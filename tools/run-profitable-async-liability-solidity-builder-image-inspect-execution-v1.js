#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const WORKSPACE = path.resolve(__dirname, "..");
const NAMESPACE = "profitable-async-liability-solidity-builder-image-inspect-execution-v1";
const PACKAGE_REL = `tools/vendor/${NAMESPACE}`;
const PACKAGE_ROOT = path.join(WORKSPACE, PACKAGE_REL);
const AUTHORITY_PATH = path.join(PACKAGE_ROOT, "manifests", "authority-manifest.json");
const AUTHORITY_HASH_PATH = path.join(PACKAGE_ROOT, "manifests", "authority-manifest.sha256");
const FIXTURE_PATH = path.join(PACKAGE_ROOT, "fixtures", "docker-qualified-responses.json");
const EXECUTE_FLAG = "--execute-reviewed-cached-image-inspect-v1";
const ENDPOINT = "npipe:////./pipe/docker_engine";
const DOCKER_VERSION = "29.6.1";
const MANIFEST_DIGEST = "sha256:47d573d5a86379a06f850de200d69407e6baa2d2f9c19d9e156a67db57f80f2f";
const IMAGE = `docker.io/emscripten/emsdk@${MANIFEST_DIGEST}`;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 32 * 1024;
const TIMEOUT_MS = 30 * 1000;
const DIAGNOSTIC_MODULE_REL = "tools/run-profitable-async-liability-solidity-builder-image-inspect-diagnostic-v2.js";
const diagnostic = require(path.join(WORKSPACE, ...DIAGNOSTIC_MODULE_REL.split("/")));

const COUNTER_KEYS = Object.freeze([
  "processCalls", "daemonQualificationRequests", "daemonQualificationSuccess",
  "imageInspectRequests", "imageInspectSuccess", "diagnosticsProduced",
  "pullRequests", "tagRequests", "fallbackRequests", "containerCreateRequests",
  "startRequests", "buildRequests", "removeRequests", "writes",
]);
const ZERO_COUNTERS = Object.freeze(Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0])));
const FORBIDDEN_KEYS = Object.freeze([
  "pullRequests", "tagRequests", "fallbackRequests", "containerCreateRequests",
  "startRequests", "buildRequests", "removeRequests", "writes",
]);
const SIMULATION_ERRORS = Object.freeze([
  "QUALIFICATION_VERSION_FAILED", "QUALIFICATION_INFO_FAILED", "QUALIFICATION_OUTPUT_LIMIT_EXCEEDED",
  "QUALIFICATION_OUTPUT_INVALID", "DAEMON_QUALIFICATION_FAILED", "IMAGE_NOT_CACHED_OR_INSPECT_FAILED",
  "INSPECT_OUTPUT_LIMIT_EXCEEDED", "INSPECT_OUTPUT_INVALID", "DIAGNOSTIC_FAILED",
]);

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileRecord(file) {
  const bytes = fs.readFileSync(file);
  return { bytes: bytes.length, sha256: sha256Buffer(bytes) };
}

function exactKeys(value, keys, code) {
  assert.equal(value && typeof value === "object" && !Array.isArray(value), true, code);
  assert.deepEqual(Object.keys(value), keys, code);
}

function readJson(file, code) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error(code); }
}

function resolveRecord(record) {
  exactKeys(record, ["path", "bytes", "sha256"], "RECORD_KEYS");
  assert.match(record.path, /^[a-zA-Z0-9._/-]+$/);
  assert.equal(Number.isSafeInteger(record.bytes) && record.bytes >= 0, true, "RECORD_BYTES");
  assert.match(record.sha256, /^[a-f0-9]{64}$/);
  const resolved = path.resolve(WORKSPACE, ...record.path.split("/"));
  const relative = path.relative(WORKSPACE, resolved);
  assert.equal(relative.startsWith("..") || path.isAbsolute(relative), false, "RECORD_OUTSIDE_WORKSPACE");
  return resolved;
}

function verifyRecord(record) {
  assert.deepEqual(fileRecord(resolveRecord(record)), { bytes: record.bytes, sha256: record.sha256 }, `SEAL_MISMATCH:${record.path}`);
}

function validateAuthorityChain() {
  const detached = fs.readFileSync(AUTHORITY_HASH_PATH, "utf8");
  const detachedMatch = /^([a-f0-9]{64})  manifests\/authority-manifest\.json\n$/.exec(detached);
  assert.notEqual(detachedMatch, null, "DETACHED_CHECKSUM_FORMAT");
  assert.equal(fileRecord(AUTHORITY_PATH).sha256, detachedMatch[1], "DETACHED_CHECKSUM_MISMATCH");
  const authority = readJson(AUTHORITY_PATH, "AUTHORITY_INVALID");
  exactKeys(authority, ["schema", "namespace", "status", "executionAuthorized", "executable", "executionFlag", "proposalManifest", "report", "futureExecutor", "claims", "detachedChecksumRole"], "AUTHORITY_KEYS");
  assert.equal(authority.schema, `${NAMESPACE}/authority-v1`);
  assert.equal(authority.namespace, NAMESPACE);
  assert.equal(authority.status, "SEALED_PROPOSAL_REVIEW_REQUIRED_EXECUTION_UNAUTHORIZED");
  assert.equal(authority.executionAuthorized, false);
  assert.equal(authority.executable, false);
  assert.equal(authority.executionFlag, EXECUTE_FLAG);
  assert.equal(authority.detachedChecksumRole, "LOCAL_INTEGRITY_CHECK_ONLY_NOT_EXTERNAL_TRUST_ANCHOR");
  assert.deepEqual(authority.futureExecutor, {
    distinctAddOnlyPackageRequired: true,
    explicitCurrentTurnAuthorizationRequired: true,
    exactExecutorBytesAndSha256Required: true,
    reviewedEmbeddedOneRunDecisionRequired: true,
    grantDropInCannotEnableThisPackage: true,
  });
  assert.deepEqual(authority.claims, { cachedImage: false, execution: false, durability: false, equality: false, reproducibility: false, parserPromotion: false });
  verifyRecord(authority.proposalManifest);
  verifyRecord(authority.report);

  const manifest = readJson(resolveRecord(authority.proposalManifest), "PROPOSAL_MANIFEST_INVALID");
  assert.equal(manifest.schema, `${NAMESPACE}/proposal-manifest-v1`);
  assert.equal(manifest.namespace, NAMESPACE);
  assert.equal(manifest.status, authority.status);
  assert.equal(manifest.executionAuthorized, false);
  assert.equal(manifest.executable, false);
  assert.equal(manifest.executionFlagBehavior, "ALWAYS_FAIL_DISTINCT_HASH_PINNED_EXECUTOR_REQUIRED");
  assert.equal(manifest.defaultWrites, 0);
  assert.equal(manifest.scope.endpoint, ENDPOINT);
  assert.equal(manifest.scope.imageReference, IMAGE);
  assert.equal(manifest.scope.dockerVersion, DOCKER_VERSION);
  assert.equal(manifest.scope.maxDaemonQualificationCalls, 2);
  assert.equal(manifest.scope.maxImageInspectRequests, 1);
  assert.equal(manifest.scope.maxProcessCalls, 3);
  assert.equal(manifest.scope.shell, false);
  assert.equal(manifest.scope.cacheAbsencePolicy, "FAIL_CLOSED_NO_PULL");
  assert.deepEqual(manifest.scope.forbiddenCounters, Object.fromEntries(FORBIDDEN_KEYS.filter((key) => key !== "writes").map((key) => [key, 0])));
  assert.equal(manifest.outputMaxBytes, MAX_OUTPUT_BYTES);
  assert.equal(manifest.diagnosticMaxBytes, MAX_DIAGNOSTIC_BYTES);
  assert.equal(manifest.timeoutMs, TIMEOUT_MS);
  for (const record of [...manifest.successorRecords, ...manifest.fixtureRecords, ...manifest.diagnosticV2.records]) verifyRecord(record);
  assert.equal(manifest.successorRecords.length, 2);
  assert.equal(manifest.fixtureRecords.length, 1);
  assert.equal(manifest.diagnosticV2.records.length, 8);
  assert.equal(manifest.diagnosticV2.authoritySha256, "fd61ce8bcf96773ed7f0b19277aab658fe25d76320104542b3c02df2a296b295");
  assert.equal(manifest.diagnosticV2.diagnosticManifestSha256, "a322db01673e7721b76f45451a0399157cb340041e49779290a3176d7212f24b");
  assert.deepEqual(manifest.terminalPredecessor, {
    runId: "54ae1c68cf9ed4e2",
    authorizationConsumed: true,
    exactFailedImageField: null,
    journalSha256: "5415368990eec83c77e2dc9e63634ec9a38bf6b89294264e31268db10b05e8e8",
    failureMarkerSha256: "6e8c606e179f55e38b60728409228f43784a888ba3ed7aa08999a97bd243fd90",
  });
  assert.equal(manifest.futureRequirements.packageRootSafety.resolvedContainmentRequired, true);
  assert.equal(manifest.futureRequirements.packageRootSafety.linkJunctionReparseRejectionRequired, true);
  assert.equal(manifest.futureRequirements.durability.policy, "FAIL_BEFORE_PROCESS_CALLS_UNLESS_REVIEWED_DURABILITY_MECHANISM_ESTABLISHED");
  assert.deepEqual(manifest.futureRequirements.consumptionMustBind, ["grantSha256", "decisionSha256", "executorSha256", "executorAuthoritySha256", "detachedExecutorChecksumSha256"]);
  assert.equal(manifest.futureRequirements.currentPackageWritesConsumptionMarker, false);
  diagnostic.validateAuthorityChain();
  return { authority, manifest, checksumSha256: detachedMatch[1] };
}

function buildOfflinePlan(dockerConfigToken = "<DEDICATED_EMPTY_DOCKER_CONFIG>") {
  assert.equal(typeof dockerConfigToken === "string" && dockerConfigToken.length > 0, true, "DOCKER_CONFIG_TOKEN");
  const base = ["--config", dockerConfigToken, "--host", ENDPOINT];
  return {
    schema: `${NAMESPACE}/offline-plan-v1`,
    shell: false,
    timeoutMs: TIMEOUT_MS,
    maxBufferBytes: MAX_OUTPUT_BYTES,
    versionArgv: [...base, "version", "--format", "{{json .}}"],
    infoArgv: [...base, "info", "--format", "{{json .}}"],
    inspectArgv: [...base, "image", "inspect", IMAGE],
    forbiddenOperations: ["pull", "tag", "fallback", "create", "start", "build", "remove"],
  };
}

function validateFixtureResponse(response, operation) {
  exactKeys(response, ["status", "errorCode", "stdoutBytes", "stdout"], "SIMULATED_RESPONSE_KEYS");
  assert.equal(Number.isSafeInteger(response.status), true, "SIMULATED_STATUS");
  assert.equal(response.errorCode === null || ["ENOBUFS", "ENOENT", "ETIMEDOUT", "EFAIL"].includes(response.errorCode), true, "SIMULATED_ERROR_CODE");
  assert.equal(Number.isSafeInteger(response.stdoutBytes) && response.stdoutBytes >= 0, true, "SIMULATED_STDOUT_BYTES");
  assert.equal(typeof response.stdout === "string", true, "SIMULATED_STDOUT");
  assert.equal(Buffer.byteLength(response.stdout), response.stdoutBytes, "SIMULATED_STDOUT_COUNT");
  assert.equal(["VERSION", "INFO", "INSPECT"].includes(operation), true);
  return response;
}

function simulationFailure(code, counters) {
  assert.equal(SIMULATION_ERRORS.includes(code), true, "SIMULATION_ERROR_CODE");
  for (const key of FORBIDDEN_KEYS) assert.equal(counters[key], 0, `SIMULATION_FORBIDDEN_${key}`);
  return {
    schema: `${NAMESPACE}/simulation-result-v1`,
    status: "SIMULATED_FAILURE",
    errorCode: code,
    counters: { ...counters },
    diagnostic: null,
  };
}

function parseSimulatedJson(response, operation) {
  if (response.errorCode === "ENOBUFS" || response.stdoutBytes > MAX_OUTPUT_BYTES) {
    throw new Error(operation === "INSPECT" ? "INSPECT_OUTPUT_LIMIT_EXCEEDED" : "QUALIFICATION_OUTPUT_LIMIT_EXCEEDED");
  }
  if (response.errorCode !== null || response.status !== 0) {
    if (operation === "VERSION") throw new Error("QUALIFICATION_VERSION_FAILED");
    if (operation === "INFO") throw new Error("QUALIFICATION_INFO_FAILED");
    throw new Error("IMAGE_NOT_CACHED_OR_INSPECT_FAILED");
  }
  if (operation === "INSPECT") return response.stdout;
  try { return JSON.parse(response.stdout); }
  catch { throw new Error("QUALIFICATION_OUTPUT_INVALID"); }
}

function validateDaemon(version, info) {
  try {
    assert.equal(version.Client.Version, DOCKER_VERSION);
    assert.equal(version.Server.Version, DOCKER_VERSION);
    assert.equal(info.ServerVersion, DOCKER_VERSION);
    assert.equal(String(info.OSType).toLowerCase(), "linux");
    assert.equal(["amd64", "x86_64"].includes(String(info.Architecture).toLowerCase()), true);
    assert.equal(Array.isArray(info.SecurityOptions), true);
    assert.equal(typeof info.CgroupVersion, "string");
    assert.equal(typeof info.NCPU, "number");
    assert.equal(typeof info.MemTotal, "number");
  } catch { throw new Error("DAEMON_QUALIFICATION_FAILED"); }
}

function simulatePlan(responses, options = {}) {
  exactKeys(responses, ["version", "info", "inspect"], "SIMULATION_RESPONSES");
  const runId = options.runId === undefined ? "a".repeat(16) : options.runId;
  assert.match(runId, /^[a-f0-9]{16}(?:[a-f0-9]{16})?$/, "SIMULATION_RUN_ID");
  const counters = { ...ZERO_COUNTERS };
  try {
    counters.daemonQualificationRequests += 1;
    counters.processCalls += 1;
    const version = parseSimulatedJson(validateFixtureResponse(responses.version, "VERSION"), "VERSION");
    counters.daemonQualificationSuccess += 1;

    counters.daemonQualificationRequests += 1;
    counters.processCalls += 1;
    const info = parseSimulatedJson(validateFixtureResponse(responses.info, "INFO"), "INFO");
    validateDaemon(version, info);
    counters.daemonQualificationSuccess += 1;

    counters.imageInspectRequests += 1;
    counters.processCalls += 1;
    const inspectText = parseSimulatedJson(validateFixtureResponse(responses.inspect, "INSPECT"), "INSPECT");
    let result;
    try {
      result = diagnostic.parseInspectText(inspectText, { source: "DOCKER_IMAGE_INSPECT_MEMORY_ONLY", runId });
      diagnostic.validateDiagnosticSchema(result);
    } catch (error) {
      if (error && ["INSPECT_INPUT_TOO_LARGE"].includes(error.message)) throw new Error("INSPECT_OUTPUT_LIMIT_EXCEEDED");
      throw new Error("INSPECT_OUTPUT_INVALID");
    }
    counters.imageInspectSuccess += 1;
    counters.diagnosticsProduced += 1;
    assert.equal(Buffer.byteLength(JSON.stringify(result)) <= MAX_DIAGNOSTIC_BYTES, true, "DIAGNOSTIC_SIZE");
    for (const key of FORBIDDEN_KEYS) assert.equal(counters[key], 0);
    return {
      schema: `${NAMESPACE}/simulation-result-v1`,
      status: "SIMULATED_DIAGNOSTIC",
      errorCode: null,
      counters: { ...counters },
      diagnostic: result,
    };
  } catch (error) {
    const code = SIMULATION_ERRORS.includes(error && error.message) ? error.message : "DIAGNOSTIC_FAILED";
    return simulationFailure(code, counters);
  }
}

function fixtureResponses() {
  const fixture = readJson(FIXTURE_PATH, "FIXTURE_INVALID");
  exactKeys(fixture, ["schema", "version", "info", "inspect"], "FIXTURE_KEYS");
  assert.equal(fixture.schema, `${NAMESPACE}/pure-simulation-fixture-v1`);
  return { version: fixture.version, info: fixture.info, inspect: fixture.inspect };
}

function runOfflineFixtures() {
  const responses = fixtureResponses();
  const result = simulatePlan(responses);
  assert.equal(result.status, "SIMULATED_DIAGNOSTIC");
  assert.equal(result.counters.processCalls, 3);
  assert.equal(result.counters.writes, 0);
  const plan = buildOfflinePlan();
  assert.equal([...plan.versionArgv, ...plan.infoArgv, ...plan.inspectArgv].includes("pull"), false);
  return { fixtureCases: 2, fixtureAssertions: 4 };
}

function runDefault() {
  const { authority } = validateAuthorityChain();
  const fixtures = runOfflineFixtures();
  return {
    schema: `${NAMESPACE}/offline-summary-v1`,
    status: "PASS",
    authorityStatus: authority.status,
    executable: false,
    executionAuthorized: false,
    processCalls: 0,
    writes: 0,
    fixtureCases: fixtures.fixtureCases,
    fixtureAssertions: fixtures.fixtureAssertions,
  };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) return runDefault();
  if (argv.length === 1 && argv[0] === EXECUTE_FLAG) {
    validateAuthorityChain();
    throw new Error("DISTINCT_HASH_PINNED_EXECUTOR_REQUIRED");
  }
  throw new Error("ARGUMENTS_REJECTED");
}

function safeErrorCode(error) {
  const value = error && typeof error.message === "string" ? error.message : "";
  return ["DISTINCT_HASH_PINNED_EXECUTOR_REQUIRED", "ARGUMENTS_REJECTED"].includes(value) ? value : "PROPOSAL_VALIDATION_FAILED";
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main())}\n`); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "FAIL", errorCode: safeErrorCode(error), processCalls: 0, writes: 0 })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DOCKER_VERSION, ENDPOINT, EXECUTE_FLAG, IMAGE, MANIFEST_DIGEST, MAX_DIAGNOSTIC_BYTES,
  MAX_OUTPUT_BYTES, NAMESPACE, TIMEOUT_MS, ZERO_COUNTERS, buildOfflinePlan, fileRecord,
  fixtureResponses, main, runDefault, runOfflineFixtures, safeErrorCode, simulatePlan,
  validateAuthorityChain,
};
