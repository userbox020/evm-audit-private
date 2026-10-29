#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const producer = require("./run-critical-etherfi-debtmanager-profit-trigger");
const sharedRpc = require("./shared-rpc");
const { reviewedOperatorFamily, isTransportFailure } = require("./lib/rpc-provider-reliability");
const { normalizeHeader, createRpcLedger, PreflightError } = require("./lib/common-finalized-rpc-preflight");

const SOURCE_PATH = path.join(__dirname, "run-critical-etherfi-debtmanager-profit-trigger.js");
const SOURCE_SHA = "e0c15152e462736a30d2707159622f965f15298de78012d34c182ae29a1810df";
const SCHEMA = "etherfi-log-capability-diagnostic/v1";
const LIMITS = Object.freeze({ maxNetworkCalls: 80, maxEndpointsPerFamily: 2,
  chainTimeoutMs: 3500, finalizedTimeoutMs: 6000, logsTimeoutMs: 10000,
  recentBlocks: 100000, logChunk: 50000, deploymentBlock: 149521228,
  maxFinalizedAgeSeconds: 86400, maxFutureSkewSeconds: 300 });
const SAFETY = Object.freeze({ pinConsensusPerformed: false, logsCapableProbe: true, noSigning: true, noBroadcast: true });
const ERRORS = ["CHAIN_MISMATCH", "CHAIN_INVALID", "FINALIZED_INVALID", "PREDEPLOYMENT_HEADER", "STALE_HEADER",
  "FUTURE_HEADER", "INVALID_LOG_RESPONSE", "TRANSPORT_FAILURE", "RPC_FAILURE", "NETWORK_CALL_CAP"];
const OUTCOMES = ["NOT_RUN", "LOG_CAPABLE", ...ERRORS];
const STATUSES = new Set(["TWO_FAMILY_LOG_CAPABLE", "ONE_FAMILY_LOG_CAPABLE", ...ERRORS,
  "INSUFFICIENT_FAMILIES", "SOURCE_VERSION_MISMATCH", "SOURCE_CHANGED", "REFUSED_ARGUMENTS", "INVALID_OPTIONS", "UNEXPECTED", "OUTPUT_SCHEMA_INVALID"]);
const TOP_KEYS = ["schema", "generatedAt", "chainId", "producerSourceSha256", "sharedRpcSha256", "memberCount", "perMember",
  "counts", "capableFamilies", "status", "sourceUnchanged", "limits", "safety"];
const quantity = (value) => typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const decimal = (value) => typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function baseResult() {
  return { schema: SCHEMA, generatedAt: new Date().toISOString(), chainId: 10,
    producerSourceSha256: null, sharedRpcSha256: null, memberCount: 0, perMember: [],
    counts: Object.fromEntries(OUTCOMES.map((key) => [key, 0])), capableFamilies: 0,
    status: "UNEXPECTED", sourceUnchanged: false, limits: { ...LIMITS }, safety: { ...SAFETY } };
}
function windowFor(height) {
  const from = Math.max(LIMITS.deploymentBlock, height - LIMITS.recentBlocks + 1);
  return { fromBlock: String(from), toBlock: String(Math.min(height, from + LIMITS.logChunk - 1)) };
}
function memberOutcome(member) {
  for (const key of ["stageChain", "stageFinalized", "stageLog"]) {
    if (ERRORS.includes(member[key])) return member[key];
  }
  return member.stageLog === "LOG_CAPABLE" ? "LOG_CAPABLE" : "NOT_RUN";
}
function inferredStatus(result) {
  if (result.counts.NETWORK_CALL_CAP) return "NETWORK_CALL_CAP";
  if (result.memberCount < 2) return "INSUFFICIENT_FAMILIES";
  if (result.capableFamilies === 2) return "TWO_FAMILY_LOG_CAPABLE";
  if (result.capableFamilies === 1) return "ONE_FAMILY_LOG_CAPABLE";
  return result.perMember.map(memberOutcome).find((outcome) => ERRORS.includes(outcome)) || "UNEXPECTED";
}

function createLogTransport(rawCall) {
  return async (handle, method, params, timeout) => {
    const filter = Array.isArray(params) && params[0];
    const logs = method === "eth_getLogs" && Array.isArray(params) && params.length === 1 && timeout === LIMITS.logsTimeoutMs
      && exactKeys(filter, ["address", "fromBlock", "toBlock", "topics"])
      && typeof filter.address === "string" && filter.address.toLowerCase() === producer.MANAGER.toLowerCase()
      && quantity(filter.fromBlock) && quantity(filter.toBlock)
      && BigInt(filter.fromBlock) >= BigInt(LIMITS.deploymentBlock) && BigInt(filter.toBlock) >= BigInt(filter.fromBlock)
      && BigInt(filter.toBlock) <= BigInt(Number.MAX_SAFE_INTEGER)
      && BigInt(filter.toBlock) - BigInt(filter.fromBlock) < BigInt(LIMITS.logChunk)
      && Array.isArray(filter.topics) && filter.topics.length === 1 && filter.topics[0] === producer.SUPPLIED_TOPIC;
    const chain = method === "eth_chainId" && Array.isArray(params) && params.length === 0 && timeout === LIMITS.chainTimeoutMs;
    const finalized = method === "eth_getBlockByNumber" && Array.isArray(params) && params.length === 2
      && params[0] === "finalized" && params[1] === false && timeout === LIMITS.finalizedTimeoutMs;
    if (!logs && !chain && !finalized) throw new Error("METHOD_REJECTED");
    return rawCall(handle, method, params, timeout);
  };
}
function validateResult(value) {
  try {
    if (!exactKeys(value, TOP_KEYS) || value.schema !== SCHEMA || value.chainId !== 10 || !STATUSES.has(value.status)
        || typeof value.generatedAt !== "string" || new Date(value.generatedAt).toISOString() !== value.generatedAt
        || ![null, SOURCE_SHA].includes(value.producerSourceSha256)
        || !(value.sharedRpcSha256 === null || typeof value.sharedRpcSha256 === "string" && /^[0-9a-f]{64}$/.test(value.sharedRpcSha256))
        || typeof value.sourceUnchanged !== "boolean" || value.sourceUnchanged && value.producerSourceSha256 !== SOURCE_SHA
        || !exactKeys(value.limits, Object.keys(LIMITS)) || !Object.keys(LIMITS).every((key) => value.limits[key] === LIMITS[key])
        || !exactKeys(value.safety, Object.keys(SAFETY)) || !Object.keys(SAFETY).every((key) => value.safety[key] === SAFETY[key])
        || !count(value.memberCount) || value.memberCount > 2 || !Array.isArray(value.perMember) || value.perMember.length !== value.memberCount
        || !count(value.capableFamilies) || value.capableFamilies > 2 || !exactKeys(value.counts, OUTCOMES)) return false;
    const totals = Object.fromEntries(OUTCOMES.map((key) => [key, 0]));
    let reads = 0, capable = 0, capSeen = false;
    for (let index = 0; index < value.perMember.length; index += 1) {
      const row = value.perMember[index], hasCount = Object.hasOwn(row, "logsCount");
      if (!exactKeys(row, ["ordinal", "stageChain", "stageFinalized", "stageLog", "capable", "reads", "lastWindow", ...(hasCount ? ["logsCount"] : [])])
          || row.ordinal !== index + 1 || !count(row.reads) || row.reads > 3 || typeof row.capable !== "boolean"
          || !["NOT_RUN", "OK", "CHAIN_MISMATCH", "CHAIN_INVALID", "TRANSPORT_FAILURE", "RPC_FAILURE", "NETWORK_CALL_CAP"].includes(row.stageChain)
          || !["NOT_RUN", "OK", "FINALIZED_INVALID", "PREDEPLOYMENT_HEADER", "STALE_HEADER", "FUTURE_HEADER", "TRANSPORT_FAILURE", "RPC_FAILURE", "NETWORK_CALL_CAP"].includes(row.stageFinalized)
          || !["NOT_RUN", "LOG_CAPABLE", "INVALID_LOG_RESPONSE", "TRANSPORT_FAILURE", "RPC_FAILURE", "NETWORK_CALL_CAP"].includes(row.stageLog)) return false;
      if (row.stageChain !== "OK" && (row.stageFinalized !== "NOT_RUN" || row.stageLog !== "NOT_RUN")
          || row.stageFinalized !== "OK" && row.stageLog !== "NOT_RUN") return false;
      const stages = [row.stageChain, row.stageFinalized, row.stageLog];
      const attempted = stages.filter((stage) => stage !== "NOT_RUN" && stage !== "NETWORK_CALL_CAP").length;
      if (row.reads !== attempted || row.stageChain === "OK" && row.stageFinalized === "NOT_RUN"
          || row.stageFinalized === "OK" && row.stageLog === "NOT_RUN" || capSeen && row.reads !== 0) return false;
      if (stages.includes("NETWORK_CALL_CAP")) capSeen = true;
      if (row.stageLog === "NOT_RUN") { if (row.lastWindow !== null) return false; }
      else {
        if (!exactKeys(row.lastWindow, ["fromBlock", "toBlock"]) || !decimal(row.lastWindow.fromBlock) || !decimal(row.lastWindow.toBlock)) return false;
        const from = BigInt(row.lastWindow.fromBlock), to = BigInt(row.lastWindow.toBlock);
        if (from < BigInt(LIMITS.deploymentBlock) || to < from || to > BigInt(Number.MAX_SAFE_INTEGER)
            || to - from >= BigInt(LIMITS.logChunk)) return false;
      }
      if (row.capable !== (row.stageLog === "LOG_CAPABLE") || hasCount !== row.capable || hasCount && !count(row.logsCount)) return false;
      if (row.capable) capable += 1;
      totals[memberOutcome(row)] += 1; reads += row.reads;
    }
    if (reads > LIMITS.maxNetworkCalls || capable !== value.capableFamilies
        || !OUTCOMES.every((key) => count(value.counts[key]) && value.counts[key] === totals[key])) return false;
    if (reads && (value.producerSourceSha256 !== SOURCE_SHA || !value.sharedRpcSha256 || value.memberCount !== 2)) return false;
    if (value.status === "SOURCE_CHANGED") return !value.sourceUnchanged && value.producerSourceSha256 === SOURCE_SHA;
    if (["REFUSED_ARGUMENTS", "INVALID_OPTIONS", "SOURCE_VERSION_MISMATCH", "OUTPUT_SCHEMA_INVALID", "UNEXPECTED"].includes(value.status)) {
      return reads === 0 && value.memberCount === 0 && value.capableFamilies === 0;
    }
    return value.sourceUnchanged && value.status === inferredStatus(value)
      && (value.memberCount === 2 ? value.perMember.every((row) => row.stageChain !== "NOT_RUN") || capSeen : reads === 0);
  } catch (_) { return false; }
}
function validated(result) {
  if (validateResult(result)) return result;
  const refused = baseResult(); refused.status = "OUTPUT_SCHEMA_INVALID"; return refused;
}
function headerOutcome(header, nowSeconds) {
  if (!header) return "FINALIZED_INVALID";
  if (header.number < LIMITS.deploymentBlock) return "PREDEPLOYMENT_HEADER";
  if (BigInt(header.timestamp) < nowSeconds - BigInt(LIMITS.maxFinalizedAgeSeconds)) return "STALE_HEADER";
  if (BigInt(header.timestamp) > nowSeconds + BigInt(LIMITS.maxFutureSkewSeconds)) return "FUTURE_HEADER";
  return "OK";
}
function thrownOutcome(error) {
  return error instanceof PreflightError && error.code === "NETWORK_CALL_CAP" ? "NETWORK_CALL_CAP"
    : isTransportFailure(error) ? "TRANSPORT_FAILURE" : "RPC_FAILURE";
}

async function diagnoseLogCapability(options = {}) {
  const result = baseResult();
  if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => !["candidates", "rpcCall", "inventoryLoader", "now", "readSource"].includes(key))
      || Object.hasOwn(options, "rpcCall") && typeof options.rpcCall !== "function"
      || ["candidates", "inventoryLoader", "now", "readSource"].some((key) => Object.hasOwn(options, key) && typeof options.rpcCall !== "function")
      || Object.hasOwn(options, "candidates") && !Array.isArray(options.candidates)
      || ["inventoryLoader", "now", "readSource"].some((key) => Object.hasOwn(options, key) && typeof options[key] !== "function")) {
    result.status = "INVALID_OPTIONS"; return validated(result);
  }
  const readSource = options.readSource || (() => fs.readFileSync(SOURCE_PATH));
  const matchesSource = () => crypto.createHash("sha256").update(readSource()).digest("hex") === SOURCE_SHA;
  const finish = () => {
    try { result.sourceUnchanged = result.producerSourceSha256 === SOURCE_SHA && matchesSource(); } catch (_) { result.sourceUnchanged = false; }
    if (result.producerSourceSha256 === SOURCE_SHA && !result.sourceUnchanged) result.status = "SOURCE_CHANGED";
    return validated(result);
  };
  try { if (matchesSource()) result.producerSourceSha256 = SOURCE_SHA; } catch (_) { /* No source trust: no inventory or network. */ }
  if (!result.producerSourceSha256) { result.status = "SOURCE_VERSION_MISMATCH"; return validated(result); }
  let nowSeconds, members;
  try {
    result.generatedAt = new Date((options.now || Date.now)()).toISOString();
    nowSeconds = BigInt(Math.floor(Date.parse(result.generatedAt) / 1000));
  } catch (_) { result.status = "INVALID_OPTIONS"; return finish(); }
  try {
    const pool = options.candidates || producer.candidatePool(options.inventoryLoader ? { inventoryLoader: options.inventoryLoader } : {});
    members = []; const families = new Set(), handles = new Set();
    for (const row of pool) {
      const family = reviewedOperatorFamily(row?.operatorFamily);
      if (!family || families.has(family)) continue;
      if (typeof row.handle !== "string" || handles.has(row.handle)) { result.status = "INVALID_OPTIONS"; return finish(); }
      families.add(family); handles.add(row.handle); members.push(row);
      if (members.length === 2) break;
    }
    result.sharedRpcSha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "shared-rpc.js"))).digest("hex");
  } catch (_) { result.status = "UNEXPECTED"; return finish(); }
  result.memberCount = members.length;
  result.perMember = members.map((_, index) => ({ ordinal: index + 1, stageChain: "NOT_RUN", stageFinalized: "NOT_RUN",
    stageLog: "NOT_RUN", capable: false, reads: 0, lastWindow: null }));
  if (members.length < 2) {
    result.counts.NOT_RUN = members.length; result.status = "INSUFFICIENT_FAMILIES"; return finish();
  }
  const ledger = createRpcLedger(createLogTransport(options.rpcCall || sharedRpc.rpcCallStrict), LIMITS.maxNetworkCalls);
  let capped = false;
  for (let index = 0; index < members.length && !capped; index += 1) {
    const member = result.perMember[index];
    const call = async (method, params, timeout) => {
      const before = ledger.networkCalls;
      try { return await ledger.call(members[index].handle, method, params, timeout); }
      finally { member.reads += ledger.networkCalls - before; }
    };
    let stage = "stageChain";
    try {
      const chain = await call("eth_chainId", [], LIMITS.chainTimeoutMs);
      member.stageChain = !quantity(chain) ? "CHAIN_INVALID" : BigInt(chain) !== 10n ? "CHAIN_MISMATCH" : "OK";
      if (member.stageChain === "OK") {
        stage = "stageFinalized";
        const header = normalizeHeader(await call("eth_getBlockByNumber", ["finalized", false], LIMITS.finalizedTimeoutMs));
        member.stageFinalized = headerOutcome(header, nowSeconds);
        if (member.stageFinalized === "OK") {
          stage = "stageLog"; member.lastWindow = windowFor(header.number);
          const logs = await call("eth_getLogs", [{ address: producer.MANAGER,
            fromBlock: ethers.toQuantity(BigInt(member.lastWindow.fromBlock)), toBlock: ethers.toQuantity(BigInt(member.lastWindow.toBlock)),
            topics: [producer.SUPPLIED_TOPIC] }], LIMITS.logsTimeoutMs);
          member.stageLog = Array.isArray(logs) ? "LOG_CAPABLE" : "INVALID_LOG_RESPONSE";
          if (Array.isArray(logs)) { member.logsCount = logs.length; member.capable = true; }
        }
      }
    } catch (error) { member[stage] = thrownOutcome(error); }
    capped = memberOutcome(member) === "NETWORK_CALL_CAP";
  }
  for (const member of result.perMember) {
    result.counts[memberOutcome(member)] += 1;
    if (member.capable) result.capableFamilies += 1;
  }
  result.status = inferredStatus(result); return finish();
}

async function main(argv = process.argv.slice(2), options = {}) {
  let result;
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== "--run") { result = baseResult(); result.status = "REFUSED_ARGUMENTS"; }
  else { try { result = await diagnoseLogCapability(options); } catch (_) { result = baseResult(); result.status = "UNEXPECTED"; } }
  result = validated(result); process.stdout.write(`${JSON.stringify(result)}\n`); return result;
}
if (require.main === module) main().then((result) => {
  if (result.status !== "TWO_FAMILY_LOG_CAPABLE" || !result.sourceUnchanged) process.exitCode = 1;
}).catch(() => { process.exitCode = 1; });
module.exports = Object.freeze({ diagnoseLogCapability, main, validateResult, createLogTransport });
