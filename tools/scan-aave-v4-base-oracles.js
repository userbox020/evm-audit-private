#!/usr/bin/env node
"use strict";

const { Interface } = require("ethers");
const contract = require("./lib/aave-v4-base-observation-contract");
const ABI = new Interface([
  "function ORACLE() view returns (address)", "function spoke() view returns (address)", "function decimals() view returns (uint8)",
  "function getReserveSource(uint256) view returns (address)", "function getReservePrice(uint256) view returns (uint256)",
]);
const TIMESTAMP = new Interface(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]);
async function collectBaseOracles(topology, deps = {}) {
  const out = contract.result("oracle", deps.now);
  out.componentScope = "PINNED_WIRING_OBSERVATIONS_SOURCE_AND_FRESHNESS_ARE_SEPARATE_AXES";
  out.oracle = contract.ORACLE; out.spoke = contract.SPOKE; out.reserves = [];
  out.wiringObserved = false; out.sourceSemanticsQualified = false; out.freshness = "UNKNOWN";
  out.semanticEvidenceOrigin = "PARENT_CODE_BOUND_SOURCE_REVIEW_NOT_RECOMPILED";
  let state;
  try {
    const prepared = await contract.openObservation(topology, deps);
    state = { ...prepared, counts: { attempted: 0, succeeded: 0, failed: 0 } };
    const scope = contract.frozenScope(deps.frozenScope);
    if (![contract.SPOKE, contract.ORACLE, ...contract.FEEDS].every(address => scope.has(address))) contract.fail("SCOPE_INVALID");
    const runtimeCache = new Map();
    async function binding(address) {
      if (!runtimeCache.has(address)) runtimeCache.set(address, await contract.runtimeBinding(state, address, deps.runtimeExpectations, scope));
      return runtimeCache.get(address);
    }
    const descriptorFor = address => {
      const matches = (deps.semanticDescriptors || []).filter(row => contract.at(row?.address) === address);
      if (matches.length > 1) contract.fail("SOURCE_BINDING_INVALID");
      return matches[0];
    };
    const oracleBinding = await binding(contract.ORACLE);
    const oraclePolicy = contract.sourcePolicy(descriptorFor(contract.ORACLE), oracleBinding);
    const oracle = await contract.read(state, contract.SPOKE, ABI, "ORACLE");
    const spoke = await contract.read(state, contract.ORACLE, ABI, "spoke");
    const decimals = await contract.read(state, contract.ORACLE, ABI, "decimals");
    if (contract.at(oracle[0]) !== contract.ORACLE || contract.at(spoke[0]) !== contract.SPOKE || decimals[0] !== 8n) contract.fail("ORACLE_WIRING_MISMATCH");
    async function freshness(address, policy, depth = 0) {
      if (!policy) return { freshness: "UNKNOWN", reason: "SOURCE_SEMANTICS_UNQUALIFIED", semanticsChainQualified: false };
      if (policy.kind === "answer-only") return { freshness: "UNKNOWN", reason: "SOURCE_EXPOSES_NO_TIMESTAMP" };
      if (policy.kind === "round-data" && policy.timestampPropagation === "propagated") return {
        freshness: "UNKNOWN", reason: "CURRENT_CHILD_BINDING_UNQUALIFIED", timestampEvidence: "ADAPTER_PROPAGATED", semanticsChainQualified: false };
      if (policy.kind === "round-data") {
        const round = await contract.read(state, address, TIMESTAMP, "latestRoundData");
        return { freshness: contract.timestampFreshness(round[3], prepared.pin.timestamp, policy.maxAgeSeconds), updatedAt: round[3].toString(),
          timestampEvidence: policy.timestampPropagation === "propagated" ? "ADAPTER_PROPAGATED" : "ADAPTER_REPORTED",
          maxAgeSeconds: Number.isSafeInteger(policy.maxAgeSeconds) && policy.maxAgeSeconds > 0 ? policy.maxAgeSeconds : null };
      }
      if (depth >= 1 || !policy.child || !policy.childBindingQualified || !scope.has(policy.child)) return {
        freshness: "UNKNOWN", reason: "CHILD_SCOPE_OR_SOURCE_UNQUALIFIED", semanticsChainQualified: false };
      const childDescriptor = descriptorFor(policy.child);
      if (!childDescriptor) return { freshness: "UNKNOWN", reason: "CHILD_SCOPE_OR_SOURCE_UNQUALIFIED", semanticsChainQualified: false };
      const childPolicy = contract.sourcePolicy(childDescriptor, await binding(policy.child));
      const child = await freshness(policy.child, childPolicy, depth + 1);
      // A fresh child does not prove a capped parent is fresh. No invented parent
      // latestRoundData selector, cap, timestamp propagation or clamping rule.
      return { freshness: child.freshness === "FAIL" ? "FAIL" : "UNKNOWN", reason: "PARENT_TIMESTAMP_NOT_INDEPENDENTLY_OBSERVED",
        timestampEvidence: "CHILD_ONLY_PARENT_UNKNOWN", childFreshness: child.freshness, semanticsChainQualified: child.semanticsChainQualified !== false };
    }
    for (const link of prepared.links) {
      const source = await contract.read(state, contract.ORACLE, ABI, "getReserveSource", [link.reserveId]);
      const price = await contract.read(state, contract.ORACLE, ABI, "getReservePrice", [link.reserveId]);
      if (contract.at(source[0]) !== link.source) contract.fail("ORACLE_WIRING_MISMATCH");
      if (price[0] <= 0n) contract.fail("ORACLE_PRICE_INVALID");
      const sourceBinding = await binding(link.source);
      const policy = contract.sourcePolicy(descriptorFor(link.source), sourceBinding);
      const assessment = await freshness(link.source, policy);
      out.reserves.push({ reserveId: link.reserveId, assetId: link.assetId, hub: link.hubAddress, underlying: link.underlying,
        source: link.source, priceRaw: price[0].toString(), oracleDecimals: 8, runtimeAddress: sourceBinding.runtimeAddress,
        runtimeCodeKeccak256: sourceBinding.codeKeccak256,
        sourceSemanticsQualified: Boolean(policy) && assessment.semanticsChainQualified !== false, ...assessment });
    }
    out.wiringObserved = true;
    out.sourceSemanticsQualified = Boolean(oraclePolicy) && out.reserves.every(row => row.sourceSemanticsQualified);
    out.freshness = out.reserves.some(row => row.freshness === "FAIL") ? "FAIL"
      : out.sourceSemanticsQualified && out.reserves.every(row => row.freshness === "PASS") ? "PASS" : "UNKNOWN";
    out.componentObservationComplete = out.wiringObserved;
  } catch (error) { out.errors.push(contract.safeFailure(error)); }
  if (state && !await contract.finish(out, state)) {
    out.sourceSemanticsQualified = false; out.freshness = "UNKNOWN";
    for (const row of out.reserves) { row.freshness = "UNKNOWN"; row.sourceSemanticsQualified = false; }
  }
  if (!out.observationPin) out.componentObservationComplete = false;
  out.coverage.classification = out.componentObservationComplete ? "BOUNDED_OBSERVATIONAL" : "SOURCE_INCOMPLETE";
  return out;
}
if (require.main === module) console.log(JSON.stringify({ status: "OFFLINE_INJECTED_INPUT_REQUIRED", networkCalls: 0, writes: 0 }));
module.exports = { collectBaseOracles, ABI, TIMESTAMP };
