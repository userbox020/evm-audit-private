#!/usr/bin/env node
"use strict";

const assert = require("assert");
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const R = require("./capture-critical-valantis-stex-p1-production-applicability.js");

const ROOT = path.resolve(__dirname, "..");
const REPORT = `reports/${R.CLAIM.replace("critical/", "critical-")}.md`;
const INBOX = "coordination/inbox/critical/20260809-critical-valantis-stex-p1-production-applicability.json";
const HANDOFF = "coordination/handoffs/20260809-critical-valantis-stex-p1-production-applicability.md";
const ABSENT = Object.freeze([R.PATHS.decision, R.PATHS.pass, R.PATHS.diagnostic, R.PATHS.lock, R.PATHS.ledger]);
const COMPONENTS = Object.freeze([R.PATHS.runner, R.PATHS.tests, R.PATHS.validator, R.PATHS.authority,
  R.PATHS.publicEvidence, R.PATHS.reviewPackage, R.PATHS.sourceManifest, R.PATHS.preAccessLaunchDiagnostic,
  R.PATHS.archivedTerminalDecision]);
const rel = (value) => path.join(ROOT, ...value.split("/"));
const read = (value) => fs.readFileSync(rel(value));
const json = (value) => JSON.parse(read(value).toString("utf8"));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
let checks = 0;
function check(value, message) { checks += 1; assert.ok(value, `check ${checks}: ${message}`); }
function equal(actual, expected, message) { checks += 1; assert.deepStrictEqual(actual, expected, `check ${checks}: ${message}`); }
function exactKeys(value, keys, label) { check(value && typeof value === "object" && !Array.isArray(value), `${label} object`); equal(Object.keys(value).sort(), [...keys].sort(), `${label} exact keys`); }

function validate() {
  checks = 0;
  equal(sha256(read(R.PATHS.authority)), R.AUTHORITY_SHA256, "authority hash");
  equal(sha256(read(R.PATHS.publicEvidence)), R.PUBLIC_EVIDENCE_SHA256, "public evidence hash");
  equal(sha256(read(R.PATHS.sourceManifest)), R.SOURCE_MANIFEST_SHA256, "frozen source-manifest hash");
  const authority = json(R.PATHS.authority); const evidence = json(R.PATHS.publicEvidence);
  equal(authority.historicalSource.sourceManifestPath, R.PATHS.sourceManifest, "source-manifest path authority");
  equal(authority.coordinatorDecisionRequired.reviewerVerdict, "APPROVE_UNCHANGED_FOR_ONE_RUN", "reviewer verdict authority");
  equal([authority.coordinatorDecisionRequired.cryptographicHumanAuthenticationClaimed,
    authority.coordinatorDecisionRequired.localFileTamperResistanceClaimed], [false, false], "honest orchestration limitation");
  equal(evidence.allowedRpc, R.ALLOWED_RPC, "RPC allowlist"); equal(evidence.permittedOutcomes, R.OUTCOMES, "outcomes");
  check(Object.values(evidence.knownRuntimeVersions).filter(Array.isArray).every((rows) => rows.length === 0), "all current runtime lists empty");
  equal([evidence.historyBounds.deploymentStartBlock, evidence.historyBounds.productionManagerEventTopics], [null, null], "history remains unbound");
  for (const row of Object.values(evidence.priorEvidence)) equal(sha256(read(row.path)), row.sha256, `${row.path} immutable prior lineage`);

  const review = json(R.PATHS.reviewPackage); exactKeys(review, R.REVIEW_KEYS, "review package");
  equal([review.claimId, review.status], [R.CLAIM, "AWAITING_FRESH_AUTHORIZATION_AND_REVIEW_NOT_EXECUTED"], "review status");
  R.validateReviewPackage(review); equal(review.files.map((row) => row.path), COMPONENTS.filter((value) => value !== R.PATHS.reviewPackage), "reviewed files");
  equal(review.authorization, { decisionPath: R.PATHS.decision, freshDecisionPresent: false, decisionReadDuringPreparation: false,
    priorExecutionId: "p1-f71f64c3d0db44d3bebc4e1adb648cf1",
    priorDisposition: "PRE_ACCESS_PORTABILITY_FAILURE_NOT_CONSUMED_BY_MARKER_BUT_NO_RETRY", priorDecisionReusable: false,
    captureExecuted: false, authorizationConsumed: false, inventoryFilesOpened: 0, retryAuthorized: false,
    replacementAuthorized: false, runnerCreatesDecision: false }, "authorization preparation state");
  equal(review.outputPolicy.conservativeConsumptionStatus, "AUTHORIZATION_CONSERVATIVELY_CONSUMED_BEFORE_PROTECTED_ACCESS", "consumption status");
  equal(review.outputPolicy.groupWording, "two protected inventory groups, backend independence unproven", "group wording");
  equal([review.outputPolicy.windows.parentDirectoryFsync, review.outputPolicy.windows.fileFlushes,
    review.outputPolicy.windows.independentMarkerFiles], [false, 2, true], "Windows durability policy");
  equal(review.outputPolicy.persistedMarkerParentDirectoryFsync, "UNVERIFIED_NOT_CLAIMED", "persisted marker makes no parent-fsync claim");

  const launchDiagnostic = json(R.PATHS.preAccessLaunchDiagnostic); const archivedDecision = read(R.PATHS.archivedTerminalDecision);
  equal([launchDiagnostic.status, launchDiagnostic.code], ["PRE_ACCESS_PORTABILITY_FAILURE_NOT_CONSUMED_BY_MARKER_BUT_NO_RETRY",
    "PARENT_DIRECTORY_FSYNC_UNSUPPORTED_WINDOWS"], "historical launch disposition");
  equal(launchDiagnostic.decision.sha256, sha256(archivedDecision), "archived decision binding");
  equal([launchDiagnostic.counters.markerFilesCreated, launchDiagnostic.counters.inventoryFilesOpened,
    launchDiagnostic.counters.networkCalls, launchDiagnostic.counters.outputsCreated], [0, 0, 0, 0], "historical launch zero access");

  const packageManifest = json(R.PATHS.packageManifest); R.validatePackageManifest(packageManifest);
  equal(packageManifest.components.map((row) => row.path), COMPONENTS, "canonical component order");
  const digestInput = { schemaVersion: packageManifest.schemaVersion, claimId: packageManifest.claimId, components: packageManifest.components };
  equal(packageManifest.packageDigest, sha256(Buffer.from(R.stable(digestInput))), "canonical package digest");
  const packageManifestSha256 = sha256(read(R.PATHS.packageManifest));
  for (const row of packageManifest.components) equal([read(row.path).length, sha256(read(row.path))], [row.bytes, row.sha256], `${row.path} package claim`);

  const source = read(R.PATHS.runner).toString("utf8");
  const capKeys = Object.keys(evidence.caps); for (const key of capKeys) check(source.includes(`.${key}`), `declared cap ${key} used`);
  check(!/options\.approval|options\.review|reviewApproval/u.test(source), "no approval injection");
  check(source.includes("https.request") && source.includes("lookup") && source.includes("servername"), "pinned HTTPS transport");
  check(source.includes("AUTHORIZATION_CONSERVATIVELY_CONSUMED_BEFORE_PROTECTED_ACCESS"), "pre-access consumption marker");
  check(!source.includes("linkSync") && !source.includes("SameInode"), "no hardlink durability dependency");
  check(source.includes("fileFlushes: 2") && source.includes("parentDirectoryFsync"), "dual-file portability policy");
  check(source.includes('parentDirectoryFsync: "UNVERIFIED_NOT_CLAIMED"'), "marker parent-fsync state is always unverified");

  for (const output of ABSENT) check(!fs.existsSync(rel(output)), `${output} absent`);
  const syntax = cp.spawnSync(process.execPath, ["--check", rel(R.PATHS.runner)], { encoding: "utf8", env: {} }); equal([syntax.status, syntax.stdout, syntax.stderr], [0, "", ""], "runner syntax");
  const testSyntax = cp.spawnSync(process.execPath, ["--check", rel(R.PATHS.tests)], { encoding: "utf8", env: {} }); equal([testSyntax.status, testSyntax.stdout, testSyntax.stderr], [0, "", ""], "test syntax");
  const tests = cp.spawnSync(process.execPath, [rel(R.PATHS.tests)], { encoding: "utf8", env: {} }); equal([tests.status, tests.stderr], [0, ""], "offline test exit");
  const testResult = JSON.parse(tests.stdout); equal(testResult, review.validation.testResult, "test result bound in review");
  const checkOnly = R.checkOnly(); equal([checkOnly.decisionRead, checkOnly.captureExecuted, checkOnly.inventoryReads, checkOnly.networkCalls], [false, false, 0, 0], "check-only does not read decision or protected state");

  const report = read(REPORT).toString("utf8"); const handoff = read(HANDOFF).toString("utf8"); const inbox = json(INBOX);
  for (const text of [report, handoff, JSON.stringify(inbox)]) { check(text.includes(packageManifest.packageDigest), "artifact package digest claim"); check(text.includes(packageManifestSha256), "artifact package-manifest hash claim"); check(text.includes("AWAITING_FRESH_AUTHORIZATION_AND_REVIEW_NOT_EXECUTED"), "artifact review status"); check(text.includes("PRE_ACCESS_PORTABILITY_FAILURE_NOT_CONSUMED_BY_MARKER_BUT_NO_RETRY"), "artifact prior terminal status"); }
  equal(inbox.package.packageDigest, packageManifest.packageDigest, "inbox canonical digest");
  equal(inbox.package.packageManifestSha256, packageManifestSha256, "inbox sidecar hash");
  equal(inbox.verification, { tests: testResult.tests, assertions: testResult.assertions, validatorChecks: "SELF",
    protectedInventoryReads: 0, networkCalls: 0, captureExecuted: false }, "inbox verification claims");

  return { status: "PASS", claimId: R.CLAIM, reviewStatus: review.status, packageDigest: packageManifest.packageDigest,
    packageManifestSha256, checks, tests: testResult.tests, assertions: testResult.assertions, protectedInventoryReads: 0,
    networkCalls: 0, captureExecuted: false, authorizationConsumed: false, decisionPresent: false, transactions: 0,
    signing: false, fork: false };
}

module.exports = { ABSENT, COMPONENTS, exactKeys, validate };
if (require.main === module) {
  try { if (process.argv.length !== 2) throw new Error("NO_ARGUMENTS_ALLOWED"); process.stdout.write(`${JSON.stringify(validate())}\n`); }
  catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
}
