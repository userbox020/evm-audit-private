#!/usr/bin/env node
"use strict";

// Aave V3 on L2 (Base/Arbitrum/Polygon/Optimism) read-only cross-domain timing
// (sequencer-outage composition) observation producer.
//
// Purpose (standing-order class "cross-domain timing"): pre-position the
// Aave-V3-on-L2 side of a sequencer-outage composition. Per chain it records
//   (1) the configured PriceOracleSentinel + its uptime feed + grace period +
//       the CURRENT uptime-feed state (the out-candidate trigger condition),
//   (2) the HF<0.95 vulnerable band (sentinel-bypass band during outages),
//   (3) per-asset stale-oracle posture for the top assets by HF-weighted usage,
//       with each source's updatedAt-shaped age measured at the current block.
//
// Conventions mirrored from tools/scan-euler-l.js, tools/scan-eulerswap-l.js,
// tools/scan-twyne-l.js and tools/scan-pendle-l.js (bounded observation producer):
//   * Multicall3-batched state reads, fail-closed (a null/revert is unresolved,
//     never a default),
//   * adaptive resumable index (address resolution + reserve metadata + borrower
//     discovery are cached; live HF / sentinel state / oracle ages are always
//     re-read fresh),
//   * atomic artifact writes, canonical CSV + sha256, process-only endpoints,
//   * sequential reads, no signing, no transactions, no private-key material.
//
// Resolution rules (no new doc pages fetched):
//   * Pools are the standing Aave V3 Pool addresses embedded in
//     tools/scan-aave-v3-route-distance.js (its chain config is the prior proven
//     reference); the PoolAddressesProvider is resolved live via the Pool's own
//     ADDRESSES_PROVIDER() view, then getPriceOracleSentinel()/getPriceOracle()
//     are read through it.
//   * Sentinel sub-reads probe honest getters only. IPriceOracleSentinel exposes
//     getSequencerOracle() in the in-tree source; sequencerOracle() is probed as
//     a secondary name. If neither resolves, the uptime feed is recorded as
//     UNRESOLVED_FULLSCREEN and that sub-read is skipped (never guessed).
//   * Borrower discovery reuses ONLY the existing proven anchors: the
//     api.v3.aave.com userBorrows GraphQL anchor from
//     tools/scan-aave-v3-l2-borrowers.js, with a bounded Borrow-event getLogs
//     fallback using the exact BORROW_TOPICS from
//     tools/scan-aave-v3-route-distance.js.
//   * Oracle freshness mirrors the in-tree AggregatorInterface (answer +
//     updatedAt on latestRoundData()).
//
// Every unknown stays unknown: a sentinel that reverts or returns zero is
// recorded as sentinel NONE (a v3.7-signalling fact), an unresolved uptime feed
// is UNRESOLVED_FULLSCREEN, and per-row economics (USD debt, collateral value,
// route-positive) are explicitly out of scope (netDeltas: null).
//
// Read-only. RPC material stays process-only and is never printed or persisted.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc, loadRpcUrls, sanitizeError } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const ARTIFACT_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-l2-outage-l.json");
const CSV_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-l2-outage-l.csv");
const INDEX_PATH = path.join(WORKSPACE, "reports", "monitor", "aave-v3-l2-outage-l-index.json");

const ARTIFACT_SCHEMA = "aave-v3-l2-outage-l-observation/v1";
const INDEX_SCHEMA = "aave-v3-l2-outage-l-index/v1";
const VERSION = 1;

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const ZERO = "0x0000000000000000000000000000000000000000";

// The four in-scope L2 chains (standing-order class "cross-domain timing").
const CHAINS = Object.freeze({
  8453: Object.freeze({ chainId: 8453, label: "base" }),
  42161: Object.freeze({ chainId: 42161, label: "arbitrum" }),
  137: Object.freeze({ chainId: 137, label: "polygon" }),
  10: Object.freeze({ chainId: 10, label: "optimism" }),
});

// Standing per-chain Aave V3 Pool addresses, taken verbatim from
// tools/scan-aave-v3-route-distance.js (the prior proven reference). No
// PoolAddressesProvider literal is embedded there: it is derived live from the
// Pool's ADDRESSES_PROVIDER() view, exactly as that scanner does.
const AAVE_POOLS = Object.freeze({
  8453: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  42161: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  137: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  10: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
});

// Exact Borrow topics from tools/scan-aave-v3-route-distance.js (existing proven
// anchor; topic[2] is onBehalfOf).
const BORROW_TOPICS = Object.freeze([
  "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0",
  "0xc6a898309e823ee50bac64e45ca8adba6690e99e7841c45d754e2a38e9019d9b",
]);

// Existing proven GraphQL anchor from tools/scan-aave-v3-l2-borrowers.js.
const AAVE_API = "https://api.v3.aave.com/graphql";

// Bounds / conventions.
const WINDOW = 10_000;              // bounded Borrow-event lookback
const MAX_ACCOUNTS_PER_CHAIN = 50;  // discovery cap per chain
const MAX_ASSETS_PER_CHAIN = 10;    // oracle-freshness asset cap per chain
const HF_VULNERABLE = 0.95;         // vulnerable-band upper bound
const HF_BAND_LOW = 0.80;           // labelled sub-band low edge
const STALE_BLOCKS_THRESHOLD = 3600; // boolean flag convention: age>3600 blocks
const AVG_BLOCK_WINDOW = 3600;      // window used to measure avg block time
const TIMEOUT_MS = 30_000;
const MC_BATCH = 200;
const MC_CONCURRENCY = 1;           // sequential
const LOG_CONCURRENCY = 1;          // sequential
const REQUEST_BUDGET = 500;         // bounded requests per run
const MAX_WALL_MS = 16 * 60 * 1000;
const API_TIMEOUT_MS = 15_000;

const I = Object.freeze({
  pool: new ethers.Interface([
    "function ADDRESSES_PROVIDER() view returns (address)",
    "function getReservesList() view returns (address[])",
    "function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)",
    "function getUserConfiguration(address user) view returns (uint256)",
  ]),
  provider: new ethers.Interface([
    "function getPriceOracle() view returns (address)",
    "function getPriceOracleSentinel() view returns (address)",
  ]),
  sentinel: new ethers.Interface([
    "function ADDRESSES_PROVIDER() view returns (address)",
    "function isBorrowAllowed() view returns (bool)",
    "function isLiquidationAllowed() view returns (bool)",
    "function getSequencerOracle() view returns (address)",
    "function getGracePeriod() view returns (uint256)",
  ]),
  // Secondary honest probe name (never guessed beyond these two names).
  sentinelAlt: new ethers.Interface([
    "function sequencerOracle() view returns (address)",
  ]),
  oracle: new ethers.Interface([
    "function getSourceOfAsset(address asset) view returns (address)",
    "function getAssetPrice(address asset) view returns (uint256)",
  ]),
  aggregator: new ethers.Interface([
    "function decimals() view returns (uint8)",
    "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
    "function latestAnswer() view returns (int256)",
  ]),
  erc20: new ethers.Interface([
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
  ]),
  multicall: new ethers.Interface([
    "function aggregate3((address target,bool failure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])",
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
function isZeroAddr(value) { return typeof value === "string" && /^0x0{40}$/i.test(value); }
function canonicalHash(value) { return `0x${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function toIso(seconds) {
  try { return new Date(Number(seconds) * 1000).toISOString(); } catch (_) { return null; }
}
function round(value, decimals = 6) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const f = 10 ** decimals;
  return Math.round(Number(value) * f) / f;
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
function decodeAddrItem(iface, fn, item) {
  if (!item || item.success !== true) return null;
  const d = decodeOrNull(iface, fn, item.returnData);
  return d ? lower(d[0]) : null;
}
function decodeUintItem(iface, fn, item) {
  if (!item || item.success !== true) return null;
  const d = decodeOrNull(iface, fn, item.returnData);
  return d ? BigInt(d[0]).toString() : null;
}
function decodeBoolItem(iface, fn, item) {
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

// --- multicall (sequential, fail-closed) -------------------------------------------------
async function multicall(rpc, blockTag, entries) {
  const results = new Array(entries.length);
  const batches = [];
  for (let i = 0; i < entries.length; i += MC_BATCH) batches.push(i);
  let failures = 0;
  let requests = 0;
  for (const start of batches) {
    const batch = entries.slice(start, start + MC_BATCH);
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

// --- index (resumable) -------------------------------------------------------------------
function emptyChainIndex(chainId) {
  return {
    chainId,
    pool: AAVE_POOLS[chainId] ? lower(AAVE_POOLS[chainId]) : null,
    provider: null,
    oracle: null,
    sentinel: null,
    sentinelState: null,
    uptimeFeed: null,
    uptimeFeedGetter: null,
    uptimeFeedState: null,
    gracePeriodRaw: null,
    reserves: [],
    reserveCount: 0,
    borrowerCandidates: [],
    discoverySource: null,
    finalizedAtLastRun: null,
    failures: 0,
  };
}

function emptyIndex() {
  return { schema: INDEX_SCHEMA, version: VERSION, runCount: 0, lastRunAt: null, chains: {} };
}

function loadIndex(file = INDEX_PATH, fsImpl = fs) {
  if (!fsImpl.existsSync(file)) return emptyIndex();
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.chains !== "object") return emptyIndex();
    const index = { ...emptyIndex(), ...parsed, chains: {} };
    for (const [key, state] of Object.entries(parsed.chains || {})) {
      index.chains[key] = {
        ...emptyChainIndex(Number(key)),
        ...state,
        reserves: Array.isArray(state.reserves) ? state.reserves : [],
        borrowerCandidates: Array.isArray(state.borrowerCandidates) ? state.borrowerCandidates : [],
      };
    }
    return index;
  } catch (_) { return emptyIndex(); }
}

function persistIndex(index, file = INDEX_PATH, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, `${JSON.stringify(index)}\n`);
}

// --- discovery (existing proven anchors only) --------------------------------------------
async function discoverBorrowersApi(chainId, cap) {
  const candidates = [];
  let error = null;
  try {
    API_REQUEST_COUNT += 1;
    const res = await fetch(AAVE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.aave.com", Referer: "https://app.aave.com/" },
      body: JSON.stringify({
        query: `query { userBorrows(request: { chainIds: [${chainId}], first: ${cap}, orderBy: totalBorrowsUSD, orderDirection: desc }) { user { id } } }`,
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const j = await res.json();
    for (const b of (j && j.data && j.data.userBorrows) || []) {
      const a = lower(b && b.user && b.user.id);
      if (a) candidates.push(a);
    }
  } catch (_) { error = "api-unreachable"; }
  const unique = [...new Set(candidates)].slice(0, cap);
  return { candidates: unique, error, source: "api.v3.aave.com:userBorrows(totalBorrowsUSD desc)" };
}

async function discoverBorrowersLogs(rpc, pool, cap) {
  try {
    const blockHex = await call(rpc, "eth_blockNumber", []);
    const latest = Number(BigInt(blockHex));
    const from = Math.max(0, latest - WINDOW);
    const logs = await call(rpc, "eth_getLogs", [{
      fromBlock: hexBlock(from), toBlock: hexBlock(latest), address: pool, topics: [BORROW_TOPICS],
    }], 20_000);
    if (!Array.isArray(logs)) return { candidates: [], error: "log-query-failed", source: "pool:Borrow-getLogs", observedRange: { from, to: latest } };
    const seen = new Set();
    for (const log of logs.slice().reverse()) {
      const topic = log && Array.isArray(log.topics) ? log.topics[2] : null;
      if (!topic || String(topic).length !== 66) continue;
      const a = lower(`0x${String(topic).slice(26)}`);
      if (a) seen.add(a);
    }
    return { candidates: [...seen].slice(0, cap), error: null, source: "pool:Borrow-getLogs", observedRange: { from, to: latest } };
  } catch (_) {
    return { candidates: [], error: "log-query-failed", source: "pool:Borrow-getLogs" };
  }
}

// --- reserve metadata ---------------------------------------------------------------------
async function readReserveMetadata(rpc, blockTag, reserveAddresses) {
  const entries = [];
  for (const asset of reserveAddresses) {
    entries.push({ to: asset, data: I.erc20.encodeFunctionData("symbol", []) });
    entries.push({ to: asset, data: I.erc20.encodeFunctionData("decimals", []) });
  }
  const { results, failures, requests } = entries.length ? await multicall(rpc, blockTag, entries) : { results: [], failures: 0, requests: 0 };
  const reserves = reserveAddresses.map((asset, index) => {
    const base = index * 2;
    const symDec = results[base];
    const decItem = results[base + 1];
    let symbol = null;
    if (symDec && symDec.success === true) {
      const d = decodeOrNull(I.erc20, "symbol", symDec.returnData);
      if (d && typeof d[0] === "string") symbol = d[0];
    }
    let decimals = null;
    if (decItem && decItem.success === true) {
      const d = decodeOrNull(I.erc20, "decimals", decItem.returnData);
      if (d) decimals = Number(BigInt(d[0]));
    }
    return { asset: lower(asset), symbol, decimals };
  });
  return { reserves, failures, requests };
}

// --- sentinel resolution (fail-closed; v3.7 ABSENT shapes recorded honestly) -------------
async function resolveSentinel({ rpc, blockTag, provider }) {
  const oracleRes = await readCall(rpc, provider, I.provider, "getPriceOracle", [], blockTag);
  const oracle = oracleRes ? lower(oracleRes[0]) : null;

  const sentinelRes = await readCall(rpc, provider, I.provider, "getPriceOracleSentinel", [], blockTag);
  const sentinelCallOk = sentinelRes !== null;
  const sentinel = sentinelRes ? lower(sentinelRes[0]) : null;
  const sentinelAbsent = !sentinel || isZeroAddr(sentinel);

  if (sentinelAbsent) {
    return {
      oracle,
      sentinel: null,
      sentinelState: "NONE",
      sentinelCallOk,
      sentinelReason: sentinelCallOk ? "provider-returned-zero" : "provider-call-reverted-or-unavailable",
      hasCode: false,
      borrowAllowed: null,
      liquidationAllowed: null,
      gracePeriodRaw: null,
      uptimeFeed: null,
      uptimeFeedGetter: null,
      uptimeFeedState: "NO_SENTINEL",
      uptimeFeedRound: null,
    };
  }

  const code = await readCode(rpc, sentinel, blockTag);
  const hasCode = typeof code === "string" && code.length > 2;

  const borrowAllowedRes = hasCode ? await readCall(rpc, sentinel, I.sentinel, "isBorrowAllowed", [], blockTag) : null;
  const liquidationAllowedRes = hasCode ? await readCall(rpc, sentinel, I.sentinel, "isLiquidationAllowed", [], blockTag) : null;
  const graceRes = hasCode ? await readCall(rpc, sentinel, I.sentinel, "getGracePeriod", [], blockTag) : null;

  // Uptime-feed getter probe: getSequencerOracle() (in-tree source) then
  // sequencerOracle() (secondary honest name). Never guess beyond these.
  let uptimeFeed = null;
  let uptimeFeedGetter = null;
  if (hasCode) {
    const seq1 = await readCall(rpc, sentinel, I.sentinel, "getSequencerOracle", [], blockTag);
    const cand1 = seq1 ? lower(seq1[0]) : null;
    if (cand1 && !isZeroAddr(cand1)) { uptimeFeed = cand1; uptimeFeedGetter = "getSequencerOracle"; }
    if (!uptimeFeed) {
      const seq2 = await readCall(rpc, sentinel, I.sentinelAlt, "sequencerOracle", [], blockTag);
      const cand2 = seq2 ? lower(seq2[0]) : null;
      if (cand2 && !isZeroAddr(cand2)) { uptimeFeed = cand2; uptimeFeedGetter = "sequencerOracle"; }
    }
  }

  return {
    oracle,
    sentinel,
    sentinelState: "RESOLVED",
    sentinelCallOk,
    sentinelReason: null,
    hasCode,
    borrowAllowed: borrowAllowedRes ? borrowAllowedRes[0] === true : null,
    liquidationAllowed: liquidationAllowedRes ? liquidationAllowedRes[0] === true : null,
    gracePeriodRaw: graceRes ? BigInt(graceRes[0]).toString() : null,
    uptimeFeed,
    uptimeFeedGetter,
    uptimeFeedState: uptimeFeed ? "RESOLVED" : "UNRESOLVED_FULLSCREEN",
    uptimeFeedRound: null,
  };
}

// Read the current uptime-feed state (the out-candidate trigger condition).
// SequencerUptimeFeed answer: 0 = sequencer up, 1 = down. Fail-closed: a revert
// or an undecodable round is UNRESOLVED, never "up".
async function readUptimeFeed({ rpc, blockTag, uptimeFeed, blockTimestamp }) {
  if (!uptimeFeed) return { state: "UNRESOLVED_FULLSCREEN", round: null };
  const code = await readCode(rpc, uptimeFeed, blockTag);
  if (!(typeof code === "string" && code.length > 2)) return { state: "UPTIME_FEED_NO_CODE", round: null };
  const res = await readCall(rpc, uptimeFeed, I.aggregator, "latestRoundData", [], blockTag);
  if (!res) return { state: "UPTIME_FEED_READ_FAILED", round: null };
  const answer = BigInt(res[1]);
  const startedAt = Number(BigInt(res[2]));
  const updatedAt = Number(BigInt(res[3]));
  const sequencerStatus = answer === 0n ? "UP" : answer === 1n ? "DOWN" : "UNKNOWN";
  return {
    state: "RESOLVED",
    round: {
      roundId: BigInt(res[0]).toString(),
      answerRaw: answer.toString(),
      sequencerStatus,
      startedAt,
      startedAtIso: toIso(startedAt),
      updatedAt,
      updatedAtIso: toIso(updatedAt),
      answeredInRound: BigInt(res[4]).toString(),
      ageSeconds: Number.isFinite(blockTimestamp) && updatedAt > 0 ? blockTimestamp - updatedAt : null,
    },
  };
}

// --- avg block time (honest on-chain measurement) -----------------------------------------
async function measureAvgBlockSeconds(rpc, finalizedNumber) {
  if (finalizedNumber <= AVG_BLOCK_WINDOW) return null;
  const fromBlock = finalizedNumber - AVG_BLOCK_WINDOW;
  const [a, b] = await Promise.all([
    call(rpc, "eth_getBlockByNumber", [hexBlock(finalizedNumber), false]),
    call(rpc, "eth_getBlockByNumber", [hexBlock(fromBlock), false]),
  ]);
  if (!a || !b || !a.timestamp || !b.timestamp) return null;
  const tsA = Number(BigInt(a.timestamp));
  const tsB = Number(BigInt(b.timestamp));
  const delta = tsA - tsB;
  if (!Number.isFinite(delta) || delta <= 0) return null;
  const avg = delta / AVG_BLOCK_WINDOW;
  if (!Number.isFinite(avg) || avg <= 0.001) return null;
  return { avgBlockSeconds: round(avg, 6), windowBlocks: AVG_BLOCK_WINDOW, fromBlock, toBlock: finalizedNumber };
}

// --- oracle freshness ---------------------------------------------------------------------
function rankAssets({ bandRows, allRows }) {
  const weight = new Map();
  const count = new Map();
  const bump = (asset, w) => {
    if (!asset) return;
    weight.set(asset, (weight.get(asset) || 0) + w);
    count.set(asset, (count.get(asset) || 0) + 1);
  };
  for (const r of bandRows) {
    const w = Math.max(0, 1 - r.healthFactor);
    for (const a of [...(r.debtAssets || []), ...(r.collAssets || [])]) bump(a, w);
  }
  const bandRanked = [...weight.keys()].sort((a, b) => (weight.get(b) - weight.get(a)) || (count.get(b) - count.get(a)) || a.localeCompare(b));
  const selected = [...bandRanked];
  if (selected.length < MAX_ASSETS_PER_CHAIN) {
    const extra = new Map();
    for (const r of allRows) {
      for (const a of [...(r.debtAssets || []), ...(r.collAssets || [])]) {
        if (a && !selected.includes(a)) extra.set(a, (extra.get(a) || 0) + 1);
      }
    }
    const extraRanked = [...extra.keys()].sort((a, b) => (extra.get(b) - extra.get(a)) || a.localeCompare(b));
    for (const a of extraRanked) { if (selected.length >= MAX_ASSETS_PER_CHAIN) break; selected.push(a); }
  }
  const selection = bandRanked.length >= MAX_ASSETS_PER_CHAIN
    ? "vulnerable-band-hf-weighted"
    : bandRanked.length > 0
      ? "vulnerable-band-hf-weighted+all-readers-topup"
      : allRows.length > 0 ? "all-readers-topup-no-vulnerable-rows" : "no-assets-available";
  return {
    assets: selected.slice(0, MAX_ASSETS_PER_CHAIN),
    selection,
    bandAssetCount: bandRanked.length,
    weights: selected.map((a) => ({ asset: a, hfWeight: round(weight.get(a) || 0, 8), usageCount: count.get(a) || 0 })),
  };
}

async function readOracleFreshness({ rpc, blockTag, oracle, assets, symbolOf, blockTimestamp, avgBlockSeconds }) {
  if (!oracle || assets.length === 0) return { rows: [], failures: 0, requests: 0 };

  // Pass A: per-asset source + Aave price.
  const entriesA = [];
  for (const asset of assets) {
    entriesA.push({ to: oracle, data: I.oracle.encodeFunctionData("getSourceOfAsset", [asset]) });
    entriesA.push({ to: oracle, data: I.oracle.encodeFunctionData("getAssetPrice", [asset]) });
  }
  const a = await multicall(rpc, blockTag, entriesA);
  const assetMeta = assets.map((asset, index) => {
    const base = index * 2;
    return {
      asset,
      symbol: symbolOf.get(asset) || null,
      source: decodeAddrItem(I.oracle, "getSourceOfAsset", a.results[base]),
      aavePriceRaw: decodeUintItem(I.oracle, "getAssetPrice", a.results[base + 1]),
    };
  });

  // Pass B: per-distinct-source aggregator round + decimals.
  const distinctSources = [...new Set(assetMeta.map((m) => m.source).filter((s) => s && !isZeroAddr(s)))];
  const entriesB = [];
  for (const source of distinctSources) {
    entriesB.push({ to: source, data: I.aggregator.encodeFunctionData("latestRoundData", []) });
    entriesB.push({ to: source, data: I.aggregator.encodeFunctionData("decimals", []) });
  }
  const b = distinctSources.length ? await multicall(rpc, blockTag, entriesB) : { results: [], failures: 0, requests: 0 };
  const sourceState = new Map();
  distinctSources.forEach((source, index) => {
    const base = index * 2;
    const roundItem = b.results[base];
    const decItem = b.results[base + 1];
    let round = null;
    if (roundItem && roundItem.success === true) {
      const d = decodeOrNull(I.aggregator, "latestRoundData", roundItem.returnData);
      if (d) {
        round = {
          roundId: BigInt(d[0]).toString(),
          answerRaw: BigInt(d[1]).toString(),
          startedAt: Number(BigInt(d[2])),
          updatedAt: Number(BigInt(d[3])),
          answeredInRound: BigInt(d[4]).toString(),
        };
      }
    }
    let decimals = null;
    if (decItem && decItem.success === true) {
      const d = decodeOrNull(I.aggregator, "decimals", decItem.returnData);
      if (d) decimals = Number(BigInt(d[0]));
    }
    sourceState.set(source, { round, decimals });
  });

  // Pass C: latestAnswer() fallback for sources whose latestRoundData reverted.
  // Aave fixed-peg / price-cap stable adapters expose latestAnswer() but no
  // timestamp (updatedAt): the answer is recorded, the age stays honestly null.
  const fallbackSources = distinctSources.filter((s) => { const st = sourceState.get(s); return !st || !st.round; });
  let cFailures = 0;
  let cRequests = 0;
  if (fallbackSources.length) {
    const entriesC = fallbackSources.map((source) => ({ to: source, data: I.aggregator.encodeFunctionData("latestAnswer", []) }));
    const c = await multicall(rpc, blockTag, entriesC);
    cFailures = c.failures;
    cRequests = c.requests;
    fallbackSources.forEach((source, index) => {
      const item = c.results[index];
      let answerOnlyRaw = null;
      if (item && item.success === true) {
        const d = decodeOrNull(I.aggregator, "latestAnswer", item.returnData);
        if (d) answerOnlyRaw = BigInt(d[0]).toString();
      }
      const st = sourceState.get(source) || { round: null, decimals: null };
      st.answerOnlyRaw = answerOnlyRaw;
      sourceState.set(source, st);
    });
  }

  const rows = assetMeta.map((meta) => {
    const st = meta.source ? sourceState.get(meta.source) : null;
    const round = st ? st.round : null;
    const answerOnlyRaw = st ? (st.answerOnlyRaw ?? null) : null;
    const updatedAt = round ? round.updatedAt : null;
    const ageSeconds = (round && Number.isFinite(blockTimestamp) && updatedAt > 0) ? blockTimestamp - updatedAt : null;
    const ageBlocks = (ageSeconds !== null && Number.isFinite(avgBlockSeconds) && avgBlockSeconds > 0)
      ? Math.round(ageSeconds / avgBlockSeconds) : null;
    let state = "RESOLVED";
    if (!meta.source || isZeroAddr(meta.source)) state = "NO_SOURCE";
    else if (!round && answerOnlyRaw === null) state = "SOURCE_ROUND_UNRESOLVED";
    else if (!round) state = "ANSWER_ONLY_NO_TIMESTAMP";
    return {
      asset: meta.asset,
      symbol: meta.symbol,
      source: meta.source,
      answerSource: round ? "latestRoundData" : (answerOnlyRaw !== null ? "latestAnswer" : null),
      aggregatorDecimals: st ? st.decimals : null,
      aggregatorAnswerRaw: round ? round.answerRaw : answerOnlyRaw,
      startedAt: round ? round.startedAt : null,
      updatedAt,
      updatedAtIso: updatedAt ? toIso(updatedAt) : null,
      answeredInRound: round ? round.answeredInRound : null,
      aavePriceRaw: meta.aavePriceRaw,
      ageSeconds,
      ageBlocks,
      staleWarningAgeGt3600Blocks: ageBlocks === null ? null : ageBlocks > STALE_BLOCKS_THRESHOLD,
      state,
    };
  });

  return { rows, failures: a.failures + b.failures + cFailures, requests: a.requests + b.requests + cRequests };
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
  "rowType", "chainId", "chain", "account", "healthFactor", "debtAsset", "collAsset", "hfBand", "bandRule",
  "asset", "symbol", "source", "answerSource", "aggregatorDecimals", "aggregatorAnswerRaw", "aavePriceRaw", "startedAt",
  "updatedAt", "ageSeconds", "ageBlocks", "staleWarningAgeGt3600Blocks", "state", "netDeltas",
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

function hfBandLabel(hf) {
  if (hf < HF_BAND_LOW) return "below-0.80";
  if (hf < HF_VULNERABLE) return "0.80..0.95";
  return "0.95..1.00";
}

// --- per-chain scan -----------------------------------------------------------------------
async function scanChain({ chainId, rpc, index, fsImpl, indexPath, runNumber }) {
  const chain = CHAINS[chainId];
  const chainStartRequests = REQUEST_COUNT;
  if (!index.chains[chainId]) index.chains[chainId] = emptyChainIndex(chainId);
  const chainIndex = index.chains[chainId];
  const pool = lower(AAVE_POOLS[chainId]);

  const reused = { addressResolution: false, reserves: false, discovery: false };

  const finalizedBlock = await selectFinalized(rpc);
  const finalizedNumber = Number(BigInt(finalizedBlock.number));
  const blockTag = finalizedBlock.hash;
  const blockTimestamp = Number(BigInt(finalizedBlock.timestamp));

  // Provider resolution (live, cheap) then sentinel + oracle.
  const providerRes = await readCall(rpc, pool, I.pool, "ADDRESSES_PROVIDER", [], blockTag);
  const provider = providerRes ? lower(providerRes[0]) : null;
  if (!provider || isZeroAddr(provider)) {
    return {
      chainId, label: chain.label,
      pin: { number: finalizedNumber, hash: finalizedBlock.hash, timestamp: toIso(finalizedBlock.timestamp), finality: "finalized" },
      pool,
      provider: null,
      sentinel: { sentinelState: "UNRESOLVED", sentinelReason: "provider-unresolved", uptimeFeedState: "NO_SENTINEL" },
      oracle: null,
      vulnerableBand: { rows: [], count: 0, accountsRead: 0 },
      oracleFreshness: { assetsSelected: [], selection: "no-assets-available", rows: [] },
      reads: { chainRequests: REQUEST_COUNT - chainStartRequests },
      coverage: { complete: false, blockers: ["provider-unresolved"] },
    };
  }

  const sentinel = await resolveSentinel({ rpc, blockTag, provider });
  const oracle = sentinel.oracle;
  // Only probe the uptime feed when a sentinel actually exists; a chain with no
  // sentinel is recorded as NO_SENTINEL, a sentinel without a resolvable
  // sequencer-oracle getter is UNRESOLVED_FULLSCREEN (distinct honest states).
  const uptimeRead = sentinel.sentinelState === "RESOLVED"
    ? await readUptimeFeed({ rpc, blockTag, uptimeFeed: sentinel.uptimeFeed, blockTimestamp })
    : { state: "NO_SENTINEL", round: null };
  sentinel.uptimeFeedRound = uptimeRead.round;
  sentinel.uptimeFeedState = uptimeRead.state;

  chainIndex.provider = provider;
  chainIndex.oracle = oracle;
  chainIndex.sentinel = sentinel.sentinel;
  chainIndex.sentinelState = sentinel.sentinelState;
  chainIndex.uptimeFeed = sentinel.uptimeFeed;
  chainIndex.uptimeFeedGetter = sentinel.uptimeFeedGetter;
  chainIndex.uptimeFeedState = sentinel.uptimeFeedState;
  chainIndex.gracePeriodRaw = sentinel.gracePeriodRaw;

  // Reserves (cached: metadata is stable).
  let reserves;
  if (Array.isArray(chainIndex.reserves) && chainIndex.reserves.length > 0 && chainIndex.reserveCount > 0) {
    reserves = chainIndex.reserves;
    reused.reserves = true;
  } else {
    const listRes = await readCall(rpc, pool, I.pool, "getReservesList", [], blockTag);
    const reserveAddresses = (listRes && Array.isArray(listRes[0])) ? listRes[0].map((a) => lower(a)).filter(Boolean) : [];
    const meta = await readReserveMetadata(rpc, blockTag, reserveAddresses);
    reserves = meta.reserves;
    chainIndex.reserves = reserves;
    chainIndex.reserveCount = reserves.length;
  }
  const symbolOf = new Map(reserves.filter((r) => r.asset).map((r) => [r.asset, r.symbol]));

  // Borrower discovery (cached: resumable).
  let candidates;
  let discoverySource;
  let discoveryError = null;
  if (Array.isArray(chainIndex.borrowerCandidates) && chainIndex.borrowerCandidates.length > 0) {
    candidates = chainIndex.borrowerCandidates;
    discoverySource = chainIndex.discoverySource || "index-cache";
    reused.discovery = true;
  } else {
    const api = await discoverBorrowersApi(chainId, MAX_ACCOUNTS_PER_CHAIN);
    if (api.candidates.length > 0) {
      candidates = api.candidates;
      discoverySource = api.source;
    } else {
      const logs = await discoverBorrowersLogs(rpc, pool, MAX_ACCOUNTS_PER_CHAIN);
      candidates = logs.candidates;
      discoverySource = logs.source;
      discoveryError = api.error || logs.error || null;
    }
    chainIndex.borrowerCandidates = candidates;
    chainIndex.discoverySource = discoverySource;
  }
  candidates = candidates.slice(0, MAX_ACCOUNTS_PER_CHAIN);

  // Live HF + user configuration (fresh every run).
  const entries = [];
  for (const account of candidates) {
    entries.push({ to: pool, data: I.pool.encodeFunctionData("getUserAccountData", [account]) });
    entries.push({ to: pool, data: I.pool.encodeFunctionData("getUserConfiguration", [account]) });
  }
  const mc = entries.length ? await multicall(rpc, blockTag, entries) : { results: [], failures: 0, requests: 0 };

  const allRows = [];
  const bandRows = [];
  let accountsRead = 0;
  let accountReadFailed = 0;
  candidates.forEach((account, index2) => {
    const base = index2 * 2;
    const acctItem = mc.results[base];
    const cfgItem = mc.results[base + 1];
    const acct = acctItem && acctItem.success === true ? decodeOrNull(I.pool, "getUserAccountData", acctItem.returnData) : null;
    if (!acct) { accountReadFailed += 1; return; }
    accountsRead += 1;
    const hfRaw = BigInt(acct[5]);
    const healthFactor = hfRaw > 10n ** 36n ? 999 : Number(hfRaw) / 1e18;

    let cfg = null;
    if (cfgItem && cfgItem.success === true) {
      const d = decodeOrNull(I.pool, "getUserConfiguration", cfgItem.returnData);
      if (d) cfg = BigInt(d[0]);
    }
    const debtAssets = [];
    const collAssets = [];
    if (cfg !== null) {
      for (let id = 0; id < reserves.length; id += 1) {
        const asset = reserves[id] ? reserves[id].asset : null;
        if (!asset) continue;
        const b = BigInt(id * 2);
        if (((cfg >> b) & 1n) === 1n) debtAssets.push(asset);
        if (((cfg >> (b + 1n)) & 1n) === 1n) collAssets.push(asset);
      }
    }

    const row = {
      chainId,
      chain: chain.label,
      account,
      healthFactor: round(healthFactor, 8),
      healthFactorRaw: hfRaw.toString(),
      debtAssets,
      collAssets,
      debtAsset: debtAssets[0] || null,
      collAsset: collAssets[0] || null,
      hfBand: hfBandLabel(healthFactor),
      bandRule: "sentinel-bypass-band",
      netDeltas: null,
      configResolved: cfg !== null,
    };
    allRows.push(row);
    if (healthFactor < HF_VULNERABLE) bandRows.push(row);
  });

  // Oracle freshness for the top assets by HF-weighted usage.
  const ranking = rankAssets({ bandRows, allRows });
  const avgBlock = await measureAvgBlockSeconds(rpc, finalizedNumber);
  const freshness = await readOracleFreshness({
    rpc, blockTag, oracle, assets: ranking.assets, symbolOf, blockTimestamp,
    avgBlockSeconds: avgBlock ? avgBlock.avgBlockSeconds : null,
  });

  chainIndex.finalizedAtLastRun = finalizedNumber;
  persistIndex(index, indexPath, fsImpl);

  const chainRequests = REQUEST_COUNT - chainStartRequests;
  const blockers = [];
  if (sentinel.sentinelState === "NONE") blockers.push("sentinel-none");
  if (sentinel.uptimeFeedState !== "RESOLVED") blockers.push(`uptime-feed-${sentinel.uptimeFeedState}`);
  if (accountsRead === 0) blockers.push("no-accounts-read");
  if (freshness.failures > 0) blockers.push("oracle-read-partial-failure");
  const complete = sentinel.sentinelState === "RESOLVED"
    && sentinel.uptimeFeedState === "RESOLVED"
    && freshness.failures === 0
    && accountsRead > 0;

  return {
    chainId,
    label: chain.label,
    pin: { number: finalizedNumber, hash: finalizedBlock.hash, timestamp: toIso(finalizedBlock.timestamp), finality: "finalized" },
    pool,
    provider,
    sentinel: {
      sentinelState: sentinel.sentinelState,
      sentinelReason: sentinel.sentinelReason,
      sentinelCallOk: sentinel.sentinelCallOk,
      address: sentinel.sentinel,
      hasCode: sentinel.hasCode,
      isBorrowAllowed: sentinel.borrowAllowed,
      isLiquidationAllowed: sentinel.liquidationAllowed,
      gracePeriodRaw: sentinel.gracePeriodRaw,
      gracePeriodSeconds: sentinel.gracePeriodRaw !== null ? Number(sentinel.gracePeriodRaw) : null,
      uptimeFeed: sentinel.uptimeFeed,
      uptimeFeedGetter: sentinel.uptimeFeedGetter,
      uptimeFeedState: sentinel.uptimeFeedState,
      uptimeFeedRound: sentinel.uptimeFeedRound,
    },
    oracle,
    reserves: { count: reserves.length, metadataReused: reused.reserves },
    discovery: {
      source: discoverySource,
      reusedFromIndex: reused.discovery,
      candidateCount: candidates.length,
      error: discoveryError,
    },
    vulnerableBand: {
      threshold: HF_VULNERABLE,
      accountsRead,
      accountReadFailed,
      count: bandRows.length,
      rows: bandRows,
    },
    oracleFreshness: {
      selection: ranking.selection,
      bandAssetCount: ranking.bandAssetCount,
      assetsSelected: ranking.assets,
      weights: ranking.weights,
      avgBlock: avgBlock,
      rows: freshness.rows,
    },
    reads: {
      chainRequests,
      discoveryMulticallRequests: mc.requests,
      discoveryMulticallFailures: mc.failures,
      oracleMulticallRequests: freshness.requests,
      oracleMulticallFailures: freshness.failures,
    },
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
      state.reserves = [];
      state.reserveCount = 0;
      state.borrowerCandidates = [];
      state.discoverySource = null;
    }
  }
  const previousRunCount = Number(index.runCount || 0);
  const runNumber = previousRunCount + 1;
  const reusedIndex = previousRunCount > 0;

  const chainIds = options.chainIds || Object.keys(CHAINS).map(Number);
  const chains = [];
  for (const chainId of chainIds) {
    const rpc = options.rpcFor ? options.rpcFor(chainId) : await resolveWorkingRpc(chainId);
    if (!rpc) {
      chains.push({
        chainId,
        label: CHAINS[chainId] ? CHAINS[chainId].label : `c${chainId}`,
        pool: AAVE_POOLS[chainId] ? lower(AAVE_POOLS[chainId]) : null,
        error: "no-rpc",
        sentinel: { sentinelState: "UNRESOLVED", sentinelReason: "rpc-unavailable", uptimeFeedState: "NO_SENTINEL" },
        vulnerableBand: { rows: [], count: 0, accountsRead: 0 },
        oracleFreshness: { assetsSelected: [], selection: "no-assets-available", rows: [] },
        coverage: { complete: false, blockers: ["rpc-unavailable"] },
      });
      continue;
    }
    try {
      chains.push(await scanChain({ chainId, rpc, index, fsImpl, indexPath, runNumber }));
    } catch (e) {
      chains.push({
        chainId,
        label: CHAINS[chainId] ? CHAINS[chainId].label : `c${chainId}`,
        pool: AAVE_POOLS[chainId] ? lower(AAVE_POOLS[chainId]) : null,
        error: sanitizeError(e, "scan-error"),
        sentinel: { sentinelState: "UNRESOLVED", sentinelReason: "scan-error", uptimeFeedState: "NO_SENTINEL" },
        vulnerableBand: { rows: [], count: 0, accountsRead: 0 },
        oracleFreshness: { assetsSelected: [], selection: "no-assets-available", rows: [] },
        coverage: { complete: false, blockers: ["scan-error"] },
      });
    }
  }

  index.runCount = runNumber;
  index.lastRunAt = new Date().toISOString();
  persistIndex(index, indexPath, fsImpl);

  // Canonical CSV: vulnerable-band rows + oracle-source rows, deterministic sort.
  const csvRows = [];
  for (const c of chains) {
    for (const r of (c.vulnerableBand && c.vulnerableBand.rows) || []) {
      csvRows.push({
        rowType: "vulnerable-band", chainId: c.chainId, chain: c.label, account: r.account,
        healthFactor: r.healthFactor, debtAsset: r.debtAsset, collAsset: r.collAsset,
        hfBand: r.hfBand, bandRule: r.bandRule, netDeltas: null,
      });
    }
    for (const o of (c.oracleFreshness && c.oracleFreshness.rows) || []) {
      csvRows.push({
        rowType: "oracle-source", chainId: c.chainId, chain: c.label, asset: o.asset, symbol: o.symbol,
        source: o.source, answerSource: o.answerSource, aggregatorDecimals: o.aggregatorDecimals, aggregatorAnswerRaw: o.aggregatorAnswerRaw,
        aavePriceRaw: o.aavePriceRaw, startedAt: o.startedAt, updatedAt: o.updatedAt, ageSeconds: o.ageSeconds,
        ageBlocks: o.ageBlocks, staleWarningAgeGt3600Blocks: o.staleWarningAgeGt3600Blocks, state: o.state,
      });
    }
  }
  csvRows.sort((a, b) => (a.rowType.localeCompare(b.rowType))
    || (a.chainId - b.chainId)
    || String(a.account || a.asset || "").localeCompare(String(b.account || b.asset || "")));
  const csvPath = options.csvPath || CSV_PATH;
  const csvWrite = writeCsv(csvRows, csvPath, fsImpl);

  const wallMs = Date.now() - startMs;
  const totalBandRows = chains.reduce((s, c) => s + ((c.vulnerableBand && c.vulnerableBand.count) || 0), 0);
  const totalAccountsRead = chains.reduce((s, c) => s + ((c.vulnerableBand && c.vulnerableBand.accountsRead) || 0), 0);
  const totalOracleRows = chains.reduce((s, c) => s + ((c.oracleFreshness && c.oracleFreshness.rows.length) || 0), 0);
  const staleOracleRows = chains.reduce((s, c) => s + ((c.oracleFreshness && c.oracleFreshness.rows.filter((r) => r.staleWarningAgeGt3600Blocks === true).length) || 0), 0);
  const sentinelsResolved = chains.filter((c) => c.sentinel && c.sentinel.sentinelState === "RESOLVED").length;
  const sentinelsNone = chains.filter((c) => c.sentinel && c.sentinel.sentinelState === "NONE").length;
  const uptimeFeedsResolved = chains.filter((c) => c.sentinel && c.sentinel.uptimeFeedState === "RESOLVED").length;
  const uptimeFeedsUnresolved = chains.filter((c) => c.sentinel && c.sentinel.uptimeFeedState === "UNRESOLVED_FULLSCREEN").length;

  const honestAbsences = [];
  if (sentinelsNone > 0) honestAbsences.push(`${sentinelsNone} chain(s) have no PriceOracleSentinel (provider returned zero or the call reverted): recorded as sentinel NONE.`);
  if (uptimeFeedsUnresolved > 0) honestAbsences.push(`${uptimeFeedsUnresolved} chain(s) expose a sentinel but no resolvable sequencer-oracle getter: uptime feed recorded UNRESOLVED_FULLSCREEN and that sub-read skipped (never guessed).`);
  if (totalBandRows === 0) honestAbsences.push("No borrower in the discovered set (top totalBorrowsUSD, bounded 50/chain) has a live HF<0.95 at this pin.");
  honestAbsences.push("Per-row economics (USD debt, collateral value, route-positive) are out of scope for this lane: netDeltas is null for every row.");

  const artifact = {
    schema: ARTIFACT_SCHEMA,
    scannedAt: new Date().toISOString(),
    scanner: "tools/scan-aave-v3-l2-outage-l.js",
    scope: "Read-only Aave V3 on L2 cross-domain timing (sequencer-outage composition) observation producer",
    safety: {
      readOnly: true, signedActions: false, transactions: false, endpointMaterialPersisted: false,
      privateKeysRead: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false,
    },
    reference: {
      pools: "tools/scan-aave-v3-route-distance.js (AAVE_POOLS)",
      borrowTopics: "tools/scan-aave-v3-route-distance.js (BORROW_TOPICS)",
      discoveryAnchor: "tools/scan-aave-v3-l2-borrowers.js (api.v3.aave.com userBorrows GraphQL)",
      sentinelInterface: "targets/aave-v3-origin/src/contracts/interfaces/IPriceOracleSentinel.sol",
      aggregatorInterface: "targets/aave-v3-origin/src/contracts/dependencies/chainlink/AggregatorInterface.sol:46",
    },
    conventions: {
      vulnerableBand: HF_VULNERABLE,
      hfBandLow: HF_BAND_LOW,
      bandRule: "sentinel-bypass-band",
      staleBlocksThreshold: STALE_BLOCKS_THRESHOLD,
      avgBlockWindow: AVG_BLOCK_WINDOW,
      ageBlocksDerivation: "ageBlocks = round(ageSeconds / measuredAvgBlockSeconds); avgBlockSeconds measured on-chain over the trailing avgBlockWindow blocks. Raw ageSeconds and updatedAt are recorded; the only boolean is staleWarningAgeGt3600Blocks.",
      uptimeFeedAnswerSemantics: "0 = sequencer up, 1 = down (Chainlink SequencerUptimeFeed shape)",
    },
    totals: {
      chainsRequested: chainIds.length,
      chainsScanned: chains.filter((c) => !c.error).length,
      sentinelsResolved,
      sentinelsNone,
      uptimeFeedsResolved,
      uptimeFeedsUnresolved,
      accountsRead: totalAccountsRead,
      vulnerableBandRows: totalBandRows,
      oracleSourceRows: totalOracleRows,
      staleOracleRows,
      requests: REQUEST_COUNT,
      apiRequests: API_REQUEST_COUNT,
    },
    budget: {
      requestBudget: REQUEST_BUDGET,
      requests: REQUEST_COUNT,
      withinBudget: REQUEST_COUNT <= REQUEST_BUDGET,
      wallMs,
      maxWallMs: MAX_WALL_MS,
      withinWall: wallMs <= MAX_WALL_MS,
      sequential: true,
      runNumber,
      secondRun: runNumber >= 2,
      reusedIndex,
    },
    csv: { path: relPosix(csvPath), rowCount: csvWrite.rowCount, sha256: csvWrite.sha256, canonicalHash: canonicalHash(csvRows), bounded: true },
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
    const byLabel = { base: 8453, arbitrum: 42161, polygon: 137, optimism: 10 };
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
    const lines = Object.values(index.chains).map((c) => `${c.chainId}:sentinel=${c.sentinelState || "n/a"},uptime=${c.uptimeFeedState || "n/a"},candidates=${(c.borrowerCandidates || []).length},reserves=${c.reserveCount || 0}`);
    process.stdout.write(`aave-v3-l2-outage-l[sync] runs=${index.runCount} chains=${Object.keys(index.chains).length} ${lines.join(" ")}\n`);
    return;
  }
  const index = loadIndex(INDEX_PATH, fsImpl);
  if (options.full) {
    for (const state of Object.values(index.chains)) {
      state.reserves = [];
      state.reserveCount = 0;
      state.borrowerCandidates = [];
      state.discoverySource = null;
    }
  }
  const artifact = await runAndPublish({ chainIds: options.chainIds, index, fsImpl });
  const summary = {
    status: "OK",
    scannedAt: artifact.scannedAt,
    runNumber: artifact.budget.runNumber,
    secondRun: artifact.budget.secondRun,
    reusedIndex: artifact.budget.reusedIndex,
    requests: artifact.totals.requests,
    apiRequests: artifact.totals.apiRequests,
    wallMs: artifact.budget.wallMs,
    withinBudget: artifact.budget.withinBudget,
    chains: artifact.chains.map((c) => ({
      chainId: c.chainId,
      label: c.label,
      sentinel: c.sentinel ? c.sentinel.sentinelState : "n/a",
      gracePeriodSeconds: c.sentinel ? c.sentinel.gracePeriodSeconds ?? null : null,
      uptimeFeed: c.sentinel ? c.sentinel.uptimeFeedState : "n/a",
      uptimeFeedStatus: c.sentinel && c.sentinel.uptimeFeedRound ? c.sentinel.uptimeFeedRound.sequencerStatus : null,
      vulnerableBandRows: c.vulnerableBand ? c.vulnerableBand.count : 0,
      accountsRead: c.vulnerableBand ? c.vulnerableBand.accountsRead : 0,
      oracleSourcesRead: c.oracleFreshness ? c.oracleFreshness.rows.length : 0,
      oracleStaleRows: c.oracleFreshness ? c.oracleFreshness.rows.filter((r) => r.staleWarningAgeGt3600Blocks === true).length : 0,
      complete: c.coverage ? c.coverage.complete : false,
    })),
    csv: artifact.csv.path,
    coverage: artifact.coverage,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`aave-v3-l2-outage-l scan failed: ${error && error.code ? error.code : "SCAN_FAILED"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE, ARTIFACT_PATH, CSV_PATH, INDEX_PATH, ARTIFACT_SCHEMA, INDEX_SCHEMA, VERSION,
  MULTICALL3, CHAINS, AAVE_POOLS, BORROW_TOPICS, AAVE_API,
  WINDOW, MAX_ACCOUNTS_PER_CHAIN, MAX_ASSETS_PER_CHAIN, HF_VULNERABLE, HF_BAND_LOW,
  STALE_BLOCKS_THRESHOLD, AVG_BLOCK_WINDOW, REQUEST_BUDGET, I,
  ScanFailure, sleep, hexBlock, relPosix, lower, isZeroAddr, canonicalHash, toIso, round,
  call, selectFinalized, resolveWorkingRpc, decodeOrNull, readCode, readCall, multicall,
  emptyChainIndex, emptyIndex, loadIndex, persistIndex,
  discoverBorrowersApi, discoverBorrowersLogs, readReserveMetadata,
  resolveSentinel, readUptimeFeed, measureAvgBlockSeconds, rankAssets, readOracleFreshness,
  atomicWriteJson, writeCsv, hfBandLabel, scanChain, scan, runAndPublish, parseArgs, main,
};
