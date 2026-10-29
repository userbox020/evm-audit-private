#!/usr/bin/env node
"use strict";

// Import-inert near-liquidation Aave V4 runner for Rank #1 (USDC/USDC 0x014e), Rank #2 (wstETH/WETH 0x4cd7), and Rank #5 (USDC/USDC 0x0d3f).
// Shares the atomic wallet lock and journal directory with tools/execute-aave-v4-liquidation.js and tools/execute-top-whale-trigger.js.
const fs = require("node:fs");
const path = require("node:path");
const { Interface, isAddress, keccak256 } = require("./node_modules/ethers");
const guard = require("./lib/wallet-execution-guard.js");
const { createPinnedRpc, loadRpcCandidates, httpRpc, MULTICALL3 } = require("./lib/executor-pinned-rpc.js");
const { MAIN_ACCOUNT, requireThat, uint, safeError, atomicJson } = guard;

const ROOT = path.resolve(__dirname, "..");
const BUNDLE = path.join(ROOT, "coordination/live-execution-batch-aave-v4-near-liquidation-20261019.json");
const STATUS_FILE = path.join(ROOT, "reports/raw/fast/aave-v4-near-liquidation-live-watch.json");
const UNIFIED_LIQUIDATOR = "0xf09a01a6c23b936d5a51abce87a6ec8442a44262";
const DEDICATED_V4_LIQUIDATOR = "0x3c02c96bbb423d0109b823c23a05fcf0bf91ecb7";
const MORPHO_BLUE = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
const UNIV3_SWAP_ROUTER_02 = "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const WSTETH = "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const FEED_IFACE = new Interface([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)"
]);

const MULTICALL_IFACE = new Interface([
  "function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns(tuple(bool success,bytes returnData)[] returnData)"
]);
const DEDICATED_IFACE = new Interface([
  "function previewHealthFactor(address spoke, address user) view returns (uint256 healthFactor, bool isLiquidatable, uint256 totalCollateralValue, uint256 totalDebtValue)",
  "function execute((address spoke,uint256 collateralReserveId,uint256 debtReserveId,address borrower,address debtAsset,address collateralAsset,uint256 flashLoanAmount,uint256 debtToCover,uint256 minSwapOut,uint256 minProfit,uint256 deadline,uint8 venueType,address swapTarget,uint24 uniV3Fee,int128 curveIndexIn,int128 curveIndexOut,bytes customSwapData) plan) external returns (uint256 profitOut)"
]);
const UNIFIED_IFACE = new Interface([
  "function executeMorpho(uint256 flashAmount, (bool isAaveV3,address target,address borrower,address debtToken,address collateralToken,uint256 collateralReserveId,uint256 debtReserveId,uint256 minCollateralSeized,uint8 swapKind,address swapTarget,address swapSpender,uint24 uniFee,int128 curveI,int128 curveJ,uint256 minDebtTokenOut,uint256 minProfitDebtToken) params) external"
]);

const NEAR_TARGET_PLANS = Object.freeze([
  Object.freeze({
    id: "rank1_usdc_usdc_0x014e",
    executorKind: "UNIFIED",
    executor: UNIFIED_LIQUIDATOR,
    spoke: "0x94e7a5dcbe816e498b89ab752661904e2f56c485",
    borrower: "0x014e4921ec5aeeead25192a48028b776601d2c8e",
    collateralReserveId: 7n,
    debtReserveId: 7n,
    collateralAsset: USDC,
    debtAsset: USDC,
    flashLoanAmount: 165000000n,
    debtToCover: 165000000n,
    minSwapOut: 0n,
    minProfit: 5000000n
  }),
  Object.freeze({
    id: "rank2_wsteth_weth_0x4cd7",
    executorKind: "DEDICATED_V4",
    executor: DEDICATED_V4_LIQUIDATOR,
    spoke: "0xe1900480ac69f0b296841cd01cc37546d92f35cd",
    borrower: "0x4cd76521f616db4d6978a4a80aeb77ccc9e890ec",
    collateralReserveId: 0n,
    debtReserveId: 1n,
    collateralAsset: WSTETH,
    debtAsset: WETH,
    flashLoanAmount: 1400000000000000000n,
    debtToCover: (1n << 256n) - 1n,
    minSwapOut: 375000000000000000n,
    minProfit: 2000000000000000n,
    venueType: 0,
    swapTarget: ZERO_ADDR,
    uniV3Fee: 100
  }),
  Object.freeze({
    id: "rank5_usdc_usdc_0x0d3f",
    executorKind: "UNIFIED",
    executor: UNIFIED_LIQUIDATOR,
    spoke: "0xd8b93635b8c6d0ff98cbe90b5988e3f2d1cd9da1",
    borrower: "0x0d3ff01d9a6b4ce46e048e495b9c109b6b5d0933",
    collateralReserveId: 1n,
    debtReserveId: 1n,
    collateralAsset: USDC,
    debtAsset: USDC,
    flashLoanAmount: 1500000000n,
    debtToCover: 1500000000n,
    minSwapOut: 0n,
    minProfit: 20000000n
  })
]);

// Default non-trace callers retain the rank2 hold. Only the trigger-time authenticated
// swap preflight can replace it; execute() profit alone is not a seized-input quote.
const ENABLED_TARGET_IDS = Object.freeze(NEAR_TARGET_PLANS.filter(t => t.collateralAsset === t.debtAsset).map(t => t.id));
const HELD_TARGETS = Object.freeze(NEAR_TARGET_PLANS.filter(t => !ENABLED_TARGET_IDS.includes(t.id))
  .map(t => Object.freeze({ targetId: t.id, reason: "SLIPPAGE_PREFLIGHT_HOLD" })));

const REQUIRED_TARGETS = Object.freeze([
  UNIFIED_LIQUIDATOR,
  DEDICATED_V4_LIQUIDATOR,
  MORPHO_BLUE,
  UNIV3_SWAP_ROUTER_02,
  ...new Set(NEAR_TARGET_PLANS.map(t => t.spoke))
]);

function validateAuthorization(batch, now = Date.now()) {
  requireThat(batch?.schema === "live-execution-batch/v1" && batch.approved === true && Number.isFinite(Date.parse(batch.expiresAt)) && Date.parse(batch.expiresAt) > now, "BATCH_INVALID_OR_EXPIRED");
  return validatePlanPolicy(batch);
}

// Also usable for unsigned readiness checks; this does NOT grant execution authority.
function validatePlanPolicy(batch) {
  requireThat(batch?.schema === "live-execution-batch/v1", "BATCH_SCOPE_MISMATCH");
  requireThat(batch.chainId === 1 && batch.chain === "ethereum" && batch.account?.address?.toLowerCase() === MAIN_ACCOUNT, "BATCH_SCOPE_MISMATCH");
  requireThat(Array.isArray(batch.targets) && Array.isArray(batch.actions), "BATCH_SCOPE_MISMATCH");
  const addresses = batch.targets.map(t => typeof t?.address === "string" ? t.address.toLowerCase() : null);
  requireThat(REQUIRED_TARGETS.every(t => addresses.includes(t.toLowerCase())), "BATCH_TARGET_NOT_APPROVED");
  const c = batch.caps || {}, maxSwapSlippageBps = c.maxSwapSlippageBps;
  requireThat(Number.isInteger(maxSwapSlippageBps) && maxSwapSlippageBps >= 0 && maxSwapSlippageBps <= 50, "BATCH_SLIPPAGE_NOT_APPROVED");
  for (const t of NEAR_TARGET_PLANS) {
    // Structured, affirmative permission binds each borrower to its executor/spoke and fixed plan.
    const actions = batch.actions.filter(a => a?.targetId === t.id);
    requireThat(actions.length === 1, "BATCH_ACTION_NOT_APPROVED");
    const a = actions[0];
    requireThat(a.permission === "EXECUTE_ON_TRIGGER" && a.method === (t.executorKind === "UNIFIED" ? "executeMorpho" : "execute") &&
      ["executor", "spoke", "borrower", "collateralAsset", "debtAsset"].every(k => typeof a[k] === "string" && a[k].toLowerCase() === t[k]) &&
      ["collateralReserveId", "debtReserveId", "flashLoanAmount", "debtToCover", "minProfit"].every(k => a[k] === t[k].toString()), "BATCH_ACTION_NOT_APPROVED");
    // Rank2's absolute floor remains an additional restriction, never a quote substitute.
    requireThat(a.slippage?.mode === (t.collateralAsset === t.debtAsset ? "NO_SWAP_SAME_ASSET" : "QUOTE_RELATIVE") &&
      a.slippage.minSwapOutRaw === t.minSwapOut.toString(), "BATCH_SLIPPAGE_NOT_APPROVED");
    if (t.collateralAsset !== t.debtAsset) requireThat(a.slippage.maxSlippageBps === maxSwapSlippageBps, "BATCH_SLIPPAGE_NOT_APPROVED");
  }
  requireThat(c.valueCapEth === "0" && /^zero \(atomic/.test(c.principalAtRisk || ""), "BATCH_VALUE_CAP_INVALID");
  const gasCap = uint(c.maxExecuteGasLimit, "BATCH_CAP_INVALID");
  const feeCap = uint(c.maxFeePerGasWei, "BATCH_CAP_INVALID");
  const spendCap = uint(c.maxNativeSpendPerTransactionWei, "BATCH_CAP_INVALID");
  const dailyCap = uint(c.signedExecutionsPerDay, "BATCH_CAP_INVALID");
  const minProfitUsdc = uint(c.minProfitUsdcRaw, "BATCH_PROFIT_FLOOR_INVALID");
  const minProfitWeth = uint(c.minProfitWethRaw, "BATCH_PROFIT_FLOOR_INVALID");
  requireThat(gasCap > 0n && feeCap > 0n && spendCap > 0n && dailyCap > 0n && minProfitUsdc >= 5000000n && minProfitWeth >= 2000000000000000n, "BATCH_CAP_INVALID");
  for (const t of NEAR_TARGET_PLANS) {
    requireThat(t.minProfit >= (t.debtAsset === WETH ? minProfitWeth : minProfitUsdc), "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    if (t.executorKind === "DEDICATED_V4") requireThat(t.minSwapOut > 0n, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
  }
  return { gasCap, feeCap, spendCap, dailyCap, minProfitUsdc, minProfitWeth, maxSwapSlippageBps, economics: validateEconomicsPolicy(batch.economics) };
}

function validateEconomicsPolicy(policy) {
  requireThat(policy?.schema === "near-liquidation-economics/v1", "BATCH_ECONOMICS_REQUIRED");
  const raw = key => {
    requireThat(typeof policy[key] === "string" && /^(0|[1-9][0-9]{0,77})$/.test(policy[key]) && BigInt(policy[key]) < (1n << 256n), "BATCH_ECONOMICS_INVALID");
    return policy[key];
  };
  const additionalReserveUsdcRaw = raw("additionalReserveUsdcRaw"), additionalReserveWethRaw = raw("additionalReserveWethRaw");
  const profitHaircutBps = raw("profitHaircutBps");
  requireThat(BigInt(profitHaircutBps) <= 10000n, "BATCH_ECONOMICS_INVALID");
  const feed = key => {
    const f = policy[key];
    requireThat(f && typeof f.address === "string" && isAddress(f.address) && f.address.toLowerCase() !== ZERO_ADDR &&
      Number.isInteger(f.decimals) && f.decimals >= 0 && f.decimals <= 18 && Number.isSafeInteger(f.maxAgeSeconds) && f.maxAgeSeconds > 0, "BATCH_ORACLE_POLICY_INVALID");
    return { address: f.address.toLowerCase(), decimals: f.decimals, maxAgeSeconds: f.maxAgeSeconds };
  };
  const ethUsdFeed = feed("ethUsdFeed"), usdcUsdFeed = feed("usdcUsdFeed");
  requireThat(ethUsdFeed.address !== usdcUsdFeed.address, "BATCH_ORACLE_POLICY_INVALID");
  // Explicit zero reserves/haircut are distinguishable from missing terms. No live defaults.
  return { schema: policy.schema, additionalReserveUsdcRaw, additionalReserveWethRaw, profitHaircutBps, ethUsdFeed, usdcUsdFeed };
}

async function readUsdFeed(pinned, config, description) {
  async function read(method) {
    const raw = await pinned.call({ to: config.address, data: FEED_IFACE.encodeFunctionData(method) });
    try {
      const decoded = FEED_IFACE.decodeFunctionResult(method, raw);
      requireThat(FEED_IFACE.encodeFunctionResult(method, decoded).toLowerCase() === raw.toLowerCase(), "ORACLE_ABI_INVALID");
      return decoded;
    } catch (_) { throw new guard.ExecutionError("ORACLE_ABI_INVALID"); }
  }
  requireThat((await read("decimals"))[0] === BigInt(config.decimals), "ORACLE_DECIMALS_MISMATCH");
  requireThat((await read("description"))[0] === description, "ORACLE_DENOMINATION_MISMATCH");
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = await read("latestRoundData");
  const timestamp = uint(pinned.pin.timestamp, "ORACLE_PIN_TIMESTAMP_INVALID");
  requireThat(answer > 0n, "ORACLE_PRICE_NONPOSITIVE");
  requireThat(roundId > 0n && answeredInRound >= roundId && startedAt > 0n && updatedAt >= startedAt, "ORACLE_ROUND_INCOMPLETE");
  requireThat(timestamp > 0n && startedAt <= timestamp && updatedAt <= timestamp, "ORACLE_FUTURE_TIMESTAMP");
  requireThat(timestamp - updatedAt <= BigInt(config.maxAgeSeconds), "ORACLE_STALE");
  return { ...config, description, roundId: roundId.toString(), answerRaw: answer.toString(), startedAt: startedAt.toString(),
    updatedAt: updatedAt.toString(), answeredInRound: answeredInRound.toString(), ageAtPinSeconds: (timestamp - updatedAt).toString() };
}

const ceilDiv = (n, d) => (n + d - 1n) / d;
const floorDiv = (n, d) => n < 0n ? -ceilDiv(-n, d) : n / d;

async function estimateNetLowerBound(pinned, template, fees, policy) {
  const ethUsd = await readUsdFeed(pinned, policy.ethUsdFeed, "ETH / USD");
  const isWeth = template.debtAsset === WETH;
  requireThat(isWeth || template.debtAsset === USDC, "ECONOMIC_TOKEN_UNSUPPORTED");
  const usdcUsd = isWeth ? null : await readUsdFeed(pinned, policy.usdcUsdFeed, "USDC / USD");
  const ethPrice = BigInt(ethUsd.answerRaw), ethScale = 10n ** BigInt(ethUsd.decimals);
  const tokenPrice = isWeth ? ethPrice : BigInt(usdcUsd.answerRaw), tokenScale = isWeth ? ethScale : 10n ** BigInt(usdcUsd.decimals);
  const tokenDecimals = isWeth ? 18 : 6, tokenUnit = 10n ** BigInt(tokenDecimals), nativeUnit = 10n ** 18n;
  // EIP-1559 maxFee already includes priority fee. Charge the entire padded gas limit ONCE.
  const nativeGasBudget = uint(fees.gasLimit) * uint(fees.maxFeePerGas);
  const gasCost = isWeth ? nativeGasBudget : ceilDiv(nativeGasBudget * ethPrice * tokenScale * tokenUnit, nativeUnit * ethScale * tokenPrice);
  const reserve = BigInt(isWeth ? policy.additionalReserveWethRaw : policy.additionalReserveUsdcRaw);
  const haircut = ceilDiv(template.minProfit * BigInt(policy.profitHaircutBps), 10000n);
  // Repayment and swap/flash costs are already inside the protected post-settlement floor.
  const net = template.minProfit - gasCost - reserve - haircut;
  return {
    kind: "CONDITIONAL_CONSERVATIVE_NET_LOWER_BOUND", basis: "CONTRACT_ENFORCED_POST_SETTLEMENT_PROFIT_FLOOR",
    profitToken: template.debtAsset, profitTokenDecimals: tokenDecimals, contractEnforcedProfitFloorRaw: template.minProfit.toString(),
    gasLimit: fees.gasLimit.toString(), maxFeePerGasWei: fees.maxFeePerGas.toString(), nativeGasBudgetWei: nativeGasBudget.toString(),
    gasCostProfitTokenRaw: gasCost.toString(), gasConversion: isWeth ? "WETH_1_TO_1_NATIVE_ETH" : "CEIL_ETH_USD_DIV_USDC_USD",
    additionalReserveRaw: reserve.toString(), profitHaircutBps: policy.profitHaircutBps, profitHaircutRaw: haircut.toString(),
    netLowerBoundProfitTokenRaw: net.toString(),
    netLowerBoundNativeWei: (isWeth ? net : floorDiv(net * tokenPrice * ethScale * nativeUnit, tokenUnit * tokenScale * ethPrice)).toString(),
    netLowerBoundUsdE8: floorDiv(net * tokenPrice * 100000000n, tokenUnit * tokenScale).toString(), positive: net > 0n,
    pin: { number: pinned.pin.number, hash: pinned.pin.hash, timestamp: pinned.pin.timestamp },
    prices: { ethUsd, ...(usdcUsd ? { usdcUsd } : {}) }, policy,
    realizedNetProfit: "UNKNOWN",
    limitations: "Conditional on successful atomic settlement and pinned prices/explicit reserves; not a realized profit or future-price guarantee. Failed-transaction gas and competition losses are NOT eliminated. Reserves cover additional costs only; settlement costs are not deducted twice."
  };
}

function buildExecutionCalldata(template, nowMs) {
  if (template.executorKind === "UNIFIED") {
    return UNIFIED_IFACE.encodeFunctionData("executeMorpho", [template.flashLoanAmount, {
      isAaveV3: false,
      target: template.spoke,
      borrower: template.borrower,
      debtToken: template.debtAsset,
      collateralToken: template.collateralAsset,
      collateralReserveId: template.collateralReserveId,
      debtReserveId: template.debtReserveId,
      minCollateralSeized: template.minProfit,
      swapKind: 0,
      swapTarget: ZERO_ADDR,
      swapSpender: ZERO_ADDR,
      uniFee: 0,
      curveI: 0,
      curveJ: 0,
      minDebtTokenOut: 0n,
      minProfitDebtToken: template.minProfit
    }]);
  }
  const deadline = BigInt(Math.floor(nowMs / 1000)) + 120n;
  return DEDICATED_IFACE.encodeFunctionData("execute", [{
    spoke: template.spoke,
    collateralReserveId: template.collateralReserveId,
    debtReserveId: template.debtReserveId,
    borrower: template.borrower,
    debtAsset: template.debtAsset,
    collateralAsset: template.collateralAsset,
    flashLoanAmount: template.flashLoanAmount,
    debtToCover: template.debtToCover,
    minSwapOut: template.minSwapOut,
    minProfit: template.minProfit,
    deadline,
    venueType: template.venueType,
    swapTarget: template.swapTarget,
    uniV3Fee: template.uniV3Fee,
    curveIndexIn: 0,
    curveIndexOut: 0,
    customSwapData: "0x"
  }]);
}

async function readHealthBatch(pinned, previewIface = DEDICATED_IFACE) {
  const data = MULTICALL_IFACE.encodeFunctionData("aggregate3", [NEAR_TARGET_PLANS.map(t => ({
    target: DEDICATED_V4_LIQUIDATOR,
    allowFailure: true,
    callData: previewIface.encodeFunctionData("previewHealthFactor", [t.spoke, t.borrower])
  }))]);
  const raw = await pinned.call({ to: MULTICALL3, data });
  const rows = MULTICALL_IFACE.decodeFunctionResult("aggregate3", raw)[0];
  requireThat(rows.length === NEAR_TARGET_PLANS.length && MULTICALL_IFACE.encodeFunctionResult("aggregate3", [rows]).toLowerCase() === raw.toLowerCase(), "HEALTH_BATCH_INVALID");
  return rows.map((r, index) => {
    const t = NEAR_TARGET_PLANS[index];
    if (!r.success) return { id: t.id, executor: t.executor, spoke: t.spoke, borrower: t.borrower, healthFactorRaw: null, isLiquidatableBothProviders: false };
    const d = previewIface.decodeFunctionResult("previewHealthFactor", r.returnData);
    requireThat(previewIface.encodeFunctionResult("previewHealthFactor", d).toLowerCase() === r.returnData.toLowerCase(), "HEALTH_ABI_INVALID");
    return {
      id: t.id,
      executor: t.executor,
      spoke: t.spoke,
      borrower: t.borrower,
      healthFactorRaw: d[0].toString(),
      healthFactorFormatted: (Number(d[0]) / 1e18).toFixed(9),
      bpsToLiquidation: ((Number(d[0]) / 1e18 - 1) * 10000).toFixed(4),
      isLiquidatableBothProviders: d[1] === true && d[0] < 10n ** 18n
    };
  });
}

async function runOnce({ execute = false, argv = [], pinned, batch, loadBatch = () => batch, now = Date.now, writeOut = false, statusFile = STATUS_FILE,
  signTransaction = guard.signWithProcessKey, executionOptions = {}, createRank2Pinned = null }) {
  writeOut = writeOut && !argv.includes("--no-write");
  const rank2Enabled = typeof createRank2Pinned === "function" || (pinned?.evidence?.traceQualified === true && typeof pinned?.trace === "function");
  const enabledTargetIds = rank2Enabled ? NEAR_TARGET_PLANS.map(t => t.id) : ENABLED_TARGET_IDS;
  const heldTargets = rank2Enabled ? [] : HELD_TARGETS;
  try {
    guard.parseMode([...argv, ...(execute ? ["--execute-if-liquidatable"] : [])], "--execute-if-liquidatable");
    let caps, authorizationFailure = null;
    const readinessFailures = [];
    if (execute) caps = validateAuthorization(batch, now());
    else {
      try { validateAuthorization(batch, now()); } catch (error) { authorizationFailure = safeError(error); }
      try { caps = validatePlanPolicy(batch); } catch (error) { readinessFailures.push(safeError(error)); }
      try { validateEconomicsPolicy(batch?.economics); } catch (error) {
        if (!readinessFailures.includes(safeError(error))) readinessFailures.push(safeError(error));
      }
    }
    const targets = (await readHealthBatch(pinned)).map(t => ({ ...t,
      readinessStatus: heldTargets.find(h => h.targetId === t.id)?.reason || (caps ? "READY_FOR_TRIGGER_PREFLIGHT" : "BLOCKED_POLICY")
    }));
    await pinned.recheck();
    const fired = targets.filter(t => t.isLiquidatableBothProviders);
    // Filter before any target execution calldata, simulation, estimate or guarded execution.
    const enabledFired = fired.filter(t => enabledTargetIds.includes(t.id));
    const heldTriggers = heldTargets.filter(h => fired.some(t => t.id === h.targetId));
    if (execute) {
      await guard.reconcileWallet({ ...executionOptions, account: MAIN_ACCOUNT, receiptRpc: hash => pinned.receipt(hash) });
      validateAuthorization(loadBatch(), now());
    }
    const armed = execute && !!caps && enabledTargetIds.length > 0;
    const snapshot = {
      ok: true,
      armed,
      enabledTargetIds,
      armedTargetIds: armed ? enabledTargetIds : [],
      heldTargets,
      heldTriggers,
      checkedAt: new Date(now()).toISOString(),
      mode: execute ? "EXECUTE_IF_LIQUIDATABLE" : "CHECK_ONLY",
      owner: MAIN_ACCOUNT,
      executors: { unified: UNIFIED_LIQUIDATOR, dedicatedV4: DEDICATED_V4_LIQUIDATOR },
      pin: pinned.pin,
      blockNumber: pinned.pin.number,
      evidence: pinned.evidence,
      firedCount: fired.length,
      targets,
      partition: "NEAR_LIQUIDATION_V4_TRIO",
      profitConvention: "CONTRACT_ENFORCED_TOKEN_FLOOR; CONDITIONAL_NET_LOWER_BOUND_AFTER_GAS_AND_EXPLICIT_RESERVES; REALIZED_NET_UNKNOWN",
      executionAuthorization: { valid: authorizationFailure === null, reason: authorizationFailure },
      readinessFailures,
      netEvaluation: !caps ? "BLOCKED_POLICY" : !fired.length ? "NOT_EVALUATED_HEALTHY" : !enabledFired.length ? "SLIPPAGE_PREFLIGHT_HOLD" : "PREFLIGHT_REQUIRED",
      ...(caps && fired.length && !enabledFired.length ? { reason: "SLIPPAGE_PREFLIGHT_HOLD" } : {})
    };
    if (writeOut) atomicJson(statusFile, snapshot);
    if (!caps || !enabledFired.length) return snapshot;

    const preflightFailures = [], preflightResults = [];
    for (const firedTarget of enabledFired) {
      const template = NEAR_TARGET_PLANS.find(t => t.id === firedTarget.id);
      const rank2 = template.id === "rank2_wsteth_weth_0x4cd7";
      let data, transaction, simulation, fees, netEstimate, prepared, minimumOutput, executionPinned = pinned, validationError;
      const validate = async () => {
        try {
          await executionPinned.recheck();
          // Reload after the last await, including immediately before sign and send.
          const currentBatch = loadBatch(), currentCaps = validateAuthorization(currentBatch, now());
          requireThat(JSON.stringify(currentCaps.economics) === JSON.stringify(caps.economics), "BATCH_ECONOMICS_CHANGED");
          if (rank2) {
            requireThat(typeof prepared.policy?.batchId === "string" && prepared.policy.batchId.length > 0 && currentBatch.batchId === prepared.policy.batchId, "BATCH_ID_CHANGED");
            requireThat(BigInt(Math.floor(now() / 1000)) <= BigInt(prepared.deadline), "SWAP_DEADLINE_EXPIRED");
            requireThat(keccak256((transaction || prepared.finalTx).data).toLowerCase() === prepared.finalCalldataHash.toLowerCase(), "FINAL_CALLDATA_MISMATCH");
            requireThat(BigInt(prepared.M) >= minimumOutput(BigInt(prepared.Q), currentCaps.maxSwapSlippageBps), "SLIPPAGE_CAP_TIGHTENED");
          }
          return currentCaps;
        } catch (error) { validationError = error; throw error; }
      };
      const holdRank2 = error => {
        preflightFailures.push({ targetId: template.id, reason: safeError(error) });
        heldTriggers.push({ targetId: template.id, reason: "SLIPPAGE_PREFLIGHT_HOLD" });
      };
      try {
        if (rank2) {
          // Runtime-only import: the helper imports this module's exported plan/ABI.
          const { prepareRank2SwapPreflight, minimumOutput: minOutput } = require("./lib/aave-v4-near-swap-preflight.js");
          minimumOutput = minOutput;
          executionPinned = pinned?.evidence?.traceQualified === true && typeof pinned?.trace === "function" ? pinned : await createRank2Pinned();
          requireThat(executionPinned?.evidence?.traceQualified === true && typeof executionPinned?.trace === "function", "TRACE_QUALIFIED_PAIR_REQUIRED");
          const rank2Health = (await readHealthBatch(executionPinned)).find(t => t.id === template.id);
          await executionPinned.recheck();
          requireThat(rank2Health?.isLiquidatableBothProviders === true, "RANK2_NOT_LIQUIDATABLE");
          prepared = await prepareRank2SwapPreflight({ pinned: executionPinned, batch: loadBatch(), loadBatch, now });
          requireThat(prepared?.status === "SIMULATION_ONLY", "RANK2_SWAP_PREFLIGHT_NOT_READY");
          data = prepared.finalTx.data;
          fees = { gasLimit: BigInt(prepared.fees.gasLimit), maxFeePerGas: BigInt(prepared.fees.maxFeePerGas), maxPriorityFeePerGas: BigInt(prepared.fees.maxPriorityFeePerGas) };
          netEstimate = prepared.netEstimate;
          simulation = { kind: "TRACE_AND_CALL_AUTHENTICATED_SWAP_PREFLIGHT", seizedCollateralRaw: prepared.evidence.discovery.C,
            quoteOutputWethRaw: prepared.Q, minSwapOutWethRaw: prepared.M,
            simulatedProfitBeforeGasRaw: prepared.evidence.callProfitRaw, deadline: prepared.deadline, finalCalldataHash: prepared.finalCalldataHash };
          await validate(); // A stale trigger is held before creating any wallet intent.
        } else {
          data = buildExecutionCalldata(template, now());
          const call = { from: MAIN_ACCOUNT, to: template.executor, data };
          const raw = await pinned.call(call);
          UNIFIED_IFACE.decodeFunctionResult("executeMorpho", raw);
          requireThat(raw === "0x", "EXECUTION_ABI_INVALID");
          simulation = { kind: "NO_RETURN_SUCCESS_CONTRACT_ENFORCED_LOWER_BOUND", contractEnforcedProfitFloorRaw: template.minProfit.toString() };
          fees = guard.buildFees(await pinned.estimateGas(call), pinned.pin.baseFeePerGas, caps);
          netEstimate = await estimateNetLowerBound(pinned, template, fees, caps.economics);
          await pinned.recheck();
        }
        requireThat(netEstimate.positive, "CONSERVATIVE_NET_NONPOSITIVE");
      } catch (error) {
        if (rank2) holdRank2(error);
        else {
          pinned.assertUsable();
          preflightFailures.push({ targetId: template.id, reason: safeError(error), ...(netEstimate ? { netEstimate } : {}) });
        }
        continue;
      }
      preflightResults.push({ targetId: template.id, simulation, netEstimate });
      if (!execute) continue; // Never reconcile, request a nonce, access keys or invoke a signer in check-only.
      let receipt, signingAttempted = false;
      try { receipt = await guard.executeGuarded({
        ...executionOptions,
        now,
        account: MAIN_ACCOUNT,
        intent: {
          targetId: template.id,
          to: template.executor,
          profitToken: template.debtAsset,
          pinHash: executionPinned.pin.hash,
          simulation,
          contractEnforcedProfitFloorBeforeGasRaw: template.minProfit.toString(),
          netEstimate
        },
        prepare: async () => {
          await validate();
          const nonce = Number(uint(await executionPinned.nonce(MAIN_ACCOUNT)));
          transaction = { type: 2, chainId: 1, nonce, to: template.executor, data, value: 0n, ...fees };
          return { transaction, caps: validateAuthorization(loadBatch(), now()) };
        },
        validate,
        signTransaction: rank2 ? async tx => { signingAttempted = true; return signTransaction(tx); } : signTransaction,
        sendRawTransaction: signed => executionPinned.send(signed),
        receiptRpc: (hash, timeoutMs) => executionPinned.receipt(hash, timeoutMs)
      }); } catch (error) {
        // Never clear or step past PREPARED/SENT/UNCERTAIN intents to try another target.
        if (!rank2 || error !== validationError || signingAttempted || guard.readJournals(executionOptions.journalDir, MAIN_ACCOUNT)
          .some(({ record }) => ["PREPARED", "SENT", "UNCERTAIN"].includes(record.stage))) throw error;
        preflightResults.pop(); holdRank2(error); continue;
      }
      const stillArmed = !["PREPARED", "SENT", "UNCERTAIN"].includes(receipt.stage);
      const out = { ...snapshot, netEvaluation: "POSITIVE_CONDITIONAL_LOWER_BOUND", preflightResults, preflightFailures,
        armed: stillArmed, armedTargetIds: stillArmed ? enabledTargetIds : [], execution: receipt };
      if (writeOut) atomicJson(statusFile, out);
      return out;
    }
    const rank2OnlyHold = !preflightResults.length && enabledFired.length > 0 && enabledFired.every(t => t.id === "rank2_wsteth_weth_0x4cd7");
    const out = { ...snapshot,
      armed: rank2OnlyHold ? snapshot.armed : false,
      armedTargetIds: rank2OnlyHold && snapshot.armed ? ENABLED_TARGET_IDS : [],
      heldTargets: rank2OnlyHold ? HELD_TARGETS : snapshot.heldTargets,
      netEvaluation: preflightResults.length ? "POSITIVE_CONDITIONAL_LOWER_BOUND" : rank2OnlyHold ? "SLIPPAGE_PREFLIGHT_HOLD" : "BLOCKED_PREFLIGHT",
      reason: preflightResults.length ? "CHECK_ONLY_NO_SIGNING" : rank2OnlyHold ? "SLIPPAGE_PREFLIGHT_HOLD" : "NO_FIRED_TARGET_PASSED_PREFLIGHT",
      preflightResults, preflightFailures };
    if (writeOut) atomicJson(statusFile, out);
    return out;
  } catch (error) {
    let keepPrev = false;
    if (argv.includes("--loop") && writeOut && fs.existsSync(statusFile)) {
      try {
        const prev = JSON.parse(fs.readFileSync(statusFile, "utf8"));
        if (prev?.ok === true && now() - Date.parse(prev.checkedAt) <= 600000) keepPrev = true;
      } catch (_) {}
    }
    if (writeOut && !keepPrev) atomicJson(statusFile, { ok: false, armed: false, enabledTargetIds, armedTargetIds: [], heldTargets,
      mode: "BLOCKED", checkedAt: new Date(now()).toISOString(), reason: safeError(error) });
    throw error;
  }
}

function computeNearPollIntervalMs(status, baseIntervalMs = 12000) {
  if (status?.execution?.stage === "RECEIPT_VERIFIED" && status?.armed === true) return 0;
  if (Array.isArray(status?.targets) && status.targets.some(t => t && (t.isLiquidatableBothProviders === true ||
    (t.bpsToLiquidation !== null && t.bpsToLiquidation !== undefined && Number.isFinite(Number(t.bpsToLiquidation)) && Number(t.bpsToLiquidation) <= 5.0)))) {
    return Math.min(baseIntervalMs, 6000);
  }
  return baseIntervalMs;
}

async function main(argv = process.argv.slice(2)) {
  const { execute, writeOut } = guard.parseMode(argv, "--execute-if-liquidatable"), loop = argv.includes("--loop");
  const explicitInterval = argv.find(a => a.startsWith("--interval-ms="))?.split("=")[1];
  const interval = Math.max(6000, Number(explicitInterval) || 12000);
  do {
    let waitMs = interval;
    try {
      const batch = JSON.parse(fs.readFileSync(BUNDLE, "utf8"));
      if (execute) validateAuthorization(batch, Date.now());
      const pinned = await createPinnedRpc({ candidates: loadRpcCandidates(), rpc: httpRpc });
      const out = await runOnce({ execute, argv, writeOut, pinned, batch, loadBatch: () => JSON.parse(fs.readFileSync(BUNDLE, "utf8")),
        createRank2Pinned: () => createPinnedRpc({ candidates: loadRpcCandidates(), rpc: httpRpc, requireTrace: true }) });
      if (!explicitInterval) waitMs = computeNearPollIntervalMs(out, interval);
      console.log(JSON.stringify(out));
      if (out.execution || (execute && out.armed === false)) return;
    } catch (error) {
      let keepPrev = false;
      if (loop && writeOut && fs.existsSync(STATUS_FILE)) {
        try {
          const prev = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
          if (prev?.ok === true && Date.now() - Date.parse(prev.checkedAt) <= 600000) keepPrev = true;
        } catch (_) {}
      }
      if (writeOut && !keepPrev) atomicJson(STATUS_FILE, { ok: false, armed: false, mode: "BLOCKED",
        checkedAt: new Date().toISOString(), reason: safeError(error) });
      console.error(JSON.stringify({ ok: false, reason: safeError(error) }));
      if (!(loop && error instanceof guard.ExecutionError && error.code === "WALLET_LOCK_HELD")) {
        process.exitCode = 1;
        return;
      }
    }
    if (loop && waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
  } while (loop);
}

module.exports = {
  NEAR_TARGET_PLANS,
  REQUIRED_TARGETS,
  UNIFIED_LIQUIDATOR,
  DEDICATED_V4_LIQUIDATOR,
  MULTICALL_IFACE,
  DEDICATED_IFACE,
  UNIFIED_IFACE,
  FEED_IFACE,
  validateAuthorization,
  validateEconomicsPolicy,
  estimateNetLowerBound,
  buildExecutionCalldata,
  readHealthBatch,
  runOnce,
  computeNearPollIntervalMs,
  main
};
if (require.main === module) main();
