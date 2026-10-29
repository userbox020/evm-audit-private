"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const R7 = require("../polymarket-research-r7");
const R12 = require("../polymarket-research-r12");
const R = require("../polymarket-research-r13");

const CAPTURED = Date.parse("2026-08-31T14:00:00Z");
const START = CAPTURED - 120_000;
const END = CAPTURED + 30 * 24 * 60 * 60 * 1000;

function book(tokenId, asks, overrides = {}) { return { tokenId, receivedAtMs: CAPTURED, sourceTimestampMs: CAPTURED, bids: [{ price: "0.1", size: "10" }], asks, ...overrides }; }

function acceptedRecord(options = {}) {
  const yesAsks = options.yesAsks || [{ price: "0.4", size: "1" }, { price: "0.45", size: "1" }];
  const noAsks = options.noAsks || [{ price: "0.3", size: "2" }];
  return {
    marketId: "7001", status: "REJECT", reason: "window-ongoing", bindingAccepted: true, referenceEquivalenceVerified: false,
    market: {
      marketId: "7001", conditionId: `0x${"1".repeat(64)}`, outcomes: [{ outcome: "Yes", tokenId: "90001" }, { outcome: "No", tokenId: "90002" }], tokenMap: { yesTokenId: "90001", noTokenId: "90002" }, tickSize: "0.01", minimumOrderSize: "2",
      feeConfig: options.feeConfig === undefined ? { enabled: true, rate: options.feeRate || "0.1", exponent: 1, takerOnly: true } : options.feeConfig,
      condition: { conditionId: `0x${"1".repeat(64)}`, active: true, closed: false, acceptingOrders: true, enableOrderBook: true, negRisk: false, tickSize: "0.01", minimumOrderSize: "2" },
      books: { yes: book("90001", yesAsks), no: book("90002", noAsks) },
    },
    rule: { family: "creation", asset: "BTC", quoteAsset: "USDT", binanceSymbol: "BTCUSDT", interval: "1m", priceField: "High", comparator: ">=", yesCondition: "High >= 60000", threshold: "60000", startMs: START, endMs: END, requiredCandles: (END - START) / 60_000 },
    reference: { source: "binance-rest-klines", symbol: "BTCUSDT", interval: "1m", capturedAtMs: CAPTURED, referenceConditionMet: null, completeHistory: false, expectedCandleCount: 2, retainedCandleCount: 2, candleHash: "a".repeat(64), requestPages: 1, queryStartMs: START, queryEndMs: CAPTURED, firstHit: null, firstGapMs: null },
  };
}

function r9Artifact(options = {}) {
  const record = acceptedRecord(options); const recordHash = R7.hash({ index: 0, previousHash: null, record });
  return { schemaVersion: 2, mode: "r9-binance-btcusdt-hit-price-reference-scan", asOfMs: CAPTURED, sourceHashes: { acceptedChainHead: recordHash }, records: [{ ...record, previousHash: null, recordHash }], highestStatus: "REJECT", profitabilityClaim: false, routePositive: "unknown", signedActionJustified: false, shadowOnly: true };
}

function surface() { return { schemaVersion: 1, mode: "r12-deribit-btc-option-surface-fixture", capturedAtMs: CAPTURED + 500, underlying: { asset: "BTC", indexName: "btc_usd", underlyingPrice: "50100", indexPrice: "50000", sourceTimestampMs: CAPTURED + 250 }, selectedOption: { instrumentName: "BTC-30SEP26-60000-C", underlyingIndex: "btc_usd", expiryTimestampMs: END, strike: "60000", optionType: "call", bestBidPrice: "0.04", bestAskPrice: "0.05", bidIv: "0.5", askIv: "0.6", markIv: "0.55", forwardPrice: "50100", liquid: true } }; }

function fixture(options = {}) { const r9 = r9Artifact(options); const r12 = R12.value(r9, surface()); return { schemaVersion: 1, mode: R.INPUT_MODE, r12, r9 }; }

function rehashR9(r9) { const value = structuredClone(r9); const record = value.records[0]; const { previousHash, recordHash: _old, ...core } = record; record.recordHash = R7.hash({ index: 0, previousHash, record: core }); value.sourceHashes.acceptedChainHead = record.recordHash; return value; }

test("strict R12, R9, hash, chronology, and claims gates fail closed", () => {
  const valid = fixture(); assert.equal(R.validateR12(valid.r12).probabilities.lower, valid.r12.valuation.probabilities.lower); assert.equal(R.validateR9(valid.r9).market.marketId, "7001");
  const badValuation = structuredClone(valid); badValuation.r12.valuation.valuationHash = "0".repeat(64); assert.throws(() => R.screenBundle(badValuation), /valuation-chain/);
  const badClaim = structuredClone(valid); badClaim.r12.modelBased = false; assert.throws(() => R.screenBundle(badClaim), /r12-input/);
  const badR9 = structuredClone(valid); badR9.r9.records[0].recordHash = "0".repeat(64); assert.throws(() => R.screenBundle(badR9), /r9-chain/);
  const mismatch = structuredClone(valid); mismatch.r9.records[0].marketId = "7002"; mismatch.r9.records[0].market.marketId = "7002"; mismatch.r9 = rehashR9(mismatch.r9); assert.throws(() => R.screenBundle(mismatch), /reference-basis-mismatch/);
  const empty = structuredClone(valid); empty.r9.records = []; empty.r9.sourceHashes.acceptedChainHead = null; assert.throws(() => R.screenBundle(empty), /r9-input|accepted/);
  const stale = structuredClone(valid); stale.r12.sourceBinding.surfaceCapturedAtMs = CAPTURED + 2001; assert.throws(() => R.screenBundle(stale), /reference-basis/);
});

test("FOK depth walk charges exact per-level published taker fees", () => {
  const output = R.screenBundle(fixture(), { modelHaircutBps: 100, latencyBps: 20, basisBps: 100, carryBps: 30, oneLegBps: 40, unwindBps: 50 });
  const yes = output.rows[0]; const no = output.rows[1];
  assert.equal(yes.executable.askGrossCost, "0.85"); assert.equal(yes.fills[0].takerFee, "0.024"); assert.equal(yes.fills[1].takerFee, "0.02475"); assert.equal(yes.executable.takerFee, "0.04875"); assert.equal(yes.executable.totalCost, "0.89875"); assert.equal(yes.executable.costPerShare, "0.449375");
  assert.equal(no.executable.askGrossCost, "0.6"); assert.equal(no.executable.takerFee, "0.042"); assert.equal(no.executable.totalCost, "0.642"); assert.equal(no.executable.costPerShare, "0.321");
});

test("all explicit reserves use exact six-decimal per-share math", () => {
  const output = R.screenBundle(fixture(), { modelHaircutBps: 100, latencyBps: 20, basisBps: 100, carryBps: 30, oneLegBps: 40, unwindBps: 50 }); const reserves = output.rows[0].reservesPerShare;
  assert.deepEqual(reserves, { modelHaircut: "0.01", latency: "0.002", basis: "0.01", carry: "0.003", oneLeg: "0.004", unwind: "0.005", total: "0.034" });
  const expected = R7.parseFixed(output.rows[0].fairProbability.lower) - R7.parseFixed("0.449375") - R7.parseFixed("0.034"); assert.equal(output.rows[0].counterfactualMarginPerShare.lower, R7.formatFixed(expected));
});

test("No-side fair range is the conservative complement of the Yes range", () => {
  const input = fixture(); const output = R.screenBundle(input); const yes = output.rows[0].fairProbability; const no = output.rows[1].fairProbability;
  assert.equal(R7.parseFixed(no.lower), R7.SCALE - R.probabilityAtoms(input.r12.valuation.probabilities.upper, "ceil"));
  assert.equal(R7.parseFixed(no.central), R7.SCALE - R.probabilityAtoms(input.r12.valuation.probabilities.central, "ceil"));
  assert.equal(R7.parseFixed(no.upper), R7.SCALE - R.probabilityAtoms(input.r12.valuation.probabilities.lower, "ceil"));
  assert.ok(R7.parseFixed(yes.lower) <= R7.parseFixed(yes.central) && R7.parseFixed(yes.central) <= R7.parseFixed(yes.upper));
});

test("positive numerical conservative edge remains REJECT with no execution claim", () => {
  const input = fixture({ feeRate: "0", yesAsks: [{ price: "0.2", size: "2" }], noAsks: [{ price: "0.2", size: "2" }] });
  const output = R.screenBundle(input, { modelHaircutBps: 0, latencyBps: 0, basisBps: 100, carryBps: 0, oneLegBps: 0, unwindBps: 0 });
  assert.ok(output.rows.some((row) => row.numericalConservativeEdgePositive)); assert.equal(output.distribution.positiveConservativeCount > 0, true);
  assert.ok(output.rows.every((row) => row.status === "REJECT" && row.executionEvidence === "none" && row.fillAssumption === "none" && row.routePositive === "unknown" && row.profitabilityClaim === false && row.signedActionJustified === false && row.shadowOnly === true)); assert.equal(output.status, "REJECT"); assert.equal(output.highestStatus, "REJECT"); assert.equal(output.routePositive, "unknown"); assert.equal(output.profitabilityClaim, false); assert.equal(output.signedActionJustified, false); assert.equal(output.shadowOnly, true);
});

test("unknown fee or cost and missing FOK depth reject", () => {
  const feeUnknown = fixture(); delete feeUnknown.r9.records[0].market.feeConfig.rate; feeUnknown.r9 = rehashR9(feeUnknown.r9); assert.throws(() => R.screenBundle(feeUnknown), /fee-unknown/);
  const shallow = fixture({ yesAsks: [{ price: "0.4", size: "1" }] }); assert.throws(() => R.screenBundle(shallow), /fok-depth/);
  assert.throws(() => R.screenBundle(fixture(), { latencyBps: null }), /cost-unknown/); assert.throws(() => R.screenBundle(fixture(), { unwindBps: 5001 }), /config/); assert.throws(() => R.screenBundle(fixture(), { basisBps: 99 }), /reference-basis/);
});

test("diagnostics, Wilson helper, row hashes, and output claims are bounded", () => {
  const output = R.screenBundle(fixture()); assert.equal(output.diagnostics.marketConcentration.inherentlyConcentrated, true); assert.equal(output.diagnostics.dayConcentration.inherentlyConcentrated, true); assert.equal(output.diagnostics.sourceConcentration.inherentlyConcentrated, true); assert.equal(output.diagnostics.futureRepeatedBinaryProxyWilson.lowerBound, null);
  assert.ok(Math.abs(R.wilsonLowerBound(50, 100) - 0.4038298286) < 1e-9); assert.equal(R.wilsonLowerBound(0, 0), null); assert.throws(() => R.wilsonLowerBound(2, 1), /wilson/);
  for (let index = 0; index < output.rows.length; index += 1) { const { previousHash, rowHash, ...row } = output.rows[index]; assert.equal(rowHash, R7.hash({ index, previousHash, row })); }
  const serialized = JSON.stringify(output); assert.equal(serialized.includes("WATCH"), false); assert.equal(serialized.includes("WATCH_SIGNAL"), false); assert.equal(serialized.includes("SHADOW_CANDIDATE"), false); assert.equal(output.limitations.realizedFillsEstablished, false); assert.equal(output.limitations.realizedPnlEstablished, false); assert.equal(output.limitations.profitabilityEstablished, false); assert.ok(Buffer.byteLength(`${JSON.stringify(output, null, 2)}\n`) <= R.LIMITS.outputBytes);
});

test("bounded input, exclusive output, and offline CLI expose no transport options", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-r13-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const large = path.join(root, "large.json"); fs.writeFileSync(large, `"${"x".repeat(R.LIMITS.inputBytes)}"`); assert.throws(() => R.readJsonBounded(large), /input-read/);
  const out = path.join(root, "out.json"); fs.writeFileSync(out, "{}\n"); assert.throws(() => R.runScreen({ r12Path: "missing", outputPath: out }), /output-exists/);
  const cli = path.resolve(__dirname, "../polymarket-research-r13/cli.js"); const help = spawnSync(process.execPath, [cli], { encoding: "utf8", env: {} }); assert.equal(help.status, 0); assert.match(help.stdout, /offline counterfactual/); assert.doesNotMatch(help.stdout, /https?:\/\//);
  const parser = require("../polymarket-research-r13/cli"); assert.throws(() => parser.args(["screen", "--url", "x"]), /invalid-argument/);
});
