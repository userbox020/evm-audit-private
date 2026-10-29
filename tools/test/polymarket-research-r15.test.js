"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const R = require("../polymarket-research-r15");

const H = (character) => character.repeat(64);
const BASE = Date.parse("2026-09-01T00:00:00Z");
const PUBLIC_START = Date.parse("2026-09-01T03:56:00Z");
const PUBLIC_AS_OF = Date.parse("2026-09-01T03:58:00Z");
const PUBLIC_END = Date.parse("2026-09-01T04:00:00Z");
function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-r15-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function labels(value) { assert.equal(value.status, "REJECT"); assert.equal(value.highestStatus, "REJECT"); assert.equal(value.profitabilityClaim, false); assert.equal(value.routePositive, "unknown"); assert.equal(value.signedActionJustified, false); assert.equal(value.shadowOnly, true); }

function r9Artifact(time = BASE) {
  const record = { marketId: "7001", status: "REJECT", reason: "window-ongoing", bindingAccepted: true, referenceEquivalenceVerified: false, market: { marketId: "7001", conditionId: `0x${"1".repeat(64)}` }, rule: { priceField: "High", comparator: ">=", endMs: time + 60_000 }, reference: { capturedAtMs: time, referenceConditionMet: null, completeHistory: false, expectedCandleCount: 1, retainedCandleCount: 1, queryEndMs: time, firstHit: null, firstGapMs: null } };
  const recordHash = R.hash({ index: 0, previousHash: null, record });
  return { schemaVersion: 2, mode: "r9-binance-btcusdt-hit-price-reference-scan", asOfMs: time, sourceHashes: { acceptedChainHead: recordHash }, records: [{ ...record, previousHash: null, recordHash }], highestStatus: "REJECT", profitabilityClaim: false, routePositive: "unknown", signedActionJustified: false, shadowOnly: true };
}
function r12Artifact(r9, time = BASE) {
  const core = { status: "REJECT", modelBased: true, nonExecutable: true, probabilities: { lower: "0.3", central: "0.5", upper: "0.7" } };
  const valuationHash = R.hash({ index: 0, previousHash: null, valuation: core });
  return { schemaVersion: 1, mode: "r12-btcusdt-upper-barrier-risk-neutral-gbm-proxy", inputHashes: { r9CanonicalHash: R.hash(r9), acceptedR9RecordHash: r9.records[0].recordHash, valuationChainHead: valuationHash }, sourceBinding: { r9CapturedAtMs: time, surfaceCapturedAtMs: time + 100, optionExpiryTimestampMs: r9.records[0].rule.endMs }, valuation: { ...core, previousHash: null, valuationHash }, highestStatus: "REJECT", modelBased: true, nonExecutable: true, signedActionJustified: false, shadowOnly: true };
}
function r13Artifact(r9, r12, positive) { return { schemaVersion: 1, mode: "r13-counterfactual-executable-edge-distribution", status: "REJECT", highestStatus: "REJECT", inputHashes: { r12CanonicalHash: R.hash(r12), boundR9CanonicalHash: R.hash(r9), acceptedR9RecordHash: r9.records[0].recordHash }, rows: [{ status: "REJECT" }, { status: "REJECT" }], distribution: { positiveConservativeCount: positive ? 1 : 0 }, modelRiskProxy: true, executionEvidence: "none", routePositive: "unknown", profitabilityClaim: false, signedActionJustified: false, shadowOnly: true }; }
function evidence(time = BASE) { return ["gamma", "clob", "binance", "deribit"].map((source, index) => ({ source, sourceTimeMs: time + index * 10, receiptTimeMs: time + 100 + index * 10, id: `${source}-id`, hash: H(String(index + 1)), updateId: index, complete: true })); }
function candidate(time = BASE, positive = true) { const r9 = r9Artifact(time); const r12 = r12Artifact(r9, time); return { candidateId: `candidate-${time}`, r9, r12, r13: r13Artifact(r9, r12, positive), evidence: evidence(time), risk: { costKnown: true, depthKnown: true, surfaceKnown: true, basisKnown: true, provenanceKnown: true, r14ForwardEvidenceSufficient: false, marketConcentration: 0.1, dayConcentration: 0.1, lossProxy: "0.1", cost: "0.1" } }; }
function functions(log) { return { r9: async (value) => { log.push("r9"); return value.r9; }, r12: async (_r9, value) => { log.push("r12"); return value.r12; }, r13: async (_r12, _r9, value) => { log.push("r13"); return value.r13; }, r14: async () => { log.push("r14"); throw new Error("not-called"); } }; }

test("canonical append-only JSONL verifies links, idempotency, tamper, and no-overwrite", (t) => {
  const root = temp(t); const file = path.join(root, "journal.jsonl");
  const first = R.appendRecord(file, { idempotencyKey: "a", value: 1 }, { expectedPreviousHash: null, idempotencyKey: "a" }); assert.equal(first.appended, true);
  const duplicate = R.appendRecord(file, { idempotencyKey: "a", value: 1 }, { idempotencyKey: "a" }); assert.equal(duplicate.appended, false);
  const second = R.appendRecord(file, { idempotencyKey: "b", value: 2 }, { expectedPreviousHash: first.headHash, idempotencyKey: "b" }); assert.equal(second.record.previousHash, first.headHash); assert.equal(R.readJournal(file).records.length, 2);
  assert.throws(() => R.appendRecord(file, { idempotencyKey: "c" }, { expectedPreviousHash: H("f"), idempotencyKey: "c" }), /previous-hash/);
  const headFile = path.join(root, "head.json"); const head = R.writeChainHeadExclusive(headFile, file); labels(head); assert.throws(() => R.writeChainHeadExclusive(headFile, file), /output-exists/);
  fs.appendFileSync(file, `${JSON.stringify({ previousHash: second.headHash, recordHash: H("0"), value: 3 })}\n`); assert.throws(() => R.readJournal(file), /chain/);
});

test("registry is hit-price only and forbidden configuration material fails closed", () => {
  assert.equal(R.registryEntry("hit-price").delegatedParser, "r9"); assert.deepEqual(Object.keys(R.REGISTRY), ["hit-price"]); assert.throws(() => R.registryEntry("generic"), /unsupported/);
  for (const value of [{ endpoint: "x" }, { credential: "x" }, { wallet: "x" }, { action: "place order" }, { target: "https://invalid.test" }, { signing: true }, { transportOverride: true }]) assert.throws(() => R.scanForbidden(value), /forbidden/);
  assert.throws(() => R.injectedFunctions({ r9() {}, r12() {}, r13() {} }), /interface/);
});

function response(url, body, options = {}) { return { ok: options.ok ?? true, status: options.status ?? 200, redirected: options.redirected ?? false, url: options.url ?? url.href, headers: { get: (name) => name === "content-length" ? String(Buffer.byteLength(JSON.stringify(body))) : null }, text: async () => options.text ?? JSON.stringify(body) }; }
test("mocked public transports enforce fixed paths, methods, caps, redirects, and JSON-RPC", async () => {
  const calls = []; const fetchImpl = async (url, init) => { calls.push({ url, init }); if (url.origin === R.ORIGINS.deribit) { const request = JSON.parse(init.body); return response(url, { jsonrpc: "2.0", id: request.id, result: {} }); } if (url.pathname === "/tags/slug/hit-price") return response(url, { id: 77, slug: "hit-price" }); if (url.pathname === "/markets/keyset") return response(url, { markets: [] }); if (url.pathname === "/books") return response(url, []); if (url.pathname === "/fee-rate") return response(url, { fee_rate_bps: 0 }); if (url.pathname === "/api/v3/klines") return response(url, []); if (url.pathname === "/api/v3/depth") return response(url, { lastUpdateId: 1, bids: [], asks: [] }); throw new Error("unexpected"); };
  const adapters = R.createPublicAdapters({ fetchImpl, now: () => BASE, requestCap: 8 });
  await adapters.gamma.tag(); await adapters.gamma.marketsKeyset({ tagId: "77", limit: 100 }); await adapters.clob.books(["1", "2"]); await adapters.clob.feeRate("1"); await adapters.binance.klines({ startTime: 0, endTime: 59_999, limit: 1 }); await adapters.binance.depth({ limit: 100 }); await adapters.deribit.call("public/get_index_price", { index_name: "btc_usd" });
  assert.deepEqual(calls.map((call) => [call.url.pathname, call.init.method]), [["/tags/slug/hit-price", "GET"], ["/markets/keyset", "GET"], ["/books", "POST"], ["/fee-rate", "GET"], ["/api/v3/klines", "GET"], ["/api/v3/depth", "GET"], ["/api/v2", "POST"]]);
  await assert.rejects(adapters.clob.books(Array.from({ length: 501 }, (_, index) => String(index + 1))), /bound/); await assert.rejects(adapters.gamma.marketsKeyset({ tagId: "77", limit: 101 }), /query/); await assert.rejects(adapters.deribit.call("private/get_positions", {}), /method/); await assert.rejects(adapters.deribit.call("public/get_index_price", { index_name: "eth_usd" }), /method/);
  const redirected = R.createPublicAdapters({ fetchImpl: async (url) => response(url, {}, { redirected: true }), requestCap: 1 }); await assert.rejects(redirected.gamma.tag(), /redirect/);
  const badRpc = R.createPublicAdapters({ fetchImpl: async (url) => response(url, { jsonrpc: "2.0", id: 99, result: {} }), requestCap: 1 }); await assert.rejects(badRpc.deribit.call("public/get_index_price", { index_name: "btc_usd" }), /rpc/);
  const capped = R.createPublicAdapters({ fetchImpl: async (url) => response(url, { id: 77, slug: "hit-price" }), requestCap: 1 }); await capped.gamma.tag(); await assert.rejects(capped.gamma.tag(), /request-cap/);
});

function publicCandidate() { return { id: "7001", description: "This market will resolve to \"Yes\" if the final 1 minute candle High for Binance BTC/USDT is greater than or equal to $100,000 at any time from market creation through 2026-08-31 23:59 ET. Candles before market creation are explicitly excluded. Otherwise, this market will resolve to \"No\".", resolutionSource: "https://api.binance.com/api/v3/klines", createdAt: new Date(PUBLIC_START).toISOString(), endDate: new Date(PUBLIC_END).toISOString(), updatedAt: new Date(PUBLIC_AS_OF).toISOString(), outcomes: JSON.stringify(["Yes", "No"]), clobTokenIds: JSON.stringify(["90001", "90002"]), conditionId: `0x${"1".repeat(64)}` }; }
function publicFetch({ candidate = null, incomplete = false, calls = [] } = {}) { return async (url, init) => { calls.push({ url, init }); if (url.pathname === "/tags/slug/hit-price") return response(url, { id: 77, slug: "hit-price" }); if (url.pathname === "/markets/keyset") return response(url, { markets: candidate ? [candidate] : [{ id: "1", description: "unsupported" }] }); if (url.pathname === "/books") return response(url, [{ asset_id: "90001", timestamp: incomplete ? null : String(PUBLIC_AS_OF), bids: [], asks: [] }, { asset_id: "90002", timestamp: String(PUBLIC_AS_OF), bids: [], asks: [] }]); if (url.pathname === "/fee-rate") return response(url, { fee_rate_bps: 0 }); if (url.pathname === "/api/v3/klines") return response(url, [0, 1].map((index) => { const open = PUBLIC_START + index * 60_000; return [open, "1", "99999", "90000", "95000", "1", open + 59_999]; })); if (url.pathname === "/api/v3/depth") return response(url, { lastUpdateId: 10, bids: [["99900", "1"]], asks: [["100100", "1"]] }); if (url.pathname === "/api/v2") { const request = JSON.parse(init.body); let result; if (request.method === "public/get_instruments") result = [{ instrument_name: "BTC-1SEP26-100000-C", expiration_timestamp: PUBLIC_END, strike: 100000, option_type: "call" }]; else if (request.method === "public/get_index_price") result = { index_price: 99950 }; else result = { timestamp: PUBLIC_AS_OF, change_id: 11, bids: [[0.1, 1]], asks: [[0.2, 1]] }; return response(url, { jsonrpc: "2.0", id: request.id, result }); } throw new Error("unexpected-public-route"); }; }

test("run-public no-candidate discovery is exactly one Gamma page and makes no downstream calls", async () => {
  const calls = []; const output = await R.publicRun({ asOfMs: PUBLIC_AS_OF }, { fetchImpl: publicFetch({ calls }), now: () => PUBLIC_AS_OF }); labels(output); assert.equal(output.reasonCode, "r15-no-exact-candidate"); assert.equal(output.totalRequests, 2); assert.equal(output.discovery.keysetPages, 1); assert.equal(output.discovery.rowsSeen, 1); assert.equal(output.capture, null);
  assert.deepEqual(calls.map((call) => [call.url.origin, call.url.pathname, call.init.method]), [[R.ORIGINS.gamma, "/tags/slug/hit-price", "GET"], [R.ORIGINS.gamma, "/markets/keyset", "GET"]]); const query = calls[1].url.searchParams; assert.equal(query.get("tag_id"), "77"); assert.equal(query.get("limit"), "100"); assert.equal(query.get("active"), "true"); assert.equal(query.get("closed"), "false"); assert.equal(query.get("archived"), "false"); assert.equal(query.get("order"), "volume24hr"); assert.equal(query.get("ascending"), "false");
});

test("run-public exact candidate uses fixed bounded downstream order and rejects incomplete evidence", async () => {
  const calls = []; const output = await R.publicRun({ asOfMs: PUBLIC_AS_OF }, { fetchImpl: publicFetch({ candidate: publicCandidate(), incomplete: true, calls }), now: () => PUBLIC_AS_OF }); labels(output); assert.match(output.reasonCode, /evidence-shape-reject/); assert.equal(output.totalRequests, 9); assert.ok(output.totalRequests <= 12);
  assert.deepEqual(calls.map((call) => [call.url.origin, call.url.pathname, call.init.method]), [[R.ORIGINS.gamma, "/tags/slug/hit-price", "GET"], [R.ORIGINS.gamma, "/markets/keyset", "GET"], [R.ORIGINS.clob, "/books", "POST"], [R.ORIGINS.clob, "/fee-rate", "GET"], [R.ORIGINS.binance, "/api/v3/klines", "GET"], [R.ORIGINS.binance, "/api/v3/depth", "GET"], [R.ORIGINS.deribit, "/api/v2", "POST"], [R.ORIGINS.deribit, "/api/v2", "POST"], [R.ORIGINS.deribit, "/api/v2", "POST"]]);
  assert.deepEqual(calls.slice(6).map((call) => JSON.parse(call.init.body).method), ["public/get_instruments", "public/get_index_price", "public/get_order_book"]); assert.equal(JSON.stringify(output).includes("resolutionSource"), false); assert.equal(JSON.stringify(output).includes("https://"), false);
});

test("run-public complete evidence invokes strict injected R12 then R13 but remains REJECT", async () => {
  const order = []; const output = await R.publicRun({ asOfMs: PUBLIC_AS_OF }, { fetchImpl: publicFetch({ candidate: publicCandidate() }), now: () => PUBLIC_AS_OF, r12: async (input) => { order.push("r12"); return { highestStatus: "REJECT", modelBased: true, nonExecutable: true, publicCaptureHash: input.captureHash }; }, r13: async (r12) => { order.push("r13"); return { status: "REJECT", highestStatus: "REJECT", profitabilityClaim: false, routePositive: "unknown", signedActionJustified: false, shadowOnly: true, inputHashes: { r12CanonicalHash: R.hash(r12) } }; } }); labels(output); assert.deepEqual(order, ["r12", "r13"]); assert.equal(output.reasonCode, "r15-r13-evaluated-reject"); assert.match(output.capture.injected.r13Hash, /^[a-f0-9]{64}$/);
});

test("run-public sanitizes failures and writes exclusively without exposing response details", async (t) => {
  const failure = await R.publicRun({ asOfMs: PUBLIC_AS_OF }, { fetchImpl: async () => { throw new Error("private credential detail"); }, now: () => PUBLIC_AS_OF }); labels(failure); assert.equal(failure.reasonCode, "r15-request-failed"); assert.equal(JSON.stringify(failure).includes("credential detail"), false);
  const root = temp(t); const out = path.join(root, "public.json"); let calls = 0; const written = await R.runPublic({ asOfMs: PUBLIC_AS_OF, outputPath: out }, { fetchImpl: publicFetch({ calls: [] }), now: () => PUBLIC_AS_OF }); labels(written); assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).reasonCode, "r15-no-exact-candidate"); calls += 1; await assert.rejects(R.runPublic({ asOfMs: PUBLIC_AS_OF, outputPath: out }, { fetchImpl: async () => { calls += 1; } }), /output-exists/); assert.equal(calls, 1);
});

test("evidence normalization rejects empty, stale, skewed, incomplete, and mismatched captures", () => {
  const valid = R.validateEvidenceSet(evidence(), { nowMs: BASE + 500 }); labels(valid); assert.equal(valid.complete, true);
  assert.throws(() => R.validateEvidenceSet([], { nowMs: BASE }), /empty/); const stale = evidence(); stale[0].sourceTimeMs -= 10_000; assert.throws(() => R.validateEvidenceSet(stale, { nowMs: BASE + 500 }), /stale|skew/);
  const skew = evidence(); skew[3].receiptTimeMs += 3_000; assert.throws(() => R.validateEvidenceSet(skew, { nowMs: BASE + 4_000 }), /skew/); const incomplete = evidence(); incomplete[1].complete = false; assert.throws(() => R.validateEvidenceSet(incomplete, { nowMs: BASE + 500 }), /shape/);
  assert.throws(() => R.validateEvidenceSet(evidence(), { nowMs: BASE + 500, expectedIds: { gamma: "other" } }), /mismatch/);
});

test("scheduler lock, retry/backoff, deterministic idempotency, and run bounds", async (t) => {
  const root = temp(t); const journalPath = path.join(root, "journal.jsonl"); const lockPath = path.join(root, "run.lock"); const sleeps = []; let attempts = 0; let processed = 0;
  const deps = { now: () => BASE, discover: async () => { if (attempts++ === 0) throw new Error("temporary"); return [{ id: 1 }]; }, processCandidate: async () => { processed += 1; return { status: "REJECT" }; }, sleep: async (ms) => sleeps.push(ms) };
  const first = await R.runOnce({ scheduledTimeMs: BASE, lockPath, journalPath }, deps); labels(first); assert.equal(processed, 1); assert.equal(sleeps.length, 1); assert.equal(fs.existsSync(lockPath), false);
  const second = await R.runOnce({ scheduledTimeMs: BASE, lockPath, journalPath }, deps); assert.equal(second.runId, first.runId); assert.equal(processed, 1); assert.equal(R.readJournal(journalPath).records.length, 1);
  fs.writeFileSync(lockPath, "held"); await assert.rejects(R.runOnce({ scheduledTimeMs: BASE + 1, lockPath, journalPath }, deps), /lock-active/); fs.rmSync(lockPath);
  await assert.rejects(R.runOnce({ scheduledTimeMs: BASE + 2, lockPath, journalPath }, { ...deps, discover: async () => Array.from({ length: R.LIMITS.candidatesPerRun + 1 }, () => ({})) }), /candidate-bound/);
});

test("risk policy activates named unknown, concentration, stale, forward, and cap kills", () => {
  const result = R.assessRisk({ candidateCount: 21, stale: true, skewed: true, costKnown: false, depthKnown: false, surfaceKnown: false, basisKnown: false, provenanceKnown: false, r14ForwardEvidenceSufficient: false, marketConcentration: 1, dayConcentration: 1, lossProxy: "2", cost: "2" }); labels(result);
  for (const kill of ["STALE_EVIDENCE", "SOURCE_SKEW", "CANDIDATE_LIMIT", "UNKNOWN_COST", "UNKNOWN_DEPTH", "UNKNOWN_SURFACE", "UNKNOWN_BASIS", "UNKNOWN_PROVENANCE", "INSUFFICIENT_R14_FORWARD_EVIDENCE", "MARKET_CONCENTRATION", "DAY_CONCENTRATION", "LOSS_PROXY_CAP", "COST_CAP"]) assert.ok(result.killConditions.includes(kill));
});

test("orchestrator enforces R9 then R12/R13 and persists favorable and unfavorable forecasts", async (t) => {
  const root = temp(t); const journalPath = path.join(root, "journal.jsonl"); const forecastPath = path.join(root, "forecasts.jsonl");
  for (const [index, positive] of [[0, true], [1, false]]) { const time = BASE + index * 3_000; const value = candidate(time, positive); const log = []; const result = await R.orchestrateCandidate(value, { runId: `run-${index}`, decisionTimeMs: time + 1_000 }, { functions: functions(log) }, { journalPath, forecastPath }); labels(result); assert.equal(result.evaluated, true, JSON.stringify(result)); assert.equal(result.favorableIllustration, positive); assert.deepEqual(log, ["r9", "r12", "r13"]); }
  const forecasts = R.readJournal(forecastPath).records; assert.equal(forecasts.length, 2); assert.ok(forecasts.every((row) => row.status === "REJECT")); assert.equal(R.readJournal(journalPath).records.filter((row) => row.code === "R13_EVALUATED").length, 2);
  const bad = candidate(BASE + 10_000); bad.evidence = []; const log = []; const rejected = await R.orchestrateCandidate(bad, { runId: "run-bad", decisionTimeMs: BASE + 11_000 }, { functions: functions(log) }, { journalPath, forecastPath }); labels(rejected); assert.equal(rejected.evaluated, false); assert.deepEqual(log, ["r9"]); assert.equal(R.readJournal(forecastPath).records.length, 2);
  const mismatch = candidate(BASE + 20_000); mismatch.r12.inputHashes.r9CanonicalHash = H("f"); const mismatchLog = []; const mismatchResult = await R.orchestrateCandidate(mismatch, { runId: "run-mismatch", decisionTimeMs: BASE + 21_000 }, { functions: functions(mismatchLog) }, { journalPath, forecastPath }); assert.equal(mismatchResult.evaluated, false); assert.deepEqual(mismatchLog, ["r9", "r12"]);
});

test("R14 forecast wrapper preserves pre-outcome chronology and evaluate infers no outcome", async (t) => {
  const root = temp(t); const journalPath = path.join(root, "journal.jsonl"); const forecastPath = path.join(root, "forecasts.jsonl"); const value = candidate(); await R.orchestrateCandidate(value, { runId: "run-r14", decisionTimeMs: BASE + 1_000 }, { functions: functions([]) }, { journalPath, forecastPath });
  const wrapper = R.buildR14ForecastWrapper(forecastPath); assert.equal(wrapper.mode, "r14-forward-forecasts-fixture"); assert.ok(wrapper.records[0].sourceTimeMs <= wrapper.records[0].receiptTimeMs && wrapper.records[0].receiptTimeMs <= wrapper.records[0].decisionTimeMs);
  const evaluated = R.evaluateForecasts(forecastPath); labels(evaluated); assert.equal(evaluated.outcomeInferred, false); assert.equal(evaluated.forwardEvidenceSufficient, false); assert.ok(evaluated.risk.killConditions.includes("INSUFFICIENT_R14_FORWARD_EVIDENCE"));
});

test("calibration consumes only injected normalized events and never establishes execution evidence", async () => {
  const output = await R.replayCalibration([{ type: "ack", eventId: "e1", orderId: "o1", sequence: 1, eventTimeMs: BASE }, { type: "fill", eventId: "e2", orderId: "o1", sequence: 2, eventTimeMs: BASE + 1, price: "0.5", size: "1" }]); labels(output); assert.equal(output.acceptanceEvidenceAvailable, false); assert.equal(output.fillEvidenceAvailable, false); assert.equal(output.cancelEvidenceAvailable, false); assert.equal(output.inventoryEvidenceAvailable, "unknown"); assert.equal(output.executionEvidence, "none");
  await assert.rejects(R.replayCalibration([{ type: "ack", sequence: 1, eventTimeMs: BASE, authorization: "Bearer private" }]), /sensitive/);
});

test("offline CLI help, run-fixture, run-public, evaluate, and exclusive outputs", async (t) => {
  const root = temp(t); const fixturePath = path.join(root, "fixture.json"); const outDir = path.join(root, "out"); const fixture = { schemaVersion: 1, mode: R.MODES.fixture, scheduledTimeMs: BASE + 1_000, candidates: [candidate(BASE, true)] }; fs.writeFileSync(fixturePath, JSON.stringify(fixture)); const cli = path.resolve(__dirname, "../polymarket-research-r15/cli.js");
  const help = spawnSync(process.execPath, [cli, "help"], { encoding: "utf8", env: {} }); assert.equal(help.status, 0); assert.match(help.stdout, /Help is offline/); assert.match(help.stdout, /run-public --as-of-ms/); assert.doesNotMatch(help.stdout, /https?:\/\//);
  const run = spawnSync(process.execPath, [cli, "run-fixture", "--fixture", fixturePath, "--out-dir", outDir], { encoding: "utf8", env: {} }); assert.equal(run.status, 0, run.stderr); labels(JSON.parse(fs.readFileSync(path.join(outDir, "result.json"), "utf8"))); labels(JSON.parse(fs.readFileSync(path.join(outDir, "journal-head.json"), "utf8")));
  const again = spawnSync(process.execPath, [cli, "run-fixture", "--fixture", fixturePath, "--out-dir", outDir], { encoding: "utf8", env: {} }); assert.notEqual(again.status, 0); assert.match(again.stderr, /output-exists/);
  const evaluationPath = path.join(root, "evaluation.json"); const evaluation = spawnSync(process.execPath, [cli, "evaluate", "--forecasts", path.join(outDir, "forecasts.jsonl"), "--out", evaluationPath], { encoding: "utf8", env: {} }); assert.equal(evaluation.status, 0, evaluation.stderr); labels(JSON.parse(fs.readFileSync(evaluationPath, "utf8")));
  const parser = require("../polymarket-research-r15/cli"); const publicOut = path.join(root, "cli-public.json"); await parser.main(["run-public", "--as-of-ms", String(PUBLIC_AS_OF), "--out", publicOut], { fetchImpl: publicFetch(), now: () => PUBLIC_AS_OF }); labels(JSON.parse(fs.readFileSync(publicOut, "utf8"))); assert.throws(() => parser.args(["run-public", "--url", "x"]), /invalid/); assert.throws(() => parser.args(["run-public", "--endpoint", "x"]), /invalid/); assert.throws(() => parser.args(["run-fixture", "--url", "x"]), /invalid/); assert.throws(() => parser.args(["evaluate", "--credential", "x"]), /invalid/);
});
