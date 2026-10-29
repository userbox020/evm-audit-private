#!/usr/bin/env node
"use strict";

const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const target = path.join(root, "targets", "liquity-bold-b40fa9b");
const rel = (file) => path.join(root, ...file.split("/"));
const read = (file) => fs.readFileSync(rel(file));
const text = (file) => read(file).toString("utf8");
const json = (file) => JSON.parse(text(file));
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const prefix = "reports/raw/fast/critical-liquity-bold-redemption-step1";
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error(`check ${checks} failed: ${message}`);
}

function equal(actual, expected, message) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`
  );
}

const artifactPaths = [
  "targets/liquity-bold-b40fa9b/README.md",
  "targets/liquity-bold-b40fa9b/contracts/foundry.toml",
  "targets/liquity-bold-b40fa9b/contracts/src/CollateralRegistry.sol",
  "targets/liquity-bold-b40fa9b/contracts/src/TroveManager.sol",
  "targets/liquity-bold-b40fa9b/contracts/src/ActivePool.sol",
  "targets/liquity-bold-b40fa9b/contracts/src/Interfaces/ITroveEvents.sol",
  "targets/liquity-bold-b40fa9b/contracts/test/redemptions.t.sol",
  "targets/liquity-bold-b40fa9b/contracts/test/multicollateral.t.sol",
  "targets/liquity-bold-b40fa9b/contracts/test/events.t.sol",
  "targets/liquity-bold-b40fa9b/contracts/test/batchManagementFee.t.sol",
  "targets/liquity-bold-b40fa9b/contracts/test/rebasingBatchShares.t.sol",
  "targets/liquity-bold-b40fa9b/contracts/test/Invariants.t.sol",
  "targets/liquity-bold-b40fa9b/contracts/test/TestContracts/InvariantsTestHandler.t.sol",
  "targets/liquity-bold-b40fa9b/contracts/test/audit/liquity-bold-redemption-step1/RedemptionStep1.t.sol",
  "tools/capture-critical-liquity-bold-redemption-step1.js",
  "tools/validate-critical-liquity-bold-redemption-step1.js",
  "reports/critical-liquity-bold-redemption-step1.md",
  `${prefix}.json`
];
const captureNames = [
  "fmt",
  "focused",
  "upstream-redemptions",
  "upstream-multicollateral",
  "upstream-events",
  "upstream-batch-management",
  "upstream-rebasing-batch-shares",
  "upstream-invariants",
  "build"
];
for (const name of captureNames) {
  artifactPaths.push(`${prefix}-${name}.capture.json`, `${prefix}-${name}.stdout.txt`, `${prefix}-${name}.stderr.txt`);
}

const manifestPath = `${prefix}-manifest.json`;
if (process.argv[2] === "--write-manifest" && process.argv.length === 3) {
  const artifacts = artifactPaths.map((artifactPath) => {
    const bytes = read(artifactPath);
    return {path: artifactPath, bytes: bytes.length, sha256: sha256(bytes)};
  });
  const aggregateSha256 = sha256(
    Buffer.from(artifacts.map((artifact) => `${artifact.path}:${artifact.sha256}`).sort().join("\n"), "utf8")
  );
  const manifest = {
    schemaVersion: 3,
    findingId: "liquity-bold-redemption-step1",
    revision: "R2",
    algorithm: "sha256",
    aggregateConstruction: "sha256(sorted(path + ':' + sha256).join('\\n'))",
    artifactCount: artifacts.length,
    aggregateSha256,
    artifacts
  };
  fs.writeFileSync(rel(manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`WROTE ${artifacts.length} artifacts; aggregate ${aggregateSha256}`);
  process.exit(0);
}
check(process.argv.length === 2, "usage: validator takes no args (or --write-manifest for package construction)");

const head = cp.execFileSync("git", ["rev-parse", "HEAD"], {cwd: target, encoding: "utf8"}).trim();
equal(head, "b40fa9b909efd34a1b1ae2bab5d240b77f86d3a4", "exact target commit");
const submodules = cp.execFileSync("git", ["submodule", "status", "--recursive"], {cwd: target, encoding: "utf8"});
check(submodules.trim().length > 0, "recursive submodule status nonempty");
check(!submodules.split(/\r?\n/u).some((line) => /^[-+]/u.test(line)), "recursive gitlinks initialized exactly");
cp.execFileSync(
  "git",
  [
    "diff",
    "--exit-code",
    "--",
    "contracts/src",
    "contracts/test/redemptions.t.sol",
    "contracts/test/multicollateral.t.sol",
    "contracts/test/events.t.sol",
    "contracts/test/batchManagementFee.t.sol",
    "contracts/test/rebasingBatchShares.t.sol",
    "contracts/test/Invariants.t.sol"
  ],
  {cwd: target, stdio: "ignore"}
);
check(true, "production source and upstream tests unchanged");

const priorManifest = json("reports/raw/fast/critical-liquity-bold-stabilitypool-step1-manifest.json");
equal(priorManifest.aggregateSha256, "59b088bac77dac0502dec1c016d4eeda14edccc16f1a2631e6988330ca6f85f8", "prior package aggregate unchanged");
equal(
  sha256(read("reports/critical-liquity-bold-stabilitypool-step1.md")),
  "5b6b56e4bf5f4d9aca679bf1ee7d9b5ba95bea1df810e8b5ef1e39f499758a3c",
  "prior report unchanged"
);

const captures = {};
for (const name of captureNames) {
  const capture = json(`${prefix}-${name}.capture.json`);
  captures[name] = capture;
  equal(capture.capture, name, `${name} capture name`);
  equal(capture.cwd, "targets/liquity-bold-b40fa9b/contracts", `${name} cwd`);
  equal(
    [capture.exitCode, capture.signal, capture.spawnError],
    [name === "upstream-invariants" ? 1 : 0, null, null],
    `${name} expected exit`
  );
  check(capture.forgeVersion.stdout.includes("forge Version: 1.5.1-stable"), `${name} Forge version`);
  equal([capture.compiler, capture.evmVersion, capture.optimizer, capture.optimizerRuns], ["solc 0.8.24", "cancun", true, 200], `${name} compiler settings`);
  if (name !== "fmt") check(capture.command.includes("--offline") && capture.command.includes("--use"), `${name} offline exact compiler command`);
  for (const stream of ["stdout", "stderr"]) {
    const bytes = read(capture[stream].path);
    equal(bytes.length, capture[stream].bytes, `${name} ${stream} bytes`);
    equal(sha256(bytes), capture[stream].sha256, `${name} ${stream} hash`);
  }
}

equal(read(captures.fmt.stdout.path).length, 0, "fmt stdout empty");
const focused = text(captures.focused.stdout.path);
check(focused.includes("11 tests passed, 0 failed, 0 skipped (11 total tests)"), "focused 11/11");
const focusedFuzz = [...focused.matchAll(/^\[PASS\] testFuzz[^\n]+\(runs: (\d+),/gmu)];
equal(focusedFuzz.length, 2, "two focused fuzz tests");
for (const row of focusedFuzz) equal(Number(row[1]), 64, "focused fuzz runs");
for (const testName of [
  "test_threeBranchSequentialRoutingAndExactGrossFeePayoutFloors",
  "test_sequenceMatrixRequestedAboveEligibleThenZeroUnbackedFallbackWithShutdownBranch",
  "test_iterationCapsZeroOneTwoThreeProduceExactUnderfill",
  "testFuzz_partialZombieFollowUpResetAndNoStaleSurplus",
  "test_splitCallFeePathDependenceIsRedeemerFavoringAndConservesDebt",
  "test_threeTroveBatchAccruedInterestAndManagementFeeOneCallVsSplit",
  "test_registryGatesDirectTroveManagerRedemption"
]) check(focused.includes(`[PASS] ${testName}`), `focused ${testName}`);

check(text(captures["upstream-redemptions"].stdout.path).includes("43 tests passed, 0 failed, 0 skipped (43 total tests)"), "upstream redemptions 43/43");
const multicollateral = text(captures["upstream-multicollateral"].stdout.path);
check(multicollateral.includes("8 tests passed, 0 failed, 0 skipped (8 total tests)"), "upstream multicollateral 8/8");
check(multicollateral.includes("testMultiCollateralRedemptionFuzz") && multicollateral.includes("runs: 256"), "upstream multicollateral 256 fuzz");
check(text(captures["upstream-events"].stdout.path).includes("28 tests passed, 0 failed, 0 skipped (28 total tests)"), "upstream events 28/28");
check(text(captures["upstream-batch-management"].stdout.path).includes("29 tests passed, 0 failed, 0 skipped (29 total tests)"), "upstream batch management 29/29");
check(text(captures["upstream-rebasing-batch-shares"].stdout.path).includes("3 tests passed, 0 failed, 0 skipped (3 total tests)"), "upstream rebasing shares 3/3");
const invariants = text(captures["upstream-invariants"].stdout.path);
check(invariants.includes("8 tests passed, 1 failed, 0 skipped (9 total tests)"), "upstream invariants exact 8/9 outcome");
const invariantRows = [...invariants.matchAll(/^\[PASS\] invariant_[^(]+\(\) \(runs: (\d+), calls: (\d+), reverts: (\d+)\)$/gmu)];
equal(invariantRows.length, 8, "eight passing invariant rows");
for (const row of invariantRows) equal(row.slice(1).map(Number), [500, 25000, 0], "upstream invariant tuple");
equal(invariantRows.reduce((sum, row) => sum + Number(row[2]), 0), 200000, "passing upstream invariant calls");
check(invariants.includes("yieldGainsOwed !~= sum(yieldGain): 46339 >= 1000"), "exact upstream SP invariant failure retained");
check(invariants.includes("invariant_StabilityPool_AllBoldClaimable_ExceptYieldReceivedWhileEmpty() (runs: 176, calls: 8800, reverts: 0)"), "exact failed invariant partial campaign");
const build = text(captures.build.stdout.path);
check(build.includes("Compiling 294 files with Solc 0.8.24"), "full build file/compiler count");
check(build.includes("Compiler run successful with warnings:"), "full build succeeds with retained warnings");

const source = text("targets/liquity-bold-b40fa9b/contracts/test/audit/liquity-bold-redemption-step1/RedemptionStep1.t.sol");
for (const required of [
  "burn equals sum branch returns",
  "sequential routed amount",
  "split fee path is redeemer-favoring",
  "exact accrued batch debt fixture",
  "management fee minted once and exactly",
  "batch shares exhausted",
  "exact retained pre-redemption share-floor residual",
  "one-call and split start identically",
  "split leaves a higher terminal base rate",
  "CallerNotCollateralRegistry.selector"
]) check(source.includes(required), `test source includes ${required}`);
check(!source.includes("vm.etch"), "no runtime replacement");
const registry = text("targets/liquity-bold-b40fa9b/contracts/src/CollateralRegistry.sol");
check(registry.includes("_calcRedemptionRate(_getUpdatedBaseRateFromRedemption(_boldAmount, totals.boldSupplyAtStart))"), "pre-execution fee quote bound");
check(registry.includes("_updateBaseRateAndGetRedemptionRate(totals.redeemedAmount, totals.boldSupplyAtStart)"), "post-execution actual base-rate update bound");
const manager = text("targets/liquity-bold-b40fa9b/contracts/src/TroveManager.sol");
check(manager.includes("splitting the total _amount in appropriate chunks") && manager.includes("_updateBatchInterestPriorToRedemption"), "split guidance and batch update bound");
const readme = text("targets/liquity-bold-b40fa9b/README.md");
check(readme.includes("### 3 - Path-dependent redemptions: lower fee when chunking"), "README known-behavior heading");
check(readme.includes("No fix is deemed necessary") && readme.includes("Chunking redemptions incurs a higher total gas cost"), "README intended/no-fix/gas tradeoff");

const oneCall = 3728513485441277944n;
const split = 4170612865581565881n;
const delta = split - oneCall;
equal(delta.toString(), "442099380140287937", "exact split payout delta");
equal((delta * 2000n).toString(), "884198760280575874000", "fixture value before 18-decimal normalization");
const result = json(`${prefix}.json`);
equal(result.revision, "R2", "result revision");
equal(result.target.commit, head, "result commit");
equal([result.focused.tests, result.focused.passed, result.focused.fuzzCasesTotal], [11, 11, 128], "result focused counts");
equal([result.upstream.invariants.properties, result.upstream.invariants.passed, result.upstream.invariants.failed, result.upstream.invariants.passedCallsTotal, result.upstream.invariants.failedAfterCalls], [9, 8, 1, 200000, 8800], "result invariant outcome counts");
equal([result.knownBehavior.newFinding, result.knownBehavior.intended, result.knownBehavior.fixRecommended], [false, true, false], "known intended no-new-finding classification");
equal(result.knownBehavior.documentedAt, "README.md:1388-1405", "known behavior documentation binding");
equal(result.exactLocalRegressionRaw.splitCallAdditionalCollateral, delta.toString(), "result exact delta");
equal(result.exactLocalRegressionRaw.splitCallAdditionalValueAtFixturePriceBoldRaw, "884198760280575874000", "result fixture value");
equal(result.exactLocalRegressionRaw.independentlyFlooredPreRedemptionResidual, "4", "exact retained residual");
equal([result.comparator.snapshotRestoresIdenticalStart, result.comparator.maxIterations, result.comparator.maxFeePercentage, result.comparator.splitCallsSameTimestamp, result.comparator.interCallDecay], [true, 0, "100%", true, false], "comparator controls");
equal([result.feeMechanics.redemptionBeta, result.feeMechanics.storedBaseRateUsesActualRedeemedBold, result.feeMechanics.deltaIncludesSegmentationFloors, result.feeMechanics.feeCurvePathDependenceDominates], [1, true, true, true], "fee mechanics");
equal([result.gasAndOrdering.extraExternalTransactionGasUnavoidable, result.gasAndOrdering.atomicTwoCallContractPossible, result.gasAndOrdering.atomicCallsAvoidInterCallTimeAndThirdPartyOrderingExposure], [true, true, true], "gas and atomic ordering semantics");
equal(result.routeAssessment.unauthorizedOrConservationRoutes, "route-negative", "unauthorized/conservation route closeout");
equal([result.gates.sourcePrimitive, result.gates.localRoutePositive, result.gates.routePositive, result.gates.executableNow, result.gates.signedActionJustified, result.gates.fork], [1, 1, 0, 0, false, false], "source and operational gates");

const report = text("reports/critical-liquity-bold-redemption-step1.md");
check(report.includes("KNOWN/INTENDED INFORMATIONAL / NO NEW FINDING") && report.includes("442099380140287937"), "report signal and exact delta");
check(report.includes("README `:1388-1405`") && report.includes("No protocol fix is recommended"), "report known intended/no-fix binding");
check(report.includes("one-call and two-call paths begin from the same `vm.snapshotState()` state") && report.includes("same timestamp, so no minute decay"), "report comparator binding");
check(report.includes("supply denominator is after the first call's aggregate interest/management-fee mint and BOLD burn"), "report second-call denominator binding");
check(report.includes("segmentation-floor effects") && report.includes("fee-curve path dependence dominates"), "report exact fee mechanics");
check(report.includes("fees remain in the redeemed Troves for their borrowers") && report.includes("ActivePool is custody"), "report correct fee bearer");
check(report.includes("make both calls atomically") && report.includes("Market/oracle movement, concrete gas, and net economics remain unassessed"), "report gas/ordering limits");
check(report.includes("200,000") && report.includes("8/9") && report.includes("8,800") && report.includes("294") && report.includes("11/11"), "report evidence counts and retained invariant failure");
check(report.includes("routePositive=0") && report.includes("signedActionJustified=false") && report.includes("fork=false"), "report closed operational gates");

const manifest = json(manifestPath);
equal([manifest.schemaVersion, manifest.revision, manifest.artifactCount], [3, "R2", artifactPaths.length], "manifest header");
const manifestPaths = new Set();
for (const artifact of manifest.artifacts) {
  check(!manifestPaths.has(artifact.path), `unique manifest path ${artifact.path}`);
  manifestPaths.add(artifact.path);
  const bytes = read(artifact.path);
  equal(bytes.length, artifact.bytes, `manifest bytes ${artifact.path}`);
  equal(sha256(bytes), artifact.sha256, `manifest hash ${artifact.path}`);
}
for (const artifactPath of artifactPaths) check(manifestPaths.has(artifactPath), `manifest closure ${artifactPath}`);
const aggregate = sha256(
  Buffer.from(manifest.artifacts.map((artifact) => `${artifact.path}:${artifact.sha256}`).sort().join("\n"), "utf8")
);
equal(aggregate, manifest.aggregateSha256, "manifest aggregate");

const inbox = json("coordination/inbox/critical/20260730-critical-liquity-bold-redemption-step1.json");
equal([inbox.sourcePrimitive, inbox.localRoutePositive, inbox.routePositive, inbox.executableNow, inbox.signedActionJustified, inbox.fork], [1, 1, 0, 0, false, false], "inbox gates");
equal(inbox.evidence.manifestAggregateSha256, aggregate, "inbox aggregate binding");
const handoff = text("coordination/handoffs/20260730-critical-liquity-bold-redemption-step1-handoff.md");
check(handoff.includes("Step1 R2 handoff") && handoff.includes(aggregate) && handoff.includes("442099380140287937"), "handoff revision/delta/aggregate binding");

console.log(`PASS ${checks} checks; aggregate ${aggregate}`);
