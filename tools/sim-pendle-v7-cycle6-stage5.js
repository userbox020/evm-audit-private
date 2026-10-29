#!/usr/bin/env node
'use strict';
// Defensive OFFLINE verifier. No RPC, env/key reads, signing, fork or target writes.
// Missing fresh capture or prices is UNKNOWN, never an economic-negative result.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'reports/raw/fast/novelty-rerank-20261017/';
const TARGET = 'targets/pendle-core-v2-e8c2cca4/';
const SNAP = 'reports/raw/fast/pendle-l.json';
const W = 10n ** 18n, Y = 365n * 86400n, THRESHOLD = 10n;
const abs = x => x < 0n ? -x : x;
const max = (a, b) => a > b ? a : b;
const min = (a, b) => a < b ? a : b;
const ceil = (a, b) => { assert(a >= 0n && b > 0n); return (a + b - 1n) / b; };
const div = (a, b) => a * W / b; // Solidity truncates signed divisions toward zero.
const read = f => fs.readFileSync(path.join(ROOT, f));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const json = x => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const write = (p, x) => fs.writeFileSync(path.join(ROOT, p), typeof x === 'string' ? x : json(x) + '\n');
const snapshotBytes = read(SNAP), snapshot = JSON.parse(snapshotBytes);
const cycle5 = JSON.parse(read(BASE + 'pendle-v7-cycle5-per-market-results.json'));
const lattice = JSON.parse(read(BASE + 'A04-stage4-lattice.json'));
const sourceManifest = cycle5.sourceManifest.map(m => {
  assert.equal(sha(read(m.file)), m.sha256, 'source drift: ' + m.file); return m;
});
const inputPaths = [SNAP, BASE + 'pendle-v7-cycle5-per-market-results.json',
  BASE + 'A04-stage4-lattice.json', 'tools/sim-pendle-v7-cycle5-per-market.js',
  'tools/scan-pendle-l.js', 'tools/shared-rpc.js'];
const inputManifest = inputPaths.map(file => ({ file, sha256: sha(read(file)) }));
const priorWorst = 19446892277n;
const logText = read(TARGET + 'contracts/core/libraries/math/LogExpMath.sol').toString();
const constant = name => {
  const m = logText.match(new RegExp('int256 constant ' + name + ' = ([0-9_]+);'));
  assert(m); return BigInt(m[1].replaceAll('_', ''));
};
const X = [], A = [];
for (let i = 0; i <= 11; i++) { X.push(constant('x' + i)); A.push(constant('a' + i)); }
const W20 = 10n ** 20n, W36 = W * W;
function exp18(x) {
  assert(x >= -41n * W && x <= 130n * W);
  if (x < 0n) return W * W / exp18(-x);
  let first = 1n;
  if (x >= X[0]) { x -= X[0]; first = A[0]; }
  else if (x >= X[1]) { x -= X[1]; first = A[1]; }
  x *= 100n;
  let product = W20;
  for (let i = 2; i <= 9; i++) if (x >= X[i]) { x -= X[i]; product = product * A[i] / W20; }
  let term = x, sum = W20 + x;
  for (let n = 2n; n <= 12n; n++) { term = term * x / W20 / n; sum += term; }
  return product * sum / W20 * first / 100n;
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
  assert(a > 0n);
  return a > W - W / 10n && a < W + W / 10n ? lnSeries(a * W, W36, 15n) / W : lnBase(a);
}
function reference(digits) {
  const S = 10n ** digits;
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
    assert(a > 0n); let k = 0n;
    while (a >= 2n * S) { a /= 2n; k++; }
    while (a < S) { a *= 2n; k--; }
    return seriesLn(a) + k * ln2;
  }
  function exp(a) {
    if (a < 0n) return S * S / exp(-a);
    let k = 0n;
    while (a > S / 8n) { a /= 2n; k++; }
    let term = S, sum = S;
    for (let n = 1n; n < 2001n; n++) {
      term = term * a / S / n; sum += term;
      if (term === 0n) break;
      assert(n !== 2000n);
    }
    while (k-- > 0n) sum = sum * sum / S;
    return sum;
  }
  return { S, ln, exp };
}
const ref72 = reference(72n), ref96 = reference(96n);
function sourceRate(pt, sy, index, scalarRoot, t, anchor) {
  const totalAsset = sy * index / W, scalar = scalarRoot * Y / t;
  assert(totalAsset > 0n && scalar > 0n && pt > 0n);
  const p = div(pt, pt + totalAsset);
  assert(p > 0n && p <= 96n * W / 100n);
  const exchange = div(ln18(div(p, W - p)), scalar) + anchor;
  if (exchange < W) return null;
  const lnImplied = ln18(exchange) * Y / t;
  assert(lnImplied >= 0n && lnImplied < (1n << 96n));
  return W * W / exp18(lnImplied * t / Y);
}
function continuous(r, pt, sy, index, scalarRoot, t, anchor) {
  const { S } = r, totalAsset = sy * index * S / W;
  const p = pt * S * S / (pt * S + totalAsset);
  const scalar = scalarRoot * Y * S / (t * W);
  const exchange = r.ln(p * S / (S - p)) * S / scalar + anchor * S / W;
  assert(exchange > 0n);
  return W * S / r.exp(r.ln(exchange) * Y / t * t / Y);
}
function measure(pt, sy, lp, index, scalarRoot, t, anchor, assetDecimals, kind) {
  const totalAsset = sy * index / W, p = div(pt, pt + totalAsset);
  const base = { pt, sy, lp, index, scalarRoot, t, anchor, assetDecimals, kind };
  if (totalAsset <= 0n || p <= 0n || p > 96n * W / 100n)
    return { ...base, status: 'SKIPPED_ASSET_OR_PROPORTION_GUARD' };
  const actual = sourceRate(pt, sy, index, scalarRoot, t, anchor);
  if (actual === null) return { ...base, status: 'EXCHANGE_BELOW_ONE' };
  const ideal = continuous(ref72, pt, sy, index, scalarRoot, t, anchor);
  assert.equal(ideal, continuous(ref96, pt, sy, index, scalarRoot, t, anchor));
  const signedDiff = actual - ideal, absDiff = abs(signedDiff), assetScale = 10n ** assetDecimals;
  const adjusted = ceil(absDiff * pt * W, lp * assetScale);
  return { ...base, status: 'MEASURED', sourceRate: actual, idealRate: ideal, signedDiff, absDiff,
    assetScale, lpAdjustedWeiResidual: adjusted,
    fingerprintRetained: absDiff * 10n >= priorWorst && absDiff <= priorWorst * 10n };
}
function model(c, m) {
  const sy = BigInt(m.totalSyRaw), pt = BigInt(m.totalPtRaw), lp = BigInt(m.totalLpRaw);
  assert(sy > 0n && pt > 0n && lp > 0n);
  const stored = BigInt(m.pyIndexStoredRaw), exchange = BigInt(m.syExchangeRateRaw);
  const cached = m.doCacheIndexSameBlock && BigInt(m.pyIndexLastUpdatedBlock) === BigInt(c.pin.number);
  const index = cached ? stored : max(stored, exchange), scalarRoot = BigInt(m.scalarRootRaw);
  const ln = BigInt(m.lastLnImpliedRateRaw), assetDecimals = BigInt(m.assetDecimals);
  assert.equal(BigInt(m.ptDecimals), assetDecimals);
  const expiry = BigInt(m.expiry), blockTime = BigInt(Date.parse(c.pin.timestamp)) / 1000n;
  const t = max(0n, expiry - blockTime), assetScale = 10n ** assetDecimals;
  const oracleRate = t === 0n ? W : W * W / exp18(ln * t / Y);
  const oracleRef = r => t === 0n ? W : W * r.S / r.exp(ln * t * r.S / (Y * W));
  const ideal = oracleRef(ref72); assert.equal(ideal, oracleRef(ref96));
  const oracleDiff = abs(oracleRate - ideal);
  const storedOracle = { sourceRate: oracleRate, idealRate: ideal, absDiff: oracleDiff,
    lpAdjustedWeiResidual: ceil(oracleDiff * pt * W, lp * assetScale) };
  const rows = [];
  if (t > 0n) {
    const totalAsset = sy * index / W, scalar = scalarRoot * Y / t, p = div(pt, pt + totalAsset);
    if (totalAsset <= 0n || p <= 0n || p > 96n * W / 100n)
      rows.push({ kind: 'SAVED_RESERVES', status: 'SKIPPED_ASSET_OR_PROPORTION_GUARD' });
    else {
      const anchor = exp18(ln * t / Y) - div(ln18(div(p, W - p)), scalar);
      rows.push(measure(pt, sy, lp, index, scalarRoot, t, anchor, assetDecimals, 'SAVED_RESERVES'));
      for (const target of [1000001n, 1000000000001n, W + 1n]) {
        const smallSy = min(target, sy), smallPt = pt * smallSy / sy, smallLp = lp * smallSy / sy;
        if (smallSy === sy) continue;
        if (smallLp <= 1000n || smallPt === 0n)
          rows.push({ kind: 'SYNTHETIC_RATIO_PRESERVING', target, status: 'SKIPPED_LOCKED_LP_OR_ZERO_PT' });
        else rows.push(measure(smallPt, smallSy, smallLp, index, scalarRoot, t, anchor,
          assetDecimals, 'SYNTHETIC_RATIO_PRESERVING'));
      }
    }
  }
  const measured = rows.filter(r => r.status === 'MEASURED');
  const snapshotMax = max(storedOracle.lpAdjustedWeiResidual,
    rows[0]?.status === 'MEASURED' ? rows[0].lpAdjustedWeiResidual : 0n);
  return { selectedIndex: index, storedOracle, rows, totalSy: sy, totalPt: pt, totalLP: lp,
    lockedOnly: lp === 1000n, expired: t === 0n,
    calcMaxRateUnits: measured.reduce((v, r) => max(v, r.absDiff), oracleDiff),
    lpAdjustedWeiResidual: snapshotMax,
    aboveThreshold: t > 0n && rows[0]?.status !== 'MEASURED' ? null : snapshotMax > THRESHOLD,
    gridMaxLpAdjustedWeiResidual: measured.reduce((v, r) => max(v, r.lpAdjustedWeiResidual), storedOracle.lpAdjustedWeiResidual),
    fingerprintRetained: measured.some(r => r.fingerprintRetained),
    latticeComplete: rows.every(r => r.status === 'MEASURED') };
}
// USD functions use 1e18 USD; caller must provide a positive, validated price.
// These functions do NOT supply/assume any token's price or a swap realization.
function usd(rawAsset, assetDecimals, priceUsd18) {
  assert(rawAsset >= 0n && priceUsd18 > 0n); return rawAsset * priceUsd18 / 10n ** assetDecimals;
}
function tvlEstimate(totalSy, totalPt, syIndex, ptRate, decimals, priceUsd18) {
  const reserve0USD = usd(totalSy * syIndex / W, decimals, priceUsd18);
  const reserve1USD = usd(totalPt * ptRate / W, decimals, priceUsd18);
  return { reserve0USD, reserve1USD, tvlUSD: reserve0USD + reserve1USD };
}
function freshAt(iso, now, maxAgeMs) {
  const parsed = Date.parse(iso); return Number.isFinite(parsed) && now >= parsed && now - parsed <= maxAgeMs;
}
function main() {
  const generatedAt = new Date().toISOString(), now = Date.parse(generatedAt);
  const freshArtifact = freshAt(snapshot.scannedAt, now, 30 * 60000) && snapshot.chains.every(c =>
    freshAt(c.pin?.timestamp, now, 60 * 60000) && /^0x[0-9a-f]{64}$/i.test(c.pin?.hash || ''));
  // This offline invocation cannot attest that a scanner ran, bind a finalized
  // header, or verify its hash live. Do not admit current-chain findings here.
  const captureStatus = 'BLOCKED_METHOD_SCOPE_CONFLICT';
  const blocker = 'Unmodified scan-pendle-l.js requires eth_chainId, eth_getBlockByNumber, eth_getCode, eth_getStorageAt and eth_getLogs; current user hard constraint permits eth_call only. No scanner/RPC run.';
  const watch = cycle5.markets.filter(m => m.snapshotDustBounded === false);
  assert.equal(watch.length, 10); assert.equal(lattice.markets.length, 47);
  const observed = new Map(snapshot.chains.flatMap(c => c.markets.map(m => [`${c.chainId}:${m.market}`, { c, m }])));
  const markets = lattice.markets.map(old => {
    const hit = observed.get(`${old.chainId}:${old.marketAddress}`);
    const regression = hit ? model(hit.c, hit.m) : null;
    // Current fields deliberately null: stale regression is never promoted.
    return { chainId: old.chainId, marketAddress: old.marketAddress, pin: null,
      calcMaxRateUnits: null, lpAdjustedWeiResidual: null, threshold: THRESHOLD,
      aboveThreshold: null, fingerprintRetained: null, stage2Status: 'INCOMPLETE_DATA',
      routePositive: 'unknown', executableNow: 'unknown', signedActionJustified: false,
      historicalOnly: hit ? { pin: hit.c.pin, scannedAt: snapshot.scannedAt, ...regression } : null };
  });
  const stage5 = watch.map(w => {
    const hit = observed.get(`${w.chainId}:${w.market}`);
    return { chainId: w.chainId, marketAddress: w.market,
      assetAddressHistorical: hit?.m.asset ?? null, assetDecimalsHistorical: hit?.m.assetDecimals ?? null,
      assetIdentityStatus: 'HISTORICAL_SY_ASSETINFO_ONLY_NOT_REFRESHED',
      stage5Status: 'INCOMPLETE_DATA', usdQuote: null, reserve0USD: null, reserve1USD: null, tvlEstimateUSD: null,
      reasons: ['FRESH_FINALIZED_PIN_UNAVAILABLE', 'NO_FRESH_IDENTITY_BOUND_UNDERLYING_USD_FEED',
        'NO_ACTUAL_ROUNDTRIP_SWAP_PATH_BOUND', 'ACTUAL_PATH_GAS_UNAVAILABLE_ETH_CALL_ONLY'],
      sizes: [1000n, 10000n, 50000n].map(inputUSD => ({ inputUSD,
        quoteOutUSD: null, feeTotalUSD: null, gasUnits: null, gasUSD: null, netUSD: null,
        routePositive: 'unknown', executableNow: 'unknown', signedActionJustified: false })) };
  });
  // Independent known answers and stale/future-time fail-closed regressions.
  const control = measure(1500n, 1000001n, 38729n, 1500000000000000007n, 10n * W, Y, 2n * W, 18n, 'SYNTHETIC_CONTROL');
  assert.equal(control.absDiff, priorWorst);
  assert.equal(exp18(W), 2718281828459045235n); assert.equal(ln18(2n * W), 693147180559945309n);
  assert.equal(div(-1n, 3n * W), 0n);
  assert(!freshAt('invalid', now, 1)); assert(!freshAt(new Date(now + 1).toISOString(), now, 1000));
  assert(!freshAt(new Date(now - 1001).toISOString(), now, 1000));
  const mockTvl = tvlEstimate(2n * W, 3n * 10n ** 6n, 10n ** 6n, W, 6n, 2n * W);
  assert.equal(mockTvl.tvlUSD, 10n * W); // Synthetic $2 price, not any market.
  const sameHistoricalInput = sha(snapshotBytes) === cycle5.inputManifest.find(x => x.file === SNAP).sha256;
  if (sameHistoricalInput) for (const m of markets) {
    const prior = cycle5.markets.find(p => p.chainId === m.chainId && p.market === m.marketAddress);
    assert.equal(m.historicalOnly.calcMaxRateUnits.toString(), prior.maxRawRateResidual);
    assert.equal(m.historicalOnly.gridMaxLpAdjustedWeiResidual.toString(), prior.maxLpAdjustedCeil);
    assert.equal(m.historicalOnly.aboveThreshold, prior.snapshotDustBounded === null ? null : !prior.snapshotDustBounded);
  }
  const checks = markets.flatMap((m, marketId) => (m.historicalOnly?.rows ?? [])
    .filter(r => r.status === 'MEASURED').map(r => ({ ...r, marketId })));
  const testPath = 'exploits/pendle-v7/test/Cycle6PerMarketSanity.t.sol';
  const testSource = solidity(checks, control, mockTvl.tvlUSD);
  write(testPath, testSource);
  const safety = { rpcCalls: 0, scannerRun: false, inventoryReads: 0, envReads: 0, walletKeyReads: 0,
    signing: false, broadcast: false, fork: false, targetWrites: 0 };
  const gates = { routePositive: 'unknown', routeDisposition: 'UNKNOWN', executableNow: 'unknown',
    signedActionJustified: false, authorizationState: 'ABSENT', executionHold: 'pending-owner-batch-envelope' };
  const disclosure = ['This is a defensive sanity check, not an exploit-development path.',
    'This work does NOT establish profitability on any market; the residual scale is recorded for defensive characterization only. Stage-5 USD economics are bound to fresh, observed on-chain prices; the workspace makes no synthetic economic claim.'];
  const result = { schema: 'pendle-v7-cycle6-per-market/v1', signal: 'INCOMPLETE_DATA_NO_PROMOTION',
    generatedAt, captureStatus, blocker, beforeSha256: sha(snapshotBytes), afterSha256: sha(read(SNAP)),
    refreshed: false, freshFinalizedPin: null, inputManifest, sourceManifest,
    simulatorSha256: sha(read('tools/sim-pendle-v7-cycle6-stage5.js')),
    freshness: { scannedAt: snapshot.scannedAt, ageSeconds: BigInt(Math.floor((now - Date.parse(snapshot.scannedAt)) / 1000)),
      maxArtifactAgeSeconds: 1800, maxPinAgeSeconds: 3600, status: freshArtifact ? 'RECENT_ARTIFACT_NOT_LIVE_REVALIDATED' : 'STALE_REJECTED' },
    thresholds: { value: THRESHOLD, unit: 'PT-only value per whole 18-decimal LP, 1e18 underlying-asset precision',
      aboveThresholdConvention: 'cycle5 snapshot combined stored-oracle/reserve-recompute; NOT grid maximum',
      calcMaxRateUnitsConvention: 'maximum across stored oracle, reserve recompute and measured synthetic rows' },
    summary: { markets: markets.length, freshMeasuredMarkets: 0, watchListMarkets: stage5.length,
      stage5IncompleteMarkets: stage5.length, sizesUnknown: stage5.length * 3,
      historicalControlRateUnits: control.absDiff, historicalRegressionMatchesCycle5: sameHistoricalInput },
    evidence: { localSemantic: 'PASS/supports historical model only; Solidity execution reported separately',
      reachability: 'UNKNOWN', economics: 'BLOCKED/inconclusive', deployment: 'UNBOUND',
      provenance: 'Historical provider-attested saved artifact, no new chain observation' },
    safety, gates, mockTest: { file: testPath, sha256: sha(read(testPath)), fixtureProvenance: 'HISTORICAL_AND_SYNTHETIC_ONLY', fixtures: checks.length },
    markets, stage5, cycle6Verdict: 'INCOMPLETE_DATA_WATCH_LIST_PERSISTS_NO_FRESH_ECONOMIC_VERDICT',
    cycle7Recommendation: 'Owner clarifies read-method envelope first. Then separately bounded finalized capture, asset/feed identity and freshness, actual swap-path and gas evidence; no trigger or deployment implied.',
    limitations: ['No cycle6 current-state table, USD quote, TVL, swap output, fee or gas/net claim is established.',
      'Candidate (a) is a rate diagnostic, not a swap quote or payout; no quoteOut can be derived from residual alone.',
      'PendlePYOracleLib:65-75 gives a raw reciprocal rate, not asset identity; identity comes from SY.assetInfo plus deployment/feed binding.',
      'Native ETH/USD does not price an arbitrary USD-denominated, receipt or yield-bearing underlying.',
      'eth_estimateGas is outside eth_call-only authority; eth_call output is not an actual-path gas estimate.',
      'Historical sensitivity downscales are synthetic, not observed depletion or public-actor reachability.',
      'No all-market WARM closure and no economic-positive promotion follows from missing evidence.'], disclosure };
  for (const m of [...inputManifest, ...sourceManifest]) assert.equal(sha(read(m.file)), m.sha256, 'input drift');
  write(BASE + 'pendle-v7-cycle6-stage5-stage5-usd-raw.json', { schema: 'pendle-v7-cycle6-stage5-usd/v1',
    signal: result.signal, generatedAt, status: 'INCOMPLETE_DATA', pin: null, safety, gates, markets: stage5 });
  write(BASE + 'pendle-v7-cycle6-per-market-results.json', result);
  write(BASE + 'pendle-v7-cycle6-per-market-summary.md', markdown(result));
  console.log(json({ status: result.cycle6Verdict, ...result.summary, sha256: result.afterSha256 }));
}
function solidity(checks, control, expectedMockTvl) {
  return `// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import "pendle/core/libraries/math/LogExpMath.sol";
import "pendle/core/libraries/math/PMath.sol";
// Generated offline. HISTORICAL fixtures and synthetic controls, NOT cycle6
// chainstate, a swap, an oracle price observation or an integration test.
contract Cycle6PerMarketSanityTest {
    uint256 constant W = 1e18;
    uint256 constant Y = 365 days;
    struct Check { uint256 sy; uint256 pt; uint256 lp; uint256 index; uint256 scalar; uint256 t; int256 anchor; uint256 actual; uint256 ideal; uint256 assetScale; }
    function fixture(uint256 i) internal pure returns (Check memory) {
${checks.map((r, i) => `        if (i == ${i}) return Check(${r.sy},${r.pt},${r.lp},${r.index},${r.scalarRoot},${r.t},${r.anchor},${r.sourceRate},${r.idealRate},${r.assetScale});`).join('\n')}
        revert("fixture range");
    }
    function rate(Check memory c) internal pure returns (uint256) {
        int256 p = PMath.divDown(int256(c.pt), int256(c.pt+c.sy*c.index/W));
        require(p > 0 && p <= 96e16,"proportion");
        int256 e = PMath.divDown(LogExpMath.ln(PMath.divDown(p,int256(W)-p)),int256(c.scalar*Y/c.t))+c.anchor;
        require(e >= int256(W),"exchange");
        uint256 ln = uint256(LogExpMath.ln(e))*Y/c.t;
        require(ln < 2**96,"uint96");
        return W*W/uint256(LogExpMath.exp(int256(ln*c.t/Y)));
    }
    function diff(uint256 a,uint256 b) internal pure returns (uint256) { return a>b?a-b:b-a; }
    function test_Cycle4Control() public pure {
        Check memory c = Check(1000001,1500,38729,1500000000000000007,1e19,Y,2e18,${control.sourceRate},${control.idealRate},1e18);
        require(rate(c)==c.actual && diff(c.actual,c.ideal)==19446892277 && c.actual<c.ideal,"control");
    }
    function test_HistoricalSavedReserveMirror() public pure {
${checks.map((r, i) => r.kind === 'SAVED_RESERVES' ? `        require(rate(fixture(${i})) == fixture(${i}).actual,"saved");` : '').filter(Boolean).join('\n')}
    }
    function test_HistoricalSyntheticMirror() public pure {
${checks.map((r, i) => r.kind !== 'SAVED_RESERVES' ? `        require(rate(fixture(${i})) == fixture(${i}).actual,"sensitivity");` : '').filter(Boolean).join('\n')}
    }
    function test_SignedMagnitudeAndCeiling() public pure {
        for(uint256 i;i<${checks.length};++i) {
            Check memory c=fixture(i); uint256 d=diff(rate(c),c.ideal);
            require(c.actual>=c.ideal?c.ideal+d==c.actual:c.actual+d==c.ideal,"direction");
            uint256 n=d*c.pt*W; uint256 q=c.lp*c.assetScale; uint256 v=(n+q-1)/q;
            require(v*q>=n && (v==0 || (v-1)*q<n),"ceiling interval");
        }
    }
    function test_SyntheticDecimalAwareUSDOnly() public pure {
        // Arbitrary $2 mock price, 6-decimal asset, 18-decimal SY; no live asset.
        uint256 price=2e18;
        uint256 syAsset=(2e18*1e6)/W;
        uint256 ptAsset=(3e6*W)/W;
        require((syAsset*price)/1e6+(ptAsset*price)/1e6==${expectedMockTvl},"USD scale");
        require(int256(999e18)-int256(1000e18)-int256(1e18)==-2e18,"net sign");
    }
}
`;
}
function markdown(r) {
  return ['# Pendle V7 cycle-6 — fail-closed closeout', '', 'Signal: **INCOMPLETE_DATA_NO_PROMOTION**', '',
    `Generated ${r.generatedAt}. **No fresh chainstate captured; scanner not run.**`, '',
    '## Blocking conflict', '', r.blocker,
    'The scanner also has a non-RPC public API fallback. No method widening or fallback was attempted. Actual-path gas estimation is independently unavailable under eth_call-only authority; no $50 gas substitute was used.', '',
    `Snapshot before/after SHA-256: \`${r.beforeSha256}\` / \`${r.afterSha256}\`. It is unchanged, NOT refreshed.`,
    `Saved scan: ${r.freshness.scannedAt}; age ${r.freshness.ageSeconds}s; freshness ${r.freshness.status}. Fresh finalized number/hash: **unknown**.`, '',
    '## Cycle-6 verdict', '', '**INCOMPLETE_DATA. Watch-list persists administratively; fresh economics unknown.**',
    'Neither requested binary economic conclusion is justified: unknown rows are not route-negative, and historical residuals are not route-positive. Do not declare that cycle-3/cycle-5 falsification generalizes or return A04 to WARM from these data. No promotion.', '',
    'Current residual columns are unknown for all 47 markets. JSON historicalOnly retains independently recomputed old-pin controls, not current observations. Offline BigInt results match cycle-5 when its exact snapshot is present. Solidity test is mock/historical-only, execution recorded in handoff.', '',
    '## Requested per-market residual table at refreshed pin', '',
    'There is no refreshed pin. `?` is unknown, not zero. Threshold =10 PT-only normalized units per whole LP; no token payout or actual LP oracle price is implied.', '',
    '| Chain | Market | Calc max rate units | LP-adjusted residual | Threshold | Above | Fingerprint |',
    '|---|---|---:|---:|---:|---|---|',
    ...r.markets.map(m => `| ${m.chainId} | ${m.marketAddress} | ? | ? | 10 | ? | ? |`), '',
    '## Stage-5 watch-list USD table', '',
    'Each market has three separate $1k/$10k/$50k rows in JSON; all 30 routePositive values are unknown. Prices, reserves in USD, TVL, quoteOut, fees, gas, and net are null—not estimated from a peg or a native-price surrogate.', '',
    '| Chain | Market | Historical asset address | Status | $1k / $10k / $50k |', '|---|---|---|---|---|',
    ...r.stage5.map(m => `| ${m.chainId} | ${m.marketAddress} | ${m.assetAddressHistorical} | INCOMPLETE_DATA | unknown / unknown / unknown |`), '',
    '## Source / invariant / defensive tests', '',
    '`MarketMathCore.sol:335-353,309-323` produces a rate, not quoteOut; a complete swap needs :179-273, reserve updates and fees. `:166-167` floors burn outputs; `:246,251-252` allocate already-computed fees. `PendlePYOracleLib.sol:65-75` does not identify the underlying asset; SY.assetInfo and an identity-bound asset/USD feed are required. Native ETH/USD alone cannot value arbitrary stablecoin/receipt assets.', '',
    'Invariant: signed residual D reconstructs source and reference; C=ceil(abs(D)*PT*1e18/(LP*10^assetDecimals)) obeys both ceiling inequalities. Frozen effective-anchor downscales are synthetic, not a depletion strategy. Separate stored-oracle, actual-reserve and grid maxima. Net requires observed quoteOut-input-fees and separately measured actual-path gas, with no fee double count. No route is complete from candidate (a) alone.', '',
    '72/96-digit reference agreement, historical per-market equality to cycle-5, cycle-4 19,446,892,277 control, signed division, decimal-aware synthetic USD calculation, and stale/invalid/future timestamp rejection are checked in Node. Generated Forge file has five mock-only tests against actual LogExpMath/PMath; no whole-market build/runtime-equivalence claim.', '',
    '## Cycle-7 recommendation', '', r.cycle7Recommendation,
    'The workspace owner must explicitly resolve scanner read methods and gas evidence scope before capture. Positive economics, if later established, still require Stage-6 Pendle routing, deployed/verified executor where appropriate, and a fresh named owner batch envelope. executableNow remains unknown; signedActionJustified=false.', '',
    ...r.disclosure, ''].join('\n');
}
main();
