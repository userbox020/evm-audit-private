"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MODULE_PATH = path.join(__dirname, "run-profitable-async-liability-solidity-builder-corrected-two-build-executor-v2.js");
const AUTH_PATH = path.join(__dirname, "vendor", "profitable-async-liability-solidity-builder-corrected-two-build-executor-v2", "authorization", "current-turn-authorization.json");
const FIXTURE_PATH = path.join(__dirname, "vendor", "profitable-async-liability-solidity-builder-image-inspect-diagnostic-v2", "fixtures", "image-inspect-match.json");
const SOURCE = fs.readFileSync(MODULE_PATH, "utf8");
const executor = require(MODULE_PATH);
function authorization() { return JSON.parse(fs.readFileSync(AUTH_PATH, "utf8")); }
function fixture() { return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"))[0]; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function loadInstrumented() {
  const injected = SOURCE.replace(/^#!.*\n/, "").replace("module.exports = Object.freeze({", "module.exports = Object.freeze({ runWorkflow, validateCreatedInspect, validateExitedInspect,");
  const module = { exports: {} }; const wrapper = `(function(require,module,exports,__filename,__dirname){${injected}\n})`;
  const compiled = new vm.Script(wrapper, { filename: MODULE_PATH }).runInThisContext(); compiled(require, module, module.exports, MODULE_PATH, __dirname); return module.exports;
}
const internal = loadInstrumented();

function result(status, stdout = "", stderr = "") { return { status, stdout, stderr, signal: null, error: null }; }
function imageInspect() { const value = fixture(); delete value.Config.User; delete value.Config.Cmd; return value; }
function createdContainer(spec, id) {
  return { Id: id, Name: `/${spec.name}`, Image: "sha256:a411b47f58dbac78da4f2ea974e6bdbb4cd0598d6de7d8166903cdb34d6ecc9e",
    Config: { Image: executor.IMAGE, Labels: spec.labels, Entrypoint: ["/emsdk/upstream/emscripten/emcc"], Cmd: executor.EMCC_ARGV, User: "65532:65532", WorkingDir: "/src", Env: ["PATH=/emsdk:/emsdk/upstream/emscripten:/emsdk/node/20.18.0_64bit/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "EMSDK=/emsdk", "TZ=UTC", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "HOME=/home/nonroot", "XDG_CACHE_HOME=/cache"] },
    State: { Status: "created", Running: false, StartedAt: "0001-01-01T00:00:00Z", FinishedAt: "0001-01-01T00:00:00Z", ExitCode: 0 },
    HostConfig: { ReadonlyRootfs: true, NetworkMode: "none", CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], Memory: 4294967296, MemorySwap: 4294967296, NanoCpus: 2000000000, PidsLimit: 256, IpcMode: "private", CgroupnsMode: "private", Privileged: false, Devices: [], PidMode: "", UTSMode: "", Tmpfs: { "/tmp": "rw,nosuid,nodev,size=268435456", "/home/nonroot": "rw,noexec,nosuid,nodev,size=33554432", "/cache": "rw,size=536870912" }, Mounts: [{ Type: "bind", Source: spec.sourceDir, Target: "/src", ReadOnly: true }, { Type: "bind", Source: spec.outputDir, Target: "/out", ReadOnly: false }] },
    Mounts: [{ Destination: "/src", RW: false }, { Destination: "/out", RW: true }] };
}
function exitedContainer(spec, id) { const value = createdContainer(spec, id); value.State = { Status: "exited", Running: false, StartedAt: "2026-08-12T01:00:00.000000000Z", FinishedAt: "2026-08-12T01:00:01.000000000Z", ExitCode: 0 }; return value; }

function fakeWorkflow(failAt = null, override = {}) {
  const authId = authorization().authorizationId; const plan = executor.buildPlan("<config>", "C:\\safe\\run", authId); const calls = []; const journals = []; const ids = { a: "a".repeat(64), b: "b".repeat(64) };
  const io = { configToken: "<config>", runToken: "C:\\safe\\run", journal(phase, operation, counters) { journals.push({ phase, operation, counters: { ...counters } }); },
    docker(operation) {
      calls.push(operation); if (operation === failAt) return override.failureResult || result(2, "", "permission denied\n");
      if (operation === "VERSION") return result(0, JSON.stringify({ Client: { Version: "29.6.1" }, Server: { Version: "29.6.1" } }));
      if (operation === "INFO") return result(0, JSON.stringify({ ServerVersion: "29.6.1", OSType: "linux", Architecture: "amd64", SecurityOptions: [], CgroupVersion: "2", NCPU: 2, MemTotal: 8589934592 }));
      if (operation === "IMAGE_INSPECT") return result(0, JSON.stringify([imageInspect()]));
      if (operation.endsWith("ABSENCE_BEFORE")) { const spec = plan.builds[operation.startsWith("A_") ? 0 : 1]; return result(1, "", `Error: No such container: ${spec.name}\n`); }
      if (operation.endsWith("CREATE")) return result(0, `${ids[operation.startsWith("A_") ? "a" : "b"]}\n`);
      if (operation.endsWith("CREATED_INSPECT")) { const spec = plan.builds[operation.startsWith("A_") ? 0 : 1]; const id = ids[spec.label]; return result(0, JSON.stringify([createdContainer({ ...spec, sourceDir: plan.sourceDir }, id)])); }
      if (operation.endsWith("START_ATTACH")) return result(0);
      if (operation.endsWith("EXITED_INSPECT")) { const spec = plan.builds[operation.startsWith("A_") ? 0 : 1]; return result(0, JSON.stringify([exitedContainer(spec, ids[spec.label])])); }
      if (operation.endsWith("RM_FORCE")) return result(0);
      if (operation.endsWith("ABSENCE_AFTER")) { const spec = plan.builds[operation.startsWith("A_") ? 0 : 1]; return result(1, "", `Error: No such container: ${ids[spec.label]}\n`); }
      throw new Error(operation);
    },
    validateDaemon() {}, validateMountPaths() {}, validateSourceExact() {}, validateOutputEmpty() {},
    validateOutputExact() { return { bytes: executor.OUTPUT_BYTES, sha256: executor.OUTPUT_SHA256 }; }, validateFinalPaths() {}, validatePublishedExact() { return { bytes: executor.OUTPUT_BYTES, sha256: executor.OUTPUT_SHA256 }; }, ...override.io };
  try { return { value: internal.runWorkflow(io, authId), calls, journals, error: null }; } catch (error) { return { value: null, calls, journals, error }; }
}

test("exports pure helpers only; instrumented state machine is not production export", () => {
  assert.equal(Object.hasOwn(executor, "runWorkflow"), false); assert.equal(Object.hasOwn(executor, "executeFixed"), false); assert.equal(Object.hasOwn(executor, "main"), false);
  assert.equal(typeof internal.runWorkflow, "function"); assert.equal(SOURCE.includes("testHook"), false); assert.equal(SOURCE.includes("internalOptions"), false);
});

test("authorization cites bounded sentence plus please, never bare please alone", () => {
  const auth = authorization(); executor.validateAuthorizationValue(auth);
  assert.equal(auth.authorizationBasis.userAcceptance, "please"); assert.match(auth.authorizationBasis.interpretationRule, /NOT_BARE_PLEASE_ALONE/); assert.match(auth.authorizationBasis.immediatelyPrecedingBoundedSentence, /fresh current-turn authorization/); assert.match(auth.authorizationBasis.immediatelyPrecedingBoundedSentence, /No live protocol actions, signing, or detector execution/);
  const bare = clone(auth); bare.authorizationBasis.immediatelyPrecedingBoundedSentence = "please"; assert.throws(() => executor.validateAuthorizationValue(bare));
});

test("absence accepts exact Docker 29.6.1 no-such-container only", () => {
  assert.equal(executor.classifyExactAbsence(result(1, "", "Error: No such container: exact\n"), "exact"), true);
  const failures = [result(1, "", "permission denied\n"), result(1, "", "Cannot connect to the Docker daemon\n"), result(1, "", "context deadline exceeded\n"), result(1, "", "protocol error\n"), result(2, "", "Error: No such container: exact\n"), { status: null, stdout: "", stderr: "Error: No such container: exact\n", signal: null, error: null }, { status: "1", stdout: "", stderr: "Error: No such container: exact\n", signal: null, error: null }, result(1, "extra", "Error: No such container: exact\n")];
  for (const value of failures) assert.throws(() => executor.classifyExactAbsence(value, "exact"));
});

test("create output requires full lowercase 64-hex ID", () => {
  const id = "a".repeat(64); assert.equal(executor.parseCreateId(result(0, `${id}\n`)), id);
  for (const stdout of [id, `${id}\nextra`, `${"A".repeat(64)}\n`, `${"a".repeat(63)}\n`, `sha256:${id}\n`, ""]) assert.throws(() => executor.parseCreateId(result(0, stdout)));
});

test("plan fixes 17 operations, format absence, ID factories and timeouts", () => {
  const plan = executor.buildPlan("<c>", "<r>", "1".repeat(32)); assert.deepEqual(plan.operationOrder, executor.OPERATION_ORDER); assert.equal(plan.maxCalls, 17); assert.equal(plan.adminTimeoutMs, 30000); assert.equal(plan.buildTimeoutMs, 1800000);
  for (const build of plan.builds) { assert.deepEqual(build.absenceBeforeArgv.slice(-4), ["inspect", "--format", "{{.Id}}", build.name]); const id = "f".repeat(64); for (const argv of [build.createdInspectById(id), build.startById(id), build.exitedInspectById(id), build.removeById(id), build.absenceAfterById(id)]) assert.equal(argv.includes(id), true); assert.equal(build.createArgv.includes("SOURCE_DATE_EPOCH"), false); }
});

test("actual fake workflow succeeds with exact 17 calls and observed starts only at exit", () => {
  const run = fakeWorkflow(); assert.equal(run.error, null); assert.deepEqual(run.calls, executor.OPERATION_ORDER); assert.equal(run.value.counters.processCalls, 17); assert.equal(run.value.counters.startAttachSuccess, 2); assert.equal(run.value.counters.daemonObservedStarts, 2); assert.deepEqual(run.value.counters, executor.SUCCESS_COUNTERS_BEFORE_COMMIT);
  const startAfter = run.journals.filter((row) => row.phase === "after" && row.operation.endsWith("START_ATTACH")); assert.deepEqual(startAfter.map((row) => row.counters.daemonObservedStarts), [0, 1]);
});

test("every actual workflow operation failure remains within cap and each operation once", () => {
  for (const operation of executor.OPERATION_ORDER) {
    const run = fakeWorkflow(operation); assert.notEqual(run.error, null, operation); assert.equal(run.calls.length <= 17, true, operation); assert.equal(new Set(run.calls).size, run.calls.length, operation);
    if (operation.startsWith("A_")) assert.equal(run.calls.some((name) => name.startsWith("B_")), false, operation);
  }
});

test("failed create has no ID and cannot spend duplicate cleanup", () => {
  const run = fakeWorkflow("A_CREATE"); assert.deepEqual(run.calls, ["VERSION", "INFO", "IMAGE_INSPECT", "A_ABSENCE_BEFORE", "A_CREATE"]); assert.equal(run.error.message, "BUILD_A_FAILED_NO_BUILD_B");
});

test("post-create failure cleans by ID once and exact ID absence once", () => {
  const run = fakeWorkflow("A_CREATED_INSPECT"); assert.deepEqual(run.calls.slice(-2), ["A_RM_FORCE", "A_ABSENCE_AFTER"]); assert.equal(run.calls.filter((x) => x === "A_RM_FORCE").length, 1); assert.equal(run.calls.filter((x) => x === "A_ABSENCE_AFTER").length, 1);
});

test("created inspect binds ID name labels and exact created state", () => {
  const plan = executor.buildPlan("<c>", "C:\\safe\\run", authorization().authorizationId); const spec = { ...plan.builds[0], sourceDir: plan.sourceDir }; const id = "a".repeat(64); const good = createdContainer(spec, id); internal.validateCreatedInspect(good, spec, id);
  const mutations = [(x) => { x.Id = "b".repeat(64); }, (x) => { x.Name = "/wrong"; }, (x) => { x.Config.Labels["pal.authorization"] = "wrong"; }, (x) => { x.State.Status = "running"; }, (x) => { x.State.Running = true; }, (x) => { x.State.StartedAt = "2026-08-12T00:00:00Z"; }];
  for (const mutate of mutations) { const value = clone(good); mutate(value); assert.throws(() => internal.validateCreatedInspect(value, spec, id), /CREATED_CONFIG_INVALID/); }
});

test("exited inspect binds identity labels and timestamp evidence", () => {
  const spec = executor.buildPlan("<c>", "C:\\safe\\run", authorization().authorizationId).builds[0]; const id = "a".repeat(64); const good = exitedContainer(spec, id); internal.validateExitedInspect(good, spec, id);
  const mutations = [(x) => { x.Id = "b".repeat(64); }, (x) => { x.Name = "/wrong"; }, (x) => { x.State.Running = true; }, (x) => { x.State.Status = "created"; }, (x) => { x.State.ExitCode = 1; }, (x) => { x.State.StartedAt = "0001-01-01T00:00:00Z"; }, (x) => { x.State.FinishedAt = "bad"; }, (x) => { x.State.FinishedAt = "2026-08-12T00:59:59Z"; }];
  for (const mutate of mutations) { const value = clone(good); mutate(value); assert.throws(() => internal.validateExitedInspect(value, spec, id), /EXIT_EVIDENCE_INVALID/); }
});

test("path and source validation occurs after creation, immediately pre-mount and final", () => {
  const run = fakeWorkflow(null, { io: { validateMountPaths(label, phase) { this.pathEvents ||= []; this.pathEvents.push(`${label}:${phase}`); } } }); assert.equal(run.error, null);
  assert.equal((SOURCE.match(/io\.validateMountPaths\(spec\.label/g) || []).length, 2); assert.match(SOURCE, /io\.validateSourceExact\(\); io\.validateFinalPaths\(\)/); assert.match(SOURCE, /assert\.deepEqual\(fs\.readdirSync\(sourceDir\)\.sort\(\), \["parser\.c", "tree_sitter"\]\)/);
});

test("output listing is exact and final A B published rehash immediately precedes equality", () => {
  assert.match(SOURCE, /assert\.deepEqual\(listing, empty \? \[\] : \[OUTPUT_NAME\]/); const workflow = SOURCE.slice(SOURCE.indexOf("function runWorkflow"), SOURCE.indexOf("function validateDecisionValue"));
  const finalIndex = workflow.indexOf("const finalA = io.validateOutputExact"); const equalityIndex = workflow.indexOf("assert.deepEqual([finalA, finalB, published]"); assert.equal(finalIndex >= 0 && finalIndex < equalityIndex, true); assert.equal(workflow.lastIndexOf("io.validateSourceExact()") < finalIndex, true);
});

test("correction-v2 semantics remain exact and adversarial input fails closed", () => {
  for (const user of [undefined, null, ""]) { const image = fixture(); if (user === undefined) delete image.Config.User; else image.Config.User = user; image.Config.Cmd = null; executor.validateImageInspectPure(image); }
  for (const value of ["root", 0, false, [], {}]) { const image = fixture(); image.Config.User = value; assert.throws(() => executor.validateImageInspectPure(image)); }
  for (const cmd of [undefined, null]) { const image = fixture(); if (cmd === undefined) delete image.Config.Cmd; else image.Config.Cmd = cmd; image.Config.User = ""; executor.validateImageInspectPure(image); }
  for (const value of [[], "", false, 0, {}]) { const image = fixture(); image.Config.Cmd = value; assert.throws(() => executor.validateImageInspectPure(image)); }
  let calls = 0; const tripwire = fixture(); Object.defineProperty(tripwire.Config, "Trap", { enumerable: true, get() { calls += 1; return 1; } }); assert.throws(() => executor.validateImageInspectPure(tripwire)); assert.equal(calls, 0);
});

function fakeBindings() { const out = { authorization: authorization() }; for (const [index, key] of executor.CONSUMPTION_BINDING_KEYS.entries()) out[key] = ((index + 1) % 16).toString(16).repeat(64); return out; }
test("decision and final validators reject wrapper-value extras and incomplete bindings", () => {
  const bindings = fakeBindings(); const baseKeys = executor.CONSUMPTION_BINDING_KEYS.slice(0, executor.CONSUMPTION_BINDING_KEYS.indexOf("decisionSha256")); const decision = { schema: `${executor.NAMESPACE}/review-decision-v1`, status: "APPROVED_UNCHANGED_FOR_ONE_CONDITIONAL_EXECUTION", authorizationId: bindings.authorization.authorizationId, executorNamespace: executor.NAMESPACE, bindings: Object.fromEntries(baseKeys.map((key) => [key, bindings[key]])), scope: bindings.authorization.scope, verdict: "ORACLE_APPROVE_UNCHANGED_CONDITIONAL_ONE_SHOT" }; executor.validateDecisionValue(decision, bindings); const extra = clone(decision); extra.extra = true; assert.throws(() => executor.validateDecisionValue(extra, bindings)); const missing = clone(decision); delete missing.bindings[baseKeys[0]]; assert.throws(() => executor.validateDecisionValue(missing, bindings));
  const finalKeys = executor.CONSUMPTION_BINDING_KEYS.filter((key) => !["finalAuthoritySha256", "finalDetachedChecksumSha256"].includes(key)); const final = { schema: `${executor.NAMESPACE}/final-execution-authority-v1`, status: "FINAL_ONE_SHOT_TWO_BUILD_EXECUTION_AUTHORITY", authorizationId: bindings.authorization.authorizationId, executorNamespace: executor.NAMESPACE, bindings: Object.fromEntries(finalKeys.map((key) => [key, bindings[key]])), scope: bindings.authorization.scope, oracleDisposition: "ORACLE_FINAL_APPROVE_ONE_CONDITIONAL_EXECUTION", oneShot: { consumeBeforeFirstDockerCall: true, noRetry: true, hardMaximumCallsAllPaths: 17, noBuildBAfterBuildAFailure: true } }; executor.validateFinalAuthorityValue(final, bindings); final.bindings.extra = "0".repeat(64); assert.throws(() => executor.validateFinalAuthorityValue(final, bindings));
});

test("source enforces exact wrapper schemas statuses and keys", () => {
  for (const text of ["INDEPENDENT_REVIEW_APPROVED_ONE_CONDITIONAL_EXECUTION", "FINAL_AUTHORITY_PACKAGE_APPROVED", "review-decision-authority-v1", "final-authority-package-v1", "decisionAuthoritySha256"]) assert.equal(SOURCE.includes(text), true, text);
  assert.equal((SOURCE.match(/exactKeys\(wrapper/g) || []).length >= 4, true);
});

test("marker ordering and precommit counters avoid self-reference and dual markers", () => {
  const execute = SOURCE.slice(SOURCE.indexOf("function executeFixed"), SOURCE.indexOf("function runDefault")); const finalJournal = execute.indexOf('journal.append("final", "SUCCESS_READY_TO_COMMIT"'); const close = execute.indexOf("journal.close()", finalJournal); const marker = execute.indexOf('writeMarker(staged.runRoot, "success.json"', close); assert.equal(finalJournal < close && close < marker, true);
  const markerFn = SOURCE.slice(SOURCE.indexOf("function writeMarker"), SOURCE.indexOf("function validateExactSourceDirectory")); assert.match(markerFn, /filename === "success\.json" \? "failure\.json" : "success\.json"/); assert.equal(execute.includes("countersBeforeCommit"), true); assert.equal(execute.indexOf("counters.failureMarkerWrites += 1") > execute.indexOf('writeMarker(staged.runRoot, "failure.json"'), true);
});

test("post-consumption env rejection is inside terminal handler", () => {
  const execute = SOURCE.slice(SOURCE.indexOf("function executeFixed"), SOURCE.indexOf("function runDefault")); assert.equal(execute.indexOf("stageAndConsume(bindings)") < execute.indexOf("try {"), true); assert.equal(execute.indexOf("sanitizedDockerEnv") > execute.indexOf("try {"), true); assert.equal(execute.includes('writeMarker(staged.runRoot, "failure.json"'), true);
});

test("production source has pre-spawn guard, attempted flags and exact timeout split", () => {
  assert.equal(SOURCE.indexOf("context.counters.processCalls < MAX_CALLS") < SOURCE.indexOf("context.io.docker(operation"), true); assert.match(SOURCE, /context\.attempted\[operation\], false/); assert.match(SOURCE, /operation\.endsWith\("START_ATTACH"\) \? BUILD_TIMEOUT_MS : ADMIN_TIMEOUT_MS/); assert.equal(executor.ADMIN_TIMEOUT_MS, 30000); assert.equal(executor.BUILD_TIMEOUT_MS, 1800000);
});

test("raw bodies remain memory-only and journals contain no body/path/argv/env", () => {
  assert.equal(SOURCE.includes("result.stderr"), true); assert.equal(SOURCE.includes("writeFileSync(result.stderr"), false); assert.equal(SOURCE.includes("writeFileSync(result.stdout"), false);
  const journal = SOURCE.slice(SOURCE.indexOf("function openJournal"), SOURCE.indexOf("function sanitizedDockerEnv")); for (const forbidden of ["stdout", "stderr", "argv", "env", "sourceDir", "outputDir"]) assert.equal(journal.includes(forbidden), false, forbidden);
});

test("fixed production main and absent authorities block exact flag without hooks", () => {
  assert.match(SOURCE, /function main\(argv\)/); assert.match(SOURCE, /main\(process\.argv\.slice\(2\)\)/); assert.equal(SOURCE.includes('throw new Error("REVIEW_DECISION_REQUIRED")'), true); assert.equal(SOURCE.includes("options = {}"), false); assert.equal(SOURCE.includes("spawnSync:"), false);
});

test("pure exported APIs make zero process calls and writes", () => {
  const spawn = childProcess.spawnSync; const writes = [fs.writeSync, fs.mkdirSync, fs.renameSync]; let calls = 0; let writeCount = 0; childProcess.spawnSync = () => { calls += 1; throw new Error("FORBIDDEN"); }; fs.writeSync = () => { writeCount += 1; throw new Error("FORBIDDEN"); }; fs.mkdirSync = () => { writeCount += 1; throw new Error("FORBIDDEN"); }; fs.renameSync = () => { writeCount += 1; throw new Error("FORBIDDEN"); };
  try { executor.buildPlan(); executor.classifyExactAbsence(result(1, "", "Error: No such container: x\n"), "x"); executor.parseCreateId(result(0, `${"a".repeat(64)}\n`)); executor.validateAuthorizationValue(authorization()); assert.equal(calls, 0); assert.equal(writeCount, 0); }
  finally { childProcess.spawnSync = spawn; [fs.writeSync, fs.mkdirSync, fs.renameSync] = writes; }
});

test("rejected v1 and correction-v2 bindings are represented", () => {
  for (const key of ["rejectedV1ExecutorSha256", "rejectedV1PackageSha256", "rejectedV1AuthoritySha256", "correctionV2PackageSha256", "correctionV2AuthoritySha256", "publishedWasmSha256"]) assert.equal(executor.CONSUMPTION_BINDING_KEYS.includes(key), true);
  assert.equal(executor.CONSUMPTION_BINDING_KEYS.length, 23);
});
