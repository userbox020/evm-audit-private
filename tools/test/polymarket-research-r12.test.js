"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const R = require("../polymarket-research-r12");

const CAPTURED = Date.parse("2026-08-31T14:00:00Z");
const START = CAPTURED - 120_000;
const END = CAPTURED + 30 * 24 * 60 * 60 * 1000;

function acceptedRecord(overrides = {}) {
  return {
    marketId: "7001", status: "REJECT", reason: "window-ongoing", bindingAccepted: true, referenceEquivalenceVerified: false,
    market: { marketId: "7001", conditionId: `0x${"1".repeat(64)}` },
    rule: { family: "creation", asset: "BTC", quoteAsset: "USDT", binanceSymbol: "BTCUSDT", interval: "1m", priceField: "High", comparator: ">=", yesCondition: "High >= 60000", threshold: "60000", startMs: START, endMs: END, requiredCandles: (END - START) / 60_000 },
    reference: { source: "binance-rest-klines", symbol: "BTCUSDT", interval: "1m", capturedAtMs: CAPTURED, referenceConditionMet: null, completeHistory: false, expectedCandleCount: 2, retainedCandleCount: 2, candleHash: "a".repeat(64), requestPages: 1, queryStartMs: START, queryEndMs: CAPTURED, firstHit: null, firstGapMs: null },
    ...overrides,
  };
}

function r9Artifact(record = acceptedRecord()) {
  const recordHash = R.hash({ index: 0, previousHash: null, record });
  return { schemaVersion: 2, mode: "r9-binance-btcusdt-hit-price-reference-scan", asOfMs: CAPTURED, sourceHashes: { acceptedChainHead: recordHash }, records: [{ ...record, previousHash: null, recordHash }], highestStatus: "REJECT", profitabilityClaim: false, routePositive: "unknown", signedActionJustified: false, shadowOnly: true };
}

function surface(overrides = {}) {
  const base = {
    schemaVersion: 1, mode: "r12-deribit-btc-option-surface-fixture", capturedAtMs: CAPTURED + 500,
    underlying: { asset: "BTC", indexName: "btc_usd", underlyingPrice: "50100", indexPrice: "50000", sourceTimestampMs: CAPTURED + 250 },
    selectedOption: { instrumentName: "BTC-30SEP26-60000-C", underlyingIndex: "btc_usd", expiryTimestampMs: END, strike: "60000", optionType: "call", bestBidPrice: "0.04", bestAskPrice: "0.05", bidIv: "0.5", askIv: "0.6", markIv: "0.55", forwardPrice: "50100", liquid: true },
  };
  return { ...base, ...overrides, underlying: { ...base.underlying, ...(overrides.underlying || {}) }, selectedOption: { ...base.selectedOption, ...(overrides.selectedOption || {}) } };
}

function rehash(input) {
  const artifact = structuredClone(input); const record = artifact.records[0];
  const { previousHash, recordHash: _ignored, ...core } = record;
  record.recordHash = R.hash({ index: 0, previousHash, record: core }); artifact.sourceHashes.acceptedChainHead = record.recordHash;
  return artifact;
}

test("normal CDF and GBM upper-hit formula satisfy limits and zero-log-drift identity", () => {
  assert.equal(R.normalCdf(0), 0.5); assert.equal(R.normalCdf(-Infinity), 0); assert.equal(R.normalCdf(Infinity), 1);
  assert.equal(R.upperHitProbability(100, 90, 1, 0.2, 0), 1); assert.equal(R.upperHitProbability(100, 110, 0, 0.2, 0), 0);
  const years = 0.75; const sigma = 0.4; const barrier = 130;
  const actual = R.upperHitProbability(100, barrier, years, sigma, sigma * sigma / 2);
  const identity = 2 * R.normalCdf(-Math.log(barrier / 100) / (sigma * Math.sqrt(years)));
  assert.ok(Math.abs(actual - identity) < 1e-12);
});

test("formula is monotone in volatility and barrier and finite for extreme valid inputs", () => {
  assert.ok(R.upperHitProbability(100, 130, 0.5, 0.8, 0.02) > R.upperHitProbability(100, 130, 0.5, 0.15, 0.02));
  assert.ok(R.upperHitProbability(100, 120, 0.5, 0.4, 0.02) > R.upperHitProbability(100, 180, 0.5, 0.4, 0.02));
  for (const value of [R.upperHitProbability(1, 1e7, 1e-8, 0.01, -5), R.upperHitProbability(1, 1.000001, 2, 5, 5)]) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
});

test("strict surface rejects stale, expiry, basis, crossed, wide, unknown, and invalid IV data", () => {
  const r9 = R.validateR9(r9Artifact()); const config = R.validateConfig();
  const mutations = [
    surface({ capturedAtMs: CAPTURED + 2001 }), surface({ selectedOption: { expiryTimestampMs: END + 1 } }),
    surface({ underlying: { indexPrice: "51000" }, selectedOption: { forwardPrice: "51100" } }),
    surface({ selectedOption: { bestBidPrice: "0.05", bestAskPrice: "0.05" } }), surface({ selectedOption: { bestBidPrice: "0.01", bestAskPrice: "0.02" } }),
    surface({ selectedOption: { bidIv: "0" } }), surface({ selectedOption: { bidIv: "0.7" } }), { ...surface(), extra: true },
  ];
  for (const fixture of mutations) assert.throws(() => R.validateSurface(fixture, r9, config), /r12-/);
  assert.throws(() => R.validateConfig({ basisBps: 1001 }), /config/);
});

test("valuation bands are ordered and combine IV, basis, drift, and monitoring controls", () => {
  const output = R.value(r9Artifact(), surface()); const probability = output.valuation.probabilities;
  assert.ok(Number(probability.lower) <= Number(probability.central)); assert.ok(Number(probability.central) <= Number(probability.upper));
  assert.ok(Number(probability.monitoringCorrectedLower) <= Number(probability.parameterUpper));
  assert.equal(output.approximationControls.scenarioCount, 27); assert.equal(output.approximationControls.continuousMonitoringIsUpperApproximation, true);
  const { previousHash, valuationHash, ...core } = output.valuation;
  assert.equal(valuationHash, R.hash({ index: 0, previousHash, valuation: core }));
});

test("exact R9 hash chain and sole accepted upward completed record are mandatory", () => {
  const broken = r9Artifact(); broken.records[0].recordHash = "0".repeat(64); assert.throws(() => R.validateR9(broken), /chain/);
  const downward = r9Artifact(); downward.records[0].rule.priceField = "Low"; downward.records[0].rule.comparator = "<="; downward.records[0].rule.yesCondition = "Low <= 60000"; assert.throws(() => R.validateR9(rehash(downward)), /upward/);
  const incomplete = r9Artifact(); incomplete.records[0].reference.retainedCandleCount = 1; assert.throws(() => R.validateR9(rehash(incomplete)), /reference/);
  const ambiguous = r9Artifact(); const second = acceptedRecord({ marketId: "7002", market: { marketId: "7002", conditionId: `0x${"2".repeat(64)}` } }); const secondHash = R.hash({ index: 1, previousHash: ambiguous.records[0].recordHash, record: second }); ambiguous.records.push({ ...second, previousHash: ambiguous.records[0].recordHash, recordHash: secondHash }); ambiguous.sourceHashes.acceptedChainHead = secondHash; assert.throws(() => R.validateR9(ambiguous), /accepted-record/);
});

test("output makes only model-based non-executable REJECT claims and is hash-linked/bounded", () => {
  const output = R.value(r9Artifact(), surface()); assert.equal(output.highestStatus, "REJECT");
  for (const scope of [output, output.valuation]) { assert.equal(scope.modelBased, true); assert.equal(scope.probabilityKind, "risk-neutral-proxy"); assert.equal(scope.monitoringModel, "continuous-upper-bound-for-1m"); assert.equal(scope.nonExecutable, true); }
  assert.equal(output.signedActionJustified, false);
  assert.match(output.inputHashes.r9CanonicalHash, /^[a-f0-9]{64}$/); assert.equal(output.inputHashes.valuationChainHead, output.valuation.valuationHash);
  const serialized = JSON.stringify(output); for (const forbidden of ["WATCH", "fill", "PnL", "pnl", "profit", "route"]) assert.equal(serialized.includes(forbidden), false);
  assert.ok(Buffer.byteLength(`${JSON.stringify(output, null, 2)}\n`) <= R.LIMITS.outputBytes);
});

test("CLI help is offline, rejects transport options, and output never overwrites", (t) => {
  const cli = path.resolve(__dirname, "../polymarket-research-r12/cli.js"); const help = spawnSync(process.execPath, [cli], { encoding: "utf8", env: {} });
  assert.equal(help.status, 0); assert.match(help.stdout, /offline upper-barrier/); assert.doesNotMatch(help.stdout, /https?:\/\//);
  const parser = require("../polymarket-research-r12/cli"); assert.throws(() => parser.args(["value", "--url", "x"]), /invalid-argument/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-r12-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputPath = path.join(root, "out.json"); fs.writeFileSync(outputPath, "{}\n"); assert.throws(() => R.runValue({ r9Path: "missing", surfacePath: "missing", outputPath }), /output-exists/);
});
