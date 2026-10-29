"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { ExecutionError } = require("../lib/wallet-execution-guard.js");
const { createPinnedRpc, createM1HotPathFactory, httpRpc, MULTICALL3, PROBE, MAX_CANDIDATES, QUALIFICATION_CONCURRENCY,
  REQUEST_TIMEOUT_MS, MAX_RESPONSE_BYTES, MAX_AGE_MS } = require("../lib/executor-pinned-rpc.js");
const { createNextBlockContext, buildNextBlockRequest, buildNextBlockProbeTransaction } = require("../lib/next-block-simulation.js");
const NOW = Date.parse("2026-10-23T22:00:01Z"), HEAD = 1000, TIME = NOW / 1000 - 1;
const hex = n => "0x" + BigInt(n).toString(16), hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const address = n => "0x" + BigInt(n).toString(16).padStart(40, "0"), UNKNOWN = "0x" + "f".repeat(64), CODE = "0x600160ab";
const TX = { type: 2, chainId: 1, from: address(1), to: address(2), data: "0x1234", value: "0x0", nonce: 7,
  gasLimit: 180000, maxFeePerGas: 200000000, maxPriorityFeePerGas: 1, accessList: [] };
const header = (number = HEAD) => ({ number: hex(number), hash: hash(number), parentHash: hash(number - 1), stateRoot: hash(7),
  timestamp: hex(TIME + (number - HEAD) * 12), baseFeePerGas: hex(100000000), gasLimit: hex(30000000) });
const ref = (blockHash = hash(HEAD)) => ({ blockHash, requireCanonical: true });
const probeCall = () => ({ to: MULTICALL3, data: PROBE.encodeFunctionData("getBlockNumber") });
const MISSING_BLOCK_FORMS = [[-32001, "block not found: hash "], [-32001, "block not found: canonical hash "], [-32000, "block not found: "]];
function lookupParams(method, blockHash = UNKNOWN) {
  if (method !== "eth_simulateV1") return [method === "eth_call" ? probeCall() : MULTICALL3, ref(blockHash)];
  const params = buildNextBlockRequest(createNextBlockContext({ number: HEAD, hash: hash(HEAD), timestamp: TIME }),
    buildNextBlockProbeTransaction(header(), 7, 2000000000000000n));
  params[1] = ref(blockHash); return params;
}
function fixture(modes = ["strict", "strict"], { families, hook = () => undefined } = {}) {
  const candidates = modes.map((_, i) => ({ handle: "OFFLINE_OPAQUE_" + i, family: families?.[i] ?? "synthetic-family-" + i }));
  const state = { now: NOW, head: HEAD, calls: [], active: 0, peak: 0, ready: false };
  async function rpc(candidate, method, params, timeoutMs) {
    const alias = candidates.indexOf(candidate) + 1, mode = modes[alias - 1];
    const call = { alias, method, params: structuredClone(params), timeoutMs, ready: state.ready }; state.calls.push(call);
    state.active++; state.peak = Math.max(state.peak, state.active);
    try {
      await Promise.resolve(); assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= REQUEST_TIMEOUT_MS);
      const changed = hook({ call, state, mode }); if (changed !== undefined) return changed;
      if (method === "eth_chainId") return mode === "wrong-chain" ? "0x2" : "0x1";
      if (method === "eth_getBlockByNumber") return header(params[0] === "latest" || mode === "header-latest" ? state.head : Number(BigInt(params[0])));
      if (["eth_call", "eth_getCode"].includes(method)) {
        assert.deepEqual(params[1], ref(params[1].blockHash));
        if (method === "eth_getCode" && mode === "call-only") throw new ExecutionError("RPC_FAILED");
        if (params[1].blockHash === UNKNOWN) {
          const kind = method === "eth_call" ? "call" : "code";
          if (mode === kind + "-unknown-invalid") throw new ExecutionError("RPC_FAILED");
          if (mode === kind + "-unknown-forged") throw Object.assign(new Error("UNTRUSTED_LOOKUP_DETAIL"), { code: "UNKNOWN_BLOCK_REJECTED" });
          if (mode !== kind + "-accepts-unknown") throw new ExecutionError("UNKNOWN_BLOCK_REJECTED");
        }
        if (method === "eth_getCode") {
          if (mode === "code-empty") return "0x";
          if (mode === "code-malformed") return "0x1";
          if (mode === "code-history-mismatch" && params[1].blockHash === hash(HEAD - 1)) return "0x6002";
          return alias % 2 ? CODE : CODE.toUpperCase();
        }
        if (params[0].to === MULTICALL3) return hash(mode === "call-latest" || params[1].blockHash === UNKNOWN ? state.head : BigInt(params[1].blockHash));
        return "0x1234";
      }
      if (method === "eth_estimateGas") return hex(80000);
      if (method === "eth_getTransactionCount") return "0x7";
      if (method === "eth_getBalance") return hex(2000000000000000n);
      if (method === "eth_getTransactionReceipt") return null;
      if (method === "debug_traceCall") {
        if (params[1].blockHash === UNKNOWN) throw new ExecutionError("UNKNOWN_BLOCK_REJECTED");
        const tx = params[0];
        return { type: "CALL", from: tx.from, to: tx.to, input: tx.data, value: hex(tx.value ?? 0),
          output: tx.to === MULTICALL3 ? hash(BigInt(params[1].blockHash)) : "0x1234", calls: [] };
      }
      if (method === "eth_simulateV1") {
        if (params[1].blockHash === UNKNOWN) throw new ExecutionError("UNKNOWN_BLOCK_REJECTED");
        const block = params[0].blockStateCalls[0], tx = block.calls[0];
        return [{ parentHash: params[1].blockHash, number: block.blockOverrides.number, timestamp: block.blockOverrides.time,
          transactions: [structuredClone(tx)], calls: [{ status: "0x1", gasUsed: hex(80000), logs: [],
            returnData: tx.to === null ? hash(BigInt(block.blockOverrides.number)) + hash(BigInt(block.blockOverrides.time)).slice(2) : "0x1234" }] }];
      }
      assert.fail("UNPLANNED_METHOD");
    } finally { state.active--; }
  }
  return { candidates, rpc, state, connect: async (options = {}) => {
    const api = await createPinnedRpc({ candidates, rpc, now: () => state.now, requireStrictEvidence: true, ...options });
    state.ready = true; return api;
  } };
}
function safeRejection(code) {
  return error => {
    assert.ok(error instanceof ExecutionError); assert.equal(error.code, code); assert.equal(error.message, code);
    assert.doesNotMatch(error.stack + JSON.stringify(error), /UNTRUSTED|OFFLINE_OPAQUE|synthetic-family/); return true;
  };
}
function mockHttp(t, f, unknownError = { code: -32000, message: "header not found" }) {
  t.mock.method(globalThis, "fetch", async (handle, options) => {
    assert.equal(options.redirect, "error");
    const { method, params } = JSON.parse(options.body), candidate = f.candidates.find(c => c.handle === handle);
    assert.ok(candidate);
    try { return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: await f.rpc(candidate, method, params, REQUEST_TIMEOUT_MS) })); }
    catch (error) {
      if (error.code === "RPC_TIMEOUT" || error.code === "ECONNRESET") throw error;
      if (error.code === "RPC_HTTP_RETRYABLE") return new Response("UNTRUSTED_HTTP_BODY", { status: 503 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: error instanceof ExecutionError && error.code === "UNKNOWN_BLOCK_REJECTED"
        ? unknownError : { code: -32000, message: "UNTRUSTED_PROVIDER_MESSAGE" } }));
    }
  });
}
const originalFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = () => { throw new Error("OFFLINE_NETWORK_FORBIDDEN"); }; });
test.after(() => { globalThis.fetch = originalFetch; });

test("default/false preserve call-only qualification, legacy options and API/evidence shape", async () => {
  for (const requireStrictEvidence of [undefined, false]) {
    const f = fixture(["call-only", "call-only"]), api = await f.connect({ requireStrictEvidence, legacyUnusedOption: true });
    assert.equal(api.code, undefined);
    assert.deepEqual(Object.keys(api.evidence).sort(), ["aliases", "independentFamilies", "qualification"]);
    assert.deepEqual(api.evidence.qualification, [{ alias: 1, qualified: true }, { alias: 2, qualified: true }]);
    assert.equal(await api.call(TX), "0x1234"); await api.recheck();
    assert.equal(f.state.calls.some(c => c.method === "eth_getCode" || c.params[1]?.blockHash === UNKNOWN), false);
  }
});

test("strict capability qualification finishes across the bounded pool before independent-family selection", async () => {
  const seen = new Set(), codeUnknown = new Set(), chainCounts = new Map();
  const f = fixture(["call-only", "strict", "strict", "strict", "call-only", "strict"], {
    families: ["a", "z", "z", "y", "b", "x"], hook: ({ call }) => {
      if (call.method === "eth_getCode" && call.params[1].blockHash === UNKNOWN) codeUnknown.add(call.alias);
      if (call.method === "eth_chainId") {
        const count = (chainCounts.get(call.alias) ?? 0) + 1; chainCounts.set(call.alias, count);
        if (count === 1) seen.add(call.alias);
        else { assert.equal(seen.size, 6); assert.equal(codeUnknown.size, 4); }
      }
    }
  });
  const api = await f.connect();
  assert.deepEqual(api.evidence.aliases, [2, 4]); assert.equal(f.state.peak, QUALIFICATION_CONCURRENCY); assert.equal(f.state.active, 0);
  for (const key of ["strictEvidence", "fixedProviderPair", "rawTimestamp", "codeHashPinnedQualified"]) assert.equal(api.evidence[key], true);
  assert.deepEqual(api.evidence.qualification.filter(row => row.qualified).map(row => row.alias), [2, 3, 4, 6]);
  for (const row of api.evidence.qualification.filter(row => row.qualified)) {
    assert.equal(row.strictEvidence, true); assert.equal(row.hashPinnedCallQualified, true); assert.equal(row.callUnknownHashRejected, true);
    assert.equal(row.codeHashPinnedQualified, true); assert.equal(row.codeUnknownHashRejected, true); assert.equal(row.strictProbePin.number, HEAD - 1);
  }
  assert.doesNotMatch(JSON.stringify(api.evidence), /OFFLINE_OPAQUE|synthetic-family|UNTRUSTED/);
  const before = f.state.calls.length; assert.equal(await api.code(address(9)), CODE); await api.recheck();
  assert.ok(f.state.calls.slice(before).every(c => [2, 4].includes(c.alias)));
});

test("qualification verifies current/previous NUMBER and nonempty Multicall3 code with exact canonical references", async () => {
  const f = fixture(); await f.connect();
  for (const alias of [1, 2]) {
    const calls = f.state.calls.filter(c => c.alias === alias), code = calls.filter(c => c.method === "eth_getCode");
    assert.deepEqual(code.map(c => c.params), [[MULTICALL3, ref(hash(HEAD - 1))], [MULTICALL3, ref()], [MULTICALL3, ref(UNKNOWN)]]);
    const probes = calls.filter(c => c.method === "eth_call");
    assert.deepEqual(probes.map(c => c.params[1].blockHash), [hash(HEAD), hash(HEAD - 1), UNKNOWN, hash(HEAD)]);
    for (const call of probes) assert.deepEqual(call.params, [probeCall(), ref(call.params[1].blockHash)]);
  }
});

test("unsupported, hash-ignoring, malformed, wrong-chain and nongenuine lookup providers never qualify", async () => {
  for (const mode of ["call-only", "wrong-chain", "call-latest", "header-latest", "code-empty", "code-malformed", "code-history-mismatch",
    "call-accepts-unknown", "code-accepts-unknown", "call-unknown-invalid", "code-unknown-invalid", "call-unknown-forged", "code-unknown-forged"]) {
    const f = fixture([mode, mode]);
    await assert.rejects(f.connect(), safeRejection("TWO_STRICT_CAPABLE_FAMILIES_REQUIRED")); assert.equal(f.state.active, 0);
  }
  await assert.rejects(fixture(["strict", "strict"], { families: ["same", "same"] }).connect(), safeRejection("TWO_STRICT_CAPABLE_FAMILIES_REQUIRED"));
});

test("strict code consensus normalizes hex case, preserves empty code and never accepts address/options fallbacks", async () => {
  const f = fixture(undefined, { hook: ({ call, state }) => state.ready && call.method === "eth_getCode" && call.params[0] === address(8) ? "0x" : undefined });
  const api = await f.connect(), upper = "0x" + "AB".repeat(20);
  assert.equal(await api.code(upper), CODE); assert.equal(await api.code(address(8)), "0x");
  const code = f.state.calls.filter(c => c.ready && c.method === "eth_getCode");
  assert.deepEqual(code.slice(0, 2).map(c => c.params), [[upper.toLowerCase(), ref()], [upper.toLowerCase(), ref()]]);
  const before = f.state.calls.length;
  for (const value of [null, 1, {}, "latest", "0x1234", "UNTRUSTED_ADDRESS", address(9) + "\n"])
    await assert.rejects(api.code(value), safeRejection("PIN_CODE_REQUEST_INVALID"));
  await assert.rejects(api.code(address(9), "latest"), safeRejection("PIN_CODE_REQUEST_INVALID"));
  assert.equal(f.state.calls.length, before); api.assertUsable();
});

test("code disagreement, malformed/oversized bytes and unsupported reads poison the fixed session", async () => {
  for (const [value, expected] of [["0x6002", "PROVIDER_RESULT_DISAGREEMENT"], [null, "PIN_CODE_RESULT_INVALID"],
    ["0x1", "PIN_CODE_RESULT_INVALID"], ["0xAB\n", "PIN_CODE_RESULT_INVALID"], ["0xAB\r\n", "PIN_CODE_RESULT_INVALID"], ["UNTRUSTED_CODE", "PIN_CODE_RESULT_INVALID"],
    ["0x" + "ab".repeat(MAX_RESPONSE_BYTES + 1), "PIN_CODE_RESULT_INVALID"], ["unsupported", "PINNED_RPC_FAILED"]]) {
    const f = fixture(["strict", "strict", "strict"], { hook: ({ call, state }) => {
      if (state.ready && call.alias === 2 && call.method === "eth_getCode") {
        if (value === "unsupported") throw new Error("UNTRUSTED_METHOD_DETAILS"); return value;
      }
    } }), api = await f.connect();
    await assert.rejects(api.code(address(9)), safeRejection(expected));
    assert.deepEqual(f.state.calls.filter(c => c.ready).map(c => c.alias).sort(), [1, 2]);
    const before = f.state.calls.length;
    for (const invoke of [() => api.code(address(9)), () => api.call(TX), () => api.estimateGas(TX), () => api.recheck()])
      await assert.rejects(invoke(), safeRejection("PIN_EVIDENCE_INVALIDATED"));
    assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" }); assert.equal(f.state.calls.length, before);
    assert.deepEqual(api.evidence.aliases, [1, 2]); assert.ok(f.state.calls.filter(c => c.ready).every(c => c.alias !== 3));
  }
});

test("strict HTTP transient timeout retries the identical pinned request on the same provider without replacement", async t => {
  let failures = 1;
  const f = fixture(["strict", "strict", "strict"], { hook: ({ call, state }) => {
    if (state.ready && call.alias === 1 && call.method === "eth_call" && call.params[0].to === TX.to && failures-- > 0)
      throw new ExecutionError("RPC_TIMEOUT");
  } });
  mockHttp(t, f); const api = await f.connect({ rpc: httpRpc }), before = f.state.calls.length, pin = api.pin;
  assert.equal(await api.call(TX), "0x1234"); api.assertUsable();
  const calls = f.state.calls.slice(before);
  assert.deepEqual(calls.map(c => c.alias).sort(), [1, 1, 2]);
  for (const call of calls) assert.deepEqual(call.params, [TX, ref()]);
  assert.deepEqual(api.evidence.aliases, [1, 2]); assert.equal(api.pin, pin);
  assert.equal(await api.code(address(9)), CODE); await api.recheck(); api.assertUsable();
});

test("non-strict HTTP transient exhaustion also fails closed without selected-family replacement", async t => {
  const f = fixture(["strict", "strict", "strict"], { hook: ({ call, state }) => {
    if (state.ready && call.alias === 1 && call.method === "eth_call" && call.params[0].to === TX.to) throw new ExecutionError("RPC_HTTP_RETRYABLE");
  } });
  mockHttp(t, f); const api = await f.connect({ rpc: httpRpc, requireStrictEvidence: false }), before = f.state.calls.length;
  await assert.rejects(api.call(TX), safeRejection("PINNED_RPC_FAILED"));
  assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" });
  const calls = f.state.calls.slice(before);
  assert.deepEqual(calls.map(c => c.alias).sort(), [1, 1, 1, 2]);
  assert.deepEqual(api.evidence.aliases, [1, 2]);
});

test("both strict witnesses may recover after at most two transient retries and must still agree", async () => {
  const attempts = new Map();
  const f = fixture(undefined, { hook: ({ call, state }) => {
    if (state.ready && call.method === "eth_call") {
      const count = (attempts.get(call.alias) ?? 0) + 1; attempts.set(call.alias, count);
      if (count <= 2) throw new ExecutionError("RPC_TIMEOUT");
    }
  } }), api = await f.connect();
  assert.equal(await api.call(TX), "0x1234"); api.assertUsable();
  assert.deepEqual([...attempts.values()], [3, 3]);
  for (const call of f.state.calls.filter(c => c.ready)) assert.deepEqual(call.params, [TX, ref()]);
});

test("strict retry exhaustion poisons call, code and recheck without ever selecting an alternative", async () => {
  for (const method of ["eth_call", "eth_getCode", "eth_chainId"]) {
    let fail = true;
    const f = fixture(["strict", "strict", "strict"], { hook: ({ call, state }) => {
      if (state.ready && call.alias === 1 && call.method === method && fail) throw new ExecutionError("RPC_TIMEOUT");
    } }), api = await f.connect(), pin = api.pin;
    const invoke = method === "eth_call" ? () => api.call(TX) : method === "eth_getCode" ? () => api.code(address(9)) : () => api.recheck();
    await assert.rejects(invoke(), safeRejection("PINNED_RPC_FAILED"));
    assert.equal(f.state.calls.filter(c => c.ready && c.alias === 1 && c.method === method).length, 3);
    assert.ok(f.state.calls.filter(c => c.ready).every(c => c.alias !== 3));
    fail = false; const after = f.state.calls.length;
    await assert.rejects(invoke(), safeRejection("PIN_EVIDENCE_INVALIDATED"));
    assert.equal(f.state.calls.length, after); assert.equal(api.pin, pin); assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" });
  }
});

test("strict recheck recovers from one transport failure while preserving all header checks", async () => {
  let failures = 1;
  const f = fixture(undefined, { hook: ({ call, state }) => {
    if (state.ready && call.alias === 1 && call.method === "eth_getBlockByNumber" && call.params[0] === hex(HEAD) && failures-- > 0)
      throw Object.assign(new Error("UNTRUSTED_TRANSPORT"), { code: "ECONNRESET" });
  } }), api = await f.connect(), pin = api.pin;
  await api.recheck(); api.assertUsable(); assert.equal(api.pin, pin);
  assert.equal(f.state.calls.filter(c => c.ready && c.alias === 1 && c.method === "eth_getBlockByNumber" && c.params[0] === hex(HEAD)).length, 2);
});

test("terminal errors and unclassified RPC failures never retry even with a transient nested cause", async () => {
  for (const code of ["PROVIDER_RESULT_DISAGREEMENT", "PIN_CODE_RESULT_INVALID", "PIN_CHANGED", "PIN_TOO_FAR_BEHIND", "PIN_STALE_OR_FUTURE", "WRONG_CHAIN", "RPC_FAILED", "CALL_REVERTED"]) {
    const f = fixture(undefined, { hook: ({ call, state }) => {
      if (state.ready && call.method === "eth_call") throw Object.assign(new ExecutionError(code), { cause: { code: "ECONNRESET" } });
    } }), api = await f.connect();
    await assert.rejects(api.call(TX), safeRejection(code === "CALL_REVERTED" ? code : "PINNED_RPC_FAILED"));
    assert.deepEqual(f.state.calls.filter(c => c.ready).map(c => c.alias).sort(), [1, 2]);
    if (code === "CALL_REVERTED") api.assertUsable();
    else assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" });
  }
});

test("a retried witness that returns disagreement or malformed code still poisons immediately", async () => {
  for (const [result, code] of [["0x6002", "PROVIDER_RESULT_DISAGREEMENT"], ["0x1", "PIN_CODE_RESULT_INVALID"]]) {
    let failures = 1;
    const f = fixture(undefined, { hook: ({ call, state }) => {
      if (state.ready && call.alias === 2 && call.method === "eth_getCode") {
        if (failures-- > 0) throw new ExecutionError("RPC_TIMEOUT"); return result;
      }
    } }), api = await f.connect();
    await assert.rejects(api.code(address(9)), safeRejection(code));
    assert.deepEqual(f.state.calls.filter(c => c.ready).map(c => c.alias).sort(), [1, 2, 2]);
    assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" });
  }
});

test("collector forwards the requested timeout, defaults to 4s and caps physical requests at 4s", async t => {
  t.mock.method(Date, "now", () => NOW);
  const f = fixture(), api = await f.connect();
  for (const [timeout, expected] of [[undefined, 4000], [700, 700], [15000, 4000]]) {
    const before = f.state.calls.length;
    assert.equal(await api.collectorOptions.rpcCall("PINNED_ETHEREUM", "eth_call", [TX, api.pin.hash], timeout), "0x1234");
    const calls = f.state.calls.slice(before);
    assert.deepEqual(calls.map(c => c.timeoutMs), [expected, expected]);
    for (const call of calls) assert.deepEqual(call.params, [TX, ref()]);
  }
});

test("retry backoff consumes a caller's remaining timeout and an exhausted budget never restarts", async t => {
  let clock = NOW, failures = 1;
  t.mock.method(Date, "now", () => NOW);
  const setTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms) => { assert.equal(ms, 150); clock += ms; return setTimeout(fn, 0); });
  const f = fixture(undefined, { hook: ({ call, state }) => {
    if (state.ready && call.alias === 1 && call.method === "eth_call" && failures-- > 0) {
      clock += 100; throw new ExecutionError("RPC_TIMEOUT");
    }
  } }), api = await f.connect({ now: () => clock });
  assert.equal(await api.collectorOptions.rpcCall("PINNED_ETHEREUM", "eth_call", [TX, api.pin.hash], 600), "0x1234");
  assert.deepEqual(f.state.calls.filter(c => c.ready && c.alias === 1).map(c => c.timeoutMs), [600, 350]);
  failures = 1; const before = f.state.calls.length;
  await assert.rejects(api.collectorOptions.rpcCall("PINNED_ETHEREUM", "eth_call", [TX, api.pin.hash], 100), safeRejection("PINNED_RPC_FAILED"));
  assert.equal(f.state.calls.slice(before).filter(c => c.alias === 1).length, 1);
  assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" });
});

test("receipt polling with no remaining budget performs no RPC and fails closed", async () => {
  const f = fixture(), api = await f.connect(), before = f.state.calls.length;
  await assert.rejects(api.receipt(hash(42), 0), safeRejection("PINNED_RPC_FAILED"));
  assert.equal(f.state.calls.length, before); assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" });
});

test("next-block retries cannot extend the existing parent deadline", async t => {
  const f = fixture(undefined, { hook: ({ call, state }) => {
    if (state.ready && call.alias === 1 && call.method === "eth_chainId") {
      state.now += 100; throw new ExecutionError("RPC_TIMEOUT");
    }
  } });
  t.mock.method(Date, "now", () => f.state.now);
  const api = await f.connect({ requireNextBlock: true });
  f.state.now = (TIME + 12) * 1000 - 200;
  await assert.rejects(api.nextBlock.recheck(), safeRejection("NEXT_BLOCK_RPC_FAILED"));
  const failed = f.state.calls.filter(c => c.ready && c.alias === 1);
  assert.equal(failed.length, 1); assert.equal(failed[0].timeoutMs, 200);
  assert.ok(f.state.calls.filter(c => c.ready).every(c => c.timeoutMs <= 200));
});

test("HTTP retry classification admits 429/5xx and identified transport failures, never malformed responses or other errors", async t => {
  let f, failure, used;
  t.mock.method(globalThis, "fetch", async (handle, options) => {
    const { method, params } = JSON.parse(options.body), candidate = f.candidates.find(c => c.handle === handle);
    let result;
    try { result = await f.rpc(candidate, method, params, REQUEST_TIMEOUT_MS); }
    catch (error) {
      assert.equal(error.code, "UNKNOWN_BLOCK_REJECTED");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "header not found" } }));
    }
    if (f.state.ready && candidate === f.candidates[0] && method === "eth_call" && !used++) return failure();
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  });
  const failures = [
    ...[429, 500, 503, 599].map(status => [true, () => new Response("UNTRUSTED_HTTP_BODY", { status })]),
    [true, () => { throw Object.assign(new TypeError("UNTRUSTED_FETCH_DETAIL"), { cause: { code: "ECONNRESET" } }); }],
    ...[400, 401, 403, 408].map(status => [false, () => new Response("UNTRUSTED_HTTP_BODY", { status })]),
    [false, () => new Response("UNTRUSTED_MALFORMED_JSON")],
    [false, () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }))],
    [false, () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "UNTRUSTED_RPC_FAILURE" } }))],
    [false, () => { throw new Error("UNTRUSTED_UNKNOWN_FAILURE"); }]
  ];
  for (const [retryable, fail] of failures) {
    f = fixture(["strict", "strict", "strict"]); failure = fail; used = 0;
    const api = await f.connect({ rpc: httpRpc });
    if (retryable) { assert.equal(await api.call(TX), "0x1234"); api.assertUsable(); }
    else { await assert.rejects(api.call(TX), safeRejection("PINNED_RPC_FAILED")); assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" }); }
    assert.deepEqual(f.state.calls.filter(c => c.ready).map(c => c.alias).sort(), retryable ? [1, 1, 2] : [1, 2]);
    assert.deepEqual(api.evidence.aliases, [1, 2]);
  }
});

test("strict acquisition and rechecks preserve actual chain timestamps under the live-clock path", async t => {
  const f = fixture(undefined, { hook: ({ call, state }) => state.ready && call.method === "eth_getBlockByNumber"
    ? { ...header(), timestamp: hex(TIME + 2) } : undefined });
  t.mock.method(Date, "now", () => f.state.now); mockHttp(t, f);
  const api = await f.connect({ rpc: httpRpc, now: Date.now });
  assert.equal(api.pin.timestamp, TIME); assert.notEqual(api.pin.timestamp, Math.floor(f.state.now / 1000));
  await assert.rejects(api.recheck(), safeRejection("PIN_STALE_OR_FUTURE"));
  assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" }); assert.equal(api.pin.timestamp, TIME);
});

test("future canonical headers reject instead of clamping in strict mode, while default clamp remains unchanged", async t => {
  t.mock.method(Date, "now", () => NOW);
  const f = fixture(undefined, { hook: ({ call }) => call.method === "eth_getBlockByNumber" ? { ...header(), timestamp: hex(TIME + 2) } : undefined });
  mockHttp(t, f);
  await assert.rejects(f.connect({ rpc: httpRpc, now: Date.now }), safeRejection("TWO_STRICT_CAPABLE_FAMILIES_REQUIRED"));
  const api = await f.connect({ rpc: httpRpc, now: Date.now, requireStrictEvidence: false });
  assert.equal(api.pin.timestamp, NOW / 1000); assert.notEqual(api.pin.timestamp, TIME + 2); await api.recheck();
});

test("strict rechecks retain existing +4/+5 head bounds, lower-head rejection and 120s age limit", async () => {
  const f = fixture(), api = await f.connect(), pin = api.pin;
  f.state.head = HEAD + 4; f.state.now = (TIME + 48) * 1000; await api.recheck();
  f.state.head++; f.state.now += 12000;
  await assert.rejects(api.recheck(), safeRejection("PIN_TOO_FAR_BEHIND")); assert.equal(api.pin, pin);
  const low = fixture(), lower = await low.connect(); low.state.head--;
  await assert.rejects(lower.recheck(), safeRejection("PIN_TOO_FAR_BEHIND"));
  const aged = fixture(), old = await aged.connect(); aged.state.now = TIME * 1000 + MAX_AGE_MS;
  await old.recheck(); aged.state.now++;
  await assert.rejects(old.recheck(), safeRejection("PIN_STALE_OR_FUTURE"));
});

test("strict qualification finishes before refreshing the already selected pair to a newer immutable parent", async () => {
  const done = new Set();
  const f = fixture(["strict", "strict", "strict"], { hook: ({ call, state }) => {
    if (call.method === "eth_getCode" && call.params[1].blockHash === UNKNOWN) {
      done.add(call.alias); if (done.size === 3) { state.now = NOW + 24000; state.head = HEAD + 2; }
    }
  } }), api = await f.connect();
  assert.equal(api.pin.number, HEAD + 2); assert.equal(api.pin.timestamp, TIME + 24); assert.deepEqual(api.evidence.aliases, [1, 2]);
  assert.equal(api.evidence.qualification[0].strictProbePin.number, HEAD - 1);
  assert.equal(await api.code(address(9)), CODE);
  for (const call of f.state.calls.filter(c => c.ready && c.method === "eth_getCode")) assert.deepEqual(call.params[1], ref(hash(HEAD + 2)));
});

test("strict qualification/rechecks reject canonical header changes without alternate selection", async () => {
  const numbered = new Map();
  const changed = fixture(undefined, { hook: ({ call }) => {
    if (call.method === "eth_getBlockByNumber" && call.params[0] === hex(HEAD - 1)) {
      const count = (numbered.get(call.alias) ?? 0) + 1; numbered.set(call.alias, count);
      if (count === 2) return { ...header(HEAD - 1), stateRoot: hash(99) };
    }
  } });
  await assert.rejects(changed.connect(), safeRejection("TWO_STRICT_CAPABLE_FAMILIES_REQUIRED"));
  const f = fixture(["strict", "strict", "strict"], { hook: ({ call, state }) => state.ready && call.method === "eth_getBlockByNumber"
    ? { ...header(), stateRoot: hash(99) } : undefined }), api = await f.connect();
  await assert.rejects(api.recheck(), safeRejection("PIN_CHANGED"));
  assert.ok(f.state.calls.filter(c => c.ready).every(c => c.alias !== 3)); assert.deepEqual(api.evidence.aliases, [1, 2]);
});

test("strict evidence coexists with trace and next-block opt-ins on the same immutable pin", async () => {
  for (const requireTrace of [false, true]) for (const requireNextBlock of [false, true]) {
    const f = fixture(), api = await f.connect({ requireTrace, requireNextBlock });
    assert.equal(api.evidence.strictEvidence, true); assert.equal(api.evidence.traceQualified, requireTrace ? true : undefined);
    assert.equal(api.evidence.nextBlockQualified, requireNextBlock ? true : undefined);
    assert.equal(await api.code(address(9)), CODE); await api.recheck();
    if (requireTrace) assert.equal((await api.trace(TX)).tree.output, "0x1234");
    if (requireNextBlock) {
      const result = await api.nextBlock.simulate(TX);
      assert.equal(result.context.parentHash, api.pin.hash); assert.equal(result.context.parentTimestamp, TIME);
      assert.equal(result.context.timestamp, TIME + 12); assert.equal(result.gasLimit, hex(TX.gasLimit));
    }
  }
});

test("strict option types, unknown options and oversized pools reject before any RPC", async () => {
  const f = fixture();
  for (const requireStrictEvidence of [null, "true", "false", 1, 0, {}, []])
    await assert.rejects(f.connect({ requireStrictEvidence }), safeRejection("STRICT_EVIDENCE_OPTIONS_INVALID"));
  for (const options of [{ now: null }, { allowFallback: true }, { rawTimestamp: false }, { timeoutMs: 1 }])
    await assert.rejects(f.connect(options), safeRejection("STRICT_EVIDENCE_OPTIONS_INVALID"));
  await assert.rejects(f.connect({ candidates: Array(MAX_CANDIDATES + 1).fill(f.candidates[0]) }), safeRejection("RPC_CANDIDATES_INVALID"));
  assert.equal(f.state.calls.length, 0);
});

for (const requireStrictEvidence of [false, true]) test(`plain repin advances every hash-bound read without requalification (strict=${requireStrictEvidence})`, async () => {
  const f = fixture(["strict", "strict", "strict"]), api = await f.connect({ requireStrictEvidence });
  const original = api.pin, evidence = structuredClone(api.evidence), methods = { send: api.send, liveHeadNumber: api.liveHeadNumber };
  f.state.head++; f.state.now += 12000;
  const before = f.state.calls.length, result = await api.repin();
  assert.equal(api.pin, result.pin); assert.notEqual(api.pin, original); assert.ok(Object.isFrozen(api.pin));
  assert.equal(api.pin.number, HEAD + 1); assert.equal(api.pin.hash, hash(HEAD + 1)); assert.deepEqual(result.aliases, [1, 2]);
  assert.deepEqual(f.state.calls.slice(before).map(c => [c.alias, c.method, c.params]), [
    [1, "eth_getBlockByNumber", ["latest", false]], [2, "eth_getBlockByNumber", ["latest", false]],
    [1, "eth_getBlockByNumber", [hex(HEAD + 1), false]], [2, "eth_getBlockByNumber", [hex(HEAD + 1), false]],
  ]);
  assert.deepEqual(api.evidence.lastRepin, { sequence: 1, previousPin: { number: original.number, hash: original.hash },
    pin: { number: api.pin.number, hash: api.pin.hash }, timestamp: new Date(f.state.now).toISOString(), aliases: [1, 2] });
  const { lastRepin, ...acquisition } = api.evidence;
  assert.deepEqual(acquisition, evidence); assert.ok(Object.isFrozen(lastRepin));
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(api.evidence), /OFFLINE_OPAQUE|synthetic-family/);
  if (requireStrictEvidence) assert.equal(api.evidence.qualification[0].strictProbePin.number, HEAD - 1);
  const reads = f.state.calls.length;
  assert.equal(await api.call(TX), "0x1234"); assert.equal(await api.estimateGas(TX), hex(80000));
  if (requireStrictEvidence) assert.equal(await api.code(address(9)), CODE);
  const collector = api.collectorOptions;
  const latest = await collector.rpcCall("PINNED_ETHEREUM", "eth_getBlockByNumber", ["latest", false]);
  assert.equal(latest.number, hex(HEAD + 1)); assert.equal(latest.hash, api.pin.hash);
  assert.equal(await collector.rpcCall("PINNED_ETHEREUM", "eth_call", [TX, api.pin.hash]), "0x1234");
  await assert.rejects(collector.rpcCall("PINNED_ETHEREUM", "eth_call", [TX, original.hash]), { code: "COLLECTOR_UNPINNED_REQUEST" });
  await api.recheck(); assert.equal(await api.liveHeadNumber(), HEAD + 1); api.assertUsable();
  const subsequent = f.state.calls.slice(reads);
  assert.ok(subsequent.every(c => [1, 2].includes(c.alias)));
  for (const call of subsequent.filter(c => ["eth_call", "eth_estimateGas", "eth_getCode"].includes(c.method)))
    assert.deepEqual(call.params[1], ref(api.pin.hash));
  assert.deepEqual(subsequent.filter(c => c.method === "eth_getBlockByNumber" && c.params[0] !== "latest").map(c => c.params[0]), [hex(HEAD + 1), hex(HEAD + 1)]);
  assert.equal(api.send, methods.send); assert.equal(api.liveHeadNumber, methods.liveHeadNumber);
  assert.equal(original.hash, hash(HEAD)); assert.equal(original.number, HEAD);
});

test("repin accepts the same head and exactly +4 with bounded metadata and unchanged acquisition evidence", async () => {
  const f = fixture(), api = await f.connect(), original = structuredClone(api.evidence);
  await api.repin(); const firstRecord = api.evidence.lastRepin;
  assert.equal(firstRecord.sequence, 1); assert.equal(api.pin.number, HEAD);
  f.state.head += 4; f.state.now += 48000;
  await api.repin(); await api.recheck(); api.assertUsable();
  assert.equal(api.pin.number, HEAD + 4); assert.equal(api.evidence.lastRepin.sequence, 2);
  assert.deepEqual(api.evidence.lastRepin.previousPin, { number: HEAD, hash: hash(HEAD) });
  assert.equal(firstRecord.sequence, 1); assert.equal(firstRecord.pin.number, HEAD);
  const { lastRepin, ...acquisition } = api.evidence;
  assert.deepEqual(acquisition, original);
});

for (const heads of [[100, 99], [99, 101]])
  test(`repin tolerates latest skew ${heads.join("/")} and uses the agreed lower height 99`, async () => {
    const initial = 98, common = Math.min(...heads);
    const f = fixture(undefined, { hook: ({ call, state }) => {
      if (call.method !== "eth_getBlockByNumber") return;
      const number = call.params[0] === "latest" ? state.ready ? heads[call.alias - 1] : initial : Number(BigInt(call.params[0]));
      return { ...header(number), timestamp: hex(TIME + (number - initial) * 12) };
    } }), api = await f.connect(), original = api.pin, before = f.state.calls.length;
    assert.equal(original.number, initial); f.state.now += (Math.max(...heads) - initial) * 12000;
    const result = await api.repin();
    assert.equal(result.pin, api.pin); assert.equal(api.pin.number, common); assert.equal(api.pin.hash, hash(common));
    assert.deepEqual(f.state.calls.slice(before).map(c => [c.alias, c.method, c.params]), [
      [1, "eth_getBlockByNumber", ["latest", false]], [2, "eth_getBlockByNumber", ["latest", false]],
      [1, "eth_getBlockByNumber", [hex(common), false]], [2, "eth_getBlockByNumber", [hex(common), false]],
    ]);
    assert.deepEqual(api.evidence.lastRepin.previousPin, { number: initial, hash: hash(initial) });
    assert.deepEqual(api.evidence.lastRepin.pin, { number: common, hash: hash(common) });
    assert.equal(await api.call(TX), "0x1234");
    for (const call of f.state.calls.slice(-2)) assert.deepEqual(call.params[1], ref(hash(common)));
    await api.recheck(); api.assertUsable(); assert.equal(api.pin, result.pin);
  });

for (const field of ["hash", "stateRoot"])
  test(`repin poisons genuine ${field} disagreement at the common height despite normal latest skew`, async () => {
    const common = HEAD + 1;
    const f = fixture(undefined, { hook: ({ call, state }) => {
      if (!state.ready || call.method !== "eth_getBlockByNumber") return;
      if (call.params[0] === "latest") return { number: hex(common + (call.alias === 1 ? 1 : 0)) };
      if (call.params[0] === hex(common) && call.alias === 2) return { ...header(common), [field]: hash(9999) };
    } }), api = await f.connect(), original = api.pin;
    f.state.now += 24000;
    await assert.rejects(api.repin(), safeRejection("PROVIDER_RESULT_DISAGREEMENT"));
    assert.equal(api.pin, original); assert.equal(api.evidence.lastRepin, undefined);
    assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" });
  });

for (const advance of [-1, 5]) test(`repin enforces common-height advance ${advance} even with skewed latest heads`, async () => {
  const common = HEAD + advance;
  const f = fixture(undefined, { hook: ({ call, state }) => state.ready && call.method === "eth_getBlockByNumber" && call.params[0] === "latest"
    ? { number: hex(common + (call.alias === 1 ? 2 : 0)) } : undefined }), api = await f.connect(), original = api.pin;
  f.state.now += Math.max(0, advance + 2) * 12000;
  await assert.rejects(api.repin(), safeRejection("PIN_TOO_FAR_BEHIND"));
  assert.deepEqual(f.state.calls.slice(-2).map(c => c.params), [[hex(common), false], [hex(common), false]]);
  assert.equal(api.pin, original); assert.equal(api.evidence.lastRepin, undefined);
  assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" });
});

test("repin rejects witnesses agreeing on a header other than the requested common height", async () => {
  const f = fixture(undefined, { hook: ({ call, state }) => state.ready && call.method === "eth_getBlockByNumber"
    ? call.params[0] === "latest" ? { number: hex(HEAD + 1) } : header(HEAD) : undefined }), api = await f.connect(), original = api.pin;
  f.state.now += 12000;
  await assert.rejects(api.repin(), safeRejection("PROVIDER_RESULT_DISAGREEMENT"));
  assert.equal(api.pin, original); assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" });
});

for (const field of ["number", "hash", "parentHash", "stateRoot", "timestamp", "baseFeePerGas"])
  test(`repin ${field} disagreement poisons without changing pin or evidence`, async () => {
    const f = fixture(undefined, { hook: ({ call, state }) => {
      if (state.ready && call.alias === 2 && call.method === "eth_getBlockByNumber" && call.params[0] === hex(state.head))
        return { ...header(state.head), [field]: field === "number" ? hex(HEAD) : field === "timestamp" ? hex(TIME + 11)
          : field === "baseFeePerGas" ? hex(100000001) : hash(9999) };
    } }), api = await f.connect(), original = api.pin, evidence = structuredClone(api.evidence);
    f.state.head++; f.state.now += 12000;
    await assert.rejects(api.repin(), safeRejection("PROVIDER_RESULT_DISAGREEMENT"));
    assert.equal(api.pin, original); assert.deepEqual(api.evidence, evidence);
    const before = f.state.calls.length;
    assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" });
    for (const invoke of [api.repin, api.recheck, () => api.call(TX), () => api.code(address(9))])
      await assert.rejects(invoke(), safeRejection("PIN_EVIDENCE_INVALIDATED"));
    assert.equal(f.state.calls.length, before);
  });

for (const advance of [-1, 5]) test(`repin rejects and poisons out-of-bound advance ${advance}`, async () => {
  const f = fixture(), api = await f.connect(), original = api.pin;
  f.state.head += advance; f.state.now += Math.max(0, advance) * 12000;
  await assert.rejects(api.repin(), safeRejection("PIN_TOO_FAR_BEHIND"));
  assert.equal(api.pin, original); assert.equal(api.evidence.lastRepin, undefined);
  assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" });
});

test("repin cannot replace an agreed but changed header at the existing height", async () => {
  const f = fixture(undefined, { hook: ({ call, state }) => state.ready && call.method === "eth_getBlockByNumber"
    ? { ...header(), hash: hash(9999) } : undefined }), api = await f.connect(), original = api.pin;
  await assert.rejects(api.repin(), safeRejection("PIN_CHANGED"));
  assert.equal(api.pin, original); assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" });
});

test("repin on an already poisoned session rejects without reading either witness", async () => {
  const f = fixture(undefined, { hook: ({ call, state }) => state.ready && call.alias === 2 && call.method === "eth_getCode" ? "0x6002" : undefined });
  const api = await f.connect(), original = api.pin;
  await assert.rejects(api.code(address(9)), safeRejection("PROVIDER_RESULT_DISAGREEMENT"));
  const before = f.state.calls.length;
  await assert.rejects(api.repin(), safeRejection("PIN_EVIDENCE_INVALIDATED"));
  assert.equal(f.state.calls.length, before); assert.equal(api.pin, original);
});

for (const malformed of [false, true]) test(`repin poisons on ${malformed ? "malformed header" : "transport failure"}`, async () => {
  const f = fixture(undefined, { hook: ({ call, state }) => {
    if (state.ready && call.alias === 2 && call.method === "eth_getBlockByNumber") {
      if (malformed) return { ...header(), stateRoot: "invalid" };
      throw new Error("UNTRUSTED_PROVIDER_DETAIL");
    }
  } }), api = await f.connect(), original = api.pin;
  await assert.rejects(api.repin(), safeRejection(malformed ? "PIN_HEADER_INVALID" : "PINNED_RPC_FAILED"));
  assert.equal(api.pin, original); assert.equal(api.evidence.lastRepin, undefined);
  assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" });
});

test("overlapping repins poison both attempts without publishing either head", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(undefined, { hook: ({ call, state }) => state.ready && call.method === "eth_getBlockByNumber"
    ? gate.then(() => header(state.head)) : undefined }), api = await f.connect(), original = api.pin;
  f.state.head++; f.state.now += 12000;
  const first = assert.rejects(api.repin(), safeRejection("PIN_EVIDENCE_INVALIDATED"));
  try { await assert.rejects(api.repin(), safeRejection("REPIN_IN_PROGRESS")); }
  finally { release(); }
  await first;
  assert.equal(api.pin, original); assert.equal(api.evidence.lastRepin, undefined);
  assert.throws(api.assertUsable, { code: "PIN_EVIDENCE_INVALIDATED" });
});

for (const options of [{ requireNextBlock: true }, { requireTrace: true }, { requireNextBlock: true, requireTrace: true }])
  test(`repin refuses ${Object.keys(options).join("+")} without poisoning or changing its usable proofs`, async () => {
    const f = fixture(), api = await f.connect(options), original = api.pin, evidence = structuredClone(api.evidence), before = f.state.calls.length;
    // Detaching the method cannot bypass the construction-time shape guard.
    const repin = api.repin;
    await assert.rejects(repin(), safeRejection("REPIN_UNSUPPORTED_FOR_LEASE_SESSION"));
    assert.equal(f.state.calls.length, before); assert.equal(api.pin, original); assert.deepEqual(api.evidence, evidence);
    api.assertUsable(); await api.recheck(); assert.equal(await api.call(TX), "0x1234"); assert.equal(await api.code(address(9)), CODE);
    if (options.requireTrace) assert.equal((await api.trace(TX)).tree.output, "0x1234");
    if (options.requireNextBlock) {
      api.nextBlock.assertUsable(); await api.nextBlock.recheck();
      assert.equal((await api.nextBlock.simulate(TX)).returnData, "0x1234");
    }
    assert.equal(api.pin, original); assert.deepEqual(api.evidence, evidence); api.assertUsable();
  });

for (const qualificationMode of ["fresh", "capability-v1"])
  test(`repin refuses M1 ${qualificationMode} CURRENT and copied FUTURE methods without poisoning their trace/child proofs`, async t => {
    const f = fixture(); mockHttp(t, f);
    const factory = createM1HotPathFactory({ rpc: httpRpc, now: () => f.state.now, monotonic: () => 0, allowFuture: true, qualificationMode });
    t.after(() => factory.close()); factory.maintain({ candidates: f.candidates }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(factory.maintain({ candidates: f.candidates }).selection, "READY");
    const lease = await factory.acquire({ candidates: f.candidates }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(lease.isFutureReady(), true);
    const future = lease.takeFuture(), current = lease.current, facet = await lease.qualifyCurrentTrace();
    assert.ok(future); assert.ok(Object.isFrozen(current)); assert.ok(Object.isFrozen(future));
    const before = f.state.calls.length, evidence = JSON.stringify(current.evidence), futureEvidence = JSON.stringify(future.evidence), original = current.pin;
    await assert.rejects(current.repin(), safeRejection("REPIN_UNSUPPORTED_FOR_LEASE_SESSION"));
    await assert.rejects(future.repin(), safeRejection("REPIN_UNSUPPORTED_FOR_LEASE_SESSION"));
    assert.equal(f.state.calls.length, before); assert.equal(current.pin, original); assert.equal(future.pin, original);
    current.assertUsable(); future.assertUsable(); facet.assertUsable();
    await current.recheck(); assert.equal(await current.call(TX), "0x1234"); assert.equal(await current.code(address(9)), CODE);
    assert.equal((await facet.trace({ from: TX.from, to: TX.to, data: TX.data, value: TX.value })).tree.output, "0x1234"); await future.nextBlock.recheck();
    assert.equal((await future.nextBlock.simulate(TX)).returnData, "0x1234");
    assert.equal(JSON.stringify(current.evidence), evidence); assert.equal(JSON.stringify(future.evidence), futureEvidence);
    assert.equal(factory.maintain({ candidates: f.candidates }).selection, "READY");
  });

test("HTTP strict unknown-hash classification is limited to exact sentinel probes and hash-bound lookup errors", async t => {
  let error;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error })));
  for (const method of ["eth_call", "eth_getCode"]) {
    const target = method === "eth_call" ? probeCall() : MULTICALL3, params = [target, ref(UNKNOWN)];
    for (const message of ["unknown block", "header not found", "header for hash not found", "canonical block not found, hash: " + UNKNOWN,
      "UNKNOWN BLOCK HASH: " + UNKNOWN.toUpperCase() + "."]) {
      error = { code: -32000, message, data: "UNTRUSTED_ERROR_DATA" };
      await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, method, params), safeRejection("UNKNOWN_BLOCK_REJECTED"));
      await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, method, [target, ref()]), safeRejection("RPC_FAILED"));
      const otherTarget = method === "eth_call" ? { ...probeCall(), to: address(9) } : address(9);
      await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, method, [otherTarget, ref(UNKNOWN)]), safeRejection("RPC_FAILED"));
    }
    for (const [code, message] of [[-32602, "unknown block"], [-32601, "header not found"], [-32099, "unknown block"],
      [-32000, "invalid params: unknown block"], [-32000, "unknown block hash: " + hash(999)],
      [-32000, "canonical block not found, hash: " + UNKNOWN + " extra"], [-32000, "header for hash not found\n"], [-32000, "header not found\n"],
      [-32000, "header not found https://example.invalid/"], [-32000, "UNTRUSTED_ARBITRARY_MESSAGE"]]) {
      error = { code, message };
      await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, method, params), safeRejection("RPC_FAILED"));
    }
  }
  error = { code: -32000, message: "unknown block" };
  await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, "eth_call", [{ ...probeCall(), gas: "0x10000" }, ref(UNKNOWN)]), safeRejection("RPC_FAILED"));
  await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, "eth_call", [probeCall(), { blockHash: UNKNOWN, requireCanonical: false }]), safeRejection("RPC_FAILED"));
});

for (const method of ["eth_call", "eth_getCode", "eth_simulateV1"]) for (const [code, prefix] of MISSING_BLOCK_FORMS)
  test(`HTTP ${method} accepts only exact ${code}/${prefix} with the requested sentinel hash`, async t => {
    let error = { code, message: prefix + UNKNOWN };
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error })));
    const invoke = (params = lookupParams(method)) => httpRpc({ handle: "OFFLINE_OPAQUE" }, method, params);
    for (const embedded of [UNKNOWN, "0x" + "F".repeat(64)]) {
      error = { code, message: prefix + embedded };
      await assert.rejects(invoke(), safeRejection("UNKNOWN_BLOCK_REJECTED"));
    }
    for (const message of [prefix + hash(42), "prefix " + prefix + UNKNOWN, prefix + UNKNOWN + " suffix", prefix + UNKNOWN + ".",
      " " + prefix + UNKNOWN, prefix + UNKNOWN + "\n", prefix.toUpperCase() + UNKNOWN, prefix + UNKNOWN.slice(0, -1),
      prefix + UNKNOWN + "f", prefix + UNKNOWN + " " + hash(42), prefix + "0x" + "g".repeat(64), prefix + UNKNOWN + "x".repeat(512),
      "invalid params: " + prefix + UNKNOWN, "unauthorized: " + prefix + UNKNOWN, "state pruned: " + prefix + UNKNOWN,
      "method not found: " + prefix + UNKNOWN, "request timed out: " + prefix + UNKNOWN]) {
      error = { code, message }; await assert.rejects(invoke(), safeRejection("RPC_FAILED"));
    }
    for (const wrongCode of [code === -32001 ? -32000 : -32001, -32002, -32603, -32602, -32601, -32099]) {
      error = { code: wrongCode, message: prefix + UNKNOWN };
      await assert.rejects(invoke(), safeRejection(method === "eth_simulateV1" && code === -32001 && wrongCode === -32000 ? "UNKNOWN_BLOCK_REJECTED" :
        method === "eth_simulateV1" && wrongCode === -32601 ? "NEXT_BLOCK_METHOD_UNAVAILABLE" : "RPC_FAILED"));
    }
    for (error of [null, [], "unknown block", { code: String(code), message: prefix + UNKNOWN }, { code: code - 0.5, message: prefix + UNKNOWN },
      { code, message: null }, { code, message: {} }, { code, message: [prefix + UNKNOWN] }, { code }])
      await assert.rejects(invoke(), safeRejection("RPC_FAILED"));
    for (const requested of [hash(HEAD), hash(42)]) {
      error = { code, message: prefix + requested };
      await assert.rejects(invoke(lookupParams(method, requested)), safeRejection("RPC_FAILED"));
    }
    error = { code, message: prefix + UNKNOWN };
    if (method !== "eth_simulateV1") {
      const params = lookupParams(method); params[0] = method === "eth_call" ? { ...probeCall(), to: address(9) } : address(9);
      await assert.rejects(invoke(params), safeRejection("RPC_FAILED"));
      if (method === "eth_call") {
        await assert.rejects(invoke([{ ...probeCall(), gas: "0x10000" }, ref(UNKNOWN)]), safeRejection("RPC_FAILED"));
        await assert.rejects(invoke([probeCall(), { blockHash: UNKNOWN, requireCanonical: false }]), safeRejection("RPC_FAILED"));
      }
    }
    await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, "eth_estimateGas", [probeCall(), ref(UNKNOWN)]), safeRejection("RPC_FAILED"));
  });

for (const [code, prefix] of MISSING_BLOCK_FORMS) test(`HTTP strict/simulation/legacy trace qualification retains all controls with ${code}/${prefix}`, async t => {
  const f = fixture(); mockHttp(t, f, { code, message: prefix + UNKNOWN });
  const api = await f.connect({ rpc: httpRpc, requireTrace: true, requireNextBlock: true });
  assert.equal(api.evidence.strictEvidence, true); assert.equal(api.evidence.traceQualified, true); assert.equal(api.evidence.nextBlockQualified, true);
  for (const alias of [1, 2]) for (const method of ["eth_call", "eth_getCode", "eth_simulateV1", "debug_traceCall"])
    assert.ok(f.state.calls.some(row => row.alias === alias && row.method === method && row.params[1]?.blockHash === UNKNOWN));
  assert.equal(await api.code(address(9)), CODE); await api.recheck(); assert.equal(f.state.active, 0);
});

for (const [code, prefix] of MISSING_BLOCK_FORMS) test(`HTTP CURRENT trace accepts ${code}/${prefix} only after known-hash proofs and canonical rereads`, async t => {
  const f = fixture(); mockHttp(t, f, { code, message: prefix + UNKNOWN });
  const factory = createM1HotPathFactory({ rpc: httpRpc, now: () => f.state.now, monotonic: () => 0 });
  t.after(() => factory.close()); factory.maintain({ candidates: f.candidates }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(factory.maintain({ candidates: f.candidates }).selection, "READY");
  const lease = await factory.acquire({ candidates: f.candidates }), before = f.state.calls.length;
  const facet = await lease.qualifyCurrentTrace(); assert.equal(facet.pin, lease.current.pin);
  assert.equal(facet.evidence.hashPinnedBlockNumberVerified, true); assert.equal(facet.evidence.unknownHashRejected, true);
  for (const alias of [1, 2]) {
    const rows = f.state.calls.slice(before).filter(row => row.alias === alias);
    assert.deepEqual(rows.filter(row => row.method === "debug_traceCall").map(row => row.params[1].blockHash), [hash(HEAD), hash(HEAD - 1), UNKNOWN]);
    for (const number of [HEAD, HEAD - 1]) assert.equal(rows.filter(row => row.method === "eth_getBlockByNumber" && row.params[0] === hex(number)).length, 2);
  }
  facet.assertUsable(); lease.current.assertUsable(); assert.equal(f.state.active, 0);
});

test("HTTP unknown controls do not turn authentication failures or timeouts into lookup evidence", async t => {
  let status = 401;
  t.mock.method(globalThis, "fetch", async () => status === null ? new Promise(() => {}) :
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "block not found: hash " + UNKNOWN } }), { status }));
  for (const method of ["eth_call", "eth_getCode", "eth_simulateV1"]) for (status of [401, 403, null])
    await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, method, lookupParams(method), 10), safeRejection(status === null ? "RPC_TIMEOUT" : "RPC_FAILED"));
});

test("HTTP code responses normalize hex, reject malformed data and disallow number/latest/state-override fallbacks", async t => {
  let result = "0X60AB", requests = 0;
  t.mock.method(globalThis, "fetch", async (_handle, options) => {
    requests++; assert.deepEqual(JSON.parse(options.body).params, [MULTICALL3, ref()]);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  });
  assert.equal(await httpRpc({ handle: "OFFLINE_OPAQUE" }, "eth_getCode", [MULTICALL3, ref()]), "0x60ab");
  for (result of [null, {}, "0x1", "0xAB\n", "UNTRUSTED_CODE"]) await assert.rejects(
    httpRpc({ handle: "OFFLINE_OPAQUE" }, "eth_getCode", [MULTICALL3, ref()]), safeRejection("RPC_FAILED"));
  const before = requests;
  for (const params of [[MULTICALL3, "latest"], [MULTICALL3, hex(HEAD)], [MULTICALL3, { blockHash: hash(HEAD), requireCanonical: false }],
    [MULTICALL3, { ...ref(), stateOverrides: {} }], [MULTICALL3, ref(), {}], ["0x1", ref()]])
    await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, "eth_getCode", params), safeRejection("PIN_CODE_REQUEST_INVALID"));
  assert.equal(requests, before);
});

test("HTTP code transport retains bounded body size and sanitized failures", async t => {
  let reads = 0, cancelled = 0;
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, body: { getReader: () => ({
    read: async () => { reads++; return { done: false, value: Buffer.alloc(MAX_RESPONSE_BYTES / 2) }; },
    cancel: async () => { cancelled++; }, releaseLock: () => {} }) } }));
  await assert.rejects(httpRpc({ handle: "OFFLINE_OPAQUE" }, "eth_getCode", [MULTICALL3, ref()]), safeRejection("RPC_RESPONSE_TOO_LARGE"));
  assert.equal(reads, 3); assert.equal(cancelled, 1);
});

test("module reload performs no inventory, key or network IO", t => {
  const fs = require("node:fs"), filename = require.resolve("../lib/executor-pinned-rpc.js"), cached = require.cache[filename];
  const read = fs.readFileSync, reads = [];
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    // The staging preload changes source location, not the module identity.
    assert.ok(String(file).replaceAll("\\", "/").endsWith("/tools/lib/executor-pinned-rpc.js")); reads.push(file); return read(file, ...args);
  });
  t.mock.method(fs, "readdirSync", () => assert.fail("IMPORT_DIRECTORY_IO_FORBIDDEN"));
  t.mock.method(globalThis, "fetch", () => assert.fail("IMPORT_NETWORK_IO_FORBIDDEN"));
  delete require.cache[filename]; t.after(() => { require.cache[filename] = cached; });
  const imported = require(filename); assert.equal(typeof imported.createPinnedRpc, "function");
  assert.ok(reads.length <= 1); // Node may reuse its source cache; no other file may be read.
});

test("parallel strict controls remain private; legacy and qualified-pair sessions retain serial per-witness order", async () => {
  const { createQualifiedPairFactory } = require("../lib/executor-pinned-rpc.js");
  for (const reuse of [false, true]) {
    const f = fixture(), active = [0, 0], peaks = [0, 0];
    const rpc = async (candidate, ...args) => {
      const index = f.candidates.findIndex(c => c.handle === candidate.handle);
      peaks[index] = Math.max(peaks[index], ++active[index]);
      try { await new Promise(resolve => setImmediate(resolve)); return await f.rpc(f.candidates[index], ...args); }
      finally { active[index]--; }
    };
    const factory = reuse ? createQualifiedPairFactory({ rpc, now: () => NOW }) : null;
    try {
      if (factory) await factory.acquire({ candidates: f.candidates }); else await f.connect({ rpc });
      assert.deepEqual(peaks, [1, 1]); assert.deepEqual(active, [0, 0]);
      for (const alias of [1, 2]) assert.deepEqual(f.state.calls.filter(c => c.alias === alias).map(c => [c.method, c.params[1]?.blockHash || c.params[0]]), [
        ["eth_chainId", undefined], ["eth_getBlockByNumber", "latest"], ["eth_call", hash(HEAD)],
        ["eth_getBlockByNumber", hex(HEAD - 1)], ["eth_call", hash(HEAD - 1)],
        ["eth_getCode", hash(HEAD - 1)], ["eth_getCode", hash(HEAD)], ["eth_call", UNKNOWN], ["eth_getCode", UNKNOWN],
        ["eth_getBlockByNumber", hex(HEAD - 1)], ["eth_getBlockByNumber", hex(HEAD)],
        ["eth_chainId", undefined], ["eth_getBlockByNumber", "latest"], ["eth_getBlockByNumber", hex(HEAD)], ["eth_call", hash(HEAD)],
      ]);
    } finally { factory?.close(); }
  }
  const f = fixture();
  for (const parallelStrictControls of [true, false, 1])
    await assert.rejects(f.connect({ parallelStrictControls }), safeRejection("STRICT_EVIDENCE_OPTIONS_INVALID"));
  assert.throws(() => createQualifiedPairFactory({ rpc: f.rpc, parallelStrictControls: true }), /QUALIFIED_PAIR_OPTIONS_INVALID/);
  assert.equal(f.state.calls.length, 0);
});
