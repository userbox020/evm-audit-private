#!/usr/bin/env node
'use strict';

// OFFLINE ONLY. No dependencies, endpoints, environment reads or target writes.
// All EVM amounts, counters, grid parameters and numerical references use BigInt.
// JS array indices / filesystem metadata are not financial arithmetic.
// Source pin e8c2cca4c9b329ba8a383a27d7318e5f8b35c843 (source hashes in output).
// Run: node tools/sim-pendle-v7-rounding.js
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'targets/pendle-core-v2-e8c2cca4');
const OUT = path.join(ROOT, 'reports/raw/fast/novelty-rerank-20261017');
const W = 10n ** 18n;
const Y = 365n * 86400n;
const MAX128 = (1n << 128n) - 1n;
const I128 = (1n << 127n) - 1n;
const abs = x => x < 0n ? -x : x;
const min = (a, b) => a < b ? a : b;
const max = (a, b) => a > b ? a : b;
const ceil = (a, b) => { assert(a >= 0n && b > 0n); return (a + b - 1n) / b; };
const div = (a, b) => a * W / b; // Solidity signed division truncates TOWARD ZERO.
const mul = (a, b) => a * b / W;
const asset = (index, sy) => sy * index / W;
const sy = (index, a) => a * W / index;
function u128(x) { assert(x >= 0n && x <= MAX128, 'uint128 range'); return x; }
function sqrt(y) {
  if (y === 0n) return 0n;
  let z = y, x = y / 2n + 1n;
  while (x < z) { z = x; x = (y / x + x) / 2n; }
  return z;
}
const files = [
  'contracts/core/Market/PendleMarketV7.sol',
  'contracts/core/Market/MarketMathCore.sol',
  'contracts/core/Market/PendleMarketFactoryV7Upg.sol',
  'contracts/router/math/MarketApproxLibV2.sol',
  'contracts/core/YieldContracts/PendleYieldToken.sol',
  'contracts/core/libraries/math/PMath.sol',
  'contracts/core/libraries/math/LogExpMath.sol',
  'contracts/core/StandardizedYield/PYIndex.sol',
  'contracts/core/StandardizedYield/SYUtils.sol',
  'contracts/core/erc20/PendleERC20.sol',
  'contracts/interfaces/IStandardizedYield.sol',
  'contracts/oracles/PtYtLpOracle/PendlePYOracleLib.sol',
  'contracts/oracles/PtYtLpOracle/PendleLpOracleLib.sol',
];
const texts = Object.fromEntries(files.map(f => [f, fs.readFileSync(path.join(TARGET, f), 'utf8')]));
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const manifest = files.map(file => ({ file, sha256: hash(fs.readFileSync(path.join(TARGET, file))) }));

// Exact mirror of LogExpMath.sol:94-248,308-503, omitting unused pow().
// Read only numeric precomputed constants from the pinned source, never eval code.
const logText = texts['contracts/core/libraries/math/LogExpMath.sol'];
const constant = name => {
  const m = logText.match(new RegExp('int256 constant ' + name + ' = ([0-9_]+);'));
  assert(m, 'missing source constant ' + name);
  return BigInt(m[1].replaceAll('_', ''));
};
const X = [], A = [];
for (let i = 0; i <= 11; i++) { X.push(constant('x' + i)); A.push(constant('a' + i)); }
const W20 = 10n ** 20n, W36 = W * W;
function exp18(x) {
  assert(x >= -41n * W && x <= 130n * W, 'Invalid exponent');
  if (x < 0n) return W * W / exp18(-x);
  let first = 1n;
  if (x >= X[0]) { x -= X[0]; first = A[0]; }
  else if (x >= X[1]) { x -= X[1]; first = A[1]; }
  x *= 100n;
  let product = W20;
  for (let i = 2; i <= 9; i++) if (x >= X[i]) { x -= X[i]; product = product * A[i] / W20; }
  let term = x, sum = W20 + x;
  for (let n = 2n; n <= 12n; n++) { term = (term * x / W20) / n; sum += term; }
  return ((product * sum / W20) * first) / 100n;
}
function lnSeries(x, scale, last) {
  const z = (x - scale) * scale / (x + scale), z2 = z * z / scale;
  let num = z, sum = z;
  for (let n = 3n; n <= last; n += 2n) { num = num * z2 / scale; sum += num / n; }
  return 2n * sum;
}
function lnBase(a) {
  if (a < W) return -lnBase(W * W / a);
  let sum = 0n;
  for (let i = 0; i <= 1; i++) if (a >= A[i] * W) { a /= A[i]; sum += X[i]; }
  a *= 100n; sum *= 100n;
  for (let i = 2; i <= 11; i++) if (a >= A[i]) { a = a * W20 / A[i]; sum += X[i]; }
  return (sum + lnSeries(a, W20, 11n)) / 100n;
}
function ln18(a) {
  assert(a > 0n, 'out of bounds');
  return a > W - W / 10n && a < W + W / 10n ? lnSeries(a * W, W36, 15n) / W : lnBase(a);
}

// Independent high-precision reference: atanh ln with power-of-two range reduction;
// Taylor exp with repeated squaring. Not a substitution for Solidity execution.
// Evaluate at BOTH 72 and 96 decimals; assert identical final 18-decimal floors.
function reference(digits) {
  const S = 10n ** digits, memoLn = new Map(), memoExp = new Map();
  function seriesLn(a) {
    const z = (a - S) * S / (a + S), z2 = z * z / S;
    let term = z, sum = z;
    for (let n = 3n; n < 2001n; n += 2n) {
      term = term * z2 / S;
      const add = term / n; sum += add;
      if (add === 0n) return 2n * sum;
    }
    throw Error('reference ln did not converge');
  }
  const ln2 = seriesLn(2n * S);
  function ln(a) {
    assert(a > 0n);
    const key = a.toString(); if (memoLn.has(key)) return memoLn.get(key);
    let k = 0n;
    while (a >= 2n * S) { a /= 2n; k++; }
    while (a < S) { a *= 2n; k--; }
    const v = seriesLn(a) + k * ln2; memoLn.set(key, v); return v;
  }
  function exp(a) {
    const key = a.toString(); if (memoExp.has(key)) return memoExp.get(key);
    if (a < 0n) return S * S / exp(-a);
    let k = 0n;
    while (a > S / 8n) { a /= 2n; k++; }
    let term = S, sum = S;
    for (let n = 1n; n < 2001n; n++) {
      term = term * a / S / n; sum += term;
      if (term === 0n) break;
      assert(n !== 2000n, 'reference exp did not converge');
    }
    while (k-- > 0n) sum = sum * sum / S;
    memoExp.set(key, sum); return sum;
  }
  return { S, ln, exp };
}
const ref72 = reference(72n), ref96 = reference(96n);

// FIXED GRID. No live state; all markets synthetic, source-range-valid only.
const grid = {
  indexes: [W, W + 1n, 15n * W / 10n + 7n, 10n * W + 7n, 10000n * W],
  reserveSy: [10n ** 6n + 1n, 10n ** 12n + 1n, W + 1n],
  ptToAssetRatios: [[1n, 1000n], [1n, 100n], [1n, 1n], [19n, 1n]],
  scalarRoots: [10n * W, 50n * W, 100n * W],
  timesToExpiry: [86400n, 30n * 86400n, Y],
  initialAnchor: 2n * W,
  burnFractions: [[1n, 1000n], [1n, 3n], [1n, 2n], [999n, 1000n]],
  priorBurnCounts: [1n, 2n, 8n, 32n],
  feeAssetAmounts: [1n, 99n, 100n, 101n, 10001n, 10n ** 6n + 17n, W + 17n, 10n ** 24n + 17n],
  reserveFeePercent: [0n, 1n, 20n, 50n, 99n, 100n],
  cacheFlags: [false, true], sameBlockFlags: [false, true],
  callbacks: ['setPostExpiryData', 'redeemPY', 'redeemPYMulti', 'redeemDueInterestAndRewards',
    'redeemInterestAndRewardsPostExpiryForTreasury', 'pyIndexCurrent', 'transfer', 'transferFrom', 'approve', 'view'],
  callbackPhases: ['claimRewards-before-firstPYIndex', 'exchangeRate-before-firstPYIndex', 'rewardIndexesCurrent-after-firstPYIndex'],
  callbackFailureModes: ['caught', 'propagated'],
  feeWitness: { index: 15n * W / 10n + 7n, reserveSy: W + 1n, pt: W,
    scalarRoot: 10n * W, timeToExpiry: Y, lnFeeRateRoot: W / 100n,
    reserveFeePercent: 99n, targetFeeAsset: 101n, ptOutSearchMin: 1n, ptOutSearchMax: 50000n },
};
const rows = { a: [], b: [], c: [], d: [] };
const skipped = { a: 0n, b: 0n };

// (a) The actual initialize -> implied ln-rate -> PT/asset oracle path.
// MarketMathCore:125,373-381,335-353,309-323; PYOracleLib:65-75.
// No tick, LiquidityAmount or LP-position-count input exists in this market.
function impliedSource(pt, reserveSy, index, scalarRoot, t) {
  const totalAsset = asset(index, reserveSy), scalar = scalarRoot * Y / t;
  const proportion = div(pt, pt + totalAsset);
  assert(proportion <= 96n * W / 100n);
  const logit = div(proportion, W - proportion);
  const logProportion = ln18(logit);
  const exchange = div(logProportion, scalar) + grid.initialAnchor;
  if (exchange < W) return null;
  const lnExchange = ln18(exchange), lnImplied = lnExchange * Y / t;
  assert(lnImplied <= (1n << 96n) - 1n);
  const rt = lnImplied * t / Y, oracleExchange = exp18(rt);
  return { totalAsset, scalar, proportion, logit, logProportion, exchange, lnExchange, lnImplied,
    rt, oracleExchange, ptToAssetRate: W * W / oracleExchange };
}
function impliedReference(r, pt, reserveSy, index, scalarRoot, t) {
  const { S } = r;
  // Continuous counterparts, retaining exact pre-syToAsset reserve value.
  const totalAsset = reserveSy * index * S / W;
  const p = pt * S * S / (pt * S + totalAsset);
  const logit = p * S / (S - p), logProportion = r.ln(logit);
  const scalar = scalarRoot * Y * S / (t * W);
  const exchange = logProportion * S / scalar + grid.initialAnchor * S / W;
  const lnImplied = r.ln(exchange) * Y / t;
  const oracleExchange = r.exp(lnImplied * t / Y);
  return { exchange18: exchange * W / S, lnImplied18: lnImplied * W / S,
    ptToAssetRate18: W * S / oracleExchange };
}
for (const index of grid.indexes) for (const reserveSy of grid.reserveSy)
for (const [n, d] of grid.ptToAssetRatios) for (const scalarRoot of grid.scalarRoots)
for (const t of grid.timesToExpiry) {
  const pt = asset(index, reserveSy) * n / d, lp = sqrt(pt * reserveSy);
  assert(lp > 1000n && pt < I128 && reserveSy < I128);
  const s = impliedSource(pt, reserveSy, index, scalarRoot, t);
  if (!s || s.lnImplied === 0n) { skipped.a++; continue; }
  const r = impliedReference(ref72, pt, reserveSy, index, scalarRoot, t);
  assert.deepEqual(r, impliedReference(ref96, pt, reserveSy, index, scalarRoot, t), 'reference precision instability');
  rows.a.push({ index, reserveSy, pt, totalLp: lp, lpToReserve: 1000n, scalarRoot, timeToExpiry: t,
    sourceSteps: s, reference: r, formulaResult: s.ptToAssetRate, idealResult: r.ptToAssetRate18,
    absDiff: abs(s.ptToAssetRate - r.ptToAssetRate18),
    exchangeAbsDiff: abs(s.exchange - r.exchange18), lnImpliedAbsDiff: abs(s.lnImplied - r.lnImplied18) });
}

// (b) MarketMathCore:130-139 (mint floors LP, ceils nonlimiting input),166-176 (burn floors BOTH outputs).
function addLiquidity(m, ds, dp) {
  const byPt = dp * m.lp / m.pt, bySy = ds * m.lp / m.sy;
  const out = min(byPt, bySy);
  const usedPt = byPt < bySy ? dp : ceil(m.pt * out, m.lp);
  const usedSy = byPt < bySy ? ceil(m.sy * out, m.lp) : ds;
  assert(out > 0n && usedSy > 0n && usedPt > 0n);
  return { out, usedSy, usedPt, market: { lp: m.lp + out, sy: m.sy + usedSy, pt: m.pt + usedPt } };
}
function burn(m, lp) {
  assert(lp > 0n && lp <= m.lp - 1000n, 'locked liquidity');
  const outSy = lp * m.sy / m.lp, outPt = lp * m.pt / m.lp;
  assert(outSy !== 0n || outPt !== 0n, 'MarketZeroAmountsOutput');
  return { outSy, outPt, market: { lp: m.lp - lp, sy: m.sy - outSy, pt: m.pt - outPt } };
}
for (const index of grid.indexes) for (const reserveSy of grid.reserveSy)
for (const [n, d] of grid.ptToAssetRatios) for (const [bn, bd] of grid.burnFractions) {
  const pt = asset(index, reserveSy) * n / d;
  const m = { sy: reserveSy, pt, lp: sqrt(pt * reserveSy) };
  const amount = (m.lp - 1000n) * bn / bd;
  if (amount === 0n) { skipped.b++; continue; }
  const out = burn(m, amount), upperSy = ceil(amount * m.sy, m.lp), upperPt = ceil(amount * m.pt, m.lp);
  assert(upperSy - out.outSy <= 1n && upperPt - out.outPt <= 1n);
  // Normalized value is a separately labelled diagnostic, not raw SY wei.
  const assetValueGap = asset(index, upperSy) - asset(index, out.outSy) + upperPt - out.outPt;
  const minted = addLiquidity(m, max(1n, m.sy / 10n), max(1n, m.pt / 10n));
  const roundTrip = burn(minted.market, minted.out);
  assert(roundTrip.outSy <= minted.usedSy && roundTrip.outPt <= minted.usedPt, 'mint/burn gain');
  for (const count of grid.priorBurnCounts) {
    const eachVictimLp = (m.lp - 1000n) / (2n * count);
    if (eachVictimLp === 0n) { skipped.b++; continue; }
    let remaining = m, paidSy = 0n, paidPt = 0n;
    for (let i = 0n; i < count; i++) {
      const v = burn(remaining, eachVictimLp); remaining = v.market; paidSy += v.outSy; paidPt += v.outPt;
    }
    const lastLp = remaining.lp - 1000n, last = burn(remaining, lastLp);
    const fairSy = lastLp * m.sy / m.lp, fairPt = lastLp * m.pt / m.lp;
    assert(paidSy + last.outSy + last.market.sy === m.sy);
    assert(paidPt + last.outPt + last.market.pt === m.pt);
    assert(last.market.lp === 1000n);
    rows.b.push({ index, reserveSy, pt, totalLp: m.lp, lpToBurn: amount, formulaSy: out.outSy,
      ceilSy: upperSy, formulaPt: out.outPt, ceilPt: upperPt,
      absDiff: max(upperSy - out.outSy, upperPt - out.outPt), assetValueGap,
      mint: { lpOut: minted.out, usedSy: minted.usedSy, usedPt: minted.usedPt },
      roundTrip: { syOut: roundTrip.outSy, ptOut: roundTrip.outPt },
      priorBurnCount: count, eachVictimLp, lastLp, lastOutSy: last.outSy, lastOutPt: last.outPt,
      originalProRataSy: fairSy, originalProRataPt: fairPt,
      lastWithdrawerGainSy: last.outSy - fairSy, lastWithdrawerGainPt: last.outPt - fairPt,
      lastWithdrawerGainAsset: asset(index, last.outSy) - asset(index, fairSy) + last.outPt - fairPt,
      lockedRemainingSy: last.market.sy, lockedRemainingPt: last.market.pt });
  }
}

// (c) There is NO expiry PnL-distribution step in burn. Model the nearest real step:
// calcTrade:246-252 splits ALREADY COMPUTED positive asset fee, floors two SY conversions.
// This isolates allocation rounding, not preFee exchange/fee calculation error.
for (const index of grid.indexes) for (const fee of grid.feeAssetAmounts) for (const percent of grid.reserveFeePercent) {
  const reserveAsset = fee * percent / 100n;
  const totalSyFee = sy(index, fee), syToReserve = sy(index, reserveAsset);
  const reportedLpFee = totalSyFee - syToReserve;
  const idealLpFee = fee * (100n - percent) * W / (100n * index);
  // Three floor events: percent floor, total-fee SY conversion and reserve SY conversion.
  // The reserve-asset floor can add a further SY unit; do NOT assume a one-unit bound.
  assert(abs(reportedLpFee - idealLpFee) <= 2n);
  rows.c.push({ index, feeAsset: fee, reserveFeePercent: percent, reserveAsset, totalSyFee, syToReserve,
    formulaResult: reportedLpFee, idealResult: idealLpFee, absDiff: abs(reportedLpFee - idealLpFee),
    assetValueGap: abs(asset(index, reportedLpFee) - asset(index, idealLpFee)),
    executableSwapGuard: asset(index, reportedLpFee) > 0n,
    note: 'Actual swap-fee allocation diagnostic; not an expiry/burn PnL step or a full swap simulation.' });
}

// Construct one full source-math trade witness for the two-unit allocation row.
// This is still synthetic (not Solidity execution / not a deployed market binding).
const fw = grid.feeWitness;
const initial = impliedSource(fw.pt, fw.reserveSy, fw.index, fw.scalarRoot, fw.timeToExpiry);
assert(initial && fw.lnFeeRateRoot <= ln18(105n * W / 100n)); // factory:49,76
const priorExchange = exp18(initial.lnImplied * fw.timeToExpiry / Y);
const rateAnchor = priorExchange - div(ln18(div(initial.proportion, W - initial.proportion)), initial.scalar);
const feeRate = exp18(fw.lnFeeRateRoot * fw.timeToExpiry / Y);
function witnessTrade(ptOut) {
  const proportion = div(fw.pt - ptOut, fw.pt + initial.totalAsset);
  assert(proportion <= 96n * W / 100n && proportion > 0n);
  const preFeeExchangeRate = div(ln18(div(proportion, W - proportion)), initial.scalar) + rateAnchor;
  const preFeeAssetToAccount = -div(ptOut, preFeeExchangeRate);
  const postFeeExchangeRate = div(preFeeExchangeRate, feeRate);
  assert(postFeeExchangeRate >= W);
  const feeAsset = mul(preFeeAssetToAccount, W - feeRate);
  const reserveAsset = feeAsset * fw.reserveFeePercent / 100n;
  const netAssetToAccount = preFeeAssetToAccount - feeAsset;
  const netSyIn = ceil(-netAssetToAccount * W, fw.index);
  const netSyFee = sy(fw.index, feeAsset), netSyToReserve = sy(fw.index, reserveAsset);
  const reportedLpFee = netSyFee - netSyToReserve;
  const idealLpFee = feeAsset * (100n - fw.reserveFeePercent) * W / (100n * fw.index);
  const newPt = fw.pt - ptOut, newSy = fw.reserveSy + netSyIn - netSyToReserve;
  const newProportion = div(newPt, newPt + asset(fw.index, newSy));
  const newExchange = div(ln18(div(newProportion, W - newProportion)), initial.scalar) + rateAnchor;
  const newLnImpliedRate = ln18(newExchange) * Y / fw.timeToExpiry;
  assert(newLnImpliedRate > 0n && newLnImpliedRate < (1n << 96n));
  assert(newPt < I128 && newSy < I128);
  return { ptOut, preFeeExchangeRate, preFeeAssetToAccount, postFeeExchangeRate, feeAsset,
    reserveAsset, netAssetToAccount, netSyIn, netSyFee, netSyToReserve, reportedLpFee, idealLpFee,
    absDiff: abs(reportedLpFee - idealLpFee), executableSwapGuard: asset(fw.index, reportedLpFee) > 0n,
    newPt, newSy, newLnImpliedRate };
}
let lo = fw.ptOutSearchMin, hi = fw.ptOutSearchMax;
assert(witnessTrade(hi).feeAsset >= fw.targetFeeAsset);
while (lo < hi) {
  const mid = (lo + hi) / 2n;
  if (witnessTrade(mid).feeAsset >= fw.targetFeeAsset) hi = mid; else lo = mid + 1n;
}
const feeTradeWitness = { parameters: fw, initial, priorExchange, rateAnchor, feeRate, trade: witnessTrade(lo) };
assert.equal(feeTradeWitness.trade.feeAsset, fw.targetFeeAsset);
assert.equal(feeTradeWitness.trade.absDiff, 2n);
assert(feeTradeWitness.trade.executableSwapGuard);

// (d) Source-state-machine mirror, NOT an EVM reentrancy test.
// YT:54-58,131,147-151,168-172,201-205,243,260,379-391,403-410,505-508;
// PendleERC20:42-54,118,163-168. All paths into lazy-set enter the same lock first.
const guarded = new Set(grid.callbacks.filter(x => x !== 'approve' && x !== 'view'));
for (const index of grid.indexes) for (const cache of grid.cacheFlags) for (const sameBlock of grid.sameBlockFlags)
for (const action of grid.callbacks) for (const phase of grid.callbackPhases) for (const failureMode of grid.callbackFailureModes) {
  const before = { first: 0n, stored: W, writes: 0n };
  let state = { ...before }, status = 1n, rejected = 0n, rolledBack = false, callbackFirst = null;
  const expected = cache && sameBlock ? before.stored : max(index, before.stored);
  function callback(at) {
    if (phase !== at) return;
    callbackFirst = state.first;
    // exchangeRate() is VIEW (STATICCALL); no writes even via approve at this phase.
    const forbidden = guarded.has(action) || (at.startsWith('exchangeRate') && action === 'approve');
    if (forbidden) { rejected++; if (failureMode === 'propagated') throw Error('callback revert'); }
  }
  function lazySet() {
    if (state.first !== 0n) return;
    callback('claimRewards-before-firstPYIndex');
    if (!(cache && sameBlock)) callback('exchangeRate-before-firstPYIndex');
    state.stored = u128(expected); state.first = u128(expected); state.writes++;
    callback('rewardIndexesCurrent-after-firstPYIndex');
  }
  assert(status !== 2n); status = 2n;
  try { lazySet(); } catch { state = { ...before }; rolledBack = true; }
  status = 1n;
  const afterOuter = { ...state };
  // An ordinary subsequent transaction, with no adversarial callback, is idempotent
  // after success; after rollback, a legitimate first set is still possible.
  if (!rolledBack) { status = 2n; lazySet(); status = 1n; }
  const expectedFirst = rolledBack ? 0n : expected;
  assert(state.first === expectedFirst && state.writes === (rolledBack ? 0n : 1n));
  rows.d.push({ index, cache, sameBlock, action, phase, failureMode, expectedIndex: expected,
    callbackObservedFirst: callbackFirst, reentrantRejected: rejected, rolledBack,
    firstAfterOuter: afterOuter.first, firstAfterSecondCall: state.first, writes: state.writes,
    formulaResult: state.first, idealResult: expectedFirst, absDiff: abs(state.first - expectedFirst),
    note: 'Abstract source mirror; caught callbacks are a synthetic hostile-SY assumption, not deployment evidence.' });
}

// Cheap known answers, algebraic guards, cast falsification and signed-direction tests.
assert.equal(exp18(0n), W); assert.equal(ln18(W), 0n);
assert.equal(exp18(W), 2718281828459045235n);
assert.equal(ln18(2n * W), 693147180559945309n);
assert.equal(div(-1n, 3n * W), 0n); // NOT mathematical floor -1
assert.equal(u128(MAX128), MAX128); assert.throws(() => u128(MAX128 + 1n));
for (const index of grid.indexes) assert.equal(u128(index), index);
assert(!/convertToAssets|convertToShares|LiquidityAmount/.test(texts['contracts/core/Market/PendleMarketV7.sol']));
const resultMax = (rs, key) => rs.reduce((a, b) => b[key] > a[key] ? b : a, rs[0]);
const summaries = {};
for (const candidate of ['a', 'b', 'c', 'd']) {
  const rs = rows[candidate], worst = resultMax(rs, 'absDiff');
  summaries[candidate] = { rows: BigInt(rs.length), maxAbsDiff: worst.absDiff,
    aboveOneWeiRows: BigInt(rs.filter(r => r.absDiff > 1n).length), worstCase: worst };
}
summaries.a.unit = 'PT-to-asset rate units (1e18 precision), continuous-reference floor comparison';
summaries.a.maxAtExactly1e18Index = resultMax(rows.a.filter(r => r.index === W), 'absDiff');
summaries.a.maxWithAtLeast1e18RawSy = resultMax(rows.a.filter(r => r.reserveSy >= W), 'absDiff');
summaries.a.verdict = 'THRESHOLD_FLAG: source-valid synthetic initialization/oracle precision difference >1. No profitable route proved; no ticks or position-count mechanism exists.';
summaries.b.unit = 'raw SY or PT wei, maximum per-output floor/ceil gap';
summaries.b.worstAssetValueGap = resultMax(rows.b, 'assetValueGap');
summaries.b.worstLastWithdrawerAssetGain = resultMax(rows.b, 'lastWithdrawerGainAsset');
summaries.b.maxLastWithdrawerSyGain = resultMax(rows.b, 'lastWithdrawerGainSy').lastWithdrawerGainSy;
summaries.b.maxLastWithdrawerPtGain = resultMax(rows.b, 'lastWithdrawerGainPt').lastWithdrawerGainPt;
summaries.b.maxSequenceOutputAbsDiff = max(summaries.b.maxLastWithdrawerSyGain, summaries.b.maxLastWithdrawerPtGain);
summaries.b.worstSequenceAtExactly1e18Index = resultMax(rows.b.filter(r => r.index === W), 'lastWithdrawerGainAsset');
summaries.b.verdict = 'Per-output gap <=1 raw unit; asset-normalized and accumulated last-withdrawer dust can exceed1. ERC4626 premise false. No mint/burn roundtrip gain; donations/trade/financing/gas not modeled.';
summaries.c.unit = 'raw SY wei in actual swap-fee allocation diagnostic';
summaries.c.claimedExpiryPnlStep = 'N/A: absent from burn; cannot assign a measured zero to nonexistent math';
summaries.c.worstAssetValueGap = resultMax(rows.c, 'assetValueGap');
summaries.c.fullTradeSourceMathWitness = feeTradeWitness;
summaries.c.verdict = 'Claimed burn/expiry distribution absent. Actual swap-fee allocation gap <=2 SY units on this grid, with asset-normalization amplification. No last-withdrawer fee sweep exists.';
summaries.d.unit = 'PY-index units; abstract source-state-machine comparison';
summaries.d.verdict = 'Double-set path source-refuted: all callers, including inherited transfer/transferFrom hook paths, hold the common reentrancy lock. No EVM runtime validation claimed.';
const output = {
  schema: 'pendle-v7-alt-rounding/v1', signal: 'SOURCE_BOUNDED_THRESHOLD_FLAG_NOT_EXPLOIT',
  generatedAt: new Date().toISOString(), nodeVersion: process.version,
  sourceCommit: 'e8c2cca4c9b329ba8a383a27d7318e5f8b35c843', sourceTree: '03ad7e203832bbdb7ea944b260092c4626339b99',
  sourceManifest: manifest, simulatorSha256: hash(fs.readFileSync(__filename)),
  execution: { offline: true, rpcCalls: 0n, targetWrites: 0n, signing: false, broadcast: false, solidityExecuted: false },
  gates: { routePositive: 'unknown', executableNow: 'unknown', signedActionJustified: 'false',
    routeDisposition: 'UNKNOWN', accessDisposition: 'OFFLINE-ONLY', deploymentDisposition: 'UNBOUND' },
  evidence: { localSemantic: 'PASS: source mirror assertions only', reachability: 'synthetic source-state range only; no deployed instance binding',
    economics: 'UNKNOWN: no complete actor-to-extraction or net profit model', reproducibility: 'node tools/sim-pendle-v7-rounding.js' },
  scope: 'Fixed-grid initial implied/PT-oracle math, proportional burn/mint, fee-allocation substep and abstract lazy-set lock. Not a whole-protocol audit.',
  reference: 'Independent 72/96 decimal atanh/Taylor reference; all final comparison floors agree. Not a formal transcendentals proof.',
  grid, skipped, summaries, rows,
  conclusion: 'Uint128 truncation stays refuted; it does NOT generalize to absence of all other rounding. Candidate (a) exceeds1 rate unit on source-valid synthetic inputs, even index=1e18. This is a triage flag, NOT an exploit finding. Do not close A04 entirely based on the proposed one-wei criterion.',
};
for (const m of manifest) assert.equal(hash(fs.readFileSync(path.join(TARGET, m.file))), m.sha256, 'source changed during run');
const json = x => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'pendle-v7-alt-rounding-results.json'), json(output) + '\n');
for (const [k, s] of Object.entries(summaries)) console.log(`${k}: rows=${s.rows} maxAbsDiff=${s.maxAbsDiff} (${s.unit})`);
console.log(`b: max last-withdrawer gains SY=${summaries.b.maxLastWithdrawerSyGain} PT=${summaries.b.maxLastWithdrawerPtGain}`);
console.log('All assertions passed; source hashes unchanged. JSON written. No network or target modifications.');
