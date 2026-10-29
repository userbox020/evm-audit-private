"use strict";

// Target-agnostic scheduling and offline arithmetic only. Callers authenticate
// parent/state evidence and own authorization, freshness scopes and execution.
// No target imports, RPC, persistent state, signing or background work on import.
const controllers = new WeakMap();
const WAD = 10n ** 18n, VIRTUAL_SHARES = 1000000n, BPS = 10000n;
const MAX_UINT = (1n << 256n) - 1n, MAX_TIME = 8640000000000000;
const DEFAULT_BPS_LADDER = Object.freeze([10000n, 9500n, 9000n, 8000n, 7000n, 5000n, 2500n]);
function failure(code) { return Object.assign(new Error(code), { code }); }
function need(ok, code) { if (!ok) throw failure(code); }
function uint(value, code = "MORPHO_INVALID_AMOUNT") {
  need(typeof value === "bigint" || typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ||
    typeof value === "number" && Number.isSafeInteger(value), code);
  const n = BigInt(value); need(n >= 0n && n <= MAX_UINT, code); return n;
}
function positive(value, code) { const n = uint(value, code); need(n > 0n, code || "MORPHO_INVALID_AMOUNT"); return n; }
const ceil = (n, d) => n / d + (n % d === 0n ? 0n : 1n);
const min = (...values) => values.reduce((a, b) => a < b ? a : b);

function state(controller) { const s = controllers.get(controller); need(s, "WARM_UNISSUED"); return s; }
function active(s) { need(!s.closed, "WARM_CLOSED"); need(!s.stopped, "WARM_STOPPED"); }
function latchStop(s) {
  s.stopped = true; s.lastAuthenticParent = null;
  clearTimeout(s.waitTimer); s.waitReject?.();
}
function drain(g) {
  if (!g?.handle) return Promise.resolve();
  if (!g.drain) {
    g.drain = Promise.resolve().then(() => g.handle.close?.());
    g.drain.catch(() => {});
  }
  return g.drain;
}
async function settleAndDrain(g) { if (g) { await g.promise; await drain(g); } }
function shutdown(s, closed = false) {
  if (closed) s.closed = true;
  latchStop(s);
  if (!s.shutdownPromise) s.shutdownPromise = (async () => {
    const generations = [s.current, s.pending];
    const results = await Promise.allSettled(generations.map(settleAndDrain));
    for (const g of generations) if (g) { g.finished = true; g.ready = false; }
    s.current = null; s.pending = null;
    const failed = results.find(row => row.status === "rejected"); if (failed) throw failed.reason;
  })();
  return s.shutdownPromise;
}
function clock(s) {
  let wall, mono;
  try { wall = s.now(); mono = s.monotonicNow(); } catch { /* sanitized clock hold below */ }
  if (!(Number.isSafeInteger(wall) && wall >= 0 && wall <= MAX_TIME && Number.isFinite(mono) && mono >= 0 &&
      (s.previousWall === null || wall >= s.previousWall) && (s.previousMono === null || mono >= s.previousMono))) {
    shutdown(s).catch(() => {}); throw failure("WARM_CLOCK_HOLD");
  }
  s.previousWall = wall; s.previousMono = mono; return { wall, mono };
}
function parentOf(parent, slotSeconds) {
  need(parent && typeof parent === "object", "WARM_PARENT_HOLD");
  const number = uint(parent.number, "WARM_PARENT_HOLD"), timestamp = uint(parent.timestamp, "WARM_PARENT_HOLD");
  need(number <= BigInt(Number.MAX_SAFE_INTEGER) && timestamp * 1000n + BigInt(slotSeconds) * 1000n <= BigInt(MAX_TIME) &&
    typeof parent.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(parent.hash) && !/^0x0{64}$/.test(parent.hash), "WARM_PARENT_HOLD");
  return Object.freeze({ number: number.toString(), hash: parent.hash.toLowerCase(), timestamp: timestamp.toString() });
}
function createWarmSlotController({ qualify, slotSeconds = 12, failureBackoffMs = 5000, maxRuns,
  now = Date.now, monotonicNow = () => require("node:perf_hooks").performance.now(), pause } = {}) {
  need(typeof qualify === "function" && typeof now === "function" && typeof monotonicNow === "function" &&
    (pause === undefined || typeof pause === "function") && Number.isSafeInteger(slotSeconds) && slotSeconds > 0 &&
    slotSeconds <= MAX_TIME / 1000 && Number.isSafeInteger(failureBackoffMs) && failureBackoffMs >= 0 && failureBackoffMs <= MAX_TIME &&
    (maxRuns === undefined || Number.isSafeInteger(maxRuns) && maxRuns >= 1), "WARM_OPTIONS_REJECTED");
  const controller = Object.freeze({});
  controllers.set(controller, { qualify, slotSeconds, failureBackoffMs, maxRuns, now, monotonicNow, pause,
    cycleCount: 0, current: null, pending: null, lastAuthenticParent: null, needsBackoff: false, stopped: false, closed: false,
    previousWall: null, previousMono: null, waitTimer: null, waitReject: null, shutdownPromise: null });
  return controller;
}
function generation() {
  return { promise: null, handle: null, error: null, failed: false, drain: null, ready: false, finished: false, finishing: null,
    healthy: false, authenticParent: null, startedMonoMs: null, endedMonoMs: null };
}
function launch(s, g) {
  g.startedMonoMs = clock(s).mono; active(s);
  // Store background failures; checkout observes them without unhandled rejection.
  g.promise = Promise.resolve().then(async () => {
    try {
      active(s); g.handle = await s.qualify();
      need(g.handle !== null && ["object", "function"].includes(typeof g.handle) &&
        (g.handle.close === undefined || typeof g.handle.close === "function"), "WARM_QUALIFICATION_HOLD");
    } catch (e) { g.failed = true; g.error = e; }
    try { g.endedMonoMs = clock(s).mono; } catch (e) { g.failed = true; g.error = e; }
    if (s.stopped || s.closed || g.failed) try { await drain(g); } catch (e) { if (!g.failed) g.error = e; g.failed = true; }
  });
}
async function sleepUntil(s, targetWall) {
  need(Number.isSafeInteger(targetWall) && targetWall <= MAX_TIME, "WARM_CLOCK_HOLD");
  for (;;) {
    active(s); const remaining = targetWall - clock(s).wall; if (remaining <= 0) return;
    try {
      await Promise.race([
        s.pause ? Promise.resolve().then(() => s.pause(remaining)) : new Promise(resolve => { s.waitTimer = setTimeout(resolve, remaining); }),
        new Promise((_, reject) => { s.waitReject = () => reject(failure(s.closed ? "WARM_CLOSED" : "WARM_STOPPED")); }),
      ]);
    } finally { clearTimeout(s.waitTimer); s.waitTimer = null; s.waitReject = null; }
  }
}
async function takeWarmQualification(controller) {
  const s = state(controller); active(s); need(s.current === null, "WARM_BUSY");
  need(s.cycleCount < (s.maxRuns ?? Infinity), "WARM_MAX_RUNS"); clock(s);
  const warm = s.pending !== null, parent = s.lastAuthenticParent, g = s.pending || generation();
  s.pending = null; s.current = g; s.cycleCount++;
  const metrics = { cycle: s.cycleCount, warmPrequalified: warm, qualificationElapsedMs: null,
    qualificationCriticalPathMs: null, slotWaitElapsedMs: 0 };
  try {
    if (!warm && s.needsBackoff && s.cycleCount > 1) {
      const start = clock(s); await sleepUntil(s, start.wall + s.failureBackoffMs);
      metrics.slotWaitElapsedMs = clock(s).mono - start.mono;
    }
    const start = clock(s).mono;
    if (!warm) launch(s, g);
    await g.promise;
    metrics.qualificationCriticalPathMs = clock(s).mono - start;
    metrics.qualificationElapsedMs = g.endedMonoMs - g.startedMonoMs;
    if (g.failed) throw g.error;
    active(s);
    if (warm) {
      need(parent, "WARM_PARENT_HOLD"); const waitStart = clock(s).mono;
      await sleepUntil(s, Number(parent.timestamp) * 1000 + s.slotSeconds * 1000);
      metrics.slotWaitElapsedMs = clock(s).mono - waitStart;
    }
    active(s); need(s.current === g && !g.finished && !g.finishing, "WARM_GENERATION_CLOSED"); g.ready = true;
    return Object.freeze({ handle: g.handle, watchMetrics: Object.freeze(metrics) });
  } catch (e) {
    g.healthy = false; g.authenticParent = null; s.needsBackoff = true; s.lastAuthenticParent = null;
    await settleAndDrain(g); throw e;
  }
}
// Parent validation is structural, NOT authentication: only pass independently
// checked evidence from this checked-out handle, never a speculative next head.
function recordWarmCycleOutcome(controller, { healthy, parent } = {}) {
  const s = state(controller); active(s); const g = s.current;
  need(g?.ready && !g.finished && !g.finishing, "WARM_GENERATION_CLOSED");
  g.healthy = false; g.authenticParent = null;
  need(typeof healthy === "boolean", "WARM_OUTCOME_INVALID");
  if (healthy) { g.authenticParent = parentOf(parent, s.slotSeconds); g.healthy = true; }
}
async function finishWarmCycle(controller) {
  const s = state(controller), g = s.current; if (!g) return;
  if (g.finishing) return g.finishing;
  g.finishing = (async () => {
    try { await settleAndDrain(g); }
    catch (e) { latchStop(s); throw e; }
    finally { g.finished = true; g.ready = false; if (s.current === g) s.current = null; }
    if (!s.stopped && !s.closed && s.cycleCount < (s.maxRuns ?? Infinity) && g.healthy && g.authenticParent) {
      s.lastAuthenticParent = g.authenticParent; s.needsBackoff = false;
      s.pending = generation(); launch(s, s.pending);
    } else { s.lastAuthenticParent = null; s.needsBackoff = true; }
  })();
  return g.finishing;
}
async function stopWarmController(controller) { return shutdown(state(controller)); }
async function closeWarmController(controller) { return shutdown(state(controller), true); }

function createInflightCoalescer() {
  const inflight = new Map();
  return function coalesce(key, fn) {
    if (!inflight.has(key)) {
      const promise = Promise.resolve().then(fn).finally(() => { inflight.delete(key); });
      inflight.set(key, promise);
    }
    return inflight.get(key);
  };
}
function rpcUint(value) {
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) value = BigInt(value);
  return uint(value, "INVALID_QUANTITY");
}
async function runConcurrentCurrentChecks({ assertFresh, balance, code, owner, nonce,
  minBalanceWei, expectedRuntimeKeccak256, expectedOwner, expectedNonce }) {
  // Async wrappers capture synchronous throws without preventing later launches.
  const results = await Promise.allSettled([assertFresh, balance, code, owner, nonce].map(async fn => fn()));
  const codes = ["FRESHNESS_HOLD", "BALANCE_HOLD", "RUNTIME_HOLD", "OWNER_HOLD", "NONCE_HOLD"];
  let balanceWei, nonceValue;
  const validators = [
    value => value === true || value === undefined,
    value => { balanceWei = rpcUint(value); return balanceWei >= rpcUint(minBalanceWei); },
    value => typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(value) &&
      typeof expectedRuntimeKeccak256 === "string" && /^0x[0-9a-fA-F]{64}$/.test(expectedRuntimeKeccak256) &&
      require("../node_modules/ethers").keccak256(value) === expectedRuntimeKeccak256.toLowerCase(),
    value => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value) &&
      typeof expectedOwner === "string" && value.toLowerCase() === expectedOwner.toLowerCase(),
    value => { nonceValue = rpcUint(value); return nonceValue === rpcUint(expectedNonce); },
  ];
  for (let i = 0; i < results.length; i++) {
    let valid = false;
    if (results[i].status === "fulfilled") try { valid = validators[i](results[i].value); } catch { /* deterministic sanitized hold */ }
    need(valid, codes[i]);
  }
  return Object.freeze({ ok: true, balanceWei, nonce: nonceValue });
}

function liquidationIncentive(lltv) {
  const value = uint(lltv); need(value <= WAD, "MORPHO_INVALID_LLTV");
  return min(1150000000000000000n, WAD * WAD / (WAD - 300000000000000000n * (WAD - value) / WAD));
}
function wTaylorCompounded(rate, elapsed) {
  const first = uint(uint(rate) * uint(elapsed), "MORPHO_ACCRUAL_OVERFLOW");
  const second = uint(first * first, "MORPHO_ACCRUAL_OVERFLOW") / (2n * WAD);
  const third = uint(second * first, "MORPHO_ACCRUAL_OVERFLOW") / (3n * WAD);
  return uint(first + second + third, "MORPHO_ACCRUAL_OVERFLOW");
}
// All amounts are raw token/share units. Health is arithmetic, not live evidence.
function accrueMorphoPosition({ market, position, price, rate, timestamp, lltv, priceScale = 10n ** 36n }) {
  need(market && position, "MORPHO_INVALID_STATE");
  const totalBorrowAssets = uint(market.totalBorrowAssets), totalBorrowShares = uint(market.totalBorrowShares);
  const borrowShares = uint(position.borrowShares), collateral = uint(position.collateral);
  const lastUpdate = uint(market.lastUpdate), now = uint(timestamp), oraclePrice = positive(price), scale = positive(priceScale);
  const threshold = uint(lltv), lif = liquidationIncentive(threshold);
  need(now >= lastUpdate && borrowShares <= totalBorrowShares, "MORPHO_INVALID_STATE");
  const elapsed = now - lastUpdate, compounded = wTaylorCompounded(rate, elapsed);
  const interest = uint(totalBorrowAssets * compounded, "MORPHO_ACCRUAL_OVERFLOW") / WAD;
  const accruedBorrowAssets = uint(totalBorrowAssets + interest, "MORPHO_ACCRUAL_OVERFLOW");
  const debt = ceil(borrowShares * (accruedBorrowAssets + 1n), totalBorrowShares + VIRTUAL_SHARES);
  const maxBorrow = (collateral * oraclePrice / scale) * threshold / WAD;
  return Object.freeze({ totalBorrowAssets, totalBorrowShares, borrowShares, collateral, price: oraclePrice, priceScale: scale,
    lltv: threshold, lif, rate: uint(rate), timestamp: now, lastUpdate, elapsed, compounded, interest, accruedBorrowAssets,
    debt, maxBorrow, healthy: debt <= maxBorrow });
}
function repayment(state, seizedAssets) {
  const seizedQuoted = ceil(seizedAssets * state.price, state.priceScale);
  const repaidAssetsInitial = ceil(seizedQuoted * WAD, state.lif);
  const repaidShares = ceil(repaidAssetsInitial * (state.totalBorrowShares + VIRTUAL_SHARES), state.accruedBorrowAssets + 1n);
  need(repaidShares > 0n && repaidShares <= state.borrowShares, "MORPHO_REPAYMENT_SHARE_CAP_EXCEEDED");
  return { repaidShares, repaidAssets: ceil(repaidShares * (state.accruedBorrowAssets + 1n), state.totalBorrowShares + VIRTUAL_SHARES) };
}
// Full-share repayment first, then descending, unique seized-asset amounts.
// A retained floor is token-denominated metadata, not a profitability assertion;
// callers must independently establish eligibility, quotes, costs and authority.
function buildMorphoSizingVariants({ state, maxSeizeRaw = state?.collateral, minRetainedFloorRaw = 0n, bpsLadder = DEFAULT_BPS_LADDER }) {
  need(state && Array.isArray(bpsLadder) && bpsLadder.length <= 7, "MORPHO_INVALID_STATE");
  const s = Object.fromEntries(["borrowShares", "totalBorrowShares", "accruedBorrowAssets", "collateral", "lltv", "lif"].map(key => [key, uint(state[key])]));
  s.price = positive(state.price); s.priceScale = positive(state.priceScale);
  need(s.lif === liquidationIncentive(s.lltv) && s.borrowShares <= s.totalBorrowShares, "MORPHO_INVALID_STATE");
  const ladder = bpsLadder.map(value => { const bps = positive(value, "MORPHO_INVALID_BPS"); need(bps <= BPS, "MORPHO_INVALID_BPS"); return bps; })
    .sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
  const repaidAssetsDown = s.borrowShares * (s.accruedBorrowAssets + 1n) / (s.totalBorrowShares + VIRTUAL_SHARES);
  const shareBound = (repaidAssetsDown * s.lif / WAD) * s.priceScale / s.price;
  const maxSeize = min(uint(maxSeizeRaw), s.collateral), base = min(maxSeize, shareBound);
  const retained = uint(minRetainedFloorRaw), variants = [], seizedVariants = new Map();
  if (s.borrowShares > 0n && shareBound > 0n && shareBound <= maxSeize) {
    variants.push(Object.freeze({ mode: "repaidShares", bps: BPS, seizedAssets: 0n, repaidShares: s.borrowShares,
      expectedSeizedAssets: shareBound, expectedRepaidShares: s.borrowShares,
      expectedRepaidAssets: ceil(s.borrowShares * (s.accruedBorrowAssets + 1n), s.totalBorrowShares + VIRTUAL_SHARES), minRetainedFloorRaw: retained }));
  }
  for (const bps of ladder) {
    const seizedAssets = base * bps / BPS; if (seizedAssets === 0n || seizedVariants.has(seizedAssets)) continue;
    const paid = repayment(s, seizedAssets);
    seizedVariants.set(seizedAssets, Object.freeze({ mode: "seizedAssets", bps, seizedAssets, repaidShares: 0n,
      expectedSeizedAssets: seizedAssets, expectedRepaidShares: paid.repaidShares, expectedRepaidAssets: paid.repaidAssets, minRetainedFloorRaw: retained }));
  }
  return Object.freeze([...variants, ...seizedVariants.values()]);
}

module.exports = Object.freeze({ createWarmSlotController, takeWarmQualification, recordWarmCycleOutcome, finishWarmCycle,
  stopWarmController, closeWarmController, createInflightCoalescer, runConcurrentCurrentChecks, accrueMorphoPosition, buildMorphoSizingVariants });
