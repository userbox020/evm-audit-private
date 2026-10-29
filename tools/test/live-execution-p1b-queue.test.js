#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const batchTool = require("../live-execution-batch.js");
const runner = require("../run-approved-fork-validation.js");
const queue = require("../live-execution-p1b-queue.js");

const H = (byte) => `0x${byte.repeat(64)}`;
const ACTOR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TARGET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PIN = H("1");
const ROOT_HASH = H("2");
const BATCH_HASH = H("3");
const SCOPE_HASH = H("4");
const TEMP_ROOT = process.platform === "win32" ? "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode" : "/mnt/c/Users/MiPC/AppData/Local/Temp/opencode";

function manifestFixture(overrides = {}) {
  return {
    schema: runner.MANIFEST_SCHEMA, manifestId: "a1b2c3d4", chainId: "1", pinBlockNumber: "10", pinBlockHash: PIN,
    pinStateRoot: ROOT_HASH, pinFinality: "finalized",
    calls: [{ id: "c1", actor: ACTOR, to: TARGET, data: "0x12345678", valueWei: "0", gasLimit: "100000", slippageBps: "10" }],
    watch: [
      { id: "actor", token: "native", holder: ACTOR, decimals: "18", role: "attacker" },
      { id: "target", token: "native", holder: TARGET, decimals: "18", role: "observer" },
    ], pricesUsd: [], ...overrides,
  };
}
function batchFor(manifest) {
  return { chainId: manifest.chainId, accountRef: ACTOR, actions: manifest.calls.map((call) => ({ from: call.actor, to: call.to, valueWei: call.valueWei, data: call.data, gasLimit: call.gasLimit, slippageBps: call.slippageBps })) };
}
function runnerOutput(manifest, status = "FORK_VALIDATION_COMPLETE", overrides = {}) {
  return { schema: runner.OUTPUT_SCHEMA, status, manifestCommitment: runner.manifestCommitment(manifest), batchCommitment: BATCH_HASH, authorizationStateAtRun: "CONSUMED", cleanup: { child: "STOPPED", relay: "CLOSED" }, ...overrides };
}
function testDurable(file, bytes, options) {
  assert.equal(options.requireDurable, true);
  let fd;
  try { fd = fs.openSync(file, "wx", 0o600); let offset = 0; while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset); fs.fsyncSync(fd); }
  catch (error) { if (error?.code === "EEXIST") { const wrapped = new Error("BATCH_ALREADY_EXISTS"); wrapped.code = "BATCH_ALREADY_EXISTS"; throw wrapped; } throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return { committed: true };
}
function setup(t, options = {}) {
  const parent = fs.mkdtempSync(path.join(TEMP_ROOT, "p1b-queue-test-")); t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "queue"), manifestPath = path.join(parent, "reviewed-manifest.json");
  const manifest = options.manifest || manifestFixture();
  const manifestBytes = options.manifestBytes || Buffer.from(JSON.stringify(manifest, null, 2)); fs.writeFileSync(manifestPath, manifestBytes);
  const state = { calls: 0, consumed: false, delegated: null };
  const batchState = options.batchState || (() => state.consumed
    ? { state: batchTool.STATES.CONSUMED, batchCommitment: BATCH_HASH, terminal: { manifestCommitment: runner.manifestCommitment(manifest), runId: state.delegated.runId } }
    : { state: batchTool.STATES.VALID, batch: batchFor(manifest), batchCommitment: BATCH_HASH, scopeCommitment: SCOPE_HASH, approval: { approverId: "reviewed" } });
  const runForkValidation = options.runForkValidation || (async (delegated) => { state.calls += 1; state.delegated = delegated; state.consumed = true; return { output: runnerOutput(manifest) }; });
  const durableWrite = options.durableWrite || testDurable;
  const harness = queue._test.createTestHarness({ root, batchState, runForkValidation, durableWrite });
  return { parent, root, manifestPath, manifest, manifestBytes, state, harness, durableWrite };
}
function digest(bytes) { return `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`; }
function enqueue(env) { return env.harness.enqueueReviewedManifest({ manifestPath: env.manifestPath, expectedManifestBytesSha256: digest(env.manifestBytes) }); }

test("request schema and domain-separated commitment are exact", () => {
  const request = { schema: queue.constants.REQUEST_SCHEMA, manifestBytesSha256: H("a"), manifestCommitment: H("b") };
  assert.equal(queue.validateRequest(request), request);
  assert.throws(() => queue.validateRequest({ ...request, extra: true }), /REQUEST_SCHEMA_INVALID/);
  assert.throws(() => queue.validateRequest({ ...request, manifestBytesSha256: H("A") }), /REQUEST_MANIFEST_BYTES_INVALID/);
  const expected = digest(Buffer.from(`${queue.constants.REQUEST_DOMAIN}${batchTool.canonical(request)}`));
  assert.equal(queue.requestCommitment(request), expected);
});

test("digest, fatal UTF-8, JSON, and manifest size failures precede publication", (t) => {
  const mismatch = setup(t); assert.throws(() => mismatch.harness.enqueueReviewedManifest({ manifestPath: mismatch.manifestPath, expectedManifestBytesSha256: H("f") }), /MANIFEST_BYTES_SHA256_MISMATCH/); assert.equal(fs.existsSync(mismatch.root), false);
  const invalidUtf8 = setup(t, { manifestBytes: Buffer.from([0xff, 0xfe, 0xfd]) }); assert.throws(() => invalidUtf8.harness.enqueueReviewedManifest({ manifestPath: invalidUtf8.manifestPath, expectedManifestBytesSha256: digest(invalidUtf8.manifestBytes) }), /MANIFEST_UTF8_OR_JSON_INVALID/);
  const malformed = setup(t, { manifestBytes: Buffer.from("{") }); assert.throws(() => malformed.harness.enqueueReviewedManifest({ manifestPath: malformed.manifestPath, expectedManifestBytesSha256: digest(malformed.manifestBytes) }), /MANIFEST_UTF8_OR_JSON_INVALID/);
  const oversized = setup(t, { manifestBytes: Buffer.alloc(batchTool.CAPS.batchBytes + 1, 0x20) }); assert.throws(() => oversized.harness.enqueueReviewedManifest({ manifestPath: oversized.manifestPath, expectedManifestBytesSha256: digest(oversized.manifestBytes) }), /QUEUE_FILE_INVALID/);
});

test("enqueue preserves reviewed bytes and formatting and semantic drift address distinct requests", (t) => {
  const pretty = setup(t); const first = enqueue(pretty); assert.equal(first.status, "QUEUED");
  const stored = queue._test.pathsFor(pretty.root, first.requestCommitment); assert.deepEqual(fs.readFileSync(stored.manifest), pretty.manifestBytes);
  const compact = setup(t, { manifest: pretty.manifest, manifestBytes: Buffer.from(JSON.stringify(pretty.manifest)) }); const second = enqueue(compact);
  assert.equal(second.manifestCommitment, first.manifestCommitment); assert.notEqual(second.requestCommitment, first.requestCommitment);
  const changedManifest = manifestFixture({ pinBlockNumber: "11" }); const changed = setup(t, { manifest: changedManifest }); const third = enqueue(changed);
  assert.notEqual(third.manifestCommitment, first.manifestCommitment); assert.notEqual(third.requestCommitment, first.requestCommitment);
});

test("duplicates are terminal for enqueue and partial publication is never repaired", (t) => {
  const complete = setup(t); const first = enqueue(complete); assert.equal(enqueue(complete).status, "ALREADY_EXISTS"); assert.equal(complete.harness.requestStatus(first.requestCommitment).status, "QUEUED");
  let publications = 0; const partial = setup(t, { durableWrite(file, bytes, options) { publications += 1; if (publications === 2) throw new Error("uncertain"); return testDurable(file, bytes, options); } });
  const row = enqueue(partial); assert.equal(row.status, "INCOMPLETE_ENQUEUE"); assert.equal(partial.harness.requestStatus(row.requestCommitment).status, "INCOMPLETE_ENQUEUE");
  assert.equal(enqueue(partial).status, "INCOMPLETE_ENQUEUE"); assert.equal(publications, 2);
});

test("stored request and decision caps plus malformed artifacts report INVALID", (t) => {
  const requestCase = setup(t); const queued = enqueue(requestCase), files = queue._test.pathsFor(requestCase.root, queued.requestCommitment);
  fs.rmSync(files.request); fs.writeFileSync(files.request, Buffer.alloc(queue.constants.SMALL_CAP + 1, 0x20)); assert.equal(requestCase.harness.requestStatus(queued.requestCommitment).status, "INVALID");
  const decisionCase = setup(t); const queued2 = enqueue(decisionCase), files2 = queue._test.pathsFor(decisionCase.root, queued2.requestCommitment);
  fs.writeFileSync(files2.decision, Buffer.alloc(queue.constants.SMALL_CAP + 1, 0x20)); assert.equal(decisionCase.harness.requestStatus(queued2.requestCommitment).status, "INVALID");
});

test("absent or mismatched authorization creates no claim and makes no runner call", async (t) => {
  for (const kind of ["absent", "mismatch", "scope"]) {
    const env = setup(t, { batchState: () => kind === "absent" ? { state: batchTool.STATES.ABSENT } : { state: batchTool.STATES.VALID, batch: kind === "scope" ? { ...batchFor(manifestFixture()), chainId: "2" } : batchFor(manifestFixture()), batchCommitment: BATCH_HASH, scopeCommitment: SCOPE_HASH } });
    const queued = enqueue(env), result = await env.harness.dispatchOnce({ requestCommitment: queued.requestCommitment, expectedBatchCommitment: kind === "mismatch" ? H("9") : BATCH_HASH });
    assert.equal(result.status, "QUEUED"); assert.equal(result.dispatched, false); assert.equal(env.state.calls, 0); assert.equal(fs.existsSync(queue._test.pathsFor(env.root, queued.requestCommitment).decision), false);
  }
});

test("claim/claim and claim/cancel races have one immutable decision slot", async (t) => {
  const double = setup(t), queued = enqueue(double);
  const first = double.harness.dispatchOnce({ requestCommitment: queued.requestCommitment, expectedBatchCommitment: BATCH_HASH });
  const second = double.harness.dispatchOnce({ requestCommitment: queued.requestCommitment, expectedBatchCommitment: BATCH_HASH });
  const rows = await Promise.all([first, second]); assert.equal(double.state.calls, 1); assert.ok(rows.some((row) => row.status === "COMPLETED"));
  const cancelled = setup(t), q2 = enqueue(cancelled); assert.equal(cancelled.harness.cancelRequest(q2.requestCommitment).status, "CANCELLED"); assert.equal((await cancelled.harness.dispatchOnce({ requestCommitment: q2.requestCommitment, expectedBatchCommitment: BATCH_HASH })).status, "CANCELLED"); assert.equal(cancelled.state.calls, 0);
  const claimed = setup(t), q3 = enqueue(claimed); const running = claimed.harness.dispatchOnce({ requestCommitment: q3.requestCommitment, expectedBatchCommitment: BATCH_HASH }); const cancelLost = claimed.harness.cancelRequest(q3.requestCommitment); assert.equal(cancelLost.status, "CLAIMED_UNRESOLVED"); await running; assert.equal(claimed.state.calls, 1);
});

test("uncertain claim publication causes zero calls", async (t) => {
  const env = setup(t, { durableWrite(file, bytes, options) { if (file.endsWith(".decision.json")) throw new Error("uncertain"); return testDurable(file, bytes, options); } });
  const queued = enqueue(env); await assert.rejects(env.harness.dispatchOnce({ requestCommitment: queued.requestCommitment, expectedBatchCommitment: BATCH_HASH }), /DECISION_PUBLICATION_INDETERMINATE/); assert.equal(env.state.calls, 0); assert.equal(env.harness.requestStatus(queued.requestCommitment).status, "QUEUED");
});

test("delegation is exact and contains no production dependency overrides", async (t) => {
  const env = setup(t), queued = enqueue(env); await env.harness.dispatchOnce({ requestCommitment: queued.requestCommitment, expectedBatchCommitment: BATCH_HASH });
  assert.deepEqual(Object.keys(env.state.delegated).sort(), ["expectedBatchCommitment", "expectedManifestBytesSha256", "expectedManifestCommitment", "manifestPath", "runId"]);
  assert.equal(env.state.delegated.manifestPath, queue._test.pathsFor(env.root, queued.requestCommitment).manifest); assert.equal(env.state.delegated.runId, `p1b-${queued.requestCommitment.slice(2)}`); assert.equal(env.state.delegated.expectedManifestBytesSha256, digest(env.manifestBytes)); assert.equal(env.state.delegated.expectedManifestCommitment, runner.manifestCommitment(env.manifest)); assert.equal(env.state.delegated.expectedBatchCommitment, BATCH_HASH);
});

test("malformed, incomplete, and failed runner outcomes publish non-retryable envelopes", async (t) => {
  const malformed = setup(t, { runForkValidation: async (options) => { malformed.state.calls += 1; malformed.state.delegated = options; malformed.state.consumed = true; return { output: { bad: true } }; } });
  let queued = enqueue(malformed), row = await malformed.harness.dispatchOnce({ requestCommitment: queued.requestCommitment, expectedBatchCommitment: BATCH_HASH }); assert.equal(row.status, "INCOMPLETE"); assert.equal(row.blocker, "RUNNER_OUTPUT_INVALID");
  const incomplete = setup(t, { runForkValidation: async (options) => { incomplete.state.calls += 1; incomplete.state.delegated = options; incomplete.state.consumed = true; return { output: runnerOutput(incomplete.manifest, "FORK_VALIDATION_INCOMPLETE") }; } });
  queued = enqueue(incomplete); row = await incomplete.harness.dispatchOnce({ requestCommitment: queued.requestCommitment, expectedBatchCommitment: BATCH_HASH }); assert.equal(row.status, "INCOMPLETE"); assert.equal(row.blocker, "RUNNER_INCOMPLETE");
  const failed = setup(t, { runForkValidation: async (options) => { failed.state.calls += 1; failed.state.delegated = options; failed.state.consumed = true; const error = new Error("private detail"); error.output = runnerOutput(failed.manifest, "FORK_VALIDATION_INCOMPLETE"); throw error; } });
  queued = enqueue(failed); row = await failed.harness.dispatchOnce({ requestCommitment: queued.requestCommitment, expectedBatchCommitment: BATCH_HASH }); assert.equal(row.status, "FAILED"); assert.equal(row.blocker, "RUNNER_FAILED"); assert.equal(JSON.stringify(row).includes("private detail"), false);
  const mismatched = setup(t, { runForkValidation: async (options) => { mismatched.state.calls += 1; mismatched.state.delegated = options; mismatched.state.consumed = true; return { output: runnerOutput(mismatched.manifest, "FORK_VALIDATION_COMPLETE", { manifestCommitment: H("9") }) }; } });
  queued = enqueue(mismatched); row = await mismatched.harness.dispatchOnce({ requestCommitment: queued.requestCommitment, expectedBatchCommitment: BATCH_HASH }); assert.equal(row.status, "INCOMPLETE"); assert.equal(row.blocker, "RUNNER_OUTPUT_INVALID"); assert.equal(row.runnerOutput, null);
  const dirtyCleanup = setup(t, { runForkValidation: async (options) => { dirtyCleanup.state.calls += 1; dirtyCleanup.state.delegated = options; dirtyCleanup.state.consumed = true; return { output: runnerOutput(dirtyCleanup.manifest, "FORK_VALIDATION_COMPLETE", { cleanup: { child: "FAILED", relay: "CLOSED" } }) }; } });
  queued = enqueue(dirtyCleanup); row = await dirtyCleanup.harness.dispatchOnce({ requestCommitment: queued.requestCommitment, expectedBatchCommitment: BATCH_HASH }); assert.equal(row.status, "INCOMPLETE"); assert.equal(row.blocker, "RUNNER_INCOMPLETE");
});

test("unknown consumption and result publication failure are non-retryable", async (t) => {
  const unknown = setup(t, { runForkValidation: async (options) => { unknown.state.calls += 1; unknown.state.delegated = options; return { output: runnerOutput(unknown.manifest) }; } });
  let queued = enqueue(unknown), row = await unknown.harness.dispatchOnce({ requestCommitment: queued.requestCommitment, expectedBatchCommitment: BATCH_HASH }); assert.equal(row.status, "INCOMPLETE"); assert.equal(row.consumption, "UNKNOWN"); assert.equal(unknown.state.calls, 1); await unknown.harness.dispatchOnce({ requestCommitment: queued.requestCommitment, expectedBatchCommitment: BATCH_HASH }); assert.equal(unknown.state.calls, 1);
  const publishFail = setup(t, { durableWrite(file, bytes, options) { if (file.endsWith(".result.json")) throw new Error("uncertain"); return testDurable(file, bytes, options); } });
  queued = enqueue(publishFail); await assert.rejects(publishFail.harness.dispatchOnce({ requestCommitment: queued.requestCommitment, expectedBatchCommitment: BATCH_HASH }), /RESULT_PUBLICATION_INDETERMINATE/); assert.equal(publishFail.state.calls, 1); assert.equal(publishFail.harness.requestStatus(queued.requestCommitment).status, "CLAIMED_UNRESOLVED"); await publishFail.harness.dispatchOnce({ requestCommitment: queued.requestCommitment, expectedBatchCommitment: BATCH_HASH }); assert.equal(publishFail.state.calls, 1);
  let wrongRunId;
  wrongRunId = setup(t, { batchState: () => wrongRunId.state.consumed
    ? { state: batchTool.STATES.CONSUMED, batchCommitment: BATCH_HASH, terminal: { manifestCommitment: runner.manifestCommitment(wrongRunId.manifest), runId: "different-run" } }
    : { state: batchTool.STATES.VALID, batch: batchFor(wrongRunId.manifest), batchCommitment: BATCH_HASH, scopeCommitment: SCOPE_HASH, approval: { approverId: "reviewed" } } });
  queued = enqueue(wrongRunId); row = await wrongRunId.harness.dispatchOnce({ requestCommitment: queued.requestCommitment, expectedBatchCommitment: BATCH_HASH }); assert.equal(row.status, "INCOMPLETE"); assert.equal(row.consumption, "UNKNOWN"); assert.equal(row.blocker, "CONSUMPTION_UNCONFIRMED"); assert.equal(wrongRunId.state.calls, 1);
});

test("stored terminal envelopes bind the exact state machine and runner commitments", async (t) => {
  for (const tamper of [
    (result) => { result.state = "FAILED"; },
    (result) => { result.runnerOutput.batchCommitment = H("9"); },
  ]) {
    const env = setup(t), queued = enqueue(env); await env.harness.dispatchOnce({ requestCommitment: queued.requestCommitment, expectedBatchCommitment: BATCH_HASH });
    const file = queue._test.pathsFor(env.root, queued.requestCommitment).result, result = JSON.parse(fs.readFileSync(file, "utf8")); tamper(result);
    fs.rmSync(file); fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    assert.equal(env.harness.requestStatus(queued.requestCommitment).status, "INVALID");
  }
});

test("status is non-mutating and CLI exposes no dispatch, retry, watch, or default command", (t) => {
  const env = setup(t), request = queue.requestCommitment({ schema: queue.constants.REQUEST_SCHEMA, manifestBytesSha256: H("a"), manifestCommitment: H("b") });
  assert.equal(env.harness.requestStatus(request).status, "ABSENT"); assert.equal(fs.existsSync(env.root), false);
  for (const args of [[], ["dispatch", "--request", request], ["retry", "--request", request], ["watch"], ["status"], ["status", "--request", request, "extra"], ["enqueue", "--manifest", "x", "--manifest", "y"]]) assert.throws(() => queue._test.parseCli(args), /USAGE_ERROR/);
});

test("production status stays non-mutating and fails closed on an unsupported host or unsafe parent", () => {
  assert.equal(fs.existsSync(queue.constants.QUEUE_ROOT), false);
  if (process.platform !== "linux") assert.throws(() => queue.requestStatus(H("a")), /QUEUE_SECURE_HOST_REQUIRED/);
  else {
    try { assert.equal(queue.requestStatus(H("a")).status, "ABSENT"); }
    catch (error) { assert.match(error.message, /QUEUE_(?:PARENT_UNSAFE|PARENT_UNAVAILABLE|SECURE_HOST_REQUIRED)/); }
  }
  assert.equal(fs.existsSync(queue.constants.QUEUE_ROOT), false);
});
