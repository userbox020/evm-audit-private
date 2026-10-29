"use strict";

const crypto = require("node:crypto");
const curveBind = require("./run-base-curve-twocrypto-factory-binding");

const CHAIN_ID = 8453n;
const MAX_WINDOW_BLOCKS = 8192;
const METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getLogs"]);
const STATUS_COMPLETE = "FINALIZED_EVENT_DELTA_AGREED";
const STATUS_INCOMPLETE = "INCOMPLETE";
const LIMITS = Object.freeze({ requests: 24, requestMs: 20_000, wallMs: 180_000,
  responseBytes: 4 * 1024 * 1024, totalResponseBytes: 12 * 1024 * 1024, records: 20_000 });

// Event declarations are pinned to curvefi/twocrypto-ng@d6755cb2ac64c1a3823f552911c59dc9a42a21fb,
// contracts/main/CurveTwocryptoFactory.vy (Vyper 0.3.10). No fields are indexed.
const EVENT_DEFINITIONS = Object.freeze([
  Object.freeze({ event: "TwocryptoPoolDeployed", category: "POOL_DEPLOYMENT",
    signature: "TwocryptoPoolDeployed(address,string,string,address[2],address,bytes32,uint256[2],uint256,uint256,uint256,uint256,address)",
    topic0: "0x8152a3037e3dc54154ad0d2cadb1cf7e1d1b9e2b625faa3dfb4fe03d609102ca", decoder: "pool" }),
  Object.freeze({ event: "LiquidityGaugeDeployed", category: "POOL_DEPLOYMENT",
    signature: "LiquidityGaugeDeployed(address,address)",
    topic0: "0x656bb34c20491970a8c163f3bd62ead82022b379c3924960ec60f6dbfc5aab3b", decoder: "addresses2" }),
  Object.freeze({ event: "UpdateFeeReceiver", category: "AUTHORITY_CONFIG",
    signature: "UpdateFeeReceiver(address,address)",
    topic0: "0x2861448678f0be67f11bfb5481b3e3b4cfeb3acc6126ad60a05f95bfc6530666", decoder: "addresses2" }),
  Object.freeze({ event: "UpdatePoolImplementation", category: "AUTHORITY_CONFIG",
    signature: "UpdatePoolImplementation(uint256,address,address)",
    topic0: "0x6a42ef9605e135afaf6ae4f3683b161a3b7369d07c9d52c701ab69553e04c3b6", decoder: "uintAddresses2" }),
  Object.freeze({ event: "UpdateGaugeImplementation", category: "AUTHORITY_CONFIG",
    signature: "UpdateGaugeImplementation(address,address)",
    topic0: "0x1fd705f9c77053962a503f2f2f57f0862b4c3af687c25615c13817a86946c359", decoder: "addresses2" }),
  Object.freeze({ event: "UpdateMathImplementation", category: "AUTHORITY_CONFIG",
    signature: "UpdateMathImplementation(address,address)",
    topic0: "0x68fe8fc3ac76ec17e21117df5e854c8c25b7b5f776aad2adc927fdd156bcd6de", decoder: "addresses2" }),
  Object.freeze({ event: "UpdateViewsImplementation", category: "AUTHORITY_CONFIG",
    signature: "UpdateViewsImplementation(address,address)",
    topic0: "0xd84eb1ea70cda40a6bfaa11f4f69efa10cbc5eb82760b3058f440512ec1d6d1f", decoder: "addresses2" }),
  Object.freeze({ event: "TransferOwnership", category: "AUTHORITY_CONFIG",
    signature: "TransferOwnership(address,address)",
    topic0: "0x5c486528ec3e3f0ea91181cff8116f02bfa350e03b8b6f12e00765adbb5af85c", decoder: "addresses2" })
]);
const EVENT_BY_TOPIC = new Map(EVENT_DEFINITIONS.map((row) => [row.topic0, row]));
const CATEGORIES = Object.freeze(["POOL_DEPLOYMENT", "AUTHORITY_CONFIG"]);
const MASK_64 = (1n << 64n) - 1n;
const KECCAK_ROUNDS = Object.freeze([
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
]);
const KECCAK_ROTATION = Object.freeze([
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14
]);

class ScannerError extends Error {
  constructor(code) { super(code); this.name = "ScannerError"; this.code = code; }
}
const stop = (code) => { throw new ScannerError(code); };
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function commitment(namespace, value) {
  return `${namespace}_${crypto.createHash("sha256").update(`${namespace}:${value}`).digest("base64url")}`;
}
function rotate64(value, count) {
  if (count === 0) return value & MASK_64;
  const shift = BigInt(count); return ((value << shift) | (value >> (64n - shift))) & MASK_64;
}
function keccakPermutation(state) {
  for (const round of KECCAK_ROUNDS) {
    const c = new Array(5); const d = new Array(5);
    for (let x = 0; x < 5; x += 1) c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    for (let x = 0; x < 5; x += 1) d[x] = c[(x + 4) % 5] ^ rotate64(c[(x + 1) % 5], 1);
    for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) state[x + 5 * y] = (state[x + 5 * y] ^ d[x]) & MASK_64;
    const b = new Array(25).fill(0n);
    for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) {
      const index = x + 5 * y; b[y + 5 * ((2 * x + 3 * y) % 5)] = rotate64(state[index], KECCAK_ROTATION[index]);
    }
    for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) {
      state[x + 5 * y] = (b[x + 5 * y] ^ ((~b[((x + 1) % 5) + 5 * y]) & b[((x + 2) % 5) + 5 * y])) & MASK_64;
    }
    state[0] ^= round;
  }
}
function keccak256(text) {
  const input = Buffer.from(text, "utf8"); const rate = 136;
  const paddedLength = Math.ceil((input.length + 1) / rate) * rate;
  const bytes = Buffer.alloc(paddedLength); input.copy(bytes); bytes[input.length] = 0x01; bytes[paddedLength - 1] |= 0x80;
  const state = new Array(25).fill(0n);
  for (let offset = 0; offset < bytes.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) {
      let value = 0n; for (let byte = 0; byte < 8; byte += 1) value |= BigInt(bytes[offset + lane * 8 + byte]) << BigInt(byte * 8);
      state[lane] ^= value;
    }
    keccakPermutation(state);
  }
  const output = Buffer.alloc(32);
  for (let index = 0; index < output.length; index += 1) output[index] = Number((state[Math.floor(index / 8)] >> BigInt((index % 8) * 8)) & 0xffn);
  return `0x${output.toString("hex")}`;
}
function assertSourceEventAbi(rows) {
  if (!Array.isArray(rows) || rows.length !== EVENT_DEFINITIONS.length) stop("SOURCE_ABI_INVALID");
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]; const expected = EVENT_DEFINITIONS[index];
    if (!row || row.type !== "event" || row.name !== expected.event || row.anonymous !== false || !Array.isArray(row.inputs)
        || row.inputs.some((input) => !input || input.indexed !== false || typeof input.type !== "string")) stop("SOURCE_ABI_INVALID");
    const signature = `${row.name}(${row.inputs.map((input) => input.type).join(",")})`;
    if (signature !== expected.signature || keccak256(signature) !== expected.topic0) stop("SOURCE_ABI_TOPIC_MISMATCH");
  }
  return true;
}

function quantity(value, code) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/iu.test(value)) stop(code);
  return BigInt(value);
}
function quantityHex(value) { return `0x${BigInt(value).toString(16)}`; }
function exactHex(value, bytes, code) {
  if (typeof value !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`, "u").test(value)) stop(code);
  return value.toLowerCase();
}
function safeNumber(value, code) {
  const parsed = quantity(value, code); if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) stop(code); return Number(parsed);
}
function validateWindow(fromValue, toValue) {
  if (fromValue === undefined || toValue === undefined) stop("WINDOW_REQUIRED");
  if (!/^(?:0|[1-9][0-9]*)$/u.test(String(fromValue)) || !/^(?:0|[1-9][0-9]*)$/u.test(String(toValue))) stop("WINDOW_INVALID");
  const fromBlock = Number(fromValue); const toBlock = Number(toValue);
  if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || toBlock < fromBlock
      || toBlock - fromBlock + 1 > MAX_WINDOW_BLOCKS) stop("WINDOW_INVALID");
  return { fromBlock, toBlock };
}
function requestedWindow(fromValue, toValue) {
  if (toValue === "finalized") {
    if (fromValue !== undefined) stop("FINALIZED_MODE_FROM_FORBIDDEN");
    return { mode: "finalized", window: null };
  }
  return { mode: "numeric", window: validateWindow(fromValue, toValue) };
}
function verifyBindingArtifact(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact) || artifact.status !== curveBind.STATUS_BOUND) stop("BIND_ARTIFACT_MISSING_OR_INVALID");
  const expectedFlags = { authorityExact: true, sourceExact: true, compilerExact: true, buildExact: true,
    twoIndependentFamilies: true, finalizedAgreement: true, factoryCodeAgreement: true, terminalHeaderStable: true,
    directTopology: true, exactRuntime: true, inventoryStable: true };
  if (artifact.authorityCommitment !== commitment("authority", canonical(curveBind.AUTHORITY))
      || canonical(artifact.binding) !== canonical(expectedFlags)
      || artifact.bindingCommitment !== commitment("binding", canonical(expectedFlags))
      || artifact.anonymousFamilyCount !== 2 || !Array.isArray(artifact.selectedFamilyOrdinalCommitments)
      || artifact.selectedFamilyOrdinalCommitments.length !== 2
      || new Set(artifact.selectedFamilyOrdinalCommitments).size !== 2
      || artifact.selectedFamilyOrdinalCommitments.some((value) => !/^family-ordinal_[A-Za-z0-9_-]{43}$/u.test(value))
      || artifact.failurePhase !== null || artifact.failureCode !== null
      || artifact.temporaryMaterialCleanupComplete !== true) stop("BIND_ARTIFACT_MISSING_OR_INVALID");
  const { derivedCommitment, ...core } = artifact;
  if (derivedCommitment !== commitment("derived", canonical(core))) stop("BIND_ARTIFACT_MISSING_OR_INVALID");
  return artifact;
}
function parseHeader(value, expectedNumber = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) stop("HEADER_INVALID");
  const number = quantity(value.number, "HEADER_INVALID");
  if (expectedNumber !== null && number !== BigInt(expectedNumber)) stop("HEADER_INVALID");
  const projection = { number: quantityHex(number), hash: exactHex(value.hash, 32, "HEADER_INVALID"),
    parentHash: exactHex(value.parentHash, 32, "HEADER_INVALID"), stateRoot: exactHex(value.stateRoot, 32, "HEADER_INVALID"),
    timestamp: quantityHex(quantity(value.timestamp, "HEADER_INVALID")) };
  return { number, hash: projection.hash, projection: canonical(projection) };
}
class Budget {
  constructor(options = {}) { this.started = Date.now(); this.requests = 0; this.bytes = 0;
    this.requestMs = options.requestMs ?? LIMITS.requestMs; }
  use() { this.requests += 1; if (this.requests > LIMITS.requests || Date.now() - this.started > LIMITS.wallMs) stop("REQUEST_CAP_EXCEEDED"); }
  add(bytes) { if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > LIMITS.responseBytes) stop("RESPONSE_CAP_EXCEEDED");
    this.bytes += bytes; if (this.bytes > LIMITS.totalResponseBytes) stop("RESPONSE_CAP_EXCEEDED"); }
}
async function fetchTransport({ candidate, envelope, timeoutMs }) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(candidate.url.href, { method: "POST", redirect: "error", signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json", "accept-encoding": "identity" }, body: JSON.stringify(envelope) });
    if (!response || response.status !== 200) stop("RPC_HTTP_INVALID");
    const text = await response.text(); const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > LIMITS.responseBytes) stop("RESPONSE_CAP_EXCEEDED");
    let value; try { value = JSON.parse(text); } catch (_) { stop("RPC_JSON_INVALID"); }
    return { value, bytes };
  } catch (error) { if (error instanceof ScannerError) throw error; stop("RPC_TRANSPORT_FAILED"); } finally { clearTimeout(timer); }
}
async function rpc(candidate, method, params, budget, transport) {
  if (!METHODS.has(method)) stop("RPC_METHOD_FORBIDDEN"); budget.use();
  const envelope = { jsonrpc: "2.0", id: budget.requests, method, params }; let timer;
  let row; try { row = await Promise.race([transport({ candidate, envelope, timeoutMs: budget.requestMs }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new ScannerError("RPC_TIMEOUT")), budget.requestMs); })]); }
  catch (error) { if (error instanceof ScannerError) throw error; stop("RPC_TRANSPORT_FAILED"); } finally { clearTimeout(timer); }
  if (!row || !Object.hasOwn(row, "value") || !Number.isSafeInteger(row.bytes)) stop("RPC_RESPONSE_INVALID"); budget.add(row.bytes);
  if (!row.value || row.value.jsonrpc !== "2.0" || row.value.id !== envelope.id || Object.hasOwn(row.value, "error")
      || !Object.hasOwn(row.value, "result")) stop("RPC_RESPONSE_INVALID");
  return row.value.result;
}
function word(data, index, code = "EVENT_DATA_INVALID") {
  const start = index * 64; if (start + 64 > data.length) stop(code); return data.slice(start, start + 64);
}
function addressWord(data, index) { if (!/^0{24}[0-9a-f]{40}$/u.test(word(data, index))) stop("EVENT_ADDRESS_INVALID"); }
function decodeString(data, offset, maxLength) {
  if (offset % 32 !== 0 || offset < 0 || offset + 32 > data.length / 2) stop("EVENT_DYNAMIC_INVALID");
  const lengthWord = data.slice(offset * 2, offset * 2 + 64); const lengthBig = BigInt(`0x${lengthWord}`);
  if (lengthBig > BigInt(maxLength)) stop("EVENT_DYNAMIC_INVALID"); const length = Number(lengthBig);
  const padded = Math.ceil(length / 32) * 32; const start = offset * 2 + 64; const end = start + padded * 2;
  if (end > data.length || !/^0*$/u.test(data.slice(start + length * 2, end))) stop("EVENT_DYNAMIC_INVALID");
  try { new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(data.slice(start, start + length * 2), "hex")); }
  catch (_) { stop("EVENT_DYNAMIC_INVALID"); }
  return { end: offset + 32 + padded };
}
function decodeEventData(definition, value) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(value)) stop("EVENT_DATA_INVALID");
  const data = value.slice(2).toLowerCase();
  if (definition.decoder === "addresses2") {
    if (data.length !== 128) stop("EVENT_DATA_INVALID"); addressWord(data, 0); addressWord(data, 1); return;
  }
  if (definition.decoder === "uintAddresses2") {
    if (data.length !== 192) stop("EVENT_DATA_INVALID"); addressWord(data, 1); addressWord(data, 2); return;
  }
  if (data.length < 14 * 64 || data.length % 64 !== 0) stop("EVENT_DATA_INVALID");
  for (const index of [0, 3, 4, 5, 13]) addressWord(data, index);
  const nameOffsetBig = BigInt(`0x${word(data, 1)}`); const symbolOffsetBig = BigInt(`0x${word(data, 2)}`);
  if (nameOffsetBig > BigInt(Number.MAX_SAFE_INTEGER) || symbolOffsetBig > BigInt(Number.MAX_SAFE_INTEGER)) stop("EVENT_DYNAMIC_INVALID");
  const nameOffset = Number(nameOffsetBig); const symbolOffset = Number(symbolOffsetBig);
  if (nameOffset !== 14 * 32) stop("EVENT_DYNAMIC_INVALID"); const name = decodeString(data, nameOffset, 64);
  if (symbolOffset !== name.end) stop("EVENT_DYNAMIC_INVALID"); const symbol = decodeString(data, symbolOffset, 32);
  if (symbol.end * 2 !== data.length) stop("EVENT_DYNAMIC_INVALID");
}
function normalizeLogs(value, window) {
  if (!Array.isArray(value) || value.length > LIMITS.records) stop("LOGS_INVALID");
  const rows = value.map((log) => {
    if (!log || typeof log !== "object" || Array.isArray(log) || log.removed !== false || !Array.isArray(log.topics)
        || log.topics.length !== 1) stop("LOG_MALFORMED");
    const address = exactHex(log.address, 20, "LOG_MALFORMED");
    if (address !== curveBind.AUTHORITY.factory) stop("LOG_EMITTER_INVALID");
    const topic0 = exactHex(log.topics[0], 32, "LOG_MALFORMED"); const definition = EVENT_BY_TOPIC.get(topic0);
    if (!definition) stop("LOG_TOPIC_INVALID"); decodeEventData(definition, log.data);
    const blockNumber = safeNumber(log.blockNumber, "LOG_POSITION_INVALID");
    if (blockNumber < window.fromBlock || blockNumber > window.toBlock) stop("LOG_POSITION_INVALID");
    return { event: definition.event, category: definition.category, blockNumber,
      blockHash: exactHex(log.blockHash, 32, "LOG_POSITION_INVALID"),
      transactionHash: exactHex(log.transactionHash, 32, "LOG_POSITION_INVALID"),
      transactionIndex: safeNumber(log.transactionIndex, "LOG_POSITION_INVALID"),
      logIndex: safeNumber(log.logIndex, "LOG_POSITION_INVALID"), topic0, data: log.data.toLowerCase() };
  });
  rows.sort((left, right) => left.blockNumber - right.blockNumber || left.transactionIndex - right.transactionIndex || left.logIndex - right.logIndex);
  const seen = new Set();
  for (const row of rows) { const key = `${row.blockNumber}:${row.transactionIndex}:${row.logIndex}`; if (seen.has(key)) stop("LOG_DUPLICATE"); seen.add(key); }
  return rows;
}
async function observe(candidate, window, budget, transport) {
  if (quantity(await rpc(candidate, "eth_chainId", [], budget, transport), "CHAIN_INVALID") !== CHAIN_ID) stop("CHAIN_INVALID");
  const finalized = parseHeader(await rpc(candidate, "eth_getBlockByNumber", ["finalized", false], budget, transport));
  if (finalized.number < BigInt(window.toBlock)) stop("NON_FINALIZED_BOUNDARY");
  const from = parseHeader(await rpc(candidate, "eth_getBlockByNumber", [quantityHex(window.fromBlock), false], budget, transport), window.fromBlock);
  const to = window.fromBlock === window.toBlock ? from
    : parseHeader(await rpc(candidate, "eth_getBlockByNumber", [quantityHex(window.toBlock), false], budget, transport), window.toBlock);
  const logs = normalizeLogs(await rpc(candidate, "eth_getLogs", [{ address: curveBind.AUTHORITY.factory,
    fromBlock: quantityHex(window.fromBlock), toBlock: quantityHex(window.toBlock), topics: [EVENT_DEFINITIONS.map((row) => row.topic0)] }], budget, transport), window);
  return { candidate, from, to, logs };
}
async function resolveLatestFinalized(selected, budget, transport) {
  const headers = [];
  for (const candidate of selected) {
    if (quantity(await rpc(candidate, "eth_chainId", [], budget, transport), "CHAIN_INVALID") !== CHAIN_ID) stop("CHAIN_INVALID");
    headers.push(parseHeader(await rpc(candidate, "eth_getBlockByNumber", ["finalized", false], budget, transport)));
  }
  if (headers.length !== 2 || headers[0].projection !== headers[1].projection) stop("FINALIZED_HEADER_DISAGREEMENT");
  if (headers[0].number < BigInt(MAX_WINDOW_BLOCKS - 1) || headers[0].number > BigInt(Number.MAX_SAFE_INTEGER)) {
    stop("FINALIZED_RANGE_INSUFFICIENT");
  }
  const toBlock = Number(headers[0].number);
  return { window: { fromBlock: toBlock - MAX_WINDOW_BLOCKS + 1, toBlock }, headers };
}
async function observeResolvedFinalized(candidate, window, budget, transport) {
  const from = parseHeader(await rpc(candidate, "eth_getBlockByNumber", [quantityHex(window.fromBlock), false], budget, transport), window.fromBlock);
  const to = parseHeader(await rpc(candidate, "eth_getBlockByNumber", [quantityHex(window.toBlock), false], budget, transport), window.toBlock);
  const logs = normalizeLogs(await rpc(candidate, "eth_getLogs", [{ address: curveBind.AUTHORITY.factory,
    fromBlock: quantityHex(window.fromBlock), toBlock: quantityHex(window.toBlock), topics: [EVENT_DEFINITIONS.map((row) => row.topic0)] }], budget, transport), window);
  return { candidate, from, to, logs };
}
async function terminalRecheck(rows, window, budget, transport) {
  for (const row of rows) {
    const from = parseHeader(await rpc(row.candidate, "eth_getBlockByNumber", [quantityHex(window.fromBlock), false], budget, transport), window.fromBlock);
    const to = window.fromBlock === window.toBlock ? from
      : parseHeader(await rpc(row.candidate, "eth_getBlockByNumber", [quantityHex(window.toBlock), false], budget, transport), window.toBlock);
    const finalized = parseHeader(await rpc(row.candidate, "eth_getBlockByNumber", ["finalized", false], budget, transport));
    if (from.projection !== row.from.projection || to.projection !== row.to.projection || finalized.number < BigInt(window.toBlock)) stop("TERMINAL_BOUNDARY_INVALID");
  }
}
function emptyCounts() {
  return { eventCounts: Object.fromEntries(EVENT_DEFINITIONS.map((row) => [row.event, 0])),
    categoryCounts: Object.fromEntries(CATEGORIES.map((category) => [category, 0])) };
}
function makeResult(status, errorCode, window, artifact, selected, budget, logs, flags) {
  const counts = emptyCounts(); const eventCommitments = [];
  if (status === STATUS_COMPLETE) for (const log of logs) {
    counts.eventCounts[log.event] += 1; counts.categoryCounts[log.category] += 1;
    eventCommitments.push({ category: log.category, event: log.event, commitment: commitment("event", canonical(log)) });
  }
  const core = { status, errorCode, blockRange: window ? { fromBlock: String(window.fromBlock), toBlock: String(window.toBlock), blockCount: String(window.toBlock - window.fromBlock + 1) } : null,
    sourceAbiCommitment: commitment("source-abi", canonical(EVENT_DEFINITIONS.map(({ event, category, signature, topic0 }) => ({ event, category, signature, topic0 })))),
    bindArtifactCommitment: artifact?.bindingCommitment ?? null,
    bindTemporaryMaterialCleanupComplete: artifact?.temporaryMaterialCleanupComplete ?? null, anonymousFamilyCount: selected.length,
    selectedFamilyOrdinalCommitments: selected.map((row) => commitment("family-ordinal", String(row.ordinal))), readCount: budget.requests,
    ...counts, eventCommitments, completeness: flags };
  return { ...core, scanCommitment: commitment("scan", canonical(core)) };
}
function defaultFlags() { return { exactBindPrerequisite: false, twoIndependentFamilies: false, finalizedBoundary: false,
  boundaryAgreement: false, normalizedLogAgreement: false, terminalBoundaryStable: false, inventoryStable: false }; }
async function runScanner(options = {}) {
  let window = null; let request = null; let resolvedFinalized = null; let artifact = null; let inventory = null; let selected = []; const budget = new Budget(options); const flags = defaultFlags();
  const checkInventory = options.assertInventoryUnchangedFn ?? curveBind.inventoryUnchanged;
  try {
    request = requestedWindow(options.fromBlock, options.toBlock); window = request.window;
    const supplied = Object.hasOwn(options, "bindingArtifact") ? options.bindingArtifact
      : await (options.bindingAdapter ?? curveBind.runBinding)();
    artifact = verifyBindingArtifact(supplied); flags.exactBindPrerequisite = true;
    inventory = options.inventoryText !== undefined ? { text: options.inventoryText, identity: options.inventoryIdentity ?? "injected" }
      : (options.readInventoryFn ? options.readInventoryFn() : curveBind.readStableInventory());
    if (!inventory || typeof inventory.text !== "string" || !Object.hasOwn(inventory, "identity")) stop("INVENTORY_INVALID");
    const wanted = new Set(artifact.selectedFamilyOrdinalCommitments);
    selected = curveBind.parseAuthorizedBaseInventory(inventory.text).filter((candidate) => wanted.has(commitment("family-ordinal", String(candidate.ordinal))));
    if (selected.length !== 2 || selected[0].family === selected[1].family) stop("BOUND_FAMILIES_UNAVAILABLE");
    flags.twoIndependentFamilies = true;
    const transport = options.transport ?? fetchTransport;
    if (request.mode === "finalized") {
      const resolved = await resolveLatestFinalized(selected, budget, transport); window = resolved.window;
      resolvedFinalized = resolved.headers; flags.finalizedBoundary = true;
    }
    const observations = [];
    for (const candidate of selected) observations.push(request.mode === "finalized"
      ? await observeResolvedFinalized(candidate, window, budget, transport)
      : await observe(candidate, window, budget, transport));
    if (resolvedFinalized && observations.some((row, index) => row.to.projection !== resolvedFinalized[index].projection)) {
      stop("FINALIZED_BOUNDARY_CHANGED");
    }
    flags.finalizedBoundary = true;
    if (observations[0].from.projection !== observations[1].from.projection || observations[0].to.projection !== observations[1].to.projection) stop("BOUNDARY_DISAGREEMENT");
    flags.boundaryAgreement = true;
    if (canonical(observations[0].logs) !== canonical(observations[1].logs)) stop("LOG_DISAGREEMENT");
    flags.normalizedLogAgreement = true;
    await terminalRecheck(observations, window, budget, transport); flags.terminalBoundaryStable = true;
    checkInventory(inventory.identity); flags.inventoryStable = true;
    return makeResult(STATUS_COMPLETE, null, window, artifact, selected, budget, observations[0].logs, flags);
  } catch (error) {
    if (inventory) try { checkInventory(inventory.identity); flags.inventoryStable = true; } catch (_) { flags.inventoryStable = false; }
    const errorCode = error instanceof ScannerError ? error.code : "INTERNAL_ERROR";
    return makeResult(STATUS_INCOMPLETE, errorCode, window, artifact, selected, budget, [], flags);
  }
}
function parseArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]; if (!["--from-block", "--to-block"].includes(flag) || index + 1 >= argv.length) stop("ARGUMENT_INVALID");
    const key = flag === "--from-block" ? "fromBlock" : "toBlock"; if (Object.hasOwn(output, key)) stop("ARGUMENT_INVALID");
    output[key] = argv[++index];
  }
  if (!Object.hasOwn(output, "toBlock") || (output.toBlock !== "finalized" && !Object.hasOwn(output, "fromBlock"))
      || (output.toBlock === "finalized" && Object.hasOwn(output, "fromBlock"))) stop("ARGUMENT_INVALID");
  return output;
}
async function main() {
  let output;
  try { output = await runScanner(parseArgs(process.argv.slice(2))); }
  catch (error) { output = makeResult(STATUS_INCOMPLETE, error instanceof ScannerError ? error.code : "ARGUMENT_INVALID", null, null, [], new Budget(), [], defaultFlags()); }
  process.stdout.write(`${JSON.stringify(output)}\n`); if (output.status !== STATUS_COMPLETE) process.exitCode = 1;
}
module.exports = { EVENT_DEFINITIONS, LIMITS, MAX_WINDOW_BLOCKS, STATUS_COMPLETE, STATUS_INCOMPLETE,
  ScannerError, assertSourceEventAbi, keccak256, requestedWindow, runScanner, validateWindow, verifyBindingArtifact };
if (require.main === module) main();
