"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PAXG_MARKET, BWUSDC_MARKET, classifyStrike, assessPaxg, MAX_SIGNAL_AGE_MS } = require("../lib/canary-strike-eligibility.js");
const { evaluatePaxgNet } = require("../lib/paxg-conservative-net.js");

const spec = (marketId, routePositive = true, routeStatus = "fork-verified", chainId = 1) =>
  ({ marketId, routePositive, routeStatus, chainId });
const signal = (now, fired = true, liquidity = "102000000") => ({
  schema: "exploit-rearm-canary/v1", chainId: 1, noSigning: true, noBroadcast: true,
  generatedAt: new Date(now).toISOString(), pin: { block: 26050000 },
  sentinels: [{ sentinel: "morpho-paxg-misscale", ok: true, fired, chainId: 1,
    measurements: { availableLiquidityUsdcWei: liquidity } }],
});
const authorized = {
  state: "VALID", batchCommitment: "0x" + "11".repeat(32),
  approval: { scopeCommitment: "0x" + "22".repeat(32) },
  batch: { schema: "live-execution-batch/v3", mode: "PRODUCTION", chainId: "1" },
};

test("never promotes unproven funding, unpriced exits, malformed markets, or the blocked bwUSDC wrapper", () => {
  assert.equal(classifyStrike(spec(BWUSDC_MARKET)), "BLOCKED_REAL_DEPOSIT");
  assert.equal(classifyStrike(spec(PAXG_MARKET, false)), "MONITOR_ONLY_UNPROVEN_OR_UNPRICED");
  assert.equal(classifyStrike(spec(PAXG_MARKET, true, "over-scale-confirmed-funding-leg-unavailable")), "MONITOR_ONLY_UNPROVEN_OR_UNPRICED");
  assert.equal(classifyStrike(spec("0x1234")), "INVALID_SPEC");
  assert.equal(classifyStrike(spec(PAXG_MARKET)), "PAXG_REQUIRES_LIVE_ROUTE_PREFLIGHT");
  assert.equal(classifyStrike(spec("0x" + "33".repeat(32))), "REQUIRES_REAL_FUNDING_AND_EXIT_PROOF");
});

test("a monitoring-only batch, zero liquidity and a stale signal cannot authorize a strike", () => {
  const now = Date.parse("2026-09-24T23:00:00Z");
  const result = assessPaxg(signal(now, false, "0"), { state: "ABSENT" }, now);
  assert.deepEqual(result.blockers, ["PAXG_NO_BORROWABLE_WINDOW", "SIGNED_V3_AUTHORITY_REQUIRED", "ROUTE_REAL_FORK_AND_CONSERVATIVE_NET_REQUIRED"]);
  assert.equal(result.monitoringOnly, true);
  const stale = assessPaxg(signal(now - MAX_SIGNAL_AGE_MS - 1), authorized, now);
  assert.ok(stale.blockers.includes("SIGNAL_INVALID_OR_STALE"));
});

test("even a fresh fire with valid signed authority still needs route-real and net proof", () => {
  const now = Date.parse("2026-09-24T23:00:00Z");
  const result = assessPaxg(signal(now), authorized, now);
  assert.deepEqual(result.blockers, ["ROUTE_REAL_FORK_AND_CONSERVATIVE_NET_REQUIRED"]);
  assert.equal(result.monitoringOnly, true);
});

const quote = () => ({
  borrowUsdcRaw: "100000000", availableUsdcRaw: "110000000", collateralPaxgWei: "1000000000000",
  usdcUsdE8: "100000000", paxgUsdE8: "450000000000", ethUsdE8: "300000000000",
  supplyGasLimit: "160000", borrowGasLimit: "200000", maxFeePerGasWei: "100000000",
  exitSlippageBps: "50", financingUsdRaw: "0", competitionUsdRaw: "5000000", uncertaintyUsdRaw: "1000000",
});

test("exact-cost calculation stays observational even when conservative net is positive", () => {
  const row = evaluatePaxgNet(quote());
  assert.equal(row.economicPositive, true);
  assert.equal(row.executable, false);
  assert.ok(BigInt(row.netUsdRaw) > 0n);
  assert.equal(BigInt(row.grossUsdRaw), 100_000_000n);
  assert.ok(BigInt(row.netNativeEthWei) > 0n);
  assert.ok(BigInt(row.netBpsOfCapital) > 0n);
});

test("missing prices, insufficient liquidity, high gas or negative net fail closed", () => {
  assert.equal(evaluatePaxgNet({ ...quote(), paxgUsdE8: undefined }).economicPositive, false);
  assert.equal(evaluatePaxgNet({ ...quote(), availableUsdcRaw: "100000000" }).economicPositive, false);
  assert.equal(evaluatePaxgNet({ ...quote(), maxFeePerGasWei: "500000000000" }).blocker, "GAS_CAP_EXCEEDED");
  assert.equal(evaluatePaxgNet({ ...quote(), competitionUsdRaw: "99000000" }).economicPositive, false);
});
