"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyMarginalFeeFloor } = require("../lib/marginal-fee-watch-filter");

const PROVENANCE = "FEELESS_INFINITESIMAL_PRICE_DIFFERENCE_NOT_FINITE_INPUT_GROSS_OR_NET";
const PROOF = "ArbitrumReviewedUniV3PoolRuntime";
const pin = "0x" + "ab".repeat(32);
const profiles = [
  { candidateId: "ethereum-usdc-weth-univ3-500-sushi-v2", chainId: 1, feePpm: 500,
    runtimeHash: "0xa981b66c747a3d9fa29d7e200d5faaa2826960523d0e5a0df8148e8868c480b4" },
  { candidateId: "arbitrum-native-usdc-weth-univ3-100-camelot", chainId: 42161, feePpm: 100,
    runtimeHash: "0x2a97cecfded007e8ef2bb083121cd8331ae4984c84abef1516776f57a887fd9b" },
  { candidateId: "arbitrum-native-usdc-weth-univ3-500-camelot", chainId: 42161, feePpm: 500,
    runtimeHash: "0xb9d899dac136c1f5179e1987328abb4c9f1ac0abf027ca0ad81750300996af6c" },
  { candidateId: "arbitrum-native-usdc-weth-univ3-3000-camelot", chainId: 42161, feePpm: 3000,
    runtimeHash: "0xcbe8d056c494677dacc0a73b03e961fb696b53ac915e9b278fa2c47da921f418" },
];
function input(index = 1, spread = "0") {
  const profile = profiles[index];
  return { chainId: profile.chainId, candidateId: profile.candidateId,
    pinHash: pin, optimisticMarginalSpreadBps: spread, alreadyFeeIncluded: false,
    spreadProvenance: PROVENANCE, feeBinding: { pinHash: pin,
      runtimeHash: profile.runtimeHash, feePpm: profile.feePpm, selectedFeeApplicationProof: PROOF } };
}
function safety(output) {
  assert.equal(output.scope, "HISTORICAL_OR_PINNED_FEELESS_INFINITESIMAL_PRIORITY_FILTER_ONLY");
  assert.equal(output.routePositive, "unknown");
  assert.equal(output.routeNegative, "unknown");
  assert.equal(output.executableNow, "unknown");
  assert.equal(output.qualified, false);
  assert.equal(output.automaticPromotion, false);
  assert.equal(output.signingAuthorized, false);
  assert.equal(output.otherVenueFeeFinancingGasAndUncertainty, "UNKNOWN_NOT_ASSUMED_ZERO");
  assert.equal(output.finiteSizeFillSettlementRepaymentAndNet, "UNVALIDATED");
  assert.equal(output.bindingAuthenticity, "PARENT_PREVALIDATED_NOT_AUTHENTICATED_BY_THIS_PURE_FUNCTION");
}

test("24 saved spread floors: 14 below fee-only upper bound, four watch, six Ethereum unknown", () => {
  const groups = [
    [0, [12, 9, 3, 0, 3, 7], "UNKNOWN"],
    [1, [0, 0, 2, 1, 1, 3], null],
    [2, [3, 3, 2, 1, 1, 2], "BELOW_KNOWN_VENUE_FEE_PREFILTER"],
    [3, [10, 6, 7, 15, 19, 20], "BELOW_KNOWN_VENUE_FEE_PREFILTER"],
  ];
  const totals = { UNKNOWN: 0, BELOW_KNOWN_VENUE_FEE_PREFILTER: 0, COSTS_INCOMPLETE_WATCH: 0 };
  for (const [index, spreads, expected] of groups) {
    for (const spread of spreads) {
      const output = classifyMarginalFeeFloor(input(index, String(spread)));
      safety(output);
      assert.equal(output.optimisticMarginalSpreadBps, String(spread));
      assert.equal(output.candidateId, profiles[index].candidateId);
      assert.equal(output.classification, expected || (spread === 0
        ? "BELOW_KNOWN_VENUE_FEE_PREFILTER" : "COSTS_INCOMPLETE_WATCH"));
      totals[output.classification]++;
    }
  }
  assert.deepEqual(totals, { UNKNOWN: 6, BELOW_KNOWN_VENUE_FEE_PREFILTER: 14, COSTS_INCOMPLETE_WATCH: 4 });
});

test("strict integer upper endpoints: fee100 at 0/1, fee500 at 4/5, fee3000 at 29/30", () => {
  for (const [index, below, above, denominator] of [
    [1, "0", "1", "999900"], [2, "4", "5", "999500"], [3, "29", "30", "997000"],
  ]) {
    const low = classifyMarginalFeeFloor(input(index, below));
    const high = classifyMarginalFeeFloor(input(index, above));
    assert.equal(low.classification, "BELOW_KNOWN_VENUE_FEE_PREFILTER");
    assert.equal(low.reason, "STRICT_SPREAD_UPPER_BOUND_BELOW_SELECTED_VENUE_FEE");
    assert.deepEqual(low.feeOnlyBreakEvenRatio, { numerator: "1000000", denominator });
    assert.equal(high.classification, "COSTS_INCOMPLETE_WATCH");
    assert.equal(high.reason, "FEE_ONLY_FLOOR_NOT_ESTABLISHED_OTHER_COSTS_UNKNOWN");
    assert.deepEqual(high.feeOnlyBreakEvenRatio, low.feeOnlyBreakEvenRatio);
    safety(low); safety(high);
  }
});

test("large canonical spreads use exact BigInt, never floating price or implicit unit conversion", () => {
  const spread = "9".repeat(78);
  const output = classifyMarginalFeeFloor(input(3, spread));
  assert.equal(output.optimisticMarginalSpreadBps, spread);
  assert.equal(output.classification, "COSTS_INCOMPLETE_WATCH");
  safety(output);
});

test("mismatched pin, runtime, selected proof, fee, chain and foreign profile never prove a floor", () => {
  const variations = [
    value => { value.feeBinding.pinHash = "0x" + "cd".repeat(32); },
    value => { value.feeBinding.runtimeHash = profiles[2].runtimeHash; },
    value => { value.feeBinding.selectedFeeApplicationProof = "UNKNOWN"; },
    value => { value.feeBinding.feePpm = 500; },
    value => { value.chainId = 1; },
    value => { value.candidateId = profiles[0].candidateId; },
    value => { value.feeBinding = null; },
  ];
  for (const mutate of variations) {
    const value = input(1); mutate(value);
    const output = classifyMarginalFeeFloor(value);
    assert.equal(output.classification, "UNKNOWN");
    assert.equal(output.feeOnlyBreakEvenRatio, null);
    assert.equal(output.feePpm, null);
    safety(output);
  }
  const ethereum = classifyMarginalFeeFloor(input(0, "0"));
  assert.equal(ethereum.classification, "UNKNOWN");
  assert.equal(ethereum.reason, "ETHEREUM_FEE_APPLICATION_PROOF_MISSING");
  assert.equal(ethereum.feeOnlyBreakEvenRatio, null);
});

test("already fee included does not deduct fee again or imply route-negative", () => {
  for (const index of [0, 1, 2, 3]) {
    const value = input(index, "0"); value.alreadyFeeIncluded = true;
    const output = classifyMarginalFeeFloor(value);
    assert.equal(output.classification, "UNKNOWN");
    assert.equal(output.reason, "ALREADY_FEE_INCLUDED_NOT_APPLICABLE");
    assert.equal(output.feeOnlyBreakEvenRatio, null);
    safety(output);
  }
});

test("invalid strings, unknown or missing keys, accessors and proxies fail closed with no side effects", () => {
  const sentinel = "https://SENTINEL_SECRET.invalid";
  let getters = 0, traps = 0;
  const get = () => { getters++; throw Error(sentinel); };
  const proxy = target => new Proxy(target, { get() { traps++; throw Error(sentinel); } });
  const unknown = input(); unknown.rawErrorMessage = sentinel;
  const missing = input(); delete missing.spreadProvenance;
  const extraBinding = input(); extraBinding.feeBinding.rawErrorMessage = sentinel;
  const accessor = input(); Object.defineProperty(accessor, "alreadyFeeIncluded", { get });
  const accessorBinding = input(); Object.defineProperty(accessorBinding.feeBinding, "feePpm", { get });
  const cases = [
    unknown, missing, extraBinding, accessor, accessorBinding, proxy(input()),
    { ...input(), feeBinding: proxy(input().feeBinding) },
    ...["01", "-1", "1e2", "1.0", "9".repeat(79), sentinel].map(spread => input(1, spread)),
    { ...input(), pinHash: sentinel }, { ...input(), spreadProvenance: sentinel },
  ];
  for (const value of cases) {
    const output = classifyMarginalFeeFloor(value);
    assert.equal(output.classification, "UNKNOWN");
    assert.equal(output.reason, "INVALID_INPUT");
    assert.equal(output.candidateId, null);
    assert.equal(output.optimisticMarginalSpreadBps, null);
    assert.ok(!JSON.stringify(output).includes("SENTINEL"));
    safety(output);
  }
  assert.equal(getters, 0);
  assert.equal(traps, 0);
});
