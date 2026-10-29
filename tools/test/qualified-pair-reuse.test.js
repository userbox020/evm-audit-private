"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { ExecutionError } = require("../lib/wallet-execution-guard.js");
const { createQualifiedPairFactory, MULTICALL3, PROBE, MAX_CANDIDATES, QUALIFICATION_CONCURRENCY,
  REQUEST_TIMEOUT_MS } = require("../lib/executor-pinned-rpc.js");
const NOW = Date.parse("2026-10-24T02:00:01Z"), HEAD = 1000, TIME = NOW / 1000 - 1;
const hex = n => "0x" + BigInt(n).toString(16), hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const address = n => "0x" + BigInt(n).toString(16).padStart(40, "0"), UNKNOWN = "0x" + "f".repeat(64);
const TX = { type: 2, chainId: 1, from: address(1), to: address(2), data: "0x1234", value: "0x0", nonce: 7,
  gasLimit: 180000, maxFeePerGas: 200000000, maxPriorityFeePerGas: 1, accessList: [] };
const header = (number = HEAD) => ({ number: hex(number), hash: hash(number), parentHash: hash(number - 1), stateRoot: hash(7),
  timestamp: hex(TIME + (number - HEAD) * 12), baseFeePerGas: hex(100000000), gasLimit: hex(30000000) });
const ref = blockHash => ({ blockHash, requireCanonical: true });
function simulation(params) {
  const block = params[0].blockStateCalls[0], tx = block.calls[0];
  return [{ parentHash: params[1].blockHash, number: block.blockOverrides.number, timestamp: block.blockOverrides.time,
    transactions: [structuredClone(tx)], calls: [{ status: "0x1", gasUsed: hex(80000), logs: [],
      returnData: tx.to === null ? hash(BigInt(block.blockOverrides.number)) + hash(BigInt(block.blockOverrides.time)).slice(2) : "0x1234" }] }];
}
function fixture({ count = 4, families, ...options } = {}) {
  const candidates = Array.from({ length: count }, (_, i) => ({ handle: "SECRET_HANDLE_" + (i + 1),
    family: "SECRET_FAMILY_" + (families?.[i] ?? i + 1) }));
  const state = { now: NOW, tick: 0, head: HEAD, calls: [], active: 0, peak: 0, nonce: 7, code: "0x600160ab",
    modes: {}, hook: () => undefined };
  const counts = new Map();
  async function rpc(candidate, method, params, timeoutMs) {
    const alias = Number(/^SECRET_HANDLE_(\d+)/.exec(candidate.handle)?.[1]);
    assert.ok(alias > 0); assert.ok(Object.isFrozen(candidate));
    const key = alias + ":" + method + ":" + (typeof params[0] === "string" ? params[0] : "");
    const occurrence = (counts.get(key) ?? 0) + 1; counts.set(key, occurrence);
    const call = { alias, method, params: structuredClone(params), timeoutMs, occurrence }; state.calls.push(call);
    state.active++; state.peak = Math.max(state.peak, state.active);
    try {
      await Promise.resolve(); assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= REQUEST_TIMEOUT_MS);
      const changed = await state.hook(call); if (changed !== undefined) return changed;
      const mode = state.modes[alias];
      if (method === "eth_chainId") return mode === "wrong-chain" ? "0x2" : "0x1";
      if (method === "eth_getBlockByNumber") return header(params[0] === "latest" ? state.head : Number(BigInt(params[0])));
      if (["eth_call", "eth_getCode", "debug_traceCall", "eth_simulateV1"].includes(method)) {
        assert.deepEqual(params[1], ref(params[1].blockHash));
        if (method === "eth_getCode" && mode === "call-only") throw new Error("SECRET_PROVIDER_DETAIL");
        if (params[1].blockHash === UNKNOWN) throw new ExecutionError("UNKNOWN_BLOCK_REJECTED");
      }
      if (method === "eth_call") return params[0].to === MULTICALL3 ? hash(BigInt(params[1].blockHash)) : "0x1234";
      if (method === "eth_getCode") return state.code;
      if (method === "eth_estimateGas") return hex(80000);
      if (method === "eth_getTransactionCount") return hex(state.nonce);
      if (method === "eth_getBalance") return hex(2000000000000000n);
      if (method === "eth_getTransactionReceipt") return null;
      if (method === "debug_traceCall") {
        const tx = params[0];
        return { type: "CALL", from: tx.from, to: tx.to, input: tx.data, value: hex(tx.value ?? 0), calls: [],
          output: tx.to === MULTICALL3 ? hash(BigInt(params[1].blockHash)) : "0x1234" };
      }
      if (method === "eth_simulateV1") return simulation(params);
      assert.fail("UNPLANNED_METHOD");
    } finally { state.active--; }
  }
  const factory = createQualifiedPairFactory({ rpc, now: () => state.now, monotonic: () => state.tick, ...options });
  return { candidates, state, rpc, factory, acquire: (input = { candidates }) => factory.acquire(input) };
}
function safeRejection(code) {
  return error => {
    assert.ok(error instanceof ExecutionError); assert.equal(error.code, code); assert.equal(error.message, code);
    assert.doesNotMatch(error.stack + JSON.stringify(error), /SECRET_|UNTRUSTED/); return true;
  };
}
const used = calls => [...new Set(calls.map(call => call.alias))].sort((a, b) => a - b);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const originalFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = () => { throw new Error("OFFLINE_NETWORK_FORBIDDEN"); }; });
test.after(() => { globalThis.fetch = originalFetch; });

test("factory is synchronous, strict-only, fixed-profile and validates bounded TTL/options without RPC", async () => {
  const f = fixture(); assert.equal(typeof f.factory.acquire, "function"); assert.equal(f.factory.then, undefined);
  for (const options of [{ ttlMs: 0 }, { ttlMs: -1 }, { ttlMs: 60001 }, { ttlMs: Infinity }, { ttlMs: NaN }, { ttlMs: "60" },
    { monotonic: null }, { now: 1 }, { rpc: null }, { requireStrictEvidence: false }, { requireStrictEvidence: "true" },
    { requireTrace: 1 }, { requireNextBlock: null }, { allowFallback: true }])
    assert.throws(() => createQualifiedPairFactory({ rpc: f.rpc, ...options }), safeRejection("QUALIFIED_PAIR_OPTIONS_INVALID"));
  for (const options of [{ requireNextBlock: false }, { requireStrictEvidence: false }, { rpc: f.rpc }, { ttlMs: 1 }])
    await assert.rejects(f.acquire({ candidates: f.candidates, ...options }), safeRejection("QUALIFIED_PAIR_OPTIONS_INVALID"));
  await assert.rejects(f.acquire({ candidates: Array(MAX_CANDIDATES + 1).fill(f.candidates[0]) }), safeRejection("RPC_CANDIDATES_INVALID"));
  assert.equal(f.state.calls.length, 0);
});

test("cold finishes the entire bounded pool before selection; warm requalifies exactly the original pair", async () => {
  const f = fixture({ count: MAX_CANDIDATES, families: ["a", "z", "z", "y"] });
  f.state.modes[1] = "call-only";
  const completed = new Set();
  f.state.hook = call => {
    if (call.method === "eth_chainId" && call.occurrence > 1) assert.equal(completed.size, MAX_CANDIDATES);
    if (call.method === "eth_getCode" && (call.params[1].blockHash === UNKNOWN || call.alias === 1)) completed.add(call.alias);
  };
  const cold = await f.acquire();
  assert.deepEqual(cold.evidence.aliases, [2, 4]); assert.equal(cold.evidence.qualificationReuse, "COLD_FULL_POOL");
  assert.equal(cold.evidence.qualification.length, MAX_CANDIDATES); assert.equal(f.state.peak, QUALIFICATION_CONCURRENCY);
  f.state.hook = () => undefined; f.state.now += 12000; f.state.head++; f.state.tick = 12000;
  const before = f.state.calls.length, warm = await f.acquire();
  assert.deepEqual(used(f.state.calls.slice(before)), [2, 4]); assert.equal(f.state.active, 0);
  assert.equal(warm.evidence.qualificationReuse, "WARM_PAIR_REQUALIFICATION"); assert.deepEqual(warm.evidence.aliases, [2, 4]);
  assert.deepEqual(warm.evidence.qualification.map(row => row.alias), [2, 4]);
  assert.notEqual(warm, cold); assert.notEqual(warm.pin, cold.pin); assert.notEqual(warm.collectorOptions, cold.collectorOptions);
  assert.equal(warm.pin.number, HEAD + 1); assert.equal(cold.pin.number, HEAD); assert.ok(Object.isFrozen(warm.pin));
  for (const row of warm.evidence.qualification) assert.equal(row.strictProbePin.number, HEAD);
});

test("warm aliases preserve original pool ordering when prior selection head order reverses", async () => {
  const f = fixture(); f.state.hook = call => call.alias !== 4 && call.method === "eth_getBlockByNumber" && call.params[0] === "latest"
    ? header(HEAD - 1) : undefined;
  const first = await f.acquire(); assert.deepEqual(first.evidence.aliases, [4, 1]);
  f.state.hook = () => undefined;
  const warm = await f.acquire(); assert.deepEqual(warm.evidence.aliases, [1, 4]);
  assert.deepEqual(warm.evidence.qualification.map(row => row.alias), [1, 4]);
});

test("every warm strict probe, code read and requested trace is freshly executed", async () => {
  const f = fixture({ requireTrace: true }), cold = await f.acquire();
  assert.equal(await cold.code(address(9)), "0x600160ab");
  f.state.code = "0x600260cd"; f.state.nonce = 9; f.state.now += 12000; f.state.head++;
  const before = f.state.calls.length, warm = await f.acquire(), calls = f.state.calls.slice(before);
  for (const alias of [1, 2]) {
    const rows = calls.filter(call => call.alias === alias);
    assert.deepEqual(rows.filter(call => call.method === "eth_getCode").map(call => call.params[1].blockHash), [hash(HEAD), hash(HEAD + 1), UNKNOWN]);
    assert.deepEqual(rows.filter(call => call.method === "eth_call").map(call => call.params[1].blockHash),
      [hash(HEAD + 1), hash(HEAD), UNKNOWN, hash(HEAD), hash(HEAD + 1)]);
    assert.deepEqual(rows.filter(call => call.method === "debug_traceCall").map(call => call.params[1].blockHash), [hash(HEAD), UNKNOWN, hash(HEAD + 1)]);
  }
  assert.equal(await warm.code(address(9)), "0x600260cd"); assert.equal(await warm.nonce(TX.from), "0x9");
  assert.equal((await warm.trace(TX)).tree.output, "0x1234");
});

test("warm next-block qualification repeats nonce/balance and both controls with a new immutable context", async () => {
  const f = fixture({ requireNextBlock: true, requireTrace: true }), cold = await f.acquire();
  f.state.head++; f.state.now += 12000; f.state.tick += 12000; f.state.nonce = 11;
  const before = f.state.calls.length, warm = await f.acquire(), calls = f.state.calls.slice(before);
  assert.notEqual(cold.nextBlock, warm.nextBlock); assert.notEqual(cold.nextBlock.context, warm.nextBlock.context);
  assert.equal(warm.nextBlock.context.parentNumber, HEAD + 1); assert.equal(warm.nextBlock.context.parentHash, warm.pin.hash);
  assert.equal(warm.nextBlock.context.timestamp, TIME + 24); assert.ok(Object.isFrozen(warm.nextBlock.context));
  for (const alias of [1, 2]) {
    const rows = calls.filter(call => call.alias === alias);
    for (const method of ["eth_getTransactionCount", "eth_getBalance"]) {
      const reads = rows.filter(call => call.method === method); assert.equal(reads.length, 1);
      assert.deepEqual(reads[0].params[1], ref(warm.pin.hash));
    }
    const simulations = rows.filter(call => call.method === "eth_simulateV1"); assert.equal(simulations.length, 3);
    assert.deepEqual(simulations.map(call => call.params[0].blockStateCalls[0].blockOverrides.time), [TIME + 36, TIME + 24, TIME + 24].map(hex));
    assert.ok(simulations.every(call => call.params[0].blockStateCalls[0].calls[0].nonce === "0xb"));
  }
  const proof1 = await warm.nextBlock.simulate({ ...TX, nonce: 11 }), proof2 = await warm.nextBlock.simulate({ ...TX, nonce: 12 });
  assert.notEqual(proof1, proof2); assert.equal(proof2.context.transaction.nonce, "0xc");
  assert.doesNotMatch(JSON.stringify(warm.evidence), /nonce|transaction|profit|SECRET_/i);
});

test("current-only measurement acquires fresh pins and never requests nonce/balance/simulation", async () => {
  const f = fixture(); await f.acquire(); const warm = await f.acquire();
  assert.equal(warm.nextBlock, undefined); assert.equal(warm.trace, undefined);
  assert.equal(f.state.calls.some(call => ["eth_getTransactionCount", "eth_getBalance", "eth_simulateV1"].includes(call.method)), false);
  assert.doesNotMatch(JSON.stringify(warm.evidence), /nonce|balance|transaction|profit|SECRET_/i);
});

test("TTL is non-sliding and expires exactly at the cold-start boundary", async () => {
  const f = fixture(); await f.acquire();
  for (const time of [1, 30000, 59999]) { f.state.tick = time; assert.equal((await f.acquire()).evidence.qualificationReuse, "WARM_PAIR_REQUALIFICATION"); }
  f.state.tick = 60000; const before = f.state.calls.length;
  assert.equal((await f.acquire()).evidence.qualificationReuse, "COLD_FULL_POOL"); assert.deepEqual(used(f.state.calls.slice(before)), [1, 2, 3, 4]);
  f.state.tick = 60001; assert.equal((await f.acquire()).evidence.qualificationReuse, "WARM_PAIR_REQUALIFICATION");
});

for (const duration of [59999, 60000, 60001]) test(`cold qualification duration ${duration}ms counts toward TTL`, async () => {
  const f = fixture(); f.state.hook = () => { f.state.tick = duration; };
  assert.equal((await f.acquire()).evidence.qualificationReuse, "COLD_FULL_POOL"); f.state.hook = () => undefined;
  assert.equal((await f.acquire()).evidence.qualificationReuse, duration < 60000 ? "WARM_PAIR_REQUALIFICATION" : "COLD_FULL_POOL");
});

test("custom TTL and expiry during warm acquisition do not extend eligibility", async () => {
  const f = fixture({ ttlMs: 10 }); await f.acquire(); f.state.tick = 9;
  f.state.hook = () => { f.state.tick = 10; };
  assert.equal((await f.acquire()).evidence.qualificationReuse, "WARM_PAIR_REQUALIFICATION");
  f.state.hook = () => undefined; assert.equal((await f.acquire()).evidence.qualificationReuse, "COLD_FULL_POOL");
});

for (const value of [-1, NaN, Infinity, 5]) test(`monotonic anomaly ${value} invalidates and requires a subsequent cold acquisition`, async () => {
  const f = fixture(); f.state.tick = 10; await f.acquire(); f.state.tick = value;
  await assert.rejects(f.acquire(), safeRejection("QUALIFIED_PAIR_CLOCK_INVALID"));
  f.state.tick = 20; assert.equal((await f.acquire()).evidence.qualificationReuse, "COLD_FULL_POOL");
});

test("clock failures during acquisition cannot publish selection or leak callback errors", async () => {
  const f = fixture(); f.state.hook = () => { f.state.tick = NaN; };
  await assert.rejects(f.acquire(), safeRejection("QUALIFIED_PAIR_CLOCK_INVALID")); f.state.tick = 0; f.state.hook = () => undefined;
  assert.equal((await f.acquire()).evidence.qualificationReuse, "COLD_FULL_POOL");
  const factory = createQualifiedPairFactory({ rpc: f.rpc, monotonic: () => { throw new Error("SECRET_CLOCK"); } });
  await assert.rejects(factory.acquire({ candidates: f.candidates }), safeRejection("QUALIFIED_PAIR_CLOCK_INVALID"));
});

for (const change of ["reorder", "replace", "handle-inplace", "family-inplace", "unselected-inplace"])
  test(`inventory ${change} invalidates the entire cached selection`, async () => {
    const f = fixture(); await f.acquire();
    if (change === "reorder") f.candidates.reverse();
    if (change === "replace") f.candidates[0] = { ...f.candidates[0], handle: f.candidates[0].handle + "_REPLACED" };
    if (change === "handle-inplace") f.candidates[0].handle += "_EDITED";
    if (change === "family-inplace") f.candidates[0].family += "_EDITED";
    if (change === "unselected-inplace") f.candidates[3].handle += "_EDITED";
    const before = f.state.calls.length; assert.equal((await f.acquire()).evidence.qualificationReuse, "COLD_FULL_POOL");
    assert.deepEqual(used(f.state.calls.slice(before)), [1, 2, 3, 4]);
  });

test("equal inventory values in new objects reuse selection; public evidence edits cannot alter it", async () => {
  const f = fixture(), first = await f.acquire(); first.evidence.aliases.splice(0, 2, 3, 4);
  first.evidence.qualification.length = 0; first.assertUsable = () => { throw new Error("SECRET_REPLACEMENT"); };
  const before = f.state.calls.length, warm = await f.acquire({ candidates: f.candidates.map(c => ({ ...c })) });
  assert.equal(warm.evidence.qualificationReuse, "WARM_PAIR_REQUALIFICATION"); assert.deepEqual(warm.evidence.aliases, [1, 2]);
  assert.deepEqual(used(f.state.calls.slice(before)), [1, 2]);
});

test("unsupported nested handles, accessors and mutable opaque shapes fail closed before RPC", async () => {
  const f = fixture(); await f.acquire(); const before = f.state.calls.length;
  for (const handle of [{ url: "SECRET_NESTED", headers: { authorization: "SECRET_AUTH" } }, ["SECRET_ARRAY"], new Map(), () => "SECRET_FN", null])
    await assert.rejects(f.acquire({ candidates: [{ ...f.candidates[0], handle }, f.candidates[1]] }), safeRejection("RPC_CANDIDATES_INVALID"));
  const candidate = { family: "SECRET_FAMILY" }; Object.defineProperty(candidate, "handle", { get: () => { throw new Error("SECRET_GETTER"); } });
  await assert.rejects(f.acquire({ candidates: [candidate, f.candidates[1]] }), safeRejection("RPC_CANDIDATES_INVALID"));
  const input = {}; Object.defineProperty(input, "candidates", { get: () => { throw new Error("SECRET_GETTER"); } });
  await assert.rejects(f.acquire(input), safeRejection("QUALIFIED_PAIR_OPTIONS_INVALID"));
  assert.equal(f.state.calls.length, before); assert.equal((await f.acquire()).evidence.qualificationReuse, "COLD_FULL_POOL");
});

test("mutation during acquisition rejects its cache commit while session RPC candidates remain isolated", async () => {
  const f = fixture(); let changed = false;
  f.state.hook = () => { if (!changed) { changed = true; f.candidates[0].handle += "_CHANGED"; } };
  await assert.rejects(f.acquire(), safeRejection("QUALIFIED_PAIR_INVENTORY_CHANGED")); assert.equal(f.state.active, 0);
  f.state.hook = () => undefined; assert.equal((await f.acquire()).evidence.qualificationReuse, "COLD_FULL_POOL");
});

const warmFailures = [
  ["wrong-chain", "TWO_STRICT_CAPABLE_FAMILIES_REQUIRED", c => c.method === "eth_chainId" ? "0x2" : undefined],
  ["malformed-header", "TWO_STRICT_CAPABLE_FAMILIES_REQUIRED", c => c.method === "eth_getBlockByNumber" ? { ...header(), hash: "SECRET_INVALID" } : undefined],
  ["future-header", "TWO_STRICT_CAPABLE_FAMILIES_REQUIRED", c => c.method === "eth_getBlockByNumber" ? { ...header(), timestamp: hex(NOW / 1000 + 1) } : undefined],
  ["ignored-call-hash", "TWO_STRICT_CAPABLE_FAMILIES_REQUIRED", c => c.method === "eth_call" ? hash(HEAD) : undefined],
  ["accepted-unknown-code", "TWO_STRICT_CAPABLE_FAMILIES_REQUIRED", c => c.method === "eth_getCode" && c.params[1].blockHash === UNKNOWN ? "0x6001" : undefined],
  ["malformed-code", "TWO_STRICT_CAPABLE_FAMILIES_REQUIRED", c => c.method === "eth_getCode" ? "0x1" : undefined],
  ["pair-header-disagreement", "PIN_HASH_DISAGREEMENT", c => c.method === "eth_getBlockByNumber" ? { ...header(c.params[0] === "latest" ? HEAD : Number(BigInt(c.params[0]))), stateRoot: hash(99) } : undefined]
];
for (const [name, code, fail] of warmFailures) test(`warm ${name} evicts without same-acquisition fallback; next explicit acquisition is cold`, async () => {
  const f = fixture(); await f.acquire(); const before = f.state.calls.length;
  f.state.hook = call => call.alias === 2 ? fail(call) : undefined;
  await assert.rejects(f.acquire(), safeRejection(code)); assert.equal(f.state.active, 0);
  assert.deepEqual(used(f.state.calls.slice(before)), [1, 2]);
  f.state.hook = () => undefined; const recovery = f.state.calls.length;
  assert.equal((await f.acquire()).evidence.qualificationReuse, "COLD_FULL_POOL"); assert.deepEqual(used(f.state.calls.slice(recovery)), [1, 2, 3, 4]);
});

test("warm trace and next-block capability failures never silently downgrade their fixed profiles", async () => {
  for (const [options, method] of [[{ requireTrace: true }, "debug_traceCall"], [{ requireNextBlock: true }, "eth_simulateV1"]]) {
    const f = fixture(options); await f.acquire(); const before = f.state.calls.length;
    f.state.hook = call => { if (call.alias === 2 && call.method === method) throw new Error("SECRET_UNSUPPORTED"); };
    await assert.rejects(f.acquire(), safeRejection("TWO_STRICT_CAPABLE_FAMILIES_REQUIRED"));
    assert.deepEqual(used(f.state.calls.slice(before)), [1, 2]);
    f.state.hook = () => undefined; assert.equal((await f.acquire()).evidence.qualificationReuse, "COLD_FULL_POOL");
  }
});

test("warm next-block admission still rejects the exact parent deadline with no alternative-pair fallback", async () => {
  const f = fixture({ requireNextBlock: true }); await f.acquire(); f.state.now = (TIME + 12) * 1000;
  const before = f.state.calls.length;
  await assert.rejects(f.acquire(), safeRejection("NEXT_BLOCK_DEADLINE")); assert.deepEqual(used(f.state.calls.slice(before)), [1, 2]);
  f.state.head++; assert.equal((await f.acquire()).evidence.qualificationReuse, "COLD_FULL_POOL");
});

test("old parent poison after a warm pass invalidates selection but never rehabilitates the poisoned session", async () => {
  const f = fixture(), old = await f.acquire(); await f.acquire();
  f.state.hook = call => call.alias === 2 && call.method === "eth_getCode" && call.params[0] === TX.to ? "0x6002" : undefined;
  await assert.rejects(old.code(TX.to), safeRejection("PROVIDER_RESULT_DISAGREEMENT"));
  assert.throws(old.assertUsable, safeRejection("PIN_EVIDENCE_INVALIDATED")); f.state.hook = () => undefined;
  assert.equal((await f.acquire()).evidence.qualificationReuse, "COLD_FULL_POOL");
  await assert.rejects(old.call(TX), safeRejection("PIN_EVIDENCE_INVALIDATED"));
});

for (const method of ["recheck", "simulate"]) test(`child-only ${method} poison evicts selection without poisoning the current-state parent`, async () => {
  const f = fixture({ requireNextBlock: true }), old = await f.acquire(); await f.acquire();
  if (method === "recheck") f.state.now = (TIME + 12) * 1000;
  else f.state.hook = call => call.alias === 2 && call.method === "eth_simulateV1" && call.params[0].blockStateCalls[0].calls[0].to !== null
    ? [{ ...simulation(call.params)[0], transactions: [] }] : undefined;
  await assert.rejects(method === "recheck" ? old.nextBlock.recheck() : old.nextBlock.simulate(TX),
    safeRejection(method === "recheck" ? "NEXT_BLOCK_DEADLINE" : "NEXT_BLOCK_RESULT_INVALID"));
  old.assertUsable(); assert.equal(await old.call(TX), "0x1234");
  f.state.hook = () => undefined; f.state.now = NOW;
  assert.equal((await f.acquire()).evidence.qualificationReuse, "COLD_FULL_POOL");
  await assert.rejects(old.nextBlock.recheck(), safeRejection("NEXT_BLOCK_EVIDENCE_INVALIDATED")); old.assertUsable();
});

test("collector poison is observed; public assertUsable replacement cannot conceal internal poison", async () => {
  const f = fixture(), old = await f.acquire(), original = old.assertUsable; old.assertUsable = () => {};
  f.state.hook = call => call.alias === 2 && call.method === "eth_call" && call.params[0].to === TX.to ? "0xabcd" : undefined;
  await assert.rejects(old.collectorOptions.rpcCall("PINNED_ETHEREUM", "eth_call", [TX, old.pin.hash]), safeRejection("PROVIDER_RESULT_DISAGREEMENT"));
  assert.throws(original, safeRejection("PIN_EVIDENCE_INVALIDATED")); f.state.hook = () => undefined;
  assert.equal((await f.acquire()).evidence.qualificationReuse, "COLD_FULL_POOL");
});

test("advisory live-head failure does not poison eligibility or change the immutable pin", async () => {
  const f = fixture(), api = await f.acquire(), pin = api.pin;
  f.state.hook = call => { if (call.timeoutMs === 1500) throw new Error("SECRET_ADVISORY"); };
  await assert.rejects(api.liveHeadNumber(), safeRejection("PINNED_RPC_FAILED")); api.assertUsable(); assert.equal(api.pin, pin);
  f.state.hook = () => undefined; assert.equal((await f.acquire()).evidence.qualificationReuse, "WARM_PAIR_REQUALIFICATION");
});

test("deterministic call and child simulation reverts preserve ordinary session semantics and eligibility", async () => {
  const f = fixture({ requireNextBlock: true }), api = await f.acquire();
  f.state.hook = call => {
    if (call.method === "eth_call" && call.params[0].to === TX.to) throw new ExecutionError("CALL_REVERTED");
    if (call.method === "eth_simulateV1" && call.params[0].blockStateCalls[0].calls[0].to === TX.to) throw new ExecutionError("NEXT_BLOCK_REVERTED");
  };
  await assert.rejects(api.call(TX), safeRejection("CALL_REVERTED"));
  await assert.rejects(api.nextBlock.simulate(TX), safeRejection("NEXT_BLOCK_REVERTED")); api.assertUsable(); await api.nextBlock.recheck();
  f.state.hook = () => undefined; assert.equal((await f.acquire()).evidence.qualificationReuse, "WARM_PAIR_REQUALIFICATION");
});

test("concurrent acquisitions serialize cold/warm passes and return distinct sessions", async () => {
  const f = fixture(), entered = deferred(), release = deferred(); let held = false;
  f.state.hook = async call => {
    if (!held && call.alias === 1 && call.method === "eth_chainId") { held = true; entered.resolve(); await release.promise; }
  };
  const first = f.acquire(), second = f.acquire(); await entered.promise; await turn();
  assert.equal(f.state.calls.filter(call => call.alias === 1 && call.method === "eth_chainId").length, 1);
  release.resolve(); const [a, b] = await Promise.all([first, second]);
  assert.equal(a.evidence.qualificationReuse, "COLD_FULL_POOL"); assert.equal(b.evidence.qualificationReuse, "WARM_PAIR_REQUALIFICATION");
  assert.notEqual(a, b); assert.notEqual(a.pin, b.pin); assert.equal(f.state.active, 0);
});

test("fail-fast final refresh drains its delayed sibling and all continuations before rejecting or starting the queued cold pass", async () => {
  const f = fixture(); await f.acquire();
  const entered = deferred(), release = deferred(); let firstSettled = false, failed = false;
  f.state.hook = async call => {
    // Cold and warm each read chainId twice. The fourth occurrence is warm final refresh.
    if (call.method === "eth_chainId" && call.occurrence === 4) {
      if (call.alias === 1) { failed = true; return "0x2"; }
      if (call.alias === 2) { entered.resolve(); await release.promise; }
    }
  };
  const failing = f.acquire(); const checked = assert.rejects(failing, safeRejection("WRONG_CHAIN"));
  failing.then(() => { firstSettled = true; }, () => { firstSettled = true; });
  const queued = f.acquire(); await entered.promise; await turn();
  assert.equal(failed, true); assert.equal(firstSettled, false); assert.equal(f.state.active, 1);
  const calls = f.state.calls.length; await turn(); assert.equal(f.state.calls.length, calls);
  release.resolve(); await checked; const recovered = await queued;
  assert.equal(recovered.evidence.qualificationReuse, "COLD_FULL_POOL"); assert.equal(f.state.active, 0);
  assert.equal(f.state.calls.filter(call => call.alias === 2 && call.method === "eth_getBlockByNumber" && call.params[0] === "latest").length, 5);
});

test("a retry backoff left by fail-fast acquisition cannot issue RPC into the next pass", async t => {
  const f = fixture(); await f.acquire(); const backoff = deferred(), release = deferred(), originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    if (ms === 150) { backoff.resolve(); release.promise.then(callback); return 0; }
    return originalTimeout(callback, ms, ...args);
  });
  f.state.hook = async call => {
    if (call.method === "eth_chainId" && call.occurrence === 4) {
      if (call.alias === 2) throw new ExecutionError("RPC_TIMEOUT");
      if (call.alias === 1) { await backoff.promise; return "0x2"; }
    }
  };
  await assert.rejects(f.acquire(), safeRejection("WRONG_CHAIN")); f.state.hook = () => undefined;
  assert.equal((await f.acquire()).evidence.qualificationReuse, "COLD_FULL_POOL");
  const before = f.state.calls.length; release.resolve(); await turn();
  assert.equal(f.state.calls.length, before); assert.equal(f.state.active, 0);
});

for (const action of ["invalidate", "close"]) test(`${action} during acquire drains and prevents stale publication`, async () => {
  const f = fixture(), entered = deferred(), release = deferred(); let held = false;
  f.state.hook = async call => {
    if (!held && call.alias === 1 && call.method === "eth_chainId") { held = true; entered.resolve(); await release.promise; }
  };
  const acquisition = f.acquire(), checked = assert.rejects(acquisition, safeRejection(action === "close" ? "QUALIFIED_PAIR_CLOSED" : "QUALIFIED_PAIR_INVALIDATED"));
  await entered.promise; f.factory[action](); release.resolve(); await checked; assert.equal(f.state.active, 0);
  f.state.hook = () => undefined;
  if (action === "close") {
    const before = f.state.calls.length; f.factory.invalidate(); f.factory.close();
    await assert.rejects(f.acquire(), safeRejection("QUALIFIED_PAIR_CLOSED")); assert.equal(f.state.calls.length, before);
  } else assert.equal((await f.acquire()).evidence.qualificationReuse, "COLD_FULL_POOL");
});

test("late operations on an invalidated old session cannot evict or publish the new cold generation", async () => {
  const f = fixture({ requireNextBlock: true }), old = await f.acquire(); f.factory.invalidate(); await f.acquire();
  f.state.hook = call => call.method === "eth_simulateV1" && call.params[0].blockStateCalls[0].calls[0].to === TX.to ? [] : undefined;
  await assert.rejects(old.nextBlock.simulate(TX), safeRejection("NEXT_BLOCK_RESULT_INVALID")); f.state.hook = () => undefined;
  assert.equal((await f.acquire()).evidence.qualificationReuse, "WARM_PAIR_REQUALIFICATION");
  f.factory.close(); old.assertUsable(); assert.equal(await old.call(TX), "0x1234");
  await assert.rejects(f.acquire(), safeRejection("QUALIFIED_PAIR_CLOSED"));
});

test("old-session failure during warm acquisition prevents publishing a stale lineage", async () => {
  const f = fixture(), old = await f.acquire(), entered = deferred(), release = deferred(); let held = false;
  f.state.hook = async call => {
    if (!held && call.method === "eth_chainId") { held = true; entered.resolve(); await release.promise; }
    if (call.method === "eth_call" && call.params[0].to === TX.to && call.alias === 2) return "0xabcd";
  };
  const warm = f.acquire(), checked = assert.rejects(warm, safeRejection("QUALIFIED_PAIR_INVALIDATED")); await entered.promise;
  await assert.rejects(old.call(TX), safeRejection("PROVIDER_RESULT_DISAGREEMENT")); release.resolve(); await checked;
  f.state.hook = () => undefined; assert.equal((await f.acquire()).evidence.qualificationReuse, "COLD_FULL_POOL");
});

test("serialization exposes no inventory/family/handle markers, cached nonce, or provider error detail", async () => {
  const f = fixture({ requireNextBlock: true }), cold = await f.acquire(), warm = await f.acquire();
  for (const value of [f.factory, cold, warm, cold.evidence, warm.evidence])
    assert.doesNotMatch(JSON.stringify(value), /SECRET_|nonce|profit|transactions/i);
  f.state.hook = () => { throw new Error("SECRET_PROVIDER_ERROR"); };
  await assert.rejects(f.acquire(), safeRejection("TWO_STRICT_CAPABLE_FAMILIES_REQUIRED"));
  const fresh = createQualifiedPairFactory({ rpc: f.rpc, now: () => NOW, monotonic: () => 0 }); f.state.hook = () => undefined;
  assert.equal((await fresh.acquire({ candidates: f.candidates })).evidence.qualificationReuse, "COLD_FULL_POOL");
});
