"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const runner = require("../execute-top-whale-trigger.js"), guard = require("../lib/wallet-execution-guard.js");

function fixture(options = {}) {
  const state = { time: 0, passes: [], sleeps: [], loads: 0, reads: 0, outputs: [] };
  const pinned = { pin: { number: 100, timestamp: 1000 } };
  const dependencies = {
    loadCandidates: () => [], loadBatch: () => { state.loads++; return {}; },
    connect: async () => pinned, now: () => state.time,
    sleep: async ms => { state.sleeps.push(ms); state.time += ms; },
    liveHeadNumber: async value => {
      assert.equal(value, pinned); state.reads++;
      return options.head ? options.head(state) : 100;
    },
    runPass: async () => { state.passes.push(state.time); return { summary: options.summary || { targets: [] } }; },
    output: value => state.outputs.push(value),
  };
  const run = (argv = [], overrides = {}) => runner.main(["--check", "--no-write", "--watch", "20", "--max-runs", "2", ...argv],
    { ...dependencies, ...overrides });
  return { state, pinned, dependencies, run };
}

test("watch first pass is immediate; a new head starts the next pass without the old sleep", async () => {
  for (const readyAt of [0, 600]) {
    const f = fixture({ head: state => state.time >= readyAt ? 101 : 100 });
    await f.run();
    assert.deepEqual(f.state.passes, [0, readyAt]);
    assert.deepEqual(f.state.sleeps, readyAt ? [300, 300] : []);
    assert.equal(f.state.loads, 2, "authorization is reloaded for each pass");
    assert.equal(f.state.outputs.length, 2);
  }
});

test("watch with no head progress stops waiting at the adaptive cap", async () => {
  for (const near of [false, true]) {
    const f = fixture({ summary: { targets: near ? [{ positionStatus: "OPEN", debtRaw: "1", bpsToLiquidation: 1 }] : [] } });
    await f.run();
    const cap = near ? 6000 : 20000;
    assert.deepEqual(f.state.passes, [0, cap]);
    assert.equal(f.state.sleeps.reduce((sum, ms) => sum + ms, 0), cap);
    assert.ok(f.state.sleeps.every(ms => ms > 0 && ms <= 300));
  }
});

test("head read failures use the existing sleep and do not suppress the next pass", async () => {
  for (const failureAt of [1, 2]) {
    const f = fixture({ head: state => {
      if (state.reads === failureAt) throw new Error("OFFLINE_HEAD_FAILURE");
      return 100;
    } });
    await f.run();
    assert.deepEqual(f.state.passes, [0, 20000 + (failureAt - 1) * 300]);
    assert.equal(f.state.sleeps.at(-1), 20000);
    assert.doesNotMatch(JSON.stringify(f.state.outputs), /OFFLINE_HEAD_FAILURE/);
  }
});

test("missing live head method falls back to the existing minimum five-second sleep", async () => {
  const f = fixture();
  await runner.main(["--check", "--no-write", "--watch", "1", "--max-runs", "2"],
    { ...f.dependencies, liveHeadNumber: undefined });
  assert.deepEqual(f.state.passes, [0, 5000]); assert.deepEqual(f.state.sleeps, [5000]);
  assert.equal(f.state.reads, 0);
});

test("watch uses the pinned live head method when no dependency overrides it", async () => {
  const f = fixture(); let reads = 0;
  f.pinned.liveHeadNumber = async function () { assert.equal(this, f.pinned); reads++; return 101; };
  await f.run([], { liveHeadNumber: undefined });
  assert.equal(reads, 1); assert.deepEqual(f.state.passes, [0, 0]);
});

test("watch never polls or starts an overlapping pass while a pass is pending", async () => {
  const f = fixture({ head: () => 101 }); let active = 0, maximum = 0, runs = 0, releasePass, enteredPass;
  const gate = new Promise(resolve => { releasePass = resolve; }), entered = new Promise(resolve => { enteredPass = resolve; });
  const pending = f.run([], { runPass: async () => {
    runs++; active++; maximum = Math.max(maximum, active);
    try { if (runs === 1) { enteredPass(); await gate; } return { summary: { targets: [] } }; }
    finally { active--; }
  } });
  try {
    await entered; await new Promise(resolve => setImmediate(resolve));
    assert.equal(runs, 1); assert.equal(f.state.reads, 0); assert.equal(f.state.loads, 1);
  } finally { releasePass(); }
  await pending; assert.equal(maximum, 1); assert.equal(runs, 2);
});

test("verified-receipt immediate follow-up bypasses both polling and sleep", async () => {
  const f = fixture({ summary: { execution: { stage: "RECEIPT_VERIFIED" }, armed: true } });
  await f.run();
  assert.deepEqual(f.state.passes, [0, 0]); assert.equal(f.state.reads, 0); assert.deepEqual(f.state.sleeps, []);
});

test("failed passes still wait against their acquired pin; failed acquisition falls back", async () => {
  const f = fixture({ head: () => 101 }); let runs = 0;
  await f.run([], { runPass: async () => { if (++runs === 1) throw new guard.ExecutionError("OFFLINE_PASS_FAILED"); return { summary: {} }; } });
  assert.equal(runs, 2); assert.equal(f.state.reads, 1); assert.deepEqual(f.state.sleeps, []);
  const failed = fixture();
  await failed.run([], { connect: async () => { throw new guard.ExecutionError("OFFLINE_CONNECT_FAILED"); } });
  assert.equal(failed.state.outputs.length, 2); assert.equal(failed.state.reads, 0); assert.deepEqual(failed.state.sleeps, [20000]);
});

test("a stuck head read cannot overrun the wait cap", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0, done = false;
  const pending = runner.waitForNewHead({ number: 100 }, { intervalMs: 5000, now: () => 0,
    liveHeadNumber: () => { reads++; return new Promise(() => {}); }, sleep: () => assert.fail("no extra sleep at cap") });
  pending.then(() => { done = true; }); await Promise.resolve();
  t.mock.timers.tick(4999); await Promise.resolve(); assert.equal(done, false);
  t.mock.timers.tick(1); await pending; assert.equal(reads, 1);
});

test("focusedError records the sanitized initiating code before assertBase invalidation", async () => {
  for (const typed of [true, false]) for (const m1Only of [false, true]) {
    const events = [], original = typed ? new guard.ExecutionError("COLLECTOR_PIN_MISMATCH") : new Error("private diagnostic must not escape");
    if (typed) Object.defineProperty(original, "code", { get() { events.push("sanitize"); return "COLLECTOR_PIN_MISMATCH"; } });
    const invalidated = new guard.ExecutionError("PIN_EVIDENCE_INVALIDATED");
    const pinned = { pin: { number: 100, timestamp: 1000 }, assertUsable() { events.push("assertBase"); throw invalidated; } };
    await assert.rejects(runner.runPass({ pinned, argv: ["--measure-only", ...(m1Only ? ["--m1-only"] : [])], checkOnce: async () => { throw original; } }), error => {
      assert.equal(error, invalidated, "the thrown guard error is unchanged");
      const code = typed ? "COLLECTOR_PIN_MISMATCH" : "EXECUTION_FAILED";
      assert.equal(error.passSummary.focusedError, code);
      assert.equal(error.passSummary.preflightFailures[0].reason, code);
      assert.equal(error.passSummary.reason, "PIN_EVIDENCE_INVALIDATED");
      if (m1Only) {
        assert.equal(error.passSummary.collectionScope, "M1_ONLY"); assert.equal(error.passSummary.partial, true);
        assert.deepEqual(error.passSummary.targets, []); assert.equal(error.passSummary.armed, false);
      }
      assert.doesNotMatch(JSON.stringify(error.passSummary), /private diagnostic/);
      return true;
    });
    assert.deepEqual(events, typed ? ["sanitize", "assertBase"] : ["assertBase"]);
  }
});

test("M1-only watch passes argv through acquisition/preparation and never overlaps a pass or head wait", async () => {
  const f = fixture({ head: () => 101 }); let runs = 0, active = 0, maximum = 0, release, entered;
  const waiting = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const events = [], pending = f.run(["--m1-only", "--next-block"], {
    connect: async options => { assert.equal(active, 0); assert.ok(options.argv.includes("--m1-only")); events.push("connect"); return f.pinned; },
    runPass: async options => {
      assert.ok(options.argv.includes("--m1-only")); assert.ok(options.argv.includes("--next-block"));
      runs++; active++; maximum = Math.max(maximum, active); events.push("pass");
      try {
        if (runs === 1) { entered(); await waiting; }
        return { summary: { collectionScope: "M1_ONLY", partial: true, armed: false, targets: [] } };
      } finally { active--; }
    },
    liveHeadNumber: async pinned => { assert.equal(active, 0); assert.equal(pinned, f.pinned); events.push("head"); return 101; },
  });
  try { await started; await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, ["connect", "pass"]); }
  finally { release(); }
  await pending;
  assert.equal(maximum, 1); assert.equal(runs, 2); assert.deepEqual(events, ["connect", "pass", "head", "connect", "pass"]);
  assert.deepEqual(f.state.sleeps, []); assert.equal(f.state.loads, 2);
});

test("M1-only failures before runPass remain scoped, empty and disarmed in check and measurement modes", async () => {
  for (const measureOnly of [false, true]) {
    const f = fixture(); let attempts = 0, passes = 0;
    await f.run(["--m1-only", ...(measureOnly ? ["--measure-only", "--next-block"] : [])], {
      connect: async () => { if (++attempts === 1) return f.pinned; throw new Error("private acquisition diagnostic"); },
      runPass: async () => { passes++; return { summary: { collectionScope: "M1_ONLY", partial: true, armed: false, targets: [{ user: "previous-pass" }] } }; },
    });
    const failed = f.state.outputs[1]; assert.equal(passes, 1); assert.equal(failed.collectionScope, "M1_ONLY");
    assert.equal(failed.partial, true); assert.equal(failed.armed, false); assert.deepEqual(failed.targets, []);
    assert.equal(failed.mode, measureOnly ? "MEASURE_ONLY" : "BLOCKED"); assert.equal(failed.reason, "EXECUTION_FAILED");
    assert.doesNotMatch(JSON.stringify(failed), /private acquisition diagnostic|previous-pass/);
    assert.equal(failed.phaseTimingsMs.focusedM1Collection, null); assert.equal(failed.phaseTimingsMs.broadCollection, null);
    if (measureOnly) { assert.equal(f.state.loads, 0); assert.equal(failed.measurements.fullPreparation, "NOT_MEASURED_NONCE_FORBIDDEN"); }
  }
  const f = fixture();
  await f.run(["--m1-only"], { loadBatch: () => { throw new guard.ExecutionError("BATCH_INVALID_OR_EXPIRED"); },
    connect: () => assert.fail("batch failure must precede acquisition"), runPass: () => assert.fail("batch failure must precede runPass") });
  for (const failed of f.state.outputs) {
    assert.equal(failed.collectionScope, "M1_ONLY"); assert.equal(failed.partial, true); assert.equal(failed.armed, false);
    assert.deepEqual(failed.targets, []); assert.equal(failed.reason, "BATCH_INVALID_OR_EXPIRED");
    assert.equal(failed.phaseTimingsMs.acquisition, null);
  }
});

test("qualified-pair watch serializes acquisition, preparation and head waits before acquiring a fresh pin", async () => {
  const f = fixture(), events = [], inventories = [], pins = [];
  let active = 0, maximum = 0, acquisitions = 0, passes = 0, factories = 0, closes = 0;
  const gates = Array.from({ length: 3 }, () => {
    let enter, release;
    return { started: new Promise(resolve => { enter = resolve; }), waiting: new Promise(resolve => { release = resolve; }),
      enter: () => enter(), release: () => release() };
  });
  const stage = async (name, gate) => {
    events.push(name); active++; maximum = Math.max(maximum, active);
    try { if (gate) { gate.enter(); await gate.waiting; } } finally { active--; }
  };
  const pending = f.run(["--m1-only", "--reuse-qualified-pair", "--next-block"], {
    loadCandidates: () => { assert.equal(active, 0); const inventory = []; inventories.push(inventory); return inventory; },
    createQualifiedPairFactory: profile => {
      factories++; assert.equal(profile.requireStrictEvidence, true); assert.equal(profile.requireNextBlock, true);
      return {
        acquire: async ({ candidates }) => {
          assert.equal(active, 0); assert.equal(candidates, inventories[acquisitions]); acquisitions++;
          await stage("acquire", acquisitions === 1 ? gates[0] : null);
          const pinned = { pin: { number: 100 + acquisitions, timestamp: 1000 } }; pins.push(pinned); return pinned;
        },
        close: () => { assert.equal(active, 0); closes++; events.push("close"); },
      };
    },
    connect: options => runner.connectForPass({ ...options, create: () => assert.fail("reuse cannot enter fallback") }),
    runPass: async options => {
      assert.equal(active, 0); assert.equal(options.pinned, pins[passes]); passes++;
      await stage("pass", passes === 1 ? gates[1] : null);
      return { summary: { collectionScope: "M1_ONLY", partial: true, armed: false, targets: [] } };
    },
    liveHeadNumber: async pinned => { assert.equal(active, 0); assert.equal(pinned, pins[0]); await stage("head", gates[2]); return 102; },
  });
  try {
    for (const [index, gate] of gates.entries()) {
      await gate.started; await new Promise(resolve => setImmediate(resolve));
      assert.equal(acquisitions, 1); assert.equal(inventories.length, 1); assert.equal(f.state.loads, 1);
      assert.deepEqual(events, ["acquire", "pass", "head"].slice(0, index + 1)); gate.release();
    }
  } finally { for (const gate of gates) gate.release(); }
  await pending;
  assert.equal(maximum, 1); assert.equal(factories, 1); assert.equal(closes, 1);
  assert.equal(acquisitions, 2); assert.equal(passes, 2); assert.equal(f.state.loads, 2);
  assert.notEqual(pins[0], pins[1]); assert.notEqual(inventories[0], inventories[1]);
  assert.deepEqual(events, ["acquire", "pass", "head", "acquire", "pass", "close"]); assert.deepEqual(f.state.sleeps, []);
});
