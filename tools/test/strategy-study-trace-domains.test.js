"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const capture = require("../strategy-study/capture");
const collector = require("../strategy-study/trace-enrichment");
const cli = require("../strategy-study/trace-cli");
const diagnostic = require("../strategy-study/trace-diagnose-cli");
const domains = require("../strategy-study/log-index-domains");
const accounting = require("../strategy-study/call-accounting");
const { fixture, accountingFixture } = require("./strategy-study-trace.test");
const A = `0x${"11".repeat(20)}`, B = `0x${"22".repeat(20)}`, SENTINEL = "T2_PRIVATE_MUST_NOT_ESCAPE";
const H = n => `0x${BigInt(n).toString(16).padStart(64, "0")}`, Q = n => `0x${BigInt(n).toString(16)}`, clone = value => structuredClone(value);
const isCall = c => c.method === "debug_traceTransaction" && c.params[1].tracer === "callTracer";
const isState = c => c.method === "debug_traceTransaction" && c.params[1].tracer === "prestateTracer";
function domainFixture(options = {}) {
  const create = options.accounting ? accountingFixture : fixture;
  return create({ ...options, metadata: options.metadata ?? true, hook(c) {
    if (isCall(c)) {
      let ordinal = 0;
      const receiptLogs = c.fixture.receipt(c.u).logs;
      function walk(frame, ancestorsCommitted = true) {
        const committed = ancestorsCommitted && !frame.error, children = frame.calls || [];
        for (let position = 0; position <= children.length; position++) {
          for (const log of frame.logs || []) if (BigInt(log.position) === BigInt(position) && committed) {
            const domain = options.domains?.[c.index] || (c.index === 1 ? "LOCAL_DENSE" : "GLOBAL"), reported = options.reported?.[c.index];
            if (domain === "NONE" || (reported && !reported.includes(ordinal))) delete log.index;
            else log.index = domain === "GLOBAL" ? receiptLogs[ordinal].logIndex : Q(ordinal);
            ordinal++;
          }
          if (position < children.length) walk(children[position], committed);
        }
      }
      walk(c.result);
    }
    return options.hook ? options.hook(c) || { result: c.result } : { result: c.result };
  } });
}
const run = (f, extras = {}) => collector.runDomainEnrichment({ parent: f.parent, runtimeOptions: f.options, ...extras });
function temp() { const root = path.join(os.tmpdir(), "opencode"); fs.mkdirSync(root, { recursive: true }); return fs.mkdtempSync(path.join(root, "t2-test-")); }
const read = (out, f, options = {}) => cli.readAuthoritativeTraces(out, options, { loadParent: () => f.parent });
async function published(f) {
  const root = temp(), out = path.join(root, "capture"), writer = cli.createTraceWriter(out);
  const result = await run(f, { onTrace: writer.onTrace }), summary = writer.publish(result, f.parent, f.now);
  return { root, out, result, summary };
}
function reseal(m, row, out) {
  delete row.evidenceSha256; row.evidenceSha256 = capture.sha256(capture.canonical(row));
  const text = JSON.stringify(row); fs.writeFileSync(path.join(out, "trace00001.json"), text);
  m.traces[0].sha256 = capture.sha256(text); m.traces[0].evidenceSha256 = row.evidenceSha256;
  delete m.manifestEvidenceSha256; m.manifestEvidenceSha256 = capture.sha256(capture.canonical(m));
  fs.writeFileSync(path.join(out, "terminalmanifest.json"), JSON.stringify(m));
}

test("T2 explicitly versions all 111 rows, qualifies every provider then reuses the fixture and immutable pair across domains", async () => {
  const f = domainFixture({ n: 111 }), p = await published(f);
  try {
    const r = p.result, loaded = read(p.out, f, { expectedManifestSha256: p.summary.manifestSha256 });
    assert.equal(r.status, "COMPLETE", r.reason); assert.equal(r.schema, "strategy-study-t2/v1"); assert.equal(r.traces.length, 111);
    assert.equal(r.indexSemantics, "receipt-global-domain-validated"); assert.deepEqual(r.indexProvenance, collector.INDEX_PROVENANCE);
    assert.ok(!r.limitations.includes(collector.NOTES[2]), "T2 must not describe its canonical index as raw T1 metadata");
    assert.equal(r.indexProvenance.evidenceClassification, "per-observation-validated-metadata"); assert.equal(r.indexProvenance.omittedMetadataAbsenceProven, false);
    assert.equal(loaded.authority.validAggregate, true); assert.equal(r.finalAnchorRechecked, true); assert.equal(r.runtimeDrained, true);
    assert.deepEqual(r.limits, capture.ENRICHMENT_LIMITS); assert.equal(r.budget.traceRequests, 446); assert.equal(r.budget.logRequests, 0);
    assert.ok(r.budget.requests < 3000); assert.deepEqual(r.selectedAliases, ["obs-01", "obs-02"]);
    const firstTrace = f.calls.findIndex(isCall), nextTx = f.calls.findIndex(c => c.u === 1);
    for (let i = 0; i < 3; i++) {
      assert.ok(f.calls.findIndex(c => c.index === i && c.method === "eth_getTransactionReceipt") < firstTrace);
      assert.ok(f.calls.findIndex(c => c.index === i && isState(c)) < nextTx);
      assert.equal(f.calls.filter(c => c.index === i && c.u === 0 && isCall(c)).length, 1);
    }
    assert.ok(f.calls.slice(nextTx).every(c => c.index < 2));
    const row = loaded.traces[0]; assert.equal(row.schema, "strategy-study-t2-trace/v1");
    assert.deepEqual(row.callFrames[0].logs.map(log => log.index), ["10", "11"]);
    assert.deepEqual(row.logIndexObservations.map(o => [o.observationId, o.candidateDomains]), [["obs-01", ["GLOBAL"]], ["obs-02", ["LOCAL_DENSE"]]]);
    assert.equal(row.logIndexObservations[1].bindings[0].observedIndex, "0"); assert.equal(row.logIndexObservations[1].bindings[0].receiptLogIndex, "10");
    assert.equal(row.metadataCoverage.logIndex.reportedBoth, 2); assert.equal(row.metadataCoverage.codeHashSides.reportedBoth, 2);
    assert.equal(row.sourceRuntimeVerified, false); assert.equal(row.costComplete, false); assert.equal(row.profitKnown, false);
    assert.throws(() => diagnostic.readFixtureDiagnostic(p.out, {}, { loadParent: () => f.parent }), /invalid-schema/);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("T1 and T1D still reject differing raw indexes instead of silently converting domains", async () => {
  for (const runner of [collector.runEnrichment, collector.runFixtureDiagnostic]) {
    const f = domainFixture(), r = await runner({ parent: f.parent, runtimeOptions: f.options });
    assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(Object.hasOwn(r, "indexSemantics"), false);
    assert.equal(Object.hasOwn(r, "indexProvenance"), false);
    if (r.diagnostic) { assert.equal(r.diagnostic.kind, "log-index"); assert.equal(r.diagnostic.differences[0].prior.value, "10"); assert.equal(r.diagnostic.differences[0].current.value, "0"); }
  }
});

test("T2 preserves ambiguous zero-base, subset gaps and unknown absent metadata without one-sided promotion", async () => {
  for (const mode of ["zero-base", "subset", "disjoint", "one-absent", "all-absent"]) {
    const f = domainFixture({ logOffset: mode === "zero-base" ? 0 : 10, logAddresses: Array(4).fill(B),
      domains: mode === "one-absent" ? ["GLOBAL", "NONE", "GLOBAL"] : mode === "all-absent" ? ["NONE", "NONE", "NONE"] : undefined,
      reported: mode === "subset" ? [[0, 2], [2, 3], [0, 1, 2, 3]] : mode === "disjoint" ? [[0, 2], [1, 3], [0, 1, 2, 3]] : undefined }), p = await published(f);
    try {
      assert.equal(p.result.status, "COMPLETE", `${mode}: ${p.result.reason}`);
      const row = read(p.out, f).traces[0], [left, right] = row.logIndexObservations;
      assert.equal(left.totalCommittedLogs, 4); assert.equal(right.totalCommittedLogs, 4); assert.equal(row.metadataCoverage.logIndex.total, 4);
      if (mode === "zero-base") {
        assert.deepEqual(left.candidateDomains, ["GLOBAL", "LOCAL_DENSE"]); assert.deepEqual(right.candidateDomains, ["GLOBAL", "LOCAL_DENSE"]);
        assert.equal(row.metadataCoverage.logIndex.reportedBoth, 4);
      } else if (mode === "subset") {
        assert.deepEqual(left.bindings.map(b => b.receiptOrdinal), [0, 2]); assert.deepEqual(right.bindings.map(b => b.receiptOrdinal), [2, 3]);
        assert.equal(right.bindings[0].observedIndex, "2", "full receipt ordinal, not ordinal among reported entries");
        assert.deepEqual(row.callFrames[0].logs.map(log => log.index), [undefined, undefined, "12", undefined]);
        assert.equal(row.metadataCoverage.logIndex.reportedBoth, 1); assert.equal(left.unreported, 2); assert.equal(right.unreported, 2);
      } else {
        assert.equal(row.metadataCoverage.logIndex.reportedBoth, 0); assert.ok(row.callFrames[0].logs.every(log => !Object.hasOwn(log, "index")));
        if (mode !== "disjoint") { assert.deepEqual(right.candidateDomains, []); assert.equal(right.reported, 0); assert.equal(right.unreported, 4); }
        if (mode === "all-absent") { assert.deepEqual(left.candidateDomains, []); assert.equal(left.reported, 0); }
      }
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});

test("frame0/log0 at committed receipt ordinal23 maps local23 and global395 by execution order, not frame order", async () => {
  const f = domainFixture({ logOffset: 372, logAddresses: Array(24).fill(B), trace(raw) {
    const logs = raw.logs; raw.logs = [{ ...logs[23], position: "0x1" }];
    raw.calls = [{ type: "CALL", from: B, to: B, gas: "0x1000", gasUsed: "0x100", input: "0x", output: "0x", logs: logs.slice(0, 23) }];
    return raw;
  } }), p = await published(f);
  try {
    assert.equal(p.result.status, "COMPLETE", p.result.reason); const row = read(p.out, f).traces[0];
    assert.equal(row.callFrames[0].logs[0].index, "395");
    for (const [i, observedIndex] of [[0, "395"], [1, "23"]]) {
      assert.deepEqual(row.logIndexObservations[i].bindings[23], { frameIndex: 0, logIndex: 0, receiptOrdinal: 23, receiptLogIndex: "395", observedIndex });
      assert.equal(row.logIndexObservations[i].bindings[0].frameIndex, 1);
    }
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("all invalid/mixed/gapped/uncommitted indexes fail on the individual observation before pairing or retirement", async () => {
  for (const mode of ["same-invalid", "mixed", "gapped", "uncommitted"]) {
    const f = domainFixture({ hook(c) {
      if (!isCall(c)) return { result: c.result };
      if (mode === "same-invalid") c.result.logs.forEach(log => { log.index = "0x63"; });
      if (mode === "mixed") { c.result.logs[0].index = "0xa"; c.result.logs[1].index = "0x1"; }
      if (mode === "gapped") { c.result.logs[0].index = "0x0"; c.result.logs[1].index = "0x2"; }
      if (mode === "uncommitted") c.result.calls = [{ type: "CALL", from: B, to: B, gas: "0x100", gasUsed: "0x10", input: "0x", error: SENTINEL,
        logs: [{ ...c.result.logs[0], index: "0x0" }] }];
      return { result: c.result };
    } }), r = await run(f);
    assert.equal(r.status, "CAPTURE-FAILED", mode); assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.integrityFailure.phase, "call-tracer");
    assert.equal(r.traces.length, 0); assert.deepEqual(r.selectedAliases, []); assert.equal(r.budget.traceRequests, 1);
    assert.ok(!f.calls.some(isState)); assert.equal(r.observations[0].reason, null); assert.ok(!JSON.stringify(r).includes(SENTINEL));
  }
});

test("valid uncommitted emissions without indexes do not change the committed metadata denominator", async () => {
  const f = domainFixture({ trace(raw) {
    const log = { ...raw.logs[0] }; delete log.index;
    raw.calls = [{ type: "CALL", from: B, to: B, gas: "0x100", gasUsed: "0x10", input: "0x", error: SENTINEL, logs: [log] }];
    return raw;
  } }), p = await published(f);
  try {
    assert.equal(p.result.status, "COMPLETE", p.result.reason); const row = read(p.out, f).traces[0];
    assert.equal(row.metadataCoverage.logIndex.total, 3); assert.equal(row.metadataCoverage.logIndex.reportedBoth, 2); assert.equal(row.metadataCoverage.logIndex.unknown, 1);
    assert.ok(row.logIndexObservations.every(o => o.totalCommittedLogs === 2 && o.reported === 2 && o.unreported === 0));
    assert.equal(Object.hasOwn(row.callFrames[1].logs[0], "index"), false);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("gas/state/codeHash and derived accounting remain strict; earlier canonical facts survive later candidate failures", async () => {
  for (const field of ["gas", "state", "codeHash", "accounting-raw"]) {
    const f = domainFixture({ accounting: true, hook(c) {
      if (c.index === 0 && isCall(c) && field === "gas") c.result.gas = "0x5209";
      if (c.index === 0 && isCall(c) && field === "accounting-raw") c.result.calls[0].output = `0x${"00".repeat(64)}`;
      if (c.index === 0 && isState(c) && field === "state") c.result.pre[A].balance = "0x65";
      if (c.index === 0 && isState(c) && field === "codeHash") c.result.pre[A].codeHash = H(999);
      if (c.index === 0 && (["gas", "accounting-raw"].includes(field) ? isState(c) : c.method === "eth_getTransactionReceipt" && c.fixture.calls.some(previous => previous.index === 0 && isState(previous)))) {
        return { status: 403, raw: SENTINEL };
      }
      return { result: c.result };
    } }), r = await run(f);
    assert.equal(r.reason, "consensus-mismatch", field); assert.equal(r.aggregateEvidenceStatus, "INVALID"); assert.equal(r.traces.length, 0);
    assert.equal(r.observations[0].reason, "provider-http-failure");
  }
});

test("original normalized indexes bind accounting without mutation, and derived-only conflicts still invalidate T2", async () => {
  let extractions = 0, corrupt = false;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../strategy-study/trace-enrichment.js"), "utf8"), {
    module, __dirname: path.join(__dirname, "../strategy-study"), require(name) {
      if (name === "node:path") return path;
      if (name === "./capture") return capture;
      if (name === "./log-index-domains") return { bindLogIndexDomains(...args) { return domains.bindLogIndexDomains(...args.map(clone)); } };
      if (name === "./call-accounting") return { ...accounting, extractCallAccounting(raw, frames, scope) {
        const before = capture.canonical({ raw, frames });
        assert.equal(capture.canonical(frames), capture.canonical(capture.normalizeCallTrace(raw)));
        const rows = clone(accounting.extractCallAccounting(raw, frames, scope));
        assert.equal(capture.canonical({ raw, frames }), before);
        if (corrupt && extractions === 0) rows[0].abiInterpretation.arguments.recipient = A;
        extractions++; return rows;
      } };
      assert.fail("unexpected dependency");
    },
  });
  const f = domainFixture({ accounting: true }), r = await module.exports.runDomainEnrichment({ parent: f.parent, runtimeOptions: f.options });
  assert.equal(r.status, "COMPLETE", r.reason); assert.equal(extractions, 7); assert.equal(r.traces[0].logIndexObservations[1].bindings[0].observedIndex, "0");
  assert.equal(r.traces[0].callFrames[0].logs[0].index, "10"); assert.equal(r.traces[0].callAccounting[1].abiInterpretation.returns.result.repaidAssets, "37");
  corrupt = true; extractions = 0;
  const bad = domainFixture({ accounting: true, hook(c) { if (c.index === 0 && isState(c)) return { status: 403, raw: SENTINEL }; } });
  const rejected = await module.exports.runDomainEnrichment({ parent: bad.parent, runtimeOptions: bad.options });
  assert.equal(rejected.reason, "consensus-mismatch"); assert.equal(rejected.traces.length, 0); assert.equal(extractions, 2);
});

test("T2 reader rejects rehashed domain/count/location/alias/provenance and canonical intersection tampering", async () => {
  const f = domainFixture({ reported: [[0, 1], [1], [0, 1]] }), p = await published(f);
  try {
    const original = read(p.out, f), base = original.manifest, row = original.traces[0];
    for (const mutate of [r => { r.logIndexObservations.pop(); }, r => { r.logIndexObservations.reverse(); }, r => { r.logIndexObservations[1].observationId = "obs-01"; },
      r => { r.logIndexObservations[0].candidateDomains = ["LOCAL_DENSE"]; }, r => { r.logIndexObservations[0].candidateDomains = ["GLOBAL", "GLOBAL"]; },
      r => { r.logIndexObservations[0].reported = 1; }, r => { r.logIndexObservations[1].unreported = 0; }, r => { r.logIndexObservations[0].totalCommittedLogs = 3; },
      r => { r.logIndexObservations[0].bindings[0].observedIndex = "99"; }, r => { r.logIndexObservations[0].bindings[0].receiptLogIndex = "11"; },
      r => { r.logIndexObservations[0].bindings[0].receiptOrdinal = 1; }, r => { r.logIndexObservations[1].bindings[0].frameIndex = 1; },
      r => { r.logIndexObservations[1].bindings[0].logIndex = 0; }, r => { r.logIndexObservations[0].bindings[1] = clone(r.logIndexObservations[0].bindings[0]); },
      r => { r.logIndexObservations[0].bindings[0].raw = SENTINEL; }, r => { r.logIndexObservations[0].client = SENTINEL; },
      r => { r.callFrames[0].logs[0].index = "10"; r.metadataCoverage.logIndex.reportedBoth = 2; r.metadataCoverage.logIndex.unknown = 0; },
      r => { delete r.callFrames[0].logs[1].index; r.metadataCoverage.logIndex.reportedBoth = 0; r.metadataCoverage.logIndex.unknown = 2; },
      r => { r.callFrames[0].logs[1].index = "1"; }, r => { r.indexSemantics = "raw"; }, r => { r.indexProvenance.rawIndexEqualityClaimed = true; },
      r => { delete r.logIndexObservations; }, r => { r.schema = "strategy-study-t1-trace/v1"; }]) {
      const m = clone(base), changed = clone(row); mutate(changed); reseal(m, changed, p.out);
      assert.throws(() => read(p.out, f), /invalid-schema/);
    }
    for (const mutate of [m => { m.schema = "strategy-study-t1/v1"; }, m => { delete m.indexSemantics; }, m => { m.indexSemantics = "raw"; },
      m => { m.indexProvenance.omittedMetadataAbsenceProven = true; }, m => { m.indexProvenance.raw = SENTINEL; }]) {
      const m = clone(base); mutate(m); reseal(m, clone(row), p.out); assert.throws(() => read(p.out, f), /invalid-schema/);
    }
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("old T1 authority cannot gain T2 fields and T2 provenance cannot prove an omitted raw index was absent", async () => {
  const f = fixture({ metadata: true }), root = temp(), out = path.join(root, "t1");
  try {
    const writer = cli.createTraceWriter(out), r = await collector.runEnrichment({ parent: f.parent, runtimeOptions: f.options, onTrace: writer.onTrace });
    writer.publish(r, f.parent, f.now); const original = read(out, f);
    assert.equal(original.manifest.schema, "strategy-study-t1/v1"); assert.equal(original.traces[0].callFrames[0].logs[0].index, "0");
    const row = clone(original.traces[0]), m = clone(original.manifest); row.indexSemantics = collector.INDEX_SEMANTICS; reseal(m, row, out);
    assert.throws(() => read(out, f), /invalid-schema/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const t2 = domainFixture(), p = await published(t2);
  try {
    const original = read(p.out, t2), m = clone(original.manifest), row = clone(original.traces[0]);
    // A coherent different provenance assertion cannot be authenticated without
    // the retained external manifest digest; never claim recovery of omissions.
    for (const o of row.logIndexObservations) { o.candidateDomains = []; o.reported = 0; o.unreported = 2; o.bindings = []; }
    row.callFrames[0].logs.forEach(log => { delete log.index; }); row.metadataCoverage.logIndex.reportedBoth = 0; row.metadataCoverage.logIndex.unknown = 2;
    reseal(m, row, p.out);
    assert.throws(() => read(p.out, t2, { expectedManifestSha256: p.summary.manifestSha256 }), /invalid-schema/);
    assert.equal(row.indexProvenance.omittedMetadataAbsenceProven, false);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("T2 CLI dispatch is explicit with unchanged expiry/output/parent/adapter ordering and no fallback", async () => {
  assert.equal(cli.parseArgs(["--enrich", "--index-domains", "--chain=1", "--out=x"]).indexDomains, true);
  assert.equal(Object.hasOwn(cli.parseArgs(["--enrich", "--chain=1", "--out=x"]), "indexDomains"), false);
  for (const args of [["--index-domains", "--chain=1", "--out=x"], ["--enrich", "--index-domains", "--index-domains", "--chain=1", "--out=x"],
    ["--enrich", "--index-domains", "--chain=8453", "--out=x"], ["--enrich", "--index-domains", "--chain=1", "--out=x", "--domain=GLOBAL"]]) assert.throws(() => cli.parseArgs(args), /invalid-options/);
  for (const enabled of [false, true]) {
    const f = enabled ? domainFixture() : fixture(), root = temp(), out = path.join(root, "cli"), order = [], printed = [];
    try {
      const execute = async (options, domain) => {
        assert.equal(domain, enabled); order.push(domain ? "T2" : "T1");
        const result = await (domain ? collector.runDomainEnrichment : collector.runEnrichment)({ ...options, runtimeOptions: { ...f.options, ...options.runtimeOptions } });
        assert.equal(result.runtimeDrained, true); order.push("drained"); return result;
      };
      const code = await cli.main(["--enrich", ...(enabled ? ["--index-domains"] : []), "--chain=1", `--out=${out}`], {
        now: f.now, print: value => printed.push(value), loadParent() { assert.equal(order.at(-1), "reserved"); order.push("parent"); return f.parent; },
        createTraceWriter(directory) { const writer = cli.createTraceWriter(directory); order.push("reserved"); return { ...writer, publish(...args) {
          assert.equal(order.at(-1), "disposed"); order.push("published"); return writer.publish(...args);
        } }; },
        loadAuthorizedCandidates() { order.push("loaded"); return { candidates: f.candidates, getOrigin: () => null, dispose() { assert.equal(order.at(-1), "drained"); order.push("disposed"); } }; },
        runEnrichment: options => execute(options, false), runDomainEnrichment: options => execute(options, true),
      });
      assert.equal(code, 0, printed.join("")); assert.deepEqual(order, ["reserved", "parent", "loaded", enabled ? "T2" : "T1", "drained", "disposed", "published"]);
      assert.equal(read(out, f).manifest.schema, enabled ? "strategy-study-t2/v1" : "strategy-study-t1/v1");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  let loaded = 0;
  for (const mode of ["expired", "bad-parent"]) {
    const root = temp(), out = path.join(root, mode);
    try {
      assert.equal(await cli.main(["--enrich", "--index-domains", "--chain=1", `--out=${out}`], { now: () => mode === "expired" ? Date.parse(capture.EXPIRES_AT) : Date.parse("2026-10-20T06:00:00Z"),
        loadParent() { throw new Error("invalid-schema"); }, loadAuthorizedCandidates() { loaded++; throw new Error(SENTINEL); }, print() {} }), 2);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  assert.equal(loaded, 0);
});

test("T2 selected-pair failure keeps the exact missing suffix and late integrity still invalidates saved rows", async () => {
  for (const integrity of [false, true]) {
    const f = domainFixture({ hook(c) {
      if (c.index === 0 && c.u === 1 && isCall(c)) {
        if (!integrity) return { status: 503, raw: SENTINEL };
        c.result.logs[0].index = "0x63";
      }
      return { result: c.result };
    } }), p = await published(f);
    try {
      assert.equal(p.result.traces.length, 1); assert.deepEqual(p.result.missingIndices, [1, 2]); assert.equal(p.result.status, integrity ? "CAPTURE-FAILED" : "ACCESS-BLOCKED");
      assert.ok(!f.calls.some(c => c.u === 2)); assert.ok(f.calls.filter(c => c.u === 1).every(c => c.index < 2));
      if (integrity) assert.throws(() => read(p.out, f, { allowPartial: true }), /invalid-schema/);
      else assert.equal(read(p.out, f, { allowPartial: true }).authority.aggregateEvidenceStatus, "PARTIAL");
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});
