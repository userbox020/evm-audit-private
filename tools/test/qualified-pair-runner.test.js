"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const runner = require("../execute-top-whale-trigger.js"), guard = require("../lib/wallet-execution-guard.js");
const transport = require("../lib/executor-pinned-rpc.js"), m1 = require("../lib/m1-live-evidence.js");
const forbidden = () => assert.fail("unexpected production transport, fallback or wallet IO");
const flags = ["--m1-only", "--reuse-qualified-pair"];

function forbidProductionFactory(t) {
  const descriptor = Object.getOwnPropertyDescriptor(transport, "createQualifiedPairFactory");
  Object.defineProperty(transport, "createQualifiedPairFactory", { configurable: true, get: forbidden });
  t.after(() => { if (descriptor) Object.defineProperty(transport, "createQualifiedPairFactory", descriptor); else delete transport.createQualifiedPairFactory; });
}

function fixture() {
  const state = { time: 0, profiles: [], inventories: [], acquired: [], pins: [], batches: [], passes: [], outputs: [], sleeps: [], heads: [], closes: 0 };
  const factory = {
    acquire: async options => {
      state.acquired.push(options);
      const pinned = { pin: { number: 100 + state.acquired.length, timestamp: 1000, hash: "0x" + "ab".repeat(32) },
        evidence: { strictEvidence: true }, assertUsable() {}, collectorOptions: {},
        nonce: forbidden, send: forbidden, receipt: forbidden, code: forbidden, estimateGas: forbidden,
        nextBlock: { context: null, recheck: forbidden, simulate: forbidden } };
      state.pins.push(pinned); return pinned;
    },
    invalidate: forbidden, // Eligibility eviction/cold selection belongs to the real transport, not the runner stub.
    close: async () => { state.closes++; },
  };
  const dependencies = {
    createQualifiedPairFactory: profile => { state.profiles.push(profile); return factory; },
    connect: options => runner.connectForPass({ ...options, create: forbidden }),
    loadCandidates: () => { const inventory = [{ family: `offline-${state.inventories.length}` }]; state.inventories.push(inventory); return inventory; },
    loadBatch: () => { const batch = { revision: state.batches.length }; state.batches.push(batch); return batch; },
    runPass: async options => { state.passes.push(options); return { summary: { collectionScope: "M1_ONLY", partial: true, armed: false, targets: [] } }; },
    output: value => state.outputs.push(value), now: () => state.time,
    sleep: async ms => { state.sleeps.push(ms); state.time += ms; },
    liveHeadNumber: async pinned => { state.heads.push(pinned); return pinned.pin.number + 1; },
  };
  const run = (argv = [], overrides = {}) => runner.main(["--check", "--no-write", "--watch", "20", "--max-runs", "2", ...flags, ...argv],
    { ...dependencies, ...overrides });
  return { state, factory, dependencies, run };
}

test("reuse flag is opt-in and rejects missing M1 scope before any IO", async () => {
  assert.equal(runner.parseRunnerMode([]).reuseQualifiedPair, false);
  for (const extra of [[], ["--next-block"], ["--measure-only", "--next-block"], ["--execute"]]) {
    const argv = ["--reuse-qualified-pair", ...extra];
    const rejected = error => error instanceof guard.ExecutionError && guard.safeError(error) === "QUALIFIED_PAIR_REQUIRES_M1_ONLY";
    assert.throws(() => runner.parseRunnerMode(argv), rejected);
    await assert.rejects(runner.main(argv, { createQualifiedPairFactory: forbidden, connect: forbidden, loadBatch: forbidden, loadCandidates: forbidden }), rejected);
    await assert.rejects(runner.connectForPass({ argv, candidates: [], create: forbidden, qualifiedPairFactory: { acquire: forbidden } }), rejected);
    assert.equal(runner.parseRunnerMode([...flags, ...extra]).reuseQualifiedPair, true);
  }
});

test("an offline connect override requires explicit factory injection; missing factory never falls back", async t => {
  forbidProductionFactory(t);
  await assert.rejects(runner.main(flags, { connect: forbidden, loadBatch: forbidden, loadCandidates: forbidden }),
    error => guard.safeError(error) === "QUALIFIED_PAIR_FACTORY_INJECTION_REQUIRED");
  await assert.rejects(runner.connectForPass({ argv: flags, candidates: [], create: forbidden }),
    error => guard.safeError(error) === "QUALIFIED_PAIR_FACTORY_REQUIRED");
  const f = fixture(); await f.run();
  assert.equal(f.state.profiles.length, 1); assert.equal(f.state.closes, 1);
});

test("reused acquisition calls acquire exactly once and propagates failures without weaker creates", async () => {
  for (const extra of [[], ["--next-block"], ["--measure-only", "--next-block"]]) {
    for (const error of [new guard.ExecutionError("NEXT_BLOCK_CAPABILITY_UNAVAILABLE"), new Error("private acquisition diagnostic")]) {
      const candidates = [], calls = [], qualifiedPairFactory = { acquire: async options => { calls.push(options); throw error; } };
      await assert.rejects(runner.connectForPass({ argv: [...flags, ...extra], candidates, rpc: forbidden, create: forbidden, qualifiedPairFactory }),
        actual => actual === error);
      assert.deepEqual(calls, [{ candidates }]); assert.equal(calls[0].candidates, candidates);
    }
  }
  const pin = {}, qualifiedPairFactory = { acquire: async () => pin };
  assert.equal(await runner.connectForPass({ argv: flags, candidates: [], create: forbidden, qualifiedPairFactory }), pin);
});

test("one factory per invocation fixes a strict 60-second profile and reloads inventory/authorization every pass", async () => {
  for (const extra of [[], ["--next-block"], ["--measure-only"], ["--measure-only", "--next-block"]]) {
    const f = fixture(), measureOnly = extra.includes("--measure-only");
    await f.run(extra);
    assert.equal(f.state.profiles.length, 1);
    const profile = f.state.profiles[0];
    assert.deepEqual(profile, { rpc: transport.httpRpc, ttlMs: 60000, requireStrictEvidence: true,
      requireNextBlock: extra.includes("--next-block") && !measureOnly, requireTrace: false });
    assert.equal(Object.isFrozen(profile), true);
    assert.throws(() => { profile.requireStrictEvidence = false; }, TypeError);
    assert.throws(() => { profile.requireNextBlock = !profile.requireNextBlock; }, TypeError);
    assert.equal(f.state.inventories.length, 2); assert.equal(f.state.acquired.length, 2);
    assert.notEqual(f.state.inventories[0], f.state.inventories[1]); assert.notEqual(f.state.pins[0], f.state.pins[1]);
    assert.equal(f.state.batches.length, measureOnly ? 0 : 2);
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(Object.keys(f.state.acquired[i]), ["candidates"]);
      assert.equal(f.state.acquired[i].candidates, f.state.inventories[i]);
      assert.equal(f.state.passes[i].pinned, f.state.pins[i]);
      assert.equal(f.state.passes[i].batch, measureOnly ? undefined : f.state.batches[i]);
      assert.ok(f.state.passes[i].argv.includes("--m1-only")); assert.equal(f.state.passes[i].writeOut, false);
      const timings = f.state.passes[i].timings.snapshot();
      assert.equal(typeof timings.acquisition, "number");
      assert.deepEqual(timings.boundaries.map(row => [row.phase, row.edge]), [["acquisition", "start"], ["acquisition", "end"]]);
    }
    assert.deepEqual(f.state.heads, [f.state.pins[0]]); assert.equal(f.state.closes, 1);
    await f.run(extra);
    assert.equal(f.state.profiles.length, 2, "no process-global factory reuse"); assert.equal(f.state.closes, 2);
  }
});

test("failed acquisition holds the whole pass, waits boundedly, and delegates only the next acquisition to the factory", async () => {
  for (const extra of [[], ["--next-block"], ["--measure-only", "--next-block"]]) for (const typed of [true, false]) {
    const f = fixture(), acquire = f.factory.acquire; let attempts = 0;
    f.factory.acquire = async options => {
      if (++attempts === 2) { f.state.acquired.push(options); throw typed ? new guard.ExecutionError("NEXT_BLOCK_CAPABILITY_UNAVAILABLE") : new Error("private diagnostic"); }
      return acquire(options);
    };
    await f.run(extra, {
      runPass: async options => { f.state.passes.push(options); return { summary: { targets: [{ user: "previous-pass" }], armed: false } }; },
    });
    assert.equal(attempts, 2); assert.equal(f.state.passes.length, 1);
    const failed = f.state.outputs[1];
    assert.equal(failed.reason, typed ? "NEXT_BLOCK_CAPABILITY_UNAVAILABLE" : "EXECUTION_FAILED");
    assert.equal(failed.mode, extra.includes("--measure-only") ? "MEASURE_ONLY" : "BLOCKED");
    assert.equal(failed.collectionScope, "M1_ONLY"); assert.equal(failed.partial, true); assert.equal(failed.armed, false);
    assert.deepEqual(failed.targets, []); assert.doesNotMatch(JSON.stringify(failed), /private diagnostic|previous-pass/);
    assert.equal(typeof failed.phaseTimingsMs.acquisition, "number");
    assert.deepEqual(failed.phaseTimingsMs.boundaries.map(row => [row.phase, row.edge]), [["acquisition", "start"], ["acquisition", "end"]]);
    assert.equal(failed.phaseTimingsMs.boundaries[1].parentAgeMs, null);
    assert.equal(failed.phaseTimingsMs.focusedM1Collection, null); assert.equal(failed.phaseTimingsMs.broadCollection, null);
    assert.equal(f.state.closes, 1);
  }
  const f = fixture(), acquire = f.factory.acquire; let attempts = 0;
  f.factory.acquire = async options => {
    if (++attempts === 2) { f.state.acquired.push(options); throw new guard.ExecutionError("PIN_EVIDENCE_INVALIDATED"); }
    return acquire(options);
  };
  await runner.main(["--check", "--no-write", "--watch", "20", "--max-runs", "3", ...flags, "--next-block"], f.dependencies);
  assert.equal(attempts, 3); assert.equal(f.state.profiles.length, 1); assert.equal(f.state.inventories.length, 3);
  assert.equal(f.state.passes.length, 2); assert.notEqual(f.state.passes[0].pinned, f.state.passes[1].pinned);
  assert.deepEqual(f.state.heads, [f.state.pins[0]], "a failed acquisition must not reuse the previous pin for head wait/proof");
  assert.deepEqual(f.state.sleeps, [20000]); assert.equal(f.state.closes, 1);
  // No COLD/WARM claim here: the stub establishes runner delegation, not actual transport eviction.
});

test("authorization reload failures skip acquisition and retain scoped empty telemetry", async () => {
  const f = fixture(); let loads = 0;
  await f.run([], { loadBatch: () => { loads++; throw new guard.ExecutionError("BATCH_INVALID_OR_EXPIRED"); } });
  assert.equal(loads, 2); assert.equal(f.state.acquired.length, 0); assert.equal(f.state.inventories.length, 0);
  assert.equal(f.state.passes.length, 0); assert.deepEqual(f.state.sleeps, [20000]); assert.equal(f.state.closes, 1);
  for (const failed of f.state.outputs) {
    assert.equal(failed.reason, "BATCH_INVALID_OR_EXPIRED"); assert.equal(failed.collectionScope, "M1_ONLY");
    assert.equal(failed.partial, true); assert.equal(failed.armed, false); assert.deepEqual(failed.targets, []);
    assert.equal(failed.phaseTimingsMs.acquisition, null);
  }
});

test("measure-only flag combinations run real M1-only admission with no batch/nonce/future/key/sign/write IO", async t => {
  for (const method of ["reconcileWallet", "executeGuarded", "acquireWalletLock", "signWithProcessKey"]) t.mock.method(guard, method, forbidden);
  for (const method of ["readFileSync", "existsSync", "writeFileSync", "mkdirSync", "renameSync", "openSync"]) t.mock.method(fs, method, forbidden);
  for (const extra of [[], ["--next-block"], ["--next-block", "--include-aave-v4"]]) {
    const f = fixture(); let collections = 0;
    await runner.main(["--measure-only", "--watch", "20", "--max-runs", "2", ...flags, ...extra], {
      ...f.dependencies, loadBatch: forbidden,
      runPass: options => runner.runPass({ ...options, now: () => 1000000, loadMorphoBatch: forbidden,
        signTransaction: forbidden, m1ReadFile: forbidden, amendmentReadFile: forbidden,
        checkOnce: async collection => {
          collections++; assert.equal(collection.m1Only, true); assert.equal(collection.writeOut, false); assert.equal(collection.nextBlockContext, null);
          return { pin: { ...options.pinned.pin, chainId: 1 }, targets: {
            [m1.ID]: { user: m1.BORROWER, rank: `FRESH-${collections}`, liquidatableNow: false }, unrelated: { user: "unrelated", liquidatableNow: true },
          } };
        } }),
    });
    assert.equal(collections, 2); assert.equal(f.state.profiles[0].requireStrictEvidence, true);
    assert.equal(f.state.profiles[0].requireNextBlock, false); assert.equal(f.state.closes, 1);
    for (const [index, result] of f.state.outputs.entries()) {
      assert.equal(result.ok, true); assert.equal(result.mode, "MEASURE_ONLY"); assert.equal(result.armed, false);
      assert.equal(result.collectionScope, "M1_ONLY"); assert.equal(result.partial, true); assert.equal(result.partition, "M1_ONLY");
      assert.deepEqual(result.targets.map(row => [row.user, row.rank]), [[m1.BORROWER, `FRESH-${index + 1}`]]);
      assert.equal(result.phaseTimingsMs.broadCollection, null); assert.equal(result.candidateCount, 0);
      assert.ok(Object.values(result.phaseTimingsMs.preparation).every(value => value === null));
      assert.deepEqual(result.measurements, { futureQualification: "NOT_MEASURED_NONCE_FORBIDDEN", exactExecution: "NOT_MEASURED_NONCE_FORBIDDEN", fullPreparation: "NOT_MEASURED_NONCE_FORBIDDEN" });
      assert.equal(result.nextBlock.enabled, false);
    }
  }
  for (const flag of ["--execute", "--execute-if-liquidatable"]) await assert.rejects(runner.main(["--measure-only", ...flags, "--next-block", flag],
    { createQualifiedPairFactory: forbidden, loadBatch: forbidden }), error => guard.safeError(error) === "MEASURE_ONLY_EXECUTION_FORBIDDEN");
});

test("default connector keeps the existing strict/nonstrict and next-block fallback ladder with no factory access", async t => {
  forbidProductionFactory(t);
  for (const extra of [[], ["--next-block"], ["--measure-only", "--next-block"]]) {
    const calls = [], pinned = {}, measureOnly = extra.includes("--measure-only"), count = measureOnly ? 1 : extra.includes("--next-block") ? 4 : 2;
    assert.equal(await runner.connectForPass({ argv: extra, candidates: [], create: async options => {
      calls.push(options); if (calls.length < count) throw new guard.ExecutionError("OFFLINE_CAPABILITY_UNAVAILABLE"); return pinned;
    } }), pinned);
    assert.deepEqual(calls.map(({ requireStrictEvidence, requireNextBlock }) => [requireStrictEvidence, requireNextBlock]),
      measureOnly ? [[true, undefined]] : count === 4 ? [[true, true], [true, undefined], [undefined, true], [undefined, undefined]] : [[true, undefined], [undefined, undefined]]);
  }
  const f = fixture(), options = [];
  await runner.main(["--check", "--no-write", "--max-runs", "1"], { ...f.dependencies,
    createQualifiedPairFactory: forbidden, connect: async value => { options.push(value); return { pin: { number: 1 } }; } });
  assert.equal(options.length, 1); assert.equal(Object.hasOwn(options[0], "qualifiedPairFactory"), false); assert.equal(f.state.closes, 0);
});

test("main finally awaits close on a finite run and closes on fatal wait termination", async () => {
  const f = fixture(); let release, entered, done = false;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  f.factory.close = async () => { f.state.closes++; entered(); await gate; };
  const pending = runner.main(["--check", "--no-write", ...flags], f.dependencies).then(() => { done = true; });
  try { await started; await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false); }
  finally { release(); }
  await pending; assert.equal(f.state.closes, 1);
  const failed = fixture(), error = new guard.ExecutionError("OFFLINE_WAIT_STOPPED");
  await assert.rejects(failed.run([], { liveHeadNumber: undefined, sleep: async () => { throw error; } }), actual => actual === error);
  assert.equal(failed.state.closes, 1); assert.equal(failed.state.acquired.length, 1);
});
