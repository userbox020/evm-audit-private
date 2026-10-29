"use strict";

const REGISTRY_PIN = "d0e9a428";
const CHAIN_ID = 8453;
const SAMPLE_COUNT = 3;
const ECONOMIC_CATEGORY_NAMES = Object.freeze([
  "acquisition", "gasSwap", "gasApproval", "gasRedemption", "gasExecutor", "gasDeployment",
  "financingCapital", "slippage", "latency", "competition", "residualUncertainty", "quoteDrift",
  "redemptionDrift", "gasVolatility", "transferTaxTokenSemantics"
]);
const GAS_CATEGORY_NAMES = Object.freeze(["gasSwap", "gasApproval", "gasRedemption", "gasExecutor", "gasDeployment"]);
const INAPPLICABLE_RATIONALES = Object.freeze({
  gasApproval: "ALLOWANCE_ALREADY_SUFFICIENT_FOR_BOUNDED_ROUTE",
  gasExecutor: "NO_EXTERNAL_EXECUTOR_CALL_IN_ROUTE",
  gasDeployment: "PREDEPLOYED_EXECUTOR_REQUIRED_NO_DEPLOYMENT",
  financingCapital: "SELF_FUNDED_NO_FINANCING_OR_CAPITAL_CHARGE",
  slippage: "EXACT_OUTPUT_LIMIT_FULLY_BOUNDS_SLIPPAGE",
  transferTaxTokenSemantics: "STANDARD_TRANSFER_SEMANTICS_PROVEN_NO_TAX"
});
const AUTHORITY_MANIFEST_COMMITMENT = "reviewed_fixture_manifest_base_evk_shadow_r1";
const REVIEWED_AUTHORITY_MANIFEST = Object.freeze({
  fixtureOnly: true,
  chainId: CHAIN_ID,
  registryPin: REGISTRY_PIN,
  authorityManifestCommitment: AUTHORITY_MANIFEST_COMMITMENT,
  bindings: Object.freeze({
    vault: "reviewed_fixture_vault_binding_r1",
    factory: "reviewed_fixture_factory_binding_r1",
    proxy: "reviewed_fixture_proxy_binding_r1",
    implementation: "reviewed_fixture_implementation_binding_r1",
    runtime: "reviewed_fixture_runtime_binding_r1"
  })
});
const FORBIDDEN_COMPONENTS = Object.freeze(["indirect", "multiPool", "queue", "auction", "callback", "bridge", "flash", "private"]);

class ShadowError extends Error {
  constructor(code, kind = "INCOMPLETE") { super(code); this.name = "ShadowError"; this.code = code; this.kind = kind; }
}
const stop = (code, kind = "INCOMPLETE") => { throw new ShadowError(code, kind); };
const own = (value, key) => value && typeof value === "object" && Object.hasOwn(value, key);

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

const FORBIDDEN_KEYS = /^(?:url|urls|domain|hostname|endpoint|endpoints|provider|providers|providerLabel|family|families|operatorFamily|headers?|authorization|credential|credentials|apiKey|token|secret|password|rawRpc|rawResponse|rawQuote|rawQuotePayload|calldata|address|addresses|blockHash|stateRoot|transactionHash|txHash)$/iu;
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

function uint(value, code) {
  if (typeof value === "string" && /^-[0-9]+$/u.test(value)) stop(code, "REJECT");
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) stop(code);
  return BigInt(value);
}
function requiredBoolean(object, key, code) {
  if (!own(object, key) || typeof object[key] !== "boolean") stop(code);
  return object[key];
}
function opaque(value, code) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{2,63}$/u.test(value)) stop(code);
  return value;
}

function baseOutput(status, counts, minNet = null, maxNet = null, valuations = {}) {
  const output = {
    schema: "base-euler-evk-same-asset-shadow-r1/result-v1",
    status,
    scope: "OFFLINE_INJECTED_SHADOW_SELECTION_AND_SAME_ASSET_ECONOMICS_ONLY",
    counts,
    netSummary: { denomination: "SETTLEMENT_ASSET_BASE_UNITS", minimum: minNet, maximum: maxNet },
    valuationCompleteness: { native: valuations.native === true, usd: valuations.usd === true },
    gates: { automaticPromotion: false, routePositive: "unknown", executableNow: "unknown", signedActionJustified: false },
    safety: { network: false, rpc: false, inventory: false, secrets: false, wallets: false, forks: false, childProcesses: false, capture: false, execution: false, outputArtifacts: false },
    limitations: [
      "PASS_SHADOW_CANDIDATE is shadow selection evidence only, not a finding or promotion.",
      "Authority is restricted to the fixed reviewed offline fixture manifest and is not real-target authorization.",
      "No route-positive, executable-now, deployment-currentness, native-value, or USD-value conclusion is produced.",
      "The engine does not interpolate beyond the three injected exact-output samples."
    ]
  };
  assertSanitized(output);
  return output;
}

function emptyCounts(sampled = 0) {
  return { sampled, evaluated: 0, positive: 0, zero: 0, negative: 0, capacityFailures: 0, structuralFailures: 0, incompleteInputs: 0 };
}

function validateAuthority(input) {
  if (!input.authority || typeof input.authority !== "object") stop("AUTHORITY_MISSING");
  if (input.authority.chainId !== CHAIN_ID) stop("WRONG_CHAIN", "REJECT");
  if (input.authority.registryPin !== REGISTRY_PIN) stop("REGISTRY_PIN_MISMATCH", "REJECT");
  if (!own(input.authority, "reviewedManifestValidated") || input.authority.reviewedManifestValidated !== true) stop("REVIEWED_MANIFEST_VALIDATION_MISSING");
  if (input.authority.fixtureOnly !== true) stop("FIXTURE_ONLY_AUTHORITY_REQUIRED", "REJECT");
  opaque(input.authority.authorityManifestCommitment, "AUTHORITY_MANIFEST_COMMITMENT_INVALID");
  if (input.authority.authorityManifestCommitment !== REVIEWED_AUTHORITY_MANIFEST.authorityManifestCommitment) stop("AUTHORITY_MANIFEST_UNAUTHORIZED", "REJECT");
  const block = input.authority.finalizedBlock;
  if (!block || !Number.isSafeInteger(block.number) || block.number <= 0 || typeof block.timestamp !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(block.timestamp)) stop("FINALIZED_BLOCK_MALFORMED");
  if (requiredBoolean(block, "finalized", "FINALITY_MISSING") !== true) stop("NONFINALIZED_STATE", "REJECT");
  const agreement = input.authority.agreement;
  if (!agreement || requiredBoolean(agreement, "twoFamilies", "TWO_FAMILY_MISSING") !== true
      || requiredBoolean(agreement, "sameBlock", "SAME_BLOCK_MISSING") !== true
      || requiredBoolean(agreement, "sameState", "SAME_STATE_MISSING") !== true
      || requiredBoolean(agreement, "mixedState", "MIXED_STATE_MISSING") !== false) stop("MIXED_OR_UNCORROBORATED_STATE", "REJECT");
  const bindings = input.authority.bindings;
  if (!bindings || typeof bindings !== "object") stop("BINDINGS_MISSING");
  for (const name of ["vault", "factory", "proxy", "implementation", "runtime"]) {
    const row = bindings[name];
    if (!row || typeof row !== "object") stop(`BINDING_${name.toUpperCase()}_MISSING`);
    if (requiredBoolean(row, "exact", `BINDING_${name.toUpperCase()}_EXACT_MISSING`) !== true) stop(`BINDING_${name.toUpperCase()}_NOT_EXACT`, "REJECT");
    opaque(row.commitment, `BINDING_${name.toUpperCase()}_COMMITMENT_INVALID`);
    if (row.commitment !== REVIEWED_AUTHORITY_MANIFEST.bindings[name]) stop(`BINDING_${name.toUpperCase()}_UNAUTHORIZED`, "REJECT");
  }
}

function validateRoute(route) {
  if (!route || typeof route !== "object") stop("ROUTE_MISSING");
  const settlement = opaque(route.settlementAsset, "SETTLEMENT_ASSET_INVALID");
  const vaultAsset = opaque(route.vaultAsset, "VAULT_ASSET_INVALID");
  const share = opaque(route.shareAsset, "SHARE_ASSET_INVALID");
  if (settlement !== vaultAsset || settlement === share) stop("NOT_SAME_UNDERLYING_ROUTE", "REJECT");
  if (!Array.isArray(route.pairAssets) || route.pairAssets.length !== 2 || route.pairAssets[0] !== settlement || route.pairAssets[1] !== share) stop("PAIR_NOT_EXACT_A_V", "REJECT");
  if (route.tokenIn !== settlement || route.tokenOut !== share || route.poolCount !== 1 || route.venueCount !== 1) stop("NOT_ONE_DIRECT_POOL", "REJECT");
  for (const [key, code] of [
    ["direct", "DIRECT_PROOF_MISSING"], ["permissionless", "PERMISSIONLESS_PROOF_MISSING"], ["immediateRedeem", "IMMEDIATE_REDEEM_MISSING"],
    ["exactOutput", "EXACT_OUTPUT_MISSING"], ["factoryMembership", "FACTORY_MEMBERSHIP_MISSING"],
    ["quoterProvenance", "QUOTER_PROVENANCE_MISSING"], ["routerProvenance", "ROUTER_PROVENANCE_MISSING"], ["standardTransfer", "NONSTANDARD_TRANSFER"]
  ]) if (requiredBoolean(route, key, code) !== true) stop(code, "REJECT");
  if (!route.components || typeof route.components !== "object") stop("COMPONENT_FLAGS_MISSING");
  for (const key of FORBIDDEN_COMPONENTS) if (requiredBoolean(route.components, key, `COMPONENT_${key.toUpperCase()}_MISSING`) !== false) stop(`FORBIDDEN_COMPONENT_${key.toUpperCase()}`, "REJECT");
  return { settlement, share };
}

function validateVault(state) {
  if (!state || typeof state !== "object") stop("ERC4626_STATE_MISSING");
  for (const key of ["assetDecimals", "shareDecimals"]) if (!Number.isSafeInteger(state[key]) || state[key] < 6 || state[key] > 77) stop("BAD_DECIMALS", "REJECT");
  if (state.assetDecimals !== state.shareDecimals) stop("DECIMALS_MISMATCH", "REJECT");
  const totalSupply = uint(state.totalSupply, "TOTAL_SUPPLY_MISSING"), totalAssets = uint(state.totalAssets, "TOTAL_ASSETS_MISSING");
  if (totalSupply === 0n || totalAssets === 0n) stop("EMPTY_VAULT_STATE", "REJECT");
  if (state.rounding !== "DOWN" || requiredBoolean(state, "optimisticConversion", "ROUNDING_FLAG_MISSING") !== false) stop("ROUNDING_NOT_CONSERVATIVE", "REJECT");
  return {
    totalSupply,
    totalAssets,
    poolShares: uint(state.poolShares, "POOL_SHARES_MISSING"),
    maxRedeem: uint(state.maxRedeemPool, "MAX_REDEEM_MISSING"),
    maxWithdraw: uint(state.maxWithdrawPool, "MAX_WITHDRAW_MISSING"),
    cash: uint(state.underlyingCash, "VAULT_CASH_MISSING")
  };
}

function proofBoolean(row, key, codePrefix) {
  if (!own(row, key) || typeof row[key] !== "boolean") stop(`${codePrefix}_${key.toUpperCase()}_MISSING`);
  if (row[key] !== true) stop(`${codePrefix}_${key.toUpperCase()}_INVALID`, "REJECT");
}

function validateNativeGasConversion(row, amount) {
  const conversion = row.nativeGasConversion;
  if (!conversion || typeof conversion !== "object") stop("NATIVE_GAS_CONVERSION_MISSING");
  proofBoolean(conversion, "evidence", "NATIVE_GAS_CONVERSION");
  proofBoolean(conversion, "provenance", "NATIVE_GAS_CONVERSION");
  proofBoolean(conversion, "complete", "NATIVE_GAS_CONVERSION");
  proofBoolean(conversion, "conservative", "NATIVE_GAS_CONVERSION");
  if (conversion.rounding !== "UP") stop("NATIVE_GAS_CONVERSION_ROUNDING_INVALID", "REJECT");
  const nativeAmount = uint(conversion.nativeAmount, "NATIVE_GAS_AMOUNT_INVALID");
  const settlementAmount = uint(conversion.settlementAmount, "NATIVE_GAS_SETTLEMENT_AMOUNT_INVALID");
  const numerator = uint(conversion.rateNumerator, "NATIVE_GAS_RATE_NUMERATOR_INVALID");
  const denominator = uint(conversion.rateDenominator, "NATIVE_GAS_RATE_DENOMINATOR_INVALID");
  if (nativeAmount === 0n || settlementAmount === 0n || numerator === 0n || denominator === 0n) stop("NATIVE_GAS_CONVERSION_ZERO", "REJECT");
  const conservativeMinimum = (nativeAmount * numerator + denominator - 1n) / denominator;
  if (settlementAmount < conservativeMinimum || settlementAmount !== amount) stop("NATIVE_GAS_CONVERSION_UNDERSTATED", "REJECT");
}

function economicCategories(rows) {
  if (!Array.isArray(rows)) stop("ECONOMICS_MISSING");
  const names = new Set(), output = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof row.category !== "string") stop("ECONOMICS_ROW_MALFORMED");
    if (names.has(row.category)) stop("ECONOMICS_DUPLICATE", "REJECT");
    names.add(row.category);
    if (!ECONOMIC_CATEGORY_NAMES.includes(row.category)) stop("ECONOMICS_UNKNOWN", "REJECT");
    proofBoolean(row, "evidence", "ECONOMICS");
    proofBoolean(row, "provenance", "ECONOMICS");
    if (row.treatment === "PROVEN_INAPPLICABLE") {
      if (!Object.hasOwn(INAPPLICABLE_RATIONALES, row.category)
          || !own(row, "rationale")
          || typeof row.rationale !== "string"
          || row.rationale !== INAPPLICABLE_RATIONALES[row.category]) stop("ECONOMICS_INAPPLICABLE_RATIONALE_INVALID", "REJECT");
      if (own(row, "amount") || own(row, "denomination") || own(row, "nativeGasConversion") || own(row, "conservative")
          || own(row, "venueFeesIncluded") || own(row, "exactOutputAmount")) stop("ECONOMICS_INAPPLICABLE_HAS_AMOUNT", "REJECT");
      output.set(row.category, 0n);
      continue;
    }
    if (row.treatment !== "AMOUNT") stop("ECONOMICS_TREATMENT_INVALID", "REJECT");
    if (own(row, "rationale")) stop("ECONOMICS_AMOUNT_HAS_INAPPLICABLE_RATIONALE", "REJECT");
    proofBoolean(row, "conservative", "ECONOMICS");
    if (row.denomination !== "SETTLEMENT_ASSET") stop("ECONOMICS_DENOMINATION_INVALID", "REJECT");
    const amount = uint(row.amount, "ECONOMICS_AMOUNT_INVALID");
    if (amount === 0n) stop("ECONOMICS_ZERO_UNSUPPORTED", "REJECT");
    if (GAS_CATEGORY_NAMES.includes(row.category)) validateNativeGasConversion(row, amount);
    else if (own(row, "nativeGasConversion")) stop("NON_GAS_CATEGORY_HAS_GAS_CONVERSION", "REJECT");
    if (row.category === "acquisition") {
      if (requiredBoolean(row, "exactOutputAmount", "ACQUISITION_EXACT_OUTPUT_MISSING") !== true) stop("ACQUISITION_NOT_EXACT_OUTPUT", "REJECT");
      if (requiredBoolean(row, "venueFeesIncluded", "ACQUISITION_VENUE_FEES_MISSING") !== true) stop("ACQUISITION_VENUE_FEES_EXCLUDED", "REJECT");
    } else if (own(row, "venueFeesIncluded") || own(row, "exactOutputAmount")) stop("NON_ACQUISITION_QUOTE_FIELDS", "REJECT");
    output.set(row.category, amount);
  }
  if (output.size !== ECONOMIC_CATEGORY_NAMES.length || ECONOMIC_CATEGORY_NAMES.some((name) => !output.has(name))) stop("ECONOMICS_OMITTED");
  return output;
}

function evaluateSample(sample, vault) {
  if (!sample || typeof sample !== "object") stop("QUOTE_SAMPLE_MISSING");
  if (requiredBoolean(sample, "success", "QUOTE_SUCCESS_MISSING") !== true || requiredBoolean(sample, "reverted", "QUOTE_REVERTED_MISSING") !== false) stop("QUOTE_FAILED_OR_REVERTED");
  if (requiredBoolean(sample, "provenance", "QUOTE_PROVENANCE_MISSING") !== true) stop("QUOTE_PROVENANCE_INVALID", "REJECT");
  if (sample.feeTreatment !== "INCLUDED_IN_ACQUISITION_CATEGORY") stop("QUOTE_FEE_TREATMENT_INVALID", "REJECT");
  const q = uint(sample.sharesOut, "SHARES_OUT_MISSING");
  const preview = uint(sample.previewRedeem, "PREVIEW_REDEEM_MISSING"), converted = uint(sample.convertToAssets, "CONVERT_TO_ASSETS_MISSING");
  if (q === 0n) stop("ZERO_SAMPLE", "REJECT");
  const floorConversion = (q * vault.totalAssets) / vault.totalSupply;
  if (converted !== floorConversion || preview > converted) stop("ROUNDING_SANITY_FAILED", "REJECT");
  if (q > vault.poolShares || q > vault.maxRedeem || preview > vault.maxWithdraw || preview > vault.cash) {
    return { capacity: false, q };
  }
  const economics = economicCategories(sample.economics);
  let deductions = 0n;
  for (const amount of economics.values()) deductions += amount;
  return { capacity: true, q, net: preview - deductions };
}

function runShadowGate(input) {
  const sampled = Array.isArray(input?.samples) ? input.samples.length : 0;
  const counts = emptyCounts(sampled);
  try {
    assertSanitized(input);
    validateAuthority(input);
    validateRoute(input.route);
    const vault = validateVault(input.erc4626);
    if (!Array.isArray(input.samples) || input.samples.length !== SAMPLE_COUNT) stop("QUOTE_LADDER_NOT_EXACTLY_THREE");
    if (requiredBoolean(input, "interpolationUsed", "INTERPOLATION_FLAG_MISSING") !== false) stop("INTERPOLATION_FORBIDDEN", "REJECT");
    const seen = new Set(), nets = [];
    for (const sample of input.samples) {
      const evaluated = evaluateSample(sample, vault);
      const key = evaluated.q.toString();
      if (seen.has(key)) stop("DUPLICATE_SAMPLE", "REJECT");
      seen.add(key);
      if (!evaluated.capacity) { counts.capacityFailures += 1; continue; }
      counts.evaluated += 1;
      nets.push(evaluated.net);
      if (evaluated.net > 0n) counts.positive += 1;
      else if (evaluated.net === 0n) counts.zero += 1;
      else counts.negative += 1;
    }
    if (counts.capacityFailures > 0) return baseOutput("REJECT", counts, null, null, valuationFlags(input.valuations));
    const minimum = nets.reduce((a, b) => a < b ? a : b), maximum = nets.reduce((a, b) => a > b ? a : b);
    const status = counts.positive === SAMPLE_COUNT ? "PASS_SHADOW_CANDIDATE" : "REJECT";
    return baseOutput(status, counts, minimum.toString(), maximum.toString(), valuationFlags(input.valuations));
  } catch (error) {
    if (!(error instanceof ShadowError)) throw error;
    counts[error.kind === "REJECT" ? "structuralFailures" : "incompleteInputs"] += 1;
    return baseOutput(error.kind === "REJECT" ? "REJECT" : "INCOMPLETE", counts);
  }
}

function valuationFlags(value) {
  return {
    native: Boolean(value && value.native && value.native.complete === true),
    usd: Boolean(value && value.usd && value.usd.complete === true)
  };
}

module.exports = Object.freeze({
  REGISTRY_PIN,
  CHAIN_ID,
  SAMPLE_COUNT,
  ECONOMIC_CATEGORY_NAMES,
  GAS_CATEGORY_NAMES,
  INAPPLICABLE_RATIONALES,
  AUTHORITY_MANIFEST_COMMITMENT,
  REVIEWED_AUTHORITY_MANIFEST,
  FORBIDDEN_COMPONENTS,
  ShadowError,
  canonical,
  assertSanitized,
  runShadowGate
});
