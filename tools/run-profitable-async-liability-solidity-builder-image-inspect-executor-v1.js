#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const WORKSPACE = path.resolve(__dirname, "..");
const NAMESPACE = "profitable-async-liability-solidity-builder-image-inspect-executor-v1";
const PACKAGE_REL = `tools/vendor/${NAMESPACE}`;
const PACKAGE_ROOT = path.join(WORKSPACE, ...PACKAGE_REL.split("/"));
const AUTHORITY_PATH = path.join(PACKAGE_ROOT, "manifests", "authority-manifest.json");
const AUTHORITY_HASH_PATH = path.join(PACKAGE_ROOT, "manifests", "authority-manifest.sha256");
const AUTHORIZATION_PATH = path.join(PACKAGE_ROOT, "authorization", "current-turn-authorization.json");
const RUNS_ROOT = path.join(PACKAGE_ROOT, "runs");
const DECISION_PACKAGE_REL = "tools/vendor/profitable-async-liability-solidity-builder-image-inspect-executor-v1-review-decision";
const DECISION_PACKAGE_ROOT = path.join(WORKSPACE, ...DECISION_PACKAGE_REL.split("/"));
const DECISION_AUTHORITY_PATH = path.join(DECISION_PACKAGE_ROOT, "authority-manifest.json");
const DECISION_HASH_PATH = path.join(DECISION_PACKAGE_ROOT, "authority-manifest.sha256");
const DECISION_PATH = path.join(DECISION_PACKAGE_ROOT, "review-decision.json");
const FINAL_PACKAGE_REL = "tools/vendor/profitable-async-liability-solidity-builder-image-inspect-executor-v1-final-authority";
const FINAL_PACKAGE_ROOT = path.join(WORKSPACE, ...FINAL_PACKAGE_REL.split("/"));
const FINAL_AUTHORITY_PATH = path.join(FINAL_PACKAGE_ROOT, "authority-manifest.json");
const FINAL_HASH_PATH = path.join(FINAL_PACKAGE_ROOT, "authority-manifest.sha256");
const FINAL_DECISION_PATH = path.join(FINAL_PACKAGE_ROOT, "final-execution-authority.json");
const EXECUTE_FLAG = "--execute-reviewed-cached-image-inspect-executor-v1";
const ENDPOINT = "npipe:////./pipe/docker_engine";
const DOCKER_VERSION = "29.6.1";
const MANIFEST_DIGEST = "sha256:47d573d5a86379a06f850de200d69407e6baa2d2f9c19d9e156a67db57f80f2f";
const IMAGE = `docker.io/emscripten/emsdk@${MANIFEST_DIGEST}`;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 32 * 1024;
const TIMEOUT_MS = 30000;
const EMPTY_DOCKER_CONFIG = '{"auths":{}}';
const DIAGNOSTIC_MODULE_REL = "tools/run-profitable-async-liability-solidity-builder-image-inspect-diagnostic-v2.js";
const diagnostic = require(path.join(WORKSPACE, ...DIAGNOSTIC_MODULE_REL.split("/")));

const COUNTER_KEYS = Object.freeze([
  "processCalls", "daemonVersionRequests", "daemonVersionSuccess", "daemonInfoRequests",
  "daemonInfoSuccess", "imageInspectRequests", "imageInspectSuccess", "diagnosticWrites",
  "successMarkerWrites", "failureMarkerWrites", "authorizationConsumeMarkersWritten",
  "pullRequests", "tagRequests", "fallbackRequests", "loginRequests", "containerCreateRequests",
  "startRequests", "buildRequests", "removeRequests", "alternateEndpointRequests",
]);
const ZERO_COUNTERS = Object.freeze(Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0])));
const FORBIDDEN_COUNTERS = Object.freeze([
  "pullRequests", "tagRequests", "fallbackRequests", "loginRequests", "containerCreateRequests",
  "startRequests", "buildRequests", "removeRequests", "alternateEndpointRequests",
]);
const ERROR_CODES = Object.freeze([
  "REVIEW_DECISION_REQUIRED", "REVIEW_DECISION_INVALID", "FINAL_EXECUTION_AUTHORITY_REQUIRED",
  "FINAL_EXECUTION_AUTHORITY_INVALID", "ARGUMENTS_REJECTED", "AUTHORIZATION_INVALID",
  "AUTHORIZATION_ALREADY_CONSUMED", "PACKAGE_PATH_UNSAFE", "RUN_PATH_UNSAFE",
  "DURABILITY_NOT_ESTABLISHED", "DOCKER_ENV_REJECTED", "DAEMON_VERSION_FAILED",
  "DAEMON_INFO_FAILED", "QUALIFICATION_OUTPUT_LIMIT_EXCEEDED", "QUALIFICATION_OUTPUT_INVALID",
  "DAEMON_QUALIFICATION_FAILED", "IMAGE_NOT_CACHED_OR_INSPECT_FAILED",
  "INSPECT_OUTPUT_LIMIT_EXCEEDED", "INSPECT_OUTPUT_INVALID", "DIAGNOSTIC_FAILED",
  "OUTPUT_WRITE_FAILED", "EXECUTION_FAILED",
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function recordBytes(bytes) {
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

function fileRecord(file) {
  return recordBytes(fs.readFileSync(file));
}

function exactKeys(value, keys, code) {
  assert.equal(value && typeof value === "object" && !Array.isArray(value), true, code);
  assert.deepEqual(Object.keys(value), keys, code);
}

function parseJson(text, code) {
  try { return JSON.parse(text); }
  catch { throw new Error(code); }
}

function readJson(file, code) {
  return parseJson(fs.readFileSync(file, "utf8"), code);
}

function contained(target, root) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertFixedPathSafe(target, root, code) {
  assert.equal(contained(target, root), true, code);
  const absoluteRoot = path.resolve(root);
  assert.equal(fs.existsSync(absoluteRoot), true, code);
  const rootStat = fs.lstatSync(absoluteRoot);
  assert.equal(rootStat.isSymbolicLink(), false, code);
  const rootReal = fs.realpathSync.native ? fs.realpathSync.native(absoluteRoot) : fs.realpathSync(absoluteRoot);
  assert.equal(path.resolve(rootReal), absoluteRoot, code);
  let cursor = absoluteRoot;
  for (const part of path.relative(absoluteRoot, path.resolve(target)).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    assert.equal(fs.existsSync(cursor), true, code);
    const stat = fs.lstatSync(cursor);
    assert.equal(stat.isSymbolicLink(), false, code);
    const real = fs.realpathSync.native ? fs.realpathSync.native(cursor) : fs.realpathSync(cursor);
    assert.equal(path.resolve(real), path.resolve(cursor), code);
    assert.equal(contained(real, absoluteRoot), true, code);
  }
}

function assertFixedPackageFilesSafe(root, files, missingCode, unsafeCode) {
  if (!fs.existsSync(root) || !files.every((file) => fs.existsSync(file))) throw new Error(missingCode);
  try {
    assertFixedPathSafe(root, WORKSPACE, unsafeCode);
    for (const file of files) assertFixedPathSafe(file, root, unsafeCode);
  } catch { throw new Error(unsafeCode); }
}

function resolveWorkspaceRecord(record) {
  exactKeys(record, ["path", "bytes", "sha256"], "RECORD_KEYS");
  assert.match(record.path, /^[a-zA-Z0-9._/-]+$/);
  assert.equal(Number.isSafeInteger(record.bytes) && record.bytes >= 0, true, "RECORD_BYTES");
  assert.match(record.sha256, /^[a-f0-9]{64}$/);
  const resolved = path.resolve(WORKSPACE, ...record.path.split("/"));
  assert.equal(contained(resolved, WORKSPACE), true, "RECORD_OUTSIDE_WORKSPACE");
  return resolved;
}

function verifyRecord(record) {
  const file = resolveWorkspaceRecord(record);
  assertFixedPathSafe(file, WORKSPACE, "PACKAGE_PATH_UNSAFE");
  assert.deepEqual(fileRecord(file), { bytes: record.bytes, sha256: record.sha256 }, `SEAL_MISMATCH:${record.path}`);
}

function validateAuthorizationValue(value) {
  exactKeys(value, ["schema", "status", "authorizationId", "authorizedAtUtc", "currentTurnContext", "userAuthorizationText", "executorNamespace", "soleFlag", "scope", "consumption", "review"], "AUTHORIZATION_KEYS");
  assert.equal(value.schema, `${NAMESPACE}/current-turn-authorization-v1`);
  assert.equal(value.status, "USER_AUTHORIZED_PACKAGE_PREPARATION_AND_CONDITIONAL_ONE_SHOT_EXECUTION");
  assert.match(value.authorizationId, /^[a-f0-9]{32}$/);
  assert.equal(value.authorizedAtUtc, "2026-08-12T00:00:00Z");
  assert.equal(value.currentTurnContext, "USER_EXPLICITLY_AUTHORIZED_CREATE_REVIEW_AND_IF_APPROVED_EXECUTE_ONE_DISTINCT_HASH_PINNED_CACHED_IMAGE_DIAGNOSTIC_EXECUTOR");
  assert.equal(value.userAuthorizationText, "User explicitly authorized this current turn: create, independently review, and only if approved execute one distinct hash-pinned cached-image diagnostic executor.");
  assert.equal(value.executorNamespace, NAMESPACE);
  assert.equal(value.soleFlag, EXECUTE_FLAG);
  assert.deepEqual(value.scope, {
    dockerVersion: DOCKER_VERSION,
    endpoint: ENDPOINT,
    imageReference: IMAGE,
    maxCalls: 3,
    allowedCalls: ["DOCKER_VERSION", "DOCKER_INFO", "CACHED_EXACT_DIGEST_IMAGE_INSPECT"],
    forbidden: ["PULL", "TAG", "FALLBACK", "LOGIN", "CONTAINER_CREATE", "CONTAINER_START", "BUILD", "REMOVE", "ALTERNATE_ENDPOINT", "NETWORK_INVENTORY", "PARSER_PROMOTION", "DETECTOR_RUN"],
    cacheAbsence: "FAIL_CLOSED",
  });
  assert.deepEqual(value.consumption, { beforeFirstProcessCall: true, oneShotNoReuseOnFailure: true });
  assert.deepEqual(value.review, {
    independentDecisionRequired: true,
    selfApprovalForbidden: true,
    distinctAddOnlyDecisionPackage: DECISION_PACKAGE_REL,
    distinctFinalAuthorityPackage: FINAL_PACKAGE_REL,
  });
  return value;
}

function buildPlan(configToken = "<DEDICATED_EMPTY_DOCKER_CONFIG>") {
  assert.equal(typeof configToken === "string" && configToken.length > 0, true, "CONFIG_TOKEN");
  const base = ["--config", configToken, "--host", ENDPOINT];
  return {
    versionArgv: [...base, "version", "--format", "{{json .}}"],
    infoArgv: [...base, "info", "--format", "{{json .}}"],
    inspectArgv: [...base, "image", "inspect", IMAGE],
    shell: false,
    timeoutMs: TIMEOUT_MS,
    maxBufferBytes: MAX_OUTPUT_BYTES,
  };
}

function validateDecisionValue(decision, bindings) {
  exactKeys(decision, ["schema", "status", "authorizationId", "executorNamespace", "executorSha256", "executorAuthoritySha256", "executorDetachedChecksumSha256", "authorizationSha256", "scope", "verdict"], "DECISION_KEYS");
  assert.equal(decision.schema, `${NAMESPACE}/review-decision-v1`);
  assert.equal(decision.status, "APPROVED_UNCHANGED_FOR_ONE_SHOT_EXECUTION");
  assert.equal(decision.authorizationId, bindings.authorization.authorizationId);
  assert.equal(decision.executorNamespace, NAMESPACE);
  assert.equal(decision.executorSha256, bindings.executorSha256);
  assert.equal(decision.executorAuthoritySha256, bindings.executorAuthoritySha256);
  assert.equal(decision.executorDetachedChecksumSha256, bindings.executorDetachedChecksumSha256);
  assert.equal(decision.authorizationSha256, bindings.authorizationSha256);
  assert.deepEqual(decision.scope, bindings.authorization.scope);
  assert.equal(decision.verdict, "ORACLE_APPROVE_UNCHANGED_ONE_SHOT");
  return decision;
}

function validateFinalAuthorityValue(value, bindings) {
  exactKeys(value, ["schema", "status", "authorizationId", "executorNamespace", "executorSha256", "executorAuthoritySha256", "executorDetachedChecksumSha256", "authorizationSha256", "decisionSha256", "decisionAuthoritySha256", "decisionDetachedChecksumSha256", "scope", "oracleDisposition", "oneShot"], "FINAL_KEYS");
  assert.equal(value.schema, `${NAMESPACE}/final-execution-authority-v1`);
  assert.equal(value.status, "FINAL_ONE_SHOT_EXECUTION_AUTHORITY");
  assert.equal(value.authorizationId, bindings.authorization.authorizationId);
  assert.equal(value.executorNamespace, NAMESPACE);
  for (const key of ["executorSha256", "executorAuthoritySha256", "executorDetachedChecksumSha256", "authorizationSha256", "decisionSha256", "decisionAuthoritySha256", "decisionDetachedChecksumSha256"]) assert.equal(value[key], bindings[key]);
  assert.deepEqual(value.scope, bindings.authorization.scope);
  assert.equal(value.oracleDisposition, "ORACLE_FINAL_APPROVE_ONE_EXECUTION");
  assert.deepEqual(value.oneShot, { consumeBeforeFirstCall: true, noReuseOnFailure: true });
  return value;
}

function validateExecutorAuthorityFixed() {
  assertFixedPackageFilesSafe(PACKAGE_ROOT, [AUTHORITY_PATH, AUTHORITY_HASH_PATH, AUTHORIZATION_PATH], "AUTHORIZATION_INVALID", "PACKAGE_PATH_UNSAFE");
  const detachedBytes = fs.readFileSync(AUTHORITY_HASH_PATH);
  const match = /^([a-f0-9]{64})  manifests\/authority-manifest\.json\n$/.exec(detachedBytes.toString("utf8"));
  assert.notEqual(match, null, "DETACHED_AUTHORITY_FORMAT");
  assert.equal(fileRecord(AUTHORITY_PATH).sha256, match[1], "DETACHED_AUTHORITY_MISMATCH");
  const authority = readJson(AUTHORITY_PATH, "AUTHORITY_INVALID");
  exactKeys(authority, ["schema", "namespace", "status", "executionAuthorized", "executionFlag", "packageManifest", "report", "authorization", "reviewDecision", "finalAuthority", "claims", "detachedChecksumRole"], "AUTHORITY_KEYS");
  assert.equal(authority.schema, `${NAMESPACE}/authority-v1`);
  assert.equal(authority.namespace, NAMESPACE);
  assert.equal(authority.status, "SEALED_EXECUTOR_REVIEW_REQUIRED_NOT_EXECUTED");
  assert.equal(authority.executionAuthorized, false);
  assert.equal(authority.executionFlag, EXECUTE_FLAG);
  assert.deepEqual(authority.reviewDecision, { expectedPackageRoot: DECISION_PACKAGE_REL, present: false, distinctAddOnlyPackageRequired: true });
  assert.deepEqual(authority.finalAuthority, { expectedPackageRoot: FINAL_PACKAGE_REL, present: false, distinctAddOnlyPackageRequired: true });
  assert.deepEqual(authority.claims, { cachedImage: false, execution: false, equality: false, reproducibility: false, parserPromotion: false, detectorRun: false });
  verifyRecord(authority.packageManifest);
  verifyRecord(authority.report);
  verifyRecord(authority.authorization);
  const manifest = readJson(resolveWorkspaceRecord(authority.packageManifest), "PACKAGE_MANIFEST_INVALID");
  assert.equal(manifest.schema, `${NAMESPACE}/package-manifest-v1`);
  assert.equal(manifest.namespace, NAMESPACE);
  assert.equal(manifest.status, authority.status);
  assert.equal(manifest.executionAuthorized, false);
  assert.equal(manifest.scope.endpoint, ENDPOINT);
  assert.equal(manifest.scope.imageReference, IMAGE);
  assert.equal(manifest.scope.maxProcessCalls, 3);
  assert.deepEqual(manifest.scope.forbiddenCounters, Object.fromEntries(FORBIDDEN_COUNTERS.map((key) => [key, 0])));
  assert.deepEqual(manifest.consumptionBindings, [
    "authorizationSha256", "decisionSha256", "decisionAuthoritySha256",
    "decisionDetachedChecksumSha256", "executorSha256", "executorAuthoritySha256",
    "executorDetachedChecksumSha256", "finalAuthoritySha256", "finalDetachedChecksumSha256",
  ]);
  for (const record of [...manifest.successorRecords, ...manifest.diagnosticV2Records, ...manifest.predecessorEvidenceRecords]) verifyRecord(record);
  diagnostic.validateAuthorityChain();
  const authorization = validateAuthorizationValue(readJson(AUTHORIZATION_PATH, "AUTHORIZATION_INVALID"));
  assert.deepEqual(fileRecord(AUTHORIZATION_PATH), { bytes: authority.authorization.bytes, sha256: authority.authorization.sha256 });
  return {
    authority,
    manifest,
    authorization,
    executorAuthoritySha256: match[1],
    executorDetachedChecksumSha256: sha256(detachedBytes),
    authorizationSha256: authority.authorization.sha256,
    executorSha256: manifest.successorRecords.find((record) => record.path.endsWith("executor-v1.js")).sha256,
  };
}

function loadDecisionFixed(executorBindings) {
  assertFixedPackageFilesSafe(DECISION_PACKAGE_ROOT, [DECISION_AUTHORITY_PATH, DECISION_HASH_PATH, DECISION_PATH], "REVIEW_DECISION_REQUIRED", "REVIEW_DECISION_INVALID");
  const detachedBytes = fs.readFileSync(DECISION_HASH_PATH);
  const match = /^([a-f0-9]{64})  authority-manifest\.json\n$/.exec(detachedBytes.toString("utf8"));
  if (!match || fileRecord(DECISION_AUTHORITY_PATH).sha256 !== match[1]) throw new Error("REVIEW_DECISION_INVALID");
  try {
    const authority = readJson(DECISION_AUTHORITY_PATH, "REVIEW_DECISION_INVALID");
    exactKeys(authority, ["schema", "status", "decision", "executorAuthoritySha256", "independentReviewer"], "DECISION_AUTHORITY_KEYS");
    assert.equal(authority.schema, `${NAMESPACE}/review-decision-authority-v1`);
    assert.equal(authority.status, "INDEPENDENT_REVIEW_APPROVED_ONE_SHOT");
    assert.equal(authority.executorAuthoritySha256, executorBindings.executorAuthoritySha256);
    assert.equal(authority.independentReviewer, "ORACLE");
    exactKeys(authority.decision, ["path", "bytes", "sha256"], "DECISION_RECORD");
    assert.equal(authority.decision.path, "review-decision.json");
    assert.deepEqual(fileRecord(DECISION_PATH), { bytes: authority.decision.bytes, sha256: authority.decision.sha256 });
    const decision = validateDecisionValue(readJson(DECISION_PATH, "REVIEW_DECISION_INVALID"), executorBindings);
    return {
      decision,
      decisionSha256: authority.decision.sha256,
      decisionAuthoritySha256: match[1],
      decisionDetachedChecksumSha256: sha256(detachedBytes),
    };
  } catch { throw new Error("REVIEW_DECISION_INVALID"); }
}

function loadFinalAuthorityFixed(bindings) {
  assertFixedPackageFilesSafe(FINAL_PACKAGE_ROOT, [FINAL_AUTHORITY_PATH, FINAL_HASH_PATH, FINAL_DECISION_PATH], "FINAL_EXECUTION_AUTHORITY_REQUIRED", "FINAL_EXECUTION_AUTHORITY_INVALID");
  const detachedBytes = fs.readFileSync(FINAL_HASH_PATH);
  const match = /^([a-f0-9]{64})  authority-manifest\.json\n$/.exec(detachedBytes.toString("utf8"));
  if (!match || fileRecord(FINAL_AUTHORITY_PATH).sha256 !== match[1]) throw new Error("FINAL_EXECUTION_AUTHORITY_INVALID");
  try {
    const authority = readJson(FINAL_AUTHORITY_PATH, "FINAL_EXECUTION_AUTHORITY_INVALID");
    exactKeys(authority, ["schema", "status", "finalAuthority", "executorAuthoritySha256", "oracleFinalReview"], "FINAL_AUTHORITY_KEYS");
    assert.equal(authority.schema, `${NAMESPACE}/final-authority-package-v1`);
    assert.equal(authority.status, "FINAL_AUTHORITY_PACKAGE_APPROVED");
    assert.equal(authority.executorAuthoritySha256, bindings.executorAuthoritySha256);
    assert.equal(authority.oracleFinalReview, "ORACLE_FINAL_APPROVE_ONE_EXECUTION");
    exactKeys(authority.finalAuthority, ["path", "bytes", "sha256"], "FINAL_RECORD");
    assert.equal(authority.finalAuthority.path, "final-execution-authority.json");
    assert.deepEqual(fileRecord(FINAL_DECISION_PATH), { bytes: authority.finalAuthority.bytes, sha256: authority.finalAuthority.sha256 });
    const finalValue = validateFinalAuthorityValue(readJson(FINAL_DECISION_PATH, "FINAL_EXECUTION_AUTHORITY_INVALID"), bindings);
    return {
      finalValue,
      finalAuthoritySha256: authority.finalAuthority.sha256,
      finalDetachedChecksumSha256: sha256(detachedBytes),
    };
  } catch { throw new Error("FINAL_EXECUTION_AUTHORITY_INVALID"); }
}

function sanitizedDockerEnv(dockerConfig) {
  for (const key of Object.keys(process.env)) {
    if (["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_AUTH_CONFIG", "REGISTRY_AUTH_FILE", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"].includes(key.toUpperCase())) throw new Error("DOCKER_ENV_REJECTED");
  }
  const env = { DOCKER_CONFIG: dockerConfig };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "PATHEXT"]) if (typeof process.env[key] === "string") env[key] = process.env[key];
  return env;
}

function safeCounters(context) {
  return Object.fromEntries(COUNTER_KEYS.map((key) => [key, context.counters[key]]));
}

function establishConsumption(bindings) {
  assertFixedPathSafe(PACKAGE_ROOT, WORKSPACE, "PACKAGE_PATH_UNSAFE");
  if (!fs.existsSync(RUNS_ROOT)) fs.mkdirSync(RUNS_ROOT, { recursive: false });
  assertFixedPathSafe(RUNS_ROOT, PACKAGE_ROOT, "RUN_PATH_UNSAFE");
  const runRoot = path.join(RUNS_ROOT, bindings.authorization.authorizationId);
  if (fs.existsSync(runRoot)) throw new Error("AUTHORIZATION_ALREADY_CONSUMED");
  fs.mkdirSync(runRoot, { recursive: false });
  assertFixedPathSafe(runRoot, RUNS_ROOT, "RUN_PATH_UNSAFE");
  const dockerConfig = path.join(runRoot, "docker-config");
  fs.mkdirSync(dockerConfig, { recursive: false });
  const configPath = path.join(dockerConfig, "config.json");
  const configFd = fs.openSync(configPath, "wx", 0o600);
  try { fs.writeSync(configFd, EMPTY_DOCKER_CONFIG, null, "utf8"); fs.fsyncSync(configFd); }
  finally { fs.closeSync(configFd); }
  assert.equal(fs.readFileSync(configPath, "utf8"), EMPTY_DOCKER_CONFIG, "DURABILITY_NOT_ESTABLISHED");
  const marker = {
    schema: `${NAMESPACE}/authorization-consumed-v1`,
    authorizationId: bindings.authorization.authorizationId,
    consumed: true,
    bindings: {
      authorizationSha256: bindings.authorizationSha256,
      decisionSha256: bindings.decisionSha256,
      decisionAuthoritySha256: bindings.decisionAuthoritySha256,
      decisionDetachedChecksumSha256: bindings.decisionDetachedChecksumSha256,
      executorSha256: bindings.executorSha256,
      executorAuthoritySha256: bindings.executorAuthoritySha256,
      executorDetachedChecksumSha256: bindings.executorDetachedChecksumSha256,
      finalAuthoritySha256: bindings.finalAuthoritySha256,
      finalDetachedChecksumSha256: bindings.finalDetachedChecksumSha256,
    },
    durability: {
      exclusiveRunRoot: true,
      markerFileFsync: true,
      exactReadback: true,
      parentDirectoryFsync: "ATTEMPTED_PLATFORM_DEPENDENT",
    },
    counters: { ...ZERO_COUNTERS, authorizationConsumeMarkersWritten: 1 },
  };
  const markerText = `${JSON.stringify(marker)}\n`;
  const markerPath = path.join(runRoot, "authorization-consumed.json");
  const markerFd = fs.openSync(markerPath, "wx", 0o600);
  try { fs.writeSync(markerFd, markerText, null, "utf8"); fs.fsyncSync(markerFd); }
  finally { fs.closeSync(markerFd); }
  assert.equal(fs.readFileSync(markerPath, "utf8"), markerText, "DURABILITY_NOT_ESTABLISHED");
  try {
    const parentFd = fs.openSync(runRoot, "r");
    try { fs.fsyncSync(parentFd); }
    finally { fs.closeSync(parentFd); }
  } catch {
    // Reviewed Windows alternative: exclusive root plus marker fsync and exact readback.
  }
  return { runRoot, dockerConfig };
}

function openJournal(runRoot) {
  const fd = fs.openSync(path.join(runRoot, "journal.jsonl"), "ax", 0o600);
  let seq = 0;
  return {
    append(phase, operation, counters, fields = {}) {
      const value = { seq, phase, operation, counters };
      if (fields.errorCode !== undefined) value.errorCode = fields.errorCode;
      if (fields.fieldIds !== undefined) value.fieldIds = fields.fieldIds;
      if (fields.matched !== undefined) value.matched = fields.matched;
      fs.writeSync(fd, `${JSON.stringify(value)}\n`, null, "utf8"); fs.fsyncSync(fd); seq += 1;
    },
    close() { fs.closeSync(fd); },
  };
}

function writeSanitized(runRoot, filename, value) {
  const text = typeof value === "string" ? value : `${JSON.stringify(value)}\n`;
  const fd = fs.openSync(path.join(runRoot, filename), "wx", 0o600);
  try { fs.writeSync(fd, text, null, "utf8"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  assert.equal(fs.readFileSync(path.join(runRoot, filename), "utf8"), text, "OUTPUT_WRITE_FAILED");
}

function callDocker(operation, argv, context) {
  context.counters.processCalls += 1;
  const result = childProcess.spawnSync("docker", argv, {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    env: context.env,
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result && result.error && result.error.code === "ENOBUFS") throw new Error(operation === "INSPECT" ? "INSPECT_OUTPUT_LIMIT_EXCEEDED" : "QUALIFICATION_OUTPUT_LIMIT_EXCEEDED");
  if (!result || result.error || result.status !== 0) throw new Error(operation === "VERSION" ? "DAEMON_VERSION_FAILED" : operation === "INFO" ? "DAEMON_INFO_FAILED" : "IMAGE_NOT_CACHED_OR_INSPECT_FAILED");
  if (typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES) throw new Error(operation === "INSPECT" ? "INSPECT_OUTPUT_LIMIT_EXCEEDED" : "QUALIFICATION_OUTPUT_LIMIT_EXCEEDED");
  return result.stdout;
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

function safeErrorCode(error) {
  return ERROR_CODES.includes(error && error.message) ? error.message : "EXECUTION_FAILED";
}

function executeFixed(bindings) {
  const staged = establishConsumption(bindings);
  const context = { counters: { ...ZERO_COUNTERS, authorizationConsumeMarkersWritten: 1 }, env: sanitizedDockerEnv(staged.dockerConfig) };
  const plan = buildPlan(staged.dockerConfig);
  const journal = openJournal(staged.runRoot);
  try {
    context.counters.daemonVersionRequests = 1;
    journal.append("before", "VERSION", safeCounters(context));
    const version = parseJson(callDocker("VERSION", plan.versionArgv, context), "QUALIFICATION_OUTPUT_INVALID");
    context.counters.daemonVersionSuccess = 1;
    journal.append("after", "VERSION", safeCounters(context));
    context.counters.daemonInfoRequests = 1;
    journal.append("before", "INFO", safeCounters(context));
    const info = parseJson(callDocker("INFO", plan.infoArgv, context), "QUALIFICATION_OUTPUT_INVALID");
    validateDaemon(version, info);
    context.counters.daemonInfoSuccess = 1;
    journal.append("after", "INFO", safeCounters(context));
    context.counters.imageInspectRequests = 1;
    journal.append("before", "INSPECT", safeCounters(context));
    const inspectText = callDocker("INSPECT", plan.inspectArgv, context);
    context.counters.imageInspectSuccess = 1;
    journal.append("after", "INSPECT", safeCounters(context));
    let result;
    try {
      result = diagnostic.parseInspectText(inspectText, { source: "DOCKER_IMAGE_INSPECT_MEMORY_ONLY", runId: bindings.authorization.authorizationId });
      diagnostic.validateDiagnosticSchema(result);
    } catch (error) {
      throw new Error(error && error.message === "INSPECT_INPUT_TOO_LARGE" ? "INSPECT_OUTPUT_LIMIT_EXCEEDED" : "INSPECT_OUTPUT_INVALID");
    }
    const diagnosticText = `${JSON.stringify(result)}\n`;
    if (Buffer.byteLength(diagnosticText) > MAX_DIAGNOSTIC_BYTES) throw new Error("DIAGNOSTIC_FAILED");
    writeSanitized(staged.runRoot, "diagnostic.json", diagnosticText);
    context.counters.diagnosticWrites = 1;
    journal.append("after", "DIAGNOSTIC", safeCounters(context), { fieldIds: result.summary.mismatchFieldIds, matched: result.status === "IMAGE_INSPECT_DIAGNOSIS_MATCH" });
    for (const key of FORBIDDEN_COUNTERS) assert.equal(context.counters[key], 0);
    assert.equal(context.counters.processCalls, 3);
    writeSanitized(staged.runRoot, "success.json", {
      schema: `${NAMESPACE}/success-v1`, status: "SANITIZED_DIAGNOSTIC_CAPTURED",
      authorizationId: bindings.authorization.authorizationId, counters: safeCounters(context),
      diagnosticStatus: result.status, mismatchFieldIds: result.summary.mismatchFieldIds,
    });
    context.counters.successMarkerWrites = 1;
    journal.append("final", "SUCCESS", safeCounters(context), { fieldIds: result.summary.mismatchFieldIds, matched: result.status === "IMAGE_INSPECT_DIAGNOSIS_MATCH" });
    return {
      schema: `${NAMESPACE}/cli-result-v1`, status: "SANITIZED_DIAGNOSTIC_CAPTURED",
      authorizationId: bindings.authorization.authorizationId, counters: safeCounters(context),
      diagnosticStatus: result.status, mismatchFieldIds: result.summary.mismatchFieldIds,
    };
  } catch (error) {
    const code = safeErrorCode(error);
    try {
      writeSanitized(staged.runRoot, "failure.json", {
        schema: `${NAMESPACE}/failure-v1`, status: "EXECUTION_FAILED_CONSUMED",
        authorizationId: bindings.authorization.authorizationId, errorCode: code, counters: safeCounters(context),
      });
      context.counters.failureMarkerWrites = 1;
      journal.append("final", "FAILURE", safeCounters(context), { errorCode: code });
    } catch {}
    const sanitized = new Error(code);
    sanitized.counters = safeCounters(context);
    throw sanitized;
  } finally { journal.close(); }
}

function simulateResponses(responses) {
  exactKeys(responses, ["version", "info", "inspect"], "SIMULATION_KEYS");
  const counters = { ...ZERO_COUNTERS };
  const step = (name, response) => {
    counters.processCalls += 1;
    if (name === "VERSION") counters.daemonVersionRequests = 1;
    if (name === "INFO") counters.daemonInfoRequests = 1;
    if (name === "INSPECT") counters.imageInspectRequests = 1;
    if (response.errorCode === "ENOBUFS") return name === "INSPECT" ? "INSPECT_OUTPUT_LIMIT_EXCEEDED" : "QUALIFICATION_OUTPUT_LIMIT_EXCEEDED";
    if (response.status !== 0) return name === "VERSION" ? "DAEMON_VERSION_FAILED" : name === "INFO" ? "DAEMON_INFO_FAILED" : "IMAGE_NOT_CACHED_OR_INSPECT_FAILED";
    if (name === "VERSION") counters.daemonVersionSuccess = 1;
    if (name === "INFO") counters.daemonInfoSuccess = 1;
    if (name === "INSPECT") counters.imageInspectSuccess = 1;
    return null;
  };
  for (const [name, response] of [["VERSION", responses.version], ["INFO", responses.info], ["INSPECT", responses.inspect]]) {
    exactKeys(response, ["status", "errorCode"], "SIMULATION_RESPONSE_KEYS");
    const code = step(name, response);
    if (code) return { status: "SIMULATED_FAILURE", errorCode: code, counters };
  }
  return { status: "SIMULATED_SUCCESS", errorCode: null, counters };
}

function runDefault() {
  const bindings = validateExecutorAuthorityFixed();
  const plan = buildPlan();
  assert.deepEqual(plan.inspectArgv.slice(-3), ["image", "inspect", IMAGE]);
  assert.equal([...plan.versionArgv, ...plan.infoArgv, ...plan.inspectArgv].some((value) => ["pull", "tag", "login", "create", "start", "build", "rm", "remove"].includes(value)), false);
  return {
    schema: `${NAMESPACE}/offline-summary-v1`, status: "PASS",
    packageStatus: bindings.authority.status, executionAuthorized: false,
    reviewDecisionPresent: false, finalAuthorityPresent: false, processCalls: 0, writes: 0,
  };
}

function main(argv) {
  if (argv.length === 0) return runDefault();
  if (argv.length !== 1 || argv[0] !== EXECUTE_FLAG) throw new Error("ARGUMENTS_REJECTED");
  const executorBindings = validateExecutorAuthorityFixed();
  const decisionBindings = loadDecisionFixed(executorBindings);
  const combined = { ...executorBindings, ...decisionBindings };
  const finalBindings = loadFinalAuthorityFixed(combined);
  return executeFixed({ ...combined, ...finalBindings });
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "FAIL", errorCode: safeErrorCode(error), counters: error && error.counters ? error.counters : { processCalls: 0 } })}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  NAMESPACE,
  EXECUTE_FLAG,
  ENDPOINT,
  DOCKER_VERSION,
  IMAGE,
  MANIFEST_DIGEST,
  MAX_OUTPUT_BYTES,
  MAX_DIAGNOSTIC_BYTES,
  TIMEOUT_MS,
  ZERO_COUNTERS,
  buildPlan,
  simulateResponses,
  validateAuthorizationValue,
  validateDecisionValue,
  validateFinalAuthorityValue,
});
