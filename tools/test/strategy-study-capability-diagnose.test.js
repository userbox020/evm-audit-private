"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const capture = require("../strategy-study/capture"), emission = require("../strategy-study/emission-diagnose"), oldCli = require("../strategy-study/emission-cli");
const tracer = require("../strategy-study/emission-tracer"), control = require("../strategy-study/capability-control");
const collector = require("../strategy-study/capability-diagnose"), cli = require("../strategy-study/capability-cli"), previous = require("../strategy-study/trace-enrichment");
const { fixture } = require("./strategy-study-trace.test"), { witnessFor, recordedTrace, H, Q, B } = require("./strategy-study-emission-proof.test");
const clone = value => structuredClone(value), PIN = previous.FAILURE_FIXTURE, OFFSET = Number(PIN.blockNumber) - 109;
const SENTINEL = "PRIVATE_CAPABILITY_SENTINEL", isN = c => c.method === "debug_traceTransaction" && c.params[1].tracer === "callTracer";
const isM = c => c.method === "debug_traceTransaction" && c.params[1].tracer === control.MIN_JS_SOURCE;
const isE = c => c.method === "debug_traceTransaction" && c.params[1].tracer === tracer.EMISSION_TRACER_SOURCE;
function capabilityFixture(options = {}) {
  const f = fixture({ n: options.n || 111, metadata: true, ...options, hook(c) {
    if (isM(c)) c.result = 1;
    if (isE(c)) c.result = witnessFor(capture.normalizeCallTrace(c.fixture.callTrace(c.u)));
    return options.hook?.(c) || { result: c.result };
  } });
  const hashes = new Map([[H(10009), PIN.txHash]]), number = n => n === 1000 ? Number(capture.EMISSION_FIXTURE.anchorNumber) : n === 1001 ? Number(capture.EMISSION_FIXTURE.anchorNumber) + 1 : n + OFFSET;
  for (let n = 99; n <= 1001; n++) hashes.set(H(n), n === 109 ? PIN.blockHash : n === 1000 ? capture.EMISSION_FIXTURE.anchorHash : H(number(n)));
  const reverse = new Map([...hashes].map(([a, b]) => [b, a]));
  function translate(value) {
    if (typeof value === "string") return hashes.get(value) || value;
    if (Array.isArray(value)) return value.map(translate);
    if (!value || typeof value !== "object") return value;
    const target = value.blockHash === H(109) || value.txHash === H(10009);
    return Object.fromEntries(Object.entries(value).map(([key, v]) => {
      if (["number", "blockNumber"].includes(key) && typeof v === "string") return [key, v.startsWith("0x") ? Q(number(Number(BigInt(v)))) : String(number(Number(v)))];
      if (key === "transactionIndex" && target) return [key, v.startsWith("0x") ? Q(35) : "35"];
      if (key === "transactions" && Array.isArray(v) && v.length === 1 && v[0] === H(10009)) return [key, [...Array.from({ length: 35 }, (_, i) => H(50000 + i)), PIN.txHash]];
      return [key, translate(v)];
    }));
  }
  f.parent = { ...translate(f.parent), failureProvenance: previous.FAILURE_PROVENANCE, emissionProvenance: emission.PROVENANCE, capabilityProvenance: collector.PROVENANCE };
  const fetch = f.options.fetch; f.actualCalls = [];
  f.options.fetch = async (url, init) => {
    const req = JSON.parse(init.body); f.actualCalls.push({ index: f.candidates.indexOf(url), method: req.method, params: clone(req.params) });
    req.params = req.params.map((p, i) => {
      if (i || typeof p !== "string") return p;
      if (req.method === "eth_getBlockByNumber" && p !== "finalized") return Q(p === Q(capture.EMISSION_FIXTURE.anchorNumber) ? 1000 : BigInt(p) - BigInt(OFFSET));
      return reverse.get(p) || p;
    });
    const response = await fetch(url, { ...init, body: JSON.stringify(req) }); if (response.status !== 200) return response;
    const body = await response.json(); if (Object.hasOwn(body, "result")) body.result = translate(body.result);
    return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
  };
  return f;
}
function replaceResponse(f, matches, respond) {
  const fetch = f.options.fetch;
  f.options.fetch = async (url, init) => {
    const response = await fetch(url, init), req = { ...JSON.parse(init.body), index: f.candidates.indexOf(url) };
    return matches(req) ? respond(req) : response;
  };
}
const run = f => collector.runCapabilityDiagnostic({ parent: f.parent, runtimeOptions: f.options });
const read = (out, f, options = {}) => cli.readCapabilityDiagnostic(out, options, { loadCapabilityParent: () => f.parent });
function temp() { const root = path.join(os.tmpdir(), "opencode"); fs.mkdirSync(root, { recursive: true }); return fs.mkdtempSync(path.join(root, "t4c-test-")); }
async function published(f) {
  const root = temp(), out = path.join(root, "matrix");
  try { const result = await run(f), summary = cli.createCapabilityWriter(out).publish(result, f.parent, f.now); return { root, out, result, summary }; }
  catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
}
function rehash(file, m) { delete m.payloadSha256; m.payloadSha256 = capture.sha256(capture.canonical(m)); fs.writeFileSync(file, JSON.stringify(m)); }
const rpc = (code = -32602, message = SENTINEL) => ({ error: { code, message, data: { nested: SENTINEL, source: tracer.EMISSION_TRACER_SOURCE } } });

test("fixed full-pool N/M10/E matrix precedes independent pair and exact final checks without study authority", async () => {
  const f = capabilityFixture({ trace: recordedTrace, hook(c) {
    if (isN(c) && c.index === 1) c.result.logs.forEach((log, i) => { log.index = Q(i + 10); });
    if (isN(c) && c.index === 2) c.result.logs.forEach(log => { delete log.index; });
    return { result: c.result };
  } }), p = await published(f);
  try {
    const r = p.result; assert.equal(r.status, "DIAGNOSTIC-COMPLETE", r.reason); assert.equal(r.basicPoolComplete, true);
    assert.equal(r.matrixComplete, true); assert.equal(r.pairedWitnessComplete, true); assert.equal(r.pairIndependent, true); assert.equal(r.finalAnchorRechecked, true);
    assert.deepEqual(r.selectedAliases, ["obs-01", "obs-02"]); assert.deepEqual(r.customRejections, []); assert.ok(r.observations.every(o => o.complete && o.postchecked && o.minimalResult === 1));
    assert.deepEqual(r.proof.callObservations.map(o => o.candidateDomains), [["RECORDED_EMISSION"], ["GLOBAL"], []]);
    assert.equal(r.validAggregate, false); assert.equal(r.counts.completed, 0); assert.equal(r.counts.universe, 111); assert.equal(r.budget.traceRequests, 9);
    assert.equal(r.budget.requests, f.actualCalls.length); assert.equal(r.budget.logRequests, 0);
    const firstTrace = f.actualCalls.findIndex(isN), lastE = f.actualCalls.findLastIndex(isE);
    for (let i = 0; i < 3; i++) {
      assert.ok(f.actualCalls.findIndex(c => c.index === i && c.method === "eth_getTransactionReceipt") < firstTrace);
      const calls = f.actualCalls.filter(c => c.index === i && c.method === "debug_traceTransaction");
      assert.deepEqual(calls.map(c => c.params), [capture.CALL_CONFIG, control.MIN_JS_CONFIG, tracer.EMISSION_TRACE_CONFIG].map(config => [PIN.txHash, config]));
    }
    assert.ok(r.transportDiagnostics.filter(e => e.phase.startsWith("final-")).every(e => e.requestId > lastE));
    const text = fs.readFileSync(path.join(p.out, cli.FILE), "utf8"); assert.ok(!text.includes(SENTINEL)); assert.ok(!text.includes(control.MIN_JS_SOURCE)); assert.ok(!text.includes(tracer.EMISSION_TRACER_SOURCE));
    assert.ok(!/https:|alchemy|infura|publicnode/.test(text)); assert.equal(read(p.out, f, { expectedManifestSha256: p.summary.manifestSha256 }).authority.validAggregate, false);
    assert.throws(() => oldCli.readEmissionDiagnostic(p.out, {}, { loadEmissionParent: () => f.parent }), /invalid-schema/);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
test("single-family and one-witness matrices never confer paired success", async () => {
  for (const singleFamily of [true, false]) {
    const f = capabilityFixture({ n: 10, ...(singleFamily ? { candidates: ["https://eth-mainnet.g.alchemy.com/offline-a", "https://eth-mainnet.g.alchemy.com/offline-b"] } : {}),
      hook(c) { return !singleFamily && c.index > 0 && isE(c) ? { status: 401, raw: SENTINEL } : { result: c.result }; } }), p = await published(f);
    try {
      const r = p.result; assert.equal(r.basicPoolComplete, true); assert.equal(r.matrixComplete, !singleFamily);
      assert.equal(r.reason, "independent-pair-unavailable"); assert.equal(r.status, "ACCESS-BLOCKED");
      assert.equal(r.pairedWitnessComplete, false); assert.equal(r.proof, null); assert.deepEqual(r.selectedAliases, []); assert.equal(read(p.out, f).authority.validAggregate, false);
      if (singleFamily) {
        assert.ok(r.observations.every(o => o.basic === "passed")); assert.equal(r.budget.traceRequests, 0);
        assert.equal(f.actualCalls.some(c => isN(c) || isM(c) || isE(c)), false);
        assert.equal(r.transportDiagnostics.some(e => e.phase === "trace-header-before"), false);
      } else assert.equal(r.observations.filter(o => o.complete).length, 1);
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});
test("one basic-qualified candidate cannot start capability discovery after the full pool rejects wrong-chain and unavailable candidates", async () => {
  const f = capabilityFixture({ n: 10, hook(c) {
    if (c.index === 1 && c.method === "eth_chainId") return { result: "0x2" };
    if (c.index === 2 && c.method === "eth_getTransactionByHash") return { result: null };
    return { result: c.result };
  } }), p = await published(f);
  try {
    const r = p.result; assert.equal(r.basicPoolComplete, true); assert.equal(r.matrixComplete, false);
    assert.equal(r.status, "ACCESS-BLOCKED"); assert.equal(r.reason, "independent-pair-unavailable"); assert.equal(r.integrityFailure, null);
    assert.deepEqual(r.observations.map(o => o.basic), ["passed", "not-tested", "not-tested"]);
    assert.deepEqual(r.observations.map(o => o.reason), [null, "wrong-chain", "fixture-unavailable"]);
    assert.equal(r.budget.traceRequests, 0); assert.equal(r.proof, null); assert.deepEqual(r.selectedAliases, []); assert.equal(r.pairedWitnessComplete, false);
    assert.equal(f.actualCalls.some(c => isN(c) || isM(c) || isE(c)), false);
    assert.equal(r.transportDiagnostics.some(e => e.phase === "trace-header-before"), false);
    for (let i = 0; i < 3; i++) assert.ok(f.actualCalls.some(c => c.index === i && c.method === "eth_chainId"));
    assert.equal(read(p.out, f).manifest.matrixComplete, false);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
test("well-formed M10/E rejections before or after two witnesses are permanent global blockers with postchecks and matrix continuation", async () => {
  const classes = [["unknown", `unsupported ${SENTINEL}`], ["custom-disabled-reported", `custom JS tracing is disabled ${SENTINEL}`],
    ["js-parse-reported", `failed to parse JS tracer ${SENTINEL}`], ["configuration-rejected-reported", `invalid timeout value ${SENTINEL}`]];
  for (const phase of ["M", "E"]) for (const index of [0, 2]) for (const errorCode of [-32601, -32602]) for (const [errorClass, message] of classes) {
    if (phase === "E" && errorClass === "custom-disabled-reported") continue;
    const f = capabilityFixture({ n: 10, hook(c) { return c.index === index && (phase === "M" ? isM(c) : isE(c)) ? rpc(errorCode, message) : { result: c.result }; } }), p = await published(f);
    try {
      const r = p.result, o = r.observations[index], rejection = r.customRejections[0];
      assert.equal(r.status, "CAPABILITY-BLOCKED", `${phase}/${index}/${errorCode}/${errorClass}`); assert.equal(r.matrixComplete, true); assert.equal(r.integrityFailure, null);
      assert.equal(r.aggregateEvidenceStatus, "INVALID"); assert.equal(r.pairedWitnessComplete, false); assert.equal(r.proof, null); assert.deepEqual(r.selectedAliases, []);
      assert.equal(o.reason, null); assert.equal(o.postchecked, true); assert.equal(o.minimal, phase === "M" ? "rejected" : "passed"); assert.equal(o.witness, phase === "M" ? "not-tested" : "rejected");
      assert.equal(rejection.rpcErrorClass, errorClass); assert.equal(rejection.rpcErrorCode, errorCode); assert.equal(rejection.code, errorCode === -32601 ? "provider-method-not-found" : "provider-rpc-failure");
      assert.ok(r.observations.filter((_, i) => i !== index).every(o => o.complete)); assert.equal(r.customRejections.length, 1);
      const history = r.transportDiagnostics.filter(e => e.observationId === o.id), post = history.filter(e => e.requestId > rejection.requestId);
      assert.deepEqual(post.map(e => e.phase), ["receipt-after", "trace-header-after", "trace-header-after"]);
      assert.equal(f.actualCalls.filter(c => c.index === index && isE(c)).length, phase === "M" ? 0 : 1);
      assert.equal(read(p.out, f).manifest.aggregateEvidenceStatus, "INVALID"); assert.ok(!fs.readFileSync(path.join(p.out, cli.FILE), "utf8").includes(SENTINEL));
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});
test("M10 success followed by E blanket denial stops as inconsistent capability reporting, not a chain contradiction", async () => {
  const f = capabilityFixture({ n: 10, hook(c) { return c.index === 0 && isE(c) ? rpc(-32602, `JS tracing is disabled ${SENTINEL}`) : { result: c.result }; } }), p = await published(f);
  try {
    const r = p.result; assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.reason, "provider-rpc-failure"); assert.equal(r.matrixComplete, false);
    assert.equal(r.integrityFailure.category, "inconsistent-capability-reporting"); assert.equal(r.customRejections.length, 1); assert.equal(r.observations[0].postchecked, false);
    assert.equal(r.budget.traceRequests, 3); assert.equal(r.proof, null); assert.equal(read(p.out, f).manifest.aggregateEvidenceStatus, "INVALID");
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
test("exact numeric1 is required for M10 and malformed native, E, material and RPC envelopes are immediate fatal failures", async () => {
  for (const value of [null, false, true, 0, 2, "1", "0x1", {}, [], { result: 1 }]) {
    const f = capabilityFixture({ n: 10, hook(c) { return c.index === 0 && isM(c) ? { result: value } : { result: c.result }; } }), r = await run(f);
    assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.reason, "invalid-schema"); assert.equal(r.observations[0].minimalResult, null); assert.equal(r.customRejections.length, 0);
    assert.equal(f.actualCalls.some(isE), false); cli.validateCapabilityDiagnostic(r, f.parent);
  }
  for (const matches of [isN, isM, isE, c => c.method === "eth_getBlockByNumber"]) for (const mode of ["bad-result", "error-plus-result", "bad-message", "bad-code", "invalid-json", "http500"]) {
    if (matches === isM && mode === "bad-result") continue;
    const f = capabilityFixture({ n: 10 });
    replaceResponse(f, c => c.index === 0 && matches(c), req => {
      const body = { jsonrpc: "2.0", id: req.id, error: { code: -32602, message: SENTINEL } };
      if (mode === "bad-result") { delete body.error; body.result = {}; }
      if (mode === "error-plus-result") body.result = 1;
      if (mode === "bad-message") body.error.message = null;
      if (mode === "bad-code") body.error.code = "-32602";
      return new Response(mode === "invalid-json" ? SENTINEL : JSON.stringify(body), { status: mode === "http500" ? 500 : 200 });
    });
    const r = await run(f); assert.equal(r.status, "CAPTURE-FAILED", mode); assert.equal(r.customRejections.length, 0); assert.equal(r.proof, null);
    assert.ok(r.observations.every(o => o.reason === null)); assert.ok(!JSON.stringify(r).includes(SENTINEL)); cli.validateCapabilityDiagnostic(r, f.parent);
  }
  for (const matches of [isN, c => c.method === "eth_getTransactionReceipt"]) {
    const f = capabilityFixture({ n: 10, hook(c) { return c.index === 0 && matches(c) ? rpc() : { result: c.result }; } }), r = await run(f);
    assert.equal(r.reason, "provider-rpc-failure"); assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.customRejections.length, 0); cli.validateCapabilityDiagnostic(r, f.parent);
  }
});
test("all retained core/witness/index facts veto later candidates, including M10-rejected indexes as soon as the first witness arrives", async () => {
  for (const mode of ["early-index", "late-index", "retired-core", "retired-witness", "material"]) {
    const f = capabilityFixture({ n: 10, hook(c) {
      if (mode === "early-index" && c.index === 0 && isM(c)) return rpc();
      if (mode === "early-index" && c.index === 0 && isN(c)) c.result.logs[1].index = "0x7";
      if (mode === "late-index" && c.index === 1 && isN(c)) c.result.logs[1].index = "0x7";
      if (mode === "retired-core" && c.index === 0 && isN(c)) c.result.gas = "0x5209";
      if (mode === "retired-core" && c.index === 0 && isM(c)) return { status: 403, raw: SENTINEL };
      if (mode === "retired-witness" && c.index === 0 && isE(c)) c.result.emissions[0].pc++;
      if (mode === "retired-witness" && c.index === 0 && c.method === "eth_getTransactionReceipt" && c.fixture.calls.some(p => p.index === 0 && isE(p))) return { result: null };
      if (mode === "material" && c.index === 1 && c.method === "eth_getBlockByNumber") c.result.stateRoot = H(999);
      return { result: c.result };
    } }), p = await published(f);
    try {
      const r = p.result; assert.equal(r.status, "CAPTURE-FAILED", mode); assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.proof, null); assert.equal(r.matrixComplete, false);
      if (mode === "early-index") { assert.equal(r.integrityFailure.phase, "index-domain"); assert.equal(r.integrityFailure.observationId, "obs-01"); assert.equal(r.customRejections.length, 1); }
      if (mode === "late-index") { assert.equal(r.integrityFailure.phase, "index-domain"); assert.equal(f.actualCalls.filter(c => c.index === 1 && isM(c)).length, 0); }
      assert.equal(read(p.out, f).manifest.aggregateEvidenceStatus, "INVALID");
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});
test("initial identity failed admission stays narrow, while accepted identity and prior material observations cannot be discarded", async () => {
  for (const retry of [false, true]) {
    const f = capabilityFixture({ n: 10 }); let count = 0;
    replaceResponse(f, c => c.index === 0 && c.method === "eth_chainId", req => retry && count++ === 0 ? new Response(SENTINEL, { status: 429 })
      : new Response(JSON.stringify({ jsonrpc: "1.0", id: req.id, result: SENTINEL })));
    const p = await published(f);
    try {
      assert.equal(p.result.status, "DIAGNOSTIC-COMPLETE"); assert.equal(p.result.observations[0].reason, "identity-unqualified");
      assert.ok(f.actualCalls.filter(c => c.index === 0).every(c => c.method === "eth_chainId")); assert.equal(p.result.backoff.retries, retry ? 1 : 0);
      assert.deepEqual(p.result.selectedAliases, ["obs-02", "obs-03"]); assert.equal(read(p.out, f).authority.validAggregate, false);
      const file = path.join(p.out, cli.FILE), base = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const mutate of [m => { m.observations[0].basic = "passed"; }, m => { m.transportDiagnostics = m.transportDiagnostics.filter(e => e.observationId !== "obs-01"); },
        m => { const e = m.transportDiagnostics.findLast(e => e.observationId === "obs-01"); e.outcome = "passed"; e.code = null; },
        m => { m.transportDiagnostics.find(e => e.observationId === "obs-01").attempt = 2; }]) {
        const m = clone(base); mutate(m); rehash(file, m); assert.throws(() => read(p.out, f), /invalid-schema/);
      }
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
  const f = capabilityFixture({ n: 10, hook(c) { return c.index === 0 && c.method === "eth_chainId" ? { result: null } : { result: c.result }; } }), r = await run(f);
  assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.observations[0].reason, null); assert.equal(r.transportDiagnostics[0].outcome, "passed"); cli.validateCapabilityDiagnostic(r, f.parent);
});
test("custom 429 retries preserve exact params; request/byte/expiry/callback/internal/global failures never become deferred rejection", async () => {
  let attempts = 0;
  const retried = capabilityFixture({ n: 10, hook(c) { return c.index === 0 && isM(c) ? attempts++ === 0 ? { status: 429, raw: SENTINEL } : rpc() : { result: c.result }; } }), result = await run(retried);
  assert.equal(result.status, "CAPABILITY-BLOCKED"); assert.equal(result.backoff.retries, 1); assert.equal(result.customRejections.length, 1);
  const sends = retried.actualCalls.filter(c => c.index === 0 && isM(c)); assert.equal(sends.length, 2); assert.deepEqual(sends[0].params, sends[1].params); cli.validateCapabilityDiagnostic(result, retried.parent);
  for (const limits of [{ requests: 1 }, { responseBytes: 1 }, { totalResponseBytes: 1 }, { traceRequestCap: 2 }]) {
    const f = capabilityFixture({ n: 10, limits, hook(c) { return c.index === 0 && isM(c) ? rpc() : { result: c.result }; } }), r = await run(f);
    // At trace cap2 the rejected custom event is retained, but the next
    // candidate's native probe cannot evade the shared physical trace cap.
    assert.equal(r.status, "LIMIT-REACHED"); assert.equal(r.matrixComplete, false); assert.equal(r.proof, null); cli.validateCapabilityDiagnostic(r, f.parent);
  }
  const original = capture.createRuntime;
  for (const mode of ["callback", "async-callback", "options", "internal", "expiry", ...collector.GLOBAL_LIMITS]) {
    const f = capabilityFixture({ n: 10, hook(c) { return c.index === 0 && isM(c) ? rpc() : { result: c.result }; } });
    const expected = mode === "expiry" ? "session-expired" : mode === "options" ? "invalid-options" : collector.GLOBAL_LIMITS.has(mode) ? mode : "capture-failed";
    capture.createRuntime = options => {
      const runtime = original({ ...options, onTransportDiagnostic(event) {
        options.onTransportDiagnostic(event);
        if (event.rpcErrorClass === "not-applicable") return;
        if (mode === "callback") throw new Error(SENTINEL);
        if (mode === "async-callback") return Promise.reject(new Error(SENTINEL));
        if (mode === "expiry") f.setNow(Date.parse(capture.EXPIRES_AT));
      } });
      if (["callback", "async-callback", "expiry"].includes(mode)) return runtime;
      return { ...runtime, async request(...args) {
        try { return await runtime.request(...args); } catch (_) { throw new Error(mode === "internal" ? SENTINEL : expected); }
      } };
    };
    try {
      const r = await run(f); assert.equal(r.reason, expected, mode); assert.equal(r.customRejections.length, 0); assert.equal(r.matrixComplete, false);
      assert.equal(r.transportDiagnostics.at(-1).rpcErrorClass, "unknown"); assert.equal(r.proof, null); assert.equal(r.selectedAliases.length, 0); cli.validateCapabilityDiagnostic(r, f.parent);
    } finally { capture.createRuntime = original; }
  }
});
test("a later global budget and drain failure discard an earlier potential pair and never publish partial proof", async () => {
  const f = capabilityFixture({ n: 10, limits: { traceRequestCap: 7 } }), r = await run(f);
  assert.equal(r.status, "LIMIT-REACHED"); assert.equal(r.observations.filter(o => o.complete).length, 2); assert.equal(r.matrixComplete, false); assert.equal(r.proof, null);
  assert.deepEqual(r.selectedAliases, []); cli.validateCapabilityDiagnostic(r, f.parent);
  const g = capabilityFixture({ n: 10 }), original = capture.createRuntime, root = temp();
  capture.createRuntime = options => { const runtime = original(options); return { ...runtime, async close() { await runtime.close(); throw new Error("runtime-drain-failed"); } }; };
  try {
    const failed = await run(g), out = path.join(root, "failed"); assert.equal(failed.proof, null); assert.equal(failed.pairedWitnessComplete, false); assert.equal(failed.matrixComplete, false);
    assert.throws(() => cli.createCapabilityWriter(out).publish(failed, g.parent, g.now), /invalid-schema/); assert.deepEqual(fs.readdirSync(out), []);
  } finally { capture.createRuntime = original; fs.rmSync(root, { recursive: true, force: true }); }
});
test("reader rejects rehashed cleared/relabelled blockers, forged M10, missing postchecks and a blocked pair", async () => {
  const f = capabilityFixture({ n: 10, hook(c) { return c.index === 0 && isM(c) ? rpc() : { result: c.result }; } }), p = await published(f);
  try {
    const file = path.join(p.out, cli.FILE), base = JSON.parse(fs.readFileSync(file, "utf8")), terminal = m => m.transportDiagnostics.find(e => e.requestId === base.customRejections[0].requestId);
    for (const [i, mutate] of [
      m => { m.customRejections = []; m.status = "ACCESS-BLOCKED"; m.reason = "independent-pair-unavailable"; m.aggregateEvidenceStatus = "NON-AUTHORITATIVE"; },
      m => {
        Object.assign(m.observations[0], { basic: "not-tested", call: "not-tested", minimal: "not-tested", minimalResult: null, witness: "not-tested", postchecked: false, reason: "identity-unqualified" });
        m.customRejections = []; m.status = "ACCESS-BLOCKED"; m.reason = "independent-pair-unavailable"; m.aggregateEvidenceStatus = "NON-AUTHORITATIVE";
        Object.assign(terminal(m), { phase: "chain-id", method: "eth_chainId", universeIndex: null, rpcErrorCode: null, rpcErrorClass: "not-applicable", code: "invalid-schema" });
      },
      m => { m.observations[0].reason = "provider-method-not-found"; }, m => { m.observations[0].minimal = "passed"; m.observations[0].minimalResult = 1; },
      m => { m.customRejections[0].requestId++; }, m => { m.customRejections[0].rpcErrorClass = "js-parse-reported"; }, m => { m.customRejections[0].resolved = true; },
      m => { terminal(m).rpcErrorClass = "not-applicable"; }, m => { terminal(m).httpStatus = 201; }, m => { terminal(m).code = "provider-json-failure"; },
      m => { terminal(m).outcome = "passed"; terminal(m).code = null; }, m => { m.transportDiagnostics = m.transportDiagnostics.filter(e => e.phase !== "receipt-after"); },
      m => { m.observations[0].postchecked = false; m.transportDiagnostics = m.transportDiagnostics.filter(e => e.observationId !== "obs-01" || e.requestId <= terminal(m).requestId); },
      m => { m.pairedWitnessComplete = true; m.selectedAliases = ["obs-02", "obs-03"]; m.pairIndependent = true; },
      m => { m.transportDiagnostics = m.transportDiagnostics.filter(e => e.phase !== "minimal-tracer"); },
      m => { m.observations[1].minimalResult = "1"; }, m => { m.source.minimalConfigSha256 = "0".repeat(64); }, m => { m.validAggregate = true; },
      m => { m.transportDiagnostics[0].raw = SENTINEL; }, m => { m.proof = { raw: SENTINEL }; },
    ].entries()) {
      const m = clone(base); mutate(m); rehash(file, m); assert.throws(() => read(p.out, f), /invalid-schema/, `forgery ${i}`);
    }
    const reordered = clone(base); reordered.transportDiagnostics.reverse(); rehash(file, reordered); assert.equal(read(p.out, f).manifest.status, "CAPABILITY-BLOCKED");
    assert.throws(() => read(p.out, f, { expectedManifestSha256: p.summary.manifestSha256 }), /invalid-schema/);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
test("reader independently rebuilds successful proof, control ordering, full pool and all final checks", async () => {
  const f = capabilityFixture({ n: 10 }), p = await published(f);
  try {
    const file = path.join(p.out, cli.FILE), base = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const mutate of [m => { m.proof.callObservations.pop(); }, m => { m.proof.witness.rootGasUsed = "1"; },
      m => { m.proof.callObservations[0].bindings[0].observedIndex = "999"; }, m => { m.observations[0].minimalResult = null; },
      m => { m.observations[0].minimal = "not-tested"; m.observations[0].minimalResult = null; }, m => { m.basicPoolComplete = false; },
      m => { m.transportDiagnostics = m.transportDiagnostics.filter(e => e.phase !== "final-anchor"); },
      m => {
        const events = [...m.transportDiagnostics].sort((a, b) => a.requestId - b.requestId), finals = events.filter(e => e.phase.startsWith("final-"));
        const others = events.filter(e => !finals.includes(e)), at = others.findIndex(e => e.observationId === "obs-03" && e.phase === "trace-header-before");
        others.splice(at, 0, ...finals); others.forEach((e, i) => { e.requestId = i + 1; }); m.transportDiagnostics = others;
      },
      m => { const a = m.transportDiagnostics.find(e => e.phase === "minimal-tracer"), b = m.transportDiagnostics.find(e => e.phase === "emission-tracer"); [a.requestId, b.requestId] = [b.requestId, a.requestId]; },
      m => { const e = m.transportDiagnostics.find(e => e.phase === "call-tracer"); e.attempt = 2; }, m => { m.selectedAliases.reverse(); },
      m => { m.provenance.sourceT3DRManifestSha256 = "0".repeat(64); }, m => { m.counts.completed = 1; }]) {
      const m = clone(base); mutate(m); rehash(file, m); assert.throws(() => read(p.out, f), /invalid-schema/);
    }
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
test("fixed parent loader binds immutable T3DR failure provenance and cannot override any path, hash or fixture", () => {
  const f = capabilityFixture({ n: 10 }), m = { schema: emission.SCHEMA, chainId: 1, status: "CAPTURE-FAILED", reason: "provider-rpc-failure", aggregateEvidenceStatus: "INVALID",
    validAggregate: false, proof: null, diagnosticFixtureComplete: false, provenance: emission.PROVENANCE, source: emission.SOURCE, universe: f.parent.universe, fixture: PIN,
    integrityFailure: { code: "provider-rpc-failure", phase: "emission-tracer", observationId: "obs-02", universeIndex: 9, category: "ambiguous-provider-failure" } };
  function load(manifest = m, hash = collector.T3DR_SHA256) {
    return collector.loadCapabilityParent({ loadEmissionParent: () => f.parent, readEmissionDiagnostic(directory, options, deps) {
      assert.equal(directory, collector.T3DR_DIRECTORY); assert.deepEqual(options, { expectedManifestSha256: collector.T3DR_SHA256 }); assert.equal(deps.loadEmissionParent(), f.parent);
      return { manifest, manifestSha256: hash, authority: { validAggregate: false } };
    } });
  }
  assert.deepEqual(load().capabilityProvenance, collector.PROVENANCE); assert.throws(() => load(m, "0".repeat(64)), /invalid-schema/);
  for (const mutate of [m => { m.integrityFailure.phase = "chain-id"; }, m => { m.integrityFailure.observationId = "obs-01"; }, m => { m.integrityFailure.universeIndex = 8; },
    m => { m.status = "DIAGNOSTIC-COMPLETE"; }, m => { m.reason = "invalid-schema"; }, m => { m.validAggregate = true; }, m => { m.provenance.sourceC2ManifestSha256 = "0".repeat(64); }]) {
    const changed = clone(m); mutate(changed); assert.throws(() => load(changed), /invalid-schema/);
  }
  for (const key of ["path", "hash", "index"]) assert.throws(() => collector.loadCapabilityParent({ [key]: "override" }), /invalid-schema/);
});
test("strict fresh writer and CLI preserve output/expiry/parent/disposal gates and sanitized summaries", async () => {
  for (const extra of ["--chain=8453", "--diagnose-emissions", "--script=x", "--timeout=5s", "--index=9", "--requests=1", "--diagnose-capabilities"])
    assert.throws(() => cli.parseArgs(["--diagnose-capabilities", "--chain=1", "--out=x", extra]), /invalid-options/);
  for (const mode of ["success", "blocked", "parent", "expiry", "dispose"]) {
    const f = capabilityFixture({ n: 10, hook(c) { return mode === "blocked" && isM(c) ? rpc() : { result: c.result }; } }), root = temp(), out = path.join(root, "matrix"), order = [], printed = [];
    try {
      const result = await cli.main(["--diagnose-capabilities", "--chain=1", `--out=${out}`], {
        now: mode === "expiry" ? () => Date.parse(capture.EXPIRES_AT) : f.now, print: text => printed.push(text),
        createCapabilityWriter(directory) { const writer = cli.createCapabilityWriter(directory); order.push("reserve"); return { publish(...args) { assert.equal(order.at(-1), "dispose"); order.push("publish"); return writer.publish(...args); } }; },
        loadCapabilityParent() { order.push("parents"); if (mode === "parent") throw new Error(SENTINEL); return f.parent; },
        loadAuthorizedCandidates() { order.push("adapter"); return { candidates: f.candidates, getOrigin: () => null, dispose() { order.push("dispose"); if (mode === "dispose") throw new Error(SENTINEL); } }; },
        async runCapabilityDiagnostic(options) { const r = await collector.runCapabilityDiagnostic({ ...options, runtimeOptions: { ...f.options, ...options.runtimeOptions } }); assert.equal(r.runtimeDrained, true); order.push("drain"); return r; },
      });
      assert.equal(result, mode === "success" ? 0 : 2, printed.join("")); assert.ok(!printed.join("").includes(SENTINEL));
      assert.deepEqual(order, mode === "expiry" ? ["reserve"] : mode === "parent" ? ["reserve", "parents"] : ["reserve", "parents", "adapter", "drain", "dispose", ...(mode === "dispose" ? [] : ["publish"])]);
      if (["success", "blocked"].includes(mode)) assert.equal(read(out, f).authority.validAggregate, false); else assert.deepEqual(fs.readdirSync(out), []);
      assert.throws(() => cli.createCapabilityWriter(out), /output-unavailable/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
test("late publication clears paired claims and reader rejects unlisted, oversized and symlink terminal files", async t => {
  const f = capabilityFixture({ n: 10 }), result = await run(f), root = temp(), expired = path.join(root, "expired");
  try {
    cli.createCapabilityWriter(expired).publish(result, f.parent, () => Date.parse(capture.EXPIRES_AT));
    const m = read(expired, f).manifest; assert.equal(m.status, "LIMIT-REACHED"); assert.equal(m.matrixComplete, false); assert.equal(m.proof, null);
    const file = path.join(expired, cli.FILE), bytes = fs.readFileSync(file);
    fs.writeFileSync(path.join(expired, "partial.json"), "{}"); assert.throws(() => read(expired, f), /invalid-schema/); fs.unlinkSync(path.join(expired, "partial.json"));
    const fd = fs.openSync(file, "w"); fs.ftruncateSync(fd, cli.MAX_BYTES + 1); fs.closeSync(fd); assert.throws(() => read(expired, f), /invalid-schema/); fs.writeFileSync(file, bytes);
    const target = path.join(root, "target.json"); fs.renameSync(file, target);
    try { fs.symlinkSync(target, file, "file"); } catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return t.skip("Windows symlink permission unavailable"); throw error; }
    assert.throws(() => read(expired, f), /invalid-schema/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
