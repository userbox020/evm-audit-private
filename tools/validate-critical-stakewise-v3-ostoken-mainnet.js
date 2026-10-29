#!/usr/bin/env node
"use strict";

const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const runner = require("./critical-stakewise-v3-ostoken-mainnet-runner.js");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "stakewise-v3-core-v5.0.1");
const PREFIX = "critical-stakewise-v3-ostoken-mainnet";
const rel = (value) => path.join(ROOT, ...value.split("/"));
const read = (value) => fs.readFileSync(rel(value));
const text = (value) => read(value).toString("utf8");
const json = (value) => JSON.parse(text(value));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
let checks = 0;

function check(value, message) {
  checks += 1;
  if (!value) throw new Error(`check ${checks} failed: ${message}`);
}

function equal(actual, expected, message) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`);
}

check(process.argv.length === 2, "validator accepts no arguments and performs no writes");
equal(cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: TARGET, encoding: "utf8" }).trim(),
  "fc70cbe1b3d41bc5f78434830d837aa270ca33bc", "target commit bound");
equal(cp.execFileSync("git", ["describe", "--tags", "--exact-match"], { cwd: TARGET, encoding: "utf8" }).trim(),
  "v5.0.1", "target tag bound");

const scripts = [
  `tools/${PREFIX}-runner.js`,
  `tools/test-${PREFIX}.js`,
  `tools/validate-${PREFIX}.js`
];
for (const script of scripts) {
  equal(cp.spawnSync(process.execPath, ["--check", rel(script)], { cwd: ROOT, env: {} }).status, 0, `${script} syntax`);
}

const forbiddenArtifacts = [runner.FIXED_APPROVAL_REL, runner.GLOBAL_LEDGER_REL, runner.FIXED_OUTPUT_REL];
const absenceBefore = forbiddenArtifacts.map((value) => fs.existsSync(rel(value)));
equal(absenceBefore, [false, false, false], "no approval ledger or network capture exists");

const checkOnly = cp.spawnSync(process.execPath, [rel(`tools/${PREFIX}-runner.js`), "--check-only"], {
  cwd: ROOT,
  encoding: "utf8",
  env: {},
  maxBuffer: 16 * 1024 * 1024
});
equal([checkOnly.status, checkOnly.stderr], [0, ""], "check-only passes offline");
const generatedPreflight = JSON.parse(checkOnly.stdout);
const preflight = json(`reports/raw/fast/${PREFIX}-preflight.json`);
equal(generatedPreflight, preflight, "checked-in preflight equals check-only output");
equal([preflight.networkReads, preflight.inventoryReads, preflight.writes], [0, 0, 0], "check-only declares zero side effects");
equal([preflight.authorization.proposalState, preflight.authorization.proposalAuthorization,
  preflight.authorization.authorized, preflight.authorization.captureExecuted],
["REVIEW_REQUESTED", "NOT_AUTHORIZED", false, false], "preflight remains unauthorized and unexecuted");
equal(preflight.methods.allowed, ["eth_call", "eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getLogs"],
  "exact RPC allowlist");
for (const method of ["eth_getStorageAt", "debug_traceCall", "trace_call", "eth_sendRawTransaction", "eth_sendTransaction"]) {
  check(preflight.methods.forbidden.includes(method), `${method} forbidden`);
}
equal(Object.values(preflight.gates).slice(0, 6), [null, null, null, null, null, null], "preflight exposure gates fail closed");

const tests = cp.spawnSync(process.execPath, [rel(`tools/test-${PREFIX}.js`)], {
  cwd: ROOT,
  encoding: "utf8",
  env: {},
  maxBuffer: 16 * 1024 * 1024
});
equal([tests.status, tests.stderr], [0, ""], "offline fixture tests pass");
const testResult = JSON.parse(tests.stdout);
equal([testResult.status, testResult.networkReads, testResult.inventoryReads, testResult.liveCaptureExecuted,
  testResult.approvalCreated], ["PASS", 0, 0, false, false], "tests are offline and create no approval");
equal(testResult.fixtureClasses, 48, "all bounded fixture classes executed");

const sourceManifest = json(runner.SOURCE_MANIFEST_REL);
runner.validateSourceManifest(sourceManifest);
check(true, "local recursive source closure manifest valid");
const local = runner.loadLocalBindings();
equal([sourceManifest.sourceClosureFileCount, sourceManifest.packageSourceBinding],
  [local.sourceRecords.length, local.packageSourceBinding], "source closure count and binding exact");
check(local.sourceRecords.some((row) => row.path.endsWith("deployments/mainnet.json")), "mainnet deployment seeds bound");
for (const seed of runner.SOURCE_SEEDS) {
  check(local.sourceRecords.some((row) => row.path.endsWith(seed)), `source seed bound ${seed}`);
}

const manifestBytes = read(runner.MANIFEST_REL);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
runner.validatePackageManifest(manifest);
check(true, "package manifest validates exact local package artifacts");

const proposal = json(runner.PROPOSAL_REL);
runner.validateProposal(proposal);
check(true, "proposal exact-key schema and metadata policy validate");
equal([proposal.schemaVersion, proposal.state, proposal.authorization, proposal.captureExecuted],
  [1, "REVIEW_REQUESTED", "NOT_AUTHORIZED", false], "proposal is fresh and not an approval");
equal(proposal.proposalCommitment, runner.bytes32Commitment(proposal.proposalPayload), "proposal commitment exact");
equal(proposal.proposalPayload.findingId, runner.FINDING_ID, "proposal finding bound");
equal(proposal.proposalPayload.runnerSha256, `0x${sha256(read(`tools/${PREFIX}-runner.js`))}`, "proposal runner hash bound");
equal(proposal.proposalPayload.packageManifestSha256, `0x${sha256(manifestBytes)}`, "proposal manifest hash bound");
equal(proposal.proposalPayload.packageAggregateSha256, `0x${manifest.aggregateSha256}`, "proposal aggregate bound");
equal(proposal.proposalPayload.packageSourceBinding, local.packageSourceBinding, "proposal source closure bound");
equal(proposal.proposalPayload.capsCommitment, runner.bytes32Commitment(runner.CAPS), "proposal caps bound");
equal(proposal.proposalPayload.allowedMethods, [...runner.ALLOWED_METHODS].sort(), "proposal methods bound");
equal([proposal.proposalPayload.fixedApprovalPath, proposal.proposalPayload.fixedOutputPath,
  proposal.proposalPayload.globalConsumptionLedger],
[runner.FIXED_APPROVAL_REL, runner.FIXED_OUTPUT_REL, runner.GLOBAL_LEDGER_REL], "proposal fixed paths bound");
equal([proposal.reviewerIssuedApprovalRequirements.issuedAt, proposal.reviewerIssuedApprovalRequirements.expiresAt,
  proposal.reviewerIssuedApprovalRequirements.approvalCommitment,
  proposal.reviewerIssuedApprovalRequirements.reviewMaterialManifestSha256], [null, null, null, null],
"reviewer approval remains unissued");

const reviewManifestBytes = read(runner.REVIEW_MANIFEST_REL);
const reviewManifest = JSON.parse(reviewManifestBytes.toString("utf8"));
runner.validateReviewManifest(reviewManifest);
check(true, "detached review-material manifest binds complete proposal and reviewed artifacts");
check(reviewManifest.artifacts.some((row) => row.path === runner.PROPOSAL_REL && row.sha256 === sha256(read(runner.PROPOSAL_REL))),
  "review manifest binds complete proposal file hash");

const baseConditions = { finalityComplete: true, historyComplete: true, stateAgreement: true, registryAgreement: true,
  exactLineage: null, supplyReconciled: true };
const usefulFacts = { vaultLineage: { usefulPartialLineage: true, partialLineageCompleteCount: 1 },
  discovery: { dualFamilyMembershipAgreement: true } };
const partialResult = runner.buildCaptureResult(baseConditions, new runner.Budget().summary(), usefulFacts);
equal([partialResult.status, partialResult.resultPromoted, partialResult.promotionGates.aggregateEconomicExposure],
  ["PARTIAL_USEFUL_LINEAGE_CAPTURED_EXPOSURE_AND_ECONOMIC_GATES_NULL", false, null], "partial lineage behavior fail-closes exposure");
const completeResult = runner.buildCaptureResult({ ...baseConditions, exactLineage: true }, new runner.Budget().summary(), usefulFacts);
equal([completeResult.status, completeResult.resultPromoted], ["COMPLETE_READ_ONLY_LINEAGE_AND_HISTORY_CAPTURED", true],
  "exact lineage complete behavior is reachable");
const badHistoryResult = runner.buildCaptureResult({ ...baseConditions, historyComplete: false }, new runner.Budget().summary(), usefulFacts);
equal([badHistoryResult.reasonCode, badHistoryResult.promotionGates.historyComplete], ["HISTORY_INCOMPLETE_OR_MISMATCH", null],
  "incomplete history behavior fail-closes");
equal(runner.reconcileGlobalSupply(10n, 7n, { complete: true, shares: new Map([["aux", 3n]]) }, true).reconciled, true,
  "all-controller supply reconciliation behavior");
equal(runner.reconcileGlobalSupply(10n, 10n, { complete: false, shares: new Map() }, false).reconciled, null,
  "incomplete controller set blocks global reconciliation");
check(preflight.providerPolicy.backendIndependenceProven === false, "hostname diversity does not claim backend independence");
equal(runner.buildCaptureResult(baseConditions, new runner.Budget().summary(), {
  vaultLineage: { usefulPartialLineage: false, partialLineageCompleteCount: 0 },
  discovery: { dualFamilyMembershipAgreement: true }
}).reasonCode, "USEFUL_PARTIAL_LINEAGE_NOT_ESTABLISHED", "empty lineage cannot receive positive partial wording");
check(runner.protocolObservationsExactlyMatch({ raw: { totalSupply: 1n } }, { raw: { totalSupply: 2n } }) === false,
  "exact protocol numeric mismatch is behavioral");
equal(runner.reconcileDualFamilySupply([{ raw: { totalSupply: 3n, totalShares: 1n } },
  { raw: { totalSupply: 3n, totalShares: 1n } }], [{ complete: true, shares: new Map([["aux", 2n]]) },
  { complete: true, shares: new Map([["aux", 3n]]) }], true).reconciled, null,
"auxiliary-controller family mismatch blocks reconciliation");

const fixture = json(`tools/fixtures/${PREFIX}-fixtures.json`);
for (const fixtureClass of ["approval-replay", "approval-expiry", "approval-path-binding", "approval-runner-hash-binding",
  "approval-manifest-hash-binding", "budget-total-exhaustion", "budget-response-exhaustion", "budget-time-exhaustion",
  "hostname-family-threshold", "finalized-number-mismatch", "finalized-hash-mismatch", "forbidden-storage-method",
  "forbidden-trace-method", "forbidden-send-method", "url-leak-guard", "hostname-leak-guard",
  "provider-identity-leak-guard", "provider-hash-leak-guard", "raw-response-leak-guard",
  "transaction-hash-leak-guard", "calldata-leak-guard", "arbitrary-address-leak-guard"] ) {
  check(fixture.fixtureClasses.includes(fixtureClass), `fixture class ${fixtureClass}`);
}

const report = text(runner.REVIEW_REPORT_REL);
for (const marker of ["REVIEW_REQUESTED / NOT_AUTHORIZED / NOT_EXECUTED", "two hostname-distinct families",
  "terminal same-number/hash recheck", "source-runtime equivalence", "trusted coordinator", "No network capture was executed"]) {
  check(report.includes(marker), `preflight report marker ${marker}`);
}

for (const value of [`reports/raw/fast/${PREFIX}-preflight.json`, runner.PROPOSAL_REL]) {
  const content = text(value);
  check(!/(?:https?|wss?):\/\//iu.test(content), `${value} contains no URL`);
  check(!/0x[0-9a-f]{40}(?![0-9a-f])/iu.test(content), `${value} contains no raw address`);
  check(!/"(?:hostname|providerIdentity|providerHash|rawResponse|transactionHash|txHash|calldata|userAddress)"/iu.test(content),
    `${value} contains no forbidden identity field`);
}
for (const value of [
  `tools/${PREFIX}-runner.js`,
  `tools/test-${PREFIX}.js`,
  `tools/validate-${PREFIX}.js`,
  `tools/fixtures/${PREFIX}-fixtures.json`,
  runner.REVIEW_REPORT_REL,
  `reports/raw/fast/${PREFIX}-preflight.json`,
  runner.PROPOSAL_REL,
  runner.SOURCE_MANIFEST_REL,
  runner.MANIFEST_REL,
  runner.REVIEW_MANIFEST_REL
]) {
  const content = text(value);
  check(!/[ \t]+$/gmu.test(content), `no trailing whitespace ${value}`);
  check(content.endsWith("\n"), `final newline ${value}`);
}

equal(forbiddenArtifacts.map((value) => fs.existsSync(rel(value))), absenceBefore,
  "validator/check-only/tests created no approval ledger or network capture");

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  checks,
  offlineFixtureChecks: testResult.checks,
  fixtureClasses: testResult.fixtureClasses,
  sourceClosureFiles: sourceManifest.sourceClosureFileCount,
  packageAggregateSha256: manifest.aggregateSha256,
  proposalStatus: `${proposal.state}/${proposal.authorization}`,
  networkReads: 0,
  inventoryReads: 0,
  liveCaptureExecuted: false,
  approvalCreated: false
}, null, 2)}\n`);
