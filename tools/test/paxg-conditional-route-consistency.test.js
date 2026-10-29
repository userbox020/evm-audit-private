"use strict";

// Offline consistency checks only. Synthetic quotes and caller attestations are not route proof.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildActions, MARKET, BOT, MORPHO, IF } = require("../lib/paxg-exact-actions.js");
const { evaluatePaxgNet } = require("../lib/paxg-conservative-net.js");
const { assessPaxg } = require("../lib/canary-strike-eligibility.js");
const { projectCanaryArmReadiness } = require("../lib/canary-arm-readiness.js");

const marketParams = [
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "0x45804880de22913dafe09f4980848ece6ecbaf78",
  "0xdd1778f71a4a1c6a0efebd8ae9f8848634ce1101",
  "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
  915000000000000000n,
];
const actions = buildActions(marketParams); // construction is unsigned and offline
const supply = IF.decodeFunctionData("supplyCollateral", actions[0].data);
const borrow = IF.decodeFunctionData("borrow", actions[1].data);

test("exact unsigned calls fix 0.000001 PAXG, 100 USDC and both gas budgets", () => {
  assert.equal(MARKET, "0x8eaf7b29f02ba8d8c1d7aeb587403dcb16e2e943e4e2f5f94b0963c2386406c9");
  assert.equal(actions.length, 2);
  assert.deepEqual(actions.map((a) => a.gasLimit), ["180000", "300000"]);
  for (const action of actions) {
    assert.equal(action.from, BOT);
    assert.equal(action.to, MORPHO);
    assert.equal(action.valueWei, "0");
    assert.equal(action.slippageBps, "0");
  }
  assert.deepEqual(supply[0].map((value) => String(value).toLowerCase()), marketParams.map((value) => String(value).toLowerCase()));
  assert.deepEqual(borrow[0].map((value) => String(value).toLowerCase()), marketParams.map((value) => String(value).toLowerCase()));
  assert.equal(supply[1], 1_000_000_000_000n);
  assert.equal(supply[2].toLowerCase(), BOT);
  assert.equal(supply[3], "0x");
  assert.equal(borrow[1], 100_000_000n);
  assert.equal(borrow[2], 0n);
  assert.equal(borrow[3].toLowerCase(), BOT);
  assert.equal(borrow[4].toLowerCase(), BOT);
});

// Invented price inputs exercise arithmetic; they do not establish funding, exit, or executable liquidity.
const syntheticQuote = (overrides = {}) => ({
  borrowUsdcRaw: borrow[1].toString(), availableUsdcRaw: "101000000",
  collateralPaxgWei: supply[1].toString(),
  supplyGasLimit: actions[0].gasLimit, borrowGasLimit: actions[1].gasLimit,
  usdcUsdE8: "100000000", paxgUsdE8: "450000000000", ethUsdE8: "300000000000",
  maxFeePerGasWei: "1000000000", exitSlippageBps: "50",
  financingUsdRaw: "0", competitionUsdRaw: "5000000", uncertaintyUsdRaw: "1000000",
  ...overrides,
});

test("exact-action synthetic economics reject missing liquidity and adverse fee/discount/competition", () => {
  const cases = [
    { name: "zero available", changes: { availableUsdcRaw: "0" }, positive: false, blocker: "INVALID_ROUTE_OR_UNPRICED_LIQUIDITY" },
    { name: "only 100 USDC available", changes: { availableUsdcRaw: "100000000" }, positive: false, blocker: "INVALID_ROUTE_OR_UNPRICED_LIQUIDITY" },
    { name: "101 USDC with low max fee", changes: {}, positive: true },
    { name: "101 USDC with high but capped max fee", changes: { maxFeePerGasWei: "100000000000" }, positive: false },
    { name: "per-tx gas cap exceeded", changes: { maxFeePerGasWei: "200000000000" }, positive: false, blocker: "GAS_CAP_EXCEEDED" },
    { name: "synthetic USDC discount", changes: { usdcUsdE8: "90000000", competitionUsdRaw: "89000000" }, positive: false },
    { name: "competition haircut", changes: { competitionUsdRaw: "99000000" }, positive: false },
  ];
  for (const { name, changes, positive, blocker } of cases) {
    const result = evaluatePaxgNet(syntheticQuote(changes));
    assert.equal(result.economicPositive, positive, name);
    assert.equal(result.executable, false, name);
    if (blocker) assert.equal(result.blocker, blocker, name);
    else assert.equal(result.blocker, undefined, name);
    if (positive) assert.ok(BigInt(result.netUsdRaw) > 0n, name);
  }
});

const NOW = Date.parse("2026-09-26T12:00:00Z");
const identity = { chainId: 1, marketId: MARKET, actionId: "synthetic-paxg-check" };
const batchCommitment = "0x" + "11".repeat(32);
const scopeCommitment = "0x" + "22".repeat(32);
const pin = { chainId: 1, block: 26050000, hash: "0x" + "33".repeat(32),
  timeMs: NOW - 1000, witnessed: true };

test("a fresh synthetic FIRED reading with ABSENT authority never authorizes live action", () => {
  const signal = { schema: "exploit-rearm-canary/v1", chainId: 1, noSigning: true,
    noBroadcast: true, generatedAt: new Date(NOW).toISOString(), pin: { block: pin.block },
    sentinels: [{ sentinel: "morpho-paxg-misscale", chainId: 1, ok: true, fired: true,
      measurements: { availableLiquidityUsdcWei: "101000000" } }] };
  const result = assessPaxg(signal, { state: "ABSENT" }, NOW);
  assert.equal(result.monitoringOnly, true);
  assert.ok(result.blockers.includes("SIGNED_V3_AUTHORITY_REQUIRED"));
  assert.ok(result.blockers.includes("ROUTE_REAL_FORK_AND_CONSERVATIVE_NET_REQUIRED"));
  assert.ok(result.blockers.length > 0);
});

test("ABSENT authority or synthetic-only route attestations cannot arm, trigger, or dispatch", () => {
  const base = {
    nowMs: NOW,
    plan: { identity, immutable: true, independent: true, sameMarket: true,
      forkRehearsed: false, realFundingProved: false, conditionalNetPositive: true,
      nonSynthetic: false }, // positive synthetic arithmetic is not route proof
    authority: { state: "VALID", signatureVerified: true, mode: "PRODUCTION", identity,
      batchCommitment, scopeCommitment, actionMatch: true, capsOk: true,
      notBeforeMs: NOW - 1000, expiresAtMs: NOW + 1000 }, // hypothetical shape, not a real approval
    producer: { active: true, sole: true, leaseValid: true, continuityAttested: true,
      leaseExpiresAtMs: NOW + 1000 },
  };
  for (const status of ["DORMANT", "FIRED"]) {
    const signal = { status, condition: status === "FIRED", identity,
      batchCommitment, scopeCommitment, pin };
    for (const scenario of [
      { name: "absent authority", plan: { ...base.plan, forkRehearsed: true, realFundingProved: true, nonSynthetic: true }, authority: { state: "ABSENT" }, reason: "BATCH_INVALID_OR_SCOPE_MISMATCH" },
      { name: "synthetic-only route", plan: base.plan, authority: base.authority, reason: "ROUTE_UNPROVEN" },
    ]) {
      const result = projectCanaryArmReadiness({ ...base, ...scenario, signal });
      assert.equal(result.state, "NOT_READY", `${scenario.name}: ${status}`);
      assert.equal(result.reason, scenario.reason, `${scenario.name}: ${status}`);
      assert.equal(result.monitoringOnly, true);
      assert.equal(result.noSigning, true);
      assert.equal(result.noBroadcast, true);
      assert.equal(result.dispatchAllowed, false);
    }
  }
});
