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
const prefix = "reports/raw/fast/critical-liquity-bold-stabilitypool-step1";
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error(`check ${checks} failed: ${message}`);
}

function equal(actual, expected, message) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

const artifactPaths = [
  "targets/liquity-bold-b40fa9b/README.md",
  "targets/liquity-bold-b40fa9b/contracts/foundry.toml",
  "targets/liquity-bold-b40fa9b/contracts/src/ActivePool.sol",
  "targets/liquity-bold-b40fa9b/contracts/src/StabilityPool.sol",
  "targets/liquity-bold-b40fa9b/contracts/test/TestContracts/InvariantsTestHandler.t.sol",
  "targets/liquity-bold-b40fa9b/contracts/test/audit/liquity-bold-stabilitypool-step1/StabilityPoolStep1.t.sol",
  "tools/capture-critical-liquity-bold-stabilitypool-step1.js",
  "tools/validate-critical-liquity-bold-stabilitypool-step1.js",
  "reports/critical-liquity-bold-stabilitypool-step1.md",
  `${prefix}.json`
];
const captureNames = ["fmt", "focused", "upstream-stability", "upstream-sp-invariant", "upstream-anchored-sp", "build"];
for (const name of captureNames) {
  artifactPaths.push(`${prefix}-${name}.capture.json`, `${prefix}-${name}.stdout.txt`, `${prefix}-${name}.stderr.txt`);
}

const manifestPath = `${prefix}-manifest.json`;
if (process.argv[2] === "--write-manifest" && process.argv.length === 3) {
  const artifacts = artifactPaths.map((artifactPath) => {
    const bytes = read(artifactPath);
    return {path: artifactPath, bytes: bytes.length, sha256: sha256(bytes)};
  });
  const aggregateSha256 = sha256(Buffer.from(artifacts.map((a) => `${a.path}:${a.sha256}`).sort().join("\n"), "utf8"));
  const manifest = {
    schemaVersion: 3,
    findingId: "liquity-bold-stabilitypool-step1",
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
check(!submodules.split(/\r?\n/u).some((line) => /^[-+]/u.test(line)), "all recursive gitlinks initialized at recorded commits");
cp.execFileSync("git", ["diff", "--exit-code", "--", "contracts/src", "contracts/test/stabilityPool.t.sol", "contracts/test/SPInvariants.t.sol", "contracts/test/AnchoredSPInvariantsTest.t.sol"], {cwd: target, stdio: "ignore"});
check(true, "production source and upstream StabilityPool tests unchanged");

const captures = {};
for (const name of captureNames) {
  const capture = json(`${prefix}-${name}.capture.json`);
  captures[name] = capture;
  equal(capture.capture, name, `${name} capture name`);
  equal(capture.cwd, "targets/liquity-bold-b40fa9b/contracts", `${name} cwd`);
  equal(capture.exitCode, 0, `${name} exit code`);
  equal(capture.signal, null, `${name} signal`);
  equal(capture.spawnError, null, `${name} spawn error`);
  check(capture.forgeVersion.stdout.includes("forge Version: 1.5.1-stable"), `${name} Forge version`);
  equal(capture.compiler, "solc 0.8.24", `${name} compiler`);
  equal([capture.evmVersion, capture.optimizer, capture.optimizerRuns], ["cancun", true, 200], `${name} compiler settings`);
  if (name !== "fmt") check(capture.command.includes("--offline") && capture.command.includes("--use"), `${name} offline exact compiler command`);
  for (const stream of ["stdout", "stderr"]) {
    const bytes = read(capture[stream].path);
    equal(bytes.length, capture[stream].bytes, `${name} ${stream} bytes`);
    equal(sha256(bytes), capture[stream].sha256, `${name} ${stream} hash`);
  }
}

equal(read(captures.fmt.stdout.path).length, 0, "fmt stdout empty");
const focused = text(captures.focused.stdout.path);
check(focused.includes("9 passed; 0 failed; 0 skipped"), "9 focused unit tests");
check(focused.includes("12 tests passed, 0 failed, 0 skipped (12 total tests)"), "12 focused total");
const focusedInvariantRows = [...focused.matchAll(/^\[PASS\] invariant_[^(]+\(\) \(runs: (\d+), calls: (\d+), reverts: (\d+)\)$/gmu)];
equal(focusedInvariantRows.length, 3, "three focused invariants");
for (const row of focusedInvariantRows) equal(row.slice(1).map(Number), [256, 16384, 0], "focused invariant tuple");
equal(focusedInvariantRows.reduce((sum, row) => sum + Number(row[2]), 0), 49152, "focused invariant calls");
check(focused.includes("invariant_aggregatePayoutsDoNotExceedModeledInputs"), "narrow aggregate payout invariant ran");
check(!focused.includes("invariant_noOverpaymentCrossUserOrDoubleClaim"), "superseded broad invariant absent");

const upstream = text(captures["upstream-stability"].stdout.path);
check(upstream.includes("91 tests passed, 0 failed, 0 skipped (91 total tests)"), "upstream StabilityPool 91/91");
const upstreamInvariant = text(captures["upstream-sp-invariant"].stdout.path);
check(upstreamInvariant.includes("invariant_AllFundsClaimable() (runs: 128, calls: 8192, reverts: 0)"), "upstream SP invariant calls");
const anchored = text(captures["upstream-anchored-sp"].stdout.path);
check(anchored.includes("9 tests passed, 0 failed, 0 skipped (9 total tests)"), "anchored SP 9/9");
const build = text(captures.build.stdout.path);
check(build.includes("Compiling 293 files with Solc 0.8.24"), "full build file/compiler count");
check(build.includes("Compiler run successful with warnings:"), "full build succeeds with retained warnings");

const P = 10n ** 36n;
const pending = 10n * 10n ** 18n + 23n;
const attackerPrincipal = 2n * 10n ** 18n;
const denominator = attackerPrincipal + 1n;
const deltaB = P * pending / denominator;
const attackerGain = attackerPrincipal * deltaB / P;
const incumbentGain = deltaB / P;
const liquidGain = attackerGain - (10n ** 18n - 1n);
const owed = pending - attackerGain;
equal(
  [pending, denominator, attackerGain, incumbentGain, liquidGain, owed - incumbentGain].map(String),
  ["10000000000000000023", "2000000000000000001", "10000000000000000017", "5", "9000000000000000018", "1"],
  "exact pending-yield floor model"
);

const result = json(`${prefix}.json`);
equal(result.revision, "R2", "result revision");
equal(result.target.commit, head, "result commit");
equal([result.focused.unitTests, result.focused.invariantProperties, result.focused.invariantCallsTotal], [9, 3, 49152], "result focused counts");
equal([result.gates.sourcePrimitive, result.gates.localRoutePositive, result.gates.routePositive, result.gates.executableNow, result.gates.signedActionJustified, result.gates.fork], [1, 1, 0, 0, false, false], "source and operational gates");
equal(result.finding.exactLocalDeltasRaw.attackerAllocatedYield, attackerGain.toString(), "result attacker gain");
equal(result.finding.exactLocalDeltasRaw.incumbentAllocatedYield, incumbentGain.toString(), "result incumbent gain");
equal(result.finding.exactLocalDeltasRaw.attackerImmediateLiquidGain, liquidGain.toString(), "result liquid gain");
equal(result.finding.exactLocalDeltasRaw.attackerPrincipalReturned, attackerPrincipal.toString(), "result full principal return");
equal(result.finding.exactLocalDeltasRaw.attackerRemainingCapturedYieldDeposit, (10n ** 18n - 1n).toString(), "result captured yield in floor");
equal([result.finding.implementedFixedPreEntryEntitlementPresent, result.finding.legalEntitlementAssessed], [false, false], "implemented/legal entitlement scope");
equal([result.productionSourceReachability.permissionless, result.productionSourceReachability.exactTenBoldFixtureSynthetic, result.productionSourceReachability.deploymentStateAndNetEconomicsClosed], [true, true, true], "source reachability versus fixture/economics");
equal([result.assurance.priorUnexpectedPayoutsConjunctVacuousAndRemoved, result.assurance.crossUserOrDoubleClaimInvariantClaimed], [true, false], "assurance correction");

const source = text("targets/liquity-bold-b40fa9b/contracts/test/audit/liquity-bold-stabilitypool-step1/StabilityPoolStep1.t.sol");
for (const required of ["test_pendingThresholdCrossingIsProcessedOnceAndEntrantDeltaIsExact", "test_stashFullWithdrawReentryAndSingleClaim", "test_repeatedPublicLoopsNoCrossUserPayoutOrDoubleClaim", "invariant_assetsAndRecordedLiabilitiesReconcile", "invariant_aggregatePayoutsDoNotExceedModeledInputs"]) {
  check(source.includes(required), `test source includes ${required}`);
}
check(!source.includes("vm.etch"), "no runtime replacement");
check(!source.includes("unexpectedPayouts"), "vacuous unexpectedPayouts counter removed");
const production = text("targets/liquity-bold-b40fa9b/contracts/src/StabilityPool.sol");
check(production.includes("yieldGainsPending = accumulatedYieldGains") && production.includes("scaleToB[currentScale] += P * accumulatedYieldGains / totalBoldDeposits"), "pending threshold source path bound");
check(production.includes("activePool.mintAggInterest();") && production.indexOf("activePool.mintAggInterest();") < production.indexOf("_updateDepositAndSnapshots(msg.sender, newDeposit, newStashedColl);") && production.indexOf("_updateDepositAndSnapshots(msg.sender, newDeposit, newStashedColl);") < production.indexOf("_updateYieldRewardsSum(0);"), "public provide ordering bound");
check(!production.includes("currentEpoch"), "no epoch state at exact commit");
const activePoolSource = text("targets/liquity-bold-b40fa9b/contracts/src/ActivePool.sol");
check(activePoolSource.includes("function mintAggInterest() external override") && activePoolSource.includes("stabilityPool.triggerBoldRewards(spYield);"), "ActivePool public-source reward reachability bound");
const upstreamHandlerSource = text("targets/liquity-bold-b40fa9b/contracts/test/TestContracts/InvariantsTestHandler.t.sol");
check(upstreamHandlerSource.includes("v.blockedSPYield") && upstreamHandlerSource.includes("See if the change unblocked any pending yield") && upstreamHandlerSource.includes("v.blockedSPYield * v.boldDeposit / v.totalBoldDeposits"), "upstream handler anticipates post-entry allocation");

const report = text("reports/critical-liquity-bold-stabilitypool-step1.md");
check(report.includes("SOURCE-CONFIRMED PRE-ENTRY PENDING-YIELD ALLOCATION"), "report signal");
check(report.includes("9000000000000000018") && report.includes("49,152") && report.includes("91/91"), "report exact delta and evidence counts");
check(report.includes("signedActionJustified=false") && report.includes("fork=false"), "report closed operational gates");
check(report.includes("ActivePool.sol:243-260") && report.includes("synthetic local authorized-yield fixture"), "report source reachability versus synthetic fixture");
check(report.includes("InvariantsTestHandler.t.sol:1629-1677") && report.includes("Legal or off-chain entitlement was not assessed"), "report handler and entitlement scope");
check(report.includes("Simply attempting to flush yield earlier") && report.includes("before the entrant snapshot"), "report precise mitigation");
check(report.includes("prior invariant included `unexpectedPayouts == 0`") && report.includes("that conjunct was vacuous"), "report vacuous invariant disclosure");
check(!report.includes("intentional-shaped"), "imprecise intentional-shaped wording absent");

const manifest = json(manifestPath);
equal(manifest.schemaVersion, 3, "manifest schema");
equal(manifest.revision, "R2", "manifest revision");
equal(manifest.artifactCount, artifactPaths.length, "manifest artifact count");
const manifestPaths = new Set();
for (const artifact of manifest.artifacts) {
  check(!manifestPaths.has(artifact.path), `unique manifest path ${artifact.path}`);
  manifestPaths.add(artifact.path);
  const bytes = read(artifact.path);
  equal(bytes.length, artifact.bytes, `manifest bytes ${artifact.path}`);
  equal(sha256(bytes), artifact.sha256, `manifest hash ${artifact.path}`);
}
for (const artifactPath of artifactPaths) check(manifestPaths.has(artifactPath), `manifest closure ${artifactPath}`);
const aggregate = sha256(Buffer.from(manifest.artifacts.map((a) => `${a.path}:${a.sha256}`).sort().join("\n"), "utf8"));
equal(aggregate, manifest.aggregateSha256, "manifest aggregate");

const inbox = json("coordination/inbox/critical/20260730-critical-liquity-bold-stabilitypool-step1.json");
equal(inbox.revision, "R2", "inbox revision");
equal(inbox.evidence.invariants, "3 invariants; each ran 256 × 64 = 16,384 calls; 49,152 total.", "inbox invariant count wording");
equal([inbox.sourcePrimitive, inbox.localRoutePositive, inbox.routePositive, inbox.executableNow, inbox.signedActionJustified, inbox.fork], [1, 1, 0, 0, false, false], "inbox gates");
equal(inbox.evidence.manifestAggregateSha256, aggregate, "inbox aggregate binding");
const handoff = text("coordination/handoffs/20260730-critical-liquity-bold-stabilitypool-step1-handoff.md");
check(handoff.includes("Step1 R2 handoff") && handoff.includes(aggregate) && handoff.includes("prior vacuous `unexpectedPayouts == 0`"), "handoff revision/aggregate/assurance binding");

console.log(`PASS ${checks} checks; aggregate ${aggregate}`);
