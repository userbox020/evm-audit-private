"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  FIXED_SCALE,
  GATES,
  RECONCILIATION_HARD_LIMITS,
  HistorianSession,
  assertFixedTransport,
  captureBounded,
  appendNdjson,
  artifactHash,
  buildPolicyEvidence,
  captureHistoryHash,
  evaluatePolicy,
  exactFomcMarketMap,
  forecastFomc,
  formatFixed,
  heartbeatAction,
  journalFixture,
  mapBindingHash,
  marketSnapshotFixture,
  multiclassMetrics,
  observationsFixture,
  officialMetadataFixture,
  parseFixed,
  parseDebit,
  readNdjsonPrefix,
  reconcile,
  scoreVector,
  simulateDepth,
  simulatePortfolio,
  simulationFixture,
  takerFee,
  validateOfficialSource,
  writeJsonExclusive,
} = require("../polymarket-research-r3");

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "polymarket-r3-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("BigInt fixed point parses, formats, and preserves exact scale", () => {
  assert.equal(parseFixed("1.23456789"), 1_234_567_890n);
  assert.equal(formatFixed(-1_230_000_000n), "-1.23");
  assert.equal(FIXED_SCALE, 1_000_000_000n);
  assert.throws(() => parseFixed("0.0000000001"), /nonzero-fixed-precision-discarded/);
  assert.equal(parseFixed("1.0000000000"), 1_000_000_000n);
  assert.equal(parseDebit("0.0000000001"), 1n);
});

test("exact September 2026 FOMC mapping requires all unique active markets and yields identity payoffs", () => {
  const map = exactFomcMarketMap(marketSnapshotFixture());
  assert.equal(map.markets.length, 5);
  assert.equal(map.mappingComplete, true);
  assert.deepEqual(map.payoffMatrix[2].yesPayoffs, [0, 0, 1, 0, 0]);
  assert.equal(new Set(map.markets.flatMap((row) => [row.yesTokenId, row.noTokenId])).size, 10);
  const missing = marketSnapshotFixture();
  missing.markets.pop();
  assert.throws(() => exactFomcMarketMap(missing), /exact-five-fomc-markets-required/);
  const noRules = marketSnapshotFixture();
  noRules.markets[0].description = "";
  assert.throws(() => exactFomcMarketMap(noRules), /invalid-fomc-market/);
});

test("artifact store is no-overwrite and journal reader returns crash-valid prefix", (t) => {
  const directory = workspace(t);
  const artifact = path.join(directory, "artifact.json");
  writeJsonExclusive(artifact, { value: 1 });
  assert.throws(() => writeJsonExclusive(artifact, { value: 2 }), /EEXIST/);
  const journal = path.join(directory, "journal.ndjson");
  appendNdjson(journal, { sequence: 1 }, { fsync: true });
  appendNdjson(journal, { sequence: 2 });
  fs.appendFileSync(journal, '{"sequence":3', "utf8");
  assert.deepEqual(readNdjsonPrefix(journal), { records: [{ sequence: 1 }, { sequence: 2 }], crashTail: true, validPrefixCount: 2 });
});

test("historian writes durable sanitized meta/journal/complete records and enforces bounds", (t) => {
  const directory = workspace(t);
  const session = new HistorianSession(directory, {
    mappingHash: "map-hash",
    sourceContracts: [{ endpointUrl: "https://secret.invalid", kind: "public" }],
  }, { durationMs: 1000, maxEvents: 1, maxBytes: 10_000, maxRequests: 1, maxReconnects: 0, maxFailures: 1, fsyncEvery: 1, startedAtMs: 1 });
  session.append("ws", { asset_id: "token", endpoint: "wss://secret.invalid", bids: [], asks: [] }, { receivedAtMs: 2, sourceTimestampMs: 1 });
  assert.throws(() => session.append("ws", {}), /event-bound-exceeded/);
  session.noteRequest();
  assert.throws(() => session.noteRequest(), /request-bound-exceeded/);
  session.complete("test", 3);
  const persisted = `${fs.readFileSync(path.join(directory, "meta.json"), "utf8")}\n${fs.readFileSync(path.join(directory, "journal.ndjson"), "utf8")}`;
  assert.equal(persisted.includes("secret.invalid"), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "complete.json"), "utf8")).counts.events, 1);
  assert.throws(() => new HistorianSession(directory, { mappingHash: "again" }, { durationMs: 1, maxEvents: 1, maxBytes: 1, maxRequests: 1, maxFailures: 1 }), /EEXIST/);
});

test("pure reconciliation covers matching, mismatch, missing, REST error, and concurrent race", () => {
  const book = { bids: [{ price: "0.4", size: "2" }], asks: [{ price: "0.6", size: "2" }] };
  const records = [
    { localSequence: 1, recordType: "rest-anchor", sourceTimestampMs: 1, payload: { tokenId: "missing", requestStartedMs: 1, responseReceivedMs: 2, book } },
    { localSequence: 2, recordType: "rest-error", payload: { tokenId: "error" } },
    { localSequence: 3, recordType: "ws", sourceTimestampMs: 5, payload: { asset_id: "match", ...book } },
    { localSequence: 4, recordType: "rest-anchor", sourceTimestampMs: 5, payload: { tokenId: "match", requestStartedMs: 10, responseReceivedMs: 11, book } },
    { localSequence: 5, recordType: "ws", sourceTimestampMs: 5, payload: { asset_id: "different", bids: [], asks: [] } },
    { localSequence: 6, recordType: "rest-anchor", sourceTimestampMs: 5, payload: { tokenId: "different", requestStartedMs: 10, responseReceivedMs: 11, book } },
    { localSequence: 7, recordType: "ws", sourceTimestampMs: 15, payload: { asset_id: "race", ...book } },
    { localSequence: 8, recordType: "rest-anchor", sourceTimestampMs: 15, payload: { tokenId: "race", requestStartedMs: 14, responseReceivedMs: 16, book } },
  ];
  const result = reconcile(records, RECONCILIATION_HARD_LIMITS);
  assert.deepEqual(result.statuses.map((row) => row.status), ["ws-missing", "rest-error", "matched", "mismatch", "indeterminate-concurrent-update"]);
  assert.equal(result.restIsExecutableDepthAuthority, true);
});

test("reconnect and timestamp regressions require fresh WS plus race-safe fresh REST before recovery", () => {
  const book = { bids: [], asks: [{ price: "0.5", size: "1" }] };
  const result = reconcile([
    { localSequence: 1, recordType: "ws", sourceTimestampMs: 100, payload: { asset_id: "t", ...book } },
    { localSequence: 2, recordType: "gap", payload: { code: "reconnect" } },
    { localSequence: 3, recordType: "rest-anchor", sourceTimestampMs: 100, payload: { tokenId: "t", requestStartedMs: 200, responseReceivedMs: 210, book } },
    { localSequence: 4, recordType: "ws", sourceTimestampMs: 220, payload: { asset_id: "t", ...book } },
    { localSequence: 5, recordType: "rest-anchor", sourceTimestampMs: 220, payload: { tokenId: "t", requestStartedMs: 300, responseReceivedMs: 310, book } },
    { localSequence: 6, recordType: "rest-anchor", sourceTimestampMs: 220, payload: { tokenId: "t", requestStartedMs: 400, responseReceivedMs: 410, book } },
    { localSequence: 7, recordType: "ws", sourceTimestampMs: 150, payload: { asset_id: "t", ...book } },
    { localSequence: 8, recordType: "rest-anchor", sourceTimestampMs: 220, payload: { tokenId: "t", requestStartedMs: 500, responseReceivedMs: 510, book } },
    { localSequence: 9, recordType: "ws", sourceTimestampMs: 520, payload: { asset_id: "t", ...book } },
    { localSequence: 10, recordType: "rest-anchor", sourceTimestampMs: 520, payload: { tokenId: "t", requestStartedMs: 600, responseReceivedMs: 610, book } },
    { localSequence: 11, recordType: "rest-anchor", sourceTimestampMs: 520, payload: { tokenId: "t", requestStartedMs: 700, responseReceivedMs: 710, book } },
  ], { expectedTokenIds: ["t"], maxRestAgeMs: 1000, maxTimestampSkewMs: 100 });
  assert.deepEqual(result.statuses.map((row) => row.status), ["quarantined-after-gap", "quarantined-after-gap", "matched", "quarantined-after-gap", "quarantined-after-gap", "matched"]);
  assert.equal(result.statuses[0].recoveryProof, false);
  assert.equal(result.statuses[1].recoveryProof, true);
  assert.equal(result.quality.sessionPermanentlyDisqualified, true);
  assert.equal(result.quality.promotionEligible, false);
});

test("malformed capture failures globally quarantine all expected tokens until full recovery", () => {
  const book = { bids: [], asks: [{ price: "0.5", size: "1" }] };
  const result = reconcile([
    { localSequence: 1, recordType: "ws", sourceTimestampMs: 100, payload: { asset_id: "a", ...book } },
    { localSequence: 2, recordType: "ws", sourceTimestampMs: 100, payload: { asset_id: "b", ...book } },
    { localSequence: 3, recordType: "failure", payload: { code: "ws-malformed" } },
    { localSequence: 4, recordType: "rest-anchor", sourceTimestampMs: 100, payload: { tokenId: "a", requestStartedMs: 200, responseReceivedMs: 210, book } },
    { localSequence: 5, recordType: "ws", sourceTimestampMs: 300, payload: { asset_id: "a", ...book } },
    { localSequence: 6, recordType: "rest-anchor", sourceTimestampMs: 300, payload: { tokenId: "a", requestStartedMs: 400, responseReceivedMs: 410, book } },
  ], { expectedTokenIds: ["a", "b"], ...RECONCILIATION_HARD_LIMITS });
  assert.equal(result.statuses[0].recoveryProof, false);
  assert.equal(result.statuses[1].recoveryProof, true);
  assert.equal(result.quality.globalQuarantine, true);
  assert.equal(result.quality.promotionEligible, false);
  assert.ok(result.quality.failureCodes.includes("ws-malformed"));
});

test("a mismatch followed by later matching anchors remains permanently ineligible", () => {
  const good = { bids: [], asks: [{ price: "0.5", size: "1" }] };
  const bad = { bids: [], asks: [{ price: "0.6", size: "1" }] };
  const result = reconcile([
    { localSequence: 1, recordType: "ws", sourceTimestampMs: 100, payload: { asset_id: "t", ...bad } },
    { localSequence: 2, recordType: "rest-anchor", sourceTimestampMs: 100, payload: { tokenId: "t", requestStartedMs: 200, responseReceivedMs: 210, book: good } },
    { localSequence: 3, recordType: "ws", sourceTimestampMs: 300, payload: { asset_id: "t", ...good } },
    { localSequence: 4, recordType: "rest-anchor", sourceTimestampMs: 300, payload: { tokenId: "t", requestStartedMs: 400, responseReceivedMs: 410, book: good } },
  ], { expectedTokenIds: ["t"], ...RECONCILIATION_HARD_LIMITS });
  assert.deepEqual(result.statuses.map((row) => row.status), ["mismatch", "matched"]);
  assert.equal(result.quality.sessionPermanentlyDisqualified, true);
  assert.equal(result.quality.promotionEligible, false);
});

test("stale REST timestamps fail reconciliation freshness", () => {
  const book = { bids: [], asks: [] };
  const result = reconcile([
    { localSequence: 1, recordType: "ws", sourceTimestampMs: 1, payload: { asset_id: "t", ...book } },
    { localSequence: 2, recordType: "rest-anchor", sourceTimestampMs: 1, payload: { tokenId: "t", requestStartedMs: 9000, responseReceivedMs: 10000, book } },
  ], { expectedTokenIds: ["t"], maxRestAgeMs: 100, maxTimestampSkewMs: RECONCILIATION_HARD_LIMITS.maxTimestampSkewMs });
  assert.equal(result.statuses[0].reason, "rest-timestamp-stale-or-invalid");
  assert.equal(result.quality.promotionEligible, false);
});

test("reconciliation rejects missing, invalid, and oversized caller time bounds", () => {
  assert.throws(() => reconcile([], {}), /invalid-reconciliation-time-bounds/);
  assert.throws(() => reconcile([], { maxRestAgeMs: -1, maxTimestampSkewMs: 1 }), /invalid-reconciliation-time-bounds/);
  assert.throws(() => reconcile([], { maxRestAgeMs: 1, maxTimestampSkewMs: Number.POSITIVE_INFINITY }), /invalid-reconciliation-time-bounds/);
  assert.throws(() => reconcile([], { maxRestAgeMs: RECONCILIATION_HARD_LIMITS.maxRestAgeMs + 1, maxTimestampSkewMs: RECONCILIATION_HARD_LIMITS.maxTimestampSkewMs }), /invalid-reconciliation-time-bounds/);
  assert.throws(() => reconcile([], { maxRestAgeMs: RECONCILIATION_HARD_LIMITS.maxRestAgeMs, maxTimestampSkewMs: RECONCILIATION_HARD_LIMITS.maxTimestampSkewMs + 1 }), /invalid-reconciliation-time-bounds/);
});

test("official-source contracts reject credentials and accept dated raw fixture metadata", () => {
  assert.throws(() => validateOfficialSource({ sourceType: "BLS_PUBLIC_JSON", credentialFree: false }), /credential-free/);
  assert.throws(() => validateOfficialSource({ sourceType: "BLS_PUBLIC_JSON", credentialFree: true, seriesId: "x", period: "2026-07", value: 1, releaseAt: "2026-08-01", retrievedAt: "2026-08-02" }), /raw-sha256/);
  const raw = validateOfficialSource({ sourceType: "FED_RAW_FIXTURE", fixtureName: "fed.txt", documentDate: "2026-08-01", capturedAt: "2026-08-02", sha256: "a".repeat(64) });
  assert.equal(raw.contractValid, true);
  assert.deepEqual(officialMetadataFixture().map((entry) => validateOfficialSource(entry).sourceType), ["FED_RAW_FIXTURE", "BLS_RAW_FIXTURE", "BEA_RAW_FIXTURE"]);
  assert.throws(() => validateOfficialSource({ sourceType: "CME_PRIVATE" }), /unsupported/);
});

test("frozen model enforces chronology and normalizes five probabilities exactly", () => {
  const forecast = forecastFomc(observationsFixture());
  assert.deepEqual(forecast, forecastFomc(observationsFixture()));
  assert.equal(forecast.outcomes.length, 5);
  assert.equal(forecast.probabilitySumAtoms, FIXED_SCALE.toString());
  assert.equal(forecast.chronologyValid, true);
  assert.equal(forecast.factors[0].loadings.length, 5);
  assert.equal(forecast.parameterStatus, "transparent-assumptions-not-calibrated-alpha");
  assert.equal(forecast.futuresOis.status, "unknown");
  const invalid = observationsFixture();
  invalid.observations.inflation.source.releaseAt = "2026-09-01T00:00:00Z";
  assert.throws(() => forecastFomc(invalid), /chronology-violation/);
  const wrongSeries = observationsFixture();
  wrongSeries.observations.inflation.source.seriesId = "WRONG";
  assert.throws(() => forecastFomc(wrongSeries), /source-binding-violation/);
  const wrongPeriod = observationsFixture();
  wrongPeriod.observations.inflation.source.period = "2026-06";
  assert.throws(() => forecastFomc(wrongPeriod), /source-binding-violation/);
  const mismatch = observationsFixture();
  mismatch.observations.payrolls.actual = "80001";
  assert.throws(() => forecastFomc(mismatch), /source-value-mismatch/);
  const override = observationsFixture();
  override.observations.unemployment.reference = "4.2";
  assert.throws(() => forecastFomc(override), /reference-override-forbidden/);
  const postRetrieval = observationsFixture();
  postRetrieval.observations.inflation.source.retrievedAt = "2026-09-02T00:00:00Z";
  assert.throws(() => forecastFomc(postRetrieval), /chronology-violation/);
  const revised = observationsFixture();
  revised.observations.inflation.source.revisionAt = "2026-09-02T00:00:00Z";
  assert.throws(() => forecastFomc(revised), /post-forecast-revision/);
});

test("multiclass metrics match examples and deduplicate identical forecast vintages", () => {
  const perfect = scoreVector([1, 0, 0, 0, 0], 0);
  assert.equal(perfect.brier, 0);
  assert.equal(perfect.log, 0);
  const row = { targetId: "fomc", vintageAt: "2026-08-01", actualOutcome: 2, probabilities: [0.1, 0.1, 0.6, 0.1, 0.1] };
  const metrics = multiclassMetrics([row, { ...row }], { marketBaselines: [[0.2, 0.2, 0.2, 0.2, 0.2]], priorBaselines: [[0.03, 0.22, 0.5, 0.22, 0.03]] });
  assert.equal(metrics.count, 1);
  assert.equal(metrics.deduplicated, 1);
  assert.ok(Math.abs(metrics.model.brier - 0.2) < 1e-12);
  assert.ok(metrics.marketBaseline && metrics.priorBaseline);
  assert.ok(Number.isFinite(metrics.expectedCalibrationError));
});

test("fixed taker fee and depth conform to R1 rounding, symmetry, FOK, FAK, haircut, and latency", () => {
  assert.equal(takerFee("10", "0.02", "0.2"), "0.032");
  assert.equal(takerFee("10", "0.02", "0.8"), "0.032");
  assert.equal(takerFee("1", "0.00001", "0.5"), "0");
  const frames = [{ timestampMs: 1100, authority: "REST", asks: [{ price: "0.4", size: "2" }, { price: "0.5", size: "1" }], bids: [] }];
  const fok = simulateDepth({ side: "buy", frames, decisionTimeMs: 1000, latencyMs: 100, shares: "4", feeRate: "0", orderType: "FOK", tickSize: "0.01" });
  assert.equal(fok.blocker, "insufficient-depth-for-fok");
  const fak = simulateDepth({ side: "buy", frames, decisionTimeMs: 1000, latencyMs: 100, shares: "4", feeRate: "0", orderType: "FAK", tickSize: "0.01", depthHaircutBps: 5000, adverseTicks: 1 });
  assert.equal(fak.partial, true);
  assert.equal(fak.filledShares, "1.5");
  assert.equal(fak.frameTimestampMs, 1100);
});

test("portfolio simulation covers all subsets, configured partial fills, catalyst stress, and terminal losses", () => {
  const simulation = simulatePortfolio(simulationFixture());
  assert.deepEqual(simulation, simulatePortfolio(simulationFixture()));
  assert.equal(simulation.subsetCount, 31);
  assert.equal(simulation.all31NonemptySubsets.length, 31);
  assert.equal(simulation.configuredPartialFills.length, 10);
  assert.equal(simulation.requiredScenarioSet.expectedCount, 42);
  assert.equal(simulation.requiredScenarioSet.evaluableCount, 42);
  assert.equal(simulation.catalystShock.additionalAdverseTicks, 2);
  assert.ok(Number(simulation.all31NonemptySubsets[0].worstTerminalPnl) < 0);
  assert.ok(Number(simulation.conservativeBaseNet) < 0);
  assert.equal(simulation.restAuthorityComplete, true);
  assert.equal(simulation.observedFills, 0);
  assert.equal(simulation.realizedPnl, null);
  assert.equal(simulation.supplementalRewards.includedInBase, false);
  const missingAssumptions = simulationFixture();
  delete missingAssumptions.makerFillAssumptions;
  assert.throws(() => simulatePortfolio(missingAssumptions), /explicit-counterfactual/);
  const incompleteInput = simulationFixture();
  incompleteInput.books[0].frames[0].asks[0].size = "1";
  const incomplete = simulatePortfolio(incompleteInput);
  assert.equal(incomplete.requiredScenarioSet.complete, false);
  assert.equal(incomplete.conservativeBaseNet, null);
});

function rawPolicyInput(options = {}) {
  const snapshot = marketSnapshotFixture();
  const map = exactFomcMarketMap(snapshot);
  const tokens = map.markets.flatMap((row) => [row.yesTokenId, row.noTokenId]);
  const records = [];
  tokens.forEach((tokenId, index) => {
    const timestamp = 1000 + index;
    const book = { asset_id: tokenId, timestamp: String(timestamp).padStart(13, "0"), bids: [{ price: "0.4", size: "100" }], asks: [{ price: "0.6", size: "100" }] };
    records.push({ localSequence: records.length + 1, recordType: "ws", receivedAtMs: timestamp + 10, sourceTimestampMs: timestamp, payloadHash: artifactHash(book), payload: book });
    const restPayload = { tokenId, requestStartedMs: timestamp + 100, responseReceivedMs: timestamp + 200, book };
    records.push({ localSequence: records.length + 1, recordType: "rest-anchor", receivedAtMs: timestamp + 200, sourceTimestampMs: timestamp, payloadHash: artifactHash(restPayload), payload: restPayload });
  });
  const capture = {
    meta: { schemaVersion: 1, mode: "bounded-public-historian", mappingHash: mapBindingHash(map) },
    records,
    complete: { schemaVersion: 1, completed: true, reason: "duration-complete", endedAtMs: 2200, counts: { events: records.length, requests: 10, failures: 0, reconnects: 0 } },
    crashTail: false,
  };
  const sourceBundle = {
    forecastInput: observationsFixture(),
    futuresOis: options.futures === false ? undefined : { sourceType: "CREDENTIAL_FREE_PUBLIC_FUTURES_OIS", rawSha256: "c".repeat(64), observedAt: "2026-08-29T00:00:00Z", retrievedAt: "2026-08-30T00:00:00Z", observations: [{ tenor: "meeting", rate: "4.5" }] },
  };
  const forecast = forecastFomc(sourceBundle.forecastInput);
  forecast.futuresOis = options.futures === false ? { status: "unknown", reason: "No credential-free public futures/OIS raw input supplied." } : { status: "verified-public-input", sourceType: sourceBundle.futuresOis.sourceType, rawSha256: sourceBundle.futuresOis.rawSha256, observedAt: sourceBundle.futuresOis.observedAt, retrievedAt: sourceBundle.futuresOis.retrievedAt };
  forecast.sourceBundleHash = artifactHash(sourceBundle);
  const simulationPlan = simulationFixture();
  simulationPlan.bindings = { sourceBundleHash: artifactHash(sourceBundle), historyHash: captureHistoryHash(capture), forecastHash: artifactHash(forecast) };
  const scoreRows = Array.from({ length: options.samples || 30 }, (_, index) => ({ targetId: "september-2026-fomc", vintageAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00Z`, actualOutcome: "NO_CHANGE", probabilities: [0, 0, 1, 0, 0], resolution: { outcome: "NO_CHANGE", sourceType: "FED_RAW_FIXTURE", rawSha256: "f".repeat(64), resolvedAt: "2026-09-16T18:00:00Z" } }));
  return {
    snapshot,
    capture,
    sourceBundle,
    scoreInput: { rows: scoreRows, options: {} },
    simulationPlan,
    reconciliationPolicy: { maxRestAgeMs: 5000, maxTimestampSkewMs: 1000 },
    catalystPolicy: { schemaVersion: 1, mode: "paper-catalyst-policy", approved: true, maxAdditionalAdverseTicks: 2 },
    paperPolicy: { schemaVersion: 1, mode: "paper-only", allowedStatuses: options.allowedStatuses === undefined ? ["REJECT", "WATCH", "PAPER_PROMOTE"] : options.allowedStatuses, minMetricSamples: 30, maxCalibrationError: 0.1, maxCaptureAgeMs: 1000, maxExposure: 100 },
    prospective: options.prospective !== false,
    fixture: options.fixture === true,
    asOfMs: 2300,
  };
}

test("aggregate evidence with self-attested hashes cannot reach policy evaluation", () => {
  const fabricated = { conservativeBaseNet: "1", gates: Object.fromEntries(GATES.map((gate) => [gate, true])), evidenceManifest: { bindings: { self: artifactHash({ fake: true }) } } };
  const result = evaluatePolicy(fabricated);
  assert.equal(result.status, "REJECT");
  assert.equal(result.reason, "pipeline-built-evidence-required");
});

test("only an in-process pipeline-built branded bundle reaches derived evaluation", () => {
  const raw = rawPolicyInput();
  const bundle = buildPolicyEvidence(raw);
  const result = evaluatePolicy(bundle);
  assert.notEqual(result.reason, "pipeline-built-evidence-required");
  assert.equal(result.status, "REJECT");
  assert.ok(Number(result.conservativeBaseNet) < 0);
  assert.equal(result.observedFills, 0);
  assert.equal(result.realizedPnl, null);
  const serialized = JSON.parse(JSON.stringify(bundle));
  assert.equal(evaluatePolicy(serialized).reason, "pipeline-built-evidence-required");
});

test("pipeline builder rejects cross-map, mappingHash, source, metric, and simulation mixes", () => {
  const mappingHash = rawPolicyInput();
  mappingHash.capture.meta.mappingHash = "wrong";
  assert.throws(() => buildPolicyEvidence(mappingHash), /capture-map-mappingHash-mismatch/);
  const journalMix = rawPolicyInput();
  journalMix.capture.records[0].payload.asks[0].price = "0.7";
  assert.throws(() => buildPolicyEvidence(journalMix), /capture-journal-hash-or-sequence-mismatch/);
  const tokenMix = rawPolicyInput();
  tokenMix.simulationPlan.books[0].tokenId = tokenMix.simulationPlan.books[1].tokenId;
  assert.throws(() => buildPolicyEvidence(tokenMix), /simulation-map-token-binding-mismatch/);
  const crossMap = rawPolicyInput();
  crossMap.snapshot.markets[0].clobTokenIds = JSON.stringify(["different-token", JSON.parse(crossMap.snapshot.markets[0].clobTokenIds)[1]]);
  crossMap.capture.meta.mappingHash = mapBindingHash(exactFomcMarketMap(crossMap.snapshot));
  assert.throws(() => buildPolicyEvidence(crossMap), /capture-token-set-mismatch/);
  const sourceMix = rawPolicyInput();
  sourceMix.sourceBundle.forecastInput.observations.inflation.actual = "9";
  assert.throws(() => buildPolicyEvidence(sourceMix), /source-value-mismatch/);
  const metricMix = rawPolicyInput();
  metricMix.scoreInput.rows[0].targetId = "other-target";
  assert.throws(() => buildPolicyEvidence(metricMix), /metric-target-or-resolution-binding-mismatch/);
  const resolutionMix = rawPolicyInput();
  resolutionMix.scoreInput.rows[0].resolution.outcome = "HIKE_25";
  assert.throws(() => buildPolicyEvidence(resolutionMix), /metric-target-or-resolution-binding-mismatch/);
  const historyMix = rawPolicyInput();
  historyMix.simulationPlan.bindings.historyHash = "d".repeat(64);
  assert.throws(() => buildPolicyEvidence(historyMix), /simulation-history-binding-mismatch/);
  const forecastMix = rawPolicyInput();
  forecastMix.simulationPlan.bindings.forecastHash = "e".repeat(64);
  assert.throws(() => buildPolicyEvidence(forecastMix), /simulation-forecast-binding-mismatch/);
});

test("PAPER_PROMOTE omission and empty allowedStatuses fail the status-policy gate", () => {
  for (const allowedStatuses of [[], ["REJECT", "WATCH"]]) {
    const result = evaluatePolicy(buildPolicyEvidence(rawPolicyInput({ allowedStatuses })));
    assert.equal(result.status, "REJECT");
    assert.equal(result.gates.statusPolicy, false);
  }
  const omitted = rawPolicyInput();
  delete omitted.paperPolicy.allowedStatuses;
  const omittedResult = evaluatePolicy(buildPolicyEvidence(omitted));
  assert.equal(omittedResult.status, "REJECT");
  assert.equal(omittedResult.gates.statusPolicy, false);
});

test("huge raw and paper freshness bounds cannot make stale matching books eligible", () => {
  const raw = rawPolicyInput();
  const staleRest = raw.capture.records.find((record) => record.recordType === "rest-anchor");
  staleRest.payload.responseReceivedMs = Number(staleRest.sourceTimestampMs) + RECONCILIATION_HARD_LIMITS.maxRestAgeMs + 1;
  staleRest.receivedAtMs = staleRest.payload.responseReceivedMs;
  staleRest.payloadHash = artifactHash(staleRest.payload);
  raw.reconciliationPolicy = { maxRestAgeMs: Number.MAX_SAFE_INTEGER, maxTimestampSkewMs: Number.MAX_SAFE_INTEGER };
  raw.paperPolicy.maxRestAgeMs = Number.MAX_SAFE_INTEGER;
  raw.paperPolicy.maxTimestampSkewMs = Number.MAX_SAFE_INTEGER;
  raw.simulationPlan.bindings.historyHash = captureHistoryHash(raw.capture);
  const bundle = buildPolicyEvidence(raw);
  const staleStatus = bundle.reconciliation.statuses.find((row) => row.restSequence === staleRest.localSequence);
  assert.equal(staleStatus.status, "mismatch");
  assert.equal(staleStatus.reason, "rest-timestamp-stale-or-invalid");
  assert.equal(bundle.reconciliation.quality.restFreshnessBoundMs, RECONCILIATION_HARD_LIMITS.maxRestAgeMs);
  assert.equal(bundle.reconciliation.quality.timestampSkewBoundMs, RECONCILIATION_HARD_LIMITS.maxTimestampSkewMs);
  assert.equal(bundle.reconciliation.quality.sessionPermanentlyDisqualified, true);
  assert.equal(bundle.reconciliation.quality.promotionEligible, false);
  assert.equal(evaluatePolicy(bundle).status, "REJECT");
});

test("missing futures, insufficient raw metrics, fixture provenance, and rewards remain rejecting", () => {
  const raw = rawPolicyInput({ futures: false, samples: 1, prospective: false, fixture: true });
  raw.simulationPlan.supplementalRewards = "1000000";
  raw.simulationPlan.bindings.sourceBundleHash = artifactHash(raw.sourceBundle);
  const forecast = forecastFomc(raw.sourceBundle.forecastInput);
  forecast.futuresOis = { status: "unknown", reason: "No credential-free public futures/OIS raw input supplied." };
  forecast.sourceBundleHash = artifactHash(raw.sourceBundle);
  raw.simulationPlan.bindings.forecastHash = artifactHash(forecast);
  const result = evaluatePolicy(buildPolicyEvidence(raw));
  assert.equal(result.status, "REJECT");
  assert.equal(result.rewardsConsideredForPromotion, false);
  assert.equal(result.gates.futures, false);
  assert.equal(result.gates.sample, false);
  assert.equal(result.gates.evidence, false);
});

test("historian transport is fixed to official origins and endpoint overrides are forbidden", () => {
  assert.deepEqual(assertFixedTransport({}), { restOrigin: "https://clob.polymarket.com", wsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market" });
  assert.throws(() => assertFixedTransport({ restUrl: "https://example.invalid" }), /endpoint-overrides-forbidden/);
});

test("historian heartbeat sends text PING and fails closed without timely PONG", () => {
  const sent = [];
  const socket = { send: (value) => sent.push(value) };
  assert.equal(heartbeatAction(socket, 20_000, 0), "PING");
  assert.deepEqual(sent, ["PING"]);
  assert.throws(() => heartbeatAction(socket, 20_001, 0), /heartbeat-timeout-fail-closed/);
});

test("historian rejects redirects and uses abortable no-redirect REST requests", async (t) => {
  const directory = workspace(t);
  let requestOptions;
  class Socket {
    addEventListener() {}
    close() {}
  }
  const complete = await captureBounded({
    sessionDir: directory,
    mappingHash: "map",
    tokenIds: ["token"],
    durationMs: 100,
    pollMs: 1,
    maxEvents: 10,
    maxBytes: 10000,
    maxRequests: 2,
    maxReconnects: 0,
    maxFailures: 2,
    requestTimeoutMs: 10,
  }, {
    WebSocketImpl: Socket,
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return { ok: true, redirected: true, status: 200, url: "https://clob.polymarket.com/book", json: async () => ({}) };
    },
  });
  assert.equal(requestOptions.redirect, "error");
  assert.ok(requestOptions.signal instanceof AbortSignal);
  assert.equal(complete.reason, "rest-failure-fail-closed");
  assert.equal(complete.counts.failures, 1);
});

test("historian request timeout aborts and fails closed", async (t) => {
  const directory = workspace(t);
  class Socket { addEventListener() {} close() {} }
  const complete = await captureBounded({
    sessionDir: directory, mappingHash: "map", tokenIds: ["token"], durationMs: 100,
    pollMs: 1, maxEvents: 10, maxBytes: 10000, maxRequests: 2, maxReconnects: 0,
    maxFailures: 2, requestTimeoutMs: 1,
  }, {
    WebSocketImpl: Socket,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
  });
  assert.equal(complete.reason, "rest-timeout-fail-closed");
});

test("CLI is offline by default and deterministic fixture replay has no network path", (t) => {
  const directory = workspace(t);
  const cli = path.join(__dirname, "..", "polymarket-research-r3", "cli.js");
  const help = spawnSync(process.execPath, [cli], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Only capture may instantiate public network transports/);
  assert.doesNotMatch(help.stdout, /--rest-url|--ws-url/);
  assert.doesNotMatch(help.stdout, /--evidence FILE|--demo-evidence/);
  const one = path.join(directory, "one.json");
  const two = path.join(directory, "two.json");
  assert.equal(spawnSync(process.execPath, [cli, "replay", "--demo", "--out", one], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync(process.execPath, [cli, "replay", "--demo", "--out", two], { encoding: "utf8" }).status, 0);
  assert.equal(fs.readFileSync(one, "utf8"), fs.readFileSync(two, "utf8"));
  assert.equal(spawnSync(process.execPath, [cli, "replay", "--demo", "--out", one], { encoding: "utf8" }).status, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(one, "utf8")).records, journalFixture());
  const snapshot = path.join(directory, "snapshot.json");
  const raw = path.join(directory, "raw.json");
  const session = path.join(directory, "session");
  const promotion = path.join(directory, "promotion.json");
  fs.writeFileSync(snapshot, JSON.stringify(marketSnapshotFixture()), "utf8");
  assert.equal(spawnSync(process.execPath, [cli, "raw-fixture", "--snapshot", snapshot, "--session-dir", session, "--out", raw], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync(process.execPath, [cli, "promote", "--snapshot", snapshot, "--session-dir", session, "--raw-input", raw, "--out", promotion], { encoding: "utf8" }).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(promotion, "utf8")).status, "REJECT");
  assert.equal(spawnSync(process.execPath, [cli, "promote", "--simulation", one, "--evidence", two, "--out", path.join(directory, "forbidden.json")], { encoding: "utf8" }).status, 1);
});
