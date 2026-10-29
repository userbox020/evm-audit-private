#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CLAIM = "critical/yearn-v3-withdrawal-queue-effective-liquidity-step3";
const EXECUTION_ID = "yv3q-step3-912826169a7f45feb164f773219ca242";
const FINAL_DISPOSITION = "CAPTURE_FAILED / AUTHORIZATION_PERMANENTLY_CONSUMED / PIN: TWO_DISTINCT_FINALIZED_PROVIDERS_UNAVAILABLE / NO_RETRY";
const HASHES = Object.freeze({
  diagnostic: "5e43badfd5e3f883c990a875867d3c4eae0e78fac574c8a66b5e21b9b1a5504f",
  marker: "05be9611a5cb7cd7ac5b293c17e5a091f28939afc81c9a24be47485fa0068f34",
  decision: "40801a6122795d6cf828ea7c33f2fb16510a867c65af5089d6dafcc24945653b"
});
const PATHS = Object.freeze({
  diagnostic: "reports/raw/fast/critical-yearn-v3-withdrawal-queue-effective-liquidity-step3-diagnostic.json",
  ledger: "reports/raw/fast/critical-yearn-v3-withdrawal-queue-effective-liquidity-step3-consumption-ledger.json",
  lock: "reports/raw/fast/critical-yearn-v3-withdrawal-queue-effective-liquidity-step3-capture.lock",
  decision: "coordination/decisions/critical-yearn-v3-withdrawal-queue-effective-liquidity-step3-approval.json",
  pass: "reports/raw/fast/critical-yearn-v3-withdrawal-queue-effective-liquidity-step3-pass.json",
  report: "reports/critical-yearn-v3-withdrawal-queue-effective-liquidity-step3.md",
  inbox: "coordination/inbox/critical/critical-yearn-v3-withdrawal-queue-effective-liquidity-step3.json",
  handoff: "coordination/handoffs/20260810-critical-yearn-v3-withdrawal-queue-effective-liquidity-step3.md"
});
const DECISION_HASH_BINDINGS = Object.freeze({
  runnerSha256: "083be2a450f933dcc0e18a97f1b9893ad7e8526d46b8dc94aa83589abc181303",
  testsSha256: "db5ccd9e5a1d395701442ba28e445223c79f6378a0b72c1c49f936ce0a15fa74",
  validatorSha256: "62bf05954b4b9485d27d913526ead72fdb00398dba4fa719d52edbbaf2422f0e",
  localAuthoritySha256: "a3bafee28a745b9c97972732c6b17e0e288f65d73339b1e7ac8fbefaffb9203a",
  publicEvidenceSha256: "388dac3348ba56c470fbf2d586369c7f44b564648db39924c969f3a4d9a0a53d",
  reviewPackageSha256: "7320e8bf6860b4e21a6f40ec44130659c92d87c7bd474dcb4e883b87628ed419",
  packageManifestSha256: "f96df329b863869a94566563a0edf38c6ee83ae146b316a52a310209ea2b5e61",
  packageDigest: "432a5438dc6a37744542b31eb9cc8d64ff1765e6cd0085a39e58597f4a85ead0"
});

class ResultError extends Error { constructor(code) { super(code); this.name = "ResultError"; this.code = code; } }
function fail(code) { throw new ResultError(code); }
function rel(value) { return path.join(ROOT, ...value.split("/")); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function stable(value) { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function exactKeys(value, keys, code) { if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${code}_OBJECT`); if (stable(Object.keys(value).sort()) !== stable([...keys].sort())) fail(`${code}_KEYS`); return value; }
function parseJson(bytes, code) { try { return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes); } catch { fail(`${code}_JSON`); } }
function expect(value, expected, code) { if (stable(value) !== stable(expected)) fail(code); }
function expectType(value, type, code) { if (typeof value !== type) fail(code); }

function validateDiagnostic(value) {
  exactKeys(value, ["schemaVersion", "claimId", "status", "executionId", "error", "safety"], "DIAGNOSTIC");
  exactKeys(value.error, ["stage", "code"], "DIAGNOSTIC_ERROR");
  exactKeys(value.safety, ["retry", "replacement", "cleanup"], "DIAGNOSTIC_SAFETY");
  expectType(value.schemaVersion, "number", "DIAGNOSTIC_SCHEMA_TYPE");
  expectType(value.claimId, "string", "DIAGNOSTIC_CLAIM_TYPE");
  expectType(value.status, "string", "DIAGNOSTIC_STATUS_TYPE");
  expectType(value.executionId, "string", "DIAGNOSTIC_EXECUTION_TYPE");
  for (const key of ["retry", "replacement", "cleanup"]) expectType(value.safety[key], "boolean", `DIAGNOSTIC_${key.toUpperCase()}_TYPE`);
  expect([value.schemaVersion, value.claimId, value.status, value.executionId], [1, CLAIM, "CAPTURE_FAILED_AUTHORIZATION_PERMANENTLY_CONSUMED_NO_RETRY", EXECUTION_ID], "DIAGNOSTIC_IDENTITY");
  expect(value.error, { stage: "PIN", code: "TWO_DISTINCT_FINALIZED_PROVIDERS_UNAVAILABLE" }, "DIAGNOSTIC_TERMINAL_ERROR");
  expect(value.safety, { retry: false, replacement: false, cleanup: false }, "DIAGNOSTIC_PERMANENCE");
  const forbiddenFactKeys = new Set(["pin", "block", "state", "configuration", "config", "vault", "module", "queue", "strategy", "loss", "liquidity", "economics", "route", "routePositive", "executable", "profit", "networkCalls", "inventoryReads"]);
  function walk(row) { if (row && typeof row === "object") for (const [key, entry] of Object.entries(row)) { if (forbiddenFactKeys.has(key)) fail("DIAGNOSTIC_YEARN_OR_COUNTER_FACT_PUBLISHED"); walk(entry); } }
  walk(value);
  return value;
}

function validateMarker(value) {
  exactKeys(value, ["schemaVersion", "claimId", "executionId", "decisionSha256", "status", "markersRequired", "fileFlushesRequired", "parentDirectoryFsync", "retryReplacementCleanupAuthorized"], "MARKER");
  expectType(value.schemaVersion, "number", "MARKER_SCHEMA_TYPE");
  expectType(value.markersRequired, "number", "MARKER_COUNT_TYPE");
  expectType(value.fileFlushesRequired, "number", "MARKER_FLUSH_TYPE");
  expectType(value.retryReplacementCleanupAuthorized, "boolean", "MARKER_AUTH_TYPE");
  expect([value.schemaVersion, value.claimId, value.executionId, value.decisionSha256], [1, CLAIM, EXECUTION_ID, HASHES.decision], "MARKER_IDENTITY");
  expect([value.status, value.markersRequired, value.fileFlushesRequired, value.parentDirectoryFsync, value.retryReplacementCleanupAuthorized], ["AUTHORIZATION_CONSUMED_BEFORE_INVENTORY_OR_NETWORK", 2, 2, "UNVERIFIED_NOT_CLAIMED", false], "MARKER_PERMANENCE");
  return value;
}

function validateDecision(value) {
  const keys = ["schemaVersion", "claimId", "status", "reviewerVerdict", "currentTurnAuthorization", "scope", "decidedAtUtc", "expiresAtUtc", "executionId", "command", "runnerSha256", "testsSha256", "validatorSha256", "localAuthoritySha256", "publicEvidenceSha256", "reviewPackageSha256", "packageManifestSha256", "packageDigest", "trustedOrchestrationBoundary"];
  exactKeys(value, keys, "DECISION");
  exactKeys(value.scope, ["mode", "inventoryPath", "captureCount", "networkReadOnly", "transactionsAuthorized", "signingAuthorized", "forkAuthorized", "deploymentAuthorized", "simulationAuthorized", "holderScanAuthorized", "productionMutationAuthorized", "retryAuthorized", "replacementAuthorized", "cleanupAuthorized"], "DECISION_SCOPE");
  expectType(value.schemaVersion, "number", "DECISION_SCHEMA_TYPE"); expectType(value.scope.captureCount, "number", "DECISION_COUNT_TYPE"); expectType(value.scope.networkReadOnly, "boolean", "DECISION_READONLY_TYPE");
  expect([value.schemaVersion, value.claimId, value.status, value.reviewerVerdict, value.executionId], [1, CLAIM, "COORDINATOR_ONE_RUN_DECISION", "APPROVE_UNCHANGED_FOR_ONE_RUN", EXECUTION_ID], "DECISION_IDENTITY");
  expect([value.decidedAtUtc, value.expiresAtUtc], ["2026-08-10T20:47:32.0955511Z", "2026-08-10T21:17:32.0955511Z"], "DECISION_WINDOW");
  expect(value.currentTurnAuthorization, "Authorize exactly one bounded read-only Ethereum capture using exactly rpc_endpoints.txt after independent unchanged-package review; no capture retry, replacement, cleanup, transaction, signing, fork, deployment, simulation, holder scan, or production mutation.", "DECISION_AUTHORIZATION");
  expect(value.command, "node tools/capture-critical-yearn-v3-withdrawal-queue-effective-liquidity-step3.js --capture-once", "DECISION_COMMAND");
  expect(value.trustedOrchestrationBoundary, "Trusted external coordinator decision file and local filesystem; no cryptographic reviewer identity or backend/provider independence is claimed.", "DECISION_BOUNDARY");
  expect(value.scope, { mode: "ONE_READ_ONLY_CAPTURE", inventoryPath: "rpc_endpoints.txt", captureCount: 1, networkReadOnly: true, transactionsAuthorized: false, signingAuthorized: false, forkAuthorized: false, deploymentAuthorized: false, simulationAuthorized: false, holderScanAuthorized: false, productionMutationAuthorized: false, retryAuthorized: false, replacementAuthorized: false, cleanupAuthorized: false }, "DECISION_SCOPE_POLICY");
  for (const [key, expected] of Object.entries(DECISION_HASH_BINDINGS)) expect(value[key], expected, `DECISION_${key.toUpperCase()}`);
  return value;
}

function assertNoLeak(values) {
  for (const value of values) {
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : stable(value);
    if (/(?:https?|wss?):\/\//iu.test(text) || /"(?:endpointUrl|providerUrl|rawResponse|responseBody|authorizationHeader|headers|apiKey)"\s*:/iu.test(text)) fail("PROVIDER_OR_RAW_LEAK");
  }
  return true;
}

function validateCloseout(report, inbox, handoff) {
  expectType(report, "string", "REPORT_TYPE"); expectType(handoff, "string", "HANDOFF_TYPE");
  exactKeys(inbox, ["schemaVersion", "claimId", "status", "signal", "executionId", "result", "conclusions", "lineage", "discoveryContext", "nextAction"], "INBOX");
  exactKeys(inbox.result, ["capture", "authorization", "failureStage", "failureCode", "passOutputPresent", "accessCapabilityBlocked", "yearnNegativeEvidence", "providerHealthEvidence"], "INBOX_RESULT");
  exactKeys(inbox.conclusions, ["productionConfiguration", "withdrawLimitModule", "queue", "loss", "liquidity", "routePositive", "executable", "economics", "signedActionJustified", "fork", "findingClaimed"], "INBOX_CONCLUSIONS");
  exactKeys(inbox.lineage, ["retryAuthorized", "replacementAuthorized", "cleanupAuthorized", "replacementUnderThisLineage"], "INBOX_LINEAGE");
  exactKeys(inbox.discoveryContext, ["yBOLD", "yETHRecovery", "fixedBlockTruthEstablished"], "INBOX_DISCOVERY");
  expect([inbox.schemaVersion, inbox.claimId, inbox.status, inbox.signal, inbox.executionId], [2, CLAIM, FINAL_DISPOSITION, "WATCH_DIAGNOSTIC_ONLY_ACCESS_CAPABILITY_BLOCKED", EXECUTION_ID], "INBOX_IDENTITY");
  expect(inbox.result, { capture: "FAILED", authorization: "PERMANENTLY_CONSUMED", failureStage: "PIN", failureCode: "TWO_DISTINCT_FINALIZED_PROVIDERS_UNAVAILABLE", passOutputPresent: false, accessCapabilityBlocked: true, yearnNegativeEvidence: false, providerHealthEvidence: false }, "INBOX_RESULT_VALUES");
  expect(inbox.conclusions, { productionConfiguration: "UNKNOWN", withdrawLimitModule: "UNKNOWN", queue: "UNKNOWN", loss: "UNKNOWN", liquidity: "UNKNOWN", routePositive: "UNKNOWN", executable: "UNKNOWN", economics: "UNKNOWN", signedActionJustified: false, fork: false, findingClaimed: false }, "INBOX_CONCLUSION_VALUES");
  expect(inbox.lineage, { retryAuthorized: false, replacementAuthorized: false, cleanupAuthorized: false, replacementUnderThisLineage: false }, "INBOX_LINEAGE_VALUES");
  expect(inbox.discoveryContext, { yBOLD: "0x9F4330700a36B29952869fac9b33f45EEdd8A3d8", yETHRecovery: "0xd7a540ba3626c0aa66e7DB4088971d0CD64695B6", fixedBlockTruthEstablished: false }, "INBOX_DISCOVERY_VALUES");
  for (const [name, text] of [["REPORT", report], ["HANDOFF", handoff]]) {
    if (!text.includes("🟠 WATCH") || !text.includes(FINAL_DISPOSITION)) fail(`${name}_SIGNAL_OR_DISPOSITION`);
    if (!/access\/capability[- ]blocked/iu.test(text) || !text.includes("not Yearn-negative") || !text.includes("not provider-health evidence")
      || !/routePositive[^\n]*unknown/iu.test(text) || !text.includes("No replacement")) fail(`${name}_CLOSEOUT_LANGUAGE`);
    if (!text.includes("yBOLD") || !text.includes("yETH-Recovery") || !text.includes("reopen predicates") && !text.includes("Reopen predicates")) fail(`${name}_DISCOVERY_OR_REOPEN`);
    if (/networkCalls\s*[:=]\s*0|inventoryReads\s*[:=]\s*0|protected inventory reads\s*[:=]\s*0/iu.test(text)) fail(`${name}_INVENTED_COUNTER`);
  }
  return true;
}

let checks = 0;
function checked(fn) { const value = fn(); checks += 1; return value; }
function verifyResult(options = {}) {
  checks = 0;
  const read = (key) => options[`${key}Bytes`] || fs.readFileSync(rel(PATHS[key]));
  const diagnosticBytes = read("diagnostic"), ledgerBytes = read("ledger"), lockBytes = read("lock"), decisionBytes = read("decision");
  checked(() => expect(sha256(diagnosticBytes), HASHES.diagnostic, "DIAGNOSTIC_HASH"));
  checked(() => expect(sha256(ledgerBytes), HASHES.marker, "LEDGER_HASH"));
  checked(() => expect(sha256(lockBytes), HASHES.marker, "LOCK_HASH"));
  checked(() => expect(sha256(decisionBytes), HASHES.decision, "DECISION_HASH"));
  checked(() => expect(ledgerBytes.equals(lockBytes), true, "MARKERS_NOT_IDENTICAL"));
  const diagnostic = checked(() => validateDiagnostic(parseJson(diagnosticBytes, "DIAGNOSTIC")));
  const ledger = checked(() => validateMarker(parseJson(ledgerBytes, "LEDGER")));
  const lock = checked(() => validateMarker(parseJson(lockBytes, "LOCK")));
  const decision = checked(() => validateDecision(parseJson(decisionBytes, "DECISION")));
  checked(() => expect([diagnostic.executionId, ledger.executionId, lock.executionId, decision.executionId], [EXECUTION_ID, EXECUTION_ID, EXECUTION_ID, EXECUTION_ID], "EXECUTION_LINKAGE"));
  checked(() => expect([ledger.decisionSha256, lock.decisionSha256], [sha256(decisionBytes), sha256(decisionBytes)], "DECISION_MARKER_LINKAGE"));
  checked(() => assertNoLeak([diagnostic, ledger, lock, decision]));
  const passExists = options.passExists === undefined ? fs.existsSync(rel(PATHS.pass)) : options.passExists;
  checked(() => expect(passExists, false, "PASS_OUTPUT_PRESENT"));
  const report = options.report === undefined ? fs.readFileSync(rel(PATHS.report), "utf8") : options.report;
  const inbox = options.inbox === undefined ? parseJson(fs.readFileSync(rel(PATHS.inbox)), "INBOX") : options.inbox;
  const handoff = options.handoff === undefined ? fs.readFileSync(rel(PATHS.handoff), "utf8") : options.handoff;
  checked(() => validateCloseout(report, inbox, handoff));
  return { status: "PASS", checks, finalDisposition: FINAL_DISPOSITION, diagnosticSha256: HASHES.diagnostic, markerSha256: HASHES.marker, decisionSha256: HASHES.decision, executionId: EXECUTION_ID, passOutputPresent: false, retry: false, replacement: false, cleanup: false, signedActionJustified: false, fork: false };
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(verifyResult(), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error.code || "RESULT_VERIFICATION_FAILED"}\n`); process.exitCode = 1; }
}

module.exports = { ROOT, CLAIM, EXECUTION_ID, FINAL_DISPOSITION, HASHES, PATHS, DECISION_HASH_BINDINGS, ResultError, rel, sha256, stable, exactKeys, parseJson, validateDiagnostic, validateMarker, validateDecision, assertNoLeak, validateCloseout, verifyResult };
