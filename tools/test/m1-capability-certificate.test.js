"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const transport = require("../lib/executor-pinned-rpc.js"), { ExecutionError } = require("../lib/wallet-execution-guard.js");
const NOW = Date.parse("2026-10-24T02:00:01Z"), HEAD = 1000, TIME = NOW / 1000 - 1;
const hex = n => "0x" + BigInt(n).toString(16), hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0"), UNKNOWN = "0x" + "f".repeat(64);
const ADDRESS = "0x" + "12".repeat(20), turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function header(number = HEAD) {
  return { number: hex(number), hash: hash(number), parentHash: hash(number - 1), stateRoot: hash(7),
    timestamp: hex(TIME + (number - HEAD) * 12), baseFeePerGas: hex(100000000), gasLimit: hex(30000000) };
}
function fixture(t, options = {}) {
  const candidates = Array.from({ length: options.count || 4 }, (_, i) => ({ family: `PRIVATE_FAMILY_${i}`, handle: `PRIVATE_HANDLE_${i}` }));
  const state = { now: NOW, mono: 0, head: HEAD, calls: [], active: 0, peak: 0, hook: () => undefined, origins: new Map(),
    configuration: Object.freeze({}), inventoryRevision: 1, rpcIdentity() {}, fetchIdentity() {}, fetchCalls: 0, fetchHook: null };
  const rpc = async (candidate, method, params, timeout, guard) => {
    assert.ok(Object.isFrozen(candidate)); assert.ok(timeout > 0 && timeout <= 4000);
    guard?.();
    const call = { alias: Number(candidate.handle.split("_").at(-1)), method, params }; state.calls.push(call);
    state.active++; state.peak = Math.max(state.peak, state.active);
    try {
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
      const changed = await state.hook(call); if (changed !== undefined) return changed;
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_getBlockByNumber") return header(params[0] === "latest" ? state.head : Number(BigInt(params[0])));
      if (["eth_call", "eth_getCode", "eth_simulateV1"].includes(method) && params[1].blockHash === UNKNOWN) throw new ExecutionError("UNKNOWN_BLOCK_REJECTED");
      if (method === "eth_call") return params[0].to === transport.MULTICALL3 ? hash(BigInt(params[1].blockHash)) : "0x1234";
      if (method === "eth_getCode") return "0x6001";
      if (method === "eth_getTransactionCount") return "0x7";
      if (method === "eth_getBalance") return hex(2000000000000000n);
      if (method === "eth_simulateV1") {
        const block = params[0].blockStateCalls[0], tx = block.calls[0];
        return [{ parentHash: params[1].blockHash, number: block.blockOverrides.number, timestamp: block.blockOverrides.time,
          transactions: [structuredClone(tx)], calls: [{ status: "0x1", gasUsed: hex(80000), logs: [],
            returnData: hash(BigInt(block.blockOverrides.number)) + hash(BigInt(block.blockOverrides.time)).slice(2) }] }];
      }
      assert.fail("UNPLANNED_METHOD");
    } finally { state.active--; }
  };
  const resolveOrigin = handle => state.origins.get(handle) ?? null;
  if (options.http) {
    t.mock.method(require("../shared-rpc.js"), "getOrigin", resolveOrigin);
    t.mock.method(globalThis, "fetch", async (handle, config) => {
      state.fetchCalls++; state.fetchHook?.(); const body = JSON.parse(config.body);
      let packet;
      try { packet = { result: await rpc(Object.freeze({ handle }), body.method, body.params, 4000) }; }
      catch (error) {
        if (error instanceof ExecutionError && error.code === "CALL_REVERTED") packet = { error: { code: 3, message: "execution reverted" } };
        else if (error.code === "UNKNOWN_BLOCK_REJECTED") packet = { error: { code: -32000, message: "unknown block" } };
        else throw error;
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...packet }));
    });
  }
  const factory = transport.createM1HotPathFactory({ rpc: options.http ? transport.httpRpc : rpc, now: () => state.now, monotonic: () => state.mono,
    qualificationMode: options.mode || "capability-v1", allowFuture: options.future || false,
    ...(!options.http ? { resolveOrigin, getCapabilityContext: () => ({ rpc: state.rpcIdentity, fetch: state.fetchIdentity,
      configuration: state.configuration, inventoryRevision: state.inventoryRevision }) } : {}) });
  t.after(() => factory.close());
  const maintain = () => factory.maintain({ candidates }), acquire = () => factory.acquire({ candidates });
  const ready = async () => {
    maintain();
    for (let i = 0; i < 1000; i++) { await new Promise(resolve => setTimeout(resolve, 1)); if (maintain().selection === "READY") return; }
    assert.fail("QUALIFICATION_NOT_READY");
  };
  const advance = ms => { state.now += ms; state.mono += ms; state.head = HEAD + Math.floor(state.mono / 12000); };
  return { candidates, state, factory, maintain, acquire, ready, advance, rpc };
}

test("mode validation and injected context fail closed; caller certificates/aliases cannot authorize reuse", async t => {
  assert.throws(() => transport.createM1HotPathFactory({ rpc() {}, qualificationMode: "capability-v2" }), { code: "M1_QUALIFICATION_MODE_INVALID" });
  assert.throws(() => transport.createM1HotPathFactory({ rpc() {}, qualificationMode: "capability-v1" }), { code: "M1_CAPABILITY_CONTEXT_REQUIRED" });
  assert.throws(() => transport.createM1HotPathFactory({ rpc() {}, qualificationMode: "capability-v1", certificate: {} }), /M1_HOT_PATH_OPTIONS_INVALID/);
  const f = fixture(t);
  await assert.rejects(f.factory.acquire({ candidates: f.candidates, certificate: {} }));
  await assert.rejects(f.acquire(), /M1_HOT_PATH_SELECTION_HOLD/); assert.equal(f.state.calls.length, 0);
  f.candidates[0].alias = 1; assert.throws(f.maintain); assert.equal(f.state.calls.length, 0);
});

test("positive RTT: full bounded pool completes before selection; acquisition repeats only the four fresh stages", async t => {
  const f = fixture(t, { delay: 1 }), gate = deferred(); let entered = false;
  f.state.hook = async call => { if (call.alias === 3 && call.method === "eth_chainId") { entered = true; await gate.promise; } };
  f.maintain(); while (!entered) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(f.acquire(), /M1_HOT_PATH_SELECTION_HOLD/); gate.resolve(); await f.ready();
  assert.equal(new Set(f.state.calls.filter(c => c.method === "eth_getCode" && c.params[1].blockHash === UNKNOWN).map(c => c.alias)).size, 4);
  assert.equal(f.state.peak, 2);
  f.advance(12000); f.state.calls.length = 0;
  const lease = await f.acquire(), calls = f.state.calls;
  assert.deepEqual(calls.map(c => c.method), ["eth_chainId", "eth_chainId", "eth_getBlockByNumber", "eth_getBlockByNumber",
    "eth_getBlockByNumber", "eth_getBlockByNumber", "eth_call", "eth_call"]);
  assert.ok(calls.slice(2, 4).every(c => c.params[0] === "latest"));
  assert.ok(calls.slice(4, 6).every(c => c.params[0] === hex(HEAD + 1)));
  assert.ok(calls.slice(6).every(c => c.params[1].blockHash === hash(HEAD + 1)));
  const evidence = lease.current.evidence;
  assert.equal(evidence.qualificationMode, "capability-v1"); assert.equal(evidence.capability.ageAtAcquisitionMs, 12000);
  assert.equal(evidence.capability.anchors[0].number, HEAD); assert.equal(lease.current.pin.number, HEAD + 1);
  assert.equal(evidence.qualification[0].strictProbePin.number, HEAD - 1);
  assert.equal(evidence.qualification[0].capabilityAnchor.number, HEAD); assert.equal(evidence.qualification[0].freshPinNumberVerified, true);
  assert.ok(Object.isFrozen(evidence.capability.anchors[0])); assert.ok(Object.isFrozen(evidence.freshPinEvidence.pin));
  const serialized = JSON.stringify(evidence); f.advance(1000); assert.equal(JSON.stringify(evidence), serialized);
  assert.doesNotMatch(serialized + JSON.stringify(lease), /PRIVATE|configuration|inventoryRevision|origin|handle|fetch/i);
  f.state.calls.length = 0; await lease.current.code(ADDRESS); await lease.current.nonce(ADDRESS); await lease.current.call({ to: ADDRESS, data: "0x" });
  assert.deepEqual(f.state.calls.map(c => c.method), ["eth_getCode", "eth_getCode", "eth_getTransactionCount", "eth_getTransactionCount", "eth_call", "eth_call"]);
});

test("slow qualification lifetime starts at entry, not completion, publication or acquisition", async t => {
  const f = fixture(t); let moved = false;
  f.state.hook = () => { if (!moved) { moved = true; f.advance(20000); } };
  await f.ready(); const lease = await f.acquire(), proof = lease.current.evidence.capability;
  assert.equal(proof.startedAtMonoMs, 0); assert.equal(proof.completedAtMonoMs, 20000); assert.equal(proof.expiresAtMonoMs, 60000);
  f.advance(39999); lease.current.assertUsable(); await f.acquire();
  f.advance(1); const count = f.state.calls.length;
  assert.throws(lease.current.assertUsable, /M1_CAPABILITY_EXPIRED/);
  await assert.rejects(f.acquire(), /M1_HOT_PATH_SELECTION_HOLD/); assert.equal(f.state.calls.length, count);
});

test("qualification exceeding the existing 30s budget never mints a certificate", async t => {
  const f = fixture(t); let moved = false;
  f.state.hook = () => { if (!moved) { moved = true; f.advance(30000); } };
  f.maintain(); await turn(); await assert.rejects(f.acquire(), /M1_HOT_PATH_SELECTION_HOLD/);
});

test("refresh at 30s replaces eligibility but never retargets or extends an old immutable lease", async t => {
  const f = fixture(t); await f.ready(); const old = await f.acquire(), evidence = JSON.stringify(old.current.evidence);
  f.advance(29999); const count = f.state.calls.length; assert.equal(f.maintain().refreshing, false); assert.equal(f.state.calls.length, count);
  f.advance(1); assert.equal(f.maintain().refreshing, true); await turn();
  const next = await f.acquire(); assert.equal(next.current.evidence.capability.startedAtMonoMs, 30000);
  assert.equal(old.current.pin.number, HEAD); assert.equal(next.current.pin.number, HEAD + 2);
  old.current.assertUsable(); assert.equal(JSON.stringify(old.current.evidence), evidence);
  f.advance(30000); assert.throws(old.current.assertUsable, /M1_CAPABILITY_EXPIRED/); next.current.assertUsable();
  assert.equal(next.current.evidence.capability.expiresAtMonoMs, 90000);
});

for (const mutation of ["origin", "rpc", "fetch", "configuration", "revision", "inventory", "wall", "monotonic", "cumulative-drift"])
  test(`${mutation} mutation invalidates existing certificate proofs without foreground rescue`, async t => {
    const f = fixture(t); await f.ready(); const lease = await f.acquire(), count = f.state.calls.length;
    if (mutation === "origin") f.state.origins.set(f.candidates[0].handle, "https://PRIVATE.invalid");
    if (mutation === "rpc") f.state.rpcIdentity = function changed() {};
    if (mutation === "fetch") f.state.fetchIdentity = function changed() {};
    if (mutation === "configuration") f.state.configuration = Object.freeze({});
    if (mutation === "revision") f.state.inventoryRevision++;
    if (mutation === "inventory") f.candidates[0].family += "_CHANGED";
    if (mutation === "wall") f.state.now--;
    if (mutation === "monotonic") f.state.mono--;
    if (mutation === "cumulative-drift") { f.state.now += 700; lease.current.assertUsable(); f.state.now += 700; }
    assert.throws(lease.current.assertUsable); await assert.rejects(f.acquire()); assert.equal(f.state.calls.length, count);
    assert.throws(lease.current.assertUsable);
  });

test("expired while preparation is pending rejects response and revokes sibling leases before drain", async t => {
  const f = fixture(t); await f.ready(); const a = await f.acquire(), b = await f.acquire(), gate = deferred();
  f.state.hook = async call => { if (call.method === "eth_getCode" && call.alias === 1) await gate.promise;
    if (call.method === "eth_getCode" && call.alias === 0) f.advance(60000); };
  const pending = assert.rejects(a.current.code(ADDRESS)); await turn();
  assert.throws(b.current.assertUsable); gate.resolve(); await pending; assert.equal(f.state.active, 0);
});

test("CURRENT contradiction revokes immediately while a parallel sibling remains blocked; trust outranks expiry", async t => {
  const f = fixture(t); await f.ready(); const lease = await f.acquire(), gate = deferred(), sibling = deferred(); let finished = false;
  f.state.hook = async call => {
    if (call.method !== "eth_getBlockByNumber") return;
    if (call.alias === 0 && call.params[0] !== "latest") { await sibling.promise; f.advance(60000); return { ...header(HEAD), hash: hash(9999) }; }
    sibling.resolve();
    await gate.promise;
  };
  const pending = assert.rejects(lease.current.recheck()).then(() => { finished = true; }); await turn();
  assert.throws(lease.current.assertUsable); assert.equal(finished, false); gate.resolve(); await pending;
  await assert.rejects(f.acquire(), /M1_HOT_PATH_SELECTION_HOLD/);
});

test("late background completion after context revocation cannot resurrect its certificate generation", async t => {
  const f = fixture(t); await f.ready(); const lease = await f.acquire(), gate = deferred();
  f.advance(30000); f.state.hook = async () => { await gate.promise; }; f.maintain(); await turn();
  f.state.configuration = Object.freeze({}); assert.throws(lease.current.assertUsable); gate.resolve(); await turn();
  await assert.rejects(f.acquire(), /M1_HOT_PATH_SELECTION_HOLD/); assert.throws(lease.current.assertUsable);
});

test("queued expiry before transport invocation sends zero requests", async t => {
  const f = fixture(t); await f.ready(); const lease = await f.acquire(), count = f.state.calls.length;
  const pending = assert.rejects(lease.current.code(ADDRESS)); f.advance(60000); await pending;
  assert.equal(f.state.calls.length, count); assert.throws(lease.current.assertUsable);
});

for (const transition of ["expiry", "origin", "fetch"])
  test(`real httpRpc physical read boundary blocks ${transition} after factory admission`, async t => {
    const f = fixture(t, { http: true }); await f.ready(); const lease = await f.acquire(), count = f.state.fetchCalls;
    const pending = assert.rejects(lease.current.code(ADDRESS));
    queueMicrotask(() => {
      if (transition === "expiry") f.advance(60000);
      if (transition === "origin") f.state.origins.set(f.candidates[0].handle, "https://PRIVATE.invalid");
      if (transition === "fetch") globalThis.fetch = () => assert.fail("REPLACED_FETCH_MUST_NOT_DISPATCH");
    });
    await pending; assert.equal(f.state.fetchCalls, count); assert.throws(lease.current.assertUsable);
  });

test("real HTTP response arriving after expiry cannot become fresh state evidence", async t => {
  const f = fixture(t, { http: true }); await f.ready(); const lease = await f.acquire();
  f.state.fetchHook = () => f.advance(60000);
  await assert.rejects(lease.current.code(ADDRESS)); assert.throws(lease.current.assertUsable);
});

test("FUTURE qualification is fresh on each acquisition; CURRENT capabilities alone are reused", async t => {
  const f = fixture(t, { future: true }); await f.ready();
  for (let i = 0; i < 2; i++) {
    f.state.calls.length = 0; const lease = await f.acquire(); await turn(); assert.ok(lease.takeFuture());
    const calls = f.state.calls;
    assert.equal(calls.filter(c => c.method === "eth_simulateV1").length, 6);
    assert.equal(calls.filter(c => c.method === "eth_simulateV1" && c.params[1].blockHash === UNKNOWN).length, 2);
    assert.equal(calls.filter(c => c.method === "eth_getBalance").length, 2);
    assert.equal(calls.filter(c => c.method === "eth_getTransactionCount").length, 2);
    assert.equal(calls.filter(c => c.method === "eth_getCode").length, 0);
  }
});

test("same-family candidates cannot mint a certificate or trigger foreground selection", async t => {
  const f = fixture(t); for (const c of f.candidates) c.family = "PRIVATE_SAME_FAMILY";
  f.maintain(); await turn(); const count = f.state.calls.length;
  await assert.rejects(f.acquire(), /M1_HOT_PATH_SELECTION_HOLD/); assert.equal(f.state.calls.length, count);
  assert.equal(new Set(f.state.calls.map(c => c.alias)).size, 4);
});

test("configuration change on response acceptance invalidates all dependent leases", async t => {
  const f = fixture(t); await f.ready(); const a = await f.acquire(), b = await f.acquire();
  f.state.hook = call => { if (call.method === "eth_getCode") f.state.configuration = Object.freeze({}); };
  await assert.rejects(a.current.code(ADDRESS)); assert.throws(b.current.assertUsable);
});

test("malformed state code revokes before the other witness drains", async t => {
  const f = fixture(t); await f.ready(); const lease = await f.acquire(), gate = deferred(), entered = deferred(); let settled = false;
  f.state.hook = async call => {
    if (call.method !== "eth_getCode") return;
    if (call.alias === 0) { await entered.promise; return "not-code"; }
    entered.resolve(); await gate.promise;
  };
  const pending = assert.rejects(lease.current.code(ADDRESS)).then(() => { settled = true; }); await turn();
  assert.equal(settled, false); assert.throws(lease.current.assertUsable); gate.resolve(); await pending;
});

test("background selected-family contradiction revokes old certificates and cannot mint its late refresh", async t => {
  const f = fixture(t); await f.ready(); const lease = await f.acquire(), gate = deferred(); f.advance(30000);
  f.state.hook = async call => {
    if (call.alias === 0 && call.method === "eth_chainId") return "0x2";
    if (call.alias === 1 && call.method === "eth_chainId") await gate.promise;
  };
  f.maintain(); await turn(); assert.throws(lease.current.assertUsable); gate.resolve(); await turn();
  await assert.rejects(f.acquire(), /M1_HOT_PATH_SELECTION_HOLD/);
});

test("real httpRpc immutable acquisition evidence never accepts a physical transport/context mismatch", async t => {
  const f = fixture(t, { http: true }); await f.ready(); const lease = await f.acquire();
  const shared = require("../shared-rpc.js"), previous = shared.getOrigin;
  t.mock.method(shared, "getOrigin", handle => previous(handle));
  const count = f.state.fetchCalls; await assert.rejects(lease.current.code(ADDRESS));
  assert.equal(f.state.fetchCalls, count); assert.throws(lease.current.assertUsable);
});

for (const successAlias of [0, 1]) test(`success/revert contradiction revokes shared certificate before unrelated drain (success witness ${successAlias})`, async t => {
  const f = fixture(t, { http: true }); await f.ready();
  const a = await f.acquire(), b = await f.acquire(), held = deferred(), secondOutcome = deferred(), bothHeld = deferred();
  assert.equal(a.current.evidence.capability.revision, b.current.evidence.capability.revision);
  let heldCount = 0, heldDone = false, callDone = false, contradiction;
  const calls = [], tx = { to: ADDRESS, data: "0x12345678", value: "0x0" };
  f.state.hook = async call => {
    if (call.method === "eth_getCode") {
      if (++heldCount === 2) bothHeld.resolve();
      await held.promise; return "0x6001";
    }
    if (call.method === "eth_call" && call.params[0].to === ADDRESS) {
      calls.push(call);
      if (call.alias === 1) await secondOutcome.promise;
      if (call.alias === successAlias) return "0x1234";
      throw new ExecutionError("CALL_REVERTED");
    }
  };
  const holding = assert.rejects(b.current.code(ADDRESS)).then(() => { heldDone = true; });
  try {
    await bothHeld.promise;
    const failing = assert.rejects(a.current.call(tx), error => {
      contradiction = error;
      assert.ok(error instanceof ExecutionError); assert.equal(error.code, "PROVIDER_CALL_OUTCOME_DISAGREEMENT");
      assert.equal(error.message, error.code); return true;
    }).then(() => { callDone = true; });
    await turn(); assert.equal(callDone, false); a.current.assertUsable(); b.current.assertUsable();
    secondOutcome.resolve(); await failing;
    assert.equal(heldDone, false, "contradiction must not wait for a separate operation");
    assert.throws(a.current.assertUsable); assert.throws(b.current.assertUsable);
    assert.equal(calls.length, 2); assert.deepEqual(calls[0].params, calls[1].params);
    assert.deepEqual(calls[0].params, [tx, { blockHash: a.current.pin.hash, requireCanonical: true }]);
    const physical = f.state.fetchCalls, requests = f.state.calls.length;
    await Promise.all([a, b].map(lease => assert.rejects(lease.current.send("0x010203", () => {}))));
    await assert.rejects(f.acquire(), /M1_HOT_PATH_SELECTION_HOLD/);
    assert.equal(f.state.fetchCalls, physical); assert.equal(f.state.calls.length, requests);
    assert.equal(f.state.calls.some(call => call.method === "eth_sendRawTransaction"), false);
    held.resolve(); await holding;
    assert.equal(contradiction.code, "PROVIDER_CALL_OUTCOME_DISAGREEMENT", "late cancellation cannot overwrite the observed trust code");
    assert.throws(a.current.assertUsable); assert.throws(b.current.assertUsable);
    await assert.rejects(f.acquire(), /M1_HOT_PATH_SELECTION_HOLD/);
    assert.equal(f.state.active, 0);
  } finally { secondOutcome.resolve(); held.resolve(); await holding; }
});

test("unanimous genuine call reverts remain business failures without poisoning either certificate lease", async t => {
  const f = fixture(t, { http: true }); await f.ready(); const a = await f.acquire(), b = await f.acquire();
  f.state.hook = call => {
    if (call.method === "eth_call" && call.params[0].to === ADDRESS) throw new ExecutionError("CALL_REVERTED");
  };
  await assert.rejects(a.current.call({ to: ADDRESS, data: "0x12345678" }), { code: "CALL_REVERTED" });
  a.current.assertUsable(); b.current.assertUsable();
  const next = await f.acquire();
  assert.equal(next.current.evidence.capability.revision, a.current.evidence.capability.revision);
  a.current.assertUsable(); b.current.assertUsable();
});

for (const failure of ["RPC_TIMEOUT", "RPC_HTTP_RETRYABLE", "RPC_TRANSPORT_ERROR", "unclassified", "forged-revert"])
  test(`success plus ${failure} is not mislabeled as semantic disagreement`, async t => {
    const f = fixture(t); await f.ready(); const a = await f.acquire(), b = await f.acquire();
    const errors = {
      unclassified: () => new Error("UNTRUSTED_TRANSPORT_TEXT"),
      "forged-revert": () => Object.assign(new Error("UNTRUSTED_TRANSPORT_TEXT"), { code: "CALL_REVERTED" }),
    };
    f.state.hook = call => {
      if (call.alias === 1 && call.method === "eth_call" && call.params[0].to === ADDRESS)
        throw errors[failure] ? errors[failure]() : new ExecutionError(failure);
    };
    await assert.rejects(a.current.call({ to: ADDRESS, data: "0x12345678" }), { code: "PINNED_RPC_FAILED" });
    // Preserve the previous failed-facade behavior, without revoking the shared
    // certificate on absent transport evidence or forged semantic error codes.
    assert.throws(a.current.assertUsable); b.current.assertUsable();
    const next = await f.acquire();
    assert.equal(next.current.evidence.capability.revision, b.current.evidence.capability.revision);
    b.current.assertUsable(); next.current.assertUsable();
  });
