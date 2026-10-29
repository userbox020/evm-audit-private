"use strict";

const crypto = require("node:crypto");
const { types: utilTypes } = require("node:util");

const CHAIN_ID = 8453;
const SOURCE_PIN = "89de5264c22e0e6e4e075a67046d120a7e7dbcff";
const MAX_CANDIDATES = 24;
const MAX_WITHDRAW_QUEUE = 30;
const SAMPLE_COUNT = 3;
const INPUT_BUDGET = Object.freeze({ nodes: 10000, properties: 50000, arrayItems: 4096, stringCharacters: 500000, depth: 24 });
const FORBIDDEN_COMPONENTS = Object.freeze(["userQueue", "delay", "auction", "callback", "bridge", "flash", "privateExecutor"]);
const REVIEWED_FIXTURE_AUTHORITY = Object.freeze({
  fixtureOnly: true,
  manifestCommitment: "reviewed_fixture_base_metamorpho_v1_1_shadow_r1",
  observerClassCommitments: Object.freeze([
    "reviewed_fixture_observer_class_alpha_r1",
    "reviewed_fixture_observer_class_beta_r1"
  ]),
  bindings: Object.freeze({
    factoryImplementation: "reviewed_fixture_metamorpho_v1_1_factory_implementation_r1",
    factoryRuntime: "reviewed_fixture_metamorpho_v1_1_factory_runtime_r1",
    vaultRuntime: "reviewed_fixture_metamorpho_v1_1_vault_runtime_r1",
    vaultSource: "reviewed_fixture_metamorpho_v1_1_vault_source_r1",
    morphoImmutable: "reviewed_fixture_morpho_blue_immutable_r1",
    assetImmutable: "reviewed_fixture_vault_asset_immutable_r1"
  })
});

class ShadowError extends Error {
  constructor(code, kind = "INCOMPLETE") { super(code); this.name = "ShadowError"; this.code = code; this.kind = kind; }
}
const stop = (code, kind = "INCOMPLETE") => { throw new ShadowError(code, kind); };
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

const FORBIDDEN_KEYS = /^(?:url|urls|domain|hostname|endpoint|endpoints|provider|providers|providerLabel|family|families|operatorFamily|headers?|authorization|credential|credentials|apiKey|token|secret|password|rawRpc|rawResponse|rawQuote|rawQuotePayload|calldata|address|addresses|vaultAddress|poolAddress|blockHash|stateRoot|transactionHash|txHash|sourcePath|sourcePaths|path|paths)$/iu;
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
function deriveMarketCommitment(preimage) {
  if (!preimage || typeof preimage !== "object") stop("BLUE_MARKET_PREIMAGE_MISSING");
  const normalized = [
    opaque(preimage.loanTokenRef, "BLUE_MARKET_LOAN_TOKEN_INVALID"),
    opaque(preimage.collateralTokenRef, "BLUE_MARKET_COLLATERAL_TOKEN_INVALID"),
    opaque(preimage.oracleCommitment, "BLUE_MARKET_ORACLE_INVALID"),
    opaque(preimage.irmCommitment, "BLUE_MARKET_IRM_INVALID"),
    uint(preimage.lltv, "BLUE_MARKET_LLTV_INVALID").toString()
  ];
  return `market_${crypto.createHash("sha256").update(canonical(["METAMORPHO_V1_1_BLUE_MARKET_ID_FIXTURE_V1", ...normalized])).digest("hex")}`;
}
function validateCommitment(value, expected, code) {
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
  if (!Array.isArray(value)) return undefined;
  if (value.length > cap) stop(`${code}_CAP_EXCEEDED`, "REJECT");
  return value;
}

function shallowBoundedArrays(input, candidates) {
  const authority = dataProperty(input, "authority", "AUTHORITY_SHALLOW_INVALID");
  if (authority && typeof authority === "object") {
    boundedArrayProperty(authority, "observers", 2, "OBSERVERS_SHALLOW_INVALID");
    const terminal = dataProperty(authority, "terminalRecheck", "TERMINAL_SHALLOW_INVALID");
    if (terminal && typeof terminal === "object") {
      boundedArrayProperty(terminal, "observerCommitments", 2, "TERMINAL_OBSERVERS_SHALLOW_INVALID");
      boundedArrayProperty(terminal, "classCommitments", 2, "TERMINAL_CLASSES_SHALLOW_INVALID");
    }
  }
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(candidates, String(candidateIndex));
    if (!descriptor || !own(descriptor, "value")) stop("CANDIDATE_ARRAY_ACCESSOR_OR_HOLE", "REJECT");
    const candidate = descriptor.value;
    plainDataObject(candidate, "CANDIDATE_SHALLOW_INVALID");
    const state = dataProperty(candidate, "vaultState", "VAULT_STATE_SHALLOW_INVALID");
    if (state && typeof state === "object") {
      boundedArrayProperty(state, "withdrawQueue", MAX_WITHDRAW_QUEUE, "WITHDRAW_QUEUE_SHALLOW_INVALID");
      boundedArrayProperty(state, "markets", MAX_WITHDRAW_QUEUE, "MARKETS_SHALLOW_INVALID");
      const reads = dataProperty(state, "reads", "VAULT_READS_SHALLOW_INVALID");
      if (reads && typeof reads === "object") {
        const queueRead = dataProperty(reads, "withdrawQueue", "WITHDRAW_QUEUE_READ_SHALLOW_INVALID");
        if (queueRead && typeof queueRead === "object") boundedArrayProperty(queueRead, "normalizedQueue", MAX_WITHDRAW_QUEUE, "NORMALIZED_QUEUE_SHALLOW_INVALID");
      }
    }
    const acquisition = dataProperty(candidate, "acquisition", "ACQUISITION_SHALLOW_INVALID");
    if (acquisition && typeof acquisition === "object") boundedArrayProperty(acquisition, "samples", SAMPLE_COUNT, "ACQUISITION_SAMPLES_SHALLOW_INVALID");
    const exit = dataProperty(candidate, "underlyingExit", "UNDERLYING_EXIT_SHALLOW_INVALID");
    if (exit && typeof exit === "object") boundedArrayProperty(exit, "samples", SAMPLE_COUNT, "UNDERLYING_EXIT_SAMPLES_SHALLOW_INVALID");
    const redemption = dataProperty(candidate, "redemption", "REDEMPTION_SHALLOW_INVALID");
    if (redemption && typeof redemption === "object") boundedArrayProperty(redemption, "samples", SAMPLE_COUNT, "REDEMPTION_SAMPLES_SHALLOW_INVALID");
  }
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
  return Object.freeze({ nodes, properties, arrayItems, stringCharacters });
}

function validateAuthority(input) {
  const authority = input.authority;
  if (!authority || typeof authority !== "object") stop("AUTHORITY_MISSING");
  if (authority.chainId !== CHAIN_ID) stop("WRONG_CHAIN", "REJECT");
  if (authority.mode !== "OFFLINE_REVIEWED_FIXTURE_ONLY" || authority.fixtureOnly !== true) stop("REAL_AUTHORITY_FORBIDDEN", "REJECT");
  exactFalse(authority, "captureEnabled", "CAPTURE_ENABLED");
  if (authority.factoryVersion !== "V1.1") stop("FACTORY_NOT_V1_1", "REJECT");
  if (authority.officialSourcePin !== SOURCE_PIN) stop("OFFICIAL_SOURCE_PIN_MISMATCH", "REJECT");
  if (authority.reviewedManifestValidated !== true) stop("REVIEWED_MANIFEST_VALIDATION_MISSING");
  validateCommitment(authority.manifestCommitment, REVIEWED_FIXTURE_AUTHORITY.manifestCommitment, "AUTHORITY_MANIFEST");

  const observation = authority.observation;
  if (!observation || typeof observation !== "object") stop("OBSERVATION_MISSING");
  if (!Number.isSafeInteger(observation.blockNumber) || observation.blockNumber <= 0) stop("BLOCK_NUMBER_INVALID");
  uint(observation.timestamp, "BLOCK_TIMESTAMP_INVALID");
  exactTrue(observation, "finalized", "OBSERVATION_NOT_FINALIZED");
  exactTrue(observation, "requireCanonical", "OBSERVATION_NOT_CANONICAL");
  const stateCommitment = opaque(observation.stateCommitment, "STATE_COMMITMENT_INVALID");
  const sourcePinCommitment = opaque(observation.sourcePinCommitment, "SOURCE_PIN_COMMITMENT_INVALID");
  const bundleCommitment = opaque(observation.bundleCommitment, "BUNDLE_COMMITMENT_INVALID");

  if (!Array.isArray(authority.observers) || authority.observers.length !== 2) stop("TWO_OBSERVERS_REQUIRED", "REJECT");
  const observerCommitments = new Set(), classCommitments = new Set();
  for (const observer of authority.observers) {
    if (!observer || typeof observer !== "object") stop("OBSERVER_MALFORMED");
    exactTrue(observer, "exact", "OBSERVER_NOT_EXACT");
    exactTrue(observer, "finalized", "OBSERVER_NOT_FINALIZED");
    exactTrue(observer, "requireCanonical", "OBSERVER_NOT_CANONICAL");
    if (observer.blockNumber !== observation.blockNumber || observer.stateCommitment !== stateCommitment
        || observer.sourcePinCommitment !== sourcePinCommitment || observer.bundleCommitment !== bundleCommitment) stop("OBSERVER_STATE_OR_PIN_MISMATCH", "REJECT");
    const commitment = opaque(observer.commitment, "OBSERVER_COMMITMENT_INVALID");
    const classCommitment = opaque(observer.classCommitment, "OBSERVER_CLASS_COMMITMENT_INVALID");
    if (observerCommitments.has(commitment)) stop("OBSERVER_COMMITMENT_DUPLICATE", "REJECT");
    if (!REVIEWED_FIXTURE_AUTHORITY.observerClassCommitments.includes(classCommitment) || classCommitments.has(classCommitment)) stop("OBSERVER_CLASS_NOT_DISTINCT_OR_REVIEWED", "REJECT");
    observerCommitments.add(commitment);
    classCommitments.add(classCommitment);
  }

  const terminal = authority.terminalRecheck;
  if (!terminal || typeof terminal !== "object") stop("TERMINAL_RECHECK_MISSING");
  exactTrue(terminal, "exact", "TERMINAL_NOT_EXACT");
  exactTrue(terminal, "complete", "TERMINAL_INCOMPLETE");
  exactTrue(terminal, "finalized", "TERMINAL_NOT_FINALIZED");
  exactTrue(terminal, "requireCanonical", "TERMINAL_NOT_CANONICAL");
  if (terminal.blockNumber !== observation.blockNumber || terminal.stateCommitment !== stateCommitment
      || terminal.sourcePinCommitment !== sourcePinCommitment || terminal.bundleCommitment !== bundleCommitment) stop("TERMINAL_STATE_OR_PIN_MISMATCH", "REJECT");
  opaque(terminal.commitment, "TERMINAL_COMMITMENT_INVALID");
  if (!Array.isArray(terminal.observerCommitments) || terminal.observerCommitments.length !== 2
      || new Set(terminal.observerCommitments).size !== 2 || terminal.observerCommitments.some((value) => !observerCommitments.has(value))) stop("TERMINAL_OBSERVER_BINDING_MISMATCH", "REJECT");
  if (!Array.isArray(terminal.classCommitments) || terminal.classCommitments.length !== 2
      || new Set(terminal.classCommitments).size !== 2 || terminal.classCommitments.some((value) => !classCommitments.has(value))) stop("TERMINAL_CLASS_BINDING_MISMATCH", "REJECT");

  const factory = authority.factoryBinding;
  if (!factory || typeof factory !== "object") stop("FACTORY_BINDING_MISSING");
  exactTrue(factory, "exact", "FACTORY_BINDING_NOT_EXACT");
  if (factory.version !== "V1.1" || factory.sourcePin !== SOURCE_PIN) stop("FACTORY_SOURCE_OR_VERSION_MISMATCH", "REJECT");
  validateCommitment(factory.implementationCommitment, REVIEWED_FIXTURE_AUTHORITY.bindings.factoryImplementation, "FACTORY_IMPLEMENTATION");
  validateCommitment(factory.runtimeCommitment, REVIEWED_FIXTURE_AUTHORITY.bindings.factoryRuntime, "FACTORY_RUNTIME");
  return { blockNumber: observation.blockNumber, stateCommitment, sourcePinCommitment, bundleCommitment };
}

function validateObservationBinding(binding, candidateCommitment, observation, code) {
  if (!binding || typeof binding !== "object") stop(`${code}_OBSERVATION_BINDING_MISSING`);
  exactTrue(binding, "exact", `${code}_OBSERVATION_BINDING_NOT_EXACT`);
  if (binding.candidateCommitment !== candidateCommitment || binding.blockNumber !== observation.blockNumber
      || binding.stateCommitment !== observation.stateCommitment || binding.sourcePinCommitment !== observation.sourcePinCommitment
      || binding.bundleCommitment !== observation.bundleCommitment) stop(`${code}_OBSERVATION_BINDING_MISMATCH`, "REJECT");
}

function validateRead(read, code, candidateCommitment, observation) {
  if (!read || typeof read !== "object") stop(`${code}_READ_MISSING`);
  exactTrue(read, "exact", `${code}_READ_NOT_EXACT`);
  exactTrue(read, "success", `${code}_READ_FAILED`);
  exactFalse(read, "reverted", `${code}_READ_REVERTED`);
  opaque(read.commitment, `${code}_READ_COMMITMENT_INVALID`);
  validateObservationBinding(read.observationBinding, candidateCommitment, observation, code);
}

function validateVaultBinding(candidate, candidateCommitment, observation) {
  const deployment = candidate.deployment;
  if (!deployment || typeof deployment !== "object") stop("DEPLOYMENT_BINDING_MISSING");
  exactTrue(deployment, "factoryRecognized", "FACTORY_DEPLOYMENT_UNRECOGNIZED");
  if (deployment.version !== "V1.1") stop("DEPLOYMENT_NOT_V1_1", "REJECT");
  validateRead(deployment.factoryRead, "FACTORY_DEPLOYMENT", candidateCommitment, observation);
  if (deployment.factoryRead.normalizedRecognized !== true || deployment.factoryRead.normalizedVersion !== "V1.1") stop("FACTORY_DEPLOYMENT_DECODE_MISMATCH", "REJECT");
  const runtime = candidate.runtimeBinding;
  if (!runtime || typeof runtime !== "object") stop("VAULT_RUNTIME_BINDING_MISSING");
  exactTrue(runtime, "codePresent", "VAULT_CODE_ABSENT");
  exactTrue(runtime, "exact", "VAULT_RUNTIME_NOT_EXACT");
  if (runtime.sourcePin !== SOURCE_PIN) stop("VAULT_SOURCE_PIN_MISMATCH", "REJECT");
  validateCommitment(runtime.runtimeCommitment, REVIEWED_FIXTURE_AUTHORITY.bindings.vaultRuntime, "VAULT_RUNTIME");
  validateCommitment(runtime.sourceBindingCommitment, REVIEWED_FIXTURE_AUTHORITY.bindings.vaultSource, "VAULT_SOURCE_BINDING");
  validateObservationBinding(runtime.observationBinding, candidateCommitment, observation, "VAULT_RUNTIME");
  const immutables = candidate.immutables;
  if (!immutables || typeof immutables !== "object") stop("IMMUTABLE_BINDING_MISSING");
  exactTrue(immutables, "exact", "IMMUTABLE_BINDING_NOT_EXACT");
  validateCommitment(immutables.morphoCommitment, REVIEWED_FIXTURE_AUTHORITY.bindings.morphoImmutable, "MORPHO_IMMUTABLE");
  opaque(immutables.morphoRef, "MORPHO_IMMUTABLE_REF_INVALID");
  validateCommitment(immutables.assetBindingCommitment, REVIEWED_FIXTURE_AUTHORITY.bindings.assetImmutable, "ASSET_IMMUTABLE");
  validateObservationBinding(immutables.observationBinding, candidateCommitment, observation, "IMMUTABLES");
  return opaque(immutables.assetRef, "VAULT_ASSET_REF_INVALID");
}

function validateVaultState(candidate, candidateCommitment, observation, assetRef) {
  const state = candidate.vaultState;
  if (!state || typeof state !== "object") stop("VAULT_STATE_MISSING");
  const reads = state.reads;
  if (!reads || typeof reads !== "object") stop("VAULT_STATE_READS_MISSING");
  for (const name of ["withdrawQueueLength", "withdrawQueue", "idleAssets", "maxRedeem", "maxWithdraw"]) validateRead(reads[name], name.toUpperCase(), candidateCommitment, observation);
  if (!Number.isSafeInteger(state.withdrawQueueLength) || state.withdrawQueueLength < 0 || state.withdrawQueueLength > MAX_WITHDRAW_QUEUE) stop("WITHDRAW_QUEUE_LENGTH_INVALID", "REJECT");
  if (!Array.isArray(state.withdrawQueue) || state.withdrawQueue.length !== state.withdrawQueueLength) stop("WITHDRAW_QUEUE_LENGTH_MISMATCH", "REJECT");
  if (new Set(state.withdrawQueue).size !== state.withdrawQueue.length) stop("WITHDRAW_QUEUE_DUPLICATE_MARKET", "REJECT");
  for (const market of state.withdrawQueue) opaque(market, "WITHDRAW_QUEUE_MARKET_INVALID");
  if (reads.withdrawQueueLength.normalizedLength !== state.withdrawQueueLength) stop("WITHDRAW_QUEUE_LENGTH_DECODE_MISMATCH", "REJECT");
  if (!Array.isArray(reads.withdrawQueue.normalizedQueue) || reads.withdrawQueue.normalizedQueue.length !== state.withdrawQueue.length
      || reads.withdrawQueue.normalizedQueue.some((value, index) => value !== state.withdrawQueue[index])) stop("WITHDRAW_QUEUE_DECODE_OR_ORDER_MISMATCH", "REJECT");

  const idleAssets = uint(state.idleAssets, "IDLE_ASSETS_INVALID");
  const maxRedeem = uint(state.maxRedeem, "MAX_REDEEM_INVALID");
  const maxWithdraw = uint(state.maxWithdraw, "MAX_WITHDRAW_INVALID");
  if (uint(reads.idleAssets.normalizedAmount, "IDLE_ASSETS_DECODE_INVALID") !== idleAssets) stop("IDLE_ASSETS_DECODE_MISMATCH", "REJECT");
  if (uint(reads.maxRedeem.normalizedAmount, "MAX_REDEEM_DECODE_INVALID") !== maxRedeem) stop("MAX_REDEEM_DECODE_MISMATCH", "REJECT");
  if (uint(reads.maxWithdraw.normalizedAmount, "MAX_WITHDRAW_DECODE_INVALID") !== maxWithdraw) stop("MAX_WITHDRAW_DECODE_MISMATCH", "REJECT");

  if (!Array.isArray(state.markets) || state.markets.length !== state.withdrawQueue.length) stop("MARKET_ROWS_LENGTH_MISMATCH", "REJECT");
  let marketLiquidity = 0n;
  for (let index = 0; index < state.markets.length; index += 1) {
    const market = state.markets[index];
    if (!market || typeof market !== "object") stop("MARKET_ROW_MALFORMED");
    const marketCommitment = opaque(market.marketCommitment, "MARKET_COMMITMENT_INVALID");
    if (marketCommitment !== state.withdrawQueue[index] || market.queueIndex !== index) stop("MARKET_QUEUE_ORDER_MISMATCH", "REJECT");
    const config = market.config;
    if (!config || typeof config !== "object") stop("MARKET_CONFIG_MISSING");
    exactTrue(config, "enabled", "MARKET_CONFIG_DISABLED");
    if (uint(config.cap, "MARKET_CAP_INVALID") === 0n) stop("MARKET_CAP_ZERO", "REJECT");
    validateRead(config.read, "MARKET_CONFIG", candidateCommitment, observation);
    if (config.read.marketCommitment !== marketCommitment) stop("MARKET_CONFIG_BINDING_MISMATCH", "REJECT");
    if (config.read.normalizedEnabled !== config.enabled || uint(config.read.normalizedCap, "MARKET_CONFIG_CAP_DECODE_INVALID") !== uint(config.cap, "MARKET_CONFIG_CAP_ASSERTION_INVALID")) stop("MARKET_CONFIG_DECODE_MISMATCH", "REJECT");
    const preimage = market.bluePreimage;
    if (!preimage || typeof preimage !== "object") stop("BLUE_MARKET_PREIMAGE_MISSING");
    exactTrue(preimage, "exact", "BLUE_MARKET_PREIMAGE_NOT_EXACT");
    if (preimage.marketCommitment !== marketCommitment || preimage.loanTokenRef !== assetRef) stop("BLUE_MARKET_PREIMAGE_BINDING_MISMATCH", "REJECT");
    for (const key of ["collateralTokenRef", "oracleCommitment", "irmCommitment", "preimageCommitment"]) opaque(preimage[key], `BLUE_MARKET_${key.toUpperCase()}_INVALID`);
    if (uint(preimage.lltv, "BLUE_MARKET_LLTV_INVALID") === 0n) stop("BLUE_MARKET_LLTV_ZERO", "REJECT");
    if (deriveMarketCommitment(preimage) !== marketCommitment) stop("BLUE_MARKET_ID_DERIVATION_MISMATCH", "REJECT");
    validateObservationBinding(preimage.observationBinding, candidateCommitment, observation, "BLUE_MARKET_PREIMAGE");
    const position = market.vaultSupplyPosition;
    if (!position || typeof position !== "object") stop("VAULT_SUPPLY_POSITION_MISSING");
    validateRead(position.read, "VAULT_SUPPLY_POSITION", candidateCommitment, observation);
    if (position.read.marketCommitment !== marketCommitment || position.rounding !== "DOWN") stop("VAULT_SUPPLY_POSITION_BINDING_OR_ROUNDING_INVALID", "REJECT");
    const positionAssets = uint(position.currentSupplyAssets, "VAULT_SUPPLY_POSITION_INVALID");
    if (uint(position.read.normalizedAmount, "VAULT_SUPPLY_POSITION_DECODE_INVALID") !== positionAssets
        || requiredBoolean(position, "zeroPosition", "VAULT_SUPPLY_POSITION_ZERO_FLAG_MISSING") !== (positionAssets === 0n)) stop("VAULT_SUPPLY_POSITION_DECODE_OR_ZERO_MISMATCH", "REJECT");
    const liquidity = market.liquidity;
    if (!liquidity || typeof liquidity !== "object") stop("MARKET_LIQUIDITY_MISSING");
    validateRead(liquidity.read, "MARKET_LIQUIDITY", candidateCommitment, observation);
    if (liquidity.read.marketCommitment !== marketCommitment || liquidity.rounding !== "DOWN") stop("MARKET_LIQUIDITY_BINDING_OR_ROUNDING_MISMATCH", "REJECT");
    const expected = uint(liquidity.expectedCurrentLiquidity, "MARKET_LIQUIDITY_INVALID");
    if (uint(liquidity.read.normalizedAmount, "MARKET_LIQUIDITY_DECODE_INVALID") !== expected
        || requiredBoolean(liquidity, "zeroLiquidity", "MARKET_LIQUIDITY_ZERO_FLAG_MISSING") !== (expected === 0n)) stop("MARKET_LIQUIDITY_DECODE_OR_ZERO_MISMATCH", "REJECT");
    const immediateWithdrawable = positionAssets < expected ? positionAssets : expected;
    if (uint(market.expectedImmediateWithdrawable, "EXPECTED_IMMEDIATE_WITHDRAWABLE_INVALID") !== immediateWithdrawable
        || requiredBoolean(market, "zeroImmediateWithdrawable", "IMMEDIATE_WITHDRAWABLE_ZERO_FLAG_MISSING") !== (immediateWithdrawable === 0n)) stop("IMMEDIATE_WITHDRAWABLE_MIN_OR_ZERO_MISMATCH", "REJECT");
    marketLiquidity += immediateWithdrawable;
  }
  return { idleAssets, maxRedeem, maxWithdraw, totalImmediateLiquidity: idleAssets + marketLiquidity, marketRows: state.markets.length };
}

function validateAcquisition(candidate, candidateCommitment, observation, assetRef, shareRef) {
  const acquisition = candidate.acquisition;
  if (!acquisition || typeof acquisition !== "object") stop("ACQUISITION_MISSING");
  if (acquisition.mode === "DIRECT_DEPOSIT" || acquisition.mode === "DIRECT_MINT") stop("VALUE_NEUTRAL_PRIMARY_ACQUISITION", "REJECT");
  if (acquisition.mode !== "DIRECT_SECONDARY_SHARE") stop("ACQUISITION_MODE_INVALID", "REJECT");
  exactTrue(acquisition, "direct", "ACQUISITION_NOT_DIRECT");
  exactTrue(acquisition, "secondary", "ACQUISITION_NOT_SECONDARY");
  exactTrue(acquisition, "shareOnly", "ACQUISITION_NOT_SHARE_ONLY");
  exactFalse(acquisition, "genericDex", "GENERIC_DEX_FORBIDDEN");
  if (acquisition.venueCount !== 1 || acquisition.tokenOut !== shareRef) stop("ACQUISITION_VENUE_OR_DIRECTION_INVALID", "REJECT");
  const settlementAsset = opaque(acquisition.settlementAsset, "SETTLEMENT_ASSET_INVALID");
  if (acquisition.tokenIn !== settlementAsset) stop("ACQUISITION_INPUT_NOT_SETTLEMENT_ASSET", "REJECT");
  opaque(acquisition.venueCommitment, "ACQUISITION_VENUE_COMMITMENT_INVALID");
  validateRead(acquisition.venueProof, "ACQUISITION_VENUE", candidateCommitment, observation);
  exactTrue(acquisition.venueProof, "targetSpecific", "ACQUISITION_VENUE_NOT_TARGET_SPECIFIC");
  exactTrue(acquisition.venueProof, "directShareVenue", "ACQUISITION_VENUE_NOT_DIRECT_SHARE");
  if (acquisition.venueProof.venueCommitment !== acquisition.venueCommitment) stop("ACQUISITION_VENUE_PROOF_MISMATCH", "REJECT");
  exactTrue(acquisition, "transferable", "SHARE_NOT_TRANSFERABLE");
  exactTrue(acquisition, "standardTransfer", "SHARE_TRANSFER_NONSTANDARD");
  validateRead(acquisition.transferProof, "SHARE_TRANSFER", candidateCommitment, observation);
  if (acquisition.transferProof.shareRef !== shareRef || acquisition.transferProof.normalizedTransferable !== true
      || acquisition.transferProof.normalizedStandardTransfer !== true) stop("SHARE_TRANSFER_DECODE_MISMATCH", "REJECT");

  const exit = candidate.underlyingExit;
  if (!exit || typeof exit !== "object") stop("UNDERLYING_EXIT_MISSING");
  const exitRequired = assetRef !== settlementAsset;
  if (requiredBoolean(exit, "required", "UNDERLYING_EXIT_REQUIRED_FLAG_MISSING") !== exitRequired) stop("UNDERLYING_EXIT_REQUIREMENT_MISMATCH", "REJECT");
  if (exitRequired) {
    exactTrue(exit, "direct", "UNDERLYING_EXIT_NOT_DIRECT");
    exactTrue(exit, "liquid", "UNDERLYING_EXIT_NOT_LIQUID");
    exactTrue(exit, "targetSpecific", "UNDERLYING_EXIT_NOT_TARGET_SPECIFIC");
    exactFalse(exit, "genericDex", "UNDERLYING_EXIT_GENERIC_DEX_FORBIDDEN");
    if (exit.venueCount !== 1 || exit.tokenIn !== assetRef || exit.tokenOut !== settlementAsset) stop("UNDERLYING_EXIT_ROUTE_INVALID", "REJECT");
    opaque(exit.venueCommitment, "UNDERLYING_EXIT_VENUE_COMMITMENT_INVALID");
    if (!Array.isArray(exit.samples) || exit.samples.length !== SAMPLE_COUNT) stop("UNDERLYING_EXIT_SAMPLES_INVALID", "REJECT");
  } else {
    exactFalse(exit, "direct", "UNNEEDED_UNDERLYING_EXIT");
    if (exit.venueCount !== 0) stop("UNNEEDED_UNDERLYING_EXIT_VENUE", "REJECT");
  }

  if (!Array.isArray(acquisition.samples)) stop("ACQUISITION_SAMPLES_MISSING");
  if (acquisition.samples.length !== SAMPLE_COUNT) stop("ACQUISITION_SAMPLES_NOT_EXACTLY_THREE", "REJECT");
  const seen = new Set();
  for (const sample of acquisition.samples) {
    if (!sample || typeof sample !== "object") stop("ACQUISITION_SAMPLE_MALFORMED");
    const shares = uint(sample.sharesAcquired, "ACQUISITION_SHARES_INVALID");
    if (shares === 0n || seen.has(shares.toString())) stop(shares === 0n ? "ACQUISITION_SHARES_ZERO" : "ACQUISITION_SAMPLE_DUPLICATE", "REJECT");
    seen.add(shares.toString());
    const amount = sample.amountBinding;
    if (!amount || typeof amount !== "object") stop("ACQUISITION_AMOUNT_BINDING_MISSING");
    exactTrue(amount, "exact", "ACQUISITION_AMOUNT_NOT_EXACT");
    if (uint(amount.shares, "ACQUISITION_AMOUNT_SHARES_INVALID") !== shares) stop("ACQUISITION_AMOUNT_SHARES_MISMATCH", "REJECT");
    opaque(amount.commitment, "ACQUISITION_AMOUNT_COMMITMENT_INVALID");
    validateObservationBinding(amount.observationBinding, candidateCommitment, observation, "ACQUISITION_AMOUNT");
    const quote = sample.quote;
    validateRead(quote, "ACQUISITION_QUOTE", candidateCommitment, observation);
    exactTrue(quote, "fixedAllInCost", "ACQUISITION_COST_NOT_FIXED_ALL_IN");
    exactTrue(quote, "venueFeesIncluded", "ACQUISITION_FEES_EXCLUDED");
    if (quote.venueCommitment !== acquisition.venueCommitment || quote.tokenIn !== settlementAsset || quote.tokenOut !== shareRef
        || uint(quote.sharesOut, "ACQUISITION_QUOTE_SHARES_INVALID") !== shares || uint(quote.allInShareCost, "ACQUISITION_COST_INVALID") === 0n) stop("ACQUISITION_QUOTE_BINDING_OR_AMOUNT_INVALID", "REJECT");
  }
  return { settlementAsset, samples: acquisition.samples, exit, exitRequired };
}

function validateRedemptions(candidate, candidateCommitment, observation, assetRef, acquisition, capacity) {
  const redemption = candidate.redemption;
  if (!redemption || typeof redemption !== "object") stop("REDEMPTION_MISSING");
  exactTrue(redemption, "erc4626", "REDEMPTION_NOT_ERC4626");
  exactTrue(redemption, "immediateOrRevert", "REDEMPTION_NOT_IMMEDIATE_OR_REVERT");
  exactFalse(redemption, "asyncUserQueue", "ASYNC_USER_QUEUE_FORBIDDEN");
  if (uint(redemption.delaySeconds, "REDEMPTION_DELAY_INVALID") !== 0n) stop("REDEMPTION_DELAY_FORBIDDEN", "REJECT");
  if (redemption.assetRef !== assetRef || !Array.isArray(redemption.samples) || redemption.samples.length !== SAMPLE_COUNT) stop("REDEMPTION_ASSET_OR_SAMPLES_INVALID", "REJECT");
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const sample = redemption.samples[index];
    if (!sample || typeof sample !== "object") stop("REDEMPTION_SAMPLE_MALFORMED");
    const acquiredShares = uint(acquisition.samples[index].sharesAcquired, "ACQUIRED_SHARES_INVALID");
    const shares = uint(sample.sharesRedeemed, "REDEEMED_SHARES_INVALID");
    if (shares === 0n || shares !== acquiredShares) stop("REDEEMED_SHARES_MISMATCH", "REJECT");
    const preview = sample.previewRedeem;
    validateRead(preview, "PREVIEW_REDEEM", candidateCommitment, observation);
    if (uint(preview.shares, "PREVIEW_REDEEM_SHARES_INVALID") !== shares) stop("PREVIEW_REDEEM_SHARES_MISMATCH", "REJECT");
    if (preview.shareRef !== candidate.shareRef || preview.assetRef !== assetRef) stop("PREVIEW_REDEEM_ASSET_BINDING_MISMATCH", "REJECT");
    const proceeds = uint(preview.assets, "PREVIEW_REDEEM_ASSETS_INVALID");
    if (proceeds === 0n) stop("PREVIEW_REDEEM_ZERO", "REJECT");
    const proof = sample.immediateRedeemProof;
    validateRead(proof, "IMMEDIATE_REDEEM", candidateCommitment, observation);
    exactTrue(proof, "immediate", "REDEEM_PROOF_NOT_IMMEDIATE");
    if (proof.shareRef !== candidate.shareRef || proof.assetRef !== assetRef) stop("REDEEM_PROOF_ASSET_BINDING_MISMATCH", "REJECT");
    if (uint(proof.shares, "REDEEM_PROOF_SHARES_INVALID") !== shares || uint(proof.assetsReceived, "REDEEM_PROOF_ASSETS_INVALID") !== proceeds) stop("REDEEM_PROOF_AMOUNT_MISMATCH", "REJECT");
    if (shares > capacity.maxRedeem || proceeds > capacity.maxWithdraw || proceeds > capacity.totalImmediateLiquidity) stop("IMMEDIATE_REDEMPTION_CAPACITY_SHORTFALL", "REJECT");
    if (acquisition.exitRequired) {
      const exitSample = acquisition.exit.samples[index];
      if (!exitSample || typeof exitSample !== "object") stop("UNDERLYING_EXIT_SAMPLE_MALFORMED");
      validateRead(exitSample.quote, "UNDERLYING_EXIT_QUOTE", candidateCommitment, observation);
      if (exitSample.quote.venueCommitment !== acquisition.exit.venueCommitment
          || exitSample.quote.tokenIn !== assetRef || exitSample.quote.tokenOut !== acquisition.settlementAsset
          || uint(exitSample.quote.underlyingAmountIn, "UNDERLYING_EXIT_AMOUNT_IN_INVALID") !== proceeds
          || uint(exitSample.quote.settlementAmountOut, "UNDERLYING_EXIT_AMOUNT_OUT_INVALID") === 0n) stop("UNDERLYING_EXIT_QUOTE_BINDING_OR_AMOUNT_INVALID", "REJECT");
    }
  }
}

function validateCandidate(candidate, observation) {
  if (!candidate || typeof candidate !== "object") stop("CANDIDATE_MALFORMED");
  const candidateCommitment = opaque(candidate.candidateCommitment, "CANDIDATE_COMMITMENT_INVALID");
  if (candidate.kind !== "METAMORPHO_V1_1") stop("CANDIDATE_NOT_METAMORPHO_V1_1", "REJECT");
  validateObservationBinding(candidate.observationBinding, candidateCommitment, observation, "CANDIDATE");
  const assetRef = validateVaultBinding(candidate, candidateCommitment, observation);
  const shareRef = opaque(candidate.shareRef, "VAULT_SHARE_REF_INVALID");
  if (shareRef === assetRef) stop("VAULT_SHARE_EQUALS_ASSET", "REJECT");
  const capacity = validateVaultState(candidate, candidateCommitment, observation, assetRef);
  const acquisition = validateAcquisition(candidate, candidateCommitment, observation, assetRef, shareRef);
  if (!candidate.components || typeof candidate.components !== "object") stop("COMPONENT_FLAGS_MISSING");
  for (const component of FORBIDDEN_COMPONENTS) exactFalse(candidate.components, component, `FORBIDDEN_COMPONENT_${component.toUpperCase()}`);
  validateRedemptions(candidate, candidateCommitment, observation, assetRef, acquisition, capacity);
  return { marketRows: capacity.marketRows, sampleCount: SAMPLE_COUNT };
}

function emptyCounts(submitted = 0) {
  return { submitted, evaluated: 0, boundVaults: 0, marketRows: 0, acquisitionSamples: 0, redemptionSamples: 0, structuralFailures: 0, incompleteInputs: 0 };
}
function outputCommitment(output) {
  return `result_${crypto.createHash("sha256").update(canonical(output)).digest("base64url")}`;
}
function baseOutput(status, counts, observationBundleValidated = false) {
  const output = {
    schema: "base-metamorpho-v1-1-share-shadow-r1/result-v1",
    status,
    scope: "OFFLINE_INJECTED_METAMORPHO_V1_1_SHARE_IMMEDIATE_REDEEM_PREFLIGHT_ONLY",
    authorityMode: "REVIEWED_FIXTURE_ONLY_NOT_REAL_AUTHORITY",
    counts,
    binding: { mode: "FIXTURE_ONLY", observationBundleValidated },
    commitments: { aggregateResult: null },
    gates: { captureEnabled: false, automaticPromotion: false, signedActionJustified: false, routePositive: "unknown", executableNow: "unknown", economicsEvaluated: false },
    safety: { offline: true, injectedOnly: true, network: false, rpc: false, inventory: false, secrets: false, wallets: false, forks: false, childProcesses: false, transactions: false, outputArtifacts: false },
    limitations: [
      "Fixture-only shadow preflight is not real authority or capture approval.",
      "No transaction, fork, execution, promotion, profit, net, or arithmetic economics assessment is performed.",
      "Direct deposit and mint are value-neutral and are not accepted as share acquisition venues."
    ]
  };
  output.commitments.aggregateResult = outputCommitment(output);
  assertSanitized(output);
  return output;
}

function runShadowPreflight(input) {
  const counts = emptyCounts(0);
  let observationBundleValidated = false;
  try {
    plainDataObject(input, "INPUT_NOT_PLAIN_DATA");
    const candidates = dataProperty(input, "candidates", "CANDIDATES_SHALLOW_INVALID");
    if (candidates === undefined) stop("CANDIDATES_MISSING");
    plainDataObject(candidates, "CANDIDATES_NOT_PLAIN_ARRAY");
    if (!Array.isArray(candidates)) stop("CANDIDATES_MISSING");
    counts.submitted = candidates.length;
    if (candidates.length > MAX_CANDIDATES) stop("CANDIDATE_CAP_EXCEEDED", "REJECT");
    shallowBoundedArrays(input, candidates);
    validateBoundedPlainGraph(input);
    assertSanitized(input);
    const observation = validateAuthority(input);
    observationBundleValidated = true;
    if (candidates.length === 0) return baseOutput("HOLD_NO_BOUND_VAULT", counts, observationBundleValidated);
    for (const candidate of candidates) {
      const result = validateCandidate(candidate, observation);
      counts.evaluated += 1;
      counts.boundVaults += 1;
      counts.marketRows += result.marketRows;
      counts.acquisitionSamples += result.sampleCount;
      counts.redemptionSamples += result.sampleCount;
    }
    if (counts.boundVaults !== 1) stop("AMBIGUOUS_OR_MULTI_VAULT_INPUT", "REJECT");
    return baseOutput("READY_FOR_SHADOW_CAPTURE", counts, observationBundleValidated);
  } catch (error) {
    if (error instanceof ShadowError) {
      if (error.kind === "REJECT") counts.structuralFailures += 1;
      else counts.incompleteInputs += 1;
      return baseOutput(error.kind === "REJECT" ? "REJECT" : "INCOMPLETE", counts, observationBundleValidated);
    }
    counts.structuralFailures += 1;
    return baseOutput("REJECT", counts, observationBundleValidated);
  }
}

module.exports = Object.freeze({
  CHAIN_ID,
  SOURCE_PIN,
  MAX_CANDIDATES,
  MAX_WITHDRAW_QUEUE,
  SAMPLE_COUNT,
  INPUT_BUDGET,
  FORBIDDEN_COMPONENTS,
  REVIEWED_FIXTURE_AUTHORITY,
  ShadowError,
  canonical,
  deriveMarketCommitment,
  assertSanitized,
  runShadowPreflight
});
