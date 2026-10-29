"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const capture = require("../strategy-study/capture"), previous = require("../strategy-study/trace-enrichment"), oldCli = require("../strategy-study/trace-cli");
const pilot = require("../strategy-study/compound-b-pilot"), cli = require("../strategy-study/compound-b-pilot-cli"), accounting = require("../strategy-study/compound-b-accounting");
const { fixture } = require("./strategy-study-trace.test"), { H, Q, A, B } = require("./strategy-study-emission-proof.test");
const { parseAuthorizedInventory } = require("../strategy-study/authorized-inventory");
const clone = value => structuredClone(value), INDEX = 41, PIN = pilot.FIXTURE, OFFSET = Number(PIN.blockNumber) - 141, SENTINEL = "PRIVATE_B_PILOT_SENTINEL";
const isCall = c => c.method === "debug_traceTransaction" && c.params[1].tracer === "callTracer", isState = c => c.method === "debug_traceTransaction" && c.params[1].tracer === "prestateTracer";
function pilotFixture(options = {}) {
  const f = fixture({ n: 111, metadata: true, logAddresses: Array(13).fill(B), ...options, hook(c) {
    if (c.u === INDEX) {
      if (c.method === "eth_getTransactionByHash" || isCall(c)) c.result.gas = Q(1000000);
      if (c.method === "eth_getTransactionReceipt" || isCall(c)) c.result.gasUsed = Q(855908);
      if (c.method === "eth_getTransactionReceipt") { c.result.cumulativeGasUsed = Q(855908); c.result.effectiveGasPrice = Q(2509170716); }
    }
    return options.hook?.(c) || { result: c.result };
  } });
  const number = n => n === 1000 ? Number(capture.EMISSION_FIXTURE.anchorNumber) : n === 1001 ? Number(capture.EMISSION_FIXTURE.anchorNumber) + 1 : n + OFFSET;
  const hashes = new Map([[H(10000 + INDEX), PIN.txHash]]);
  for (let n = 99; n <= 1001; n++) hashes.set(H(n), n === 141 ? PIN.blockHash : n === 1000 ? capture.EMISSION_FIXTURE.anchorHash : H(number(n)));
  const reverse = new Map([...hashes].map(([a, b]) => [b, a]));
  function translate(value) {
    if (typeof value === "string") return hashes.get(value) || value;
    if (Array.isArray(value)) return value.map(translate);
    if (!value || typeof value !== "object") return value;
    const target = value.blockHash === H(141) || value.txHash === H(10000 + INDEX);
    return Object.fromEntries(Object.entries(value).map(([key, v]) => {
      if (["number", "blockNumber"].includes(key) && typeof v === "string") return [key, v.startsWith("0x") ? Q(number(Number(BigInt(v)))) : String(number(Number(v)))];
      if (key === "transactionIndex" && target) return [key, v.startsWith("0x") ? Q(113) : "113"];
      if (key === "transactions" && Array.isArray(v) && v.length === 1 && v[0] === H(10000 + INDEX)) return [key, [...Array.from({ length: 113 }, (_, i) => H(50000 + i)), PIN.txHash]];
      return [key, translate(v)];
    }));
  }
  f.parent = translate(f.parent); f.parent.scope = clone(pilot.SCOPE); f.parent.views[INDEX].transaction.gas = "1000000";
  Object.assign(f.parent.views[INDEX].receipt, { gasUsed: "855908", cumulativeGasUsed: "855908", effectiveGasPrice: "2509170716" });
  f.options.shared = { getOrigin: () => null }; const fetch = f.options.fetch; f.actualCalls = [];
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
function replaceResponse(f, matches, respond) { const fetch = f.options.fetch; f.options.fetch = async (url, init) => {
  const response = await fetch(url, init), req = { ...JSON.parse(init.body), index: f.candidates.indexOf(url) }; return matches(req) ? respond(req) : response;
}; }
const run = f => pilot.runCompoundBPilot({ parent: f.parent, runtimeOptions: f.options });
const read = (out, f, options = {}) => cli.readCompoundBPilot(out, options, { loadCompoundBParent: () => f.parent });
function temp() { const root = path.join(os.tmpdir(), "opencode"); fs.mkdirSync(root, { recursive: true }); return fs.mkdtempSync(path.join(root, "b1-test-")); }
async function published(f) { const root = temp(), out = path.join(root, "pilot"); try {
  const result = await run(f), summary = cli.createCompoundBWriter(out).publish(result, f.parent, f.now); return { root, out, result, summary };
} catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; } }
function rehash(file, m) { delete m.payloadSha256; m.payloadSha256 = capture.sha256(capture.canonical(m)); fs.writeFileSync(file, JSON.stringify(m)); }
function diagnosticParent(f, implementation = pilot, mutate = () => {}) {
  const source = { manifestSha256: pilot.B1R_SHA256, manifest: { status: "CAPTURE-FAILED", reason: "consensus-mismatch", aggregateEvidenceStatus: "INVALID", runtimeDrained: true,
    capsule: null, validPilotAggregate: false, validStudyAggregate: false, fixture: { universeIndex: 41 }, budget: { requests: 61, traceRequests: 1, logRequests: 0 },
    integrityFailure: { code: "consensus-mismatch", phase: "call-tracer", observationId: "obs-02", universeIndex: 41 },
    observations: [{ call: "not-tested", state: "not-tested", complete: false }],
    transportDiagnostics: [{ method: "debug_traceTransaction", phase: "call-tracer", observationId: "obs-02", universeIndex: 41, outcome: "passed", code: null }] } };
  mutate(source);
  return implementation.loadCompoundBIndexDiagnosticParent({ loadCompoundBParent: () => f.parent, readCompoundBPilot(directory, options, dependencies) {
    assert.equal(directory, pilot.B1R_PATH); assert.deepEqual(options, { expectedManifestSha256: pilot.B1R_SHA256 }); assert.ok(dependencies.loadCompoundBParent() === f.parent); return source;
  } });
}
function rejectionTrace(raw, kind) {
  if (kind === "uncommitted-index") raw.calls = [{ type: "CALL", from: B, to: B, value: "0x0", gas: "0x100", gasUsed: "0x1", input: "0x", output: "0x", error: SENTINEL,
    logs: [{ address: B, topics: [H(1)], data: "0x1234", position: "0x0", index: "0x123" }] }];
  else raw.logs[7].index = kind === "redacted" ? Q(1n << 64n) : "0x99";
  return raw;
}
const diagnose = (f, parent = diagnosticParent(f)) => pilot.runCompoundBIndexDiagnostic({ parent, runtimeOptions: f.options });
async function publishedDiagnostic(f, result = null, parent = diagnosticParent(f)) {
  const root = temp(), out = path.join(root, "diagnostic");
  try { result ||= await diagnose(f, parent); const summary = cli.createCompoundBIndexDiagnosticWriter(out).publish(result, parent, f.now); return { root, out, result, parent, summary }; }
  catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
}
const readDiagnostic = p => cli.readCompoundBIndexDiagnostic(p.out, {}, { loadCompoundBIndexDiagnosticParent: () => p.parent });
const forensicFixture = options => pilotFixture({ logOffset: 491, ...options });
function forensicParent(f, implementation = pilot, mutate = () => {}) {
  const parent = diagnosticParent(f, implementation), source = { manifestSha256: pilot.B1DR_SHA256, manifest: {
    sourceB1RManifestSha256: pilot.B1R_SHA256, status: "CAPTURE-FAILED", reason: "consensus-mismatch", aggregateEvidenceStatus: "INVALID", runtimeDrained: true,
    capsule: null, validPilotAggregate: false, validStudyAggregate: false, basicPoolComplete: true, basicPairIndependent: true, failureStage: "index-domain", diagnosticConstruction: "complete",
    observations: [{ id: "obs-02", basic: "passed", call: "not-tested", state: "not-tested", complete: false }],
    integrityFailure: { code: "consensus-mismatch", phase: "call-tracer", observationId: "obs-02", universeIndex: 41 },
    diagnostic: { observationId: "obs-02", universeIndex: 41, rejection: { schema: "strategy-study-index-domain-rejection/v1", kind: "empty-domain-intersection", candidateCount: 0,
      witnesses: ["GLOBAL", "LOCAL_DENSE"].map(eliminates => ({ eliminates, frameIndex: 51, logIndex: 0, receiptOrdinal: 0, receiptLogIndex: { value: "491", redacted: false }, observedIndex: { value: "12", redacted: false } })) } },
    transportDiagnostics: [{ method: "debug_traceTransaction", phase: "call-tracer", attempt: 1, observationId: "obs-02", universeIndex: 41, outcome: "passed", code: null }],
  } }; mutate(source);
  return implementation.loadCompoundBCallForensicParent({ loadCompoundBIndexDiagnosticParent: () => parent, readCompoundBIndexDiagnostic(directory, options, dependencies) {
    assert.equal(directory, pilot.B1DR_PATH); assert.deepEqual(options, { expectedManifestSha256: pilot.B1DR_SHA256 }); assert.ok(dependencies.loadCompoundBIndexDiagnosticParent() === parent); return source;
  } });
}
async function publishedForensic(f, result = null, parent = forensicParent(f)) {
  const root = temp(), out = path.join(root, "forensic");
  try { result ||= await pilot.runCompoundBCallForensic({ parent, runtimeOptions: f.options }); const summary = cli.createCompoundBCallForensicWriter(out).publish(result, parent, f.now); return { root, out, result, parent, summary }; }
  catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
}
const readForensic = p => cli.readCompoundBCallForensic(p.out, {}, { loadCompoundBCallForensicParent: () => p.parent });
function syntheticForensicTrace(raw, kind) {
  if (kind !== "not-reproduced") rejectionTrace(raw, kind);
  raw.output = "0xcafe";
  raw.calls ||= [{ type: "CALL", from: B, to: B, value: "0x0", gas: "0x100", gasUsed: "0x1", input: "0x12345678", error: SENTINEL }];
  raw.calls[0].output = "0xdeadbeef"; raw.calls[0].revertReason = SENTINEL;
  return raw;
}

test("call forensic pins B1R and B1DR and strictly retains synthetic rejected frames/public reverted bytes without authority", async () => {
  const realParent = pilot.loadCompoundBCallForensicParent(); assert.equal(pilot.checkCompoundBCallForensicParent(realParent).index, 41);
  const old = cli.readCompoundBIndexDiagnostic(pilot.B1DR_PATH, { expectedManifestSha256: pilot.B1DR_SHA256 }); assert.equal(old.manifest.aggregateEvidenceStatus, "INVALID"); assert.equal(old.capsule, null);
  for (const kind of ["empty-domain-intersection", "uncommitted-index", "not-reproduced"]) {
    const f = forensicFixture({ trace: raw => syntheticForensicTrace(raw, kind) }), p = await publishedForensic(f);
    try {
      const r = p.result, o = r.forensicObservation; assert.equal(r.schema, pilot.CALL_FORENSIC_SCHEMA); assert.equal(o.observationId, "obs-01"); assert.equal(o.universeIndex, 41);
      assert.equal(o.callFrames[1].error, true); assert.equal(o.publicCallBytes[1].output, "0xdeadbeef"); assert.equal(o.publicCallBytes[0].output, "0xcafe");
      if (kind === "empty-domain-intersection") assert.equal(o.callFrames[0].logs[7].index, "153");
      assert.equal(r.status, kind === "not-reproduced" ? "DIAGNOSTIC-COMPLETE" : "CAPTURE-FAILED"); assert.equal(r.aggregateEvidenceStatus, kind === "not-reproduced" ? "NON-AUTHORITATIVE" : "INVALID");
      assert.equal(r.serverTracerTimeoutRequested, "10s"); assert.equal(r.serverTimeoutEnforcement, "unknown"); assert.deepEqual(r.features, pilot.FEATURES); assert.equal(r.capsule, null);
      assert.equal(f.actualCalls.filter(isCall).length, 1); assert.ok(isCall(f.actualCalls.at(-1))); assert.equal(f.actualCalls.some(isState), false);
      const read = readForensic(p); assert.equal(read.authority.validPilotAggregate, false); assert.equal(read.authority.validStudyAggregate, false);
      assert.deepEqual(read.manifest.forensicObservation, o); assert.throws(() => cli.validateCompoundBIndexDiagnostic(r, p.parent), /invalid-schema/);
      assert.throws(() => cli.readCompoundBIndexDiagnostic(p.out, {}, { loadCompoundBIndexDiagnosticParent: () => p.parent }), /invalid-schema/);
      const text = fs.readFileSync(path.join(p.out, cli.CALL_FORENSIC_FILE), "utf8"); assert.ok(!text.includes(SENTINEL) && !/revertReason|https:|alchemy|infura/.test(text));
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
  const f = forensicFixture();
  for (const mutate of [s => { s.manifestSha256 = "0".repeat(64); }, s => { s.manifest.sourceB1RManifestSha256 = "0".repeat(64); }, s => { s.manifest.diagnostic.observationId = "obs-01"; },
    s => { s.manifest.diagnostic.rejection.witnesses[0].observedIndex.value = "13"; }, s => { s.manifest.diagnosticConstruction = "failed"; }]) assert.throws(() => forensicParent(f, pilot, mutate), /invalid-schema/);
  await assert.rejects(pilot.runCompoundBCallForensic({ parent: diagnosticParent(f), runtimeOptions: f.options }), /invalid-schema/);
});
test("call forensic reader recomputes original rejection, bytes, topology, receipt payloads and helper analysis after rehash", async () => {
  const f = forensicFixture({ trace: raw => syntheticForensicTrace(raw, "empty-domain-intersection") }), p = await publishedForensic(f);
  try {
    const file = path.join(p.out, cli.CALL_FORENSIC_FILE), base = JSON.parse(fs.readFileSync(file));
    for (const mutate of [m => { m.forensicObservation.publicCallBytes[1].output = "0xdeadbeee"; }, m => { m.forensicObservation.publicCallBytes[0].input = "0x1235"; },
      m => { m.forensicObservation.callFrames[1].index = 2; }, m => { m.forensicObservation.callFrames[1].parent = 1; }, m => { m.forensicObservation.callFrames[0].logs[7].index = "154"; },
      m => { m.forensicObservation.callFrames[0].logs[0].data = "0xffff"; }, m => { m.forensicObservation.callFrames[0].logs[0].position = "9"; },
      m => { m.forensicObservation.analysis.baseAccounting[0].inputBytes++; }, m => { m.forensicObservation.analysis.nativeEffects.transfers.push({ valueWei: "1" }); },
      m => { m.forensicObservation.observationId = "obs-02"; }, m => { m.forensicObservation.universeIndex = 0; }, m => { m.forensicObservation = null; },
      m => { m.sourceB1DRManifestSha256 = "0".repeat(64); }, m => { m.sourceB1RManifestSha256 = "0".repeat(64); }, m => { m.serverTracerTimeoutRequested = "20s"; }, m => { m.serverTimeoutEnforcement = "enforced"; },
      m => { m.transportDiagnostics.at(-1).observationId = "obs-02"; }, m => { m.transportDiagnostics.at(-1).phase = "prestate-tracer"; }, m => { m.diagnostic.rejection.witnesses[1].observedIndex.value = "154"; },
      m => { m.forensicObservation.rawError = SENTINEL; }, m => { m.forensicObservation.callFrames[1].revertReason = SENTINEL; }, m => { m.validPilotAggregate = true; }]) {
      const changed = clone(base); mutate(changed); rehash(file, changed); assert.throws(() => readForensic(p), /invalid-schema/);
    }
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
test("call forensic early binding failures retain no observation; optional construction failure keeps original rejection and validated public bytes", async () => {
  for (const mode of ["root", "receipt", "gas", "bytes", "rpc"]) {
    const f = forensicFixture({ hook(c) {
      if (isCall(c)) { if (mode === "root") c.result.from = B; if (mode === "receipt") c.result.logs[0].data = "0xffff"; if (mode === "gas") c.result.gasUsed = Q(855907);
        if (mode === "bytes") c.result.output = "0x1"; if (mode === "rpc") return { error: { code: -32000, message: SENTINEL } }; }
      return { result: c.result };
    } }), p = await publishedForensic(f);
    try { assert.equal(p.result.forensicObservation, null); assert.equal(p.result.status, "CAPTURE-FAILED"); assert.equal(readForensic(p).authority.validPilotAggregate, false);
      assert.equal(f.actualCalls.filter(isCall).length, 1); assert.ok(isCall(f.actualCalls.at(-1))); assert.ok(!fs.readFileSync(path.join(p.out, cli.CALL_FORENSIC_FILE), "utf8").includes(SENTINEL));
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
  const Module = require("node:module"), domains = require("../strategy-study/log-index-domains"), filename = require.resolve("../strategy-study/compound-b-pilot");
  for (const stage of ["preimages", "analysis", "diagnostic"]) {
    const isolated = new Module(filename, module); isolated.filename = filename; isolated.paths = module.paths;
    let rejectValidation = false;
    isolated.require = name => name === "./log-index-domains" && stage === "diagnostic" ? { ...domains, validateIndexDomainRejection(value) { if (rejectValidation) throw new Error(SENTINEL); return domains.validateIndexDomainRejection(value); } }
      : name === "./compound-b-accounting" && stage !== "diagnostic" ? { ...accounting, [stage === "preimages" ? "capturePublicCallBytes" : "analyzePilotCalls"]() { throw new Error("binding-mismatch"); } }
      : require(require.resolve(name, { paths: [path.dirname(filename)] }));
    isolated._compile(fs.readFileSync(filename, "utf8"), filename); const implementation = isolated.exports, f = forensicFixture({ trace: raw => syntheticForensicTrace(raw, "empty-domain-intersection") });
    // Establish source provenance before injecting the capture-time failure.
    const parent = forensicParent(f, implementation); rejectValidation = true;
    const r = await implementation.runCompoundBCallForensic({ parent, runtimeOptions: f.options }), p = await publishedForensic(f, r);
    try { assert.equal(r.reason, stage === "diagnostic" ? "consensus-mismatch" : "binding-mismatch"); assert.equal(r.diagnosticConstruction, stage === "diagnostic" ? "failed" : "not-needed");
      assert.equal(r.forensicObservation === null, stage !== "diagnostic"); assert.equal(r.diagnostic, null); assert.equal(readForensic(p).authority.aggregateEvidenceStatus, "INVALID");
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});

test("call forensic reuses first-eligible stopping, independent-family admission, bounded retries, caps and expiry with exclusive flags", async () => {
  for (const extra of ["--capture-compound-b", "--diagnose-compound-b-index", "--capture-compound-b-forensic", "--tx=x", "--index=41", "--source=x", "--requests=301", "--tracer=x"])
    assert.throws(() => cli.parseArgs(["--capture-compound-b-forensic", "--chain=1", "--out=x", extra]), /invalid-options/);
  for (const flag of ["--capture-compound-b", "--diagnose-compound-b-index"]) assert.throws(() => cli.parseArgs([flag, "--capture-compound-b-forensic", "--chain=1", "--out=x"]), /invalid-options/);
  for (const mode of ["first-eligible", "rate-retry", "availability", "same-family", "request-cap", "expired"]) {
    let calls = 0;
    const f = forensicFixture({ ...(mode === "same-family" ? { candidates: ["https://eth-mainnet.g.alchemy.com/a", "https://eth-mainnet.g.alchemy.com/b"] } : {}),
      ...(mode === "request-cap" ? { limits: { requests: 1 } } : {}), trace: raw => syntheticForensicTrace(raw, "empty-domain-intersection"), hook(c) {
        if (mode === "first-eligible" && c.index === 0 && c.method === "eth_chainId") return { result: "0x2" };
        if (isCall(c)) { calls++; if (mode === "availability") return { status: 403, raw: SENTINEL }; if (mode === "rate-retry" && calls === 1) return { status: 429, raw: SENTINEL }; }
        return { result: c.result };
      } });
    if (mode === "expired") f.setNow(Date.parse(capture.EXPIRES_AT));
    const p = await publishedForensic(f);
    try {
      const r = p.result; assert.equal(r.runtimeDrained, true); assert.equal(readForensic(p).authority.validPilotAggregate, false); assert.equal(r.capsule, null);
      assert.equal(f.actualCalls.some(isState), false);
      if (["first-eligible", "rate-retry"].includes(mode)) {
        assert.equal(r.failureStage, "index-domain"); assert.ok(r.forensicObservation); assert.equal(calls, mode === "rate-retry" ? 2 : 1);
        assert.equal(r.forensicObservation.observationId, mode === "first-eligible" ? "obs-02" : "obs-01"); assert.ok(isCall(f.actualCalls.at(-1)));
      } else { assert.equal(r.forensicObservation, null); assert.equal(calls, mode === "availability" ? 1 : 0); }
      if (mode === "availability") assert.ok(isCall(f.actualCalls.at(-1)));
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
  const f = forensicFixture(), parent = forensicParent(f);
  await assert.rejects(pilot.runCompoundBCallForensic({ parent, runtimeOptions: f.options, mode: "other" }), /invalid-schema/);
  await assert.rejects(pilot.runCompoundBCallForensic({ parent: clone(parent), runtimeOptions: f.options }), /invalid-schema/); assert.equal(f.actualCalls.length, 0);
});

test("real CLI child entrypoints validate pinned provenance before the offline adapter stub without circular initialization", t => {
  const { spawnSync } = require("node:child_process");
  const cliPath = require.resolve("../strategy-study/compound-b-pilot-cli"), collectorPath = require.resolve("../strategy-study/compound-b-pilot"), inventoryPath = require.resolve("../strategy-study/authorized-inventory");
  for (const flag of ["--diagnose-compound-b-index", "--capture-compound-b", "--capture-compound-b-forensic"]) {
    const root = temp(), out = path.join(root, "output"), preload = path.join(root, "offline-preload.cjs");
    const provenance = path.join(root, "provenance"), adapter = path.join(root, "adapter"), fetched = path.join(root, "fetch");
    try {
      fs.writeFileSync(preload, `"use strict";
const fs = require("node:fs"), assert = require("node:assert/strict");
const provenance = ${JSON.stringify(provenance)}, adapter = ${JSON.stringify(adapter)}, fetched = ${JSON.stringify(fetched)};
Date.now = () => Date.parse("2026-10-20T22:00:00Z");
global.fetch = () => { fs.writeFileSync(fetched, "FORBIDDEN_FETCH"); throw new Error("capture-failed"); };
const inventoryPath = ${JSON.stringify(inventoryPath)};
require.cache[inventoryPath] = { id: inventoryPath, filename: inventoryPath, loaded: true, exports: {
  loadAuthorizedCandidates() {
    assert.equal(fs.readFileSync(provenance, "utf8"), "PINNED_PROVENANCE_VALIDATED");
    fs.writeFileSync(adapter, "OFFLINE_ADAPTER_REACHED"); throw new Error("authorized-inventory-unavailable");
  }
} };
const collector = require(${JSON.stringify(collectorPath)});
assert.equal(require.cache[${JSON.stringify(cliPath)}], undefined);
for (const name of ["loadCompoundBParent", "loadCompoundBIndexDiagnosticParent", "loadCompoundBCallForensicParent"]) {
  const original = collector[name];
  collector[name] = () => {
    const parent = original();
    assert.equal(parent.universe.length, 111); assert.equal(collector.checkParent(parent).index, 41);
    if (name === "loadCompoundBIndexDiagnosticParent") collector.checkCompoundBIndexDiagnosticParent(parent);
    if (name === "loadCompoundBCallForensicParent") collector.checkCompoundBCallForensicParent(parent);
    fs.writeFileSync(provenance, "PINNED_PROVENANCE_VALIDATED"); return parent;
  };
}
`, { flag: "wx" });
      const child = spawnSync(process.execPath, ["-r", preload, cliPath, flag, "--chain=1", `--out=${out}`], { encoding: "utf8", timeout: 20000, maxBuffer: 32768, windowsHide: true });
      assert.equal(child.error, undefined); assert.equal(child.status, 2); assert.equal(child.signal, null);
      assert.equal(child.stdout, `${JSON.stringify({ status: "CAPTURE-FAILED", reason: "capture-failed", validPilotAggregate: false, validStudyAggregate: false })}\n`);
      assert.equal(fs.existsSync(fetched), false); assert.deepEqual(fs.readdirSync(out), []);
      const evidence = { diagnostic: flag === "--diagnose-compound-b-index", provenanceValidated: fs.existsSync(provenance), adapterReached: fs.existsSync(adapter), circularWarning: /circular dependency/.test(child.stderr) };
      t.diagnostic(JSON.stringify(evidence));
      assert.deepEqual(evidence, { diagnostic: flag === "--diagnose-compound-b-index", provenanceValidated: true, adapterReached: true, circularWarning: false });
      assert.equal(child.stderr, "");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("index diagnostic pins the full C2 and immutable B1R failure; ordinary failed artifacts and schemas stay unchanged", async () => {
  const realParent = pilot.loadCompoundBIndexDiagnosticParent(); assert.equal(pilot.checkCompoundBIndexDiagnosticParent(realParent).index, 41); assert.equal(realParent.universe.length, 111);
  for (const [directory, hash] of [["b1-compound-ethereum", "e214e960556f6c30924c2130342802e8def9ebd3f1623d84e70bbfc3bb48e181"], ["b1r-compound-ethereum", pilot.B1R_SHA256]]) {
    const old = cli.readCompoundBPilot(path.resolve("reports/raw/fast/strategy-study-20261020", directory), { expectedManifestSha256: hash });
    assert.equal(old.manifest.status, "CAPTURE-FAILED"); assert.equal(old.authority.aggregateEvidenceStatus, "INVALID"); assert.equal(old.capsule, null);
  }
  const f = pilotFixture();
  for (const mutate of [s => { s.manifestSha256 = "0".repeat(64); }, s => { s.manifest.budget.requests = 60; }, s => { s.manifest.budget.traceRequests = 2; },
    s => { s.manifest.integrityFailure.observationId = "obs-01"; }, s => { s.manifest.integrityFailure.phase = "prestate-tracer"; }, s => { s.manifest.fixture.universeIndex = 0; },
    s => { s.manifest.observations[0].call = "passed"; }, s => { s.manifest.observations[0].state = "passed"; }, s => { s.manifest.capsule = {}; }]) assert.throws(() => diagnosticParent(f, pilot, mutate), /invalid-schema/);
  const parent = diagnosticParent(f); await assert.rejects(diagnose(f, clone(parent)), /invalid-schema/); await assert.rejects(diagnose(f, f.parent), /invalid-schema/);
  await assert.rejects(pilot.runCompoundBIndexDiagnostic({ parent, runtimeOptions: f.options, mode: "other" }), /invalid-schema/);
  await assert.rejects(pilot.runCompoundBPilot({ parent: f.parent, runtimeOptions: f.options, mode: "diagnostic" }), /invalid-schema/); assert.equal(f.actualCalls.length, 0);
});
test("index diagnostic binds both rejection kinds and redacted witnesses at the first eligible CALL, then stops without alternate authority", async () => {
  for (const kind of ["empty-domain-intersection", "uncommitted-index", "redacted"]) {
    const f = pilotFixture({ trace: raw => rejectionTrace(raw, kind), hook(c) { return c.index === 0 && c.method === "eth_chainId" ? { result: "0x2" } : { result: c.result }; } }), p = await publishedDiagnostic(f);
    try {
      const r = p.result; assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.failureStage, "index-domain"); assert.equal(r.diagnosticConstruction, "complete");
      assert.equal(r.diagnostic.observationId, "obs-02"); assert.equal(r.diagnostic.universeIndex, 41); assert.equal(r.basicPairIndependent, true); assert.equal(r.qualificationComplete, false);
      assert.equal(r.diagnostic.rejection.kind, kind === "redacted" ? "empty-domain-intersection" : kind);
      if (kind === "redacted") assert.ok(r.diagnostic.rejection.witnesses.some(w => w.observedIndex.redacted && w.observedIndex.value === null));
      for (const w of r.diagnostic.rejection.witnesses) if (w.receiptOrdinal !== null) assert.deepEqual(w.receiptLogIndex, { value: f.parent.views[41].receipt.logs[w.receiptOrdinal].logIndex, redacted: false });
      assert.equal(f.actualCalls.filter(isCall).length, 1); assert.equal(f.actualCalls.at(-1).index, 1); assert.ok(isCall(f.actualCalls.at(-1)));
      assert.equal(r.budget.traceRequests, 1); assert.equal(r.budget.logRequests, 0); assert.equal(r.runtimeDrained, true); assert.equal(r.capsule, null); assert.deepEqual(r.features, pilot.FEATURES);
      const loaded = readDiagnostic(p); assert.equal(loaded.authority.validPilotAggregate, false); assert.equal(loaded.authority.validStudyAggregate, false); assert.equal(loaded.authority.aggregateEvidenceStatus, "INVALID");
      assert.throws(() => cli.readCompoundBPilot(p.out, {}, { loadCompoundBParent: () => f.parent }), /invalid-schema/);
      assert.throws(() => cli.validateCompoundBPilot(r, f.parent), /invalid-schema/); assert.ok(!/PRIVATE|https:|alchemy|infura|publicnode/.test(fs.readFileSync(path.join(p.out, cli.INDEX_DIAGNOSTIC_FILE), "utf8")));
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});
test("index diagnostic construction failure cannot replace the latched domain rejection or promote unrelated native failures", async () => {
  const Module = require("node:module"), domains = require("../strategy-study/log-index-domains"), filename = require.resolve("../strategy-study/compound-b-pilot");
  const isolated = new Module(filename, module); isolated.filename = filename; isolated.paths = module.paths;
  let validations = 0; isolated.require = name => name === "./log-index-domains" ? { ...domains, validateIndexDomainRejection() { validations++; throw new Error(SENTINEL); } } : require(require.resolve(name, { paths: [path.dirname(filename)] }));
  isolated._compile(fs.readFileSync(filename, "utf8"), filename);
  const f = pilotFixture({ trace: raw => rejectionTrace(raw, "empty-domain-intersection") }), implementation = isolated.exports;
  const result = await implementation.runCompoundBIndexDiagnostic({ parent: diagnosticParent(f, implementation), runtimeOptions: f.options }), p = await publishedDiagnostic(f, result);
  try { assert.equal(validations, 1); assert.equal(result.reason, "consensus-mismatch"); assert.equal(result.integrityFailure.phase, "call-tracer"); assert.equal(result.failureStage, "index-domain");
    assert.equal(result.diagnosticConstruction, "failed"); assert.equal(result.diagnostic, null); assert.equal(readDiagnostic(p).authority.aggregateEvidenceStatus, "INVALID"); assert.equal(f.actualCalls.filter(isCall).length, 1);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  for (const mode of ["schema", "root", "rpc", "unavailable", "header-unavailable"]) {
    const bad = pilotFixture({ hook(c) {
      if (mode === "header-unavailable" && c.index === 0 && c.method === "eth_getBlockByNumber" && c.fixture.calls.filter(e => e.index === 0 && e.method === "eth_getBlockByNumber").length === 3) return { status: 403, raw: SENTINEL };
      if (isCall(c)) { if (mode === "schema") return { result: {} }; if (mode === "root") c.result.from = B;
        if (mode === "rpc") return { error: { code: -32000, message: SENTINEL } }; if (mode === "unavailable") return { status: 403, raw: SENTINEL }; }
      return { result: c.result };
    } }), saved = await publishedDiagnostic(bad);
    try { assert.notEqual(saved.result.status, "DIAGNOSTIC-COMPLETE"); assert.equal(saved.result.failureStage, null); assert.equal(saved.result.diagnosticConstruction, "not-needed"); assert.equal(saved.result.diagnostic, null);
      assert.equal(bad.actualCalls.filter(isCall).length, mode === "header-unavailable" ? 0 : 1); assert.ok(!bad.actualCalls.some(isState)); assert.equal(readDiagnostic(saved).authority.validPilotAggregate, false);
    } finally { fs.rmSync(saved.root, { recursive: true, force: true }); }
  }
});
test("index diagnostic nonreproduction is non-authoritative and stops after one logical CALL, including exact 429 retries", async () => {
  for (const retry of [false, true]) {
    let attempted = 0; const f = pilotFixture({ hook(c) { return retry && isCall(c) && attempted++ === 0 ? { status: 429, raw: SENTINEL } : { result: c.result }; } }), p = await publishedDiagnostic(f);
    try { const r = p.result; assert.equal(r.status, "DIAGNOSTIC-COMPLETE"); assert.equal(r.reason, "not-reproduced"); assert.equal(r.aggregateEvidenceStatus, "NON-AUTHORITATIVE");
      assert.equal(r.diagnosticConstruction, "not-needed"); assert.equal(r.capsule, null); assert.deepEqual(r.features, pilot.FEATURES); assert.equal(r.budget.traceRequests, retry ? 2 : 1);
      const sends = f.actualCalls.filter(isCall); assert.equal(sends.length, retry ? 2 : 1); assert.ok(isCall(f.actualCalls.at(-1))); assert.equal(r.observations[0].call, "passed");
      assert.ok(r.observations.every(o => o.state === "not-tested" && !o.complete)); if (retry) assert.deepEqual(sends[0], sends[1]); assert.equal(readDiagnostic(p).authority.validPilotAggregate, false);
      const file = path.join(p.out, cli.INDEX_DIAGNOSTIC_FILE), changed = JSON.parse(fs.readFileSync(file)); changed.aggregateEvidenceStatus = "VALIDATED"; rehash(file, changed); assert.throws(() => readDiagnostic(p), /invalid-schema/);
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});
test("index diagnostic reader rejects rehashed source, witness, receipt, observation and one-CALL history tampering", async () => {
  const f = pilotFixture({ trace: raw => rejectionTrace(raw, "empty-domain-intersection") }), p = await publishedDiagnostic(f);
  try {
    const file = path.join(p.out, cli.INDEX_DIAGNOSTIC_FILE), base = JSON.parse(fs.readFileSync(file));
    for (const mutate of [m => { m.sourceB1RManifestSha256 = "0".repeat(64); }, m => { m.sourceC2ManifestSha256 = "0".repeat(64); }, m => { m.fixture.universeIndex = 0; },
      m => { m.diagnostic.observationId = "obs-02"; }, m => { m.diagnostic.universeIndex = 0; }, m => { m.failureStage = null; }, m => { m.diagnosticConstruction = "failed"; },
      m => { m.diagnostic.rejection.witnesses[0].receiptOrdinal = 13; }, m => { m.diagnostic.rejection.witnesses[0].receiptLogIndex.value = "999"; },
      m => { m.diagnostic.rejection.witnesses[0].receiptLogIndex = { value: null, redacted: true }; }, m => { m.diagnostic.rejection.witnesses[0].observedIndex.value = "00"; },
      m => { m.diagnostic.rejection.witnesses.pop(); }, m => { m.diagnostic.rejection.candidateCount = 1; }, m => { m.diagnostic.rejection.kind = "other"; }, m => { m.diagnostic.raw = SENTINEL; },
      m => { m.basicPairIndependent = false; }, m => { m.observations[0].state = "passed"; }, m => { m.integrityFailure.phase = "validation"; }, m => { m.validPilotAggregate = true; },
      m => { m.transportDiagnostics.at(-1).attempt = 2; }, m => { m.transportDiagnostics.at(-1).outcome = "failed"; m.transportDiagnostics.at(-1).code = "provider-rpc-failure"; },
      m => { m.transportDiagnostics.at(-1).phase = "prestate-tracer"; }, m => { m.transportDiagnostics.pop(); },
      m => { m.transportDiagnostics.filter(e => ["trace-header-before", "call-tracer"].includes(e.phase)).forEach(e => { e.observationId = "obs-02"; }); m.integrityFailure.observationId = "obs-02"; m.diagnostic.observationId = "obs-02"; },
      m => { m.capsule = {}; }, m => { m.selectedAliases = ["obs-01", "obs-02"]; }, m => { m.features.stateObserved = true; }]) {
      const changed = clone(base); mutate(changed); rehash(file, changed); assert.throws(() => readDiagnostic(p), /invalid-schema/);
    }
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("index diagnostic retains full-pool independent admission, limits and shutdown expiry without any fallback", async () => {
  for (const mode of ["same-family", "late-basic-conflict", "family-cap", "request-cap", "response-cap", "trace-cap", "rate-limit", "expired"]) {
    const f = pilotFixture({ ...(mode === "same-family" || mode === "family-cap" ? { candidates: ["https://eth-mainnet.g.alchemy.com/a", "https://eth-mainnet.g.alchemy.com/b", ...(mode === "family-cap" ? ["https://eth-mainnet.g.alchemy.com/c"] : [])] } : {}),
      ...(mode === "request-cap" ? { limits: { requests: 1 } } : mode === "response-cap" ? { limits: { responseBytes: 1 } } : mode === "trace-cap" ? { limits: { traceRequestCap: 1 } } : {}), hook(c) {
        if (mode === "late-basic-conflict" && c.index === 2 && c.method === "eth_getTransactionByHash") c.result.input = "0xabcd";
        if (["trace-cap", "rate-limit"].includes(mode) && isCall(c)) return { status: 429, raw: SENTINEL };
        return { result: c.result };
      } });
    if (mode === "expired") f.setNow(Date.parse(capture.EXPIRES_AT));
    const p = await publishedDiagnostic(f);
    try {
      const r = p.result; assert.equal(r.capsule, null); assert.equal(r.validPilotAggregate, false); assert.equal(r.runtimeDrained, true); assert.equal(r.failureStage, null);
      assert.equal(r.diagnostic, null); assert.equal(readDiagnostic(p).authority.validStudyAggregate, false);
      if (["trace-cap", "rate-limit"].includes(mode)) { assert.equal(r.basicPairIndependent, true); assert.equal(f.actualCalls.filter(isCall).length, mode === "trace-cap" ? 1 : 3); assert.ok(isCall(f.actualCalls.at(-1))); }
      else { assert.equal(r.basicPairIndependent, false); assert.equal(r.budget.traceRequests, 0); assert.ok(!r.transportDiagnostics.some(e => e.phase === "trace-header-before")); }
      if (mode === "same-family") { assert.equal(r.reason, "independent-pair-unavailable"); assert.equal(r.basicPoolComplete, true); }
      if (mode === "late-basic-conflict") { assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.basicPoolComplete, false); }
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
  const original = capture.createRuntime;
  for (const mode of ["expiry", "drain"]) {
    const f = pilotFixture({ trace: raw => rejectionTrace(raw, "empty-domain-intersection") });
    capture.createRuntime = options => { const runtime = original(options); return { ...runtime, async close() {
      await runtime.close(); if (mode === "expiry") f.setNow(Date.parse(capture.EXPIRES_AT)); else throw new Error("runtime-drain-failed");
    } }; };
    try {
      const parent = diagnosticParent(f), r = await diagnose(f, parent); assert.equal(r.reason, "consensus-mismatch"); assert.equal(r.diagnosticConstruction, "complete"); assert.equal(r.capsule, null);
      assert.equal(r.lifecycleFailure, mode === "expiry" ? "session-expired" : "runtime-drain-failed");
      if (mode === "expiry") { const p = await publishedDiagnostic(f, r, parent); try { assert.equal(readDiagnostic(p).authority.aggregateEvidenceStatus, "INVALID"); } finally { fs.rmSync(p.root, { recursive: true, force: true }); } }
      else assert.throws(() => cli.validateCompoundBIndexDiagnostic(r, parent), /invalid-schema/);
    } finally { capture.createRuntime = original; }
  }
});
test("index diagnostic CLI is exclusive, checks pinned provenance before adapter, preserves protected handles and publishes only after disposal", async () => {
  for (const extra of ["--capture-compound-b", "--diagnose-compound-b-index", "--tx=x", "--index=41", "--source=x", "--requests=1", "--chain=8453", "--allow-partial"])
    assert.throws(() => cli.parseArgs(["--diagnose-compound-b-index", "--chain=1", "--out=x", extra]), /invalid-options/);
  assert.throws(() => cli.parseArgs(["--capture-compound-b", "--chain=1", "--out=x", "--diagnose-compound-b-index"]), /invalid-options/);
  for (const mode of ["rejected", "not-reproduced", "pin-failed", "unbranded", "expired"]) {
    const adapter = parseAuthorizedInventory(`# Ethereum\nhttps://eth-mainnet.g.alchemy.com/${SENTINEL}/a\nhttps://eth-mainnet.infura.io/${SENTINEL}/b`, { chainId: 1 });
    const f = pilotFixture({ candidates: adapter.candidates, ...(mode === "rejected" ? { trace: raw => rejectionTrace(raw, "uncommitted-index") } : {}) });
    const parent = diagnosticParent(f), root = temp(), out = path.join(root, "diagnostic"), order = [], printed = [];
    try {
      const result = await cli.main(["--diagnose-compound-b-index", "--chain=1", `--out=${out}`], {
        now: mode === "expired" ? () => Date.parse(capture.EXPIRES_AT) : f.now, print: value => printed.push(value),
        createCompoundBIndexDiagnosticWriter(directory) { order.push("reserve"); const writer = cli.createCompoundBIndexDiagnosticWriter(directory);
          return { publish(...args) { assert.equal(order.at(-1), "dispose"); order.push("publish"); return writer.publish(...args); } }; },
        loadCompoundBIndexDiagnosticParent() { order.push("parent"); if (mode === "pin-failed") throw new Error(SENTINEL); return mode === "unbranded" ? clone(parent) : parent; },
        loadAuthorizedCandidates() { order.push("adapter"); return { candidates: adapter.candidates, getOrigin: adapter.getOrigin, dispose() { order.push("dispose"); adapter.dispose(); } }; },
        async runCompoundBIndexDiagnostic(options) { assert.ok(options.runtimeOptions.candidates === adapter.candidates); assert.throws(() => JSON.stringify(adapter.candidates), /process-only-provider-handles/);
          const r = await pilot.runCompoundBIndexDiagnostic({ ...options, runtimeOptions: { ...f.options, ...options.runtimeOptions } }); assert.equal(r.runtimeDrained, true);
          assert.throws(() => JSON.stringify(adapter.candidates), /process-only-provider-handles/); order.push("drain"); return r; },
      });
      assert.equal(result, 2); assert.ok(!printed.join("").includes(SENTINEL));
      const captured = ["rejected", "not-reproduced"].includes(mode);
      assert.deepEqual(order, captured ? ["reserve", "parent", "adapter", "drain", "dispose", "publish"] : mode === "expired" ? ["reserve"] : ["reserve", "parent"]);
      if (captured) {
        assert.equal(adapter.candidates.length, 0); assert.throws(() => JSON.stringify(adapter.candidates), /process-only-provider-handles/);
        const loaded = cli.readCompoundBIndexDiagnostic(out, {}, { loadCompoundBIndexDiagnosticParent: () => parent });
        assert.equal(loaded.manifest.status, mode === "rejected" ? "CAPTURE-FAILED" : "DIAGNOSTIC-COMPLETE"); assert.equal(loaded.authority.validPilotAggregate, false);
        assert.throws(() => cli.createCompoundBIndexDiagnosticWriter(out), /output-unavailable/);
        fs.writeFileSync(path.join(out, "partial.json"), "{}"); assert.throws(() => cli.readCompoundBIndexDiagnostic(out, {}, { loadCompoundBIndexDiagnosticParent: () => parent }), /invalid-schema/);
      } else { assert.deepEqual(fs.readdirSync(out), []); assert.equal(f.actualCalls.length, 0); }
    } finally { adapter.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});
test("index diagnostic late publication of nonreproduction stays expired and never becomes authoritative", async () => {
  const f = pilotFixture(), parent = diagnosticParent(f), result = await diagnose(f, parent), root = temp(), out = path.join(root, "diagnostic");
  try {
    cli.createCompoundBIndexDiagnosticWriter(out).publish(result, parent, () => Date.parse(capture.EXPIRES_AT));
    const loaded = cli.readCompoundBIndexDiagnostic(out, {}, { loadCompoundBIndexDiagnosticParent: () => parent });
    assert.equal(loaded.manifest.status, "LIMIT-REACHED"); assert.equal(loaded.manifest.reason, "session-expired"); assert.equal(loaded.authority.aggregateEvidenceStatus, "INVALID"); assert.equal(loaded.capsule, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("synthetic authorized adapter passes unchanged to runtime and strict terminal reader without losing process-only guards", async t => {
  const adapter = parseAuthorizedInventory(`# Ethereum\nOrigin: https://pilot-origin.invalid\nhttps://eth-mainnet.g.alchemy.com/${SENTINEL}/a\nhttps://eth-mainnet.infura.io/${SENTINEL}/b`, { chainId: 1 });
  const candidates = adapter.candidates, inspect = Symbol.for("nodejs.util.inspect.custom"), root = temp(), original = capture.createRuntime;
  const guards = ["toJSON", inspect].map(key => [key, Object.getOwnPropertyDescriptor(candidates, key)]);
  const guarded = () => {
    assert.ok(adapter.candidates === candidates); assert.equal(Object.getPrototypeOf(candidates), Array.prototype);
    for (const [key, expected] of guards) {
      const d = Object.getOwnPropertyDescriptor(candidates, key);
      assert.ok(d && Object.hasOwn(d, "value") && typeof d.value === "function" && d.value === expected.value);
      assert.equal(d.enumerable, false); assert.equal(d.writable, false); assert.equal(d.configurable, false);
    }
  };
  let entered = 0;
  try {
    assert.equal(candidates.length, 2); guarded(); assert.throws(() => JSON.stringify(candidates), /process-only-provider-handles/);
    const f = pilotFixture({ candidates }); f.options.shared = { getOrigin: adapter.getOrigin };
    const fetch = f.options.fetch; f.options.fetch = (...args) => { guarded(); return fetch(...args); };
    capture.createRuntime = options => { assert.ok(options.candidates === candidates); guarded(); entered++; return original(options); };
    const r = await run(f);
    if (r.status !== "COMPLETE") t.diagnostic(JSON.stringify({ status: r.status, reason: r.reason, integrityFailure: r.integrityFailure,
      budget: r.budget, observationCount: r.observations.length, startedAt: r.startedAt, observedAt: r.observedAt, endedAt: r.endedAt, capsule: r.capsule }));
    assert.equal(r.status, "COMPLETE"); assert.equal(entered, 1); assert.ok(f.actualCalls.length > 0); assert.equal(r.budget.traceRequests, 4);
    assert.ok(f.origins.length > 0 && f.origins.every(origin => origin === "https://pilot-origin.invalid"));
    assert.equal(r.runtimeDrained, true); guarded(); assert.equal(candidates.length, 2);
    assert.throws(() => JSON.stringify(adapter), /process-only-provider-handles/); assert.throws(() => JSON.stringify(candidates), /process-only-provider-handles/);
    adapter.dispose(); guarded(); assert.equal(candidates.length, 0); assert.throws(() => JSON.stringify(candidates), /process-only-provider-handles/);
    assert.equal(adapter.getOrigin(`https://eth-mainnet.g.alchemy.com/${SENTINEL}/a`), null);
    const out = path.join(root, "pilot"), summary = cli.createCompoundBWriter(out).publish(r, f.parent, f.now);
    const loaded = cli.readAuthoritativeCompoundBPilot(out, { expectedManifestSha256: summary.manifestSha256 }, { loadCompoundBParent: () => f.parent });
    assert.equal(loaded.authority.validPilotAggregate, true); assert.equal(loaded.authority.validStudyAggregate, false);
    const text = fs.readFileSync(path.join(out, cli.FILE), "utf8"); assert.ok(!text.includes(SENTINEL) && !/https:|pilot-origin|alchemy|infura/.test(text));
  } finally { capture.createRuntime = original; adapter.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("candidate admission rejects accessors, incomplete or malformed guards, extras, sparse and inherited arrays without executing them", async () => {
  const inspect = Symbol.for("nodejs.util.inspect.custom"); let invoked = 0;
  const forbidden = () => { invoked++; throw new Error(SENTINEL); };
  const base = () => [`https://eth-mainnet.g.alchemy.com/${SENTINEL}/a`, `https://eth-mainnet.infura.io/${SENTINEL}/b`];
  const guarded = (list, overrides = {}) => Object.defineProperties(list, { toJSON: { value: forbidden }, [inspect]: { value: forbidden }, ...overrides });
  const cases = [
    ["array-like", () => ({ length: 2, get 0() { return forbidden(); } })],
    ["plain accessor", () => Object.defineProperty(base(), "0", { get: forbidden })],
    ["protected accessor", () => Object.defineProperty(guarded(base()), "1", { get: forbidden })],
    ["hidden element", () => Object.defineProperty(guarded(base()), "0", { enumerable: false })],
    ["sparse", () => { const list = guarded(base()); delete list[0]; return list; }],
    ["sparse with compensating extra", () => { const list = guarded(base()); delete list[0]; list.extra = SENTINEL; return list; }],
    ["inherited element", () => { const list = guarded(base()); delete list[0]; Object.setPrototypeOf(list, Object.create(Array.prototype, { 0: { get: forbidden } })); return list; }],
    ["null prototype", () => Object.setPrototypeOf(guarded(base()), null)],
    ["subclass", () => { class Candidates extends Array {} return guarded(new Candidates(2)); }],
    ["plain serializer only", () => Object.defineProperty(base(), "toJSON", { value: forbidden })],
    ["inspect only", () => Object.defineProperty(base(), inspect, { value: forbidden })],
    ["extra enumerable property", () => Object.assign(guarded(base()), { extra: SENTINEL })],
    ["extra hidden property", () => Object.defineProperty(guarded(base()), "extra", { value: SENTINEL })],
    ["extra symbol", () => Object.defineProperty(guarded(base()), Symbol("extra"), { value: forbidden })],
    ["custom iterator", () => Object.defineProperty(guarded(base()), Symbol.iterator, { get: forbidden })],
    ["wrong inspect symbol", () => Object.defineProperties(base(), { toJSON: { value: forbidden }, [Symbol("nodejs.util.inspect.custom")]: { value: forbidden } })],
    ["nonstring element", () => { const list = guarded(base()); list[0] = { toString: forbidden }; return list; }, "invalid-options"],
  ];
  for (const [key, name] of [["toJSON", "json"], [inspect, "inspect"]]) {
    cases.push([`${name} accessor`, () => guarded(base(), { [key]: { get: forbidden } })]);
    cases.push([`${name} nonfunction`, () => guarded(base(), { [key]: { value: SENTINEL } })]);
    for (const flag of ["enumerable", "writable", "configurable"]) cases.push([`${name} ${flag}`, () => guarded(base(), { [key]: { value: forbidden, [flag]: true } })]);
  }
  for (const [name, build, reason = "invalid-schema"] of cases) {
    const f = pilotFixture(); f.options.candidates = build(); const r = await run(f);
    assert.equal(r.status, "CAPTURE-FAILED", name); assert.equal(r.reason, reason, name); assert.equal(r.integrityFailure.phase, "validation", name);
    assert.deepEqual(r.budget, { requests: 0, logRequests: 0, traceRequests: 0, bytes: 0 }, name);
    assert.equal(f.actualCalls.length, 0, name); assert.equal(r.observations.length, 0, name); assert.equal(r.capsule, null, name); assert.equal(invoked, 0, name);
    cli.validateCompoundBPilot(r, f.parent); const text = JSON.stringify(r); assert.ok(!text.includes(SENTINEL) && !/https:|alchemy|infura/.test(text), name);
  }
});

test("protected candidate lists retain pool and family caps while shared artifact arrays stay strict", async () => {
  for (const mode of ["pool", "family", "unknown"]) {
    const adapter = parseAuthorizedInventory(`# Ethereum\nhttps://eth-mainnet.g.alchemy.com/${SENTINEL}/a\nhttps://eth-mainnet.infura.io/${SENTINEL}/b`, { chainId: 1 });
    try {
      if (mode === "pool") while (adapter.candidates.length < 17) adapter.candidates.push(`https://eth-mainnet.g.alchemy.com/${SENTINEL}/${adapter.candidates.length}`);
      if (mode === "family") adapter.candidates.push(`https://eth-mainnet.g.alchemy.com/${SENTINEL}/c`, `https://eth-mainnet.g.alchemy.com/${SENTINEL}/d`);
      if (mode === "unknown") adapter.candidates[0] = `https://unknown.invalid/${SENTINEL}`;
      const f = pilotFixture({ candidates: adapter.candidates }), p = await published(f);
      try {
        assert.equal(p.result.status, "CAPTURE-FAILED"); assert.equal(p.result.reason, mode === "pool" ? "invalid-schema" : "invalid-options");
        assert.equal(f.actualCalls.length, 0); assert.equal(read(p.out, f).authority.validPilotAggregate, false);
        assert.throws(() => JSON.stringify(adapter.candidates), /process-only-provider-handles/);
        assert.ok(!fs.readFileSync(path.join(p.out, cli.FILE), "utf8").includes(SENTINEL));
      } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
    } finally { adapter.dispose(); }
  }
  let invoked = 0; const forbidden = () => { invoked++; throw new Error(SENTINEL); };
  const guard = list => Object.defineProperties(list, { toJSON: { value: forbidden }, [Symbol.for("nodejs.util.inspect.custom")]: { value: forbidden } });
  const f = pilotFixture(), r = await run(f); assert.equal(r.status, "COMPLETE");
  const altered = clone(r); guard(altered.observations);
  assert.throws(() => require("../strategy-study/emission-proof").array(altered.observations, 16), /invalid-schema/);
  assert.throws(() => pilot.plain(altered.observations), /invalid-schema/);
  assert.throws(() => cli.validateCompoundBPilot(altered, f.parent), /invalid-schema/);
  guard(f.parent.universe); await assert.rejects(run(f), /invalid-schema/); assert.equal(invoked, 0);
});

test("fixed B alone captures native call/state/public bytes after full111 parent and full pool, with independently rebuilt pilot-only authority", async () => {
  const f = pilotFixture({ hook(c) {
    if (isCall(c) && c.index === 1) c.result.logs.forEach((log, i) => { log.index = Q(i + 10); });
    if (isCall(c) && c.index === 2) c.result.logs.forEach(log => { delete log.index; });
    if (isState(c) && c.index === 2) { delete c.result.pre[A].codeHash; delete c.result.post[A].codeHash; }
    return { result: c.result };
  } }), p = await published(f);
  try {
    const r = p.result; assert.equal(r.status, "COMPLETE", r.reason); assert.equal(r.validPilotAggregate, true); assert.equal(r.validStudyAggregate, false);
    assert.equal(r.sourceUniverseSize, 111); assert.equal(r.sourceUniverse.length, 111); assert.equal(r.fixture.universeIndex, INDEX); assert.equal(r.pilotScope, "fixed-B");
    assert.equal(r.basicPoolComplete, true); assert.equal(r.qualificationComplete, true); assert.equal(r.finalAnchorRechecked, true); assert.ok(r.observations.every(o => o.complete));
    assert.deepEqual(r.selectedAliases, ["obs-01", "obs-02"]); assert.equal(r.pairIndependent, true); assert.equal(r.budget.traceRequests, 6); assert.equal(r.budget.logRequests, 0);
    assert.deepEqual(r.capsule.callObservations.map(o => o.candidateDomains), [["LOCAL_DENSE"], ["GLOBAL"], []]); assert.equal(r.capsule.callObservations.length, 3); assert.equal(r.capsule.stateObservations.length, 3);
    assert.equal(r.capsule.receipt.logs.length, 13); assert.equal(r.capsule.receiptFeeWei, pilot.FEE_WEI); assert.equal(r.capsule.transactionInput, "0x1234");
    assert.deepEqual(r.capsule.publicCallBytes, [{ frameIndex: 0, input: "0x1234", output: "0x" }]);
    assert.equal(r.capsule.senderNonceSanity.preNonce, "41"); assert.equal(r.capsule.nativeBalances[0].delta, "-10");
    assert.equal(r.features.traceComplete, true); assert.equal(r.features.stateObserved, true); for (const key of ["sourceRuntimeVerified", "balancesVerified", "tokenBalanceLayoutVerified", "costComplete", "profitKnown"]) assert.equal(r.features[key], false);
    assert.ok(f.actualCalls.filter(c => ["eth_getTransactionByHash", "eth_getTransactionReceipt", "debug_traceTransaction"].includes(c.method)).every(c => c.params[0] === PIN.txHash));
    assert.ok(f.actualCalls.filter(c => c.method === "debug_traceTransaction").every(c => [capture.canonical(capture.CALL_CONFIG), capture.canonical(capture.PRESTATE_CONFIG)].includes(capture.canonical(c.params[1]))));
    const firstTrace = f.actualCalls.findIndex(isCall); for (let i = 0; i < 3; i++) assert.ok(f.actualCalls.findIndex(c => c.index === i && c.method === "eth_getTransactionReceipt") < firstTrace);
    const loaded = cli.readAuthoritativeCompoundBPilot(p.out, { expectedManifestSha256: p.summary.manifestSha256 }, { loadCompoundBParent: () => f.parent }); assert.equal(loaded.authority.validPilotAggregate, true);
    assert.equal(loaded.authority.validStudyAggregate, false); assert.throws(() => oldCli.readAuthoritativeTraces(p.out, { allowPartial: true }, { loadParent: () => f.parent }), /invalid-schema/);
    const text = fs.readFileSync(path.join(p.out, cli.FILE), "utf8"); assert.ok(!/PRIVATE|https:|alchemy|infura|publicnode/.test(text));
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
test("parent pin/full111/original B scope and strict options reject overrides before any fetch", async () => {
  const f = pilotFixture(); assert.equal(pilot.loadCompoundBParent({ loadParent: () => f.parent }).universe.length, 111);
  for (const mutate of [p => { p.universe = p.universe.slice(40, 42); p.views = p.views.slice(40, 42); }, p => { p.sourceC2ManifestSha256 = "0".repeat(64); },
    p => { p.scope.window.fromBlock = "1"; }, p => { p.universe[INDEX].transactionIndex = "112"; }, p => { p.views[INDEX].header.transactions[113] = H(99); },
    p => { p.views[INDEX].receipt.effectiveGasPrice = "1"; }, p => { p.universe[42] = clone(p.universe[INDEX]); }, p => { p.views[INDEX].receipt.logs.pop(); }]) {
    const parent = clone(f.parent); mutate(parent); await assert.rejects(pilot.runCompoundBPilot({ parent, runtimeOptions: f.options }), /invalid-schema|binding-mismatch/);
  }
  for (const options of [{ tx: H(1) }, { index: INDEX }, { onTrace() {} }, { allowPartial: true }]) await assert.rejects(pilot.runCompoundBPilot({ parent: f.parent, runtimeOptions: f.options, ...options }), /invalid-schema/);
  for (const extra of [{ transport() {} }, { purpose: "qualification" }, { chainId: 8453 }, { onTransportDiagnostic() {} }, { limits: { requests: 301 } }, { limits: { traceRequestCap: 65 } },
    { limits: { totalTimeoutMs: 600001 } }, { limits: { spacingMs: 999 } }, { limits: { logRequests: 1 } }]) await assert.rejects(pilot.runCompoundBPilot({ parent: f.parent, runtimeOptions: { ...f.options, ...extra } }), /invalid-schema|invalid-options/);
  assert.equal(f.actualCalls.length, 0); assert.throws(() => pilot.loadCompoundBParent({ path: "override" }), /invalid-schema/);
});
test("two-per-reviewed-family bound precedes transport and independent basic pair precedes every trace header", async () => {
  for (const candidates of [["https://unknown.invalid/offline"], ["https://eth-mainnet.g.alchemy.com/a", "https://eth-mainnet.g.alchemy.com/b", "https://eth-mainnet.g.alchemy.com/c"]]) {
    const f = pilotFixture({ candidates }), r = await run(f); assert.equal(r.status, "CAPTURE-FAILED"); assert.equal(r.reason, "invalid-options"); assert.equal(f.actualCalls.length, 0); cli.validateCompoundBPilot(r, f.parent);
  }
  for (const sameFamily of [true, false]) {
    const f = pilotFixture({ ...(sameFamily ? { candidates: ["https://eth-mainnet.g.alchemy.com/a", "https://eth-mainnet.g.alchemy.com/b"] } : {}), hook(c) {
      if (!sameFamily && c.index === 1 && c.method === "eth_chainId") return { result: "0x2" };
      if (!sameFamily && c.index === 2 && c.method === "eth_getTransactionByHash") return { result: null };
      return { result: c.result };
    } }), p = await published(f);
    try {
      const r = p.result; assert.equal(r.status, "ACCESS-BLOCKED"); assert.equal(r.reason, "independent-pair-unavailable"); assert.equal(r.basicPoolComplete, true); assert.equal(r.qualificationComplete, false);
      assert.equal(r.budget.traceRequests, 0); assert.equal(r.transportDiagnostics.some(e => e.phase === "trace-header-before"), false); assert.equal(r.capsule, null); assert.deepEqual(r.selectedAliases, []);
      assert.equal(read(p.out, f).authority.validPilotAggregate, false); assert.throws(() => cli.readAuthoritativeCompoundBPilot(p.out, {}, { loadCompoundBParent: () => f.parent }), /invalid-schema/);
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});
test("only narrow initial identity/null/auth availability retires; malformed postidentity and generic native RPC remain fatal", async () => {
  for (const mode of ["identity-schema", "identity-rpc", "null-material", "http401", "http403", "method-missing", "identity-result", "header-schema", "native-rpc", "state-rpc", "error-plus-result", "bad-error-message"]) {
    const f = pilotFixture({ hook(c) {
      if (c.index !== 0) return { result: c.result };
      if (mode === "identity-rpc" && c.method === "eth_chainId") return { error: { code: -32000, message: SENTINEL } };
      if (mode === "null-material" && c.method === "eth_getTransactionByHash") return { result: null };
      if (mode.startsWith("http") && isState(c)) return { status: Number(mode.slice(4)), raw: SENTINEL };
      if (mode === "method-missing" && isState(c)) return { error: { code: -32601, message: SENTINEL } };
      if (mode === "identity-result" && c.method === "eth_chainId") return { result: null };
      if (mode === "header-schema" && c.method === "eth_getBlockByNumber") return { result: {} };
      if ((mode === "native-rpc" && isCall(c)) || (mode === "state-rpc" && isState(c))) return { error: { code: -32602, message: SENTINEL } };
      return { result: c.result };
    } });
    if (["identity-schema", "error-plus-result", "bad-error-message"].includes(mode)) replaceResponse(f, c => c.index === 0 && (mode === "identity-schema" ? c.method === "eth_chainId" : isState(c)), req => {
      const body = { jsonrpc: mode === "identity-schema" ? "1.0" : "2.0", id: req.id, error: { code: -32601, message: mode === "bad-error-message" ? null : SENTINEL } };
      if (mode === "error-plus-result") body.result = {}; return new Response(JSON.stringify(body));
    });
    const p = await published(f);
    try {
      const accepted = ["identity-schema", "identity-rpc", "null-material", "http401", "http403", "method-missing"].includes(mode), r = p.result;
      assert.equal(r.status, accepted ? "COMPLETE" : "CAPTURE-FAILED", mode); assert.equal(r.validPilotAggregate, accepted);
      if (accepted) assert.deepEqual(r.selectedAliases, ["obs-02", "obs-03"]); else { assert.equal(r.capsule, null); assert.equal(r.observations[0].reason, null); }
      if (mode === "identity-schema") { assert.equal(r.observations[0].reason, "identity-unqualified"); assert.deepEqual(f.actualCalls.filter(c => c.index === 0).map(c => c.method), ["eth_chainId"]); }
      assert.equal(read(p.out, f).authority.validPilotAggregate, accepted); assert.ok(!fs.readFileSync(path.join(p.out, cli.FILE), "utf8").includes(SENTINEL));
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});
test("every retained call core/byte/index/state/codeHash fact survives retirement and vetoes later candidates", async () => {
  for (const mode of ["core", "bytes", "index", "state", "codeHash", "nonce", "receipt"]) {
    const f = pilotFixture({ trace(raw) { raw.calls = [{ type: "CALL", from: B, to: B, input: "0xabcd", output: "0x", gas: "0x100", gasUsed: "0x1", value: "0x0" }]; return raw; }, hook(c) {
      if (c.index === 0 && isCall(c)) {
        if (mode === "core") c.result.gas = Q(1000001);
        if (mode === "bytes") c.result.calls[0].input = "0xabce";
        if (mode === "index") c.result.logs[1].index = "0x99";
      }
      if (c.index === 0 && isState(c)) {
        if (["core", "bytes"].includes(mode)) return { status: 403, raw: SENTINEL };
        if (mode === "state") c.result.post[A].balance = "0x59";
        if (mode === "codeHash") c.result.pre[A].codeHash = H(999);
        if (mode === "nonce") c.result.pre[A].nonce = 1;
      }
      const afterState = c.fixture.calls.some(p => p.index === 0 && isState(p));
      if (c.index === 0 && afterState && c.method === "eth_getTransactionReceipt" && ["state", "codeHash"].includes(mode)) return { result: null };
      if (mode === "receipt" && c.index === 1 && c.method === "eth_getTransactionReceipt") c.result.logs[0].data = "0x5678";
      return { result: c.result };
    } }), p = await published(f);
    try { assert.equal(p.result.status, "CAPTURE-FAILED", mode); assert.equal(p.result.capsule, null); assert.deepEqual(p.result.selectedAliases, []); assert.equal(read(p.out, f).manifest.aggregateEvidenceStatus, "INVALID"); }
    finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});
test("one complete witness, late third-candidate contradictions and final-pair failures cannot fall back to an earlier capsule", async () => {
  for (const mode of ["one-call", "one-state", "late-call", "late-state", "final-receipt"]) {
    const f = pilotFixture({ hook(c) {
      if (c.index > 0 && ((mode === "one-call" && isCall(c)) || (mode === "one-state" && isState(c)))) return { error: { code: -32601, message: SENTINEL } };
      if (c.index === 2 && mode === "late-call" && isCall(c)) c.result.output = "0x01";
      if (c.index === 2 && mode === "late-state" && isState(c)) c.result.post[A].balance = "0x59";
      if (c.index === 0 && mode === "final-receipt" && c.method === "eth_getTransactionReceipt"
          && c.fixture.calls.filter(p => p.index === 0 && p.method === "eth_getTransactionReceipt").length === 3) c.result.logs[0].data = "0xabcd";
      return { result: c.result };
    } }), p = await published(f);
    try {
      const r = p.result, missing = mode.startsWith("one-"); assert.equal(r.status, missing ? "ACCESS-BLOCKED" : "CAPTURE-FAILED", mode);
      assert.equal(r.reason, missing ? "independent-pair-unavailable" : "consensus-mismatch", mode); assert.equal(r.capsule, null); assert.deepEqual(r.selectedAliases, []);
      assert.equal(r.observations.filter(o => o.complete).length, missing ? 1 : mode === "final-receipt" ? 3 : 2);
      assert.equal(r.qualificationComplete, missing || mode === "final-receipt");
      const finalEvents = r.transportDiagnostics.filter(e => e.phase.startsWith("final-") && e.phase !== "finalized-header");
      if (mode === "final-receipt") { assert.ok(finalEvents.length > 0); assert.ok(finalEvents.every(e => ["obs-01", "obs-02"].includes(e.observationId))); }
      else assert.equal(finalEvents.length, 0);
      assert.equal(read(p.out, f).authority.validPilotAggregate, false);
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
});
test("unknown sparse native balances remain null and one-sided code hashes do not become code or balance proof", async () => {
  const f = pilotFixture({ hook(c) { if (isState(c)) {
    delete c.result.pre[A].balance; delete c.result.post[A].balance;
    if (c.index === 1) delete c.result.post[A].codeHash;
  } return { result: c.result }; } }), p = await published(f);
  try {
    assert.equal(p.result.status, "COMPLETE"); assert.deepEqual(p.result.capsule.nativeBalances, [{ address: A, before: null, after: null, delta: null }]);
    assert.deepEqual(p.result.capsule.stateAccounts[0].codeHash, { before: H(10), after: null });
    assert.deepEqual(p.result.capsule.metadataCoverage.codeHashSides, { total: 2, reportedBoth: 1, unknown: 1 }); assert.equal(read(p.out, f).authority.validPilotAggregate, true);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
test("reader rederives bytes, topology, domains, accounting, state/nonce, receipt fee, parent scope and selected corroboration after rehash", async () => {
  const f = pilotFixture(), p = await published(f);
  try {
    const file = path.join(p.out, cli.FILE), base = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [i, mutate] of [m => { m.capsule.transactionInput = "0xffff"; }, m => { m.capsule.publicCallBytes[0].input = "0xffff"; }, m => { m.capsule.publicCallBytes[0].output = "0x01"; },
      m => { m.capsule.callFrames[0].inputSha256 = "0".repeat(64); }, m => { m.capsule.callFrames[0].parent = 0; }, m => { m.capsule.callFrames[0].logs[0].position = "1"; },
      m => { m.capsule.callObservations[0].bindings[0].observedIndex = "999"; }, m => { m.capsule.callObservations[0].candidateDomains = ["GLOBAL"]; }, m => { m.capsule.callObservations.pop(); },
      m => { m.capsule.callAccounting[0].inputBytes++; }, m => { m.capsule.analysis.baseAccounting[0].inputBytes++; }, m => { m.capsule.analysis.nativeEffects.transfers.push({ amount: "1" }); },
      m => { m.capsule.stateAccounts[0].nonce.before = "40"; }, m => { m.capsule.senderNonceSanity.postNonce = "43"; }, m => { m.capsule.stateObservations[2].codeHashes[0].before = H(999); },
      m => { m.capsule.nativeBalances[0].delta = "0"; }, m => { m.capsule.receiptFeeWei = "0"; }, m => { m.capsule.receipt.logs.pop(); },
      m => { m.sourceUniverse.pop(); }, m => { m.sourceUniverseSize = 1; }, m => { m.fixture.universeIndex = 0; }, m => { m.sourceC2ManifestSha256 = "0".repeat(64); },
      m => { m.selectedAliases.reverse(); }, m => { m.capsule.stateObservations.pop(); }, m => { m.capsule.metadataCoverage.logIndex.reportedBoth = 0; },
      m => { m.validStudyAggregate = true; }, m => { m.features.profitKnown = true; }, m => { m.capsule.publicCallBytes[0].rawError = SENTINEL; },
      m => { m.transportDiagnostics = m.transportDiagnostics.filter(e => e.phase !== "final-anchor"); }, m => { m.observations[0].reason = "identity-unqualified"; }].entries()) {
      const m = clone(base); mutate(m); rehash(file, m); assert.throws(() => read(p.out, f), /invalid-schema/, `mutation ${i}`);
    }
    assert.throws(() => read(p.out, f, { allowPartial: true }), /invalid-schema/);
  } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
test("429 exact-param accounting, all global caps, expiry and late failure never leave an earlier usable capsule", async () => {
  let count = 0; const retried = pilotFixture({ hook(c) { return c.index === 0 && isCall(c) && count++ === 0 ? { status: 429, raw: SENTINEL } : { result: c.result }; } }), r = await run(retried);
  assert.equal(r.status, "COMPLETE"); assert.equal(r.backoff.retries, 1); assert.equal(r.budget.traceRequests, 7);
  const sends = retried.actualCalls.filter(c => c.index === 0 && isCall(c)); assert.deepEqual(sends[0].params, sends[1].params); cli.validateCompoundBPilot(r, retried.parent);
  for (const limits of [{ requests: 1 }, { responseBytes: 1 }, { totalResponseBytes: 1 }, { traceRequestCap: 5 }]) {
    const f = pilotFixture({ limits }), p = await published(f);
    try { assert.equal(p.result.status, "LIMIT-REACHED"); assert.equal(p.result.capsule, null); assert.deepEqual(p.result.selectedAliases, []); assert.equal(read(p.out, f).authority.validPilotAggregate, false); }
    finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  }
  const expired = pilotFixture(); expired.setNow(Date.parse(capture.EXPIRES_AT)); const failed = await run(expired); assert.equal(failed.reason, "session-expired"); assert.equal(expired.actualCalls.length, 0);
});
test("matching diagnostics cannot retire callback/options/expiry failures; runtime drain failure prohibits publication", async () => {
  const original = capture.createRuntime;
  for (const mode of ["callback", "options", "expiry", "drain"]) {
    const f = pilotFixture({ hook(c) { return mode !== "drain" && c.index === 0 && isState(c) ? { status: 403, raw: SENTINEL } : { result: c.result }; } }), root = temp();
    capture.createRuntime = options => {
      const runtime = original({ ...options, onTransportDiagnostic(event) { options.onTransportDiagnostic(event);
        if (event.httpStatus === 403) { if (mode === "callback") throw new Error(SENTINEL); if (mode === "expiry") f.setNow(Date.parse(capture.EXPIRES_AT)); } } });
      if (mode === "options") return { ...runtime, async request(...args) { try { return await runtime.request(...args); } catch (_) { throw new Error("invalid-options"); } } };
      if (mode === "drain") return { ...runtime, async close() { await runtime.close(); throw new Error("runtime-drain-failed"); } };
      return runtime;
    };
    try { const r = await run(f), out = path.join(root, "pilot"); assert.equal(r.capsule, null); assert.equal(r.validPilotAggregate, false);
      if (mode === "drain") { assert.throws(() => cli.createCompoundBWriter(out).publish(r, f.parent, f.now), /invalid-schema/); assert.deepEqual(fs.readdirSync(out), []); }
      else { assert.equal(r.observations[0].reason, null); cli.validateCompoundBPilot(r, f.parent); }
    } finally { capture.createRuntime = original; fs.rmSync(root, { recursive: true, force: true }); }
  }
});
test("strict CLI reserves fresh output, checks parent/expiry before adapter, and disposes before sanitized publication", async () => {
  for (const extra of ["--chain=8453", "--tx=x", "--index=41", "--allow-partial", "--requests=1", "--source=x", "--capture-compound-b"])
    assert.throws(() => cli.parseArgs(["--capture-compound-b", "--chain=1", "--out=x", extra]), /invalid-options/);
  for (const mode of ["success", "parent", "expiry", "dispose"]) {
    const f = pilotFixture(), root = temp(), out = path.join(root, "pilot"), order = [], printed = [];
    try {
      const code = await cli.main(["--capture-compound-b", "--chain=1", `--out=${out}`], {
        now: mode === "expiry" ? () => Date.parse(capture.EXPIRES_AT) : f.now, print: text => printed.push(text),
        createCompoundBWriter(directory) { const writer = cli.createCompoundBWriter(directory); order.push("reserve"); return { publish(...args) { assert.equal(order.at(-1), "dispose"); order.push("publish"); return writer.publish(...args); } }; },
        loadCompoundBParent() { order.push("parent"); if (mode === "parent") throw new Error(SENTINEL); return f.parent; },
        loadAuthorizedCandidates() { order.push("adapter"); return { candidates: f.candidates, getOrigin: () => null, dispose() { order.push("dispose"); if (mode === "dispose") throw new Error(SENTINEL); } }; },
        async runCompoundBPilot(options) { const r = await pilot.runCompoundBPilot({ ...options, runtimeOptions: { ...f.options, ...options.runtimeOptions } }); assert.equal(r.runtimeDrained, true); order.push("drain"); return r; },
      });
      assert.equal(code, mode === "success" ? 0 : 2, printed.join("")); assert.ok(!printed.join("").includes(SENTINEL));
      assert.deepEqual(order, mode === "expiry" ? ["reserve"] : mode === "parent" ? ["reserve", "parent"] : ["reserve", "parent", "adapter", "drain", "dispose", ...(mode === "dispose" ? [] : ["publish"])]);
      assert.throws(() => cli.createCompoundBWriter(out), /output-unavailable/);
      if (mode === "success") assert.equal(read(out, f).authority.validPilotAggregate, true); else assert.deepEqual(fs.readdirSync(out), []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
test("late publication removes capsule; oversized/unlisted/symlink artifacts never become authority", async t => {
  const f = pilotFixture(), r = await run(f), root = temp(), out = path.join(root, "expired");
  try {
    cli.createCompoundBWriter(out).publish(r, f.parent, () => Date.parse(capture.EXPIRES_AT)); const loaded = read(out, f);
    assert.equal(loaded.manifest.status, "LIMIT-REACHED"); assert.equal(loaded.capsule, null); assert.equal(loaded.authority.validPilotAggregate, false);
    const file = path.join(out, cli.FILE), bytes = fs.readFileSync(file); fs.writeFileSync(path.join(out, "partial.json"), "{}"); assert.throws(() => read(out, f), /invalid-schema/); fs.unlinkSync(path.join(out, "partial.json"));
    const fd = fs.openSync(file, "w"); fs.ftruncateSync(fd, cli.MAX_BYTES + 1); fs.closeSync(fd); assert.throws(() => read(out, f), /invalid-schema/); fs.writeFileSync(file, bytes);
    const target = path.join(root, "target.json"); fs.renameSync(file, target); try { fs.symlinkSync(target, file, "file"); }
    catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return t.skip("Windows symlink permission unavailable"); throw error; }
    assert.throws(() => read(out, f), /invalid-schema/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
