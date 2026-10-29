"use strict";

const crypto = require("node:crypto");

const CHAIN_ID = 8453;
const MAX_CANDIDATES = 24;
const SAMPLE_COUNT = 3;
const OFFICIAL_PINS = Object.freeze({ registry: "d0e9a428", evk: "5b98b420", eulerSwap: "153cf82b" });
const FORBIDDEN_COMPONENTS = Object.freeze(["queue", "auction", "callback", "bridge", "flash", "private"]);
const READ_NAMES = Object.freeze(["getAssets", "getStaticParams", "getReserves"]);
const REVIEWED_FIXTURE_AUTHORITY = Object.freeze({
  fixtureOnly: true,
  manifestCommitment: "reviewed_fixture_base_eulerswap_v2_discovery_r1",
  pinsetCommitment: "reviewed_fixture_registry_evk_eulerswap_pinset_r1",
  observerClassCommitments: Object.freeze([
    "reviewed_fixture_observer_class_alpha_r1",
    "reviewed_fixture_observer_class_beta_r1"
  ]),
  bindings: Object.freeze({
    factoryImplementation: "reviewed_fixture_eulerswap_v2_factory_implementation_r1",
    factoryRuntime: "reviewed_fixture_eulerswap_v2_factory_runtime_r1",
    peripheryImplementation: "reviewed_fixture_eulerswap_v2_periphery_implementation_r1",
    peripheryRuntime: "reviewed_fixture_eulerswap_v2_periphery_runtime_r1",
    poolRuntime: "reviewed_fixture_eulerswap_v2_pool_runtime_r1"
  })
});

class DiscoveryError extends Error {
  constructor(code, kind = "INCOMPLETE") { super(code); this.name = "DiscoveryError"; this.code = code; this.kind = kind; }
}
const stop = (code, kind = "INCOMPLETE") => { throw new DiscoveryError(code, kind); };
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

const FORBIDDEN_KEYS = /^(?:url|urls|domain|hostname|endpoint|endpoints|provider|providers|providerLabel|family|families|operatorFamily|headers?|authorization|credential|credentials|apiKey|token|secret|password|rawRpc|rawResponse|rawQuote|rawQuotePayload|calldata|address|addresses|poolAddress|blockHash|stateRoot|transactionHash|txHash|sourcePath|sourcePaths|path|paths)$/iu;
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
function opaque(value, code) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{2,95}$/u.test(value)) stop(code);
  return value;
}
function uint(value, code) {
  if (typeof value === "string" && /^-[0-9]+$/u.test(value)) stop(code, "REJECT");
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) stop(code);
  return BigInt(value);
}
function exactTrue(object, key, code) {
  if (requiredBoolean(object, key, `${code}_MISSING`) !== true) stop(code, "REJECT");
}
function exactFalse(object, key, code) {
  if (requiredBoolean(object, key, `${code}_MISSING`) !== false) stop(code, "REJECT");
}

function validateCommitment(value, expected, code) {
  opaque(value, `${code}_INVALID`);
  if (value !== expected) stop(`${code}_UNAUTHORIZED`, "REJECT");
}

function validateAuthority(input) {
  const authority = input.authority;
  if (!authority || typeof authority !== "object") stop("AUTHORITY_MISSING");
  if (authority.chainId !== CHAIN_ID) stop("WRONG_CHAIN", "REJECT");
  if (authority.mode !== "OFFLINE_REVIEWED_FIXTURE_ONLY" || authority.fixtureOnly !== true) stop("REAL_AUTHORITY_FORBIDDEN", "REJECT");
  exactFalse(authority, "captureEnabled", "CAPTURE_ENABLED");
  exactFalse(authority, "genericAdapter", "GENERIC_ADAPTER_FORBIDDEN");
  if (authority.venue !== "EULERSWAP_V2" || authority.eulerSwapVersion !== "V2") stop("NOT_EULERSWAP_V2", "REJECT");
  if (!authority.reviewedManifestValidated || typeof authority.reviewedManifestValidated !== "boolean") stop("REVIEWED_MANIFEST_VALIDATION_MISSING");
  validateCommitment(authority.manifestCommitment, REVIEWED_FIXTURE_AUTHORITY.manifestCommitment, "AUTHORITY_MANIFEST");
  const pins = authority.officialPins;
  if (!pins || typeof pins !== "object") stop("OFFICIAL_PINS_MISSING");
  for (const name of Object.keys(OFFICIAL_PINS)) if (pins[name] !== OFFICIAL_PINS[name]) stop(`OFFICIAL_${name.toUpperCase()}_PIN_MISMATCH`, "REJECT");

  const observation = authority.observation;
  if (!observation || typeof observation !== "object") stop("OBSERVATION_MISSING");
  if (!Number.isSafeInteger(observation.blockNumber) || observation.blockNumber <= 0) stop("BLOCK_NUMBER_INVALID");
  uint(observation.timestamp, "BLOCK_TIMESTAMP_INVALID");
  exactTrue(observation, "finalized", "NONFINALIZED_OBSERVATION");
  exactTrue(observation, "requireCanonical", "EIP1898_REQUIRE_CANONICAL_FALSE");
  const stateCommitment = opaque(observation.stateCommitment, "STATE_COMMITMENT_INVALID");
  const pinsetCommitment = opaque(observation.pinsetCommitment, "PINSET_COMMITMENT_INVALID");
  validateCommitment(pinsetCommitment, REVIEWED_FIXTURE_AUTHORITY.pinsetCommitment, "PINSET_COMMITMENT");
  const bundleCommitment = opaque(observation.bundleCommitment, "BUNDLE_COMMITMENT_INVALID");

  if (!Array.isArray(authority.observerCommitments) || authority.observerCommitments.length !== 2) stop("TWO_OBSERVERS_REQUIRED", "REJECT");
  const observerValues = new Set(), observerClasses = new Set();
  for (const observer of authority.observerCommitments) {
    if (!observer || typeof observer !== "object") stop("OBSERVER_MALFORMED");
    exactTrue(observer, "independent", "OBSERVER_NOT_INDEPENDENT");
    exactTrue(observer, "finalized", "OBSERVER_NOT_FINALIZED");
    exactTrue(observer, "requireCanonical", "OBSERVER_REQUIRE_CANONICAL_FALSE");
    if (observer.blockNumber !== observation.blockNumber || observer.stateCommitment !== stateCommitment || observer.pinsetCommitment !== pinsetCommitment) stop("OBSERVER_MIXED_STATE_OR_PIN", "REJECT");
    const commitment = opaque(observer.commitment, "OBSERVER_COMMITMENT_INVALID");
    if (observerValues.has(commitment)) stop("OBSERVER_COMMITMENTS_NOT_INDEPENDENT", "REJECT");
    observerValues.add(commitment);
    const classCommitment = opaque(observer.classCommitment, "OBSERVER_CLASS_COMMITMENT_INVALID");
    if (!REVIEWED_FIXTURE_AUTHORITY.observerClassCommitments.includes(classCommitment) || observerClasses.has(classCommitment)) stop("OBSERVER_CLASS_NOT_INDEPENDENT_OR_REVIEWED", "REJECT");
    observerClasses.add(classCommitment);
  }
  if (observerClasses.size !== REVIEWED_FIXTURE_AUTHORITY.observerClassCommitments.length) stop("TWO_REVIEWED_OBSERVER_CLASSES_REQUIRED", "REJECT");

  const agreement = authority.agreement;
  if (!agreement || typeof agreement !== "object") stop("AGREEMENT_MISSING");
  for (const key of ["sameBlock", "sameState", "samePin", "twoIndependentObservers"]) exactTrue(agreement, key, `AGREEMENT_${key.toUpperCase()}_FALSE`);
  exactFalse(agreement, "mixedState", "MIXED_STATE");

  const terminal = authority.terminalRecheck;
  if (!terminal || typeof terminal !== "object") stop("TERMINAL_RECHECK_MISSING");
  exactTrue(terminal, "complete", "TERMINAL_RECHECK_INCOMPLETE");
  exactTrue(terminal, "finalized", "TERMINAL_RECHECK_NOT_FINALIZED");
  exactTrue(terminal, "requireCanonical", "TERMINAL_REQUIRE_CANONICAL_FALSE");
  if (terminal.blockNumber !== observation.blockNumber || terminal.stateCommitment !== stateCommitment || terminal.pinsetCommitment !== pinsetCommitment) stop("TERMINAL_RECHECK_MISMATCH", "REJECT");
  opaque(terminal.commitment, "TERMINAL_RECHECK_COMMITMENT_INVALID");
  if (!Array.isArray(terminal.observerCommitments) || terminal.observerCommitments.length !== 2
      || terminal.observerCommitments.some((value) => !observerValues.has(value))
      || new Set(terminal.observerCommitments).size !== 2) stop("TERMINAL_OBSERVER_BINDING_MISMATCH", "REJECT");
  if (!Array.isArray(terminal.classCommitments) || terminal.classCommitments.length !== 2
      || terminal.classCommitments.some((value) => !observerClasses.has(value))
      || new Set(terminal.classCommitments).size !== 2) stop("TERMINAL_CLASS_BINDING_MISMATCH", "REJECT");

  const bindings = authority.bindings;
  if (!bindings || typeof bindings !== "object") stop("AUTHORITY_BINDINGS_MISSING");
  for (const unit of ["factory", "periphery"]) {
    const binding = bindings[unit];
    if (!binding || typeof binding !== "object") stop(`${unit.toUpperCase()}_BINDING_MISSING`);
    exactTrue(binding, "exact", `${unit.toUpperCase()}_BINDING_NOT_EXACT`);
    if (binding.version !== "V2") stop(`${unit.toUpperCase()}_BINDING_NOT_V2`, "REJECT");
    validateCommitment(binding.implementationCommitment, REVIEWED_FIXTURE_AUTHORITY.bindings[`${unit}Implementation`], `${unit.toUpperCase()}_IMPLEMENTATION`);
    validateCommitment(binding.runtimeCommitment, REVIEWED_FIXTURE_AUTHORITY.bindings[`${unit}Runtime`], `${unit.toUpperCase()}_RUNTIME`);
  }
  return { blockNumber: observation.blockNumber, stateCommitment, pinsetCommitment, bundleCommitment };
}

function validateObservationBinding(binding, candidateCommitment, observation, code) {
  if (!binding || typeof binding !== "object") stop(`${code}_OBSERVATION_BINDING_MISSING`);
  exactTrue(binding, "exact", `${code}_OBSERVATION_BINDING_NOT_EXACT`);
  if (binding.candidateCommitment !== candidateCommitment
      || binding.blockNumber !== observation.blockNumber
      || binding.stateCommitment !== observation.stateCommitment
      || binding.pinsetCommitment !== observation.pinsetCommitment
      || binding.bundleCommitment !== observation.bundleCommitment) stop(`${code}_POOL_OR_OBSERVATION_MISMATCH`, "REJECT");
}

function validateRead(read, code, candidateCommitment, observation) {
  if (!read || typeof read !== "object") stop(`${code}_READ_MISSING`);
  exactTrue(read, "exact", `${code}_READ_NOT_EXACT`);
  exactTrue(read, "success", `${code}_READ_FAILED`);
  exactFalse(read, "reverted", `${code}_READ_REVERTED`);
  opaque(read.commitment, `${code}_READ_COMMITMENT_INVALID`);
  validateObservationBinding(read.observationBinding, candidateCommitment, observation, code);
}

function validateCandidate(candidate, observation) {
  if (!candidate || typeof candidate !== "object") stop("CANDIDATE_MALFORMED");
  const candidateCommitment = opaque(candidate.candidateCommitment, "CANDIDATE_COMMITMENT_INVALID");
  if (candidate.venue !== "EULERSWAP_V2" || candidate.version !== "V2") stop("CANDIDATE_NOT_EULERSWAP_V2", "REJECT");
  exactFalse(candidate, "genericAdapter", "CANDIDATE_GENERIC_ADAPTER_FORBIDDEN");
  exactTrue(candidate, "direct", "CANDIDATE_NOT_DIRECT");
  if (candidate.poolCount !== 1) stop("CANDIDATE_MULTI_POOL", "REJECT");
  const observationBinding = candidate.observationBinding;
  if (!observationBinding || typeof observationBinding !== "object") stop("CANDIDATE_OBSERVATION_BINDING_MISSING");
  exactTrue(observationBinding, "exact", "CANDIDATE_OBSERVATION_BINDING_NOT_EXACT");
  if (observationBinding.blockNumber !== observation.blockNumber
      || observationBinding.stateCommitment !== observation.stateCommitment
      || observationBinding.pinsetCommitment !== observation.pinsetCommitment
      || observationBinding.bundleCommitment !== observation.bundleCommitment) stop("CANDIDATE_OBSERVATION_UNBOUND", "REJECT");
  const factory = candidate.factoryMembership;
  if (!factory || typeof factory !== "object") stop("FACTORY_MEMBERSHIP_MISSING");
  exactTrue(factory, "deployedPool", "FACTORY_MEMBERSHIP_FALSE");
  if (factory.venueCommitment !== candidateCommitment) stop("FACTORY_MEMBERSHIP_UNBOUND", "REJECT");
  validateRead(factory.read, "DEPLOYED_POOLS", candidateCommitment, observation);
  const runtime = candidate.runtime;
  if (!runtime || typeof runtime !== "object") stop("POOL_RUNTIME_MISSING");
  exactTrue(runtime, "codePresent", "POOL_CODE_ABSENT");
  exactTrue(runtime, "exact", "POOL_RUNTIME_NOT_EXACT");
  validateCommitment(runtime.commitment, REVIEWED_FIXTURE_AUTHORITY.bindings.poolRuntime, "POOL_RUNTIME");

  const reads = candidate.reads;
  if (!reads || typeof reads !== "object") stop("POOL_READS_MISSING");
  for (const name of READ_NAMES) validateRead(reads[name], name.toUpperCase(), candidateCommitment, observation);
  const poolState = candidate.poolState;
  if (!poolState || typeof poolState !== "object") stop("POOL_STATE_MISSING");
  exactTrue(poolState, "active", "POOL_INACTIVE");
  exactTrue(poolState, "unlocked", "POOL_LOCKED");
  if (!Array.isArray(poolState.reserves) || poolState.reserves.length !== 2) stop("RESERVES_MALFORMED");
  for (const reserve of poolState.reserves) uint(reserve, "RESERVE_INVALID");

  const pair = candidate.pair;
  if (!pair || typeof pair !== "object") stop("PAIR_MISSING");
  if (!Array.isArray(pair.assets) || pair.assets.length !== 2) stop("PAIR_NOT_TWO_ASSETS", "REJECT");
  const assets = pair.assets.map((value) => opaque(value, "PAIR_ASSET_INVALID"));
  if (new Set(assets).size !== 2) stop("PAIR_ASSETS_NOT_DISTINCT", "REJECT");
  const share = opaque(pair.eVaultShare, "EVAULT_SHARE_INVALID");
  const underlying = opaque(pair.eVaultAsset, "EVAULT_ASSET_INVALID");
  if (share === underlying || assets.filter((value) => value === share).length !== 1 || assets.filter((value) => value === underlying).length !== 1) stop("PAIR_NOT_EXACT_SHARE_UNDERLYING", "REJECT");
  if (pair.eVaultShareCount !== 1) stop("PAIR_SHARE_COUNT_AMBIGUOUS", "REJECT");
  exactTrue(pair, "assetCallSuccess", "EVAULT_ASSET_CALL_FAILED");
  exactTrue(pair, "shareBindingExact", "EVAULT_SHARE_BINDING_UNPROVEN");
  opaque(pair.assetCallCommitment, "EVAULT_ASSET_CALL_COMMITMENT_INVALID");
  exactTrue(candidate, "standardTransfer", "NONSTANDARD_TRANSFER");
  if (!Array.isArray(reads.getAssets.normalizedAssets) || reads.getAssets.normalizedAssets.length !== 2
      || reads.getAssets.normalizedAssets[0] !== assets[0] || reads.getAssets.normalizedAssets[1] !== assets[1]) stop("GET_ASSETS_DECODE_MISMATCH", "REJECT");
  if (!Array.isArray(reads.getReserves.normalizedReserves) || reads.getReserves.normalizedReserves.length !== 2) stop("GET_RESERVES_DECODE_MALFORMED");
  for (let index = 0; index < 2; index += 1) {
    if (uint(reads.getReserves.normalizedReserves[index], "GET_RESERVES_DECODE_INVALID") !== uint(poolState.reserves[index], "POOL_RESERVE_INVALID")) stop("GET_RESERVES_DECODE_MISMATCH", "REJECT");
  }
  const staticParams = reads.getStaticParams.normalizedStaticParams;
  if (!staticParams || typeof staticParams !== "object") stop("GET_STATIC_PARAMS_DECODE_MISSING");
  if (requiredBoolean(staticParams, "active", "GET_STATIC_PARAMS_ACTIVE_MISSING") !== poolState.active
      || requiredBoolean(staticParams, "unlocked", "GET_STATIC_PARAMS_UNLOCKED_MISSING") !== poolState.unlocked) stop("GET_STATIC_PARAMS_STATE_MISMATCH", "REJECT");
  const staticAssertion = opaque(staticParams.assertionCommitment, "GET_STATIC_PARAMS_ASSERTION_INVALID");
  if (staticAssertion !== opaque(poolState.staticParamsAssertionCommitment, "POOL_STATIC_PARAMS_ASSERTION_INVALID")) stop("GET_STATIC_PARAMS_ASSERTION_MISMATCH", "REJECT");

  if (!candidate.components || typeof candidate.components !== "object") stop("COMPONENT_FLAGS_MISSING");
  for (const name of FORBIDDEN_COMPONENTS) exactFalse(candidate.components, name, `FORBIDDEN_COMPONENT_${name.toUpperCase()}`);

  const holder = candidate.holderProof;
  if (!holder || typeof holder !== "object") stop("HOLDER_PROOF_MISSING");
  exactTrue(holder, "exact", "HOLDER_PROOF_NOT_EXACT");
  for (const key of ["fresh", "debtFree", "shareTransferSuccess", "accountStatusClean"]) exactTrue(holder, key, `HOLDER_${key.toUpperCase()}_FALSE`);
  if (uint(holder.debtAmount, "HOLDER_DEBT_AMOUNT_INVALID") !== 0n) stop("HOLDER_HAS_DEBT", "REJECT");
  opaque(holder.commitment, "HOLDER_PROOF_COMMITMENT_INVALID");
  const sessionCommitment = opaque(holder.sessionCommitment, "HOLDER_SESSION_COMMITMENT_INVALID");
  const transferredShares = uint(holder.shareAmountTransferred, "HOLDER_SHARE_AMOUNT_INVALID");
  if (transferredShares === 0n) stop("HOLDER_SHARE_AMOUNT_ZERO", "REJECT");
  exactFalse(holder, "stale", "HOLDER_PROOF_STALE");
  validateObservationBinding(holder.observationBinding, candidateCommitment, observation, "HOLDER_PROOF");

  const redemption = candidate.redemptionProof;
  if (!redemption || typeof redemption !== "object") stop("REDEMPTION_PROOF_MISSING");
  exactTrue(redemption, "exact", "REDEMPTION_PROOF_NOT_EXACT");
  for (const key of ["erc4626", "immediate", "success", "underlyingReceived", "accountStatusClean"]) exactTrue(redemption, key, `REDEMPTION_${key.toUpperCase()}_FALSE`);
  if (redemption.shareAsset !== share || redemption.underlyingAsset !== underlying) stop("REDEMPTION_ASSET_MISMATCH", "REJECT");
  opaque(redemption.commitment, "REDEMPTION_PROOF_COMMITMENT_INVALID");
  if (opaque(redemption.sessionCommitment, "REDEMPTION_SESSION_COMMITMENT_INVALID") !== sessionCommitment) stop("HOLDER_REDEMPTION_SESSION_MISMATCH", "REJECT");
  const redeemedShares = uint(redemption.shareAmountRedeemed, "REDEEMED_SHARE_AMOUNT_INVALID");
  if (redeemedShares === 0n || redeemedShares !== transferredShares) stop("TRANSFER_REDEMPTION_SHARE_AMOUNT_MISMATCH", "REJECT");
  if (uint(redemption.underlyingAmountReceived, "REDEMPTION_UNDERLYING_AMOUNT_INVALID") === 0n) stop("REDEMPTION_UNDERLYING_AMOUNT_ZERO", "REJECT");
  exactFalse(redemption, "stale", "REDEMPTION_PROOF_STALE");
  validateObservationBinding(redemption.observationBinding, candidateCommitment, observation, "REDEMPTION_PROOF");

  const quote = candidate.quotePreflight;
  if (!quote || typeof quote !== "object") stop("QUOTE_PREFLIGHT_MISSING");
  if (quote.tokenIn !== underlying || quote.tokenOut !== share || quote.direction !== "A_TO_V") stop("QUOTE_DIRECTION_INVALID", "REJECT");
  exactTrue(quote, "exactOutput", "QUOTE_NOT_EXACT_OUTPUT");
  exactFalse(quote, "interpolationUsed", "QUOTE_INTERPOLATION_FORBIDDEN");
  if (!Array.isArray(quote.samples) || quote.samples.length !== SAMPLE_COUNT) stop("QUOTE_SAMPLES_NOT_EXACTLY_THREE");
  const amounts = new Set();
  for (const sample of quote.samples) {
    if (!sample || typeof sample !== "object") stop("QUOTE_SAMPLE_MALFORMED");
    const amountOut = uint(sample.amountOut, "QUOTE_AMOUNT_OUT_INVALID");
    if (amountOut === 0n) stop("QUOTE_AMOUNT_OUT_ZERO", "REJECT");
    const amountKey = amountOut.toString();
    if (amounts.has(amountKey)) stop("QUOTE_SAMPLE_DUPLICATE", "REJECT");
    amounts.add(amountKey);

    const poolQuote = sample.computeQuote;
    validateRead(poolQuote, "COMPUTE_QUOTE", candidateCommitment, observation);
    exactFalse(poolQuote, "exactIn", "COMPUTE_QUOTE_DIRECTION_INVALID");
    if (poolQuote.tokenIn !== underlying || poolQuote.tokenOut !== share) stop("COMPUTE_QUOTE_PAIR_MISMATCH", "REJECT");
    if (uint(poolQuote.amountOut, "COMPUTE_QUOTE_REQUEST_AMOUNT_INVALID") !== amountOut) stop("COMPUTE_QUOTE_REQUEST_AMOUNT_MISMATCH", "REJECT");
    const poolAmount = uint(poolQuote.amountIn, "COMPUTE_QUOTE_AMOUNT_INVALID");

    const peripheryQuote = sample.peripheryQuoteExactOutput;
    validateRead(peripheryQuote, "PERIPHERY_QUOTE", candidateCommitment, observation);
    exactTrue(peripheryQuote, "exactOutput", "PERIPHERY_QUOTE_NOT_EXACT_OUTPUT");
    if (peripheryQuote.venueCommitment !== candidateCommitment || peripheryQuote.tokenIn !== underlying || peripheryQuote.tokenOut !== share) stop("PERIPHERY_QUOTE_BINDING_MISMATCH", "REJECT");
    if (uint(peripheryQuote.amountOut, "PERIPHERY_QUOTE_REQUEST_AMOUNT_INVALID") !== amountOut) stop("PERIPHERY_QUOTE_REQUEST_AMOUNT_MISMATCH", "REJECT");
    const peripheryAmount = uint(peripheryQuote.amountIn, "PERIPHERY_QUOTE_AMOUNT_INVALID");
    if (poolAmount === 0n || peripheryAmount === 0n) stop("QUOTE_RESULT_ZERO", "REJECT");
    if (poolAmount !== peripheryAmount) stop("QUOTE_RESULT_MISMATCH", "REJECT");

    const limits = sample.limits;
    validateRead(limits, "GET_LIMITS", candidateCommitment, observation);
    if (limits.tokenIn !== underlying || limits.tokenOut !== share) stop("LIMITS_PAIR_MISMATCH", "REJECT");
    if (uint(limits.maximumAmountOut, "LIMITS_AMOUNT_INVALID") < amountOut) stop("LIMITS_SHORTFALL", "REJECT");
  }
  return SAMPLE_COUNT;
}

function emptyCounts(submitted = 0) {
  return { submitted, evaluated: 0, boundPairs: 0, quoteSamples: 0, structuralFailures: 0, incompleteInputs: 0 };
}

function outputCommitment(output) {
  return `result_${crypto.createHash("sha256").update(canonical(output)).digest("base64url")}`;
}

function baseOutput(status, counts, observationBundleValidated = false) {
  const output = {
    schema: "base-eulerswap-direct-share-pair-discovery-r1/result-v1",
    status,
    scope: "OFFLINE_INJECTED_EULERSWAP_V2_DIRECT_SHARE_PAIR_PREFLIGHT_ONLY",
    authorityMode: "REVIEWED_FIXTURE_ONLY_NOT_REAL_TARGET_AUTHORITY",
    counts,
    binding: { mode: "FIXTURE_ONLY", observationBundleValidated },
    commitments: { aggregateResult: null },
    gates: { captureEnabled: false, automaticPromotion: false, routePositive: "unknown", executableNow: "unknown", economicsEvaluated: false, profitAssessed: false },
    safety: { offline: true, injectedOnly: true, network: false, rpc: false, inventory: false, secrets: false, wallets: false, forks: false, childProcesses: false, swaps: false, transactions: false, outputArtifacts: false },
    limitations: [
      "Fixture-only discovery preflight is not real-target authority or capture approval.",
      "No swap, transaction construction, execution, fork, promotion, profit, or net assessment is performed.",
      "No chain-wide enumeration or generic DEX adapter is used."
    ]
  };
  output.commitments.aggregateResult = outputCommitment(output);
  assertSanitized(output);
  return output;
}

function runDiscoveryPreflight(input) {
  const counts = emptyCounts(0);
  let observationBundleValidated = false;
  try {
    if (!input || typeof input !== "object") stop("INPUT_MISSING");
    if (!own(input, "candidates") || !Array.isArray(input.candidates)) stop("CANDIDATES_MISSING");
    counts.submitted = input.candidates.length;
    if (input.candidates.length > MAX_CANDIDATES) stop("CANDIDATE_CAP_EXCEEDED", "REJECT");
    assertSanitized(input);
    const observation = validateAuthority(input);
    observationBundleValidated = true;
    if (input.candidates.length === 0) return baseOutput("HOLD_NO_BOUND_PAIR", counts, observationBundleValidated);
    for (const candidate of input.candidates) {
      counts.quoteSamples += validateCandidate(candidate, observation);
      counts.evaluated += 1;
      counts.boundPairs += 1;
    }
    if (counts.boundPairs !== 1) stop("AMBIGUOUS_OR_MULTI_POOL_CANDIDATES", "REJECT");
    return baseOutput("READY_FOR_SHADOW_CAPTURE", counts, observationBundleValidated);
  } catch (error) {
    if (!(error instanceof DiscoveryError)) throw error;
    if (error.kind === "REJECT") counts.structuralFailures += 1;
    else counts.incompleteInputs += 1;
    return baseOutput(error.kind === "REJECT" ? "REJECT" : "INCOMPLETE", counts, observationBundleValidated);
  }
}

module.exports = Object.freeze({
  CHAIN_ID,
  MAX_CANDIDATES,
  SAMPLE_COUNT,
  OFFICIAL_PINS,
  FORBIDDEN_COMPONENTS,
  REVIEWED_FIXTURE_AUTHORITY,
  DiscoveryError,
  canonical,
  assertSanitized,
  runDiscoveryPreflight
});
