"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const r5 = require("./run-profitable-async-liability-solidity-builder-exact-qualified-reference-two-clean-build-reproducibility-executor-v21-r5.js");

const temps = [];
const RECEIPTS = { A: "a".repeat(64), B: "b".repeat(64) };
const WASM = Buffer.from("r5-wasm");
const EXPECTED = Object.freeze({ bytes: WASM.length, sha256: crypto.createHash("sha256").update(WASM).digest("hex") });
test.after(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture(options = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "v21-r5-")); temps.push(workspace);
  const packageRoot = path.join(workspace, "package"); fs.mkdirSync(packageRoot);
  if (options.existingRuns) fs.mkdirSync(path.join(packageRoot, "runs"));
  const sources = path.join(workspace, "sources"); fs.mkdirSync(sources); fs.mkdirSync(path.join(sources, "tree_sitter"));
  const parser = Buffer.from("parser-r5"), header = Buffer.from("header-r5"); fs.writeFileSync(path.join(sources, "parser.c"), parser); fs.writeFileSync(path.join(sources, "tree_sitter", "parser.h"), header);
  const sourceRecords = [
    { path: "sources/parser.c", stage: "parser.c", bytes: parser.length, sha256: crypto.createHash("sha256").update(parser).digest("hex") },
    { path: "sources/tree_sitter/parser.h", stage: "tree_sitter/parser.h", bytes: header.length, sha256: crypto.createHash("sha256").update(header).digest("hex") }
  ];
  return { workspace, packageRoot, sourceRecords };
}
function lifecycleFixture(options = {}) {
  const f = fixture(options), state = r5.freshState(), lifecycle = r5.createLifecycleR5(r5.AUTHORIZATION_ID, state, { fs, workspace: f.workspace, packageRoot: f.packageRoot, sourceRecords: f.sourceRecords, expectedOutput: EXPECTED, limits: options.limits, beforeSuccessCommit: options.beforeSuccessCommit });
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
      if (op.endsWith("_CREATED_INSPECT")) return ok(JSON.stringify([{ Id: receipt }]));
      if (op.endsWith("_START_ATTACH")) { fs.writeFileSync(path.join(spec.output, r5.OUTPUT_NAME), WASM); return ok(); }
      if (op.endsWith("_EXITED_INSPECT")) return ok(JSON.stringify([{ Id: receipt }]));
      return ok("{}");
    } }
  };
}
function ok(stdout = "") { return { status: 0, signal: null, error: null, stdout, stderr: "" }; }
function workflowIO(lifecycle, state, adapter, overrides = {}) {
  return { state, budgets: lifecycle.budgets, runRoot: lifecycle.runRoot, config: lifecycle.config, adapter, journal: lifecycle.journal, validateIdentities: lifecycle.validateIdentities, validateCleanup: lifecycle.validateCleanup, assertFreshSlot: lifecycle.assertFreshSlot, verifyOutput: lifecycle.verifyOutput, expectedOutput: EXPECTED, validateQualification() {}, compareCreated() { return { match: true, mismatchCodes: [], representationNotes: [] }; }, compareExited() { return { match: true, mismatchCodes: [], representationNotes: [] }; }, ...overrides };
}
function finishFailure(lifecycle, error) { try { lifecycle.terminal(false, { rootCauseCode: error.message }); } catch {} }

test("01 default import is zero capability", () => {
  const value = r5.main([]);
  assert.equal(value.status, "PASS"); assert.equal(value.processCalls, 0); assert.equal(value.writes, 0); assert.equal(value.consumed, false); assert.equal(value.networkCalls, 0);
});

test("02 exported R5 workflow succeeds with exact counters", () => {
  const { state, lifecycle } = lifecycleFixture(), mock = adapterFor(lifecycle);
  const result = r5.executeWorkflowR5(workflowIO(lifecycle, state, mock.adapter), r5.AUTHORIZATION_ID);
  assert.equal(result.schema, `${r5.NAMESPACE}/workflow-result-v1`); assert.equal(result.status, "REPRODUCIBLE_EXACT_QUALIFIED_REFERENCE");
  assert.deepEqual([state.processCalls, state.buildAttempts, state.successfulBuilds, state.cleanupAttempts, state.cleanupSuccesses, state.networkCalls], [13, 2, 2, 2, 2, 0]);
  assert.deepEqual(result.calls, r5.OPERATIONS); assert.equal(state.writes <= 64, true);
  const terminal = lifecycle.terminal(true, result); assert.equal(terminal.authoritative, "success.json"); assert.equal(state.terminal, terminal);
});

test("03 post-journal A_CREATE failure performs one cleanup call", () => {
  const { state, lifecycle } = lifecycleFixture(), mock = adapterFor(lifecycle); let thrown = false;
  const io = workflowIO(lifecycle, state, mock.adapter, { journal(phase, op, value) { lifecycle.journal(phase, op, value); if (!thrown && phase === "after" && op === "A_CREATE") { thrown = true; throw new Error("POST_JOURNAL_FAULT"); } } });
  let error; try { r5.executeWorkflowR5(io, r5.AUTHORIZATION_ID); } catch (caught) { error = caught; }
  assert.match(error.message, /POST_JOURNAL_FAULT/); assert.equal(error.op, "A_CREATE"); assert.equal(error.result.stdout, `${RECEIPTS.A}\n`);
  assert.equal(mock.seen.filter((op) => op === "A_RM_FORCE").length, 1); finishFailure(lifecycle, error);
});

test("04 active mount mutation blocks START but cleanup still runs", () => {
  const { state, lifecycle } = lifecycleFixture();
  const mock = adapterFor(lifecycle, { onCall(op, spec) { if (op === "A_CREATED_INSPECT") fs.writeFileSync(path.join(spec.work, "pollution"), "x"); } });
  let error; try { r5.executeWorkflowR5(workflowIO(lifecycle, state, mock.adapter), r5.AUTHORIZATION_ID); } catch (caught) { error = caught; }
  assert.match(error.message, /STAGED_SOURCE_LISTING_CHANGED/); assert.equal(mock.seen.includes("A_START_ATTACH"), false); assert.equal(mock.seen.filter((op) => op === "A_RM_FORCE").length, 1); finishFailure(lifecycle, error);
});

test("05 B pollution during A blocks before A START and cleans A", () => {
  const { state, lifecycle } = lifecycleFixture();
  const mock = adapterFor(lifecycle, { onCall(op) { if (op === "A_CREATED_INSPECT") fs.writeFileSync(path.join(lifecycle.plan.builds[1].output, "intruder"), "x"); } });
  let error; try { r5.executeWorkflowR5(workflowIO(lifecycle, state, mock.adapter), r5.AUTHORIZATION_ID); } catch (caught) { error = caught; }
  assert.match(error.message, /OUTPUT_NOT_EMPTY/); assert.equal(mock.seen.includes("A_START_ATTACH"), false); assert.equal(mock.seen.includes("A_RM_FORCE"), true); assert.equal(mock.seen.includes("B_CREATE"), false); finishFailure(lifecycle, error);
});

test("06 B pollution after A cleanup blocks directly before B CREATE", () => {
  const { state, lifecycle } = lifecycleFixture();
  const mock = adapterFor(lifecycle, { onCall(op) { if (op === "A_RM_FORCE") fs.writeFileSync(path.join(lifecycle.plan.builds[1].output, "intruder"), "x"); } });
  let error; try { r5.executeWorkflowR5(workflowIO(lifecycle, state, mock.adapter), r5.AUTHORIZATION_ID); } catch (caught) { error = caught; }
  assert.match(error.message, /OUTPUT_NOT_EMPTY/); assert.equal(mock.seen.includes("A_RM_FORCE"), true); assert.equal(mock.seen.includes("B_CREATE"), false); finishFailure(lifecycle, error);
});

test("07 centralized process cap blocks before sixteenth process", () => {
  const state = r5.freshState({ processCalls: 15 }), budgets = r5.createBudgetsR5(state), seen = [];
  const io = { state, budgets, config: "cfg", runRoot: path.resolve("r5-process-cap"), journal() {}, validateIdentities() {}, validateCleanup() {}, assertFreshSlot() {}, adapter: { call(op) { seen.push(op); return ok("{}"); } }, validateQualification() {}, compareCreated() { return { match: true }; }, compareExited() { return { match: true }; }, verifyOutput() { return { ...EXPECTED, content: WASM }; }, expectedOutput: EXPECTED };
  assert.throws(() => r5.executeWorkflowR5(io, r5.AUTHORIZATION_ID), /PROCESS_BUDGET_EXCEEDED/); assert.equal(state.processCalls, 15); assert.equal(seen.length, 0);
});

test("08 centralized write cap blocks all later writes", () => {
  const f = fixture(), state = r5.freshState({ writes: 64 });
  assert.throws(() => r5.createLifecycleR5(r5.AUTHORIZATION_ID, state, { fs, workspace: f.workspace, packageRoot: f.packageRoot, sourceRecords: f.sourceRecords, expectedOutput: EXPECTED }), /WRITE_BUDGET_EXCEEDED/);
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
  const state = r5.freshState(); assert.throws(() => r5.createLifecycleR5(r5.AUTHORIZATION_ID, state, { fs, workspace: f.workspace, packageRoot: f.packageRoot, sourceRecords: f.sourceRecords, expectedOutput: EXPECTED }), /PATH_SYMLINK_OR_REPARSE/); assert.equal(state.consumed, false);
});

test("11 success commit failure leaves one authoritative failure terminal", () => {
  const { state, lifecycle } = lifecycleFixture({ beforeSuccessCommit() { throw new Error("COMMIT_INJECTED"); } });
  const terminal = lifecycle.terminal(true, { status: "WOULD_PASS" });
  assert.equal(terminal.authoritative, "failure.json"); assert.equal(terminal.value.value.rootCauseCode, "COMMIT_INJECTED");
  assert.equal(fs.existsSync(path.join(lifecycle.runRoot, "success.json")), false); assert.equal(fs.existsSync(path.join(lifecycle.runRoot, "failure.json")), true);
  assert.equal(r5.readTerminalR5(lifecycle.runRoot).authoritative, "failure.json"); assert.equal(state.terminal.authoritative, "failure.json");
});

test("12 deterministic cleanup name is used when CREATE receipt is malformed", () => {
  const { state, lifecycle } = lifecycleFixture(), mock = adapterFor(lifecycle); const original = mock.adapter.call;
  mock.adapter.call = (op, argv, timeout) => op === "A_CREATE" ? (mock.seen.push(op), ok("malformed")) : original(op, argv, timeout);
  const result = r5.executeWorkflowR5(workflowIO(lifecycle, state, mock.adapter), r5.AUTHORIZATION_ID);
  assert.equal(result.status, "REPRODUCIBLE_EXACT_QUALIFIED_REFERENCE"); assert.equal(state.cleanupSuccesses, 2); lifecycle.terminal(true, result);
});

test("13 R5 plan has sealed tmpfs, host cache, no network, and R5 labels", () => {
  const plan = r5.buildPlanR5("cfg", path.resolve("r5-plan"), r5.AUTHORIZATION_ID);
  for (const spec of plan.builds) {
    assert.equal(spec.name.startsWith(`pal-v21r5-${r5.AUTHORIZATION_ID}-`), true); assert.equal(spec.labels["pal.executor"], r5.NAMESPACE);
    assert.equal(spec.create.includes("none"), true); assert.equal(spec.create.includes("never"), true); assert.equal(spec.create.includes("/tmp:rw,nosuid,nodev,size=268435456"), true); assert.equal(spec.create.includes("/home/nonroot:rw,noexec,nosuid,nodev,size=33554432"), true); assert.equal(spec.create.some((value) => typeof value === "string" && value.includes("dst=/cache")), true);
    for (const stale of ["v21-r2", "v21-r3", "v21-r4", "pal-v21r2", "pal-v21r3", "pal-v21r4"]) assert.equal(spec.name.includes(stale) || Object.values(spec.labels).some((value) => String(value).includes(stale)), false);
  }
});

test("14 exact output descriptor validates content and rejects extras", () => {
  const f = fixture(), out = path.join(f.workspace, "out"); fs.mkdirSync(out); fs.writeFileSync(path.join(out, r5.OUTPUT_NAME), WASM);
  const value = r5.outputDescriptorR5(out, f.workspace, fs, EXPECTED); assert.equal(value.content.equals(WASM), true);
  fs.writeFileSync(path.join(out, "extra"), "x"); assert.throws(() => r5.outputDescriptorR5(out, f.workspace, fs, EXPECTED), /OUTPUT_INVALID/);
});

test("15 package, dependencies, image, V13/V15, and ac4d binding are sealed", () => {
  const sealed = r5.validatePackageR5(); assert.equal(sealed.manifest.dependencyRecords.length, 18); assert.equal(r5.OUTPUT.sha256, "ac4d44dc54b7a475c2284ae27ab0af932043e2cfd4e200a416b2ac5d40f433d7"); assert.equal(r5.IMAGE.includes("@sha256:"), true); assert.equal(r5.V13.endsWith("v13"), true); assert.equal(r5.V15.endsWith("v15"), true);
});

test("16 invalid arguments fail without entering reserved production mode", () => {
  assert.throws(() => r5.main(["--not-production"]), /ARGUMENTS_REJECTED/); assert.equal(process.argv.includes(r5.EXECUTE_FLAG), false);
});
