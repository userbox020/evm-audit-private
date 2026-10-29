"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const model = require("./analyze-critical-stakewise-v3-ostoken-conversion-floor-step2.js");

const ROOT = path.resolve(__dirname, "..");
const WAD = model.WAD;
let artifact;

test.before(() => { artifact = model.buildArtifact(ROOT); });

test("aggressive Step1 anchor reproduces every exact terminal", () => {
  const row = artifact.anchors.aggressiveStep1;
  assert.equal(row.terminalAssets, "51874849202000000000");
  assert.equal(row.terminalShares, "21912496909009018158");
  assert.equal(row.cumulativeFeePerShare, "1091743119266055040");
  assert.equal(row.implementationLiability, "21834862385321100800");
  assert.equal(row.everyUpdateLiability, "21834862385321100800");
  assert.equal(row.fairLiability, "21912496909009018158");
  assert.equal(row.gapShares, "77634523687917358");
  assert.equal(row.gapAssets, "183789151273036805");
});

test("realistic 4 percent daily anchor reproduces exact floors", () => {
  const row = artifact.anchors.realistic4Percent;
  assert.equal(row.parameters.ratePerSecondWad, "1268391679");
  assert.equal(row.gapShares, "159741903680023");
  assert.equal(row.gapAssets, "165597084405370");
  assert.equal(row.gapBpsOfInitialPositionWad, "82798542202685000");
  assert.equal(row.terminalFairCapital.collateralCapitalAssets, "23129077624909760698");
});

test("floor, ceiling and source zero-safe conversion semantics are exact", () => {
  assert.equal(model.floorMulDiv(5n, 2n, 3n), 3n);
  assert.equal(model.ceilDiv(10n, 3n), 4n);
  assert.equal(model.ceilDiv(0n, 3n), 0n);
  assert.equal(model.zeroSafeConvertToShares(7n, 0n, 0n), 7n);
  assert.equal(model.zeroSafeConvertToShares(0n, 9n, 0n), 0n);
  assert.equal(model.zeroSafeConvertToShares(7n, 11n, 13n), 5n);
  assert.throws(() => model.zeroSafeConvertToShares(1n, 1n, 0n), /DIVISION_BY_ZERO/);
});

test("lazy and every-update synchronization are modeled with separate floors", () => {
  const result = model.recurrence({
    initialAssets: 1_000_000n, initialShares: 1_000_000n, initialPositionShares: 11n,
    ratePerSecondWad: 100_000_000_000_000n, elapsedEach: 1000n, updates: 10, feeBps: 1000,
  });
  assert.equal(result.implementationLiability, 12n);
  assert.equal(result.everyUpdateLiability, 11n);
  assert.equal(result.fairLiability, 11n);
});

test("difference-of-floors is not replaced by a blind gap conversion", () => {
  const exact = model.gapAssetsDifferenceOfFloors(10n, 3n, 7n, 5n, 7n);
  const blind = model.floorMulDiv(7n - 3n, 5n, 7n);
  assert.equal(exact, 3n);
  assert.equal(blind, 2n);
  const aggressive = artifact.anchors.aggressiveStep1;
  assert.equal(aggressive.gapAssets, "183789151273036805");
});

test("arbitrary sufficient headroom obeys the one-raw-unit floor-shift lemma exhaustively", () => {
  let checked = 0;
  for (let shares = 1n; shares <= 12n; shares += 1n) {
    for (let assets = 0n; assets <= 12n; assets += 1n) {
      for (let gap = 0n; gap <= 12n; gap += 1n) {
        for (let offset = 0n; offset <= 12n; offset += 1n) {
          for (let implementation = 0n; implementation <= 4n; implementation += 1n) {
            const fair = implementation + gap; const headroom = fair + offset;
            const exact = model.gapAssetsDifferenceOfFloors(headroom, implementation, fair, assets, shares);
            const baseline = model.floorMulDiv(gap, assets, shares);
            assert.ok(exact === baseline || exact === baseline + 1n);
            checked += 1;
          }
        }
      }
    }
  }
  assert.equal(checked, 131820);
});

test("bounded deterministic fuzz preserves arbitrary-headroom lemma", () => {
  let state = 0x5a17n;
  const next = () => { state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return state; };
  for (let index = 0; index < 5000; index += 1) {
    const shares = next() % 1_000_000_000_000n + 1n;
    const assets = next() % 1_000_000_000_000n;
    const implementation = next() % 1_000_000_000n;
    const gap = next() % 1_000_000_000n;
    const fair = implementation + gap; const headroom = fair + next() % 10_000_000_000n;
    const exact = model.gapAssetsDifferenceOfFloors(headroom, implementation, fair, assets, shares);
    const baseline = model.floorMulDiv(gap, assets, shares);
    assert.ok(exact === baseline || exact === baseline + 1n);
  }
  assert.throws(() => model.gapAssetsDifferenceOfFloors(6n, 3n, 7n, 5n, 7n), /INVALID_HEADROOM_ORDER/);
});

test("sampled headroom offsets retain economics classification", () => {
  assert.equal(artifact.headroomSensitivity.checkedModelCells, 294);
  assert.equal(artifact.headroomSensitivity.checkCount, 1470);
  assert.equal(artifact.headroomSensitivity.maximumAbsoluteShiftRawAssetUnits, "1");
  assert.equal(artifact.headroomSensitivity.economicEvaluationPassFlips, 0);
  assert.equal(artifact.headroomSensitivity.economicsClassificationUnchanged, true);
  for (const row of [...artifact.headroomSensitivity.aggressiveOffsets, ...artifact.headroomSensitivity.realisticOffsets]) {
    assert.ok(BigInt(row.shiftFromGapFloor) >= 0n && BigInt(row.shiftFromGapFloor) <= 1n);
    assert.equal(row.absoluteShiftAtMostOne, true);
  }
});

test("zero reward or zero fee produces no liability gap", () => {
  for (const [annual, fee] of [[0n, 1000], [4n * WAD / 100n, 0]]) {
    const result = model.scenario(20n * WAD, annual, fee, 365, 1);
    assert.equal(result.gapShares, 0n);
    assert.equal(result.gapAssets, 0n);
  }
});

test("annual reward local bisection crossing checks its predecessor", () => {
  const row = artifact.boundaries.annualRewardFrontierFee10Daily365;
  assert.equal(row.method, "LOCAL_BISECTION_CROSSING_NO_GLOBAL_MINIMALITY_CLAIM");
  assert.equal(row.annualWad, "376121102027616000");
  assert.equal(row.ratePerSecondWad, "11926721906");
  assert.equal(row.strictAbove10BpsInitial, true);
  assert.equal(row.priorAnnualWadPasses, false);
  const at = model.scenario(20n * WAD, BigInt(row.annualWad), 1000, 365, 1);
  const before = model.scenario(20n * WAD, BigInt(row.annualWad) - 1n, 1000, 365, 1);
  assert.ok(at.gapAssets * model.BPS > 20n * WAD * 10n);
  assert.ok(before.gapAssets * model.BPS <= 20n * WAD * 10n);
});

test("4 percent full fee stays below 10bps and exhaustive horizon has a true first crossing", () => {
  const full = artifact.boundaries.fourPercentRewardFullFee365;
  assert.equal(full.below10BpsInitial, true);
  assert.equal(full.gapAssets, "16169862639911908");
  const row = artifact.boundaries.holdingFrontier4PercentFee10Daily;
  assert.equal(row.method, "EXHAUSTIVE_ENUMERATION");
  assert.deepEqual(row.declaredDomainDays, { first: 1, last: 5475 });
  assert.equal(row.days, "3426");
  assert.equal(row.priorDayPasses, false);
  assert.equal(row.earlierPassingDays, 0);
  assert.equal(row.strictAbove10BpsInitial, true);
  assert.ok(Number(row.days) > 365 && Number(row.days) <= row.searchBoundDays);
});

test("promotion threshold is strict when net equals threshold", () => {
  const result = { gapAssets: WAD, assets: WAD, shares: WAD, fairLiability: WAD };
  const economic = model.economics(result, { haircutWad: WAD, costUsd: 0, priceUsd: 1000 });
  assert.equal(economic.grossUsdWad, 1000n * WAD);
  assert.equal(economic.thresholdUsdWad, 1000n * WAD);
  assert.equal(economic.passes, false);
});

test("exact monotone h_min is minimal and selected-grid h_min is impossible", () => {
  const h = BigInt(artifact.boundaries.hMin.aggressive1000AssetsPrice3000Cost250Wad);
  const result = model.recurrence({
    initialAssets: 1000n * WAD, initialShares: 1000n * WAD, initialPositionShares: 1000n * WAD,
    ratePerSecondWad: 100_000_000_000_000n, elapsedEach: 1000n, updates: 10, feeBps: 1000,
  });
  assert.equal(model.economics(result, { haircutWad: h, costUsd: 250, priceUsd: 3000 }).passes, true);
  assert.equal(model.economics(result, { haircutWad: h - 1n, costUsd: 250, priceUsd: 3000 }).passes, false);
  assert.equal(artifact.boundaries.hMin.selectedGrid4Percent100000AssetsPrice3000Cost0Wad, null);
  assert.equal(artifact.boundaries.hMin.selectedGrid4PercentImpossibleIfAtLeastOne, true);
});

test("aggressive capital results are labeled local bisection crossings", () => {
  for (const row of artifact.boundaries.aggressiveLocalBisectionCrossingsAt3000Usd) {
    assert.equal(row.method, "LOCAL_BISECTION_CROSSING_NO_GLOBAL_MINIMALITY_CLAIM");
    assert.equal(row.predecessorChecked, true);
    assert.equal(row.passes, true);
    assert.equal(row.priorRawUnitPasses, false);
    assert.ok(BigInt(row.netUsdWad) > BigInt(row.thresholdUsdWad));
  }
  assert.equal(artifact.boundaries.aggressiveLocalBisectionCrossingsAt3000Usd[0].initialAssets, "36273450421252990685");
  assert.equal(artifact.boundaries.aggressiveLocalBisectionCrossingsAt3000Usd[0].capitalUsdWad, "313613295106453711257000");
});

test("scale outputs are sampled sanity checks under an empirical bound", () => {
  const scale = artifact.sampledScaleSanityChecks;
  assert.equal(scale.status, "SAMPLED_SANITY_CHECK_NOT_A_HOMOGENEITY_THEOREM");
  assert.deepEqual(scale.samples, ["1", "20", "1000", "100000"]);
  for (const row of scale.rows) {
    assert.equal(row.withinEmpiricalBound, true);
    assert.ok(BigInt(row.gapDeviationFromOneAssetLinearRaw) <= BigInt(row.empiricalFloorBoundRaw));
    assert.ok(BigInt(row.assetDeviationFromOneAssetLinearRaw) <= BigInt(row.empiricalFloorBoundRaw));
  }
});

test("sweep dimensions, counts and extreme-only decision are complete", () => {
  assert.equal(artifact.sweep.modelCellCount, 294);
  assert.equal(artifact.sweep.economicEvaluationCount, 18816);
  assert.equal(artifact.sweep.analystSelectedGridCellCount, 120);
  assert.equal(artifact.sweep.analystSelectedGridTenBpsCapitalRatioCells, 0);
  assert.equal(artifact.sweep.tenBpsCapitalRatioCells, 48);
  assert.equal(artifact.sweep.promotionPassCountAt20AssetPosition, 880);
  assert.equal(artifact.sweep.promotionPassesOnlyExtremeRewardOrFee, true);
  assert.match(artifact.sweep.analystSelectedGridDefinition, /not deployed bounds/);
  assert.equal(artifact.sweep.deployedBoundsClaimed, false);
  assert.equal(artifact.sweep.modelDigest, "0x088f05553c3ae980105616ee8c928f48bd49a534662453923679e188ab11a248");
  assert.equal(artifact.sweep.economicsDigest, "0xa5f3f31f4a42a50e4b73411e1e4c328a852b20762975dc694e2a6eec880b6911");
});

test("source, Step1 and line-range commitments verify", () => {
  const bindings = model.verifyInputs(ROOT);
  assert.equal(bindings.step1Artifact.sha256, model.INPUTS.step1Artifact.sha256);
  assert.equal(bindings.controller.ranges.length, 5);
  assert.equal(bindings.vaultOsToken.ranges.length, 3);
  assert.equal(bindings.step1Manifest.sha256, model.INPUTS.step1Manifest.sha256);
  assert.equal(bindings.step1SourceClosure.sha256, model.INPUTS.step1SourceClosure.sha256);
  assert.equal(bindings.step1FocusedCapture.sha256, model.INPUTS.step1FocusedCapture.sha256);
  assert.equal(bindings.step1HarnessBuildInfoCapture.sha256, model.INPUTS.step1HarnessBuildInfoCapture.sha256);
  assert.equal(bindings.step1AuditOverlay.sha256, model.INPUTS.step1AuditOverlay.sha256);
  assert.equal(artifact.scope.sourceCommit, model.SOURCE_COMMIT);
  assert.equal(artifact.lineage.fullStep1LineageAuthorityClaimed, false);
  assert.equal(artifact.lineage.auditOverlay.tracking, "UNTRACKED_AUDIT_OVERLAY");
});

test("source and input hash tripwires fail closed", () => {
  const original = fs.readFileSync;
  assert.throws(() => model.verifyInputs(ROOT, (file, encoding) => {
    const value = original(file, encoding);
    if (String(file).endsWith("OsTokenVaultController.sol")) {
      const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
      bytes[0] ^= 1;
      return encoding ? bytes.toString(encoding) : bytes;
    }
    return value;
  }), /INPUT_HASH_MISMATCH:controller/);
  assert.throws(() => model.verifyInputs(ROOT, (file, encoding) => {
    const value = original(file, encoding);
    if (String(file).endsWith("critical-stakewise-v3-ostoken-step1.json")) {
      const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
      bytes[0] ^= 1;
      return encoding ? bytes.toString(encoding) : bytes;
    }
    return value;
  }), /INPUT_HASH_MISMATCH:step1Artifact/);
  for (const name of ["step1Manifest", "step1SourceClosure", "step1FocusedCapture", "step1HarnessBuildInfoCapture", "step1AuditOverlay"]) {
    const target = model.INPUTS[name].path.replaceAll("/", path.sep);
    assert.throws(() => model.verifyInputs(ROOT, (file, encoding) => {
      const value = original(file, encoding);
      if (String(file).endsWith(target)) {
        const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
        bytes[0] ^= 1;
        return encoding ? bytes.toString(encoding) : bytes;
      }
      return value;
    }), new RegExp(`INPUT_HASH_MISMATCH:${name}`));
  }
});

test("artifact and report are deterministic committed outputs", () => {
  const second = model.buildArtifact(ROOT);
  assert.equal(model.serializeArtifact(second), model.serializeArtifact(artifact));
  assert.equal(fs.readFileSync(path.join(ROOT, model.OUTPUT), "utf8"), model.serializeArtifact(artifact));
  assert.equal(fs.readFileSync(path.join(ROOT, model.REPORT), "utf8"), model.renderReport(artifact));
});

test("schema, gates and security remain fail-closed without provider material", () => {
  assert.equal(artifact.schema, model.SCHEMA);
  assert.equal(artifact.classification.deploymentCaptureDecision, "DEFER_ROTATE");
  assert.equal(artifact.classification.deployedClassification, "NONE");
  assert.equal(artifact.classification.nextFallback, "Symbiotic named-deployment path");
  assert.deepEqual(artifact.gates, { sourcePrimitive: 1, localDirectExtraMint: 1, analystSelectedGridMateriality: 0,
    routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false });
  assert.deepEqual(artifact.security, { networkReads: 0, protectedFilesRead: 0, rpcReads: 0, transactions: 0,
    signing: false, broadcasts: 0, mutations: 0, privateKeys: 0, providerMaterialAbsent: true, productionSourceEdits: 0 });
  const encoded = model.serializeArtifact(artifact);
  assert.doesNotMatch(encoded, /(?:https?|wss?):\/\//i);
  assert.doesNotMatch(encoded, /rpc_endpoints|graphql_endpoints|authorization\s*[:=]\s*bearer/i);
});

test("Yearn comparison is rotation rationale only", () => {
  assert.equal(artifact.comparison.yearnKnownBps, "0.04656");
  assert.match(artifact.comparison.use, /rotation rationale only/);
  assert.equal(artifact.scope.deployedConfigurationClaimed, false);
  assert.equal(artifact.scope.currentStateClaimed, false);
  assert.equal(artifact.scope.exitLiquidityClaimed, false);
});
