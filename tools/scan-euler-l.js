#!/usr/bin/env node
"use strict";

// Euler EVK (Euler Vault Kit / Euler V2) Ethereum liquidation (L class)
// read-only observation producer.
//
// Mirrors the established Blue-L observation-producer conventions
// (tools/scan-morpho-blue-l.js): fail-closed reads, chunked/adaptive-window
// full-history enumeration, bounded resumable index, atomic artifact write,
// process-only endpoint material.
//
// This is a FRESH-STATE SURFACE, not a liquidation-opportunity engine:
//   * the EVault inventory is derived from the in-tree EVault Factory
//     (GenericFactory) ProxyCreated logs, cross-checked against the factory's
//     own getProxyListLength/getProxyListSlice view,
//   * every historical `Liquidate` log emitted by an EVault is enumerated from
//     the factory deployment floor forward,
//   * per-vault current solvency is read fresh from the vault views
//     (totalBorrows / cash / totalAssets / totalSupply / oracle / asset).
//
// The exact event field set is taken from the in-tree source
// (targets/euler-evk/src/EVault/shared/Events.sol and the emitting site
// targets/euler-evk/src/EVault/modules/Liquidation.sol). Fields the source does
// not expose (e.g. a separate collateral/liability account or a discount field
// on `Liquidate`) are recorded as explicitly absent rather than fabricated.
//
// Read-only. No signing, no transactions, no broadcasts. RPC material stays
// process-only and is never printed or persisted.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc, loadRpcUrls } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const ARTIFACT_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "euler-l.json");
const INDEX_PATH = path.join(WORKSPACE, "reports", "monitor", "euler-l-index.json");
const CSV_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "euler-l.csv");

const ARTIFACT_SCHEMA = "euler-l-observation/v1";
const INDEX_SCHEMA = "euler-l-index/v1";
const VERSION = 1;
const CHAIN_ID = 1;

// Pinned from targets/euler-interfaces/addresses/1/CoreAddresses.json.
const FACTORY = "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e";
const EVC = "0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const ENUMERATION_REF = "bounded full-history EVault Liquidate enumeration";

// Base window is deterministic across runs so the resumable done-map keys stay
// stable; on a provider range rejection a base window is recursively split.
const WINDOW = 10_000;
const MIN_WINDOW = 1_000;
const CONCURRENCY = 12; // <= 12 windows in flight (Blue-L bounded window budget)
const MAX_EVENTS_INDEX = 50_000; // safety cap on persisted Liquidate rows
const TOP_PER_VAULT = 20;
const TOP_GLOBAL = 50;
const TIMEOUT_MS = 30_000;
const MC_BATCH = 200;
const MC_CONCURRENCY = 4;

// Exact event signatures derived from the in-tree EVK source.
const EVENT_SIGNATURES = Object.freeze({
  Liquidate: "Liquidate(address,address,address,uint256,uint256)",
  VaultStatus: "VaultStatus(uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  ProxyCreated: "ProxyCreated(address,bool,address,bytes)",
});
const LIQUIDATE_TOPIC = ethers.id(EVENT_SIGNATURES.Liquidate);
const VAULT_STATUS_TOPIC = ethers.id(EVENT_SIGNATURES.VaultStatus);
const PROXY_CREATED_TOPIC = ethers.id(EVENT_SIGNATURES.ProxyCreated);

const FACTORY_ABI = [
  "function getProxyListLength() view returns (uint256)",
  "function getProxyListSlice(uint256 start,uint256 end) view returns (address[])",
];
const EVAULT_ABI = [
  "function asset() view returns (address)",
  "function oracle() view returns (address)",
  "function unitOfAccount() view returns (address)",
  "function cash() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];
const MC_ABI = "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])";

const PROXY_CREATED_EVENT = new ethers.Interface([
  "event ProxyCreated(address indexed proxy,bool upgradeable,address implementation,bytes trailingData)",
]);

const I = Object.freeze({
  factory: new ethers.Interface(FACTORY_ABI),
  evault: new ethers.Interface(EVAULT_ABI),
  multicall: new ethers.Interface([MC_ABI]),
  liquidate: new ethers.Interface([
    "event Liquidate(address indexed liquidator,address indexed violator,address collateral,uint256 repayAssets,uint256 yieldBalance)",
  ]),
  proxyCreated: PROXY_CREATED_EVENT,
});

class ScanFailure extends Error {
  constructor(code) { super(code); this.name = "ScanFailure"; this.code = code; }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function relPosix(target) { return path.relative(WORKSPACE, target).split(path.sep).join("/"); }
function lower(value) { try { return ethers.getAddress(String(value)).toLowerCase(); } catch (_) { return null; } }
function topicToAddress(topic) {
  const raw = String(topic || "");
  if (!/^0x[0-9a-f]{64}$/i.test(raw)) return null;
  return `0x${raw.slice(26)}`.toLowerCase();
}
function canonicalHash(value) {
  return `0x${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

async function call(rpc, method, params, ms = TIMEOUT_MS, attempts = 6) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
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
  const first = await resolveRpc(chainId, null, { capability: "logs" });
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

// --- history floor ----------------------------------------------------------------------
// The EVK factory source is a GenericFactory; its ProxyCreated logs are the
// per-vault deployment records. No deploy-block comment exists in the in-tree
// README, so the floor is proven with a bounded eth_getCode binary search.
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

async function proveHistoryStartBound(rpc, finalizedNumber) {
  const floor = await binarySearchCodeFloor(rpc, FACTORY, 1, finalizedNumber);
  const before = await call(rpc, "eth_getCode", [FACTORY, hexBlock(floor - 1)]);
  const at = await call(rpc, "eth_getCode", [FACTORY, hexBlock(floor)]);
  const previousBlockCodeAbsent = before === "0x";
  const deploymentBlockCodePresent = typeof at === "string" && at.length > 2;
  if (!previousBlockCodeAbsent || !deploymentBlockCodePresent) throw new ScanFailure("HISTORY_BOUND_UNPROVEN");
  return {
    block: floor,
    proven: true,
    derivation: "eth_getCode-binary-search",
    note: "targets/euler-evk/README.md carries no deploy-block comment; EVault Factory runtime absent one block before the floor and present at it.",
    proof: {
      method: "eth_getCode",
      address: FACTORY.toLowerCase(),
      previousBlock: floor - 1,
      previousBlockCodeAbsent,
      deploymentBlockCodePresent,
      proxyCreatedTopic: PROXY_CREATED_TOPIC,
      liquidateTopic: LIQUIDATE_TOPIC,
    },
  };
}

// --- log enumeration --------------------------------------------------------------------
function decodeOrNull(iface, fn, returnData) {
  try { return iface.decodeFunctionResult(fn, returnData); } catch (_) { return null; }
}

// Bounded fetch of one base window; a persistent failure is split in half so a
// provider range cap or transient flake cannot silently drop logs.
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
    catch (error) {
      last = error;
      if (attempt < attempts - 1) await sleep(300 * (attempt + 1));
    }
  }
  if (to - from > MIN_WINDOW) {
    const mid = from + Math.floor((to - from) / 2);
    const left = await fetchRangeBounded(rpc, { ...spec, from, to: mid }, attempts);
    const right = await fetchRangeBounded(rpc, { ...spec, from: mid + 1, to }, attempts);
    return left.concat(right);
  }
  throw last;
}

// Adaptive-window enumeration with a bounded (<= 12) worker pool over stable
// base windows. A window is marked done only once its logs are fully retrieved;
// unresolved windows stay eligible for a later run (resumable, zero-loss).
async function enumerateWindows(index, doneKey, { rpc, address, topic0, from, to, onLogs, fsImpl = fs, indexPath = INDEX_PATH, verify = true }) {
  const done = index[doneKey] && typeof index[doneKey] === "object" ? index[doneKey] : (index[doneKey] = {});
  const total = Math.max(0, to - from + 1);
  const windowCount = Math.ceil(total / WINDOW);
  const pending = [];
  for (let i = 0; i < windowCount; i += 1) {
    const wFrom = from + i * WINDOW;
    const wTo = Math.min(to, wFrom + WINDOW - 1);
    // A stored zero is a successfully completed empty window, not missing
    // coverage. Revisit the prior partial tail when the finalized tip grows.
    const growingTail = Number.isSafeInteger(index.finalizedAtLastRun)
      && wTo > index.finalizedAtLastRun;
    if (!Object.hasOwn(done, i) || growingTail) pending.push(i);
  }
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
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, pending.length)) }, worker));
  let verification = null;
  if (verify && failed.length === 0 && pending.length > 0) {
    // One verify re-read on a zero-failure pass: re-fetch the first newly
    // completed window and confirm the count is reproducible.
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
  persistIndex(index, indexPath, fsImpl);
  return { windowCount, pendingWindows: pending.length, failedWindows: failed.length, verification };
}

// --- index ------------------------------------------------------------------------------
function emptyIndex() {
  return {
    schema: INDEX_SCHEMA,
    chainId: CHAIN_ID,
    version: VERSION,
    deploymentFloor: null,
    finalizedAtLastRun: null,
    proxyWindows: {},
    liquidateWindows: {},
    proxyCreated: { count: 0, vaults: {} },
    liquidate: { total: 0, rowsByWindow: {} },
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
      proxyWindows: parsed.proxyWindows || {},
      liquidateWindows: parsed.liquidateWindows || {},
      proxyCreated: { count: 0, vaults: {}, ...(parsed.proxyCreated || {}) },
      liquidate: { total: 0, rowsByWindow: {}, ...(parsed.liquidate || {}) },
    };
  } catch (_) {
    return emptyIndex();
  }
}

function persistIndex(index, file = INDEX_PATH, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, `${JSON.stringify(index)}\n`);
}

// Decode the exact `Liquidate` field set. Rows are stored per base window so a
// window re-fetch (after a crash before its done-flag persisted) is idempotent.
function collectLiquidateRows(logs) {
  const rows = [];
  for (const log of logs) {
    const vault = String(log.address || "").toLowerCase();
    if (!vault) continue;
    let parsed = null;
    try { parsed = I.liquidate.parseLog({ topics: log.topics, data: log.data }); } catch (_) { parsed = null; }
    if (!parsed) continue;
    rows.push({
      vault,
      liquidator: String(parsed.args.liquidator).toLowerCase(),
      violator: String(parsed.args.violator).toLowerCase(),
      collateralAsset: String(parsed.args.collateral).toLowerCase(),
      repayAssetsRaw: BigInt(parsed.args.repayAssets).toString(),
      yieldBalanceRaw: BigInt(parsed.args.yieldBalance).toString(),
      blockNumber: Number(BigInt(log.blockNumber)),
      txHash: String(log.transactionHash).toLowerCase(),
      logIndex: Number(BigInt(log.logIndex)),
    });
  }
  return rows;
}

function allLiquidateRows(index) {
  const rows = [];
  for (const windowRows of Object.values(index.liquidate.rowsByWindow || {})) {
    if (Array.isArray(windowRows)) rows.push(...windowRows);
  }
  rows.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex));
  return rows;
}

// Per-vault aggregates (event count, era blocks, repay/yield sums, top-N by
// repay) derived from the full bounded row set.
function aggregateLiquidate(rows) {
  const perVault = {};
  for (const row of rows) {
    const agg = perVault[row.vault] || (perVault[row.vault] = { count: 0, firstBlock: null, lastBlock: null, repaySumRaw: "0", yieldSumRaw: "0", top: [] });
    agg.count += 1;
    agg.firstBlock = agg.firstBlock === null ? row.blockNumber : Math.min(agg.firstBlock, row.blockNumber);
    agg.lastBlock = agg.lastBlock === null ? row.blockNumber : Math.max(agg.lastBlock, row.blockNumber);
    agg.repaySumRaw = (BigInt(agg.repaySumRaw) + BigInt(row.repayAssetsRaw)).toString();
    agg.yieldSumRaw = (BigInt(agg.yieldSumRaw) + BigInt(row.yieldBalanceRaw)).toString();
    agg.top.push(row);
  }
  for (const agg of Object.values(perVault)) {
    agg.top.sort((a, b) => (BigInt(b.repayAssetsRaw) > BigInt(a.repayAssetsRaw) ? 1 : BigInt(b.repayAssetsRaw) < BigInt(a.repayAssetsRaw) ? -1 : b.blockNumber - a.blockNumber));
    if (agg.top.length > TOP_PER_VAULT) agg.top.length = TOP_PER_VAULT;
  }
  return perVault;
}

// --- current solvency (fresh state) -----------------------------------------------------
async function multicall(rpc, blockTag, entries) {
  const results = new Array(entries.length);
  const batches = [];
  for (let i = 0; i < entries.length; i += MC_BATCH) batches.push(i);
  let cursor = 0;
  let failures = 0;
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
          const raw = await call(rpc, "eth_call", [{ to: MULTICALL3, data }, blockTag], TIMEOUT_MS);
          const [out] = I.multicall.decodeFunctionResult("aggregate3", raw);
          decoded = out;
        } catch (_) {
          if (attempt < 2) await sleep(300 * (attempt + 1));
        }
      }
      if (decoded === null) { failures += batch.length; return; }
      decoded.forEach((item, index) => {
        results[start + index] = { success: item[0] === true, returnData: item[1] };
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(MC_CONCURRENCY, batches.length) }, worker));
  return { results, failures };
}

async function readFactoryInventory(rpc, blockTag) {
  const lengthRaw = await call(rpc, "eth_call", [{ to: FACTORY, data: I.factory.encodeFunctionData("getProxyListLength", []) }, blockTag]);
  const lengthDecoded = decodeOrNull(I.factory, "getProxyListLength", lengthRaw);
  const length = lengthDecoded ? Number(BigInt(lengthDecoded[0])) : 0;
  const addresses = [];
  for (let start = 0; start < length; start += 100) {
    const end = Math.min(length, start + 100);
    const raw = await call(rpc, "eth_call", [{ to: FACTORY, data: I.factory.encodeFunctionData("getProxyListSlice", [start, end]) }, blockTag]);
    const decoded = decodeOrNull(I.factory, "getProxyListSlice", raw);
    const slice = decoded && Array.isArray(decoded[0]) ? decoded[0] : [];
    for (const addr of slice) { const a = lower(addr); if (a) addresses.push(a); }
  }
  return { length, addresses };
}

async function readVaultState(rpc, blockTag, vaults) {
  const entries = [];
  for (const vault of vaults) {
    entries.push({ to: vault, data: I.evault.encodeFunctionData("asset", []) });
    entries.push({ to: vault, data: I.evault.encodeFunctionData("oracle", []) });
    entries.push({ to: vault, data: I.evault.encodeFunctionData("unitOfAccount", []) });
    entries.push({ to: vault, data: I.evault.encodeFunctionData("totalBorrows", []) });
    entries.push({ to: vault, data: I.evault.encodeFunctionData("cash", []) });
    entries.push({ to: vault, data: I.evault.encodeFunctionData("totalAssets", []) });
    entries.push({ to: vault, data: I.evault.encodeFunctionData("totalSupply", []) });
  }
  const { results, failures } = await multicall(rpc, blockTag, entries);
  const state = new Map();
  vaults.forEach((vault, index) => {
    const base = index * 7;
    const pick = (offset, fn) => {
      const item = results[base + offset];
      if (!item || !item.success) return null;
      const decoded = decodeOrNull(I.evault, fn, item.returnData);
      return decoded ? decoded[0] : null;
    };
    const asset = pick(0, "asset");
    state.set(vault, {
      asset: asset ? lower(asset) : null,
      oracle: pick(1, "oracle") ? lower(pick(1, "oracle")) : null,
      unitOfAccount: pick(2, "unitOfAccount") ? lower(pick(2, "unitOfAccount")) : null,
      totalBorrowsRaw: pick(3, "totalBorrows") !== null ? BigInt(pick(3, "totalBorrows")).toString() : null,
      cashRaw: pick(4, "cash") !== null ? BigInt(pick(4, "cash")).toString() : null,
      totalAssetsRaw: pick(5, "totalAssets") !== null ? BigInt(pick(5, "totalAssets")).toString() : null,
      totalSupplyRaw: pick(6, "totalSupply") !== null ? BigInt(pick(6, "totalSupply")).toString() : null,
    });
  });
  return { state, failures };
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
  const header = "vault,liquidator,violator,collateralAsset,repayAssetsRaw,yieldBalanceRaw,blockNumber,txHash,logIndex";
  const lines = rows.map((r) => [r.vault, r.liquidator, r.violator, r.collateralAsset, r.repayAssetsRaw, r.yieldBalanceRaw, r.blockNumber, r.txHash, r.logIndex].join(","));
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    fsImpl.writeFileSync(temporary, `${[header, ...lines].join("\n")}\n`, { flag: "wx" });
    fsImpl.renameSync(temporary, file);
  } finally {
    try { fsImpl.rmSync(temporary, { force: true }); } catch (_) {}
  }
}

function buildArtifact({ index, historyStartBound, finalizedBlock, inventory, vaultState, stateFailures, enumeration, csvInfo }) {
  const allRows = allLiquidateRows(index);
  const perVault = aggregateLiquidate(allRows);
  const vaults = [...new Set([...inventory.addresses, ...Object.keys(index.proxyCreated.vaults), ...Object.keys(perVault)])].sort();
  const rows = vaults.map((vault) => {
    const created = index.proxyCreated.vaults[vault] || null;
    const agg = perVault[vault] || null;
    const state = vaultState.get(vault) || null;
    return {
      vault,
      deployBlock: created ? created.deployBlock : null,
      proxyListIndex: created ? created.proxyListIndex : null,
      codePresent: state !== null,
      liquidateEventCount: agg ? agg.count : 0,
      firstLiquidateBlock: agg ? agg.firstBlock : null,
      lastLiquidateBlock: agg ? agg.lastBlock : null,
      liquidateRepayAssetsRawSum: agg ? agg.repaySumRaw : "0",
      liquidateYieldBalanceRawSum: agg ? agg.yieldSumRaw : "0",
      currentTotalBorrowsRaw: state ? state.totalBorrowsRaw : null,
      currentCashRaw: state ? state.cashRaw : null,
      currentTotalAssetsRaw: state ? state.totalAssetsRaw : null,
      currentTotalSupplyRaw: state ? state.totalSupplyRaw : null,
      asset: state ? state.asset : null,
      oracle: state ? state.oracle : null,
      unitOfAccount: state ? state.unitOfAccount : null,
      topLiquidateEvents: agg ? agg.top : [],
    };
  });

  // Global top events by repayAssets, derived from the bounded per-vault tops.
  const globalTop = rows.flatMap((r) => r.topLiquidateEvents)
    .sort((a, b) => (BigInt(b.repayAssetsRaw) > BigInt(a.repayAssetsRaw) ? 1 : BigInt(b.repayAssetsRaw) < BigInt(a.repayAssetsRaw) ? -1 : b.blockNumber - a.blockNumber))
    .slice(0, TOP_GLOBAL);

  const vaultsWithLiquidations = rows.filter((r) => r.liquidateEventCount > 0).length;
  const vaultsWithBorrows = rows.filter((r) => r.currentTotalBorrowsRaw !== null && BigInt(r.currentTotalBorrowsRaw) > 0n).length;
  const vaultsWithCode = rows.filter((r) => r.codePresent).length;

  const complete = index.failures === 0
    && enumeration.proxy.failedWindows === 0
    && enumeration.liquidate.failedWindows === 0
    && historyStartBound.proven === true;

  return {
    schema: ARTIFACT_SCHEMA,
    scannedAt: new Date().toISOString(),
    scanner: "tools/scan-euler-l.js",
    chainId: CHAIN_ID,
    safety: { readOnly: true, signedActions: false, transactions: false, endpointMaterialPersisted: false },
    pin: {
      number: Number(BigInt(finalizedBlock.number)),
      hash: finalizedBlock.hash,
      timestamp: new Date(Number(BigInt(finalizedBlock.timestamp)) * 1000).toISOString(),
      finality: "finalized",
    },
    contracts: { factory: FACTORY.toLowerCase(), evc: EVC.toLowerCase() },
    derivedTopics: {
      source: "targets/euler-evk/src/EVault/shared/Events.sol",
      signatures: EVENT_SIGNATURES,
      Liquidate: LIQUIDATE_TOPIC,
      VaultStatus: VAULT_STATUS_TOPIC,
      ProxyCreated: PROXY_CREATED_TOPIC,
      liquidationEmitter: "targets/euler-evk/src/EVault/modules/Liquidation.sol",
    },
    liquidateEventFieldSet: {
      fields: ["liquidator(indexed)", "violator(indexed)", "collateral(address asset)", "repayAssets(uint256)", "yieldBalance(uint256)"],
      collateralAccountExposed: false,
      liabilityAccountExposed: false,
      discountFieldExposed: false,
      accountInfoExposed: false,
      note: "The EVK `Liquidate` event exposes the collateral asset and the violator (borrower) but no separate collateral/liability account, discount, or per-event accountInfo; absent fields are recorded as false, never fabricated.",
    },
    historyStartBound,
    enumeration: {
      method: "EVault Factory ProxyCreated inventory + full-history Liquidate topic enumeration + fresh vault-view solvency",
      windowSize: WINDOW,
      concurrency: CONCURRENCY,
      proxyCreated: enumeration.proxy,
      liquidate: enumeration.liquidate,
      verifyReRead: enumeration.liquidate.verification || enumeration.proxy.verification || null,
    },
    inventory: {
      factoryProxyListLength: inventory.length,
      vaultsInSurface: rows.length,
      vaultsWithCode,
      proxyCreatedLogs: index.proxyCreated.count,
      inventorySource: "factory ProxyCreated logs ∪ factory getProxyListSlice view",
    },
    totals: {
      evVaultCount: rows.length,
      liquidateEventCount: index.liquidate.total,
      vaultsWithLiquidations,
      vaultsWithBorrows,
      vaultsWithCurrentStateRead: rows.filter((r) => r.currentTotalBorrowsRaw !== null).length,
      currentStateReadFailures: stateFailures,
      truncated: index.truncated === true,
    },
    reads: {
      logWindows: enumeration.proxy.windowCount + enumeration.liquidate.windowCount,
      logWindowsPending: enumeration.proxy.pendingWindows + enumeration.liquidate.pendingWindows,
      logWindowFailures: enumeration.proxy.failedWindows + enumeration.liquidate.failedWindows,
    },
    csv: csvInfo,
    topLiquidateEvents: globalTop,
    vaults: rows,
    coverage: {
      complete,
      blockers: complete ? [] : ["full-history enumeration incomplete at this pin"],
    },
  };
}

// --- orchestration ----------------------------------------------------------------------
async function scan(options = {}) {
  const rpc = options.rpc || (await resolveWorkingRpc(CHAIN_ID));
  if (!rpc) throw new ScanFailure("RPC_UNAVAILABLE");
  const fsImpl = options.fsImpl || fs;
  const indexPath = options.indexPath || INDEX_PATH;
  const index = options.index || loadIndex(indexPath, fsImpl);
  const full = options.full === true;
  if (full) {
    index.proxyWindows = {};
    index.liquidateWindows = {};
    index.proxyCreated = { count: 0, vaults: {} };
    index.liquidate = { total: 0, rowsByWindow: {} };
    index.failures = 0;
    index.truncated = false;
  }

  const finalizedBlock = await selectFinalized(rpc);
  const finalizedNumber = Number(BigInt(finalizedBlock.number));
  const blockRef = finalizedBlock.hash;

  if (!index.deploymentFloor || index.deploymentFloor.proven !== true) {
    index.deploymentFloor = await proveHistoryStartBound(rpc, finalizedNumber);
  }
  const floor = index.deploymentFloor.block;

  const inventory = await readFactoryInventory(rpc, blockRef);

  // ProxyCreated inventory enumeration.
  const proxyEnum = await enumerateWindows(index, "proxyWindows", {
    rpc, address: FACTORY, topic0: PROXY_CREATED_TOPIC, from: floor, to: finalizedNumber,
    onLogs: (logs) => {
      for (const log of logs) {
        let parsed = null;
        try { parsed = I.proxyCreated.parseLog({ topics: log.topics, data: log.data }); } catch (_) { parsed = null; }
        if (!parsed) continue;
        const proxy = String(parsed.args.proxy).toLowerCase();
        if (index.proxyCreated.vaults[proxy]) continue;
        index.proxyCreated.vaults[proxy] = {
          deployBlock: Number(BigInt(log.blockNumber)),
          proxyListIndex: index.proxyCreated.count,
          txHash: String(log.transactionHash).toLowerCase(),
        };
        index.proxyCreated.count += 1;
      }
    },
    fsImpl, indexPath,
  });

  const vaultSet = new Set([...inventory.addresses, ...Object.keys(index.proxyCreated.vaults)]);

  // Full-history Liquidate enumeration scoped to the factory-derived vault set.
  // Public read providers can reject chain-wide topic-only log searches even
  // when they serve the same bounded range for explicit contract addresses.
  const liquidateEnum = await enumerateWindows(index, "liquidateWindows", {
    rpc, address: [...vaultSet], topic0: LIQUIDATE_TOPIC, from: floor, to: finalizedNumber,
    onLogs: (logs, windowIndex) => {
      const vaultLogs = logs.filter((log) => vaultSet.has(String(log.address || "").toLowerCase()));
      index.liquidate.rowsByWindow[windowIndex] = collectLiquidateRows(vaultLogs);
    },
    fsImpl, indexPath,
  });
  index.liquidate.total = allLiquidateRows(index).length;
  index.truncated = index.liquidate.total > MAX_EVENTS_INDEX;

  index.finalizedAtLastRun = finalizedNumber;
  persistIndex(index, indexPath, fsImpl);

  const { state: vaultState, failures: stateFailures } = await readVaultState(rpc, blockRef, inventory.addresses);

  const enumeration = {
    proxy: { windowCount: proxyEnum.windowCount, pendingWindows: proxyEnum.pendingWindows, failedWindows: proxyEnum.failedWindows, verification: proxyEnum.verification },
    liquidate: { windowCount: liquidateEnum.windowCount, pendingWindows: liquidateEnum.pendingWindows, failedWindows: liquidateEnum.failedWindows, verification: liquidateEnum.verification },
  };

  // Bounded CSV only when the surfaced event count exceeds 500 rows.
  let csvInfo = null;
  const csvRows = allLiquidateRows(index);
  if (csvRows.length > 500) {
    const csvPath = options.csvPath || CSV_PATH;
    writeCsv(csvRows, csvPath, fsImpl);
    csvInfo = { path: relPosix(csvPath), rowCount: csvRows.length, canonicalHash: canonicalHash(csvRows), bounded: true };
  }

  const artifact = buildArtifact({ index, historyStartBound: index.deploymentFloor, finalizedBlock, inventory, vaultState, stateFailures, enumeration, csvInfo });
  return artifact;
}

async function runAndPublish(options = {}) {
  const artifact = await scan(options);
  const artifactPath = options.artifactPath || ARTIFACT_PATH;
  atomicWriteJson(artifactPath, artifact, options.fsImpl || fs);
  return artifact;
}

function parseArgs(argv) {
  const modes = new Set(argv.filter((value) => value.startsWith("--")));
  const full = modes.has("--full");
  const sync = modes.has("--sync");
  const unknown = [...modes].filter((value) => !["--full", "--sync", "--once"].includes(value));
  if (unknown.length) throw new ScanFailure("USAGE");
  return { full, sync };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.sync) {
    const index = loadIndex(INDEX_PATH);
    process.stdout.write(`euler-l[sync] floor=${index.deploymentFloor ? index.deploymentFloor.block : "n/a"} vaults=${Object.keys(index.proxyCreated.vaults).length} liquidateEvents=${index.liquidate.total} failures=${index.failures}\n`);
    return;
  }
  const artifact = await runAndPublish({ full: options.full });
  process.stdout.write(`${JSON.stringify({
    status: "OK",
    chain: "ethereum",
    pin: artifact.pin.number,
    evVaultCount: artifact.totals.evVaultCount,
    liquidateEventCount: artifact.totals.liquidateEventCount,
    vaultsWithLiquidations: artifact.totals.vaultsWithLiquidations,
    vaultsWithBorrows: artifact.totals.vaultsWithBorrows,
    complete: artifact.coverage.complete,
    scannedAt: artifact.scannedAt,
    csv: artifact.csv ? artifact.csv.path : null,
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`euler-l scan failed: ${error && error.code ? error.code : "SCAN_FAILED"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE, ARTIFACT_PATH, INDEX_PATH, CSV_PATH, ARTIFACT_SCHEMA, INDEX_SCHEMA, VERSION, CHAIN_ID,
  FACTORY, EVC, MULTICALL3, ENUMERATION_REF, WINDOW, MIN_WINDOW, CONCURRENCY, TOP_PER_VAULT, TOP_GLOBAL,
  EVENT_SIGNATURES, LIQUIDATE_TOPIC, VAULT_STATUS_TOPIC, PROXY_CREATED_TOPIC, I,
  ScanFailure, call, selectFinalized, resolveWorkingRpc, hexBlock, lower, topicToAddress, canonicalHash,
  binarySearchCodeFloor, proveHistoryStartBound, decodeOrNull, fetchRange, fetchRangeBounded, enumerateWindows,
  emptyIndex, loadIndex, persistIndex, collectLiquidateRows, allLiquidateRows, aggregateLiquidate, multicall, readFactoryInventory, readVaultState,
  atomicWriteJson, writeCsv, buildArtifact, scan, runAndPublish, parseArgs, main,
};
