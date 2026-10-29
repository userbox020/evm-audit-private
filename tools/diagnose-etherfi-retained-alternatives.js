#!/usr/bin/env node
"use strict";

// One current primary baseline, then unused alternatives from that exact selected pool.
// Endpoint handles, family identities, source bodies and raw replies remain process-only.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const diagnostic = require("./diagnose-etherfi-qualification");
const producer = require("./run-critical-etherfi-debtmanager-profit-trigger");
const sharedRpc = require("./shared-rpc");
const { isTransportFailure, reviewedOperatorFamily } = require("./lib/rpc-provider-reliability");
const { normalizeHeader, PreflightError } = require("./lib/common-finalized-rpc-preflight");

const SOURCE_PATH = path.join(__dirname, "run-critical-etherfi-debtmanager-profit-trigger.js");
const SOURCE_SHA = "e0c15152e462736a30d2707159622f965f15298de78012d34c182ae29a1810df";
const SCHEMA = "etherfi-retained-alternatives-diagnostic/v1";
const LIMITS = Object.freeze({
  maxNetworkCalls: 80, maxCandidates: 44, maxInventoryCandidates: 96,
  preflightCeiling: 65, probeReserve: 26, requiredFamilies: 2,
  maxTransportRetriesPerFamily: 1, maxEndpointsPerFamily: 2,
  maxAlternativesPerFamily: 1, maxAlternativeReads: 2,
  chainTimeoutMs: 3500, finalizedTimeoutMs: 6000,
  deploymentBlock: 149521228, maxFinalizedAgeSeconds: 86400, maxFutureSkewSeconds: 300
});
const SAFETY = Object.freeze({
  sameSelectedPoolOnly: true, pinConsensusPerformed: false, stateReads: 0, flowReads: 0,
  monitorPublished: false, noSigning: true, noBroadcast: true
});
const OUTCOMES = Object.freeze([
  "NO_RETAINED_ALTERNATIVE", "ALREADY_PROBED_BY_BASELINE", "INVALID_CHAIN_RESPONSE", "WRONG_CHAIN",
  "TRANSPORT_FAILURE", "RPC_FAILURE", "INVALID_HEADER", "PREDEPLOYMENT_HEADER", "STALE_HEADER",
  "FUTURE_HEADER", "FINALIZED_QUALIFIED", "NETWORK_CALL_CAP"
]);
const SUCCESS = new Set(["BASELINE_ALREADY_HAS_TWO_FAMILIES", "SECOND_FAMILY_FOUND_IN_EXISTING_POOL"]);
const STATUSES = new Set([
  ...SUCCESS, "EXISTING_POOL_STILL_INSUFFICIENT", "NETWORK_CALL_CAP", "BASELINE_REFUSED",
  "REFUSED_ARGUMENTS", "INVALID_OPTIONS", "SOURCE_VERSION_MISMATCH", "SOURCE_CHANGED",
  "INVENTORY_FAILURE", "UNEXPECTED", "OUTPUT_SCHEMA_INVALID"
]);
const TOP_KEYS = [
  "schema", "generatedAt", "chainId", "originalSourceSha", "baseline", "alternativeAttempts",
  "totalNetworkCalls", "alternativeNetworkCalls", "qualifiedFamiliesAfter", "counts", "status",
  "sourceUnchanged", "safety", "limits"
];
function baseResult() {
  return {
    schema: SCHEMA, generatedAt: new Date().toISOString(), chainId: 10, originalSourceSha: null,
    baseline: null, alternativeAttempts: [], totalNetworkCalls: 0, alternativeNetworkCalls: 0,
    qualifiedFamiliesAfter: 0, counts: Object.fromEntries(OUTCOMES.map((key) => [key, 0])),
    status: "EXISTING_POOL_STILL_INSUFFICIENT", sourceUnchanged: false,
    safety: { ...SAFETY }, limits: { ...LIMITS }
  };
}
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function validateResult(value) {
  try {
    if (!exactKeys(value, TOP_KEYS) || value.schema !== SCHEMA || value.chainId !== 10
        || typeof value.generatedAt !== "string" || new Date(value.generatedAt).toISOString() !== value.generatedAt
        || ![null, SOURCE_SHA].includes(value.originalSourceSha) || typeof value.sourceUnchanged !== "boolean"
        || !STATUSES.has(value.status) || !exactKeys(value.limits, Object.keys(LIMITS))
        || !Object.keys(LIMITS).every((key) => value.limits[key] === LIMITS[key])
        || !exactKeys(value.safety, Object.keys(SAFETY))
        || !Object.keys(SAFETY).every((key) => value.safety[key] === SAFETY[key])
        || !["totalNetworkCalls", "alternativeNetworkCalls", "qualifiedFamiliesAfter"].every((key) => count(value[key]))
        || value.totalNetworkCalls > LIMITS.maxNetworkCalls || value.qualifiedFamiliesAfter > 2
        || !exactKeys(value.counts, OUTCOMES) || !Object.values(value.counts).every(count)
        || !Array.isArray(value.alternativeAttempts)) return false;
    const baseline = value.baseline;
    if (baseline !== null && (!diagnostic.validateResult(baseline) || baseline.sourceSha256 !== SOURCE_SHA
        || baseline.generatedAt !== value.generatedAt)) return false;
    if (value.sourceUnchanged && value.originalSourceSha !== SOURCE_SHA) return false;
    if (value.totalNetworkCalls > 0 && value.originalSourceSha !== SOURCE_SHA) return false;
    if (value.status === "SOURCE_CHANGED" && value.sourceUnchanged) return false;
    if (baseline && value.originalSourceSha !== SOURCE_SHA) return false;
    const totals = Object.fromEntries(OUTCOMES.map((key) => [key, 0]));
    let reads = 0, previousOrdinal = 0;
    for (const row of value.alternativeAttempts) {
      if (!exactKeys(row, ["primaryAttemptOrdinal", "outcome", "stage", "reads"])
          || !count(row.primaryAttemptOrdinal) || row.primaryAttemptOrdinal <= previousOrdinal
          || !baseline || row.primaryAttemptOrdinal > baseline.attempts.length
          || baseline.attempts[row.primaryAttemptOrdinal - 1].outcome === "FINALIZED_QUALIFIED"
          || !OUTCOMES.includes(row.outcome) || !count(row.reads) || row.reads > LIMITS.maxAlternativeReads) return false;
      if (["NO_RETAINED_ALTERNATIVE", "ALREADY_PROBED_BY_BASELINE"].includes(row.outcome)) {
        if (row.stage !== "SKIPPED" || row.reads !== 0) return false;
      } else {
        if (!["CHAIN", "FINALIZED"].includes(row.stage)) return false;
        if (row.outcome === "NETWORK_CALL_CAP") {
          if (row.reads !== (row.stage === "CHAIN" ? 0 : 1)) return false;
        } else if (row.reads !== (row.stage === "CHAIN" ? 1 : 2)) return false;
        if (["WRONG_CHAIN", "INVALID_CHAIN_RESPONSE"].includes(row.outcome) && row.stage !== "CHAIN") return false;
        if (["INVALID_HEADER", "PREDEPLOYMENT_HEADER", "STALE_HEADER", "FUTURE_HEADER", "FINALIZED_QUALIFIED"].includes(row.outcome)
            && row.stage !== "FINALIZED") return false;
      }
      previousOrdinal = row.primaryAttemptOrdinal;
      totals[row.outcome] += 1;
      reads += row.reads;
      // No attempt, including a skipped one, may follow the second qualified family.
      if ((baseline.finalizedQualified + totals.FINALIZED_QUALIFIED >= 2 || row.outcome === "NETWORK_CALL_CAP")
          && row !== value.alternativeAttempts[value.alternativeAttempts.length - 1]) return false;
    }
    if (!OUTCOMES.every((key) => totals[key] === value.counts[key])
        || reads !== value.alternativeNetworkCalls
        || (baseline && value.totalNetworkCalls !== baseline.networkCalls + reads)
        || value.qualifiedFamiliesAfter !== (baseline ? baseline.finalizedQualified : 0) + totals.FINALIZED_QUALIFIED) return false;
    if (!baseline && (reads || value.alternativeAttempts.length || value.qualifiedFamiliesAfter
        || value.totalNetworkCalls > 0 && !["BASELINE_REFUSED", "UNEXPECTED", "SOURCE_CHANGED"].includes(value.status))) return false;
    if (value.alternativeAttempts.length && (baseline.status !== "TWO_FAMILIES_UNAVAILABLE" || !baseline.sourceUnchanged)) return false;
    if (SUCCESS.has(value.status) && (!value.sourceUnchanged || value.qualifiedFamiliesAfter !== 2 || !baseline?.sourceUnchanged)) return false;
    if (value.status === "BASELINE_ALREADY_HAS_TWO_FAMILIES"
        && (baseline?.status !== "QUALIFICATION_ONLY_COMPLETE_NOT_PIN_CONSENSUS" || value.alternativeAttempts.length)) return false;
    if (value.status === "SECOND_FAMILY_FOUND_IN_EXISTING_POOL"
        && (baseline?.status !== "TWO_FAMILIES_UNAVAILABLE" || !totals.FINALIZED_QUALIFIED)) return false;
    if (value.qualifiedFamiliesAfter === 2 && !SUCCESS.has(value.status) && value.status !== "SOURCE_CHANGED") return false;
    if (value.status === "EXISTING_POOL_STILL_INSUFFICIENT"
        && (!value.sourceUnchanged || baseline?.status !== "TWO_FAMILIES_UNAVAILABLE"
          || value.alternativeAttempts.length !== baseline.qualificationAttempts - baseline.finalizedQualified)) return false;
    if (totals.NETWORK_CALL_CAP && !["NETWORK_CALL_CAP", "SOURCE_CHANGED"].includes(value.status)) return false;
    return true;
  } catch (_) { return false; }
}
function validated(result) {
  if (validateResult(result)) return result;
  const refused = baseResult();
  refused.status = "OUTPUT_SCHEMA_INVALID";
  return refused;
}
function headerOutcome(raw, nowSeconds, limits) {
  const header = normalizeHeader(raw);
  if (!header) return "INVALID_HEADER";
  if (header.number < limits.deploymentBlock) return "PREDEPLOYMENT_HEADER";
  const timestamp = BigInt(header.timestamp);
  if (timestamp < nowSeconds - BigInt(limits.maxFinalizedAgeSeconds)) return "STALE_HEADER";
  if (timestamp > nowSeconds + BigInt(limits.maxFutureSkewSeconds)) return "FUTURE_HEADER";
  return "FINALIZED_QUALIFIED";
}

async function diagnoseRetainedAlternatives(options = {}) {
  const result = baseResult();
  if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => !["rpcCall", "inventoryLoader", "readSource", "now"].includes(key))
      || Object.hasOwn(options, "rpcCall") && typeof options.rpcCall !== "function"
      || ["inventoryLoader", "readSource", "now"].some((key) => Object.hasOwn(options, key)
        && (typeof options[key] !== "function" || typeof options.rpcCall !== "function"))) {
    result.status = "INVALID_OPTIONS";
    return validated(result);
  }
  const readSource = options.readSource || (() => fs.readFileSync(SOURCE_PATH));
  const matchesSource = () => crypto.createHash("sha256").update(readSource()).digest("hex") === SOURCE_SHA;
  const finish = () => {
    try { result.sourceUnchanged = result.originalSourceSha === SOURCE_SHA && matchesSource()
      && (!result.baseline || result.baseline.sourceUnchanged); }
    catch (_) { result.sourceUnchanged = false; }
    if (!result.sourceUnchanged && result.originalSourceSha === SOURCE_SHA) result.status = "SOURCE_CHANGED";
    return validated(result);
  };
  try { if (matchesSource()) result.originalSourceSha = SOURCE_SHA; } catch (_) { /* Refuse without error detail. */ }
  if (!result.originalSourceSha) { result.status = "SOURCE_VERSION_MISMATCH"; return validated(result); }
  let fixedNow, nowSeconds;
  try {
    fixedNow = (options.now || Date.now)();
    result.generatedAt = new Date(fixedNow).toISOString();
    nowSeconds = BigInt(Math.floor(Date.parse(result.generatedAt) / 1000));
  } catch (_) { result.status = "INVALID_OPTIONS"; return finish(); }
  let inventory, selected;
  try {
    inventory = (options.inventoryLoader || sharedRpc.loadRpcUrls)({ maxCandidates: LIMITS.maxInventoryCandidates });
    if (!Array.isArray(inventory)) throw new Error("INVENTORY_FAILURE");
    inventory = inventory.slice(0, LIMITS.maxInventoryCandidates);
    selected = producer.candidatePool({ inventoryLoader: () => inventory });
  } catch (_) { result.status = "INVENTORY_FAILURE"; return finish(); }
  const families = new Map();
  for (const row of selected) {
    if (!reviewedOperatorFamily(row.operatorFamily)) continue;
    if (!families.has(row.operatorFamily)) families.set(row.operatorFamily, []);
    families.get(row.operatorFamily).push(row);
  }
  const primaryRows = [...families.values()].map((rows) => rows[0]);
  const selectedHandles = new Set(selected.map((row) => row.handle));
  const contacted = new Set();
  let totalCalls = 0;
  const rawCall = options.rpcCall || sharedRpc.rpcCallStrict;
  const tracked = diagnostic.createQualificationTransport(async (handle, method, params, timeout) => {
    if (!selectedHandles.has(handle)) throw new Error("POOL_REJECTED");
    if (totalCalls >= LIMITS.maxNetworkCalls) throw new PreflightError("NETWORK_CALL_CAP");
    contacted.add(handle);
    totalCalls += 1;
    return rawCall(handle, method, params, timeout);
  });
  try {
    // Do not supply candidates: doing so would change default fallback/hint ordering.
    const baseline = await diagnostic.diagnoseQualification({
      inventoryLoader: () => inventory, rpcCall: tracked, now: () => fixedNow, readSource
    });
    result.totalNetworkCalls = totalCalls;
    if (!diagnostic.validateResult(baseline) || baseline.sourceSha256 !== SOURCE_SHA
        || baseline.selectedCandidateRows !== selected.length || baseline.recognizedFamilyCount !== families.size
        || baseline.qualificationAttempts > primaryRows.length || baseline.networkCalls !== totalCalls
        || baseline.generatedAt !== result.generatedAt) {
      result.status = "BASELINE_REFUSED";
      return finish();
    }
    result.baseline = baseline;
    result.totalNetworkCalls = totalCalls;
    result.qualifiedFamiliesAfter = baseline.finalizedQualified;
    if (!baseline.sourceUnchanged || !["TWO_FAMILIES_UNAVAILABLE", "QUALIFICATION_ONLY_COMPLETE_NOT_PIN_CONSENSUS"].includes(baseline.status)) {
      result.status = baseline.status === "NETWORK_CALL_CAP" ? "NETWORK_CALL_CAP" : "BASELINE_REFUSED";
      return finish();
    }
    if (baseline.finalizedQualified >= 2) {
      result.status = "BASELINE_ALREADY_HAS_TWO_FAMILIES";
      return finish();
    }
    for (const primaryAttempt of baseline.attempts) {
      if (primaryAttempt.outcome === "FINALIZED_QUALIFIED") continue;
      const primary = primaryRows[primaryAttempt.attemptOrdinal - 1];
      const retained = families.get(primary.operatorFamily).find((row) => row.handle !== primary.handle);
      const attempt = { primaryAttemptOrdinal: primaryAttempt.attemptOrdinal,
        outcome: "NO_RETAINED_ALTERNATIVE", stage: "SKIPPED", reads: 0 };
      if (retained && contacted.has(retained.handle)) attempt.outcome = "ALREADY_PROBED_BY_BASELINE";
      else if (retained) {
        attempt.stage = "CHAIN";
        const call = async (method, params, timeout) => {
          if (totalCalls >= LIMITS.maxNetworkCalls) throw new PreflightError("NETWORK_CALL_CAP");
          attempt.reads += 1;
          return tracked(retained.handle, method, params, timeout);
        };
        try {
          const chain = await call("eth_chainId", [], baseline.limits.chainTimeoutMs);
          if (typeof chain !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(chain)) attempt.outcome = "INVALID_CHAIN_RESPONSE";
          else if (BigInt(chain) !== 10n) attempt.outcome = "WRONG_CHAIN";
          else {
            attempt.stage = "FINALIZED";
            attempt.outcome = headerOutcome(await call("eth_getBlockByNumber", ["finalized", false], baseline.limits.finalizedTimeoutMs), nowSeconds, baseline.limits);
          }
        } catch (error) {
          attempt.outcome = error instanceof PreflightError && error.code === "NETWORK_CALL_CAP" ? "NETWORK_CALL_CAP"
            : isTransportFailure(error) ? "TRANSPORT_FAILURE" : "RPC_FAILURE";
        }
      }
      result.alternativeAttempts.push(attempt);
      result.counts[attempt.outcome] += 1;
      result.alternativeNetworkCalls += attempt.reads;
      result.totalNetworkCalls = totalCalls;
      if (attempt.outcome === "FINALIZED_QUALIFIED") result.qualifiedFamiliesAfter += 1;
      if (attempt.outcome === "NETWORK_CALL_CAP") { result.status = "NETWORK_CALL_CAP"; break; }
      if (result.qualifiedFamiliesAfter >= 2) { result.status = "SECOND_FAMILY_FOUND_IN_EXISTING_POOL"; break; }
    }
  } catch (_) { result.totalNetworkCalls = totalCalls; result.status = "UNEXPECTED"; }
  return finish();
}

async function main(argv = process.argv.slice(2), options = {}) {
  let result;
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== "--run") {
    result = baseResult(); result.status = "REFUSED_ARGUMENTS";
  } else {
    try { result = await diagnoseRetainedAlternatives(options); }
    catch (_) { result = baseResult(); result.status = "UNEXPECTED"; }
  }
  result = validated(result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}
if (require.main === module) main().then((result) => {
  if (!SUCCESS.has(result.status)) process.exitCode = 1;
}).catch(() => { process.exitCode = 1; });

module.exports = Object.freeze({ diagnoseRetainedAlternatives, main, validateResult });
