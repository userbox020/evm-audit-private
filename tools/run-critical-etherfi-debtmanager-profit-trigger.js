#!/usr/bin/env node
"use strict";

// Narrow, read-only DebtManager ratio/flow trigger. RPC inventory contents,
// endpoint identities, raw responses, and event actors remain memory-only.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { loadRpcUrls, rpcCallStrict: sharedRpcCall, PUBLIC_FALLBACKS } = require("./shared-rpc");
const {
  PreflightError, normalizeHeader, stableObservation, createRpcLedger
} = require("./lib/common-finalized-rpc-preflight");
const {
  classifyProvider, providerCapabilityRank, reviewedOperatorFamily, rankBeforeCap,
  createTransportRetryController
} = require("./lib/rpc-provider-reliability");

const CLAIM = "critical/etherfi-ratio-flow-trigger-producer";
const SCHEMA = "etherfi-debtmanager-profit-trigger/v2";
const EVIDENCE_CLASS = "FINALIZED_MULTI_FAMILY_READ_ONLY";
const CHAIN_ID = 10;
const DEPLOYMENT_BLOCK = 149521228;
const RECENT_BLOCKS = 100000;
const LOG_CHUNK = 50000;
const SMALL_LOG_CHUNK = 10000;
const MAX_CANDIDATES = 44;
const INVENTORY_SELECTION_LIMIT = 96;
const REQUIRED_FAMILIES = 2;
const MAX_NETWORK_CALLS = 80;
const MAX_FINALIZED_AGE_SECONDS = 86400;
const MAX_FUTURE_SKEW_SECONDS = 300;
const WORKSPACE = path.resolve(__dirname, "..");
const OUTPUT = path.join(WORKSPACE, "reports", "monitor", "etherfi-debtmanager-profit-trigger.json");

const MANAGER = "0x0078C5a459132e279056B2371fE8A8eC973A9553";
const EIP1967 = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const HISTORICAL = Object.freeze({
  implementation: "0x0392347936B84Fd2d9De67F178f1D8e0bFc14a19",
  proxyRuntimeHash: "0xe428fca70a96823c60ffaa430edc8cc501377a4709bdb3a070d024d616d81ff5",
  implementationRuntimeHash: "0xdf7eab5a9862bab8b11aef543878afc87f1abbecd61dd4ccd6c4e61a44055fda"
});
const CURRENT_SOURCE_BOUND = Object.freeze({
  // Exact runtime reconstruction: reports/critical-etherfi-debtmanager-upgrade-audit-20261018.md.
  // Prior source-bound core: 0x234305C478B584D4d92293D19084a2e2583F994f
  // (runtime 0x210d88fca0036c2ae18d3879ea39d0f0b4d09a4e00eba8519b33926520720a1f).
  implementation: "0xec22154811cd6510f4443438e0dbd04acfb908a1",
  proxyRuntimeHash: "0xe428fca70a96823c60ffaa430edc8cc501377a4709bdb3a070d024d616d81ff5",
  implementationRuntimeHash: "0x146529ea74e9c9cd6d84790188ae52b4ced8877bb92fd74396ffa9df957e60e9"
});
const TOKENS = Object.freeze([
  Object.freeze({ name: "EURC", address: "0xDCB612005417Dc906fF72c87DF732e5a90D49e11", decimals: 6 }),
  Object.freeze({ name: "USDC", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6 })
]);

const manager = new ethers.Interface([
  "function paused() view returns(bool)",
  "function borrowTokenConfig(address) view returns(uint256,uint256,uint256,uint64,uint64,uint128)",
  "function totalSupplies(address) view returns(uint256)"
]);
const token = new ethers.Interface([
  "function balanceOf(address) view returns(uint256)",
  "function decimals() view returns(uint8)"
]);
const SUPPLIED_TOPIC = ethers.id("Supplied(address,address,address,uint256)").toLowerCase();
const ZERO_ADDRESS = ethers.ZeroAddress;
const ZERO_HASH = `0x${"0".repeat(64)}`;
const TOP_KEYS = Object.freeze(["schema", "generatedAt", "chainId", "evidenceClass", "pin", "runtime", "paused", "pools", "trigger", "economics", "gates", "diagnostics", "safety"]);
const PIN_KEYS = Object.freeze(["number", "hash", "timestamp", "finalized", "headerFamilies", "stateFamilies"]);
const RUNTIME_KEYS = Object.freeze(["implementation", "proxyRuntimeHash", "implementationRuntimeHash", "changedFromHistorical", "exactCurrentSourceBound"]);
const POOL_KEYS = Object.freeze(["token", "decimals", "assetsRaw", "sharesRaw", "liquidRaw", "minSharesRaw", "zeroShareMaxRaw", "recentSupplyEventCount", "recentNonDustSupply", "recentWindowFrom", "recentWindowTo"]);
const TRIGGER_KEYS = Object.freeze(["status", "positive", "reason"]);
const ECONOMICS_KEYS = Object.freeze(["status", "capitalRaw", "grossCeilingRaw", "gasRaw", "l1FeeRaw", "carryRaw", "acquisitionUnwindRaw", "competitionRaw", "uncertaintyRaw", "conservativeNetRaw", "netBps", "capacityRaw"]);
const GATE_KEYS = Object.freeze(["sourceCurrent", "runtimeBound", "nonDustFlow", "feasibleCapital", "liquidExit", "economicsComplete", "conservativeNetPositive", "keylessForkJustified"]);
const DIAGNOSTIC_KEYS = Object.freeze(["candidatesConsidered", "qualificationAttempts", "chainMatches", "finalizedQualified", "pinConsensusFamilies", "stateAttempts", "stateSuccesses", "stateConsensusFamilies", "stateDistinctGroups", "flowAttempts", "flowSuccesses", "flowConsensusFamilies", "flowDistinctGroups", "failurePhase", "failureCode"]);
const SAFETY_KEYS = Object.freeze(["inventoryReadInMemoryOnly", "networkCalls", "transportFailures", "automaticRetries", "retryExhaustions", "transactions", "signing", "broadcast"]);
const FAILURE_PHASES = new Set(["NONE", "QUALIFICATION", "PIN_CONSENSUS", "STATE", "FLOW"]);
const FAILURE_CODES = new Set(["NONE", "TWO_FAMILIES_UNAVAILABLE", "PIN_CONSENSUS_UNAVAILABLE", "STATE_CONSENSUS_UNAVAILABLE", "FLOW_CONSENSUS_UNAVAILABLE", "NETWORK_CALL_CAP", "UNEXPECTED"]);
const STATUS_REASON = Object.freeze({
  INCOMPLETE: "EVIDENCE_INCOMPLETE",
  BLOCKED_PAUSED: "MANAGER_PAUSED",
  BLOCKED_RUNTIME_UNBOUND: "CURRENT_RUNTIME_NOT_EXACT_SOURCE_BOUND",
  BLOCKED_NO_FLOW: "NO_RECENT_SUPPLY_EVENTS",
  BLOCKED_DUST_ONLY: "RECENT_SUPPLY_DUST_ONLY",
  POSITIVE_FLOW: "RECENT_NON_DUST_SUPPLY_OBSERVED"
});

class CaptureError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function fail(code) { throw new CaptureError(code); }
function lower(value) { return String(value).toLowerCase(); }
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function unsigned(value) { return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value); }
function signed(value) { return typeof value === "string" && /^(?:0|-?[1-9][0-9]*)$/.test(value); }
function nullableUnsigned(value) { return value === null || unsigned(value); }
function nullableSigned(value) { return value === null || signed(value); }
function hash32(value) { return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value); }
function address(value) { try { return ethers.getAddress(value) === value; } catch (_) { return false; } }
function gate(value) { return value === "PASS" || value === "FAIL" || value === "UNKNOWN"; }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function runtimeMatchesBaseline(runtime, baseline) {
  return lower(runtime.implementation) === lower(baseline.implementation)
    && lower(runtime.proxyRuntimeHash) === lower(baseline.proxyRuntimeHash)
    && lower(runtime.implementationRuntimeHash) === lower(baseline.implementationRuntimeHash);
}

function zeroShareMax(assetsRaw, sharesRaw) {
  const assets = BigInt(assetsRaw), shares = BigInt(sharesRaw);
  if (shares === 0n) return null;
  return ((assets + shares - 1n) / shares - 1n).toString();
}

function emptyEconomics(status = "NOT_RUN") {
  return {
    status, capitalRaw: null, grossCeilingRaw: null, gasRaw: null, l1FeeRaw: null,
    carryRaw: null, acquisitionUnwindRaw: null, competitionRaw: null, uncertaintyRaw: null,
    conservativeNetRaw: null, netBps: null, capacityRaw: null
  };
}

function emptyPool(row) {
  return {
    token: row.address, decimals: row.decimals, assetsRaw: "0", sharesRaw: "0", liquidRaw: "0",
    minSharesRaw: "0", zeroShareMaxRaw: null, recentSupplyEventCount: 0,
    recentNonDustSupply: false, recentWindowFrom: "0", recentWindowTo: "0"
  };
}

function emptyDiagnostics() {
  return {
    candidatesConsidered: 0, qualificationAttempts: 0, chainMatches: 0, finalizedQualified: 0,
    pinConsensusFamilies: 0, stateAttempts: 0, stateSuccesses: 0, stateConsensusFamilies: 0,
    stateDistinctGroups: 0, flowAttempts: 0, flowSuccesses: 0, flowConsensusFamilies: 0,
    flowDistinctGroups: 0, failurePhase: "NONE", failureCode: "NONE"
  };
}

function baseArtifact(now = Date.now) {
  return {
    schema: SCHEMA,
    generatedAt: new Date(now()).toISOString(),
    chainId: CHAIN_ID,
    evidenceClass: EVIDENCE_CLASS,
    pin: { number: "0", hash: ZERO_HASH, timestamp: "0", finalized: true, headerFamilies: 0, stateFamilies: 0 },
    runtime: { implementation: ZERO_ADDRESS, proxyRuntimeHash: ZERO_HASH, implementationRuntimeHash: ZERO_HASH, changedFromHistorical: false, exactCurrentSourceBound: false },
    paused: false,
    pools: TOKENS.map(emptyPool),
    trigger: { status: "INCOMPLETE", positive: false, reason: STATUS_REASON.INCOMPLETE },
    economics: emptyEconomics(),
    gates: {
      sourceCurrent: "UNKNOWN", runtimeBound: "UNKNOWN", nonDustFlow: "UNKNOWN", feasibleCapital: "UNKNOWN",
      liquidExit: "UNKNOWN", economicsComplete: "UNKNOWN", conservativeNetPositive: "UNKNOWN", keylessForkJustified: "UNKNOWN"
    },
    diagnostics: emptyDiagnostics(),
    safety: { inventoryReadInMemoryOnly: true, networkCalls: 0, transportFailures: 0, automaticRetries: 0, retryExhaustions: 0, transactions: 0, signing: false, broadcast: false }
  };
}

function validateArtifact(value) {
  try {
    if (!exactKeys(value, TOP_KEYS) || value.schema !== SCHEMA || value.evidenceClass !== EVIDENCE_CLASS
        || value.chainId !== CHAIN_ID || typeof value.generatedAt !== "string"
        || new Date(value.generatedAt).toISOString() !== value.generatedAt) return false;
    const pin = value.pin;
    if (!exactKeys(pin, PIN_KEYS) || !unsigned(pin.number) || !hash32(pin.hash) || !unsigned(pin.timestamp)
        || pin.finalized !== true || !Number.isInteger(pin.headerFamilies) || pin.headerFamilies < 0
        || !Number.isInteger(pin.stateFamilies) || pin.stateFamilies < 0 || pin.stateFamilies > pin.headerFamilies) return false;
    const runtime = value.runtime;
    if (!exactKeys(runtime, RUNTIME_KEYS) || !address(runtime.implementation) || !hash32(runtime.proxyRuntimeHash)
        || !hash32(runtime.implementationRuntimeHash) || typeof runtime.changedFromHistorical !== "boolean"
        || typeof runtime.exactCurrentSourceBound !== "boolean") return false;
    if (typeof value.paused !== "boolean" || !Array.isArray(value.pools) || value.pools.length !== 2) return false;
    for (let index = 0; index < value.pools.length; index += 1) {
      const pool = value.pools[index], expected = TOKENS[index];
      if (!exactKeys(pool, POOL_KEYS) || pool.token !== expected.address || !Number.isInteger(pool.decimals) || pool.decimals < 0 || pool.decimals > 255
          || !unsigned(pool.assetsRaw) || !unsigned(pool.sharesRaw) || !unsigned(pool.liquidRaw) || !unsigned(pool.minSharesRaw)
          || !nullableSigned(pool.zeroShareMaxRaw) || !Number.isInteger(pool.recentSupplyEventCount) || pool.recentSupplyEventCount < 0
          || typeof pool.recentNonDustSupply !== "boolean" || !unsigned(pool.recentWindowFrom) || !unsigned(pool.recentWindowTo)) return false;
      if (pool.zeroShareMaxRaw !== zeroShareMax(pool.assetsRaw, pool.sharesRaw)) return false;
      if (pool.recentNonDustSupply && pool.recentSupplyEventCount === 0) return false;
    }
    const trigger = value.trigger;
    if (!exactKeys(trigger, TRIGGER_KEYS) || !Object.hasOwn(STATUS_REASON, trigger.status)
        || trigger.positive !== (trigger.status === "POSITIVE_FLOW") || trigger.reason !== STATUS_REASON[trigger.status]) return false;
    if (trigger.status !== "INCOMPLETE" && (pin.headerFamilies < 2 || pin.stateFamilies < 2
        || value.diagnostics.flowConsensusFamilies < 2)) return false;
    if (trigger.status === "BLOCKED_PAUSED" && value.paused !== true) return false;
    if (trigger.status === "BLOCKED_RUNTIME_UNBOUND" && (value.paused || runtime.exactCurrentSourceBound)) return false;
    const eventCount = value.pools.reduce((sum, pool) => sum + pool.recentSupplyEventCount, 0);
    const nonDust = value.pools.some((pool) => pool.recentNonDustSupply);
    if (trigger.status === "BLOCKED_NO_FLOW" && eventCount !== 0) return false;
    if (trigger.status === "BLOCKED_DUST_ONLY" && (eventCount === 0 || nonDust)) return false;
    if (trigger.status === "POSITIVE_FLOW" && !nonDust) return false;
    const economics = value.economics;
    if (!exactKeys(economics, ECONOMICS_KEYS) || !["NOT_RUN", "INCOMPLETE", "NEGATIVE", "TRIGGER_POSITIVE_GROSS_ONLY"].includes(economics.status)
        || ![economics.capitalRaw, economics.grossCeilingRaw, economics.gasRaw, economics.l1FeeRaw, economics.carryRaw,
          economics.acquisitionUnwindRaw, economics.competitionRaw, economics.uncertaintyRaw, economics.capacityRaw].every(nullableUnsigned)
        || !nullableSigned(economics.conservativeNetRaw) || !nullableSigned(economics.netBps)) return false;
    if (trigger.status === "POSITIVE_FLOW" && economics.status !== "TRIGGER_POSITIVE_GROSS_ONLY") return false;
    if (trigger.status !== "POSITIVE_FLOW" && !["NOT_RUN", "INCOMPLETE", "NEGATIVE"].includes(economics.status)) return false;
    if (!exactKeys(value.gates, GATE_KEYS) || !Object.values(value.gates).every(gate)) return false;
    const diagnostics = value.diagnostics;
    if (!exactKeys(diagnostics, DIAGNOSTIC_KEYS)
        || !DIAGNOSTIC_KEYS.slice(0, 13).every((key) => Number.isInteger(diagnostics[key]) && diagnostics[key] >= 0)
        || diagnostics.candidatesConsidered > MAX_CANDIDATES
        || diagnostics.qualificationAttempts > diagnostics.candidatesConsidered
        || diagnostics.chainMatches > diagnostics.qualificationAttempts
        || diagnostics.finalizedQualified > diagnostics.chainMatches
        || diagnostics.pinConsensusFamilies > diagnostics.finalizedQualified
        || diagnostics.flowAttempts > diagnostics.finalizedQualified
        || diagnostics.flowSuccesses > diagnostics.flowAttempts
        || diagnostics.stateAttempts > diagnostics.flowSuccesses
        || diagnostics.stateSuccesses > diagnostics.stateAttempts
        || diagnostics.stateConsensusFamilies > diagnostics.stateSuccesses
        || diagnostics.stateDistinctGroups > diagnostics.stateSuccesses
        || diagnostics.flowConsensusFamilies > diagnostics.stateConsensusFamilies
        || diagnostics.flowDistinctGroups > diagnostics.stateConsensusFamilies
        || !FAILURE_PHASES.has(diagnostics.failurePhase) || !FAILURE_CODES.has(diagnostics.failureCode)
        || (diagnostics.failurePhase === "NONE") !== (diagnostics.failureCode === "NONE")
        || (trigger.status === "INCOMPLETE") !== (diagnostics.failurePhase !== "NONE")) return false;
    const safety = value.safety;
    if (!exactKeys(safety, SAFETY_KEYS) || safety.inventoryReadInMemoryOnly !== true
        || !Number.isInteger(safety.networkCalls) || safety.networkCalls < 0 || safety.networkCalls > MAX_NETWORK_CALLS
        || ![safety.transportFailures, safety.automaticRetries, safety.retryExhaustions].every((count) => Number.isInteger(count) && count >= 0)
        || safety.transportFailures > safety.networkCalls || safety.automaticRetries > safety.transportFailures
        || safety.automaticRetries > MAX_CANDIDATES || safety.retryExhaustions > safety.transportFailures
        || safety.transactions !== 0 || safety.signing !== false || safety.broadcast !== false) return false;
    const serialized = JSON.stringify(value);
    return !/(?:https?|wss?):\/\/|authorization\s*:|bearer\s|api[_-]?key|rpc_endpoints|\.env\b|transactionHash|\b(?:sender|user|actor)\b/i.test(serialized);
  } catch (_) { return false; }
}

function canonicalProviderFamily(url) {
  const classified = classifyProvider(url);
  return classified && classified.quorumReviewed ? classified.operatorFamily : null;
}

function currentFinalizedTransport(rawCall, nowMs) {
  const nowSeconds = BigInt(Math.floor(nowMs / 1000));
  return async (handle, method, params, timeout) => {
    const raw = await rawCall(handle, method, params, timeout);
    if (method !== "eth_getBlockByNumber" || params[0] !== "finalized") return raw;
    const finalized = normalizeHeader(raw);
    if (!finalized || finalized.number < DEPLOYMENT_BLOCK
        || BigInt(finalized.timestamp) < nowSeconds - BigInt(MAX_FINALIZED_AGE_SECONDS)
        || BigInt(finalized.timestamp) > nowSeconds + BigInt(MAX_FUTURE_SKEW_SECONDS)) return null;
    return raw;
  };
}

function optimismHostnameHint(value) {
  try {
    const host = new URL(typeof value === "string" ? value : value.handle).hostname.toLowerCase();
    return host.split(".").some((label) => /^(?:optimism|optimistic|optimism-mainnet|op-mainnet|opt-mainnet)$/.test(label));
  } catch (_) { return false; }
}

function optimismInventoryHint(value) {
  try {
    const url = new URL(value);
    return optimismHostnameHint(value)
      || url.hostname.toLowerCase().split(".").some((label) => /^(?:op|optimism-rpc)$/.test(label))
      || ["rpc.ankr.com", "1rpc.io", "0xrpc.io"].includes(url.hostname.toLowerCase())
        && /^\/(?:op|optimism)(?:\/|$)/i.test(url.pathname);
  } catch (_) { return false; }
}

function candidatePool(options) {
  const supplied = options.candidates || options.candidateUrls;
  const defaultInventory = !supplied;
  // Scope the real inventory before its shared per-family cap can discard OP
  // path-based endpoints in favour of unrelated chains. Test loaders stay exact.
  const inventoryLoader = typeof options.inventoryLoader === "function" ? options.inventoryLoader
    : (limits) => loadRpcUrls({ ...limits, candidateFilter: optimismInventoryHint });
  let values = supplied;
  if (!values) {
    const inventory = inventoryLoader({ maxCandidates: INVENTORY_SELECTION_LIMIT });
    const hinted = inventory.filter(optimismHostnameHint);
    const remaining = inventory.filter((value) => !optimismHostnameHint(value));
    values = [PUBLIC_FALLBACKS[CHAIN_ID], ...hinted, ...remaining];
  }
  const rows = [], seenHandles = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const source = value && typeof value === "object" && Object.hasOwn(value, "handle") ? value : { handle: value };
    const handle = source.handle;
    if (typeof handle !== "string" || !/^https?:\/\//i.test(handle) || seenHandles.has(handle)) continue;
    seenHandles.add(handle);
    const classified = classifyProvider(handle);
    rows.push({
      handle,
      operatorFamily: reviewedOperatorFamily(source.operatorFamily) || (classified && classified.quorumReviewed ? classified.operatorFamily : null),
      inventoryOrder: Number.isSafeInteger(source.inventoryOrder) ? source.inventoryOrder : index,
      capabilityRank: Number.isSafeInteger(source.capabilityRank) ? source.capabilityRank : providerCapabilityRank(handle)
    });
  }
  const fallback = PUBLIC_FALLBACKS[CHAIN_ID];
  const ranked = rankBeforeCap(rows, Math.max(MAX_CANDIDATES, rows.length), (left, right) => {
    const fixed = defaultInventory ? Number(right.handle === fallback) - Number(left.handle === fallback) : 0;
    if (fixed) return fixed;
    const hinted = defaultInventory ? Number(optimismHostnameHint(right)) - Number(optimismHostnameHint(left)) : 0;
    if (hinted) return hinted;
    const reviewed = Number(Boolean(right.operatorFamily)) - Number(Boolean(left.operatorFamily));
    return reviewed || left.capabilityRank - right.capabilityRank || left.inventoryOrder - right.inventoryOrder;
  });
  const counts = new Map(), selected = [];
  for (const row of ranked) {
    if (row.operatorFamily) {
      const count = counts.get(row.operatorFamily) || 0;
      if (count >= 2) continue;
      counts.set(row.operatorFamily, count + 1);
    }
    selected.push(row);
    if (selected.length >= MAX_CANDIDATES) break;
  }
  return selected;
}

async function contractCall(reader, to, iface, method, args) {
  const raw = await reader.call({ to, data: iface.encodeFunctionData(method, args) });
  if (typeof raw !== "string") fail("CALL_FAILED");
  return iface.decodeFunctionResult(method, raw);
}

async function readState(reader) {
  const proxyCode = await reader.getCode(MANAGER);
  const implWord = await reader.getStorageAt(MANAGER, EIP1967);
  if (typeof proxyCode !== "string" || !/^0x[0-9a-f]*$/i.test(proxyCode)
      || typeof implWord !== "string" || !/^0x[0-9a-f]{64}$/i.test(implWord)) fail("RUNTIME_READ_FAILED");
  const implementation = ethers.getAddress(`0x${implWord.slice(-40)}`);
  if (implementation === ZERO_ADDRESS) fail("IMPLEMENTATION_ZERO");
  const implementationCode = await reader.getCode(implementation);
  if (typeof implementationCode !== "string" || !/^0x[0-9a-f]*$/i.test(implementationCode)) fail("RUNTIME_READ_FAILED");
  const paused = Boolean((await contractCall(reader, MANAGER, manager, "paused", []))[0]);
  const pools = [];
  for (const tokenRow of TOKENS) {
    const cfg = await contractCall(reader, MANAGER, manager, "borrowTokenConfig", [tokenRow.address]);
    const assets = BigInt((await contractCall(reader, MANAGER, manager, "totalSupplies", [tokenRow.address]))[0]);
    const liquid = BigInt((await contractCall(reader, tokenRow.address, token, "balanceOf", [MANAGER]))[0]);
    const decimals = Number((await contractCall(reader, tokenRow.address, token, "decimals", []))[0]);
    const shares = BigInt(cfg[2]), minShares = BigInt(cfg[5]);
    pools.push({
      token: tokenRow.address, decimals, assetsRaw: assets.toString(), sharesRaw: shares.toString(),
      liquidRaw: liquid.toString(), minSharesRaw: minShares.toString(), zeroShareMaxRaw: zeroShareMax(assets, shares)
    });
  }
  return {
    runtime: {
      implementation,
      proxyRuntimeHash: ethers.keccak256(proxyCode),
      implementationRuntimeHash: ethers.keccak256(implementationCode)
    },
    paused,
    pools
  };
}

function decodeSupplyLogs(rawLogs, tokenRow, from, to) {
  if (!Array.isArray(rawLogs)) fail("LOG_SCHEMA");
  const tokenTopic = lower(ethers.zeroPadValue(tokenRow.address, 32));
  return rawLogs.map((log) => {
    if (!log || lower(log.address) !== lower(MANAGER) || !Array.isArray(log.topics) || log.topics.length !== 4
        || lower(log.topics[0]) !== SUPPLIED_TOPIC || lower(log.topics[3]) !== tokenTopic
        || typeof log.data !== "string" || !/^0x[0-9a-f]{64}$/i.test(log.data)) fail("LOG_BINDING");
    const blockNumber = Number(BigInt(log.blockNumber));
    const transactionIndex = Number(BigInt(log.transactionIndex));
    const logIndex = Number(BigInt(log.logIndex));
    if (![blockNumber, transactionIndex, logIndex].every(Number.isSafeInteger) || blockNumber < from || blockNumber > to) fail("LOG_BINDING");
    return { blockNumber, transactionIndex, logIndex, amountRaw: BigInt(log.data).toString() };
  }).sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
}

async function readRecentFlow(row, pin, state, rpc) {
  const from = Math.max(DEPLOYMENT_BLOCK, pin.number - RECENT_BLOCKS + 1), to = pin.number;
  const chunk = row.logChunk || LOG_CHUNK;
  const pools = [];
  for (let index = 0; index < TOKENS.length; index += 1) {
    const tokenRow = TOKENS[index], events = [];
    for (let cursor = from; cursor <= to; cursor += chunk) {
      const end = Math.min(to, cursor + chunk - 1);
      const result = await rpc.call(row.handle, "eth_getLogs", [{
        address: MANAGER, fromBlock: ethers.toQuantity(cursor), toBlock: ethers.toQuantity(end),
        topics: [SUPPLIED_TOPIC, null, null, ethers.zeroPadValue(tokenRow.address, 32)]
      }], 15000);
      events.push(...decodeSupplyLogs(result, tokenRow, cursor, end));
    }
    const ceiling = state.pools[index].zeroShareMaxRaw;
    const nonDust = events.some((event) => ceiling === null ? BigInt(event.amountRaw) > 0n : BigInt(event.amountRaw) > BigInt(ceiling));
    pools.push({ eventCount: events.length, nonDust, events });
  }
  return { from, to, pools };
}

function flowConsensus(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = stable(row.flow);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length)[0] || [];
}

function distinctCandidateFamilies(rows) {
  return new Set(rows.map((row) => row.candidate.operatorFamily).filter(Boolean)).size;
}

function pinnedStateReader(candidate, pin, rpc) {
  const canonical = Object.freeze({ blockHash: pin.hash, requireCanonical: true });
  let calls = 0;
  async function guarded(method, params, timeout) {
    if (calls >= 12) throw new PreflightError("NETWORK_CALL_CAP");
    calls += 1;
    return rpc.call(candidate.handle, method, params, timeout);
  }
  return Object.freeze({
    async getCode(target) {
      const value = await guarded("eth_getCode", [target, canonical], 8000);
      if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) throw new PreflightError("PROBE_CAPABILITY_UNAVAILABLE");
      return value;
    },
    async getStorageAt(target, slot) {
      const value = await guarded("eth_getStorageAt", [target, slot, canonical], 8000);
      if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) throw new PreflightError("PROBE_CAPABILITY_UNAVAILABLE");
      return value;
    },
    async call(transaction) {
      const value = await guarded("eth_call", [transaction, canonical], 10000);
      if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) throw new PreflightError("PROBE_CAPABILITY_UNAVAILABLE");
      return value;
    }
  });
}

async function qualifyLogFirst(candidates, rpc, preferredFamilies, diagnostics) {
  const authoritative = new Set(candidates.map((row) => row.operatorFamily).filter(Boolean));
  if (authoritative.size < REQUIRED_FAMILIES) throw new PreflightError("TWO_FAMILIES_UNAVAILABLE", diagnostics);
  const preflightCeiling = rpc.maxNetworkCalls - 15;
  const probeReserve = preferredFamilies * 13;
  const remaining = () => preflightCeiling - rpc.networkCalls;
  const checked = async (candidate, method, params, timeout) => {
    if (remaining() <= 0) throw new PreflightError("NETWORK_CALL_CAP", diagnostics);
    return rpc.call(candidate.handle, method, params, timeout);
  };
  const qualified = [], exactCache = new Map(), probed = new Set(), logCapable = [], logFamilies = new Set(), pinFamilies = new Set();
  const failedLogFamilies = new Set();
  let pin = null;
  async function exactAt(row, number) {
    const key = `${row.candidate.handle}:${number}`;
    if (exactCache.has(key)) return exactCache.get(key);
    if (remaining() <= probeReserve) throw new PreflightError("NETWORK_CALL_CAP", diagnostics);
    let value = null;
    try {
      const normalized = normalizeHeader(await checked(row.candidate, "eth_getBlockByNumber", [ethers.toQuantity(number), false], 6000));
      if (normalized && normalized.number === number) value = normalized;
    } catch (error) {
      if (error instanceof PreflightError && error.code === "NETWORK_CALL_CAP") throw error;
    }
    exactCache.set(key, value); return value;
  }
  async function establishPin() {
    const heights = [...new Set(qualified.map((row) => row.finalized.number))].sort((a, b) => b - a);
    for (const number of heights) {
      const eligible = qualified.filter((row) => row.finalized.number >= number); const groups = new Map();
      if (distinctCandidateFamilies(eligible) < REQUIRED_FAMILIES) continue;
      for (const row of eligible) {
        const header = await exactAt(row, number); if (!header) continue;
        const key = stableObservation(header); if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ candidate: row.candidate, header });
      }
      diagnostics.pinConsensusFamilies = Math.max(diagnostics.pinConsensusFamilies, 0,
        ...[...groups.values()].map(distinctCandidateFamilies));
      const matching = [...groups.values()].filter((group) => distinctCandidateFamilies(group) >= REQUIRED_FAMILIES)
        .sort((left, right) => distinctCandidateFamilies(right) - distinctCandidateFamilies(left));
      if (matching.length) return { pin: matching[0][0].header, rows: matching[0] };
    }
    return null;
  }
  async function probeRows(rows) {
    for (const row of rows) {
      if (probed.has(row.candidate.handle) || logFamilies.has(row.candidate.operatorFamily)) continue;
      probed.add(row.candidate.handle); diagnostics.flowAttempts += 1;
      for (const logChunk of [LOG_CHUNK, SMALL_LOG_CHUNK]) {
        try {
          const from = Math.max(DEPLOYMENT_BLOCK, pin.number - RECENT_BLOCKS + 1);
          const to = Math.min(pin.number, from + logChunk - 1);
          const logs = await checked(row.candidate, "eth_getLogs", [{ address: MANAGER,
            fromBlock: ethers.toQuantity(from), toBlock: ethers.toQuantity(to), topics: [SUPPLIED_TOPIC] }], 10000);
          if (!Array.isArray(logs)) continue;
          logCapable.push({ candidate: { ...row.candidate, logChunk }, header: row.header });
          logFamilies.add(row.candidate.operatorFamily); diagnostics.flowSuccesses += 1;
          break;
        } catch (error) {
          if (error instanceof PreflightError && error.code === "NETWORK_CALL_CAP") throw error;
        }
      }
      if (!logFamilies.has(row.candidate.operatorFamily)) failedLogFamilies.add(row.candidate.operatorFamily);
      if (logFamilies.size >= preferredFamilies) return;
    }
  }
  const attemptedFamilies = new Set(), attemptedHandles = new Set();
  // Revisit alternatives skipped before the common pin exposed a failed probe.
  for (const candidate of [...candidates, ...candidates]) {
    if (!candidate.operatorFamily || logFamilies.has(candidate.operatorFamily) || logFamilies.size >= preferredFamilies) continue;
    if (attemptedHandles.has(candidate.handle)) continue;
    // A log capability rejection may try the retained endpoint, but a wrong-chain
    // reply still cannot rotate into authority for that family.
    if (attemptedFamilies.has(candidate.operatorFamily) && !failedLogFamilies.has(candidate.operatorFamily)) continue;
    attemptedFamilies.add(candidate.operatorFamily);
    attemptedHandles.add(candidate.handle);
    if (remaining() <= probeReserve) throw new PreflightError("NETWORK_CALL_CAP", diagnostics, pin ? { pin } : {});
    diagnostics.qualificationAttempts += 1;
    let chain;
    try { chain = await checked(candidate, "eth_chainId", [], 3500); } catch (error) {
      if (error instanceof PreflightError && error.code === "NETWORK_CALL_CAP") throw error; continue;
    }
    try { if (BigInt(chain) !== BigInt(CHAIN_ID)) continue; } catch (_) { continue; }
    diagnostics.chainMatches += 1;
    let finalized;
    try { finalized = normalizeHeader(await checked(candidate, "eth_getBlockByNumber", ["finalized", false], 6000)); } catch (error) {
      if (error instanceof PreflightError && error.code === "NETWORK_CALL_CAP") throw error; continue;
    }
    if (!finalized) continue;
    diagnostics.finalizedQualified += 1; const qualifiedRow = { candidate, finalized }; qualified.push(qualifiedRow);
    if (!pin) {
      if (distinctCandidateFamilies(qualified) < REQUIRED_FAMILIES) continue;
      const established = await establishPin(); if (!established) continue;
      pin = established.pin;
      for (const row of established.rows) pinFamilies.add(row.candidate.operatorFamily);
      diagnostics.pinConsensusFamilies = pinFamilies.size;
      await probeRows(established.rows);
    } else if (finalized.number >= pin.number) {
      const header = await exactAt(qualifiedRow, pin.number);
      if (header && stableObservation(header) === stableObservation(pin)) {
        pinFamilies.add(candidate.operatorFamily); diagnostics.pinConsensusFamilies = pinFamilies.size;
        await probeRows([{ candidate, header }]);
      }
    }
  }
  if (!pin) {
    const code = new Set(qualified.map((row) => row.candidate.operatorFamily)).size < REQUIRED_FAMILIES
      ? "TWO_FAMILIES_UNAVAILABLE" : "PIN_CONSENSUS_UNAVAILABLE";
    throw new PreflightError(code, diagnostics);
  }
  if (logFamilies.size < REQUIRED_FAMILIES) {
    const error = new CaptureError("FLOW_CONSENSUS_UNAVAILABLE"); error.pin = pin; throw error;
  }
  return { pin, selected: logCapable.slice(0, preferredFamilies) };
}

function applyGates(artifact, complete) {
  const status = artifact.trigger.status;
  artifact.gates.sourceCurrent = artifact.runtime.exactCurrentSourceBound ? "PASS" : complete ? "UNKNOWN" : "UNKNOWN";
  artifact.gates.runtimeBound = artifact.runtime.exactCurrentSourceBound ? "PASS" : complete ? "FAIL" : "UNKNOWN";
  artifact.gates.nonDustFlow = !complete ? "UNKNOWN" : artifact.pools.some((pool) => pool.recentNonDustSupply) ? "PASS" : "FAIL";
  artifact.gates.feasibleCapital = "UNKNOWN";
  artifact.gates.liquidExit = "UNKNOWN";
  artifact.gates.economicsComplete = complete ? "FAIL" : "UNKNOWN";
  artifact.gates.conservativeNetPositive = artifact.economics.status === "NEGATIVE" ? "FAIL" : "UNKNOWN";
  artifact.gates.keylessForkJustified = status === "POSITIVE_FLOW" ? "PASS"
    : status === "INCOMPLETE" || status === "BLOCKED_RUNTIME_UNBOUND" ? "UNKNOWN" : "FAIL";
}

async function runTrigger(options = {}) {
  const now = options.now || Date.now;
  const artifact = baseArtifact(now);
  const candidates = candidatePool(options);
  const familyByHandle = new Map(candidates.map((candidate) => [candidate.handle, candidate.operatorFamily]));
  const alternativesByFamily = new Map();
  for (const candidate of candidates) {
    if (!candidate.operatorFamily) continue;
    if (!alternativesByFamily.has(candidate.operatorFamily)) alternativesByFamily.set(candidate.operatorFamily, []);
    alternativesByFamily.get(candidate.operatorFamily).push(candidate.handle);
  }
  const activeByFamily = new Map();
  const ledger = createRpcLedger(currentFinalizedTransport(
    options.rpcCall || sharedRpcCall, Date.parse(artifact.generatedAt)
  ), MAX_NETWORK_CALLS);
  const retry = createTransportRetryController({ familyOf: (candidate) => candidate.operatorFamily });
  const rpc = Object.freeze({
    get networkCalls() { return ledger.networkCalls; },
    get maxNetworkCalls() { return ledger.maxNetworkCalls; },
    call(handle, method, params, timeout) {
      const operatorFamily = familyByHandle.get(handle) || null;
      const active = method === "eth_chainId" ? handle : activeByFamily.get(operatorFamily) || handle;
      return retry.run({ operatorFamily }, async (_candidate, retryIndex) => {
        const alternatives = alternativesByFamily.get(operatorFamily) || [active];
        const selected = retryIndex === 0 ? active : alternatives.find((candidate) => candidate !== active) || active;
        const value = await ledger.call(selected, method, params, timeout);
        if (retryIndex > 0 || method === "eth_chainId") activeByFamily.set(operatorFamily, selected);
        return value;
      });
    }
  });
  const historical = options.historical || HISTORICAL;
  let complete = false;
  let phase = "QUALIFICATION";
  try {
    const qualificationFamilyTarget = options.qualificationFamilyTarget === 3 ? 3 : REQUIRED_FAMILIES;
    artifact.diagnostics.candidatesConsidered = candidates.length;
    const preflight = await qualifyLogFirst(candidates, rpc, qualificationFamilyTarget, artifact.diagnostics);
    const pin = preflight.pin;
    artifact.pin = {
      number: String(pin.number), hash: pin.hash, timestamp: String(pin.timestamp), finalized: true,
      headerFamilies: artifact.diagnostics.pinConsensusFamilies, stateFamilies: 0
    };
    phase = "STATE";
    const observedStates = [], stateGroups = new Map();
    artifact.diagnostics.stateAttempts = preflight.selected.length;
    for (const row of preflight.selected) {
      try {
        const observation = await readState(pinnedStateReader(row.candidate, pin, rpc));
        const key = stableObservation(observation); const member = { candidate: row.candidate, observation };
        observedStates.push(member); if (!stateGroups.has(key)) stateGroups.set(key, []); stateGroups.get(key).push(member);
        artifact.diagnostics.stateSuccesses += 1;
      } catch (error) {
        if (error instanceof PreflightError && error.code === "NETWORK_CALL_CAP" && rpc.networkCalls >= MAX_NETWORK_CALLS) throw error;
      }
    }
    artifact.diagnostics.stateDistinctGroups = stateGroups.size;
    artifact.diagnostics.stateConsensusFamilies = Math.max(0, ...[...stateGroups.values()].map((group) => new Set(group.map((row) => row.candidate.operatorFamily)).size));
    artifact.pin.stateFamilies = artifact.diagnostics.stateConsensusFamilies;
    const matchingStates = [...stateGroups.values()].filter((group) => new Set(group.map((row) => row.candidate.operatorFamily)).size >= REQUIRED_FAMILIES)
      .sort((left, right) => right.length - left.length);
    if (!matchingStates.length) fail("STATE_CONSENSUS_UNAVAILABLE");
    const stateGroup = [], stateFamilies = new Set();
    for (const member of matchingStates[0]) {
      if (stateFamilies.has(member.candidate.operatorFamily)) continue;
      stateGroup.push(member); stateFamilies.add(member.candidate.operatorFamily);
      if (stateGroup.length === qualificationFamilyTarget) break;
    }
    artifact.diagnostics.stateConsensusFamilies = stateGroup.length;
    artifact.pin = {
      number: String(pin.number), hash: pin.hash, timestamp: String(pin.timestamp), finalized: true,
      headerFamilies: artifact.diagnostics.pinConsensusFamilies, stateFamilies: stateGroup.length
    };
    const current = stateGroup[0].observation;
    const unchangedFromHistorical = runtimeMatchesBaseline(current.runtime, historical);
    const exactCurrentSourceBound = unchangedFromHistorical || runtimeMatchesBaseline(current.runtime, CURRENT_SOURCE_BOUND);
    artifact.runtime = {
      ...current.runtime,
      changedFromHistorical: !unchangedFromHistorical,
      exactCurrentSourceBound
    };
    artifact.paused = current.paused;
    artifact.pools = current.pools.map((pool) => ({
      ...pool, recentSupplyEventCount: 0, recentNonDustSupply: false,
      recentWindowFrom: "0", recentWindowTo: String(pin.number)
    }));
    const flowRows = [];
    phase = "FLOW";
    for (const member of stateGroup) {
      try { flowRows.push({ member, flow: await readRecentFlow(member.candidate, pin, current, rpc) }); } catch (_) { /* fail closed after bounded transport retry */ }
    }
    const flowGroup = flowConsensus(flowRows);
    artifact.diagnostics.flowConsensusFamilies = flowGroup.length;
    artifact.diagnostics.flowDistinctGroups = new Set(flowRows.map((row) => stable(row.flow))).size;
    if (flowGroup.length < REQUIRED_FAMILIES) fail("FLOW_CONSENSUS_UNAVAILABLE");
    phase = "PIN_CONSENSUS";
    let terminalPinStable = true;
    for (const row of flowGroup) {
      let terminal;
      try {
        terminal = normalizeHeader(await rpc.call(row.member.candidate.handle, "eth_getBlockByNumber", [ethers.toQuantity(pin.number), false], 6000));
      } catch (error) {
        if (error instanceof PreflightError && error.code === "NETWORK_CALL_CAP") throw error;
        terminal = null;
      }
      if (!terminal || stableObservation(terminal) !== stableObservation(pin)) terminalPinStable = false;
    }
    if (!terminalPinStable) fail("PIN_CONSENSUS_UNAVAILABLE");
    const flow = flowGroup[0].flow;
    artifact.pools = artifact.pools.map((pool, index) => ({
      ...pool,
      recentSupplyEventCount: flow.pools[index].eventCount,
      recentNonDustSupply: flow.pools[index].nonDust,
      recentWindowFrom: String(flow.from),
      recentWindowTo: String(flow.to)
    }));
    complete = true;
    const eventCount = artifact.pools.reduce((sum, pool) => sum + pool.recentSupplyEventCount, 0);
    const nonDust = artifact.pools.some((pool) => pool.recentNonDustSupply);
    let status;
    if (artifact.paused) status = "BLOCKED_PAUSED";
    else if (!artifact.runtime.exactCurrentSourceBound) status = "BLOCKED_RUNTIME_UNBOUND";
    else if (eventCount === 0) status = "BLOCKED_NO_FLOW";
    else if (!nonDust) status = "BLOCKED_DUST_ONLY";
    else status = "POSITIVE_FLOW";
    artifact.trigger = { status, positive: status === "POSITIVE_FLOW", reason: STATUS_REASON[status] };
    artifact.economics = status === "POSITIVE_FLOW" ? emptyEconomics("TRIGGER_POSITIVE_GROSS_ONLY") : emptyEconomics();
  } catch (error) {
    if (error instanceof PreflightError && error.diagnostics) Object.assign(artifact.diagnostics, error.diagnostics);
    if (error instanceof PreflightError && error.pin) {
      artifact.pin = {
        number: String(error.pin.number), hash: error.pin.hash, timestamp: String(error.pin.timestamp), finalized: true,
        headerFamilies: artifact.diagnostics.pinConsensusFamilies, stateFamilies: artifact.diagnostics.stateConsensusFamilies
      };
    }
    if (error instanceof CaptureError && error.pin) {
      artifact.pin = {
        number: String(error.pin.number), hash: error.pin.hash, timestamp: String(error.pin.timestamp), finalized: true,
        headerFamilies: artifact.diagnostics.pinConsensusFamilies, stateFamilies: artifact.diagnostics.stateConsensusFamilies
      };
    }
    if (error && error.code === "TWO_FAMILIES_UNAVAILABLE") phase = "QUALIFICATION";
    else if (error && error.code === "PIN_CONSENSUS_UNAVAILABLE") phase = "PIN_CONSENSUS";
    else if (error && error.code === "STATE_CONSENSUS_UNAVAILABLE") phase = "STATE";
    else if (error && error.code === "FLOW_CONSENSUS_UNAVAILABLE") phase = "FLOW";
    artifact.diagnostics.failurePhase = phase;
    artifact.diagnostics.failureCode = ((error instanceof CaptureError || error instanceof PreflightError) && FAILURE_CODES.has(error.code)) ? error.code : "UNEXPECTED";
    artifact.trigger = { status: "INCOMPLETE", positive: false, reason: STATUS_REASON.INCOMPLETE };
    artifact.economics = emptyEconomics(artifact.economics.status === "TRIGGER_POSITIVE_GROSS_ONLY" ? "INCOMPLETE" : "NOT_RUN");
  } finally {
    artifact.safety.networkCalls = rpc.networkCalls;
    Object.assign(artifact.safety, retry.snapshot());
  }
  applyGates(artifact, complete);
  if (!validateArtifact(artifact)) fail("OUTPUT_SCHEMA_INVALID");
  return artifact;
}

function fsyncDirectory(directory, fsImpl) {
  const fd = fsImpl.openSync(directory, "r");
  try { try { fsImpl.fsyncSync(fd); } catch (error) { if (!["EINVAL", "EPERM", "EBADF"].includes(error.code)) throw error; } }
  finally { fsImpl.closeSync(fd); }
}

function publishAtomic(artifact, options = {}) {
  if (!validateArtifact(artifact)) fail("OUTPUT_SCHEMA_INVALID");
  const fsImpl = options.fsImpl || fs;
  const target = path.resolve(options.outputPath || OUTPUT);
  const allowedRoot = path.resolve(options.allowedRoot || path.dirname(OUTPUT));
  if (path.dirname(target) !== allowedRoot || path.basename(target) !== "etherfi-debtmanager-profit-trigger.json") fail("OUTPUT_PATH_REJECTED");
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  const temporary = path.join(allowedRoot, `.etherfi-debtmanager-profit-trigger.json.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  let fd;
  try {
    fd = fsImpl.openSync(temporary, "wx", 0o600);
    fsImpl.writeFileSync(fd, bytes);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    fsImpl.renameSync(temporary, target);
    fsyncDirectory(allowedRoot, fsImpl);
    const readback = fsImpl.readFileSync(target);
    if (!readback.equals(bytes) || !validateArtifact(JSON.parse(readback.toString("utf8")))) fail("READBACK_INVALID");
    return target;
  } finally {
    if (fd !== undefined) try { fsImpl.closeSync(fd); } catch (_) {}
    if (fsImpl.existsSync(temporary)) try { fsImpl.unlinkSync(temporary); } catch (_) {}
  }
}

async function runAndPublish(options = {}) {
  const artifact = await runTrigger(options);
  publishAtomic(artifact, options);
  return artifact;
}
async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 0) fail("ARGUMENTS_REJECTED");
  await runAndPublish();
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });

module.exports = Object.freeze({
  CLAIM, SCHEMA, EVIDENCE_CLASS, CHAIN_ID, MANAGER, EIP1967, HISTORICAL, CURRENT_SOURCE_BOUND, TOKENS, OUTPUT,
  MAX_CANDIDATES, MAX_NETWORK_CALLS, SUPPLIED_TOPIC, manager, token, CaptureError, zeroShareMax, baseArtifact,
  runtimeMatchesBaseline, canonicalProviderFamily, candidatePool, validateArtifact, runTrigger, publishAtomic, runAndPublish, main
});
