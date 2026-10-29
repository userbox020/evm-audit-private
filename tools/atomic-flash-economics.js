"use strict";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/iu;
const HASH_RE = /^0x[0-9a-f]{64}$/iu;
const UINT_RE = /^(?:0|[1-9][0-9]*)$/u;
const INT_RE = /^-?(?:0|[1-9][0-9]*)$/u;
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)(?:\.([0-9]+))?$/u;
const TEN_THOUSAND = 10_000n;
const NATIVE_DECIMALS = 18;

const SCHEMA = "atomic-flash-economics/v1";
const FORK_REQUEST_SCHEMA = "atomic-flash-fork-poc-request/v1";

// Constants and rounding are bound to local source where available. Balancer's
// fee is configurable, but its constructor default is zero; a fork must still
// verify the deployed value and liquidity. No availability is inferred here.
const FLASH_SOURCES = Object.freeze({
  "balancer-v2": Object.freeze({
    premiumBps: 0,
    rounding: "ceil",
    source: "targets/raft/lib/balancer-v2-monorepo/pkg/vault/contracts/Fees.sol:53-61; ProtocolFeesCollector.sol:42-58",
    qualification: "local-source-constructor-default-zero-deployed-value-requires-fork",
  }),
  "morpho-blue": Object.freeze({
    premiumBps: 0,
    rounding: "exact-zero",
    source: "targets/morpho-blue/src/Morpho.sol:421-430",
    qualification: "local-source-exact-principal-return",
  }),
  "aave-v3": Object.freeze({
    premiumBps: 5,
    rounding: "ceil",
    source: "targets/aave-v3-origin/src/deployments/inputs/DefaultMarketInput.sol:26; src/contracts/protocol/libraries/logic/FlashLoanLogic.sol:180",
    qualification: "local-source-default-and-percentMulCeil-deployed-value-requires-fork",
  }),
});

class EconomicsFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) { throw new EconomicsFailure(code); }

function asUint(value, code) {
  if (typeof value === "bigint") {
    if (value < 0n) fail(code);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) fail(code);
    return BigInt(value);
  }
  if (typeof value !== "string" || !UINT_RE.test(value)) fail(code);
  return BigInt(value);
}

function asInt(value, code) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail(code);
    return BigInt(value);
  }
  if (typeof value !== "string" || !INT_RE.test(value)) fail(code);
  return BigInt(value);
}

function asDecimals(value, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 36) fail(code);
  return value;
}

function parsePositiveDecimal(value, code) {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string" || !DECIMAL_RE.test(text)) fail(code);
  const [, fractional = ""] = text.match(DECIMAL_RE);
  const numerator = BigInt(text.replace(".", ""));
  if (numerator <= 0n) fail(code);
  return { numerator, scale: fractional.length, text };
}

function ceilDiv(numerator, denominator) {
  if (numerator < 0n || denominator <= 0n) fail("DIVISION_INPUT_INVALID");
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}

function pow10(decimals) { return 10n ** BigInt(decimals); }

function formatScaled(value, scale) {
  if (value < 0n) return `-${formatScaled(-value, scale)}`;
  if (scale === 0) return value.toString();
  const digits = value.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function usdValue(raw, decimals, price) {
  return formatScaled(raw * price.numerator, decimals + price.scale);
}

function premiumFor(principal, sourceName) {
  const source = FLASH_SOURCES[sourceName];
  if (!source) fail("FLASH_SOURCE_UNSUPPORTED");
  if (source.premiumBps === 0) return 0n;
  return ceilDiv(principal * BigInt(source.premiumBps), TEN_THOUSAND);
}

function gasCostInLoanRaw({ gasUnits, gasPriceWei, nativePrice, loanPrice, loanDecimals }) {
  const numerator = gasUnits * gasPriceWei * nativePrice.numerator
    * pow10(loanDecimals) * pow10(loanPrice.scale);
  const denominator = pow10(NATIVE_DECIMALS) * pow10(nativePrice.scale) * loanPrice.numerator;
  return ceilDiv(numerator, denominator);
}

function collateralValueInLoanRaw({ collateralRaw, collateralDecimals, collateralPrice, loanDecimals, loanPrice }) {
  const numerator = collateralRaw * collateralPrice.numerator
    * pow10(loanDecimals) * pow10(loanPrice.scale);
  const denominator = pow10(collateralDecimals) * pow10(collateralPrice.scale) * loanPrice.numerator;
  return numerator / denominator;
}

function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) fail("CANDIDATE_INVALID");
  if (!Number.isSafeInteger(candidate.chainId) || candidate.chainId <= 0) fail("CHAIN_ID_INVALID");
  if (candidate.protocol !== "morpho-blue") fail("PROTOCOL_UNSUPPORTED");
  if (!HASH_RE.test(candidate.marketId || "")) fail("MARKET_ID_INVALID");
  for (const key of ["borrower", "loanToken", "collateralToken"]) {
    if (!ADDRESS_RE.test(candidate[key] || "")) fail(`${key.replace(/[A-Z]/gu, (x) => `_${x}`).toUpperCase()}_INVALID`);
  }
  const loanDecimals = asDecimals(candidate.loanDecimals, "LOAN_DECIMALS_INVALID");
  const collateralDecimals = asDecimals(candidate.collateralDecimals, "COLLATERAL_DECIMALS_INVALID");
  const repayRaw = asUint(candidate.repayRaw, "REPAY_RAW_INVALID");
  const seizableCollateralRaw = asUint(candidate.seizableCollateralRaw, "SEIZABLE_COLLATERAL_RAW_INVALID");
  const lltvRaw = asUint(candidate.lltvRaw, "LLTV_RAW_INVALID");
  if (lltvRaw <= 0n || lltvRaw >= 10n ** 18n) fail("LLTV_RAW_INVALID");
  return {
    chainId: candidate.chainId,
    protocol: candidate.protocol,
    marketId: candidate.marketId.toLowerCase(),
    borrower: candidate.borrower.toLowerCase(),
    loanToken: candidate.loanToken.toLowerCase(),
    collateralToken: candidate.collateralToken.toLowerCase(),
    loanDecimals,
    collateralDecimals,
    repayRaw,
    seizableCollateralRaw,
    lltvRaw,
  };
}

function normalizeContext(context, repayRaw) {
  if (!context || typeof context !== "object" || Array.isArray(context)) fail("PRICE_GAS_CONTEXT_INVALID");
  const flashSource = context.flashSource;
  if (!Object.hasOwn(FLASH_SOURCES, flashSource)) fail("FLASH_SOURCE_UNSUPPORTED");
  if (context.gasUnits === undefined) fail("GAS_UNITS_MISSING");
  if (context.gasPriceWei === undefined) fail("GAS_PRICE_WEI_MISSING");
  if (context.nativeTokenUsdPrice === undefined) fail("NATIVE_USD_PRICE_MISSING");
  if (context.loanTokenUsdPrice === undefined) fail("LOAN_USD_PRICE_MISSING");
  if (context.collateralTokenUsdPrice === undefined) fail("COLLATERAL_USD_PRICE_MISSING");
  if (context.flashLiquidityRaw === undefined) fail("FLASH_LIQUIDITY_MISSING");

  const gasUnits = asUint(context.gasUnits, "GAS_UNITS_INVALID");
  const gasPriceWei = asUint(context.gasPriceWei, "GAS_PRICE_WEI_INVALID");
  if (gasUnits === 0n) fail("GAS_UNITS_INVALID");
  if (gasPriceWei === 0n) fail("GAS_PRICE_WEI_INVALID");
  const flashLiquidityRaw = asUint(context.flashLiquidityRaw, "FLASH_LIQUIDITY_INVALID");
  const dustThresholdRaw = context.dustThresholdRaw === undefined
    ? 0n : asUint(context.dustThresholdRaw, "DUST_THRESHOLD_INVALID");
  if (repayRaw <= dustThresholdRaw) fail("DUST_REPAY_AMOUNT");
  if (flashLiquidityRaw < repayRaw) fail("FLASH_LIQUIDITY_INSUFFICIENT");

  let block = "finalized";
  if (context.block !== undefined) {
    if (context.block !== "finalized" && (typeof context.block !== "string" || !UINT_RE.test(context.block))) {
      fail("FORK_BLOCK_INVALID");
    }
    block = context.block;
  }
  return {
    flashSource,
    gasUnits,
    gasPriceWei,
    flashLiquidityRaw,
    dustThresholdRaw,
    nativePrice: parsePositiveDecimal(context.nativeTokenUsdPrice, "NATIVE_USD_PRICE_INVALID"),
    loanPrice: parsePositiveDecimal(context.loanTokenUsdPrice, "LOAN_USD_PRICE_INVALID"),
    collateralPrice: parsePositiveDecimal(context.collateralTokenUsdPrice, "COLLATERAL_USD_PRICE_INVALID"),
    block,
    forkProof: context.forkProof,
  };
}

function observationMap(proof) {
  if (!Array.isArray(proof.observations)) fail("FORK_PROOF_INVALID");
  const values = new Map();
  for (const row of proof.observations) {
    if (row && typeof row.label === "string" && Object.hasOwn(row, "value")) values.set(row.label, row.value);
  }
  return values;
}

function validateForkProof(proof, expected) {
  if (proof === undefined || proof === null) return null;
  if (!proof || proof.schema !== "fork-poc/v1" || proof.status !== "PASS" || proof.result !== "PASS") {
    fail("FORK_PROOF_INVALID");
  }
  const proofBlock = String(proof.block);
  const blockMatches = String(expected.block) === "finalized"
    ? (proofBlock === "finalized" || UINT_RE.test(proofBlock))
    : proofBlock === String(expected.block);
  if (proof.chainId !== expected.chainId || !blockMatches) fail("FORK_PROOF_PIN_MISMATCH");
  if (proof.safety?.localOnly !== true || proof.safety?.noSigning !== true || proof.safety?.noBroadcast !== true) {
    fail("FORK_PROOF_SAFETY_INVALID");
  }
  if (!Array.isArray(proof.asserts) || proof.asserts.length === 0 || proof.asserts.some((row) => row?.pass !== true)) {
    fail("FORK_PROOF_ASSERTIONS_INVALID");
  }
  const values = observationMap(proof);
  if (values.get("fullAtomicPathCompleted") !== true || values.get("principalRepaid") !== true) {
    fail("FORK_PROOF_INCOMPLETE_PATH");
  }
  if (String(values.get("marketId")).toLowerCase() !== expected.marketId
      || String(values.get("borrower")).toLowerCase() !== expected.borrower
      || String(values.get("loanToken")).toLowerCase() !== expected.loanToken
      || values.get("flashSource") !== expected.flashSource
      || String(values.get("requiredPrincipalRaw")) !== expected.requiredPrincipalRaw.toString()) {
    fail("FORK_PROOF_CANDIDATE_MISMATCH");
  }
  if (String(values.get("premiumPaidRaw")) !== expected.premiumRaw.toString()
      || String(values.get("gasCostInLoanTokenRaw")) !== expected.gasCostInLoanTokenRaw.toString()) {
    fail("FORK_PROOF_COST_MISMATCH");
  }
  const netRaw = asInt(values.get("netLoanTokenRaw"), "FORK_NET_INVALID");
  if (netRaw <= 0n) fail("FORK_NET_NOT_POSITIVE");
  return { netRaw };
}

function buildForkRequest(candidate, context, economics) {
  const scenario = "tools/fork-poc/morpho-blue-atomic-liquidation.js";
  return {
    schema: FORK_REQUEST_SCHEMA,
    harness: "tools/run-fork-poc.js",
    triggerHarness: "tools/run-trigger-fork-poc.js",
    invocation: {
      chain: String(candidate.chainId),
      block: context.block,
      scenario,
      explicitRunFlagRequired: true,
      argv: ["--chain", String(candidate.chainId), "--block", context.block, "--scenario", scenario, "--run"],
    },
    candidate: {
      protocol: candidate.protocol,
      marketId: candidate.marketId,
      borrower: candidate.borrower,
      loanToken: candidate.loanToken,
      collateralToken: candidate.collateralToken,
      repayRaw: candidate.repayRaw.toString(),
      seizableCollateralRaw: candidate.seizableCollateralRaw.toString(),
      lltvRaw: candidate.lltvRaw.toString(),
    },
    economics: {
      flashSource: context.flashSource,
      requiredPrincipalRaw: economics.requiredPrincipalRaw.toString(),
      premiumRaw: economics.premiumRaw.toString(),
      gasCostInLoanTokenRaw: economics.gasCostInLoanTokenRaw.toString(),
      minimumSwapOutRaw: economics.breakEvenOutRaw.toString(),
    },
    scenarioContract: {
      export: "run(ctx)",
      requiredPath: ["flash-borrow", "morpho-liquidate", "swap-all-seized-collateral", "repay-principal-and-premium"],
      requiredObservations: [
        "marketId", "borrower", "loanToken", "flashSource", "requiredPrincipalRaw",
        "fullAtomicPathCompleted", "principalRepaid", "premiumPaidRaw", "gasCostInLoanTokenRaw",
        "netLoanTokenRaw",
      ],
      positiveAcceptance: "PASS with every assertion true and netLoanTokenRaw > 0 after principal, premium, swap, and gas",
    },
    safety: {
      localForkOnly: true,
      keylessImpersonationOnly: true,
      noSigning: true,
      noBroadcast: true,
      arithmeticIsNotRouteProof: true,
    },
  };
}

function sourceOptions(principal) {
  return Object.entries(FLASH_SOURCES).map(([flashSource, source]) => ({
    flashSource,
    premiumBps: source.premiumBps,
    premiumRaw: premiumFor(principal, flashSource).toString(),
    rounding: source.rounding,
    constantSource: source.source,
    qualification: source.qualification,
  }));
}

function evaluate(candidateInput, contextInput) {
  const candidate = normalizeCandidate(candidateInput);
  const context = normalizeContext(contextInput, candidate.repayRaw);
  const premiumRaw = premiumFor(candidate.repayRaw, context.flashSource);
  const gasCostRaw = gasCostInLoanRaw({
    gasUnits: context.gasUnits,
    gasPriceWei: context.gasPriceWei,
    nativePrice: context.nativePrice,
    loanPrice: context.loanPrice,
    loanDecimals: candidate.loanDecimals,
  });
  const breakEvenOutRaw = candidate.repayRaw + premiumRaw + gasCostRaw;
  const collateralSpotLoanRaw = collateralValueInLoanRaw({
    collateralRaw: candidate.seizableCollateralRaw,
    collateralDecimals: candidate.collateralDecimals,
    collateralPrice: context.collateralPrice,
    loanDecimals: candidate.loanDecimals,
    loanPrice: context.loanPrice,
  });
  if (collateralSpotLoanRaw < candidate.repayRaw) fail("BAD_DEBT_POSITION");

  const proof = validateForkProof(context.forkProof, {
    chainId: candidate.chainId,
    block: context.block,
    marketId: candidate.marketId,
    borrower: candidate.borrower,
    loanToken: candidate.loanToken,
    flashSource: context.flashSource,
    requiredPrincipalRaw: candidate.repayRaw,
    premiumRaw,
    gasCostInLoanTokenRaw: gasCostRaw,
  });
  const economics = {
    requiredPrincipalRaw: candidate.repayRaw,
    premiumRaw,
    gasCostInLoanTokenRaw: gasCostRaw,
    breakEvenOutRaw,
  };
  const result = {
    schema: SCHEMA,
    status: proof ? "FORK_PROVEN_POSITIVE" : "ARITHMETIC_ONLY_FORK_REQUIRED",
    candidate: {
      ...candidate,
      repayRaw: candidate.repayRaw.toString(),
      seizableCollateralRaw: candidate.seizableCollateralRaw.toString(),
      lltvRaw: candidate.lltvRaw.toString(),
    },
    requiredPrincipalRaw: candidate.repayRaw.toString(),
    flashSource: context.flashSource,
    flashLiquidityRaw: context.flashLiquidityRaw.toString(),
    flashLoanCoversPrincipal: true,
    premiumRaw: premiumRaw.toString(),
    premiumBps: FLASH_SOURCES[context.flashSource].premiumBps,
    flashSourceOptions: sourceOptions(candidate.repayRaw),
    gasUnits: context.gasUnits.toString(),
    gasPriceWei: context.gasPriceWei.toString(),
    gasCostInLoanTokenRaw: gasCostRaw.toString(),
    breakEvenOutRaw: breakEvenOutRaw.toString(),
    requiredCapitalUsd: usdValue(candidate.repayRaw, candidate.loanDecimals, context.loanPrice),
    collateralSpotValueInLoanRaw: collateralSpotLoanRaw.toString(),
    swapRequired: true,
    minimumAcceptableSwapOutRaw: breakEvenOutRaw.toString(),
    gasOnlyAtRisk: true,
    forkRequired: !proof,
    estimatedNetUsd: proof ? usdValue(proof.netRaw, candidate.loanDecimals, context.loanPrice) : null,
    routePositive: proof ? true : "unknown",
    netClaim: proof ? {
      basis: "LOCAL_FORK_FULL_ATOMIC_POSITIVE_BALANCE_DELTA",
      netLoanTokenRaw: proof.netRaw.toString(),
    } : null,
    arithmeticClaim: "break-even requirement only; no executable route or profit is inferred",
  };
  result.forkPocRequest = buildForkRequest(candidate, context, economics);
  assertSanitized(result);
  return result;
}

function safeCode(error) {
  const code = error?.code || error?.message;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)
    ? code : "ATOMIC_ECONOMICS_FAILED";
}

function candidateIdentity(input) {
  const result = {};
  if (Number.isSafeInteger(input?.chainId) && input.chainId > 0) result.chainId = input.chainId;
  if (HASH_RE.test(input?.marketId || "")) result.marketId = input.marketId.toLowerCase();
  if (ADDRESS_RE.test(input?.borrower || "")) result.borrower = input.borrower.toLowerCase();
  return result;
}

function evaluateFailClosed(candidate, context) {
  try {
    return evaluate(candidate, context);
  } catch (error) {
    return {
      schema: SCHEMA,
      status: "FAIL_CLOSED",
      reason: safeCode(error),
      candidate: candidateIdentity(candidate),
      gasOnlyAtRisk: true,
      forkRequired: true,
      estimatedNetUsd: null,
      routePositive: "unknown",
      netClaim: null,
    };
  }
}

function assertSanitized(value) {
  let text;
  try { text = JSON.stringify(value); } catch (_) { fail("OUTPUT_SANITIZATION_FAILED"); }
  const forbidden = [
    /https?:\/\//iu,
    /rpc_endpoints\.txt/iu,
    /(?:api[_-]?key|private[_-]?key|mnemonic|secret|authorization)["']?\s*:/iu,
    /[?&](?:token|key|api_key)=/iu,
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/iu,
  ];
  if (forbidden.some((pattern) => pattern.test(text))) fail("OUTPUT_SANITIZATION_FAILED");
  return true;
}

module.exports = Object.freeze({
  SCHEMA,
  FORK_REQUEST_SCHEMA,
  FLASH_SOURCES,
  EconomicsFailure,
  assertSanitized,
  ceilDiv,
  evaluate,
  evaluateFailClosed,
  gasCostInLoanRaw,
  premiumFor,
  safeCode,
});
