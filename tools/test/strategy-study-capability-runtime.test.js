"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const capture = require("../strategy-study/capture");
const control = require("../strategy-study/capability-control"), tracer = require("../strategy-study/emission-tracer");
const { MIN_JS_SOURCE, MIN_JS_CONFIG, ERROR_CLASSES, classifyRpcError } = control;
const PIN = capture.EMISSION_FIXTURE, START = Date.parse("2026-10-20T01:00:00Z");
const SENTINEL = "PRIVATE_CAPABILITY_SENTINEL", H = n => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const Q = n => `0x${BigInt(n).toString(16)}`;
const trace = config => [PIN.txHash, config];
const disabledMessage = "Custom JavaScript tracers are disabled";
const envelope = (req, error) => ({ jsonrpc: "2.0", id: req.id, error });
const rpcError = (req, message = disabledMessage, code = -32602, data) => new Response(JSON.stringify(envelope(req, { code, message, ...(data === undefined ? {} : { data }) })));

// Fake credential-free handles, injected fetch only. No helper loads inventory.
function fixture(respond = req => new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: 1 })), overrides = {}) {
  let clock = START;
  const calls = [], events = [], candidates = ["https://eth-mainnet.g.alchemy.com/offline-capability", "https://eth-mainnet.infura.io/offline-capability", "https://ethereum.publicnode.com/offline-capability"];
  const f = { calls, events, now: () => clock, setNow: value => { clock = value; } };
  f.options = {
    purpose: "emission-capability", chainId: 1, backoff: true, candidates,
    shared: { getOrigin: () => null, loadRpcUrls() { assert.fail("inventory forbidden"); } },
    now: f.now, sleep: async ms => { clock += ms; }, backoffRandom: () => 0,
    onTransportDiagnostic: e => { events.push(e); },
    fetch: async (url, init) => {
      const req = JSON.parse(init.body);
      calls.push({ ...req, index: f.options.candidates.indexOf(url), at: clock });
      assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
      return respond(req, init, f);
    }, ...overrides,
  };
  return f;
}
async function withRuntime(f, task) {
  const runtime = capture.createRuntime(f.options);
  try { return await task(runtime); }
  finally { await runtime.close(); assert.deepEqual(runtime.lifecycle(), { closed: true, pending: 0 }); }
}
async function rejects(request, code) {
  await assert.rejects(request, error => {
    assert.equal(error.message, code);
    assert.equal(capture.safeCode(error), code);
    assert.equal(error.cause, undefined);
    assert.ok(!String(error).includes(SENTINEL));
    return true;
  });
}

test("immutable M10 contract and original emission source remain exact, with no new safe failure codes", () => {
  assert.equal(MIN_JS_SOURCE, "{fault:function(){},result:function(){return 1;}}");
  assert.deepEqual(MIN_JS_CONFIG, { tracer: MIN_JS_SOURCE, timeout: "10s" });
  assert.deepEqual(ERROR_CLASSES, ["not-applicable", "custom-disabled-reported", "js-parse-reported", "configuration-rejected-reported", "unknown"]);
  assert.ok(Object.isFrozen(control) && Object.isFrozen(MIN_JS_CONFIG) && Object.isFrozen(ERROR_CLASSES));
  assert.throws(() => { MIN_JS_CONFIG.timeout = "5s"; }, TypeError);
  assert.throws(() => { control.MIN_JS_SOURCE = "{}"; }, TypeError);
  assert.equal(capture.sha256(tracer.EMISSION_TRACER_SOURCE), "276fee9367c64c68302488dcd36905b1de625084db9e1ee8efc3dd29ce510ed4");
  assert.deepEqual(tracer.EMISSION_TRACE_CONFIG, { tracer: tracer.EMISSION_TRACER_SOURCE, timeout: "10s" });
  for (const c of ERROR_CLASSES) assert.equal(capture.safeCode(new Error(c)), "capture-failed");
});

test("new purpose allows only exact N/M10/original E and inherits every fixed diagnostic cap", async () => {
  const f = fixture();
  await withRuntime(f, async runtime => {
    assert.deepEqual(runtime.limits, capture.EMISSION_DIAGNOSTIC_LIMITS);
    assert.deepEqual(Object.fromEntries(["candidatePool", "requests", "traceRequestCap", "logRequests", "totalTimeoutMs", "totalResponseBytes", "responseBytes", "requestTimeoutMs", "concurrency", "traceConcurrency", "spacingMs"].map(k => [k, runtime.limits[k]])),
      { candidatePool: 16, requests: 300, traceRequestCap: 64, logRequests: 0, totalTimeoutMs: 600000, totalResponseBytes: 67108864, responseBytes: 8388608, requestTimeoutMs: 20000, concurrency: 2, traceConcurrency: 1, spacingMs: 1000 });
    assert.equal(runtime.timing().expiresAt, "2026-10-21T00:00:00Z");
    for (const c of [capture.CALL_CONFIG, MIN_JS_CONFIG, tracer.EMISSION_TRACE_CONFIG]) assert.equal(await runtime.request(0, "debug_traceTransaction", trace(c)), 1);
    assert.deepEqual(f.calls.map(c => c.params), [capture.CALL_CONFIG, MIN_JS_CONFIG, tracer.EMISSION_TRACE_CONFIG].map(trace));
    assert.equal(runtime.snapshot().traceRequests, 3);
    assert.ok(f.events.every(e => Object.isFrozen(e) && e.rpcErrorClass === "not-applicable" && e.outcome === "passed"));
    assert.deepEqual(f.calls.map(c => c.at), [START, START + 1000, START + 2000]);
  });
});

test("old purposes keep their exact tracer allowlists and diagnostics without rpcErrorClass", async () => {
  for (const purpose of [undefined, "qualification", "census", "enrichment", "emission-diagnostic"]) {
    const f = fixture(req => rpcError(req), { purpose });
    await withRuntime(f, async runtime => {
      for (const config of [MIN_JS_CONFIG, ...(purpose === "emission-diagnostic" ? [capture.PRESTATE_CONFIG] : [tracer.EMISSION_TRACE_CONFIG])]) {
        await rejects(runtime.request(0, "debug_traceTransaction", trace(config)), purpose === "census" ? "rpc-method-not-read-only-allowlisted" : "invalid-options");
      }
      assert.equal(f.calls.length, 0);
      if (purpose === "census") await rejects(runtime.request(0, "eth_chainId", []), "provider-rpc-failure");
      else for (const config of [capture.CALL_CONFIG, purpose === "emission-diagnostic" ? tracer.EMISSION_TRACE_CONFIG : capture.PRESTATE_CONFIG]) {
        await rejects(runtime.request(0, "debug_traceTransaction", trace(config)), "provider-rpc-failure");
      }
      assert.ok(f.events.every(e => !Object.hasOwn(e, "rpcErrorClass")));
    });
  }
});

test("chain, explicit candidates/getOrigin/backoff and all cap increases fail before fetch or inventory", () => {
  const f = fixture();
  for (const extra of [{ chainId: 8453 }, { chainId: "1" }, { backoff: false }, { backoff: undefined }, { candidates: undefined }, { candidates: null }, { shared: undefined }, { shared: {} },
    { candidates: Array(17).fill(f.options.candidates[0]) }, { candidates: ["a", "b", "c"].map(s => `https://eth-mainnet.g.alchemy.com/offline-${s}`) },
    ...Object.entries({ candidatePool: 17, requests: 301, traceRequestCap: 65, logRequests: 1, totalTimeoutMs: 600001, totalResponseBytes: 67108865,
      responseBytes: 8388609, requestTimeoutMs: 20001, concurrency: 3, traceConcurrency: 2, spacingMs: 999 }).map(([k, v]) => ({ limits: { [k]: v } }))]) {
    assert.throws(() => capture.createRuntime({ ...f.options, ...extra }), /^Error: invalid-options$/);
  }
  assert.equal(f.calls.length, 0);
});

test("different source, timeout, native config, extra keys and fixture params are rejected before send", async () => {
  const f = fixture();
  await withRuntime(f, async runtime => {
    for (const c of [capture.PRESTATE_CONFIG, {}, { tracer: MIN_JS_SOURCE }, { ...MIN_JS_CONFIG, timeout: "5s" }, { ...MIN_JS_CONFIG, timeout: "11s" },
      { ...MIN_JS_CONFIG, timeout: 10 }, { ...MIN_JS_CONFIG, tracer: `${MIN_JS_SOURCE} ` }, { ...MIN_JS_CONFIG, tracer: "{result:function(){return 2;}}" },
      { ...MIN_JS_CONFIG, tracerConfig: {} }, { ...MIN_JS_CONFIG, source: SENTINEL }, { ...tracer.EMISSION_TRACE_CONFIG, timeout: "5s" },
      { ...capture.CALL_CONFIG, tracerConfig: { onlyTopCall: false, withLog: false } }]) await rejects(runtime.request(0, "debug_traceTransaction", trace(c)), "invalid-options");
    for (const [method, params] of [["eth_chainId", ["0x1"]], ["eth_chainId", {}], ["debug_traceTransaction", [H(1), MIN_JS_CONFIG]],
      ["debug_traceTransaction", [...trace(MIN_JS_CONFIG), {}]], ["eth_getTransactionByHash", [H(1)]], ["eth_getTransactionReceipt", [H(1)]],
      ["eth_getTransactionByHash", []], ["eth_getTransactionReceipt", [PIN.txHash, false]], ["eth_getBlockByNumber", ["latest", false]],
      ["eth_getBlockByNumber", ["0x1", false]], ["eth_getBlockByNumber", [Q(PIN.blockNumber), true]],
      ["eth_getBlockByHash", [H(1), false]], ["eth_getBlockByHash", [PIN.blockHash, true]], ["eth_getBlockByHash", [PIN.blockHash]]]) {
      await rejects(runtime.request(0, method, params), "invalid-options");
    }
    for (const method of ["eth_getLogs", "eth_call", "eth_getCode", "eth_sendRawTransaction", "trace_transaction"]) await rejects(runtime.request(0, method, []), "rpc-method-not-read-only-allowlisted");
    assert.equal(f.calls.length, 0); assert.equal(runtime.snapshot().requests, 0);
  });
});

test("safe copy rejects getters, hidden/inherited serializers and symbol fields on ALL requests without invoking them", async () => {
  let invoked = 0;
  const trap = () => { invoked++; throw new Error(SENTINEL); };
  const getter = { timeout: "10s" }; Object.defineProperty(getter, "tracer", { enumerable: true, get: trap });
  const serializer = { ...MIN_JS_CONFIG }; Object.defineProperty(serializer, "toJSON", { value: trap });
  const inherited = Object.assign(Object.create({ toJSON: trap }), MIN_JS_CONFIG);
  const hidden = { ...MIN_JS_CONFIG }; Object.defineProperty(hidden, "extra", { value: "x" });
  const symbol = { ...MIN_JS_CONFIG, [Symbol("hidden")]: "x" };
  const nested = { ...capture.CALL_CONFIG, tracerConfig: { onlyTopCall: false, get withLog() { return trap(); } } };
  const configGetter = [PIN.txHash, MIN_JS_CONFIG]; Object.defineProperty(configGetter, "1", { enumerable: true, get: trap });
  const txGetter = [PIN.txHash]; Object.defineProperty(txGetter, "0", { enumerable: true, get: trap });
  const chainSerializer = []; Object.defineProperty(chainSerializer, "toJSON", { value: trap });
  const f = fixture();
  await withRuntime(f, async runtime => {
    for (const c of [getter, serializer, inherited, hidden, symbol, nested]) await rejects(runtime.request(0, "debug_traceTransaction", trace(c)), "invalid-options");
    for (const [method, params] of [["debug_traceTransaction", configGetter], ["eth_getTransactionByHash", txGetter], ["eth_chainId", chainSerializer]]) {
      await rejects(runtime.request(0, method, params), "invalid-options");
    }
    assert.equal(invoked, 0); assert.equal(f.calls.length, 0);
  });
});

test("fixed material/header methods and candidate-local observed finalized hashes retain their scope", async () => {
  const f = fixture(req => new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.method === "eth_getBlockByNumber" && req.params[0] === "finalized" ? { hash: H(10) } : 1 })));
  await withRuntime(f, async runtime => {
    await runtime.request(0, "eth_chainId", []);
    for (const method of ["eth_getTransactionByHash", "eth_getTransactionReceipt"]) await runtime.request(0, method, [PIN.txHash]);
    for (const number of ["finalized", Q(PIN.blockNumber), Q(PIN.anchorNumber)]) await runtime.request(0, "eth_getBlockByNumber", [number, false]);
    for (const hash of [PIN.blockHash, PIN.anchorHash, H(10)]) await runtime.request(0, "eth_getBlockByHash", [hash, false]);
    await rejects(runtime.request(1, "eth_getBlockByHash", [H(10), false]), "invalid-options");
    assert.equal(f.calls.length, 9); assert.ok(f.events.every(e => e.rpcErrorClass === "not-applicable"));
  });
});

const classifiedMessages = [
  ["custom-disabled-reported", [disabledMessage, "JavaScript tracers are not supported", "Custom JS tracing is disabled"]],
  ["js-parse-reported", ["failed to parse tracer source", "SyntaxError in custom JavaScript tracer", "tracer source: syntax error", "error parsing tracer"]],
  ["configuration-rejected-reported", ["invalid timeout value", "invalid type for timeout field", "timeout must be a string", "timeout: time: invalid duration", "json: cannot unmarshal number into Go struct field TraceConfig.timeout of type string"]],
  ["unknown", ["Invalid params", "unsupported", "method not found", "custom tracer unsupported", "tracer rejected", "invalid tracer source", "SyntaxError: unexpected token", "JSON parse error", "runtime exception in tracer", "ReferenceError in tracer", "invalid timeout", "execution timed out", "quota exceeded", "authentication failed", "rate limit", "", SENTINEL,
    `${disabledMessage}; failed to parse tracer`, `${disabledMessage}; invalid timeout value`, "tracer: parse error; invalid timeout value", `${disabledMessage}; unauthorized`, "JSON parse error in tracer",
    "failed to parse tracer: unexpected token in JSON", "no syntax error in tracer", "execution reverted: tracer source: parse error", "tracer threw: failed to parse tracer"]],
];
for (const [expected, messages] of classifiedMessages) test(`strict HTTP200 M10/E errors classify ${expected} without changing codes or retrying`, async () => {
  for (const config of [MIN_JS_CONFIG, tracer.EMISSION_TRACE_CONFIG]) for (const message of messages) {
    const f = fixture(req => rpcError(req, message));
    await withRuntime(f, async runtime => {
      await rejects(runtime.request(0, "debug_traceTransaction", trace(config)), "provider-rpc-failure");
      assert.equal(f.events.length, 1); assert.equal(f.events[0].rpcErrorClass, expected); assert.equal(f.events[0].rpcErrorCode, -32602);
      assert.equal(f.events[0].httpStatus, 200); assert.equal(f.events[0].code, "provider-rpc-failure"); assert.equal(f.events[0].attempt, 1);
      assert.equal(classifyRpcError({ code: -32602, message }), expected);
      assert.equal(f.calls.length, 1); assert.equal(runtime.backoffSnapshot().retries, 0);
    });
  }
});

test("unrecognized integer RPC codes remain null in the old field; method-not-found retains its original safe code", async () => {
  for (const code of [-32601, -32602, -32000, 42, -32042]) for (const message of [disabledMessage, SENTINEL]) {
    const f = fixture(req => rpcError(req, message, code));
    await withRuntime(f, async runtime => {
      await rejects(runtime.request(0, "debug_traceTransaction", trace(MIN_JS_CONFIG)), code === -32601 ? "provider-method-not-found" : "provider-rpc-failure");
      assert.equal(f.events[0].rpcErrorCode, [-32601, -32602, -32000].includes(code) ? code : null);
      assert.equal(f.events[0].rpcErrorClass, message === SENTINEL ? "unknown" : "custom-disabled-reported");
    });
  }
});

test("native and material errors plus non200 custom errors never get a validated custom class", async () => {
  for (const [method, params] of [["debug_traceTransaction", trace(capture.CALL_CONFIG)], ["eth_chainId", []], ["eth_getTransactionReceipt", [PIN.txHash]]]) {
    const f = fixture(req => rpcError(req));
    await withRuntime(f, async runtime => { await rejects(runtime.request(0, method, params), "provider-rpc-failure"); assert.equal(f.events[0].rpcErrorClass, "not-applicable"); });
  }
  for (const status of [201, 400, 401, 403, 500]) {
    const f = fixture(req => new Response(JSON.stringify(envelope(req, { code: -32602, message: disabledMessage })), { status }));
    await withRuntime(f, async runtime => {
      await rejects(runtime.request(0, "debug_traceTransaction", trace(MIN_JS_CONFIG)), status === 201 ? "provider-rpc-failure" : "provider-http-failure");
      assert.equal(f.events[0].rpcErrorClass, "not-applicable"); assert.equal(f.calls.length, 1); assert.equal(runtime.backoffSnapshot().retries, 0);
    });
  }
});

test("malformed JSON/envelopes, error-plus-result, missing id, oversized messages and wrong field types never classify", async () => {
  const mutations = [b => null, b => [], b => false, b => ({ ...b, result: 1 }), b => { delete b.id; return b; }, b => ({ ...b, id: String(b.id) }),
    b => ({ ...b, id: b.id + 1 }), b => ({ ...b, jsonrpc: "1.0" }), b => { delete b.jsonrpc; return b; }, b => ({ ...b, extra: SENTINEL }),
    ...[null, false, 0, "error", [], {}, { code: "-32602", message: disabledMessage }, { code: -32602.5, message: disabledMessage },
      { code: -32602, message: null }, { code: -32602, message: 1 }, { code: -32602, message: [] }, { code: -32602 }, { message: disabledMessage },
      { code: -32602, message: `${disabledMessage}${"x".repeat(4096)}` }, { code: -32602, message: disabledMessage, extra: SENTINEL }].map(error => b => ({ ...b, error })),
    b => { delete b.error; return b; },
  ];
  for (const mutate of mutations) {
    const f = fixture(req => new Response(JSON.stringify(mutate(envelope(req, { code: -32602, message: disabledMessage })))));
    await withRuntime(f, async runtime => {
      await rejects(runtime.request(0, "debug_traceTransaction", trace(MIN_JS_CONFIG)), "invalid-schema");
      assert.equal(f.events[0].rpcErrorClass, "not-applicable"); assert.equal(f.calls.length, 1);
    });
  }
  const f = fixture(() => new Response(`{${SENTINEL}`));
  await withRuntime(f, async runtime => {
    await rejects(runtime.request(0, "debug_traceTransaction", trace(tracer.EMISSION_TRACE_CONFIG)), "provider-json-failure");
    assert.equal(f.events[0].rpcErrorClass, "not-applicable"); assert.equal(f.events[0].rpcErrorCode, null);
  });
});

test("classifier ignores nested data and refuses malformed/getter arguments without leaking or hashing message/source fragments", async () => {
  let invoked = 0;
  const trap = () => { invoked++; throw new Error(SENTINEL); };
  const safe = { code: -32602, message: SENTINEL }; Object.defineProperty(safe, "data", { get: trap });
  assert.equal(classifyRpcError(safe), "unknown");
  const inherited = Object.create({ code: -32602, message: disabledMessage });
  for (const bad of [undefined, null, [], SENTINEL, {}, inherited, { code: -32602.5, message: disabledMessage }, { code: -32602, message: 1 },
    { get code() { return trap(); }, message: disabledMessage }, { code: -32602, get message() { return trap(); } },
    { code: -32602, message: disabledMessage, toJSON: trap }, { code: -32602, message: "x".repeat(4097) }]) assert.equal(classifyRpcError(bad), "unknown");
  assert.equal(invoked, 0);
  assert.equal(classifyRpcError({ code: -32602, message: SENTINEL, data: { message: disabledMessage } }), "unknown");
  const message = `${disabledMessage}; ${SENTINEL}; ${MIN_JS_SOURCE}; ${tracer.EMISSION_TRACER_SOURCE.slice(0, 80)}`;
  const f = fixture(req => rpcError(req, message, -32602, { message: "failed to parse tracer", source: tracer.EMISSION_TRACER_SOURCE, private: SENTINEL }));
  await withRuntime(f, async runtime => {
    await rejects(runtime.request(0, "debug_traceTransaction", trace(MIN_JS_CONFIG)), "provider-rpc-failure");
    assert.equal(f.events[0].rpcErrorClass, "custom-disabled-reported");
    const publicText = JSON.stringify({ events: f.events, snapshot: runtime.snapshot(), backoff: runtime.backoffSnapshot(), class: classifyRpcError({ code: -32602, message }) });
    for (const secret of [SENTINEL, MIN_JS_SOURCE, tracer.EMISSION_TRACER_SOURCE.slice(0, 80), capture.sha256(message), "failed to parse tracer"]) assert.ok(!publicText.includes(secret));
  });
  const bounded = fixture(req => rpcError(req, disabledMessage.padEnd(4096, " ")));
  await withRuntime(bounded, async runtime => {
    await rejects(runtime.request(0, "debug_traceTransaction", trace(MIN_JS_CONFIG)), "provider-rpc-failure");
    assert.equal(bounded.events[0].rpcErrorClass, "custom-disabled-reported");
  });
});

test("callback exceptions/promises and late duration/expiry keep precedence over classified RPC rejection", async () => {
  for (const mode of ["throw", "promise", "expiry", "duration"]) {
    const f = fixture(req => rpcError(req));
    f.options.onTransportDiagnostic = event => {
      f.events.push(event);
      if (mode === "throw") throw new Error(SENTINEL);
      if (mode === "promise") return Promise.reject(new Error(SENTINEL));
      f.setNow(mode === "expiry" ? Date.parse(capture.EXPIRES_AT) : START + 600000);
    };
    await withRuntime(f, async runtime => {
      await rejects(runtime.request(0, "debug_traceTransaction", trace(MIN_JS_CONFIG)), mode === "expiry" ? "session-expired" : mode === "duration" ? "total-time-budget-exhausted" : "capture-failed");
      assert.equal(f.events[0].rpcErrorClass, "custom-disabled-reported"); assert.equal(f.events[0].code, "provider-rpc-failure");
      assert.equal(f.calls.length, 1); assert.equal(runtime.backoffSnapshot().retries, 0);
    });
  }
});

test("late request/byte budgets and responses consumed after expiry/duration never become deferred rejection authority", async () => {
  const errorBytes = Buffer.byteLength(JSON.stringify(envelope({ id: 1 }, { code: -32602, message: disabledMessage })));
  for (const limits of [{ requests: 1 }, { responseBytes: 1 }, { totalResponseBytes: 1 }, { totalResponseBytes: errorBytes }]) {
    const f = fixture(req => rpcError(req), { limits });
    await withRuntime(f, async runtime => {
      await rejects(runtime.request(0, "debug_traceTransaction", trace(MIN_JS_CONFIG)), limits.requests ? "request-budget-exhausted" : "response-budget-exceeded");
      assert.equal(f.events[0].rpcErrorClass, limits.requests || limits.totalResponseBytes === errorBytes ? "custom-disabled-reported" : "not-applicable");
      assert.equal(f.calls.length, 1);
    });
  }
  for (const expiry of [false, true]) {
    const f = fixture((req, _init, self) => { self.setNow(expiry ? Date.parse(capture.EXPIRES_AT) : START + 600000); return rpcError(req); });
    await withRuntime(f, async runtime => {
      await rejects(runtime.request(0, "debug_traceTransaction", trace(MIN_JS_CONFIG)), expiry ? "session-expired" : "total-time-budget-exhausted");
      assert.equal(f.events[0].rpcErrorClass, "not-applicable"); assert.equal(f.calls.length, 1);
    });
  }
});

test("absolute expiry is checked at setup and before requests, cannot roll back, and does not fetch", async () => {
  const f = fixture(); f.setNow(Date.parse(capture.EXPIRES_AT));
  assert.throws(() => capture.createRuntime(f.options), /^Error: session-expired$/);
  f.setNow(START);
  await withRuntime(f, async runtime => {
    f.setNow(Date.parse(capture.EXPIRES_AT)); await rejects(runtime.request(0, "debug_traceTransaction", trace(MIN_JS_CONFIG)), "session-expired");
    f.setNow(START); await rejects(runtime.request(0, "eth_chainId", []), "session-expired");
    assert.equal(f.calls.length, 0);
  });
});

test("429 retries consume physical request/trace counts and preserve copied method/params despite caller mutation", async () => {
  for (const retryCount of [1, 2]) {
    const config = { ...MIN_JS_CONFIG }, params = trace(config);
    const f = fixture((req, _init, self) => {
      config.timeout = "5s"; config.tracer = SENTINEL; params[0] = H(999);
      return self.calls.length <= retryCount ? new Response(JSON.stringify(envelope(req, { code: -32602, message: disabledMessage })), { status: 429 }) : new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: 1 }));
    });
    await withRuntime(f, async runtime => {
      assert.equal(await runtime.request(0, "debug_traceTransaction", params), 1);
      assert.equal(runtime.snapshot().requests, retryCount + 1); assert.equal(runtime.snapshot().traceRequests, retryCount + 1);
      assert.equal(runtime.backoffSnapshot().retries, retryCount); assert.equal(f.calls.length, retryCount + 1);
      assert.deepEqual(f.calls.map(c => [c.method, c.params]), Array.from({ length: retryCount + 1 }, () => ["debug_traceTransaction", trace(MIN_JS_CONFIG)]));
      assert.deepEqual(f.events.map(e => e.attempt), Array.from({ length: retryCount + 1 }, (_, i) => i + 1));
      assert.ok(f.events.every(e => e.rpcErrorClass === "not-applicable"));
    });
  }
});

test("429 per-request, family circuit, session retry and physical request/trace caps remain unchanged", async () => {
  const f = fixture(() => new Response(SENTINEL, { status: 429 }));
  await withRuntime(f, async runtime => {
    await rejects(runtime.request(0, "debug_traceTransaction", trace(MIN_JS_CONFIG)), "provider-rate-limited");
    await rejects(runtime.request(0, "debug_traceTransaction", trace(MIN_JS_CONFIG)), "provider-circuit-open");
    assert.equal(f.calls.length, 3); assert.equal(runtime.backoffSnapshot().retries, 2); assert.equal(runtime.snapshot().traceRequests, 3);
  });
  const capped = fixture((req, _init, self) => self.calls.length % 2 ? new Response(SENTINEL, { status: 429 }) : new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: 1 })));
  await withRuntime(capped, async runtime => {
    for (let n = 0; n < 16; n++) assert.equal(await runtime.request(n % 3, "debug_traceTransaction", trace(MIN_JS_CONFIG)), 1);
    await rejects(runtime.request(1, "debug_traceTransaction", trace(MIN_JS_CONFIG)), "retry-budget-exhausted");
    assert.equal(runtime.backoffSnapshot().retries, 16); assert.equal(capped.calls.length, 33); assert.equal(runtime.snapshot().traceRequests, 33);
  });
  for (const limits of [{ requests: 1 }, { traceRequestCap: 1 }]) {
    const bounded = fixture(() => new Response(SENTINEL, { status: 429 }), { limits });
    await withRuntime(bounded, async runtime => {
      await rejects(runtime.request(0, "debug_traceTransaction", trace(MIN_JS_CONFIG)), limits.requests ? "request-budget-exhausted" : "trace-request-budget-exhausted");
      assert.equal(bounded.calls.length, 1); assert.equal(runtime.snapshot().requests, 1); assert.equal(runtime.snapshot().traceRequests, 1);
    });
  }
});

test("default 64-trace and 300-physical-request caps stop new sends, including the last late-budget result", async () => {
  const traces = fixture();
  await withRuntime(traces, async runtime => {
    for (let n = 0; n < 64; n++) await runtime.request(0, "debug_traceTransaction", trace(MIN_JS_CONFIG));
    await rejects(runtime.request(0, "debug_traceTransaction", trace(MIN_JS_CONFIG)), "trace-request-budget-exhausted");
    assert.equal(traces.calls.length, 64); assert.equal(runtime.snapshot().traceRequests, 64);
  });
  const requests = fixture();
  await withRuntime(requests, async runtime => {
    for (let n = 0; n < 299; n++) await runtime.request(0, "eth_chainId", []);
    await rejects(runtime.request(0, "eth_chainId", []), "request-budget-exhausted");
    await rejects(runtime.request(0, "eth_chainId", []), "request-budget-exhausted");
    assert.equal(requests.calls.length, 300); assert.equal(runtime.snapshot().requests, 300);
  });
});

test("close cancels and drains a mocked streamed fetch and pending requests without a rejection class", { timeout: 3000 }, async () => {
  let entered, aborted = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture((_req, init) => new Response(new ReadableStream({ start(controller) {
    init.signal.addEventListener("abort", () => { aborted++; controller.error(new Error(SENTINEL)); }, { once: true }); entered();
  } })), { limits: { requestTimeoutMs: 500 } });
  const runtime = capture.createRuntime(f.options);
  const done = Promise.allSettled([runtime.request(0, "debug_traceTransaction", trace(MIN_JS_CONFIG)), runtime.request(0, "eth_chainId", [])]);
  await started; await runtime.close();
  for (const result of await done) { assert.equal(result.status, "rejected"); assert.equal(result.reason.message, "session-closed"); }
  assert.equal(aborted, 1); assert.equal(f.calls.length, 1); assert.equal(f.events[0].rpcErrorClass, "not-applicable");
  assert.deepEqual(runtime.lifecycle(), { closed: true, pending: 0 });
  await rejects(runtime.request(0, "eth_chainId", []), "session-closed");
});

test("mocked streamed fetch timeout is not a classified custom rejection", { timeout: 3000 }, async () => {
  const f = fixture((_req, init) => new Response(new ReadableStream({ start(controller) {
    init.signal.addEventListener("abort", () => controller.error(new Error(SENTINEL)), { once: true });
  } })), { limits: { requestTimeoutMs: 25 } });
  await withRuntime(f, async runtime => {
    await rejects(runtime.request(0, "debug_traceTransaction", trace(MIN_JS_CONFIG)), "request-timeout");
    assert.equal(f.calls.length, 1); assert.equal(f.events[0].rpcErrorClass, "not-applicable");
  });
});

test("strict error envelopes still fail without a diagnostic callback", async () => {
  for (const malformed of [false, true]) {
    const f = fixture(req => {
      const body = envelope(req, { code: -32602, message: disabledMessage });
      if (malformed) delete body.id;
      return new Response(JSON.stringify(body));
    }, { onTransportDiagnostic: undefined });
    await withRuntime(f, async runtime => {
      await rejects(runtime.request(0, "debug_traceTransaction", trace(MIN_JS_CONFIG)), malformed ? "invalid-schema" : "provider-rpc-failure");
      assert.equal(f.calls.length, 1); assert.equal(f.events.length, 0);
    });
  }
});

test("mocked fetch enforces two concurrent requests and one concurrent trace across the candidate pool", async () => {
  let active = 0, peak = 0, traces = 0, tracePeak = 0;
  const f = fixture(async req => {
    active++; peak = Math.max(peak, active);
    if (req.method === "debug_traceTransaction") { traces++; tracePeak = Math.max(tracePeak, traces); }
    await new Promise(resolve => setImmediate(resolve));
    active--; if (req.method === "debug_traceTransaction") traces--;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: 1 }));
  });
  await withRuntime(f, async runtime => {
    await Promise.all(Array.from({ length: 9 }, (_, n) => runtime.request(n % 3, "eth_chainId", [])));
    await Promise.all(Array.from({ length: 9 }, (_, n) => runtime.request(n % 3, "debug_traceTransaction", trace([capture.CALL_CONFIG, MIN_JS_CONFIG, tracer.EMISSION_TRACE_CONFIG][n % 3]))));
    assert.equal(peak, 2); assert.equal(tracePeak, 1); assert.equal(f.calls.length, 18);
  });
});
