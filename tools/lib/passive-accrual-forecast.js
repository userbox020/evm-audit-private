"use strict";

// Advisory only: no RPC, current eligibility changes, or execution authority.
const W = 10n ** 18n, V = 1000000n, PRICE_SCALE = 10n ** 36n;
const ceil = (x, y) => (x + y - 1n) / y;
const uint = value => typeof value === "bigint" && value >= 0n;

function contextForPin(supplied, pin) {
  if (pin?.chainId !== 1 || !/^0x[\da-f]{64}$/i.test(pin.hash || "")
      || !Number.isSafeInteger(pin.number) || pin.number < 0
      || !Number.isSafeInteger(pin.timestamp) || pin.timestamp < 0
      || !Number.isSafeInteger(pin.number + 1) || !Number.isSafeInteger(pin.timestamp + 12)) return null;
  const expected = { chainId: 1, parentHash: pin.hash, parentNumber: pin.number,
    parentTimestamp: pin.timestamp, number: pin.number + 1, timestamp: pin.timestamp + 12, seconds: 12 };
  if (supplied === undefined) return expected;
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)
      || Object.entries(expected).some(([key, value]) => supplied[key] !== value)) return null;
  return supplied; // Preserve the qualified caller's object, not a reconstructed context.
}

function nearHealthy(numerator, denominator) {
  // (1 - 1/HF) * 10,000 <= 0.05 bps, without division/rounding.
  return uint(numerator) && uint(denominator) && denominator > 0n
    && numerator >= denominator && (numerator - denominator) * 200000n <= numerator;
}

function morphoProjection({ market, position, price, lltv, rate, context }) {
  if (!context || !market || !position
      || ![market[2], market[3], market[4], position[1], position[2], price, lltv, rate].every(uint)
      || market[2] === 0n || market[3] === 0n || position[1] === 0n || position[1] > market[3]
      || position[2] === 0n || price === 0n || lltv === 0n || lltv > W
      || market[4] > BigInt(context.parentTimestamp)) return null;
  const maxBorrow = (position[2] * price / PRICE_SCALE) * lltv / W;
  const evaluateAt = timestamp => {
    // Re-evaluate the protocol Taylor polynomial from ORIGINAL market storage.
    // Compounding a second 12s polynomial on the already accrued value is not equivalent.
    const first = rate * (BigInt(timestamp) - market[4]);
    const second = first * first / (2n * W);
    const third = second * first / (3n * W);
    const assets = market[2] + market[2] * (first + second + third) / W;
    return { assets, debt: ceil(position[1] * (assets + 1n), market[3] + V) };
  };
  const current = evaluateAt(context.parentTimestamp), next = evaluateAt(context.timestamp);
  if (!nearHealthy(maxBorrow, current.debt)) return null;
  return { protocol: "Morpho Blue", currentHealth: "HEALTHY", currentDebtRaw: current.debt.toString(),
    maxBorrowRaw: maxBorrow.toString(), projectedDebtRaw: next.debt.toString(),
    projectedHealthFactorRaw: (maxBorrow * W / next.debt).toString(), projectedLiquidatable: next.debt > maxBorrow,
    projectionIsEstimate: true, projectionMethod: "ORIGINAL_MARKET_PINNED_RATE_TAYLOR",
    // IRM borrowRateView at the parent need not equal its rate at the child timestamp.
    requiresExactSimulation: true, projectedBorrowAssetsRaw: next.assets.toString() };
}

function morphoSeizeFits(projection, { market, position, price, seizedAssets, lif }) {
  if (!projection || ![seizedAssets, lif].every(uint) || seizedAssets === 0n || lif < W
      || seizedAssets > position[2]) return false;
  const repayment = ceil(ceil(seizedAssets * price, PRICE_SCALE) * W, lif);
  const shares = ceil(repayment * (market[3] + V), BigInt(projection.projectedBorrowAssetsRaw) + 1n);
  return shares > 0n && shares <= position[1];
}

function aaveProjection({ healthFactorRaw, debtRaw, collateralRaw, protocol = "Aave V3" }) {
  if (!uint(debtRaw) || debtRaw === 0n || !uint(collateralRaw) || collateralRaw === 0n
      || !nearHealthy(healthFactorRaw, W)) return null;
  // A route's same-asset pair says nothing about the entire account's future HF.
  return { protocol, currentHealth: "HEALTHY", currentHealthFactorRaw: healthFactorRaw.toString(),
    projectedHealthFactorRaw: null, projectedLiquidatable: null,
    projectionMethod: "EXACT_EVM_SIMULATION_REQUIRED", requiresExactSimulation: true };
}

function attachForecast(row, context, projection, nonHealthReady, buildPlans) {
  delete row.nextBlockForecast;
  if (!context || !projection || nonHealthReady !== true || row.inactive === true
      || ["CLOSED", "UNKNOWN"].includes(row.positionStatus) || row.observationOnly === true
      || ["INCOMPLETE", "UNAVAILABLE"].includes(row.observationStatus)) return row;
  const plans = buildPlans();
  if (!plans || !Object.keys(plans).length || Object.entries(plans).some(([key, value]) =>
    !/^readyExecute.*Calldata$/.test(key) || typeof value !== "string" || !/^0x(?:[\da-f]{2}){4,}$/i.test(value))) return row;
  row.nextBlockForecast = { context, eligibleForSimulation: true, evidence: "FORECAST_ONLY", plans, ...projection };
  return row;
}

module.exports = { contextForPin, nearHealthy, morphoProjection, morphoSeizeFits, aaveProjection, attachForecast };
