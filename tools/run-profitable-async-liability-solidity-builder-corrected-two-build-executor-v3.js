#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const WORKSPACE = path.resolve(__dirname, "..");
const NAMESPACE = "profitable-async-liability-solidity-builder-corrected-two-build-executor-v3";
const PACKAGE_REL = `tools/vendor/${NAMESPACE}`;
const PACKAGE_ROOT = path.join(WORKSPACE, ...PACKAGE_REL.split("/"));
const PREPARATION_PATH = path.join(PACKAGE_ROOT, "authorization", "preparation-only.json");
const PACKAGE_MANIFEST_PATH = path.join(PACKAGE_ROOT, "manifests", "package-manifest.json");
const AUTHORITY_PATH = path.join(PACKAGE_ROOT, "manifests", "authority-manifest.json");
const AUTHORITY_HASH_PATH = path.join(PACKAGE_ROOT, "manifests", "authority-manifest.sha256");
const RUNS_ROOT = path.join(PACKAGE_ROOT, "runs");
const EXECUTION_AUTH_PACKAGE_REL = `tools/vendor/${NAMESPACE}-execution-authorization`;
const EXECUTION_AUTH_ROOT = path.join(WORKSPACE, ...EXECUTION_AUTH_PACKAGE_REL.split("/"));
const EXECUTION_AUTH_PATH = path.join(EXECUTION_AUTH_ROOT, "execution-authorization.json");
const EXECUTION_AUTHORITY_PATH = path.join(EXECUTION_AUTH_ROOT, "authority-manifest.json");
const EXECUTION_AUTH_HASH_PATH = path.join(EXECUTION_AUTH_ROOT, "authority-manifest.sha256");
const DECISION_PACKAGE_REL = `tools/vendor/${NAMESPACE}-review-decision`;
const DECISION_ROOT = path.join(WORKSPACE, ...DECISION_PACKAGE_REL.split("/"));
const DECISION_PATH = path.join(DECISION_ROOT, "review-decision.json");
const DECISION_AUTHORITY_PATH = path.join(DECISION_ROOT, "authority-manifest.json");
const DECISION_HASH_PATH = path.join(DECISION_ROOT, "authority-manifest.sha256");
const FINAL_PACKAGE_REL = `tools/vendor/${NAMESPACE}-final-authority`;
const FINAL_ROOT = path.join(WORKSPACE, ...FINAL_PACKAGE_REL.split("/"));
const FINAL_PATH = path.join(FINAL_ROOT, "final-execution-authority.json");
const FINAL_AUTHORITY_PATH = path.join(FINAL_ROOT, "authority-manifest.json");
const FINAL_HASH_PATH = path.join(FINAL_ROOT, "authority-manifest.sha256");
const correction = require(path.join(WORKSPACE, "tools", "validate-profitable-async-liability-solidity-builder-image-inspect-correction-v2.js"));

const EXECUTE_FLAG = "--execute-reviewed-corrected-two-build-executor-v3";
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
const ZERO_TIME = "0001-01-01T00:00:00Z";
const ENTRYPOINT = "/emsdk/upstream/emscripten/emcc";
const EMCC_ARGV = Object.freeze(["-o", "/out/tree-sitter-solidity.wasm", "-Os", "-s", "WASM=1", "-s", "SIDE_MODULE=2", "-s", "TOTAL_MEMORY=33554432", "-s", "NODEJS_CATCH_EXIT=0", "-s", "EXPORTED_FUNCTIONS=[\"_tree_sitter_solidity\"]", "-fno-exceptions", "-fvisibility=hidden", "-I", ".", "parser.c"]);
const IMAGE_ENV = Object.freeze(["PATH=/emsdk:/emsdk/upstream/emscripten:/emsdk/node/20.18.0_64bit/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "EMSDK=/emsdk"]);
const EXPLICIT_ENV = Object.freeze(["TZ=UTC", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "HOME=/home/nonroot", "XDG_CACHE_HOME=/cache"]);
const EFFECTIVE_ENV = Object.freeze([...IMAGE_ENV, ...EXPLICIT_ENV]);
const TMPFS = Object.freeze({ "/tmp": "rw,nosuid,nodev,size=268435456", "/home/nonroot": "rw,noexec,nosuid,nodev,size=33554432", "/cache": "rw,size=536870912" });
const LIMITS = Object.freeze({ memory: 4294967296, memorySwap: 4294967296, nanoCpus: 2000000000, pidsLimit: 256 });
const SOURCE_RECORDS = Object.freeze([
  Object.freeze({ path: "tools/vendor/profitable-async-liability-delta-detector-v1-parser-authority/sources/extracted/tree-sitter-solidity-1.2.13/package/src/parser.c", stage: "parser.c", bytes: 2567063, sha256: "e71971f6ddc0704e81f4af3f43ecc79793742bb5f1d256a5fdd718aa06d74acb" }),
  Object.freeze({ path: "tools/vendor/profitable-async-liability-delta-detector-v1-parser-authority/sources/extracted/tree-sitter-solidity-1.2.13/package/src/tree_sitter/parser.h", stage: "tree_sitter/parser.h", bytes: 7624, sha256: "180b893c8734778fd32f372dfbc27bd6ad1cd2221f26150b31256ff6716320d2" }),
]);
const PUBLISHED_RECORD = Object.freeze({ path: "tools/vendor/profitable-async-liability-delta-detector-v1-parser-authority/sources/extracted/tree-sitter-solidity-1.2.13/package/tree-sitter-solidity.wasm", bytes: OUTPUT_BYTES, sha256: OUTPUT_SHA256 });
const OPERATION_ORDER = Object.freeze(["VERSION", "INFO", "IMAGE_INSPECT", "A_ABSENCE_BEFORE", "A_CREATE", "A_CREATED_INSPECT", "A_START_ATTACH", "A_EXITED_INSPECT", "A_RM_FORCE", "A_ABSENCE_AFTER", "B_ABSENCE_BEFORE", "B_CREATE", "B_CREATED_INSPECT", "B_START_ATTACH", "B_EXITED_INSPECT", "B_RM_FORCE", "B_ABSENCE_AFTER"]);
const COUNTER_KEYS = Object.freeze(["processCalls", "filesystemWrites", "versionRequests", "versionSuccess", "infoRequests", "infoSuccess", "imageInspectRequests", "imageInspectSuccess", "absenceRequests", "absenceObserved", "createRequests", "createSuccess", "createdInspectRequests", "createdInspectSuccess", "startRequests", "startSuccess", "daemonObservedStarts", "exitInspectRequests", "exitInspectSuccess", "verifiedBuilds", "removeRequests", "removeSuccess", "cleanupAbsenceVerified"]);
const ZERO_COUNTERS = Object.freeze(Object.fromEntries(COUNTER_KEYS.map((key) => [key, 0])));
const ERROR_CODES = Object.freeze(["EXPLICIT_EXECUTION_AUTHORIZATION_REQUIRED", "EXECUTION_AUTHORIZATION_INVALID", "REVIEW_DECISION_REQUIRED", "REVIEW_DECISION_INVALID", "FINAL_EXECUTION_AUTHORITY_REQUIRED", "FINAL_EXECUTION_AUTHORITY_INVALID", "ARGUMENTS_REJECTED", "AUTHORIZATION_ALREADY_CONSUMED", "CALL_BUDGET_EXCEEDED", "OPERATION_REPEATED", "ABSENCE_CLASSIFICATION_FAILED", "NAME_NOT_ABSENT", "CREATE_RESPONSE_AMBIGUOUS", "CREATE_RECOVERY_INVALID", "CREATE_FAILED", "CREATED_CONFIG_INVALID", "START_FAILED", "EXIT_EVIDENCE_INVALID", "OUTPUT_INVALID", "BUILD_A_FAILED_NO_BUILD_B", "EQUALITY_FAILED", "DOCKER_ENV_REJECTED", "PACKAGE_INVALID", "PATH_UNSAFE", "DURABILITY_NOT_ESTABLISHED", "EXECUTION_FAILED"]);

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fileRecord(file) { const bytes = fs.readFileSync(file); return { bytes: bytes.length, sha256: sha256(bytes) }; }
function exactKeys(value, keys, code) { assert.equal(value && typeof value === "object" && !Array.isArray(value), true, code); assert.deepEqual(Object.keys(value), keys, code); }
function parseJson(text, code) { try { return JSON.parse(text); } catch { throw new Error(code); } }
function readJson(file, code) { return parseJson(fs.readFileSync(file, "utf8"), code); }
function contained(target, root) { const relative = path.relative(path.resolve(root), path.resolve(target)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function resolveRecord(record) { exactKeys(record, ["path", "bytes", "sha256"], "PACKAGE_INVALID"); assert.match(record.path, /^[a-zA-Z0-9._/-]+$/); assert.match(record.sha256, /^[a-f0-9]{64}$/); assert.equal(Number.isSafeInteger(record.bytes), true); const file = path.resolve(WORKSPACE, ...record.path.split("/")); assert.equal(contained(file, WORKSPACE), true); return file; }
function verifyRecord(record) { assert.deepEqual(fileRecord(resolveRecord(record)), { bytes: record.bytes, sha256: record.sha256 }, `SEAL:${record.path}`); }
function safeCounters(context) { return Object.fromEntries(COUNTER_KEYS.map((key) => [key, context.counters[key]])); }
function labels(id, build) { return { "pal.authorization": id, "pal.executor": NAMESPACE, "pal.build": build }; }
function envMap(values) { const output = {}; for (const entry of values) { const at = entry.indexOf("="); assert.equal(at > 0, true); assert.equal(Object.hasOwn(output, entry.slice(0, at)), false); output[entry.slice(0, at)] = entry.slice(at + 1); } return output; }

function validatePreparationValue(value) {
  exactKeys(value, ["schema", "status", "preparationId", "recordedAtUtc", "userText", "context", "interpretation", "executionAuthorized", "futureAuthorization"], "PACKAGE_INVALID");
  assert.equal(value.schema, `${NAMESPACE}/preparation-only-v1`); assert.equal(value.status, "PREPARATION_ONLY_EXPLICIT_EXECUTION_AUTHORIZATION_REQUIRED"); assert.match(value.preparationId, /^[a-f0-9]{32}$/); assert.equal(value.recordedAtUtc, "2026-08-12T00:00:00Z"); assert.equal(value.userText, "please");
  assert.equal(value.context, "The assistant described next steps for a distinct reviewed successor and the user replied only 'please'.");
  assert.equal(value.interpretation, "REQUEST_TO_PROCEED_WITH_PACKAGE_PREPARATION_ONLY_NOT_SUFFICIENT_EXECUTION_GRANT"); assert.equal(value.executionAuthorized, false);
  assert.deepEqual(value.futureAuthorization, { required: true, fixedPackageRoot: EXECUTION_AUTH_PACKAGE_REL, mustBindExactFutureUserText: true, mustBindFreshAuthorizationId: true, mustBindExactScope: true, mustBindReviewedExecutorHashes: true }); return value;
}

function normalizeTerminalNewline(text) { return text.endsWith("\r\n") ? `${text.slice(0, -2)}\n` : text; }
function classifyExactAbsence(result, reference) {
  assert.equal(result && Number.isInteger(result.status), true, "ABSENCE_CLASSIFICATION_FAILED"); assert.equal(result.status, 1, "NAME_NOT_ABSENT"); assert.equal(result.error == null && result.signal == null, true, "ABSENCE_CLASSIFICATION_FAILED"); assert.equal(result.stdout, "", "ABSENCE_CLASSIFICATION_FAILED"); assert.equal(normalizeTerminalNewline(result.stderr), `Error: No such container: ${reference}\n`, "ABSENCE_CLASSIFICATION_FAILED"); return true;
}
function parseCreateId(result) {
  if (result && result.status === 0 && result.error == null && result.signal == null && result.stderr === "" && /^[a-f0-9]{64}\n$/.test(result.stdout)) return { trusted: true, id: result.stdout.slice(0, 64) };
  return { trusted: false, id: null };
}
function buildCreateArgs(base, spec, sourceDir, outputDir, preparationId) {
  const argv = [...base, "create", "--name", spec.name, "--platform", "linux/amd64", "--pull", "never", "--network", "none", "--read-only", "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--memory", String(LIMITS.memory), "--memory-swap", String(LIMITS.memorySwap), "--cpus", "2", "--pids-limit", "256", "--ipc", "private", "--cgroupns", "private", "--workdir", "/src", "--entrypoint", ENTRYPOINT];
  for (const [key, value] of Object.entries(labels(preparationId, spec.label))) argv.push("--label", `${key}=${value}`); for (const value of EXPLICIT_ENV) argv.push("--env", value);
  argv.push("--mount", `type=bind,src=${sourceDir},dst=/src,readonly`, "--mount", `type=bind,src=${outputDir},dst=/out`, "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456", "--tmpfs", "/home/nonroot:rw,noexec,nosuid,nodev,size=33554432", "--tmpfs", "/cache:rw,size=536870912", IMAGE, ...EMCC_ARGV); return argv;
}
function buildPlan(config = "<CONFIG>", root = "<RUN>", preparationId = "0".repeat(32)) {
  const base = ["--config", config, "--host", ENDPOINT]; const sourceDir = path.join(root, "source"); const builds = ["a", "b"].map((label) => { const upper = label.toUpperCase(); const spec = { label, upper, name: `pal-corrected-v3-${preparationId}-${label}`, outputDir: path.join(root, `out-${label}`) }; return { ...spec, expectedLabels: labels(preparationId, label), absenceBeforeArgv: [...base, "container", "inspect", "--format", "{{.Id}}", spec.name], createArgv: buildCreateArgs(base, spec, sourceDir, spec.outputDir, preparationId), inspectByNameArgv: [...base, "container", "inspect", spec.name], inspectById: (id) => [...base, "container", "inspect", id], startById: (id) => [...base, "start", "--attach", id], removeById: (id) => [...base, "rm", "--force", id], absenceById: (id) => [...base, "container", "inspect", "--format", "{{.Id}}", id] }; });
  return { base, sourceDir, builds, versionArgv: [...base, "version", "--format", "{{json .}}"], infoArgv: [...base, "info", "--format", "{{json .}}"], imageArgv: [...base, "image", "inspect", IMAGE] };
}
function validateCreated(container, spec, id) {
  try { assert.match(id, /^[a-f0-9]{64}$/); assert.equal(container.Id, id); assert.equal(container.Name, `/${spec.name}`); assert.deepEqual(container.Config.Labels, spec.expectedLabels); assert.equal(container.State.Status, "created"); assert.equal(container.State.Running, false); assert.equal(container.State.StartedAt, ZERO_TIME); assert.equal(container.Image, CONFIG_DIGEST); assert.deepEqual(container.Config.Entrypoint, [ENTRYPOINT]); assert.deepEqual(container.Config.Cmd, EMCC_ARGV); assert.equal(container.Config.User, "65532:65532"); assert.deepEqual(envMap(container.Config.Env), envMap(EFFECTIVE_ENV)); assert.equal(envMap(container.Config.Env).SOURCE_DATE_EPOCH, undefined); assert.equal(container.HostConfig.NetworkMode, "none"); assert.equal(container.HostConfig.ReadonlyRootfs, true); assert.deepEqual(container.HostConfig.CapDrop, ["ALL"]); assert.equal(container.HostConfig.Memory, LIMITS.memory); assert.deepEqual(container.HostConfig.Tmpfs, TMPFS); } catch { throw new Error("CREATED_CONFIG_INVALID"); } return id;
}
function validateExited(container, spec, id) {
  try { assert.equal(container.Id, id); assert.equal(container.Name, `/${spec.name}`); assert.deepEqual(container.Config.Labels, spec.expectedLabels); assert.equal(container.State.Status, "exited"); assert.equal(container.State.Running, false); assert.equal(container.State.ExitCode, 0); assert.notEqual(container.State.StartedAt, ZERO_TIME); assert.notEqual(container.State.FinishedAt, ZERO_TIME); const started = Date.parse(container.State.StartedAt); const finished = Date.parse(container.State.FinishedAt); assert.equal(Number.isFinite(started) && Number.isFinite(finished) && finished >= started, true); } catch { throw new Error("EXIT_EVIDENCE_INVALID"); }
}
function requireSuccess(result, code) { if (!result || result.status !== 0 || result.error != null || result.signal != null || typeof result.stdout !== "string" || typeof result.stderr !== "string") throw new Error(code); return result; }
function counterPair(operation) { if (operation === "VERSION") return ["versionRequests", "versionSuccess"]; if (operation === "INFO") return ["infoRequests", "infoSuccess"]; if (operation === "IMAGE_INSPECT") return ["imageInspectRequests", "imageInspectSuccess"]; if (operation.includes("ABSENCE")) return ["absenceRequests", "absenceObserved"]; if (operation.endsWith("CREATE")) return ["createRequests", "createSuccess"]; if (operation.endsWith("CREATED_INSPECT")) return ["createdInspectRequests", "createdInspectSuccess"]; if (operation.endsWith("START_ATTACH")) return ["startRequests", "startSuccess"]; if (operation.endsWith("EXITED_INSPECT")) return ["exitInspectRequests", "exitInspectSuccess"]; return ["removeRequests", "removeSuccess"]; }
function runWorkflow(io, preparationId) {
  const plan = buildPlan(io.config, io.root, preparationId); const context = { counters: { ...ZERO_COUNTERS }, attempted: Object.fromEntries(OPERATION_ORDER.map((key) => [key, false])) };
  function call(operation, argv, timeout) { assert.equal(context.counters.processCalls < MAX_CALLS, true, "CALL_BUDGET_EXCEEDED"); assert.equal(context.attempted[operation], false, "OPERATION_REPEATED"); context.attempted[operation] = true; context.counters.processCalls += 1; context.counters[counterPair(operation)[0]] += 1; io.journal("before", operation, safeCounters(context)); return io.docker(operation, argv, timeout); }
  function finish(operation) { context.counters[counterPair(operation)[1]] += 1; io.journal("after", operation, safeCounters(context)); }
  function absence(operation, argv, reference, cleanup) { classifyExactAbsence(call(operation, argv, ADMIN_TIMEOUT_MS), reference); finish(operation); if (cleanup) context.counters.cleanupAbsenceVerified += 1; }
  function inspect(operation, argv) { const result = requireSuccess(call(operation, argv, ADMIN_TIMEOUT_MS), "CREATE_RECOVERY_INVALID"); finish(operation); const rows = parseJson(result.stdout, "CREATE_RECOVERY_INVALID"); assert.equal(Array.isArray(rows) && rows.length === 1, true, "CREATE_RECOVERY_INVALID"); return rows[0]; }
  function cleanup(spec, id) { const rm = `${spec.upper}_RM_FORCE`; requireSuccess(call(rm, spec.removeById(id), ADMIN_TIMEOUT_MS), "EXECUTION_FAILED"); finish(rm); absence(`${spec.upper}_ABSENCE_AFTER`, spec.absenceById(id), id, true); }
  try {
    const version = parseJson(requireSuccess(call("VERSION", plan.versionArgv, ADMIN_TIMEOUT_MS), "EXECUTION_FAILED").stdout, "EXECUTION_FAILED"); finish("VERSION"); const info = parseJson(requireSuccess(call("INFO", plan.infoArgv, ADMIN_TIMEOUT_MS), "EXECUTION_FAILED").stdout, "EXECUTION_FAILED"); finish("INFO"); io.validateDaemon(version, info);
    const imageRows = parseJson(requireSuccess(call("IMAGE_INSPECT", plan.imageArgv, ADMIN_TIMEOUT_MS), "EXECUTION_FAILED").stdout, "EXECUTION_FAILED"); finish("IMAGE_INSPECT"); correction.compareCorrectedInspect(imageRows[0], { source: "DOCKER_IMAGE_INSPECT_MEMORY_ONLY", runId: preparationId });
    const outputs = [];
    for (let index = 0; index < plan.builds.length; index += 1) {
      const spec = plan.builds[index];
      try {
        io.validatePaths(spec.label, "AFTER_CREATION"); io.validateSource(); io.validateEmpty(spec.label); absence(`${spec.upper}_ABSENCE_BEFORE`, spec.absenceBeforeArgv, spec.name, false); io.validatePaths(spec.label, "IMMEDIATELY_BEFORE_MOUNT"); io.validateSource(); io.validateEmpty(spec.label);
        const createOperation = `${spec.upper}_CREATE`; const createResult = call(createOperation, spec.createArgv, ADMIN_TIMEOUT_MS); const parsed = parseCreateId(createResult); let id;
        if (parsed.trusted) { id = parsed.id; finish(createOperation); validateCreated(inspect(`${spec.upper}_CREATED_INSPECT`, spec.inspectById(id)), spec, id); }
        else {
          const recoveryOperation = `${spec.upper}_CREATED_INSPECT`; const recovery = call(recoveryOperation, spec.inspectByNameArgv, ADMIN_TIMEOUT_MS);
          try { classifyExactAbsence(recovery, spec.name); finish(recoveryOperation); throw new Error("CREATE_RESPONSE_AMBIGUOUS"); }
          catch (absenceError) {
            if (absenceError.message === "CREATE_RESPONSE_AMBIGUOUS") throw absenceError;
            const successful = requireSuccess(recovery, "CREATE_RECOVERY_INVALID"); finish(recoveryOperation); const rows = parseJson(successful.stdout, "CREATE_RECOVERY_INVALID"); assert.equal(Array.isArray(rows) && rows.length === 1, true, "CREATE_RECOVERY_INVALID"); id = rows[0].Id; validateCreated(rows[0], spec, id); cleanup(spec, id); throw new Error("CREATE_RESPONSE_AMBIGUOUS");
          }
        }
        const start = `${spec.upper}_START_ATTACH`; requireSuccess(call(start, spec.startById(id), BUILD_TIMEOUT_MS), "START_FAILED"); finish(start); const exited = inspect(`${spec.upper}_EXITED_INSPECT`, spec.inspectById(id)); validateExited(exited, spec, id); context.counters.daemonObservedStarts += 1; outputs.push(io.validateOutput(spec.label)); context.counters.verifiedBuilds += 1; cleanup(spec, id);
      } catch (error) { if (index === 0) throw new Error("BUILD_A_FAILED_NO_BUILD_B"); throw error; }
    }
    io.validateSource(); io.validateFinalPaths(); const a = io.validateOutput("a"); const b = io.validateOutput("b"); const published = io.validatePublished(); assert.deepEqual([a, b, published], [{ bytes: OUTPUT_BYTES, sha256: OUTPUT_SHA256 }, { bytes: OUTPUT_BYTES, sha256: OUTPUT_SHA256 }, { bytes: OUTPUT_BYTES, sha256: OUTPUT_SHA256 }], "EQUALITY_FAILED"); return { status: "READY_TO_COMMIT", counters: safeCounters(context), outputs, attempted: context.attempted };
  } catch (error) { error.counters = safeCounters(context); error.attempted = context.attempted; throw error; }
}

function writeDurableMarker(storage, runRoot, filename, value) {
  const opposite = filename === "success.json" ? "failure.json" : "success.json"; assert.equal(storage.exists(path.join(runRoot, opposite)), false, "DURABILITY_NOT_ESTABLISHED"); const temporary = path.join(runRoot, `${filename}.tmp`); const target = path.join(runRoot, filename); const text = `${JSON.stringify(value)}\n`;
  storage.writeExclusive(temporary, text); storage.fsyncFile(temporary); assert.equal(storage.read(temporary), text); storage.rename(temporary, target); assert.equal(storage.read(target), text); const directoryFsync = storage.fsyncDirectory(runRoot); return { committed: true, directoryFsync: directoryFsync ? "SUCCEEDED" : "ATTEMPTED_PLATFORM_LIMITATION" };
}

function validateExecutionAuthorizationValue(value, bindings) {
  exactKeys(value, ["schema", "status", "authorizationId", "authorizedAtUtc", "exactUserText", "scope", "bindings", "oneShot"], "EXECUTION_AUTHORIZATION_INVALID"); assert.equal(value.schema, `${NAMESPACE}/execution-authorization-v1`); assert.equal(value.status, "EXPLICIT_CURRENT_TURN_EXECUTION_AUTHORIZATION"); assert.match(value.authorizationId, /^[a-f0-9]{32}$/); assert.equal(typeof value.exactUserText === "string" && value.exactUserText.length > 0, true); assert.deepEqual(value.scope, bindings.manifest.scope); exactKeys(value.bindings, ["executorSha256", "testsSha256", "reportSha256", "packageManifestSha256", "executorAuthoritySha256", "executorDetachedChecksumSha256"], "EXECUTION_AUTHORIZATION_INVALID"); for (const key of Object.keys(value.bindings)) assert.equal(value.bindings[key], bindings[key]); assert.deepEqual(value.oneShot, { consumeBeforeFirstDockerCall: true, noRetry: true }); return value;
}
function loadFixedPackage(root, files, missingCode, invalidCode) { if (!files.every(fs.existsSync)) throw new Error(missingCode); try { for (const file of files) assert.equal(contained(file, root), true); } catch { throw new Error(invalidCode); } }
function loadExecutionAuthorization(bindings) {
  loadFixedPackage(EXECUTION_AUTH_ROOT, [EXECUTION_AUTH_PATH, EXECUTION_AUTHORITY_PATH, EXECUTION_AUTH_HASH_PATH], "EXPLICIT_EXECUTION_AUTHORIZATION_REQUIRED", "EXECUTION_AUTHORIZATION_INVALID");
  try { const detached = fs.readFileSync(EXECUTION_AUTH_HASH_PATH); const match = /^([a-f0-9]{64})  authority-manifest\.json\n$/.exec(detached.toString("utf8")); assert.notEqual(match, null); assert.equal(fileRecord(EXECUTION_AUTHORITY_PATH).sha256, match[1]); const wrapper = readJson(EXECUTION_AUTHORITY_PATH, "EXECUTION_AUTHORIZATION_INVALID"); exactKeys(wrapper, ["schema", "status", "authorization", "executorAuthoritySha256"], "EXECUTION_AUTHORIZATION_INVALID"); assert.equal(wrapper.schema, `${NAMESPACE}/execution-authorization-authority-v1`); assert.equal(wrapper.status, "EXPLICIT_EXECUTION_AUTHORIZATION_PACKAGE"); assert.equal(wrapper.executorAuthoritySha256, bindings.executorAuthoritySha256); exactKeys(wrapper.authorization, ["path", "bytes", "sha256"], "EXECUTION_AUTHORIZATION_INVALID"); assert.equal(wrapper.authorization.path, "execution-authorization.json"); assert.deepEqual(fileRecord(EXECUTION_AUTH_PATH), { bytes: wrapper.authorization.bytes, sha256: wrapper.authorization.sha256 }); const authorization = validateExecutionAuthorizationValue(readJson(EXECUTION_AUTH_PATH, "EXECUTION_AUTHORIZATION_INVALID"), bindings); return { authorization, executionAuthorizationSha256: wrapper.authorization.sha256, executionAuthorizationAuthoritySha256: match[1], executionAuthorizationDetachedSha256: sha256(detached) }; } catch { throw new Error("EXECUTION_AUTHORIZATION_INVALID"); }
}
function validateBase() {
  const detached = fs.readFileSync(AUTHORITY_HASH_PATH); const match = /^([a-f0-9]{64})  manifests\/authority-manifest\.json\n$/.exec(detached.toString("utf8")); assert.notEqual(match, null); assert.equal(fileRecord(AUTHORITY_PATH).sha256, match[1]); const authority = readJson(AUTHORITY_PATH, "PACKAGE_INVALID"); assert.equal(authority.status, "SEALED_PREPARATION_ONLY_REVIEW_REQUIRED_EXECUTION_UNAUTHORIZED"); assert.equal(authority.executionAuthorized, false); for (const record of [authority.packageManifest, authority.report, authority.preparation]) verifyRecord(record); const manifest = readJson(PACKAGE_MANIFEST_PATH, "PACKAGE_INVALID"); assert.equal(manifest.status, authority.status); for (const record of [...manifest.successorRecords, ...manifest.rejectedV2Records]) verifyRecord(record);
  const v2ManifestRecord = manifest.rejectedV2Records.find((record) => record.path.endsWith("manifests/package-manifest.json")); const v2 = readJson(resolveRecord(v2ManifestRecord), "PACKAGE_INVALID"); const inherited = [...v2.rejectedV1Records, ...v2.correctionV2Records, ...v2.correctionV2PredecessorRecords, ...v2.builderInputRecords]; assert.equal(inherited.length, 53); for (const record of inherited) verifyRecord(record); validatePreparationValue(readJson(PREPARATION_PATH, "PACKAGE_INVALID")); const find = (part) => manifest.successorRecords.find((record) => record.path.includes(part)); return { authority, manifest, preparation: readJson(PREPARATION_PATH, "PACKAGE_INVALID"), executorSha256: find("run-profitable").sha256, testsSha256: find("test-run").sha256, reportSha256: authority.report.sha256, packageManifestSha256: authority.packageManifest.sha256, executorAuthoritySha256: match[1], executorDetachedChecksumSha256: sha256(detached) };
}
function loadDecision() { throw new Error("REVIEW_DECISION_REQUIRED"); }
function loadFinal() { throw new Error("FINAL_EXECUTION_AUTHORITY_REQUIRED"); }
function safeErrorCode(error) { return ERROR_CODES.includes(error && error.message) ? error.message : "EXECUTION_FAILED"; }
function executeFixed() { throw new Error("EXECUTION_FAILED"); }
function runDefault() { const base = validateBase(); return { schema: `${NAMESPACE}/offline-summary-v1`, status: "PASS", packageStatus: base.authority.status, executionAuthorized: false, explicitExecutionAuthorizationPresent: false, processCalls: 0, filesystemWrites: 0 }; }
function main(argv) { if (argv.length === 0) return runDefault(); if (argv.length !== 1 || argv[0] !== EXECUTE_FLAG) throw new Error("ARGUMENTS_REJECTED"); const base = validateBase(); const executionAuthorization = loadExecutionAuthorization(base); const decision = loadDecision({ ...base, ...executionAuthorization }); const final = loadFinal({ ...base, ...executionAuthorization, ...decision }); return executeFixed({ ...base, ...executionAuthorization, ...decision, ...final }); }
if (require.main === module) { try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`); } catch (error) { process.stderr.write(`${JSON.stringify({ status: "FAIL", errorCode: safeErrorCode(error), counters: error && error.counters ? error.counters : { processCalls: 0, filesystemWrites: 0 }, terminalEvidenceState: error && error.terminalEvidenceState ? error.terminalEvidenceState : "NOT_CONSUMED" })}\n`); process.exitCode = 1; } }

module.exports = Object.freeze({ NAMESPACE, EXECUTE_FLAG, MAX_CALLS, ADMIN_TIMEOUT_MS, BUILD_TIMEOUT_MS, OPERATION_ORDER, ZERO_COUNTERS, buildPlan, classifyExactAbsence, parseCreateId, validatePreparationValue, validateExecutionAuthorizationValue });
