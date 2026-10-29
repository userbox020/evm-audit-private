#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const WORKSPACE = path.resolve(__dirname, "..");
const NAMESPACE = "profitable-async-liability-solidity-builder-image-inspect-correction-v1";
const PACKAGE_REL = `tools/vendor/${NAMESPACE}`;
const PACKAGE_ROOT = path.join(WORKSPACE, ...PACKAGE_REL.split("/"));
const AUTHORITY_PATH = path.join(PACKAGE_ROOT, "manifests", "authority-manifest.json");
const AUTHORITY_HASH_PATH = path.join(PACKAGE_ROOT, "manifests", "authority-manifest.sha256");
const EVIDENCE_PATH = path.join(PACKAGE_ROOT, "terminal-evidence.json");
const DIAGNOSTIC_REL = "tools/run-profitable-async-liability-solidity-builder-image-inspect-diagnostic-v2.js";
const diagnostic = require(path.join(WORKSPACE, ...DIAGNOSTIC_REL.split("/")));

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileRecord(file) {
  const bytes = fs.readFileSync(file);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

function exactKeys(value, keys, code) {
  assert.equal(value && typeof value === "object" && !Array.isArray(value), true, code);
  assert.deepEqual(Object.keys(value), keys, code);
}

function readJson(file, code) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error(code); }
}

function contained(target, root) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveRecord(record) {
  exactKeys(record, ["path", "bytes", "sha256"], "RECORD_KEYS");
  assert.match(record.path, /^[a-zA-Z0-9._/-]+$/);
  assert.equal(Number.isSafeInteger(record.bytes) && record.bytes >= 0, true, "RECORD_BYTES");
  assert.match(record.sha256, /^[a-f0-9]{64}$/);
  const resolved = path.resolve(WORKSPACE, ...record.path.split("/"));
  assert.equal(contained(resolved, WORKSPACE), true, "RECORD_OUTSIDE_WORKSPACE");
  return resolved;
}

function verifyRecord(record) {
  assert.deepEqual(fileRecord(resolveRecord(record)), { bytes: record.bytes, sha256: record.sha256 }, `SEAL_MISMATCH:${record.path}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeOciDefaults(image) {
  assert.equal(image && typeof image === "object" && !Array.isArray(image), true, "IMAGE_OBJECT_REQUIRED");
  const normalized = clone(image);
  if (!Object.prototype.hasOwnProperty.call(normalized, "Config")) return normalized;
  if (!normalized.Config || typeof normalized.Config !== "object" || Array.isArray(normalized.Config)) return normalized;
  const config = normalized.Config;
  if (!Object.prototype.hasOwnProperty.call(config, "User") || config.User === null) config.User = "";
  if (!Object.prototype.hasOwnProperty.call(config, "Cmd")) config.Cmd = null;
  return normalized;
}

function compareCorrectedInspect(image, input = {}) {
  return diagnostic.compareImageInspect(normalizeOciDefaults(image), input);
}

function validateTerminalEvidence(value) {
  exactKeys(value, ["schema", "namespace", "status", "authorization", "runArtifacts", "terminalResult", "validatorCause", "claims", "futureBoundary"], "EVIDENCE_KEYS");
  assert.equal(value.schema, `${NAMESPACE}/terminal-evidence-v1`);
  assert.equal(value.namespace, NAMESPACE);
  assert.equal(value.status, "TERMINAL_VALID_MISMATCH_AUTHORIZATION_CONSUMED");
  assert.deepEqual(value.authorization, {
    authorizationId: "8f2c6a13d9e44720bc5186fe3a701d94",
    permanentlyConsumed: true,
    retryAuthorized: false,
  });
  assert.equal(value.runArtifacts.length, 4);
  for (const record of value.runArtifacts) verifyRecord(record);
  assert.deepEqual(value.terminalResult, {
    validSanitizedDiagnostic: true,
    processCalls: 3,
    allowedCalls: ["DOCKER_VERSION", "DOCKER_INFO", "CACHED_EXACT_DIGEST_IMAGE_INSPECT"],
    forbiddenCountersAllZero: true,
    rawInspectRetained: false,
    fieldsCompared: 9,
    fieldsMatched: 7,
    fieldsMismatched: 2,
    mismatchFieldIds: ["CONFIG_USER", "CONFIG_CMD"],
    mismatchDetailCodes: { CONFIG_USER: "MISSING", CONFIG_CMD: "MISSING" },
  });
  assert.deepEqual(value.validatorCause, {
    classification: "RETROSPECTIVE_MECHANICALLY_SUPPORTED_VALIDATOR_CAUSE_NOT_DIRECT_RAW_PROOF",
    configUser: "GATE0_NORMALIZED_MISSING_USER_TO_EMPTY_STRING_NOT_SUFFICIENT_TO_FAIL",
    configCmd: "STRICT_CONFIG_CMD_NULL_CHECK_REJECTS_MISSING_MECHANICALLY_SUFFICIENT_TO_EXPLAIN_FAILURE",
    directRawInspectProof: false,
  });
  assert.deepEqual(value.claims, {
    oldGate0Modified: false,
    reinspectAuthorized: false,
    buildAuthorized: false,
    parserPromotionAuthorized: false,
    detectorRunAuthorized: false,
  });
  assert.deepEqual(value.futureBoundary, {
    newBuildSuccessorRequiresFreshUserAuthorization: true,
    independentReviewRequired: true,
  });
  return value;
}

function validateAuthorityChain() {
  const detached = fs.readFileSync(AUTHORITY_HASH_PATH, "utf8");
  const match = /^([a-f0-9]{64})  manifests\/authority-manifest\.json\n$/.exec(detached);
  assert.notEqual(match, null, "DETACHED_FORMAT");
  assert.equal(fileRecord(AUTHORITY_PATH).sha256, match[1], "DETACHED_MISMATCH");
  const authority = readJson(AUTHORITY_PATH, "AUTHORITY_INVALID");
  exactKeys(authority, ["schema", "namespace", "status", "executionAuthorized", "packageManifest", "report", "claims"], "AUTHORITY_KEYS");
  assert.equal(authority.schema, `${NAMESPACE}/authority-v1`);
  assert.equal(authority.namespace, NAMESPACE);
  assert.equal(authority.status, "SEALED_OFFLINE_NO_EXECUTION_AUTHORITY");
  assert.equal(authority.executionAuthorized, false);
  assert.deepEqual(authority.claims, { reinspect: false, build: false, parserPromotion: false, detectorRun: false });
  verifyRecord(authority.packageManifest);
  verifyRecord(authority.report);
  const manifest = readJson(resolveRecord(authority.packageManifest), "MANIFEST_INVALID");
  assert.equal(manifest.schema, `${NAMESPACE}/package-manifest-v1`);
  assert.equal(manifest.namespace, NAMESPACE);
  assert.equal(manifest.status, authority.status);
  assert.equal(manifest.executionAuthorized, false);
  assert.deepEqual(manifest.correctedSemantics, {
    CONFIG_USER: "MISSING_NULL_EMPTY_STRING_EQUIVALENT_DEFAULT_OTHER_VALUES_REJECTED",
    CONFIG_CMD: "MISSING_NULL_EQUIVALENT_DEFAULT_ALL_OTHER_TYPES_AND_VALUES_REJECTED",
    otherFields: "UNCHANGED_DIAGNOSTIC_V2_STRICT_SEMANTICS",
  });
  for (const record of [...manifest.successorRecords, ...manifest.executorChainRecords, ...manifest.decisionRecords, ...manifest.finalAuthorityRecords, ...manifest.diagnosticV2Records, ...manifest.terminalPredecessorRecords, ...manifest.runArtifactRecords]) verifyRecord(record);
  assert.equal(manifest.successorRecords.length, 3);
  assert.equal(manifest.executorChainRecords.length, 7);
  assert.equal(manifest.decisionRecords.length, 3);
  assert.equal(manifest.finalAuthorityRecords.length, 3);
  assert.equal(manifest.diagnosticV2Records.length, 8);
  assert.equal(manifest.terminalPredecessorRecords.length, 2);
  assert.equal(manifest.runArtifactRecords.length, 4);
  validateTerminalEvidence(readJson(EVIDENCE_PATH, "EVIDENCE_INVALID"));
  diagnostic.validateAuthorityChain();
  return { authority, manifest };
}

function runDefault() {
  const chain = validateAuthorityChain();
  return {
    schema: `${NAMESPACE}/offline-summary-v1`,
    status: "PASS",
    authorityStatus: chain.authority.status,
    processCalls: 0,
    writes: 0,
    executionAuthorized: false,
  };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 0) throw new Error("ARGUMENTS_REJECTED");
  return runDefault();
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main())}\n`); }
  catch { process.stderr.write(`${JSON.stringify({ status: "FAIL", errorCode: "OFFLINE_VALIDATION_FAILED", processCalls: 0, writes: 0 })}\n`); process.exitCode = 1; }
}

module.exports = Object.freeze({
  NAMESPACE,
  compareCorrectedInspect,
  normalizeOciDefaults,
  validateTerminalEvidence,
});
