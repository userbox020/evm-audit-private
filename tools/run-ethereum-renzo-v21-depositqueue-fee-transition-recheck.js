#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { classifyOperatorFamily } = require("./lib/common-finalized-rpc-preflight");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY_FILE = path.join(ROOT, "rpc_endpoints.txt");
const RUNTIME_FILE = path.join(ROOT, "reports", "raw", "fast", "critical-renzo-v21-current-runtime-binding-step4a-r3.json");
const FILES = Object.freeze({
  source: Object.freeze({ file: path.join(ROOT, "targets", "renzo-contracts-public-v2.1", "contracts", "Deposits", "DepositQueue.sol"), bytes: 12282, sha256: "b54a7fcdbb4ccac552fbf44fa9d766da38a169bb00cbeab4e3f60a87f93d4975" }),
  interface: Object.freeze({ file: path.join(ROOT, "targets", "renzo-contracts-public-v2.1", "contracts", "Deposits", "IDepositQueue.sol"), bytes: 487, sha256: "d0e9c0f32b127990c76515997ac8f779ac1f41f143c50e50bb11d127c575b9a8" }),
  attributionState: Object.freeze({ file: path.join(ROOT, "reports", "raw", "fast", "ethereum-renzo-v21-phase2-depositqueue-attribution-20260828-01", "state.json"), bytes: 4342, sha256: "9fca90095a974ff1b69b80902bb12f58104d47af06ab275f55c10cb1c67d4503" }),
  attributionManifest: Object.freeze({ file: path.join(ROOT, "reports", "raw", "fast", "ethereum-renzo-v21-phase2-depositqueue-attribution-20260828-01", "manifest.json"), bytes: 204, sha256: "bec8f754d677b5981ca99e5e4954957cfc082ee6ab5055bc67f1cfafdbaf43ea" })
});
const SELECTION_FILE = path.join(ROOT, "coordination", "inbox", "atomic-low-fund", "20260828-atomic-ethereum-protocol-delta-v1-selection.json");
const LIMITS = Object.freeze({ inventoryBytes: 1024 * 1024, candidates: 12, calls: 120, responseBytes: 1024 * 1024,
  totalResponseBytes: 8 * 1024 * 1024, logs: 16, windowBlocks: 8192, requestMs: 12000, wallMs: 180000 });
const METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getLogs", "eth_call"]);
const PHASES = new Set(["NONE", "AUTHORITY", "ABI", "INVENTORY", "QUALIFICATION", "HEADER", "LOG", "CALL", "TRANSITION", "TERMINAL", "CAP"]);
const CODES = new Set(["NONE", "AUTHORITY_INVALID", "ABI_INVALID", "INVENTORY_INVALID", "INVENTORY_MUTATED",
  "TWO_FAMILIES_UNAVAILABLE", "HEADER_INVALID", "HEADER_DISAGREEMENT", "LOG_INVALID", "LOG_DISAGREEMENT",
  "CALL_INVALID", "CALL_DISAGREEMENT", "TRANSITION_MISMATCH", "TERMINAL_RECHECK_FAILED", "READ_CAP", "UNEXPECTED"]);
const STATUS_EXACT = "EXACT_FEE_TRANSITION_RECHECKED";
const STATUS_INCOMPLETE = "INCOMPLETE";
const ZERO_ADDRESS = ethers.ZeroAddress.toLowerCase();

class RecheckError extends Error {
  constructor(phase, code) { super(code); this.name = "RecheckError"; this.phase = PHASES.has(phase) ? phase : "CAP"; this.code = CODES.has(code) ? code : "UNEXPECTED"; }
}
const fail = (phase, code) => { throw new RecheckError(phase, code); };
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function exactKeys(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(","); }
function readPinned(record, readFile) {
  let bytes; try { bytes = readFile(record.file); } catch (_) { fail("AUTHORITY", "AUTHORITY_INVALID"); }
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) fail("AUTHORITY", "AUTHORITY_INVALID");
  return bytes;
}
function deriveAbiAuthority(source) {
  const match = /event\s+FeeConfigUpdated\s*\(([^)]*)\)\s*;/u.exec(source);
  if (!match) fail("ABI", "ABI_INVALID");
  const parameters = match[1].split(",").map((row) => row.trim());
  if (parameters.length !== 2 || parameters.some((row) => /\bindexed\b/u.test(row))) fail("ABI", "ABI_INVALID");
  const types = parameters.map((row) => row.split(/\s+/u)[0]);
  const signature = `FeeConfigUpdated(${types.join(",")})`;
  let eventInterface; let topic;
  try { eventInterface = new ethers.Interface([`event FeeConfigUpdated(${parameters.join(",")})`]); topic = eventInterface.getEvent("FeeConfigUpdated").topicHash.toLowerCase(); }
  catch (_) { fail("ABI", "ABI_INVALID"); }
  if (topic !== ethers.id(signature).toLowerCase()) fail("ABI", "ABI_INVALID");
  return { declaration: `FeeConfigUpdated(${parameters.join(",")})`, signature, eventInterface, topic };
}
function readAuthority(options = {}) {
  const readFile = options.readFile || fs.readFileSync;
  const pinned = Object.fromEntries(Object.entries(FILES).map(([name, record]) => [name, readPinned(record, readFile)]));
  let state; let manifest; let selection; let selectionBytes;
  try { selectionBytes = readFile(SELECTION_FILE); if (!Buffer.isBuffer(selectionBytes)) selectionBytes = Buffer.from(selectionBytes); }
  catch (_) { fail("AUTHORITY", "AUTHORITY_INVALID"); }
  if (selectionBytes.length < 1 || selectionBytes.length > LIMITS.inventoryBytes) fail("AUTHORITY", "AUTHORITY_INVALID");
  try { state = JSON.parse(pinned.attributionState); manifest = JSON.parse(pinned.attributionManifest); selection = JSON.parse(selectionBytes); }
  catch (_) { fail("AUTHORITY", "AUTHORITY_INVALID"); }
  if (manifest.endpointFree !== true || manifest.files?.["state.json"]?.bytes !== FILES.attributionState.bytes
      || manifest.files?.["state.json"]?.sha256 !== FILES.attributionState.sha256
      || state.schema !== "ETHEREUM_RENZO_V21_PHASE2_DEPOSITQUEUE_ATTRIBUTION_V1"
      || state.attributionStatus !== "ATTRIBUTED_CHANGE_TRIGGER" || state.providerAgreement?.independentFamilies !== 2
      || state.providerAgreement?.finalized !== true || state.providerAgreement?.eip1898RequireCanonical !== true
      || selection.phase2Attribution?.artifact !== "reports/raw/fast/ethereum-renzo-v21-phase2-depositqueue-attribution-20260828-01/"
      || selection.renzoFeeChangeFollowup?.sourceArtifact !== selection.phase2Attribution.artifact
      || selection.renzoFeeChangeFollowup?.changedGetter !== "feeBasisPoints()"
      || selection.renzoFeeChangeFollowup?.eventKind !== "FeeConfigUpdated") fail("AUTHORITY", "AUTHORITY_INVALID");
  const getter = state.getters?.find((row) => row.signatureLabel === selection.renzoFeeChangeFollowup.changedGetter);
  const feeEvents = state.events?.rows?.filter((row) => row.kind === selection.renzoFeeChangeFollowup.eventKind) || [];
  const baseline = state.blockBindings?.baseline?.blockNumber, comparison = state.blockBindings?.comparison?.blockNumber;
  const eventBlock = feeEvents.length === 1 ? feeEvents[0].blockNumber : null;
  const priorFee = getter?.baseline?.decimalValue, newFee = getter?.comparison?.decimalValue;
  if (!/^\d+$/u.test(baseline || "") || !/^\d+$/u.test(comparison || "") || !/^\d+$/u.test(eventBlock || "")
      || !/^\d+$/u.test(priorFee || "") || !/^\d+$/u.test(newFee || "") || priorFee === newFee
      || getter.change !== "CHANGED" || getter.returnTypeClass !== "UNSIGNED_INTEGER"
      || selection.renzoFeeChangeFollowup.eventBlockNumber !== eventBlock
      || selection.renzoFeeChangeFollowup.baselineValue !== priorFee || selection.renzoFeeChangeFollowup.comparisonValue !== newFee
      || BigInt(baseline) >= BigInt(eventBlock) || BigInt(eventBlock) >= BigInt(comparison)) fail("AUTHORITY", "AUTHORITY_INVALID");
  const runtimeBinding = state.artifactBindings?.find((row) => row.artifact === "renzo-v21-runtime-authority-r3");
  if (!runtimeBinding || !Number.isSafeInteger(runtimeBinding.bytes) || !/^[0-9a-f]{64}$/u.test(runtimeBinding.sha256 || "")) fail("AUTHORITY", "AUTHORITY_INVALID");
  let runtimeBytes; try { runtimeBytes = readFile(RUNTIME_FILE); } catch (_) { fail("AUTHORITY", "AUTHORITY_INVALID"); }
  if (!Buffer.isBuffer(runtimeBytes)) runtimeBytes = Buffer.from(runtimeBytes);
  if (runtimeBytes.length !== runtimeBinding.bytes || sha256(runtimeBytes) !== runtimeBinding.sha256) fail("AUTHORITY", "AUTHORITY_INVALID");
  let runtime; try { runtime = JSON.parse(runtimeBytes); } catch (_) { fail("AUTHORITY", "AUTHORITY_INVALID"); }
  const target = runtime.chain?.proxies?.depositQueue?.address;
  try { if (ethers.getAddress(target).toLowerCase() === ZERO_ADDRESS) fail("AUTHORITY", "AUTHORITY_INVALID"); }
  catch (_) { fail("AUTHORITY", "AUTHORITY_INVALID"); }
  const source = pinned.source.toString("utf8"), interfaceSource = pinned.interface.toString("utf8");
  if (!source.includes("emit FeeConfigUpdated(_feeAddress, _feeBasisPoints);") || !source.includes("feeBasisPoints = _feeBasisPoints;")
      || !source.includes("if (_feeBasisPoints > 10000) revert OverMaxBasisPoints();") || !interfaceSource.includes("interface IDepositQueue")) fail("AUTHORITY", "AUTHORITY_INVALID");
  const abi = deriveAbiAuthority(source);
  if (getter.signatureLabel !== "feeBasisPoints()") fail("ABI", "ABI_INVALID");
  const getterInterface = new ethers.Interface([`function ${getter.signatureLabel} view returns (uint256)`]);
  const radius = 64n, event = BigInt(eventBlock); const from = event - radius, to = event + radius;
  if (to - from + 1n > BigInt(LIMITS.windowBlocks) || from <= BigInt(baseline) || to >= BigInt(comparison)) fail("AUTHORITY", "AUTHORITY_INVALID");
  const authority = { baseline: BigInt(baseline), comparison: BigInt(comparison), eventBlock: event,
    priorFee: BigInt(priorFee), newFee: BigInt(newFee), from, to, getterInterface, getterSignature: getter.signatureLabel,
    eventDeclaration: abi.declaration };
  Object.defineProperties(authority, { target: { value: ethers.getAddress(target).toLowerCase() }, topic: { value: abi.topic }, eventInterface: { value: abi.eventInterface } });
  return Object.freeze(authority);
}

function fileIdentity(stat) { return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }; }
function readStableInventory() {
  let before; let heldBefore; let heldAfter; let after; let fd; let bytes; let real;
  try {
    before = fs.lstatSync(INVENTORY_FILE); real = fs.realpathSync.native(INVENTORY_FILE);
    if (!before.isFile() || before.isSymbolicLink() || real !== INVENTORY_FILE || before.size < 1 || before.size > LIMITS.inventoryBytes) fail("INVENTORY", "INVENTORY_INVALID");
    fd = fs.openSync(INVENTORY_FILE, "r"); heldBefore = fs.fstatSync(fd); bytes = fs.readFileSync(fd); heldAfter = fs.fstatSync(fd); after = fs.lstatSync(INVENTORY_FILE);
  } catch (error) { if (error instanceof RecheckError) throw error; fail("INVENTORY", "INVENTORY_INVALID"); }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
  if (bytes.length !== before.size || stable(fileIdentity(before)) !== stable(fileIdentity(after))
      || stable(fileIdentity(heldBefore)) !== stable(fileIdentity(heldAfter)) || String(before.dev) !== String(heldBefore.dev)
      || String(before.ino) !== String(heldBefore.ino)) fail("INVENTORY", "INVENTORY_MUTATED");
  return { text: bytes.toString("utf8"), identity: fileIdentity(after) };
}
function inventoryUnchanged(expected) {
  let stat; let real; try { stat = fs.lstatSync(INVENTORY_FILE); real = fs.realpathSync.native(INVENTORY_FILE); } catch (_) { fail("INVENTORY", "INVENTORY_MUTATED"); }
  if (!stat.isFile() || stat.isSymbolicLink() || real !== INVENTORY_FILE || stable(fileIdentity(stat)) !== stable(expected)) fail("INVENTORY", "INVENTORY_MUTATED");
}
function placeholder(url, context) {
  let decoded; try { decoded = decodeURIComponent(`${url.pathname} ${url.search}`); } catch (_) { return true; }
  return /(?:^|\.)(?:example|placeholder|invalid)(?:\.|$)/u.test(url.hostname.toLowerCase())
    || /(?:\{|\}|<|>|\$\{|your[-_ ]?(?:api[-_ ]?)?key|replace[-_ ]?(?:me|this)|insert[-_ ]?(?:key|token)|placeholder|changeme|api[-_ ]?key[-_ ]?here)/iu.test(`${context} ${decoded}`);
}
function parseInventoryText(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) < 1 || Buffer.byteLength(text) > LIMITS.inventoryBytes) fail("INVENTORY", "INVENTORY_INVALID");
  const rows = []; const seen = new Set(); let section = ""; let ordinal = 0;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim(); if (trimmed && trimmed.length <= 512 && !/https?:\/\//iu.test(trimmed)) section = trimmed;
    for (const match of line.matchAll(/https?:\/\/[^\s<'"`\])}]+/giu)) {
      const localOrdinal = ordinal++; let url; try { url = new URL(match[0].replace(/[>,.;]+$/u, "")); } catch (_) { continue; }
      const context = `${section} ${line}`; const lower = context.toLowerCase(); const rowLower = line.toLowerCase();
      const ethereum = /\b(?:ethereum|eth[- _]?mainnet)\b|\b(?:chain(?:id)?|eip155)\s*[:=]?\s*1\b/u.test(lower);
      const ethereumRow = /\b(?:ethereum|eth[- _]?mainnet)\b|\b(?:chain(?:id)?|eip155)\s*[:=]?\s*1\b/u.test(rowLower);
      const otherRow = /\b(?:base|arbitrum|optimism|polygon|bnb|bsc|avalanche|linea|scroll|zksync|solana|sepolia|hoodi|testnet)\b/u.test(rowLower);
      const forbidden = /\b(?:restricted|unavailable|disabled|retired|deprecated|unsupported|failed|dead|app[- _]?scoped|private|internal)\b|\bdo[- ]?not[- ]?use\b/iu.test(lower)
        || /\b(?:origin[- _]?required|browser[- _]?only|session[- _]?auth|session|cookie|referer|cors)\b|\brequires?\b[^\r\n]{0,40}\borigin\b/iu.test(lower)
        || /\b(?:custom[- _]?headers?|authorization|bearer|x[- _]?api[- _]?key)\b|\brequires?\b[^\r\n]{0,40}\bheaders?\b/iu.test(lower);
      const unsafe = url.protocol !== "https:" || Boolean(url.username || url.password || url.hash) || (url.port && url.port !== "443")
        || /(?:localhost|\.local|\.internal|\.invalid)$/u.test(url.hostname.toLowerCase()) || /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(url.hostname);
      const classified = classifyOperatorFamily(url.href);
      if (!ethereum || (otherRow && !ethereumRow) || forbidden || unsafe || placeholder(url, context) || !classified) continue;
      if (seen.has(url.href)) continue; seen.add(url.href);
      rows.push({ url, family: classified.operatorFamily, capabilityRank: classified.capabilityRank, ordinal: localOrdinal });
    }
  }
  return rows.sort((a, b) => a.capabilityRank - b.capabilityRank || a.ordinal - b.ordinal).slice(0, LIMITS.candidates);
}

class Budget {
  constructor(maxCalls = LIMITS.calls) { this.maxCalls = Math.min(LIMITS.calls, maxCalls); this.calls = 0; this.bytes = 0; this.started = Date.now(); }
  use() { if (++this.calls > this.maxCalls || Date.now() - this.started > LIMITS.wallMs) fail("CAP", "READ_CAP"); }
  add(bytes) { if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > LIMITS.responseBytes) fail("CAP", "READ_CAP"); this.bytes += bytes; if (this.bytes > LIMITS.totalResponseBytes) fail("CAP", "READ_CAP"); }
}
async function fetchTransport({ candidate, envelope, timeoutMs }) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(candidate.url.href, { method: "POST", redirect: "error", signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json", "accept-encoding": "identity" }, body: JSON.stringify(envelope) });
    if (response.status !== 200) throw new Error("transport"); const text = await response.text();
    if (Buffer.byteLength(text) > LIMITS.responseBytes) fail("CAP", "READ_CAP"); const value = JSON.parse(text);
    return { value, bytes: Buffer.byteLength(text) };
  } catch (error) { if (error instanceof RecheckError) throw error; throw new Error("transport"); }
  finally { clearTimeout(timer); }
}
async function rpc(candidate, method, params, budget, transport) {
  if (!METHODS.has(method)) fail("CAP", "READ_CAP"); budget.use(); const envelope = { jsonrpc: "2.0", id: budget.calls, method, params };
  let row; try { row = await transport({ candidate, envelope, timeoutMs: LIMITS.requestMs }); } catch (error) { if (error instanceof RecheckError) throw error; throw new Error("transport"); }
  if (!row || !Number.isSafeInteger(row.bytes) || !row.value || row.value.jsonrpc !== "2.0" || row.value.id !== envelope.id
      || Object.hasOwn(row.value, "error") || !Object.hasOwn(row.value, "result")) throw new Error("transport");
  budget.add(row.bytes); return row.value.result;
}
function quantity(value) { if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/iu.test(value)) throw new Error("quantity"); return BigInt(value); }
function normalizeHeader(value, expected = null) {
  try {
    if (!value || typeof value !== "object" || !/^0x[0-9a-f]{64}$/iu.test(value.hash || "") || !/^0x[0-9a-f]{64}$/iu.test(value.parentHash || "")
        || !/^0x[0-9a-f]{64}$/iu.test(value.stateRoot || "")) throw new Error("header");
    const number = quantity(value.number); const timestamp = quantity(value.timestamp); if (expected !== null && number !== expected) throw new Error("header");
    return { number: number.toString(), hash: value.hash.toLowerCase(), parentHash: value.parentHash.toLowerCase(), stateRoot: value.stateRoot.toLowerCase(), timestamp: timestamp.toString() };
  } catch (_) { fail("HEADER", "HEADER_INVALID"); }
}
function blockRef(header) { return { blockHash: header.hash, requireCanonical: true }; }
function decodeFee(value, authority) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/iu.test(value)) fail("CALL", "CALL_INVALID");
  try { return BigInt(authority.getterInterface.decodeFunctionResult(authority.getterSignature, value)[0]); }
  catch (_) { fail("CALL", "CALL_INVALID"); }
}
function normalizeLogs(value, authority, eventHeader) {
  if (!Array.isArray(value) || value.length > LIMITS.logs) fail("LOG", "LOG_INVALID");
  const rows = value.map((log) => {
    try {
      if (!log || log.removed !== false || String(log.address).toLowerCase() !== authority.target || !Array.isArray(log.topics)
          || log.topics.length !== 1 || String(log.topics[0]).toLowerCase() !== authority.topic || !/^0x[0-9a-f]{128}$/iu.test(log.data || "")
          || !/^0x[0-9a-f]{64}$/iu.test(log.blockHash || "") || !/^0x[0-9a-f]{64}$/iu.test(log.transactionHash || "")) throw new Error("log");
      const block = quantity(log.blockNumber), transactionIndex = quantity(log.transactionIndex), logIndex = quantity(log.logIndex);
      if (block < authority.from || block > authority.to || block !== authority.eventBlock || log.blockHash.toLowerCase() !== eventHeader.hash) throw new Error("log");
      const parsed = authority.eventInterface.parseLog({ topics: log.topics, data: log.data }); if (!parsed) throw new Error("log");
      const feeAddress = ethers.getAddress(parsed.args[0]).toLowerCase(), fee = BigInt(parsed.args[1]);
      if (fee > 10000n || (fee > 0n && feeAddress === ZERO_ADDRESS)) throw new Error("log");
      return { block: block.toString(), blockHash: log.blockHash.toLowerCase(), transactionHash: log.transactionHash.toLowerCase(),
        transactionIndex: transactionIndex.toString(), logIndex: logIndex.toString(), feeAddress, fee: fee.toString() };
    } catch (_) { fail("LOG", "LOG_INVALID"); }
  }).sort((a, b) => BigInt(a.transactionIndex) < BigInt(b.transactionIndex) ? -1 : BigInt(a.transactionIndex) > BigInt(b.transactionIndex) ? 1 : BigInt(a.logIndex) < BigInt(b.logIndex) ? -1 : 1);
  if (new Set(rows.map((row) => `${row.transactionHash}:${row.logIndex}`)).size !== rows.length) fail("LOG", "LOG_INVALID");
  return rows;
}
async function qualify(candidate, authority, budget, transport) {
  if (quantity(await rpc(candidate, "eth_chainId", [], budget, transport)) !== 1n) throw new Error("wrong-chain");
  const finalized = normalizeHeader(await rpc(candidate, "eth_getBlockByNumber", ["finalized", false], budget, transport));
  if (BigInt(finalized.number) < authority.comparison) throw new Error("not-finalized");
  const probe = await rpc(candidate, "eth_getLogs", [{ address: authority.target, fromBlock: ethers.toQuantity(authority.eventBlock),
    toBlock: ethers.toQuantity(authority.eventBlock), topics: [authority.topic] }], budget, transport);
  if (!Array.isArray(probe)) throw new Error("logs"); return { candidate, finalized };
}
async function captureView(row, authority, budget, transport) {
  const headers = {};
  for (const [name, number] of [["baseline", authority.baseline], ["comparison", authority.comparison], ["event", authority.eventBlock]]) {
    headers[name] = normalizeHeader(await rpc(row.candidate, "eth_getBlockByNumber", [ethers.toQuantity(number), false], budget, transport), number);
  }
  const logs = normalizeLogs(await rpc(row.candidate, "eth_getLogs", [{ address: authority.target, fromBlock: ethers.toQuantity(authority.from),
    toBlock: ethers.toQuantity(authority.to), topics: [authority.topic] }], budget, transport), authority, headers.event);
  const data = authority.getterInterface.encodeFunctionData(authority.getterSignature, []);
  const priorFee = decodeFee(await rpc(row.candidate, "eth_call", [{ to: authority.target, data }, blockRef(headers.baseline)], budget, transport), authority);
  const newFee = decodeFee(await rpc(row.candidate, "eth_call", [{ to: authority.target, data }, blockRef(headers.comparison)], budget, transport), authority);
  return { row, headers, logs, priorFee: priorFee.toString(), newFee: newFee.toString() };
}
function compareViews(left, right, authority) {
  if (stable(left.headers) !== stable(right.headers)) return new RecheckError("HEADER", "HEADER_DISAGREEMENT");
  if (stable(left.logs) !== stable(right.logs)) return new RecheckError("LOG", "LOG_DISAGREEMENT");
  if (left.priorFee !== right.priorFee || left.newFee !== right.newFee) return new RecheckError("CALL", "CALL_DISAGREEMENT");
  const eventExact = left.logs.length === 1 && BigInt(left.logs[0].fee) === authority.newFee;
  if (BigInt(left.priorFee) !== authority.priorFee || BigInt(left.newFee) !== authority.newFee || !eventExact) return new RecheckError("TRANSITION", "TRANSITION_MISMATCH");
  return null;
}
async function terminalRecheck(selected, budget, transport) {
  for (const view of selected) for (const [name, header] of Object.entries(view.headers)) {
    const current = normalizeHeader(await rpc(view.row.candidate, "eth_getBlockByNumber", [ethers.toQuantity(header.number), false], budget, transport), BigInt(header.number));
    if (stable(current) !== stable(header) || stable(current) !== stable(selected[0].headers[name])) fail("TERMINAL", "TERMINAL_RECHECK_FAILED");
  }
}
function emptyResult() { return { status: STATUS_INCOMPLETE, phase: "NONE", code: "NONE", anonymousCandidateCount: 0,
  anonymousQualifiedCount: 0, anonymousSelectedCount: 0, blockRange: { fromBlock: null, toBlock: null }, eventCount: 0,
  transitionAgreement: false, readCount: 0, cleanupComplete: true }; }
function validateOutput(output) {
  if (!exactKeys(output, ["status", "phase", "code", "anonymousCandidateCount", "anonymousQualifiedCount", "anonymousSelectedCount", "blockRange", "eventCount", "transitionAgreement", "readCount", "cleanupComplete"])
      || ![STATUS_EXACT, STATUS_INCOMPLETE].includes(output.status) || !PHASES.has(output.phase) || !CODES.has(output.code)
      || (output.status === STATUS_EXACT) !== (output.phase === "NONE" && output.code === "NONE" && output.transitionAgreement === true)
      || ![output.anonymousCandidateCount, output.anonymousQualifiedCount, output.anonymousSelectedCount, output.eventCount, output.readCount].every(Number.isSafeInteger)
      || output.anonymousCandidateCount > LIMITS.candidates || output.anonymousSelectedCount > 2 || output.readCount > LIMITS.calls
      || output.cleanupComplete !== true || !exactKeys(output.blockRange, ["fromBlock", "toBlock"])) fail("CAP", "UNEXPECTED");
  const serialized = JSON.stringify(output);
  if (/(?:https?|wss?):\/\/|0x[0-9a-f]{8,}|provider|endpoint|credential|topic|address|hash|rpc[_-]?endpoints/iu.test(serialized)) fail("CAP", "UNEXPECTED");
  return true;
}
async function runRecheck(options = {}) {
  const output = emptyResult(); const budget = new Budget(options.maxCalls ?? LIMITS.calls); let inventory = null;
  const transport = options.transport || fetchTransport; const checkInventory = options.assertInventoryUnchangedFn || inventoryUnchanged;
  try {
    const authority = await (options.authorityAdapter || readAuthority)(options.authorityOptions || {});
    output.blockRange = { fromBlock: authority.from.toString(), toBlock: authority.to.toString() };
    inventory = options.inventoryText !== undefined ? { text: options.inventoryText, identity: options.inventoryIdentity ?? "injected" }
      : (options.readInventoryFn ? options.readInventoryFn() : readStableInventory());
    if (!inventory || typeof inventory.text !== "string" || !Object.hasOwn(inventory, "identity")) fail("INVENTORY", "INVENTORY_INVALID");
    const candidates = parseInventoryText(inventory.text); output.anonymousCandidateCount = candidates.length;
    const qualified = [];
    for (const candidate of candidates) {
      try { qualified.push(await qualify(candidate, authority, budget, transport)); }
      catch (error) { if (error instanceof RecheckError && error.code === "READ_CAP") throw error; }
    }
    output.anonymousQualifiedCount = qualified.length;
    if (new Set(qualified.map((row) => row.candidate.family)).size < 2) fail("QUALIFICATION", "TWO_FAMILIES_UNAVAILABLE");
    const views = []; let pair = null; let disagreement = null; let viewFailure = null;
    for (const row of qualified) {
      let view; try { view = await captureView(row, authority, budget, transport); }
      catch (error) { if (error instanceof RecheckError) { if (error.code === "READ_CAP") throw error; viewFailure = error; } continue; }
      for (const prior of views) {
        if (prior.row.candidate.family === view.row.candidate.family) continue;
        const mismatch = compareViews(prior, view, authority); if (!mismatch) { pair = [prior, view]; break; } disagreement = mismatch;
      }
      views.push(view); if (pair) break;
    }
    if (!pair) throw disagreement || viewFailure || new RecheckError("TRANSITION", "TRANSITION_MISMATCH");
    await terminalRecheck(pair, budget, transport); checkInventory(inventory.identity);
    output.status = STATUS_EXACT; output.anonymousSelectedCount = 2; output.eventCount = pair[0].logs.length; output.transitionAgreement = true;
  } catch (error) {
    const failure = error instanceof RecheckError ? error : new RecheckError("CAP", "UNEXPECTED");
    output.phase = failure.phase; output.code = failure.code;
  } finally {
    if (inventory && output.code !== "INVENTORY_MUTATED") try { checkInventory(inventory.identity); } catch (_) { output.status = STATUS_INCOMPLETE; output.phase = "INVENTORY"; output.code = "INVENTORY_MUTATED"; output.transitionAgreement = false; output.anonymousSelectedCount = 0; }
    output.readCount = budget.calls;
  }
  validateOutput(output); return output;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 0) { process.stdout.write(`${JSON.stringify({ status: STATUS_INCOMPLETE, phase: "CAP", code: "UNEXPECTED", anonymousCandidateCount: 0, anonymousQualifiedCount: 0, anonymousSelectedCount: 0, blockRange: { fromBlock: null, toBlock: null }, eventCount: 0, transitionAgreement: false, readCount: 0, cleanupComplete: true })}\n`); process.exitCode = 1; return; }
  const result = await runRecheck(); process.stdout.write(`${JSON.stringify(result)}\n`); if (result.status !== STATUS_EXACT) process.exitCode = 1;
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });

module.exports = Object.freeze({ FILES, INVENTORY_FILE, LIMITS, RecheckError, STATUS_EXACT, STATUS_INCOMPLETE,
  deriveAbiAuthority, parseInventoryText, readAuthority, runRecheck, validateOutput });
