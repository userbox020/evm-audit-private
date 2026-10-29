"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const capture = require("../strategy-study/capture"), classifier = require("../strategy-study/rpc-envelope-diagnostic"), diagnostic = require("../strategy-study/compound-b-envelope-diagnostic");
const START = Date.parse("2026-10-21T02:00:00Z"), PRIVATE = "PRIVATE_ENVELOPE_SENTINEL", TEMP = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode";
const urls = ["https://eth-mainnet.g.alchemy.com/offline-envelope", "https://eth-mainnet.infura.io/offline-envelope", "https://ethereum.publicnode.com/offline-envelope"];
const clone = v => JSON.parse(JSON.stringify(v)), bytes = v => Buffer.from(JSON.stringify(v)), ok = id => ({ jsonrpc: "2.0", id, result: "0x1" });
let parent; function source() { return parent ||= diagnostic.loadDiagnosticParent(); }
function fixture(respond = c => ({ value: ok(c.id) }), extra = {}) {
  let time = START; const calls = [], events = [];
  const f = { calls, events, now: () => time, setNow: n => { time = n; } };
  f.options = { purpose: diagnostic.PURPOSE, chainId: 1, backoff: true, candidates: urls, shared: { getOrigin: () => null }, now: f.now,
    sleep: async ms => { time += ms; }, backoffRandom: () => 0, onTransportDiagnostic: e => events.push(e),
    fetch: async (url, init) => { const c = { ...JSON.parse(init.body), index: f.options.candidates.indexOf(url), at: time }; calls.push(c);
      const r = await respond(c, f, init); return new Response(r.raw ?? JSON.stringify(r.value), { status: r.status || 200, headers: r.headers }); }, ...extra };
  f.run = () => { const { purpose, chainId, backoff, onTransportDiagnostic, ...runtimeOptions } = f.options; return diagnostic.runEnvelopeDiagnostic({ parent: source(), runtimeOptions }); };
  return f;
}
async function withRuntime(f, task) { const r = capture.createRuntime(f.options); try { return await task(r); } finally { await r.close(); assert.deepEqual(r.lifecycle(), { closed: true, pending: 0 }); } }
function cases() {
  const error = (value, more = {}) => ({ jsonrpc: "2.0", id: 1, error: value, ...more });
  return [
    [Buffer.from(PRIVATE), "invalid-json"], [null, "invalid-root"], [[], "invalid-root"], [true, "invalid-root"], [1, "invalid-root"], [PRIVATE, "invalid-root"],
    [{ id: 1, result: PRIVATE }, "invalid-version"], [{ jsonrpc: 2, id: 1, result: PRIVATE }, "invalid-version"], [{ ...ok(1), jsonrpc: "1.0" }, "invalid-version"],
    [{ jsonrpc: "2.0", result: PRIVATE }, "invalid-id"], [ok(null), "invalid-id"], [ok("1"), "invalid-id"], [ok(2), "invalid-id"], [ok({ [PRIVATE]: PRIVATE }), "invalid-id"],
    [error(null, { result: PRIVATE }), "error-plus-result"], [error({ code: -32601, message: PRIVATE }, { [PRIVATE]: PRIVATE }), "extra-top-fields"],
    [error(null), "malformed-error"], [error(false), "malformed-error"], [error(0), "malformed-error"], [error(PRIVATE), "malformed-error"], [error([]), "malformed-error"],
    [error({ code: -32601, message: PRIVATE, [PRIVATE]: PRIVATE }), "extra-error-keys"],
    [error({ message: PRIVATE }), "noninteger-code"], [error({ code: "-32601", message: PRIVATE }), "noninteger-code"], [error({ code: 1.5, message: PRIVATE }), "noninteger-code"],
    [error({ code: -32601 }), "message-wrong-type"], [error({ code: -32601, message: { [PRIVATE]: PRIVATE } }), "message-wrong-type"],
    [error({ code: -32601, message: PRIVATE.repeat(250) }), "message-too-long"], [{ jsonrpc: "2.0", id: 1 }, "missing-result"],
    [error({ code: -32601, message: PRIVATE, data: { [PRIVATE]: PRIVATE } }), "error-envelope-valid"],
    [error({ code: 12345, message: "" }), "error-envelope-valid"], [ok(1), "result-envelope-valid"],
    [{ ...ok(1), [PRIVATE]: { [PRIVATE]: PRIVATE } }, "result-envelope-valid"], [{ ...ok(1), result: null }, "result-envelope-valid"],
  ];
}
test("pure classifier distinguishes every rejection gate without retaining raw keys/values or provider classes", () => {
  const seen = new Set();
  for (const [value, expected] of cases()) {
    const s = classifier.classifyEnvelope(Buffer.isBuffer(value) ? value : bytes(value), 1); seen.add(s.category);
    assert.equal(s.category, expected); assert.equal(classifier.validateEnvelopeShape(s), s); assert.ok(Object.isFrozen(s));
    assert.deepEqual(Object.keys(s).sort(), [...classifier.KEYS].sort()); assert.ok(!JSON.stringify(s).includes(PRIVATE));
    assert.ok(Object.values(s).every(v => typeof v === "boolean" || typeof v === "string"));
  }
  assert.deepEqual([...seen].sort(), [...classifier.CATEGORIES].sort());
  for (const result of ["0x1", "0x2", "0x0", "0x01", "0xA", "0x", 1, [], {}, PRIVATE]) {
    const s = classifier.classifyEnvelope(bytes({ ...ok(1), result }), 1);
    assert.equal(s.ethereumChainMatch, result === "0x1"); assert.equal(s.resultCanonicalHex, ["0x1", "0x2", "0x0"].includes(result));
  }
  assert.equal(classifier.classifyEnvelope(bytes({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "x".repeat(4096) } }), 1).category, "error-envelope-valid");
});
test("classifier bytes-only bounds and intrinsic decode do not invoke getters, serializers or caller methods", () => {
  let invoked = 0; const hostile = { get length() { invoked++; }, get toString() { invoked++; }, toJSON() { invoked++; } };
  assert.throws(() => classifier.classifyEnvelope(hostile, 1), /invalid-options/);
  for (const id of [null, "1", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, hostile]) assert.throws(() => classifier.classifyEnvelope(bytes(ok(1)), id), /invalid-options/);
  assert.throws(() => classifier.classifyEnvelope(Buffer.alloc(classifier.MAX_BYTES + 1), 1), /invalid-options/);
  const b = bytes(ok(1)); for (const k of ["toString", "utf8Slice", "length"]) Object.defineProperty(b, k, { get() { invoked++; throw new Error(PRIVATE); } });
  assert.equal(classifier.classifyEnvelope(b, 1).category, "result-envelope-valid"); assert.equal(invoked, 0);
  assert.throws(() => classifier.classifyEnvelope(new Proxy(b, { get() { invoked++; } }), 1), /invalid-options/); assert.equal(invoked, 0);
  assert.equal(classifier.classifyEnvelope(Buffer.alloc(classifier.MAX_BYTES, 32), 1).category, "invalid-json");
  for (const change of [s => { s.extra = PRIVATE; }, s => { s.idMatches = "true"; }, s => { s.rootType = PRIVATE; }, s => { s.category = "invalid-id"; },
    s => { s.idType = "string"; }, s => { s.resultCanonicalHex = false; }, s => { s.knownErrorKeys = true; }, s => { s.messageWithinBound = true; }, s => { s.jsonParseValid = false; }]) {
    const s = clone(classifier.classifyEnvelope(bytes(ok(1)), 1)); change(s); assert.throws(() => classifier.validateEnvelopeShape(s), /invalid-schema/);
  }
  const s = clone(classifier.classifyEnvelope(bytes(ok(1)), 1)); Object.defineProperty(s, "idMatches", { get() { invoked++; } }); assert.throws(() => classifier.validateEnvelopeShape(s), /invalid-schema/); assert.equal(invoked, 0);
});
test("new runtime purpose is exact chain-ID only and preserves older expiry/diagnostic shapes", async () => {
  const f = fixture();
  for (const options of [{ backoff: false }, { chainId: 8453 }, { candidates: undefined }, { shared: undefined }, { expiresAt: "2030-01-01" }, { allowedMethods: ["eth_call"] },
    { limits: { requests: 33 } }, { limits: { totalTimeoutMs: 300001 } }, { limits: { responseBytes: 1048577 } }, { limits: { totalResponseBytes: 16777217 } }, { limits: { logRequests: 1 } }, { limits: { traceRequestCap: 1 } }, { limits: { spacingMs: 999 } }])
    assert.throws(() => capture.createRuntime({ ...f.options, ...options }), /invalid-options/);
  await withRuntime(f, async r => {
    for (const method of [...capture.METHODS.filter(m => m !== "eth_chainId"), "eth_call", "eth_getCode", "eth_sendRawTransaction", "debug_traceCall"])
      await assert.rejects(r.request(0, method, []), /rpc-method-not-read-only-allowlisted/);
    let invoked = 0; const accessor = []; Object.defineProperty(accessor, "0", { get() { invoked++; return PRIVATE; } });
    const serialize = []; Object.defineProperty(serialize, "toJSON", { value() { invoked++; return []; } });
    for (const params of [[1], accessor, serialize, {}, null, Object.setPrototypeOf([], null)]) await assert.rejects(r.request(0, "eth_chainId", params), /invalid-options/);
    await assert.rejects(r.request(0, "eth_chainId", [], PRIVATE), /invalid-options/); assert.equal(invoked, 0); assert.equal(r.snapshot().requests, 0);
    const params = [], pending = r.request(0, "eth_chainId", params); params.push(PRIVATE); const returned = await pending;
    assert.deepEqual(f.calls[0].params, []); assert.equal(returned.ethereumChainMatch, true); assert.equal(returned.result, undefined);
    assert.equal(r.timing().expiresAt, diagnostic.EXPIRES_AT);
  });
  assert.ok(f.events[0].envelopeShape); assert.equal(f.events[0].rpcErrorCode, null);
  const old = fixture(undefined, { purpose: "compound-b-metadata" }); await withRuntime(old, r => r.request(0, "eth_chainId", [])); assert.equal(Object.hasOwn(old.events[0], "envelopeShape"), false);
  for (const purpose of ["qualification", "census", "enrichment", "emission-diagnostic", "emission-capability"]) assert.throws(() => capture.createRuntime({ ...f.options, purpose }), /session-expired/);
  const expired = fixture(undefined, { now: () => Date.parse(diagnostic.EXPIRES_AT) }); assert.throws(() => capture.createRuntime(expired.options), /session-expired/);
});
test("runtime classifies before each malformed envelope rejection and never accepts non-200 shape evidence", async () => {
  for (const [value, category] of cases()) {
    const f = fixture(() => ({ raw: Buffer.isBuffer(value) ? value.toString() : JSON.stringify(value) }));
    await withRuntime(f, async r => {
      if (category === "result-envelope-valid") assert.equal((await r.request(0, "eth_chainId", [])).category, category);
      else await assert.rejects(r.request(0, "eth_chainId", []));
    });
    assert.equal(f.events[0].envelopeShape.category, category); assert.ok(!JSON.stringify(f.events).includes(PRIVATE));
  }
  for (const status of [201, 401, 403, 500]) {
    const f = fixture(c => ({ status, value: ok(c.id), headers: { "x-private": PRIVATE } }));
    await withRuntime(f, r => assert.rejects(r.request(0, "eth_chainId", []), /provider-http-failure/)); assert.equal(f.events[0].envelopeShape.category, "result-envelope-valid");
  }
});
test("bounded bodies, expiry, HTTP timeout and drain retain only available shapes", async () => {
  const oversized = fixture(() => ({ raw: PRIVATE }), { limits: { responseBytes: 1 } });
  await withRuntime(oversized, r => assert.rejects(r.request(0, "eth_chainId", []), /response-budget-exceeded/)); assert.equal(oversized.events[0].envelopeShape, null);
  const expired = fixture((c, f) => { f.setNow(Date.parse(diagnostic.EXPIRES_AT)); return { value: ok(c.id) }; });
  await withRuntime(expired, r => assert.rejects(r.request(0, "eth_chainId", []), /session-expired/)); assert.equal(expired.events[0].envelopeShape.ethereumChainMatch, true);
  const timeout = fixture(undefined, { limits: { requestTimeoutMs: 10 }, fetch: async (_, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error(PRIVATE)), { once: true })) });
  await withRuntime(timeout, r => assert.rejects(r.request(0, "eth_chainId", []), /request-timeout/)); assert.equal(timeout.events[0].envelopeShape, null);
  const r = capture.createRuntime(timeout.options), request = r.request(0, "eth_chainId", []), rejected = assert.rejects(request, /session-closed|request-timeout/); await r.close(); await rejected;
  assert.deepEqual(r.lifecycle(), { closed: true, pending: 0 });
});
test("429 retries retain original frozen payload, Retry-After floor, circuit and privacy", async () => {
  const f = fixture(c => c.id === 1 ? { status: 429, raw: PRIVATE, headers: { "retry-after": "3", "x-private": PRIVATE } } : { value: ok(c.id) });
  await withRuntime(f, async r => { const params = [], pending = r.request(0, "eth_chainId", params); params.push(PRIVATE); await pending;
    assert.equal(r.backoffSnapshot().retries, 1); assert.ok(f.calls[1].at - f.calls[0].at >= 3000); assert.ok(f.calls.every(c => c.params.length === 0)); });
  const blocked = fixture(() => ({ status: 429, raw: PRIVATE }));
  await withRuntime(blocked, async r => { await assert.rejects(r.request(0, "eth_chainId", []), /provider-rate-limited/); await assert.rejects(r.request(0, "eth_chainId", []), /provider-circuit-open/); assert.equal(blocked.calls.length, 3); });
  assert.ok(!JSON.stringify([...f.events, ...blocked.events]).includes(PRIVATE));
});
test("diagnostic completes ordered full pool despite invalid envelopes, chains and HTTP failures; authority stays false", async () => {
  const f = fixture(c => ({ value: c.index === 0 ? { ...ok(c.id), id: null, [PRIVATE]: PRIVATE } : c.index === 1 ? { ...ok(c.id), result: "0x2" } : ok(c.id) }));
  const m = await f.run(); assert.equal(m.diagCollectionComplete, true); assert.deepEqual(m.operations.map(o => o.code), ["invalid-schema", "wrong-chain", null]);
  assert.deepEqual(m.operations.map(o => o.observationId), ["obs-01", "obs-02", "obs-03"]); assert.equal(m.runtimeDrained, true); assert.deepEqual(m.authority, diagnostic.AUTHORITY);
  diagnostic.validateEnvelopeDiagnostic(m, source()); assert.ok(!JSON.stringify(m).includes(PRIVATE)); assert.equal(m.limitations.historicalFailureCauseProven, false);
  for (const mode of ["http", "json", "rpc", "transport", "timeout", "rate", "cooldown"]) {
    const f = fixture(c => {
      if (c.index !== 0) return { value: ok(c.id) };
      if (mode === "http") return { status: 401, raw: PRIVATE };
      if (mode === "json") return { raw: PRIVATE };
      if (mode === "rpc") return { value: { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: PRIVATE } } };
      if (mode === "transport") throw new Error(PRIVATE);
      if (["rate", "cooldown"].includes(mode)) return { status: 429, raw: PRIVATE, headers: { "retry-after": mode === "cooldown" ? "1000" : "1" } };
    });
    if (mode === "timeout") { const original = f.options.fetch; f.options.limits = { requestTimeoutMs: 10 }; f.options.fetch = async (url, init) => url === urls[0]
      ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error(PRIVATE)), { once: true })) : original(url, init); }
    const m = await f.run(); assert.equal(m.diagCollectionComplete, true, mode); assert.equal(m.operations.length, 3); assert.notEqual(m.operations[0].code, null); diagnostic.validateEnvelopeDiagnostic(m, source());
  }
});
test("request/byte/lifetime/expiry caps stop globally without replacing or dropping observed candidates", async () => {
  for (const mode of ["requests", "response", "total-bytes", "elapsed", "expired"]) {
    const f = fixture((c, f) => { if (mode === "expired") f.setNow(Date.parse(diagnostic.EXPIRES_AT)); if (mode === "elapsed") f.setNow(START + 300000); return { value: ok(c.id) }; },
      mode === "requests" ? { limits: { requests: 1 } } : mode === "response" ? { limits: { responseBytes: 1 } } : mode === "total-bytes" ? { limits: { totalResponseBytes: 1 } } : {});
    const m = await f.run(); assert.equal(m.diagCollectionComplete, false); assert.equal(m.operations.length, 1); assert.equal(f.calls.length, 1); diagnostic.validateEnvelopeDiagnostic(m, source());
  }
  const sameFamily = [urls[0], urls[0] + "-second", urls[1]], f = fixture(c => c.index === 0 ? { status: 429, raw: PRIVATE } : { value: ok(c.id) }, { candidates: sameFamily });
  const m = await f.run(); assert.deepEqual(m.operations.map(o => o.code), ["provider-rate-limited", "provider-circuit-open", null]); assert.equal(m.operations[1].transport.length, 0); diagnostic.validateEnvelopeDiagnostic(m, source());
});
test("complete bounded pool enforces 32 physical/16 additional attempt ceilings and max two per family", async () => {
  const hosts = ["alchemy.com", "infura.io", "quicknode.com", "ankr.com", "1rpc.io", "0xrpc.io", "drpc.org", "publicnode.com"];
  const pool = hosts.flatMap(host => [`https://${host}/synthetic-one`, `https://${host}/synthetic-two`]);
  assert.throws(() => capture.createRuntime(fixture(undefined, { candidates: [urls[0], urls[0] + "-2", urls[0] + "-3"] }).options), /invalid-options/);
  for (const mode of ["physical", "retries"]) {
    const attempts = new Map(), f = fixture(c => { const n = (attempts.get(c.index) || 0) + 1; attempts.set(c.index, n);
      return n <= (mode === "physical" ? 1 : 2) ? { status: 429, raw: PRIVATE } : { value: ok(c.id) }; }, { candidates: pool });
    const m = await f.run(); assert.equal(m.reason, mode === "physical" ? "request-budget-exhausted" : "retry-budget-exhausted");
    assert.equal(m.budget.requests, mode === "physical" ? 32 : 25); assert.equal(m.backoff.retries, 16); assert.equal(m.diagCollectionComplete, false);
    diagnostic.validateEnvelopeDiagnostic(m, source()); assert.ok(m.operations.every(o => o.transport.length <= 3));
  }
});
test("actual guarded adapter shape, parent-before-inventory, reservation and dispose-before-publish", async () => {
  const adapter = require("../strategy-study/authorized-inventory").parseAuthorizedInventory(urls.map(url => `Ethereum ${url}`).join("\n"), { chainId: 1, cap: 16 });
  assert.equal(Object.getPrototypeOf(adapter), null); assert.throws(() => JSON.stringify(adapter.candidates), /process-only-provider-handles/);
  const f = fixture(undefined, { candidates: adapter.candidates }), order = [];
  const exit = await diagnostic.main(["--capture-compound-b-envelope-diagnostic"], { now: f.now, print() {}, preflight() { order.push("fresh"); },
    loadDiagnosticParent() { order.push("parent"); return source(); }, createEnvelopeDiagnosticWriter() { order.push("reserve"); return { publish(m) { order.push("publish");
      assert.equal(adapter.candidates.length, 0); assert.equal(m.adapterDisposed, true); diagnostic.validateEnvelopeDiagnostic(m, source()); return { diagCollectionComplete: m.diagCollectionComplete }; } }; },
    loadAuthorizedCandidates() { order.push("inventory"); return adapter; }, runEnvelopeDiagnostic: async ({ runtimeOptions }) => {
      order.push("run"); assert.equal(runtimeOptions.candidates, adapter.candidates); return f.run(); } });
  assert.equal(exit, 0); assert.deepEqual(order, ["fresh", "parent", "reserve", "inventory", "run", "publish"]);
});
test("strict timing enforces family pacing and original-source chronology; setup failure publishes without inventory details", async () => {
  const f = fixture(undefined, { candidates: [urls[0], urls[0] + "-second"] }), m = await f.run(); diagnostic.validateEnvelopeDiagnostic(m, source());
  const changed = clone(m); changed.operations[1].transport[0].startedAt = changed.operations[0].transport[0].startedAt;
  assert.throws(() => diagnostic.validateEnvelopeDiagnostic(changed, source()), /invalid-schema/);
  const backwards = fixture(undefined, { now: () => Date.parse(source().originalPublishedAt) - 1 }), failed = await backwards.run();
  assert.equal(failed.reason, "invalid-options"); assert.equal(failed.budget.requests, 0); diagnostic.validateEnvelopeDiagnostic(failed, source());
  let published = false;
  const exit = await diagnostic.main(["--capture-compound-b-envelope-diagnostic"], { preflight() {}, loadDiagnosticParent: source, now: f.now, print() {},
    loadAuthorizedCandidates() { throw new Error(PRIVATE); }, createEnvelopeDiagnosticWriter() { return { publish(m) {
      diagnostic.validateEnvelopeDiagnostic(m, source()); assert.equal(m.runtimeInitialized, false); assert.equal(m.reason, "capture-failed"); assert.equal(m.adapterDisposed, true); published = true; return { diagCollectionComplete: false };
    } }; } });
  assert.equal(exit, 2); assert.equal(published, true);
});
test("strict reader authenticates original B2M and rejects rehashed flags, timings, sequence, budgets and authority tampering", async () => {
  const f = fixture(), m = await f.run(), root = fs.mkdtempSync(path.join(TEMP, "envelope-reader-")), out = path.join(root, "capture");
  try {
    const writer = diagnostic.createEnvelopeDiagnosticWriter(out), summary = writer.publish({ ...m, adapterDisposed: true }, source(), f.now);
    const read = () => diagnostic.readEnvelopeDiagnostic(out), file = path.join(out, diagnostic.FILE), originalText = fs.readFileSync(file, "utf8"), original = JSON.parse(originalText);
    assert.equal(read().manifestSha256, summary.manifestSha256); assert.throws(() => diagnostic.readEnvelopeDiagnostic(out, { expectedManifestSha256: "0".repeat(64) }), /invalid-schema/);
    assert.throws(() => diagnostic.createEnvelopeDiagnosticWriter(out), /output-unavailable/); assert.throws(() => writer.publish(m, source(), f.now), /output-unavailable/);
    for (const mutate of [m => { m.sourceB2MManifestSha256 = "0".repeat(64); }, m => { m.operations[0].transport[0].envelopeShape.category = "invalid-id"; },
      m => { m.operations[0].transport[0].envelopeShape.secret = PRIVATE; }, m => { m.operations[0].transport[0].envelopeShape.idType = "string"; },
      m => { m.operations[0].transport[0].httpStatus = 401; }, m => { m.operations[0].transport[0].requestId = 2; }, m => { m.operations[0].transport[0].attempt = 2; },
      m => { m.operations[0].transport[0].startedAt = "2026-10-22T00:00:00.000Z"; }, m => { m.operations[0].transport[0].responseBytes = 0; },
      m => { m.operations.reverse(); }, m => { m.operations.pop(); }, m => { m.limits.requests = 33; }, m => { m.budget.logRequests = 1; }, m => { m.budget.bytes--; },
      m => { m.backoff.retries = 1; }, m => { m.backoff.openCircuits = 1; }, m => { m.backoff.successes--; }, m => { m.diagCollectionComplete = false; },
      m => { m.authority.qualifiedMetadata = true; }, m => { m.authority.prefixComplete = true; }, m => { m.limitations.endpointIdentityProven = true; },
      m => { m.adapterDisposed = false; }, m => { m.runtimeDrained = false; }, m => { m.independence[0][0] = true; }, m => { m.poolShapeMatchesB2M = !m.poolShapeMatchesB2M; }]) {
      const changed = clone(original); mutate(changed); const { payloadSha256, ...body } = changed; changed.payloadSha256 = capture.sha256(capture.canonical(body)); fs.writeFileSync(file, JSON.stringify(changed)); assert.throws(read, /invalid-schema/);
    }
    fs.writeFileSync(file, originalText); fs.writeFileSync(path.join(out, "extra"), ""); assert.throws(read, /invalid-schema/); fs.unlinkSync(path.join(out, "extra"));
    const link = path.join(root, "alias"); fs.symlinkSync(out, link, "junction"); assert.throws(() => diagnostic.readEnvelopeDiagnostic(link), /invalid-schema/); fs.unlinkSync(link);
    const hardlink = path.join(root, "hardlink"); fs.linkSync(file, hardlink); assert.throws(read, /invalid-schema/); fs.unlinkSync(hardlink);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("failed and publication-expired diagnostic terminals remain strictly readable and exclusive", async () => {
  for (const mode of ["malformed", "budget", "expired-publication"]) {
    const f = fixture(c => ({ raw: mode === "malformed" ? PRIVATE : JSON.stringify(ok(c.id)) }), mode === "budget" ? { limits: { requests: 1 } } : {}), m = await f.run();
    const root = fs.mkdtempSync(path.join(TEMP, "envelope-terminal-")), out = path.join(root, "capture");
    try {
      diagnostic.createEnvelopeDiagnosticWriter(out).publish({ ...m, adapterDisposed: true }, source(), mode === "expired-publication" ? () => Date.parse(diagnostic.EXPIRES_AT) : f.now);
      const read = diagnostic.readEnvelopeDiagnostic(out); assert.equal(read.manifest.diagCollectionComplete, mode === "malformed"); assert.deepEqual(read.manifest.authority, diagnostic.AUTHORITY);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
test("real CLI rejects options/collision/original-source failure before resolving inventory; imports are inert", () => {
  const snapshotOutput = () => {
    if (!fs.existsSync(diagnostic.OUTPUT)) return null;
    const artifact = path.join(diagnostic.OUTPUT, diagnostic.FILE);
    return { entries: fs.readdirSync(diagnostic.OUTPUT).sort(), artifactSha256: fs.existsSync(artifact) ? capture.sha256(fs.readFileSync(artifact)) : null };
  };
  const beforeOutput = snapshotOutput();
  const root = fs.mkdtempSync(path.join(TEMP, "envelope-cli-")), preload = path.join(root, "preload.cjs");
  try {
    for (const mode of ["collision", "source"]) {
      fs.writeFileSync(preload, `const M=require('node:module'),fs=require('node:fs');const old=M._load;M._load=function(n,...a){if(/authorized-inventory|shared-rpc/.test(n))throw new Error('FORBIDDEN_MODULE');if(n==='./compound-b-metadata-cli'&&${mode === "source"})return {readCompoundBMetadata(d,o){if(o.expectedManifestSha256!=='${diagnostic.B2M_SHA256}')throw new Error('BAD_PIN');throw new Error('invalid-schema')}};return old.call(this,n,...a)};const l=fs.lstatSync;fs.lstatSync=function(p,...a){if(String(p)===${JSON.stringify(diagnostic.OUTPUT)}){${mode === "collision" ? "return {isDirectory:()=>true};" : "const e=new Error('synthetic-output-absent');e.code='ENOENT';throw e;"}}return l.call(this,p,...a)};`);
      for (const argv of [["--capture-compound-b-envelope-diagnostic"], ["--capture-compound-b-envelope-diagnostic", "--out=x"], ["--expiry=2030"]]) {
        const r = cp.spawnSync(process.execPath, ["--require", preload, require.resolve("../strategy-study/compound-b-envelope-diagnostic"), ...argv], { encoding: "utf8", timeout: 10000, windowsHide: true });
        assert.equal(r.status, 2); assert.equal(r.stderr, ""); const summary = JSON.parse(r.stdout);
        assert.equal(summary.reason, argv.length === 1 && argv[0] === "--capture-compound-b-envelope-diagnostic" ? mode === "collision" ? "output-unavailable" : "invalid-schema" : "invalid-options");
        assert.equal(summary.qualifiedMetadata, false);
      }
    }
    const vm = require("node:vm"), blocked = new Proxy({}, { get() { assert.fail("I/O during import"); } });
    const filename = require.resolve("../strategy-study/compound-b-envelope-diagnostic"), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, __dirname: path.dirname(filename), process: blocked, Buffer,
      require(dep) { if (dep === "node:fs") return blocked; if (dep === "node:path") return path; if (dep === "./capture") return capture;
        if (dep === "./rpc-envelope-diagnostic") return classifier; if (dep === "./emission-proof") return require("../strategy-study/emission-proof"); assert.fail("unexpected import"); } });
    assert.equal(typeof module.exports.main, "function");
  } finally { fs.rmSync(root, { recursive: true, force: true }); assert.deepEqual(snapshotOutput(), beforeOutput); }
  assert.equal(capture.sha256(fs.readFileSync(path.join(diagnostic.B2M_DIRECTORY, "terminalmetadata.json"))), diagnostic.B2M_SHA256);
});
