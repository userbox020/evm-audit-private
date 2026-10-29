#!/usr/bin/env node
"use strict";

// Initial qualification only. Endpoint identities and raw responses stay in memory.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const producer = require("./run-critical-etherfi-debtmanager-profit-trigger.js");
const sharedRpc = require("./shared-rpc");
const { createTransportRetryController, isTransportFailure } = require("./lib/rpc-provider-reliability");
const { normalizeHeader, createRpcLedger, PreflightError } = require("./lib/common-finalized-rpc-preflight");

const SOURCE_PATH = path.join(__dirname, "run-critical-etherfi-debtmanager-profit-trigger.js");
const SOURCE_SHA256 = "e0c15152e462736a30d2707159622f965f15298de78012d34c182ae29a1810df";
const SCHEMA = "etherfi-qualification-diagnostic/v1";
const { CHAIN_ID, MAX_CANDIDATES, MAX_NETWORK_CALLS } = producer;
// Private producer constants: usable only while the exact source guard matches.
const LIMITS = Object.freeze({
  maxCandidates: MAX_CANDIDATES, maxNetworkCalls: MAX_NETWORK_CALLS,
  preflightCeiling: MAX_NETWORK_CALLS - 15, probeReserve: 2 * 13,
  requiredFamilies: 2, maxTransportRetriesPerFamily: 1,
  chainTimeoutMs: 3500, finalizedTimeoutMs: 6000,
  deploymentBlock: 149521228, maxFinalizedAgeSeconds: 86400, maxFutureSkewSeconds: 300
});
const SAFETY = Object.freeze({
  pinConsensusPerformed: false, stateReads: 0, flowReads: 0,
  monitorPublished: false, noSigning: true, noBroadcast: true
});
const OUTCOMES = Object.freeze([
  "WRONG_CHAIN", "INVALID_CHAIN_RESPONSE", "TRANSPORT_FAILURE", "RPC_FAILURE",
  "INVALID_HEADER", "PREDEPLOYMENT_HEADER", "STALE_HEADER", "FUTURE_HEADER",
  "FINALIZED_QUALIFIED", "NETWORK_CALL_CAP"
]);
const STATUSES = new Set([
  "REFUSED_ARGUMENTS", "INVALID_OPTIONS", "SOURCE_VERSION_MISMATCH", "SOURCE_CHANGED",
  "INVENTORY_FAILURE", "UNEXPECTED", "OUTPUT_SCHEMA_INVALID", "TWO_FAMILIES_UNAVAILABLE",
  "QUALIFICATION_ONLY_COMPLETE_NOT_PIN_CONSENSUS", "NETWORK_CALL_CAP"
]);
const TOP_KEYS = [
  "schema", "generatedAt", "chainId", "sourceSha256", "selectedCandidateRows", "recognizedFamilyCount",
  "qualificationAttempts", "chainMatches", "finalizedQualified", "networkCalls", "limits", "counts",
  "attempts", "transportFailures", "automaticRetries", "retryExhaustions", "status", "safety", "sourceUnchanged"
];
function baseResult() {
  return {
    schema: SCHEMA, generatedAt: new Date().toISOString(), chainId: CHAIN_ID, sourceSha256: null,
    selectedCandidateRows: 0, recognizedFamilyCount: 0, qualificationAttempts: 0,
    chainMatches: 0, finalizedQualified: 0, networkCalls: 0, limits: { ...LIMITS },
    counts: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])), attempts: [],
    transportFailures: 0, automaticRetries: 0, retryExhaustions: 0,
    status: "TWO_FAMILIES_UNAVAILABLE", safety: { ...SAFETY }, sourceUnchanged: false
  };
}
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function validateResult(value) {
  try {
    if (!exactKeys(value, TOP_KEYS) || value.schema !== SCHEMA || value.chainId !== CHAIN_ID
        || typeof value.generatedAt !== "string" || new Date(value.generatedAt).toISOString() !== value.generatedAt
        || !(value.sourceSha256 === null || typeof value.sourceSha256 === "string" && /^[0-9a-f]{64}$/.test(value.sourceSha256))
        || typeof value.sourceUnchanged !== "boolean" || !STATUSES.has(value.status)
        || !exactKeys(value.limits, Object.keys(LIMITS)) || !Object.keys(LIMITS).every((key) => value.limits[key] === LIMITS[key])
        || !exactKeys(value.safety, Object.keys(SAFETY)) || !Object.keys(SAFETY).every((key) => value.safety[key] === SAFETY[key])) return false;
    const numeric = ["selectedCandidateRows", "recognizedFamilyCount", "qualificationAttempts", "chainMatches",
      "finalizedQualified", "networkCalls", "transportFailures", "automaticRetries", "retryExhaustions"];
    if (!numeric.every((key) => count(value[key])) || value.selectedCandidateRows > MAX_CANDIDATES
        || value.recognizedFamilyCount > value.selectedCandidateRows || value.qualificationAttempts > value.recognizedFamilyCount
        || value.chainMatches > value.qualificationAttempts || value.finalizedQualified > value.chainMatches
        || value.finalizedQualified > LIMITS.requiredFamilies || value.networkCalls > MAX_NETWORK_CALLS
        || value.transportFailures > value.networkCalls || value.automaticRetries > value.transportFailures
        || value.automaticRetries > value.qualificationAttempts || value.retryExhaustions > value.transportFailures) return false;
    if (!exactKeys(value.counts, OUTCOMES) || !Object.values(value.counts).every(count)
        || !Array.isArray(value.attempts) || value.attempts.length !== value.qualificationAttempts) return false;
    const totals = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
    let finalizedStages = 0;
    for (let index = 0; index < value.attempts.length; index += 1) {
      const row = value.attempts[index];
      if (!exactKeys(row, ["attemptOrdinal", "stage", "outcome"]) || row.attemptOrdinal !== index + 1
          || !["CHAIN", "FINALIZED"].includes(row.stage) || !OUTCOMES.includes(row.outcome)) return false;
      if (["WRONG_CHAIN", "INVALID_CHAIN_RESPONSE"].includes(row.outcome) && row.stage !== "CHAIN") return false;
      if (["INVALID_HEADER", "PREDEPLOYMENT_HEADER", "STALE_HEADER", "FUTURE_HEADER", "FINALIZED_QUALIFIED"].includes(row.outcome)
          && row.stage !== "FINALIZED") return false;
      if (row.stage === "FINALIZED") finalizedStages += 1;
      totals[row.outcome] += 1;
    }
    if (!OUTCOMES.every((outcome) => totals[outcome] === value.counts[outcome])
        || totals.FINALIZED_QUALIFIED !== value.finalizedQualified || finalizedStages !== value.chainMatches) return false;
    if (value.sourceUnchanged && value.sourceSha256 !== SOURCE_SHA256) return false;
    if (value.status === "QUALIFICATION_ONLY_COMPLETE_NOT_PIN_CONSENSUS"
        && (value.finalizedQualified !== 2 || !value.sourceUnchanged)) return false;
    if (value.finalizedQualified === 2 && !["QUALIFICATION_ONLY_COMPLETE_NOT_PIN_CONSENSUS", "SOURCE_CHANGED"].includes(value.status)) return false;
    if (value.networkCalls > 0 && value.sourceSha256 !== SOURCE_SHA256) return false;
    return true;
  } catch (_) { return false; }
}
function validated(result) {
  if (validateResult(result)) return result;
  const refused = baseResult();
  refused.status = "OUTPUT_SCHEMA_INVALID";
  return refused;
}

// No state, logs, exact-height selectors, writes, or other methods reach raw transport.
function createQualificationTransport(rawCall) {
  return async (handle, method, params, timeout) => {
    const chain = method === "eth_chainId" && Array.isArray(params) && params.length === 0
      && timeout === LIMITS.chainTimeoutMs;
    const finalized = method === "eth_getBlockByNumber" && Array.isArray(params) && params.length === 2
      && params[0] === "finalized" && params[1] === false && timeout === LIMITS.finalizedTimeoutMs;
    if (!chain && !finalized) throw new Error("METHOD_REJECTED");
    return rawCall(handle, method, params, timeout);
  };
}
function headerOutcome(raw, nowSeconds) {
  const header = normalizeHeader(raw);
  if (!header) return "INVALID_HEADER";
  if (header.number < LIMITS.deploymentBlock) return "PREDEPLOYMENT_HEADER";
  const timestamp = BigInt(header.timestamp);
  if (timestamp < nowSeconds - BigInt(LIMITS.maxFinalizedAgeSeconds)) return "STALE_HEADER";
  if (timestamp > nowSeconds + BigInt(LIMITS.maxFutureSkewSeconds)) return "FUTURE_HEADER";
  return "FINALIZED_QUALIFIED";
}
function thrownOutcome(error) {
  if (error instanceof PreflightError && error.code === "NETWORK_CALL_CAP") return "NETWORK_CALL_CAP";
  return isTransportFailure(error) ? "TRANSPORT_FAILURE" : "RPC_FAILURE";
}

async function diagnoseQualification(options = {}) {
  const result = baseResult();
  // Test injection may never silently widen the pool used by a real transport.
  if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => !["rpcCall", "candidates", "inventoryLoader", "now", "readSource"].includes(key))
      || Object.hasOwn(options, "rpcCall") && typeof options.rpcCall !== "function"
      || ["candidates", "inventoryLoader", "now", "readSource"].some((key) => Object.hasOwn(options, key)) && typeof options.rpcCall !== "function") {
    result.status = "INVALID_OPTIONS";
    return validated(result);
  }
  const readSource = options.readSource || (() => fs.readFileSync(SOURCE_PATH));
  const sourceHash = () => crypto.createHash("sha256").update(readSource()).digest("hex");
  const finish = () => {
    try { result.sourceUnchanged = result.sourceSha256 === SOURCE_SHA256 && sourceHash() === result.sourceSha256; }
    catch (_) { result.sourceUnchanged = false; }
    if (!result.sourceUnchanged && result.sourceSha256 === SOURCE_SHA256) result.status = "SOURCE_CHANGED";
    return validated(result);
  };
  try { result.sourceSha256 = sourceHash(); } catch (_) { /* No source trust, no inventory/RPC. */ }
  if (result.sourceSha256 !== SOURCE_SHA256) {
    result.status = "SOURCE_VERSION_MISMATCH";
    return finish();
  }
  let nowSeconds;
  try {
    const nowMs = (options.now || Date.now)();
    result.generatedAt = new Date(nowMs).toISOString();
    nowSeconds = BigInt(Math.floor(Date.parse(result.generatedAt) / 1000));
  } catch (_) { result.status = "INVALID_OPTIONS"; return finish(); }
  let candidates;
  try { candidates = producer.candidatePool(options); }
  catch (_) { result.status = "INVENTORY_FAILURE"; return finish(); }
  result.selectedCandidateRows = candidates.length;
  const familyByHandle = new Map(candidates.map((candidate) => [candidate.handle, candidate.operatorFamily]));
  const alternativesByFamily = new Map();
  for (const candidate of candidates) {
    if (!candidate.operatorFamily) continue;
    if (!alternativesByFamily.has(candidate.operatorFamily)) alternativesByFamily.set(candidate.operatorFamily, []);
    alternativesByFamily.get(candidate.operatorFamily).push(candidate.handle);
  }
  result.recognizedFamilyCount = alternativesByFamily.size;
  const activeByFamily = new Map();
  const ledger = createRpcLedger(createQualificationTransport(options.rpcCall || sharedRpc.rpcCallStrict), MAX_NETWORK_CALLS);
  const retry = createTransportRetryController({ familyOf: (candidate) => candidate.operatorFamily });
  const rpc = Object.freeze({
    call(handle, method, params, timeout) {
      const operatorFamily = familyByHandle.get(handle) || null;
      const active = activeByFamily.get(operatorFamily) || handle;
      return retry.run({ operatorFamily }, async (_candidate, retryIndex) => {
        const alternatives = alternativesByFamily.get(operatorFamily) || [active];
        const selected = retryIndex === 0 ? active : alternatives.find((candidate) => candidate !== active) || active;
        const value = await ledger.call(selected, method, params, timeout);
        if (retryIndex > 0) activeByFamily.set(operatorFamily, selected);
        return value;
      });
    }
  });
  const remaining = () => LIMITS.preflightCeiling - ledger.networkCalls;
  const checked = (candidate, method, params, timeout) => {
    if (remaining() <= 0) throw new PreflightError("NETWORK_CALL_CAP");
    return rpc.call(candidate.handle, method, params, timeout);
  };
  function record(stage, outcome) {
    result.attempts.push({ attemptOrdinal: result.qualificationAttempts, stage, outcome });
    result.counts[outcome] += 1;
  }
  try {
    if (result.recognizedFamilyCount >= LIMITS.requiredFamilies) {
      const attemptedFamilies = new Set();
      for (const candidate of candidates) {
        if (!candidate.operatorFamily || attemptedFamilies.has(candidate.operatorFamily)) continue;
        attemptedFamilies.add(candidate.operatorFamily);
        if (remaining() <= LIMITS.probeReserve) { result.status = "NETWORK_CALL_CAP"; break; }
        result.qualificationAttempts += 1;
        let stage = "CHAIN", outcome;
        try {
          const chain = await checked(candidate, "eth_chainId", [], LIMITS.chainTimeoutMs);
          try {
            // Preserve producer matching semantics, but do not attribute coerced
            // non-quantity replies (for example an empty string) to another chain.
            outcome = BigInt(chain) === BigInt(CHAIN_ID) ? null
              : typeof chain === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(chain)
                ? "WRONG_CHAIN" : "INVALID_CHAIN_RESPONSE";
          }
          catch (_) { outcome = "INVALID_CHAIN_RESPONSE"; }
          if (!outcome) {
            result.chainMatches += 1;
            stage = "FINALIZED";
            outcome = headerOutcome(await checked(candidate, "eth_getBlockByNumber", ["finalized", false], LIMITS.finalizedTimeoutMs), nowSeconds);
            if (outcome === "FINALIZED_QUALIFIED") result.finalizedQualified += 1;
          }
        } catch (error) { outcome = thrownOutcome(error); }
        record(stage, outcome);
        if (outcome === "NETWORK_CALL_CAP") { result.status = "NETWORK_CALL_CAP"; break; }
        if (result.finalizedQualified === LIMITS.requiredFamilies) {
          result.status = "QUALIFICATION_ONLY_COMPLETE_NOT_PIN_CONSENSUS";
          break;
        }
      }
    }
  } catch (_) { result.status = "UNEXPECTED"; }
  finally {
    result.networkCalls = ledger.networkCalls;
    Object.assign(result, retry.snapshot());
  }
  return finish();
}

async function main(argv = process.argv.slice(2), options = {}) {
  let result;
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== "--run") {
    result = baseResult();
    result.status = "REFUSED_ARGUMENTS";
  } else {
    try { result = await diagnoseQualification(options); }
    catch (_) { result = baseResult(); result.status = "UNEXPECTED"; }
  }
  result = validated(result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}
if (require.main === module) main().then((result) => {
  if (result.status !== "QUALIFICATION_ONLY_COMPLETE_NOT_PIN_CONSENSUS") process.exitCode = 1;
}).catch(() => { process.exitCode = 1; });

module.exports = Object.freeze({ diagnoseQualification, main, validateResult, createQualificationTransport });
