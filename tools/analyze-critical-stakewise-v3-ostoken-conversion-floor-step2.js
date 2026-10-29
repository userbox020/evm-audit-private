#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WAD = 10n ** 18n;
const BPS = 10_000n;
const YEAR_SECONDS = 31_536_000n;
const DAY_SECONDS = 86_400n;
const SOURCE_COMMIT = "fc70cbe1b3d41bc5f78434830d837aa270ca33bc";
const SCHEMA = "critical-stakewise-v3-ostoken-conversion-floor-step2/v1";
const OUTPUT = "reports/raw/fast/critical-stakewise-v3-ostoken-conversion-floor-step2.json";
const REPORT = "reports/critical-stakewise-v3-ostoken-conversion-floor-step2.md";

const INPUTS = Object.freeze({
  step1Artifact: {
    path: "reports/raw/fast/critical-stakewise-v3-ostoken-step1.json",
    sha256: "0x9c7a86f821b25417562d7761fbc97ce476265afc22d27b55a2894fd07c4460c9",
  },
  step1Report: {
    path: "reports/critical-stakewise-v3-ostoken-step1.md",
    sha256: "0x7683ec8ed35f7724c192a20975a7b5262ee8b3b61a2a1f9976bb35ca1d88619d",
  },
  step1Manifest: {
    path: "reports/raw/fast/critical-stakewise-v3-ostoken-step1-manifest.json",
    sha256: "0xb300d8140bc36f17962227ebf162d33f3fed60f833150377ee09bbc9120ab822",
  },
  step1SourceClosure: {
    path: "reports/raw/fast/critical-stakewise-v3-ostoken-step1-source-closure.json",
    sha256: "0x758d091cdbeb6960548d1f3611aea7ba77923e1ac64733d9b16f73d2b10bb561",
  },
  step1FocusedCapture: {
    path: "reports/raw/fast/critical-stakewise-v3-ostoken-step1-focused.capture.json",
    sha256: "0x3bb15424ed7d7bb14b46c7c643f749e1878555724b5f2645e0417a861b327e4b",
  },
  step1HarnessBuildInfoCapture: {
    path: "reports/raw/fast/critical-stakewise-v3-ostoken-step1-harness-build-info.capture.json",
    sha256: "0xdb833d02879ec59644e6a79eaefd795a43caa602a68ac6bcc0c0d04fc031f161",
  },
  step1AuditOverlay: {
    path: "targets/stakewise-v3-core-v5.0.1/test/local/StakeWiseOsTokenStep1.t.sol",
    sha256: "0x47e8c77c6d6bb1b8af548289d98b4b6edce7753fbdd5c48cf4799a64a031e2de",
  },
  controller: {
    path: "targets/stakewise-v3-core-v5.0.1/contracts/tokens/OsTokenVaultController.sol",
    sha256: "0xa06da86214b87eabaa4d8639356d3e496f3c2e26c1333537c0b203480fa8a06d",
    ranges: [
      [84, 100, "0xd0170337eef6e7ede0f59c1c0cdcea8703fb9559f926ec11b3256e1d9fbfed93", "totalAssets and floor conversions"],
      [200, 228, "0xb1db6bd802af45ba7a8751017f8dd0469f2317e23b5f7fed7d9f642db26420fc", "cumulative fee preview"],
      [231, 280, "0x5357dde3aea000f7049312325ce7db0f31b78387de0ab74accf72b77b171e00b", "updateState fee mint and additive cumulative"],
      [283, 304, "0x67eab72559a7dc2abefb3171259abe19739c65dfc3243583cd508ca9cb0472f2", "zero-safe conversion internals"],
      [309, 318, "0xedf70964a4a4f020878a8f528938164ca529af2fff591da6d3032322f2a8e007", "reward accrual floor"],
    ],
  },
  vaultOsToken: {
    path: "targets/stakewise-v3-core-v5.0.1/contracts/vaults/modules/VaultOsToken.sol",
    sha256: "0x09e32b4d86695108e30863d4956e00f5b2813285d0e8f24740bf1ed2e7676da5",
    ranges: [
      [165, 209, "0x6cbbd91dd9656368cdad7c0522b15df10131dd41e5abe61d817f4f2c5d39d817", "position sync and max mint subtraction"],
      [271, 281, "0x04a2a4e341e405b06b4cbd6d5ef18d27ad8243f94eb4fb8dc7cf899adccd2838", "position cumulative fee synchronization"],
      [310, 313, "0x8f58353b706732a6662fc0bb8e109ba7bbb55b2c72f7282ff7f1555cfdf95443", "LTV max share conversion"],
    ],
  },
});

const HORIZONS = Object.freeze([30, 90, 365]);
const CADENCES = Object.freeze([
  { name: "daily", updatesPerDay: 1, dt: 86_400 },
  { name: "10x-daily", updatesPerDay: 10, dt: 8_640 },
]);
const FEES = Object.freeze([0, 100, 500, 1000, 2000, 5000, 10000]);
const REWARDS = Object.freeze([
  { label: "1%", annualWad: WAD / 100n },
  { label: "4%", annualWad: 4n * WAD / 100n },
  { label: "10%", annualWad: 10n * WAD / 100n },
  { label: "20%", annualWad: 20n * WAD / 100n },
  { label: "37.62%", annualWad: 3762n * WAD / 10_000n },
  { label: "50%", annualWad: 50n * WAD / 100n },
  { label: "100%", annualWad: WAD },
]);
const HAIRCUTS = Object.freeze([WAD, 99n * WAD / 100n, 95n * WAD / 100n, 90n * WAD / 100n]);
const COSTS_USD = Object.freeze([0, 50, 250, 1000]);
const PRICES_USD = Object.freeze([1000, 2000, 3000, 5000]);
const DEFAULT_LTV = 90n * WAD / 100n;

function sha256(value) {
  return `0x${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function digest(value) { return sha256(Buffer.from(canonical(value))); }
function floorMulDiv(a, b, d) {
  if (d === 0n) throw new Error("DIVISION_BY_ZERO");
  return a * b / d;
}
function ceilDiv(a, b) {
  if (b <= 0n) throw new Error("INVALID_DIVISOR");
  return a === 0n ? 0n : (a + b - 1n) / b;
}
function zeroSafeConvertToShares(assets, shares, assetBase) {
  if (assets === 0n || shares === 0n) return assets;
  return floorMulDiv(assets, shares, assetBase);
}
function annualToRatePerSecondWad(annualWad) { return annualWad / YEAR_SECONDS; }
function gapAssetsDifferenceOfFloors(headroom, implementationLiability, fairLiability, assets, shares) {
  if (headroom < fairLiability || fairLiability < implementationLiability) throw new Error("INVALID_HEADROOM_ORDER");
  if (shares <= 0n) throw new Error("INVALID_SHARE_SUPPLY");
  const implementationHeadroom = headroom - implementationLiability;
  const fairHeadroom = headroom - fairLiability;
  const implementationAssets = floorMulDiv(implementationHeadroom, assets, shares);
  const fairAssets = floorMulDiv(fairHeadroom, assets, shares);
  return implementationAssets - fairAssets;
}
function headroomFloorShift(result, offsetShares) {
  const offset = BigInt(offsetShares);
  if (offset < 0n) throw new Error("INVALID_HEADROOM_OFFSET");
  const headroom = result.fairLiability + offset;
  const arbitraryHeadroomGapAssets = gapAssetsDifferenceOfFloors(
    headroom, result.implementationLiability, result.fairLiability, result.assets, result.shares,
  );
  const conservativeHeadroomGapAssets = gapAssetsDifferenceOfFloors(
    result.fairLiability, result.implementationLiability, result.fairLiability, result.assets, result.shares,
  );
  const floorGapSharesAssets = floorMulDiv(result.gapShares, result.assets, result.shares);
  const shiftFromGapFloor = arbitraryHeadroomGapAssets - floorGapSharesAssets;
  return { offsetShares: offset, headroom, arbitraryHeadroomGapAssets, conservativeHeadroomGapAssets,
    floorGapSharesAssets, shiftFromGapFloor, absoluteShiftAtMostOne: shiftFromGapFloor >= 0n && shiftFromGapFloor <= 1n };
}

function recurrence(params) {
  let assets = BigInt(params.initialAssets);
  let shares = BigInt(params.initialShares);
  const initialPositionShares = BigInt(params.initialPositionShares);
  let cumulative = params.initialCumulative === undefined ? WAD : BigInt(params.initialCumulative);
  const initialCumulative = cumulative;
  let fairLiability = initialPositionShares;
  let everyUpdateLiability = initialPositionShares;
  const rate = BigInt(params.ratePerSecondWad);
  const elapsed = BigInt(params.elapsedEach);
  const feeBps = BigInt(params.feeBps);
  const updates = Number(params.updates);
  if (!Number.isSafeInteger(updates) || updates < 0) throw new Error("INVALID_UPDATES");
  for (let index = 0; index < updates; index += 1) {
    const oldAssets = assets;
    const oldShares = shares;
    const oldCumulative = cumulative;
    const profit = floorMulDiv(rate * oldAssets, elapsed, WAD);
    const feeAssets = floorMulDiv(profit, feeBps, BPS);
    const denominator = oldAssets + profit - feeAssets;
    const treasuryShares = zeroSafeConvertToShares(feeAssets, oldShares, denominator);
    assets = oldAssets + profit;
    shares = oldShares + treasuryShares;
    cumulative = oldCumulative + (oldShares === 0n ? 0n : floorMulDiv(treasuryShares, WAD, oldShares));
    fairLiability = oldShares === 0n ? fairLiability : floorMulDiv(fairLiability, shares, oldShares);
    everyUpdateLiability = oldCumulative === 0n
      ? everyUpdateLiability
      : floorMulDiv(everyUpdateLiability, cumulative, oldCumulative);
  }
  const implementationLiability = initialCumulative === 0n
    ? initialPositionShares
    : floorMulDiv(initialPositionShares, cumulative, initialCumulative);
  const gapShares = fairLiability > implementationLiability ? fairLiability - implementationLiability : 0n;
  const everySyncGapShares = fairLiability > everyUpdateLiability ? fairLiability - everyUpdateLiability : 0n;
  // H=F is the minimum fair headroom and a conservative evaluation point.
  const headroom = fairLiability;
  const implementationHeadroom = headroom > implementationLiability ? headroom - implementationLiability : 0n;
  const fairHeadroom = headroom > fairLiability ? headroom - fairLiability : 0n;
  const implementationHeadroomAssets = shares === 0n ? 0n : floorMulDiv(implementationHeadroom, assets, shares);
  const fairHeadroomAssets = shares === 0n ? 0n : floorMulDiv(fairHeadroom, assets, shares);
  const gapAssets = fairLiability >= implementationLiability
    ? gapAssetsDifferenceOfFloors(headroom, implementationLiability, fairLiability, assets, shares) : 0n;
  return {
    assets, shares, cumulative, implementationLiability, everyUpdateLiability, fairLiability,
    gapShares, everySyncGapShares, headroom, implementationHeadroomAssets, fairHeadroomAssets, gapAssets,
  };
}

function fairCapitalAssets(result, ltvWad = DEFAULT_LTV) {
  const fairAssets = result.shares === 0n ? result.fairLiability : floorMulDiv(result.fairLiability, result.assets, result.shares);
  return { fairLiabilityAssets: fairAssets, collateralCapitalAssets: ceilDiv(fairAssets * WAD, ltvWad) };
}

function economics(result, { haircutWad, costUsd, priceUsd, ltvWad = DEFAULT_LTV }) {
  const h = BigInt(haircutWad);
  const cost = BigInt(costUsd) * WAD;
  const price = BigInt(priceUsd);
  const realizedAssets = floorMulDiv(result.gapAssets, h, WAD);
  const grossUsdWad = realizedAssets * price;
  const netUsdWad = grossUsdWad - cost;
  const capital = fairCapitalAssets(result, ltvWad);
  const capitalUsdWad = capital.collateralCapitalAssets * price;
  const tenBpsCapitalUsdWad = floorMulDiv(capitalUsdWad, 10n, BPS);
  const thresholdUsdWad = tenBpsCapitalUsdWad > 1000n * WAD ? tenBpsCapitalUsdWad : 1000n * WAD;
  return {
    ...capital, realizedAssets, grossUsdWad, costUsdWad: cost, netUsdWad, capitalUsdWad,
    tenBpsCapitalUsdWad, thresholdUsdWad, passes: netUsdWad > thresholdUsdWad,
  };
}

function minimumHaircutWad(result, options) {
  if (!economics(result, { ...options, haircutWad: WAD }).passes) return null;
  let low = 0n; let high = WAD;
  while (low < high) {
    const mid = (low + high) / 2n;
    if (economics(result, { ...options, haircutWad: mid }).passes) high = mid;
    else low = mid + 1n;
  }
  return low;
}

function binarySearchFirst(low, high, predicate) {
  let left = BigInt(low); let right = BigInt(high);
  if (!predicate(right)) return null;
  while (left < right) {
    const mid = (left + right) / 2n;
    if (predicate(mid)) right = mid;
    else left = mid + 1n;
  }
  return left;
}

function scenario(initialAssets, annualWad, feeBps, days, updatesPerDay = 1) {
  const initial = BigInt(initialAssets);
  return recurrence({
    initialAssets: initial, initialShares: initial, initialPositionShares: initial,
    ratePerSecondWad: annualToRatePerSecondWad(BigInt(annualWad)),
    elapsedEach: DAY_SECONDS / BigInt(updatesPerDay), updates: days * updatesPerDay, feeBps,
  });
}

function bpsAboveInitial(result, initialAssets) {
  return floorMulDiv(result.gapAssets, BPS, BigInt(initialAssets));
}

function annualRewardFrontier() {
  const initial = 20n * WAD;
  const predicate = (annualWad) => scenario(initial, annualWad, 1000, 365, 1).gapAssets * BPS > initial * 10n;
  const annualWad = binarySearchFirst(0n, 10n * WAD, predicate);
  const result = scenario(initial, annualWad, 1000, 365, 1);
  const prior = annualWad === 0n ? null : scenario(initial, annualWad - 1n, 1000, 365, 1);
  return { method: "LOCAL_BISECTION_CROSSING_NO_GLOBAL_MINIMALITY_CLAIM",
    declaredDomain: { annualWadLow: 0n, annualWadHigh: 10n * WAD },
    annualWad, ratePerSecondWad: annualToRatePerSecondWad(annualWad), result,
    predecessorChecked: true, priorPasses: prior ? prior.gapAssets * BPS > initial * 10n : false };
}

function holdingHorizonFrontier() {
  const initial = 20n * WAD; const annual = 4n * WAD / 100n;
  const bound = 15 * 365;
  let first = null; let result = null; let priorPasses = false; let earlierPassingDays = 0;
  for (let days = 1; days <= bound; days += 1) {
    const candidate = scenario(initial, annual, 1000, days, 1);
    const passes = candidate.gapAssets * BPS > initial * 10n;
    if (passes && first === null) { first = days; result = candidate; }
    else if (passes && first === null) earlierPassingDays += 1;
    if (first !== null && days === first - 1) priorPasses = passes;
  }
  if (first === null) return null;
  const prior = first === 1 ? null : scenario(initial, annual, 1000, first - 1, 1);
  priorPasses = prior ? prior.gapAssets * BPS > initial * 10n : false;
  return { method: "EXHAUSTIVE_ENUMERATION", declaredDomainDays: { first: 1, last: bound },
    days: BigInt(first), result, priorPasses, earlierPassingDays };
}

function initialPositionLocalBisectionCrossing(params) {
  const predicate = (initial) => economics(
    recurrence({
      initialAssets: initial, initialShares: initial, initialPositionShares: initial,
      ratePerSecondWad: params.ratePerSecondWad, elapsedEach: params.elapsedEach,
      updates: params.updates, feeBps: params.feeBps,
    }), params.economics,
  ).passes;
  let upper = WAD;
  while (!predicate(upper) && upper < 1_000_000_000n * WAD) upper *= 2n;
  const initial = binarySearchFirst(1n, upper, predicate);
  if (initial === null) return null;
  const result = recurrence({
    initialAssets: initial, initialShares: initial, initialPositionShares: initial,
    ratePerSecondWad: params.ratePerSecondWad, elapsedEach: params.elapsedEach,
    updates: params.updates, feeBps: params.feeBps,
  });
  return { method: "LOCAL_BISECTION_CROSSING_NO_GLOBAL_MINIMALITY_CLAIM",
    declaredDomainRaw: { low: 1n, high: upper }, initial, result, economic: economics(result, params.economics),
    predecessorChecked: true, priorPasses: initial > 1n ? predicate(initial - 1n) : false };
}

function sourceLineBytes(bytes, start, end) {
  const lines = bytes.toString("utf8").split(/\r?\n/);
  return Buffer.from(`${lines.slice(start - 1, end).join("\n")}\n`, "utf8");
}

function verifyInputs(root = ROOT, readFile = fs.readFileSync) {
  const records = {};
  for (const [name, input] of Object.entries(INPUTS)) {
    const bytes = readFile(path.join(root, ...input.path.split("/")));
    if (sha256(bytes) !== input.sha256) throw new Error(`INPUT_HASH_MISMATCH:${name}`);
    const record = { path: input.path, sha256: input.sha256 };
    if (input.ranges) {
      record.ranges = input.ranges.map(([start, end, expected, purpose]) => {
        const actual = sha256(sourceLineBytes(bytes, start, end));
        if (actual !== expected) throw new Error(`SOURCE_RANGE_HASH_MISMATCH:${name}:${start}-${end}`);
        return { start, end, sha256: expected, purpose };
      });
    }
    records[name] = record;
  }
  const step1 = JSON.parse(readFile(path.join(root, ...INPUTS.step1Artifact.path.split("/")), "utf8"));
  if (step1.scope?.sourceCommit !== SOURCE_COMMIT) throw new Error("SOURCE_COMMIT_MISMATCH");
  const manifest = JSON.parse(readFile(path.join(root, ...INPUTS.step1Manifest.path.split("/")), "utf8"));
  if (manifest.findingId !== "stakewise-v3-ostoken-step1"
    || manifest.aggregateSha256 !== "e00aacc7af5323b5b2dec009fb68a5c35819ff1bd89386f62d2dc09cdc19a1b3"
    || !manifest.artifacts?.some((row) => row.path === INPUTS.step1AuditOverlay.path
      && `0x${row.sha256}` === INPUTS.step1AuditOverlay.sha256)) throw new Error("STEP1_MANIFEST_INVALID");
  const sourceClosure = JSON.parse(readFile(path.join(root, ...INPUTS.step1SourceClosure.path.split("/")), "utf8"));
  if (sourceClosure.sourceCommit !== SOURCE_COMMIT || sourceClosure.sourceTag !== "v5.0.1"
    || sourceClosure.compiler !== "solc 0.8.26") throw new Error("STEP1_SOURCE_CLOSURE_INVALID");
  for (const [name, captureName] of [["step1FocusedCapture", "focused"], ["step1HarnessBuildInfoCapture", "harness-build-info"]]) {
    const capture = JSON.parse(readFile(path.join(root, ...INPUTS[name].path.split("/")), "utf8"));
    if (capture.capture !== captureName || capture.exitCode !== 0 || capture.networkReads !== 0 || capture.rpcReads !== 0
      || capture.endpointOrSecretEnvironmentValuesConsumed !== 0) throw new Error(`STEP1_CAPTURE_INVALID:${name}`);
  }
  return records;
}

function stringifyBigInts(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(stringifyBigInts);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, stringifyBigInts(child)]));
  return value;
}

function compactResult(result) {
  return stringifyBigInts({
    terminalAssets: result.assets, terminalShares: result.shares, cumulativeFeePerShare: result.cumulative,
    implementationLiability: result.implementationLiability, everyUpdateLiability: result.everyUpdateLiability,
    fairLiability: result.fairLiability, gapShares: result.gapShares,
    everySyncGapShares: result.everySyncGapShares, gapAssets: result.gapAssets,
  });
}

function compareRatio(left, right) {
  const lhs = left.result.gapAssets * right.capital.collateralCapitalAssets;
  const rhs = right.result.gapAssets * left.capital.collateralCapitalAssets;
  if (lhs === rhs) return left.key.localeCompare(right.key);
  return lhs > rhs ? -1 : 1;
}

function buildArtifact(root = ROOT, readFile = fs.readFileSync) {
  const inputBindings = verifyInputs(root, readFile);
  const aggressive = recurrence({
    initialAssets: 20n * WAD, initialShares: 20n * WAD, initialPositionShares: 20n * WAD,
    ratePerSecondWad: 10n ** 14n, elapsedEach: 1000n, updates: 10, feeBps: 1000,
  });
  const realistic = scenario(20n * WAD, 4n * WAD / 100n, 1000, 365, 1);

  const modelCells = [];
  const evaluations = [];
  for (const horizonDays of HORIZONS) for (const cadence of CADENCES) for (const feeBps of FEES) for (const reward of REWARDS) {
    const result = scenario(20n * WAD, reward.annualWad, feeBps, horizonDays, cadence.updatesPerDay);
    const capital = fairCapitalAssets(result);
    const key = `${horizonDays}d/${cadence.name}/${feeBps}bps/${reward.label}`;
    const cell = { key, horizonDays, cadence: cadence.name, updates: horizonDays * cadence.updatesPerDay,
      elapsedEach: cadence.dt, feeBps, annualReward: reward.label, annualWad: reward.annualWad,
      ratePerSecondWad: annualToRatePerSecondWad(reward.annualWad), result, capital };
    modelCells.push(cell);
    for (const haircutWad of HAIRCUTS) for (const costUsd of COSTS_USD) for (const priceUsd of PRICES_USD) {
      const economic = economics(result, { haircutWad, costUsd, priceUsd });
      evaluations.push({ key, haircutWad, costUsd, priceUsd, passes: economic.passes,
        grossUsdWad: economic.grossUsdWad, netUsdWad: economic.netUsdWad, thresholdUsdWad: economic.thresholdUsdWad });
    }
  }
  const realisticCells = modelCells.filter((cell) => cell.feeBps <= 2000 && cell.annualWad <= 20n * WAD / 100n);
  const tenBps = (cell) => cell.result.gapAssets * BPS > cell.capital.collateralCapitalAssets * 10n;
  const ranked = [...modelCells].sort(compareRatio);
  const realisticTenBps = realisticCells.filter(tenBps);
  const allTenBps = modelCells.filter(tenBps);
  const promotionPasses = evaluations.filter((row) => row.passes);
  let headroomCheckCount = 0; let headroomMaxShiftRaw = 0n; let headroomEconomicPassFlips = 0;
  let headroomMaxGrossUsdWadDelta = 0n;
  for (const cell of modelCells) {
    const offsets = [0n, 1n, cell.result.shares / 7n, cell.result.shares, 10n * cell.result.shares + 7n];
    for (const offset of offsets) {
      const check = headroomFloorShift(cell.result, offset); headroomCheckCount += 1;
      if (!check.absoluteShiftAtMostOne) throw new Error("HEADROOM_FLOOR_SHIFT_BOUND_FAILED");
      if (check.shiftFromGapFloor > headroomMaxShiftRaw) headroomMaxShiftRaw = check.shiftFromGapFloor;
      for (const haircutWad of HAIRCUTS) for (const costUsd of COSTS_USD) for (const priceUsd of PRICES_USD) {
        const base = economics(cell.result, { haircutWad, costUsd, priceUsd });
        const shifted = economics({ ...cell.result, gapAssets: check.arbitraryHeadroomGapAssets }, { haircutWad, costUsd, priceUsd });
        if (base.passes !== shifted.passes) headroomEconomicPassFlips += 1;
        const delta = shifted.grossUsdWad >= base.grossUsdWad
          ? shifted.grossUsdWad - base.grossUsdWad : base.grossUsdWad - shifted.grossUsdWad;
        if (delta > headroomMaxGrossUsdWadDelta) headroomMaxGrossUsdWadDelta = delta;
      }
    }
  }

  const annualFrontier = annualRewardFrontier();
  const horizonFrontier = holdingHorizonFrontier();
  const fourPercentFullFee = scenario(20n * WAD, 4n * WAD / 100n, 10_000, 365, 1);
  const scaleReference = scenario(WAD, 4n * WAD / 100n, 1000, 365, 1);
  const scaleChecks = [1n, 20n, 1000n, 100000n].map((scale) => {
    const result = scenario(scale * WAD, 4n * WAD / 100n, 1000, 365, 1);
    const gapDeviation = result.gapShares - scaleReference.gapShares * scale;
    const assetDeviation = result.gapAssets - scaleReference.gapAssets * scale;
    return { scaleAssets: scale, result, gapDeviation, assetDeviation,
      floorBoundRaw: 365n * scale,
      withinFloorBound: gapDeviation >= 0n && gapDeviation <= 365n * scale && assetDeviation >= 0n && assetDeviation <= 365n * scale };
  });

  const localCrossingCases = [
    { label: "h=1.00 K=$0", haircutWad: WAD, costUsd: 0 },
    { label: "h=0.99 K=$50", haircutWad: 99n * WAD / 100n, costUsd: 50 },
    { label: "h=0.95 K=$250", haircutWad: 95n * WAD / 100n, costUsd: 250 },
    { label: "h=0.90 K=$1000", haircutWad: 90n * WAD / 100n, costUsd: 1000 },
  ].map((entry) => {
    const found = initialPositionLocalBisectionCrossing({
      ratePerSecondWad: 10n ** 14n, elapsedEach: 1000n, updates: 10, feeBps: 1000,
      economics: { haircutWad: entry.haircutWad, costUsd: entry.costUsd, priceUsd: 3000 },
    });
    return { ...entry, priceUsd: 3000, ...found };
  });
  const aggressiveLarge = recurrence({
    initialAssets: 1000n * WAD, initialShares: 1000n * WAD, initialPositionShares: 1000n * WAD,
    ratePerSecondWad: 10n ** 14n, elapsedEach: 1000n, updates: 10, feeBps: 1000,
  });
  const hMinAggressive = minimumHaircutWad(aggressiveLarge, { costUsd: 250, priceUsd: 3000 });
  const hMinRealistic = minimumHaircutWad(
    scenario(100000n * WAD, 4n * WAD / 100n, 1000, 365, 1), { costUsd: 0, priceUsd: 3000 },
  );

  const artifact = {
    schema: SCHEMA,
    schemaVersion: 1,
    findingId: "stakewise-v3-ostoken-conversion-floor-step2",
    generatedBy: "tools/analyze-critical-stakewise-v3-ostoken-conversion-floor-step2.js",
    deterministic: true,
    scope: {
      sourceTag: "v5.0.1", sourceCommit: SOURCE_COMMIT, mode: "offline-source-and-arithmetic-only",
      deployedConfigurationClaimed: false, currentStateClaimed: false, exitLiquidityClaimed: false,
      initialCumulativeFeePerShare: WAD.toString(), defaultLtvWad: DEFAULT_LTV.toString(),
    },
    inputBindings,
    recurrence: {
      profit: "floor(ratePerSecondWad*A*dt/1e18)", fee: "floor(profit*feeBps/10000)",
      treasuryShares: "fee==0||S==0 ? fee : floor(fee*S/(A+profit-fee))",
      nextAssets: "A+profit", nextShares: "S+treasuryShares",
      nextCumulative: "C+floor(treasuryShares*1e18/S)",
      lazyLiability: "floor(Q0*Cn/C0)", everyUpdateLiability: "iterated floor(I*Cnext/C)",
      fairLiability: "iterated floor(F*Snext/S)",
      arbitraryHeadroomGapAssets: "floor((H-I)*A/S)-floor((H-F)*A/S), H>=F>=I",
      conservativeEvaluation: "H=F is minimum fair headroom, not the exact value for arbitrary H",
      floorShiftLemma: "for d=F-I and x=H-F, floor((x+d)A/S)-floor(xA/S) differs from floor(dA/S) by 0 or 1 raw asset unit",
    },
    lineage: {
      arithmeticReproduction: "exact recurrence outputs reproduced from hash-bound source and retained Step1 package",
      fullStep1LineageAuthorityClaimed: false,
      reason: "Step1 test/local audit harness is a retained untracked audit overlay; hashes bind retained bytes but do not make it production source or full git-tracked lineage",
      auditOverlay: { path: INPUTS.step1AuditOverlay.path, sha256: INPUTS.step1AuditOverlay.sha256,
        tracking: "UNTRACKED_AUDIT_OVERLAY", productionSource: false },
      retainedManifestAggregateSha256: "e00aacc7af5323b5b2dec009fb68a5c35819ff1bd89386f62d2dc09cdc19a1b3",
    },
    anchors: {
      aggressiveStep1: {
        parameters: { initialAssets: (20n * WAD).toString(), initialShares: (20n * WAD).toString(),
          initialPositionShares: (20n * WAD).toString(), ratePerSecondWad: "100000000000000", elapsedEach: 1000, updates: 10, feeBps: 1000 },
        ...compactResult(aggressive),
      },
      realistic4Percent: {
        parameters: { initialAssets: (20n * WAD).toString(), annualRewardWad: (4n * WAD / 100n).toString(),
          ratePerSecondWad: annualToRatePerSecondWad(4n * WAD / 100n).toString(), elapsedEach: 86400, updates: 365, feeBps: 1000 },
        ...compactResult(realistic),
        gapBpsOfInitialPositionWad: floorMulDiv(realistic.gapAssets, BPS * WAD, 20n * WAD).toString(),
        terminalFairCapital: stringifyBigInts(fairCapitalAssets(realistic)),
      },
    },
    sweep: {
      dimensions: { horizonsDays: HORIZONS, cadences: CADENCES, feesBps: FEES,
        annualRewards: REWARDS.map((row) => ({ label: row.label, annualWad: row.annualWad.toString(), ratePerSecondWad: annualToRatePerSecondWad(row.annualWad).toString() })),
        realizationWad: HAIRCUTS.map(String), costsUsd: COSTS_USD, assetPricesUsd: PRICES_USD },
      modelCellCount: modelCells.length, economicEvaluationCount: evaluations.length,
      modelDigest: digest(stringifyBigInts(modelCells.map((cell) => ({ key: cell.key, result: compactResult(cell.result) })))),
      economicsDigest: digest(stringifyBigInts(evaluations)),
      tenBpsCapitalRatioCells: allTenBps.length,
      analystSelectedGridDefinition: "annualReward<=20%, fee<=2000bps, horizon<=365d; not deployed bounds",
      deployedBoundsClaimed: false,
      analystSelectedGridCellCount: realisticCells.length,
      analystSelectedGridTenBpsCapitalRatioCells: realisticTenBps.length,
      promotionPassCountAt20AssetPosition: promotionPasses.length,
      promotionPassesOnlyExtremeRewardOrFee: promotionPasses.every((row) => {
        const cell = modelCells.find((candidate) => candidate.key === row.key);
        return cell.annualWad > 20n * WAD / 100n || cell.feeBps > 2000;
      }),
      topCapitalRatioCells: ranked.slice(0, 12).map((cell) => ({ key: cell.key,
        gapAssets: cell.result.gapAssets.toString(), collateralCapitalAssets: cell.capital.collateralCapitalAssets.toString(),
        ratioBpsWad: floorMulDiv(cell.result.gapAssets, BPS * WAD, cell.capital.collateralCapitalAssets).toString(),
        inAnalystSelectedGrid: cell.annualWad <= 20n * WAD / 100n && cell.feeBps <= 2000 })),
    },
    headroomSensitivity: {
      lemma: "absolute (±1) difference from floor(gapShares*A/S) is at most one raw asset unit for H>=F>=I; under this ordering the carry is specifically 0 or +1",
      proofSketch: "write x=H-F, d=F-I, and q=A/S; floor((x+d)q)-floor(xq)=floor(dq)+carry with carry in {0,1}",
      sampledOffsetsPerCell: ["0", "1", "S/7", "S", "10*S+7"],
      checkedModelCells: modelCells.length, checkCount: headroomCheckCount,
      maximumAbsoluteShiftRawAssetUnits: headroomMaxShiftRaw.toString(),
      economicEvaluationPassFlips: headroomEconomicPassFlips,
      maximumGrossUsdWadDelta: headroomMaxGrossUsdWadDelta.toString(),
      economicsClassificationUnchanged: headroomEconomicPassFlips === 0,
      aggressiveOffsets: [0n, 1n, aggressive.shares / 7n, aggressive.shares, 10n * aggressive.shares + 7n]
        .map((offset) => stringifyBigInts(headroomFloorShift(aggressive, offset))),
      realisticOffsets: [0n, 1n, realistic.shares / 7n, realistic.shares, 10n * realistic.shares + 7n]
        .map((offset) => stringifyBigInts(headroomFloorShift(realistic, offset))),
    },
    boundaries: {
      annualRewardFrontierFee10Daily365: {
        method: annualFrontier.method,
        declaredDomain: stringifyBigInts(annualFrontier.declaredDomain),
        annualWad: annualFrontier.annualWad.toString(),
        ratePerSecondWad: annualFrontier.ratePerSecondWad.toString(),
        gapShares: annualFrontier.result.gapShares.toString(), gapAssets: annualFrontier.result.gapAssets.toString(),
        strictAbove10BpsInitial: annualFrontier.result.gapAssets * BPS > 20n * WAD * 10n,
        predecessorChecked: annualFrontier.predecessorChecked,
        priorAnnualWadPasses: annualFrontier.priorPasses,
      },
      fourPercentRewardFullFee365: {
        gapShares: fourPercentFullFee.gapShares.toString(), gapAssets: fourPercentFullFee.gapAssets.toString(),
        ratioBpsWad: floorMulDiv(fourPercentFullFee.gapAssets, BPS * WAD, 20n * WAD).toString(),
        below10BpsInitial: fourPercentFullFee.gapAssets * BPS < 20n * WAD * 10n,
      },
      holdingFrontier4PercentFee10Daily: {
        method: horizonFrontier.method,
        declaredDomainDays: horizonFrontier.declaredDomainDays,
        days: horizonFrontier.days.toString(), yearsWad: floorMulDiv(horizonFrontier.days, WAD, 365n).toString(),
        gapShares: horizonFrontier.result.gapShares.toString(), gapAssets: horizonFrontier.result.gapAssets.toString(),
        strictAbove10BpsInitial: horizonFrontier.result.gapAssets * BPS > 20n * WAD * 10n,
        priorDayPasses: horizonFrontier.priorPasses, earlierPassingDays: horizonFrontier.earlierPassingDays,
        searchBoundDays: 15 * 365,
      },
      aggressiveLocalBisectionCrossingsAt3000Usd: localCrossingCases.map((row) => ({
        label: row.label, haircutWad: row.haircutWad.toString(), costUsd: row.costUsd, priceUsd: row.priceUsd,
        method: row.method, declaredDomainRaw: stringifyBigInts(row.declaredDomainRaw), predecessorChecked: row.predecessorChecked,
        initialAssets: row.initial.toString(), gapAssets: row.result.gapAssets.toString(),
        collateralCapitalAssets: row.economic.collateralCapitalAssets.toString(),
        capitalUsdWad: row.economic.capitalUsdWad.toString(), netUsdWad: row.economic.netUsdWad.toString(),
        thresholdUsdWad: row.economic.thresholdUsdWad.toString(), passes: row.economic.passes, priorRawUnitPasses: row.priorPasses,
      })),
      hMin: {
        method: "EXACT_MONOTONE_BISECTION_OVER_INTEGER_H_WAD",
        monotonicity: "floor(G_a*h/1e18) is nondecreasing in h while cost and threshold are fixed",
        aggressive1000AssetsPrice3000Cost250Wad: hMinAggressive === null ? null : hMinAggressive.toString(),
        aggressiveImpossibleIfAtLeastOne: hMinAggressive === null || hMinAggressive >= WAD,
        selectedGrid4Percent100000AssetsPrice3000Cost0Wad: hMinRealistic === null ? null : hMinRealistic.toString(),
        selectedGrid4PercentImpossibleIfAtLeastOne: hMinRealistic === null || hMinRealistic >= WAD,
      },
    },
    sampledScaleSanityChecks: {
      status: "SAMPLED_SANITY_CHECK_NOT_A_HOMOGENEITY_THEOREM",
      samples: ["1", "20", "1000", "100000"],
      empiricalBoundDescription: "for these four 4%-reward/10%-fee/daily-365 samples only, deviations from one-asset linear scaling are <=365*scale raw units",
      rows: scaleChecks.map((row) => ({ scaleAssets: row.scaleAssets.toString(), ...compactResult(row.result),
      gapDeviationFromOneAssetLinearRaw: row.gapDeviation.toString(), assetDeviationFromOneAssetLinearRaw: row.assetDeviation.toString(),
      empiricalFloorBoundRaw: row.floorBoundRaw.toString(), withinEmpiricalBound: row.withinFloorBound })),
    },
    comparison: {
      yearnKnownBps: "0.04656",
      use: "rotation rationale only; Yearn is outside StakeWise scope",
      stakewiseRealisticInitialPositionBpsWad: floorMulDiv(realistic.gapAssets, BPS * WAD, 20n * WAD).toString(),
    },
    classification: {
      sourcePrimitive: "CONFIRMED",
      localDirectExtraMint: "CONFIRMED_STEP1",
      analystSelectedGridMaterialityWithin365Days: realisticTenBps.length === 0 ? "BELOW_10BPS_CONSERVATIVE_CAPITAL" : "ABOVE_10BPS",
      deployedClassification: "NONE",
      syntheticFrontier: allTenBps.length > 0 ? "EXTREME_REWARD_OR_FEE_ONLY" : "NONE",
      deployedConfiguration: "UNVERIFIED",
      exit: "UNVERIFIED",
      conservativeNet: "NOT_ESTABLISHED",
      deploymentCaptureDecision: realisticTenBps.length === 0 ? "DEFER_ROTATE" : "JUSTIFIED",
      nextFallback: "Symbiotic named-deployment path",
    },
    gates: { sourcePrimitive: 1, localDirectExtraMint: 1, analystSelectedGridMateriality: 0,
      routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false },
    security: { networkReads: 0, protectedFilesRead: 0, rpcReads: 0, transactions: 0, signing: false,
      broadcasts: 0, mutations: 0, privateKeys: 0, providerMaterialAbsent: true, productionSourceEdits: 0 },
  };
  return artifact;
}

function decimalWad(value, digits = 6) {
  const raw = BigInt(value); const whole = raw / WAD; const fraction = (raw % WAD).toString().padStart(18, "0").slice(0, digits).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
function usd(value) { return `$${decimalWad(value, 18)}`; }

function renderReport(artifact) {
  const a = artifact.anchors.aggressiveStep1;
  const r = artifact.anchors.realistic4Percent;
  const annual = artifact.boundaries.annualRewardFrontierFee10Daily365;
  const horizon = artifact.boundaries.holdingFrontier4PercentFee10Daily;
  const minimumRows = artifact.boundaries.aggressiveLocalBisectionCrossingsAt3000Usd.map((row) =>
    `| ${row.label} | ${decimalWad(row.initialAssets, 9)} | ${decimalWad(row.collateralCapitalAssets, 9)} | ${usd(row.capitalUsdWad)} | ${usd(row.netUsdWad)} |`,
  ).join("\n");
  const topRows = artifact.sweep.topCapitalRatioCells.slice(0, 8).map((row) =>
    `| ${row.key} | ${decimalWad(row.gapAssets, 12)} | ${decimalWad(row.ratioBpsWad, 6)} | ${row.inAnalystSelectedGrid} |`,
  ).join("\n");
  return `# StakeWise V3 osToken Conversion-Floor Step 2\n\n`+
`**Classification: SOURCE PRIMITIVE CONFIRMED / ANALYST-SELECTED <=365-DAY GRID BELOW 10BPS OF CONSERVATIVE COLLATERAL / NO DEPLOYMENT CLASSIFICATION / CAPTURE DEFERRED**\n\n`+
`## Scope and source binding\n\n`+
`This is deterministic offline BigInt analysis only. It binds Step 1 and StakeWise V3 tag \`v5.0.1\` commit \`${SOURCE_COMMIT}\`, including exact whole-file and line-range SHA-256 commitments for \`OsTokenVaultController\` update/conversion logic and \`VaultOsToken\` fee sync/max mint logic. It also binds the retained Step 1 manifest, source-closure manifest, focused capture, harness build-info capture, and audit overlay. The \`test/local/StakeWiseOsTokenStep1.t.sol\` harness is an untracked retained audit overlay: hashing its bytes supports arithmetic reproduction but does not create full git-tracked lineage authority or make it production source. This package makes no deployed configuration, current-state, liquidity, exit, runtime, or profit claim. No production source was edited.\n\n`+
`## Exact recurrence\n\n`+
`Every division floors exactly as Solidity: \`p=floor(r*A*dt/1e18)\`, \`f=floor(p*fee/10000)\`, \`m=floor(f*S/(A+p-f))\` with the source's zero-safe conversion, \`A'=A+p\`, \`S'=S+m\`, and \`C'=C+floor(m*1e18/S)\`. Lazy implementation liability is \`floor(Q0*Cn/C0)\`; every-update sync applies its floor at every step; fair liability applies \`floor(F*S'/S)\` at every step. For arbitrary sufficient headroom \`H>=F>=I\`, realizable extra debt is \`floor((H-I)*A/S)-floor((H-F)*A/S)\`. The reported \`H=F\` anchor is the conservative minimum-fair-headroom evaluation, not the exact arbitrary-headroom value. Writing \`x=H-F\` and \`d=F-I\` proves the floor-shift is \`floor((x+d)A/S)-floor(xA/S)=floor(dA/S)+carry\`, where carry is 0 or 1. Thus the absolute sensitivity is within ±1 raw asset unit (specifically 0/+1 under this ordering). Across ${artifact.headroomSensitivity.checkCount} sampled headroom offsets, the maximum shift is ${artifact.headroomSensitivity.maximumAbsoluteShiftRawAssetUnits} raw asset unit, the maximum gross sensitivity is $${decimalWad(artifact.headroomSensitivity.maximumGrossUsdWadDelta, 18)}, promotion flips are ${artifact.headroomSensitivity.economicEvaluationPassFlips}, and economics classification is unchanged.\n\n`+
`## Anchor reproductions\n\n`+
`The aggressive Step 1 anchor reproduces terminal assets \`${a.terminalAssets}\`, supply/fair liability \`${a.terminalShares}\`, implementation liability \`${a.implementationLiability}\`, gap \`${a.gapShares}\` shares, and exact extra debt assets \`${a.gapAssets}\` (required \`183789151273036805\`).\n\n`+
`The 4% annual, 10% fee, daily one-year anchor reproduces \`${r.gapShares}\` gap shares and \`${r.gapAssets}\` gap assets, or \`${decimalWad(r.gapBpsOfInitialPositionWad, 8)}\` bps of the initial 20-asset position before conservative collateral adjustment. Its full-fee control remains below 10bps.\n\n`+
`## Sweep and boundaries\n\n`+
`The complete sweep contains \`${artifact.sweep.modelCellCount}\` recurrence cells and \`${artifact.sweep.economicEvaluationCount}\` realization/cost/price evaluations. The <=20% reward, <=20% fee, <=365-day subset is an analyst-selected grid, not a deployed bound or deployment classification. Within that grid, \`${artifact.sweep.analystSelectedGridTenBpsCapitalRatioCells}\` cells clear 10bps of conservative fair-liability collateral. Any >10bps cells require reward >20% or fee >20%; passes at the fixed 20-asset scale are extreme-only.\n\n`+
`At 10% fee with daily updates for 365 days, local bisection over the declared annual-WAD domain returns crossing \`${annual.annualWad}\` (per-second WAD \`${annual.ratePerSecondWad}\`), and the immediate predecessor fails; no global minimality theorem is claimed for that raw-WAD domain. Exact exhaustive enumeration of every holding day 1..5475 confirms the true first daily crossing at 4% reward and 10% fee is \`${horizon.days}\` days (\`${decimalWad(horizon.yearsWad, 6)}\` years), beyond the <=365-day decision scope.\n\n`+
`| Highest gap/capital cells | Gap assets | Ratio (bps) | In analyst-selected grid |\n|---|---:|---:|:---:|\n${topRows}\n\n`+
`## Conservative economics\n\n`+
`Collateral capital is the terminal fair-liability asset value, ceil-divided by 90% LTV. Gross is \`h*G_a*price\`, net is gross minus fixed cost, and promotion is strict \`net > max($1,000, 10bps capital)\`. The 20-asset aggressive anchor does not clear $1,000 even at $5,000/asset and h=1. Local raw-unit bisection crossings at $3,000 are shown below; each crossing and immediate predecessor were checked, but no global initial-position monotonicity/minimum theorem is claimed:\n\n`+
`| Realization/cost | Initial assets | Conservative collateral assets | Capital USD | Net USD |\n|---|---:|---:|---:|---:|\n${minimumRows}\n\n`+
`The 4%/10% one-year ratio cannot pass at any \`h<=1\`, even at the sampled 100,000-asset position, because it remains below the 10bps capital threshold. Scale results at 1, 20, 1,000, and 100,000 assets are sampled sanity checks only. Their deviations fit the reported empirical \`365*scale\` raw-unit bound; this is not a homogeneity theorem or a bound outside those samples.\n\n`+
`## Decision and gates\n\n`+
`The source primitive and Step 1 local direct extra mint remain confirmed as retained local evidence. The analyst-selected <=365-day grid does not clear 10bps after full-collateral LTV adjustment; only extreme reward/fee cells cross the synthetic frontier. No deployment is classified. Current deployment configuration and an executable exit are unverified, so conservative net is not established and deployment capture is deferred. Rotate to the Symbiotic named-deployment fallback. Yearn's known \`0.04656\`bps is cited only as rotation rationale and is outside this scope.\n\n`+
`Gates remain \`sourcePrimitive=1\`, \`localDirectExtraMint=1\`, \`analystSelectedGridMateriality=0\`, \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`, \`fork=false\`. No network, protected inventory, RPC, transaction, signing, broadcast, mutation, private key, provider material, or production source edit was used.\n`;
}

function serializeArtifact(artifact) { return `${JSON.stringify(artifact, null, 2)}\n`; }

function writeOutputs(root = ROOT) {
  const artifact = buildArtifact(root);
  fs.writeFileSync(path.join(root, ...OUTPUT.split("/")), serializeArtifact(artifact), "utf8");
  fs.writeFileSync(path.join(root, ...REPORT.split("/")), renderReport(artifact), "utf8");
  return artifact;
}

if (require.main === module) {
  try {
    if (process.argv.length !== 2 && !(process.argv.length === 3 && process.argv[2] === "--write")) throw new Error("USAGE");
    const artifact = process.argv[2] === "--write" ? writeOutputs(ROOT) : buildArtifact(ROOT);
    process.stdout.write(`${JSON.stringify({ schema: artifact.schema, classification: artifact.classification,
      modelCellCount: artifact.sweep.modelCellCount, deploymentCaptureDecision: artifact.classification.deploymentCaptureDecision })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schema: SCHEMA, status: "REJECTED", errorClass: /^[A-Z0-9_:.-]+$/.test(error.message || "") ? error.message : "UNEXPECTED" })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  WAD, BPS, YEAR_SECONDS, SOURCE_COMMIT, SCHEMA, OUTPUT, REPORT, INPUTS, HORIZONS, CADENCES, FEES, REWARDS,
  HAIRCUTS, COSTS_USD, PRICES_USD, DEFAULT_LTV, sha256, canonical, digest, floorMulDiv, ceilDiv,
  zeroSafeConvertToShares, annualToRatePerSecondWad, gapAssetsDifferenceOfFloors, headroomFloorShift, recurrence, fairCapitalAssets, economics,
  minimumHaircutWad, binarySearchFirst, scenario, bpsAboveInitial, annualRewardFrontier,
  holdingHorizonFrontier, initialPositionLocalBisectionCrossing, sourceLineBytes, verifyInputs, stringifyBigInts,
  compactResult, buildArtifact, renderReport, serializeArtifact, writeOutputs,
};
