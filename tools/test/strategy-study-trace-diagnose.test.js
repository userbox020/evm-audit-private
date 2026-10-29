"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const capture = require("../strategy-study/capture");
const collector = require("../strategy-study/trace-enrichment");
const accounting = require("../strategy-study/call-accounting");
const difference = require("../strategy-study/trace-difference");
const cli = require("../strategy-study/trace-diagnose-cli");
const ordinary = require("../strategy-study/trace-cli");
const { fixture, accountingFixture } = require("./strategy-study-trace.test");
const H = n => `0x${BigInt(n).toString(16).padStart(64, "0")}`, A = `0x${"11".repeat(20)}`;
const SENTINEL = "T1D_RAW_PRIVATE_SENTINEL", clone = value => structuredClone(value), START = Date.parse("2026-10-20T06:00:00Z");
const isCall = c => c.method === "debug_traceTransaction" && c.params[1].tracer === "callTracer";
const isState = c => c.method === "debug_traceTransaction" && c.params[1].tracer === "prestateTracer";
const run = f => collector.runFixtureDiagnostic({ parent: f.parent, runtimeOptions: f.options });
function temp() { const root = path.join(os.tmpdir(), "opencode"); fs.mkdirSync(root, { recursive: true }); return fs.mkdtempSync(path.join(root, "t1d-test-")); }
const read = (out, f, options = {}) => cli.readFixtureDiagnostic(out, options, { loadParent: () => f.parent });
async function published(f) {
  const root = temp(), out = path.join(root, "diagnostic"), writer = cli.createFixtureDiagnosticWriter(out), result = await run(f);
  const summary = writer.publish(result, f.parent, f.now);
  return { root, out, result, summary };
}
function mutateConflict(kind, c) {
  if (c.index !== 1) return;
  if (kind === "call-core" && isCall(c)) c.result.gas = "0x5209";
  if (kind === "log-index" && isCall(c)) c.result.logs[0].index = "0x9";
  if (kind === "state-core" && isState(c)) c.result.pre[A].balance = "0x65";
  if (kind === "code-hash" && isState(c)) c.result.pre[A].codeHash = H(999);
}
function injectedCollector({ extract = accounting.extractCallAccounting, describe = difference.describeTraceConflict } = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../strategy-study/trace-enrichment.js"), "utf8"), {
    module, __dirname: path.join(__dirname, "../strategy-study"), require(name) {
      if (name === "node:path") return path;
      if (name === "./capture") return capture;
      if (name === "./call-accounting") return { ...accounting, extractCallAccounting: extract };
      // The helper's strict plain-object gate is intentionally realm-local.
      if (name === "./trace-difference") return { ...difference, describeTraceConflict: input => describe(clone(input)) };
      assert.fail("unexpected dependency");
    },
  });
  return module.exports;
}

test("T1D whole 111-universe success qualifies the full pool but queries only fixture zero and grants no trace authority", async () => {
  const f = fixture({ n: 111, metadata: true }), p = await published(f);
  try {
    const r = p.result, loaded = read(p.out, f, { expectedManifestSha256: p.summary.manifestSha256 });
    assert.equal(r.status, "DIAGNOSTIC-COMPLETE", r.reason); assert.equal(r.schema, "strategy-study-t1-fixture-diagnostic/v1");
    assert.deepEqual(r.counts, { universe: 111, completed: 0, missing: 111 }); assert.equal(r.missingIndices.length, 111);
    assert.deepEqual(r.fixture, f.parent.universe[0]); assert.equal(r.finalAnchorRechecked, true); assert.equal(r.runtimeDrained, true);
    assert.equal(r.validAggregate, false); assert.equal(loaded.authority.validAggregate, false); assert.equal(r.aggregateEvidenceStatus, "NON-AUTHORITATIVE");
    assert.equal(r.features.costComplete, false); assert.equal(r.features.profitKnown, false); assert.equal(r.features.traceReceiptBound, false);
    assert.equal(r.diagnostic, null); assert.equal(r.diagnosticConstruction, "not-needed");
    assert.equal(Object.hasOwn(r, "traces"), false); assert.deepEqual(fs.readdirSync(p.out), ["terminaldiagnostic.json"]);
    assert.deepEqual(r.limits, collector.FIXTURE_DIAGNOSTIC_LIMITS); assert.equal(r.budget.traceRequests, 6); assert.equal(r.budget.logRequests, 0);
    assert.ok(f.calls.every(c => c.u === null || c.u === 0));
    const firstTrace = f.calls.findIndex(isCall);
    for (let i = 0; i < 3; i++) {
      assert.ok(f.calls.findIndex(c => c.index === i && c.method === "eth_getTransactionReceipt") < firstTrace);
      assert.equal(f.calls.filter(c => c.index === i && isCall(c)).length, 1); assert.equal(f.calls.filter(c => c.index === i && isState(c)).length, 1);
    }
    assert.deepEqual(r.selectedAliases, ["obs-01", "obs-02"]); assert.equal(r.observations[2].complete, true);
    assert.ok(!/RAW_PRIVATE|https:|alchemy|infura|publicnode|callFrames|stateAccounts|callAccounting/.test(JSON.stringify(loaded)));
    assert.throws(() => ordinary.readAuthoritativeTraces(p.out, { allowPartial: true }, { loadParent: () => f.parent }), /invalid-schema/);
    assert.throws(() => collector.runFixtureDiagnostic({ parent: f.parent, runtimeOptions: f.options, onTrace() { assert.fail("commit forbidden"); } }), /invalid-options/);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("T1D distinguishes call/state core and optional metadata conflicts without continuing after the first discrepancy", async () => {
  for (const kind of ["call-core", "log-index", "state-core", "code-hash"]) {
    const f = fixture({ metadata: true, hook(c) { mutateConflict(kind, c); return { result: c.result }; } }), p = await published(f);
    try {
      const r = p.result, d = read(p.out, f).diagnostic;
      assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.aggregateEvidenceStatus, "INVALID");
      assert.equal(r.diagnosticConstruction, "complete"); assert.equal(d.kind, kind); assert.equal(d.firstObservation, "obs-01"); assert.equal(d.currentObservation, "obs-02");
      assert.equal(r.counts.completed, 0); assert.deepEqual(r.selectedAliases, []); assert.equal(r.finalAnchorRechecked, false);
      assert.equal(f.calls.at(-1).index, 1); assert.equal(kind === "call-core" || kind === "log-index" ? isCall(f.calls.at(-1)) : isState(f.calls.at(-1)), true);
      assert.equal(f.calls.filter(c => c.index === 2 && c.method === "debug_traceTransaction").length, 0);
      const text = JSON.stringify(d); assert.ok(!text.includes(A)); assert.ok(!text.includes(H(999))); assert.ok(!text.includes(SENTINEL));
      if (kind === "call-core") {
        assert.equal(d.differences[0].field, "frame.gas"); assert.equal(d.differences[0].prior.value, "21000"); assert.equal(d.differences[0].current.value, "21001");
      } else if (kind === "log-index") assert.equal(d.differences[0].current.value, "9");
      else assert.ok(d.differences.every(row => row.prior.redacted && row.current.redacted && row.prior.value === null && row.current.value === null));
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});

test("optional metadata provenance follows its first supplier even when that later candidate subsequently retires", async () => {
  for (const kind of ["log-index", "code-hash"]) {
    const f = fixture({ metadata: true, hook(c) {
      if (kind === "log-index" && isCall(c)) {
        if (c.index === 0) c.result.logs.forEach(log => { delete log.index; });
        if (c.index === 2) c.result.logs[0].index = "0x9";
      }
      if (kind === "code-hash" && isState(c)) {
        if (c.index === 0) { delete c.result.pre[A].codeHash; delete c.result.post[A].codeHash; }
        if (c.index === 2) c.result.pre[A].codeHash = H(999);
      }
      if (c.index === 1 && ((kind === "log-index" && isState(c)) || (kind === "code-hash" && c.method === "eth_getTransactionReceipt"
          && c.fixture.calls.some(previous => previous.index === 1 && isState(previous))))) return { status: 403, raw: SENTINEL };
      return { result: c.result };
    } }), r = await run(f);
    assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.diagnostic.kind, kind);
    assert.equal(r.diagnostic.firstObservation, "obs-02"); assert.equal(r.diagnostic.currentObservation, "obs-03");
    assert.equal(r.observations[1].reason, "provider-http-failure");
    if (kind === "code-hash") { assert.equal(r.diagnostic.differences[0].accountIndex, 0); assert.equal(r.diagnostic.differences[0].side, "before"); }
  }
  const f = fixture({ metadata: true, hook(c) {
    if (c.index === 0 && isCall(c)) c.result.logs.forEach(log => { delete log.index; });
    if (c.index === 1 && isState(c)) { delete c.result.pre[A].codeHash; delete c.result.post[A].codeHash; }
    return { result: c.result };
  } }), r = await run(f);
  assert.equal(r.status, "DIAGNOSTIC-COMPLETE"); assert.equal(r.diagnostic, null); assert.equal(r.validAggregate, false);
});

test("out-of-uint64 gas remains redacted without changing conflict acceptance", async () => {
  const f = fixture({ hook(c) { if (c.index === 1 && isCall(c)) c.result.gas = "0x10000000000000000"; return { result: c.result }; } }), p = await published(f);
  try {
    const d = read(p.out, f).diagnostic; assert.equal(d.kind, "call-core"); assert.equal(p.result.reason, "consensus-mismatch");
    assert.equal(d.differences[0].field, "frame.gas"); assert.equal(d.differences[0].current.value, null); assert.equal(d.differences[0].current.redacted, true);
    assert.ok(!JSON.stringify(d).includes("18446744073709551616"));
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("accounting conflicts use their separate retained provenance and all nonnumeric values stay redacted", async () => {
  let calls = 0;
  const injected = injectedCollector({ extract(...args) {
    const rows = clone(accounting.extractCallAccounting(...args));
    if (calls++ === 0) rows[0].abiInterpretation.arguments.recipient = A;
    return rows;
  } });
  const f = accountingFixture({ hook(c) { if (c.index === 0 && isState(c)) return { status: 503, raw: SENTINEL }; } });
  const r = clone(await injected.runFixtureDiagnostic({ parent: f.parent, runtimeOptions: f.options }));
  assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.diagnostic.kind, "accounting"); assert.equal(calls, 2);
  assert.equal(r.diagnostic.firstObservation, "obs-01"); assert.equal(r.diagnostic.currentObservation, "obs-02");
  assert.equal(r.observations[0].reason, "provider-http-failure");
  assert.equal(r.diagnostic.differences[0].field, "accounting.recipient"); assert.equal(r.diagnostic.differences[0].prior.value, null);
  const root = temp(), out = path.join(root, "accounting");
  try { cli.createFixtureDiagnosticWriter(out).publish(r, f.parent, f.now); assert.equal(read(out, f).authority.validAggregate, false); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("core conflict stops before later metadata/accounting checks; helper failure preserves the first integrity latch", async () => {
  let extractions = 0, descriptions = 0;
  const injected = injectedCollector({ extract(...args) { extractions++; return accounting.extractCallAccounting(...args); }, describe() { descriptions++; throw new Error(SENTINEL); } });
  const f = fixture({ metadata: true, hook(c) {
    if (c.index === 1 && isCall(c)) { c.result.gas = "0x5209"; c.result.logs[0].index = "0x9"; }
    return { result: c.result };
  } }), r = clone(await injected.runFixtureDiagnostic({ parent: f.parent, runtimeOptions: f.options }));
  assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.diagnosticConstruction, "failed"); assert.equal(r.diagnostic, null);
  assert.equal(extractions, 1); assert.equal(descriptions, 1); assert.equal(f.calls.at(-1).index, 1); assert.ok(isCall(f.calls.at(-1)));
  const root = temp(), out = path.join(root, "construction-failed");
  try { cli.createFixtureDiagnosticWriter(out).publish(r, f.parent, f.now); assert.equal(read(out, f).manifest.reason, "consensus-mismatch"); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
  assert.ok(!JSON.stringify(r).includes(SENTINEL));
});

test("nontrace pinned fact contradictions stay strict without exposing header/transaction/receipt differences", async () => {
  const f = fixture({ hook(c) { if (c.index === 0 && c.method === "eth_getTransactionByHash") c.result.nonce = "0x9"; return { result: c.result }; } }), p = await published(f);
  try {
    assert.equal(p.result.reason, "consensus-mismatch"); assert.equal(p.result.diagnostic, null); assert.equal(p.result.diagnosticConstruction, "not-needed");
    assert.equal(p.result.budget.traceRequests, 0); assert.equal(read(p.out, f).authority.validAggregate, false);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("T1D reduced caps cannot enlarge, and every physical 429 retry stays inside request/trace budgets", async () => {
  const original = fixture();
  for (const limits of [{ requests: 301 }, { traceRequestCap: 65 }, { totalTimeoutMs: 600001 }, { totalResponseBytes: 64 * 1024 * 1024 + 1 }, { logRequests: 1 }, { concurrency: 3 }, { spacingMs: 999 }]) {
    assert.throws(() => collector.runFixtureDiagnostic({ parent: original.parent, runtimeOptions: { ...original.options, limits } }), /invalid-options/);
  }
  for (const limits of [{ requests: 1 }, { traceRequestCap: 1 }]) {
    const f = fixture({ limits, hook: c => (limits.requests || isCall(c)) ? { status: 429, raw: SENTINEL } : {} }), r = await run(f);
    assert.equal(r.status, "LIMIT-REACHED"); assert.match(r.reason, /request-budget-exhausted|trace-request-budget-exhausted/);
    assert.ok(r.budget.requests <= (limits.requests || 300)); assert.ok(r.budget.traceRequests <= (limits.traceRequestCap || 64));
    assert.equal(r.budget.requests, f.calls.length); assert.equal(r.validAggregate, false);
  }
  let seen = 0;
  const f = fixture({ hook(c) { if (c.index === 0 && isCall(c) && seen++ === 0) return { status: 429, raw: SENTINEL, headers: { "retry-after": "1" } }; } }), p = await published(f);
  try {
    assert.equal(p.result.status, "DIAGNOSTIC-COMPLETE"); assert.equal(p.result.backoff.retries, 1); assert.equal(p.result.budget.traceRequests, 7);
    assert.equal(p.result.budget.requests, f.calls.length); assert.ok(f.calls.every(c => c.u === null || c.u === 0));
    assert.equal(p.result.transportDiagnostics.find(d => d.httpStatus === 429).phase, "call-tracer");
    assert.equal(read(p.out, f).authority.validAggregate, false);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("shutdown expiry cannot replace the first conflict and expired diagnostics remain readable only as invalid evidence", async () => {
  const f = fixture({ hook(c) { mutateConflict("call-core", c); return { result: c.result }; } }), original = capture.createRuntime;
  capture.createRuntime = options => { const runtime = original(options); return Object.freeze({ ...runtime, close: async () => { await runtime.close(); f.setNow(Date.parse(capture.EXPIRES_AT)); } }); };
  const root = temp(), out = path.join(root, "expired");
  try {
    const r = await run(f); assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.lifecycleFailure, "session-expired"); assert.equal(r.runtimeDrained, true);
    cli.createFixtureDiagnosticWriter(out).publish(r, f.parent, f.now);
    const loaded = read(out, f); assert.equal(loaded.manifest.publicationExpired, true); assert.equal(loaded.manifest.status, "CAPTURE-FAILED");
    assert.equal(loaded.authority.validAggregate, false); assert.equal(loaded.manifest.aggregateEvidenceStatus, "INVALID");
  } finally { capture.createRuntime = original; fs.rmSync(root, { recursive: true, force: true }); }
});

test("late publication expiry cannot advertise fixture success, and final-anchor conflict prevents subsequent reads", async () => {
  const f = fixture(), result = await run(f), root = temp(), out = path.join(root, "late");
  try {
    assert.equal(result.status, "DIAGNOSTIC-COMPLETE");
    const summary = cli.createFixtureDiagnosticWriter(out).publish(result, f.parent, () => Date.parse(capture.EXPIRES_AT));
    assert.equal(summary.status, "LIMIT-REACHED"); assert.equal(summary.reason, "session-expired");
    const loaded = read(out, f); assert.equal(loaded.manifest.publicationExpired, true); assert.equal(loaded.authority.validAggregate, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const conflict = fixture({ hook(c) {
    if (c.index === 0 && c.method === "eth_getBlockByNumber" && c.params[0] === "0x3e8") c.result.stateRoot = H(999);
    return { result: c.result };
  } }), rejected = await run(conflict);
  assert.equal(rejected.reason, "consensus-mismatch"); assert.equal(rejected.integrityFailure.phase, "final-anchor-recheck");
  assert.equal(conflict.calls.filter(c => c.method === "eth_getBlockByHash" && c.params[0] === H(1000)).length, 0);
  assert.equal(rejected.diagnostic, null); assert.equal(rejected.counts.completed, 0);
});

test("strict INVALID publication rejects unknown names/values before any payload serialization", async () => {
  const f = fixture({ hook(c) { mutateConflict("call-core", c); return { result: c.result }; } }), base = await run(f), root = temp();
  try {
    const changes = [r => { r[SENTINEL] = SENTINEL; }, r => { r.integrityFailure.raw = SENTINEL; }, r => { r.integrityFailure.code = SENTINEL; },
      r => { r.integrityFailure.diagnostics = { category: SENTINEL, depth: 0, frameCount: 1, hasCalls: false, hasLogs: false }; },
      r => { r.transportDiagnostics[0].endpoint = SENTINEL; }, r => { r.observations[0].reason = SENTINEL; }, r => { r.provenance.raw = SENTINEL; },
      r => { r.diagnostic.differences[0].current.value = SENTINEL; }, r => { r.diagnostic.differences[0].field = SENTINEL; }, r => { r.traces = []; },
      r => { r.validAggregate = true; }, r => { r.status = "COMPLETE"; }, r => { r.diagnostic = null; }, r => { r.runtimeDrained = false; },
      r => { r.toJSON = () => { assert.fail("must reject before JSON serialization"); }; }];
    for (const [i, mutate] of changes.entries()) {
      const r = clone(base), out = path.join(root, String(i)), writer = cli.createFixtureDiagnosticWriter(out); mutate(r);
      assert.throws(() => writer.publish(r, f.parent, f.now), /invalid-schema/); assert.deepEqual(fs.readdirSync(out), []);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("diagnostic reader enforces file/payload hashes, fixed fixture, counts, caps, descriptor and authority whitelist", async () => {
  const f = fixture({ hook(c) { mutateConflict("call-core", c); return { result: c.result }; } }), p = await published(f);
  try {
    assert.throws(() => read(p.out, f, { expectedManifestSha256: "0".repeat(64) }), /invalid-schema/);
    const file = path.join(p.out, "terminaldiagnostic.json"), text = fs.readFileSync(file, "utf8"), base = JSON.parse(text);
    for (const mutate of [m => { m.counts.completed = 1; }, m => { m.counts.missing = 2; }, m => { m.missingIndices = []; },
      m => { m.fixture.txHash = H(999); }, m => { m.universe.reverse(); }, m => { m.limits.requests = 301; }, m => { m.limits.traceRequestCap = 65; },
      m => { m.budget.requests = 301; }, m => { m.transportDiagnostics[0].universeIndex = 1; }, m => { m.backoff.activeOperations = 1; },
      m => { m.transportDiagnostics[0].phase = "receipt-read"; },
      m => { m.reason = SENTINEL; }, m => { m.diagnostic.currentObservation = "obs-16"; }, m => { m.diagnostic.differences[0].prior.raw = SENTINEL; },
      m => { m.diagnostic.differences[0].current.value = "18446744073709551616"; }, m => { m.diagnostic.differences[0].field = "frame.value"; },
      m => { m.diagnosticConstruction = "not-needed"; }, m => { m.validAggregate = true; }, m => { m.schema = "strategy-study-t1/v1"; },
      m => { m.sourceC2ManifestSha256 = "0".repeat(64); }, m => { m.features.profitKnown = true; }, m => { m.provenance.transactionScope = "all-transactions"; }]) {
      const m = clone(base); mutate(m); delete m.payloadSha256; m.payloadSha256 = capture.sha256(capture.canonical(m)); fs.writeFileSync(file, JSON.stringify(m));
      assert.throws(() => read(p.out, f), /invalid-schema/);
    }
    fs.writeFileSync(file, text); fs.writeFileSync(path.join(p.out, "orphan.json"), "{}"); assert.throws(() => read(p.out, f), /invalid-schema/);
    fs.unlinkSync(path.join(p.out, "orphan.json")); fs.renameSync(file, path.join(p.out, "terminalmanifest.json"));
    assert.throws(() => read(p.out, f), /invalid-schema/); assert.throws(() => ordinary.readAuthoritativeTraces(p.out, { allowPartial: true }, { loadParent: () => f.parent }), /invalid-schema/);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("CLI reserves output and checks fixed parent/expiry before lazy loading; no chain/input/budget overrides", async () => {
  const root = temp(); let loads = 0;
  try {
    for (const extra of ["--chain=8453", "--input=other", "--tx=0x00", "--requests=1", "--endpoint=secret", "--diagnose-fixture"]) {
      assert.throws(() => cli.parseArgs(["--diagnose-fixture", "--chain=1", "--out=x", extra]), /invalid-options/);
    }
    for (const mode of ["exists", "expiry", "parent"]) {
      const out = path.join(root, mode); if (mode === "exists") fs.mkdirSync(out);
      const code = await cli.main(["--diagnose-fixture", "--chain=1", `--out=${out}`], {
        now: () => mode === "expiry" ? Date.parse(capture.EXPIRES_AT) : START,
        loadParent() { assert.equal(mode, "parent"); assert.ok(fs.existsSync(out)); throw new Error("invalid-schema"); },
        loadAuthorizedCandidates() { loads++; throw new Error(SENTINEL); }, print() {},
      });
      assert.equal(code, 2);
    }
    assert.equal(loads, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("CLI drains before disposal and publishes only afterward, including sanitized runtime initialization failure", async () => {
  for (const mode of ["success", "conflict", "initialize", "throw", "dispose", "load"]) {
    const f = fixture({ hook(c) { if (mode === "conflict") mutateConflict("call-core", c); return { result: c.result }; } });
    const root = temp(), out = path.join(root, mode), order = [], printed = [];
    try {
      const code = await cli.main(["--diagnose-fixture", "--chain=1", `--out=${out}`], {
        now: f.now, print: text => printed.push(text), loadParent() { assert.equal(order.at(-1), "reserve"); order.push("parent"); return f.parent; },
        createFixtureDiagnosticWriter(directory) { const writer = cli.createFixtureDiagnosticWriter(directory); order.push("reserve"); return { publish(...args) {
          assert.equal(order.at(-1), "dispose"); order.push("publish"); return writer.publish(...args);
        } }; },
        loadAuthorizedCandidates(options) {
          assert.deepEqual(options, { chainId: 1, cap: 16 }); order.push("load"); if (mode === "load") throw new Error(SENTINEL);
          return { candidates: f.candidates, getOrigin: () => "https://process-only.invalid", dispose() { order.push("dispose"); if (mode === "dispose") throw new Error(SENTINEL); } };
        },
        async runFixtureDiagnostic(options) {
          assert.equal(Object.hasOwn(options, "onTrace"), false); if (mode === "throw") throw new Error(SENTINEL);
          const result = await collector.runFixtureDiagnostic({ ...options, runtimeOptions: { ...f.options, ...options.runtimeOptions,
            ...(mode === "initialize" ? { backoffRandom: 1 } : {}) } });
          assert.equal(result.runtimeDrained, true); order.push("drain"); return result;
        },
      });
      assert.equal(code, mode === "success" ? 0 : 2, printed.join(""));
      const prefix = ["reserve", "parent", "load"];
      assert.deepEqual(order, mode === "load" ? prefix : mode === "throw" ? [...prefix, "dispose"] : mode === "dispose" ? [...prefix, "drain", "dispose"] : [...prefix, "drain", "dispose", "publish"]);
      assert.ok(!/T1D_RAW_PRIVATE|https:/.test(printed.join("")));
      if (["success", "conflict", "initialize"].includes(mode)) assert.equal(read(out, f).authority.validAggregate, false);
      else assert.deepEqual(fs.readdirSync(out), []);
      assert.ok(f.origins.every(origin => origin === "https://process-only.invalid"));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("reader rejects a symlinked diagnostic file", async t => {
  const f = fixture(), p = await published(f);
  try {
    const file = path.join(p.out, "terminaldiagnostic.json"), target = path.join(p.root, "copy.json"); fs.renameSync(file, target);
    try { fs.symlinkSync(target, file, "file"); } catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return t.skip("Windows symlink permission unavailable"); throw error; }
    assert.throws(() => read(p.out, f), /invalid-schema/);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
