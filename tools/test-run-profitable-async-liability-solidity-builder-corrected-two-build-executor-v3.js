"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MODULE_PATH = path.join(__dirname, "run-profitable-async-liability-solidity-builder-corrected-two-build-executor-v3.js");
const PREPARATION_PATH = path.join(__dirname, "vendor", "profitable-async-liability-solidity-builder-corrected-two-build-executor-v3", "authorization", "preparation-only.json");
const FIXTURE_PATH = path.join(__dirname, "vendor", "profitable-async-liability-solidity-builder-image-inspect-diagnostic-v2", "fixtures", "image-inspect-match.json");
const SOURCE = fs.readFileSync(MODULE_PATH, "utf8");
const executor = require(MODULE_PATH);
function preparation() { return JSON.parse(fs.readFileSync(PREPARATION_PATH, "utf8")); }
function fixture() { return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"))[0]; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function loadInternal() {
  const injected = SOURCE.replace(/^#!.*\n/, "").replace("module.exports = Object.freeze({", "module.exports = Object.freeze({ runWorkflow, writeDurableMarker, validateCreated, validateExited,");
  const module = { exports: {} }; const wrapper = `(function(require,module,exports,__filename,__dirname){${injected}\n})`; new vm.Script(wrapper, { filename: MODULE_PATH }).runInThisContext()(require, module, module.exports, MODULE_PATH, __dirname); return module.exports;
}
const internal = loadInternal();
function result(status, stdout = "", stderr = "", error = null) { return { status, stdout, stderr, signal: null, error }; }
function created(spec, id) { return { Id: id, Name: `/${spec.name}`, Image: "sha256:a411b47f58dbac78da4f2ea974e6bdbb4cd0598d6de7d8166903cdb34d6ecc9e", Config: { Labels: spec.expectedLabels, Entrypoint: ["/emsdk/upstream/emscripten/emcc"], Cmd: ["-o", "/out/tree-sitter-solidity.wasm", "-Os", "-s", "WASM=1", "-s", "SIDE_MODULE=2", "-s", "TOTAL_MEMORY=33554432", "-s", "NODEJS_CATCH_EXIT=0", "-s", "EXPORTED_FUNCTIONS=[\"_tree_sitter_solidity\"]", "-fno-exceptions", "-fvisibility=hidden", "-I", ".", "parser.c"], User: "65532:65532", Env: ["PATH=/emsdk:/emsdk/upstream/emscripten:/emsdk/node/20.18.0_64bit/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "EMSDK=/emsdk", "TZ=UTC", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "HOME=/home/nonroot", "XDG_CACHE_HOME=/cache"] }, State: { Status: "created", Running: false, StartedAt: "0001-01-01T00:00:00Z", FinishedAt: "0001-01-01T00:00:00Z", ExitCode: 0 }, HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], Memory: 4294967296, Tmpfs: { "/tmp": "rw,nosuid,nodev,size=268435456", "/home/nonroot": "rw,noexec,nosuid,nodev,size=33554432", "/cache": "rw,size=536870912" } } }; }
function exited(spec, id) { const value = created(spec, id); value.State = { Status: "exited", Running: false, ExitCode: 0, StartedAt: "2026-08-12T01:00:00Z", FinishedAt: "2026-08-12T01:00:01Z" }; return value; }

function fakeWorkflow(createMode = "normal", failureAt = null) {
  const id = preparation().preparationId; const plan = executor.buildPlan("<c>", "C:\\safe\\run", id); const ids = { a: "a".repeat(64), b: "b".repeat(64) }; const calls = [];
  const io = { config: "<c>", root: "C:\\safe\\run", journal() {}, validateDaemon() {}, validatePaths() {}, validateSource() {}, validateEmpty() {}, validateOutput() { return { bytes: 508582, sha256: "07420813d7668445152a5d5d2017e0fb84cb27342257e1add3cc7462eec7f811" }; }, validateFinalPaths() {}, validatePublished() { return { bytes: 508582, sha256: "07420813d7668445152a5d5d2017e0fb84cb27342257e1add3cc7462eec7f811" }; },
    docker(operation) {
      calls.push(operation); if (operation === failureAt) return result(2, "", "permission denied\n");
      if (operation === "VERSION") return result(0, JSON.stringify({})); if (operation === "INFO") return result(0, JSON.stringify({}));
      if (operation === "IMAGE_INSPECT") { const image = fixture(); delete image.Config.User; delete image.Config.Cmd; return result(0, JSON.stringify([image])); }
      if (operation.endsWith("ABSENCE_BEFORE")) { const spec = plan.builds[operation[0] === "A" ? 0 : 1]; return result(1, "", `Error: No such container: ${spec.name}\n`); }
      if (operation.endsWith("CREATE")) { const label = operation[0].toLowerCase(); if (createMode !== "normal" && label === "a") return createMode === "timeout" ? result(null, "", "", { code: "ETIMEDOUT" }) : createMode === "enobufs" ? result(null, "", "", { code: "ENOBUFS" }) : createMode === "malformed" ? result(0, "bad\n", "") : result(null); return result(0, `${ids[label]}\n`); }
      if (operation.endsWith("CREATED_INSPECT")) { const spec = plan.builds[operation[0] === "A" ? 0 : 1]; return result(0, JSON.stringify([created(spec, ids[spec.label])])); }
      if (operation.endsWith("START_ATTACH")) return result(0);
      if (operation.endsWith("EXITED_INSPECT")) { const spec = plan.builds[operation[0] === "A" ? 0 : 1]; return result(0, JSON.stringify([exited(spec, ids[spec.label])])); }
      if (operation.endsWith("RM_FORCE")) return result(0);
      if (operation.endsWith("ABSENCE_AFTER")) { const spec = plan.builds[operation[0] === "A" ? 0 : 1]; return result(1, "", `Error: No such container: ${ids[spec.label]}\n`); }
      throw new Error(operation);
    } };
  try { return { value: internal.runWorkflow(io, id), error: null, calls }; } catch (error) { return { value: null, error, calls }; }
}

test("preparation artifact is truthful and no current execution authorization", () => {
  const value = preparation(); executor.validatePreparationValue(value); assert.equal(value.status, "PREPARATION_ONLY_EXPLICIT_EXECUTION_AUTHORIZATION_REQUIRED"); assert.equal(value.userText, "please"); assert.equal(value.executionAuthorized, false); assert.match(value.interpretation, /PREPARATION_ONLY_NOT_SUFFICIENT_EXECUTION_GRANT/);
});

test("production exports no workflow or live executor", () => {
  assert.equal(Object.hasOwn(executor, "runWorkflow"), false); assert.equal(Object.hasOwn(executor, "executeFixed"), false); assert.equal(typeof internal.runWorkflow, "function"); assert.equal(SOURCE.includes("testHook"), false);
});

test("exact flag gates execution authorization before review roots", () => {
  const main = SOURCE.slice(SOURCE.indexOf("function main(argv)"), SOURCE.indexOf("if (require.main")); const auth = main.indexOf("loadExecutionAuthorization"); const decision = main.indexOf("loadDecision"); const final = main.indexOf("loadFinal"); assert.equal(auth >= 0 && auth < decision, true); assert.equal(decision >= 0 && decision < final, true); assert.equal(SOURCE.includes('"EXPLICIT_EXECUTION_AUTHORIZATION_REQUIRED"'), true);
});

test("absence accepts exact LF and terminal CRLF only", () => {
  assert.equal(executor.classifyExactAbsence(result(1, "", "Error: No such container: x\n"), "x"), true); assert.equal(executor.classifyExactAbsence(result(1, "", "Error: No such container: x\r\n"), "x"), true);
  for (const text of ["No such container: x\n", "Error: No such container: x \n", "permission denied\n", "Error: No such object: x\n"]) assert.throws(() => executor.classifyExactAbsence(result(1, "", text), "x"));
});

test("normal actual workflow remains exact 17-call success", () => {
  const run = fakeWorkflow(); assert.equal(run.error, null); assert.deepEqual(run.calls, executor.OPERATION_ORDER); assert.equal(run.value.counters.processCalls, 17); assert.equal(run.value.counters.daemonObservedStarts, 2); assert.equal(run.value.counters.verifiedBuilds, 2);
});

test("ambiguous create variants recover by deterministic name then cleanup without start", () => {
  for (const mode of ["timeout", "enobufs", "malformed", "null"]) {
    const run = fakeWorkflow(mode); assert.notEqual(run.error, null, mode); assert.equal(run.error.message, "BUILD_A_FAILED_NO_BUILD_B", mode); assert.deepEqual(run.calls, ["VERSION", "INFO", "IMAGE_INSPECT", "A_ABSENCE_BEFORE", "A_CREATE", "A_CREATED_INSPECT", "A_RM_FORCE", "A_ABSENCE_AFTER"], mode); assert.equal(run.calls.includes("A_START_ATTACH"), false); assert.equal(run.calls.some((x) => x.startsWith("B_")), false); assert.equal(run.calls.length <= 17, true);
  }
});

test("ambiguous create exact absence is clean and never removes or starts", () => {
  const id = preparation().preparationId; const original = fakeWorkflow;
  const plan = executor.buildPlan("<c>", "C:\\safe\\run", id); const calls = []; const io = { config: "<c>", root: "C:\\safe\\run", journal() {}, validateDaemon() {}, validatePaths() {}, validateSource() {}, validateEmpty() {}, docker(operation) { calls.push(operation); if (operation === "VERSION" || operation === "INFO") return result(0, "{}"); if (operation === "IMAGE_INSPECT") { const image = fixture(); delete image.Config.User; delete image.Config.Cmd; return result(0, JSON.stringify([image])); } if (operation === "A_ABSENCE_BEFORE") return result(1, "", `Error: No such container: ${plan.builds[0].name}\n`); if (operation === "A_CREATE") return result(null, "", "", { code: "ETIMEDOUT" }); if (operation === "A_CREATED_INSPECT") return result(1, "", `Error: No such container: ${plan.builds[0].name}\n`); throw new Error(operation); } };
  assert.throws(() => internal.runWorkflow(io, id), /BUILD_A_FAILED_NO_BUILD_B/); assert.deepEqual(calls, ["VERSION", "INFO", "IMAGE_INSPECT", "A_ABSENCE_BEFORE", "A_CREATE", "A_CREATED_INSPECT"]); void original;
});

test("failure paths never exceed 17 and operations never repeat", () => {
  for (const operation of executor.OPERATION_ORDER) { const run = fakeWorkflow("normal", operation); assert.notEqual(run.error, null); assert.equal(run.calls.length <= 17, true, operation); assert.equal(new Set(run.calls).size, run.calls.length, operation); if (operation.startsWith("A_")) assert.equal(run.calls.some((x) => x.startsWith("B_")), false); }
});

test("created recovery validates exact name labels and not-started state", () => {
  const plan = executor.buildPlan("<c>", "C:\\safe\\run", preparation().preparationId); const spec = plan.builds[0]; const id = "a".repeat(64); internal.validateCreated(created(spec, id), spec, id);
  for (const mutate of [(x) => { x.Name = "/wrong"; }, (x) => { x.Config.Labels["pal.authorization"] = "wrong"; }, (x) => { x.State.Status = "running"; }, (x) => { x.State.Running = true; }, (x) => { x.State.StartedAt = "2026-08-12T00:00:00Z"; }]) { const value = clone(created(spec, id)); mutate(value); assert.throws(() => internal.validateCreated(value, spec, id)); }
});

test("durable marker ordering includes temp fsync readback rename final readback directory fsync", () => {
  const events = []; const files = new Map(); const storage = { exists(file) { return files.has(file); }, writeExclusive(file, text) { assert.equal(files.has(file), false); events.push("write-exclusive"); files.set(file, text); }, fsyncFile() { events.push("file-fsync"); }, read(file) { events.push(file.endsWith(".tmp") ? "temp-readback" : "final-readback"); return files.get(file); }, rename(from, to) { events.push("rename"); files.set(to, files.get(from)); files.delete(from); }, fsyncDirectory() { events.push("directory-fsync"); return false; } };
  const value = internal.writeDurableMarker(storage, "run", "success.json", { ok: true }); assert.deepEqual(events, ["write-exclusive", "file-fsync", "temp-readback", "rename", "final-readback", "directory-fsync"]); assert.deepEqual(value, { committed: true, directoryFsync: "ATTEMPTED_PLATFORM_LIMITATION" }); assert.throws(() => internal.writeDurableMarker(storage, "run", "failure.json", { no: true }));
});

test("future authorization schema binds user text ID scope and reviewed hashes", () => {
  const bindings = { manifest: { scope: { calls: 17 } }, executorSha256: "1".repeat(64), testsSha256: "2".repeat(64), reportSha256: "3".repeat(64), packageManifestSha256: "4".repeat(64), executorAuthoritySha256: "5".repeat(64), executorDetachedChecksumSha256: "6".repeat(64) };
  const value = { schema: `${executor.NAMESPACE}/execution-authorization-v1`, status: "EXPLICIT_CURRENT_TURN_EXECUTION_AUTHORIZATION", authorizationId: "a".repeat(32), authorizedAtUtc: "future", exactUserText: "I explicitly authorize this exact execution", scope: bindings.manifest.scope, bindings: { executorSha256: bindings.executorSha256, testsSha256: bindings.testsSha256, reportSha256: bindings.reportSha256, packageManifestSha256: bindings.packageManifestSha256, executorAuthoritySha256: bindings.executorAuthoritySha256, executorDetachedChecksumSha256: bindings.executorDetachedChecksumSha256 }, oneShot: { consumeBeforeFirstDockerCall: true, noRetry: true } }; executor.validateExecutionAuthorizationValue(value, bindings); value.exactUserText = ""; assert.throws(() => executor.validateExecutionAuthorizationValue(value, bindings));
});

test("CLI output reports counters and terminal evidence state without writes equals zero claim", () => {
  const cli = SOURCE.slice(SOURCE.indexOf("if (require.main"), SOURCE.indexOf("module.exports")); assert.match(cli, /counters: error && error\.counters/); assert.match(cli, /terminalEvidenceState/); assert.equal(cli.includes("writes: 0"), false);
});

test("v2 protections remain represented", () => {
  for (const text of ["IMMEDIATELY_BEFORE_MOUNT", "validateFinalPaths", "validatePublished", "BUILD_TIMEOUT_MS", "SOURCE_DATE_EPOCH", "daemonObservedStarts", "success.json", "failure.json"]) assert.equal(SOURCE.includes(text), true, text);
  assert.equal(executor.ADMIN_TIMEOUT_MS, 30000); assert.equal(executor.BUILD_TIMEOUT_MS, 1800000); assert.equal(executor.MAX_CALLS, 17);
});

test("production main fixed and no option/path overrides", () => {
  assert.match(SOURCE, /function main\(argv\)/); assert.match(SOURCE, /main\(process\.argv\.slice\(2\)\)/); for (const bad of ["internalOptions", "testHook", "options = {}", "spawnSync:", "authorizationRootOverride"]) assert.equal(SOURCE.includes(bad), false);
});

test("preparation-only pure helpers do not call process or write", () => {
  const childProcess = require("node:child_process"); const spawn = childProcess.spawnSync; const write = fs.writeSync; let calls = 0; let writes = 0; childProcess.spawnSync = () => { calls += 1; }; fs.writeSync = () => { writes += 1; };
  try { executor.buildPlan(); executor.validatePreparationValue(preparation()); executor.classifyExactAbsence(result(1, "", "Error: No such container: x\n"), "x"); assert.equal(calls, 0); assert.equal(writes, 0); } finally { childProcess.spawnSync = spawn; fs.writeSync = write; }
});

test("status string and executionAuthorized false are source-sealed", () => {
  assert.equal(SOURCE.includes("SEALED_PREPARATION_ONLY_REVIEW_REQUIRED_EXECUTION_UNAUTHORIZED"), true); assert.equal(SOURCE.includes("executionAuthorized: false"), true); assert.equal(SOURCE.includes("PREPARATION_ONLY_EXPLICIT_EXECUTION_AUTHORIZATION_REQUIRED"), true);
});
