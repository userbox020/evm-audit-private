#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

if (process.argv.length !== 3 || process.argv[2] !== "--check-only") {
  console.error("usage: node tools/validate-critical-aerodrome-ve33-step1.js --check-only");
  process.exit(2);
}

const root = path.resolve(__dirname, "..");
const paths = {
  report: "reports/critical-aerodrome-ve33-claim-conservation-step1.md",
  raw: "reports/raw/fast/critical-aerodrome-ve33-claim-conservation-step1.json",
  forge: "reports/raw/fast/critical-aerodrome-ve33-claim-conservation-step1-forge.txt",
  metadata: "reports/raw/fast/critical-aerodrome-ve33-claim-conservation-step1-metadata.json",
  evidence: "reports/raw/fast/critical-aerodrome-ve33-claim-conservation-step1-build-evidence.json",
  fmt: "reports/raw/fast/critical-aerodrome-ve33-claim-conservation-step1-fmt.txt",
  lint: "reports/raw/fast/critical-aerodrome-ve33-claim-conservation-step1-lint.txt",
  manifest: "reports/raw/fast/critical-aerodrome-ve33-claim-conservation-step1-manifest.json",
  test: "targets/aerodrome-contracts/audit-step1/test/AuditVe33ClaimConservationStep1.t.sol",
  scope: "targets/aerodrome-contracts/audit-step1/src/Scope.sol",
  inbox: "coordination/inbox/critical/20260729-critical-aerodrome-ve33-step1.json",
  handoff: "coordination/handoffs/20260729-critical-aerodrome-ve33-step1-handoff.md",
  validator: "tools/validate-critical-aerodrome-ve33-step1.js"
};

let checks = 0;
function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error(`check ${checks} failed: ${message}`);
}
function absolute(rel) {
  return path.join(root, rel);
}
function read(rel) {
  check(fs.existsSync(absolute(rel)), `missing ${rel}`);
  return fs.readFileSync(absolute(rel), "utf8");
}
function sha256(rel) {
  return crypto.createHash("sha256").update(fs.readFileSync(absolute(rel))).digest("hex");
}
function bigint(value) {
  return BigInt(value);
}

const report = read(paths.report);
const raw = JSON.parse(read(paths.raw));
const forge = read(paths.forge);
const metadata = JSON.parse(read(paths.metadata));
const evidence = JSON.parse(read(paths.evidence));
const fmt = read(paths.fmt);
const lint = read(paths.lint);
const test = read(paths.test);
const inbox = JSON.parse(read(paths.inbox));
const handoff = read(paths.handoff);
const manifest = JSON.parse(read(paths.manifest));

const manifestBefore = sha256(paths.manifest);
const boundBefore = new Map(manifest.files.map((entry) => [entry.path, sha256(entry.path)]));

check(report.includes("PASS / ROUTE-NEGATIVE"), "report signal");
check(report.includes("direct calls"), "direct caller limitation");
check(report.includes("synthetic direct gauge-authorized notification"), "fee path limitation");
check(report.includes("Reward/FreeManagedReward"), "adversarial token scope");
check(raw.routePositive === 0 && raw.executableNow === 0, "route/execution gates");
check(raw.signedActionJustified === false && raw.fork === false, "sign/fork gates");
check(raw.revisionOffline === true, "R3 offline");
check(raw.tests.functionsPassed === 15 && raw.tests.functionsFailed === 0, "test functions");
check(raw.tests.fuzzRuns === 128 && raw.tests.effectiveCases === 142, "case counts");
check(raw.tests.forcedBuildExitCode === 0 && raw.tests.focusedTestExitCode === 0, "build/test exits");
check(raw.tests.fmtExitCode === 0 && raw.tests.lintHighMediumExitCode === 0, "fmt/lint exits");
check(raw.decisiveGate.publicCallerRedirectedIncumbentClaim === false, "redirect gate");
check(raw.decisiveGate.consumedRewardWindowReplayed === false, "replay gate");
check(raw.decisiveGate.unentitledOrUnfundedConventionalRewardReceived === false, "unentitled gate");

const rollover = raw.exactDeltas.gaugeRollover;
check(rollover.effectiveFunded === "829440000000000079", "rollover funded");
check(rollover.paid === "829440000000000000", "rollover paid");
check(rollover.remainder === "31" && rollover.injectedBurn === "48", "rollover remainder/burn");
check(bigint(rollover.paid) + bigint(rollover.remainder) + bigint(rollover.injectedBurn) === bigint(rollover.effectiveFunded), "rollover identity");

const r1 = raw.exactDeltas.combinedR1;
const r2 = raw.exactDeltas.combinedR2;
check(bigint(r1.bobPaid) + bigint(r1.remaining) === bigint(r1.funded), "R1 conservation");
check(bigint(r2.bobPaid) + bigint(r2.remaining) === bigint(r2.funded), "R2 conservation");
check(r1.formerOwnerDelta === "0" && r2.formerOwnerDelta === "0", "former owner token deltas");
check(raw.exactDeltas.formerOwnerAggregateDelta === "0", "former owner aggregate");

const pagination = raw.exactDeltas.distributorPagination;
check(bigint(pagination.firstPage) + bigint(pagination.secondDuplicatePage) === bigint(pagination.totalPaid), "pagination pages");
check(bigint(pagination.totalPaid) + bigint(pagination.residual) === bigint(pagination.funded), "pagination conservation");
check(pagination.postCursorReplayDelta === "0", "pagination replay");
check(raw.paginationSemantics.includes("distinct 50-week pages"), "pagination wording");

check(raw.exactDeltas.distributorSameBlockTransfer.currentOwnerPaid === "1000000000000000000000", "same-block owner");
check(raw.exactDeltas.distributorSameBlockTransfer.formerOwnerDelta === "0", "same-block former owner");
check(raw.exactDeltas.distributorSafeCallback.receiverCurrentOwnerPaid === "1000000000000000000000", "safe callback owner");
check(raw.exactDeltas.distributorManaged.managedClaim === "1000000000000000000000", "managed claim");
check(raw.exactDeltas.distributorManaged.lockedConstituentDirectClaimRejected === true, "locked constituent rejection");
check(raw.feePath.includes("pool.claimFees production route unexecuted"), "fee path raw");
check(raw.adversarialTokenScope.includes("Reward/FreeManagedReward only"), "token scope raw");
check(raw.callerBindingScope.includes("direct calls only"), "caller scope raw");

check(evidence.target.head === "1ba30815bba620f7e9faa34769ffd00c214c9b82", "HEAD binding");
check(evidence.target.trackedDiffExitCode === 0 && evidence.target.trackedFilesClean === true, "tracked clean binding");
check(evidence.target.overallClean === false && evidence.target.status.includes("?? audit-step1/"), "intentional untracked state");
check(evidence.openzeppelin.declaredGitlink === evidence.openzeppelin.focusedLocalHead, "OZ gitlink/head");
check(evidence.openzeppelin.clean === true && evidence.openzeppelin.statusOutput === "", "OZ clean");
check(evidence.forge.effectiveFocusedConfig.offline === true, "offline config");
check(evidence.forge.effectiveFocusedConfig.autoDetectRemappings === true, "remapping config");
check(evidence.forge.effectiveFocusedConfig.autoDetectSolc === false, "solc auto-detect config");
check(evidence.forge.effectiveFocusedConfig.solc === "0.8.19", "solc config");
check(evidence.commands.forcedBuild.exitCode === 0, "evidence build exit");
check(evidence.commands.focusedTests.exitCode === 0, "evidence test exit");
check(evidence.commands.focusedTests.compilation === "skipped-no-files-changed", "focused test compile status");
check(evidence.commands.fmtCheck.exitCode === 0, "evidence fmt exit");
check(evidence.commands.lintHighMedium.exitCode === 0, "evidence lint exit");
check(evidence.r3Safety.networkReads === 0 && evidence.r3Safety.dependencyFetches === 0, "R3 network/fetch safety");
check(metadata.scope.protocolForwarderTested === false && metadata.scope.signedForwardingTested === false, "forwarder scope metadata");
check(metadata.scope.productionPoolClaimFeesRouteTested === false, "pool fee metadata");
check(metadata.scope.managedDistributorClaimExecuted === true, "managed metadata");

check(fmt.includes("EXIT_CODE=0"), "fmt output exit");
check(lint.includes("Compiling 53 files with Solc 0.8.19"), "lint compile output");
check(lint.includes("EXIT_CODE=0"), "lint output exit");
check(forge.includes("Compiling 52 files with Solc 0.8.19"), "forced build output");
check(forge.includes("15 tests passed, 0 failed"), "focused test output");
check(forge.includes("runs: 128"), "fuzz output");
check(forge.includes("paginationSecondPage: 5999999999999999994"), "pagination output");
check(!forge.toLowerCase().includes("npx"), "npx absent");

for (const functionName of [
  "testRewardsDistributorDuplicateIdPaginatesPastFiftyWeeksWithoutReplay",
  "testRewardsDistributorSameBlockTransferThenPublicClaimPaysCurrentOwner",
  "testRewardsDistributorSafeTransferReceiverCallbackClaimsAsCurrentOwner",
  "testRewardsDistributorManagedIdAttributionAndLockedConstituentRejection",
  "testCombinedManagedBribeFeeDuplicateClaimsAndOwnerTransfer",
  "testGaugeNotifyRolloverRemainderPartialFundingAndPayoutRollback",
  "testFeeOnTransferNominalConsumptionAndPhysicalShortfall"
]) {
  check(test.includes(functionName), `missing test ${functionName}`);
}
check(inbox.routePositive === 0 && inbox.executableNow === 0, "inbox gates");
check(handoff.includes("Gates: `0/0/false`"), "handoff gates");
check(Array.isArray(manifest.files) && manifest.files.length === 12, "manifest file count");

const sorted = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path));
for (const entry of sorted) {
  check(/^[0-9a-f]{64}$/.test(entry.sha256), `hash shape ${entry.path}`);
  check(sha256(entry.path) === entry.sha256, `hash mismatch ${entry.path}`);
}
const aggregateInput = sorted.map((entry) => `${entry.path}\0${entry.sha256}\n`).join("");
const aggregate = crypto.createHash("sha256").update(aggregateInput).digest("hex");
check(aggregate === manifest.aggregateSha256, "aggregate hash");

for (const rel of Object.values(paths)) {
  if (rel === paths.manifest) continue;
  const text = read(rel);
  check(!/[ \t]+$/m.test(text), `trailing whitespace ${rel}`);
  if (rel !== paths.validator) check(!text.includes("rpc_endpoints.txt"), `endpoint inventory reference ${rel}`);
}

for (const [rel, before] of boundBefore) {
  check(sha256(rel) === before, `validator write detected for ${rel}`);
}
check(sha256(paths.manifest) === manifestBefore, "validator write detected for manifest");

console.log(`PASS ${checks} checks; noWrite=true; aggregate=${aggregate}`);
