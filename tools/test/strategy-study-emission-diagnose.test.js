"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const capture = require("../strategy-study/capture"), tracer = require("../strategy-study/emission-tracer");
const collector = require("../strategy-study/emission-diagnose"), cli = require("../strategy-study/emission-cli");
const previous = require("../strategy-study/trace-enrichment"), oldCli = require("../strategy-study/trace-cli"), oldDiagnostic = require("../strategy-study/trace-diagnose-cli");
const { fixture } = require("./strategy-study-trace.test");
const { witnessFor, recordedTrace, H, Q, A, B } = require("./strategy-study-emission-proof.test");
const clone = value => structuredClone(value), PIN = previous.FAILURE_FIXTURE, OFFSET = Number(PIN.blockNumber) - 109, SENTINEL = "PRIVATE_EMISSION_SENTINEL";
const isCall = c => c.method === "debug_traceTransaction" && c.params[1].tracer === "callTracer";
const isJS = c => c.method === "debug_traceTransaction" && c.params[1].tracer === tracer.EMISSION_TRACER_SOURCE;
function emissionFixture(options = {}) {
  const f = fixture({ n: options.n || 111, metadata: true, ...options, hook(c) {
    if (isJS(c)) c.result = witnessFor(capture.normalizeCallTrace(c.fixture.callTrace(c.u)));
    const response = options.hook?.(c);
    return response || { result: c.result };
  } });
  const hashes = new Map([[H(10009), PIN.txHash]]);
  const blockNumber = n => n === 1000 ? Number(capture.EMISSION_FIXTURE.anchorNumber) : n === 1001 ? Number(capture.EMISSION_FIXTURE.anchorNumber) + 1 : n + OFFSET;
  for (let n = 99; n <= 1001; n++) hashes.set(H(n), n === 109 ? PIN.blockHash : n === 1000 ? capture.EMISSION_FIXTURE.anchorHash : H(blockNumber(n)));
  const reverse = new Map([...hashes].map(([a, b]) => [b, a]));
  function translate(value) {
    if (typeof value === "string") return hashes.get(value) || value;
    if (Array.isArray(value)) return value.map(translate);
    if (!value || typeof value !== "object") return value;
    const target = value.blockHash === H(109) || value.txHash === H(10009);
    return Object.fromEntries(Object.entries(value).map(([key, v]) => {
      if (["number", "blockNumber"].includes(key) && typeof v === "string") return [key, v.startsWith("0x") ? Q(blockNumber(Number(BigInt(v)))) : String(blockNumber(Number(v)))];
      if (key === "transactionIndex" && target) return [key, v.startsWith("0x") ? Q(35) : "35"];
      if (key === "transactions" && Array.isArray(v) && v.length === 1 && v[0] === H(10009)) return [key, [...Array.from({ length: 35 }, (_, i) => H(50000 + i)), PIN.txHash]];
      return [key, translate(v)];
    }));
  }
  f.parent = { ...translate(f.parent), failureProvenance: previous.FAILURE_PROVENANCE, emissionProvenance: collector.PROVENANCE };
  const fetch = f.options.fetch; f.actualCalls = [];
  f.options.fetch = async (url, init) => {
    const req = JSON.parse(init.body); f.actualCalls.push({ index: f.candidates.indexOf(url), method: req.method, params: clone(req.params) });
    req.params = req.params.map((p, i) => {
      if (i || typeof p !== "string") return p;
      if (req.method === "eth_getBlockByNumber" && p !== "finalized") return Q(p === Q(capture.EMISSION_FIXTURE.anchorNumber) ? 1000 : BigInt(p) - BigInt(OFFSET));
      return reverse.get(p) || p;
    });
    const response = await fetch(url, { ...init, body: JSON.stringify(req) });
    if (response.status !== 200) return response;
    const body = await response.json(); if (Object.hasOwn(body, "result")) body.result = translate(body.result);
    return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
  };
  return f;
}
const run = f => collector.runEmissionDiagnostic({ parent: f.parent, runtimeOptions: f.options });
const read = (out, f, options = {}) => cli.readEmissionDiagnostic(out, options, { loadEmissionParent: () => f.parent });
function temp() { const root = path.join(os.tmpdir(), "opencode"); fs.mkdirSync(root, { recursive: true }); return fs.mkdtempSync(path.join(root, "t3d-test-")); }
async function published(f) {
  const root = temp(), out = path.join(root, "witness"), result = await run(f), summary = cli.createEmissionWriter(out).publish(result, f.parent, f.now);
  return { root, out, result, summary };
}
function replaceResponse(f, matches, respond) {
  const fetch = f.options.fetch;
  f.options.fetch = async (url, init) => {
    const response = await fetch(url, init), req = { ...JSON.parse(init.body), index: f.candidates.indexOf(url) };
    return matches(req) ? respond(req) : response;
  };
}
const firstIdentity = req => req.index === 0 && req.method === "eth_chainId";
const malformedEnvelope = req => new Response(JSON.stringify({ jsonrpc: "1.0", id: req.id, result: SENTINEL }));
function rehash(file, manifest) {
  delete manifest.payloadSha256; manifest.payloadSha256 = capture.sha256(capture.canonical(manifest)); fs.writeFileSync(file, JSON.stringify(manifest));
}
test("dedicated runtime permits exactly reviewed source/config and fixed fixture/header scope; all old modes still reject JavaScript", async () => {
  const f = emissionFixture({ n: 10 });
  for (const purpose of ["qualification", "census", "enrichment"]) {
    const runtime = capture.createRuntime({ ...f.options, purpose, chainId: 1, backoff: true });
    try { await assert.rejects(runtime.request(0, "debug_traceTransaction", [PIN.txHash, tracer.EMISSION_TRACE_CONFIG]), /invalid-options|rpc-method-not-read-only-allowlisted/); }
    finally { await runtime.close(); }
  }
  assert.equal(f.calls.length, 0);
  for (const extra of [{ chainId: 8453 }, { backoff: false }, { limits: { requests: 301 } }, { limits: { traceRequestCap: 65 } }, { limits: { spacingMs: 999 } },
    { limits: { totalTimeoutMs: 600001 } }, { limits: { totalResponseBytes: 67108865 } }]) assert.throws(() => capture.createRuntime({ ...f.options, purpose: "emission-diagnostic", chainId: 1, backoff: true, ...extra }), /invalid-options/);
  const runtime = capture.createRuntime({ ...f.options, purpose: "emission-diagnostic", chainId: 1, backoff: true });
  try {
    for (const [method, params] of [["debug_traceTransaction", [PIN.txHash, capture.PRESTATE_CONFIG]], ["debug_traceTransaction", [PIN.txHash, { ...tracer.EMISSION_TRACE_CONFIG, timeout: "11s" }]],
      ["debug_traceTransaction", [H(10000), tracer.EMISSION_TRACE_CONFIG]], ["debug_traceTransaction", [PIN.txHash, { tracer: "{}", timeout: "10s" }]],
      ["eth_getTransactionByHash", [H(10000)]], ["eth_getTransactionReceipt", [H(10000)]], ["eth_getBlockByNumber", ["latest", false]],
      ["eth_getBlockByHash", [H(123), false]], ["eth_getLogs", [{}]]]) await assert.rejects(runtime.request(0, method, params), /invalid-options|rpc-method-not-read-only-allowlisted/);
    assert.equal(f.calls.length, 0);
    const spoof = { ...tracer.EMISSION_TRACE_CONFIG };
    Object.defineProperty(spoof, "toJSON", { value() { assert.fail("unreviewed serializer must not run"); } });
    await assert.rejects(runtime.request(0, "debug_traceTransaction", [PIN.txHash, spoof]), /invalid-options/);
    const getter = { timeout: "10s" }; Object.defineProperty(getter, "tracer", { enumerable: true, get() { assert.fail("unreviewed getter must not run"); } });
    await assert.rejects(runtime.request(0, "debug_traceTransaction", [PIN.txHash, getter]), /invalid-options/);
    await runtime.request(0, "debug_traceTransaction", [PIN.txHash, capture.CALL_CONFIG]);
    await runtime.request(0, "debug_traceTransaction", [PIN.txHash, tracer.EMISSION_TRACE_CONFIG]);
    assert.equal(runtime.snapshot().traceRequests, 2); assert.deepEqual(runtime.limits, capture.EMISSION_DIAGNOSTIC_LIMITS);
  } finally { await runtime.close(); }
});
test("full admitted pool proves fixed index9 only, retains paired core/witness and all domain maps without study or economic authority", async () => {
  const f = emissionFixture({ logAddresses: Array(36).fill(B), trace: recordedTrace, hook(c) {
    if (isCall(c) && c.index === 1) c.result.logs.forEach((log, i) => { log.index = Q(i + 10); });
    if (isCall(c) && c.index === 2) c.result.logs.forEach(log => { delete log.index; });
    return { result: c.result };
  } }), p = await published(f);
  try {
    const r = p.result, loaded = read(p.out, f, { expectedManifestSha256: p.summary.manifestSha256 });
    assert.equal(r.status, "DIAGNOSTIC-COMPLETE", r.reason); assert.equal(r.validAggregate, false); assert.equal(loaded.authority.validAggregate, false);
    assert.equal(r.diagnosticFixtureComplete, true); assert.equal(r.aggregateEvidenceStatus, "NON-AUTHORITATIVE"); assert.equal(r.pairIndependent, true);
    assert.equal(r.universe.length, 111); assert.deepEqual(r.counts, { universe: 111, completed: 0, missing: 111 }); assert.equal(r.missingIndices.length, 111);
    assert.deepEqual(r.selectedAliases, ["obs-01", "obs-02"]); assert.equal(r.observations[2].complete, true);
    assert.deepEqual(r.proof.callObservations.map(o => o.candidateDomains), [["RECORDED_EMISSION"], ["GLOBAL"], []]);
    assert.equal(r.proof.callObservations[0].bindings.at(-1).emissionOrdinal, 39); assert.equal(r.proof.callObservations[2].unreported, 36);
    assert.ok(r.proof.callCore.every(frame => frame.logs.every(log => !Object.hasOwn(log, "index"))));
    assert.equal(r.budget.traceRequests, 6); assert.equal(r.budget.logRequests, 0); assert.ok(f.calls.every(c => c.u === null || c.u === 9));
    const firstTrace = f.calls.findIndex(isCall);
    for (let i = 0; i < 3; i++) assert.ok(f.calls.findIndex(c => c.index === i && c.method === "eth_getTransactionReceipt") < firstTrace);
    assert.ok(f.actualCalls.filter(c => c.method === "debug_traceTransaction").every(c => c.params[0] === PIN.txHash && [capture.canonical(capture.CALL_CONFIG), capture.canonical(tracer.EMISSION_TRACE_CONFIG)].includes(capture.canonical(c.params[1]))));
    assert.equal(r.features.profitKnown, false); assert.equal(r.features.costComplete, false); assert.equal(r.features.sourceRuntimeVerified, false);
    assert.equal(r.source.sourceSha256, capture.sha256(tracer.EMISSION_TRACER_SOURCE)); assert.equal(r.source.configSha256, capture.sha256(capture.canonical(tracer.EMISSION_TRACE_CONFIG)));
    assert.ok(!JSON.stringify(r).includes(tracer.EMISSION_TRACER_SOURCE)); assert.ok(!/PRIVATE|https:|alchemy|infura|publicnode/.test(JSON.stringify(r)));
    assert.deepEqual(fs.readdirSync(p.out), ["terminalwitness.json"]);
    assert.throws(() => oldCli.readAuthoritativeTraces(p.out, { allowPartial: true }, { loadParent: () => f.parent }), /invalid-schema/);
    assert.throws(() => oldDiagnostic.readFailureFixtureDiagnostic(p.out, {}, { loadFailureBoundParent: () => f.parent }), /invalid-schema/);
    await assert.rejects(collector.runEmissionDiagnostic({ parent: f.parent, runtimeOptions: f.options, onTrace() {} }), /invalid-schema/);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
test("independent basic eligibility precedes all traces; one complete witness or single family never confers fixture success", async () => {
  const single = emissionFixture({ candidates: ["https://eth-mainnet.g.alchemy.com/offline-a", "https://eth-mainnet.g.alchemy.com/offline-b"] });
  const r = await run(single); assert.equal(r.reason, "independent-pair-unavailable"); assert.equal(r.budget.traceRequests, 0);
  const one = emissionFixture({ hook(c) { if (isJS(c) && c.index > 0) return { error: { code: -32601, message: SENTINEL } }; return { result: c.result }; } }), p = await published(one);
  try { assert.equal(p.result.status, "ACCESS-BLOCKED"); assert.equal(p.result.reason, "independent-pair-unavailable"); assert.equal(p.result.proof, null); assert.equal(p.result.diagnosticFixtureComplete, false); assert.equal(read(p.out, one).authority.validAggregate, false); }
  finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
test("retired call/index/witness constraints survive JS or later-read availability and can veto the complete pair", async () => {
  for (const mode of ["valid-retired-call", "invalid-retired-index", "conflicting-retired-core", "conflicting-retired-witness"]) {
    const f = emissionFixture({ hook(c) {
      if (c.index === 0 && isCall(c)) {
        if (mode === "invalid-retired-index") c.result.logs[1].index = "0x7";
        if (mode === "conflicting-retired-core") c.result.gas = "0x5209";
      }
      if (c.index === 0 && isJS(c)) {
        if (mode !== "conflicting-retired-witness") return { status: 403, raw: SENTINEL };
        c.result.emissions[0].pc += 1;
      }
      if (mode === "conflicting-retired-witness" && c.index === 0 && c.method === "eth_getTransactionReceipt" && c.fixture.calls.some(previous => previous.index === 0 && isJS(previous))) return { status: 401, raw: SENTINEL };
      return { result: c.result };
    } }), p = await published(f);
    try {
      const r = p.result; assert.equal(r.observations[0].reason, "provider-http-failure");
      if (mode === "valid-retired-call") {
        assert.equal(r.status, "DIAGNOSTIC-COMPLETE", r.reason); assert.deepEqual(r.selectedAliases, ["obs-02", "obs-03"]);
        assert.deepEqual(r.proof.callObservations.map(o => o.observationId), ["obs-01", "obs-02", "obs-03"]);
      } else { assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.proof, null); }
      if (mode === "invalid-retired-index") { assert.equal(r.integrityFailure.phase, "index-domain"); assert.equal(r.integrityFailure.observationId, "obs-01"); }
      assert.equal(read(p.out, f).authority.validAggregate, false);
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});
test("ambiguous JS errors, HTTP500, partial success, sticky failure and wrong gas are global failures, not availability or fallback", async () => {
  for (const mode of ["rpc", "http500", "partial", "sticky", "gas", "gas-agrees-with-call"]) {
    const f = emissionFixture({ hook(c) {
      if (c.index === 0 && isCall(c) && mode === "gas-agrees-with-call") c.result.gasUsed = "0x1";
      if (c.index === 0 && isJS(c)) {
        if (mode === "rpc") return { error: { code: -32000, message: SENTINEL } };
        if (mode === "http500") return { status: 500, raw: SENTINEL };
        if (mode === "partial") return { result: { complete: false, raw: SENTINEL } };
        if (mode === "sticky") c.result.complete = false;
        if (mode.startsWith("gas")) c.result.rootGasUsed = "1";
      }
      return { result: c.result };
    } }), p = await published(f);
    try {
      assert.equal(p.result.status, "CAPTURE-FAILED", mode); assert.equal(p.result.proof, null); assert.equal(p.result.integrityFailure.phase, "emission-tracer");
      assert.equal(p.result.observations[0].reason, null); assert.equal(p.result.budget.traceRequests, 2); assert.ok(!JSON.stringify(p.result).includes(SENTINEL));
      assert.equal(read(p.out, f).manifest.aggregateEvidenceStatus, "INVALID");
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});
test("new runtime rejects error-plus-result and enforces physical 429/request/trace caps without new queries", async () => {
  const f = emissionFixture({ n: 10 });
  const runtime = capture.createRuntime({ ...f.options, purpose: "emission-diagnostic", chainId: 1, backoff: true, fetch: async (_url, init) => {
    const req = JSON.parse(init.body); return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {}, error: { code: -32601, message: SENTINEL } }));
  } });
  try { await assert.rejects(runtime.request(0, "debug_traceTransaction", [PIN.txHash, tracer.EMISSION_TRACE_CONFIG]), /invalid-schema/); }
  finally { await runtime.close(); }
  let attempts = 0;
  const retry = emissionFixture({ hook(c) { if (isJS(c) && c.index === 0 && attempts++ === 0) return { status: 429, raw: SENTINEL }; return { result: c.result }; } }), r = await run(retry);
  assert.equal(r.status, "DIAGNOSTIC-COMPLETE", r.reason); assert.equal(r.backoff.retries, 1); assert.equal(r.budget.traceRequests, 7); assert.equal(r.budget.requests, retry.calls.length);
  for (const limits of [{ requests: 1 }, { traceRequestCap: 1 }]) {
    const capped = emissionFixture({ limits, hook(c) { if (limits.requests || isCall(c)) return { status: 429, raw: SENTINEL }; return { result: c.result }; } }), r = await run(capped);
    assert.equal(r.status, "LIMIT-REACHED", r.reason); assert.equal(r.budget.requests, capped.calls.length); assert.ok(r.budget.traceRequests <= (limits.traceRequestCap || 64));
  }
});
test("fixed loader binds C2/T2/T2D failure provenance and cannot take path/hash/index overrides", () => {
  const f = emissionFixture(), m = { schema: "strategy-study-t2-failure-diagnostic/v1", chainId: 1, status: "CAPTURE-FAILED", reason: "consensus-mismatch",
    aggregateEvidenceStatus: "INVALID", failureStage: "index-domain", diagnosticConstruction: "complete", validAggregate: false,
    sourceC2ManifestSha256: previous.C2_SHA256, universe: f.parent.universe, fixture: PIN, failureProvenance: previous.FAILURE_PROVENANCE,
    integrityFailure: previous.FAILURE_PROVENANCE.failure, diagnostic: { observationId: "obs-02", universeIndex: 9 } };
  function load(manifest = m, digest = collector.T2D_SHA256) {
    return collector.loadEmissionParent({ loadFailureBoundParent: () => f.parent, readFailureFixtureDiagnostic(directory, options, deps) {
      assert.equal(directory, collector.T2D_DIRECTORY); assert.deepEqual(options, { expectedManifestSha256: collector.T2D_SHA256 }); assert.equal(deps.loadFailureBoundParent(), f.parent);
      return { manifest, manifestSha256: digest, authority: { validAggregate: false } };
    } });
  }
  assert.equal(load().universe.length, 111); assert.throws(() => load(m, "0".repeat(64)), /invalid-schema/);
  for (const mutate of [m => { m.status = "DIAGNOSTIC-COMPLETE"; }, m => { m.integrityFailure.universeIndex = 0; }, m => { m.fixture.txHash = H(99); },
    m => { m.failureProvenance.sourceT2ManifestSha256 = "0".repeat(64); }, m => { m.universe.reverse(); }]) { const changed = clone(m); mutate(changed); assert.throws(() => load(changed), /invalid-schema/); }
  for (const key of ["path", "hash", "targetIndex"]) assert.throws(() => collector.loadEmissionParent({ [key]: "override" }), /invalid-schema/);
});
test("success reader recomputes proof and rejects rehashed aliases/maps/gas/frames/source/provenance/count/authority tampering", async () => {
  const f = emissionFixture({ trace: recordedTrace }), p = await published(f);
  try {
    const file = path.join(p.out, "terminalwitness.json"), base = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.throws(() => read(p.out, f, { expectedManifestSha256: "0".repeat(64) }), /invalid-schema/);
    for (const mutate of [m => { m.proof.callObservations.pop(); }, m => { m.proof.callObservations.reverse(); }, m => { m.proof.callObservations[0].observationId = "obs-02"; },
      m => { m.proof.callObservations[0].bindings[1].emissionOrdinal = 1; }, m => { m.proof.callObservations[0].reported = 1; }, m => { m.proof.callObservations[0].candidateDomains = ["LOCAL_DENSE"]; },
      m => { m.proof.witness.rootGasUsed = "1"; }, m => { m.proof.callCore[0].gasUsed = "1"; m.proof.witness.rootGasUsed = "1"; }, m => { m.proof.witness.frames[0].from = B; },
      m => { m.proof.witness.frames[1].failed = false; }, m => { m.proof.witness.emissions[0].position = 1; }, m => { m.proof.callCore[0].logs[0].index = "0"; },
      m => { m.proof.witness.raw = SENTINEL; }, m => { m.source.sourceSha256 = "0".repeat(64); }, m => { m.source.configSha256 = "0".repeat(64); },
      m => { m.provenance.sourceT2DManifestSha256 = "0".repeat(64); }, m => { m.selectedAliases.reverse(); }, m => { m.pairIndependent = false; }, m => { m.counts.completed = 1; },
      m => { m.validAggregate = true; }, m => { m.diagnosticFixtureComplete = false; }, m => { m.transportDiagnostics[0].universeIndex = 0; }]) {
      const m = clone(base); mutate(m); delete m.payloadSha256; m.payloadSha256 = capture.sha256(capture.canonical(m)); fs.writeFileSync(file, JSON.stringify(m));
      assert.throws(() => read(p.out, f), /invalid-schema/);
    }
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
test("failure publication validates its entire fixed schema before serialization and never saves unpaired proof or hidden payload", async () => {
  const f = emissionFixture({ hook(c) { if (isJS(c)) return { error: { code: -32000, message: SENTINEL } }; return { result: c.result }; } }), r = await run(f), root = temp();
  try {
    for (const [i, mutate] of [m => { m.raw = SENTINEL; }, m => { m.proof = { callCore: [], witness: SENTINEL, callObservations: [] }; },
      m => { m.integrityFailure.raw = SENTINEL; }, m => { m.reason = SENTINEL; }, m => { m.source.script = SENTINEL; },
      m => { m.transportDiagnostics[0].url = SENTINEL; }, m => { m.runtimeDrained = false; }, m => { m.toJSON = () => { assert.fail("serialization forbidden"); }; }].entries()) {
      const bad = clone(r), out = path.join(root, String(i)); mutate(bad);
      assert.throws(() => cli.createEmissionWriter(out).publish(bad, f.parent, f.now), /invalid-schema/); assert.deepEqual(fs.readdirSync(out), []);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("first integrity dominates shutdown expiry; late publication clears paired proof instead of advertising success", async () => {
  const f = emissionFixture({ hook(c) { if (isJS(c)) c.result.rootGasUsed = "1"; return { result: c.result }; } }), original = capture.createRuntime;
  capture.createRuntime = options => { const runtime = original(options); return { ...runtime, async close() { await runtime.close(); f.setNow(Date.parse(capture.EXPIRES_AT)); } }; };
  const root = temp();
  try {
    const r = await run(f); assert.equal(r.reason, "binding-mismatch"); assert.equal(r.lifecycleFailure, "session-expired");
    const out = path.join(root, "failed"); cli.createEmissionWriter(out).publish(r, f.parent, f.now); assert.equal(read(out, f).manifest.status, "CAPTURE-FAILED");
  } finally { capture.createRuntime = original; fs.rmSync(root, { recursive: true, force: true }); }
  const good = emissionFixture(), p = await run(good), root2 = temp(), out2 = path.join(root2, "expired");
  try { cli.createEmissionWriter(out2).publish(p, good.parent, () => Date.parse(capture.EXPIRES_AT)); const loaded = read(out2, good); assert.equal(loaded.manifest.proof, null); assert.equal(loaded.manifest.status, "LIMIT-REACHED"); assert.equal(loaded.authority.validAggregate, false); }
  finally { fs.rmSync(root2, { recursive: true, force: true }); }
});
test("CLI checks output/expiry/all parent pins before lazy inventory and drains/disposes before terminal publication", async () => {
  for (const extra of ["--chain=8453", "--script=x", "--index=9", "--tx=x", "--input=x", "--requests=1", "--diagnose-emissions"]) assert.throws(() => cli.parseArgs(["--diagnose-emissions", "--chain=1", "--out=x", extra]), /invalid-options/);
  for (const mode of ["success", "failure", "parent", "expiry", "dispose", "initialize"]) {
    const f = emissionFixture({ hook(c) { if (mode === "failure" && isJS(c)) return { error: { code: -32000, message: SENTINEL } }; return { result: c.result }; } });
    const root = temp(), out = path.join(root, mode), order = [], printed = [];
    try {
      const code = await cli.main(["--diagnose-emissions", "--chain=1", `--out=${out}`], {
        now: mode === "expiry" ? () => Date.parse(capture.EXPIRES_AT) : f.now, print: text => printed.push(text),
        createEmissionWriter(directory) { const writer = cli.createEmissionWriter(directory); order.push("reserve"); return { publish(...args) { assert.equal(order.at(-1), "dispose"); order.push("publish"); return writer.publish(...args); } }; },
        loadEmissionParent() { order.push("parents"); if (mode === "parent") throw new Error("invalid-schema"); return f.parent; },
        loadAuthorizedCandidates() { order.push("inventory"); return { candidates: f.candidates, getOrigin: () => null, dispose() { order.push("dispose"); if (mode === "dispose") throw new Error(SENTINEL); } }; },
        async runEmissionDiagnostic(options) {
          assert.equal(Object.hasOwn(options, "onTrace"), false);
          const result = await collector.runEmissionDiagnostic({ ...options, runtimeOptions: { ...f.options, ...options.runtimeOptions, ...(mode === "initialize" ? { backoffRandom: 1 } : {}) } });
          assert.equal(result.runtimeDrained, true); order.push("drain"); return result;
        },
      });
      assert.equal(code, mode === "success" ? 0 : 2, printed.join(""));
      assert.deepEqual(order, mode === "expiry" ? ["reserve"] : mode === "parent" ? ["reserve", "parents"] : ["reserve", "parents", "inventory", "drain", "dispose", ...(mode === "dispose" ? [] : ["publish"])]);
      assert.ok(!printed.join("").includes(SENTINEL));
      if (["success", "failure", "initialize"].includes(mode)) assert.equal(read(out, f).authority.validAggregate, false); else assert.deepEqual(fs.readdirSync(out), []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
test("reader rejects oversized/unlisted/symlink artifacts and does not trim proof", async t => {
  const f = emissionFixture(), p = await published(f);
  try {
    const file = path.join(p.out, "terminalwitness.json"), bytes = fs.readFileSync(file);
    fs.writeFileSync(path.join(p.out, "orphan.json"), "{}"); assert.throws(() => read(p.out, f), /invalid-schema/); fs.unlinkSync(path.join(p.out, "orphan.json"));
    const fd = fs.openSync(file, "w"); fs.ftruncateSync(fd, cli.MAX_BYTES + 1); fs.closeSync(fd); assert.throws(() => read(p.out, f), /invalid-schema/); fs.writeFileSync(file, bytes);
    const target = path.join(p.root, "target.json"); fs.renameSync(file, target);
    try { fs.symlinkSync(target, file, "file"); } catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return t.skip("Windows symlink permission unavailable"); throw error; }
    assert.throws(() => read(p.out, f), /invalid-schema/);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
test("the exclusive writer fails rather than trimming a valid proof above the16MiB artifact ceiling", async () => {
  const f = emissionFixture(), result = clone(await run(f)), parent = clone(f.parent), root = temp(), out = path.join(root, "too-large");
  const count = 2048, data = `0x${"ab".repeat(4096)}`, template = result.proof.callCore[0].logs[0], receiptLog = parent.views[9].receipt.logs[0];
  result.proof.callCore[0].logs = Array.from({ length: count }, () => ({ ...template, data }));
  parent.views[9].receipt.logs = Array.from({ length: count }, (_, i) => ({ ...receiptLog, logIndex: String(10 + i), data }));
  result.proof.witness = witnessFor(result.proof.callCore);
  result.proof.callObservations = result.observations.map(o => ({ observationId: o.id, candidateDomains: ["LOCAL_DENSE", "RECORDED_EMISSION"],
    totalCommittedLogs: count, reported: count, unreported: 0, bindings: Array.from({ length: count }, (_, i) => ({ frameIndex: 0, logIndex: i,
      receiptOrdinal: i, receiptLogIndex: String(10 + i), observedIndex: String(i), emissionOrdinal: i })) }));
  try {
    assert.throws(() => cli.createEmissionWriter(out).publish(result, parent, f.now), /output-unavailable/);
    assert.deepEqual(fs.readdirSync(out), []); assert.equal(result.proof.callCore[0].logs.length, count);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("full-pool basic null material and well-formed identity RPC unavailability leave an independent complete witness pair", async () => {
  const candidates = ["https://eth-mainnet.g.alchemy.com/offline-a", "https://eth-mainnet.infura.io/offline-a", "https://ethereum.publicnode.com/offline-a",
    "https://eth-mainnet.g.alchemy.com/offline-b", "https://eth-mainnet.infura.io/offline-b", "https://ethereum.publicnode.com/offline-b"];
  const f = emissionFixture({ candidates, hook(c) {
    if ((c.index === 0 && c.method === "eth_getBlockByNumber") || (c.index === 1 && c.method === "eth_getTransactionByHash")
        || (c.index === 2 && c.method === "eth_getTransactionReceipt")) return { result: null };
    if (c.index === 3 && c.method === "eth_chainId") return { error: { code: -32000, message: SENTINEL } };
    return { result: c.result };
  } }), p = await published(f);
  try {
    const r = p.result; assert.equal(r.status, "DIAGNOSTIC-COMPLETE", r.reason); assert.equal(r.integrityFailure, null);
    assert.deepEqual(r.observations.map(o => o.reason), ["fixture-unavailable", "fixture-unavailable", "fixture-unavailable", "provider-rpc-failure", null, null]);
    assert.deepEqual(r.selectedAliases, ["obs-05", "obs-06"]); assert.deepEqual(r.proof.callObservations.map(o => o.observationId), ["obs-05", "obs-06"]);
    assert.equal(r.budget.traceRequests, 4); assert.equal(r.counts.universe, 111); assert.equal(r.counts.completed, 0);
    const firstTrace = f.calls.findIndex(isCall);
    for (let i = 0; i < 6; i++) assert.ok(f.calls.findIndex(c => c.index === i && c.method === "eth_chainId") < firstTrace);
    assert.ok(f.calls.filter(c => c.method === "debug_traceTransaction").every(c => c.index >= 4 && c.u === 9));
    assert.ok(!JSON.stringify(r).includes(SENTINEL)); assert.equal(read(p.out, f).authority.validAggregate, false);
    const file = path.join(p.out, "terminalwitness.json"), original = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const mutate of [m => { m.observations[3].basic = "passed"; }, m => { m.transportDiagnostics.find(e => e.observationId === "obs-04").httpStatus = 201; },
      m => { const e = m.transportDiagnostics.find(e => e.observationId === "obs-04"); e.phase = "emission-tracer"; e.method = "debug_traceTransaction"; e.universeIndex = 9; },
      m => { const e = m.transportDiagnostics.find(e => e.observationId === "obs-04"); e.outcome = "passed"; e.code = null; },
      m => { m.transportDiagnostics = m.transportDiagnostics.filter(e => e.observationId !== "obs-04"); }]) {
      const m = clone(original); mutate(m); delete m.payloadSha256; m.payloadSha256 = capture.sha256(capture.canonical(m)); fs.writeFileSync(file, JSON.stringify(m));
      assert.throws(() => read(p.out, f), /invalid-schema/);
    }
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
test("explicit null at every material basic read is unavailable, but null-ish malformed data and null tracers stay global failures", async () => {
  const predicates = [c => c.method === "eth_getBlockByNumber" && c.params[0] === "finalized",
    c => c.method === "eth_getBlockByHash" && c.params[0] === H(1001), c => c.method === "eth_getBlockByNumber" && c.params[0] === Q(109),
    c => c.method === "eth_getBlockByHash" && c.params[0] === H(109), c => c.method === "eth_getTransactionByHash", c => c.method === "eth_getTransactionReceipt"];
  for (const matches of predicates) {
    const f = emissionFixture({ n: 10, hook(c) { return c.index === 0 && matches(c) ? { result: null } : { result: c.result }; } }), r = await run(f);
    assert.equal(r.status, "DIAGNOSTIC-COMPLETE", r.reason); assert.equal(r.observations[0].reason, "fixture-unavailable");
    cli.validateEmissionDiagnostic(r, f.parent); assert.deepEqual(r.selectedAliases, ["obs-02", "obs-03"]);
  }
  for (const method of ["eth_getBlockByNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt"]) {
    for (const value of [undefined, {}, false, [], { hash: null }]) {
      const f = emissionFixture({ n: 10, hook(c) { return c.index === 0 && c.method === method ? { result: value } : { result: c.result }; } }), r = await run(f);
      assert.equal(r.status, "CAPTURE-FAILED", `${method}/${String(value)}`); assert.notEqual(r.reason, "fixture-unavailable");
      assert.equal(r.observations[0].reason, null); assert.equal(r.proof, null);
    }
  }
  for (const matches of [c => c.method === "eth_chainId", isCall, isJS]) {
    const f = emissionFixture({ n: 10, hook(c) { return c.index === 0 && matches(c) ? { result: null } : { result: c.result }; } }), r = await run(f);
    assert.equal(r.status, "CAPTURE-FAILED"); assert.notEqual(r.reason, "fixture-unavailable"); assert.equal(r.observations[0].reason, null);
  }
});
test("valid generic RPC errors are retirable only for initial chain identity, never material reads or either tracer", async () => {
  for (const matches of [c => c.method === "eth_getBlockByNumber", c => c.method === "eth_getTransactionByHash", c => c.method === "eth_getTransactionReceipt", isCall, isJS]) {
    const f = emissionFixture({ n: 10, hook(c) {
      return c.index === 0 && matches(c) ? { error: { code: -32000, message: `unsupported ${SENTINEL}` } } : { result: c.result };
    } }), r = await run(f);
    assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.reason, "provider-rpc-failure"); assert.equal(r.observations[0].reason, null);
    assert.equal(r.integrityFailure.observationId, "obs-01"); assert.equal(r.integrityFailure.category, "ambiguous-provider-failure");
    cli.validateEmissionDiagnostic(r, f.parent);
  }
});
test("only initial HTTP200 malformed envelopes fail admission; full pool and two independent witnesses survive with original diagnostics", async () => {
  assert.equal(collector.RETIRABLE.includes("identity-unqualified"), false);
  assert.equal(capture.safeCode(new Error("identity-unqualified")), "capture-failed");
  for (const mode of ["error-plus-result", "bad-code", "bad-message", "wrong-id", "wrong-version", "array-error", "missing-result", "null-envelope"]) {
    const f = emissionFixture();
    replaceResponse(f, firstIdentity, req => {
      const body = { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: SENTINEL } };
      if (mode === "error-plus-result") body.result = "0x1";
      if (mode === "bad-code") body.error.code = "-32000";
      if (mode === "bad-message") body.error.message = null;
      if (mode === "wrong-id") body.id++;
      if (mode === "wrong-version") body.jsonrpc = "1.0";
      if (mode === "array-error") body.error = [];
      if (mode === "missing-result") delete body.error;
      return new Response(JSON.stringify(mode === "null-envelope" ? null : body));
    });
    const p = await published(f);
    try {
      const r = p.result; assert.equal(r.status, "DIAGNOSTIC-COMPLETE", mode); assert.equal(r.integrityFailure, null);
      assert.deepEqual(r.observations[0], { id: "obs-01", basic: "not-tested", call: "not-tested", witness: "not-tested", complete: false, reason: "identity-unqualified" });
      assert.deepEqual(r.selectedAliases, ["obs-02", "obs-03"]); assert.equal(r.pairIndependent, true);
      assert.ok(r.observations.slice(1).every(o => o.complete)); assert.deepEqual(r.proof.callObservations.map(o => o.observationId), ["obs-02", "obs-03"]);
      assert.deepEqual(f.actualCalls.filter(c => c.index === 0).map(c => [c.method, c.params]), [["eth_chainId", []]]);
      const events = r.transportDiagnostics.filter(e => e.observationId === "obs-01"); assert.equal(events.length, 1);
      assert.deepEqual(events[0], { observationId: "obs-01", requestId: 1, method: "eth_chainId", httpStatus: 200, rpcErrorCode: null,
        outcome: "failed", code: "invalid-schema", restriction: "unknown", attempt: 1, phase: "chain-id", universeIndex: null });
      const firstTrace = f.actualCalls.findIndex(isCall);
      for (let i = 0; i < 3; i++) assert.ok(f.actualCalls.findIndex(c => c.index === i && c.method === "eth_chainId") < firstTrace);
      for (let i = 1; i < 3; i++) assert.ok(f.actualCalls.findIndex(c => c.index === i && c.method === "eth_getTransactionReceipt") < firstTrace);
      assert.equal(r.budget.requests, f.actualCalls.length); assert.equal(r.budget.traceRequests, 4); assert.equal(r.budget.logRequests, 0);
      assert.equal(r.aggregateEvidenceStatus, "NON-AUTHORITATIVE"); assert.equal(r.counts.completed, 0); assert.equal(r.counts.universe, 111);
      assert.equal(read(p.out, f, { expectedManifestSha256: p.summary.manifestSha256 }).authority.validAggregate, false);
      assert.ok(!fs.readFileSync(path.join(p.out, "terminalwitness.json"), "utf8").includes(SENTINEL));
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});
test("successful malformed or null identity results, invalid JSON and non200 failures do not acquire the admission exception", async () => {
  for (const value of [null, {}, [], false, 1, "", "1", "0x", "0xzz"]) {
    const f = emissionFixture({ n: 10, hook(c) { return firstIdentity(c) ? { result: value } : { result: c.result }; } }), r = await run(f);
    assert.equal(r.reason, "invalid-schema"); assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.observations[0].reason, null);
    assert.equal(r.transportDiagnostics[0].outcome, "passed"); assert.equal(r.budget.requests, 1); cli.validateEmissionDiagnostic(r, f.parent);
  }
  for (const mode of ["invalid-json", "http400", "http500", "http201", "http401", "http403", "wrong-chain"]) {
    const f = emissionFixture({ n: 10 });
    replaceResponse(f, firstIdentity, req => new Response(mode === "invalid-json" ? SENTINEL : JSON.stringify(mode === "wrong-chain"
      ? { jsonrpc: "2.0", id: req.id, result: "0x2" } : { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: SENTINEL } }),
    { status: mode.startsWith("http") ? Number(mode.slice(4)) : 200 }));
    const r = await run(f), available = ["http401", "http403", "wrong-chain"].includes(mode);
    assert.equal(r.status, available ? "DIAGNOSTIC-COMPLETE" : "CAPTURE-FAILED", mode);
    assert.equal(r.observations[0].reason, available ? mode === "wrong-chain" ? "wrong-chain" : "provider-http-failure" : null);
    if (!available) { assert.equal(r.integrityFailure.phase, "chain-id"); assert.equal(r.budget.requests, 1); }
    if (mode === "invalid-json") assert.equal(r.reason, "provider-json-failure");
    assert.ok(!JSON.stringify(r).includes(SENTINEL)); cli.validateEmissionDiagnostic(r, f.parent);
  }
});
test("valid identity is irrevocable before the first header; postidentity malformed envelopes or results remain fatal", async () => {
  for (const matches of [c => c.method === "eth_getBlockByNumber", isCall, isJS]) {
    for (const envelope of [false, true]) {
      const f = emissionFixture({ n: 10, hook(c) { return !envelope && c.index === 0 && matches(c) ? { result: {} } : { result: c.result }; } });
      if (envelope) replaceResponse(f, c => c.index === 0 && matches(c), malformedEnvelope);
      const r = await run(f); assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.observations[0].reason, null); assert.equal(r.proof, null);
      assert.equal(r.transportDiagnostics[0].outcome, "passed");
      assert.equal(r.integrityFailure.phase, matches({ method: "eth_getBlockByNumber" }) ? "finalized-header" : matches({ method: "debug_traceTransaction", params: [null, capture.CALL_CONFIG] }) ? "call-tracer" : "emission-tracer");
      if (envelope) assert.equal(r.reason, "invalid-schema"); cli.validateEmissionDiagnostic(r, f.parent);
    }
  }
});
test("admission permits only existing consecutive 429 attempts with unchanged identity params", async () => {
  for (const retries of [1, 2]) {
    const f = emissionFixture({ n: 10 }); let attempts = 0;
    replaceResponse(f, firstIdentity, req => attempts++ < retries ? new Response(SENTINEL, { status: 429 }) : malformedEnvelope(req));
    const p = await published(f);
    try {
      const r = p.result, history = r.transportDiagnostics.filter(e => e.observationId === "obs-01");
      assert.equal(r.status, "DIAGNOSTIC-COMPLETE"); assert.equal(r.observations[0].reason, "identity-unqualified");
      assert.deepEqual(history.map(e => e.attempt), Array.from({ length: retries + 1 }, (_, n) => n + 1));
      assert.ok(history.slice(0, -1).every(e => e.httpStatus === 429 && e.code === "provider-http-failure" && e.outcome === "failed"));
      assert.equal(history.at(-1).code, "invalid-schema"); assert.equal(r.backoff.retries, retries); assert.equal(r.budget.requests, f.actualCalls.length);
      assert.deepEqual(f.actualCalls.filter(c => c.index === 0).map(c => [c.method, c.params]), Array.from({ length: retries + 1 }, () => ["eth_chainId", []]));
      assert.equal(read(p.out, f).manifest.status, "DIAGNOSTIC-COMPLETE");
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});
test("collector refuses admission when recorded identity attempts contain earlier success, non429 failure or skipped attempts", async () => {
  const original = capture.createRuntime;
  for (const mode of ["passed", "schema", "http403", "rpc-code", "attempt-skip", "attempt-reset", "request-order"]) {
    const f = emissionFixture({ n: 10 }); let attempts = 0;
    replaceResponse(f, firstIdentity, req => attempts++ === 0 ? new Response(SENTINEL, { status: 429 }) : malformedEnvelope(req));
    capture.createRuntime = options => original({ ...options, onTransportDiagnostic(event) {
      const e = { ...event };
      if (e.attempt === 1) {
        if (mode === "passed") { e.outcome = "passed"; e.code = null; e.httpStatus = 200; }
        if (mode === "schema") { e.code = "invalid-schema"; e.httpStatus = 200; }
        if (mode === "http403") e.httpStatus = 403;
        if (mode === "rpc-code") e.code = "provider-rpc-failure";
        if (mode === "attempt-skip") e.attempt = 2;
      } else {
        if (mode === "attempt-reset") e.attempt = 1;
        if (mode === "request-order") e.requestId = 1;
      }
      options.onTransportDiagnostic(e);
    } });
    try {
      const r = await run(f); assert.equal(r.status, "CAPTURE-FAILED", mode); assert.equal(r.reason, "invalid-schema");
      assert.equal(r.observations[0].reason, null); assert.equal(r.budget.requests, 2); assert.equal(r.budget.traceRequests, 0);
    } finally { capture.createRuntime = original; }
  }
});
test("matching transport evidence cannot retire internal, options, callback or global-budget failures", async () => {
  const original = capture.createRuntime;
  for (const mode of ["internal", "options", "callback", "async-callback", "expiry", "duration", ...collector.GLOBAL_LIMITS]) {
    const f = emissionFixture({ n: 10 }); replaceResponse(f, firstIdentity, malformedEnvelope);
    const expected = mode === "options" ? "invalid-options" : mode === "expiry" ? "session-expired"
      : mode === "duration" ? "total-time-budget-exhausted" : collector.GLOBAL_LIMITS.has(mode) ? mode : "capture-failed";
    capture.createRuntime = options => {
      const runtime = original({ ...options, onTransportDiagnostic(event) {
        options.onTransportDiagnostic(event);
        if (mode === "callback") throw new Error("invalid-schema");
        if (mode === "async-callback") return Promise.reject(new Error(SENTINEL));
        if (mode === "expiry") f.setNow(Date.parse(capture.EXPIRES_AT));
        if (mode === "duration") f.setNow(f.now() + capture.EMISSION_DIAGNOSTIC_LIMITS.totalTimeoutMs);
      } });
      if (["callback", "async-callback", "expiry", "duration"].includes(mode)) return runtime;
      return { ...runtime, async request(...args) {
        try { return await runtime.request(...args); } catch (_) { throw new Error(mode === "internal" ? SENTINEL : expected); }
      } };
    };
    try {
      const r = await run(f); assert.equal(r.reason, expected, mode); assert.equal(r.observations[0].reason, null);
      assert.equal(r.transportDiagnostics[0].code, "invalid-schema"); assert.equal(r.transportDiagnostics[0].httpStatus, 200);
      assert.equal(r.budget.requests, 1); assert.equal(r.proof, null); assert.ok(!JSON.stringify(r).includes(SENTINEL)); cli.validateEmissionDiagnostic(r, f.parent);
    } finally { capture.createRuntime = original; }
  }
});
test("physical request and byte exhaustion on the malformed first attempt remain global limits", async () => {
  for (const limits of [{ requests: 1 }, { responseBytes: 1 }, { totalResponseBytes: 1 }]) {
    const f = emissionFixture({ n: 10, limits }); replaceResponse(f, firstIdentity, malformedEnvelope);
    const r = await run(f); assert.equal(r.status, "LIMIT-REACHED"); assert.equal(r.reason, limits.requests ? "request-budget-exhausted" : "response-budget-exceeded");
    assert.equal(r.observations[0].reason, null); assert.equal(r.integrityFailure, null); assert.equal(r.budget.requests, 1);
    if (limits.requests) assert.equal(r.transportDiagnostics[0].code, "invalid-schema");
    cli.validateEmissionDiagnostic(r, f.parent);
  }
});
test("admission retirement never substitutes for independent families or two complete witnesses", async () => {
  for (const singleFamily of [false, true]) {
    const f = emissionFixture({ n: 10, ...(singleFamily ? { candidates: ["https://eth-mainnet.g.alchemy.com/offline", "https://eth-mainnet.infura.io/offline-a", "https://eth-mainnet.infura.io/offline-b"] } : {}),
      hook(c) { return !singleFamily && c.index === 2 && isJS(c) ? { error: { code: -32601, message: SENTINEL } } : { result: c.result }; } });
    replaceResponse(f, firstIdentity, malformedEnvelope); const p = await published(f);
    try {
      const r = p.result; assert.equal(r.observations[0].reason, "identity-unqualified"); assert.equal(r.status, "ACCESS-BLOCKED");
      assert.equal(r.reason, "independent-pair-unavailable"); assert.equal(r.proof, null); assert.deepEqual(r.selectedAliases, []);
      assert.equal(r.diagnosticFixtureComplete, false); if (singleFamily) assert.equal(r.budget.traceRequests, 0);
      assert.equal(read(p.out, f).authority.validAggregate, false);
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
  const f = emissionFixture({ n: 10, hook(c) {
    if (c.index === 1 && c.method === "eth_getBlockByNumber") c.result.stateRoot = H(999);
    return { result: c.result };
  } });
  replaceResponse(f, firstIdentity, malformedEnvelope);
  const r = await run(f); assert.equal(r.observations[0].reason, "identity-unqualified"); assert.equal(r.reason, "consensus-mismatch");
  assert.equal(r.integrityFailure.observationId, "obs-02"); assert.equal(r.budget.traceRequests, 0);
  assert.equal(f.actualCalls.some(c => c.index === 2), false); cli.validateEmissionDiagnostic(r, f.parent);
});
test("reader rejects rehashed admission state, terminal evidence and retry-history forgeries; terminal is request-ID ordered", async () => {
  const f = emissionFixture({ n: 10 }); let attempts = 0;
  replaceResponse(f, firstIdentity, req => attempts++ === 0 ? new Response(SENTINEL, { status: 429 }) : malformedEnvelope(req));
  const p = await published(f);
  try {
    const file = path.join(p.out, "terminalwitness.json"), base = JSON.parse(fs.readFileSync(file, "utf8"));
    const history = m => m.transportDiagnostics.filter(e => e.observationId === "obs-01").sort((a, b) => a.requestId - b.requestId);
    const first = m => history(m)[0], terminal = m => history(m).at(-1);
    const mutations = [
      ...["basic", "call", "witness"].map(key => m => { m.observations[0][key] = "passed"; }), m => { m.observations[0].complete = true; },
      m => { m.reason = "identity-unqualified"; m.status = "ACCESS-BLOCKED"; m.proof = null; m.diagnosticFixtureComplete = false; },
      m => { m.selectedAliases = ["obs-01", "obs-02"]; }, m => { m.selectedAliases = []; m.pairIndependent = false; },
      m => { m.proof.callObservations.pop(); }, m => { m.pairIndependent = false; },
      m => { m.transportDiagnostics = m.transportDiagnostics.filter(e => e.observationId !== "obs-01"); },
      m => { m.transportDiagnostics = m.transportDiagnostics.filter(e => e !== terminal(m)); },
      ...["phase", "method", "httpStatus", "rpcErrorCode", "code", "outcome", "attempt", "requestId"].map(key => m => { delete terminal(m)[key]; }),
      m => { terminal(m).code = "provider-json-failure"; }, m => { terminal(m).code = "identity-unqualified"; },
      m => { terminal(m).rpcErrorCode = -32000; }, m => { terminal(m).httpStatus = 201; }, m => { terminal(m).httpStatus = null; },
      m => { terminal(m).outcome = "passed"; terminal(m).code = null; },
      m => { terminal(m).phase = "finalized-header"; terminal(m).method = "eth_getBlockByNumber"; },
      m => { terminal(m).method = "debug_traceTransaction"; terminal(m).phase = "emission-tracer"; terminal(m).universeIndex = 9; m.budget.traceRequests++; },
      m => { first(m).httpStatus = 200; first(m).code = "invalid-schema"; }, m => { first(m).httpStatus = 403; },
      m => { first(m).code = "provider-rpc-failure"; }, m => { first(m).outcome = "passed"; first(m).code = null; first(m).httpStatus = 200; },
      m => { first(m).attempt = 2; }, m => { terminal(m).attempt = 1; }, m => { terminal(m).attempt = 3; }, m => { terminal(m).attempt = 4; },
      m => { const [a, b] = history(m); [a.requestId, b.requestId] = [b.requestId, a.requestId]; },
      ...["eth_getBlockByNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt", "debug_traceTransaction"].map(method => m => {
        const e = first(m); e.method = method; e.phase = { eth_getBlockByNumber: "historical-header", eth_getTransactionByHash: "transaction-read",
          eth_getTransactionReceipt: "receipt-read", debug_traceTransaction: "call-tracer" }[method]; e.universeIndex = 9;
        if (method === "debug_traceTransaction") m.budget.traceRequests++;
      }),
    ];
    for (const [i, mutate] of mutations.entries()) {
      const m = clone(base); mutate(m); rehash(file, m); assert.throws(() => read(p.out, f), /invalid-schema/, `forgery ${i}`);
    }
    const reordered = clone(base); reordered.transportDiagnostics.reverse(); rehash(file, reordered);
    assert.equal(read(p.out, f).manifest.observations[0].reason, "identity-unqualified");
    // A payload hash is not provenance for a wholly rewritten history.
    assert.throws(() => read(p.out, f, { expectedManifestSha256: p.summary.manifestSha256 }), /invalid-schema/);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
test("post-trace null retirement retains all prior core/witness/index facts, including contradictions which veto later complete candidates", async () => {
  for (const mode of ["receipt-null", "numbered-header-null", "hashed-header-null", "core-veto", "witness-veto", "index-veto"]) {
    const f = emissionFixture({ hook(c) {
      if (c.index === 0 && isCall(c)) {
        if (mode === "core-veto") c.result.gas = "0x5209";
        if (mode === "index-veto") c.result.logs[1].index = "0x7";
      }
      if (c.index === 0 && isJS(c) && mode === "witness-veto") c.result.emissions[0].pc++;
      const afterJS = c.fixture.calls.some(previous => previous.index === 0 && isJS(previous));
      const method = mode === "numbered-header-null" ? "eth_getBlockByNumber" : mode === "hashed-header-null" ? "eth_getBlockByHash" : "eth_getTransactionReceipt";
      if (c.index === 0 && afterJS && c.method === method) return { result: null };
      return { result: c.result };
    } }), p = await published(f);
    try {
      const r = p.result; assert.equal(r.observations[0].reason, "fixture-unavailable"); assert.equal(r.observations[0].call, "passed"); assert.equal(r.observations[0].witness, "passed");
      if (mode.endsWith("veto")) { assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.proof, null); }
      else {
        assert.equal(r.status, "DIAGNOSTIC-COMPLETE", r.reason); assert.deepEqual(r.selectedAliases, ["obs-02", "obs-03"]);
        assert.deepEqual(r.proof.callObservations.map(o => o.observationId), ["obs-01", "obs-02", "obs-03"]);
      }
      if (mode === "index-veto") { assert.equal(r.integrityFailure.phase, "index-domain"); assert.equal(r.integrityFailure.observationId, "obs-01"); }
      assert.equal(read(p.out, f).authority.validAggregate, false);
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
  const f = emissionFixture({ hook(c) {
    if (c.index === 0 && c.method === "eth_getTransactionByHash") return { result: null };
    if (c.index === 1 && c.method === "eth_getBlockByNumber" && c.params[0] === "finalized") c.result.stateRoot = H(999);
    return { result: c.result };
  } }), r = await run(f);
  assert.equal(r.observations[0].reason, "fixture-unavailable"); assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.reason, "consensus-mismatch");
  assert.equal(r.integrityFailure.observationId, "obs-02"); assert.equal(r.budget.traceRequests, 0);
});
test("reader rejects forged retirement around a JS error or null tracer even when qualification flags and payload hashes are rewritten", async () => {
  for (const rawNull of [false, true]) {
    const f = emissionFixture({ hook(c) {
      if (c.index === 0 && isJS(c)) return rawNull ? { result: null } : { error: { code: -32000, message: SENTINEL } };
      return { result: c.result };
    } }), p = await published(f);
    try {
      const file = path.join(p.out, "terminalwitness.json"), original = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const hidePassed of [false, true]) {
        const m = clone(original); m.integrityFailure = null; m.status = "ACCESS-BLOCKED"; m.reason = "independent-pair-unavailable"; m.aggregateEvidenceStatus = "NON-AUTHORITATIVE";
        m.observations[0].reason = rawNull ? "fixture-unavailable" : "provider-rpc-failure";
        if (hidePassed) { m.observations[0].basic = "not-tested"; m.observations[0].call = "not-tested"; }
        if (!rawNull && hidePassed) {
          // A forged earlier identity failure cannot excuse later trace traffic.
          const first = m.transportDiagnostics[0]; first.outcome = "failed"; first.code = "provider-rpc-failure"; first.rpcErrorCode = -32000;
        }
        delete m.payloadSha256; m.payloadSha256 = capture.sha256(capture.canonical(m)); fs.writeFileSync(file, JSON.stringify(m));
        assert.throws(() => read(p.out, f), /invalid-schema/);
      }
      for (const forgeTerminal of [false, true]) {
        const m = clone(original); m.integrityFailure = null; m.status = "ACCESS-BLOCKED"; m.reason = "independent-pair-unavailable"; m.aggregateEvidenceStatus = "NON-AUTHORITATIVE";
        Object.assign(m.observations[0], { basic: "not-tested", call: "not-tested", witness: "not-tested", complete: false, reason: "identity-unqualified" });
        const events = m.transportDiagnostics.filter(e => e.observationId === "obs-01"), event = forgeTerminal ? events.at(-1) : events[0];
        Object.assign(event, { phase: "chain-id", method: "eth_chainId", outcome: "failed", code: "invalid-schema", httpStatus: 200, rpcErrorCode: null, universeIndex: null, attempt: 1 });
        rehash(file, m); assert.throws(() => read(p.out, f), /invalid-schema/);
        if (forgeTerminal) {
          // Resetting flags and erasing material rows still cannot hide a prior
          // passed identity operation behind a new terminal identity failure.
          m.transportDiagnostics = [events[0], event]; event.attempt = 2;
          rehash(file, m); assert.throws(() => read(p.out, f), /invalid-schema/);
        }
      }
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});
