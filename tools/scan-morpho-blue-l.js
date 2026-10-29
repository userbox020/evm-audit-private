#!/usr/bin/env node
"use strict";

// Morpho Blue Ethereum liquidation (L class) read-only observation producer.
//
// Enumerate EVERY Borrow log emitted by the Ethereum Morpho Blue singleton from
// its deployment block forward in chunked, resumable, zero-failure passes, then
// re-derive exact liquidatability with Morpho's own conventions:
//   * interest accrued to the pinned finalized block with the market IRM's own
//     `borrowRate` (replicating `_accrueInterest`),
//   * `toAssetsUp(shares, totalBorrowAssets, totalBorrowShares)` with the
//     VIRTUAL_ASSETS=1 / VIRTUAL_SHARES=1e6 share offsets,
//   * `maxBorrow = collateral * oraclePrice / 1e36 * lltv / 1e18`.
// The raw stored-state count is kept only as a directional audit field and is
// never published as a finding.
//
// The full-history index is complete after a one-time `--full` seed. Each watch
// cycle then re-evaluates only the persisted active/unresolved pair set plus any
// pair that first appears in the tail-sync, which keeps the cycle inside the
// profit-trigger watch budget while still covering every pair that can hold
// debt (a zero-debt pair can only re-enter via a new Borrow log).
//
// Read-only. No signing, no transactions, no broadcasts. RPC material stays
// process-only and is never printed or persisted.
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc, loadRpcUrls } = require("./shared-rpc");
const morphoValuation = require("./morpho-unwind-valuation");
const deadline = require("./lib/producer-deadline");

const WORKSPACE = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(WORKSPACE, "reports", "monitor", "morpho-blue-l-index.json");
const ARTIFACT_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "morpho-blue-liquidatable.json");
const COVERAGE_PATH = path.join(WORKSPACE, "reports", "monitor", "trigger-coverage", "morpho-blue-ethereum-l.json");

const INDEX_SCHEMA = "morpho-blue-l-index/v1";
const ARTIFACT_SCHEMA = "morpho-blue-liquidatable-observation/v1";
const COVERAGE_SCHEMA = "trigger-coverage-evidence/v1";
const VERSION = 1;
const CHAIN_ID = 1;

// Morpho Blue is deployed at the same singleton address and emits the same
// Borrow event on every supported chain; only the deployment block, the
// gas-feed, the artifact paths and the log-range cap differ.
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const BORROW_TOPIC = "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43";
const ENUMERATION_REF = "bounded active-position observation";

const CHAINS = Object.freeze({
  1: Object.freeze({
    chainId: 1,
    family: "Morpho Blue",
    label: "ethereum",
    deployBlock: 18883124,
    chainlinkEthUsd: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    indexPath: path.join(WORKSPACE, "reports", "monitor", "morpho-blue-l-index.json"),
    artifactPath: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-blue-liquidatable.json"),
    coveragePath: path.join(WORKSPACE, "reports", "monitor", "trigger-coverage", "morpho-blue-ethereum-l.json"),
    logChunk: 50_000,
  }),
  8453: Object.freeze({
    chainId: 8453,
    family: "Morpho Blue",
    label: "base",
    deployBlock: 13977148,
    chainlinkEthUsd: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    indexPath: path.join(WORKSPACE, "reports", "monitor", "morpho-blue-l-base-index.json"),
    artifactPath: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-blue-liquidatable-base.json"),
    coveragePath: path.join(WORKSPACE, "reports", "monitor", "trigger-coverage", "morpho-blue-base-l.json"),
    logChunk: 12_000,
    backfillConcurrency: 10,
  }),
});
let ACTIVE = CHAINS[1];
function chainConfig(chainId) { return CHAINS[Number(chainId)] || null; }
function activeConfig() { return ACTIVE; }

const DEPLOY_BLOCK = CHAINS[1].deployBlock;

const WAD = 10n ** 18n;
const ORACLE_SCALE = 10n ** 36n;
const VIRTUAL_SHARES = 1_000_000n;
const VIRTUAL_ASSETS = 1n;

const TIMEOUT_MS = 30_000;
const LOG_CHUNK = 50_000;
const LOG_CHUNK_MIN = 5_000;
const MC_BATCH = 200;
const MC_CONCURRENCY = 4;
const IRM_CONCURRENCY = 16;
const SAMPLE_SIZE = 8;

const MARKET_PARAMS_ABI = "function idToMarketParams(bytes32 id) view returns (address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)";
const MARKET_ABI = "function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)";
const POSITION_ABI = "function position(bytes32 id,address borrower) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)";
const ORACLE_ABI = "function price() view returns (uint256)";
const IRM_ABI = "function borrowRate((address,address,address,address,uint256) marketParams,(uint128,uint128,uint128,uint128,uint128,uint128) market) view returns (uint256)";
const LIQUIDATE_ABI = "function liquidate((address,address,address,address,uint256) marketParams,address borrower,uint256 seizedAssets,uint256 repaidShares,bytes data) returns (uint256,uint256)";
const MC_ABI = "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])";

const I = Object.freeze({
  params: new ethers.Interface([MARKET_PARAMS_ABI]),
  market: new ethers.Interface([MARKET_ABI]),
  position: new ethers.Interface([POSITION_ABI]),
  oracle: new ethers.Interface([ORACLE_ABI]),
  irm: new ethers.Interface([IRM_ABI]),
  liquidate: new ethers.Interface([LIQUIDATE_ABI]),
  multicall: new ethers.Interface([MC_ABI]),
});

const HEALTHY_POSITION_SELECTOR = ethers.id("HealthyPosition()").slice(0, 10);

class ScanFailure extends Error {
  constructor(code) { super(code); this.name = "ScanFailure"; this.code = code; }
}

function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function ceilDiv(a, b) { return (a + b - 1n) / b; }
function mulDivUp(x, y, denominator) { return denominator === 0n ? 0n : ceilDiv(x * y, denominator); }

// Morpho MathLib.toAssetsUp with the Blue virtual share/asset offsets.
function toAssetsUp(shares, totalAssets, totalShares) {
  return mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
}

// MathLib.wTaylorCompounded, preserving each Solidity integer rounding step.
function wTaylorCompounded(rate, elapsed) {
  const first = rate * elapsed;
  const second = first * first / (2n * WAD);
  const third = second * first / (3n * WAD);
  return first + second + third;
}

// Replicates Morpho Blue `_accrueInterest` for the borrow side.
function accruedBorrowAssets({ totalBorrowAssets, borrowRate, elapsedSeconds }) {
  if (elapsedSeconds <= 0n || borrowRate <= 0n) return totalBorrowAssets;
  const interest = totalBorrowAssets * wTaylorCompounded(borrowRate, elapsedSeconds) / WAD;
  return totalBorrowAssets + interest;
}

function maxBorrowAssets(collateral, oraclePrice, lltv) {
  return (((collateral * oraclePrice) / ORACLE_SCALE) * lltv) / WAD;
}

function isLiquidatable({ borrowed, collateral, maxBorrow }) {
  return borrowed > 0n && collateral >= 0n && borrowed > maxBorrow;
}

async function call(rpc, method, params, ms = TIMEOUT_MS, attempts = 6) {
  deadline.check();
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await deadline.invoke(() => rpcCall(rpc, method, params, ms, { signal: deadline.current()?.signal }));
    deadline.check();
    if (result !== null && result !== undefined) return result;
    last = result;
    if (attempt < attempts - 1) await sleep(250 * (attempt + 1));
  }
  void last;
  throw new ScanFailure("RPC_READ_FAILED");
}

const CHAINLINK_ETH_USD = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const CHAINLINK_I = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);

// ETH/USD at the exact pin, for the bounded gas ceiling. A stale or invalid feed
// fails the valuation closed rather than defaulting.
async function readEthUsd(rpc, blockRef, blockTimestamp, chainlinkAddress = CHAINLINK_ETH_USD) {
  const decimalsRaw = await call(rpc, "eth_call", [{ to: chainlinkAddress, data: CHAINLINK_I.encodeFunctionData("decimals", []) }, blockRef]);
  const roundRaw = await call(rpc, "eth_call", [{ to: chainlinkAddress, data: CHAINLINK_I.encodeFunctionData("latestRoundData", []) }, blockRef]);
  const decimalsDecoded = CHAINLINK_I.decodeFunctionResult("decimals", decimalsRaw);
  const round = CHAINLINK_I.decodeFunctionResult("latestRoundData", roundRaw);
  const answer = BigInt(round[1]);
  const updatedAt = BigInt(round[3]);
  if (Number(decimalsDecoded[0]) !== 8 || answer <= 0n || updatedAt <= 0n || updatedAt > blockTimestamp + 60n) throw new ScanFailure("ORACLE_INVALID");
  if (blockTimestamp - updatedAt > 3600n) throw new ScanFailure("ORACLE_STALE");
  return { ethUsdRaw: answer.toString(), updatedAtRaw: updatedAt.toString() };
}

async function selectFinalized(rpc) {
  const block = await call(rpc, "eth_getBlockByNumber", ["finalized", false]);
  if (!block || !/^0x[0-9a-f]+$/i.test(block.number || "") || !/^0x[0-9a-f]{64}$/i.test(block.hash || "")) throw new ScanFailure("BLOCK_UNAVAILABLE");
  return block;
}

const sleep = deadline.sleep;

// Some shared endpoints become degraded (mostly-null responses). Qualify the
// endpoint before a scan: chain id must match and a finalized block read must
// succeed. Endpoint values stay process-only.
async function resolveWorkingRpc(chainId) {
  deadline.check();
  const first = await deadline.invoke(() => resolveRpc(chainId));
  const candidates = [];
  if (first) candidates.push(first);
  try { deadline.check(); for (const url of loadRpcUrls({ maxCandidates: 40 })) if (!candidates.includes(url)) candidates.push(url); } catch (_) { deadline.check(); }
  for (const url of candidates.slice(0, 20)) {
    deadline.check();
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
    try {
      const chainRaw = await deadline.invoke(() => rpcCall(url, "eth_chainId", [], 6000, { signal: deadline.current()?.signal }));
      if (!chainRaw || Number(BigInt(chainRaw)) !== chainId) continue;
      const block = await deadline.invoke(() => rpcCall(url, "eth_getBlockByNumber", ["finalized", false], 12_000, { signal: deadline.current()?.signal }));
      if (block && block.number && block.hash) return url;
    } catch (_) { deadline.check(); /* try next candidate */ }
  }
  deadline.check();
  return first;
}

// --- Multicall3 aggregation -------------------------------------------------------------
async function multicall(rpc, blockTag, entries, options = {}) {
  deadline.check();
  const batchSize = options.batchSize || MC_BATCH;
  const concurrency = options.concurrency || MC_CONCURRENCY;
  const batches = [];
  for (let index = 0; index < entries.length; index += batchSize) batches.push(entries.slice(index, index + batchSize));
  const results = new Array(entries.length);
  let cursor = 0;
  let failures = 0;
  async function worker() {
    while (true) {
      deadline.check();
      const batchIndex = cursor++;
      if (batchIndex >= batches.length) return;
      const batch = batches[batchIndex];
      const offset = batchIndex * batchSize;
      // Bounded retry of a whole-batch transient failure, so endpoint flakiness
      // cannot silently produce incomplete coverage.
      let decodedBatch = null;
      for (let attempt = 0; attempt < 3 && decodedBatch === null; attempt += 1) {
        deadline.check();
        try {
          const tuples = batch.map((entry) => ({ target: entry.to, allowFailure: true, callData: entry.data }));
          const data = I.multicall.encodeFunctionData("aggregate3", [tuples]);
          const raw = await call(rpc, "eth_call", [{ to: MULTICALL3, data }, blockTag], TIMEOUT_MS);
          deadline.check();
          const [decoded] = I.multicall.decodeFunctionResult("aggregate3", raw);
          decodedBatch = decoded;
        } catch (_) {
          deadline.check();
          if (attempt < 2) await sleep(300 * (attempt + 1));
        }
      }
      if (decodedBatch === null) {
        failures += batch.length;
        for (let index = 0; index < batch.length; index += 1) results[offset + index] = null;
        continue;
      }
      decodedBatch.forEach((item, index) => {
        // Ethers drops nested tuple component names for `tuple(bool,bytes)[]`,
        // so read the result positionally.
        results[offset + index] = { success: item[0] === true, returnData: item[1] };
      });
    }
  }
  await deadline.join(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  deadline.check();
  return { results, failures };
}

function decodeOrNull(iface, fn, returnData) {
  try { return iface.decodeFunctionResult(fn, returnData); } catch (_) { return null; }
}

// Bounded-concurrency map for the sender-gated direct reads. A worker throw is
// counted as a failure and recorded as a null result (callers treat null as
// unresolved, never as a default).
async function poolMap(items, concurrency, worker) {
  deadline.check();
  const results = new Array(items.length);
  let cursor = 0;
  let failures = 0;
  async function run() {
    while (true) {
      deadline.check();
      const index = cursor++;
      if (index >= items.length) return;
      try {
        const result = await deadline.invoke(() => worker(items[index], index));
        deadline.check();
        results[index] = result;
      }
      catch (_) { deadline.check(); results[index] = null; failures += 1; }
    }
  }
  await deadline.join(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, run));
  deadline.check();
  return { results, failures };
}

// --- log index --------------------------------------------------------------------------
function emptyIndex(config = activeConfig()) {
  return {
    schema: INDEX_SCHEMA,
    chainId: config.chainId,
    version: VERSION,
    deploymentBlock: config.deployBlock,
    cursor: config.deployBlock,
    logs: 0,
    pairs: {},
    chunkReads: 0,
    failures: 0,
    backfill: null,
    historyStartBound: null,
    evaluation: null,
    failureReconciliation: null,
  };
}

function loadIndex(file = INDEX_PATH, fsImpl = fs) {
  if (!fsImpl.existsSync(file)) return emptyIndex();
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.pairs !== "object") return emptyIndex();
    return {
      ...emptyIndex(),
      ...parsed,
      pairs: parsed.pairs || {},
      failures: Number.isSafeInteger(parsed.failures) ? parsed.failures : 0,
    };
  } catch (_) {
    return emptyIndex();
  }
}

function persistIndex(index, file = INDEX_PATH, fsImpl = fs) {
  deadline.check();
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  deadline.check();
  const bytes = `${JSON.stringify(index)}\n`;
  deadline.check();
  fsImpl.writeFileSync(file, bytes);
}

function pairKeyForLog(log) {
  if (!Array.isArray(log.topics) || log.topics.length < 3) return null;
  return String(log.topics[1]).toLowerCase() + String(log.topics[2]).toLowerCase();
}

// The borrower topic is left-padded to 32 bytes and keeps its 0x prefix, so the
// 20-byte address starts at offset 26 within the topic.
function borrowerFromKey(key) { return `0x${key.slice(66).slice(26)}`; }
function marketFromKey(key) { return key.slice(0, 66); }

async function proveHistoryStartBound(rpc, config = activeConfig()) {
  // Independently checkable: Morpho runtime is absent one block before the
  // deployment block and present at it. Combined with a zero-failure full scan
  // from that block this pins the enumeration start.
  const priorBlockTag = hexBlock(config.deployBlock - 1);
  const deployTag = hexBlock(config.deployBlock);
  const before = await call(rpc, "eth_getCode", [MORPHO, priorBlockTag]);
  const at = await call(rpc, "eth_getCode", [MORPHO, deployTag]);
  const previousBlockCodeAbsent = before === "0x";
  const deploymentBlockCodePresent = typeof at === "string" && at.length > 2;
  if (!previousBlockCodeAbsent || !deploymentBlockCodePresent) throw new ScanFailure("HISTORY_BOUND_UNPROVEN");
  return {
    block: config.deployBlock,
    proven: true,
    proof: {
      method: "eth_getCode",
      address: MORPHO.toLowerCase(),
      previousBlock: config.deployBlock - 1,
      previousBlockCodeAbsent,
      deploymentBlockCodePresent,
      borrowTopic: BORROW_TOPIC,
      note: "Morpho runtime absent before deployment block and present at it; zero-failure Borrow-log scan starts here.",
    },
  };
}

// Reconcile the persisted read-failure count with the real per-chunk state.
// A legacy index used a single scalar that incremented on every aborted pass and
// was never cleared, so a transient endpoint failure permanently blocked
// completion even after the chunk was later fetched. The truth is the number of
// chunks still *not* successfully fetched. When a legacy scalar is replaced we
// record an explicit reconciliation (never a silent reset): the legacy count and
// the fetched/total chunk coverage are preserved as evidence.
function computeFailureAccounting({ legacyFailures, failedChunks, fetchedChunks, totalChunks, reconciledAt }) {
  const failures = Array.isArray(failedChunks) ? failedChunks.length : 0;
  const legacy = Number.isSafeInteger(legacyFailures) && legacyFailures > 0 ? legacyFailures : 0;
  let reconciliation = null;
  if (legacy > 0) {
    reconciliation = {
      reconciledAt,
      legacyFailures: legacy,
      remainingFailedChunks: failures,
      fetchedChunks,
      totalChunks,
      reason: fetchedChunks >= totalChunks
        ? "all declared chunks were subsequently fetched successfully; the legacy scalar counted aborted passes, not unresolved chunks"
        : "legacy scalar failure count replaced by per-chunk failure accounting",
    };
  }
  return { failures, reconciliation };
}

// One-time parallel full-history backfill. Chunks are processed out of order by
// a bounded worker pool over disjoint ranges, so a slow provider range cap costs
// latency only, and every completed chunk index is persisted for exact resume.
async function backfillParallel(index, { rpc, config, finalized, chunkSize, concurrency, indexPath, fsImpl, fetchChunk }) {
  deadline.check();
  const from0 = config.deployBlock;
  const total = Math.ceil((finalized - from0 + 1) / chunkSize);
  const state = index.backfill && index.backfill.chunkSize === chunkSize
    ? index.backfill
    : { chunkSize, done: [], failed: [] };
  const done = new Set(state.done);
  const failed = new Set(Array.isArray(state.failed) ? state.failed : []);
  index.backfill = state;
  let next = 0;
  let sincePersist = 0;
  const fetchRange = async (from, to) => {
    deadline.check();
    try {
      const logs = await call(rpc, "eth_getLogs", [{
        address: MORPHO, topics: [BORROW_TOPIC], fromBlock: hexBlock(from), toBlock: hexBlock(to),
      }], 30_000);
      deadline.check();
      if (!Array.isArray(logs)) throw new ScanFailure("LOG_READ_FAILED");
      return logs;
    } catch (error) {
      deadline.check();
      if (to > from) {
        const mid = from + Math.floor((to - from) / 2);
        const left = await fetchRange(from, mid);
        const right = await fetchRange(mid + 1, to);
        return left.concat(right);
      }
      throw error;
    }
  };
  // Bounded retry of one chunk before it is recorded as failed for the pass. A
  // failed chunk stays out of `done`, so a later cycle re-fetches it; it is only
  // cleared from `failed` once its logs are genuinely retrieved.
  const fetchRangeBounded = async (from, to, attempts = 3) => {
    let last = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      deadline.check();
      try { return await deadline.invoke(() => fetchRange(from, to)); }
      catch (error) { deadline.check(); last = error; if (attempt < attempts - 1) await sleep(300 * (attempt + 1)); }
    }
    throw last;
  };
  // Test seam: callers may inject the per-chunk fetcher to exercise the
  // classification/retry behaviour without a network.
  const fetchChunkFn = typeof fetchChunk === "function" ? fetchChunk : fetchRangeBounded;
  const worker = async () => {
    while (true) {
      deadline.check();
      let index0 = next++;
      while (index0 < total && done.has(index0)) index0 = next++;
      if (index0 >= total) return;
      const from = from0 + index0 * chunkSize;
      const to = Math.min(finalized, from + chunkSize - 1);
      try {
        const logs = await deadline.invoke(() => fetchChunkFn(from, to));
        deadline.check();
        index.chunkReads += 1;
        for (const log of logs) {
          const key = pairKeyForLog(log);
          if (key) index.pairs[key] = (index.pairs[key] || 0) + 1;
        }
        index.logs += logs.length;
        done.add(index0);
        failed.delete(index0);
      } catch (_) {
        deadline.check();
        // Record the unresolved chunk; do not abort the whole pass and do not
        // consume its logs. It remains eligible for a later-cycle retry.
        failed.add(index0);
      }
      state.done = [...done];
      state.failed = [...failed];
      if (++sincePersist >= 25) { sincePersist = 0; persistIndex(index, indexPath, fsImpl); }
    }
  };
  await deadline.join(Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, worker));
  deadline.check();
  state.done = [...done];
  state.failed = [...failed];
  const accounting = computeFailureAccounting({
    legacyFailures: index.failures,
    failedChunks: [...failed],
    fetchedChunks: done.size,
    totalChunks: total,
    reconciledAt: new Date().toISOString(),
  });
  index.failures = accounting.failures;
  if (accounting.reconciliation) index.failureReconciliation = accounting.reconciliation;
  // Only advance the cursor once every chunk has been fetched at least once;
  // otherwise the next cycle must retry the missing chunks.
  if (done.size >= total) index.cursor = finalized + 1;
  persistIndex(index, indexPath, fsImpl);
}

async function syncIndex(index, deps = {}) {
  deadline.check();
  const config = deps.config || activeConfig();
  const rpc = deps.rpc;
  const indexPath = deps.indexPath || config.indexPath;
  const finalized = deps.finalizedBlock || Number(BigInt((await selectFinalized(rpc)).number));
  if (!index.historyStartBound || index.historyStartBound.proven !== true) {
    index.historyStartBound = await proveHistoryStartBound(rpc, config);
  }
  let cursor = Number.isSafeInteger(index.cursor) && index.cursor >= config.deployBlock ? index.cursor : config.deployBlock;
  // Deep-finality reorg guard: a cursor beyond the finalized tip means observed
  // history was rolled back, so restart at the bound (zero-failure rescan).
  if (cursor > finalized + 1) cursor = config.deployBlock;
  const priorPairKeys = new Set(Object.keys(index.pairs));
  if (deps.parallel && deps.parallel.chunkSize) {
    await backfillParallel(index, {
      rpc, config, finalized, chunkSize: deps.parallel.chunkSize,
      concurrency: deps.parallel.concurrency || 8, indexPath, fsImpl: deps.fsImpl,
    });
    const newPairKeysParallel = Object.keys(index.pairs).filter((key) => !priorPairKeys.has(key));
    return { finalizedBlock: finalized, cursor: index.cursor, pairCount: Object.keys(index.pairs).length, newPairKeys: newPairKeysParallel };
  }
  let chunk = config.logChunk || LOG_CHUNK;
  const maxChunk = chunk;
  while (cursor <= finalized) {
    deadline.check();
    const to = Math.min(finalized, cursor + chunk - 1);
    try {
      const logs = await call(rpc, "eth_getLogs", [{
        address: MORPHO, topics: [BORROW_TOPIC], fromBlock: hexBlock(cursor), toBlock: hexBlock(to),
      }], 25_000);
      deadline.check();
      if (!Array.isArray(logs)) throw new ScanFailure("LOG_READ_FAILED");
      index.chunkReads += 1;
      for (const log of logs) {
        const key = pairKeyForLog(log);
        if (!key) continue;
        index.pairs[key] = (index.pairs[key] || 0) + 1;
      }
      index.logs += logs.length;
      cursor = to + 1;
      index.cursor = cursor;
      if (chunk < maxChunk) chunk = Math.min(maxChunk, chunk * 2);
    } catch (error) {
      deadline.check();
      if (chunk > LOG_CHUNK_MIN) { chunk = Math.floor(chunk / 2); continue; }
      index.failures += 1;
      persistIndex(index, indexPath, deps.fsImpl);
      throw new ScanFailure("BACKFILL_FAILURE");
    }
  }
  const newPairKeys = Object.keys(index.pairs).filter((key) => !priorPairKeys.has(key));
  persistIndex(index, indexPath, deps.fsImpl);
  return { finalizedBlock: finalized, cursor: index.cursor, pairCount: Object.keys(index.pairs).length, newPairKeys };
}

// --- exact evaluation -------------------------------------------------------------------
async function resolveMarkets(rpc, blockTag, blockTimestamp, marketIds) {
  const paramsEntries = marketIds.map((id) => ({ to: MORPHO, data: I.params.encodeFunctionData("idToMarketParams", [id]) }));
  const paramsResult = await multicall(rpc, blockTag, paramsEntries);
  const markets = new Map();
  const unresolved = [];
  const unresolvedDetail = [];
  const oracleUnavailableDetail = [];
  const drop = (id, reason) => { unresolved.push(id); unresolvedDetail.push({ marketId: id, reason }); };
  paramsResult.results.forEach((item, index) => {
    const id = marketIds[index];
    if (!item || !item.success) { drop(id, "params-read"); return; }
    const decoded = decodeOrNull(I.params, "idToMarketParams", item.returnData);
    if (!decoded) { drop(id, "params-decode"); return; }
    markets.set(id, {
      id,
      loanToken: decoded[0], collateralToken: decoded[1], oracle: decoded[2], irm: decoded[3], lltv: BigInt(decoded[4]),
    });
  });

  const known = marketIds.filter((id) => markets.has(id));
  const stateAndPriceEntries = [];
  for (const id of known) {
    const market = markets.get(id);
    stateAndPriceEntries.push({ to: MORPHO, data: I.market.encodeFunctionData("market", [id]) });
    stateAndPriceEntries.push({ to: market.oracle, data: I.oracle.encodeFunctionData("price", []) });
  }
  const stateAndPrice = await multicall(rpc, blockTag, stateAndPriceEntries);
  const priced = [];
  stateAndPrice.results.forEach((item, index) => {
    const marketId = known[Math.floor(index / 2)];
    if (!markets.has(marketId)) return;
    if (index % 2 === 0) {
      const decoded = item && item.success ? decodeOrNull(I.market, "market", item.returnData) : null;
      if (!decoded) { markets.delete(marketId); drop(marketId, "market-read"); return; }
      const market = markets.get(marketId);
      market.totalSupplyAssets = BigInt(decoded[0]);
      market.totalSupplyShares = BigInt(decoded[1]);
      market.totalBorrowAssets = BigInt(decoded[2]);
      market.totalBorrowShares = BigInt(decoded[3]);
      market.lastUpdate = BigInt(decoded[4]);
      market.fee = BigInt(decoded[5]);
    } else {
      const decoded = item && item.success ? decodeOrNull(I.oracle, "price", item.returnData) : null;
      // Keep the market in the map with an explicit oracle-unavailable flag so a
      // position that is provably zero-debt is still classified zero (no oracle
      // needed) while a position with debt is honestly unresolved.
      const market = markets.get(marketId);
      if (!decoded) { market.oracleOk = false; oracleUnavailableDetail.push({ marketId, oracle: market.oracle, reason: "oracle-read" }); return; }
      if (BigInt(decoded[0]) === 0n) { market.oracleOk = false; oracleUnavailableDetail.push({ marketId, oracle: market.oracle, reason: "oracle-zero" }); return; }
      market.oracleOk = true;
      market.oraclePrice = BigInt(decoded[0]);
      priced.push(marketId);
    }
  });

  // The AdaptiveCurveIRM `borrowRate` view is sender-gated (`not Morpho`), so it
  // cannot be aggregated through Multicall3 (whose sub-call sender is itself).
  // Each rate is read with an explicit `from = MORPHO` at the exact pin.
  const irmTargets = priced.filter((id) => {
    const market = markets.get(id);
    return market && market.irm && !/^0x0{40}$/i.test(market.irm);
  });
  const { failures: irmFailures } = await poolMap(irmTargets, IRM_CONCURRENCY, async (id) => {
    const market = markets.get(id);
    const data = I.irm.encodeFunctionData("borrowRate", [
      [market.loanToken, market.collateralToken, market.oracle, market.irm, market.lltv],
      [market.totalSupplyAssets, market.totalSupplyShares, market.totalBorrowAssets, market.totalBorrowShares, market.lastUpdate, market.fee],
    ]);
    try {
      const raw = await call(rpc, "eth_call", [{ from: MORPHO, to: market.irm, data }, blockTag], TIMEOUT_MS);
      deadline.check();
      const decoded = decodeOrNull(I.irm, "borrowRate", raw);
      if (!decoded) throw new ScanFailure("IRM_DECODE_FAILED");
      market.borrowRate = BigInt(decoded[0]);
      return true;
    } catch (_) {
      deadline.check();
      market.borrowRate = null;
      return false;
    }
  });
  const irmUnresolved = irmTargets.filter((id) => markets.get(id).borrowRate === null);
  for (const id of irmUnresolved) { markets.delete(id); drop(id, "irm-read"); }

  for (const id of priced) {
    const market = markets.get(id);
    if (!market) continue;
    // A zero IRM address means the market accrues no interest; stored totals are
    // already exact at the pin.
    if (market.borrowRate === undefined) market.borrowRate = 0n;
    const elapsed = blockTimestamp - market.lastUpdate;
    market.elapsedSeconds = elapsed > 0n ? elapsed : 0n;
    market.totalBorrowAssetsAccrued = accruedBorrowAssets({
      totalBorrowAssets: market.totalBorrowAssets, borrowRate: market.borrowRate, elapsedSeconds: market.elapsedSeconds,
    });
  }
  const reads = marketIds.length
    + marketIds.length * 2
    + irmTargets.length;
  void irmFailures;
  return { markets, unresolved: [...new Set(unresolved)], unresolvedDetail, oracleUnavailableDetail, reads };
}

// Read every candidate position without needing market/oracle data first.
async function readPositions(rpc, blockTag, keys) {
  const entries = keys.map((key) => ({
    to: MORPHO,
    data: I.position.encodeFunctionData("position", [marketFromKey(key), borrowerFromKey(key)]),
  }));
  const result = await multicall(rpc, blockTag, entries);
  const positions = [];
  const failures = [];
  result.results.forEach((item, index) => {
    const key = keys[index];
    const decoded = item && item.success ? decodeOrNull(I.position, "position", item.returnData) : null;
    if (!decoded) { failures.push(key); return; }
    positions.push({ key, borrowShares: BigInt(decoded[1]), collateral: BigInt(decoded[2]) });
  });
  return { positions, failures };
}

// Classify with exact accrued borrow assets. A zero-debt position needs no
// oracle; a debt-bearing position in a market whose oracle is unavailable is
// honestly unresolved rather than guessed.
function classifyPositions(markets, positions) {
  const rows = [];
  const failures = [];
  for (const position of positions) {
    const { key } = position;
    if (position.borrowShares === 0n) { rows.push({ key, state: "zero" }); continue; }
    const market = markets.get(marketFromKey(key));
    if (!market) { failures.push(key); continue; }
    // A market whose oracle cannot be priced is structurally non-liquidatable at
    // this pin (the protocol's own `liquidate` reverts on the oracle call). The
    // debt-bearing position is excluded from the actionable set and recorded,
    // never silently treated as healthy or liquidatable.
    if (market.oracleOk !== true) {
      rows.push({ key, state: "oracleUnavailable", marketId: market.id, borrower: borrowerFromKey(key), oracle: market.oracle, borrowShares: position.borrowShares.toString() });
      continue;
    }
    if (market.totalBorrowAssetsAccrued === undefined) { failures.push(key); continue; }
    // Exact (accrued to the pin) and directional (stored, unaccrued) borrow
    // assets. The stored value reproduces the legacy unaccrued sweep count and
    // is published only as a directional audit field.
    const borrowed = toAssetsUp(position.borrowShares, market.totalBorrowAssetsAccrued, market.totalBorrowShares);
    const borrowedStored = toAssetsUp(position.borrowShares, market.totalBorrowAssets, market.totalBorrowShares);
    const maxBorrow = maxBorrowAssets(position.collateral, market.oraclePrice, market.lltv);
    const liquidatable = isLiquidatable({ borrowed, collateral: position.collateral, maxBorrow });
    const liquidatableStored = isLiquidatable({ borrowed: borrowedStored, collateral: position.collateral, maxBorrow });
    rows.push({
      key, state: "active", marketId: market.id, borrower: borrowerFromKey(key),
      loanToken: market.loanToken, collateralToken: market.collateralToken, oracle: market.oracle, irm: market.irm,
      borrowShares: position.borrowShares.toString(), collateralRaw: position.collateral.toString(),
      borrowedRaw: borrowed.toString(), borrowedStoredRaw: borrowedStored.toString(),
      totalBorrowAssetsAccruedRaw: market.totalBorrowAssetsAccrued.toString(),
      totalBorrowSharesRaw: market.totalBorrowShares.toString(),
      maxBorrowRaw: maxBorrow.toString(),
      oraclePriceRaw: market.oraclePrice.toString(), lltvRaw: market.lltv.toString(),
      liquidatable, liquidatableStored,
    });
  }
  return { rows, failures };
}

function decodeRevertString(returnData) {
  try {
    const raw = String(returnData || "");
    if (!raw.startsWith("0x08c379a0") || raw.length < 138) return "";
    const [message] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], `0x${raw.slice(10)}`);
    return `(${String(message).slice(0, 80)})`;
  } catch (_) { return ""; }
}

function revertMessage(returnData) {
  const selector = String(returnData || "0x").slice(0, 10).toLowerCase();
  if (selector === HEALTHY_POSITION_SELECTOR) return "position is healthy";
  return decodeRevertString(returnData).replace(/^\(|\)$/gu, "");
}

// Collateral to seize so the probe repays roughly the whole debt (bounded by the
// position), avoiding the rounding panic a 1-wei seize triggers on dust debts.
function probeSeizeRaw(row) {
  const borrowed = BigInt(row.borrowedRaw);
  const price = BigInt(row.oraclePriceRaw);
  const collateral = BigInt(row.collateralRaw);
  if (borrowed <= 0n || price <= 0n) return 1n;
  const needed = mulDivUp(borrowed, ORACLE_SCALE, price);
  const seize = needed < collateral ? needed : collateral;
  return seize > 0n ? seize : 1n;
}

// Independent verification: Morpho's own `liquidate` runs `_accrueInterest` and
// `_isHealthy` before it settles. Driving it at the exact pin therefore confirms
// our off-chain accrual and health arithmetic:
//   * a healthy account reverts with `HealthyPosition` / "position is healthy";
//   * a liquidatable account passes the health gate and then reverts at the
//     zero-funding `transferFrom` settlement step, because the Multicall3 sender
//     holds none of the loan asset. No `from`-funded liquidation is performed.
async function sampleVerify(rpc, blockTag, markets, activeCandidates) {
  // Probe the largest-debt positions first: 1-wei debts can make the on-chain
  // settlement rounding underflow, which would make the probe inconclusive
  // rather than wrong.
  const byDebtDesc = (a, b) => (BigInt(b.borrowedRaw) > BigInt(a.borrowedRaw) ? 1 : BigInt(b.borrowedRaw) < BigInt(a.borrowedRaw) ? -1 : 0);
  const liquidatable = activeCandidates.filter((row) => row.liquidatable).sort(byDebtDesc);
  const healthy = activeCandidates.filter((row) => !row.liquidatable).sort(byDebtDesc);
  const picks = [
    ...liquidatable.slice(0, SAMPLE_SIZE).map((row) => ({ row, expected: "liquidatable" })),
    ...healthy.slice(0, SAMPLE_SIZE).map((row) => ({ row, expected: "healthy" })),
  ];
  if (!picks.length) return { checked: 0, liquidatableConfirmed: 0, healthyConfirmed: 0, ambiguous: [], failures: 0 };
  const entries = picks.map(({ row }) => {
    const market = markets.get(row.marketId);
    return {
      to: MORPHO,
      data: I.liquidate.encodeFunctionData("liquidate", [
        [market.loanToken, market.collateralToken, market.oracle, market.irm, market.lltv],
        row.borrower, probeSeizeRaw(row), 0n, "0x",
      ]),
    };
  });
  const result = await multicall(rpc, blockTag, entries);
  let liquidatableConfirmed = 0;
  let healthyConfirmed = 0;
  const ambiguous = [];
  result.results.forEach((item, index) => {
    const pick = picks[index];
    if (!item) { ambiguous.push({ expected: pick.expected, reason: "read-failed" }); return; }
    const selector = String(item.returnData || "0x").slice(0, 10).toLowerCase();
    const message = revertMessage(item.returnData);
    if (pick.expected === "healthy") {
      if (selector === HEALTHY_POSITION_SELECTOR || /healthy/iu.test(message)) { healthyConfirmed += 1; return; }
      ambiguous.push({ expected: pick.expected, reason: `revert:${selector}${message ? `(${message})` : ""}` });
      return;
    }
    // Expected liquidatable: success is impossible here (no funding) but would
    // still confirm; the health gate is passed when the revert is the zero-fund
    // settlement pull rather than a healthy/structural revert.
    if (item.success) { liquidatableConfirmed += 1; return; }
    if (/transferFrom reverted|transfer reverted|insufficient allowance|insufficient balance/iu.test(message)) {
      liquidatableConfirmed += 1;
      return;
    }
    ambiguous.push({ expected: pick.expected, reason: `revert:${selector}${message ? `(${message})` : ""}` });
  });
  return { checked: picks.length, liquidatableConfirmed, healthyConfirmed, ambiguous, failures: result.failures };
}

// Unwind valuation. Discovers Uniswap V3 pools and quotes the realised unwind at
// the exact pin through the venue-generic qualifier. A candidate is only
// `routePositive:true` when the haircut-adjusted USDC output covers the repay
// and the bounded gas ceiling; unqualified pairs stay `routePositive:false` and
// are suppressed. `quoteExecutable` stays false until a same-pin keyless fork
// measures the view-vs-mined divergence for that route.
async function valuateCandidates({ rpc, blockRef, baseFeeRaw, blockTimestamp, activeCandidates, config = activeConfig() }) {
  const liquidatable = activeCandidates.filter((row) => row.liquidatable);
  if (!liquidatable.length) {
    return { status: "NO_CANDIDATE", qualifiedRoutes: 0, qualifiedCandidates: 0, routedCandidates: 0, unknownCandidates: 0, gasCeilingUsdcRaw: null, routes: [], candidates: [], note: "No exact liquidatable candidate at this pin." };
  }
  let ethUsdRaw = null;
  let ethUsdNote = null;
  try {
    const oracle = await readEthUsd(rpc, blockRef, blockTimestamp, config.chainlinkEthUsd);
    ethUsdRaw = oracle.ethUsdRaw;
  } catch (error) {
    deadline.check();
    ethUsdNote = error && error.code ? error.code : "ORACLE_UNAVAILABLE";
  }
  if (ethUsdRaw === null) {
    return {
      status: "GAS_ORACLE_UNAVAILABLE", qualifiedRoutes: 0, qualifiedCandidates: 0, routedCandidates: 0,
      unknownCandidates: liquidatable.length, gasCeilingUsdcRaw: null, routes: [],
      candidates: liquidatable.map((row) => ({
        eventKey: row.key, marketId: row.marketId, borrower: row.borrower,
        collateralToken: row.collateralToken, loanToken: row.loanToken,
        ...morphoValuation.liquidationAmounts(row),
        unwindRoute: null, routePositive: false, valuationStatus: "GAS_ORACLE_UNAVAILABLE",
        gasCeilingUsdcRaw: null, expectedOutUsdcRaw: null, repaidUsdcRaw: null, netUsdcRaw: null,
        haircutBps: 0, quoteExecutable: false, probeStatus: "BLOCKED", swapTarget: null, swapData: null, swapHops: [], swapFees: [], minLoanOutRaw: null,
      })),
      note: `ETH/USD gas oracle unavailable at the pin (${ethUsdNote}); all candidates suppressed.`,
    };
  }
  const result = await deadline.invoke(() => morphoValuation.valuate({
    rpc, blockRef, baseFeeWei: baseFeeRaw, ethUsdRaw, candidates: liquidatable, multicall, chainId: config.chainId,
  }));
  const routed = result.candidates.filter((row) => row.valuationStatus === "QUALIFIED_VIEW").length;
  const qualified = result.candidates.filter((row) => row.routePositive).length;
  return {
    status: routed > 0 ? "QUALIFIED_VIEW" : "UNQUALIFIED_ROUTE",
    qualifiedRoutes: result.routes.filter((route) => route.direct || route.collateralUsdc).length,
    qualifiedCandidates: qualified,
    routedCandidates: routed,
    unknownCandidates: result.candidates.length - routed,
    gasCeilingUsdcRaw: result.gasCeilingUsdcRaw,
    ethUsdRaw,
    routes: result.routes,
    candidates: result.candidates,
    note: routed > 0
      ? `${routed} candidate(s) have a view-quoted Uniswap V3 unwind route; ${qualified} cross the conservative net gate.`
      : "No candidate has a qualified collateral->loan/USDC Uniswap V3 route; all suppressed.",
  };
}

// --- artifact / binder ------------------------------------------------------------------
function coverageEvidence(artifact) {
  const valuation = artifact.valuation || {};
  const oracleUnavailable = artifact.enumeration && artifact.enumeration.oracleUnavailableNow;
  return {
    schema: COVERAGE_SCHEMA,
    observedAt: artifact.scannedAt,
    chainId: artifact.chainId,
    family: "Morpho Blue",
    triggerClass: "L",
    enumeration: {
      kind: "BOUNDED_ARTIFACT",
      ref: ENUMERATION_REF,
      boundDeclared: true,
      successful: artifact.coverage.complete === true,
    },
    reads: artifact.reads,
    classSemantics: { triggerClass: "L", exact: true },
    coverage: { complete: artifact.coverage.complete === true },
    onFire: { economics: true, keylessFixedPinFork: true, alert: true },
    dispatchEnabled: true,
    evidence: [
      `${relPosix((chainConfig(artifact.chainId) || activeConfig()).artifactPath)}#totals`,
      `historyStartBound block ${artifact.historyStartBound.block} proven=${artifact.historyStartBound.proven}`,
      ...(artifact.failureReconciliation ? [`read-failure reconciliation: legacyFailures=${artifact.failureReconciliation.legacyFailures} remainingFailedChunks=${artifact.failureReconciliation.remainingFailedChunks} chunksFetched=${artifact.failureReconciliation.fetchedChunks}/${artifact.failureReconciliation.totalChunks}`] : []),
      `finalized pin ${artifact.pin.number} hash ${artifact.pin.hash}`,
      `exact liquidatable ${artifact.totals.exactLiquidatable} of ${artifact.totals.activeEvaluated} active positions (raw directional ${artifact.totals.rawDirectionalLiquidatable})`,
      `sampledVerification liquidatable=${artifact.totals.sampledVerification.liquidatableConfirmed} healthy=${artifact.totals.sampledVerification.healthyConfirmed} ambiguous=${artifact.totals.sampledVerification.ambiguous.length}`,
      `oracle-unavailable markets excluded from the actionable bound: positions=${oracleUnavailable || 0} (protocol liquidate reverts on the oracle call; re-checked every cycle)`,
      `unwind valuation ${valuation.status} routes=${valuation.qualifiedRoutes || 0} routed=${valuation.routedCandidates || 0} unknown=${valuation.unknownCandidates || 0} routePositive=${valuation.qualifiedCandidates || 0} quoteExecutable=false (same-pin fork probe pending)`,
    ],
    blockers: artifact.coverage.complete === true ? [] : ["exact position enumeration incomplete"],
  };
}

function relPosix(target) { return path.relative(WORKSPACE, target).split(path.sep).join("/"); }

function publish(artifact, options = {}) {
  deadline.check();
  const fsImpl = options.fsImpl || fs;
  const config = chainConfig(artifact.chainId) || activeConfig();
  const artifactPath = options.artifactPath || config.artifactPath;
  const coveragePath = options.coveragePath || config.coveragePath;
  fsImpl.mkdirSync(path.dirname(artifactPath), { recursive: true });
  deadline.check();
  fsImpl.mkdirSync(path.dirname(coveragePath), { recursive: true });
  deadline.check();
  const artifactBytes = `${JSON.stringify(artifact, null, 2)}\n`;
  deadline.check();
  fsImpl.writeFileSync(artifactPath, artifactBytes);
  deadline.check();
  const coverageBytes = `${JSON.stringify(coverageEvidence(artifact), null, 2)}\n`;
  deadline.check();
  fsImpl.writeFileSync(coveragePath, coverageBytes);
  return artifact;
}

// --- orchestration ----------------------------------------------------------------------
async function scan(options = {}) {
  deadline.check();
  const config = chainConfig(options.chainId || options.chain || CHAIN_ID);
  if (!config) throw new ScanFailure("CHAIN_UNSUPPORTED");
  ACTIVE = config;
  const rpc = options.rpc || (await deadline.invoke(() => resolveWorkingRpc(config.chainId)));
  if (!rpc) throw new ScanFailure("RPC_UNAVAILABLE");
  const fsImpl = options.fsImpl || fs;
  const indexPath = options.indexPath || config.indexPath;
  const full = options.full === true;
  const index = options.index || loadIndex(indexPath, fsImpl);

  const finalizedBlock = await deadline.invoke(() => selectFinalized(rpc));
  const finalizedNumber = Number(BigInt(finalizedBlock.number));
  const pinTimestamp = BigInt(finalizedBlock.timestamp);
  const parallel = options.parallel !== undefined
    ? options.parallel
    : (config.backfillConcurrency ? { chunkSize: config.logChunk, concurrency: config.backfillConcurrency } : null);
  const sync = await deadline.invoke(() => syncIndex(index, { rpc, config, finalizedBlock: finalizedNumber, indexPath, fsImpl, parallel }));

  const evaluation = index.evaluation;
  let candidateKeys;
  if (full || !evaluation || !Array.isArray(evaluation.activeKeys)) {
    candidateKeys = Object.keys(index.pairs);
  } else {
    const seen = new Set();
    candidateKeys = [];
    for (const key of [...evaluation.activeKeys, ...(evaluation.unresolvedKeys || []), ...(evaluation.oracleUnavailableKeys || []), ...sync.newPairKeys]) {
      if (seen.has(key)) continue;
      seen.add(key);
      candidateKeys.push(key);
    }
  }

  // Exact-pin block reference (hash) used for every eth_call, with the pin
  // timestamp carried separately for interest accrual.
  const blockRef = finalizedBlock.hash;
  // Positions first (oracle-free), then market/oracle/IRM resolution only for
  // markets that actually hold debt.
  const { positions, failures: positionReadFailures } = await deadline.invoke(() => readPositions(rpc, blockRef, candidateKeys));
  const activeMarketIds = [...new Set(positions.filter((row) => row.borrowShares > 0n).map((row) => marketFromKey(row.key)))];
  const { markets, unresolvedDetail, oracleUnavailableDetail, reads: marketReads } = await deadline.invoke(() => resolveMarkets(rpc, blockRef, pinTimestamp, activeMarketIds));
  const { rows, failures: classifyFailures } = classifyPositions(markets, positions);
  const active = rows.filter((row) => row.state === "active");
  const zero = rows.filter((row) => row.state === "zero");
  const oracleUnavailable = rows.filter((row) => row.state === "oracleUnavailable");
  const sample = await deadline.invoke(() => sampleVerify(rpc, blockRef, markets, active));
  const valuation = await deadline.invoke(() => valuateCandidates({
    rpc, blockRef, config,
    baseFeeRaw: finalizedBlock.baseFeePerGas ? BigInt(finalizedBlock.baseFeePerGas) : 0n,
    blockTimestamp: pinTimestamp,
    activeCandidates: active,
  }));

  const activeKeys = active.map((row) => row.key);
  const oracleUnavailableKeys = oracleUnavailable.map((row) => row.key);
  const positionFailures = [...new Set([...positionReadFailures, ...classifyFailures])];
  const unresolvedKeys = [...positionFailures];
  index.evaluation = {
    evaluatedAt: new Date().toISOString(),
    pin: { number: finalizedNumber, hash: finalizedBlock.hash },
    pairCount: Object.keys(index.pairs).length,
    candidateCount: candidateKeys.length,
    activeKeys,
    unresolvedKeys,
    oracleUnavailableKeys,
  };
  persistIndex(index, indexPath, fsImpl);

  const activeEvaluated = active.length;
  const exactLiquidatable = active.filter((row) => row.liquidatable).length;
  const rawDirectional = active.filter((row) => row.liquidatableStored).length;
  const readsAttempted = index.chunkReads + candidateKeys.length + marketReads;
  const readsFailed = index.failures + positionFailures.length;
  const complete = index.failures === 0
    && unresolvedKeys.length === 0
    && positionFailures.length === 0
    && index.historyStartBound
    && index.historyStartBound.proven === true;

  const artifact = {
    schema: ARTIFACT_SCHEMA,
    scannedAt: new Date().toISOString(),
    scanner: "tools/scan-morpho-blue-l.js",
    chainId: config.chainId,
    safety: { readOnly: true, signedActions: false, transactions: false, endpointMaterialPersisted: false },
    pin: {
      number: finalizedNumber,
      hash: finalizedBlock.hash,
      timestamp: new Date(Number(pinTimestamp) * 1000).toISOString(),
      finality: "finalized",
      baseFeePerGasRaw: finalizedBlock.baseFeePerGas ? BigInt(finalizedBlock.baseFeePerGas).toString() : null,
    },
    historyStartBound: index.historyStartBound,
    failureReconciliation: index.failureReconciliation || null,
    index: {
      cursor: index.cursor,
      logs: index.logs,
      pairCount: Object.keys(index.pairs).length,
      failures: index.failures,
      chunkReads: index.chunkReads,
      newPairsThisCycle: sync.newPairKeys.length,
      mode: full || !evaluation ? "full" : "cycle",
    },
    enumeration: {
      candidatePairsThisCycle: candidateKeys.length,
      activeNow: active.length,
      zeroNow: zero.length,
      assumedZero: Object.keys(index.pairs).length - candidateKeys.length,
      unresolvedNow: unresolvedKeys.length,
      unresolvedMarkets: new Set(unresolvedDetail.map((row) => row.marketId)).size,
      unresolvedReasons: unresolvedDetail.reduce((acc, row) => {
        acc[row.reason] = (acc[row.reason] || 0) + 1;
        return acc;
      }, {}),
      oracleUnavailableNow: oracleUnavailable.length,
      oracleUnavailableMarkets: new Set(oracleUnavailableDetail.map((row) => row.marketId)).size,
      // A market whose oracle.price() reverts or is zero cannot execute the
      // protocol liquidate path at this pin, so its debt-bearing positions are
      // excluded from the actionable bound and re-checked every cycle.
      oracleUnavailableExcluded: true,
      method: "Morpho Blue Borrow-log full-history index + exact accrued-position evaluation",
    },
    totals: {
      rawDirectionalLiquidatable: rawDirectional,
      exactLiquidatable,
      activeEvaluated,
      oracleUnavailable: oracleUnavailable.length,
      sampledVerification: sample,
    },
    valuation,
    rows: valuation.candidates,
    reads: { attempted: readsAttempted, succeeded: readsAttempted - readsFailed, failed: readsFailed, unclassifiedFailures: 0 },
    coverage: {
      complete,
      blockers: complete ? [] : ["exact position enumeration incomplete at this pin"],
    },
  };
  deadline.check();
  return artifact;
}

async function runAndPublish(options = {}) {
  const artifact = await scan(options);
  return publish(artifact, options);
}

function parseArgs(argv) {
  const modes = new Set(argv.filter((value) => value.startsWith("--")));
  const full = modes.has("--full");
  const sync = modes.has("--sync");
  const chainArgIndex = argv.indexOf("--chain");
  let chainId = 1;
  if (chainArgIndex !== -1) {
    const value = argv[chainArgIndex + 1];
    chainId = value === "base" ? 8453 : value === "ethereum" ? 1 : Number(value);
    modes.delete("--chain");
  }
  const unknown = [...modes].filter((value) => !["--full", "--sync", "--cycle"].includes(value));
  if (unknown.length || !chainConfig(chainId)) throw new ScanFailure("USAGE");
  return { full, sync, chainId };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const config = chainConfig(options.chainId);
  if (options.sync) {
    ACTIVE = config;
    const rpc = await resolveRpc(config.chainId);
    const index = loadIndex(config.indexPath);
    const parallel = config.backfillConcurrency ? { chunkSize: config.logChunk, concurrency: config.backfillConcurrency } : null;
    const sync = await syncIndex(index, { rpc, config, parallel });
    process.stdout.write(`morpho-blue-l[${config.label}] index cursor=${sync.cursor} pairs=${sync.pairCount} new=${sync.newPairKeys.length} failures=${index.failures}\n`);
    return;
  }
  const artifact = await runAndPublish({ full: options.full, chainId: options.chainId });
  process.stdout.write(`${JSON.stringify({
    status: "OK",
    chain: config.label,
    mode: artifact.index.mode,
    pin: artifact.pin.number,
    pairs: artifact.index.pairCount,
    active: artifact.enumeration.activeNow,
    exactLiquidatable: artifact.totals.exactLiquidatable,
    valuation: artifact.valuation.status,
    complete: artifact.coverage.complete,
    failures: artifact.index.failures,
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`morpho-blue-l scan failed: ${error && error.code ? error.code : "SCAN_FAILED"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE, INDEX_PATH, ARTIFACT_PATH, COVERAGE_PATH, INDEX_SCHEMA, ARTIFACT_SCHEMA, COVERAGE_SCHEMA,
  VERSION, CHAIN_ID, CHAINS, chainConfig, activeConfig, MORPHO, MULTICALL3, BORROW_TOPIC, DEPLOY_BLOCK, ENUMERATION_REF,
  backfillParallel,
  WAD, ORACLE_SCALE, VIRTUAL_SHARES, VIRTUAL_ASSETS, HEALTHY_POSITION_SELECTOR, I,
  MC_BATCH, MC_CONCURRENCY, IRM_CONCURRENCY, SAMPLE_SIZE,
  ScanFailure, resolveWorkingRpc, hexBlock, ceilDiv, mulDivUp, toAssetsUp, wTaylorCompounded, accruedBorrowAssets, maxBorrowAssets, isLiquidatable,
  selectFinalized, multicall, poolMap, decodeOrNull, decodeRevertString, emptyIndex, loadIndex, persistIndex, pairKeyForLog,
  computeFailureAccounting,
  borrowerFromKey, marketFromKey, proveHistoryStartBound, syncIndex, resolveMarkets, readPositions,
  classifyPositions, sampleVerify, probeSeizeRaw, valuateCandidates, readEthUsd, CHAINLINK_ETH_USD, CHAINLINK_I,
  coverageEvidence, relPosix, publish, scan, runAndPublish, parseArgs, main,
};
