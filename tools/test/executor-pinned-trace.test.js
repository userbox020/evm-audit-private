"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { ExecutionError } = require("../lib/wallet-execution-guard.js");
const { createPinnedRpc, httpRpc, normalizeCallTrace, MULTICALL3, PROBE, MAX_CANDIDATES,
  QUALIFICATION_CONCURRENCY, REQUEST_TIMEOUT_MS, MAX_RESPONSE_BYTES } = require("../lib/executor-pinned-rpc.js");
const NOW = Date.parse("2026-10-19T23:00:00Z"), HEAD = 1000;
const hex = n => "0x" + BigInt(n).toString(16), hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const address = n => "0x" + BigInt(n).toString(16).padStart(40, "0"), UNKNOWN = "0x" + "f".repeat(64);
const TX = { from: address(1), to: address(2), data: "0x1234", value: "0x0" };
const traceOptions = () => ({ tracer: "callTracer", timeout: "3s", tracerConfig: { onlyTopCall: false } });
const traceParams = (blockHash = hash(HEAD)) => [{ ...TX }, { blockHash, requireCanonical: true }, traceOptions()];
const frame = (extra = {}) => ({ type: "CALL", from: TX.from, to: TX.to, input: TX.data, output: "0x", value: "0x0", ...extra });
const header = number => ({ number: hex(number), hash: hash(number), parentHash: hash(number - 1), stateRoot: hash(7),
  timestamp: hex(NOW / 1000 - 12 - (HEAD - number) * 12), baseFeePerGas: hex(100000000) });
function fixture(modes = ["trace", "trace"], { families, hook = () => undefined } = {}) {
  const candidates = modes.map((_, i) => ({ handle: "SYNTHETIC_OPAQUE_" + i, family: families?.[i] ?? "synthetic-family-" + i }));
  const calls = [], state = { active: 0, peak: 0, traceDifference: false, drift: false, phase: "qualifying" };
  const rpc = async (candidate, method, params, timeoutMs) => {
    const alias = candidates.indexOf(candidate) + 1, mode = modes[alias - 1];
    const call = { alias, method, params: structuredClone(params), timeoutMs }; calls.push(call);
    state.active++; state.peak = Math.max(state.peak, state.active);
    try {
      await Promise.resolve(); assert.equal(timeoutMs, REQUEST_TIMEOUT_MS);
      const changed = hook({ call, calls, state, mode });
      if (changed !== undefined) return changed;
      if (method === "eth_chainId") return mode === "wrong-chain" ? "0x2" : "0x1";
      if (method === "eth_getBlockByNumber") {
        const number = params[0] === "latest" || mode === "header-latest" ? HEAD : Number(BigInt(params[0]));
        return { ...header(number), ...(state.drift ? { stateRoot: hash(9) } : {}) };
      }
      if (method === "eth_call" || method === "eth_estimateGas") {
        assert.deepEqual(params[1], { blockHash: params[1].blockHash, requireCanonical: true });
        if (mode === "no-call") throw new Error("UNTRUSTED_CALL_DETAILS");
        if (method === "eth_estimateGas") return "0x10000";
        if (params[0].to === MULTICALL3 && params[0].data === PROBE.encodeFunctionData("getBlockNumber")) return hash(BigInt(params[1].blockHash));
        return "0x1234";
      }
      if (method === "debug_traceCall") {
        assert.deepEqual(params[2], traceOptions());
        assert.deepEqual(params[1], { blockHash: params[1].blockHash, requireCanonical: true });
        if (mode === "call-only") throw new ExecutionError("TRACE_METHOD_UNAVAILABLE");
        if (params[1].blockHash === UNKNOWN) {
          if (mode === "unknown-invalid-params") throw new ExecutionError("RPC_FAILED");
          if (mode === "unknown-unsupported") throw new ExecutionError("TRACE_METHOD_UNAVAILABLE");
          if (mode === "unknown-forged-code") throw Object.assign(new Error("UNTRUSTED_UNKNOWN"), { code: "UNKNOWN_BLOCK_REJECTED" });
          if (mode !== "accepts-unknown") throw new ExecutionError("UNKNOWN_BLOCK_REJECTED");
        }
        const tx = params[0], number = mode === "trace-latest" ? HEAD : BigInt(params[1].blockHash);
        const probe = tx.to === MULTICALL3;
        const result = frame({ from: tx.from, to: tx.to, input: tx.data, value: tx.value,
          output: probe ? hash(number) : "0x", gas: hex(alias * 100), gasUsed: hex(alias), clientMetadata: "UNTRUSTED_CLIENT_METADATA" });
        if (!probe) result.calls = [frame({ type: "STATICCALL", to: address(3), output: "0xab" }), frame({ to: address(4), value: "0x1" })];
        if (!probe && state.traceDifference && alias === 2) result.calls.reverse();
        return result;
      }
      if (method === "eth_getTransactionCount") return "0x1";
      if (method === "eth_getTransactionReceipt") return null;
      assert.fail("UNPLANNED_METHOD");
    } finally { state.active--; }
  };
  return { candidates, rpc, calls, state, connect: options => createPinnedRpc({ candidates, rpc, now: () => NOW, ...options }) };
}
function envelope(result) { return { jsonrpc: "2.0", id: 1, result }; }
function rpcError(code, message) { return { jsonrpc: "2.0", id: 1, error: { code, message, data: "UNTRUSTED_ERROR_DATA" } }; }
function safeRejection(code) {
  return error => {
    assert.equal(error.code, code); assert.equal(error.message, code);
    assert.doesNotMatch(error.stack + JSON.stringify(error), /UNTRUSTED|SYNTHETIC_OPAQUE/); return true;
  };
}

const originalFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = () => { throw new Error("OFFLINE_NETWORK_FORBIDDEN"); }; });
test.after(() => { globalThis.fetch = originalFetch; });

test("default and explicit false retain call-only qualification and expose no trace API", async () => {
  for (const options of [{}, { requireTrace: false }]) {
    const f = fixture(["call-only", "call-only"]), api = await f.connect(options);
    assert.equal(api.trace, undefined); assert.equal(api.evidence.traceQualified, undefined);
    assert.deepEqual(api.evidence.qualification, [{ alias: 1, qualified: true }, { alias: 2, qualified: true }]);
    assert.equal(await api.call(TX), "0x1234"); await api.recheck();
    assert.equal(f.calls.some(call => call.method === "debug_traceCall"), false);
  }
});

test("all bounded candidates qualify before selection; earlier call-only families are excluded from the entire API", async () => {
  const modes = ["call-only", "call-only", "trace", "trace", "trace", "wrong-chain", "no-call"];
  const seenChain = new Set(), seenTrace = new Set();
  const f = fixture(modes, { hook: ({ call }) => {
    if (call.method === "eth_chainId") seenChain.add(call.alias);
    if (call.method === "debug_traceCall") {
      seenTrace.add(call.alias);
      if (call.params[1].blockHash === hash(HEAD)) { assert.equal(seenChain.size, modes.length); assert.equal(seenTrace.size, 5); }
    }
  } });
  const api = await f.connect({ requireTrace: true });
  assert.deepEqual(api.evidence.aliases, [3, 4]); assert.equal(api.evidence.traceQualified, true);
  assert.equal(api.evidence.qualification.length, modes.length); assert.equal(f.state.peak, QUALIFICATION_CONCURRENCY); assert.equal(f.state.active, 0);
  assert.deepEqual(api.evidence.qualification.filter(row => row.qualified).map(row => row.alias), [3, 4, 5]);
  for (const row of api.evidence.qualification.filter(row => row.qualified)) {
    assert.equal(row.traceQualified, true); assert.equal(row.hashPinnedBlockNumberVerified, true); assert.equal(row.unknownHashRejected, true);
    assert.equal(row.probePin.number, HEAD - 1); assert.equal(row.probePin.hash, hash(HEAD - 1));
  }
  const before = f.calls.length;
  await api.call(TX); await api.estimateGas(TX); await api.recheck(); await api.nonce(TX.from); await api.receipt(hash(42));
  const trace = await api.trace(TX); assert.equal(trace.nodes, 3);
  assert.ok(f.calls.slice(before).every(call => [3, 4].includes(call.alias)));
  assert.doesNotMatch(JSON.stringify(api.evidence) + JSON.stringify(trace), /UNTRUSTED|SYNTHETIC_OPAQUE|synthetic-family/);
});

test("capability probes use a real previous block, EIP-1898 and exact fixed callTracer settings", async () => {
  const f = fixture(), api = await f.connect({ requireTrace: true });
  for (const alias of [1, 2]) {
    const calls = f.calls.filter(call => call.alias === alias), traces = calls.filter(call => call.method === "debug_traceCall");
    assert.deepEqual(traces.map(call => call.params[1].blockHash), [hash(HEAD - 1), UNKNOWN, hash(HEAD)]);
    for (const call of traces) {
      assert.equal(call.params[1].requireCanonical, true); assert.deepEqual(call.params[2], traceOptions());
      assert.equal(call.timeoutMs, 4000);
    }
    assert.equal(calls.filter(call => call.method === "eth_getBlockByNumber" && call.params[0] === hex(HEAD - 1)).length, 2);
    assert.ok(calls.some(call => call.method === "eth_call" && call.params[1].blockHash === hash(HEAD - 1)));
  }
  assert.equal(api.pin.number, HEAD);
});

test("same-family, unsupported, hash-ignorant/latest-only and non-genuine unknown probes fail closed", async () => {
  const sameFamily = fixture(["trace", "trace"], { families: ["one", "one"] });
  await assert.rejects(sameFamily.connect({ requireTrace: true }), safeRejection("TWO_TRACE_CAPABLE_FAMILIES_REQUIRED"));
  for (const mode of ["call-only", "trace-latest", "header-latest", "accepts-unknown", "unknown-invalid-params", "unknown-unsupported", "unknown-forged-code"]) {
    const f = fixture([mode, mode]);
    await assert.rejects(f.connect({ requireTrace: true }), safeRejection("TWO_TRACE_CAPABLE_FAMILIES_REQUIRED"));
    assert.equal(f.state.active, 0);
  }
});

test("a wrong previous-block output or changed full qualification header cannot qualify", async () => {
  for (const field of ["output", "stateRoot", "baseFeePerGas", "parentHash", "timestamp"]) {
    const counts = new Map();
    const f = fixture(["trace", "trace"], { hook: ({ call }) => {
      if (field === "output" && call.method === "debug_traceCall" && call.params[1].blockHash === hash(HEAD - 1)) {
        return frame({ from: call.params[0].from, to: MULTICALL3, input: call.params[0].data, output: hash(HEAD - 2) });
      }
      if (field !== "output" && call.method === "eth_getBlockByNumber" && call.params[0] === hex(HEAD - 1)) {
        const count = (counts.get(call.alias) ?? 0) + 1; counts.set(call.alias, count);
        if (count === 2) return { ...header(HEAD - 1), [field]: field === "timestamp" ? hex(NOW / 1000 - 25) : hash(99) };
      }
    } });
    await assert.rejects(f.connect({ requireTrace: true }), safeRejection("TWO_TRACE_CAPABLE_FAMILIES_REQUIRED"));
  }
});

test("trace normalization ignores gas/client metadata but retains values, frame order and revert booleans", () => {
  const left = frame({ calls: [frame({ value: "0x01", error: "UNTRUSTED_REVERT_REASON", output: "0xAB" }), frame({ to: address(9) })] });
  const right = structuredClone(left); right.gas = "0xffff"; right.client = "UNTRUSTED_CLIENT";
  right.calls[0].value = "0x1"; right.calls[0].error = "different provider reason"; right.calls[0].output = "0xab";
  const normalized = normalizeCallTrace(left);
  assert.deepEqual(normalized, normalizeCallTrace(right)); assert.equal(normalized.nodes, 3);
  assert.equal(normalized.tree.calls[0].value, "1"); assert.equal(normalized.tree.calls[0].reverted, true);
  assert.doesNotMatch(JSON.stringify(normalized), /UNTRUSTED|provider reason/);
  for (const change of [row => { row.calls[0].value = "0x2"; }, row => { row.calls.reverse(); }, row => { delete row.calls[0].error; }]) {
    const changed = structuredClone(right); change(changed); assert.notDeepEqual(normalized, normalizeCallTrace(changed));
  }
  assert.equal(left.calls[0].output, "0xAB");
});

test("malformed trace errors, calls, addresses, values and byte fields are rejected safely", () => {
  for (const extra of [{ error: false }, { error: null }, { error: {} }, { error: "" }, { error: " " }, { calls: null }, { calls: {} },
    { calls: [null] }, { type: "UNKNOWN" }, { from: "UNTRUSTED_ADDRESS" }, { to: null }, { input: "0x1" }, { output: null },
    { value: -1 }, { value: "1" }, { value: null }, { value: "0x" + "f".repeat(65) }, { reverted: true }, { reverted: "yes" }]) {
    assert.throws(() => normalizeCallTrace(frame(extra)), safeRejection("TRACE_SHAPE_INVALID"));
  }
});

test("normalization bounds 2000 nodes and depth 64, including cycles and sparse children", () => {
  assert.equal(normalizeCallTrace(frame({ calls: Array.from({ length: 1999 }, () => frame()) })).nodes, 2000);
  assert.throws(() => normalizeCallTrace(frame({ calls: Array.from({ length: 2000 }, () => frame()) })), /TRACE_SHAPE_INVALID/);
  let nested = frame(); for (let i = 0; i < 64; i++) nested = frame({ calls: [nested] });
  assert.equal(normalizeCallTrace(nested).nodes, 65);
  assert.throws(() => normalizeCallTrace(frame({ calls: [nested] })), /TRACE_SHAPE_INVALID/);
  const cycle = frame(); cycle.calls = [cycle]; assert.throws(() => normalizeCallTrace(cycle), /TRACE_SHAPE_INVALID/);
  assert.throws(() => normalizeCallTrace(frame({ calls: new Array(1) })), /TRACE_SHAPE_INVALID/);
});

test("pair trace disagreement poisons the entire API, not just later traces", async () => {
  const f = fixture(), api = await f.connect({ requireTrace: true });
  const start = f.calls.length;
  f.state.traceDifference = true;
  await assert.rejects(api.trace(TX), safeRejection("PROVIDER_RESULT_DISAGREEMENT"));
  assert.deepEqual(f.calls.slice(start).map(c => c.alias).sort(), [1, 2]);
  const before = f.calls.length;
  await assert.rejects(api.call(TX), { code: "PIN_EVIDENCE_INVALIDATED" });
  await assert.rejects(api.estimateGas(TX), { code: "PIN_EVIDENCE_INVALIDATED" });
  await assert.rejects(api.trace(TX), { code: "PIN_EVIDENCE_INVALIDATED" });
  await assert.rejects(api.recheck(), { code: "PIN_EVIDENCE_INVALIDATED" });
  assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" }); assert.equal(f.calls.length, before);
});

test("matching reverted trace trees return sanitized evidence, while malformed traces poison", async () => {
  let malformed = false;
  const f = fixture(["trace", "trace"], { hook: ({ call }) => call.method === "debug_traceCall" && call.params[0].to === TX.to
    ? frame({ error: malformed ? false : "UNTRUSTED_PROVIDER_REVERT", output: "0xab" }) : undefined });
  const api = await f.connect({ requireTrace: true }), trace = await api.trace(TX);
  assert.equal(trace.tree.reverted, true); assert.doesNotMatch(JSON.stringify(trace), /UNTRUSTED/); api.assertUsable();
  const before = f.calls.length;
  malformed = true; await assert.rejects(api.trace(TX), safeRejection("TRACE_SHAPE_INVALID"));
  assert.deepEqual(f.calls.slice(before).map(c => c.alias).sort(), [1, 2]);
  assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" });
});

test("trace timeout retries only the failed witness with the identical hash and tracer options", async () => {
  let failures = 1;
  const f = fixture(undefined, { hook: ({ call }) => {
    if (call.alias === 1 && call.method === "debug_traceCall" && call.params[0].to === TX.to && failures-- > 0)
      throw new ExecutionError("RPC_TIMEOUT");
  } }), api = await f.connect({ requireTrace: true }), before = f.calls.length;
  assert.equal((await api.trace(TX)).nodes, 3); api.assertUsable();
  const calls = f.calls.slice(before);
  assert.deepEqual(calls.map(c => c.alias).sort(), [1, 1, 2]);
  for (const call of calls) assert.deepEqual(call.params, traceParams());
});

test("final construction recheck and subsequent recheck reject full-header drift", async () => {
  const f = fixture(), api = await f.connect({ requireTrace: true }); f.state.drift = true;
  await assert.rejects(api.recheck(), { code: "PIN_CHANGED" }); assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" });
  let sharedPinTraces = 0;
  const late = fixture(["trace", "trace"], { hook: ({ call, state }) => {
    if (call.method === "debug_traceCall" && call.params[1].blockHash === hash(HEAD) && ++sharedPinTraces === 2) state.drift = true;
  } });
  await assert.rejects(late.connect({ requireTrace: true }), safeRejection("PIN_CHANGED"));
});

test("unsupported opt-in types/options and oversized pools reject before any requests", async () => {
  const f = fixture();
  for (const requireTrace of [null, "true", 1, {}, []]) await assert.rejects(f.connect({ requireTrace }), { code: "TRACE_OPTIONS_INVALID" });
  for (const extra of [{ tracer: "prestateTracer" }, { traceOptions: {} }, { timeoutMs: 9999 }, { now: null }]) {
    await assert.rejects(f.connect({ requireTrace: true, ...extra }), { code: "TRACE_OPTIONS_INVALID" });
  }
  await assert.rejects(createPinnedRpc({ candidates: Array(MAX_CANDIDATES + 1).fill(f.candidates[0]), rpc: f.rpc, requireTrace: true }), { code: "RPC_CANDIDATES_INVALID" });
  assert.equal(f.calls.length, 0);
  const api = await f.connect({ requireTrace: true }), before = f.calls.length;
  await assert.rejects(api.trace(TX, {}), { code: "TRACE_OPTIONS_INVALID" });
  await assert.rejects(api.trace(null), { code: "TRACE_OPTIONS_INVALID" }); assert.equal(f.calls.length, before);
});

test("HTTP trace handling uses fixed pinned options and strips all provider messages/metadata", async t => {
  let payload = envelope(frame({ error: "UNTRUSTED_PROVIDER_ERROR", gas: "UNTRUSTED_GAS", client: "UNTRUSTED_CLIENT" })), requests = 0;
  t.mock.method(globalThis, "fetch", async (_handle, options) => {
    requests++; const body = JSON.parse(options.body);
    assert.equal(body.method, "debug_traceCall"); assert.deepEqual(body.params, traceParams());
    assert.equal(options.redirect, "error"); return new Response(JSON.stringify(payload));
  });
  const raw = await httpRpc({ handle: "SYNTHETIC_OPAQUE" }, "debug_traceCall", traceParams());
  assert.equal(normalizeCallTrace(raw).tree.reverted, true); assert.doesNotMatch(JSON.stringify(raw), /UNTRUSTED/);
  for (const params of [[TX, "latest", traceOptions()], [TX, { blockHash: hash(HEAD), requireCanonical: false }, traceOptions()],
    [TX, { blockNumber: hex(HEAD) }, traceOptions()], [TX, traceParams()[1], { ...traceOptions(), stateOverrides: {} }],
    [TX, traceParams()[1], { ...traceOptions(), tracerConfig: { onlyTopCall: true } }]]) {
    await assert.rejects(httpRpc({ handle: "SYNTHETIC_OPAQUE" }, "debug_traceCall", params), { code: "TRACE_OPTIONS_INVALID" });
  }
  assert.equal(requests, 1);
  payload = envelope(frame({ calls: null }));
  await assert.rejects(httpRpc({ handle: "SYNTHETIC_OPAQUE" }, "debug_traceCall", traceParams()), safeRejection("TRACE_SHAPE_INVALID"));
});

test("unknown-hash qualification accepts only genuine lookup/canonical rejection, never invalid params or unsupported methods", async t => {
  let payload;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload)));
  for (const message of ["unknown block", "unknown block hash: " + UNKNOWN, "header not found", "block " + UNKNOWN + " not found",
    "block is not canonical", "hash " + UNKNOWN + " is not currently canonical"]) {
    payload = rpcError(-32000, message);
    await assert.rejects(httpRpc({ handle: "SYNTHETIC_OPAQUE" }, "debug_traceCall", traceParams(UNKNOWN)), safeRejection("UNKNOWN_BLOCK_REJECTED"));
    await assert.rejects(httpRpc({ handle: "SYNTHETIC_OPAQUE" }, "debug_traceCall", traceParams()), safeRejection("RPC_FAILED"));
  }
  for (const [code, message, expected] of [[-32601, "header not found", "TRACE_METHOD_UNAVAILABLE"], [-32602, "unknown block", "RPC_FAILED"],
    [-32000, "invalid params: unknown block", "RPC_FAILED"], [-32000, "method unavailable; header not found", "RPC_FAILED"],
    [-32000, "UNTRUSTED_PROVIDER_MESSAGE", "RPC_FAILED"], [3, "execution reverted: header not found", "RPC_FAILED"]]) {
    payload = rpcError(code, message);
    await assert.rejects(httpRpc({ handle: "SYNTHETIC_OPAQUE" }, "debug_traceCall", traceParams(UNKNOWN)), safeRejection(expected));
  }
});

for (const [code, prefix] of [[-32001, "block not found: hash "], [-32001, "block not found: canonical hash "], [-32000, "block not found: "],
  [-32000, "get block number: block not found: "]])
  test(`HTTP trace exact ${code}/${prefix} is additive, full-message and requested-hash bound`, async t => {
    let payload = rpcError(code, prefix + UNKNOWN);
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload)));
    const invoke = (blockHash = UNKNOWN) => httpRpc({ handle: "SYNTHETIC_OPAQUE" }, "debug_traceCall", traceParams(blockHash));
    await assert.rejects(invoke(), safeRejection("UNKNOWN_BLOCK_REJECTED"));
    payload = rpcError(code, prefix + "0x" + "F".repeat(64));
    await assert.rejects(invoke(), safeRejection("UNKNOWN_BLOCK_REJECTED"));
    for (const message of [prefix + hash(42), "prefix " + prefix + UNKNOWN, prefix + UNKNOWN + " suffix", prefix + UNKNOWN + ".",
      " " + prefix + UNKNOWN, prefix + UNKNOWN + "\n", prefix.toUpperCase() + UNKNOWN, prefix + UNKNOWN.slice(0, -1),
      prefix + UNKNOWN + "f", prefix + UNKNOWN + " " + hash(42), prefix + UNKNOWN + "x".repeat(512),
      "invalid params: " + prefix + UNKNOWN, "unauthorized: " + prefix + UNKNOWN, "state pruned: " + prefix + UNKNOWN,
      "method not found: " + prefix + UNKNOWN, "request timed out: " + prefix + UNKNOWN]) {
      payload = rpcError(code, message); await assert.rejects(invoke(), safeRejection("RPC_FAILED"));
    }
    for (const wrongCode of [code === -32001 ? -32000 : -32001, -32002, -32603, -32602, -32601, -32099]) {
      payload = rpcError(wrongCode, prefix + UNKNOWN);
      await assert.rejects(invoke(), safeRejection(wrongCode === -32601 ? "TRACE_METHOD_UNAVAILABLE" : "RPC_FAILED"));
    }
    for (const error of [null, [], "unknown block", { code: String(code), message: prefix + UNKNOWN }, { code, message: null },
      { code, message: {} }, { code, message: [prefix + UNKNOWN] }, { code }]) {
      payload = { jsonrpc: "2.0", id: 1, error }; await assert.rejects(invoke(), safeRejection("RPC_FAILED"));
    }
    for (const requested of [hash(HEAD), hash(42)]) {
      payload = rpcError(code, prefix + requested); await assert.rejects(invoke(requested), safeRejection("RPC_FAILED"));
    }
  });

test("HTTP Erigon trace wrapper is not a call/code/simulation unknown-hash rejection", async t => {
  const { createNextBlockContext, buildNextBlockRequest, buildNextBlockProbeTransaction } = require("../lib/next-block-simulation.js");
  const pin = { ...header(HEAD), gasLimit: hex(30000000) }, ref = { blockHash: UNKNOWN, requireCanonical: true }, methods = [];
  const simulation = buildNextBlockRequest(createNextBlockContext({ number: HEAD, hash: hash(HEAD), timestamp: Number(BigInt(pin.timestamp)) }),
    buildNextBlockProbeTransaction(pin, 7, 2000000000000000n));
  simulation[1] = ref;
  t.mock.method(globalThis, "fetch", async (_, options) => {
    methods.push(JSON.parse(options.body).method);
    return new Response(JSON.stringify(rpcError(-32000, "get block number: block not found: " + UNKNOWN)));
  });
  for (const [method, params] of [["eth_call", [{ to: MULTICALL3, data: PROBE.encodeFunctionData("getBlockNumber") }, ref]],
    ["eth_getCode", [MULTICALL3, ref]], ["eth_simulateV1", simulation]])
    await assert.rejects(httpRpc({ handle: "SYNTHETIC_OPAQUE" }, method, params), safeRejection("RPC_FAILED"));
  assert.deepEqual(methods, ["eth_call", "eth_getCode", "eth_simulateV1"]);
});

test("HTTP Erigon trace wrapper rejects noncanonical and inexact wrapped errors", async t => {
  let payload;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload)));
  for (const [code, message] of [
    [-32603, "get block number: hash " + UNKNOWN.slice(2) + " is not currently canonical"],
    [-32603, "get block number: hash " + UNKNOWN + " is not currently canonical"],
    [-32000, "get block number: hash " + UNKNOWN + " is not currently canonical"],
    [-32000, "get block number: block not found: " + UNKNOWN + "\r\n"],
    [-32000, "get block number: block not found: " + UNKNOWN + "\t"],
    [-32000, "get block number: block not found:\t" + UNKNOWN],
    [-32000, "get block number: block not found: \n" + UNKNOWN],
    [-32000, "get block number: invalid params: block not found: " + UNKNOWN],
    [-32000, "get block number: unauthorized: block not found: " + UNKNOWN],
    [-32000, "get block number: method not found: " + UNKNOWN],
    [-32000, "get block number: block not found: hash " + UNKNOWN],
    [-32000, "get block number: block not found: canonical hash " + UNKNOWN],
  ]) {
    payload = rpcError(code, message);
    await assert.rejects(httpRpc({ handle: "SYNTHETIC_OPAQUE" }, "debug_traceCall", traceParams(UNKNOWN)), safeRejection("RPC_FAILED"));
  }
});

test("HTTP trace reads retain the 1 MiB cap and cancel safely with opaque errors", async t => {
  let reads = 0, cancelled = 0, released = 0, signal;
  t.mock.method(globalThis, "fetch", async (_, options) => {
    signal = options.signal;
    return { ok: true, body: { getReader: () => ({
      read: async () => { reads++; return { done: false, value: Buffer.alloc(MAX_RESPONSE_BYTES / 2) }; },
      cancel: async () => { cancelled++; throw new Error("UNTRUSTED_CANCEL"); }, releaseLock: () => { released++; },
    }) } };
  });
  await assert.rejects(httpRpc({ handle: "SYNTHETIC_OPAQUE" }, "debug_traceCall", traceParams()), safeRejection("RPC_RESPONSE_TOO_LARGE"));
  assert.equal(reads, 3); assert.equal(cancelled, 1); assert.equal(released, 1); assert.equal(signal.aborted, true);
});

test("HTTP trace timeout covers request and body, without leaking transport errors", async t => {
  let phase = "request", signal, cancelled = 0;
  t.mock.method(globalThis, "fetch", (_, options) => {
    signal = options.signal;
    if (phase === "request") return new Promise(() => {});
    if (phase === "exception") throw new Error("UNTRUSTED_TRANSPORT_DETAIL");
    return Promise.resolve({ ok: true, body: { getReader: () => ({ read: () => new Promise(() => {}),
      cancel: async () => { cancelled++; }, releaseLock: () => {} }) } });
  });
  for (phase of ["request", "body"]) {
    await assert.rejects(httpRpc({ handle: "SYNTHETIC_OPAQUE" }, "debug_traceCall", traceParams(), 10), safeRejection("RPC_TIMEOUT"));
    assert.equal(signal.aborted, true);
  }
  assert.equal(cancelled, 1); phase = "exception";
  await assert.rejects(httpRpc({ handle: "SYNTHETIC_OPAQUE" }, "debug_traceCall", traceParams()), safeRejection("RPC_FAILED"));
});
