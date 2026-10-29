#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");

const SCHEMA = "frax-usdc-cross-venue-economics/v1";
const STATUSES = Object.freeze(["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED", "FAILED"]);
const GAS_CEILING = 2_000_000n;
// Per-route quote-inflation haircut (bps). A route whose quoted leg is not
// executable at the same pin (e.g. the Base Curve StableSwap-NG `get_dy` view)
// declares a conservative haircut here; the fire gate subtracts
// ceil(amountInRaw * bps / 10_000) from the quoted gross. The haircut can only
// SUPPRESS a fire, never create one. Routes without the field are unchanged.
const QUOTE_INFLATION_BPS_DENOMINATOR = 10_000n;
// Ethereum FRAX route priority-fee floor (regression-locked). Each route may
// supply a lower, conservative floor via context.gasPolicy.priorityFeeWei.
const PRIORITY_FEE_WEI = 2_000_000_000n;
const MORPHO_PREMIUM_RAW = 0n;
const USDC_SCALE = 1_000_000n;
const ETH_SCALE = 1_000_000_000_000_000_000n;
const CHAINLINK_SCALE = 100_000_000n;

function ceilDiv(numerator, denominator) {
  if (typeof numerator !== "bigint" || typeof denominator !== "bigint" || numerator < 0n || denominator <= 0n) throw new Error("ARITHMETIC_INVALID");
  return (numerator + denominator - 1n) / denominator;
}

function resolvePriorityFeeWei(priorityFeeWei) {
  if (priorityFeeWei === undefined || priorityFeeWei === null) return PRIORITY_FEE_WEI;
  const value = BigInt(priorityFeeWei);
  if (value < 0n) throw new Error("ARITHMETIC_INVALID");
  return value;
}

function sha256(fields) {
  return crypto.createHash("sha256").update(fields.map(String).join("\0")).digest("hex");
}

function routeKey({ chainId, curvePool, uniPool, direction, amountInRaw }) {
  return sha256([chainId, String(curvePool).toLowerCase(), String(uniPool).toLowerCase(), direction, amountInRaw]);
}

function eventId({ routeKey: key, blockHash, expectedOutRaw, grossDeltaRaw }) {
  return sha256([key, String(blockHash).toLowerCase(), expectedOutRaw, grossDeltaRaw]);
}

function effectiveGasPriceWei(baseFeeWei, priorityFeeWei = PRIORITY_FEE_WEI) {
  return ceilDiv(BigInt(baseFeeWei) * 9n, 8n) + resolvePriorityFeeWei(priorityFeeWei);
}

function gasCeilingUsdcRaw(baseFeeWei, ethUsdRaw, priorityFeeWei = PRIORITY_FEE_WEI) {
  const gasWei = GAS_CEILING * effectiveGasPriceWei(baseFeeWei, priorityFeeWei);
  return ceilDiv(gasWei * BigInt(ethUsdRaw) * USDC_SCALE, ETH_SCALE * CHAINLINK_SCALE);
}

// Conservative per-route quote-inflation haircut in raw output units. Rounds up
// so the haircut is never understated. Zero when the route declares no haircut.
function resolveQuoteInflationBps(quoteInflationBps) {
  if (quoteInflationBps === undefined || quoteInflationBps === null) return 0;
  const value = Number(quoteInflationBps);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("ARITHMETIC_INVALID");
  return value;
}

function quoteInflationRaw(amountInRaw, quoteInflationBps) {
  const bps = BigInt(resolveQuoteInflationBps(quoteInflationBps));
  if (bps === 0n) return 0n;
  return ceilDiv(BigInt(amountInRaw) * bps, QUOTE_INFLATION_BPS_DENOMINATOR);
}

function evaluateRow(row, context) {
  try {
    if (!row || row.classification === "INCOMPLETE" || row.amountOutRaw === undefined || row.grossDeltaRaw === null) throw new Error("ROW_INCOMPLETE");
    const amountInRaw = BigInt(row.amountInRaw);
    const expectedOutRaw = BigInt(row.amountOutRaw);
    const quotedGrossDeltaRaw = BigInt(row.grossDeltaRaw);
    const priorityFeeWei = resolvePriorityFeeWei(context.priorityFeeWei);
    const gasRaw = gasCeilingUsdcRaw(context.baseFeeWei, context.ethUsdRaw, priorityFeeWei);
    // Effective gross = quoted gross minus the conservative quote-inflation
    // haircut. Because the haircut is subtracted, it can only suppress a fire.
    const quoteInflationRawValue = quoteInflationRaw(amountInRaw, context.quoteInflationBps);
    const grossDeltaRaw = quotedGrossDeltaRaw - quoteInflationRawValue;
    const key = routeKey({
      chainId: context.chainId,
      curvePool: context.curvePool,
      uniPool: context.uniPool,
      direction: row.direction,
      amountInRaw,
    });
    const id = eventId({ routeKey: key, blockHash: context.blockHash, expectedOutRaw, grossDeltaRaw });
    let status = "NO_GROSS_EDGE";
    if (grossDeltaRaw > 0n) status = grossDeltaRaw > MORPHO_PREMIUM_RAW + gasRaw ? "ATOMIC_FORK_REQUIRED" : "GROSS_EDGE_NET_BLOCKED";
    // The quoted-vs-haircut audit fields are added only when the route declares
    // an active haircut, so routes without one (Ethereum FRAX) keep byte-identical
    // economics rows.
    const haircutAudit = quoteInflationRawValue > 0n
      ? {
        quotedGrossDeltaRaw: quotedGrossDeltaRaw.toString(),
        quoteInflationRaw: quoteInflationRawValue.toString(),
        quoteInflationBps: resolveQuoteInflationBps(context.quoteInflationBps),
      }
      : {};
    return {
      status,
      routeKey: key,
      eventId: id,
      direction: row.direction,
      amountInRaw: amountInRaw.toString(),
      expectedOutRaw: expectedOutRaw.toString(),
      ...haircutAudit,
      grossDeltaRaw: grossDeltaRaw.toString(),
      morphoPremiumRaw: MORPHO_PREMIUM_RAW.toString(),
      gasCeilingUsdcRaw: gasRaw.toString(),
      effectiveGasPriceWei: effectiveGasPriceWei(context.baseFeeWei, priorityFeeWei).toString(),
      routePositive: "unknown",
    };
  } catch (_) {
    return {
      status: "FAILED", routeKey: null, eventId: null,
      direction: typeof row?.direction === "string" ? row.direction : null,
      amountInRaw: typeof row?.amountInRaw === "string" ? row.amountInRaw : null,
      expectedOutRaw: null, grossDeltaRaw: null, morphoPremiumRaw: "0",
      gasCeilingUsdcRaw: null, effectiveGasPriceWei: null, routePositive: "unknown",
    };
  }
}

function evaluateScan(scan) {
  const priorityFeeWei = scan.gasPolicy && scan.gasPolicy.priorityFeeWei !== undefined
    ? scan.gasPolicy.priorityFeeWei : PRIORITY_FEE_WEI;
  // Optional per-route quote-inflation haircut, read from the scan's route
  // binding. Absent for the Ethereum FRAX route, so ETH semantics are unchanged.
  const binding = scan.routeBinding || {};
  // A single-venue mint/redeem (R class) scan has no second venue: it declares
  // `routeBinding.joinExit.pool`. The route key then hashes the same pool in
  // both key slots. This branch is additive and does not alter the cross-venue
  // routes, whose `routeBinding.curve`/`uniswapV3` are unchanged.
  const joinExit = binding.joinExit && binding.joinExit.pool ? binding.joinExit : null;
  const quoteInflationBps = joinExit
    ? joinExit.quoteInflationBps
    : (binding.curve ? binding.curve.quoteInflationBps : undefined);
  const context = {
    chainId: scan.chainId,
    curvePool: joinExit ? joinExit.pool : binding.curve.pool,
    uniPool: joinExit ? joinExit.pool : binding.uniswapV3.pool,
    blockHash: scan.pin.hash,
    baseFeeWei: scan.pin.baseFeePerGasRaw,
    ethUsdRaw: scan.oracle.ethUsdRaw,
    priorityFeeWei,
    quoteInflationBps,
  };
  const rows = scan.rows.map((row) => evaluateRow(row, context));
  return {
    schema: SCHEMA,
    generatedAt: scan.scannedAt,
    pin: { number: scan.pin.number, hash: scan.pin.hash },
    gasPolicy: {
      gasCeiling: GAS_CEILING.toString(),
      baseFeeMultiplierNumerator: "9",
      baseFeeMultiplierDenominator: "8",
      priorityFeeWei: resolvePriorityFeeWei(priorityFeeWei).toString(),
      morphoPremiumRaw: "0",
    },
    rows,
    fired: rows.filter((row) => row.status === "ATOMIC_FORK_REQUIRED"),
  };
}

module.exports = {
  SCHEMA, STATUSES, GAS_CEILING, PRIORITY_FEE_WEI, MORPHO_PREMIUM_RAW,
  QUOTE_INFLATION_BPS_DENOMINATOR,
  ceilDiv, resolvePriorityFeeWei, quoteInflationRaw, routeKey, eventId, effectiveGasPriceWei, gasCeilingUsdcRaw, evaluateRow, evaluateScan,
};
