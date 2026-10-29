"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const transport = require("../lib/executor-pinned-rpc.js"), { ExecutionError } = require("../lib/wallet-execution-guard.js");
const NOW = Date.parse("2026-10-24T02:00:01Z"), HEAD = 1000, TIME = NOW / 1000 - 1;
const hex = n => "0x" + BigInt(n).toString(16), hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const address = n => "0x" + BigInt(n).toString(16).padStart(40, "0"), UNKNOWN = "0x" + "f".repeat(64);
const TX = Object.freeze({ type: "0x2", chainId: "0x1", from: address(1), to: address(2), data: "0x1234", value: "0x0",
  gas: "0x13d620", maxFeePerGas: "0xee6b280", maxPriorityFeePerGas: "0x1", nonce: "0x7", accessList: Object.freeze([]) });
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function header(number = HEAD) {
  return { number: hex(number), hash: hash(number), parentHash: hash(number - 1), stateRoot: hash(7),
    timestamp: hex(TIME + (number - HEAD) * 12), baseFeePerGas: hex(100000000), gasLimit: hex(30000000) };
}
const frame = (tx, output = "0x") => ({ type: "CALL", from: tx.from, to: tx.to, input: tx.data, value: tx.value, output, calls: [] });
function fixture(t, { mode = "capability-v1", future = false, http = false, recovery = false, selectionPolicy, count = 4, deferredDispatch = false } = {}) {
  const candidates = Array.from({ length: count }, (_, i) => ({ family: `PRIVATE_FAMILY_${i}`, handle: `PRIVATE_HANDLE_${i}` }));
  const state = { now: NOW, mono: 0, head: HEAD, calls: [], active: 0, peak: 0, hook: () => undefined, sendGate: null, sends: 0,
    origins: new Map(), configuration: Object.freeze({}), inventoryRevision: 1, rpcIdentity() {}, fetchIdentity() {}, packetHook: null, responseHook: null,
    dispatchHook: null, fetches: [], dispatchFailures: [] };
  const raw = async (candidate, method, params, timeout, guard) => {
    guard?.(); assert.ok(timeout > 0 && timeout <= 4000);
    const row = { alias: Number(candidate.handle.split("_").at(-1)), method, params, timeout };
    state.calls.push(row); state.peak = Math.max(state.peak, ++state.active);
    try {
      if (method === "eth_sendRawTransaction") { if (state.sendGate) await state.sendGate.promise; guard?.(); state.sends++; return hash(999); }
      const changed = await state.hook(row); if (changed !== undefined) return changed;
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_getBlockByNumber") return header(params[0] === "latest" ? state.head : Number(BigInt(params[0])));
      if (["eth_call", "eth_getCode", "eth_simulateV1", "debug_traceCall"].includes(method) && params[1].blockHash === UNKNOWN)
        throw new ExecutionError("UNKNOWN_BLOCK_REJECTED");
      if (method === "eth_call") return params[0].to === transport.MULTICALL3 ? hash(BigInt(params[1].blockHash)) : "0x1234";
      if (method === "eth_getCode") return "0x6001";
      if (method === "eth_getTransactionCount") return "0x7";
      if (method === "eth_getBalance") return hex(2000000000000000n);
      if (method === "debug_traceCall") return frame(params[0], params[0].to === transport.MULTICALL3 ? hash(BigInt(params[1].blockHash)) : "0x1234");
      if (method === "eth_simulateV1") {
        const block = params[0].blockStateCalls[0], tx = block.calls[0];
        return [{ parentHash: params[1].blockHash, number: block.blockOverrides.number, timestamp: block.blockOverrides.time,
          transactions: [structuredClone(tx)], calls: [{ status: "0x1", gasUsed: hex(80000), logs: [],
            returnData: hash(BigInt(block.blockOverrides.number)) + hash(BigInt(block.blockOverrides.time)).slice(2) }] }];
      }
      assert.fail("UNEXPECTED_SYNTHETIC_METHOD");
    } finally { state.active--; }
  };
  const resolveOrigin = handle => state.origins.get(handle) ?? null;
  if (http) {
    t.mock.method(require("../shared-rpc.js"), "getOrigin", resolveOrigin);
    t.mock.method(globalThis, "fetch", async (handle, config) => {
      const body = JSON.parse(config.body), override = state.packetHook?.(body);
      state.fetches.push({ handle, method: body.method });
      if (state.responseHook) {
        const response = await state.responseHook(handle, config, body); if (response !== undefined) return response;
      }
      let packet = override;
      if (!packet) {
        try { packet = { result: await raw({ handle }, body.method, body.params, 4000) }; }
        catch (error) {
          if (error.code !== "UNKNOWN_BLOCK_REJECTED") throw error;
          packet = { error: { code: -32000, message: "unknown block" } };
        }
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...packet }));
    });
  }
  const underlying = http ? transport.httpRpc : raw;
  const rpc = deferredDispatch ? (...args) => Promise.resolve().then(async () => {
    await state.dispatchHook?.(...args); return underlying(...args);
  }).catch(error => { state.dispatchFailures.push({ handle: args[0].handle, method: args[1], error }); throw error; }) : underlying;
  if (deferredDispatch && http) { state.rpcIdentity = transport.httpRpc; state.fetchIdentity = globalThis.fetch; }
  const factory = transport.createM1HotPathFactory({ rpc, now: () => state.now, monotonic: () => state.mono,
    qualificationMode: mode, allowFuture: future, rank1AcquisitionRecovery: recovery, selectionPolicy, ...(!http || deferredDispatch ? { resolveOrigin,
      getCapabilityContext: () => ({ rpc: state.rpcIdentity, fetch: state.fetchIdentity, configuration: state.configuration,
        inventoryRevision: state.inventoryRevision }) } : {}) });
  t.after(() => factory.close());
  const maintain = () => factory.maintain({ candidates }), acquire = () => factory.acquire({ candidates });
  const ready = async () => { maintain(); await turn(); assert.equal(maintain().selection, "READY"); };
  const advance = ms => { state.now += ms; state.mono += ms; };
  return { state, candidates, factory, ready, acquire, maintain, advance, raw };
}
const traceCalls = state => state.calls.filter(c => c.method === "debug_traceCall");

for (const mode of ["fresh", "capability-v1"]) test(`${mode}: acquire/CURRENT/FUTURE remain trace-free; opt-in retains identity, aliases, pair and pin`, async t => {
  const f = fixture(t, { mode, future: true }); await f.ready(); const lease = await f.acquire(); await turn();
  const current = lease.current, baseEvidence = JSON.stringify(current.evidence), future = lease.takeFuture(); assert.ok(future);
  assert.equal(traceCalls(f.state).length, 0); assert.equal(current.trace, undefined);
  f.state.calls.length = 0; f.state.peak = 0;
  const [facet, duplicate] = await Promise.all([lease.qualifyCurrentTrace(), lease.qualifyCurrentTrace()]);
  assert.equal(facet, duplicate); assert.equal(facet, await lease.qualifyCurrentTrace());
  assert.equal(lease.current, current); assert.equal(facet.pin, current.pin); assert.equal(JSON.stringify(current.evidence), baseEvidence);
  assert.equal(facet.assertUsable(), undefined); assert.equal(current.assertUsable(), undefined); future.assertUsable();
  assert.deepEqual(Object.keys(facet).sort(), ["assertUsable", "evidence", "pin", "trace"]);
  assert.ok(Object.isFrozen(facet)); assert.ok(Object.isFrozen(facet.evidence.aliases)); assert.ok(Object.isFrozen(facet.evidence.probePin));
  assert.equal(facet.evidence.traceQualified, true); assert.equal(facet.evidence.independentFamilies, true);
  assert.deepEqual(facet.evidence.aliases, current.evidence.aliases); assert.equal(f.state.peak, 2);
  assert.deepEqual([...new Set(f.state.calls.map(c => c.alias))].sort(), [0, 1]);
  for (const alias of [0, 1]) {
    const traces = traceCalls(f.state).filter(c => c.alias === alias);
    assert.deepEqual(traces.map(c => c.params[1]), [HEAD, HEAD - 1].map(n => ({ blockHash: hash(n), requireCanonical: true })).concat({ blockHash: UNKNOWN, requireCanonical: true }));
    assert.equal(f.state.calls.filter(c => c.alias === alias && c.method === "eth_getBlockByNumber" && c.params[0] === hex(HEAD - 1)).length, 2);
    assert.equal(f.state.calls.filter(c => c.alias === alias && c.method === "eth_getBlockByNumber" && c.params[0] === hex(HEAD)).length, 2);
  }
  assert.doesNotMatch(JSON.stringify(facet), /PRIVATE|handle|origin|configuration|fetch|rpc/i);
  const result = await facet.trace(TX); assert.deepEqual(result, transport.normalizeCallTrace(frame(TX, "0x1234")));
  assert.equal(result.nodes, 1); assert.equal(lease.current, current);
});

test("strict arguments/envelopes reject without IO or revoking healthy proofs", async t => {
  const f = fixture(t); await f.ready(); const lease = await f.acquire(), count = f.state.calls.length;
  for (const args of [[undefined], [{}], [{ pin: lease.current.pin }], [1, 2]]) await assert.rejects(lease.qualifyCurrentTrace(...args), { code: "TRACE_OPTIONS_INVALID" });
  assert.equal(f.state.calls.length, count); const facet = await lease.qualifyCurrentTrace(), after = f.state.calls.length;
  for (const tx of [null, [], {}, { ...TX, from: undefined }, { ...TX, to: null }, { ...TX, value: 0 }, { ...TX, gas: 1n },
    { ...TX, nonce: "0x07" }, { ...TX, data: "0x1" }, { ...TX, chainId: "0x2" }, { ...TX, gasLimit: "0x1" },
    { ...TX, blockHash: hash(1) }, { ...TX, stateOverrides: {} }, { ...TX, accessList: [{ address: address(2), storageKeys: ["0x1"] }] },
    { ...TX, get data() { assert.fail("GETTER_MUST_NOT_RUN"); } }]) await assert.rejects(facet.trace(tx), { code: "TRACE_OPTIONS_INVALID" });
  await assert.rejects(facet.trace(TX, undefined), { code: "TRACE_OPTIONS_INVALID" });
  assert.equal(f.state.calls.length, after); facet.assertUsable(); lease.current.assertUsable();
});

test("concurrent trace calls serialize width-two pairs and snapshot envelopes before queuing", async t => {
  const f = fixture(t); await f.ready(); const lease = await f.acquire(), facet = await lease.qualifyCurrentTrace(), gate = deferred();
  f.state.peak = 0; f.state.calls.length = 0;
  f.state.hook = async row => { if (row.method === "debug_traceCall") await gate.promise; };
  const tx = structuredClone(TX), first = facet.trace(tx), second = facet.trace(TX); tx.to = address(99);
  await turn(); assert.equal(f.state.calls.length, 2); gate.resolve(); await Promise.all([first, second]);
  assert.equal(f.state.peak, 2); assert.equal(f.state.calls.length, 4); assert.ok(f.state.calls.every(row => row.params[0].to === TX.to));
});

for (const errorCode of ["TRACE_METHOD_UNAVAILABLE", "TRACE_RESOURCE_UNAVAILABLE", "RPC_RESPONSE_TOO_LARGE", "RPC_TIMEOUT", "RPC_HTTP_RETRYABLE", "RPC_TRANSPORT_ERROR"])
  test(`${errorCode} is trace-only HOLD, not call/code/FUTURE distrust or fallback`, async t => {
    const f = fixture(t, { future: true }); await f.ready(); const lease = await f.acquire(); await turn();
    f.state.hook = row => { if (row.method === "debug_traceCall") throw new ExecutionError(errorCode); };
    await assert.rejects(lease.qualifyCurrentTrace(), { code: "TRACE_CAPABILITY_UNAVAILABLE" });
    const count = f.state.calls.length; await assert.rejects(lease.qualifyCurrentTrace(), { code: "TRACE_CAPABILITY_UNAVAILABLE" });
    assert.equal(f.state.calls.length, count); lease.current.assertUsable(); const future = lease.takeFuture(); assert.ok(future); future.assertUsable();
    assert.equal(await lease.current.code(address(2)), "0x6001");
    const sibling = await f.acquire(); sibling.current.assertUsable(); assert.equal(f.maintain().selection, "READY");
    assert.ok(traceCalls(f.state).every(row => [0, 1].includes(row.alias)));
  });

test("one trace-capable selected family cannot qualify or be replaced by an unselected family", async t => {
  const f = fixture(t, { future: true }); await f.ready(); const lease = await f.acquire(); await turn();
  f.state.calls.length = 0;
  f.state.hook = row => { if (row.alias === 1 && row.method === "debug_traceCall") throw new ExecutionError("TRACE_METHOD_UNAVAILABLE"); };
  await assert.rejects(lease.qualifyCurrentTrace(), { code: "TRACE_CAPABILITY_UNAVAILABLE" });
  assert.equal(f.state.active, 0); assert.ok(traceCalls(f.state).some(row => row.alias === 0));
  assert.deepEqual([...new Set(f.state.calls.map(row => row.alias))].sort(), [0, 1]);
  lease.current.assertUsable(); const future = lease.takeFuture(); assert.ok(future); future.assertUsable();
  const count = f.state.calls.length;
  await assert.rejects(lease.qualifyCurrentTrace(), { code: "TRACE_CAPABILITY_UNAVAILABLE" }); assert.equal(f.state.calls.length, count);
});

for (const control of ["currentNumber", "previousNumber", "unknownHash", "wrongChain", "currentHash", "previousHash", "canonicalReread", "malformed", "traceDisagreement"])
  test(`${control} contradiction revokes original lease and reused certificate`, async t => {
    const f = fixture(t); await f.ready(); const lease = await f.acquire(), sibling = await f.acquire(); let previousReads = 0;
    f.state.hook = row => {
      if (row.alias !== 0) return;
      if (control === "wrongChain" && row.method === "eth_chainId") return "0x2";
      if (row.method === "eth_getBlockByNumber") {
        if (control === "currentHash" && row.params[0] === hex(HEAD)) return { ...header(), hash: hash(88) };
        if (row.params[0] === hex(HEAD - 1)) {
          previousReads++;
          if (control === "previousHash" || control === "canonicalReread" && previousReads === 2) return { ...header(HEAD - 1), hash: hash(88) };
        }
      }
      if (row.method !== "debug_traceCall") return;
      if (control === "malformed") return { type: "INVALID" };
      if (control === "unknownHash" && row.params[1].blockHash === UNKNOWN) return frame(row.params[0], hash(HEAD));
      if ((control === "currentNumber" && row.params[1].blockHash === hash(HEAD)) || (control === "previousNumber" && row.params[1].blockHash === hash(HEAD - 1)))
        return frame(row.params[0], hash(88));
      if (control === "traceDisagreement" && row.params[1].blockHash === hash(HEAD)) return { ...frame(row.params[0], hash(HEAD)), calls: [frame(TX)] };
    };
    await assert.rejects(lease.qualifyCurrentTrace(), error => {
      assert.ok(error instanceof ExecutionError); assert.match(error.code, /^(PIN_TRACE_CAPABILITY_FAILED|TRACE_UNKNOWN_HASH_NOT_REJECTED|WRONG_CHAIN|PIN_CHANGED|TRACE_SHAPE_INVALID|PROVIDER_RESULT_DISAGREEMENT)$/); return true;
    });
    assert.throws(lease.current.assertUsable); assert.throws(sibling.current.assertUsable);
    await assert.rejects(f.acquire(), { code: "M1_HOT_PATH_SELECTION_HOLD" }); assert.equal(f.state.active, 0);
    await assert.rejects(lease.current.send("0x1234")); assert.equal(f.state.sends, 0);
  });

test("fast unavailable plus slow NUMBER contradiction: immediate revocation, full drain and trust-priority error", async t => {
  const f = fixture(t); await f.ready(); const lease = await f.acquire(), gate = deferred(); let done = false;
  f.state.hook = async row => {
    if (row.method !== "debug_traceCall") return;
    if (row.alias === 0) throw new ExecutionError("TRACE_METHOD_UNAVAILABLE");
    await gate.promise; return frame(row.params[0], hash(88));
  };
  const pending = assert.rejects(lease.qualifyCurrentTrace(), { code: "PIN_TRACE_CAPABILITY_FAILED" }).then(() => { done = true; });
  await turn(); assert.equal(done, false); lease.current.assertUsable(); const count = f.state.calls.length;
  gate.resolve(); await pending; assert.equal(f.state.calls.length, count); assert.equal(f.state.active, 0); assert.throws(lease.current.assertUsable);
  await turn(); assert.equal(f.state.calls.length, count);
});

test("observed contradiction revokes queued primary and secondary dispatch while sibling still drains", async t => {
  const f = fixture(t); await f.ready(); const lease = await f.acquire(), gate = deferred(), sendGate = deferred();
  f.state.sendGate = sendGate;
  const primary = assert.rejects(lease.current.send("0x1234"));
  const secondary = assert.rejects((async () => { lease.current.assertUsable(); await sendGate.promise; lease.current.assertUsable(); f.state.sends++; })());
  await turn(); let done = false;
  f.state.hook = async row => {
    if (row.method !== "debug_traceCall") return;
    if (row.alias === 1) { await gate.promise; return; }
    return frame(row.params[0], hash(88));
  };
  const pending = assert.rejects(lease.qualifyCurrentTrace(), { code: "PIN_TRACE_CAPABILITY_FAILED" }).then(() => { done = true; });
  await turn(); assert.equal(done, false); assert.throws(lease.current.assertUsable);
  sendGate.resolve(); await Promise.all([primary, secondary]); assert.equal(f.state.sends, 0);
  const count = f.state.calls.length; gate.resolve(); await pending; assert.equal(f.state.active, 0); assert.equal(f.state.calls.length, count);
});

for (const control of ["malformed", "disagreement", "envelope", "unsupported", "reverted"])
  test(`qualified facet runtime trace ${control}`, async t => {
    const f = fixture(t); await f.ready(); const lease = await f.acquire(), facet = await lease.qualifyCurrentTrace();
    f.state.hook = row => {
      if (row.method !== "debug_traceCall") return;
      if (control === "unsupported") throw new ExecutionError("TRACE_METHOD_UNAVAILABLE");
      if (control === "reverted") return { ...frame(TX), error: "UNTRUSTED_DETAIL", calls: [frame({ ...TX, value: "0x1" })] };
      if (row.alias !== 0) return;
      if (control === "malformed") return [];
      if (control === "disagreement") return frame(TX, "0xabcd");
      if (control === "envelope") return frame({ ...TX, to: address(99) });
    };
    if (control === "reverted") {
      const result = await facet.trace(TX); assert.equal(result.tree.reverted, true); assert.equal(result.nodes, 2);
      assert.equal(result.tree.calls[0].value, "1"); assert.doesNotMatch(JSON.stringify(result), /UNTRUSTED_DETAIL/); facet.assertUsable();
    } else {
      await assert.rejects(facet.trace(TX), { code: { malformed: "TRACE_SHAPE_INVALID", disagreement: "PROVIDER_RESULT_DISAGREEMENT",
        envelope: "TRACE_TRANSACTION_MISMATCH", unsupported: "TRACE_CAPABILITY_UNAVAILABLE" }[control] });
      assert.throws(facet.assertUsable); const count = f.state.calls.length; await assert.rejects(facet.trace(TX)); assert.equal(f.state.calls.length, count);
      if (control === "unsupported") lease.current.assertUsable(); else assert.throws(lease.current.assertUsable);
    }
  });

for (const mutation of ["origin", "configuration", "rpc", "fetch", "inventoryRevision", "inventory", "monotonic", "wall", "expiry", "close", "parent"])
  test(`trace proof cannot survive ${mutation}`, async t => {
    const f = fixture(t); await f.ready(); const lease = await f.acquire(), facet = await lease.qualifyCurrentTrace();
    if (mutation === "origin") f.state.origins.set(f.candidates[0].handle, "PRIVATE_ORIGIN");
    if (mutation === "configuration") f.state.configuration = Object.freeze({});
    if (mutation === "rpc") f.state.rpcIdentity = function changed() {};
    if (mutation === "fetch") f.state.fetchIdentity = function changed() {};
    if (mutation === "inventoryRevision") f.state.inventoryRevision++;
    if (mutation === "inventory") f.candidates[0].handle += "_CHANGED";
    if (mutation === "monotonic") f.state.mono = -1;
    if (mutation === "wall") f.state.now--;
    if (mutation === "expiry") f.advance(60000);
    if (mutation === "close") await f.factory.close();
    if (mutation === "parent") { f.state.hook = row => row.method === "eth_chainId" ? "0x2" : undefined; await assert.rejects(lease.current.recheck()); }
    assert.throws(facet.assertUsable); const count = f.state.calls.length;
    await assert.rejects(facet.trace(TX)); await assert.rejects(lease.qualifyCurrentTrace()); assert.equal(f.state.calls.length, count);
  });

test("trace qualification and facet reuse never reset the original 30s acquisition allowance", async t => {
  const f = fixture(t); await f.ready(); const lease = await f.acquire(); f.advance(29999);
  const facet = await lease.qualifyCurrentTrace(); assert.equal(facet.assertUsable(), undefined);
  assert.ok(traceCalls(f.state).every(row => row.timeout === 1)); f.advance(1);
  assert.throws(facet.assertUsable, { code: "M1_HOT_PATH_BUDGET" }); const count = f.state.calls.length;
  await assert.rejects(facet.trace(TX), { code: "M1_HOT_PATH_BUDGET" }); assert.equal(f.state.calls.length, count); lease.current.assertUsable();
});

test("timeout drains actual in-flight transport and late contradictory response outranks availability", async t => {
  const f = fixture(t); await f.ready(); const lease = await f.acquire(), gate = deferred(); f.advance(29980); let done = false;
  f.state.hook = async row => {
    if (row.method !== "debug_traceCall") return;
    await gate.promise; return frame(row.params[0], row.alias === 0 ? hash(88) : hash(HEAD));
  };
  const pending = assert.rejects(lease.qualifyCurrentTrace(), { code: "PIN_TRACE_CAPABILITY_FAILED" }).then(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(done, false); assert.equal(f.state.active, 2);
  const count = f.state.calls.length; gate.resolve(); await pending; assert.equal(f.state.active, 0); assert.equal(f.state.calls.length, count);
  assert.throws(lease.current.assertUsable);
});

for (const errorCode of ["TRACE_SHAPE_INVALID", "RPC_FAILED"])
  test(`timeout cannot hide a late rejected ${errorCode} response while the sibling drains`, async t => {
    const f = fixture(t); await f.ready(); const lease = await f.acquire(), sibling = await f.acquire();
    const firstGate = deferred(), secondGate = deferred(); f.advance(29980); let done = false;
    f.state.hook = async row => {
      if (row.method !== "debug_traceCall") return;
      await (row.alias === 0 ? firstGate : secondGate).promise;
      if (row.alias === 0) throw new ExecutionError(errorCode);
    };
    const pending = assert.rejects(lease.qualifyCurrentTrace(), { code: errorCode }).then(() => { done = true; });
    await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(done, false); assert.equal(f.state.active, 2);
    const count = f.state.calls.length;
    firstGate.resolve(); await turn();
    try {
      assert.equal(done, false); assert.equal(f.state.active, 1);
      assert.throws(lease.current.assertUsable); assert.throws(sibling.current.assertUsable);
    } finally { secondGate.resolve(); await pending; }
    assert.equal(f.state.active, 0); assert.equal(f.state.calls.length, count);
  });

test("late unsupported trace response drains without poisoning independent CURRENT", async t => {
  const f = fixture(t); await f.ready(); const lease = await f.acquire(), gate = deferred(); f.advance(29980); let done = false;
  f.state.hook = async row => {
    if (row.method !== "debug_traceCall") return;
    await gate.promise; throw new ExecutionError("TRACE_METHOD_UNAVAILABLE");
  };
  const pending = assert.rejects(lease.qualifyCurrentTrace(), { code: "M1_HOT_PATH_BUDGET" }).then(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(done, false); assert.equal(f.state.active, 2);
  const count = f.state.calls.length; gate.resolve(); await pending;
  assert.equal(f.state.active, 0); assert.equal(f.state.calls.length, count); lease.current.assertUsable();
});

for (const mode of ["fresh", "capability-v1"]) for (const mutation of ["budget", "origin"])
  test(`${mode}: cached qualification checks ${mutation} without replacing or reviving the facet`, async t => {
    const f = fixture(t, { mode }); await f.ready(); const lease = await f.acquire(); await lease.qualifyCurrentTrace();
    if (mutation === "budget") f.advance(30000);
    else f.state.origins.set(f.candidates[0].handle, "PRIVATE_CHANGED_ORIGIN");
    const count = f.state.calls.length;
    await assert.rejects(lease.qualifyCurrentTrace(), { code: mutation === "budget" ? "M1_HOT_PATH_BUDGET" : "M1_CAPABILITY_CONTEXT_CHANGED" });
    assert.equal(f.state.calls.length, count);
  });

for (const error of [{ code: -32601, message: "method not found" }, { code: -32005, message: "limit exceeded" },
  { code: -32000, message: "execution timeout" }]) test(`HTTP typed trace unavailability ${error.code}/${error.message}`, async t => {
  const f = fixture(t, { http: true }); await f.ready(); const lease = await f.acquire();
  f.state.packetHook = body => body.method === "debug_traceCall" ? { error } : undefined;
  await assert.rejects(lease.qualifyCurrentTrace(), { code: "TRACE_CAPABILITY_UNAVAILABLE" }); lease.current.assertUsable();
  assert.equal(await lease.current.code(address(2)), "0x6001");
});

for (const error of [{ code: -32602, message: "invalid params" }, { code: -32000, message: `unknown block ${hash(123)}` }])
  test(`HTTP unknown-hash rejection must be genuine: ${error.code}`, async t => {
    const f = fixture(t, { http: true }); await f.ready(); const lease = await f.acquire();
    f.state.packetHook = body => body.method === "debug_traceCall" && body.params[1].blockHash === UNKNOWN ? { error } : undefined;
    await assert.rejects(lease.qualifyCurrentTrace()); assert.throws(lease.current.assertUsable);
  });

async function failedAcquisition(f) {
  let failure; await assert.rejects(f.acquire(), error => { failure = error; return error instanceof ExecutionError; }); return failure;
}
for (const control of ["valid", "known-output", "canonical-reread"])
  test(`HTTP Erigon wrapped unknown hash qualifies hints/CURRENT only with intact positive controls: ${control}`, async t => {
    const f = fixture(t, { http: true, recovery: true, selectionPolicy: "rank1-prefer-dual", future: true });
    let unknowns = 0, previousReads = 0;
    f.state.packetHook = body => {
      if (body.method === "debug_traceCall" && body.params[1].blockHash === UNKNOWN) {
        unknowns++; return { error: { code: -32000, message: "get block number: block not found: " + UNKNOWN } };
      }
    };
    await f.ready(); await turn(); assert.ok(unknowns > 0); assert.equal(f.maintain().selection, "READY");
    const lease = await f.acquire(); await turn(); const before = unknowns, calls = f.state.calls.length;
    f.state.hook = row => {
      if (row.alias !== 0) return;
      if (control === "known-output" && row.method === "debug_traceCall" && row.params[1].blockHash !== UNKNOWN)
        return frame(row.params[0], hash(88));
      if (control === "canonical-reread" && row.method === "eth_getBlockByNumber" && row.params[0] === hex(HEAD - 1) && ++previousReads === 2)
        return { ...header(HEAD - 1), stateRoot: hash(88) };
    };
    if (control !== "valid") {
      // HTTP retains its existing opaque normalization of these hard positive-control failures.
      await assert.rejects(lease.qualifyCurrentTrace(), { code: "RPC_FAILED" });
      if (control === "canonical-reread") assert.ok(unknowns > before);
      assert.throws(lease.current.assertUsable); return;
    }
    const facet = await lease.qualifyCurrentTrace(); assert.equal(unknowns - before, 2);
    assert.equal(facet.evidence.unknownHashRejected, true); assert.equal(facet.evidence.hashPinnedBlockNumberVerified, true);
    for (const alias of [0, 1]) {
      const observed = f.state.calls.slice(calls).filter(row => row.alias === alias);
      assert.deepEqual(observed.filter(row => row.method === "debug_traceCall").map(row => row.params[1].blockHash), [hash(HEAD), hash(HEAD - 1)]);
      assert.equal(observed.filter(row => row.method === "eth_getBlockByNumber" && row.params[0] === hex(HEAD - 1)).length, 2);
    }
    facet.assertUsable(); lease.current.assertUsable(); const future = lease.takeFuture(); assert.ok(future); future.assertUsable();
  });
function fastRetries(t) {
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => timer(fn, ms === 150 ? 0 : ms, ...args));
}

for (const prefix of ["block not found: hash ", "block not found: canonical hash "])
  test(`HTTP Reth simulation-only -32000 selector is exact and sentinel-bound: ${prefix}`, async t => {
    const { createNextBlockContext, buildNextBlockRequest, buildNextBlockProbeTransaction } = require("../lib/next-block-simulation.js");
    const params = buildNextBlockRequest(createNextBlockContext({ number: HEAD, hash: hash(HEAD), timestamp: TIME }),
      buildNextBlockProbeTransaction(header(), 7, 2000000000000000n));
    params[1] = { blockHash: UNKNOWN, requireCanonical: true };
    let error, requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests++; return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error }));
    });
    const invoke = (request = params) => transport.httpRpc({ handle: "PRIVATE_SYNTHETIC_HANDLE" }, "eth_simulateV1", request);
    for (const code of [-32000, -32001]) for (const embedded of [UNKNOWN, "0x" + "F".repeat(64)]) {
      error = { code, message: prefix + embedded };
      await assert.rejects(invoke(), { code: "UNKNOWN_BLOCK_REJECTED" });
    }
    for (const message of [prefix + hash(42), "prefix " + prefix + UNKNOWN, prefix + UNKNOWN + " suffix", prefix + UNKNOWN + ".",
      " " + prefix + UNKNOWN, prefix + UNKNOWN + " ", prefix + UNKNOWN + "\n", prefix + UNKNOWN + "\r\n", prefix + UNKNOWN + "\t",
      prefix + "\n" + UNKNOWN, prefix + UNKNOWN + "\u0000", prefix.toUpperCase() + UNKNOWN, prefix + UNKNOWN.slice(0, -1),
      prefix + UNKNOWN + "f", prefix + UNKNOWN + " " + hash(42), prefix + UNKNOWN + ' {"extra":true}', prefix + UNKNOWN + "x".repeat(512),
      "invalid params: " + prefix + UNKNOWN, "unauthorized: " + prefix + UNKNOWN, "method not found: " + prefix + UNKNOWN]) {
      error = { code: -32000, message }; await assert.rejects(invoke(), { code: "RPC_FAILED" });
    }
    // -32001 remains a separately supported lookup form, not a newly accepted code.
    for (const code of [-32002, -32603, -32602, -32601, -32099, -32000.5, "-32000"]) {
      error = { code, message: prefix + UNKNOWN };
      await assert.rejects(invoke(), { code: code === -32601 ? "NEXT_BLOCK_METHOD_UNAVAILABLE" : "RPC_FAILED" });
    }
    for (const blockHash of [hash(HEAD), hash(42)]) {
      error = { code: -32000, message: prefix + blockHash };
      await assert.rejects(invoke([params[0], { blockHash, requireCanonical: true }]), { code: "RPC_FAILED" });
    }
    error = { code: -32000, message: prefix + UNKNOWN };
    const before = requests, ref = { blockHash: UNKNOWN, requireCanonical: true };
    for (const [method, request] of [["eth_call", [{ to: transport.MULTICALL3, data: transport.PROBE.encodeFunctionData("getBlockNumber") }, ref]],
      ["eth_getCode", [transport.MULTICALL3, ref]], ["debug_traceCall", [TX, ref,
        { tracer: "callTracer", timeout: "3s", tracerConfig: { onlyTopCall: false } }]]])
      await assert.rejects(transport.httpRpc({ handle: "PRIVATE_SYNTHETIC_HANDLE" }, method, request), { code: "RPC_FAILED" });
    assert.equal(requests - before, 3);
  });

for (const prefix of ["block not found: hash ", "block not found: canonical hash "]) for (const control of ["valid", "positive", "canonical"])
  test(`HTTP Reth simulation selector preserves qualification/recheck/provenance: ${prefix}, ${control}`, async t => {
    const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
    const f = fixture(t, { http: true, recovery: true, selectionPolicy: "rank1-prefer-dual", future: true });
    let unknowns = 0, record = false; const packets = [];
    f.state.responseHook = (handle, config, body) => {
      if (record) packets.push({ alias: Number(handle.split("_").at(-1)), method: body.method, params: body.params });
      if (body.method === "eth_simulateV1" && body.params[1].blockHash === UNKNOWN) {
        unknowns++; return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: prefix + UNKNOWN } }));
      }
    };
    await f.ready(); await turn(); assert.ok(unknowns > 0); assert.equal(f.maintain().selection, "READY");
    record = true; const before = unknowns;
    f.state.hook = async row => {
      if (row.method === "eth_simulateV1") {
        entered.resolve(); await gate.promise;
        if (control === "positive") return [];
      }
      if (control === "canonical" && unknowns > before && row.method === "eth_getBlockByNumber" && row.params[0] === hex(HEAD))
        return { ...header(), stateRoot: hash(88) };
    };
    const acquiring = f.acquire(); await entered.promise; const lease = await acquiring; lease.current.assertUsable();
    gate.resolve(); await turn(); const future = lease.takeFuture();
    if (control === "valid") {
      assert.ok(future); future.assertUsable(); lease.current.assertUsable(); assert.equal(unknowns - before, 2);
      for (const proof of future.evidence.qualification) {
        assert.equal(proof.simulationUnknownHashRejected, true); assert.equal(proof.numberTimestampVerified, true); assert.equal(proof.timeControlVerified, true);
      }
      for (const alias of [0, 1]) {
        const rows = packets.filter(row => row.alias === alias), simulations = rows.filter(row => row.method === "eth_simulateV1");
        assert.deepEqual(simulations.map(row => row.params[1].blockHash), [hash(HEAD), hash(HEAD), UNKNOWN]);
        assert.deepEqual(simulations.slice(0, 2).map(row => Number(BigInt(row.params[0].blockStateCalls[0].blockOverrides.time))), [TIME + 24, TIME + 12]);
        const negative = rows.findIndex(row => row.method === "eth_simulateV1" && row.params[1].blockHash === UNKNOWN);
        assert.ok(rows.slice(negative + 1).some(row => row.method === "eth_getBlockByNumber" && row.params[0] === hex(HEAD)));
      }
    } else {
      assert.equal(future, null);
      if (control === "positive") assert.equal(unknowns, before); else assert.ok(unknowns > before);
      f.state.hook = () => undefined; f.advance(5000); await f.ready(); await turn();
    }
    fastRetries(t); f.state.hook = row => { if (row.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT"); };
    const retirement = f.factory.retireFailedAcquisition(await failedAcquisition(f));
    if (control === "valid") assert.equal(await retirement, true);
    else await assert.rejects(retirement, /RANK1_ACQUISITION_RETIREMENT_DENIED/);
  });
for (const code of ["RPC_TIMEOUT", "RPC_TRANSPORT_ERROR", "RPC_HTTP_RETRYABLE"])
  test(`recovery preserves actual ${code} provenance behind normalized PINNED_RPC_FAILED`, async t => {
    const f = fixture(t, { recovery: true }); await f.ready(); fastRetries(t);
    const raw = new ExecutionError(code); f.state.hook = () => { throw raw; };
    const error = await failedAcquisition(f);
    assert.equal(error.code, "PINNED_RPC_FAILED"); assert.notEqual(error, raw); assert.equal(error.message, error.code);
    const other = fixture(t, { recovery: true });
    await assert.rejects(other.factory.retireFailedAcquisition(error), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
    for (const forged of [new ExecutionError(error.code), new ExecutionError(code), { ...error }, null])
      await assert.rejects(f.factory.retireFailedAcquisition(forged), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
    assert.equal(await f.factory.retireFailedAcquisition(error), true); assert.equal(f.state.active, 0);
    await assert.rejects(f.factory.retireFailedAcquisition(error), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
  });

for (const mutation of ["origin", "configuration", "rpc", "fetch", "inventoryRevision", "inventory", "monotonic", "wall"])
  test(`recovery refuses ${mutation} changes after the original transport rejection`, async t => {
    const f = fixture(t, { recovery: true }); await f.ready(); fastRetries(t);
    f.state.hook = () => { throw new ExecutionError("RPC_TIMEOUT"); }; const error = await failedAcquisition(f);
    if (mutation === "origin") f.state.origins.set(f.candidates[0].handle, "PRIVATE_CHANGED_ORIGIN");
    if (mutation === "configuration") f.state.configuration = Object.freeze({});
    if (mutation === "rpc") f.state.rpcIdentity = function changed() {};
    if (mutation === "fetch") f.state.fetchIdentity = function changed() {};
    if (mutation === "inventoryRevision") f.state.inventoryRevision++;
    if (mutation === "inventory") f.candidates[0].handle += "_CHANGED";
    if (mutation === "monotonic") f.state.mono = -1;
    if (mutation === "wall") f.state.now += 5000;
    await assert.rejects(f.factory.retireFailedAcquisition(error), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
    assert.equal(f.state.active, 0);
  });

test("a transient-looking exception from response inspection is hard, not issued-transport provenance", async t => {
  const f = fixture(t, { recovery: true }); await f.ready();
  f.state.hook = row => row.method === "eth_getBlockByNumber" ? { ...header(), get hash() { throw new ExecutionError("RPC_TIMEOUT"); } } : undefined;
  const error = await failedAcquisition(f);
  await assert.rejects(f.factory.retireFailedAcquisition(error), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
});

test("published CURRENT/trace failures never authorize retirement or alter the trace qualification contract", async t => {
  const f = fixture(t, { recovery: true }); await f.ready(); const lease = await f.acquire();
  assert.equal(traceCalls(f.state).length, 0); const facet = await lease.qualifyCurrentTrace(); facet.assertUsable();
  f.state.hook = row => { if (row.method === "debug_traceCall") throw new ExecutionError("TRACE_METHOD_UNAVAILABLE"); };
  let failure; await assert.rejects(facet.trace(TX), error => { failure = error; return error.code === "TRACE_CAPABILITY_UNAVAILABLE"; });
  await assert.rejects(f.factory.retireFailedAcquisition(failure), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
  lease.current.assertUsable();
});

for (const failure of ["valid", "chain", "context-restored", "clock-restored"])
  test(`HTTP recovery observes the actual late fetch/body before permission: ${failure}`, async t => {
    const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
    const f = fixture(t, { recovery: true, http: true }); await f.ready();
    const timer = globalThis.setTimeout; let starts = 0, done = false;
    t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => timer(fn, ms === 4000 ? 5 : ms === 150 ? 0 : ms, ...args));
    f.state.hook = async row => {
      if (row.method !== "eth_chainId") return;
      if (++starts === 6) entered.resolve(); await gate.promise;
      if (failure === "chain" && row.alias === 0) return "0x2";
    };
    const pending = failedAcquisition(f).then(error => { done = true; return error; });
    await entered.promise; await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(done, false); assert.equal(f.state.active, 6, "aborting HTTP is not proof its physical operation drained");
    if (failure === "context-restored") f.state.origins.set(f.candidates[0].handle, "PRIVATE_CHANGED_ORIGIN");
    if (failure === "clock-restored") f.state.mono = -1;
    gate.resolve(); const error = await pending;
    f.state.origins.clear(); f.state.mono = 0;
    if (failure === "valid") assert.equal(await f.factory.retireFailedAcquisition(error), true);
    else await assert.rejects(f.factory.retireFailedAcquisition(error), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
    assert.equal(f.state.active, 0); assert.equal(starts, 6);
  });

function preferredFixture(t, { traces = [2, 3], futures = [0, 1, 2, 3], ...options } = {}) {
  const f = fixture(t, { selectionPolicy: "rank1-prefer-dual", ...options });
  const base = row => {
    if (row.method === "debug_traceCall" && !traces.includes(row.alias)) throw new ExecutionError("TRACE_METHOD_UNAVAILABLE");
    if (row.method === "eth_simulateV1" && !futures.includes(row.alias)) throw new ExecutionError("NEXT_BLOCK_METHOD_UNAVAILABLE");
  };
  f.state.hook = base; return { ...f, base };
}

for (const mode of ["fresh", "capability-v1"]) test(`${mode}: selection waits for every hint; replacement never swaps or invalidates a fixed lease`, async t => {
  const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
  const f = preferredFixture(t, { mode });
  f.state.hook = async row => {
    if (row.alias === 3 && row.method === "eth_simulateV1" && row.params[1].blockHash === UNKNOWN) { entered.resolve(); await gate.promise; }
    return f.base(row);
  };
  f.maintain(); await entered.promise;
  const old = await f.acquire(), frozen = JSON.stringify(old.current);
  assert.deepEqual(old.current.evidence.aliases, [1, 2]);
  const acquisitionGate = deferred(), acquisitionEntered = deferred(); t.after(() => acquisitionGate.resolve());
  let acquiring = true;
  const hook = f.state.hook;
  f.state.hook = async row => {
    if (acquiring && row.method === "eth_chainId") { acquisitionEntered.resolve(); await acquisitionGate.promise; }
    return hook(row);
  };
  const inFlight = f.acquire(); await acquisitionEntered.promise;
  gate.resolve(); await turn(); acquiring = false; acquisitionGate.resolve();
  const captured = await inFlight; assert.deepEqual(captured.current.evidence.aliases, [1, 2]);
  old.current.assertUsable(); captured.current.assertUsable(); assert.equal(JSON.stringify(old.current), frozen);
  const lease = await f.acquire(); assert.deepEqual(lease.current.evidence.aliases, [3, 4]);
  assert.doesNotMatch(JSON.stringify(lease.current.evidence), /traceQualified|nextBlockQualified|PRIVATE|handle|origin/);
  assert.equal(lease.isFutureReady(), false); assert.equal(lease.takeFuture(), null);
  const before = traceCalls(f.state).length; await lease.qualifyCurrentTrace();
  assert.equal(traceCalls(f.state).length - before, 6, "a hint never substitutes for per-lease trace qualification");
  old.current.assertUsable(); captured.current.assertUsable();
});

for (const spec of [
  { name: "dual beats newer FUTURE-only", traces: [2, 3], futures: [0, 1, 2, 3], newer: true, expected: [3, 4] },
  { name: "one trace beats zero among FUTURE pairs", traces: [3], futures: [0, 1, 2, 3], expected: [1, 4] },
  { name: "FUTURE-only keeps watching without claiming trace", traces: [], futures: [2, 3], expected: [3, 4] },
  { name: "no independent FUTURE pair retains ordinary fallback", traces: [2, 3], futures: [2], expected: [1, 2] },
  { name: "no hints retains ordinary fallback", traces: [], futures: [], expected: [1, 2] },
  { name: "equal hint ranks preserve head then alias ordering", traces: [0, 1, 2, 3], futures: [0, 1, 2, 3], newer: true, expected: [1, 2] },
  { name: "same-family dual rows cannot form a pair", traces: [2, 3], futures: [0, 1, 2, 3], sameFamily: true, expected: [1, 3] },
]) test(`selection ranking: ${spec.name}`, async t => {
  const f = preferredFixture(t, spec); let hintsStarted = false;
  if (spec.sameFamily) f.candidates[3].family = f.candidates[2].family;
  f.state.hook = row => {
    if (row.method === "debug_traceCall") hintsStarted = true;
    if (spec.newer && !hintsStarted && row.method === "eth_getBlockByNumber" && row.params[0] === "latest")
      return header(row.alias < 2 ? HEAD : HEAD - 1);
    return f.base(row);
  };
  await f.ready();
  assert.equal(f.state.peak, 2, "the complete background sweeps have bounded workers");
  assert.deepEqual([...new Set(traceCalls(f.state).map(row => row.alias))].sort(), [0, 1, 2, 3]);
  assert.deepEqual([...new Set(f.state.calls.filter(row => row.method === "eth_simulateV1").map(row => row.alias))].sort(), [0, 1, 2, 3]);
  const lease = await f.acquire(); assert.deepEqual(lease.current.evidence.aliases, spec.expected);
  assert.doesNotMatch(JSON.stringify(lease.current.evidence), /traceQualified|nextBlockQualified/);
});

test("selection FUTURE attempts reread fresh canonical headers after trace latency", async t => {
  const f = preferredFixture(t); let advanced = false;
  f.state.hook = row => {
    if (row.method === "debug_traceCall" && !advanced) { advanced = true; f.advance(12000); f.state.head++; }
    return f.base(row);
  };
  await f.ready();
  const simulations = f.state.calls.filter(row => row.method === "eth_simulateV1" && row.params[1].blockHash !== UNKNOWN);
  assert.ok(simulations.length >= 8); assert.ok(simulations.every(row => row.params[1].blockHash === hash(HEAD + 1)));
  for (const alias of [0, 1, 2, 3]) {
    const rows = f.state.calls.filter(row => row.alias === alias), index = rows.findIndex(row => row.method === "eth_getTransactionCount");
    assert.equal(rows[index - 1].method, "eth_getBlockByNumber"); assert.equal(rows[index - 1].params[0], hex(HEAD + 1));
    assert.equal(rows[index - 2].params[0], "latest");
  }
  assert.deepEqual((await f.acquire()).current.evidence.aliases, [3, 4]);
});

test("selection hint completion never renews the original strict expiry or trace deadline", async t => {
  const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
  const f = preferredFixture(t); let delay = true;
  f.state.hook = async row => {
    if (delay && row.method === "debug_traceCall") { entered.resolve(); await gate.promise; }
    return f.base(row);
  };
  f.maintain(); await entered.promise; f.advance(20000); f.state.head++; delay = false; gate.resolve(); await turn();
  const lease = await f.acquire(); assert.deepEqual(lease.current.evidence.aliases, [3, 4]);
  await lease.qualifyCurrentTrace(); f.advance(31000);
  await assert.rejects(lease.qualifyCurrentTrace(), /M1_HOT_PATH_BUDGET/);
  f.advance(9000); assert.throws(lease.current.assertUsable, /M1_CAPABILITY_EXPIRED/);
  await assert.rejects(f.acquire(), /M1_HOT_PATH_SELECTION_HOLD/);
});

test("an incomplete bounded hint sweep retains strict fallback, including after late physical completion", async t => {
  const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
  const f = preferredFixture(t);
  f.state.hook = async row => {
    if (row.alias === 3 && row.method === "debug_traceCall") { entered.resolve(); await gate.promise; }
    return f.base(row);
  };
  f.maintain(); await entered.promise; f.advance(30000); f.state.head += 2; gate.resolve(); await turn();
  const lease = await f.acquire(); assert.deepEqual(lease.current.evidence.aliases, [1, 2]); lease.current.assertUsable();
});

for (const mutation of ["origin", "configuration", "inventory", "trust"]) test(`selection cannot replace after ${mutation} changes during hints`, async t => {
  const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
  const f = preferredFixture(t);
  f.state.hook = async row => {
    if (row.alias === 3 && row.method === "debug_traceCall") { entered.resolve(); await gate.promise; }
    return f.base(row);
  };
  f.maintain(); await entered.promise; const lease = await f.acquire();
  if (mutation === "origin") f.state.origins.set(f.candidates[3].handle, "PRIVATE_CHANGED_ORIGIN");
  if (mutation === "configuration") f.state.configuration = Object.freeze({});
  if (mutation === "inventory") f.candidates[3].family += "_CHANGED";
  if (mutation === "trust") {
    const saved = f.state.hook;
    f.state.hook = row => row.method === "eth_chainId" ? "0x2" : saved(row);
    await assert.rejects(lease.current.recheck()); f.state.hook = saved;
  }
  gate.resolve(); await turn();
  assert.throws(lease.current.assertUsable); await assert.rejects(f.acquire()); assert.equal(f.state.active, 0);
});

for (const hard of [false, true]) test(`selection hint physical drain participates in retirement, late contradiction=${hard}`, async t => {
  const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
  const f = preferredFixture(t, { recovery: true }); fastRetries(t);
  f.state.hook = async row => {
    if (row.method === "debug_traceCall" && row.alias === 0) {
      entered.resolve(); await gate.promise;
      return frame(row.params[0], hard ? hash(777) : hash(BigInt(row.params[1].blockHash)));
    }
    return f.base(row);
  };
  f.maintain(); await entered.promise;
  const saved = f.state.hook;
  f.state.hook = row => { if (row.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT"); return saved(row); };
  const error = await failedAcquisition(f); let done = false;
  const retirement = f.factory.retireFailedAcquisition(error).finally(() => { done = true; });
  const checked = hard ? assert.rejects(retirement, /RANK1_ACQUISITION_RETIREMENT_DENIED/) : retirement;
  await turn(); assert.equal(done, false); assert.ok(f.state.active > 0); const count = f.state.calls.length;
  gate.resolve(); const result = await checked; if (!hard) assert.equal(result, true);
  assert.equal(f.state.active, 0); assert.equal(f.state.calls.length, count);
});

test("selection close without recovery waits for outstanding physical hints", async t => {
  const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
  const f = preferredFixture(t);
  f.state.hook = async row => { if (row.method === "debug_traceCall") { entered.resolve(); await gate.promise; } return f.base(row); };
  f.maintain(); await entered.promise; let done = false;
  const closing = f.factory.close().then(() => { done = true; }); await turn(); assert.equal(done, false);
  const count = f.state.calls.length; gate.resolve(); await closing;
  assert.equal(f.state.active, 0); assert.equal(f.state.calls.length, count);
});

test("selection cannot create strict capacity or include a failed strict row in the hint pool", async t => {
  const f = preferredFixture(t, { count: 5, traces: [4], futures: [4] });
  f.state.hook = row => row.alias === 4 && row.method === "eth_getCode" ? "0x" : f.base(row);
  await f.ready();
  assert.equal(f.state.calls.some(row => row.alias === 4 && ["debug_traceCall", "eth_simulateV1"].includes(row.method)), false);
  const lease = await f.acquire(); assert.deepEqual(lease.current.evidence.aliases, [1, 2]);
  await assert.rejects(lease.qualifyCurrentTrace(), /TRACE_CAPABILITY_UNAVAILABLE/); lease.current.assertUsable();
});

test("selection replacement preserves an already-ready FUTURE; every later lease needs new FUTURE and trace proofs", async t => {
  const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
  const f = preferredFixture(t, { future: true });
  f.state.hook = async row => {
    if (row.alias === 3 && row.method === "eth_simulateV1" && row.params[1].blockHash === UNKNOWN) { entered.resolve(); await gate.promise; }
    return f.base(row);
  };
  f.maintain(); await entered.promise; const old = await f.acquire(); await turn();
  assert.equal(old.isFutureReady(), true); gate.resolve(); await turn();
  assert.equal(old.isFutureReady(), true); old.takeFuture().assertUsable(); old.current.assertUsable();
  for (let attempt = 0; attempt < 2; attempt++) {
    const start = f.state.calls.length, lease = await f.acquire(); await turn();
    assert.deepEqual(lease.current.evidence.aliases, [3, 4]);
    const calls = f.state.calls.slice(start);
    assert.equal(calls.filter(row => row.method === "eth_simulateV1").length, 6);
    assert.equal(calls.filter(row => row.method === "debug_traceCall").length, 0);
    assert.equal(lease.isFutureReady(), true); lease.takeFuture().assertUsable();
    await lease.qualifyCurrentTrace(); assert.equal(f.state.calls.slice(start).filter(row => row.method === "debug_traceCall").length, 6);
  }
  f.state.hook = row => { if (row.method === "debug_traceCall") throw new ExecutionError("TRACE_METHOD_UNAVAILABLE"); return f.base(row); };
  const lost = await f.acquire(); await assert.rejects(lost.qualifyCurrentTrace(), /TRACE_CAPABILITY_UNAVAILABLE/);
  lost.current.assertUsable();
});

for (const unavailable of ["unsupported", "resource", "transport", "reverted", "unfunded", "window"])
  test(`selection hint ${unavailable} is not a hard contradiction or recovery authority`, async t => {
    const f = preferredFixture(t, { recovery: true }); fastRetries(t);
    f.state.hook = row => {
      if (row.method === "debug_traceCall") throw new ExecutionError(unavailable === "resource" ? "TRACE_RESOURCE_UNAVAILABLE" : "TRACE_METHOD_UNAVAILABLE");
      if (row.method === "eth_simulateV1") {
        if (unavailable === "reverted") throw new ExecutionError("NEXT_BLOCK_REVERTED");
        if (unavailable === "transport") throw new ExecutionError("RPC_TRANSPORT_ERROR");
        throw new ExecutionError("NEXT_BLOCK_METHOD_UNAVAILABLE");
      }
      if (unavailable === "unfunded" && row.method === "eth_getBalance") return "0x0";
    };
    if (unavailable === "window") { f.advance(11000); }
    await f.ready(); assert.equal(f.state.active, 0);
    f.state.hook = () => { throw new ExecutionError("RPC_TIMEOUT"); };
    const error = await failedAcquisition(f);
    assert.equal(await f.factory.retireFailedAcquisition(error), true);
  });

for (const http of [false, true]) for (const hard of [false, true]) for (const method of ["debug_traceCall", "eth_simulateV1"])
  test(`selection timed-out hint remains physically tracked: http=${http}, hard=${hard}, ${method}`, async t => {
    const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
    const f = preferredFixture(t, { recovery: true, http, traces: [0, 1, 2, 3] });
    const timer = globalThis.setTimeout;
    t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => timer(fn, ms === 4000 ? 5 : ms === 150 ? 0 : ms, ...args));
    f.state.hook = async row => {
      if (row.method === method && row.alias === 0) {
        entered.resolve(); await gate.promise;
        if (method === "debug_traceCall") return frame(row.params[0], hard ? hash(111) : hash(BigInt(row.params[1].blockHash)));
        const block = row.params[0].blockStateCalls[0];
        return [{ parentHash: hard ? hash(111) : row.params[1].blockHash, number: block.blockOverrides.number, timestamp: block.blockOverrides.time,
          transactions: [structuredClone(block.calls[0])], calls: [{ status: "0x1", gasUsed: hex(80000), logs: [],
            returnData: hash(BigInt(block.blockOverrides.number)) + hash(BigInt(block.blockOverrides.time)).slice(2) }] }];
      }
    };
    f.maintain(); await entered.promise; await new Promise(resolve => setTimeout(resolve, 20));
    f.state.hook = row => { if (row.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT"); };
    const error = await failedAcquisition(f); let done = false;
    const retirement = f.factory.retireFailedAcquisition(error).finally(() => { done = true; });
    const checked = hard ? assert.rejects(retirement, /RANK1_ACQUISITION_RETIREMENT_DENIED/) : retirement;
    await turn(); assert.equal(done, false); gate.resolve();
    const result = await checked; if (!hard) assert.equal(result, true); assert.equal(f.state.active, 0);
  });

test("HTTP hint budget exhaustion keeps its private soft provenance through transport normalization", async t => {
  const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
  const f = preferredFixture(t, { recovery: true, http: true, traces: [0, 1, 2, 3] });
  f.state.hook = async row => { if (row.method === "debug_traceCall") { entered.resolve(); await gate.promise; } };
  f.maintain(); await entered.promise; f.advance(30000); f.state.head += 2; gate.resolve(); await turn();
  assert.equal(f.state.active, 0); fastRetries(t);
  f.state.hook = row => { if (row.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT"); };
  const error = await failedAcquisition(f); assert.equal(await f.factory.retireFailedAcquisition(error), true);
});

test("late hint contradiction revokes a published strict fallback even without recovery opt-in", async t => {
  const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
  const f = preferredFixture(t), timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => timer(fn, ms === 4000 ? 5 : ms, ...args));
  f.state.hook = async row => {
    if (row.alias === 0 && row.method === "debug_traceCall") {
      entered.resolve(); await gate.promise; return frame(row.params[0], hash(111));
    }
    return f.base(row);
  };
  f.maintain(); await entered.promise; await new Promise(resolve => setTimeout(resolve, 20));
  const lease = await f.acquire(); assert.deepEqual(lease.current.evidence.aliases, [1, 2]); lease.current.assertUsable();
  gate.resolve(); await turn(); assert.throws(lease.current.assertUsable);
  await assert.rejects(f.acquire(), /M1_HOT_PATH_SELECTION_HOLD/); assert.equal(f.state.active, 0);
});

for (const status of [429, 503, 401]) for (const cleanupFails of [false, true])
  test(`HTTP recovery drains status ${status} body cancellation before retirement, cleanupFails=${cleanupFails}`, async t => {
    const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
    const f = fixture(t, { recovery: true, http: true, selectionPolicy: "rank1-prefer-dual" });
    const streams = []; let cancellations = 0, disposed = 0, failAcquisition = false;
    fastRetries(t);
    f.state.responseHook = (handle, config, body) => {
      if (failAcquisition && body.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT");
      if (body.method !== "eth_simulateV1") return;
      const stream = new ReadableStream({ start(controller) {
        config.signal.addEventListener("abort", () => controller.error(config.signal.reason), { once: true });
      }, async cancel() {
        assert.equal(config.signal.aborted, false, "cleanup must cancel before aborting a live status body");
        cancellations++; entered.resolve(); await gate.promise; disposed++;
        if (cleanupFails) throw new Error("SYNTHETIC_CANCEL_FAILURE");
      } });
      streams.push(stream); return new Response(stream, { status });
    };
    f.maintain(); await entered.promise; failAcquisition = true;
    const error = await failedAcquisition(f); let done = false;
    const retirement = f.factory.retireFailedAcquisition(error).finally(() => { done = true; });
    const denied = cleanupFails || status === 401;
    const checked = denied ? assert.rejects(retirement, /RANK1_ACQUISITION_RETIREMENT_DENIED/) : retirement;
    await turn(); assert.equal(done, false); assert.ok(cancellations > 0); assert.equal(disposed, 0);
    gate.resolve(); const result = await checked; if (!denied) assert.equal(result, true);
    assert.equal(disposed, cancellations); assert.ok(streams.every(stream => !stream.locked)); assert.equal(f.state.active, 0);
  });

for (const kind of ["reset", "owned-timeout", "foreign-abort"]) for (const cleanup of ["same", "different"])
  test(`HTTP recovery terminal stream identity: ${kind}, cleanup=${cleanup}`, async t => {
    const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
    const f = fixture(t, { recovery: true, http: true }); await f.ready(); fastRetries(t);
    if (kind === "owned-timeout") {
      const timer = globalThis.setTimeout;
      t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => timer(fn, ms === 4000 ? 5 : ms, ...args));
    }
    const streams = []; let cancelStarted = 0, cancelFinished = 0, done = false;
    f.state.responseHook = (handle, config, body) => {
      if (body.method !== "eth_chainId") return;
      let terminalError;
      const stream = new ReadableStream({ start(controller) {
        if (kind === "owned-timeout") config.signal.addEventListener("abort", () => {
          terminalError = config.signal.reason; assert.equal(terminalError.code, "RPC_TIMEOUT"); controller.error(terminalError);
        }, { once: true });
        else {
          terminalError = kind === "reset" ? Object.assign(new Error("SYNTHETIC_RESET"), { code: "ECONNRESET" }) :
            new DOMException("SYNTHETIC_ABORT", "AbortError");
          controller.error(terminalError);
        }
      } });
      const getReader = stream.getReader.bind(stream);
      t.mock.method(stream, "getReader", () => {
        const reader = getReader(), cancel = reader.cancel.bind(reader);
        t.mock.method(reader, "cancel", async () => {
          cancelStarted++; if (kind !== "owned-timeout" || cancelStarted === 6) entered.resolve();
          await gate.promise;
          try { await cancel(); assert.fail("ERRORED_STREAM_MUST_REJECT_CANCEL"); }
          catch (error) {
            assert.equal(error, terminalError, "native cancel repeats the exact stored stream error");
            cancelFinished++;
            if (cleanup === "different") throw Object.assign(new Error(error.message), { code: error.code, name: error.name });
            throw error;
          }
        });
        return reader;
      });
      streams.push(stream); return new Response(stream, { status: 200 });
    };
    const acquiring = failedAcquisition(f).then(error => { done = true; return error; });
    await entered.promise; await turn(); assert.equal(done, false); assert.equal(cancelFinished, 0);
    gate.resolve(); const error = await acquiring;
    assert.equal(cancelFinished, cancelStarted); assert.ok(streams.every(stream => !stream.locked));
    if (cleanup === "same" && kind !== "foreign-abort") assert.equal(await f.factory.retireFailedAcquisition(error), true);
    else await assert.rejects(f.factory.retireFailedAcquisition(error), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
    assert.equal(f.state.active, 0);
  });

for (const invalid of ["missing-body", "getReader-failure"])
  test(`HTTP recovery rejects ${invalid} on retryable status and disposes any retained body`, async t => {
    const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
    const f = fixture(t, { recovery: true, http: true }); await f.ready();
    const streams = []; let disposed = 0;
    f.state.responseHook = (handle, config, body) => {
      if (body.method !== "eth_chainId") return;
      if (invalid === "missing-body") return new Response(null, { status: 503 });
      const stream = new ReadableStream({ async cancel() { entered.resolve(); await gate.promise; disposed++; } });
      t.mock.method(stream, "getReader", () => { throw Object.assign(new Error("SYNTHETIC_READER_FAILURE"), { code: "ECONNRESET" }); });
      streams.push(stream); return new Response(stream, { status: 503 });
    };
    let done = false; const acquiring = failedAcquisition(f).then(error => { done = true; return error; });
    if (invalid === "getReader-failure") { await entered.promise; await turn(); assert.equal(done, false); gate.resolve(); }
    const error = await acquiring;
    await assert.rejects(f.factory.retireFailedAcquisition(error), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
    assert.equal(disposed, streams.length); assert.ok(streams.every(stream => !stream.locked));
  });

test("HTTP terminal stream echoes cannot conceal context changes during awaited cleanup", async t => {
  const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
  const f = fixture(t, { recovery: true, http: true }); await f.ready(); fastRetries(t);
  f.state.responseHook = (handle, config, body) => {
    if (body.method !== "eth_chainId") return;
    const failure = Object.assign(new Error("SYNTHETIC_RESET"), { code: "ECONNRESET" });
    const stream = new ReadableStream({ start(controller) { controller.error(failure); } }), getReader = stream.getReader.bind(stream);
    t.mock.method(stream, "getReader", () => {
      const reader = getReader(), cancel = reader.cancel.bind(reader);
      t.mock.method(reader, "cancel", async () => { entered.resolve(); await gate.promise; return cancel(); }); return reader;
    });
    return new Response(stream);
  };
  const acquiring = failedAcquisition(f); await entered.promise;
  f.state.origins.set(f.candidates[0].handle, "PRIVATE_CHANGED_ORIGIN"); gate.resolve();
  const error = await acquiring; f.state.origins.clear();
  await assert.rejects(f.factory.retireFailedAcquisition(error), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
});

const lifecycleFixture = (t, options = {}) => fixture(t, { recovery: true, selectionPolicy: "rank1-prefer-dual", future: true, ...options });
const minedReceipt = () => ({ transactionHash: hash(999), blockHash: hash(HEAD), blockNumber: hex(HEAD), transactionIndex: "0x0", status: "0x1",
  from: address(1), to: address(2), gasUsed: hex(80000), effectiveGasPrice: hex(100000001), logs: [] });

for (const code of ["RPC_TIMEOUT", "RPC_TRANSPORT_ERROR", "RPC_HTTP_RETRYABLE"])
  test(`record-scoped retirement after healthy leases, expiry/refresh and cancellation: ${code}`, async t => {
    const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
    const f = lifecycleFixture(t); fastRetries(t);
    const hold = await failedAcquisition(f); assert.equal(hold.code, "M1_HOT_PATH_SELECTION_HOLD");
    await f.ready(); const first = await f.acquire(); await turn();
    const trace = await first.qualifyCurrentTrace(), future = first.takeFuture(); assert.ok(future); first.cancelFuture();
    f.advance(12000); f.state.head++;
    const second = await f.acquire(); await turn(); second.cancelFuture();
    f.advance(48000); f.state.head += 4;
    let expired;
    assert.throws(first.current.assertUsable, error => { expired = error; return error.code === "M1_CAPABILITY_EXPIRED"; });
    await assert.rejects(f.factory.retireFailedAcquisition(expired), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
    await f.ready(); const third = await f.acquire(); await turn();
    f.state.hook = async row => {
      if (row.method === "eth_getTransactionReceipt") { entered.resolve(); await gate.promise; return null; }
      if (row.method === "eth_chainId") throw new ExecutionError(code);
    };
    const oldRead = third.current.receipt(hash(999)).catch(error => error); await entered.promise;
    const error = await failedAcquisition(f); let done = false;
    const retirement = f.factory.retireFailedAcquisition(error).finally(() => { done = true; });
    await turn(); assert.equal(done, false); const calls = f.state.calls.length;
    gate.resolve(); await oldRead; assert.equal(await retirement, true);
    for (const proof of [first.current, second.current, third.current, trace, future]) assert.throws(proof.assertUsable);
    await assert.rejects(third.current.nonce(address(1))); assert.equal(f.state.calls.length, calls); assert.equal(f.state.active, 0);
    await assert.rejects(f.factory.retireFailedAcquisition(error), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
    await assert.rejects(f.factory.retireFailedAcquisition(hold), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
  });

for (const reuse of ["none", "same-error", "nested-error", "outward-error"])
  test(`published-operation errors cannot transfer acquisition authority: ${reuse}`, async t => {
    const f = lifecycleFixture(t, { future: false }); await f.ready(); fastRetries(t); const lease = await f.acquire();
    const nested = {}, original = new ExecutionError("RPC_TIMEOUT"); original.cause = nested;
    f.state.hook = row => { if (row.method === "eth_getBlockByNumber" && row.params[0] === "latest") throw original; };
    let oldError; await assert.rejects(lease.current.liveHeadNumber(), error => { oldError = error; return true; });
    await assert.rejects(f.factory.retireFailedAcquisition(oldError), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
    f.state.hook = row => {
      if (row.method !== "eth_chainId") return;
      if (reuse === "same-error") throw original;
      if (reuse === "outward-error") throw oldError;
      const error = new ExecutionError("RPC_TIMEOUT"); if (reuse === "nested-error") error.cause = nested; throw error;
    };
    const failure = await failedAcquisition(f);
    if (reuse === "none") assert.equal(await f.factory.retireFailedAcquisition(failure), true);
    else await assert.rejects(f.factory.retireFailedAcquisition(failure), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
  });

for (const firstBad of [0, 1]) test(`cold rejected rows are isolated in both completion orders: first=${firstBad}`, async t => {
  const gates = [deferred(), deferred()], entered = deferred(); t.after(() => gates.forEach(gate => gate.resolve()));
  const f = lifecycleFixture(t, { count: 6, future: false }); let starts = 0;
  f.state.hook = async row => {
    if (row.alias < 2 && row.method === "eth_chainId") {
      if (++starts === 2) entered.resolve(); await gates[row.alias].promise;
      if (row.alias === 1) return "0x2";
    }
    if (row.alias === 0 && row.method === "eth_getBlockByNumber") return { ...header(row.params[0] === "latest" ? HEAD : Number(BigInt(row.params[0]))), stateRoot: hash(333) };
    if (row.alias === 0 && row.method === "eth_getCode") throw new ExecutionError("RPC_FAILED");
  };
  f.maintain(); await entered.promise; gates[firstBad].resolve(); await turn(); gates[1 - firstBad].resolve(); await turn();
  assert.equal(f.maintain().selection, "READY"); const lease = await f.acquire(); assert.deepEqual(lease.current.evidence.aliases, [3, 4]);
  fastRetries(t); f.state.hook = row => { if (row.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT"); };
  assert.equal(await f.factory.retireFailedAcquisition(await failedAcquisition(f)), true);
});

for (const fault of ["WRONG_CHAIN", "RPC_FAILED"])
  test(`accepted history cannot become cold after certificate expiry: ${fault}`, async t => {
    const f = lifecycleFixture(t, { future: false }); await f.ready(); const lease = await f.acquire();
    f.advance(60000); f.state.head += 5;
    f.state.hook = row => {
      if (row.alias === 3 && row.method === "eth_chainId") {
        if (fault === "WRONG_CHAIN") return "0x2"; throw new ExecutionError("RPC_FAILED");
      }
    };
    f.maintain(); await turn(); assert.throws(lease.current.assertUsable);
    f.state.hook = () => undefined; f.advance(5000); await f.ready(); fastRetries(t);
    f.state.hook = row => { if (row.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT"); };
    await assert.rejects(f.factory.retireFailedAcquisition(await failedAcquisition(f)), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
  });

for (const fault of ["cleanup", "context"])
  test(`cold local ${fault} failures stay fatal after the pool recovers`, async t => {
    const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
    const f = lifecycleFixture(t, { http: true, future: false });
    f.state.responseHook = (handle, config, body) => {
      if (handle !== f.candidates[0].handle || body.method !== "eth_chainId") return;
      if (fault === "cleanup") return new Response(new ReadableStream({ async cancel() { entered.resolve(); await gate.promise; throw new Error("SYNTHETIC_CLEANUP"); } }), { status: 503 });
    };
    if (fault === "context") f.state.hook = async row => {
      if (row.alias === 0 && row.method === "eth_chainId") { entered.resolve(); await gate.promise; }
    };
    f.maintain(); await entered.promise;
    if (fault === "context") f.state.origins.set(f.candidates[0].handle, "PRIVATE_CHANGED_ORIGIN");
    gate.resolve(); await turn(); f.state.origins.clear(); f.state.responseHook = null; f.state.hook = () => undefined;
    f.advance(5000); await f.ready(); fastRetries(t);
    f.state.hook = row => { if (row.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT"); };
    await assert.rejects(f.factory.retireFailedAcquisition(await failedAcquisition(f)), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
  });

for (const code of ["M1_HOT_PATH_CANCELLED", "M1_CAPABILITY_EXPIRED", "M1_CAPABILITY_INVALIDATED", "M1_HOT_PATH_SELECTION_HOLD"])
  test(`forged lifecycle codes are not owned lifecycle outcomes: ${code}`, async t => {
    const f = lifecycleFixture(t, { future: false }); await f.ready(); await f.acquire();
    f.state.hook = row => { if (row.method === "eth_chainId") throw new ExecutionError(code); };
    await assert.rejects(f.factory.retireFailedAcquisition(await failedAcquisition(f)), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
  });

for (const hard of [false, true]) test(`ordinary cancelled/expired old FUTURE drains without hiding late hard=${hard}`, async t => {
  const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
  const f = lifecycleFixture(t); await f.ready(); fastRetries(t);
  f.state.hook = async row => {
    if (row.method === "eth_simulateV1") {
      entered.resolve(); await gate.promise;
      if (hard && row.alias === 0) return [];
    }
  };
  const acquiring = f.acquire(); await entered.promise; const old = await acquiring; old.cancelFuture();
  f.advance(12000); f.state.head++;
  const hook = f.state.hook;
  f.state.hook = row => { if (row.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT"); return hook(row); };
  const failure = await failedAcquisition(f); let done = false;
  const retirement = f.factory.retireFailedAcquisition(failure).finally(() => { done = true; });
  const checked = hard ? assert.rejects(retirement, /RANK1_ACQUISITION_RETIREMENT_DENIED/) : retirement;
  await turn(); assert.equal(done, false); gate.resolve(); const result = await checked; if (!hard) assert.equal(result, true);
  assert.throws(old.current.assertUsable); assert.equal(f.state.active, 0);
});

for (const method of ["receipt", "nonce", "call"]) for (const first of [0, 1])
  test(`old published ${method} disagreement survives retirement and both arrival orders: first=${first}`, async t => {
    const gates = [deferred(), deferred()], entered = deferred(); t.after(() => gates.forEach(gate => gate.resolve()));
    const f = lifecycleFixture(t, { future: false }); await f.ready(); const old = await f.acquire(); fastRetries(t); let starts = 0;
    const rpcMethod = method === "receipt" ? "eth_getTransactionReceipt" : method === "nonce" ? "eth_getTransactionCount" : "eth_call";
    f.state.hook = async row => {
      if (row.method === rpcMethod) {
        if (++starts === 2) entered.resolve(); await gates[row.alias].promise;
        if (method === "receipt") return row.alias === 0 ? null : minedReceipt();
        if (method === "nonce") return row.alias === 0 ? "0x7" : "0x8";
        if (row.alias === 0) return "0x1234"; throw new ExecutionError("CALL_REVERTED");
      }
      if (row.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT");
    };
    const read = (method === "receipt" ? old.current.receipt(hash(999)) : method === "nonce" ? old.current.nonce(address(1)) :
      old.current.call({ to: address(2), data: "0x1234" })).catch(error => error);
    await entered.promise; const failure = await failedAcquisition(f); let done = false;
    const retirement = f.factory.retireFailedAcquisition(failure).finally(() => { done = true; });
    const checked = assert.rejects(retirement, /RANK1_ACQUISITION_RETIREMENT_DENIED/);
    gates[first].resolve(); await turn(); assert.equal(done, false);
    gates[1 - first].resolve(); await read; await checked; assert.equal(f.state.active, 0); assert.throws(old.current.assertUsable);
  });

for (const hard of [false, true]) test(`provisional admission drains late physical retries before accepting the row: hard=${hard}`, async t => {
  const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
  const f = lifecycleFixture(t, { future: false }), timer = globalThis.setTimeout; let first = true;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => timer(fn, ms === 4000 ? 5 : ms === 150 ? 0 : ms, ...args));
  f.state.hook = async row => {
    if (first && row.alias === 0 && row.method === "eth_chainId") {
      first = false; entered.resolve(); await gate.promise; return hard ? "0x2" : "0x1";
    }
  };
  f.maintain(); await entered.promise; await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.maintain().selection, "HOLD"); assert.equal(traceCalls(f.state).length, 0);
  gate.resolve(); await turn(); const lease = await f.acquire(); assert.deepEqual(lease.current.evidence.aliases, hard ? [2, 3] : [1, 2]);
  f.state.hook = row => { if (row.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT"); };
  assert.equal(await f.factory.retireFailedAcquisition(await failedAcquisition(f)), true);
});

for (const source of ["provisional", "hint"])
  test(`background ${source} error identities never become acquisition authority`, async t => {
    const f = lifecycleFixture(t, { future: false }); fastRetries(t); const shared = new ExecutionError("RPC_TIMEOUT");
    f.state.hook = row => {
      if (row.alias === 0 && row.method === (source === "provisional" ? "eth_chainId" : "debug_traceCall")) throw shared;
    };
    f.maintain(); for (let i = 0; i < 15; i++) { await new Promise(resolve => setTimeout(resolve, 2)); if (f.maintain().selection === "READY") break; }
    assert.equal(f.maintain().selection, "READY"); await turn();
    f.state.hook = row => { if (row.method === "eth_chainId") throw shared; };
    await assert.rejects(f.factory.retireFailedAcquisition(await failedAcquisition(f)), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
  });

test("foreign failed-acquisition error is not a permit and does not contaminate this factory", async t => {
  const first = lifecycleFixture(t, { future: false }), second = lifecycleFixture(t, { future: false }); fastRetries(t);
  await first.ready(); await second.ready(); await second.acquire();
  first.state.hook = row => { if (row.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT"); };
  const foreign = await failedAcquisition(first);
  await assert.rejects(second.factory.retireFailedAcquisition(foreign), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
  second.state.hook = row => { if (row.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT"); };
  assert.equal(await second.factory.retireFailedAcquisition(await failedAcquisition(second)), true);
});

for (const domain of ["trace", "simulation", "hint"]) for (const hard of [false, true])
  test(`retirement drains old ${domain} semantic roots and late hard=${hard}`, async t => {
    const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
    const f = lifecycleFixture(t, { future: domain === "simulation" }); await f.ready(); fastRetries(t);
    const old = await f.acquire(); await turn();
    const proof = domain === "trace" ? await old.qualifyCurrentTrace() : domain === "simulation" ? old.takeFuture() : null;
    if (domain === "simulation") assert.ok(proof);
    f.state.hook = async row => {
      if (row.method === (domain === "simulation" ? "eth_simulateV1" : "debug_traceCall")) {
        entered.resolve(); await gate.promise;
        if (hard && row.alias === 0) return domain === "simulation" ? [] : frame(row.params[0], "0xdead");
      }
    };
    let operation = Promise.resolve();
    if (domain === "trace") operation = proof.trace(TX).catch(error => error);
    else if (domain === "simulation") operation = proof.nextBlock.simulate(TX).catch(error => error);
    else { f.advance(30000); f.state.head += 2; f.maintain(); }
    await entered.promise;
    const previous = f.state.hook;
    f.state.hook = row => { if (row.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT"); return previous(row); };
    const error = await failedAcquisition(f); let done = false;
    const retirement = f.factory.retireFailedAcquisition(error).finally(() => { done = true; });
    const checked = hard ? assert.rejects(retirement, /RANK1_ACQUISITION_RETIREMENT_DENIED/) : retirement;
    await turn(); assert.equal(done, false); gate.resolve(); await operation;
    const result = await checked; if (!hard) assert.equal(result, true);
    assert.throws(old.current.assertUsable); assert.equal(f.state.active, 0);
  });

for (const fault of ["context", "cleanup"]) test(`old published HTTP receipt drain preserves late ${fault} failure`, async t => {
  const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
  const f = lifecycleFixture(t, { http: true, future: false }); await f.ready(); const old = await f.acquire(); fastRetries(t);
  f.state.responseHook = (handle, config, body) => {
    if (body.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT");
    if (body.method !== "eth_getTransactionReceipt") return;
    if (fault === "cleanup") return new Response(new ReadableStream({ async cancel() {
      entered.resolve(); await gate.promise; throw new Error("SYNTHETIC_CLEANUP");
    } }), { status: 503 });
  };
  if (fault === "context") f.state.hook = async row => {
    if (row.method === "eth_getTransactionReceipt") { entered.resolve(); await gate.promise; return null; }
  };
  const operation = old.current.receipt(hash(999)).catch(error => error); await entered.promise;
  const error = await failedAcquisition(f); let done = false;
  const retirement = f.factory.retireFailedAcquisition(error).finally(() => { done = true; });
  const checked = assert.rejects(retirement, /RANK1_ACQUISITION_RETIREMENT_DENIED/);
  await turn(); assert.equal(done, false);
  if (fault === "context") f.state.origins.set(f.candidates[0].handle, "PRIVATE_CHANGED_ORIGIN");
  gate.resolve(); await operation; await checked; assert.equal(f.state.active, 0);
});

for (const http of [false, true]) for (const replay of [false, true]) for (const boundary of ["wrapper", "transport"])
  test(`dispatch-bound sibling cancellation preserves trust but cannot be replayed: HTTP=${http}, replay=${replay}, boundary=${boundary}`, async t => {
    const gate = deferred(), entered = deferred(); t.after(() => gate.resolve());
    const f = lifecycleFixture(t, { http, deferredDispatch: true }); await f.ready();
    const lease = await f.acquire(); await turn(); const future = lease.takeFuture(); assert.ok(future);
    let cancellation;
    f.state.dispatchHook = async (candidate, method, params, timeout, guard) => {
      if (method !== "debug_traceCall" || candidate.handle !== f.candidates[1].handle) return;
      entered.resolve(); await gate.promise;
      if (boundary === "wrapper") try { guard(); } catch (error) { cancellation = error; throw error; }
    };
    f.state.hook = row => { if (row.alias === 0 && row.method === "debug_traceCall") throw new ExecutionError("TRACE_METHOD_UNAVAILABLE"); };
    const calls = f.state.calls.length, fetches = f.state.fetches.length;
    f.state.dispatchFailures.length = 0;
    const checked = assert.rejects(lease.qualifyCurrentTrace(), { code: "TRACE_CAPABILITY_UNAVAILABLE" });
    await entered.promise; await turn(); gate.resolve(); await checked;
    if (boundary === "transport") cancellation = f.state.dispatchFailures.find(row => row.handle === f.candidates[1].handle && row.method === "debug_traceCall")?.error;
    assert.equal(cancellation?.code, "M1_HOT_PATH_CANCELLED");
    assert.equal(f.state.calls.slice(calls).filter(row => row.alias === 1 && row.method === "debug_traceCall").length, 0);
    if (http) assert.equal(f.state.fetches.slice(fetches).filter(row => row.handle === f.candidates[1].handle && row.method === "debug_traceCall").length, 0);
    lease.current.assertUsable(); future.assertUsable();
    f.state.dispatchHook = null; f.state.hook = () => undefined;
    const sibling = await f.acquire(); sibling.current.assertUsable(); await turn();
    if (replay) {
      if (boundary === "wrapper") f.state.dispatchHook = (candidate, method) => { if (method === "eth_chainId") throw cancellation; };
      else f.state.hook = row => { if (row.method === "eth_chainId") throw cancellation; };
      const rejected = await failedAcquisition(f);
      assert.notEqual(rejected, cancellation);
      f.state.dispatchHook = null; f.state.hook = () => undefined; f.advance(5000); await f.ready();
    }
    fastRetries(t); f.state.hook = row => { if (row.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT"); };
    const retirement = f.factory.retireFailedAcquisition(await failedAcquisition(f));
    if (replay) await assert.rejects(retirement, /RANK1_ACQUISITION_RETIREMENT_DENIED/);
    else assert.equal(await retirement, true);
  });

for (const code of ["RPC_TIMEOUT", "RPC_TRANSPORT_ERROR", "RPC_HTTP_RETRYABLE"])
  test(`deferred HTTP wrapper entry without observer-confirmed fetch grants no ${code} authority`, async t => {
    const f = lifecycleFixture(t, { http: true, deferredDispatch: true, future: false }); await f.ready(); fastRetries(t);
    const fetches = f.state.fetches.length; let entered = 0;
    f.state.dispatchHook = (candidate, method) => { if (method === "eth_chainId") { entered++; throw new ExecutionError(code); } };
    const error = await failedAcquisition(f); assert.ok(entered > 0); assert.equal(f.state.fetches.length, fetches);
    await assert.rejects(f.factory.retireFailedAcquisition(error), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
  });

for (const refresh of [false, true]) for (const fault of ["code", "canonical-header"]) for (const first of [0, 1])
  test(`fully qualified rows reconcile before publication: ${fault}, first=${first}, refresh=${refresh}`, async t => {
    const gates = [deferred(), deferred()], entered = deferred(); t.after(() => gates.forEach(gate => gate.resolve()));
    const f = lifecycleFixture(t, { future: false, count: 2 }); let old;
    if (refresh) { await f.ready(); old = await f.acquire(); f.advance(30000); f.state.head += 2; }
    let starts = 0;
    const response = (row, divergent) => {
      if (fault === "code" && row.method === "eth_getCode" && row.params[1].blockHash !== UNKNOWN) return divergent ? "0x6002" : "0x6001";
      if (fault === "canonical-header" && row.method === "eth_getBlockByNumber")
        return { ...header(row.params[0] === "latest" ? f.state.head : Number(BigInt(row.params[0]))), stateRoot: hash(divergent ? 88 : 7) };
    };
    f.state.hook = async row => {
      if (row.method === "eth_getBlockByNumber" && row.params[0] === hex(f.state.head)) {
        if (++starts === 2) entered.resolve(); await gates[row.alias].promise;
      }
      return response(row, row.alias === 1);
    };
    f.maintain(); await entered.promise;
    gates[first].resolve(); await turn(); gates[1 - first].resolve(); await turn();
    assert.equal(starts, 2); assert.equal(f.maintain().selection, "HOLD");
    if (old) assert.throws(old.current.assertUsable);
    // Later responses agree with the first fully admitted row; they cannot
    // erase the independent accepted witness's earlier contradictory facts.
    f.state.hook = row => response(row, first === 1); f.advance(5000); await f.ready();
    const healthy = await f.acquire(); healthy.current.assertUsable();
    fastRetries(t); f.state.hook = row => { if (row.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT"); return response(row, first === 1); };
    await assert.rejects(f.factory.retireFailedAcquisition(await failedAcquisition(f)), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
  });

for (const field of ["hash", "timestamp"]) for (const code of ["RPC_TIMEOUT", "RPC_FAILED", "WRONG_CHAIN", null])
  test(`cold header ${field} inspection exception is never a remote rejection: ${code}`, async t => {
    const f = lifecycleFixture(t, { future: false }); fastRetries(t); let inspected = 0;
    f.state.hook = row => {
      if (row.alias !== 0 || row.method !== "eth_getBlockByNumber") return;
      return Object.defineProperty(header(), field, { get() {
        inspected++; throw code ? new ExecutionError(code) : new Error("LOCAL_INSPECTION_FAILURE");
      } });
    };
    f.maintain(); for (let i = 0; i < 20 && f.maintain().selection !== "READY"; i++) await new Promise(resolve => setTimeout(resolve, 2));
    await f.ready(); assert.ok(inspected > 0); const lease = await f.acquire(); assert.deepEqual(lease.current.evidence.aliases, [2, 3]);
    f.state.hook = () => undefined; f.advance(30000); f.state.head += 2; await f.ready();
    f.state.hook = row => { if (row.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT"); };
    await assert.rejects(f.factory.retireFailedAcquisition(await failedAcquisition(f)), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
  });

for (const field of ["status", "read"]) for (const code of ["RPC_TIMEOUT", "RPC_FAILED"]) test(`cold HTTP ${field} getter stays local through normalization: ${code}`, async t => {
  const f = lifecycleFixture(t, { http: true, future: false }); fastRetries(t); let inspected = 0;
  f.state.responseHook = (handle, config, body) => {
    if (handle !== f.candidates[0].handle || body.method !== "eth_chainId") return;
    if (field === "read") return { status: 200, ok: true, body: { getReader: () => ({ closed: Promise.resolve(),
      get read() { inspected++; throw new ExecutionError(code); }, cancel: async () => {}, releaseLock() {} }) } };
    return { body: new Response("{}").body, get status() { inspected++; throw new ExecutionError(code); } };
  };
  f.maintain(); for (let i = 0; i < 20 && f.maintain().selection !== "READY"; i++) await new Promise(resolve => setTimeout(resolve, 2));
  await f.ready(); assert.ok(inspected > 0); f.state.responseHook = null;
  f.advance(30000); f.state.head += 2; await f.ready();
  f.state.hook = row => { if (row.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT"); };
  await assert.rejects(f.factory.retireFailedAcquisition(await failedAcquisition(f)), /RANK1_ACQUISITION_RETIREMENT_DENIED/);
});

for (const fault of ["json", "protocol", "header", "known-control"])
  test(`genuine cold ${fault} response rejection remains isolated`, async t => {
    const f = lifecycleFixture(t, { http: true, future: false });
    f.state.responseHook = (handle, config, body) => {
      if (handle !== f.candidates[0].handle) return;
      if (body.method === "eth_chainId" && fault === "json") return new Response("{");
      if (body.method === "eth_chainId" && fault === "protocol") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "request rejected" } }));
      if (body.method === "eth_getBlockByNumber" && fault === "header") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ...header(), stateRoot: "0x12" } }));
      if (body.method === "eth_getCode" && body.params[1].blockHash === UNKNOWN && fault === "known-control")
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x6001" }));
    };
    await f.ready(); const lease = await f.acquire(); assert.deepEqual(lease.current.evidence.aliases, [2, 3]);
    f.state.responseHook = null; fastRetries(t);
    f.state.hook = row => { if (row.method === "eth_chainId") throw new ExecutionError("RPC_TIMEOUT"); };
    assert.equal(await f.factory.retireFailedAcquisition(await failedAcquisition(f)), true);
  });
