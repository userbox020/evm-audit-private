#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET_REL = 'targets/derive-v2-core';
const TARGET = path.join(ROOT, ...TARGET_REL.split('/'));
const ID = 'critical-derive-v2-settlement-order-materiality-envelope-gate0-step3';
const CLAIM_ID = 'critical/derive-v2-settlement-order-materiality-envelope-gate0-step3';
const CLAIM_REVISION = 4;
const OUTPUT = `reports/raw/fast/${ID}.json`;
const EXACT_COMMIT = '96796a61dcb1dc852e25518b00cc1a79fb3caeeb';
const EXACT_TREE = 'bff9a8d82d1615ecdfe2f1b8f25f9b9c9bf7d365';
const GENERATED_AT = '2026-08-08T00:00:00.000Z';
const UNIT = 10n ** 18n;
const YEAR = 365n * 24n * 60n * 60n;
const DAY = 24n * 60n * 60n;
const ASSESSOR = 'critical-derive-v2-materiality-gate0-step3-20260808';

const PARAMS = Object.freeze({
  intended: Object.freeze({ minRate: 20_000_000_000_000_000n, rateMultiplier: 80_000_000_000_000_000n, highRateMultiplier: 900_000_000_000_000_000n, optimalUtil: 850_000_000_000_000_000n }),
  step1Fixture: Object.freeze({ minRate: 60_000_000_000_000_000n, rateMultiplier: 200_000_000_000_000_000n, highRateMultiplier: 400_000_000_000_000_000n, optimalUtil: 600_000_000_000_000_000n }),
  constructorMaxima: Object.freeze({ minRate: 2n * UNIT, rateMultiplier: 5n * UNIT, highRateMultiplier: 5n * UNIT, optimalUtil: UNIT }),
});

const INPUTS = Object.freeze({
  baseManager: { path: `${TARGET_REL}/src/risk-managers/BaseManager.sol`, sha256: '9d3b691ce0aa99e9469696c5acbb5d3a7f03b3e98a40024c81150e88ca897e09' },
  cashAsset: { path: `${TARGET_REL}/src/assets/CashAsset.sol`, sha256: '64419f529533210f7957ad5f3f60205356800e3964aaf62bbf9d9a928095c2b9' },
  interestRateModel: { path: `${TARGET_REL}/src/assets/InterestRateModel.sol`, sha256: '6c51b5c3f92b918927d2847941d9822e167cf614b7fe4e76f3f7890d21d9797c' },
  fixedPointMathLib: { path: `${TARGET_REL}/lib/lyra-utils/src/math/FixedPointMathLib.sol`, sha256: '3c1bc3f088c0e5f1cd1a75c0ac18d7c96d18500f11cae8fc3067885c712836e8' },
  intendedConfig: { path: `${TARGET_REL}/scripts/config-mainnet.sol`, sha256: '9372e3f68399d2397318e0868de1e1161e0fb41f0177a4ce2ec140140853f9ab' },
  step1Report: { path: 'reports/critical-derive-v2-cash-wrapped-pnl-funding-conservation-step1.md', sha256: '6f7e679f6a4859bdec2090dcf22e2bb8c9c882bc63593c1c6bfb58cb10d8d50a' },
});

function invariant(value, message) { if (!value) throw new Error(message); }
function workspacePath(rel) { return path.join(ROOT, ...rel.split('/')); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function read(rel) { return fs.readFileSync(workspacePath(rel)); }
function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function stringifyBigInts(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(stringifyBigInts);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stringifyBigInts(v)]));
  return value;
}
function mulWadDown(x, y) { return x * y / UNIT; }
function min(a, b) { return a < b ? a : b; }
function ceilDiv(x, y) { return x === 0n ? 0n : (x + y - 1n) / y; }
const CASH_QUANTUM = 10n ** 12n;

// Exact BigInt transcription of lyra-utils FixedPointMathLib.exp for nonnegative protocol inputs.
function expWad(x) {
  invariant(x >= 0n && x < 135_305_999_368_893_231_589n, 'exp input outside protocol representable domain');
  x = (x << 78n) / (5n ** 18n);
  const ln2 = 54_916_777_467_707_473_351_141_471_128n;
  const k = (((x << 96n) / ln2) + (2n ** 95n)) >> 96n;
  x -= k * ln2;
  let p = x + 2_772_001_395_605_857_295_435_445_496_992n;
  p = ((p * x) >> 96n) + 44_335_888_930_127_919_016_834_873_520_032n;
  p = ((p * x) >> 96n) + 398_888_492_587_501_845_352_592_340_339_721n;
  p = ((p * x) >> 96n) + 1_993_839_819_670_624_470_859_228_494_792_842n;
  p = p * x + (4_385_272_521_454_847_904_632_057_985_693_276n << 96n);
  let z = x + 750_530_180_792_738_023_273_180_420_736n;
  z = ((z * x) >> 96n) + 32_788_456_221_302_202_726_307_501_949_080n;
  let w = x - 2_218_138_959_503_481_824_038_194_425_854n;
  w = ((w * z) >> 96n) + 892_943_633_302_991_980_437_332_862_907_700n;
  let q = z + w - 78_174_809_823_045_304_726_920_794_422_040n;
  q = ((q * w) >> 96n) + 4_203_224_763_890_128_580_604_056_984_195_872n;
  const r = p / q;
  return (r * 3_822_833_074_963_236_453_042_738_258_902_158_003_155_416_615_667n) >> (195n - k);
}

function utilization(supply, borrows) {
  if (supply === 0n || borrows === 0n) return 0n;
  return min(borrows * UNIT / supply, UNIT);
}

function borrowRate(supply, borrows, params) {
  const util = utilization(supply, borrows);
  if (util <= params.optimalUtil) return mulWadDown(util, params.rateMultiplier) + params.minRate;
  const normal = mulWadDown(params.optimalUtil, params.rateMultiplier) + params.minRate;
  return mulWadDown(util - params.optimalUtil, params.highRateMultiplier) + normal;
}

function interestFactor(elapsed, rate) {
  invariant(elapsed > 0n, 'elapsed must be positive');
  return expWad(elapsed * rate / YEAR) - UNIT;
}

function settlementDelta({ b, S, B, N, t, params }) {
  invariant(b > 0n && S > 0n && B >= b && N >= 0n && t > 0n, 'invalid settlement model input');
  const baselineRate = borrowRate(S, B, params);
  const attackedRate = borrowRate(S + N, B, params);
  const baselineFactor = interestFactor(t, baselineRate);
  const attackedFactor = interestFactor(t, attackedRate);
  invariant(attackedRate >= params.minRate, 'attacked rate below minRate');
  invariant(baselineRate >= attackedRate, 'loser-first rate exceeds baseline');
  const baselineLiability = b + mulWadDown(b, baselineFactor);
  const attackedLiability = b + mulWadDown(b, attackedFactor);
  const baselineExternalRepayment = ceilDiv(baselineLiability, CASH_QUANTUM) * CASH_QUANTUM;
  const attackedExternalRepayment = ceilDiv(attackedLiability, CASH_QUANTUM) * CASH_QUANTUM;
  const baselineInternalCashDust = baselineExternalRepayment - baselineLiability;
  const attackedInternalCashDust = attackedExternalRepayment - attackedLiability;
  const liabilityReduction = baselineLiability - attackedLiability;
  const externalWalletGain = baselineExternalRepayment - attackedExternalRepayment;
  const totalControlledWealthGain = externalWalletGain + attackedInternalCashDust - baselineInternalCashDust;
  invariant(totalControlledWealthGain === liabilityReduction, 'controlled wealth reconciliation');
  return {
    b, S, B, N, t,
    baselineUtil: utilization(S, B),
    attackedUtil: utilization(S + N, B),
    baselineRate,
    attackedRate,
    baselineFactor,
    attackedFactor,
    baselineLiability,
    attackedLiability,
    liabilityReduction,
    baselineExternalRepayment,
    attackedExternalRepayment,
    externalWalletGain,
    baselineInternalCashDust,
    attackedInternalCashDust,
    internalCashDustDeltaAttackedMinusBaseline: attackedInternalCashDust - baselineInternalCashDust,
    totalControlledWealthGain,
  };
}

function infiniteLossBound({ b, S, B, t, params }) {
  const baselineRate = borrowRate(S, B, params);
  const attackedRate = params.minRate;
  const baselineFactor = interestFactor(t, baselineRate);
  const attackedFactor = interestFactor(t, attackedRate);
  const baselineLiability = b + mulWadDown(b, baselineFactor);
  const attackedLiability = b + mulWadDown(b, attackedFactor);
  const baselineExternalRepayment = ceilDiv(baselineLiability, CASH_QUANTUM) * CASH_QUANTUM;
  const attackedExternalRepayment = ceilDiv(attackedLiability, CASH_QUANTUM) * CASH_QUANTUM;
  const liabilityReductionUpperBound = baselineLiability - attackedLiability;
  const externalWalletGainExact = baselineExternalRepayment - attackedExternalRepayment;
  return {
    b, S, B, N: 'INFINITY', t,
    baselineUtil: utilization(S, B), attackedUtilLimit: 0n,
    baselineRate, attackedRate,
    baselineFactor, attackedFactor,
    baselineLiability,
    attackedLiability,
    liabilityReductionUpperBound,
    externalWalletGainExact,
    baselineInternalCashDust: baselineExternalRepayment - baselineLiability,
    attackedInternalCashDust: attackedExternalRepayment - attackedLiability,
    externalWalletRoundingUpperBound: liabilityReductionUpperBound + CASH_QUANTUM - 1n,
  };
}

function materialityThreshold(capital) { return capital / 1000n > 1000n * UNIT ? capital / 1000n : 1000n * UNIT; }

function metricValue(row, metric) {
  const value = row[metric];
  invariant(typeof value === 'bigint', `unknown metric ${metric}`);
  return value;
}

function firstTimeCrossing(input, threshold, maxTime, metric = 'liabilityReductionUpperBound') {
  if (metricValue(infiniteLossBound({ ...input, t: maxTime }), metric) <= threshold) return null;
  let lo = 1n;
  let hi = maxTime;
  while (lo < hi) {
    const mid = (lo + hi) >> 1n;
    if (metricValue(infiniteLossBound({ ...input, t: mid }), metric) > threshold) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

function firstLossCrossing(input, threshold, maxN, metric = 'liabilityReduction') {
  if (metricValue(settlementDelta({ ...input, N: maxN }), metric) <= threshold) return null;
  let lo = 0n;
  let hi = maxN;
  while (lo < hi) {
    const mid = (lo + hi) >> 1n;
    if (metricValue(settlementDelta({ ...input, N: mid }), metric) > threshold) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

function verifyAuthority() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: TARGET, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: TARGET, encoding: 'utf8' }).trim();
  invariant(commit === EXACT_COMMIT, 'target commit drift');
  invariant(tree === EXACT_TREE, 'target tree drift');
  const inputs = Object.entries(INPUTS).map(([role, item]) => {
    const bytes = read(item.path);
    const digest = sha256(bytes);
    invariant(digest === item.sha256, `${role} hash drift`);
    return { role, path: item.path, bytes: bytes.length, sha256: digest };
  });
  const source = Object.fromEntries(inputs.map((x) => [x.role, read(x.path).toString('utf8')]));
  invariant(source.baseManager.includes('cashAsset.updateSettledCash(netCash);') && source.baseManager.indexOf('cashAsset.updateSettledCash(netCash);') < source.baseManager.indexOf('AssetAdjustment(accountId, cashAsset, 0, netCash'), 'settlement ordering semantic drift');
  invariant(source.cashAsset.includes('realSupply += (-netSettledCash).toUint256()') && source.cashAsset.includes('getBorrowInterestFactor(elapsedTime, borrowRate)'), 'cash accrual semantic drift');
  invariant(source.interestRateModel.includes('return Math.min(borrows.divideDecimal(supply), 1e18)') && source.interestRateModel.includes('FixedPointMathLib.exp'), 'rate semantics drift');
  invariant(source.fixedPointMathLib.includes('1993839819670624470859228494792842'), 'exp coefficient semantic drift');
  invariant(source.intendedConfig.includes('minRate = 0.02e18;') && source.intendedConfig.includes('optimalUtil = 0.85e18;'), 'intended config drift');
  return { commit, tree, preExistingDirtyFilesPreserved: ['foundry.lock', 'test/audit/'], inputs };
}

function walkTextFiles(directory, prefix) {
  if (!fs.existsSync(directory)) return [];
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
    const full = path.join(directory, entry.name);
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkTextFiles(full, rel));
    else if (/\.(md|txt)$/i.test(entry.name)) out.push(rel.replaceAll('\\', '/'));
  }
  return out;
}

function duplicateScreen() {
  const reportFiles = fs.readdirSync(workspacePath('reports'), { withFileTypes: true })
    .filter((x) => x.isFile() && x.name.endsWith('.md') && x.name !== `${ID}.md`)
    .map((x) => `reports/${x.name}`);
  const docFiles = walkTextFiles(workspacePath(`${TARGET_REL}/docs`), `${TARGET_REL}/docs`);
  const files = [...reportFiles, ...docFiles].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const terms = [/loser-first/i, /settlement[- ]order/i];
  const matches = files.filter((file) => terms.some((term) => term.test(read(file).toString('utf8'))));
  const predecessor = INPUTS.step1Report.path;
  const lineageReferences = matches.filter((x) => x === predecessor || x === 'reports/rpc-blocked-backlog.md');
  const semanticContextDocs = docFiles.filter((file) => {
    const text = read(file).toString('utf8');
    return /netSettledCash/i.test(text) && /interest/i.test(text);
  });
  return {
    scope: ['reports/*.md', `${TARGET_REL}/docs/**/*.md|txt`],
    filesScanned: files.length,
    matchingFiles: matches,
    predecessorMatch: matches.includes(predecessor),
    lineageReferences,
    semanticContextDocs,
    independentDuplicateMatches: matches.filter((x) => !lineageReferences.includes(x)),
    disposition: matches.filter((x) => !lineageReferences.includes(x)).length === 0 ? 'NO_INDEPENDENT_LOCAL_DUPLICATE' : 'REVIEW_LOCAL_MATCHES',
  };
}

function economicsRow(name, capital, params, t) {
  const b = capital * 4n / 10n;
  const threshold = materialityThreshold(capital);
  const bound = infiniteLossBound({ b, S: b, B: b, t, params });
  return {
    name,
    capital,
    actorDebt: b,
    totalBorrow: b,
    supply: b,
    elapsed: t,
    threshold,
    ...bound,
    liabilityPassesStrictly: bound.liabilityReductionUpperBound > threshold,
    externalWalletPassesStrictly: bound.externalWalletGainExact > threshold,
    roundingConservativePassesStrictly: bound.externalWalletRoundingUpperBound > threshold,
  };
}

function evidenceRecord(status, result, assumptions, artifacts, rationale, assessor = ASSESSOR) {
  return { status, result, assumptions, assessor, assessedAt: GENERATED_AT, artifacts, rationale };
}

function buildArtifact() {
  const authority = verifyAuthority();
  const step1 = settlementDelta({ b: 8000n * UNIT, S: 10_000n * UNIT, B: 8000n * UNIT, N: 181_999_791_666_666_668_000n, t: 86_401n, params: PARAMS.step1Fixture });
  invariant(step1.liabilityReduction === 125_457_288_093_656_000n, 'Step1 exact liability reduction');
  invariant(step1.externalWalletGain === 125_458_000_000_000_000n, 'Step1 exact external wallet delta');
  invariant(step1.totalControlledWealthGain === step1.liabilityReduction, 'Step1 controlled wealth');

  const monotonicNs = [0n, 1n * UNIT, 100n * UNIT, 1000n * UNIT, 10_000n * UNIT, 1_000_000n * UNIT];
  const monotonicRows = monotonicNs.map((N) => settlementDelta({ b: 8000n * UNIT, S: 10_000n * UNIT, B: 8000n * UNIT, N, t: 86_401n, params: PARAMS.step1Fixture }));
  for (let i = 1; i < monotonicRows.length; i++) invariant(monotonicRows[i].liabilityReduction >= monotonicRows[i - 1].liabilityReduction, 'N monotonicity failed');
  const step1Infinity = infiniteLossBound({ b: 8000n * UNIT, S: 10_000n * UNIT, B: 8000n * UNIT, t: 86_401n, params: PARAMS.step1Fixture });
  invariant(monotonicRows.every((x) => x.liabilityReduction <= step1Infinity.liabilityReductionUpperBound), 'infinite bound failed');

  const intendedPrimary = economicsRow('intended-primary-capital-ceiling', 100_000_000n * UNIT, PARAMS.intended, DAY);
  const intendedBoundary = economicsRow('intended-threshold-pivot', 1_000_000n * UNIT, PARAMS.intended, DAY);
  const maximaBoundary = economicsRow('constructor-maxima-threshold-pivot', 1_000_000n * UNIT, PARAMS.constructorMaxima, DAY);
  invariant(!intendedPrimary.roundingConservativePassesStrictly && !intendedBoundary.roundingConservativePassesStrictly && maximaBoundary.liabilityPassesStrictly, 'mandatory qualification drift');

  const favorableInput = { b: 400_000n * UNIT, S: 400_000n * UNIT, B: 400_000n * UNIT, params: PARAMS.intended };
  const threshold = materialityThreshold(1_000_000n * UNIT);
  const intendedLiabilityTime = firstTimeCrossing(favorableInput, threshold, 365n * DAY, 'liabilityReductionUpperBound');
  const intendedWalletTime = firstTimeCrossing(favorableInput, threshold, 365n * DAY, 'externalWalletGainExact');
  const maximaInput = { ...favorableInput, params: PARAMS.constructorMaxima };
  const maximaLiabilityTime = firstTimeCrossing(maximaInput, threshold, 365n * DAY, 'liabilityReductionUpperBound');
  const maximaWalletTime = firstTimeCrossing(maximaInput, threshold, 365n * DAY, 'externalWalletGainExact');
  const fiveDayInput = { ...favorableInput, t: 5n * DAY };
  const liabilityLossN = firstLossCrossing(fiveDayInput, threshold, 10_000_000_000n * UNIT, 'liabilityReduction');
  const walletLossN = firstLossCrossing(fiveDayInput, threshold, 10_000_000_000n * UNIT, 'externalWalletGain');
  invariant(intendedLiabilityTime !== null && intendedLiabilityTime > DAY, 'intended crossing qualification');
  invariant(maximaLiabilityTime !== null && maximaLiabilityTime < DAY, 'maxima crossing qualification');
  invariant(liabilityLossN === 1_136_279_991_480_119_097_126_870n, 'five-day liability N crossing drift');
  invariant(walletLossN === 1_136_279_991_837_322_249_500_164n, 'five-day wallet N crossing drift');

  const actorOwnsLosingSideOnly = settlementDelta({ ...fiveDayInput, N: liabilityLossN });
  invariant(actorOwnsLosingSideOnly.liabilityReduction - liabilityLossN < 0n, 'losing-side-only loss must dominate gain');
  const pivotBps18 = intendedBoundary.liabilityReductionUpperBound * 10_000n * UNIT / intendedBoundary.capital;
  invariant(pivotBps18 === 2_225_398_222_881_584_000n, 'pivot bps drift');
  const primaryFloor = economicsRow('intended-capital-floor', 20_000n * UNIT, PARAMS.intended, DAY);
  const maximaFloor = economicsRow('constructor-maxima-capital-floor', 20_000n * UNIT, PARAMS.constructorMaxima, DAY);
  const primaryRows = [primaryFloor, intendedBoundary, intendedPrimary, maximaFloor, maximaBoundary];
  invariant(primaryRows.filter((x) => x.name.startsWith('intended')).every((x) => !x.roundingConservativePassesStrictly), 'intended primary universal rows');
  const chain957Files = fs.readdirSync(workspacePath(`${TARGET_REL}/deployments/957`)).filter((x) => x.endsWith('.json')).length;

  const artifact = {
    schemaVersion: 2,
    claimId: CLAIM_ID,
    claimRevision: CLAIM_REVISION,
    supersedes: [],
    reportStatus: 'PUBLISHED',
    axes: {
      evidenceStage: 'SOURCE-CONFIRMED',
      validityOutcome: 'VALID',
      noveltyOutcome: 'UNKNOWN',
      deploymentDisposition: 'UNBOUND',
      accessDisposition: 'NOT-REQUESTED',
      routeDisposition: 'UNKNOWN',
      signal: 'final',
    },
    lineage: {
      parentClaimId: 'critical/derive-v2-cash-wrapped-pnl-funding-conservation-step1',
      relation: 'materiality-envelope-gate0-step3',
      priorDraftRevisions: 'history/tool context only; no published Step3 revision superseded',
    },
    generatedAt: GENERATED_AT,
    mode: 'DETERMINISTIC_OFFLINE_SOURCE_LOCAL_GATE0',
    classification: 'CLOSE_ROTATE/PRIMARY-ONE-DAY-MATERIALITY-NONPOSITIVE/MULTI-DAY-UNKNOWN/CONSTRUCTOR-MAXIMA-SENSITIVITY',
    classificationScope: 'profit-prioritization Gate0 only; not route-negative and not protocol-wide',
    authority,
    sourceSemantics: {
      roots: ['src/risk-managers/BaseManager.sol:381-394', 'src/assets/CashAsset.sol:488-523', 'src/assets/InterestRateModel.sol:45-52,69-111', 'lib/lyra-utils/src/math/FixedPointMathLib.sol:120-180', 'scripts/config-mainnet.sol:646-657'],
      formula: 'gain=b*(exp(t*r_base/year)-exp(t*r_attack/year)); r_base=IRM(S,B), r_attack=IRM(S+N,B)',
      exactIntegerSemantics: ['1e18 multiply/divide round down', 'utilization capped at 1e18', 'piecewise protocol rate', 'elapsed*rate/year truncation', 'exact FixedPointMathLib.exp coefficients and operations'],
      loserFirstRateFloor: 'attackedRate >= minRate for every finite N; attackedRate -> minRate as N -> infinity',
    },
    parameters: {
      intended: PARAMS.intended,
      step1Fixture: PARAMS.step1Fixture,
      absoluteConstructorBounds: PARAMS.constructorMaxima,
      warning: 'Constructor maxima are legal source bounds, not intended or deployed parameters.',
    },
    step1Reproduction: step1,
    monotonicEnvelope: { rows: monotonicRows, infinity: step1Infinity, monotonicNondecreasingInN: true, everyFiniteRowAtOrBelowInfinity: true },
    materialityDomain: {
      thresholdRule: 'exact total controlled wealth or external six-decimal wallet gain > max($1,000, 10bps actor capital)',
      cashUsdAssumption: 'one cash unit treated as $1 for Gate0 only; no current peg/state claim',
      capital: { min: 20_000n * UNIT, max: 100_000_000n * UNIT },
      actorDebtRule: 'b <= 40% actor capital, matching the Step1 8,000 debt / approximately $20,000 collateral fixture',
      marketEnvelope: 'maximally favorable B=b, S=B (100% baseline utilization), N->infinity',
      primaryElapsed: { minSeconds: 1n, maxSeconds: DAY, rationale: 'analyst-selected primary domain inherited from the approximately one-day Step1 horizon' },
      multiDayDisposition: 'UNKNOWN; sensitivity only',
      rounding: { quantum18: CASH_QUANTUM, exactExternalWalletModeled: true, conservativeAdditiveUpperBound: CASH_QUANTUM - 1n, label: '<1 USDC raw-unit rounding' },
      primaryRows,
      primaryIntendedAnyPass: false,
      constructorMaximaCanPass: true,
    },
    universalDomainProof: {
      domain: 'capital $20,000..$100,000,000; b<=0.4C; B>=b; S>0; N>=0; t<=1 day; intended nonnegative slopes',
      gainMonotoneInActorDebt: { proved: true, reason: 'factor difference is nonnegative and independent of b for fixed market state, so b=0.4C maximizes gain' },
      rateMonotoneInUtilization: { proved: true, reason: 'both intended piecewise slopes are nonnegative' },
      utilizationCap: { proved: true, reason: 'B>=S gives capped baseline utilization 1; B=b,S=B is representative of that maximum while satisfying B>=b' },
      lossEnvelope: { proved: true, reason: 'N->infinity minimizes attacked utilization and rate to minRate' },
      capitalAtOrBelowPivot: { pivotCapital: 1_000_000n * UNIT, proved: true, reason: 'gain is linear in C and its maximum at the pivot remains below $1,000 even after adding <1 raw-unit rounding', pivotLiabilityUpperBound: intendedBoundary.liabilityReductionUpperBound, pivotRoundingUpperBound: intendedBoundary.externalWalletRoundingUpperBound },
      capitalAtOrAbovePivot: { proved: true, reason: 'gain/capital is constant at b=0.4C and remains below 10bps', liabilityGainBps18: pivotBps18, thresholdBps18: 10n * UNIT },
      conclusion: 'bounded one-day intended-parameter economics are nonpositive against the materiality threshold for the entire encoded domain',
    },
    crossings: {
      favorableCapital: 1_000_000n * UNIT,
      favorableDebtBorrowSupply: 400_000n * UNIT,
      strictThreshold: threshold,
      intendedInfiniteLoss: { liabilityFirstElapsedSeconds: intendedLiabilityTime, externalWalletFirstElapsedSeconds: intendedWalletTime },
      constructorMaximaInfiniteLoss: { liabilityFirstElapsedSeconds: maximaLiabilityTime, externalWalletFirstElapsedSeconds: maximaWalletTime },
      intendedFiveDay: { liabilityFirstLossN: liabilityLossN, externalWalletFirstLossN: walletLossN },
      qualification: 'Multi-day intended crossings are UNKNOWN sensitivity outside the analyst-selected primary domain; no route promotion follows.',
    },
    lifecycle: {
      productionPathFixture: `targets/derive-v2-core/test/audit/DeriveV2SettlementOrderMaterialityEnvelopeGate0Step3.t.sol`,
      controlledSteps: ['actor owns borrower', 'actor receives borrowed stable in wallet', 'third-party loser is settled first', 'actor repays lower indexed liability', 'actor withdraws all wrapped collateral', 'terminal external stable plus collateral wallet is compared'],
      aggregateSupplierOrSmLossCountedAsActorGain: false,
      exactAccounting: { liabilityReduction: step1.liabilityReduction, externalWalletGain: step1.externalWalletGain, attackedInternalCashDust: step1.attackedInternalCashDust, baselineInternalCashDust: step1.baselineInternalCashDust, internalCashDustDeltaAttackedMinusBaseline: step1.internalCashDustDeltaAttackedMinusBaseline, totalControlledWealthGain: step1.totalControlledWealthGain },
      pnlFundingRequirement: {
        actorFundedRequiredBySource: false,
        witness: 'The borrower can be distinct from both Perp counterparties and permissionlessly trigger settlement; N can be exogenous in the focused fixture.',
        exogenousAvailabilityCurrent: 'unknown',
        actorOwnsLosingSideOnly: { N: liabilityLossN, liabilityReduction: actorOwnsLosingSideOnly.liabilityReduction, netBeforeOtherCosts: actorOwnsLosingSideOnly.liabilityReduction - liabilityLossN, result: 'nonpositive' },
        coalitionBothSides: { result: 'inconclusive', disposition: 'UNKNOWN', NAutomaticallyCharged: false, unresolved: ['fees', 'margin', 'funding', 'market exposure', 'opportunity cost', 'position unwind'] },
      },
    },
    economics: {
      optimisticUpperBound: { gross: 'exact liability reduction / total controlled wealth', externalWallet: 'exact ceilDiv repayment delta', capital: 'explicit actor collateral at b<=40% capital', obligations: ['repay attacked indexed debt', 'return/unwind any borrowed liquidity'], costs: 0, costsQualification: 'free N and zero costs are optimistic upper bounds only' },
      conservative: { gross: 'same liability reduction', capital: 'collateral plus any Perp/margin/liquidity capital', obligations: ['debt repayment', 'position close/unwind', 'N only when actor owns losing side'], costs: 'unknown: settlement competition, gas, trading/funding/price movement, slippage, opportunity cost', net: null },
      currentLiquidity: 'unknown', currentState: 'unknown', currentDeployment: 'unknown', routePromotion: false,
    },
    deploymentContext: {
      chain957JsonFilesPresent: chain957Files,
      disposition: 'STALE_REPOSITORY_CONTEXT_ONLY',
      currentDeploymentEvidence: false,
      runtimeMatched: false,
      warning: 'Repository chain-957 JSON is not evidence of current deployment, state, liquidity, executability, or parameters.',
    },
    duplicateScreen: duplicateScreen(),
    evidence: {
      sourceExact: evidenceRecord('PASS', 'n/a', ['local target remains at the exact pinned commit and authority hashes'], authority.inputs.map((x) => x.path), 'Exact commit/tree and six authority inputs are hash-bound, including FixedPointMathLib.'),
      buildVerified: evidenceRecord('BLOCKED', 'inconclusive', ['tracked dependency layout is preserved'], ['targets/derive-v2-core/lib/lyra-utils/test/math/SVI.t.sol', 'targets/derive-v2-core/lib/lyra-utils/src/math/SVI.sol'], 'Focused compilation succeeds, but Solar cannot resolve the tracked test import src/math/SVI.sol.'),
      localSemantic: evidenceRecord('PASS', 'supports', ['local integration fixture represents the source-local ordering path', 'cash uses protocol decimal semantics'], [`targets/derive-v2-core/test/audit/DeriveV2SettlementOrderMaterialityEnvelopeGate0Step3.t.sol`, `tools/analyze-${ID}.js`], 'Exact analyzer and production-path fixture reproduce ordering, lifecycle, rates, exp factors, and repayment rounding.'),
      deploymentProvenance: evidenceRecord('UNKNOWN', 'n/a', ['checked-in deployment JSON is stale context only'], [`${TARGET_REL}/deployments/957/`], 'No current deployment provenance was requested or established.'),
      runtimeAttested: evidenceRecord('UNKNOWN', 'n/a', ['no network, RPC, or runtime capture'], [], 'No runtime attestation was requested or performed.'),
      reachability: evidenceRecord('UNKNOWN', 'inconclusive', ['source-local public calls do not establish current timing, state, or liquidity'], ['reports/critical-derive-v2-cash-wrapped-pnl-funding-conservation-step1.md'], 'Current settlement availability and operational reachability are unbound.'),
      economics: evidenceRecord('UNKNOWN', 'inconclusive', ['bounded one-day assessment is not global/current economics', 'multi-day and coalition costs remain unbound'], [OUTPUT], 'Global/current state, coalition costs, liquidity, and multi-day economics are unbound.'),
      reproducibility: evidenceRecord('PASS', 'n/a', ['Node.js BigInt and pinned local Foundry semantics'], [`tools/analyze-${ID}.js`, `tools/test-${ID}.js`, `targets/derive-v2-core/test/audit/DeriveV2SettlementOrderMaterialityEnvelopeGate0Step3.t.sol`, OUTPUT], 'Deterministic offline analyzer tests/check, exact EVM assertions, formatting, and JSON validation reproduce the package.'),
      review: evidenceRecord('PASS', 'n/a', ['revision 3 package received final Oracle approval'], ['reports/critical-derive-v2-settlement-order-materiality-envelope-gate0-step3.md', 'coordination/inbox/critical/20260808-critical-derive-v2-settlement-order-materiality-envelope-gate0-step3.json', 'coordination/handoffs/20260808-critical-derive-v2-settlement-order-materiality-envelope-gate0-step3.md'], 'Oracle final approval of revision 3 authorizes publication-only revision 4.', 'oracle-derive-v2-materiality-gate0-step3-20260808'),
    },
    boundedAssessments: {
      boundedOneDayEconomics: evidenceRecord('PASS', 'nonpositive', ['analyst-selected one-day horizon inherited from Step1', 'b<=0.4C', 'free N and zero costs', 'intended parameters'], [OUTPUT, `tools/test-${ID}.js`], 'The universal free-N upper bound remains below the materiality threshold throughout the encoded primary domain.'),
    },
    severity: {
      rating: 'LOW',
      framework: 'source-local impact with bounded materiality and unbound current execution',
      confidence: 'LOW',
      maxCredibleSupportedImpact: 'Source-local redistribution of one elapsed interest interval from suppliers and the SM fee recipient to lower borrower liability.',
      attackerGain: 'Exact Step1 controlled-wealth gain is 0.125457288093656 cash; global/current gain is unknown.',
      attackerCost: 'Unknown outside the zero-cost bounded assessment; losing-side-only ownership charges N.',
      victimLoss: 'Lower supplier interest equal to the supplier share of the source-local redistribution; current amount is unknown.',
      protocolLoss: 'Lower security-module fee accrual in the source-local ordering; current amount is unknown.',
      operationalImpact: 'No current operational impact established.',
      uncertainty: ['deployment provenance', 'runtime attestation', 'current reachability', 'multi-day timing', 'coalition costs', 'liquidity and unwind'],
      rationale: 'The source condition is valid and locally reproducible, bounded one-day intended economics are below the threshold, and current/global execution evidence is unbound.',
    },
    gates: {
      routePositive: 'unknown',
      executableNow: 'unknown',
      impactPath: [
        { type: 'victim-loss', supported: 'true', invariant: 'loser-first supplier interest is lower than deterministic baseline', evidence: ['step1Reproduction', 'lifecycle.exactAccounting'] },
        { type: 'protocol-loss', supported: 'true', invariant: 'loser-first security-module fee accrual is lower than deterministic baseline', evidence: ['reports/critical-derive-v2-cash-wrapped-pnl-funding-conservation-step1.md'] },
      ],
      signedActionJustified: false,
      fork: { justified: false, chainId: null, blockNumber: null, blockHash: null, stateRoot: null, finality: null, snapshotHash: null, syntheticChanges: [], signedAction: false },
    },
    networkAttempted: false, rpcAttempted: false, protectedFilesRead: false, signingAttempted: false, transactionAttempted: false,
    nextAction: 'CLOSE_ROTATE',
    reopenOnlyOn: ['reviewed current runtime/configuration binding', 'evidence for a material multi-day accrual opportunity', 'current third-party or coalition settlement and liquidity', 'conservative terminal controlled-wealth net above threshold after all obligations and costs'],
  };
  const normalized = stringifyBigInts(artifact);
  validateArtifact(normalized);
  return normalized;
}

function validateArtifact(a) {
  invariant(a.schemaVersion === 2 && a.claimId === CLAIM_ID && a.claimRevision === CLAIM_REVISION && Array.isArray(a.supersedes) && a.supersedes.length === 0, 'artifact identity');
  invariant(a.reportStatus === 'PUBLISHED' && a.axes.evidenceStage === 'SOURCE-CONFIRMED' && a.axes.signal === 'final', 'published schema');
  invariant(a.axes.validityOutcome === 'VALID' && a.axes.noveltyOutcome === 'UNKNOWN' && a.axes.deploymentDisposition === 'UNBOUND' && a.axes.accessDisposition === 'NOT-REQUESTED' && a.axes.routeDisposition === 'UNKNOWN', 'canonical dispositions');
  invariant(a.classification.startsWith('CLOSE_ROTATE/') && a.nextAction === 'CLOSE_ROTATE', 'close classification');
  invariant(a.step1Reproduction.liabilityReduction === '125457288093656000', 'Step1 liability delta');
  invariant(a.step1Reproduction.externalWalletGain === '125458000000000000', 'Step1 wallet delta');
  invariant(a.step1Reproduction.totalControlledWealthGain === a.step1Reproduction.liabilityReduction, 'Step1 wealth reconciliation');
  invariant(a.monotonicEnvelope.monotonicNondecreasingInN && a.monotonicEnvelope.everyFiniteRowAtOrBelowInfinity, 'monotonic envelope flags');
  invariant(a.materialityDomain.primaryIntendedAnyPass === false && a.materialityDomain.constructorMaximaCanPass === true, 'materiality gate flags');
  invariant(BigInt(a.crossings.intendedInfiniteLoss.liabilityFirstElapsedSeconds) > DAY, 'intended crossing exceeds primary domain');
  invariant(a.crossings.intendedFiveDay.liabilityFirstLossN === '1136279991480119097126870' && a.crossings.intendedFiveDay.externalWalletFirstLossN === '1136279991837322249500164', 'five-day crossings');
  invariant(a.universalDomainProof.gainMonotoneInActorDebt.proved && a.universalDomainProof.rateMonotoneInUtilization.proved && a.universalDomainProof.utilizationCap.proved && a.universalDomainProof.lossEnvelope.proved, 'universal proof');
  invariant(a.lifecycle.pnlFundingRequirement.actorFundedRequiredBySource === false, 'actor funding finding');
  invariant(BigInt(a.lifecycle.pnlFundingRequirement.actorOwnsLosingSideOnly.netBeforeOtherCosts) < 0n, 'losing-side-only stop');
  invariant(a.lifecycle.pnlFundingRequirement.coalitionBothSides.result === 'inconclusive' && a.lifecycle.pnlFundingRequirement.coalitionBothSides.NAutomaticallyCharged === false, 'coalition qualification');
  invariant(a.economics.optimisticUpperBound.costs === 0 && a.economics.conservative.net === null, 'optimistic/conservative separation');
  invariant(a.deploymentContext.currentDeploymentEvidence === false && a.deploymentContext.disposition === 'STALE_REPOSITORY_CONTEXT_ONLY', 'stale deployment qualification');
  const evidenceKeys = ['sourceExact', 'buildVerified', 'localSemantic', 'deploymentProvenance', 'runtimeAttested', 'reachability', 'economics', 'reproducibility', 'review'];
  invariant(JSON.stringify(Object.keys(a.evidence)) === JSON.stringify(evidenceKeys), 'canonical evidence dimensions');
  invariant(Object.values(a.evidence).every((x) => Array.isArray(x.assumptions) && typeof x.assessor === 'string' && x.assessor.length > 0 && x.assessedAt === GENERATED_AT && Array.isArray(x.artifacts) && typeof x.rationale === 'string'), 'complete evidence records');
  invariant(a.evidence.sourceExact.status === 'PASS' && a.evidence.sourceExact.result === 'n/a', 'source exact taxonomy');
  invariant(a.evidence.localSemantic.status === 'PASS' && a.evidence.localSemantic.result === 'supports', 'local semantic taxonomy');
  invariant(a.boundedAssessments.boundedOneDayEconomics.status === 'PASS' && a.boundedAssessments.boundedOneDayEconomics.result === 'nonpositive', 'bounded economics taxonomy');
  invariant(a.evidence.economics.status === 'UNKNOWN' && a.evidence.economics.result === 'inconclusive', 'global economics taxonomy');
  invariant(a.evidence.review.status === 'PASS' && a.evidence.review.result === 'n/a' && a.evidence.review.assessor === 'oracle-derive-v2-materiality-gate0-step3-20260808' && /revision 3/i.test(a.evidence.review.rationale), 'published review taxonomy');
  invariant(a.gates.routePositive === 'unknown' && a.gates.executableNow === 'unknown' && a.gates.signedActionJustified === false, 'canonical safety gates');
  invariant(a.gates.impactPath.every((x) => x.supported === 'true' && typeof x.invariant === 'string' && Array.isArray(x.evidence)), 'canonical impact paths');
  invariant(a.gates.fork.justified === false && a.gates.fork.signedAction === false && a.gates.fork.syntheticChanges.length === 0, 'canonical fork schema');
  invariant(a.networkAttempted === false && a.rpcAttempted === false && a.protectedFilesRead === false && a.transactionAttempted === false, 'offline safety');
  return true;
}

function main() {
  const artifact = buildArtifact();
  const bytes = json(artifact);
  if (process.argv.includes('--check')) {
    assert.strictEqual(fs.readFileSync(workspacePath(OUTPUT), 'utf8'), bytes, 'persisted artifact drift');
  } else {
    fs.writeFileSync(workspacePath(OUTPUT), bytes);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, claimId: artifact.claimId, claimRevision: artifact.claimRevision, reportStatus: artifact.reportStatus, classification: artifact.classification, step1LiabilityReduction: artifact.step1Reproduction.liabilityReduction, step1ExternalWalletGain: artifact.step1Reproduction.externalWalletGain, intendedLiabilityCrossingSeconds: artifact.crossings.intendedInfiniteLoss.liabilityFirstElapsedSeconds, intendedWalletCrossingSeconds: artifact.crossings.intendedInfiniteLoss.externalWalletFirstElapsedSeconds, maximaLiabilityCrossingSeconds: artifact.crossings.constructorMaximaInfiniteLoss.liabilityFirstElapsedSeconds, maximaWalletCrossingSeconds: artifact.crossings.constructorMaximaInfiniteLoss.externalWalletFirstElapsedSeconds, fiveDayLiabilityN: artifact.crossings.intendedFiveDay.liabilityFirstLossN, fiveDayWalletN: artifact.crossings.intendedFiveDay.externalWalletFirstLossN, output: OUTPUT }, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = { ROOT, ID, CLAIM_ID, CLAIM_REVISION, OUTPUT, EXACT_COMMIT, EXACT_TREE, UNIT, CASH_QUANTUM, YEAR, DAY, PARAMS, ceilDiv, expWad, utilization, borrowRate, interestFactor, settlementDelta, infiniteLossBound, materialityThreshold, firstTimeCrossing, firstLossCrossing, duplicateScreen, buildArtifact, validateArtifact, stringifyBigInts };
