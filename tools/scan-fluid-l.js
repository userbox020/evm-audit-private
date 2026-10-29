#!/usr/bin/env node
"use strict";

// Fluid Vault (lending) live-set + liquidation-readiness observation producer
// (L class).
//
// Mirrors the established L-class observation-producer conventions
// (tools/scan-euler-l.js, tools/scan-aave-v3-l2-outage-l.js, tools/scan-twyne-l.js,
// tools/scan-pendle-l.js, tools/scan-eulerswap-l.js):
//   * Multicall3-batched state reads, fail-closed (a null/revert is unresolved,
//     never a default),
//   * adaptive resumable windows (bounded recent cross-check; the live factory
//     view is authoritative for the vault set),
//   * atomic artifact writes, canonical CSV + sha256, process-only endpoints,
//   * sequential reads, no signing, no transactions, no private-key material.
//
// Purpose (standing-order class anchor: the in-tree verified VaultT2/T4
// "negative token1 maximum" predicate, reports/critical-fluid-vaultt2-t4-
// smart-collateral-negative-max-r2.md FLUID-VT2T4-L01): surface the LIVE Fluid
// vault set and its per-vault liquidation-readiness posture, honestly labelled.
//
// Resolution rules (no new doc pages fetched; anchors are in-tree only):
//   * Deployments (factory + resolver + the four per-type deployment logics)
//     are read from targets/fluid-contracts-public/deployments/<folder>/*.json
//     (the in-tree deployment/logic map, factory/main.sol:362 FluidVaultFactory).
//   * The vault set is the factory's own live view: totalVaults() + getVaultAddress(id).
//     This is authoritative and cheap. A BOUNDED recent `VaultDeployed` event
//     scan (adaptive resumable windows) is a cross-check only.
//   * The per-type implementation map is double-bound two ways: the live
//     isVaultDeploymentLogic(address) view for the four known logic addresses,
//     plus a bounded `LogSetVaultDeploymentLogic` event scan.
//   * Per-vault type/config/exchange prices/totals come from the in-tree
//     VaultResolver.getVaultEntireData(address) shape (periphery/resolvers/vault/
//     structs.sol), decoded through the deployment ABI. TYPE() is read on the
//     vault itself as an independent type double-bind.
//   * EIP1967 implementation slots are read (factory + surfaced vaults) and
//     recorded honestly; Fluid vaults are CREATE-deployed (not EIP1967 proxies),
//     so a zero slot is expected and recorded as ZERO_NOT_PROXY.
//
// Honest unknowns (never fabricated):
//   * The negative-max lens is a COMPILE FACT of the in-tree pin. No live
//     confirmation is derivable from this read-only surface; every T2/T4 row is
//     labelled liveVerification: NONE_COMPILE_FACT_ONLY.
//   * The per-vault near-liquidation-threshold posture is an AGGREGATE proxy
//     (debt / oracle-valued collateral); the vault's true trigger is per-position
//     tick-based. Where the oracle price or collateral is unavailable the LT
//     posture is UNRESOLVED_NO_DEEPER_READ.
//
// Read-only. RPC material stays process-only and is never printed or persisted.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc, loadRpcUrls, sanitizeError } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const ARTIFACT_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "fluid-l.json");
const CSV_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "fluid-l.csv");
const INDEX_PATH = path.join(WORKSPACE, "reports", "monitor", "fluid-l-index.json");
const DEPLOYMENTS = path.join(WORKSPACE, "targets", "fluid-contracts-public", "deployments");
const PRIOR_PHASE0 = path.join(WORKSPACE, "reports", "raw", "fast", "fluid-lending-phase0.json");
const NEGATIVE_MAX_REPORT = "reports/critical-fluid-vaultt2-t4-smart-collateral-negative-max-r2.md";

const ARTIFACT_SCHEMA = "fluid-l-observation/v1";
const INDEX_SCHEMA = "fluid-l-index/v1";
const VERSION = 1;

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ZERO = "0x0000000000000000000000000000000000000000";

// In-scope chains (Ethereum mainnet FIRST; Base/Arbitrum/Polygon second).
const CHAINS = Object.freeze({
  1: Object.freeze({ chainId: 1, label: "ethereum", folder: "mainnet" }),
  8453: Object.freeze({ chainId: 8453, label: "base", folder: "base" }),
  42161: Object.freeze({ chainId: 42161, label: "arbitrum", folder: "arbitrum" }),
  137: Object.freeze({ chainId: 137, label: "polygon", folder: "polygon" }),
});

// fluidProtocolTypes.sol:10-13
const VAULT_TYPES = Object.freeze({
  10000: Object.freeze({ typeNumber: 1, label: "T1" }),
  20000: Object.freeze({ typeNumber: 2, label: "T2-smart-col" }),
  30000: Object.freeze({ typeNumber: 3, label: "T3-smart-debt" }),
  40000: Object.freeze({ typeNumber: 4, label: "T4-smart-col-smart-debt" }),
});

// Bounds / conventions.
const MAX_VAULTS_PER_CHAIN = 40;   // surfaced (prioritized) vault cap per chain
const WINDOW = 10_000;             // bounded recent event-scan base window
const MIN_WINDOW = 1_000;          // adaptive split floor
const MAX_EVENT_WINDOWS = 40;      // bounded recent event-scan window budget
const REQUEST_BUDGET = 240;        // bounded requests per chain per run
const MC_BATCH_LIGHT = 200;        // cheap view batching
const MC_BATCH_HEAVY = 10;         // heavy resolver batching
const TIMEOUT_MS = 30_000;
const LT_NEAR_PCT = 95n;           // near-LT band = 95% of liquidation threshold
const LTV_SCALE_SUSPECT_BPS = 1_000_000n; // >100x => scale unresolved

const EVENT_SIGNATURES = Object.freeze({
  VaultDeployed: "VaultDeployed(address,uint256)",
  LogSetVaultDeploymentLogic: "LogSetVaultDeploymentLogic(address,bool)",
});
const VAULT_DEPLOYED_TOPIC = ethers.id(EVENT_SIGNATURES.VaultDeployed);
const LOG_SET_VAULT_DEPLOYMENT_LOGIC_TOPIC = ethers.id(EVENT_SIGNATURES.LogSetVaultDeploymentLogic);

const I = Object.freeze({
  factory: new ethers.Interface([
    "function totalVaults() view returns (uint256)",
    "function getVaultAddress(uint256 vaultId_) view returns (address)",
    "function isVaultDeploymentLogic(address vaultDeploymentLogic_) view returns (bool)",
    "function owner() view returns (address)",
    "function readFromStorage(bytes32 slot_) view returns (uint256)",
  ]),
  vault: new ethers.Interface([
    "function TYPE() view returns (uint256)",
    "function VAULT_ID() view returns (uint256)",
    "function readFromStorage(bytes32 slot_) view returns (uint256)",
  ]),
  storage: new ethers.Interface([
    "function readFromStorage(bytes32 slot_) view returns (uint256)",
  ]),
  multicall: new ethers.Interface([
    "function aggregate3((address target,bool failure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])",
  ]),
});

let REQUEST_COUNT = 0;

class ScanFailure extends Error {
  constructor(code) { super(code); this.name = "ScanFailure"; this.code = code; }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function relPosix(target) { return path.relative(WORKSPACE, target).split(path.sep).join("/"); }
function lower(value) { try { return ethers.getAddress(String(value)).toLowerCase(); } catch (_) { return null; } }
function isZeroAddr(value) { return typeof value === "string" && /^0x0{40}$/i.test(value); }
function canonicalHash(value) { return `0x${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function toIso(seconds) { try { return new Date(Number(seconds) * 1000).toISOString(); } catch (_) { return null; } }
function big(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function ustr(value) { return value === null || value === undefined ? null : big(value).toString(); }

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return text ? JSON.parse(text) : null;
  } catch (_) { return null; }
}

async function call(rpc, method, params, ms = TIMEOUT_MS, attempts = 6) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    REQUEST_COUNT += 1;
    const result = await rpcCall(rpc, method, params, ms);
    if (result !== null && result !== undefined) return result;
    last = result;
    if (attempt < attempts - 1) await sleep(250 * (attempt + 1));
  }
  void last;
  throw new ScanFailure("RPC_READ_FAILED");
}

async function selectFinalized(rpc) {
  const block = await call(rpc, "eth_getBlockByNumber", ["finalized", false]);
  if (!block || !/^0x[0-9a-f]+$/i.test(block.number || "") || !/^0x[0-9a-f]{64}$/i.test(block.hash || "")) {
    throw new ScanFailure("BLOCK_UNAVAILABLE");
  }
  return block;
}

// Qualify the endpoint before a scan: chain id must match and a finalized block
// read must succeed. Endpoint values stay process-only.
async function resolveWorkingRpc(chainId) {
  const first = await resolveRpc(chainId);
  const candidates = [];
  if (first) candidates.push(first);
  try { for (const url of loadRpcUrls({ maxCandidates: 40 })) if (!candidates.includes(url)) candidates.push(url); } catch (_) {}
  for (const url of candidates.slice(0, 20)) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
    try {
      const chainRaw = await rpcCall(url, "eth_chainId", [], 6000);
      if (!chainRaw || Number(BigInt(chainRaw)) !== chainId) continue;
      const block = await rpcCall(url, "eth_getBlockByNumber", ["finalized", false], 12_000);
      if (block && block.number && block.hash) return url;
    } catch (_) { /* try next candidate */ }
  }
  return first;
}

function decodeOrNull(iface, fn, returnData) {
  try { return iface.decodeFunctionResult(fn, returnData); } catch (_) { return null; }
}

async function readCode(rpc, address, blockTag) {
  try { const code = await call(rpc, "eth_getCode", [address, blockTag]); return typeof code === "string" ? code : null; }
  catch (_) { return null; }
}

async function readCall(rpc, to, iface, fn, args, blockTag) {
  try {
    const raw = await call(rpc, "eth_call", [{ to, data: iface.encodeFunctionData(fn, args) }, blockTag]);
    return decodeOrNull(iface, fn, raw);
  } catch (_) { return null; }
}

// --- deployments (in-tree map) ------------------------------------------------------------
function loadChainDeployments(folder) {
  const dir = path.join(DEPLOYMENTS, folder);
  const factoryJson = readJson(path.join(dir, "VaultFactory.json"));
  const resolverJson = readJson(path.join(dir, "VaultResolver.json"));
  const factory = factoryJson ? lower(factoryJson.address) : null;
  const factoryDeployBlock = factoryJson && factoryJson.receipt && Number.isFinite(Number(factoryJson.receipt.blockNumber))
    ? Number(factoryJson.receipt.blockNumber) : null;
  const resolver = resolverJson ? lower(resolverJson.address) : null;
  const resolverAbi = resolverJson && Array.isArray(resolverJson.abi) ? resolverJson.abi : null;
  const deploymentLogics = {};
  for (const n of [1, 2, 3, 4]) {
    const j = readJson(path.join(dir, `VaultT${n}DeploymentLogic.json`));
    deploymentLogics[n] = j ? lower(j.address) : null;
  }
  return { factory, factoryDeployBlock, resolver, resolverAbi, deploymentLogics };
}

// --- multicall (sequential, fail-closed) --------------------------------------------------
async function multicall(rpc, blockTag, entries, batchSize = MC_BATCH_LIGHT) {
  const results = new Array(entries.length);
  let failures = 0;
  let requests = 0;
  for (let start = 0; start < entries.length; start += batchSize) {
    const batch = entries.slice(start, start + batchSize);
    let decoded = null;
    for (let attempt = 0; attempt < 3 && decoded === null; attempt += 1) {
      try {
        const tuples = batch.map((e) => ({ target: e.to, failure: true, callData: e.data }));
        const data = I.multicall.encodeFunctionData("aggregate3", [tuples]);
        requests += 1;
        const raw = await call(rpc, "eth_call", [{ to: MULTICALL3, data }, blockTag], TIMEOUT_MS);
        const [out] = I.multicall.decodeFunctionResult("aggregate3", raw);
        decoded = out;
      } catch (_) { if (attempt < 2) await sleep(300 * (attempt + 1)); }
    }
    if (decoded === null) { failures += batch.length; continue; }
    decoded.forEach((item, index) => { results[start + index] = { success: item[0] === true, returnData: item[1] }; });
  }
  return { results, failures, requests };
}

// --- history floor ------------------------------------------------------------------------
// The in-tree deployment receipt carries the factory deploy block. Prove it on
// chain (runtime absent one block before, present at it). When the receipt block
// is missing, fall back to a bounded eth_getCode binary search.
async function binarySearchCodeFloor(rpc, address, lo, hi) {
  let low = lo;
  let high = hi;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    const code = await call(rpc, "eth_getCode", [address, hexBlock(mid)]);
    if (typeof code === "string" && code.length > 2) high = mid; else low = mid + 1;
  }
  return low;
}

async function proveHistoryStartBound(rpc, factory, finalizedNumber, claimedBlock) {
  if (claimedBlock && claimedBlock > 1 && claimedBlock <= finalizedNumber) {
    const before = await readCode(rpc, factory, hexBlock(claimedBlock - 1));
    const at = await readCode(rpc, factory, hexBlock(claimedBlock));
    if (before === "0x" && typeof at === "string" && at.length > 2) {
      return {
        block: claimedBlock,
        proven: true,
        derivation: "deployment-receipt-block-verified-by-eth_getCode",
        note: "targets/fluid-contracts-public/deployments receipt block verified on chain: factory runtime absent one block before the floor and present at it.",
        proof: { method: "eth_getCode", address: factory, previousBlock: claimedBlock - 1, previousBlockCodeAbsent: true, deploymentBlockCodePresent: true },
      };
    }
  }
  const floor = await binarySearchCodeFloor(rpc, factory, 1, finalizedNumber);
  const before = await readCode(rpc, factory, hexBlock(floor - 1));
  const at = await readCode(rpc, factory, hexBlock(floor));
  const previousBlockCodeAbsent = before === "0x";
  const deploymentBlockCodePresent = typeof at === "string" && at.length > 2;
  if (!previousBlockCodeAbsent || !deploymentBlockCodePresent) throw new ScanFailure("HISTORY_BOUND_UNPROVEN");
  return {
    block: floor,
    proven: true,
    derivation: "eth_getCode-binary-search",
    note: "deployment receipt block unavailable; factory runtime absent one block before the floor and present at it.",
    proof: { method: "eth_getCode", address: factory, previousBlock: floor - 1, previousBlockCodeAbsent, deploymentBlockCodePresent },
  };
}

// --- bounded adaptive resumable event windows ---------------------------------------------
async function fetchRange(rpc, { address, topics, from, to }) {
  const filter = { topics, fromBlock: hexBlock(from), toBlock: hexBlock(to) };
  if (address) filter.address = address;
  const logs = await call(rpc, "eth_getLogs", [filter], TIMEOUT_MS);
  if (!Array.isArray(logs)) throw new ScanFailure("LOG_READ_FAILED");
  return logs;
}

async function fetchRangeBounded(rpc, spec, attempts = 3) {
  const { from, to } = spec;
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await fetchRange(rpc, spec); }
    catch (error) { last = error; if (attempt < attempts - 1) await sleep(300 * (attempt + 1)); }
  }
  if (to - from > MIN_WINDOW) {
    const mid = from + Math.floor((to - from) / 2);
    const left = await fetchRangeBounded(rpc, { ...spec, from, to: mid }, attempts);
    const right = await fetchRangeBounded(rpc, { ...spec, from: mid + 1, to }, attempts);
    return left.concat(right);
  }
  throw last;
}

// Bounded recent scan: at most MAX_EVENT_WINDOWS base windows ending at the
// finalized pin. A window is marked done only once its logs are fully retrieved;
// unresolved windows stay eligible for a later run (resumable, zero-loss).
async function enumerateRecentWindows(index, doneKey, { rpc, address, topics, to, onLogs, persist }) {
  const done = index[doneKey] && typeof index[doneKey] === "object" ? index[doneKey] : (index[doneKey] = {});
  const from = Math.max(0, to - MAX_EVENT_WINDOWS * WINDOW + 1);
  const windowCount = Math.ceil((to - from + 1) / WINDOW);
  const pending = [];
  for (let i = 0; i < windowCount; i += 1) if (!(i in done)) pending.push(i);
  const initialPending = pending.length;
  const failed = [];
  let verification = null;
  for (const i of pending) {
    const wFrom = from + i * WINDOW;
    const wTo = Math.min(to, wFrom + WINDOW - 1);
    try {
      const logs = await fetchRangeBounded(rpc, { address, topics, from: wFrom, to: wTo });
      onLogs(logs, i);
      done[i] = logs.length;
    } catch (_) { failed.push(i); }
    if (typeof persist === "function") persist();
  }
  if (failed.length === 0 && pending.length > 0) {
    const i = pending[0];
    const wFrom = from + i * WINDOW;
    const wTo = Math.min(to, wFrom + WINDOW - 1);
    try {
      const again = await fetchRangeBounded(rpc, { address, topics, from: wFrom, to: wTo }, 2);
      verification = { windowStart: wFrom, firstCount: done[i], secondCount: again.length, match: again.length === done[i] };
    } catch (_) { verification = { windowStart: wFrom, firstCount: done[i], secondCount: null, match: false }; }
  }
  if (typeof persist === "function") persist();
  const remainingWindows = windowCount - Object.keys(done).length;
  return {
    from, to, windowCount, initialPending, remainingWindows,
    windowsFetched: pending.length, windowsCached: windowCount - pending.length,
    failedWindows: failed.length, verification,
  };
}

// --- index (resumable) --------------------------------------------------------------------
function emptyChainIndex(chainId, folder) {
  return {
    chainId,
    folder,
    factory: null,
    resolver: null,
    deploymentLogics: { 1: null, 2: null, 3: null, 4: null },
    floor: null,
    inventory: { count: 0, addresses: [] },
    implementationMap: {},
    implementationLogicEvents: { count: 0, rows: [] },
    eventWindows: {},
    eventVaultDeployed: { count: 0, vaults: {} },
    vaultStructural: {},
    eip1967: {},
    finalizedAtLastRun: null,
    failures: 0,
  };
}

function emptyIndex() {
  return {
    schema: INDEX_SCHEMA,
    version: VERSION,
    runCount: 0,
    lastRunAt: null,
    priorPhase0Loaded: false,
    lastCsvSha256: null,
    lastCsvRowCount: null,
    chains: {},
  };
}

function loadIndex(file = INDEX_PATH, fsImpl = fs) {
  if (!fsImpl.existsSync(file)) return emptyIndex();
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.chains !== "object") return emptyIndex();
    const index = { ...emptyIndex(), ...parsed, chains: {} };
    for (const [key, state] of Object.entries(parsed.chains || {})) {
      const base = emptyChainIndex(Number(key), CHAINS[Number(key)] ? CHAINS[Number(key)].folder : null);
      index.chains[key] = {
        ...base,
        ...state,
        deploymentLogics: { ...base.deploymentLogics, ...(state.deploymentLogics || {}) },
        inventory: { count: 0, addresses: [], ...(state.inventory || {}) },
        implementationMap: state.implementationMap || {},
        implementationLogicEvents: { count: 0, rows: [], ...(state.implementationLogicEvents || {}) },
        eventWindows: state.eventWindows || {},
        eventVaultDeployed: { count: 0, vaults: {}, ...(state.eventVaultDeployed || {}) },
        vaultStructural: state.vaultStructural || {},
        eip1967: state.eip1967 || {},
      };
    }
    return index;
  } catch (_) { return emptyIndex(); }
}

function persistIndex(index, file = INDEX_PATH, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, `${JSON.stringify(index)}\n`);
}

// --- prior phase0 priority (honest labeling) ----------------------------------------------
// Priority order for the surfaced vault set follows the prior scanner's
// totalBorrowUsd labeling (scan-fluid-lending-phase0.js), matched by
// chainId:address. This is deterministic, which keeps the surfaced set stable
// across runs. Vaults absent from the prior artifact sort last by vaultId.
function loadPriorPriority() {
  const artifact = readJson(PRIOR_PHASE0);
  const priority = new Map();
  if (!artifact || !Array.isArray(artifact.chainResults)) return { priority, loaded: false, source: null };
  for (const chain of artifact.chainResults) {
    for (const row of chain.vaultRows || []) {
      const addr = lower(row.vault || row.address);
      if (!addr) continue;
      const usd = Number.isFinite(Number(row.totalBorrowUsd)) ? Number(row.totalBorrowUsd) : null;
      priority.set(`${chain.chainId}:${addr}`, { totalBorrowUsd: usd, label: row.label || null });
    }
  }
  return { priority, loaded: priority.size > 0, source: "reports/raw/fast/fluid-lending-phase0.json (totalBorrowUsd, chainId:address)" };
}

// --- inventory / implementation map / EIP1967 ---------------------------------------------
async function readInventory(rpc, blockTag, factory) {
  const lenRes = await readCall(rpc, factory, I.factory, "totalVaults", [], blockTag);
  const count = lenRes ? Number(big(lenRes[0])) : 0;
  if (!Number.isFinite(count) || count < 0) throw new ScanFailure("INVENTORY_UNAVAILABLE");
  const entries = [];
  for (let id = 1; id <= count; id += 1) entries.push({ to: factory, data: I.factory.encodeFunctionData("getVaultAddress", [id]) });
  const mc = entries.length ? await multicall(rpc, blockTag, entries, MC_BATCH_LIGHT) : { results: [], failures: 0, requests: 0 };
  const addresses = [];
  for (let i = 0; i < count; i += 1) {
    const item = mc.results[i];
    if (!item || item.success !== true) continue;
    const d = decodeOrNull(I.factory, "getVaultAddress", item.returnData);
    const addr = d ? lower(d[0]) : null;
    if (addr && !isZeroAddr(addr)) addresses.push(addr);
  }
  return { count, addresses, failures: mc.failures, requests: mc.requests };
}

async function readImplementationMap(rpc, blockTag, factory, logicAddresses) {
  const entries = logicAddresses.map((a) => ({ to: factory, data: I.factory.encodeFunctionData("isVaultDeploymentLogic", [a]) }));
  const mc = entries.length ? await multicall(rpc, blockTag, entries, MC_BATCH_LIGHT) : { results: [], failures: 0, requests: 0 };
  const map = {};
  logicAddresses.forEach((a, i) => {
    const item = mc.results[i];
    const d = item && item.success === true ? decodeOrNull(I.factory, "isVaultDeploymentLogic", item.returnData) : null;
    map[a] = d ? d[0] === true : null;
  });
  return { map, failures: mc.failures, requests: mc.requests };
}

// EIP1967 implementation slot via the contract's own readFromStorage(slot_).
async function readEip1967(rpc, blockTag, addresses) {
  const entries = addresses.map((a) => ({ to: a, data: I.storage.encodeFunctionData("readFromStorage", [EIP1967_IMPL_SLOT]) }));
  const mc = entries.length ? await multicall(rpc, blockTag, entries, MC_BATCH_LIGHT) : { results: [], failures: 0, requests: 0 };
  const map = {};
  addresses.forEach((a, i) => {
    const item = mc.results[i];
    let slotValue = null;
    if (item && item.success === true) {
      const d = decodeOrNull(I.storage, "readFromStorage", item.returnData);
      if (d) slotValue = `0x${big(d[0]).toString(16).padStart(64, "0")}`;
    }
    let classification = "UNRESOLVED";
    let impl = null;
    if (slotValue !== null) {
      impl = `0x${slotValue.slice(26)}`;
      classification = isZeroAddr(impl) ? "ZERO_NOT_PROXY" : "NONZERO_IMPLEMENTATION";
    }
    map[a] = { slotValue, implementation: impl, classification };
  });
  return { map, failures: mc.failures, requests: mc.requests };
}

// --- per-vault live posture ---------------------------------------------------------------
function negativeMaxLens(typeNumber) {
  if (typeNumber !== 2 && typeNumber !== 4) return null;
  const anchor = typeNumber === 2
    ? "targets/fluid-contracts-public/contracts/protocols/vault/vaultT2/coreModule/mainOperate.sol:51"
    : "targets/fluid-contracts-public/contracts/protocols/vault/vaultT4/coreModule/mainOperate.sol:88";
  return {
    vaultType: typeNumber,
    negativemaxSemantics: "vulnerable-per-pin",
    remediationStatus: "patch-never-deployed-in-tree-pin",
    predicateAnchor: anchor,
    predicate: "duplicate `colToken0MinMax_ <= 0` predicate in place of `colToken1MinMax_ <= 0`: a negative token1 maximum is not rejected before conversion to uint, disabling token1 slippage protection",
    findingRef: `${NEGATIVE_MAX_REPORT} (FLUID-VT2T4-L01)`,
    liveVerification: "NONE_COMPILE_FACT_ONLY",
    note: "The predicate is a compile fact of the in-tree pin; this read-only surface provides NO live-verifiable confirmation. Fail-closed label.",
  };
}

function computeLtPosture({ totalSupplyVault, totalBorrowVault, oraclePriceOperate, liquidationThresholdBps }) {
  const supply = big(totalSupplyVault);
  const borrow = big(totalBorrowVault);
  const price = big(oraclePriceOperate);
  const ltBps = liquidationThresholdBps === null || liquidationThresholdBps === undefined ? null : Number(liquidationThresholdBps);
  const derivation = "aggregateLtvBps = totalBorrowVault * 1e4 / (totalSupplyVault * oraclePriceOperate / 1e27); aggregate proxy only (per-position tick truth not derived)";
  if (borrow === 0n) {
    return { aggregateLtvBps: 0, ltReadiness: "NO_DEBT", liquidationThresholdBps: ltBps, derivation, sanity: "OK" };
  }
  if (supply === 0n) {
    return { aggregateLtvBps: null, ltReadiness: "UNRESOLVED_NO_DEEPER_READ", liquidationThresholdBps: ltBps, derivation, sanity: "NO_COLLATERAL" };
  }
  if (price === 0n) {
    return { aggregateLtvBps: null, ltReadiness: "UNRESOLVED_NO_DEEPER_READ", liquidationThresholdBps: ltBps, derivation, sanity: "NO_ORACLE_PRICE" };
  }
  const collateralInDebt = (supply * price) / (10n ** 27n);
  if (collateralInDebt === 0n) {
    return { aggregateLtvBps: null, ltReadiness: "UNRESOLVED_NO_DEEPER_READ", liquidationThresholdBps: ltBps, derivation, sanity: "COLLATERAL_VALUE_ZERO" };
  }
  const ltvBps = (borrow * 10000n) / collateralInDebt;
  if (ltvBps > LTV_SCALE_SUSPECT_BPS) {
    return { aggregateLtvBps: Number(ltvBps), ltReadiness: "UNRESOLVED_NO_DEEPER_READ", liquidationThresholdBps: ltBps, derivation, sanity: "SCALE_SUSPECT" };
  }
  let readiness = "BELOW_LT";
  if (ltBps === null) readiness = "LT_UNRESOLVED";
  else if (ltvBps >= BigInt(ltBps)) readiness = "AT_OR_ABOVE_LT";
  else if (ltvBps * 100n >= BigInt(ltBps) * LT_NEAR_PCT) readiness = "NEAR_LT";
  return { aggregateLtvBps: Number(ltvBps), ltReadiness: readiness, liquidationThresholdBps: ltBps, derivation, sanity: "OK" };
}

function parseEntire(decoded) {
  const cv = decoded.constantVariables;
  const cfg = decoded.configs;
  const ex = decoded.exchangePricesAndRates;
  const tot = decoded.totalSupplyAndBorrow;
  const state = decoded.vaultState;
  const vaultTypeRaw = Number(big(cv.vaultType));
  const meta = VAULT_TYPES[vaultTypeRaw] || null;
  const supplyToken0 = lower(cv.supplyToken.token0);
  const supplyToken1 = lower(cv.supplyToken.token1);
  const borrowToken0 = lower(cv.borrowToken.token0);
  const borrowToken1 = lower(cv.borrowToken.token1);
  return {
    resolverResolved: true,
    vaultTypeRaw,
    typeNumber: meta ? meta.typeNumber : null,
    typeLabel: meta ? meta.label : null,
    vaultId: ustr(cv.vaultId),
    isSmartCol: decoded.isSmartCol === true,
    isSmartDebt: decoded.isSmartDebt === true,
    supply: lower(cv.supply),
    borrow: lower(cv.borrow),
    supplyToken0,
    supplyToken1: supplyToken1 && !isZeroAddr(supplyToken1) ? supplyToken1 : null,
    borrowToken0,
    borrowToken1: borrowToken1 && !isZeroAddr(borrowToken1) ? borrowToken1 : null,
    collateralFactorBps: Number(big(cfg.collateralFactor)),
    liquidationThresholdBps: Number(big(cfg.liquidationThreshold)),
    liquidationMaxLimitBps: Number(big(cfg.liquidationMaxLimit)),
    liquidationPenaltyBps: Number(big(cfg.liquidationPenalty)),
    oracle: lower(cfg.oracle),
    oraclePriceOperateRaw: ustr(cfg.oraclePriceOperate),
    oraclePriceLiquidateRaw: ustr(cfg.oraclePriceLiquidate),
    lastStoredLiquiditySupplyExchangePriceRaw: ustr(ex.lastStoredLiquiditySupplyExchangePrice),
    lastStoredLiquidityBorrowExchangePriceRaw: ustr(ex.lastStoredLiquidityBorrowExchangePrice),
    lastStoredVaultSupplyExchangePriceRaw: ustr(ex.lastStoredVaultSupplyExchangePrice),
    lastStoredVaultBorrowExchangePriceRaw: ustr(ex.lastStoredVaultBorrowExchangePrice),
    vaultSupplyExchangePriceRaw: ustr(ex.vaultSupplyExchangePrice),
    vaultBorrowExchangePriceRaw: ustr(ex.vaultBorrowExchangePrice),
    liquiditySupplyExchangePriceRaw: ustr(ex.liquiditySupplyExchangePrice),
    liquidityBorrowExchangePriceRaw: ustr(ex.liquidityBorrowExchangePrice),
    supplyRateLiquidityRaw: ustr(ex.supplyRateLiquidity),
    borrowRateLiquidityRaw: ustr(ex.borrowRateLiquidity),
    totalSupplyVaultRaw: ustr(tot.totalSupplyVault),
    totalBorrowVaultRaw: ustr(tot.totalBorrowVault),
    totalSupplyLiquidityOrDexRaw: ustr(tot.totalSupplyLiquidityOrDex),
    totalBorrowLiquidityOrDexRaw: ustr(tot.totalBorrowLiquidityOrDex),
    absorbedSupplyRaw: ustr(tot.absorbedSupply),
    absorbedBorrowRaw: ustr(tot.absorbedBorrow),
    totalPositions: Number(big(state.totalPositions)),
  };
}

async function readVaultLive(rpc, blockTag, resolver, resolverIface, vaults) {
  const entries = vaults.map((v) => ({ to: resolver, data: resolverIface.encodeFunctionData("getVaultEntireData", [v]) }));
  const mc = entries.length ? await multicall(rpc, blockTag, entries, MC_BATCH_HEAVY) : { results: [], failures: 0, requests: 0 };
  const live = new Map();
  vaults.forEach((v, i) => {
    const item = mc.results[i];
    if (!item || item.success !== true) { live.set(v, { resolverResolved: false }); return; }
    const decoded = decodeOrNull(resolverIface, "getVaultEntireData", item.returnData);
    if (!decoded) { live.set(v, { resolverResolved: false }); return; }
    live.set(v, parseEntire(decoded[0]));
  });
  return { live, failures: mc.failures, requests: mc.requests };
}

// TYPE() read on the vault itself (independent type double-bind).
async function readVaultTypes(rpc, blockTag, vaults) {
  const entries = vaults.map((v) => ({ to: v, data: I.vault.encodeFunctionData("TYPE", []) }));
  const mc = entries.length ? await multicall(rpc, blockTag, entries, MC_BATCH_LIGHT) : { results: [], failures: 0, requests: 0 };
  const map = {};
  vaults.forEach((v, i) => {
    const item = mc.results[i];
    const d = item && item.success === true ? decodeOrNull(I.vault, "TYPE", item.returnData) : null;
    map[v] = d ? Number(big(d[0])) : null;
  });
  return { map, failures: mc.failures, requests: mc.requests };
}

// --- artifact -----------------------------------------------------------------------------
function atomicWriteJson(file, value, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    fsImpl.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    fsImpl.renameSync(temporary, file);
  } finally {
    try { fsImpl.rmSync(temporary, { force: true }); } catch (_) {}
  }
}

const CSV_HEADER = [
  "chainId", "chain", "vault", "vaultId", "vaultType", "typeLabel", "implementationLogic", "deployBlock",
  "negativemaxSemantics", "remediationStatus", "negativemaxAnchor",
  "liquidationThresholdBps", "collateralFactorBps", "liquidationMaxLimitBps", "liquidationPenaltyBps",
  "isSmartCol", "isSmartDebt", "supplyToken0", "supplyToken1", "borrowToken0", "borrowToken1",
  "resolverResolved", "eip1967Implementation",
];

function writeCsv(rows, file, fsImpl = fs) {
  const lines = rows.map((r) => CSV_HEADER.map((h) => {
    const v = r[h];
    return v === null || v === undefined ? "" : String(v);
  }).join(","));
  const body = `${[CSV_HEADER.join(","), ...lines].join("\n")}\n`;
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    fsImpl.writeFileSync(temporary, body, { flag: "wx" });
    fsImpl.renameSync(temporary, file);
  } finally {
    try { fsImpl.rmSync(temporary, { force: true }); } catch (_) {}
  }
  return { sha256: crypto.createHash("sha256").update(body).digest("hex"), rowCount: rows.length };
}

function csvRowFor({ chainId, label, vault, structural, eip1967 }) {
  const lens = structural.negativemaxLens;
  return {
    chainId,
    chain: label,
    vault,
    vaultId: structural.vaultId,
    vaultType: structural.vaultTypeRaw,
    typeLabel: structural.typeLabel,
    implementationLogic: structural.implementationLogic,
    deployBlock: structural.deployBlock,
    negativemaxSemantics: lens ? lens.negativemaxSemantics : null,
    remediationStatus: lens ? lens.remediationStatus : null,
    negativemaxAnchor: lens ? lens.predicateAnchor : null,
    liquidationThresholdBps: structural.liquidationThresholdBps,
    collateralFactorBps: structural.collateralFactorBps,
    liquidationMaxLimitBps: structural.liquidationMaxLimitBps,
    liquidationPenaltyBps: structural.liquidationPenaltyBps,
    isSmartCol: structural.isSmartCol,
    isSmartDebt: structural.isSmartDebt,
    supplyToken0: structural.supplyToken0,
    supplyToken1: structural.supplyToken1,
    borrowToken0: structural.borrowToken0,
    borrowToken1: structural.borrowToken1,
    resolverResolved: structural.resolverResolved,
    eip1967Implementation: eip1967 ? eip1967.implementation : null,
  };
}

// --- per-chain scan -----------------------------------------------------------------------
async function scanChain({ chainId, rpc, index, fsImpl, indexPath, full, priorPriority }) {
  const chain = CHAINS[chainId];
  const chainStartRequests = REQUEST_COUNT;
  if (!index.chains[chainId]) index.chains[chainId] = emptyChainIndex(chainId, chain.folder);
  const ci = index.chains[chainId];

  const deployments = loadChainDeployments(chain.folder);
  const factory = deployments.factory;
  if (!factory) {
    return {
      chainId, label: chain.label, error: "deployment-map-missing", factory: null,
      coverage: { complete: false, blockers: ["deployment-map-missing"] },
      reads: { chainRequests: REQUEST_COUNT - chainStartRequests },
    };
  }
  ci.folder = chain.folder;
  ci.factory = factory;

  const finalizedBlock = await selectFinalized(rpc);
  const finalizedNumber = Number(big(finalizedBlock.number));
  const blockTag = finalizedBlock.hash;
  const blockTimestamp = Number(big(finalizedBlock.timestamp));

  const reused = { floor: false, inventory: false, implementationMap: false, structural: false, eventWindows: false, eip1967: false };

  // Floor.
  if (!ci.floor || ci.floor.proven !== true || full) {
    ci.floor = await proveHistoryStartBound(rpc, factory, finalizedNumber, deployments.factoryDeployBlock);
  } else { reused.floor = true; }

  // Resolver resolution (live) + interface from the deployment ABI.
  const resolver = deployments.resolver;
  ci.resolver = resolver;
  let resolverIface = null;
  let resolverCodeOk = false;
  if (resolver) {
    const code = await readCode(rpc, resolver, blockTag);
    resolverCodeOk = typeof code === "string" && code.length > 2;
    if (resolverCodeOk && deployments.resolverAbi) {
      try { resolverIface = new ethers.Interface(deployments.resolverAbi); } catch (_) { resolverIface = null; }
    }
  }

  // Inventory (live view; cached unless --full).
  let inventory;
  if (!full && Array.isArray(ci.inventory.addresses) && ci.inventory.addresses.length > 0) {
    inventory = { count: ci.inventory.count, addresses: ci.inventory.addresses, failures: 0, requests: 0 };
    reused.inventory = true;
  } else {
    inventory = await readInventory(rpc, blockTag, factory);
    ci.inventory = { count: inventory.count, addresses: inventory.addresses };
  }

  // Implementation map: live isVaultDeploymentLogic views (cached unless --full).
  const logicAddresses = [1, 2, 3, 4].map((n) => deployments.deploymentLogics[n]).filter(Boolean);
  let implementationMap;
  if (!full && ci.implementationMap && Object.keys(ci.implementationMap).length > 0) {
    implementationMap = { map: ci.implementationMap, failures: 0, requests: 0 };
    reused.implementationMap = true;
  } else {
    implementationMap = await readImplementationMap(rpc, blockTag, factory, logicAddresses);
    ci.implementationMap = implementationMap.map;
  }

  // Bounded recent event cross-check (VaultDeployed + LogSetVaultDeploymentLogic).
  const eventEnum = await enumerateRecentWindows(ci, "eventWindows", {
    rpc, address: factory, topics: [[VAULT_DEPLOYED_TOPIC, LOG_SET_VAULT_DEPLOYMENT_LOGIC_TOPIC]],
    to: finalizedNumber,
    onLogs: (logs, windowIndex) => {
      for (const log of logs) {
        const topic0 = log && Array.isArray(log.topics) ? String(log.topics[0]).toLowerCase() : null;
        if (topic0 === VAULT_DEPLOYED_TOPIC.toLowerCase()) {
          const topic1 = log.topics[1];
          const vault = typeof topic1 === "string" && topic1.length === 66 ? lower(`0x${topic1.slice(26)}`) : null;
          if (vault && !ci.eventVaultDeployed.vaults[vault]) {
            ci.eventVaultDeployed.vaults[vault] = { deployBlock: Number(big(log.blockNumber)), window: windowIndex };
            ci.eventVaultDeployed.count += 1;
          }
        } else if (topic0 === LOG_SET_VAULT_DEPLOYMENT_LOGIC_TOPIC.toLowerCase()) {
          const topic1 = log.topics[1];
          const logic = typeof topic1 === "string" && topic1.length === 66 ? lower(`0x${topic1.slice(26)}`) : null;
          if (logic) {
            ci.implementationLogicEvents.rows.push({ logic, block: Number(big(log.blockNumber)) });
            ci.implementationLogicEvents.count += 1;
          }
        }
      }
    },
    persist: () => persistIndex(index, indexPath, fsImpl),
  });
  if (eventEnum.windowsFetched < eventEnum.windowCount) reused.eventWindows = true;
  // Prioritized surfaced set: prior phase0 totalBorrowUsd desc, vaultId asc.
  const inventorySorted = [...inventory.addresses].sort((a, b) => {
    const pa = priorPriority.get(`${chainId}:${a}`);
    const pb = priorPriority.get(`${chainId}:${b}`);
    const ua = pa && pa.totalBorrowUsd !== null ? pa.totalBorrowUsd : -1;
    const ub = pb && pb.totalBorrowUsd !== null ? pb.totalBorrowUsd : -1;
    if (ub !== ua) return ub - ua;
    return a.localeCompare(b);
  });
  const selected = inventorySorted.slice(0, MAX_VAULTS_PER_CHAIN);

  // Live reads for the selected set.
  let liveResult = { live: new Map(), failures: 0, requests: 0 };
  let typeResult = { map: {}, failures: 0, requests: 0 };
  if (resolverIface && resolverCodeOk && selected.length > 0) {
    liveResult = await readVaultLive(rpc, blockTag, resolver, resolverIface, selected);
  }
  if (selected.length > 0) {
    typeResult = await readVaultTypes(rpc, blockTag, selected);
  }

  // EIP1967 impl slot: factory + surfaced vaults. Proxy-ness is immutable, so
  // it is cached (refreshed only with --full) to keep the CSV deterministic.
  const eipAddresses = [factory, ...selected];
  let eip1967;
  if (!full && ci.eip1967 && Object.keys(ci.eip1967).length > 0) {
    eip1967 = { map: ci.eip1967, failures: 0, requests: 0 };
    reused.eip1967 = true;
  } else {
    eip1967 = await readEip1967(rpc, blockTag, eipAddresses);
    ci.eip1967 = eip1967.map;
  }

  // Structural cache (cached unless --full) + fresh live state for this run.
  const vaultRows = [];
  let structuralUpdated = 0;
  for (const vault of selected) {
    const live = liveResult.live.get(vault) || { resolverResolved: false };
    let structural = ci.vaultStructural[vault];
    const needStructural = full || !structural || structural.resolverResolved !== true;
    if (needStructural && live.resolverResolved === true) {
      const typeNumber = live.typeNumber;
      structural = {
        resolverResolved: true,
        vaultTypeRaw: live.vaultTypeRaw,
        typeNumber,
        typeLabel: live.typeLabel,
        vaultId: live.vaultId,
        implementationLogic: typeNumber && deployments.deploymentLogics[typeNumber] ? deployments.deploymentLogics[typeNumber] : null,
        deployBlock: ci.eventVaultDeployed.vaults[vault] ? ci.eventVaultDeployed.vaults[vault].deployBlock : null,
        isSmartCol: live.isSmartCol,
        isSmartDebt: live.isSmartDebt,
        supplyToken0: live.supplyToken0,
        supplyToken1: live.supplyToken1,
        borrowToken0: live.borrowToken0,
        borrowToken1: live.borrowToken1,
        collateralFactorBps: live.collateralFactorBps,
        liquidationThresholdBps: live.liquidationThresholdBps,
        liquidationMaxLimitBps: live.liquidationMaxLimitBps,
        liquidationPenaltyBps: live.liquidationPenaltyBps,
        negativemaxLens: negativeMaxLens(typeNumber),
      };
      ci.vaultStructural[vault] = structural;
      structuralUpdated += 1;
    }
    if (!structural) {
      structural = {
        resolverResolved: false, vaultTypeRaw: null, typeNumber: null, typeLabel: null, vaultId: null,
        implementationLogic: null, deployBlock: ci.eventVaultDeployed.vaults[vault] ? ci.eventVaultDeployed.vaults[vault].deployBlock : null,
        isSmartCol: null, isSmartDebt: null, supplyToken0: null, supplyToken1: null, borrowToken0: null, borrowToken1: null,
        collateralFactorBps: null, liquidationThresholdBps: null, liquidationMaxLimitBps: null, liquidationPenaltyBps: null,
        negativemaxLens: null,
      };
    }
    if (!full && ci.vaultStructural[vault]) reused.structural = true;

    const ltPosture = live.resolverResolved === true
      ? computeLtPosture({
        totalSupplyVault: live.totalSupplyVaultRaw,
        totalBorrowVault: live.totalBorrowVaultRaw,
        oraclePriceOperate: live.oraclePriceOperateRaw,
        liquidationThresholdBps: structural.liquidationThresholdBps,
      })
      : { aggregateLtvBps: null, ltReadiness: "UNRESOLVED_NO_DEEPER_READ", liquidationThresholdBps: structural.liquidationThresholdBps, derivation: "resolver unresolved", sanity: "RESOLVER_UNRESOLVED" };

    vaultRows.push({
      vault,
      vaultId: structural.vaultId,
      vaultTypeRaw: structural.vaultTypeRaw,
      typeNumber: structural.typeNumber,
      typeLabel: structural.typeLabel,
      typeDoubleBind: {
        resolverTypeRaw: live.resolverResolved ? live.vaultTypeRaw : null,
        onChainTypeRaw: typeResult.map[vault] === undefined ? null : typeResult.map[vault],
        match: live.resolverResolved && typeResult.map[vault] !== null && typeResult.map[vault] !== undefined
          ? typeResult.map[vault] === live.vaultTypeRaw : null,
      },
      implementationLogic: structural.implementationLogic,
      deployBlock: structural.deployBlock,
      resolverResolved: live.resolverResolved === true,
      isSmartCol: structural.isSmartCol,
      isSmartDebt: structural.isSmartDebt,
      supplyToken0: structural.supplyToken0,
      supplyToken1: structural.supplyToken1,
      borrowToken0: structural.borrowToken0,
      borrowToken1: structural.borrowToken1,
      collateralFactorBps: structural.collateralFactorBps,
      liquidationThresholdBps: structural.liquidationThresholdBps,
      liquidationMaxLimitBps: structural.liquidationMaxLimitBps,
      liquidationPenaltyBps: structural.liquidationPenaltyBps,
      live: live.resolverResolved ? {
        vaultSupplyExchangePriceRaw: live.vaultSupplyExchangePriceRaw,
        vaultBorrowExchangePriceRaw: live.vaultBorrowExchangePriceRaw,
        liquiditySupplyExchangePriceRaw: live.liquiditySupplyExchangePriceRaw,
        liquidityBorrowExchangePriceRaw: live.liquidityBorrowExchangePriceRaw,
        lastStoredLiquiditySupplyExchangePriceRaw: live.lastStoredLiquiditySupplyExchangePriceRaw,
        lastStoredLiquidityBorrowExchangePriceRaw: live.lastStoredLiquidityBorrowExchangePriceRaw,
        supplyRateLiquidityRaw: live.supplyRateLiquidityRaw,
        borrowRateLiquidityRaw: live.borrowRateLiquidityRaw,
        totalSupplyVaultRaw: live.totalSupplyVaultRaw,
        totalBorrowVaultRaw: live.totalBorrowVaultRaw,
        totalSupplyLiquidityOrDexRaw: live.totalSupplyLiquidityOrDexRaw,
        totalBorrowLiquidityOrDexRaw: live.totalBorrowLiquidityOrDexRaw,
        absorbedSupplyRaw: live.absorbedSupplyRaw,
        absorbedBorrowRaw: live.absorbedBorrowRaw,
        oraclePriceOperateRaw: live.oraclePriceOperateRaw,
        oraclePriceLiquidateRaw: live.oraclePriceLiquidateRaw,
        totalPositions: live.totalPositions,
      } : null,
      ltPosture,
      negativemaxLens: structural.negativemaxLens,
      eip1967: eip1967.map[vault] || null,
      priority: priorPriority.get(`${chainId}:${vault}`) || null,
    });
  }

  ci.finalizedAtLastRun = finalizedNumber;
  persistIndex(index, indexPath, fsImpl);

  const surfaceT2T4 = vaultRows.filter((r) => r.typeNumber === 2 || r.typeNumber === 4);
  const nearLt = vaultRows.filter((r) => r.ltPosture && (r.ltPosture.ltReadiness === "NEAR_LT" || r.ltPosture.ltReadiness === "AT_OR_ABOVE_LT"));
  const unresolvedLt = vaultRows.filter((r) => r.ltPosture && r.ltPosture.ltReadiness === "UNRESOLVED_NO_DEEPER_READ");
  const typeMismatch = vaultRows.filter((r) => r.typeDoubleBind && r.typeDoubleBind.match === false);
  const liveCoveredByEvents = selected.filter((v) => ci.eventVaultDeployed.vaults[v]).length;

  const chainRequests = REQUEST_COUNT - chainStartRequests;
  const blockers = [];
  if (!resolverCodeOk) blockers.push("resolver-unresolved");
  if (inventory.addresses.length === 0) blockers.push("inventory-empty");
  if (liveResult.failures > 0) blockers.push("live-read-partial-failure");
  if (eventEnum.failedWindows > 0) blockers.push("event-window-failure");
  if (unresolvedLt.length === vaultRows.length && vaultRows.length > 0) blockers.push("all-lt-unresolved");
  const complete = resolverCodeOk && inventory.addresses.length > 0 && eventEnum.failedWindows === 0;

  return {
    chainId,
    label: chain.label,
    pin: { number: finalizedNumber, hash: finalizedBlock.hash, timestamp: toIso(finalizedBlock.timestamp), finality: "finalized" },
    factory,
    resolver,
    resolverCodeOk,
    deploymentLogics: deployments.deploymentLogics,
    floor: ci.floor,
    inventory: {
      totalVaults: inventory.count,
      addressesResolved: inventory.addresses.length,
      reusedFromIndex: reused.inventory,
      surfaced: vaultRows.length,
      prioritySource: priorPriority.size > 0 ? "prior-phase0-totalBorrowUsd" : "vaultId-ascending",
    },
    implementationMap: {
      live: implementationMap.map,
      logSetVaultDeploymentLogicEvents: ci.implementationLogicEvents.count,
      eventWindowCovered: eventEnum.windowCount,
    },
    events: {
      boundedLookback: { from: eventEnum.from, to: eventEnum.to, windowCount: eventEnum.windowCount },
      vaultDeployedObserved: ci.eventVaultDeployed.count,
      vaultDeployedInSurfacedSet: liveCoveredByEvents,
      failedWindows: eventEnum.failedWindows,
      remainingWindows: eventEnum.remainingWindows,
      windowsFetched: eventEnum.windowsFetched,
      windowsCached: eventEnum.windowsCached,
      verifyReRead: eventEnum.verification,
    },
    eip1967: {
      factory: eip1967.map[factory] || null,
      surfacedClassified: vaultRows.filter((r) => r.eip1967).map((r) => ({ vault: r.vault, classification: r.eip1967.classification })),
      note: "Fluid vaults are CREATE-deployed, not EIP1967 proxies; a zero slot (ZERO_NOT_PROXY) is the expected honest record.",
    },
    totals: {
      surfaced: vaultRows.length,
      resolverResolved: vaultRows.filter((r) => r.resolverResolved).length,
      typeCounts: vaultRows.reduce((acc, r) => { const k = r.typeNumber === null ? "unresolved" : `T${r.typeNumber}`; acc[k] = (acc[k] || 0) + 1; return acc; }, {}),
      negativeMaxSurfaced: surfaceT2T4.length,
      nearLtSurfaced: nearLt.length,
      unresolvedLtSurfaced: unresolvedLt.length,
      typeDoubleBindMismatches: typeMismatch.length,
    },
    reads: {
      chainRequests,
      liveMulticallRequests: liveResult.requests,
      liveMulticallFailures: liveResult.failures,
      reused: { ...reused, structuralRowsUpdated: structuralUpdated },
    },
    vaults: vaultRows,
    coverage: { complete, blockers },
  };
}

// --- orchestration ------------------------------------------------------------------------
async function scan(options = {}) {
  const startMs = Date.now();
  const fsImpl = options.fsImpl || fs;
  const indexPath = options.indexPath || INDEX_PATH;
  const index = options.index || loadIndex(indexPath, fsImpl);
  const full = options.full === true;
  if (full) {
    for (const state of Object.values(index.chains)) {
      state.floor = null;
      state.inventory = { count: 0, addresses: [] };
      state.implementationMap = {};
      state.implementationLogicEvents = { count: 0, rows: [] };
      state.eventWindows = {};
      state.eventVaultDeployed = { count: 0, vaults: {} };
      state.vaultStructural = {};
      state.eip1967 = {};
    }
  }
  const prior = loadPriorPriority();
  index.priorPhase0Loaded = prior.loaded;
  const previousRunCount = Number(index.runCount || 0);
  const runNumber = previousRunCount + 1;
  const reusedIndex = previousRunCount > 0;
  const previousCsvSha = index.lastCsvSha256;

  const chainIds = options.chainIds || Object.keys(CHAINS).map(Number);
  const chains = [];
  for (const chainId of chainIds) {
    const rpc = options.rpcFor ? options.rpcFor(chainId) : await resolveWorkingRpc(chainId);
    if (!rpc) {
      chains.push({
        chainId,
        label: CHAINS[chainId] ? CHAINS[chainId].label : `c${chainId}`,
        error: "no-rpc",
        coverage: { complete: false, blockers: ["rpc-unavailable"] },
      });
      continue;
    }
    try {
      chains.push(await scanChain({ chainId, rpc, index, fsImpl, indexPath, full, priorPriority: prior.priority }));
    } catch (e) {
      chains.push({
        chainId,
        label: CHAINS[chainId] ? CHAINS[chainId].label : `c${chainId}`,
        error: sanitizeError(e, "scan-error"),
        coverage: { complete: false, blockers: ["scan-error"] },
      });
    }
  }

  index.runCount = runNumber;
  index.lastRunAt = new Date().toISOString();
  persistIndex(index, indexPath, fsImpl);

  // Canonical CSV: structural rows only (deterministic from the cached index),
  // sorted by (chainId, vault). Live state is JSON-only by design, so a second
  // run that reuses the cache reproduces byte-identical CSV.
  const csvRows = [];
  for (const c of chains) {
    for (const r of c.vaults || []) {
      csvRows.push(csvRowFor({
        chainId: c.chainId,
        label: c.label,
        vault: r.vault,
        structural: {
          vaultId: r.vaultId,
          vaultTypeRaw: r.vaultTypeRaw,
          typeLabel: r.typeLabel,
          implementationLogic: r.implementationLogic,
          deployBlock: r.deployBlock,
          negativemaxLens: r.negativemaxLens,
          liquidationThresholdBps: r.liquidationThresholdBps,
          collateralFactorBps: r.collateralFactorBps,
          liquidationMaxLimitBps: r.liquidationMaxLimitBps,
          liquidationPenaltyBps: r.liquidationPenaltyBps,
          isSmartCol: r.isSmartCol,
          isSmartDebt: r.isSmartDebt,
          supplyToken0: r.supplyToken0,
          supplyToken1: r.supplyToken1,
          borrowToken0: r.borrowToken0,
          borrowToken1: r.borrowToken1,
          resolverResolved: r.resolverResolved,
        },
        eip1967: r.eip1967,
      }));
    }
  }
  csvRows.sort((a, b) => (a.chainId - b.chainId) || String(a.vault).localeCompare(String(b.vault)));
  const csvPath = options.csvPath || CSV_PATH;
  const csvWrite = writeCsv(csvRows, csvPath, fsImpl);
  const csvByteIdentical = previousCsvSha !== null && previousCsvSha === csvWrite.sha256;
  index.lastCsvSha256 = csvWrite.sha256;
  index.lastCsvRowCount = csvWrite.rowCount;
  persistIndex(index, indexPath, fsImpl);

  const wallMs = Date.now() - startMs;
  const surfacedRows = chains.reduce((s, c) => s + ((c.vaults && c.vaults.length) || 0), 0);
  const negativeMaxRows = chains.reduce((s, c) => s + ((c.totals && c.totals.negativeMaxSurfaced) || 0), 0);
  const nearLtRows = chains.reduce((s, c) => s + ((c.totals && c.totals.nearLtSurfaced) || 0), 0);
  const unresolvedLtRows = chains.reduce((s, c) => s + ((c.totals && c.totals.unresolvedLtSurfaced) || 0), 0);
  const inventoryTotal = chains.reduce((s, c) => s + ((c.inventory && c.inventory.addressesResolved) || 0), 0);
  const surfacedResolved = chains.reduce((s, c) => s + ((c.totals && c.totals.resolverResolved) || 0), 0);

  const honestAbsences = [];
  honestAbsences.push("The T2/T4 negative-max lens is a compile fact of the in-tree pin; NO live confirmation is available from this surface. Every T2/T4 row is labelled liveVerification: NONE_COMPILE_FACT_ONLY.");
  honestAbsences.push("The near-LT posture is an aggregate proxy (debt / oracle-valued collateral); the vault's true liquidation trigger is per-position tick-based and is not derived here.");
  honestAbsences.push("The factory does not emit a `LogUpdateVaultTypeImplementation` event; the per-type implementation map is bound by the live isVaultDeploymentLogic view plus the real `LogSetVaultDeploymentLogic` event and the in-tree per-type deployment-logic files.");
  honestAbsences.push("Full-history `VaultDeployed` enumeration is out of the per-chain request budget; the live factory view (totalVaults/getVaultAddress) is authoritative and the event scan is a bounded recent cross-check only.");
  if (unresolvedLtRows > 0) honestAbsences.push(`${unresolvedLtRows} surfaced vault(s) have an unresolved LT posture (no oracle price / no collateral / scale suspect): recorded UNRESOLVED_NO_DEEPER_READ, never guessed.`);

  const artifact = {
    schema: ARTIFACT_SCHEMA,
    scannedAt: new Date().toISOString(),
    scanner: "tools/scan-fluid-l.js",
    scope: "Read-only Fluid Vault live-set + liquidation-readiness observation producer (L class)",
    safety: {
      readOnly: true, signedActions: false, transactions: false, endpointMaterialPersisted: false,
      privateKeysRead: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false,
    },
    reference: {
      deploymentMap: "targets/fluid-contracts-public/deployments/<folder>/*.json",
      factory: "targets/fluid-contracts-public/contracts/protocols/vault/factory/main.sol:362 (FluidVaultFactory)",
      deploymentLogics: "contracts/protocols/vault/factory/deploymentLogics/vaultT{1,2,3,4}Logic.sol",
      vaultTypes: "contracts/libraries/fluidProtocolTypes.sol:10-13",
      resolverShape: "contracts/periphery/resolvers/vault/structs.sol (VaultEntireData)",
      liquidityCalcs: "contracts/libraries/liquidityCalcs.sol:17,76-78,187,196-197 (exchange-price consumption surface)",
      adminEvents: "contracts/protocols/vault/vaultTypesCommon/adminModule/events.sol (LogUpdateLiquidationThreshold/LogUpdateCollateralFactor/...)",
      negativeMaxFinding: `${NEGATIVE_MAX_REPORT} (FLUID-VT2T4-L01)`,
      negativeMaxSources: [
        "contracts/protocols/vault/vaultT2/coreModule/mainOperate.sol:51",
        "contracts/protocols/vault/vaultT4/coreModule/mainOperate.sol:88",
      ],
    },
    conventions: {
      maxVaultsPerChain: MAX_VAULTS_PER_CHAIN,
      window: WINDOW,
      minWindow: MIN_WINDOW,
      maxEventWindows: MAX_EVENT_WINDOWS,
      requestBudget: REQUEST_BUDGET,
      nearLtBand: "aggregateLtvBps >= 95% of liquidationThresholdBps => NEAR_LT; >= LT => AT_OR_ABOVE_LT",
      typeMap: VAULT_TYPES,
      priorityRule: "prior scan-fluid-lending-phase0 totalBorrowUsd desc (chainId:address), vaultId asc tie-break",
      csvDeterminism: "CSV rows are structural (cached index); live state is JSON-only so a resuming second run reproduces byte-identical CSV.",
    },
    budget: {
      requestBudgetPerChain: REQUEST_BUDGET,
      requests: REQUEST_COUNT,
      maxChainRequests: Math.max(0, ...chains.map((c) => (c.reads && c.reads.chainRequests) || 0)),
      withinBudget: chains.every((c) => !c.reads || c.reads.chainRequests <= REQUEST_BUDGET),
      wallMs,
      sequential: true,
      runNumber,
      secondRun: runNumber >= 2,
      reusedIndex,
      priorPhase0Loaded: prior.loaded,
    },
    csv: {
      path: relPosix(csvPath),
      rowCount: csvWrite.rowCount,
      sha256: csvWrite.sha256,
      canonicalHash: canonicalHash(csvRows),
      bounded: true,
      byteIdenticalToPreviousRun: csvByteIdentical,
      previousRunSha256: previousCsvSha,
    },
    totals: {
      chainsRequested: chainIds.length,
      chainsScanned: chains.filter((c) => !c.error).length,
      inventoryVaults: inventoryTotal,
      surfacedVaults: surfacedRows,
      surfacedResolverResolved: surfacedResolved,
      negativeMaxSurfaced: negativeMaxRows,
      nearLtSurfaced: nearLtRows,
      unresolvedLtSurfaced: unresolvedLtRows,
      requests: REQUEST_COUNT,
    },
    chains,
    coverage: {
      complete: chains.length > 0 && chains.every((c) => !c.error && c.coverage && c.coverage.complete),
      blockers: [...new Set(chains.flatMap((c) => (c.coverage && c.coverage.blockers) || (c.error ? [c.error] : [])))],
      honestAbsences,
    },
  };
  return artifact;
}

async function runAndPublish(options = {}) {
  const artifact = await scan(options);
  atomicWriteJson(options.artifactPath || ARTIFACT_PATH, artifact, options.fsImpl || fs);
  return artifact;
}

function parseArgs(argv) {
  const modes = new Set(argv.filter((value) => value.startsWith("--")));
  const unknown = [...modes].filter((value) => !["--full", "--once", "--sync", "--chain"].includes(value));
  if (unknown.length) throw new ScanFailure("USAGE");
  const chainArgIndex = argv.indexOf("--chain");
  let chainIds = Object.keys(CHAINS).map(Number);
  if (chainArgIndex !== -1) {
    const value = argv[chainArgIndex + 1];
    const byLabel = { ethereum: 1, mainnet: 1, base: 8453, arbitrum: 42161, polygon: 137 };
    chainIds = byLabel[value] ? [byLabel[value]] : [Number(value)];
    if (chainIds.some((c) => !CHAINS[c])) throw new ScanFailure("USAGE");
  }
  return { full: modes.has("--full"), sync: modes.has("--sync"), chainIds };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const fsImpl = fs;
  if (options.sync) {
    const index = loadIndex(INDEX_PATH, fsImpl);
    const lines = Object.values(index.chains).map((c) => `${c.chainId}:vaults=${(c.inventory && c.inventory.addresses || []).length},struct=${Object.keys(c.vaultStructural || {}).length},floor=${c.floor ? c.floor.block : "n/a"}`);
    process.stdout.write(`fluid-l[sync] runs=${index.runCount} chains=${Object.keys(index.chains).length} ${lines.join(" ")}\n`);
    return;
  }
  const artifact = await runAndPublish({ chainIds: options.chainIds, full: options.full });
  const summary = {
    status: "OK",
    scannedAt: artifact.scannedAt,
    runNumber: artifact.budget.runNumber,
    secondRun: artifact.budget.secondRun,
    reusedIndex: artifact.budget.reusedIndex,
    requests: artifact.totals.requests,
    withinBudget: artifact.budget.withinBudget,
    csv: artifact.csv.path,
    csvRowCount: artifact.csv.rowCount,
    csvByteIdenticalToPreviousRun: artifact.csv.byteIdenticalToPreviousRun,
    inventoryVaults: artifact.totals.inventoryVaults,
    surfacedVaults: artifact.totals.surfacedVaults,
    negativeMaxSurfaced: artifact.totals.negativeMaxSurfaced,
    nearLtSurfaced: artifact.totals.nearLtSurfaced,
    unresolvedLtSurfaced: artifact.totals.unresolvedLtSurfaced,
    chains: artifact.chains.map((c) => ({
      chainId: c.chainId,
      label: c.label,
      error: c.error || null,
      inventory: c.inventory ? c.inventory.addressesResolved : 0,
      surfaced: c.totals ? c.totals.surfaced : 0,
      negativeMax: c.totals ? c.totals.negativeMaxSurfaced : 0,
      nearLt: c.totals ? c.totals.nearLtSurfaced : 0,
      chainRequests: c.reads ? c.reads.chainRequests : 0,
      complete: c.coverage ? c.coverage.complete : false,
    })),
    coverage: artifact.coverage,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`fluid-l scan failed: ${error && error.code ? error.code : "SCAN_FAILED"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE, ARTIFACT_PATH, CSV_PATH, INDEX_PATH, DEPLOYMENTS, PRIOR_PHASE0, NEGATIVE_MAX_REPORT,
  ARTIFACT_SCHEMA, INDEX_SCHEMA, VERSION, MULTICALL3, EIP1967_IMPL_SLOT, ZERO, CHAINS, VAULT_TYPES,
  MAX_VAULTS_PER_CHAIN, WINDOW, MIN_WINDOW, MAX_EVENT_WINDOWS, REQUEST_BUDGET, MC_BATCH_LIGHT, MC_BATCH_HEAVY,
  EVENT_SIGNATURES, VAULT_DEPLOYED_TOPIC, LOG_SET_VAULT_DEPLOYMENT_LOGIC_TOPIC, I,
  ScanFailure, sleep, hexBlock, relPosix, lower, isZeroAddr, canonicalHash, toIso, big, ustr, readJson,
  call, selectFinalized, resolveWorkingRpc, decodeOrNull, readCode, readCall,
  loadChainDeployments, multicall, binarySearchCodeFloor, proveHistoryStartBound, fetchRange, fetchRangeBounded, enumerateRecentWindows,
  emptyChainIndex, emptyIndex, loadIndex, persistIndex, loadPriorPriority,
  readInventory, readImplementationMap, readEip1967, negativeMaxLens, computeLtPosture, parseEntire, readVaultLive, readVaultTypes,
  atomicWriteJson, CSV_HEADER, writeCsv, csvRowFor, scanChain, scan, runAndPublish, parseArgs, main,
};
