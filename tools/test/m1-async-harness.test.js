"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { asyncHarness, deferred } = require("./m1-async-harness-fixture.js");
const turn = () => new Promise(resolve => setImmediate(resolve));

test("an immediate precondition rejection beats a missing start and retains its cause", async t => {
  const h = asyncHarness(t), entered = deferred();
  const cause = Object.assign(new Error("SYNTHETIC_PRIVATE_CAUSE"), { code: "SYNTHETIC_PRECONDITION" });
  const pending = h.run(() => Promise.reject(cause)), startedAt = performance.now();
  // The generic assertion may succeed, but cannot conceal an absent start.
  const rejection = h.assertion(assert.rejects(pending, { code: cause.code }));
  await turn();
  await assert.rejects(h.wait(entered.promise, pending, "synthetic start"), error => {
    assert.equal(error.code, "M1_TEST_REJECTED_BEFORE_HANDSHAKE"); assert.equal(error.cause, cause);
    assert.match(error.message, /SYNTHETIC_PRECONDITION/); assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE_CAUSE/); return true;
  });
  await rejection; assert.ok(performance.now() - startedAt < 1000);
});

test("completion before a missing start fails without serializing the result", async t => {
  const h = asyncHarness(t), pending = h.run(() => ({ private: "SYNTHETIC_PRIVATE_RESULT" }));
  await assert.rejects(h.wait(deferred().promise, pending, "synthetic start"), error => {
    assert.equal(error.code, "M1_TEST_COMPLETED_BEFORE_HANDSHAKE");
    assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE_RESULT/); return true;
  });
});

for (const reject of [false, true]) test(`an already-resolved handshake wins same-turn settlement (${reject})`, async t => {
  const h = asyncHarness(t), entered = deferred(), cause = new Error("SYNTHETIC_AFTER_START");
  const pending = h.run(() => { entered.resolve("started"); return reject ? Promise.reject(cause) : "completed"; });
  await turn();
  assert.equal(await h.wait(entered.promise, pending, "synthetic start"), "started");
  if (reject) await assert.rejects(pending, error => error === cause); else assert.equal(await pending, "completed");
});

test("missing-start timeout releases gates and drains work before fixture teardown", async t => {
  const h = asyncHarness(t, { waitMs: 30 }), held = h.gate();
  let drained = false;
  h.afterCleanup(() => assert.equal(drained, true));
  const pending = h.run(async () => { await held.promise; drained = true; });
  await assert.rejects(h.wait(deferred().promise, pending, "synthetic start"), { code: "M1_TEST_TIMEOUT" });
  assert.equal(drained, false);
});

test("a delayed assertion await remains observed and still rejects with its mismatch", async t => {
  const h = asyncHarness(t), cause = Object.assign(new Error("SYNTHETIC_PRECONDITION"), { code: "ACTUAL" });
  const pending = h.run(() => Promise.reject(cause));
  // Observe the assertion without registering an expected mismatch as a required
  // successful assertion; its rejection is asserted explicitly below.
  const rejection = h.observe(assert.rejects(pending, { code: "EXPECTED" }));
  await turn(); await assert.rejects(rejection, { code: "ERR_ASSERTION" });
});

test("cleanup has its own deadline for a noncooperative synthetic task", async () => {
  const hooks = [], h = asyncHarness({ after: fn => hooks.push(fn) }, { cleanupMs: 30, operationMs: 60000 });
  let closed = false, tornDown = false;
  h.onCleanup(() => { closed = true; });
  const pending = h.run(() => new Promise(() => {}));
  h.fixtureContext.after(() => { tornDown = true; });
  await assert.rejects(hooks[0](), error => error.code === "M1_TEST_TIMEOUT" && /cleanup drain/.test(error.message));
  await assert.rejects(pending, { code: "M1_TEST_CLEANUP_CANCELLED" });
  assert.equal(closed, true); assert.equal(tornDown, true);
});

test("an unawaited assertion mismatch still fails cleanup after fixture teardown", async () => {
  const hooks = [], h = asyncHarness({ after: fn => hooks.push(fn) });
  let tornDown = false;
  h.fixtureContext.after(() => { tornDown = true; });
  h.assertion(assert.rejects(h.run(() => Promise.reject(new Error("ACTUAL"))), /EXPECTED/));
  await turn(); await assert.rejects(hooks[0](), { code: "ERR_ASSERTION" });
  assert.equal(tornDown, true);
});

test("node:test reports early failures, cleans resources and exits without unhandled rejections", { timeout: 15000 }, () => {
  const env = { ...process.env, M1_ASYNC_HARNESS_NEGATIVE_CONTROLS: "1" };
  // An isolated node:test worker uses an internal binary reporter. This child
  // is an independent runner whose explicit TAP reporter must remain active.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--test", "--test-isolation=none", "--test-timeout=15000", "--test-reporter=tap",
    require.resolve("./m1-async-harness-fixture.js")], { encoding: "utf8", timeout: 10000, windowsHide: true,
    env });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 1);
  const output = result.stdout + result.stderr;
  for (const code of ["M1_TEST_REJECTED_BEFORE_HANDSHAKE", "SYNTHETIC_PRECONDITION", "M1_TEST_COMPLETED_BEFORE_HANDSHAKE", "M1_TEST_TIMEOUT"])
    assert.ok(output.includes(code), code);
  for (const kind of ["rejection", "completion", "missing-start", "assertion-rejection"])
    assert.ok(output.includes(`cleanup verified: ${kind}`), kind);
  assert.match(output, /# tests 4\b/); assert.match(output, /# fail 4\b/); assert.match(output, /# cancelled 0\b/);
  assert.doesNotMatch(output, /unhandledRejection|uncaughtException|testTimeoutFailure|SYNTHETIC_HANDLE_LEAK|SYNTHETIC_PRIVATE_RESULT/);
});
