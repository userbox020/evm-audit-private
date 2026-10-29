"use strict";

// Import-inert, rank-1 only. No loader, transport, wallet, signing or write path.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { Interface, keccak256 } = require("../node_modules/ethers");
const { ExecutionError } = require("./wallet-execution-guard.js");
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const TARGET = freeze({ id: "spokeA-candidate1-usde-usdc", chainId: 1,
  owner: "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a", executor: "0x3c02c96bbb423d0109b823c23a05fcf0bf91ecb7",
  borrower: "0x1cb432f80416f07db4420b8c20447924a0658894", spoke: "0xba1b3d55d249692b669a164024a838309b7508af",
  collateralReserveId: 3, debtReserveId: 4, usde: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
  usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" });
const POLICY = freeze({ gasLimitCap: "1300000", maxFeePerGasWeiCap: "1500000000", nativeSpendWeiCap: "1950000000000000",
  valueWei: "0", minimumProfitUsdcRaw: "100000000", additionalReserveUsdcRaw: "2000000", profitHaircutBps: "1000",
  haircutBasis: "ORIGINAL_CONTRACT_ENFORCED_USDC_FLOOR", reserveAuthority: "STRICTER_ENGINEERING_RESERVE_NOT_BATCH_AUTHORIZATION",
  expiresAt: "2026-10-30T23:59:59Z",
  ethUsd: { address: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419", description: "ETH / USD", decimals: 8, maxAgeSeconds: 3600 },
  usdcUsd: { address: "0x8fffffd4afb6115b954bd326cbe7b4ba576818f6", description: "USDC / USD", decimals: 8, maxAgeSeconds: 82800 } });
const SOURCE_PATH = "tools/fork-poc/contracts/FlashLiquidateAaveV4.sol";
const COMPILED_PATH = "tools/fork-poc/contracts/FlashLiquidateAaveV4.compiled.json";
const BATCH_PATH = "coordination/live-execution-batch-aave-v4-executor-deploy-20261019.json";
// Source/runtime provenance remains bound to the ORIGINAL deployment approval.
// The runner, not this source proof, must establish the separate new gas authority.
const SOURCE_BATCH_FEE_CAP = "250000000", SOURCE_BATCH_SPEND_CAP = "550000000000000";
const SOURCE_SHA = "ca2666e360d08f3c755709afde70495906f85a6e76524ed73b73023c44c232ae";
const COMPILED_SHA = "ff6e6512eb5aa8adf80f1c4109e5b188e8e65e0b127c9dd3773923832e8dfe46";
const RUNTIME_HASH = "0x9bfeec237d3689863be8dda33148dfecaa28433c115513b2cc211733c593f833", RUNTIME_BYTES = 7578;
const OWNER_OFFSETS = [252, 868, 4524, 4775, 6307], ROOT = path.resolve(__dirname, "../..");
const U256 = (1n << 256n) - 1n, I256 = (1n << 255n) - 1n, U80 = (1n << 80n) - 1n;
const W = 10n ** 18n, USDC_UNIT = 10n ** 6n, EXPIRY = BigInt(Date.parse(POLICY.expiresAt) / 1000);
const runtimes = new WeakMap();
const STATE = new Interface(["function owner() view returns(address)", "function decimals() view returns(uint8)",
  "function balanceOf(address) view returns(uint256)"]);
const FEED = new Interface(["function decimals() view returns(uint8)", "function description() view returns(string)",
  "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)"]);
const fail = code => { throw new ExecutionError(code); };
const need = (condition, code) => { if (!condition) fail(code); };
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function integer(value, code, maximum = U256, allowNumber = false) {
  if (allowNumber && typeof value === "number") {
    need(Number.isSafeInteger(value) && value >= 0, code); value = BigInt(value);
  }
  need(typeof value === "bigint" || typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value), code);
  const n = BigInt(value); need(n >= 0n && n <= maximum, code); return n;
}
const timestamp = (value, code) => integer(value, code, BigInt(Number.MAX_SAFE_INTEGER), true);
function optionsOnly(options, names) {
  need(options && typeof options === "object" && !Array.isArray(options) &&
    Reflect.ownKeys(options).every(key => names.includes(key)), "RANK1_OPTIONS_INVALID");
}

// The optional readFile seam can replace bytes, never paths/owners/commitments.
// A returned proof is metadata only; the verified instantiated code stays private.
function loadRank1SourceProof(options = {}) {
  optionsOnly(options, ["readFile"]);
  const readFile = options.readFile === undefined ? fs.readFileSync : options.readFile;
  need(typeof readFile === "function", "RANK1_OPTIONS_INVALID");
  try {
    const sourceBytes = readFile(path.join(ROOT, SOURCE_PATH)), compiledBytes = readFile(path.join(ROOT, COMPILED_PATH));
    const batch = JSON.parse(readFile(path.join(ROOT, BATCH_PATH)).toString("utf8"));
    need(sha(sourceBytes) === SOURCE_SHA && sha(compiledBytes) === COMPILED_SHA, "RANK1_SOURCE_COMMITMENT_MISMATCH");
    need(batch.schema === "live-execution-batch/v1" && batch.batchId === "aave-v4-executor-deploy-and-trigger-20261019-01" &&
      batch.approved === true && batch.revoked !== true && batch.chainId === 1 && batch.chain === "ethereum" &&
      batch.account?.address?.toLowerCase() === TARGET.owner && batch.expiresAt === POLICY.expiresAt, "RANK1_SOURCE_APPROVAL_INVALID");
    const deployments = batch.targets?.filter(t => t.kind === "contract-deployment" && t.contract === "FlashLiquidateAaveV4");
    need(deployments?.length === 1, "RANK1_SOURCE_APPROVAL_INVALID");
    const binding = deployments[0], caps = batch.caps;
    need(binding.sourcePath === SOURCE_PATH && binding.compiledPath === COMPILED_PATH && binding.sourceSha256 === SOURCE_SHA &&
      binding.compiledSha256 === COMPILED_SHA && binding.expectedOwner?.toLowerCase() === TARGET.owner &&
      caps?.maxExecuteGasLimit === 1300000 && caps.maxFeePerGasWei === SOURCE_BATCH_FEE_CAP &&
      caps.maxNativeSpendPerTransactionWei === SOURCE_BATCH_SPEND_CAP && caps.valueCapEth === "0" &&
      caps.minProfitUsdcRaw === POLICY.minimumProfitUsdcRaw, "RANK1_SOURCE_APPROVAL_INVALID");
    const artifact = JSON.parse(compiledBytes.toString("utf8"));
    need(artifact.schema === "compiled-contract/v1" && artifact.contractName === "FlashLiquidateAaveV4" &&
      artifact.sourcePath === SOURCE_PATH && artifact.sourceSha256 === SOURCE_SHA && artifact.deployedBytecodeBytes === RUNTIME_BYTES &&
      typeof artifact.deployedBytecode === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(artifact.deployedBytecode), "RANK1_ARTIFACT_INVALID");
    const references = artifact.immutableReferences;
    need(references && Object.keys(references).length === 1 && Array.isArray(references["189"]) &&
      references["189"].length === OWNER_OFFSETS.length && references["189"].every((r, i) =>
        r.start === OWNER_OFFSETS[i] && r.length === 32), "RANK1_IMMUTABLES_INVALID");
    const runtime = Buffer.from(artifact.deployedBytecode.slice(2), "hex");
    need(runtime.length === RUNTIME_BYTES, "RANK1_ARTIFACT_INVALID");
    const owner = Buffer.from(TARGET.owner.slice(2).padStart(64, "0"), "hex");
    for (const start of OWNER_OFFSETS) {
      need(runtime.subarray(start, start + 32).every(byte => byte === 0), "RANK1_IMMUTABLES_INVALID");
      owner.copy(runtime, start);
    }
    need(keccak256(runtime) === RUNTIME_HASH, "RANK1_RUNTIME_COMMITMENT_MISMATCH");
    const proof = freeze({ schema: "rank1-source-proof/v1", targetId: TARGET.id, sourceSha256: SOURCE_SHA,
      compiledSha256: COMPILED_SHA, runtimeKeccak256: RUNTIME_HASH, runtimeBytes: RUNTIME_BYTES, owner: TARGET.owner,
      ownerImmutableRanges: OWNER_OFFSETS.map(start => ({ start, length: 32 })), approvalExpiresAt: POLICY.expiresAt,
      profitSemantics: "INCREMENTAL_USDC_AFTER_PRINCIPAL_ONLY_MORPHO_REPAYMENT_BEFORE_NATIVE_GAS",
      priorInventory: "PRESERVED_ONLY_INCREMENTAL_GAIN_TRANSFERRED", zeroInventorySourceInvariant: false,
      executionAuthorization: "CALLER_MUST_VALIDATE_CURRENT_BATCH_AND_SCOPE", settlementVerified: false });
    runtimes.set(proof, "0x" + runtime.toString("hex")); return proof;
  } catch (error) {
    if (error instanceof ExecutionError && /^RANK1_/.test(error.code)) throw error;
    fail("RANK1_SOURCE_ARTIFACT_UNAVAILABLE");
  }
}

function pinSnapshot(pinned) {
  try {
    need(pinned && typeof pinned.call === "function" && typeof pinned.assertUsable === "function" &&
      pinned.evidence?.independentFamilies === true && pinned.evidence.fixedProviderPair === true &&
      pinned.evidence.strictEvidence === true && pinned.evidence.rawTimestamp === true, "RANK1_STRICT_PIN_REQUIRED");
    pinned.assertUsable();
    const pin = pinned.pin;
    need(pin && /^0x[0-9a-f]{64}$/i.test(pin.hash) && (pin.chainId === undefined || pin.chainId === 1), "RANK1_PIN_INVALID");
    const number = timestamp(pin.number, "RANK1_PIN_INVALID"), at = timestamp(pin.timestamp, "RANK1_PIN_INVALID");
    need(at > 0n, "RANK1_PIN_INVALID");
    return freeze({ number: number.toString(), hash: pin.hash.toLowerCase(), timestamp: at.toString() });
  } catch (error) {
    if (error instanceof ExecutionError && ["RANK1_STRICT_PIN_REQUIRED", "RANK1_PIN_INVALID"].includes(error.code)) throw error;
    fail("RANK1_PIN_INVALID");
  }
}
function assertPin(pinned, pin) {
  const current = pinSnapshot(pinned);
  need(current.number === pin.number && current.hash === pin.hash && current.timestamp === pin.timestamp, "RANK1_PIN_CHANGED");
}
async function pairedRead(pinned, pin, invoke) {
  assertPin(pinned, pin);
  let raw;
  try { raw = await invoke(); } catch (_) { fail("RANK1_RPC_FAILED"); }
  assertPin(pinned, pin); return raw;
}
async function abiRead(pinned, pin, iface, target, method, args = []) {
  const raw = await pairedRead(pinned, pin, () => pinned.call({ to: target, data: iface.encodeFunctionData(method, args) }));
  try {
    need(typeof raw === "string" && raw.length <= 8194 && /^0x(?:[0-9a-f]{2})*$/i.test(raw), "RANK1_ABI_INVALID");
    const decoded = iface.decodeFunctionResult(method, raw);
    need(iface.encodeFunctionResult(method, decoded).toLowerCase() === raw.toLowerCase(), "RANK1_ABI_INVALID");
    return decoded;
  } catch (_) { fail("RANK1_ABI_INVALID"); }
}
async function boundedReads(jobs) {
  const values = new Array(jobs.length), errors = new Array(jobs.length); let next = 0, failed = false;
  await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, async () => {
    while (!failed && next < jobs.length) {
      const index = next++;
      try { values[index] = await jobs[index](); }
      catch (error) { errors[index] = { error }; failed = true; }
    }
  }));
  // Age-only recovery is valid only after every started read has drained and
  // no harder failure was observed. Wrappers retain even falsy rejections.
  const failures = errors.filter(Boolean);
  const failure = failures.find(({ error }) => !(error instanceof ExecutionError && error.code === "RANK1_FEED_STALE")) || failures[0];
  if (failure) throw failure.error; return values;
}
async function verifyRank1Runtime(pinned, options = {}) {
  optionsOnly(options, ["sourceProof"]);
  const source = options.sourceProof === undefined ? loadRank1SourceProof() : options.sourceProof;
  need(runtimes.has(source), "RANK1_SOURCE_PROOF_REQUIRED");
  const pin = pinSnapshot(pinned);
  need(typeof pinned.code === "function" && pinned.evidence.codeHashPinnedQualified === true, "RANK1_STRICT_CODE_REQUIRED");
  const [runtime, owner, usdeDecimals, usdcDecimals, usdeBalance, usdcBalance] = await boundedReads([
    async () => {
      const raw = await pairedRead(pinned, pin, () => pinned.code(TARGET.executor));
      need(typeof raw === "string" && raw.length === 2 + RUNTIME_BYTES * 2 && /^0x[0-9a-f]+$/i.test(raw) &&
        raw.toLowerCase() === runtimes.get(source), "RANK1_RUNTIME_MISMATCH"); return RUNTIME_HASH;
    },
    async () => {
      const value = (await abiRead(pinned, pin, STATE, TARGET.executor, "owner"))[0].toLowerCase();
      need(value === TARGET.owner, "RANK1_OWNER_MISMATCH"); return value;
    },
    ...[[TARGET.usde, 18n], [TARGET.usdc, 6n]].map(([token, decimals]) => async () => {
      const value = (await abiRead(pinned, pin, STATE, token, "decimals"))[0];
      need(value === decimals, "RANK1_TOKEN_DECIMALS_MISMATCH"); return Number(value);
    }),
    ...[TARGET.usde, TARGET.usdc].map(token => async () => {
      const value = (await abiRead(pinned, pin, STATE, token, "balanceOf", [TARGET.executor]))[0];
      need(value === 0n, "RANK1_EXECUTOR_INVENTORY_NONZERO"); return value.toString();
    }),
  ]);
  assertPin(pinned, pin);
  return freeze({ schema: "rank1-runtime-proof/v1", targetId: TARGET.id, chainId: 1, executor: TARGET.executor,
    owner, runtimeKeccak256: runtime, runtimeBytes: RUNTIME_BYTES, source, pin,
    inventories: { usde: { token: TARGET.usde, decimals: usdeDecimals, balanceRaw: usdeBalance },
      usdc: { token: TARGET.usdc, decimals: usdcDecimals, balanceRaw: usdcBalance } },
    zeroOwnPrincipalPolicy: "RUNNER_REQUIRES_ZERO_EXECUTOR_USDE_AND_USDC_NOT_A_SOURCE_INVARIANT", settlementVerified: false });
}

function feedProof(row, expected, at, context) {
  need(row && row.address === expected.address && row.description === expected.description, "RANK1_FEED_DENOMINATION_MISMATCH");
  need(row.decimals === 8 && row.maxAgeSeconds === expected.maxAgeSeconds, "RANK1_FEED_CONFIGURATION_INVALID");
  const answer = integer(row.answerRaw, "RANK1_FEED_PRICE_INVALID", I256);
  need(answer > 0n, "RANK1_FEED_PRICE_INVALID");
  const round = integer(row.roundId, "RANK1_FEED_ROUND_INVALID", U80), answered = integer(row.answeredInRound, "RANK1_FEED_ROUND_INVALID", U80);
  const started = timestamp(row.startedAt, "RANK1_FEED_ROUND_INVALID"), updated = timestamp(row.updatedAt, "RANK1_FEED_ROUND_INVALID");
  need(round > 0n && answered >= round && started > 0n && updated >= started, "RANK1_FEED_ROUND_INVALID");
  need(started <= at && updated <= at, "RANK1_FEED_FUTURE_TIMESTAMP");
  need(at - updated <= BigInt(expected.maxAgeSeconds) && context - updated <= BigInt(expected.maxAgeSeconds), "RANK1_FEED_STALE");
  return { ...expected, roundId: round.toString(), answerRaw: answer.toString(), startedAt: started.toString(), updatedAt: updated.toString(),
    answeredInRound: answered.toString(), ageAtPinSeconds: (at - updated).toString(), ageAtContextSeconds: (context - updated).toString() };
}
async function readRank1Feeds(pinned, options = {}) {
  optionsOnly(options, ["contextTimestamp"]);
  const pin = pinSnapshot(pinned), at = BigInt(pin.timestamp);
  const context = options.contextTimestamp === undefined ? at : timestamp(options.contextTimestamp, "RANK1_CONTEXT_TIMESTAMP_INVALID");
  need(context >= at, "RANK1_CONTEXT_TIMESTAMP_INVALID");
  const [ethUsd, usdcUsd] = await boundedReads([POLICY.ethUsd, POLICY.usdcUsd].map(config => async () => {
    const decimals = (await abiRead(pinned, pin, FEED, config.address, "decimals"))[0];
    need(decimals === 8n, "RANK1_FEED_CONFIGURATION_INVALID");
    const description = (await abiRead(pinned, pin, FEED, config.address, "description"))[0];
    need(description === config.description, "RANK1_FEED_DENOMINATION_MISMATCH");
    const [roundId, answer, startedAt, updatedAt, answeredInRound] = await abiRead(pinned, pin, FEED, config.address, "latestRoundData");
    return feedProof({ ...config, roundId, answerRaw: answer, startedAt, updatedAt, answeredInRound }, config, at, context);
  }));
  assertPin(pinned, pin);
  return freeze({ schema: "rank1-feeds/v1", pin, contextTimestamp: context.toString(), ethUsd, usdcUsd });
}

const multiply = (...values) => values.reduce((product, value) => {
  const result = product * value; need(result <= U256, "RANK1_ARITHMETIC_OVERFLOW"); return result;
}, 1n);
const ceil = (n, d) => n / d + (n % d === 0n ? 0n : 1n);
function validatedProfitInputs(input) {
  need(input && typeof input === "object" && !Array.isArray(input), "RANK1_ECONOMICS_INPUT_INVALID");
  const { profitUsdcRaw, feeds } = input;
  const profit = integer(profitUsdcRaw, "RANK1_PROFIT_FLOOR_INVALID");
  need(profit >= BigInt(POLICY.minimumProfitUsdcRaw), "RANK1_PROFIT_FLOOR_INVALID");
  need(feeds?.schema === "rank1-feeds/v1" && /^0x[0-9a-f]{64}$/i.test(feeds.pin?.hash), "RANK1_FEEDS_INVALID");
  const at = timestamp(feeds.pin.timestamp, "RANK1_FEEDS_INVALID"), context = timestamp(feeds.contextTimestamp, "RANK1_CONTEXT_TIMESTAMP_INVALID");
  need(at > 0n && context >= at, "RANK1_CONTEXT_TIMESTAMP_INVALID");
  need(context < EXPIRY, "RANK1_APPROVAL_EXPIRED");
  const ethUsd = feedProof(feeds.ethUsd, POLICY.ethUsd, at, context), usdcUsd = feedProof(feeds.usdcUsd, POLICY.usdcUsd, at, context);
  const ethPrice = BigInt(ethUsd.answerRaw), usdcPrice = BigInt(usdcUsd.answerRaw);
  return { profit, feeds, at, context, ethUsd, usdcUsd, ethPrice, usdcPrice };
}
function conservativeBeforeGas({ profit, ethPrice, usdcPrice }) {
  const reserve = BigInt(POLICY.additionalReserveUsdcRaw), haircut = ceil(multiply(profit, BigInt(POLICY.profitHaircutBps)), 10000n);
  need(profit > reserve + haircut, "RANK1_NET_NONPOSITIVE");
  const beforeGasUsdc = profit - reserve - haircut;
  const beforeGasWei = multiply(beforeGasUsdc, usdcPrice, W) / multiply(USDC_UNIT, ethPrice);
  return { reserve, haircut, beforeGasUsdc, beforeGasWei };
}
// Fee-selection input only: no gas envelope or after-gas profitability claim.
// The exact final envelope must still pass valueRank1Profit without exception.
function valueRank1ProfitBeforeGas(input = {}) {
  const values = validatedProfitInputs(input), { profit, feeds, at, context } = values;
  const { reserve, haircut, beforeGasUsdc, beforeGasWei } = conservativeBeforeGas(values);
  return freeze({ schema: "rank1-before-gas-valuation/v1", targetId: TARGET.id,
    contractEnforcedProfitUsdcRaw: profit.toString(), additionalReserveUsdcRaw: reserve.toString(), profitHaircutUsdcRaw: haircut.toString(),
    conservativeProfitBeforeGasUsdcRaw: beforeGasUsdc.toString(), conservativeProfitBeforeGasWei: beforeGasWei.toString(),
    pin: { number: timestamp(feeds.pin.number, "RANK1_FEEDS_INVALID").toString(), hash: feeds.pin.hash.toLowerCase(), timestamp: at.toString() },
    contextTimestamp: context.toString(), afterGas: "NOT_EVALUATED", settlementVerified: false });
}
function valueRank1Profit(input = {}) {
  const values = validatedProfitInputs(input), { profit, feeds, at, context, ethUsd, usdcUsd, ethPrice, usdcPrice } = values;
  const { fees } = input;
  need(fees && typeof fees === "object" && !Array.isArray(fees), "RANK1_FEES_INVALID");
  const gas = integer(fees.gasLimit, "RANK1_FEES_INVALID"), maxFee = integer(fees.maxFeePerGas, "RANK1_FEES_INVALID");
  const priority = integer(fees.maxPriorityFeePerGas, "RANK1_FEES_INVALID");
  if (fees.value !== undefined) need(integer(fees.value, "RANK1_FEES_INVALID") === 0n, "RANK1_VALUE_CAP_EXCEEDED");
  need(gas > 0n && gas <= BigInt(POLICY.gasLimitCap) && maxFee > 0n && maxFee <= BigInt(POLICY.maxFeePerGasWeiCap) &&
    priority <= maxFee, "RANK1_FEE_CAP_EXCEEDED");
  const gasBudget = multiply(gas, maxFee);
  need(gasBudget <= BigInt(POLICY.nativeSpendWeiCap), "RANK1_NATIVE_SPEND_CAP_EXCEEDED");
  const { reserve, haircut, beforeGasUsdc, beforeGasWei } = conservativeBeforeGas(values);
  const netWei = beforeGasWei - gasBudget;
  need(netWei > 0n, "RANK1_NET_NONPOSITIVE");
  const gasUsdc = ceil(multiply(gasBudget, ethPrice, USDC_UNIT), multiply(W, usdcPrice));
  const beforeGasUsd = multiply(beforeGasUsdc, usdcPrice) / USDC_UNIT, gasUsd = ceil(multiply(gasBudget, ethPrice), W);
  // Report both display denominations from the same native lower bound. They
  // may floor to zero below their unit precision, never create a second gas
  // deduction or an artificial negative USD net from two separate roundings.
  const netUsd = multiply(netWei, ethPrice) / W;
  const netUsdc = multiply(netWei, ethPrice, USDC_UNIT) / multiply(W, usdcPrice);
  return freeze({ schema: "rank1-conservative-economics/v1", targetId: TARGET.id,
    basis: "CALLER_VERIFIED_CONTRACT_ENFORCED_USDC_LOWER_BOUND_NOT_SIMULATED_ESTIMATE",
    profitToken: TARGET.usdc, profitTokenDecimals: 6, contractEnforcedProfitUsdcRaw: profit.toString(),
    additionalReserveUsdcRaw: reserve.toString(), profitHaircutUsdcRaw: haircut.toString(),
    conservativeProfitBeforeGasUsdcRaw: beforeGasUsdc.toString(), conservativeProfitBeforeGasUsdE8: beforeGasUsd.toString(),
    // Wallet guard subtracts gas once from THIS value, not from the reported net.
    conservativeProfitBeforeGasWei: beforeGasWei.toString(), gasLimit: gas.toString(), maxFeePerGasWei: maxFee.toString(),
    nativeGasBudgetWei: gasBudget.toString(), gasCostUsdcRawCeil: gasUsdc.toString(), gasCostUsdE8Ceil: gasUsd.toString(),
    afterGas: { netNativeWei: netWei.toString(), netUsdcRaw: netUsdc.toString(), netUsdE8: netUsd.toString() },
    units: { native: "wei (1e-18 ETH)", usdc: "raw (1e-6 USDC)", usd: "E8 (1e-8 USD)" },
    pin: { number: timestamp(feeds.pin.number, "RANK1_FEEDS_INVALID").toString(), hash: feeds.pin.hash.toLowerCase(), timestamp: at.toString() },
    contextTimestamp: context.toString(), feeds: { ethUsd, usdcUsd }, policy: POLICY,
    positive: true, realizedProfit: "UNKNOWN", settlementVerified: false });
}

module.exports = { TARGET, POLICY, loadRank1SourceProof, verifyRank1Runtime, readRank1Feeds, valueRank1ProfitBeforeGas, valueRank1Profit };
