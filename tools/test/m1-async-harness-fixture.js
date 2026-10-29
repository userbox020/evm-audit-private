"use strict";

const { setTimeout, clearTimeout } = require("node:timers");
const harnesses = new WeakMap();
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function failure(code, label, cause) {
  const reason = typeof cause?.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(cause.code) ? ` (${cause.code})` : "";
  return Object.assign(new Error(`${code}: ${label}${reason}`, cause === undefined ? undefined : { cause }), { code });
}
async function deadline(promise, ms, label, cancellations) {
  let timer, cancel;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      cancel = () => reject(failure("M1_TEST_CLEANUP_CANCELLED", label));
      cancellations?.add(cancel);
      timer = setTimeout(() => reject(failure("M1_TEST_TIMEOUT", label)), ms);
    })]);
  } finally { clearTimeout(timer); cancellations?.delete(cancel); }
}

// Create this BEFORE fixture(h.fixtureContext), so gates/tasks drain before
// files/mocks disappear, even when cleanup fails. Observation preserves results.
function asyncHarness(t, { waitMs = 2000, operationMs = 5000, cleanupMs = 2000 } = {}) {
  if (harnesses.has(t)) return harnesses.get(t);
  const records = new Map(), cleanups = [], teardowns = [], cancellations = new Set();
  function observe(value, assertion = false) {
    const promise = Promise.resolve(value);
    let record = records.get(promise);
    if (!record) {
      record = { assertion, settled: false };
      record.outcome = promise.then(
        value => { record.settled = true; return { ok: true, value }; },
        error => { record.settled = true; return { ok: false, error }; });
      records.set(promise, record);
    }
    record.assertion ||= assertion;
    return promise;
  }
  const harness = {
    observe,
    assertion: promise => observe(promise, true),
    onCleanup: fn => cleanups.push(fn),
    afterCleanup: fn => teardowns.push(fn),
    // Local fixture adapter, not a patch to TestContext. The real per-test mock
    // tracker stays installed through cleanup and is restored by node:test.
    fixtureContext: { mock: t.mock, after: fn => teardowns.push(fn) },
    gate() { const gate = deferred(); cleanups.push(gate.resolve); return gate; },
    run(fn) {
      let operation;
      try { operation = fn(); } catch (error) { operation = Promise.reject(error); }
      return observe(deadline(observe(operation), operationMs, "operation settlement", cancellations));
    },
    wait(handshake, operation, label) {
      observe(operation);
      const outcome = records.get(Promise.resolve(operation)).outcome;
      // Handshake first: an already-observed start must win even if operation
      // settlement is also queued in this turn. Its eventual failure stays live.
      return observe(deadline(Promise.race([
        Promise.resolve(handshake).then(value => ({ started: true, value })),
        outcome.then(result => ({ started: false, ...result })),
      ]), waitMs, label, cancellations).then(result => {
        if (result.started) return result.value;
        throw failure(result.ok ? "M1_TEST_COMPLETED_BEFORE_HANDSHAKE" : "M1_TEST_REJECTED_BEFORE_HANDSHAKE", label, result.error);
      }));
    },
  };
  harnesses.set(t, harness);
  t.after(async () => {
    // Release every owned gate/handle even if another cleanup throws. Observe
    // cleanup promises immediately too, then drain under one real-time deadline.
    for (const fn of cleanups) {
      try { observe(fn(), true); } catch (error) { observe(Promise.reject(error), true); }
    }
    // Cancel only our deadline wrappers, not the underlying operation. Raw
    // tasks remain observed and must drain (or report the cleanup deadline).
    for (const cancel of cancellations) cancel();
    const errors = [];
    try {
      await deadline((async () => {
        do { await Promise.all([...records.values()].map(record => record.outcome)); }
        while ([...records.values()].some(record => !record.settled));
      })(), cleanupMs, "cleanup drain");
      for (const record of records.values()) {
        const result = await record.outcome;
        if (record.assertion && !result.ok) errors.push(result.error);
      }
    } catch (error) { errors.push(error); }
    // Node skips subsequent after hooks when an earlier one throws. Always run
    // the captured fixture teardowns before exposing a drain/assertion failure.
    try {
      const results = await deadline(Promise.allSettled(teardowns.map(fn => Promise.resolve().then(fn))), cleanupMs, "fixture teardown");
      for (const result of results) if (result.status === "rejected") errors.push(result.reason);
    } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "M1_TEST_CLEANUP_FAILED");
  });
  return harness;
}

module.exports = { asyncHarness, deferred };

// Deliberately failing, entirely synthetic node:test cases, run only by the
// subprocess regression. No financial fixtures, production imports or IO.
if (require.main === module && process.env.M1_ASYNC_HARNESS_NEGATIVE_CONTROLS === "1") {
  const test = require("node:test"), assert = require("node:assert/strict");
  for (const kind of ["rejection", "completion", "missing-start", "assertion-rejection"]) {
    test(`synthetic ${kind}`, async t => {
      const h = asyncHarness(t, { waitMs: 40, operationMs: 500, cleanupMs: 250 });
      const held = h.gate(), entered = deferred(), resource = { open: true, check: () => false };
      let drained = false, closed = false;
      t.mock.method(resource, "check", () => true);
      const handle = setTimeout(() => assert.fail("SYNTHETIC_HANDLE_LEAK"), 60000);
      h.onCleanup(() => { clearTimeout(handle); closed = true; });
      h.afterCleanup(() => {
        assert.equal(drained, true); assert.equal(closed, true); assert.equal(resource.open, true);
        resource.open = false; t.diagnostic(`cleanup verified: ${kind}`);
      });
      h.observe((async () => {
        await held.promise; assert.equal(resource.open, true); assert.equal(resource.check(), true); drained = true;
      })());
      const pending = h.run(async () => {
        if (kind === "missing-start") await held.promise;
        if (kind === "rejection" || kind === "assertion-rejection")
          throw Object.assign(new Error("SYNTHETIC_PRECONDITION"), { code: "SYNTHETIC_PRECONDITION" });
        return { notForDiagnostics: "SYNTHETIC_PRIVATE_RESULT" };
      });
      if (kind === "rejection") h.assertion(assert.rejects(pending));
      if (kind === "assertion-rejection") h.assertion(assert.rejects(pending, { code: "EXPECTED_DIFFERENT_CODE" }));
      await h.wait(entered.promise, pending, "synthetic start");
    });
  }
}
