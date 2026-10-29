"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const { performance } = require("node:perf_hooks");
const { keccak256 } = require("../node_modules/ethers");
const m1 = require("../lib/m1-live-evidence.js"), guard = require("../lib/wallet-execution-guard.js");
const runner = require("../execute-top-whale-trigger.js");
const { fixture, readEvidence, NOW, PIN, W, hex, hash } = require("./m1-live-evidence.test.js");
const { MULTICALL3, MAX_AGE_MS } = require("../lib/executor-pinned-rpc.js");
const { asyncHarness, deferred } = require("./m1-async-harness-fixture.js");
const FULL = 108500n * W, HALF = FULL / 2n, QUARTER = FULL / 4n;
const turn = () => new Promise(resolve => setImmediate(resolve));
function setup(t, options = {}) {
  const async = asyncHarness(t), f = fixture(async.fixtureContext, options), future = options.future !== false;
  const candidate = runner.selectCandidates({ pin: { ...f.pinned.pin, chainId: 1 }, targets: { [m1.ID]: f.row } },
    future ? ["--next-block"] : [], { nextBlockContext: future ? f.context : undefined })[0];
  assert.ok(candidate);
  f.async = async;
  f.execute = overrides => (f.operation = async.run(() => m1.executeM1({ candidate, pinned: f.pinned, now: () => f.state.now,
    readFile: f.read, executionOptions: f.executionOptions, signTransaction: f.signTransaction,
    validateBase: (batches, now) => { runner.validateAuthorization(batches[0], now); return runner.validateMorphoAuthorization(batches[1], now); },
    ...overrides })));
  f.candidate = candidate;
  return f;
}
function label(tx, child, future) {
  const data = tx.data || tx.input;
  if (tx.to === MULTICALL3) return m1.MULTI_IFACE.decodeFunctionData("aggregate3", data)[0].length === 6 ? "feeds"
    : !child && future ? "parent" : "state";
  if (tx.to === m1.QUOTER) return "quote:" + m1.QUOTE_IFACE.decodeFunctionData("quoteExactInput", data)[1];
  return "exact:" + m1.EXEC_IFACE.decodeFunctionData("execute", data)[2];
}
// Every call represents a distinct sandbox: fixture checks accrue-before-state,
// parent/child timestamps, exact nonce, and canonical return-data/settlement ABI.
function track(f, { future = true, holds = [], errors = {}, edits = {}, rttMs = 0, distinctEstimates = false } = {}) {
  const gates = new Map(holds.map(name => [name, f.async.gate()])), starts = new Map(), ends = new Map(), estimates = new Map();
  const events = [], transactions = [];
  let active = 0, maximum = 0;
  const signal = (map, name) => { if (!map.has(name)) map.set(name, deferred()); return map.get(name); };
  const started = name => f.async.wait(signal(starts, name).promise, f.operation, "start:" + name);
  const ended = name => f.async.wait(signal(ends, name).promise, f.operation, "end:" + name);
  const run = (name, fn, tx) => f.async.observe((async () => {
    assert.equal(fs.readdirSync(f.lockRoot).length, 1);
    events.push("start:" + name); active++; maximum = Math.max(maximum, active);
    if (tx) transactions.push({ name, tx: structuredClone(tx) });
    signal(starts, name).resolve();
    try {
      if (rttMs) await new Promise(resolve => setTimeout(resolve, rttMs));
      await (gates.get(name)?.promise || turn());
      if (errors[name]) throw errors[name];
      const value = await fn();
      return edits[name] ? edits[name](value) : value;
    } finally { active--; events.push("end:" + name); signal(ends, name).resolve(); }
  })());
  const code = f.pinned.code, nonce = f.pinned.nonce, call = f.pinned.call, simulate = f.next.simulate, estimate = f.pinned.estimateGas;
  f.pinned.code = (...args) => run("runtime", () => code(...args));
  f.pinned.nonce = (...args) => run("nonce", () => nonce(...args));
  f.pinned.call = tx => run(label(tx, false, future), () => call(tx), tx);
  f.next.simulate = tx => run(label(tx, true, future), () => simulate(tx), tx);
  f.pinned.estimateGas = tx => {
    const size = label(tx, false, future).slice(6), count = (estimates.get(size) || 0) + 1; estimates.set(size, count);
    return run("estimate:" + size + (distinctEstimates ? count === 1 ? ":probe" : ":final" : ""), () => estimate(tx), tx);
  };
  return { events, transactions, started, ended, release: name => gates.get(name).resolve(), get active() { return active; }, get maximum() { return maximum; } };
}
function noExecution(f) { assert.equal(f.state.signs, 0); assert.equal(f.state.sends, 0); assert.equal(f.journalExists(), false); }
function assertTiming(events) {
  const phases = new Set(["preparation", "source", "runtime", "state", "feeds", "variants", "lockWait", "finalValidation", "sign", "send", "sendAck", "receipt"]);
  const active = new Map();
  for (const e of events) {
    assert.ok(Object.isFrozen(e)); assert.ok(phases.has(e.phase)); assert.ok(["start", "end", "point"].includes(e.edge));
    assert.deepEqual(Object.keys(e).sort(), ["phase", "edge", "atMonoMs", "atWallMs", ...(e.edge === "end" ? ["durationMs"] : [])].sort());
    for (const key of Object.keys(e).filter(k => !["phase", "edge"].includes(k))) assert.equal(Number.isFinite(e[key]), true);
    if (e.edge === "start") { assert.equal(active.has(e.phase), false); active.set(e.phase, e.atMonoMs); }
    if (e.edge === "end") { assert.equal(e.durationMs, e.atMonoMs - active.get(e.phase)); active.delete(e.phase); }
  }
  assert.equal(active.size, 0);
  assert.deepEqual(events.map(e => e.atMonoMs), events.map(e => e.atMonoMs).sort((a, b) => a - b));
  assert.doesNotMatch(JSON.stringify(events), /0x010203|signature|transaction|returnData|https:|PRIVATE/);
}

for (const future of [false, true]) {
  test(`${future ? "NEXT_BLOCK" : "CURRENT"}: default serial ordering and parallel width-two produce identical selected envelope, proof and economics`, async t => {
    const serial = setup(t, { future }), serialTrace = track(serial, { future });
    const baseline = await serial.execute();
    assert.equal(serialTrace.maximum, 1);
    assert.ok(serialTrace.events.indexOf("end:runtime") < serialTrace.events.indexOf("start:nonce"));
    assert.ok(serialTrace.events.indexOf("end:state") < serialTrace.events.indexOf("start:feeds"));
    assert.ok(serialTrace.events.indexOf("end:exact:" + FULL) < serialTrace.events.indexOf("start:quote:" + HALF));
    const f = setup(t, { future }), trace = track(f, { future }), events = [], legacy = [];
    const out = await f.execute({ preparationMode: "parallel-v1", onTiming: e => events.push(e),
      phase: name => { legacy.push("start:" + name); return () => legacy.push("end:" + name); } });
    assert.equal(out.stage, "RECEIPT_VERIFIED"); assert.equal(trace.maximum, 2); assert.equal(trace.active, 0);
    assert.ok(trace.events.indexOf("start:nonce") < trace.events.indexOf("end:runtime"));
    assert.ok(trace.events.indexOf("end:nonce") < trace.events.indexOf("start:state"));
    assert.ok(trace.events.indexOf("end:runtime") < trace.events.indexOf("start:state"));
    const firstFinal = trace.events.findIndex(e => /^start:(exact|estimate):/.test(e));
    for (const size of [FULL, HALF, QUARTER]) assert.ok(trace.events.indexOf("end:quote:" + size) < firstFinal);
    for (const name of ["state", "feeds", ...(future ? ["parent"] : [])])
      assert.ok(trace.events.indexOf("end:" + name) < trace.events.indexOf("start:quote:" + FULL));
    let finals = 0;
    for (const e of trace.events) if (/^(start|end):(exact|estimate):/.test(e)) { finals += e.startsWith("start:") ? 1 : -1; assert.ok(finals <= 1); }
    assert.deepEqual(f.state.tx, serial.state.tx);
    assert.deepEqual(out.intent.m1LiveProof, baseline.intent.m1LiveProof);
    assert.equal(out.intent.m1LiveProofSha256, baseline.intent.m1LiveProofSha256);
    assert.equal(f.state.nonces, 1);
    for (const { tx } of trace.transactions) assert.equal(BigInt(tx.nonce), 7n);
    for (const name of ["source", "runtime", "state", "feeds", "variants"]) {
      assert.equal(legacy.filter(e => e === "start:" + name).length, 1);
      assert.equal(legacy.filter(e => e === "end:" + name).length, 1);
    }
    assertTiming(events);
    const lockEnd = events.find(e => e.phase === "lockWait" && e.edge === "end");
    assert.ok(lockEnd.atMonoMs <= events.find(e => e.phase === "preparation").atMonoMs);
    assert.equal(events.filter(e => e.phase === "sendAck").length, 1);
  });

  test(`${future ? "NEXT_BLOCK" : "CURRENT"}: reverse quote completion preserves deterministic variants and best-net half size`, async t => {
    const options = { future, quote: input => input === FULL ? 104466n * W : 108000n * W * input / FULL };
    const serial = await setup(t, options).execute();
    const f = setup(t, options), trace = track(f, { future, holds: ["quote:" + FULL, "quote:" + HALF, "quote:" + QUARTER] });
    const pending = f.execute({ preparationMode: "parallel-v1" });
    await Promise.all([trace.started("quote:" + FULL), trace.started("quote:" + HALF)]);
    trace.release("quote:" + HALF); await trace.started("quote:" + QUARTER); trace.release("quote:" + QUARTER);
    await turn(); await turn(); assert.equal(f.state.executorCalls, 0); assert.equal(f.state.estimates, 0);
    trace.release("quote:" + FULL);
    const out = await pending;
    assert.equal(out.intent.m1LiveProof.selectedSeizedRaw, HALF.toString());
    assert.deepEqual(out.intent.m1LiveProof, serial.intent.m1LiveProof);
    assert.deepEqual(out.intent.m1LiveProof.evaluatedVariants.map(v => v.seizedRaw), [FULL, HALF, QUARTER].map(String));
    assert.equal(trace.maximum, 2);
  });
}

for (const future of [false, true]) {
  const mode = future ? "NEXT_BLOCK" : "CURRENT";
  test(`${mode} parallel-v2: nonzero RTT overlaps two exact evaluations with unchanged dependencies and complete serial proof`, async t => {
    const serial = setup(t, { future }), baseline = await serial.execute();
    const f = setup(t, { future }), trace = track(f, { future, rttMs: 2, distinctEstimates: true }), events = [];
    const out = await f.execute({ preparationMode: "parallel-v2", onTiming: e => events.push(e) });
    assert.equal(out.stage, "RECEIPT_VERIFIED"); assert.equal(trace.maximum, 2); assert.equal(trace.active, 0);
    assert.deepEqual(f.state.tx, serial.state.tx); assert.deepEqual(out.intent, baseline.intent);
    let active = 0, maximum = 0;
    for (const e of trace.events) if (/^(start|end):(exact|estimate):/.test(e)) {
      active += e.startsWith("start:") ? 1 : -1; maximum = Math.max(maximum, active); assert.ok(active <= 2);
    }
    assert.equal(maximum, 2); assert.equal(active, 0);
    const before = (a, b) => assert.ok(trace.events.indexOf(a) >= 0 && trace.events.indexOf(a) < trace.events.indexOf(b), `${a} before ${b}`);
    for (const name of ["state", "feeds", ...(future ? ["parent"] : [])]) {
      for (const prerequisite of ["runtime", "nonce"]) before("end:" + prerequisite, "start:" + name);
      for (const size of [FULL, HALF, QUARTER]) before("end:" + name, "start:quote:" + size);
    }
    const firstFinal = trace.events.find(e => /^start:(exact|estimate):/.test(e));
    for (const size of [FULL, HALF, QUARTER]) {
      before("end:quote:" + size, firstFinal);
      const rows = trace.transactions.filter(row => row.name.includes(size.toString()) && !row.name.startsWith("quote:"));
      if (future) {
        assert.deepEqual(rows.map(row => row.name), ["exact:" + size]);
        const exact = f.state.simulations.find(tx => tx.to === m1.EXECUTOR && m1.EXEC_IFACE.decodeFunctionData("execute", tx.data)[2] === size);
        assert.ok(Object.isFrozen(exact)); assert.ok(Object.isFrozen(exact.accessList));
      } else {
        assert.deepEqual(rows.map(row => row.name), [`estimate:${size}:probe`, `exact:${size}`, `estimate:${size}:final`]);
        before(`end:estimate:${size}:probe`, `start:exact:${size}`); before(`end:exact:${size}`, `start:estimate:${size}:final`);
        assert.deepEqual(rows[1].tx, rows[2].tx);
      }
    }
    assert.equal(f.state.nonces, 1); assert.equal(f.state.estimates, future ? 0 : 6);
    for (const { tx } of trace.transactions) assert.equal(BigInt(tx.nonce), 7n);
    assert.ok(f.state.tx.gasLimit <= 1500000n); assert.ok(f.state.tx.gasLimit * f.state.tx.maxFeePerGas <= 2000000000000000n);
    const proof = out.intent.m1LiveProof;
    assert.ok(Object.isFrozen(proof)); assert.ok(Object.isFrozen(proof.transaction));
    assert.equal(proof.economics.additionalReserveRaw, (2n * W).toString()); assert.equal(proof.economics.uncertaintyHaircutBps, 1000);
    assert.ok(BigInt(proof.quote.minOutputRaw) * 10000n >= BigInt(proof.quote.outputRaw) * 9950n);
    assertTiming(events);
  });

  test(`${mode} parallel-v2: reverse exact completion drains before publication and preserves ties, ranking and row order`, async t => {
    const reference = await setup(t, { future }).execute(), accrued = reference.intent.m1LiveProof.accruedState;
    const tieState = Object.fromEntries(["totalBorrowAssets", "totalBorrowShares", "borrowShares", "collateral", "price", "lif", "shareBound"].map(key => [key, BigInt(accrued[key])]));
    // Equal minOut surpluses tie all three nets without lowering the admitted 25 DAI floor.
    const tieQuote = input => (m1.repayment(tieState, input).assets + 25n * W / 4n) * 10000n / 9950n;
    for (const options of [{}, { tie: true, quote: tieQuote }, { quote: input => input === FULL ? 104470n * W : 108000n * W * input / FULL }]) {
      const baseline = options.quote ? await setup(t, { future, ...options }).execute() : reference;
      assert.ok(baseline.intent.m1LiveProof.evaluatedVariants.every(row => row.status === "VERIFIED"));
      const f = setup(t, { future, ...options }), trace = track(f, { future, rttMs: 2, distinctEstimates: true,
        holds: [FULL, HALF, QUARTER].map(size => "exact:" + size) });
      const events = []; let done = false;
      const pending = f.async.observe(f.execute({ preparationMode: "parallel-v2", onTiming: e => events.push(e) }).finally(() => { done = true; }));
      await Promise.all([trace.started("exact:" + FULL), trace.started("exact:" + HALF)]);
      assert.equal(trace.active, 2); assert.equal(trace.events.some(e => /^start:(exact|estimate):/.test(e) && e.includes(QUARTER.toString())), false);
      trace.release("exact:" + HALF); await trace.started("exact:" + QUARTER); trace.release("exact:" + QUARTER);
      await trace.ended(future ? "exact:" + QUARTER : `estimate:${QUARTER}:final`); await turn();
      assert.equal(done, false); assert.equal(trace.active, 1); assert.equal(fs.readdirSync(f.lockRoot).length, 1);
      assert.equal(events.length, 0); noExecution(f);
      trace.release("exact:" + FULL); const out = await pending;
      assert.equal(trace.active, 0); assert.equal(trace.maximum, 2); assert.deepEqual(out.intent, baseline.intent);
      const proof = out.intent.m1LiveProof;
      assert.deepEqual(proof.evaluatedVariants.map(row => row.seizedRaw), [FULL, HALF, QUARTER].map(String));
      assert.equal(proof.selectedSeizedRaw, (options.quote && !options.tie ? HALF : FULL).toString());
      if (options.tie) assert.equal(new Set(proof.evaluatedVariants.map(row => row.economics.netTokenRaw)).size, 1);
      assertTiming(events);
    }
  });

  test(`${mode} parallel-v2: fatal exact branches drain a positive sibling and never dequeue the third variant`, async t => {
    const cases = future ? [
      { name: "exact:" + FULL, code: "NEXT_BLOCK_REVERTED", error: true },
      { name: "exact:" + FULL, code: "NEXT_BLOCK_SIMULATION_PROOF_INVALID", edit: value => ({ ...value, context: { ...value.context, transaction: { ...value.context.transaction, nonce: "0x8" } } }) },
      { name: "exact:" + FULL, code: "M1_SETTLEMENT_INVALID", edit: value => ({ ...value, logs: value.logs.slice(1) }) },
    ] : [
      { name: `estimate:${FULL}:probe`, code: "UNKNOWN_ESTIMATE", error: true },
      { name: "exact:" + FULL, code: "CALL_REVERTED", error: true },
      { name: "exact:" + FULL, code: "EXECUTION_ABI_INVALID", edit: () => "0x00" },
      { name: `estimate:${FULL}:final`, code: "M1_FINAL_GAS_INVALID", edit: () => hex(1500001) },
    ];
    for (const failure of cases) {
      const f = setup(t, { future }), sibling = "exact:" + HALF;
      const trace = track(f, { future, rttMs: 2, distinctEstimates: true, holds: [failure.name, sibling],
        errors: failure.error ? { [failure.name]: new guard.ExecutionError(failure.code) } : {},
        edits: failure.edit ? { [failure.name]: failure.edit } : {} });
      let done = false;
      const pending = f.async.observe(f.execute({ preparationMode: "parallel-v2" }).finally(() => { done = true; }));
      const rejection = f.async.assertion(assert.rejects(pending, { code: failure.code }));
      await Promise.all([trace.started(failure.name), trace.started(sibling)]);
      trace.release(failure.name); await trace.ended(failure.name); await turn();
      assert.equal(done, false); assert.equal(trace.active, 1); assert.equal(fs.readdirSync(f.lockRoot).length, 1); noExecution(f);
      trace.release(sibling); await rejection;
      assert.ok(trace.events.includes("end:" + sibling));
      if (!future) assert.ok(trace.events.includes(`end:estimate:${HALF}:final`), "started sibling completes its dependent evaluation");
      assert.equal(trace.events.some(e => /^start:(exact|estimate):/.test(e) && e.includes(QUARTER.toString())), false);
      assert.equal(trace.active, 0); assert.equal(fs.readdirSync(f.lockRoot).length, 0); noExecution(f);
    }
  });

  test(`${mode} parallel-v2: an already-positive result cannot escape a late fatal sibling or its draining third job`, async t => {
    const f = setup(t, { future }), full = "exact:" + FULL, quarter = "exact:" + QUARTER;
    const code = future ? "NEXT_BLOCK_REVERTED" : "CALL_REVERTED";
    const trace = track(f, { future, rttMs: 2, distinctEstimates: true, holds: [full, quarter], errors: { [full]: new guard.ExecutionError(code) } });
    let done = false;
    const pending = f.async.observe(f.execute({ preparationMode: "parallel-v2" }).finally(() => { done = true; })), rejection = f.async.assertion(assert.rejects(pending, { code }));
    await trace.started(quarter);
    assert.ok(trace.events.includes(future ? "end:exact:" + HALF : `end:estimate:${HALF}:final`)); noExecution(f);
    trace.release(full); await trace.ended(full); await turn();
    assert.equal(done, false); assert.equal(trace.active, 1); noExecution(f);
    trace.release(quarter); await rejection; assert.equal(trace.active, 0); noExecution(f);
  });

  test(`${mode} parallel-v2: late candidate, pair, context, deadline and authorization changes cannot publish a winner`, async t => {
    for (const mutation of ["candidate", "pair", "context", "deadline", "authorization"]) {
      let revoked = false;
      const f = setup(t, { future, readFile: file => {
        const raw = readEvidence(file);
        return revoked && file.replace(/\\/g, "/").endsWith(m1.AMENDMENT_PATH) ? Buffer.concat([raw, Buffer.from(" ")]) : raw;
      } });
      const full = "exact:" + FULL, trace = track(f, { future, rttMs: 2, distinctEstimates: true, holds: [full] });
      const pending = f.execute({ preparationMode: "parallel-v2" });
      const code = mutation === "authorization" ? "M1_LIVE_APPROVAL_REQUIRED" : mutation === "deadline"
        ? future ? "NEXT_BLOCK_DEADLINE" : "M1_CONTEXT_STALE_OR_INVALID"
        : mutation === "context" && future ? "NEXT_BLOCK_CONTEXT_MISMATCH" : "M1_CONTEXT_OR_PAIR_CHANGED";
      const rejection = f.async.assertion(assert.rejects(pending, { code }));
      await trace.ended(future ? "exact:" + QUARTER : `estimate:${QUARTER}:final`); await turn(); noExecution(f);
      if (mutation === "candidate") f.candidate.data += "00";
      if (mutation === "pair") f.pinned.evidence.aliases.reverse();
      if (mutation === "context") {
        if (future) f.next.context = { ...f.context, parentHash: hash(42) }; else f.pinned.pin = { ...f.pinned.pin, hash: hash(42) };
      }
      if (mutation === "deadline") f.state.now = future ? f.context.timestamp * 1000 : f.pinned.pin.timestamp * 1000 + MAX_AGE_MS + 1;
      if (mutation === "authorization") revoked = true;
      trace.release(full); await rejection; assert.equal(trace.active, 0); noExecution(f);
    }
  });

  test(`${mode} parallel-v2: isolated quote reverts/zero/negative sizes keep serial proof rows; exact reverts remain fatal`, async t => {
    for (const kind of ["revert", "zero", "negative"]) {
      const options = { future, ...(kind === "revert" ? {} : { quote: input => input === FULL ? kind === "zero" ? 0n : 100000n * W : 108000n * W * input / FULL }) };
      const serial = setup(t, options), f = setup(t, options);
      const errors = kind === "revert" ? { ["quote:" + FULL]: new guard.ExecutionError(future ? "NEXT_BLOCK_REVERTED" : "CALL_REVERTED") } : {};
      track(serial, { future, errors }); const trace = track(f, { future, errors, rttMs: 2 });
      const baseline = await serial.execute(), out = await f.execute({ preparationMode: "parallel-v2" });
      assert.deepEqual(out.intent, baseline.intent); assert.equal(out.intent.m1LiveProof.selectedSeizedRaw, HALF.toString());
      assert.equal(out.intent.m1LiveProof.evaluatedVariants[0].status, { revert: "QUOTE_REVERTED", zero: "QUOTE_ZERO", negative: "NET_NONPOSITIVE" }[kind]);
      assert.equal(trace.events.includes("start:exact:" + FULL), false);
    }
  });

  test(`${mode} parallel-v2: changed context and nonce rebuild every state/feed/quote/exact proof, with no event-attempt reset`, async t => {
    const first = setup(t, { future }), options = { future, nonce: 8, now: NOW + 12000,
      pin: { number: PIN.number + 1, hash: hash(PIN.number + 1), timestamp: PIN.timestamp + 12 }, quote: 107900n * W };
    const second = setup(t, options), baseline = await setup(t, options).execute();
    const traces = [track(first, { future, rttMs: 2 }), track(second, { future, rttMs: 2 })];
    const a = await first.execute({ preparationMode: "parallel-v2" }), b = await second.execute({ preparationMode: "parallel-v2" });
    assert.deepEqual(b.intent, baseline.intent); assert.notEqual(a.intent.m1LiveProofSha256, b.intent.m1LiveProofSha256);
    assert.notDeepEqual(a.intent.m1LiveProof.accruedState, b.intent.m1LiveProof.accruedState);
    assert.notDeepEqual(a.intent.m1LiveProof.economics.prices, b.intent.m1LiveProof.economics.prices);
    assert.notDeepEqual(a.intent.m1LiveProof.quote, b.intent.m1LiveProof.quote);
    for (const [f, trace, nonce] of [[first, traces[0], 7n], [second, traces[1], 8n]]) {
      assert.equal(f.state.codes, 1); assert.equal(f.state.nonces, 1);
      for (const name of ["state", "feeds", ...(future ? ["parent"] : []), ...[FULL, HALF, QUARTER].flatMap(size => ["quote:" + size, "exact:" + size])])
        assert.equal(trace.events.filter(e => e === "start:" + name).length, 1);
      for (const { tx } of trace.transactions) assert.equal(BigInt(tx.nonce), nonce);
      const reads = f.state.reads.length;
      await assert.rejects(f.execute({ preparationMode: "parallel-v2" }), { code: "M1_TRIGGER_EVENT_ALREADY_ATTEMPTED" });
      assert.equal(f.state.reads.length, reads); assert.equal(f.state.signs, 1); assert.equal(f.state.sends, 1);
    }
  });
}

test("invalid preparation modes reject before lock, authorization, nonce or wallet work", async t => {
  for (const preparationMode of [null, false, "parallel", {}, 1]) {
    const f = setup(t);
    await assert.rejects(f.execute({ preparationMode }), { code: "M1_PREPARATION_MODE_INVALID" });
    assert.equal(fs.existsSync(f.lockRoot), false); assert.equal(f.state.reads.length, 0); assert.equal(f.state.nonces, 0); noExecution(f);
  }
});

test("parent and actual-state run independently; feeds can occupy the freed slot without ending the still-active state phase", async t => {
  const f = setup(t), trace = track(f, { holds: ["parent", "state", "feeds"] }), events = [], legacy = [];
  const pending = f.execute({ preparationMode: "parallel-v1", onTiming: e => events.push(e),
    phase: name => { legacy.push("start:" + name); return () => legacy.push("end:" + name); } });
  await Promise.all([trace.started("parent"), trace.started("state")]);
  assert.equal(trace.active, 2); assert.equal(trace.events.includes("start:feeds"), false);
  trace.release("state"); await trace.started("feeds");
  assert.equal(trace.active, 2); assert.equal(legacy.includes("end:state"), false);
  assert.equal(events.length, 0, "capture must not invoke observers during preparation");
  trace.release("feeds"); await turn();
  assert.equal(legacy.includes("end:feeds"), true); assert.equal(legacy.includes("end:state"), false);
  assert.equal(trace.events.includes("start:quote:" + FULL), false);
  trace.release("parent"); await pending;
  assert.equal(trace.maximum, 2); assertTiming(events);
  assert.ok(events.findIndex(e => e.phase === "feeds" && e.edge === "end") < events.findIndex(e => e.phase === "state" && e.edge === "end"));
});

test("a different nonce rebuilds all state/quote/final envelopes and the proof rather than patching a prior pass", async t => {
  for (const future of [false, true]) {
    const first = setup(t, { future, nonce: 7 }), second = setup(t, { future, nonce: 8 });
    const firstTrace = track(first, { future }), secondTrace = track(second, { future });
    const a = await first.execute({ preparationMode: "parallel-v1" }), b = await second.execute({ preparationMode: "parallel-v1" });
    assert.equal(a.intent.m1LiveProof.transaction.nonce, "0x7"); assert.equal(b.intent.m1LiveProof.transaction.nonce, "0x8");
    assert.notEqual(a.intent.m1LiveProofSha256, b.intent.m1LiveProofSha256);
    for (const [f, trace, nonce] of [[first, firstTrace, 7n], [second, secondTrace, 8n]]) {
      assert.equal(f.state.nonces, 1); assert.equal(f.state.codes, 1); assert.ok(f.state.reads.length > 0);
      assert.equal(trace.transactions.filter(row => row.name.startsWith("quote:")).length, 3);
      for (const { tx } of trace.transactions) assert.equal(BigInt(tx.nonce), nonce);
    }
    assert.deepEqual(a.intent.m1LiveProof.economics, b.intent.m1LiveProof.economics);
  }
});

test("runtime/nonce rejection drains its sibling under the wallet lock before exposing failure", async t => {
  for (const failed of ["runtime", "nonce"]) {
    const other = failed === "runtime" ? "nonce" : "runtime", f = setup(t);
    const trace = track(f, { holds: [failed, other], errors: { [failed]: new guard.ExecutionError("UNKNOWN_READ") } });
    let completed = false;
    const pending = f.async.observe(f.execute({ preparationMode: "parallel-v1" }).finally(() => { completed = true; }));
    const rejection = f.async.assertion(assert.rejects(pending, { code: "UNKNOWN_READ" }));
    await Promise.all([trace.started(failed), trace.started(other)]); trace.release(failed); await turn();
    assert.equal(completed, false); assert.equal(trace.active, 1); assert.equal(fs.readdirSync(f.lockRoot).length, 1);
    trace.release(other); await rejection;
    assert.equal(trace.active, 0); assert.equal(fs.readdirSync(f.lockRoot).length, 0); assert.equal(f.state.calls.length, 0); noExecution(f);
  }
});

test("runtime and nonce values are validated only after both parallel reads drain", async t => {
  for (const [options, edits, reason] of [[{ runtime: "0x" }, {}, "M1_RUNTIME_BINDING_REQUIRED"],
    [{}, { nonce: () => "0x20000000000000" }, "NONCE_INVALID"]]) {
    const f = setup(t, options), trace = track(f, { holds: ["nonce"], edits });
    const pending = f.execute({ preparationMode: "parallel-v1" }), rejection = f.async.assertion(assert.rejects(pending, { code: reason }));
    await trace.started("nonce"); await turn(); assert.equal(trace.active, 1); assert.equal(f.state.calls.length, 0);
    trace.release("nonce"); await rejection; noExecution(f);
  }
});

test("parent failure drains actual-state, cancels queued feeds, and leaves no accepted branch", async t => {
  const f = setup(t), trace = track(f, { holds: ["parent", "state"], errors: { parent: new guard.ExecutionError("UNKNOWN_STATE") } });
  let finished = false;
  const pending = f.async.observe(f.execute({ preparationMode: "parallel-v1" }).finally(() => { finished = true; }));
  const rejection = f.async.assertion(assert.rejects(pending, { code: "UNKNOWN_STATE" }));
  await Promise.all([trace.started("parent"), trace.started("state")]); trace.release("parent"); await turn();
  assert.equal(finished, false); assert.equal(trace.active, 1); assert.equal(trace.events.includes("start:feeds"), false);
  trace.release("state"); await rejection;
  assert.equal(trace.active, 0); assert.equal(trace.events.includes("start:feeds"), false); noExecution(f);
});

test("unknown feeds drain current state; stale/malformed feeds and unhealthy/inventory states never sign", async t => {
  const f = setup(t, { future: false }), trace = track(f, { future: false, holds: ["state", "feeds"], errors: { feeds: new guard.ExecutionError("UNKNOWN_FEEDS") } });
  let done = false;
  const pending = f.async.observe(f.execute({ preparationMode: "parallel-v1" }).finally(() => { done = true; }));
  const rejection = f.async.assertion(assert.rejects(pending, { code: "UNKNOWN_FEEDS" }));
  await Promise.all([trace.started("state"), trace.started("feeds")]); trace.release("feeds"); await turn();
  assert.equal(done, false); trace.release("state"); await rejection; noExecution(f);
  for (const options of [{ staleValuation: true }, { mutateFeeds: rows => { rows[0].returnData = "0x"; } },
    { childHealthy: true }, { parentUnhealthy: true }, { future: false, currentHealthy: true },
    ...[m1.USDE, m1.DAI, m1.USDC].map(dustToken => ({ dustToken })), { mutateState: rows => { rows[4].success = false; } }]) {
    const bad = setup(t, options);
    await assert.rejects(bad.execute({ preparationMode: "parallel-v1" })); noExecution(bad);
    assert.equal(bad.state.calls.filter(c => c.to === m1.QUOTER).length + bad.state.simulations.filter(c => c.to === m1.QUOTER).length, 0);
  }
});

test("fatal parallel quote errors drain successful siblings, never evaluate an accepted size, and cancel queued work", async t => {
  for (const future of [false, true]) for (const malformed of [false, true]) {
    const f = setup(t, { future }), full = "quote:" + FULL, half = "quote:" + HALF;
    const trace = track(f, { future, holds: [full, half],
      errors: malformed ? {} : { [half]: new guard.ExecutionError("UNKNOWN_QUOTE") },
      edits: malformed ? { [half]: value => future ? { ...value, returnData: "0x" } : "0x" } : {} });
    let done = false;
    const pending = f.async.observe(f.execute({ preparationMode: "parallel-v1" }).finally(() => { done = true; }));
    const rejection = f.async.assertion(assert.rejects(pending, { code: malformed ? "M1_QUOTE_INVALID" : "UNKNOWN_QUOTE" }));
    await Promise.all([trace.started(full), trace.started(half)]); trace.release(half); await turn();
    assert.equal(done, false); assert.equal(trace.events.includes("start:quote:" + QUARTER), false);
    trace.release(full); await rejection;
    assert.equal(trace.active, 0); assert.equal(f.state.executorCalls, 0); assert.equal(f.state.estimates, 0); noExecution(f);
  }
});

test("only the existing isolated quote revert skips a size; a poisoned revert and final execution revert abort", async t => {
  for (const future of [false, true]) {
    const code = future ? "NEXT_BLOCK_REVERTED" : "CALL_REVERTED", full = "quote:" + FULL;
    const f = setup(t, { future }); track(f, { future, errors: { [full]: new guard.ExecutionError(code) } });
    const out = await f.execute({ preparationMode: "parallel-v1" });
    assert.equal(out.intent.m1LiveProof.evaluatedVariants[0].status, "QUOTE_REVERTED");
    assert.equal(out.intent.m1LiveProof.selectedSeizedRaw, HALF.toString());
    const poisoned = setup(t, { future }); let poison = false;
    poisoned.pinned.assertUsable = () => { if (poison) throw new guard.ExecutionError("POISONED"); };
    track(poisoned, { future, edits: { [full]: () => { poison = true; throw new guard.ExecutionError(code); } } });
    await assert.rejects(poisoned.execute({ preparationMode: "parallel-v1" }), { code: "POISONED" }); noExecution(poisoned);
    const failed = setup(t, { future, revertSim: true });
    await assert.rejects(failed.execute({ preparationMode: "parallel-v1" }), { code });
    assert.equal(failed.state.executorCalls, 1); noExecution(failed);
  }
});

test("expired child or changed proof context prevents queued quotes and signing without nonce patching", async t => {
  for (const expire of [true, false]) {
    const f = setup(t), full = "quote:" + FULL, half = "quote:" + HALF;
    const trace = track(f, { holds: [full, half], edits: { [full]: value => {
      if (expire) f.state.now = f.context.timestamp * 1000; else f.pinned.evidence.aliases.reverse(); return value;
    } } });
    const pending = f.execute({ preparationMode: "parallel-v1" }), rejection = f.async.assertion(assert.rejects(pending));
    await Promise.all([trace.started(full), trace.started(half)]); trace.release(full); await turn(); trace.release(half); await rejection;
    assert.equal(trace.events.includes("start:quote:" + QUARTER), false); assert.equal(f.state.nonces, 1); noExecution(f);
  }
  const f = setup(t, { mutateProof: proof => { proof.context.transaction = { ...proof.context.transaction, nonce: "0x8" }; } });
  await assert.rejects(f.execute({ preparationMode: "parallel-v1" }), { code: "NEXT_BLOCK_SIMULATION_PROOF_INVALID" }); noExecution(f);
});

test("throwing, rejecting and never-settling timing observers cannot alter execution or leak execution bytes", async t => {
  for (const mode of ["throw", "reject", "pending"]) {
    const f = setup(t), events = [];
    const out = await f.execute({ preparationMode: "parallel-v1", onTiming: e => {
      events.push(e);
      if (mode === "throw") throw new Error("PRIVATE_OBSERVER");
      if (mode === "reject") return Promise.reject(new Error("PRIVATE_OBSERVER"));
      return new Promise(() => {});
    } });
    assert.equal(out.stage, "RECEIPT_VERIFIED"); assert.equal(f.state.signs, 1); assert.equal(f.state.sends, 1);
    assertTiming(events); await turn();
  }
});

test("send timing/ack follows the actual primary, not the delayed secondary; identical bytes and primary authority remain", async t => {
  for (const failPrimary of [false, true]) {
    const f = setup(t), primary = f.async.gate(), secondary = f.async.gate(), both = [deferred(), deferred()], events = [], raw = [];
    let primaryReturnedAt, secondaryDrained = false;
    const delivery = [];
    f.pinned.send = signed => f.async.observe((async () => { f.state.sends++; raw.push(signed); both[0].resolve(); await primary.promise;
      primaryReturnedAt = performance.now();
      if (failPrimary) throw new guard.ExecutionError("PRIMARY_FAILED"); return keccak256(signed); })());
    let finished = false;
    const pending = f.async.observe(f.execute({ preparationMode: "parallel-v1", onTiming: e => { events.push(e); delivery.push(secondaryDrained); }, secondarySendRawTransaction: signed => f.async.observe((async () => {
      raw.push(signed); both[1].resolve(); await secondary.promise; secondaryDrained = true; return keccak256(signed);
    })()) }).finally(() => { finished = true; }));
    const result = failPrimary ? f.async.assertion(assert.rejects(pending, { code: "BROADCAST_OUTCOME_UNCERTAIN" })) : pending;
    await f.async.wait(Promise.all(both.map(d => d.promise)), pending, "primary/secondary start"); assert.deepEqual(raw, ["0x010203", "0x010203"]);
    assert.equal(events.filter(e => e.phase === "sendAck").length, 0);
    primary.resolve(); await turn();
    const afterPrimary = performance.now();
    assert.equal(finished, false); assert.equal(events.length, 0, "even an accepted primary cannot flush before secondary drains");
    secondary.resolve(); await result; assertTiming(events);
    assert.ok(delivery.length > 0 && delivery.every(Boolean));
    const end = events.filter(e => e.phase === "send" && e.edge === "end");
    assert.equal(end.length, 1); assert.ok(end[0].atMonoMs >= primaryReturnedAt && end[0].atMonoMs <= afterPrimary);
    const ack = events.filter(e => e.phase === "sendAck");
    assert.equal(ack.length, failPrimary ? 0 : 1);
    if (!failPrimary) assert.ok(ack[0].atMonoMs >= primaryReturnedAt && ack[0].atMonoMs <= afterPrimary);
    assert.equal(f.state.signs, 1); assert.equal(f.state.sends, 1);
  }
});

for (const [phase, edge, occurrence] of [["sign", "start", 1], ["send", "start", 1],
  ["finalValidation", "end", 2], ["finalValidation", "end", 4]]) {
  test(`NEXT_BLOCK buffers ${phase}/${edge} #${occurrence}: clock-crossing observer cannot expire sign or either dispatch`, async t => {
    for (const expiry of ["child", "authorization"]) {
      const f = setup(t), initial = f.state.now, events = [], delivered = [], actions = [], raw = [];
      const authorization = m1.loadAuthorization({ readFile: f.read, now: initial, future: true });
      const expires = expiry === "child" ? f.context.timestamp * 1000 : Date.parse(authorization.amendment.expiresAt);
      let matches = 0, secondary = 0;
      const checkAction = name => {
        actions.push({ name, at: f.state.now });
        m1.strictContext(f.pinned, f.context, f.state.now);
        m1.loadAuthorization({ readFile: f.read, now: f.state.now, future: true });
      };
      const sign = f.signTransaction;
      // Deliberately synchronous primary response: its ack must not deliver an
      // observer before the concurrent identical-byte secondary is invoked.
      f.pinned.send = signed => { checkAction("primary"); raw.push(signed); f.state.sends++; return keccak256(signed); };
      const out = await f.execute({ preparationMode: "parallel-v1",
        signTransaction: tx => { checkAction("sign"); return sign(tx); },
        secondarySendRawTransaction: signed => { checkAction("secondary"); raw.push(signed); secondary++; return keccak256(signed); },
        onTiming: e => {
          events.push(e);
          delivered.push({ signs: f.state.signs, sends: f.state.sends, secondary,
            locks: fs.readdirSync(f.lockRoot).length, stage: guard.readJournals(f.journalDir)[0].record.stage });
          if (e.phase === phase && e.edge === edge && ++matches === occurrence) f.state.now = expires;
        },
      });
      assert.equal(out.stage, "RECEIPT_VERIFIED"); assert.equal(f.state.now, expires);
      assert.deepEqual(actions, ["sign", "primary", "secondary"].map(name => ({ name, at: initial })));
      assert.deepEqual(raw, ["0x010203", "0x010203"]);
      assert.ok(delivered.length > 0 && delivered.every(row => row.signs === 1 && row.sends === 1 && row.secondary === 1 && row.locks === 0 && row.stage === "RECEIPT_VERIFIED"));
      assert.ok(events.every(e => e.atWallMs === initial), "all capture timestamps precede observer-caused expiry");
      assertTiming(events);
    }
  });
}

test("timing does not convert a mismatched primary hash into an acceptance or relax authorization and final net gates", async t => {
  const f = setup(t), events = []; f.pinned.send = async () => { f.state.sends++; return hash(42); };
  await assert.rejects(f.execute({ preparationMode: "parallel-v1", onTiming: e => events.push(e) }), { code: "BROADCAST_OUTCOME_UNCERTAIN" });
  assert.equal(events.filter(e => e.phase === "sendAck").length, 0);
  for (const options of [{ ethUsd: 8175400000000n }, { failStage: "preSign", reason: "NEXT_BLOCK_DEADLINE" },
    { failStage: "preSend", reason: "NEXT_BLOCK_PARENT_CHANGED" }, { mutateLogs: logs => logs.splice(1, 1) }]) {
    const bad = setup(t, options);
    await assert.rejects(bad.execute({ preparationMode: "parallel-v1", onTiming: () => Promise.reject(new Error("PRIVATE")) }));
    assert.equal(bad.state.signs, options.failStage === "preSend" ? 1 : 0); assert.equal(bad.state.sends, 0);
  }
});
