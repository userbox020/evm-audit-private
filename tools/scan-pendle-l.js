#!/usr/bin/env node
"use strict";

// Pendle V2 (L class) read-only market-liveness observation producer.
//
// Resolves the LIVE Pendle V2 deployments (router + market factory) per chain
// from the in-tree deployment artifacts (targets/pendle-core-v2-e8c2cca4/
// deployments/{chainId}-core.json), double-binds them on-chain (EIP1967 impl /
// admin slots + the factory's own immutable views), enumerates the factory's
// market-creation events (`CreateNewMarket`, the "MarketCreated"-shaped event of
// IPMarketFactory.sol) forward from a proven in-tree pin, and reads a bounded
// per-market liveness surface with Multicall3.
//
// Conventions mirrored from tools/scan-euler-l.js (Euler EVK L surface),
// tools/scan-eulerswap-l.js and tools/scan-twyne-l.js:
//   * eth_getCode-binary-search deployment-floor proof (used only when no
//     proven prior-artifact pin binds the chain),
//   * bounded, resumable, adaptive-window eth_getLogs enumeration with a verify
//     re-read and a per-window done-map (a window is marked done only once its
//     logs are fully retrieved),
//   * Multicall3-batched state reads, fail-closed (a null/revert is unresolved,
//     never a default),
//   * atomic artifact writes, canonical CSV + sha256, process-only endpoints,
//   * sequential reads, no signing, no transactions, no private-key material.
//
// Every unknown stays unknown: an oracle raw-rate view that is not externally
// callable is recorded as NOT_EXTERNALLY_CALLABLE rather than approximated with
// a twap, an unreadable EIP1967 slot is UNPROVEN, and a chain that cannot be
// identity-bound is UNKNOWN (fail-closed).
//
// Read-only. RPC material stays process-only and is never printed or persisted.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc, loadRpcUrls } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const ARTIFACT_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "pendle-l.json");
const CSV_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "pendle-l.csv");
const INDEX_PATH = path.join(WORKSPACE, "reports", "monitor", "pendle-l-index.json");

const ARTIFACT_SCHEMA = "pendle-l-observation/v1";
const INDEX_SCHEMA = "pendle-l-index/v1";
const VERSION = 1;

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

// Exact source surface (the pinned checkout).
const SOURCE_ROOT = "targets/pendle-core-v2-e8c2cca4";
const DEPLOYMENTS_DIR = `${SOURCE_ROOT}/deployments`;

// Proven-pin artifacts: a prior read-only lane that recorded an exact finalized
// Ethereum block (number + timestamp). The pin is re-bound at run time (the
// block header must reproduce the recorded timestamp) before it is used as the
// bounded enumeration floor.
const PIN_ARTIFACTS = Object.freeze({
  1: Object.freeze({ path: "reports/raw/fast/pendle-pt-consumer-graph.json", pointer: "block" }),
});

// Morpho Blue liquidatable-lens artifacts used for the PT cross-join.
const MORPHO_ARTIFACTS = Object.freeze({
  1: "reports/raw/fast/morpho-blue-liquidatable.json",
  8453: "reports/raw/fast/morpho-blue-liquidatable-base.json",
});

// Docs-API floor (used ONLY when the factory event stream is unreachable).
const PENDLE_API_BASE = "https://api-v2.pendle.finance/core/v1";

// EIP1967 storage slots.
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

// Exact event signatures derived from the in-tree source.
const FACTORY_EVENT_SIGNATURES = Object.freeze({
  CreateNewMarket: "CreateNewMarket(address,address,int256,int256,uint256)",
  SetOverriddenFee: "SetOverriddenFee(address,address,uint80)",
  NewTreasuryAndFeeReserve: "NewTreasuryAndFeeReserve(address,uint8)",
});
const MARKET_EVENT_SIGNATURES = Object.freeze({
  Mint: "Mint(address,uint256,uint256,uint256)",
  Burn: "Burn(address,address,uint256,uint256,uint256)",
  Swap: "Swap(address,address,int256,int256,uint256,uint256)",
  UpdateImpliedRate: "UpdateImpliedRate(uint256,uint256)",
  IncreaseObservationCardinalityNext: "IncreaseObservationCardinalityNext(uint16,uint16)",
});
// Non-tuple-bearing router action events from IPAllEventsV3.sol (the tuple
// Exit* events are excluded from derivation, not silently invented).
const ACTION_EVENT_SIGNATURES = Object.freeze({
  AddLiquidityDualSyAndPt: "AddLiquidityDualSyAndPt(address,address,address,uint256,uint256,uint256)",
  AddLiquidityDualTokenAndPt: "AddLiquidityDualTokenAndPt(address,address,address,address,uint256,uint256,uint256,uint256)",
  AddLiquiditySinglePt: "AddLiquiditySinglePt(address,address,address,uint256,uint256)",
  AddLiquiditySingleSy: "AddLiquiditySingleSy(address,address,address,uint256,uint256)",
  AddLiquiditySingleToken: "AddLiquiditySingleToken(address,address,address,address,uint256,uint256,uint256)",
  AddLiquiditySingleSyKeepYt: "AddLiquiditySingleSyKeepYt(address,address,address,uint256,uint256,uint256,uint256)",
  AddLiquiditySingleTokenKeepYt: "AddLiquiditySingleTokenKeepYt(address,address,address,address,uint256,uint256,uint256,uint256,uint256)",
  RemoveLiquidityDualSyAndPt: "RemoveLiquidityDualSyAndPt(address,address,address,uint256,uint256,uint256)",
  RemoveLiquidityDualTokenAndPt: "RemoveLiquidityDualTokenAndPt(address,address,address,address,uint256,uint256,uint256,uint256)",
  RemoveLiquiditySinglePt: "RemoveLiquiditySinglePt(address,address,address,uint256,uint256)",
  RemoveLiquiditySingleSy: "RemoveLiquiditySingleSy(address,address,address,uint256,uint256)",
  RemoveLiquiditySingleToken: "RemoveLiquiditySingleToken(address,address,address,address,uint256,uint256,uint256)",
  SwapPtAndSy: "SwapPtAndSy(address,address,address,int256,int256)",
  SwapPtAndToken: "SwapPtAndToken(address,address,address,address,int256,int256,uint256)",
  SwapYtAndSy: "SwapYtAndSy(address,address,address,int256,int256)",
  SwapYtAndToken: "SwapYtAndToken(address,address,address,address,int256,int256,uint256)",
  MintSyFromToken: "MintSyFromToken(address,address,address,address,uint256,uint256)",
  RedeemSyToToken: "RedeemSyToToken(address,address,address,address,uint256,uint256)",
  MintPyFromSy: "MintPyFromSy(address,address,address,uint256,uint256)",
  RedeemPyToSy: "RedeemPyToSy(address,address,address,uint256,uint256)",
  MintPyFromToken: "MintPyFromToken(address,address,address,address,uint256,uint256,uint256)",
  RedeemPyToToken: "RedeemPyToToken(address,address,address,address,uint256,uint256,uint256)",
});

const CREATE_NEW_MARKET_TOPIC = ethers.id(FACTORY_EVENT_SIGNATURES.CreateNewMarket);

// Bounds.
const WINDOW = 10_000;             // base log window
const MIN_WINDOW = 1_000;          // split floor on provider range rejection
const LOG_CONCURRENCY = 1;         // sequential
const MC_BATCH = 200;
const MC_CONCURRENCY = 1;          // sequential
const TIMEOUT_MS = 30_000;
const MAX_ENUM_WINDOWS = 300;      // per-chain window cap (~3,000,000 blocks)
const BASE_ANCHOR_SPAN = 600_000;  // fallback span when no proven pin exists
const MAX_MARKET_DETAIL = 40;      // per-chain per-market detail cap
const ORACLE_DURATION_SEC = 900;   // bounded oracle duration used for oracle-state reads (no twap)
const NEAR_EXPIRY_DAYS = 45;
const REQUEST_BUDGET = 240;        // bounded requests per run
const MIN_CHAIN_RESERVE = 30;      // reserve before a secondary chain
const MAX_WALL_MS = 16 * 60 * 1000;

const CHAINS = Object.freeze({
  1: Object.freeze({ chainId: 1, label: "ethereum" }),
  8453: Object.freeze({ chainId: 8453, label: "base" }),
});

const I = Object.freeze({
  factory: new ethers.Interface([
    "function VERSION() view returns (uint256)",
    "function isValidMarket(address market) view returns (bool)",
    "function yieldContractFactory() view returns (address)",
    "function gaugeController() view returns (address)",
    "function getMarketConfig(address market,address router) view returns (address treasury,uint80 overriddenFee,uint8 reserveFeePercent)",
  ]),
  market: new ethers.Interface([
    "function readTokens() view returns (address SY,address PT,address YT)",
    "function readState(address router) view returns (int256 totalPt,int256 totalSy,int256 totalLp,address treasury,int256 scalarRoot,uint256 expiry,uint256 lnFeeRateRoot,uint256 reserveFeePercent,uint256 lastLnImpliedRate)",
    "function _storage() view returns (int128 totalPt,int128 totalSy,uint96 lastLnImpliedRate,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext)",
    "function factory() view returns (address)",
    "function expiry() view returns (uint256)",
    "function getNonOverrideLnFeeRateRoot() view returns (uint80)",
  ]),
  sy: new ethers.Interface([
    "function exchangeRate() view returns (uint256)",
    "function assetInfo() view returns (uint8 assetType,address assetAddress,uint8 assetDecimals)",
    "function decimals() view returns (uint8)",
  ]),
  erc20: new ethers.Interface([
    "function decimals() view returns (uint8)",
  ]),
  yt: new ethers.Interface([
    "function pyIndexStored() view returns (uint256)",
    "function doCacheIndexSameBlock() view returns (bool)",
    "function pyIndexLastUpdatedBlock() view returns (uint128)",
    "function getPostExpiryData() view returns (uint256 firstPYIndex,uint256 totalSyInterestForTreasury,uint256[] firstRewardIndexes,uint256[] userRewardOwed)",
  ]),
  oracle: new ethers.Interface([
    "function getOracleState(address market,uint32 duration) view returns (bool increaseCardinalityRequired,uint16 cardinalityRequired,bool oldestObservationSatisfied)",
    "function blockCycleNumerator() view returns (uint16)",
  ]),
  multicall: new ethers.Interface([
    "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])",
  ]),
  createNewMarket: new ethers.Interface([
    "event CreateNewMarket(address indexed market,address indexed PT,int256 scalarRoot,int256 initialAnchor,uint256 lnFeeRateRoot)",
  ]),
});

let REQUEST_COUNT = 0;
let API_REQUEST_COUNT = 0;

class ScanFailure extends Error {
  constructor(code) { super(code); this.name = "ScanFailure"; this.code = code; }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function relPosix(target) { return path.relative(WORKSPACE, target).split(path.sep).join("/"); }
function lower(value) { try { return ethers.getAddress(String(value)).toLowerCase(); } catch (_) { return null; } }
function canonicalHash(value) { return `0x${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function loadJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; } }
function slotToAddress(raw) {
  const s = String(raw || "");
  if (!/^0x[0-9a-f]{64}$/i.test(s)) return null;
  const addr = `0x${s.slice(26)}`;
  return /^0x0{40}$/i.test(addr) ? null : addr;
}
function toIso(seconds) {
  try { return new Date(Number(seconds) * 1000).toISOString(); } catch (_) { return null; }
}
function topicMap(signatures) {
  const out = {};
  for (const [name, sig] of Object.entries(signatures)) out[name] = ethers.id(sig);
  return out;
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
function decodeAddr(iface, fn, item) {
  if (!item || item.success !== true) return null;
  const d = decodeOrNull(iface, fn, item.returnData);
  return d ? lower(d[0]) : null;
}
function decodeUintStr(iface, fn, item) {
  if (!item || item.success !== true) return null;
  const d = decodeOrNull(iface, fn, item.returnData);
  return d ? BigInt(d[0]).toString() : null;
}
function decodeBool(iface, fn, item) {
  if (!item || item.success !== true) return null;
  const d = decodeOrNull(iface, fn, item.returnData);
  return d ? d[0] === true : null;
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

// --- deployment artifacts / resolution ---------------------------------------------------
function loadDeployments(chainId) {
  const file = path.join(WORKSPACE, DEPLOYMENTS_DIR, `${chainId}-core.json`);
  const data = loadJson(file);
  if (!data) return { present: false, file: relPosix(file), data: null, router: null, factory: null, factoryKey: null, factoryVersionHint: null, ycf: null, ycfKey: null, proxyAdmin: null, gaugeController: null, allMarketFactories: [] };
  const versioned = Object.keys(data).filter((k) => /^marketFactoryV\d+$/.test(k));
  let factoryKey = "marketFactory";
  let factoryVersionHint = null;
  if (versioned.length) {
    versioned.sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    factoryKey = versioned[versioned.length - 1];
    factoryVersionHint = Number(factoryKey.match(/\d+/)[0]);
  }
  let ycfKey = "yieldContractFactory";
  if (factoryVersionHint !== null && data[`yieldContractFactoryV${factoryVersionHint}`]) ycfKey = `yieldContractFactoryV${factoryVersionHint}`;
  return {
    present: true,
    file: relPosix(file),
    data,
    router: lower(data.router),
    factory: lower(data[factoryKey]),
    factoryKey,
    factoryVersionHint,
    ycf: lower(data[ycfKey]),
    ycfKey,
    proxyAdmin: lower(data.proxyAdmin),
    gaugeController: lower(data.gaugeController),
    allMarketFactories: versioned.map((k) => ({ key: k, address: lower(data[k]) })),
  };
}

// Deployments artifact -> on-chain double-bind. The artifact supplies the proxy
// addresses; the live proxies are verified by reading their own EIP1967 impl /
// admin slots and the factory's own immutable views (VERSION,
// yieldContractFactory, gaugeController). A slot that cannot be read is
// UNPROVEN, never a default. An identity that cannot be bound is UNKNOWN.
async function resolveDeployment({ rpc, blockTag, deployments }) {
  const source = {
    kind: "IN_TREE_DEPLOYMENTS_ARTIFACT",
    file: deployments.file,
    factoryKey: deployments.factoryKey,
    factoryVersionHint: deployments.factoryVersionHint,
    ycfKey: deployments.ycfKey,
  };

  if (!deployments.present || !deployments.factory || !deployments.router) {
    return {
      state: "UNKNOWN",
      reason: "DEPLOYMENTS_ARTIFACT_UNBOUND",
      chainIdSource: { chainId: null },
      source,
      addresses: {},
      codePresence: {},
      eip1967: {},
      crossBinds: [],
      versions: {},
      resolved: false,
    };
  }

  const codePresence = {};
  for (const [name, address] of Object.entries({ router: deployments.router, marketFactory: deployments.factory, yieldContractFactory: deployments.ycf, proxyAdmin: deployments.proxyAdmin })) {
    if (!address) { codePresence[name] = { address: null, present: false, byteSize: 0 }; continue; }
    const code = await readCode(rpc, address, blockTag);
    codePresence[name] = { address, present: typeof code === "string" && code.length > 2, byteSize: typeof code === "string" && code.length > 2 ? (code.length - 2) / 2 : 0 };
  }

  async function readSlot(proxy, slot) {
    try {
      const raw = await call(rpc, "eth_getStorageAt", [proxy, slot, blockTag]);
      return { raw: String(raw || ""), address: slotToAddress(raw), readable: /^0x[0-9a-f]{64}$/i.test(String(raw || "")) };
    } catch (_) { return { raw: null, address: null, readable: false }; }
  }

  const implSlot = await readSlot(deployments.factory, EIP1967_IMPL_SLOT);
  const adminSlot = await readSlot(deployments.factory, EIP1967_ADMIN_SLOT);
  const adminExpected = deployments.proxyAdmin;
  const adminReadable = adminSlot.readable;
  const adminState = !adminReadable ? "UNPROVEN"
    : (adminExpected && adminSlot.address === adminExpected ? "BOUND"
      : (adminExpected ? "MISMATCH" : "OBSERVED_NO_EXPECTED"));

  const eip1967 = {
    impl: { slot: EIP1967_IMPL_SLOT, observedImpl: implSlot.address, readable: implSlot.readable, state: implSlot.address ? "OBSERVED" : "UNPROVEN" },
    admin: {
      slot: EIP1967_ADMIN_SLOT, observedAdmin: adminSlot.address, expectedAdmin: adminExpected,
      readable: adminReadable, bind: Boolean(adminReadable && adminExpected && adminSlot.address === adminExpected), state: adminState,
    },
  };

  const crossBinds = [];
  const pushBind = (name, observed, expected) => crossBinds.push({
    name,
    observed: observed ? lower(observed) : null,
    expected: expected ? lower(expected) : null,
    bind: Boolean(observed && expected && lower(observed) === lower(expected)),
  });

  const versionRes = await readCall(rpc, deployments.factory, I.factory, "VERSION", [], blockTag);
  const versionObserved = versionRes ? Number(BigInt(versionRes[0])) : null;
  const ycfRes = await readCall(rpc, deployments.factory, I.factory, "yieldContractFactory", [], blockTag);
  pushBind("factory.yieldContractFactory", ycfRes && ycfRes[0], deployments.ycf);
  const gcRes = await readCall(rpc, deployments.factory, I.factory, "gaugeController", [], blockTag);
  pushBind("factory.gaugeController", gcRes && gcRes[0], deployments.gaugeController);
  const bindsByFactory = crossBinds;

  const versionBind = versionObserved === 7;
  const ycfBind = Boolean(deployments.ycf && ycfRes && lower(ycfRes[0]) === deployments.ycf);
  const gcBind = Boolean(deployments.gaugeController && gcRes && lower(gcRes[0]) === deployments.gaugeController);

  const resolved = Boolean(codePresence.marketFactory.present && codePresence.router.present && versionBind && ycfBind);

  return {
    state: resolved ? "RESOLVED" : "UNKNOWN",
    reason: resolved ? null : "IDENTITY_UNPROVEN",
    chainIdSource: { chainId: deployments.data && deployments.data.network ? deployments.data.network.chainId : null },
    source,
    addresses: {
      router: deployments.router,
      marketFactory: deployments.factory,
      yieldContractFactory: deployments.ycf,
      proxyAdmin: deployments.proxyAdmin,
      gaugeController: deployments.gaugeController,
    },
    codePresence,
    eip1967,
    crossBinds,
    versions: { factoryVersionObserved: versionObserved, factoryVersionExpected: 7 },
    identityBinds: { version: versionBind, yieldContractFactory: ycfBind, gaugeController: gcBind, eip1967Admin: eip1967.admin.bind },
    allMarketFactories: deployments.allMarketFactories,
    resolved,
  };
}

// --- history floor ----------------------------------------------------------------------
// Preferred: a proven pin recorded by a prior read-only lane. The pin must
// re-bind: the live block header at that number must reproduce the recorded
// timestamp. Otherwise a bounded eth_getCode binary search is attempted; if the
// full span is too wide for the window cap, a bounded recent anchor is used and
// recorded honestly as not-a-deployment-floor.
function loadProvenPin(chainId) {
  const spec = PIN_ARTIFACTS[chainId];
  if (!spec) return null;
  const artifact = loadJson(path.join(WORKSPACE, spec.path));
  if (!artifact) return null;
  const block = artifact[spec.pointer] || artifact.block || null;
  if (!block || !Number.isFinite(Number(block.number))) return null;
  return {
    number: Number(block.number),
    timestamp: Number.isFinite(Number(block.timestamp)) ? Number(block.timestamp) : null,
    iso: block.iso || null,
    sourcePath: spec.path,
  };
}

async function bindPin(rpc, pin) {
  if (!pin) return null;
  let header = null;
  try { header = await call(rpc, "eth_getBlockByNumber", [hexBlock(pin.number), false]); } catch (_) { header = null; }
  if (!header || !header.number) {
    return { ...pin, bound: false, reason: "HEADER_UNAVAILABLE" };
  }
  const observedTimestamp = Number(BigInt(header.timestamp));
  const hashBound = /^0x[0-9a-f]{64}$/i.test(header.hash || "");
  const timestampBound = pin.timestamp === null ? null : observedTimestamp === pin.timestamp;
  const bound = hashBound && (timestampBound !== false);
  return { ...pin, observedTimestamp, observedIso: toIso(observedTimestamp), hash: header.hash, bound, timestampBound };
}

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

async function determineFloor({ rpc, chainId, factory, head, indexChain }) {
  if (indexChain.enumerationFloor && indexChain.enumerationFloor.block) return indexChain.enumerationFloor;

  const pin = await bindPin(rpc, loadProvenPin(chainId));
  if (pin && pin.bound) {
    return {
      block: pin.number,
      proven: true,
      derivation: "prior-artifact-proven-pin",
      source: pin.sourcePath,
      pin,
      note: `Prior read-only lane recorded Ethereum block ${pin.number}; the live header re-binds (timestamp ${pin.observedIso}). Enumeration is bounded forward from this pin.`,
      proof: { method: "eth_getBlockByNumber", number: pin.number, hash: pin.hash, timestampBound: pin.timestampBound },
    };
  }

  // Bounded binary search only if the resulting span fits the window cap.
  let searchFloor = null;
  try { searchFloor = await binarySearchCodeFloor(rpc, factory, 1, head); } catch (_) { searchFloor = null; }
  if (searchFloor !== null && (head - searchFloor) <= MAX_ENUM_WINDOWS * WINDOW) {
    const before = await call(rpc, "eth_getCode", [factory, hexBlock(searchFloor - 1)]);
    const at = await call(rpc, "eth_getCode", [factory, hexBlock(searchFloor)]);
    const previousBlockCodeAbsent = before === "0x";
    const deploymentBlockCodePresent = typeof at === "string" && at.length > 2;
    if (previousBlockCodeAbsent && deploymentBlockCodePresent) {
      return {
        block: searchFloor,
        proven: true,
        derivation: "eth_getCode-binary-search",
        source: null,
        note: "Market factory runtime absent one block before the floor and present at it.",
        proof: { method: "eth_getCode", address: factory, previousBlock: searchFloor - 1, previousBlockCodeAbsent, deploymentBlockCodePresent },
      };
    }
  }

  const span = BASE_ANCHOR_SPAN;
  return {
    block: Math.max(1, head - span),
    proven: false,
    derivation: "bounded-recent-snapshot-anchor",
    source: pin ? pin.sourcePath : null,
    pin: pin || null,
    note: "No proven in-tree pin bound this chain and the factory deployment floor is wider than the window cap; a bounded recent snapshot anchor is used. Markets created before the anchor are outside this bounded lane's scope.",
    proof: { method: "head-minus-span", head, span },
  };
}

// --- log enumeration --------------------------------------------------------------------
async function fetchRange(rpc, { address, topic0, from, to }) {
  const filter = { topics: [topic0], fromBlock: hexBlock(from), toBlock: hexBlock(to) };
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

// Adaptive-window enumeration with a per-window done-map (resumable, zero-loss).
// A window is marked done only once its logs are fully retrieved. A zero-failure
// pass triggers one verify re-read of the first newly completed window.
// `done` is the per-chain done-map; `persist` writes the whole (top-level) index.
async function enumerateWindows({ rpc, address, topic0, from, to, onLogs, done, persist, verify = true, maxWindows = MAX_ENUM_WINDOWS, verifyTarget = null }) {
  const doneMap = done && typeof done === "object" ? done : {};
  const total = Math.max(0, to - from + 1);
  const windowCount = Math.ceil(total / WINDOW);
  const startIndex = Math.max(0, windowCount - maxWindows);
  let pendingBelowStart = 0;
  for (let i = 0; i < startIndex; i += 1) if (doneMap[i] === undefined) pendingBelowStart += 1;
  const truncated = pendingBelowStart > 0;
  const pending = [];
  for (let i = startIndex; i < windowCount; i += 1) if (doneMap[i] === undefined) pending.push(i);
  const failed = [];
  let cursor = 0;
  let sincePersist = 0;
  const worker = async () => {
    while (true) {
      const slot = cursor++;
      if (slot >= pending.length) return;
      const i = pending[slot];
      const wFrom = from + i * WINDOW;
      const wTo = Math.min(to, wFrom + WINDOW - 1);
      try {
        const logs = await fetchRangeBounded(rpc, { address, topic0, from: wFrom, to: wTo });
        onLogs(logs, i);
        doneMap[i] = logs.length;
      } catch (_) {
        failed.push(i);
      }
      if (++sincePersist >= 50) { sincePersist = 0; if (persist) persist(); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOG_CONCURRENCY, Math.max(1, pending.length)) }, worker));
  let verification = null;
  if (verify && failed.length === 0 && pending.length > 0) {
    const i = pending[0];
    const wFrom = from + i * WINDOW;
    const wTo = Math.min(to, wFrom + WINDOW - 1);
    try {
      const again = await fetchRangeBounded(rpc, { address, topic0, from: wFrom, to: wTo }, 2);
      verification = { windowStart: wFrom, firstCount: doneMap[i], secondCount: again.length, match: again.length === doneMap[i] };
    } catch (_) {
      verification = { windowStart: wFrom, firstCount: doneMap[i], secondCount: null, match: false };
    }
  }
  if (verification && verifyTarget) verifyTarget.enumerationVerification = verification;
  if (persist) persist();
  return { windowCount, pendingWindows: pending.length, pendingBelowStart, failedWindows: failed.length, verification, truncated, startIndex };
}

// --- index ------------------------------------------------------------------------------
function emptyChainIndex(chainId) {
  return {
    chainId,
    resolution: null,
    enumerationFloor: null,
    createdWindows: {},
    markets: {},
    createdTotal: 0,
    enumerationVerification: null,
    finalizedAtLastRun: null,
    method: "logs",
    apiMarkets: {},
    failures: 0,
    truncated: false,
  };
}

function emptyIndex() {
  return { schema: INDEX_SCHEMA, version: VERSION, chains: {} };
}

function loadIndex(file = INDEX_PATH, fsImpl = fs) {
  if (!fsImpl.existsSync(file)) return emptyIndex();
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyIndex();
    const chains = parsed.chains && typeof parsed.chains === "object" ? parsed.chains : {};
    const out = emptyIndex();
    for (const [k, v] of Object.entries(chains)) {
      out.chains[k] = {
        ...emptyChainIndex(Number(k)),
        ...v,
        createdWindows: (v && v.createdWindows) || {},
        markets: (v && v.markets) || {},
        apiMarkets: (v && v.apiMarkets) || {},
      };
    }
    return out;
  } catch (_) { return emptyIndex(); }
}

function persistIndex(index, file = INDEX_PATH, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, `${JSON.stringify(index)}\n`);
}

function recordCreated(indexChain, logs, factory) {
  for (const log of logs) {
    let parsed = null;
    try { parsed = I.createNewMarket.parseLog({ topics: log.topics, data: log.data }); } catch (_) { parsed = null; }
    if (!parsed) continue;
    const market = lower(parsed.args.market);
    const pt = lower(parsed.args.PT);
    if (!market) continue;
    if (indexChain.markets[market]) continue;
    indexChain.markets[market] = {
      market,
      pt,
      scalarRootRaw: BigInt(parsed.args.scalarRoot).toString(),
      initialAnchorRaw: BigInt(parsed.args.initialAnchor).toString(),
      lnFeeRateRootRaw: BigInt(parsed.args.lnFeeRateRoot).toString(),
      deployBlock: Number(BigInt(log.blockNumber)),
      txHash: String(log.transactionHash).toLowerCase(),
      logIndex: Number(BigInt(log.logIndex)),
      factory: lower(factory),
      source: "CreateNewMarket",
    };
    indexChain.createdTotal += 1;
  }
}

// Docs-API floor: used ONLY when the factory event stream is unreachable.
async function apiEnumerate(chainId, cap) {
  const markets = [];
  for (let page = 0; page < 3 && markets.length < cap; page += 1) {
    const url = `${PENDLE_API_BASE}/${chainId}/markets?limit=100&skip=${page * 100}`;
    try {
      API_REQUEST_COUNT += 1;
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) break;
      const body = await res.json();
      const results = Array.isArray(body && body.results) ? body.results : [];
      for (const m of results) {
        const market = lower(m && m.address);
        const pt = lower(m && m.pt && m.pt.address);
        if (!market) continue;
        markets.push({ market, pt, name: m && m.name ? String(m.name) : null, expiryIso: m && m.expiry ? String(m.expiry) : null, source: "api-v2.pendle.finance" });
        if (markets.length >= cap) break;
      }
      if (results.length < 100) break;
    } catch (_) { break; }
  }
  return markets.slice(0, cap);
}

// --- multicall --------------------------------------------------------------------------
async function multicall(rpc, blockTag, entries) {
  const results = new Array(entries.length);
  const batches = [];
  for (let i = 0; i < entries.length; i += MC_BATCH) batches.push(i);
  let cursor = 0;
  let failures = 0;
  let requests = 0;
  const worker = async () => {
    while (true) {
      const start = batches[cursor++];
      if (start === undefined) return;
      const batch = entries.slice(start, start + MC_BATCH);
      let decoded = null;
      for (let attempt = 0; attempt < 3 && decoded === null; attempt += 1) {
        try {
          const tuples = batch.map((e) => ({ target: e.to, allowFailure: true, callData: e.data }));
          const data = I.multicall.encodeFunctionData("aggregate3", [tuples]);
          requests += 1;
          const raw = await call(rpc, "eth_call", [{ to: MULTICALL3, data }, blockTag], TIMEOUT_MS);
          const [out] = I.multicall.decodeFunctionResult("aggregate3", raw);
          decoded = out;
        } catch (_) { if (attempt < 2) await sleep(300 * (attempt + 1)); }
      }
      if (decoded === null) { failures += batch.length; return; }
      decoded.forEach((item, index) => { results[start + index] = { success: item[0] === true, returnData: item[1] }; });
    }
  };
  await Promise.all(Array.from({ length: Math.min(MC_CONCURRENCY, batches.length) }, worker));
  return { results, failures, requests };
}

// --- per-market reads -------------------------------------------------------------------
// Pass A: identity + immutable config (readTokens / readState / _storage / isValidMarket).
async function readMarketCore(rpc, blockTag, factory, router, markets) {
  const entries = [];
  for (const market of markets) {
    entries.push({ to: market, data: I.market.encodeFunctionData("readTokens", []) });
    entries.push({ to: market, data: I.market.encodeFunctionData("readState", [router]) });
    entries.push({ to: market, data: I.market.encodeFunctionData("_storage", []) });
    entries.push({ to: factory, data: I.factory.encodeFunctionData("isValidMarket", [market]) });
  }
  const { results, failures, requests } = entries.length ? await multicall(rpc, blockTag, entries) : { results: [], failures: 0, requests: 0 };
  const out = new Map();
  markets.forEach((market, index) => {
    const base = index * 4;
    const tokens = results[base] && results[base].success ? decodeOrNull(I.market, "readTokens", results[base].returnData) : null;
    const state = results[base + 1] && results[base + 1].success ? decodeOrNull(I.market, "readState", results[base + 1].returnData) : null;
    const storage = results[base + 2] && results[base + 2].success ? decodeOrNull(I.market, "_storage", results[base + 2].returnData) : null;
    out.set(market, {
      sy: tokens ? lower(tokens[0]) : null,
      pt: tokens ? lower(tokens[1]) : null,
      yt: tokens ? lower(tokens[2]) : null,
      isValidMarket: results[base + 3] && results[base + 3].success ? results[base + 3].returnData !== "0x" + "0".repeat(64) : null,
      totalPtRaw: state ? BigInt(state[0]).toString() : null,
      totalSyRaw: state ? BigInt(state[1]).toString() : null,
      totalLpRaw: state ? BigInt(state[2]).toString() : null,
      treasury: state ? lower(state[3]) : null,
      scalarRootRaw: state ? BigInt(state[4]).toString() : null,
      expiry: state ? BigInt(state[5]).toString() : null,
      lnFeeRateRootRaw: state ? BigInt(state[6]).toString() : null,
      reserveFeePercentRaw: state ? BigInt(state[7]).toString() : null,
      lastLnImpliedRateRaw: state ? BigInt(state[8]).toString() : null,
      storageTotalPtRaw: storage ? BigInt(storage[0]).toString() : null,
      storageTotalSyRaw: storage ? BigInt(storage[1]).toString() : null,
      storageLastLnImpliedRateRaw: storage ? BigInt(storage[2]).toString() : null,
      observationIndex: storage ? Number(BigInt(storage[3])) : null,
      observationCardinality: storage ? Number(BigInt(storage[4])) : null,
      observationCardinalityNext: storage ? Number(BigInt(storage[5])) : null,
      coreRead: Boolean(tokens && state && storage),
    });
  });
  return { state: out, failures, requests };
}

// Pass B: token-level + oracle-state reads (depends on pass A token addresses).
async function readMarketDetail(rpc, blockTag, oracle, usdDuration, core) {
  const entries = [];
  const meta = [];
  for (const [market, c] of core) {
    const add = (to, iface, fn, args, key) => { if (!to) return; entries.push({ to, data: iface.encodeFunctionData(fn, args) }); meta.push({ market, key, iface, fn }); };
    add(c.sy, I.sy, "exchangeRate", [], "syExchangeRate");
    add(c.sy, I.sy, "assetInfo", [], "syAssetInfo");
    add(c.sy, I.sy, "decimals", [], "syDecimals");
    add(c.pt, I.erc20, "decimals", [], "ptDecimals");
    add(c.yt, I.erc20, "decimals", [], "ytDecimals");
    add(c.yt, I.yt, "pyIndexStored", [], "pyIndexStored");
    add(c.yt, I.yt, "doCacheIndexSameBlock", [], "doCacheIndexSameBlock");
    add(c.yt, I.yt, "pyIndexLastUpdatedBlock", [], "pyIndexLastUpdatedBlock");
    add(oracle, I.oracle, "getOracleState", [market, usdDuration], "oracleState");
  }
  const { results, failures, requests } = entries.length ? await multicall(rpc, blockTag, entries) : { results: [], failures: 0, requests: 0 };
  const out = new Map();
  for (const market of core.keys()) out.set(market, {});
  entries.forEach((entry, i) => {
    const { market, key, iface, fn } = meta[i];
    const item = results[i];
    const bucket = out.get(market);
    if (!bucket) return;
    if (!item || item.success !== true) { bucket[key] = null; return; }
    if (key === "syAssetInfo") {
      const d = decodeOrNull(I.sy, "assetInfo", item.returnData);
      bucket.asset = d ? lower(d[1]) : null;
      bucket.assetDecimals = d ? Number(d[2]) : null;
      bucket.assetType = d ? Number(d[0]) : null;
      return;
    }
    if (key === "oracleState") {
      const d = decodeOrNull(I.oracle, "getOracleState", item.returnData);
      bucket.oracleState = d ? { increaseCardinalityRequired: d[0] === true, cardinalityRequired: Number(d[1]), oldestObservationSatisfied: d[2] === true } : null;
      return;
    }
    const d = decodeOrNull(iface, fn, item.returnData);
    if (!d) { bucket[key] = null; return; }
    bucket[key] = key === "doCacheIndexSameBlock" ? d[0] === true : BigInt(d[0]).toString();
  });
  return { state: out, failures, requests };
}

// Pass C: post-expiry state for markets whose expiry has already passed.
async function readPostExpiry(rpc, blockTag, ytByMarket) {
  const entries = [];
  const list = [];
  for (const [market, yt] of ytByMarket) {
    if (!yt) continue;
    entries.push({ to: yt, data: I.yt.encodeFunctionData("getPostExpiryData", []) });
    list.push({ market, yt });
  }
  const { results, failures, requests } = entries.length ? await multicall(rpc, blockTag, entries) : { results: [], failures: 0, requests: 0 };
  const out = new Map();
  list.forEach(({ market }, i) => {
    const item = results[i];
    if (item && item.success) {
      const d = decodeOrNull(I.yt, "getPostExpiryData", item.returnData);
      out.set(market, {
        state: d ? "FIRST_PY_INDEX_SET" : "DECODE_UNRESOLVED",
        firstPYIndexRaw: d ? BigInt(d[0]).toString() : null,
        totalSyInterestForTreasuryRaw: d ? BigInt(d[1]).toString() : null,
      });
    } else {
      out.set(market, { state: "PY_INDEX_UNSET_OR_REVERT", firstPYIndexRaw: null, totalSyInterestForTreasuryRaw: null });
    }
  });
  return { state: out, failures, requests };
}

// --- Morpho cross-join ------------------------------------------------------------------
function buildMorphoJoin(chainId, marketsByToken) {
  const relPath = MORPHO_ARTIFACTS[chainId];
  const artifact = relPath ? loadJson(path.join(WORKSPACE, relPath)) : null;
  if (!artifact || !Array.isArray(artifact.rows)) {
    return {
      available: false, source: relPath || null, rowsScanned: 0, marketsByToken: marketsByToken.size,
      morphoPtCollateral: 0, byDirection: {}, matchedRows: [], note: "Morpho liquidatable artifact unavailable; cross-join recorded as unavailable (fail-closed).",
    };
  }
  const matched = [];
  const uniqueMarkets = new Set();
  const byDirection = {};
  for (const row of artifact.rows) {
    const collateral = lower(row.collateralToken);
    const loan = lower(row.loanToken);
    const collPt = collateral ? marketsByToken.get(collateral) : null;
    const loanPt = loan ? marketsByToken.get(loan) : null;
    if (!collPt && !loanPt) continue;
    const direction = collPt && loanPt ? "both" : collPt ? "collateral" : "loan";
    const hit = collPt || loanPt;
    byDirection[direction] = (byDirection[direction] || 0) + 1;
    uniqueMarkets.add(hit.market);
    matched.push({
      marketId: row.marketId || null,
      borrower: lower(row.borrower),
      collateralToken: collateral,
      loanToken: loan,
      direction,
      ptToken: collPt ? collateral : loan,
      ptMarket: hit.market,
      ptMarketInDetailedSet: hit.detailed === true,
      priceSourcePosture: "UNRESOLVED_NO_DEEPER_READ",
    });
  }
  const routes = Array.isArray(artifact.valuation && artifact.valuation.routes) ? artifact.valuation.routes : [];
  let routeHits = 0;
  const routeMatched = [];
  for (const r of routes) {
    const c = lower(r.collateralToken);
    const l = lower(r.loanToken);
    const cHit = c ? marketsByToken.get(c) : null;
    const lHit = l ? marketsByToken.get(l) : null;
    if (!cHit && !lHit) continue;
    const hit = cHit || lHit;
    routeHits += 1;
    routeMatched.push({ collateralToken: c, loanToken: l, direction: cHit && lHit ? "both" : cHit ? "collateral" : "loan", ptMarket: hit.market });
  }
  return {
    available: true,
    source: relPath,
    rowsScanned: artifact.rows.length,
    marketsByToken: marketsByToken.size,
    morphoPtCollateral: matched.length,
    uniquePtMarkets: uniqueMarkets.size,
    byDirection,
    matchedRows: matched.slice(0, 100),
    matchedRowsTruncated: matched.length > 100,
    routeRowsScanned: routes.length,
    morphoPtRoutes: routeHits,
    routeMatched: routeMatched.slice(0, 100),
    priceSourcePostureNote: "Per-market PT price-source posture is recorded as UNRESOLVED_NO_DEEPER_READ: the Morpho oracle is not decoded in this bounded lane and the linear-discount configured oracle was not bound, so no comparison is asserted.",
  };
}

// --- artifact ---------------------------------------------------------------------------
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
  "chainId", "market", "factory", "deployBlock", "sy", "pt", "yt", "asset", "assetType", "assetDecimals",
  "ptDecimals", "ytDecimals", "syDecimals", "expiry", "expiryIso", "isExpired", "daysToExpiry",
  "totalPtRaw", "totalSyRaw", "totalLpRaw", "scalarRootRaw", "lnFeeRateRootRaw", "reserveFeePercentRaw",
  "lastLnImpliedRateRaw", "treasury", "observationCardinality", "observationCardinalityNext",
  "pyIndexStoredRaw", "doCacheIndexSameBlock", "pyIndexLastUpdatedBlock",
  "syExchangeRateRaw", "oracleDurationSec", "oracleIncreaseCardinalityRequired", "oracleCardinalityRequired",
  "oracleOldestObservationSatisfied", "postExpiryState", "postExpiryFirstPYIndexRaw",
  "isNearExpiry45d", "isValidMarket", "coreRead", "oracleRead", "skipReason",
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

// --- chain scan -------------------------------------------------------------------------
async function scanChain({ chainId, rpc, index, fsImpl, indexPath, nowSeconds }) {
  const chainStartRequests = REQUEST_COUNT;
  const chain = CHAINS[chainId];
  if (!index.chains[chainId]) index.chains[chainId] = emptyChainIndex(chainId);
  const chainIndex = index.chains[chainId];

  const finalizedBlock = await selectFinalized(rpc);
  const finalizedNumber = Number(BigInt(finalizedBlock.number));
  const blockTag = finalizedBlock.hash;
  const chainNow = nowSeconds || Number(BigInt(finalizedBlock.timestamp));

  const deployments = loadDeployments(chainId);
  const resolution = await resolveDeployment({ rpc, blockTag, deployments });
  chainIndex.resolution = { state: resolution.state, resolved: resolution.resolved, at: finalizedNumber };
  persistIndex(index, indexPath, fsImpl);

  if (!resolution.resolved) {
    return {
      chainId, label: chain.label,
      pin: { number: finalizedNumber, hash: finalizedBlock.hash, timestamp: toIso(finalizedBlock.timestamp) },
      resolution,
      deploymentSource: deployments.file,
      historyStartBound: null,
      enumeration: null,
      inventory: { marketsInSurface: 0, detailed: 0, detailCap: MAX_MARKET_DETAIL, detailCapped: false },
      nearExpiry: { thresholdDays: NEAR_EXPIRY_DAYS, count: 0, markets: [] },
      postExpiry: { expiredMarkets: 0, firstPYIndexSet: 0, firstPYIndexUnsetOrRevert: 0 },
      oracle: { durationSec: ORACLE_DURATION_SEC, read: 0, note: "oracle reads skipped: chain unresolved" },
      morphoJoin: buildMorphoJoin(chainId, new Map()),
      reads: { chainRequests: REQUEST_COUNT - chainStartRequests },
      coverage: { complete: false, blockers: [`deployment ${resolution.state}`] },
      markets: [],
    };
  }

  const factory = resolution.addresses.marketFactory;
  const router = resolution.addresses.router;

  const floor = await determineFloor({ rpc, chainId, factory, head: finalizedNumber, indexChain: chainIndex });
  chainIndex.enumerationFloor = floor;

  // Window cap: for a secondary chain, derive a bounded window count from the
  // remaining request budget so the run stays inside REQUEST_BUDGET.
  let maxWindows = MAX_ENUM_WINDOWS;
  if (chainId !== 1) {
    const remaining = REQUEST_BUDGET - REQUEST_COUNT;
    maxWindows = Math.max(0, Math.min(MAX_ENUM_WINDOWS, Math.floor(remaining * 0.8) - 10));
    if (maxWindows < 5) {
      return {
        chainId, label: chain.label,
        pin: { number: finalizedNumber, hash: finalizedBlock.hash, timestamp: toIso(finalizedBlock.timestamp) },
        resolution,
        deploymentSource: deployments.file,
        historyStartBound: floor,
        enumeration: { method: "logs", skipped: true, reason: "INSUFFICIENT_REQUEST_BUDGET", windowCap: maxWindows },
        inventory: { marketsInSurface: 0, detailed: 0, detailCap: MAX_MARKET_DETAIL, detailCapped: false },
        nearExpiry: { thresholdDays: NEAR_EXPIRY_DAYS, count: 0, markets: [] },
        postExpiry: { expiredMarkets: 0, firstPYIndexSet: 0, firstPYIndexUnsetOrRevert: 0 },
        oracle: { durationSec: ORACLE_DURATION_SEC, read: 0, note: "oracle reads skipped: budget" },
        morphoJoin: buildMorphoJoin(chainId, new Map()),
        reads: { chainRequests: REQUEST_COUNT - chainStartRequests },
        coverage: { complete: false, blockers: ["INSUFFICIENT_REQUEST_BUDGET"] },
        markets: [],
      };
    }
  }

  const enumeration = await enumerateWindows({
    rpc,
    address: factory,
    topic0: CREATE_NEW_MARKET_TOPIC,
    from: floor.block,
    to: finalizedNumber,
    onLogs: (logs) => recordCreated(chainIndex, logs, factory),
    done: chainIndex.createdWindows,
    persist: () => persistIndex(index, indexPath, fsImpl),
    verifyTarget: chainIndex,
    maxWindows,
  });

  // Docs-API floor: only when the event stream was unreachable (no markets and
  // failures). Markets are verify-read on-chain before they are kept.
  if (chainIndex.createdTotal === 0 && enumeration.failedWindows > 0) {
    const apiMarkets = await apiEnumerate(chainId, MAX_MARKET_DETAIL);
    if (apiMarkets.length) {
      const entries = apiMarkets.map((m) => ({ to: factory, data: I.factory.encodeFunctionData("isValidMarket", [m.market]) }));
      const verify = await multicall(rpc, blockTag, entries);
      apiMarkets.forEach((m, i) => {
        const item = verify.results[i];
        const valid = item && item.success ? item.returnData !== "0x" + "0".repeat(64) : null;
        if (valid === true) {
          chainIndex.apiMarkets[m.market] = { ...m, verifyIsValidMarket: true };
          if (!chainIndex.markets[m.market]) {
            chainIndex.markets[m.market] = {
              market: m.market, pt: m.pt, scalarRootRaw: null, initialAnchorRaw: null, lnFeeRateRootRaw: null,
              deployBlock: null, txHash: null, logIndex: null, factory, source: "api-v2.pendle.finance",
            };
            chainIndex.createdTotal += 1;
          }
        }
      });
      chainIndex.method = "api-fallback";
    }
  }

  chainIndex.finalizedAtLastRun = finalizedNumber;
  chainIndex.truncated = chainIndex.createdTotal > 5_000;
  persistIndex(index, indexPath, fsImpl);

  const allMarkets = Object.keys(chainIndex.markets);
  // Deterministic ordering: most recent first (deployBlock desc), then address.
  const ordered = [...allMarkets].sort((a, b) => {
    const da = chainIndex.markets[a].deployBlock === null ? -1 : chainIndex.markets[a].deployBlock;
    const db = chainIndex.markets[b].deployBlock === null ? -1 : chainIndex.markets[b].deployBlock;
    if (da !== db) return db - da;
    return a.localeCompare(b);
  });
  const detailed = ordered.slice(0, MAX_MARKET_DETAIL);
  const detailCapped = ordered.length > detailed.length;

  const coreRead = await readMarketCore(rpc, blockTag, factory, router, detailed);
  const oracleAddr = lower(deployments.data && deployments.data.pyYtLpOracle) || null;
  const detailRead = await readMarketDetail(rpc, blockTag, oracleAddr, ORACLE_DURATION_SEC, coreRead.state);

  // Post-expiry reads (pass C) for markets whose expiry already passed.
  const expiredMarkets = detailed.filter((m) => {
    const c = coreRead.state.get(m);
    return c && c.expiry !== null && Number(c.expiry) <= chainNow;
  });
  const postExpiryRead = await readPostExpiry(rpc, blockTag, new Map(expiredMarkets.map((m) => [m, (coreRead.state.get(m) || {}).yt])));

  let oracleBlockCycleNumerator = null;
  if (oracleAddr) {
    const bcn = await readCall(rpc, oracleAddr, I.oracle, "blockCycleNumerator", [], blockTag);
    oracleBlockCycleNumerator = bcn ? Number(BigInt(bcn[0])) : null;
  }

  // Per-market rows.
  const rows = [];
  for (const market of detailed) {
    const rec = chainIndex.markets[market];
    const c = coreRead.state.get(market) || {};
    const d = detailRead.state.get(market) || {};
    const expiryNum = c.expiry !== null && c.expiry !== undefined ? Number(c.expiry) : null;
    const isExpired = expiryNum === null ? null : expiryNum <= chainNow;
    const daysToExpiry = expiryNum === null ? null : Number(((expiryNum - chainNow) / 86400).toFixed(3));
    const nearExpiry = expiryNum !== null && !isExpired && (expiryNum - chainNow) <= NEAR_EXPIRY_DAYS * 86400;
    const pe = postExpiryRead.state.get(market) || null;

    rows.push({
      chainId,
      market,
      factory: rec.factory,
      deployBlock: rec.deployBlock,
      sy: c.sy || null,
      pt: c.pt || rec.pt || null,
      yt: c.yt || null,
      asset: d.asset || null,
      assetType: d.assetType === undefined ? null : d.assetType,
      assetDecimals: d.assetDecimals === undefined ? null : d.assetDecimals,
      ptDecimals: d.ptDecimals === undefined ? null : d.ptDecimals,
      ytDecimals: d.ytDecimals === undefined ? null : d.ytDecimals,
      syDecimals: d.syDecimals === undefined ? null : d.syDecimals,
      expiry: c.expiry !== undefined ? c.expiry : null,
      expiryIso: expiryNum === null ? null : toIso(expiryNum),
      isExpired,
      daysToExpiry,
      totalPtRaw: c.totalPtRaw !== undefined ? c.totalPtRaw : null,
      totalSyRaw: c.totalSyRaw !== undefined ? c.totalSyRaw : null,
      totalLpRaw: c.totalLpRaw !== undefined ? c.totalLpRaw : null,
      scalarRootRaw: c.scalarRootRaw !== undefined ? c.scalarRootRaw : (rec.scalarRootRaw || null),
      lnFeeRateRootRaw: c.lnFeeRateRootRaw !== undefined ? c.lnFeeRateRootRaw : (rec.lnFeeRateRootRaw || null),
      reserveFeePercentRaw: c.reserveFeePercentRaw !== undefined ? c.reserveFeePercentRaw : null,
      lastLnImpliedRateRaw: c.lastLnImpliedRateRaw !== undefined ? c.lastLnImpliedRateRaw : null,
      treasury: c.treasury !== undefined ? c.treasury : null,
      observationCardinality: c.observationCardinality !== undefined ? c.observationCardinality : null,
      observationCardinalityNext: c.observationCardinalityNext !== undefined ? c.observationCardinalityNext : null,
      pyIndexStoredRaw: d.pyIndexStored === undefined ? null : d.pyIndexStored,
      pyIndexLastUpdatedBlock: d.pyIndexLastUpdatedBlock === undefined ? null : d.pyIndexLastUpdatedBlock,
      doCacheIndexSameBlock: d.doCacheIndexSameBlock === undefined ? null : d.doCacheIndexSameBlock,
      syExchangeRateRaw: d.syExchangeRate === undefined ? null : d.syExchangeRate,
      oracleDurationSec: ORACLE_DURATION_SEC,
      oracleIncreaseCardinalityRequired: d.oracleState ? d.oracleState.increaseCardinalityRequired : null,
      oracleCardinalityRequired: d.oracleState ? d.oracleState.cardinalityRequired : null,
      oracleOldestObservationSatisfied: d.oracleState ? d.oracleState.oldestObservationSatisfied : null,
      postExpiryState: isExpired ? (pe ? pe.state : "READ_UNRESOLVED") : "NOT_EXPIRED",
      postExpiryFirstPYIndexRaw: pe ? pe.firstPYIndexRaw : null,
      isNearExpiry45d: nearExpiry,
      isValidMarket: c.isValidMarket === undefined ? null : c.isValidMarket,
      coreRead: c.coreRead === true,
      oracleRead: d.oracleState !== undefined && d.oracleState !== null,
      skipReason: c.coreRead === true ? null : "CORE_READ_UNRESOLVED",
    });
  }

  // Morpho cross-join over ALL enumerated markets (event PT), not just the
  // detailed set, so the join is not silently narrowed by the detail cap.
  const marketsByToken = new Map();
  for (const [market, rec] of Object.entries(chainIndex.markets)) {
    const token = (coreRead.state.get(market) || {}).pt || rec.pt;
    if (token) marketsByToken.set(token, { market, detailed: detailed.includes(market) });
  }
  const morphoJoin = buildMorphoJoin(chainId, marketsByToken);

  const nearExpiryRows = rows.filter((r) => r.isNearExpiry45d === true);
  const nearExpiryPostExpiryRows = rows.filter((r) => r.postExpiryState === "FIRST_PY_INDEX_SET");
  const postExpirySet = rows.filter((r) => r.postExpiryState === "FIRST_PY_INDEX_SET").length;
  const postExpiryUnset = rows.filter((r) => r.postExpiryState === "PY_INDEX_UNSET_OR_REVERT" || r.postExpiryState === "READ_UNRESOLVED").length;

  const enumerationComplete = enumeration.failedWindows === 0;
  const complete = resolution.resolved
    && enumerationComplete
    && coreRead.failures === 0
    && detailRead.failures === 0
    && REQUEST_COUNT <= REQUEST_BUDGET;

  return {
    chainId,
    label: chain.label,
    pin: { number: finalizedNumber, hash: finalizedBlock.hash, timestamp: toIso(finalizedBlock.timestamp) },
    resolution,
    deploymentSource: deployments.file,
    historyStartBound: floor,
    enumeration: {
      method: chainIndex.method,
      windowSize: WINDOW,
      concurrency: LOG_CONCURRENCY,
      windowCount: enumeration.windowCount,
      pendingWindows: enumeration.pendingWindows,
      failedWindows: enumeration.failedWindows,
      truncated: enumeration.truncated,
      windowCap: maxWindows,
      verification: enumeration.verification || chainIndex.enumerationVerification || null,
      verificationSource: enumeration.verification ? "this-run" : (chainIndex.enumerationVerification ? "resumable-index-last-verify-run" : null),
      marketsEnumerated: allMarkets.length,
    },
    inventory: {
      marketsInSurface: rows.length,
      detailed: detailed.length,
      detailCap: MAX_MARKET_DETAIL,
      detailCapped,
      createdTotal: chainIndex.createdTotal,
      apiMarkets: Object.keys(chainIndex.apiMarkets).length,
    },
    nearExpiry: {
      thresholdDays: NEAR_EXPIRY_DAYS,
      count: nearExpiryRows.length,
      postExpiryFirstPYIndexSetCount: nearExpiryPostExpiryRows.length,
      markets: nearExpiryRows.map((r) => ({
        market: r.market, pt: r.pt, expiry: r.expiry, expiryIso: r.expiryIso, daysToExpiry: r.daysToExpiry,
        postExpiryState: r.postExpiryState, totalPtRaw: r.totalPtRaw, totalSyRaw: r.totalSyRaw,
      })),
    },
    postExpiry: { expiredMarkets: expiredMarkets.length, firstPYIndexSet: postExpirySet, firstPYIndexUnsetOrRevert: postExpiryUnset },
    oracle: {
      durationSec: ORACLE_DURATION_SEC,
      oracle: oracleAddr,
      blockCycleNumerator: oracleBlockCycleNumerator,
      read: rows.filter((r) => r.oracleRead).length,
      note: "Oracle state is read as a bounded spot/state read (getOracleState + market observation cardinality + lastLnImpliedRate). getPtToAssetRateRaw is an internal library function with no external entry point, so it is recorded as NOT_EXTERNALLY_CALLABLE; no twap is invoked.",
      rawRateView: "NOT_EXTERNALLY_CALLABLE",
    },
    morphoJoin,
    reads: {
      chainRequests: REQUEST_COUNT - chainStartRequests,
      coreMulticallRequests: coreRead.requests,
      detailMulticallRequests: detailRead.requests,
      postExpiryMulticallRequests: postExpiryRead.requests,
      coreReadFailures: coreRead.failures,
      detailReadFailures: detailRead.failures,
      postExpiryReadFailures: postExpiryRead.failures,
    },
    markets: rows,
    coverage: {
      complete,
      detailCapped,
      blockers: complete ? [] : [
        !resolution.resolved ? `deployment ${resolution.state}` : null,
        !enumerationComplete ? "created-log enumeration incomplete" : null,
        coreRead.failures > 0 ? "core multicall partial failure" : null,
        detailRead.failures > 0 ? "detail multicall partial failure" : null,
        REQUEST_COUNT > REQUEST_BUDGET ? "request budget exceeded" : null,
      ].filter(Boolean),
      honestAbsences: [
        floor.proven === false ? "enumeration floor is a bounded recent snapshot anchor, not a proven deployment floor; markets created before the anchor are outside this lane's scope." : null,
        detailCapped ? `per-market detail cap reached: ${detailed.length} of ${ordered.length} enumerated markets detailed.` : null,
        "market-level Mint/Burn/Swap event enumeration is not performed in this bounded lane (topics derived only).",
        "getPtToAssetRateRaw is not externally callable; no twap is invoked and the raw rate is recorded as unresolved.",
      ].filter(Boolean),
    },
  };
}

// --- orchestration ----------------------------------------------------------------------
async function scan(options = {}) {
  const startMs = Date.now();
  const fsImpl = options.fsImpl || fs;
  const indexPath = options.indexPath || INDEX_PATH;
  const index = options.index || loadIndex(indexPath, fsImpl);
  const full = options.full === true;
  if (full) for (const state of Object.values(index.chains)) {
    state.enumerationFloor = null; state.createdWindows = {}; state.markets = {};
    state.createdTotal = 0; state.enumerationVerification = null; state.apiMarkets = {}; state.method = "logs";
  }

  const chainIds = options.chainIds || [1, 8453];
  const chains = [];
  for (const chainId of chainIds) {
    if (!CHAINS[chainId]) continue;
    if (chainId !== 1 && REQUEST_COUNT > REQUEST_BUDGET - MIN_CHAIN_RESERVE) {
      chains.push({
        chainId, label: CHAINS[chainId].label,
        resolution: { state: chainId === 1 ? "MAINNET_UNKNOWN" : "UNRESOLVED", reason: "REQUEST_BUDGET_RESERVED" },
        historyStartBound: null, enumeration: null,
        inventory: { marketsInSurface: 0, detailed: 0, detailCap: MAX_MARKET_DETAIL, detailCapped: false },
        nearExpiry: { thresholdDays: NEAR_EXPIRY_DAYS, count: 0, markets: [] },
        postExpiry: { expiredMarkets: 0, firstPYIndexSet: 0, firstPYIndexUnsetOrRevert: 0 },
        oracle: { durationSec: ORACLE_DURATION_SEC, read: 0, note: "skipped" },
        morphoJoin: { available: false, morphoPtCollateral: 0, byDirection: {}, note: "skipped: request budget reserved" },
        reads: { chainRequests: 0 },
        coverage: { complete: false, blockers: ["REQUEST_BUDGET_RESERVED"] },
        markets: [],
      });
      continue;
    }
    const rpc = options.rpcFor ? options.rpcFor(chainId) : await resolveWorkingRpc(chainId);
    if (!rpc) {
      chains.push({
        chainId, label: CHAINS[chainId].label,
        resolution: { state: chainId === 1 ? "MAINNET_UNKNOWN" : "UNRESOLVED", reason: "RPC_UNAVAILABLE" },
        historyStartBound: null, enumeration: null,
        inventory: { marketsInSurface: 0, detailed: 0, detailCap: MAX_MARKET_DETAIL, detailCapped: false },
        nearExpiry: { thresholdDays: NEAR_EXPIRY_DAYS, count: 0, markets: [] },
        postExpiry: { expiredMarkets: 0, firstPYIndexSet: 0, firstPYIndexUnsetOrRevert: 0 },
        oracle: { durationSec: ORACLE_DURATION_SEC, read: 0, note: "skipped" },
        morphoJoin: { available: false, morphoPtCollateral: 0, byDirection: {}, note: "skipped: rpc unavailable" },
        reads: { chainRequests: 0 },
        coverage: { complete: false, blockers: ["RPC_UNAVAILABLE"] },
        markets: [],
      });
      continue;
    }
    chains.push(await scanChain({ chainId, rpc, index, fsImpl, indexPath }));
  }

  persistIndex(index, indexPath, fsImpl);

  const csvRows = chains.flatMap((c) => c.markets || []).sort((a, b) => (a.chainId - b.chainId) || String(a.market).localeCompare(String(b.market)));
  const csvPath = options.csvPath || CSV_PATH;
  const csvWrite = writeCsv(csvRows, csvPath, fsImpl);

  const wallMs = Date.now() - startMs;
  const artifact = {
    schema: ARTIFACT_SCHEMA,
    scannedAt: new Date().toISOString(),
    scanner: "tools/scan-pendle-l.js",
    safety: {
      readOnly: true, signedActions: false, transactions: false, endpointMaterialPersisted: false,
      privateKeysRead: false, exploitExecuteCalls: false, forkTransactions: false,
    },
    derivedTopics: {
      source: {
        marketFactory: `${SOURCE_ROOT}/contracts/interfaces/IPMarketFactory.sol`,
        market: `${SOURCE_ROOT}/contracts/interfaces/IPMarket.sol`,
        routerActions: `${SOURCE_ROOT}/contracts/interfaces/IPAllEventsV3.sol`,
        marketImpl: `${SOURCE_ROOT}/contracts/core/Market/PendleMarketV7.sol`,
        oracleLib: `${SOURCE_ROOT}/contracts/oracles/PtYtLpOracle/PendlePYOracleLib.sol`,
      },
      factory: topicMap(FACTORY_EVENT_SIGNATURES),
      market: topicMap(MARKET_EVENT_SIGNATURES),
      routerActions: topicMap(ACTION_EVENT_SIGNATURES),
      routerActionsExcluded: "tuple-bearing Exit* events are not derived",
      CreateNewMarket: CREATE_NEW_MARKET_TOPIC,
    },
    source: { sourceRoot: SOURCE_ROOT, deploymentsDir: DEPLOYMENTS_DIR },
    chains,
    totals: {
      chainsScanned: chains.length,
      chainsResolved: chains.filter((c) => c.resolution && c.resolution.state === "RESOLVED").length,
      marketsEnumerated: chains.reduce((s, c) => s + (c.enumeration && c.enumeration.marketsEnumerated ? c.enumeration.marketsEnumerated : 0), 0),
      marketsDetailed: chains.reduce((s, c) => s + (c.inventory ? c.inventory.detailed : 0), 0),
      nearExpiryMarkets: chains.reduce((s, c) => s + (c.nearExpiry ? c.nearExpiry.count : 0), 0),
      postExpiryFirstPYIndexSet: chains.reduce((s, c) => s + (c.postExpiry ? c.postExpiry.firstPYIndexSet : 0), 0),
      morphoPtCollateral: chains.reduce((s, c) => s + (c.morphoJoin ? c.morphoJoin.morphoPtCollateral : 0), 0),
      morphoPtRoutes: chains.reduce((s, c) => s + (c.morphoJoin && c.morphoJoin.morphoPtRoutes ? c.morphoJoin.morphoPtRoutes : 0), 0),
      requests: REQUEST_COUNT,
      apiRequests: API_REQUEST_COUNT,
    },
    budget: {
      requestBudget: REQUEST_BUDGET, requests: REQUEST_COUNT, withinBudget: REQUEST_COUNT <= REQUEST_BUDGET,
      wallMs, maxWallMs: MAX_WALL_MS, withinWall: wallMs <= MAX_WALL_MS, sequential: true,
    },
    csv: { path: relPosix(csvPath), rowCount: csvWrite.rowCount, sha256: csvWrite.sha256, canonicalHash: canonicalHash(csvRows), bounded: true },
    coverage: {
      complete: chains.length > 0 && chains.every((c) => c.coverage && c.coverage.complete === true),
      blockers: chains.flatMap((c) => (c.coverage && c.coverage.blockers ? c.coverage.blockers.map((b) => `${c.chainId}: ${b}`) : [])),
      honestAbsences: [
        "This lane enumerates the factory's market-creation events from a proven pin forward and caps per-market detail reads; older markets and the per-market event streams are outside its bounded scope.",
        "Morpho PT price-source posture is unresolved without deeper oracle reads.",
      ],
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
  const unknown = [...modes].filter((value) => !["--full", "--once", "--sync", "--ethereum", "--base"].includes(value));
  if (unknown.length) throw new ScanFailure("USAGE");
  let chainIds = [1, 8453];
  if (modes.has("--ethereum")) chainIds = [1];
  if (modes.has("--base")) chainIds = [8453];
  return { full: modes.has("--full"), sync: modes.has("--sync"), chainIds };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.sync) {
    const index = loadIndex(INDEX_PATH);
    const summary = Object.values(index.chains).map((c) => `${c.chainId}:floor=${c.enumerationFloor ? c.enumerationFloor.block : "n/a"},markets=${Object.keys(c.markets).length},method=${c.method}`);
    process.stdout.write(`pendle-l[sync] ${summary.join(" ")}\n`);
    return;
  }
  const artifact = await runAndPublish({ full: options.full, chainIds: options.chainIds });
  process.stdout.write(`${JSON.stringify({
    status: "OK",
    scannedAt: artifact.scannedAt,
    chains: artifact.chains.map((c) => ({
      chainId: c.chainId,
      resolution: c.resolution ? c.resolution.state : "UNKNOWN",
      floor: c.historyStartBound ? c.historyStartBound.block : null,
      floorProven: c.historyStartBound ? c.historyStartBound.proven : false,
      marketsEnumerated: c.enumeration ? c.enumeration.marketsEnumerated : 0,
      detailed: c.inventory ? c.inventory.detailed : 0,
      nearExpiry: c.nearExpiry ? c.nearExpiry.count : 0,
      postExpiryFirstPYIndexSet: c.postExpiry ? c.postExpiry.firstPYIndexSet : 0,
      morphoPtCollateral: c.morphoJoin ? c.morphoJoin.morphoPtCollateral : 0,
      complete: c.coverage ? c.coverage.complete : false,
    })),
    requests: artifact.totals.requests,
    withinBudget: artifact.budget.withinBudget,
    wallMs: artifact.budget.wallMs,
    csv: artifact.csv.path,
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`pendle-l scan failed: ${error && error.code ? error.code : "SCAN_FAILED"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE, ARTIFACT_PATH, CSV_PATH, INDEX_PATH, ARTIFACT_SCHEMA, INDEX_SCHEMA, VERSION,
  MULTICALL3, SOURCE_ROOT, DEPLOYMENTS_DIR, PIN_ARTIFACTS, MORPHO_ARTIFACTS, PENDLE_API_BASE,
  EIP1967_IMPL_SLOT, EIP1967_ADMIN_SLOT, FACTORY_EVENT_SIGNATURES, MARKET_EVENT_SIGNATURES,
  ACTION_EVENT_SIGNATURES, CREATE_NEW_MARKET_TOPIC,
  WINDOW, MIN_WINDOW, LOG_CONCURRENCY, MC_BATCH, MC_CONCURRENCY, MAX_ENUM_WINDOWS, BASE_ANCHOR_SPAN,
  MAX_MARKET_DETAIL, ORACLE_DURATION_SEC, NEAR_EXPIRY_DAYS, REQUEST_BUDGET, MIN_CHAIN_RESERVE, MAX_WALL_MS, CHAINS, I,
  ScanFailure, call, selectFinalized, resolveWorkingRpc, hexBlock, lower, slotToAddress, canonicalHash, loadJson, toIso, topicMap,
  decodeOrNull, decodeAddr, decodeUintStr, decodeBool, readCode, readCall,
  loadDeployments, resolveDeployment, loadProvenPin, bindPin, binarySearchCodeFloor, determineFloor,
  fetchRange, fetchRangeBounded, enumerateWindows, emptyChainIndex, emptyIndex, loadIndex, persistIndex, recordCreated, apiEnumerate,
  multicall, readMarketCore, readMarketDetail, readPostExpiry, buildMorphoJoin,
  atomicWriteJson, CSV_HEADER, writeCsv, scanChain, scan, runAndPublish, parseArgs, main,
};
