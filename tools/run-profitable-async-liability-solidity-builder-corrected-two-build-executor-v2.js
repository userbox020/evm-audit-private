#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const WORKSPACE = path.resolve(__dirname, "..");
const NAMESPACE = "profitable-async-liability-solidity-builder-corrected-two-build-executor-v2";
const PACKAGE_REL = `tools/vendor/${NAMESPACE}`;
const PACKAGE_ROOT = path.join(WORKSPACE, ...PACKAGE_REL.split("/"));
const AUTHORIZATION_PATH = path.join(PACKAGE_ROOT, "authorization", "current-turn-authorization.json");
const PACKAGE_MANIFEST_PATH = path.join(PACKAGE_ROOT, "manifests", "package-manifest.json");
const AUTHORITY_PATH = path.join(PACKAGE_ROOT, "manifests", "authority-manifest.json");
const AUTHORITY_HASH_PATH = path.join(PACKAGE_ROOT, "manifests", "authority-manifest.sha256");
const RUNS_ROOT = path.join(PACKAGE_ROOT, "runs");
const DECISION_PACKAGE_REL = "tools/vendor/profitable-async-liability-solidity-builder-corrected-two-build-executor-v2-review-decision";
const DECISION_ROOT = path.join(WORKSPACE, ...DECISION_PACKAGE_REL.split("/"));
const DECISION_PATH = path.join(DECISION_ROOT, "review-decision.json");
const DECISION_AUTHORITY_PATH = path.join(DECISION_ROOT, "authority-manifest.json");
const DECISION_HASH_PATH = path.join(DECISION_ROOT, "authority-manifest.sha256");
const FINAL_PACKAGE_REL = "tools/vendor/profitable-async-liability-solidity-builder-corrected-two-build-executor-v2-final-authority";
const FINAL_ROOT = path.join(WORKSPACE, ...FINAL_PACKAGE_REL.split("/"));
const FINAL_PATH = path.join(FINAL_ROOT, "final-execution-authority.json");
const FINAL_AUTHORITY_PATH = path.join(FINAL_ROOT, "authority-manifest.json");
const FINAL_HASH_PATH = path.join(FINAL_ROOT, "authority-manifest.sha256");
const CORRECTION_REL = "tools/validate-profitable-async-liability-solidity-builder-image-inspect-correction-v2.js";
const correction = require(path.join(WORKSPACE, ...CORRECTION_REL.split("/")));

const EXECUTE_FLAG = "--execute-reviewed-corrected-two-build-executor-v2";
const ENDPOINT = "npipe:////./pipe/docker_engine";
const DOCKER_VERSION = "29.6.1";
const IMAGE = "docker.io/emscripten/emsdk@sha256:47d573d5a86379a06f850de200d69407e6baa2d2f9c19d9e156a67db57f80f2f";
const CONFIG_DIGEST = "sha256:a411b47f58dbac78da4f2ea974e6bdbb4cd0598d6de7d8166903cdb34d6ecc9e";
const OUTPUT_NAME = "tree-sitter-solidity.wasm";
const OUTPUT_BYTES = 508582;
const OUTPUT_SHA256 = "07420813d7668445152a5d5d2017e0fb84cb27342257e1add3cc7462eec7f811";
const ADMIN_TIMEOUT_MS = 30000;
const BUILD_TIMEOUT_MS = 1800000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_CALLS = 17;
const EMPTY_DOCKER_CONFIG = '{"auths":{}}';
const ENTRYPOINT = "/emsdk/upstream/emscripten/emcc";
const ZERO_TIME = "0001-01-01T00:00:00Z";
const EMCC_ARGV = Object.freeze([
  "-o", "/out/tree-sitter-solidity.wasm", "-Os", "-s", "WASM=1", "-s", "SIDE_MODULE=2",
  "-s", "TOTAL_MEMORY=33554432", "-s", "NODEJS_CATCH_EXIT=0", "-s",
  "EXPORTED_FUNCTIONS=[\"_tree_sitter_solidity\"]", "-fno-exceptions", "-fvisibility=hidden", "-I", ".", "parser.c",
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
const OPERATION_ORDER = Object.freeze([
  "VERSION", "INFO", "IMAGE_INSPECT",
  "A_ABSENCE_BEFORE", "A_CREATE", "A_CREATED_INSPECT", "A_START_ATTACH", "A_EXITED_INSPECT", "A_RM_FORCE", "A_ABSENCE_AFTER",
  "B_ABSENCE_BEFORE", "B_CREATE", "B_CREATED_INSPECT", "B_START_ATTACH", "B_EXITED_INSPECT", "B_RM_FORCE", "B_ABSENCE_AFTER",
]);
const COUNTER_KEYS = Object.freeze([
  "processCalls", "versionRequests", "versionSuccess", "infoRequests", "infoSuccess", "imageInspectRequests", "imageInspectSuccess",
  "absenceRequests", "absenceObserved", "createRequests", "createSuccess", "createdInspectRequests", "createdInspectSuccess",
  "startRequests", "startAttachSuccess", "daemonObservedStarts", "exitInspectRequests", "exitInspectSuccess", "verifiedBuilds",
  "removeRequests", "removeSuccess", "cleanupAbsenceVerified", "authorizationConsumeMarkersWritten", "successMarkerWrites", "failureMarkerWrites",
]);
const ZERO_COUNTERS = Object.freeze(Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0])));
const SUCCESS_COUNTERS_BEFORE_COMMIT = Object.freeze({
  processCalls: 17, versionRequests: 1, versionSuccess: 1, infoRequests: 1, infoSuccess: 1,
  imageInspectRequests: 1, imageInspectSuccess: 1, absenceRequests: 4, absenceObserved: 4,
  createRequests: 2, createSuccess: 2, createdInspectRequests: 2, createdInspectSuccess: 2,
  startRequests: 2, startAttachSuccess: 2, daemonObservedStarts: 2, exitInspectRequests: 2, exitInspectSuccess: 2,
  verifiedBuilds: 2, removeRequests: 2, removeSuccess: 2, cleanupAbsenceVerified: 2,
  authorizationConsumeMarkersWritten: 1, successMarkerWrites: 0, failureMarkerWrites: 0,
});
const ERROR_CODES = Object.freeze([
  "REVIEW_DECISION_REQUIRED", "REVIEW_DECISION_INVALID", "FINAL_EXECUTION_AUTHORITY_REQUIRED", "FINAL_EXECUTION_AUTHORITY_INVALID",
  "ARGUMENTS_REJECTED", "AUTHORIZATION_INVALID", "AUTHORIZATION_ALREADY_CONSUMED", "PACKAGE_PATH_UNSAFE", "RUN_PATH_UNSAFE",
  "DURABILITY_NOT_ESTABLISHED", "DOCKER_ENV_REJECTED", "LOCAL_INPUT_INVALID", "CALL_BUDGET_EXCEEDED", "OPERATION_REPEATED",
  "OPERATION_ORDER_INVALID", "DAEMON_QUALIFICATION_FAILED", "IMAGE_INSPECT_INVALID", "ABSENCE_CLASSIFICATION_FAILED",
  "NAME_NOT_ABSENT", "CREATE_FAILED", "CREATE_ID_INVALID", "CREATED_INSPECT_FAILED", "CREATED_CONFIG_INVALID", "START_FAILED",
  "EXIT_INSPECT_FAILED", "EXIT_EVIDENCE_INVALID", "OUTPUT_INVALID", "REMOVE_FAILED", "CLEANUP_ABSENCE_FAILED",
  "BUILD_A_FAILED_NO_BUILD_B", "EQUALITY_FAILED", "PUBLISHED_WASM_CHANGED", "OUTPUT_LIMIT_EXCEEDED", "EXECUTION_FAILED",
]);
const CONSUMPTION_BINDING_KEYS = Object.freeze([
  "authorizationSha256", "executorSha256", "testsSha256", "reportSha256", "packageManifestSha256", "executorAuthoritySha256",
  "executorDetachedChecksumSha256", "rejectedV1ExecutorSha256", "rejectedV1PackageSha256", "rejectedV1AuthoritySha256",
  "correctionV2PackageSha256", "correctionV2AuthoritySha256", "correctionV2DetachedChecksumSha256", "builderManifestSha256",
  "parserCSha256", "parserHeaderSha256", "grammarJsonSha256", "publishedWasmSha256", "decisionSha256", "decisionAuthoritySha256",
  "decisionDetachedChecksumSha256", "finalAuthoritySha256", "finalDetachedChecksumSha256",
]);

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fileRecord(file) { const bytes = fs.readFileSync(file); return { bytes: bytes.length, sha256: sha256(bytes) }; }
function exactKeys(value, keys, code) { assert.equal(value && typeof value === "object" && !Array.isArray(value), true, code); assert.deepEqual(Object.keys(value), keys, code); }
function parseJson(text, code) { try { return JSON.parse(text); } catch { throw new Error(code); } }
function readJson(file, code) { return parseJson(fs.readFileSync(file, "utf8"), code); }
function contained(target, root) { const relative = path.relative(path.resolve(root), path.resolve(target)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function resolveRecord(record) {
  exactKeys(record, ["path", "bytes", "sha256"], "RECORD_KEYS"); assert.match(record.path, /^[a-zA-Z0-9._/-]+$/);
  assert.equal(Number.isSafeInteger(record.bytes) && record.bytes >= 0, true, "RECORD_BYTES"); assert.match(record.sha256, /^[a-f0-9]{64}$/);
  const file = path.resolve(WORKSPACE, ...record.path.split("/")); assert.equal(contained(file, WORKSPACE), true, "RECORD_OUTSIDE_WORKSPACE"); return file;
}
function assertPathSafe(target, root, code, mustExist = true) {
  const absoluteRoot = path.resolve(root); const absolute = path.resolve(target); assert.equal(contained(absolute, absoluteRoot), true, code);
  assert.equal(fs.existsSync(absoluteRoot), true, code); let cursor = absoluteRoot;
  const rootStat = fs.lstatSync(cursor); assert.equal(rootStat.isSymbolicLink(), false, code);
  const rootReal = fs.realpathSync.native ? fs.realpathSync.native(cursor) : fs.realpathSync(cursor); assert.equal(path.resolve(rootReal), cursor, code);
  for (const part of path.relative(absoluteRoot, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part); if (!fs.existsSync(cursor)) { assert.equal(mustExist, false, code); return; }
    const stat = fs.lstatSync(cursor); assert.equal(stat.isSymbolicLink(), false, code);
    const real = fs.realpathSync.native ? fs.realpathSync.native(cursor) : fs.realpathSync(cursor);
    assert.equal(path.resolve(real), path.resolve(cursor), code); assert.equal(contained(real, absoluteRoot), true, code);
  }
}
function verifyRecord(record) { const file = resolveRecord(record); assertPathSafe(file, WORKSPACE, "PACKAGE_PATH_UNSAFE"); assert.deepEqual(fileRecord(file), { bytes: record.bytes, sha256: record.sha256 }, `SEAL_MISMATCH:${record.path}`); }
function safeCounters(context) { return Object.fromEntries(COUNTER_KEYS.map((key) => [key, context.counters[key]])); }
function envMap(values) { const output = Object.create(null); for (const entry of values) { const at = entry.indexOf("="); assert.equal(at > 0, true); const key = entry.slice(0, at); assert.equal(Object.hasOwn(output, key), false); output[key] = entry.slice(at + 1); } return output; }
function canonicalRepo(value) { let normalized = String(value).toLowerCase(); for (const prefix of ["docker.io/", "index.docker.io/"]) if (normalized.startsWith(prefix)) normalized = normalized.slice(prefix.length); return normalized; }
function containerLabels(authorizationId, label) { return Object.freeze({ "pal.authorization": authorizationId, "pal.executor": NAMESPACE, "pal.build": label }); }

function validateAuthorizationValue(value) {
  exactKeys(value, ["schema", "status", "authorizationId", "authorizedAtUtc", "authorizationBasis", "boundedInterpretation", "executorNamespace", "soleFlag", "scope", "consumption", "review"], "AUTHORIZATION_KEYS");
  assert.equal(value.schema, `${NAMESPACE}/current-turn-authorization-v1`); assert.equal(value.status, "USER_AUTHORIZED_CREATE_REVIEW_AND_CONDITIONAL_ONE_SHOT_TWO_BUILD_EXECUTION");
  assert.match(value.authorizationId, /^[a-f0-9]{32}$/); assert.equal(value.authorizedAtUtc, "2026-08-12T00:00:00Z");
  assert.deepEqual(value.authorizationBasis, {
    immediatelyPrecedingBoundedSentence: "Any future build requires fresh current-turn authorization and a distinct independently reviewed successor binding correction-v2; the consumed diagnostic authorization cannot be reused. No live protocol actions, signing, or detector execution are authorized.",
    userAcceptance: "please",
    interpretationRule: "THE_EXPLICIT_BOUNDED_SENTENCE_PLUS_THE_USERS_PLEASE_AS_ACCEPTANCE_NOT_BARE_PLEASE_ALONE",
  });
  assert.equal(value.boundedInterpretation, "The immediately preceding explicit bounded sentence required fresh current-turn authorization for a distinct reviewed two-container build successor binding correction-v2 and excluded live protocol actions, signing, and detector execution. The user's 'please' accepted that exact bounded proposal. Bare 'please' alone is not claimed as authorization and nothing broader is authorized.");
  assert.equal(value.executorNamespace, NAMESPACE); assert.equal(value.soleFlag, EXECUTE_FLAG);
  assert.deepEqual(value.scope, {
    cachedExactDigestImageOnly: IMAGE, endpoint: ENDPOINT, dockerVersion: DOCKER_VERSION, hardMaximumDockerCallsAllPaths: 17,
    successfulDockerCallsExactly: 17, successfulCallCounts: { version: 1, info: 1, imageInspect: 1, exactAbsenceChecks: 4, create: 2, createdInspect: 2, startAttach: 2, exitedInspect: 2, rmForce: 2 },
    startsExactly: 2, buildsExactly: 2, sequential: "A_REMOVED_AND_ID_ABSENT_BEFORE_B", noBuildBAfterBuildAFailure: true,
    forbidden: ["PULL", "TAG", "LOGIN", "FALLBACK", "INVENTORY", "ALTERNATE_ENDPOINT", "LIVE_PROTOCOL_ACTION", "SIGNING", "PARSER_PROMOTION", "DETECTOR_RUN", "RETRY"],
  });
  assert.deepEqual(value.consumption, { packageLocalRunRoot: true, beforeFirstDockerCall: true, oneShotNoReuseOnAnyOutcome: true, bindsRejectedV1AndCorrectionV2: true });
  assert.deepEqual(value.review, { independentDecisionRequired: true, selfApprovalForbidden: true, distinctDecisionPackage: DECISION_PACKAGE_REL, distinctFinalAuthorityPackage: FINAL_PACKAGE_REL }); return value;
}

function createArgs(config, name, sourceDir, outputDir, authorizationId, label) {
  const base = ["--config", config, "--host", ENDPOINT]; const labels = containerLabels(authorizationId, label);
  const argv = [...base, "create", "--name", name, "--platform", "linux/amd64", "--pull", "never", "--network", "none", "--read-only",
    "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--memory", String(LIMITS.memory),
    "--memory-swap", String(LIMITS.memorySwap), "--cpus", "2", "--pids-limit", String(LIMITS.pidsLimit), "--ipc", "private", "--cgroupns", "private",
    "--workdir", "/src", "--entrypoint", ENTRYPOINT];
  for (const [key, value] of Object.entries(labels)) argv.push("--label", `${key}=${value}`);
  for (const value of EXPLICIT_ENV) argv.push("--env", value);
  argv.push("--mount", `type=bind,src=${sourceDir},dst=/src,readonly`, "--mount", `type=bind,src=${outputDir},dst=/out`,
    "--tmpfs", `/tmp:${TMPFS["/tmp"]}`, "--tmpfs", `/home/nonroot:${TMPFS["/home/nonroot"]}`, "--tmpfs", `/cache:${TMPFS["/cache"]}`, IMAGE, ...EMCC_ARGV); return argv;
}

function buildPlan(config = "<DEDICATED_EMPTY_DOCKER_CONFIG>", root = "<FIXED_PACKAGE_LOCAL_RUN_ROOT>", authorizationId = "0".repeat(32)) {
  assert.match(authorizationId, /^[a-f0-9]{32}$/); const base = ["--config", config, "--host", ENDPOINT]; const sourceDir = path.join(root, "source");
  const builds = ["a", "b"].map((label) => { const upper = label.toUpperCase(); const name = `pal-corrected-v2-${authorizationId}-${label}`; const outputDir = path.join(root, `out-${label}`); return {
    label, upper, name, outputDir, labels: containerLabels(authorizationId, label), absenceBeforeArgv: [...base, "container", "inspect", "--format", "{{.Id}}", name],
    createArgv: createArgs(config, name, sourceDir, outputDir, authorizationId, label), createdInspectById(id) { return [...base, "container", "inspect", id]; },
    startById(id) { return [...base, "start", "--attach", id]; }, exitedInspectById(id) { return [...base, "container", "inspect", id]; },
    removeById(id) { return [...base, "rm", "--force", id]; }, absenceAfterById(id) { return [...base, "container", "inspect", "--format", "{{.Id}}", id]; },
  }; });
  return { shell: false, maxCalls: MAX_CALLS, adminTimeoutMs: ADMIN_TIMEOUT_MS, buildTimeoutMs: BUILD_TIMEOUT_MS, operationOrder: [...OPERATION_ORDER], sourceDir,
    versionArgv: [...base, "version", "--format", "{{json .}}"], infoArgv: [...base, "info", "--format", "{{json .}}"], imageInspectArgv: [...base, "image", "inspect", IMAGE], builds };
}

function classifyExactAbsence(result, reference) {
  assert.equal(result && typeof result === "object", true, "ABSENCE_CLASSIFICATION_FAILED");
  assert.equal(Number.isInteger(result.status), true, "ABSENCE_CLASSIFICATION_FAILED"); assert.equal(result.status, 1, "NAME_NOT_ABSENT");
  assert.equal(result.signal === null || result.signal === undefined, true, "ABSENCE_CLASSIFICATION_FAILED"); assert.equal(result.error === null || result.error === undefined, true, "ABSENCE_CLASSIFICATION_FAILED");
  assert.equal(result.stdout, "", "ABSENCE_CLASSIFICATION_FAILED"); assert.equal(result.stderr, `Error: No such container: ${reference}\n`, "ABSENCE_CLASSIFICATION_FAILED"); return true;
}
function parseCreateId(result) {
  assert.equal(result && result.status === 0 && !result.error && (result.signal === null || result.signal === undefined), true, "CREATE_FAILED");
  assert.equal(result.stderr, "", "CREATE_FAILED"); assert.match(result.stdout, /^[a-f0-9]{64}\n$/, "CREATE_ID_INVALID"); return result.stdout.slice(0, 64);
}
function validateImageInspectPure(value, runId = "0".repeat(32)) {
  const result = correction.compareCorrectedInspect(value, { source: "DOCKER_IMAGE_INSPECT_MEMORY_ONLY", runId }); assert.equal(result.summary.fieldsCompared, 9); assert.equal(result.summary.fieldsMismatched, 0, "IMAGE_INSPECT_INVALID"); return result;
}
function parseTimestamp(value, code) { assert.equal(typeof value, "string", code); const time = Date.parse(value); assert.equal(Number.isFinite(time), true, code); return time; }
function validateCreatedInspect(container, spec, id) {
  try {
    assert.equal(container.Id, id); assert.equal(container.Name, `/${spec.name}`); assert.deepEqual(container.Config.Labels, spec.labels);
    assert.equal(container.Image, CONFIG_DIGEST); assert.equal(canonicalRepo(container.Config.Image), canonicalRepo(IMAGE)); assert.deepEqual(container.Config.Entrypoint, [ENTRYPOINT]); assert.deepEqual(container.Config.Cmd, EMCC_ARGV);
    assert.equal(container.Config.User, "65532:65532"); assert.equal(container.Config.WorkingDir, "/src"); assert.deepEqual({ ...envMap(container.Config.Env) }, { ...envMap(EFFECTIVE_ENV) }); assert.equal(envMap(container.Config.Env).SOURCE_DATE_EPOCH, undefined);
    assert.equal(container.State.Status, "created"); assert.equal(container.State.Running, false); assert.equal(container.State.StartedAt, ZERO_TIME);
    const host = container.HostConfig; assert.equal(host.ReadonlyRootfs, true); assert.equal(host.NetworkMode, "none"); assert.deepEqual(host.CapDrop, ["ALL"]); assert.deepEqual(host.SecurityOpt, ["no-new-privileges:true"]);
    assert.equal(host.Memory, LIMITS.memory); assert.equal(host.MemorySwap, LIMITS.memorySwap); assert.equal(host.NanoCpus, LIMITS.nanoCpus); assert.equal(host.PidsLimit, LIMITS.pidsLimit); assert.equal(host.IpcMode, "private"); assert.equal(host.CgroupnsMode, "private"); assert.equal(host.Privileged, false); assert.deepEqual(host.Devices || [], []); assert.equal(host.PidMode, ""); assert.equal(host.UTSMode, ""); assert.deepEqual(host.Tmpfs, TMPFS);
    assert.deepEqual(host.Mounts.map((m) => ({ Type: m.Type, Source: path.resolve(m.Source).toLowerCase(), Target: m.Target, ReadOnly: m.ReadOnly === true })), [
      { Type: "bind", Source: path.resolve(spec.sourceDir).toLowerCase(), Target: "/src", ReadOnly: true }, { Type: "bind", Source: path.resolve(spec.outputDir).toLowerCase(), Target: "/out", ReadOnly: false },
    ]); assert.deepEqual(container.Mounts.map((m) => ({ Destination: m.Destination, RW: m.RW === true })), [{ Destination: "/src", RW: false }, { Destination: "/out", RW: true }]);
  } catch { throw new Error("CREATED_CONFIG_INVALID"); }
}
function validateExitedInspect(container, spec, id) {
  try {
    assert.equal(container.Id, id); assert.equal(container.Name, `/${spec.name}`); assert.deepEqual(container.Config.Labels, spec.labels); assert.equal(container.State.Running, false); assert.equal(container.State.Status, "exited"); assert.equal(container.State.ExitCode, 0);
    assert.notEqual(container.State.StartedAt, ZERO_TIME); assert.notEqual(container.State.FinishedAt, ZERO_TIME); const started = parseTimestamp(container.State.StartedAt, "EXIT_EVIDENCE_INVALID"); const finished = parseTimestamp(container.State.FinishedAt, "EXIT_EVIDENCE_INVALID"); assert.equal(finished >= started, true);
  } catch { throw new Error("EXIT_EVIDENCE_INVALID"); }
}

function counterKeysFor(operation) {
  if (operation === "VERSION") return ["versionRequests", "versionSuccess"]; if (operation === "INFO") return ["infoRequests", "infoSuccess"]; if (operation === "IMAGE_INSPECT") return ["imageInspectRequests", "imageInspectSuccess"];
  if (operation.endsWith("ABSENCE_BEFORE") || operation.endsWith("ABSENCE_AFTER")) return ["absenceRequests", "absenceObserved"];
  if (operation.endsWith("CREATE")) return ["createRequests", "createSuccess"]; if (operation.endsWith("CREATED_INSPECT")) return ["createdInspectRequests", "createdInspectSuccess"];
  if (operation.endsWith("START_ATTACH")) return ["startRequests", "startAttachSuccess"]; if (operation.endsWith("EXITED_INSPECT")) return ["exitInspectRequests", "exitInspectSuccess"];
  if (operation.endsWith("RM_FORCE")) return ["removeRequests", "removeSuccess"]; throw new Error("OPERATION_ORDER_INVALID");
}
function makeCallGuard(context) {
  return function guardedCall(operation, argv, timeoutMs) {
    assert.equal(OPERATION_ORDER.includes(operation), true, "OPERATION_ORDER_INVALID"); assert.equal(context.attempted[operation], false, "OPERATION_REPEATED");
    assert.equal(context.counters.processCalls < MAX_CALLS, true, "CALL_BUDGET_EXCEEDED"); assert.equal(timeoutMs, operation.endsWith("START_ATTACH") ? BUILD_TIMEOUT_MS : ADMIN_TIMEOUT_MS, "OPERATION_ORDER_INVALID");
    context.attempted[operation] = true; const [request] = counterKeysFor(operation); context.counters[request] += 1; context.counters.processCalls += 1;
    context.journal("before", operation, safeCounters(context)); return context.io.docker(operation, argv, timeoutMs);
  };
}
function finishCall(context, operation) { const [, success] = counterKeysFor(operation); context.counters[success] += 1; context.journal("after", operation, safeCounters(context)); }
function requireSuccessResult(result, code) {
  if (!result || !Number.isInteger(result.status) || result.status !== 0 || result.error || !(result.signal === null || result.signal === undefined)) throw new Error(code);
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string" || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT_BYTES) throw new Error("OUTPUT_LIMIT_EXCEEDED"); return result;
}

function runWorkflow(io, authorizationId) {
  const plan = buildPlan(io.configToken, io.runToken, authorizationId); const context = { io, counters: { ...ZERO_COUNTERS, authorizationConsumeMarkersWritten: 1 }, attempted: Object.fromEntries(OPERATION_ORDER.map((key) => [key, false])), journal: io.journal };
  const call = makeCallGuard(context); const built = []; let active = null;
  function successJson(operation, argv, code, timeout = ADMIN_TIMEOUT_MS) { const result = requireSuccessResult(call(operation, argv, timeout), code); finishCall(context, operation); return parseJson(result.stdout, code); }
  function absence(operation, argv, reference, after) { const result = call(operation, argv, ADMIN_TIMEOUT_MS); classifyExactAbsence(result, reference); finishCall(context, operation); if (after) context.counters.cleanupAbsenceVerified += 1; }
  function cleanup(spec) {
    if (!active || active.cleaned) return;
    if (active.id && !context.attempted[`${spec.upper}_RM_FORCE`]) { const operation = `${spec.upper}_RM_FORCE`; requireSuccessResult(call(operation, spec.removeById(active.id), ADMIN_TIMEOUT_MS), "REMOVE_FAILED"); finishCall(context, operation); }
    if (active.id && !context.attempted[`${spec.upper}_ABSENCE_AFTER`]) absence(`${spec.upper}_ABSENCE_AFTER`, spec.absenceAfterById(active.id), active.id, true);
    active.cleaned = true;
  }
  try {
    const version = successJson("VERSION", plan.versionArgv, "DAEMON_QUALIFICATION_FAILED"); const info = successJson("INFO", plan.infoArgv, "DAEMON_QUALIFICATION_FAILED"); io.validateDaemon(version, info);
    const imageRows = successJson("IMAGE_INSPECT", plan.imageInspectArgv, "IMAGE_INSPECT_INVALID"); assert.equal(Array.isArray(imageRows) && imageRows.length === 1, true, "IMAGE_INSPECT_INVALID"); validateImageInspectPure(imageRows[0], authorizationId);
    for (let index = 0; index < plan.builds.length; index += 1) {
      const spec = plan.builds[index]; active = { spec, id: null, cleaned: false };
      try {
        io.validateMountPaths(spec.label, "AFTER_CREATION"); io.validateSourceExact(); io.validateOutputEmpty(spec.label);
        absence(`${spec.upper}_ABSENCE_BEFORE`, spec.absenceBeforeArgv, spec.name, false);
        io.validateMountPaths(spec.label, "IMMEDIATELY_BEFORE_MOUNT"); io.validateSourceExact(); io.validateOutputEmpty(spec.label);
        const createOperation = `${spec.upper}_CREATE`; const createResult = call(createOperation, spec.createArgv, ADMIN_TIMEOUT_MS); active.id = parseCreateId(createResult); finishCall(context, createOperation);
        const createdRows = successJson(`${spec.upper}_CREATED_INSPECT`, spec.createdInspectById(active.id), "CREATED_INSPECT_FAILED"); assert.equal(Array.isArray(createdRows) && createdRows.length === 1, true, "CREATED_INSPECT_FAILED"); validateCreatedInspect(createdRows[0], { ...spec, sourceDir: plan.sourceDir }, active.id);
        const startOperation = `${spec.upper}_START_ATTACH`; requireSuccessResult(call(startOperation, spec.startById(active.id), BUILD_TIMEOUT_MS), "START_FAILED"); finishCall(context, startOperation);
        const exitedRows = successJson(`${spec.upper}_EXITED_INSPECT`, spec.exitedInspectById(active.id), "EXIT_INSPECT_FAILED"); assert.equal(Array.isArray(exitedRows) && exitedRows.length === 1, true, "EXIT_INSPECT_FAILED"); validateExitedInspect(exitedRows[0], spec, active.id); context.counters.daemonObservedStarts += 1;
        built.push(io.validateOutputExact(spec.label)); context.counters.verifiedBuilds += 1; cleanup(spec); io.validateOutputExact(spec.label); active = null;
      } catch (error) {
        try { cleanup(spec); } catch (cleanupError) { throw cleanupError; }
        if (index === 0) throw new Error("BUILD_A_FAILED_NO_BUILD_B"); throw error;
      }
    }
    io.validateSourceExact(); io.validateFinalPaths(); const finalA = io.validateOutputExact("a"); const finalB = io.validateOutputExact("b"); const published = io.validatePublishedExact();
    assert.deepEqual([finalA, finalB, published], [{ bytes: OUTPUT_BYTES, sha256: OUTPUT_SHA256 }, { bytes: OUTPUT_BYTES, sha256: OUTPUT_SHA256 }, { bytes: OUTPUT_BYTES, sha256: OUTPUT_SHA256 }], "EQUALITY_FAILED");
    assert.deepEqual(built, [finalA, finalB], "EQUALITY_FAILED"); assert.deepEqual(safeCounters(context), SUCCESS_COUNTERS_BEFORE_COMMIT); return { status: "WORKFLOW_SUCCESS_READY_TO_COMMIT", counters: safeCounters(context), outputs: [finalA, finalB], attempted: { ...context.attempted } };
  } catch (error) { error.counters = safeCounters(context); error.attempted = { ...context.attempted }; throw error; }
}

function validateDecisionValue(value, bindings) {
  exactKeys(value, ["schema", "status", "authorizationId", "executorNamespace", "bindings", "scope", "verdict"], "DECISION_KEYS"); assert.equal(value.schema, `${NAMESPACE}/review-decision-v1`); assert.equal(value.status, "APPROVED_UNCHANGED_FOR_ONE_CONDITIONAL_EXECUTION"); assert.equal(value.authorizationId, bindings.authorization.authorizationId); assert.equal(value.executorNamespace, NAMESPACE);
  const baseKeys = CONSUMPTION_BINDING_KEYS.slice(0, CONSUMPTION_BINDING_KEYS.indexOf("decisionSha256")); exactKeys(value.bindings, baseKeys, "DECISION_BINDING_KEYS"); for (const key of baseKeys) assert.equal(value.bindings[key], bindings[key]);
  assert.deepEqual(value.scope, bindings.authorization.scope); assert.equal(value.verdict, "ORACLE_APPROVE_UNCHANGED_CONDITIONAL_ONE_SHOT"); return value;
}
function validateFinalAuthorityValue(value, bindings) {
  exactKeys(value, ["schema", "status", "authorizationId", "executorNamespace", "bindings", "scope", "oracleDisposition", "oneShot"], "FINAL_KEYS"); assert.equal(value.schema, `${NAMESPACE}/final-execution-authority-v1`); assert.equal(value.status, "FINAL_ONE_SHOT_TWO_BUILD_EXECUTION_AUTHORITY"); assert.equal(value.authorizationId, bindings.authorization.authorizationId); assert.equal(value.executorNamespace, NAMESPACE);
  const keys = CONSUMPTION_BINDING_KEYS.filter((key) => !["finalAuthoritySha256", "finalDetachedChecksumSha256"].includes(key)); exactKeys(value.bindings, keys, "FINAL_BINDING_KEYS"); for (const key of keys) assert.equal(value.bindings[key], bindings[key]);
  assert.deepEqual(value.scope, bindings.authorization.scope); assert.equal(value.oracleDisposition, "ORACLE_FINAL_APPROVE_ONE_CONDITIONAL_EXECUTION"); assert.deepEqual(value.oneShot, { consumeBeforeFirstDockerCall: true, noRetry: true, hardMaximumCallsAllPaths: 17, noBuildBAfterBuildAFailure: true }); return value;
}

function validateBaseAuthority() {
  assertPathSafe(PACKAGE_ROOT, WORKSPACE, "PACKAGE_PATH_UNSAFE"); const detached = fs.readFileSync(AUTHORITY_HASH_PATH); const match = /^([a-f0-9]{64})  manifests\/authority-manifest\.json\n$/.exec(detached.toString("utf8")); assert.notEqual(match, null); assert.equal(fileRecord(AUTHORITY_PATH).sha256, match[1]);
  const authority = readJson(AUTHORITY_PATH, "AUTHORIZATION_INVALID"); exactKeys(authority, ["schema", "namespace", "status", "executionAuthorized", "executionFlag", "packageManifest", "report", "authorization", "reviewDecision", "finalAuthority", "claims", "detachedChecksumRole"], "AUTHORITY_KEYS");
  assert.equal(authority.schema, `${NAMESPACE}/authority-v1`); assert.equal(authority.namespace, NAMESPACE); assert.equal(authority.status, "SEALED_EXECUTOR_REVIEW_REQUIRED_NOT_EXECUTED"); assert.equal(authority.executionAuthorized, false); assert.equal(authority.executionFlag, EXECUTE_FLAG);
  assert.deepEqual(authority.reviewDecision, { expectedPackageRoot: DECISION_PACKAGE_REL, present: false }); assert.deepEqual(authority.finalAuthority, { expectedPackageRoot: FINAL_PACKAGE_REL, present: false }); assert.deepEqual(authority.claims, { cachedImage: false, execution: false, equality: false, reproducibility: false, build: false, parserPromotion: false, detectorRun: false });
  for (const record of [authority.packageManifest, authority.report, authority.authorization]) verifyRecord(record);
  const manifest = readJson(PACKAGE_MANIFEST_PATH, "AUTHORIZATION_INVALID"); assert.equal(manifest.schema, `${NAMESPACE}/package-manifest-v1`); assert.equal(manifest.status, authority.status); assert.equal(manifest.executionAuthorized, false); assert.equal(manifest.scope.hardMaximumDockerCallsAllPaths, 17); assert.deepEqual(manifest.consumptionBindingKeys, CONSUMPTION_BINDING_KEYS);
  assert.equal(manifest.rejectedV1Records.length, 7); assert.equal(manifest.correctionV2Records.length, 7); assert.equal(manifest.correctionV2PredecessorRecords.length, 34); assert.equal(manifest.builderInputRecords.length, 5);
  for (const record of [...manifest.successorRecords, ...manifest.rejectedV1Records, ...manifest.correctionV2Records, ...manifest.correctionV2PredecessorRecords, ...manifest.builderInputRecords]) verifyRecord(record);
  const authorization = validateAuthorizationValue(readJson(AUTHORIZATION_PATH, "AUTHORIZATION_INVALID")); const successor = (part) => manifest.successorRecords.find((record) => record.path.includes(part)); const rejected = (part) => manifest.rejectedV1Records.find((record) => record.path.includes(part)); const builder = (suffix) => manifest.builderInputRecords.find((record) => record.path.endsWith(suffix));
  return { authority, manifest, authorization, authorizationSha256: authority.authorization.sha256, executorSha256: successor("run-profitable").sha256, testsSha256: successor("test-run").sha256, reportSha256: authority.report.sha256, packageManifestSha256: authority.packageManifest.sha256, executorAuthoritySha256: match[1], executorDetachedChecksumSha256: sha256(detached),
    rejectedV1ExecutorSha256: rejected("run-profitable").sha256, rejectedV1PackageSha256: rejected("manifests/package-manifest.json").sha256, rejectedV1AuthoritySha256: rejected("manifests/authority-manifest.json").sha256,
    correctionV2PackageSha256: manifest.correctionV2Records.find((record) => record.path.endsWith("manifests/package-manifest.json")).sha256, correctionV2AuthoritySha256: manifest.correctionV2Records.find((record) => record.path.endsWith("manifests/authority-manifest.json")).sha256, correctionV2DetachedChecksumSha256: manifest.correctionV2Records.find((record) => record.path.endsWith("manifests/authority-manifest.sha256")).sha256,
    builderManifestSha256: builder("builder-manifest.json").sha256, parserCSha256: builder("src/parser.c").sha256, parserHeaderSha256: builder("tree_sitter/parser.h").sha256, grammarJsonSha256: builder("src/grammar.json").sha256, publishedWasmSha256: builder("tree-sitter-solidity.wasm").sha256 };
}

function loadDecision(bindings) {
  if (![DECISION_PATH, DECISION_AUTHORITY_PATH, DECISION_HASH_PATH].every(fs.existsSync)) throw new Error("REVIEW_DECISION_REQUIRED");
  try {
    for (const file of [DECISION_PATH, DECISION_AUTHORITY_PATH, DECISION_HASH_PATH]) assertPathSafe(file, DECISION_ROOT, "REVIEW_DECISION_INVALID"); const detached = fs.readFileSync(DECISION_HASH_PATH); const match = /^([a-f0-9]{64})  authority-manifest\.json\n$/.exec(detached.toString("utf8")); assert.notEqual(match, null); assert.equal(fileRecord(DECISION_AUTHORITY_PATH).sha256, match[1]);
    const wrapper = readJson(DECISION_AUTHORITY_PATH, "REVIEW_DECISION_INVALID"); exactKeys(wrapper, ["schema", "status", "decision", "executorAuthoritySha256", "independentReviewer"], "REVIEW_DECISION_INVALID"); assert.equal(wrapper.schema, `${NAMESPACE}/review-decision-authority-v1`); assert.equal(wrapper.status, "INDEPENDENT_REVIEW_APPROVED_ONE_CONDITIONAL_EXECUTION"); assert.equal(wrapper.executorAuthoritySha256, bindings.executorAuthoritySha256); assert.equal(wrapper.independentReviewer, "ORACLE"); exactKeys(wrapper.decision, ["path", "bytes", "sha256"], "REVIEW_DECISION_INVALID"); assert.equal(wrapper.decision.path, "review-decision.json"); assert.deepEqual(fileRecord(DECISION_PATH), { bytes: wrapper.decision.bytes, sha256: wrapper.decision.sha256 }); validateDecisionValue(readJson(DECISION_PATH, "REVIEW_DECISION_INVALID"), bindings);
    return { decisionSha256: wrapper.decision.sha256, decisionAuthoritySha256: match[1], decisionDetachedChecksumSha256: sha256(detached) };
  } catch { throw new Error("REVIEW_DECISION_INVALID"); }
}
function loadFinal(bindings) {
  if (![FINAL_PATH, FINAL_AUTHORITY_PATH, FINAL_HASH_PATH].every(fs.existsSync)) throw new Error("FINAL_EXECUTION_AUTHORITY_REQUIRED");
  try {
    for (const file of [FINAL_PATH, FINAL_AUTHORITY_PATH, FINAL_HASH_PATH]) assertPathSafe(file, FINAL_ROOT, "FINAL_EXECUTION_AUTHORITY_INVALID"); const detached = fs.readFileSync(FINAL_HASH_PATH); const match = /^([a-f0-9]{64})  authority-manifest\.json\n$/.exec(detached.toString("utf8")); assert.notEqual(match, null); assert.equal(fileRecord(FINAL_AUTHORITY_PATH).sha256, match[1]);
    const wrapper = readJson(FINAL_AUTHORITY_PATH, "FINAL_EXECUTION_AUTHORITY_INVALID"); exactKeys(wrapper, ["schema", "status", "finalAuthority", "executorAuthoritySha256", "decisionAuthoritySha256", "oracleFinalReview"], "FINAL_EXECUTION_AUTHORITY_INVALID"); assert.equal(wrapper.schema, `${NAMESPACE}/final-authority-package-v1`); assert.equal(wrapper.status, "FINAL_AUTHORITY_PACKAGE_APPROVED"); assert.equal(wrapper.executorAuthoritySha256, bindings.executorAuthoritySha256); assert.equal(wrapper.decisionAuthoritySha256, bindings.decisionAuthoritySha256); assert.equal(wrapper.oracleFinalReview, "ORACLE_FINAL_APPROVE_ONE_CONDITIONAL_EXECUTION"); exactKeys(wrapper.finalAuthority, ["path", "bytes", "sha256"], "FINAL_EXECUTION_AUTHORITY_INVALID"); assert.equal(wrapper.finalAuthority.path, "final-execution-authority.json"); assert.deepEqual(fileRecord(FINAL_PATH), { bytes: wrapper.finalAuthority.bytes, sha256: wrapper.finalAuthority.sha256 }); validateFinalAuthorityValue(readJson(FINAL_PATH, "FINAL_EXECUTION_AUTHORITY_INVALID"), bindings);
    return { finalAuthoritySha256: wrapper.finalAuthority.sha256, finalDetachedChecksumSha256: sha256(detached) };
  } catch { throw new Error("FINAL_EXECUTION_AUTHORITY_INVALID"); }
}

function verifyLocalInputs() { for (const record of [...SOURCE_RECORDS, GRAMMAR_RECORD, PUBLISHED_RECORD]) verifyRecord(record); const grammar = readJson(resolveRecord(GRAMMAR_RECORD), "LOCAL_INPUT_INVALID"); assert.equal(grammar.name, "solidity"); assert.deepEqual(grammar.externals, []); }
function writeFileFsync(file, text) { const fd = fs.openSync(file, "wx", 0o600); try { fs.writeSync(fd, text, null, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } assert.equal(fs.readFileSync(file, "utf8"), text, "DURABILITY_NOT_ESTABLISHED"); }
function tryDirectoryFsync(dir) { try { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } return "SUCCEEDED"; } catch { return "UNAVAILABLE_PLATFORM_DEPENDENT"; } }
function writeMarker(runRoot, filename, value) { const text = `${JSON.stringify(value)}\n`; const temporary = path.join(runRoot, `${filename}.tmp`); const target = path.join(runRoot, filename); assert.equal(fs.existsSync(path.join(runRoot, filename === "success.json" ? "failure.json" : "success.json")), false, "DURABILITY_NOT_ESTABLISHED"); writeFileFsync(temporary, text); assert.equal(fs.readFileSync(temporary, "utf8"), text, "DURABILITY_NOT_ESTABLISHED"); tryDirectoryFsync(runRoot); fs.renameSync(temporary, target); }
function validateExactSourceDirectory(sourceDir) {
  assertPathSafe(sourceDir, PACKAGE_ROOT, "RUN_PATH_UNSAFE"); assert.deepEqual(fs.readdirSync(sourceDir).sort(), ["parser.c", "tree_sitter"]); const tree = path.join(sourceDir, "tree_sitter"); assertPathSafe(tree, sourceDir, "RUN_PATH_UNSAFE"); assert.deepEqual(fs.readdirSync(tree), ["parser.h"]);
  for (const record of SOURCE_RECORDS) { const file = path.join(sourceDir, ...record.stage.split("/")); assertPathSafe(file, sourceDir, "RUN_PATH_UNSAFE"); const stat = fs.lstatSync(file); assert.equal(stat.isFile() && !stat.isSymbolicLink(), true, "LOCAL_INPUT_INVALID"); assert.deepEqual(fileRecord(file), { bytes: record.bytes, sha256: record.sha256 }, "LOCAL_INPUT_INVALID"); }
}
function validateOutputDirectory(outputDir, empty) { assertPathSafe(outputDir, PACKAGE_ROOT, "RUN_PATH_UNSAFE"); const listing = fs.readdirSync(outputDir); assert.deepEqual(listing, empty ? [] : [OUTPUT_NAME], empty ? "OUTPUT_INVALID" : "OUTPUT_INVALID"); }
function stageAndConsume(bindings) {
  verifyLocalInputs(); if (!fs.existsSync(RUNS_ROOT)) fs.mkdirSync(RUNS_ROOT, { recursive: false }); assertPathSafe(RUNS_ROOT, PACKAGE_ROOT, "RUN_PATH_UNSAFE"); const runRoot = path.join(RUNS_ROOT, bindings.authorization.authorizationId); if (fs.existsSync(runRoot)) throw new Error("AUTHORIZATION_ALREADY_CONSUMED"); fs.mkdirSync(runRoot, { recursive: false });
  const sourceDir = path.join(runRoot, "source"); const treeDir = path.join(sourceDir, "tree_sitter"); const outA = path.join(runRoot, "out-a"); const outB = path.join(runRoot, "out-b"); const dockerConfig = path.join(runRoot, "docker-config"); for (const dir of [sourceDir, treeDir, outA, outB, dockerConfig]) fs.mkdirSync(dir, { recursive: false });
  for (const record of SOURCE_RECORDS) fs.copyFileSync(resolveRecord(record), path.join(sourceDir, ...record.stage.split("/")), fs.constants.COPYFILE_EXCL); writeFileFsync(path.join(dockerConfig, "config.json"), EMPTY_DOCKER_CONFIG);
  for (const target of [runRoot, sourceDir, treeDir, outA, outB, dockerConfig]) assertPathSafe(target, PACKAGE_ROOT, "RUN_PATH_UNSAFE"); validateExactSourceDirectory(sourceDir); validateOutputDirectory(outA, true); validateOutputDirectory(outB, true); assert.deepEqual(fileRecord(resolveRecord(PUBLISHED_RECORD)), { bytes: OUTPUT_BYTES, sha256: OUTPUT_SHA256 }, "PUBLISHED_WASM_CHANGED");
  const marker = { schema: `${NAMESPACE}/authorization-consumed-v1`, authorizationId: bindings.authorization.authorizationId, consumed: true, authorizationBasis: bindings.authorization.authorizationBasis, bindings: Object.fromEntries(CONSUMPTION_BINDING_KEYS.map((key) => [key, bindings[key]])), durability: { exclusiveRunRoot: true, markerFileFsync: true, exactReadback: true, parentDirectoryFsync: "ATTEMPTED_PLATFORM_DEPENDENT_WINDOWS_LIMITATION_ACKNOWLEDGED", detectableReparseChecksOnly: true }, counters: { ...ZERO_COUNTERS, authorizationConsumeMarkersWritten: 1 } };
  writeMarker(runRoot, "authorization-consumed.json", marker); return { runRoot, sourceDir, outA, outB, dockerConfig };
}
function openJournal(runRoot) { const fd = fs.openSync(path.join(runRoot, "journal.jsonl"), "ax", 0o600); let seq = 0; return { append(phase, operation, counters, errorCode) { const row = { seq, phase, operation, counters }; if (errorCode) row.errorCode = errorCode; fs.writeSync(fd, `${JSON.stringify(row)}\n`, null, "utf8"); fs.fsyncSync(fd); seq += 1; }, close() { fs.closeSync(fd); } }; }
function sanitizedDockerEnv(dockerConfig) { for (const key of Object.keys(process.env)) if (["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_AUTH_CONFIG", "REGISTRY_AUTH_FILE", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"].includes(key.toUpperCase())) throw new Error("DOCKER_ENV_REJECTED"); const env = { DOCKER_CONFIG: dockerConfig }; for (const key of ["PATH", "SystemRoot", "WINDIR", "PATHEXT"]) if (typeof process.env[key] === "string") env[key] = process.env[key]; return env; }
function productionDocker(env) { return (_operation, argv, timeout) => childProcess.spawnSync("docker", argv, { shell: false, windowsHide: true, encoding: "utf8", env, timeout, maxBuffer: MAX_OUTPUT_BYTES }); }
function validateDaemon(version, info) { try { assert.equal(version.Client.Version, DOCKER_VERSION); assert.equal(version.Server.Version, DOCKER_VERSION); assert.equal(info.ServerVersion, DOCKER_VERSION); assert.equal(String(info.OSType).toLowerCase(), "linux"); assert.equal(["amd64", "x86_64"].includes(String(info.Architecture).toLowerCase()), true); assert.equal(Array.isArray(info.SecurityOptions), true); assert.equal(typeof info.CgroupVersion, "string"); assert.equal(typeof info.NCPU, "number"); assert.equal(typeof info.MemTotal, "number"); } catch { throw new Error("DAEMON_QUALIFICATION_FAILED"); } }
function verifyOutputFile(outputDir) { validateOutputDirectory(outputDir, false); const file = path.join(outputDir, OUTPUT_NAME); assertPathSafe(file, outputDir, "RUN_PATH_UNSAFE"); const stat = fs.lstatSync(file); assert.equal(stat.isFile() && !stat.isSymbolicLink() && stat.size === OUTPUT_BYTES, true, "OUTPUT_INVALID"); const record = fileRecord(file); assert.equal(record.sha256, OUTPUT_SHA256, "OUTPUT_INVALID"); return record; }
function safeErrorCode(error) { return ERROR_CODES.includes(error && error.message) ? error.message : "EXECUTION_FAILED"; }

function executeFixed(bindings) {
  const staged = stageAndConsume(bindings); let journal = null; let result; let failure;
  try {
    journal = openJournal(staged.runRoot); const env = sanitizedDockerEnv(staged.dockerConfig);
    const io = { configToken: staged.dockerConfig, runToken: staged.runRoot, docker: productionDocker(env), journal: (phase, operation, counters) => journal.append(phase, operation, counters), validateDaemon,
      validateMountPaths(label) { const output = label === "a" ? staged.outA : staged.outB; for (const target of [staged.runRoot, staged.sourceDir, output]) assertPathSafe(target, PACKAGE_ROOT, "RUN_PATH_UNSAFE"); },
      validateSourceExact() { validateExactSourceDirectory(staged.sourceDir); }, validateOutputEmpty(label) { validateOutputDirectory(label === "a" ? staged.outA : staged.outB, true); },
      validateOutputExact(label) { return verifyOutputFile(label === "a" ? staged.outA : staged.outB); }, validateFinalPaths() { for (const target of [staged.runRoot, staged.sourceDir, staged.outA, staged.outB]) assertPathSafe(target, PACKAGE_ROOT, "RUN_PATH_UNSAFE"); },
      validatePublishedExact() { const file = resolveRecord(PUBLISHED_RECORD); assertPathSafe(file, WORKSPACE, "PACKAGE_PATH_UNSAFE"); const record = fileRecord(file); assert.deepEqual(record, { bytes: OUTPUT_BYTES, sha256: OUTPUT_SHA256 }, "PUBLISHED_WASM_CHANGED"); return record; } };
    result = runWorkflow(io, bindings.authorization.authorizationId);
  } catch (error) { failure = error; }
  if (result) {
    const countersBeforeCommit = result.counters; const cli = { schema: `${NAMESPACE}/cli-result-v1`, status: "TWO_BUILDS_EQUAL_PUBLISHED_QUARANTINED", authorizationId: bindings.authorization.authorizationId, counters: { ...countersBeforeCommit, successMarkerWrites: 1 }, outputBytes: OUTPUT_BYTES, outputSha256: OUTPUT_SHA256 };
    try { journal.append("final", "SUCCESS_READY_TO_COMMIT", countersBeforeCommit); journal.close(); journal = null; writeMarker(staged.runRoot, "success.json", { schema: `${NAMESPACE}/success-v1`, status: cli.status, authorizationId: bindings.authorization.authorizationId, countersBeforeCommit, outputs: result.outputs, published: { bytes: OUTPUT_BYTES, sha256: OUTPUT_SHA256 }, successMarkerIsCommitPoint: true, parserPromotion: false, detectorRun: false }); }
    catch (error) { failure = error; result = null; }
    if (result) return cli;
  }
  const code = safeErrorCode(failure); const counters = failure && failure.counters ? failure.counters : { ...ZERO_COUNTERS, authorizationConsumeMarkersWritten: 1 };
  try { if (journal) { journal.append("final", "FAILURE_READY_TO_COMMIT", counters, code); journal.close(); journal = null; } writeMarker(staged.runRoot, "failure.json", { schema: `${NAMESPACE}/failure-v1`, status: "EXECUTION_FAILED_CONSUMED_OUTPUTS_QUARANTINED", authorizationId: bindings.authorization.authorizationId, errorCode: code, countersBeforeCommit: counters, failureMarkerIsCommitPoint: true, partialOutputsQuarantined: true }); counters.failureMarkerWrites += 1; } catch {}
  const clean = new Error(code); clean.counters = counters; throw clean;
}

function runDefault() { const bindings = validateBaseAuthority(); const plan = buildPlan(); assert.deepEqual(plan.operationOrder, OPERATION_ORDER); return { schema: `${NAMESPACE}/offline-summary-v1`, status: "PASS", packageStatus: bindings.authority.status, executionAuthorized: false, reviewDecisionPresent: false, finalAuthorityPresent: false, processCalls: 0, writes: 0 }; }
function main(argv) { if (argv.length === 0) return runDefault(); if (argv.length !== 1 || argv[0] !== EXECUTE_FLAG) throw new Error("ARGUMENTS_REJECTED"); const base = validateBaseAuthority(); const decision = loadDecision(base); const combined = { ...base, ...decision }; const final = loadFinal(combined); return executeFixed({ ...combined, ...final }); }
if (require.main === module) { try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`); } catch (error) { process.stderr.write(`${JSON.stringify({ status: "FAIL", errorCode: safeErrorCode(error), counters: error && error.counters ? error.counters : { processCalls: 0 }, writes: 0 })}\n`); process.exitCode = 1; } }

module.exports = Object.freeze({ NAMESPACE, EXECUTE_FLAG, ENDPOINT, IMAGE, OUTPUT_BYTES, OUTPUT_SHA256, ADMIN_TIMEOUT_MS, BUILD_TIMEOUT_MS, MAX_CALLS, EMCC_ARGV, OPERATION_ORDER, ZERO_COUNTERS, SUCCESS_COUNTERS_BEFORE_COMMIT, CONSUMPTION_BINDING_KEYS, buildPlan, classifyExactAbsence, parseCreateId, validateAuthorizationValue, validateDecisionValue, validateFinalAuthorityValue, validateImageInspectPure });
