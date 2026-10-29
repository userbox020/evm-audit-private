"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const v24 = require("./run-profitable-async-liability-solidity-builder-v23-comparator-two-clean-build-executor-v24.js");
const v23 = require("./run-profitable-async-liability-solidity-builder-cache-bind-aware-created-inspect-comparator-v23.js");

const temps = [];
const RECEIPTS = { A: "a".repeat(64), B: "b".repeat(64) };
const WASM = Buffer.from("v24-wasm");
const EXPECTED = Object.freeze({ bytes: WASM.length, sha256: crypto.createHash("sha256").update(WASM).digest("hex") });
test.after(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture(options = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "v21-v24-")); temps.push(workspace);
  const packageRoot = path.join(workspace, "package"); fs.mkdirSync(packageRoot);
  if (options.existingRuns) fs.mkdirSync(path.join(packageRoot, "runs"));
  const sources = path.join(workspace, "sources"); fs.mkdirSync(sources); fs.mkdirSync(path.join(sources, "tree_sitter"));
  const parser = Buffer.from("parser-v24"), header = Buffer.from("header-v24"); fs.writeFileSync(path.join(sources, "parser.c"), parser); fs.writeFileSync(path.join(sources, "tree_sitter", "parser.h"), header);
  const sourceRecords = [
    { path: "sources/parser.c", stage: "parser.c", bytes: parser.length, sha256: crypto.createHash("sha256").update(parser).digest("hex") },
    { path: "sources/tree_sitter/parser.h", stage: "tree_sitter/parser.h", bytes: header.length, sha256: crypto.createHash("sha256").update(header).digest("hex") }
  ];
  return { workspace, packageRoot, sourceRecords };
}
function lifecycleFixture(options = {}) {
  const f = fixture(options), state = v24.freshState(), lifecycle = v24.createTestLifecycleV24(v24.AUTHORIZATION_ID, state, { testMode: true, fs, workspace: f.workspace, packageRoot: f.packageRoot, sourceRecords: f.sourceRecords, expectedOutput: EXPECTED, limits: options.limits, beforeSuccessCommit: options.beforeSuccessCommit });
  return { ...f, state, lifecycle };
}
function adapterFor(lifecycle, options = {}) {
  const seen = [];
  return {
    seen,
    adapter: { call(op) {
      seen.push(op);
      const upper = op.startsWith("B_") ? "B" : "A", receipt = RECEIPTS[upper], spec = lifecycle.plan.builds[upper === "A" ? 0 : 1];
      if (options.onCall) options.onCall(op, spec, lifecycle);
      if (op.endsWith("_CREATE")) return ok(`${receipt}\n`);
      if (op.endsWith("_CREATED_INSPECT")) return ok(JSON.stringify([options.createdInspect ? options.createdInspect(spec, receipt) : { Id: receipt }]));
      if (op.endsWith("_START_ATTACH")) { fs.writeFileSync(path.join(spec.output, v24.OUTPUT_NAME), WASM); return ok(); }
      if (op.endsWith("_EXITED_INSPECT")) return ok(JSON.stringify([{ Id: receipt }]));
      return ok("{}");
    } }
  };
}
function ok(stdout = "") { return { status: 0, signal: null, error: null, stdout, stderr: "" }; }
function workflowIO(lifecycle, state, adapter, overrides = {}) {
  return { testMode: true, state, budgets: lifecycle.budgets, runRoot: lifecycle.runRoot, config: lifecycle.config, adapter, journal: lifecycle.journal, validateIdentities: lifecycle.validateIdentities, validateCleanup: lifecycle.validateCleanup, assertFreshSlot: lifecycle.assertFreshSlot, verifyOutput: lifecycle.verifyOutput, expectedOutput: EXPECTED, validateQualification() {}, compareCreated() { return { match: true, mismatchCodes: [], representationNotes: [] }; }, compareExited() { return { match: true, mismatchCodes: [], representationNotes: [] }; }, ...overrides };
}
function finishFailure(lifecycle, error) { try { lifecycle.terminal(false, { rootCauseCode: error.message }); } catch {} }
function binding(name) { const bytes = Buffer.from(name); return { path: name, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") }; }
function fileRecord(file, display) { const bytes = fs.readFileSync(file); return { path: display, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") }; }
function writeContractRoot(workspace, spec, payload, wrapperFactory) {
  const root = path.join(workspace, ...spec.root.split("/")); fs.mkdirSync(root, { recursive: true }); const payloadPath = path.join(root, spec.payload); fs.writeFileSync(payloadPath, JSON.stringify(payload)); const payloadRecord = fileRecord(payloadPath, spec.payload), wrapper = wrapperFactory(payloadRecord), wrapperPath = path.join(root, "authority-manifest.json"); fs.writeFileSync(wrapperPath, JSON.stringify(wrapper)); const wrapperRecord = fileRecord(wrapperPath, "authority-manifest.json"), detachedPath = path.join(root, "authority-manifest.sha256"); fs.writeFileSync(detachedPath, `${wrapperRecord.sha256}  authority-manifest.json\n`); return { payload: payloadRecord, wrapper: wrapperRecord, detached: fileRecord(detachedPath, "authority-manifest.sha256"), root, payloadPath };
}
function authorityFixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "v21-v24-authority-")); temps.push(workspace); const packageRoot = path.join(workspace, "tools", "vendor", v24.NAMESPACE); fs.mkdirSync(packageRoot, { recursive: true });
  const bindings = { runner: binding("runner"), tests: binding("tests"), report: binding("report"), policy: binding("policy"), packageManifest: binding("package-manifest"), packageAuthority: binding("package-authority"), packageDetached: binding("package-detached") }, base = { sealedBindings: bindings }, scope = v24.authorityScopeV24(), now = Date.now(), assistantRequestText = `Authorize one-shot no-retry ${v24.EXACT_COMMAND} with ${v24.AUTHORIZATION_ID}`, userResponseText = v24.STANDING_USER_RESPONSE_TEXT;
  const authorization = { schema: `${v24.NAMESPACE}/execution-authorization-transcript-pair-v1`, status: "EXACT_TRANSCRIPT_PAIR_ONE_SHOT_EXECUTION_AUTHORIZATION", authorizationId: v24.AUTHORIZATION_ID, executorNamespace: v24.NAMESPACE, authorizedAtUtc: new Date(now).toISOString(), currentTurn: true, exactCommand: v24.EXACT_COMMAND, assistantRequestText, assistantRequestBytes: Buffer.byteLength(assistantRequestText), assistantRequestSha256: crypto.createHash("sha256").update(assistantRequestText).digest("hex"), userResponseText, userResponseBytes: Buffer.byteLength(userResponseText), userResponseSha256: crypto.createHash("sha256").update(userResponseText).digest("hex"), standingAuthorization: true, oneShot: true, noRetry: true, scope, bindings };
  const auth = writeContractRoot(workspace, v24.AUTHORITY_FILES[0], authorization, (payload) => ({ schema: `${v24.NAMESPACE}/execution-authorization-authority-v1`, status: "EXACT_FIXED_PACKAGE_AUTHORIZATION", payload, bindings }));
  const decision = { schema: `${v24.NAMESPACE}/review-decision-v1`, status: "INDEPENDENT_ORACLE_REVIEW", authorizationId: v24.AUTHORIZATION_ID, executorNamespace: v24.NAMESPACE, executionPayload: auth.payload, executionWrapper: auth.wrapper, executionDetached: auth.detached, assistantRequestBytes: authorization.assistantRequestBytes, assistantRequestSha256: authorization.assistantRequestSha256, userResponseBytes: authorization.userResponseBytes, userResponseSha256: authorization.userResponseSha256, reviewer: "ORACLE", verdict: "APPROVE_UNCHANGED_TRANSCRIPT_PAIR_ONE_SHOT_NO_RETRY", scope, bindings };
  const review = writeContractRoot(workspace, v24.AUTHORITY_FILES[1], decision, (payload) => ({ schema: `${v24.NAMESPACE}/review-decision-authority-v1`, status: "INDEPENDENT_ORACLE_REVIEW_PACKAGE", payload, executionPayload: auth.payload, executionWrapper: auth.wrapper, executionDetached: auth.detached, reviewer: "ORACLE", bindings }));
  const finalValue = { schema: `${v24.NAMESPACE}/final-execution-authority-v1`, status: "FINAL_INDEPENDENT_TRANSCRIPT_PAIR_ONE_SHOT_EXECUTION_AUTHORITY", authorizationId: v24.AUTHORIZATION_ID, executorNamespace: v24.NAMESPACE, executionPayload: auth.payload, executionWrapper: auth.wrapper, executionDetached: auth.detached, reviewPayload: review.payload, reviewWrapper: review.wrapper, reviewDetached: review.detached, assistantRequestSha256: authorization.assistantRequestSha256, userResponseSha256: authorization.userResponseSha256, currentTurn: true, oneShot: true, noRetry: true, reviewer: "ORACLE", verdict: "AUTHORIZE_EXACT_TRANSCRIPT_PAIR_COMMAND_ONCE_NO_RETRY", scope, bindings };
  const final = writeContractRoot(workspace, v24.AUTHORITY_FILES[2], finalValue, (payload) => ({ schema: `${v24.NAMESPACE}/final-authority-package-v1`, status: "FINAL_INDEPENDENT_ORACLE_AUTHORITY_PACKAGE", payload, executionPayload: auth.payload, executionWrapper: auth.wrapper, executionDetached: auth.detached, reviewPayload: review.payload, reviewWrapper: review.wrapper, reviewDetached: review.detached, reviewer: "ORACLE", bindings }));
  return { workspace, packageRoot, base, now, auth, review, final };
}

test("01 default import is zero capability", () => {
  const value = v24.main([]);
  assert.equal(value.status, "PASS"); assert.equal(value.processCalls, 0); assert.equal(value.writes, 0); assert.equal(value.consumed, false); assert.equal(value.networkCalls, 0);
});

test("02 exported V24 workflow succeeds with exact counters", () => {
  const { state, lifecycle } = lifecycleFixture(), mock = adapterFor(lifecycle);
  const result = v24.executeWorkflowV24(workflowIO(lifecycle, state, mock.adapter), v24.AUTHORIZATION_ID);
  assert.equal(result.schema, `${v24.NAMESPACE}/workflow-result-v1`); assert.equal(result.status, "PARSER_AUTHORITY_CANDIDATE_REPRODUCIBLE_EXACT_QUALIFIED_REFERENCE"); assert.equal(result.automaticPromotion, false); assert.equal(result.detectorRun, false);
  assert.deepEqual([state.processCalls, state.buildAttempts, state.successfulBuilds, state.cleanupAttempts, state.cleanupSuccesses, state.networkCalls], [13, 2, 2, 2, 2, 0]);
  assert.deepEqual(result.calls, v24.OPERATIONS); assert.equal(state.writes <= 64, true);
  const terminal = lifecycle.terminal(true, result); assert.equal(terminal.authoritative, "success.json"); assert.equal(state.terminal, terminal);
});

test("03 post-journal A_CREATE failure performs one cleanup call", () => {
  const { state, lifecycle } = lifecycleFixture(), mock = adapterFor(lifecycle); let thrown = false;
  const io = workflowIO(lifecycle, state, mock.adapter, { journal(phase, op, value) { lifecycle.journal(phase, op, value); if (!thrown && phase === "after" && op === "A_CREATE") { thrown = true; throw new Error("POST_JOURNAL_FAULT"); } } });
  let error; try { v24.executeWorkflowV24(io, v24.AUTHORIZATION_ID); } catch (caught) { error = caught; }
  assert.match(error.message, /POST_JOURNAL_FAULT/); assert.equal(error.op, "A_CREATE"); assert.equal(error.result.stdout, `${RECEIPTS.A}\n`);
  assert.equal(mock.seen.filter((op) => op === "A_RM_FORCE").length, 1); finishFailure(lifecycle, error);
});

test("04 active mount mutation blocks START but cleanup still runs", () => {
  const { state, lifecycle } = lifecycleFixture();
  const mock = adapterFor(lifecycle, { onCall(op, spec) { if (op === "A_CREATED_INSPECT") fs.writeFileSync(path.join(spec.work, "pollution"), "x"); } });
  let error; try { v24.executeWorkflowV24(workflowIO(lifecycle, state, mock.adapter), v24.AUTHORIZATION_ID); } catch (caught) { error = caught; }
  assert.match(error.message, /STAGED_SOURCE_LISTING_CHANGED/); assert.equal(mock.seen.includes("A_START_ATTACH"), false); assert.equal(mock.seen.filter((op) => op === "A_RM_FORCE").length, 1); finishFailure(lifecycle, error);
});

test("05 inactive B pollution is scoped and blocks only when B becomes active", () => {
  const { state, lifecycle } = lifecycleFixture();
  const mock = adapterFor(lifecycle, { onCall(op) { if (op === "A_CREATED_INSPECT") fs.writeFileSync(path.join(lifecycle.plan.builds[1].output, "intruder"), "x"); } });
  let error; try { v24.executeWorkflowV24(workflowIO(lifecycle, state, mock.adapter), v24.AUTHORIZATION_ID); } catch (caught) { error = caught; }
  assert.match(error.message, /OUTPUT_NOT_EMPTY/); assert.equal(mock.seen.includes("A_START_ATTACH"), true); assert.equal(mock.seen.includes("A_RM_FORCE"), true); assert.equal(mock.seen.includes("B_CREATE"), false); finishFailure(lifecycle, error);
});

test("06 B pollution after A cleanup blocks directly before B CREATE", () => {
  const { state, lifecycle } = lifecycleFixture();
  const mock = adapterFor(lifecycle, { onCall(op) { if (op === "A_RM_FORCE") fs.writeFileSync(path.join(lifecycle.plan.builds[1].output, "intruder"), "x"); } });
  let error; try { v24.executeWorkflowV24(workflowIO(lifecycle, state, mock.adapter), v24.AUTHORIZATION_ID); } catch (caught) { error = caught; }
  assert.match(error.message, /OUTPUT_NOT_EMPTY/); assert.equal(mock.seen.includes("A_RM_FORCE"), true); assert.equal(mock.seen.includes("B_CREATE"), false); finishFailure(lifecycle, error);
});

test("07 centralized process cap blocks before sixteenth process", () => {
  const state = v24.freshState({ processCalls: 15 }), budgets = v24.createBudgetsV24(state), seen = [];
  const io = { testMode: true, state, budgets, config: "cfg", runRoot: path.resolve("v24-process-cap"), journal() {}, validateIdentities() {}, validateCleanup() {}, assertFreshSlot() {}, adapter: { call(op) { seen.push(op); return ok("{}"); } }, validateQualification() {}, compareCreated() { return { match: true }; }, compareExited() { return { match: true }; }, verifyOutput() { return { ...EXPECTED, content: WASM }; }, expectedOutput: EXPECTED };
  assert.throws(() => v24.executeWorkflowV24(io, v24.AUTHORIZATION_ID), /PROCESS_BUDGET_EXCEEDED/); assert.equal(state.processCalls, 15); assert.equal(seen.length, 0);
});

test("08 centralized write cap blocks all later writes", () => {
  const f = fixture(), state = v24.freshState({ writes: 64 });
  assert.throws(() => v24.createTestLifecycleV24(v24.AUTHORIZATION_ID, state, { testMode: true, fs, workspace: f.workspace, packageRoot: f.packageRoot, sourceRecords: f.sourceRecords, expectedOutput: EXPECTED }), /WRITE_BUDGET_EXCEEDED/);
  assert.equal(state.writes, 64); assert.equal(fs.existsSync(path.join(f.packageRoot, "runs")), false);
});

test("09 runs parent creation is counted", () => {
  const absent = lifecycleFixture(), present = lifecycleFixture({ existingRuns: true });
  assert.equal(absent.state.writes, present.state.writes + 1); assert.equal(fs.existsSync(path.join(absent.packageRoot, "runs")), true);
  absent.lifecycle.terminal(false, { rootCauseCode: "TEST" }); present.lifecycle.terminal(false, { rootCauseCode: "TEST" });
});

test("10 unsafe symlink runs parent is rejected", (t) => {
  const f = fixture(), elsewhere = path.join(f.workspace, "elsewhere"); fs.mkdirSync(elsewhere);
  try { fs.symlinkSync(elsewhere, path.join(f.packageRoot, "runs"), "junction"); } catch (error) { if (error.code === "EPERM") { t.skip("symlink privilege unavailable"); return; } throw error; }
  const state = v24.freshState(); assert.throws(() => v24.createTestLifecycleV24(v24.AUTHORIZATION_ID, state, { testMode: true, fs, workspace: f.workspace, packageRoot: f.packageRoot, sourceRecords: f.sourceRecords, expectedOutput: EXPECTED }), /PATH_SYMLINK_OR_REPARSE/); assert.equal(state.consumed, false);
});

test("11 success commit failure leaves one authoritative failure terminal", () => {
  const { state, lifecycle } = lifecycleFixture({ beforeSuccessCommit() { throw new Error("COMMIT_INJECTED"); } });
  const terminal = lifecycle.terminal(true, { status: "WOULD_PASS" });
  assert.equal(terminal.authoritative, "failure.json"); assert.equal(terminal.value.value.rootCauseCode, "COMMIT_INJECTED");
  assert.equal(fs.existsSync(path.join(lifecycle.runRoot, "success.json")), false); assert.equal(fs.existsSync(path.join(lifecycle.runRoot, "failure.json")), true);
  assert.equal(v24.readTerminalV24(lifecycle.runRoot).authoritative, "failure.json"); assert.equal(state.terminal.authoritative, "failure.json");
});

test("12 deterministic cleanup name is used when CREATE receipt is malformed", () => {
  const { state, lifecycle } = lifecycleFixture(), mock = adapterFor(lifecycle); const original = mock.adapter.call;
  mock.adapter.call = (op, argv, timeout) => op === "A_CREATE" ? (mock.seen.push(op), ok("malformed")) : original(op, argv, timeout);
  const result = v24.executeWorkflowV24(workflowIO(lifecycle, state, mock.adapter), v24.AUTHORIZATION_ID);
  assert.equal(result.status, "PARSER_AUTHORITY_CANDIDATE_REPRODUCIBLE_EXACT_QUALIFIED_REFERENCE"); assert.equal(state.cleanupSuccesses, 2); lifecycle.terminal(true, result);
});

test("13 V24 plan has sealed tmpfs, host cache, no network, and V24 labels", () => {
  const plan = v24.buildPlanV24("cfg", path.resolve("v24-plan"), v24.AUTHORIZATION_ID);
  for (const spec of plan.builds) {
    assert.equal(spec.name.startsWith(`pal-v24-${v24.AUTHORIZATION_ID}-`), true); assert.equal(spec.labels["pal.executor"], v24.NAMESPACE);
    assert.equal(spec.create.includes("none"), true); assert.equal(spec.create.includes("never"), true); assert.equal(spec.create.includes("/tmp:rw,nosuid,nodev,size=268435456"), true); assert.equal(spec.create.includes("/home/nonroot:rw,noexec,nosuid,nodev,size=33554432"), true); assert.equal(spec.create.some((value) => typeof value === "string" && value.includes("dst=/cache")), true);
    for (const stale of ["v21-r2", "v21-r3", "v21-r4", "v21-r5", "v21-r6", "pal-v21r2", "pal-v21r3", "pal-v21r4", "pal-v21r5", "pal-v21r6"]) assert.equal(spec.name.includes(stale) || Object.values(spec.labels).some((value) => String(value).includes(stale)), false);
  }
});

test("14 exact output descriptor validates content and rejects extras", () => {
  const f = fixture(), out = path.join(f.workspace, "out"); fs.mkdirSync(out); fs.writeFileSync(path.join(out, v24.OUTPUT_NAME), WASM);
  const value = v24.outputDescriptorV24(out, f.workspace, fs, EXPECTED); assert.equal(value.content.equals(WASM), true);
  fs.writeFileSync(path.join(out, "extra"), "x"); assert.throws(() => v24.outputDescriptorV24(out, f.workspace, fs, EXPECTED), /OUTPUT_INVALID/);
});

test("15 package, dependencies, image, V23/V15, and ac4d binding are sealed", () => {
  const sealed = v24.validatePackageV24(); assert.equal(sealed.manifest.dependencyRecords.length, 38); assert.equal(v24.V24_BOUND_RECORDS.length, 12); assert.equal(v24.OUTPUT.sha256, "ac4d44dc54b7a475c2284ae27ab0af932043e2cfd4e200a416b2ac5d40f433d7"); assert.equal(v24.IMAGE.includes("@sha256:"), true); assert.equal(v24.V23_CREATED.endsWith("v23"), true); assert.equal(v24.V15.endsWith("v15"), true);
});

test("16 invalid arguments fail without entering reserved production mode", () => {
  assert.throws(() => v24.main(["--not-production"]), /ARGUMENTS_REJECTED/); assert.equal(process.argv.includes(v24.EXECUTE_FLAG), false);
});

test("17 fixed three-package authority contract validates exact chain", () => {
  const f = authorityFixture(), value = v24.validateAuthorityV24(f.base, f.workspace, fs, f.now);
  assert.equal(value.authorization.payload.authorizationId, v24.AUTHORIZATION_ID); assert.equal(value.authorization.payload.userResponseText, v24.STANDING_USER_RESPONSE_TEXT); assert.equal(value.review.payload.reviewer, "ORACLE"); assert.equal(value.final.payload.verdict, "AUTHORIZE_EXACT_TRANSCRIPT_PAIR_COMMAND_ONCE_NO_RETRY");
});

test("18 missing fixed authority root is AUTHORITY_REQUIRED", () => {
  const f = authorityFixture(); fs.rmSync(f.review.root, { recursive: true, force: true }); assert.throws(() => v24.validateAuthorityV24(f.base, f.workspace, fs, f.now), /^Error: AUTHORITY_REQUIRED$/);
});

test("19 tampered authority payload fails closed", () => {
  const f = authorityFixture(), value = JSON.parse(fs.readFileSync(f.review.payloadPath, "utf8")); value.verdict = "TAMPERED"; fs.writeFileSync(f.review.payloadPath, JSON.stringify(value)); assert.throws(() => v24.validateAuthorityV24(f.base, f.workspace, fs, f.now));
});

test("20 direct production prerequisite guard requires authority before dependencies", () => {
  assert.throws(() => v24.validateProductionPrerequisitesV24(), /AUTHORITY_REQUIRED/); assert.equal(Object.hasOwn(v24, "executeProductionV24"), false); assert.equal(Object.hasOwn(v24, "orchestrateV24"), false);
});

test("21 transitive diagnostic tamper blocks before first deferred require", () => {
  const workspace = path.resolve(__dirname, ".."), target = path.join(workspace, "tools", "run-profitable-async-liability-solidity-builder-image-inspect-diagnostic-v2.js"), proxy = Object.create(fs); let loads = 0;
  proxy.readFileSync = (file, ...args) => path.resolve(file) === path.resolve(target) ? Buffer.from("tampered") : fs.readFileSync(file, ...args);
  assert.throws(() => v24.loadDependenciesV24(workspace, proxy, () => { loads += 1; return {}; }), /DEPENDENCY_SEAL/); assert.equal(loads, 0);
});

test("22 CREATE preprocess failure never arms cleanup", () => {
  const { state, lifecycle } = lifecycleFixture(), mock = adapterFor(lifecycle), original = lifecycle.validateIdentities;
  const io = workflowIO(lifecycle, state, mock.adapter, { validateIdentities(op) { if (op === "A_CREATE") throw new Error("CREATE_PREPROCESS_FAILED"); original(op); } });
  let error; try { v24.executeWorkflowV24(io, v24.AUTHORIZATION_ID); } catch (caught) { error = caught; }
  assert.match(error.message, /CREATE_PREPROCESS_FAILED/); assert.equal(mock.seen.includes("A_CREATE"), false); assert.equal(mock.seen.includes("A_RM_FORCE"), false); finishFailure(lifecycle, error);
});

test("23 post-call CREATE journal fault retains result and cleanup", () => {
  const { state, lifecycle } = lifecycleFixture(), mock = adapterFor(lifecycle); let once = false;
  const io = workflowIO(lifecycle, state, mock.adapter, { journal(phase, op, value) { lifecycle.journal(phase, op, value); if (!once && phase === "after" && op === "A_CREATE") { once = true; throw new Error("AFTER_CREATE_JOURNAL"); } } });
  let error; try { v24.executeWorkflowV24(io, v24.AUTHORIZATION_ID); } catch (caught) { error = caught; }
  assert.equal(error.result.stdout, `${RECEIPTS.A}\n`); assert.equal(mock.seen.filter((op) => op === "A_RM_FORCE").length, 1); finishFailure(lifecycle, error);
});

test("24 run-root fsync failure occurs after consumption and commits failure terminal", () => {
  const f = fixture(), state = v24.freshState(), proxy = Object.create(fs); let fsyncs = 0, failed = false;
  proxy.fsyncSync = (fd) => { fsyncs += 1; if (!failed && fsyncs === 3) { failed = true; const error = new Error("FSYNC_INJECTED"); error.code = "EIO"; throw error; } return fs.fsyncSync(fd); };
  let error; try { v24.createTestLifecycleV24(v24.AUTHORIZATION_ID, state, { testMode: true, fs: proxy, workspace: f.workspace, packageRoot: f.packageRoot, sourceRecords: f.sourceRecords, expectedOutput: EXPECTED }); } catch (caught) { error = caught; }
  assert.equal(state.consumed, true); assert.equal(error.lifecycleTerminal.authoritative, "failure.json"); assert.equal(v24.readTerminalV24(state.runRoot).value.value.rootCauseCode, "FSYNC_INJECTED");
});

test("25 lexical identity must match initial descriptor fstat", () => {
  const f = fixture(), out = path.join(f.workspace, "out"); fs.mkdirSync(out); fs.writeFileSync(path.join(out, v24.OUTPUT_NAME), WASM); const proxy = Object.create(fs); let first = true;
  proxy.fstatSync = (fd) => { const stat = fs.fstatSync(fd); if (!first) return stat; first = false; return new Proxy(stat, { get(target, property) { if (property === "dev") return typeof target.dev === "bigint" ? target.dev + 1n : target.dev + 1; const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; } }); };
  assert.throws(() => v24.outputDescriptorV24(out, f.workspace, proxy, EXPECTED), /OUTPUT_DESCRIPTOR_MISMATCH/);
});

test("26 populated completed A cache is allowed while B is fresh", () => {
  const { state, lifecycle } = lifecycleFixture(); const mock = adapterFor(lifecycle, { onCall(op) { if (op === "A_RM_FORCE") fs.writeFileSync(path.join(lifecycle.plan.builds[0].cache, "compiler-cache"), "ok"); } });
  const result = v24.executeWorkflowV24(workflowIO(lifecycle, state, mock.adapter), v24.AUTHORIZATION_ID); assert.equal(result.status, "PARSER_AUTHORITY_CANDIDATE_REPRODUCIBLE_EXACT_QUALIFIED_REFERENCE"); assert.equal(mock.seen.includes("B_CREATE"), true); lifecycle.terminal(true, result);
});

test("27 output byte buffers are mandatory and compared unconditionally", () => {
  const { state, lifecycle } = lifecycleFixture(), mock = adapterFor(lifecycle); const io = workflowIO(lifecycle, state, mock.adapter, { verifyOutput() { return { ...EXPECTED }; } });
  let error; try { v24.executeWorkflowV24(io, v24.AUTHORIZATION_ID); } catch (caught) { error = caught; }
  assert.match(error.message, /OUTPUT_A_BYTES_REQUIRED/); finishFailure(lifecycle, error);
});

test("28 workflow and lifecycle hooks require explicit test mode", () => {
  assert.throws(() => v24.executeWorkflowV24({ adapter: { call() {} } }, v24.AUTHORIZATION_ID), /WORKFLOW_MODE_REJECTED/); assert.throws(() => v24.createTestLifecycleV24(v24.AUTHORIZATION_ID, v24.freshState(), {}), /EXPLICIT_TEST_MODE_REQUIRED/);
});

test("29 transcript pair rejects any fabricated user response wording", () => {
  const f = authorityFixture(), value = JSON.parse(fs.readFileSync(f.auth.payloadPath, "utf8")); value.userResponseText += " altered"; value.userResponseBytes = Buffer.byteLength(value.userResponseText); value.userResponseSha256 = crypto.createHash("sha256").update(value.userResponseText).digest("hex"); fs.writeFileSync(f.auth.payloadPath, JSON.stringify(value)); assert.throws(() => v24.validateAuthorityV24(f.base, f.workspace, fs, f.now), /USER_RESPONSE_TEXT_INVALID/);
});

test("30 transcript request and bounded exclusions are exact", () => {
  const f = authorityFixture(), value = JSON.parse(fs.readFileSync(f.auth.payloadPath, "utf8")); value.assistantRequestText = "one-shot no-retry but missing exact identifiers"; value.assistantRequestBytes = Buffer.byteLength(value.assistantRequestText); value.assistantRequestSha256 = crypto.createHash("sha256").update(value.assistantRequestText).digest("hex"); fs.writeFileSync(f.auth.payloadPath, JSON.stringify(value)); assert.throws(() => v24.validateAuthorityV24(f.base, f.workspace, fs, f.now), /ASSISTANT_REQUEST_TEXT_INVALID/); assert.deepEqual(v24.authorityScopeV24().exclusions, v24.SCOPE_EXCLUSIONS);
});

function realisticCreated(spec, receipt, notes = []) { const wanted = v24.expectedCreatedV24(spec, receipt), labels = { ...wanted.labels }, environment = [...wanted.environment], topSource = (item) => item.source; if (notes.includes("EXTRA_NON_PAL_LABELS_PRESENT")) labels["com.example.runtime"] = "representation"; if (notes.includes("ENV_ORDER_ONLY")) environment.reverse(); return { Id: wanted.id, Name: wanted.name, Image: wanted.configDigest, Config: { Image: wanted.imageReference, Labels: labels, Env: environment, Entrypoint: wanted.entrypoint, Cmd: wanted.command, User: wanted.user, WorkingDir: wanted.workdir }, State: { Status: wanted.state.status, Running: wanted.state.running, StartedAt: wanted.state.startedAt }, HostConfig: { NetworkMode: wanted.host.networkMode, ReadonlyRootfs: wanted.host.readOnlyRootfs, Privileged: wanted.host.privileged, Devices: null, Memory: wanted.host.memory, MemorySwap: wanted.host.memorySwap, NanoCpus: wanted.host.nanoCpus, PidsLimit: wanted.host.pidsLimit, IpcMode: wanted.host.ipcMode, CgroupnsMode: wanted.host.cgroupnsMode, PidMode: wanted.host.pidMode, UTSMode: wanted.host.utsMode, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges=true"], Tmpfs: { ...wanted.host.tmpfs }, Mounts: wanted.mounts.map((item) => ({ Type: item.type, Source: item.source, Target: item.target, ...(item.readOnly ? { ReadOnly: true } : {}) })).reverse() }, Mounts: wanted.mounts.map((item) => ({ Type: item.type, Source: topSource(item), Destination: item.target, RW: !item.readOnly })).reverse() }; }
for (const notes of [[], ["ENV_ORDER_ONLY"], ["EXTRA_NON_PAL_LABELS_PRESENT"], ["ENV_ORDER_ONLY", "EXTRA_NON_PAL_LABELS_PRESENT"]]) test(`31 allowed representation-note subset: ${notes.join("+") || "empty"}`, () => { assert.deepEqual(v24.validateCreatedComparisonV24({ match: true, mismatchCodes: [], representationNotes: notes }).representationNotes, notes); });
test("32 disallowed representation note blocks before START and cleans", () => { const { state, lifecycle } = lifecycleFixture(), mock = adapterFor(lifecycle), io = workflowIO(lifecycle, state, mock.adapter, { compareCreated() { return { match: true, mismatchCodes: [], representationNotes: ["TOP_MOUNT_SOURCE_IGNORED_VM_TRANSLATION"] }; } }); let error; try { v24.executeWorkflowV24(io, v24.AUTHORIZATION_ID); } catch (caught) { error = caught; } assert.match(error.message, /CREATED_INSPECT_REPRESENTATION_NOTE_BLOCKED/); assert.equal(mock.seen.includes("A_START_ATTACH"), false); assert.equal(mock.seen.filter((op) => op === "A_RM_FORCE").length, 1); finishFailure(lifecycle, error); });
for (const [name, comparison, code] of [["shape", { match: true }, "CREATED_INSPECT_COMPARATOR_INVALID"], ["mismatch", { match: false, mismatchCodes: ["NAME_MISMATCH"], representationNotes: [] }, "CREATED_INSPECT_SEMANTIC_MISMATCH"], ["unknown-code", { match: false, mismatchCodes: ["UNKNOWN"], representationNotes: [] }, "CREATED_INSPECT_COMPARATOR_INVALID"]]) test(`33 invalid created comparison blocks: ${name}`, () => { assert.throws(() => v24.validateCreatedComparisonV24(comparison), new RegExp(code)); });
test("34 full A/B lifecycle uses real V23 comparator fixtures", () => { const { state, lifecycle } = lifecycleFixture(), notes = ["ENV_ORDER_ONLY", "EXTRA_NON_PAL_LABELS_PRESENT"], mock = adapterFor(lifecycle, { createdInspect: (spec, receipt) => realisticCreated(spec, receipt, notes) }), io = workflowIO(lifecycle, state, mock.adapter, { compareCreated: (raw, wanted) => v23.compareInspect(raw, wanted) }), result = v24.executeWorkflowV24(io, v24.AUTHORIZATION_ID); assert.equal(result.status, "PARSER_AUTHORITY_CANDIDATE_REPRODUCIBLE_EXACT_QUALIFIED_REFERENCE"); assert.deepEqual([state.processCalls, state.buildAttempts, state.successfulBuilds, state.cleanupAttempts, state.cleanupSuccesses], [13, 2, 2, 2, 2]); assert.deepEqual(mock.seen, v24.OPERATIONS); lifecycle.terminal(true, result); });
