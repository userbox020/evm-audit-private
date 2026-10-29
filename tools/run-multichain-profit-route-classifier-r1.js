"use strict";

const crypto = require("node:crypto");
const { types: utilTypes } = require("node:util");

const CHAIN_IDS = Object.freeze([1, 8453, 42161]);
const MECHANISMS = Object.freeze(["COMET_RESERVE_BUYCOLLATERAL", "ERC4626_SHARE_DISCOUNT_REDEEM", "FXSAVE_EMPTY_ROUTE_IDENTITY"]);
const MAX_CANDIDATES = 24;
const MAX_PER_CHAIN = 8;
const SAMPLE_COUNT = 3;
const COST_NAMES = Object.freeze(["fees", "slippage", "gas", "financing", "latency", "competition", "uncertainty", "approvals"]);
const FORBIDDEN_COMPONENTS = Object.freeze(["liquidation", "victim", "orderflow", "sandwich", "bridge", "queue", "cooldown", "receipt", "privateExecutor", "genericRouter"]);
const VENUES = Object.freeze({
  COMET_RESERVE_BUYCOLLATERAL: "COMET_TARGET_SPECIFIC_PUBLIC_RESERVE_VENUE",
  ERC4626_SHARE_DISCOUNT_REDEEM: "TARGET_SPECIFIC_PUBLIC_ERC4626_SHARE_VENUE",
  FXSAVE_EMPTY_ROUTE_IDENTITY: "FXSAVE_TARGET_SPECIFIC_PUBLIC_IDENTITY_ROUTE"
});
const INPUT_BUDGET = Object.freeze({ nodes: 12000, properties: 60000, arrayItems: 4096, stringCharacters: 600000, depth: 24 });
const CLASSIFIER_VERSION_DOMAIN = "MULTICHAIN_PROFIT_ROUTE_CLASSIFIER_R1_CONTENT_ADDRESSED_V2";
const REVIEWED_MANIFEST = Object.freeze({
  schema: "multichain-profit-route-reviewed-fixture-manifest-v2",
  chains: Object.freeze({
    1: Object.freeze({ chainId: 1, pinIdentity: "reviewed_chain_1_canonical_pin_r2" }),
    8453: Object.freeze({ chainId: 8453, pinIdentity: "reviewed_chain_8453_canonical_pin_r2" }),
    42161: Object.freeze({ chainId: 42161, pinIdentity: "reviewed_chain_42161_canonical_pin_r2" })
  }),
  observerClasses: Object.freeze([
    Object.freeze({ classId: "class_alpha", identity: "reviewed_independent_observer_identity_alpha_r2" }),
    Object.freeze({ classId: "class_beta", identity: "reviewed_independent_observer_identity_beta_r2" })
  ]),
  assets: Object.freeze({
    comet_base_asset: Object.freeze({ assetRef: "comet_base_asset", decimals: 6, scale: "1000000" }),
    comet_collateral_asset: Object.freeze({ assetRef: "comet_collateral_asset", decimals: 8, scale: "100000000" }),
    vault_underlying_asset: Object.freeze({ assetRef: "vault_underlying_asset", decimals: 6, scale: "1000000" }),
    vault_share_asset: Object.freeze({ assetRef: "vault_share_asset", decimals: 18, scale: "1000000000000000000" }),
    fxsave_settlement_asset: Object.freeze({ assetRef: "fxsave_settlement_asset", decimals: 6, scale: "1000000" }),
    fxsave_input_asset: Object.freeze({ assetRef: "fxsave_input_asset", decimals: 18, scale: "1000000000000000000" }),
    fxsave_raw_identity_token: Object.freeze({ assetRef: "fxsave_raw_identity_token", decimals: 8, scale: "100000000" })
  }),
  candidates: Object.freeze({
    COMET_RESERVE_BUYCOLLATERAL: Object.freeze({ lineageId: "reviewed_comet_fixture_lineage_r2", allowedChains: Object.freeze([1, 8453, 42161]), venue: VENUES.COMET_RESERVE_BUYCOLLATERAL }),
    ERC4626_SHARE_DISCOUNT_REDEEM: Object.freeze({ lineageId: "reviewed_erc4626_fixture_lineage_r2", allowedChains: Object.freeze([1, 8453, 42161]), venue: VENUES.ERC4626_SHARE_DISCOUNT_REDEEM }),
    FXSAVE_EMPTY_ROUTE_IDENTITY: Object.freeze({ lineageId: "reviewed_fxsave_fixture_lineage_r2", allowedChains: Object.freeze([1]), venue: VENUES.FXSAVE_EMPTY_ROUTE_IDENTITY })
  }),
  bindings: Object.freeze(Object.fromEntries(MECHANISMS.map((mechanism) => [mechanism, Object.freeze(Object.fromEntries(
    ["source", "runtime", "factory", "asset", "venue"].map((name) => [name, Object.freeze({ mechanism, bindingKind: name, revision: "reviewed_r2" })])
  ))]))),
  fxsaveBindings: Object.freeze(Object.fromEntries(["deployment", "facet", "selector", "converterSource", "converterRuntime"].map((name) => [name, Object.freeze({ unit: name, revision: "reviewed_fxsave_r2" })])))
});
// Independently reviewed content address for REVIEWED_MANIFEST; module load verifies it below.
const EXPECTED_REVIEWED_MANIFEST_COMMITMENT = "c_013ef3aab85fb24b22f0f8355f4e62b77e923a39bc351f084d5b40937b03d9ff";

class ClassifierError extends Error {
  constructor(code, kind = "INCOMPLETE") { super(code); this.name = "ClassifierError"; this.code = code; this.kind = kind; }
}
const stop = (code, kind = "INCOMPLETE") => { throw new ClassifierError(code, kind); };
const own = (value, key) => Boolean(value && typeof value === "object" && Object.hasOwn(value, key));

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) stop("NONFINITE_NUMBER");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") stop("NONCANONICAL_VALUE");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function contentHash(domain, payload) {
  return `c_${crypto.createHash("sha256").update(canonical({ domain, payload })).digest("hex")}`;
}
const MODULE_REVIEWED_MANIFEST_COMMITMENT = contentHash("REVIEWED_MANIFEST_V2", REVIEWED_MANIFEST);
if (MODULE_REVIEWED_MANIFEST_COMMITMENT !== EXPECTED_REVIEWED_MANIFEST_COMMITMENT) throw new Error("REVIEWED_MANIFEST_MODULE_INTEGRITY_FAILURE");

function withoutCommitment(row) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "commitment"));
}
function verifyContentCommitment(row, domain, code) {
  if (!row || typeof row !== "object") stop(`${code}_MISSING`);
  if (row.commitmentDomain !== domain) stop(`${code}_DOMAIN_MISMATCH`, "REJECT");
  const expected = contentHash(domain, withoutCommitment(row));
  if (row.commitment !== expected) stop(`${code}_CONTENT_COMMITMENT_MISMATCH`, "REJECT");
  return expected;
}

const FORBIDDEN_KEYS = /^(?:url|urls|domain|hostname|endpoint|endpoints|provider|providers|providerLabel|family|families|operatorFamily|headers?|authorization|credential|credentials|apiKey|token|secret|password|rawRpc|rawResponse|rawQuote|rawQuotePayload|calldata|address|addresses|blockHash|stateRoot|transactionHash|txHash|sourcePath|sourcePaths|path|paths)$/iu;
function assertSanitized(value) {
  const seen = new Set();
  function visit(current) {
    if (typeof current === "string") {
      if (/(?:https?|wss?):\/\//iu.test(current)) stop("FORBIDDEN_URL", "REJECT");
      if (/^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u.test(current)) stop("FORBIDDEN_HEX_IDENTIFIER", "REJECT");
      if (/\b(?:[a-z0-9-]+\.)+(?:com|io|org|net|xyz|cloud|dev|pro)\b/iu.test(current)) stop("FORBIDDEN_DOMAIN", "REJECT");
      if (/^(?:Bearer|Basic)\s+/iu.test(current)) stop("FORBIDDEN_CREDENTIAL", "REJECT");
      return;
    }
    if (current === null || typeof current === "boolean" || typeof current === "number") return;
    if (!current || typeof current !== "object" || seen.has(current)) stop("UNSANITIZED_VALUE", "REJECT");
    seen.add(current);
    if (Array.isArray(current)) for (const item of current) visit(item);
    else for (const [key, item] of Object.entries(current)) {
      if (FORBIDDEN_KEYS.test(key)) stop("FORBIDDEN_FIELD", "REJECT");
      visit(item);
    }
    seen.delete(current);
  }
  visit(value);
  return true;
}

function requiredBoolean(object, key, code) {
  if (!own(object, key) || typeof object[key] !== "boolean") stop(code);
  return object[key];
}
function exactTrue(object, key, code) {
  if (requiredBoolean(object, key, `${code}_MISSING`) !== true) stop(code, "REJECT");
}
function exactFalse(object, key, code) {
  if (requiredBoolean(object, key, `${code}_MISSING`) !== false) stop(code, "REJECT");
}
function opaque(value, code) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{2,95}$/u.test(value)) stop(code);
  return value;
}
function uint(value, code) {
  if (typeof value === "string" && /^-[0-9]+$/u.test(value)) stop(code, "REJECT");
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) stop(code);
  return BigInt(value);
}
function validateExpectedCommitment(value, expected, code) {
  opaque(value, `${code}_INVALID`);
  if (value !== expected) stop(`${code}_UNAUTHORIZED`, "REJECT");
}

function plainDataObject(value, code) {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value)) stop(code, "REJECT");
  const expectedPrototype = Array.isArray(value) ? Array.prototype : Object.prototype;
  if (Object.getPrototypeOf(value) !== expectedPrototype) stop(code, "REJECT");
  return value;
}
function dataProperty(object, key, code) {
  plainDataObject(object, code);
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return undefined;
  if (!own(descriptor, "value")) stop(code, "REJECT");
  return descriptor.value;
}
function boundedArrayProperty(object, key, cap, code) {
  const value = dataProperty(object, key, code);
  if (value === undefined) return undefined;
  plainDataObject(value, code);
  if (!Array.isArray(value)) stop(code, "REJECT");
  if (value.length > cap) stop(`${code}_CAP_EXCEEDED`, "REJECT");
  return value;
}

function candidateDataAt(candidates, index) {
  const descriptor = Object.getOwnPropertyDescriptor(candidates, String(index));
  if (!descriptor || !own(descriptor, "value")) stop("CANDIDATE_ARRAY_ACCESSOR_OR_HOLE", "REJECT");
  return descriptor.value;
}

function shallowBounds(input) {
  plainDataObject(input, "INPUT_NOT_PLAIN_DATA");
  const candidates = boundedArrayProperty(input, "candidates", MAX_CANDIDATES, "CANDIDATES_SHALLOW_INVALID");
  if (!candidates) stop("CANDIDATES_MISSING");
  const chainCounts = new Map();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidateDataAt(candidates, index);
    plainDataObject(candidate, "CANDIDATE_SHALLOW_INVALID");
    const chainId = dataProperty(candidate, "chainId", "CANDIDATE_CHAIN_SHALLOW_INVALID");
    const count = (chainCounts.get(chainId) || 0) + 1;
    chainCounts.set(chainId, count);
    if (count > MAX_PER_CHAIN) stop("PER_CHAIN_CANDIDATE_CAP_EXCEEDED", "REJECT");
    const samples = boundedArrayProperty(candidate, "samples", SAMPLE_COUNT, "SAMPLES_SHALLOW_INVALID");
    if (samples) for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
      const sample = candidateDataAt(samples, sampleIndex);
      plainDataObject(sample, "SAMPLE_SHALLOW_INVALID");
      boundedArrayProperty(sample, "costs", COST_NAMES.length, "COSTS_SHALLOW_INVALID");
    }
  }
  const authority = dataProperty(input, "authority", "AUTHORITY_SHALLOW_INVALID");
  if (authority && typeof authority === "object") {
    const observations = boundedArrayProperty(authority, "observations", CHAIN_IDS.length, "OBSERVATIONS_SHALLOW_INVALID");
    if (observations) for (let index = 0; index < observations.length; index += 1) {
      const observation = candidateDataAt(observations, index);
      plainDataObject(observation, "OBSERVATION_SHALLOW_INVALID");
      boundedArrayProperty(observation, "observers", 2, "OBSERVERS_SHALLOW_INVALID");
      const terminal = dataProperty(observation, "terminalRecheck", "TERMINAL_SHALLOW_INVALID");
      if (terminal && typeof terminal === "object") {
        boundedArrayProperty(terminal, "observerCommitments", 2, "TERMINAL_OBSERVERS_SHALLOW_INVALID");
        boundedArrayProperty(terminal, "classCommitments", 2, "TERMINAL_CLASSES_SHALLOW_INVALID");
      }
    }
  }
  return candidates;
}

function validateBoundedPlainGraph(root) {
  const stack = [{ value: root, depth: 0 }], seen = new Set();
  let nodes = 0, properties = 0, arrayItems = 0, stringCharacters = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop();
    if (typeof value === "string") {
      stringCharacters += value.length;
      if (stringCharacters > INPUT_BUDGET.stringCharacters) stop("INPUT_STRING_BUDGET_EXCEEDED", "REJECT");
      continue;
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") continue;
    if (!value || typeof value !== "object") stop("INPUT_VALUE_NOT_PLAIN_DATA", "REJECT");
    plainDataObject(value, "INPUT_OBJECT_NOT_PLAIN_DATA");
    if (seen.has(value)) stop("INPUT_GRAPH_ALIAS_OR_CYCLE", "REJECT");
    seen.add(value);
    nodes += 1;
    if (nodes > INPUT_BUDGET.nodes || depth > INPUT_BUDGET.depth) stop("INPUT_GRAPH_BUDGET_EXCEEDED", "REJECT");
    if (Array.isArray(value)) {
      arrayItems += value.length;
      if (arrayItems > INPUT_BUDGET.arrayItems) stop("INPUT_ARRAY_BUDGET_EXCEEDED", "REJECT");
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) stop("INPUT_SYMBOL_PROPERTY_FORBIDDEN", "REJECT");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const descriptor of Object.values(descriptors)) if (!own(descriptor, "value")) stop("INPUT_ACCESSOR_FORBIDDEN", "REJECT");
    const keys = Object.keys(value);
    properties += keys.length;
    if (properties > INPUT_BUDGET.properties) stop("INPUT_PROPERTY_BUDGET_EXCEEDED", "REJECT");
    for (const key of keys) stack.push({ value: descriptors[key].value, depth: depth + 1 });
  }
}

function validateObservationBinding(binding, candidateCommitment, observation, code) {
  if (!binding || typeof binding !== "object") stop(`${code}_OBSERVATION_BINDING_MISSING`);
  exactTrue(binding, "exact", `${code}_OBSERVATION_BINDING_NOT_EXACT`);
  if (binding.candidateCommitment !== candidateCommitment || binding.chainId !== observation.chainId
      || binding.blockNumber !== observation.blockNumber || binding.stateCommitment !== observation.stateCommitment
      || binding.pinCommitment !== observation.pinCommitment || binding.bundleCommitment !== observation.bundleCommitment) stop(`${code}_OBSERVATION_BINDING_MISMATCH`, "REJECT");
}
function validateProof(proof, code, candidateCommitment, observation) {
  if (!proof || typeof proof !== "object") stop(`${code}_MISSING`);
  verifyContentCommitment(proof, `PROOF_${code}_V2`, code);
  exactTrue(proof, "exact", `${code}_NOT_EXACT`);
  exactTrue(proof, "success", `${code}_FAILED`);
  exactFalse(proof, "reverted", `${code}_REVERTED`);
  opaque(proof.commitment, `${code}_COMMITMENT_INVALID`);
  validateObservationBinding(proof.observationBinding, candidateCommitment, observation, code);
}

function inputLineagePayload(input) {
  const authority = Object.fromEntries(Object.entries(input.authority).filter(([key]) => key !== "inputLineageCommitment"));
  return { classifierVersionDomain: CLASSIFIER_VERSION_DOMAIN, authority, candidates: input.candidates };
}

function validateAuthority(input) {
  const authority = input.authority;
  if (!authority || typeof authority !== "object") stop("AUTHORITY_MISSING");
  if (authority.mode !== "OFFLINE_REVIEWED_FIXTURE_ONLY" || authority.fixtureOnly !== true) stop("REAL_AUTHORITY_FORBIDDEN", "REJECT");
  exactFalse(authority, "captureEnabled", "CAPTURE_ENABLED");
  if (!authority.reviewedManifest || canonical(authority.reviewedManifest) !== canonical(REVIEWED_MANIFEST)) stop("REVIEWED_MANIFEST_CONTENT_MISMATCH", "REJECT");
  if (authority.manifestCommitment !== EXPECTED_REVIEWED_MANIFEST_COMMITMENT
      || contentHash("REVIEWED_MANIFEST_V2", authority.reviewedManifest) !== EXPECTED_REVIEWED_MANIFEST_COMMITMENT) stop("AUTHORITY_MANIFEST_CONTENT_ADDRESS_MISMATCH", "REJECT");
  const runIdentity = opaque(authority.runIdentity, "RUN_IDENTITY_INVALID");
  if (!Array.isArray(authority.observations) || authority.observations.length !== CHAIN_IDS.length) stop("CHAIN_OBSERVATIONS_NOT_EXACT", "REJECT");
  const observations = new Map();
  for (const observation of authority.observations) {
    if (!observation || typeof observation !== "object" || !CHAIN_IDS.includes(observation.chainId) || observations.has(observation.chainId)) stop("CHAIN_OBSERVATION_INVALID", "REJECT");
    if (!Number.isSafeInteger(observation.blockNumber) || observation.blockNumber <= 0) stop("BLOCK_NUMBER_INVALID");
    uint(observation.timestamp, "BLOCK_TIMESTAMP_INVALID");
    exactTrue(observation, "eip1898", "OBSERVATION_NOT_EIP1898");
    exactTrue(observation, "finalized", "OBSERVATION_NOT_FINALIZED");
    exactTrue(observation, "requireCanonical", "OBSERVATION_NOT_CANONICAL");
    const stateCommitment = opaque(observation.stateCommitment, "STATE_COMMITMENT_INVALID");
    const pinCommitment = opaque(observation.pinCommitment, "PIN_COMMITMENT_INVALID");
    if (pinCommitment !== contentHash("REVIEWED_PIN_V2", REVIEWED_MANIFEST.chains[observation.chainId])) stop("PIN_COMMITMENT_UNAUTHORIZED", "REJECT");
    const bundleCommitment = opaque(observation.bundleCommitment, "BUNDLE_COMMITMENT_INVALID");
    if (!Array.isArray(observation.observers) || observation.observers.length !== 2) stop("TWO_OBSERVERS_REQUIRED", "REJECT");
    const observerCommitments = new Set(), classCommitments = new Set();
    for (const observer of observation.observers) {
      if (!observer || typeof observer !== "object") stop("OBSERVER_MALFORMED");
      exactTrue(observer, "exact", "OBSERVER_NOT_EXACT");
      exactTrue(observer, "finalized", "OBSERVER_NOT_FINALIZED");
      exactTrue(observer, "requireCanonical", "OBSERVER_NOT_CANONICAL");
      if (observer.chainId !== observation.chainId || observer.blockNumber !== observation.blockNumber
          || observer.stateCommitment !== stateCommitment || observer.pinCommitment !== pinCommitment
          || observer.bundleCommitment !== bundleCommitment) stop("OBSERVER_STATE_MIX", "REJECT");
      const commitment = opaque(observer.commitment, "OBSERVER_COMMITMENT_INVALID");
      const classCommitment = opaque(observer.classCommitment, "OBSERVER_CLASS_INVALID");
      verifyContentCommitment(observer, "OBSERVER_ATTESTATION_V2", "OBSERVER_ATTESTATION");
      const reviewedClass = REVIEWED_MANIFEST.observerClasses.find((row) => row.classId === observer.classPayload?.classId);
      if (!reviewedClass || canonical(observer.classPayload) !== canonical(reviewedClass)
          || classCommitment !== contentHash("OBSERVER_CLASS_V2", reviewedClass)
          || observerCommitments.has(commitment) || classCommitments.has(classCommitment)) stop("OBSERVER_NOT_TWO_REVIEWED_CLASSES", "REJECT");
      observerCommitments.add(commitment);
      classCommitments.add(classCommitment);
    }
    const terminal = observation.terminalRecheck;
    if (!terminal || typeof terminal !== "object") stop("TERMINAL_RECHECK_MISSING");
    exactTrue(terminal, "exact", "TERMINAL_NOT_EXACT");
    exactTrue(terminal, "complete", "TERMINAL_INCOMPLETE");
    exactTrue(terminal, "finalized", "TERMINAL_NOT_FINALIZED");
    exactTrue(terminal, "requireCanonical", "TERMINAL_NOT_CANONICAL");
    if (terminal.chainId !== observation.chainId || terminal.blockNumber !== observation.blockNumber
        || terminal.stateCommitment !== stateCommitment || terminal.pinCommitment !== pinCommitment
        || terminal.bundleCommitment !== bundleCommitment) stop("TERMINAL_STATE_MIX", "REJECT");
    opaque(terminal.commitment, "TERMINAL_COMMITMENT_INVALID");
    verifyContentCommitment(terminal, "TERMINAL_RECHECK_V2", "TERMINAL_RECHECK");
    if (!Array.isArray(terminal.observerCommitments) || terminal.observerCommitments.length !== 2
        || new Set(terminal.observerCommitments).size !== 2 || terminal.observerCommitments.some((value) => !observerCommitments.has(value))) stop("TERMINAL_OBSERVER_BINDING_MISMATCH", "REJECT");
    if (!Array.isArray(terminal.classCommitments) || terminal.classCommitments.length !== 2
        || new Set(terminal.classCommitments).size !== 2 || terminal.classCommitments.some((value) => !classCommitments.has(value))) stop("TERMINAL_CLASS_BINDING_MISMATCH", "REJECT");
    observations.set(observation.chainId, { chainId: observation.chainId, blockNumber: observation.blockNumber, stateCommitment, pinCommitment, bundleCommitment });
  }
  const inputLineageCommitment = contentHash("INPUT_LINEAGE_V2", inputLineagePayload(input));
  if (authority.inputLineageCommitment !== inputLineageCommitment) stop("INPUT_LINEAGE_COMMITMENT_MISMATCH", "REJECT");
  const pinSetCommitment = contentHash("VERIFIED_PIN_SET_V2", [...observations.values()].sort((a, b) => a.chainId - b.chainId).map((row) => ({ chainId: row.chainId, pinCommitment: row.pinCommitment })));
  return { observations, manifestCommitment: EXPECTED_REVIEWED_MANIFEST_COMMITMENT, inputLineageCommitment, pinSetCommitment, runIdentity };
}

function validateBindings(candidate, candidateCommitment, observation) {
  const bindings = candidate.bindings;
  if (!bindings || typeof bindings !== "object") stop("CANDIDATE_BINDINGS_MISSING");
  const expected = REVIEWED_MANIFEST.bindings[candidate.mechanism];
  for (const name of ["source", "runtime", "factory", "asset", "venue"]) {
    const row = bindings[name];
    if (!row || typeof row !== "object") stop(`BINDING_${name.toUpperCase()}_MISSING`);
    verifyContentCommitment(row, `CANDIDATE_BINDING_${name.toUpperCase()}_V2`, `BINDING_${name.toUpperCase()}`);
    exactTrue(row, "exact", `BINDING_${name.toUpperCase()}_NOT_EXACT`);
    if (canonical(row.bindingPayload) !== canonical(expected[name])) stop(`BINDING_${name.toUpperCase()}_PAYLOAD_UNAUTHORIZED`, "REJECT");
    validateObservationBinding(row.observationBinding, candidateCommitment, observation, `BINDING_${name.toUpperCase()}`);
  }
}

function validateComponents(candidate, candidateCommitment, observation) {
  const components = candidate.components;
  if (!components || typeof components !== "object") stop("COMPONENTS_MISSING");
  for (const name of FORBIDDEN_COMPONENTS) exactFalse(components, name, `FORBIDDEN_COMPONENT_${name.toUpperCase()}`);
  const flashFunding = requiredBoolean(components, "flashFunding", "FLASH_FUNDING_FLAG_MISSING");
  if (flashFunding) {
    const callback = candidate.flashCallbackProof;
    if (!callback || typeof callback !== "object") stop("FLASH_CALLBACK_PROOF_REQUIRED", "REJECT");
    validateProof(callback, "FLASH_CALLBACK_PROOF", candidateCommitment, observation);
    exactTrue(callback, "targetSpecific", "FLASH_CALLBACK_NOT_TARGET_SPECIFIC");
    exactTrue(callback, "public", "FLASH_CALLBACK_NOT_PUBLIC");
  } else if (own(candidate, "flashCallbackProof")) stop("UNNEEDED_FLASH_CALLBACK_PROOF", "REJECT");
}

function validateEconomicsContext(candidate, candidateCommitment, observation) {
  const economics = candidate.economics;
  if (!economics || typeof economics !== "object") stop("ECONOMICS_CONTEXT_MISSING");
  verifyContentCommitment(economics, "ECONOMICS_CONTEXT_V2", "ECONOMICS_CONTEXT");
  const settlementAssetRef = opaque(economics.settlementAssetRef, "SETTLEMENT_ASSET_INVALID");
  const reviewedSettlement = REVIEWED_MANIFEST.assets[settlementAssetRef];
  if (!reviewedSettlement) stop("SETTLEMENT_ASSET_NOT_REVIEWED", "REJECT");
  if (!Number.isSafeInteger(economics.decimals) || economics.decimals < 0 || economics.decimals > 36) stop("SETTLEMENT_DECIMALS_INVALID", "REJECT");
  const scale = uint(economics.scale, "SETTLEMENT_SCALE_INVALID");
  if (scale !== 10n ** BigInt(economics.decimals) || economics.decimals !== reviewedSettlement.decimals || economics.scale !== reviewedSettlement.scale) stop("SETTLEMENT_SCALE_MISMATCH", "REJECT");
  const valuationBasisPayload = { kind: "EXACT_SETTLEMENT_ASSET_BASE_UNITS", settlementAssetRef, decimals: economics.decimals, scale: economics.scale };
  if (canonical(economics.valuationBasisPayload) !== canonical(valuationBasisPayload)
      || economics.valuationBasisCommitment !== contentHash("VALUATION_BASIS_V2", valuationBasisPayload)) stop("VALUATION_BASIS_BINDING_MISMATCH", "REJECT");
  validateObservationBinding(economics.observationBinding, candidateCommitment, observation, "ECONOMICS_CONTEXT");
  if (economics.assetRegistryCommitment !== contentHash("VERIFIER_ASSET_REGISTRY_V3", REVIEWED_MANIFEST.assets)) stop("ASSET_REGISTRY_BINDING_MISMATCH", "REJECT");
  return { settlementAssetRef, decimals: economics.decimals, scale, valuationBasisCommitment: economics.valuationBasisCommitment };
}

function settlementValue(value, economics, candidateCommitment, observation, code) {
  if (!value || typeof value !== "object") stop(`${code}_MONETARY_VALUE_MISSING`);
  verifyContentCommitment(value, "SETTLEMENT_VALUE_V3", `${code}_MONETARY_VALUE`);
  validateObservationBinding(value.observationBinding, candidateCommitment, observation, `${code}_MONETARY_VALUE`);
  if (value.unitKind !== "SETTLEMENT_VALUE" || value.assetRef !== economics.settlementAssetRef || value.settlementAssetRef !== economics.settlementAssetRef
      || value.decimals !== economics.decimals || value.scale !== economics.scale.toString()
      || value.valuationBasisCommitment !== economics.valuationBasisCommitment) stop(`${code}_DENOMINATION_OR_BASIS_MISMATCH`, "REJECT");
  if (typeof value.amount !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value.amount)) stop(`${code}_AMOUNT_INVALID`, "REJECT");
  const raw = BigInt(value.amount);
  const valueScale = uint(value.scale, `${code}_SCALE_INVALID`);
  if (valueScale === 0n || (raw * economics.scale) % valueScale !== 0n) stop(`${code}_NORMALIZATION_INEXACT`, "REJECT");
  return (raw * economics.scale) / valueScale;
}

function tokenQuantity(value, expectedAssetRef, candidateCommitment, observation, code, signed = false) {
  if (!value || typeof value !== "object") stop(`${code}_TOKEN_QUANTITY_MISSING`);
  verifyContentCommitment(value, "TOKEN_QUANTITY_V3", `${code}_TOKEN_QUANTITY`);
  validateObservationBinding(value.observationBinding, candidateCommitment, observation, `${code}_TOKEN_QUANTITY`);
  const reviewedAsset = REVIEWED_MANIFEST.assets[expectedAssetRef];
  if (!reviewedAsset || value.unitKind !== "TOKEN_QUANTITY" || value.assetRef !== expectedAssetRef
      || value.decimals !== reviewedAsset.decimals || value.scale !== reviewedAsset.scale
      || value.assetUnitCommitment !== contentHash("ASSET_UNIT_V3", reviewedAsset)) stop(`${code}_ASSET_UNIT_MISMATCH`, "REJECT");
  const expression = signed ? /^-?(?:0|[1-9][0-9]*)$/u : /^(?:0|[1-9][0-9]*)$/u;
  if (typeof value.amount !== "string" || !expression.test(value.amount) || value.amount === "-0") stop(`${code}_AMOUNT_INVALID`, "REJECT");
  return BigInt(value.amount);
}

function validateConversion(evidence, sourceValue, destinationValue, candidateCommitment, observation, code) {
  if (!evidence || typeof evidence !== "object") stop(`${code}_CONVERSION_EVIDENCE_MISSING`);
  verifyContentCommitment(evidence, "CONVERSION_EVIDENCE_V3", `${code}_CONVERSION_EVIDENCE`);
  validateObservationBinding(evidence.observationBinding, candidateCommitment, observation, `${code}_CONVERSION_EVIDENCE`);
  exactTrue(evidence, "conservative", `${code}_CONVERSION_NOT_CONSERVATIVE`);
  if (evidence.rounding !== "DOWN") stop(`${code}_CONVERSION_ROUNDING_INVALID`, "REJECT");
  if (evidence.sourceCommitment !== sourceValue?.commitment || evidence.destinationCommitment !== destinationValue?.commitment
      || evidence.sourceAssetRef !== sourceValue?.assetRef || evidence.destinationAssetRef !== destinationValue?.assetRef
      || evidence.sourceScale !== sourceValue?.scale || evidence.destinationScale !== destinationValue?.scale) stop(`${code}_CONVERSION_BINDING_MISMATCH`, "REJECT");
  const numerator = uint(evidence.numerator, `${code}_CONVERSION_NUMERATOR_INVALID`);
  const denominator = uint(evidence.denominator, `${code}_CONVERSION_DENOMINATOR_INVALID`);
  if (numerator === 0n || denominator === 0n) stop(`${code}_CONVERSION_RATIO_ZERO`, "REJECT");
  const sourceAmount = uint(sourceValue.amount, `${code}_CONVERSION_SOURCE_AMOUNT_INVALID`);
  const destinationAmount = uint(destinationValue.amount, `${code}_CONVERSION_DESTINATION_AMOUNT_INVALID`);
  const sourceScale = uint(sourceValue.scale, `${code}_CONVERSION_SOURCE_SCALE_INVALID`);
  const destinationScale = uint(destinationValue.scale, `${code}_CONVERSION_DESTINATION_SCALE_INVALID`);
  const expectedDestination = (sourceAmount * numerator * destinationScale) / (denominator * sourceScale);
  if (destinationAmount !== expectedDestination) stop(`${code}_CONVERSION_VALUE_MISMATCH`, "REJECT");
}

function validateCosts(rows, economics, candidateCommitment, observation) {
  if (!Array.isArray(rows)) stop("COSTS_MISSING");
  const names = new Set();
  let total = 0n;
  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof row.name !== "string") stop("COST_ROW_MALFORMED");
    if (!COST_NAMES.includes(row.name) || names.has(row.name)) stop("COST_UNKNOWN_OR_DUPLICATE", "REJECT");
    names.add(row.name);
    exactTrue(row, "evidence", "COST_EVIDENCE_INVALID");
    exactTrue(row, "provenance", "COST_PROVENANCE_INVALID");
    const amount = settlementValue(row.value, economics, candidateCommitment, observation, `COST_${row.name.toUpperCase()}`);
    if (amount === 0n) stop("COST_ZERO_UNSUPPORTED", "REJECT");
    total += amount;
  }
  if (names.size !== COST_NAMES.length || COST_NAMES.some((name) => !names.has(name))) stop("COST_CATEGORY_OMITTED");
  return total;
}

function validateComet(candidate, sample, economics, candidateCommitment, observation, size, proceeds, acquisition) {
  const facts = candidate.mechanismFacts;
  if (!facts || typeof facts !== "object") stop("COMET_FACTS_MISSING");
  exactTrue(facts, "publicBuyPath", "COMET_BUY_PATH_NOT_PUBLIC");
  exactFalse(facts, "paused", "COMET_PAUSED");
  const base = opaque(facts.baseAssetRef, "COMET_BASE_ASSET_INVALID");
  const collateral = opaque(facts.collateralAssetRef, "COMET_COLLATERAL_ASSET_INVALID");
  if (base === collateral || facts.settlementAssetRef !== base) stop("COMET_ASSET_BINDING_INVALID", "REJECT");
  const reserve = facts.reserveState;
  validateProof(reserve, "COMET_RESERVE_STATE", candidateCommitment, observation);
  const baseReserves = tokenQuantity(reserve.baseReserves, base, candidateCommitment, observation, "COMET_BASE_RESERVES", true);
  const targetReserves = tokenQuantity(reserve.targetBaseReserves, base, candidateCommitment, observation, "COMET_TARGET_RESERVES");
  const inventory = tokenQuantity(reserve.collateralInventory, collateral, candidateCommitment, observation, "COMET_INVENTORY");
  const buyAllowed = baseReserves < 0n || (baseReserves >= 0n && baseReserves < targetReserves);
  if (!buyAllowed || inventory === 0n) stop("COMET_RESERVE_OR_INVENTORY_BOUND_FAILED", "REJECT");
  const bounds = facts.quoteBounds;
  validateProof(bounds, "COMET_QUOTE_BOUNDS", candidateCommitment, observation);
  const minimum = tokenQuantity(bounds.minimumCollateral, collateral, candidateCommitment, observation, "COMET_QUOTE_MINIMUM");
  const maximum = tokenQuantity(bounds.maximumCollateral, collateral, candidateCommitment, observation, "COMET_QUOTE_MAXIMUM");
  if (minimum === 0n || maximum < minimum || size < minimum || size > maximum || size > inventory) stop("COMET_QUOTE_BOUNDS_FAILED", "REJECT");
  const unwind = facts.publicUnwind;
  validateProof(unwind, "COMET_PUBLIC_UNWIND", candidateCommitment, observation);
  exactTrue(unwind, "public", "COMET_UNWIND_NOT_PUBLIC");
  exactTrue(unwind, "direct", "COMET_UNWIND_NOT_DIRECT");
  exactTrue(unwind, "targetSpecific", "COMET_UNWIND_NOT_TARGET_SPECIFIC");
  if (unwind.tokenIn !== collateral || unwind.tokenOut !== base) stop("COMET_UNWIND_ASSET_MISMATCH", "REJECT");
  const route = sample.mechanismResult;
  if (!route || typeof route !== "object") stop("COMET_SAMPLE_RESULT_MISSING");
  validateProof(route.buyQuote, "COMET_BUY_QUOTE", candidateCommitment, observation);
  if (settlementValue(route.buyQuote.basePaid, economics, candidateCommitment, observation, "COMET_BASE_PAID") !== acquisition
      || tokenQuantity(route.buyQuote.collateralReceived, collateral, candidateCommitment, observation, "COMET_COLLATERAL_RECEIVED") !== size) stop("COMET_BUY_QUOTE_AMOUNT_MISMATCH", "REJECT");
  validateConversion(route.buyQuote.conversionEvidence, route.buyQuote.basePaid, route.buyQuote.collateralReceived, candidateCommitment, observation, "COMET_BUY");
  validateProof(route.transferDeltas, "COMET_TRANSFER_DELTAS", candidateCommitment, observation);
  if (tokenQuantity(route.transferDeltas.baseAssetOut, base, candidateCommitment, observation, "COMET_BASE_DELTA") !== acquisition
      || tokenQuantity(route.transferDeltas.collateralAssetIn, collateral, candidateCommitment, observation, "COMET_COLLATERAL_DELTA") !== size) stop("COMET_TRANSFER_DELTA_MISMATCH", "REJECT");
  validateProof(route.unwindQuote, "COMET_UNWIND_QUOTE", candidateCommitment, observation);
  if (tokenQuantity(route.unwindQuote.collateralIn, collateral, candidateCommitment, observation, "COMET_UNWIND_INPUT") !== size
      || settlementValue(route.unwindQuote.baseProceeds, economics, candidateCommitment, observation, "COMET_UNWIND_PROCEEDS") !== proceeds) stop("COMET_UNWIND_AMOUNT_MISMATCH", "REJECT");
  validateConversion(route.unwindQuote.conversionEvidence, route.unwindQuote.collateralIn, route.unwindQuote.baseProceeds, candidateCommitment, observation, "COMET_UNWIND");
}

function validateErc4626(candidate, sample, economics, candidateCommitment, observation, size, proceeds, acquisition) {
  const facts = candidate.mechanismFacts;
  if (!facts || typeof facts !== "object") stop("ERC4626_FACTS_MISSING");
  const share = opaque(facts.shareAssetRef, "ERC4626_SHARE_ASSET_INVALID");
  const asset = opaque(facts.vaultAssetRef, "ERC4626_VAULT_ASSET_INVALID");
  const settlement = opaque(facts.settlementAssetRef, "ERC4626_SETTLEMENT_ASSET_INVALID");
  const exitRequired = asset !== settlement;
  if (share === asset) stop("ERC4626_SHARE_EQUALS_ASSET", "REJECT");
  exactTrue(facts, "transferableShares", "ERC4626_SHARES_NOT_TRANSFERABLE");
  exactTrue(facts, "standardTransfer", "ERC4626_TRANSFER_NONSTANDARD");
  validateProof(facts.transferProof, "ERC4626_TRANSFER_PROOF", candidateCommitment, observation);
  const venue = facts.acquisitionVenue;
  validateProof(venue, "ERC4626_ACQUISITION_VENUE", candidateCommitment, observation);
  exactTrue(venue, "public", "ERC4626_ACQUISITION_NOT_PUBLIC");
  exactTrue(venue, "direct", "ERC4626_ACQUISITION_NOT_DIRECT");
  exactTrue(venue, "targetSpecific", "ERC4626_ACQUISITION_NOT_TARGET_SPECIFIC");
  if (venue.tokenIn !== settlement || venue.tokenOut !== share) stop("ERC4626_ACQUISITION_ASSET_MISMATCH", "REJECT");
  const redemption = facts.redemptionState;
  validateProof(redemption, "ERC4626_REDEMPTION_STATE", candidateCommitment, observation);
  exactTrue(redemption, "immediate", "ERC4626_REDEMPTION_NOT_IMMEDIATE");
  exactFalse(redemption, "asyncQueue", "ERC4626_ASYNC_QUEUE_FORBIDDEN");
  if (uint(redemption.delaySeconds, "ERC4626_DELAY_INVALID") !== 0n) stop("ERC4626_DELAY_FORBIDDEN", "REJECT");
  const maxRedeem = tokenQuantity(redemption.maxRedeem, share, candidateCommitment, observation, "ERC4626_MAX_REDEEM");
  const maxWithdraw = tokenQuantity(redemption.maxWithdraw, asset, candidateCommitment, observation, "ERC4626_MAX_WITHDRAW");
  const liquidAssets = tokenQuantity(redemption.immediateLiquidity, asset, candidateCommitment, observation, "ERC4626_LIQUIDITY");
  const route = sample.mechanismResult;
  if (!route || typeof route !== "object") stop("ERC4626_SAMPLE_RESULT_MISSING");
  validateProof(route.acquisitionQuote, "ERC4626_ACQUISITION_QUOTE", candidateCommitment, observation);
  if (tokenQuantity(route.acquisitionQuote.sharesOut, share, candidateCommitment, observation, "ERC4626_QUOTE_SHARES") !== size
      || settlementValue(route.acquisitionQuote.allInCost, economics, candidateCommitment, observation, "ERC4626_QUOTE_COST") !== acquisition) stop("ERC4626_ACQUISITION_QUOTE_MISMATCH", "REJECT");
  validateConversion(route.acquisitionQuote.conversionEvidence, route.acquisitionQuote.allInCost, route.acquisitionQuote.sharesOut, candidateCommitment, observation, "ERC4626_ACQUISITION");
  validateProof(route.previewRedeem, "ERC4626_PREVIEW_REDEEM", candidateCommitment, observation);
  const assets = exitRequired
    ? tokenQuantity(route.previewRedeem.assets, asset, candidateCommitment, observation, "ERC4626_PREVIEW_ASSETS")
    : settlementValue(route.previewRedeem.assets, economics, candidateCommitment, observation, "ERC4626_PREVIEW_ASSETS");
  if (tokenQuantity(route.previewRedeem.shares, share, candidateCommitment, observation, "ERC4626_PREVIEW_SHARES") !== size || assets === 0n) stop("ERC4626_PREVIEW_REDEEM_MISMATCH", "REJECT");
  validateConversion(route.previewRedeem.conversionEvidence, route.previewRedeem.shares, route.previewRedeem.assets, candidateCommitment, observation, "ERC4626_REDEMPTION");
  validateProof(route.actorDelta, "ERC4626_ACTOR_DELTA", candidateCommitment, observation);
  const actorAssets = exitRequired
    ? tokenQuantity(route.actorDelta.underlyingIn, asset, candidateCommitment, observation, "ERC4626_ACTOR_ASSET_DELTA")
    : settlementValue(route.actorDelta.underlyingIn, economics, candidateCommitment, observation, "ERC4626_ACTOR_ASSET_DELTA");
  if (tokenQuantity(route.actorDelta.sharesOut, share, candidateCommitment, observation, "ERC4626_ACTOR_SHARE_DELTA") !== size
      || actorAssets !== assets) stop("ERC4626_ACTOR_DELTA_MISMATCH", "REJECT");
  if (size > maxRedeem || assets > maxWithdraw || assets > liquidAssets) stop("ERC4626_CAPACITY_SHORTFALL", "REJECT");
  if (requiredBoolean(facts, "directExitRequired", "ERC4626_EXIT_REQUIRED_FLAG_MISSING") !== exitRequired) stop("ERC4626_EXIT_REQUIREMENT_MISMATCH", "REJECT");
  if (exitRequired) {
    const exit = facts.directExit;
    validateProof(exit, "ERC4626_DIRECT_EXIT", candidateCommitment, observation);
    exactTrue(exit, "public", "ERC4626_EXIT_NOT_PUBLIC");
    exactTrue(exit, "direct", "ERC4626_EXIT_NOT_DIRECT");
    exactTrue(exit, "targetSpecific", "ERC4626_EXIT_NOT_TARGET_SPECIFIC");
    if (exit.tokenIn !== asset || exit.tokenOut !== settlement) stop("ERC4626_EXIT_ASSET_MISMATCH", "REJECT");
    validateProof(route.exitQuote, "ERC4626_EXIT_QUOTE", candidateCommitment, observation);
    if (tokenQuantity(route.exitQuote.underlyingIn, asset, candidateCommitment, observation, "ERC4626_EXIT_INPUT") !== assets
        || settlementValue(route.exitQuote.settlementOut, economics, candidateCommitment, observation, "ERC4626_EXIT_OUTPUT") !== proceeds) stop("ERC4626_EXIT_QUOTE_MISMATCH", "REJECT");
    validateConversion(route.exitQuote.conversionEvidence, route.exitQuote.underlyingIn, route.exitQuote.settlementOut, candidateCommitment, observation, "ERC4626_EXIT");
  } else if (assets !== proceeds || own(route, "exitQuote")) stop("ERC4626_SAME_ASSET_PROCEEDS_MISMATCH", "REJECT");
}

function validateFxLink(row, link, code) {
  for (const key of ["callerCommitment", "beneficiaryCommitment", "deploymentCommitment", "facetCommitment", "selectorCommitment", "converterSourceCommitment", "converterRuntimeCommitment"])
    if (row[key] !== link[key]) stop(`${code}_${key.toUpperCase()}_MISMATCH`, "REJECT");
}

function validateFxsave(candidate, sample, economics, candidateCommitment, observation, size, proceeds, acquisition) {
  const facts = candidate.mechanismFacts;
  if (!facts || typeof facts !== "object") stop("FXSAVE_FACTS_MISSING");
  const bindings = facts.fxBindings;
  if (!bindings || typeof bindings !== "object") stop("FXSAVE_BINDINGS_MISSING");
  for (const [name, expected] of Object.entries(REVIEWED_MANIFEST.fxsaveBindings)) {
    const row = bindings[name];
    if (!row || typeof row !== "object") stop(`FXSAVE_${name.toUpperCase()}_BINDING_MISSING`);
    verifyContentCommitment(row, `FXSAVE_BINDING_${name.toUpperCase()}_V2`, `FXSAVE_${name.toUpperCase()}`);
    exactTrue(row, "exact", `FXSAVE_${name.toUpperCase()}_NOT_EXACT`);
    if (canonical(row.bindingPayload) !== canonical(expected)) stop(`FXSAVE_${name.toUpperCase()}_PAYLOAD_UNAUTHORIZED`, "REJECT");
    validateObservationBinding(row.observationBinding, candidateCommitment, observation, `FXSAVE_${name.toUpperCase()}`);
  }
  const link = {
    callerCommitment: opaque(facts.callerCommitment, "FXSAVE_CALLER_INVALID"),
    beneficiaryCommitment: opaque(facts.beneficiaryCommitment, "FXSAVE_BENEFICIARY_INVALID"),
    deploymentCommitment: bindings.deployment.commitment,
    facetCommitment: bindings.facet.commitment,
    selectorCommitment: bindings.selector.commitment,
    converterSourceCommitment: bindings.converterSource.commitment,
    converterRuntimeCommitment: bindings.converterRuntime.commitment
  };
  const inventory = facts.ambientInventory;
  validateProof(inventory, "FXSAVE_AMBIENT_INVENTORY", candidateCommitment, observation);
  validateFxLink(inventory, link, "FXSAVE_INVENTORY");
  exactFalse(inventory, "attackerFunded", "FXSAVE_ATTACKER_FUNDED_INVENTORY");
  const acquisitionPath = facts.publicAcquisition;
  validateProof(acquisitionPath, "FXSAVE_PUBLIC_ACQUISITION", candidateCommitment, observation);
  validateFxLink(acquisitionPath, link, "FXSAVE_ACQUISITION_PATH");
  exactTrue(acquisitionPath, "public", "FXSAVE_ACQUISITION_NOT_PUBLIC");
  exactTrue(acquisitionPath, "targetSpecific", "FXSAVE_ACQUISITION_NOT_TARGET_SPECIFIC");
  exactTrue(acquisitionPath, "direct", "FXSAVE_ACQUISITION_NOT_DIRECT");
  const redeemPath = facts.publicRedeem;
  validateProof(redeemPath, "FXSAVE_PUBLIC_REDEEM", candidateCommitment, observation);
  validateFxLink(redeemPath, link, "FXSAVE_REDEEM_PATH");
  exactTrue(redeemPath, "public", "FXSAVE_REDEEM_NOT_PUBLIC");
  exactTrue(redeemPath, "emptyRoute", "FXSAVE_ROUTE_NOT_EMPTY");
  const identity = facts.identityProof;
  validateProof(identity, "FXSAVE_IDENTITY_PROOF", candidateCommitment, observation);
  validateFxLink(identity, link, "FXSAVE_IDENTITY_PROOF");
  exactTrue(identity, "discrepancy", "FXSAVE_IDENTITY_DISCREPANCY_ABSENT");
  const input = opaque(identity.inputAssetRef, "FXSAVE_INPUT_ASSET_INVALID");
  const output = opaque(identity.outputAssetRef, "FXSAVE_OUTPUT_ASSET_INVALID");
  const raw = opaque(identity.rawTokenRef, "FXSAVE_RAW_TOKEN_INVALID");
  if (input !== output || raw === input || identity.converterInputRef !== raw || identity.converterOutputRef !== output) stop("FXSAVE_IDENTITY_RELATION_INVALID", "REJECT");
  if (acquisitionPath.tokenIn !== economics.settlementAssetRef || acquisitionPath.tokenOut !== input
      || redeemPath.tokenIn !== input || redeemPath.tokenOut !== raw || inventory.rawTokenRef !== raw) stop("FXSAVE_END_TO_END_TOKEN_PATH_MISMATCH", "REJECT");
  const inventoryAmount = tokenQuantity(inventory.amount, raw, candidateCommitment, observation, "FXSAVE_INVENTORY_AMOUNT");
  if (inventoryAmount === 0n) stop("FXSAVE_AMBIENT_INVENTORY_ZERO", "REJECT");
  const unwind = facts.publicUnwind;
  validateProof(unwind, "FXSAVE_PUBLIC_UNWIND", candidateCommitment, observation);
  validateFxLink(unwind, link, "FXSAVE_UNWIND_PATH");
  exactTrue(unwind, "public", "FXSAVE_UNWIND_NOT_PUBLIC");
  exactTrue(unwind, "targetSpecific", "FXSAVE_UNWIND_NOT_TARGET_SPECIFIC");
  exactTrue(unwind, "direct", "FXSAVE_UNWIND_NOT_DIRECT");
  if (unwind.tokenIn !== raw || unwind.tokenOut !== economics.settlementAssetRef) stop("FXSAVE_UNWIND_TOKEN_PATH_MISMATCH", "REJECT");
  const route = sample.mechanismResult;
  if (!route || typeof route !== "object") stop("FXSAVE_SAMPLE_RESULT_MISSING");
  validateProof(route.acquisitionProof, "FXSAVE_ACQUISITION_RESULT", candidateCommitment, observation);
  validateFxLink(route.acquisitionProof, link, "FXSAVE_ACQUISITION_RESULT");
  exactTrue(route.acquisitionProof, "direct", "FXSAVE_ACQUISITION_RESULT_NOT_DIRECT");
  if (route.acquisitionProof.tokenIn !== economics.settlementAssetRef || route.acquisitionProof.tokenOut !== input
      || settlementValue(route.acquisitionProof.amountPaid, economics, candidateCommitment, observation, "FXSAVE_ACQUISITION_PAID") !== acquisition
      || tokenQuantity(route.acquisitionProof.unitsAcquired, input, candidateCommitment, observation, "FXSAVE_UNITS_ACQUIRED") !== size) stop("FXSAVE_ACQUISITION_AMOUNT_MISMATCH", "REJECT");
  validateConversion(route.acquisitionProof.conversionEvidence, route.acquisitionProof.amountPaid, route.acquisitionProof.unitsAcquired, candidateCommitment, observation, "FXSAVE_ACQUISITION");
  validateProof(route.redeemProof, "FXSAVE_REDEEM_RESULT", candidateCommitment, observation);
  validateFxLink(route.redeemProof, link, "FXSAVE_REDEEM_RESULT");
  if (!own(route.redeemProof, "emptyRoute") || route.redeemProof.emptyRoute !== true) stop("FXSAVE_REDEEM_RESULT_ROUTE_NOT_EMPTY", "REJECT");
  if (route.redeemProof.publicRedeemCommitment !== redeemPath.commitment) stop("FXSAVE_REDEEM_RESULT_PUBLIC_PATH_MISMATCH", "REJECT");
  const rawReceived = tokenQuantity(route.redeemProof.rawUnitsReceived, raw, candidateCommitment, observation, "FXSAVE_RAW_RECEIVED");
  if (route.redeemProof.tokenIn !== input || route.redeemProof.tokenOut !== raw
      || tokenQuantity(route.redeemProof.unitsRedeemed, input, candidateCommitment, observation, "FXSAVE_UNITS_REDEEMED") !== size || rawReceived === 0n
      || rawReceived > inventoryAmount) stop("FXSAVE_REDEEM_AMOUNT_OR_INVENTORY_MISMATCH", "REJECT");
  validateConversion(route.redeemProof.conversionEvidence, route.redeemProof.unitsRedeemed, route.redeemProof.rawUnitsReceived, candidateCommitment, observation, "FXSAVE_REDEEM");
  validateProof(route.unwindProof, "FXSAVE_UNWIND_RESULT", candidateCommitment, observation);
  validateFxLink(route.unwindProof, link, "FXSAVE_UNWIND_RESULT");
  exactTrue(route.unwindProof, "direct", "FXSAVE_UNWIND_RESULT_NOT_DIRECT");
  if (route.unwindProof.tokenIn !== raw || route.unwindProof.tokenOut !== economics.settlementAssetRef
      || tokenQuantity(route.unwindProof.rawUnitsIn, raw, candidateCommitment, observation, "FXSAVE_UNWIND_INPUT") !== rawReceived
      || settlementValue(route.unwindProof.settlementProceeds, economics, candidateCommitment, observation, "FXSAVE_UNWIND_PROCEEDS") !== proceeds) stop("FXSAVE_UNWIND_AMOUNT_MISMATCH", "REJECT");
  validateConversion(route.unwindProof.conversionEvidence, route.unwindProof.rawUnitsIn, route.unwindProof.settlementProceeds, candidateCommitment, observation, "FXSAVE_UNWIND");
}

function validateCandidate(candidate, observations) {
  if (!candidate || typeof candidate !== "object") stop("CANDIDATE_MALFORMED");
  if (!CHAIN_IDS.includes(candidate.chainId)) stop("UNKNOWN_CHAIN", "REJECT");
  if (!MECHANISMS.includes(candidate.mechanism)) stop("UNKNOWN_MECHANISM", "REJECT");
  if (candidate.mechanism === "FXSAVE_EMPTY_ROUTE_IDENTITY" && candidate.chainId !== 1) stop("FXSAVE_WRONG_CHAIN", "REJECT");
  if (candidate.venue !== VENUES[candidate.mechanism]) stop("UNKNOWN_OR_WRONG_VENUE", "REJECT");
  const observation = observations.get(candidate.chainId);
  const reviewedCandidate = REVIEWED_MANIFEST.candidates[candidate.mechanism];
  if (!reviewedCandidate || !reviewedCandidate.allowedChains.includes(candidate.chainId)
      || canonical(candidate.lineagePayload) !== canonical(reviewedCandidate)) stop("CANDIDATE_LINEAGE_UNAUTHORIZED", "REJECT");
  const candidateCommitment = contentHash("CANDIDATE_LINEAGE_V2", {
    lineagePayload: candidate.lineagePayload,
    chainId: candidate.chainId,
    mechanism: candidate.mechanism,
    venue: candidate.venue,
    observation
  });
  if (candidate.candidateCommitment !== candidateCommitment) stop("CANDIDATE_CONTENT_COMMITMENT_MISMATCH", "REJECT");
  validateObservationBinding(candidate.observationBinding, candidateCommitment, observation, "CANDIDATE");
  validateBindings(candidate, candidateCommitment, observation);
  validateComponents(candidate, candidateCommitment, observation);
  const economics = validateEconomicsContext(candidate, candidateCommitment, observation);
  if (!Array.isArray(candidate.samples) || candidate.samples.length !== SAMPLE_COUNT) stop("SAMPLES_NOT_EXACTLY_THREE", "REJECT");
  const seen = new Set(), nets = [];
  for (const sample of candidate.samples) {
    if (!sample || typeof sample !== "object") stop("SAMPLE_MALFORMED");
    validateObservationBinding(sample.observationBinding, candidateCommitment, observation, "SAMPLE");
    const expectedAmountCommitment = contentHash("SAMPLE_AMOUNT_SET_V2", {
      size: sample.size?.commitment,
      proceeds: sample.proceeds?.commitment,
      acquisition: sample.acquisition?.commitment
    });
    if (sample.amountCommitment !== expectedAmountCommitment) stop("SAMPLE_AMOUNT_COMMITMENT_MISMATCH", "REJECT");
    const sizeAsset = candidate.mechanism === "COMET_RESERVE_BUYCOLLATERAL" ? candidate.mechanismFacts?.collateralAssetRef
      : candidate.mechanism === "ERC4626_SHARE_DISCOUNT_REDEEM" ? candidate.mechanismFacts?.shareAssetRef
        : candidate.mechanismFacts?.identityProof?.inputAssetRef;
    const size = tokenQuantity(sample.size, sizeAsset, candidateCommitment, observation, "SAMPLE_SIZE");
    if (size === 0n || seen.has(size.toString())) stop(size === 0n ? "SAMPLE_SIZE_ZERO" : "SAMPLE_SIZE_DUPLICATE", "REJECT");
    seen.add(size.toString());
    const proceeds = settlementValue(sample.proceeds, economics, candidateCommitment, observation, "SAMPLE_PROCEEDS");
    const acquisition = settlementValue(sample.acquisition, economics, candidateCommitment, observation, "SAMPLE_ACQUISITION");
    if (proceeds === 0n || acquisition === 0n) stop("SAMPLE_PRIMARY_AMOUNT_ZERO", "REJECT");
    if (candidate.mechanism === "COMET_RESERVE_BUYCOLLATERAL") validateComet(candidate, sample, economics, candidateCommitment, observation, size, proceeds, acquisition);
    else if (candidate.mechanism === "ERC4626_SHARE_DISCOUNT_REDEEM") validateErc4626(candidate, sample, economics, candidateCommitment, observation, size, proceeds, acquisition);
    else validateFxsave(candidate, sample, economics, candidateCommitment, observation, size, proceeds, acquisition);
    const net = proceeds - acquisition - validateCosts(sample.costs, economics, candidateCommitment, observation);
    nets.push(net);
  }
  return { status: nets.every((net) => net > 0n) ? "WATCH_SHADOW_ONLY" : "REJECT", minimumNet: nets.reduce((a, b) => a < b ? a : b) };
}

function countsTemplate(submitted = 0) {
  return { submitted, WATCH_SHADOW_ONLY: 0, REJECT: 0, INCOMPLETE: 0 };
}
function safeSubmittedCount(input) {
  if (!input || typeof input !== "object" || utilTypes.isProxy(input)) return 0;
  const descriptor = Object.getOwnPropertyDescriptor(input, "candidates");
  if (!descriptor || !own(descriptor, "value") || !Array.isArray(descriptor.value) || utilTypes.isProxy(descriptor.value)) return 0;
  return descriptor.value.length;
}
function outputCommitment(output, lineage) {
  return contentHash("AGGREGATE_CLASSIFIER_RESULT_V2", {
    classifierVersionDomain: CLASSIFIER_VERSION_DOMAIN,
    manifestCommitment: lineage?.manifestCommitment || EXPECTED_REVIEWED_MANIFEST_COMMITMENT,
    inputLineageCommitment: lineage?.inputLineageCommitment || "unverified_input_lineage",
    pinSetCommitment: lineage?.pinSetCommitment || "unverified_pin_set",
    runIdentity: lineage?.runIdentity || "unverified_run_identity",
    aggregate: { counts: output.counts, gates: output.gates }
  });
}
function baseOutput(counts, authorityValidated = false, lineage = null, economicsCompleted = 0) {
  const output = {
    schema: "multichain-profit-route-classifier-r1/result-v1",
    counts,
    commitments: { aggregateResult: null },
    gates: {
      authorityMode: authorityValidated ? "VALIDATED_FIXTURE_ONLY" : "UNVALIDATED_FIXTURE_ONLY",
      routePositive: "unknown",
      executableNow: "unknown",
      forkEligible: false,
      automaticPromotion: false,
      signedActionJustified: false,
      economicsEvaluated: authorityValidated && economicsCompleted > 0
    }
  };
  output.commitments.aggregateResult = outputCommitment(output, lineage);
  assertSanitized(output);
  return output;
}

function runClassifier(input) {
  const counts = countsTemplate(0);
  let authorityValidated = false;
  let verifiedLineage = null;
  let economicsCompleted = 0;
  try {
    counts.submitted = safeSubmittedCount(input);
    const candidates = shallowBounds(input);
    validateBoundedPlainGraph(input);
    assertSanitized(input);
    const authority = validateAuthority(input);
    const observations = authority.observations;
    authorityValidated = true;
    verifiedLineage = authority;
    const ranking = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      try {
        const result = validateCandidate(candidate, observations);
        economicsCompleted += 1;
        counts[result.status] += 1;
        if (result.status === "WATCH_SHADOW_ONLY") ranking.push(result.minimumNet);
      } catch (error) {
        if (error instanceof ClassifierError) counts[error.kind === "REJECT" ? "REJECT" : "INCOMPLETE"] += 1;
        else counts.REJECT += 1;
      }
    }
    ranking.sort((a, b) => a === b ? 0 : a > b ? -1 : 1);
    return baseOutput(counts, authorityValidated, verifiedLineage, economicsCompleted);
  } catch (error) {
    const kind = error instanceof ClassifierError && error.kind !== "REJECT" ? "INCOMPLETE" : "REJECT";
    counts[kind] = counts.submitted;
    return baseOutput(counts, authorityValidated, verifiedLineage, economicsCompleted);
  }
}

module.exports = Object.freeze({
  CHAIN_IDS,
  MECHANISMS,
  MAX_CANDIDATES,
  MAX_PER_CHAIN,
  SAMPLE_COUNT,
  COST_NAMES,
  FORBIDDEN_COMPONENTS,
  VENUES,
  INPUT_BUDGET,
  ClassifierError,
  canonical,
  assertSanitized,
  runClassifier
});
