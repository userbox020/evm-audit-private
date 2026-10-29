"use strict";

// Import-inert: no CLI, endpoint discovery, seed-file reads, or network construction.
// The caller qualifies two independent families and supplies timeout/response-capped
// transports. A transport must settle within its supplied timeout; never detach it.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const indexer = require("./lib/compound-borrower-index");
const METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getLogs"]);
const MAX_REQUESTS = 3500, MAX_RUNTIME_MS = 1800000;
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const fail = (code) => { throw new Error(code); };
const safeCode = (error) => indexer.ERROR_CODES.includes(error?.message) ? error.message : "RPC_FAILURE";
const encode = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function createPacedTransports({ transports, minIntervalMs = 1100, maxRequests = MAX_REQUESTS,
  maxRuntimeMs = MAX_RUNTIME_MS, now = () => performance.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  indexer.validateTransports(transports);
  if (!integer(minIntervalMs, 0, MAX_RUNTIME_MS) || !integer(maxRequests, 0, MAX_REQUESTS)
      || !integer(maxRuntimeMs, 1, MAX_RUNTIME_MS) || typeof now !== "function" || typeof sleep !== "function") fail("INDEX_INVALID");
  let lastNow = -Infinity;
  const clock = () => {
    const tick = now();
    if (!Number.isFinite(tick) || tick < lastNow) fail("TIME_BUDGET_EXCEEDED");
    lastNow = tick; return tick;
  };
  const started = clock(), deadline = started + maxRuntimeMs;
  let requests = 0;
  const counts = [0, 0], lastStarts = [-Infinity, -Infinity], tails = [Promise.resolve(), Promise.resolve()];
  const paced = transports.map((send, provider) => (method, params, _id, timeoutMs) => {
    if (!METHODS.has(method)) return Promise.reject(new Error("READ_ONLY_METHOD_REQUIRED"));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error("TIME_BUDGET_EXCEEDED"));
    const requestDeadline = Math.min(deadline, clock() + timeoutMs);
    const run = async () => {
      try {
        if (requests >= maxRequests) fail("RPC_BUDGET_EXCEEDED");
        let tick = clock();
        // Queueing and pacing consume, rather than renew, the caller's timeout.
        while (tick < lastStarts[provider] + minIntervalMs) {
          const wait = lastStarts[provider] + minIntervalMs - tick;
          if (tick + wait >= requestDeadline) fail("TIME_BUDGET_EXCEEDED");
          await sleep(wait); tick = clock();
        }
        if (tick >= requestDeadline) fail("TIME_BUDGET_EXCEEDED");
        if (requests >= maxRequests) fail("RPC_BUDGET_EXCEEDED");
        lastStarts[provider] = tick; counts[provider]++; requests++;
        const value = await send(method, params, requests, requestDeadline - tick);
        if (clock() >= requestDeadline) fail("TIME_BUDGET_EXCEEDED");
        return value;
      } catch (error) { fail(safeCode(error)); }
    };
    const pending = tails[provider].then(run);
    tails[provider] = pending.catch(() => {});
    return pending;
  });
  return { transports: paced, now: clock,
    stats: () => ({ requests, requestsByProvider: counts.slice(), elapsedMs: clock() - started }) };
}

function rejectExisting(file) {
  try { fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw Object.assign(new Error("OUTPUT_EXISTS"), { code: "EEXIST" });
}

/**
 * totalBlocks includes the already-covered prefix of a resumed index. fromBlock
 * must equal that index's window.fromBlock; its entire window must fit the range.
 * Only that exact same-pin window is resumable. Legacy seeds are candidate hints.
 * Subsequent windows default to 5000 blocks / 100-block chunks / 50 attempts.
 * COMPLETE means the requested range only, never full market/history coverage.
 */
async function runBackfill({ transports, pin, seedBytes = null, fromBlock, totalBlocks, outDir,
  minIntervalMs = 1100, maxRequests = MAX_REQUESTS, maxRuntimeMs = MAX_RUNTIME_MS, now, sleep,
  windowBlocks = 5000, chunkBlocks = 100, maxChunks = 50,
  runId = crypto.randomBytes(12).toString("hex") } = {}) {
  indexer.validateTransports(transports); pin = indexer.normalizedPin(pin);
  if (!integer(fromBlock, 0, pin.number) || !integer(totalBlocks, 1, pin.number - fromBlock + 1)
      || !integer(windowBlocks, 1, indexer.MAX_WINDOW) || !integer(chunkBlocks, 1, indexer.MAX_CHUNK)
      || !integer(maxChunks, 1, indexer.MAX_CHUNKS) || Math.ceil(windowBlocks / chunkBlocks) > maxChunks
      || typeof outDir !== "string" || !outDir || typeof runId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(runId)) fail("INDEX_INVALID");
  const toBlock = fromBlock + totalBlocks - 1;
  const seed = seedBytes === null ? null : indexer.parseSeed(seedBytes);
  const prior = seed?.document.schema === indexer.INDEX_SCHEMA ? seed.document : null;
  if (seed && seed.provenance.pin.number > pin.number) fail("SEED_PIN_AHEAD");
  if (prior && (JSON.stringify(indexer.normalizedPin(prior.pin)) !== JSON.stringify(pin)
      || prior.window.fromBlock !== fromBlock || prior.window.toBlock > toBlock
      || Math.ceil((prior.window.toBlock - fromBlock + 1) / prior.window.chunkBlocks) > indexer.MAX_CHUNKS)) fail("RESUME_INCOMPATIBLE");
  const paced = createPacedTransports({ transports, minIntervalMs, maxRequests, maxRuntimeMs, now, sleep });
  const prefix = `compound-backfill-${runId}`, manifestName = `${prefix}-manifest.json`;
  const manifestPath = path.join(outDir, manifestName);
  rejectExisting(manifestPath);
  const sources = [], ranges = [];
  let currentBytes = seed?.bytes ?? null, indexPath = null, currentIndex = null;
  let nextCursor = fromBlock, reason = null, coveredBlocks = 0, successfulChunks = 0;
  let resumedCoveredBlocks = 0;
  do {
    const first = sources.length === 0;
    const start = first && prior ? prior.window.fromBlock : nextCursor;
    const end = first && prior ? prior.window.toBlock : Math.min(toBlock, start + windowBlocks - 1);
    const sourceName = `${prefix}-index-${String(sources.length).padStart(4, "0")}.json`;
    indexPath = path.join(outDir, sourceName);
    rejectExisting(indexPath);
    currentIndex = await indexer.scanBorrowerIndex({ transports: paced.transports, pin, seedBytes: currentBytes,
      fromBlock: start, windowBlocks: end - start + 1, chunkBlocks: first && prior ? prior.window.chunkBlocks : chunkBlocks,
      // The cap is per invocation; cached + new ranges remain bounded by MAX_CHUNKS.
      maxChunks: first && prior ? indexer.MAX_CHUNKS : maxChunks,
      backfill: first && prior ? prior.window.backfill : true, maxMs: 120000, now: paced.now });
    currentBytes = encode(currentIndex);
    // Closed-schema validation and evidence digests come exclusively from indexer.
    const validated = indexer.parseSeed(currentBytes).document;
    if (validated.window.fromBlock !== nextCursor || validated.window.toBlock !== end
        || JSON.stringify(validated.pin) !== JSON.stringify(pin)) fail("INDEX_INVALID");
    const saved = indexer.persistBorrowerIndex(indexPath, validated);
    sources.push({ path: sourceName, sha256: saved.sha256, window: { ...validated.window },
      nextCursor: validated.nextCursor, coveredBlocks: validated.coveredBlocks,
      successfulChunks: validated.successfulChunks, candidateCount: validated.users.length,
      pinVerified: validated.pinVerified, status: validated.status, reason: validated.reason,
      gaps: validated.gaps.map((gap) => ({ ...gap })) });
    // Count only validated source ranges, once; never seed users/provenance counters.
    if (validated.pinVerified) {
      for (const range of validated.coveredRanges) {
        if (range.fromBlock !== nextCursor) fail("INDEX_INVALID");
        ranges.push({ ...range, sourcePath: sourceName });
        coveredBlocks += range.toBlock - range.fromBlock + 1;
        successfulChunks++; nextCursor = range.toBlock + 1;
      }
      if (first && prior) resumedCoveredBlocks = prior.coveredBlocks;
    }
    if (validated.status !== "COMPLETE") { reason = validated.reason; break; }
  } while (nextCursor <= toBlock);

  // A demonstrated canonical pin/chain mismatch invalidates earlier same-pin proof.
  if (["PIN_DRIFT", "CHAIN_MISMATCH"].includes(reason)) {
    ranges.length = 0; coveredBlocks = 0; successfulChunks = 0; resumedCoveredBlocks = 0; nextCursor = fromBlock;
  }
  const manifest = { schema: "compound-v3-base-backfill/v1", updatedAt: new Date().toISOString(),
    chainId: indexer.CHAIN_ID, market: indexer.MARKET, pin, requestedRange: { fromBlock, toBlock, totalBlocks },
    status: reason === null && nextCursor === toBlock + 1 ? "COMPLETE" : "INCOMPLETE", reason,
    coverage: "PARTIAL", fullHistoryEstablished: false, fullMarketCoverageEstablished: false,
    corroboration: "TWO_CALLER_QUALIFIED_TRANSPORTS_EXACT_LOG_AGREEMENT",
    nextCursor, coveredBlocks, successfulChunks, resumedCoveredBlocks,
    newlyCoveredBlocks: coveredBlocks - resumedCoveredBlocks, candidateCount: currentIndex.users.length,
    seedProvenance: seed?.provenance ?? null, ranges,
    gaps: nextCursor <= toBlock ? [{ fromBlock: nextCursor, toBlock, reason: reason ?? "DISCOVERY_INCOMPLETE" }] : [],
    sources, finalIndexPath: sources.at(-1).path,
    limits: { minIntervalMs, maxRequests, maxRuntimeMs, windowBlocks, chunkBlocks, maxChunks }, diagnostics: paced.stats() };
  fs.writeFileSync(manifestPath, encode(manifest), { flag: "wx", mode: 0o600 });
  return { seedBytes: currentBytes, indexPath, index: currentIndex, manifestPath, manifest };
}

module.exports = { runBackfill, createPacedTransports };
