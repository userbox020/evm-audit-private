#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CLAIM = "critical/valantis-stex-p1-production-applicability";
const STEM = "critical-valantis-stex-p1-production-applicability";
const PATHS = Object.freeze({
  diagnostic: `reports/raw/fast/${STEM}-diagnostic.json`,
  ledger: `reports/raw/fast/${STEM}-consumption-ledger.json`,
  lock: `reports/raw/fast/${STEM}-capture.lock`,
  decision: `coordination/decisions/${STEM}-approval.json`,
  pass: `reports/raw/fast/${STEM}-pass.json`
});
const EXPECTED = Object.freeze({
  diagnostic: { bytes: 1261, sha256: "67d11660e5dd68646ff256e0e7084e0e62b14aad2b633d1145228daa90351643" },
  ledger: { bytes: 398, sha256: "ee2b56b6088cc39dd1d79d2aa8a3eb6eaa7e414bb811e7ef52ef05233a900898" },
  lock: { bytes: 398, sha256: "ee2b56b6088cc39dd1d79d2aa8a3eb6eaa7e414bb811e7ef52ef05233a900898" },
  decision: { bytes: 1960, sha256: "000faae022b21f111c43286f053257f7b99511293c9fbac0f874baf68113140c" },
  executionId: "p1-7dc8c8ce09864bebaff42d740ce43d4b"
});
const DISPOSITION = "CAPTURE_EXECUTED / AUTHORIZATION_CONSUMED / CAPTURE_INCOMPLETE / PIN: GROUP_UNQUALIFIED";
let checks = 0;
function check(value, message) { checks += 1; assert.ok(value, `check ${checks}: ${message}`); }
function equal(actual, expected, message) { checks += 1; assert.deepStrictEqual(actual, expected, `check ${checks}: ${message}`); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys, label) { check(plain(value), `${label} object`); equal(Object.keys(value).sort(), [...keys].sort(), `${label} exact keys`); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function rel(value) { return path.join(ROOT, ...value.split("/")); }
function parse(bytes, label) { try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label}_INVALID_JSON`); } }
function uint(value, label) { check(Number.isSafeInteger(value) && value >= 0, `${label} uint`); }
function bool(value, label) { check(typeof value === "boolean", `${label} bool`); }
function text(value, label) { check(typeof value === "string" && value.length > 0, `${label} string`); }

function scanNoProviderMaterial(value) {
  const serialized = JSON.stringify(value);
  check(!/(?:https?|wss?):\/\//iu.test(serialized), "no URL material");
  check(!/(?:endpoint|hostname|providerUrl|rawResponse|authorizationHeader|rpcUrl)"\s*:/iu.test(serialized), "no provider/raw keys");
  check(!/(?:api[_-]?key|bearer\s+|basic\s+)/iu.test(serialized), "no credential-like material");
}

function validateMarker(marker) {
  exactKeys(marker, ["claimId", "decisionSha256", "executionId", "fileFlushes", "inventoryFilesOpened", "networkCalls",
    "parentDirectoryFsync", "schemaVersion", "status"], "marker");
  equal(marker.schemaVersion, 1, "marker schema"); equal(marker.claimId, CLAIM, "marker claim");
  equal(marker.decisionSha256, EXPECTED.decision.sha256, "marker decision hash");
  equal(marker.executionId, EXPECTED.executionId, "marker execution");
  equal(marker.status, "AUTHORIZATION_CONSERVATIVELY_CONSUMED_BEFORE_PROTECTED_ACCESS", "marker status");
  equal(marker.parentDirectoryFsync, "UNVERIFIED_NOT_CLAIMED", "marker parent-fsync honesty");
  equal(marker.fileFlushes, 2, "marker file flushes"); equal(marker.inventoryFilesOpened, 0, "marker pre-access inventory zero");
  equal(marker.networkCalls, 0, "marker pre-access network zero");
}

function validateDecision(decision) {
  exactKeys(decision, ["schemaVersion", "claimId", "status", "reviewerVerdict", "currentTurnAuthorization", "scope",
    "decidedAtUtc", "expiresAtUtc", "executionId", "command", "runnerSha256", "testsSha256", "validatorSha256",
    "authoritySha256", "publicEvidenceSha256", "reviewPackageSha256", "packageDigest", "trustedOrchestrationBoundary"], "decision");
  equal([decision.schemaVersion, decision.claimId, decision.status, decision.reviewerVerdict],
    [1, CLAIM, "COORDINATOR_ONE_RUN_DECISION", "APPROVE_UNCHANGED_FOR_ONE_RUN"], "decision identity");
  equal(decision.executionId, EXPECTED.executionId, "decision execution");
  equal(decision.command, `node tools/capture-${STEM}.js --capture-once`, "decision command");
  exactKeys(decision.scope, ["mode", "inventoryPaths", "captureCount", "networkReadOnly", "transactionsAuthorized",
    "signingAuthorized", "forkAuthorized", "deploymentAuthorized", "productionMutationAuthorized", "retryAuthorized",
    "replacementAuthorized"], "decision scope");
  equal([decision.scope.captureCount, decision.scope.networkReadOnly, decision.scope.transactionsAuthorized,
    decision.scope.signingAuthorized, decision.scope.forkAuthorized, decision.scope.deploymentAuthorized,
    decision.scope.productionMutationAuthorized, decision.scope.retryAuthorized, decision.scope.replacementAuthorized],
  [1, true, false, false, false, false, false, false, false], "decision read-only one-run scope");
}

function validateDiagnostic(diagnostic) {
  exactKeys(diagnostic, ["capturedAtUtc", "claimId", "counters", "economics", "executionId", "gates",
    "groupQualification", "history", "interfaces", "liabilities", "outcome", "pin", "runtimeBinding", "safety",
    "schemaVersion", "topology"], "diagnostic");
  equal([diagnostic.schemaVersion, diagnostic.claimId, diagnostic.outcome, diagnostic.executionId],
    [2, CLAIM, "CAPTURE_INCOMPLETE", EXPECTED.executionId], "diagnostic identity/outcome");
  text(diagnostic.capturedAtUtc, "capturedAtUtc"); check(Number.isFinite(Date.parse(diagnostic.capturedAtUtc)), "capturedAtUtc parseable");

  exactKeys(diagnostic.counters, ["authorizationConsumed", "automaticRetries", "decodedBytes", "durability", "httpAttempts",
    "inventoryFilesOpened", "logicalRpcCalls", "networkCalls"], "counters");
  equal([diagnostic.counters.inventoryFilesOpened, diagnostic.counters.logicalRpcCalls, diagnostic.counters.httpAttempts,
    diagnostic.counters.networkCalls, diagnostic.counters.automaticRetries, diagnostic.counters.authorizationConsumed,
    diagnostic.counters.decodedBytes], [2, 4, 4, 12, 0, true, 0], "terminal counters");
  exactKeys(diagnostic.counters.durability, ["fileFlushes", "parentDirectoryFsync"], "durability counters");
  equal(diagnostic.counters.durability, { fileFlushes: 2, parentDirectoryFsync: false }, "runtime durability observation");

  exactKeys(diagnostic.groupQualification, ["backendIndependenceClaimed", "basis", "groupAQualified", "groupBQualified",
    "identicalCanonicalAgreement"], "group qualification");
  equal(diagnostic.groupQualification, { backendIndependenceClaimed: false,
    basis: "two protected inventory groups, backend independence unproven", groupAQualified: 0, groupBQualified: 0,
    identicalCanonicalAgreement: false }, "bounded group result");

  equal(diagnostic.pin, null, "no pin"); equal(diagnostic.topology, null, "no topology");
  equal(diagnostic.runtimeBinding, { complete: false }, "no runtime binding facts");
  equal(diagnostic.interfaces, { complete: false }, "no interface facts");
  equal(diagnostic.history, { code: "GROUP_UNQUALIFIED", complete: false, stage: "PIN" }, "terminal stage/code only");
  equal(diagnostic.liabilities, { complete: false, zeroState: false }, "no liability/zero-state facts");
  equal(diagnostic.economics, { positiveAccountingGap: false, routeOrProfitInferred: false, rows: [],
    status: "UNKNOWN_FORMULAS_UNBOUND" }, "no economics facts");
  equal(diagnostic.gates, { executableNow: "UNKNOWN", fork: false, routePositive: "UNKNOWN",
    signedActionJustified: false }, "unknown/false gates");

  exactKeys(diagnostic.safety, ["broadcast", "deployment", "fork", "productionMutation", "providerMaterialPersisted",
    "rawResponsesPersisted", "signing", "transactions"], "safety");
  equal(diagnostic.safety, { broadcast: false, deployment: false, fork: false, productionMutation: false,
    providerMaterialPersisted: false, rawResponsesPersisted: false, signing: false, transactions: 0 }, "terminal safety");
  scanNoProviderMaterial(diagnostic);
}

function validate(options = {}) {
  checks = 0; const read = options.read || ((value) => fs.readFileSync(rel(value)));
  const exists = options.exists || ((value) => fs.existsSync(rel(value)));
  const bytes = { diagnostic: read(PATHS.diagnostic), ledger: read(PATHS.ledger), lock: read(PATHS.lock), decision: read(PATHS.decision) };
  for (const name of Object.keys(bytes)) {
    check(Buffer.isBuffer(bytes[name]), `${name} bytes`); equal(bytes[name].length, EXPECTED[name].bytes, `${name} byte length`);
    equal(sha256(bytes[name]), EXPECTED[name].sha256, `${name} immutable hash`);
  }
  equal(bytes.ledger, bytes.lock, "ledger and lock exact bytes");
  const decision = parse(bytes.decision, "DECISION"); const ledger = parse(bytes.ledger, "LEDGER");
  const lock = parse(bytes.lock, "LOCK"); const diagnostic = parse(bytes.diagnostic, "DIAGNOSTIC");
  validateDecision(decision); validateMarker(ledger); validateMarker(lock); validateDiagnostic(diagnostic);
  equal([decision.executionId, ledger.executionId, lock.executionId, diagnostic.executionId],
    Array(4).fill(EXPECTED.executionId), "all execution IDs agree");
  equal([ledger.decisionSha256, lock.decisionSha256], Array(2).fill(EXPECTED.decision.sha256), "decision-marker hash binding");
  check(!exists(PATHS.pass), "forbidden pass output absent");
  return { status: "PASS", disposition: DISPOSITION, checks, diagnosticBytes: EXPECTED.diagnostic.bytes,
    diagnosticSha256: EXPECTED.diagnostic.sha256, markerBytes: EXPECTED.ledger.bytes,
    markerSha256: EXPECTED.ledger.sha256, decisionSha256: EXPECTED.decision.sha256,
    executionId: EXPECTED.executionId, inventoryFilesOpened: 2, logicalRpcCalls: 4, httpAttempts: 4,
    networkCalls: 12, automaticRetries: 0, groupAQualified: 0, groupBQualified: 0,
    protectedInventoryReadsDuringVerification: 0, networkCallsDuringVerification: 0, captureExecutedDuringVerification: false };
}

module.exports = { CLAIM, DISPOSITION, EXPECTED, PATHS, exactKeys, scanNoProviderMaterial, sha256,
  validate, validateDecision, validateDiagnostic, validateMarker };
if (require.main === module) {
  try { if (process.argv.length !== 2) throw new Error("NO_ARGUMENTS_ALLOWED"); process.stdout.write(`${JSON.stringify(validate())}\n`); }
  catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
}
