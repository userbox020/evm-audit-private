#!/usr/bin/env node
"use strict";

const assert = require("assert");
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TARGET_REL = "targets/valantis-stex-remediation-step3";
const TARGET = path.join(ROOT, ...TARGET_REL.split("/"));
const STEM = "critical-valantis-stex-remediation-assurance-step4";
const RAW = "reports/raw/fast";
const ARTIFACT = `${RAW}/${STEM}.json`;
const RUNBOOK = `${RAW}/${STEM}-runbook.json`;
const COMMAND_MANIFEST = `${RAW}/${STEM}-commands.json`;
const REPORT = `reports/${STEM}.md`;
const POST_MANIFEST = `${RAW}/critical-valantis-stex-khype-share-accounting-remediation-step3-post-patch-manifest.json`;
const STEP3_ARTIFACT = `${RAW}/critical-valantis-stex-khype-share-accounting-remediation-step3.json`;
const EXPECTED_TEST_ASSERTIONS = 36;
const EXPECTED_TAMPER_CLASSES = 26;

const PROPERTIES = Object.freeze([
  "invariant_ClaimSolvencyAndCumulativeAccounting",
  "invariant_IndependentLendingBackingAndOwnership",
  "invariant_LpSupplyEqualsAllActorsAndMinimumLiquidity",
  "invariant_ManagerLiveRequestsExactlyTracked",
  "invariant_PendingAggregateGhostMatchesRawSlot",
  "invariant_RawSlotPredicateEqualsProductionPredicate",
  "invariant_ShareBoundaryClassificationAndAtomicity"
]);
const ACTIONS = Object.freeze([
  "actionBufferUsed", "actionCancel", "actionCancelRequeueWithFeeChange", "actionClaim", "actionConfirm",
  "actionDeposit", "actionDonateKHYPE", "actionLendingSupply", "actionLendingWithdraw", "actionLendingYield",
  "actionManagerFunding", "actionOffset", "actionPendingSettlement", "actionQueueReserve", "actionRequeueExcess",
  "actionRewards", "actionSlashing", "actionTemporaryFailureRetry", "actionUnsafeProbeTriplet", "actionUnstakeFee",
  "actionUpdate", "actionWarp", "actionWithdrawInstant", "actionWithdrawOrdinary"
]);
const CRITICAL_TRANSITIONS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 10, 12, 14, 15, 20, 21, 22]);
const SEED = `0x${"22".repeat(32)}`;
const DEEPER_SEED = `0x${"33".repeat(32)}`;
const ALLOWED_STEP4 = Object.freeze([
  "test/invariant/step4/Step4Fixture.sol",
  "test/invariant/step4/Step4Handler.sol",
  "test/invariant/step4/ValantisRemediationAssuranceStep4.t.sol"
]);
const STEP3_HASHES = Object.freeze({
  [`${RAW}/critical-valantis-stex-khype-share-accounting-remediation-step3.patch`]: "084bdafc9a8b43d35f79af3e0e154c28d0407195ffdf287b163dc767c3b48937",
  [`${RAW}/critical-valantis-stex-khype-share-accounting-remediation-step3-baseline-manifest.json`]: "d112c816477112c2561d0b59aa07823cf728a2b75ccc75ceeec16e6e471b9835",
  [POST_MANIFEST]: "1a97ad1099399fd21c29d64ade4787195e490a38c308e2d2b2bb3cabc9000559",
  [`${RAW}/critical-valantis-stex-khype-share-accounting-remediation-step3-storage-abi-diff.json`]: "159136789538c0458f1685342c6641d7ed52eda0ec988a56ee8996e0e77d1f7c",
  [STEP3_ARTIFACT]: "f08b17066a01beb726aac979dcc7130383594afdc1955e6b8643576e5c413477",
  "reports/critical-valantis-stex-khype-share-accounting-remediation-step3.md": "dfd271fbae9c0420a7be4adcf17c0eacbee5bf49f07836c4a80394beedb983e0"
});

const rel = (value) => path.join(ROOT, ...value.split("/"));
const read = (value) => fs.readFileSync(rel(value));
const json = (value) => JSON.parse(read(value).toString("utf8"));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
let checks = 0;
function check(value, message) { checks += 1; assert.ok(value, `check ${checks}: ${message}`); }
function equal(actual, expected, message) { checks += 1; assert.deepStrictEqual(actual, expected, `check ${checks}: ${message}`); }

function exactKeys(value, expected, label) {
  check(value !== null && typeof value === "object" && !Array.isArray(value), `${label} object type`);
  equal(Object.keys(value).sort(), [...expected].sort(), `${label} exact schema`);
}

function verifyBoundData(row, data, label) {
  exactKeys(row, ["path", "bytes", "sha256"], `${label} binding`);
  check(typeof row.path === "string" && Number.isSafeInteger(row.bytes) && /^[0-9a-f]{64}$/u.test(row.sha256), `${label} binding types`);
  equal([data.length, sha256(data)], [row.bytes, row.sha256], `${label} bytes/hash`);
}

function validateEnvironmentEntry(entry, data) {
  exactKeys(entry, ["path", "bytes", "sha256"], "environment entry");
  check(typeof entry.path === "string" && Number.isSafeInteger(entry.bytes) && /^[0-9a-f]{64}$/u.test(entry.sha256), "environment entry types");
  equal([data.length, sha256(data)], [entry.bytes, entry.sha256], `environment ${entry.path}`);
}

function parseHeaders(text) {
  const value = {};
  for (const name of ["STARTED_UTC", "FINISHED_UTC", "COMMAND", "SEED", "RUNS", "DEPTH", "FAIL_ON_REVERT", "EXIT"]) {
    const matches = [...text.matchAll(new RegExp(`^${name}: (.+)$`, "gmu"))];
    if (matches.length) value[name] = matches.at(-1)[1].trim();
  }
  return value;
}

function collectFailureLines(text) {
  return text.split(/\r?\n/u).filter((line) =>
    /\[FAIL(?::|\])|Suite result:\s*FAILED|^Failing tests:|Encountered .*failing tests|^(?:EXIT|COMMAND_EXIT):\s*[1-9]\d*/iu.test(line.trim()));
}

function rejectFailureMarkers(text, label) {
  equal(collectFailureLines(text), [], `${label} all failure lines absent`);
}

function parseSuiteSummaries(text) {
  return [...text.matchAll(/Ran (\d+) test suites? in .*?: (\d+) tests passed, (\d+) failed, (\d+) skipped \((\d+) total tests\)/gu)]
    .map((match) => ({ suites: Number(match[1]), passed: Number(match[2]), failed: Number(match[3]),
      skipped: Number(match[4]), total: Number(match[5]) }));
}

function validateSuiteLog(text, expected, label) {
  rejectFailureMarkers(text, label);
  const summaries = parseSuiteSummaries(text);
  check(summaries.length > 0, `${label} suite summary exists`);
  const aggregate = summaries.reduce((sum, row) => ({ suites: sum.suites + row.suites, passed: sum.passed + row.passed,
    failed: sum.failed + row.failed, skipped: sum.skipped + row.skipped, total: sum.total + row.total }),
  { suites: 0, passed: 0, failed: 0, skipped: 0, total: 0 });
  equal(aggregate, expected, `${label} all suite summaries`);
}

function parseInvariant(text) {
  const properties = [...text.matchAll(/\[PASS\] (invariant_\w+)\(\) \(runs: (\d+), calls: (\d+), reverts: (\d+)\)/gu)]
    .map((match) => ({ name: match[1], runs: Number(match[2]), calls: Number(match[3]), reverts: Number(match[4]) }));
  const trajectories = []; let table = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/\| Step4Handler \| (action\w+)\s+\| (\d+)\s+\| (\d+)\s+\|/u);
    if (!match) continue;
    if (table[match[1]]) { trajectories.push(table); table = {}; }
    table[match[1]] = { calls: Number(match[2]), reverts: Number(match[3]) };
    if (Object.keys(table).length === ACTIONS.length) { trajectories.push(table); table = {}; }
  }
  const aggregate = Object.fromEntries(ACTIONS.map((action) => [action, { calls: 0, reverts: 0 }]));
  for (const trajectory of trajectories) for (const action of ACTIONS) if (trajectory[action]) {
    aggregate[action].calls += trajectory[action].calls; aggregate[action].reverts += trajectory[action].reverts;
  }
  return { properties, trajectories, aggregate };
}

function validateInvariantLog(text, runs, depth, seed) {
  rejectFailureMarkers(text, `invariant ${runs}x${depth}`);
  const headers = parseHeaders(text);
  equal([headers.SEED, Number(headers.RUNS), Number(headers.DEPTH), headers.FAIL_ON_REVERT, Number(headers.EXIT)],
    [seed, runs, depth, "true", 0], "invariant parameters");
  const parsed = parseInvariant(text);
  equal(parsed.properties.map((row) => row.name), PROPERTIES, "independent invariant names");
  for (const row of parsed.properties) equal([row.runs, row.calls, row.reverts], [runs, runs * depth, 0], `${row.name} dimensions`);
  equal(parsed.trajectories.length, PROPERTIES.length, "trajectory count");
  for (const trajectory of parsed.trajectories) {
    equal(Object.keys(trajectory).sort(), [...ACTIONS].sort(), "trajectory actions");
    equal(Object.values(trajectory).reduce((sum, row) => sum + row.calls, 0), runs * depth, "trajectory calls");
    equal(Object.values(trajectory).reduce((sum, row) => sum + row.reverts, 0), 0, "trajectory reverts");
  }
  equal(Object.values(parsed.aggregate).reduce((sum, row) => sum + row.calls, 0), PROPERTIES.length * runs * depth, "aggregate calls");
  return parsed;
}

function parseDirectedCoverage(text) {
  const attempts = Array(24).fill(null); const transitions = Array(24).fill(null);
  for (const match of text.matchAll(/STEP4_(ATTEMPT|TRANSITION)_(\d+): (\d+)/gu)) {
    (match[1] === "ATTEMPT" ? attempts : transitions)[Number(match[2])] = Number(match[3]);
  }
  return { attempts, transitions };
}

function validateMutationLog(text) {
  const failures = collectFailureLines(text);
  check(failures.some((line) => line.includes("[FAIL:")) && failures.some((line) => line.includes("1 failing tests")), "mutation expected failure lines");
  check(/ACTUAL_EXIT: 1/u.test(text) && /^EXIT: 1$/mu.test(text), "mutation expected exit");
  check(/live manager request hidden from module tracking/u.test(text), "mutation hidden-request assertion");
  check(!/(?:https?|wss?):\/\//iu.test(text) && !/[A-Z]:\\Users\\/u.test(text), "mutation sanitization");
}

function parseSubmoduleStatus(text) {
  return text.trimEnd().split(/\r?\n/u).filter(Boolean).map((line) => {
    const match = line.match(/^ ?([0-9a-f]{40}) ([^ ]+)/u);
    if (!match) throw new Error("SUBMODULE_STATUS_DRIFT");
    return { path: match[2], commit: match[1] };
  });
}

function walkFiles(root, prefix = "") {
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const normalized = prefix ? `${prefix}/${entry.name}` : entry.name;
    if ([".git", "out", "cache"].includes(entry.name)) continue;
    if (entry.isDirectory()) result.push(...walkFiles(root, normalized)); else result.push(normalized.replace(/\\/gu, "/"));
  }
  return result.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
}

function validateEnvironment() {
  const manifest = json(POST_MANIFEST);
  equal([manifest.entryCount, manifest.root], [1942, TARGET_REL], "Step3 manifest identity");
  const retained = new Set();
  for (const entry of manifest.entries) {
    validateEnvironmentEntry(entry, fs.readFileSync(path.join(TARGET, ...entry.path.split("/")))); retained.add(entry.path);
  }
  const actual = walkFiles(TARGET); const extras = actual.filter((value) => !retained.has(value));
  equal(extras, [...ALLOWED_STEP4].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))), "only Step4 test additions");
  equal(actual.length, manifest.entryCount + ALLOWED_STEP4.length, "complete environment file count");
  const step3 = json(STEP3_ARTIFACT);
  equal([step3.oracleDisposition, step3.findingPreserved.classification], ["APPROVE_TEMPORARY_MITIGATION", "PROVISIONAL_HIGH_SOURCE_LOCAL_NOT_CRITICAL"], "Step3 classifications");
  const status = cp.spawnSync("git", ["submodule", "status", "--recursive"], { cwd: TARGET, encoding: "utf8", env: {} });
  equal(status.status, 0, "submodule status command");
  equal(parseSubmoduleStatus(status.stdout), step3.sourceBinding.recursiveGitlinks.map(({ path: p, commit }) => ({ path: p, commit })), "submodule identities/pins");
  const head = cp.spawnSync("git", ["rev-parse", "HEAD^{commit}", "HEAD^{tree}"], { cwd: TARGET, encoding: "utf8", env: {} });
  equal([head.status, ...head.stdout.trim().split(/\r?\n/u)], [0, step3.sourceBinding.commit, step3.sourceBinding.tree], "repository identity");
}

function validateRunbook(runbook) {
  exactKeys(runbook, ["schemaVersion", "claimId", "status", "deploymentDisposition", "zeroStateGates", "compatibility",
    "requestEnumeration", "stagedRollout", "monitoring", "pauseLimitation", "abortRollback", "residualRisks"], "runbook");
  equal([runbook.status, runbook.deploymentDisposition, runbook.abortRollback.noLiveAction], ["OFFLINE_DESIGN_ONLY_NO_LIVE_ACTION", "PRODUCTION_DEPLOYMENT_BLOCKED", true], "runbook disposition");
  const gates = runbook.zeroStateGates.requiredBeforeCanaryAndEveryUnpause;
  for (const key of ["amountToken0PendingUnstaking", "amountToken0PendingUnstakingOffsetSlot12", "pendingUnstakeRequestCountSlot18",
    "amountToken1PendingLPWithdrawalCoveredByQueuedUnstakeSlot23", "localKHYPEBalance", "managerLiveRequestsCurrentAndLegacy",
    "untrackedManagerLiveRequestsCurrentAndLegacy", "unreconciledFeeOrRoundingResidual"]) equal(gates[key], "0", `runbook zero ${key}`);
  check(runbook.zeroStateGates.claimsFormula.includes("sum(unmigrated active amountToken1)"), "claim formula");
  check(runbook.zeroStateGates.lendingFormula.includes("yieldToken.balanceOf(lendingModule)"), "lending formula");
  check(runbook.zeroStateGates.feeFormula.includes("token0.balanceOf(STEX) == 0"), "fee formula");
  equal(runbook.stagedRollout.productionDonationDrillForbidden, true, "production donation drill forbidden");
  equal(runbook.stagedRollout.stageFormula, {
    initialCanary: "amount <= min(0.01 token, liquidReserves / 10000)",
    observation: "duration >= max(30 minutes, 2 proven finality windows)",
    limits: ["<= 1 bp", "<= 5 bp", "<= 25 bp"],
    minimumTimePerLimit: ">= withdrawalDelay + 2 proven finality windows",
    unrestricted: "forbidden until every alert is zero through all stages and a new independent approval is issued"
  }, "staged rollout formulas");
  for (const name of ["unsafeTerm", "queue", "donation", "residual", "request", "claim", "lending", "fee", "runtime"]) check(runbook.monitoring.alerts.some((row) => row.name === name), `numeric alert ${name}`);
  check(runbook.pauseLimitation.includes("pause does not stop withdrawals"), "pause limitation");
  check(runbook.abortRollback.oldModuleLimitation.includes("does not automatically restore old-module ownership"), "rollback limitation");
}

function validateArtifactSchema(artifact) {
  exactKeys(artifact, ["schemaVersion", "claimId", "classification", "oracleDispositionPreserved", "findingPreserved",
    "independentInvariantCount", "independentInvariants", "omissions", "hiddenRequestAssurance", "shareBoundary",
    "atomicityDigestCoverage", "campaign", "deeperCampaign", "directedCoverage", "mutation", "environmentValidation",
    "files", "evidence", "validation", "availabilityGriefing", "deployment", "residualRisks", "safety"], "artifact");
  check(Number.isSafeInteger(artifact.schemaVersion) && Array.isArray(artifact.independentInvariants) && Array.isArray(artifact.files), "artifact field types");
}

function validateArtifact(artifact, invariant, deeper, coverage) {
  validateArtifactSchema(artifact);
  equal([artifact.schemaVersion, artifact.independentInvariantCount, artifact.omissions.fullLpPendingLiabilityGhostImplemented], [4, 7, false], "artifact invariant scope");
  equal(artifact.classification, "STATEFUL_ASSURANCE_PASS / TEMPORARY_FAIL_CLOSED_SOURCE_MITIGATION / PRODUCTION_DEPLOYMENT_BLOCKED", "artifact classification");
  equal(artifact.campaign.perPropertyTrajectories, invariant.properties, "primary trajectories");
  equal([artifact.campaign.aggregateCalls, artifact.campaign.frameworkReverts], [57344, 0], "primary totals");
  equal(artifact.deeperCampaign.perPropertyTrajectories, deeper.properties, "deeper trajectories");
  equal(artifact.deeperCampaign.aggregateCalls, 28672, "deeper total");
  equal(artifact.campaign.aggregateSelectorCalls, invariant.aggregate, "selector aggregate");
  equal([artifact.directedCoverage.attempts, artifact.directedCoverage.transitions], [coverage.attempts, coverage.transitions], "directed coverage");
  for (const index of CRITICAL_TRANSITIONS) check(coverage.transitions[index] > 0, `critical transition ${index}`);
  equal(artifact.mutation.hiddenRequestMutationDetected, true, "mutation detected");
  equal(artifact.validation, { directed: 13, focused: 44, relevant: 104, full: 271,
    validatorAssertions: EXPECTED_TEST_ASSERTIONS, distinctTamperClasses: EXPECTED_TAMPER_CLASSES }, "validation metrics");
  equal(artifact.deployment.disposition, "PRODUCTION_DEPLOYMENT_BLOCKED", "deployment blocked");
  equal(artifact.safety, { rpc: false, networkCapture: false, signing: false, transactions: 0, broadcast: false,
    fork: false, liveMutation: false, productionDeployment: false }, "offline safety");
  equal(artifact.evidence.runbookSha256, sha256(read(RUNBOOK)), "runbook binding");
  equal(artifact.evidence.commandManifestSha256, sha256(read(COMMAND_MANIFEST)), "command binding");
  for (const row of artifact.files) verifyBoundData(row, read(row.path), row.path);
}

function validateCommandManifest(manifest, artifact) {
  exactKeys(manifest, ["schemaVersion", "claimId", "scope", "offline", "forge", "solc", "targetSelectors", "commands", "safety"], "command manifest");
  equal([manifest.schemaVersion, manifest.scope, manifest.forge.version, manifest.solc.version], [3, "BOUND_INPUT_COMMANDS_ONLY_EXCLUDES_FINAL_VALIDATOR_AND_CLOSEOUT", "1.5.1-stable", "0.8.28"], "command manifest identity");
  equal(manifest.targetSelectors, ACTIONS, "target selectors");
  const expectedIds = ["format", "build", "invariant", "deeper", "directed", "focused", "relevant", "full", "mutation"];
  equal(manifest.commands.map((row) => row.id), expectedIds, "ordered command IDs");
  let priorFinished = ""; const byId = {};
  for (const row of manifest.commands) {
    check(/^20\d\d-.+Z$/u.test(row.startedUtc) && /^20\d\d-.+Z$/u.test(row.finishedUtc), `${row.id} timestamps`);
    check(row.startedUtc >= priorFinished && row.finishedUtc >= row.startedUtc, `${row.id} strict chronology`);
    priorFinished = row.finishedUtc; byId[row.id] = row;
    const data = read(row.path); equal([data.length, sha256(data)], [row.bytes, row.sha256], `${row.id} log binding`);
    const headers = parseHeaders(data.toString("utf8"));
    equal([headers.STARTED_UTC, headers.FINISHED_UTC, Number(headers.EXIT)], [row.startedUtc, row.finishedUtc, row.exit], `${row.id} log chronology/exit`);
  }
  equal(artifact.evidence.commandManifestSha256, sha256(read(COMMAND_MANIFEST)), "artifact command hash");
  return byId;
}

function resultObject(semanticChecks) {
  return { status: "PASS", independentInvariants: 7, perPropertyCalls: 8192, aggregateCalls: 57344,
    deeperAggregateCalls: 28672, frameworkReverts: 0, directedTests: 13, focusedTests: 44, relevantTests: 104,
    fullTests: 271, mutationDetected: true, semanticChecks, validatorTestAssertions: EXPECTED_TEST_ASSERTIONS,
    distinctTamperClasses: EXPECTED_TAMPER_CLASSES, productionSourceUnchanged: true, networkReads: 0, transactions: 0 };
}

function renderResult(value) { return `${JSON.stringify(value, null, 2)}\n`; }

function validate() {
  checks = 0;
  for (const [file, expected] of Object.entries(STEP3_HASHES)) equal(sha256(read(file)), expected, `${file} Step3 hash`);
  validateEnvironment();
  const artifact = json(ARTIFACT); const commands = json(COMMAND_MANIFEST);
  const byId = validateCommandManifest(commands, artifact);
  for (const id of ["format", "build", "invariant", "deeper", "directed", "focused", "relevant", "full"]) rejectFailureMarkers(read(byId[id].path).toString("utf8"), id);
  equal([byId.invariant.seed, byId.invariant.runs, byId.invariant.depth, byId.invariant.failOnRevert], [SEED, 128, 64, true], "primary manifest parameters");
  equal([byId.deeper.seed, byId.deeper.runs, byId.deeper.depth, byId.deeper.failOnRevert], [DEEPER_SEED, 32, 128, true], "deeper manifest parameters");
  const invariant = validateInvariantLog(read(byId.invariant.path).toString("utf8"), 128, 64, SEED);
  const deeper = validateInvariantLog(read(byId.deeper.path).toString("utf8"), 32, 128, DEEPER_SEED);
  const directedText = read(byId.directed.path).toString("utf8"); const coverage = parseDirectedCoverage(directedText);
  equal(coverage.attempts, Array(24).fill(1), "all actions attempted");
  validateSuiteLog(directedText, { suites: 1, passed: 13, failed: 0, skipped: 0, total: 13 }, "directed");
  validateSuiteLog(read(byId.focused.path).toString("utf8"), { suites: 1, passed: 44, failed: 0, skipped: 0, total: 44 }, "focused");
  validateSuiteLog(read(byId.relevant.path).toString("utf8"), { suites: 4, passed: 104, failed: 0, skipped: 0, total: 104 }, "relevant");
  validateSuiteLog(read(byId.full.path).toString("utf8"), { suites: 17, passed: 271, failed: 0, skipped: 0, total: 271 }, "full");
  validateMutationLog(read(byId.mutation.path).toString("utf8"));
  validateArtifact(artifact, invariant, deeper, coverage);
  validateRunbook(json(RUNBOOK));
  const testLog = read(artifact.evidence.finalValidatorTests.path);
  equal(sha256(testLog), artifact.evidence.finalValidatorTests.expectedSha256, "final validator-tests deterministic hash");
  const testResult = JSON.parse(testLog.toString("utf8"));
  equal([testResult.status, testResult.assertions, testResult.distinctTamperClasses], ["PASS", EXPECTED_TEST_ASSERTIONS, EXPECTED_TAMPER_CLASSES], "validator-test result metrics");
  const report = read(REPORT).toString("utf8");
  for (const required of ["STATEFUL_ASSURANCE_PASS", "PRODUCTION_DEPLOYMENT_BLOCKED", "7 independent invariants", "57,344 aggregate calls",
    "PERMISSIONLESS_SHUTDOWN_GRIEFING_VECTOR", sha256(read(RUNBOOK)), sha256(read(COMMAND_MANIFEST)), sha256(read(ARTIFACT)),
    artifact.evidence.finalValidator.expectedSha256]) check(report.includes(required), `report ${required}`);
  check(report.includes("closeout manifest is outside validator scope") && report.endsWith("\n") && !/[ \t]+$/gmu.test(report), "report scope/formatting");

  const result = resultObject(checks + 1);
  equal(artifact.evidence.finalValidator.expectedSha256, sha256(Buffer.from(renderResult(result))), "expected final validator output hash");
  return result;
}

module.exports = { ACTIONS, CRITICAL_TRANSITIONS, DEEPER_SEED, EXPECTED_TAMPER_CLASSES, EXPECTED_TEST_ASSERTIONS,
  PROPERTIES, SEED, collectFailureLines, exactKeys, parseDirectedCoverage, parseHeaders, parseInvariant,
  parseSubmoduleStatus, parseSuiteSummaries, renderResult, resultObject, validateArtifactSchema, validateEnvironmentEntry,
  validateInvariantLog, validateMutationLog, validateRunbook, validateSuiteLog, verifyBoundData, validate };

if (require.main === module) {
  try {
    if (process.argv.length !== 2) throw new Error("NO_ARGUMENTS_ALLOWED");
    process.stdout.write(renderResult(validate()));
  } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
}
