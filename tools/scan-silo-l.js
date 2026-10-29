#!/usr/bin/env node
"use strict";

// Silo V3 market (lending) live-set + liquidation-readiness observation producer
// (L class).
//
// Mirrors the established L-class observation-producer conventions
// (tools/scan-euler-l.js, tools/scan-aave-v3-l2-outage-l.js, tools/scan-twyne-l.js,
// tools/scan-pendle-l.js, tools/scan-eulerswap-l.js, tools/scan-fluid-l.js):
//   * Multicall3-batched state reads, fail-closed (a null/revert is unresolved,
//     never a default),
//   * adaptive resumable windows (bounded recent cross-check; the live factory
//     view is authoritative for the market set),
//   * atomic artifact writes, canonical CSV + sha256, process-only endpoints,
//   * sequential reads, no signing, no transactions, no private-key material.
//
// Purpose (standing-order class anchor: the in-tree verified Silo v3 defaulting
// / staleness / share-offset lens, reports/critical-silo-v3-step1-source.md and
// reports/critical-silo-v3-phase0-gate-check.md): surface the LIVE Silo V3 market
// set and its per-market liquidation posture, honestly labelled.
//
// Resolution rules (no new doc pages fetched; anchors are in-tree only):
//   * The market set is the factory's own live view: getNextSiloId() +
//     idToSiloConfig(id) (silo-core/deployments/<folder>/SiloFactory.sol.json).
//     A BOUNDED recent `NewSilo` event scan (adaptive resumable windows) is a
//     cross-check only.
//   * Per-market per-side config is SiloConfig.getConfig(silo) (ISiloConfig
//     ConfigData, silo-core/contracts/interfaces/ISiloConfig.sol:97-115): the two
//     oracles (solvencyOracle/maxLtvOracle), LT/maxLtv/liquidationTargetLtv/
//     liquidationFee, hookReceiver, callBeforeQuote, and the three share tokens.
//   * The hook class is bound by the on-chain hookReceiver: the receiver's own
//     VERSION() read plus the deployed SiloHookV1/V2/V3 addresses and the
//     PendleRewardsClaimer `pendleMarket()` getter. defaultingEnabled is
//     V2/V3->true, V1/pendle->false (SiloHookV1 = PartialLiquidation; SiloHookV2/3
//     = PartialLiquidationByDefaulting). V3 is the "disabled-standard" hook: its
//     LT_MARGIN_FOR_DEFAULTING() returns 0 and its `liquidationCall` reverts
//     NotSupported (silo-core/contracts/hooks/SiloHookV3.sol:10-32).
//   * The oracle class is bound by the oracle's own VERSION() read. ChainlinkV3
//     oracles are classified chainlink-no-staleness: the source ignores the
//     heartbeat argument (`uint256 /* _heartbeat */`,
//     silo-oracles/contracts/chainlinkV3/ChainlinkV3Oracle.sol:108-120).
//   * Share decimals offset is read from each collateral share token's
//     decimalsOffset() (SiloMathLib._DECIMALS_OFFSET = 3,
//     silo-core/contracts/lib/SiloMathLib.sol:15; ShareDebtToken overrides to 0).
//   * Near-LT posture: bounded borrower discovery from recent `Borrow` events on
//     the surfaced silos, then SiloLens.getUsersHealth(Borrower[]) for the
//     {lt,ltv} band per borrower (silo-core/contracts/SiloLens.sol:81-90).
//
// Honest unknowns (never fabricated):
//   * The near-LT posture is a live per-borrower {ltv,lt} band. It is NOT a
//     future strategy label; every row is labelled stratLabel: NONE.
//   * `oracleStalenessGuarded` is only asserted false for ChainlinkV3 (source
//     fact); for every other class it is UNKNOWN (never guessed).
//   * Borrower discovery is a BOUNDED recent event window; it is not a complete
//     holder census.
//
// Read-only. RPC material stays process-only and is never printed or persisted.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc, loadRpcUrls, sanitizeError } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const ARTIFACT_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "silo-l.json");
const CSV_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "silo-l.csv");
const INDEX_PATH = path.join(WORKSPACE, "reports", "monitor", "silo-l-index.json");
const DEPLOYMENTS = path.join(WORKSPACE, "targets", "silo-contracts-v3-8e2c1b6283ab", "silo-core", "deployments");
const SILO_DEPLOYMENTS_REGISTRY = path.join(WORKSPACE, "targets", "silo-contracts-v3-8e2c1b6283ab", "silo-core", "deploy", "silo", "_siloDeployments.json");
const PHASE0_REPORT = "reports/critical-silo-v3-phase0-gate-check.md";
const STEP1_REPORT = "reports/critical-silo-v3-step1-source.md";
const PENDLE_L_REFERENCE = "reports/raw/fast/pendle-l.json";

const ARTIFACT_SCHEMA = "silo-l-observation/v1";
const INDEX_SCHEMA = "silo-l-index/v1";
const VERSION = 1;

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ZERO = "0x0000000000000000000000000000000000000000";

// In-scope chains (Ethereum mainnet FIRST; Arbitrum then Base).
const CHAINS = Object.freeze({
  1: Object.freeze({ chainId: 1, label: "ethereum", folder: "mainnet", registryKey: "mainnet" }),
  42161: Object.freeze({ chainId: 42161, label: "arbitrum", folder: "arbitrum_one", registryKey: "arbitrum_one" }),
  8453: Object.freeze({ chainId: 8453, label: "base", folder: "base", registryKey: "base" }),
});
// Explicit chain priority (numeric keys are otherwise auto-sorted ascending).
const CHAIN_PRIORITY = Object.freeze([1, 42161, 8453]);

// Bounds / conventions.
const MAX_MARKETS_PER_CHAIN = 40;     // surfaced (prioritized) market cap per chain
const MAX_UNION_PER_CHAIN = 140;      // bounded pre-filter union (registry + factory window)
const MAX_ACCOUNTS_PER_MARKET = 20;   // borrower cap per market
const MAX_ACCOUNTS_PER_CHAIN = 120;   // borrower cap per chain (bounded posture read)
const WINDOW = 10_000;                // bounded recent event-scan base window
const MIN_WINDOW = 1_000;             // adaptive split floor
const MAX_EVENT_WINDOWS = 8;          // bounded recent event-scan window budget (factory)
const MAX_BORROW_WINDOWS = 40;        // bounded recent borrower-discovery window budget
const REQUEST_BUDGET = 240;           // bounded requests per chain per run
const MC_BATCH_LIGHT = 200;           // cheap view batching
const MC_BATCH_HEAVY = 10;            // heavy lens batching
const TIMEOUT_MS = 30_000;
const LT_NEAR_PCT = 95n;              // near-LT band = 95% of liquidation threshold

// Hook deployment roles resolved per chain from the in-tree deployments map.
const HOOK_ROLES = Object.freeze(["SiloHookV1", "SiloHookV2", "SiloHookV3"]);

const EVENT_SIGNATURES = Object.freeze({
  NewSilo: "NewSilo(address,address,address,address,address,address)",
  Borrow: "Borrow(address,address,address,uint256,uint256)",
});
const NEW_SILO_TOPIC = ethers.id(EVENT_SIGNATURES.NewSilo);
const BORROW_TOPIC = ethers.id(EVENT_SIGNATURES.Borrow);

const I = Object.freeze({
  factory: new ethers.Interface([
    "function getNextSiloId() view returns (uint256)",
    "function idToSiloConfig(uint256 id) view returns (address)",
    "function isSilo(address silo) view returns (bool)",
    "function VERSION() view returns (string)",
  ]),
  config: new ethers.Interface([
    "function getSilos() view returns (address,address)",
    "function getConfig(address _silo) view returns ((uint256,uint256,address,address,address,address,address,address,address,address,uint256,uint256,uint256,uint256,uint256,address,bool))",
    "function SILO_ID() view returns (uint256)",
    "function getAssetForSilo(address _silo) view returns (address)",
  ]),
  silo: new ethers.Interface([
    "function asset() view returns (address)",
    "function factory() view returns (address)",
    "function getLiquidity() view returns (uint256)",
    "function getSiloStorage() view returns (uint192,uint64,uint256,uint256,uint256)",
    "function getTotalAssetsStorage(uint8 _assetType) view returns (uint256)",
    "function config() view returns (address)",
  ]),
  share: new ethers.Interface([
    "function decimalsOffset() view returns (uint256)",
    "function VERSION() view returns (string)",
    "function symbol() view returns (string)",
  ]),
  hook: new ethers.Interface([
    "function VERSION() view returns (string)",
    "function pendleMarket() view returns (address)",
    "function LT_MARGIN_FOR_DEFAULTING() view returns (uint256)",
    "function liquidationCall(address,address,address,uint256,bool) returns (uint256,uint256)",
  ]),
  oracle: new ethers.Interface([
    "function VERSION() view returns (string)",
    "function quoteToken() view returns (address)",
  ]),
  lens: new ethers.Interface([
    "function getUsersHealth((address,address)[] _borrowers) view returns ((uint256,uint256)[] healths)",
    "function getLtv(address _silo, address _borrower) view returns (uint256)",
    "function isSolvent(address _silo, address _borrower) view returns (bool)",
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
function ratio18(value) { try { return Number(big(value)) / 1e18; } catch (_) { return null; } }

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

async function readStorage(rpc, address, slot, blockTag) {
  try { const value = await call(rpc, "eth_getStorageAt", [address, slot, blockTag]); return typeof value === "string" ? value : null; }
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
  const factoryJson = readJson(path.join(dir, "SiloFactory.sol.json"));
  const lensJson = readJson(path.join(dir, "SiloLens.sol.json"));
  const factory = factoryJson ? lower(factoryJson.address) : null;
  const factoryDeployBlock = factoryJson && factoryJson.receipt && Number.isFinite(Number(factoryJson.receipt.blockNumber))
    ? Number(factoryJson.receipt.blockNumber) : null;
  const lens = lensJson ? lower(lensJson.address) : null;
  const hooks = {};
  for (const role of HOOK_ROLES) {
    const j = readJson(path.join(dir, `${role}.sol.json`));
    hooks[role] = j ? lower(j.address) : null;
  }
  return { factory, factoryDeployBlock, lens, hooks };
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
// The in-tree deployment receipt may carry the factory deploy block. Prove it on
// chain (runtime absent one block before, present at it). When the receipt block
// is missing, fall back to a bounded eth_getCode binary search.
async function binarySearchCodeFloor(rpc, address, lo, hi) {
  let low = lo;
  let high = hi;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    const code = await readCode(rpc, address, hexBlock(mid));
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
        note: "targets/silo-contracts-v3... deployments receipt block verified on chain: factory runtime absent one block before the floor and present at it.",
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
async function enumerateRecentWindows(index, doneKey, { rpc, address, topics, to, onLogs, persist, windowBudget = MAX_EVENT_WINDOWS }) {
  const done = index[doneKey] && typeof index[doneKey] === "object" ? index[doneKey] : (index[doneKey] = {});
  const from = Math.max(0, to - windowBudget * WINDOW + 1);
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
    lens: null,
    hookDeployments: { SiloHookV1: null, SiloHookV2: null, SiloHookV3: null },
    floor: null,
    inventory: { nextSiloId: null, ids: [], configs: [] },
    structural: {},
    borrowerAccounts: {},
    eventWindows: {},
    borrowWindows: {},
    eventNewSilo: { count: 0, markets: {} },
    eventBorrow: { count: 0, accounts: {} },
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
        hookDeployments: { ...base.hookDeployments, ...(state.hookDeployments || {}) },
        inventory: { nextSiloId: null, ids: [], configs: [], ...(state.inventory || {}) },
        structural: state.structural || {},
        borrowerAccounts: state.borrowerAccounts || {},
        eventWindows: state.eventWindows || {},
        borrowWindows: state.borrowWindows || {},
        eventNewSilo: { count: 0, markets: {}, ...(state.eventNewSilo || {}) },
        eventBorrow: { count: 0, accounts: {}, ...(state.eventBorrow || {}) },
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

// --- classification helpers ---------------------------------------------------------------
function parseHookClass({ version, knownClass, pendleMarket }) {
  if (pendleMarket && !isZeroAddr(pendleMarket)) return "pendle";
  if (version) {
    if (/SiloHookV3/i.test(version)) return "v3";
    if (/SiloHookV2/i.test(version)) return "v2";
    if (/SiloHookV1/i.test(version)) return "v1";
    if (/PendleRewardsClaimer/i.test(version)) return "pendle";
  }
  if (knownClass) return knownClass;
  return version ? `other:${version}` : "unknown-no-version";
}

function defaultingForClass(hookClass) {
  if (hookClass === "v2" || hookClass === "v3") return true;
  if (hookClass === "v1" || hookClass === "pendle") return false;
  return null;
}

function classifyOracle(version) {
  if (!version) return "unknown-no-version";
  const v = String(version).toLowerCase();
  if (v.includes("chainlink")) return "chainlink-no-staleness";
  if (v.includes("manageable")) return "managed";
  if (v.includes("ptlinear") || v.includes("pendle") || /\bpt\b/.test(v)) return "pendle-pt";
  if (v.includes("custommethod")) return "custom-method";
  if (v.includes("dia")) return "dia";
  if (v.includes("erc4626")) return "erc4626";
  if (v.includes("flatprice")) return "flat-price";
  if (v.includes("uniswap")) return "uniswap-v3";
  if (v.includes("supra")) return "supra";
  if (v.includes("dualoracle")) return "dual";
  if (v.includes("scaler")) return "scaler";
  if (v.includes("forwarder")) return "forwarder";
  if (v.includes("reverting")) return "reverting";
  return "other";
}

// ChainlinkV3 ignores the heartbeat (no staleness bound); other classes UNKNOWN.
function oracleStalenessGuarded(oracleClass) {
  if (oracleClass === "chainlink-no-staleness") return false;
  return null;
}

function parseConfigData(decoded) {
  const row = decoded?.[0];
  if (!row) return null;
  return {
    daoFeeRaw: ustr(row[0]),
    deployerFeeRaw: ustr(row[1]),
    silo: lower(row[2]),
    token: lower(row[3]),
    protectedShareToken: lower(row[4]),
    collateralShareToken: lower(row[5]),
    debtShareToken: lower(row[6]),
    solvencyOracle: lower(row[7]),
    maxLtvOracle: lower(row[8]),
    interestRateModel: lower(row[9]),
    maxLtvRaw: ustr(row[10]),
    ltRaw: ustr(row[11]),
    liquidationTargetLtvRaw: ustr(row[12]),
    liquidationFeeRaw: ustr(row[13]),
    flashloanFeeRaw: ustr(row[14]),
    hookReceiver: lower(row[15]),
    callBeforeQuote: row[16] === true,
    maxLtv: ratio18(row[10]),
    lt: ratio18(row[11]),
    liquidationTargetLtv: ratio18(row[12]),
    liquidationFee: ratio18(row[13]),
  };
}

// --- inventory ----------------------------------------------------------------------------
// In-tree market registry: _siloDeployments.json values are SiloConfig addresses
// (verified: getSilos()/SILO_ID() respond, asset()/config() do not).
function loadRegistry(registryKey) {
  const j = readJson(SILO_DEPLOYMENTS_REGISTRY);
  if (!j || !j[registryKey] || typeof j[registryKey] !== "object") return [];
  const out = [];
  for (const [name, addr] of Object.entries(j[registryKey])) {
    const config = lower(addr);
    if (config) out.push({ id: null, config, name, source: "registry" });
  }
  return out;
}

async function readInventory(rpc, blockTag, factory, registryConfigs) {
  const nextRaw = await readCall(rpc, factory, I.factory, "getNextSiloId", [], blockTag);
  const nextSiloId = nextRaw ? Number(big(nextRaw[0])) : null;
  if (!Number.isFinite(nextSiloId) || nextSiloId < 0) throw new ScanFailure("INVENTORY_UNAVAILABLE");
  // Factory view: surface the most recent bounded window of ids (deterministic).
  const start = Math.max(0, nextSiloId - MAX_MARKETS_PER_CHAIN);
  const ids = [];
  for (let id = start; id < nextSiloId; id += 1) ids.push(id);
  const entries = ids.map((id) => ({ to: factory, data: I.factory.encodeFunctionData("idToSiloConfig", [id]) }));
  const mc = entries.length ? await multicall(rpc, blockTag, entries, MC_BATCH_LIGHT) : { results: [], failures: 0, requests: 0 };
  const factoryConfigs = [];
  ids.forEach((id, i) => {
    const item = mc.results[i];
    if (!item || item.success !== true) return;
    const d = decodeOrNull(I.factory, "idToSiloConfig", item.returnData);
    const config = d ? lower(d[0]) : null;
    if (config && !isZeroAddr(config)) factoryConfigs.push({ id, config, name: null, source: "factory-id-window" });
  });
  // Union: the bounded factory id window (most recent v3 ids) first, then the
  // in-tree registry (mixed legacy v2 + v3); dedup by config; bounded pre-filter.
  // The v3 factory binding is verified per market after getSilos (silo.factory()).
  const seen = new Set();
  const configs = [];
  for (const row of [...factoryConfigs, ...(registryConfigs || [])]) {
    if (seen.has(row.config)) continue;
    seen.add(row.config);
    configs.push(row);
  }
  const union = configs.slice(0, MAX_UNION_PER_CHAIN);
  return {
    nextSiloId,
    ids,
    configs: union,
    failures: mc.failures,
    requests: mc.requests,
    startId: start,
    skipped: start,
    registryConfigs: (registryConfigs || []).length,
    factoryConfigs: factoryConfigs.length,
    unionBeforeCap: configs.length,
    cappedAway: configs.length - union.length,
  };
}

// --- EIP1967 impl slot --------------------------------------------------------------------
async function readEip1967(rpc, blockTag, addresses) {
  const map = {};
  for (const a of addresses) {
    const slotValue = await readStorage(rpc, a, EIP1967_IMPL_SLOT, blockTag);
    let classification = "UNRESOLVED";
    let impl = null;
    if (typeof slotValue === "string" && /^0x[0-9a-f]{64}$/i.test(slotValue)) {
      impl = lower(`0x${slotValue.slice(26)}`);
      classification = impl && isZeroAddr(impl) ? "ZERO_NOT_PROXY" : "NONZERO_IMPLEMENTATION";
    }
    map[a] = { slotValue: typeof slotValue === "string" ? slotValue : null, implementation: impl, classification };
  }
  return map;
}

// --- per-chain scan -----------------------------------------------------------------------
async function scanChain({ chainId, rpc, index, fsImpl, indexPath, full }) {
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
  ci.lens = deployments.lens;
  ci.hookDeployments = deployments.hooks;

  const finalizedBlock = await selectFinalized(rpc);
  const finalizedNumber = Number(big(finalizedBlock.number));
  const blockTag = finalizedBlock.hash;
  const blockTimestamp = Number(big(finalizedBlock.timestamp));

  const reused = { floor: false, inventory: false, structural: false, eventWindows: false, eip1967: false };

  // Floor (cached unless --full).
  if (!ci.floor || ci.floor.proven !== true || full) {
    try {
      ci.floor = await proveHistoryStartBound(rpc, factory, finalizedNumber, deployments.factoryDeployBlock);
    } catch (_) {
      ci.floor = { block: null, proven: false, derivation: "unproven", note: "HISTORY_BOUND_UNPROVEN" };
    }
  } else { reused.floor = true; }

  // Inventory (live factory view + in-tree registry union; cached unless --full).
  const registryConfigs = loadRegistry(chain.registryKey);
  let inventory;
  if (!full && Array.isArray(ci.inventory.configs) && ci.inventory.configs.length > 0) {
    inventory = {
      nextSiloId: ci.inventory.nextSiloId,
      ids: ci.inventory.ids,
      configs: ci.inventory.configs,
      failures: 0,
      requests: 0,
      startId: ci.inventory.startId,
      skipped: ci.inventory.skipped,
      registryConfigs: ci.inventory.registryConfigs || 0,
      factoryConfigs: ci.inventory.factoryConfigs || 0,
      unionBeforeCap: ci.inventory.unionBeforeCap || ci.inventory.configs.length,
      cappedAway: ci.inventory.cappedAway || 0,
      v3Configs: ci.inventory.v3Configs || ci.inventory.configs.length,
      cappedAwayV3: ci.inventory.cappedAwayV3 || 0,
      nonV3Dropped: ci.inventory.nonV3Dropped || 0,
    };
    reused.inventory = true;
  } else {
    inventory = await readInventory(rpc, blockTag, factory, registryConfigs);
    ci.inventory = {
      nextSiloId: inventory.nextSiloId,
      ids: inventory.ids,
      configs: inventory.configs,
      startId: inventory.startId,
      skipped: inventory.skipped,
      registryConfigs: inventory.registryConfigs,
      factoryConfigs: inventory.factoryConfigs,
      unionBeforeCap: inventory.unionBeforeCap,
      cappedAway: inventory.cappedAway,
    };
  }

  // Per-market silos + per-side config (structural cache, refreshed only with --full).
  const marketSilos = new Map();
  const needStructural = full || Object.keys(ci.structural).length === 0;
  if (needStructural) {
    ci.structural = {};
    const configsAll = inventory.configs;
    const siloEntries = configsAll.map((c) => ({ to: c.config, data: I.config.encodeFunctionData("getSilos", []) }));
    const siloMc = siloEntries.length ? await multicall(rpc, blockTag, siloEntries, MC_BATCH_LIGHT) : { results: [], failures: 0, requests: 0 };
    for (let i = 0; i < configsAll.length; i += 1) {
      const item = siloMc.results[i];
      if (!item || item.success !== true) continue;
      const d = decodeOrNull(I.config, "getSilos", item.returnData);
      const silo0 = d ? lower(d[0]) : null;
      const silo1 = d ? lower(d[1]) : null;
      if (!silo0 || !silo1 || isZeroAddr(silo0) || isZeroAddr(silo1)) continue;
      marketSilos.set(configsAll[i].config, { silo0, silo1 });
    }
    // v3 factory binding: keep only configs whose Silo belongs to the v3 factory
    // (the in-tree registry is a MIXED legacy-v2 + v3 map; the factory binding is
    // the honest discriminator). Then bound to MAX_MARKETS_PER_CHAIN.
    const factoryEntries = [...marketSilos.entries()].map(([config, pair]) => ({ to: pair.silo0, data: I.silo.encodeFunctionData("factory", []), key: config }));
    const facMc = factoryEntries.length ? await multicall(rpc, blockTag, factoryEntries, MC_BATCH_LIGHT) : { results: [], failures: 0, requests: 0 };
    const factoryByConfig = {};
    factoryEntries.forEach((e, i) => {
      const item = facMc.results[i];
      factoryByConfig[e.key] = item && item.success === true ? lower(decodeOrNull(I.silo, "factory", item.returnData)?.[0]) : null;
    });
    const v3Configs = configsAll.filter((c) => marketSilos.has(c.config) && factoryByConfig[c.config] === factory);
    const cappedConfigs = v3Configs.slice(0, MAX_MARKETS_PER_CHAIN);
    inventory.configs = cappedConfigs;
    inventory.v3Configs = v3Configs.length;
    inventory.cappedAwayV3 = v3Configs.length - cappedConfigs.length;
    inventory.nonV3Dropped = configsAll.length - v3Configs.length;
    ci.inventory.configs = cappedConfigs;
    ci.inventory.v3Configs = v3Configs.length;
    ci.inventory.cappedAwayV3 = inventory.cappedAwayV3;
    ci.inventory.nonV3Dropped = inventory.nonV3Dropped;
    const configs = cappedConfigs;
    // SILO_ID per config (registry configs carry no factory id).
    const siloIdMc = configs.length ? await multicall(rpc, blockTag, configs.map((c) => ({ to: c.config, data: I.config.encodeFunctionData("SILO_ID", []) })), MC_BATCH_LIGHT) : { results: [], failures: 0, requests: 0 };
    const siloIdByConfig = {};
    configs.forEach((c, i) => {
      const item = siloIdMc.results[i];
      siloIdByConfig[c.config] = item && item.success === true ? Number(big(decodeOrNull(I.config, "SILO_ID", item.returnData)?.[0])) : null;
    });
    // getConfig for both sides (deduplicated across markets).
    const configEntries = [];
    for (const c of configs) {
      const pair = marketSilos.get(c.config);
      if (!pair) continue;
      configEntries.push({ to: c.config, data: I.config.encodeFunctionData("getConfig", [pair.silo0]), key: `${c.config}:${pair.silo0}` });
      configEntries.push({ to: c.config, data: I.config.encodeFunctionData("getConfig", [pair.silo1]), key: `${c.config}:${pair.silo1}` });
    }
    const cfgMc = configEntries.length ? await multicall(rpc, blockTag, configEntries, MC_BATCH_LIGHT) : { results: [], failures: 0, requests: 0 };
    const cfgByKey = {};
    configEntries.forEach((e, i) => {
      const item = cfgMc.results[i];
      const parsed = item && item.success === true ? parseConfigData(decodeOrNull(I.config, "getConfig", item.returnData)) : null;
      cfgByKey[e.key] = parsed;
    });
    // Hook + oracle + share-token metadata (deduplicated).
    const hookAddresses = new Set();
    const oracleAddresses = new Set();
    const shareAddresses = new Set();
    for (const key of Object.keys(cfgByKey)) {
      const cfg = cfgByKey[key];
      if (!cfg) continue;
      if (cfg.hookReceiver && !isZeroAddr(cfg.hookReceiver)) hookAddresses.add(cfg.hookReceiver);
      for (const o of [cfg.solvencyOracle, cfg.maxLtvOracle]) if (o && !isZeroAddr(o)) oracleAddresses.add(o);
      for (const s of [cfg.collateralShareToken, cfg.protectedShareToken, cfg.debtShareToken]) if (s && !isZeroAddr(s)) shareAddresses.add(s);
    }
    const hookInfo = await readHookInfo(rpc, blockTag, [...hookAddresses], deployments.hooks);
    const oracleInfo = await readOracleInfo(rpc, blockTag, [...oracleAddresses]);
    const shareInfo = await readShareInfo(rpc, blockTag, [...shareAddresses]);

    for (const c of configs) {
      const pair = marketSilos.get(c.config);
      if (!pair) continue;
      const sideFor = (silo) => {
        const cfg = cfgByKey[`${c.config}:${silo}`];
        if (!cfg) return { silo, resolved: false };
        const hook = cfg.hookReceiver ? hookInfo[cfg.hookReceiver] || null : null;
        const solvency = cfg.solvencyOracle ? oracleInfo[cfg.solvencyOracle] || null : null;
        const maxLtv = cfg.maxLtvOracle ? oracleInfo[cfg.maxLtvOracle] || null : null;
        const collateralShare = cfg.collateralShareToken ? shareInfo[cfg.collateralShareToken] || null : null;
        return {
          silo,
          resolved: true,
          asset: cfg.token,
          protectedShareToken: cfg.protectedShareToken,
          collateralShareToken: cfg.collateralShareToken,
          debtShareToken: cfg.debtShareToken,
          solvencyOracle: cfg.solvencyOracle,
          maxLtvOracle: cfg.maxLtvOracle,
          interestRateModel: cfg.interestRateModel,
          maxLtv: cfg.maxLtv,
          lt: cfg.lt,
          liquidationTargetLtv: cfg.liquidationTargetLtv,
          liquidationFee: cfg.liquidationFee,
          callBeforeQuote: cfg.callBeforeQuote,
          hookReceiver: cfg.hookReceiver,
          hookClass: hook ? hook.hookClass : null,
          hookClassBinding: hook ? hook.hookClassBinding : null,
          hookCodeBytes: hook ? hook.hookCodeBytes : null,
          cloneImplementation: hook ? hook.cloneImplementation : null,
          hookVersion: hook ? hook.version : null,
          defaultingEnabled: hook ? hook.defaultingEnabled : null,
          defaultingBinding: hook ? hook.defaultingBinding : null,
          liqltMarginRaw: hook ? hook.liqltMarginRaw : null,
          liqltMargin: hook ? hook.liqltMargin : null,
          liquidationCallReverted: hook ? hook.liquidationCallReverted : null,
          solvencyOracleClass: solvency ? solvency.oracleClass : null,
          maxLtvOracleClass: maxLtv ? maxLtv.oracleClass : null,
          oracleStalenessGuarded: solvency ? oracleStalenessGuarded(solvency.oracleClass) : null,
          shareDecimalsOffset: collateralShare ? collateralShare.decimalsOffset : null,
          shareOffsetable: collateralShare ? collateralShare.decimalsOffset !== null : null,
        };
      };
      const sides = [sideFor(pair.silo0), sideFor(pair.silo1)];
      ci.structural[c.config] = {
        config: c.config,
        siloId: c.id === null || c.id === undefined ? (siloIdByConfig[c.config] ?? null) : c.id,
        onChainSiloId: siloIdByConfig[c.config] ?? null,
        name: c.name || null,
        source: c.source || null,
        isTestName: typeof c.name === "string" ? /^Test_/i.test(c.name) : null,
        silo0: pair.silo0,
        silo1: pair.silo1,
        hookReceiver: sides.find((s) => s.resolved && s.hookReceiver) ? sides.find((s) => s.resolved && s.hookReceiver).hookReceiver : null,
        hookClass: sides.find((s) => s.resolved && s.hookClass) ? sides.find((s) => s.resolved && s.hookClass).hookClass : null,
        defaultingEnabled: sides.find((s) => s.resolved && s.defaultingEnabled !== null && s.defaultingEnabled !== undefined) ? sides.find((s) => s.resolved && s.defaultingEnabled !== null && s.defaultingEnabled !== undefined).defaultingEnabled : null,
        sides: { [pair.silo0]: sides[0], [pair.silo1]: sides[1] },
      };
    }
    persistIndex(index, indexPath, fsImpl);
  } else {
    reused.structural = true;
    for (const c of inventory.configs) {
      const s = ci.structural[c.config];
      if (s) marketSilos.set(c.config, { silo0: s.silo0, silo1: s.silo1 });
    }
  }

  // EIP1967 impl slot for factory + surfaced market configs (Silo v3 per-market
  // Silos/Configs are deterministic clones; a zero slot is the expected honest
  // record). Proxy-ness is immutable, so it is cached unless --full.
  const eipAddresses = [...new Set([factory, ...inventory.configs.map((c) => c.config)])];
  let eip1967;
  if (!full && ci.eip1967 && Object.keys(ci.eip1967).length > 0) {
    eip1967 = ci.eip1967;
    reused.eip1967 = true;
  } else {
    eip1967 = await readEip1967(rpc, blockTag, eipAddresses);
    ci.eip1967 = eip1967;
  }

  // Bounded recent NewSilo cross-check (factory).
  const eventEnum = await enumerateRecentWindows(ci, "eventWindows", {
    rpc, address: factory, topics: [NEW_SILO_TOPIC], to: finalizedNumber,
    onLogs: (logs) => {
      for (const log of logs) {
        // NewSilo(implementation indexed, token0 indexed, token1 indexed, silo0, silo1, siloConfig):
        // siloConfig is the 3rd non-indexed word of data.
        const data = typeof log.data === "string" ? log.data.replace(/^0x/i, "") : "";
        const configWord = data.length >= 192 ? data.slice(128, 192) : null;
        const config = configWord ? lower(`0x${configWord.slice(24)}`) : null;
        if (config && !isZeroAddr(config) && !ci.eventNewSilo.markets[config]) {
          ci.eventNewSilo.markets[config] = { block: Number(big(log.blockNumber)) };
          ci.eventNewSilo.count += 1;
        }
      }
    },
    persist: () => persistIndex(index, indexPath, fsImpl),
  });
  if (eventEnum.windowsFetched < eventEnum.windowCount) reused.eventWindows = true;

  // Bounded borrower discovery from recent Borrow events on the surfaced silos.
  const surfacedSilos = [...new Set([...marketSilos.values()].flatMap((p) => [p.silo0, p.silo1]))];
  const siloToMarket = new Map();
  for (const [config, pair] of marketSilos.entries()) { siloToMarket.set(pair.silo0, config); siloToMarket.set(pair.silo1, config); }
  const borrowerEnum = await enumerateRecentWindows(ci, "borrowWindows", {
    rpc, address: surfacedSilos, topics: [BORROW_TOPIC], to: finalizedNumber, windowBudget: MAX_BORROW_WINDOWS,
    onLogs: (logs) => {
      for (const log of logs) {
        const ownerTopic = Array.isArray(log.topics) ? log.topics[3] : null;
        const owner = typeof ownerTopic === "string" && ownerTopic.length === 66 ? lower(`0x${ownerTopic.slice(26)}`) : null;
        const silo = lower(log.address);
        if (!owner || !silo || !siloToMarket.has(silo)) continue;
        if (!ci.borrowerAccounts[silo]) ci.borrowerAccounts[silo] = [];
        if (!ci.borrowerAccounts[silo].includes(owner) && ci.borrowerAccounts[silo].length < MAX_ACCOUNTS_PER_MARKET) {
          ci.borrowerAccounts[silo].push(owner);
          ci.eventBorrow.count += 1;
        }
      }
    },
    persist: () => persistIndex(index, indexPath, fsImpl),
  });
  persistIndex(index, indexPath, fsImpl);

  // Aggregate per-side market state (always available, cheap) + near-LT posture.
  const aggregate = await readAggregate(rpc, blockTag, surfacedSilos);
  const posture = await readPosture(rpc, blockTag, deployments.lens, ci, siloToMarket, chainId);

  // Assemble market rows (deterministic ordering by on-chain silo id).
  const marketRows = [];
  for (const c of inventory.configs) {
    const structural = ci.structural[c.config];
    if (!structural) continue;
    const sides = [structural.sides[structural.silo0], structural.sides[structural.silo1]].filter(Boolean);
    const nearLt = posture.byConfig[c.config] || { accounts: [], counts: { accounts: 0, noDebt: 0, belowLt: 0, nearLt: 0, liquidatable: 0, unresolved: 0 } };
    const aggSides = {};
    let debtPresent = false;
    for (const s of [structural.silo0, structural.silo1]) {
      const a = aggregate[s] || null;
      aggSides[s] = a;
      if (a && big(a.debtAssetsRaw) > 0n) debtPresent = true;
    }
    const nearLtOut = {
      ...nearLt,
      borrowersNotDiscovered: debtPresent && nearLt.counts.accounts === 0,
      note: debtPresent && nearLt.counts.accounts === 0
        ? "market has debt but no borrower was discovered in the bounded recent Borrow window (position likely opened earlier)"
        : null,
    };
    marketRows.push({
      config: c.config,
      siloId: structural.siloId,
      onChainSiloId: structural.onChainSiloId,
      name: structural.name,
      source: structural.source,
      isTestName: structural.isTestName,
      silo0: structural.silo0,
      silo1: structural.silo1,
      hookReceiver: structural.hookReceiver,
      hookClass: structural.hookClass,
      defaultingEnabled: structural.defaultingEnabled,
      liqltMargin: sides.find((s) => s.liqltMargin !== null && s.liqltMargin !== undefined) ? sides.find((s) => s.liqltMargin !== null && s.liqltMargin !== undefined).liqltMargin : null,
      sides,
      aggregate: { sides: aggSides, debtPresent },
      dependencies: {
        collateralSiloPerBorrower: "opposite silo (SiloConfig.borrowerCollateralSilo); both sides may act as debt",
        callBeforeQuote: sides.reduce((acc, s) => { acc[s.silo] = s.callBeforeQuote; return acc; }, {}),
        hookReceiver: structural.hookReceiver,
      },
      nearLt: nearLtOut,
      stratLabel: "NONE",
    });
  }
  marketRows.sort((a, b) => ((a.siloId === null || a.siloId === undefined ? 1e12 : a.siloId) - (b.siloId === null || b.siloId === undefined ? 1e12 : b.siloId)) || String(a.config).localeCompare(String(b.config)));

  ci.finalizedAtLastRun = finalizedNumber;
  persistIndex(index, indexPath, fsImpl);

  const hookClassCounts = {};
  const oracleClassCounts = {};
  let defaultingMarkets = 0;
  let pendleMarkets = 0;
  for (const m of marketRows) {
    hookClassCounts[m.hookClass || "unknown"] = (hookClassCounts[m.hookClass || "unknown"] || 0) + 1;
    if (m.hookClass === "pendle") pendleMarkets += 1;
    if (m.defaultingEnabled === true) defaultingMarkets += 1;
    for (const s of m.sides) {
      const oc = s.solvencyOracleClass || "unknown";
      oracleClassCounts[oc] = (oracleClassCounts[oc] || 0) + 1;
    }
  }
  const accountsRead = marketRows.reduce((n, m) => n + m.nearLt.counts.accounts, 0);
  const accountsLiquidatable = marketRows.reduce((n, m) => n + m.nearLt.counts.liquidatable, 0);
  const accountsNearLt = marketRows.reduce((n, m) => n + m.nearLt.counts.nearLt, 0);
  const unresolvedAccounts = marketRows.reduce((n, m) => n + m.nearLt.counts.unresolved, 0);
  const marketsWithDebt = marketRows.filter((m) => m.aggregate && m.aggregate.debtPresent).length;
  const marketsBorrowersNotDiscovered = marketRows.filter((m) => m.nearLt && m.nearLt.borrowersNotDiscovered).length;

  const chainRequests = REQUEST_COUNT - chainStartRequests;
  const blockers = [];
  if (!ci.floor.proven) blockers.push("history-bound-unproven");
  if (inventory.configs.length === 0) blockers.push("inventory-empty");
  if (eventEnum.failedWindows > 0) blockers.push("event-window-failure");
  if (borrowerEnum.failedWindows > 0) blockers.push("borrower-window-failure");
  if (chainRequests > REQUEST_BUDGET) blockers.push("request-budget-exceeded");
  const complete = ci.floor.proven === true && inventory.configs.length > 0 && eventEnum.failedWindows === 0;

  return {
    chainId,
    label: chain.label,
    pin: { number: finalizedNumber, hash: finalizedBlock.hash, timestamp: toIso(finalizedBlock.timestamp), finality: "finalized" },
    factory,
    lens: deployments.lens,
    hookDeployments: deployments.hooks,
    floor: ci.floor,
    inventory: {
      nextSiloId: inventory.nextSiloId,
      idsEnumerated: inventory.ids.length,
      configsResolved: inventory.configs.length,
      skippedOlderThan: inventory.startId,
      registryConfigs: inventory.registryConfigs,
      factoryConfigs: inventory.factoryConfigs,
      unionBeforeCap: inventory.unionBeforeCap,
      cappedAway: inventory.cappedAway,
      v3Configs: inventory.v3Configs,
      cappedAwayV3: inventory.cappedAwayV3,
      nonV3Dropped: inventory.nonV3Dropped,
      reusedFromIndex: reused.inventory,
      surfaced: marketRows.length,
    },
    events: {
      newSiloBoundedLookback: { from: eventEnum.from, to: eventEnum.to, windowCount: eventEnum.windowCount },
      newSiloObserved: ci.eventNewSilo.count,
      newSiloInSurfacedSet: inventory.configs.filter((c) => ci.eventNewSilo.markets[c.config]).length,
      newSiloFailedWindows: eventEnum.failedWindows,
      newSiloVerifyReRead: eventEnum.verification,
      borrowBoundedLookback: { from: borrowerEnum.from, to: borrowerEnum.to, windowCount: borrowerEnum.windowCount },
      borrowObserved: ci.eventBorrow.count,
      borrowFailedWindows: borrowerEnum.failedWindows,
      borrowVerifyReRead: borrowerEnum.verification,
    },
    eip1967: {
      factory: eip1967[factory] || null,
      surfacedClassified: eipAddresses.filter((a) => eip1967[a]).map((a) => ({ address: a, classification: eip1967[a].classification, implementation: eip1967[a].implementation })),
      note: "Silo v3 per-market Silos/Configs are deterministic clones (not EIP1967 proxies); a zero slot (ZERO_NOT_PROXY) is the expected honest record.",
    },
    totals: {
      surfaced: marketRows.length,
      hookClassCounts,
      oracleClassCounts,
      defaultingMarkets,
      pendleHookMarkets: pendleMarkets,
      marketsWithDebt,
      marketsBorrowersNotDiscovered,
      accountsRead,
      accountsLiquidatable,
      accountsNearLt,
      accountsUnresolved: unresolvedAccounts,
    },
    markets: marketRows,
    reads: {
      chainRequests,
      withinBudget: chainRequests <= REQUEST_BUDGET,
      reused,
      inventoryFailures: inventory.failures || 0,
    },
    coverage: { complete, blockers },
  };
}

// --- hook / oracle / share-token metadata --------------------------------------------------
async function readHookInfo(rpc, blockTag, hookAddresses, knownHooks) {
  const info = {};
  if (hookAddresses.length === 0) return info;
  const codeEntries = hookAddresses.map((a) => ({ to: a, data: I.hook.encodeFunctionData("VERSION", []) }));
  const versionMc = await multicall(rpc, blockTag, codeEntries, MC_BATCH_LIGHT);
  const pendleMc = await multicall(rpc, blockTag, hookAddresses.map((a) => ({ to: a, data: I.hook.encodeFunctionData("pendleMarket", []) })), MC_BATCH_LIGHT);
  const marginMc = await multicall(rpc, blockTag, hookAddresses.map((a) => ({ to: a, data: I.hook.encodeFunctionData("LT_MARGIN_FOR_DEFAULTING", []) })), MC_BATCH_LIGHT);
  const probeMc = await multicall(rpc, blockTag, hookAddresses.map((a) => ({ to: a, data: I.hook.encodeFunctionData("liquidationCall", [ZERO, ZERO, ZERO, 0, false]) })), MC_BATCH_LIGHT);
  const knownByAddr = {};
  for (const role of HOOK_ROLES) { if (knownHooks[role]) knownByAddr[knownHooks[role]] = role === "SiloHookV1" ? "v1" : role === "SiloHookV2" ? "v2" : "v3"; }
  // Bytecode presence resolution for hooks whose VERSION() reverts: read the
  // receiver code and, for EIP-1167 clones, extract the embedded implementation
  // and bind it to the known SiloHookV1/V2/V3 deployment addresses.
  const codeBytes = {};
  const cloneImpl = {};
  hookAddresses.forEach((a, i) => {
    const code = versionMc.results[i];
    const version = code && code.success === true ? decodeOrNull(I.hook, "VERSION", code.returnData)?.[0] : null;
    if (version === undefined || version === null) {
      codeBytes[a] = null; // filled below
      cloneImpl[a] = null;
    }
  });
  for (const a of Object.keys(codeBytes)) {
    const code = await readCode(rpc, a, blockTag);
    if (typeof code === "string" && code.length > 2) {
      codeBytes[a] = (code.length - 2) / 2;
      const idx = code.toLowerCase().indexOf("363d3d373d3d3d363d73");
      if (idx >= 0 && code.length >= idx + 60) cloneImpl[a] = lower(`0x${code.slice(idx + 20, idx + 60)}`);
    }
  }
  hookAddresses.forEach((a, i) => {
    const code = versionMc.results[i];
    const version = code && code.success === true ? decodeOrNull(I.hook, "VERSION", code.returnData)?.[0] : null;
    const pm = pendleMc.results[i];
    const pendleMarket = pm && pm.success === true ? lower(decodeOrNull(I.hook, "pendleMarket", pm.returnData)?.[0]) : null;
    const mg = marginMc.results[i];
    const liqltMarginRaw = mg && mg.success === true ? ustr(decodeOrNull(I.hook, "LT_MARGIN_FOR_DEFAULTING", mg.returnData)?.[0]) : null;
    const pr = probeMc.results[i];
    const liquidationCallReverted = pr ? (pr.success === true ? false : true) : null;
    const implClass = cloneImpl[a] && knownByAddr[cloneImpl[a]] ? knownByAddr[cloneImpl[a]] : null;
    const hookClass = parseHookClass({ version: version === undefined ? null : version, knownClass: knownByAddr[a] || implClass, pendleMarket });
    // defaulting binding: V2/V3 -> true, V1/pendle -> false; for an unversioned
    // hook, infer from the LT_MARGIN_FOR_DEFAULTING getter (present => defaulting;
    // absent/revert => non-defaulting), else unresolved.
    let defaultingEnabled;
    let defaultingBinding;
    if (hookClass === "v2" || hookClass === "v3") { defaultingEnabled = true; defaultingBinding = "receiver-VERSION()"; }
    else if (hookClass === "v1" || hookClass === "pendle") { defaultingEnabled = false; defaultingBinding = "receiver-VERSION()"; }
    else if (liqltMarginRaw !== null) { defaultingEnabled = true; defaultingBinding = "LT_MARGIN_FOR_DEFAULTING-getter-present"; }
    else if (mg && mg.success === false) { defaultingEnabled = false; defaultingBinding = "LT_MARGIN_FOR_DEFAULTING-getter-absent"; }
    else { defaultingEnabled = null; defaultingBinding = "unresolved"; }
    info[a] = {
      address: a,
      version: version === undefined ? null : version,
      pendleMarket,
      hookClass,
      hookClassBinding: version ? "receiver-VERSION()" : (implClass ? "clone-implementation-address" : "unresolved-bytecode"),
      hookCodeBytes: codeBytes[a] === undefined ? null : codeBytes[a],
      cloneImplementation: cloneImpl[a] || null,
      defaultingEnabled,
      defaultingBinding,
      liqltMarginRaw,
      liqltMargin: liqltMarginRaw === null ? null : ratio18(liqltMarginRaw),
      liquidationCallReverted,
    };
  });
  return info;
}

async function readOracleInfo(rpc, blockTag, oracleAddresses) {
  const info = {};
  if (oracleAddresses.length === 0) return info;
  const versionMc = await multicall(rpc, blockTag, oracleAddresses.map((a) => ({ to: a, data: I.oracle.encodeFunctionData("VERSION", []) })), MC_BATCH_LIGHT);
  const codeMap = {};
  for (const a of oracleAddresses) {
    const code = await readCode(rpc, a, blockTag);
    codeMap[a] = typeof code === "string" && code.length > 2;
  }
  oracleAddresses.forEach((a, i) => {
    const item = versionMc.results[i];
    const version = item && item.success === true ? decodeOrNull(I.oracle, "VERSION", item.returnData)?.[0] : null;
    const oracleClass = classifyOracle(version === undefined ? null : version);
    info[a] = {
      address: a,
      version: version === undefined ? null : version,
      oracleClass,
      oracleStalenessGuarded: oracleStalenessGuarded(oracleClass),
      codePresent: Boolean(codeMap[a]),
    };
  });
  return info;
}

async function readShareInfo(rpc, blockTag, shareAddresses) {
  const info = {};
  if (shareAddresses.length === 0) return info;
  const mc = await multicall(rpc, blockTag, shareAddresses.map((a) => ({ to: a, data: I.share.encodeFunctionData("decimalsOffset", []) })), MC_BATCH_LIGHT);
  shareAddresses.forEach((a, i) => {
    const item = mc.results[i];
    const decimalsOffset = item && item.success === true ? Number(big(decodeOrNull(I.share, "decimalsOffset", item.returnData)?.[0])) : null;
    info[a] = { address: a, decimalsOffset };
  });
  return info;
}

// --- aggregate market state (per side) ----------------------------------------------------
async function readAggregate(rpc, blockTag, silos) {
  const map = {};
  if (!silos || silos.length === 0) return map;
  const entries = silos.map((s) => ({ to: s, data: I.silo.encodeFunctionData("getSiloStorage", []) }));
  const mc = await multicall(rpc, blockTag, entries, MC_BATCH_LIGHT);
  silos.forEach((s, i) => {
    const item = mc.results[i];
    if (!item || item.success !== true) { map[s] = null; return; }
    const d = decodeOrNull(I.silo, "getSiloStorage", item.returnData);
    map[s] = d ? { protectedAssetsRaw: ustr(d[2]), collateralAssetsRaw: ustr(d[3]), debtAssetsRaw: ustr(d[4]) } : null;
  });
  return map;
}

// --- near-LT posture ----------------------------------------------------------------------
async function readPosture(rpc, blockTag, lens, ci, siloToMarket, chainId) {
  const byConfig = {};
  const empty = () => ({ accounts: [], counts: { accounts: 0, noDebt: 0, belowLt: 0, nearLt: 0, liquidatable: 0, unresolved: 0 } });
  for (const config of Object.keys(ci.structural)) byConfig[config] = empty();
  const pairs = [];
  for (const [silo, accounts] of Object.entries(ci.borrowerAccounts)) {
    const config = siloToMarket.get(silo);
    if (!config) continue;
    for (const account of accounts.slice(0, MAX_ACCOUNTS_PER_MARKET)) pairs.push({ silo, account, config });
  }
  pairs.length = Math.min(pairs.length, MAX_ACCOUNTS_PER_CHAIN);
  if (!lens || pairs.length === 0) {
    return { byConfig, pairsRead: pairs.length, lensResolved: Boolean(lens) };
  }
  const lensCode = await readCode(rpc, lens, blockTag);
  const lensResolved = typeof lensCode === "string" && lensCode.length > 2;
  if (!lensResolved) {
    for (const p of pairs) byConfig[p.config].counts.unresolved += 1;
    return { byConfig, pairsRead: pairs.length, lensResolved: false };
  }
  for (let start = 0; start < pairs.length; start += MC_BATCH_HEAVY) {
    const batch = pairs.slice(start, start + MC_BATCH_HEAVY);
    const borrowers = batch.map((p) => [p.silo, p.account]);
    const entries = [{ to: lens, data: I.lens.encodeFunctionData("getUsersHealth", [borrowers]) }];
    const mc = await multicall(rpc, blockTag, entries, 1);
    const item = mc.results[0];
    let healths = null;
    if (item && item.success === true) {
      const d = decodeOrNull(I.lens, "getUsersHealth", item.returnData);
      healths = d ? d[0] : null;
    }
    batch.forEach((p, i) => {
      const bucket = byConfig[p.config];
      if (!bucket) return;
      bucket.counts.accounts += 1;
      const h = healths ? healths[i] : null;
      if (!h) {
        bucket.counts.unresolved += 1;
        bucket.accounts.push({ silo: p.silo, account: p.account, ltv: null, lt: null, band: "UNRESOLVED_NO_DEEPER_READ", stratLabel: "NONE" });
        return;
      }
      // BorrowerHealth returns (lt, ltv) per ISiloLens.sol:15-18 — lt FIRST.
      // The prior decode swapped the tuple (ltvRaw=h[0]) and inverted the band
      // comparison, producing false LIQUIDATABLE labels (fixed 2026-10-13;
      // cross-checked live via getUserLTV/getUserLT/isSolvent/maxLiquidation).
      const ltRaw = big(h[0]);
      const ltvRaw = big(h[1]);
      const ltv = ratio18(ltvRaw);
      const lt = ratio18(ltRaw);
      let band;
      if (ltRaw === 0n || ltvRaw === 0n) { band = "NO_DEBT"; bucket.counts.noDebt += 1; }
      else if (ltvRaw >= ltRaw) { band = "LIQUIDATABLE"; bucket.counts.liquidatable += 1; }
      else if (ltvRaw * 100n >= ltRaw * LT_NEAR_PCT) { band = "NEAR_LT"; bucket.counts.nearLt += 1; }
      else { band = "BELOW_LT"; bucket.counts.belowLt += 1; }
      bucket.accounts.push({ silo: p.silo, account: p.account, ltv, lt, band, stratLabel: "NONE" });
    });
  }
  return { byConfig, pairsRead: pairs.length, lensResolved: true };
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
  "chainId", "chain", "config", "siloId", "side", "asset",
  "hookReceiver", "hookClass", "defaultingEnabled", "liqltMargin",
  "solvencyOracle", "maxLtvOracle", "solvencyOracleClass", "maxLtvOracleClass", "oracleStalenessGuarded",
  "maxLtv", "lt", "liquidationTargetLtv", "liquidationFee",
  "shareDecimalsOffset", "shareOffsetable",
  "protectedShareToken", "collateralShareToken", "debtShareToken",
  "eip1967Implementation",
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

function csvRowsForChain(chain, eip1967) {
  const rows = [];
  for (const market of chain.markets || []) {
    for (const side of market.sides || []) {
      rows.push({
        chainId: chain.chainId,
        chain: chain.label,
        config: market.config,
        siloId: market.siloId,
        side: side.silo,
        asset: side.asset,
        hookReceiver: side.hookReceiver,
        hookClass: side.hookClass,
        defaultingEnabled: side.defaultingEnabled,
        liqltMargin: side.liqltMargin,
        solvencyOracle: side.solvencyOracle,
        maxLtvOracle: side.maxLtvOracle,
        solvencyOracleClass: side.solvencyOracleClass,
        maxLtvOracleClass: side.maxLtvOracleClass,
        oracleStalenessGuarded: side.oracleStalenessGuarded,
        maxLtv: side.maxLtv,
        lt: side.lt,
        liquidationTargetLtv: side.liquidationTargetLtv,
        liquidationFee: side.liquidationFee,
        shareDecimalsOffset: side.shareDecimalsOffset,
        shareOffsetable: side.shareOffsetable,
        protectedShareToken: side.protectedShareToken,
        collateralShareToken: side.collateralShareToken,
        debtShareToken: side.debtShareToken,
        eip1967Implementation: eip1967 && eip1967[market.config] ? eip1967[market.config].implementation : null,
      });
    }
  }
  return rows;
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
      state.inventory = { nextSiloId: null, ids: [], configs: [] };
      state.structural = {};
      state.borrowerAccounts = {};
      state.eventWindows = {};
      state.borrowWindows = {};
      state.eventNewSilo = { count: 0, markets: {} };
      state.eventBorrow = { count: 0, accounts: {} };
      state.eip1967 = {};
    }
  }
  const previousRunCount = Number(index.runCount || 0);
  const runNumber = previousRunCount + 1;
  const reusedIndex = previousRunCount > 0;
  const previousCsvSha = index.lastCsvSha256;

  const chainIds = options.chainIds || [...CHAIN_PRIORITY];
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
      chains.push(await scanChain({ chainId, rpc, index, fsImpl, indexPath, full }));
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
  // sorted by (chainId, config, side). Live posture is JSON-only by design, so a
  // second run that reuses the cache reproduces byte-identical CSV.
  const csvRows = [];
  for (const c of chains) {
    const implMap = c.eip1967 && Array.isArray(c.eip1967.surfacedClassified)
      ? Object.fromEntries(c.eip1967.surfacedClassified.map((r) => [r.address, { implementation: r.implementation }]))
      : null;
    csvRows.push(...csvRowsForChain(c, implMap));
  }
  csvRows.sort((a, b) => (a.chainId - b.chainId) || String(a.config).localeCompare(String(b.config)) || String(a.side).localeCompare(String(b.side)));
  const csvPath = options.csvPath || CSV_PATH;
  const csvWrite = writeCsv(csvRows, csvPath, fsImpl);
  const csvByteIdentical = previousCsvSha !== null && previousCsvSha === csvWrite.sha256;
  index.lastCsvSha256 = csvWrite.sha256;
  index.lastCsvRowCount = csvWrite.rowCount;
  persistIndex(index, indexPath, fsImpl);

  const wallMs = Date.now() - startMs;
  const marketsSurfaced = chains.reduce((s, c) => s + ((c.totals && c.totals.surfaced) || 0), 0);
  const sidesSurfaced = marketsSurfaced * 2;
  const pendleHookMarkets = chains.reduce((s, c) => s + ((c.totals && c.totals.pendleHookMarkets) || 0), 0);
  const defaultingMarkets = chains.reduce((s, c) => s + ((c.totals && c.totals.defaultingMarkets) || 0), 0);
  const accountsRead = chains.reduce((s, c) => s + ((c.totals && c.totals.accountsRead) || 0), 0);
  const accountsLiquidatable = chains.reduce((s, c) => s + ((c.totals && c.totals.accountsLiquidatable) || 0), 0);
  const accountsNearLt = chains.reduce((s, c) => s + ((c.totals && c.totals.accountsNearLt) || 0), 0);
  const marketsWithDebt = chains.reduce((s, c) => s + ((c.totals && c.totals.marketsWithDebt) || 0), 0);
  const marketsBorrowersNotDiscovered = chains.reduce((s, c) => s + ((c.totals && c.totals.marketsBorrowersNotDiscovered) || 0), 0);
  const hookClassCounts = {};
  const oracleClassCounts = {};
  for (const c of chains) {
    for (const [k, v] of Object.entries((c.totals && c.totals.hookClassCounts) || {})) hookClassCounts[k] = (hookClassCounts[k] || 0) + v;
    for (const [k, v] of Object.entries((c.totals && c.totals.oracleClassCounts) || {})) oracleClassCounts[k] = (oracleClassCounts[k] || 0) + v;
  }

  const honestAbsences = [];
  honestAbsences.push("The near-LT posture is a live per-borrower {ltv,lt} band from SiloLens.getUsersHealth; it is NOT a future strategy label (every row stratLabel: NONE).");
  honestAbsences.push("Borrower discovery is a BOUNDED recent `Borrow` event window on the surfaced silos (≤20 accounts per market, ≤120 per chain); it is not a complete holder census.");
  honestAbsences.push("`oracleStalenessGuarded` is asserted false ONLY for ChainlinkV3 oracles (source ignores the heartbeat argument); for every other oracle class it is UNKNOWN, never guessed.");
  honestAbsences.push("The V3 `liquidationCall` revert is recorded as a probe outcome; the class is bound primarily by the receiver's own VERSION() and LT_MARGIN_FOR_DEFAULTING() reads.");
  honestAbsences.push("For hook receivers without VERSION(), the hook class is recorded as unknown-no-version (with hookCodeBytes/cloneImplementation); defaultingEnabled is then inferred from the LT_MARGIN_FOR_DEFAULTING getter presence and labelled by defaultingBinding, never guessed.");
  honestAbsences.push("Full-history `NewSilo` enumeration is out of the per-chain request budget; the live factory view (getNextSiloId/idToSiloConfig) is authoritative and the event scan is a bounded recent cross-check only.");
  honestAbsences.push(`Markets are surfaced as the most recent ≤${MAX_MARKETS_PER_CHAIN} factory ids; older ids beyond that bound are recorded as skippedOlderThan.`);
  if (accountsRead === 0) honestAbsences.push("No borrower accounts were discovered in the bounded recent window on any surfaced market; the posture set is empty this run.");
  if (marketsBorrowersNotDiscovered > 0) honestAbsences.push(`${marketsBorrowersNotDiscovered} market(s) hold debt but no borrower was discovered in the bounded recent Borrow window (position likely opened earlier); each is flagged nearLt.borrowersNotDiscovered and never treated as position-free.`);

  const artifact = {
    schema: ARTIFACT_SCHEMA,
    scannedAt: new Date().toISOString(),
    scanner: "tools/scan-silo-l.js",
    scope: "Read-only Silo V3 market live-set + liquidation-readiness observation producer (L class)",
    safety: {
      readOnly: true, signedActions: false, transactions: false, endpointMaterialPersisted: false,
      privateKeysRead: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false,
    },
    reference: {
      deployments: "targets/silo-contracts-v3-8e2c1b6283ab/silo-core/deployments/<folder>/*.sol.json",
      factory: "silo-core/deployments/<folder>/SiloFactory.sol.json (getNextSiloId/idToSiloConfig/NewSilo)",
      configShape: "silo-core/contracts/interfaces/ISiloConfig.sol:97-115 (ConfigData)",
      hooks: "silo-core/contracts/hooks/SiloHookV1.sol, SiloHookV2.sol, SiloHookV3.sol, PendleRewardsClaimer.sol",
      hookV3Disabled: "silo-core/contracts/hooks/SiloHookV3.sol:10-32 (liquidationCall reverts NotSupported; LT_MARGIN_FOR_DEFAULTING()=0)",
      defaultingMargin: "silo-core/contracts/hooks/defaulting/PartialLiquidationByDefaulting.sol:57-59 (LT_MARGIN_FOR_DEFAULTING=0.01e18)",
      chainlinkNoStaleness: "silo-oracles/contracts/chainlinkV3/ChainlinkV3Oracle.sol:108-120 (_heartbeat ignored)",
      shareOffset: "silo-core/contracts/lib/SiloMathLib.sol:15 (_DECIMALS_OFFSET=3); ShareDebtToken.sol:60-62 (override 0)",
      lens: "silo-core/contracts/SiloLens.sol:81-90 (getUsersHealth)",
      phase0: PHASE0_REPORT,
      step1: STEP1_REPORT,
      pendleCrossSurface: PENDLE_L_REFERENCE,
    },
    conventions: {
      maxMarketsPerChain: MAX_MARKETS_PER_CHAIN,
      maxAccountsPerMarket: MAX_ACCOUNTS_PER_MARKET,
      maxAccountsPerChain: MAX_ACCOUNTS_PER_CHAIN,
      window: WINDOW,
      minWindow: MIN_WINDOW,
      maxEventWindows: MAX_EVENT_WINDOWS,
      requestBudget: REQUEST_BUDGET,
      nearLtBand: "ltv >= lt => LIQUIDATABLE; ltv >= 95% of lt => NEAR_LT; else BELOW_LT",
      hookClasses: { v1: "SiloHookV1 (no defaulting)", v2: "SiloHookV2 (defaulting)", v3: "SiloHookV3 (defaulting, liquidationCall disabled, margin 0)", pendle: "PendleRewardsClaimer (no defaulting)" },
      chainPriority: ["ethereum(1)", "arbitrum(42161)", "base(8453)"],
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
      marketsSurfaced,
      sidesSurfaced,
      pendleHookMarkets,
      defaultingMarkets,
      accountsRead,
      accountsLiquidatable,
      accountsNearLt,
      marketsWithDebt,
      marketsBorrowersNotDiscovered,
      hookClassCounts,
      oracleClassCounts,
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
  let chainIds = [...CHAIN_PRIORITY];
  if (chainArgIndex !== -1) {
    const value = argv[chainArgIndex + 1];
    const byLabel = { ethereum: 1, mainnet: 1, arbitrum: 42161, base: 8453 };
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
    const lines = Object.values(index.chains).map((c) => `${c.chainId}:markets=${(c.inventory && c.inventory.configs || []).length},struct=${Object.keys(c.structural || {}).length},floor=${c.floor ? c.floor.block : "n/a"}`);
    process.stdout.write(`silo-l[sync] runs=${index.runCount} chains=${Object.keys(index.chains).length} ${lines.join(" ")}\n`);
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
    marketsSurfaced: artifact.totals.marketsSurfaced,
    sidesSurfaced: artifact.totals.sidesSurfaced,
    pendleHookMarkets: artifact.totals.pendleHookMarkets,
    defaultingMarkets: artifact.totals.defaultingMarkets,
    accountsRead: artifact.totals.accountsRead,
    accountsLiquidatable: artifact.totals.accountsLiquidatable,
    accountsNearLt: artifact.totals.accountsNearLt,
    marketsWithDebt: artifact.totals.marketsWithDebt,
    marketsBorrowersNotDiscovered: artifact.totals.marketsBorrowersNotDiscovered,
    hookClassCounts: artifact.totals.hookClassCounts,
    oracleClassCounts: artifact.totals.oracleClassCounts,
    chains: artifact.chains.map((c) => ({
      chainId: c.chainId,
      label: c.label,
      error: c.error || null,
      nextSiloId: c.inventory ? c.inventory.nextSiloId : null,
      surfaced: c.totals ? c.totals.surfaced : 0,
      pendle: c.totals ? c.totals.pendleHookMarkets : 0,
      defaulting: c.totals ? c.totals.defaultingMarkets : 0,
      chainRequests: c.reads ? c.reads.chainRequests : 0,
      complete: c.coverage ? c.coverage.complete : false,
    })),
    coverage: artifact.coverage,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`silo-l scan failed: ${error && error.code ? error.code : "SCAN_FAILED"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE, ARTIFACT_PATH, CSV_PATH, INDEX_PATH, DEPLOYMENTS, PHASE0_REPORT, STEP1_REPORT, PENDLE_L_REFERENCE,
  ARTIFACT_SCHEMA, INDEX_SCHEMA, VERSION, MULTICALL3, EIP1967_IMPL_SLOT, ZERO, CHAINS, CHAIN_PRIORITY, HOOK_ROLES,
  MAX_MARKETS_PER_CHAIN, MAX_ACCOUNTS_PER_MARKET, MAX_ACCOUNTS_PER_CHAIN,
  WINDOW, MIN_WINDOW, MAX_EVENT_WINDOWS, MAX_BORROW_WINDOWS, REQUEST_BUDGET, MC_BATCH_LIGHT, MC_BATCH_HEAVY,
  EVENT_SIGNATURES, NEW_SILO_TOPIC, BORROW_TOPIC, I,
  ScanFailure, sleep, hexBlock, relPosix, lower, isZeroAddr, canonicalHash, toIso, big, ustr, ratio18, readJson,
  call, selectFinalized, resolveWorkingRpc, decodeOrNull, readCode, readStorage, readCall,
  loadChainDeployments, multicall, binarySearchCodeFloor, proveHistoryStartBound, fetchRange, fetchRangeBounded, enumerateRecentWindows,
  emptyChainIndex, emptyIndex, loadIndex, persistIndex,
  parseHookClass, defaultingForClass, classifyOracle, oracleStalenessGuarded, parseConfigData,
  readInventory, readEip1967, readHookInfo, readOracleInfo, readShareInfo, readAggregate, readPosture,
  atomicWriteJson, CSV_HEADER, writeCsv, csvRowsForChain, scanChain, scan, runAndPublish, parseArgs, main,
};
