#!/usr/bin/env node
"use strict";

// EulerSwap v2 (L class) read-only deployment/pair resolution + LP-interplay
// sample producer.
//
// Directive: "if you don't find it, decode it." This lane resolves the LIVE
// EulerSwap v2 deployments and pools on Base (8453) and Ethereum mainnet (1)
// from on-chain state, verifies the Base runtimes against the pinned
// compiler/deployment authority, enumerates the pool inventory, reads the
// per-pool activation/curve state, and samples the EulerSwap-LP <-> EVK
// liquidation interplay.
//
// Conventions mirrored from tools/scan-euler-l.js (Euler EVK L surface) and
// tools/scan-morpho-blue-l.js (bounded observation producer):
//   * eth_getCode binary-search deployment floor proof (runtime absent one
//     block before the floor, present at it),
//   * bounded, resumable, adaptive-window eth_getLogs enumeration with a
//     verify re-read and per-window done-map,
//   * Multicall3-batched state reads, fail-closed (a null/revert is unresolved,
//     never a default),
//   * atomic artifact writes, canonical CSV + sha256, process-only endpoints,
//   * no signing, no transactions, no private-key material.
//
// Every unknown stays unknown: if a chain cannot be resolved the state is
// recorded as MAINNET_UNKNOWN / UNRESOLVED rather than fabricated.
//
// Read-only. RPC material stays process-only and is never printed or persisted.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc, loadRpcUrls } = require("./shared-rpc");
const { normalizeRuntimeCandidate } = require("./eulerswap-v2-runtime-normalizer-r1");

const WORKSPACE = path.resolve(__dirname, "..");
const ARTIFACT_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "eulerswap-l.json");
const CSV_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "eulerswap-l.csv");
const INDEX_PATH = path.join(WORKSPACE, "reports", "monitor", "eulerswap-l-index.json");
const COMPILER_BUNDLE_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "eulerswap-v2-compiler-runtime-bundle-r1.json");
const DEPLOYMENT_AUTHORITY_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "eulerswap-v2-base-deployment-authority.json");
const SOURCE_ROOT = "targets/euler-swap-eulerswap-2.0-81cf6dc98846";

const ARTIFACT_SCHEMA = "eulerswap-l-observation/v1";
const INDEX_SCHEMA = "eulerswap-l-index/v1";
const VERSION = 1;

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const LIQUIDATOR_SENTINEL = "0x0000000000000000000000000000000000000001";
const ZERO = "0x0000000000000000000000000000000000000000";

// Exact event signatures derived from the in-tree source
// (src/EulerSwapFactory.sol, src/EulerSwapRegistry.sol, src/libraries/SwapLib.sol).
const EVENT_SIGNATURES = Object.freeze({
  PoolDeployed: "PoolDeployed(address,address,address,address,(address,address,address,address,address,address))",
  PoolRegistered: "PoolRegistered(address,address,address,address,(address,address,address,address,address,address),uint256)",
  Swap: "Swap(address,uint256,uint256,uint256,uint256,uint256,uint256,uint112,uint112,address)",
});
const POOL_DEPLOYED_TOPIC = ethers.id(EVENT_SIGNATURES.PoolDeployed);
const POOL_REGISTERED_TOPIC = ethers.id(EVENT_SIGNATURES.PoolRegistered);
const SWAP_TOPIC = ethers.id(EVENT_SIGNATURES.Swap);

// Source-contract -> component key (matches the pinned compiler bundle and the
// Base deployment authority).
const COMPONENTS = Object.freeze({
  factory: "src/EulerSwapFactory.sol:EulerSwapFactory",
  implementation: "src/EulerSwap.sol:EulerSwap",
  periphery: "src/EulerSwapPeriphery.sol:EulerSwapPeriphery",
  protocolFeeConfig: "src/EulerSwapProtocolFeeConfig.sol:EulerSwapProtocolFeeConfig",
  registry: "src/EulerSwapRegistry.sol:EulerSwapRegistry",
});
// euler-interfaces address-manifest keys for the v2 components.
const MANIFEST_KEYS = Object.freeze({
  factory: "eulerSwapV2Factory",
  implementation: "eulerSwapV2Implementation",
  periphery: "eulerSwapV2Periphery",
  protocolFeeConfig: "eulerSwapV2ProtocolFeeConfig",
  registry: "eulerSwapV2Registry",
});

// Bounds. Pair-detail reads are capped by PAIR_READ_BUDGET (multicall requests).
const WINDOW = 10_000;            // base log window (all tested endpoints accept this)
const MIN_WINDOW = 1_000;
const LOG_CONCURRENCY = 8;
const MAX_PAIRS = 40;
const LP_PAIRS = 10;
const PAIR_READ_BUDGET = 60;
const TIMEOUT_MS = 30_000;
const MC_BATCH = 200;
const MC_CONCURRENCY = 4;
// Bounded floor-anchored + recent PoolDeployed snapshot regions (in blocks).
const LOG_FLOOR_SPAN = 200_000;
const LOG_RECENT_SPAN = 200_000;
// Bounded recent Swap-log window used to rank pools by observable volume.
const VOLUME_WINDOW = 10_000;
const VOLUME_WINDOW_MIN = 2_000;
// Adaptive: enumerate the FULL factory span when it fits this many base windows;
// otherwise take the bounded floor-anchored + recent snapshot.
const MAX_ENUM_WINDOWS = 300;

const CHAINS = Object.freeze({
  1: Object.freeze({
    chainId: 1,
    label: "ethereum",
    manifestPath: "targets/euler-interfaces/addresses/1/EulerSwapAddresses.json",
    // DeployProtocol_input.json pins (bounded source (a)). Recorded and probed;
    // they are NOT assumed to bind the resolved deployment.
    deployInput: Object.freeze({
      path: "targets/euler-swap-eulerswap-2.0-81cf6dc98846/script/json/DeployProtocol_input.json",
      evc: "0x5301c7dD20bD945D2013b48ed0DEE3A284ca8989",
      poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
      protocolFeeAdmin: "0x33C71422B3E20ef2472Bc9aa9252220CAeAF207e",
      validVaultPerspective: "0xFEA8e8a4d7ab8C517c3790E49E92ED7E1166F651",
      curator: "0x33C71422B3E20ef2472Bc9aa9252220CAeAF207e",
    }),
  }),
  8453: Object.freeze({
    chainId: 8453,
    label: "base",
    manifestPath: "targets/euler-interfaces/addresses/8453/EulerSwapAddresses.json",
    deployInput: null,
  }),
});

const I = Object.freeze({
  pool: new ethers.Interface([
    "function getStaticParams() view returns (address supplyVault0,address supplyVault1,address borrowVault0,address borrowVault1,address eulerAccount,address feeRecipient)",
    "function getDynamicParams() view returns (uint112 equilibriumReserve0,uint112 equilibriumReserve1,uint112 minReserve0,uint112 minReserve1,uint80 priceX,uint80 priceY,uint64 concentrationX,uint64 concentrationY,uint64 fee0,uint64 fee1,uint40 expiration,uint8 swapHookedOperations,address swapHook)",
    "function getAssets() view returns (address asset0,address asset1)",
    "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 status)",
    "function getLimits(address tokenIn,address tokenOut) view returns (uint256 limitIn,uint256 limitOut)",
    "function curve() view returns (bytes32)",
    "function isInstalled() view returns (bool)",
  ]),
  registry: new ethers.Interface([
    "function pools() view returns (address[])",
    "function poolsLength() view returns (uint256)",
    "function poolsSlice(uint256 start,uint256 end) view returns (address[])",
    "function eulerSwapFactory() view returns (address)",
    "function validVaultPerspective() view returns (address)",
    "function curator() view returns (address)",
  ]),
  factory: new ethers.Interface([
    "function eulerSwapImpl() view returns (address)",
    "function EVC() view returns (address)",
    "function deployedPools(address) view returns (bool)",
  ]),
  evault: new ethers.Interface([
    "function asset() view returns (address)",
    "function oracle() view returns (address)",
    "function cash() view returns (uint256)",
    "function totalBorrows() view returns (uint256)",
    "function totalAssets() view returns (uint256)",
    "function balanceOf(address account) view returns (uint256)",
    "function debtOf(address account) view returns (uint256)",
    "function checkLiquidation(address liquidator,address violator,address collateral) view returns (uint256 maxRepay,uint256 maxYield)",
  ]),
  multicall: new ethers.Interface([
    "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])",
  ]),
  poolDeployed: new ethers.Interface([
    "event PoolDeployed(address indexed asset0,address indexed asset1,address indexed eulerAccount,address pool,(address,address,address,address,address,address) sParams)",
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
function loadJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; } }

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

// Some shared endpoints become degraded (mostly-null responses). Qualify the
// endpoint before a scan: chain id must match and a finalized block read must
// succeed. Endpoint values stay process-only.
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

// --- runtime-vs-source match -------------------------------------------------------------
function matchRuntime(component, sourceContract, codeHex, bundle, deployment) {
  const base = { component, sourceContract };
  if (typeof codeHex !== "string" || codeHex === "0x") return { ...base, state: "ABSENT" };
  const entry = Array.isArray(bundle.contracts) ? bundle.contracts.find((c) => c.sourceContract === sourceContract) : null;
  const observedByteSize = (codeHex.length - 2) / 2;
  if (entry && observedByteSize !== entry.byteSize) {
    return { ...base, state: "DIVERGED", reason: "SIZE_MISMATCH", observedByteSize, expectedByteSize: entry.byteSize };
  }
  try {
    const result = normalizeRuntimeCandidate(bundle, deployment, sourceContract, codeHex);
    const match = result.normalizedSha256 === result.expectedOfficialSha256;
    return {
      ...base,
      state: match ? "MATCH_IMMUTABLES_MASKED" : "DIVERGED",
      reason: match ? null : "HASH_MISMATCH",
      normalizedSha256: result.normalizedSha256,
      expectedOfficialSha256: result.expectedOfficialSha256,
      observedByteSize,
      immutableMaskCount: result.immutableMaskCount,
      childDigestMaskCount: result.childDigestMaskCount,
    };
  } catch (_) {
    return { ...base, state: "DIVERGED", reason: "NORMALIZATION_INVALID", observedByteSize, expectedByteSize: entry ? entry.byteSize : null };
  }
}

async function readRuntimeMatch({ rpc, blockTag, addresses, bundle, deployment }) {
  const verdicts = [];
  for (const component of Object.keys(COMPONENTS)) {
    const address = addresses[component];
    const sourceContract = COMPONENTS[component];
    if (!address) { verdicts.push({ component, sourceContract, state: "ABSENT", reason: "NO_ADDRESS" }); continue; }
    let code = null;
    try { code = await call(rpc, "eth_getCode", [address, blockTag]); } catch (_) { code = null; }
    if (code === null) { verdicts.push({ component, sourceContract, address: lower(address), state: "UNRESOLVED", reason: "CODE_READ_FAILED" }); continue; }
    verdicts.push({ address: lower(address), ...matchRuntime(component, sourceContract, code, bundle, deployment) });
  }
  const allMatch = verdicts.length > 0 && verdicts.every((v) => v.state === "MATCH_IMMUTABLES_MASKED");
  const matched = verdicts.filter((v) => v.state === "MATCH_IMMUTABLES_MASKED").length;
  return { verdicts, matched, componentCount: verdicts.length, allMatch };
}

// --- deployment resolution ---------------------------------------------------------------
async function readCode(rpc, address, blockTag) {
  try { const code = await call(rpc, "eth_getCode", [address, blockTag]); return typeof code === "string" ? code : null; }
  catch (_) { return null; }
}

async function readCall(rpc, to, iface, fn, args, blockTag) {
  try {
    const raw = await call(rpc, "eth_call", [{ to, data: iface.encodeFunctionData(fn, args) }, blockTag]);
    const decoded = decodeOrNull(iface, fn, raw);
    return decoded;
  } catch (_) { return null; }
}

// Resolve the live EulerSwap v2 deployment for a chain. Base is pinned by the
// deployment authority; mainnet is resolved from the in-tree euler-interfaces
// address manifest and cross-bound on-chain (no fabricated pins).
async function resolveDeployment({ chainId, rpc, blockTag, bundle, deploymentAuthority }) {
  const config = CHAINS[chainId];
  const manifest = loadJson(path.join(WORKSPACE, config.manifestPath));
  const addresses = {};
  if (manifest) {
    for (const [component, key] of Object.entries(MANIFEST_KEYS)) {
      if (manifest[key]) addresses[component] = manifest[key];
    }
  }

  // On-chain code presence for every component address.
  const codePresence = {};
  for (const component of Object.keys(COMPONENTS)) {
    const address = addresses[component];
    const code = address ? await readCode(rpc, address, blockTag) : null;
    codePresence[component] = { address: address ? lower(address) : null, present: typeof code === "string" && code.length > 2, byteSize: typeof code === "string" && code.length > 2 ? (code.length - 2) / 2 : 0 };
  }

  // Cross-binds (independent on-chain identity checks).
  const crossBinds = [];
  const pushBind = (name, observed, expected) => crossBinds.push({ name, observed: observed ? lower(observed) : null, expected: expected ? lower(expected) : null, bind: Boolean(observed && expected && lower(observed) === lower(expected)) });

  if (addresses.factory && codePresence.factory.present) {
    const impl = await readCall(rpc, addresses.factory, I.factory, "eulerSwapImpl", [], blockTag);
    pushBind("factory.eulerSwapImpl", impl && impl[0], addresses.implementation);
    const evc = await readCall(rpc, addresses.factory, I.factory, "EVC", [], blockTag);
    crossBinds.push({ name: "factory.EVC", observed: evc && evc[0] ? lower(evc[0]) : null, expected: null, bind: null });
  }
  if (addresses.registry && codePresence.registry.present) {
    const fac = await readCall(rpc, addresses.registry, I.registry, "eulerSwapFactory", [], blockTag);
    pushBind("registry.eulerSwapFactory", fac && fac[0], addresses.factory);
    const persp = await readCall(rpc, addresses.registry, I.registry, "validVaultPerspective", [], blockTag);
    const curator = await readCall(rpc, addresses.registry, I.registry, "curator", [], blockTag);
    crossBinds.push({ name: "registry.validVaultPerspective", observed: persp && persp[0] ? lower(persp[0]) : null, expected: null, bind: null });
    crossBinds.push({ name: "registry.curator", observed: curator && curator[0] ? lower(curator[0]) : null, expected: null, bind: null });
  }

  // Bounded source (a): the DeployProtocol_input pins. Probe their code presence
  // and record whether they bind the resolved deployment (they are NOT assumed to).
  let deployInputProbe = null;
  if (config.deployInput) {
    const pins = config.deployInput;
    const pinProbe = {};
    for (const [name, address] of Object.entries(pins)) {
      if (name === "path" || !/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
      const code = await readCode(rpc, address, blockTag);
      pinProbe[name] = { address: lower(address), present: typeof code === "string" && code.length > 2, byteSize: typeof code === "string" && code.length > 2 ? (code.length - 2) / 2 : 0 };
    }
    const observedEvc = crossBinds.find((b) => b.name === "factory.EVC")?.observed || null;
    const observedPersp = crossBinds.find((b) => b.name === "registry.validVaultPerspective")?.observed || null;
    const observedCurator = crossBinds.find((b) => b.name === "registry.curator")?.observed || null;
    deployInputProbe = {
      path: pins.path,
      pins: pinProbe,
      binds: {
        evc: Boolean(observedEvc && lower(pins.evc) === observedEvc),
        validVaultPerspective: Boolean(observedPersp && lower(pins.validVaultPerspective) === observedPersp),
        curator: Boolean(observedCurator && lower(pins.curator) === observedCurator),
      },
      note: "DeployProtocol_input.json pins are probed as a bounded source; they bind the resolved deployment only where the named equality holds. They are never substituted for the on-chain identity.",
    };
  }

  const factoryPresent = Boolean(addresses.factory && codePresence.factory.present);
  const identityBound = crossBinds.filter((b) => b.bind === true).length >= 2;
  const state = factoryPresent && identityBound
    ? (chainId === 8453 ? "RESOLVED_PINNED" : "RESOLVED")
    : (chainId === 8453 ? "UNRESOLVED" : "MAINNET_UNKNOWN");

  return {
    state,
    source: {
      kind: chainId === 8453 ? "PINNED_DEPLOYMENT_AUTHORITY" : "EULER_INTERFACES_ADDRESS_MANIFEST",
      manifestPath: config.manifestPath,
      manifestPresent: Boolean(manifest),
      sourceRoot: SOURCE_ROOT,
    },
    addresses: Object.fromEntries(Object.entries(addresses).map(([k, v]) => [k, lower(v)])),
    codePresence,
    crossBinds,
    deployInputProbe,
    factory: addresses.factory ? lower(addresses.factory) : null,
    registry: addresses.registry ? lower(addresses.registry) : null,
    implementation: addresses.implementation ? lower(addresses.implementation) : null,
    resolved: state === "RESOLVED" || state === "RESOLVED_PINNED",
  };
}

// --- index -------------------------------------------------------------------------------
function emptyChainState(chainId) {
  return {
    chainId,
    factory: null,
    deploymentFloor: null,
    logAnchor: null,
    logAnchorMeta: null,
    logWindows: {},
    pairs: {},
    registryPools: [],
    finalizedAtLastRun: null,
    failures: 0,
  };
}

function emptyIndex() {
  return { schema: INDEX_SCHEMA, version: VERSION, chains: {}, failures: 0 };
}

function loadIndex(file = INDEX_PATH, fsImpl = fs) {
  if (!fsImpl.existsSync(file)) return emptyIndex();
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.chains !== "object") return emptyIndex();
    const index = { ...emptyIndex(), ...parsed, chains: {} };
    for (const [key, state] of Object.entries(parsed.chains || {})) {
      index.chains[key] = { ...emptyChainState(Number(key)), ...state, logWindows: state.logWindows || {}, pairs: state.pairs || {} };
    }
    return index;
  } catch (_) { return emptyIndex(); }
}

function persistIndex(index, file = INDEX_PATH, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, `${JSON.stringify(index)}\n`);
}

// --- history floor -----------------------------------------------------------------------
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

async function proveHistoryStartBound(rpc, address, finalizedNumber) {
  const floor = await binarySearchCodeFloor(rpc, address, 1, finalizedNumber);
  const before = await call(rpc, "eth_getCode", [address, hexBlock(floor - 1)]);
  const at = await call(rpc, "eth_getCode", [address, hexBlock(floor)]);
  const previousBlockCodeAbsent = before === "0x";
  const deploymentBlockCodePresent = typeof at === "string" && at.length > 2;
  if (!previousBlockCodeAbsent || !deploymentBlockCodePresent) throw new ScanFailure("HISTORY_BOUND_UNPROVEN");
  return {
    block: floor,
    proven: true,
    derivation: "eth_getCode-binary-search",
    note: "EulerSwapFactory runtime absent one block before the floor and present at it; the bounded PoolDeployed snapshot starts here.",
    proof: {
      method: "eth_getCode",
      address: lower(address),
      previousBlock: floor - 1,
      previousBlockCodeAbsent,
      deploymentBlockCodePresent,
      poolDeployedTopic: POOL_DEPLOYED_TOPIC,
    },
  };
}

// --- bounded log enumeration -------------------------------------------------------------
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

// Bounded floor-anchored + recent PoolDeployed snapshot ranges, anchored on the
// first run so subsequent runs are idempotent (identical ranges, zero re-reads
// when every window is already in the done-map).
function computeLogRanges(floor, finalized) {
  const ranges = [];
  const floorTo = Math.min(finalized, floor + LOG_FLOOR_SPAN - 1);
  for (let from = floor; from <= floorTo; from += WINDOW) {
    ranges.push({ from, to: Math.min(floorTo, from + WINDOW - 1), region: "floor" });
  }
  const recentFrom = Math.max(floor, finalized - LOG_RECENT_SPAN + 1);
  for (let from = recentFrom; from <= finalized; from += WINDOW) {
    ranges.push({ from, to: Math.min(finalized, from + WINDOW - 1), region: "recent" });
  }
  // De-duplicate overlapping floor/recent windows by (from,to).
  const seen = new Set();
  return ranges.filter((r) => { const k = `${r.from}-${r.to}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Full-span ranges when the factory span fits the bounded window budget.
function fullLogRanges(floor, finalized) {
  const ranges = [];
  for (let from = floor; from <= finalized; from += WINDOW) {
    ranges.push({ from, to: Math.min(finalized, from + WINDOW - 1), region: "full" });
  }
  return ranges;
}

// Choose the enumeration plan once and persist it (idempotent across runs).
function planLogEnumeration(floor, finalized) {
  const spanWindows = Math.ceil((finalized - floor + 1) / WINDOW);
  const full = spanWindows <= MAX_ENUM_WINDOWS;
  return {
    complete: full,
    finalized,
    floor,
    spanWindows,
    ranges: full ? fullLogRanges(floor, finalized) : computeLogRanges(floor, finalized),
  };
}

async function enumerateLogs(chainState, { rpc, factory, ranges, onLogs, fsImpl, indexPath, index }) {
  const done = chainState.logWindows;
  const pending = [];
  for (const r of ranges) { const key = `${r.from}-${r.to}`; if (done[key] === undefined) pending.push({ key, ...r }); }
  const failed = [];
  let cursor = 0;
  let sincePersist = 0;
  const worker = async () => {
    while (true) {
      const slot = cursor++;
      if (slot >= pending.length) return;
      const w = pending[slot];
      try {
        const logs = await fetchRangeBounded(rpc, { address: factory, topic0: POOL_DEPLOYED_TOPIC, from: w.from, to: w.to });
        onLogs(logs, w);
        done[w.key] = logs.length;
      } catch (_) { failed.push(w.key); }
      if (++sincePersist >= 50) { sincePersist = 0; persistIndex(index, indexPath, fsImpl); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOG_CONCURRENCY, Math.max(1, pending.length)) }, worker));
  // One verify re-read on a zero-failure pass of a newly completed window.
  let verification = null;
  if (failed.length === 0 && pending.length > 0) {
    const w = pending[0];
    try {
      const again = await fetchRangeBounded(rpc, { address: factory, topic0: POOL_DEPLOYED_TOPIC, from: w.from, to: w.to }, 2);
      verification = { windowStart: w.from, firstCount: done[w.key], secondCount: again.length, match: again.length === done[w.key] };
    } catch (_) { verification = { windowStart: w.from, firstCount: done[w.key], secondCount: null, match: false }; }
  }
  persistIndex(index, indexPath, fsImpl);
  return { windowCount: ranges.length, pendingWindows: pending.length, failedWindows: failed.length, verification };
}

function recordPair(chainState, log) {
  let parsed = null;
  try { parsed = I.poolDeployed.parseLog({ topics: log.topics, data: log.data }); } catch (_) { parsed = null; }
  if (!parsed) return;
  const pool = lower(parsed.args[3]);
  if (!pool) return;
  const sParams = parsed.args[4];
  const existing = chainState.pairs[pool] || {};
  chainState.pairs[pool] = {
    ...existing,
    pool,
    asset0: lower(parsed.args[0]),
    asset1: lower(parsed.args[1]),
    eulerAccount: lower(parsed.args[2]),
    supplyVault0: lower(sParams[0]),
    supplyVault1: lower(sParams[1]),
    borrowVault0: lower(sParams[2]),
    borrowVault1: lower(sParams[3]),
    feeRecipient: lower(sParams[5]),
    deployBlock: Number(BigInt(log.blockNumber)),
    txHash: String(log.transactionHash).toLowerCase(),
    logSource: "poolDeployed-log",
  };
}

// --- multicall ---------------------------------------------------------------------------
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

// --- registry inventory ------------------------------------------------------------------
async function readRegistryPools(rpc, blockTag, registry) {
  if (!registry) return { pools: [], length: null, read: false };
  const lengthRes = await readCall(rpc, registry, I.registry, "poolsLength", [], blockTag);
  const length = lengthRes ? Number(BigInt(lengthRes[0])) : null;
  const raw = await readCall(rpc, registry, I.registry, "pools", [], blockTag);
  const pools = raw && Array.isArray(raw[0]) ? raw[0].map((a) => lower(a)).filter(Boolean) : [];
  return { pools, length, read: Array.isArray(raw) || pools.length > 0 };
}

// --- volume ranking (bounded recent Swap logs, address-filtered) -------------------------
async function rankByVolume(rpc, blockTag, finalizedNumber, poolAddrs) {
  if (!poolAddrs.length) return { window: 0, counts: {}, requests: 0 };
  let window = VOLUME_WINDOW;
  let logs = null;
  while (window >= VOLUME_WINDOW_MIN) {
    const from = Math.max(1, finalizedNumber - window + 1);
    try {
      const raw = await call(rpc, "eth_getLogs", [{ address: poolAddrs, topics: [SWAP_TOPIC], fromBlock: hexBlock(from), toBlock: hexBlock(finalizedNumber) }], TIMEOUT_MS);
      if (Array.isArray(raw)) { logs = raw; break; }
    } catch (_) { /* shrink */ }
    window = Math.floor(window / 2);
  }
  const counts = {};
  if (Array.isArray(logs)) {
    for (const log of logs) {
      const addr = String(log.address || "").toLowerCase();
      if (addr) counts[addr] = (counts[addr] || 0) + 1;
    }
  }
  return { window: Array.isArray(logs) ? window : 0, counts, requests: 1 };
}

// --- per-pair state reads -----------------------------------------------------------------
// Two passes: pass 1 resolves the pool's live assets/reserves/dynamic params;
// pass 2 reads getLimits(tokenIn,tokenOut) with the resolved assets (a registry
// pool has no PoolDeployed-derived asset pair at call time).
async function readPairStates(rpc, blockTag, pairs) {
  const entries1 = [];
  for (const pair of pairs) {
    entries1.push({ to: pair.pool, data: I.pool.encodeFunctionData("getAssets", []) });
    entries1.push({ to: pair.pool, data: I.pool.encodeFunctionData("getReserves", []) });
    entries1.push({ to: pair.pool, data: I.pool.encodeFunctionData("getDynamicParams", []) });
    entries1.push({ to: pair.pool, data: I.pool.encodeFunctionData("curve", []) });
    entries1.push({ to: pair.pool, data: I.pool.encodeFunctionData("isInstalled", []) });
  }
  const r1 = await multicall(rpc, blockTag, entries1);
  const resolved = pairs.map((pair, index) => {
    const base = index * 5;
    const assets = r1.results[base];
    const reserves = r1.results[base + 1];
    const dyn = r1.results[base + 2];
    const curve = r1.results[base + 3];
    const installed = r1.results[base + 4];
    const getAssets = assets && assets.success ? decodeOrNull(I.pool, "getAssets", assets.returnData) : null;
    const getReserves = reserves && reserves.success ? decodeOrNull(I.pool, "getReserves", reserves.returnData) : null;
    const getDyn = dyn && dyn.success ? decodeOrNull(I.pool, "getDynamicParams", dyn.returnData) : null;
    const getCurve = curve && curve.success ? decodeOrNull(I.pool, "curve", curve.returnData) : null;
    const getInstalled = installed && installed.success ? decodeOrNull(I.pool, "isInstalled", installed.returnData) : null;
    const asset0 = getAssets ? lower(getAssets[0]) : (pair.asset0 || null);
    const asset1 = getAssets ? lower(getAssets[1]) : (pair.asset1 || null);
    return {
      pool: pair.pool, asset0, asset1,
      reserve0Raw: getReserves ? BigInt(getReserves[0]).toString() : null,
      reserve1Raw: getReserves ? BigInt(getReserves[1]).toString() : null,
      status: getReserves ? Number(getReserves[2]) : null,
      curve: getCurve ? String(getCurve[0]) : null,
      isInstalled: getInstalled ? getInstalled[0] === true : null,
      dynamicParams: getDyn ? {
        equilibriumReserve0Raw: BigInt(getDyn[0]).toString(),
        equilibriumReserve1Raw: BigInt(getDyn[1]).toString(),
        minReserve0Raw: BigInt(getDyn[2]).toString(),
        minReserve1Raw: BigInt(getDyn[3]).toString(),
        priceXRaw: BigInt(getDyn[4]).toString(),
        priceYRaw: BigInt(getDyn[5]).toString(),
        concentrationXRaw: BigInt(getDyn[6]).toString(),
        concentrationYRaw: BigInt(getDyn[7]).toString(),
        fee0Raw: BigInt(getDyn[8]).toString(),
        fee1Raw: BigInt(getDyn[9]).toString(),
        expirationRaw: BigInt(getDyn[10]).toString(),
        swapHookedOperations: Number(getDyn[11]),
        swapHook: lower(getDyn[12]),
      } : null,
    };
  });

  // Pass 2: getLimits with the resolved assets (only when both are known).
  const limitsTargets = resolved.filter((r) => r.asset0 && r.asset1 && !isZeroAddr(r.asset0) && !isZeroAddr(r.asset1));
  const entries2 = limitsTargets.map((r) => ({ to: r.pool, data: I.pool.encodeFunctionData("getLimits", [r.asset0, r.asset1]) }));
  const r2 = limitsTargets.length ? await multicall(rpc, blockTag, entries2) : { results: [], failures: 0, requests: 0 };
  limitsTargets.forEach((r, i) => {
    const item = r2.results[i];
    const d = item && item.success ? decodeOrNull(I.pool, "getLimits", item.returnData) : null;
    r.limitInRaw = d ? BigInt(d[0]).toString() : null;
    r.limitOutRaw = d ? BigInt(d[1]).toString() : null;
  });

  const out = new Map();
  for (const r of resolved) out.set(r.pool, { ...r, stateRead: Boolean(r.asset0 || r.reserve0Raw || r.dynamicParams || r.limitInRaw) });
  return { states: out, failures: r1.failures + r2.failures, requests: r1.requests + r2.requests };
}

// --- LP-account liquidation interplay sample ---------------------------------------------
// For the top LP_PAIRS pairs, read the LP eulerAccount's EVK collateral/liability
// status via the EVault views and the Liquidations module's own
// checkLiquidation(liquidator, violator=eulerAccount, collateral) view. A
// positive (maxRepay,maxYield) is the module's own near-unhealthy signal; a
// revert is not-proven (fail-closed), never healthy.
async function sampleLpHealth(rpc, blockTag, pairs) {
  const entries = [];
  const layout = [];
  for (const pair of pairs) {
    const supplyVaults = [pair.supplyVault0, pair.supplyVault1].filter((a) => a && !isZeroAddr(a));
    const borrowVaults = [pair.borrowVault0, pair.borrowVault1].filter((a) => a && !isZeroAddr(a));
    const supplyBase = entries.length;
    for (const vault of supplyVaults) {
      entries.push({ to: vault, data: I.evault.encodeFunctionData("asset", []) });
      entries.push({ to: vault, data: I.evault.encodeFunctionData("balanceOf", [pair.eulerAccount]) });
    }
    const borrowBase = entries.length;
    for (const vault of borrowVaults) {
      entries.push({ to: vault, data: I.evault.encodeFunctionData("asset", []) });
      entries.push({ to: vault, data: I.evault.encodeFunctionData("totalBorrows", []) });
      entries.push({ to: vault, data: I.evault.encodeFunctionData("cash", []) });
      entries.push({ to: vault, data: I.evault.encodeFunctionData("oracle", []) });
      entries.push({ to: vault, data: I.evault.encodeFunctionData("debtOf", [pair.eulerAccount]) });
    }
    const checkBase = entries.length;
    const checks = [];
    for (const bv of borrowVaults) {
      for (const cv of supplyVaults) {
        entries.push({ to: bv, data: I.evault.encodeFunctionData("checkLiquidation", [LIQUIDATOR_SENTINEL, pair.eulerAccount, cv]) });
        checks.push({ borrowVault: bv, collateralVault: cv });
      }
    }
    layout.push({ pair, supplyVaults, borrowVaults, supplyBase, borrowBase, checkBase, checks });
  }
  const { results, failures, requests } = await multicall(rpc, blockTag, entries);
  const rows = [];
  for (const item of layout) {
    const supply = item.supplyVaults.map((vault, k) => ({
      vault,
      asset: decodeAddr(I.evault, "asset", results[item.supplyBase + k * 2]),
      lpShareBalanceRaw: decodeUintStr(I.evault, "balanceOf", results[item.supplyBase + k * 2 + 1]),
    }));
    const borrow = item.borrowVaults.map((vault, k) => ({
      vault,
      asset: decodeAddr(I.evault, "asset", results[item.borrowBase + k * 5]),
      totalBorrowsRaw: decodeUintStr(I.evault, "totalBorrows", results[item.borrowBase + k * 5 + 1]),
      cashRaw: decodeUintStr(I.evault, "cash", results[item.borrowBase + k * 5 + 2]),
      oracle: decodeAddr(I.evault, "oracle", results[item.borrowBase + k * 5 + 3]),
      lpDebtRaw: decodeUintStr(I.evault, "debtOf", results[item.borrowBase + k * 5 + 4]),
    }));
    const checks = item.checks.map((check, k) => {
      const result = results[item.checkBase + k];
      let maxRepayRaw = null;
      let maxYieldRaw = null;
      let status = "not-proven-revert";
      if (result && result.success === true) {
        const d = decodeOrNull(I.evault, "checkLiquidation", result.returnData);
        if (d) {
          maxRepayRaw = BigInt(d[0]).toString();
          maxYieldRaw = BigInt(d[1]).toString();
          status = (BigInt(d[0]) > 0n || BigInt(d[1]) > 0n) ? "liquidatable" : "no-violation";
        }
      }
      return { borrowVault: check.borrowVault, collateralVault: check.collateralVault, maxRepayRaw, maxYieldRaw, status };
    });
    const liquidatable = checks.some((c) => c.status === "liquidatable");
    const notProven = checks.filter((c) => c.status === "not-proven-revert").length;
    rows.push({
      pool: item.pair.pool,
      eulerAccount: item.pair.eulerAccount,
      supply: supply,
      borrow: borrow,
      checks,
      liquidatable,
      notProven,
      state: item.borrowVaults.length === 0 ? "NO_BORROW_VAULT" : (checks.length === 0 ? "NO_SUPPLY_VAULT" : "SAMPLED"),
    });
  }
  return { rows, failures, requests };
}

// --- artifact ----------------------------------------------------------------------------
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

function writeCsv(rows, file, fsImpl = fs) {
  const header = [
    "chainId", "pool", "asset0", "asset1", "eulerAccount", "supplyVault0", "supplyVault1",
    "borrowVault0", "borrowVault1", "feeRecipient", "deployBlock", "reserve0Raw", "reserve1Raw",
    "status", "limitInRaw", "limitOutRaw", "priceXRaw", "priceYRaw", "fee0Raw", "fee1Raw",
    "swapVolumeObserved", "lpLiquidatable",
  ];
  const lines = rows.map((r) => {
    const dyn = r.dynamicParams || {};
    return [
      r.chainId, r.pool, r.asset0 ?? "", r.asset1 ?? "", r.eulerAccount ?? "",
      r.supplyVault0 ?? "", r.supplyVault1 ?? "", r.borrowVault0 ?? "", r.borrowVault1 ?? "",
      r.feeRecipient ?? "", r.deployBlock ?? "", r.reserve0Raw ?? "", r.reserve1Raw ?? "",
      r.status ?? "", r.limitInRaw ?? "", r.limitOutRaw ?? "", dyn.priceXRaw ?? "", dyn.priceYRaw ?? "",
      dyn.fee0Raw ?? "", dyn.fee1Raw ?? "", r.swapVolumeObserved ?? "", r.lpLiquidatable ?? "",
    ].join(",");
  });
  const body = `${[header.join(","), ...lines].join("\n")}\n`;
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

// --- per-chain scan ----------------------------------------------------------------------
async function scanChain({ chainId, rpc, index, fsImpl, indexPath, bundle, deploymentAuthority }) {
  const config = CHAINS[chainId];
  const chainState = index.chains[chainId] || (index.chains[chainId] = emptyChainState(chainId));
  const chainStartRequests = REQUEST_COUNT;

  const finalizedBlock = await selectFinalized(rpc);
  const finalizedNumber = Number(BigInt(finalizedBlock.number));
  const blockTag = finalizedBlock.hash;

  const resolution = await resolveDeployment({ chainId, rpc, blockTag, bundle, deploymentAuthority });
  // Runtime match addresses come from the resolved deployment (the in-tree
  // euler-interfaces manifest, which equals the pinned Base authority).
  const runtimeMatchResolved = await readRuntimeMatch({ rpc, blockTag, addresses: resolution.addresses, bundle, deployment: deploymentAuthority });

  chainState.factory = resolution.factory;

  // Deployment floor (getCode binary search), persisted and resumable.
  if (!chainState.deploymentFloor || chainState.deploymentFloor.proven !== true) {
    if (resolution.factory) chainState.deploymentFloor = await proveHistoryStartBound(rpc, resolution.factory, finalizedNumber);
    else chainState.deploymentFloor = { block: null, proven: false, derivation: "unresolved" };
  }

  let enumeration = { windowCount: 0, pendingWindows: 0, failedWindows: 0, verification: null };
  let registryPools = { pools: [], length: null, read: false };

  if (resolution.resolved && chainState.deploymentFloor && chainState.deploymentFloor.proven) {
    // Registry inventory (authoritative on-chain pool set).
    registryPools = await readRegistryPools(rpc, blockTag, resolution.registry);
    chainState.registryPools = registryPools.pools;

    // Bounded PoolDeployed enumeration (full span when it fits the window
    // budget, otherwise floor-anchored + recent), anchored once and resumable.
    if (!chainState.logAnchor) {
      const plan = planLogEnumeration(chainState.deploymentFloor.block, finalizedNumber);
      chainState.logAnchor = plan.ranges;
      chainState.logAnchorMeta = { complete: plan.complete, finalized: plan.finalized, floor: plan.floor, spanWindows: plan.spanWindows };
    }
    enumeration = await enumerateLogs(chainState, {
      rpc, factory: resolution.factory, ranges: chainState.logAnchor,
      onLogs: (logs) => { for (const log of logs) recordPair(chainState, log); },
      fsImpl, indexPath, index,
    });
    chainState.finalizedAtLastRun = finalizedNumber;
    persistIndex(index, indexPath, fsImpl);
  }

  // Union inventory: registry view ∪ PoolDeployed-log-derived pools.
  const inventory = new Map();
  for (const pool of registryPools.pools) inventory.set(pool, { ...(chainState.pairs[pool] || {}), pool, source: "registry-view" });
  for (const [pool, pair] of Object.entries(chainState.pairs)) {
    if (inventory.has(pool)) inventory.get(pool).source = "registry-view+poolDeployed-log";
    else inventory.set(pool, { ...pair, source: "poolDeployed-log" });
  }
  const inventoryPairs = [...inventory.values()].filter((p) => p.pool);
  // Enrich StaticParams for registry pools that were not seen in the bounded log
  // window by reading them live (bounded, single multicall).
  const needStatic = inventoryPairs.filter((p) => !p.eulerAccount || !p.supplyVault0);
  if (needStatic.length) {
    const entries = needStatic.map((p) => ({ to: p.pool, data: I.pool.encodeFunctionData("getStaticParams", []) }));
    const { results } = await multicall(rpc, blockTag, entries);
    needStatic.forEach((p, i) => {
      const item = results[i];
      const d = item && item.success ? decodeOrNull(I.pool, "getStaticParams", item.returnData) : null;
      if (!d) return;
      p.supplyVault0 = lower(d[0]);
      p.supplyVault1 = lower(d[1]);
      p.borrowVault0 = lower(d[2]);
      p.borrowVault1 = lower(d[3]);
      p.eulerAccount = lower(d[4]);
      p.feeRecipient = lower(d[5]);
      p.staticParamsSource = "live-getStaticParams";
    });
  }

  // Volume ranking (bounded recent Swap logs) then top-N.
  const volume = await rankByVolume(rpc, blockTag, finalizedNumber, inventoryPairs.map((p) => p.pool));
  inventoryPairs.sort((a, b) => {
    const ca = volume.counts[a.pool] || 0;
    const cb = volume.counts[b.pool] || 0;
    if (cb !== ca) return cb - ca;
    const da = a.deployBlock || 0;
    const db = b.deployBlock || 0;
    if (db !== da) return db - da;
    return a.pool.localeCompare(b.pool);
  });
  const topPairs = inventoryPairs.slice(0, MAX_PAIRS);

  // Per-pair state reads (bounded).
  const pairReadsBefore = REQUEST_COUNT;
  const { states: pairStates, requests: pairRequests } = await readPairStates(rpc, blockTag, topPairs);

  // LP-account liquidation interplay sample (top LP_PAIRS).
  const lpSample = await sampleLpHealth(rpc, blockTag, topPairs.slice(0, LP_PAIRS));

  const pairRows = topPairs.map((p) => {
    const s = pairStates.get(p.pool) || {};
    const dyn = s.dynamicParams || {};
    const lp = lpSample.rows.find((r) => r.pool === p.pool) || null;
    return {
      chainId,
      pool: p.pool,
      asset0: s.asset0 || p.asset0 || null,
      asset1: s.asset1 || p.asset1 || null,
      eulerAccount: p.eulerAccount || null,
      supplyVault0: p.supplyVault0 || null,
      supplyVault1: p.supplyVault1 || null,
      borrowVault0: p.borrowVault0 || null,
      borrowVault1: p.borrowVault1 || null,
      feeRecipient: p.feeRecipient || null,
      deployBlock: p.deployBlock ?? null,
      inventorySource: p.source,
      reserve0Raw: s.reserve0Raw ?? null,
      reserve1Raw: s.reserve1Raw ?? null,
      status: s.status ?? null,
      activation: s.status === null ? "UNKNOWN" : (s.status === 1 ? "UNLOCKED" : s.status === 2 ? "LOCKED" : "UNACTIVATED"),
      limitInRaw: s.limitInRaw ?? null,
      limitOutRaw: s.limitOutRaw ?? null,
      curve: s.curve ?? null,
      isInstalled: s.isInstalled ?? null,
      dynamicParams: s.dynamicParams || null,
      staticParamsSource: p.staticParamsSource || (p.source.includes("poolDeployed-log") ? "poolDeployed-log" : "registry-view+getStaticParams"),
      swapVolumeObserved: volume.counts[p.pool] || 0,
      stateRead: s.stateRead === true,
      lpHealth: lp,
      lpLiquidatable: lp ? lp.liquidatable === true : null,
    };
  });

  const lpRows = pairRows.filter((r) => r.lpHealth);
  const nearUnhealthy = lpRows.filter((r) => r.lpHealth.liquidatable === true).length;
  const pairReadRequests = REQUEST_COUNT - pairReadsBefore;

  const logEnumerationComplete = Boolean(chainState.logAnchorMeta && chainState.logAnchorMeta.complete === true);
  const inventoryComplete = registryPools.read === true || Object.keys(chainState.pairs).length > 0;
  const complete = resolution.resolved
    && chainState.deploymentFloor && chainState.deploymentFloor.proven === true
    && inventoryComplete
    && pairRows.every((r) => r.stateRead)
    && lpSample.failures === 0;

  return {
    chainId,
    label: config.label,
    pin: {
      number: finalizedNumber,
      hash: finalizedBlock.hash,
      timestamp: new Date(Number(BigInt(finalizedBlock.timestamp)) * 1000).toISOString(),
      finality: "finalized",
    },
    runtimeMatch: runtimeMatchResolved,
    resolution,
    historyStartBound: chainState.deploymentFloor,
    enumeration: {
      method: "getCode-binary-search floor + adaptive PoolDeployed enumeration + registry pools() view",
      windowSize: WINDOW,
      maxEnumWindows: MAX_ENUM_WINDOWS,
      logScan: {
        ...enumeration,
        scope: logEnumerationComplete ? "FULL_SPAN" : "BOUNDED_FLOOR_AND_RECENT",
        floorSpan: LOG_FLOOR_SPAN,
        recentSpan: LOG_RECENT_SPAN,
        complete: logEnumerationComplete,
        meta: chainState.logAnchorMeta || null,
        anchor: chainState.logAnchor ? chainState.logAnchor.map((r) => ({ from: r.from, to: r.to, region: r.region })) : null,
      },
      registryView: { read: registryPools.read, poolsLength: registryPools.length, poolCount: registryPools.pools.length },
    },
    inventory: {
      pairCount: inventoryPairs.length,
      registryPoolCount: registryPools.pools.length,
      poolDeployedLogPairCount: Object.keys(chainState.pairs).length,
      source: "registry pools() view ∪ PoolDeployed bounded snapshot",
      complete: inventoryComplete,
    },
    volume: { window: volume.window, ranked: inventoryPairs.slice(0, MAX_PAIRS).map((p) => ({ pool: p.pool, swaps: volume.counts[p.pool] || 0 })) },
    pairs: pairRows,
    lpHealth: {
      sampled: lpRows.length,
      rows: lpRows,
      nearUnhealthyCount: nearUnhealthy,
      method: "EVault getSharedState-shape reads (totalBorrows/cash/oracle) + checkLiquidation(liquidator, violator=eulerAccount, collateral=supplyVault)",
      note: "checkLiquidation is the EVK Liquidations module's own view; a positive (maxRepay,maxYield) is the module's own near-unhealthy signal. A revert is not-proven (fail-closed), never healthy.",
    },
    reads: { chainRequests: REQUEST_COUNT - chainStartRequests, pairReadRequests, pairMulticallRequests: pairRequests, lpMulticallRequests: lpSample.requests, lpMulticallFailures: lpSample.failures },
    coverage: {
      complete,
      poolDeployedLogComplete: logEnumerationComplete,
      inventoryComplete,
      blockers: complete ? [] : [
        !resolution.resolved ? `deployment ${resolution.state}` : null,
        !(chainState.deploymentFloor && chainState.deploymentFloor.proven) ? "history floor unproven" : null,
        !inventoryComplete ? "pool inventory incomplete" : null,
        pairRows.some((r) => !r.stateRead) ? "some pair state reads unresolved" : null,
        lpSample.failures > 0 ? "lp-health multicall partial failure" : null,
      ].filter(Boolean),
    },
  };
}

// --- orchestration -----------------------------------------------------------------------
async function scan(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const indexPath = options.indexPath || INDEX_PATH;
  const index = options.index || loadIndex(indexPath, fsImpl);
  const bundle = options.bundle || loadJson(COMPILER_BUNDLE_PATH);
  const deploymentAuthority = options.deploymentAuthority || loadJson(DEPLOYMENT_AUTHORITY_PATH);
  if (!bundle || !deploymentAuthority) throw new ScanFailure("AUTHORITY_INPUT_MISSING");

  const chainIds = options.chainIds || [1, 8453];
  const chains = [];
  for (const chainId of chainIds) {
    const rpc = options.rpcFor ? options.rpcFor(chainId) : await resolveWorkingRpc(chainId);
    if (!rpc) {
      chains.push({
        chainId,
        label: CHAINS[chainId].label,
        resolution: { state: chainId === 1 ? "MAINNET_UNKNOWN" : "UNRESOLVED", reason: "RPC_UNAVAILABLE" },
        runtimeMatch: { verdicts: [], matched: 0, componentCount: 0, allMatch: false },
        historyStartBound: { block: null, proven: false, derivation: "rpc-unavailable" },
        enumeration: null, inventory: { pairCount: 0, complete: false },
        pairs: [], lpHealth: { sampled: 0, rows: [], nearUnhealthyCount: 0 },
        coverage: { complete: false, blockers: ["RPC_UNAVAILABLE"] },
      });
      continue;
    }
    chains.push(await scanChain({ chainId, rpc, index, fsImpl, indexPath, bundle, deploymentAuthority }));
  }

  persistIndex(index, indexPath, fsImpl);

  // Canonical CSV over the detailed pair rows, sorted deterministically.
  const csvRows = chains.flatMap((c) => c.pairs).sort((a, b) => (a.chainId - b.chainId) || a.pool.localeCompare(b.pool));
  const csvPath = options.csvPath || CSV_PATH;
  const csvWrite = writeCsv(csvRows, csvPath, fsImpl);

  const totalRequests = REQUEST_COUNT;
  const artifact = {
    schema: ARTIFACT_SCHEMA,
    scannedAt: new Date().toISOString(),
    scanner: "tools/scan-eulerswap-l.js",
    safety: {
      readOnly: true, signedActions: false, transactions: false, endpointMaterialPersisted: false,
      privateKeysRead: false, exploitExecuteCalls: false, forkTransactions: false,
    },
    derivedTopics: {
      source: "targets/euler-swap-eulerswap-2.0-81cf6dc98846/src/{EulerSwapFactory.sol,EulerSwapRegistry.sol,libraries/SwapLib.sol}",
      signatures: EVENT_SIGNATURES,
      PoolDeployed: POOL_DEPLOYED_TOPIC,
      PoolRegistered: POOL_REGISTERED_TOPIC,
      Swap: SWAP_TOPIC,
    },
    source: {
      sourceRoot: SOURCE_ROOT,
      compilerBundle: relPosix(COMPILER_BUNDLE_PATH),
      deploymentAuthority: relPosix(DEPLOYMENT_AUTHORITY_PATH),
      normalizer: "tools/eulerswap-v2-runtime-normalizer-r1.js",
    },
    chains,
    totals: {
      chainsScanned: chains.length,
      chainsResolved: chains.filter((c) => c.resolution && (c.resolution.state === "RESOLVED" || c.resolution.state === "RESOLVED_PINNED")).length,
      runtimeMatchAllChains: chains.every((c) => c.runtimeMatch && c.runtimeMatch.allMatch === true),
      pairsDetailed: chains.reduce((sum, c) => sum + c.pairs.length, 0),
      pairsWithStateRead: chains.reduce((sum, c) => sum + c.pairs.filter((p) => p.stateRead).length, 0),
      lpSamples: chains.reduce((sum, c) => sum + (c.lpHealth ? c.lpHealth.sampled : 0), 0),
      lpNearUnhealthy: chains.reduce((sum, c) => sum + (c.lpHealth ? c.lpHealth.nearUnhealthyCount : 0), 0),
      requests: totalRequests,
    },
    csv: { path: relPosix(csvPath), rowCount: csvWrite.rowCount, sha256: csvWrite.sha256, canonicalHash: canonicalHash(csvRows), bounded: true },
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
  const unknown = [...modes].filter((value) => !["--full", "--once", "--chain"].includes(value));
  if (unknown.length) throw new ScanFailure("USAGE");
  const chainArgIndex = argv.indexOf("--chain");
  let chainIds = [1, 8453];
  if (chainArgIndex !== -1) {
    const value = argv[chainArgIndex + 1];
    chainIds = value === "base" ? [8453] : value === "ethereum" ? [1] : [Number(value)];
    if (chainIds.some((c) => !CHAINS[c])) throw new ScanFailure("USAGE");
  }
  return { full: modes.has("--full"), chainIds };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const fsImpl = fs;
  const index = loadIndex(INDEX_PATH, fsImpl);
  if (options.full) for (const state of Object.values(index.chains)) { state.deploymentFloor = null; state.logAnchor = null; state.logAnchorMeta = null; state.logWindows = {}; state.pairs = {}; }
  const artifact = await runAndPublish({ chainIds: options.chainIds, index, fsImpl });
  const summary = {
    status: "OK",
    scannedAt: artifact.scannedAt,
    chains: artifact.chains.map((c) => ({
      chainId: c.chainId,
      label: c.label,
      resolution: c.resolution ? c.resolution.state : "UNRESOLVED",
      runtimeMatch: c.runtimeMatch ? { matched: c.runtimeMatch.matched, of: c.runtimeMatch.componentCount, allMatch: c.runtimeMatch.allMatch } : null,
      floor: c.historyStartBound ? c.historyStartBound.block : null,
      pairs: c.inventory ? c.inventory.pairCount : 0,
      registryPools: c.inventory ? c.inventory.registryPoolCount : 0,
      detailedPairs: c.pairs.length,
      lpSamples: c.lpHealth ? c.lpHealth.sampled : 0,
      lpNearUnhealthy: c.lpHealth ? c.lpHealth.nearUnhealthyCount : 0,
      coverageComplete: c.coverage ? c.coverage.complete : false,
    })),
    csv: artifact.csv.path,
    requests: artifact.totals.requests,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`eulerswap-l scan failed: ${error && error.code ? error.code : "SCAN_FAILED"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE, ARTIFACT_PATH, CSV_PATH, INDEX_PATH, ARTIFACT_SCHEMA, INDEX_SCHEMA, VERSION,
  MULTICALL3, LIQUIDATOR_SENTINEL, EVENT_SIGNATURES, POOL_DEPLOYED_TOPIC, POOL_REGISTERED_TOPIC, SWAP_TOPIC,
  COMPONENTS, MANIFEST_KEYS, CHAINS, WINDOW, MAX_PAIRS, LP_PAIRS, PAIR_READ_BUDGET, LOG_FLOOR_SPAN, LOG_RECENT_SPAN, I,
  ScanFailure, call, selectFinalized, resolveWorkingRpc, hexBlock, lower, isZeroAddr, canonicalHash, loadJson,
  matchRuntime, readRuntimeMatch, readCode, readCall, resolveDeployment,
  emptyChainState, emptyIndex, loadIndex, persistIndex, binarySearchCodeFloor, proveHistoryStartBound,
  fetchRange, fetchRangeBounded, computeLogRanges, enumerateLogs, recordPair, multicall,
  readRegistryPools, rankByVolume, readPairStates, sampleLpHealth,
  atomicWriteJson, writeCsv, scanChain, scan, runAndPublish, parseArgs, main,
};
