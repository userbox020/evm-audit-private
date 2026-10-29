"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const transport = require("../lib/executor-pinned-rpc.js"), runner = require("../execute-top-whale-trigger.js");
const guard = require("../lib/wallet-execution-guard.js"), m1 = require("../lib/m1-live-evidence.js");
const live = require("./m1-live-evidence.test.js");
const { keccak256 } = require("../node_modules/ethers");
const NOW = Date.parse("2026-10-24T02:00:01Z"), HEAD = 1000, TIME = NOW / 1000 - 1;
const hex = n => "0x" + BigInt(n).toString(16), hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const UNKNOWN = "0x" + "f".repeat(64), FLAGS = ["--m1-only", "--m1-hot-path-v2"];
const TX = { type: 2, chainId: 1, from: guard.MAIN_ACCOUNT, to: "0x" + "11".repeat(20), data: "0x1234", value: 0, nonce: 7,
  gasLimit: 180000, maxFeePerGas: 200000000, maxPriorityFeePerGas: 1, accessList: [] };
const forbidden = () => assert.fail("OFFLINE_FORBIDDEN_IO");
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function header(number = HEAD) { return { number: hex(number), hash: hash(number), parentHash: hash(number - 1), stateRoot: hash(7),
  timestamp: hex(TIME + (number - HEAD) * 12), baseFeePerGas: hex(100000000), gasLimit: hex(30000000) }; }
function simulation(params) {
  const block = params[0].blockStateCalls[0], tx = block.calls[0];
  return [{ parentHash: params[1].blockHash, number: block.blockOverrides.number, timestamp: block.blockOverrides.time,
    transactions: [structuredClone(tx)], calls: [{ status: "0x1", gasUsed: hex(80000), logs: [],
      returnData: tx.to === null ? hash(BigInt(block.blockOverrides.number)) + hash(BigInt(block.blockOverrides.time)).slice(2) : "0x1234" }] }];
}
function fixture(t, options = {}) {
  const candidates = Array.from({ length: options.count || 4 }, (_, i) => ({ family: `PRIVATE_FAMILY_${i}`, handle: `PRIVATE_HANDLE_${i}` }));
  const state = { now: NOW, mono: 0, head: HEAD, calls: [], active: 0, peak: 0, hook: () => undefined, events: [] };
  const rpc = async (candidate, method, params, timeout, assertDispatch) => {
    assert.ok(Object.isFrozen(candidate)); assert.ok(timeout > 0 && timeout <= 4000);
    const alias = Number(candidate.handle.split("_").at(-1)), call = { alias, method, params, timeout };
    state.calls.push(call); state.active++; state.peak = Math.max(state.peak, state.active);
    try {
      if (options.httpSends && method === "eth_sendRawTransaction") return transport.httpRpc(candidate, method, params, timeout, assertDispatch);
      const changed = await state.hook(call); if (changed !== undefined) return changed;
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_getBlockByNumber") return header(params[0] === "latest" ? state.head : Number(BigInt(params[0])));
      if (["eth_call", "eth_getCode", "eth_simulateV1"].includes(method) && params[1].blockHash === UNKNOWN) throw new guard.ExecutionError("UNKNOWN_BLOCK_REJECTED");
      if (method === "eth_call") return params[0].to === transport.MULTICALL3 ? hash(BigInt(params[1].blockHash)) : "0x1234";
      if (method === "eth_getCode") return "0x600160ab";
      if (method === "eth_getTransactionCount") return "0x7";
      if (method === "eth_getBalance") return hex(2000000000000000n);
      if (method === "eth_simulateV1") return simulation(params);
      if (method === "eth_sendRawTransaction") return keccak256(params[0]);
      assert.fail("UNPLANNED_METHOD");
    } finally { state.active--; }
  };
  const factory = transport.createM1HotPathFactory({ rpc, now: () => state.now, monotonic: () => state.mono,
    allowFuture: options.allowFuture || false, rank1AcquisitionRecovery: options.rank1AcquisitionRecovery ?? false, selectionPolicy: options.selectionPolicy,
    onTiming: options.onTiming || (event => state.events.push(event)) });
  t.after(() => factory.close());
  const maintain = () => factory.maintain({ candidates }), acquire = () => factory.acquire({ candidates });
  const detect = () => runner.createM1V2Budget({ wallNow: () => state.now, monotonicNow: () => state.mono });
  const ready = async () => { maintain(); await turn(); assert.equal(maintain().selection, "READY"); };
  const advance = ms => { state.now += ms; state.mono += ms; state.head = HEAD + Math.floor(state.mono / 12000); };
  return { candidates, state, rpc, factory, maintain, acquire, ready, advance, detect };
}
test("v2 CURRENT recheck validates each chain before width-two canonical/latest reads and immediately poisons contradictions", async t => {
  const f = fixture(t); await f.ready(); const lease = await f.acquire(), gate = deferred();
  f.state.calls.length = 0; let completed = false;
  f.state.hook = async call => {
    if (call.method !== "eth_getBlockByNumber") return;
    if (call.alias === 0 && call.params[0] !== "latest") return { ...header(), hash: hash(7777) };
    await gate.promise;
  };
  const pending = assert.rejects(lease.current.recheck()).then(() => { completed = true; }); await turn();
  assert.throws(lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/); assert.equal(completed, false);
  for (const alias of [0, 1]) {
    const calls = f.state.calls.filter(c => c.alias === alias);
    assert.equal(calls[0].method, "eth_chainId"); assert.equal(calls.length, 3);
    assert.deepEqual(calls.slice(1).map(c => c.params[0]), [hex(HEAD), "latest"]);
  }
  gate.resolve(); await pending; assert.equal(f.state.active, 0);
});

const originalFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = forbidden; });
test.after(() => { globalThis.fetch = originalFetch; });

function mockHttpFetch(t) {
  const calls = [];
  t.mock.method(globalThis, "fetch", (handle, options) => {
    const body = JSON.parse(options.body); calls.push({ handle, body });
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1,
      result: body.method === "eth_sendRawTransaction" ? keccak256(body.params[0]) : "0x1" }), { status: 200 }));
  });
  return calls;
}
function detectedLiveFixture(t, options = {}) {
  let f;
  const start = options.now ?? live.NOW, wallNow = () => f?.state.now ?? start;
  const m1Budget = runner.createM1V2Budget({ wallNow, monotonicNow: () => wallNow() - start });
  f = live.fixture(t, options); return { ...f, m1Budget };
}
async function runWithDefaultSecondary(f, acquire, argv = FLAGS) {
  const outputs = []; let acquired;
  await runner.main([...argv, "--check", "--no-write"], {
    wallNow: () => f.state.now, monotonicNow: () => f.state.mono,
    loadCandidates: () => f.candidates, loadBatch: () => ({}), connect: options => runner.connectForPass(options),
    createM1HotPathFactory: () => ({ maintain() {}, acquire: async () => { acquired = await acquire(); return acquired.hotPathLease; }, close() {} }),
    runPass: ({ secondarySendRawTransaction, m1Budget, now }) => {
      acquired.m1Budget = m1Budget;
      return acquired.liveCase.run({ argv, pinned: acquired.hotPathLease.current, hotPathLease: acquired.hotPathLease, m1Budget, now, secondarySendRawTransaction });
    },
    output: value => outputs.push(value),
  });
  return { ...acquired, outputs };
}

test("real httpRpc fetch boundary retains CURRENT background poison after both outer relay guards passed", async t => {
  const fetches = mockHttpFetch(t), f = fixture(t, { httpSends: true }); await f.ready(); f.advance(30000);
  let lease, acquired;
  let dispatched, queued = false; const secondaryChecks = [];
  t.mock.method(m1, "executeM1", async options => {
    options.pinned.assertUsable(); // Final validation succeeds before background failure.
    acquired.m1Budget.acceptUnsigned(acquired.hotPathLease, options.pinned);
    f.state.hook = call => {
      if (call.alias !== 0 || call.method !== "eth_getBlockByNumber" || call.params[0] !== hex(f.state.head)) return;
      return { ...header(f.state.head), get stateRoot() {
        if (!queued) {
          queued = true;
          dispatched = Promise.allSettled([options.pinned.send("0x010203"),
            Promise.resolve().then(() => options.secondarySendRawTransaction("0x010203"))]);
        }
        // The async strict qualifier rejects after queuing the outer sends.
        // Its caller poisons trust before httpRpc's inner fetch microtasks.
        return hash(9999);
      } };
    };
    f.maintain(); await turn();
    const [primary, secondary] = await dispatched;
    assert.equal(primary.status, "rejected"); assert.equal(primary.reason.code, "PINNED_RPC_FAILED");
    assert.equal(secondary.status, "rejected"); assert.equal(secondary.reason.code, "PIN_EVIDENCE_INVALIDATED");
    return { stage: "UNCERTAIN" };
  });
  await runWithDefaultSecondary(f, async () => {
    lease = await f.acquire();
    const liveCase = live.fixture(t, { future: false, pin: lease.current.pin, now: f.state.now });
    const pinned = { ...liveCase.pinned, send: lease.current.send, assertUsable() {
      try { lease.current.assertUsable(); if (queued) secondaryChecks.push("VALID"); }
      catch (error) { if (queued) secondaryChecks.push("INVALID"); throw error; }
    } };
    return acquired = { liveCase, hotPathLease: { current: pinned, takeFuture: forbidden, cancelFuture() {} } };
  });
  assert.equal(queued, true); assert.deepEqual(secondaryChecks, ["VALID", "INVALID"]);
  assert.equal(f.state.calls.filter(call => call.method === "eth_sendRawTransaction").length, 1, "primary reached real httpRpc");
  assert.equal(fetches.length, 0, "neither primary nor default secondary reached fetch");
  f.state.hook = () => undefined; assert.throws(lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
});

for (const invalidation of ["expiry", "cancel"]) test(`real httpRpc blocks FUTURE ${invalidation} between outer relay invocation and inner fetch`, async t => {
  const fetches = mockHttpFetch(t), f = fixture(t, { allowFuture: true, httpSends: true });
  await f.ready(); let lease, future, acquired, checked = false;
  t.mock.method(m1, "executeM1", async options => {
    assert.equal(options.pinned, future); options.pinned.assertUsable();
    acquired.m1Budget.acceptUnsigned(acquired.hotPathLease, future, future.nextBlock.context);
    const dispatched = Promise.allSettled([options.pinned.send("0x010203"),
      Promise.resolve().then(() => options.secondarySendRawTransaction("0x010203"))]);
    queueMicrotask(() => { if (invalidation === "cancel") lease.cancelFuture(); else f.advance(11000); });
    const [primary, secondary] = await dispatched;
    assert.equal(primary.status, "rejected"); assert.equal(primary.reason.code, "PINNED_RPC_FAILED");
    assert.equal(secondary.status, "rejected"); assert.equal(secondary.reason.code, "PIN_EVIDENCE_INVALIDATED");
    checked = true; return { stage: "UNCERTAIN" };
  });
  await runWithDefaultSecondary(f, async () => {
    lease = await f.acquire(); await turn(); const facade = lease.takeFuture(); assert.ok(facade);
    const liveCase = live.fixture(t, { pin: lease.current.pin, now: f.state.now });
    const current = { ...liveCase.pinned, nextBlock: undefined, evidence: { ...liveCase.pinned.evidence, nextBlockQualified: false },
      assertUsable: lease.current.assertUsable };
    future = { ...liveCase.pinned, send: facade.send, assertUsable: facade.assertUsable };
    return acquired = { liveCase, hotPathLease: { current, takeFuture: () => future, cancelFuture: lease.cancelFuture } };
  }, [...FLAGS, "--next-block"]);
  assert.equal(checked, true); lease.current.assertUsable();
  assert.equal(f.state.calls.filter(call => call.method === "eth_sendRawTransaction").length, 1);
  assert.equal(fetches.length, 0);
});

for (const invalidation of ["close", "inventory", "clock"]) test(`real httpRpc primary checks ${invalidation} again at the inner fetch boundary`, async t => {
  const fetches = mockHttpFetch(t), f = fixture(t, { httpSends: true }); await f.ready(); const lease = await f.acquire(); let closing;
  const dispatched = lease.current.send("0x010203");
  queueMicrotask(() => {
    if (invalidation === "close") closing = f.factory.close();
    else if (invalidation === "inventory") { f.candidates[0].family += "_CHANGED"; f.maintain(); }
    else f.state.mono = -1;
  });
  await assert.rejects(dispatched, { code: "PINNED_RPC_FAILED" }); await closing;
  assert.equal(f.state.calls.filter(call => call.method === "eth_sendRawTransaction").length, 1);
  assert.equal(fetches.length, 0);
  if (invalidation === "clock") f.state.mono = 0;
  assert.throws(lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
});

test("real httpRpc legacy four-argument sends and harmless read RPCs remain unchanged", async t => {
  const fetches = mockHttpFetch(t), candidate = { handle: "OFFLINE_OPAQUE" }; let guards = 0;
  assert.equal(await transport.httpRpc(candidate, "eth_sendRawTransaction", ["0x010203"], 1000), keccak256("0x010203"));
  assert.equal(await transport.httpRpc(candidate, "eth_sendRawTransaction", ["0x010203"], 1000, () => { guards++; }), keccak256("0x010203"));
  assert.equal(await transport.httpRpc(candidate, "eth_chainId", [], 1000, forbidden), "0x1");
  assert.equal(await transport.httpRpc(candidate, "eth_chainId", [], 1000), "0x1");
  assert.equal(guards, 1); assert.equal(fetches.length, 4);
  assert.deepEqual(fetches.slice(0, 2).map(call => call.body.params), [["0x010203"], ["0x010203"]]);
});

test("real httpRpc invalid dispatch guards are sanitized and nonretryable without fetch", async t => {
  const fetches = mockHttpFetch(t);
  for (const assertDispatch of [null, false, "INVALID", () => true, () => Promise.reject(new Error("PRIVATE_ASYNC_GUARD")),
    () => { throw Object.assign(new Error("PRIVATE_GUARD"), { code: "ECONNRESET" }); }]) {
    await assert.rejects(transport.httpRpc({ handle: "OFFLINE_OPAQUE" }, "eth_sendRawTransaction", ["0x010203"], 1000, assertDispatch),
      error => error.code === "PIN_EVIDENCE_INVALIDATED" && error.message === "PIN_EVIDENCE_INVALIDATED");
  }
  await turn(); assert.equal(fetches.length, 0);
});

test("real httpRpc prepares request body before the final dispatch guard", async t => {
  const fetches = mockHttpFetch(t); let usable = true;
  const params = ["0x010203"]; params.toJSON = () => { usable = false; return ["0x010203"]; };
  await assert.rejects(transport.httpRpc({ handle: "OFFLINE_OPAQUE" }, "eth_sendRawTransaction", params, 1000,
    () => guard.requireThat(usable, "PIN_EVIDENCE_INVALIDATED")), { code: "PIN_EVIDENCE_INVALIDATED" });
  assert.equal(fetches.length, 0);
});

test("real httpRpc blocked primary/default-secondary dispatch retains one signed UNCERTAIN journal", async t => {
  const fetches = mockHttpFetch(t), f = fixture(t, { httpSends: true }); await f.ready(); let closing;
  const { liveCase, outputs } = await runWithDefaultSecondary(f, async () => {
    const lease = await f.acquire(), liveCase = live.fixture(t, { future: false, pin: lease.current.pin, now: f.state.now });
    const pinned = { ...liveCase.pinned, assertUsable: lease.current.assertUsable, send: (signed, additional) => {
      const dispatched = lease.current.send(signed, additional);
      queueMicrotask(() => { closing = f.factory.close(); });
      return dispatched;
    } };
    return { liveCase, hotPathLease: { current: pinned, takeFuture: forbidden, cancelFuture() {} } };
  });
  await closing;
  assert.equal(outputs.length, 1); assert.equal(outputs[0].reason, "SIGNED_ATTEMPT_ENDED_PASS");
  assert.equal(liveCase.state.signs, 1); assert.equal(fetches.length, 0);
  assert.equal(f.state.calls.filter(call => call.method === "eth_sendRawTransaction").length, 1, "no relay retry");
  const files = fs.readdirSync(liveCase.journalDir).filter(name => name.endsWith(".json")); assert.equal(files.length, 1);
  const record = JSON.parse(fs.readFileSync(require("node:path").join(liveCase.journalDir, files[0]), "utf8"));
  assert.equal(record.stage, "UNCERTAIN"); assert.equal(record.reason, "BROADCAST_OUTCOME_UNCERTAIN");
  assert.equal(record.txHash, keccak256("0x010203"));
});

test("real httpRpc valid guarded relays still dispatch concurrent identical bytes", async t => {
  const calls = [], both = deferred();
  t.mock.method(globalThis, "fetch", async (_handle, options) => {
    calls.push(JSON.parse(options.body)); if (calls.length === 2) both.resolve();
    await both.promise;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: keccak256("0x010203") }), { status: 200 });
  });
  const f = fixture(t, { httpSends: true }); await f.ready();
  const { liveCase, outputs } = await runWithDefaultSecondary(f, async () => {
    const lease = await f.acquire(), liveCase = live.fixture(t, { future: false, pin: lease.current.pin, now: f.state.now });
    const pinned = { ...liveCase.pinned, assertUsable: lease.current.assertUsable, send: lease.current.send };
    return { liveCase, hotPathLease: { current: pinned, takeFuture: forbidden, cancelFuture() {} } };
  });
  assert.equal(liveCase.state.signs, 1); assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.params), [["0x010203"], ["0x010203"]]);
  assert.equal(outputs[0].execution.stage, "RECEIPT_VERIFIED");
});

test("v2 validates fixed options; cold acquire never starts or awaits pool work", async t => {
  const f = fixture(t), gate = deferred();
  for (const options of [{ allowFuture: 1 }, { rpc: null }, { ttlMs: 1000 }, { requireStrictEvidence: false }, { onTiming: 1 }])
    assert.throws(() => transport.createM1HotPathFactory({ rpc: f.rpc, ...options }), /M1_HOT_PATH_OPTIONS_INVALID/);
  await assert.rejects(f.acquire(), /M1_HOT_PATH_SELECTION_HOLD/); assert.equal(f.state.calls.length, 0);
  f.state.hook = async () => { await gate.promise; };
  assert.deepEqual(f.maintain(), { selection: "HOLD", refreshing: true });
  await turn(); assert.equal(f.state.calls.length, 2);
  await assert.rejects(f.acquire(), /M1_HOT_PATH_SELECTION_HOLD/);
  assert.deepEqual(f.maintain(), { selection: "HOLD", refreshing: true }); assert.equal(f.state.calls.length, 2);
  gate.resolve(); await turn(); assert.equal(f.maintain().selection, "READY");
});

test("background qualifies all 32 candidates with two workers before selecting; foreground requalifies pair only", async t => {
  const f = fixture(t, { count: 32 });
  f.state.hook = call => call.alias === 0 && call.method === "eth_chainId" ? "0x2" : undefined;
  await f.ready(); assert.equal(f.state.peak, 2);
  assert.equal(new Set(f.state.calls.map(call => call.alias)).size, 32);
  const before = f.state.calls.length, lease = await f.acquire(), calls = f.state.calls.slice(before);
  assert.deepEqual([...new Set(calls.map(call => call.alias))], [1, 2]);
  assert.deepEqual(lease.current.evidence.aliases, [2, 3]);
  for (const alias of [1, 2]) assert.equal(calls.filter(call => call.alias === alias && call.method === "eth_getCode").length, 3);
  assert.equal(lease.current.nextBlock, undefined); assert.equal(lease.takeFuture(), null);
  assert.ok(Object.isFrozen(lease.current)); assert.ok(Object.isFrozen(lease.current.evidence.qualification[0].strictProbePin));
  assert.doesNotMatch(JSON.stringify(lease), /PRIVATE_/);
});

test("selection TTL starts at refresh start and never slides on acquisitions", async t => {
  const f = fixture(t); await f.ready();
  for (const delta of [10000, 20000, 29999]) { f.advance(delta); await f.acquire(); }
  f.advance(1); const before = f.state.calls.length;
  await assert.rejects(f.acquire(), /SELECTION_HOLD/); assert.equal(f.state.calls.length, before);
  assert.equal(f.maintain().selection, "HOLD"); await turn(); assert.equal(f.maintain().selection, "READY");
});

test("refresh starts at 30s remaining; old selection expires even with refresh inflight and late results cannot publish", async t => {
  const f = fixture(t); await f.ready(); f.advance(30000);
  const gate = deferred(); let held = false;
  f.state.hook = async call => { if (!held && call.method === "eth_chainId") { held = true; await gate.promise; } };
  assert.deepEqual(f.maintain(), { selection: "READY", refreshing: true }); await turn();
  const lease = await f.acquire(); lease.current.assertUsable(); f.advance(30000);
  await assert.rejects(f.acquire(), /SELECTION_HOLD/); gate.resolve(); await turn();
  assert.equal(f.maintain().selection, "HOLD"); await turn(); assert.equal(f.maintain().selection, "READY");
});

test("failed background refresh retains only original unexpired eligibility and retries no faster than 5s", async t => {
  const f = fixture(t); await f.ready(); f.advance(30000);
  f.state.hook = () => { throw new guard.ExecutionError("PINNED_RPC_FAILED"); };
  f.maintain(); await turn(); const before = f.state.calls.length;
  assert.deepEqual(f.maintain(), { selection: "READY", refreshing: false }); assert.equal(f.state.calls.length, before);
  f.advance(4999); f.maintain(); await turn(); assert.equal(f.state.calls.length, before);
  f.advance(1); f.maintain(); await turn(); assert.ok(f.state.calls.length > before);
  f.advance(25000); await assert.rejects(f.acquire(), /SELECTION_HOLD/);
});

test("30-second pool budget rejects late results and issues no further physical requests", async t => {
  const f = fixture(t);
  f.state.hook = () => { f.advance(17000); };
  f.maintain(); await turn();
  await assert.rejects(f.acquire(), /SELECTION_HOLD/); assert.equal(f.state.calls.length, 2);
});

test("malformed transport responses invalidate an existing selection during refresh, unlike availability failures", async t => {
  const f = fixture(t); await f.ready(); f.advance(30000);
  f.state.hook = () => { throw new guard.ExecutionError("RPC_FAILED"); };
  f.maintain(); await turn(); await assert.rejects(f.acquire(), /SELECTION_HOLD/);
});

test("inventory mutation and profile overrides cannot reuse or publish stale selections", async t => {
  const f = fixture(t), gate = deferred(); let held = false;
  f.state.hook = async () => { if (!held) { held = true; await gate.promise; } };
  f.maintain(); await turn(); f.candidates[0].family += "_CHANGED"; gate.resolve(); await turn();
  await assert.rejects(f.acquire(), /SELECTION_HOLD/);
  f.advance(5000); await f.ready();
  await assert.rejects(f.factory.acquire({ candidates: f.candidates, allowFuture: true }), /M1_HOT_PATH_OPTIONS_INVALID/);
  await assert.rejects(f.acquire(), /SELECTION_HOLD/);
  assert.throws(() => f.factory.maintain({ candidates: [{ family: "x", handle: {} }, f.candidates[1]] }), /RPC_CANDIDATES_INVALID/);
});

test("clock anomalies invalidate eligibility and active proofs without resurrecting stale inflight results", async t => {
  const f = fixture(t); await f.ready(); const old = await f.acquire(); f.advance(1000);
  f.state.mono = -1; assert.throws(f.maintain, /M1_HOT_PATH_CLOCK_INVALID/); assert.throws(old.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
  f.state.mono = 6000; f.state.now = NOW + 6000; await f.ready();
  f.state.now += 10000; assert.throws(f.maintain, /M1_HOT_PATH_CLOCK_INVALID/);
});

test("routine valid refresh never poisons active proof; real old-session disagreement defeats a late refresh", async t => {
  const f = fixture(t); await f.ready(); const old = await f.acquire(); f.advance(30000); await f.ready(); old.current.assertUsable();
  assert.equal(await old.current.code("0x" + "11".repeat(20)), "0x600160ab");
  f.advance(30000); const gate = deferred(); let held = false;
  f.state.hook = async call => {
    if (!held && call.method === "eth_chainId") { held = true; await gate.promise; }
    if (call.alias === 1 && call.method === "eth_getCode" && call.params[0] !== transport.MULTICALL3) return "0x6002";
  };
  f.maintain(); await turn(); await assert.rejects(old.current.code("0x" + "11".repeat(20)), /PROVIDER_RESULT_DISAGREEMENT/);
  gate.resolve(); await turn(); await assert.rejects(f.acquire(), /SELECTION_HOLD/);
  assert.throws(old.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
});

for (const failure of ["NEXT_BLOCK_METHOD_UNAVAILABLE", "malformed"]) test(`optional ${failure} never delays or disables independently valid CURRENT`, async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const gate = deferred();
  f.state.hook = async call => {
    if (call.method === "eth_simulateV1") { await gate.promise;
      if (failure === "malformed") return []; throw new guard.ExecutionError(failure); }
  };
  const lease = await f.acquire(); assert.ok(f.state.active > 0); lease.current.assertUsable();
  assert.equal(lease.current.nextBlock, undefined); gate.resolve(); await turn(); lease.current.assertUsable();
  assert.equal(await lease.current.code("0x" + "11".repeat(20)), "0x600160ab"); assert.equal(lease.takeFuture(), null);
});

test("ready FUTURE is a one-shot separate immutable facade with fresh exact same-acquisition controls", async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const lease = await f.acquire(), before = JSON.stringify(lease.current);
  await turn(); const future = lease.takeFuture(); assert.ok(future); assert.equal(lease.takeFuture(), null);
  assert.notEqual(future, lease.current); assert.equal(future.pin, lease.current.pin); assert.equal(future.call, lease.current.call);
  assert.equal(future.evidence.nextBlockQualified, true); assert.equal(lease.current.evidence.nextBlockQualified, undefined);
  assert.equal(JSON.stringify(lease.current), before); assert.ok(Object.isFrozen(future));
  const calls = f.state.calls.filter(call => call.method === "eth_simulateV1"); assert.equal(calls.length, 6);
  assert.ok(calls.every(call => [future.pin.hash, UNKNOWN].includes(call.params[1].blockHash)));
  lease.cancelFuture(); await assert.rejects(future.nextBlock.recheck(), /NEXT_BLOCK_RPC_FAILED/);
});

test("early take/cancel and superseding acquisitions discard late FUTURE without blocking CURRENT or overlapping optional jobs", async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const gate = deferred();
  f.state.hook = async call => { if (call.method === "eth_getTransactionCount") await gate.promise; };
  const lease = await f.acquire(); assert.equal(lease.takeFuture(), null);
  const next = await f.acquire(); assert.equal(f.state.calls.filter(call => call.method === "eth_getTransactionCount").length, 2);
  next.current.assertUsable(); gate.resolve(); await turn(); assert.equal(lease.takeFuture(), null); assert.equal(next.takeFuture(), null);
  assert.equal(f.state.calls.filter(call => call.method === "eth_getBalance").length, 2, "v2 account reads are a width-two stage");
  assert.equal(f.state.calls.some(call => call.method === "eth_simulateV1"), false, "cancelled stage cannot enqueue positive controls");
});

test("unsupported optional work drains its delayed sibling before another job; negative hint never becomes proof", async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const gate = deferred();
  f.state.hook = async call => {
    if (call.method === "eth_simulateV1") {
      if (call.alias === 0) throw new guard.ExecutionError("NEXT_BLOCK_METHOD_UNAVAILABLE");
      await gate.promise;
    }
  };
  const first = await f.acquire(); await turn(); const before = f.state.calls.filter(call => call.method === "eth_getTransactionCount").length;
  const second = await f.acquire(); assert.equal(f.state.calls.filter(call => call.method === "eth_getTransactionCount").length, before);
  first.current.assertUsable(); second.current.assertUsable(); gate.resolve(); await turn();
  assert.equal(first.takeFuture(), null); assert.equal(second.takeFuture(), null);
});

for (const expiry of ["deadline", "normal-advance"]) test(`${expiry} invalidates child only, not selected-pair eligibility`, async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const lease = await f.acquire(); await turn(); const future = lease.takeFuture();
  assert.ok(future);
  if (expiry === "deadline") f.advance(11000); else f.state.head++;
  await assert.rejects(future.nextBlock.recheck(), new RegExp(expiry === "deadline" ? "NEXT_BLOCK_DEADLINE" : "NEXT_BLOCK_HEAD_ADVANCED"));
  lease.current.assertUsable(); assert.equal(f.maintain().selection, "READY");
});

test("actual future result disagreement evicts eligibility, but does not relabel or poison independent CURRENT proof", async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const lease = await f.acquire(); await turn(); const future = lease.takeFuture();
  f.state.hook = call => {
    if (call.alias === 1 && call.method === "eth_simulateV1") { const value = simulation(call.params); value[0].calls[0].returnData = "0x5678"; return value; }
  };
  const tx = { type: 2, chainId: 1, from: guard.MAIN_ACCOUNT, to: "0x" + "11".repeat(20), data: "0x1234", value: 0, nonce: 7,
    gasLimit: 180000, maxFeePerGas: 200000000, maxPriorityFeePerGas: 1, accessList: [] };
  await assert.rejects(future.nextBlock.simulate(tx), /NEXT_BLOCK_PROVIDER_DISAGREEMENT/);
  await assert.rejects(f.acquire(), /SELECTION_HOLD/); lease.current.assertUsable();
});

test("wrong-chain child evidence invalidates affected parent proofs and eligibility", async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const lease = await f.acquire(); await turn(); const future = lease.takeFuture();
  f.state.hook = call => call.method === "eth_chainId" ? "0x2" : undefined;
  await assert.rejects(future.nextBlock.recheck(), /NEXT_BLOCK_WRONG_CHAIN/);
  assert.throws(lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/); await assert.rejects(f.acquire(), /SELECTION_HOLD/);
});

for (const field of ["hash", "stateRoot", "timestamp"]) test(`one canonical witness contradicting pinned ${field} permanently poisons CURRENT`, async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const lease = await f.acquire(); await turn(); const future = lease.takeFuture();
  f.state.hook = call => call.alias === 1 && call.method === "eth_getBlockByNumber" && call.params[0] === hex(HEAD)
    ? { ...header(), [field]: field === "timestamp" ? hex(TIME + 1) : hash(9999) } : undefined;
  await assert.rejects(future.nextBlock.recheck(), { code: "NEXT_BLOCK_CANONICAL_DISAGREEMENT" });
  await assert.rejects(f.acquire(), /SELECTION_HOLD/); assert.throws(lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
  f.state.hook = () => undefined;
  await assert.rejects(future.nextBlock.recheck(), /NEXT_BLOCK_EVIDENCE_INVALIDATED/);
  assert.throws(lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
  f.advance(5000); await f.ready(); (await f.acquire()).current.assertUsable();
  assert.throws(lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/, "new eligibility never rehabilitates the old proof");
});

for (const stage of ["probe", "prepublication"]) for (const failure of ["chain", "header", "canonical"])
  test(`optional qualification ${stage} ${failure} poisons already-published CURRENT`, async t => {
    const f = fixture(t, { allowFuture: true }); await f.ready(); const gate = deferred(); let released = false;
    const code = { chain: "NEXT_BLOCK_WRONG_CHAIN", header: "NEXT_BLOCK_HEADER_INVALID", canonical: "NEXT_BLOCK_CANONICAL_DISAGREEMENT" }[failure];
    f.state.hook = async call => {
      if (call.method === "eth_getTransactionCount") { await gate.promise;
        if (stage === "probe" && call.alias === 1) throw new guard.ExecutionError(code); }
      if (stage === "prepublication" && released && call.alias === 1) {
        if (failure === "chain" && call.method === "eth_chainId") return "0x2";
        if (call.method === "eth_getBlockByNumber" && call.params[0] === hex(HEAD)) {
          if (failure === "header") return {};
          if (failure === "canonical") return { ...header(), stateRoot: hash(9999) };
        }
      }
    };
    const lease = await f.acquire(); lease.current.assertUsable(); released = true; gate.resolve(); await turn();
    assert.equal(lease.takeFuture(), null); await assert.rejects(f.acquire(), /SELECTION_HOLD/);
    f.state.hook = () => undefined; assert.throws(lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
  });

test("observed wrong chain outranks a sibling completing at child deadline", async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const lease = await f.acquire(); await turn(); const future = lease.takeFuture();
  const gate = deferred(); f.state.hook = async call => {
    if (call.method === "eth_chainId") { if (call.alias === 1) return "0x2"; await gate.promise; }
  };
  const check = future.nextBlock.recheck(); await turn(); f.advance(11000); gate.resolve();
  await assert.rejects(check, { code: "NEXT_BLOCK_WRONG_CHAIN" }); await assert.rejects(f.acquire(), /SELECTION_HOLD/);
  f.state.hook = () => undefined; assert.throws(lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
  await assert.rejects(future.nextBlock.recheck(), /NEXT_BLOCK_EVIDENCE_INVALIDATED/);
});

for (const failure of ["malformed", "unclassified"]) test(`observed ${failure} simulation failure outranks deadline without poisoning independent CURRENT`, async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const lease = await f.acquire(); await turn(); const future = lease.takeFuture();
  const gate = deferred(); f.state.hook = async call => {
    if (call.method === "eth_simulateV1") {
      if (call.alias === 1) { if (failure === "unclassified") throw new Error("PRIVATE_UNCLASSIFIED"); return []; }
      await gate.promise;
    }
  };
  const result = future.nextBlock.simulate(TX); await turn(); f.advance(11000); gate.resolve();
  await assert.rejects(result, { code: failure === "malformed" ? "NEXT_BLOCK_RESULT_INVALID" : "NEXT_BLOCK_TRUST_FAILED" });
  await assert.rejects(f.acquire(), /SELECTION_HOLD/); lease.current.assertUsable(); f.state.hook = () => undefined;
  await assert.rejects(future.nextBlock.recheck(), /NEXT_BLOCK_EVIDENCE_INVALIDATED/);
});

test("simulation output disagreement is retained ahead of an otherwise corroborated normal head advance", async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const lease = await f.acquire(); await turn(); const future = lease.takeFuture();
  f.state.hook = call => {
    if (call.method === "eth_simulateV1") {
      const raw = simulation(call.params);
      if (call.alias === 1) { raw[0].calls[0].returnData = "0xabcd"; f.state.head++; }
      return raw;
    }
  };
  await assert.rejects(future.nextBlock.simulate(TX), { code: "NEXT_BLOCK_PROVIDER_DISAGREEMENT" });
  await assert.rejects(f.acquire(), /SELECTION_HOLD/); lease.current.assertUsable();
  f.state.hook = () => undefined; await assert.rejects(future.nextBlock.recheck(), /NEXT_BLOCK_EVIDENCE_INVALIDATED/);
});

test("qualification aggregates parent trust ahead of an earlier unsupported sibling", async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const gate = deferred();
  f.state.hook = async call => {
    if (call.method === "eth_getTransactionCount") { await gate.promise;
      throw new guard.ExecutionError(call.alias === 0 ? "NEXT_BLOCK_METHOD_UNAVAILABLE" : "NEXT_BLOCK_WRONG_CHAIN"); }
  };
  const lease = await f.acquire(); gate.resolve(); await turn();
  assert.equal(lease.takeFuture(), null); await assert.rejects(f.acquire(), /SELECTION_HOLD/);
  assert.throws(lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
});

for (const invalidation of ["close", "inventory"]) test(`${invalidation} after primary send queues prevents its physical RPC invocation permanently`, async t => {
  const f = fixture(t); await f.ready(); const lease = await f.acquire(); lease.current.assertUsable();
  const queued = lease.current.send("0x010203");
  if (invalidation === "close") { const closing = f.factory.close(); await assert.rejects(queued, /PINNED_RPC_FAILED/); await closing; }
  else {
    const original = f.candidates[0].family; f.candidates[0].family += "_CHANGED"; f.maintain();
    await assert.rejects(queued, /PINNED_RPC_FAILED/); f.candidates[0].family = original;
  }
  assert.equal(f.state.calls.filter(call => call.method === "eth_sendRawTransaction").length, 0);
  assert.throws(lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
  await assert.rejects(lease.current.send("0x010203"), /PIN_EVIDENCE_INVALIDATED/);
});

for (const failure of ["chain", "canonical"]) test(`background ${failure} failure after final validation blocks both runner relays`, async t => {
  const f = fixture(t); await f.ready(); f.advance(30000); const m1Budget = f.detect(), lease = await f.acquire();
  const liveCase = live.fixture(t, { future: false, pin: lease.current.pin, now: f.state.now });
  const pinned = { ...liveCase.pinned, assertUsable: lease.current.assertUsable, send: lease.current.send };
  const hotPathLease = { current: pinned, takeFuture: forbidden, cancelFuture() {} }; m1Budget.bind(hotPathLease);
  let primary, secondary, finalValidated = false, callbacks = 0;
  t.mock.method(m1, "executeM1", async options => {
    // Controlled executor boundary: no signer/keys, and the real factory send
    // plus the runner's injected secondary callback remain under test.
    options.pinned.assertUsable(); finalValidated = true;
    m1Budget.acceptUnsigned(hotPathLease, pinned); // This test mocks the final unsigned boundary, not budget/trust checks.
    f.state.hook = call => {
      if (call.alias === 0 && failure === "chain" && call.method === "eth_chainId") return "0x2";
      if (call.alias === 0 && failure === "canonical" && call.method === "eth_getBlockByNumber" && call.params[0] === hex(f.state.head))
        return { ...header(f.state.head), stateRoot: hash(9999) };
    };
    f.maintain(); await turn();
    [primary, secondary] = await Promise.allSettled([
      Promise.resolve().then(() => options.pinned.send("0x010203")),
      Promise.resolve().then(() => options.secondarySendRawTransaction("0x010203")),
    ]);
    return { stage: "UNCERTAIN" };
  });
  await liveCase.run({ argv: FLAGS, pinned, hotPathLease, m1Budget, now: () => f.state.now,
    secondarySendRawTransaction: () => { callbacks++; return keccak256("0x010203"); } });
  assert.equal(finalValidated, true); assert.equal(primary.status, "rejected"); assert.equal(secondary.status, "rejected");
  assert.equal(primary.reason.code, "PIN_EVIDENCE_INVALIDATED"); assert.equal(secondary.reason.code, "PIN_EVIDENCE_INVALIDATED");
  assert.equal(callbacks, 0); assert.equal(f.state.calls.filter(call => call.method === "eth_sendRawTransaction").length, 0);
  f.state.hook = () => undefined; assert.throws(lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
});

test("background qualification poisons trust between primary queue admission and its physical invocation", async t => {
  const f = fixture(t); await f.ready(); f.advance(30000); const m1Budget = f.detect(), lease = await f.acquire();
  const liveCase = live.fixture(t, { future: false, pin: lease.current.pin, now: f.state.now });
  const pinned = { ...liveCase.pinned, assertUsable: lease.current.assertUsable, send: lease.current.send };
  const hotPathLease = { current: pinned, takeFuture: forbidden, cancelFuture() {} }; m1Budget.bind(hotPathLease);
  let dispatched, queuedWhileUsable = false, secondary = 0;
  t.mock.method(m1, "executeM1", async options => {
    options.pinned.assertUsable(); // Final validation has completed.
    m1Budget.acceptUnsigned(hotPathLease, pinned);
    f.state.hook = call => {
      if (call.alias !== 0 || call.method !== "eth_getBlockByNumber" || call.params[0] !== "latest") return;
      // Instrument consumption of this synthetic response: admission occurs
      // immediately before the pool validates/rejects its malformed header.
      return { get hash() {
        options.pinned.assertUsable(); queuedWhileUsable = true;
        dispatched = Promise.allSettled([options.pinned.send("0x010203"),
          Promise.resolve().then(() => options.secondarySendRawTransaction("0x010203"))]);
        return "MALFORMED_HEADER";
      } };
    };
    f.maintain(); await turn();
    const [primary, other] = await dispatched;
    assert.equal(primary.status, "rejected"); assert.equal(primary.reason.code, "PINNED_RPC_FAILED");
    assert.equal(other.status, "rejected"); assert.equal(other.reason.code, "PIN_EVIDENCE_INVALIDATED");
    return { stage: "UNCERTAIN" };
  });
  await liveCase.run({ argv: FLAGS, pinned, hotPathLease, m1Budget, now: () => f.state.now,
    secondarySendRawTransaction: () => { secondary++; return keccak256("0x010203"); } });
  assert.equal(queuedWhileUsable, true); assert.equal(secondary, 0);
  assert.equal(f.state.calls.filter(call => call.method === "eth_sendRawTransaction").length, 0);
  f.state.hook = () => undefined; assert.throws(lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
});

for (const invalidation of ["close", "inventory"]) test(`guarded M1 ${invalidation} in queued primary dispatch blocks injected secondary and retains signed journal hold`, async t => {
  const f = fixture(t); await f.ready(); const m1Budget = f.detect(), lease = await f.acquire();
  const liveCase = live.fixture(t, { future: false, pin: lease.current.pin, now: NOW }); let secondary = 0, closing;
  const pinned = { ...liveCase.pinned, assertUsable: lease.current.assertUsable, send: (signed, additional) => {
    const queued = lease.current.send(signed, additional);
    if (invalidation === "close") closing = f.factory.close();
    else { f.candidates[0].family += "_CHANGED"; f.maintain(); }
    return queued;
  } };
  const hotPathLease = { current: pinned, takeFuture: forbidden, cancelFuture() {} }; m1Budget.bind(hotPathLease);
  const out = await liveCase.run({ argv: FLAGS, pinned, hotPathLease, m1Budget, now: () => f.state.now,
    secondarySendRawTransaction: () => { secondary++; return keccak256("0x010203"); } });
  await closing;
  assert.equal(out.fired, false); assert.equal(liveCase.state.signs, 1); assert.equal(secondary, 0);
  assert.equal(f.state.calls.filter(call => call.method === "eth_sendRawTransaction").length, 0);
  const journal = fs.readdirSync(liveCase.journalDir).filter(name => name.endsWith(".json")); assert.equal(journal.length, 1);
  const record = JSON.parse(fs.readFileSync(require("node:path").join(liveCase.journalDir, journal[0]), "utf8"));
  assert.equal(record.stage, "UNCERTAIN"); assert.equal(record.reason, "BROADCAST_OUTCOME_UNCERTAIN");
  assert.equal(record.txHash, keccak256("0x010203")); assert.throws(lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
});

test("FUTURE dispatch rechecks its child guard inside queued primary invocation without poisoning CURRENT", async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const lease = await f.acquire(); await turn(); const future = lease.takeFuture();
  const queued = future.send("0x010203"); lease.cancelFuture();
  await assert.rejects(queued, /PINNED_RPC_FAILED/); lease.current.assertUsable();
  assert.equal(f.state.calls.filter(call => call.method === "eth_sendRawTransaction").length, 0);
  assert.equal(await lease.current.send("0x010203"), keccak256("0x010203"));
});

test("runner secondary uses the active FUTURE guard, not the independently valid CURRENT guard", async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const m1Budget = f.detect(), lease = await f.acquire(); await turn(); const facade = lease.takeFuture();
  const liveCase = live.fixture(t, { pin: lease.current.pin, now: NOW }); let secondary = 0, checked = false;
  const current = { ...liveCase.pinned, nextBlock: undefined, evidence: { ...liveCase.pinned.evidence, nextBlockQualified: false },
    assertUsable: lease.current.assertUsable };
  const future = { ...liveCase.pinned, assertUsable: facade.assertUsable, send: facade.send };
  const hotPathLease = { current, takeFuture: () => future, cancelFuture: lease.cancelFuture }; m1Budget.bind(hotPathLease);
  t.mock.method(m1, "executeM1", async options => {
    assert.equal(options.pinned, future); options.pinned.assertUsable();
    m1Budget.acceptUnsigned(hotPathLease, future, future.nextBlock.context); lease.cancelFuture(); lease.current.assertUsable();
    await assert.rejects(options.pinned.send("0x010203"), /NEXT_BLOCK_EVIDENCE_INVALIDATED/);
    assert.throws(() => options.secondarySendRawTransaction("0x010203"), /NEXT_BLOCK_EVIDENCE_INVALIDATED/);
    checked = true; return { stage: "UNCERTAIN" };
  });
  await liveCase.run({ argv: [...FLAGS, "--next-block"], pinned: current, hotPathLease, m1Budget, now: () => f.state.now,
    secondarySendRawTransaction: () => { secondary++; return keccak256("0x010203"); } });
  assert.equal(checked, true); assert.equal(secondary, 0); lease.current.assertUsable();
  assert.equal(f.state.calls.filter(call => call.method === "eth_sendRawTransaction").length, 0);
});

for (const failingRelay of ["primary", "secondary"]) test(`v2 ${failingRelay} failure preserves concurrent identical bytes and primary-authoritative journals`, async t => {
  const f = fixture(t); await f.ready(); const m1Budget = f.detect(), lease = await f.acquire();
  const liveCase = live.fixture(t, { future: false, pin: lease.current.pin, now: NOW });
  const gate = deferred(); let primaryBytes, secondaryBytes;
  f.state.hook = async call => {
    if (call.method === "eth_sendRawTransaction") {
      primaryBytes = call.params[0]; await gate.promise;
      if (failingRelay === "primary") throw new guard.ExecutionError("PINNED_RPC_FAILED");
    }
  };
  const pinned = { ...liveCase.pinned, assertUsable: lease.current.assertUsable, send: lease.current.send };
  const hotPathLease = { current: pinned, takeFuture: forbidden, cancelFuture() {} }; m1Budget.bind(hotPathLease);
  const out = await liveCase.run({ argv: FLAGS, pinned, hotPathLease, m1Budget, now: () => f.state.now,
    secondarySendRawTransaction: async signed => {
      secondaryBytes = signed; await turn(); assert.equal(primaryBytes, signed); gate.resolve();
      if (failingRelay === "secondary") throw new guard.ExecutionError("PINNED_RPC_FAILED");
      return keccak256(signed);
    } });
  assert.equal(primaryBytes, "0x010203"); assert.equal(secondaryBytes, primaryBytes); assert.equal(liveCase.state.signs, 1);
  assert.equal(out.fired, failingRelay === "secondary");
  const file = fs.readdirSync(liveCase.journalDir).find(name => name.endsWith(".json"));
  const record = JSON.parse(fs.readFileSync(require("node:path").join(liveCase.journalDir, file), "utf8"));
  assert.equal(record.stage, failingRelay === "primary" ? "UNCERTAIN" : "RECEIPT_VERIFIED"); assert.equal(record.txHash, keccak256(primaryBytes));
});

test("close drains started optional requests and prevents every later publication/request", async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const gate = deferred();
  f.state.hook = async call => { if (call.method === "eth_getTransactionCount") await gate.promise; };
  const lease = await f.acquire(); let done = false;
  const closing = f.factory.close().then(() => { done = true; }); await turn(); assert.equal(done, false);
  gate.resolve(); await closing; const count = f.state.calls.length;
  assert.equal(lease.takeFuture(), null); await assert.rejects(f.acquire(), /M1_HOT_PATH_CLOSED/);
  assert.equal(f.state.calls.length, count); assert.equal(f.state.active, 0);
});

test("timing callbacks are sanitized, bounded, nonawaited and nonauthoritative", async t => {
  const f = fixture(t, { onTiming: () => Promise.reject(new Error("PRIVATE_OBSERVER")) }); await f.ready(); await f.acquire();
  let delivered = 0;
  const timing = runner.createHotPathTimings({ onTiming: () => { delivered++; throw new Error("PRIVATE_OBSERVER"); } });
  for (let i = 0; i < 200; i++) timing.observe({ phase: "wsArrival", edge: "point", atMonoMs: i, atWallMs: NOW });
  timing.observe({ phase: "private-field", edge: "point", atMonoMs: 1, atWallMs: NOW });
  timing.observe({ phase: "send", edge: "point", atMonoMs: 1, atWallMs: NOW, transaction: "PRIVATE_TX" });
  assert.equal(timing.snapshot().length, 128); assert.doesNotMatch(JSON.stringify(timing.snapshot()), /PRIVATE|transaction/);
  assert.equal(delivered, 0); timing.flush(); assert.equal(delivered, 128); timing.flush(); assert.equal(delivered, 128);
});

test("pin and future completion observers cannot consume deadlines before immutable proof publication or take", async t => {
  let f, delivered = 0;
  f = fixture(t, { allowFuture: true, onTiming: event => {
    if (["pinAcquisition", "futureQualification"].includes(event.phase) && event.edge === "end") { delivered++; f.advance(121000); }
  } });
  await f.ready(); const lease = await f.acquire(); await turn();
  assert.equal(delivered, 0); assert.equal(f.state.now, NOW);
  const future = lease.takeFuture(); assert.ok(future); lease.current.assertUsable(); await future.nextBlock.recheck();
  await f.factory.close(); assert.equal(delivered, 2);
});

test("queued acquisition timing is delivered before the next entry freshness checks, never after them", async t => {
  let f, delivered = 0;
  f = fixture(t, { onTiming: event => {
    if (event.phase === "pinAcquisition" && event.edge === "end") { delivered++; f.advance(61000); return new Promise(() => {}); }
  } });
  await f.ready(); await f.acquire(); assert.equal(delivered, 0);
  const calls = f.state.calls.length;
  await assert.rejects(f.acquire(), /M1_HOT_PATH_SELECTION_HOLD/);
  assert.equal(delivered, 1); assert.equal(f.state.calls.length, calls, "expired selection cannot acquire after observer delivery");
});

test("standalone pass observers run only after guarded execution; deadline-consuming callbacks cannot enter pre-sign/send windows", async t => {
  const f = detectedLiveFixture(t), current = { ...f.pinned, evidence: { ...f.pinned.evidence, nextBlockQualified: false }, nextBlock: undefined };
  let delivered = 0;
  const lease = { current, takeFuture: () => f.pinned, cancelFuture() {} }; f.m1Budget.bind(lease);
  const out = await f.run({ argv: [...FLAGS, "--next-block"], pinned: current, hotPathLease: lease, m1Budget: f.m1Budget,
    onTiming: event => {
      delivered++; assert.equal(f.state.signs, 1); assert.equal(f.state.sends, 1);
      if (event.edge === "end") f.state.now = f.context.timestamp * 1000;
      return new Promise(() => {});
    } });
  assert.equal(out.fired, true, JSON.stringify(out.summary.preflightFailures)); assert.ok(delivered > 0);
  assert.equal(out.summary.nextBlock.enabled, false, "snapshot follows observer delivery and rechecks elapsed context");
  assert.equal(f.state.signs, 1); assert.equal(f.state.sends, 1);
});

test("main captures B/C/background timings without invoking arbitrary observers inside the pass", async () => {
  let active = false, delivered = 0, capture;
  await runner.main([...FLAGS, "--check", "--no-write"], {
    wallNow: () => NOW, monotonicNow: () => 0,
    loadCandidates: () => [], loadBatch: () => ({}), connect: options => runner.connectForPass(options),
    createM1HotPathFactory: options => {
      capture = options.onTiming;
      return { maintain() {}, acquire: async () => ({ current: { pin: { number: 1, hash: hash(1), timestamp: TIME } }, takeFuture: forbidden, cancelFuture() {} }),
        close() { capture({ phase: "poolQualification", edge: "end", atMonoMs: 2, atWallMs: NOW }); } };
    },
    onTiming: () => { assert.equal(active, false); delivered++; return Promise.reject(new Error("PRIVATE_OBSERVER")); },
    runPass: async options => {
      active = true;
      try {
        options.onTiming({ phase: "finalValidation", edge: "end", atMonoMs: 1, atWallMs: NOW });
        capture({ phase: "futureQualification", edge: "end", atMonoMs: 1, atWallMs: NOW });
        await turn(); assert.equal(delivered, 0);
        return { summary: { armed: false, targets: [] } };
      } finally { active = false; }
    }, output() {},
  });
  assert.equal(delivered, 3);
});

test("new mode scope/flag conflicts fail before transport or wallet IO", async () => {
  for (const [args, code] of [[["--m1-hot-path-v2"], "M1_HOT_PATH_REQUIRES_M1_ONLY"], [[...FLAGS, "--reuse-qualified-pair"], "M1_HOT_PATH_REUSE_CONFLICT"],
    [["--m1-ws-heads"], "M1_WS_REQUIRES_HOT_PATH"], [[...FLAGS, "--measure-only", "--execute"], "MEASURE_ONLY_EXECUTION_FORBIDDEN"]])
    await assert.rejects(runner.main(args, { loadBatch: forbidden, loadCandidates: forbidden, connect: forbidden }), new RegExp(code));
  await assert.rejects(runner.main(FLAGS, { connect: forbidden }), /M1_HOT_PATH_FACTORY_INJECTION_REQUIRED/);
});

test("CURRENT nomination cancels optional work and has exactly one execution owner with parallel-v2 preparation", async t => {
  const f = detectedLiveFixture(t, { future: false }); let cancelled = 0, collections = 0, mode;
  const original = m1.executeM1;
  t.mock.method(m1, "executeM1", options => { mode = options.preparationMode; return original(options); });
  const lease = { current: f.pinned, takeFuture: forbidden, cancelFuture: () => { cancelled++; } }; f.m1Budget.bind(lease);
  const out = await f.run({ argv: [...FLAGS, "--next-block"], hotPathLease: lease, m1Budget: f.m1Budget,
    checkOnce: async options => { collections++; assert.equal(options.nextBlockContext, null); assert.equal(options.m1Only, true);
      return { pin: { ...f.pinned.pin, chainId: 1 }, targets: { [m1.ID]: f.row, unrelated: { user: "UNRELATED" } } }; } });
  assert.equal(mode, "parallel-v2"); assert.equal(out.fired, true, JSON.stringify(out.summary.preflightFailures));
  assert.equal(collections, 1); assert.ok(cancelled >= 1); assert.equal(f.state.signs, 1); assert.equal(f.state.sends, 1);
  assert.equal(out.summary.collectionScope, "M1_ONLY"); assert.equal(out.summary.partial, true); assert.equal(out.summary.phaseTimingsMs.broadCollection, null);
  const again = await f.run({ argv: FLAGS, hotPathLease: lease, m1Budget: f.m1Budget });
  assert.equal(again.fired, false); assert.equal(f.state.signs, 1); assert.equal(f.state.sends, 1);
  assert.equal(again.summary.preflightFailures[0].reason, "M1_TRIGGER_EVENT_ALREADY_ATTEMPTED");
});

for (const available of [false, true]) test(`healthy CURRENT takes only already-ready FUTURE (${available}) for one fresh forecast collection`, async t => {
  const f = detectedLiveFixture(t), contexts = []; let takes = 0;
  const current = { ...f.pinned, evidence: { ...f.pinned.evidence, nextBlockQualified: false }, nextBlock: undefined };
  const lease = { current, takeFuture: () => { takes++; return available ? f.pinned : null; }, cancelFuture() {} }; f.m1Budget.bind(lease);
  const out = await f.run({ argv: [...FLAGS, "--next-block"], pinned: current, hotPathLease: lease, m1Budget: f.m1Budget,
    checkOnce: async options => { contexts.push(options.nextBlockContext); assert.equal(options.m1Only, true); assert.equal(options.writeOut, false);
      return { pin: { ...current.pin, chainId: 1 }, targets: { [m1.ID]: f.row } }; } });
  assert.equal(takes, 1); assert.equal(contexts[0], null); assert.equal(contexts.length, available ? 2 : 1);
  assert.equal(out.fired, available, JSON.stringify(out.summary.preflightFailures)); assert.equal(f.state.signs, available ? 1 : 0);
  assert.equal(current.nextBlock, undefined); assert.equal(current.evidence.nextBlockQualified, false);
});

test("measurement forces background/foreground CURRENT and disables WS, wallet IO and writes for all flags", async t => {
  const f = fixture(t); await f.ready(); let lease;
  for (const method of ["readFileSync", "writeFileSync", "mkdirSync", "renameSync", "openSync", "existsSync"]) t.mock.method(fs, method, forbidden);
  for (const method of ["executeGuarded", "signWithProcessKey", "reconcileWallet", "acquireWalletLock"]) t.mock.method(guard, method, forbidden);
  const profiles = [], outputs = [];
  await runner.main([...FLAGS, "--measure-only", "--next-block", "--m1-ws-heads"], {
    wallNow: () => f.state.now, monotonicNow: () => f.state.mono,
    connect: options => runner.connectForPass({ ...options, create: forbidden }), loadCandidates: () => f.candidates, loadBatch: forbidden,
    createM1HotPathFactory: profile => { profiles.push(profile); return { maintain() {}, acquire: async () => { lease = await f.acquire(); return lease; }, close() {} }; },
    createAdvisoryHeadWakeup: forbidden, createM1HeadConnector: forbidden,
    runPass: options => runner.runPass({ ...options, now: () => NOW, loadMorphoBatch: forbidden, m1ReadFile: forbidden, amendmentReadFile: forbidden,
      checkOnce: async args => { assert.equal(args.nextBlockContext, null); return { pin: { ...lease.current.pin, chainId: 1 },
        targets: { [m1.ID]: { user: m1.BORROWER, liquidatableNow: false, debtRaw: "1" } } }; } }), output: row => outputs.push(row),
  });
  assert.equal(profiles.length, 1); assert.equal(profiles[0].allowFuture, false); assert.ok(Object.isFrozen(profiles[0]));
  assert.equal(outputs[0].mode, "MEASURE_ONLY"); assert.equal(outputs[0].armed, false); assert.equal(outputs[0].ok, true);
  assert.ok(f.state.calls.every(call => !["eth_getTransactionCount", "eth_getBalance", "eth_simulateV1"].includes(call.method)));
});

test("main creates one factory/advisory, reloads inventory, uses CURRENT lease, serializes passes and closes both", async () => {
  let made = 0, acquisitions = 0, closes = 0, starts = 0, active = 0, maximum = 0, loads = 0;
  const inventories = [], maintained = [], outputs = [], leases = [], onWake = []; let clock = 0;
  await runner.main([...FLAGS, "--check", "--no-write", "--next-block", "--m1-ws-heads", "--watch", "5", "--max-runs", "2"], {
    wallNow: () => NOW + clock, monotonicNow: () => clock,
    loadBatch: () => { loads++; return {}; }, loadCandidates: () => { const value = []; inventories.push(value); return value; },
    connect: options => runner.connectForPass(options), headConnect: forbidden,
    createM1HotPathFactory: profile => { made++; assert.equal(profile.allowFuture, true); return {
      maintain: ({ candidates }) => maintained.push(candidates), acquire: async ({ candidates }) => {
        assert.equal(active, 0); assert.equal(candidates, maintained[acquisitions]); acquisitions++;
        const current = { pin: { number: acquisitions, hash: hash(acquisitions), timestamp: Math.floor((NOW + clock) / 1000) - 1 } },
          lease = { current, takeFuture: forbidden, cancelFuture() {} }; leases.push(lease); return lease;
      }, close: async () => { closes++; },
    }; },
    createAdvisoryHeadWakeup: options => { onWake.push(options.onWake); return { start: async () => { starts++; for (let i = 0; i < 100; i++) options.onWake(); }, close: async () => { closes++; } }; },
    runPass: async options => { active++; maximum = Math.max(maximum, active); assert.equal(options.pinned, options.hotPathLease.current);
      await turn(); active--; return { summary: { targets: [], armed: false } }; },
    liveHeadNumber: async pinned => { assert.equal(active, 0); return pinned.pin.number + 1; },
    sleep: async ms => { clock += ms; }, now: () => clock, output: value => outputs.push(value),
  });
  assert.equal(made, 1); assert.equal(starts, 1); assert.equal(closes, 2); assert.equal(maximum, 1); assert.equal(loads, 2);
  assert.notEqual(inventories[0], inventories[1]); assert.notEqual(leases[0], leases[1]); assert.equal(outputs.length, 2);
});

test("WS storms coalesce into the existing head wait with a minimum 300ms polling interval and HTTP fallback", async () => {
  const wake = runner.createHeadWakeLatch(); let time = 0, reads = 0; const pauses = [];
  await runner.waitForNewHead({ number: 100 }, { intervalMs: 5000, wake, now: () => time,
    liveHeadNumber: async () => { reads++; for (let i = 0; i < 100; i++) wake.signal(); return reads === 3 ? 101 : 100; },
    sleep: async ms => { pauses.push(ms); time += ms; } });
  assert.deepEqual(pauses, [300, 300]); assert.equal(reads, 3); wake.close();
  const fallback = runner.createHeadWakeLatch();
  await runner.waitForNewHead({ number: 100 }, { intervalMs: 5000, wake: fallback, now: () => time,
    liveHeadNumber: async () => { throw new Error("OFFLINE_HTTP_FAILED"); }, sleep: async ms => { pauses.push(ms); time += ms; } });
  assert.equal(pauses.at(-1), 5000); fallback.close();
});

test("connector receives explicit runtime dependencies; advisory setup failure still leaves HTTP execution path available", async () => {
  const loadCandidates = () => [], loadHeadCandidates = () => [], fetchImpl = forbidden, WebSocketImpl = function () { forbidden(); };
  let passed = 0, closed = 0;
  await runner.main([...FLAGS, "--m1-ws-heads", "--check", "--no-write"], {
    wallNow: () => NOW, monotonicNow: () => 0,
    loadCandidates, loadHeadCandidates, loadBatch: () => ({}), fetchImpl, WebSocketImpl,
    connect: options => runner.connectForPass(options),
    createM1HotPathFactory: () => ({ maintain() {}, acquire: async () => ({ current: { pin: { number: 1, hash: hash(1), timestamp: TIME } }, cancelFuture() {}, takeFuture: forbidden }), close() { closed++; } }),
    createM1HeadConnector: options => { assert.deepEqual(options, { loadHeadCandidates, fetchImpl, WebSocketImpl }); throw new Error("OFFLINE_ADVISORY_UNAVAILABLE"); },
    createAdvisoryHeadWakeup: forbidden, runPass: async () => { passed++; return { summary: { targets: [], armed: false } }; }, output() {},
  });
  assert.equal(passed, 1); assert.equal(closed, 1);
});

test("foreground strict stages retain all 15 controls per witness with width two and canonical reread barriers", async t => {
  const f = fixture(t); await f.ready(); const before = f.state.calls.length;
  const counts = [0, 0], active = [0, 0], peak = [0, 0], done = [new Set(), new Set()];
  const expected = [
    ["eth_chainId", undefined], ["eth_getBlockByNumber", "latest"], ["eth_call", hash(HEAD)],
    ["eth_getBlockByNumber", hex(HEAD - 1)], ["eth_call", hash(HEAD - 1)],
    ["eth_getCode", hash(HEAD - 1)], ["eth_getCode", hash(HEAD)], ["eth_call", UNKNOWN], ["eth_getCode", UNKNOWN],
    ["eth_getBlockByNumber", hex(HEAD - 1)], ["eth_getBlockByNumber", hex(HEAD)],
    ["eth_chainId", undefined], ["eth_getBlockByNumber", "latest"], ["eth_getBlockByNumber", hex(HEAD)], ["eth_call", hash(HEAD)],
  ];
  const peaks = new Map();
  f.state.hook = async call => {
    const { alias } = call, index = counts[alias]++, stage = index < 4 ? "initial" : index < 7 ? "positive" : index < 9 ? "negative" : index < 11 ? "canonical" : "pin";
    assert.deepEqual([call.method, call.params[1]?.blockHash || call.params[0]], expected[index]);
    if (index >= 4 && index < 7) assert.ok(done[alias].has(3));
    if (index >= 7 && index < 9) for (const positive of [4, 5, 6]) assert.ok(done[alias].has(positive));
    if (index >= 9 && index < 11) for (const control of [4, 5, 6, 7, 8]) assert.ok(done[alias].has(control));
    if (index >= 11) for (const witness of done) assert.ok(witness.has(9) && witness.has(10));
    if (["eth_call", "eth_getCode"].includes(call.method)) {
      assert.deepEqual(call.params[1], { blockHash: expected[index][1], requireCanonical: true });
      assert.deepEqual(call.params[0], call.method === "eth_getCode" ? transport.MULTICALL3 :
        { to: transport.MULTICALL3, data: transport.PROBE.encodeFunctionData("getBlockNumber") });
    }
    peak[alias] = Math.max(peak[alias], ++active[alias]);
    peaks.set(`${alias}:${stage}`, Math.max(peaks.get(`${alias}:${stage}`) || 0, active[alias]));
    try { await new Promise(resolve => setTimeout(resolve, index === 4 ? 12 : 5)); }
    finally { active[alias]--; done[alias].add(index); }
  };
  const lease = await f.acquire(); lease.current.assertUsable();
  assert.deepEqual(counts, [15, 15]); assert.deepEqual(peak, [2, 2]); assert.deepEqual(active, [0, 0]);
  for (const alias of [0, 1]) for (const stage of ["positive", "negative", "canonical"]) assert.equal(peaks.get(`${alias}:${stage}`), 2);
  for (const alias of [0, 1]) for (const stage of ["initial", "pin"]) assert.equal(peaks.get(`${alias}:${stage}`), 1);
  assert.deepEqual([...new Set(f.state.calls.slice(before).map(call => call.alias))], [0, 1]);
  assert.ok(lease.current.evidence.qualification.every(row => row.callUnknownHashRejected && row.codeUnknownHashRejected));
});

for (const availability of ["PINNED_RPC_FAILED", "RPC_TIMEOUT"]) test(`strict stage drains malformed sibling after ${availability}, stops unstarted jobs and permanently poisons old proofs`, async t => {
  const f = fixture(t); await f.ready(); const old = await f.acquire(), gate = deferred(), exhausted = deferred();
  const before = f.state.calls.length; let attempts = 0, done = false;
  f.state.hook = async call => {
    if (call.alias !== 0) return;
    if (call.method === "eth_call" && call.params[1].blockHash === hash(HEAD - 1)) {
      if (++attempts === (availability === "RPC_TIMEOUT" ? 3 : 1)) exhausted.resolve();
      throw new guard.ExecutionError(availability);
    }
    if (call.method === "eth_getCode" && call.params[1].blockHash === hash(HEAD - 1)) { await gate.promise; return "0x1"; }
  };
  const acquiring = f.acquire().finally(() => { done = true; }), rejected = assert.rejects(acquiring, /TWO_STRICT_CAPABLE_FAMILIES_REQUIRED/);
  await exhausted.promise; await turn(); assert.equal(done, false);
  assert.equal(f.state.calls.slice(before).some(call => call.alias === 0 && call.method === "eth_getCode" && call.params[1].blockHash === hash(HEAD)), false);
  gate.resolve(); await rejected; assert.equal(f.state.active, 0);
  assert.throws(old.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/); await assert.rejects(f.acquire(), /SELECTION_HOLD/);
  f.state.hook = () => undefined; f.advance(5000); await f.ready(); (await f.acquire()).current.assertUsable();
  assert.throws(old.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
});

test("a completed code mismatch survives a later NUMBER availability failure in the same positive stage", async t => {
  const f = fixture(t); await f.ready(); const old = await f.acquire(), gate = deferred(); let done = false;
  const before = f.state.calls.length;
  f.state.hook = async call => {
    if (call.alias !== 0) return;
    if (call.method === "eth_call" && call.params[1].blockHash === hash(HEAD - 1)) { await gate.promise; throw new guard.ExecutionError("PINNED_RPC_FAILED"); }
    if (call.method === "eth_getCode" && call.params[1].blockHash === hash(HEAD)) return "0x6002";
  };
  const acquiring = f.acquire().finally(() => { done = true; }), rejected = assert.rejects(acquiring, /TWO_STRICT_CAPABLE_FAMILIES_REQUIRED/);
  await turn(); assert.equal(done, false);
  assert.equal(f.state.calls.slice(before).filter(call => call.alias === 0 && call.method === "eth_getCode").length, 2);
  gate.resolve(); await rejected; assert.throws(old.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
  assert.equal(f.state.calls.slice(before).some(call => call.alias === 0 && call.params[1]?.blockHash === UNKNOWN), false);
});

for (const stage of ["negative", "canonical"]) test(`strict ${stage} stage retains trust over availability and drains before any pin publication`, async t => {
  const f = fixture(t); await f.ready(); const old = await f.acquire(), gate = deferred();
  let previousReads = 0, done = false; const before = f.state.calls.length;
  f.state.hook = async call => {
    if (call.alias !== 0) return;
    if (stage === "negative" && call.params[1]?.blockHash === UNKNOWN) {
      if (call.method === "eth_call") throw new guard.ExecutionError("PINNED_RPC_FAILED");
      await gate.promise; return "0x6001";
    }
    if (stage === "canonical" && call.method === "eth_getBlockByNumber") {
      if (call.params[0] === hex(HEAD - 1) && ++previousReads === 2) throw new guard.ExecutionError("PINNED_RPC_FAILED");
      if (call.params[0] === hex(HEAD)) { await gate.promise; return { ...header(), stateRoot: hash(99) }; }
    }
  };
  const acquiring = f.acquire().finally(() => { done = true; }), rejected = assert.rejects(acquiring, /TWO_STRICT_CAPABLE_FAMILIES_REQUIRED/);
  await turn(); assert.equal(done, false); old.current.assertUsable();
  assert.equal(f.state.calls.slice(before).filter(call => call.method === "eth_chainId").length, 2);
  gate.resolve(); await rejected; assert.equal(f.state.active, 0); assert.throws(old.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
  await assert.rejects(f.acquire(), /SELECTION_HOLD/);
});

for (const method of ["eth_call", "eth_getCode"]) for (const failure of ["accepted", "malformed", "forged"])
  test(`parallel ${method} negative control cannot qualify ${failure} rejection evidence`, async t => {
    const f = fixture(t); await f.ready(); const gate = deferred(), before = f.state.calls.length;
    f.state.hook = async call => {
      if (call.alias !== 0 || call.params[1]?.blockHash !== UNKNOWN) return;
      await gate.promise;
      if (call.method !== method) return;
      if (failure === "accepted") return method === "eth_call" ? hash(HEAD) : "0x6001";
      if (failure === "malformed") throw new guard.ExecutionError("RPC_FAILED");
      throw Object.assign(new Error("PRIVATE_FORGED_LOOKUP"), { code: "UNKNOWN_BLOCK_REJECTED" });
    };
    const acquiring = f.acquire(), rejected = assert.rejects(acquiring, /TWO_STRICT_CAPABLE_FAMILIES_REQUIRED/);
    await turn();
    const negatives = f.state.calls.slice(before).filter(call => call.alias === 0 && call.params[1]?.blockHash === UNKNOWN);
    assert.deepEqual(negatives.map(call => call.method), ["eth_call", "eth_getCode"]);
    gate.resolve(); await rejected; assert.equal(f.state.active, 0);
    assert.equal(f.state.calls.slice(before).filter(call => call.alias === 0 && call.method === "eth_getBlockByNumber").length, 2,
      "no canonical reread after failed negative evidence");
  });

test("close during parallel positive controls drains all started calls and prevents publication or queued controls", async t => {
  const f = fixture(t); await f.ready(); const gates = [deferred(), deferred()], before = f.state.calls.length;
  f.state.hook = async call => {
    if (call.params[1]?.blockHash === hash(HEAD - 1) && ["eth_call", "eth_getCode"].includes(call.method)) await gates[call.alias].promise;
  };
  const acquiring = f.acquire(), rejected = assert.rejects(acquiring, /TWO_STRICT_CAPABLE_FAMILIES_REQUIRED/);
  await turn(); assert.equal(f.state.active, 4); let closed = false;
  const closing = f.factory.close().then(() => { closed = true; });
  gates[0].resolve(); await turn(); assert.equal(closed, false); assert.equal(f.state.active, 2);
  gates[1].resolve(); await rejected; await closing;
  assert.equal(f.state.active, 0); assert.equal(f.state.calls.slice(before).length, 12);
  await assert.rejects(f.acquire(), /M1_HOT_PATH_CLOSED/);
});

for (const failedRead of ["latest", hex(HEAD)]) test(`v2 prepublication recheck ${failedRead} trust failure outranks a concurrent timeout and cannot publish FUTURE`, async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const startFuture = deferred(), bad = deferred(); let released = false;
  f.state.hook = async call => {
    if (call.method === "eth_getTransactionCount") await startFuture.promise;
    if (!released || call.alias !== 0 || call.method !== "eth_getBlockByNumber") return;
    if (call.params[0] !== failedRead) throw new guard.ExecutionError("RPC_TIMEOUT");
    await bad.promise; return { ...header(), stateRoot: hash(99) };
  };
  const lease = await f.acquire(); released = true; startFuture.resolve(); await turn();
  lease.current.assertUsable(); bad.resolve(); await turn();
  assert.equal(lease.takeFuture(), null); assert.throws(lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
  await assert.rejects(f.acquire(), /SELECTION_HOLD/); assert.equal(f.state.active, 0);
});

for (const scenario of ["mismatched", "expired", "final-pin-changed"]) test(`${scenario} initial headers cannot be reused or relaunched as a FUTURE proof for the final pin`, async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const before = f.state.calls.length, latest = [0, 0], chains = [0, 0];
  if (scenario === "expired") f.advance(11000);
  f.state.hook = call => {
    if (call.method === "eth_getBlockByNumber" && call.params[0] === "latest" && ++latest[call.alias] === 1 && scenario === "mismatched" && call.alias === 1)
      return header(HEAD - 1);
    if (call.method === "eth_chainId" && ++chains[call.alias] === 2 && call.alias === 0 && scenario === "final-pin-changed") f.advance(12000);
  };
  const lease = await f.acquire(); await turn(); lease.current.assertUsable(); assert.equal(lease.takeFuture(), null);
  assert.equal(lease.current.pin.number, scenario === "final-pin-changed" ? HEAD + 1 : HEAD);
  const calls = f.state.calls.slice(before), optionalCalls = calls.filter(call => ["eth_getTransactionCount", "eth_getBalance", "eth_simulateV1"].includes(call.method));
  if (scenario !== "final-pin-changed") assert.equal(optionalCalls.length, 0);
  else for (const call of optionalCalls) assert.ok([hash(HEAD), UNKNOWN].includes(call.params[1].blockHash));
  assert.equal(lease.current.nextBlock, undefined);
});

// Real factory + actual two-round production collector. Delays are real timers,
// not microtask-only mocks; clocks advance by actual monotonic elapsed time.
// This is controlled offline scheduling evidence, not a production latency claim.
for (const staggered of [false, true]) test(`real positive RTT permits already-ready same-pin FUTURE after two collector rounds (staggered=${staggered})`, async t => {
  const { Interface } = require("../node_modules/ethers"), watcher = require("../watch-top-whale-triggers.js");
  const rate = new Interface(["function borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128)) view returns(uint256)"]);
  const f = fixture(t, { allowFuture: true }); await f.ready();
  const started = performance.now(), elapsed = () => Math.floor(performance.now() - started);
  Object.defineProperties(f.state, { now: { get: () => NOW + elapsed() }, mono: { get: elapsed } });
  const W = 10n ** 18n, market = [2000000n * W, 2000000n * W * 1000000n, 1000000n * W - 1n,
    1000000n * W * 1000000n - 1000000n, BigInt(TIME), 0n];
  const position = [0n, (86000n * W - W / 100n) * 1000000n, 100000n * W];
  const collections = [], chains = [0, 0], latest = [0, 0], numbers = [0, 0], finalNumberDone = new Set();
  const before = f.state.calls.length;
  f.state.hook = async call => {
    const collecting = call.method === "eth_call" && call.params[0].data !== transport.PROBE.encodeFunctionData("getBlockNumber");
    const initialHead = call.method === "eth_getBlockByNumber" && call.params[0] === "latest" && ++latest[call.alias] === 1;
    if (call.method === "eth_chainId" && ++chains[call.alias] === 3)
      assert.equal(finalNumberDone.size, 2, "freshness proof follows both final immutable-pin NUMBER checks");
    await new Promise(resolve => setTimeout(resolve, 15 + (staggered && initialHead && call.alias === 1 ? 35 : 0)));
    if (call.method === "eth_call" && !collecting && call.params[1].blockHash === hash(HEAD) && ++numbers[call.alias] === 2) finalNumberDone.add(call.alias);
    if (!collecting) return;
    const rows = m1.MULTI_IFACE.decodeFunctionData("aggregate3", call.params[0].data)[0];
    collections.push({ alias: call.alias, rows: rows.length, ref: call.params[1] });
    return m1.MULTI_IFACE.encodeFunctionResult("aggregate3", [rows.map((row, i) => {
      if (rows.length === 1) {
        assert.deepEqual([...rate.decodeFunctionData("borrowRateView", row.callData)[1]], market);
        return { success: true, returnData: rate.encodeFunctionResult("borrowRateView", [100000000000n]) };
      }
      const name = ["market", "position", "price"][i]; assert.equal(rows.length, 3);
      m1.STATE_IFACE.decodeFunctionData(name, row.callData);
      return { success: true, returnData: m1.STATE_IFACE.encodeFunctionResult(name, [market, position, [10n ** 36n]][i]) };
    })]);
  };
  const lease = await f.acquire(), immutable = JSON.stringify(lease.current);
  const collect = nextBlockContext => watcher.checkOnce({ ...lease.current.collectorOptions, m1Only: true,
    pin: { ...lease.current.pin, chainId: 1 }, now: () => f.state.now, nextBlockContext });
  const current = await collect(null);
  assert.equal(current.targets[m1.ID].liquidatableNow, false); assert.equal(current.targets[m1.ID].nextBlockForecast, undefined);
  assert.deepEqual(collections.map(call => call.rows), [3, 3, 1, 1]);
  const callsAtTake = f.state.calls.length, future = lease.takeFuture(); // No wait/turn/retry at take.
  assert.ok(future); assert.equal(future.then, undefined); assert.equal(f.state.calls.length, callsAtTake);
  assert.equal(future.pin, lease.current.pin); assert.equal(future.nextBlock.context.parentHash, lease.current.pin.hash);
  assert.equal(future.nextBlock.context.parentTimestamp, lease.current.pin.timestamp); assert.equal(lease.takeFuture(), null);
  assert.equal(JSON.stringify(lease.current), immutable); assert.equal(lease.current.nextBlock, undefined);
  const forecast = await collect(future.nextBlock.context);
  assert.ok(forecast.targets[m1.ID].nextBlockForecast); assert.deepEqual(collections.map(call => call.rows), [3, 3, 1, 1, 3, 3, 1, 1]);
  assert.ok(collections.every(call => call.ref.blockHash === lease.current.pin.hash && call.ref.requireCanonical));
  const controls = f.state.calls.slice(before).filter(call => call.method === "eth_simulateV1");
  assert.equal(controls.length, 6); assert.ok(f.state.now > NOW);
  for (const alias of [0, 1]) assert.deepEqual(controls.filter(call => call.alias === alias).map(call => call.params[1].blockHash), [hash(HEAD), hash(HEAD), UNKNOWN]);
  lease.cancelFuture(); assert.throws(future.assertUsable, /NEXT_BLOCK_EVIDENCE_INVALIDATED/); lease.current.assertUsable();
});

async function httpPrepublicationFixture(t) {
  const candidates = [0, 1].map(i => ({ family: `OFFLINE_FAMILY_${i}`, handle: `OFFLINE_HANDLE_${i}` }));
  const startFuture = deferred(), gates = [], events = [];
  const state = { phase: "pool", active: 0, calls: [], hook: async () => undefined };
  t.mock.method(globalThis, "fetch", async (handle, options) => {
    const { method, params } = JSON.parse(options.body), alias = candidates.findIndex(c => c.handle === handle);
    assert.ok(alias >= 0);
    const call = { alias, method, params, phase: state.phase, completed: false }; state.calls.push(call); state.active++;
    const response = body => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }));
    try {
      if (method === "eth_getTransactionCount") await startFuture.promise;
      const changed = await state.hook(call); if (changed !== undefined) return response({ result: changed });
      if (["eth_call", "eth_getCode", "eth_simulateV1"].includes(method) && params[1].blockHash === UNKNOWN)
        return response({ error: { code: -32000, message: "header not found" } });
      let result;
      if (method === "eth_chainId") result = "0x1";
      else if (method === "eth_getBlockByNumber") result = header(params[0] === "latest" ? HEAD : Number(BigInt(params[0])));
      else if (method === "eth_call") result = hash(BigInt(params[1].blockHash));
      else if (method === "eth_getCode") result = "0x600160ab";
      else if (method === "eth_getTransactionCount") result = "0x7";
      else if (method === "eth_getBalance") result = hex(2000000000000000n);
      else if (method === "eth_simulateV1") result = simulation(params);
      else if (method === "eth_sendRawTransaction") result = keccak256(params[0]);
      else assert.fail("UNPLANNED_OFFLINE_HTTP_METHOD");
      return response({ result });
    } finally { call.completed = true; state.active--; }
  });
  const factory = transport.createM1HotPathFactory({ rpc: transport.httpRpc, now: () => NOW, monotonic: () => 0,
    allowFuture: true, onTiming: event => events.push(event) });
  t.after(async () => { startFuture.resolve(); gates.forEach(gate => gate.resolve()); await factory.close(); });
  let status = factory.maintain({ candidates });
  for (let i = 0; status.selection !== "READY" && i < 50; i++) { await turn(); status = factory.maintain({ candidates }); }
  assert.equal(status.selection, "READY"); state.phase = "acquire";
  const lease = await factory.acquire({ candidates }); lease.current.assertUsable();
  return { candidates, factory, lease, state, events,
    gate() { const gate = deferred(); gates.push(gate); return gate; },
    start() { state.phase = "child"; startFuture.resolve(); } };
}

for (const benignFirst of [false, true]) test(`real factory/httpRpc revokes published CURRENT before optional prepublication siblings drain (benignFirst=${benignFirst})`, async t => {
  const f = await httpPrepublicationFixture(t), bad = f.gate(), held = f.gate();
  f.state.hook = async call => {
    if (call.phase !== "child" || call.method !== "eth_getBlockByNumber") return;
    if (call.alias === 0 && call.params[0] === hex(HEAD)) {
      await bad.promise; return { ...header(), stateRoot: hash(99) }; // Valid shape; contradictory immutable parent.
    }
    if (call.params[0] === "latest") {
      if (call.alias === 0 && benignFirst) throw new guard.ExecutionError("RPC_TIMEOUT");
      if (call.alias === (benignFirst ? 1 : 0)) await held.promise;
    }
  };
  f.start(); await turn();
  const headers = f.state.calls.filter(call => call.phase === "child" && call.method === "eth_getBlockByNumber");
  assert.equal(headers.length, 4);
  const outstanding = headers.find(call => call.alias === (benignFirst ? 1 : 0) && call.params[0] === "latest");
  assert.equal(outstanding.completed, false);
  if (!benignFirst) assert.ok(headers.filter(call => call.alias === 1).every(call => call.completed), "other witness completed before contradiction");
  else assert.equal(headers.find(call => call.alias === 0 && call.params[0] === "latest").completed, true, "benign timeout arrived first");
  f.lease.current.assertUsable(); // No contradiction has been observed yet.
  bad.resolve(); await turn();
  assert.equal(outstanding.completed, false); assert.equal(f.state.active, 1);
  assert.throws(f.lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/, "revoke NOW, not after the held sibling");
  f.lease.cancelFuture();
  assert.throws(f.lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/, "cancellation cannot erase observed parent distrust");
  const dispatched = await Promise.allSettled([
    Promise.resolve().then(() => f.lease.current.send("0x010203")),
    transport.httpRpc(f.candidates[1], "eth_sendRawTransaction", ["0x010203"], 1000, f.lease.current.assertUsable),
  ]);
  assert.deepEqual(dispatched.map(row => [row.status, row.reason?.code]), [
    ["rejected", "PIN_EVIDENCE_INVALIDATED"], ["rejected", "PIN_EVIDENCE_INVALIDATED"],
  ]);
  assert.equal(f.state.calls.filter(call => call.method === "eth_sendRawTransaction").length, 0, "neither guarded send reaches mocked fetch");
  assert.equal(f.factory.maintain({ candidates: f.candidates }).selection, "HOLD");
  assert.equal(f.events.filter(event => event.phase === "futureQualification" && event.edge === "end").length, 0,
    "optional aggregate remains pending until every started read drains");
  let closed = false;
  const closing = f.factory.close().then(() => { closed = true; }); await turn(); assert.equal(closed, false);
  assert.equal(outstanding.completed, false); held.resolve(); await closing;
  assert.equal(outstanding.completed, true); assert.equal(f.state.active, 0);
  assert.equal(f.events.filter(event => event.phase === "futureQualification" && event.edge === "end").length, 1);
  assert.equal(f.lease.takeFuture(), null); assert.throws(f.lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
});

for (const late of [false, true]) test(`readiness subscription is bounded, zero-argument, one-shot, non-consuming and late-subscriber correct (${late})`, async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const gate = deferred();
  f.state.hook = async call => { if (call.method === "eth_getTransactionCount") await gate.promise; };
  const lease = await f.acquire(); let notifications = 0;
  assert.equal(lease.isFutureReady(), false);
  if (late) { gate.resolve(); await turn(); assert.equal(lease.isFutureReady(), true); }
  const unsubscribe = lease.onFutureReady((...args) => { notifications++; assert.deepEqual(args, []); return Promise.reject(new Error("PRIVATE_WAKE")); });
  assert.equal(notifications, 0, "never invoke an observer inline with publication/subscription");
  assert.throws(() => lease.onFutureReady(() => {}), /M1_FUTURE_SUBSCRIPTION_EXISTS/);
  assert.throws(() => lease.onFutureReady(1), /M1_FUTURE_SUBSCRIPTION_INVALID/);
  gate.resolve(); await turn(); await turn();
  assert.equal(notifications, 1); assert.equal(lease.isFutureReady(), true);
  unsubscribe(); unsubscribe(); lease.onFutureReady(() => { notifications++; }); await turn();
  assert.equal(notifications, 1); const future = lease.takeFuture(); assert.ok(future); assert.equal(lease.isFutureReady(), false);
  assert.equal(lease.takeFuture(), null); lease.cancelFuture(); lease.current.assertUsable();
});

test("unsubscribe before publication permits one replacement subscriber without overlapping optional work", async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const gate = deferred();
  f.state.hook = async call => { if (call.method === "eth_getTransactionCount") await gate.promise; };
  const lease = await f.acquire(); let old = 0, replacement = 0;
  const unsubscribe = lease.onFutureReady(() => { old++; }); unsubscribe();
  lease.onFutureReady(() => { replacement++; throw new Error("PRIVATE_WAKE_THROW"); });
  gate.resolve(); await turn(); await turn(); assert.equal(old, 0); assert.equal(replacement, 1);
  assert.equal(f.state.calls.filter(call => call.method === "eth_getTransactionCount").length, 2);
  assert.ok(lease.takeFuture());
});

for (const invalidation of ["cancel", "close", "inventory", "trust", "expiry", "supersession"])
  test(`pending readiness cannot survive ${invalidation} or publish a delayed facade`, async t => {
    const f = fixture(t, { allowFuture: true }); await f.ready(); const gate = deferred(); let closing;
    f.state.hook = async call => { if (call.method === "eth_getTransactionCount") await gate.promise; };
    const lease = await f.acquire(); let notifications = 0;
    lease.onFutureReady(() => { notifications++; });
    if (invalidation === "cancel") lease.cancelFuture();
    if (invalidation === "close") closing = f.factory.close();
    if (invalidation === "inventory") { f.candidates[0].family += "_CHANGED"; f.maintain(); }
    if (invalidation === "trust") {
      f.state.hook = async call => { if (call.method === "eth_getTransactionCount") await gate.promise;
        if (call.alias === 1 && call.method === "eth_getCode") return "0x6002"; };
      await assert.rejects(lease.current.code("0x" + "11".repeat(20)), /PROVIDER_RESULT_DISAGREEMENT/);
    }
    if (invalidation === "expiry") f.advance(11000);
    if (invalidation === "supersession") {
      const next = await f.acquire(); next.current.assertUsable();
      assert.equal(f.state.calls.filter(call => call.method === "eth_getTransactionCount").length, 2);
    }
    gate.resolve(); await closing; await turn(); await turn();
    assert.equal(notifications, 0); assert.equal(lease.isFutureReady(), false); assert.equal(lease.takeFuture(), null);
  });

test("ready facade notification queued before cancellation is suppressed; supersession also clears a completed child's latch", async t => {
  const f = fixture(t, { allowFuture: true }); await f.ready(); const first = await f.acquire(); await turn();
  assert.equal(first.isFutureReady(), true); let notifications = 0;
  first.onFutureReady(() => { notifications++; }); first.cancelFuture(); await turn(); assert.equal(notifications, 0);
  const second = await f.acquire(); await turn(); assert.equal(second.isFutureReady(), true);
  const third = await f.acquire(); assert.equal(second.isFutureReady(), false); assert.equal(second.takeFuture(), null); third.current.assertUsable();
});

function recoveryTimers(t) {
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => timer(fn, ms === 4000 ? 5 : ms === 150 ? 0 : ms, ...args));
}
async function acquisitionError(f) {
  try { await f.acquire(); assert.fail("ACQUISITION_MUST_REJECT"); }
  catch (error) { assert.ok(error instanceof guard.ExecutionError); assert.equal(error.message, error.code); return error; }
}
test("rank1 retirement API is explicit and leaves the default factory shape unchanged", async t => {
  const legacy = fixture(t), opted = fixture(t, { rank1AcquisitionRecovery: true });
  assert.deepEqual(Object.keys(legacy.factory), ["maintain", "acquire", "close"]);
  assert.deepEqual(Object.keys(opted.factory), ["maintain", "acquire", "close", "retireFailedAcquisition"]);
  for (const value of [null, 1, "true", {}]) assert.throws(() => transport.createM1HotPathFactory({ rpc: legacy.rpc, rank1AcquisitionRecovery: value }), /M1_HOT_PATH_OPTIONS_INVALID/);
  const first = await acquisitionError(opted), second = await acquisitionError(opted);
  assert.notEqual(first, second); assert.equal(first.code, "M1_HOT_PATH_SELECTION_HOLD"); assert.equal(opted.state.calls.length, 0);
  await assert.rejects(opted.factory.retireFailedAcquisition(first), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
});

for (const failure of ["valid", "chain", "hash", "disagreement"]) for (const badFirst of [false, true])
  test(`rank1 retirement drains timed-out physical and semantic work: ${failure}, first=${badFirst}`, async t => {
    const gates = [deferred(), deferred()], allStarted = deferred(); let started = 0, done = false;
    t.after(() => gates.forEach(gate => gate.resolve()));
    const f = fixture(t, { rank1AcquisitionRecovery: true }); await f.ready(); recoveryTimers(t);
    f.state.hook = async call => {
      const target = failure === "hash" ? call.method === "eth_getBlockByNumber" && call.params[0] === hex(HEAD - 1) :
        failure === "disagreement" ? call.method === "eth_getCode" && call.params[1].blockHash === hash(HEAD - 1) : call.method === "eth_chainId";
      if (!target) return;
      if (++started === 6) allStarted.resolve(); await gates[call.alias].promise;
      if (call.alias === 0 && failure === "chain") return "0x2";
      if (call.alias === 0 && failure === "hash") return { ...header(HEAD - 1), hash: hash(888) };
      if (call.alias === 0 && failure === "disagreement") return "0x6002";
    };
    const pending = acquisitionError(f).then(error => { done = true; return error; });
    await allStarted.promise; await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(done, false); assert.equal(f.state.active, 6);
    const count = f.state.calls.length; gates[badFirst ? 0 : 1].resolve(); await turn();
    assert.equal(done, false); assert.equal(f.state.active, 3);
    gates[badFirst ? 1 : 0].resolve(); const error = await pending;
    assert.equal(error.code, "TWO_STRICT_CAPABLE_FAMILIES_REQUIRED");
    if (failure === "valid") assert.equal(await f.factory.retireFailedAcquisition(error), true);
    else await assert.rejects(f.factory.retireFailedAcquisition(error), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
    assert.equal(f.state.active, 0); assert.equal(f.state.calls.length, count);
    assert.throws(f.maintain, /M1_HOT_PATH_CLOSED/); await assert.rejects(f.acquire(), /M1_HOT_PATH_CLOSED/);
    await assert.rejects(f.factory.retireFailedAcquisition(error), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
  });

for (const code of ["RPC_FAILED", "PINNED_RPC_FAILED", "M1_HOT_PATH_CANCELLED", "M1_HOT_PATH_BUDGET", "PRIVATE_UNKNOWN"])
  test(`rank1 retirement never promotes an issued but ineligible ${code}`, async t => {
    const f = fixture(t, { rank1AcquisitionRecovery: true }); await f.ready();
    f.state.hook = () => { if (code === "PRIVATE_UNKNOWN") throw new Error("PRIVATE_UNKNOWN_DETAIL"); throw new guard.ExecutionError(code); };
    const error = await acquisitionError(f);
    assert.doesNotMatch(JSON.stringify(error) + error.stack, /PRIVATE_UNKNOWN_DETAIL/);
    await assert.rejects(f.factory.retireFailedAcquisition(error), /RANK1_ACQUISITION_RETIREMENT_DENIED/); assert.equal(f.state.active, 0);
  });

for (const hard of [false, true]) test(`rank1 retirement drains late optional work without forgetting hard=${hard}`, async t => {
  const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
  const f = fixture(t, { rank1AcquisitionRecovery: true, allowFuture: true }); await f.ready(); recoveryTimers(t);
  f.state.hook = async call => {
    if (call.method === "eth_getTransactionCount") {
      entered.resolve(); await gate.promise;
      if (hard && call.alias === 0) return "0x8";
    }
    if (call.method === "eth_call" && call.params[1].blockHash === hash(HEAD - 1)) throw new guard.ExecutionError("RPC_TIMEOUT");
  };
  const pending = acquisitionError(f); await entered.promise; const error = await pending;
  let done = false;
  const retiring = f.factory.retireFailedAcquisition(error).finally(() => { done = true; });
  const checked = hard ? assert.rejects(retiring, /RANK1_ACQUISITION_RETIREMENT_DENIED/) : retiring;
  await turn(); assert.equal(done, false); assert.ok(f.state.active > 0); const calls = f.state.calls.length;
  gate.resolve(); const result = await checked;
  if (!hard) assert.equal(result, true);
  assert.equal(f.state.active, 0); assert.equal(f.state.calls.length, calls);
});

for (const hard of [false, true]) test(`rank1 retirement drains a stopped refresh and retains late hard=${hard}`, async t => {
  const gate = deferred(), entered = deferred(); let refresh = true, starts = 0;
  t.after(() => gate.resolve());
  const f = fixture(t, { rank1AcquisitionRecovery: true }); await f.ready(); recoveryTimers(t); f.advance(30000);
  f.state.hook = async call => {
    if (refresh && call.method === "eth_chainId") {
      if (++starts === 2) entered.resolve(); await gate.promise;
      if (hard && call.alias === 0) return "0x2";
    }
    if (!refresh && call.method === "eth_call") throw new guard.ExecutionError("RPC_TRANSPORT_ERROR");
  };
  f.maintain(); await entered.promise; refresh = false;
  const error = await acquisitionError(f); let done = false;
  const retiring = f.factory.retireFailedAcquisition(error).finally(() => { done = true; });
  const checked = hard ? assert.rejects(retiring, /RANK1_ACQUISITION_RETIREMENT_DENIED/) : retiring;
  await turn(); assert.equal(done, false); assert.ok(f.state.active > 0); const count = f.state.calls.length;
  gate.resolve(); const result = await checked; if (!hard) assert.equal(result, true);
  assert.equal(f.state.active, 0); assert.equal(f.state.calls.length, count);
});

test("selection policy is explicit; default M1 retains its API and performs no hint requests", async t => {
  const f = fixture(t); await f.ready(); await f.acquire();
  assert.deepEqual(Object.keys(f.factory), ["maintain", "acquire", "close"]);
  assert.equal(f.state.calls.some(row => ["debug_traceCall", "eth_simulateV1"].includes(row.method)), false);
  for (const selectionPolicy of [null, true, false, "fresh", {}, "rank1-prefer-dual "])
    assert.throws(() => transport.createM1HotPathFactory({ rpc: f.rpc, selectionPolicy }), /M1_HOT_PATH_OPTIONS_INVALID/);
});

test("selection hints cannot admit before the entire strict pool or gate fallback admission afterwards", async t => {
  const strict = deferred(), hint = deferred(); t.after(() => { strict.resolve(); hint.resolve(); });
  const f = fixture(t, { selectionPolicy: "rank1-prefer-dual", count: 6 });
  const strictEntered = deferred(), hintEntered = deferred();
  f.state.hook = async row => {
    if (row.alias === 5 && row.method === "eth_getCode" && row.params[1].blockHash === UNKNOWN) { strictEntered.resolve(); await strict.promise; }
    if (row.method === "debug_traceCall") { hintEntered.resolve(); await hint.promise; throw new guard.ExecutionError("TRACE_METHOD_UNAVAILABLE"); }
  };
  f.maintain(); await strictEntered.promise;
  assert.equal(f.maintain().selection, "HOLD"); assert.equal(f.state.calls.some(row => row.method === "debug_traceCall"), false);
  await assert.rejects(f.acquire(), /M1_HOT_PATH_SELECTION_HOLD/);
  strict.resolve(); await hintEntered.promise;
  assert.equal(f.maintain().selection, "READY");
  const fallback = await f.acquire(); assert.deepEqual(fallback.current.evidence.aliases, [1, 2]);
  assert.equal(f.state.calls.filter(row => row.method === "debug_traceCall").length, 2);
  hint.resolve(); await turn();
  assert.deepEqual([...new Set(f.state.calls.filter(row => row.method === "debug_traceCall").map(row => row.alias))].sort(), [0, 1, 2, 3, 4, 5]);
  fallback.current.assertUsable(); assert.equal(f.state.active, 0);
});

function pollingReceipt() {
  return { transactionHash: hash(999), blockHash: hash(HEAD), blockNumber: hex(HEAD), transactionIndex: "0x0", status: "0x1",
    from: guard.MAIN_ACCOUNT.toLowerCase(), to: TX.to, gasUsed: hex(80000), effectiveGasPrice: hex(100000001), logs: [] };
}
for (const recovery of [false, true]) test(`CURRENT polling accepts corroborated receipt and pending nonce progression, recovery=${recovery}`, async t => {
  const f = fixture(t, { rank1AcquisitionRecovery: recovery }); await f.ready(); const lease = await f.acquire();
  let mined = false, nonce = "0x7";
  f.state.hook = row => row.method === "eth_getTransactionReceipt" ? mined ? pollingReceipt() : null :
    row.method === "eth_getTransactionCount" ? nonce : undefined;
  assert.equal(await lease.current.receipt(hash(999)), null); assert.equal(await lease.current.nonce(guard.MAIN_ACCOUNT), "0x7");
  mined = true; nonce = "0x8";
  assert.deepEqual(await lease.current.receipt(hash(999)), pollingReceipt());
  assert.equal(await lease.current.nonce(guard.MAIN_ACCOUNT), "0x8");
  assert.deepEqual(await lease.current.receipt(hash(999)), pollingReceipt()); lease.current.assertUsable();
});

for (const mismatch of ["receipt-null", "receipt-fields", "nonce"])
  test(`recovery CURRENT polling still rejects per-invocation witness disagreement: ${mismatch}`, async t => {
    const f = fixture(t, { rank1AcquisitionRecovery: true }); await f.ready(); const lease = await f.acquire();
    let changed = false;
    f.state.hook = row => {
      if (row.method === "eth_getTransactionReceipt") {
        if (!changed) return null;
        return row.alias === 0 ? pollingReceipt() : mismatch === "receipt-null" ? null : { ...pollingReceipt(), gasUsed: hex(80001) };
      }
      if (row.method === "eth_getTransactionCount") return changed ? hex(8 + row.alias) : "0x7";
    };
    const poll = () => mismatch === "nonce" ? lease.current.nonce(guard.MAIN_ACCOUNT) : lease.current.receipt(hash(999));
    await poll(); changed = true;
    await assert.rejects(poll(), /PROVIDER_RESULT_DISAGREEMENT/); assert.throws(lease.current.assertUsable, /PIN_EVIDENCE_INVALIDATED/);
  });

for (const fact of ["feed", "runtime", "estimate", "fee-header"])
  test(`recovery polling exemption does not weaken fixed-pin ${fact} facts`, async t => {
    const f = fixture(t, { rank1AcquisitionRecovery: true }); await f.ready(); const lease = await f.acquire();
    let changed = false;
    f.state.hook = row => {
      if (fact === "feed" && row.method === "eth_call" && row.params[0].to === TX.to) return changed ? "0xabcd" : "0x1234";
      if (fact === "runtime" && row.method === "eth_getCode" && row.params[0] === TX.to) return changed ? "0x6002" : "0x6001";
      if (fact === "estimate" && row.method === "eth_estimateGas") return hex(changed ? 80001 : 80000);
      if (fact === "fee-header" && changed && row.method === "eth_getBlockByNumber") return { ...header(HEAD), baseFeePerGas: hex(100000001) };
    };
    const read = () => fact === "feed" ? lease.current.call({ to: TX.to, data: "0x1234" }) : fact === "runtime" ? lease.current.code(TX.to) :
      fact === "estimate" ? lease.current.estimateGas(TX) : lease.current.recheck();
    await read(); changed = true; await assert.rejects(read()); assert.throws(lease.current.assertUsable);
  });

test("late prepublication FUTURE parent-trust failure still revokes CURRENT after successful volatile polls", async t => {
  const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
  const f = fixture(t, { rank1AcquisitionRecovery: true, allowFuture: true }); await f.ready();
  let nonce = "0x7";
  f.state.hook = async row => {
    if (row.method === "eth_simulateV1") {
      entered.resolve(); await gate.promise;
      if (row.alias === 0) throw new guard.ExecutionError("NEXT_BLOCK_PARENT_CHANGED");
    }
    if (row.method === "eth_getTransactionCount" && row.params[1] === "pending") return nonce;
    if (row.method === "eth_getTransactionReceipt") return null;
  };
  const acquiring = f.acquire(); await entered.promise; const lease = await acquiring;
  assert.equal(await lease.current.receipt(hash(999)), null);
  assert.equal(await lease.current.nonce(guard.MAIN_ACCOUNT), "0x7"); nonce = "0x8";
  assert.equal(await lease.current.nonce(guard.MAIN_ACCOUNT), "0x8"); lease.current.assertUsable();
  gate.resolve(); await turn(); assert.throws(lease.current.assertUsable); assert.equal(f.state.active, 0);
});
