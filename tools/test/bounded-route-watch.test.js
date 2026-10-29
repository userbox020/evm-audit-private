"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runBoundedRouteWatch } = require("../lib/bounded-route-watch");

const pinHash = "ab".repeat(32);
function batch(overrides = {}) {
  return { approved: true, chainIds: [1, 10], maxCycles: 1, maxRPCRequests: 10,
    cadenceMs: 60000, expiresAtMs: Date.now() + 200000, maxCycleMs: 1000, ...overrides };
}
function observation(overrides = {}) {
  return { chainId: 1, candidateId: "route-1", pinHash, observedAtMs: Date.now(),
    evidence: "FULL_SIZE_QUOTE", grossDeltaAtomic: "100", economicCostsComplete: true,
    conservativeNetAtomic: "10", fullInputConsumed: true, financingRepaymentProven: true,
    atomicSettlementProven: true, completeGasMeasured: true, independentStateConfirmed: true,
    routeProofComplete: true, ...overrides };
}
const result = (observations = [], providerHold = false) => ({ observations, providerHold });

test("invalid approval, schema, expiry and unsafe clock never call scanner", async () => {
  let calls = 0;
  const scanCycle = () => { calls++; return result(); };
  for (const invalid of [
    batch({ approved: false }), batch({ expiresAtMs: Date.now() - 1 }),
    batch({ chainIds: [1, 1] }), batch({ chainIds: [1, 0] }),
    batch({ maxCycles: 13 }), batch({ maxRPCRequests: 0 }),
    batch({ cadenceMs: 1 }), batch({ extra: "ignored?" }),
  ]) {
    const out = await runBoundedRouteWatch({ batch: invalid, scanCycle });
    assert.equal(out.status, "NOT_STARTED");
  }
  assert.equal((await runBoundedRouteWatch({ batch: batch(), scanCycle, now: () => NaN })).status, "NOT_STARTED");
  assert.equal(calls, 0);
});

test("input getters and proxies are rejected without invoking a getter", async () => {
  let getterCalls = 0;
  const b = batch();
  Object.defineProperty(b, "approved", { get() { getterCalls++; throw Error("secret URL"); } });
  const scanCycle = () => { throw Error("must not scan"); };
  for (const input of [b, new Proxy(batch(), {}), batch({ chainIds: new Proxy([1], {}) }),
    batch({ chainIds: Object.defineProperty([1], "0", { get() { getterCalls++; } }) })]) {
    assert.equal((await runBoundedRouteWatch({ batch: input, scanCycle })).status, "NOT_STARTED");
  }
  assert.equal(getterCalls, 0);
});

test("global RPC count is charged before dispatch and a cap stops subsequent cycles", async () => {
  let dispatched = 0;
  const out = await runBoundedRouteWatch({ batch: batch({ maxCycles: 2, maxRPCRequests: 2 }),
    scanCycle({ consumeRPC, remainingRPCRequests, chainIds }) {
      assert.equal(remainingRPCRequests, 2);
      assert.ok(Object.isFrozen(chainIds));
      for (let i = 0; i < 3; i++) { consumeRPC(); dispatched++; }
      return result();
    } });
  assert.equal(dispatched, 2);
  assert.equal(out.actualRPCRequests, 2);
  assert.equal(out.cyclesStarted, 1);
  assert.equal(out.reason, "STOP_RPC_CAP");
  assert.equal(out.active, false);
});

test("exact cap after successful cycle stops, not another scheduled cycle", async () => {
  const out = await runBoundedRouteWatch({ batch: batch({ maxRPCRequests: 1, maxCycles: 3 }),
    scanCycle({ consumeRPC }) { consumeRPC(); return result(); } });
  assert.equal(out.cyclesStarted, 1);
  assert.equal(out.cyclesCompleted, 1);
  assert.equal(out.reason, "STOP_RPC_CAP");
});

test("provider hold stops globally across chains without emitting observations", async () => {
  const out = await runBoundedRouteWatch({ batch: batch({ maxCycles: 2 }),
    scanCycle: () => result([observation()], true) });
  assert.equal(out.reason, "STOP_PROVIDER_HOLD");
  assert.equal(out.events.length, 0);
  assert.equal(out.cyclesStarted, 1);
});

test("scanner and callback errors are sanitized, without raw URL or stack", async () => {
  const url = "https://private-rpc.invalid/token";
  const failedScan = await runBoundedRouteWatch({ batch: batch(), scanCycle: () => { throw Error(url); } });
  const failedEvent = await runBoundedRouteWatch({ batch: batch(), scanCycle: () => result([observation()]),
    onEvent: () => { throw Error(url); } });
  assert.equal(failedScan.reason, "STOP_SCAN_ERROR");
  assert.equal(failedEvent.reason, "STOP_EVENT_ERROR");
  assert.ok(!JSON.stringify([failedScan, failedEvent]).includes(url));
});

test("ignored cycle timeout is bounded and cannot overlap a second cycle", async () => {
  let calls = 0;
  const started = Date.now();
  const out = await runBoundedRouteWatch({ batch: batch({ maxCycles: 2, maxCycleMs: 1000 }),
    scanCycle() { calls++; return new Promise(() => {}); } });
  assert.equal(out.reason, "STOP_TIMEOUT");
  assert.equal(out.unsettled, true);
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 3000);
});

test("event callback stall is bounded within the same cycle", async () => {
  const out = await runBoundedRouteWatch({ batch: batch({ maxCycles: 2 }),
    scanCycle: () => result([observation()]), onEvent: () => new Promise(() => {}) });
  assert.equal(out.reason, "STOP_TIMEOUT");
  assert.equal(out.unsettled, true);
  assert.equal(out.cyclesStarted, 1);
  assert.equal(out.cyclesCompleted, 0);
});

test("abort during cadence wait stops with no next cycle", async () => {
  const controller = new AbortController();
  let calls = 0;
  const out = await runBoundedRouteWatch({ batch: batch({ maxCycles: 2 }), signal: controller.signal,
    scanCycle() { calls++; return result(); },
    sleep: () => { controller.abort(); return new Promise(() => {}); } });
  assert.equal(out.reason, "STOP_ABORTED");
  assert.equal(out.unsettled, true);
  assert.equal(calls, 1);
});

test("scheduled cycle starts use absolute cadence offsets, never overlap", async () => {
  let current = 100000;
  const waits = [], starts = [];
  const out = await runBoundedRouteWatch({ batch: batch({ maxCycles: 3, expiresAtMs: 300000 }),
    now: () => current,
    sleep: async (ms) => { waits.push(ms); current += ms; },
    scanCycle({ cycleNumber }) { starts.push([cycleNumber, current]); return result(); } });
  assert.deepEqual(starts, [[1, 100000], [2, 160000], [3, 220000]]);
  assert.deepEqual(waits, [60000, 60000]);
  assert.equal(out.status, "COMPLETED");
  assert.equal(out.reason, "MAX_CYCLES");
  assert.equal(out.active, false);
});

test("frozen and backwards clock cannot cause repeated waits or cycles", async () => {
  const frozen = await runBoundedRouteWatch({ batch: batch({ maxCycles: 2 }),
    scanCycle: () => result(), sleep: async () => {} });
  assert.equal(frozen.reason, "STOP_UNSAFE_CLOCK");
  assert.equal(frozen.cyclesStarted, 1);
  let current = 100000;
  const backwards = await runBoundedRouteWatch({ batch: batch({ maxCycles: 2, expiresAtMs: 300000 }),
    now: () => current, scanCycle: () => result(), sleep: async () => { current--; } });
  assert.equal(backwards.reason, "STOP_UNSAFE_CLOCK");
});

test("deadline expiry before next scheduled start stops without launching it", async () => {
  let current = 100000;
  const out = await runBoundedRouteWatch({ batch: batch({ maxCycles: 2, expiresAtMs: 159999 }),
    now: () => current, scanCycle: () => result(), sleep: async (ms) => { current += ms; } });
  assert.equal(out.reason, "STOP_EXPIRED");
  assert.equal(out.cyclesStarted, 1);
});

test("all evidence gates apply to the local candidate only; no promotion or authorization", async () => {
  const rows = [observation(), observation({ candidateId: "missing-gas", completeGasMeasured: false }),
    observation({ candidateId: "prefilter", evidence: "PREFILTER" }),
    observation({ candidateId: "costs-unknown", economicCostsComplete: false, conservativeNetAtomic: null }),
    observation({ candidateId: "net-negative", conservativeNetAtomic: "-1" })];
  const delivered = [];
  const out = await runBoundedRouteWatch({ batch: batch(), scanCycle: () => result(rows),
    onEvent: (event) => { delivered.push(event); } });
  assert.deepEqual(out.events.map((event) => event.status), [
    "CONSERVATIVE_NET_POSITIVE_VALIDATED", "NET_POSITIVE_VALIDATION_REQUIRED", "PREFILTER_WATCH",
    "GROSS_POSITIVE_COSTS_UNKNOWN_WATCH", "NET_NONPOSITIVE_WATCH",
  ]);
  assert.deepEqual(delivered, out.events);
  for (const event of out.events) {
    assert.equal(event.routePositive, "unknown");
    assert.equal(event.automaticPromotion, false);
    assert.equal(event.signedActionsAuthorized, false);
    assert.equal(event.requiresParentReview, true);
  }
  assert.equal(out.automaticPromotion, false);
  assert.equal(out.signedActionsAuthorized, false);
});

test("all required validation gates independently prevent positive validation", async () => {
  const gates = ["economicCostsComplete", "fullInputConsumed", "financingRepaymentProven",
    "atomicSettlementProven", "completeGasMeasured", "independentStateConfirmed", "routeProofComplete"];
  const rows = gates.map((gate, i) => observation({ candidateId: `missing-${i}`, [gate]: false }));
  const out = await runBoundedRouteWatch({ batch: batch(), scanCycle: () => result(rows) });
  assert.equal(out.status, "COMPLETED");
  assert.ok(out.events.every((event) => event.status !== "CONSERVATIVE_NET_POSITIVE_VALIDATED"));
});

test("stale, foreign-chain, malformed decimal, missing key, unknown key and getters fail closed", async () => {
  const invalidRows = [
    observation({ observedAtMs: Date.now() - 6000 }), observation({ chainId: 137 }),
    observation({ grossDeltaAtomic: "1.01" }), observation({ conservativeNetAtomic: "101" }),
    observation({ conservativeNetAtomic: null }), observation({ candidateId: "UPPER" }),
    observation({ extra: "https://private.invalid" }),
  ];
  const missing = observation(); delete missing.pinHash; invalidRows.push(missing);
  let getterCalls = 0;
  const accessor = observation();
  Object.defineProperty(accessor, "pinHash", { get() { getterCalls++; throw Error("secret"); } });
  invalidRows.push(accessor, new Proxy(observation(), {}));
  for (const row of invalidRows) {
    const out = await runBoundedRouteWatch({ batch: batch(), scanCycle: () => result([row]) });
    assert.equal(out.reason, "STOP_INVALID_RESULT");
    assert.equal(out.events.length, 0);
  }
  assert.equal(getterCalls, 0);
});

test("unknown result keys and observation array accessors do not emit events", async () => {
  const a = [observation()];
  Object.defineProperty(a, "0", { get() { throw Error("do not read"); } });
  for (const raw of [result([], false), result(a)]) {
    if (raw.observations.length === 0) raw.unknown = 1;
    const out = await runBoundedRouteWatch({ batch: batch(), scanCycle: () => raw });
    assert.equal(out.reason, "STOP_INVALID_RESULT");
  }
});
