#!/usr/bin/env node
"use strict";

// Network-capable bounded scheduler for the review-only r4 retry proposal.
// This module contains no endpoint discovery or URL handling. A future approved
// caller must inject exactly three anonymous endpoint transport handles. The r4
// package exercises this source only with the exported mock transport.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const R3_RUN_ID = "etherfi-behype-hyperevm-behavioral-retry-proposal-r3-5d90da55c5c566df19aae0b8d6652a835ff7fa097477417ef378f5178ba5eba9-8ad5a1e928d5f7ef97124aaec50b7605a4a6f62761f0c814847abc217266334f";
const R3_MANIFEST_AGGREGATE = "7a510ef7b21af9b345d2daecfce76da0f5eb9469b4352747a294551adf6e92dc";
const SELECTED_ENDPOINTS = [
  { familyId: "hyperevm-family-25", endpointId: "hyperevm-family-25-endpoint-01" },
  { familyId: "hyperevm-family-37", endpointId: "hyperevm-family-37-endpoint-01" },
  { familyId: "hyperevm-family-90", endpointId: "hyperevm-family-90-endpoint-01" },
];
const STAGES = [
  { id: "identity-finalized-before-pin", order: 1, perEndpoint: 4, total: 12, methods: ["eth_chainId", "eth_getBlockByNumber"] },
  { id: "initial-canaries", order: 2, perEndpoint: 8, total: 24, methods: ["eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_call"] },
  { id: "two-routes-and-integration", order: 3, perEndpoint: 51, total: 153, methods: ["eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_call"] },
  { id: "anchor-log-queries", order: 4, perEndpoint: 6, total: 18, methods: ["eth_getLogs"] },
  { id: "namespace-lookups", order: 5, perEndpoint: 32, total: 96, methods: ["eth_getTransactionByHash"] },
  { id: "positive-block-receipt-evidence", order: 6, perEndpoint: 16, total: 48, methods: ["eth_getBlockReceipts"] },
  { id: "finalized-after-and-terminal", order: 7, perEndpoint: 2, total: 6, methods: ["eth_getBlockByNumber"] },
  { id: "mandatory-elapsed-canary-rerun", order: 8, perEndpoint: 8, total: 24, methods: ["eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_call"] },
];
const READ_ONLY_METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_call", "eth_getLogs", "eth_getTransactionByHash", "eth_getBlockReceipts"]);
const POLICY = Object.freeze({ maxAttemptsTotal: 420, maxAttemptsPerEndpoint: 140, successfulPathAttempts: 381, retryReserve: 10, requiredMaximum: 391, serviceTimeoutMs: 2000, concurrency: 1, interAttemptGapMs: 1000, rateLimitWaitMs: 30000, otherRetryWaitMs: 5000, maxRetriesTotal: 10, maxRetriesPerRequest: 1, captureDeadlineMs: 2700000, pinDeadlineMs: 600000, approvalStartDeadlineMs: 900000, namespaceUniquePerEndpoint: 16, namespaceSeparationMs: 2000, logsPerEndpoint: 500, mandatoryCanaryRerunAttempts: 24 });

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hashFile = (file) => { const body = fs.readFileSync(file); return { bytes: body.length, sha256: sha(body) }; };
const clone = (value) => JSON.parse(JSON.stringify(value));
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const canonicalJson = (value) => JSON.stringify(canonical(value));

class RunnerStop extends Error { constructor(code, stage = "preflight") { super(code); this.code = code; this.stage = stage; } }
class TransportFailure extends Error { constructor(category) { super(category); this.category = category; } }

class RealClock {
  now() { return Date.now(); }
  sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  schedule(ms, fn) { return setTimeout(fn, ms); }
  cancel(token) { clearTimeout(token); }
}

class MockClock {
  constructor(now = 0) { this.time = now; this.nextTimer = 1; this.timers = new Map(); this.sleepInflationQueue = []; }
  now() { return this.time; }
  schedule(ms, fn) { const id = this.nextTimer++; this.timers.set(id, { at: this.time + ms, fn }); return id; }
  cancel(id) { this.timers.delete(id); }
  advance(ms) { this.time += ms; const due = [...this.timers.entries()].filter(([, row]) => row.at <= this.time).sort((a, b) => a[1].at - b[1].at); for (const [id, row] of due) { this.timers.delete(id); row.fn(); } }
  async sleep(ms) { const inflation = this.sleepInflationQueue.length ? this.sleepInflationQueue.shift() : 0; this.advance(ms + inflation); }
  inflateNextSleep(ms) { this.sleepInflationQueue.push(ms); }
}

class MockTransport {
  constructor(clock, behavior = {}) { this.clock = clock; this.behavior = behavior; this.dispatches = []; this.active = 0; this.maxActive = 0; this.attemptsByOperation = new Map(); }
  async dispatch(operation, context) {
    this.active++; this.maxActive = Math.max(this.maxActive, this.active); const count = (this.attemptsByOperation.get(operation.id) || 0) + 1; this.attemptsByOperation.set(operation.id, count); const rule = typeof this.behavior === "function" ? this.behavior(operation, count) : this.behavior[operation.id]?.[count - 1]; const selected = rule || { kind: "success", delayMs: 0 }; this.dispatches.push({ operationId: operation.id, stage: operation.stage, endpointId: operation.endpointId, method: operation.method, retry: context.retry, timestamp: this.clock.now() });
    try { this.clock.advance(selected.delayMs || 0); if (context.signal.aborted) throw new TransportFailure("timeout"); if (selected.kind === "rate-limit") throw new TransportFailure("rate-limited"); if (selected.kind === "timeout") { this.clock.advance(POLICY.serviceTimeoutMs + 1); if (context.signal.aborted) throw new TransportFailure("timeout"); throw new TransportFailure("timeout"); } if (selected.kind === "http-5xx") throw new TransportFailure("http-5xx"); if (selected.kind === "failure") throw new TransportFailure(selected.category || "transport-failure"); return selected.envelope || mockEnvelopeFor(operation.method); }
    finally { this.active--; }
  }
}

function mockEnvelopeFor(method) {
  if (method === "eth_chainId" || method === "eth_getBalance") return { jsonrpc: "2.0", id: 1, result: "0x1" };
  if (["eth_getCode", "eth_getStorageAt", "eth_call"].includes(method)) return { jsonrpc: "2.0", id: 1, result: "0x00" };
  if (method === "eth_getBlockByNumber") return { jsonrpc: "2.0", id: 1, result: { number: "0x1", hash: `0x${"11".repeat(32)}`, timestamp: "0x1" } };
  if (method === "eth_getLogs" || method === "eth_getBlockReceipts") return { jsonrpc: "2.0", id: 1, result: [] };
  if (method === "eth_getTransactionByHash") return { jsonrpc: "2.0", id: 1, result: null };
  return { jsonrpc: "2.0", id: 1, result: null };
}

function aggregateRecords(records) { return sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))); }

function validatePackageBinding(options) {
  const { workspaceRoot, manifestRelativePath, approvedDecision, clock, mode } = options; if (!approvedDecision || typeof approvedDecision.decisionTimestamp !== "string") throw new RunnerStop("APPROVED_DECISION_TIMESTAMP_REQUIRED"); const decisionAt = Date.parse(approvedDecision.decisionTimestamp); if (!Number.isFinite(decisionAt)) throw new RunnerStop("APPROVED_DECISION_TIMESTAMP_INVALID"); const age = clock.now() - decisionAt; if (age < 0 || age > POLICY.approvalStartDeadlineMs) throw new RunnerStop("APPROVAL_START_DEADLINE_EXCEEDED"); if (mode === "network" && approvedDecision.decision !== "APPROVED") throw new RunnerStop("NETWORK_DECISION_NOT_APPROVED"); if (mode === "mock" && approvedDecision.decision !== "APPROVED_FOR_MOCK_FIXTURE_ONLY") throw new RunnerStop("MOCK_DECISION_NOT_APPROVED");
  const manifestPath = path.join(workspaceRoot, manifestRelativePath); if (!fs.existsSync(manifestPath)) throw new RunnerStop("PACKAGE_MANIFEST_MISSING"); let manifest; try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { throw new RunnerStop("PACKAGE_MANIFEST_INVALID"); } if (manifest.runId !== approvedDecision.proposalRunId || manifest.aggregateSha256 !== approvedDecision.packageManifestAggregateSha256) throw new RunnerStop("PACKAGE_APPROVAL_BINDING_MISMATCH"); if (manifest.proposalStatus !== "REVIEW_REQUESTED/NOT_AUTHORIZED/NOT_EXECUTED") throw new RunnerStop("PACKAGE_STATUS_INVALID"); if (manifest.predecessorBinding?.runId !== R3_RUN_ID || manifest.predecessorBinding?.manifestAggregateSha256 !== R3_MANIFEST_AGGREGATE) throw new RunnerStop("R3_BINDING_MISMATCH"); if (!Array.isArray(manifest.records)) throw new RunnerStop("PACKAGE_RECORDS_INVALID");
  const actual = manifest.records.map((row) => { const file = path.join(workspaceRoot, row.path); if (!fs.existsSync(file)) throw new RunnerStop("PACKAGE_RECORD_MISSING"); const current = { path: row.path, ...hashFile(file) }; if (current.bytes !== row.bytes || current.sha256 !== row.sha256) throw new RunnerStop("PACKAGE_RECORD_HASH_MISMATCH"); return current; }); if (aggregateRecords(actual) !== manifest.aggregateSha256) throw new RunnerStop("PACKAGE_AGGREGATE_MISMATCH"); const runnerRelative = path.relative(workspaceRoot, __filename).replace(/\\/g, "/"); const runnerRecord = actual.find((row) => row.path === runnerRelative); if (!runnerRecord || runnerRecord.sha256 !== hashFile(__filename).sha256) throw new RunnerStop("RUNNER_HASH_MISMATCH"); return manifest;
}

function validateEndpoints(endpoints) {
  if (!Array.isArray(endpoints) || endpoints.length !== 3) throw new RunnerStop("EXACT_THREE_ENDPOINTS_REQUIRED"); const expected = SELECTED_ENDPOINTS.map((row) => `${row.familyId}\0${row.endpointId}`); const actual = endpoints.map((row) => `${row.familyId}\0${row.endpointId}`); if (canonicalJson(actual) !== canonicalJson(expected)) throw new RunnerStop("ENDPOINT_SUBSTITUTION_OR_ORDER_CHANGE"); for (const endpoint of endpoints) { if (typeof endpoint.dispatch !== "function") throw new RunnerStop("ENDPOINT_TRANSPORT_MISSING"); for (const forbidden of ["url", "uri", "domain", "host", "headers", "authorization", "key", "token"]) if (Object.hasOwn(endpoint, forbidden)) throw new RunnerStop("ENDPOINT_SECRET_FIELD_FORBIDDEN"); }
}

function validateCaps(stageLedger, policy = POLICY) {
  const subtotal = STAGES.reduce((value, row) => value + row.total, 0); const perEndpoint = STAGES.reduce((value, row) => value + row.perEndpoint, 0); if (subtotal !== 381 || perEndpoint !== 127 || policy.successfulPathAttempts !== subtotal || policy.retryReserve !== 10 || policy.requiredMaximum !== subtotal + policy.retryReserve) throw new RunnerStop("LEDGER_DERIVATION_INVALID"); if (policy.maxAttemptsTotal < policy.requiredMaximum) throw new RunnerStop("GLOBAL_ATTEMPT_CAP_INSUFFICIENT"); if (policy.maxAttemptsPerEndpoint < perEndpoint + policy.retryReserve) throw new RunnerStop("PER_ENDPOINT_ATTEMPT_CAP_INSUFFICIENT"); if (!stageLedger || stageLedger.successfulPathStageSubtotal !== 381 || stageLedger.requiredAttemptMaximum !== 391 || stageLedger.perEndpointSuccessfulPathMax !== 127 || stageLedger.perEndpointMaximumWithAllRetriesConcentrated !== 137) throw new RunnerStop("PACKAGE_STAGE_LEDGER_MISMATCH");
}

function validateMethod(operation, stage) {
  if (!READ_ONLY_METHODS.has(operation.method)) throw new RunnerStop("RPC_METHOD_NOT_ALLOWLISTED", operation.stage); if (!stage.methods.includes(operation.method)) throw new RunnerStop("RPC_METHOD_NOT_ALLOWED_FOR_STAGE", operation.stage); if (/send|sign|personal|wallet|mine|submit|broadcast/i.test(operation.method)) throw new RunnerStop("STATE_CHANGING_METHOD_FORBIDDEN", operation.stage);
}

function validatePlan(plan) {
  if (!Array.isArray(plan) || plan.length !== 381) throw new RunnerStop("PLAN_SUCCESSFUL_PATH_COUNT_MISMATCH"); let cursor = 0; const endpointKeys = SELECTED_ENDPOINTS.map((row) => row.endpointId); for (const stage of STAGES) { const rows = plan.slice(cursor, cursor + stage.total); if (rows.length !== stage.total || rows.some((row) => row.stage !== stage.id)) throw new RunnerStop("STAGE_OMITTED_OR_ORDER_ALTERED", stage.id); const counts = Object.fromEntries(endpointKeys.map((key) => [key, 0])); for (const row of rows) { if (!row || typeof row.id !== "string" || !row.id || !endpointKeys.includes(row.endpointId)) throw new RunnerStop("PLAN_ENDPOINT_OR_ID_INVALID", stage.id); counts[row.endpointId]++; validateMethod(row, stage); } if (Object.values(counts).some((value) => value !== stage.perEndpoint)) throw new RunnerStop("STAGE_PER_ENDPOINT_COUNT_ALTERED", stage.id); cursor += stage.total; }
  if (new Set(plan.map((row) => row.id)).size !== plan.length) throw new RunnerStop("PLAN_OPERATION_ID_DUPLICATE"); const namespace = plan.filter((row) => row.stage === "namespace-lookups"); for (const endpointId of endpointKeys) { const rows = namespace.filter((row) => row.endpointId === endpointId); const keys = new Map(); for (const row of rows) { if (typeof row.namespaceKey !== "string" || !row.namespaceKey || ![1, 2].includes(row.lookupOrdinal)) throw new RunnerStop("NAMESPACE_METADATA_INVALID", row.stage); const ordinals = keys.get(row.namespaceKey) || []; ordinals.push(row.lookupOrdinal); keys.set(row.namespaceKey, ordinals); } if (keys.size !== POLICY.namespaceUniquePerEndpoint || [...keys.values()].some((values) => canonicalJson(values.sort()) !== "[1,2]")) throw new RunnerStop("NAMESPACE_COUNT_OR_PAIR_INVALID", "namespace-lookups"); }
  const logs = plan.filter((row) => row.stage === "anchor-log-queries"); if (logs.some((row) => row.maxLogs !== POLICY.logsPerEndpoint)) throw new RunnerStop("LOG_CAP_METADATA_INVALID", "anchor-log-queries"); const rerun = plan.filter((row) => row.stage === "mandatory-elapsed-canary-rerun"); if (rerun.length !== POLICY.mandatoryCanaryRerunAttempts) throw new RunnerStop("MANDATORY_CANARY_RERUN_OMITTED"); return true;
}

function validateEnvelope(method, envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new TransportFailure("response-schema-invalid"); if (envelope.error) { const code = Number(envelope.error.code); if (code === 429 || code === -32005) throw new TransportFailure("rate-limited"); throw new TransportFailure("rpc-error"); } if (!Object.hasOwn(envelope, "result")) throw new TransportFailure("response-schema-invalid"); const result = envelope.result; if (["eth_chainId", "eth_getBalance"].includes(method) && !(typeof result === "string" && /^0x[0-9a-f]+$/i.test(result))) throw new TransportFailure("response-schema-invalid"); if (["eth_getCode", "eth_getStorageAt", "eth_call"].includes(method) && !(typeof result === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(result))) throw new TransportFailure("response-schema-invalid"); if (method === "eth_getBlockByNumber" && !(result && typeof result === "object" && typeof result.hash === "string")) throw new TransportFailure("response-schema-invalid"); if (["eth_getLogs", "eth_getBlockReceipts"].includes(method) && !Array.isArray(result)) throw new TransportFailure("response-schema-invalid"); if (method === "eth_getTransactionByHash" && !(result === null || typeof result === "object")) throw new TransportFailure("response-schema-invalid"); return true;
}

function buildFixturePlan() {
  const plan = []; let serial = 0; const add = (stage, endpoint, method, extra = {}) => plan.push({ id: `op-${String(++serial).padStart(3, "0")}`, stage: stage.id, endpointId: endpoint.endpointId, method, params: [], ...extra });
  for (const stage of STAGES) for (const endpoint of SELECTED_ENDPOINTS) {
    if (stage.id === "identity-finalized-before-pin") { add(stage, endpoint, "eth_chainId"); add(stage, endpoint, "eth_getBlockByNumber"); add(stage, endpoint, "eth_getBlockByNumber"); add(stage, endpoint, "eth_getBlockByNumber"); }
    else if (["initial-canaries", "mandatory-elapsed-canary-rerun"].includes(stage.id)) for (let i = 0; i < 8; i++) add(stage, endpoint, ["eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_call"][i % 4]);
    else if (stage.id === "two-routes-and-integration") for (let i = 0; i < 51; i++) add(stage, endpoint, ["eth_call", "eth_getCode", "eth_getStorageAt", "eth_getBalance"][i % 4]);
    else if (stage.id === "anchor-log-queries") for (let i = 0; i < 6; i++) add(stage, endpoint, "eth_getLogs", { maxLogs: 500 });
    else if (stage.id === "namespace-lookups") for (let i = 0; i < 16; i++) { add(stage, endpoint, "eth_getTransactionByHash", { namespaceKey: `${endpoint.familyId}-tx-${String(i + 1).padStart(2, "0")}`, lookupOrdinal: 1 }); add(stage, endpoint, "eth_getTransactionByHash", { namespaceKey: `${endpoint.familyId}-tx-${String(i + 1).padStart(2, "0")}`, lookupOrdinal: 2 }); }
    else if (stage.id === "positive-block-receipt-evidence") for (let i = 0; i < 16; i++) add(stage, endpoint, "eth_getBlockReceipts");
    else if (stage.id === "finalized-after-and-terminal") { add(stage, endpoint, "eth_getBlockByNumber"); add(stage, endpoint, "eth_getBlockByNumber"); }
  }
  validatePlan(plan); return plan;
}

class RetryCaptureRunner {
  constructor(options) { this.options = options; this.clock = options.clock || new RealClock(); this.mode = options.mode || "network"; this.counters = { globalAttempts: 0, retries: 0, perEndpoint: Object.fromEntries(SELECTED_ENDPOINTS.map((row) => [row.endpointId, 0])), stages: Object.fromEntries(STAGES.map((row) => [row.id, 0])) }; this.lastDispatchAt = null; this.namespaceFirstDispatch = new Map(); this.captureStartedAt = null; this.pinBoundAt = null; }
  stop(code, stage) { throw new RunnerStop(code, stage); }
  checkCaptureDeadline(stage) { if (this.clock.now() - this.captureStartedAt > POLICY.captureDeadlineMs) this.stop("CAPTURE_DEADLINE_EXCEEDED", stage); }
  async enforceGap(stage) { if (this.lastDispatchAt !== null) { const wait = POLICY.interAttemptGapMs - (this.clock.now() - this.lastDispatchAt); if (wait > 0) await this.clock.sleep(wait); } this.checkCaptureDeadline(stage); }
  async enforceNamespaceSeparation(operation) { if (operation.stage !== "namespace-lookups") return; const key = `${operation.endpointId}\0${operation.namespaceKey}`; if (operation.lookupOrdinal === 1) return; const first = this.namespaceFirstDispatch.get(key); if (!Number.isFinite(first)) this.stop("NAMESPACE_FIRST_LOOKUP_MISSING", operation.stage); const wait = POLICY.namespaceSeparationMs - (this.clock.now() - first); if (wait > 0) await this.clock.sleep(wait); this.checkCaptureDeadline(operation.stage); }
  debitAttempt(operation, retry) { if (this.counters.globalAttempts + 1 > POLICY.maxAttemptsTotal) this.stop("GLOBAL_ATTEMPT_CAP_EXHAUSTED", operation.stage); if (this.counters.perEndpoint[operation.endpointId] + 1 > POLICY.maxAttemptsPerEndpoint) this.stop("PER_ENDPOINT_ATTEMPT_CAP_EXHAUSTED", operation.stage); if (retry) { if (this.counters.retries + 1 > POLICY.maxRetriesTotal) this.stop("RETRY_RESERVE_EXHAUSTED", operation.stage); this.counters.retries++; } else { const stage = STAGES.find((row) => row.id === operation.stage); if (!stage || this.counters.stages[operation.stage] + 1 > stage.total) this.stop("STAGE_LEDGER_EXHAUSTED", operation.stage); this.counters.stages[operation.stage]++; } this.counters.globalAttempts++; this.counters.perEndpoint[operation.endpointId]++; }
  async dispatch(operation, endpoint, retry) { await this.enforceNamespaceSeparation(operation); await this.enforceGap(operation.stage); this.checkCaptureDeadline(operation.stage); this.debitAttempt(operation, retry); const controller = new AbortController(); const token = this.clock.schedule(POLICY.serviceTimeoutMs, () => controller.abort()); const timestamp = this.clock.now(); this.lastDispatchAt = timestamp; if (operation.stage === "namespace-lookups" && operation.lookupOrdinal === 1 && !retry) this.namespaceFirstDispatch.set(`${operation.endpointId}\0${operation.namespaceKey}`, timestamp); try { const envelope = await endpoint.dispatch(operation, { signal: controller.signal, retry, serviceTimeoutMs: POLICY.serviceTimeoutMs }); if (controller.signal.aborted) throw new TransportFailure("timeout"); validateEnvelope(operation.method, envelope); return envelope; } finally { this.clock.cancel(token); } }
  async executeOperation(operation, endpoint) { try { return await this.dispatch(operation, endpoint, false); } catch (error) { if (error instanceof RunnerStop) throw error; const category = error instanceof TransportFailure ? error.category : "transport-failure"; if (operation.stage === "namespace-lookups") this.stop(`NAMESPACE_${category.toUpperCase().replace(/-/g, "_")}`, operation.stage); if (!["timeout", "rate-limited", "http-5xx"].includes(category)) this.stop(`ATTEMPT_${category.toUpperCase().replace(/-/g, "_")}`, operation.stage); if (this.counters.retries >= POLICY.maxRetriesTotal) this.stop("RETRY_RESERVE_EXHAUSTED", operation.stage); await this.clock.sleep(category === "rate-limited" ? POLICY.rateLimitWaitMs : POLICY.otherRetryWaitMs); this.checkCaptureDeadline(operation.stage); try { return await this.dispatch(operation, endpoint, true); } catch (retryError) { if (retryError instanceof RunnerStop) throw retryError; const retryCategory = retryError instanceof TransportFailure ? retryError.category : "transport-failure"; if (retryCategory === "rate-limited") this.stop("RATE_LIMIT_PERSISTED_AFTER_RETRY", operation.stage); if (retryCategory === "timeout") this.stop("TIMEOUT_PERSISTED_AFTER_RETRY", operation.stage); this.stop(`RETRY_${retryCategory.toUpperCase().replace(/-/g, "_")}`, operation.stage); } } }
  async run(plan) {
    let transportInvoked = false; try { const manifest = validatePackageBinding({ ...this.options, clock: this.clock, mode: this.mode }); validateCaps(manifest.stageLedger); validateEndpoints(this.options.endpoints); validatePlan(plan); this.captureStartedAt = this.clock.now(); const endpointMap = new Map(this.options.endpoints.map((row) => [row.endpointId, row])); let priorStage = null; for (const operation of plan) { if (priorStage && operation.stage !== priorStage && priorStage === "identity-finalized-before-pin") { this.pinBoundAt = this.clock.now(); if (this.pinBoundAt - this.captureStartedAt > POLICY.pinDeadlineMs) this.stop("FRESH_PIN_DEADLINE_EXCEEDED", priorStage); } priorStage = operation.stage; transportInvoked = true; await this.executeOperation(operation, endpointMap.get(operation.endpointId)); }
      if (this.pinBoundAt === null) this.stop("PIN_NOT_BOUND"); this.checkCaptureDeadline("complete"); for (const stage of STAGES) if (this.counters.stages[stage.id] !== stage.total) this.stop("STAGE_LEDGER_INCOMPLETE", stage.id); if (this.counters.stages["mandatory-elapsed-canary-rerun"] !== 24) this.stop("MANDATORY_CANARY_RERUN_OMITTED"); return canonical({ status: "PASS_MOCK_OR_APPROVED_TRANSPORT", classificationScope: "SELECTED-THREE-SINGLETON-FAMILIES-ONLY", attempts: this.counters.globalAttempts, retries: this.counters.retries, perEndpointAttempts: this.counters.perEndpoint, stageDebits: this.counters.stages, pinElapsedMs: this.pinBoundAt - this.captureStartedAt, elapsedMs: this.clock.now() - this.captureStartedAt, transportInvoked });
    } catch (error) { const stop = error instanceof RunnerStop ? error : new RunnerStop("UNEXPECTED_RUNNER_FAILURE", "internal"); return canonical({ status: `INCONCLUSIVE/${stop.code}`, failureStage: stop.stage, attempts: this.counters.globalAttempts, retries: this.counters.retries, perEndpointAttempts: this.counters.perEndpoint, stageDebits: this.counters.stages, elapsedMs: this.captureStartedAt === null ? 0 : this.clock.now() - this.captureStartedAt, transportInvoked }); }
  }
}

function makeMockEndpoints(transport) { return SELECTED_ENDPOINTS.map((row) => ({ ...row, dispatch: transport.dispatch.bind(transport) })); }

module.exports = { POLICY, STAGES, READ_ONLY_METHODS, SELECTED_ENDPOINTS, R3_RUN_ID, R3_MANIFEST_AGGREGATE, RunnerStop, TransportFailure, RealClock, MockClock, MockTransport, RetryCaptureRunner, buildFixturePlan, makeMockEndpoints, validatePackageBinding, validateEndpoints, validateCaps, validatePlan, validateMethod, validateTimingConstants: () => ({ service: 420 * 2000, cooldown: 419 * 1000, retryWait: 10 * 30000, namespaceSeparation: 48 * 2000, fixedOverhead: 180000, total: 1835000, headroom: 865000 }) };

if (require.main === module) process.stdout.write(JSON.stringify({ status: "REVIEW_ONLY_RUNNER_READY", networkInvoked: false, explicitApprovedDecisionRequired: true, selectedEndpointCount: 3, successfulPathAttempts: 381, requiredMaximumWithRetries: 391 }) + "\n");
