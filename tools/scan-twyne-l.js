#!/usr/bin/env node
"use strict";

// Twyne (Ethereum mainnet, chainId 1) L-class read-only observation producer.
//
// Resolves the LIVE Twyne CollateralVaultFactory + VaultManager + intermediate
// vault implementation from the Sept bounty-tree artifacts, enumerates the live
// CollateralVaults from the factory's `T_CollateralVaultCreated(address indexed)`
// log from the Sept-tree pinned floor forward to head, and reads a bounded
// per-vault conservation / liquidation-readiness surface.
//
// Conventions mirrored from tools/scan-euler-l.js (Euler EVK L surface) and
// tools/scan-eulerswap-l.js:
//   * eth_getCode binary-search deployment-floor proof (omitted when a proven
//     floor already exists in the Sept-tree pin),
//   * bounded, resumable, adaptive-window eth_getLogs enumeration with a verify
//     re-read and a per-window done-map,
//   * Multicall3-batched state reads, fail-closed (a null/revert is unresolved,
//     never a default),
//   * atomic artifact writes, canonical CSV + sha256, process-only endpoints,
//   * sequential reads, no signing, no transactions, no private-key material.
//
// Every unknown stays unknown: cross-asset conservation is NOT computed without
// the vault's own quote view (the CollateralVault exposes only a 1:1
// `convertToAssets` share/asset identity, never a cross-asset quote), and the
// resolution state is recorded as FACTORY_UNKNOWN (fail-closed) when the tree
// cannot bind the live factory.
//
// Read-only. RPC material stays process-only and is never printed or persisted.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc, loadRpcUrls } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const ARTIFACT_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "twyne-l.json");
const CSV_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "twyne-l.csv");
const INDEX_PATH = path.join(WORKSPACE, "reports", "monitor", "twyne-l-index.json");

const ARTIFACT_SCHEMA = "twyne-l-observation/v1";
const INDEX_SCHEMA = "twyne-l-index/v1";
const VERSION = 1;
const CHAIN_ID = 1;

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

// Sept bounty-tree artifacts (reports/raw/fast/twyne-bounty-hunt-20260922/).
const SEPT_TREE_DIR = "reports/raw/fast/twyne-bounty-hunt-20260922";
const SEPT_TREE_PIN = 26035791;

// Address-keyed resolution inputs from the Sept tree.
//   impls.json "Collateral Vault Factory" proxy / impl
//   impls.json "Vault Manager" proxy / impl
//   impls.json BeaconProxy keys -> beacon -> EVault impl
//   live.json vaultManager.factory double-binds the factory proxy.
const FACTORY_PROXY = "0xa1517cCe0bE75700A8838EA1cEE0dc383cd3A332";
const FACTORY_IMPL = "0x70879b4f43a5ae639173fa4e3546f4775f0e4383";
const VAULT_MANAGER_PROXY = "0x0acd3A3c8Ab6a5F7b5A594C88DFa28999dA858aC";
const VAULT_MANAGER_IMPL = "0x1216069eb4b40bd7f3de9a8e58da04e3a62f1d3c";
const INTERMEDIATE_VAULT_IMPL = "0x2ff808ea1716d77cae91d85feeeef74baac85106";
const BEACON = "0xb5eb1d005e389bef38161691e2083b4d86ff647a";
const KNOWN_INTERMEDIATE_VAULTS = Object.freeze([
  "0x7613D202Af490c3d1cE1873b0a7022a34E89815f",
  "0x75029a47f28550C93Ad5A3BbD2d9b5315204B561",
  "0x87b8081A3ace680f35125F469526Ac10f5418Ca7",
  "0x79cf33e623555e899d4ee122b9bfa0214fa5a4a1",
]);

// EIP1967 storage slots.
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

// Exact event signature derived from the in-tree source
// (targets/twyne-contracts-v1/src/interfaces/IEvents.sol and the emitting site
// src/TwyneFactory/CollateralVaultFactory.sol).
const EVENT_SIGNATURES = Object.freeze({
  T_CollateralVaultCreated: "T_CollateralVaultCreated(address)",
});
const T_COLLATERAL_VAULT_CREATED_TOPIC = ethers.id(EVENT_SIGNATURES.T_CollateralVaultCreated);

// Bounds.
const WINDOW = 10_000;          // base log window
const MIN_WINDOW = 1_000;       // split floor on provider range rejection
const LOG_CONCURRENCY = 1;      // sequential
const MC_BATCH = 200;
const MC_CONCURRENCY = 1;       // sequential
const TIMEOUT_MS = 30_000;
const MAX_DETAILED_VAULTS = 40; // per-vault detail read cap (version-4 vaults)
const REQUEST_BUDGET = 240;     // bounded requests per run
const MAX_WALL_MS = 16 * 60 * 1000;

const I = Object.freeze({
  factory: new ethers.Interface([
    "function vaultManager() view returns (address)",
    "function version() pure returns (uint)",
    "function admin() view returns (address)",
    "function owner() view returns (address)",
    "function isCollateralVault(address) view returns (bool)",
    "function pauseState() view returns (uint8)",
  ]),
  vaultManager: new ethers.Interface([
    "function collateralVaultFactory() view returns (address)",
    "function version() pure returns (uint)",
    "function owner() view returns (address)",
    "function admin() view returns (address)",
    "function isIntermediateVault(address) view returns (bool)",
    "function liqParams(address intermediateVault,address targetAsset) view returns (uint16,uint16,uint16)",
    "function maxTwyneLTVs(address intermediateVault,address targetAsset) view returns (uint16)",
    "function externalLiqBuffers(address intermediateVault,address targetAsset) view returns (uint16)",
    "function borrowBuffer(address intermediateVault,address targetAsset) view returns (uint16)",
  ]),
  vault: new ethers.Interface([
    "function version() pure returns (uint)",
    "function totalAssetsDepositedOrReserved() view returns (uint)",
    "function twyneLiqLTV() view returns (uint)",
    "function maxRelease() view returns (uint)",
    "function canLiquidate() view returns (bool)",
    "function intermediateVault() view returns (address)",
    "function targetVault() view returns (address)",
    "function asset() view returns (address)",
    "function borrower() view returns (address)",
    "function convertToAssets(uint shares) pure returns (uint)",
    "function maxRepay() view returns (uint)",
  ]),
  evault: new ethers.Interface([
    "function asset() view returns (address)",
    "function debtOf(address account) view returns (uint256)",
    "function LTVLiquidation(address collateral) view returns (uint16)",
    "function accountLiquidity(address account,bool liquidation) view returns (uint256 collateralValue,uint256 liabilityValue)",
  ]),
  beacon: new ethers.Interface([
    "function implementation() view returns (address)",
  ]),
  multicall: new ethers.Interface([
    "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])",
  ]),
  created: new ethers.Interface([
    "event T_CollateralVaultCreated(address indexed vault)",
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
function canonicalHash(value) { return `0x${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function loadJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; } }
function slotToAddress(raw) {
  const s = String(raw || "");
  if (!/^0x[0-9a-f]{64}$/i.test(s)) return null;
  const addr = `0x${s.slice(26)}`;
  return /^0x0{40}$/i.test(addr) ? null : addr;
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

// --- resolution (Sept-tree -> live on-chain double-bind) --------------------------------
// The Sept tree supplies the proxy addresses (impls.json address-keyed entries,
// double-bound by live.json vaultManager.factory) and the implementation
// addresses. The live proxies are then verified by reading their own EIP1967
// slots (ERC1967 proxies) / beacon (BeaconProxy intermediate vaults) and
// comparing to the tree impls. A slot that cannot be read is UNPROVEN, never a
// default. If the tree cannot bind the factory the state is FACTORY_UNKNOWN.
async function resolveDeployment({ rpc, blockTag }) {
  const implsPath = path.join(WORKSPACE, SEPT_TREE_DIR, "impls.json");
  const livePath = path.join(WORKSPACE, SEPT_TREE_DIR, "live.json");
  const impls = loadJson(implsPath);
  const live = loadJson(livePath);

  const treeFactoryProxy = impls && impls.proxies && impls.proxies[lower(FACTORY_PROXY)]
    ? lower(FACTORY_PROXY) : null;
  const treeVmProxy = impls && impls.proxies && impls.proxies[lower(VAULT_MANAGER_PROXY)]
    ? lower(VAULT_MANAGER_PROXY) : null;
  const liveFactory = live && live.vaultManager ? lower(live.vaultManager.factory) : null;

  const treePresent = Boolean(impls && treeFactoryProxy && treeVmProxy);
  const factoryDoubleBound = Boolean(treeFactoryProxy && liveFactory && treeFactoryProxy === liveFactory);

  const source = {
    kind: "SEPT_TREE_ARTIFACTS",
    dir: SEPT_TREE_DIR,
    implsPath: relPosix(implsPath),
    livePath: relPosix(livePath),
    implsPresent: Boolean(impls),
    livePresent: Boolean(live),
    pin: impls && Number.isFinite(impls.pin) ? impls.pin : SEPT_TREE_PIN,
    factoryProxyFromTree: treeFactoryProxy,
    vaultManagerProxyFromTree: treeVmProxy,
    factoryProxyFromLiveJson: liveFactory,
    factoryDoubleBound,
  };

  if (!treePresent) {
    return {
      state: "FACTORY_UNKNOWN",
      reason: "TREE_FACTORY_UNBOUND",
      source,
      addresses: {},
      codePresence: {},
      eip1967: {},
      crossBinds: [],
      versions: {},
      resolved: false,
    };
  }

  // Code presence for every resolution address.
  const addressMap = {
    factoryProxy: FACTORY_PROXY,
    factoryImpl: FACTORY_IMPL,
    vaultManagerProxy: VAULT_MANAGER_PROXY,
    vaultManagerImpl: VAULT_MANAGER_IMPL,
    intermediateVaultImpl: INTERMEDIATE_VAULT_IMPL,
    beacon: BEACON,
  };
  const codePresence = {};
  for (const [name, address] of Object.entries(addressMap)) {
    const code = await readCode(rpc, address, blockTag);
    codePresence[name] = {
      address: lower(address),
      present: typeof code === "string" && code.length > 2,
      byteSize: typeof code === "string" && code.length > 2 ? (code.length - 2) / 2 : 0,
    };
  }
  const ivPresence = {};
  for (const iv of KNOWN_INTERMEDIATE_VAULTS) {
    const code = await readCode(rpc, iv, blockTag);
    ivPresence[lower(iv)] = { address: lower(iv), present: typeof code === "string" && code.length > 2, byteSize: typeof code === "string" && code.length > 2 ? (code.length - 2) / 2 : 0 };
  }

  // EIP1967 slot reads on the live proxies.
  async function readImplSlot(proxy, slot) {
    try {
      const raw = await call(rpc, "eth_getStorageAt", [proxy, slot, blockTag]);
      return { raw: String(raw || ""), address: slotToAddress(raw), readable: /^0x[0-9a-f]{64}$/i.test(String(raw || "")) };
    } catch (_) {
      return { raw: null, address: null, readable: false };
    }
  }

  const factorySlot = await readImplSlot(FACTORY_PROXY, EIP1967_IMPL_SLOT);
  const vmSlot = await readImplSlot(VAULT_MANAGER_PROXY, EIP1967_IMPL_SLOT);
  const ivBeaconSlot = await readImplSlot(KNOWN_INTERMEDIATE_VAULTS[0], EIP1967_BEACON_SLOT);

  // Beacon -> implementation().
  let beaconImplementation = null;
  if (ivBeaconSlot.address) {
    const impl = await readCall(rpc, ivBeaconSlot.address, I.beacon, "implementation", [], blockTag);
    beaconImplementation = impl ? lower(impl[0]) : null;
  }

  const eip1967 = {
    factory: {
      slot: EIP1967_IMPL_SLOT,
      observedImpl: factorySlot.address,
      expectedImpl: lower(FACTORY_IMPL),
      readable: factorySlot.readable,
      bind: Boolean(factorySlot.address && lower(FACTORY_IMPL) && factorySlot.address === lower(FACTORY_IMPL)),
      state: factorySlot.address ? (factorySlot.address === lower(FACTORY_IMPL) ? "BOUND" : "MISMATCH") : "UNPROVEN",
    },
    vaultManager: {
      slot: EIP1967_IMPL_SLOT,
      observedImpl: vmSlot.address,
      expectedImpl: lower(VAULT_MANAGER_IMPL),
      readable: vmSlot.readable,
      bind: Boolean(vmSlot.address && lower(VAULT_MANAGER_IMPL) && vmSlot.address === lower(VAULT_MANAGER_IMPL)),
      state: vmSlot.address ? (vmSlot.address === lower(VAULT_MANAGER_IMPL) ? "BOUND" : "MISMATCH") : "UNPROVEN",
    },
    intermediateVault: {
      beaconSlot: EIP1967_BEACON_SLOT,
      observedBeacon: ivBeaconSlot.address,
      expectedBeacon: lower(BEACON),
      beaconImplementation,
      expectedImpl: lower(INTERMEDIATE_VAULT_IMPL),
      readable: ivBeaconSlot.readable,
      bind: Boolean(beaconImplementation && lower(INTERMEDIATE_VAULT_IMPL) && beaconImplementation === lower(INTERMEDIATE_VAULT_IMPL)),
      state: beaconImplementation ? (beaconImplementation === lower(INTERMEDIATE_VAULT_IMPL) ? "BOUND" : "MISMATCH") : "UNPROVEN",
    },
  };

  // On-chain double-binds (independent identity checks).
  const crossBinds = [];
  const pushBind = (name, observed, expected) => crossBinds.push({
    name,
    observed: observed ? lower(observed) : null,
    expected: expected ? lower(expected) : null,
    bind: Boolean(observed && expected && lower(observed) === lower(expected)),
  });

  const vmFactory = await readCall(rpc, VAULT_MANAGER_PROXY, I.vaultManager, "collateralVaultFactory", [], blockTag);
  pushBind("vaultManager.collateralVaultFactory", vmFactory && vmFactory[0], FACTORY_PROXY);
  const factoryVm = await readCall(rpc, FACTORY_PROXY, I.factory, "vaultManager", [], blockTag);
  pushBind("factory.vaultManager", factoryVm && factoryVm[0], VAULT_MANAGER_PROXY);

  const versions = {};
  const factoryVersion = await readCall(rpc, FACTORY_PROXY, I.factory, "version", [], blockTag);
  versions.factory = factoryVersion ? Number(BigInt(factoryVersion[0])) : null;
  const vmVersion = await readCall(rpc, VAULT_MANAGER_PROXY, I.vaultManager, "version", [], blockTag);
  versions.vaultManager = vmVersion ? Number(BigInt(vmVersion[0])) : null;

  const factoryAdmin = await readCall(rpc, FACTORY_PROXY, I.factory, "admin", [], blockTag);
  const factoryOwner = await readCall(rpc, FACTORY_PROXY, I.factory, "owner", [], blockTag);
  const vmOwner = await readCall(rpc, VAULT_MANAGER_PROXY, I.vaultManager, "owner", [], blockTag);
  const vmAdmin = await readCall(rpc, VAULT_MANAGER_PROXY, I.vaultManager, "admin", [], blockTag);

  // Intermediate-vault registration + per-ICV code presence.
  const ivRegistration = {};
  for (const iv of KNOWN_INTERMEDIATE_VAULTS) {
    const reg = await readCall(rpc, VAULT_MANAGER_PROXY, I.vaultManager, "isIntermediateVault", [iv], blockTag);
    ivRegistration[lower(iv)] = reg ? reg[0] === true : null;
  }

  const factoryBound = eip1967.factory.bind && eip1967.vaultManager.bind;
  const ivBound = eip1967.intermediateVault.bind;
  const resolved = Boolean(codePresence.factoryProxy.present && factoryBound && ivBound);

  return {
    state: resolved ? "RESOLVED" : "FACTORY_UNKNOWN",
    reason: resolved ? null : "IDENTITY_UNPROVEN",
    source,
    addresses: {
      factoryProxy: lower(FACTORY_PROXY),
      factoryImpl: lower(FACTORY_IMPL),
      vaultManagerProxy: lower(VAULT_MANAGER_PROXY),
      vaultManagerImpl: lower(VAULT_MANAGER_IMPL),
      intermediateVaultImpl: lower(INTERMEDIATE_VAULT_IMPL),
      beacon: lower(BEACON),
      intermediateVaults: KNOWN_INTERMEDIATE_VAULTS.map((a) => lower(a)),
    },
    codePresence: { ...codePresence, intermediateVaults: ivPresence },
    eip1967,
    crossBinds,
    versions,
    roles: {
      factoryAdmin: factoryAdmin ? lower(factoryAdmin[0]) : null,
      factoryOwner: factoryOwner ? lower(factoryOwner[0]) : null,
      vaultManagerOwner: vmOwner ? lower(vmOwner[0]) : null,
      vaultManagerAdmin: vmAdmin ? lower(vmAdmin[0]) : null,
    },
    intermediateVaultRegistration: ivRegistration,
    resolved,
  };
}

// --- history floor ----------------------------------------------------------------------
// The Sept tree pins block 26,035,791 as its proven floor; the directive omits a
// fresh binary-search proof when a proven floor exists. A bounded two-call
// eth_getCode classification records whether the pin is a genuine deployment
// floor or a snapshot anchor (runtime present one block before it).
async function classifyFloor(rpc, address, floor) {
  const before = await call(rpc, "eth_getCode", [address, hexBlock(floor - 1)]);
  const at = await call(rpc, "eth_getCode", [address, hexBlock(floor)]);
  const previousBlockCodeAbsent = before === "0x";
  const deploymentBlockCodePresent = typeof at === "string" && at.length > 2;
  return {
    block: floor,
    proven: true,
    derivation: "sept-tree-pin",
    source: `${SEPT_TREE_DIR}/impls.json`,
    snapshotFloor: !previousBlockCodeAbsent,
    deployFloorProven: previousBlockCodeAbsent && deploymentBlockCodePresent,
    note: previousBlockCodeAbsent
      ? "Twyne CollateralVaultFactory runtime absent one block before the Sept-tree pin and present at it."
      : "Twyne CollateralVaultFactory runtime is present one block before the Sept-tree pin: the pin is a snapshot anchor, not a deployment floor. CollateralVaults created before the pin are outside this bounded lane's scope.",
    proof: {
      method: "eth_getCode",
      address: lower(address),
      previousBlock: floor - 1,
      previousBlockCodeAbsent,
      deploymentBlockCodePresent,
      createdTopic: T_COLLATERAL_VAULT_CREATED_TOPIC,
    },
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
async function enumerateWindows(index, { rpc, address, topic0, from, to, onLogs, fsImpl = fs, indexPath = INDEX_PATH, verify = true }) {
  const done = index.createdWindows && typeof index.createdWindows === "object" ? index.createdWindows : (index.createdWindows = {});
  const total = Math.max(0, to - from + 1);
  const windowCount = Math.ceil(total / WINDOW);
  const pending = [];
  for (let i = 0; i < windowCount; i += 1) if (done[i] === undefined) pending.push(i);
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
        done[i] = logs.length;
      } catch (_) {
        failed.push(i);
      }
      if (++sincePersist >= 50) { sincePersist = 0; persistIndex(index, indexPath, fsImpl); }
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
      verification = { windowStart: wFrom, firstCount: done[i], secondCount: again.length, match: again.length === done[i] };
    } catch (_) {
      verification = { windowStart: wFrom, firstCount: done[i], secondCount: null, match: false };
    }
  }
  if (verification) index.enumerationVerification = verification;
  persistIndex(index, indexPath, fsImpl);
  return { windowCount, pendingWindows: pending.length, failedWindows: failed.length, verification };
}

// --- index ------------------------------------------------------------------------------
function emptyIndex() {
  return {
    schema: INDEX_SCHEMA,
    chainId: CHAIN_ID,
    version: VERSION,
    enumerationFloor: null,
    finalizedAtLastRun: null,
    createdWindows: {},
    vaults: {},
    createdTotal: 0,
    resolution: null,
    enumerationVerification: null,
    failures: 0,
    truncated: false,
  };
}

function loadIndex(file = INDEX_PATH, fsImpl = fs) {
  if (!fsImpl.existsSync(file)) return emptyIndex();
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyIndex();
    return {
      ...emptyIndex(),
      ...parsed,
      createdWindows: parsed.createdWindows || {},
      vaults: parsed.vaults || {},
    };
  } catch (_) { return emptyIndex(); }
}

function persistIndex(index, file = INDEX_PATH, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, `${JSON.stringify(index)}\n`);
}

function recordCreated(index, logs) {
  for (const log of logs) {
    let parsed = null;
    try { parsed = I.created.parseLog({ topics: log.topics, data: log.data }); } catch (_) { parsed = null; }
    if (!parsed) continue;
    const vault = lower(parsed.args[0]);
    if (!vault) continue;
    if (index.vaults[vault]) continue;
    index.vaults[vault] = {
      deployBlock: Number(BigInt(log.blockNumber)),
      txHash: String(log.transactionHash).toLowerCase(),
      logIndex: Number(BigInt(log.logIndex)),
    };
    index.createdTotal += 1;
  }
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

// --- per-vault reads --------------------------------------------------------------------
// Pass 1: version() for every enumerated vault (cheap, batched).
async function readVaultVersions(rpc, blockTag, vaults) {
  const entries = vaults.map((v) => ({ to: v, data: I.vault.encodeFunctionData("version", []) }));
  const { results, failures, requests } = entries.length ? await multicall(rpc, blockTag, entries) : { results: [], failures: 0, requests: 0 };
  const versions = new Map();
  vaults.forEach((v, i) => {
    const item = results[i];
    const d = item && item.success ? decodeOrNull(I.vault, "version", item.returnData) : null;
    versions.set(v, d ? Number(BigInt(d[0])) : null);
  });
  return { versions, failures, requests };
}

// Pass 2: vault-level detail for version-4 vaults (bounded read tuple).
const VAULT_DETAIL_FNS = [
  "totalAssetsDepositedOrReserved", "twyneLiqLTV", "maxRelease", "canLiquidate",
  "intermediateVault", "targetVault", "asset",
];
async function readVaultDetail(rpc, blockTag, vaults) {
  const entries = [];
  for (const vault of vaults) {
    for (const fn of VAULT_DETAIL_FNS) entries.push({ to: vault, data: I.vault.encodeFunctionData(fn, []) });
    entries.push({ to: vault, data: I.vault.encodeFunctionData("convertToAssets", [10n ** 18n]) });
  }
  const { results, failures, requests } = entries.length ? await multicall(rpc, blockTag, entries) : { results: [], failures: 0, requests: 0 };
  const detail = new Map();
  vaults.forEach((vault, index) => {
    const base = index * (VAULT_DETAIL_FNS.length + 1);
    detail.set(vault, {
      totalAssetsDepositedOrReservedRaw: decodeUintStr(I.vault, "totalAssetsDepositedOrReserved", results[base]),
      twyneLiqLTVRaw: decodeUintStr(I.vault, "twyneLiqLTV", results[base + 1]),
      maxReleaseRaw: decodeUintStr(I.vault, "maxRelease", results[base + 2]),
      canLiquidate: decodeBool(I.vault, "canLiquidate", results[base + 3]),
      intermediateVault: decodeAddr(I.vault, "intermediateVault", results[base + 4]),
      targetVault: decodeAddr(I.vault, "targetVault", results[base + 5]),
      asset: decodeAddr(I.vault, "asset", results[base + 6]),
      conversionAssetsRaw: decodeUintStr(I.vault, "convertToAssets", results[base + 7]),
    });
  });
  return { detail, failures, requests };
}

// Pass 3: intermediate-vault debt + target-vault readiness (3 per-vault fields).
async function readConservationAndReadiness(rpc, blockTag, targets) {
  const entries = [];
  for (const t of targets) {
    entries.push({ to: t.intermediateVault, data: I.evault.encodeFunctionData("debtOf", [t.vault]) });
    entries.push({ to: t.targetVault, data: I.evault.encodeFunctionData("debtOf", [t.vault]) });
    entries.push({ to: t.targetVault, data: I.evault.encodeFunctionData("LTVLiquidation", [t.asset]) });
    entries.push({ to: t.targetVault, data: I.evault.encodeFunctionData("accountLiquidity", [t.vault, true]) });
  }
  const { results, failures, requests } = entries.length ? await multicall(rpc, blockTag, entries) : { results: [], failures: 0, requests: 0 };
  const out = new Map();
  targets.forEach((t, index) => {
    const base = index * 4;
    const liq = results[base + 3];
    const liqDecoded = liq && liq.success ? decodeOrNull(I.evault, "accountLiquidity", liq.returnData) : null;
    out.set(t.vault, {
      intermediateDebtRaw: decodeUintStr(I.evault, "debtOf", results[base]),
      targetDebtRaw: decodeUintStr(I.evault, "debtOf", results[base + 1]),
      targetLTVLiquidationRaw: decodeUintStr(I.evault, "LTVLiquidation", results[base + 2]),
      accountLiquidityCollateralValueRaw: liqDecoded ? BigInt(liqDecoded[0]).toString() : null,
      accountLiquidityLiabilityValueRaw: liqDecoded ? BigInt(liqDecoded[1]).toString() : null,
    });
  });
  return { state: out, failures, requests };
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

function writeCsv(rows, file, fsImpl = fs) {
  const header = [
    "chainId", "vault", "deployBlock", "version", "totalAssetsDepositedOrReservedRaw", "twyneLiqLTVRaw",
    "maxReleaseRaw", "canLiquidate", "intermediateVault", "intermediateVaultKnown", "targetVault", "asset",
    "intermediateDebtRaw", "targetDebtRaw", "sameUnitDeltaRaw", "conversionAssetsRaw",
    "accountLiquidityCollateralValueRaw", "accountLiquidityLiabilityValueRaw", "externalReadyToLiquidate",
    "unhealthy", "conservationState", "detailState", "skipReason",
  ];
  const lines = rows.map((r) => [
    r.chainId, r.vault, r.deployBlock ?? "", r.version ?? "",
    r.totalAssetsDepositedOrReservedRaw ?? "", r.twyneLiqLTVRaw ?? "", r.maxReleaseRaw ?? "",
    r.canLiquidate ?? "", r.intermediateVault ?? "", r.intermediateVaultKnown ?? "", r.targetVault ?? "", r.asset ?? "",
    r.intermediateDebtRaw ?? "", r.targetDebtRaw ?? "", r.sameUnitDeltaRaw ?? "", r.conversionAssetsRaw ?? "",
    r.accountLiquidityCollateralValueRaw ?? "", r.accountLiquidityLiabilityValueRaw ?? "", r.externalReadyToLiquidate ?? "",
    r.unhealthy ?? "", r.conservationState ?? "", r.detailState ?? "", r.skipReason ?? "",
  ].join(","));
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

function buildVaultRows({ vaults, versions, detail, conservation, knownIvs }) {
  const rows = [];
  for (const vault of vaults) {
    const version = versions.get(vault);
    const d = detail.get(vault) || null;
    const c = conservation.get(vault) || null;
    const iv = d ? d.intermediateVault : null;
    const ivKnown = iv ? knownIvs.has(iv) : null;

    let detailState = "DETAILED";
    let skipReason = null;
    if (version === null) { detailState = "SKIPPED"; skipReason = "VERSION_UNRESOLVED"; }
    else if (version !== 4) { detailState = "SKIPPED"; skipReason = `VERSION_NOT_4 (version=${version})`; }
    else if (!d) { detailState = "SKIPPED"; skipReason = "DETAIL_READ_UNRESOLVED"; }

    let sameUnitDeltaRaw = null;
    if (d && d.totalAssetsDepositedOrReservedRaw !== null && c && c.intermediateDebtRaw !== null) {
      sameUnitDeltaRaw = (BigInt(d.totalAssetsDepositedOrReservedRaw) - BigInt(c.intermediateDebtRaw)).toString();
    }

    let externalReadyToLiquidate = null;
    if (c && c.accountLiquidityCollateralValueRaw !== null && c.accountLiquidityLiabilityValueRaw !== null) {
      externalReadyToLiquidate = BigInt(c.accountLiquidityLiabilityValueRaw) > BigInt(c.accountLiquidityCollateralValueRaw);
    }

    let conservationState = "INCOMPLETE";
    if (d && c && d.totalAssetsDepositedOrReservedRaw !== null && c.intermediateDebtRaw !== null && c.targetDebtRaw !== null) {
      conservationState = "RAW_COMPONENTS_AND_SAME_UNIT_LENS";
    } else if (d && c && d.totalAssetsDepositedOrReservedRaw !== null && c.intermediateDebtRaw !== null) {
      conservationState = "SAME_UNIT_LENS_ONLY";
    } else if (d && d.totalAssetsDepositedOrReservedRaw !== null) {
      conservationState = "RAW_COMPONENT_ONLY";
    }

    rows.push({
      chainId: CHAIN_ID,
      vault,
      deployBlock: null, // filled by caller
      version,
      totalAssetsDepositedOrReservedRaw: d ? d.totalAssetsDepositedOrReservedRaw : null,
      twyneLiqLTVRaw: d ? d.twyneLiqLTVRaw : null,
      maxReleaseRaw: d ? d.maxReleaseRaw : null,
      canLiquidate: d ? d.canLiquidate : null,
      intermediateVault: iv,
      intermediateVaultKnown: ivKnown,
      targetVault: d ? d.targetVault : null,
      asset: d ? d.asset : null,
      intermediateDebtRaw: c ? c.intermediateDebtRaw : null,
      targetDebtRaw: c ? c.targetDebtRaw : null,
      targetLTVLiquidationRaw: c ? c.targetLTVLiquidationRaw : null,
      sameUnitDeltaRaw,
      conversionAssetsRaw: d ? d.conversionAssetsRaw : null,
      accountLiquidityCollateralValueRaw: c ? c.accountLiquidityCollateralValueRaw : null,
      accountLiquidityLiabilityValueRaw: c ? c.accountLiquidityLiabilityValueRaw : null,
      externalReadyToLiquidate,
      unhealthy: d ? d.canLiquidate === true : null,
      conservationState,
      crossAssetIdentityComputed: false,
      detailState,
      skipReason,
    });
  }
  return rows;
}

// --- orchestration ----------------------------------------------------------------------
async function scan(options = {}) {
  const startMs = Date.now();
  const rpc = options.rpc || (await resolveWorkingRpc(CHAIN_ID));
  if (!rpc) throw new ScanFailure("RPC_UNAVAILABLE");
  const fsImpl = options.fsImpl || fs;
  const indexPath = options.indexPath || INDEX_PATH;
  const index = options.index || loadIndex(indexPath, fsImpl);
  const full = options.full === true;
  if (full) {
    index.createdWindows = {};
    index.vaults = {};
    index.createdTotal = 0;
    index.enumerationFloor = null;
    index.failures = 0;
    index.truncated = false;
  }

  const finalizedBlock = await selectFinalized(rpc);
  const finalizedNumber = Number(BigInt(finalizedBlock.number));
  const blockTag = finalizedBlock.hash;

  const resolution = await resolveDeployment({ rpc, blockTag });
  index.resolution = { state: resolution.state, resolved: resolution.resolved, at: finalizedNumber };
  persistIndex(index, indexPath, fsImpl);

  const knownIvs = new Set(KNOWN_INTERMEDIATE_VAULTS.map((a) => lower(a)));

  // Fail-closed: if the tree cannot bind the live factory, do NOT probe
  // arbitrary candidate selectors; record FACTORY_UNKNOWN and stop.
  if (!resolution.resolved) {
    const artifact = {
      schema: ARTIFACT_SCHEMA,
      scannedAt: new Date().toISOString(),
      scanner: "tools/scan-twyne-l.js",
      chainId: CHAIN_ID,
      safety: { readOnly: true, signedActions: false, transactions: false, endpointMaterialPersisted: false, privateKeysRead: false },
      pin: {
        number: finalizedNumber,
        hash: finalizedBlock.hash,
        timestamp: new Date(Number(BigInt(finalizedBlock.timestamp)) * 1000).toISOString(),
        finality: "finalized",
      },
      resolution,
      derivedTopics: { source: "targets/twyne-contracts-v1/src/interfaces/IEvents.sol", signatures: EVENT_SIGNATURES, T_CollateralVaultCreated: T_COLLATERAL_VAULT_CREATED_TOPIC },
      historyStartBound: null,
      enumeration: null,
      conservation: null,
      inventory: { vaultsInSurface: 0 },
      totals: { vaultsTotal: 0, vaultsVersion4: 0, vaultsDetailed: 0, unhealthyCanLiquidateTrue: 0 },
      reads: { requests: REQUEST_COUNT },
      budget: { requestBudget: REQUEST_BUDGET, requests: REQUEST_COUNT, withinBudget: REQUEST_COUNT <= REQUEST_BUDGET, wallMs: Date.now() - startMs, maxWallMs: MAX_WALL_MS },
      csv: null,
      vaults: [],
      coverage: { complete: false, blockers: [`factory ${resolution.state}`] },
    };
    return artifact;
  }

  const floor = (index.enumerationFloor && index.enumerationFloor.block) || SEPT_TREE_PIN;
  if (!index.enumerationFloor) {
    index.enumerationFloor = await classifyFloor(rpc, FACTORY_PROXY, floor);
  }

  const enumeration = await enumerateWindows(index, {
    rpc,
    address: FACTORY_PROXY,
    topic0: T_COLLATERAL_VAULT_CREATED_TOPIC,
    from: index.enumerationFloor.block,
    to: finalizedNumber,
    onLogs: (logs) => recordCreated(index, logs),
    fsImpl,
    indexPath,
  });
  index.finalizedAtLastRun = finalizedNumber;
  index.truncated = index.createdTotal > 10_000;
  persistIndex(index, indexPath, fsImpl);

  // Deterministic vault ordering (deploy block, then address).
  const vaults = Object.keys(index.vaults).sort((a, b) => {
    const da = index.vaults[a].deployBlock;
    const db = index.vaults[b].deployBlock;
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });

  const versionRead = await readVaultVersions(rpc, blockTag, vaults);
  const version4 = vaults.filter((v) => versionRead.versions.get(v) === 4);
  const detailed = version4.slice(0, MAX_DETAILED_VAULTS);
  const detailCapped = version4.length > detailed.length;

  const detailRead = await readVaultDetail(rpc, blockTag, detailed);
  const detail = detailRead.detail;

  const conservationTargets = detailed
    .map((v) => {
      const d = detail.get(v);
      if (!d || !d.intermediateVault || !d.targetVault || !d.asset) return null;
      return { vault: v, intermediateVault: d.intermediateVault, targetVault: d.targetVault, asset: d.asset };
    })
    .filter(Boolean);
  const conservationRead = await readConservationAndReadiness(rpc, blockTag, conservationTargets);

  const rows = buildVaultRows({
    vaults,
    versions: versionRead.versions,
    detail,
    conservation: conservationRead.state,
    knownIvs,
  });
  for (const row of rows) row.deployBlock = index.vaults[row.vault] ? index.vaults[row.vault].deployBlock : null;

  const csvRows = [...rows].sort((a, b) => a.vault.localeCompare(b.vault));
  const csvPath = options.csvPath || CSV_PATH;
  const csvWrite = writeCsv(csvRows, csvPath, fsImpl);

  const vaultsVersion4 = version4.length;
  const unhealthyCount = rows.filter((r) => r.canLiquidate === true).length;
  const conservationComponentCompleteRows = rows.filter((r) => r.totalAssetsDepositedOrReservedRaw !== null && r.intermediateDebtRaw !== null && r.targetDebtRaw !== null).length;
  const conservationSameUnitLensRows = rows.filter((r) => r.sameUnitDeltaRaw !== null).length;

  const enumerationComplete = enumeration.failedWindows === 0;
  const complete = resolution.resolved
    && index.enumerationFloor.proven === true
    && enumerationComplete
    && versionRead.failures === 0
    && detailRead.failures === 0
    && conservationRead.failures === 0
    && !detailCapped
    && REQUEST_COUNT <= REQUEST_BUDGET;

  const artifact = {
    schema: ARTIFACT_SCHEMA,
    scannedAt: new Date().toISOString(),
    scanner: "tools/scan-twyne-l.js",
    chainId: CHAIN_ID,
    safety: {
      readOnly: true, signedActions: false, transactions: false, endpointMaterialPersisted: false,
      privateKeysRead: false, exploitExecuteCalls: false, forkTransactions: false,
    },
    pin: {
      number: finalizedNumber,
      hash: finalizedBlock.hash,
      timestamp: new Date(Number(BigInt(finalizedBlock.timestamp)) * 1000).toISOString(),
      finality: "finalized",
    },
    contracts: {
      factoryProxy: lower(FACTORY_PROXY),
      factoryImpl: lower(FACTORY_IMPL),
      vaultManagerProxy: lower(VAULT_MANAGER_PROXY),
      vaultManagerImpl: lower(VAULT_MANAGER_IMPL),
      intermediateVaultImpl: lower(INTERMEDIATE_VAULT_IMPL),
      beacon: lower(BEACON),
      multicall3: MULTICALL3.toLowerCase(),
    },
    resolution,
    derivedTopics: {
      source: "targets/twyne-contracts-v1/src/interfaces/IEvents.sol",
      emitter: "targets/twyne-contracts-v1/src/TwyneFactory/CollateralVaultFactory.sol",
      signatures: EVENT_SIGNATURES,
      T_CollateralVaultCreated: T_COLLATERAL_VAULT_CREATED_TOPIC,
    },
    historyStartBound: index.enumerationFloor,
    enumeration: {
      method: "Sept-tree pinned floor + adaptive T_CollateralVaultCreated enumeration (verify re-read) + Multicall3 per-vault reads",
      windowSize: WINDOW,
      concurrency: LOG_CONCURRENCY,
      created: {
        windowCount: enumeration.windowCount,
        pendingWindows: enumeration.pendingWindows,
        failedWindows: enumeration.failedWindows,
        verification: enumeration.verification || index.enumerationVerification || null,
        verificationSource: enumeration.verification ? "this-run" : (index.enumerationVerification ? "resumable-index-last-verify-run" : null),
      },
      vaultsEnumerated: vaults.length,
      truncated: index.truncated === true,
    },
    conservation: {
      lens: "collateral-asset units only (vault.totalAssetsDepositedOrReserved, intermediateVault.debtOf, targetVault.debtOf, vault.convertToAssets identity)",
      crossAssetIdentityComputed: false,
      conversionView: "CollateralVaultBase.convertToAssets(uint) returns shares 1:1; no cross-asset quote view is exposed by the collateral vault",
      note: "deposited-reserved, intermediate debt and target debt are recorded as raw components. The same-unit lens (deposited - intermediate debt, both collateral-asset units) is computed; the cross-asset identity is NOT computed without the vault's own quote view. Fail-closed per row.",
    },
    inventory: {
      vaultsInSurface: rows.length,
      version4Vaults: vaultsVersion4,
      detailedVaults: detailed.length,
      detailCapped,
      detailCap: MAX_DETAILED_VAULTS,
      knownIntermediateVaults: [...knownIvs],
    },
    totals: {
      vaultsTotal: rows.length,
      vaultsVersion4,
      vaultsDetailed: detailed.length,
      unhealthyCanLiquidateTrue: unhealthyCount,
      externalReadyToLiquidateTrue: rows.filter((r) => r.externalReadyToLiquidate === true).length,
      conservationComponentCompleteRows,
      conservationSameUnitLensRows,
      versionReadFailures: versionRead.failures,
      detailReadFailures: detailRead.failures,
      conservationReadFailures: conservationRead.failures,
    },
    reads: {
      requests: REQUEST_COUNT,
      logWindows: enumeration.windowCount,
      logWindowFailures: enumeration.failedWindows,
      versionMulticallRequests: versionRead.requests,
      detailMulticallRequests: detailRead.requests,
      conservationMulticallRequests: conservationRead.requests,
    },
    budget: {
      requestBudget: REQUEST_BUDGET,
      requests: REQUEST_COUNT,
      withinBudget: REQUEST_COUNT <= REQUEST_BUDGET,
      wallMs: Date.now() - startMs,
      maxWallMs: MAX_WALL_MS,
      withinWall: (Date.now() - startMs) <= MAX_WALL_MS,
      sequential: true,
    },
    csv: { path: relPosix(csvPath), rowCount: csvWrite.rowCount, sha256: csvWrite.sha256, canonicalHash: canonicalHash(csvRows), bounded: true },
    vaults: rows,
    coverage: {
      complete,
      blockers: complete ? [] : [
        !resolution.resolved ? `factory ${resolution.state}` : null,
        !(index.enumerationFloor && index.enumerationFloor.proven) ? "history floor unproven" : null,
        !enumerationComplete ? "created-log enumeration incomplete" : null,
        detailCapped ? "per-vault detail cap reached" : null,
        REQUEST_COUNT > REQUEST_BUDGET ? "request budget exceeded" : null,
      ].filter(Boolean),
      honestAbsences: [
        index.enumerationFloor && index.enumerationFloor.snapshotFloor
          ? "Sept-tree pin is a snapshot anchor (factory runtime present before it); CollateralVaults created before the pin are outside this bounded lane's scope."
          : null,
        "cross-asset conservation identity is not computed (no cross-asset quote view exposed by the collateral vault).",
      ].filter(Boolean),
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
  const unknown = [...modes].filter((value) => !["--full", "--once", "--sync"].includes(value));
  if (unknown.length) throw new ScanFailure("USAGE");
  return { full: modes.has("--full"), sync: modes.has("--sync") };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.sync) {
    const index = loadIndex(INDEX_PATH);
    process.stdout.write(`twyne-l[sync] floor=${index.enumerationFloor ? index.enumerationFloor.block : "n/a"} vaults=${Object.keys(index.vaults).length} resolution=${index.resolution ? index.resolution.state : "n/a"} failures=${index.failures}\n`);
    return;
  }
  const artifact = await runAndPublish({ full: options.full });
  process.stdout.write(`${JSON.stringify({
    status: "OK",
    chain: "ethereum",
    pin: artifact.pin.number,
    factoryResolution: artifact.resolution.state,
    factoryProxy: artifact.contracts ? artifact.contracts.factoryProxy : null,
    vaultManagerProxy: artifact.contracts ? artifact.contracts.vaultManagerProxy : null,
    vaultsTotal: artifact.totals.vaultsTotal,
    vaultsVersion4: artifact.totals.vaultsVersion4,
    unhealthyCanLiquidateTrue: artifact.totals.unhealthyCanLiquidateTrue,
    conservationComponentCompleteRows: artifact.totals.conservationComponentCompleteRows,
    requests: artifact.reads.requests,
    complete: artifact.coverage.complete,
    scannedAt: artifact.scannedAt,
    csv: artifact.csv ? artifact.csv.path : null,
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`twyne-l scan failed: ${error && error.code ? error.code : "SCAN_FAILED"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE, ARTIFACT_PATH, CSV_PATH, INDEX_PATH, ARTIFACT_SCHEMA, INDEX_SCHEMA, VERSION, CHAIN_ID,
  MULTICALL3, SEPT_TREE_DIR, SEPT_TREE_PIN,
  FACTORY_PROXY, FACTORY_IMPL, VAULT_MANAGER_PROXY, VAULT_MANAGER_IMPL, INTERMEDIATE_VAULT_IMPL, BEACON, KNOWN_INTERMEDIATE_VAULTS,
  EIP1967_IMPL_SLOT, EIP1967_BEACON_SLOT, EVENT_SIGNATURES, T_COLLATERAL_VAULT_CREATED_TOPIC,
  WINDOW, MIN_WINDOW, LOG_CONCURRENCY, MC_BATCH, MC_CONCURRENCY, MAX_DETAILED_VAULTS, REQUEST_BUDGET, MAX_WALL_MS, I,
  ScanFailure, call, selectFinalized, resolveWorkingRpc, hexBlock, lower, slotToAddress, canonicalHash, loadJson,
  decodeOrNull, decodeAddr, decodeUintStr, decodeBool, readCode, readCall,
  resolveDeployment, classifyFloor, fetchRange, fetchRangeBounded, enumerateWindows,
  emptyIndex, loadIndex, persistIndex, recordCreated, multicall,
  readVaultVersions, readVaultDetail, readConservationAndReadiness, VAULT_DETAIL_FNS,
  atomicWriteJson, writeCsv, buildVaultRows, scan, runAndPublish, parseArgs, main,
};
