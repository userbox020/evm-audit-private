#!/usr/bin/env node
"use strict";

// Corrected hash-bound semantic retry runner. Packaging and fixtures are offline.
// Network mode remains review-gated and performs read-only JSON-RPC only.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { getAddress, keccak256 } = require("ethers");
const r5 = require("./run-critical-etherfi-behype-hyperevm-behavioral-retry-r5.js");

const R5_AGGREGATE = "be013a696f47fed186c88faf26026627ba4ae6269473cf771c3e92335e2f48d1";
const SELECTED_FAMILIES = [...r5.SELECTED_FAMILIES];
const STAGES = [
  { id: "identity-finalized-before-initial-canary", min: 9, max: 9, perEndpointMax: 3 },
  { id: "initial-canaries-immediately-before-pin", min: 24, max: 24, perEndpointMax: 8 },
  { id: "pin-selection", min: 3, max: 3, perEndpointMax: 1 },
  { id: "two-routes-and-integration", min: 153, max: 153, perEndpointMax: 51 },
  { id: "anchor-log-queries", min: 18, max: 18, perEndpointMax: 6 },
  { id: "namespace-lookups", min: 0, max: 96, perEndpointMax: 32 },
  { id: "positive-system-receipt-evidence", min: 0, max: 48, perEndpointMax: 16 },
  { id: "finalized-after-all-semantic-reads", min: 3, max: 3, perEndpointMax: 1 },
  { id: "mandatory-canary-rerun-before-terminal", min: 24, max: 24, perEndpointMax: 8 },
  { id: "final-terminal-pin-recheck", min: 3, max: 3, perEndpointMax: 1 },
].map((row, index) => ({ ...row, order: index + 1 }));
const POLICY = Object.freeze({
  maxAttemptsTotal: 420, maxAttemptsPerEndpoint: 140, successfulPathMin: 237,
  successfulPathMax: 381, retries: 10, maxPathWithRetries: 391,
  serviceTimeoutMs: 2000, interAttemptGapMs: 1000, rateWaitMs: 30000,
  otherRetryWaitMs: 5000, captureDeadlineMs: 2700000, pinDeadlineMs: 600000,
  startDeadlineMs: 900000, maxNamespaceTransactionsPerEndpoint: 16,
  namespaceDispatchSeparationMs: 2000, logsPerEndpoint: 500,
});
const READ_ONLY = new Set(r5.READ_ONLY);
const EIP1967 = r5.EIP1967;
const ABI = r5.ABI;
const ENDPOINT_IFACE = r5.ENDPOINT_IFACE;
const LIB_IFACE = r5.LIB_IFACE;
const OAPP_IFACE = r5.OAPP_IFACE;
const ADAPTER_IFACE = r5.ADAPTER_IFACE;
const ERC20_IFACE = r5.ERC20_IFACE;
const ERROR_SELECTOR = r5.ERROR_SELECTOR;

const lower = (value) => typeof value === "string" ? value.toLowerCase() : value;
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const canonicalJson = (value) => JSON.stringify(canonical(value));
const digest = (value) => sha(Buffer.from(canonicalJson(value)));
const hex = (value) => `0x${BigInt(value).toString(16)}`;
const quantity = (value) => typeof value === "string" && /^(?:0x0|0x[1-9a-f][0-9a-f]*)$/.test(value);
const word = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
const bytes = (value) => typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/.test(value);
const addressHex = (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value);
const address = (value) => { try { return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? getAddress(value).toLowerCase() : null; } catch { return null; } };
const hashFile = (file) => { const body = fs.readFileSync(file); return { bytes: body.length, sha256: sha(body) }; };
const aggregateRecords = (records) => sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
const safeNumber = (value) => { if (!quantity(lower(value))) throw new SemanticStop("QUANTITY_SCHEMA_INVALID"); const out = Number(BigInt(value)); if (!Number.isSafeInteger(out)) throw new SemanticStop("QUANTITY_UNSAFE"); return out; };

class SemanticStop extends Error { constructor(code, stage = "preflight") { super(code); this.code = code; this.stage = stage; } }
class RpcFailure extends Error { constructor(category) { super(category); this.category = category; } }
class RealClock { now() { return Date.now(); } sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); } schedule(ms, fn) { return setTimeout(fn, ms); } cancel(token) { clearTimeout(token); } }
class MockClock { constructor(now = 0) { this.time = now; this.next = 1; this.timers = new Map(); this.inflations = []; } now() { return this.time; } schedule(ms, fn) { const id = this.next++; this.timers.set(id, { at: this.time + ms, fn }); return id; } cancel(id) { this.timers.delete(id); } advance(ms) { this.time += ms; for (const [id, row] of [...this.timers.entries()].filter(([, row]) => row.at <= this.time).sort((a, b) => a[1].at - b[1].at)) { this.timers.delete(id); row.fn(); } } async sleep(ms) { this.advance(ms + (this.inflations.shift() || 0)); } inflateNextSleep(ms) { this.inflations.push(ms); } }

function assertReadOnlyMethod(method) { if (!READ_ONLY.has(method) || /send|sign|personal|wallet|mine|submit|broadcast/i.test(method)) throw new SemanticStop("RPC_METHOD_FORBIDDEN"); }
function verifyRecords(root, records, missingCode, mismatchCode) {
  const actual = records.map((row) => { const file = path.join(root, row.path); if (!fs.existsSync(file)) throw new SemanticStop(missingCode); const current = { path: row.path, ...hashFile(file) }; if (current.bytes !== row.bytes || current.sha256 !== row.sha256) throw new SemanticStop(mismatchCode); return current; });
  return actual;
}
function verifyPackage(options) {
  const { workspaceRoot: root, manifestRelativePath, approvedDecision, clock, mode } = options;
  if (!approvedDecision || typeof approvedDecision.decisionTimestamp !== "string") throw new SemanticStop("APPROVED_DECISION_TIMESTAMP_REQUIRED");
  const decisionAt = Date.parse(approvedDecision.decisionTimestamp);
  if (!Number.isFinite(decisionAt) || clock.now() < decisionAt || clock.now() - decisionAt > POLICY.startDeadlineMs) throw new SemanticStop("APPROVAL_START_DEADLINE_EXCEEDED");
  if (mode === "network" && approvedDecision.decision !== "APPROVED") throw new SemanticStop("NETWORK_DECISION_NOT_APPROVED");
  if (mode === "mock" && approvedDecision.decision !== "APPROVED_FOR_MOCK_FIXTURE_ONLY") throw new SemanticStop("MOCK_DECISION_NOT_APPROVED");
  const manifestPath = path.join(root, manifestRelativePath);
  if (!fs.existsSync(manifestPath)) throw new SemanticStop("PACKAGE_MANIFEST_MISSING");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.runId !== approvedDecision.proposalRunId || manifest.aggregateSha256 !== approvedDecision.packageManifestAggregateSha256) throw new SemanticStop("PACKAGE_APPROVAL_BINDING_MISMATCH");
  if (manifest.proposalStatus !== "REVIEW_REQUESTED/NOT_AUTHORIZED/NOT_EXECUTED" || manifest.predecessorBinding?.manifestAggregateSha256 !== R5_AGGREGATE) throw new SemanticStop("R5_BINDING_MISMATCH");
  const actual = verifyRecords(root, manifest.records, "PACKAGE_RECORD_MISSING", "PACKAGE_RECORD_HASH_MISMATCH");
  if (aggregateRecords(actual) !== manifest.aggregateSha256) throw new SemanticStop("PACKAGE_AGGREGATE_MISMATCH");
  const runnerRel = path.relative(root, __filename).replace(/\\/g, "/");
  const self = actual.find((row) => row.path === runnerRel);
  if (!self || self.sha256 !== manifest.runner?.sha256 || self.bytes !== manifest.runner?.bytes) throw new SemanticStop("RUNNER_SELF_HASH_MISMATCH");
  const r5ManifestRel = manifest.predecessorBinding?.manifest?.path;
  if (!r5ManifestRel) throw new SemanticStop("R5_MANIFEST_BINDING_MISSING");
  const r5Manifest = JSON.parse(fs.readFileSync(path.join(root, r5ManifestRel), "utf8"));
  if (r5Manifest.aggregateSha256 !== R5_AGGREGATE) throw new SemanticStop("R5_AGGREGATE_MISMATCH");
  const r5Actual = verifyRecords(root, r5Manifest.records, "R5_RECORD_MISSING", "R5_RECORD_HASH_MISMATCH");
  if (aggregateRecords(r5Actual) !== R5_AGGREGATE) throw new SemanticStop("R5_RECORD_AGGREGATE_MISMATCH");
  return manifest;
}
function defaultInventoryProvider(root) { return { readCount: 0, read() { this.readCount++; return [fs.readFileSync(path.join(root, "rpc_endpoints.txt"), "utf8"), fs.readFileSync(path.join(root, "hyperevm_archive_endpoints.md"), "utf8")]; } }; }
function strictData(value) { const out = lower(value); if (!bytes(out)) throw new SemanticStop("MALFORMED_ABI"); return out; }
function decodeStrict(iface, name, raw) { try { return r5.decodeStrict(iface, name, raw); } catch (error) { throw error instanceof r5.SemanticStop ? new SemanticStop(error.code, error.stage) : error; } }
function normalizeLog(row, roleMap, fromBlock, toBlock) { try { return r5.normalizeLog(row, roleMap, fromBlock, toBlock); } catch (error) { throw error instanceof r5.SemanticStop ? new SemanticStop(error.code, error.stage) : error; } }
function decodeConfig(payload, type) { try { return r5.decodeConfig(payload, type); } catch (error) { throw error instanceof r5.SemanticStop ? new SemanticStop(error.code, error.stage) : error; } }
function matchTransaction(tx, log) {
  return tx && typeof tx === "object" && lower(tx.hash || tx.transactionHash) === log.transactionHash && lower(tx.blockHash) === log.blockHash && quantity(lower(tx.blockNumber)) && BigInt(tx.blockNumber) === BigInt(log.blockNumber) && quantity(lower(tx.transactionIndex)) && BigInt(tx.transactionIndex) === BigInt(log.transactionIndex);
}
function receiptMatches(receipt, txHash, logs) {
  if (!receipt || lower(receipt.transactionHash) !== txHash || lower(receipt.blockHash) !== logs[0].blockHash || !quantity(lower(receipt.blockNumber)) || BigInt(receipt.blockNumber) !== BigInt(logs[0].blockNumber) || !quantity(lower(receipt.transactionIndex)) || BigInt(receipt.transactionIndex) !== BigInt(logs[0].transactionIndex) || !Array.isArray(receipt.logs)) return false;
  return logs.every((log) => receipt.logs.some((item) => lower(item.address) === log.address && lower(item.blockHash) === log.blockHash && quantity(lower(item.logIndex)) && BigInt(item.logIndex) === BigInt(log.logIndex) && canonicalJson((item.topics || []).map(lower)) === canonicalJson(log.topics) && lower(item.data) === log.data));
}

class SemanticRetryRunner {
  constructor(options) {
    this.options = options; this.clock = options.clock || new RealClock(); this.fetchImpl = options.fetchImpl || global.fetch; this.mode = options.mode || "network"; this.inventoryProvider = options.inventoryProvider || defaultInventoryProvider(options.workspaceRoot);
    this.attempts = 0; this.retries = 0; this.perEndpoint = {}; this.stageDebits = Object.fromEntries(STAGES.map((row) => [row.id, 0])); this.stageIndex = 0; this.lastDispatch = null; this.startedAt = null; this.pinAt = null; this.executionOrder = [];
  }
  stop(code, stage = STAGES[this.stageIndex]?.id || "preflight") { throw new SemanticStop(code, stage); }
  deadline(stage) { if (this.clock.now() - this.startedAt > POLICY.captureDeadlineMs) this.stop("CAPTURE_DEADLINE_EXCEEDED", stage); }
  debit(endpoint, stage, retry) {
    const expected = STAGES[this.stageIndex]; if (!expected || expected.id !== stage) this.stop("STAGE_ORDER_VIOLATION", stage);
    if (!retry) { if (this.stageDebits[stage] >= expected.max) this.stop("STAGE_BUDGET_EXHAUSTED", stage); this.stageDebits[stage]++; }
    else { if (this.retries >= POLICY.retries) this.stop("RETRY_RESERVE_EXHAUSTED", stage); this.retries++; }
    if (this.attempts >= POLICY.maxAttemptsTotal) this.stop("GLOBAL_ATTEMPT_CAP_EXHAUSTED", stage);
    if ((this.perEndpoint[endpoint.endpointId] || 0) >= POLICY.maxAttemptsPerEndpoint) this.stop("PER_ENDPOINT_ATTEMPT_CAP_EXHAUSTED", stage);
    this.attempts++; this.perEndpoint[endpoint.endpointId] = (this.perEndpoint[endpoint.endpointId] || 0) + 1;
  }
  completeStage(stage, exact = null) {
    const expected = STAGES[this.stageIndex]; const required = exact === null ? expected.max : exact;
    if (!expected || expected.id !== stage || required < expected.min || required > expected.max || this.stageDebits[stage] !== required) this.stop("STAGE_INCOMPLETE", stage);
    this.executionOrder.push(stage); this.stageIndex++;
  }
  async gap(stage) { if (this.lastDispatch !== null) { const wait = POLICY.interAttemptGapMs - (this.clock.now() - this.lastDispatch); if (wait > 0) await this.clock.sleep(wait); } this.deadline(stage); }
  async fetchEnvelope(endpoint, method, params, stage, retry) {
    assertReadOnlyMethod(method); await this.gap(stage); this.debit(endpoint, stage, retry);
    const controller = new AbortController(); let rejectTimeout;
    const timeoutPromise = new Promise((_, reject) => { rejectTimeout = reject; });
    const timer = this.clock.schedule(POLICY.serviceTimeoutMs, () => { controller.abort(); rejectTimeout(new RpcFailure("timeout")); });
    let dispatchAt = null;
    const body = JSON.stringify({ jsonrpc: "2.0", id: this.attempts, method, params });
    const request = Promise.resolve().then(() => {
      dispatchAt = this.clock.now(); this.lastDispatch = dispatchAt;
      return this.fetchImpl(endpoint.url, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json", ...endpoint.headers }, body });
    }).then(async (response) => { if (!response || !response.ok) throw new RpcFailure(Number(response?.status) === 429 ? "rate-limited" : Number(response?.status) >= 500 ? "http-5xx" : "http-error"); return response.json(); });
    try { return { envelope: await Promise.race([request, timeoutPromise]), dispatchAt }; } finally { this.clock.cancel(timer); }
  }
  async rpc(endpoint, stage, method, params, options = {}) {
    const parse = (row, afterRetry = false) => {
      const envelope = row.envelope;
      if (envelope?.error) { const category = Number(envelope.error.code) === 429 || Number(envelope.error.code) === -32005 ? "rate-limited" : "rpc-error"; if (options.allowError && category !== "rate-limited") return { value: envelope, dispatchAt: row.dispatchAt }; throw new RpcFailure(category); }
      if (!envelope || !Object.hasOwn(envelope, "result")) throw new RpcFailure(afterRetry ? "response-schema-invalid-after-retry" : "response-schema-invalid");
      return { value: options.envelope ? envelope : envelope.result, dispatchAt: row.dispatchAt };
    };
    try { const parsed = parse(await this.fetchEnvelope(endpoint, method, params, stage, false)); return options.meta ? parsed : parsed.value; }
    catch (error) {
      if (error instanceof SemanticStop) throw error; const category = error instanceof RpcFailure ? error.category : "transport-error";
      if (options.noRetry || !["timeout", "rate-limited", "http-5xx"].includes(category)) this.stop(category.toUpperCase().replace(/-/g, "_"), stage);
      if (this.retries >= POLICY.retries) this.stop("RETRY_RESERVE_EXHAUSTED", stage);
      await this.clock.sleep(category === "rate-limited" ? POLICY.rateWaitMs : POLICY.otherRetryWaitMs); this.deadline(stage);
      try { const parsed = parse(await this.fetchEnvelope(endpoint, method, params, stage, true), true); return options.meta ? parsed : parsed.value; }
      catch (retryError) { if (retryError instanceof SemanticStop) throw retryError; const retryCategory = retryError instanceof RpcFailure ? retryError.category : "transport-error"; this.stop(retryCategory === "timeout" ? "TIMEOUT_PERSISTED" : retryCategory === "rate-limited" ? "RATE_LIMIT_PERSISTED" : "RETRY_FAILED", stage); }
    }
  }
  async strictCall(endpoint, stage, to, iface, name, args, block) { const raw = await this.rpc(endpoint, stage, "eth_call", [{ to, data: iface.encodeFunctionData(name, args) }, hex(block)]); return decodeStrict(iface, name, raw); }
  async runtime(endpoint, target, pin, stage) {
    const code = strictData(await this.rpc(endpoint, stage, "eth_getCode", [target, hex(pin)])); if (code === "0x") this.stop("CODE_ABSENT", stage);
    const slots = {}; for (const [name, slot] of Object.entries(EIP1967)) { const value = lower(await this.rpc(endpoint, stage, "eth_getStorageAt", [target, slot, hex(pin)])); if (!word(value)) this.stop("PROXY_SLOT_SCHEMA_INVALID", stage); slots[name] = value; }
    if (BigInt(slots.implementation) !== 0n && BigInt(slots.beacon) !== 0n) this.stop("PROXY_AMBIGUOUS", stage);
    return digest({ codeHash: keccak256(code), slots });
  }
  async canaries(endpoints, context, stage) {
    for (const endpoint of endpoints) { const observed = new Map(); for (const row of context.matrix.stateCanaries) {
      let actual; if (row.method === "eth_getBalance") actual = lower(await this.rpc(endpoint, stage, row.method, [row.account, hex(row.blockNumber)]));
      else if (row.method === "eth_getCode") actual = lower(await this.rpc(endpoint, stage, row.method, [row.contract, hex(row.blockNumber)]));
      else if (row.method === "eth_getStorageAt") actual = lower(await this.rpc(endpoint, stage, row.method, [row.contract, row.storageKey, hex(row.blockNumber)]));
      else if (row.method === "eth_call") actual = lower(await this.rpc(endpoint, stage, row.method, [{ to: row.contract, data: `0x70a08231000000000000000000000000${row.holder.slice(2)}` }, hex(row.blockNumber)]));
      else this.stop("CANARY_METHOD_INVALID", stage);
      let pass = row.method === "eth_getBalance" ? quantity(actual) && actual === row.expectedQuantity : row.method === "eth_getCode" ? bytes(actual) && (Object.hasOwn(row, "expectedData") ? actual === row.expectedData : row.expectedPredicate === "non-empty" && actual !== "0x") : word(actual) && actual === row.expectedWord;
      if (row.method === "eth_call" && row.mustMatchStorage === true) pass &&= observed.get(row.storageReferenceId) === actual;
      if (!pass) this.stop("HISTORICAL_CANARY_MISMATCH", stage); observed.set(row.id, actual);
    } }
  }
  async route(endpoint, context, route, pin, stage) {
    const checks = {}; checks.appRuntime = await this.runtime(endpoint, route.app, pin, stage);
    const endpointCall = await this.strictCall(endpoint, stage, route.app, OAPP_IFACE, "endpoint", [], pin); const peerCall = await this.strictCall(endpoint, stage, route.app, OAPP_IFACE, "peers", [route.eid], pin);
    if (address(endpointCall[0]) !== context.endpoint || BigInt(peerCall[0]) === 0n) this.stop("APP_ENDPOINT_PEER_MISMATCH", stage); checks.binding = digest({ endpoint: address(endpointCall[0]), peer: lower(peerCall[0]) });
    let library; if (route.direction === "receive") { const selected = await this.strictCall(endpoint, stage, context.endpoint, ENDPOINT_IFACE, "getReceiveLibrary", [route.app, route.eid], pin); library = address(selected[0]); checks.selection = digest({ library, isDefault: Boolean(selected[1]) }); }
    else { const selected = await this.strictCall(endpoint, stage, context.endpoint, ENDPOINT_IFACE, "getSendLibrary", [route.app, route.eid], pin); const def = await this.strictCall(endpoint, stage, context.endpoint, ENDPOINT_IFACE, "isDefaultSendLibrary", [route.app, route.eid], pin); library = address(selected[0]); checks.selection = digest({ library, isDefault: Boolean(def[0]) }); }
    if (!library) this.stop("LIBRARY_SELECTION_INVALID", stage); checks.libraryRuntime = await this.runtime(endpoint, library, pin, stage);
    const typeCall = await this.strictCall(endpoint, stage, library, LIB_IFACE, "messageLibType", [], pin); const versionCall = await this.strictCall(endpoint, stage, library, LIB_IFACE, "version", [], pin); const supported = await this.strictCall(endpoint, stage, library, LIB_IFACE, "isSupportedEid", [route.eid], pin); const registered = await this.strictCall(endpoint, stage, context.endpoint, ENDPOINT_IFACE, "isRegisteredLibrary", [library], pin);
    const type = Number(typeCall[0]); if (!(route.direction === "receive" ? [1, 2].includes(type) : [0, 2].includes(type)) || !supported[0] || !registered[0]) this.stop("LIBRARY_SEMANTICS_INVALID", stage); checks.library = digest({ type, version: [...versionCall].map(String), supported: Boolean(supported[0]), registered: Boolean(registered[0]) });
    const configs = []; for (const configType of route.configTypes) { const data = ENDPOINT_IFACE.encodeFunctionData("getConfig", [route.app, library, route.eid, configType]); const envelope = await this.rpc(endpoint, stage, "eth_call", [{ to: context.endpoint, data }, hex(pin)], { envelope: true, allowError: true }); if (envelope.error) { const payloads = []; const collect = (value, depth = 0) => { if (depth > 8 || value == null) return; if (typeof value === "string" && bytes(lower(value)) && value !== "0x") payloads.push(lower(value)); else if (Array.isArray(value)) for (const item of value) collect(item, depth + 1); else if (typeof value === "object") for (const item of Object.values(value)) collect(item, depth + 1); }; collect(envelope.error); if (route.direction !== "receive" || configType !== 1 || payloads.filter((value) => value.startsWith(ERROR_SELECTOR)).length !== 1) this.stop("RECEIVE_TYPE1_WRONG_SELECTOR", stage); configs.push(digest({ configType, expectedErrorSelector: ERROR_SELECTOR })); } else { const decoded = decodeStrict(ENDPOINT_IFACE, "getConfig", envelope.result); configs.push(decodeConfig(decoded[0], configType)); } }
    if (route.direction === "receive") {
      const data = ENDPOINT_IFACE.encodeFunctionData("getConfig", [route.app, library, route.eid, 1]);
      const envelope = await this.rpc(endpoint, stage, "eth_call", [{ to: context.endpoint, data }, hex(pin)], { envelope: true, allowError: true });
      const payloads = []; const collect = (value, depth = 0) => { if (depth > 8 || value == null) return; if (typeof value === "string" && bytes(lower(value)) && value !== "0x") payloads.push(lower(value)); else if (Array.isArray(value)) for (const item of value) collect(item, depth + 1); else if (typeof value === "object") for (const item of Object.values(value)) collect(item, depth + 1); };
      if (!envelope.error) this.stop("RECEIVE_TYPE1_EXPECTED_ERROR_MISSING", stage); collect(envelope.error);
      if (payloads.filter((value) => value.startsWith(ERROR_SELECTOR)).length !== 1) this.stop("RECEIVE_TYPE1_WRONG_SELECTOR", stage);
      configs.push(digest({ configType: 1, expectedErrorSelector: ERROR_SELECTOR }));
    }
    checks.configs = configs;
    const tokenCall = await this.strictCall(endpoint, stage, route.app, ADAPTER_IFACE, "token", [], pin); const token = address(tokenCall[0]); if (!token) this.stop("TOKEN_RESOLUTION_INVALID", stage);
    const receiverCode = strictData(await this.rpc(endpoint, stage, "eth_getCode", [context.receiver, hex(pin)])); const appCode = strictData(await this.rpc(endpoint, stage, "eth_getCode", [route.app, hex(pin)])); const tokenCode = strictData(await this.rpc(endpoint, stage, "eth_getCode", [token, hex(pin)])); if ([receiverCode, appCode, tokenCode].includes("0x")) this.stop("INTEGRATION_CODE_ABSENT", stage);
    const native = lower(await this.rpc(endpoint, stage, "eth_getBalance", [context.receiver, hex(pin)])); if (!quantity(native)) this.stop("INTEGRATION_BALANCE_SCHEMA", stage);
    const receiverBalance = await this.strictCall(endpoint, stage, token, ERC20_IFACE, "balanceOf", [context.receiver], pin); const appBalance = await this.strictCall(endpoint, stage, token, ERC20_IFACE, "balanceOf", [route.app], pin); const allowance = await this.strictCall(endpoint, stage, token, ERC20_IFACE, "allowance", [context.receiver, route.app], pin);
    checks.integration = digest({ receiverCode: keccak256(receiverCode), appCode: keccak256(appCode), tokenCode: keccak256(tokenCode), native: BigInt(native).toString(), receiverBalance: receiverBalance[0].toString(), appBalance: appBalance[0].toString(), allowance: allowance[0].toString() });
    return { label: route.label, routeIdentityDigest: route.routeIdentityDigest, token, commitment: digest(checks) };
  }
  async runInternal() {
    verifyPackage({ ...this.options, clock: this.clock, mode: this.mode });
    const context = r5.loadContext(this.options.workspaceRoot); const texts = this.inventoryProvider.read(); const endpoints = r5.resolveEndpoints(r5.parseInventoryTexts(texts), context.r14, this.mode);
    this.startedAt = this.clock.now(); for (const endpoint of endpoints) this.perEndpoint[endpoint.endpointId] = 0;
    const finalized = [];
    for (const endpoint of endpoints) { const stage = STAGES[0].id; const chain = lower(await this.rpc(endpoint, stage, "eth_chainId", [])); if (!quantity(chain) || BigInt(chain) !== 999n) this.stop("CHAIN_ID_MISMATCH", stage); const block1 = await this.rpc(endpoint, stage, "eth_getBlockByNumber", ["0x1", false]); if (!block1 || lower(block1.hash) !== context.selectedHeaderHash || lower(block1.number) !== "0x1") this.stop("SELECTED_HEADER_MISMATCH", stage); const final = await this.rpc(endpoint, stage, "eth_getBlockByNumber", ["finalized", false]); if (!final || !word(lower(final.hash)) || !quantity(lower(final.number))) this.stop("FINALIZED_SCHEMA_INVALID", stage); finalized.push({ endpoint, number: safeNumber(final.number) }); }
    this.completeStage(STAGES[0].id); await this.canaries(endpoints, context, STAGES[1].id); this.completeStage(STAGES[1].id);
    const pinNumber = Math.min(...finalized.map((row) => row.number)); const pinHeaders = [];
    for (const row of finalized) { const block = await this.rpc(row.endpoint, STAGES[2].id, "eth_getBlockByNumber", [hex(pinNumber), false]); if (!block || safeNumber(block.number) !== pinNumber || !word(lower(block.hash))) this.stop("PIN_HEADER_INVALID", STAGES[2].id); pinHeaders.push(lower(block.hash)); }
    if (new Set(pinHeaders).size !== 1) this.stop("PIN_HASH_MISMATCH", STAGES[2].id); const pinHash = pinHeaders[0]; this.pinAt = this.clock.now(); if (this.pinAt - this.startedAt > POLICY.pinDeadlineMs) this.stop("FRESH_PIN_DEADLINE_EXCEEDED", STAGES[2].id); this.completeStage(STAGES[2].id);
    const endpointState = new Map(); for (const endpoint of endpoints) { const routes = []; for (const route of context.routes) routes.push(await this.route(endpoint, context, route, pinNumber, STAGES[3].id)); endpointState.set(endpoint.endpointId, { routes }); } this.completeStage(STAGES[3].id);
    for (const endpoint of endpoints) { const state = endpointState.get(endpoint.endpointId); const roles = new Map(); const add = (target, role) => { const set = roles.get(target) || new Set(); set.add(role); roles.set(target, set); }; add(context.endpoint, "layerzero-endpoint"); add(context.receiver, "destination-receiver"); for (const route of context.routes) add(route.app, `route-app:${route.label}`); for (const route of state.routes) add(route.token, `route-token:${route.label}`); if (roles.size !== 6) this.stop("ANCHOR_TARGET_COUNT_NOT_SIX", STAGES[4].id); const roleMap = new Map([...roles.entries()].map(([target, set]) => [target, [...set].sort()])); const rawLogs = []; const fromBlock = Math.max(0, pinNumber - 49); for (const target of [...roleMap.keys()].sort()) { const rows = await this.rpc(endpoint, STAGES[4].id, "eth_getLogs", [{ address: target, fromBlock: hex(fromBlock), toBlock: hex(pinNumber) }]); if (!Array.isArray(rows)) this.stop("LOG_RESPONSE_SCHEMA", STAGES[4].id); rawLogs.push(...rows); } if (rawLogs.length > POLICY.logsPerEndpoint) this.stop("LOG_CAP_EXHAUSTED", STAGES[4].id); const dedupe = new Map(); for (const row of rawLogs.map((item) => normalizeLog(item, roleMap, fromBlock, pinNumber))) { const key = canonicalJson([row.blockNumberDecimal, row.transactionIndexDecimal, row.logIndexDecimal, row.address, row.transactionHash]); const prior = dedupe.get(key); if (prior && canonicalJson(prior) !== canonicalJson(row)) this.stop("ANCHOR_DUPLICATE_CONFLICT", STAGES[4].id); dedupe.set(key, row); } state.logs = [...dedupe.values()]; state.roleMapCommitment = digest([...roleMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))); const txCount = new Set(state.logs.map((row) => row.transactionHash)).size; if (txCount > POLICY.maxNamespaceTransactionsPerEndpoint) this.stop("NAMESPACE_CARDINALITY_ABOVE_MAX", STAGES[4].id); }
    this.completeStage(STAGES[4].id);
    let totalTransactions = 0; const systemCandidates = [];
    for (const endpoint of endpoints) { const state = endpointState.get(endpoint.endpointId); const byTx = new Map(); for (const log of state.logs) { const rows = byTx.get(log.transactionHash) || []; rows.push(log); byTx.set(log.transactionHash, rows); } state.txClasses = new Map(); totalTransactions += byTx.size; for (const [txHash, logs] of byTx) { const first = await this.rpc(endpoint, STAGES[5].id, "eth_getTransactionByHash", [txHash], { noRetry: true, meta: true }); const needed = POLICY.namespaceDispatchSeparationMs - (this.clock.now() - first.dispatchAt); if (needed > 0) await this.clock.sleep(needed); this.deadline(STAGES[5].id); const second = await this.rpc(endpoint, STAGES[5].id, "eth_getTransactionByHash", [txHash], { noRetry: true, meta: true }); if (second.dispatchAt - first.dispatchAt < POLICY.namespaceDispatchSeparationMs) this.stop("NAMESPACE_DISPATCH_SEPARATION_VIOLATION", STAGES[5].id); if (first.value === null && second.value === null) systemCandidates.push({ endpoint, state, txHash, logs }); else if (logs.every((log) => matchTransaction(first.value, log) && matchTransaction(second.value, log))) state.txClasses.set(txHash, "ordinary-transaction"); else this.stop("NAMESPACE_LOOKUP_MISMATCH", STAGES[5].id); } }
    this.completeStage(STAGES[5].id, totalTransactions * 2);
    for (const candidate of systemCandidates) { const { endpoint, state, txHash, logs } = candidate; const receipts = await this.rpc(endpoint, STAGES[6].id, "eth_getBlockReceipts", [logs[0].blockNumber]); if (!Array.isArray(receipts)) this.stop("POSITIVE_RECEIPT_UNAVAILABLE", STAGES[6].id); const identities = receipts.filter((receipt) => receipt && lower(receipt.transactionHash) === txHash && lower(receipt.blockHash) === logs[0].blockHash && quantity(lower(receipt.blockNumber)) && BigInt(receipt.blockNumber) === BigInt(logs[0].blockNumber) && quantity(lower(receipt.transactionIndex)) && BigInt(receipt.transactionIndex) === BigInt(logs[0].transactionIndex)); if (identities.length !== 1) this.stop("POSITIVE_RECEIPT_UNAVAILABLE", STAGES[6].id); if (!receiptMatches(identities[0], txHash, logs)) this.stop("RECEIPT_LOG_MISMATCH", STAGES[6].id); state.txClasses.set(txHash, "system-transaction"); }
    this.completeStage(STAGES[6].id, systemCandidates.length);
    for (const endpoint of endpoints) {
      const state = endpointState.get(endpoint.endpointId);
      for (const log of state.logs) log.transactionNamespace = state.txClasses.get(log.transactionHash);
      const exact = state.logs.map((log) => ({ blockNumber: log.blockNumberDecimal, blockHash: log.blockHash, transactionHash: log.transactionHash, transactionIndex: log.transactionIndexDecimal, logIndex: log.logIndexDecimal, address: log.address, roleSet: log.roleSet, topics: log.topics, data: log.data, transactionNamespace: log.transactionNamespace })).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
      const semanticMap = new Map();
      for (const log of state.logs) {
        const row = { blockNumber: log.blockNumberDecimal, roleSet: log.roleSet, eventSignature: log.topics[0] || null, indexedTopics: log.topics.slice(1), dataDigest: sha(Buffer.from(log.data.slice(2), "hex")), transactionNamespace: log.transactionNamespace };
        const key = canonicalJson(row); const current = semanticMap.get(key) || { ...row, occurrenceCount: 0 }; current.occurrenceCount++; semanticMap.set(key, current);
      }
      state.exactAnchorCommitment = digest(exact);
      state.semanticAnchorCommitment = digest([...semanticMap.values()].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))));
      const counts = [...state.txClasses.values()].reduce((out, value) => ({ ...out, [value]: (out[value] || 0) + 1 }), {});
      state.namespaceCommitment = digest(counts);
      state.routeCommitment = digest(state.routes.map((row) => ({ label: row.label, routeIdentityDigest: row.routeIdentityDigest, commitment: row.commitment })).sort((a, b) => a.label.localeCompare(b.label)));
    }
    for (const endpoint of endpoints) { const final = await this.rpc(endpoint, STAGES[7].id, "eth_getBlockByNumber", ["finalized", false]); if (!final || safeNumber(final.number) < pinNumber) this.stop("FINALIZED_AFTER_BELOW_PIN", STAGES[7].id); } this.completeStage(STAGES[7].id);
    await this.canaries(endpoints, context, STAGES[8].id); this.completeStage(STAGES[8].id);
    for (const endpoint of endpoints) { const terminal = await this.rpc(endpoint, STAGES[9].id, "eth_getBlockByNumber", [hex(pinNumber), false]); if (!terminal || lower(terminal.hash) !== pinHash || safeNumber(terminal.number) !== pinNumber) this.stop("TERMINAL_PIN_HASH_MISMATCH", STAGES[9].id); } this.completeStage(STAGES[9].id);
    const states = endpoints.map((endpoint) => endpointState.get(endpoint.endpointId)); if (new Set(states.map((row) => row.semanticAnchorCommitment)).size !== 1) this.stop("SEMANTIC_ANCHOR_MISMATCH", "aggregation"); if (new Set(states.map((row) => row.exactAnchorCommitment)).size !== 1) this.stop("EXACT_ANCHOR_MISMATCH", "aggregation"); if (new Set(states.map((row) => row.namespaceCommitment)).size !== 1) this.stop("NAMESPACE_PROFILE_MISMATCH", "aggregation"); if (new Set(states.map((row) => row.routeCommitment)).size !== 1) this.stop("FAMILY_TUPLE_DISAGREEMENT", "aggregation");
    const expected = POLICY.successfulPathMin + totalTransactions * 2 + systemCandidates.length; if (this.attempts !== expected + this.retries || this.stageIndex !== STAGES.length || expected < POLICY.successfulPathMin || expected > POLICY.successfulPathMax) this.stop("LEDGER_NOT_EXACTLY_COMPLETE", "aggregation"); this.deadline("complete");
    return canonical({ status: "PASS/SELECTED-THREE-SINGLETON-FAMILIES-ONLY", pin: { blockNumber: pinNumber, blockHash: pinHash }, attempts: this.attempts, expectedDispatchesWithoutRetries: expected, retries: this.retries, perEndpointAttempts: this.perEndpoint, stageDebits: this.stageDebits, executionOrder: this.executionOrder, familyCount: 3, transactionCountPerEndpoint: states.map((row) => new Set(row.logs.map((log) => log.transactionHash)).size), systemCandidateCount: systemCandidates.length, receiptRequests: this.stageDebits[STAGES[6].id], exactAnchorCommitment: states[0].exactAnchorCommitment, semanticAnchorCommitment: states[0].semanticAnchorCommitment, namespaceCommitment: states[0].namespaceCommitment, routeCommitment: states[0].routeCommitment, logCountPerEndpoint: states.map((row) => row.logs.length), endpointMaterialPersisted: false, rawResponsesPersisted: false, economics: false });
  }
  async run() { let inventoryRead = false; try { const originalRead = this.inventoryProvider.read.bind(this.inventoryProvider); this.inventoryProvider.read = () => { inventoryRead = true; return originalRead(); }; return await this.runInternal(); } catch (error) { const stop = error instanceof SemanticStop ? error : error instanceof r5.SemanticStop ? new SemanticStop(error.code, error.stage) : new SemanticStop("UNEXPECTED_RUNNER_FAILURE", "internal"); return canonical({ status: `INCONCLUSIVE/${stop.code}`, failureStage: stop.stage, attempts: this.attempts, retries: this.retries, perEndpointAttempts: this.perEndpoint, stageDebits: this.stageDebits, executionOrder: this.executionOrder, inventoryRead, endpointMaterialPersisted: false, rawResponsesPersisted: false, economics: false }); } }
}

module.exports = { POLICY, STAGES, READ_ONLY, SELECTED_FAMILIES, ERROR_SELECTOR, ENDPOINT_IFACE, LIB_IFACE, OAPP_IFACE, ADAPTER_IFACE, ERC20_IFACE, EIP1967, ABI, SemanticStop, RpcFailure, RealClock, MockClock, SemanticRetryRunner, assertReadOnlyMethod, verifyPackage, matchTransaction, receiptMatches, canonicalJson, digest, hex, syntheticInventoryText: r5.syntheticInventoryText, loadContext: r5.loadContext };
if (require.main === module) process.stdout.write(JSON.stringify({ status: "REVIEW_ONLY_CORRECTED_SEMANTIC_RUNNER_READY", networkInvoked: false, inventoryRead: false, endpointCalls: 0, approvedDecisionRequired: true }) + "\n");
