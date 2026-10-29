"use strict";

const crypto = require("node:crypto");
const curveBind = require("./run-base-curve-twocrypto-factory-binding");
const scanner = require("./run-base-curve-twocrypto-factory-delta-scanner");

const FROM_BLOCK = 8_385_770;
const TO_BLOCK = 8_393_961;
const CHAIN_ID = 8453n;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getLogs", "eth_getTransactionByHash", "eth_call"]);
const CLASS_CONSISTENT = "BOOTSTRAP_CONSISTENT";
const CLASS_UNPROVEN = "BOOTSTRAP_PLAUSIBLE_BUT_UNPROVEN";
const CLASS_LEAD = "POST_DEPLOYMENT_DELTA_LEAD";
const EXPECTED_COUNTS = Object.freeze({ TwocryptoPoolDeployed: 0, LiquidityGaugeDeployed: 0, UpdateFeeReceiver: 1,
  UpdatePoolImplementation: 1, UpdateGaugeImplementation: 0, UpdateMathImplementation: 2,
  UpdateViewsImplementation: 1, TransferOwnership: 1 });
const EVENT_BY_TOPIC = new Map(scanner.EVENT_DEFINITIONS.map((row) => [row.topic0, row]));
const SELECTORS = Object.freeze({
  initialiseOwnership: "0x45e62f85", setPoolImplementation: "0x6f385ff6", setViewsImplementation: "0xf6fa937f",
  setMathImplementation: "0xb07426f4", poolCount: "0x956aae3a", feeReceiver: "0xcab4d3db", admin: "0xf851a440",
  futureAdmin: "0x17f7182a", poolImplementations: "0x3273ff47", mathImplementation: "0xa13c8f81",
  viewsImplementation: "0xe31593d8"
});
const LIMITS = Object.freeze({ requests: 48, requestMs: 20_000, wallMs: 180_000,
  responseBytes: 4 * 1024 * 1024, totalResponseBytes: 16 * 1024 * 1024, logs: 256, transactions: 8 });
const FAILURE_STAGES = Object.freeze(["BIND", "INVENTORY", "HEADER", "LOGS", "TRANSACTION", "GETTER", "SEMANTIC", "TERMINAL", "INTERNAL"]);
const FAILURE_CODES = Object.freeze({
  BIND_ARTIFACT_MISSING_OR_INVALID: "BIND", INVENTORY_INVALID: "INVENTORY", INVENTORY_MUTATED: "INVENTORY",
  FAMILIES_INVALID: "INVENTORY", CHAIN_INVALID: "HEADER", HEADER_INVALID: "HEADER", BOUNDARY_NOT_FINALIZED: "HEADER",
  BOUNDARY_DISAGREEMENT: "HEADER", LOGS_INVALID: "LOGS", EVENT_MALFORMED: "LOGS", TRANSACTION_INVALID: "TRANSACTION",
  CALL_INVALID: "GETTER", SEMANTIC_SHAPE_INVALID: "SEMANTIC", EVIDENCE_DISAGREEMENT: "SEMANTIC",
  TERMINAL_INVALID: "TERMINAL", BUDGET_EXCEEDED: null, RPC_FAILED: null, METHOD_FORBIDDEN: null, INTERNAL_ERROR: "INTERNAL"
});
const CONTEXTUAL_FAILURE_STAGES = new Set(["HEADER", "LOGS", "TRANSACTION", "GETTER", "TERMINAL"]);

class ProofError extends Error { constructor(code) { super(code); this.name = "ProofError"; this.code = code; } }
const stop = (code) => { throw new ProofError(code); };
function sanitizedFailure(error, activeStage) {
  const expected = error instanceof ProofError || error instanceof scanner.ScannerError || error instanceof curveBind.CurveBindingError;
  if (!expected || !Object.hasOwn(FAILURE_CODES, error.code)) return { errorCode: "INTERNAL_ERROR", failureStage: "INTERNAL" };
  const fixedStage = FAILURE_CODES[error.code];
  if (fixedStage !== null) return { errorCode: error.code, failureStage: fixedStage };
  if (!CONTEXTUAL_FAILURE_STAGES.has(activeStage)) return { errorCode: "INTERNAL_ERROR", failureStage: "INTERNAL" };
  return { errorCode: error.code, failureStage: activeStage };
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  return JSON.stringify(value);
}
function commitment(namespace, value) { return `${namespace}_${crypto.createHash("sha256").update(`${namespace}:${value}`).digest("base64url")}`; }
function quantity(value, code) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/iu.test(value)) stop(code);
  return BigInt(value);
}
function quantityHex(value) { return `0x${BigInt(value).toString(16)}`; }
function safeNumber(value, code) { const parsed = quantity(value, code); if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) stop(code); return Number(parsed); }
function exactHex(value, bytes, code) {
  if (typeof value !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`, "u").test(value)) stop(code);
  return value.toLowerCase();
}
function parseHeader(value, expected = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) stop("HEADER_INVALID");
  const number = quantity(value.number, "HEADER_INVALID"); if (expected !== null && number !== BigInt(expected)) stop("HEADER_INVALID");
  const projection = { number: quantityHex(number), hash: exactHex(value.hash, 32, "HEADER_INVALID"),
    parentHash: exactHex(value.parentHash, 32, "HEADER_INVALID"), stateRoot: exactHex(value.stateRoot, 32, "HEADER_INVALID"),
    timestamp: quantityHex(quantity(value.timestamp, "HEADER_INVALID")) };
  return { number, hash: projection.hash, projection: canonical(projection) };
}
class Budget {
  constructor(options = {}) { this.started = Date.now(); this.requests = 0; this.bytes = 0; this.requestMs = options.requestMs ?? LIMITS.requestMs; }
  use() { this.requests += 1; if (this.requests > LIMITS.requests || Date.now() - this.started > LIMITS.wallMs) stop("BUDGET_EXCEEDED"); }
  add(bytes) { if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > LIMITS.responseBytes) stop("BUDGET_EXCEEDED");
    this.bytes += bytes; if (this.bytes > LIMITS.totalResponseBytes) stop("BUDGET_EXCEEDED"); }
}
async function fetchTransport({ candidate, envelope, timeoutMs }) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(candidate.url.href, { method: "POST", redirect: "error", signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json", "accept-encoding": "identity" }, body: JSON.stringify(envelope) });
    if (!response || response.status !== 200) stop("RPC_FAILED"); const text = await response.text();
    const bytes = Buffer.byteLength(text, "utf8"); if (bytes > LIMITS.responseBytes) stop("BUDGET_EXCEEDED");
    let value; try { value = JSON.parse(text); } catch (_) { stop("RPC_FAILED"); } return { value, bytes };
  } catch (error) { if (error instanceof ProofError) throw error; stop("RPC_FAILED"); } finally { clearTimeout(timer); }
}
async function rpc(candidate, method, params, budget, transport) {
  if (!METHODS.has(method)) stop("METHOD_FORBIDDEN"); budget.use();
  const envelope = { jsonrpc: "2.0", id: budget.requests, method, params }; let timer; let row;
  try { row = await Promise.race([transport({ candidate, envelope, timeoutMs: budget.requestMs }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new ProofError("RPC_FAILED")), budget.requestMs); })]); }
  catch (error) { if (error instanceof ProofError) throw error; stop("RPC_FAILED"); } finally { clearTimeout(timer); }
  if (!row || !Object.hasOwn(row, "value") || !Number.isSafeInteger(row.bytes)) stop("RPC_FAILED"); budget.add(row.bytes);
  const value = row.value;
  if (!value || value.jsonrpc !== "2.0" || value.id !== envelope.id || Object.hasOwn(value, "error") || !Object.hasOwn(value, "result")) stop("RPC_FAILED");
  return value.result;
}
function word(data, index) { const start = index * 64; if (start + 64 > data.length) stop("EVENT_MALFORMED"); return data.slice(start, start + 64); }
function addressFromWord(value) { if (!/^0{24}[0-9a-f]{40}$/u.test(value)) stop("EVENT_MALFORMED"); return `0x${value.slice(24)}`; }
function uintFromWord(value) { if (!/^[0-9a-f]{64}$/u.test(value)) stop("EVENT_MALFORMED"); return BigInt(`0x${value}`); }
function validatePoolData(data) {
  if (data.length < 14 * 64 || data.length % 64 !== 0) stop("EVENT_MALFORMED");
  for (const index of [0, 3, 4, 5, 13]) addressFromWord(word(data, index));
  const first = uintFromWord(word(data, 1)); const second = uintFromWord(word(data, 2));
  if (first !== 448n || second > BigInt(Number.MAX_SAFE_INTEGER)) stop("EVENT_MALFORMED");
  const decodeTail = (offset, max) => { if (offset % 32 !== 0 || offset + 32 > data.length / 2) stop("EVENT_MALFORMED");
    const length = uintFromWord(data.slice(offset * 2, offset * 2 + 64)); if (length > BigInt(max)) stop("EVENT_MALFORMED");
    const padded = Math.ceil(Number(length) / 32) * 32; const end = offset + 32 + padded;
    if (end * 2 > data.length || !/^0*$/u.test(data.slice(offset * 2 + 64 + Number(length) * 2, end * 2))) stop("EVENT_MALFORMED"); return end; };
  const nameEnd = decodeTail(Number(first), 64); if (second !== BigInt(nameEnd)) stop("EVENT_MALFORMED");
  if (decodeTail(Number(second), 32) * 2 !== data.length) stop("EVENT_MALFORMED");
}
function decodeData(definition, value) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(value)) stop("EVENT_MALFORMED");
  const data = value.slice(2).toLowerCase();
  if (definition.event === "TwocryptoPoolDeployed") { validatePoolData(data); return []; }
  const words = data.length / 64; const expected = definition.event === "UpdatePoolImplementation" ? 3 : 2;
  if (!Number.isInteger(words) || words !== expected) stop("EVENT_MALFORMED");
  if (definition.event === "UpdatePoolImplementation") return [uintFromWord(word(data, 0)), addressFromWord(word(data, 1)), addressFromWord(word(data, 2))];
  return [addressFromWord(word(data, 0)), addressFromWord(word(data, 1))];
}
function normalizeLogs(value) {
  if (!Array.isArray(value) || value.length > LIMITS.logs) stop("LOGS_INVALID");
  const logs = value.map((log) => {
    if (!log || typeof log !== "object" || Array.isArray(log) || log.removed !== false || !Array.isArray(log.topics) || log.topics.length !== 1) stop("LOGS_INVALID");
    if (exactHex(log.address, 20, "LOGS_INVALID") !== curveBind.AUTHORITY.factory) stop("LOGS_INVALID");
    const topic0 = exactHex(log.topics[0], 32, "LOGS_INVALID"); const definition = EVENT_BY_TOPIC.get(topic0); if (!definition) stop("LOGS_INVALID");
    const blockNumber = safeNumber(log.blockNumber, "LOGS_INVALID"); if (blockNumber < FROM_BLOCK || blockNumber > TO_BLOCK) stop("LOGS_INVALID");
    return { event: definition.event, blockNumber, blockHash: exactHex(log.blockHash, 32, "LOGS_INVALID"),
      transactionHash: exactHex(log.transactionHash, 32, "LOGS_INVALID"), transactionIndex: safeNumber(log.transactionIndex, "LOGS_INVALID"),
      logIndex: safeNumber(log.logIndex, "LOGS_INVALID"), values: decodeData(definition, log.data) };
  });
  logs.sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
  const seen = new Set(); for (const log of logs) { const key = `${log.blockNumber}:${log.transactionIndex}:${log.logIndex}`; if (seen.has(key)) stop("LOGS_INVALID"); seen.add(key); }
  return logs;
}
function eventCounts(logs) { const counts = Object.fromEntries(scanner.EVENT_DEFINITIONS.map((row) => [row.event, 0]));
  for (const log of logs) counts[log.event] += 1; return counts; }
function parseTransaction(value, requestedHash) {
  if (!value || typeof value !== "object" || Array.isArray(value)) stop("TRANSACTION_INVALID");
  const hash = exactHex(value.hash, 32, "TRANSACTION_INVALID"); if (hash !== requestedHash) stop("TRANSACTION_INVALID");
  const blockNumber = safeNumber(value.blockNumber, "TRANSACTION_INVALID"); if (blockNumber < FROM_BLOCK || blockNumber > TO_BLOCK) stop("TRANSACTION_INVALID");
  const input = typeof value.input === "string" && /^0x(?:[0-9a-fA-F]{2})+$/u.test(value.input) ? value.input.toLowerCase() : stop("TRANSACTION_INVALID");
  return { hash, blockNumber, blockHash: exactHex(value.blockHash, 32, "TRANSACTION_INVALID"),
    transactionIndex: safeNumber(value.transactionIndex, "TRANSACTION_INVALID"), from: exactHex(value.from, 20, "TRANSACTION_INVALID"),
    to: exactHex(value.to, 20, "TRANSACTION_INVALID"), input };
}
function callData(selector, argument = "") { return `${selector}${argument}`; }
function addressArgument(address) { return address.slice(2).padStart(64, "0"); }
function uintArgument(value) { return value.toString(16).padStart(64, "0"); }
function parseCallWord(value) { return exactHex(value, 32, "CALL_INVALID").slice(2); }
async function getter(candidate, selector, endpointHash, budget, transport, argument = "") {
  return parseCallWord(await rpc(candidate, "eth_call", [{ to: curveBind.AUTHORITY.factory, data: callData(selector, argument) },
    { blockHash: endpointHash, requireCanonical: true }], budget, transport));
}
function transactionFor(log, transactions) { const tx = transactions.get(log.transactionHash); if (!tx || tx.blockNumber !== log.blockNumber
    || tx.blockHash !== log.blockHash || tx.transactionIndex !== log.transactionIndex || tx.to !== curveBind.AUTHORITY.factory) stop("TRANSACTION_INVALID"); return tx; }
function exactInput(tx, selector, words) { return tx.input === `${selector}${words.join("")}`; }
function semanticEvidence(logs, transactions, getters) {
  const gates = { zeroPools: false, initializerPairSameTransaction: false, initializerOldZeroOrder: false,
    adminSender: false, exactUpdateChains: false, finalGettersMatch: false, futureAdminZero: false, selectorCallerOrder: false };
  const sequence = ["UpdateFeeReceiver", "TransferOwnership", "UpdatePoolImplementation", "UpdateViewsImplementation", "UpdateMathImplementation", "UpdateMathImplementation"];
  const counts = eventCounts(logs); const completeCounts = canonical(counts) === canonical(EXPECTED_COUNTS);
  if (!completeCounts || logs.length !== sequence.length || logs.some((log, index) => log.event !== sequence[index])) return { gates, counts, completeCounts };
  const [fee, ownership, pool, views, math1, math2] = logs;
  gates.initializerPairSameTransaction = fee.transactionHash === ownership.transactionHash && fee.blockNumber === ownership.blockNumber
    && fee.transactionIndex === ownership.transactionIndex;
  gates.initializerOldZeroOrder = fee.values[0] === ZERO_ADDRESS && ownership.values[0] === ZERO_ADDRESS && fee.logIndex < ownership.logIndex;
  const initTx = transactionFor(fee, transactions); const ownershipTx = transactionFor(ownership, transactions);
  const poolTx = transactionFor(pool, transactions); const viewsTx = transactionFor(views, transactions);
  const math1Tx = transactionFor(math1, transactions); const math2Tx = transactionFor(math2, transactions);
  const initInput = exactInput(initTx, SELECTORS.initialiseOwnership, [addressArgument(fee.values[1]), addressArgument(ownership.values[1])]);
  const poolInput = exactInput(poolTx, SELECTORS.setPoolImplementation, [addressArgument(pool.values[2]), uintArgument(pool.values[0])]);
  const viewsInput = exactInput(viewsTx, SELECTORS.setViewsImplementation, [addressArgument(views.values[1])]);
  const math1Input = exactInput(math1Tx, SELECTORS.setMathImplementation, [addressArgument(math1.values[1])]);
  const math2Input = exactInput(math2Tx, SELECTORS.setMathImplementation, [addressArgument(math2.values[1])]);
  const setterTransactionsDistinct = new Set([poolTx.hash, viewsTx.hash, math1Tx.hash, math2Tx.hash]).size === 4;
  gates.adminSender = [poolTx, viewsTx, math1Tx, math2Tx].every((tx) => tx.from === ownership.values[1]);
  gates.exactUpdateChains = pool.values[1] === ZERO_ADDRESS && views.values[0] === ZERO_ADDRESS
    && math1.values[0] === ZERO_ADDRESS && math2.values[0] === math1.values[1];
  gates.selectorCallerOrder = gates.initializerPairSameTransaction && initTx.hash === ownershipTx.hash && initInput && poolInput && viewsInput
    && math1Input && math2Input && setterTransactionsDistinct;
  gates.zeroPools = uintFromWord(getters.poolCount) === 0n;
  gates.futureAdminZero = addressFromWord(getters.futureAdmin) === ZERO_ADDRESS;
  gates.finalGettersMatch = addressFromWord(getters.feeReceiver) === fee.values[1] && addressFromWord(getters.admin) === ownership.values[1]
    && addressFromWord(getters.poolImplementation) === pool.values[2] && addressFromWord(getters.viewsImplementation) === views.values[1]
    && addressFromWord(getters.mathImplementation) === math2.values[1];
  return { gates, counts, completeCounts };
}
async function observe(candidate, budget, transport, setStage) {
  setStage("HEADER");
  if (quantity(await rpc(candidate, "eth_chainId", [], budget, transport), "CHAIN_INVALID") !== CHAIN_ID) stop("CHAIN_INVALID");
  const finalized = parseHeader(await rpc(candidate, "eth_getBlockByNumber", ["finalized", false], budget, transport));
  if (finalized.number < BigInt(TO_BLOCK)) stop("BOUNDARY_NOT_FINALIZED");
  const from = parseHeader(await rpc(candidate, "eth_getBlockByNumber", [quantityHex(FROM_BLOCK), false], budget, transport), FROM_BLOCK);
  const to = parseHeader(await rpc(candidate, "eth_getBlockByNumber", [quantityHex(TO_BLOCK), false], budget, transport), TO_BLOCK);
  setStage("LOGS");
  const logs = normalizeLogs(await rpc(candidate, "eth_getLogs", [{ address: curveBind.AUTHORITY.factory, fromBlock: quantityHex(FROM_BLOCK),
    toBlock: quantityHex(TO_BLOCK), topics: [scanner.EVENT_DEFINITIONS.map((row) => row.topic0)] }], budget, transport));
  setStage("TRANSACTION");
  const hashes = [...new Set(logs.map((log) => log.transactionHash))]; if (hashes.length > LIMITS.transactions) stop("TRANSACTION_INVALID");
  const transactions = new Map(); for (const hash of hashes) transactions.set(hash, parseTransaction(await rpc(candidate, "eth_getTransactionByHash", [hash], budget, transport), hash));
  setStage("SEMANTIC");
  const poolRows = logs.filter((log) => log.event === "UpdatePoolImplementation"); if (poolRows.length !== 1) stop("SEMANTIC_SHAPE_INVALID");
  setStage("GETTER");
  const getters = {
    poolCount: await getter(candidate, SELECTORS.poolCount, to.hash, budget, transport),
    feeReceiver: await getter(candidate, SELECTORS.feeReceiver, to.hash, budget, transport),
    admin: await getter(candidate, SELECTORS.admin, to.hash, budget, transport),
    futureAdmin: await getter(candidate, SELECTORS.futureAdmin, to.hash, budget, transport),
    poolImplementation: await getter(candidate, SELECTORS.poolImplementations, to.hash, budget, transport, uintArgument(poolRows[0].values[0])),
    mathImplementation: await getter(candidate, SELECTORS.mathImplementation, to.hash, budget, transport),
    viewsImplementation: await getter(candidate, SELECTORS.viewsImplementation, to.hash, budget, transport)
  };
  return { candidate, from, to, logs, transactions: [...transactions.entries()], getters };
}
function normalizedEvidence(row) { return { from: row.from.projection, to: row.to.projection, logs: row.logs,
  transactions: row.transactions, getters: row.getters }; }
async function terminalRecheck(rows, budget, transport) {
  for (const row of rows) {
    const from = parseHeader(await rpc(row.candidate, "eth_getBlockByNumber", [quantityHex(FROM_BLOCK), false], budget, transport), FROM_BLOCK);
    const to = parseHeader(await rpc(row.candidate, "eth_getBlockByNumber", [quantityHex(TO_BLOCK), false], budget, transport), TO_BLOCK);
    const finalized = parseHeader(await rpc(row.candidate, "eth_getBlockByNumber", ["finalized", false], budget, transport));
    if (from.projection !== row.from.projection || to.projection !== row.to.projection || finalized.number < BigInt(TO_BLOCK)) stop("TERMINAL_INVALID");
  }
}
function baseGates() { return { exactBindPrerequisite: false, twoIndependentFamilies: false, finalizedCanonicalBoundaries: false,
  officialLogsComplete: false, normalizedEvidenceAgreement: false, transactionEvidenceComplete: false, selectorCallerOrder: false,
  zeroPools: false, initializerPairSameTransaction: false, initializerOldZeroOrder: false, adminSender: false,
  exactUpdateChains: false, finalGettersMatch: false, futureAdminZero: false, terminalBoundaryStable: false, inventoryStable: false }; }
function zeroCounts() { return Object.fromEntries(scanner.EVENT_DEFINITIONS.map((row) => [row.event, 0])); }
function result(classification, artifact, selected, budget, gates, counts, commitments, failure = { errorCode: null, failureStage: null }) {
  const core = { classification, blockRange: { fromBlock: String(FROM_BLOCK), toBlock: String(TO_BLOCK), blockCount: String(TO_BLOCK - FROM_BLOCK + 1) },
    anonymousSelectedCount: selected.length, readCount: budget.requests, bindTemporaryMaterialCleanupComplete: artifact?.temporaryMaterialCleanupComplete ?? null,
    errorCode: failure.errorCode, failureStage: failure.failureStage, gates, eventCounts: counts, commitments };
  return { ...core, proofCommitment: commitment("bootstrap-proof", canonical(core)) };
}
async function runProof(options = {}) {
  const gates = baseGates(); const budget = new Budget(options); let artifact = null; let inventory = null; let selected = []; let counts = zeroCounts();
  let activeStage = "BIND"; const setStage = (stage) => { if (!FAILURE_STAGES.includes(stage)) stop("INTERNAL_ERROR"); activeStage = stage; };
  const checkInventory = options.assertInventoryUnchangedFn ?? curveBind.inventoryUnchanged;
  try {
    const supplied = Object.hasOwn(options, "bindingArtifact") ? options.bindingArtifact : await (options.bindingAdapter ?? curveBind.runBinding)();
    artifact = scanner.verifyBindingArtifact(supplied); gates.exactBindPrerequisite = true;
    setStage("INVENTORY");
    inventory = options.inventoryText !== undefined ? { text: options.inventoryText, identity: options.inventoryIdentity ?? "injected" }
      : (options.readInventoryFn ? options.readInventoryFn() : curveBind.readStableInventory());
    if (!inventory || typeof inventory.text !== "string" || !Object.hasOwn(inventory, "identity")) stop("INVENTORY_INVALID");
    const wanted = new Set(artifact.selectedFamilyOrdinalCommitments);
    selected = curveBind.parseAuthorizedBaseInventory(inventory.text).filter((candidate) => wanted.has(commitment("family-ordinal", String(candidate.ordinal))));
    if (selected.length !== 2 || selected[0].family === selected[1].family) stop("FAMILIES_INVALID"); gates.twoIndependentFamilies = true;
    const transport = options.transport ?? fetchTransport; const observations = [];
    for (const candidate of selected) observations.push(await observe(candidate, budget, transport, setStage));
    setStage("HEADER");
    if (observations[0].from.projection !== observations[1].from.projection || observations[0].to.projection !== observations[1].to.projection) stop("BOUNDARY_DISAGREEMENT");
    gates.finalizedCanonicalBoundaries = true;
    setStage("SEMANTIC");
    const normalized = observations.map(normalizedEvidence); if (canonical(normalized[0]) !== canonical(normalized[1])) stop("EVIDENCE_DISAGREEMENT");
    gates.normalizedEvidenceAgreement = true; gates.transactionEvidenceComplete = true;
    const semantic = semanticEvidence(observations[0].logs, new Map(observations[0].transactions), observations[0].getters);
    counts = semantic.counts; gates.officialLogsComplete = semantic.completeCounts; Object.assign(gates, semantic.gates);
    setStage("TERMINAL");
    await terminalRecheck(observations, budget, transport); gates.terminalBoundaryStable = true;
    setStage("INVENTORY");
    checkInventory(inventory.identity); gates.inventoryStable = true;
    const commitments = { boundary: commitment("boundary", `${observations[0].from.projection}:${observations[0].to.projection}`),
      logs: commitment("logs", canonical(observations[0].logs)), transactions: commitment("transactions", canonical(observations[0].transactions)),
      getters: commitment("getters", canonical(observations[0].getters)), evidence: commitment("evidence", canonical(normalized[0])) };
    const positive = Object.values(gates).every(Boolean);
    return result(positive ? CLASS_CONSISTENT : CLASS_LEAD, artifact, selected, budget, gates, counts, commitments);
  } catch (error) {
    const failure = sanitizedFailure(error, activeStage);
    if (inventory) try { checkInventory(inventory.identity); gates.inventoryStable = true; } catch (_) { gates.inventoryStable = false; }
    return result(CLASS_UNPROVEN, artifact, selected, budget, gates, zeroCounts(),
      { boundary: null, logs: null, transactions: null, getters: null, evidence: null }, failure);
  }
}
async function main() {
  if (process.argv.length !== 2) process.exitCode = 1;
  const output = process.argv.length === 2 ? await runProof() : result(CLASS_UNPROVEN, null, [], new Budget(), baseGates(), zeroCounts(),
    { boundary: null, logs: null, transactions: null, getters: null, evidence: null });
  process.stdout.write(`${JSON.stringify(output)}\n`); if (output.classification !== CLASS_CONSISTENT) process.exitCode = 1;
}
module.exports = { CLASS_CONSISTENT, CLASS_LEAD, CLASS_UNPROVEN, EXPECTED_COUNTS, FAILURE_CODES, FAILURE_STAGES, FROM_BLOCK, LIMITS, ProofError,
  SELECTORS, TO_BLOCK, runProof };
if (require.main === module) main();
