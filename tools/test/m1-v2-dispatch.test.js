"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { createM1HotPathFactory, createPinnedRpc, httpRpc, MULTICALL3 } = require("../lib/executor-pinned-rpc.js");
const shared = require("../shared-rpc.js");
const { keccak256 } = require("../node_modules/ethers");
const NOW = Date.parse("2026-10-24T02:00:01Z"), HEAD = 1000, TIME = NOW / 1000 - 1;
const SIGNED = "0x020102030405", UNKNOWN = "0x" + "f".repeat(64);
const hex = n => "0x" + BigInt(n).toString(16), hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const turn = () => new Promise(resolve => setImmediate(resolve));
function header(number = HEAD) {
  return { number: hex(number), hash: hash(number), parentHash: hash(number - 1), stateRoot: hash(7),
    timestamp: hex(TIME + (number - HEAD) * 12), baseFeePerGas: hex(100000000), gasLimit: hex(30000000) };
}
async function fixture(t, { future = false, mode = "fresh" } = {}) {
  const candidates = [0, 1].map(i => ({ family: `synthetic-family-${i}`, handle: `https://synthetic-${i}.invalid/rpc` }));
  const state = { now: NOW, mono: 0, sends: [], prepared: false, inHttpSend: false, originHook: null, bodyHook: null,
    configuration: Object.freeze({}), wrongChain: false, failSend: false };
  const stringify = JSON.stringify;
  t.mock.method(JSON, "stringify", function (value, ...args) {
    if (value?.method === "eth_sendRawTransaction") { state.prepared = true; state.bodyHook?.(); }
    return stringify.call(this, value, ...args);
  });
  t.mock.method(shared, "getOrigin", () => {
    if (!state.inHttpSend) return null;
    state.prepared = true; return state.originHook ? state.originHook() : null;
  });
  t.mock.method(globalThis, "fetch", async (handle, options) => {
    assert.ok(candidates.some(c => c.handle === handle));
    assert.equal(options.redirect, "error");
    const body = JSON.parse(options.body), { method, params } = body;
    let result, error;
    if (method === "eth_sendRawTransaction") {
      state.sends.push({ handle, body: options.body, signed: params[0] });
      if (state.failSend) return new Response("", { status: 503 });
      result = keccak256(params[0]);
    } else if (method === "eth_chainId") result = state.wrongChain ? "0x2" : "0x1";
    else if (method === "eth_getBlockByNumber") result = header(params[0] === "latest" ? HEAD : Number(BigInt(params[0])));
    else if (["eth_call", "eth_getCode", "eth_simulateV1"].includes(method) && params[1].blockHash === UNKNOWN)
      error = { code: -32000, message: "unknown block" };
    else if (method === "eth_call") { assert.equal(params[0].to, MULTICALL3); result = hash(BigInt(params[1].blockHash)); }
    else if (method === "eth_getCode") result = "0x6001";
    else if (method === "eth_getTransactionCount") result = "0x7";
    else if (method === "eth_getBalance") result = hex(2000000000000000n);
    else if (method === "eth_simulateV1") {
      const block = params[0].blockStateCalls[0], tx = block.calls[0];
      result = [{ parentHash: params[1].blockHash, number: block.blockOverrides.number, timestamp: block.blockOverrides.time,
        transactions: [structuredClone(tx)], calls: [{ status: "0x1", gasUsed: hex(80000), logs: [],
          returnData: hash(BigInt(block.blockOverrides.number)) + hash(BigInt(block.blockOverrides.time)).slice(2) }] }];
    } else assert.fail("UNEXPECTED_SYNTHETIC_METHOD");
    return new Response(stringify({ jsonrpc: "2.0", id: 1, ...(error ? { error } : { result }) }));
  });
  const rpc = (...args) => {
    // Observe only httpRpc's synchronous options/Origin preparation. Forward
    // the private fifth-argument guard unchanged to its actual fetch boundary.
    state.inHttpSend = args[1] === "eth_sendRawTransaction";
    try { return httpRpc(...args); } finally { state.inHttpSend = false; }
  };
  const factory = createM1HotPathFactory({ rpc, now: () => state.now, monotonic: () => state.mono,
    allowFuture: future, qualificationMode: mode,
    resolveOrigin: handle => shared.getOrigin(handle),
    getCapabilityContext: () => ({ rpc: httpRpc, fetch: globalThis.fetch, configuration: state.configuration, inventoryRevision: 1 }) });
  t.after(() => factory.close());
  factory.maintain({ candidates }); await turn();
  assert.equal(factory.maintain({ candidates }).selection, "READY");
  const lease = await factory.acquire({ candidates }); await turn();
  const facade = future ? lease.takeFuture() : lease.current;
  assert.ok(facade); assert.ok(Object.isFrozen(facade)); assert.equal(state.sends.length, 0);
  const advance = ms => { state.now += ms; state.mono += ms; };
  return { state, factory, candidates, lease, facade, advance };
}

for (const mode of ["fresh", "capability-v1"]) for (const future of [false, true]) {
  const lane = `${mode}/${future ? "FUTURE" : "CURRENT"}`;
  for (const phase of ["Origin", "body/options"]) test(`${lane}: 2000-to-1999 reserve drop during ${phase} preparation blocks physical fetch`, async t => {
    const f = await fixture(t, { future, mode }), deadline = f.state.now + 2000, observed = [];
    const drop = () => { f.state.prepared = true; f.advance(1); return null; };
    if (phase === "Origin") f.state.originHook = drop;
    else f.state.bodyHook = drop;
    const pending = f.facade.send(SIGNED, () => {
      observed.push(deadline - f.state.now);
      assert.ok(deadline - f.state.now >= 2000, "SYNTHETIC_RESERVE_EXHAUSTED");
    });
    assert.ok(observed.length >= 1); assert.equal(observed[0], 2000, "eager assertion runs synchronously");
    await assert.rejects(pending, error => {
      assert.equal(error.code, "PINNED_RPC_FAILED"); assert.doesNotMatch(error.message, /SYNTHETIC_RESERVE/); return true;
    });
    assert.ok(observed.includes(1999)); assert.equal(f.state.sends.length, 0); f.facade.assertUsable();
  });

  test(`${lane}: absent and valid synchronous guards retain identical bytes and one physical attempt`, async t => {
    const f = await fixture(t, { future, mode });
    assert.equal(await f.facade.send(SIGNED), keccak256(SIGNED)); assert.equal(f.state.sends.length, 1);
    f.state.prepared = false; const checks = [];
    const pending = f.facade.send(SIGNED, () => { checks.push(f.state.prepared); });
    assert.ok(checks.length > 0); assert.equal(checks[0], false); assert.equal(f.state.sends.length, 1);
    assert.equal(await pending, keccak256(SIGNED)); assert.ok(checks.includes(true));
    assert.equal(f.state.sends.length, 2); assert.deepEqual(f.state.sends.map(row => row.signed), [SIGNED, SIGNED]);
    assert.equal(f.state.sends[0].body, f.state.sends[1].body);
    f.state.failSend = true; await assert.rejects(f.facade.send(SIGNED, () => {}));
    assert.equal(f.state.sends.length, 3, "failed physical send does not retry or switch providers");
    assert.ok(f.state.sends.every(row => row.handle === f.state.sends[0].handle));
  });

  test(`${lane}: existing parent trust revocation cannot be overridden by an additional assertion`, async t => {
    const f = await fixture(t, { future, mode }); f.state.wrongChain = true;
    await assert.rejects(f.lease.current.recheck()); f.state.wrongChain = false;
    let checked = false;
    await assert.rejects(f.facade.send(SIGNED, () => { checked = true; }));
    assert.equal(checked, false); assert.equal(f.state.sends.length, 0);
  });

  test(`${lane}: callback-induced clock/trust mutation is rechecked before fetch`, async t => {
    const f = await fixture(t, { future, mode }); let changed = false;
    await assert.rejects(f.facade.send(SIGNED, () => {
      if (!f.state.prepared) return;
      changed = true;
      if (future) f.advance(11000); else f.candidates[0].family = "changed-synthetic-family";
    }));
    assert.equal(changed, true); assert.equal(f.state.sends.length, 0); assert.throws(f.facade.assertUsable);
    if (future) f.lease.current.assertUsable();
  });
}

for (const future of [false, true]) for (const failure of ["throw", "async-resolve", "async-reject", "value"])
  test(`${future ? "FUTURE" : "CURRENT"}: late ${failure} assertion is sanitized, contained and never dispatched`, async t => {
    const f = await fixture(t, { future }); let late = false;
    await assert.rejects(f.facade.send(SIGNED, () => {
      if (!f.state.prepared) return;
      late = true;
      if (failure === "throw") throw new Error("UNTRUSTED_CALLBACK_DETAIL");
      if (failure === "async-resolve") return Promise.resolve();
      if (failure === "async-reject") return Promise.reject(new Error("UNTRUSTED_CALLBACK_DETAIL"));
      return true;
    }), { code: "PINNED_RPC_FAILED" });
    await turn(); assert.equal(late, true); assert.equal(f.state.sends.length, 0); f.facade.assertUsable();
  });

for (const future of [false, true]) test(`${future ? "FUTURE" : "CURRENT"}: supplied nonfunctions and eager nonundefined returns fail before HTTP preparation`, async t => {
  const f = await fixture(t, { future });
  for (const guard of [null, false, 0, "", {}, () => null, () => false, () => 0, () => "", () => ({}), async () => {},
    () => { throw new Error("UNTRUSTED_CALLBACK_DETAIL"); }, () => Promise.reject(new Error("UNTRUSTED_CALLBACK_DETAIL"))]) {
    await assert.rejects(f.facade.send(SIGNED, guard), { code: "PIN_EVIDENCE_INVALIDATED" });
    assert.equal(f.state.prepared, false); assert.equal(f.state.sends.length, 0);
  }
  await turn(); f.facade.assertUsable();
});

for (const future of [false, true]) test(`capability-v1/${future ? "FUTURE" : "CURRENT"}: additional callback cannot replace frozen configuration guard`, async t => {
  const f = await fixture(t, { future, mode: "capability-v1" }); let changed = false;
  await assert.rejects(f.facade.send(SIGNED, () => {
    if (f.state.prepared) { changed = true; f.state.configuration = Object.freeze({}); }
  }));
  assert.equal(changed, true); assert.equal(f.state.sends.length, 0); assert.throws(f.facade.assertUsable);
});

test("capability physical metadata check remains privately marked even with an additional assertion", async t => {
  const f = await fixture(t, { mode: "capability-v1" }); let called = false;
  // A physical HTTP Origin differing from certificate metadata cannot be
  // authorized by a successful additional callback, even if later lookups agree.
  f.state.originHook = () => "https://changed-synthetic-origin.invalid";
  await assert.rejects(f.facade.send(SIGNED, () => { called = true; }));
  assert.equal(called, true); assert.equal(f.state.sends.length, 0); assert.throws(f.facade.assertUsable);
});

test("secondary public httpRpc fifth-argument reserve assertion runs after body preparation", async t => {
  const f = await fixture(t), deadline = f.state.now + 2000;
  f.state.bodyHook = () => f.advance(1);
  await assert.rejects(httpRpc(f.candidates[1], "eth_sendRawTransaction", [SIGNED], 4000, () => {
    assert.ok(deadline - f.state.now >= 2000);
  }), { code: "PIN_EVIDENCE_INVALIDATED" });
  assert.equal(f.state.sends.length, 0);
});

test("legacy createPinnedRpc send retains its one-argument API and ignores extra caller guards", async t => {
  const f = await fixture(t);
  const legacy = await createPinnedRpc({ candidates: f.candidates, rpc: httpRpc, now: () => f.state.now, requireStrictEvidence: true });
  assert.equal(await legacy.send(SIGNED, () => { assert.fail("LEGACY_MUST_IGNORE_EXTRA_ARGUMENT"); }), keccak256(SIGNED));
  assert.equal(f.state.sends.length, 1);
});
