"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const capture = require("../strategy-study/capture"), classifier = require("../strategy-study/rpc-envelope-diagnostic"), admission = require("../strategy-study/compound-b-metadata-admission");
const metadata = require("../strategy-study/compound-b-metadata"), cli = require("../strategy-study/compound-b-metadata-cli");
const START = Date.parse("2026-10-21T02:30:00Z"), stamp = ms => new Date(ms).toISOString(), PRIVATE = "PRIVATE_B3M_SENTINEL", clone = v => JSON.parse(JSON.stringify(v));
const uncorrelated = () => ({ jsonrpc: "2.0", id: null, error: { code: -32601, message: PRIVATE, data: { [PRIVATE]: PRIVATE } } });
const urls = ["https://eth-mainnet.g.alchemy.com/offline-b3m", "https://eth-mainnet.infura.io/offline-b3m"];
function fixture(response = () => ({ body: uncorrelated() }), extra = {}) {
  let time = START; const calls = [], events = [];
  const f = { calls, events, now: () => time, setNow: n => { time = n; } };
  f.options = { chainId: 1, purpose: admission.PURPOSE, candidates: urls, shared: { getOrigin: () => null }, backoff: true, now: f.now, sleep: async ms => { time += ms; }, backoffRandom: () => 0,
    onTransportDiagnostic: e => events.push(e), fetch: async (url, init) => { const req = JSON.parse(init.body); calls.push(req); const r = await response(req, f); return new Response(r.raw ?? JSON.stringify(r.body), { status: r.status || 200, headers: r.headers }); }, ...extra };
  return f;
}
async function withRuntime(f, fn) { const r = capture.createRuntime(f.options); try { return await fn(r); } finally { await r.close(); assert.deepEqual(r.lifecycle(), { closed: true, pending: 0 }); } }
function operation(raw = uncorrelated()) {
  const bytes = Buffer.from(JSON.stringify(raw)), shape = classifier.classifyEnvelope(bytes, 1);
  return { observationId: "obs-01", phase: "chain", method: "eth_chainId", params: [], response: "transport", factRefs: [], validationFailure: null, code: "invalid-schema",
    startedAt: stamp(START), endedAt: stamp(START), admissionReason: null,
    transport: [{ observationId: "obs-01", requestId: 1, method: "eth_chainId", attempt: 1, outcome: "failed", code: "invalid-schema", httpStatus: 200, rpcErrorCode: null, restriction: "unknown",
      responseBytes: bytes.length, startedAt: stamp(START), endedAt: stamp(START), admissionEnvelope: { observationId: "obs-01", requestId: 1, shape } }] };
}
test("B3M predicate requires every conjunct, not merely invalid-id category", () => {
  const accepts = (op, prior = [], caps = metadata.LIMITS) => admission.admissionReason(op, prior, caps, stamp(START));
  assert.equal(accepts(operation()), admission.REASON);
  const changes = [r => { delete r.id; }, r => { r.id = 2; }, r => { r.id = "1"; }, r => { r.id = 1; }, r => { r.result = "0x1"; },
    r => { r.result = null; }, r => { delete r.jsonrpc; }, r => { r.jsonrpc = 2; }, r => { r.jsonrpc = "1.0"; }, r => { r[PRIVATE] = PRIVATE; },
    r => { delete r.error; }, r => { r.error = null; }, r => { r.error = []; }, r => { r.error[PRIVATE] = PRIVATE; }, r => { delete r.error.code; },
    r => { r.error.code = "-32601"; }, r => { r.error.code = 1.5; }, r => { r.error.code = 12345; }, r => { delete r.error.message; },
    r => { r.error.message = {}; }, r => { r.error.message = PRIVATE.repeat(300); }];
  for (const change of changes) { const raw = uncorrelated(); change(raw); assert.equal(accepts(operation(raw)), null); }
  const hidden = operation({ ...uncorrelated(), result: "0x1" }); assert.equal(hidden.transport[0].admissionEnvelope.shape.category, "invalid-id"); assert.equal(accepts(hidden), null);
  for (const change of [o => { o.method = "eth_getBlockByHash"; }, o => { o.phase = "parent"; }, o => { o.params = ["0x1"]; }, o => { o.response = "result"; },
    o => { o.factRefs = ["accepted-chain-fact"]; }, o => { o.validationFailure = { stage: "chain", index: null }; }, o => { o.code = "capture-failed"; },
    o => { o.code = "invalid-options"; }, o => { o.code = "session-expired"; }, o => { o.code = "request-budget-exhausted"; }, o => { o.code = "response-budget-exceeded"; },
    o => { o.transport[0].code = "capture-failed"; }, o => { o.transport[0].outcome = "passed"; }, o => { o.transport[0].httpStatus = 401; },
    o => { o.transport[0].admissionEnvelope.requestId = 2; }, o => { o.transport[0].admissionEnvelope.observationId = "obs-02"; },
    o => { o.transport[0].responseBytes = 0; }, o => { o.transport[0].admissionEnvelope = null; }, o => { o.transport[0].responseBytes = admission.MAX_BYTES + 1; },
    o => { o.transport[0].attempt = 2; }, o => { o.transport[0].method = "eth_getBlockByNumber"; }, o => { o.transport[0].observationId = "obs-02"; },
    o => { o.transport[0].rpcErrorCode = -32601; }, o => { o.endedAt = stamp(Date.parse(metadata.EXPIRES_AT)); }]) {
    const op = operation(); change(op); assert.equal(accepts(op), null);
  }
  for (const prior of [{ observationId: "obs-01", factRefs: [], response: "transport" }, { observationId: "obs-01", factRefs: ["chain"], response: "result" },
    { observationId: "obs-01", method: "eth_getBlockByHash", factRefs: [] }]) assert.equal(accepts(operation(), [prior]), null);
  for (const caps of [{ ...metadata.LIMITS, requests: 1 }, { ...metadata.LIMITS, totalResponseBytes: 1 }, { ...metadata.LIMITS, responseBytes: 1 }]) assert.equal(accepts(operation(), [], caps), null);
  const retried = operation(), terminal = retried.transport[0]; terminal.requestId = 2; terminal.attempt = 2; terminal.admissionEnvelope.requestId = 2;
  retried.transport.unshift({ ...clone(terminal), requestId: 1, attempt: 1, httpStatus: 429, code: "provider-http-failure", admissionEnvelope: null });
  assert.equal(accepts(retried), admission.REASON); retried.transport[0].httpStatus = 500; assert.equal(accepts(retried), null);
});
test("B3M runtime unchanged metadata caps/targets; flags only on initial chain operation and never full bodies", async () => {
  const f = fixture((req) => ({ body: req.method === "eth_chainId" ? { jsonrpc: "2.0", id: req.id, result: "0x1" } : { jsonrpc: "2.0", id: req.id, result: { public: "x".repeat(admission.MAX_BYTES + 1) } } }));
  await withRuntime(f, async r => {
    assert.deepEqual(r.limits, metadata.LIMITS); assert.equal(r.timing().expiresAt, metadata.EXPIRES_AT);
    for (const method of ["eth_call", "eth_getLogs", "eth_getTransactionByHash", "eth_getTransactionReceipt", "debug_traceTransaction", "eth_sendRawTransaction"]) await assert.rejects(r.request(0, method, []), /rpc-method-not-read-only-allowlisted/);
    let invoked = 0; const params = []; Object.defineProperty(params, "toJSON", { get() { invoked++; } }); await assert.rejects(r.request(0, "eth_chainId", params), /invalid-options/); assert.equal(invoked, 0);
    await assert.rejects(r.request(0, "eth_getBlockByNumber", ["latest", false]), /invalid-options/);
    await assert.rejects(r.request(0, "eth_chainId", [], "extra"), /invalid-options/);
    const mutable = [], pending = r.request(0, "eth_chainId", mutable); mutable.push("changed"); assert.equal(await pending, "0x1");
    await r.request(0, "eth_getBlockByHash", [metadata.ANCHORS[1].hash, true]); await r.request(0, "eth_chainId", []);
  });
  assert.equal(f.events[0].admissionEnvelope.shape.ethereumChainMatch, true); assert.equal(f.events[0].admissionEnvelope.requestId, 1);
  for (const event of f.events.slice(1)) assert.equal(Object.hasOwn(event, "admissionEnvelope"), false);
  assert.ok(!JSON.stringify(f.events).includes("public"));
  for (const options of [{ backoff: false }, { chainId: 8453 }, { candidates: undefined }, { expiresAt: "2030" }, { limits: { requests: 301 } }, { limits: { traceRequestCap: 1 } }, { limits: { spacingMs: 999 } }])
    assert.throws(() => capture.createRuntime({ ...f.options, ...options }), /invalid-options/);
});
test("malformed response is not retried; only preceding trusted 429s may lead to admission", async () => {
  const f = fixture(req => req.id === 1 ? { status: 429, raw: PRIVATE, headers: { "retry-after": "3" } } : { body: uncorrelated() });
  await withRuntime(f, async r => { await assert.rejects(r.request(0, "eth_chainId", []), /invalid-schema/); assert.equal(r.backoffSnapshot().retries, 1); });
  assert.equal(f.calls.length, 2); assert.equal(Date.parse(f.events[1].startedAt) - Date.parse(f.events[0].startedAt), 3000);
  const op = operation(); op.transport = clone(f.events); op.endedAt = f.events.at(-1).endedAt;
  assert.equal(admission.admissionReason(op, [], metadata.LIMITS, stamp(START)), admission.REASON); assert.ok(!JSON.stringify(f.events).includes(PRIVATE));
});
test("callback/options/expiry/elapsed/byte/request failures cannot be concealed as admission", async () => {
  for (const mode of ["callback", "request", "byte", "expiry", "elapsed", "classifier-bound"]) {
    const f = fixture((_, f) => { if (mode === "expiry") f.setNow(Date.parse(metadata.EXPIRES_AT)); if (mode === "elapsed") f.setNow(START + 600000);
      return mode === "classifier-bound" ? { raw: JSON.stringify({ ...uncorrelated(), padding: "x".repeat(admission.MAX_BYTES) }) } : { body: uncorrelated() }; },
    mode === "request" ? { limits: { requests: 1 } } : mode === "byte" ? { limits: { totalResponseBytes: 1 } } : {});
    if (mode === "callback") f.options.onTransportDiagnostic = e => { f.events.push(e); throw new Error(PRIVATE); };
    let code; await withRuntime(f, async r => { try { await r.request(0, "eth_chainId", []); } catch (e) { code = e.message; } });
    const op = operation(); op.code = code; op.transport = clone(f.events); op.endedAt = f.events.at(-1)?.endedAt || stamp(START);
    assert.equal(admission.admissionReason(op, [], { ...metadata.LIMITS, ...f.options.limits }, stamp(START)), null, mode);
    if (mode === "classifier-bound") { assert.equal(code, "invalid-schema"); assert.equal(f.events[0].admissionEnvelope, null); }
    if (mode === "callback") assert.equal(code, "capture-failed");
  }
});
test("original B2M and B2D strict readers retain exact consumed outcomes and hashes", () => {
  const snapshotB3M = () => {
    const file = path.join(cli.B3M_OUTPUT, cli.FILE);
    return { listing: fs.existsSync(cli.B3M_OUTPUT) ? fs.readdirSync(cli.B3M_OUTPUT).sort() : null,
      artifactSha256: fs.existsSync(file) ? capture.sha256(fs.readFileSync(file)) : null };
  }, before = snapshotB3M();
  try {
    if (before.artifactSha256 !== null) assert.equal(before.artifactSha256, "64ea5dde6ef661e1e17ca4ad0960e5f1b3e9f69614979ad382a19c4d11cc77cb");
    const b2m = cli.readCompoundBMetadata(cli.OUTPUT, { expectedManifestSha256: "6476d060b6325ab15963717e4bf48b041af175c08b56f172c362b23984883b24" });
    assert.equal(b2m.manifest.schema, metadata.SCHEMA); assert.equal(b2m.manifest.status, "FAILED"); assert.equal(b2m.prefix, null);
    const d = require("../strategy-study/compound-b-envelope-diagnostic"), b2d = d.readEnvelopeDiagnostic(d.OUTPUT, { expectedManifestSha256: "f7ae5359362a070713d0a9f05a0cfedecd8b3ee09e4891e6967d13fb786b3a72" });
    assert.equal(b2d.manifest.diagCollectionComplete, true); assert.equal(b2d.authority.qualifiedMetadata, false);
  } finally { assert.deepEqual(snapshotB3M(), before, "B3M output listing and artifact hash must remain unchanged"); }
});
