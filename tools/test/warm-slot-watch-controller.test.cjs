"use strict";

// Offline clocks, handles and read callbacks only; no target, inventory or RPC.
const test = require("node:test"), assert = require("node:assert/strict");
const api = require("../lib/warm-slot-watch-controller.cjs");
const { keccak256 } = require("../node_modules/ethers");
const BASE = 1000000, W = 10n ** 18n, V = 1000000n, SCALE = 10n ** 36n;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const parent = () => ({ number: "100", hash: "0x" + "ab".repeat(32), timestamp: String(BASE / 1000) });
function fixture(options = {}) {
  const f = { wall: BASE + 100, mono: 100, generations: [], waits: [], events: [] };
  f.advance = ms => { f.wall += ms; f.mono += ms; };
  f.controller = api.createWarmSlotController({ maxRuns: 3, now: () => f.wall, monotonicNow: () => f.mono,
    pause: async ms => { f.waits.push(ms); if (f.onPause) await f.onPause(ms); else f.advance(ms); },
    qualify: async () => {
      const g = { id: f.generations.length + 1, closes: 0, drained: false };
      f.generations.push(g); f.events.push("qualify:" + g.id);
      g.handle = { id: g.id, async close() {
        g.closes++; f.events.push("close:" + g.id); await f.onClose?.(g);
        g.drained = true; f.events.push("drained:" + g.id);
      } };
      await f.onQualify?.(g); f.advance(300); return g.handle;
    }, ...options });
  return f;
}
function healthy(f, pin = parent()) { api.recordWarmCycleOutcome(f.controller, { healthy: true, parent: pin }); }

test("module import is inert and exports only reusable functions", () => {
  const fs = require("node:fs"), vm = require("node:vm"), module = { exports: {} };
  const denied = () => assert.fail("import must not perform IO or schedule work");
  vm.runInNewContext(fs.readFileSync(require.resolve("../lib/warm-slot-watch-controller.cjs"), "utf8"),
    { module, require: denied, setTimeout: denied, clearTimeout: denied });
  assert.ok(Object.isFrozen(module.exports));
  assert.deepEqual(Object.keys(module.exports).sort(), ["accrueMorphoPosition", "buildMorphoSizingVariants", "closeWarmController",
    "createInflightCoalescer", "createWarmSlotController", "finishWarmCycle", "recordWarmCycleOutcome", "runConcurrentCurrentChecks",
    "stopWarmController", "takeWarmQualification"].sort());
});
test("controller validates bounds and refuses unissued or unavailable generations", async () => {
  for (const options of [{}, { maxRuns: 0 }, { maxRuns: Infinity }, { maxRuns: 1.5 }, { slotSeconds: 0 }, { slotSeconds: 1.5 },
    { failureBackoffMs: -1 }, { failureBackoffMs: NaN }, { now: 42 }, { monotonicNow: 42 }, { pause: 42 }]) {
    assert.throws(() => api.createWarmSlotController({ qualify: options.maxRuns === undefined && !Object.keys(options).length ? undefined : async () => ({}), ...options }),
      { code: "WARM_OPTIONS_REJECTED" });
  }
  await assert.rejects(api.takeWarmQualification({}), { code: "WARM_UNISSUED" });
  const f = fixture(); assert.throws(() => healthy(f), { code: "WARM_GENERATION_CLOSED" });
  await api.closeWarmController(f.controller);
  await assert.rejects(api.takeWarmQualification(f.controller), { code: "WARM_CLOSED" });
});
test("first cycle is cold, returns the original handle and honors maxRuns without prequalification", async () => {
  const f = fixture({ maxRuns: 1 }); assert.equal(f.generations.length, 0);
  const taken = await api.takeWarmQualification(f.controller);
  assert.equal(taken.handle, f.generations[0].handle);
  assert.deepEqual(taken.watchMetrics, { cycle: 1, warmPrequalified: false, qualificationElapsedMs: 300,
    qualificationCriticalPathMs: 300, slotWaitElapsedMs: 0 });
  assert.ok(Object.isFrozen(taken.watchMetrics)); healthy(f);
  await api.finishWarmCycle(f.controller); await api.finishWarmCycle(f.controller);
  assert.equal(f.generations.length, 1); assert.equal(f.generations[0].closes, 1);
  await assert.rejects(api.takeWarmQualification(f.controller), { code: "WARM_MAX_RUNS" });
  await api.closeWarmController(f.controller);
});
test("healthy finish drains first, prequalifies once while idle and recalculates slot sleep after an early wake", async () => {
  const f = fixture({ maxRuns: 2 }); await api.takeWarmQualification(f.controller);
  const pin = parent(); healthy(f, pin); pin.timestamp = "999999"; // recorded parent is a snapshot
  f.advance(500); const held = deferred(); f.onClose = g => g.id === 1 ? held.promise : undefined;
  const finishing = api.finishWarmCycle(f.controller); const sameFinish = api.finishWarmCycle(f.controller);
  await flush(); assert.equal(f.generations.length, 1);
  await assert.rejects(api.takeWarmQualification(f.controller), { code: "WARM_BUSY" });
  held.resolve(); await Promise.all([finishing, sameFinish]); await flush();
  assert.equal(f.generations.length, 2); assert.ok(f.events.indexOf("drained:1") < f.events.indexOf("qualify:2"));
  const readyAt = f.wall; let early = true;
  f.onPause = ms => { f.advance(early ? ms - 100 : ms); early = false; };
  const next = await api.takeWarmQualification(f.controller);
  assert.equal(next.handle, f.generations[1].handle);
  assert.deepEqual(next.watchMetrics, { cycle: 2, warmPrequalified: true, qualificationElapsedMs: 300,
    qualificationCriticalPathMs: 0, slotWaitElapsedMs: BASE + 12000 - readyAt });
  assert.deepEqual(f.waits, [BASE + 12000 - readyAt, 100]); healthy(f);
  await api.finishWarmCycle(f.controller); await api.closeWarmController(f.controller);
  assert.equal(f.generations.length, 2); assert.ok(f.generations.every(g => g.closes === 1));
});
test("warm qualification measures only residual latency on the critical path", async () => {
  const f = fixture({ maxRuns: 2 }); await api.takeWarmQualification(f.controller); healthy(f);
  const held = deferred(); f.onQualify = g => g.id === 2 ? held.promise : undefined;
  await api.finishWarmCycle(f.controller); f.advance(400);
  const taking = api.takeWarmQualification(f.controller); await flush(); f.advance(700); held.resolve();
  const next = await taking;
  assert.equal(next.watchMetrics.qualificationElapsedMs, 1400);
  assert.equal(next.watchMetrics.qualificationCriticalPathMs, 1000);
  assert.equal(next.watchMetrics.warmPrequalified, true); assert.equal(f.generations.length, 2);
  await api.closeWarmController(f.controller);
});
test("slot length is configurable and an already elapsed slot causes no extra sleep", async () => {
  for (const late of [false, true]) {
    const f = fixture({ slotSeconds: 6, maxRuns: 2 }); await api.takeWarmQualification(f.controller); healthy(f);
    await api.finishWarmCycle(f.controller); await flush(); if (late) f.advance(10000);
    const started = f.wall, next = await api.takeWarmQualification(f.controller);
    assert.deepEqual(f.waits, late ? [] : [BASE + 6000 - started]);
    assert.equal(next.watchMetrics.slotWaitElapsedMs, late ? 0 : BASE + 6000 - started);
    await api.closeWarmController(f.controller);
  }
});
test("failed background qualification is observed, then the next cycle waits five seconds before cold qualification", async () => {
  const f = fixture(); await api.takeWarmQualification(f.controller); healthy(f);
  const error = Error("synthetic transient failure"); f.onQualify = g => { if (g.id === 2) throw error; };
  await api.finishWarmCycle(f.controller); await flush();
  await assert.rejects(api.takeWarmQualification(f.controller), e => e === error); await api.finishWarmCycle(f.controller);
  const before = f.wall;
  f.onQualify = () => assert.equal(f.wall, before + 5000);
  const next = await api.takeWarmQualification(f.controller);
  assert.deepEqual(f.waits, [5000]); assert.equal(next.watchMetrics.cycle, 3);
  assert.equal(next.watchMetrics.warmPrequalified, false); assert.equal(next.watchMetrics.slotWaitElapsedMs, 5000);
  await api.closeWarmController(f.controller);
});
test("failed cold qualification and nonhealthy or missing outcomes never launch an idle qualifier", async () => {
  for (const outcome of ["qualify-failure", "nonhealthy", "missing", "overridden"]) {
    const f = fixture();
    if (outcome === "qualify-failure") f.onQualify = () => { throw Error("transient"); };
    if (outcome === "qualify-failure") await assert.rejects(api.takeWarmQualification(f.controller), /transient/);
    else {
      await api.takeWarmQualification(f.controller);
      if (outcome === "overridden") healthy(f);
      if (outcome !== "missing") api.recordWarmCycleOutcome(f.controller, { healthy: false });
    }
    await api.finishWarmCycle(f.controller); assert.equal(f.generations.length, 1); f.onQualify = null;
    const next = await api.takeWarmQualification(f.controller);
    assert.equal(next.watchMetrics.warmPrequalified, false); assert.deepEqual(f.waits, [5000]);
    await api.closeWarmController(f.controller);
  }
});
test("custom cold backoff recalculates remaining time before launching", async () => {
  const f = fixture({ failureBackoffMs: 7000 }); await api.takeWarmQualification(f.controller); await api.finishWarmCycle(f.controller);
  f.onPause = ms => { assert.equal(f.generations.length, 1); f.advance(Math.min(ms, 4000)); };
  const next = await api.takeWarmQualification(f.controller);
  assert.deepEqual(f.waits, [7000, 3000]); assert.equal(next.watchMetrics.slotWaitElapsedMs, 7000);
  await api.closeWarmController(f.controller);
});
test("falsy thrown qualification failures cannot become successful checkouts", async () => {
  for (const error of [undefined, null, false, 0]) {
    const f = fixture(); f.onQualify = () => { throw error; };
    await assert.rejects(api.takeWarmQualification(f.controller), value => value === error);
    await api.finishWarmCycle(f.controller); f.onQualify = null;
    const next = await api.takeWarmQualification(f.controller);
    assert.equal(next.handle, f.generations[1].handle); assert.equal(next.watchMetrics.warmPrequalified, false);
    assert.deepEqual(f.waits, [5000]); await api.closeWarmController(f.controller);
  }
});
test("invalid healthy parent clears any previously recorded outcome and cannot warm the next cycle", async () => {
  for (const replacement of [{ number: "1.5" }, { number: -1 }, { hash: "0x12" }, { hash: "0x" + "00".repeat(32) },
    { timestamp: -1 }, { timestamp: String(Number.MAX_SAFE_INTEGER) }]) {
    const f = fixture(); await api.takeWarmQualification(f.controller); healthy(f);
    assert.throws(() => healthy(f, { ...parent(), ...replacement }), { code: "WARM_PARENT_HOLD" });
    await api.finishWarmCycle(f.controller); assert.equal(f.generations.length, 1);
    const next = await api.takeWarmQualification(f.controller); assert.equal(next.watchMetrics.warmPrequalified, false);
    await api.closeWarmController(f.controller);
  }
});
test("overlapping checkouts and outcomes before qualification completes are rejected", async () => {
  const held = deferred(), f = fixture(); f.onQualify = () => held.promise;
  const taking = api.takeWarmQualification(f.controller); await flush();
  await assert.rejects(api.takeWarmQualification(f.controller), { code: "WARM_BUSY" });
  assert.throws(() => healthy(f), { code: "WARM_GENERATION_CLOSED" }); held.resolve(); await taking;
  assert.throws(() => api.recordWarmCycleOutcome(f.controller, { healthy: "true", parent: parent() }), { code: "WARM_OUTCOME_INVALID" });
  await api.closeWarmController(f.controller);
});
for (const action of ["stopWarmController", "closeWarmController"]) {
  const stoppedCode = action === "stopWarmController" ? "WARM_STOPPED" : "WARM_CLOSED";
  test(`${action} drains the current handle once and awaits asynchronous close`, async () => {
    const f = fixture(); await api.takeWarmQualification(f.controller); healthy(f);
    const held = deferred(); f.onClose = () => held.promise; let done = false;
    const stopping = api[action](f.controller).then(() => { done = true; }); const again = api[action](f.controller);
    await flush(); assert.equal(done, false); assert.equal(f.generations[0].closes, 1);
    await assert.rejects(api.takeWarmQualification(f.controller), { code: stoppedCode });
    held.resolve(); await Promise.all([stopping, again]); assert.equal(done, true);
    await api.finishWarmCycle(f.controller); await api.closeWarmController(f.controller);
    assert.equal(f.generations.length, 1); assert.equal(f.generations[0].closes, 1);
  });
  test(`${action} drains a still-running idle qualification and its eventual handle`, async () => {
    const f = fixture(); await api.takeWarmQualification(f.controller); healthy(f);
    const qualified = deferred(), drained = deferred();
    f.onQualify = g => g.id === 2 ? qualified.promise : undefined; f.onClose = g => g.id === 2 ? drained.promise : undefined;
    await api.finishWarmCycle(f.controller); let done = false;
    const stopping = api[action](f.controller).then(() => { done = true; }); await flush(); assert.equal(done, false);
    qualified.resolve(); await flush(); assert.equal(done, false); assert.equal(f.generations[1].closes, 1);
    drained.resolve(); await stopping; await api[action](f.controller); await api.closeWarmController(f.controller);
    assert.equal(f.generations.length, 2); assert.ok(f.generations.every(g => g.closes === 1 && g.drained));
  });
  test(`${action} cancels both slot sleep and cold backoff without another qualification`, async () => {
    for (const warm of [true, false]) {
      const f = fixture(); await api.takeWarmQualification(f.controller); if (warm) healthy(f);
      await api.finishWarmCycle(f.controller); await flush();
      const held = deferred(); f.onPause = () => held.promise;
      const taking = api.takeWarmQualification(f.controller);
      const rejected = assert.rejects(taking, { code: stoppedCode }); await flush();
      await api[action](f.controller); await rejected; held.resolve(); await api.closeWarmController(f.controller);
      assert.equal(f.generations.length, warm ? 2 : 1); assert.ok(f.generations.every(g => g.closes === 1));
    }
  });
}
test("wall or monotonic regression during a slot wait latches stopped and drains the generation", async () => {
  for (const key of ["wall", "mono"]) {
    const f = fixture(); await api.takeWarmQualification(f.controller); healthy(f);
    await api.finishWarmCycle(f.controller); await flush();
    f.onPause = () => { f[key]--; };
    await assert.rejects(api.takeWarmQualification(f.controller), { code: "WARM_CLOCK_HOLD" });
    await assert.rejects(api.takeWarmQualification(f.controller), { code: "WARM_STOPPED" });
    await api.closeWarmController(f.controller); assert.ok(f.generations.every(g => g.closes === 1 && g.drained));
  }
});
test("clock exceptions and invalid readings latch stopped before qualification", async () => {
  for (const now of [() => NaN, () => -1, () => { throw Error("private clock text"); }]) {
    const f = fixture({ now });
    await assert.rejects(api.takeWarmQualification(f.controller), { code: "WARM_CLOCK_HOLD", message: "WARM_CLOCK_HOLD" });
    await assert.rejects(api.takeWarmQualification(f.controller), { code: "WARM_STOPPED" });
    await api.closeWarmController(f.controller); assert.equal(f.generations.length, 0);
  }
});
test("close failure stops warming and cannot close a handle twice", async () => {
  const f = fixture(); await api.takeWarmQualification(f.controller); healthy(f);
  const error = Error("close failure"); f.onClose = () => { throw error; };
  await assert.rejects(api.finishWarmCycle(f.controller), e => e === error);
  await assert.rejects(api.takeWarmQualification(f.controller), { code: "WARM_STOPPED" });
  await api.closeWarmController(f.controller); assert.equal(f.generations.length, 1); assert.equal(f.generations[0].closes, 1);
});
test("target-agnostic handles need no M32 methods or close function", async () => {
  const handle = Object.freeze({ market: "synthetic-aave" });
  const f = fixture({ qualify: () => handle, maxRuns: 1 });
  assert.equal((await api.takeWarmQualification(f.controller)).handle, handle);
  await api.finishWarmCycle(f.controller); await api.stopWarmController(f.controller); await api.closeWarmController(f.controller);
});

test("coalescer shares exact in-flight promises and evicts fulfilled and rejected reads", async () => {
  const coalesce = api.createInflightCoalescer(); let calls = 0;
  for (const outcome of ["success", "reject", "sync-throw"]) {
    const held = deferred(), error = Error(outcome);
    const first = coalesce("latest", () => { calls++; if (outcome === "sync-throw") throw error; return held.promise; });
    const same = coalesce("latest", () => assert.fail("must coalesce")); assert.equal(first, same);
    if (outcome === "success") { held.resolve(7n); assert.equal(await first, 7n); }
    else { const rejection = assert.rejects(first, e => e === error); if (outcome === "reject") held.reject(error); await rejection; }
    const fresh = coalesce("latest", () => { calls++; return 8n; }); assert.notEqual(fresh, first); assert.equal(await fresh, 8n);
  }
  assert.equal(calls, 6);
});
const CODE = "0x6001600055", OWNER = "0x" + "ab".repeat(20);
function checks(overrides = {}) {
  return { assertFresh: () => true, balance: () => 100n, code: () => CODE, owner: () => OWNER, nonce: () => 7n,
    minBalanceWei: 100n, expectedRuntimeKeccak256: keccak256(CODE), expectedOwner: OWNER, expectedNonce: 7n, ...overrides };
}
test("current checks launch all five in the calling tick and await every result", async () => {
  const names = ["assertFresh", "balance", "code", "owner", "nonce"], started = [], gates = names.map(deferred);
  let done = false;
  const work = api.runConcurrentCurrentChecks(checks(Object.fromEntries(names.map((name, i) => [name, () => { started.push(name); return gates[i].promise; }]))))
    .then(result => { done = true; return result; });
  assert.deepEqual(started, names);
  for (const i of [4, 3, 2, 1]) gates[i].resolve([true, 100n, CODE, OWNER, 7n][i]);
  await flush(); assert.equal(done, false); gates[0].resolve(true);
  assert.deepEqual(await work, { ok: true, balanceWei: 100n, nonce: 7n });
});
test("overlapping latest/pending reads coalesce four calls into two; sequential current barriers read again", async () => {
  const coalesce = api.createInflightCoalescer(), physical = []; let gates;
  const read = key => coalesce(key, () => { physical.push(key); return gates[key].promise; });
  const pair = () => Promise.all([read("latest"), read("pending")]);
  for (let cycle = 0; cycle < 2; cycle++) {
    gates = { latest: deferred(), pending: deferred() };
    const work = api.runConcurrentCurrentChecks(checks({ assertFresh: async () => { const values = await pair(); return values[0] === values[1]; },
      nonce: async () => { const [value] = await pair(); return value; } }));
    await flush(); assert.deepEqual(physical, Array.from({ length: cycle + 1 }, () => ["latest", "pending"]).flat());
    gates.pending.resolve(7n); gates.latest.resolve(7n); assert.equal((await work).nonce, 7n);
  }
  assert.equal(physical.length, 4);
});
const CURRENT_NAMES = ["assertFresh", "balance", "code", "owner", "nonce"];
const HOLD_CODES = ["FRESHNESS_HOLD", "BALANCE_HOLD", "RUNTIME_HOLD", "OWNER_HOLD", "NONCE_HOLD"];
for (let first = 0; first < 5; first++) test(`current deterministic precedence starts at ${HOLD_CODES[first]} for invalid, synchronous and asynchronous failures`, async () => {
  for (const mode of ["invalid", "throw", "reject"]) {
    const started = [], input = checks(), bad = [false, 99n, "0x6002", "0x" + "cd".repeat(20), 8n];
    for (let i = 0; i < 5; i++) {
      const valid = input[CURRENT_NAMES[i]];
      input[CURRENT_NAMES[i]] = () => {
        started.push(i); if (i < first) return valid();
        if (mode === "invalid") return bad[i];
        const error = Object.assign(Error("private upstream details"), { code: "SPOOFED_HOLD" });
        if (mode === "throw") throw error; return Promise.reject(error);
      };
    }
    await assert.rejects(api.runConcurrentCurrentChecks(input), { code: HOLD_CODES[first], message: HOLD_CODES[first] });
    assert.deepEqual(started, [0, 1, 2, 3, 4]);
  }
});
test("current checks accept assertion-style void and RPC hex quantities, but reject malformed values", async () => {
  assert.deepEqual(await api.runConcurrentCurrentChecks(checks({ assertFresh() {}, balance: () => "0x64", nonce: () => "0x07",
    expectedNonce: "7", expectedOwner: "0x" + "AB".repeat(20) })), { ok: true, balanceWei: 100n, nonce: 7n });
  for (const [key, value, code] of [["assertFresh", null, "FRESHNESS_HOLD"], ["balance", -1n, "BALANCE_HOLD"],
    ["balance", "", "BALANCE_HOLD"], ["code", "0x", "RUNTIME_HOLD"], ["code", "0x123", "RUNTIME_HOLD"],
    ["owner", null, "OWNER_HOLD"], ["nonce", 1.5, "NONCE_HOLD"], ["nonce", "-1", "NONCE_HOLD"]]) {
    await assert.rejects(api.runConcurrentCurrentChecks(checks({ [key]: () => value })), { code });
  }
});

function morpho(overrides = {}) {
  return { market: { totalBorrowAssets: 500000n * W, totalBorrowShares: 500000n * W * V, lastUpdate: 1000n },
    position: { borrowShares: 1000n * W * V + 17n, collateral: 1050n * W }, price: SCALE, rate: 0n, timestamp: 1000n,
    lltv: 915000000000000000n, ...overrides };
}
const up = (n, d) => (n + d - 1n) / d;
for (const [lltv, denominator] of [[915000000000000000n, 974500000000000000n], [860000000000000000n, 958000000000000000n],
  [945000000000000000n, 983500000000000000n]]) {
  test(`LLTV ${lltv} has exact LIF and eight ordered variants using down-seizure versus up-repayment`, () => {
    const state = api.accrueMorphoPosition(morpho({ lltv })); assert.equal(state.lif, SCALE / denominator);
    assert.equal(state.maxBorrow, 1050n * W * lltv / W); assert.equal(state.healthy, false);
    const variants = api.buildMorphoSizingVariants({ state, minRetainedFloorRaw: 5n });
    assert.equal(variants.length, 8); assert.ok(Object.isFrozen(state) && Object.isFrozen(variants));
    assert.deepEqual(variants.map(row => row.mode), ["repaidShares", ...Array(7).fill("seizedAssets")]);
    assert.deepEqual(variants.map(row => row.bps), [10000n, 10000n, 9500n, 9000n, 8000n, 7000n, 5000n, 2500n]);
    const down = state.borrowShares * (state.accruedBorrowAssets + 1n) / (state.totalBorrowShares + V);
    const repayment = up(state.borrowShares * (state.accruedBorrowAssets + 1n), state.totalBorrowShares + V);
    assert.equal(down, 1000n * W); assert.equal(repayment, down + 1n);
    const seized = (down * state.lif / W) * state.priceScale / state.price;
    const wrongUpSeizure = (repayment * state.lif / W) * state.priceScale / state.price;
    assert.equal(variants[0].seizedAssets, 0n); assert.equal(variants[0].repaidShares, state.borrowShares);
    assert.equal(variants[0].expectedRepaidAssets, repayment); assert.equal(variants[0].expectedSeizedAssets, seized);
    assert.ok(seized < wrongUpSeizure);
    for (const row of variants.slice(1)) {
      assert.equal(row.repaidShares, 0n); assert.equal(row.seizedAssets, seized * row.bps / 10000n);
      const quoted = up(row.seizedAssets * state.price, state.priceScale), initial = up(quoted * W, state.lif);
      const shares = up(initial * (state.totalBorrowShares + V), state.accruedBorrowAssets + 1n);
      assert.equal(row.expectedRepaidShares, shares); assert.ok(shares <= state.borrowShares);
      assert.equal(row.expectedRepaidAssets, up(shares * (state.accruedBorrowAssets + 1n), state.totalBorrowShares + V));
    }
    assert.ok(variants.every(row => Object.isFrozen(row) && row.minRetainedFloorRaw === 5n && row.expectedSeizedAssets <= state.collateral));
  });
}
test("Morpho interest uses the three-term rounded Taylor expansion and parameterized price scale", () => {
  const input = morpho({ rate: 1000000000000n, timestamp: 11000n, priceScale: 10n ** 24n, price: 1250000000000000000000000n });
  const state = api.accrueMorphoPosition(input), first = input.rate * 10000n;
  const second = first * first / (2n * W), third = second * first / (3n * W);
  assert.equal(state.compounded, first + second + third);
  assert.equal(state.interest, input.market.totalBorrowAssets * (first + second + third) / W);
  assert.equal(state.accruedBorrowAssets, input.market.totalBorrowAssets + state.interest);
  assert.equal(state.debt, up(input.position.borrowShares * (state.accruedBorrowAssets + 1n), input.market.totalBorrowShares + V));
  assert.equal(state.maxBorrow, (input.position.collateral * input.price / input.priceScale) * input.lltv / W);
  const variants = api.buildMorphoSizingVariants({ state }); assert.equal(variants.length, 8);
  const down = state.borrowShares * (state.accruedBorrowAssets + 1n) / (state.totalBorrowShares + V);
  assert.equal(variants[0].expectedSeizedAssets, (down * state.lif / W) * input.priceScale / input.price);
});
test("LIF cap and zero-debt healthy arithmetic are independent of target identity", () => {
  assert.equal(api.accrueMorphoPosition(morpho({ lltv: 0n })).lif, 1150000000000000000n);
  assert.equal(api.accrueMorphoPosition(morpho({ lltv: W })).lif, W);
  const state = api.accrueMorphoPosition(morpho({ position: { borrowShares: 0n, collateral: 0n } }));
  assert.equal(state.debt, 0n); assert.equal(state.healthy, true);
  assert.deepEqual(api.buildMorphoSizingVariants({ state }), []);
});
test("seizure limits omit full repayment and bound all seven ladder variants", () => {
  const original = api.accrueMorphoPosition(morpho());
  for (const [state, maxSeizeRaw] of [[original, 500n * W], [{ ...original, collateral: 500n * W }, original.collateral]]) {
    const variants = api.buildMorphoSizingVariants({ state, maxSeizeRaw }); assert.equal(variants.length, 7);
    assert.ok(variants.every(row => row.mode === "seizedAssets" && row.expectedSeizedAssets <= 500n * W));
    assert.equal(variants[0].seizedAssets, 500n * W);
  }
  assert.deepEqual(api.buildMorphoSizingVariants({ state: original, maxSeizeRaw: 0n }), []);
});
test("custom ladders sort descending, deduplicate rounded amounts and never mutate the caller", () => {
  const state = api.accrueMorphoPosition(morpho({ market: { totalBorrowAssets: 20n, totalBorrowShares: V, lastUpdate: 1000n },
    position: { borrowShares: V, collateral: 30n } }));
  const ladder = [2500n, 9000n, 9500n, 10000n, 8000n, 7000n, 5000n], before = [...ladder];
  const variants = api.buildMorphoSizingVariants({ state, bpsLadder: ladder });
  assert.deepEqual(ladder, before); assert.equal(variants.length, 7);
  assert.deepEqual(variants.slice(1).map(row => row.bps), [10000n, 9500n, 8000n, 7000n, 5000n, 2500n]);
  assert.deepEqual(variants.slice(1).map(row => row.seizedAssets), [10n, 9n, 8n, 7n, 5n, 2n]);
  assert.equal(variants[0].expectedRepaidAssets, 11n); assert.equal(variants[0].expectedSeizedAssets, 10n);
});
test("Morpho arithmetic rejects invalid state, LLTV, scale, overflow and ladders", () => {
  for (const input of [morpho({ lltv: W + 1n }), morpho({ lltv: -1n }), morpho({ price: 0n }), morpho({ priceScale: 0n }),
    morpho({ rate: -1n }), morpho({ timestamp: 999n }), morpho({ rate: (1n << 256n) - 1n, timestamp: 1002n }),
    morpho({ position: { borrowShares: 500001n * W * V, collateral: W } })]) assert.throws(() => api.accrueMorphoPosition(input));
  const state = api.accrueMorphoPosition(morpho());
  for (const bpsLadder of [[0n], [10001n], [-1n], [1.5], Array(8).fill(10000n)])
    assert.throws(() => api.buildMorphoSizingVariants({ state, bpsLadder }));
  assert.throws(() => api.buildMorphoSizingVariants({ state: { ...state, lif: W } }), { code: "MORPHO_INVALID_STATE" });
});
