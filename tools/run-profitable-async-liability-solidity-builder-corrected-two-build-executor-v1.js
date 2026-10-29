#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const WORKSPACE = path.resolve(__dirname, "..");
const NAMESPACE = "profitable-async-liability-solidity-builder-corrected-two-build-executor-v1";
const PACKAGE_REL = `tools/vendor/${NAMESPACE}`;
const PACKAGE_ROOT = path.join(WORKSPACE, ...PACKAGE_REL.split("/"));
const AUTHORIZATION_PATH = path.join(PACKAGE_ROOT, "authorization", "current-turn-authorization.json");
const PACKAGE_MANIFEST_PATH = path.join(PACKAGE_ROOT, "manifests", "package-manifest.json");
const AUTHORITY_PATH = path.join(PACKAGE_ROOT, "manifests", "authority-manifest.json");
const AUTHORITY_HASH_PATH = path.join(PACKAGE_ROOT, "manifests", "authority-manifest.sha256");
const RUNS_ROOT = path.join(PACKAGE_ROOT, "runs");
const DECISION_PACKAGE_REL = "tools/vendor/profitable-async-liability-solidity-builder-corrected-two-build-executor-v1-review-decision";
const DECISION_ROOT = path.join(WORKSPACE, ...DECISION_PACKAGE_REL.split("/"));
const DECISION_PATH = path.join(DECISION_ROOT, "review-decision.json");
const DECISION_AUTHORITY_PATH = path.join(DECISION_ROOT, "authority-manifest.json");
const DECISION_HASH_PATH = path.join(DECISION_ROOT, "authority-manifest.sha256");
const FINAL_PACKAGE_REL = "tools/vendor/profitable-async-liability-solidity-builder-corrected-two-build-executor-v1-final-authority";
const FINAL_ROOT = path.join(WORKSPACE, ...FINAL_PACKAGE_REL.split("/"));
const FINAL_PATH = path.join(FINAL_ROOT, "final-execution-authority.json");
const FINAL_AUTHORITY_PATH = path.join(FINAL_ROOT, "authority-manifest.json");
const FINAL_HASH_PATH = path.join(FINAL_ROOT, "authority-manifest.sha256");
const CORRECTION_REL = "tools/validate-profitable-async-liability-solidity-builder-image-inspect-correction-v2.js";
const correction = require(path.join(WORKSPACE, ...CORRECTION_REL.split("/")));

const EXECUTE_FLAG = "--execute-reviewed-corrected-two-build-executor-v1";
const ENDPOINT = "npipe:////./pipe/docker_engine";
const DOCKER_VERSION = "29.6.1";
const IMAGE = "docker.io/emscripten/emsdk@sha256:47d573d5a86379a06f850de200d69407e6baa2d2f9c19d9e156a67db57f80f2f";
const CONFIG_DIGEST = "sha256:a411b47f58dbac78da4f2ea974e6bdbb4cd0598d6de7d8166903cdb34d6ecc9e";
const OUTPUT_NAME = "tree-sitter-solidity.wasm";
const OUTPUT_BYTES = 508582;
const OUTPUT_SHA256 = "07420813d7668445152a5d5d2017e0fb84cb27342257e1add3cc7462eec7f811";
const TIMEOUT_MS = 120000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const EMPTY_DOCKER_CONFIG = '{"auths":{}}';
const ENTRYPOINT = "/emsdk/upstream/emscripten/emcc";
const EMCC_ARGV = Object.freeze([
  "-o", "/out/tree-sitter-solidity.wasm", "-Os", "-s", "WASM=1", "-s", "SIDE_MODULE=2",
  "-s", "TOTAL_MEMORY=33554432", "-s", "NODEJS_CATCH_EXIT=0", "-s",
  "EXPORTED_FUNCTIONS=[\"_tree_sitter_solidity\"]", "-fno-exceptions", "-fvisibility=hidden",
  "-I", ".", "parser.c",
]);
const IMAGE_ENV = Object.freeze([
  "PATH=/emsdk:/emsdk/upstream/emscripten:/emsdk/node/20.18.0_64bit/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "EMSDK=/emsdk",
]);
const EXPLICIT_ENV = Object.freeze(["TZ=UTC", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "HOME=/home/nonroot", "XDG_CACHE_HOME=/cache"]);
const EFFECTIVE_ENV = Object.freeze([...IMAGE_ENV, ...EXPLICIT_ENV]);
const TMPFS = Object.freeze({
  "/tmp": "rw,nosuid,nodev,size=268435456",
  "/home/nonroot": "rw,noexec,nosuid,nodev,size=33554432",
  "/cache": "rw,size=536870912",
});
const LIMITS = Object.freeze({ memory: 4294967296, memorySwap: 4294967296, nanoCpus: 2000000000, pidsLimit: 256 });
const SOURCE_RECORDS = Object.freeze([
  Object.freeze({ path: "tools/vendor/profitable-async-liability-delta-detector-v1-parser-authority/sources/extracted/tree-sitter-solidity-1.2.13/package/src/parser.c", stage: "parser.c", bytes: 2567063, sha256: "e71971f6ddc0704e81f4af3f43ecc79793742bb5f1d256a5fdd718aa06d74acb" }),
  Object.freeze({ path: "tools/vendor/profitable-async-liability-delta-detector-v1-parser-authority/sources/extracted/tree-sitter-solidity-1.2.13/package/src/tree_sitter/parser.h", stage: "tree_sitter/parser.h", bytes: 7624, sha256: "180b893c8734778fd32f372dfbc27bd6ad1cd2221f26150b31256ff6716320d2" }),
]);
const GRAMMAR_RECORD = Object.freeze({ path: "tools/vendor/profitable-async-liability-delta-detector-v1-parser-authority/sources/extracted/tree-sitter-solidity-1.2.13/package/src/grammar.json", bytes: 171238, sha256: "74a3972bdcd8e08047e911e5beb5f2bad06a5329629bebb8b05a6a883683da40" });
const PUBLISHED_RECORD = Object.freeze({ path: "tools/vendor/profitable-async-liability-delta-detector-v1-parser-authority/sources/extracted/tree-sitter-solidity-1.2.13/package/tree-sitter-solidity.wasm", bytes: OUTPUT_BYTES, sha256: OUTPUT_SHA256 });
const COUNTER_KEYS = Object.freeze([
  "processCalls", "versionRequests", "versionSuccess", "infoRequests", "infoSuccess", "imageInspectRequests", "imageInspectSuccess",
  "absenceRequests", "absenceObserved", "createRequests", "createSuccess", "createdInspectRequests", "createdInspectSuccess",
  "startRequests", "daemonObservedStarts", "exitInspectRequests", "exitInspectSuccess", "verifiedBuilds",
  "removeRequests", "removeSuccess", "cleanupAbsenceVerified", "authorizationConsumeMarkersWritten", "successMarkerWrites", "failureMarkerWrites",
]);
const ZERO_COUNTERS = Object.freeze(Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0])));
const SUCCESS_COUNTERS = Object.freeze({
  processCalls: 17, versionRequests: 1, versionSuccess: 1, infoRequests: 1, infoSuccess: 1,
  imageInspectRequests: 1, imageInspectSuccess: 1, absenceRequests: 4, absenceObserved: 4,
  createRequests: 2, createSuccess: 2, createdInspectRequests: 2, createdInspectSuccess: 2,
  startRequests: 2, daemonObservedStarts: 2, exitInspectRequests: 2, exitInspectSuccess: 2,
  verifiedBuilds: 2, removeRequests: 2, removeSuccess: 2, cleanupAbsenceVerified: 2,
  authorizationConsumeMarkersWritten: 1, successMarkerWrites: 1, failureMarkerWrites: 0,
});
const ERROR_CODES = Object.freeze([
  "REVIEW_DECISION_REQUIRED", "REVIEW_DECISION_INVALID", "FINAL_EXECUTION_AUTHORITY_REQUIRED", "FINAL_EXECUTION_AUTHORITY_INVALID",
  "ARGUMENTS_REJECTED", "AUTHORIZATION_INVALID", "AUTHORIZATION_ALREADY_CONSUMED", "PACKAGE_PATH_UNSAFE", "RUN_PATH_UNSAFE",
  "DURABILITY_NOT_ESTABLISHED", "DOCKER_ENV_REJECTED", "LOCAL_INPUT_INVALID", "DAEMON_QUALIFICATION_FAILED", "IMAGE_INSPECT_INVALID",
  "NAME_NOT_ABSENT", "CREATE_FAILED", "CREATED_INSPECT_FAILED", "CREATED_CONFIG_INVALID", "START_FAILED", "EXIT_INSPECT_FAILED",
  "NONZERO_EXIT", "OUTPUT_INVALID", "REMOVE_FAILED", "CLEANUP_ABSENCE_FAILED", "BUILD_A_FAILED_NO_BUILD_B", "EQUALITY_FAILED",
  "PUBLISHED_WASM_CHANGED", "OUTPUT_LIMIT_EXCEEDED", "EXECUTION_FAILED",
]);
const CONSUMPTION_BINDING_KEYS = Object.freeze([
  "authorizationSha256", "executorSha256", "testsSha256", "reportSha256", "packageManifestSha256",
  "executorAuthoritySha256", "executorDetachedChecksumSha256", "correctionV2PackageSha256", "correctionV2AuthoritySha256",
  "correctionV2DetachedChecksumSha256", "builderManifestSha256", "parserCSha256", "parserHeaderSha256", "grammarJsonSha256",
  "publishedWasmSha256", "decisionSha256", "decisionAuthoritySha256", "decisionDetachedChecksumSha256",
  "finalAuthoritySha256", "finalDetachedChecksumSha256",
]);

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fileRecord(file) { const bytes = fs.readFileSync(file); return { bytes: bytes.length, sha256: sha256(bytes) }; }
function exactKeys(value, keys, code) { assert.equal(value && typeof value === "object" && !Array.isArray(value), true, code); assert.deepEqual(Object.keys(value), keys, code); }
function parseJson(text, code) { try { return JSON.parse(text); } catch { throw new Error(code); } }
function readJson(file, code) { return parseJson(fs.readFileSync(file, "utf8"), code); }
function contained(target, root) { const rel = path.relative(path.resolve(root), path.resolve(target)); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); }
function resolveRecord(record) {
  exactKeys(record, ["path", "bytes", "sha256"], "RECORD_KEYS");
  assert.match(record.path, /^[a-zA-Z0-9._/-]+$/); assert.equal(Number.isSafeInteger(record.bytes) && record.bytes >= 0, true); assert.match(record.sha256, /^[a-f0-9]{64}$/);
  const file = path.resolve(WORKSPACE, ...record.path.split("/")); assert.equal(contained(file, WORKSPACE), true, "RECORD_OUTSIDE_WORKSPACE"); return file;
}
function assertPathSafe(target, root, code) {
  const absoluteRoot = path.resolve(root); const absolute = path.resolve(target);
  assert.equal(contained(absolute, absoluteRoot), true, code); assert.equal(fs.existsSync(absoluteRoot), true, code);
  let cursor = absoluteRoot;
  for (const part of path.relative(absoluteRoot, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part); if (!fs.existsSync(cursor)) break;
    const stat = fs.lstatSync(cursor); assert.equal(stat.isSymbolicLink(), false, code);
    const real = fs.realpathSync.native ? fs.realpathSync.native(cursor) : fs.realpathSync(cursor);
    assert.equal(path.resolve(real), path.resolve(cursor), code); assert.equal(contained(real, absoluteRoot), true, code);
  }
}
function verifyRecord(record) { const file = resolveRecord(record); assertPathSafe(file, WORKSPACE, "PACKAGE_PATH_UNSAFE"); assert.deepEqual(fileRecord(file), { bytes: record.bytes, sha256: record.sha256 }, `SEAL_MISMATCH:${record.path}`); }
function safeCounters(context) { return Object.fromEntries(COUNTER_KEYS.map((key) => [key, context.counters[key]])); }
function envMap(values) { const out = Object.create(null); for (const entry of values) { const at = entry.indexOf("="); assert.equal(at > 0, true); const key = entry.slice(0, at); assert.equal(Object.hasOwn(out, key), false); out[key] = entry.slice(at + 1); } return out; }
function canonicalRepo(value) { let x = String(value).toLowerCase(); for (const prefix of ["docker.io/", "index.docker.io/"]) if (x.startsWith(prefix)) x = x.slice(prefix.length); return x; }

function validateAuthorizationValue(value) {
  exactKeys(value, ["schema", "status", "authorizationId", "authorizedAtUtc", "boundedInterpretation", "executorNamespace", "soleFlag", "scope", "consumption", "review"], "AUTHORIZATION_KEYS");
  assert.equal(value.schema, `${NAMESPACE}/current-turn-authorization-v1`);
  assert.equal(value.status, "USER_AUTHORIZED_CREATE_REVIEW_AND_CONDITIONAL_ONE_SHOT_TWO_BUILD_EXECUTION");
  assert.match(value.authorizationId, /^[a-f0-9]{32}$/); assert.equal(value.authorizedAtUtc, "2026-08-12T00:00:00Z");
  assert.equal(value.boundedInterpretation, "User's current-turn 'please' responded directly to the stated requirement for fresh authorization to create/review/conditionally execute the two-build successor. It authorizes only creation, independent review, and conditional one-shot execution after approval of this exact bounded successor; it does not authorize immediate execution, broader Docker use, parser promotion, detector execution, inventory access, network access, or any retry.");
  assert.equal(value.executorNamespace, NAMESPACE); assert.equal(value.soleFlag, EXECUTE_FLAG);
  assert.deepEqual(value.scope, {
    cachedExactDigestImageOnly: IMAGE, endpoint: ENDPOINT, dockerVersion: DOCKER_VERSION, successfulDockerCallsExactly: 17,
    successfulCallCounts: { version: 1, info: 1, imageInspect: 1, exactNameAbsenceChecks: 4, create: 2, createdInspect: 2, startAttach: 2, exitedInspect: 2, rmForce: 2 },
    startsExactly: 2, buildsExactly: 2, sequential: "A_REMOVED_AND_ABSENT_BEFORE_B", noBuildBAfterBuildAFailure: true,
    forbidden: ["PULL", "TAG", "LOGIN", "FALLBACK", "INVENTORY", "ALTERNATE_ENDPOINT", "PARSER_PROMOTION", "DETECTOR_RUN", "RETRY"],
  });
  assert.deepEqual(value.consumption, { packageLocalRunRoot: true, beforeFirstDockerCall: true, oneShotNoReuseOnAnyOutcome: true, bindingsAtLeast: 15 });
  assert.deepEqual(value.review, { independentDecisionRequired: true, selfApprovalForbidden: true, distinctDecisionPackage: DECISION_PACKAGE_REL, distinctFinalAuthorityPackage: FINAL_PACKAGE_REL });
  return value;
}

function createArgs(config, name, sourceDir, outputDir) {
  const base = ["--config", config, "--host", ENDPOINT];
  const argv = [...base, "create", "--name", name, "--platform", "linux/amd64", "--pull", "never", "--network", "none", "--read-only",
    "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--memory", String(LIMITS.memory),
    "--memory-swap", String(LIMITS.memorySwap), "--cpus", "2", "--pids-limit", String(LIMITS.pidsLimit), "--ipc", "private", "--cgroupns", "private",
    "--workdir", "/src", "--entrypoint", ENTRYPOINT];
  for (const env of EXPLICIT_ENV) argv.push("--env", env);
  argv.push("--mount", `type=bind,src=${sourceDir},dst=/src,readonly`, "--mount", `type=bind,src=${outputDir},dst=/out`,
    "--tmpfs", `/tmp:${TMPFS["/tmp"]}`, "--tmpfs", `/home/nonroot:${TMPFS["/home/nonroot"]}`, "--tmpfs", `/cache:${TMPFS["/cache"]}`, IMAGE, ...EMCC_ARGV);
  return argv;
}

function buildPlan(config = "<DEDICATED_EMPTY_DOCKER_CONFIG>", root = "<FIXED_PACKAGE_LOCAL_RUN_ROOT>", authorizationId = "00000000000000000000000000000000") {
  assert.match(authorizationId, /^[a-f0-9]{32}$/);
  const base = ["--config", config, "--host", ENDPOINT]; const sourceDir = path.join(root, "source");
  const builds = ["a", "b"].map((label) => {
    const name = `pal-corrected-two-build-${authorizationId}-${label}`; const outputDir = path.join(root, `out-${label}`);
    return { label, name, outputDir, absenceBeforeArgv: [...base, "container", "inspect", name], createArgv: createArgs(config, name, sourceDir, outputDir),
      createdInspectArgv: [...base, "container", "inspect", name], startArgv: [...base, "start", "--attach", name],
      exitedInspectArgv: [...base, "container", "inspect", name], removeArgv: [...base, "rm", "--force", name], absenceAfterArgv: [...base, "container", "inspect", name] };
  });
  const operations = ["VERSION", "INFO", "IMAGE_INSPECT", ...builds.flatMap((build) => [
    `${build.label.toUpperCase()}_ABSENCE_BEFORE`, `${build.label.toUpperCase()}_CREATE`, `${build.label.toUpperCase()}_CREATED_INSPECT`,
    `${build.label.toUpperCase()}_START_ATTACH`, `${build.label.toUpperCase()}_EXITED_INSPECT`, `${build.label.toUpperCase()}_RM_FORCE`, `${build.label.toUpperCase()}_ABSENCE_AFTER`,
  ])];
  return { shell: false, timeoutMs: TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES, operations,
    versionArgv: [...base, "version", "--format", "{{json .}}"], infoArgv: [...base, "info", "--format", "{{json .}}"], imageInspectArgv: [...base, "image", "inspect", IMAGE], builds };
}

function simulatePlan(failAt = null) {
  const plan = buildPlan(); const counters = { ...ZERO_COUNTERS, authorizationConsumeMarkersWritten: 1 }; const observed = [];
  function mark(operation) {
    observed.push(operation); counters.processCalls += 1;
    if (operation === "VERSION") counters.versionRequests += 1;
    else if (operation === "INFO") counters.infoRequests += 1;
    else if (operation === "IMAGE_INSPECT") counters.imageInspectRequests += 1;
    else if (operation.includes("ABSENCE")) counters.absenceRequests += 1;
    else if (operation.endsWith("CREATE")) counters.createRequests += 1;
    else if (operation.endsWith("CREATED_INSPECT")) counters.createdInspectRequests += 1;
    else if (operation.endsWith("START_ATTACH")) counters.startRequests += 1;
    else if (operation.endsWith("EXITED_INSPECT")) counters.exitInspectRequests += 1;
    else if (operation.endsWith("RM_FORCE")) counters.removeRequests += 1;
    if (operation === failAt) return false;
    if (operation === "VERSION") counters.versionSuccess += 1;
    else if (operation === "INFO") counters.infoSuccess += 1;
    else if (operation === "IMAGE_INSPECT") counters.imageInspectSuccess += 1;
    else if (operation.endsWith("ABSENCE_BEFORE")) counters.absenceObserved += 1;
    else if (operation.endsWith("CREATE")) counters.createSuccess += 1;
    else if (operation.endsWith("CREATED_INSPECT")) counters.createdInspectSuccess += 1;
    else if (operation.endsWith("START_ATTACH")) { counters.daemonObservedStarts += 1; }
    else if (operation.endsWith("EXITED_INSPECT")) { counters.exitInspectSuccess += 1; counters.verifiedBuilds += 1; }
    else if (operation.endsWith("RM_FORCE")) counters.removeSuccess += 1;
    else if (operation.endsWith("ABSENCE_AFTER")) { counters.absenceObserved += 1; counters.cleanupAbsenceVerified += 1; }
    return true;
  }
  for (const operation of plan.operations) {
    if (!mark(operation)) {
      const build = operation.startsWith("A_") ? "A" : operation.startsWith("B_") ? "B" : null;
      if (build && (operation.endsWith("CREATE") || counters.createRequests > (build === "A" ? 0 : 1))) {
        if (!operation.endsWith("RM_FORCE")) mark(`${build}_RM_FORCE`);
        if (!operation.endsWith("ABSENCE_AFTER")) mark(`${build}_ABSENCE_AFTER`);
      }
      return { status: "SIMULATED_FAILURE", errorCode: build === "A" ? "BUILD_A_FAILED_NO_BUILD_B" : "EXECUTION_FAILED", observed, counters };
    }
  }
  counters.successMarkerWrites = 1; return { status: "SIMULATED_SUCCESS", errorCode: null, observed, counters };
}

function validateImageInspectPure(value) {
  const result = correction.compareCorrectedInspect(value, { source: "DOCKER_IMAGE_INSPECT_MEMORY_ONLY", runId: "0".repeat(32) });
  assert.equal(result.summary.fieldsCompared, 9); assert.equal(result.summary.fieldsMismatched, 0, "IMAGE_INSPECT_INVALID"); return result;
}

function validateDecisionValue(value, bindings) {
  exactKeys(value, ["schema", "status", "authorizationId", "executorNamespace", "bindings", "scope", "verdict"], "DECISION_KEYS");
  assert.equal(value.schema, `${NAMESPACE}/review-decision-v1`); assert.equal(value.status, "APPROVED_UNCHANGED_FOR_ONE_CONDITIONAL_EXECUTION");
  assert.equal(value.authorizationId, bindings.authorization.authorizationId); assert.equal(value.executorNamespace, NAMESPACE);
  for (const key of ["authorizationSha256", "executorSha256", "testsSha256", "reportSha256", "packageManifestSha256", "executorAuthoritySha256", "executorDetachedChecksumSha256", "correctionV2PackageSha256", "correctionV2AuthoritySha256", "correctionV2DetachedChecksumSha256", "builderManifestSha256", "parserCSha256", "parserHeaderSha256", "grammarJsonSha256", "publishedWasmSha256"]) assert.equal(value.bindings[key], bindings[key]);
  assert.deepEqual(value.scope, bindings.authorization.scope); assert.equal(value.verdict, "ORACLE_APPROVE_UNCHANGED_CONDITIONAL_ONE_SHOT"); return value;
}

function validateFinalAuthorityValue(value, bindings) {
  exactKeys(value, ["schema", "status", "authorizationId", "executorNamespace", "bindings", "scope", "oracleDisposition", "oneShot"], "FINAL_KEYS");
  assert.equal(value.schema, `${NAMESPACE}/final-execution-authority-v1`); assert.equal(value.status, "FINAL_ONE_SHOT_TWO_BUILD_EXECUTION_AUTHORITY");
  assert.equal(value.authorizationId, bindings.authorization.authorizationId); assert.equal(value.executorNamespace, NAMESPACE);
  for (const key of CONSUMPTION_BINDING_KEYS.filter((key) => !["finalAuthoritySha256", "finalDetachedChecksumSha256"].includes(key))) assert.equal(value.bindings[key], bindings[key]);
  assert.deepEqual(value.scope, bindings.authorization.scope); assert.equal(value.oracleDisposition, "ORACLE_FINAL_APPROVE_ONE_CONDITIONAL_EXECUTION");
  assert.deepEqual(value.oneShot, { consumeBeforeFirstDockerCall: true, noRetry: true, noBuildBAfterBuildAFailure: true }); return value;
}

function validateBaseAuthority() {
  assertPathSafe(PACKAGE_ROOT, WORKSPACE, "PACKAGE_PATH_UNSAFE");
  const detached = fs.readFileSync(AUTHORITY_HASH_PATH); const match = /^([a-f0-9]{64})  manifests\/authority-manifest\.json\n$/.exec(detached.toString("utf8"));
  assert.notEqual(match, null); assert.equal(fileRecord(AUTHORITY_PATH).sha256, match[1]);
  const authority = readJson(AUTHORITY_PATH, "AUTHORIZATION_INVALID");
  assert.equal(authority.schema, `${NAMESPACE}/authority-v1`); assert.equal(authority.namespace, NAMESPACE); assert.equal(authority.status, "SEALED_EXECUTOR_REVIEW_REQUIRED_NOT_EXECUTED"); assert.equal(authority.executionAuthorized, false); assert.equal(authority.executionFlag, EXECUTE_FLAG);
  assert.deepEqual(authority.reviewDecision, { expectedPackageRoot: DECISION_PACKAGE_REL, present: false }); assert.deepEqual(authority.finalAuthority, { expectedPackageRoot: FINAL_PACKAGE_REL, present: false });
  for (const record of [authority.packageManifest, authority.report, authority.authorization]) verifyRecord(record);
  const manifest = readJson(PACKAGE_MANIFEST_PATH, "AUTHORIZATION_INVALID"); assert.equal(manifest.schema, `${NAMESPACE}/package-manifest-v1`); assert.equal(manifest.status, authority.status); assert.equal(manifest.executionAuthorized, false);
  assert.equal(manifest.scope.successfulDockerCallsExactly, 17); assert.deepEqual(manifest.consumptionBindingKeys, CONSUMPTION_BINDING_KEYS);
  assert.equal(manifest.correctionV2Records.length, 7); assert.equal(manifest.correctionV2PredecessorRecords.length, 34); assert.equal(manifest.builderInputRecords.length, 5);
  for (const record of [...manifest.successorRecords, ...manifest.correctionV2Records, ...manifest.correctionV2PredecessorRecords, ...manifest.builderInputRecords]) verifyRecord(record);
  const authorization = validateAuthorizationValue(readJson(AUTHORIZATION_PATH, "AUTHORIZATION_INVALID"));
  const bySuffix = (suffix) => manifest.successorRecords.find((record) => record.path.endsWith(suffix));
  const builderBySuffix = (suffix) => manifest.builderInputRecords.find((record) => record.path.endsWith(suffix));
  return { authority, manifest, authorization, authorizationSha256: authority.authorization.sha256, executorSha256: bySuffix("executor-v1.js").sha256,
    testsSha256: bySuffix("executor-v1.js").path.includes("test-") ? bySuffix("executor-v1.js").sha256 : manifest.successorRecords.find((r) => r.path.includes("test-run-")).sha256,
    reportSha256: authority.report.sha256, packageManifestSha256: authority.packageManifest.sha256, executorAuthoritySha256: match[1], executorDetachedChecksumSha256: sha256(detached),
    correctionV2PackageSha256: manifest.correctionV2Records.find((r) => r.path.endsWith("manifests/package-manifest.json")).sha256,
    correctionV2AuthoritySha256: manifest.correctionV2Records.find((r) => r.path.endsWith("manifests/authority-manifest.json")).sha256,
    correctionV2DetachedChecksumSha256: manifest.correctionV2Records.find((r) => r.path.endsWith("manifests/authority-manifest.sha256")).sha256,
    builderManifestSha256: builderBySuffix("builder-manifest.json").sha256, parserCSha256: builderBySuffix("src/parser.c").sha256,
    parserHeaderSha256: builderBySuffix("tree_sitter/parser.h").sha256, grammarJsonSha256: builderBySuffix("src/grammar.json").sha256, publishedWasmSha256: builderBySuffix("tree-sitter-solidity.wasm").sha256 };
}

function loadDecision(bindings) {
  if (![DECISION_PATH, DECISION_AUTHORITY_PATH, DECISION_HASH_PATH].every(fs.existsSync)) throw new Error("REVIEW_DECISION_REQUIRED");
  try {
    for (const file of [DECISION_PATH, DECISION_AUTHORITY_PATH, DECISION_HASH_PATH]) assertPathSafe(file, DECISION_ROOT, "REVIEW_DECISION_INVALID");
    const detached = fs.readFileSync(DECISION_HASH_PATH); const match = /^([a-f0-9]{64})  authority-manifest\.json\n$/.exec(detached.toString("utf8")); assert.notEqual(match, null); assert.equal(fileRecord(DECISION_AUTHORITY_PATH).sha256, match[1]);
    const authority = readJson(DECISION_AUTHORITY_PATH, "REVIEW_DECISION_INVALID"); assert.equal(authority.independentReviewer, "ORACLE");
    exactKeys(authority.decision, ["path", "bytes", "sha256"], "REVIEW_DECISION_INVALID"); assert.equal(authority.decision.path, "review-decision.json"); assert.deepEqual(fileRecord(DECISION_PATH), { bytes: authority.decision.bytes, sha256: authority.decision.sha256 });
    validateDecisionValue(readJson(DECISION_PATH, "REVIEW_DECISION_INVALID"), bindings);
    return { decisionSha256: authority.decision.sha256, decisionAuthoritySha256: match[1], decisionDetachedChecksumSha256: sha256(detached) };
  } catch { throw new Error("REVIEW_DECISION_INVALID"); }
}

function loadFinal(bindings) {
  if (![FINAL_PATH, FINAL_AUTHORITY_PATH, FINAL_HASH_PATH].every(fs.existsSync)) throw new Error("FINAL_EXECUTION_AUTHORITY_REQUIRED");
  try {
    for (const file of [FINAL_PATH, FINAL_AUTHORITY_PATH, FINAL_HASH_PATH]) assertPathSafe(file, FINAL_ROOT, "FINAL_EXECUTION_AUTHORITY_INVALID");
    const detached = fs.readFileSync(FINAL_HASH_PATH); const match = /^([a-f0-9]{64})  authority-manifest\.json\n$/.exec(detached.toString("utf8")); assert.notEqual(match, null); assert.equal(fileRecord(FINAL_AUTHORITY_PATH).sha256, match[1]);
    const authority = readJson(FINAL_AUTHORITY_PATH, "FINAL_EXECUTION_AUTHORITY_INVALID"); assert.equal(authority.oracleFinalReview, "ORACLE_FINAL_APPROVE_ONE_CONDITIONAL_EXECUTION");
    exactKeys(authority.finalAuthority, ["path", "bytes", "sha256"], "FINAL_EXECUTION_AUTHORITY_INVALID"); assert.equal(authority.finalAuthority.path, "final-execution-authority.json"); assert.deepEqual(fileRecord(FINAL_PATH), { bytes: authority.finalAuthority.bytes, sha256: authority.finalAuthority.sha256 });
    validateFinalAuthorityValue(readJson(FINAL_PATH, "FINAL_EXECUTION_AUTHORITY_INVALID"), bindings);
    return { finalAuthoritySha256: authority.finalAuthority.sha256, finalDetachedChecksumSha256: sha256(detached) };
  } catch { throw new Error("FINAL_EXECUTION_AUTHORITY_INVALID"); }
}

function verifyLocalInputs() {
  for (const record of [...SOURCE_RECORDS, GRAMMAR_RECORD, PUBLISHED_RECORD]) verifyRecord(record);
  const grammar = readJson(resolveRecord(GRAMMAR_RECORD), "LOCAL_INPUT_INVALID"); assert.equal(grammar.name, "solidity"); assert.deepEqual(grammar.externals, []);
}

function sanitizedDockerEnv(dockerConfig) {
  for (const key of Object.keys(process.env)) if (["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_AUTH_CONFIG", "REGISTRY_AUTH_FILE", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"].includes(key.toUpperCase())) throw new Error("DOCKER_ENV_REJECTED");
  const env = { DOCKER_CONFIG: dockerConfig }; for (const key of ["PATH", "SystemRoot", "WINDIR", "PATHEXT"]) if (typeof process.env[key] === "string") env[key] = process.env[key]; return env;
}

function writeFileFsync(file, text) { const fd = fs.openSync(file, "wx", 0o600); try { fs.writeSync(fd, text, null, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } assert.equal(fs.readFileSync(file, "utf8"), text, "DURABILITY_NOT_ESTABLISHED"); }
function tryDirectoryFsync(dir) { try { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } return "SUCCEEDED"; } catch { return "UNAVAILABLE_PLATFORM_DEPENDENT"; } }
function writeMarker(runRoot, filename, value) {
  const text = `${JSON.stringify(value)}\n`; const temporary = path.join(runRoot, `${filename}.tmp`); const target = path.join(runRoot, filename);
  writeFileFsync(temporary, text); fs.renameSync(temporary, target); assert.equal(fs.readFileSync(target, "utf8"), text, "DURABILITY_NOT_ESTABLISHED"); return tryDirectoryFsync(runRoot);
}
function stageAndConsume(bindings) {
  verifyLocalInputs();
  if (!fs.existsSync(RUNS_ROOT)) fs.mkdirSync(RUNS_ROOT, { recursive: false }); assertPathSafe(RUNS_ROOT, PACKAGE_ROOT, "RUN_PATH_UNSAFE");
  const runRoot = path.join(RUNS_ROOT, bindings.authorization.authorizationId); if (fs.existsSync(runRoot)) throw new Error("AUTHORIZATION_ALREADY_CONSUMED"); fs.mkdirSync(runRoot, { recursive: false });
  const sourceDir = path.join(runRoot, "source"); const treeDir = path.join(sourceDir, "tree_sitter"); const outA = path.join(runRoot, "out-a"); const outB = path.join(runRoot, "out-b"); const dockerConfig = path.join(runRoot, "docker-config");
  for (const dir of [sourceDir, treeDir, outA, outB, dockerConfig]) fs.mkdirSync(dir, { recursive: false });
  for (const record of SOURCE_RECORDS) { const target = path.join(sourceDir, ...record.stage.split("/")); fs.copyFileSync(resolveRecord(record), target, fs.constants.COPYFILE_EXCL); assert.deepEqual(fileRecord(target), { bytes: record.bytes, sha256: record.sha256 }); }
  writeFileFsync(path.join(dockerConfig, "config.json"), EMPTY_DOCKER_CONFIG);
  assert.deepEqual(fileRecord(resolveRecord(PUBLISHED_RECORD)), { bytes: OUTPUT_BYTES, sha256: OUTPUT_SHA256 }, "PUBLISHED_WASM_CHANGED");
  const marker = { schema: `${NAMESPACE}/authorization-consumed-v1`, authorizationId: bindings.authorization.authorizationId, consumed: true,
    boundedInterpretation: bindings.authorization.boundedInterpretation, bindings: Object.fromEntries(CONSUMPTION_BINDING_KEYS.map((key) => [key, bindings[key]])),
    durability: { exclusiveRunRoot: true, markerFileFsync: true, exactReadback: true, parentDirectoryFsync: "ATTEMPTED_PLATFORM_DEPENDENT_WINDOWS_LIMITATION_ACKNOWLEDGED" },
    counters: { ...ZERO_COUNTERS, authorizationConsumeMarkersWritten: 1 } };
  writeMarker(runRoot, "authorization-consumed.json", marker); return { runRoot, sourceDir, outA, outB, dockerConfig };
}

function openJournal(runRoot) {
  const fd = fs.openSync(path.join(runRoot, "journal.jsonl"), "ax", 0o600); let seq = 0;
  return { append(phase, operation, counters, errorCode) { const row = { seq, phase, operation, counters }; if (errorCode) row.errorCode = errorCode; fs.writeSync(fd, `${JSON.stringify(row)}\n`, null, "utf8"); fs.fsyncSync(fd); seq += 1; }, close() { fs.closeSync(fd); } };
}
function callDocker(operation, argv, context, expectAbsent = false) {
  context.counters.processCalls += 1; const result = childProcess.spawnSync("docker", argv, { shell: false, windowsHide: true, encoding: "utf8", env: context.env, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
  if (!result || (result.error && result.error.code === "ENOBUFS")) throw new Error("OUTPUT_LIMIT_EXCEEDED");
  if (expectAbsent) { if (!result.error && result.status !== 0) return ""; throw new Error("NAME_NOT_ABSENT"); }
  if (result.error || result.status !== 0 || typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES) throw new Error(operation);
  return result.stdout;
}
function validateDaemon(version, info) { try { assert.equal(version.Client.Version, DOCKER_VERSION); assert.equal(version.Server.Version, DOCKER_VERSION); assert.equal(info.ServerVersion, DOCKER_VERSION); assert.equal(String(info.OSType).toLowerCase(), "linux"); assert.equal(["amd64", "x86_64"].includes(String(info.Architecture).toLowerCase()), true); assert.equal(Array.isArray(info.SecurityOptions), true); assert.equal(typeof info.CgroupVersion, "string"); assert.equal(typeof info.NCPU, "number"); assert.equal(typeof info.MemTotal, "number"); } catch { throw new Error("DAEMON_QUALIFICATION_FAILED"); } }
function normalizedHostPath(value) { return path.resolve(value).toLowerCase(); }
function validateCreated(container, spec) {
  try {
    assert.equal(container.Image, CONFIG_DIGEST); assert.equal(canonicalRepo(container.Config.Image), canonicalRepo(IMAGE)); assert.deepEqual(container.Config.Entrypoint, [ENTRYPOINT]); assert.deepEqual(container.Config.Cmd, EMCC_ARGV);
    assert.equal(container.Config.User, "65532:65532"); assert.equal(container.Config.WorkingDir, "/src"); assert.deepEqual({ ...envMap(container.Config.Env) }, { ...envMap(EFFECTIVE_ENV) }); assert.equal(envMap(container.Config.Env).SOURCE_DATE_EPOCH, undefined);
    const host = container.HostConfig; assert.equal(host.ReadonlyRootfs, true); assert.equal(host.NetworkMode, "none"); assert.deepEqual(host.CapDrop, ["ALL"]); assert.equal(["no-new-privileges:true", "no-new-privileges=true"].includes(host.SecurityOpt[0]) && host.SecurityOpt.length === 1, true);
    assert.equal(host.Memory, LIMITS.memory); assert.equal(host.MemorySwap, LIMITS.memorySwap); assert.equal(host.NanoCpus, LIMITS.nanoCpus); assert.equal(host.PidsLimit, LIMITS.pidsLimit); assert.equal(host.IpcMode, "private"); assert.equal(host.CgroupnsMode, "private"); assert.equal(host.Privileged, false); assert.deepEqual(host.Devices || [], []); assert.equal(host.PidMode, ""); assert.equal(host.UTSMode, ""); assert.deepEqual(host.Tmpfs, TMPFS);
    assert.deepEqual(host.Mounts.map((m) => ({ Type: m.Type, Source: normalizedHostPath(m.Source), Target: m.Target, ReadOnly: m.ReadOnly === true })), [
      { Type: "bind", Source: normalizedHostPath(spec.sourceDir), Target: "/src", ReadOnly: true }, { Type: "bind", Source: normalizedHostPath(spec.outputDir), Target: "/out", ReadOnly: false },
    ]); assert.deepEqual(container.Mounts.map((m) => ({ Destination: m.Destination, RW: m.RW === true })), [{ Destination: "/src", RW: false }, { Destination: "/out", RW: true }]);
  } catch { throw new Error("CREATED_CONFIG_INVALID"); }
}
function validateExit(container) { try { assert.equal(container.State.Status, "exited"); assert.equal(container.State.Running, false); assert.equal(container.State.ExitCode, 0); } catch { throw new Error("NONZERO_EXIT"); } }
function verifyOutput(file) { try { const stat = fs.lstatSync(file); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.isFile(), true); assert.equal(stat.size, OUTPUT_BYTES); const record = fileRecord(file); assert.equal(record.sha256, OUTPUT_SHA256); return record; } catch { throw new Error("OUTPUT_INVALID"); } }
function safeErrorCode(error) { return ERROR_CODES.includes(error && error.message) ? error.message : "EXECUTION_FAILED"; }

function executeFixed(bindings) {
  const staged = stageAndConsume(bindings); const plan = buildPlan(staged.dockerConfig, staged.runRoot, bindings.authorization.authorizationId);
  const context = { counters: { ...ZERO_COUNTERS, authorizationConsumeMarkersWritten: 1 }, env: sanitizedDockerEnv(staged.dockerConfig) }; const journal = openJournal(staged.runRoot); const outputs = [];
  function step(operation, requestKey, successKey, argv, errorCode, parse, expectAbsent = false) {
    context.counters[requestKey] += 1; journal.append("before", operation, safeCounters(context));
    let text; try { text = callDocker(errorCode, argv, context, expectAbsent); } catch (error) { throw new Error(error.message === "OUTPUT_LIMIT_EXCEEDED" || error.message === "NAME_NOT_ABSENT" ? error.message : errorCode); }
    context.counters[successKey] += 1; journal.append("after", operation, safeCounters(context)); return parse ? parseJson(text, errorCode) : text;
  }
  function absence(operation, argv, after) { step(operation, "absenceRequests", "absenceObserved", argv, after ? "CLEANUP_ABSENCE_FAILED" : "NAME_NOT_ABSENT", null, true); if (after) context.counters.cleanupAbsenceVerified += 1; }
  function removeAndConfirm(build, requested) {
    let removeError = null;
    if (requested) { try { step(`${build.label.toUpperCase()}_RM_FORCE`, "removeRequests", "removeSuccess", build.removeArgv, "REMOVE_FAILED"); } catch (error) { removeError = error; } }
    try { absence(`${build.label.toUpperCase()}_ABSENCE_AFTER`, build.absenceAfterArgv, true); } catch (error) { if (!removeError) removeError = error; }
    if (removeError) throw removeError;
  }
  try {
    const version = step("VERSION", "versionRequests", "versionSuccess", plan.versionArgv, "DAEMON_QUALIFICATION_FAILED", true);
    const info = step("INFO", "infoRequests", "infoSuccess", plan.infoArgv, "DAEMON_QUALIFICATION_FAILED", true); validateDaemon(version, info);
    const imageRows = step("IMAGE_INSPECT", "imageInspectRequests", "imageInspectSuccess", plan.imageInspectArgv, "IMAGE_INSPECT_INVALID", true); assert.equal(Array.isArray(imageRows) && imageRows.length === 1, true, "IMAGE_INSPECT_INVALID"); validateImageInspectPure(imageRows[0]);
    for (let index = 0; index < plan.builds.length; index += 1) {
      const build = plan.builds[index]; const outputDir = index === 0 ? staged.outA : staged.outB; let createRequested = false; let cleaned = false;
      try {
        absence(`${build.label.toUpperCase()}_ABSENCE_BEFORE`, build.absenceBeforeArgv, false); assert.equal(fs.readdirSync(outputDir).length, 0, "OUTPUT_INVALID");
        for (const record of SOURCE_RECORDS) assert.deepEqual(fileRecord(path.join(staged.sourceDir, ...record.stage.split("/"))), { bytes: record.bytes, sha256: record.sha256 }, "LOCAL_INPUT_INVALID");
        createRequested = true; step(`${build.label.toUpperCase()}_CREATE`, "createRequests", "createSuccess", build.createArgv, "CREATE_FAILED");
        const createdRows = step(`${build.label.toUpperCase()}_CREATED_INSPECT`, "createdInspectRequests", "createdInspectSuccess", build.createdInspectArgv, "CREATED_INSPECT_FAILED", true); assert.equal(Array.isArray(createdRows) && createdRows.length === 1, true, "CREATED_INSPECT_FAILED"); validateCreated(createdRows[0], { sourceDir: staged.sourceDir, outputDir });
        step(`${build.label.toUpperCase()}_START_ATTACH`, "startRequests", "daemonObservedStarts", build.startArgv, "START_FAILED");
        const exitRows = step(`${build.label.toUpperCase()}_EXITED_INSPECT`, "exitInspectRequests", "exitInspectSuccess", build.exitedInspectArgv, "EXIT_INSPECT_FAILED", true); assert.equal(Array.isArray(exitRows) && exitRows.length === 1, true, "EXIT_INSPECT_FAILED"); validateExit(exitRows[0]);
        outputs.push(verifyOutput(path.join(outputDir, OUTPUT_NAME))); context.counters.verifiedBuilds += 1;
        removeAndConfirm(build, true); cleaned = true;
      } catch (error) {
        if (createRequested && !cleaned) { try { removeAndConfirm(build, true); } catch {} }
        if (index === 0) throw new Error("BUILD_A_FAILED_NO_BUILD_B"); throw error;
      }
    }
    assert.deepEqual(outputs, [{ bytes: OUTPUT_BYTES, sha256: OUTPUT_SHA256 }, { bytes: OUTPUT_BYTES, sha256: OUTPUT_SHA256 }], "EQUALITY_FAILED");
    assert.deepEqual(fileRecord(resolveRecord(PUBLISHED_RECORD)), { bytes: OUTPUT_BYTES, sha256: OUTPUT_SHA256 }, "PUBLISHED_WASM_CHANGED");
    assert.deepEqual({ ...safeCounters(context), successMarkerWrites: 1 }, SUCCESS_COUNTERS); context.counters.successMarkerWrites = 1;
    writeMarker(staged.runRoot, "success.json", { schema: `${NAMESPACE}/success-v1`, status: "TWO_BUILDS_EQUAL_PUBLISHED_QUARANTINED", authorizationId: bindings.authorization.authorizationId, counters: safeCounters(context), outputs, published: { bytes: OUTPUT_BYTES, sha256: OUTPUT_SHA256 }, parserPromotion: false, detectorRun: false });
    journal.append("final", "SUCCESS", safeCounters(context)); return { schema: `${NAMESPACE}/cli-result-v1`, status: "TWO_BUILDS_EQUAL_PUBLISHED_QUARANTINED", authorizationId: bindings.authorization.authorizationId, counters: safeCounters(context), outputBytes: OUTPUT_BYTES, outputSha256: OUTPUT_SHA256 };
  } catch (error) {
    const code = safeErrorCode(error); context.counters.failureMarkerWrites = 1;
    try { writeMarker(staged.runRoot, "failure.json", { schema: `${NAMESPACE}/failure-v1`, status: "EXECUTION_FAILED_CONSUMED_OUTPUTS_QUARANTINED", authorizationId: bindings.authorization.authorizationId, errorCode: code, counters: safeCounters(context), partialOutputsQuarantined: true }); journal.append("final", "FAILURE", safeCounters(context), code); } catch {}
    const clean = new Error(code); clean.counters = safeCounters(context); throw clean;
  } finally { journal.close(); }
}

function runDefault() {
  const bindings = validateBaseAuthority(); const plan = buildPlan(); assert.equal(plan.operations.length, 17); assert.equal(plan.builds.length, 2);
  return { schema: `${NAMESPACE}/offline-summary-v1`, status: "PASS", packageStatus: bindings.authority.status, executionAuthorized: false, reviewDecisionPresent: false, finalAuthorityPresent: false, processCalls: 0, writes: 0 };
}
function main(argv) {
  if (argv.length === 0) return runDefault(); if (argv.length !== 1 || argv[0] !== EXECUTE_FLAG) throw new Error("ARGUMENTS_REJECTED");
  const base = validateBaseAuthority(); const decision = loadDecision(base); const combined = { ...base, ...decision }; const final = loadFinal(combined); return executeFixed({ ...combined, ...final });
}
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ status: "FAIL", errorCode: safeErrorCode(error), counters: error && error.counters ? error.counters : { processCalls: 0 }, writes: 0 })}\n`); process.exitCode = 1; }
}

module.exports = Object.freeze({ NAMESPACE, EXECUTE_FLAG, ENDPOINT, IMAGE, OUTPUT_BYTES, OUTPUT_SHA256, EMCC_ARGV, ZERO_COUNTERS, SUCCESS_COUNTERS, CONSUMPTION_BINDING_KEYS, buildPlan, simulatePlan, validateAuthorizationValue, validateDecisionValue, validateFinalAuthorityValue, validateImageInspectPure });
