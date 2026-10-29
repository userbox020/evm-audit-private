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
const prefix = "reports/raw/fast/critical-liquity-bold-batch-debt-step1";
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
  "targets/liquity-bold-b40fa9b/contracts/src/BorrowerOperations.sol",
  "targets/liquity-bold-b40fa9b/contracts/src/TroveManager.sol",
  "targets/liquity-bold-b40fa9b/contracts/src/ActivePool.sol",
  "targets/liquity-bold-b40fa9b/contracts/src/SortedTroves.sol",
  "targets/liquity-bold-b40fa9b/contracts/test/interestRateAggregate.t.sol",
  "targets/liquity-bold-b40fa9b/contracts/test/interestBatchManagement.t.sol",
  "targets/liquity-bold-b40fa9b/contracts/test/rebasingBatchShares.t.sol",
  "targets/liquity-bold-b40fa9b/contracts/test/SortedTroves.t.sol",
  "targets/liquity-bold-b40fa9b/contracts/test/Invariants.t.sol",
  "targets/liquity-bold-b40fa9b/contracts/test/audit/liquity-bold-batch-debt-step1/BatchDebtStep1.t.sol",
  "tools/capture-critical-liquity-bold-batch-debt-step1.js",
  "tools/validate-critical-liquity-bold-batch-debt-step1.js",
  "reports/critical-liquity-bold-batch-debt-step1.md",
  `${prefix}.json`,
  `${prefix}-r2-invariant-lineage.json`
];
const authoredPaths = artifactPaths.slice(9);
const packageOnlyPaths = [...authoredPaths];
const captureNames = [
  "fmt",
  "focused",
  "upstream-interest-aggregate",
  "upstream-interest-batch",
  "upstream-rebasing-shares",
  "upstream-sorted-troves",
  "upstream-nonsp-invariants",
  "build"
];
for (const name of captureNames) {
  const paths = [`${prefix}-${name}.capture.json`, `${prefix}-${name}.stdout.txt`, `${prefix}-${name}.stderr.txt`];
  artifactPaths.push(...paths);
  packageOnlyPaths.push(...paths);
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
    findingId: "liquity-bold-batch-debt-step1",
    revision: "R3",
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
    "diff", "--exit-code", "--",
    "contracts/src",
    "contracts/test/interestRateAggregate.t.sol",
    "contracts/test/interestBatchManagement.t.sol",
    "contracts/test/rebasingBatchShares.t.sol",
    "contracts/test/SortedTroves.t.sol",
    "contracts/test/Invariants.t.sol"
  ],
  {cwd: target, stdio: "ignore"}
);
check(true, "production source and upstream tests unchanged");

const priorManifest = json("reports/raw/fast/critical-liquity-bold-redemption-step1-manifest.json");
equal(priorManifest.aggregateSha256, "5d9a37254ced2f6b7be48645527fdcab5a7e8f0664272a6ebab5f2043c9f1abe", "prior redemption R2 aggregate unchanged");
equal(sha256(read("reports/critical-liquity-bold-redemption-step1.md")), "4956d4b7bba7ab2500b792de8870d8ed13f925e51af0f3f79846ab7f06410867", "prior redemption report unchanged");

const captures = {};
for (const name of captureNames) {
  const capture = json(`${prefix}-${name}.capture.json`);
  captures[name] = capture;
  equal(capture.capture, name, `${name} capture name`);
  equal(capture.cwd, "targets/liquity-bold-b40fa9b/contracts", `${name} cwd`);
  equal([capture.exitCode, capture.signal, capture.spawnError], [0, null, null], `${name} clean exit`);
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
check(focused.includes("18 tests passed, 0 failed, 0 skipped (18 total tests)"), "focused 18/18");
const focusedFuzz = [...focused.matchAll(/^\[PASS\] testFuzz[^\n]+\(runs: (\d+),/gmu)];
equal(focusedFuzz.length, 4, "four focused fuzz properties");
for (const row of focusedFuzz) equal(Number(row[1]), 64, "focused fuzz runs");
for (const testName of [
  "test_outsiderApplyIndividualAccrualImmediateRepeatAndPlusOneSecond",
  "test_threeBatchTrovesDifferentApplyOrdersNoDuplicateFeeOrDebt",
  "test_outsiderApplyConsumesPendingRedistributionDebtAndCollExactly",
  "test_outsiderApplyReactivatesZombieAtMinBoundaryWithoutCallerValue",
  "test_kickAuthorizationBelowAndExactlyMaxRatio",
  "test_kickAboveRatioFirstMiddleLastAndOwnerEquivalentRemove",
  "test_kickEligibleZombiePreservesZombieAbsenceAndClearsShares",
  "test_joinApplyRemoveRejoinWithStaleHintsPreservesDebtAndOrdering",
  "test_batchCrystallizationExactOneWeiPerTroveFloorResidualFixture",
  "test_oracleArithmeticShape10000_1000_100_9",
  "test_naturalRatioProductionRedistributionClosestOracleShapeExactAccounting",
  "test_repeatedNaturalRedistributionApplyTimingOwnerAndOutsiderExactBound",
  "test_batchManagerCallerReceivesOnlyEntitledManagementFee",
  "testFuzz_redistributionShareMintAndLiabilityShiftFormalBound",
  "test_componentAwareExactNegativeTwoBoundary",
  "testFuzz_componentAwareNonzeroInterestFeeDZeroAndPositive"
]) check(focused.includes(`[PASS] ${testName}`), `focused ${testName}`);
for (const exactLog of [
  "R2 production B: 209589041095890410958890",
  "R2 production S: 20958904109589041095889",
  "R2 production target shares: 2095890410958904109589",
  "R2 production redistribution gain: 9",
  "R2 production target liability decrease: 9",
  "R2 production incumbent liability increase: 8",
  "R2 production residual after: 1",
  "R2 repeated cumulative target liability decrease: 817",
  "R2 repeated cumulative exact bound: 3002",
  "R2 repeated cycle collateral gain: 657894736842105200",
  "R2 repeated cycle collateral gain: 666608574416172900",
  "R2 repeated cycle collateral gain: 675496688741721900",
  "R3 repeated one-shot simple-accrual seconds: 12601785600",
  "R2 manager caller entitled fee: 74256333270782510790"
]) check(focused.includes(exactLog), `focused exact log ${exactLog}`);

check(text(captures["upstream-interest-aggregate"].stdout.path).includes("91 tests passed, 0 failed, 0 skipped (91 total tests)"), "interest aggregate 91/91");
check(text(captures["upstream-interest-batch"].stdout.path).includes("57 tests passed, 0 failed, 0 skipped (57 total tests)"), "interest batch 57/57");
check(text(captures["upstream-rebasing-shares"].stdout.path).includes("3 tests passed, 0 failed, 0 skipped (3 total tests)"), "rebasing shares 3/3");
const sorted = text(captures["upstream-sorted-troves"].stdout.path);
check(sorted.includes("6 tests passed, 0 failed, 0 skipped (6 total tests)"), "SortedTroves 6/6");
equal([...sorted.matchAll(/^\[PASS\][^\n]+\(runs: 256,/gmu)].length, 6, "six SortedTroves fuzz properties at 256 runs");

const invariants = text(captures["upstream-nonsp-invariants"].stdout.path);
check(invariants.includes("8 tests passed, 0 failed, 0 skipped (8 total tests)"), "fresh selected non-SP invariants 8/8");
const invariantRows = [...invariants.matchAll(/^\[PASS\] invariant_[^(]+\(\) \(runs: (\d+), calls: (\d+), reverts: (\d+)\)$/gmu)];
equal(invariantRows.length, 8, "eight passing invariant rows");
for (const row of invariantRows) equal(row.slice(1).map(Number), [500, 25000, 0], "invariant tuple");
equal(invariantRows.reduce((sum, row) => sum + Number(row[2]), 0), 200000, "fresh invariant call total");
const lineage = json(`${prefix}-r2-invariant-lineage.json`);
equal(lineage.priorManifestAggregateSha256, "de6f47efdf99cb8bf336cc3d377ccf1831112a891b8768e4f8c58632357294ad", "R2 lineage aggregate");
equal(
  [lineage.priorSelectedInvariantCapture.outcome, lineage.priorSelectedInvariantCapture.passingCalls, lineage.priorSelectedInvariantCapture.failedAfterCalls, lineage.priorSelectedInvariantCapture.absoluteDelta, lineage.priorSelectedInvariantCapture.tolerance],
  ["7 passed; 1 failed; 0 skipped", 175000, 8700, "3415", "1000"],
  "R2 invariant observation retained"
);
equal(lineage.priorSelectedInvariantCapture.stdoutSha256, "9b1e054f6040332ed2ca6fed8d7c0bf806ea1e5b08894de2f6878f6f657e7763", "R2 failed stdout commitment");
const build = text(captures.build.stdout.path);
check(build.includes("Compiling 295 files with Solc 0.8.24"), "full build file/compiler count");
check(build.includes("Compiler run successful with warnings:"), "full build succeeds with retained warnings");

const source = text("targets/liquity-bold-b40fa9b/contracts/test/audit/liquity-bold-batch-debt-step1/BatchDebtStep1.t.sol");
for (const required of [
  "public apply caller value",
  "three-component batch floor bound",
  "exact fixture floor residual",
  "reverse apply order",
  "BatchSharesRatioTooLow.selector",
  "kick equals owner remove at batch rate",
  "sorted annual-interest ordering",
  "exact production arithmetic at TroveManager.sol:1849",
  "liability shift plus batch floor residual conserves exact batch ledger",
  "integer target shift bounded by ceil debt/share ratio",
  "active debt covers modeled batch components",
  "caller identity does not change redistribution accounting"
  ,"three pre-call component floors combine with k at most two"
  ,"actual target change equals isolated benefit minus component-combination k"
  ,"component-aware residual identity"
  ,"batch debt adds exact applied redistribution gain"
]) check(source.includes(required), `test source includes ${required}`);
check(!source.includes("vm.etch"), "no runtime replacement");
check(!source.includes("getEntireBranchDebt()"), "tautological branch helper comparison removed");
const borrowerOps = text("targets/liquity-bold-b40fa9b/contracts/src/BorrowerOperations.sol");
check(borrowerOps.includes("function applyPendingDebt(uint256 _troveId, uint256 _lowerHint, uint256 _upperHint) public"), "public apply route bound");
check(borrowerOps.includes("function kickFromBatch(uint256 _troveId, uint256 _upperHint, uint256 _lowerHint) external override"), "public kick route bound");
check(borrowerOps.includes("vars.batch.totalDebtShares * MAX_BATCH_SHARES_RATIO >= vars.batch.entireDebtWithoutRedistribution"), "strict kick threshold bound");
const managerSource = text("targets/liquity-bold-b40fa9b/contracts/src/TroveManager.sol");
check(managerSource.includes("batchDebtSharesDelta = currentBatchDebtShares * debtIncrease / _batchDebt;"), "floor share mint source bound");

const result = json(`${prefix}.json`);
equal(result.revision, "R3", "result revision");
equal(result.target.commit, head, "result commit");
equal([result.focused.tests, result.focused.passed, result.focused.fuzzCasesTotal], [18, 18, 256], "focused counts");
equal(
  [result.upstream.freshR3SelectedNonSpInvariants.properties, result.upstream.freshR3SelectedNonSpInvariants.passed, result.upstream.freshR3SelectedNonSpInvariants.callsTotal, result.upstream.retainedR2SelectedInvariantObservation.passed, result.upstream.retainedR2SelectedInvariantObservation.failedAfterCalls],
  [8, 8, 200000, 7, 8700],
  "fresh and retained invariant counts"
);
equal(
  [result.componentAwareMath.shareMint, result.componentAwareMath.kRange, result.componentAwareMath.isolatedBenefitRange, result.componentAwareMath.actualReduction, result.componentAwareMath.actualReductionRange, result.componentAwareMath.positiveReductionProductionCapWeiPerSuccessfulCall],
  ["d=floor(S*g/B)", "0..2", "0..ceil(B/S)", "targetPre-targetPost=delta-k", "-2..ceil(B/S)", "1000000000"],
  "component-aware formula and bounds"
);
equal(
  [result.componentBoundary.d, result.componentBoundary.k, result.componentBoundary.isolatedBenefit, result.componentBoundary.actualReduction],
  ["0", "2", "0", "-2"],
  "negative-two component boundary"
);
equal(
  [result.repeatedStressFixture.cumulativeTargetDecrease, result.repeatedStressFixture.cumulativeIncumbentIncrease, result.repeatedStressFixture.cumulativeResidualIncrease, result.repeatedStressFixture.sumOfPerCallBounds, result.repeatedStressFixture.oneShotSimpleAccrualSeconds],
  ["817", "815", "2", "3002", "12601785600"],
  "repeated exact shift and bound"
);
equal(
  [result.helperCorrection.staleBatchDebtAssertionRemoved, result.helperCorrection.expectedBatchDebt, result.residualIdentity.preRange, result.residualIdentity.identity],
  [true, "B+g", "0..3*(n-1)", "incumbentIncrease+postResidual=actualTargetReduction+preComponentResidual"],
  "helper and residual corrections"
);
equal(
  [result.zeroRedistributionOnly.threeComponentDifferenceBound, result.zeroRedistributionOnly.exactFixture, result.zeroRedistributionOnly.generalRedistributionClaim],
  ["0..2 wei", "+1 wei", false],
  "zero-redistribution-only correction"
);
equal([result.kickFromBatch.belowThreshold, result.kickFromBatch.exactThreshold, result.kickFromBatch.aboveThreshold], ["reverts BatchSharesRatioTooLow", "reverts BatchSharesRatioTooLow", "succeeds"], "kick threshold outcomes");
equal([result.gates.sourcePrimitive, result.gates.localRoutePositive, result.gates.localRoutePositiveTaxonomy, result.gates.routePositive, result.gates.executableNow, result.gates.signedActionJustified, result.gates.fork], [1, 1, "gross-dust-only for benefited owner", 0, 0, false, false], "gross-dust taxonomy and closed operational gates");

const report = text("reports/critical-liquity-bold-batch-debt-step1.md");
check(report.includes("INFORMATIONAL / BOUNDED INTENDED SHARE ROUNDING") && report.includes("EXACT REDISTRIBUTION DIRECTION UNDOCUMENTED"), "report classification");
check(report.includes("Tpre - Tpost = δ-k") && report.includes("-2 <= Tpre-Tpost <= ceil(B/S)"), "report component-aware range");
check(report.includes("D=1, I=1, F=5") && report.includes("Tpre-Tpost=-2"), "report negative-two boundary");
check(report.includes("0–2 wei") && report.includes("valid only for zero redistribution"), "report restricted crystallization floor");
check(report.includes("209589041095890410958890") && report.includes("target `-9`, incumbent `+8`"), "report exact production and oracle shapes");
check(report.includes("399.6 years") && report.includes("12601785600"), "report high-ratio timescale");
check(report.includes("1,000,000,000 wei BOLD per successful call"), "report maximum source bound");
check(report.includes("conditional gross dust for a benefited owner only") && report.includes("Capital, liquidation loss, and gas dominate"), "report caller taxonomy and economics");
check(report.includes("Naively rounding `d` upward reverses") && report.includes("No protocol-change recommendation"), "report acceptance and ceil warning");
check(report.includes("below/exact threshold revert") && report.includes("naturally above succeeds"), "report kick boundaries");
check(report.includes("200,000") && report.includes("18/18") && report.includes("295"), "report evidence counts");
check(report.includes("prior R2 `7/8` observation remains disclosed") && report.includes("Causation is unproven"), "R2 invariant disclosure retained");
check(report.includes("sourcePrimitive=1") && report.includes("localRoutePositive=1") && report.includes("routePositive=0") && report.includes("fork=false"), "report source and operational gates");

for (const artifactPath of authoredPaths) {
  const value = text(artifactPath);
  check(!/[ \t]+$/gmu.test(value), `no trailing whitespace ${artifactPath}`);
  check(!/(?:https?|wss?):\/\//giu.test(value), `no authored URL leak ${artifactPath}`);
}
for (const artifactPath of packageOnlyPaths) {
  const value = text(artifactPath);
  check(!/-----BEGIN [^-]*(?:PRIVATE KEY|OPENSSH KEY)-----/giu.test(value), `no private-key material ${artifactPath}`);
  check(!/(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|rpc_endpoints\.txt|graphql_endpoints\.txt)(?:$|[\\/])/gimu.test(value), `no secret-file path ${artifactPath}`);
}

const manifest = json(manifestPath);
equal([manifest.schemaVersion, manifest.revision, manifest.artifactCount], [3, "R3", artifactPaths.length], "manifest header");
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

const inbox = json("coordination/inbox/critical/20260730-critical-liquity-bold-batch-debt-step1.json");
equal([inbox.sourcePrimitive, inbox.localRoutePositive, inbox.localRoutePositiveTaxonomy, inbox.routePositive, inbox.executableNow, inbox.signedActionJustified, inbox.fork], [1, 1, "gross-dust-only for benefited owner", 0, 0, false, false], "inbox gates");
equal(inbox.evidence.manifestAggregateSha256, aggregate, "inbox aggregate binding");
const handoff = text("coordination/handoffs/20260730-critical-liquity-bold-batch-debt-step1-handoff.md");
check(handoff.includes("Step1 R3 handoff") && handoff.includes(aggregate) && handoff.includes("δ-k") && handoff.includes("817"), "handoff revision/math/delta/aggregate binding");

console.log(`PASS ${checks} checks; aggregate ${aggregate}`);
