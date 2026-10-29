"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const runner = require("../execute-top-whale-trigger.js"), m1 = require("../lib/m1-live-evidence.js"), guard = require("../lib/wallet-execution-guard.js");
const live = require("./m1-live-evidence.test.js");
const FLAGS = ["--m1-only", "--m1-hot-path-v2", "--no-write"];
const forbidden = () => assert.fail("OFFLINE_FORBIDDEN_IO");
const fetch = globalThis.fetch;
test.before(() => { globalThis.fetch = forbidden; }); test.after(() => { globalThis.fetch = fetch; });
function clocks(start = live.NOW) {
  const c = { wall: start, mono: 100, start, wallNow: () => c.wall, monotonicNow: () => c.mono,
    set: elapsed => { c.wall = start + elapsed; c.mono = 100 + elapsed; } };
  return c;
}
function setup(t, { future = false, start = live.NOW, onRecheck, ...options } = {}) {
  let f;
  const base = live.fixture(t, { ...options, future, recheckEdit: (state, pinned, stage) => onRecheck?.(f, stage) });
  const current = future ? { ...base.pinned, nextBlock: undefined, evidence: { ...base.pinned.evidence, nextBlockQualified: false } } : base.pinned;
  const lease = { current, takeFuture: () => base.pinned, cancelFuture() {} }, clock = clocks(start);
  const budget = runner.createM1V2Budget(clock); budget.bind(lease);
  f = { ...base, current, lease, clock, budget };
  f.run = overrides => base.run({ argv: [...FLAGS, ...(future ? ["--next-block"] : [])], pinned: current,
    now: clock.wallNow, hotPathLease: lease, m1Budget: budget, ...overrides })
    .catch(error => ({ fired: false, error, summary: error.passSummary }));
  return f;
}
function noSign(f) { assert.equal(f.state.signs, 0); assert.equal(f.state.sends, 0); assert.equal(f.budget.snapshot().unsignedReadyWallMs, null); }

test("explicit capability mode requires v2/M1-only and preserves legacy/reuse conflicts", () => {
  assert.equal(runner.parseRunnerMode([]).m1CapabilityV1, false);
  assert.equal(runner.parseRunnerMode(FLAGS).m1CapabilityV1, false);
  assert.equal(runner.parseRunnerMode([...FLAGS, "--m1-capability-v1"]).m1CapabilityV1, true);
  for (const argv of [["--m1-capability-v1"], ["--m1-only", "--m1-capability-v1"], ["--m1-hot-path-v2", "--m1-capability-v1"],
    [...FLAGS, "--m1-capability-v1", "--reuse-qualified-pair"]]) assert.throws(() => runner.parseRunnerMode(argv));
  assert.equal(runner.parseRunnerMode(["--m1-only", "--reuse-qualified-pair"]).reuseQualifiedPair, true);
});

for (const capability of [false, true]) test(`main stamps before inventory loading/acquisition and forwards qualification mode (${capability})`, async t => {
  const f = setup(t), clock = clocks(), outputs = []; let profile, passed = false;
  await runner.main([...FLAGS, "--check", ...(capability ? ["--m1-capability-v1"] : [])], {
    wallNow: clock.wallNow, monotonicNow: clock.monotonicNow, now: () => 987654321,
    loadCandidates: () => { clock.set(2000); return []; }, loadBatch: () => live.batch(0),
    createM1HotPathFactory: options => { profile = options; return { maintain() {}, acquire: async () => { clock.set(4000); return f.lease; }, close() {} }; },
    connect: config => runner.connectForPass(config),
    runPass: async args => {
      passed = true; assert.equal(args.m1Budget.snapshot().detectionWallMs, live.NOW);
      assert.equal(args.m1Budget.snapshot().detectionMonoMs, 100); clock.set(6000);
      args.m1Budget.acceptUnsigned(f.lease, f.current);
      return { summary: { m1Budget: args.m1Budget.snapshot() } };
    }, output: value => outputs.push(value),
  });
  assert.equal(profile.qualificationMode, capability ? "capability-v1" : "fresh");
  assert.equal(passed, true); assert.equal(outputs[0].m1Budget.fullUnsignedElapsedMs, 6000);
});

test("missing/expired foreground selection holds without a second acquisition or readiness rescue", async () => {
  const clock = clocks(); let acquisitions = 0, maintenance = 0, passes = 0; const outputs = [], exitCode = process.exitCode;
  try {
    await runner.main([...FLAGS, "--check", "--m1-capability-v1"], {
      wallNow: clock.wallNow, monotonicNow: clock.monotonicNow, loadCandidates: () => [], loadBatch: () => ({}),
      createM1HotPathFactory: () => ({ maintain() { maintenance++; }, acquire() { acquisitions++; throw new guard.ExecutionError("M1_HOT_PATH_SELECTION_HOLD"); }, close() {} }),
      connect: config => runner.connectForPass(config), runPass: async () => { passes++; }, output: value => outputs.push(value),
    });
  } finally { process.exitCode = exitCode; }
  assert.equal(acquisitions, 1); assert.equal(maintenance, 1); assert.equal(passes, 0);
  assert.equal(outputs[0].reason, "M1_HOT_PATH_SELECTION_HOLD"); assert.equal(outputs[0].m1Budget.detectionWallMs, live.NOW);
});

for (const future of [false, true]) {
  const mode = future ? "FUTURE" : "CURRENT";
  for (const elapsed of [6000, 6001]) test(`${mode}: final wallet validation at ${elapsed}ms accepts only the inclusive unsigned budget`, async t => {
    const f = setup(t, { future, onRecheck(f, stage) { if (stage === "preSign") f.clock.set(elapsed); } });
    const result = await f.run();
    if (elapsed === 6000) {
      assert.equal(result.fired, true); assert.equal(f.state.signs, 1); assert.equal(f.state.sends, 1);
      assert.equal(result.summary.m1Budget.fullUnsignedElapsedMs, 6000); assert.equal(result.summary.m1Budget.childHeadroomMs, 3000);
    } else {
      noSign(f); assert.equal(result.summary.reason, "M1_V2_UNSIGNED_BUDGET_EXCEEDED");
      assert.equal(guard.readJournals(f.journalDir)[0].record.stage, "ABORTED_UNSIGNED");
      assert.notEqual(result.summary.reason, "SIGNED_ATTEMPT_ENDED_PASS");
    }
  });
  for (const headroom of [2000, 1999]) test(`${mode}: final unsigned child reserve ${headroom}ms is checked against the original parent`, async t => {
    const f = setup(t, { future, start: live.PIN.timestamp * 1000 + 5000,
      onRecheck(f, stage) { if (stage === "preSign") f.clock.set(7000 - headroom); } });
    const result = await f.run();
    assert.equal(result.fired, headroom === 2000);
    if (headroom === 1999) { noSign(f); assert.equal(result.summary.reason, "M1_V2_CHILD_HEADROOM_INSUFFICIENT"); }
    else assert.equal(result.summary.m1Budget.unsignedReadyChildHeadroomMs, 2000);
  });
  test(`${mode}: six-second acceptance does not restart at signer/send; dispatch independently retains two seconds`, async t => {
    for (const dispatchElapsed of [7000, 9001]) {
      const f = setup(t, { future, start: live.PIN.timestamp * 1000 + 1000,
        onRecheck(f, stage) { if (stage === "preSign") f.clock.set(6000); } });
      const result = await f.run({ signTransaction: tx => { const raw = f.signTransaction(tx); f.clock.set(dispatchElapsed); return raw; } });
      assert.equal(f.state.signs, 1); assert.equal(result.fired, dispatchElapsed === 7000);
      assert.equal(f.state.sends, dispatchElapsed === 7000 ? 1 : 0);
      assert.equal(f.budget.snapshot().fullUnsignedElapsedMs, 6000);
      assert.equal(f.budget.snapshot().detectionWallMs, live.PIN.timestamp * 1000 + 1000);
      if (dispatchElapsed === 9001) assert.equal(guard.readJournals(f.journalDir)[0].record.stage, "UNCERTAIN");
    }
  });
  test(`${mode}: primary and secondary receive additive synchronous reserve guards (factory physical hook remains a dependency)`, async t => {
    const f = setup(t, { future }); let primary = 0, secondary = 0;
    const send = f.pinned.send;
    f.pinned.send = async (signed, additional) => {
      primary++; assert.equal(typeof additional, "function"); assert.equal(additional(), undefined); return send(signed);
    };
    if (!future) f.current.send = f.pinned.send;
    const result = await f.run({ secondarySendRawTransaction: async (signed, composite) => {
      secondary++; assert.equal(typeof composite, "function"); assert.equal(composite(), undefined); assert.equal(signed, "0x010203");
    } });
    assert.equal(result.fired, true); assert.equal(primary, 1); assert.equal(secondary, 1);
  });
  test(`${mode}: late authorization/candidate invalidation still aborts unsigned with a live budget`, async t => {
    for (const kind of ["authorization", "candidate"]) {
      let candidate;
      const original = m1.executeM1;
      const mocked = t.mock.method(m1, "executeM1", args => { candidate = args.candidate; assert.equal(args.preparationMode, "parallel-v2"); return original(args); });
      const f = setup(t, { future,
        onRecheck(f, stage) { if (kind === "candidate" && stage === "preSign") candidate.data += "00"; },
        readFile(file, state, stage) {
          const raw = live.readEvidence(file);
          return kind === "authorization" && stage === "preSign" && file.replace(/\\/g, "/").endsWith(m1.AMENDMENT_PATH)
            ? Buffer.concat([raw, Buffer.from(" ")]) : raw;
        },
      });
      try {
        const result = await f.run(); noSign(f); assert.equal(result.fired, false);
        assert.equal(guard.readJournals(f.journalDir)[0].record.stage, "ABORTED_UNSIGNED");
      } finally { mocked.mock.restore(); }
    }
  });
  test(`${mode}: crossing after wallet validation but before original signer still never marks a signed attempt`, async t => {
    const f = setup(t, { future }), original = m1.executeM1;
    t.mock.method(m1, "executeM1", args => original({ ...args, signTransaction: tx => {
      f.clock.set(6001); return args.signTransaction(tx);
    } }));
    const result = await f.run(); noSign(f);
    assert.equal(result.summary.reason, "M1_V2_UNSIGNED_BUDGET_EXCEEDED");
    assert.notEqual(result.summary.reason, "SIGNED_ATTEMPT_ENDED_PASS");
    // The guard's existing signer-boundary uncertainty policy is unchanged:
    // a throw after its pre-sign validation retains PREPARED, never an auto retry.
    assert.equal(guard.readJournals(f.journalDir)[0].record.stage, "PREPARED");
  });
  for (const cause of ["microtask", "budget-clock"]) test(`${mode}: ${cause} trust revocation in the final signer gap never reaches the original signer`, async t => {
    const f = setup(t, { future }), originalGuard = guard.executeGuarded, originalUsable = f.pinned.assertUsable;
    const pin = JSON.stringify(f.pinned.pin), context = JSON.stringify(f.pinned.nextBlock.context);
    const wall = f.clock.wall, mono = f.clock.mono, events = [], boundary = [];
    let revoked = false, gapArmed = false, finalChecks, originalSigns = 0, keys = 0, secondary = 0;
    t.mock.method(guard, "signWithProcessKey", () => { keys++; assert.fail("REAL_KEY_ACCESS_FORBIDDEN"); });
    f.pinned.assertUsable = () => {
      originalUsable(); if (gapArmed) boundary.push(revoked ? "revoked-proof-checked" : "live-proof-checked");
      guard.requireThat(!revoked, "PIN_EVIDENCE_INVALIDATED");
    };
    if (cause === "budget-clock") Object.defineProperty(f.clock, "mono", { get() {
      if (gapArmed && !revoked) { revoked = true; boundary.push("clock-revoked"); }
      return mono;
    } });
    // Delegate the real guard and every real validation/preparation. Only queue
    // revocation after its final awaited validation has returned valid caps.
    t.mock.method(guard, "executeGuarded", args => originalGuard({ ...args, validate: async () => {
      const caps = await args.validate(), records = guard.readJournals(f.journalDir);
      if (!gapArmed && records.length === 1 && records[0].record.stage === "PREPARED" && f.state.signs === 0) {
        assert.equal(records[0].record.txHash, null); assert.equal(f.state.executorCalls, 3);
        finalChecks = f.state.checks; boundary.push("final-validation-returned");
        queueMicrotask(() => {
          gapArmed = true; boundary.push("final-gap-entered");
          if (cause === "microtask") { revoked = true; boundary.push("microtask-revoked"); }
        });
      }
      return caps;
    } }));
    const result = await f.run({ onTiming: event => events.push(event),
      signTransaction: tx => { originalSigns++; return f.signTransaction(tx); },
      secondarySendRawTransaction: () => { secondary++; assert.fail("REVOKED_SECONDARY_SEND"); } });
    assert.equal(gapArmed, true); assert.equal(revoked, true); assert.equal(f.state.checks, finalChecks);
    assert.equal(result.fired, false); assert.equal(originalSigns, 0); assert.equal(keys, 0);
    assert.equal(f.state.signs, 0); assert.equal(f.state.sends, 0); assert.equal(secondary, 0);
    assert.equal(result.summary.reason, "PIN_EVIDENCE_INVALIDATED");
    assert.notEqual(result.summary.reason, "SIGNED_ATTEMPT_ENDED_PASS");
    assert.deepEqual(boundary.slice(0, 2), ["final-validation-returned", "final-gap-entered"]);
    assert.ok(boundary.indexOf("revoked-proof-checked") > boundary.indexOf(cause === "microtask" ? "microtask-revoked" : "clock-revoked"));
    if (cause === "budget-clock") assert.ok(boundary.indexOf("live-proof-checked") < boundary.indexOf("clock-revoked"));
    assert.equal(JSON.stringify(f.pinned.pin), pin); assert.equal(JSON.stringify(f.pinned.nextBlock.context), context);
    assert.equal(f.clock.wall, wall); assert.equal(f.clock.mono, mono);
    if (future) assert.doesNotThrow(f.current.assertUsable, "only the active FUTURE facade was revoked");
    const records = guard.readJournals(f.journalDir); assert.equal(records.length, 1);
    assert.equal(records[0].record.stage, "PREPARED"); assert.equal(records[0].record.txHash, null);
    assert.equal(records[0].record.signedTransactionBinding, undefined);
    // Existing sign spans time wrapper entry, not actual signature production.
    assert.deepEqual(events.filter(event => event.phase === "sign").map(event => event.edge), ["start", "end"]);
    assert.equal(events.filter(event => ["send", "sendAck"].includes(event.phase)).length, 0);
    assert.doesNotMatch(JSON.stringify(events), /signature|signedTransaction|0x010203/);
  });
  test(`${mode}: late nonfinite clock holds unsigned and budget telemetry stays finite`, async t => {
    const f = setup(t, { future, onRecheck(f, stage) { if (stage === "preSign") f.clock.mono = NaN; } });
    const result = await f.run(); noSign(f); assert.equal(result.summary.reason, "M1_V2_CLOCK_INVALID");
    assert.ok(Object.values(result.summary.m1Budget).every(value => value === null || Number.isFinite(value)));
  });
}

test("budget clock faults are terminal: nonfinite, negative, reversed, throwing and accumulated drift", async t => {
  for (const mutate of [c => c.wall = NaN, c => c.mono = Infinity, c => c.mono = -1, c => c.wall--, c => c.mono--,
    c => c.wall += 3, c => c.mono += 3]) {
    const f = setup(t); mutate(f.clock);
    assert.throws(() => f.budget.assert(f.lease, f.current), { code: "M1_V2_CLOCK_INVALID" });
    f.clock.set(0); assert.throws(() => f.budget.assert(f.lease, f.current), { code: "M1_V2_CLOCK_INVALID" });
    noSign(f);
  }
  assert.throws(() => runner.createM1V2Budget({ wallNow() { throw new Error("PRIVATE"); } }), { code: "M1_V2_CLOCK_INVALID" });
  const f = setup(t); f.clock.wall++; f.budget.assert(f.lease, f.current); f.clock.wall++;
  f.budget.assert(f.lease, f.current); f.clock.wall++;
  assert.throws(() => f.budget.assert(f.lease, f.current), { code: "M1_V2_CLOCK_INVALID" });
});

test("budget is single-bind, pin/lease/context bound, nonforgeable through JSON, and never restamped", async t => {
  for (const mutate of [f => ({ ...f.lease }), f => { f.current.pin = { ...f.current.pin, hash: live.hash(42) }; return f.lease; }]) {
    const f = setup(t), lease = mutate(f);
    assert.throws(() => f.budget.assert(lease, f.current), { code: "M1_V2_BUDGET_BINDING_INVALID" });
  }
  const f = setup(t); assert.throws(() => f.budget.bind(f.lease), { code: "M1_V2_BUDGET_BINDING_INVALID" });
  const absent = setup(t), result = await absent.run({ m1Budget: undefined });
  assert.equal(result.summary.reason, "M1_V2_BUDGET_REQUIRED"); noSign(absent);
  const forged = setup(t), rejected = await forged.run({ m1Budget: { ...forged.budget } });
  assert.equal(rejected.summary.reason, "M1_V2_BUDGET_REQUIRED"); noSign(forged);
  const future = setup(t, { future: true });
  assert.throws(() => future.budget.assert(future.lease, future.pinned, { ...future.context, timestamp: future.context.timestamp + 1 }), { code: "M1_V2_BUDGET_BINDING_INVALID" });
});

test("M1 rejects asynchronous/non-undefined budget assertions without replacing existing proof guards", async t => {
  for (const assertBudget of [() => true, async () => {}, () => Promise.reject(new Error("PRIVATE"))]) {
    const f = setup(t), original = m1.executeM1;
    const mocked = t.mock.method(m1, "executeM1", args => original({ ...args, assertBudget }));
    try { const result = await f.run(); assert.equal(result.fired, false); noSign(f); assert.equal(fs.existsSync(f.journalDir), false); }
    finally { mocked.mock.restore(); }
  }
});
