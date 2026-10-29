"use strict";

// Offline fee-only prioritization. The parent must authenticate all evidence and bindings.
const { types } = require("node:util");

const PROVENANCE = "FEELESS_INFINITESIMAL_PRICE_DIFFERENCE_NOT_FINITE_INPUT_GROSS_OR_NET";
const PROOF_SCOPE = "ArbitrumReviewedUniV3PoolRuntime";
const profiles = Object.freeze({
  "ethereum-usdc-weth-univ3-500-sushi-v2": { chainId: 1, feePpm: 500,
    runtimeHash: "a981b66c747a3d9fa29d7e200d5faaa2826960523d0e5a0df8148e8868c480b4", supported: false },
  "arbitrum-native-usdc-weth-univ3-100-camelot": { chainId: 42161, feePpm: 100,
    runtimeHash: "2a97cecfded007e8ef2bb083121cd8331ae4984c84abef1516776f57a887fd9b", supported: true },
  "arbitrum-native-usdc-weth-univ3-500-camelot": { chainId: 42161, feePpm: 500,
    runtimeHash: "b9d899dac136c1f5179e1987328abb4c9f1ac0abf027ca0ad81750300996af6c", supported: true },
  "arbitrum-native-usdc-weth-univ3-3000-camelot": { chainId: 42161, feePpm: 3000,
    runtimeHash: "cbe8d056c494677dacc0a73b03e961fb696b53ac915e9b278fa2c47da921f418", supported: true },
});
const inputKeys = ["chainId", "candidateId", "pinHash", "optimisticMarginalSpreadBps", "alreadyFeeIncluded", "spreadProvenance", "feeBinding"];
const bindingKeys = ["pinHash", "runtimeHash", "feePpm", "selectedFeeApplicationProof"];
const pinPattern = /^0x[0-9a-fA-F]{64}$/;

function data(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some(key => typeof key !== "string"
    || !keys.includes(key) || !Object.hasOwn(descriptors[key], "value"))) return null;
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

function classifyMarginalFeeFloor(input) {
  const output = { classification: "UNKNOWN", reason: "INVALID_INPUT", chainId: null,
    candidateId: null, pinHash: null, optimisticMarginalSpreadBps: null, feePpm: null,
    feeOnlyBreakEvenRatio: null,
    scope: "HISTORICAL_OR_PINNED_FEELESS_INFINITESIMAL_PRIORITY_FILTER_ONLY",
    routePositive: "unknown", routeNegative: "unknown", executableNow: "unknown",
    qualified: false, automaticPromotion: false, signingAuthorized: false,
    otherVenueFeeFinancingGasAndUncertainty: "UNKNOWN_NOT_ASSUMED_ZERO",
    finiteSizeFillSettlementRepaymentAndNet: "UNVALIDATED",
    bindingAuthenticity: "PARENT_PREVALIDATED_NOT_AUTHENTICATED_BY_THIS_PURE_FUNCTION" };
  try {
    const fields = data(input, inputKeys);
    if (!fields) return output;
    const profile = typeof fields.candidateId === "string" && Object.hasOwn(profiles, fields.candidateId)
      ? profiles[fields.candidateId] : null;
    if (!profile || fields.chainId !== profile.chainId || typeof fields.pinHash !== "string"
      || !pinPattern.test(fields.pinHash)
      || typeof fields.optimisticMarginalSpreadBps !== "string"
      || !/^(?:0|[1-9][0-9]*)$/.test(fields.optimisticMarginalSpreadBps)
      || fields.optimisticMarginalSpreadBps.length > 78
      || fields.spreadProvenance !== PROVENANCE || typeof fields.alreadyFeeIncluded !== "boolean") return output;
    const binding = data(fields.feeBinding, bindingKeys);
    if (!binding) return output;

    output.chainId = profile.chainId;
    output.candidateId = fields.candidateId;
    output.pinHash = fields.pinHash;
    output.optimisticMarginalSpreadBps = fields.optimisticMarginalSpreadBps;

    if (fields.alreadyFeeIncluded) {
      output.reason = "ALREADY_FEE_INCLUDED_NOT_APPLICABLE";
      return output;
    }
    // Ethereum lacks a reviewed selected-fee-application proof in this fixed profile.
    if (!profile.supported) {
      output.reason = "ETHEREUM_FEE_APPLICATION_PROOF_MISSING";
      return output;
    }
    if (typeof binding.pinHash !== "string" || !pinPattern.test(binding.pinHash)
      || binding.pinHash.toLowerCase() !== fields.pinHash.toLowerCase()
      || typeof binding.runtimeHash !== "string" || !pinPattern.test(binding.runtimeHash)
      || binding.runtimeHash.slice(2).toLowerCase() !== profile.runtimeHash
      || binding.feePpm !== profile.feePpm
      || binding.selectedFeeApplicationProof !== PROOF_SCOPE) {
      output.reason = "MISSING_OR_MISMATCHED_FEE_BINDING";
      return output;
    }
    const denominator = 1000000n - BigInt(profile.feePpm);
    const spread = BigInt(fields.optimisticMarginalSpreadBps);
    output.feePpm = profile.feePpm;
    output.feeOnlyBreakEvenRatio = { numerator: "1000000", denominator: denominator.toString() };
    // r is strictly below (10000+s+1)/10000; equality at its upper endpoint is excluded.
    if ((10000n + spread + 1n) * denominator <= 10000n * 1000000n) {
      output.classification = "BELOW_KNOWN_VENUE_FEE_PREFILTER";
      output.reason = "STRICT_SPREAD_UPPER_BOUND_BELOW_SELECTED_VENUE_FEE";
    } else {
      output.classification = "COSTS_INCOMPLETE_WATCH";
      output.reason = "FEE_ONLY_FLOOR_NOT_ESTABLISHED_OTHER_COSTS_UNKNOWN";
    }
  } catch (_) {
    // An adversarial input never escapes as an exception, message, or raw field.
    return { ...output, classification: "UNKNOWN", reason: "INVALID_INPUT", chainId: null,
      candidateId: null, pinHash: null, optimisticMarginalSpreadBps: null, feePpm: null,
      feeOnlyBreakEvenRatio: null };
  }
  return output;
}

module.exports = { classifyMarginalFeeFloor };
