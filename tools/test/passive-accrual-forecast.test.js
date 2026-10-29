"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { contextForPin, nearHealthy, morphoProjection, morphoSeizeFits, aaveProjection, attachForecast } = require("../lib/passive-accrual-forecast.js");
const { wTaylorCompounded } = require("../watch-top-whale-triggers.js");
const W = 10n ** 18n, V = 1000000n;
const pin = { chainId: 1, hash: "0x" + "11".repeat(32), number: 100, timestamp: 1000000 };
const context = contextForPin(undefined, pin);
const inputs = () => ({ market: [0n, 0n, 1000000n * W, 1000000n * W * V, BigInt(pin.timestamp), 0n],
  position: [0n, (200000n * W - W / 10n) * V, 200000n * W], price: 10n ** 36n, lltv: W, rate: 100000000000n, context });

test("context is exactly parent +1/+12 and supplied qualified object is retained", () => {
  assert.deepEqual(context, { chainId: 1, parentHash: pin.hash, parentNumber: 100, parentTimestamp: 1000000, number: 101, timestamp: 1000012, seconds: 12 });
  assert.equal(contextForPin(context, pin), context);
  for (const [key, value] of Object.entries({ chainId: 8453, parentHash: "0x" + "22".repeat(32), parentNumber: 99,
    parentTimestamp: 999999, number: 102, timestamp: 1000013, seconds: 13 })) assert.equal(contextForPin({ ...context, [key]: value }, pin), null);
  const { seconds, ...missingSeconds } = context;
  for (const value of [null, {}, missingSeconds, { ...context, seconds: "12" }, { ...context, timestamp: "1000012" }]) assert.equal(contextForPin(value, pin), null);
});

test("raw 0.05bps gate never promotes display rounding, null or one wei outside the boundary", () => {
  assert.equal(nearHealthy(200000n, 199999n), true);
  assert.equal(nearHealthy(200001n, 200000n), true);
  assert.equal(nearHealthy(199999n, 199998n), false);
  assert.equal(nearHealthy(W, W - 1n), true);
  assert.equal(nearHealthy(W, W + 1n), false);
  for (const value of [null, undefined, 1, "1", 0n]) assert.equal(nearHealthy(value, value), false);
});

test("Morpho forecast crosses only in prospective evidence, with ceil and virtual share arithmetic", () => {
  const data = inputs(), result = morphoProjection(data);
  assert.equal(result.currentHealth, "HEALTHY");
  assert.equal(result.currentDebtRaw, (200000n * W - W / 10n).toString());
  assert.equal(result.projectedLiquidatable, true);
  assert.equal(result.projectionIsEstimate, true);
  assert.equal(result.requiresExactSimulation, true);
  data.rate = 0n;
  data.position[1] += 1n;
  const zeroRate = morphoProjection(data);
  assert.equal(BigInt(zeroRate.currentDebtRaw), BigInt(result.currentDebtRaw) + 1n);
  assert.equal(zeroRate.projectedDebtRaw, zeroRate.currentDebtRaw);
  assert.equal(zeroRate.projectedLiquidatable, false);
});

test("Taylor is evaluated from original storage, never compounded incrementally", () => {
  const data = inputs();
  data.market[4] -= 100000n;
  data.rate = 1000000000000n;
  const assetsNow = data.market[2] + data.market[2] * wTaylorCompounded(data.rate, 100000n) / W;
  const debtNow = (data.position[1] * (assetsNow + 1n) + data.market[3] + V - 1n) / (data.market[3] + V);
  data.position[2] = debtNow + 1n;
  const result = morphoProjection(data);
  const exactAssets = data.market[2] + data.market[2] * wTaylorCompounded(data.rate, 100012n) / W;
  assert.equal(result.projectedBorrowAssetsRaw, exactAssets.toString());
  assert.notEqual(exactAssets, assetsNow + assetsNow * wTaylorCompounded(data.rate, 12n) / W);
});

test("Morpho missing rate, future lastUpdate, raw-zero debt or unknown source never gets projection", () => {
  for (const change of [d => { d.rate = null; }, d => { d.market = null; }, d => { d.market[4] += 1n; },
    d => { d.position[1] = 0n; }, d => { d.price = 0n; }, d => { d.position[2] = 0n; }, d => { d.context = null; }]) {
    const data = inputs(); change(data); assert.equal(morphoProjection(data), null);
  }
});

test("prospective Morpho plan sizing respects collateral and borrow-share limits", () => {
  const data = { ...inputs(), lif: W, seizedAssets: W };
  const projection = morphoProjection(data);
  assert.equal(morphoSeizeFits(projection, data), true);
  assert.equal(morphoSeizeFits(projection, { ...data, seizedAssets: 0n }), false);
  assert.equal(morphoSeizeFits(projection, { ...data, seizedAssets: data.position[2] + 1n }), false);
  const zeroRate = { ...data, rate: 0n };
  assert.equal(morphoSeizeFits(morphoProjection(zeroRate), { ...zeroRate, seizedAssets: zeroRate.position[2] }), false);
});

test("Aave/Spark require exact raw account HF; future HF remains unknown even for same-asset routes", () => {
  const raw = { healthFactorRaw: W + 1n, debtRaw: 1n, collateralRaw: 1n };
  for (const protocol of ["Aave V3", "SparkLend"]) {
    const projection = aaveProjection({ ...raw, protocol, sameAsset: true });
    assert.equal(projection.projectedHealthFactorRaw, null);
    assert.equal(projection.projectedLiquidatable, null);
    assert.equal(projection.projectionMethod, "EXACT_EVM_SIMULATION_REQUIRED");
    assert.equal(projection.currentHealthFactorRaw, (W + 1n).toString());
  }
  const boundary = 200000n * W / 199999n;
  assert.ok(aaveProjection({ ...raw, healthFactorRaw: boundary }));
  for (const healthFactorRaw of [null, undefined, 1.000001, "1.000001", 0n, W - 1n, boundary + 1n])
    assert.equal(aaveProjection({ ...raw, healthFactorRaw, healthFactor: 1, bpsToLiquidation: 0 }), null);
  assert.equal(aaveProjection({ ...raw, debtRaw: 0n }), null);
});

test("FORECAST_ONLY never mutates current fields and clears stale/closed/unknown forecasts", () => {
  const projection = morphoProjection(inputs()), plans = { readyExecuteExampleCalldata: "0x12345678" };
  const original = { liquidatableNow: false, executableNow: false, healthFactor: 1, readyExecuteExampleCalldata: null };
  const row = { ...original };
  attachForecast(row, context, projection, true, () => plans);
  assert.equal(row.nextBlockForecast.context, context);
  assert.equal(row.nextBlockForecast.evidence, "FORECAST_ONLY");
  assert.equal(row.nextBlockForecast.eligibleForSimulation, true);
  const { nextBlockForecast, ...current } = row;
  assert.deepEqual(current, original);
  for (const blocked of [{ inactive: true }, { positionStatus: "CLOSED" }, { positionStatus: "UNKNOWN" },
    { observationStatus: "INCOMPLETE" }, { observationOnly: true }]) {
    const stale = { ...row, ...blocked };
    attachForecast(stale, context, projection, true, () => { throw Error("MUST_NOT_BUILD"); });
    assert.equal(stale.nextBlockForecast, undefined);
  }
  attachForecast(row, context, projection, false, () => plans);
  assert.equal(row.nextBlockForecast, undefined);
});
