"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { ExecutionError, MAIN_ACCOUNT } = require("../lib/wallet-execution-guard.js");
const { createPinnedRpc, httpRpc, MULTICALL3, PROBE, MAX_CANDIDATES, QUALIFICATION_CONCURRENCY, REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BYTES } = require("../lib/executor-pinned-rpc.js");
const { createNextBlockContext, normalizeSimulationTransaction, buildNextBlockRequest, validateNextBlockParams,
  normalizeNextBlockResult, buildNextBlockProbeTransaction, createNextBlockSimulation, qualifyNextBlockProvider, PROBE_INITCODE, UNKNOWN_HASH, PROBE_GAS_LIMIT, PROBE_FEE_CAP
} = require("../lib/next-block-simulation.js");
const NOW = Date.parse("2026-10-23T20:00:01Z"), HEAD = 1000, TIME = NOW / 1000 - 1;
const hex = n => "0x" + BigInt(n).toString(16), hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const address = n => "0x" + BigInt(n).toString(16).padStart(40, "0");
const header = (number = HEAD) => ({ number: hex(number), hash: hash(number), parentHash: hash(number - 1), stateRoot: hash(7),
  timestamp: hex(TIME + (number - HEAD) * 12), baseFeePerGas: hex(100000000), gasLimit: hex(30000000) });
const TX = { type: 2, chainId: 1n, from: MAIN_ACCOUNT, to: address(2), data: "0x1234", value: 0n, nonce: 7,
  gasLimit: 180000n, maxFeePerGas: 200000000n, maxPriorityFeePerGas: 1n, accessList: [] };
function response(params) {
  const block = params[0].blockStateCalls[0], tx = structuredClone(block.calls[0]), probe = tx.input === PROBE_INITCODE;
  const output = probe ? "0x" + BigInt(block.blockOverrides.number).toString(16).padStart(64, "0") +
    BigInt(block.blockOverrides.time).toString(16).padStart(64, "0") : "0xabcd";
  return [{ number: block.blockOverrides.number, timestamp: block.blockOverrides.time, parentHash: params[1].blockHash, hash: hash(900),
    transactions: [{ ...tx, hash: hash(800), untrustedMetadata: "UNTRUSTED_CLIENT_DATA" }],
    calls: [{ returnData: output, gasUsed: hex(80000), status: "0x1", logs: probe ? [] : [
      { address: address(3), topics: [hash(4), hash(5)], data: hash(6), logIndex: "0x0", transactionIndex: "0x0",
        transactionHash: hash(800), blockNumber: block.blockOverrides.number, blockHash: hash(900), removed: false,
        untrustedMetadata: "UNTRUSTED_LOG_DATA" }] }] }];
}
for (const parallel of [false, true]) test(`qualification stages keep isolated settings and unknown-hash-last (${parallel ? "v2 width two" : "legacy serial"})`, async () => {
  let active = 0, peak = 0; const calls = [], positives = [];
  const pin = { ...header(), number: HEAD, timestamp: TIME };
  await qualifyNextBlockProvider({ provider: {}, pin, parallelQualification: parallel, request: async (_, method, params) => {
    calls.push(method); peak = Math.max(peak, ++active);
    try {
      await new Promise(resolve => setTimeout(resolve, 2));
      if (method === "eth_getTransactionCount") return "0x7";
      if (method === "eth_getBalance") return hex(2000000000000000n);
      validateNextBlockParams(params);
      if (params[1].blockHash === UNKNOWN_HASH) {
        assert.equal(positives.length, 2); assert.equal(active, 1); throw new ExecutionError("UNKNOWN_BLOCK_REJECTED");
      }
      positives.push(params); return response(params);
    } finally { active--; }
  } });
  assert.equal(peak, parallel ? 2 : 1); assert.equal(active, 0);
  assert.deepEqual(calls, ["eth_getTransactionCount", "eth_getBalance", "eth_simulateV1", "eth_simulateV1", "eth_simulateV1"]);
  assert.notEqual(positives[0][0], positives[1][0]); assert.notEqual(positives[0][1], positives[1][1]);
  assert.notEqual(positives[0][0].blockStateCalls[0], positives[1][0].blockStateCalls[0]);
  assert.deepEqual(positives.map(p => Number(BigInt(p[0].blockStateCalls[0].blockOverrides.time))), [TIME + 24, TIME + 12]);
});

for (const stage of ["account", "positive"]) test(`parallel qualification ${stage} failure revokes before sibling drain and preserves trust priority`, async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let revoked = false, settled = false, negatives = 0;
  const pin = { ...header(), number: HEAD, timestamp: TIME };
  const pending = assert.rejects(qualifyNextBlockProvider({ provider: {}, pin, parallelQualification: true, request: async (_, method, params) => {
    if (stage === "account" && method === "eth_getTransactionCount") throw new ExecutionError("NEXT_BLOCK_TX_INVALID");
    if (stage === "account" && method === "eth_getBalance") { await gate; throw new ExecutionError("NEXT_BLOCK_DEADLINE"); }
    if (method === "eth_getTransactionCount") return "0x7";
    if (method === "eth_getBalance") return hex(2000000000000000n);
    if (params[1].blockHash === UNKNOWN_HASH) { negatives++; throw new ExecutionError("UNKNOWN_BLOCK_REJECTED"); }
    if (params[0].blockStateCalls[0].blockOverrides.time === hex(TIME + 24)) {
      const raw = response(params); raw[0].calls[0].returnData = "0x00"; return raw;
    }
    await gate; throw new ExecutionError("NEXT_BLOCK_DEADLINE");
  } }, { onTrustFailure() { revoked = true; } }), { code: stage === "account" ? "NEXT_BLOCK_TX_INVALID" : "NEXT_BLOCK_OVERRIDES_IGNORED" })
    .then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(revoked, true); assert.equal(settled, false);
  release(); await pending; assert.equal(negatives, 0);
});

test("parallel qualification cannot omit a rejected-unknown-hash control", async () => {
  const pin = { ...header(), number: HEAD, timestamp: TIME };
  await assert.rejects(qualifyNextBlockProvider({ provider: {}, pin, parallelQualification: true, request: async (_, method, params) => {
    if (method === "eth_getTransactionCount") return "0x7";
    if (method === "eth_getBalance") return hex(2000000000000000n);
    return response(params);
  } }), { code: "NEXT_BLOCK_UNKNOWN_HASH_NOT_REJECTED" });
});

function fixture(modes = ["simulate", "simulate"], { families, hook = () => undefined } = {}) {
  const candidates = modes.map((_, i) => ({ handle: "OFFLINE_OPAQUE_" + i, family: families?.[i] ?? "synthetic-family-" + i }));
  const state = { now: NOW, calls: [], active: 0, peak: 0, ready: false, head: HEAD, canonicalChange: false };
  async function rpc(candidate, method, params, timeoutMs) {
    const alias = candidates.indexOf(candidate) + 1, mode = modes[alias - 1];
    const call = { alias, method, params: structuredClone(params), ready: state.ready }; state.calls.push(call);
    state.active++; state.peak = Math.max(state.peak, state.active);
    try {
      await Promise.resolve(); assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= REQUEST_TIMEOUT_MS);
      const changed = hook({ call, state, mode }); if (changed !== undefined) return changed;
      if (method === "eth_chainId") return mode === "wrong-chain" ? "0x2" : "0x1";
      if (method === "eth_getBlockByNumber") {
        const number = params[0] === "latest" ? state.head : Number(BigInt(params[0]));
        return { ...header(number), ...(state.canonicalChange ? { hash: hash(99999) } : {}) };
      }
      if (method === "eth_call") return params[0].to === MULTICALL3 ? hash(BigInt(params[1].blockHash)) : "0x1234";
      if (method === "eth_estimateGas") return hex(80000);
      if (method === "eth_getTransactionCount") return "0x7";
      if (method === "eth_getBalance") return mode === "unfunded" ? "0x0" : hex(2000000000000000n);
      if (method === "eth_simulateV1") {
        validateNextBlockParams(params);
        if (mode === "call-only") throw new ExecutionError("NEXT_BLOCK_METHOD_UNAVAILABLE");
        if (params[1].blockHash === UNKNOWN_HASH) {
          if (mode === "unknown-invalid-params") throw new ExecutionError("RPC_FAILED");
          if (mode === "unknown-forged") throw Object.assign(new Error("UNTRUSTED_PROVIDER_MESSAGE"), { code: "UNKNOWN_BLOCK_REJECTED" });
          if (mode !== "accepts-unknown") throw new ExecutionError("UNKNOWN_BLOCK_REJECTED");
        }
        const raw = response(params);
        if (mode === "ignores-time") raw[0].calls[0].returnData = hash(HEAD + 1) + hash(TIME + 12).slice(2);
        if (mode === "ignores-number") raw[0].calls[0].returnData = hash(HEAD) + hash(BigInt(params[0].blockStateCalls[0].blockOverrides.time)).slice(2);
        if (mode === "partial") delete raw[0].transactions;
        return raw;
      }
      assert.fail("UNPLANNED_METHOD");
    } finally { state.active--; }
  }
  return { state, candidates, rpc, connect: async (options = { requireNextBlock: true }) => {
    const api = await createPinnedRpc({ candidates, rpc, now: () => state.now, ...options }); state.ready = true; return api;
  } };
}
function safeRejection(code) {
  return error => {
    assert.ok(error instanceof ExecutionError); assert.equal(error.code, code); assert.equal(error.message, code);
    assert.doesNotMatch(error.stack + JSON.stringify(error), /UNTRUSTED|OFFLINE_OPAQUE|synthetic-family/); return true;
  };
}
const originalFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = () => { throw new Error("OFFLINE_NETWORK_FORBIDDEN"); }; });
test.after(() => { globalThis.fetch = originalFetch; });

test("default and explicit false never qualify simulation or expose nextBlock", async () => {
  for (const options of [{}, { requireNextBlock: false }]) {
    const f = fixture(["call-only", "call-only"]), api = await f.connect(options);
    assert.equal(api.nextBlock, undefined); assert.equal(api.evidence.nextBlockQualified, undefined);
    assert.deepEqual(api.evidence.qualification, [{ alias: 1, qualified: true }, { alias: 2, qualified: true }]);
    assert.equal(Object.hasOwn(api.pin, "gasLimit"), false); assert.equal(await api.call(TX), "0x1234"); await api.recheck();
    assert.equal(f.state.calls.some(c => ["eth_simulateV1", "eth_getBalance"].includes(c.method)), false);
  }
});

test("capability checks cover the bounded pool before choosing two independent eligible families", async () => {
  const modes = ["call-only", "call-only", "simulate", "simulate", "simulate", "wrong-chain", "unfunded"];
  const seen = new Set(), counts = new Map();
  const f = fixture(modes, { families: ["a", "b", "z", "z", "y", "wrong", "empty"], hook: ({ call }) => {
    if (call.method === "eth_chainId") {
      const count = (counts.get(call.alias) ?? 0) + 1; counts.set(call.alias, count);
      if (count === 1) seen.add(call.alias); else assert.equal(seen.size, modes.length);
    }
  } });
  const api = await f.connect();
  assert.deepEqual(api.evidence.aliases, [3, 5]); assert.equal(api.evidence.nextBlockQualified, true);
  assert.deepEqual(api.evidence.qualification.filter(q => q.qualified).map(q => q.alias), [3, 4, 5]);
  for (const row of api.evidence.qualification.filter(q => q.qualified)) {
    assert.equal(row.nextBlockQualified, true); assert.equal(row.numberTimestampVerified, true);
    assert.equal(row.timeControlVerified, true); assert.equal(row.simulationUnknownHashRejected, true);
  }
  assert.equal(f.state.peak, QUALIFICATION_CONCURRENCY); assert.equal(f.state.active, 0);
  const before = f.state.calls.length; await api.nextBlock.simulate(TX);
  assert.ok(f.state.calls.slice(before).every(call => [3, 5].includes(call.alias)));
  assert.doesNotMatch(JSON.stringify(api.evidence), /OFFLINE_OPAQUE|synthetic-family|UNTRUSTED/);
});

test("all simulation paths use exact hash pin, one call, no state override and funded creation opcode controls", async () => {
  const f = fixture(), api = await f.connect();
  for (const alias of [1, 2]) {
    const calls = f.state.calls.filter(c => c.alias === alias), simulations = calls.filter(c => c.method === "eth_simulateV1");
    assert.deepEqual(simulations.map(c => c.params[0].blockStateCalls[0].blockOverrides.time),
      [24, 12, 12].map(seconds => hex(TIME + seconds)));
    for (const call of simulations) {
      assert.deepEqual(call.params[1], { blockHash: call.params[1].blockHash, requireCanonical: true });
      assert.ok([hash(HEAD), UNKNOWN_HASH].includes(call.params[1].blockHash));
      const payload = call.params[0], block = payload.blockStateCalls[0], tx = block.calls[0];
      assert.deepEqual(Object.keys(payload), ["blockStateCalls", "validation", "traceTransfers", "returnFullTransactions"]);
      assert.deepEqual(Object.keys(block), ["blockOverrides", "calls"]); assert.equal(block.blockOverrides.number, hex(HEAD + 1));
      assert.equal(payload.validation, true); assert.equal(payload.traceTransfers, false); assert.equal(payload.returnFullTransactions, true);
      assert.equal(tx.to, null); assert.equal(tx.input, PROBE_INITCODE); assert.equal(tx.from, MAIN_ACCOUNT); assert.equal(tx.nonce, "0x7");
      assert.equal(tx.gas, hex(PROBE_GAS_LIMIT)); assert.equal(tx.maxFeePerGas, hex(112500001));
      assert.equal(tx.maxPriorityFeePerGas, "0x1"); assert.equal(tx.value, "0x0");
    }
    for (const call of calls.filter(c => ["eth_getTransactionCount", "eth_getBalance"].includes(c.method)))
      assert.deepEqual(call.params, [MAIN_ACCOUNT, { blockHash: hash(HEAD), requireCanonical: true }]);
  }
  assert.equal(api.nextBlock.context.timestamp, TIME + 12); assert.equal(api.nextBlock.context.parentHash, api.pin.hash);
  assert.ok(Object.isFrozen(api.nextBlock.context)); assert.ok(Object.isFrozen(api.pin));
});

test("all qualification cost precedes the fresh final pin and its actual chain timestamp", async () => {
  const completed = new Set(), latestCounts = new Map(); let refreshed = false;
  const f = fixture(["simulate", "simulate", "simulate"], { hook: ({ call, state }) => {
    if (!state.ready && refreshed) assert.ok(!["eth_simulateV1", "eth_getTransactionCount", "eth_getBalance", "eth_call", "debug_traceCall"].includes(call.method));
    if (call.method === "eth_simulateV1" && call.params[1].blockHash === UNKNOWN_HASH) {
      completed.add(call.alias);
      if (completed.size === 3) { state.now = NOW + 24000; state.head = HEAD + 2; }
    }
    if (call.method === "eth_getBlockByNumber" && call.params[0] === "latest") {
      const count = (latestCounts.get(call.alias) ?? 0) + 1; latestCounts.set(call.alias, count);
      if (count > 1) { assert.equal(completed.size, 3); refreshed = true; }
    }
  } });
  const api = await f.connect();
  assert.deepEqual(api.evidence.aliases, [1, 2]); assert.equal(f.state.now - NOW, 24000);
  assert.deepEqual(api.nextBlock.context, { chainId: 1, parentHash: hash(HEAD + 2), parentNumber: HEAD + 2,
    parentTimestamp: TIME + 24, number: HEAD + 3, timestamp: TIME + 36, seconds: 12 });
  assert.equal(api.pin.timestamp, TIME + 24); assert.notEqual(api.pin.timestamp, Math.floor(f.state.now / 1000));
  assert.equal(f.state.calls.filter(call => call.method === "eth_simulateV1").length, 9);
  for (const call of f.state.calls.filter(call => call.method === "eth_simulateV1"))
    assert.ok([hash(HEAD), UNKNOWN_HASH].includes(call.params[1].blockHash));
  const result = await api.nextBlock.simulate(TX);
  assert.equal(result.context.parentHash, hash(HEAD + 2)); assert.equal(result.context.timestamp, TIME + 36);
  for (const call of f.state.calls.filter(call => call.ready && call.method === "eth_simulateV1"))
    assert.deepEqual(call.params[1], { blockHash: hash(HEAD + 2), requireCanonical: true });
});

test("live-clock forecast acquisition rejects a future chain timestamp instead of skew-clamping it", async t => {
  t.mock.method(Date, "now", () => NOW);
  const methods = [];
  t.mock.method(globalThis, "fetch", async (_handle, options) => {
    const { method } = JSON.parse(options.body); methods.push(method);
    const result = method === "eth_chainId" ? "0x1" : { ...header(), timestamp: hex(NOW / 1000 + 1) };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  });
  await assert.rejects(createPinnedRpc({ candidates: [{ handle: "OFFLINE_OPAQUE_1", family: "a" }, { handle: "OFFLINE_OPAQUE_2", family: "b" }],
    rpc: httpRpc, requireNextBlock: true }), safeRejection("TWO_NEXT_BLOCK_CAPABLE_FAMILIES_REQUIRED"));
  assert.ok(methods.every(method => ["eth_chainId", "eth_getBlockByNumber"].includes(method)));
});

test("ignored opcode overrides, partial responses, unknown acceptance and false rejection cannot qualify", async () => {
  for (const mode of ["call-only", "ignores-time", "ignores-number", "partial", "accepts-unknown", "unknown-invalid-params", "unknown-forged", "unfunded", "wrong-chain"]) {
    const f = fixture([mode, mode]);
    await assert.rejects(f.connect(), safeRejection("TWO_NEXT_BLOCK_CAPABLE_FAMILIES_REQUIRED")); assert.equal(f.state.active, 0);
  }
  await assert.rejects(fixture(["simulate", "simulate"], { families: ["same", "same"] }).connect(),
    safeRejection("TWO_NEXT_BLOCK_CAPABLE_FAMILIES_REQUIRED"));
});

test("pure helpers normalize ethers type-2 input and preserve exact tested gas and execution binding", async () => {
  const context = createNextBlockContext(header()), params = buildNextBlockRequest(context, TX), result = normalizeNextBlockResult(response(params), context, TX);
  assert.deepEqual(params[0].blockStateCalls[0].calls[0], normalizeSimulationTransaction(TX));
  assert.equal(result.gasUsed, hex(80000)); assert.equal(result.gasLimit, hex(180000));
  assert.equal(result.context.transaction.gas, result.gasLimit); assert.deepEqual(result.context.transaction, normalizeSimulationTransaction(TX));
  assert.deepEqual(result.logs, [{ address: address(3), topics: [hash(4), hash(5)], data: hash(6) }]);
  assert.equal(result.transactionHash, hash(800)); assert.equal(result.returnData, "0xabcd");
  assert.ok(Object.isFrozen(result.context.transaction.accessList)); assert.ok(Object.isFrozen(result.logs[0]));
  assert.doesNotMatch(JSON.stringify(result), /UNTRUSTED|receipt|profit/);
  const f = fixture(), api = await f.connect(), before = f.state.calls.length;
  assert.deepEqual(await api.nextBlock.simulate(TX), result);
  const calls = f.state.calls.slice(before), simulations = calls.filter(c => c.method === "eth_simulateV1");
  assert.equal(simulations.length, 2); simulations.forEach(call => assert.deepEqual(call.params, params));
  assert.equal(calls.filter(c => c.method === "eth_getBlockByNumber" && c.params[0] === "latest").length, 4);
});

test("transaction normalization covers access lists, aliases and case without changing execution", () => {
  const tx = { ...TX, input: "0xABCD", data: "0xabcd", gas: "0x02bf20", accessList: [[address(4), [hash(5)]]] };
  const normalized = normalizeSimulationTransaction(tx);
  assert.equal(normalized.input, "0xabcd"); assert.equal(normalized.gas, hex(180000));
  assert.deepEqual(normalized.accessList, [{ address: address(4), storageKeys: [hash(5)] }]);
  assert.deepEqual(normalizeSimulationTransaction({ ...tx, accessList: { [address(4)]: [hash(5)] } }), normalized);
});

test("every returned execution field, including tested gas and access list, must match exactly", () => {
  const context = createNextBlockContext(header()), params = buildNextBlockRequest(context, TX);
  for (const [field, value] of [["type", "0x0"], ["chainId", "0x2"], ["from", address(9)], ["to", address(9)], ["input", "0x00"],
    ["value", "0x1"], ["nonce", "0x8"], ["gas", hex(80000)], ["maxFeePerGas", hex(200000001)], ["maxPriorityFeePerGas", "0x2"],
    ["accessList", [{ address: address(4), storageKeys: [hash(5)] }]], ["data", "0x99"], ["gasLimit", hex(80000)]]) {
    const raw = response(params); raw[0].transactions[0][field] = value;
    assert.throws(() => normalizeNextBlockResult(raw, context, TX), safeRejection("NEXT_BLOCK_TX_MISMATCH"));
  }
});

test("empty, partial, malformed block/call/log responses and gas outside tested limit fail closed", () => {
  const context = createNextBlockContext(header()), params = buildNextBlockRequest(context, TX);
  for (const mutate of [raw => raw.splice(0), raw => raw.push(raw[0]), raw => { raw[0].calls = []; }, raw => { raw[0].calls.push(raw[0].calls[0]); },
    raw => { raw[0].transactions = []; }, raw => { raw[0].transactions = [hash(800)]; }, raw => { delete raw[0].calls[0].returnData; },
    raw => { raw[0].calls[0].gasUsed = "0x0"; }, raw => { raw[0].calls[0].gasUsed = hex(180001); },
    raw => { raw[0].parentHash = hash(999); }, raw => { raw[0].number = hex(HEAD); }, raw => { raw[0].timestamp = hex(TIME); },
    raw => { raw[0].calls[0].logs = null; }, raw => { raw[0].calls[0].logs[0].removed = true; },
    raw => { raw[0].calls[0].logs[0].transactionHash = hash(900); }, raw => { raw[0].calls[0].logs[0].data = "UNTRUSTED_LOG"; }]) {
    const raw = response(params); mutate(raw);
    assert.throws(() => normalizeNextBlockResult(raw, context, TX), safeRejection("NEXT_BLOCK_RESULT_INVALID"));
  }
  for (const change of [call => { call.status = "0x0"; }, call => { call.error = { message: "UNTRUSTED_REVERT" }; }, call => { call.error = null; }]) {
    const raw = response(params); change(raw[0].calls[0]);
    assert.throws(() => normalizeNextBlockResult(raw, context, TX), safeRejection("NEXT_BLOCK_REVERTED"));
  }
});

test("provider result differences invalidate only the forecast, never the parent current-state session", async () => {
  for (const field of ["returnData", "gasUsed", "logs", "hash"]) {
    const f = fixture(undefined, { hook: ({ call, state }) => {
      if (state.ready && call.alias === 2 && call.method === "eth_simulateV1") {
        const raw = response(call.params);
        if (field === "hash") { raw[0].transactions[0].hash = hash(801); raw[0].calls[0].logs[0].transactionHash = hash(801); }
        else raw[0].calls[0][field] = { returnData: "0xabce", gasUsed: hex(80001), logs: [] }[field];
        return raw;
      }
    } }), api = await f.connect();
    await assert.rejects(api.nextBlock.simulate(TX), safeRejection("NEXT_BLOCK_PROVIDER_DISAGREEMENT"));
    await assert.rejects(api.nextBlock.recheck(), safeRejection("NEXT_BLOCK_EVIDENCE_INVALIDATED"));
    api.assertUsable(); assert.equal(await api.call(TX), "0x1234"); await api.recheck();
  }
});

test("optional unsupported, malformed and reverted runtime results do not poison current-state use", async () => {
  for (const [mode, expected] of [["unsupported", "NEXT_BLOCK_METHOD_UNAVAILABLE"], ["partial", "NEXT_BLOCK_RESULT_INVALID"], ["revert", "NEXT_BLOCK_REVERTED"]]) {
    const f = fixture(undefined, { hook: ({ call, state }) => {
      if (state.ready && call.method === "eth_simulateV1") {
        if (mode === "unsupported") throw new ExecutionError("NEXT_BLOCK_METHOD_UNAVAILABLE");
        const raw = response(call.params); if (mode === "partial") raw[0].transactions = []; else raw[0].calls[0].status = "0x0"; return raw;
      }
    } }), api = await f.connect();
    await assert.rejects(api.nextBlock.simulate(TX), safeRejection(expected)); api.assertUsable(); await api.recheck();
  }
});

test("strict forecast recheck rejects advancement, stale heads, reorg, provider disagreement and chain change", async () => {
  for (const [change, expected] of [["advance", "NEXT_BLOCK_HEAD_ADVANCED"], ["stale", "NEXT_BLOCK_HEAD_STALE"],
    ["reorg", "NEXT_BLOCK_PARENT_CHANGED"], ["disagreement", "NEXT_BLOCK_PROVIDER_DISAGREEMENT"], ["chain", "NEXT_BLOCK_WRONG_CHAIN"]]) {
    const f = fixture(undefined, { hook: ({ call, state }) => {
      if (!state.ready) return;
      if (change === "chain" && call.method === "eth_chainId") return "0x2";
      if (change === "disagreement" && call.alias === 2 && call.method === "eth_getBlockByNumber" && call.params[0] === "latest") return header(HEAD + 1);
    } }), api = await f.connect();
    if (change === "advance") f.state.head++;
    if (change === "stale") f.state.head--;
    if (change === "reorg") f.state.canonicalChange = true;
    await assert.rejects(api.nextBlock.recheck(), safeRejection(expected)); api.assertUsable();
  }
});

test("v2 normal staggered advancement requires both witnesses to verify the complete canonical extension", async () => {
  const { createNextBlockSimulation } = require("../lib/next-block-simulation.js");
  for (const disagree of [false, true]) {
    const providers = [{ family: "a" }, { family: "b" }], calls = [];
    const child = createNextBlockSimulation({ pin: header(), providers, now: () => NOW, assertUsable() {}, classifyNormalAdvance: true,
      request: async (provider, method, params) => {
        calls.push({ provider, method, params }); if (method === "eth_chainId") return "0x1";
        const number = params[0] === "latest" ? provider === providers[0] ? HEAD + 1 : HEAD : Number(BigInt(params[0]));
        return { ...header(number), ...(disagree && provider === providers[1] && number === HEAD + 1 ? { stateRoot: hash(99) } : {}) };
      } });
    await assert.rejects(child.recheck(), safeRejection(disagree ? "NEXT_BLOCK_CANONICAL_DISAGREEMENT" : "NEXT_BLOCK_HEAD_ADVANCED"));
    assert.equal(calls.filter(call => call.params[0] === hex(HEAD + 1)).length, 2);
    await assert.rejects(child.recheck(), safeRejection("NEXT_BLOCK_EVIDENCE_INVALIDATED"));
  }
});

test("strict deadline includes elapsed RPC time, permits only before +12s, and never changes current recheck semantics", async () => {
  const f = fixture(), api = await f.connect(); f.state.now = (TIME + 12) * 1000 - 1;
  await api.nextBlock.recheck(); f.state.now++;
  const before = f.state.calls.length; await assert.rejects(api.nextBlock.recheck(), safeRejection("NEXT_BLOCK_DEADLINE"));
  assert.equal(f.state.calls.length, before); await api.recheck();
  f.state.head += 4; f.state.now = (TIME + 48) * 1000; await api.recheck();
  for (const action of ["deadline", "advance"]) {
    const slow = fixture(undefined, { hook: ({ call, state }) => {
      if (state.ready && call.method === "eth_simulateV1") {
        if (action === "deadline") state.now = (TIME + 12) * 1000; else state.head = HEAD + 1;
        return response(call.params);
      }
    } }), other = await slow.connect();
    await assert.rejects(other.nextBlock.simulate(TX), safeRejection(action === "deadline" ? "NEXT_BLOCK_DEADLINE" : "NEXT_BLOCK_HEAD_ADVANCED"));
    other.assertUsable();
  }
});

test("invalid transactions, fractional seconds, chain, options and oversized pools reject before simulation", async () => {
  const f = fixture(), api = await f.connect(), before = f.state.calls.length;
  for (const change of [{ type: 1 }, { chainId: 2 }, { from: "UNTRUSTED_FROM" }, { nonce: 1.5 }, { value: -1 }, { gasLimit: 0 },
    { gasLimit: 30000001 }, { gas: hex(180001) }, { input: "0x00" }, { data: "0x1" }, { maxFeePerGas: 0 },
    { maxPriorityFeePerGas: 200000001 }, { accessList: null }, { stateOverrides: {} }, { authorizationList: [] }])
    await assert.rejects(api.nextBlock.simulate({ ...TX, ...change }), safeRejection("NEXT_BLOCK_TX_INVALID"));
  await assert.rejects(api.nextBlock.simulate(TX, { seconds: 12.5 }), safeRejection("NEXT_BLOCK_OPTIONS_INVALID"));
  assert.equal(f.state.calls.length, before);
  assert.throws(() => createNextBlockContext({ ...header(), timestamp: TIME + 0.5 }), safeRejection("NEXT_BLOCK_CONTEXT_INVALID"));
  assert.throws(() => createNextBlockContext(header(), 2), safeRejection("NEXT_BLOCK_CONTEXT_INVALID"));
  assert.throws(() => buildNextBlockRequest({ ...api.nextBlock.context, seconds: 12.5 }, TX), safeRejection("NEXT_BLOCK_CONTEXT_INVALID"));
  for (const requireNextBlock of [null, "true", 1]) await assert.rejects(f.connect({ requireNextBlock }), safeRejection("NEXT_BLOCK_OPTIONS_INVALID"));
  await assert.rejects(f.connect({ requireNextBlock: true, seconds: 12 }), safeRejection("NEXT_BLOCK_OPTIONS_INVALID"));
  await assert.rejects(createPinnedRpc({ candidates: Array(MAX_CANDIDATES + 1).fill(f.candidates[0]), rpc: f.rpc, requireNextBlock: true }),
    safeRejection("RPC_CANDIDATES_INVALID"));
  assert.throws(() => buildNextBlockProbeTransaction({ ...header(), baseFeePerGas: PROBE_FEE_CAP }, 7, 10n ** 30n),
    safeRejection("NEXT_BLOCK_PROBE_UNFUNDED"));
});

test("HTTP unknown-hash qualification requires an explicit block lookup rejection, not invalid params or text leakage", async t => {
  const params = buildNextBlockRequest(createNextBlockContext(header()), TX); params[1].blockHash = UNKNOWN_HASH;
  let error;
  t.mock.method(globalThis, "fetch", async (_handle, options) => {
    assert.equal(options.redirect, "error"); assert.ok(["eth_simulateV1", "debug_traceCall"].includes(JSON.parse(options.body).method));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error }));
  });
  for (const message of ["unknown block", "header not found", "block is not canonical", "unknown block hash: " + UNKNOWN_HASH]) {
    error = { code: -32000, message, data: "UNTRUSTED_DATA" };
    await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, "eth_simulateV1", params), safeRejection("UNKNOWN_BLOCK_REJECTED"));
  }
  for (const [code, message, expected] of [[-32602, "unknown block", "RPC_FAILED"], [-32601, "unknown block", "NEXT_BLOCK_METHOD_UNAVAILABLE"],
    [-32000, "invalid params: unknown block", "RPC_FAILED"], [-32000, "UNTRUSTED_PROVIDER_MESSAGE", "RPC_FAILED"]]) {
    error = { code, message };
    await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, "eth_simulateV1", params), safeRejection(expected));
  }
  const standards = ["header for hash not found", "canonical block not found, hash: " + UNKNOWN_HASH];
  const ordinaryParams = buildNextBlockRequest(createNextBlockContext(header()), TX);
  const traceParams = [{}, { blockHash: UNKNOWN_HASH, requireCanonical: true },
    { tracer: "callTracer", timeout: "3s", tracerConfig: { onlyTopCall: false } }];
  for (const standard of standards) {
    for (const message of [standard, standard + ".", standard.toUpperCase(), standard.toUpperCase() + "."]) {
      error = { code: -32000, message };
      await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, "eth_simulateV1", params), safeRejection("UNKNOWN_BLOCK_REJECTED"));
      await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, "eth_simulateV1", ordinaryParams), safeRejection("RPC_FAILED"));
      // Additional simulation signatures must not broaden the trace matcher.
      await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, "debug_traceCall", traceParams), safeRejection("RPC_FAILED"));
    }
    for (const suffix of ["..", " extra", "\n", "\r\n", " https://example.invalid/path", "?url=https://example.invalid/", "\u0000"]) {
      error = { code: -32000, message: standard + suffix };
      await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, "eth_simulateV1", params), safeRejection("RPC_FAILED"));
    }
    for (const code of [-32602, -32601, -32001, -32603, -32099]) {
      error = { code, message: standard };
      await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, "eth_simulateV1", params),
        safeRejection(code === -32601 ? "NEXT_BLOCK_METHOD_UNAVAILABLE" : "RPC_FAILED"));
    }
  }
  for (const message of ["canonical block not found, hash: " + hash(HEAD), "unknown block hash: " + hash(HEAD),
    "canonical block not found, hash: " + UNKNOWN_HASH + "0", "canonical block not found, hash: " + UNKNOWN_HASH.slice(0, -1),
    "invalid params: header for hash not found", "method unavailable: canonical block not found, hash: " + UNKNOWN_HASH,
    "https://example.invalid/header for hash not found", "canonical transaction not found, hash: " + UNKNOWN_HASH,
    "header for hash found", "UNTRUSTED_ARBITRARY_MESSAGE"]) {
    error = { code: -32000, message };
    await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, "eth_simulateV1", params), safeRejection("RPC_FAILED"));
  }
});

test("HTTP simulation forbids unpinned references, extra overrides, partial options and multiple calls before fetch", async () => {
  for (const mutate of [p => { p[1] = "latest"; }, p => { p[1] = "pending"; }, p => { p[1].requireCanonical = false; },
    p => { p[0].blockStateCalls[0].stateOverrides = {}; }, p => { p[0].blockStateCalls[0].blockOverrides.baseFeePerGas = "0x0"; },
    p => { p[0].validation = false; }, p => { p[0].returnFullTransactions = false; }, p => { p[0].traceTransfers = true; },
    p => { p[0].blockStateCalls[0].calls.push(p[0].blockStateCalls[0].calls[0]); }]) {
    const params = structuredClone(buildNextBlockRequest(createNextBlockContext(header()), TX)); mutate(params);
    await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, "eth_simulateV1", params), safeRejection("NEXT_BLOCK_OPTIONS_INVALID"));
  }
});

test("HTTP simulation retains bounded response size and fixed sanitized transport errors", async t => {
  let reads = 0, cancelled = 0;
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, body: { getReader: () => ({
    read: async () => { reads++; return { done: false, value: Buffer.alloc(MAX_RESPONSE_BYTES / 2) }; },
    cancel: async () => { cancelled++; }, releaseLock: () => {} }) } }));
  await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, "eth_simulateV1", buildNextBlockRequest(createNextBlockContext(header()), TX)),
    safeRejection("RPC_RESPONSE_TOO_LARGE"));
  assert.equal(reads, 3); assert.equal(cancelled, 1);
});

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function recheckFixture(options = {}, internal) {
  const providers = [{ family: "a" }, { family: "b" }], state = { now: NOW, calls: [], hook: async () => undefined };
  const child = createNextBlockSimulation({ pin: header(), providers, now: () => state.now, assertUsable() {}, ...options,
    request: async (provider, method, params) => {
      const call = { alias: providers.indexOf(provider), method, params }; state.calls.push(call);
      const changed = await state.hook(call); if (changed !== undefined) return changed;
      return method === "eth_chainId" ? "0x1" : header(params[0] === "latest" ? HEAD : Number(BigInt(params[0])));
    } }, internal);
  return { child, state };
}

for (const parallelRecheck of [undefined, false, true]) test(`recheck width/order is chain-first, opt-in only (${parallelRecheck})`, async () => {
  const f = recheckFixture({ parallelRecheck }), chain = deferred(), canonical = deferred(), latest = deferred();
  const active = [0, 0], peak = [0, 0];
  f.state.hook = async call => {
    peak[call.alias] = Math.max(peak[call.alias], ++active[call.alias]);
    try { await (call.method === "eth_chainId" ? chain : call.params[0] === "latest" ? latest : canonical).promise; }
    finally { active[call.alias]--; }
  };
  const checking = f.child.recheck(); await turn();
  assert.deepEqual(f.state.calls.map(c => c.method), ["eth_chainId", "eth_chainId"]);
  chain.resolve(); await turn();
  assert.equal(f.state.calls.length, parallelRecheck ? 6 : 4);
  canonical.resolve(); await turn(); assert.equal(f.state.calls.length, 6);
  latest.resolve(); assert.equal(await checking, f.child.context);
  assert.deepEqual(peak, parallelRecheck ? [2, 2] : [1, 1]); assert.deepEqual(active, [0, 0]);
  for (const alias of [0, 1]) assert.deepEqual(f.state.calls.filter(c => c.alias === alias).map(c => [c.method, c.params]), [
    ["eth_chainId", []], ["eth_getBlockByNumber", [hex(HEAD), false]], ["eth_getBlockByNumber", ["latest", false]],
  ]);
});

test("parallel recheck validates its option and never launches header reads for a failed chain witness", async () => {
  for (const parallelRecheck of [null, 1, "true", {}]) assert.throws(() => recheckFixture({ parallelRecheck }), /NEXT_BLOCK_OPTIONS_INVALID/);
  const f = recheckFixture({ parallelRecheck: true, classifyNormalAdvance: true });
  f.state.hook = call => call.alias === 0 && call.method === "eth_chainId" ? "0x2" : undefined;
  await assert.rejects(f.child.recheck(), safeRejection("NEXT_BLOCK_WRONG_CHAIN"));
  assert.equal(f.state.calls.filter(c => c.alias === 0).length, 1);
});

for (const badRead of ["latest", hex(HEAD)]) for (const failure of ["malformed", "canonical"])
  test(`parallel ${badRead} ${failure} outranks sibling timeout and drains every started read`, async () => {
    const f = recheckFixture({ parallelRecheck: true, classifyNormalAdvance: true }), bad = deferred(), otherWitness = deferred();
    let done = false;
    f.state.hook = async call => {
      if (call.method === "eth_chainId") return;
      if (call.alias === 1) { await otherWitness.promise; return; }
      if (call.params[0] !== badRead) throw new ExecutionError("RPC_TIMEOUT");
      await bad.promise; return failure === "malformed" ? {} : { ...header(), stateRoot: hash(99) };
    };
    const checking = f.child.recheck().finally(() => { done = true; });
    const rejected = assert.rejects(checking, safeRejection(failure === "malformed" ? "NEXT_BLOCK_HEADER_INVALID" : "NEXT_BLOCK_CANONICAL_DISAGREEMENT"));
    await turn(); assert.equal(done, false); assert.equal(f.state.calls.length, 6);
    bad.resolve(); await turn(); assert.equal(done, false, "other witness still draining");
    f.state.now = (TIME + 12) * 1000; otherWitness.resolve(); await rejected;
    const count = f.state.calls.length;
    await assert.rejects(f.child.recheck(), safeRejection("NEXT_BLOCK_EVIDENCE_INVALIDATED"));
    assert.equal(f.state.calls.length, count);
  });

test("parallel recheck preserves original-order trust precedence independent of completion order", async () => {
  const f = recheckFixture({ parallelRecheck: true, classifyNormalAdvance: true }), gate = deferred();
  f.state.hook = async call => {
    if (call.method === "eth_chainId" || call.alias === 1) return;
    if (call.params[0] === "latest") return { ...header(), stateRoot: hash(99) };
    await gate.promise; return {};
  };
  const checking = f.child.recheck(), rejected = assert.rejects(checking, safeRejection("NEXT_BLOCK_HEADER_INVALID"));
  await turn(); gate.resolve(); await rejected;
});

test("parallel recheck still checks the final deadline after both headers finish", async () => {
  const f = recheckFixture({ parallelRecheck: true }), gate = deferred();
  f.state.hook = async call => { if (call.method === "eth_getBlockByNumber") await gate.promise; };
  const checking = f.child.recheck(), rejected = assert.rejects(checking, safeRejection("NEXT_BLOCK_DEADLINE"));
  await turn(); assert.equal(f.state.calls.length, 6); f.state.now = (TIME + 12) * 1000;
  gate.resolve(); await rejected;
});

for (const disagree of [false, true]) test(`parallel staggered heads retain full extension proof (${disagree})`, async () => {
  const f = recheckFixture({ parallelRecheck: true, classifyNormalAdvance: true });
  f.state.hook = call => {
    if (call.method === "eth_chainId") return;
    const number = call.params[0] === "latest" ? HEAD + (call.alias === 0 ? 2 : 1) : Number(BigInt(call.params[0]));
    return { ...header(number), ...(disagree && call.alias === 1 && number === HEAD + 2 ? { parentHash: hash(99) } : {}) };
  };
  await assert.rejects(f.child.recheck(), safeRejection(disagree ? "NEXT_BLOCK_CANONICAL_DISAGREEMENT" : "NEXT_BLOCK_HEAD_ADVANCED"));
  for (const number of [HEAD + 1, HEAD + 2]) assert.equal(f.state.calls.filter(c => c.params[0] === hex(number)).length, 2);
});

for (const failure of ["canonical", "malformed", "wrong-chain", "parent-changed"])
  test(`private revoker observes ${failure} before sibling drain, without changing the aggregate error`, async () => {
    let revoked = 0, done = false;
    const f = recheckFixture({ parallelRecheck: true, classifyNormalAdvance: true }, { onParentTrustFailure() { revoked++; } });
    const gate = deferred();
    f.state.hook = async call => {
      if (failure === "wrong-chain") {
        if (call.method === "eth_chainId") { if (call.alias === 0) return "0x2"; await gate.promise; }
        return;
      }
      if (call.method !== "eth_getBlockByNumber" || call.alias !== 0) return;
      if (call.params[0] === "latest") { await gate.promise; return; }
      if (failure === "parent-changed") throw new ExecutionError("NEXT_BLOCK_PARENT_CHANGED");
      return failure === "malformed" ? {} : { ...header(), stateRoot: hash(99) };
    };
    const checking = f.child.recheck().finally(() => { done = true; });
    const code = { canonical: "NEXT_BLOCK_CANONICAL_DISAGREEMENT", malformed: "NEXT_BLOCK_HEADER_INVALID",
      "wrong-chain": "NEXT_BLOCK_WRONG_CHAIN", "parent-changed": "NEXT_BLOCK_PARENT_CHANGED" }[failure];
    const rejected = assert.rejects(checking, safeRejection(code));
    await turn(); assert.equal(revoked, 1); assert.equal(done, false);
    assert.throws(f.child.assertUsable, safeRejection("NEXT_BLOCK_EVIDENCE_INVALIDATED"));
    gate.resolve(); await rejected; assert.equal(revoked, 1); assert.equal(done, true);
  });

test("a delayed parent contradiction still revokes immediately after a benign sibling failure while another witness drains", async () => {
  const bad = deferred(), other = deferred(); let revoked = 0, done = false;
  const f = recheckFixture({ parallelRecheck: true, classifyNormalAdvance: true }, { onParentTrustFailure() { revoked++; } });
  f.state.hook = async call => {
    if (call.method === "eth_chainId") return;
    if (call.alias === 1) { await other.promise; return; }
    if (call.params[0] === "latest") throw new ExecutionError("RPC_TIMEOUT");
    await bad.promise; return { ...header(), stateRoot: hash(99) };
  };
  const checking = f.child.recheck().finally(() => { done = true; });
  const rejected = assert.rejects(checking, safeRejection("NEXT_BLOCK_CANONICAL_DISAGREEMENT"));
  await turn(); assert.equal(revoked, 0); assert.equal(done, false); f.child.assertUsable();
  bad.resolve(); await turn(); assert.equal(revoked, 1); assert.equal(done, false);
  assert.throws(f.child.assertUsable, /NEXT_BLOCK_EVIDENCE_INVALIDATED/);
  other.resolve(); await rejected; assert.equal(revoked, 1);
});

test("immediate revocation cannot replace original-order aggregate precedence or bypass draining even if the private hook throws", async () => {
  const gate = deferred(); let revoked = 0, done = false;
  const f = recheckFixture({ parallelRecheck: true, classifyNormalAdvance: true }, { onParentTrustFailure() {
    revoked++; throw new Error("PRIVATE_REVOKER_FAILURE");
  } });
  f.state.hook = async call => {
    if (call.method === "eth_chainId" || call.alias === 1) return;
    if (call.params[0] === "latest") return { ...header(), stateRoot: hash(99) };
    await gate.promise; return {};
  };
  const checking = f.child.recheck().finally(() => { done = true; }), rejected = assert.rejects(checking, safeRejection("NEXT_BLOCK_HEADER_INVALID"));
  await turn(); assert.equal(revoked, 1); assert.equal(done, false); assert.throws(f.child.assertUsable, /NEXT_BLOCK_EVIDENCE_INVALIDATED/);
  gate.resolve(); await rejected; assert.equal(revoked, 1);
});

for (const failure of ["parent-invalidated", "clock-invalid"]) test(`private revoker covers immediate ${failure} without starting reads`, async () => {
  let revoked = 0;
  const f = recheckFixture({ parallelRecheck: true, classifyNormalAdvance: true, assertUsable() {
    if (failure === "parent-invalidated") throw new ExecutionError("PIN_EVIDENCE_INVALIDATED");
  } }, { onParentTrustFailure() { revoked++; } });
  if (failure === "clock-invalid") f.state.now = TIME * 1000 - 1;
  await assert.rejects(f.child.recheck(), safeRejection(failure === "parent-invalidated" ? "NEXT_BLOCK_PARENT_INVALIDATED" : "NEXT_BLOCK_CLOCK_INVALID"));
  assert.equal(revoked, 1); assert.equal(f.state.calls.length, 0);
});

test("malformed canonical-extension witness revokes parent trust before its agreeing sibling completes", async () => {
  const gate = deferred(); let revoked = 0, done = false;
  const f = recheckFixture({ parallelRecheck: true, classifyNormalAdvance: true }, { onParentTrustFailure() { revoked++; } });
  f.state.hook = async call => {
    if (call.method === "eth_chainId") return;
    if (call.params[0] === "latest") return header(HEAD + 1);
    if (call.params[0] === hex(HEAD + 1)) { if (call.alias === 0) return {}; await gate.promise; }
  };
  const checking = f.child.recheck().finally(() => { done = true; }), rejected = assert.rejects(checking, safeRejection("NEXT_BLOCK_HEADER_INVALID"));
  await turn(); assert.equal(revoked, 1); assert.equal(done, false);
  assert.equal(f.state.calls.filter(call => call.params[0] === hex(HEAD + 1)).length, 2);
  gate.resolve(); await rejected;
});

test("classified parent failure during simulation revokes before its simulation sibling drains", async () => {
  const gate = deferred(); let revoked = 0, done = false;
  const f = recheckFixture({ parallelRecheck: true, classifyNormalAdvance: true }, { onParentTrustFailure() { revoked++; } });
  f.state.hook = async call => {
    if (call.method !== "eth_simulateV1") return;
    if (call.alias === 0) throw new ExecutionError("NEXT_BLOCK_PARENT_CHANGED");
    await gate.promise; return response(call.params);
  };
  const checking = f.child.simulate(TX).finally(() => { done = true; }), rejected = assert.rejects(checking, safeRejection("NEXT_BLOCK_PARENT_CHANGED"));
  await turn(); assert.equal(revoked, 1); assert.equal(done, false);
  gate.resolve(); await rejected;
});

for (const benign of ["timeout", "deadline", "normal-advance"]) test(`private parent revoker ignores optional ${benign}`, async () => {
  let revoked = 0;
  const f = recheckFixture({ parallelRecheck: true, classifyNormalAdvance: true }, { onParentTrustFailure() { revoked++; } });
  if (benign === "deadline") f.state.now = (TIME + 12) * 1000;
  f.state.hook = call => {
    if (benign === "timeout") throw new ExecutionError("RPC_TIMEOUT");
    if (call.method === "eth_getBlockByNumber" && call.params[0] === "latest") return header(HEAD + 1);
  };
  await assert.rejects(f.child.recheck(), safeRejection({ timeout: "RPC_TIMEOUT", deadline: "NEXT_BLOCK_DEADLINE", "normal-advance": "NEXT_BLOCK_HEAD_ADVANCED" }[benign]));
  assert.equal(revoked, 0);
});

test("revocation hook is private/default-off; ordinary serial callers retain canonical-before-latest behavior", async () => {
  let publicCalls = 0;
  const f = recheckFixture({ classifyNormalAdvance: true, onParentTrustFailure() { publicCalls++; } }), gate = deferred();
  f.state.hook = async call => {
    if (call.method === "eth_chainId") return;
    if (call.alias === 1) { await gate.promise; return; }
    return { ...header(), stateRoot: hash(99) };
  };
  const checking = f.child.recheck(), rejected = assert.rejects(checking, safeRejection("NEXT_BLOCK_CANONICAL_DISAGREEMENT"));
  await turn(); f.child.assertUsable(); assert.equal(publicCalls, 0);
  assert.equal(f.state.calls.some(call => call.alias === 0 && call.params[0] === "latest"), false);
  gate.resolve(); await rejected; assert.equal(publicCalls, 0);
  for (const onParentTrustFailure of [null, true, "callback"])
    assert.throws(() => recheckFixture({}, { onParentTrustFailure }), /NEXT_BLOCK_OPTIONS_INVALID/);
});
