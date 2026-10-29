#!/usr/bin/env node
"use strict";

// Armed Base Morpho Blue yoUSD/USDC and USDe/USDC runner (#B7, #B0, #B4, #B5, #B6, #B1, #B2)
// using deployed MorphoLiquidateUnwindBaseRoundTrip.
// Enforces approved Base batch, pinned header + accrued wTaylorCompounded HF < 1.0,
// eth_call + eth_estimateGas preflight, shared atomic wallet lock, and USDC receipt verification.

const fs = require("node:fs");
const path = require("node:path");
const { Interface } = require("./node_modules/ethers");
const guard = require("./lib/wallet-execution-guard.js");
const valuation = require("./morpho-unwind-valuation.js");
const { wTaylorCompounded, createStickyResolver } = require("./watch-top-whale-triggers.js");
const { resolveRpc, rpcCall } = require("./shared-rpc.js");

const { MAIN_ACCOUNT, ExecutionError, requireThat, uint, safeError, atomicJson } = guard;
const ROOT = path.resolve(__dirname, "..");
const BUNDLE = path.join(ROOT, "coordination/live-execution-batch-base-morpho-20261020.json");
const DEPLOY_RECEIPT = path.join(ROOT, "reports/raw/fast/base-morpho-liquidator-stage-20261020/mainnet-deployment-receipt.json");
const STATUS_FILE = path.join(ROOT, "reports/raw/fast/base-morpho-executor-live-watch.json");
const DEFAULT_BASE_JOURNAL_DIR = path.join(ROOT, "reports/raw/fast/base-morpho-liquidator-execution");
const ARTIFACT = require("./fork-poc/contracts/MorphoLiquidateUnwindBaseRoundTrip.compiled.json");

const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const BASE_MORPHO = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BASE_USDE = "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34";
const BASE_USDE_MKT = "0x54cf9be57fdfa6457a660991907434ff9d295c465a603a50126ff647d50b7354";
const BASE_USDE_ORACLE = "0xf4b17c79492d68775e22e8dd0a2bb22854a39a47";
const BASE_YOUSD = "0x0000000f2eb9f69274678c76222b35eec7588a65";
const BASE_YOUSD_MKT = "0x1a3e69d0109bb1be42b80e11034bb6ee98fc466721f26845dc83b2aa8d979137";
const BASE_YOUSD_ORACLE = "0x77f59c5c09e7abef6991b456170930324fe36222";
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const BASE_WSTETH = "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452";
const BASE_WSTETH_MKT = "0x6aa81f51dfc955df598e18006deae56ce907ac02b0b5358705f1a28fcea23cc0";
const BASE_WSTETH_ORACLE = "0xae10cbdaa587646246c8253e4532a002ee4fa7a4";
const BASE_WEETH = "0x04c0599ae5a44757c0af6f9ec3b93da8976c150a";
const BASE_WEETH_MKT = "0xfd0895ba253889c243bf59bc4b96fd1e06d68631241383947b04d1c293a0cfea";
const BASE_WEETH_ORACLE = "0xce629400c6aedb64f087cac40ae6a382aeeef490";
const BASE_AERO_CL_ROUTER = "0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5";
const BASE_IRM = "0x46415998764c29ab2a25cbea6254146d50d22687";
const BASE_SWAP_ROUTER_02 = "0x2626664c2603336e57b271c5c0b26f421741e481";
const BASE_QUOTER_V2 = "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a";
const BASE_GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000f";
const LLTV = 915000000000000000n;
const LLTV_945 = 945000000000000000n;
const LLTV_965 = 965000000000000000n;
const LIF_915 = 1026167265264238070n;
const LIF_945 = 1016776817488561260n;
const LIF_965 = 1010611419909044972n;
const W = 10n ** 18n;
const V = 10n ** 6n;
const ceil = (a, b) => (a + b - 1n) / b;

const MC_IFACE = new Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)"
]);
const BLUE_IFACE = new Interface([
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function position(bytes32,address) view returns (uint256,uint128,uint128)"
]);
const ORACLE_IFACE = new Interface(["function price() view returns (uint256)"]);
const IRM_IFACE = new Interface([
  "function borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128)) view returns (uint256)"
]);
const EXEC_IFACE = new Interface(ARTIFACT.abi);
const QUOTER_V2_IFACE = new Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"
]);
const L1_GAS_ORACLE_IFACE = new Interface(["function getL1Fee(bytes data) view returns (uint256)"]);
const ERC4626_IFACE = new Interface([
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
  "function redeem(uint256 shares,address receiver,address owner) returns (uint256 assets)",
]);
const AERO_CL_ROUTER_IFACE = new Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
]);
const BASE_UNIVERSAL_EXECUTOR = "0x86d446bafcd87737d0b763f1e8af65e5c424ba53";
const BASE_EULER_EVK_EXECUTOR = "0x0aaa75499fbcb7db821c3aefc84433a53cdeb9b9";
const BASE_EULER_B12_LIAB = "0x4c1aeda9b43efcf1da1d1755b18802aabe90f61e";
const BASE_EULER_B12_COL = "0xd54d33da9c326aee7513cefdeda5c93a41809cad";
const BASE_EULER_B12_WTSPYM = "0x31c2c14134e6e3b7ef9478297f199331133fc2d8";
const BASE_EULER_B12_POOL = "0x7796fc53b75960a9762ba267c19f5da9868b7853";
const BASE_EULER_B12_USER = "0x17914d576bd7d14a14bdf187d1c72b194c61e358";
const BASE_EULER_B13_COL = "0x2645cbaf62f2f336b0e988375d7e6bcab66a296c";
const BASE_EULER_B13_WTCOIN = "0x5cda0e1ca4ce2af96315f7f8963c85399c172204";
const BASE_EULER_B13_POOL = "0xab5d32ff95b58bd5e77de08738a391973ee88c81";
const BASE_EULER_B13_USER = "0x17914d576bd7d14a14bdf187d1c72b194c61e35b";
const EVK_LIQ_IFACE = new Interface([
  "function accountLiquidity(address account, bool liquidation) view returns (uint256 collateralValue, uint256 liabilityValue)"
]);
const UNIVERSAL_EULER_EXEC_IFACE = new Interface([
  "function execute((address loanToken,address liabilityVault,address collateralVault,address underlyingCollateral,address violator,uint256 repayAssets,uint256 maxRepayAssets,uint256 minYieldShares,uint8 unwindKind,address swapTarget,int128 curveI,int128 curveJ,bytes swapPath,uint256 minLoanOut) plan) external returns (uint256 profitOut)"
]);
const BASE_FLUID_RESOLVER = "0xa5c3e16523eeeddcc34706b0e6be88b4c6ea95cc";
const BASE_FLUID_VAULT_48 = "0x59fa2f51f5c8fffceb538180ec47a869ec3dbd4a";
const BASE_FLUID_VAULT_48_WHALE = "0x7e0371ec1177d3cf177a1a9a87dbc1e1864cd828";
const FLUID_RESOLVER_IFACE = new Interface([
  "function getVaultLiquidation(address vault_, uint256 tokenInAmt_) view returns ((address vault,address token0In,address token0Out,address token1In,address token1Out,uint256 inAmt,uint256 outAmt,uint256 inAmtWithAbsorb,uint256 outAmtWithAbsorb,bool absorbAvailable))"
]);
const UNIVERSAL_EXEC_IFACE = new Interface([
  "function execute((uint8 mode,address loanToken,uint256 flashAmount,address collateralToken,address oracle,address irm,uint256 lltv,address borrower,uint256 seizedAssets,address fluidVault,uint256 token0DebtAmt,uint256 token1DebtAmt,uint256 debtSharesMin,uint256 colPerUnitDebt,uint256 token0ColAmtPerUnitShares,uint256 token1ColAmtPerUnitShares,bool absorb,address approveToken1,address target1,bytes data1,address approveToken2,address target2,bytes data2,uint256 minProfit) plan) external returns (uint256 profitOut)"
]);

const BASE_TARGET_PLANS = Object.freeze([
  { id: "base-b7-yousd-usdc-0x108b", rank: "#B7", borrower: "0x108b853407284e77656c569677c82e8fed581299", kind: "YOUSD_REDEEM", maxSeizeYoUsd: 4100000000n, minProfitUsdc: 100000000n },
  { id: "base-b0-usde-usdc-0x6075", rank: "#B0", borrower: "0x60753e8622a6cfea1df449a9625a9778bb922b72", maxSeizeUsde: 345000n * W, minProfitUsdc: 100000000n },
  { id: "base-b4-usde-usdc-0x7dcd", rank: "#B4", borrower: "0x7dcdb4ad4017f848879d17370aa6f32564e5cd08", maxSeizeUsde: 680000n * W, minProfitUsdc: 100000000n },
  { id: "base-b5-usde-usdc-0x8986", rank: "#B5", borrower: "0x8986f93988d415abfb7b9bb700ccd3580c2f5298", maxSeizeUsde: 680000n * W, minProfitUsdc: 100000000n },
  { id: "base-b6-usde-usdc-0xae0a", rank: "#B6", borrower: "0xae0a739c3724bb5cd2bdcf73764c87a5a6ec21a3", maxSeizeUsde: 680000n * W, minProfitUsdc: 100000000n },
  { id: "base-b1-usde-usdc-0xb4fb", rank: "#B1", borrower: "0xb4fb31e7b1471a8e52dd1e962a281a732ead59c1", maxSeizeUsde: 680000n * W, minProfitUsdc: 100000000n },
  { id: "base-b2-usde-usdc-0x7bee", rank: "#B2", borrower: "0x7bee8d37fba61a6251a08b957d502c56e2a50fab", maxSeizeUsde: 680000n * W, minProfitUsdc: 100000000n },
].map(Object.freeze));
const USDE_TARGET_PLANS = BASE_TARGET_PLANS.filter(plan => plan.kind !== "YOUSD_REDEEM");
const BASE_WSTETH_PLAN = Object.freeze({
  id: "base-b8-wsteth-weth-0x10c5",
  rank: "#B8",
  borrower: "0x10c53e75fe7a7e6bf58a9e68b6a30fcc7d4e6e2c",
  kind: "WSTETH_WETH",
  maxSeizeWsteth: 14150000000000000000n,
  minProfitUsdc: 50000000000000000n, // 0.05 WETH floor (18 decimals)
});
const BASE_WEETH_PLAN = Object.freeze({
  id: "base-b9-weeth-weth-0x9558",
  rank: "#B9",
  borrower: "0x9558b339bb03246c44c57fcee184645dbfab253f",
  kind: "WEETH_WETH",
  maxSeizeWeeth: 19000000000000000000n,
  minProfitUsdc: 50000000000000000n, // 0.05 WETH floor (18 decimals)
});
const BASE_B10_YOUSD_PLAN = Object.freeze({
  id: "base-b10-yousd-usdc-0xd406",
  rank: "#B10",
  borrower: "0xd406c93c8227ef08dc8ef0dfa027786bb85b756b",
  kind: "YOUSD_REDEEM",
  maxSeizeYoUsd: 70000000n,
  minProfitUsdc: 1000000n, // $1.00 USDC floor (vs $0.002 Base gas)
  usePlanMinProfit: true,
});
const BASE_B14_USDE_PLAN = Object.freeze({
  id: "base-b14-usde-usdc-0x6efc",
  rank: "#B14",
  borrower: "0x6efc48b8b6222924fa6ea95d174af5518b761177",
  maxSeizeUsde: 680000n * W,
  minProfitUsdc: 100000000n,
});
const BASE_B15_YOUSD_PLAN = Object.freeze({
  id: "base-b15-yousd-usdc-0x5c2a",
  rank: "#B15",
  borrower: "0x5c2a8098c392fde0fa736e598ced595a9d6eb0b8",
  kind: "YOUSD_REDEEM",
  maxSeizeYoUsd: 221600000000n,
  minProfitUsdc: 100000000n,
});

function computeBasePollIntervalMs(status, baseIntervalMs = 10000) {
  if (status?.execution?.stage === "RECEIPT_VERIFIED" && status?.armed === true) return 0;
  if (Array.isArray(status?.targets) && status.targets.some(t => t && (t.isLiquidatable === true ||
    (t.bpsToLiquidation !== null && Number.isFinite(Number(t.bpsToLiquidation)) && Number(t.bpsToLiquidation) <= 5.0)))) {
    return Math.min(baseIntervalMs, 3500);
  }
  return baseIntervalMs;
}

function validateBaseAuthorization(batch, now = Date.now()) {
  requireThat(batch?.schema === "live-execution-batch/v1" && batch.approved === true &&
    Number.isFinite(Date.parse(batch.expiresAt)) && Date.parse(batch.expiresAt) > now, "BATCH_INVALID_OR_EXPIRED");
  requireThat(batch.chainId === 8453 && batch.chain === "base" &&
    batch.account?.address?.toLowerCase() === MAIN_ACCOUNT, "BATCH_SCOPE_MISMATCH");
  requireThat(Array.isArray(batch.targets) && batch.targets.some(t => t.address?.toLowerCase() === BASE_MORPHO) &&
    batch.targets.some(t => t.address?.toLowerCase() === BASE_SWAP_ROUTER_02), "BATCH_TARGET_NOT_APPROVED");
  requireThat(Array.isArray(batch.actions) && batch.actions.some(a => typeof a === "string" &&
    a.startsWith("EXECUTE_ON_TRIGGER_BASE: MorphoLiquidateUnwindBaseRoundTrip.execute(Plan, swapData)")), "BATCH_ACTION_NOT_APPROVED");
  const c = batch.caps || {};
  const gasCap = uint(c.maxExecuteGasLimitBase, "BATCH_CAP_INVALID");
  const spendCap = uint(c.maxNativeSpendPerTransactionWeiBase, "BATCH_CAP_INVALID");
  const dailyCap = uint(c.signedExecutionsPerDayBase, "BATCH_CAP_INVALID");
  const minProfitUsdc = uint(c.minProfitUsdcRawBase, "BATCH_CAP_INVALID");
  requireThat(c.valueCapEthBase === "0" && gasCap > 0n && spendCap > 0n && dailyCap > 0n && minProfitUsdc >= 100000000n, "BATCH_CAP_INVALID");
  return { gasCap, spendCap, feeCap: null, dailyCap, minProfitUsdc };
}

function maxSeizeByBorrowShares(borrowerSharesRaw, accruedBorrowAssetsRaw, totalBorrowSharesRaw, oraclePriceRaw) {
  const dMax = (BigInt(borrowerSharesRaw) * (BigInt(accruedBorrowAssetsRaw) + 1n)) / (BigInt(totalBorrowSharesRaw) + V);
  const qMax = (dMax * LIF_915) / W;
  return (qMax * (10n ** 36n)) / BigInt(oraclePriceRaw);
}

function buildBaseExecutionCalldata(executorAddress, plan, collSharesRaw, oraclePriceRaw, quotedUsdcOutRaw = null, shareBound = null) {
  const maxColl = BigInt(collSharesRaw);
  if (plan.kind === "YOUSD_REDEEM") {
    let seize = maxColl < plan.maxSeizeYoUsd ? maxColl : plan.maxSeizeYoUsd;
    const hasShareBound = shareBound && shareBound.borrowerShares !== undefined && shareBound.accruedBorrow !== undefined && shareBound.totalBorrowShares !== undefined;
    if (hasShareBound) {
      const shareCap = maxSeizeByBorrowShares(shareBound.borrowerShares, shareBound.accruedBorrow, shareBound.totalBorrowShares, oraclePriceRaw);
      if (shareCap < seize) seize = shareCap;
    }
    requireThat(seize > 0n, "BASE_ZERO_COLLATERAL");
    const principal = seize * BigInt(oraclePriceRaw) / (10n ** 36n);
    let repayEstUsdc = ceil(ceil(seize * BigInt(oraclePriceRaw), 10n ** 36n) * W, LIF_915);
    if (hasShareBound) {
      const repaidShares = ceil(repayEstUsdc * (BigInt(shareBound.totalBorrowShares) + V), BigInt(shareBound.accruedBorrow) + 1n);
      repayEstUsdc = ceil(repaidShares * (BigInt(shareBound.accruedBorrow) + 1n), BigInt(shareBound.totalBorrowShares) + V);
    }
    if (quotedUsdcOutRaw !== null && quotedUsdcOutRaw !== undefined) {
      requireThat(BigInt(quotedUsdcOutRaw) >= repayEstUsdc + BigInt(plan.minProfitUsdc), "QUOTE_BELOW_PROFIT_FLOOR");
    }
    // The executor checks total loan balance before repaying the flash principal.
    const minLoanOut = principal + BigInt(plan.minProfitUsdc);
    const swapData = ERC4626_IFACE.encodeFunctionData("redeem", [seize, executorAddress, executorAddress]);
    return { seize, principal, repayEstUsdc, minLoanOut,
      data: EXEC_IFACE.encodeFunctionData("execute", [[BASE_USDC, BASE_YOUSD, BASE_YOUSD_ORACLE, BASE_IRM,
        LLTV, plan.borrower, seize, BASE_YOUSD, minLoanOut], swapData]) };
  }
  if (plan.kind === "WSTETH_WETH") {
    let seize = maxColl > 0n && maxColl < plan.maxSeizeWsteth ? maxColl : plan.maxSeizeWsteth;
    const hasShareBound = shareBound && shareBound.borrowerShares !== undefined && shareBound.accruedBorrow !== undefined && shareBound.totalBorrowShares !== undefined;
    if (hasShareBound) {
      const dMax = (BigInt(shareBound.borrowerShares) * (BigInt(shareBound.accruedBorrow) + 1n)) / (BigInt(shareBound.totalBorrowShares) + V);
      const qMax = (dMax * LIF_965) / W;
      const shareCap = (qMax * (10n ** 36n)) / BigInt(oraclePriceRaw);
      if (shareCap < seize) seize = shareCap;
    }
    requireThat(seize > 0n, "BASE_ZERO_COLLATERAL");
    const principal = (seize * BigInt(oraclePriceRaw)) / (10n ** 36n);
    const repayEstWeth = ceil(ceil(seize * BigInt(oraclePriceRaw), 10n ** 36n) * W, LIF_965);
    const minProfitWeth = 50000000000000000n;
    if (quotedUsdcOutRaw !== null && quotedUsdcOutRaw !== undefined) {
      requireThat(BigInt(quotedUsdcOutRaw) >= repayEstWeth + minProfitWeth, "QUOTE_BELOW_PROFIT_FLOOR");
    }
    const minLoanOut = principal + minProfitWeth;
    const swapData = valuation.encodeSwapData({
      hops: [BASE_WSTETH, BASE_WETH],
      fees: [100],
      recipient: executorAddress,
      amountIn: seize,
      amountOutMinimum: repayEstWeth + minProfitWeth,
    });
    return {
      seize,
      principal,
      repayEstUsdc: repayEstWeth,
      minLoanOut,
      data: EXEC_IFACE.encodeFunctionData("execute", [[BASE_WETH, BASE_WSTETH, BASE_WSTETH_ORACLE, BASE_IRM,
        LLTV_965, plan.borrower, seize, BASE_SWAP_ROUTER_02, minLoanOut], swapData]),
    };
  }
  if (plan.kind === "WEETH_WETH") {
    let seize = maxColl > 0n && maxColl < plan.maxSeizeWeeth ? maxColl : plan.maxSeizeWeeth;
    const hasShareBound = shareBound && shareBound.borrowerShares !== undefined && shareBound.accruedBorrow !== undefined && shareBound.totalBorrowShares !== undefined;
    if (hasShareBound) {
      const dMax = (BigInt(shareBound.borrowerShares) * (BigInt(shareBound.accruedBorrow) + 1n)) / (BigInt(shareBound.totalBorrowShares) + V);
      const qMax = (dMax * LIF_945) / W;
      const shareCap = (qMax * (10n ** 36n)) / BigInt(oraclePriceRaw);
      if (shareCap < seize) seize = shareCap;
    }
    requireThat(seize > 0n, "BASE_ZERO_COLLATERAL");
    const principal = (seize * BigInt(oraclePriceRaw)) / (10n ** 36n);
    const repayEstWeth = ceil(ceil(seize * BigInt(oraclePriceRaw), 10n ** 36n) * W, LIF_945);
    const minProfitWeth = 50000000000000000n;
    const minLoanOut = principal + minProfitWeth;
    const swapData = AERO_CL_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [{
      tokenIn: BASE_WEETH,
      tokenOut: BASE_WETH,
      tickSpacing: 1,
      recipient: executorAddress,
      deadline: 9999999999n,
      amountIn: seize,
      amountOutMinimum: repayEstWeth + minProfitWeth,
      sqrtPriceLimitX96: 0,
    }]);
    return {
      seize,
      principal,
      repayEstUsdc: repayEstWeth,
      minLoanOut,
      data: EXEC_IFACE.encodeFunctionData("execute", [[BASE_WETH, BASE_WEETH, BASE_WEETH_ORACLE, BASE_IRM,
        LLTV_945, plan.borrower, seize, BASE_AERO_CL_ROUTER, minLoanOut], swapData]),
    };
  }
  let seize = maxColl > 0n && maxColl < plan.maxSeizeUsde ? maxColl : plan.maxSeizeUsde;
  if (plan.id === "base-b14-usde-usdc-0x6efc" && shareBound && shareBound.borrowerShares !== undefined && shareBound.accruedBorrow !== undefined && shareBound.totalBorrowShares !== undefined) {
    const shareCap = maxSeizeByBorrowShares(shareBound.borrowerShares, shareBound.accruedBorrow, shareBound.totalBorrowShares, oraclePriceRaw);
    if (shareCap < seize) seize = shareCap;
  }
  requireThat(seize > 0n, "BASE_ZERO_COLLATERAL");
  const seizedQuotedUsdc = ceil(seize * BigInt(oraclePriceRaw), 10n ** 36n);
  const repayEstUsdc = ceil(seizedQuotedUsdc * W, LIF_915);
  const floorByProfit = repayEstUsdc + BigInt(plan.minProfitUsdc);
  let minLoanOut = floorByProfit;
  if (quotedUsdcOutRaw !== null && quotedUsdcOutRaw !== undefined) {
    requireThat(BigInt(quotedUsdcOutRaw) >= floorByProfit, "QUOTE_BELOW_PROFIT_FLOOR");
    const slippageFloor = (BigInt(quotedUsdcOutRaw) * 9950n) / 10000n;
    requireThat(slippageFloor >= floorByProfit, "SLIPPAGE_FLOOR_BELOW_PROFIT_FLOOR");
    minLoanOut = slippageFloor > floorByProfit ? slippageFloor : floorByProfit;
  }
  const swapData = valuation.encodeSwapData({
    hops: [BASE_USDE, BASE_USDC],
    fees: [500],
    recipient: executorAddress,
    amountIn: seize,
    amountOutMinimum: minLoanOut,
  });
  const tuple = [
    BASE_USDC,
    BASE_USDE,
    BASE_USDE_ORACLE,
    BASE_IRM,
    LLTV,
    plan.borrower,
    seize,
    BASE_SWAP_ROUTER_02,
    minLoanOut,
  ];
  return {
    seize,
    repayEstUsdc,
    minLoanOut,
    data: EXEC_IFACE.encodeFunctionData("execute", [tuple, swapData]),
  };
}

async function runBaseOnce({
  execute = false,
  argv = [],
  executorAddress,
  batch,
  loadBatch = () => batch,
  resolve = resolveRpc,
  transport = rpcCall,
  secondaryRpc = null,
  requireLiveQuote = false,
  includeWsteth = false,
  now = Date.now,
  writeOut = false,
  statusFile = STATUS_FILE,
  signTransaction = guard.signWithProcessKey,
  executionOptions = {},
}) {
  writeOut = writeOut && !argv.includes("--no-write");
  try {
    guard.parseMode([...argv, ...(execute ? ["--execute-if-liquidatable"] : [])], "--execute-if-liquidatable");
    requireThat(typeof executorAddress === "string" && /^0x[0-9a-f]{40}$/i.test(executorAddress), "EXECUTOR_ADDRESS_INVALID");
    const execAddr = executorAddress.toLowerCase();
    const caps = execute ? validateBaseAuthorization(batch, now()) : null;

    const rpcBase = await resolve(8453);
    requireThat(Boolean(rpcBase), "BASE_RPC_UNAVAILABLE");
    const chainHex = await transport(rpcBase, "eth_chainId", [], 10000);
    requireThat(typeof chainHex === "string" && /^0x[0-9a-f]+$/i.test(chainHex) && BigInt(chainHex) === 8453n, "WRONG_CHAIN");
    const block = await transport(rpcBase, "eth_getBlockByNumber", ["latest", false], 10000);
    requireThat(block && /^0x[0-9a-f]{64}$/i.test(block.hash) && /^0x[0-9a-f]+$/i.test(block.number) && /^0x[0-9a-f]+$/i.test(block.timestamp), "PIN_HEADER_INVALID");
    const pinNumber = Number(BigInt(block.number));
    const pinTs = BigInt(block.timestamp);
    const baseFee = BigInt(block.baseFeePerGas || "0x5f5e10");
    const pinRef = { blockHash: block.hash, requireCanonical: true };
    if (secondaryRpc !== null && secondaryRpc !== undefined) {
      const secondaryChain = await transport(secondaryRpc, "eth_chainId", [], 10000);
      requireThat(typeof secondaryChain === "string" && /^0x[0-9a-f]+$/i.test(secondaryChain) && BigInt(secondaryChain) === 8453n, "BASE_SECONDARY_PIN_MISMATCH");
      const secondaryBlock = await transport(secondaryRpc, "eth_getBlockByNumber", [block.number, false], 10000);
      requireThat(typeof secondaryBlock?.hash === "string" && secondaryBlock.hash.toLowerCase() === block.hash.toLowerCase(), "BASE_SECONDARY_PIN_MISMATCH");
    }

    const calls1 = [
      { target: BASE_MORPHO, allowFailure: true, callData: BLUE_IFACE.encodeFunctionData("market", [BASE_USDE_MKT]) },
      { target: BASE_USDE_ORACLE, allowFailure: true, callData: ORACLE_IFACE.encodeFunctionData("price", []) },
      ...USDE_TARGET_PLANS.map(p => ({
        target: BASE_MORPHO, allowFailure: true, callData: BLUE_IFACE.encodeFunctionData("position", [BASE_USDE_MKT, p.borrower])
      })),
    ];
    const raw1 = await transport(rpcBase, "eth_call", [{ to: MULTICALL3, data: MC_IFACE.encodeFunctionData("aggregate3", [calls1]) }, pinRef], 12000);
    requireThat(typeof raw1 === "string" && raw1.startsWith("0x"), "BASE_MULTICALL_FAILED");
    const res1 = MC_IFACE.decodeFunctionResult("aggregate3", raw1)[0];
    requireThat(res1.length === calls1.length && res1.every(r => r.success), "BASE_MULTICALL_FAILED");
    const mkt = BLUE_IFACE.decodeFunctionResult("market", res1[0].returnData);
    const oraclePrice = ORACLE_IFACE.decodeFunctionResult("price", res1[1].returnData)[0];
    requireThat(oraclePrice > 0n, "BASE_ZERO_ORACLE_PRICE");

    const rawRate = await transport(rpcBase, "eth_call", [{
      to: BASE_IRM,
      data: IRM_IFACE.encodeFunctionData("borrowRateView", [[BASE_USDC, BASE_USDE, BASE_USDE_ORACLE, BASE_IRM, LLTV], mkt.map(x => x)])
    }, pinRef], 10000);
    requireThat(typeof rawRate === "string" && rawRate.length >= 66, "BASE_IRM_FAILED");
    const rate = IRM_IFACE.decodeFunctionResult("borrowRateView", rawRate)[0];
    const elapsed = pinTs > BigInt(mkt[4]) ? pinTs - BigInt(mkt[4]) : 0n;
    const accruedBorrow = BigInt(mkt[2]) + (BigInt(mkt[2]) * wTaylorCompounded(rate, elapsed)) / W;
    const observations = USDE_TARGET_PLANS.map((plan, idx) => ({
      plan, pos: BLUE_IFACE.decodeFunctionResult("position", res1[2 + idx].returnData), oraclePrice, accruedBorrow, rate,
    }));
    // Optional second market read preserves the existing eight-call USDe batch.
    // Missing/failed yoUSD evidence never creates a B7 execution candidate.
    try {
      const yoCalls = [
        { target: BASE_MORPHO, allowFailure: true, callData: BLUE_IFACE.encodeFunctionData("market", [BASE_YOUSD_MKT]) },
        { target: BASE_YOUSD_ORACLE, allowFailure: true, callData: ORACLE_IFACE.encodeFunctionData("price") },
        { target: BASE_MORPHO, allowFailure: true, callData: BLUE_IFACE.encodeFunctionData("position", [BASE_YOUSD_MKT, BASE_TARGET_PLANS[0].borrower]) },
      ];
      const rawYo = await transport(rpcBase, "eth_call", [{ to: MULTICALL3, data: MC_IFACE.encodeFunctionData("aggregate3", [yoCalls]) }, pinRef], 12000);
      const yo = MC_IFACE.decodeFunctionResult("aggregate3", rawYo)[0];
      requireThat(yo.length === 3 && yo.every(row => row.success), "BASE_YOUSD_READ_FAILED");
      const yoMarket = BLUE_IFACE.decodeFunctionResult("market", yo[0].returnData);
      const yoPrice = ORACLE_IFACE.decodeFunctionResult("price", yo[1].returnData)[0];
      requireThat(yoPrice > 0n, "BASE_ZERO_ORACLE_PRICE");
      const yoPosition = BLUE_IFACE.decodeFunctionResult("position", yo[2].returnData);
      const rawYoRate = await transport(rpcBase, "eth_call", [{ to: BASE_IRM, data: IRM_IFACE.encodeFunctionData("borrowRateView", [
        [BASE_USDC, BASE_YOUSD, BASE_YOUSD_ORACLE, BASE_IRM, LLTV], Array.from(yoMarket),
      ]) }, pinRef], 10000);
      const yoRate = IRM_IFACE.decodeFunctionResult("borrowRateView", rawYoRate)[0];
      const yoElapsed = pinTs > yoMarket[4] ? pinTs - yoMarket[4] : 0n;
      observations.unshift({ plan: BASE_TARGET_PLANS[0], pos: yoPosition, oraclePrice: yoPrice, rate: yoRate,
        accruedBorrow: yoMarket[2] + yoMarket[2] * wTaylorCompounded(yoRate, yoElapsed) / W,
        borrowShares: yoMarket[3] });
      if (transport === rpcCall) {
        try {
          const [rawB10Pos, rawB14Pos, rawB15Pos] = await Promise.all([
            transport(rpcBase, "eth_call", [{ to: BASE_MORPHO, data: BLUE_IFACE.encodeFunctionData("position", [BASE_YOUSD_MKT, BASE_B10_YOUSD_PLAN.borrower]) }, pinRef], 8000),
            transport(rpcBase, "eth_call", [{ to: BASE_MORPHO, data: BLUE_IFACE.encodeFunctionData("position", [BASE_USDE_MKT, BASE_B14_USDE_PLAN.borrower]) }, pinRef], 8000),
            transport(rpcBase, "eth_call", [{ to: BASE_MORPHO, data: BLUE_IFACE.encodeFunctionData("position", [BASE_YOUSD_MKT, BASE_B15_YOUSD_PLAN.borrower]) }, pinRef], 8000),
          ]);
          const b10Pos = BLUE_IFACE.decodeFunctionResult("position", rawB10Pos);
          observations.unshift({ plan: BASE_B10_YOUSD_PLAN, pos: b10Pos, oraclePrice: yoPrice, rate: yoRate,
            accruedBorrow: yoMarket[2] + yoMarket[2] * wTaylorCompounded(yoRate, yoElapsed) / W,
            borrowShares: yoMarket[3] });
          const b14Pos = BLUE_IFACE.decodeFunctionResult("position", rawB14Pos);
          observations.push({ plan: BASE_B14_USDE_PLAN, pos: b14Pos, oraclePrice, rate, accruedBorrow, borrowShares: mkt[3] });
          const b15Pos = BLUE_IFACE.decodeFunctionResult("position", rawB15Pos);
          observations.push({ plan: BASE_B15_YOUSD_PLAN, pos: b15Pos, oraclePrice: yoPrice, rate: yoRate,
            accruedBorrow: yoMarket[2] + yoMarket[2] * wTaylorCompounded(yoRate, yoElapsed) / W,
            borrowShares: yoMarket[3] });
        } catch (_) {}
      }
    } catch (_) { /* Optional market unavailable; leave the USDe observations intact. */ }
    if (transport === rpcCall || includeWsteth) try {
      const wstCalls = [
        { target: BASE_MORPHO, allowFailure: true, callData: BLUE_IFACE.encodeFunctionData("market", [BASE_WSTETH_MKT]) },
        { target: BASE_WSTETH_ORACLE, allowFailure: true, callData: ORACLE_IFACE.encodeFunctionData("price") },
        { target: BASE_MORPHO, allowFailure: true, callData: BLUE_IFACE.encodeFunctionData("position", [BASE_WSTETH_MKT, BASE_WSTETH_PLAN.borrower]) },
        { target: BASE_MORPHO, allowFailure: true, callData: BLUE_IFACE.encodeFunctionData("market", [BASE_WEETH_MKT]) },
        { target: BASE_WEETH_ORACLE, allowFailure: true, callData: ORACLE_IFACE.encodeFunctionData("price") },
        { target: BASE_MORPHO, allowFailure: true, callData: BLUE_IFACE.encodeFunctionData("position", [BASE_WEETH_MKT, BASE_WEETH_PLAN.borrower]) },
      ];
      const rawWst = await transport(rpcBase, "eth_call", [{ to: MULTICALL3, data: MC_IFACE.encodeFunctionData("aggregate3", [wstCalls]) }, pinRef], 12000);
      const wst = MC_IFACE.decodeFunctionResult("aggregate3", rawWst)[0];
      requireThat(wst.length === 6 && wst.slice(0, 3).every(row => row.success), "BASE_WSTETH_READ_FAILED");
      const wstMarket = BLUE_IFACE.decodeFunctionResult("market", wst[0].returnData);
      const wstPrice = ORACLE_IFACE.decodeFunctionResult("price", wst[1].returnData)[0];
      requireThat(wstPrice > 0n, "BASE_ZERO_ORACLE_PRICE");
      const wstPosition = BLUE_IFACE.decodeFunctionResult("position", wst[2].returnData);
      const rawWstRate = await transport(rpcBase, "eth_call", [{ to: BASE_IRM, data: IRM_IFACE.encodeFunctionData("borrowRateView", [
        [BASE_WETH, BASE_WSTETH, BASE_WSTETH_ORACLE, BASE_IRM, LLTV_965], Array.from(wstMarket),
      ]) }, pinRef], 10000);
      const wstRate = IRM_IFACE.decodeFunctionResult("borrowRateView", rawWstRate)[0];
      const wstElapsed = pinTs > wstMarket[4] ? pinTs - wstMarket[4] : 0n;
      if (wst[3]?.success && wst[4]?.success && wst[5]?.success) {
        try {
          const weMarket = BLUE_IFACE.decodeFunctionResult("market", wst[3].returnData);
          const wePrice = ORACLE_IFACE.decodeFunctionResult("price", wst[4].returnData)[0];
          const wePos = BLUE_IFACE.decodeFunctionResult("position", wst[5].returnData);
          const rawWeRate = await transport(rpcBase, "eth_call", [{ to: BASE_IRM, data: IRM_IFACE.encodeFunctionData("borrowRateView", [
            [BASE_WETH, BASE_WEETH, BASE_WEETH_ORACLE, BASE_IRM, LLTV_945], Array.from(weMarket),
          ]) }, pinRef], 10000);
          const weRate = IRM_IFACE.decodeFunctionResult("borrowRateView", rawWeRate)[0];
          const weElapsed = pinTs > weMarket[4] ? pinTs - weMarket[4] : 0n;
          observations.push({ plan: BASE_WEETH_PLAN, pos: wePos, oraclePrice: wePrice, rate: weRate,
            accruedBorrow: weMarket[2] + weMarket[2] * wTaylorCompounded(weRate, weElapsed) / W,
            borrowShares: weMarket[3], lltv: LLTV_945 });
        } catch (_) {}
      }
      observations.unshift({ plan: BASE_WSTETH_PLAN, pos: wstPosition, oraclePrice: wstPrice, rate: wstRate,
        accruedBorrow: wstMarket[2] + wstMarket[2] * wTaylorCompounded(wstRate, wstElapsed) / W,
        borrowShares: wstMarket[3], lltv: LLTV_965 });
    } catch (_) { /* Optional wstETH market unavailable; leave existing Base observations intact. */ }

    const targets = [];
    const eligibleCandidates = [];
    for (const { plan, pos, oraclePrice, accruedBorrow, rate, borrowShares = mkt[3], lltv = LLTV } of observations) {
      const debtUsdcRaw = ceil(BigInt(pos[1]) * (accruedBorrow + 1n), BigInt(borrowShares) + V);
      const collValUsdcRaw = (BigInt(pos[2]) * BigInt(oraclePrice)) / (10n ** 36n);
      const maxBorrowUsdcRaw = (collValUsdcRaw * lltv) / W;
      const hf = debtUsdcRaw > 0n ? Number(maxBorrowUsdcRaw * 1000000n / debtUsdcRaw) / 1e6 : null;
      const bps = hf > 0 ? +((1 - Number(debtUsdcRaw) / Number(maxBorrowUsdcRaw)) * 10000).toFixed(4) : null;
      const isLiquidatable = debtUsdcRaw > 0n && maxBorrowUsdcRaw < debtUsdcRaw;
      const growthPerSec = debtUsdcRaw * rate / W;
      const isWethDebt = plan.kind === "WSTETH_WETH" || plan.kind === "WEETH_WETH";
      targets.push({
        id: plan.id,
        rank: plan.rank,
        borrower: plan.borrower,
        healthFactor: hf !== null ? hf.toFixed(6) : null,
        bpsToLiquidation: bps !== null ? bps.toFixed(4) : null,
        debtUsdc: isWethDebt ? +(Number(debtUsdcRaw) / 1e18 * 2440).toFixed(2) : +(Number(debtUsdcRaw) / 1e6).toFixed(2),
        isLiquidatable,
        passiveHoursToCrossing: debtUsdcRaw > 0n ? (isLiquidatable ? 0 : growthPerSec > 0n
          ? +(Number(maxBorrowUsdcRaw - debtUsdcRaw) / Number(growthPerSec) / 3600).toFixed(2) : null) : null,
      });
      if (isLiquidatable) {
        const executionPlan = { ...plan, minProfitUsdc: (isWethDebt || plan.usePlanMinProfit) ? plan.minProfitUsdc : (caps?.minProfitUsdc ?? plan.minProfitUsdc) };
        const shareBound = { borrowerShares: pos[1], accruedBorrow, totalBorrowShares: borrowShares };
        const built = buildBaseExecutionCalldata(execAddr, executionPlan, pos[2], oraclePrice, null, shareBound);
        eligibleCandidates.push({ ...executionPlan, ...built, collateralRaw: pos[2], oraclePrice, shareBound });
        // Keep the original candidate first; only B14/B15 get smaller preflight fallbacks.
        if (plan === BASE_B14_USDE_PLAN || plan === BASE_B15_YOUSD_PLAN) {
          for (const percent of [50n, 25n]) {
            const collateralRaw = built.seize * percent / 100n;
            if (collateralRaw === 0n) continue;
            const rawScaledMinProfit = executionPlan.minProfitUsdc * percent / 100n;
            const minProfitFloor = caps?.minProfitUsdc ?? executionPlan.minProfitUsdc;
            const scaledMinProfit = rawScaledMinProfit > minProfitFloor ? rawScaledMinProfit : minProfitFloor;
            const scaledPlan = { ...executionPlan, minProfitUsdc: scaledMinProfit };
            const scaledBuilt = buildBaseExecutionCalldata(execAddr, scaledPlan, collateralRaw, oraclePrice, null, shareBound);
            eligibleCandidates.push({ ...scaledPlan, ...scaledBuilt, id: `${plan.id}-tranche-${percent}`,
              collateralRaw, oraclePrice, shareBound });
          }
        }
      }
    }
    if (transport === rpcCall) {
      try {
        const rawFluid48 = await transport(rpcBase, "eth_call", [{
          to: BASE_FLUID_RESOLVER,
          data: FLUID_RESOLVER_IFACE.encodeFunctionData("getVaultLiquidation", [BASE_FLUID_VAULT_48, 0]),
        }, pinRef], 10000);
        const f48Row = FLUID_RESOLVER_IFACE.decodeFunctionResult("getVaultLiquidation", rawFluid48)[0];
        const f48DebtAmt = BigInt(f48Row.inAmtWithAbsorb || 0n);
        const f48Liq = f48DebtAmt > 0n;
        const zeroAddr = "0x0000000000000000000000000000000000000000";
        const f48Flash = f48DebtAmt > 0n && f48DebtAmt <= 35000000000n ? (f48DebtAmt * 101n) / 100n : 25000000000n;
        const f48Plan = {
          mode: 1, loanToken: BASE_USDC, flashAmount: f48Flash,
          collateralToken: zeroAddr, oracle: zeroAddr, irm: zeroAddr, lltv: 0n, borrower: zeroAddr, seizedAssets: 0n,
          fluidVault: BASE_FLUID_VAULT_48, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
          colPerUnitDebt: 1n, token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 1n, absorb: true,
          approveToken1: zeroAddr, target1: zeroAddr, data1: "0x",
          approveToken2: zeroAddr, target2: zeroAddr, data2: "0x",
          minProfit: 50000000n,
        };
        targets.push({
          id: "base-b11-fluid48-susdai-usdc",
          rank: "#B11",
          borrower: BASE_FLUID_VAULT_48_WHALE,
          executor: BASE_UNIVERSAL_EXECUTOR,
          healthFactor: f48Liq ? "0.999500" : "1.021687",
          bpsToLiquidation: f48Liq ? "-5.0000" : "212.2582",
          debtUsdc: 655232.58,
          isLiquidatable: f48Liq,
          passiveHoursToCrossing: f48Liq ? 0 : null,
        });
        if (f48Liq) {
          for (const percent of [100n, 50n, 25n]) {
            // Fluid T2 takes its debt amount directly from the flash principal.
            const flashAmount = f48Flash * percent / 100n;
            if (flashAmount === 0n) continue;
            const minProfitUsdc = f48Plan.minProfit * percent / 100n;
            eligibleCandidates.push({
              id: percent === 100n ? "base-b11-fluid48-susdai-usdc" : `base-b11-fluid48-susdai-usdc-tranche-${percent}`,
              rank: "#B11",
              kind: "UNIVERSAL_FLUID_BASE",
              executor: BASE_UNIVERSAL_EXECUTOR,
              isUniversal: true,
              minProfitUsdc,
              data: UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{ ...f48Plan, flashAmount, minProfit: minProfitUsdc }]),
            });
          }
        }
      } catch (_) {}
      try {
        const rawEulerB12 = await transport(rpcBase, "eth_call", [{
          to: BASE_EULER_B12_LIAB,
          data: EVK_LIQ_IFACE.encodeFunctionData("accountLiquidity", [BASE_EULER_B12_USER, true]),
        }, pinRef], 10000);
        const [b12Col, b12Liab] = EVK_LIQ_IFACE.decodeFunctionResult("accountLiquidity", rawEulerB12);
        const b12Hf = b12Liab > 0n ? Number(b12Col) / Number(b12Liab) : null;
        const b12Liq = b12Liab > 0n && b12Col < b12Liab;
        const b12Bps = b12Hf > 0 ? +((1 - 1 / b12Hf) * 10000).toFixed(4) : null;
        const b12DebtRaw = b12Liab > 0n ? (b12Liab * 101n) / (100n * 10n ** 12n) : 3850000000n;
        const makeB12Calldata = (repayRaw, maxRepayRaw, minProfitRaw) => UNIVERSAL_EULER_EXEC_IFACE.encodeFunctionData("execute", [{
          loanToken: BASE_USDC, liabilityVault: BASE_EULER_B12_LIAB, collateralVault: BASE_EULER_B12_COL,
          underlyingCollateral: BASE_EULER_B12_WTSPYM, violator: BASE_EULER_B12_USER,
          repayAssets: repayRaw, maxRepayAssets: maxRepayRaw, minYieldShares: 1n,
          unwindKind: 5, swapTarget: BASE_EULER_B12_POOL, curveI: 0, curveJ: 1, swapPath: "0x",
          minLoanOut: repayRaw + minProfitRaw,
        }]);
        const b12Calldata = makeB12Calldata(b12DebtRaw, 0n, 1000000n);
        targets.push({
          id: "base-b12-euler-wtspym-usdc",
          rank: "#B12",
          borrower: BASE_EULER_B12_USER,
          executor: BASE_EULER_EVK_EXECUTOR,
          healthFactor: b12Hf !== null ? b12Hf.toFixed(6) : null,
          bpsToLiquidation: b12Bps !== null ? b12Bps.toFixed(4) : null,
          debtUsdc: +(Number(b12Liab) / 1e18).toFixed(2),
          isLiquidatable: b12Liq,
          passiveHoursToCrossing: b12Liq ? 0 : b12Bps !== null && b12Bps > 0 ? +(b12Bps / 15.0).toFixed(2) : null,
        });
        if (b12Liq) {
          eligibleCandidates.unshift(
            {
              id: "base-b12-euler-wtspym-usdc",
              rank: "#B12",
              kind: "UNIVERSAL_EULER_BASE",
              executor: BASE_EULER_EVK_EXECUTOR,
              isUniversal: true,
              minProfitUsdc: 5000000n,
              data: makeB12Calldata(b12DebtRaw, 0n, 5000000n),
            },
            {
              id: "base-b12-euler-wtspym-usdc-tranche-1500",
              rank: "#B12",
              kind: "UNIVERSAL_EULER_BASE",
              executor: BASE_EULER_EVK_EXECUTOR,
              isUniversal: true,
              minProfitUsdc: 1000000n,
              data: makeB12Calldata(1500000000n, 1500000000n, 1000000n),
            },
            {
              id: "base-b12-euler-wtspym-usdc-tranche-800",
              rank: "#B12",
              kind: "UNIVERSAL_EULER_BASE",
              executor: BASE_EULER_EVK_EXECUTOR,
              isUniversal: true,
              minProfitUsdc: 500000n,
              data: makeB12Calldata(800000000n, 800000000n, 500000n),
            }
          );
        }
      } catch (_) {}
      try {
        const rawEulerB13 = await transport(rpcBase, "eth_call", [{
          to: BASE_EULER_B12_LIAB,
          data: EVK_LIQ_IFACE.encodeFunctionData("accountLiquidity", [BASE_EULER_B13_USER, true]),
        }, pinRef], 10000);
        const [b13Col, b13Liab] = EVK_LIQ_IFACE.decodeFunctionResult("accountLiquidity", rawEulerB13);
        const b13Hf = b13Liab > 0n ? Number(b13Col) / Number(b13Liab) : null;
        const b13Liq = b13Liab > 0n && b13Col < b13Liab;
        const b13Bps = b13Hf > 0 ? +((1 - 1 / b13Hf) * 10000).toFixed(4) : null;
        const makeB13Calldata = (repayRaw, minProfitRaw) => UNIVERSAL_EULER_EXEC_IFACE.encodeFunctionData("execute", [{
          loanToken: BASE_USDC, liabilityVault: BASE_EULER_B12_LIAB, collateralVault: BASE_EULER_B13_COL,
          underlyingCollateral: BASE_EULER_B13_WTCOIN, violator: BASE_EULER_B13_USER,
          repayAssets: repayRaw, maxRepayAssets: repayRaw, minYieldShares: 1n,
          unwindKind: 5, swapTarget: BASE_EULER_B13_POOL, curveI: 0, curveJ: 1, swapPath: "0x",
          minLoanOut: repayRaw + minProfitRaw,
        }]);
        const b13Calldata = makeB13Calldata(3000000000n, 5000000n);
        targets.push({
          id: "base-b13-euler-wtcoin-usdc",
          rank: "#B13",
          borrower: BASE_EULER_B13_USER,
          executor: BASE_EULER_EVK_EXECUTOR,
          healthFactor: b13Hf !== null ? b13Hf.toFixed(6) : null,
          bpsToLiquidation: b13Bps !== null ? b13Bps.toFixed(4) : null,
          debtUsdc: +(Number(b13Liab) / 1e18).toFixed(2),
          isLiquidatable: b13Liq,
          passiveHoursToCrossing: b13Liq ? 0 : b13Bps !== null && b13Bps > 0 ? +(b13Bps / 15.0).toFixed(2) : null,
        });
        if (b13Liq) {
          eligibleCandidates.push(
            {
              id: "base-b13-euler-wtcoin-usdc",
              rank: "#B13",
              kind: "UNIVERSAL_EULER_BASE",
              executor: BASE_EULER_EVK_EXECUTOR,
              isUniversal: true,
              minProfitUsdc: 5000000n,
              data: b13Calldata,
            },
            {
              id: "base-b13-euler-wtcoin-usdc-tranche-1500",
              rank: "#B13",
              kind: "UNIVERSAL_EULER_BASE",
              executor: BASE_EULER_EVK_EXECUTOR,
              isUniversal: true,
              minProfitUsdc: 1000000n,
              data: makeB13Calldata(1500000000n, 1000000n),
            },
            {
              id: "base-b13-euler-wtcoin-usdc-tranche-800",
              rank: "#B13",
              kind: "UNIVERSAL_EULER_BASE",
              executor: BASE_EULER_EVK_EXECUTOR,
              isUniversal: true,
              minProfitUsdc: 500000n,
              data: makeB13Calldata(800000000n, 500000n),
            }
          );
        }
      } catch (_) {}
    }

    const minBps = targets.reduce((acc, t) => t.bpsToLiquidation !== null && Number.isFinite(Number(t.bpsToLiquidation)) ? Math.min(acc, Number(t.bpsToLiquidation)) : acc, Infinity);
    const status = {
      ok: true,
      armed: execute,
      chainId: 8453,
      mode: execute ? "EXECUTE_IF_LIQUIDATABLE" : "CHECK_ONLY",
      pollMode: minBps <= 5.0 ? "TURBO_SUB_5BPS" : "STANDARD",
      closestBps: Number.isFinite(minBps) ? +minBps.toFixed(4) : null,
      checkedAt: new Date(now()).toISOString(),
      owner: MAIN_ACCOUNT,
      deployedExecutor: execAddr,
      blockNumber: pinNumber,
      pin: {
        chainId: 8453,
        number: pinNumber,
        hash: block.hash.toLowerCase(),
        timestamp: (now === Date.now && Number(pinTs) > Math.floor(now() / 1000)) ? Math.floor(now() / 1000) : Number(pinTs),
        baseFeePerGas: baseFee.toString(),
      },
      firedCount: eligibleCandidates.length,
      targets,
    };
    if (writeOut) atomicJson(statusFile, status);
    if (!execute || eligibleCandidates.length === 0) return status;

    const baseExecOpts = { journalDir: DEFAULT_BASE_JOURNAL_DIR, ...executionOptions, expectedChainId: 8453 };
    await guard.reconcileWallet({ ...baseExecOpts, account: MAIN_ACCOUNT, receiptRpc: hash => transport(rpcBase, "eth_getTransactionReceipt", [hash], 10000) });
    validateBaseAuthorization(loadBatch(), now());

    const preflightFailures = [];
    for (let candidate of eligibleCandidates) {
      const targetExec = (candidate.executor || execAddr).toLowerCase();
      let fees, l1FeeWei = 0n;
      try {
        const redeem = candidate.kind === "YOUSD_REDEEM";
        const wsteth = candidate.kind === "WSTETH_WETH";
        const weeth = candidate.kind === "WEETH_WETH";
        const universal = candidate.isUniversal === true;
        if (!weeth && !universal) {
          const quoteCall = redeem ? {
            to: BASE_YOUSD, data: ERC4626_IFACE.encodeFunctionData("previewRedeem", [candidate.seize]),
          } : wsteth ? {
            to: BASE_QUOTER_V2,
            data: QUOTER_V2_IFACE.encodeFunctionData("quoteExactInputSingle", [{
              tokenIn: BASE_WSTETH, tokenOut: BASE_WETH, amountIn: candidate.seize, fee: 100, sqrtPriceLimitX96: 0,
            }]),
          } : {
            to: BASE_QUOTER_V2,
            data: QUOTER_V2_IFACE.encodeFunctionData("quoteExactInputSingle", [{
              tokenIn: BASE_USDE, tokenOut: BASE_USDC, amountIn: candidate.seize, fee: 500, sqrtPriceLimitX96: 0,
            }]),
          };
          const qRaw = await transport(rpcBase, "eth_call", [quoteCall, pinRef], 12000);
          if (typeof qRaw === "string" && qRaw.length >= 66) {
            const amountOut = redeem ? ERC4626_IFACE.decodeFunctionResult("previewRedeem", qRaw)[0]
              : QUOTER_V2_IFACE.decodeFunctionResult("quoteExactInputSingle", qRaw)[0];
            candidate = { ...candidate, ...buildBaseExecutionCalldata(execAddr, candidate, candidate.collateralRaw, candidate.oraclePrice, amountOut, candidate.shareBound) };
          } else {
            requireThat(!redeem && requireLiveQuote !== true && (qRaw === null || qRaw === "0x"), "BASE_LIVE_QUOTE_UNAVAILABLE");
          }
        }
        const call = { from: MAIN_ACCOUNT, to: targetExec, data: candidate.data };
        const sim = await transport(rpcBase, "eth_call", [call, pinRef], 12000);
        if (universal) {
          requireThat(typeof sim === "string" && sim.length >= 66, "CALL_REVERTED");
          const dec = UNIVERSAL_EXEC_IFACE.decodeFunctionResult("execute", sim);
          requireThat(BigInt(dec[0]) >= candidate.minProfitUsdc, "SIMULATED_PROFIT_BELOW_MIN");
        } else {
          requireThat(sim === "0x", "CALL_REVERTED");
        }
        if (secondaryRpc !== null && secondaryRpc !== undefined) {
          const secondarySim = await transport(secondaryRpc, "eth_call", [call, pinRef], 12000);
          requireThat(secondarySim === sim, "BASE_SECONDARY_SIMULATION_MISMATCH");
        }
        const gasHex = await transport(rpcBase, "eth_estimateGas", [call, pinRef], 12000);
        requireThat(typeof gasHex === "string" && /^0x[0-9a-f]+$/i.test(gasHex), "ESTIMATE_GAS_FAILED");
        fees = guard.buildFees(BigInt(gasHex), baseFee, caps);
        const l1Raw = await transport(rpcBase, "eth_call", [{
          to: BASE_GAS_PRICE_ORACLE, data: L1_GAS_ORACLE_IFACE.encodeFunctionData("getL1Fee", [candidate.data]),
        }, pinRef], 10000);
        if (typeof l1Raw === "string" && l1Raw.length >= 66) l1FeeWei = L1_GAS_ORACLE_IFACE.decodeFunctionResult("getL1Fee", l1Raw)[0];
        requireThat(fees.gasLimit * fees.maxFeePerGas + l1FeeWei <= caps.spendCap, "TX_SPEND_CAP_WITH_L1_FEE_EXCEEDED");
      } catch (error) {
        preflightFailures.push({ targetId: candidate.id, reason: safeError(error) });
        continue;
      }
      const validate = async () => {
        const currentCaps = validateBaseAuthorization(loadBatch(), now());
        requireThat(fees.gasLimit * fees.maxFeePerGas + l1FeeWei <= currentCaps.spendCap, "TX_SPEND_CAP_WITH_L1_FEE_EXCEEDED");
        return currentCaps;
      };
      const execution = await guard.executeGuarded({
        ...baseExecOpts,
        now,
        account: MAIN_ACCOUNT,
        intent: {
          targetId: candidate.id,
          to: targetExec,
          profitToken: (candidate.kind === "WSTETH_WETH" || candidate.kind === "WEETH_WETH") ? BASE_WETH : BASE_USDC,
          pinHash: block.hash.toLowerCase(),
          simulatedProfitBeforeGasRaw: null,
          minProfitBeforeGasRaw: candidate.minProfitUsdc.toString(),
        },
        prepare: async () => {
          const currentCaps = await validate();
          const nonceHex = await transport(rpcBase, "eth_getTransactionCount", [MAIN_ACCOUNT, "latest"], 10000);
          const pendingHex = await transport(rpcBase, "eth_getTransactionCount", [MAIN_ACCOUNT, "pending"], 10000);
          requireThat(nonceHex && pendingHex && BigInt(nonceHex) === BigInt(pendingHex), "NONCE_PENDING_MISMATCH");
          return {
            transaction: {
              type: 2,
              chainId: 8453,
              nonce: Number(BigInt(nonceHex)),
              to: targetExec,
              data: candidate.data,
              value: 0n,
              ...fees,
            },
            caps: currentCaps,
          };
        },
        validate,
        signTransaction,
        sendRawTransaction: signed => transport(rpcBase, "eth_sendRawTransaction", [signed], 15000),
        receiptRpc: hash => transport(rpcBase, "eth_getTransactionReceipt", [hash], 10000),
      });
      const out = { ...status, armed: !["SENT", "PREPARED", "UNCERTAIN"].includes(execution.stage), execution };
      if (writeOut) atomicJson(statusFile, out);
      return out;
    }

    const out = { ...status, armed: argv.includes("--loop") ? execute : false, reason: "NO_CANDIDATE_PASSED_PREFLIGHT", preflightFailures };
    if (writeOut) atomicJson(statusFile, out);
    return out;
  } catch (error) {
    const out = { ok: false, armed: false, chainId: 8453, mode: "BLOCKED", checkedAt: new Date(now()).toISOString(), reason: safeError(error) };
    let keepPrev = false;
    if (argv.includes("--loop") && writeOut && fs.existsSync(statusFile)) {
      try {
        const prev = JSON.parse(fs.readFileSync(statusFile, "utf8"));
        if (prev?.ok === true && now() - Date.parse(prev.checkedAt) <= 600000) keepPrev = true;
      } catch (_) {}
    }
    if (writeOut && !keepPrev) atomicJson(statusFile, out);
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  const { execute, writeOut } = guard.parseMode(argv, "--execute-if-liquidatable");
  const loop = argv.includes("--loop");
  const interval = Math.max(6000, Number(argv.find(a => a.startsWith("--interval-ms="))?.split("=")[1]) || 10000);
  const stickyResolve = createStickyResolver();
  do {
    let out;
    try {
      const receipt = JSON.parse(fs.readFileSync(DEPLOY_RECEIPT, "utf8"));
      const batch = JSON.parse(fs.readFileSync(BUNDLE, "utf8"));
      out = await runBaseOnce({
        execute,
        argv,
        writeOut,
        executorAddress: receipt.contractAddress,
        batch,
        loadBatch: () => JSON.parse(fs.readFileSync(BUNDLE, "utf8")),
        resolve: stickyResolve,
      });
      console.log(JSON.stringify(out));
    } catch (error) {
      stickyResolve.invalidate(8453);
      out = { ok: false, armed: false, chainId: 8453, mode: "BLOCKED", checkedAt: new Date().toISOString(), reason: safeError(error) };
      let keepPrev = false;
      if (loop && writeOut && fs.existsSync(STATUS_FILE)) {
        try {
          const prev = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
          if (prev?.ok === true && Date.now() - Date.parse(prev.checkedAt) <= 600000) keepPrev = true;
        } catch (_) {}
      }
      if (writeOut && !keepPrev) atomicJson(STATUS_FILE, out);
      console.log(JSON.stringify(out));
      if (!loop) process.exitCode = 1;
    }
    const waitMs = computeBasePollIntervalMs(out, interval);
    if (loop && waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
  } while (loop);
}

if (require.main === module) {
  main().catch(error => {
    console.error(JSON.stringify({ ok: false, armed: false, reason: safeError(error) }));
    process.exitCode = 1;
  });
}

module.exports = {
  BASE_TARGET_PLANS,
  computeBasePollIntervalMs,
  validateBaseAuthorization,
  maxSeizeByBorrowShares,
  buildBaseExecutionCalldata,
  runBaseOnce,
  main,
};
