"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const classifier = require("./run-multichain-profit-route-classifier-r1");

const VERSION = "MULTICHAIN_PROFIT_ROUTE_CLASSIFIER_R1_CONTENT_ADDRESSED_V2";
const VENUES = classifier.VENUES;
const MANIFEST = {
  schema: "multichain-profit-route-reviewed-fixture-manifest-v2",
  chains: {
    1: { chainId: 1, pinIdentity: "reviewed_chain_1_canonical_pin_r2" },
    8453: { chainId: 8453, pinIdentity: "reviewed_chain_8453_canonical_pin_r2" },
    42161: { chainId: 42161, pinIdentity: "reviewed_chain_42161_canonical_pin_r2" }
  },
  observerClasses: [
    { classId: "class_alpha", identity: "reviewed_independent_observer_identity_alpha_r2" },
    { classId: "class_beta", identity: "reviewed_independent_observer_identity_beta_r2" }
  ],
  assets: {
    comet_base_asset: { assetRef: "comet_base_asset", decimals: 6, scale: "1000000" },
    comet_collateral_asset: { assetRef: "comet_collateral_asset", decimals: 8, scale: "100000000" },
    vault_underlying_asset: { assetRef: "vault_underlying_asset", decimals: 6, scale: "1000000" },
    vault_share_asset: { assetRef: "vault_share_asset", decimals: 18, scale: "1000000000000000000" },
    fxsave_settlement_asset: { assetRef: "fxsave_settlement_asset", decimals: 6, scale: "1000000" },
    fxsave_input_asset: { assetRef: "fxsave_input_asset", decimals: 18, scale: "1000000000000000000" },
    fxsave_raw_identity_token: { assetRef: "fxsave_raw_identity_token", decimals: 8, scale: "100000000" }
  },
  candidates: {
    COMET_RESERVE_BUYCOLLATERAL: { lineageId: "reviewed_comet_fixture_lineage_r2", allowedChains: [1, 8453, 42161], venue: VENUES.COMET_RESERVE_BUYCOLLATERAL },
    ERC4626_SHARE_DISCOUNT_REDEEM: { lineageId: "reviewed_erc4626_fixture_lineage_r2", allowedChains: [1, 8453, 42161], venue: VENUES.ERC4626_SHARE_DISCOUNT_REDEEM },
    FXSAVE_EMPTY_ROUTE_IDENTITY: { lineageId: "reviewed_fxsave_fixture_lineage_r2", allowedChains: [1], venue: VENUES.FXSAVE_EMPTY_ROUTE_IDENTITY }
  },
  bindings: Object.fromEntries(classifier.MECHANISMS.map((mechanism) => [mechanism, Object.fromEntries(
    ["source", "runtime", "factory", "asset", "venue"].map((name) => [name, { mechanism, bindingKind: name, revision: "reviewed_r2" }])
  )])),
  fxsaveBindings: Object.fromEntries(["deployment", "facet", "selector", "converterSource", "converterRuntime"].map((name) => [name, { unit: name, revision: "reviewed_fxsave_r2" }]))
};

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
const hash = (domain, payload) => `c_${crypto.createHash("sha256").update(canonical({ domain, payload })).digest("hex")}`;
const withoutCommitment = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "commitment"));
function seal(row, domain) {
  row.commitmentDomain = domain;
  row.commitment = hash(domain, withoutCommitment(row));
  return row;
}
function refreshSeals(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) for (const item of value) refreshSeals(item);
  else {
    for (const [key, item] of Object.entries(value)) if (key !== "commitment") refreshSeals(item);
    if (typeof value.commitmentDomain === "string") value.commitment = hash(value.commitmentDomain, withoutCommitment(value));
  }
}
const manifestCommitment = hash("REVIEWED_MANIFEST_V2", MANIFEST);
const pinCommitment = (chainId) => hash("REVIEWED_PIN_V2", MANIFEST.chains[chainId]);
const state = (chainId) => ({
  chainId,
  blockNumber: 10000000 + chainId,
  stateCommitment: `state_commitment_chain_${chainId}_r2`,
  pinCommitment: pinCommitment(chainId),
  bundleCommitment: `bundle_commitment_chain_${chainId}_r2`
});
const observationBinding = (candidateCommitment, chainId) => ({ exact: true, candidateCommitment, ...state(chainId) });
function proof(code, candidateCommitment, chainId, extra = {}) {
  return seal({ exact: true, success: true, reverted: false, observationBinding: observationBinding(candidateCommitment, chainId), ...extra }, `PROOF_${code}_V2`);
}
function economics(candidateCommitment, chainId, settlementAssetRef) {
  const unit = MANIFEST.assets[settlementAssetRef];
  const valuationBasisPayload = { kind: "EXACT_SETTLEMENT_ASSET_BASE_UNITS", settlementAssetRef, decimals: unit.decimals, scale: unit.scale };
  return seal({
    settlementAssetRef,
    decimals: unit.decimals,
    scale: unit.scale,
    valuationBasisPayload,
    valuationBasisCommitment: hash("VALUATION_BASIS_V2", valuationBasisPayload),
    assetRegistryCommitment: hash("VERIFIER_ASSET_REGISTRY_V3", MANIFEST.assets),
    observationBinding: observationBinding(candidateCommitment, chainId)
  }, "ECONOMICS_CONTEXT_V2");
}
function settlementMoney(amount, context, candidateCommitment, chainId) {
  return seal({
    unitKind: "SETTLEMENT_VALUE", amount: String(amount), assetRef: context.settlementAssetRef, settlementAssetRef: context.settlementAssetRef,
    decimals: context.decimals, scale: context.scale, valuationBasisCommitment: context.valuationBasisCommitment,
    observationBinding: observationBinding(candidateCommitment, chainId)
  }, "SETTLEMENT_VALUE_V3");
}
function quantity(amount, assetRef, candidateCommitment, chainId) {
  const unit = MANIFEST.assets[assetRef];
  return seal({
    unitKind: "TOKEN_QUANTITY", amount: String(amount), assetRef, decimals: unit.decimals, scale: unit.scale,
    assetUnitCommitment: hash("ASSET_UNIT_V3", unit), observationBinding: observationBinding(candidateCommitment, chainId)
  }, "TOKEN_QUANTITY_V3");
}
const gcd = (a, b) => { while (b !== 0n) [a, b] = [b, a % b]; return a; };
function conversion(source, destination, candidateCommitment, chainId) {
  let numerator = BigInt(destination.amount) * BigInt(source.scale);
  let denominator = BigInt(source.amount) * BigInt(destination.scale);
  const divisor = gcd(numerator, denominator); numerator /= divisor; denominator /= divisor;
  return seal({
    conservative: true, rounding: "DOWN", sourceCommitment: source.commitment, destinationCommitment: destination.commitment,
    sourceAssetRef: source.assetRef, destinationAssetRef: destination.assetRef, sourceScale: source.scale, destinationScale: destination.scale,
    numerator: numerator.toString(), denominator: denominator.toString(), observationBinding: observationBinding(candidateCommitment, chainId)
  }, "CONVERSION_EVIDENCE_V3");
}
function candidateCommitment(mechanism, chainId) {
  return hash("CANDIDATE_LINEAGE_V2", {
    lineagePayload: MANIFEST.candidates[mechanism], chainId, mechanism, venue: VENUES[mechanism], observation: state(chainId)
  });
}
function candidateBindings(mechanism, commitment, chainId) {
  return Object.fromEntries(Object.entries(MANIFEST.bindings[mechanism]).map(([name, bindingPayload]) => [name, seal({
    exact: true, bindingPayload: structuredClone(bindingPayload), observationBinding: observationBinding(commitment, chainId)
  }, `CANDIDATE_BINDING_${name.toUpperCase()}_V2`)]));
}
const components = () => ({ ...Object.fromEntries(classifier.FORBIDDEN_COMPONENTS.map((name) => [name, false])), flashFunding: false });
function commonCandidate(mechanism, chainId, settlementAssetRef) {
  const commitment = candidateCommitment(mechanism, chainId);
  return {
    chainId, mechanism, venue: VENUES[mechanism], lineagePayload: structuredClone(MANIFEST.candidates[mechanism]),
    candidateCommitment: commitment, observationBinding: observationBinding(commitment, chainId),
    bindings: candidateBindings(mechanism, commitment, chainId), components: components(),
    economics: economics(commitment, chainId, settlementAssetRef), samples: []
  };
}
function costRows(row) {
  return classifier.COST_NAMES.map((name) => ({ name, evidence: true, provenance: true, value: settlementMoney("1", row.economics, row.candidateCommitment, row.chainId) }));
}
function sealSampleAmounts(sample) {
  sample.amountCommitment = hash("SAMPLE_AMOUNT_SET_V2", { size: sample.size.commitment, proceeds: sample.proceeds.commitment, acquisition: sample.acquisition.commitment });
}

function cometCandidate() {
  const row = commonCandidate("COMET_RESERVE_BUYCOLLATERAL", 42161, "comet_base_asset");
  const c = row.candidateCommitment, chain = row.chainId, e = row.economics;
  row.mechanismFacts = {
    publicBuyPath: true, paused: false, baseAssetRef: "comet_base_asset", collateralAssetRef: "comet_collateral_asset", settlementAssetRef: "comet_base_asset",
    reserveState: proof("COMET_RESERVE_STATE", c, chain, {
      baseReserves: quantity("499", "comet_base_asset", c, chain), targetBaseReserves: quantity("500", "comet_base_asset", c, chain),
      collateralInventory: quantity("100", "comet_collateral_asset", c, chain)
    }),
    quoteBounds: proof("COMET_QUOTE_BOUNDS", c, chain, {
      minimumCollateral: quantity("1", "comet_collateral_asset", c, chain), maximumCollateral: quantity("50", "comet_collateral_asset", c, chain)
    }),
    publicUnwind: proof("COMET_PUBLIC_UNWIND", c, chain, { public: true, direct: true, targetSpecific: true, tokenIn: "comet_collateral_asset", tokenOut: "comet_base_asset" })
  };
  row.samples = [[10, 20, 40], [20, 40, 70], [30, 60, 100]].map(([size, acquisition, proceeds]) => {
    const sampleSize = quantity(size, "comet_collateral_asset", c, chain);
    const sampleAcquisition = settlementMoney(acquisition, e, c, chain);
    const sampleProceeds = settlementMoney(proceeds, e, c, chain);
    const basePaid = settlementMoney(acquisition, e, c, chain), collateralReceived = quantity(size, "comet_collateral_asset", c, chain);
    const collateralIn = quantity(size, "comet_collateral_asset", c, chain), baseProceeds = settlementMoney(proceeds, e, c, chain);
    const sample = {
      size: sampleSize, acquisition: sampleAcquisition, proceeds: sampleProceeds,
      observationBinding: observationBinding(c, chain), costs: costRows(row),
      mechanismResult: {
        buyQuote: proof("COMET_BUY_QUOTE", c, chain, { basePaid, collateralReceived, conversionEvidence: conversion(basePaid, collateralReceived, c, chain) }),
        transferDeltas: proof("COMET_TRANSFER_DELTAS", c, chain, { baseAssetOut: quantity(acquisition, "comet_base_asset", c, chain), collateralAssetIn: quantity(size, "comet_collateral_asset", c, chain) }),
        unwindQuote: proof("COMET_UNWIND_QUOTE", c, chain, { collateralIn, baseProceeds, conversionEvidence: conversion(collateralIn, baseProceeds, c, chain) })
      }
    };
    sealSampleAmounts(sample); return sample;
  });
  return row;
}

function erc4626Candidate() {
  const row = commonCandidate("ERC4626_SHARE_DISCOUNT_REDEEM", 8453, "vault_underlying_asset");
  const c = row.candidateCommitment, chain = row.chainId, e = row.economics;
  row.mechanismFacts = {
    shareAssetRef: "vault_share_asset", vaultAssetRef: "vault_underlying_asset", settlementAssetRef: "vault_underlying_asset",
    transferableShares: true, standardTransfer: true, transferProof: proof("ERC4626_TRANSFER_PROOF", c, chain),
    acquisitionVenue: proof("ERC4626_ACQUISITION_VENUE", c, chain, { public: true, direct: true, targetSpecific: true, tokenIn: "vault_underlying_asset", tokenOut: "vault_share_asset" }),
    redemptionState: proof("ERC4626_REDEMPTION_STATE", c, chain, {
      immediate: true, asyncQueue: false, delaySeconds: "0", maxRedeem: quantity("100", "vault_share_asset", c, chain),
      maxWithdraw: quantity("200", "vault_underlying_asset", c, chain), immediateLiquidity: quantity("200", "vault_underlying_asset", c, chain)
    }), directExitRequired: false
  };
  row.samples = [[10, 10, 30], [20, 30, 60], [30, 50, 90]].map(([size, acquisition, proceeds]) => {
    const sampleSize = quantity(size, "vault_share_asset", c, chain), sampleAcquisition = settlementMoney(acquisition, e, c, chain), sampleProceeds = settlementMoney(proceeds, e, c, chain);
    const sharesOut = quantity(size, "vault_share_asset", c, chain), allInCost = settlementMoney(acquisition, e, c, chain);
    const previewShares = quantity(size, "vault_share_asset", c, chain), previewAssets = settlementMoney(proceeds, e, c, chain);
    const sample = {
      size: sampleSize, acquisition: sampleAcquisition, proceeds: sampleProceeds,
      observationBinding: observationBinding(c, chain), costs: costRows(row),
      mechanismResult: {
        acquisitionQuote: proof("ERC4626_ACQUISITION_QUOTE", c, chain, { sharesOut, allInCost, conversionEvidence: conversion(allInCost, sharesOut, c, chain) }),
        previewRedeem: proof("ERC4626_PREVIEW_REDEEM", c, chain, { shares: previewShares, assets: previewAssets, conversionEvidence: conversion(previewShares, previewAssets, c, chain) }),
        actorDelta: proof("ERC4626_ACTOR_DELTA", c, chain, { sharesOut: quantity(size, "vault_share_asset", c, chain), underlyingIn: settlementMoney(proceeds, e, c, chain) })
      }
    };
    sealSampleAmounts(sample); return sample;
  });
  return row;
}

function fxLink(row) {
  return {
    callerCommitment: row.mechanismFacts.callerCommitment, beneficiaryCommitment: row.mechanismFacts.beneficiaryCommitment,
    deploymentCommitment: row.mechanismFacts.fxBindings.deployment.commitment, facetCommitment: row.mechanismFacts.fxBindings.facet.commitment,
    selectorCommitment: row.mechanismFacts.fxBindings.selector.commitment,
    converterSourceCommitment: row.mechanismFacts.fxBindings.converterSource.commitment,
    converterRuntimeCommitment: row.mechanismFacts.fxBindings.converterRuntime.commitment
  };
}
function fxsaveCandidate() {
  const row = commonCandidate("FXSAVE_EMPTY_ROUTE_IDENTITY", 1, "fxsave_settlement_asset");
  const c = row.candidateCommitment, chain = row.chainId, e = row.economics;
  row.mechanismFacts = {
    callerCommitment: "fxsave_caller_identity_r2", beneficiaryCommitment: "fxsave_beneficiary_identity_r2",
    fxBindings: Object.fromEntries(Object.entries(MANIFEST.fxsaveBindings).map(([name, bindingPayload]) => [name, seal({
      exact: true, bindingPayload: structuredClone(bindingPayload), observationBinding: observationBinding(c, chain)
    }, `FXSAVE_BINDING_${name.toUpperCase()}_V2`)]))
  };
  const link = fxLink(row);
  row.mechanismFacts.ambientInventory = proof("FXSAVE_AMBIENT_INVENTORY", c, chain, { ...link, attackerFunded: false, rawTokenRef: "fxsave_raw_identity_token", amount: quantity("100", "fxsave_raw_identity_token", c, chain) });
  row.mechanismFacts.publicAcquisition = proof("FXSAVE_PUBLIC_ACQUISITION", c, chain, { ...link, public: true, targetSpecific: true, direct: true, tokenIn: "fxsave_settlement_asset", tokenOut: "fxsave_input_asset" });
  row.mechanismFacts.publicRedeem = proof("FXSAVE_PUBLIC_REDEEM", c, chain, { ...link, public: true, emptyRoute: true, tokenIn: "fxsave_input_asset", tokenOut: "fxsave_raw_identity_token" });
  row.mechanismFacts.identityProof = proof("FXSAVE_IDENTITY_PROOF", c, chain, {
    ...link, discrepancy: true, inputAssetRef: "fxsave_input_asset", outputAssetRef: "fxsave_input_asset",
    rawTokenRef: "fxsave_raw_identity_token", converterInputRef: "fxsave_raw_identity_token", converterOutputRef: "fxsave_input_asset"
  });
  row.mechanismFacts.publicUnwind = proof("FXSAVE_PUBLIC_UNWIND", c, chain, { ...link, public: true, targetSpecific: true, direct: true, tokenIn: "fxsave_raw_identity_token", tokenOut: "fxsave_settlement_asset" });
  row.samples = [[10, 10, 30], [20, 20, 50], [30, 30, 70]].map(([size, acquisition, proceeds]) => {
    const sampleSize = quantity(size, "fxsave_input_asset", c, chain), sampleAcquisition = settlementMoney(acquisition, e, c, chain), sampleProceeds = settlementMoney(proceeds, e, c, chain);
    const amountPaid = settlementMoney(acquisition, e, c, chain), unitsAcquired = quantity(size, "fxsave_input_asset", c, chain);
    const unitsRedeemed = quantity(size, "fxsave_input_asset", c, chain), rawUnitsReceived = quantity(size, "fxsave_raw_identity_token", c, chain);
    const rawUnitsIn = quantity(size, "fxsave_raw_identity_token", c, chain), settlementProceeds = settlementMoney(proceeds, e, c, chain);
    const sample = {
      size: sampleSize, acquisition: sampleAcquisition, proceeds: sampleProceeds,
      observationBinding: observationBinding(c, chain), costs: costRows(row),
      mechanismResult: {
        acquisitionProof: proof("FXSAVE_ACQUISITION_RESULT", c, chain, { ...link, direct: true, tokenIn: "fxsave_settlement_asset", tokenOut: "fxsave_input_asset", amountPaid, unitsAcquired, conversionEvidence: conversion(amountPaid, unitsAcquired, c, chain) }),
        redeemProof: proof("FXSAVE_REDEEM_RESULT", c, chain, { ...link, emptyRoute: true, publicRedeemCommitment: row.mechanismFacts.publicRedeem.commitment, tokenIn: "fxsave_input_asset", tokenOut: "fxsave_raw_identity_token", unitsRedeemed, rawUnitsReceived, conversionEvidence: conversion(unitsRedeemed, rawUnitsReceived, c, chain) }),
        unwindProof: proof("FXSAVE_UNWIND_RESULT", c, chain, { ...link, direct: true, tokenIn: "fxsave_raw_identity_token", tokenOut: "fxsave_settlement_asset", rawUnitsIn, settlementProceeds, conversionEvidence: conversion(rawUnitsIn, settlementProceeds, c, chain) })
      }
    };
    sealSampleAmounts(sample); return sample;
  });
  return row;
}

function authorityObservation(chainId) {
  const base = state(chainId);
  const observers = MANIFEST.observerClasses.map((classPayload) => seal({
    exact: true, finalized: true, requireCanonical: true, ...base, classPayload: structuredClone(classPayload),
    classCommitment: hash("OBSERVER_CLASS_V2", classPayload)
  }, "OBSERVER_ATTESTATION_V2"));
  const terminal = seal({
    exact: true, complete: true, finalized: true, requireCanonical: true, ...base,
    observerCommitments: observers.map((row) => row.commitment), classCommitments: observers.map((row) => row.classCommitment)
  }, "TERMINAL_RECHECK_V2");
  return { timestamp: "1700000000", eip1898: true, finalized: true, requireCanonical: true, ...base, observers, terminalRecheck: terminal };
}
function inputLineagePayload(value) {
  const authority = Object.fromEntries(Object.entries(value.authority).filter(([key]) => key !== "inputLineageCommitment"));
  return { classifierVersionDomain: VERSION, authority, candidates: value.candidates };
}
function rebindInput(value, refresh = true) {
  if (refresh) refreshSeals(value);
  for (const candidate of value.candidates) for (const sample of candidate.samples || []) sealSampleAmounts(sample);
  value.authority.inputLineageCommitment = hash("INPUT_LINEAGE_V2", inputLineagePayload(value));
  return value;
}
function fixture() {
  const value = {
    authority: {
      mode: "OFFLINE_REVIEWED_FIXTURE_ONLY", fixtureOnly: true, captureEnabled: false,
      reviewedManifest: structuredClone(MANIFEST), manifestCommitment, runIdentity: "fixture_run_identity_primary_r2",
      observations: classifier.CHAIN_IDS.map(authorityObservation)
    },
    candidates: [cometCandidate(), erc4626Candidate(), fxsaveCandidate()]
  };
  return rebindInput(value);
}
const run = (mutate = () => {}, refresh = true) => { const value = fixture(); mutate(value); if (refresh) rebindInput(value); return classifier.runClassifier(value); };

test("content-addressed reviewed fixture classifies all three positive routes WATCH_SHADOW_ONLY", () => {
  assert.equal(Object.hasOwn(classifier, "REVIEWED_FIXTURE_AUTHORITY"), false);
  const result = run();
  assert.deepEqual(result.counts, { submitted: 3, WATCH_SHADOW_ONLY: 3, REJECT: 0, INCOMPLETE: 0 });
  assert.equal(result.gates.authorityMode, "VALIDATED_FIXTURE_ONLY");
  assert.equal(result.gates.routePositive, "unknown");
  assert.equal(result.gates.executableNow, "unknown");
  assert.equal(result.gates.forkEligible, false);
  assert.equal(result.gates.automaticPromotion, false);
  assert.equal(result.gates.signedActionJustified, false);
});

test("manifest content is immutable and self-asserted flags cannot fabricate validity", () => {
  assert.equal(run((value) => { value.authority.reviewedManifest.schema = "fabricated_manifest"; }).counts.REJECT, 3);
  assert.equal(run((value) => { value.authority.reviewedManifest.schema = "fabricated_manifest"; value.authority.manifestCommitment = hash("REVIEWED_MANIFEST_V2", value.authority.reviewedManifest); }).counts.REJECT, 3);
  assert.equal(run((value) => { value.authority.reviewedManifest.schema = "fabricated_manifest"; value.authority.reviewedManifestValidated = true; }).counts.REJECT, 3);
});

test("proof and binding commitments are recomputed from canonical payloads", () => {
  const staleProof = fixture();
  staleProof.candidates[0].mechanismFacts.reserveState.collateralInventory.amount = "99";
  staleProof.authority.inputLineageCommitment = hash("INPUT_LINEAGE_V2", inputLineagePayload(staleProof));
  const proofResult = classifier.runClassifier(staleProof);
  assert.equal(proofResult.counts.REJECT, 1);
  assert.equal(run((value) => { value.candidates[0].bindings.runtime.bindingPayload.revision = "fabricated"; }).counts.REJECT, 1);
  assert.equal(run((value) => { value.authority.observations[0].observers[0].classPayload.identity = "fabricated_identity"; }).counts.REJECT, 3);
});

test("Comet signed reserves allow negative and target-minus-one but reject target and higher", () => {
  const setReserves = (value, amount) => { value.candidates[0].mechanismFacts.reserveState.baseReserves.amount = String(amount); };
  assert.equal(run((value) => setReserves(value, -1)).counts.WATCH_SHADOW_ONLY, 3);
  assert.equal(run((value) => setReserves(value, 499)).counts.WATCH_SHADOW_ONLY, 3);
  assert.equal(run((value) => setReserves(value, 500)).counts.REJECT, 1);
  assert.equal(run((value) => setReserves(value, 501)).counts.REJECT, 1);
});

test("zero and negative conservative net reject after complete normalized costs", () => {
  const zero = run((value) => {
    value.candidates[0].samples[0].costs.find((row) => row.name === "fees").value.amount = "13";
  });
  assert.equal(zero.counts.REJECT, 1);
  const negative = run((value) => {
    value.candidates[1].samples[0].costs.find((row) => row.name === "fees").value.amount = "14";
  });
  assert.equal(negative.counts.REJECT, 1);
  assert.equal(run((value) => { value.candidates[0].samples[0].costs.find((row) => row.name === "competition").value.amount = "0"; }).counts.REJECT, 1);
  assert.equal(run((value) => { value.candidates[0].samples[0].costs.find((row) => row.name === "uncertainty").value.amount = "0"; }).counts.REJECT, 1);
});

test("every monetary value requires denomination, decimals, scale, observation, and valuation basis", () => {
  const valid = fixture();
  assert.equal(valid.candidates[0].samples[0].acquisition.decimals, 6);
  assert.equal(valid.candidates[0].samples[0].size.decimals, 8);
  assert.equal(valid.candidates[1].samples[0].size.decimals, 18);
  const mutations = [
    (value) => { delete value.candidates[0].samples[0].proceeds.assetRef; },
    (value) => { value.candidates[0].samples[0].proceeds.settlementAssetRef = "other_settlement"; },
    (value) => { value.candidates[0].samples[0].proceeds.decimals = 8; },
    (value) => { value.candidates[0].samples[0].proceeds.scale = "100000000"; },
    (value) => { value.candidates[0].samples[0].proceeds.valuationBasisCommitment = "fabricated_basis"; },
    (value) => { value.candidates[0].samples[0].proceeds.observationBinding.stateCommitment = "mixed_state"; },
    (value) => { delete value.candidates[0].samples[0].costs.find((row) => row.name === "fees").value; },
    (value) => { value.candidates[0].samples[0].mechanismResult.buyQuote.collateralReceived.scale = "1000000000000000000"; },
    (value) => { value.candidates[1].samples[0].mechanismResult.acquisitionQuote.sharesOut.assetRef = "vault_underlying_asset"; },
    (value) => { delete value.candidates[0].samples[0].mechanismResult.buyQuote.conversionEvidence; },
    (value) => { value.candidates[0].samples[0].mechanismResult.unwindQuote.conversionEvidence.rounding = "UP"; },
    (value) => { delete value.candidates[2].samples[0].mechanismResult.redeemProof.conversionEvidence.numerator; }
  ];
  for (const mutate of mutations) {
    const result = run(mutate);
    assert.equal(result.counts.REJECT + result.counts.INCOMPLETE, 1);
  }
});

test("each mechanism fails closed on omitted or bad normalized proof", () => {
  assert.equal(run((value) => { delete value.candidates[0].mechanismFacts.reserveState; }).counts.INCOMPLETE, 1);
  assert.equal(run((value) => { value.candidates[0].mechanismFacts.publicUnwind.public = false; }).counts.REJECT, 1);
  assert.equal(run((value) => { value.candidates[0].samples[0].mechanismResult.transferDeltas.collateralAssetIn.amount = "9"; }).counts.REJECT, 1);
  assert.equal(run((value) => { value.candidates[1].mechanismFacts.transferableShares = false; }).counts.REJECT, 1);
  assert.equal(run((value) => { value.candidates[1].mechanismFacts.redemptionState.maxRedeem.amount = "29"; }).counts.REJECT, 1);
  assert.equal(run((value) => { value.candidates[1].samples[0].mechanismResult.actorDelta.underlyingIn.amount = "29"; }).counts.REJECT, 1);
  assert.equal(run((value) => { delete value.candidates[2].mechanismFacts.fxBindings.selector; }).counts.INCOMPLETE, 1);
  assert.equal(run((value) => { value.candidates[2].mechanismFacts.ambientInventory.attackerFunded = true; }).counts.REJECT, 1);
  assert.equal(run((value) => { value.candidates[2].mechanismFacts.identityProof.discrepancy = false; }).counts.REJECT, 1);
});

test("fxSAVE caller, beneficiary, deployment, facet, selector, observation, token, and amount substitutions reject", () => {
  const mutations = [
    (value) => { value.candidates[2].samples[0].mechanismResult.acquisitionProof.callerCommitment = "other_caller"; },
    (value) => { value.candidates[2].samples[0].mechanismResult.redeemProof.beneficiaryCommitment = "other_beneficiary"; },
    (value) => { value.candidates[2].samples[0].mechanismResult.unwindProof.deploymentCommitment = "other_deployment"; },
    (value) => { value.candidates[2].mechanismFacts.identityProof.facetCommitment = "other_facet"; },
    (value) => { value.candidates[2].mechanismFacts.publicRedeem.selectorCommitment = "other_selector"; },
    (value) => { value.candidates[2].samples[0].mechanismResult.redeemProof.observationBinding.bundleCommitment = "other_bundle"; },
    (value) => { value.candidates[2].mechanismFacts.publicAcquisition.tokenOut = "other_input"; },
    (value) => { value.candidates[2].mechanismFacts.publicRedeem.tokenOut = "other_raw"; },
    (value) => { value.candidates[2].mechanismFacts.ambientInventory.rawTokenRef = "other_raw"; },
    (value) => { value.candidates[2].mechanismFacts.publicUnwind.tokenIn = "other_raw"; },
    (value) => { value.candidates[2].samples[0].mechanismResult.acquisitionProof.amountPaid.amount = "9"; },
    (value) => { value.candidates[2].samples[0].mechanismResult.redeemProof.rawUnitsReceived.amount = "9"; },
    (value) => { value.candidates[2].samples[0].mechanismResult.unwindProof.settlementProceeds.amount = "29"; },
    (value) => { value.candidates[2].samples[0].mechanismResult.acquisitionProof.converterSourceCommitment = "other_converter_source"; },
    (value) => { delete value.candidates[2].samples[0].mechanismResult.redeemProof.converterRuntimeCommitment; },
    (value) => { value.candidates[2].mechanismFacts.publicUnwind.converterRuntimeCommitment = value.candidates[2].mechanismFacts.fxBindings.converterSource.commitment; },
    (value) => { value.candidates[2].mechanismFacts.publicAcquisition.direct = false; },
    (value) => { value.candidates[2].mechanismFacts.publicUnwind.direct = false; },
    (value) => { value.candidates[2].samples[0].mechanismResult.acquisitionProof.direct = false; },
    (value) => { value.candidates[2].samples[0].mechanismResult.unwindProof.direct = false; },
    (value) => { value.candidates[2].samples[0].mechanismResult.redeemProof.emptyRoute = false; },
    (value) => { delete value.candidates[2].samples[0].mechanismResult.redeemProof.emptyRoute; },
    (value) => { value.candidates[2].samples[0].mechanismResult.redeemProof.publicRedeemCommitment = "substituted_public_redeem_commitment"; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).counts.REJECT, 1);
});

test("economicsEvaluated requires at least one candidate to complete all three samples", () => {
  const early = run((value) => {
    value.candidates = [value.candidates[0]];
    value.candidates[0].venue = "UNKNOWN_VENUE";
  });
  assert.equal(early.counts.REJECT, 1);
  assert.equal(early.gates.economicsEvaluated, false);
  const completedReject = run((value) => {
    value.candidates = [value.candidates[0]];
    value.candidates[0].samples[0].costs.find((row) => row.name === "fees").value.amount = "13";
  });
  assert.equal(completedReject.counts.REJECT, 1);
  assert.equal(completedReject.gates.economicsEvaluated, true);
});

test("observer and terminal state mixing plus unknown scope reject globally", () => {
  assert.equal(run((value) => { value.authority.observations[0].observers[1].stateCommitment = "mixed_state"; }).counts.REJECT, 3);
  assert.equal(run((value) => { value.authority.observations[0].terminalRecheck.classCommitments[1] = value.authority.observations[0].terminalRecheck.classCommitments[0]; }).counts.REJECT, 3);
  assert.equal(run((value) => { value.candidates[0].chainId = 10; }).counts.REJECT, 1);
  assert.equal(run((value) => { value.candidates[0].mechanism = "UNKNOWN_MECHANISM"; }).counts.REJECT, 1);
  assert.equal(run((value) => { value.candidates[0].venue = "GENERIC_VENUE"; }).counts.REJECT, 1);
});

test("all forbidden components reject; target-specific public flash proof never enables execution", () => {
  for (const name of classifier.FORBIDDEN_COMPONENTS) assert.equal(run((value) => { value.candidates[0].components[name] = true; }).counts.REJECT, 1);
  assert.equal(run((value) => { value.candidates[0].components.flashFunding = true; }).counts.REJECT, 1);
  const allowed = run((value) => {
    const row = value.candidates[0]; row.components.flashFunding = true;
    row.flashCallbackProof = proof("FLASH_CALLBACK_PROOF", row.candidateCommitment, row.chainId, { targetSpecific: true, public: true });
  });
  assert.equal(allowed.counts.WATCH_SHADOW_ONLY, 3);
  assert.equal(allowed.gates.executableNow, "unknown");
});

test("caps and hostile structures fail closed before recursive getter invocation", () => {
  let reached = false;
  const input = fixture();
  const hostile = {}; Object.defineProperty(hostile, "nested", { enumerable: true, get() { reached = true; throw new Error("unreachable"); } });
  input.candidates = Array.from({ length: classifier.MAX_CANDIDATES + 1 }, () => ({})); input.candidates[0] = hostile;
  assert.equal(classifier.runClassifier(input).counts.REJECT, 25); assert.equal(reached, false);
  const perChain = fixture(); perChain.candidates = Array.from({ length: classifier.MAX_PER_CHAIN + 1 }, cometCandidate); rebindInput(perChain);
  assert.equal(classifier.runClassifier(perChain).counts.REJECT, 9);
  let getterReached = false; const accessor = fixture();
  Object.defineProperty(accessor.candidates[0], "hostile", { enumerable: true, get() { getterReached = true; throw new Error("unreachable"); } });
  assert.equal(classifier.runClassifier(accessor).counts.REJECT, 3); assert.equal(getterReached, false);
  let proxyReached = false; const proxied = fixture(); proxied.candidates[0] = new Proxy({}, { get() { proxyReached = true; throw new Error("unreachable"); } });
  assert.equal(classifier.runClassifier(proxied).counts.REJECT, 3); assert.equal(proxyReached, false);
});

test("verified lineage and run identity domain-separate equal-count aggregate commitments", () => {
  const first = run();
  const second = run((value) => { value.authority.runIdentity = "fixture_run_identity_secondary_r2"; });
  assert.deepEqual(first.counts, second.counts);
  assert.notEqual(first.commitments.aggregateResult, second.commitments.aggregateResult);
  const stale = fixture(); stale.authority.runIdentity = "mutated_without_lineage_refresh";
  const staleResult = classifier.runClassifier(stale);
  assert.equal(staleResult.counts.REJECT, 3);
  assert.equal(staleResult.gates.authorityMode, "UNVALIDATED_FIXTURE_ONLY");
});

test("sanitizer and output preserve aggregate privacy and closed gates", () => {
  for (const value of [{ url: "x" }, { safe: "https://example.invalid" }, { providerLabel: "x" }, { rawQuote: "x" }, { address: "x" }, { sourcePath: "x" }])
    assert.throws(() => classifier.assertSanitized(value), classifier.ClassifierError);
  const result = run(), text = JSON.stringify(result);
  assert.equal(/candidate_|comet_|erc4626_|fxsave_|asset|venue|mechanism|observer_|terminal_|bundle_|state_|block|amount|quote|provider|sourcePath|https?:|0x[0-9a-f]{40}/iu.test(text), false);
  assert.deepEqual(Object.keys(result.commitments), ["aggregateResult"]);
  assert.equal(result.gates.routePositive, "unknown"); assert.equal(result.gates.executableNow, "unknown");
  assert.equal(result.gates.forkEligible, false); assert.equal(result.gates.automaticPromotion, false); assert.equal(result.gates.signedActionJustified, false);
});

test("unexpected errors return fail-closed aggregate result", () => {
  const original = Object.getPrototypeOf; let result;
  try { Object.getPrototypeOf = () => { throw new Error("synthetic"); }; result = classifier.runClassifier(fixture()); }
  finally { Object.getPrototypeOf = original; }
  assert.equal(result.counts.REJECT, 3); assert.equal(result.gates.economicsEvaluated, false);
});
