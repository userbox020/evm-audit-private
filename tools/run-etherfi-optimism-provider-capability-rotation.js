#!/usr/bin/env node
"use strict";

// Bounded provider-capability qualification only. Endpoint material and raw
// responses remain in memory and are never part of the published artifact.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadRpcUrls, rpcCall: sharedRpcCall, PUBLIC_FALLBACKS } = require("./shared-rpc");
const etherfiTrigger = require("./run-critical-etherfi-debtmanager-profit-trigger.js");

const SCHEMA = "etherfi-optimism-provider-capability-rotation/v2";
const CHAIN_ID = 10;
const MAX_CANDIDATES = 96;
const MAX_NETWORK_CALLS = 256;
const MAX_CALLS_PER_CANDIDATE = 8;
const CALLS_FOR_COMPLETE_ATTEMPT = 6;
const CALL_TIMEOUT_MS = 6000;
const REQUIRED_REPLACEMENT_FAMILIES = 3;
const MAX_FINALIZED_AGE_SECONDS = 86400;
const MAX_FUTURE_SKEW_SECONDS = 300;
const WORKSPACE = path.resolve(__dirname, "..");
const OUTPUT = path.join(WORKSPACE, "reports", "monitor", "etherfi-optimism-provider-capability-rotation.json");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_SLOT = `0x${"0".repeat(64)}`;

const TOP_KEYS = Object.freeze([
  "schema", "generatedAt", "chainId", "candidateCount", "candidatesAttempted", "chainMatches",
  "finalizedQualified", "stateCapableCandidateCount", "independentStateCapableFamilyCount",
  "replacementAvailable", "status", "failureCounts", "budgets", "safety"
]);
const FAILURE_KEYS = Object.freeze([
  "chainProbeFailed", "chainMismatch", "finalizedHeaderFailed", "codeCanaryFailed",
  "storageCanaryFailed", "callCanaryFailed", "logsCanaryFailed"
]);
const BUDGET_KEYS = Object.freeze([
  "candidateLimit", "networkCallLimit", "perCandidateCallLimit", "networkCalls", "maximumCandidateCalls"
]);
const SAFETY_KEYS = Object.freeze([
  "readOnly", "inventoryReadInMemoryOnly", "publicFallbackInMemoryOnly", "endpointMaterialPersisted",
  "sequential", "automaticRetries", "consumerInvoked", "targetContractsCalled", "transactions", "signing", "broadcast"
]);
const LEAK_PATTERN = /(?:https?|wss?):\/\/|authorization\s*:|bearer\s|api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key|mnemonic|rpc_endpoints|graphql_endpoints|\.env\b|0x[0-9a-f]{40}(?:[0-9a-f]{24})?/i;

class RotationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function fail(code) { throw new RotationError(code); }
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function iso(value) {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch (_) { return false; }
}
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function emptyFailureCounts() { return Object.fromEntries(FAILURE_KEYS.map((key) => [key, 0])); }

function baseArtifact(now = Date.now) {
  const current = typeof now === "function" ? now() : now;
  return {
    schema: SCHEMA,
    generatedAt: new Date(current).toISOString(),
    chainId: CHAIN_ID,
    candidateCount: 0,
    candidatesAttempted: 0,
    chainMatches: 0,
    finalizedQualified: 0,
    stateCapableCandidateCount: 0,
    independentStateCapableFamilyCount: 0,
    replacementAvailable: false,
    status: "INCOMPLETE",
    failureCounts: emptyFailureCounts(),
    budgets: {
      candidateLimit: MAX_CANDIDATES,
      networkCallLimit: MAX_NETWORK_CALLS,
      perCandidateCallLimit: MAX_CALLS_PER_CANDIDATE,
      networkCalls: 0,
      maximumCandidateCalls: 0
    },
    safety: {
      readOnly: true,
      inventoryReadInMemoryOnly: true,
      publicFallbackInMemoryOnly: true,
      endpointMaterialPersisted: false,
      sequential: true,
      automaticRetries: 0,
      consumerInvoked: false,
      targetContractsCalled: false,
      transactions: 0,
      signing: false,
      broadcast: false
    }
  };
}

function validateArtifact(value) {
  try {
    if (!exactKeys(value, TOP_KEYS) || value.schema !== SCHEMA || !iso(value.generatedAt)
        || value.chainId !== CHAIN_ID) return false;
    const counters = [
      value.candidateCount, value.candidatesAttempted, value.chainMatches, value.finalizedQualified,
      value.stateCapableCandidateCount, value.independentStateCapableFamilyCount
    ];
    if (!counters.every(count) || value.candidateCount > MAX_CANDIDATES
        || value.candidatesAttempted > value.candidateCount || value.chainMatches > value.candidatesAttempted
        || value.finalizedQualified > value.chainMatches
        || value.stateCapableCandidateCount > value.finalizedQualified
        || value.independentStateCapableFamilyCount > value.stateCapableCandidateCount) return false;
    if (typeof value.replacementAvailable !== "boolean"
        || value.replacementAvailable !== (value.independentStateCapableFamilyCount >= REQUIRED_REPLACEMENT_FAMILIES)
        || !["READY", "INCOMPLETE"].includes(value.status)
        || (value.status === "READY") !== value.replacementAvailable) return false;

    const failures = value.failureCounts;
    if (!exactKeys(failures, FAILURE_KEYS) || !FAILURE_KEYS.every((key) => count(failures[key]))) return false;
    const failureTotal = FAILURE_KEYS.reduce((sum, key) => sum + failures[key], 0);
    if (failureTotal + value.stateCapableCandidateCount !== value.candidatesAttempted
        || failures.chainProbeFailed + failures.chainMismatch !== value.candidatesAttempted - value.chainMatches
        || failures.finalizedHeaderFailed !== value.chainMatches - value.finalizedQualified
        || failures.codeCanaryFailed + failures.storageCanaryFailed + failures.callCanaryFailed
          + failures.logsCanaryFailed !== value.finalizedQualified - value.stateCapableCandidateCount) return false;

    const budgets = value.budgets;
    if (!exactKeys(budgets, BUDGET_KEYS) || budgets.candidateLimit !== MAX_CANDIDATES
        || budgets.networkCallLimit !== MAX_NETWORK_CALLS
        || budgets.perCandidateCallLimit !== MAX_CALLS_PER_CANDIDATE
        || !count(budgets.networkCalls) || budgets.networkCalls > MAX_NETWORK_CALLS
        || !count(budgets.maximumCandidateCalls) || budgets.maximumCandidateCalls > MAX_CALLS_PER_CANDIDATE
        || budgets.maximumCandidateCalls > budgets.networkCalls
        || budgets.networkCalls > value.candidatesAttempted * MAX_CALLS_PER_CANDIDATE) return false;

    const safety = value.safety;
    if (!exactKeys(safety, SAFETY_KEYS) || safety.readOnly !== true
        || safety.inventoryReadInMemoryOnly !== true || safety.publicFallbackInMemoryOnly !== true
        || safety.endpointMaterialPersisted !== false || safety.sequential !== true
        || safety.automaticRetries !== 0 || typeof safety.consumerInvoked !== "boolean"
        || safety.consumerInvoked !== value.replacementAvailable
        || typeof safety.targetContractsCalled !== "boolean"
        || safety.targetContractsCalled !== safety.consumerInvoked
        || safety.transactions !== 0 || safety.signing !== false || safety.broadcast !== false) return false;
    return !LEAK_PATTERN.test(JSON.stringify(value));
  } catch (_) { return false; }
}

function candidatePool(options = {}) {
  const supplied = options.candidateUrls;
  const values = supplied === undefined
    ? [...loadRpcUrls({ maxCandidates: MAX_CANDIDATES - 1 }), PUBLIC_FALLBACKS[CHAIN_ID]]
    : supplied;
  if (!Array.isArray(values)) return [];
  const candidates = [], seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || seen.has(value)) continue;
    try {
      const parsed = new URL(value);
      if (!["http:", "https:"].includes(parsed.protocol)) continue;
    } catch (_) { continue; }
    seen.add(value);
    candidates.push(value);
    if (candidates.length === MAX_CANDIDATES) break;
  }
  return candidates;
}

const canonicalProviderFamily = etherfiTrigger.canonicalProviderFamily;
function parseChainId(value) {
  try {
    if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
    const parsed = Number(BigInt(value));
    return Number.isSafeInteger(parsed) ? parsed : null;
  } catch (_) { return null; }
}
function finalizedTag(value, nowMs) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || typeof value.number !== "string" || !/^0x[0-9a-f]+$/i.test(value.number)
        || typeof value.hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(value.hash)
        || typeof value.timestamp !== "string" || !/^0x[0-9a-f]+$/i.test(value.timestamp)) return null;
    const number = BigInt(value.number), timestamp = BigInt(value.timestamp);
    const nowSeconds = BigInt(Math.floor(nowMs / 1000));
    if (number < 0n || timestamp < nowSeconds - BigInt(MAX_FINALIZED_AGE_SECONDS)
        || timestamp > nowSeconds + BigInt(MAX_FUTURE_SKEW_SECONDS)) return null;
    return `0x${number.toString(16)}`;
  } catch (_) { return null; }
}
function hexBytes(value) { return typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value); }

function makeTransport(rawCall, timeoutMs = CALL_TIMEOUT_MS) {
  let networkCalls = 0, currentCandidateCalls = 0, maximumCandidateCalls = 0;
  return Object.freeze({
    beginCandidate() { currentCandidateCalls = 0; },
    async call(url, method, params) {
      if (networkCalls >= MAX_NETWORK_CALLS) fail("NETWORK_CALL_CAP");
      if (currentCandidateCalls >= MAX_CALLS_PER_CANDIDATE) fail("CANDIDATE_CALL_CAP");
      networkCalls += 1;
      currentCandidateCalls += 1;
      maximumCandidateCalls = Math.max(maximumCandidateCalls, currentCandidateCalls);
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(() => rawCall(url, method, params, timeoutMs)).catch(() => null),
          new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); })
        ]);
      } finally { clearTimeout(timer); }
    },
    get networkCalls() { return networkCalls; },
    get maximumCandidateCalls() { return maximumCandidateCalls; }
  });
}

async function runRotation(options = {}) {
  const artifact = baseArtifact(options.now || Date.now);
  const evidenceNowMs = Date.parse(artifact.generatedAt);
  const candidates = candidatePool(options);
  const requestedTimeout = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs : CALL_TIMEOUT_MS;
  const transport = makeTransport(options.rpcCall || sharedRpcCall, Math.min(requestedTimeout, CALL_TIMEOUT_MS));
  const capableUrls = [], capableByFamily = new Map();
  artifact.candidateCount = candidates.length;

  for (const url of candidates) {
    if (transport.networkCalls + CALLS_FOR_COMPLETE_ATTEMPT > MAX_NETWORK_CALLS) break;
    artifact.candidatesAttempted += 1;
    transport.beginCandidate();

    const chain = await transport.call(url, "eth_chainId", []);
    const parsedChain = parseChainId(chain);
    if (parsedChain === null) { artifact.failureCounts.chainProbeFailed += 1; continue; }
    if (parsedChain !== CHAIN_ID) { artifact.failureCounts.chainMismatch += 1; continue; }
    artifact.chainMatches += 1;

    const tag = finalizedTag(await transport.call(url, "eth_getBlockByNumber", ["finalized", false]), evidenceNowMs);
    if (tag === null) { artifact.failureCounts.finalizedHeaderFailed += 1; continue; }
    artifact.finalizedQualified += 1;

    const code = await transport.call(url, "eth_getCode", [ZERO_ADDRESS, tag]);
    if (!hexBytes(code)) { artifact.failureCounts.codeCanaryFailed += 1; continue; }
    const storage = await transport.call(url, "eth_getStorageAt", [ZERO_ADDRESS, ZERO_SLOT, tag]);
    if (typeof storage !== "string" || !/^0x[0-9a-f]{64}$/i.test(storage)) {
      artifact.failureCounts.storageCanaryFailed += 1;
      continue;
    }
    const callResult = await transport.call(url, "eth_call", [{ to: ZERO_ADDRESS, data: "0x" }, tag]);
    if (!hexBytes(callResult)) { artifact.failureCounts.callCanaryFailed += 1; continue; }
    const logs = await transport.call(url, "eth_getLogs", [{ address: ZERO_ADDRESS, fromBlock: tag, toBlock: tag }]);
    if (!Array.isArray(logs) || logs.length !== 0) { artifact.failureCounts.logsCanaryFailed += 1; continue; }
    capableUrls.push(url);
    const family = canonicalProviderFamily(url);
    if (!capableByFamily.has(family)) capableByFamily.set(family, url);
  }

  artifact.stateCapableCandidateCount = capableUrls.length;
  // Family identity is intentionally derived only for fully qualified rows.
  artifact.independentStateCapableFamilyCount = capableByFamily.size;
  artifact.replacementAvailable = artifact.independentStateCapableFamilyCount >= REQUIRED_REPLACEMENT_FAMILIES;
  artifact.budgets.networkCalls = transport.networkCalls;
  artifact.budgets.maximumCandidateCalls = transport.maximumCandidateCalls;
  if (artifact.replacementAvailable) {
    const consumer = options.consumer || ((urls) => consumeWithEtherfiTrigger(urls, options));
    await consumer([...capableByFamily.values()].slice(0, REQUIRED_REPLACEMENT_FAMILIES));
    artifact.status = "READY";
    artifact.safety.consumerInvoked = true;
    artifact.safety.targetContractsCalled = true;
  }
  if (!validateArtifact(artifact)) fail("OUTPUT_SCHEMA_INVALID");
  return artifact;
}

async function consumeWithEtherfiTrigger(candidateUrls, options = {}) {
  const artifact = await etherfiTrigger.runTrigger({
    candidateUrls,
    qualificationFamilyTarget: 3,
    rpcCall: options.triggerRpcCall || options.rpcCall || sharedRpcCall,
    historical: options.triggerHistorical,
    now: options.now || Date.now
  });
  if (!etherfiTrigger.validateArtifact(artifact)) fail("CONSUMER_ARTIFACT_INVALID");
  etherfiTrigger.publishAtomic(artifact, {
    fsImpl: options.fsImpl,
    outputPath: options.triggerOutputPath || etherfiTrigger.OUTPUT,
    allowedRoot: options.triggerAllowedRoot || path.dirname(options.triggerOutputPath || etherfiTrigger.OUTPUT)
  });
  return artifact;
}

function fsyncDirectory(directory, fsImpl = fs) {
  const descriptor = fsImpl.openSync(directory, "r");
  try {
    try { fsImpl.fsyncSync(descriptor); }
    catch (error) { if (!["EINVAL", "EPERM", "EBADF"].includes(error.code)) throw error; }
  } finally { fsImpl.closeSync(descriptor); }
}
function publishAtomic(artifact, options = {}) {
  if (!validateArtifact(artifact)) fail("OUTPUT_SCHEMA_INVALID");
  const fsImpl = options.fsImpl || fs;
  const target = path.resolve(options.outputPath || OUTPUT);
  const allowedRoot = path.resolve(options.allowedRoot || path.dirname(OUTPUT));
  const filename = "etherfi-optimism-provider-capability-rotation.json";
  if (path.dirname(target) !== allowedRoot || path.basename(target) !== filename) fail("OUTPUT_PATH_REJECTED");
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  const temporary = path.join(allowedRoot, `.${filename}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  let descriptor;
  try {
    descriptor = fsImpl.openSync(temporary, "wx", 0o600);
    fsImpl.writeFileSync(descriptor, bytes);
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    fsImpl.renameSync(temporary, target);
    fsyncDirectory(allowedRoot, fsImpl);
    const readback = fsImpl.readFileSync(target);
    if (!readback.equals(bytes) || !validateArtifact(JSON.parse(readback.toString("utf8")))) fail("READBACK_INVALID");
    return target;
  } finally {
    if (descriptor !== undefined) try { fsImpl.closeSync(descriptor); } catch (_) {}
    if (fsImpl.existsSync(temporary)) try { fsImpl.unlinkSync(temporary); } catch (_) {}
  }
}
async function runAndPublish(options = {}) {
  const artifact = await runRotation(options);
  publishAtomic(artifact, options);
  return artifact;
}
async function main(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length !== 0) fail("ARGUMENTS_REJECTED");
  await runAndPublish();
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });

module.exports = Object.freeze({
  SCHEMA, CHAIN_ID, MAX_CANDIDATES, MAX_NETWORK_CALLS, MAX_CALLS_PER_CANDIDATE,
  REQUIRED_REPLACEMENT_FAMILIES, OUTPUT, RotationError, baseArtifact, validateArtifact,
  canonicalProviderFamily, candidatePool, consumeWithEtherfiTrigger, runRotation, publishAtomic, runAndPublish, main
});
