#!/usr/bin/env node
'use strict';
// Defensive, OFFLINE ONLY: no network, env/key reads, trades or pool mutations.
// Log/exp mirrors and the independent 72/96-digit reference are copied from
// sim-pendle-v7-rounding.js (cycle-4). Do not import it: importing runs its grid.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'reports/raw/fast/novelty-rerank-20261017/';
const TARGET = 'targets/pendle-core-v2-e8c2cca4/';
const W = 10n ** 18n, Y = 365n * 86400n;
const abs = x => x < 0n ? -x : x;
const max = (a, b) => a > b ? a : b;
const min = (a, b) => a < b ? a : b;
const ceil = (a, b) => { assert(a >= 0n && b > 0n); return (a + b - 1n) / b; };
const div = (a, b) => a * W / b; // signed Solidity division is toward ZERO
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const read = p => fs.readFileSync(path.join(ROOT, p));
const inputPaths = ['reports/raw/fast/pendle-l.json', BASE + 'A04-stage4-lattice.json',
  BASE + 'pendle-v7-alt-rounding-results.json', BASE + 'pendle-v7-alt-rounding-summary.md',
  'tools/sim-pendle-v7-rounding.js'];
const sourcePaths = ['contracts/core/Market/MarketMathCore.sol',
  'contracts/core/Market/PendleMarketV7.sol',
  'contracts/core/libraries/math/LogExpMath.sol', 'contracts/core/libraries/math/PMath.sol',
  'contracts/core/StandardizedYield/SYUtils.sol',
  'contracts/oracles/PtYtLpOracle/PendlePYOracleLib.sol'];
const inputManifest = inputPaths.map(file => ({ file, sha256: sha(read(file)) }));
const sourceManifest = sourcePaths.map(file => ({ file: TARGET + file, sha256: sha(read(TARGET + file)) }));
const snapshot = JSON.parse(read(inputPaths[0]));
const lattice = JSON.parse(read(inputPaths[1]));
const prior = JSON.parse(read(inputPaths[2]));
assert.equal(lattice.inputs.artifactSha256, sha(read(inputPaths[0])), 'snapshot differs from stage4 input');
for (const m of sourceManifest) assert.equal(m.sha256,
  prior.sourceManifest.find(p => TARGET + p.file === m.file)?.sha256, 'source differs from cycle4');
const priorWorst = BigInt(prior.summaries.a.maxAbsDiff);
assert.equal(priorWorst, 19446892277n);
const logText = read(TARGET + 'contracts/core/libraries/math/LogExpMath.sol').toString();
const constant = name => {
  const m = logText.match(new RegExp('int256 constant ' + name + ' = ([0-9_]+);'));
  assert(m, 'missing constant ' + name); return BigInt(m[1].replaceAll('_', ''));
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
  assert(a > 0n, 'log input out of bounds');
  return a > W - W / 10n && a < W + W / 10n ? lnSeries(a * W, W36, 15n) / W : lnBase(a);
}
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
function sourceMath(pt, sy, index, scalarRoot, t, anchor) {
  assert(t > 0n && sy > 0n && pt > 0n);
  const totalAsset = sy * index / W, scalar = scalarRoot * Y / t;
  assert(totalAsset > 0n && scalar > 0n);
  const proportion = div(pt, pt + totalAsset);
  assert(proportion > 0n && proportion <= 96n * W / 100n);
  const logit = div(proportion, W - proportion), logProportion = ln18(logit);
  const exchange = div(logProportion, scalar) + anchor;
  if (exchange < W) return null;
  const lnExchange = ln18(exchange), lnImplied = lnExchange * Y / t;
  assert(lnImplied >= 0n && lnImplied < (1n << 96n));
  const rt = lnImplied * t / Y, oracleExchange = exp18(rt);
  return { totalAsset, scalar, proportion, logit, logProportion, exchange, lnExchange,
    lnImplied, rt, oracleExchange, rate: W * W / oracleExchange };
}
function continuous(r, pt, sy, index, scalarRoot, t, anchor) {
  const { S } = r;
  const totalAsset = sy * index * S / W;
  const p = pt * S * S / (pt * S + totalAsset);
  const scalar = scalarRoot * Y * S / (t * W);
  const exchange = r.ln(p * S / (S - p)) * S / scalar + anchor * S / W;
  assert(exchange > 0n);
  const lnImplied = r.ln(exchange) * Y / t;
  return W * S / r.exp(lnImplied * t / Y);
}
function measure(pt, sy, lp, index, scalarRoot, t, anchor, kind, assetDecimals = 18n) {
  const totalAsset = sy * index / W;
  const p = div(pt, pt + totalAsset);
  if (totalAsset <= 0n || p <= 0n || p > 96n * W / 100n)
    return { kind, sy, pt, lp, status: 'SKIPPED_ASSET_OR_PROPORTION_GUARD', absDiff: null };
  const s = sourceMath(pt, sy, index, scalarRoot, t, anchor);
  if (s === null) return { kind, sy, pt, lp, status: 'EXCHANGE_BELOW_ONE', absDiff: null };
  const ideal = continuous(ref72, pt, sy, index, scalarRoot, t, anchor);
  assert.equal(ideal, continuous(ref96, pt, sy, index, scalarRoot, t, anchor), 'reference instability');
  const signedDiff = s.rate - ideal, absDiff = abs(signedDiff);
  // PT contribution diagnostic only, NOT PendleLpOracleLib's LP price formula.
  // ceil, not floor: do not hide sub-unit residuals by truncating to zero.
  const assetScale = 10n ** assetDecimals;
  const lpAdjustedRawCeil = ceil(absDiff * pt, lp);
  // LP is 18 decimals (PendleMarketV7:70); PT/asset can be SIX decimals.
  // Normalize asset value per one whole LP to 1e18, without flooring away dust.
  const lpAdjustedCeil = ceil(absDiff * pt * W, lp * assetScale);
  const reserveWeightedAssetWeiCeil = ceil(absDiff * pt, W);
  assert(absDiff >= 0n && lpAdjustedCeil * lp * assetScale >= absDiff * pt * W);
  return { kind, status: 'MEASURED', sy, pt, lp, index, scalarRoot, timeToExpiry: t,
    anchor, assetScale, sourceSteps: s, idealRate: ideal, signedDiff, absDiff, lpAdjustedRawCeil, lpAdjustedCeil,
    reserveWeightedAssetWeiCeil, dustBounded: lpAdjustedCeil <= 10n,
    sameOrderAsCycle4: absDiff * 10n >= priorWorst && absDiff <= priorWorst * 10n,
    atLeastCycle4Order: absDiff * 10n >= priorWorst };
}
const grid = { targetRawSy: [10n ** 6n + 1n, 10n ** 12n + 1n, W + 1n],
  anchorPolicy: 'Reconstruct current effective anchor via MarketMathCore:273-293 from stored ln rate and current reserves; freeze it for sensitivity rows. NOT immutable initialAnchor.',
  scalePolicy: 'SY=min(target,observed SY); PT=floor(observed PT*SY/observed SY); LP=floor(observed LP*SY/observed SY). No depletion sequence is modeled.',
  fingerprint: 'Within factor ten of 19446892277 raw rate units; larger values reported separately, never conflated with <=10 LP-adjusted units.' };
const markets = [];
for (const c of snapshot.chains) for (const m of c.markets) {
  const old = lattice.markets.find(v => v.chainId === c.chainId && v.marketAddress === m.market);
  assert(old, 'market absent from stage4');
  assert.equal(old.marketTotalSy, m.totalSyRaw); assert.equal(old.marketTotalPt, m.totalPtRaw);
  assert.equal(old.lpTotalSupply, m.totalLpRaw); assert.equal(old.expiryTimestamp, m.expiry);
  const sy = BigInt(m.totalSyRaw), pt = BigInt(m.totalPtRaw), lp = BigInt(m.totalLpRaw);
  const storedIndex = BigInt(m.pyIndexStoredRaw), syIndex = BigInt(m.syExchangeRateRaw);
  const cached = m.doCacheIndexSameBlock && BigInt(m.pyIndexLastUpdatedBlock) === BigInt(c.pin.number);
  const index = cached ? storedIndex : max(storedIndex, syIndex);
  const scalarRoot = BigInt(m.scalarRootRaw), lnStored = BigInt(m.lastLnImpliedRateRaw);
  const assetDecimals = BigInt(m.assetDecimals), assetScale = 10n ** assetDecimals;
  assert.equal(BigInt(m.ptDecimals), assetDecimals, 'rate decimal conversion not specified');
  const blockTime = BigInt(Date.parse(c.pin.timestamp)) / 1000n, expiry = BigInt(m.expiry);
  const t = expiry > blockTime ? expiry - blockTime : 0n;
  const row = { chainId: c.chainId, market: m.market, sourcePointer: old.sourcePointer, pin: c.pin,
    totalLpSupply: lp, totalSy: sy, totalPt: pt, expiry, expiryIso: m.expiryIso,
    syDecimals: m.syDecimals, ptDecimals: m.ptDecimals, assetDecimals: m.assetDecimals, lpDecimals: 18,
    pyIndexStored: storedIndex, syExchangeRate: syIndex, selectedIndex: index, sameBlockCached: cached,
    scalarRoot, lastLnImpliedRate: lnStored, timeToExpiry: t, lockedOnly: lp === 1000n,
    smallReserveRows: [] };
  assert(lp > 0n && sy > 0n && pt > 0n, 'nonpositive snapshot amount');
  if (t === 0n) {
    row.status = 'EXPIRED_RAW_ORACLE_EXACT_ONE';
    row.storedOracle = { sourceRate: W, idealRate: W, absDiff: 0n, lpAdjustedCeil: 0n };
    row.snapshotRecompute = null;
  } else {
    // Actual raw spot-oracle input is stored ln rate, NOT a fresh reserve recompute.
    const storedRate = W * W / exp18(lnStored * t / Y);
    const oracleRef = r => W * r.S / r.exp(lnStored * t * r.S / (Y * W));
    const idealStoredRate = oracleRef(ref72);
    assert.equal(idealStoredRate, oracleRef(ref96));
    const oracleDiff = abs(storedRate - idealStoredRate);
    row.storedOracle = { sourceRate: storedRate, idealRate: idealStoredRate,
      signedDiff: storedRate - idealStoredRate, absDiff: oracleDiff,
      lpAdjustedRawCeil: ceil(oracleDiff * pt, lp),
      lpAdjustedCeil: ceil(oracleDiff * pt * W, lp * assetScale) };
    const totalAsset = sy * index / W, scalar = scalarRoot * Y / t;
    const proportion = div(pt, pt + totalAsset);
    if (totalAsset <= 0n || proportion <= 0n || proportion > 96n * W / 100n) {
      row.status = 'SNAPSHOT_RESERVE_RECOMPUTE_SOURCE_GUARD';
      row.snapshotRecompute = { status: 'SKIPPED_ASSET_OR_PROPORTION_GUARD', totalAsset, proportion, absDiff: null };
    } else {
    const anchor = exp18(lnStored * t / Y) - div(ln18(div(proportion, W - proportion)), scalar);
    row.effectiveAnchor = anchor;
    row.snapshotRecompute = measure(pt, sy, lp, index, scalarRoot, t, anchor, 'SNAPSHOT_RESERVES_INFERRED_ANCHOR', assetDecimals);
    row.status = 'MEASURED';
    for (const target of grid.targetRawSy) {
      const smallSy = min(target, sy), smallPt = pt * smallSy / sy, smallLp = lp * smallSy / sy;
      if (smallSy === sy) continue; // snapshot row already covers this state
      if (smallLp <= 1000n || smallPt === 0n) {
        row.smallReserveRows.push({ kind: 'SYNTHETIC_RATIO_PRESERVING', targetRawSy: target,
          sy: smallSy, pt: smallPt, lp: smallLp, status: 'SKIPPED_LOCKED_LP_OR_ZERO_PT', absDiff: null });
      } else row.smallReserveRows.push({ targetRawSy: target,
        ...measure(smallPt, smallSy, smallLp, index, scalarRoot, t, anchor, 'SYNTHETIC_RATIO_PRESERVING', assetDecimals) });
    }
    }
  }
  const measured = [row.snapshotRecompute, ...row.smallReserveRows].filter(r => r?.status === 'MEASURED');
  row.snapshotDustBounded = row.storedOracle.lpAdjustedCeil <= 10n &&
    (t === 0n || (row.snapshotRecompute?.status === 'MEASURED' && row.snapshotRecompute.dustBounded));
  if (t > 0n && row.snapshotRecompute?.status !== 'MEASURED') row.snapshotDustBounded = null;
  row.latticeComplete = row.smallReserveRows.every(r => r.status === 'MEASURED') &&
    (t === 0n || row.snapshotRecompute?.status === 'MEASURED');
  row.maxRawRateResidual = measured.reduce((v, r) => max(v, r.absDiff), row.storedOracle.absDiff);
  row.maxLpAdjustedCeil = measured.reduce((v, r) => max(v, r.lpAdjustedCeil), row.storedOracle.lpAdjustedCeil);
  row.sameOrderAsCycle4 = measured.some(r => r.sameOrderAsCycle4);
  row.atLeastCycle4Order = measured.some(r => r.atLeastCycle4Order);
  row.verdict = row.snapshotDustBounded === null ? 'RESERVE_RECOMPUTE_UNKNOWN_STORED_ORACLE_ONLY' :
    row.maxLpAdjustedCeil <= 10n ? 'MEASURED_ROWS_DUST_BOUNDED' :
    row.atLeastCycle4Order ? 'CYCLE4_SCALE_OR_LARGER_MEASUREMENT_ONLY' : 'ABOVE_DUST_BELOW_CYCLE4_ORDER';
  markets.push(row);
}
assert.equal(markets.length, 47); assert.equal(lattice.markets.length, 47);
// Exact cycle-4 control, NOT a deployment fixture.
const control = measure(1500n, 1000001n, 38729n, 1500000000000000007n, 10n * W, Y, 2n * W, 'CYCLE4_SYNTHETIC_CONTROL');
assert.equal(control.absDiff, priorWorst);
assert.equal(exp18(W), 2718281828459045235n); assert.equal(ln18(2n * W), 693147180559945309n);
assert.equal(div(-1n, 3n * W), 0n);
const sum = key => markets.reduce((v, m) => v + m[key], 0n);
const summary = {
  markets: 47, chains: { ethereum: 40, base: 7 },
  storedOracleRateUnitDustBoundedMarkets: markets.filter(m => m.storedOracle.absDiff <= 10n).length,
  storedOracleDustBoundedMarkets: markets.filter(m => m.storedOracle.lpAdjustedCeil <= 10n).length,
  storedOracleMaxRawRateResidual: markets.reduce((v, m) => max(v, m.storedOracle.absDiff), 0n),
  storedOracleMaxLpAdjustedCeil: markets.reduce((v, m) => max(v, m.storedOracle.lpAdjustedCeil), 0n),
  sixDecimalPtAssetMarkets: markets.filter(m => m.assetDecimals === 6).length,
  snapshotDustBoundedMarkets: markets.filter(m => m.snapshotDustBounded).length,
  snapshotAboveDustMarkets: markets.filter(m => m.snapshotDustBounded === false).map(m => m.market),
  snapshotRecomputeUnknownMarkets: markets.filter(m => m.snapshotDustBounded === null).map(m => m.market),
  measuredLatticeDustBoundedMarkets: markets.filter(m => m.maxLpAdjustedCeil <= 10n).length,
  completeLatticeDustBoundedMarkets: markets.filter(m => m.latticeComplete && m.maxLpAdjustedCeil <= 10n).length,
  sameOrderAsCycle4Markets: markets.filter(m => m.sameOrderAsCycle4).map(m => ({ chainId: m.chainId, market: m.market })),
  atLeastCycle4OrderMarkets: markets.filter(m => m.atLeastCycle4Order).map(m => ({ chainId: m.chainId, market: m.market })),
  incompleteLattices: markets.filter(m => !m.latticeComplete).map(m => m.market),
  lockedOnlyMarkets: markets.filter(m => m.lockedOnly).map(m => m.market),
  expiredMarkets: markets.filter(m => m.timeToExpiry === 0n).length,
  maxRawRateResidual: markets.reduce((v, m) => max(v, m.maxRawRateResidual), 0n),
  maxLpAdjustedCeil: markets.reduce((v, m) => max(v, m.maxLpAdjustedCeil), 0n),
  diagnosticSumOfPerMarketMaxima: sum('maxLpAdjustedCeil'),
  sumMeaning: 'Sum of separately rounded per-market maxima in unlike underlying assets: arithmetic test checksum ONLY; not monetary value or additive economic loss.',
};
// Generate mock-only source-library regression fixtures, not market deployments.
// Independent reference floors are frozen JS 72/96-digit results; Solidity tests
// validate the mirror against actual imported LogExpMath/PMath and a Solidity
// copy of just the requested core substeps, not the reference or full market.
const checks = markets.flatMap((m, marketId) => [m.snapshotRecompute, ...m.smallReserveRows]
  .filter(r => r?.status === 'MEASURED').map(r => ({ ...r, marketId,
    snapshot: r.kind === 'SNAPSHOT_RESERVES_INFERRED_ANCHOR' })));
const fixtureCases = checks.map((r, i) => `        if (i == ${i}) return Check(${r.sy}, ${r.pt}, ${r.lp}, ${r.index}, ${r.scalarRoot}, ${r.timeToExpiry}, ${r.anchor}, ${r.sourceSteps.rate}, ${r.idealRate}, ${r.assetScale}, ${r.marketId}, ${r.snapshot});`).join('\n');
const oracleCases = markets.map((m, i) => `        if (i == ${i}) return OracleCheck(${m.lastLnImpliedRate}, ${m.timeToExpiry}, ${m.totalPt}, ${m.totalLpSupply}, ${m.storedOracle.sourceRate}, ${m.storedOracle.idealRate}, ${10n ** BigInt(m.assetDecimals)});`).join('\n');
const testSource = `// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import "pendle/core/libraries/math/LogExpMath.sol";
import "pendle/core/libraries/math/PMath.sol";

// GENERATED by tools/sim-pendle-v7-cycle5-per-market.js. Offline saved-state
// fixtures and synthetic sensitivities ONLY. No vm, RPC, tokens, pools or writes.
// References: independent 72/96-digit JS floors, not formal real-number proofs.
contract Cycle5PerMarketSanityTest {
    uint256 constant W = 1e18;
    uint256 constant Y = 365 days;
    uint256 constant N = ${checks.length};
    struct Check { uint256 sy; uint256 pt; uint256 lp; uint256 index; uint256 scalarRoot; uint256 t; int256 anchor; uint256 sourceRate; uint256 ideal; uint256 assetScale; uint256 marketId; bool snapshot; }
    struct OracleCheck { uint256 lnRate; uint256 t; uint256 pt; uint256 lp; uint256 sourceRate; uint256 ideal; uint256 assetScale; }
    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) { return a > b ? a-b : b-a; }
    function _ceil(uint256 a, uint256 b) internal pure returns (uint256) { return (a+b-1)/b; }
    function _fromLn(uint256 lnRate, uint256 t) internal pure returns (uint256) {
        // MarketMathCore:321-323 and PendlePYOracleLib:73-74.
        return W*W/uint256(LogExpMath.exp(int256(lnRate*t/Y)));
    }
    function _rate(Check memory c) internal pure returns (uint256) {
        // Pure copy of MarketMathCore:335-353,309-311,356-358. This is NOT
        // whole MarketMathCore compilation or a deployed-market integration.
        int256 totalAsset = int256(c.sy*c.index/W);
        int256 proportion = PMath.divDown(int256(c.pt),int256(c.pt)+totalAsset);
        require(proportion <= 96e16,"proportion guard");
        int256 logit = PMath.divDown(proportion,int256(W)-proportion);
        int256 scalar = int256(c.scalarRoot*Y/c.t);
        int256 exchange = PMath.divDown(LogExpMath.ln(logit),scalar)+c.anchor;
        require(exchange >= int256(W),"exchange guard");
        uint256 lnRate = uint256(LogExpMath.ln(exchange))*Y/c.t;
        require(lnRate < 2**96,"storage range");
        return _fromLn(lnRate,c.t);
    }
    function _fixture(uint256 i) internal pure returns (Check memory) {
${fixtureCases}
        revert("fixture range");
    }
    function _oracleFixture(uint256 i) internal pure returns (OracleCheck memory) {
${oracleCases}
        revert("oracle fixture range");
    }
    function test_Cycle4ControlExpectedScale() public pure {
        Check memory c = Check(1000001,1500,38729,1500000000000000007,1e19,Y,2e18,763810998212818931,763811017659711208,1e18,0,false);
        uint256 actual = _rate(c);
        require(actual == c.sourceRate,"cycle4 source mismatch");
        require(actual < c.ideal,"signed direction");
        require(_absDiff(actual,c.ideal) == 19446892277,"cycle4 residual");
    }
    function test_AllSavedReserveFixturesMatchSolidityMirror() public pure {
        uint256 count;
        for (uint256 i; i<N; ++i) {
            Check memory c = _fixture(i);
            if (!c.snapshot) continue;
            require(_rate(c) == c.sourceRate,"saved reserve source mismatch");
            ++count;
        }
        require(count == ${checks.filter(r => r.snapshot).length},"saved fixture count");
    }
    function test_AllSyntheticSmallReserveFixturesMatchSolidityMirror() public pure {
        uint256 count;
        bool fingerprint;
        for (uint256 i; i<N; ++i) {
            Check memory c = _fixture(i);
            if (c.snapshot) continue;
            uint256 actual = _rate(c);
            require(actual == c.sourceRate,"synthetic source mismatch");
            uint256 d = _absDiff(actual,c.ideal);
            if (d*10 >= 19446892277 && d <= 194468922770) fingerprint = true;
            require(c.lp > 1000,"scaled locked LP");
            ++count;
        }
        require(count == ${checks.filter(r => !r.snapshot).length} && fingerprint,"small fixture coverage");
    }
    function test_All47SavedRawSpotRateResidualsBounded() public pure {
        for (uint256 i; i<47; ++i) {
            OracleCheck memory c = _oracleFixture(i);
            uint256 actual = c.t == 0 ? W : _fromLn(c.lnRate,c.t);
            require(actual == c.sourceRate,"stored oracle mismatch");
            uint256 d = _absDiff(actual,c.ideal);
            require(d <= 2 && _ceil(d*c.pt,c.lp) <= 3,"stored raw oracle dust bound");
            require(_ceil(d*c.pt*W,c.lp*c.assetScale) <= ${summary.storedOracleMaxLpAdjustedCeil},"normalized per LP bound");
        }
    }
    function test_PerMarketResidualMagnitudesAndChecksumBounded() public pure {
        uint256[47] memory maxima;
        for (uint256 i; i<N; ++i) {
            Check memory c = _fixture(i);
            uint256 actual = _rate(c);
            uint256 d = _absDiff(actual,c.ideal);
            // Check magnitude reconstructs both signed directions; unsigned >=0 alone is vacuous.
            require(actual >= c.ideal ? c.ideal+d == actual : actual+d == c.ideal,"magnitude direction");
            uint256 adjusted = _ceil(d*c.pt*W,c.lp*c.assetScale);
            require(adjusted*c.lp*c.assetScale >= d*c.pt*W,"ceiling lower bound");
            require(adjusted == 0 || (adjusted-1)*c.lp*c.assetScale < d*c.pt*W,"ceiling upper bound");
            require(d <= ${summary.maxRawRateResidual} && adjusted <= ${summary.maxLpAdjustedCeil},"grid bound");
            if (adjusted > maxima[c.marketId]) maxima[c.marketId] = adjusted;
        }
        uint256 sum;
        for (uint256 i; i<47; ++i) {
            OracleCheck memory c = _oracleFixture(i);
            uint256 d = _ceil(_absDiff(c.sourceRate,c.ideal)*c.pt*W,c.lp*c.assetScale);
            sum += d > maxima[i] ? d : maxima[i];
        }
        // Arithmetic checksum across unlike assets, NOT money, loss or profitability.
        require(sum == ${summary.diagnosticSumOfPerMarketMaxima},"per-market checksum");
    }
}
`;
const testPath = 'exploits/pendle-v7/test/Cycle5PerMarketSanity.t.sol';
fs.mkdirSync(path.join(ROOT, 'exploits/pendle-v7/test'), { recursive: true });
fs.writeFileSync(path.join(ROOT, testPath), testSource);
const generatedAt = new Date().toISOString();
const result = { schema: 'pendle-v7-cycle5-per-market/v1', signal: 'DEFENSIVE_RESIDUAL_CHARACTERIZATION_NOT_PROMOTED',
  generatedAt, nodeVersion: process.version, simulatorSha256: sha(read('tools/sim-pendle-v7-cycle5-per-market.js')),
  inputManifest, sourceManifest,
  sourceCommit: 'e8c2cca4c9b329ba8a383a27d7318e5f8b35c843', sourceTree: '03ad7e203832bbdb7ea944b260092c4626339b99',
  mockTest: { file: testPath, sha256: sha(read(testPath)), measuredFixtures: checks.length,
    referenceStatus: 'Frozen JS independent floors; actual public LogExpMath/PMath plus a Solidity copy of core substeps validate the BigInt mirror. Full MarketMathCore not compiled (unavailable OpenZeppelin dependency). Forge execution is recorded separately in handoff.' },
  freshness: { scannedAt: snapshot.scannedAt, ageSeconds: (BigInt(Date.parse(generatedAt)) - BigInt(Date.parse(snapshot.scannedAt))) / 1000n,
    status: 'STALE_SNAPSHOT_NOT_REFRESHED', note: 'User described artifact as four days old; exact timestamps retained. Not current-chain evidence.' },
  execution: { offline: true, rpcCalls: 0, targetWrites: 0, signedAction: false, broadcast: false, poolMutations: 0 },
  gates: { routePositive: 'unknown', routeDisposition: 'UNKNOWN', executableNow: 'unknown', signedActionJustified: false,
    deploymentDisposition: 'ARTIFACT_ONLY_RUNTIME_UNBOUND', accessDisposition: 'OFFLINE-ONLY' },
  evidence: { localSemantic: 'PASS/supports: BigInt mirror with converged independent floors',
    reachability: 'UNKNOWN: synthetic sensitivities are not on-chain depletion or initialization reachability',
    economics: 'N/A: expressly excluded, no profitability or loss analysis',
    reproducibility: 'node tools/sim-pendle-v7-cycle5-per-market.js' },
  limitations: ['47 detailed records, NOT all 51 enumerated markets; four Ethereum detail rows absent.',
    'No runtime equivalence verified. Factory version observations do not bind each market bytecode.',
    'Stored spot ln rate tested; actual 900-second TWAP observations/consumer behavior not captured.',
    'Effective anchor reconstructed, not observed immutable initialAnchor. Scaling reserves and LP is synthetic, not an executable withdrawal.',
    'LP-adjusted means ceil(abs(rate difference)*rawPT*1e18/(rawLP*10^assetDecimals)), PT-value contribution per whole 18-decimal LP at 1e18 precision only; not the actual LP oracle or token payout. Raw-unit counterpart retained separately.',
    'Finite grid and 72/96-digit agreement are not a formal global error proof. Signed differences may be negative; magnitudes are nonnegative.',
    'Locked-only LP inventory is labeled and cannot be treated as user-redeemable liquidity.'],
  grid, cycle4Control: control, summary, markets,
  conclusion: 'No automatic WARM closure or HOT promotion: retain separate snapshot and synthetic-scale observations. this work does NOT establish profitability on any market; the residual scale is recorded for defensive characterization only.' };
for (const m of [...inputManifest, ...sourceManifest]) assert.equal(sha(read(m.file)), m.sha256, 'input changed during run');
const json = x => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
fs.writeFileSync(path.join(ROOT, BASE + 'pendle-v7-cycle5-per-market-results.json'), json(result) + '\n');
const lines = ['# Pendle V7 cycle-5 — defensive per-market rounding sanity check', '',
  'Signal: **DEFENSIVE_RESIDUAL_CHARACTERIZATION_NOT_PROMOTED**', '',
  `Generated ${generatedAt}; snapshot scanned ${snapshot.scannedAt} (age ${result.freshness.ageSeconds} seconds).`,
  'The supplied “four days old” artifact is stale; no refresh or RPC was performed. Pins and hashes are retained per market.', '',
  '## Outcome', '',
  `- **${summary.storedOracleRateUnitDustBoundedMarkets}/47 saved raw spot-oracle calculations are raw-rate dust-bounded**: max ${summary.storedOracleMaxRawRateResidual} rate units. After decimal-aware per-whole-LP normalization, ${summary.storedOracleDustBoundedMarkets}/47 are <=10, max ${summary.storedOracleMaxLpAdjustedCeil}. A rate unit and normalized value per LP are NOT interchangeable.`,
  `- ${summary.snapshotDustBoundedMarkets}/47 snapshot rows are <=10 LP-adjusted units in both stored-oracle and reserve-recompute diagnostics.`,
  `- ${summary.snapshotAboveDustMarkets.length} saved reserve/oracle LP-adjusted diagnostics exceed dust (eight six-decimal asset records plus two locked-only inventories); ${summary.snapshotRecomputeUnknownMarkets.length} cannot recompute because the floored asset reserve is zero / proportion guard fails. Unknown is NOT dust or an observed oracle failure.`,
  `- ${summary.measuredLatticeDustBoundedMarkets}/47 markets are <=10 across all **measured** sensitivity rows; ${summary.incompleteLattices.length} lattices have explicit skips.`,
  `- Only ${summary.completeLatticeDustBoundedMarkets}/47 have complete, fully dust-bounded lattices (including the exact expired branch); “measured rows dust” does not close skipped rows.`,
  `- ${summary.sameOrderAsCycle4Markets.length} markets have a measured row within factor ten of cycle-4’s 19,446,892,277 raw rate units; ${summary.atLeastCycle4OrderMarkets.length} have that order **or larger**.`,
  `- Maximum raw-rate residual ${summary.maxRawRateResidual}; maximum PT-only LP-adjusted ceiling ${summary.maxLpAdjustedCeil}.`,
  `- ${summary.lockedOnlyMarkets.length} inventories contain only the 1,000 locked LP; ${summary.expiredMarkets} market uses the exact expired raw-oracle branch.`,
  '- The all-47 <=10 closure condition is not presumed. No global classification or gates changed.', '',
  '## Invariant / scope', '',
  'Actor is an offline analyst; inputs are the saved historical observations and explicitly labeled synthetic rows. No public actor strategy or state transition is constructed. Preconditions: positive reserves/supply, selected index, unexpired time, scalar >0, source proportion <=0.96, exchange >=1 and uint96 ln-rate range. The expired raw-oracle branch returns exactly 1e18.', '',
  'For magnitude D=abs(source-referenceFloor), record signed direction separately. For N=D*rawPT*1e18 and denominator Q=rawLP*10^assetDecimals, normalized ceiling C obeys C*Q >= N and C=0 or (C-1)*Q < N. Tests enforce both sides (not a vacuous unsigned nonnegative check). Sum of per-market maxima is a fixture checksum only, never aggregate monetary impact. Pure local computations have no pool state, callbacks, external observations or rollback effects.', '',
  '## Method / source authority', '',
  '`MarketMathCore.sol:335-353` proportion/logit/log, `:309-323` annualization/exponent; `PendlePYOracleLib.sol:65-75` reciprocal and expired branch. `PendleMarketV7.sol:105-126` initializes only on first mint; burn `:142-158` calls removeLiquidity at `:151` and does NOT recompute an implied rate.', '',
  '1. Actual saved inputs: reserves, LP supply, scalarRoot, expiry, stored ln rate and index/cache policy. Compare raw spot oracle from stored ln to an independent continuous exponent at 72 and 96 decimals.',
  '2. Reconstruct effective anchor at saved reserves using `MarketMathCore.sol:273-293`; compare source reserve-to-implied-to-oracle math to the cycle-4 independent continuous reference with that **same integer anchor**. This is not an observed initialAnchor.',
  '3. Freeze index, scalarRoot, time and inferred anchor; downscale SY to min(observed, 1e6+1 / 1e12+1 / 1e18+1), floor PT and LP proportionally. These are synthetic ratio-preserving sensitivities, NOT observed small states, depletion simulations, or a path to them. Skip <=1,000 scaled LP, zero PT and source-invalid exchange branches explicitly.',
  '4. Raw residual = abs(source rate - reference floor), in 1e18-scaled asset/PT rate units. LP-adjusted = ceil(raw residual * rawPT * 1e18 / (rawLP * 10^assetDecimals)), a **PT-only value per whole LP at 1e18 precision**. LP decimals are 18 (`PendleMarketV7.sol:70`); nine PT/asset records are 6 decimals, so dropping that normalization would understate those diagnostics by 1e12. Raw-unit counterparts retained. This is NOT PendleLpOracleLib pricing or payout. No USD conversion, aggregation of asset values, amplification, repeated transactions or economics.',
  '5. Cycle-4 exact synthetic control still yields 19,446,892,277. Same-order means [worst/10, worst*10]; larger rows are not mislabeled same-order.', '',
  '## Per-market results', '',
  'Supply/reserves/expiry and every intermediate/skip are in JSON. Raw and adjusted columns below are maxima across measured saved-state recomputation and synthetic sensitivities (stored-oracle residual also included).', '',
  '| Chain | Market | Snapshot <=10 | Max raw rate | Max LP-adjusted ceil | Same order / >=order | Locked-only |',
  '|---|---|---|---:|---:|---|---|',
  ...markets.map(m => `| ${m.chainId} | ${m.market} | ${m.snapshotDustBounded} | ${m.maxRawRateResidual} | ${m.maxLpAdjustedCeil} | ${m.sameOrderAsCycle4} / ${m.atLeastCycle4Order} | ${m.lockedOnly} |`),
  '', '## Bounds / defensive disposition', '',
  'Only 47 detailed rows (40 Ethereum + 7 Base), not the 51 enumerated markets; four Ethereum details missing. Base enumeration is recent-anchor bounded. Labels/issuers and post-expiry first index remain absent; not needed for these raw arithmetic tests, but prevent asset-semantic/economic conclusions. Runtime/source equivalence and consumer/TWAP integration remain unproven. No loss impact or severity promoted.', '',
  'Full MarketMathCore compilation initially failed due to unavailable OpenZeppelin IERC20Metadata and an external import path. No dependencies installed or targets changed: the final mock imports the exact public LogExpMath/PMath and copies only the cited core substeps into a pure Solidity mirror. Thus the tests do NOT establish full-market compilation, deployment identity or integration equivalence. Harness uses cached solc 0.8.28, optimizer 200, Cancun and a test-only enlarged code-size limit for fixtures.', '',
  'Keep stored-oracle, snapshot recomputation and synthetic sensitivities separate when reviewing watch-list measurements. A large synthetic rate residual is not a measured deviation of the deployed oracle at the saved state. Locked-only reserves do not demonstrate usable liquidity. Do not generalize a finite lattice to all states.', '',
  'Defensive regression: preserve exact input/hash fixtures, test signed truncation and LP ceiling bounds, and compare source Solidity outputs against the BigInt model. No production arithmetic change is justified by magnitude alone. Any further market/consumer investigation requires separate owner authorization.', '',
  `Reproduce: \`node --check tools/sim-pendle-v7-cycle5-per-market.js\`; \`node tools/sim-pendle-v7-cycle5-per-market.js\`. Script also generates ${checks.length} source-math fixture rows plus 47 stored-oracle fixtures in \`${testPath}\`. Mock Solidity validation is recorded separately in the handoff; this script does not execute Forge.`, '',
  '**this work does NOT establish profitability on any market; the residual scale is recorded for defensive characterization only.**', ''];
fs.writeFileSync(path.join(ROOT, BASE + 'pendle-v7-cycle5-per-market-summary.md'), lines.join('\n'));
console.log(json(summary));
console.log('All BigInt assertions passed. No network, target writes, pool mutations, signing or broadcast.');
