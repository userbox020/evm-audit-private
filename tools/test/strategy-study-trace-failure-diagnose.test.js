"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const capture = require("../strategy-study/capture"), collector = require("../strategy-study/trace-enrichment");
const cli = require("../strategy-study/trace-diagnose-cli"), ordinary = require("../strategy-study/trace-cli");
const domains = require("../strategy-study/log-index-domains"), accounting = require("../strategy-study/call-accounting");
const { fixture } = require("./strategy-study-trace.test");
const clone = value => structuredClone(value), H = n => `0x${BigInt(n).toString(16).padStart(64, "0")}`, Q = n => `0x${BigInt(n).toString(16)}`;
const A = `0x${"11".repeat(20)}`, B = `0x${"22".repeat(20)}`, SENTINEL = "T2D_PRIVATE_SENTINEL";
const PIN = collector.FAILURE_FIXTURE, OFFSET = Number(PIN.blockNumber) - 109;
const isCall = c => c.method === "debug_traceTransaction" && c.params[1].tracer === "callTracer";
const isState = c => c.method === "debug_traceTransaction" && c.params[1].tracer === "prestateTracer";
function failureFixture(options = {}) {
  // Keep the entire synthetic universe in order, replacing only public identity
  // fields consistently. The transport still uses the established offline stub.
  const f = fixture({ n: options.n || 111, metadata: true, ...options });
  const hashes = new Map([[H(10009), PIN.txHash]]);
  for (let n = 99; n <= 1001; n++) hashes.set(H(n), n === 109 ? PIN.blockHash : H(n + OFFSET));
  const reverse = new Map([...hashes].map(([a, b]) => [b, a]));
  function translate(value) {
    if (typeof value === "string") return hashes.get(value) || value;
    if (Array.isArray(value)) return value.map(translate);
    if (!value || typeof value !== "object") return value;
    const target = value.blockHash === H(109) || value.txHash === H(10009);
    return Object.fromEntries(Object.entries(value).map(([key, v]) => {
      if (["number", "blockNumber"].includes(key) && typeof v === "string") return [key, v.startsWith("0x") ? Q(BigInt(v) + BigInt(OFFSET)) : String(BigInt(v) + BigInt(OFFSET))];
      if (key === "transactionIndex" && target) return [key, v.startsWith("0x") ? Q(35) : "35"];
      if (key === "transactions" && Array.isArray(v) && v.length === 1 && v[0] === H(10009)) return [key, [...Array.from({ length: 35 }, (_, i) => H(50000 + i)), PIN.txHash]];
      return [key, translate(v)];
    }));
  }
  f.parent = { ...translate(f.parent), failureProvenance: collector.FAILURE_PROVENANCE };
  const fetch = f.options.fetch, actualCalls = [];
  f.options.fetch = async (url, init) => {
    const req = JSON.parse(init.body); actualCalls.push({ method: req.method, params: clone(req.params), index: f.candidates.indexOf(url) });
    req.params = req.params.map((p, i) => {
      if (i !== 0 || typeof p !== "string") return p;
      if (req.method === "eth_getBlockByNumber" && p !== "finalized") return Q(BigInt(p) - BigInt(OFFSET));
      return reverse.get(p) || p;
    });
    const response = await fetch(url, { ...init, body: JSON.stringify(req) });
    if (response.status !== 200) return response;
    const body = await response.json(); if (Object.hasOwn(body, "result")) body.result = translate(body.result);
    return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
  };
  f.actualCalls = actualCalls;
  return f;
}
const run = f => collector.runFailureFixtureDiagnostic({ parent: f.parent, runtimeOptions: f.options });
const read = (out, f, options = {}) => cli.readFailureFixtureDiagnostic(out, options, { loadFailureBoundParent: () => f.parent });
function temp() { const root = path.join(os.tmpdir(), "opencode"); fs.mkdirSync(root, { recursive: true }); return fs.mkdtempSync(path.join(root, "t2d-test-")); }
async function published(f) {
  const root = temp(), out = path.join(root, "diagnostic"), writer = cli.createFailureFixtureDiagnosticWriter(out), result = await run(f);
  const summary = writer.publish(result, f.parent, f.now); return { root, out, result, summary };
}
function rejectDomain(c, kind = "mixed", index = 1) {
  if (c.index !== index || !isCall(c)) return;
  if (kind === "mixed") { c.result.logs[0].index = "0xa"; c.result.logs[1].index = "0x1"; }
  else if (kind === "redacted") c.result.logs[0].index = "0x10000000000000000";
  else c.result.calls = [{ type: "CALL", from: B, to: B, input: "0x", gas: "0x100", gasUsed: "0x10", error: SENTINEL,
    logs: [{ ...c.result.logs[0], index: "0x17" }] }];
}
function injectedCollector({ helper = domains, captureOverride = capture } = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../strategy-study/trace-enrichment.js"), "utf8"), {
    module, Buffer, __dirname: path.join(__dirname, "../strategy-study"), require(name) {
      if (name === "node:path") return path;
      if (name === "./capture") return captureOverride;
      if (name === "./call-accounting") return accounting;
      if (name === "./log-index-domains") return { ...helper, bindLogIndexDomainsDiagnostic: (...args) => helper.bindLogIndexDomainsDiagnostic(...args.map(clone)) };
      assert.fail("unexpected dependency");
    },
  });
  return module.exports;
}
function manifestFor(f) {
  const body = { schema: "strategy-study-t2/v1", chainId: 1, sourceC2ManifestSha256: collector.C2_SHA256, universe: f.parent.universe,
    status: "CAPTURE-FAILED", reason: "consensus-mismatch", aggregateEvidenceStatus: "INVALID", integrityFailure: collector.FAILURE_PROVENANCE.failure };
  return { ...body, manifestEvidenceSha256: capture.sha256(capture.canonical(body)) };
}
function fakeFile(bytes, { symlink = false, size = bytes.length } = {}) {
  let offset = 0, opened = 0, closed = 0;
  const stat = { dev: 1, ino: 1, size, isFile: () => true, isSymbolicLink: () => symlink };
  return {
    lstatSync(file) { assert.equal(file, collector.FAILURE_TERMINAL_PATH); return stat; },
    realpathSync(file) { assert.ok([collector.FAILURE_TERMINAL_PATH, path.dirname(collector.FAILURE_TERMINAL_PATH)].includes(file)); return file; },
    openSync(file, mode) { assert.equal(file, collector.FAILURE_TERMINAL_PATH); assert.equal(mode, "r"); opened++; return 1; },
    fstatSync() { return stat; },
    readSync(fd, out, start, length) { const n = Math.min(length, bytes.length - offset); bytes.copy(out, start, offset, offset + n); offset += n; return n; },
    closeSync() { closed++; }, stats: () => ({ opened, closed }),
  };
}

test("T2D qualifies only fixed index9 directly, preserves all111 identities and never commits even on all-pool success", async () => {
  const f = failureFixture(), p = await published(f);
  try {
    const r = p.result, loaded = read(p.out, f, { expectedManifestSha256: p.summary.manifestSha256 });
    assert.equal(r.status, "DIAGNOSTIC-COMPLETE", r.reason); assert.equal(r.schema, "strategy-study-t2-failure-diagnostic/v1");
    assert.deepEqual(r.fixture, PIN); assert.deepEqual(r.universe, f.parent.universe); assert.deepEqual(r.counts, { universe: 111, completed: 0, missing: 111 });
    assert.deepEqual(r.missingIndices, Array.from({ length: 111 }, (_, i) => i)); assert.equal(Object.hasOwn(r, "traces"), false);
    assert.equal(r.validAggregate, false); assert.equal(loaded.authority.validAggregate, false); assert.equal(r.aggregateEvidenceStatus, "NON-AUTHORITATIVE");
    assert.equal(r.failureProvenance.validAggregate, false); assert.equal(r.failureProvenance.sourceT2ManifestSha256, collector.FAILURE_TERMINAL_SHA256);
    assert.equal(r.failureStage, null); assert.equal(r.diagnostic, null); assert.equal(r.diagnosticConstruction, "not-needed");
    assert.equal(r.features.traceReceiptBound, false); assert.equal(r.features.costComplete, false); assert.equal(r.features.profitKnown, false);
    assert.deepEqual(r.limits, collector.FIXTURE_DIAGNOSTIC_LIMITS); assert.equal(r.budget.traceRequests, 6);
    assert.ok(f.calls.every(c => c.u === null || c.u === 9));
    assert.ok(f.actualCalls.filter(c => ["eth_getTransactionByHash", "eth_getTransactionReceipt", "debug_traceTransaction"].includes(c.method)).every(c => c.params[0] === PIN.txHash));
    assert.ok(r.transportDiagnostics.every(e => e.universeIndex === null || e.universeIndex === 9));
    const firstTrace = f.calls.findIndex(isCall);
    for (let i = 0; i < 3; i++) { assert.ok(f.calls.findIndex(c => c.index === i && c.method === "eth_getTransactionReceipt") < firstTrace); assert.equal(r.observations[i].complete, true); }
    assert.deepEqual(r.selectedAliases, ["obs-01", "obs-02"]); assert.equal(r.finalAnchorRechecked, true); assert.equal(r.runtimeDrained, true);
    assert.deepEqual(fs.readdirSync(p.out), ["terminaldiagnostic.json"]);
    assert.ok(!/RAW_PRIVATE|T2D_PRIVATE|https:|callFrames|stateAccounts|callAccounting/.test(JSON.stringify(r)));
    assert.throws(() => collector.runFailureFixtureDiagnostic({ parent: f.parent, runtimeOptions: f.options, onTrace() {} }), /invalid-options/);
    for (const field of ["targetIndex", "fixtureIndex", "input", "failurePath"]) assert.throws(() => collector.runFailureFixtureDiagnostic({ parent: f.parent, runtimeOptions: f.options, [field]: 0 }), /invalid-options/);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("T2D still requires independent basics before traces and completes the entire capability pool before selection", async () => {
  const f = failureFixture({ candidates: ["https://eth-mainnet.g.alchemy.com/offline-a", "https://eth-mainnet.g.alchemy.com/offline-b"] });
  const r = await run(f); assert.equal(r.reason, "independent-pair-unavailable"); assert.equal(r.budget.traceRequests, 0);
  const later = failureFixture({ hook(c) { rejectDomain(c, "mixed", 2); return { result: c.result }; } }), bad = await run(later);
  assert.equal(bad.observations[0].complete, true); assert.equal(bad.observations[1].complete, true); assert.deepEqual(bad.selectedAliases, []);
  assert.equal(bad.integrityFailure.observationId, "obs-03"); assert.equal(bad.diagnostic.observationId, "obs-03"); assert.equal(bad.counts.completed, 0);
});

test("T2D records both mixed-domain elimination witnesses and the single indexed-uncommitted witness at index9", async () => {
  for (const kind of ["mixed", "uncommitted", "redacted"]) {
    const f = failureFixture({ hook(c) { rejectDomain(c, kind); return { result: c.result }; } }), p = await published(f);
    try {
      const r = p.result, d = read(p.out, f).diagnostic;
      assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.failureStage, "index-domain");
      assert.equal(r.aggregateEvidenceStatus, "INVALID"); assert.equal(r.diagnosticConstruction, "complete");
      assert.equal(d.observationId, "obs-02"); assert.equal(d.universeIndex, 9); assert.equal(r.integrityFailure.universeIndex, 9);
      assert.equal(f.calls.at(-1).index, 1); assert.ok(isCall(f.calls.at(-1))); assert.equal(r.observations[1].reason, null);
      const witnesses = d.rejection.witnesses;
      if (kind === "uncommitted") {
        assert.equal(d.rejection.kind, "uncommitted-index"); assert.equal(d.rejection.candidateCount, null); assert.equal(witnesses.length, 1);
        assert.equal(witnesses[0].eliminates, null); assert.equal(witnesses[0].receiptOrdinal, null); assert.equal(witnesses[0].receiptLogIndex, null);
        assert.deepEqual(witnesses[0].observedIndex, { value: "23", redacted: false });
      } else {
        assert.equal(d.rejection.kind, "empty-domain-intersection"); assert.equal(d.rejection.candidateCount, 0);
        assert.deepEqual(witnesses.map(w => w.eliminates), ["GLOBAL", "LOCAL_DENSE"]);
        if (kind === "mixed") {
          assert.deepEqual(witnesses.map(w => w.receiptOrdinal), [1, 0]); assert.deepEqual(witnesses.map(w => w.observedIndex.value), ["1", "10"]);
        } else { assert.equal(witnesses[0].observedIndex.redacted, true); assert.equal(witnesses[0].observedIndex.value, null); }
      }
      assert.ok(!JSON.stringify(r).includes(SENTINEL)); assert.ok(!JSON.stringify(d).includes("18446744073709551616"));
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});

test("other core/state/receipt/accounting conflicts stay generic and never acquire a false index-zero or intrinsic descriptor", async () => {
  for (const kind of ["core", "state", "receipt", "accounting"]) {
    const f = failureFixture({ hook(c) {
      if (c.index === 1 && kind === "core" && isCall(c)) c.result.gas = "0x5209";
      if (c.index === 1 && kind === "state" && isState(c)) c.result.pre[A].balance = "0x65";
      if (c.index === 1 && kind === "receipt" && c.method === "eth_getTransactionReceipt") c.result.gasUsed = "0x5209";
      return { result: c.result };
    } });
    let r;
    if (kind === "accounting") {
      const original = accounting.extractCallAccounting; let n = 0;
      // Dependency-only test: a derived interpretation conflict, not raw index disagreement.
      const source = fs.readFileSync(path.join(__dirname, "../strategy-study/trace-enrichment.js"), "utf8"), module = { exports: {} };
      vm.runInNewContext(source, { module, __dirname: path.join(__dirname, "../strategy-study"), require(name) {
        if (name === "node:path") return path;
        if (name === "./capture") return capture;
        if (name === "./log-index-domains") return { ...domains, bindLogIndexDomainsDiagnostic: (...args) => domains.bindLogIndexDomainsDiagnostic(...args.map(clone)) };
        if (name === "./call-accounting") return { ...accounting, extractCallAccounting(...args) { const result = clone(original(...args)); if (n++ === 1) result[0].selector = "0x12345678"; return result; } };
        assert.fail("unexpected dependency");
      } });
      r = clone(await module.exports.runFailureFixtureDiagnostic({ parent: f.parent, runtimeOptions: f.options }));
    } else r = await run(f);
    assert.equal(r.reason, "consensus-mismatch", kind); assert.equal(r.diagnostic, null); assert.equal(r.failureStage, null); assert.equal(r.diagnosticConstruction, "not-needed");
    assert.equal(r.integrityFailure.universeIndex, 9); assert.equal(r.counts.completed, 0);
  }
});

test("intrinsic consensus failure latches before witness validation; failed or missing construction cannot replace it", async () => {
  for (const mode of ["throws", "missing", "bad-value"]) {
    const injected = injectedCollector({ helper: { ...domains,
      bindLogIndexDomainsDiagnostic(...args) {
        try { return domains.bindLogIndexDomainsDiagnostic(...args); }
        catch (error) {
          if (mode !== "missing") throw error;
          const e = new Error("consensus-mismatch"); e.indexDomainReason = "unsupported-index-domain"; throw e;
        }
      }, validateIndexDomainRejection(value) { if (mode === "throws") throw new Error(SENTINEL); if (mode === "bad-value") return null; return domains.validateIndexDomainRejection(value); },
    } });
    const f = failureFixture({ hook(c) { rejectDomain(c); return { result: c.result }; } });
      const r = clone(await injected.runFailureFixtureDiagnostic({ parent: f.parent, runtimeOptions: f.options }));
    assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.failureStage, "index-domain"); assert.equal(r.diagnosticConstruction, "failed"); assert.equal(r.diagnostic, null);
    assert.equal(r.integrityFailure.observationId, "obs-02"); assert.equal(r.integrityFailure.universeIndex, 9); assert.ok(isCall(f.calls.at(-1)));
    const root = temp(), out = path.join(root, "failed");
    try {
      cli.createFailureFixtureDiagnosticWriter(out).publish(r, f.parent, f.now); assert.equal(read(out, f).authority.validAggregate, false);
      const invalid = clone(r); invalid.integrityFailure.observationId = null;
      assert.throws(() => cli.createFailureFixtureDiagnosticWriter(path.join(root, "unattributed")).publish(invalid, f.parent, f.now), /invalid-schema/);
    }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("failure-bound loader verifies exact fixed path/file digest/payload and pinned failure against full C2 before returning provenance", () => {
  const f = failureFixture(), base = manifestFor(f), bytes = Buffer.from(JSON.stringify(base));
  const rawFs = fakeFile(bytes);
  assert.throws(() => collector.loadFailureBoundParent({ loadParent: () => f.parent, fs: rawFs }), /invalid-schema/, "synthetic bytes never match the production pin");
  assert.deepEqual(rawFs.stats(), { opened: 1, closed: 1 });
  // Only the physical-file digest is substituted in this pure fixture; the
  // canonical payload digest and every bound semantic field remain real.
  const injected = injectedCollector({ captureOverride: { ...capture, sha256: value => Buffer.isBuffer(value) ? collector.FAILURE_TERMINAL_SHA256 : capture.sha256(value) } });
  const fake = fakeFile(bytes), bound = injected.loadFailureBoundParent({ loadParent: () => f.parent, fs: fake });
  assert.deepEqual(clone(bound.failureProvenance), collector.FAILURE_PROVENANCE); assert.equal(bound.universe.length, 111);
  assert.deepEqual(fake.stats(), { opened: 1, closed: 1 });
  const mutations = [m => { m.manifestEvidenceSha256 = "0".repeat(64); }, m => { m.schema = "strategy-study-t1/v1"; }, m => { m.chainId = 8453; },
    m => { m.sourceC2ManifestSha256 = "0".repeat(64); }, m => { m.status = "COMPLETE"; }, m => { m.reason = "invalid-schema"; },
    m => { m.aggregateEvidenceStatus = "VALIDATED"; }, m => { m.integrityFailure.phase = "prestate-tracer"; },
    m => { m.integrityFailure.observationId = "obs-04"; }, m => { m.integrityFailure.universeIndex = 0; }, m => { m.universe.reverse(); },
    m => { m.universe[9].txHash = H(99); }];
  for (const [i, mutate] of mutations.entries()) {
    const m = clone(base); mutate(m);
    if (i !== 0) { delete m.manifestEvidenceSha256; m.manifestEvidenceSha256 = capture.sha256(capture.canonical(m)); }
    const fake = fakeFile(Buffer.from(JSON.stringify(m)));
    assert.throws(() => injected.loadFailureBoundParent({ loadParent: () => f.parent, fs: fake }), /invalid-schema/);
    assert.equal(fake.stats().closed, 1);
  }
  for (const options of [{ symlink: true }, { size: 8 * 1024 * 1024 + 1 }, { size: bytes.length - 1 }]) {
    assert.throws(() => injected.loadFailureBoundParent({ loadParent: () => f.parent, fs: fakeFile(bytes, options) }), /invalid-schema/);
  }
  for (const key of ["path", "directory", "expectedManifestSha256", "targetIndex"]) assert.throws(() => collector.loadFailureBoundParent({ [key]: "override" }), /invalid-schema/);
  const bad = clone(f.parent); bad.universe[9].txHash = H(99);
  assert.throws(() => injected.loadFailureBoundParent({ loadParent: () => bad, fs: { lstatSync() { assert.fail("parent checked before file"); } } }), /invalid-schema/);
});

test("physical 429 retries and reduced T2D caps are unchanged, and expiry/shutdown preserve intrinsic failure dominance", async () => {
  const f = failureFixture({ n: 10 });
  for (const limits of [{ requests: 301 }, { traceRequestCap: 65 }, { totalTimeoutMs: 600001 }, { totalResponseBytes: 67108865 }, { spacingMs: 999 }]) {
    assert.throws(() => collector.runFailureFixtureDiagnostic({ parent: f.parent, runtimeOptions: { ...f.options, limits } }), /invalid-options/);
  }
  for (const limits of [{ requests: 1 }, { traceRequestCap: 1 }]) {
    const capped = failureFixture({ n: 10, limits, hook(c) { if (limits.requests || isCall(c)) return { status: 429, raw: SENTINEL }; } }), r = await run(capped);
    assert.equal(r.status, "LIMIT-REACHED"); assert.equal(r.budget.requests, capped.calls.length); assert.ok(r.budget.traceRequests <= (limits.traceRequestCap || 64));
  }
  let attempts = 0;
  const retry = failureFixture({ n: 10, hook(c) { if (c.index === 0 && isCall(c) && attempts++ === 0) return { status: 429, raw: SENTINEL }; } }), r = await run(retry);
  assert.equal(r.status, "DIAGNOSTIC-COMPLETE", r.reason); assert.equal(r.backoff.retries, 1); assert.equal(r.budget.traceRequests, 7); assert.equal(r.budget.requests, retry.calls.length);
  const expired = failureFixture({ hook(c) { rejectDomain(c); return { result: c.result }; } }), original = capture.createRuntime;
  capture.createRuntime = options => { const runtime = original(options); return { ...runtime, async close() { await runtime.close(); expired.setNow(Date.parse(capture.EXPIRES_AT)); } }; };
  const root = temp(), out = path.join(root, "expired");
  try {
    const r = await run(expired); assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.lifecycleFailure, "session-expired"); assert.equal(r.runtimeDrained, true);
    cli.createFailureFixtureDiagnosticWriter(out).publish(r, expired.parent, expired.now);
    const loaded = read(out, expired); assert.equal(loaded.manifest.publicationExpired, true); assert.equal(loaded.authority.validAggregate, false); assert.equal(loaded.manifest.status, "CAPTURE-FAILED");
  } finally { capture.createRuntime = original; fs.rmSync(root, { recursive: true, force: true }); }
});

test("strict INVALID publication and reader reject sentinel/alias/index/stage/provenance/witness tampering even after rehash", async () => {
  const f = failureFixture({ hook(c) { rejectDomain(c); return { result: c.result }; } }), p = await published(f);
  try {
    assert.throws(() => read(p.out, f, { expectedManifestSha256: "0".repeat(64) }), /invalid-schema/);
    const file = path.join(p.out, "terminaldiagnostic.json"), original = JSON.parse(fs.readFileSync(file, "utf8"));
    const changes = [m => { m[SENTINEL] = SENTINEL; }, m => { m.failureProvenance.raw = SENTINEL; }, m => { m.failureProvenance.sourceT2ManifestSha256 = "0".repeat(64); },
      m => { m.failureStage = null; }, m => { m.diagnosticConstruction = "not-needed"; }, m => { m.diagnostic = null; }, m => { m.diagnostic.observationId = "obs-01"; },
      m => { m.diagnostic.universeIndex = 0; }, m => { m.integrityFailure.universeIndex = 0; }, m => { m.integrityFailure.code = SENTINEL; },
      m => { m.diagnostic.rejection.witnesses[0].observedIndex.value = SENTINEL; }, m => { m.diagnostic.rejection.witnesses[0].observedIndex.value = "18446744073709551616"; },
      m => { m.diagnostic.rejection.witnesses[0].raw = SENTINEL; }, m => { m.diagnostic.rejection.witnesses.reverse(); }, m => { m.diagnostic.rejection.witnesses.pop(); },
      m => { m.diagnostic.rejection.witnesses[0].frameIndex = 10000; }, m => { m.diagnostic.rejection.witnesses[0].observedIndex.redacted = true; },
      m => { m.transportDiagnostics[0].universeIndex = 0; }, m => { m.fixture.txHash = H(99); }, m => { m.counts.completed = 1; },
      m => { m.budget.requests = 301; }, m => { m.validAggregate = true; }, m => { m.runtimeDrained = false; }, m => { m.schema = "strategy-study-t1-fixture-diagnostic/v1"; }];
    for (const [i, mutate] of changes.entries()) {
      const result = clone(p.result), out = path.join(p.root, `bad-${i}`); mutate(result);
      assert.throws(() => cli.createFailureFixtureDiagnosticWriter(out).publish(result, f.parent, f.now), /invalid-schema/); assert.deepEqual(fs.readdirSync(out), []);
      const m = clone(original); mutate(m); delete m.payloadSha256; m.payloadSha256 = capture.sha256(capture.canonical(m)); fs.writeFileSync(file, JSON.stringify(m));
      assert.throws(() => read(p.out, f), /invalid-schema/);
    }
    const injected = clone(p.result); injected.toJSON = () => { assert.fail("must reject before serialization"); };
    assert.throws(() => cli.createFailureFixtureDiagnosticWriter(path.join(p.root, "serializer")).publish(injected, f.parent, f.now), /invalid-schema/);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("T2D and T1D readers remain isolated and ordinary trace authority rejects either diagnostic", async () => {
  const f = failureFixture(), p = await published(f), old = fixture(), oldOut = path.join(p.root, "t1d");
  try {
    cli.createFixtureDiagnosticWriter(oldOut).publish(await collector.runFixtureDiagnostic({ parent: old.parent, runtimeOptions: old.options }), old.parent, old.now);
    assert.throws(() => cli.readFixtureDiagnostic(p.out, {}, { loadParent: () => f.parent }), /invalid-schema/);
    assert.throws(() => read(oldOut, f), /invalid-schema/);
    assert.throws(() => ordinary.readAuthoritativeTraces(p.out, { allowPartial: true }, { loadParent: () => f.parent }), /invalid-schema/);
    fs.renameSync(path.join(p.out, "terminaldiagnostic.json"), path.join(p.out, "terminalmanifest.json"));
    assert.throws(() => ordinary.readAuthoritativeTraces(p.out, { allowPartial: true }, { loadParent: () => f.parent }), /invalid-schema/);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("T2D CLI fixes its profile and verifies both parents before lazy adapter; drain/dispose/publication order is preserved", async () => {
  const args = ["--diagnose-failure", "--chain=1", "--out=x"];
  assert.equal(cli.parseArgs(args).failure, true);
  for (const extra of ["--diagnose-fixture", "--diagnose-failure", "--index=0", "--tx=0x00", "--input=other", "--failure-path=x", "--requests=1"]) assert.throws(() => cli.parseArgs([...args, extra]), /invalid-options/);
  for (const mode of ["parent-mismatch", "expiry", "success", "conflict", "dispose", "initialize"]) {
    const f = failureFixture({ hook(c) { if (mode === "conflict") rejectDomain(c); return { result: c.result }; } }), root = temp(), out = path.join(root, mode), order = [], printed = [];
    try {
      const code = await cli.main(["--diagnose-failure", "--chain=1", `--out=${out}`], {
        now: mode === "expiry" ? () => Date.parse(capture.EXPIRES_AT) : f.now, print: text => printed.push(text),
        createFailureFixtureDiagnosticWriter(directory) { const writer = cli.createFailureFixtureDiagnosticWriter(directory); order.push("reserve"); return { publish(...args) {
          assert.equal(order.at(-1), "dispose"); order.push("publish"); return writer.publish(...args);
        } }; },
        loadParent() { assert.fail("must use failure-bound loader"); }, loadFailureBoundParent() {
          assert.equal(order.at(-1), "reserve"); order.push("parents"); if (mode === "parent-mismatch") throw new Error("invalid-schema"); return f.parent;
        },
        loadAuthorizedCandidates() { order.push("inventory"); return { candidates: f.candidates, getOrigin: () => null, dispose() { order.push("dispose"); if (mode === "dispose") throw new Error(SENTINEL); } }; },
        async runFailureFixtureDiagnostic(options) {
          assert.equal(Object.hasOwn(options, "onTrace"), false);
          const result = await collector.runFailureFixtureDiagnostic({ ...options, runtimeOptions: { ...f.options, ...options.runtimeOptions, ...(mode === "initialize" ? { backoffRandom: 1 } : {}) } });
          assert.equal(result.runtimeDrained, true); order.push("drain"); return result;
        }, runFixtureDiagnostic() { assert.fail("no fallback"); },
      });
      assert.equal(code, mode === "success" ? 0 : 2, printed.join(""));
      assert.deepEqual(order, mode === "expiry" ? ["reserve"] : mode === "parent-mismatch" ? ["reserve", "parents"]
        : ["reserve", "parents", "inventory", "drain", "dispose", ...(mode === "dispose" ? [] : ["publish"])]);
      assert.ok(!printed.join("").includes(SENTINEL));
      if (["success", "conflict", "initialize"].includes(mode)) assert.equal(read(out, f).authority.validAggregate, false);
      else assert.deepEqual(fs.readdirSync(out), []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("real runtime/transport/backoff completion callbacks precede normalization and a queued contradictory second observation is attributed second", async t => {
  for (const kind of ["core", "intrinsic"]) {
  const f = failureFixture({ n: 10, hook(c) {
    if (kind === "intrinsic") rejectDomain(c); else if (c.index === 1 && isCall(c)) c.result.gas = "0x5209";
    return { result: c.result };
  } }), events = [];
  const runtime = capture.createRuntime({ ...f.options, chainId: 1, purpose: "enrichment", backoff: true, limits: collector.FIXTURE_DIAGNOSTIC_LIMITS,
    onTransportDiagnostic(event) { events.push(`complete:${event.observationId}`); } });
  let first = null, firstAlias = null, conflictAlias = null;
  const observe = index => runtime.request(index, "debug_traceTransaction", [PIN.txHash, capture.CALL_CONFIG]).then(raw => {
    const alias = `obs-0${index + 1}`; events.push(`normalize:${alias}`);
    const original = capture.normalizeCallTrace(raw), view = f.parent.views[9];
    const { compoundEmitters, morphoEmitters } = f.parent.accountingScope;
    capture.bindCallTrace(original, view.transaction, view.receipt); accounting.extractCallAccounting(raw, original, { compoundEmitters, morphoEmitters });
    let bound;
    try { bound = domains.bindLogIndexDomainsDiagnostic(original, view.transaction, view.receipt); }
    catch (error) { conflictAlias = alias; throw error; }
    const value = capture.canonical(bound.frames);
    if (first === null) { first = value; firstAlias = alias; }
    else if (value !== first) { conflictAlias = alias; throw new Error("consensus-mismatch"); }
  });
  try {
    const results = await Promise.allSettled([observe(0), observe(1)]);
    assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].status, "rejected"); assert.equal(results[1].reason.message, "consensus-mismatch");
    assert.equal(firstAlias, "obs-01"); assert.equal(conflictAlias, "obs-02");
    assert.ok(events.indexOf("complete:obs-01") < events.indexOf("complete:obs-02"));
    for (const alias of ["obs-01", "obs-02"]) assert.ok(events.indexOf(`complete:${alias}`) < events.indexOf(`normalize:${alias}`));
    assert.ok(events.indexOf("normalize:obs-01") < events.indexOf("normalize:obs-02"));
    t.diagnostic(`${kind}: ${events.join(" -> ")}`);
    if (kind === "intrinsic") assert.equal(results[1].reason.indexDomainDiagnostic.kind, "empty-domain-intersection");
    assert.equal(runtime.snapshot().traceRequests, 2); assert.ok(f.calls.every(c => c.u === 9));
  } finally { await runtime.close(); }
  assert.equal(runtime.lifecycle().pending, 0); assert.equal(runtime.backoffSnapshot().activeOperations, 0);
  }
  // The actual fixed-profile collector must make the same attribution, without
  // promoting a generic core comparison into an intrinsic helper witness.
  const actual = failureFixture({ n: 10, hook(c) { if (c.index === 1 && isCall(c)) c.result.gas = "0x5209"; return { result: c.result }; } });
  const r = await run(actual); assert.equal(r.integrityFailure.observationId, "obs-02"); assert.equal(r.integrityFailure.universeIndex, 9); assert.equal(r.failureStage, null);
});
