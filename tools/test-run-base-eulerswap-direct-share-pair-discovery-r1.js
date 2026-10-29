"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const discovery = require("./run-base-eulerswap-direct-share-pair-discovery-r1");

const observationBinding = () => ({
  exact: true,
  candidateCommitment: "candidate_pool_commitment_r1",
  blockNumber: 12345678,
  stateCommitment: "same_state_commitment_r1",
  pinsetCommitment: discovery.REVIEWED_FIXTURE_AUTHORITY.pinsetCommitment,
  bundleCommitment: "observation_bundle_commitment_r1"
});
const readProof = (name) => ({ exact: true, success: true, reverted: false, commitment: `${name}_read_commitment_r1`, observationBinding: observationBinding() });
function quoteSample(amountOut, amountIn) {
  return {
    amountOut: String(amountOut),
    computeQuote: { ...readProof(`compute_quote_${amountOut}`), exactIn: false, tokenIn: "asset_a", tokenOut: "evault_share_v", amountOut: String(amountOut), amountIn: String(amountIn) },
    peripheryQuoteExactOutput: { ...readProof(`periphery_quote_${amountOut}`), exactOutput: true, venueCommitment: "candidate_pool_commitment_r1", tokenIn: "asset_a", tokenOut: "evault_share_v", amountOut: String(amountOut), amountIn: String(amountIn) },
    limits: { ...readProof(`limits_${amountOut}`), tokenIn: "asset_a", tokenOut: "evault_share_v", maximumAmountOut: "100" }
  };
}
function candidate() {
  return {
    candidateCommitment: "candidate_pool_commitment_r1",
    venue: "EULERSWAP_V2",
    version: "V2",
    genericAdapter: false,
    direct: true,
    poolCount: 1,
    observationBinding: observationBinding(),
    factoryMembership: { deployedPool: true, venueCommitment: "candidate_pool_commitment_r1", read: readProof("deployed_pools") },
    runtime: { codePresent: true, exact: true, commitment: discovery.REVIEWED_FIXTURE_AUTHORITY.bindings.poolRuntime },
    reads: {
      getAssets: { ...readProof("get_assets"), normalizedAssets: ["asset_a", "evault_share_v"] },
      getStaticParams: { ...readProof("get_static_params"), normalizedStaticParams: { active: true, unlocked: true, assertionCommitment: "static_params_assertion_commitment_r1" } },
      getReserves: { ...readProof("get_reserves"), normalizedReserves: ["1000", "2000"] }
    },
    poolState: { active: true, unlocked: true, reserves: ["1000", "2000"], staticParamsAssertionCommitment: "static_params_assertion_commitment_r1" },
    pair: {
      assets: ["asset_a", "evault_share_v"], eVaultShare: "evault_share_v", eVaultAsset: "asset_a", eVaultShareCount: 1,
      assetCallSuccess: true, shareBindingExact: true, assetCallCommitment: "evault_asset_call_commitment_r1"
    },
    standardTransfer: true,
    components: Object.fromEntries(discovery.FORBIDDEN_COMPONENTS.map((name) => [name, false])),
    holderProof: {
      exact: true, fresh: true, stale: false, debtFree: true, debtAmount: "0", shareTransferSuccess: true, accountStatusClean: true,
      shareAmountTransferred: "10", sessionCommitment: "holder_session_commitment_r1", commitment: "fresh_holder_proof_commitment_r1",
      observationBinding: observationBinding()
    },
    redemptionProof: {
      exact: true, stale: false, erc4626: true, immediate: true, success: true, underlyingReceived: true, accountStatusClean: true,
      shareAsset: "evault_share_v", underlyingAsset: "asset_a", shareAmountRedeemed: "10", underlyingAmountReceived: "19",
      sessionCommitment: "holder_session_commitment_r1", commitment: "immediate_redemption_proof_commitment_r1",
      observationBinding: observationBinding()
    },
    quotePreflight: {
      tokenIn: "asset_a", tokenOut: "evault_share_v", direction: "A_TO_V", exactOutput: true, interpolationUsed: false,
      samples: [quoteSample(10, 12), quoteSample(20, 25), quoteSample(30, 39)]
    }
  };
}
function fixture() {
  const reviewed = discovery.REVIEWED_FIXTURE_AUTHORITY;
  return {
    authority: {
      chainId: 8453,
      mode: "OFFLINE_REVIEWED_FIXTURE_ONLY",
      fixtureOnly: true,
      captureEnabled: false,
      genericAdapter: false,
      venue: "EULERSWAP_V2",
      eulerSwapVersion: "V2",
      reviewedManifestValidated: true,
      manifestCommitment: reviewed.manifestCommitment,
      officialPins: { registry: "d0e9a428", evk: "5b98b420", eulerSwap: "153cf82b" },
      observation: {
        blockNumber: 12345678, timestamp: "1700000000", finalized: true, requireCanonical: true,
        stateCommitment: "same_state_commitment_r1", pinsetCommitment: reviewed.pinsetCommitment, bundleCommitment: "observation_bundle_commitment_r1"
      },
      observerCommitments: [
        { independent: true, finalized: true, requireCanonical: true, blockNumber: 12345678, stateCommitment: "same_state_commitment_r1", pinsetCommitment: reviewed.pinsetCommitment, classCommitment: reviewed.observerClassCommitments[0], commitment: "independent_observer_commitment_one_r1" },
        { independent: true, finalized: true, requireCanonical: true, blockNumber: 12345678, stateCommitment: "same_state_commitment_r1", pinsetCommitment: reviewed.pinsetCommitment, classCommitment: reviewed.observerClassCommitments[1], commitment: "independent_observer_commitment_two_r1" }
      ],
      agreement: { sameBlock: true, sameState: true, samePin: true, twoIndependentObservers: true, mixedState: false },
      terminalRecheck: {
        complete: true, finalized: true, requireCanonical: true, blockNumber: 12345678, stateCommitment: "same_state_commitment_r1",
        pinsetCommitment: reviewed.pinsetCommitment, commitment: "terminal_recheck_commitment_r1",
        observerCommitments: ["independent_observer_commitment_one_r1", "independent_observer_commitment_two_r1"],
        classCommitments: [...reviewed.observerClassCommitments]
      },
      bindings: {
        factory: { exact: true, version: "V2", implementationCommitment: reviewed.bindings.factoryImplementation, runtimeCommitment: reviewed.bindings.factoryRuntime },
        periphery: { exact: true, version: "V2", implementationCommitment: reviewed.bindings.peripheryImplementation, runtimeCommitment: reviewed.bindings.peripheryRuntime }
      }
    },
    candidates: [candidate()]
  };
}
const run = (mutate = () => {}) => { const value = fixture(); mutate(value); return discovery.runDiscoveryPreflight(value); };
const resultReads = (row) => [
  row.reads.getAssets,
  row.reads.getReserves,
  row.reads.getStaticParams,
  ...row.quotePreflight.samples.flatMap((sample) => [sample.computeQuote, sample.limits, sample.peripheryQuoteExactOutput])
];
const everyBoundRead = (row) => [row.factoryMembership.read, ...resultReads(row)];

test("ready direct EulerSwap V2 A-to-EVault-share route remains aggregate-only", () => {
  const result = run();
  assert.equal(result.status, "READY_FOR_SHADOW_CAPTURE");
  assert.deepEqual(result.counts, { submitted: 1, evaluated: 1, boundPairs: 1, quoteSamples: 3, structuralFailures: 0, incompleteInputs: 0 });
  assert.equal(result.authorityMode, "REVIEWED_FIXTURE_ONLY_NOT_REAL_TARGET_AUTHORITY");
  assert.deepEqual(result.gates, { captureEnabled: false, automaticPromotion: false, routePositive: "unknown", executableNow: "unknown", economicsEvaluated: false, profitAssessed: false });
});

test("empty bounded candidate set holds without claiming a pair", () => {
  const result = run((value) => { value.candidates = []; });
  assert.equal(result.status, "HOLD_NO_BOUND_PAIR");
  assert.equal(result.counts.boundPairs, 0);
});

test("missing, over-cap, and ambiguous candidate sets fail closed", () => {
  assert.equal(run((value) => { delete value.candidates; }).status, "INCOMPLETE");
  assert.equal(run((value) => { value.candidates = Array.from({ length: discovery.MAX_CANDIDATES + 1 }, candidate); }).status, "REJECT");
  const ambiguous = run((value) => { value.candidates.push(candidate()); });
  assert.equal(ambiguous.status, "REJECT");
  assert.equal(ambiguous.counts.boundPairs, 2);
});

test("candidate cap is enforced before recursively sanitizing candidate members", () => {
  let hostileGetterReached = false;
  const hostile = {};
  Object.defineProperty(hostile, "nested", { enumerable: true, get() { hostileGetterReached = true; throw new Error("must not be reached"); } });
  const value = fixture();
  value.candidates = Array.from({ length: discovery.MAX_CANDIDATES + 1 }, () => ({}));
  value.candidates[0] = hostile;
  const result = discovery.runDiscoveryPreflight(value);
  assert.equal(result.status, "REJECT");
  assert.equal(result.counts.submitted, discovery.MAX_CANDIDATES + 1);
  assert.equal(hostileGetterReached, false);
});

test("wrong, mixed, nonfinalized, observer, canonical, and terminal authority failures reject", () => {
  const mutations = [
    (value) => { value.authority.chainId = 1; },
    (value) => { value.authority.observation.finalized = false; },
    (value) => { value.authority.observation.requireCanonical = false; },
    (value) => { value.authority.agreement.mixedState = true; },
    (value) => { value.authority.agreement.sameState = false; },
    (value) => { value.authority.agreement.sameBlock = false; },
    (value) => { value.authority.agreement.samePin = false; },
    (value) => { value.authority.observerCommitments.pop(); },
    (value) => { value.authority.observerCommitments[0].independent = false; },
    (value) => { value.authority.observerCommitments[0].finalized = false; },
    (value) => { value.authority.observerCommitments[0].requireCanonical = false; },
    (value) => { value.authority.observerCommitments[1].commitment = value.authority.observerCommitments[0].commitment; },
    (value) => { value.authority.observerCommitments[1].classCommitment = value.authority.observerCommitments[0].classCommitment; },
    (value) => { value.authority.observerCommitments[1].classCommitment = "unreviewed_observer_class_commitment"; },
    (value) => { value.authority.observerCommitments[1].stateCommitment = "mixed_state_commitment_r2"; },
    (value) => { value.authority.observerCommitments[1].pinsetCommitment = "mixed_pinset_commitment_r2"; },
    (value) => { value.authority.terminalRecheck.complete = false; },
    (value) => { value.authority.terminalRecheck.finalized = false; },
    (value) => { value.authority.terminalRecheck.blockNumber += 1; },
    (value) => { value.authority.terminalRecheck.requireCanonical = false; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("terminal recheck binds both observer and reviewed class commitments", () => {
  const mutations = [
    (value) => { value.authority.terminalRecheck.observerCommitments.pop(); },
    (value) => { value.authority.terminalRecheck.observerCommitments[1] = value.authority.terminalRecheck.observerCommitments[0]; },
    (value) => { value.authority.terminalRecheck.observerCommitments[1] = "other_observer_commitment"; },
    (value) => { value.authority.terminalRecheck.classCommitments.pop(); },
    (value) => { value.authority.terminalRecheck.classCommitments[1] = value.authority.terminalRecheck.classCommitments[0]; },
    (value) => { value.authority.terminalRecheck.classCommitments[1] = "other_class_commitment"; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("official pins and exact fixture authority commitments are mandatory", () => {
  for (const name of Object.keys(discovery.OFFICIAL_PINS)) assert.equal(run((value) => { value.authority.officialPins[name] = "valid_but_wrong_pin"; }).status, "REJECT");
  assert.equal(run((value) => { value.authority.manifestCommitment = "valid_but_unauthorized_manifest_r2"; }).status, "REJECT");
  for (const unit of ["factory", "periphery"]) {
    assert.equal(run((value) => { value.authority.bindings[unit].exact = false; }).status, "REJECT");
    assert.equal(run((value) => { value.authority.bindings[unit].implementationCommitment = `valid_wrong_${unit}_implementation`; }).status, "REJECT");
    assert.equal(run((value) => { value.authority.bindings[unit].runtimeCommitment = `valid_wrong_${unit}_runtime`; }).status, "REJECT");
  }
});

test("V1, generic venue, generic adapter, real authority, and capture mode reject", () => {
  assert.equal(run((value) => { delete value.authority.reviewedManifestValidated; }).status, "INCOMPLETE");
  assert.notEqual(run((value) => { value.authority.reviewedManifestValidated = false; }).status, "READY_FOR_SHADOW_CAPTURE");
  const mutations = [
    (value) => { value.authority.eulerSwapVersion = "V1"; },
    (value) => { value.authority.venue = "GENERIC_DEX"; },
    (value) => { value.authority.genericAdapter = true; },
    (value) => { value.authority.fixtureOnly = false; },
    (value) => { value.authority.mode = "REAL_TARGET"; },
    (value) => { value.authority.captureEnabled = true; },
    (value) => { value.candidates[0].version = "V1"; },
    (value) => { value.candidates[0].genericAdapter = true; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("missing factory, runtime, code, active, and unlocked proofs fail closed", () => {
  assert.equal(run((value) => { delete value.candidates[0].observationBinding; }).status, "INCOMPLETE");
  assert.equal(run((value) => { value.candidates[0].observationBinding.stateCommitment = "unbound_state_commitment"; }).status, "REJECT");
  assert.equal(run((value) => { value.candidates[0].direct = false; }).status, "REJECT");
  assert.equal(run((value) => { value.candidates[0].poolCount = 2; }).status, "REJECT");
  assert.equal(run((value) => { delete value.candidates[0].factoryMembership; }).status, "INCOMPLETE");
  assert.equal(run((value) => { value.candidates[0].factoryMembership.deployedPool = false; }).status, "REJECT");
  assert.equal(run((value) => { value.candidates[0].factoryMembership.venueCommitment = "unbound_pool_commitment"; }).status, "REJECT");
  assert.equal(run((value) => { delete value.candidates[0].runtime; }).status, "INCOMPLETE");
  assert.equal(run((value) => { value.candidates[0].runtime.codePresent = false; }).status, "REJECT");
  assert.equal(run((value) => { value.candidates[0].runtime.commitment = "valid_wrong_pool_runtime"; }).status, "REJECT");
  assert.equal(run((value) => { value.candidates[0].poolState.active = false; }).status, "REJECT");
  assert.equal(run((value) => { value.candidates[0].poolState.unlocked = false; }).status, "REJECT");
});

test("all required normalized pool reads must succeed without reversion", () => {
  for (const name of ["getAssets", "getStaticParams", "getReserves"]) {
    assert.equal(run((value) => { delete value.candidates[0].reads[name]; }).status, "INCOMPLETE");
    assert.equal(run((value) => { value.candidates[0].reads[name].exact = false; }).status, "REJECT");
    assert.equal(run((value) => { value.candidates[0].reads[name].success = false; }).status, "REJECT");
    assert.equal(run((value) => { value.candidates[0].reads[name].reverted = true; }).status, "REJECT");
  }
});

test("every pool and quote read rejects mixed candidate or observation substitution", () => {
  const names = ["getAssets", "getReserves", "getStaticParams", "computeQuote", "getLimits", "peripheryQuote"];
  for (let index = 0; index < names.length; index += 1) {
    assert.equal(run((value) => {
      resultReads(value.candidates[0])[index < 3 ? index : 3 + (index - 3)].observationBinding.candidateCommitment = "other_candidate_commitment";
    }).status, "REJECT", `${names[index]} candidate`);
    assert.equal(run((value) => {
      resultReads(value.candidates[0])[index < 3 ? index : 3 + (index - 3)].observationBinding.stateCommitment = "other_state_commitment";
    }).status, "REJECT", `${names[index]} observation`);
  }
});

test("decoded getAssets, getReserves, and getStaticParams must agree with assertions", () => {
  const mutations = [
    (value) => { value.candidates[0].reads.getAssets.normalizedAssets[0] = "other_asset"; },
    (value) => { value.candidates[0].reads.getAssets.normalizedAssets.reverse(); },
    (value) => { value.candidates[0].reads.getReserves.normalizedReserves[0] = "999"; },
    (value) => { value.candidates[0].reads.getStaticParams.normalizedStaticParams.active = false; },
    (value) => { value.candidates[0].reads.getStaticParams.normalizedStaticParams.unlocked = false; },
    (value) => { value.candidates[0].reads.getStaticParams.normalizedStaticParams.assertionCommitment = "other_static_assertion"; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("pair must be exactly one EVault share and its underlying asset", () => {
  const mutations = [
    (value) => { value.candidates[0].pair.assets.pop(); },
    (value) => { value.candidates[0].pair.assets.push("third_asset"); },
    (value) => { value.candidates[0].pair.assets[1] = "other_share"; },
    (value) => { value.candidates[0].pair.eVaultAsset = "other_asset"; },
    (value) => { value.candidates[0].pair.eVaultShareCount = 2; },
    (value) => { value.candidates[0].pair.assetCallSuccess = false; },
    (value) => { value.candidates[0].pair.shareBindingExact = false; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("standard transfer, fresh debt-free account status, and immediate ERC4626 redemption are mandatory", () => {
  const mutations = [
    (value) => { value.candidates[0].standardTransfer = false; },
    (value) => { value.candidates[0].holderProof.fresh = false; },
    (value) => { value.candidates[0].holderProof.debtFree = false; },
    (value) => { value.candidates[0].holderProof.debtAmount = "1"; },
    (value) => { value.candidates[0].holderProof.shareTransferSuccess = false; },
    (value) => { value.candidates[0].holderProof.accountStatusClean = false; },
    (value) => { value.candidates[0].redemptionProof.erc4626 = false; },
    (value) => { value.candidates[0].redemptionProof.immediate = false; },
    (value) => { value.candidates[0].redemptionProof.success = false; },
    (value) => { value.candidates[0].redemptionProof.underlyingReceived = false; },
    (value) => { value.candidates[0].redemptionProof.underlyingAsset = "wrong_asset"; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("holder transfer and redemption amounts, session, freshness, and observation must match", () => {
  const mutations = [
    (value) => { value.candidates[0].holderProof.shareAmountTransferred = "0"; },
    (value) => { value.candidates[0].redemptionProof.shareAmountRedeemed = "0"; },
    (value) => { value.candidates[0].redemptionProof.shareAmountRedeemed = "9"; },
    (value) => { value.candidates[0].redemptionProof.underlyingAmountReceived = "0"; },
    (value) => { value.candidates[0].redemptionProof.sessionCommitment = "different_holder_session"; },
    (value) => { value.candidates[0].holderProof.stale = true; },
    (value) => { value.candidates[0].redemptionProof.stale = true; },
    (value) => { value.candidates[0].holderProof.observationBinding.stateCommitment = "stale_holder_state"; },
    (value) => { value.candidates[0].redemptionProof.observationBinding.bundleCommitment = "stale_redemption_bundle"; },
    (value) => { value.candidates[0].holderProof.observationBinding.candidateCommitment = "different_candidate"; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("every forbidden route component rejects", () => {
  for (const name of discovery.FORBIDDEN_COMPONENTS) assert.equal(run((value) => { value.candidates[0].components[name] = true; }).status, "REJECT");
});

test("three distinct exact-output quote samples and direct direction are mandatory", () => {
  assert.equal(run((value) => { value.candidates[0].quotePreflight.samples.pop(); }).status, "INCOMPLETE");
  assert.equal(run((value) => { value.candidates[0].quotePreflight.samples[1].amountOut = "10"; }).status, "REJECT");
  assert.equal(run((value) => { value.candidates[0].quotePreflight.exactOutput = false; }).status, "REJECT");
  assert.equal(run((value) => { value.candidates[0].quotePreflight.interpolationUsed = true; }).status, "REJECT");
  assert.equal(run((value) => { value.candidates[0].quotePreflight.tokenIn = "evault_share_v"; }).status, "REJECT");
});

test("missing, reverted, zero, and unequal pool/periphery quotes fail closed", () => {
  const mutations = [
    (value) => { delete value.candidates[0].quotePreflight.samples[0].computeQuote; },
    (value) => { value.candidates[0].quotePreflight.samples[0].computeQuote.success = false; },
    (value) => { value.candidates[0].quotePreflight.samples[0].computeQuote.reverted = true; },
    (value) => { value.candidates[0].quotePreflight.samples[0].peripheryQuoteExactOutput.reverted = true; },
    (value) => { value.candidates[0].quotePreflight.samples[0].computeQuote.amountIn = "0"; },
    (value) => { value.candidates[0].quotePreflight.samples[0].peripheryQuoteExactOutput.amountIn = "13"; },
    (value) => { value.candidates[0].quotePreflight.samples[0].computeQuote.amountOut = "11"; },
    (value) => { value.candidates[0].quotePreflight.samples[0].peripheryQuoteExactOutput.amountOut = "11"; },
    (value) => { value.candidates[0].quotePreflight.samples[0].computeQuote.exactIn = true; },
    (value) => { value.candidates[0].quotePreflight.samples[0].peripheryQuoteExactOutput.exactOutput = false; },
    (value) => { value.candidates[0].quotePreflight.samples[0].peripheryQuoteExactOutput.venueCommitment = "other_pool_commitment"; }
  ];
  for (const mutate of mutations) assert.notEqual(run(mutate).status, "READY_FOR_SHADOW_CAPTURE");
});

test("current getLimits must cover each requested EVault share amount", () => {
  assert.equal(run((value) => { delete value.candidates[0].quotePreflight.samples[0].limits; }).status, "INCOMPLETE");
  assert.equal(run((value) => { value.candidates[0].quotePreflight.samples[2].limits.maximumAmountOut = "29"; }).status, "REJECT");
  assert.equal(run((value) => { value.candidates[0].quotePreflight.samples[0].limits.tokenOut = "wrong_share"; }).status, "REJECT");
});

test("sanitizer rejects prohibited identifiers and transport data", () => {
  const cases = [
    { url: "opaque" }, { safe: "https://example.invalid" }, { safe: "rpc.example.com" }, { providerLabel: "observer" },
    { family: "observer" }, { rawRpc: "x" }, { rawQuotePayload: "x" }, { calldata: "0x1234" }, { address: "opaque" },
    { safe: `0x${"11".repeat(20)}` }, { blockHash: "x" }, { stateRoot: "x" }, { transactionHash: "x" }, { sourcePath: "x" }
  ];
  for (const value of cases) assert.throws(() => discovery.assertSanitized(value), discovery.DiscoveryError);
});

test("output is deterministic, aggregate-only, and contains no candidate or quote details", () => {
  const first = run(), second = run();
  assert.deepEqual(first, second);
  assert.ok(["READY_FOR_SHADOW_CAPTURE", "HOLD_NO_BOUND_PAIR", "REJECT", "INCOMPLETE"].includes(first.status));
  const text = JSON.stringify(first);
  assert.equal(/asset_a|evault_share_v|candidate_pool|amountOut|amountIn|reserves|balance|observer_commitment|terminal_recheck|https?:|0x[0-9a-f]{40}/iu.test(text), false);
  assert.equal(first.gates.economicsEvaluated, false);
  assert.equal(first.gates.profitAssessed, false);
  assert.equal(first.safety.outputArtifacts, false);
});

test("semantic injected bundle commitment is validated but never persisted in output", () => {
  const marker = "semantic_bundle_marker_never_emit_r1";
  const value = fixture();
  value.authority.observation.bundleCommitment = marker;
  const row = value.candidates[0];
  row.observationBinding.bundleCommitment = marker;
  for (const read of everyBoundRead(row)) read.observationBinding.bundleCommitment = marker;
  row.holderProof.observationBinding.bundleCommitment = marker;
  row.redemptionProof.observationBinding.bundleCommitment = marker;
  const result = discovery.runDiscoveryPreflight(value);
  assert.equal(result.status, "READY_FOR_SHADOW_CAPTURE");
  assert.equal(result.binding.observationBundleValidated, true);
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.deepEqual(Object.keys(result.commitments), ["aggregateResult"]);
});

test("all missing structural inputs return INCOMPLETE without throwing", () => {
  const mutations = [
    (value) => { delete value.authority; },
    (value) => { delete value.authority.observation; },
    (value) => { delete value.authority.terminalRecheck; },
    (value) => { delete value.authority.bindings.factory; },
    (value) => { delete value.candidates[0].pair; },
    (value) => { delete value.candidates[0].holderProof; },
    (value) => { delete value.candidates[0].redemptionProof; },
    (value) => { delete value.candidates[0].quotePreflight; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "INCOMPLETE");
});
