"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { ExecutionError } = require("../lib/wallet-execution-guard.js");
const { createPinnedRpc, MAX_CANDIDATES, QUALIFICATION_CONCURRENCY, REQUEST_TIMEOUT_MS, MAX_AGE_MS,
  MULTICALL3, PROBE } = require("../lib/executor-pinned-rpc.js");
const NOW = Date.parse("2026-10-20T00:30:00Z"), START = 1000;
const hex = n => "0x" + BigInt(n).toString(16), hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const UNKNOWN = "0x" + "f".repeat(64), TX = { from: "0x" + "11".repeat(20), to: "0x" + "22".repeat(20), data: "0x1234", value: "0x0" };

// Virtual elapsed time is advanced once per concurrent slow-request wave. Each
// request consumes only 3s (<4s timeout), but the full 32-candidate pool takes 72s.
// Three initially fast capable families finish before the remaining candidates.
// No real transport, provider inventory, keys, waits or filesystem writes.
function fixture(options = {}) {
  const count = options.count ?? MAX_CANDIDATES;
  const candidates = Array.from({ length: count }, (_, i) => ({ handle: "OFFLINE_" + (i + 1),
    family: ["z-selected", "y-selected", "a-fallback"][i] ?? "slow-" + i }));
  const state = { now: NOW, calls: [], active: 0, peak: 0, qualificationDone: new Set(),
    latestCounts: new Map(), chainCounts: new Map(), phase: "constructing", headOverride: null };
  let pending = [], scheduled = false;
  function slowWave() {
    return new Promise(resolve => {
      pending.push(resolve);
      if (!scheduled) {
        scheduled = true;
        setImmediate(() => {
          const wave = pending; pending = []; scheduled = false;
          state.now += 3000; wave.forEach(done => done());
        });
      }
    });
  }
  const head = () => START + Math.floor((state.now - NOW) / 12000);
  const header = number => ({ number: hex(number), hash: hash(number), parentHash: hash(number - 1), stateRoot: hash(7),
    timestamp: hex(NOW / 1000 - 12 + (number - START) * 12), baseFeePerGas: hex(100000000) });
  async function rpc(candidate, method, params, timeoutMs) {
    const alias = candidates.indexOf(candidate) + 1, slow = alias > 3;
    const call = { alias, method, params: structuredClone(params), timeoutMs, time: state.now, completedQualifications: state.qualificationDone.size };
    state.calls.push(call); state.active++; state.peak = Math.max(state.peak, state.active);
    try {
      assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= REQUEST_TIMEOUT_MS);
      if (slow) await slowWave(); else await Promise.resolve();
      if (method === "eth_chainId") {
        const occurrence = (state.chainCounts.get(alias) ?? 0) + 1; state.chainCounts.set(alias, occurrence);
        return options.chain?.({ alias, occurrence, state }) ?? "0x1";
      }
      if (method === "eth_getBlockByNumber") {
        if (params[0] === "latest") {
          const occurrence = (state.latestCounts.get(alias) ?? 0) + 1; state.latestCounts.set(alias, occurrence);
          const number = occurrence === 1 && !slow ? (options.initialHeads?.[alias] ?? START - (alias === 3 ? 1 : 0))
            : state.headOverride ?? head();
          return options.latest?.({ alias, occurrence, state, header, number }) ?? header(number);
        }
        const number = Number(BigInt(params[0]));
        return options.numbered?.({ alias, state, header, number }) ?? header(number);
      }
      if (method === "eth_call" || method === "eth_estimateGas") {
        assert.deepEqual(params[1], { blockHash: params[1].blockHash, requireCanonical: true });
        if (slow) { state.qualificationDone.add(alias); throw new Error("OFFLINE_PIN_UNAVAILABLE"); }
        if (params[0].to === MULTICALL3) {
          if (!options.requireTrace) state.qualificationDone.add(alias);
          return options.probe?.({ alias, state, params }) ?? hash(BigInt(params[1].blockHash));
        }
        return method === "eth_estimateGas" ? "0x10000" : "0x1234";
      }
      if (method === "debug_traceCall") {
        assert.deepEqual(params[1], { blockHash: params[1].blockHash, requireCanonical: true });
        assert.deepEqual(params[2], { tracer: "callTracer", timeout: "3s", tracerConfig: { onlyTopCall: false } });
        if (params[1].blockHash === UNKNOWN) { state.qualificationDone.add(alias); throw new ExecutionError("UNKNOWN_BLOCK_REJECTED"); }
        const tx = params[0];
        return { type: "CALL", from: tx.from, to: tx.to, input: tx.data, output: tx.to === MULTICALL3 ? hash(BigInt(params[1].blockHash)) : "0x1234", value: "0x0", calls: [] };
      }
      assert.fail("Unexpected method: " + method);
    } finally { state.active--; }
  }
  return { state, candidates, head, header,
    connect: () => createPinnedRpc({ candidates, rpc, now: () => state.now, requireTrace: options.requireTrace ?? false }) };
}

for (const requireTrace of [false, true]) test(`delayed full-pool qualification acquires fresh same-pair pin (trace=${requireTrace})`, async t => {
  const f = fixture({ requireTrace }), api = await f.connect();
  t.diagnostic(`virtual qualification elapsed=${f.state.now - NOW}ms; acquired=${api.pin.number}; currentHead=${f.head()}; pinAge=${f.state.now - api.pin.timestamp * 1000}ms`);
  await api.recheck();
  assert.equal(f.state.now - NOW, 72000); assert.equal(f.head(), START + 6);
  assert.equal(api.pin.number, f.head()); assert.equal(api.pin.hash, hash(f.head()));
  assert.deepEqual(api.evidence.aliases, [1, 2]); assert.equal(api.evidence.qualification.length, MAX_CANDIDATES);
  assert.equal(api.evidence.qualification.filter(q => q.qualified).length, 3);
  assert.equal(f.state.peak, QUALIFICATION_CONCURRENCY); assert.ok(Object.isFrozen(api.pin));
});

for (const requireTrace of [false, true]) test(`full qualification precedes same-pair refresh and all subsequent methods bind the fresh hash (trace=${requireTrace})`, async () => {
  const f = fixture({ requireTrace }), api = await f.connect();
  assert.equal(api.evidence.traceQualified, requireTrace ? true : undefined);
  assert.deepEqual(api.evidence.aliases, [1, 2]);
  assert.deepEqual(api.evidence.qualification.filter(q => q.qualified).map(q => q.alias), [1, 2, 3]);
  // A lexically earlier, capable fallback must not replace the selected pair.
  const refreshes = f.state.calls.filter(c => c.method === "eth_getBlockByNumber" && c.params[0] === "latest" && c.completedQualifications === MAX_CANDIDATES);
  assert.ok(refreshes.length >= 2); assert.ok(refreshes.every(c => [1, 2].includes(c.alias)));
  assert.equal(f.state.latestCounts.get(3), 1);
  for (const alias of [1, 2]) {
    assert.equal(f.state.latestCounts.get(alias), requireTrace ? 3 : 2);
    assert.equal(f.state.chainCounts.get(alias), requireTrace ? 3 : 2);
  }
  if (requireTrace) for (const row of api.evidence.qualification.filter(q => q.qualified)) {
    assert.equal(row.traceQualified, true); assert.equal(row.hashPinnedBlockNumberVerified, true); assert.equal(row.unknownHashRejected, true);
    assert.ok(row.probePin.number < api.pin.number);
  }
  const acquisitionProbes = f.state.calls.filter(c => ["eth_call", "debug_traceCall"].includes(c.method) && c.params[0].to === MULTICALL3 &&
    c.params[1].blockHash === api.pin.hash);
  assert.deepEqual(acquisitionProbes.filter(c => c.method === "eth_call").map(c => c.alias).sort(), [1, 2]);
  assert.equal(acquisitionProbes.filter(c => c.method === "debug_traceCall").length, requireTrace ? 2 : 0);
  const before = f.state.calls.length, pin = api.pin;
  assert.equal(await api.call(TX), "0x1234"); assert.equal(await api.estimateGas(TX), "0x10000");
  if (requireTrace) assert.equal((await api.trace(TX)).tree.output, "0x1234");
  await api.recheck();
  assert.equal(api.pin, pin); assert.equal(api.pin.hash, hash(START + 6));
  const used = f.state.calls.slice(before);
  assert.ok(used.every(c => [1, 2].includes(c.alias)));
  for (const call of used.filter(c => ["eth_call", "eth_estimateGas", "debug_traceCall"].includes(c.method)))
    assert.deepEqual(call.params[1], { blockHash: pin.hash, requireCanonical: true });
});

test("normal advancement accepts exact +4, rejects +5, poisons every pinned method and never repins", async () => {
  const f = fixture({ requireTrace: true }), api = await f.connect(), pin = api.pin;
  f.state.now += 48000;
  assert.equal(f.head() - pin.number, 4); await api.recheck(); api.assertUsable();
  await api.call(TX); assert.equal(api.pin, pin); assert.equal(api.pin.number, START + 6);
  f.state.now += 12000;
  assert.equal(f.head() - pin.number, 5);
  await assert.rejects(api.recheck(), { code: "PIN_TOO_FAR_BEHIND" });
  const before = f.state.calls.length;
  for (const invoke of [() => api.call(TX), () => api.estimateGas(TX), () => api.trace(TX), () => api.recheck()])
    await assert.rejects(invoke(), { code: "PIN_EVIDENCE_INVALIDATED" });
  assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" });
  assert.equal(f.state.calls.length, before); assert.equal(api.pin, pin); assert.equal(api.pin.hash, hash(START + 6));
});

test("a provider head below the frozen pin fails and poisons without reacquisition", async () => {
  const f = fixture(), api = await f.connect(), pin = api.pin;
  f.state.headOverride = pin.number - 1;
  await assert.rejects(api.recheck(), { code: "PIN_TOO_FAR_BEHIND" });
  assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" }); assert.equal(api.pin, pin);
});

test("the existing 120-second freshness boundary is retained exactly", async () => {
  assert.equal(MAX_AGE_MS, 120000);
  const f = fixture(), api = await f.connect(); f.state.headOverride = api.pin.number;
  f.state.now = api.pin.timestamp * 1000 + MAX_AGE_MS; await api.recheck();
  f.state.now++;
  await assert.rejects(api.recheck(), { code: "PIN_STALE_OR_FUTURE" });
  assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" });
});

for (const requireTrace of [false, true]) test(`fresh pair gap +4 selects the fresh lower common height (trace=${requireTrace})`, async () => {
  const f = fixture({ requireTrace, latest: ({ alias, occurrence, number, header }) =>
    occurrence === 2 && alias === 2 ? header(number - 4) : undefined });
  const api = await f.connect();
  assert.equal(api.pin.number, START + 2); assert.equal(api.pin.hash, hash(START + 2));
  assert.deepEqual(api.evidence.aliases, [1, 2]); await api.recheck();
});

test("outdated qualification-time gap cannot override converged refreshed heads or change selected aliases", async () => {
  const f = fixture({ initialHeads: { 1: START, 2: START - 5, 3: START - 6 } }), api = await f.connect();
  assert.deepEqual(api.evidence.aliases, [1, 2]); assert.equal(api.pin.number, START + 6); await api.recheck();
});

const freshFailures = [
  ["head gap +5", "PROVIDER_HEAD_GAP", ({ number, header }) => header(number - 5)],
  ["invalid hash", "PIN_HEADER_INVALID", ({ number, header }) => ({ ...header(number), hash: "invalid" })],
  ["invalid parent hash", "PIN_HEADER_INVALID", ({ number, header }) => ({ ...header(number), parentHash: "invalid" })],
  ["invalid state root", "PIN_HEADER_INVALID", ({ number, header }) => ({ ...header(number), stateRoot: "invalid" })],
  ["stale timestamp", "PIN_STALE_OR_FUTURE", ({ number, header, state }) => ({ ...header(number), timestamp: hex(state.now / 1000 - 121) })],
  ["future timestamp", "PIN_STALE_OR_FUTURE", ({ number, header, state }) => ({ ...header(number), timestamp: hex(state.now / 1000 + 1) })],
  ["unsafe height", "PIN_STALE_OR_FUTURE", ({ number, header }) => ({ ...header(number), number: hex(BigInt(Number.MAX_SAFE_INTEGER) + 1n) })],
  ["invalid base fee", "INVALID_INTEGER", ({ number, header }) => ({ ...header(number), baseFeePerGas: "invalid" })],
  ["request failure", "PINNED_RPC_FAILED", () => { throw new Error("OFFLINE_FAILURE_DETAIL"); }]
];
for (const requireTrace of [false, true]) for (const [name, code, fail] of freshFailures)
  test(`fresh selected-pair ${name} fails closed without fallback/retry (trace=${requireTrace})`, async () => {
    const f = fixture({ requireTrace, latest: args => args.occurrence === 2 && args.alias === 2 ? fail(args) : undefined });
    await assert.rejects(f.connect(), { code });
    assert.equal(f.state.qualificationDone.size, MAX_CANDIDATES);
    assert.equal(f.state.latestCounts.get(1), 2); assert.equal(f.state.latestCounts.get(2), 2); assert.equal(f.state.latestCounts.get(3), 1);
    const afterQualification = f.state.calls.filter(c => c.completedQualifications === MAX_CANDIDATES);
    assert.ok(afterQualification.every(c => [1, 2].includes(c.alias)));
    assert.ok(afterQualification.every(c => c.method === "eth_chainId" || c.method === "eth_getBlockByNumber" && c.params[0] === "latest"));
  });

test("the selected pair's chain is revalidated after qualification; changed chain never selects the capable fallback", async () => {
  const f = fixture({ chain: ({ alias, occurrence }) => alias === 2 && occurrence === 2 ? "0x2" : undefined });
  await assert.rejects(f.connect(), { code: "WRONG_CHAIN" });
  assert.equal(f.state.chainCounts.get(2), 2); assert.equal(f.state.chainCounts.get(3), 1);
  assert.equal(f.state.latestCounts.get(2), 1); assert.equal(f.state.latestCounts.get(3), 1);
});

test("fresh acquisition still requires complete common-header agreement and exact hash probes", async () => {
  for (const field of ["hash", "parentHash", "stateRoot", "timestamp", "baseFeePerGas", "number"]) {
    const f = fixture({ numbered: ({ alias, state, header, number }) => alias === 2 && state.qualificationDone.size === MAX_CANDIDATES
      ? { ...header(number), [field]: field === "timestamp" ? hex(state.now / 1000 - 13)
        : field === "number" ? hex(number - 1) : field === "baseFeePerGas" ? hex(100000001) : hash(99999) } : undefined });
    await assert.rejects(f.connect(), { code: "PIN_HASH_DISAGREEMENT" });
    assert.equal(f.state.latestCounts.get(3), 1);
  }
  const badProbe = fixture({ probe: ({ alias, state }) => alias === 2 && state.qualificationDone.size === MAX_CANDIDATES ? hash(START) : undefined });
  await assert.rejects(badProbe.connect(), { code: "PIN_CALL_CAPABILITY_FAILED" });
  assert.equal(badProbe.state.latestCounts.get(3), 1);
});

test("independent later passes acquire their own fresh pin rather than caching prior qualification", async () => {
  const first = fixture(), a = await first.connect();
  const second = fixture(), b = await second.connect();
  assert.notEqual(a, b); assert.notEqual(a.pin, b.pin);
  assert.equal(first.state.qualificationDone.size, MAX_CANDIDATES); assert.equal(second.state.qualificationDone.size, MAX_CANDIDATES);
  assert.equal(first.state.calls.length, second.state.calls.length);
});

test("live head is a single 1500ms scheduling read, never pin or collector evidence", async () => {
  const f = fixture({ count: 3 }), api = await f.connect(), pin = api.pin, evidence = structuredClone(api.evidence);
  f.state.now += 60000;
  const before = f.state.calls.length;
  assert.equal(await api.liveHeadNumber(), pin.number + 5);
  const calls = f.state.calls.slice(before);
  assert.equal(calls.length, 1); assert.equal(calls[0].alias, 1); assert.equal(calls[0].timeoutMs, 1500);
  assert.equal(calls[0].method, "eth_getBlockByNumber"); assert.deepEqual(calls[0].params, ["latest", false]);
  assert.equal(api.pin, pin); assert.deepEqual(api.evidence, evidence); api.assertUsable();
  const collected = await api.collectorOptions.rpcCall("PINNED_ETHEREUM", "eth_getBlockByNumber", ["latest", false]);
  assert.equal(collected.number, hex(pin.number)); assert.equal(collected.hash, pin.hash);
  assert.equal(f.state.calls.length, before + 1);
  await assert.rejects(api.recheck(), { code: "PIN_TOO_FAR_BEHIND" });
  assert.equal(await api.liveHeadNumber(), pin.number + 5);
  assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" }); assert.equal(api.pin, pin);
});

test("live-head transport failure rejects without retries or poisoning and the next poll prefers the other witness", async () => {
  let failed = false;
  const f = fixture({ count: 3, latest: ({ alias, state }) => {
    if (state.phase === "ready" && alias === 1) { failed = true; throw new ExecutionError("RPC_TIMEOUT"); }
  } }), api = await f.connect(), pin = api.pin;
  f.state.phase = "ready"; const before = f.state.calls.length;
  await assert.rejects(api.liveHeadNumber(), { code: "PINNED_RPC_FAILED" }); assert.equal(failed, true);
  assert.equal(f.state.calls.length, before + 1); assert.equal(f.state.calls[before].timeoutMs, 1500);
  api.assertUsable(); assert.equal(await api.call(TX), "0x1234");
  assert.equal(await api.liveHeadNumber(), pin.number); assert.equal(f.state.calls.at(-1).alias, 2);
  assert.equal(api.pin, pin); assert.deepEqual(api.evidence.aliases, [1, 2]); api.assertUsable();
});

test("malformed live-head numbers fail without invalidating otherwise usable pin evidence", async () => {
  for (const number of [null, "UNTRUSTED_NUMBER", -1, hex(BigInt(Number.MAX_SAFE_INTEGER) + 1n)]) {
    const f = fixture({ count: 3, latest: ({ state, header }) => state.phase === "ready" ? { ...header(START), number } : undefined });
    const api = await f.connect(), before = f.state.calls.length;
    f.state.phase = "ready";
    await assert.rejects(api.liveHeadNumber(), { code: "LIVE_HEAD_INVALID" });
    assert.equal(f.state.calls.length, before + 1); api.assertUsable();
    f.state.phase = "constructing"; await api.recheck(); assert.equal(await api.call(TX), "0x1234");
  }
});
