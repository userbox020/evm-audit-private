#!/usr/bin/env node
"use strict";

const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const runnerModule = require("./critical-stakewise-v3-eth-exitqueue-step2-runner.js");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "stakewise-v3-core-v5.0.1");
const PREFIX = "reports/raw/fast/critical-stakewise-v3-eth-exitqueue-step2";
const MANIFEST = `${PREFIX}-manifest.json`;
const PREFLIGHT_LINEAGE_MANIFEST = `${PREFIX}-preflight-lineage-manifest.json`;
const CAPTURE = `${PREFIX}-capture.json`;
const CLOSEOUT = `${PREFIX}-closeout.json`;
const APPROVAL = "coordination/decisions/stakewise-v3-eth-exitqueue-step2-r2-approval.json";
const LEDGER = "coordination/decisions/stakewise-v3-eth-exitqueue-step2-consumption-ledger.json";
const rel = (value) => path.join(ROOT, ...value.split("/"));
const read = (value) => fs.readFileSync(rel(value));
const text = (value) => read(value).toString("utf8");
const json = (value) => JSON.parse(text(value));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error(`check ${checks} failed: ${message}`);
}

function equal(actual, expected, message) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`);
}

const specs = [
  { name: "check-only", script: "tools/critical-stakewise-v3-eth-exitqueue-step2-runner.js", args: ["--check-only"] },
  { name: "test", script: "tools/test-critical-stakewise-v3-eth-exitqueue-step2.js", args: [] }
];
const boundArtifacts = runnerModule.BOUND_FILES.map((value) => `targets/stakewise-v3-core-v5.0.1/${value}`);
const captureArtifacts = specs.flatMap((spec) => [
  `${PREFIX}-${spec.name}.capture.json`,
  `${PREFIX}-${spec.name}.stdout.txt`,
  `${PREFIX}-${spec.name}.stderr.txt`
]);
const artifacts = [
  "tools/critical-stakewise-v3-eth-exitqueue-step2-runner.js",
  "tools/test-critical-stakewise-v3-eth-exitqueue-step2.js",
  "tools/validate-critical-stakewise-v3-eth-exitqueue-step2.js",
  "tools/fixtures/critical-stakewise-v3-eth-exitqueue-step2-fixtures.json",
  "reports/critical-stakewise-v3-eth-exitqueue-step2-preflight.md",
  `${PREFIX}-preflight.json`,
  `${PREFIX}-approval-proposal.json`,
  PREFLIGHT_LINEAGE_MANIFEST,
  CAPTURE,
  CLOSEOUT,
  APPROVAL,
  LEDGER,
  "reports/raw/fast/critical-stakewise-v3-eth-exitqueue-step1-manifest.json",
  "coordination/inbox/critical/stakewise-v3-eth-exitqueue-step2.json",
  "coordination/handoffs/2026-07-30-critical-stakewise-v3-step2-preflight.md",
  ...boundArtifacts,
  ...captureArtifacts
];

function captureOffline() {
  for (const spec of specs) {
    const result = cp.spawnSync(process.execPath, [rel(spec.script), ...spec.args], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {}
    });
    const stdout = Buffer.from(result.stdout || "", "utf8");
    const stderr = Buffer.from(result.stderr || "", "utf8");
    const stdoutPath = `${PREFIX}-${spec.name}.stdout.txt`;
    const stderrPath = `${PREFIX}-${spec.name}.stderr.txt`;
    fs.writeFileSync(rel(stdoutPath), stdout);
    fs.writeFileSync(rel(stderrPath), stderr);
    fs.writeFileSync(rel(`${PREFIX}-${spec.name}.capture.json`), `${JSON.stringify({
      schemaVersion: 2,
      capture: spec.name,
      classification: "OFFLINE_LOCAL_ONLY",
      command: `node ${spec.script}${spec.args.length ? ` ${spec.args.join(" ")}` : ""}`,
      expectedExitCode: 0,
      exitCode: result.status,
      signal: result.signal,
      spawnError: result.error ? String(result.error.message || result.error) : null,
      networkReads: 0,
      inventoryReads: 0,
      liveCaptureExecuted: false,
      stdout: { path: stdoutPath, bytes: stdout.length, sha256: sha256(stdout) },
      stderr: { path: stderrPath, bytes: stderr.length, sha256: sha256(stderr) }
    }, null, 2)}\n`, "utf8");
    if (result.status !== 0 || result.error) throw new Error(`${spec.name} failed`);
  }
  fs.writeFileSync(rel(`${PREFIX}-preflight.json`), read(`${PREFIX}-check-only.stdout.txt`));
}

function manifestRecords() {
  return artifacts.map((artifactPath) => {
    const bytes = read(artifactPath);
    return { path: artifactPath, bytes: bytes.length, sha256: sha256(bytes) };
  });
}

if (process.argv[2] === "--capture-offline" && process.argv.length === 3) {
  throw new Error("OFFLINE_CAPTURE_REGENERATION_FORBIDDEN_AFTER_CONSUMPTION");
}

if (process.argv[2] === "--write-manifest" && process.argv.length === 3) {
  if (!fs.existsSync(rel(PREFLIGHT_LINEAGE_MANIFEST))) {
    const current = read(MANIFEST);
    const parsed = JSON.parse(current.toString("utf8"));
    if (parsed.status !== "REVIEW_REQUESTED_NOT_AUTHORIZED_NOT_EXECUTED" ||
      parsed.aggregateSha256 !== "e4b900717871c9ae85f0e819ec1e01941ccd140cdc0cd29d97b0bdc5d1f7f357" ||
      sha256(current) !== "8548ad7f9f34a90a5748279024280efd8e60d877dbcd50eb97aaf7a2ad8779d6") {
      throw new Error("PREFLIGHT_LINEAGE_SOURCE_MISMATCH");
    }
    fs.writeFileSync(rel(PREFLIGHT_LINEAGE_MANIFEST), current, { flag: "wx" });
  }
  const records = manifestRecords();
  const aggregateSha256 = sha256(Buffer.from(records.map((row) => `${row.path}:${row.sha256}`).sort().join("\n"), "utf8"));
  fs.writeFileSync(rel(MANIFEST), `${JSON.stringify({
    schemaVersion: 2,
    findingId: "stakewise-v3-eth-exitqueue-step2-closeout",
    status: "CAPTURE_INCOMPLETE_TWO_FAMILY_PIN_THRESHOLD_NOT_MET_RETRY_NOT_AUTHORIZED",
    algorithm: "sha256",
    aggregateConstruction: "sha256(sorted(path + ':' + sha256).join('\\n'))",
    artifactCount: records.length,
    aggregateSha256,
    artifacts: records
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`WROTE ${records.length} artifacts; aggregate ${aggregateSha256}\n`);
  process.exit(0);
}

check(process.argv.length === 2, "usage: no args or --write-manifest; consumed capture cannot be regenerated");
equal(cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: TARGET, encoding: "utf8" }).trim(),
  "fc70cbe1b3d41bc5f78434830d837aa270ca33bc", "exact target commit");
equal(cp.execFileSync("git", ["describe", "--tags", "--exact-match"], { cwd: TARGET, encoding: "utf8" }).trim(),
  "v5.0.1", "exact target tag");
for (const script of ["tools/critical-stakewise-v3-eth-exitqueue-step2-runner.js",
  "tools/test-critical-stakewise-v3-eth-exitqueue-step2.js", "tools/validate-critical-stakewise-v3-eth-exitqueue-step2.js"]) {
  equal(cp.spawnSync(process.execPath, ["--check", rel(script)], { cwd: ROOT }).status, 0, `${script} syntax`);
}

const runner = text("tools/critical-stakewise-v3-eth-exitqueue-step2-runner.js");
for (const marker of [
  "MODE_CONFLICT", "GLOBALLY_CONSUMED_BEFORE_INVENTORY_ACCESS", "fs.openSync(authorization.ledgerPath, \"wx\")",
  "maxApprovalWindowMs", "FIXED_OUTPUT_REL", "GLOBAL_LEDGER_REL", "validatePackageManifest(manifest)",
  "FactoryRemoved", "MetaVaultCreated", "V2ExitQueueEntered", "INVALID_V2_V3_MIGRATION",
  "ASYMMETRIC_FACTORY_MEMBERSHIP", "ASYMMETRIC_VAULT_MEMBERSHIP", "MALFORMED_OR_OUT_OF_RANGE_LOG",
  "CONFLICTING_DUPLICATE_LOG", "implementationViewMatchedSlot", "expectedProxyRuntimeHash",
  "expectedImplementationRuntimeHash", "expectedNativeVaultId", "INCOMPLETE_ALL_PROMOTION_GATES_NULL",
  "BUDGET_EXHAUSTED_", "aggregateEventShapeCommitment", "runtimeHashesPersisted: false"
]) check(runner.includes(marker), `runner marker ${marker}`);
for (const method of ["eth_call", "eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getLogs"]) {
  check(runner.includes(`\"${method}\"`), `allowed method ${method}`);
}
for (const method of ["eth_getStorageAt", "debug_traceCall", "trace_call", "eth_sendRawTransaction", "eth_sendTransaction"]) {
  check(runner.includes(`\"${method}\"`), `forbidden method ${method}`);
}
check(!runner.includes("eth_getBalance"), "balance method absent");
const mainSource = runner.slice(runner.indexOf("async function main"));
check(mainSource.indexOf("if (!args.capture)") < mainSource.indexOf("runCapture(args)"), "check-only returns before capture");
const captureSource = runner.slice(runner.indexOf("async function runCapture"));
check(captureSource.indexOf("validateApproval(args)") < captureSource.indexOf("consumeApprovalAtomically(authorization)"),
  "approval before consumption");
check(captureSource.indexOf("consumeApprovalAtomically(authorization)") < captureSource.indexOf("loadInventoryAuthorized()"),
  "consumption before inventory");
equal((runner.match(/loadInventoryAuthorized\(\)/gu) || []).length, 2, "single capture-only inventory call");

const preflight = json(`${PREFIX}-preflight.json`);
equal(preflight.status, "PREPARED_NOT_AUTHORIZED_NOT_EXECUTED", "preflight status");
equal([preflight.authorization.proposalState, preflight.authorization.proposalAuthorization,
  preflight.authorization.authorized, preflight.authorization.captureExecuted],
  ["REVIEW_REQUESTED", "NOT_AUTHORIZED", false, false], "authorization state");
equal([preflight.networkReads, preflight.inventoryReads, preflight.writes], [0, 0, 0], "check-only zero side effects");
equal(preflight.authorization.fixedOutputPath, runnerModule.FIXED_OUTPUT_REL, "fixed output");
equal(preflight.authorization.globalConsumptionLedger, runnerModule.GLOBAL_LEDGER_REL, "global ledger");
equal(preflight.localMap.boundFileCount, runnerModule.BOUND_FILES.length, "bound file count");
equal(preflight.localMap.packageSourceBinding, runnerModule.dryPreflight().localMap.packageSourceBinding, "source binding");
equal(preflight.methods.allowed, [...runnerModule.ALLOWED_METHODS].sort(), "exact allowlist");
equal([preflight.gates.exactAffectedRuntime, preflight.gates.historicallyProvenTrigger, preflight.gates.currentlyLockedValue],
  [null, null, null], "promotion gates null");
equal([preflight.gates.routePositive, preflight.gates.executableNow, preflight.gates.signedActionJustified, preflight.gates.fork],
  [0, 0, false, false], "operational gates closed");

const proposal = json(`${PREFIX}-approval-proposal.json`);
equal([proposal.state, proposal.authorization, proposal.captureExecuted], ["REVIEW_REQUESTED", "NOT_AUTHORIZED", false],
  "proposal not authorization");
equal(proposal.proposalCommitment, runnerModule.bytes32Commitment(proposal.proposalPayload), "proposal commitment");
equal(proposal.proposalPayload.runnerSha256, `0x${sha256(read("tools/critical-stakewise-v3-eth-exitqueue-step2-runner.js"))}`,
  "proposal runner binding");
equal(proposal.proposalPayload.packageSourceBinding, preflight.localMap.packageSourceBinding, "proposal source binding");
equal(proposal.proposalPayload.capsCommitment, runnerModule.bytes32Commitment(runnerModule.CAPS), "proposal caps binding");
equal(proposal.proposalPayload.requestedApprovalId, proposal.reviewerIssuedApprovalRequirements.requestedApprovalId,
  "proposal-bound unique approval ID");
equal([proposal.proposalPayload.fixedApprovalPath, proposal.proposalPayload.fixedOutputPath,
  proposal.proposalPayload.globalConsumptionLedger],
  [runnerModule.FIXED_APPROVAL_REL, runnerModule.FIXED_OUTPUT_REL, runnerModule.GLOBAL_LEDGER_REL], "proposal fixed paths");
equal([proposal.reviewerIssuedApprovalRequirements.issuedAt, proposal.reviewerIssuedApprovalRequirements.expiresAt,
  proposal.reviewerIssuedApprovalRequirements.packageManifestSha256,
  proposal.reviewerIssuedApprovalRequirements.packageAggregateSha256], [null, null, null, null],
  "reviewer fields intentionally unissued");

const approvalBytes = read(APPROVAL);
const approval = JSON.parse(approvalBytes.toString("utf8"));
const ledgerBytes = read(LEDGER);
const ledger = JSON.parse(ledgerBytes.toString("utf8"));
const captureBytes = read(CAPTURE);
const consumedCapture = JSON.parse(captureBytes.toString("utf8"));
const lineageBytes = read(PREFLIGHT_LINEAGE_MANIFEST);
const lineage = JSON.parse(lineageBytes.toString("utf8"));
const closeout = json(CLOSEOUT);
const expectedApprovalId = "swv3-step2-7c30e7d4a96f41b28d5e3f7081c6a942";
const expectedApprovalCommitment = "0xffc821fa427dffe6e491ea451fc608f8579602d40faeba648a9ceeface025705";
equal([approval.schemaVersion, approval.state, approval.approvalPayload.approvalId,
  approval.approvalPayload.authorizedCaptureCount, approval.approvalCommitment],
  [2, "AUTHORIZED", expectedApprovalId, 1, expectedApprovalCommitment], "exact consumed approval");
equal(approval.approvalCommitment, runnerModule.bytes32Commitment(approval.approvalPayload),
  "approval canonical commitment");
equal([approval.approvalPayload.fixedOutputPath, approval.approvalPayload.globalConsumptionLedger,
  approval.approvalPayload.runnerSha256, approval.approvalPayload.packageSourceBinding,
  approval.approvalPayload.proposalCommitment],
  [runnerModule.FIXED_OUTPUT_REL, runnerModule.GLOBAL_LEDGER_REL, proposal.proposalPayload.runnerSha256,
    proposal.proposalPayload.packageSourceBinding, proposal.proposalCommitment], "approval preflight bindings");
equal([approval.approvalPayload.packageAggregateSha256, approval.approvalPayload.packageManifestSha256],
  ["0xe4b900717871c9ae85f0e819ec1e01941ccd140cdc0cd29d97b0bdc5d1f7f357",
    "0x8548ad7f9f34a90a5748279024280efd8e60d877dbcd50eb97aaf7a2ad8779d6"],
  "approval preflight package lineage");
equal([sha256(approvalBytes), approvalBytes.length],
  ["3b0a0d686b557e91d4928b4d7ce6219f31d22cf88eddb69dde2d1f099ed6ac4b", 1498], "approval immutable hash");
equal([ledger.schemaVersion, ledger.findingId, ledger.approvalId, ledger.approvalCommitment, ledger.status],
  [1, "stakewise-v3-eth-exitqueue-step2", expectedApprovalId, expectedApprovalCommitment,
    "GLOBALLY_CONSUMED_BEFORE_INVENTORY_ACCESS"], "global ledger exact consumption");
equal([sha256(ledgerBytes), ledgerBytes.length],
  ["140fb4b9f98d218af69589e8a0902ef73f2f2323a64b42dce873a424aff2bded", 290], "ledger immutable hash");
equal([lineage.status, lineage.aggregateSha256, sha256(lineageBytes), lineageBytes.length],
  ["REVIEW_REQUESTED_NOT_AUTHORIZED_NOT_EXECUTED", "e4b900717871c9ae85f0e819ec1e01941ccd140cdc0cd29d97b0bdc5d1f7f357",
    "8548ad7f9f34a90a5748279024280efd8e60d877dbcd50eb97aaf7a2ad8779d6", 5717],
  "preflight manifest immutable lineage");
equal(lineage.artifacts.find((row) => row.path === "tools/critical-stakewise-v3-eth-exitqueue-step2-runner.js").sha256,
  "9245eb0d582670c2fbc8534ad07325103650a79d5d53feb6e334c6eacf7ff341", "preflight runner lineage");
equal([consumedCapture.schemaVersion, consumedCapture.findingId, consumedCapture.status, consumedCapture.reasonCode,
  consumedCapture.liveCaptureExecuted, consumedCapture.resultPromoted],
  [2, "stakewise-v3-eth-exitqueue-step2", "INCOMPLETE_ALL_PROMOTION_GATES_NULL",
    "TWO_FAMILY_PIN_THRESHOLD_NOT_MET", true, false], "consumed capture exact result");
equal(Object.values(consumedCapture.promotionGates), [null, null, null, null, null, null],
  "all six promotion gates null");
equal(Object.values(consumedCapture.operationalGates), [0, 0, false, false], "operational gates closed");
equal([consumedCapture.budget.total, consumedCapture.budget.responseBytes, consumedCapture.budget.logs,
  consumedCapture.budget.logsReturned, consumedCapture.budget.calls, consumedCapture.budget.codes,
  consumedCapture.budget.blocks, consumedCapture.budget.retries, consumedCapture.budget.chunks,
  consumedCapture.budget.timestampFetches], [23, 172, 0, 0, 0, 0, 0, 0, 0, 0],
  "qualification-only budget exact");
equal([consumedCapture.budget.exhausted, consumedCapture.budget.elapsedWithinCap, consumedCapture.budget.allWithinCaps],
  [null, true, true], "capture caps pass");
equal(consumedCapture.budget.total,
  23 + consumedCapture.budget.logs + consumedCapture.budget.calls + consumedCapture.budget.codes +
    consumedCapture.budget.blocks + consumedCapture.budget.retries,
  "budget arithmetic: 23 qualification and zero downstream/retries");
equal([sha256(captureBytes), captureBytes.length],
  ["70a3a4a278e2c44c35bb3ceef5a272412a37e263099bc6e845bf7ec32ea60e69", 891], "capture immutable hash");
const captureNames = fs.readdirSync(path.dirname(rel(CAPTURE)))
  .filter((name) => name === path.basename(CAPTURE));
equal(captureNames.length, 1, "exactly one fixed consumed capture present");
equal([closeout.classification, closeout.status, closeout.reasonCode],
  ["CAPTURE_INCOMPLETE/TWO_FAMILY_PIN_THRESHOLD_NOT_MET/NO_RUNTIME-STATE-HISTORY/ALL_PROMOTION_GATES_NULL/RETRY_NOT_AUTHORIZED",
    "INCOMPLETE_ALL_PROMOTION_GATES_NULL", "TWO_FAMILY_PIN_THRESHOLD_NOT_MET"], "closeout classification");
equal([closeout.approval.consumed, closeout.approval.retryAuthorized, closeout.qualification.sanitizedReadsAttempted,
  closeout.qualification.responseBytes, closeout.qualification.twoFamilyPinThresholdMet,
  closeout.qualification.zeroEndpointsClaimed, closeout.qualification.providerIndependenceProven],
  [true, false, 23, 172, false, false, false], "qualification caveats");
equal([closeout.downstreamCoverage.logRequests, closeout.downstreamCoverage.calls,
  closeout.downstreamCoverage.codeRequests, closeout.downstreamCoverage.blockRequests,
  closeout.downstreamCoverage.retries, closeout.downstreamCoverage.chunks,
  closeout.downstreamCoverage.timestampFetches, closeout.downstreamCoverage.runtimeAssessed,
  closeout.downstreamCoverage.stateAssessed, closeout.downstreamCoverage.historyAssessed,
  closeout.downstreamCoverage.exposureAbsenceClaimed], [0, 0, 0, 0, 0, 0, 0, false, false, false, false],
  "no downstream coverage or absence claim");
equal(Object.values(closeout.promotionGates), [null, null, null, null, null, null], "closeout gates null");
equal([closeout.postCapture.inventoryReads, closeout.postCapture.networkReads, closeout.postCapture.rpcReads,
  closeout.postCapture.captureRetries, closeout.postCapture.automaticRetryAllowed], [0, 0, 0, 0, false],
  "offline closeout and no retry");

const immutableBeforeCheckOnly = [CAPTURE, LEDGER, APPROVAL].map((value) => sha256(read(value)));
const checkOnlyRun = cp.spawnSync(process.execPath,
  [rel("tools/critical-stakewise-v3-eth-exitqueue-step2-runner.js"), "--check-only"],
  { cwd: ROOT, encoding: "utf8", env: {} });
equal([checkOnlyRun.status, checkOnlyRun.stderr, JSON.parse(checkOnlyRun.stdout).writes,
  JSON.parse(checkOnlyRun.stdout).inventoryReads, JSON.parse(checkOnlyRun.stdout).networkReads],
  [0, "", 0, 0, 0], "post-capture check-only remains zero-write/read");
equal([CAPTURE, LEDGER, APPROVAL].map((value) => sha256(read(value))), immutableBeforeCheckOnly,
  "check-only did not mutate capture ledger or approval");

for (const spec of specs) {
  const capture = json(`${PREFIX}-${spec.name}.capture.json`);
  equal([capture.capture, capture.classification, capture.exitCode, capture.signal, capture.spawnError],
    [spec.name, "OFFLINE_LOCAL_ONLY", 0, null, null], `${spec.name} metadata`);
  equal([capture.networkReads, capture.inventoryReads, capture.liveCaptureExecuted], [0, 0, false], `${spec.name} offline only`);
  for (const stream of ["stdout", "stderr"]) {
    const bytes = read(capture[stream].path);
    equal([bytes.length, sha256(bytes)], [capture[stream].bytes, capture[stream].sha256], `${spec.name} ${stream} binding`);
  }
}
equal(JSON.parse(text(`${PREFIX}-check-only.stdout.txt`)), preflight, "captured check-only equals preflight");
equal(text(`${PREFIX}-check-only.stderr.txt`), "", "check-only stderr empty");
const testResult = JSON.parse(text(`${PREFIX}-test.stdout.txt`));
equal([testResult.status, testResult.checks, testResult.fixtureClasses, testResult.networkReads,
  testResult.inventoryReads, testResult.captureExecuted], ["PASS", 63, 22, 0, 0, false], "fixture result");
equal(text(`${PREFIX}-test.stderr.txt`), "", "fixture stderr empty");

const fixture = json("tools/fixtures/critical-stakewise-v3-eth-exitqueue-step2-fixtures.json");
equal(fixture.oracleCorrectionCases.length, 22, "all requested fixture classes retained");
for (const name of ["approval-replay", "meta-vault-created", "removed-factory-history", "asymmetric-membership",
  "v2-v3-zero-asset-migration", "noncanonical-block-hash", "global-byte-exhaustion", "false-exact-proxy-runtime"]) {
  check(fixture.oracleCorrectionCases.includes(name), `fixture class ${name}`);
}

const report = text("reports/critical-stakewise-v3-eth-exitqueue-step2-preflight.md");
for (const marker of ["CAPTURE_INCOMPLETE / TWO_FAMILY_PIN_THRESHOLD_NOT_MET", "2 + 3 + 4 = 9",
  "atomic global consumption ledger", "MetaVaultCreated", "V2ExitQueueEntered", "ExitQueue.sol:105-113",
  "implementationViewMatchedSlot", "All six promotion gates are null", "23` sanitized reads",
  "Retry is not authorized", "new offline package and independent review"] ) {
  check(report.includes(marker), `report marker ${marker}`);
}
const inbox = json("coordination/inbox/critical/stakewise-v3-eth-exitqueue-step2.json");
equal([inbox.status, inbox.classification, inbox.routePositive, inbox.executableNow,
  inbox.signedActionJustified, inbox.liveCaptureExecuted, inbox.resultPromoted, inbox.approvalConsumed,
  inbox.retryAuthorized, inbox.postCaptureNetworkReads],
  ["capture-incomplete-two-family-threshold-not-met-retry-not-authorized",
    closeout.classification, 0, 0, false, true, false, true, false, 0], "inbox closeout state");
const handoff = text("coordination/handoffs/2026-07-30-critical-stakewise-v3-step2-preflight.md");
check(handoff.includes("CAPTURE_INCOMPLETE/TWO_FAMILY_PIN_THRESHOLD_NOT_MET") && handoff.includes("23 sanitized reads") &&
  handoff.includes("No automatic retry") && handoff.includes("70a3a4a278e2c44c"), "handoff closeout state");

for (const value of boundArtifacts) check(fs.existsSync(rel(value)), `bound source exists ${value}`);
const manifest = json(MANIFEST);
runnerModule.validatePackageManifest(manifest);
check(true, "runner package validation passes");
const expectedRecords = manifestRecords();
equal(manifest.artifacts, expectedRecords, "manifest records exact");
equal(manifest.aggregateSha256,
  sha256(Buffer.from(expectedRecords.map((row) => `${row.path}:${row.sha256}`).sort().join("\n"), "utf8")),
  "manifest aggregate exact");
equal([manifest.status, manifest.artifactCount],
  ["CAPTURE_INCOMPLETE_TWO_FAMILY_PIN_THRESHOLD_NOT_MET_RETRY_NOT_AUTHORIZED", artifacts.length],
  "manifest status/count");
equal(json("reports/raw/fast/critical-stakewise-v3-eth-exitqueue-step1-manifest.json").aggregateSha256,
  "6b4b08afd330f5d7f94465bf79c66d09070c361c23d2a71403ea877d3fdf7050", "Step1 immutable aggregate");

check(fs.existsSync(rel(runnerModule.FIXED_OUTPUT_REL)), "exact consumed capture present");
check(fs.existsSync(rel(runnerModule.GLOBAL_LEDGER_REL)), "global consumption ledger present");
const jsonArtifacts = artifacts.filter((value) => value.endsWith(".json"));
for (const value of jsonArtifacts) {
  JSON.parse(text(value));
  check(true, `valid JSON ${value}`);
}
for (const value of artifacts.filter((item) => !boundArtifacts.includes(item) && /\.(?:js|json|md|txt)$/u.test(item))) {
  const content = text(value);
  check(!/[ \t]+$/gmu.test(content), `no trailing whitespace ${value}`);
  check(content.length === 0 || content.endsWith("\n"), `final newline ${value}`);
}
for (const value of [`${PREFIX}-preflight.json`, `${PREFIX}-approval-proposal.json`, ...captureArtifacts,
  CAPTURE, CLOSEOUT, APPROVAL, LEDGER, "coordination/inbox/critical/stakewise-v3-eth-exitqueue-step2.json"]) {
  const content = text(value);
  check(!/(?:https?|wss?):\/\//iu.test(content), `${value} has no URL`);
  check(!/0x[0-9a-f]{40}(?![0-9a-f])/iu.test(content), `${value} has no address`);
  check(!/seed phrase|private key|authorization: bearer|x-api-key/iu.test(content), `${value} has no secret marker`);
  check(!/"(?:endpointUrl|hostname|rawResponse|callerAddress|receiverAddress|positionTicket|transactionHash)"/iu.test(content),
    `${value} has no endpoint/caller/address/raw-response field`);
}

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  checks,
  offlineFixtureChecks: testResult.checks,
  fixtureClasses: testResult.fixtureClasses,
  artifactCount: artifacts.length,
  aggregateSha256: manifest.aggregateSha256,
  classification: closeout.classification,
  approvalConsumed: true,
  retryAuthorized: false,
  postCaptureNetworkReads: 0,
  postCaptureInventoryReads: 0,
  liveCaptureExecuted: true,
  resultPromoted: false,
  routePositive: 0,
  executableNow: 0,
  signedActionJustified: false,
  fork: false
}, null, 2)}\n`);
