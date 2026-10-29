"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const R = require("../polymarket-research-r14");

const BASE = Date.parse("2027-01-01T00:00:00Z");
const H = (character) => character.repeat(64);
const PROVENANCE = { classification: "fixture", brand: "r14-offline-test-double", independentlyVerified: false, selfAttested: false };

function link(records) {
  let previousHash = null;
  return records.map((record) => {
    const core = { ...record, previousHash }; const linked = { ...core, recordHash: R.hash(core) }; previousHash = linked.recordHash; return linked;
  });
}
function forecast(index, options = {}) {
  const sourceTimeMs = options.sourceTimeMs ?? BASE + index * 1_000;
  return {
    forecastId: options.forecastId ?? `forecast-${index}`, marketId: options.marketId ?? `market-${index}`,
    decisionTimeMs: options.decisionTimeMs ?? sourceTimeMs + 200, sourceTimeMs, receiptTimeMs: options.receiptTimeMs ?? sourceTimeMs + 100,
    probability: options.probability ?? "0.8", modelHash: options.modelHash ?? H("a"), marketHash: options.marketHash ?? H("b"), status: options.status ?? "REJECT",
  };
}
function outcome(index, options = {}) {
  return { outcomeId: options.outcomeId ?? `outcome-${index}`, marketId: options.marketId ?? `market-${index}`, outcome: options.outcome ?? 1, resolutionTimeMs: options.resolutionTimeMs ?? BASE + 1_000_000 + index, sourceHash: options.sourceHash ?? H("c") };
}
function wrappers(forecasts, outcomes, windows = null) {
  const forecastWrapper = { schemaVersion: 1, mode: "r14-forward-forecasts-fixture", provenance: { ...PROVENANCE }, records: link(forecasts) };
  const outcomeWrapper = { schemaVersion: 1, mode: "r14-forward-outcomes-fixture", provenance: { ...PROVENANCE }, records: link(outcomes) };
  if (windows) { forecastWrapper.windows = { ...windows }; outcomeWrapper.windows = { ...windows }; }
  return [forecastWrapper, outcomeWrapper];
}
function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-r14-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test("known Brier, log loss, calibration, coverage, and binary success metrics", () => {
  const [forecasts, outcomes] = wrappers(
    [forecast(0, { probability: "0.8" }), forecast(1, { probability: "0.2" })],
    [outcome(0, { outcome: 1 }), outcome(1, { outcome: 0 })],
  );
  const result = R.evaluate(forecasts, outcomes);
  assert.equal(result.metrics.brierScore, 0.04);
  assert.ok(Math.abs(result.metrics.logLoss - 0.223143551314) < 1e-12);
  assert.equal(result.metrics.logLossEpsilon, 0.000001);
  assert.deepEqual(result.metrics.calibrationBuckets.filter((bucket) => bucket.count).map((bucket) => [bucket.index, bucket.meanForecast, bucket.observedRate]), [[2, 0.2, 0], [8, 0.8, 1]]);
  assert.deepEqual(result.coverage, { forecastCount: 2, matchedForecastCount: 2, outcomeCount: 2, matchedOutcomeCount: 2, forecastCoverage: 1, outcomeCoverage: 1 });
  assert.equal(result.metrics.realizedBinarySuccess.successes, 2);
  assert.equal(result.metrics.realizedBinarySuccess.wilsonLower95, R.wilsonLower(2, 2));
});

test("record hashes, links, duplicate IDs, and missing pair links fail closed", () => {
  const [forecasts, outcomes] = wrappers([forecast(0), forecast(1)], [outcome(0), outcome(1)]);
  assert.doesNotThrow(() => R.evaluate(forecasts, outcomes));
  const brokenLink = structuredClone(forecasts); brokenLink.records[1].previousHash = H("d"); assert.throws(() => R.evaluate(brokenLink, outcomes), /link/);
  const brokenHash = structuredClone(forecasts); brokenHash.records[0].probability = "0.7"; assert.throws(() => R.evaluate(brokenHash, outcomes), /hash/);
  const duplicateForecasts = wrappers([forecast(0), forecast(1, { forecastId: "forecast-0" })], [outcome(0), outcome(1)])[0]; assert.throws(() => R.evaluate(duplicateForecasts, outcomes), /duplicate-id/);
  const crossDuplicate = wrappers([forecast(0)], [outcome(0, { outcomeId: "forecast-0" })]); assert.throws(() => R.evaluate(...crossDuplicate), /duplicate-id/);
  const missingOutcome = wrappers([forecast(0), forecast(1)], [outcome(0)])[1]; assert.throws(() => R.evaluate(forecasts, missingOutcome), /missing-outcome/);
  const extraOutcome = wrappers([forecast(0)], [outcome(0), outcome(1)])[1]; assert.throws(() => R.evaluate(wrappers([forecast(0)], [outcome(0)])[0], extraOutcome), /missing-forecast/);
});

test("chronology rejects source leakage, late decisions, overlap, and nonmonotonic outcomes", () => {
  const late = wrappers([forecast(0, { decisionTimeMs: BASE + 1_000_000 })], [outcome(0, { resolutionTimeMs: BASE + 1_000_000 })]); assert.throws(() => R.evaluate(...late), /decision-outcome/);
  const sourceAfterDecision = wrappers([forecast(0, { sourceTimeMs: BASE + 300, receiptTimeMs: BASE + 100, decisionTimeMs: BASE + 200 })], [outcome(0)]); assert.throws(() => R.evaluate(...sourceAfterDecision), /predecision/);
  const receiptAfterDecision = wrappers([forecast(0, { receiptTimeMs: BASE + 300, decisionTimeMs: BASE + 200 })], [outcome(0)]); assert.throws(() => R.evaluate(...receiptAfterDecision), /predecision/);
  const overlap = wrappers([forecast(0), forecast(1, { sourceTimeMs: BASE + 200, receiptTimeMs: BASE + 250, decisionTimeMs: BASE + 300 })], [outcome(0), outcome(1)]); assert.throws(() => R.evaluate(...overlap), /overlap/);
  const nonmonotonic = wrappers([forecast(0), forecast(1)], [outcome(0, { resolutionTimeMs: BASE + 2_000_000 }), outcome(1, { resolutionTimeMs: BASE + 1_000_000 })]); assert.throws(() => R.evaluate(...nonmonotonic), /nonmonotonic/);
  const outcomeBefore = wrappers([forecast(0, { sourceTimeMs: BASE + 1_000_000, receiptTimeMs: BASE + 1_000_100, decisionTimeMs: BASE + 1_000_200 })], [outcome(0, { resolutionTimeMs: BASE + 999_999 })]); assert.throws(() => R.evaluate(...outcomeBefore), /decision-outcome/);
});

test("strict provenance, schema, secret, URL, free-text, and embargo validation", () => {
  const validWindows = { trainStartTimeMs: BASE - 20_000, trainEndTimeMs: BASE - 10_000, forwardStartTimeMs: BASE - 5_000, forwardEndTimeMs: BASE + 100_000, embargoMs: 5_000 };
  const valid = wrappers([forecast(0)], [outcome(0)], validWindows); assert.doesNotThrow(() => R.evaluate(...valid));
  const mutations = [
    (forecastWrapper) => { forecastWrapper.provenance.brand = ""; },
    (forecastWrapper) => { forecastWrapper.provenance.selfAttested = true; },
    (forecastWrapper) => { forecastWrapper.provenance.independentlyVerified = true; },
    (forecastWrapper) => { forecastWrapper.extra = "free text"; },
    (forecastWrapper) => { forecastWrapper.records[0].notes = "free text"; },
    (forecastWrapper) => { forecastWrapper.records[0].apiKey = "redacted"; },
    (forecastWrapper) => { forecastWrapper.records[0].forecastId = "https://invalid.test"; },
  ];
  for (const mutate of mutations) { const [forecastWrapper, outcomeWrapper] = wrappers([forecast(0)], [outcome(0)]); mutate(forecastWrapper); assert.throws(() => R.evaluate(forecastWrapper, outcomeWrapper)); }
  const overlapWindows = { ...validWindows, forwardStartTimeMs: BASE - 10_000, embargoMs: 1 }; assert.throws(() => R.evaluate(...wrappers([forecast(0)], [outcome(0)], overlapWindows)), /embargo-overlap/);
  const zeroEmbargo = { ...validWindows, embargoMs: 0 }; assert.throws(() => R.evaluate(...wrappers([forecast(0)], [outcome(0)], zeroEmbargo)), /range/);
  const mismatched = wrappers([forecast(0)], [outcome(0)], validWindows); mismatched[1].windows.embargoMs += 1; assert.throws(() => R.evaluate(...mismatched), /windows-mismatch|embargo/);
});

test("Wilson lower bound and source/day/market concentration are conservative and bounded", () => {
  assert.equal(R.wilsonLower(0, 10), 0);
  assert.ok(R.wilsonLower(5, 10) > 0 && R.wilsonLower(5, 10) < 0.5);
  assert.ok(R.wilsonLower(10, 10) < 1);
  assert.throws(() => R.wilsonLower(11, 10), /input/);
  const [forecasts, outcomes] = wrappers(
    [forecast(0, { marketId: "market-a" }), forecast(1, { marketId: "market-a" }), forecast(2, { marketId: "market-b", sourceTimeMs: BASE + 86_400_000 })],
    [outcome(0, { marketId: "market-a", sourceHash: H("c"), resolutionTimeMs: BASE + 2 * 86_400_000 }), outcome(1, { marketId: "market-b", sourceHash: H("d"), resolutionTimeMs: BASE + 2 * 86_400_000 + 1 })],
  );
  const result = R.evaluate(forecasts, outcomes);
  assert.equal(result.concentration.byMarket.find((row) => row.key === "market-a").share, 0.666666666667);
  assert.equal(result.concentration.largest.share, 0.666666666667);
  assert.ok(["market", "day", "source"].includes(result.concentration.largest.dimension));
});

test("minimum forward evidence threshold is explicit but never changes offline REJECT status", () => {
  const forecastRows = []; const outcomeRows = [];
  const spacing = 30 * 60_000;
  for (let index = 0; index < 200; index += 1) forecastRows.push(forecast(index, { sourceTimeMs: BASE + index * spacing, marketId: `market-${index % 20}`, probability: index % 2 ? "0.4" : "0.6" }));
  const finalDecision = forecastRows.at(-1).decisionTimeMs;
  for (let index = 0; index < 20; index += 1) outcomeRows.push(outcome(index, { marketId: `market-${index}`, resolutionTimeMs: finalDecision + 10_000 + index, outcome: index % 2 }));
  const result = R.evaluate(...wrappers(forecastRows, outcomeRows));
  assert.equal(result.evidenceGate.observedForecasts, 200); assert.equal(result.evidenceGate.observedMarkets, 20); assert.ok(result.evidenceGate.observedDays >= 5);
  assert.equal(result.forwardEvidenceSufficient, true); assert.equal(result.highestStatus, "REJECT"); assert.equal(result.offlineFixture, true);
  const small = R.evaluate(...wrappers([forecast(0)], [outcome(0)])); assert.equal(small.forwardEvidenceSufficient, false); assert.equal(small.highestStatus, "REJECT");
});

test("paired output is hash-linked and contains no financial, fill, execution, or route claims", () => {
  const result = R.evaluate(...wrappers([forecast(0), forecast(1)], [outcome(0), outcome(1)]));
  let previousPairHash = null;
  for (const pair of result.pairs) { const core = { ...pair }; delete core.pairHash; assert.equal(pair.previousPairHash, previousPairHash); assert.equal(pair.pairHash, R.hash(core)); previousPairHash = pair.pairHash; }
  const outputCore = { ...result }; delete outputCore.outputHash; assert.equal(result.outputHash, R.hash(outputCore));
  const text = JSON.stringify(result).toLowerCase();
  for (const forbidden of ["pnl", "p&l", "fill", "execution", "profit", "route", "watch", "shadow_candidate"]) assert.equal(text.includes(forbidden), false);
});

test("CLI help is offline and evaluate uses bounded exclusive output", (t) => {
  const root = temp(t); const forecastPath = path.join(root, "forecasts.json"); const outcomePath = path.join(root, "outcomes.json"); const outputPath = path.join(root, "output.json");
  const [forecasts, outcomes] = wrappers([forecast(0)], [outcome(0)]); fs.writeFileSync(forecastPath, JSON.stringify(forecasts)); fs.writeFileSync(outcomePath, JSON.stringify(outcomes));
  const cli = path.resolve(__dirname, "../polymarket-research-r14/cli.js");
  const help = spawnSync(process.execPath, [cli, "help"], { encoding: "utf8", env: {} }); assert.equal(help.status, 0); assert.match(help.stdout, /Help is offline/); assert.doesNotMatch(help.stdout, /https?:|wss?:/);
  const run = spawnSync(process.execPath, [cli, "evaluate", "--forecasts", forecastPath, "--outcomes", outcomePath, "--out", outputPath], { encoding: "utf8", env: {} }); assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(fs.readFileSync(outputPath, "utf8")).highestStatus, "REJECT");
  const again = spawnSync(process.execPath, [cli, "evaluate", "--forecasts", forecastPath, "--outcomes", outcomePath, "--out", outputPath], { encoding: "utf8", env: {} }); assert.notEqual(again.status, 0); assert.match(again.stderr, /output-exists/);
  const cliModule = require("../polymarket-research-r14/cli"); assert.throws(() => cliModule.args(["evaluate", "--url", "x", "--outcomes", "y", "--out", "z"]), /invalid/);
});
