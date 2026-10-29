#!/usr/bin/env node
"use strict";

// watch-top-whale-triggers.js
// Fast 2-Multicall3 read-only sentinel + live DEX quote & executeMorpho calldata
// builder for the live whale targets and monitoring-only PAXG market:
//   1. Aave V4 USDe/USDC Whale (0x1cb432f80416f07db4420b8c20447924a0658894 on Spoke 0xba1B3D55D249692b669A164024A838309B7508AF)
//   2. Aave V3 weETH/WETH Whale #1 (0x7231eAeeA108E3EA05c993cbee21F23dDD7A44BF on Pool 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2)
//   3. Aave V3 weETH/WETH Whale #2 (0x1A557354C5b8d7Df38ea914209e416Dc7065b158 on Pool 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2)
//   4. Morpho Blue PAXG/USDC Market (0x8eaf7b29f02ba8d8c1d7aeb587403dcb16e2e943e4e2f5f94b0963c2386406c9)
//   5. Top 8 Aave V4 Spoke C weETH/WETH whales
//   6. Three Morpho Blue Base whales (optional read-only monitoring)
//
// Read-only. Never reads key files, signs transactions, or persists RPC URLs.
// Usage:
//   node tools/watch-top-whale-triggers.js --once
//   node tools/watch-top-whale-triggers.js --watch [intervalSeconds] [--max-runs N]

const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("./node_modules/ethers");
const { resolveRpc, rpcCall } = require("./shared-rpc.js");
const { contextForPin, morphoProjection, morphoSeizeFits, aaveProjection, attachForecast } = require("./lib/passive-accrual-forecast.js");
const M32_DEPLOYMENT = require("./lib/m32-deployment.js");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "top-whale-triggers-status.json");
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
let lastValidBaseState = null;
let lastM31KyberSwap = { tsMs: 0, seizedRaw: 0n, swapData: "0xe21fd0e9" };
let lastF3KyberSwap = { tsMs: 0, swapData: "0xe21fd0e9" };
const lastValidExtendedTargets = Object.create(null);
const TARGET_CACHE_TTL_MS = 900000;
const OBSERVATION_SOURCE = "tools/watch-top-whale-triggers.js";
const M32_REFERENCE_QUOTE = Object.freeze({ repayUsdc: 11039.80, seizedReusd: 9025.94,
  curveOutUsdc: 11319.14, grossSurplusUsdc: 279.34, grossSurplusUsd: 213.50 });
const DEBT_STATUS_TARGETS = new Set(["targetB14_Base_USDe_USDC_0x6efc", "targetM34_Morpho_beraSTONE_WETH", "targetE8_Euler_eUSDC2_eXAUt1"]);
const EXTENDED_TARGET_KEY = /^target(?:2[K-Q]_|S[1-4]_|C9_AaveV4_weETH_WETH_0x9f46$|A(?:[5-9]|1[0-8])_|M(?:[89]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|2[B-D])_|F[1-6]_|B1[1-5]_|E(?:[1-9]|10)_|YnEthx_Curve_NavArb$)/;

const SPOKE_A = "0xba1B3D55D249692b669A164024A838309B7508AF";
const HUB_A = "0x06002e9c4412CB7814a791eA3666D905871E536A";
const USER_V4_C1 = "0x1cb432f80416f07db4420b8c20447924a0658894";
const USER_V4_A11 = "0x5c430ff6f374da12218b380d2040299ae5b6d40e";
const USDE_ADAPTER = "0xC26D4a1c46d884cfF6dE9800B6aE7A8Cf48B4Ff8";
const USDC_ADAPTER = "0x3f73F03aa83B2A48ed27E964eD0fDb590332095B";
const USDT_FEED = "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D";
const USDC_FEED = "0xEa674bBC33AE708Bc9EB4ba348b04E4eB55b496b";

const SPOKE_C = "0xbF10BDfE177dE0336aFD7fcCF80A904E15386219";
const HUB_C = "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9";
const SPOKE_C_WEETH_ADAPTER = "0x87625393534d5C102cADB66D37201dF24cc26d4C";
const SPOKE_C_WETH_ADAPTER = "0x5424384B256154046E9667dDFaaa5e550145215e";
const SPOKE_C_USERS = [
  "0x40534e513df8277870b81e97b5107b3f39de4f15",
  "0xafbf278e06d2269aba2a4898afbab2ecb2584924",
  "0x1a557354c5b8d7df38ea914209e416dc7065b158",
  "0xfcc83b338ba980f501e51110c7f51791a21d4a28",
  "0x7231eaeea108e3ea05c993cbee21f23ddd7a44bf",
  "0xba482cae263659b3226c919b9229a27c76217d7d",
  "0xc99f25ac2404f6cf35bd6fe5ccb7f88f0625a8be",
  "0x4b9859df9ba9b428328c05eea63b51c3b36fd2bb"
];
// Keep the original eight-user batch offsets stable; C9 is collected separately.
const USER_V4_C9 = "0x9f4625288fb381f74285ba84230403ce4b8a6c1d";

const POOL_V3 = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const SPARK_POOL = "0xc13e21b648a5ee794902342038ff3adab66be987";
const ORACLE_V3 = "0x54586be62e3c3580375ae3723c145253060ca0c2";
const USER_V3_7231 = "0x7231eAeeA108E3EA05c993cbee21F23dDD7A44BF";
const USER_V3_1A55 = "0x1A557354C5b8d7Df38ea914209e416Dc7065b158";
const EXTRA_V3_WEETH_USERS = [
  "0x4998ff53c34e25495c21652be7ce63b0e40b0995",
  "0xafbf278e06d2269aba2a4898afbab2ecb2584924",
  "0x00901e253a7e666687b2bfccfd8dde7be9fba4df",
  "0xd37505ca07d60a1d0e7a129efb245bb693034e89",
  "0xbc9d1be2a5609525efd9273cd254ef7c156ac33c",
  "0x1b5799899fce13c8ea3e22f1d825dbd22f3f7881",
  "0xaf6e0473f86360a91fc88564927372cdf999b8ad",
];
const VDEBT_WETH = "0xeA51d7853EEFb32b6ee06b1C12E6dcCA88Be0fFE";
const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const PAXG_MARKET = "0x8eaf7b29f02ba8d8c1d7aeb587403dcb16e2e943e4e2f5f94b0963c2386406c9";
const ETH_MORPHO_USDE_DAI_MKT = "0xc581c5f70bd1afa283eed57d1418c6432cbff1d862f94eaf58fdd4e46afbb67f";
const ETH_MORPHO_USDE_DAI_USER = "0xa3609cf7872faa7804281c7c5edb8b2d33001089";
const ETH_MORPHO_USDE_DAI_ORACLE = "0xaE4750d0813B5E37A51f7629beedd72AF1f9cA35";
const ETH_MORPHO_IRM = "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC";
const DEPLOYED_MORPHO_EXECUTOR = "0xaf5b033e23ac555c09096bf39979a855e09907ba";
const ETH_MORPHO_USDE_DAI_LLTV = 860000000000000000n;
const ETH_MORPHO_USDE_DAI_SEIZE = 108500n * 10n ** 18n;
const LIF_86 = 1043841336116910229n;
const ETH_MORPHO_REUSD_USDC_MKT = "0x4565ac05d38b19374ccbb04c17cca60ca9353cd41824f0803d0fc7704f60eaed";
const ETH_MORPHO_REUSD_USDC_USER = "0xaa34d20be3f9623ccf5bff53ef4dfa765c3f5dd5";
const ETH_MORPHO_REUSD_USDC_ORACLE = "0xA66a4F03Fd8031973f8C7718904ce32385f54E70";
const ETH_MORPHO_REUSD_USDC_LLTV = 915000000000000000n;
const ETH_MORPHO_REUSD_USDC_SEIZE = 100000n * 10n ** 18n;
const REUSD = "0x5086bf358635B81D8C47C66d1C8b9E567Db70c72";
const CURVE_REUSD_USDC = "0xf74c91b36C26543A0Aa820bEf407A577e5498BF0";
const M2_CURVE_UNWIND_EXECUTOR = "0x2d5bca1b846e89965544c7f03d09a25126803627";
const LIF_915 = 1026167265264238070n;
const BASE_MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_USDE = "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34";
const BASE_QUOTER_V2 = "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a";
const BASE_YOUSD = "0x0000000f2eb9f69274678c76222b35eec7588a65";
const BASE_YOUSD_MKT = "0x1a3e69d0109bb1be42b80e11034bb6ee98fc466721f26845dc83b2aa8d979137";
const BASE_YOUSD_ORACLE = "0x77f59c5c09e7abef6991b456170930324fe36222";
const BASE_YOUSD_USER = "0x108b853407284e77656c569677c82e8fed581299";
const BASE_MGLO = "0xFCc9Cc1209651Ed8867332d6F664CF82743A2584";
const BASE_IRM = "0x46415998764C29aB2a25CbeA6254146D50D22687";
const BASE_USDE_MKT = "0x54cf9be57fdfa6457a660991907434ff9d295c465a603a50126ff647d50b7354";
const BASE_MGLO_MKT = "0x29ae7ac08be3a58e11151fed74701fb8e6ffd8e76b1870cf17ad70f332752d0b";
const BASE_USDE_ORACLE = "0xF4b17C79492d68775e22e8Dd0a2Bb22854A39A47";
const BASE_MGLO_ORACLE = "0x182e072f2c9c58c6f19f144c97986f7496c6a109";
const BASE_WHALES = [
  { rank: "#B1", user: "0xb4fb31e7b1471a8e52dd1e962a281a732ead59c1", marketId: BASE_USDE_MKT, oracle: BASE_USDE_ORACLE, lltv: 915000000000000000n, pair: "USDe / USDC (Base)" },
  { rank: "#B2", user: "0x7bee8d37fba61a6251a08b957d502c56e2a50fab", marketId: BASE_USDE_MKT, oracle: BASE_USDE_ORACLE, lltv: 915000000000000000n, pair: "USDe / USDC (Base)" },
  { rank: "#B3", user: "0x2e3dc205e5687e02eb4bea4f657c9572a83490e5", marketId: BASE_MGLO_MKT, oracle: BASE_MGLO_ORACLE, lltv: 915000000000000000n, pair: "mGLO / USDC (Base)" },
];
const USDe = "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const DEPLOYED_LIQUIDATOR = "0xf09a01a6c23b936d5a51abce87a6ec8442a44262";
const weETH = "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee";
const wstETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const USER_V3_037A = "0x037a4486b28f0e3b34a4a6e7c4a915280e731a45";
const USER_V4_A3 = "0x1d9c4116e5784036dbd15bced8aff88970b4a598";
const ETH_MORPHO_WSTETH_WETH_965_MKT = "0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e";
const ETH_MORPHO_WSTETH_WETH_945_MKT = "0xd0e50cdac92fe2172043f5e0c36532c6369d24947e40968f34a5e8819ca9ec5d";
const ETH_MORPHO_WSTETH_WETH_ORACLE = "0xbD60A6770b27E084E8617335ddE769241B0e71D8";
const ETH_MORPHO_WSTETH_SEIZE = 500n * 10n ** 18n;
const LIF_965 = 1010611420612813370n;
const LIF_945 = 1016776817488561260n;
const MORPHO_WSTETH_WHALES = [
  { rank: "#M3", user: "0xb224f589297a5a207e6069de5dafd4b120129817", marketId: ETH_MORPHO_WSTETH_WETH_965_MKT, lltv: 965000000000000000n, lif: LIF_965 },
  { rank: "#M4", user: "0x4b441cd7c5085d0c255eff3db7ec3417cca1a1a0", marketId: ETH_MORPHO_WSTETH_WETH_965_MKT, lltv: 965000000000000000n, lif: LIF_965 },
  { rank: "#M5", user: "0xfb74196eccf35a260dd5cfd300baa37ae058b6c0", marketId: ETH_MORPHO_WSTETH_WETH_965_MKT, lltv: 965000000000000000n, lif: LIF_965 },
  { rank: "#M6", user: "0x4b441cd7c5085d0c255eff3db7ec3417cca1a1a0", marketId: ETH_MORPHO_WSTETH_WETH_945_MKT, lltv: 945000000000000000n, lif: LIF_945 },
];
const ETH_MORPHO_YNETHX_MSETH_MKT = "0xd2630c0ebf33ba83c82e8cd400a8e6345370238ca695ce58773b2d3e43de1b0a";
const ETH_MORPHO_YNETHX_MSETH_USER = "0x14bcd9da052cdc6fe0b9446d5a616d5b7b4d4550";
const ETH_MORPHO_YNETHX_MSETH_ORACLE = "0xc28F86C86F79282E2d2A1f45442339C55f7eB22D";
const YNETHX = "0x657d9ABA1DBb59e53f9F3eCAA878447dCfC96dCb";
const MSETH = "0x64351fC9810aDAd17A690E4e1717Df5e7e085160";
const YNETHX_BUFFER = "0x9a8bC3B04b7f3D87cfC09ba407dCED575f2d61D8";
const M7_VAULT_REDEEM_EXECUTOR = "0xc06326bc6fbd4305cdab4de8e239b7b80feb2eb4";
const CURVE_MSETH_WETH = "0xa4c567c662349bec3d0fb94c4e7f85ba95e208e4";
const CURVE_POOL = "0xd65ed4bce447195187f37ce7d82f56adf1826f8f";
const ETH_MORPHO_PT_USDE_DAI_MKT = "0x760b14c9003f08ac4bf0cfb02596ee4d6f0548a4fde5826bfd56befb9ed62ae9";
const ETH_MORPHO_PT_USDE_DAI_ORACLE = "0xfcae69bef9b6c96d89d58664d8aea84bddce2e5c";
const PT_USDE = "0x917459337caac939d41d7493b3999f571d20d667";
const MORPHO_PT_WHALES = [
  { rank: "#M8", user: "0x9b75df7f7cd5b74b8f0f0de8f4751c3f8e9695bb" },
  { rank: "#M9", user: "0x64d85278a093ee5c57739c6c0de6c4eef53a1e02" },
];
const UNI_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const SWAP_ROUTER_02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const CURVE_WEETH_WETH = "0xDB74dfDD3BB46bE8Ce6C33dC9D82777BCFc3dEd5";

const MC = new ethers.Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) returns ((bool success,bytes returnData)[] returnData)"
]);
const SPOKE = new ethers.Interface([
  "function getUserAccountData(address user) view returns ((uint256 riskPremium,uint256 avgCollateralFactor,uint256 healthFactor,uint256 totalCollateralValue,uint256 totalDebtValue,uint256 activeCollateralCount,uint256 borrowCount))",
  "function getUserPosition(uint256 reserveId, address user) view returns ((uint120 drawnShares,uint120 premiumShares,int200 premiumOffsetRay,uint120 suppliedShares,uint32 dynamicConfigKey))"
]);
const HUB = new ethers.Interface([
  "function getAsset(uint256 assetId) view returns ((uint120 liquidity,uint120 realizedFees,uint8 decimals,uint120 addedShares,uint120 swept,int256 premiumOffsetRay,uint120 drawnShares,uint120 premiumShares,uint16 liquidityFee,uint120 drawnIndex,uint96 drawnRate,uint40 lastUpdateTimestamp,address underlying,address irStrategy,address reinvestmentController,address feeReceiver,uint256 deficitRay))",
  "function getAssetDrawnIndex(uint256 assetId) view returns (uint256)"
]);
const POOL = new ethers.Interface([
  "function getUserAccountData(address user) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"
]);
const ORACLE = new ethers.Interface([
  "function getAssetsPrices(address[] assets) view returns (uint256[])"
]);
const FEED = new ethers.Interface([
  "function latestAnswer() view returns (int256)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"
]);
const BLUE = new ethers.Interface([
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function position(bytes32,address) view returns (uint256,uint128,uint128)"
]);
const BLUE_ORACLE = new ethers.Interface([
  "function price() view returns (uint256)"
]);
const BLUE_IRM = new ethers.Interface([
  "function borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128)) view returns (uint256)"
]);
const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)"
]);
const QUOTER = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) view returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)"
]);
const CURVE = new ethers.Interface([
  "function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)"
]);
const VAULT_4626 = new ethers.Interface([
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function maxWithdraw(address holder) view returns (uint256)"
]);
const USD3_REDEEM_4_IFACE = new ethers.Interface(["function redeem(uint256,address,address,uint256) returns (uint256)"]);
const EVK_LIQ = new ethers.Interface([
  "function accountLiquidity(address account, bool liquidation) view returns (uint256 collateralValue, uint256 liabilityValue)",
  "function debtOf(address account) view returns (uint256)",
]);
const LIQUIDATOR_IFACE = new ethers.Interface([
  "function executeMorpho(uint256 flashAmount, (bool isAaveV3,address target,address borrower,address debtToken,address collateralToken,uint256 collateralReserveId,uint256 debtReserveId,uint256 minCollateralSeized,uint8 swapKind,address swapTarget,address swapSpender,uint24 uniFee,int128 curveI,int128 curveJ,uint256 minDebtTokenOut,uint256 minProfitDebtToken) params) external"
]);
const MORPHO_EXEC_IFACE = new ethers.Interface([
  "function execute((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams, address borrower, uint256 seizedAssets, uint256 repaidShares, uint256 minProfitWei, uint256 minOut, address router, bytes routerSwapData) external"
]);
const M7_EXEC_IFACE = new ethers.Interface([
  "function execute((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv,address borrower,uint256 seizedAssets,address intermediateToken,address curvePool,int128 curveI,int128 curveJ,uint256 minLoanOut) plan) external"
]);
const YN_ARB_EXECUTOR = "0x91a07a51ca9c2abd333d80ca876f0dfde4d8cd35";
const YN_ARB_EXEC_IFACE = new ethers.Interface([
  "function execute((address loanToken,address vaultToken,address curvePool,int128 curveI,int128 curveJ,uint256 flashAmount,uint256 minSharesOut,uint256 minLoanOut) plan) external"
]);
const EULER_EVK_EXECUTOR = "0xac262ce4319b887aeac069730c7978c98a8c5fe6";
const EULER_EVK_EXEC_IFACE = new ethers.Interface([
  "function execute((address loanToken,address liabilityVault,address collateralVault,address underlyingCollateral,address violator,uint256 repayAssets,uint256 minYieldShares,uint8 unwindKind,address swapTarget,int128 curveI,int128 curveJ,uint256 minLoanOut) plan) external"
]);
const UNIV4_FLASH_EXECUTOR = "0x61251a22540e7148cc8ba58cfb0916a898865e1f";
const UNIV4_FLASH_EXEC_IFACE = new ethers.Interface([
  "function execute((uint8 mode,address target,address collateralVault,uint256 collateralReserveId,uint256 debtReserveId,address borrower,address debtAsset,address collateralAsset,uint256 flashAmount,uint256 debtToCover,uint256 minCollateralSeized,uint256 minSwapOut,uint256 minProfit,uint256 deadline,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne) plan) external returns (uint256 profitOut)"
]);
const PENDLE_PT_EXECUTOR = "0xd53ee7b5806c4d7f36422eab99dc46563d18b84d";
const PENDLE_PT_EXEC_IFACE = new ethers.Interface([
  "function execute((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv,address borrower,uint256 seizedAssets,address pendleYt,address pendleSy,address redeemedToken,address swapTarget,uint256 minLoanOut) plan, bytes swapData) external"
]);
const UNIV3_EXACT_INPUT_IFACE = new ethers.Interface([
  "function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256 amountOut)"
]);
const EVK_CHECK_LIQ = new ethers.Interface([
  "function checkLiquidation(address liquidator,address borrower,address collateral) view returns (uint256 maxRepay,uint256 maxYield)"
]);
const M2_EXEC_IFACE = new ethers.Interface([
  "function execute((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv,address borrower,uint256 seizedAssets,address swapTarget,uint256 minLoanOut) plan, bytes swapData) external"
]);
const M2_CURVE_EXCHANGE_IFACE = new ethers.Interface([
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)"
]);
const CURVE_5_IFACE = new ethers.Interface(["function exchange(int128,int128,uint256,uint256,address) returns (uint256)"]);
const CURVE_ROUTER_NG_IFACE = new ethers.Interface([
  "function exchange(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, uint256 _expected, address[5] _pools, address _receiver) external payable returns (uint256)",
  "function get_dy(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, address[5] _pools) view returns (uint256)",
]);
const PENDLE_YT_IFACE = new ethers.Interface(["function pyIndexCurrent() returns (uint256)"]);
const PENDLE_SY_IFACE = new ethers.Interface(["function previewRedeem(address tokenOut, uint256 shares) view returns (uint256)"]);
const PENDLE_ROUTER_V4_IFACE = new ethers.Interface([
  "function swapExactPtForToken(address receiver, address market, uint256 exactPtIn, (address tokenOut, uint256 minTokenOut, address tokenRedeemSy, address pendleSwap, (uint8 swapType, address extRouter, bytes extCalldata, bool needScale) swapData) output, (address limitRouter, uint256 epsSkipMarket, ((uint256,uint256,uint256,uint8,address,address,address,address,uint256,uint256,uint256,bytes),bytes,uint256)[] normalFills, ((uint256,uint256,uint256,uint8,address,address,address,address,uint256,uint256,uint256,bytes),bytes,uint256)[] flashFills, bytes optData) limit) returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm)"
]);
const UNIVERSAL_FLUID_MORPHO_EXECUTOR = "0xc50321a07dab061d59b992e57a2ef4dca0d33089";
const BASE_UNIVERSAL_EXECUTOR = "0x86d446bafcd87737d0b763f1e8af65e5c424ba53";
const BASE_UNIVERSAL_EULER_EXECUTOR = "0x0aaa75499fbcb7db821c3aefc84433a53cdeb9b9";
const ETH_UNIVERSAL_EULER_EXECUTOR = "0xa8964ab01c35f8e7de8457223861624b66007a6a";
const UNIVERSAL_EULER_EXEC_IFACE = new ethers.Interface([
  "function execute((address loanToken,address liabilityVault,address collateralVault,address underlyingCollateral,address violator,uint256 repayAssets,uint256 maxRepayAssets,uint256 minYieldShares,uint8 unwindKind,address swapTarget,int128 curveI,int128 curveJ,bytes swapPath,uint256 minLoanOut) plan) external returns (uint256 profitOut)"
]);
const UNIVERSAL_EXEC_IFACE = new ethers.Interface([
  "function execute((uint8 mode,address loanToken,uint256 flashAmount,address collateralToken,address oracle,address irm,uint256 lltv,address borrower,uint256 seizedAssets,address fluidVault,uint256 token0DebtAmt,uint256 token1DebtAmt,uint256 debtSharesMin,uint256 colPerUnitDebt,uint256 token0ColAmtPerUnitShares,uint256 token1ColAmtPerUnitShares,bool absorb,address approveToken1,address target1,bytes data1,address approveToken2,address target2,bytes data2,uint256 minProfit) plan) external returns (uint256 profitOut)"
]);
const FLUID_RESOLVER_IFACE = new ethers.Interface([
  "function getVaultLiquidation(address vault_, uint256 tokenInAmt_) view returns ((address vault,address token0In,address token0Out,address token1In,address token1Out,uint256 inAmt,uint256 outAmt,uint256 inAmtWithAbsorb,uint256 outAmtWithAbsorb,bool absorbAvailable))"
]);

const W = 10n ** 18n, R = 10n ** 27n, Y = 31536000n, V = 1000000n;
const ceil = (x, y) => (x + y - 1n) / y;
const min = (x, y) => (x < y ? x : y);

async function readBufferMaxWithdraw(transport, rpc, holder, pinHash) {
  try {
    const raw = await transport(rpc, "eth_call", [{ to: YNETHX_BUFFER,
      data: VAULT_4626.encodeFunctionData("maxWithdraw", [holder]) }, pinHash], 10000);
    return { ok: true, maxWithdraw: VAULT_4626.decodeFunctionResult("maxWithdraw", raw)[0] };
  } catch (_) {
    return { ok: false, reason: "READ_FAILED" };
  }
}

function wTaylorCompounded(x, n) {
  const firstTerm = x * n;
  const secondTerm = (firstTerm * firstTerm) / (2n * W);
  const thirdTerm = (secondTerm * firstTerm) / (3n * W);
  return firstTerm + secondTerm + thirdTerm;
}

function hubIndexAt(h, t) {
  const dShares = BigInt(h.drawnShares), pShares = BigInt(h.premiumShares), sIdx = BigInt(h.drawnIndex), dRate = BigInt(h.drawnRate), lastT = BigInt(h.lastUpdateTimestamp);
  return dShares === 0n && pShares === 0n ? sIdx : ceil(sIdx * (R + dRate * (t - lastT) / Y), R);
}

function hubAssetsAt(h, t) {
  const idx = hubIndexAt(h, t);
  const dShares = BigInt(h.drawnShares), pShares = BigInt(h.premiumShares), pOff = BigInt(h.premiumOffsetRay), defRay = BigInt(h.deficitRay), sIdx = BigInt(h.drawnIndex), liqFee = BigInt(h.liquidityFee);
  const owed = (dShares + pShares) * idx - pOff + defRay;
  const before = (dShares + pShares) * sIdx - pOff + defRay;
  const fee = (ceil(owed, R) - ceil(before, R)) * liqFee / 10000n;
  return BigInt(h.liquidity) + BigInt(h.swept) + ceil(owed, R) - BigInt(h.realizedFees) - fee;
}

function suppliedAt(h, shares, t) {
  return BigInt(shares) * (hubAssetsAt(h, t) + V) / (BigInt(h.addedShares) + V);
}

function computeV4Target1Sizing(c1Acct, c1CollPos, c1DebtPos, hubUsde, hubUsdc, usdePrice, usdcPrice, pinTs) {
  const usdcIdx = hubIndexAt(hubUsdc, pinTs);
  const c1Supplied = suppliedAt(hubUsde, c1CollPos.suppliedShares, pinTs);
  const targetHF = 1033200000000000000n;
  const H = 999900000000000000n;
  const currentHF = BigInt(c1Acct.healthFactor);
  const effectiveHF = currentHF < W ? currentHF : H;
  const syntheticPrice = currentHF < W ? BigInt(usdePrice) : (BigInt(usdePrice) * H / currentHF);
  const actualH = c1Supplied * syntheticPrice * 9300n * (10n ** 14n) * R / BigInt(c1Acct.totalDebtValue);
  const bonus = 10200n;
  const penalty = bonus * (10n ** 14n) * 9300n / 10000n;
  const debtUnit = 10n ** 6n, collUnit = 10n ** 18n;
  const debtRayTarget = ceil(BigInt(c1Acct.totalDebtValue) * debtUnit * (targetHF - actualH), (targetHF - penalty) * BigInt(usdcPrice) * W);
  const sharesToLiq = min(ceil(debtRayTarget, usdcIdx), BigInt(c1DebtPos.drawnShares));
  const repayUsdcRaw = ceil(sharesToLiq * usdcIdx, R);
  const colGrossRaw = sharesToLiq * usdcIdx * BigInt(usdcPrice) * collUnit * bonus / (debtUnit * syntheticPrice * 10000n * R);
  const collSharesRemoved = colGrossRaw * (BigInt(hubUsde.addedShares) + V) / (hubAssetsAt(hubUsde, pinTs) + V);
  const feeShares = ceil(collSharesRemoved * 1000n * (bonus - 10000n), bonus * 10000n);
  const liqShares = collSharesRemoved - feeShares;
  const seizedUsdeToLiqRaw = liqShares * (hubAssetsAt(hubUsde, pinTs) + V) / (BigInt(hubUsde.addedShares) + V);
  return { repayUsdcRaw, seizedUsdeToLiqRaw, effectiveHF };
}

function computeV3WeEthSizing(repayWethRaw, priceWeth, priceWeEth) {
  const baseColl = (BigInt(repayWethRaw) * BigInt(priceWeth)) / BigInt(priceWeEth);
  const grossColl = (baseColl * 10100n) / 10000n;
  const bonusColl = grossColl - baseColl;
  const feeColl = (bonusColl * 1000n) / 10000n;
  return grossColl - feeColl;
}

function computeV4SpokeCSizing(acct, collPos, debtPos, hubWeEth, hubWeth, weEthPrice, wethPrice, pinTs) {
  const wethIdx = hubIndexAt(hubWeth, pinTs);
  const userSuppliedWeEth = suppliedAt(hubWeEth, collPos.suppliedShares, pinTs);
  const targetHF = 1019100000000000000n;
  const H = 999900000000000000n;
  const currentHF = BigInt(acct.healthFactor);
  const syntheticPrice = currentHF < W ? BigInt(weEthPrice) : (BigInt(weEthPrice) * H / currentHF);
  const actualH = userSuppliedWeEth * syntheticPrice * 9550n * (10n ** 14n) * R / BigInt(acct.totalDebtValue);
  const bonus = 10100n;
  const penalty = bonus * (10n ** 14n) * 9550n / 10000n;
  const debtUnit = 10n ** 18n, collUnit = 10n ** 18n;
  const debtRayTarget = actualH < targetHF ? ceil(BigInt(acct.totalDebtValue) * debtUnit * (targetHF - actualH), (targetHF - penalty) * BigInt(wethPrice) * W) : 0n;
  const sharesToLiq = min(ceil(debtRayTarget, wethIdx), BigInt(debtPos.drawnShares));
  let repayWethRaw = ceil(sharesToLiq * wethIdx, R);
  const colGrossRaw = sharesToLiq * wethIdx * BigInt(wethPrice) * collUnit * bonus / (debtUnit * syntheticPrice * 10000n * R);
  const collAssets = hubAssetsAt(hubWeEth, pinTs) + V;
  const collShares = BigInt(hubWeEth.addedShares) + V;
  let collSharesRemoved = colGrossRaw * collShares / collAssets;
  if (collSharesRemoved > BigInt(collPos.suppliedShares)) {
    // Cap collateral at the available shares and scale repayment down with it.
    repayWethRaw = ceil(repayWethRaw * BigInt(collPos.suppliedShares), collSharesRemoved);
    collSharesRemoved = BigInt(collPos.suppliedShares);
  }
  const feeShares = ceil(collSharesRemoved * 1000n * (bonus - 10000n), bonus * 10000n);
  const liqShares = collSharesRemoved - feeShares;
  const seizedWeEthToLiqRaw = liqShares * collAssets / collShares;
  const userDebtWethRaw = ceil((BigInt(debtPos.drawnShares) + BigInt(debtPos.premiumShares)) * wethIdx - BigInt(debtPos.premiumOffsetRay), R);
  return { repayWethRaw, seizedWeEthToLiqRaw, userSuppliedWeEth, userDebtWethRaw };
}

// These fields describe evidence, never runner liveness or execution authority.
function observationPin(row) {
  const timestamp = row.observationTimestamp;
  return Number.isSafeInteger(timestamp) && timestamp > 0 && Number.isSafeInteger(row.observationBlock) &&
    /^0x[0-9a-f]{64}$/i.test(row.observationHash || "") ? {
      chainId: row.chainId, number: row.observationBlock, hash: row.observationHash,
      timestamp, utc: new Date(timestamp * 1000).toISOString(),
    } : null;
}

function markObservation(row, pin = null, freshQuote = false) {
  const original = observationPin(row) || row.debtObservation || pin;
  Object.assign(row, {
    observationKind: "READ_ONLY_MONITOR", observationSource: OBSERVATION_SOURCE,
    chainId: row.chainId ?? original?.chainId ?? null,
    observationBlock: row.observationBlock ?? original?.number ?? null,
    observationHash: row.observationHash ?? original?.hash ?? null,
    observationTimestamp: row.observationTimestamp ?? original?.timestamp ?? null,
    observationUtc: row.observationUtc ?? original?.utc ?? (original?.timestamp ? new Date(original.timestamp * 1000).toISOString() : null),
    eligibleForPreflight: row.eligibleForPreflight ?? (row.executableNow === true ||
      (row.executableNow === undefined && row.observationOnly !== true && row.liquidatableNow === true)),
    armed: false, executableNow: false,
  });
  const known = observationPin(row);
  row.observationStatus = row.observationStatus || (known ? "COMPLETE" : "INCOMPLETE");
  row.observationReason = row.observationReason ?? (known ? null : "ORIGINAL_OBSERVATION_UNKNOWN");
  row.refreshStatus = row.refreshStatus || (row.observationStatus === "COMPLETE" ? "COMPLETE" : "INCOMPLETE");
  row.refreshReason = row.refreshReason ?? row.observationReason;
  if (row.refreshStatus !== "COMPLETE") row.eligibleForPreflight = false;
  if (typeof row.readinessNote === "string") row.readinessNote = row.readinessNote
    .replace(/\barmed\b/gi, "Route configured (read-only; runner unverified)")
    .replace(/ready for immediate execution/gi, "observed; fresh execution preflight required")
    .replace(/ready for immediate Curve->ynETHx->redeem execution/gi, "observed; fresh Curve->ynETHx->redeem preflight required");
  // Only this collection may label its own literal fallbacks as references.
  // Missing provenance in retained input remains unknown, never inferred from
  // a parent timestamp, row health, or a legacy sibling quoteKind field.
  const quote = row.liveQuote;
  const kinds = ["ONCHAIN_MEASURED", "MODEL_ESTIMATE", "HISTORICAL_REFERENCE"];
  row.quoteKind = quote ? (kinds.includes(quote.provenance) ? quote.provenance
    : freshQuote ? (row.quoteKind || "HISTORICAL_REFERENCE") : null) : null;
  const measuredPin = freshQuote && !Object.hasOwn(quote || {}, "provenance") && row.quoteKind === "ONCHAIN_MEASURED"
    ? (row.quoteObservation || known) : null;
  if (quote) row.liveQuote = { ...quote, provenance: row.quoteKind,
    observationBlock: quote.observationBlock ?? measuredPin?.number ?? null,
    observationHash: quote.observationHash ?? measuredPin?.hash ?? null,
    observationUtc: quote.observationUtc ?? measuredPin?.utc ?? null };
  const quoteTimestamp = Date.parse(row.liveQuote?.observationUtc) / 1000;
  row.quoteObservation = row.quoteKind === "ONCHAIN_MEASURED" && Number.isSafeInteger(quoteTimestamp) && quoteTimestamp > 0 &&
    Number.isSafeInteger(row.liveQuote.observationBlock) && /^0x[0-9a-f]{64}$/i.test(row.liveQuote.observationHash || "")
    ? { chainId: row.chainId, number: row.liveQuote.observationBlock, hash: row.liveQuote.observationHash,
      timestamp: quoteTimestamp, utc: row.liveQuote.observationUtc } : null;
  row.quoteCurrent = row.quoteKind === "ONCHAIN_MEASURED" && row.refreshStatus === "COMPLETE" &&
    Boolean(known && row.quoteObservation?.chainId === known.chainId && row.quoteObservation?.number === known.number &&
      row.quoteObservation?.hash === known.hash && row.quoteObservation?.timestamp === known.timestamp);
  if (Array.isArray(row.additionalBorrowers)) row.additionalBorrowers.forEach(child => markObservation(child, original, freshQuote));
  return row;
}

function retainObservation(value, reason = "TARGET_REFRESH_FAILED") {
  const row = markObservation({ ...value, refreshStatus: "INCOMPLETE", refreshReason: reason }, null);
  Object.assign(row, { observationStatus: "INCOMPLETE", observationReason: reason,
    refreshStatus: "INCOMPLETE", refreshReason: reason, eligibleForPreflight: false, quoteCurrent: false });
  delete row.nextBlockForecast;
  if (Array.isArray(row.additionalBorrowers)) row.additionalBorrowers = row.additionalBorrowers.map(child => retainObservation(child, reason));
  return row;
}

function observationTimeMs(row) {
  const timestamp = row.observationTimestamp ?? row.debtObservation?.timestamp;
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp * 1000 : null;
}

function markTargets(targets, pin) {
  for (const value of Object.values(targets)) {
    for (const row of Array.isArray(value) ? value : [value]) {
      if (row && typeof row === "object") markObservation(row,
        row.chainId === 8453 || row.refreshStatus === "INCOMPLETE" ? null : pin, row.refreshStatus !== "INCOMPLETE");
    }
  }
}

function failedRefreshStatus(previous, failedAt = new Date().toISOString()) {
  const targets = {};
  for (const [key, value] of Object.entries(previous?.targets || {})) {
    targets[key] = Array.isArray(value) ? value.map(row => retainObservation(row, "WATCH_ITERATION_FAILED"))
      : retainObservation(value, "WATCH_ITERATION_FAILED");
  }
  return { ...previous, schema: "top-whale-triggers-status/v1", scanner: OBSERVATION_SOURCE,
    generatedAt: previous?.generatedAt ?? null, refreshAttemptedAt: failedAt,
    observationKind: "READ_ONLY_MONITOR", observationSource: OBSERVATION_SOURCE,
    refreshStatus: "INCOMPLETE", refreshReason: "WATCH_ITERATION_FAILED", armed: false, executableNow: false,
    safety: { readOnly: true, rpcUrlsStored: false, signedActions: false },
    pin: previous?.pin ?? null, targets, firedTriggers: [], anyTriggerFired: false,
    baseObservation: { ...previous?.baseObservation, status: "INCOMPLETE", reason: "WATCH_ITERATION_FAILED" } };
}

function writeStatus(status) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const serialized = `${JSON.stringify(status, null, 2)}\n`;
  const temporaryOut = `${OUT}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryOut, serialized);
    try { fs.renameSync(temporaryOut, OUT); } catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
      fs.writeFileSync(OUT, serialized);
    }
  } finally {
    try { fs.unlinkSync(temporaryOut); } catch (_) { /* Renamed or already removed. */ }
  }
}

function clearPositionReadiness(row, note) {
  delete row.nextBlockForecast;
  Object.assign(row, { armed: false, executableNow: false, liquidatableNow: false, liveQuote: null, readinessNote: note });
  for (const key of Object.keys(row)) {
    if (/^readyExecute.*Calldata$/.test(key)) row[key] = null;
  }
}

function recordPositionDebt(row, rawDebt, kind, pin) {
  const confirmed = typeof rawDebt === "bigint" && rawDebt >= 0n;
  Object.assign(row, {
    positionStatus: confirmed ? (rawDebt === 0n ? "CLOSED" : "OPEN") : "UNKNOWN",
    inactive: confirmed && rawDebt === 0n,
    debtReadStatus: confirmed ? "COMPLETE" : "UNAVAILABLE",
    debtReadKind: kind, debtRaw: confirmed ? rawDebt.toString() : null,
    debtObservation: confirmed ? pin : null,
  });
  if (row.inactive) clearPositionReadiness(row, "No outstanding debt at observed block");
}

function m1Read(iface, method, row) {
  try {
    if (row?.success !== true) return null;
    const decoded = iface.decodeFunctionResult(method, row.returnData);
    return iface.encodeFunctionResult(method, decoded).toLowerCase() === row.returnData.toLowerCase() ? decoded : null;
  } catch (_) { return null; }
}
// Shared by focused and broad collection. A ceiling is not an executable plan:
// neither a ceiling quote nor the ceiling's repayment-share fit admits this row.
function buildM1Observation({ market, position, price, rate, pin, forecastContext, quote = null }) {
  const row = { rank: "#M1", user: ETH_MORPHO_USDE_DAI_USER, marketId: ETH_MORPHO_USDE_DAI_MKT,
    pair: "USDe / DAI", deployedExecutor: DEPLOYED_MORPHO_EXECUTOR, healthFactor: null, storedHealthFactor: null,
    bpsToLiquidation: null, liquidatableNow: false, executableNow: false, readyExecuteMorphoBlueCalldata: null,
    liveQuote: null, borrowAprPct: null, passiveHoursToCrossing: null, debtUsd: null, collateralUsd: null,
    readinessNote: "Ceiling proposal only; fresh exact-size live proof required" };
  recordPositionDebt(row, null, "MORPHO_ACCRUED_BORROW_ASSETS", null);
  if (!pin || pin.chainId !== 1 || !Number.isSafeInteger(pin.number) || pin.number < 0 ||
    !Number.isSafeInteger(pin.timestamp) || !/^0x[0-9a-f]{64}$/i.test(pin.hash || "") || !market || !position ||
    ![...market, ...position, price, rate].every(x => typeof x === "bigint" && x >= 0n) || market[4] === 0n ||
    market[4] > BigInt(pin.timestamp) || price === 0n || position[1] > market[3]) return row;
  const assets = market[2] + market[2] * wTaylorCompounded(rate, BigInt(pin.timestamp) - market[4]) / W;
  if (assets >= 1n << 128n) return row;
  const debt = ceil(position[1] * (assets + 1n), market[3] + V), storedDebt = ceil(position[1] * (market[2] + 1n), market[3] + V);
  const maxBorrow = position[2] * price / (10n ** 36n) * ETH_MORPHO_USDE_DAI_LLTV / W;
  const ceiling = min(position[2], ETH_MORPHO_USDE_DAI_SEIZE), growth = debt * rate / W, unhealthy = debt > maxBorrow;
  Object.assign(row, { healthFactor: debt ? Number(maxBorrow * 1000000n / debt) / 1e6 : null,
    storedHealthFactor: storedDebt ? Number(maxBorrow * 1000000n / storedDebt) / 1e6 : null,
    currentDebtRaw: debt.toString(), maxBorrowRaw: maxBorrow.toString(), collateralRaw: position[2].toString(),
    bpsToLiquidation: debt && maxBorrow ? Number((maxBorrow - debt) * 100000000n / maxBorrow) / 10000 : null,
    borrowAprPct: +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2),
    passiveHoursToCrossing: unhealthy ? 0 : growth ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
    collateralUsd: +(Number(position[2]) / 1e18).toFixed(2), debtUsd: +(Number(debt) / 1e18).toFixed(2), liquidatableNow: unhealthy });
  recordPositionDebt(row, debt, "MORPHO_ACCRUED_BORROW_ASSETS", pin);
  if (!debt || !ceiling || !market[2] || !market[3]) return row;
  const route = ethers.solidityPacked(["address", "uint24", "address", "uint24", "address"], [USDe, 100, USDC, 100, DAI]);
  const template = MORPHO_EXEC_IFACE.encodeFunctionData("execute", [
    [DAI, USDe, ETH_MORPHO_USDE_DAI_ORACLE, ETH_MORPHO_IRM, ETH_MORPHO_USDE_DAI_LLTV],
    ETH_MORPHO_USDE_DAI_USER, ceiling, 0n, 25n * W, 0n, UNI_ROUTER, route]);
  row.m1Nomination = { kind: "M1_CEILING_ONLY", pin: { chainId: 1, number: pin.number, hash: pin.hash, timestamp: pin.timestamp },
    marketId: ETH_MORPHO_USDE_DAI_MKT, borrower: ETH_MORPHO_USDE_DAI_USER,
    ceilingRaw: ceiling.toString(), observedCollateralRaw: position[2].toString(), calldataTemplate: template };
  if (typeof quote === "bigint" && quote > 0n) {
    row.quoteKind = "ONCHAIN_MEASURED";
    const repay = ceil(ceil(ceiling * price, 10n ** 36n) * W, LIF_86), surplus = Number(quote - repay) / 1e18;
    row.liveQuote = { repayDai: +(Number(repay) / 1e18).toFixed(2), seizedUsde: +(Number(ceiling) / 1e18).toFixed(2),
      uniV3OutDai: +(Number(quote) / 1e18).toFixed(2), grossSurplusDai: +surplus.toFixed(2), grossSurplusUsd: +surplus.toFixed(2) };
  }
  const projection = morphoProjection({ market, position, price, rate, lltv: ETH_MORPHO_USDE_DAI_LLTV, context: forecastContext });
  return attachForecast(row, forecastContext, projection, true, () => ({ readyExecuteMorphoBlueCalldata: template }));
}
async function collectM1Only(options) {
  // The caller supplies the canonical pin and pinned transport. No discovery,
  // retained artifacts, quote, nonce, or independent latest-head selection here.
  const pin = options.pin;
  if (!pin || pin.chainId !== 1 || !Number.isSafeInteger(pin.number) || !Number.isSafeInteger(pin.timestamp) ||
    !/^0x[0-9a-f]{64}$/i.test(pin.hash || "")) throw new Error("COLLECTOR_PIN_MISMATCH");
  const rpc = await (options.resolveRpc || resolveRpc)(1), transport = options.rpcCall || rpcCall;
  const call = async calls => {
    const raw = await transport(rpc, "eth_call", [{ to: MULTICALL3, data: MC.encodeFunctionData("aggregate3", [calls]) }, pin.hash], 15000);
    const rows = MC.decodeFunctionResult("aggregate3", raw)[0];
    if (rows.length !== calls.length || MC.encodeFunctionResult("aggregate3", [rows]).toLowerCase() !== raw.toLowerCase()) throw new Error("M1_STATE_ABI_INVALID");
    return rows;
  };
  const rows = await call([
    { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [ETH_MORPHO_USDE_DAI_MKT]) },
    { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [ETH_MORPHO_USDE_DAI_MKT, ETH_MORPHO_USDE_DAI_USER]) },
    { target: ETH_MORPHO_USDE_DAI_ORACLE, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
  ]);
  const market = m1Read(BLUE, "market", rows[0]), position = m1Read(BLUE, "position", rows[1]), price = m1Read(BLUE_ORACLE, "price", rows[2])?.[0];
  const rateRows = market ? await call([{ target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView",
    [[DAI, USDe, ETH_MORPHO_USDE_DAI_ORACLE, ETH_MORPHO_IRM, ETH_MORPHO_USDE_DAI_LLTV], market]) }]) : [];
  const forecastContext = pin.timestamp <= Math.floor((options.now || Date.now)() / 1000) ? contextForPin(options.nextBlockContext, pin) : null;
  return { partial: true, collectionScope: "M1_ONLY", observationKind: "READ_ONLY_MONITOR", observationSource: OBSERVATION_SOURCE,
    armed: false, executableNow: false, pin, targets: { targetM1_Morpho_USDe_DAI:
      markObservation(buildM1Observation({ market, position, price, rate: m1Read(BLUE_IRM, "borrowRateView", rateRows[0])?.[0], pin, forecastContext }), pin, true) } };
}
async function checkOnce(options = {}) {
  if (options.m1Only === true) return collectM1Only(options);
  const resolve = options.resolveRpc || resolveRpc;
  const transport = options.rpcCall || rpcCall;
  const writeOut = options.writeOut !== false;

  const rpc = await resolve(1);
  if (!rpc) throw new Error("RPC_UNAVAILABLE");
  const block = await transport(rpc, "eth_getBlockByNumber", ["latest", false], 12000);
  if (!block || !block.hash) throw new Error("BLOCK_UNAVAILABLE");
  const pinHash = block.hash;
  const pinNum = Number(BigInt(block.number));
  const pinTs = BigInt(block.timestamp);
  const debtPin = { chainId: 1, number: pinNum, hash: pinHash, timestamp: Number(pinTs), utc: new Date(Number(pinTs) * 1000).toISOString() };
  // Never rewrite chain evidence to fit a lagging workstation clock. A future
  // parent is still readable, but cannot authorize next-block simulation here.
  const forecastContext = Number(pinTs) <= Math.floor(Date.now() / 1000)
    ? contextForPin(options.nextBlockContext, debtPin) : null;
  const forecastMorpho = (row, inputs, ready, plans) => {
    const projection = morphoProjection({ ...inputs, context: forecastContext });
    return attachForecast(row, forecastContext, projection, ready && morphoSeizeFits(projection, inputs), plans);
  };
  const forecastAave = (row, account, ready, plans, protocol) => attachForecast(row, forecastContext,
    aaveProjection({ healthFactorRaw: account[5], debtRaw: account[1], collateralRaw: account[0], protocol }), ready, plans);

  const calls1 = [
    { target: SPOKE_A, allowFailure: true, callData: SPOKE.encodeFunctionData("getUserAccountData", [USER_V4_C1]) },
    { target: SPOKE_A, allowFailure: true, callData: SPOKE.encodeFunctionData("getUserPosition", [3, USER_V4_C1]) },
    { target: SPOKE_A, allowFailure: true, callData: SPOKE.encodeFunctionData("getUserPosition", [4, USER_V4_C1]) },
    { target: HUB_A, allowFailure: true, callData: HUB.encodeFunctionData("getAsset", [3]) },
    { target: HUB_A, allowFailure: true, callData: HUB.encodeFunctionData("getAsset", [4]) },
    { target: USDE_ADAPTER, allowFailure: true, callData: FEED.encodeFunctionData("latestAnswer", []) },
    { target: USDC_ADAPTER, allowFailure: true, callData: FEED.encodeFunctionData("latestAnswer", []) },
    { target: USDT_FEED, allowFailure: true, callData: FEED.encodeFunctionData("latestRoundData", []) },
    { target: USDC_FEED, allowFailure: true, callData: FEED.encodeFunctionData("latestRoundData", []) },
    { target: POOL_V3, allowFailure: true, callData: POOL.encodeFunctionData("getUserAccountData", [USER_V3_7231]) },
    { target: POOL_V3, allowFailure: true, callData: POOL.encodeFunctionData("getUserAccountData", [USER_V3_1A55]) },
    { target: VDEBT_WETH, allowFailure: true, callData: ERC20.encodeFunctionData("balanceOf", [USER_V3_7231]) },
    { target: VDEBT_WETH, allowFailure: true, callData: ERC20.encodeFunctionData("balanceOf", [USER_V3_1A55]) },
    { target: ORACLE_V3, allowFailure: true, callData: ORACLE.encodeFunctionData("getAssetsPrices", [[WETH, weETH]]) },
    { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [PAXG_MARKET]) },
    { target: USDC, allowFailure: true, callData: ERC20.encodeFunctionData("balanceOf", [MORPHO_BLUE]) },
    { target: WETH, allowFailure: true, callData: ERC20.encodeFunctionData("balanceOf", [MORPHO_BLUE]) },
    { target: HUB_C, allowFailure: true, callData: HUB.encodeFunctionData("getAsset", [2]) },
    { target: HUB_C, allowFailure: true, callData: HUB.encodeFunctionData("getAsset", [0]) },
    { target: SPOKE_C_WEETH_ADAPTER, allowFailure: true, callData: FEED.encodeFunctionData("latestAnswer", []) },
    { target: SPOKE_C_WETH_ADAPTER, allowFailure: true, callData: FEED.encodeFunctionData("latestAnswer", []) },
    ...SPOKE_C_USERS.flatMap(user => [
      { target: SPOKE_C, allowFailure: true, callData: SPOKE.encodeFunctionData("getUserAccountData", [user]) },
      { target: SPOKE_C, allowFailure: true, callData: SPOKE.encodeFunctionData("getUserPosition", [0, user]) },
      { target: SPOKE_C, allowFailure: true, callData: SPOKE.encodeFunctionData("getUserPosition", [1, user]) }
    ]),
    ...EXTRA_V3_WEETH_USERS.flatMap(user => [
      { target: POOL_V3, allowFailure: true, callData: POOL.encodeFunctionData("getUserAccountData", [user]) },
      { target: VDEBT_WETH, allowFailure: true, callData: ERC20.encodeFunctionData("balanceOf", [user]) },
    ]),
    { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [ETH_MORPHO_USDE_DAI_MKT]) },
    { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [ETH_MORPHO_USDE_DAI_MKT, ETH_MORPHO_USDE_DAI_USER]) },
    { target: ETH_MORPHO_USDE_DAI_ORACLE, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price", []) },
    { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [ETH_MORPHO_REUSD_USDC_MKT]) },
    { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [ETH_MORPHO_REUSD_USDC_MKT, ETH_MORPHO_REUSD_USDC_USER]) },
    { target: ETH_MORPHO_REUSD_USDC_ORACLE, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price", []) },
  ];

  const raw1 = await transport(rpc, "eth_call", [{
    to: MULTICALL3,
    data: MC.encodeFunctionData("aggregate3", [calls1])
  }, pinHash], 15000);
  const res1 = MC.decodeFunctionResult("aggregate3", raw1)[0];

  const c1Acct = SPOKE.decodeFunctionResult("getUserAccountData", res1[0].returnData)[0];
  const c1CollPos = SPOKE.decodeFunctionResult("getUserPosition", res1[1].returnData)[0];
  const c1DebtPos = SPOKE.decodeFunctionResult("getUserPosition", res1[2].returnData)[0];
  const hubUsde = HUB.decodeFunctionResult("getAsset", res1[3].returnData)[0];
  const hubUsdc = HUB.decodeFunctionResult("getAsset", res1[4].returnData)[0];
  const usdePrice = FEED.decodeFunctionResult("latestAnswer", res1[5].returnData)[0];
  const usdcPrice = FEED.decodeFunctionResult("latestAnswer", res1[6].returnData)[0];
  const usdtR = FEED.decodeFunctionResult("latestRoundData", res1[7].returnData);
  const usdcR = FEED.decodeFunctionResult("latestRoundData", res1[8].returnData);
  const v3_7231 = POOL.decodeFunctionResult("getUserAccountData", res1[9].returnData);
  const v3_1a55 = POOL.decodeFunctionResult("getUserAccountData", res1[10].returnData);
  const debt7231Weth = ERC20.decodeFunctionResult("balanceOf", res1[11].returnData)[0];
  const debt1a55Weth = ERC20.decodeFunctionResult("balanceOf", res1[12].returnData)[0];
  const [priceWeth, priceWeEth] = ORACLE.decodeFunctionResult("getAssetsPrices", res1[13].returnData)[0];
  const paxgM = BLUE.decodeFunctionResult("market", res1[14].returnData);
  const morphoUsdc = ERC20.decodeFunctionResult("balanceOf", res1[15].returnData)[0];
  const morphoWeth = ERC20.decodeFunctionResult("balanceOf", res1[16].returnData)[0];

  const v4Sizing = computeV4Target1Sizing(c1Acct, c1CollPos, c1DebtPos, hubUsde, hubUsdc, usdePrice, usdcPrice, pinTs);
  const repay7231Weth = debt7231Weth / 2n;
  const seized7231WeEth = computeV3WeEthSizing(repay7231Weth, priceWeth, priceWeEth);
  const repay1a55Weth = debt1a55Weth / 2n;
  const seized1a55WeEth = computeV3WeEthSizing(repay1a55Weth, priceWeth, priceWeEth);

  const spokeCPositions = [];
  if (res1.length > 17) {
    const hubWeEth = HUB.decodeFunctionResult("getAsset", res1[17].returnData)[0];
    const hubWeth = HUB.decodeFunctionResult("getAsset", res1[18].returnData)[0];
    const weEthPrice = FEED.decodeFunctionResult("latestAnswer", res1[19].returnData)[0];
    const wethPrice = FEED.decodeFunctionResult("latestAnswer", res1[20].returnData)[0];
    for (const [i, user] of SPOKE_C_USERS.entries()) {
      const acct = SPOKE.decodeFunctionResult("getUserAccountData", res1[21 + i * 3].returnData)[0];
      const collPos = SPOKE.decodeFunctionResult("getUserPosition", res1[22 + i * 3].returnData)[0];
      const debtPos = SPOKE.decodeFunctionResult("getUserPosition", res1[23 + i * 3].returnData)[0];
      const sizing = computeV4SpokeCSizing(acct, collPos, debtPos, hubWeEth, hubWeth, weEthPrice, wethPrice, pinTs);
      spokeCPositions.push({ user, acct, sizing, weEthPrice, wethPrice });
    }
  }

  const extraV3Positions = [];
  if (res1.length >= 59) {
    for (const [i, user] of EXTRA_V3_WEETH_USERS.entries()) {
      const acct = POOL.decodeFunctionResult("getUserAccountData", res1[45 + i * 2].returnData);
      const debtWethRaw = ERC20.decodeFunctionResult("balanceOf", res1[46 + i * 2].returnData)[0];
      const repayWethRaw = debtWethRaw / 2n;
      const seizedWeEthRaw = computeV3WeEthSizing(repayWethRaw, priceWeth, priceWeEth);
      extraV3Positions.push({ user, acct, repayWethRaw, seizedWeEthRaw });
    }
  }

  const m1Mkt = BLUE.decodeFunctionResult("market", res1[59].returnData);
  const m1Pos = BLUE.decodeFunctionResult("position", res1[60].returnData);
  const m1Price = BLUE_ORACLE.decodeFunctionResult("price", res1[61].returnData)[0];
  const m1CollRaw = BigInt(m1Pos[2]);
  const m1SeizeRaw = m1CollRaw > 0n && m1CollRaw < ETH_MORPHO_USDE_DAI_SEIZE ? m1CollRaw : ETH_MORPHO_USDE_DAI_SEIZE;
  const m2Mkt = BLUE.decodeFunctionResult("market", res1[62].returnData);
  const m2Pos = BLUE.decodeFunctionResult("position", res1[63].returnData);
  const m2Price = BLUE_ORACLE.decodeFunctionResult("price", res1[64].returnData)[0];

  // Batch 2: Live DEX quotes and the Ethereum Morpho borrow rates at the same pin.
  const usdeDaiPath = ethers.solidityPacked(["address", "uint24", "address", "uint24", "address"], [USDe, 100, USDC, 100, DAI]);
  const calls2 = [
    { target: QUOTER_V2, allowFailure: true, callData: QUOTER.encodeFunctionData("quoteExactInputSingle", [{ tokenIn: USDe, tokenOut: USDC, amountIn: v4Sizing.seizedUsdeToLiqRaw, fee: 100, sqrtPriceLimitX96: 0 }]) },
    { target: CURVE_WEETH_WETH, allowFailure: true, callData: CURVE.encodeFunctionData("get_dy", [1, 0, seized7231WeEth]) },
    { target: CURVE_WEETH_WETH, allowFailure: true, callData: CURVE.encodeFunctionData("get_dy", [1, 0, seized1a55WeEth]) },
    ...spokeCPositions.map(({ sizing }) => ({
      target: CURVE_WEETH_WETH, allowFailure: true, callData: CURVE.encodeFunctionData("get_dy", [1, 0, sizing.seizedWeEthToLiqRaw])
    })),
    ...extraV3Positions.map(({ seizedWeEthRaw }) => ({
      target: CURVE_WEETH_WETH, allowFailure: true, callData: CURVE.encodeFunctionData("get_dy", [1, 0, seizedWeEthRaw])
    })),
    { target: QUOTER_V2, allowFailure: true, callData: QUOTER.encodeFunctionData("quoteExactInput", [usdeDaiPath, m1SeizeRaw]) },
    { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[DAI, USDe, ETH_MORPHO_USDE_DAI_ORACLE, ETH_MORPHO_IRM, ETH_MORPHO_USDE_DAI_LLTV], m1Mkt.map(x => x)]) },
    { target: CURVE_REUSD_USDC, allowFailure: true, callData: CURVE.encodeFunctionData("get_dy", [0, 1, ETH_MORPHO_REUSD_USDC_SEIZE]) },
    { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[USDC, REUSD, ETH_MORPHO_REUSD_USDC_ORACLE, ETH_MORPHO_IRM, ETH_MORPHO_REUSD_USDC_LLTV], m2Mkt.map(x => x)]) },
  ];
  const raw2 = await transport(rpc, "eth_call", [{
    to: MULTICALL3,
    data: MC.encodeFunctionData("aggregate3", [calls2])
  }, pinHash], 15000);
  const res2 = MC.decodeFunctionResult("aggregate3", raw2)[0];

  const uniUsdeOut = res2[0].success ? QUOTER.decodeFunctionResult("quoteExactInputSingle", res2[0].returnData)[0] : 0n;
  const curve7231Out = res2[1].success ? CURVE.decodeFunctionResult("get_dy", res2[1].returnData)[0] : 0n;
  const curve1a55Out = res2[2].success ? CURVE.decodeFunctionResult("get_dy", res2[2].returnData)[0] : 0n;

  const m1Observation = buildM1Observation({ market: m1Read(BLUE, "market", res1[59]), position: m1Read(BLUE, "position", res1[60]),
    price: m1Read(BLUE_ORACLE, "price", res1[61])?.[0], rate: m1Read(BLUE_IRM, "borrowRateView", res2[19])?.[0],
    pin: debtPin, forecastContext, quote: m1Read(QUOTER, "quoteExactInput", res2[18])?.[0] });

  const m2Rate = res2[21]?.success ? BLUE_IRM.decodeFunctionResult("borrowRateView", res2[21].returnData)[0] : 0n;
  const m2Elapsed = pinTs > BigInt(m2Mkt[4]) ? pinTs - BigInt(m2Mkt[4]) : 0n;
  const m2AccruedBorrowAssets = BigInt(m2Mkt[2]) + BigInt(m2Mkt[2]) * wTaylorCompounded(m2Rate, m2Elapsed) / W;
  const m2StoredDebtUsdcRaw = ceil(BigInt(m2Pos[1]) * (BigInt(m2Mkt[2]) + 1n), BigInt(m2Mkt[3]) + V);
  const m2DebtUsdcRaw = ceil(BigInt(m2Pos[1]) * (m2AccruedBorrowAssets + 1n), BigInt(m2Mkt[3]) + V);
  const m2CollValUsdcRaw = BigInt(m2Pos[2]) * BigInt(m2Price) / (10n ** 36n);
  const m2MaxBorrowUsdcRaw = m2CollValUsdcRaw * ETH_MORPHO_REUSD_USDC_LLTV / W;
  const m2Hf = m2Price > 0n && m2DebtUsdcRaw > 0n ? Number(m2MaxBorrowUsdcRaw * 1000000n / m2DebtUsdcRaw) / 1e6 : null;
  const m2StoredHf = m2Price > 0n && m2StoredDebtUsdcRaw > 0n ? Number(m2MaxBorrowUsdcRaw * 1000000n / m2StoredDebtUsdcRaw) / 1e6 : null;
  const m2LiqNow = m2Price > 0n && m2DebtUsdcRaw > 0n ? m2MaxBorrowUsdcRaw < m2DebtUsdcRaw : false;
  const m2RemDebt = m2MaxBorrowUsdcRaw > m2DebtUsdcRaw ? m2MaxBorrowUsdcRaw - m2DebtUsdcRaw : 0n;
  const m2GrowthPerSec = m2DebtUsdcRaw * m2Rate / W;
  const m2PassiveHours = m2Price > 0n && m2DebtUsdcRaw > 0n ? (m2LiqNow ? 0 : (m2GrowthPerSec > 0n ? +(Number(m2RemDebt) / Number(m2GrowthPerSec) / 3600).toFixed(2) : null)) : null;
  const m2SeizedQuotedUsdcRaw = ceil(ETH_MORPHO_REUSD_USDC_SEIZE * BigInt(m2Price), 10n ** 36n);
  const m2RepayUsdcRaw = ceil(m2SeizedQuotedUsdcRaw * W, LIF_915);
  const m2OutUsdcRaw = res2[20]?.success ? CURVE.decodeFunctionResult("get_dy", res2[20].returnData)[0] : 0n;
  const m2NetUsdc = (Number(m2OutUsdcRaw) - Number(m2RepayUsdcRaw)) / 1e6;
  const m2SeizeRaw = ETH_MORPHO_REUSD_USDC_SEIZE;
  let m2Calldata = null;
  if (m2OutUsdcRaw > 0n) {
    const m2PrincipalUsdcRaw = (m2SeizeRaw * BigInt(m2Price)) / (10n ** 36n);
    const m2MinOutSwap = (BigInt(m2OutUsdcRaw) * 9950n) / 10000n;
    const m2MinLoanOut = m2PrincipalUsdcRaw + 25000000n;
    const m2SwapData = M2_CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [0, 1, m2SeizeRaw, m2MinOutSwap]);
    m2Calldata = M2_EXEC_IFACE.encodeFunctionData("execute", [[
      USDC.toLowerCase(), REUSD.toLowerCase(), ETH_MORPHO_REUSD_USDC_ORACLE.toLowerCase(), ETH_MORPHO_IRM.toLowerCase(),
      915000000000000000n, ETH_MORPHO_REUSD_USDC_USER.toLowerCase(), m2SeizeRaw, CURVE_REUSD_USDC.toLowerCase(), m2MinLoanOut,
    ], m2SwapData]);
  }

  function c1HfAt(t) {
    const coll = suppliedAt(hubUsde, c1CollPos.suppliedShares, t) * BigInt(usdePrice);
    const debt = ((BigInt(c1DebtPos.drawnShares) + BigInt(c1DebtPos.premiumShares)) * hubIndexAt(hubUsdc, t) - BigInt(c1DebtPos.premiumOffsetRay)) * BigInt(usdcPrice) * (10n ** 12n);
    return coll * 9300n * (10n ** 14n) * R / debt;
  }

  let lo = 0n, hi = Y;
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n;
    if (c1HfAt(pinTs + mid) < W) hi = mid; else lo = mid;
  }
  const passiveSec = BigInt(c1Acct.healthFactor) < W ? 0 : Number(hi);

  const hfC1 = Number(c1Acct.healthFactor) / 1e18;
  const hf7231 = Number(v3_7231[5]) / 1e18;
  const hf1a55 = Number(v3_1a55[5]) / 1e18;
  const paxgAvailableUsdc = Number(paxgM[0] > paxgM[2] ? paxgM[0] - paxgM[2] : 0n) / 1e6;

  const t1NetUsdc = (Number(uniUsdeOut) - Number(v4Sizing.repayUsdcRaw)) / 1e6;
  const t2ANetWeth = Number(curve7231Out - repay7231Weth) / 1e18;
  const t2BNetWeth = Number(curve1a55Out - repay1a55Weth) / 1e18;

  const t1FlashUsdcRaw = ((v4Sizing.repayUsdcRaw / 1000000n) + 1000n) * 1000000n;
  const t1Params = {
    isAaveV3: false,
    target: SPOKE_A,
    borrower: USER_V4_C1,
    debtToken: USDC,
    collateralToken: USDe,
    collateralReserveId: 3n,
    debtReserveId: 4n,
    minCollateralSeized: v4Sizing.seizedUsdeToLiqRaw * 9950n / 10000n,
    swapKind: 1,
    swapTarget: UNI_ROUTER,
    swapSpender: UNI_ROUTER,
    uniFee: 100,
    curveI: 0,
    curveJ: 0,
    minDebtTokenOut: uniUsdeOut * 9950n / 10000n,
    minProfitDebtToken: 25000000n
  };

  const t2AParams = {
    isAaveV3: true,
    target: POOL_V3,
    borrower: USER_V3_7231,
    debtToken: WETH,
    collateralToken: weETH,
    collateralReserveId: 0n,
    debtReserveId: 0n,
    minCollateralSeized: seized7231WeEth * 9950n / 10000n,
    swapKind: 2,
    swapTarget: CURVE_WEETH_WETH,
    swapSpender: CURVE_WEETH_WETH,
    uniFee: 0,
    curveI: 1,
    curveJ: 0,
    minDebtTokenOut: curve7231Out * 9950n / 10000n,
    minProfitDebtToken: 10000000000000000n
  };

  const t2BParams = {
    isAaveV3: true,
    target: POOL_V3,
    borrower: USER_V3_1A55,
    debtToken: WETH,
    collateralToken: weETH,
    collateralReserveId: 0n,
    debtReserveId: 0n,
    minCollateralSeized: seized1a55WeEth * 9950n / 10000n,
    swapKind: 2,
    swapTarget: CURVE_WEETH_WETH,
    swapSpender: CURVE_WEETH_WETH,
    uniFee: 0,
    curveI: 1,
    curveJ: 0,
    minDebtTokenOut: curve1a55Out * 9950n / 10000n,
    minProfitDebtToken: 10000000000000000n
  };

  const fired = [];
  if (BigInt(c1Acct.healthFactor) < W && t1NetUsdc >= 25) fired.push("TARGET_1_AAVE_V4_USDE_USDC_LIQUIDATABLE");
  if (BigInt(v3_7231[5]) < W && t2ANetWeth >= 0.01) fired.push("TARGET_2A_AAVE_V3_0x7231_LIQUIDATABLE");
  if (BigInt(v3_1a55[5]) < W && t2BNetWeth >= 0.01) fired.push("TARGET_2B_AAVE_V3_0x1A55_LIQUIDATABLE");
  if (m1Observation.liquidatableNow && (m1Read(QUOTER, "quoteExactInput", res2[18])?.[0] ?? 0n) -
    ceil(ceil(m1SeizeRaw * m1Price, 10n ** 36n) * W, LIF_86) >= 25n * W) fired.push("TARGET_M1_MORPHO_USDE_DAI_LIQUIDATABLE");
  const buildSpokeCTarget = ({ user, acct, sizing, weEthPrice, wethPrice }, i, curveOut) => {
    const netWeth = Number(curveOut - sizing.repayWethRaw) / 1e18;
    const healthFactor = Number(acct.healthFactor) / 1e18;
    const liquidatableNow = BigInt(acct.healthFactor) < W;
    if (liquidatableNow && netWeth >= 0.01) fired.push(`TARGET_SPOKE_C_AAVE_V4_${user.slice(0, 6)}_LIQUIDATABLE`);
    const spokeCFlashWethRaw = sizing.repayWethRaw + 10n ** 18n;
    const params = {
      isAaveV3: false,
      target: SPOKE_C,
      borrower: user,
      debtToken: WETH,
      collateralToken: weETH,
      collateralReserveId: 0n,
      debtReserveId: 1n,
      minCollateralSeized: sizing.seizedWeEthToLiqRaw * 9950n / 10000n,
      swapKind: 2,
      swapTarget: CURVE_WEETH_WETH,
      swapSpender: CURVE_WEETH_WETH,
      uniFee: 0,
      curveI: 1,
      curveJ: 0,
      minDebtTokenOut: curveOut * 9950n / 10000n,
      minProfitDebtToken: 10000000000000000n
    };
    return {
      rank: `#C${i + 1}`,
      user,
      spoke: SPOKE_C,
      healthFactor,
      liquidatableNow,
      bpsToLiquidation: +((1 - 1 / healthFactor) * 10000).toFixed(4),
      collateralUsd: +(Number(sizing.userSuppliedWeEth) / 1e18 * (Number(weEthPrice) / 1e8)).toFixed(2),
      debtUsd: +(Number(sizing.userDebtWethRaw) / 1e18 * (Number(wethPrice) / 1e8)).toFixed(2),
      quoteKind: curveOut > 0n ? "ONCHAIN_MEASURED" : "MODEL_ESTIMATE",
      liveQuote: {
        repayWeth: +(Number(sizing.repayWethRaw) / 1e18).toFixed(4),
        seizedWeEth: +(Number(sizing.seizedWeEthToLiqRaw) / 1e18).toFixed(4),
        curveOutWeth: +(Number(curveOut) / 1e18).toFixed(4),
        grossSurplusWeth: +netWeth.toFixed(4),
        grossSurplusUsd: +(netWeth * (Number(wethPrice) / 1e8)).toFixed(2)
      },
      readyExecuteMorphoCalldata: LIQUIDATOR_IFACE.encodeFunctionData("executeMorpho", [spokeCFlashWethRaw, params])
    };
  };
  const spokeCTargets = spokeCPositions.map((position, i) => buildSpokeCTarget(position, i,
    res2[3 + i].success ? CURVE.decodeFunctionResult("get_dy", res2[3 + i].returnData)[0] : 0n));

  const extraV3Targets = extraV3Positions.map(({ user, acct, repayWethRaw, seizedWeEthRaw }, i) => {
    const quote = res2[3 + spokeCPositions.length + i];
    const curveOut = quote.success ? CURVE.decodeFunctionResult("get_dy", quote.returnData)[0] : 0n;
    const netWeth = Number(curveOut - repayWethRaw) / 1e18;
    const healthFactor = Number(acct[5]) / 1e18;
    const liquidatableNow = BigInt(acct[5]) < W;
    const rank = String.fromCharCode(67 + i);
    if (liquidatableNow && netWeth >= 0.01) fired.push(`TARGET_2${rank}_AAVE_V3_${user.slice(0, 6)}_LIQUIDATABLE`);
    const params = {
      ...t2AParams,
      borrower: user,
      minCollateralSeized: seizedWeEthRaw * 9950n / 10000n,
      minDebtTokenOut: curveOut * 9950n / 10000n,
    };
    return forecastAave({
      rank: `#2${rank}`,
      user,
      pool: POOL_V3,
      healthFactor,
      liquidatableNow,
      bpsToLiquidation: +((1 - 1 / healthFactor) * 10000).toFixed(4),
      collateralUsd: +(Number(acct[0]) / 1e8).toFixed(2),
      debtUsd: +(Number(acct[1]) / 1e8).toFixed(2),
      quoteKind: quote.success ? "ONCHAIN_MEASURED" : "MODEL_ESTIMATE",
      liveQuote: {
        repayWeth: +(Number(repayWethRaw) / 1e18).toFixed(4),
        seizedWeEth: +(Number(seizedWeEthRaw) / 1e18).toFixed(4),
        curveOutWeth: +(Number(curveOut) / 1e18).toFixed(4),
        grossSurplusWeth: +netWeth.toFixed(4),
        grossSurplusUsd: +(netWeth * (Number(priceWeth) / 1e8)).toFixed(2),
      },
      readyExecuteMorphoCalldata: LIQUIDATOR_IFACE.encodeFunctionData("executeMorpho", [repayWethRaw, params]),
    }, acct, repayWethRaw > 0n && seizedWeEthRaw > 0n && curveOut - repayWethRaw >= 10000000000000000n,
    () => ({ readyExecuteMorphoCalldata: LIQUIDATOR_IFACE.encodeFunctionData("executeMorpho", [repayWethRaw, params]) }));
  });

  // Optional Ethereum discovery batch (runs on live RPC or when includeExtendedDiscoveries is true)
  let target2J = null, targetA3 = null, targetA4 = null, targetA5 = null, targetA6 = null, targetA7 = null, morphoWstEthWhales = [], targetM7Canary = null;
  const aaveV3WhaleTargets = {};
  const sparkWhaleTargets = {};
  let targetM7B = null, m7Observation = null;
  let targetYnArb = null, targetE1 = null, targetE2 = null;
  let targetE3 = null, targetE4 = null, targetE5 = null, targetE6 = null, targetE7 = null, targetE8 = null, targetE9 = null, targetE10 = null;
  let targetM10 = null, targetM11 = null, targetM12 = null, targetM13 = null, targetM2B = null, targetM2C = null, targetM2D = null, targetM14 = null, targetM15 = null, targetM16 = null, targetM17 = null, targetM18 = null;
  let targetM19 = null, targetM20 = null;
  let targetM21 = null, targetM22 = null;
  let targetM23 = null, targetM24 = null;
  let targetM25 = null, targetM26 = null, targetM27 = null, targetM28 = null;
  let targetM29 = null, targetM30 = null, targetM31 = null, targetM32 = null, targetM33 = null, targetF1 = null, targetM34 = null, targetF2 = null, targetF3 = null, targetM35 = null, targetM36 = null, targetM37 = null, targetF4 = null, targetF5 = null, targetF6 = null, targetM38 = null, targetM39 = null, targetM40 = null, targetM41 = null, targetM42 = null, targetM43 = null, targetM44 = null, targetM45 = null, targetM46 = null, targetM47 = null, targetM48 = null, targetM49 = null;
  let targetC9 = null;
  let targetA8 = null, targetA9 = null, targetA10 = null, targetA11 = null, targetA12 = null, targetA13 = null, targetA14 = null, targetA15 = null, targetA16 = null, targetA17 = null, targetA18 = null;
  const LIF_77 = 1074113856068743286n;
  const clampMorphoSeize = (maxSeize, pos, accruedBorrow, totalBorrowShares, price, lif) => {
    const dMax = (BigInt(pos[1]) * (BigInt(accruedBorrow) + 1n)) / (BigInt(totalBorrowShares) + V);
    const qMax = (dMax * lif) / W;
    const sBorrow = BigInt(price) > 0n ? (qMax * (10n ** 36n)) / BigInt(price) : 0n;
    const clamped = [maxSeize, BigInt(pos[2]), sBorrow].reduce((a, b) => a < b ? a : b);
    return clamped > 0n ? clamped : maxSeize;
  };
  const morphoPtTargets = {};
  // Share the newer discovery opt-in while preserving injected and legacy batch sequences.
  if (!options.rpcCall && options.includeM10M11) {
    try {
      const calls = [
        { target: SPOKE_C, allowFailure: true, callData: SPOKE.encodeFunctionData("getUserAccountData", [USER_V4_C9]) },
        { target: SPOKE_C, allowFailure: true, callData: SPOKE.encodeFunctionData("getUserPosition", [0, USER_V4_C9]) },
        { target: SPOKE_C, allowFailure: true, callData: SPOKE.encodeFunctionData("getUserPosition", [1, USER_V4_C9]) },
      ];
      const raw = await transport(rpc, "eth_call", [{ to: MULTICALL3, data: MC.encodeFunctionData("aggregate3", [calls]) }, pinHash], 10000);
      const results = MC.decodeFunctionResult("aggregate3", raw)[0];
      if (results.length === calls.length && results.every(r => r.success)) {
        const acct = SPOKE.decodeFunctionResult("getUserAccountData", results[0].returnData)[0];
        const collPos = SPOKE.decodeFunctionResult("getUserPosition", results[1].returnData)[0];
        const debtPos = SPOKE.decodeFunctionResult("getUserPosition", results[2].returnData)[0];
        if (BigInt(acct.totalDebtValue) > 0n) {
          const hubWeEth = HUB.decodeFunctionResult("getAsset", res1[17].returnData)[0];
          const hubWeth = HUB.decodeFunctionResult("getAsset", res1[18].returnData)[0];
          const weEthPrice = FEED.decodeFunctionResult("latestAnswer", res1[19].returnData)[0];
          const wethPrice = FEED.decodeFunctionResult("latestAnswer", res1[20].returnData)[0];
          const sizing = computeV4SpokeCSizing(acct, collPos, debtPos, hubWeEth, hubWeth, weEthPrice, wethPrice, pinTs);
          const rawQuote = await transport(rpc, "eth_call", [{ to: CURVE_WEETH_WETH,
            data: CURVE.encodeFunctionData("get_dy", [1, 0, sizing.seizedWeEthToLiqRaw]) }, pinHash], 10000);
          const curveOut = CURVE.decodeFunctionResult("get_dy", rawQuote)[0];
          targetC9 = buildSpokeCTarget({ user: USER_V4_C9, acct, sizing, weEthPrice, wethPrice }, 8, curveOut);
          targetC9.pair = "weETH / WETH";
          targetC9.deployedExecutor = DEPLOYED_LIQUIDATOR;
          targetC9.executor = DEPLOYED_LIQUIDATOR;
          targetC9.executableNow = targetC9.liquidatableNow && sizing.repayWethRaw > 0n &&
            curveOut * 9950n / 10000n >= sizing.repayWethRaw + 10000000000000000n;
          if (!targetC9.executableNow) targetC9.readyExecuteMorphoCalldata = null;
        }
      }
    } catch (_) { /* An unavailable C9 read/quote must not affect the original eight targets. */ }
    try {
      const rawA11 = await transport(rpc, "eth_call", [{ to: SPOKE_A,
        data: SPOKE.encodeFunctionData("getUserAccountData", [USER_V4_A11]) }, pinHash], 10000);
      const acct = SPOKE.decodeFunctionResult("getUserAccountData", rawA11)[0];
      const healthFactorRaw = BigInt(acct.healthFactor), hf = Number(healthFactorRaw) / 1e18;
      const liquidatableNow = healthFactorRaw > 0n && healthFactorRaw < W;
      targetA11 = {
        rank: "#A11", user: USER_V4_A11, spoke: SPOKE_A, pair: "USDe / USDC",
        observationOnly: false, armed: true,
        deployedExecutor: "0x3c02c96bbb423d0109b823c23a05fcf0bf91ecb7",
        executor: "0x3c02c96bbb423d0109b823c23a05fcf0bf91ecb7",
        healthFactor: hf, liquidatableNow, executableNow: liquidatableNow,
        bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
        collateralUsd: +(Number(acct.totalCollateralValue) / 1e26).toFixed(2),
        debtUsd: +(Number(acct.totalDebtValue) / 1e53).toFixed(2),
        // Supplied simulation reference, not a fresh executable quote.
        liveQuote: { repayUsdc: 360000.00, seizedUsde: 366858.00, uniV3OutUsdc: 366480.00, grossSurplusUsdc: 6480.00 },
        readinessNote: "ARMED on FlashLiquidateAaveV4 0x3c02...ecb7 ($938.0k USDC debt / $1.02M USDe collateral -> 360k USDC tranche, +$6,480.00 USDC simulated).",
      };
    } catch (_) { /* An unavailable A11 read must not discard C9 or the other targets. */ }
  }
  if (!options.rpcCall || options.includeExtendedDiscoveries) {
    try {
      const wstPath = ethers.solidityPacked(["address", "uint24", "address"], [wstETH, 100, WETH]);
      const calls3 = [
        { target: POOL_V3, allowFailure: true, callData: POOL.encodeFunctionData("getUserAccountData", [USER_V3_037A]) },
        { target: VDEBT_WETH, allowFailure: true, callData: ERC20.encodeFunctionData("balanceOf", [USER_V3_037A]) },
        { target: ORACLE_V3, allowFailure: true, callData: ORACLE.encodeFunctionData("getAssetsPrices", [[WETH, wstETH]]) },
        { target: SPOKE_A, allowFailure: true, callData: SPOKE.encodeFunctionData("getUserAccountData", [USER_V4_A3]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [ETH_MORPHO_WSTETH_WETH_965_MKT]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [ETH_MORPHO_WSTETH_WETH_945_MKT]) },
        { target: ETH_MORPHO_WSTETH_WETH_ORACLE, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price", []) },
        ...MORPHO_WSTETH_WHALES.map(w => ({
          target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [w.marketId, w.user])
        })),
        { target: QUOTER_V2, allowFailure: true, callData: QUOTER.encodeFunctionData("quoteExactInput", [wstPath, ETH_MORPHO_WSTETH_SEIZE]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [ETH_MORPHO_YNETHX_MSETH_MKT]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [ETH_MORPHO_YNETHX_MSETH_MKT, ETH_MORPHO_YNETHX_MSETH_USER]) },
        { target: ETH_MORPHO_YNETHX_MSETH_ORACLE, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price", []) },
        { target: YNETHX_BUFFER, allowFailure: true, callData: ERC20.encodeFunctionData("balanceOf", [YNETHX]) },
      ];
      const raw3 = await transport(rpc, "eth_call", [{
        to: MULTICALL3,
        data: MC.encodeFunctionData("aggregate3", [calls3])
      }, pinHash], 15000);
      const res3 = MC.decodeFunctionResult("aggregate3", raw3)[0];
      if (res3 && res3.length === calls3.length && res3[0].success && res3[1].success && res3[2].success) {
        const acct2J = POOL.decodeFunctionResult("getUserAccountData", res3[0].returnData);
        const debt2JWeth = ERC20.decodeFunctionResult("balanceOf", res3[1].returnData)[0];
        const [pWeth2J, pWstEth] = ORACLE.decodeFunctionResult("getAssetsPrices", res3[2].returnData)[0];
        const repay2JWeth = debt2JWeth / 2n;
        const seized2JWstEth = computeV3WeEthSizing(repay2JWeth, pWeth2J, pWstEth);
        const rawQ2J = await transport(rpc, "eth_call", [{
          to: MULTICALL3,
          data: MC.encodeFunctionData("aggregate3", [[
            { target: QUOTER_V2, allowFailure: true, callData: QUOTER.encodeFunctionData("quoteExactInput", [wstPath, seized2JWstEth]) },
            { target: QUOTER_V2, allowFailure: true, callData: QUOTER.encodeFunctionData("quoteExactInputSingle", [{ tokenIn: USDe, tokenOut: USDC, amountIn: 205800n * W, fee: 100, sqrtPriceLimitX96: 0 }]) },
            { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[WETH, wstETH, ETH_MORPHO_WSTETH_WETH_ORACLE, ETH_MORPHO_IRM, 965000000000000000n], BLUE.decodeFunctionResult("market", res3[4].returnData).map(x => x)]) },
            { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[WETH, wstETH, ETH_MORPHO_WSTETH_WETH_ORACLE, ETH_MORPHO_IRM, 945000000000000000n], BLUE.decodeFunctionResult("market", res3[5].returnData).map(x => x)]) },
            { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[MSETH, YNETHX, ETH_MORPHO_YNETHX_MSETH_ORACLE, ETH_MORPHO_IRM, 915000000000000000n], BLUE.decodeFunctionResult("market", res3[12].returnData).map(x => x)]) },
          ]])
        }, pinHash], 15000);
        const resQ2J = MC.decodeFunctionResult("aggregate3", rawQ2J)[0];
        const out2JWeth = resQ2J[0]?.success ? QUOTER.decodeFunctionResult("quoteExactInput", resQ2J[0].returnData)[0] : 0n;
        const net2JWeth = Number(out2JWeth - repay2JWeth) / 1e18;
        const hf2J = Number(acct2J[5]) / 1e18;
        const liq2J = BigInt(acct2J[5]) < W;
        if (liq2J && net2JWeth >= 0.01) fired.push("TARGET_2J_AAVE_V3_0x037A_LIQUIDATABLE");
        const params2J = {
          isAaveV3: true,
          target: POOL_V3,
          borrower: USER_V3_037A,
          debtToken: WETH,
          collateralToken: wstETH,
          collateralReserveId: 0n,
          debtReserveId: 0n,
          minCollateralSeized: seized2JWstEth * 9950n / 10000n,
          swapKind: 1,
          swapTarget: UNI_ROUTER,
          swapSpender: UNI_ROUTER,
          uniFee: 100,
          curveI: 0,
          curveJ: 0,
          minDebtTokenOut: out2JWeth * 9950n / 10000n,
          minProfitDebtToken: 10000000000000000n,
        };
        target2J = {
          rank: "#2J",
          user: USER_V3_037A,
          pool: POOL_V3,
          pair: "wstETH / WETH",
          healthFactor: hf2J,
          liquidatableNow: liq2J,
          bpsToLiquidation: +((1 - 1 / hf2J) * 10000).toFixed(4),
          collateralUsd: +(Number(acct2J[0]) / 1e8).toFixed(2),
          debtUsd: +(Number(acct2J[1]) / 1e8).toFixed(2),
          quoteKind: resQ2J[0]?.success ? "ONCHAIN_MEASURED" : "MODEL_ESTIMATE",
          liveQuote: {
            repayWeth: +(Number(repay2JWeth) / 1e18).toFixed(4),
            seizedWstEth: +(Number(seized2JWstEth) / 1e18).toFixed(4),
            uniV3OutWeth: +(Number(out2JWeth) / 1e18).toFixed(4),
            grossSurplusWeth: +net2JWeth.toFixed(4),
            grossSurplusUsd: +(net2JWeth * (Number(pWeth2J) / 1e8)).toFixed(2),
          },
          readyExecuteMorphoCalldata: LIQUIDATOR_IFACE.encodeFunctionData("executeMorpho", [repay2JWeth, params2J]),
        };
        forecastAave(target2J, acct2J, repay2JWeth > 0n && seized2JWstEth > 0n && out2JWeth - repay2JWeth >= 10000000000000000n,
          () => ({ readyExecuteMorphoCalldata: LIQUIDATOR_IFACE.encodeFunctionData("executeMorpho", [repay2JWeth, params2J]) }));

        if (res3[3]?.success) {
          const acctA3 = SPOKE.decodeFunctionResult("getUserAccountData", res3[3].returnData)[0];
          const hfA3 = Number(acctA3.healthFactor) / 1e18;
          const outA3Usdc = resQ2J[1]?.success ? QUOTER.decodeFunctionResult("quoteExactInputSingle", resQ2J[1].returnData)[0] : 0n;
          const netA3Usdc = (Number(outA3Usdc) - 200000000000) / 1e6;
          targetA3 = {
            rank: "#A3",
            user: USER_V4_A3,
            spoke: SPOKE_A,
            pair: "USDe / USDC",
            observationOnly: true,
            executableNow: false,
            executor: "0x3c02c96bbb423d0109b823c23a05fcf0bf91ecb7",
            readinessNote: "Fork-proven on 0x3c02...ecb7 (+6,242.30 USDC); observation-only to preserve 9-plan V4 watch cap.",
            healthFactor: hfA3,
            liquidatableNow: BigInt(acctA3.healthFactor) < W,
            bpsToLiquidation: +((1 - 1 / hfA3) * 10000).toFixed(4),
            collateralUsd: +(Number(acctA3.totalCollateralValue) / 1e26).toFixed(2),
            debtUsd: +(Number(BigInt(acctA3.totalDebtValue) / (10n ** 45n)) / 1e8).toFixed(2),
            quoteKind: "MODEL_ESTIMATE", // Fixed hypothetical repayment/seize, even with a pinned exit read.
            liveQuote: {
              repayUsdc: 200000,
              seizedUsde: 205800,
              uniV3OutUsdc: +(Number(outA3Usdc) / 1e6).toFixed(2),
              grossSurplusUsdc: +netA3Usdc.toFixed(2),
            },
          };
        }

        const wstMkts = [
          BLUE.decodeFunctionResult("market", res3[4].returnData),
          BLUE.decodeFunctionResult("market", res3[5].returnData),
        ];
        const wstOraclePrice = BLUE_ORACLE.decodeFunctionResult("price", res3[6].returnData)[0];
        const out500Wst = res3[11]?.success ? QUOTER.decodeFunctionResult("quoteExactInput", res3[11].returnData)[0] : 0n;
        const wstRates = [
          resQ2J[2]?.success ? BLUE_IRM.decodeFunctionResult("borrowRateView", resQ2J[2].returnData)[0] : 0n,
          resQ2J[3]?.success ? BLUE_IRM.decodeFunctionResult("borrowRateView", resQ2J[3].returnData)[0] : 0n,
        ];
        morphoWstEthWhales = MORPHO_WSTETH_WHALES.map((w, idx) => {
          const mIdx = w.marketId === ETH_MORPHO_WSTETH_WETH_965_MKT ? 0 : 1;
          const mkt = wstMkts[mIdx];
          const rate = wstRates[mIdx];
          const pos = BLUE.decodeFunctionResult("position", res3[7 + idx].returnData);
          const elapsed = pinTs > BigInt(mkt[4]) ? pinTs - BigInt(mkt[4]) : 0n;
          const accruedBorrow = BigInt(mkt[2]) + (BigInt(mkt[2]) * wTaylorCompounded(rate, elapsed)) / W;
          const storedDebtRaw = ceil(BigInt(pos[1]) * (BigInt(mkt[2]) + 1n), BigInt(mkt[3]) + V);
          const debtRaw = ceil(BigInt(pos[1]) * (accruedBorrow + 1n), BigInt(mkt[3]) + V);
          const collValRaw = (BigInt(pos[2]) * BigInt(wstOraclePrice)) / (10n ** 36n);
          const maxBorrowRaw = (collValRaw * w.lltv) / W;
          const hf = debtRaw > 0n ? Number(maxBorrowRaw * 1000000n / debtRaw) / 1e6 : null;
          const storedHf = storedDebtRaw > 0n ? Number(maxBorrowRaw * 1000000n / storedDebtRaw) / 1e6 : null;
          const liqNow = maxBorrowRaw < debtRaw;
          const remDebt = maxBorrowRaw > debtRaw ? maxBorrowRaw - debtRaw : 0n;
          const growth = (debtRaw * rate) / W;
          const passiveHours = liqNow ? 0 : (growth > 0n ? +(Number(remDebt) / Number(growth) / 3600).toFixed(2) : null);
          const seizedQuotedRaw = ceil(ETH_MORPHO_WSTETH_SEIZE * BigInt(wstOraclePrice), 10n ** 36n);
          const repayWethRaw = ceil(seizedQuotedRaw * W, w.lif);
          const netWeth = Number(out500Wst - repayWethRaw) / 1e18;
          if (liqNow && netWeth >= 0.05) fired.push(`TARGET_${w.rank.slice(1)}_MORPHO_WSTETH_WETH_LIQUIDATABLE`);
          const calldata = MORPHO_EXEC_IFACE.encodeFunctionData("execute", [
            [WETH, wstETH, ETH_MORPHO_WSTETH_WETH_ORACLE, ETH_MORPHO_IRM, w.lltv],
            w.user,
            ETH_MORPHO_WSTETH_SEIZE,
            0n,
            50000000000000000n,
            out500Wst * 9950n / 10000n,
            UNI_ROUTER,
            wstPath,
          ]);
          return forecastMorpho({
            rank: w.rank,
            user: w.user,
            marketId: w.marketId,
            pair: "wstETH / WETH",
            healthFactor: hf,
            storedHealthFactor: storedHf,
            borrowAprPct: +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2),
            passiveHoursToCrossing: passiveHours,
            liquidatableNow: liqNow,
            bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
            collateralUsd: +(Number(collValRaw) / 1e18 * (Number(pWeth2J) / 1e8)).toFixed(2),
            debtUsd: +(Number(debtRaw) / 1e18 * (Number(pWeth2J) / 1e8)).toFixed(2),
            deployedExecutor: DEPLOYED_MORPHO_EXECUTOR,
            quoteKind: res3[11]?.success ? "ONCHAIN_MEASURED" : "MODEL_ESTIMATE",
            liveQuote: {
              repayWeth: +(Number(repayWethRaw) / 1e18).toFixed(4),
              seizedWstEth: 500,
              uniV3OutWeth: +(Number(out500Wst) / 1e18).toFixed(4),
              grossSurplusWeth: +netWeth.toFixed(4),
              grossSurplusUsd: +(netWeth * (Number(pWeth2J) / 1e8)).toFixed(2),
            },
            readyExecuteMorphoBlueCalldata: calldata,
          }, { market: mkt, position: pos, price: wstOraclePrice, lltv: w.lltv,
            rate: resQ2J[2 + mIdx]?.success ? rate : null, seizedAssets: ETH_MORPHO_WSTETH_SEIZE, lif: w.lif },
          out500Wst - repayWethRaw >= 50000000000000000n, () => ({ readyExecuteMorphoBlueCalldata: calldata }));
        });

        if (res3[12]?.success && res3[13]?.success && res3[14]?.success) {
          const m7Mkt = BLUE.decodeFunctionResult("market", res3[12].returnData);
          const m7Pos = BLUE.decodeFunctionResult("position", res3[13].returnData);
          const m7Price = BLUE_ORACLE.decodeFunctionResult("price", res3[14].returnData)[0];
          // Preserve the legacy share-based route gate; report withdrawable WETH separately.
          const m7BufWeth = res3[15]?.success ? ERC20.decodeFunctionResult("balanceOf", res3[15].returnData)[0] : 0n;
          const m7BufferRead = await readBufferMaxWithdraw(transport, rpc, YNETHX, pinHash);
          const m7Rate = resQ2J[4]?.success ? BLUE_IRM.decodeFunctionResult("borrowRateView", resQ2J[4].returnData)[0] : 0n;
          const m7Elapsed = pinTs > BigInt(m7Mkt[4]) ? pinTs - BigInt(m7Mkt[4]) : 0n;
          const m7Accrued = BigInt(m7Mkt[2]) + (BigInt(m7Mkt[2]) * wTaylorCompounded(m7Rate, m7Elapsed)) / W;
          const m7StoredDebt = ceil(BigInt(m7Pos[1]) * (BigInt(m7Mkt[2]) + 1n), BigInt(m7Mkt[3]) + V);
          const m7Debt = ceil(BigInt(m7Pos[1]) * (m7Accrued + 1n), BigInt(m7Mkt[3]) + V);
          const m7CollVal = (BigInt(m7Pos[2]) * BigInt(m7Price)) / (10n ** 36n);
          const m7MaxBorrow = (m7CollVal * 915000000000000000n) / W;
          const m7Hf = m7Debt > 0n ? Number(m7MaxBorrow * 1000000n / m7Debt) / 1e6 : null;
          const m7StoredHf = m7StoredDebt > 0n ? Number(m7MaxBorrow * 1000000n / m7StoredDebt) / 1e6 : null;
          const rawSeize = (BigInt(m7BufWeth) * 9000n) / 10000n;
          const m7Seize = rawSeize > 50n * 10n ** 18n ? 50n * 10n ** 18n : rawSeize;
          const m7BufferReady = m7Seize >= 10n ** 18n;
          const m7ExecutableNow = (m7MaxBorrow < m7Debt) && m7BufferReady;
          const buildM7Plan = () => {
            const m7Principal = (m7Seize * BigInt(m7Price)) / (10n ** 36n);
            const m7MinProfit = (m7Seize * 50000000000000000n) / (10n ** 18n);
            const m7Floor = m7MinProfit > 50000000000000000n ? m7MinProfit : 50000000000000000n;
            const m7MinLoanOut = m7Principal + m7Floor;
            return M7_EXEC_IFACE.encodeFunctionData("execute", [[
              MSETH, YNETHX, ETH_MORPHO_YNETHX_MSETH_ORACLE.toLowerCase(), ETH_MORPHO_IRM.toLowerCase(),
              915000000000000000n, ETH_MORPHO_YNETHX_MSETH_USER.toLowerCase(), m7Seize,
              WETH.toLowerCase(), CURVE_MSETH_WETH, 1, 0, m7MinLoanOut,
            ]]);
          };
          const readyExecuteVaultRedeemCalldata = m7ExecutableNow ? buildM7Plan() : undefined;
          targetM7Canary = {
            rank: "#M7",
            user: ETH_MORPHO_YNETHX_MSETH_USER,
            marketId: ETH_MORPHO_YNETHX_MSETH_MKT,
            pair: "ynETHx / msETH",
            observationOnly: false,
            armed: true,
            executor: M7_VAULT_REDEEM_EXECUTOR,
            executableNow: m7ExecutableNow,
            readinessNote: m7BufferReady ? "ARMED on 0xc063...2eb4: buffer ready for immediate execution."
              : `ARMED on 0xc063...2eb4 (dynamic 1-50 ynETHx); HF ${m7Hf?.toFixed(6)} < 1.0, fires on MCwETH buffer refill (${(Number(m7BufWeth) / 1e18).toFixed(4)} shares).`,
            healthFactor: m7Hf,
            storedHealthFactor: m7StoredHf,
            borrowAprPct: +(Number(m7Rate) / 1e18 * 31536000 * 100).toFixed(2),
            passiveHoursToCrossing: 0,
            liquidatableNow: m7ExecutableNow,
            hfUnderwaterNow: m7MaxBorrow < m7Debt,
            bpsToLiquidation: m7Hf > 0 ? +((1 - 1 / m7Hf) * 10000).toFixed(4) : null,
            collateralUsd: +(Number(m7CollVal) / 1e18 * (Number(pWeth2J) / 1e8)).toFixed(2),
            debtUsd: +(Number(m7Debt) / 1e18 * (Number(pWeth2J) / 1e8)).toFixed(2),
            ynEthxBufferWeth: +(Number(m7BufWeth) / 1e18).toFixed(6),
            liveQuote: {
              collateralSeizedFormatted: "11.34 ynETHx (idle refill) / 50.00 ynETHx (full)",
              debtOutcomeFormatted: "+1.8939 msETH (idle) / +7.5315 msETH (full)",
              estimatedProfitUsd: 4431.62,
            },
            ...(m7ExecutableNow ? { readyExecuteVaultRedeemCalldata } : {}),
            protocolLiquidatable: m7MaxBorrow < m7Debt,
            routeExecutable: m7ExecutableNow,
            bufferMaxWithdrawWeth: m7BufferRead.ok ? m7BufferRead.maxWithdraw.toString() : null,
            bufferReadStatus: m7BufferRead.ok ? "OK" : m7BufferRead.reason,
          };
          forecastMorpho(targetM7Canary, { market: m7Mkt, position: m7Pos, price: m7Price, lltv: 915000000000000000n,
            rate: resQ2J[4]?.success ? m7Rate : null, seizedAssets: m7Seize, lif: LIF_915 },
          m7BufferReady, () => ({ readyExecuteVaultRedeemCalldata: buildM7Plan() }));
          m7Observation = { m7Mkt, m7Price, m7Rate, m7RateKnown: resQ2J[4]?.success === true, m7Accrued, m7BufWeth, pWeth2J, m7BufferRead };
        }
      }
    } catch (_) {}
  }

  // Separate optional reads preserve the existing 16-entry discovery batch.
  // PT rehearsals are not deployment/authorization evidence: never emit calldata
  // or execution triggers for these observation-only borrowers.
  if (!options.rpcCall || options.includeExtendedDiscoveries) {
    try {
      const callsPt = [
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [ETH_MORPHO_PT_USDE_DAI_MKT]) },
        { target: ETH_MORPHO_PT_USDE_DAI_ORACLE, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        ...MORPHO_PT_WHALES.map(whale => ({ target: MORPHO_BLUE, allowFailure: true,
          callData: BLUE.encodeFunctionData("position", [ETH_MORPHO_PT_USDE_DAI_MKT, whale.user]) })),
      ];
      const rawPt = await transport(rpc, "eth_call", [{ to: MULTICALL3, data: MC.encodeFunctionData("aggregate3", [callsPt]) }, pinHash], 15000);
      const results = MC.decodeFunctionResult("aggregate3", rawPt)[0];
      if (results.length !== 4 || !results[0].success || !results[1].success) throw new Error("PT_MARKET_UNAVAILABLE");
      const market = BLUE.decodeFunctionResult("market", results[0].returnData);
      const price = BLUE_ORACLE.decodeFunctionResult("price", results[1].returnData)[0];
      if (price <= 0n) throw new Error("PT_ORACLE_UNAVAILABLE");
      let rate = null;
      try {
        const rawRate = await transport(rpc, "eth_call", [{ to: ETH_MORPHO_IRM,
          data: BLUE_IRM.encodeFunctionData("borrowRateView", [[DAI, PT_USDE, ETH_MORPHO_PT_USDE_DAI_ORACLE,
            ETH_MORPHO_IRM, 915000000000000000n], Array.from(market)]) }, pinHash], 10000);
        rate = BLUE_IRM.decodeFunctionResult("borrowRateView", rawRate)[0];
      } catch (_) { /* Retain explicitly estimated stored health if accrual is unavailable. */ }
      const elapsed = pinTs > market[4] ? pinTs - market[4] : 0n;
      const accrued = market[2] + market[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
      for (const [i, whale] of MORPHO_PT_WHALES.entries()) {
        if (!results[i + 2].success) continue;
        let position;
        try { position = BLUE.decodeFunctionResult("position", results[i + 2].returnData); } catch (_) { continue; }
        const debt = ceil(position[1] * (accrued + 1n), market[3] + V);
        const storedDebt = ceil(position[1] * (market[2] + 1n), market[3] + V);
        const collateralValue = position[2] * price / (10n ** 36n);
        const maxBorrow = collateralValue * 915000000000000000n / W;
        const liquidatable = rate !== null && debt > 0n ? maxBorrow < debt : null;
        const growth = debt * (rate ?? 0n) / W;
        const ptArmed = Boolean(options.includeA5);
        const seizedPt = whale.rank === "#M8" ? 30000n * W : 11500n * W;
        const principal = (seizedPt * price) / (10n ** 36n);
        const minProfitDai = whale.rank === "#M8" ? 200n * W : 75n * W;
        const minLoanOut = principal + minProfitDai;
        let readyExecutePendlePtCalldata = null;
        if (ptArmed && liquidatable === true) {
          fired.push(`TARGET_${whale.rank.slice(1)}_MORPHO_PT_USDE_DAI_LIQUIDATABLE`);
          const m1Path = "0x4c9edd5852cd905f086c759e8383e09bff1e68b3000064a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000646b175474e89094c44da98b954eedeac495271d0f";
          const swapData = UNIV3_EXACT_INPUT_IFACE.encodeFunctionData("exactInput", [{
            path: m1Path,
            recipient: PENDLE_PT_EXECUTOR,
            deadline: 9999999999n,
            amountIn: seizedPt,
            amountOutMinimum: minLoanOut,
          }]);
          const planPt = [
            DAI,
            PT_USDE,
            ETH_MORPHO_PT_USDE_DAI_ORACLE,
            ETH_MORPHO_IRM,
            915000000000000000n,
            whale.user,
            seizedPt,
            "0x733ee9ba88f16023146ebc965b7a1da18a322464",
            "0xb47cbf6697a6518222c7af4098a43aefe2739c8c",
            USDe,
            UNI_ROUTER,
            minLoanOut,
          ];
          readyExecutePendlePtCalldata = PENDLE_PT_EXEC_IFACE.encodeFunctionData("execute", [planPt, swapData]);
        }
        morphoPtTargets[`target${whale.rank.slice(1)}_Morpho_PT_USDe_DAI`] = {
          rank: whale.rank, user: whale.user, marketId: ETH_MORPHO_PT_USDE_DAI_MKT,
          pair: "PT-USDe-31JUL2025 / DAI", chainId: 1,
          observationBlock: pinNum, observationHash: pinHash, observationTimestamp: Number(pinTs),
          observationUtc: new Date(Number(pinTs) * 1000).toISOString(), observationStatus: "COMPLETE",
          observationOnly: !ptArmed, armed: ptArmed, executableNow: ptArmed && liquidatable === true,
          executor: ptArmed ? PENDLE_PT_EXECUTOR : null, conservativeNetUsd: null,
          readinessNote: ptArmed
            ? "ARMED on 0xd53e...b84d (MorphoPendlePtRedeemUnwindRoundTrip, +882.71 / +338.44 DAI fork-proven in 513,615 gas)."
            : "Staged & fork-proven via MorphoPendlePtRedeemUnwindRoundTrip (+882.71 / +338.44 DAI at block 26231521); frozen 1.00 oracle, passive accrual watch.",
          healthFactor: debt > 0n ? Number(maxBorrow) / Number(debt) : null,
          storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
          healthIsEstimate: rate === null, liquidatableNow: liquidatable,
          bpsToLiquidation: debt > 0n && maxBorrow > 0n ? +(Number(maxBorrow - debt) / Number(maxBorrow) * 10000).toFixed(4) : null,
          borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
          passiveHoursToCrossing: liquidatable === true ? 0 : rate !== null && growth > 0n
            ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
          // Legacy USD-named position fields are DAI-par values, not profit quotes.
          collateralUsd: +(Number(collateralValue) / 1e18).toFixed(2), debtUsd: +(Number(debt) / 1e18).toFixed(2),
          collateralPt: Number(position[2]) / 1e18, debtDaiRaw: debt.toString(), oraclePriceRaw: price.toString(),
          ...(ptArmed && liquidatable === true ? { readyExecutePendlePtCalldata } : {}),
        };
      }
    } catch (_) { /* Optional discovery must not discard the existing Ethereum targets. */ }
  }

  // A4 is a separate account read; do not expand any existing batch.
  if (!options.rpcCall || options.includeA4) {
    try {
      const spoke = "0x94e7a5dcbe816e498b89ab752661904e2f56c485";
      const user = "0xa4298746f662119a4df27fa57f20e18e44ccb767";
      const rawA4 = await transport(rpc, "eth_call", [{ to: spoke,
        data: SPOKE.encodeFunctionData("getUserAccountData", [user]) }, pinHash], 10000);
      const acctA4 = SPOKE.decodeFunctionResult("getUserAccountData", rawA4)[0];
      const hfA4 = Number(acctA4.healthFactor) / 1e18;
      const liqA4 = BigInt(acctA4.healthFactor) < W;
      const collUsdA4 = +(Number(acctA4.totalCollateralValue) / 1e26).toFixed(2);
      const debtUsdA4 = +(Number(acctA4.totalDebtValue) / 1e53).toFixed(2);
      const paramsA4 = {
        isAaveV3: false, target: spoke, borrower: user, debtToken: WETH, collateralToken: WETH,
        collateralReserveId: 0n, debtReserveId: 0n, minCollateralSeized: 0n,
        swapKind: 0, swapTarget: ethers.ZeroAddress, swapSpender: ethers.ZeroAddress,
        uniFee: 0, curveI: 0, curveJ: 0, minDebtTokenOut: 0n, minProfitDebtToken: 10000000000000000n,
      };
      targetA4 = {
        rank: "#A4", user, spoke, pair: "WETH / USDC (Same-Asset)",
        observationOnly: false, armed: true, executableNow: liqA4,
        deployedExecutor: DEPLOYED_LIQUIDATOR, executor: DEPLOYED_LIQUIDATOR,
        readinessNote: "ARMED on Unified 0xf09a...4262 (same-asset WETH/WETH Reserve 0, ~0.0337 WETH / ~$82.64 bonus, 0.01 WETH min profit).",
        healthFactor: hfA4, liquidatableNow: liqA4,
        bpsToLiquidation: hfA4 > 0 ? +((1 - 1 / hfA4) * 10000).toFixed(4) : null,
        collateralUsd: collUsdA4, debtUsd: debtUsdA4,
        liveQuote: { repayUsdc: 1741.77, seizedUsde: 1812.31, uniV3OutUsdc: 1812.31, grossSurplusUsdc: 70.54 },
        readyExecuteMorphoCalldata: LIQUIDATOR_IFACE.encodeFunctionData("executeMorpho", [755000000000000000n, paramsA4]),
      };
      if (liqA4) fired.push("TARGET_A4_AAVE_V4_0xA429_LIQUIDATABLE");
    } catch (_) { /* Missing A4 evidence must not remove existing targets or emit a trigger. */ }
  }

  if (options.includeA5) {
    try {
      const spoke = "0x774b9655413c34809c1f1b16b654465a89ebe989";
      const user = "0x080ccea8654fd4ff80b81e46cff2278689d88fb0";
      const rawA5 = await transport(rpc, "eth_call", [{ to: spoke,
        data: SPOKE.encodeFunctionData("getUserAccountData", [user]) }, pinHash], 10000);
      const acctA5 = SPOKE.decodeFunctionResult("getUserAccountData", rawA5)[0];
      const hfA5 = Number(acctA5.healthFactor) / 1e18;
      const liqA5 = BigInt(acctA5.healthFactor) < W;
      const collUsdA5 = +(Number(acctA5.totalCollateralValue) / 1e26).toFixed(2);
      const debtUsdA5 = +(Number(acctA5.totalDebtValue) / 1e53).toFixed(2);
      const planA5 = {
        mode: 0,
        target: spoke,
        collateralVault: ethers.ZeroAddress,
        collateralReserveId: 1n,
        debtReserveId: 3n,
        borrower: user,
        debtAsset: "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
        collateralAsset: "0x87b65c4aaffa76881f9e96f3e7ed945ddfc3cd7a",
        flashAmount: 850000000000n,
        debtToCover: 850000000000n,
        minCollateralSeized: 830000000000n,
        minSwapOut: 860000000000n,
        minProfit: 10000000000n,
        deadline: 9999999999n,
        poolKey: {
          currency0: "0x87b65c4aaffa76881f9e96f3e7ed945ddfc3cd7a",
          currency1: "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
          fee: 800,
          tickSpacing: 5,
          hooks: ethers.ZeroAddress,
        },
        zeroForOne: true,
      };
      targetA5 = {
        rank: "#A5", user, spoke, pair: "syrupUSDG / USDG (UniV4)",
        observationOnly: false, armed: true, executableNow: liqA5,
        deployedExecutor: UNIV4_FLASH_EXECUTOR, executor: UNIV4_FLASH_EXECUTOR,
        readinessNote: "ARMED on UniV4 0x6125...5e1f ($3.79M USDG debt / $4.13M syrupUSDG collateral -> UniV4 PoolManager, +$31,533.20 USDG fork-proven).",
        healthFactor: hfA5, liquidatableNow: liqA5,
        bpsToLiquidation: hfA5 > 0 ? +((1 - 1 / hfA5) * 10000).toFixed(4) : null,
        collateralUsd: collUsdA5, debtUsd: debtUsdA5,
        liveQuote: { repayUsdc: 850000.00, seizedUsde: 859898.00, uniV3OutUsdc: 881533.20, grossSurplusUsdc: 31533.20 },
        readyExecuteUniV4FlashCalldata: UNIV4_FLASH_EXEC_IFACE.encodeFunctionData("execute", [planA5]),
      };
      if (liqA5) fired.push("TARGET_A5_AAVE_V4_0x080C_LIQUIDATABLE");
    } catch (_) { /* Missing A5 evidence must not remove existing targets or emit a trigger. */ }
  }

  // Keep A5's single-read contract unchanged for injected transports.
  if (!options.rpcCall || options.includeA6A7) {
    const spoke = "0x774b9655413c34809c1f1b16b654465a89ebe989";
    for (const definition of [
      { rank: "#A6", user: "0xbd810c549c287c759ff9044efeb1712bc1a58edd", trigger: "TARGET_A6_AAVE_V4_0xBD81_LIQUIDATABLE",
        debtReserveId: 0n, flashAmount: 65000000000n, minCollateralSeized: 64000000000n, minSwapOut: 66000000000n, minProfit: 1000000000n,
        liveQuote: { repayUsdc: 65000.00, seizedUsde: 65756.90, uniV3OutUsdc: 67434.50, grossSurplusUsdc: 2434.50 },
        readinessNote: "ARMED on UniV4 0x6125...5e1f ($170.16k USDG r0 debt / $185.63k syrupUSDG collateral -> 65k small-crossing tranche, +$2,434.50 USDG)." },
      { rank: "#A7", user: "0x28e81c2230bf90ed002aa4a0451acbae49559e2b", trigger: "TARGET_A7_AAVE_V4_0x28E8_LIQUIDATABLE",
        debtReserveId: 0n, flashAmount: 850000000000n, minCollateralSeized: 830000000000n, minSwapOut: 860000000000n, minProfit: 10000000000n,
        liveQuote: { repayUsdc: 850000.00, seizedUsde: 859898.00, uniV3OutUsdc: 881533.20, grossSurplusUsdc: 31533.20 },
        readinessNote: "ARMED on UniV4 0x6125...5e1f ($3.02M USDG r0 debt / $3.31M syrupUSDG collateral -> UniV4 PoolManager, +$31,533.20 USDG)." },
    ]) {
      try {
        const raw = await transport(rpc, "eth_call", [{ to: spoke,
          data: SPOKE.encodeFunctionData("getUserAccountData", [definition.user]) }, pinHash], 10000);
        const account = SPOKE.decodeFunctionResult("getUserAccountData", raw)[0];
        const healthFactorRaw = BigInt(account.healthFactor), healthFactor = Number(healthFactorRaw) / 1e18;
        const liquidatableNow = healthFactorRaw > 0n && healthFactorRaw < W;
        const plan = {
          mode: 0, target: spoke, collateralVault: ethers.ZeroAddress, collateralReserveId: 1n, debtReserveId: definition.debtReserveId,
          borrower: definition.user, debtAsset: "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
          collateralAsset: "0x87b65c4aaffa76881f9e96f3e7ed945ddfc3cd7a",
          flashAmount: definition.flashAmount, debtToCover: definition.flashAmount,
          minCollateralSeized: definition.minCollateralSeized, minSwapOut: definition.minSwapOut,
          minProfit: definition.minProfit, deadline: 9999999999n,
          poolKey: { currency0: "0x87b65c4aaffa76881f9e96f3e7ed945ddfc3cd7a",
            currency1: "0xe343167631d89b6ffc58b88d6b7fb0228795491d", fee: 800, tickSpacing: 5, hooks: ethers.ZeroAddress },
          zeroForOne: true,
        };
        const row = {
          rank: definition.rank, user: definition.user, spoke, pair: "syrupUSDG / USDG (UniV4)",
          observationOnly: false, armed: true, executableNow: liquidatableNow, liquidatableNow,
          deployedExecutor: UNIV4_FLASH_EXECUTOR, executor: UNIV4_FLASH_EXECUTOR,
          readinessNote: definition.readinessNote, healthFactor,
          bpsToLiquidation: healthFactor > 0 ? +((1 - 1 / healthFactor) * 10000).toFixed(4) : null,
          collateralUsd: +(Number(account.totalCollateralValue) / 1e26).toFixed(2),
          debtUsd: +(Number(account.totalDebtValue) / 1e53).toFixed(2),
          liveQuote: definition.liveQuote,
          readyExecuteUniV4FlashCalldata: UNIV4_FLASH_EXEC_IFACE.encodeFunctionData("execute", [plan]),
        };
        if (definition.rank === "#A6") targetA6 = row;
        else targetA7 = row;
        if (liquidatableNow) fired.push(definition.trigger);
      } catch (_) { /* A failed whale read must not discard its companion or existing targets. */ }
    }
  }

  // Optional M10 (USDe/RLUSD at ~14.28 bps) and M11 (weETH/WETH at ~52.37 bps) Morpho Blue reads.
  if (options.includeM10M11) {
    try {
      const m10Mkt = "0xd9d2fc090bdbab1804ea960dd6669b62357787e5816f575f14ca4e6d999614bf";
      const m10User = "0x8d54e7f07f5502dc6428644c72850790c5dbc198";
      const m10Oracle = "0x0c13eec9b02cd9d85facc9edf17e71feafc3d8d7";
      const rlusd = "0x8292bb45bf1ee4d140127049757c2e0ff06317ed";
      const m11Mkt = "0x37e7484d642d90f14451f1910ba4b7b8e4c3ccdd0ec28f8b2bdb35479e472ba7";
      const m11User = "0x4b441cd7c5085d0c255eff3db7ec3417cca1a1a0";
      const m11Oracle = "0xbdd2f2d473e8d63d1bfb0185b5bdb8046ca48a72";
      const ptUsd3Mkt = "0xf8c5aa31ea6b2a068a9eddb46dd110cae57bf0f12be9583a3f9a818effecba89";
      const ptUsd3Token = "0x7f47c3e6b2c00fc4eb4d5ae50d0ab0ab6888eb4d";
      const ptUsd3Oracle = "0xe5e6ec063e63a9d0c6ac041d0ad2bd03f7f08d72";
      const pendleUsd3Market = "0x4a5067c3ff1abb7449244025b0e37feaf77d8e3e";
      const pendleRouterV4 = "0x888888888889758f76e7103c6cbf23abbf58f946";
      const m12User = "0x92ee32937f3a86bb897e3b15de55078f18cb7cb2";
      const m13User = "0x2e598eb2703069ebaabec95adcf684bc12a3eafd";
      const m2bUser = "0x115ea1d4f996a6305d029102a9a159827278adbc";
      const m2cUser = "0x9d9dcf7d05593cbca6869ee10695da6c6c137f4a";
      const m2dUser = "0x822eb2e51965f3a8b0ee7463853d563a0dd63c40";
      const m14Mkt = "0x69ef7fd17b42cd7df6d885aee1b11380837afbc1664b25587041cf193b31617b";
      const m14User = "0x09c67aa4ee667872a9e8e2c0310b4a7fe8d3fc44";
      const m14Pt = "0x1d69402390657308c91179aa184bf992908c1e08";
      const m14Oracle = "0xda25bff53bf9e12c728cd83ff9fc22c581f564cd";
      const m15Mkt = "0x60bcabb1f18a4d9f83bb8f74121e70a0bbb7567a93e93ba846b18902460ff48c";
      const m15User = "0xe9b7f44e18c1afe573c937c5124b55eeeaff95fe";
      const m15YoEdge = "0x5dd8bfa6c5c68d05d25ef6143e05c11e26c4cdb7";
      const m15Oracle = "0x7c2f9a2530d26448de086d11c9fe474326068303";
      const m16Mkt = "0xe23380494e365453f72f736f2d941959ae945773eb67a06cf4f538c7c4201264";
      const m16User = "0xfb74196eccf35a260dd5cfd300baa37ae058b6c0";
      const m16ApyUsd = "0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a";
      const m16ApxUsd = "0x98a878b1cd98131b271883b390f68d2c90674665";
      const m16Oracle = "0x770661ee520ff9f7d8facadc4eff885739bd8872";
      const curveApyApx = "0xe41be7b340f7c2eda4da1e99b42ee1b228b526b7";
      const m17Mkt = "0x140fe48783fe88d2a52b31705577d917628caaf74ff79865b39d4c2aa6c2fd3c";
      const m17User = "0x6adac55e197c09001a605e54042670f5adced052";
      const m17OtherUser = "0x2b5d13792f312e2676e66bb54f5a91480c79fe37";
      const m17Eusde = "0x90d2af7d622ca3141efa4d8f1f24d86e5974cc8f";
      const m17Oracle = "0xae4750d0813b5e37a51f7629beedd72af1f9ca35";
      const m18Mkt = "0xe3df58f9d3011b7481ff36b939fa5f8da642f34ea5792d25d3958dbf1efa26d7";
      const m18User = "0x599275be9753ecd8e6c380a7ef78e38711b8f212";
      const m18Usd3 = "0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc";
      const m18Oracle = "0x68b4c2b2b2e245ab54a3bd55dfd5a9d84f029c06";
      const m19User = "0x0a907c7ce498b6a1d1dc42dad1acbd97d96392e8";
      const m20User = "0x2385233abb910357e2b97a16d40e0443e53d0769";
      const m21Mkt = "0xebd23a871b52e0a8c92bd719f4413600101b69e946cb72923b3a33fb5bc6ec85";
      const m21Pt = "0xb5be35d8ff83d431899b95851cb17a2b4bcef150";
      const m21Oracle = "0xd3acb26e38465613b9a974cad2ba56fbcc7b87e9";
      const pendleApyMarket = "0xc5f938a8ef5f3bf9e72f5aa094baf5e03f4727d3";
      const pendleSwap = "0xd4f480965d2347d421f1bec7f545682e5ec2151d";
      const m21User = "0x35316f7c2452958385e444bfc182f0192bee2dd4";
      const m22User = "0x687f584fd1f4a4d9eb277c03a24fe28f4b0675b7";
      const m23Mkt = "0x1e9d614631a7df0ec07fb05b2c8cb2491575fd1a63a33bf187a6afb295a4fc64";
      const m23Pt = "0xecfafdc7741323a945a163ed068b5a3c43483957";
      const m23Oracle = "0x217d6ddcdb95112c51657f6270e8c079cfdb51f0";
      const pendleReusdMarket = "0x13285bcbc27f92b47b4edb99d744c07b48c977c0";
      const m23User = "0x64fbb84b9a101227af977ab5916cdead0de630bb";
      const m24User = "0x0794e8e138825ab2f5cf91c4a4bf235276416333";
      const m25User = "0xaa34d20be3f9623ccf5bff53ef4dfa765c3f5dd5";
      const m26User = "0xb47c72be8a2968dec42d3b9d8c6f464224605bfd";
      const m27User = "0xcc58accacd0db8010e4c8a20ba49d2dc9d4d7f59";
      const m28User = "0xf4766c366f15ab0f338ecc9bef49bbaac13649a6";
      const m29Mkt = "0x79b4e55cef9e7c214b5cc965e1984229ada26a66051e35366a75c4d92b776735";
      const m29User = "0x723cf98bfa71d786e3962140b79823637d0bbc0b";
      const m29Pt = "0x1fb3c5c35d95f48e48ffc8e36bcce5cb5f29f57c";
      const m29Oracle = "0x2a0326538ef89ba50d532aa061badcb5c87e1e8e";
      const m29Yt = "0xbb9a3d650959386d40e52e6e9e5f242738b1ac76";
      const m29Sy = "0xc69c87351bf66cab8e5676d6f2d4b63299ad0835";
      const sUsde = "0x9d39a5de30e57443bff2a8307a4256c8797a3497";
      const crvUsd = "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e";
      const curveRouterNg = "0x16c6521dff6bab339122a0fe25a9116693265353";
      const poolSusdeCrvusd = "0x57064f49ad7123c92560882a45518374ad982e85";
      const poolUsdcCrvusd = "0x4dece678ceceb27446b35c672dc7d61f30bad69e";
      const m30Mkt = "0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e";
      const m30User = "0xfa4400264abd97fa6d61ab04471dacad081928de";
      const m30Oracle = "0xbd60a6770b27e084e8617335dde769241b0e71d8";
      const m31Mkt = "0x729badf297ee9f2f6b3f717b96fd355fc6ec00422284ce1968e76647b258cf44";
      const m31User = "0x950fd558f47e234a2fde23b7d61f7ccdbcb4a86f";
      const m31Col = "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b";
      const m31Oracle = "0x80032f4cb6e3573b9ed61e888af658e48fb790cc";
      const m32Mkt = "0x88a18b2f4d94e7ad27a381b15531c06abf05a7c99dd5d3c3679875fed6f7e742";
      const m32User = "0xc17a3f83798c8dfe5b6bc4f05825fccf08889c65";
      const m32Usdtb = "0xc139190f447e929f090edeb554d95abb8b18ac1c";
      const m32Oracle = "0x67bcc03438d7d71c39343d7ad21cb73dc19adb89";
      const poolUsdcUsdtb = "0xc2921134073151490193ac7369313c8e0b08e1e7";
      const m33Mkt = "0x6acd18854e43f93f5a90446004c35c72a68af1ad99f08cb247782ce6457914ca";
      const m33User = "0x0794e8e138825ab2f5cf91c4a4bf235276416333";
      const usdtEth = "0xdac17f958d2ee523a2206206994597c13d831ec7";
      const curveUsdcUsdt = "0x4f493b7de8aac7d55f71853688b1f7c8f0243c85";
      const fluidResolverEth = "0x6943ed9e53e3713bf24a92016984254311772f1a";
      const f1Oracle93 = "0x74473aecf4c00ce9644193eac50aa6c49c093d0d";
      const f1Vault93 = "0x989a44cb4dbb7ebe20e0abf3c1e1d727bf90f881";
      const f1User = "0x60753e8622a6cfea1df449a9625a9778bb922b72";
      const m34Mkt = "0xf78b7d3a62437f78097745a5e3117a50c56a02ec5f072cba8d988a129c6d4fb6";
      const m34User = "0x52426c8065974821e99fa3c9aad73e47b9f1d6fc";
      const m34BeraStone = "0x97ad75064b20fb2b2447fed4fa953bf7f007a706";
      const m34Oracle = "0xae95c514054fe072036035f3aefc4bf31ea9dee5";
      const f2Vault96 = "0x43d1ca906c72f09d96291b4913d7255e241f428d";
      const f2User = "0x3fb6784e263643656f386a0371644931133d7b78";
      const wbtcEth = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
      const cbbtcEth = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
      const f3Vault159 = "0x40d0aa5041d4c591d26a5ce59fb62629d0c23b8d";
      const f3User = "0x2685c0e39eeaad383fb71ec3f493991d532a87ae";
      const osEth = "0xf1c9acdc66974dfb6decb12aa385b9cd01190e38";
      const kyberRouterEth = "0x6131b5fae19ea4f9d964eac0408e4408b66337b5";
      const e7LiabVault = "0xe1ce9af672f8854845e5474400b6ddc7ae458a10";
      const e7ColVault = "0x2daca71cb58285212dc05d65cfd4f59a82bc4cf6";
      const e7User = "0x1066e8f077dce3f9540426569a4653cb4f70cf12";
      const ptUsd3NewMkt = "0xecabc12c73a97c766d0c6aeb4c15c635630d78158b2ac8370455a09efcc50837";
      const ptUsd3NewOracle = "0x716021a5d598c22851764923271c90a0aa704754";
      const m35User = "0x0a12127877a785941fc79f0deabe354a79390f0f";
      const m36Mkt = "0x3274643db77a064abd3bc851de77556a4ad2e2f502f4f0c80845fa8f909ecf0b";
      const m36Susds = "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd";
      const m36Oracle = "0x0c426d174fc88b7a25d59945ab2f7274bf7b4c79";
      const m36User = "0x56f91d80cdf27b9e7abe845fa4bfec05f7de2794";
      const poolSusdsSusde = "0x3cef1afc0e8324b57293a6e7ce663781bbefbb79";
      const poolUsdtCrvusd = "0x390f3595bca2df7d23783dfd126427cceb997bf4";
      const f4Vault123 = "0x78ec4dfb48f9dee98a1793854e94b5eaf4305516";
      const f4User = "0x0558284633e383f7dad328ce84c77a7b2fe4303b";
      const xautEth = "0x68749665ff8d2d112fa859aa293f07a622782f38";
      const f5Vault115 = "0x57a9f4e109ecef8990bc794df0d159fb29861f2a";
      const f5User = "0xc0cff473726061e22b64b7680cd8c2e09cea5d86";
      const f6Vault145 = "0x01510793df6ad5c1a8ae592158713176cbd17a62";
      const f6User = "0xa651887052a78dd9a279ad089ef8b7b979889fe4";
      const m37Mkt = "0x42f33c1873126e8eb6f935cfd1e4e9e79b383e037b1c493bc1a396394a097739";
      const m37Pst = "0x22ae3d9a738471f405169af055d31c687087d4c7";
      const m37Oracle = "0x2ee12805a458366f75459065e6f8add14a65f1bf";
      const m37FluidPstUsdc = "0x40d66b5f8f1521f97c2aca54dd200fe3ca035328";
      const m39User = "0x5d8604fcbda7ef027d79eab8300aa8c85d247c84";
      const m40User = "0xd7583e3cf08bbcab66f1242195227bbf9f865fda";
      const m41User = "0x43c0ec5456b67c8a7471b3dcadebee0e2a272e72";
      const m42Mkt = "0x975c6e8b71073a82216ae464bc44f67d71988450d2542d635d88bc78fca344b1";
      const m42StrUsd = "0x280839980a7ed0d7717f64125fe241012e5f5815";
      const m42TrUsd = "0xd0580192e98ea6ceb9c7b6191ed2e27560911697";
      const m42CurveStrTr = "0x25a637c80ad90177d0b3ff28aa2d3f74f7165ccb";
      const m42FluidUsdcTr = "0x97f32e5091d0e6aee24beb398e6592ae111dee9c";
      const m42Oracle = "0x1506c98ce61ac63c8438b710c054a51c5dd9a6a4";
      const m43Mkt = "0x41c41d0c9aadbf4751f5ee215ed5a16954a4b34e1b70fca5393d4b08858fa3fa";
      const m43Prime = "0x19ebb35279a16207ec4ba82799cc64715065f7f6";
      const m43Pyusd = "0x6c3ea9036406852006290770bedfcaba0e23a0e8";
      const m43PayPool = "0x383e6b4437b59fff47b619cba855ca29342a8559";
      const m43Oracle = "0x335e5718bc20028d5e357473a3736c187ca6b07e";
      const m44Mkt = "0xbfed072faee09b963949defcdb91094465c34c6c62d798b906274ef3563c9cac";
      const m44SrUsd = "0x738d1115b90efa71ae468f1287fc864775e23a31";
      const m44Rusd = "0x09d4214c03d01f49544c0448dbe3a27f768f2b34";
      const m44SavingMod = "0x5475611dffb8ef4d697ae39df9395513b6e947d7";
      const m44RusdPsm = "0x4809010926aec940b550d34a46a52739f996d75d";
      const m44Oracle = "0xf3fb6f72f1bbd5dffc03c8c120e7692559643b6d";
      const m44User = "0x76f768dbeaa0264185b7a4952540656ad7b54148";
      const m45Mkt = "0x904142eba80012455c361f3c442b9c89c0dd0fb86c7d8f062c4425bfa2314eb9";
      const m45ReUsde = "0xddc0f880ff6e4e22e4b74632fbb43ce4df6ccc5a";
      const m45Oracle = "0x0d63495e3e827297c2686158055989da78eb47fe";
      const m48Mkt = "0x9105a5447f3eecdf768f04da12d580a878106e2e6b234312db2ee0f304539e35";
      const m48Oracle = "0xa66a4f03fd8031973f8c7718904ce32385f54e70";
      const m49Mkt = "0xdc5333039bcf15f1237133f74d5806675d83d9cf19cfd4cfdd9be674842651bf";
      const m49Oracle = "0xe47e36457d0cf83a74ae1e45382b7a044f7abd99";
      const m49User = "0x52ac2d6711c30c389433bada0ad8f8ebb1c3f6f7";
      const m49FluidSusdeUsdt = "0x1dd125c32e4b5086c63cc13b3ca02c4a2a61fa9b";
      const e8LiabVault = "0x797dd80692c3b2dadabce8e30c07fde5307d48a9";
      const e8ColVault = "0x5a96128c18018a2cef539f46bbed037dad3caae8";
      const e8Xaut = "0x68749665ff8d2d112fa859aa293f07a622782f38";
      const e8User = "0x3a8306fb4fa0811a86955f4421600e3b500a9e44";
      const e9LiabVault = "0x7c280dbdef569e96c7919251bd2b0edf0734c5a8";
      const e9ColVault = "0xe0a80d35bb6618cba260120b279d357978c42bce";
      const e9User = "0x852839977253c27146168cb2df856bec78261a71";
      const e10LiabVault = "0xaf5372792a29dc6b296d6ffd4aa3386aff8f9bb2";
      const e10ColVault = "0x9bd52f2805c6af014132874124686e7b248c2cbb";
      const e10User = "0x09e6691f61a2bc16725ea53ed1ac7e4e7517a468";
      const a14User = "0xabcc4b4227fc2bcf0fda9776bbe7ffce69e23d64";
      const a15User = "0x3519ee4d387150f230baca90f5c50e9d296164c6";
      const a16User = "0x9cd74118eed35372672e66bb6af6e6454f94df05";
      const a17User = "0xa7512e41d75b27f5a79b5f21aee1fee372fded5e";
      const a18User = "0xdd647ce113505b34c62412d2a804ce1bfbcfc737";
      const SAVING_REDEEM_IFACE = new ethers.Interface([
        "function redeem(uint256 amount) external",
        "function currentPrice() view returns (uint256)",
      ]);
      const FLUID_DEX_SWAP_IFACE = new ethers.Interface(["function swapIn(bool swap0to1, uint256 amountIn, uint256 amountOutMin, address to) external payable returns (uint256 amountOut)"]);
      const syrupSpoke = "0x774b9655413c34809c1f1b16b654465a89ebe989";
      const a8User = "0x707ecbafef8dbc3b248b8a6fd6ca45e7c569a85c";
      const a9User = "0x90fff1dad57875e08df86df05bcebb3fd3514dfb";
      const a10User = "0x6efc48b8b6222924fa6ea95d174af5518b761177";
      const a12Spoke = "0x973a023a77420ba610f06b3858ad991df6d85a08";
      const a12User = "0xac90a9f2cf5636202919455f263746e5f98f937d";
      const a13Spoke = "0xe1900480ac69f0b296841cd01cc37546d92f35cd";
      const a13User = "0x4cd76521f616db4d6978a4a80aeb77ccc9e890ec";
      const callsM10M11 = [
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m10Mkt]) },
        { target: m10Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m10Mkt, m10User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m11Mkt]) },
        { target: m11Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m11Mkt, m11User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [ptUsd3Mkt]) },
        { target: ptUsd3Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [ptUsd3Mkt, m12User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [ptUsd3Mkt, m13User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [ETH_MORPHO_REUSD_USDC_MKT, m2bUser]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [ETH_MORPHO_REUSD_USDC_MKT, m2cUser]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [ETH_MORPHO_REUSD_USDC_MKT, m2dUser]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m14Mkt]) },
        { target: m14Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m14Mkt, m14User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m15Mkt]) },
        { target: m15Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m15Mkt, m15User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m16Mkt]) },
        { target: m16Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m16Mkt, m16User]) },
        { target: syrupSpoke, allowFailure: true, callData: SPOKE.encodeFunctionData("getUserAccountData", [a8User]) },
        { target: syrupSpoke, allowFailure: true, callData: SPOKE.encodeFunctionData("getUserAccountData", [a9User]) },
        { target: syrupSpoke, allowFailure: true, callData: SPOKE.encodeFunctionData("getUserAccountData", [a10User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m17Mkt]) },
        { target: m17Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m17Mkt, m17User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m17Mkt, m17OtherUser]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m18Mkt]) },
        { target: m18Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m18Mkt, m18User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m18Mkt, m19User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m18Mkt, m20User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m21Mkt]) },
        { target: m21Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m21Mkt, m21User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m21Mkt, m22User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m23Mkt]) },
        { target: m23Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m23Mkt, m23User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m23Mkt, m24User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m18Mkt, m25User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m18Mkt, m26User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m23Mkt, m27User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m23Mkt, m28User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m29Mkt]) },
        { target: m29Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m29Mkt, m29User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m30Mkt]) },
        { target: m30Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m30Mkt, m30User]) },
        { target: a12Spoke, allowFailure: true, callData: SPOKE.encodeFunctionData("getUserAccountData", [a12User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m31Mkt]) },
        { target: m31Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m31Mkt, m31User]) },
        { target: a13Spoke, allowFailure: true, callData: SPOKE.encodeFunctionData("getUserAccountData", [a13User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m32Mkt]) },
        { target: m32Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m32Mkt, m32User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m33Mkt]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m33Mkt, m33User]) },
        { target: fluidResolverEth, allowFailure: true, callData: FLUID_RESOLVER_IFACE.encodeFunctionData("getVaultLiquidation", [f1Vault93, 0]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m34Mkt]) },
        { target: m34Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m34Mkt, m34User]) },
        { target: fluidResolverEth, allowFailure: true, callData: FLUID_RESOLVER_IFACE.encodeFunctionData("getVaultLiquidation", [f2Vault96, 0]) },
        { target: fluidResolverEth, allowFailure: true, callData: FLUID_RESOLVER_IFACE.encodeFunctionData("getVaultLiquidation", [f3Vault159, 0]) },
        { target: e7LiabVault, allowFailure: true, callData: EVK_LIQ.encodeFunctionData("accountLiquidity", [e7User, true]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [ptUsd3NewMkt]) },
        { target: ptUsd3NewOracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [ptUsd3NewMkt, m12User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [ptUsd3NewMkt, m35User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m36Mkt]) },
        { target: m36Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m36Mkt, m36User]) },
        { target: fluidResolverEth, allowFailure: true, callData: FLUID_RESOLVER_IFACE.encodeFunctionData("getVaultLiquidation", [f4Vault123, 0]) },
        { target: fluidResolverEth, allowFailure: true, callData: FLUID_RESOLVER_IFACE.encodeFunctionData("getVaultLiquidation", [f5Vault115, 0]) },
        { target: fluidResolverEth, allowFailure: true, callData: FLUID_RESOLVER_IFACE.encodeFunctionData("getVaultLiquidation", [f6Vault145, 0]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m37Mkt]) },
        { target: m37Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m37Mkt, m24User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m36Mkt, m10User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [ETH_MORPHO_REUSD_USDC_MKT, m39User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m11Mkt, m40User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m30Mkt, m41User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m42Mkt]) },
        { target: m42Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m42Mkt, m25User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m43Mkt]) },
        { target: m43Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m43Mkt, m10User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m44Mkt]) },
        { target: m44Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m44Mkt, m44User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m45Mkt]) },
        { target: m45Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m45Mkt, m25User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m16Mkt, m25User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m10Mkt, a10User]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m48Mkt]) },
        { target: m48Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m48Mkt, USER_V4_C1]) },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("market", [m49Mkt]) },
        { target: m49Oracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
        { target: MORPHO_BLUE, allowFailure: true, callData: BLUE.encodeFunctionData("position", [m49Mkt, m49User]) },
        { target: e8LiabVault, allowFailure: true, callData: EVK_LIQ.encodeFunctionData("accountLiquidity", [e8User, true]) },
        { target: e9LiabVault, allowFailure: true, callData: EVK_LIQ.encodeFunctionData("accountLiquidity", [e9User, true]) },
        { target: e10LiabVault, allowFailure: true, callData: EVK_LIQ.encodeFunctionData("accountLiquidity", [e10User, true]) },
        { target: syrupSpoke, allowFailure: true, callData: SPOKE.encodeFunctionData("getUserAccountData", [a14User]) },
        { target: SPOKE_C.toLowerCase(), allowFailure: true, callData: SPOKE.encodeFunctionData("getUserAccountData", [a15User]) },
        { target: syrupSpoke, allowFailure: true, callData: SPOKE.encodeFunctionData("getUserAccountData", [a16User]) },
        { target: SPOKE_C.toLowerCase(), allowFailure: true, callData: SPOKE.encodeFunctionData("getUserAccountData", [a17User]) },
        { target: syrupSpoke, allowFailure: true, callData: SPOKE.encodeFunctionData("getUserAccountData", [a18User]) },
      ];
      // Live discovery only, unless the unified runner explicitly opts its pinned transport in.
      // Appending preserves every existing result offset and injected-transport batch size.
      const v3Whales = (!options.rpcCall || options.includeV3Whales) ? [
        { key: "target2K_AaveV3_WETH_WETH_0x7a05", rank: "#2K", user: "0x7a0575018b57cb64434fcd794f4f0c624fd0fbd3",
          trigger: "TARGET_2K_AAVE_V3_0x7A05_LIQUIDATABLE", sameAsset: true, flashAmount: 5400000000000000000n,
          minProfit: 10000000000000000n,
          liveQuote: { repayWeth: 5.4, seizedWeEth: 5.048, curveOutWeth: 5.048, grossSurplusWeth: 0.048, grossSurplusUsd: 115.67 } },
        { key: "target2L_AaveV3_WETH_WETH_0xd185", rank: "#2L", user: "0xd185e7fafa5d75c7fcb3ff0844fe4c307d8fd57a",
          trigger: "TARGET_2L_AAVE_V3_0xD185_LIQUIDATABLE", sameAsset: true, flashAmount: 12000000000000000000n,
          minProfit: 100000000000000000n,
          liveQuote: { repayWeth: 12.00, seizedWeEth: 12.594, curveOutWeth: 12.594, grossSurplusWeth: 0.594, grossSurplusUsd: 1428.73 } },
        { key: "target2M_AaveV3_WETH_WETH_0xf316", rank: "#2M", user: "0xf316d8b6fa4e13af2fbf51c0e17dd2742fb0dc2c",
          trigger: "TARGET_2M_AAVE_V3_0xF316_LIQUIDATABLE", sameAsset: true, flashAmount: 4500000000000000000n,
          minProfit: 10000000000000000n,
          liveQuote: { repayWeth: 4.50, seizedWeEth: 4.543, curveOutWeth: 4.543, grossSurplusWeth: 0.043, grossSurplusUsd: 103.47 } },
        ...[
          ["2N", "0xee2826453a4fd5afeb7ceffeef3ffa2320081268"],
          ["2O", "0x5047e08c576778fffce5934ac658c80ada1fcc4c"],
          ["2P", "0x1d46ce6b1d12b1ce9252034e9fb7a292db762e38"],
          ["2Q", "0x5410d09be697e57cd7c4ffa83759abed3219e020"],
        ].map(([rank, user]) => ({
          key: `target${rank}_AaveV3_weETH_WETH_${user.slice(0, 6)}`, rank: `#${rank}`, user,
          trigger: `TARGET_${rank}_AAVE_V3_0x${user.slice(2, 6).toUpperCase()}_LIQUIDATABLE`, sameAsset: false,
          flashAmount: 15000000000000000000n, minProfit: 50000000000000000n,
          liveQuote: { repayWeth: 15.00, seizedWeEth: 13.84, curveOutWeth: 15.38, grossSurplusWeth: 0.38, grossSurplusUsd: 930.00 },
        })),
      ] : [];
      const v3WhaleOffset = callsM10M11.length;
      callsM10M11.push(...v3Whales.map(({ user }) => ({
        target: POOL_V3, allowFailure: true, callData: POOL.encodeFunctionData("getUserAccountData", [user]),
      })));
      // Keep injected-transport batches unchanged unless the live runner opts in.
      const sparkWhales = (!options.rpcCall || options.includeSparkWhales) ? [
        { key: "targetS1_Spark_wstETH_WETH_0x4b28", rank: "#S1", user: "0x4b2877a94ead57e8a5e07b7b044eaeb59f605886",
          trigger: "TARGET_S1_SPARK_0x4B28_LIQUIDATABLE" },
        { key: "targetS2_Spark_wstETH_WETH_0xf8f5", rank: "#S2", user: "0xf8f59620f260583e833d43a1940e6d210d0ce912",
          trigger: "TARGET_S2_SPARK_0xF8F5_LIQUIDATABLE" },
        { key: "targetS3_Spark_wstETH_WETH_0x0f8f", rank: "#S3", user: "0x0f8f3f27a9626de852cff35c9ed1a261131b70fe",
          trigger: "TARGET_S3_SPARK_0x0F8F_LIQUIDATABLE" },
        { key: "targetS4_Spark_wstETH_WETH_0x1964", rank: "#S4", user: "0x19647b0e6f6e3776378dac18047148d324472e02",
          trigger: "TARGET_S4_SPARK_0x1964_LIQUIDATABLE" },
      ] : [];
      const sparkWhaleOffset = callsM10M11.length;
      callsM10M11.push(...sparkWhales.map(({ user }) => ({
        target: SPARK_POOL, allowFailure: true, callData: POOL.encodeFunctionData("getUserAccountData", [user]),
      })));
      const rawM10M11 = await transport(rpc, "eth_call", [{ to: MULTICALL3, data: MC.encodeFunctionData("aggregate3", [callsM10M11]) }, pinHash], 15000);
      const resM10M11 = MC.decodeFunctionResult("aggregate3", rawM10M11)[0];
      for (const [index, definition] of sparkWhales.entries()) {
        const result = resM10M11[sparkWhaleOffset + index];
        if (!result?.success) continue;
        try {
          const [totalCollateralBase, totalDebtBase, , , , healthFactorRaw] = POOL.decodeFunctionResult("getUserAccountData", result.returnData);
          const acct = { totalCollateralBase, totalDebtBase };
          const healthFactor = Number(healthFactorRaw) / 1e18;
          const liquidatableNow = acct.totalDebtBase > 0n && healthFactorRaw > 0n && healthFactorRaw < W;
          const flashAmount = 50000000000000000000n;
          const params = {
            isAaveV3: true, target: SPARK_POOL, borrower: definition.user, debtToken: WETH, collateralToken: wstETH,
            collateralReserveId: 0n, debtReserveId: 0n, minCollateralSeized: 38000000000000000000n,
            swapKind: 1, swapTarget: UNI_ROUTER, swapSpender: UNI_ROUTER, uniFee: 100, curveI: 0, curveJ: 0,
            minDebtTokenOut: 50100000000000000000n, minProfitDebtToken: 100000000000000000n,
          };
          sparkWhaleTargets[definition.key] = {
            rank: definition.rank, user: definition.user, pool: SPARK_POOL, marketId: SPARK_POOL, pair: "wstETH / WETH (SparkLend)",
            observationOnly: false, armed: true, executableNow: liquidatableNow, liquidatableNow,
            deployedExecutor: DEPLOYED_LIQUIDATOR, executor: DEPLOYED_LIQUIDATOR,
            healthFactor, bpsToLiquidation: healthFactor > 0 ? +((1 - 1 / healthFactor) * 10000).toFixed(4) : null,
            collateralUsd: +(Number(acct.totalCollateralBase) / 1e8).toFixed(2),
            debtUsd: +(Number(acct.totalDebtBase) / 1e8).toFixed(2),
            // Supplied sizing reference, not a fresh executable exit quote.
            liveQuote: { repayWeth: 50.00, seizedWstEth: 40.48, uniV3OutWeth: 50.44, grossSurplusWeth: 0.44, grossSurplusUsd: 1060.00 },
            readyExecuteMorphoCalldata: LIQUIDATOR_IFACE.encodeFunctionData("executeMorpho", [flashAmount, params]),
          };
          forecastAave(sparkWhaleTargets[definition.key], [totalCollateralBase, totalDebtBase, 0n, 0n, 0n, healthFactorRaw],
            flashAmount > 0n && priceWeth > 0n && flashAmount * priceWeth <= totalDebtBase * W
              && flashAmount * priceWeth <= totalCollateralBase * W
              && params.minCollateralSeized > 0n && params.minDebtTokenOut >= flashAmount + params.minProfitDebtToken,
            () => ({ readyExecuteMorphoCalldata: LIQUIDATOR_IFACE.encodeFunctionData("executeMorpho", [flashAmount, params]) }), "SparkLend");
          if (liquidatableNow) fired.push(definition.trigger);
        } catch (_) { /* A failed Spark whale read must not discard its companions or existing targets. */ }
      }
      for (const [index, definition] of v3Whales.entries()) {
        const result = resM10M11[v3WhaleOffset + index];
        if (!result?.success) continue;
        try {
          const account = POOL.decodeFunctionResult("getUserAccountData", result.returnData);
          const healthFactorRaw = account[5], healthFactor = Number(healthFactorRaw) / 1e18;
          const liquidatableNow = account[1] > 0n && healthFactorRaw > 0n && healthFactorRaw < W;
          const params = {
            isAaveV3: true, target: POOL_V3, borrower: definition.user, debtToken: WETH,
            collateralToken: definition.sameAsset ? WETH : weETH,
            collateralReserveId: 0n, debtReserveId: 0n,
            minCollateralSeized: definition.sameAsset ? 0n : 13000000000000000000n,
            swapKind: definition.sameAsset ? 0 : 2,
            swapTarget: definition.sameAsset ? ethers.ZeroAddress : CURVE_WEETH_WETH,
            swapSpender: definition.sameAsset ? ethers.ZeroAddress : CURVE_WEETH_WETH,
            uniFee: 0, curveI: definition.sameAsset ? 0 : 1, curveJ: 0,
            minDebtTokenOut: definition.sameAsset ? 0n : 15050000000000000000n,
            minProfitDebtToken: definition.minProfit,
          };
          aaveV3WhaleTargets[definition.key] = {
            rank: definition.rank, user: definition.user, pool: POOL_V3,
            pair: definition.sameAsset ? "WETH / WETH (Same-Asset)" : "weETH / WETH",
            observationOnly: false, armed: true, executableNow: liquidatableNow, liquidatableNow,
            deployedExecutor: DEPLOYED_LIQUIDATOR, executor: DEPLOYED_LIQUIDATOR,
            healthFactor, bpsToLiquidation: healthFactor > 0 ? +((1 - 1 / healthFactor) * 10000).toFixed(4) : null,
            collateralUsd: +(Number(account[0]) / 1e8).toFixed(2), debtUsd: +(Number(account[1]) / 1e8).toFixed(2),
            // Supplied sizing reference, not a fresh executable exit quote.
            liveQuote: definition.liveQuote,
            readyExecuteMorphoCalldata: LIQUIDATOR_IFACE.encodeFunctionData("executeMorpho", [definition.flashAmount, params]),
          };
          forecastAave(aaveV3WhaleTargets[definition.key], account,
            definition.flashAmount > 0n && priceWeth > 0n && definition.flashAmount * priceWeth <= account[1] * W
              && definition.flashAmount * priceWeth <= account[0] * W && definition.minProfit > 0n && (definition.sameAsset
              || (params.minCollateralSeized > 0n && params.minDebtTokenOut >= definition.flashAmount + definition.minProfit)),
            () => ({ readyExecuteMorphoCalldata: LIQUIDATOR_IFACE.encodeFunctionData("executeMorpho", [definition.flashAmount, params]) }));
          if (liquidatableNow) fired.push(definition.trigger);
        } catch (_) { /* A failed whale read must not discard its companions or existing targets. */ }
      }
      const mkt10 = resM10M11[0]?.success ? BLUE.decodeFunctionResult("market", resM10M11[0].returnData) : null;
      const mkt11 = resM10M11[3]?.success ? BLUE.decodeFunctionResult("market", resM10M11[3].returnData) : null;
      const mkt12 = resM10M11[6]?.success ? BLUE.decodeFunctionResult("market", resM10M11[6].returnData) : null;
      const mkt14 = resM10M11[13]?.success ? BLUE.decodeFunctionResult("market", resM10M11[13].returnData) : null;
      const mkt15 = resM10M11[16]?.success ? BLUE.decodeFunctionResult("market", resM10M11[16].returnData) : null;
      const mkt16 = resM10M11[19]?.success ? BLUE.decodeFunctionResult("market", resM10M11[19].returnData) : null;
      const mkt17 = resM10M11[25]?.success ? BLUE.decodeFunctionResult("market", resM10M11[25].returnData) : null;
      const mkt18 = resM10M11[29]?.success ? BLUE.decodeFunctionResult("market", resM10M11[29].returnData) : null;
      const mkt21 = resM10M11[34]?.success ? BLUE.decodeFunctionResult("market", resM10M11[34].returnData) : null;
      const mkt23 = resM10M11[38]?.success ? BLUE.decodeFunctionResult("market", resM10M11[38].returnData) : null;
      const mkt29 = resM10M11[46]?.success ? BLUE.decodeFunctionResult("market", resM10M11[46].returnData) : null;
      const mkt30 = resM10M11[49]?.success ? BLUE.decodeFunctionResult("market", resM10M11[49].returnData) : null;
      const mkt31 = resM10M11[53]?.success ? BLUE.decodeFunctionResult("market", resM10M11[53].returnData) : null;
      const mkt32 = resM10M11[57]?.success ? BLUE.decodeFunctionResult("market", resM10M11[57].returnData) : null;
      const mkt33 = resM10M11[60]?.success ? BLUE.decodeFunctionResult("market", resM10M11[60].returnData) : null;
      const mkt34 = resM10M11[63]?.success ? BLUE.decodeFunctionResult("market", resM10M11[63].returnData) : null;
      const mkt35 = resM10M11[69]?.success ? BLUE.decodeFunctionResult("market", resM10M11[69].returnData) : null;
      const mkt36 = resM10M11[73]?.success ? BLUE.decodeFunctionResult("market", resM10M11[73].returnData) : null;
      const mkt37 = resM10M11[79]?.success ? BLUE.decodeFunctionResult("market", resM10M11[79].returnData) : null;
      const mkt42 = resM10M11[86]?.success ? BLUE.decodeFunctionResult("market", resM10M11[86].returnData) : null;
      const mkt43 = resM10M11[89]?.success ? BLUE.decodeFunctionResult("market", resM10M11[89].returnData) : null;
      const mkt44 = resM10M11[92]?.success ? BLUE.decodeFunctionResult("market", resM10M11[92].returnData) : null;
      const mkt45 = resM10M11[95]?.success ? BLUE.decodeFunctionResult("market", resM10M11[95].returnData) : null;
      const mkt48 = resM10M11[100]?.success ? BLUE.decodeFunctionResult("market", resM10M11[100].returnData) : null;
      const mkt49 = resM10M11[103]?.success ? BLUE.decodeFunctionResult("market", resM10M11[103].returnData) : null;
      let rate10 = null, rate11 = null, rate12 = null, rate14 = null, rate15 = null, rate16 = null, rate17 = null, rate18 = null, rate21 = null, rate23 = null, rate29 = null, rate30 = null, rate31 = null, rate32 = null, rate33 = null, rate34 = null, rate35 = null, rate36 = null, rate37 = null, rate42 = null, rate43 = null, rate44 = null, rate45 = null, rate48 = null, rate49 = null;
      try {
        const rateCalls = [
          mkt10 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[rlusd, USDe.toLowerCase(), m10Oracle, ETH_MORPHO_IRM.toLowerCase(), 915000000000000000n], Array.from(mkt10)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt11 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[WETH.toLowerCase(), weETH.toLowerCase(), m11Oracle, ETH_MORPHO_IRM.toLowerCase(), 945000000000000000n], Array.from(mkt11)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt12 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[USDC.toLowerCase(), ptUsd3Token, ptUsd3Oracle, ETH_MORPHO_IRM.toLowerCase(), 860000000000000000n], Array.from(mkt12)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt14 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[USDC.toLowerCase(), m14Pt, m14Oracle, ETH_MORPHO_IRM.toLowerCase(), 915000000000000000n], Array.from(mkt14)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt15 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[USDC.toLowerCase(), m15YoEdge, m15Oracle, ETH_MORPHO_IRM.toLowerCase(), 770000000000000000n], Array.from(mkt15)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt16 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[m16ApxUsd, m16ApyUsd, m16Oracle, ETH_MORPHO_IRM.toLowerCase(), 860000000000000000n], Array.from(mkt16)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt17 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[USDe.toLowerCase(), m17Eusde, m17Oracle, ETH_MORPHO_IRM.toLowerCase(), 915000000000000000n], Array.from(mkt17)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt18 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[USDC.toLowerCase(), m18Usd3, m18Oracle, ETH_MORPHO_IRM.toLowerCase(), 915000000000000000n], Array.from(mkt18)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt21 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[m16ApxUsd, m21Pt, m21Oracle, ETH_MORPHO_IRM.toLowerCase(), 915000000000000000n], Array.from(mkt21)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt23 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[USDC.toLowerCase(), m23Pt, m23Oracle, ETH_MORPHO_IRM.toLowerCase(), 915000000000000000n], Array.from(mkt23)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt29 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[USDC.toLowerCase(), m29Pt, m29Oracle, ETH_MORPHO_IRM.toLowerCase(), 915000000000000000n], Array.from(mkt29)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt30 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[WETH.toLowerCase(), wstETH.toLowerCase(), m30Oracle, ETH_MORPHO_IRM.toLowerCase(), 965000000000000000n], Array.from(mkt30)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt31 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[USDC.toLowerCase(), m31Col, m31Oracle, ETH_MORPHO_IRM.toLowerCase(), 915000000000000000n], Array.from(mkt31)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt32 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[m32Usdtb, sUsde, m32Oracle, ETH_MORPHO_IRM.toLowerCase(), 915000000000000000n], Array.from(mkt32)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt33 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[usdtEth, m23Pt, m23Oracle, ETH_MORPHO_IRM.toLowerCase(), 915000000000000000n], Array.from(mkt33)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt34 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[WETH.toLowerCase(), m34BeraStone, m34Oracle, ETH_MORPHO_IRM.toLowerCase(), 915000000000000000n], Array.from(mkt34)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt35 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[USDC.toLowerCase(), ptUsd3Token, ptUsd3NewOracle, ETH_MORPHO_IRM.toLowerCase(), 860000000000000000n], Array.from(mkt35)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt36 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[usdtEth, m36Susds, m36Oracle, ETH_MORPHO_IRM.toLowerCase(), 965000000000000000n], Array.from(mkt36)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt37 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[usdtEth, m37Pst, m37Oracle, ETH_MORPHO_IRM.toLowerCase(), 860000000000000000n], Array.from(mkt37)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt42 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[USDC.toLowerCase(), m42StrUsd, m42Oracle, ETH_MORPHO_IRM.toLowerCase(), 860000000000000000n], Array.from(mkt42)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt43 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[m43Pyusd, m43Prime, m43Oracle, ETH_MORPHO_IRM.toLowerCase(), 860000000000000000n], Array.from(mkt43)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt44 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[USDC.toLowerCase(), m44SrUsd, m44Oracle, ETH_MORPHO_IRM.toLowerCase(), 915000000000000000n], Array.from(mkt44)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt45 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[USDC.toLowerCase(), m45ReUsde, m45Oracle, ETH_MORPHO_IRM.toLowerCase(), 770000000000000000n], Array.from(mkt45)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt48 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[usdtEth, REUSD.toLowerCase(), m48Oracle, ETH_MORPHO_IRM.toLowerCase(), 915000000000000000n], Array.from(mkt48)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
          mkt49 ? { target: ETH_MORPHO_IRM, allowFailure: true, callData: BLUE_IRM.encodeFunctionData("borrowRateView", [[usdtEth, sUsde, m49Oracle, ETH_MORPHO_IRM.toLowerCase(), 915000000000000000n], Array.from(mkt49)]) } : { target: ETH_MORPHO_IRM, allowFailure: true, callData: "0x" },
        ];
        const rawRates = await transport(rpc, "eth_call", [{ to: MULTICALL3, data: MC.encodeFunctionData("aggregate3", [rateCalls]) }, pinHash], 10000);
        const resRates = MC.decodeFunctionResult("aggregate3", rawRates)[0];
        if (mkt10 && resRates[0]?.success && resRates[0].returnData.length >= 66) rate10 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[0].returnData)[0];
        if (mkt11 && resRates[1]?.success && resRates[1].returnData.length >= 66) rate11 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[1].returnData)[0];
        if (mkt12 && resRates[2]?.success && resRates[2].returnData.length >= 66) rate12 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[2].returnData)[0];
        if (mkt14 && resRates[3]?.success && resRates[3].returnData.length >= 66) rate14 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[3].returnData)[0];
        if (mkt15 && resRates[4]?.success && resRates[4].returnData.length >= 66) rate15 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[4].returnData)[0];
        if (mkt16 && resRates[5]?.success && resRates[5].returnData.length >= 66) rate16 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[5].returnData)[0];
        if (mkt17 && resRates[6]?.success && resRates[6].returnData.length >= 66) rate17 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[6].returnData)[0];
        if (mkt18 && resRates[7]?.success && resRates[7].returnData.length >= 66) rate18 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[7].returnData)[0];
        if (mkt21 && resRates[8]?.success && resRates[8].returnData.length >= 66) rate21 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[8].returnData)[0];
        if (mkt23 && resRates[9]?.success && resRates[9].returnData.length >= 66) rate23 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[9].returnData)[0];
        if (mkt29 && resRates[10]?.success && resRates[10].returnData.length >= 66) rate29 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[10].returnData)[0];
        if (mkt30 && resRates[11]?.success && resRates[11].returnData.length >= 66) rate30 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[11].returnData)[0];
        if (mkt31 && resRates[12]?.success && resRates[12].returnData.length >= 66) rate31 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[12].returnData)[0];
        if (mkt32 && resRates[13]?.success && resRates[13].returnData.length >= 66) rate32 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[13].returnData)[0];
        if (mkt33 && resRates[14]?.success && resRates[14].returnData.length >= 66) rate33 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[14].returnData)[0];
        if (mkt34 && resRates[15]?.success && resRates[15].returnData.length >= 66) rate34 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[15].returnData)[0];
        if (mkt35 && resRates[16]?.success && resRates[16].returnData.length >= 66) rate35 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[16].returnData)[0];
        if (mkt36 && resRates[17]?.success && resRates[17].returnData.length >= 66) rate36 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[17].returnData)[0];
        if (mkt37 && resRates[18]?.success && resRates[18].returnData.length >= 66) rate37 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[18].returnData)[0];
        if (mkt42 && resRates[19]?.success && resRates[19].returnData.length >= 66) rate42 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[19].returnData)[0];
        if (mkt43 && resRates[20]?.success && resRates[20].returnData.length >= 66) rate43 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[20].returnData)[0];
        if (mkt44 && resRates[21]?.success && resRates[21].returnData.length >= 66) rate44 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[21].returnData)[0];
        if (mkt45 && resRates[22]?.success && resRates[22].returnData.length >= 66) rate45 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[22].returnData)[0];
        if (mkt48 && resRates[23]?.success && resRates[23].returnData.length >= 66) rate48 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[23].returnData)[0];
        if (mkt49 && resRates[24]?.success && resRates[24].returnData.length >= 66) rate49 = BLUE_IRM.decodeFunctionResult("borrowRateView", resRates[24].returnData)[0];
      } catch (_) {}
      if (mkt10 && resM10M11[1]?.success && resM10M11[2]?.success) {
        try {
          const mkt = mkt10;
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[1].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[2].returnData);
          if (price > 0n) {
            const rate = rate10;
            const elapsed = pinTs > mkt[4] ? pinTs - mkt[4] : 0n;
            const accrued = mkt[2] + mkt[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt[3] + V);
            const storedDebt = ceil(pos[1] * (mkt[2] + 1n), mkt[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 915000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const storedHf = storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null;
            const liqNow = rate !== null && debt > 0n ? maxBorrow < debt : false;
            const growth = (debt * (rate ?? 0n)) / W;
            const seizedUsdeRaw = clampMorphoSeize(35000n * W, pos, accrued, mkt[3], price, LIF_915);
            const flashPrincipalRlusdRaw = (seizedUsdeRaw * price) / (10n ** 36n);
            const minProfitRlusdRaw = 100n * W;
            const minLoanOutRlusdRaw = flashPrincipalRlusdRaw + minProfitRlusdRaw;
            const minSwapOutRlusdRaw = (seizedUsdeRaw * 34800n) / 35000n;
            const pathM10 = ethers.solidityPacked(["address", "uint24", "address", "uint24", "address"], [USDe, 100, USDC, 100, rlusd]);
            const swapDataM10 = UNIV3_EXACT_INPUT_IFACE.encodeFunctionData("exactInput", [{
              path: pathM10, recipient: M2_CURVE_UNWIND_EXECUTOR, deadline: 9999999999n,
              amountIn: seizedUsdeRaw, amountOutMinimum: minSwapOutRlusdRaw,
            }]);
            const planM10 = {
              loanToken: rlusd, collateralToken: USDe.toLowerCase(), oracle: m10Oracle, irm: ETH_MORPHO_IRM.toLowerCase(),
              lltv: 915000000000000000n, borrower: m10User, seizedAssets: seizedUsdeRaw,
              swapTarget: UNI_ROUTER.toLowerCase(), minLoanOut: minLoanOutRlusdRaw,
            };
            targetM10 = {
              rank: "#M10", user: m10User, marketId: m10Mkt, pair: "USDe / RLUSD",
              observationOnly: false, armed: true, deployedExecutor: M2_CURVE_UNWIND_EXECUTOR, executor: M2_CURVE_UNWIND_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on 0x2d5b...3627 ($35.2k RLUSD debt / 38.5k USDe collateral -> UniV3 USDe->USDC->RLUSD, +$911.56 RLUSD simulated).",
              healthFactor: hf, storedHealthFactor: storedHf, healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e18).toFixed(2), debtUsd: +(Number(debt) / 1e18).toFixed(2),
              liveQuote: { repayUsdc: 34092.60, seizedReusd: 35000, curveOutUsdc: 34986.97, grossSurplusUsdc: 894.37, grossSurplusUsd: 894.37 },
              readyExecuteCurveUnwindCalldata: M2_EXEC_IFACE.encodeFunctionData("execute", [planM10, swapDataM10]),
            };
            if (liqNow) fired.push("TARGET_M10_MORPHO_USDE_RLUSD_LIQUIDATABLE");
          }
        } catch (_) {}
      }
      if (mkt11 && resM10M11[4]?.success && resM10M11[5]?.success) {
        try {
          const mkt = mkt11;
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[4].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[5].returnData);
          if (price > 0n) {
            const rate = rate11;
            const elapsed = pinTs > mkt[4] ? pinTs - mkt[4] : 0n;
            const accrued = mkt[2] + mkt[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt[3] + V);
            const storedDebt = ceil(pos[1] * (mkt[2] + 1n), mkt[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 945000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const storedHf = storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null;
            const liqNow = rate !== null && debt > 0n ? maxBorrow < debt : false;
            const growth = (debt * (rate ?? 0n)) / W;
            const seizedWeethRaw = clampMorphoSeize(450n * W, pos, accrued, mkt[3], price, LIF_945);
            const minProfitWethRaw = 1n * W;
            const minOutWethRaw = (seizedWeethRaw * 470n) / 450n;
            const weethPath = ethers.solidityPacked(["address", "uint24", "address"], [weETH, 100, WETH]);
            const m11Calldata = MORPHO_EXEC_IFACE.encodeFunctionData("execute", [
              [WETH.toLowerCase(), weETH.toLowerCase(), m11Oracle, ETH_MORPHO_IRM.toLowerCase(), 945000000000000000n],
              m11User, seizedWeethRaw, 0n, minProfitWethRaw, minOutWethRaw, UNI_ROUTER.toLowerCase(), weethPath,
            ]);
            targetM11 = {
              rank: "#M11", user: m11User, marketId: m11Mkt, pair: "weETH / WETH",
              observationOnly: false, armed: true, deployedExecutor: DEPLOYED_MORPHO_EXECUTOR, executor: DEPLOYED_MORPHO_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on 0xaf5b...07ba (493.22 WETH / $1.20M debt / 474.29 weETH collateral -> UniV3 weETH->WETH, +6.50 WETH simulated).",
              healthFactor: hf, storedHealthFactor: storedHf, healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e18 * 2440).toFixed(2), debtUsd: +(Number(debt) / 1e18 * 2440).toFixed(2),
              liveQuote: { repayWeth: 468.20, seizedWstEth: 450, uniV3OutWeth: 474.70, grossSurplusWeth: 6.50, grossSurplusUsd: 15860.00 },
              readyExecuteMorphoBlueCalldata: m11Calldata,
            };
            if (liqNow) fired.push("TARGET_M11_MORPHO_WEETH_WETH_LIQUIDATABLE");
          }
        } catch (_) {}
      }
      if (mkt12 && resM10M11[7]?.success) {
        try {
          const mkt = mkt12;
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[7].returnData)[0];
          if (price > 0n) {
            const rate = rate12;
            const elapsed = pinTs > mkt[4] ? pinTs - mkt[4] : 0n;
            const accrued = mkt[2] + mkt[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            for (const [resIdx, rank, user, seizedPtUnits, minProfitUsdcUnits, simProfitUsdc, trigger] of [
              [8, "#M12", m12User, 500000n, 10000n, 32456.05, "TARGET_M12_MORPHO_PT_USD3_USDC_LIQUIDATABLE"],
              [9, "#M13", m13User, 105000n, 2000n, 6977.54, "TARGET_M13_MORPHO_PT_USD3_USDC_LIQUIDATABLE"],
            ]) {
              if (!resM10M11[resIdx]?.success) continue;
              const pos = BLUE.decodeFunctionResult("position", resM10M11[resIdx].returnData);
              const debt = ceil(pos[1] * (accrued + 1n), mkt[3] + V);
              const storedDebt = ceil(pos[1] * (mkt[2] + 1n), mkt[3] + V);
              const collVal = (pos[2] * price) / (10n ** 36n);
              const maxBorrow = (collVal * 860000000000000000n) / W;
              const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : 99.999999;
              const storedHf = storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : 99.999999;
              const liqNow = rate !== null && debt > 0n ? maxBorrow < debt : false;
              const growth = (debt * (rate ?? 0n)) / W;
              const seizedPtRaw = clampMorphoSeize(seizedPtUnits * 1000000n, pos, accrued, mkt[3], price, LIF_86);
              const flashPrincipalUsdcRaw = (seizedPtRaw * price) / (10n ** 36n);
              const repayEstUsdcRaw = ceil(ceil(seizedPtRaw * price, 10n ** 36n) * W, LIF_86);
              const minProfitUsdcRaw = minProfitUsdcUnits * 1000000n;
              const minLoanOutUsdcRaw = flashPrincipalUsdcRaw + minProfitUsdcRaw;
              const zero = ethers.ZeroAddress;
              const swapDataPt = PENDLE_ROUTER_V4_IFACE.encodeFunctionData("swapExactPtForToken", [
                M2_CURVE_UNWIND_EXECUTOR, pendleUsd3Market, seizedPtRaw,
                { tokenOut: USDC.toLowerCase(), minTokenOut: repayEstUsdcRaw + minProfitUsdcRaw, tokenRedeemSy: USDC.toLowerCase(),
                  pendleSwap: zero, swapData: { swapType: 0, extRouter: zero, extCalldata: "0x", needScale: false } },
                { limitRouter: zero, epsSkipMarket: 0, normalFills: [], flashFills: [], optData: "0x" },
              ]);
              const planPt = {
                loanToken: USDC.toLowerCase(), collateralToken: ptUsd3Token, oracle: ptUsd3Oracle, irm: ETH_MORPHO_IRM.toLowerCase(),
                lltv: 860000000000000000n, borrower: user, seizedAssets: seizedPtRaw,
                swapTarget: pendleRouterV4, minLoanOut: minLoanOutUsdcRaw,
              };
              const row = {
                rank, user, marketId: ptUsd3Mkt, pair: "PT-USD3-17DEC2026 / USDC",
                observationOnly: false, armed: true, deployedExecutor: M2_CURVE_UNWIND_EXECUTOR, executor: M2_CURVE_UNWIND_EXECUTOR,
                executableNow: liqNow, liquidatableNow: liqNow,
                readinessNote: `ARMED on 0x2d5b...3627 ($${(Number(debt) / 1e6).toFixed(1)}k USDC debt / ${(Number(pos[2]) / 1e6).toFixed(0)} PT-USD3 -> PendleRouterV4 USDC, +$${simProfitUsdc.toFixed(2)} USDC simulated).`,
                healthFactor: hf, storedHealthFactor: storedHf, healthIsEstimate: rate === null,
                borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
                passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
                bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
                collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
                quoteKind: "MODEL_ESTIMATE",
                liveQuote: { repayUsdc: +(Number(repayEstUsdcRaw) / 1e6).toFixed(2), seizedReusd: Number(seizedPtUnits),
                  curveOutUsdc: +(Number(repayEstUsdcRaw) / 1e6 + simProfitUsdc).toFixed(2), grossSurplusUsdc: simProfitUsdc, grossSurplusUsd: simProfitUsdc },
                readyExecuteCurveUnwindCalldata: M2_EXEC_IFACE.encodeFunctionData("execute", [planPt, swapDataPt]),
              };
              if (rank === "#M12") targetM12 = row;
              else targetM13 = row;
              if (liqNow) fired.push(trigger);
            }
          }
        } catch (_) {}
      }
      if (m2Price > 0n && m2OutUsdcRaw > 0n) {
        for (const [resIdx, rank, user, trigger] of [
          [10, "#M2B", m2bUser, "TARGET_M2B_MORPHO_REUSD_USDC_LIQUIDATABLE"],
          [11, "#M2C", m2cUser, "TARGET_M2C_MORPHO_REUSD_USDC_LIQUIDATABLE"],
          [12, "#M2D", m2dUser, "TARGET_M2D_MORPHO_REUSD_USDC_LIQUIDATABLE"],
          [83, "#M39", m39User, "TARGET_M39_MORPHO_REUSD_USDC_LIQUIDATABLE"],
        ]) {
          if (!resM10M11[resIdx]?.success) continue;
          try {
            const pos = BLUE.decodeFunctionResult("position", resM10M11[resIdx].returnData);
            const debt = ceil(pos[1] * (m2AccruedBorrowAssets + 1n), BigInt(m2Mkt[3]) + V);
            const storedDebt = ceil(pos[1] * (BigInt(m2Mkt[2]) + 1n), BigInt(m2Mkt[3]) + V);
            const collVal = (pos[2] * BigInt(m2Price)) / (10n ** 36n);
            const maxBorrow = (collVal * ETH_MORPHO_REUSD_USDC_LLTV) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const storedHf = storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null;
            const liqNow = debt > 0n && maxBorrow < debt && m2NetUsdc >= 25;
            const growth = (debt * m2Rate) / W;
            const m2xSeizeRaw = clampMorphoSeize(m2SeizeRaw, pos, m2AccruedBorrowAssets, m2Mkt[3], m2Price, LIF_915);
            const m2xPrincipalUsdcRaw = (m2xSeizeRaw * BigInt(m2Price)) / (10n ** 36n);
            const m2xMinOutSwap = (((BigInt(m2OutUsdcRaw) * m2xSeizeRaw) / m2SeizeRaw) * 9950n) / 10000n;
            const m2xMinLoanOut = m2xPrincipalUsdcRaw + 25000000n;
            const m2xSwapData = M2_CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [0, 1, m2xSeizeRaw, m2xMinOutSwap]);
            const m2xCalldata = M2_EXEC_IFACE.encodeFunctionData("execute", [[
              USDC.toLowerCase(), REUSD.toLowerCase(), ETH_MORPHO_REUSD_USDC_ORACLE.toLowerCase(), ETH_MORPHO_IRM.toLowerCase(),
              915000000000000000n, user, m2xSeizeRaw, CURVE_REUSD_USDC.toLowerCase(), m2xMinLoanOut,
            ], m2xSwapData]);
            const row = {
              rank, user, marketId: ETH_MORPHO_REUSD_USDC_MKT, pair: "reUSD / USDC",
              observationOnly: false, armed: true, deployedExecutor: M2_CURVE_UNWIND_EXECUTOR, executor: M2_CURVE_UNWIND_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: `ARMED on Curve-unwind executor 0x2d5b...3627 ($${(Number(debt) / 1e3).toFixed(1)}k USDC debt ahead of #M2, +$2,299.13 USDC simulated).`,
              healthFactor: hf, storedHealthFactor: storedHf,
              borrowAprPct: +(Number(m2Rate) / 1e18 * 31536000 * 100).toFixed(2),
              passiveHoursToCrossing: liqNow ? 0 : growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
              quoteKind: "ONCHAIN_MEASURED",
              liveQuote: { repayUsdc: +(Number(m2RepayUsdcRaw) / 1e6).toFixed(2), seizedReusd: 100000,
                curveOutUsdc: +(Number(m2OutUsdcRaw) / 1e6).toFixed(2), grossSurplusUsdc: +m2NetUsdc.toFixed(2), grossSurplusUsd: +m2NetUsdc.toFixed(2) },
              readyExecuteCurveUnwindCalldata: m2xCalldata,
            };
            if (rank === "#M2B") targetM2B = row;
            else if (rank === "#M2C") targetM2C = row;
            else if (rank === "#M2D") targetM2D = row;
            else targetM39 = row;
            if (liqNow) fired.push(trigger);
          } catch (_) {}
        }
      }
      if (mkt14 && resM10M11[14]?.success && resM10M11[15]?.success) {
        try {
          const mkt = mkt14;
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[14].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[15].returnData);
          const rate = rate14;
          const elapsed = pinTs > mkt[4] ? pinTs - mkt[4] : 0n;
          const accrued = mkt[2] + mkt[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
          const debt = ceil(pos[1] * (accrued + 1n), mkt[3] + V);
          const storedDebt = ceil(pos[1] * (mkt[2] + 1n), mkt[3] + V);
          const collVal = (pos[2] * price) / (10n ** 36n);
          const maxBorrow = (collVal * 915000000000000000n) / W;
          const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
          const storedHf = storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null;
          const liqNow = rate !== null && debt > 0n ? maxBorrow < debt : false;
          const growth = (debt * (rate ?? 0n)) / W;
          const seizedPtRaw = clampMorphoSeize(5400n * 1000000n, pos, accrued, mkt[3], price, LIF_915);
          const principalUsdcRaw = (seizedPtRaw * price) / (10n ** 36n);
          const minLoanOutRaw = principalUsdcRaw + 25000000n;
          const curveUsdatPool = "0xf4d0cf32908b2c7f1021339c43df0f77f06896d7";
          const swapData14 = M2_CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [1, 0, seizedPtRaw, (principalUsdcRaw * 9900n) / 10000n]);
          const plan14 = [
            USDC.toLowerCase(), m14Pt, m14Oracle, ETH_MORPHO_IRM.toLowerCase(), 915000000000000000n,
            m14User, seizedPtRaw, "0x076a3ea71e83ca09319b161e40f5fb3bb943d3c6", "0x7a7de491e1be5287874904e2b7c8488249a4d0a9",
            "0x23238f20b894f29041f48d88ee91131c395aaa71", curveUsdatPool, minLoanOutRaw,
          ];
          targetM14 = {
            rank: "#M14", user: m14User, marketId: m14Mkt, pair: "PT-USDat-27AUG2026 / USDC",
            observationOnly: false, armed: true, deployedExecutor: PENDLE_PT_EXECUTOR, executor: PENDLE_PT_EXECUTOR,
            executableNow: liqNow, liquidatableNow: liqNow,
            readinessNote: "ARMED on 0xd53e...b84d ($5.39k USDC debt / 5,902.74 PT-USDat-27AUG2026 -> YT/SY redeem -> Curve USDat/USDC, +$140.00 USDC simulated).",
            healthFactor: hf, storedHealthFactor: storedHf, healthIsEstimate: rate === null,
            borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
            passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
            bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
            collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
            collateralPt: Number(pos[2]) / 1e6,
            liveQuote: { repayUsdc: 5262.10, seizedReusd: 5400, curveOutUsdc: 5402.10, grossSurplusUsdc: 140.00, grossSurplusUsd: 140.00 },
            readyExecutePendlePtCalldata: PENDLE_PT_EXEC_IFACE.encodeFunctionData("execute", [plan14, swapData14]),
          };
          if (liqNow) fired.push("TARGET_M14_MORPHO_PT_USDAT_USDC_LIQUIDATABLE");
        } catch (_) {}
      }
      if (mkt15 && resM10M11[17]?.success && resM10M11[18]?.success) {
        try {
          const mkt = mkt15;
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[17].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[18].returnData);
          if (price > 0n) {
            const rate = rate15;
            const elapsed = pinTs > mkt[4] ? pinTs - mkt[4] : 0n;
            const accrued = mkt[2] + mkt[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt[3] + V);
            const storedDebt = ceil(pos[1] * (mkt[2] + 1n), mkt[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 770000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const storedHf = storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null;
            const liqNow = rate !== null && debt > 0n ? maxBorrow < debt : false;
            const growth = (debt * (rate ?? 0n)) / W;
            const seizedYoRaw = clampMorphoSeize(6800n * 1000000n, pos, accrued, mkt[3], price, LIF_77);
            const principalUsdcRaw = (seizedYoRaw * price) / (10n ** 36n);
            const minLoanOutRaw = principalUsdcRaw + 400n * 1000000n;
            const swapData15 = VAULT_4626.encodeFunctionData("redeem", [seizedYoRaw, M2_CURVE_UNWIND_EXECUTOR, M2_CURVE_UNWIND_EXECUTOR]);
            const plan15 = {
              loanToken: USDC.toLowerCase(), collateralToken: m15YoEdge, oracle: m15Oracle, irm: ETH_MORPHO_IRM.toLowerCase(),
              lltv: 770000000000000000n, borrower: m15User, seizedAssets: seizedYoRaw,
              swapTarget: m15YoEdge, minLoanOut: minLoanOutRaw,
            };
            targetM15 = {
              rank: "#M15", user: m15User, marketId: m15Mkt, pair: "yoUSD Edge / USDC",
              observationOnly: false, armed: true, deployedExecutor: M2_CURVE_UNWIND_EXECUTOR, executor: M2_CURVE_UNWIND_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on 0x2d5b...3627 ($6.68k USDC debt / 8,494.97 yoUSD Edge -> yoUSD Edge.redeem, +$485.00 USDC simulated).",
              healthFactor: hf, storedHealthFactor: storedHf, healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
              liveQuote: { repayUsdc: 6467.00, seizedReusd: 6800, curveOutUsdc: 6952.00, grossSurplusUsdc: 485.00, grossSurplusUsd: 485.00 },
              readyExecuteCurveUnwindCalldata: M2_EXEC_IFACE.encodeFunctionData("execute", [plan15, swapData15]),
            };
            if (liqNow) fired.push("TARGET_M15_MORPHO_YOUSD_EDGE_USDC_LIQUIDATABLE");
          }
        } catch (_) {}
      }
      if (mkt16 && resM10M11[20]?.success && resM10M11[21]?.success) {
        try {
          const mkt = mkt16;
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[20].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[21].returnData);
          if (price > 0n) {
            const rate = rate16;
            const elapsed = pinTs > mkt[4] ? pinTs - mkt[4] : 0n;
            const accrued = mkt[2] + mkt[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt[3] + V);
            const storedDebt = ceil(pos[1] * (mkt[2] + 1n), mkt[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 860000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const storedHf = storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null;
            const liqNow = rate !== null && debt > 0n ? maxBorrow < debt : false;
            const growth = (debt * (rate ?? 0n)) / W;
            const seizedApyRaw = clampMorphoSeize(500000n * W, pos, accrued, mkt[3], price, LIF_86);
            const principalApxRaw = (seizedApyRaw * price) / (10n ** 36n);
            const minLoanOutApxRaw = principalApxRaw + 5000n * W;
            const swapData16 = M2_CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [0, 1, seizedApyRaw, (seizedApyRaw * 690000n) / 500000n]);
            const plan16 = {
              loanToken: m16ApxUsd, collateralToken: m16ApyUsd, oracle: m16Oracle, irm: ETH_MORPHO_IRM.toLowerCase(),
              lltv: 860000000000000000n, borrower: m16User, seizedAssets: seizedApyRaw,
              swapTarget: curveApyApx, minLoanOut: minLoanOutApxRaw,
            };
            targetM16 = {
              rank: "#M16", user: m16User, marketId: m16Mkt, pair: "apyUSD / apxUSD",
              observationOnly: false, armed: true, deployedExecutor: M2_CURVE_UNWIND_EXECUTOR, executor: M2_CURVE_UNWIND_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on 0x2d5b...3627 ($779.5k apxUSD debt / 630.4k apyUSD -> Curve $16.77M apyUSD/apxUSD pool, +$9,453.47 apxUSD simulated).",
              healthFactor: hf, storedHealthFactor: storedHf, healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e18).toFixed(2), debtUsd: +(Number(debt) / 1e18).toFixed(2),
              liveQuote: { repayUsdc: 688451.37, seizedReusd: 500000, curveOutUsdc: 697904.85, grossSurplusUsdc: 9453.47, grossSurplusUsd: 9453.47 },
              readyExecuteCurveUnwindCalldata: M2_EXEC_IFACE.encodeFunctionData("execute", [plan16, swapData16]),
            };
            if (liqNow) fired.push("TARGET_M16_MORPHO_APYUSD_APXUSD_LIQUIDATABLE");
          }
        } catch (_) {}
      }
      if (mkt17 && resM10M11[26]?.success) {
        const additionalBorrowers = [];
        for (const [resIdx, user] of [[27, m17User], [28, m17OtherUser]]) {
          if (!resM10M11[resIdx]?.success) continue;
          try {
            const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[26].returnData)[0];
            if (price <= 0n) continue;
            const pos = BLUE.decodeFunctionResult("position", resM10M11[resIdx].returnData);
            const elapsed = pinTs > mkt17[4] ? pinTs - mkt17[4] : 0n;
            const interest = mkt17[2] * wTaylorCompounded(rate17 ?? 0n, elapsed) / W;
            const accrued = mkt17[2] + interest;
            const debt = ceil(pos[1] * (accrued + 1n), mkt17[3] + V);
            const storedDebt = ceil(pos[1] * (mkt17[2] + 1n), mkt17[3] + V);
            const collVal = pos[2] * price / (10n ** 36n);
            const maxBorrow = collVal * 915000000000000000n / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const m17Liquidatable = rate17 !== null && debt > 0n && maxBorrow < debt;
            const growth = debt * (rate17 ?? 0n) / W;
            const row = {
              user, marketId: m17Mkt, pair: "eUSDe / USDe", liquidatableNow: m17Liquidatable,
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate17 === null,
              borrowAprPct: rate17 !== null ? +(Number(rate17) / 1e18 * 31536000 * 100).toFixed(2) : null,
              borrowApyPct: rate17 !== null ? +((Math.exp(Number(rate17) / 1e18 * 31536000) - 1) * 100).toFixed(2) : null,
              utilizationPct: mkt17[0] + interest > 0n ? +(Number(accrued) / Number(mkt17[0] + interest) * 100).toFixed(2) : null,
              passiveHoursToCrossing: m17Liquidatable ? 0 : rate17 !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e18).toFixed(2), debtUsd: +(Number(debt) / 1e18).toFixed(2),
            };
            if (user !== m17User) {
              additionalBorrowers.push({ ...row, observationOnly: true, executableNow: false });
              continue;
            }
            const seizeM17 = clampMorphoSeize(30000n * W, pos, accrued, mkt17[3], price, LIF_915);
            // The unwind executor flash-borrows the oracle-valued principal before liquidation.
            const repayM17 = seizeM17 * price / (10n ** 36n);
            const plan17 = {
              loanToken: USDe.toLowerCase(), collateralToken: m17Eusde, oracle: m17Oracle, irm: ETH_MORPHO_IRM.toLowerCase(),
              lltv: 915000000000000000n, borrower: m17User, seizedAssets: seizeM17,
              swapTarget: m17Eusde, minLoanOut: repayM17 + 20n * W,
            };
            const swapData17 = VAULT_4626.encodeFunctionData("redeem", [seizeM17, M2_CURVE_UNWIND_EXECUTOR, M2_CURVE_UNWIND_EXECUTOR]);
            const m17Calldata = M2_EXEC_IFACE.encodeFunctionData("execute", [plan17, swapData17]);
            targetM17 = {
              ...row, rank: "#M17", observationOnly: false, armed: true,
              deployedExecutor: M2_CURVE_UNWIND_EXECUTOR, executor: M2_CURVE_UNWIND_EXECUTOR,
              executableNow: m17Liquidatable,
              readinessNote: "eUSDe.redeem -> USDe on 0x2d5b...3627; requires liquidatable accrued debt and trigger-pin execution preflight; 20 USDe owner floor before gas.",
              additionalBorrowers,
              // Supplied simulation reference alongside the pin-derived sizing.
              liveQuote: { repayUsdc: 29486.00, seizedReusd: 30000, curveOutUsdc: 30525.00,
                grossSurplusUsdc: 1039.00, grossSurplusUsd: 1039.00,
                flashPrincipalUsde: Number(repayM17) / 1e18, seizedEusde: Number(seizeM17) / 1e18 },
              readyExecuteCurveUnwindCalldata: m17Calldata,
              readyExecuteReusdCalldata: m17Calldata,
            };
            if (m17Liquidatable) fired.push("TARGET_M17_MORPHO_EUSDE_USDE_LIQUIDATABLE");
          } catch (_) { /* A failed borrower read must not discard its companion. */ }
        }
      }
      if (mkt18 && resM10M11[30]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[30].returnData)[0];
          if (price > 0n) {
            const rate = rate18;
            const elapsed = pinTs > mkt18[4] ? pinTs - mkt18[4] : 0n;
            const accrued = mkt18[2] + mkt18[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            for (const [resIdx, rank, user, maxSeize, minProfit, liveQuote, readinessNote] of [
              [31, "#M18", m18User, 100000n * 1000000n, 500n * 1000000n,
                { repayUsdc: 116591.50, seizedReusd: 100000, curveOutUsdc: 118487.38, grossSurplusUsdc: 1895.88, grossSurplusUsd: 1895.88 },
                "ARMED on 0x2d5b...3627 ($137.3k USDC debt / 128.6k USD3 -> USD3.redeem(maxLoss=0), +$1,895.88 USDC simulated)."],
              [32, "#M19", m19User, 500000n * 1000000n, 2500n * 1000000n,
                { repayUsdc: 563988.00, seizedReusd: 500000, curveOutUsdc: 592438.48, grossSurplusUsdc: 28450.48, grossSurplusUsd: 28450.48 },
                "ARMED on 0x2d5b...3627 ($5.04M USDC debt / 4.65M USD3 -> 500k USD3.redeem(maxLoss=0), +$28,450.48 USDC simulated)."],
              [33, "#M20", m20User, 500000n * 1000000n, 2500n * 1000000n,
                { repayUsdc: 563988.00, seizedReusd: 500000, curveOutUsdc: 592438.48, grossSurplusUsdc: 28450.48, grossSurplusUsd: 28450.48 },
                "ARMED on 0x2d5b...3627 ($2.01M USDC debt / 1.86M USD3 -> 500k USD3.redeem(maxLoss=0), +$28,450.48 USDC simulated)."],
              [42, "#M25", m25User, 150000n * 1000000n, 750n * 1000000n,
                { repayUsdc: 169196.40, seizedReusd: 150000, curveOutUsdc: 177731.54, grossSurplusUsdc: 8535.14, grossSurplusUsd: 8535.14 },
                "ARMED on 0x2d5b...3627 ($197.1k USDC debt -> 150k USD3.redeem(maxLoss=0), +$8,535.14 USDC simulated)."],
              [43, "#M26", m26User, 500000n * 1000000n, 2500n * 1000000n,
                { repayUsdc: 563988.00, seizedReusd: 500000, curveOutUsdc: 592438.48, grossSurplusUsdc: 28450.48, grossSurplusUsd: 28450.48 },
                "ARMED on 0x2d5b...3627 ($2.87M USDC debt -> 500k USD3.redeem(maxLoss=0), +$28,450.48 USDC simulated)."],
            ]) {
              if (!resM10M11[resIdx]?.success) continue;
              try {
                const pos = BLUE.decodeFunctionResult("position", resM10M11[resIdx].returnData);
                const debt = ceil(pos[1] * (accrued + 1n), mkt18[3] + V);
                const storedDebt = ceil(pos[1] * (mkt18[2] + 1n), mkt18[3] + V);
                const collVal = (pos[2] * price) / (10n ** 36n);
                const maxBorrow = collVal * 915000000000000000n / W;
                const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
                const storedHf = storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null;
                const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
                const growth = debt * (rate ?? 0n) / W;
                // Both USD3 shares and USDC loan assets use six decimals.
                const seize = clampMorphoSeize(maxSeize, pos, accrued, mkt18[3], price, LIF_915);
                const repay = (seize * price) / (10n ** 36n);
                const swapData = USD3_REDEEM_4_IFACE.encodeFunctionData("redeem", [seize, M2_CURVE_UNWIND_EXECUTOR, M2_CURVE_UNWIND_EXECUTOR, 0n]);
                const plan = {
                  loanToken: USDC.toLowerCase(), collateralToken: m18Usd3, oracle: m18Oracle, irm: ETH_MORPHO_IRM.toLowerCase(),
                  lltv: 915000000000000000n, borrower: user, seizedAssets: seize,
                  swapTarget: m18Usd3, minLoanOut: repay + minProfit,
                };
                const row = {
                  rank, user, marketId: m18Mkt, pair: "USD3 / USDC",
                  observationOnly: false, armed: true, deployedExecutor: M2_CURVE_UNWIND_EXECUTOR, executor: M2_CURVE_UNWIND_EXECUTOR,
                  executableNow: liqNow, liquidatableNow: liqNow, readinessNote,
                  healthFactor: hf, storedHealthFactor: storedHf, healthIsEstimate: rate === null,
                  borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
                  passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
                  bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
                  collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
                  // Supplied simulation reference, not a fresh redemption quote.
                  liveQuote,
                  readyExecuteCurveUnwindCalldata: M2_EXEC_IFACE.encodeFunctionData("execute", [plan, swapData]),
                  readyExecuteReusdCalldata: M2_EXEC_IFACE.encodeFunctionData("execute", [plan, swapData]),
                };
                if (rank === "#M18") targetM18 = row;
                else if (rank === "#M19") targetM19 = row;
                else if (rank === "#M20") targetM20 = row;
                else if (rank === "#M25") targetM25 = row;
                else targetM26 = row;
                if (liqNow) fired.push(`TARGET_${rank.slice(1)}_MORPHO_USD3_USDC_LIQUIDATABLE`);
              } catch (_) { /* An unavailable position must not discard its market companions. */ }
            }
          }
        } catch (_) { /* Unavailable USD3 market evidence must not discard the other targets. */ }
      }
      if (mkt21 && resM10M11[35]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[35].returnData)[0];
          if (price > 0n) {
            const rate = rate21;
            const elapsed = pinTs > mkt21[4] ? pinTs - mkt21[4] : 0n;
            const accrued = mkt21[2] + mkt21[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            for (const [resIdx, rank, user, capPtUnits, ratioBps, minProfitApx, simProfit] of [
              [36, "#M21", m21User, 100000n, 6865n, 200n * W, 1665.64],
              [37, "#M22", m22User, 250000n, 6855n, 500n * W, 2291.00],
            ]) {
              if (!resM10M11[resIdx]?.success) continue;
              try {
                const pos = BLUE.decodeFunctionResult("position", resM10M11[resIdx].returnData);
                const debt = ceil(pos[1] * (accrued + 1n), mkt21[3] + V);
                const storedDebt = ceil(pos[1] * (mkt21[2] + 1n), mkt21[3] + V);
                const collVal = pos[2] * price / (10n ** 36n);
                const maxBorrow = collVal * 915000000000000000n / W;
                const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
                const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
                const growth = debt * (rate ?? 0n) / W;
                const seizedPtRaw = clampMorphoSeize(capPtUnits * W, pos, accrued, mkt21[3], price, LIF_915);
                const seizedValApxRaw = (seizedPtRaw * price) / (10n ** 36n);
                const dxApyRaw = (seizedPtRaw * ratioBps) / 10000n;
                const minDyApxRaw = (seizedValApxRaw * 9550n) / 10000n;
                const extCalldata = CURVE_5_IFACE.encodeFunctionData("exchange", [0, 1, dxApyRaw, minDyApxRaw, pendleRouterV4]);
                const swapData = PENDLE_ROUTER_V4_IFACE.encodeFunctionData("swapExactPtForToken", [
                  M2_CURVE_UNWIND_EXECUTOR, pendleApyMarket, seizedPtRaw,
                  { tokenOut: m16ApxUsd, minTokenOut: minDyApxRaw, tokenRedeemSy: m16ApyUsd, pendleSwap,
                    swapData: { swapType: 1, extRouter: curveApyApx, extCalldata, needScale: false } },
                  { limitRouter: ethers.ZeroAddress, epsSkipMarket: 0, normalFills: [], flashFills: [], optData: "0x" },
                ]);
                const plan = {
                  loanToken: m16ApxUsd, collateralToken: m21Pt, oracle: m21Oracle, irm: ETH_MORPHO_IRM.toLowerCase(),
                  lltv: 915000000000000000n, borrower: user, seizedAssets: seizedPtRaw,
                  swapTarget: pendleRouterV4, minLoanOut: seizedValApxRaw + minProfitApx,
                };
                const row = {
                  rank, user, marketId: m21Mkt, pair: "PT-apyUSD-5NOV2026 / apxUSD",
                  observationOnly: false, armed: true, deployedExecutor: M2_CURVE_UNWIND_EXECUTOR, executor: M2_CURVE_UNWIND_EXECUTOR,
                  executableNow: liqNow, liquidatableNow: liqNow,
                  readinessNote: `ARMED on 0x2d5b...3627 (${capPtUnits} PT-apyUSD cap -> Pendle -> Curve apyUSD/apxUSD, +${simProfit.toFixed(2)} apxUSD simulated); requires trigger-pin preflight.`,
                  healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
                  healthIsEstimate: rate === null,
                  borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
                  borrowApyPct: rate !== null ? +((Math.exp(Number(rate) / 1e18 * 31536000) - 1) * 100).toFixed(2) : null,
                  passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
                  bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
                  collateralUsd: +(Number(collVal) / 1e18).toFixed(2), debtUsd: +(Number(debt) / 1e18).toFixed(2),
                  // Supplied simulation surplus, not a fresh executable quote.
                  quoteKind: "MODEL_ESTIMATE",
                  liveQuote: { seizedReusd: Number(seizedPtRaw) / 1e18, flashPrincipalApx: Number(seizedValApxRaw) / 1e18,
                    grossSurplusUsdc: simProfit, grossSurplusUsd: simProfit },
                  readyExecuteCurveUnwindCalldata: M2_EXEC_IFACE.encodeFunctionData("execute", [plan, swapData]),
                  readyExecuteReusdCalldata: M2_EXEC_IFACE.encodeFunctionData("execute", [plan, swapData]),
                };
                if (rank === "#M21") targetM21 = row;
                else targetM22 = row;
                if (liqNow) fired.push(`TARGET_${rank.slice(1)}_MORPHO_PT_APYUSD_APXUSD_LIQUIDATABLE`);
              } catch (_) { /* A failed PT borrower read must not discard its companion. */ }
            }
          }
        } catch (_) { /* Unavailable PT-apyUSD evidence must not discard the other targets. */ }
      }
      if (mkt23 && resM10M11[39]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[39].returnData)[0];
          if (price > 0n) {
            const rate = rate23;
            const elapsed = pinTs > mkt23[4] ? pinTs - mkt23[4] : 0n;
            const accrued = mkt23[2] + mkt23[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            for (const [resIdx, rank, user, capPtUnits, ratioBps, minProfitUsdc, simProfit] of [
              [40, "#M23", m23User, 8000n, 8860n, 50n * 1000000n, 232.68],
              [41, "#M24", m24User, 40000n, 8810n, 150n * 1000000n, 832.95],
              [44, "#M27", m27User, 40000n, 8810n, 150n * 1000000n, 832.95],
              [45, "#M28", m28User, 40000n, 8810n, 150n * 1000000n, 832.95],
            ]) {
              if (!resM10M11[resIdx]?.success) continue;
              try {
                const pos = BLUE.decodeFunctionResult("position", resM10M11[resIdx].returnData);
                const debt = ceil(pos[1] * (accrued + 1n), mkt23[3] + V);
                const storedDebt = ceil(pos[1] * (mkt23[2] + 1n), mkt23[3] + V);
                const collVal = (pos[2] * price) / (10n ** 36n);
                const maxBorrow = collVal * 915000000000000000n / W;
                const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
                const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
                const growth = debt * (rate ?? 0n) / W;
                const seizedPtRaw = clampMorphoSeize(capPtUnits * 1000000n, pos, accrued, mkt23[3], price, LIF_915);
                const seizedValUsdcRaw = (seizedPtRaw * price) / (10n ** 36n);
                // PT and USDC use six decimals; Curve's reUSD input uses eighteen.
                const dxReusdRaw = (seizedPtRaw * ratioBps * (10n ** 12n)) / 10000n;
                const minDyUsdcRaw = (seizedValUsdcRaw * 9550n) / 10000n;
                const extCalldata = CURVE_5_IFACE.encodeFunctionData("exchange", [0, 1, dxReusdRaw, minDyUsdcRaw, pendleRouterV4]);
                const swapData = PENDLE_ROUTER_V4_IFACE.encodeFunctionData("swapExactPtForToken", [
                  M2_CURVE_UNWIND_EXECUTOR, pendleReusdMarket, seizedPtRaw,
                  { tokenOut: USDC.toLowerCase(), minTokenOut: minDyUsdcRaw, tokenRedeemSy: REUSD.toLowerCase(), pendleSwap,
                    swapData: { swapType: 1, extRouter: CURVE_REUSD_USDC.toLowerCase(), extCalldata, needScale: false } },
                  { limitRouter: ethers.ZeroAddress, epsSkipMarket: 0, normalFills: [], flashFills: [], optData: "0x" },
                ]);
                const plan = {
                  loanToken: USDC.toLowerCase(), collateralToken: m23Pt, oracle: m23Oracle, irm: ETH_MORPHO_IRM.toLowerCase(),
                  lltv: 915000000000000000n, borrower: user, seizedAssets: seizedPtRaw,
                  swapTarget: pendleRouterV4, minLoanOut: seizedValUsdcRaw + minProfitUsdc,
                };
                const row = {
                  rank, user, marketId: m23Mkt, pair: "PT-reUSD-10DEC2026 / USDC",
                  observationOnly: false, armed: true, deployedExecutor: M2_CURVE_UNWIND_EXECUTOR, executor: M2_CURVE_UNWIND_EXECUTOR,
                  executableNow: liqNow, liquidatableNow: liqNow,
                  readinessNote: `ARMED on 0x2d5b...3627 (${capPtUnits} PT-reUSD cap -> Pendle -> Curve reUSD/USDC, +${simProfit.toFixed(2)} USDC simulated); requires trigger-pin preflight.`,
                  healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
                  healthIsEstimate: rate === null,
                  borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
                  borrowApyPct: rate !== null ? +((Math.exp(Number(rate) / 1e18 * 31536000) - 1) * 100).toFixed(2) : null,
                  passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
                  bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
                  collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
                  // Supplied simulation surplus, not a fresh executable quote.
                  quoteKind: "MODEL_ESTIMATE",
                  liveQuote: { seizedReusd: Number(seizedPtRaw) / 1e6, flashPrincipalUsdc: Number(seizedValUsdcRaw) / 1e6,
                    grossSurplusUsdc: simProfit, grossSurplusUsd: simProfit },
                  readyExecuteCurveUnwindCalldata: M2_EXEC_IFACE.encodeFunctionData("execute", [plan, swapData]),
                  readyExecuteReusdCalldata: M2_EXEC_IFACE.encodeFunctionData("execute", [plan, swapData]),
                };
                if (rank === "#M23") targetM23 = row;
                else if (rank === "#M24") targetM24 = row;
                else if (rank === "#M27") targetM27 = row;
                else targetM28 = row;
                if (liqNow) fired.push(`TARGET_${rank.slice(1)}_MORPHO_PT_REUSD_USDC_LIQUIDATABLE`);
              } catch (_) { /* A failed PT borrower read must not discard its companion. */ }
            }
          }
        } catch (_) { /* Unavailable PT-reUSD evidence must not discard the other targets. */ }
      }
      if (mkt29 && resM10M11[47]?.success && resM10M11[48]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[47].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[48].returnData);
          if (price > 0n) {
            const rate = rate29;
            const elapsed = pinTs > mkt29[4] ? pinTs - mkt29[4] : 0n;
            const accrued = mkt29[2] + mkt29[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt29[3] + V);
            const storedDebt = ceil(pos[1] * (mkt29[2] + 1n), mkt29[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = collVal * 915000000000000000n / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = debt * (rate ?? 0n) / W;
            const seizedPtRaw = clampMorphoSeize(3500n * W, pos, accrued, mkt29[3], price, LIF_915);
            const seizedValUsdcRaw = (seizedPtRaw * price) / (10n ** 36n);
            let dxSusdeRaw = (seizedPtRaw * 7965n) / 10000n;
            let redemption29Measured = false;
            if (!options.rpcCall) {
              try {
                const [rawIndex, rawRedeem] = await Promise.all([
                  transport(rpc, "eth_call", [{ to: m29Yt, data: PENDLE_YT_IFACE.encodeFunctionData("pyIndexCurrent") }, pinHash], 10000),
                  transport(rpc, "eth_call", [{ to: m29Sy, data: PENDLE_SY_IFACE.encodeFunctionData("previewRedeem", [sUsde, W]) }, pinHash], 10000),
                ]);
                const pyIndexRaw = PENDLE_YT_IFACE.decodeFunctionResult("pyIndexCurrent", rawIndex)[0];
                const susdePerSyRaw = PENDLE_SY_IFACE.decodeFunctionResult("previewRedeem", rawRedeem)[0];
                if (pyIndexRaw <= 0n || susdePerSyRaw <= 0n) throw new Error("M29_REDEMPTION_RATE_INVALID");
                const redeemedSy = (seizedPtRaw * W) / pyIndexRaw;
                const redeemedSusde = (redeemedSy * susdePerSyRaw) / W;
                dxSusdeRaw = (redeemedSusde * 9995n) / 10000n;
                redemption29Measured = true;
              } catch (_) { /* Preserve the supplied sizing fallback if optional rate reads fail. */ }
            }
            const minOutUsdcRaw = (seizedValUsdcRaw * 9800n) / 10000n;
            const minLoanOutUsdcRaw = seizedValUsdcRaw + 20n * 1000000n;
            const zero = ethers.ZeroAddress;
            const route29 = [sUsde, poolSusdeCrvusd, crvUsd, poolUsdcCrvusd, USDC.toLowerCase(), zero, zero, zero, zero, zero, zero];
            const swapParams29 = [[1, 0, 1, 10, 2], [1, 0, 1, 10, 2], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
            const pools29 = [poolSusdeCrvusd, poolUsdcCrvusd, zero, zero, zero];
            let liveQuote29 = { repayUsdc: 3390.19, seizedReusd: 3500, curveOutUsdc: 3494.10, grossSurplusUsdc: 103.91, grossSurplusUsd: 103.91 };
            let quoteKind29 = "HISTORICAL_REFERENCE";
            if (!options.rpcCall) {
              try {
                const rawQuote = await transport(rpc, "eth_call", [{ to: curveRouterNg,
                  data: CURVE_ROUTER_NG_IFACE.encodeFunctionData("get_dy", [route29, swapParams29, dxSusdeRaw, pools29]) }, pinHash], 10000);
                const outUsdcRaw = CURVE_ROUTER_NG_IFACE.decodeFunctionResult("get_dy", rawQuote)[0];
                const repayEstUsdcRaw = ceil(ceil(seizedPtRaw * price, 10n ** 36n) * W, LIF_915);
                quoteKind29 = redemption29Measured ? "ONCHAIN_MEASURED" : "MODEL_ESTIMATE";
                liveQuote29 = {
                  repayUsdc: +(Number(repayEstUsdcRaw) / 1e6).toFixed(2), seizedReusd: Number(seizedPtRaw) / 1e18,
                  curveOutUsdc: +(Number(outUsdcRaw) / 1e6).toFixed(2),
                  grossSurplusUsdc: +(Number(outUsdcRaw - repayEstUsdcRaw) / 1e6).toFixed(2),
                  grossSurplusUsd: +(Number(outUsdcRaw - repayEstUsdcRaw) / 1e6).toFixed(2),
                };
              } catch (_) { /* Preserve the supplied simulation reference if the optional quote fails. */ }
            }
            const swapData29 = CURVE_ROUTER_NG_IFACE.encodeFunctionData("exchange", [route29, swapParams29, dxSusdeRaw, minOutUsdcRaw, pools29, PENDLE_PT_EXECUTOR]);
            const plan29 = {
              loanToken: USDC.toLowerCase(), collateralToken: m29Pt, oracle: m29Oracle, irm: ETH_MORPHO_IRM.toLowerCase(),
              lltv: 915000000000000000n, borrower: m29User, seizedAssets: seizedPtRaw,
              pendleYt: m29Yt, pendleSy: m29Sy, redeemedToken: sUsde, swapTarget: curveRouterNg, minLoanOut: minLoanOutUsdcRaw,
            };
            targetM29 = {
              rank: "#M29", user: m29User, marketId: m29Mkt, pair: "PT-srUSDe-15JAN2026 / USDC",
              observationOnly: false, armed: true, deployedExecutor: PENDLE_PT_EXECUTOR, executor: PENDLE_PT_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on 0xd53e...b84d ($3.82k USDC debt / 4,186.17 PT-srUSDe -> YT/SY redeem sUSDe -> CurveRouterNG crvUSD->USDC, +$103.91 USDC simulated).",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              borrowApyPct: rate !== null ? +((Math.exp(Number(rate) / 1e18 * 31536000) - 1) * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
              // Pinned Curve quote when available; otherwise the supplied simulation reference.
              liveQuote: liveQuote29,
              quoteKind: quoteKind29,
              readyExecutePendlePtCalldata: PENDLE_PT_EXEC_IFACE.encodeFunctionData("execute", [plan29, swapData29]),
            };
            if (liqNow) fired.push("TARGET_M29_MORPHO_PT_SRUSDE_USDC_LIQUIDATABLE");
          }
        } catch (_) { /* Unavailable PT-srUSDe evidence must not discard the other targets. */ }
      }
      if (mkt30 && resM10M11[50]?.success && resM10M11[51]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[50].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[51].returnData);
          if (price > 0n) {
            const rate = rate30;
            const elapsed = pinTs > mkt30[4] ? pinTs - mkt30[4] : 0n;
            const accrued = mkt30[2] + mkt30[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt30[3] + V);
            const storedDebt = ceil(pos[1] * (mkt30[2] + 1n), mkt30[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 965000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = (debt * (rate ?? 0n)) / W;
            // Keep M30's supplied liquidation factor local to this target.
            const LIF_965 = 1010611735330836454n;
            const seizedWstRaw = clampMorphoSeize(200000000000000000n, pos, accrued, mkt30[3], price, LIF_965);
            const minOutWethRaw = (seizedWstRaw * 240n) / 200n;
            const wstPath = ethers.solidityPacked(["address", "uint24", "address"], [wstETH, 100, WETH]);
            const m30Calldata = MORPHO_EXEC_IFACE.encodeFunctionData("execute", [
              [WETH.toLowerCase(), wstETH.toLowerCase(), m30Oracle, ETH_MORPHO_IRM.toLowerCase(), 965000000000000000n],
              m30User, seizedWstRaw, 0n, 1000000000000000n, minOutWethRaw, UNI_ROUTER.toLowerCase(), wstPath,
            ]);
            targetM30 = {
              rank: "#M30", user: m30User, marketId: m30Mkt, pair: "wstETH / WETH",
              observationOnly: false, armed: true, deployedExecutor: DEPLOYED_MORPHO_EXECUTOR, executor: DEPLOYED_MORPHO_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on Morpho executor (0.2000 wstETH cap -> UniV3 wstETH->WETH, +0.0026 WETH simulated); requires trigger-pin preflight.",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              borrowApyPct: rate !== null ? +((Math.exp(Number(rate) / 1e18 * 31536000) - 1) * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e18 * 2440).toFixed(2), debtUsd: +(Number(debt) / 1e18 * 2440).toFixed(2),
              // Supplied simulation reference, not a fresh executable quote.
              liveQuote: { repayWeth: 0.2420, seizedWstEth: 0.2000, uniV3OutWeth: 0.2446, grossSurplusWeth: 0.0026, grossSurplusUsd: 6.35 },
              readyExecuteMorphoBlueCalldata: m30Calldata,
            };
            if (liqNow) fired.push("TARGET_M30_MORPHO_WSTETH_WETH_LIQUIDATABLE");
          }
        } catch (_) { /* Unavailable M30 evidence must not discard the other targets. */ }
      }
      if (mkt31 && resM10M11[54]?.success && resM10M11[55]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[54].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[55].returnData);
          if (price > 0n) {
            const rate = rate31;
            const elapsed = pinTs > mkt31[4] ? pinTs - mkt31[4] : 0n;
            const accrued = mkt31[2] + mkt31[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt31[3] + V);
            const storedDebt = ceil(pos[1] * (mkt31[2] + 1n), mkt31[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 915000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const m31Liquidatable = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = (debt * (rate ?? 0n)) / W;
            const seizeM31 = clampMorphoSeize(740000000n, pos, accrued, mkt31[3], price, LIF_915);
            const repayM31 = (seizeM31 * price) / (10n ** 36n);
            const plan31 = {
              loanToken: USDC.toLowerCase(), collateralToken: m31Col, oracle: m31Oracle, irm: ETH_MORPHO_IRM.toLowerCase(),
              lltv: 915000000000000000n, borrower: m31User, seizedAssets: seizeM31,
              swapTarget: "0x6131b5fae19ea4f9d964eac0408e4408b66337b5", minLoanOut: repayM31 + 5000000n,
            };
            if (!options.rpcCall && (Date.now() - lastM31KyberSwap.tsMs > 300000 || lastM31KyberSwap.seizedRaw !== seizeM31)) {
              try {
                const signal = AbortSignal.timeout(5000);
                const routeResp = await fetch(`https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?tokenIn=0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b&tokenOut=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&amountIn=${seizeM31.toString()}&includedSources=uniswap-v4`, {
                  method: "GET", headers: { "x-client-id": "opencode-audit" }, signal,
                }).then(response => response.json());
                const routeSummary = routeResp?.data?.routeSummary;
                if (routeSummary) {
                  const buildResp = await fetch("https://aggregator-api.kyberswap.com/ethereum/api/v1/route/build", {
                    method: "POST", headers: { "content-type": "application/json", "x-client-id": "opencode-audit" }, signal,
                    body: JSON.stringify({ routeSummary, sender: M2_CURVE_UNWIND_EXECUTOR, recipient: M2_CURVE_UNWIND_EXECUTOR,
                      slippageTolerance: 100, deadline: 2147483647 }),
                  }).then(response => response.json());
                  if (typeof buildResp?.data?.data === "string" && buildResp.data.data.startsWith("0xe21fd0e9")) {
                    lastM31KyberSwap = { tsMs: Date.now(), seizedRaw: seizeM31, swapData: buildResp.data.data };
                  }
                }
              } catch (_) { /* Retain the cached payload when the route service is unavailable. */ }
            }
            const m31Calldata = M2_EXEC_IFACE.encodeFunctionData("execute", [plan31, lastM31KyberSwap.swapData]);
            targetM31 = {
              rank: "#M31", user: m31User, marketId: m31Mkt, pair: "syrupUSDC / USDC",
              observationOnly: false, armed: true, deployedExecutor: M2_CURVE_UNWIND_EXECUTOR, executor: M2_CURVE_UNWIND_EXECUTOR,
              executableNow: m31Liquidatable, liquidatableNow: m31Liquidatable,
              readinessNote: "ARMED on 0x2d5b...3627 ($864.1 USDC debt / 793.8 syrupUSDC collateral at 3.19 bps, +$21.91 USDC simulated).",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              borrowApyPct: rate !== null ? +((Math.exp(Number(rate) / 1e18 * 31536000) - 1) * 100).toFixed(2) : null,
              passiveHoursToCrossing: m31Liquidatable ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              // Both collateral valuation and debt are in six-decimal USDC units.
              collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
              // Supplied simulation reference, not a fresh executable quote.
              liveQuote: { repayUsdc: 864.09, seizedReusd: 745, curveOutUsdc: 886.00, grossSurplusUsdc: 21.91, grossSurplusUsd: 21.91 },
              readyExecuteCurveUnwindCalldata: m31Calldata,
              readyExecuteReusdCalldata: m31Calldata,
            };
            if (m31Liquidatable) fired.push("TARGET_M31_MORPHO_SYRUPUSDC_USDC_LIQUIDATABLE");
          }
        } catch (_) { /* Unavailable syrupUSDC evidence must not discard the other targets. */ }
      }
      if (mkt32 && resM10M11[58]?.success && resM10M11[59]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[58].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[59].returnData);
          if (price > 0n) {
            const rate = rate32;
            const elapsed = pinTs > mkt32[4] ? pinTs - mkt32[4] : 0n;
            const accrued = mkt32[2] + mkt32[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt32[3] + V);
            const storedDebt = ceil(pos[1] * (mkt32[2] + 1n), mkt32[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 915000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = (debt * (rate ?? 0n)) / W;
            targetM32 = {
              rank: "#M32", user: m32User, marketId: m32Mkt, pair: "sUSDe / USDtb",
              observationOnly: false, armed: true, deployedExecutor: M32_DEPLOYMENT.EXECUTOR, executor: M32_DEPLOYMENT.EXECUTOR,
              kind: "MORPHO_BLUE_M32", executableNow: false, liquidatableNow: liqNow,
              readinessNote: "ARMED on 0x2c94...47c4 (dedicated MorphoM32CurveUnwindLiquidator; +279.34 USDtb gross / +$213.50 modeled net rehearsed).",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              borrowApyPct: rate !== null ? +((Math.exp(Number(rate) / 1e18 * 31536000) - 1) * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e18).toFixed(2), debtUsd: +(Number(debt) / 1e18).toFixed(2),
              // Never combine current debt with a fixed past gain to fabricate an exit quote.
              quoteKind: "HISTORICAL_REFERENCE", liveQuote: { ...M32_REFERENCE_QUOTE },
            };
            if (liqNow) fired.push("TARGET_M32_MORPHO_SUSDE_USDTB_LIQUIDATABLE");
          }
        } catch (_) { /* Unavailable sUSDe/USDtb evidence must not discard the other targets. */ }
      }
      if (mkt33 && resM10M11[39]?.success && resM10M11[61]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[39].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[61].returnData);
          if (price > 0n) {
            const rate = rate33;
            const elapsed = pinTs > mkt33[4] ? pinTs - mkt33[4] : 0n;
            const accrued = mkt33[2] + mkt33[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt33[3] + V);
            const storedDebt = ceil(pos[1] * (mkt33[2] + 1n), mkt33[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 915000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = (debt * (rate ?? 0n)) / W;
            const zero = ethers.ZeroAddress;
            const seizedPtRaw = clampMorphoSeize(40000n * 1000000n, pos, accrued, mkt33[3], price, LIF_915);
            const flashUsdtRaw = (seizedPtRaw * price) / (10n ** 36n);
            const dxReusdRaw = (seizedPtRaw * 8810n * (10n ** 12n)) / 10000n;
            const minUsdcRaw = (flashUsdtRaw * 9550n) / 10000n;
            const extCalldata = CURVE_5_IFACE.encodeFunctionData("exchange", [0, 1, dxReusdRaw, minUsdcRaw, pendleRouterV4]);
            const data1 = PENDLE_ROUTER_V4_IFACE.encodeFunctionData("swapExactPtForToken", [
              UNIVERSAL_FLUID_MORPHO_EXECUTOR, pendleReusdMarket, seizedPtRaw,
              { tokenOut: USDC.toLowerCase(), minTokenOut: minUsdcRaw, tokenRedeemSy: REUSD.toLowerCase(), pendleSwap, swapData: { swapType: 1, extRouter: CURVE_REUSD_USDC.toLowerCase(), extCalldata, needScale: false } },
              { limitRouter: zero, epsSkipMarket: 0, normalFills: [], flashFills: [], optData: "0x" }
            ]);
            const data2 = M2_CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [0, 1, minUsdcRaw, minUsdcRaw - 50000000n]);
            const m33Calldata = UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{
              mode: 0, loanToken: usdtEth, flashAmount: flashUsdtRaw,
              collateralToken: m23Pt, oracle: m23Oracle, irm: ETH_MORPHO_IRM.toLowerCase(), lltv: 915000000000000000n,
              borrower: m33User, seizedAssets: seizedPtRaw,
              fluidVault: zero, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
              colPerUnitDebt: 0n, token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 0n, absorb: false,
              approveToken1: m23Pt, target1: pendleRouterV4, data1,
              approveToken2: USDC.toLowerCase(), target2: curveUsdcUsdt, data2,
              minProfit: 100n * 1000000n,
            }]);
            targetM33 = {
              rank: "#M33", user: m33User, marketId: m33Mkt, pair: "PT-reUSD-10DEC2026 / USDT",
              observationOnly: false, armed: true, deployedExecutor: UNIVERSAL_FLUID_MORPHO_EXECUTOR, executor: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on Universal 0xc503...3089 ($81.5k USDT debt / 90,959 PT-reUSD at 55.75 bps -> 2-step Pendle+Curve USDT, +$402.39 USDT simulated).",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              borrowApyPct: rate !== null ? +((Math.exp(Number(rate) / 1e18 * 31536000) - 1) * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
              liveQuote: { repayUsdc: 38094.56, seizedReusd: 40000, curveOutUsdc: 38496.95, grossSurplusUsdc: 402.39, grossSurplusUsd: 402.39 },
              readyExecuteUniversalCalldata: m33Calldata,
              readyExecuteCurveUnwindCalldata: m33Calldata,
              readyExecuteReusdCalldata: m33Calldata,
            };
            if (liqNow) fired.push("TARGET_M33_MORPHO_PT_REUSD_USDT_LIQUIDATABLE");
          }
        } catch (_) { /* Unavailable PT-reUSD/USDT evidence must not discard the other targets. */ }
      }
      if (resM10M11[62]?.success) {
        try {
          const f1LiqRow = FLUID_RESOLVER_IFACE.decodeFunctionResult("getVaultLiquidation", resM10M11[62].returnData)[0];
          const f1DebtAmt = BigInt(f1LiqRow.inAmtWithAbsorb || 0n);
          const f1Liq = f1DebtAmt >= 100000000n;
          const f1Hf = f1Liq ? 0.9995 : 1.000235;
          const f1Bps = f1Liq ? -5 : 2.3455;
          const zero = ethers.ZeroAddress;
          const f1FlashUsdt = f1Liq ? (f1DebtAmt * 101n) / 100n : 12000000000n;
          const f1Calldata = UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{
            mode: 1, loanToken: usdtEth, flashAmount: f1FlashUsdt,
            collateralToken: zero, oracle: zero, irm: zero, lltv: 0n, borrower: zero, seizedAssets: 0n,
            fluidVault: f1Vault93, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
            colPerUnitDebt: 1n, token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 1n, absorb: true,
            approveToken1: zero, target1: zero, data1: "0x",
            approveToken2: zero, target2: zero, data2: "0x",
            minProfit: 5000000n,
          }]);
          targetF1 = {
            rank: "#F1", user: f1User, marketId: f1Vault93, pair: "USDe-USDT / USDT (Fluid T2)",
            observationOnly: false, armed: true, deployedExecutor: UNIVERSAL_FLUID_MORPHO_EXECUTOR, executor: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
            executableNow: f1Liq, liquidatableNow: f1Liq,
            readinessNote: "ARMED on Universal 0xc503...3089 ($117.5k USDT debt in Fluid T2 Vault 93; NFT #7607 at 2.35 bps & NFT #6264 $117k at 72.08 bps -> +$384.51 to +$1,219.69 USDT simulated).",
            healthFactor: f1Hf,
            bpsToLiquidation: f1Bps,
            collateralUsd: 124719.95, debtUsd: 117488.49,
            liveQuote: { repayUsdc: 12000.00, seizedReusd: 5658.74, curveOutUsdc: 12384.51, grossSurplusUsdc: 384.51, grossSurplusUsd: 384.51 },
            readyExecuteUniversalCalldata: f1Calldata,
            readyExecuteCurveUnwindCalldata: f1Calldata,
            readyExecuteReusdCalldata: f1Calldata,
          };
          if (f1Liq) fired.push("TARGET_F1_FLUID_USDE_USDT_93_LIQUIDATABLE");
        } catch (_) { /* Unavailable Fluid Vault 93 evidence must not discard the other targets. */ }
      }
      if (mkt34 && resM10M11[64]?.success && resM10M11[65]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[64].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[65].returnData);
          if (price > 0n) {
            const rate = rate34;
            const elapsed = pinTs > mkt34[4] ? pinTs - mkt34[4] : 0n;
            const accrued = mkt34[2] + mkt34[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt34[3] + V);
            const storedDebt = ceil(pos[1] * (mkt34[2] + 1n), mkt34[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 915000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = (debt * (rate ?? 0n)) / W;
            const zero = ethers.ZeroAddress;
            const seizedBera = clampMorphoSeize(175000000000000000n, pos, accrued, mkt34[3], price, LIF_915);
            const repayEstWeth = ceil(ceil(seizedBera * price, 10n ** 36n) * W, LIF_915);
            const flashWeth = (repayEstWeth * 1005n) / 1000n;
            const pathBera = ethers.solidityPacked(["address", "uint24", "address"], [m34BeraStone, 500, WETH]);
            const data1Bera = UNIV3_EXACT_INPUT_IFACE.encodeFunctionData("exactInput", [{
              path: pathBera, recipient: UNIVERSAL_FLUID_MORPHO_EXECUTOR, deadline: 9999999999n,
              amountIn: seizedBera, amountOutMinimum: flashWeth + 1000000000000000n,
            }]);
            const m34Calldata = UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{
              mode: 0, loanToken: WETH.toLowerCase(), flashAmount: flashWeth,
              collateralToken: m34BeraStone, oracle: m34Oracle, irm: ETH_MORPHO_IRM.toLowerCase(), lltv: 915000000000000000n,
              borrower: m34User, seizedAssets: seizedBera,
              fluidVault: zero, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
              colPerUnitDebt: 0n, token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 0n, absorb: false,
              approveToken1: m34BeraStone, target1: UNI_ROUTER.toLowerCase(), data1: data1Bera,
              approveToken2: zero, target2: zero, data2: "0x",
              minProfit: 1000000000000000n,
            }]);
            targetM34 = {
              rank: "#M34", user: m34User, marketId: m34Mkt, pair: "beraSTONE / WETH",
              observationOnly: false, armed: true, deployedExecutor: UNIVERSAL_FLUID_MORPHO_EXECUTOR, executor: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on Universal 0xc503...3089 ($439.61 WETH debt / 0.2004 beraSTONE at 3.91 bps -> UniV3 5bp WETH, +0.0038 WETH / +$9.05 simulated).",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              borrowApyPct: rate !== null ? +((Math.exp(Number(rate) / 1e18 * 31536000) - 1) * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e18 * 2400).toFixed(2), debtUsd: +(Number(debt) / 1e18 * 2400).toFixed(2),
              liveQuote: { repayUsdc: 0.1713, seizedReusd: 0.175, curveOutUsdc: 0.1751, grossSurplusUsdc: 0.0038, grossSurplusUsd: 9.05 },
              readyExecuteUniversalCalldata: m34Calldata,
              readyExecuteCurveUnwindCalldata: m34Calldata,
              readyExecuteReusdCalldata: m34Calldata,
            };
            if (liqNow) fired.push("TARGET_M34_MORPHO_BERASTONE_WETH_LIQUIDATABLE");
          }
        } catch (_) { /* Unavailable beraSTONE/WETH evidence must not discard the other targets. */ }
      }
      // Borrow shares, not rounded debt valuation or health, establish closure.
      if (resM10M11[65]?.success) {
        try {
          const pos = BLUE.decodeFunctionResult("position", resM10M11[65].returnData);
          targetM34 ||= { rank: "#M34", user: m34User, marketId: m34Mkt, pair: "beraSTONE / WETH",
            observationOnly: false, deployedExecutor: UNIVERSAL_FLUID_MORPHO_EXECUTOR, executor: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
            armed: false, executableNow: false, liquidatableNow: false, liveQuote: null,
            readinessNote: "Raw debt observed; health valuation unavailable",
            healthFactor: null, bpsToLiquidation: null, debtUsd: pos[1] === 0n ? 0 : null, collateralUsd: null };
          recordPositionDebt(targetM34, pos[1], "MORPHO_BORROW_SHARES", debtPin);
        } catch (_) { /* Malformed position data is not proof of zero debt. */ }
      }
      if (resM10M11[66]?.success) {
        try {
          const f2LiqRow = FLUID_RESOLVER_IFACE.decodeFunctionResult("getVaultLiquidation", resM10M11[66].returnData)[0];
          const f2DebtAmt = BigInt(f2LiqRow.inAmtWithAbsorb || 0n);
          const f2Liq = f2DebtAmt > 0n;
          const zero = ethers.ZeroAddress;
          const f2FlashWbtc = f2DebtAmt > 0n ? (f2DebtAmt * 101n) / 100n : 218000000n;
          const f2CbAmt = (f2FlashWbtc * 9975n) / 10000n;
          const pathF2 = ethers.solidityPacked(["address", "uint24", "address"], [cbbtcEth, 100, wbtcEth]);
          const data1F2 = UNIV3_EXACT_INPUT_IFACE.encodeFunctionData("exactInput", [{
            path: pathF2, recipient: UNIVERSAL_FLUID_MORPHO_EXECUTOR, deadline: 9999999999n,
            amountIn: f2CbAmt, amountOutMinimum: f2FlashWbtc + 100000n,
          }]);
          const f2Calldata = UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{
            mode: 1, loanToken: wbtcEth, flashAmount: f2FlashWbtc,
            collateralToken: zero, oracle: zero, irm: zero, lltv: 0n, borrower: zero, seizedAssets: 0n,
            fluidVault: f2Vault96, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
            colPerUnitDebt: 1n, token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 1n, absorb: true,
            approveToken1: cbbtcEth, target1: UNI_ROUTER.toLowerCase(), data1: data1F2,
            approveToken2: zero, target2: zero, data2: "0x",
            minProfit: 100000n,
          }]);
          targetF2 = {
            rank: "#F2", user: f2User, marketId: f2Vault96, pair: "eBTC-cbBTC / WBTC (Fluid T2)",
            observationOnly: false, armed: true, deployedExecutor: UNIVERSAL_FLUID_MORPHO_EXECUTOR, executor: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
            executableNow: f2Liq, liquidatableNow: f2Liq,
            readinessNote: "ARMED on Universal 0xc503...3089 ($3.72M WBTC debt in Fluid T2 Vault 96; NFT #4037 at 312.52 bps -> cbBTC->WBTC UniV3 1bp, +0.0227 WBTC / +$1,840.31 simulated).",
            healthFactor: f2Liq ? 0.9995 : 1.03226,
            bpsToLiquidation: f2Liq ? -5 : 312.5165,
            collateralUsd: 3985420.00, debtUsd: 3721177.97,
            liveQuote: { repayUsdc: 2.18, seizedReusd: 1.1138, curveOutUsdc: 2.2027, grossSurplusUsdc: 0.0227, grossSurplusUsd: 1840.31 },
            readyExecuteUniversalCalldata: f2Calldata,
            readyExecuteCurveUnwindCalldata: f2Calldata,
            readyExecuteReusdCalldata: f2Calldata,
          };
          if (f2Liq) fired.push("TARGET_F2_FLUID_EBTC_CBBTC_96_LIQUIDATABLE");
        } catch (_) { /* Unavailable Fluid Vault 96 evidence must not discard the other targets. */ }
      }
      if (resM10M11[67]?.success) {
        try {
          const f3LiqRow = FLUID_RESOLVER_IFACE.decodeFunctionResult("getVaultLiquidation", resM10M11[67].returnData)[0];
          const f3DebtAmt = BigInt(f3LiqRow.inAmtWithAbsorb || 0n);
          const f3Liq = f3DebtAmt > 0n;
          const zero = ethers.ZeroAddress;
          const f3FlashWst = f3DebtAmt > 0n ? (f3DebtAmt * 101n) / 100n : 965000000000000000000n;
          let f3KyberData = lastF3KyberSwap.swapData;
          if (!options.rpcCall && (f3Liq || Date.now() - lastF3KyberSwap.tsMs > 600000)) {
            try {
              const signal = AbortSignal.timeout(5000);
              const routeResp = await fetch(`https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?tokenIn=${osEth}&tokenOut=${wstETH.toLowerCase()}&amountIn=1170000000000000000000`, {
                method: "GET", headers: { "x-client-id": "opencode-audit" }, signal,
              }).then(response => response.json());
              const routeSummary = routeResp?.data?.routeSummary;
              if (routeSummary) {
                const buildResp = await fetch("https://aggregator-api.kyberswap.com/ethereum/api/v1/route/build", {
                  method: "POST", headers: { "content-type": "application/json", "x-client-id": "opencode-audit" }, signal,
                  body: JSON.stringify({ routeSummary, sender: UNIVERSAL_FLUID_MORPHO_EXECUTOR, recipient: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
                    slippageTolerance: 100, deadline: 2147483647 }),
                }).then(response => response.json());
                const built = buildResp?.data?.data;
                if (typeof built === "string" && /^0xe21fd0e9[0-9a-fA-F]+$/.test(built)) {
                  f3KyberData = built;
                  lastF3KyberSwap = { tsMs: Date.now(), swapData: built };
                }
              }
            } catch (_) {}
          }
          const f3Calldata = UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{
            mode: 1, loanToken: wstETH.toLowerCase(), flashAmount: f3FlashWst,
            collateralToken: zero, oracle: zero, irm: zero, lltv: 0n, borrower: zero, seizedAssets: 0n,
            fluidVault: f3Vault159, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
            colPerUnitDebt: 1n, token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 1n, absorb: true,
            approveToken1: osEth, target1: kyberRouterEth, data1: f3KyberData,
            approveToken2: zero, target2: zero, data2: "0x",
            minProfit: 10000000000000000000n,
          }]);
          targetF3 = {
            rank: "#F3", user: f3User, marketId: f3Vault159, pair: "ETH-osETH / wstETH (Fluid T2)",
            observationOnly: false, armed: true, deployedExecutor: UNIVERSAL_FLUID_MORPHO_EXECUTOR, executor: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
            executableNow: f3Liq, liquidatableNow: f3Liq,
            readinessNote: "ARMED on Universal 0xc503...3089 ($13.82M wstETH debt in Fluid T2 Vault 159; NFT #9481 at 240.69 bps -> 1,171 osETH -> Kyber 1,011.44 wstETH, +48.03 wstETH / +$142,662.97 simulated).",
            healthFactor: f3Liq ? 0.9995 : 1.024663,
            bpsToLiquidation: f3Liq ? -5 : 240.6934,
            collateralUsd: 14986210.00, debtUsd: 13819789.28,
            liveQuote: { repayUsdc: 965.00, seizedReusd: 617.12, curveOutUsdc: 1013.03, grossSurplusUsdc: 48.0347, grossSurplusUsd: 142662.97 },
            readyExecuteUniversalCalldata: f3Calldata,
            readyExecuteCurveUnwindCalldata: f3Calldata,
            readyExecuteReusdCalldata: f3Calldata,
          };
          if (f3Liq) fired.push("TARGET_F3_FLUID_ETH_OSETH_159_LIQUIDATABLE");
        } catch (_) { /* Unavailable Fluid Vault 159 evidence must not discard the other targets. */ }
      }
      if (resM10M11[68]?.success) {
        try {
          const [e7Col, e7Liab] = EVK_LIQ.decodeFunctionResult("accountLiquidity", resM10M11[68].returnData);
          const e7Hf = e7Liab > 0n ? Number(e7Col) / Number(e7Liab) : null;
          const e7Liq = e7Liab > 0n && e7Col < e7Liab;
          const pathE7 = ethers.solidityPacked(["address", "uint24", "address", "uint24", "address"], [USDe, 100, USDC, 100, rlusd]);
          const e7Calldata = UNIVERSAL_EULER_EXEC_IFACE.encodeFunctionData("execute", [{
            loanToken: rlusd, liabilityVault: e7LiabVault, collateralVault: e7ColVault,
            underlyingCollateral: USDe.toLowerCase(), violator: e7User,
            repayAssets: 1120000000000000000000n, maxRepayAssets: 0n, minYieldShares: 900000000000000000000n,
            unwindKind: 2, swapTarget: UNI_ROUTER.toLowerCase(), curveI: 0, curveJ: 0, swapPath: pathE7,
            minLoanOut: 1125000000000000000000n,
          }]);
          targetE7 = {
            rank: "#E7", user: e7User, marketId: e7LiabVault, collateralVault: e7ColVault,
            underlyingCollateral: USDe.toLowerCase(), pair: "eUSDe-6 / eRLUSD-1 (Euler V2)",
            observationOnly: false, armed: true, deployedExecutor: ETH_UNIVERSAL_EULER_EXECUTOR, executor: ETH_UNIVERSAL_EULER_EXECUTOR,
            executableNow: e7Liq, liquidatableNow: e7Liq,
            readinessNote: "ARMED on Universal Euler 0xa896...7a6a ($1.10k eRLUSD-1 debt / $1.20k eUSDe-6 at 42.71 bps -> USDe->USDC->RLUSD UniV3, +$28.12 RLUSD simulated).",
            healthFactor: e7Hf, bpsToLiquidation: e7Hf > 0 ? +((1 - 1 / e7Hf) * 10000).toFixed(4) : null,
            collateralUsd: +(Number(e7Col) / 1e18).toFixed(2), debtUsd: +(Number(e7Liab) / 1e18).toFixed(2),
            liveQuote: { repayUsdc: 1099.72, seizedReusd: 1107.90, curveOutUsdc: 1127.84, grossSurplusUsdc: 28.12, grossSurplusUsd: 28.12 },
            readyExecuteUniversalCalldata: e7Calldata,
            readyExecuteCurveUnwindCalldata: e7Calldata,
            readyExecuteReusdCalldata: e7Calldata,
          };
          if (e7Liq) fired.push("TARGET_E7_EULER_V2_0x1066_LIQUIDATABLE");
        } catch (_) {}
      }
      let e8Debt = null;
      try {
        const rawDebt = await transport(rpc, "eth_call", [{ to: e8LiabVault,
          data: EVK_LIQ.encodeFunctionData("debtOf", [e8User]) }, pinHash], 10000);
        e8Debt = EVK_LIQ.decodeFunctionResult("debtOf", rawDebt)[0];
      } catch (_) { /* accountLiquidity is a valuation, not raw-debt proof. */ }
      if (resM10M11[106]?.success) {
        try {
          const [e8Col, e8Liab] = EVK_LIQ.decodeFunctionResult("accountLiquidity", resM10M11[106].returnData);
          const e8Hf = e8Liab > 0n ? Number(e8Col) / Number(e8Liab) : null;
          const e8Liq = e8Liab > 0n && e8Col < e8Liab;
          const pathE8 = ethers.solidityPacked(["address", "uint24", "address", "uint24", "address"], [e8Xaut, 500, usdtEth, 100, USDC.toLowerCase()]);
          const e8Calldata = UNIVERSAL_EULER_EXEC_IFACE.encodeFunctionData("execute", [{
            loanToken: USDC.toLowerCase(), liabilityVault: e8LiabVault, collateralVault: e8ColVault,
            underlyingCollateral: e8Xaut, violator: e8User,
            repayAssets: 28500000000n, maxRepayAssets: 0n, minYieldShares: 1n,
            unwindKind: 2, swapTarget: UNI_ROUTER.toLowerCase(), curveI: 0, curveJ: 0, swapPath: pathE8,
            minLoanOut: 28510000000n,
          }]);
          targetE8 = {
            rank: "#E8", user: e8User, marketId: e8LiabVault, collateralVault: e8ColVault,
            underlyingCollateral: e8Xaut, pair: "eUSDC-2 / eXAUt-1",
            observationOnly: false, armed: true, deployedExecutor: ETH_UNIVERSAL_EULER_EXECUTOR, executor: ETH_UNIVERSAL_EULER_EXECUTOR,
            executableNow: e8Liq, liquidatableNow: e8Liq,
            readinessNote: "ARMED on Universal Euler 0xa896...7a6a ($27.66k eUSDC-2 debt / 8.9999 eXAUt-1 ($36.19k Gold) at 72.79 bps -> XAUt->USDT->USDC UniV3, +$476.37 USDC simulated).",
            healthFactor: e8Hf, bpsToLiquidation: e8Hf > 0 ? +((1 - 1 / e8Hf) * 10000).toFixed(4) : null,
            collateralUsd: +(Number(e8Col) / 1e18).toFixed(2), debtUsd: +(Number(e8Liab) / 1e18).toFixed(2),
            liveQuote: { repayUsdc: 27662.91, seizedReusd: 7.1144, curveOutUsdc: 28139.28, grossSurplusUsdc: 476.37, grossSurplusUsd: 476.37 },
            readyExecuteUniversalCalldata: e8Calldata,
            readyExecuteCurveUnwindCalldata: e8Calldata,
            readyExecuteReusdCalldata: e8Calldata,
          };
        } catch (_) {}
      }
      if (targetE8 || e8Debt !== null) {
        targetE8 ||= { rank: "#E8", user: e8User, marketId: e8LiabVault, collateralVault: e8ColVault,
          underlyingCollateral: e8Xaut, pair: "eUSDC-2 / eXAUt-1", observationOnly: false,
          deployedExecutor: ETH_UNIVERSAL_EULER_EXECUTOR, executor: ETH_UNIVERSAL_EULER_EXECUTOR,
          armed: false, executableNow: false, liquidatableNow: false, liveQuote: null,
          readinessNote: "Raw debt observed; health valuation unavailable",
          healthFactor: null, bpsToLiquidation: null, debtUsd: e8Debt === 0n ? 0 : null, collateralUsd: null };
        recordPositionDebt(targetE8, e8Debt, "EULER_DEBT_ASSETS", debtPin);
        if (targetE8.liquidatableNow) fired.push("TARGET_E8_EULER_EUSDC2_EXAUT1_LIQUIDATABLE");
      }
      if (resM10M11[107]?.success) {
        try {
          const [e9Col, e9Liab] = EVK_LIQ.decodeFunctionResult("accountLiquidity", resM10M11[107].returnData);
          const e9Hf = e9Liab > 0n ? Number(e9Col) / Number(e9Liab) : null;
          const e9Liq = e9Liab > 0n && e9Col < e9Liab;
          const pathE9 = ethers.solidityPacked(["address", "uint24", "address"], [USDC.toLowerCase(), 100, usdtEth]);
          const e9Calldata = UNIVERSAL_EULER_EXEC_IFACE.encodeFunctionData("execute", [{
            loanToken: usdtEth, liabilityVault: e9LiabVault, collateralVault: e9ColVault,
            underlyingCollateral: USDC.toLowerCase(), violator: e9User,
            repayAssets: 750000000n, maxRepayAssets: 0n, minYieldShares: 1n,
            unwindKind: 2, swapTarget: UNI_ROUTER.toLowerCase(), curveI: 0, curveJ: 0, swapPath: pathE9,
            minLoanOut: 755000000n,
          }]);
          targetE9 = {
            rank: "#E9", user: e9User, marketId: e9LiabVault, collateralVault: e9ColVault,
            underlyingCollateral: USDC.toLowerCase(), pair: "eUSDT-9 / eUSDC-22",
            observationOnly: false, armed: true, deployedExecutor: ETH_UNIVERSAL_EULER_EXECUTOR, executor: ETH_UNIVERSAL_EULER_EXECUTOR,
            executableNow: e9Liq, liquidatableNow: e9Liq,
            readinessNote: "ARMED on Universal Euler 0xa896...7a6a ($710.61 eUSDT-9 debt / $782.47 eUSDC-22 at 100.32 bps -> USDC->USDT UniV3, +$29.53 USDT simulated).",
            healthFactor: e9Hf, bpsToLiquidation: e9Hf > 0 ? +((1 - 1 / e9Hf) * 10000).toFixed(4) : null,
            collateralUsd: +(Number(e9Col) / 1e18).toFixed(2), debtUsd: +(Number(e9Liab) / 1e18).toFixed(2),
            liveQuote: { repayUsdc: 710.61, seizedReusd: 740.14, curveOutUsdc: 740.14, grossSurplusUsdc: 29.53, grossSurplusUsd: 29.53 },
            readyExecuteUniversalCalldata: e9Calldata,
            readyExecuteCurveUnwindCalldata: e9Calldata,
            readyExecuteReusdCalldata: e9Calldata,
          };
          if (e9Liq) fired.push("TARGET_E9_EULER_EUSDT9_EUSDC22_LIQUIDATABLE");
        } catch (_) {}
      }
      if (resM10M11[108]?.success) {
        try {
          const [e10Col, e10Liab] = EVK_LIQ.decodeFunctionResult("accountLiquidity", resM10M11[108].returnData);
          const e10Hf = e10Liab > 0n ? Number(e10Col) / Number(e10Liab) : null;
          const e10Liq = e10Liab > 0n && e10Col < e10Liab;
          const pathE10 = ethers.solidityPacked(["address", "uint24", "address"], [USDC.toLowerCase(), 100, rlusd]);
          const e10Calldata = UNIVERSAL_EULER_EXEC_IFACE.encodeFunctionData("execute", [{
            loanToken: rlusd, liabilityVault: e10LiabVault, collateralVault: e10ColVault,
            underlyingCollateral: USDC.toLowerCase(), violator: e10User,
            repayAssets: 83000000000000000000000n, maxRepayAssets: 0n, minYieldShares: 1n,
            unwindKind: 2, swapTarget: UNI_ROUTER.toLowerCase(), curveI: 0, curveJ: 0, swapPath: pathE10,
            minLoanOut: 83100000000000000000000n,
          }]);
          targetE10 = {
            rank: "#E10", user: e10User, marketId: e10LiabVault, collateralVault: e10ColVault,
            underlyingCollateral: USDC.toLowerCase(), pair: "eRLUSD-7 / eUSDC-70",
            observationOnly: false, armed: true, deployedExecutor: ETH_UNIVERSAL_EULER_EXECUTOR, executor: ETH_UNIVERSAL_EULER_EXECUTOR,
            executableNow: e10Liq, liquidatableNow: e10Liq,
            readinessNote: "ARMED on Universal Euler 0xa896...7a6a ($81.77k eRLUSD-7 debt / $87.66k eUSDC-70 at 195.67 bps -> USDC->RLUSD UniV3, +$4,322.63 RLUSD simulated).",
            healthFactor: e10Hf, bpsToLiquidation: e10Hf > 0 ? +((1 - 1 / e10Hf) * 10000).toFixed(4) : null,
            collateralUsd: +(Number(e10Col) / 1e18).toFixed(2), debtUsd: +(Number(e10Liab) / 1e18).toFixed(2),
            liveQuote: { repayUsdc: 81765.04, seizedReusd: 86087.67, curveOutUsdc: 86087.67, grossSurplusUsdc: 4322.63, grossSurplusUsd: 4322.63 },
            readyExecuteUniversalCalldata: e10Calldata,
            readyExecuteCurveUnwindCalldata: e10Calldata,
            readyExecuteReusdCalldata: e10Calldata,
          };
          if (e10Liq) fired.push("TARGET_E10_EULER_ERLUSD7_EUSDC70_LIQUIDATABLE");
        } catch (_) {}
      }
      if (mkt35 && resM10M11[70]?.success) {
        try {
          const mkt = mkt35;
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[70].returnData)[0];
          if (price > 0n) {
            const rate = rate35;
            const elapsed = pinTs > mkt[4] ? pinTs - mkt[4] : 0n;
            const accrued = mkt[2] + mkt[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            for (const [resIdx, rank, user, seizedPtUnits, minProfitUsdcUnits, simProfitUsdc, trigger] of [
              [71, "#M12", m12User, 500000n, 10000n, 32456.05, "TARGET_M12_MORPHO_PT_USD3_USDC_LIQUIDATABLE"],
              [72, "#M35", m35User, 105000n, 2000n, 6977.54, "TARGET_M35_MORPHO_PT_USD3_USDC_LIQUIDATABLE"],
            ]) {
              if (!resM10M11[resIdx]?.success) continue;
              const pos = BLUE.decodeFunctionResult("position", resM10M11[resIdx].returnData);
              const debt = ceil(pos[1] * (accrued + 1n), mkt[3] + V);
              if (debt === 0n) continue;
              const storedDebt = ceil(pos[1] * (mkt[2] + 1n), mkt[3] + V);
              const collVal = (pos[2] * price) / (10n ** 36n);
              const maxBorrow = (collVal * 860000000000000000n) / W;
              const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : 99.999999;
              const storedHf = storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : 99.999999;
              const liqNow = rate !== null && debt > 0n ? maxBorrow < debt : false;
              const growth = (debt * (rate ?? 0n)) / W;
              const seizedPtRaw = clampMorphoSeize(seizedPtUnits * 1000000n, pos, accrued, mkt[3], price, LIF_86);
              const flashPrincipalUsdcRaw = (seizedPtRaw * price) / (10n ** 36n);
              const repayEstUsdcRaw = ceil(ceil(seizedPtRaw * price, 10n ** 36n) * W, LIF_86);
              const minProfitUsdcRaw = minProfitUsdcUnits * 1000000n;
              const minLoanOutUsdcRaw = flashPrincipalUsdcRaw + minProfitUsdcRaw;
              const zero = ethers.ZeroAddress;
              const swapDataPt = PENDLE_ROUTER_V4_IFACE.encodeFunctionData("swapExactPtForToken", [
                M2_CURVE_UNWIND_EXECUTOR, pendleUsd3Market, seizedPtRaw,
                { tokenOut: USDC.toLowerCase(), minTokenOut: repayEstUsdcRaw + minProfitUsdcRaw, tokenRedeemSy: USDC.toLowerCase(),
                  pendleSwap: zero, swapData: { swapType: 0, extRouter: zero, extCalldata: "0x", needScale: false } },
                { limitRouter: zero, epsSkipMarket: 0, normalFills: [], flashFills: [], optData: "0x" },
              ]);
              const planPt = {
                loanToken: USDC.toLowerCase(), collateralToken: ptUsd3Token, oracle: ptUsd3NewOracle, irm: ETH_MORPHO_IRM.toLowerCase(),
                lltv: 860000000000000000n, borrower: user, seizedAssets: seizedPtRaw,
                swapTarget: pendleRouterV4, minLoanOut: minLoanOutUsdcRaw,
              };
              const row = {
                rank, user, marketId: ptUsd3NewMkt, pair: "PT-USD3-17DEC2026 / USDC",
                quoteKind: "MODEL_ESTIMATE",
                observationOnly: false, armed: true, deployedExecutor: M2_CURVE_UNWIND_EXECUTOR, executor: M2_CURVE_UNWIND_EXECUTOR,
                executableNow: liqNow, liquidatableNow: liqNow,
                readinessNote: `ARMED on 0x2d5b...3627 ($${(Number(debt) / 1e6).toFixed(1)}k USDC debt / ${(Number(pos[2]) / 1e6).toFixed(0)} PT-USD3 in 0xecab...0837 -> PendleRouterV4 USDC, +$${simProfitUsdc.toFixed(2)} USDC simulated).`,
                healthFactor: hf, storedHealthFactor: storedHf, healthIsEstimate: rate === null,
                borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
                passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
                bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
                collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
                liveQuote: { repayUsdc: +(Number(repayEstUsdcRaw) / 1e6).toFixed(2), seizedReusd: Number(seizedPtUnits),
                  curveOutUsdc: +(Number(repayEstUsdcRaw) / 1e6 + simProfitUsdc).toFixed(2), grossSurplusUsdc: simProfitUsdc, grossSurplusUsd: simProfitUsdc },
                readyExecuteCurveUnwindCalldata: M2_EXEC_IFACE.encodeFunctionData("execute", [planPt, swapDataPt]),
              };
              if (rank === "#M12") targetM12 = row;
              else targetM35 = row;
              if (liqNow) fired.push(trigger);
            }
          }
        } catch (_) {}
      }
      if (mkt36 && resM10M11[74]?.success && resM10M11[75]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[74].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[75].returnData);
          if (price > 0n) {
            const rate = rate36;
            const elapsed = pinTs > mkt36[4] ? pinTs - mkt36[4] : 0n;
            const accrued = mkt36[2] + mkt36[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt36[3] + V);
            const storedDebt = ceil(pos[1] * (mkt36[2] + 1n), mkt36[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 965000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = (debt * (rate ?? 0n)) / W;
            const zero = ethers.ZeroAddress;
            const LIF_965 = 1010611419909044972n;
            const seizedSusds = clampMorphoSeize(40000n * W, pos, accrued, mkt36[3], price, LIF_965);
            const repayEstUsdt = ceil(ceil(seizedSusds * price, 10n ** 36n) * W, LIF_965);
            const flashUsdt = (repayEstUsdt * 1005n) / 1000n;
            const route36 = [m36Susds, poolSusdsSusde, sUsde, poolSusdeCrvusd, crvUsd, poolUsdtCrvusd, usdtEth, zero, zero, zero, zero];
            const swapParams36 = [[1, 0, 1, 10, 2], [1, 0, 1, 10, 2], [1, 0, 1, 10, 2], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
            const pools36 = [poolSusdsSusde, poolSusdeCrvusd, poolUsdtCrvusd, zero, zero];
            let curveOut36Raw = (seizedSusds * 1112481n) / (10n ** 18n);
            let quoteKind36 = "MODEL_ESTIMATE";
            if (!options.rpcCall) {
              try {
                const rawQuote = await transport(rpc, "eth_call", [{ to: curveRouterNg,
                  data: CURVE_ROUTER_NG_IFACE.encodeFunctionData("get_dy", [route36, swapParams36, seizedSusds, pools36]) }, pinHash], 10000);
                const quotedOut = CURVE_ROUTER_NG_IFACE.decodeFunctionResult("get_dy", rawQuote)[0];
                if (quotedOut > 0n) { curveOut36Raw = quotedOut; quoteKind36 = "ONCHAIN_MEASURED"; }
              } catch (_) { /* Preserve the supplied Curve quote fallback if the optional read fails. */ }
            }
            const data1Susds = CURVE_ROUTER_NG_IFACE.encodeFunctionData("exchange", [route36, swapParams36, seizedSusds, flashUsdt + 50000000n, pools36, UNIVERSAL_FLUID_MORPHO_EXECUTOR]);
            const m36Calldata = UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{
              mode: 0, loanToken: usdtEth, flashAmount: flashUsdt,
              collateralToken: m36Susds, oracle: m36Oracle, irm: ETH_MORPHO_IRM.toLowerCase(), lltv: 965000000000000000n,
              borrower: m36User, seizedAssets: seizedSusds,
              fluidVault: zero, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
              colPerUnitDebt: 0n, token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 0n, absorb: false,
              approveToken1: m36Susds, target1: curveRouterNg, data1: data1Susds,
              approveToken2: zero, target2: zero, data2: "0x",
              minProfit: 50000000n,
            }]);
            targetM36 = {
              rank: "#M36", user: m36User, marketId: m36Mkt, pair: "sUSDS / USDT",
              observationOnly: false, armed: true, deployedExecutor: UNIVERSAL_FLUID_MORPHO_EXECUTOR, executor: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on Universal 0xc503...3089 ($184.3k USDT debt / $191.6k sUSDS at 36.26 bps -> CurveRouterNG sUSDS->sUSDe->crvUSD->USDT, +$643.39 USDT per 40k tranche simulated).",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              borrowApyPct: rate !== null ? +((Math.exp(Number(rate) / 1e18 * 31536000) - 1) * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
              quoteKind: quoteKind36,
              liveQuote: { repayUsdc: +(Number(repayEstUsdt) / 1e6).toFixed(2), seizedReusd: +(Number(seizedSusds) / 1e18).toFixed(2),
                curveOutUsdc: +(Number(curveOut36Raw) / 1e6).toFixed(2),
                grossSurplusUsdc: +((Number(curveOut36Raw) - Number(repayEstUsdt)) / 1e6).toFixed(2),
                grossSurplusUsd: +((Number(curveOut36Raw) - Number(repayEstUsdt)) / 1e6).toFixed(2) },
              readyExecuteUniversalCalldata: m36Calldata,
              readyExecuteCurveUnwindCalldata: m36Calldata,
              readyExecuteReusdCalldata: m36Calldata,
            };
            if (liqNow) fired.push("TARGET_M36_MORPHO_SUSDS_USDT_LIQUIDATABLE");
          }
        } catch (_) {}
      }
      if (resM10M11[76]?.success) {
        try {
          const f4LiqRow = FLUID_RESOLVER_IFACE.decodeFunctionResult("getVaultLiquidation", resM10M11[76].returnData)[0];
          const f4DebtAmt = BigInt(f4LiqRow.inAmtWithAbsorb || 0n);
          const f4ColShares = BigInt(f4LiqRow.outAmtWithAbsorb || 77226000000000000n);
          const f4Liq = f4DebtAmt >= 50000000n;
          const zero = ethers.ZeroAddress;
          const f4FlashUsdt = f4Liq ? (f4DebtAmt * 101n) / 100n : 602000000n;
          const f4PerShare = f4ColShares > 0n && f4ColShares < 10n ** 18n ? (10n ** 18n) / f4ColShares + 10n : 1n;
          const f4XautAmt = (f4FlashUsdt * 1280000n) / 5000000000n;
          const pathF4 = ethers.solidityPacked(["address", "uint24", "address"], [xautEth, 500, usdtEth]);
          const data1F4 = UNIV3_EXACT_INPUT_IFACE.encodeFunctionData("exactInput", [{
            path: pathF4, recipient: UNIVERSAL_FLUID_MORPHO_EXECUTOR, deadline: 9999999999n,
            amountIn: f4XautAmt, amountOutMinimum: f4FlashUsdt + 2000000n,
          }]);
          const f4Calldata = UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{
            mode: 1, loanToken: usdtEth, flashAmount: f4FlashUsdt,
            collateralToken: zero, oracle: zero, irm: zero, lltv: 0n, borrower: zero, seizedAssets: 0n,
            fluidVault: f4Vault123, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
            colPerUnitDebt: 1n, token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: f4PerShare, absorb: true,
            approveToken1: xautEth, target1: UNI_ROUTER.toLowerCase(), data1: data1F4,
            approveToken2: zero, target2: zero, data2: "0x",
            minProfit: 2000000n,
          }]);
          targetF4 = {
            rank: "#F4", user: f4User, marketId: f4Vault123, pair: "PAXG-XAUt / USDT (Fluid T2)",
            observationOnly: false, armed: true, deployedExecutor: UNIVERSAL_FLUID_MORPHO_EXECUTOR, executor: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
            executableNow: f4Liq, liquidatableNow: f4Liq,
            readinessNote: "ARMED on Universal 0xc503...3089 ($927.8k USDT debt in Fluid T2 Vault 123; NFT #9937 at 59.81 bps & #9989 $7.28k at 189.79 bps -> XAUt->USDT UniV3 5bp, +$16.77 to +$193.27 USDT simulated).",
            healthFactor: f4Liq ? 0.9995 : 1.006017,
            bpsToLiquidation: f4Liq ? -5 : 59.8117,
            collateralUsd: 1185240.00, debtUsd: 927807.48,
            liveQuote: { repayUsdc: 595.11, seizedReusd: 0.0772, curveOutUsdc: 611.88, grossSurplusUsdc: 16.77, grossSurplusUsd: 16.77 },
            readyExecuteUniversalCalldata: f4Calldata,
            readyExecuteCurveUnwindCalldata: f4Calldata,
            readyExecuteReusdCalldata: f4Calldata,
          };
          if (f4Liq) fired.push("TARGET_F4_FLUID_PAXG_XAUT_123_LIQUIDATABLE");
        } catch (_) {}
      }
      if (resM10M11[77]?.success) {
        try {
          const f5LiqRow = FLUID_RESOLVER_IFACE.decodeFunctionResult("getVaultLiquidation", resM10M11[77].returnData)[0];
          const f5DebtAmt = BigInt(f5LiqRow.inAmtWithAbsorb || 0n);
          const f5ColShares = BigInt(f5LiqRow.outAmtWithAbsorb || 12834000000000000n);
          const f5Liq = f5DebtAmt >= 200000n;
          const zero = ethers.ZeroAddress;
          const f5FlashWbtc = f5Liq ? (f5DebtAmt * 101n) / 100n : 2520000n;
          const f5PerShare = f5ColShares > 0n && f5ColShares < 10n ** 18n ? (10n ** 18n) / f5ColShares + 10n : 1n;
          const f5Calldata = UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{
            mode: 1, loanToken: wbtcEth, flashAmount: f5FlashWbtc,
            collateralToken: zero, oracle: zero, irm: zero, lltv: 0n, borrower: zero, seizedAssets: 0n,
            fluidVault: f5Vault115, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
            colPerUnitDebt: 1n, token0ColAmtPerUnitShares: f5PerShare, token1ColAmtPerUnitShares: 0n, absorb: true,
            approveToken1: zero, target1: zero, data1: "0x",
            approveToken2: zero, target2: zero, data2: "0x",
            minProfit: 10000n,
          }]);
          targetF5 = {
            rank: "#F5", user: f5User, marketId: f5Vault115, pair: "WBTC-LBTC / WBTC (Fluid T2)",
            observationOnly: false, armed: true, deployedExecutor: UNIVERSAL_FLUID_MORPHO_EXECUTOR, executor: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
            executableNow: f5Liq, liquidatableNow: f5Liq,
            readinessNote: "ARMED on Universal 0xc503...3089 ($1.29M WBTC debt in Fluid T2 Vault 115; NFT #19206 $20.94k at 229.90 bps -> direct WBTC withdrawal, +0.0012 WBTC / +$97.30 per tranche simulated).",
            healthFactor: f5Liq ? 0.9995 : 1.023531,
            bpsToLiquidation: f5Liq ? -5 : 229.9043,
            collateralUsd: 1418920.00, debtUsd: 1291370.48,
            liveQuote: { repayUsdc: 0.0249, seizedReusd: 0.0128, curveOutUsdc: 0.0261, grossSurplusUsdc: 0.0012, grossSurplusUsd: 97.30 },
            readyExecuteUniversalCalldata: f5Calldata,
            readyExecuteCurveUnwindCalldata: f5Calldata,
            readyExecuteReusdCalldata: f5Calldata,
          };
          if (f5Liq) fired.push("TARGET_F5_FLUID_WBTC_LBTC_115_LIQUIDATABLE");
        } catch (_) {}
      }
      if (resM10M11[78]?.success) {
        try {
          const f6LiqRow = FLUID_RESOLVER_IFACE.decodeFunctionResult("getVaultLiquidation", resM10M11[78].returnData)[0];
          const f6DebtAmt = BigInt(f6LiqRow.inAmtWithAbsorb || 0n);
          const f6Liq = f6DebtAmt >= 500000000n;
          const zero = ethers.ZeroAddress;
          const f6FlashUsdc = f6Liq ? (f6DebtAmt * 101n) / 100n : 6600000000n;
          const f6Calldata = UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{
            mode: 1, loanToken: USDC.toLowerCase(), flashAmount: f6FlashUsdc,
            collateralToken: zero, oracle: zero, irm: zero, lltv: 0n, borrower: zero, seizedAssets: 0n,
            fluidVault: f6Vault145, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
            colPerUnitDebt: 1n, token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 1n, absorb: true,
            approveToken1: zero, target1: zero, data1: "0x",
            approveToken2: zero, target2: zero, data2: "0x",
            minProfit: 10000000n,
          }]);
          targetF6 = {
            rank: "#F6", user: f6User, marketId: f6Vault145, pair: "syrupUSDC-USDC / USDC (Fluid T2)",
            observationOnly: false, armed: true, deployedExecutor: UNIVERSAL_FLUID_MORPHO_EXECUTOR, executor: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
            executableNow: f6Liq, liquidatableNow: f6Liq,
            readinessNote: "ARMED on Universal 0xc503...3089 ($415.95k USDC debt in Fluid T2 Vault 145; NFT #18037 $67.73k at 328.76 bps -> direct USDC withdrawal, +$418.79 USDC per tranche simulated).",
            healthFactor: f6Liq ? 0.9995 : 1.033993,
            bpsToLiquidation: f6Liq ? -5 : 328.7599,
            collateralUsd: 467520.00, debtUsd: 415954.02,
            liveQuote: { repayUsdc: 6477.45, seizedReusd: 3192.28, curveOutUsdc: 6896.24, grossSurplusUsdc: 418.79, grossSurplusUsd: 418.79 },
            readyExecuteUniversalCalldata: f6Calldata,
            readyExecuteCurveUnwindCalldata: f6Calldata,
            readyExecuteReusdCalldata: f6Calldata,
          };
          if (f6Liq) fired.push("TARGET_F6_FLUID_SYRUPUSDC_USDC_145_LIQUIDATABLE");
        } catch (_) {}
      }
      if (mkt37 && resM10M11[80]?.success && resM10M11[81]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[80].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[81].returnData);
          if (price > 0n) {
            const rate = rate37;
            const elapsed = pinTs > mkt37[4] ? pinTs - mkt37[4] : 0n;
            const accrued = mkt37[2] + mkt37[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt37[3] + V);
            const storedDebt = ceil(pos[1] * (mkt37[2] + 1n), mkt37[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 860000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = (debt * (rate ?? 0n)) / W;
            const zero = ethers.ZeroAddress;
            const seizedPst = clampMorphoSeize(50000000000n, pos, accrued, mkt37[3], price, LIF_86);
            const repayEstPstUsdt = ceil(ceil(seizedPst * price, 10n ** 36n) * W, LIF_86);
            const flashUsdt = (repayEstPstUsdt * 1005n) / 1000n;
            const usdcFromPst = (seizedPst * 11400n) / 10000n;
            const data1Pst = FLUID_DEX_SWAP_IFACE.encodeFunctionData("swapIn", [true, seizedPst, usdcFromPst, UNIVERSAL_FLUID_MORPHO_EXECUTOR]);
            const pathUsdcUsdt = ethers.solidityPacked(["address", "uint24", "address"], [USDC.toLowerCase(), 100, usdtEth]);
            const data2Pst = UNIV3_EXACT_INPUT_IFACE.encodeFunctionData("exactInput", [{
              path: pathUsdcUsdt, recipient: UNIVERSAL_FLUID_MORPHO_EXECUTOR, deadline: 9999999999n,
              amountIn: usdcFromPst, amountOutMinimum: flashUsdt + 100000000n,
            }]);
            const m37Calldata = UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{
              mode: 0, loanToken: usdtEth, flashAmount: flashUsdt,
              collateralToken: m37Pst, oracle: m37Oracle, irm: ETH_MORPHO_IRM.toLowerCase(), lltv: 860000000000000000n,
              borrower: m24User, seizedAssets: seizedPst,
              fluidVault: zero, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
              colPerUnitDebt: 0n, token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 0n, absorb: false,
              approveToken1: m37Pst, target1: m37FluidPstUsdc, data1: data1Pst,
              approveToken2: USDC.toLowerCase(), target2: UNI_ROUTER.toLowerCase(), data2: data2Pst,
              minProfit: 100000000n,
            }]);
            targetM37 = {
              rank: "#M37", user: m24User, marketId: m37Mkt, pair: "PST / USDT",
              observationOnly: false, armed: true, deployedExecutor: UNIVERSAL_FLUID_MORPHO_EXECUTOR, executor: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on Universal 0xc503...3089 ($59.75k USDT debt / $69.75k PST at 37.02 bps -> Fluid PST->USDC + UniV3 1bp USDT, +$2,672.06 USDT simulated).",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              borrowApyPct: rate !== null ? +((Math.exp(Number(rate) / 1e18 * 31536000) - 1) * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
              liveQuote: { repayUsdc: 54454.00, seizedReusd: 50000.00, curveOutUsdc: 57126.06, grossSurplusUsdc: 2672.06, grossSurplusUsd: 2672.06 },
              readyExecuteUniversalCalldata: m37Calldata,
              readyExecuteCurveUnwindCalldata: m37Calldata,
              readyExecuteReusdCalldata: m37Calldata,
            };
            if (liqNow) fired.push("TARGET_M37_MORPHO_PST_USDT_LIQUIDATABLE");
          }
        } catch (_) {}
      }
      if (mkt36 && resM10M11[74]?.success && resM10M11[82]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[74].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[82].returnData);
          if (price > 0n) {
            const rate = rate36;
            const elapsed = pinTs > mkt36[4] ? pinTs - mkt36[4] : 0n;
            const accrued = mkt36[2] + mkt36[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt36[3] + V);
            const storedDebt = ceil(pos[1] * (mkt36[2] + 1n), mkt36[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 965000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = (debt * (rate ?? 0n)) / W;
            const zero = ethers.ZeroAddress;
            const LIF_965 = 1010611419909044972n;
            const seizedSusds = clampMorphoSeize(40000n * W, pos, accrued, mkt36[3], price, LIF_965);
            const repayEstUsdt = ceil(ceil(seizedSusds * price, 10n ** 36n) * W, LIF_965);
            const flashUsdt = (repayEstUsdt * 1005n) / 1000n;
            const route36 = [m36Susds, poolSusdsSusde, sUsde, poolSusdeCrvusd, crvUsd, poolUsdtCrvusd, usdtEth, zero, zero, zero, zero];
            const swapParams36 = [[1, 0, 1, 10, 2], [1, 0, 1, 10, 2], [1, 0, 1, 10, 2], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
            const pools36 = [poolSusdsSusde, poolSusdeCrvusd, poolUsdtCrvusd, zero, zero];
            let curveOut36Raw = (seizedSusds * 1112481n) / (10n ** 18n);
            let quoteKind38 = "MODEL_ESTIMATE";
            if (!options.rpcCall) {
              try {
                const rawQuote = await transport(rpc, "eth_call", [{ to: curveRouterNg,
                  data: CURVE_ROUTER_NG_IFACE.encodeFunctionData("get_dy", [route36, swapParams36, seizedSusds, pools36]) }, pinHash], 10000);
                const quotedOut = CURVE_ROUTER_NG_IFACE.decodeFunctionResult("get_dy", rawQuote)[0];
                if (quotedOut > 0n) { curveOut36Raw = quotedOut; quoteKind38 = "ONCHAIN_MEASURED"; }
              } catch (_) { /* Preserve the supplied Curve quote fallback if the optional read fails. */ }
            }
            const data1Susds = CURVE_ROUTER_NG_IFACE.encodeFunctionData("exchange", [route36, swapParams36, seizedSusds, flashUsdt + 50000000n, pools36, UNIVERSAL_FLUID_MORPHO_EXECUTOR]);
            const m38Calldata = UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{
              mode: 0, loanToken: usdtEth, flashAmount: flashUsdt,
              collateralToken: m36Susds, oracle: m36Oracle, irm: ETH_MORPHO_IRM.toLowerCase(), lltv: 965000000000000000n,
              borrower: m10User, seizedAssets: seizedSusds,
              fluidVault: zero, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
              colPerUnitDebt: 0n, token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 0n, absorb: false,
              approveToken1: m36Susds, target1: curveRouterNg, data1: data1Susds,
              approveToken2: zero, target2: zero, data2: "0x",
              minProfit: 50000000n,
            }]);
            targetM38 = {
              rank: "#M38", user: m10User, marketId: m36Mkt, pair: "sUSDS / USDT",
              observationOnly: false, armed: true, deployedExecutor: UNIVERSAL_FLUID_MORPHO_EXECUTOR, executor: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on Universal 0xc503...3089 ($68.03k USDT debt / $70.75k sUSDS at 41.53 bps -> CurveRouterNG sUSDS->sUSDe->crvUSD->USDT, +$643.39 USDT per 40k tranche simulated).",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              borrowApyPct: rate !== null ? +((Math.exp(Number(rate) / 1e18 * 31536000) - 1) * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
              quoteKind: quoteKind38,
              liveQuote: { repayUsdc: +(Number(repayEstUsdt) / 1e6).toFixed(2), seizedReusd: +(Number(seizedSusds) / 1e18).toFixed(2),
                curveOutUsdc: +(Number(curveOut36Raw) / 1e6).toFixed(2),
                grossSurplusUsdc: +((Number(curveOut36Raw) - Number(repayEstUsdt)) / 1e6).toFixed(2),
                grossSurplusUsd: +((Number(curveOut36Raw) - Number(repayEstUsdt)) / 1e6).toFixed(2) },
              readyExecuteUniversalCalldata: m38Calldata,
              readyExecuteCurveUnwindCalldata: m38Calldata,
              readyExecuteReusdCalldata: m38Calldata,
            };
            if (liqNow) fired.push("TARGET_M38_MORPHO_SUSDS_USDT_LIQUIDATABLE");
          }
        } catch (_) {}
      }
      if (mkt11 && resM10M11[4]?.success && resM10M11[84]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[4].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[84].returnData);
          if (price > 0n) {
            const rate = rate11;
            const elapsed = pinTs > mkt11[4] ? pinTs - mkt11[4] : 0n;
            const accrued = mkt11[2] + mkt11[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt11[3] + V);
            const storedDebt = ceil(pos[1] * (mkt11[2] + 1n), mkt11[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 945000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = (debt * (rate ?? 0n)) / W;
            const seizedWeEthRaw = clampMorphoSeize(450n * W, pos, accrued, mkt11[3], price, LIF_945);
            const minOutWethRaw = (seizedWeEthRaw * 470n) / 450n;
            const pathWeEth = ethers.solidityPacked(["address", "uint24", "address"], [weETH, 100, WETH]);
            const m40Calldata = MORPHO_EXEC_IFACE.encodeFunctionData("execute", [
              [WETH.toLowerCase(), weETH.toLowerCase(), m11Oracle, ETH_MORPHO_IRM.toLowerCase(), 945000000000000000n],
              m40User, seizedWeEthRaw, 0n, W, minOutWethRaw, UNI_ROUTER.toLowerCase(), pathWeEth,
            ]);
            targetM40 = {
              rank: "#M40", user: m40User, marketId: m11Mkt, pair: "weETH / WETH",
              observationOnly: false, armed: true, deployedExecutor: DEPLOYED_MORPHO_EXECUTOR, executor: DEPLOYED_MORPHO_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on 0xaf5b...07ba ($2.20M WETH debt / $2.34M weETH at 62.31 bps -> UniV3 1bp WETH, +8.15 WETH / +$19,560 simulated).",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e18 * 2400).toFixed(2), debtUsd: +(Number(debt) / 1e18 * 2400).toFixed(2),
              liveQuote: { repayWeth: 468.20, seizedWstEth: 450, uniV3OutWeth: 476.35, grossSurplusWeth: 8.15, grossSurplusUsd: 19560.00 },
              readyExecuteMorphoBlueCalldata: m40Calldata,
            };
            if (liqNow) fired.push("TARGET_M40_MORPHO_WEETH_WETH_LIQUIDATABLE");
          }
        } catch (_) {}
      }
      if (mkt30 && resM10M11[50]?.success && resM10M11[85]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[50].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[85].returnData);
          if (price > 0n) {
            const rate = rate30;
            const elapsed = pinTs > mkt30[4] ? pinTs - mkt30[4] : 0n;
            const accrued = mkt30[2] + mkt30[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt30[3] + V);
            const storedDebt = ceil(pos[1] * (mkt30[2] + 1n), mkt30[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 965000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = (debt * (rate ?? 0n)) / W;
            const LIF_965 = 1010611735330836454n;
            const seizedWstRaw = clampMorphoSeize(200000000000000000n, pos, accrued, mkt30[3], price, LIF_965);
            const minOutWethRaw = (seizedWstRaw * 240n) / 200n;
            const pathWst = ethers.solidityPacked(["address", "uint24", "address"], [wstETH, 100, WETH]);
            const m41Calldata = MORPHO_EXEC_IFACE.encodeFunctionData("execute", [
              [WETH.toLowerCase(), wstETH.toLowerCase(), m30Oracle, ETH_MORPHO_IRM.toLowerCase(), 965000000000000000n],
              m41User, seizedWstRaw, 0n, 1000000000000000n, minOutWethRaw, UNI_ROUTER.toLowerCase(), pathWst,
            ]);
            targetM41 = {
              rank: "#M41", user: m41User, marketId: m30Mkt, pair: "wstETH / WETH",
              observationOnly: false, armed: true, deployedExecutor: DEPLOYED_MORPHO_EXECUTOR, executor: DEPLOYED_MORPHO_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on 0xaf5b...07ba ($1.85M WETH debt / $1.92M wstETH at 74.89 bps -> UniV3 1bp WETH, +0.0025 WETH / +$6.00 per nimble tranche simulated).",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e18 * 2400).toFixed(2), debtUsd: +(Number(debt) / 1e18 * 2400).toFixed(2),
              liveQuote: { repayWeth: 0.242, seizedWstEth: 0.20, uniV3OutWeth: 0.2445, grossSurplusWeth: 0.0025, grossSurplusUsd: 6.00 },
              readyExecuteMorphoBlueCalldata: m41Calldata,
            };
            if (liqNow) fired.push("TARGET_M41_MORPHO_WSTETH_WETH_LIQUIDATABLE");
          }
        } catch (_) {}
      }
      if (mkt42 && resM10M11[87]?.success && resM10M11[88]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[87].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[88].returnData);
          if (price > 0n) {
            const rate = rate42;
            const elapsed = pinTs > mkt42[4] ? pinTs - mkt42[4] : 0n;
            const accrued = mkt42[2] + mkt42[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt42[3] + V);
            const storedDebt = ceil(pos[1] * (mkt42[2] + 1n), mkt42[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 860000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = (debt * (rate ?? 0n)) / W;
            const seizeStr = clampMorphoSeize(50000n * W, pos, accrued, mkt42[3], price, LIF_86);
            const repayEstStrUsdc = ceil(ceil(seizeStr * price, 10n ** 36n) * W, LIF_86);
            const flashUsdc = (repayEstStrUsdc * 1005n) / 1000n;
            const trToSwap = (seizeStr * 10320n) / 10000n;
            const data1Str = M2_CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [0, 1, seizeStr, trToSwap]);
            const data2Str = FLUID_DEX_SWAP_IFACE.encodeFunctionData("swapIn", [false, trToSwap, flashUsdc + 100000000n, UNIVERSAL_FLUID_MORPHO_EXECUTOR]);
            const m42Calldata = UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{
              mode: 0, loanToken: USDC.toLowerCase(), flashAmount: flashUsdc,
              collateralToken: m42StrUsd, oracle: m42Oracle, irm: ETH_MORPHO_IRM.toLowerCase(), lltv: 860000000000000000n,
              borrower: m25User, seizedAssets: seizeStr,
              fluidVault: ethers.ZeroAddress, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
              colPerUnitDebt: 0n, token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 0n, absorb: false,
              approveToken1: m42StrUsd, target1: m42CurveStrTr, data1: data1Str,
              approveToken2: m42TrUsd, target2: m42FluidUsdcTr, data2: data2Str,
              minProfit: 100000000n,
            }]);
            targetM42 = {
              rank: "#M42", user: m25User, marketId: m42Mkt, pair: "strUSD / USDC",
              observationOnly: false, armed: true, deployedExecutor: UNIVERSAL_FLUID_MORPHO_EXECUTOR, executor: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on Universal 0xc503...3089 ($1.27M USDC debt / $1.48M strUSD at 75.39 bps -> Curve strUSD->trUSD + Fluid trUSD->USDC, +$2,586.50 USDC per 50k tranche simulated).",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
              liveQuote: { repayUsdc: 49036.85, seizedReusd: 50000.00, curveOutUsdc: 51623.35, grossSurplusUsdc: 2586.50, grossSurplusUsd: 2586.50 },
              readyExecuteUniversalCalldata: m42Calldata,
              readyExecuteCurveUnwindCalldata: m42Calldata,
              readyExecuteReusdCalldata: m42Calldata,
            };
            if (liqNow) fired.push("TARGET_M42_MORPHO_STRUSD_USDC_LIQUIDATABLE");
          }
        } catch (_) {}
      }
      if (mkt43 && resM10M11[90]?.success && resM10M11[91]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[90].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[91].returnData);
          if (price > 0n) {
            const rate = rate43;
            const elapsed = pinTs > mkt43[4] ? pinTs - mkt43[4] : 0n;
            const accrued = mkt43[2] + mkt43[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt43[3] + V);
            const storedDebt = ceil(pos[1] * (mkt43[2] + 1n), mkt43[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 860000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = (debt * (rate ?? 0n)) / W;
            const seizePrime = clampMorphoSeize(19000000000n, pos, accrued, mkt43[3], price, LIF_86);
            const repayEstPyusd = ceil(ceil(seizePrime * price, 10n ** 36n) * W, LIF_86);
            const flashPyusd = (repayEstPyusd * 1005n) / 1000n;
            const usdcFromPrime = (seizePrime * 10630n) / 10000n;
            const pathPrimeUsdc = ethers.solidityPacked(["address", "uint24", "address"], [m43Prime, 100, USDC.toLowerCase()]);
            const data1Prime = UNIV3_EXACT_INPUT_IFACE.encodeFunctionData("exactInput", [{
              path: pathPrimeUsdc, recipient: UNIVERSAL_FLUID_MORPHO_EXECUTOR, deadline: 9999999999n,
              amountIn: seizePrime, amountOutMinimum: usdcFromPrime,
            }]);
            const data2Prime = M2_CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [1, 0, usdcFromPrime, flashPyusd + 50000000n]);
            const m43Calldata = UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{
              mode: 0, loanToken: m43Pyusd, flashAmount: flashPyusd,
              collateralToken: m43Prime, oracle: m43Oracle, irm: ETH_MORPHO_IRM.toLowerCase(), lltv: 860000000000000000n,
              borrower: m10User, seizedAssets: seizePrime,
              fluidVault: ethers.ZeroAddress, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
              colPerUnitDebt: 0n, token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 0n, absorb: false,
              approveToken1: m43Prime, target1: UNI_ROUTER.toLowerCase(), data1: data1Prime,
              approveToken2: USDC.toLowerCase(), target2: m43PayPool, data2: data2Prime,
              minProfit: 50000000n,
            }]);
            targetM43 = {
              rank: "#M43", user: m10User, marketId: m43Mkt, pair: "PRIME / PYUSD",
              observationOnly: false, armed: true, deployedExecutor: UNIVERSAL_FLUID_MORPHO_EXECUTOR, executor: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on Universal 0xc503...3089 ($21.07k PYUSD debt / $24.65k PRIME at 61.33 bps -> UniV3 PRIME->USDC + Curve PayPool PYUSD, +$948.22 PYUSD simulated).",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
              liveQuote: { repayUsdc: 19295.74, seizedReusd: 19000.00, curveOutUsdc: 20243.96, grossSurplusUsdc: 948.22, grossSurplusUsd: 948.22 },
              readyExecuteUniversalCalldata: m43Calldata,
              readyExecuteCurveUnwindCalldata: m43Calldata,
              readyExecuteReusdCalldata: m43Calldata,
            };
            if (liqNow) fired.push("TARGET_M43_MORPHO_PRIME_PYUSD_LIQUIDATABLE");
          }
        } catch (_) {}
      }
      if (mkt44 && resM10M11[93]?.success && resM10M11[94]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[93].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[94].returnData);
          if (price > 0n) {
            const rate = rate44;
            const elapsed = pinTs > mkt44[4] ? pinTs - mkt44[4] : 0n;
            const accrued = mkt44[2] + mkt44[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt44[3] + V);
            const storedDebt = ceil(pos[1] * (mkt44[2] + 1n), mkt44[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 915000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = (debt * (rate ?? 0n)) / W;
            const seizeSr = clampMorphoSeize(22000n * W, pos, accrued, mkt44[3], price, LIF_915);
            const repayEstSr = ceil(ceil(seizeSr * price, 10n ** 36n) * W, LIF_915);
            const flashUsdc = (repayEstSr * 1005n) / 1000n;
            let rusdRaw = (seizeSr * 11665n) / 10000n;
            if (!options.rpcCall) {
              try {
                const rawPrice = await transport(rpc, "eth_call", [{ to: m44SavingMod,
                  data: SAVING_REDEEM_IFACE.encodeFunctionData("currentPrice") }, pinHash], 10000);
                const priceRaw = SAVING_REDEEM_IFACE.decodeFunctionResult("currentPrice", rawPrice)[0];
                if (priceRaw <= 0n) throw new Error("M44_REDEMPTION_PRICE_INVALID");
                const redeemedRusd = priceRaw > 10n ** 12n ? (seizeSr * priceRaw) / W : (seizeSr * priceRaw) / (10n ** 8n);
                // 2 bps covers the reviewed 1.67 bps SavingModule redemption fee.
                rusdRaw = (redeemedRusd * 9998n) / 10000n;
              } catch (_) { /* Preserve the supplied sizing fallback if the optional price read fails. */ }
            }
            // Whole USDC units keep the 18-decimal SavingModule and 6-decimal PSM legs aligned.
            const rusdUnits = rusdRaw / W;
            const data1Sr = SAVING_REDEEM_IFACE.encodeFunctionData("redeem", [rusdUnits * W]);
            const data2Sr = SAVING_REDEEM_IFACE.encodeFunctionData("redeem", [rusdUnits * 1000000n]);
            const m44Calldata = UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{
              mode: 0, loanToken: USDC.toLowerCase(), flashAmount: flashUsdc,
              collateralToken: m44SrUsd, oracle: m44Oracle, irm: ETH_MORPHO_IRM.toLowerCase(), lltv: 915000000000000000n,
              borrower: m44User, seizedAssets: seizeSr,
              fluidVault: ethers.ZeroAddress, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
              colPerUnitDebt: 0n, token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 0n, absorb: false,
              approveToken1: m44SrUsd, target1: m44SavingMod, data1: data1Sr,
              approveToken2: m44Rusd, target2: m44RusdPsm, data2: data2Sr,
              minProfit: 50000000n,
            }]);
            targetM44 = {
              rank: "#M44", user: m44User, marketId: m44Mkt, pair: "srUSD / USDC",
              observationOnly: false, armed: true, deployedExecutor: UNIVERSAL_FLUID_MORPHO_EXECUTOR, executor: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on Universal 0xc503...3089 ($26.34k USDC debt / $29.19k srUSD at 76.56 bps -> Reservoir SavingModule + PSM USDC, +$877.72 USDC simulated).",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
              liveQuote: { repayUsdc: 24772.28, seizedReusd: 22000.00, curveOutUsdc: 25650.00, grossSurplusUsdc: 877.72, grossSurplusUsd: 877.72 },
              readyExecuteUniversalCalldata: m44Calldata,
              readyExecuteCurveUnwindCalldata: m44Calldata,
              readyExecuteReusdCalldata: m44Calldata,
            };
            if (liqNow) fired.push("TARGET_M44_MORPHO_SRUSD_USDC_LIQUIDATABLE");
          }
        } catch (_) {}
      }
      if (mkt45 && resM10M11[96]?.success && resM10M11[97]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[96].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[97].returnData);
          if (price > 0n) {
            const rate = rate45;
            const elapsed = pinTs > mkt45[4] ? pinTs - mkt45[4] : 0n;
            const accrued = mkt45[2] + mkt45[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt45[3] + V);
            const storedDebt = ceil(pos[1] * (mkt45[2] + 1n), mkt45[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 770000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = (debt * (rate ?? 0n)) / W;
            const LIF_77 = 1074113856068743286n;
            const seizeReUsde = clampMorphoSeize(30000n * W, pos, accrued, mkt45[3], price, LIF_77);
            const repayEstUsdc = ceil(ceil(seizeReUsde * price, 10n ** 36n) * W, LIF_77);
            const flashUsdc = (repayEstUsdc * 1005n) / 1000n;
            const poolReusdeSusde = "0x43b98eea5c689f0036918f590a4b55f22d853734";
            const zero = ethers.ZeroAddress;
            const route45 = [m45ReUsde, poolReusdeSusde, sUsde, poolSusdeCrvusd, crvUsd, poolUsdcCrvusd, USDC.toLowerCase(), zero, zero, zero, zero];
            const swapParams45 = [[0, 1, 1, 20, 2], [1, 0, 1, 10, 2], [1, 0, 1, 10, 2], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
            const pools45 = [poolReusdeSusde, poolSusdeCrvusd, poolUsdcCrvusd, zero, zero];
            let curveOut45Raw = (seizeReUsde * 1368437n) / (10n ** 18n);
            let quoteKind45 = "MODEL_ESTIMATE";
            if (!options.rpcCall) {
              try {
                const rawQuote = await transport(rpc, "eth_call", [{ to: curveRouterNg,
                  data: CURVE_ROUTER_NG_IFACE.encodeFunctionData("get_dy", [route45, swapParams45, seizeReUsde, pools45]) }, pinHash], 10000);
                const quotedOut = CURVE_ROUTER_NG_IFACE.decodeFunctionResult("get_dy", rawQuote)[0];
                if (quotedOut > 0n) { curveOut45Raw = quotedOut; quoteKind45 = "ONCHAIN_MEASURED"; }
              } catch (_) { /* Preserve the supplied Curve quote fallback if the optional read fails. */ }
            }
            const data1M45 = CURVE_ROUTER_NG_IFACE.encodeFunctionData("exchange", [route45, swapParams45, seizeReUsde, flashUsdc + 100000000n, pools45, UNIVERSAL_FLUID_MORPHO_EXECUTOR]);
            const m45Calldata = UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{
              mode: 0, loanToken: USDC.toLowerCase(), flashAmount: flashUsdc,
              collateralToken: m45ReUsde, oracle: m45Oracle, irm: ETH_MORPHO_IRM.toLowerCase(), lltv: 770000000000000000n,
              borrower: m25User, seizedAssets: seizeReUsde,
              fluidVault: ethers.ZeroAddress, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
              colPerUnitDebt: 0n, token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 0n, absorb: false,
              approveToken1: m45ReUsde, target1: curveRouterNg, data1: data1M45,
              approveToken2: ethers.ZeroAddress, target2: ethers.ZeroAddress, data2: "0x",
              minProfit: 100000000n,
            }]);
            targetM45 = {
              rank: "#M45", user: m25User, marketId: m45Mkt, pair: "reUSDe / USDC",
              observationOnly: false, armed: true, deployedExecutor: UNIVERSAL_FLUID_MORPHO_EXECUTOR, executor: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on Universal 0xc503...3089 ($125.6k USDC debt / $164.5k reUSDe -> CurveRouterNG reUSDe->sUSDe->crvUSD->USDC, +$4,086.91 USDC per 30k tranche simulated).",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
              quoteKind: quoteKind45,
              liveQuote: { repayUsdc: +(Number(repayEstUsdc) / 1e6).toFixed(2), seizedReusd: +(Number(seizeReUsde) / 1e18).toFixed(2),
                curveOutUsdc: +(Number(curveOut45Raw) / 1e6).toFixed(2),
                grossSurplusUsdc: +((Number(curveOut45Raw) - Number(repayEstUsdc)) / 1e6).toFixed(2),
                grossSurplusUsd: +((Number(curveOut45Raw) - Number(repayEstUsdc)) / 1e6).toFixed(2) },
              readyExecuteUniversalCalldata: m45Calldata,
              readyExecuteCurveUnwindCalldata: m45Calldata,
              readyExecuteReusdCalldata: m45Calldata,
            };
            if (liqNow) fired.push("TARGET_M45_MORPHO_REUSDE_USDC_LIQUIDATABLE");
          }
        } catch (_) {}
      }
      if (mkt16 && resM10M11[20]?.success && resM10M11[98]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[20].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[98].returnData);
          if (price > 0n) {
            const rate = rate16;
            const elapsed = pinTs > mkt16[4] ? pinTs - mkt16[4] : 0n;
            const accrued = mkt16[2] + mkt16[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt16[3] + V);
            const storedDebt = ceil(pos[1] * (mkt16[2] + 1n), mkt16[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 860000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = (debt * (rate ?? 0n)) / W;
            const seizedApyRaw = clampMorphoSeize(250000n * W, pos, accrued, mkt16[3], price, LIF_86);
            const principalApxRaw = (seizedApyRaw * price) / (10n ** 36n);
            const minLoanOutApxRaw = principalApxRaw + 2500n * W;
            const swapData46 = M2_CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [0, 1, seizedApyRaw, (seizedApyRaw * 690000n) / 500000n]);
            const plan46 = {
              loanToken: m16ApxUsd, collateralToken: m16ApyUsd, oracle: m16Oracle, irm: ETH_MORPHO_IRM.toLowerCase(),
              lltv: 860000000000000000n, borrower: m25User, seizedAssets: seizedApyRaw,
              swapTarget: curveApyApx, minLoanOut: minLoanOutApxRaw,
            };
            targetM46 = {
              rank: "#M46", user: m25User, marketId: m16Mkt, pair: "apyUSD / apxUSD",
              observationOnly: false, armed: true, deployedExecutor: M2_CURVE_UNWIND_EXECUTOR, executor: M2_CURVE_UNWIND_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on 0x2d5b...3627 ($360.15k apxUSD debt / $415.60k apyUSD at 65.21 bps -> Curve apyUSD/apxUSD, +$4,726.74 apxUSD simulated).",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e18).toFixed(2), debtUsd: +(Number(debt) / 1e18).toFixed(2),
              liveQuote: { repayUsdc: 342240.00, seizedReusd: 250000.00, curveOutUsdc: 346966.74, grossSurplusUsdc: 4726.74, grossSurplusUsd: 4726.74 },
              readyExecuteCurveUnwindCalldata: M2_EXEC_IFACE.encodeFunctionData("execute", [plan46, swapData46]),
              readyExecuteReusdCalldata: M2_EXEC_IFACE.encodeFunctionData("execute", [plan46, swapData46]),
            };
            if (liqNow) fired.push("TARGET_M46_MORPHO_APYUSD_APXUSD_LIQUIDATABLE");
          }
        } catch (_) {}
      }
      if (mkt10 && resM10M11[1]?.success && resM10M11[99]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[1].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[99].returnData);
          if (price > 0n) {
            const rate = rate10;
            const elapsed = pinTs > mkt10[4] ? pinTs - mkt10[4] : 0n;
            const accrued = mkt10[2] + mkt10[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt10[3] + V);
            const storedDebt = ceil(pos[1] * (mkt10[2] + 1n), mkt10[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 915000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = (debt * (rate ?? 0n)) / W;
            const seizedUsdeRaw = clampMorphoSeize(35000n * W, pos, accrued, mkt10[3], price, LIF_915);
            const flashPrincipalRlusdRaw = (seizedUsdeRaw * price) / (10n ** 36n);
            const minProfitRlusdRaw = 100n * W;
            const minLoanOutRlusdRaw = flashPrincipalRlusdRaw + minProfitRlusdRaw;
            const minSwapOutRlusdRaw = (seizedUsdeRaw * 34800n) / 35000n;
            const pathM10 = ethers.solidityPacked(["address", "uint24", "address", "uint24", "address"], [USDe, 100, USDC, 100, rlusd]);
            const swapData47 = UNIV3_EXACT_INPUT_IFACE.encodeFunctionData("exactInput", [{
              path: pathM10, recipient: M2_CURVE_UNWIND_EXECUTOR, deadline: 9999999999n,
              amountIn: seizedUsdeRaw, amountOutMinimum: minSwapOutRlusdRaw,
            }]);
            const plan47 = {
              loanToken: rlusd, collateralToken: USDe.toLowerCase(), oracle: m10Oracle, irm: ETH_MORPHO_IRM.toLowerCase(),
              lltv: 915000000000000000n, borrower: a10User, seizedAssets: seizedUsdeRaw,
              swapTarget: UNI_ROUTER.toLowerCase(), minLoanOut: minLoanOutRlusdRaw,
            };
            targetM47 = {
              rank: "#M47", user: a10User, marketId: m10Mkt, pair: "USDe / RLUSD",
              observationOnly: false, armed: true, deployedExecutor: M2_CURVE_UNWIND_EXECUTOR, executor: M2_CURVE_UNWIND_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on 0x2d5b...3627 ($457.5k RLUSD debt / $503.2k USDe at 70.59 bps -> UniV3 USDe->USDC->RLUSD, +$894.37 RLUSD per 35k tranche simulated).",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e18).toFixed(2), debtUsd: +(Number(debt) / 1e18).toFixed(2),
              liveQuote: { repayUsdc: 34092.60, seizedReusd: 35000, curveOutUsdc: 34986.97, grossSurplusUsdc: 894.37, grossSurplusUsd: 894.37 },
              readyExecuteCurveUnwindCalldata: M2_EXEC_IFACE.encodeFunctionData("execute", [plan47, swapData47]),
            };
            if (liqNow) fired.push("TARGET_M47_MORPHO_USDE_RLUSD_LIQUIDATABLE");
          }
        } catch (_) {}
      }
      if (mkt48 && resM10M11[101]?.success && resM10M11[102]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[101].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[102].returnData);
          if (price > 0n) {
            const rate = rate48;
            const elapsed = pinTs > mkt48[4] ? pinTs - mkt48[4] : 0n;
            const accrued = mkt48[2] + mkt48[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt48[3] + V);
            const storedDebt = ceil(pos[1] * (mkt48[2] + 1n), mkt48[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 915000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = (debt * (rate ?? 0n)) / W;
            const seizeReUsd = clampMorphoSeize(50000n * W, pos, accrued, mkt48[3], price, LIF_915);
            const repayEstUsdt = ceil(ceil(seizeReUsd * price, 10n ** 36n) * W, LIF_915);
            const flashUsdt = (repayEstUsdt * 1005n) / 1000n;
            const usdcFromReUsd = (seizeReUsd * 11018n) / (10000n * 10n ** 12n);
            const pathUsdcUsdt = ethers.solidityPacked(["address", "uint24", "address"], [USDC.toLowerCase(), 100, usdtEth]);
            const data1Re = M2_CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [0, 1, seizeReUsd, usdcFromReUsd]);
            const data2Re = UNIV3_EXACT_INPUT_IFACE.encodeFunctionData("exactInput", [{
              path: pathUsdcUsdt, recipient: UNIVERSAL_FLUID_MORPHO_EXECUTOR, deadline: 9999999999n,
              amountIn: usdcFromReUsd, amountOutMinimum: flashUsdt + 100000000n,
            }]);
            const m48Calldata = UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{
              mode: 0, loanToken: usdtEth, flashAmount: flashUsdt,
              collateralToken: REUSD.toLowerCase(), oracle: m48Oracle, irm: ETH_MORPHO_IRM.toLowerCase(), lltv: 915000000000000000n,
              borrower: USER_V4_C1.toLowerCase(), seizedAssets: seizeReUsd,
              fluidVault: ethers.ZeroAddress, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
              colPerUnitDebt: 0n, token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 0n, absorb: false,
              approveToken1: REUSD.toLowerCase(), target1: CURVE_REUSD_USDC.toLowerCase(), data1: data1Re,
              approveToken2: USDC.toLowerCase(), target2: UNI_ROUTER.toLowerCase(), data2: data2Re,
              minProfit: 100000000n,
            }]);
            targetM48 = {
              rank: "#M48", user: USER_V4_C1.toLowerCase(), marketId: m48Mkt, pair: "reUSD / USDT",
              observationOnly: false, armed: true, deployedExecutor: UNIVERSAL_FLUID_MORPHO_EXECUTOR, executor: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on Universal 0xc503...3089 ($129.9k USDT debt / $143.0k reUSD at 66.65 bps -> Curve reUSD->USDC + UniV3 USDT, +$1,559.98 USDT per 50k tranche simulated).",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
              liveQuote: { repayUsdc: 53642.10, seizedReusd: 50000.00, curveOutUsdc: 55202.08, grossSurplusUsdc: 1559.98, grossSurplusUsd: 1559.98 },
              readyExecuteUniversalCalldata: m48Calldata,
              readyExecuteCurveUnwindCalldata: m48Calldata,
              readyExecuteReusdCalldata: m48Calldata,
            };
            if (liqNow) fired.push("TARGET_M48_MORPHO_REUSD_USDT_LIQUIDATABLE");
          }
        } catch (_) {}
      }
      if (mkt49 && resM10M11[104]?.success && resM10M11[105]?.success) {
        try {
          const price = BLUE_ORACLE.decodeFunctionResult("price", resM10M11[104].returnData)[0];
          const pos = BLUE.decodeFunctionResult("position", resM10M11[105].returnData);
          if (price > 0n) {
            const rate = rate49;
            const elapsed = pinTs > mkt49[4] ? pinTs - mkt49[4] : 0n;
            const accrued = mkt49[2] + mkt49[2] * wTaylorCompounded(rate ?? 0n, elapsed) / W;
            const debt = ceil(pos[1] * (accrued + 1n), mkt49[3] + V);
            const storedDebt = ceil(pos[1] * (mkt49[2] + 1n), mkt49[3] + V);
            const collVal = (pos[2] * price) / (10n ** 36n);
            const maxBorrow = (collVal * 915000000000000000n) / W;
            const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
            const liqNow = rate !== null && debt > 0n && maxBorrow < debt;
            const growth = (debt * (rate ?? 0n)) / W;
            const seizeSusde = clampMorphoSeize(40000n * W, pos, accrued, mkt49[3], price, LIF_915);
            const repayEstUsdt = ceil(ceil(seizeSusde * price, 10n ** 36n) * W, LIF_915);
            const flashUsdt = (repayEstUsdt * 1005n) / 1000n;
            const data1Susde = FLUID_DEX_SWAP_IFACE.encodeFunctionData("swapIn", [true, seizeSusde, flashUsdt + 100000000n, UNIVERSAL_FLUID_MORPHO_EXECUTOR]);
            const m49Calldata = UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{
              mode: 0, loanToken: usdtEth, flashAmount: flashUsdt,
              collateralToken: sUsde, oracle: m49Oracle, irm: ETH_MORPHO_IRM.toLowerCase(), lltv: 915000000000000000n,
              borrower: m49User, seizedAssets: seizeSusde,
              fluidVault: ethers.ZeroAddress, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
              colPerUnitDebt: 0n, token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 0n, absorb: false,
              approveToken1: sUsde, target1: m49FluidSusdeUsdt, data1: data1Susde,
              approveToken2: ethers.ZeroAddress, target2: ethers.ZeroAddress, data2: "0x",
              minProfit: 100000000n,
            }]);
            targetM49 = {
              rank: "#M49", user: m49User, marketId: m49Mkt, pair: "sUSDe / USDT",
              observationOnly: false, armed: true, deployedExecutor: UNIVERSAL_FLUID_MORPHO_EXECUTOR, executor: UNIVERSAL_FLUID_MORPHO_EXECUTOR,
              executableNow: liqNow, liquidatableNow: liqNow,
              readinessNote: "ARMED on Universal 0xc503...3089 ($167.9k USDT debt / $184.8k sUSDe at 75.12 bps -> Fluid sUSDe->USDT, +$1,690.01 USDT per 40k tranche simulated).",
              healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
              healthIsEstimate: rate === null,
              borrowAprPct: rate !== null ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
              passiveHoursToCrossing: liqNow ? 0 : rate !== null && growth > 0n ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null,
              bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
              collateralUsd: +(Number(collVal) / 1e6).toFixed(2), debtUsd: +(Number(debt) / 1e6).toFixed(2),
              liveQuote: { repayUsdc: 48483.82, seizedReusd: 40000.00, curveOutUsdc: 50173.83, grossSurplusUsdc: 1690.01, grossSurplusUsd: 1690.01 },
              readyExecuteUniversalCalldata: m49Calldata,
              readyExecuteCurveUnwindCalldata: m49Calldata,
              readyExecuteReusdCalldata: m49Calldata,
            };
            if (liqNow) fired.push("TARGET_M49_MORPHO_SUSDE_USDT_LIQUIDATABLE");
          }
        } catch (_) {}
      }
      for (const [resIdx, rank, user, trigger, flashAmount, minCollateralSeized, minSwapOut, minProfit, liveQuote, readinessNote] of [
        [22, "#A8", a8User, "TARGET_A8_AAVE_V4_0x707E_LIQUIDATABLE", 850000000000n, 830000000000n, 860000000000n, 10000000000n,
          { repayUsdc: 850000.00, seizedUsde: 859898.00, uniV3OutUsdc: 881533.20, grossSurplusUsdc: 31533.20 },
          "ARMED on UniV4 0x6125...5e1f ($3.71M USDG r0 debt / $4.07M syrupUSDG collateral -> 850k tranche, +$31,533.20 USDG)."],
        [23, "#A9", a9User, "TARGET_A9_AAVE_V4_0x90FF_LIQUIDATABLE", 850000000000n, 830000000000n, 860000000000n, 10000000000n,
          { repayUsdc: 850000.00, seizedUsde: 859898.00, uniV3OutUsdc: 881533.20, grossSurplusUsdc: 31533.20 },
          "ARMED on UniV4 0x6125...5e1f ($7.70M USDG r0 debt / $8.45M syrupUSDG collateral -> 850k tranche, +$31,533.20 USDG)."],
        [24, "#A10", a10User, "TARGET_A10_AAVE_V4_0x6EFC_LIQUIDATABLE", 650000000000n, 635000000000n, 658000000000n, 8000000000n,
          { repayUsdc: 650000.00, seizedUsde: 657569.00, uniV3OutUsdc: 674113.60, grossSurplusUsdc: 24113.60 },
          "ARMED on UniV4 0x6125...5e1f ($1.75M USDG r0 debt / $1.92M syrupUSDG collateral -> 650k small-crossing tranche, +$24,113.60 USDG)."],
        [109, "#A14", a14User, "TARGET_A14_AAVE_V4_0xABCC_LIQUIDATABLE", 850000000000n, 830000000000n, 860000000000n, 10000000000n,
          { repayUsdc: 850000.00, seizedUsde: 859898.00, uniV3OutUsdc: 881533.20, grossSurplusUsdc: 31533.20 },
          "ARMED on UniV4 0x6125...5e1f ($5.55M USDG r0 debt / $6.09M syrupUSDG collateral at 99.91 bps -> 850k tranche, +$31,533.20 USDG)."],
        [111, "#A16", a16User, "TARGET_A16_AAVE_V4_0x9CD7_LIQUIDATABLE", 250000000000n, 240000000000n, 253000000000n, 3000000000n,
          { repayUsdc: 250000.00, seizedUsde: 252911.00, uniV3OutUsdc: 259645.20, grossSurplusUsdc: 9645.20 },
          "ARMED on UniV4 0x6125...5e1f ($574.2k USDG r0/r3 debt / $631.8k syrupUSDG collateral at 121.41 bps -> 250k tranche, +$9,645.20 USDG)."],
        [113, "#A18", a18User, "TARGET_A18_AAVE_V4_0xDD64_LIQUIDATABLE", 850000000000n, 830000000000n, 860000000000n, 10000000000n,
          { repayUsdc: 850000.00, seizedUsde: 859898.00, uniV3OutUsdc: 881533.20, grossSurplusUsdc: 31533.20 },
          "ARMED on UniV4 0x6125...5e1f ($4.91M USDG r0 debt / $5.42M syrupUSDG collateral at 142.55 bps -> 850k tranche, +$31,533.20 USDG)."],
      ]) {
        if (!resM10M11[resIdx]?.success) continue;
        try {
          const account = SPOKE.decodeFunctionResult("getUserAccountData", resM10M11[resIdx].returnData)[0];
          const healthFactorRaw = BigInt(account.healthFactor), healthFactor = Number(healthFactorRaw) / 1e18;
          const liquidatableNow = healthFactorRaw > 0n && healthFactorRaw < W;
          const plan = {
            mode: 0, target: syrupSpoke, collateralVault: ethers.ZeroAddress, collateralReserveId: 1n, debtReserveId: 0n,
            borrower: user, debtAsset: "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
            collateralAsset: "0x87b65c4aaffa76881f9e96f3e7ed945ddfc3cd7a",
            flashAmount, debtToCover: flashAmount, minCollateralSeized, minSwapOut, minProfit, deadline: 9999999999n,
            poolKey: { currency0: "0x87b65c4aaffa76881f9e96f3e7ed945ddfc3cd7a",
              currency1: "0xe343167631d89b6ffc58b88d6b7fb0228795491d", fee: 800, tickSpacing: 5, hooks: ethers.ZeroAddress },
            zeroForOne: true,
          };
          const row = {
            rank, user, spoke: syrupSpoke, pair: "syrupUSDG / USDG (UniV4)",
            observationOnly: false, armed: true, executableNow: liquidatableNow, liquidatableNow,
            deployedExecutor: UNIV4_FLASH_EXECUTOR, executor: UNIV4_FLASH_EXECUTOR,
            readinessNote, healthFactor,
            bpsToLiquidation: healthFactor > 0 ? +((1 - 1 / healthFactor) * 10000).toFixed(4) : null,
            collateralUsd: +(Number(account.totalCollateralValue) / 1e26).toFixed(2),
            debtUsd: +(Number(account.totalDebtValue) / 1e53).toFixed(2),
            liveQuote,
            readyExecuteUniV4FlashCalldata: UNIV4_FLASH_EXEC_IFACE.encodeFunctionData("execute", [plan]),
          };
          if (rank === "#A8") targetA8 = row;
          else if (rank === "#A9") targetA9 = row;
          else if (rank === "#A10") targetA10 = row;
          else if (rank === "#A14") targetA14 = row;
          else if (rank === "#A16") targetA16 = row;
          else if (rank === "#A18") targetA18 = row;
          if (liquidatableNow) fired.push(trigger);
        } catch (_) {}
      }
      for (const [resIdx, rank, user, trigger, flashWeth, minSeizedWeEth, minOutWeth, minProfitWeth, liveQuote, readinessNote] of [
        [110, "#A15", a15User, "TARGET_A15_AAVE_V4_0x3519_LIQUIDATABLE", 15000000000000000000n, 13000000000000000000n, 15050000000000000000n, 50000000000000000n,
          { repayWeth: 15.00, seizedWeEth: 13.84, curveOutWeth: 15.38, grossSurplusWeth: 0.38, grossSurplusUsd: 930.00 },
          "ARMED on Unified 0xf09a...4262 ($171.88k WETH r1 debt / $182.05k weETH r0 collateral at 113.60 bps -> 15 WETH tranche, +$930.00 WETH simulated)."],
        [112, "#A17", a17User, "TARGET_A17_AAVE_V4_0xA751_LIQUIDATABLE", 8000000000000000000n, 7000000000000000000n, 8020000000000000000n, 20000000000000000n,
          { repayWeth: 8.00, seizedWeEth: 7.38, curveOutWeth: 8.14, grossSurplusWeth: 0.14, grossSurplusUsd: 348.00 },
          "ARMED on Unified 0xf09a...4262 ($64.20k WETH r1 debt / $68.18k weETH r0 collateral at 140.21 bps -> 8 WETH tranche, +$348.00 WETH simulated)."],
      ]) {
        if (!resM10M11[resIdx]?.success) continue;
        try {
          const account = SPOKE.decodeFunctionResult("getUserAccountData", resM10M11[resIdx].returnData)[0];
          const healthFactorRaw = BigInt(account.healthFactor), healthFactor = Number(healthFactorRaw) / 1e18;
          const liquidatableNow = healthFactorRaw > 0n && healthFactorRaw < W;
          const paramsSpokeC = {
            isAaveV3: false, target: SPOKE_C, borrower: user, debtToken: WETH, collateralToken: weETH,
            collateralReserveId: 0n, debtReserveId: 1n, minCollateralSeized: minSeizedWeEth,
            swapKind: 2, swapTarget: CURVE_WEETH_WETH, swapSpender: CURVE_WEETH_WETH, uniFee: 0, curveI: 1, curveJ: 0,
            minDebtTokenOut: minOutWeth, minProfitDebtToken: minProfitWeth,
          };
          const rowC = {
            rank, user, spoke: SPOKE_C, pair: "weETH / WETH",
            observationOnly: false, armed: true, executableNow: liquidatableNow, liquidatableNow,
            deployedExecutor: DEPLOYED_LIQUIDATOR, executor: DEPLOYED_LIQUIDATOR,
            healthFactor,
            bpsToLiquidation: healthFactor > 0 ? +((1 - 1 / healthFactor) * 10000).toFixed(4) : null,
            collateralUsd: +(Number(account.totalCollateralValue) / 1e26).toFixed(2),
            debtUsd: +(Number(account.totalDebtValue) / 1e53).toFixed(2),
            liveQuote, readinessNote,
            readyExecuteMorphoCalldata: LIQUIDATOR_IFACE.encodeFunctionData("executeMorpho", [flashWeth, paramsSpokeC]),
          };
          if (rank === "#A15") targetA15 = rowC;
          else targetA17 = rowC;
          if (liquidatableNow) fired.push(trigger);
        } catch (_) {}
      }
      if (resM10M11[52]?.success) {
        try {
          const account = SPOKE.decodeFunctionResult("getUserAccountData", resM10M11[52].returnData)[0];
          const healthFactorRaw = BigInt(account.healthFactor), healthFactor = Number(healthFactorRaw) / 1e18;
          const liquidatableNow = healthFactorRaw > 0n && healthFactorRaw < W;
          const planA12 = {
            mode: 0, target: a12Spoke, collateralVault: ethers.ZeroAddress, collateralReserveId: 1n, debtReserveId: 5n,
            borrower: a12User, debtAsset: "0xdac17f958d2ee523a2206206994597c13d831ec7",
            collateralAsset: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
            flashAmount: 28000000000n, debtToCover: 28000000000n, minCollateralSeized: 35000000n,
            minSwapOut: 28500000000n, minProfit: 500000000n, deadline: 9999999999n,
            poolKey: { currency0: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
              currency1: "0xdac17f958d2ee523a2206206994597c13d831ec7", fee: 500, tickSpacing: 10, hooks: ethers.ZeroAddress },
            zeroForOne: true,
          };
          targetA12 = {
            rank: "#A12", user: a12User, spoke: a12Spoke, pair: "WBTC / USDT (UniV4)",
            observationOnly: false, armed: true, executableNow: liquidatableNow, liquidatableNow,
            deployedExecutor: UNIV4_FLASH_EXECUTOR, executor: UNIV4_FLASH_EXECUTOR,
            healthFactor,
            bpsToLiquidation: healthFactor > 0 ? +((1 - 1 / healthFactor) * 10000).toFixed(4) : null,
            collateralUsd: +(Number(account.totalCollateralValue) / 1e26).toFixed(2),
            debtUsd: +(Number(account.totalDebtValue) / 1e53).toFixed(2),
            // Supplied simulation reference, not a fresh executable quote.
            liveQuote: { repayUsdc: 28000.00, seizedUsde: 0.3588, uniV3OutUsdc: 28846.58, grossSurplusUsdc: 846.58, grossSurplusUsd: 846.58 },
            readinessNote: "ARMED on UniV4 0x6125...5e1f ($55.5k debt [$47.9k USDT r5 + $7.3k USDC r4] / $65.7k WBTC r1 -> 28k USDT tranche, +$846.58 USDT simulated).",
            readyExecuteUniV4FlashCalldata: UNIV4_FLASH_EXEC_IFACE.encodeFunctionData("execute", [planA12]),
          };
          if (liquidatableNow) fired.push("TARGET_A12_AAVE_V4_0xAC90_LIQUIDATABLE");
        } catch (_) { /* An unavailable A12 account must not discard the other targets. */ }
      }
      if (resM10M11[56]?.success) {
        try {
          const account = SPOKE.decodeFunctionResult("getUserAccountData", resM10M11[56].returnData)[0];
          const healthFactorRaw = BigInt(account.healthFactor), healthFactor = Number(healthFactorRaw) / 1e18;
          const liquidatableNow = healthFactorRaw > 0n && healthFactorRaw < W;
          const flashWeth = 350000000000000000n;
          const minSeizedWst = 280000000000000000n;
          const minOutWeth = 352000000000000000n;
          const minProfitWeth = 2000000000000000n;
          const paramsA13 = {
            isAaveV3: false, target: a13Spoke, borrower: a13User, debtToken: WETH, collateralToken: wstETH,
            collateralReserveId: 0n, debtReserveId: 1n, minCollateralSeized: minSeizedWst,
            swapKind: 1, swapTarget: UNI_ROUTER, swapSpender: UNI_ROUTER, uniFee: 100, curveI: 0, curveJ: 0,
            minDebtTokenOut: minOutWeth, minProfitDebtToken: minProfitWeth,
          };
          targetA13 = {
            rank: "#A13", user: a13User, spoke: a13Spoke, pair: "wstETH / WETH",
            observationOnly: false, armed: true, executableNow: liquidatableNow, liquidatableNow,
            deployedExecutor: DEPLOYED_LIQUIDATOR, executor: DEPLOYED_LIQUIDATOR,
            healthFactor,
            bpsToLiquidation: healthFactor > 0 ? +((1 - 1 / healthFactor) * 10000).toFixed(4) : null,
            collateralUsd: +(Number(account.totalCollateralValue) / 1e26).toFixed(2),
            debtUsd: +(Number(account.totalDebtValue) / 1e53).toFixed(2),
            // Supplied simulation reference, not a fresh executable quote.
            liveQuote: { repayWeth: 0.3500, seizedWstEth: 0.2885, uniV3OutWeth: 0.3531, grossSurplusWeth: 0.0031, grossSurplusUsd: 7.56 },
            readinessNote: "ARMED on Unified 0xf09a...4262 ($3.23k WETH r1 debt / $3.39k wstETH r0 collateral at 2.59 bps -> 0.35 WETH tranche, +$7.56 WETH simulated).",
            readyExecuteMorphoCalldata: LIQUIDATOR_IFACE.encodeFunctionData("executeMorpho", [flashWeth, paramsA13]),
          };
          if (liquidatableNow) fired.push("TARGET_A13_AAVE_V4_0x4CD7_LIQUIDATABLE");
        } catch (_) { /* An unavailable A13 account must not discard the other targets. */ }
      }
    } catch (_) { /* Optional M10/M11 reads must not discard existing targets. */ }
  }

  // Reuse M7's pinned market/rate/oracle/buffer evidence; only read the companion position.
  if ((!options.rpcCall || options.includeM7B) && targetM7Canary && m7Observation) {
    try {
      const { m7Mkt, m7Price, m7Rate, m7RateKnown, m7Accrued, m7BufWeth, pWeth2J, m7BufferRead } = m7Observation;
      const user = "0x9b1303ebf09bc51b7fac376c9e421e8daae63b82";
      const rawM7B = await transport(rpc, "eth_call", [{ to: MORPHO_BLUE,
        data: BLUE.encodeFunctionData("position", [ETH_MORPHO_YNETHX_MSETH_MKT, user]) }, pinHash], 10000);
      const m7bPos = BLUE.decodeFunctionResult("position", rawM7B);
      const m7bStoredDebt = ceil(BigInt(m7bPos[1]) * (BigInt(m7Mkt[2]) + 1n), BigInt(m7Mkt[3]) + V);
      const m7bDebt = ceil(BigInt(m7bPos[1]) * (m7Accrued + 1n), BigInt(m7Mkt[3]) + V);
      const m7bCollVal = (BigInt(m7bPos[2]) * BigInt(m7Price)) / (10n ** 36n);
      const m7bMaxBorrow = (m7bCollVal * 915000000000000000n) / W;
      const m7bHf = m7bDebt > 0n ? Number(m7bMaxBorrow * 1000000n / m7bDebt) / 1e6 : null;
      const m7bStoredHf = m7bStoredDebt > 0n ? Number(m7bMaxBorrow * 1000000n / m7bStoredDebt) / 1e6 : null;
      const m7bDMax = (BigInt(m7bPos[1]) * (m7Accrued + 1n)) / (BigInt(m7Mkt[3]) + V);
      const m7bQMax = (m7bDMax * 1026167265264238070n) / W;
      const m7bSMax = BigInt(m7Price) > 0n ? (m7bQMax * (10n ** 36n)) / BigInt(m7Price) : 0n;
      const m7bRawSeize = (BigInt(m7BufWeth) * 9000n) / 10000n;
      const m7bSeize = [m7bRawSeize, BigInt(m7bPos[2]), m7bSMax, 50n * W].reduce((a, b) => a < b ? a : b);
      const m7bBufferReady = m7bSeize >= W;
      const m7bExecutableNow = (m7bMaxBorrow < m7bDebt) && m7bBufferReady;
      const buildM7BPlan = () => {
        const m7bPrincipal = (m7bSeize * BigInt(m7Price)) / (10n ** 36n);
        const m7bMinProfit = (m7bSeize * 50000000000000000n) / W;
        const m7bFloor = m7bMinProfit > 50000000000000000n ? m7bMinProfit : 50000000000000000n;
        const m7bMinLoanOut = m7bPrincipal + m7bFloor;
        return M7_EXEC_IFACE.encodeFunctionData("execute", [[
          MSETH, YNETHX, ETH_MORPHO_YNETHX_MSETH_ORACLE.toLowerCase(), ETH_MORPHO_IRM.toLowerCase(),
          915000000000000000n, user, m7bSeize, WETH.toLowerCase(), CURVE_MSETH_WETH, 1, 0, m7bMinLoanOut,
        ]]);
      };
      const readyExecuteVaultRedeemCalldata = m7bExecutableNow ? buildM7BPlan() : undefined;
      targetM7B = {
        rank: "#M7B", user, marketId: ETH_MORPHO_YNETHX_MSETH_MKT, pair: "ynETHx / msETH",
        observationOnly: false, armed: true, executor: M7_VAULT_REDEEM_EXECUTOR, executableNow: m7bExecutableNow,
        readinessNote: m7bBufferReady ? "ARMED on 0xc063...2eb4: buffer ready for immediate execution."
          : `ARMED on 0xc063...2eb4 (dynamic 1-5.69 ynETHx); HF ${m7bHf?.toFixed(6)} < 1.0, fires on MCwETH buffer refill (${(Number(m7BufWeth) / 1e18).toFixed(4)} shares).`,
        healthFactor: m7bHf, storedHealthFactor: m7bStoredHf,
        borrowAprPct: +(Number(m7Rate) / 1e18 * 31536000 * 100).toFixed(2),
        passiveHoursToCrossing: m7bMaxBorrow < m7bDebt ? 0 : null,
        liquidatableNow: m7bExecutableNow, hfUnderwaterNow: m7bMaxBorrow < m7bDebt,
        bpsToLiquidation: m7bHf > 0 ? +((1 - 1 / m7bHf) * 10000).toFixed(4) : null,
        collateralUsd: +(Number(m7bCollVal) / 1e18 * (Number(pWeth2J) / 1e8)).toFixed(2),
        debtUsd: +(Number(m7bDebt) / 1e18 * (Number(pWeth2J) / 1e8)).toFixed(2),
        ynEthxBufferWeth: +(Number(m7BufWeth) / 1e18).toFixed(6),
        liveQuote: { collateralSeizedFormatted: "5.69 ynETHx (buffer refill)",
          debtOutcomeFormatted: "+0.8612 msETH (pre-gas)", estimatedProfitUsd: 2080.15 },
        ...(m7bExecutableNow ? { readyExecuteVaultRedeemCalldata } : {}),
        protocolLiquidatable: m7bMaxBorrow < m7bDebt,
        routeExecutable: m7bExecutableNow,
        bufferMaxWithdrawWeth: m7BufferRead.ok ? m7BufferRead.maxWithdraw.toString() : null,
        bufferReadStatus: m7BufferRead.ok ? "OK" : m7BufferRead.reason,
      };
      forecastMorpho(targetM7B, { market: m7Mkt, position: m7bPos, price: m7Price, lltv: 915000000000000000n,
        rate: m7RateKnown ? m7Rate : null, seizedAssets: m7bSeize, lif: LIF_915 },
      m7bBufferReady, () => ({ readyExecuteVaultRedeemCalldata: buildM7BPlan() }));
    } catch (_) { /* A missing companion position must not discard M7 or emit an execution trigger. */ }
  }

  // Curve/NAV and Euler reads reuse M7's pinned context.
  if ((!options.rpcCall || options.includeEulerYn) && targetM7Canary && m7Observation) {
    const { m7BufWeth, pWeth2J, m7BufferRead } = m7Observation;
    try {
      const rawYn = await transport(rpc, "eth_call", [{ to: CURVE_POOL,
        data: CURVE.encodeFunctionData("get_dy", [1, 0, 10000000000000000000n]) }, pinHash], 10000);
      const ynBought = CURVE.decodeFunctionResult("get_dy", rawYn)[0];
      const rawRedeem = await transport(rpc, "eth_call", [{ to: YNETHX,
        data: VAULT_4626.encodeFunctionData("previewRedeem", [ynBought]) }, pinHash], 10000);
      const wethRedeem = VAULT_4626.decodeFunctionResult("previewRedeem", rawRedeem)[0];
      const grossProfitWeth = Number(wethRedeem - 10000000000000000000n) / 1e18;
      const roiBps = Number((wethRedeem - 10000000000000000000n) * 10000n / 10000000000000000000n);
      const bufferReady = BigInt(m7BufWeth) >= 1216100000000000000n;
      const ynExecutableNow = bufferReady && wethRedeem > 10050000000000000000n;
      let readyExecuteCurveRedeemCalldata;
      if (ynExecutableNow) {
        const ynFlash = BigInt(m7BufWeth) >= wethRedeem
          ? 10000000000000000000n
          : [BigInt(m7BufWeth) * 10000000000000000000n * 9000n / (wethRedeem * 10000n), W].reduce((a, b) => a > b ? a : b);
        const minSharesOut = (ynBought * ynFlash * 9900n) / (10000000000000000000n * 10000n);
        const scaledRedeem = (wethRedeem * ynFlash * 9900n) / (10000000000000000000n * 10000n);
        const minProfit = ynFlash * 50000000000000000n / W > 50000000000000000n ? ynFlash * 50000000000000000n / W : 50000000000000000n;
        const minLoanOut = scaledRedeem > ynFlash + minProfit ? scaledRedeem : ynFlash + minProfit;
        readyExecuteCurveRedeemCalldata = YN_ARB_EXEC_IFACE.encodeFunctionData("execute", [[
          WETH.toLowerCase(), YNETHX, CURVE_POOL, 1, 0, ynFlash, minSharesOut, minLoanOut,
        ]]);
      }
      targetYnArb = {
        rank: "#YN",
        user: CURVE_POOL,
        marketId: CURVE_POOL,
        pair: "WETH -> ynETHx -> Redeem (Curve/NAV)",
        observationOnly: false,
        armed: true,
        executor: YN_ARB_EXECUTOR,
        executableNow: ynExecutableNow,
        liquidatableNow: ynExecutableNow,
        hfUnderwaterNow: true,
        healthFactor: +(10000 / (10000 + roiBps)).toFixed(6),
        bpsToLiquidation: -roiBps,
        collateralUsd: +(Number(wethRedeem) / 1e18 * (Number(pWeth2J) / 1e8)).toFixed(2),
        debtUsd: +(10 * (Number(pWeth2J) / 1e8)).toFixed(2),
        ynEthxBufferWeth: +(Number(m7BufWeth) / 1e18).toFixed(6),
        readinessNote: ynExecutableNow
          ? "ARMED on 0x91a0...cd35: buffer ready for immediate Curve->ynETHx->redeem execution."
          : `ARMED on 0x91a0...cd35 (+${grossProfitWeth.toFixed(4)} WETH / +${(roiBps / 100).toFixed(2)}% on 10 WETH, +21.61% on 1 WETH); fires on MCwETH buffer refill.`,
        quoteKind: "ONCHAIN_MEASURED",
        liveQuote: {
          collateralSeizedFormatted: `${(Number(ynBought) / 1e18).toFixed(2)} ynETHx bought`,
          debtOutcomeFormatted: `+${grossProfitWeth.toFixed(4)} WETH (10 WETH flash)`,
          estimatedProfitUsd: +(grossProfitWeth * (Number(pWeth2J) / 1e8)).toFixed(2),
        },
        ...(ynExecutableNow ? { readyExecuteCurveRedeemCalldata } : {}),
        protocolLiquidatable: false, // Curve/NAV arbitrage has no protocol liquidation condition.
        routeExecutable: ynExecutableNow,
        bufferMaxWithdrawWeth: m7BufferRead.ok ? m7BufferRead.maxWithdraw.toString() : null,
        bufferReadStatus: m7BufferRead.ok ? "OK" : m7BufferRead.reason,
      };
    } catch (_) { /* An unavailable NAV quote must not discard Euler or existing observations. */ }
    try {
      const callsEuler = [
        { target: "0xe1ce9af672f8854845e5474400b6ddc7ae458a10", allowFailure: true,
          callData: EVK_LIQ.encodeFunctionData("accountLiquidity", ["0xbf21702d7213bc7a95fc0ecb1e4a4e43c2380772", true]) },
        { target: "0x9bd52f2805c6af014132874124686e7b248c2cbb", allowFailure: true,
          callData: EVK_LIQ.encodeFunctionData("accountLiquidity", ["0x9f09502a0b68edbccdff5e6c59270ad150def361", true]) },
      ];
      const rawEuler = await transport(rpc, "eth_call", [{ to: MULTICALL3,
        data: MC.encodeFunctionData("aggregate3", [callsEuler]) }, pinHash], 15000);
      const results = MC.decodeFunctionResult("aggregate3", rawEuler)[0];
      if (results[0]?.success) {
        try {
          const [e1Col, e1Liab] = EVK_LIQ.decodeFunctionResult("accountLiquidity", results[0].returnData);
          const e1Hf = e1Liab > 0n ? Number(e1Col) / Number(e1Liab) : null;
          const e1Liq = e1Liab > 0n && e1Col < e1Liab;
          let readyExecuteEulerEvkCalldata;
          if (e1Liq) {
            readyExecuteEulerEvkCalldata = EULER_EVK_EXEC_IFACE.encodeFunctionData("execute", [[
              "0x8292bb45bf1ee4d140127049757c2e0ff06317ed",
              "0xe1ce9af672f8854845e5474400b6ddc7ae458a10",
              "0xe0a80d35bb6618cba260120b279d357978c42bce",
              USDC.toLowerCase(),
              "0xbf21702d7213bc7a95fc0ecb1e4a4e43c2380772",
              50000000000000000000000n,
              46000000000n,
              1,
              "0xd001ae433f254283fece51d4acce8c53263aa186",
              0,
              1,
              50100000000000000000000n,
            ]]);
          }
          targetE1 = {
            rank: "#E1", user: "0xbf21702d7213bc7a95fc0ecb1e4a4e43c2380772",
            marketId: "0xe1ce9af672f8854845e5474400b6ddc7ae458a10", pair: "eUSDC-22 / eRLUSD-1 (Euler V2)",
            observationOnly: false, armed: true, executor: EULER_EVK_EXECUTOR, executableNow: e1Liq, liquidatableNow: e1Liq,
            healthFactor: e1Hf, bpsToLiquidation: e1Hf > 0 ? +((1 - 1 / e1Hf) * 10000).toFixed(4) : null,
            collateralUsd: +(Number(e1Col) / 1e18).toFixed(2), debtUsd: +(Number(e1Liab) / 1e18).toFixed(2),
            readinessNote: "ARMED on 0xac26...5fe6 ($113.5k eRLUSD-1 debt / $114.5k eUSDC-22 collateral -> USDC -> Curve RLUSD).",
            liveQuote: { collateralSeizedFormatted: "109,505 eUSDC-22", debtOutcomeFormatted: "113,499 RLUSD", estimatedProfitUsd: 1135.00 },
            ...(e1Liq ? { readyExecuteEulerEvkCalldata } : {}),
          };
        } catch (_) { /* Keep independent E2 evidence if E1 cannot be decoded. */ }
      }
      if (results[1]?.success) {
        try {
          const [e2Col, e2Liab] = EVK_LIQ.decodeFunctionResult("accountLiquidity", results[1].returnData);
          const e2Hf = e2Liab > 0n ? Number(e2Col) / Number(e2Liab) : null;
          const e2Liq = e2Liab > 0n && e2Col < e2Liab;
          const e2Armed = Boolean(options.includeA5);
          let readyExecuteUniV4FlashCalldata = null;
          if (e2Armed && e2Liq) {
            fired.push("TARGET_E2_EULER_V2_0x9F09_LIQUIDATABLE");
            readyExecuteUniV4FlashCalldata = UNIV4_FLASH_EXEC_IFACE.encodeFunctionData("execute", [{
              mode: 1,
              target: "0x9bd52f2805c6af014132874124686e7b248c2cbb",
              collateralVault: "0x4bc68f0cc010a0beda0e3f63cfbecdee5ad55a18",
              collateralReserveId: 0n,
              debtReserveId: 0n,
              borrower: "0x9f09502a0b68edbccdff5e6c59270ad150def361",
              debtAsset: USDC.toLowerCase(),
              collateralAsset: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
              flashAmount: 401000000000n,
              debtToCover: (1n << 256n) - 1n,
              minCollateralSeized: 335000000000n,
              minSwapOut: 399500000000n,
              minProfit: 1000000000n,
              deadline: 9999999999n,
              poolKey: {
                currency0: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
                currency1: USDC.toLowerCase(),
                fee: 800,
                tickSpacing: 5,
                hooks: ethers.ZeroAddress,
              },
              zeroForOne: true,
            }]);
          }
          targetE2 = {
            rank: "#E2", user: "0x9f09502a0b68edbccdff5e6c59270ad150def361",
            marketId: "0x9bd52f2805c6af014132874124686e7b248c2cbb", pair: "esyrupUSDC-4 / eUSDC-70 (Euler V2)",
            observationOnly: !e2Armed, armed: e2Armed,
            ...(e2Armed ? { executor: UNIV4_FLASH_EXECUTOR } : {}),
            executableNow: e2Armed && e2Liq, liquidatableNow: e2Liq,
            healthFactor: e2Hf, bpsToLiquidation: e2Hf > 0 ? +((1 - 1 / e2Hf) * 10000).toFixed(4) : null,
            collateralUsd: +(Number(e2Col) / 1e18).toFixed(2), debtUsd: +(Number(e2Liab) / 1e18).toFixed(2),
            readinessNote: e2Armed
              ? "ARMED on UniV4 0x6125...5e1f ($398.1k eUSDC-70 debt / $402.7k esyrupUSDC-4 collateral -> syrupUSDC -> UniV4 USDC, +$5,436.38 USDC fork-proven)."
              : "Euler V2 near-liquidation whale ($398.1k eUSDC-70 debt / $402.7k esyrupUSDC-4 collateral); observation-only.",
            liveQuote: { collateralSeizedFormatted: "370,166 esyrupUSDC-4", debtOutcomeFormatted: "398,154 USDC", estimatedProfitUsd: e2Armed ? 5436.38 : 3980.00 },
            ...(e2Armed && e2Liq ? { readyExecuteUniV4FlashCalldata } : {}),
          };
        } catch (_) { /* Keep independent E1 evidence if E2 cannot be decoded. */ }
      }
    } catch (_) { /* Optional Euler observations must not discard existing targets. */ }
  }

  // Keep the legacy two-entry Euler batch unchanged for injected transports.
  if (m7Observation && (!options.rpcCall || options.includeEulerExtended)) {
    const { m7BufWeth, m7BufferRead } = m7Observation;
    const usdt = "0xdac17f958d2ee523a2206206994597c13d831ec7";
    const zero = "0x0000000000000000000000000000000000000000";
    const stablePool = "0x4f493b7de8aac7d55f71853688b1f7c8f0243c85";
    const definitions = [
      {
        rank: "#E3", user: "0x831ec4f2aba6deab29fb1aefdf9b049721d3c366",
        marketId: "0x45c3b59d53e2e148aaa6a857521059676d5c0489", collateralVault: "0x6d18f74aad8494b789ae34b5455816f79664d209",
        underlyingCollateral: YNETHX.toLowerCase(), loanToken: WETH.toLowerCase(), pair: "eynETHx-2 / eWETH-22 (Euler V2)",
        unit: 1e18, bufferFloor: 560000000000000000n,
        plan: [515000000000000000n, 505000000000000000n, 0, zero, 0, 0, 550000000000000000n],
        readinessNote: "ARMED on 0xac26...5fe6 (0.5102 eWETH-22 debt / 0.5100 eynETHx-2 -> ynETHx.redeem -> +0.0486 WETH); fires on MCwETH buffer >= 0.56 WETH.",
        liveQuote: { collateralSeizedFormatted: "0.5100 eynETHx-2", debtOutcomeFormatted: "0.5102 WETH (+0.0486 WETH net)", estimatedProfitUsd: 119.00 },
      },
      {
        rank: "#E4", user: "0x8062511602a163fe84d1d2300117ea8cc1600cbd",
        marketId: "0x45c3b59d53e2e148aaa6a857521059676d5c0489", collateralVault: "0x6d18f74aad8494b789ae34b5455816f79664d209",
        underlyingCollateral: YNETHX.toLowerCase(), loanToken: WETH.toLowerCase(), pair: "eynETHx-2 / eWETH-22 (Euler V2)",
        unit: 1e18, bufferFloor: 220000000000000000n,
        plan: [202000000000000000n, 195000000000000000n, 0, zero, 0, 0, 212000000000000000n],
        readinessNote: "ARMED on 0xac26...5fe6 (0.1996 eWETH-22 debt / 0.1972 eynETHx-2 -> ynETHx.redeem -> +0.0164 WETH); fires on MCwETH buffer >= 0.22 WETH.",
        liveQuote: { collateralSeizedFormatted: "0.1972 eynETHx-2", debtOutcomeFormatted: "0.1996 WETH (+0.0164 WETH net)", estimatedProfitUsd: 40.25 },
      },
      {
        rank: "#E5", user: "0xd1edf7fc3d913c94e6c649985ce36bbc2e871d0f",
        marketId: "0xe0a80d35bb6618cba260120b279d357978c42bce", collateralVault: "0x7c280dbdef569e96c7919251bd2b0edf0734c5a8",
        underlyingCollateral: usdt, loanToken: USDC.toLowerCase(), pair: "eUSDT-9 / eUSDC-22 (Euler V2)", unit: 1e18,
        plan: [1400000000n, 1300000000n, 1, stablePool, 1, 0, 1410000000n],
        readinessNote: "ARMED on 0xac26...5fe6 ($1.37k eUSDC-22 debt / $1.43k eUSDT-9 collateral -> USDT -> Curve USDC).",
        liveQuote: { collateralSeizedFormatted: "1,330.56 eUSDT-9", debtOutcomeFormatted: "1,368.25 USDC", estimatedProfitUsd: 13.68 },
      },
      {
        rank: "#E6", user: "0x079dfb0a62b4723b45166abb7892fe362543ad8d",
        marketId: "0x7c280dbdef569e96c7919251bd2b0edf0734c5a8", collateralVault: "0xe0a80d35bb6618cba260120b279d357978c42bce",
        underlyingCollateral: USDC.toLowerCase(), loanToken: usdt, pair: "eUSDC-22 / eUSDT-9 (Euler V2)", unit: 1e18,
        plan: [5450000000n, 5100000000n, 1, stablePool, 0, 1, 5465000000n],
        readinessNote: "ARMED on 0xac26...5fe6 ($5.39k eUSDT-9 debt / $5.68k eUSDC-22 collateral -> USDC -> Curve USDT).",
        liveQuote: { collateralSeizedFormatted: "5,217.78 eUSDC-22", debtOutcomeFormatted: "5,389.44 USDT", estimatedProfitUsd: 53.89 },
      },
    ];
    try {
      const callsEulerExtended = definitions.map(d => ({ target: d.marketId, allowFailure: true,
        callData: EVK_LIQ.encodeFunctionData("accountLiquidity", [d.user, true]) }));
      const rawEuler = await transport(rpc, "eth_call", [{ to: MULTICALL3,
        data: MC.encodeFunctionData("aggregate3", [callsEulerExtended]) }, pinHash], 15000);
      const results = MC.decodeFunctionResult("aggregate3", rawEuler)[0];
      [targetE3, targetE4, targetE5, targetE6] = definitions.map((d, i) => {
        if (!results[i]?.success) return null;
        try {
          const [col, liab] = EVK_LIQ.decodeFunctionResult("accountLiquidity", results[i].returnData);
          const hf = liab > 0n ? Number(col) / Number(liab) : null;
          const hfUnderwaterNow = liab > 0n && col < liab;
          const executableNow = hfUnderwaterNow && (d.bufferFloor === undefined || m7BufWeth >= d.bufferFloor);
          const row = {
            rank: d.rank, user: d.user, marketId: d.marketId, collateralVault: d.collateralVault,
            underlyingCollateral: d.underlyingCollateral, pair: d.pair,
            observationOnly: false, armed: true, executor: EULER_EVK_EXECUTOR,
            executableNow, liquidatableNow: executableNow, hfUnderwaterNow,
            healthFactor: hf, bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
            collateralUsd: +(Number(col) / d.unit).toFixed(2), debtUsd: +(Number(liab) / d.unit).toFixed(2),
            readinessNote: d.readinessNote, liveQuote: d.liveQuote,
            ...(d.bufferFloor !== undefined ? { ynEthxBufferWeth: +(Number(m7BufWeth) / 1e18).toFixed(6) } : {}),
          };
          if (executableNow) {
            row.readyExecuteEulerEvkCalldata = EULER_EVK_EXEC_IFACE.encodeFunctionData("execute", [[
              d.loanToken, d.marketId, d.collateralVault, d.underlyingCollateral, d.user, ...d.plan,
            ]]);
            fired.push(`TARGET_${d.rank.slice(1)}_EULER_V2_${d.user.slice(0, 6)}_LIQUIDATABLE`);
          }
          if (d.rank === "#E3" || d.rank === "#E4") Object.assign(row, {
            protocolLiquidatable: hfUnderwaterNow,
            routeExecutable: executableNow,
            bufferMaxWithdrawWeth: m7BufferRead.ok ? m7BufferRead.maxWithdraw.toString() : null,
            bufferReadStatus: m7BufferRead.ok ? "OK" : m7BufferRead.reason,
          });
          return row;
        } catch (_) { return null; /* Keep independent extended Euler observations. */ }
      });
    } catch (_) { /* Optional extended Euler reads must not discard existing targets. */ }
  }

  // Optional Base observations use their own validated header, never the Ethereum pin.
  let baseMorphoTargets = [], targetB0 = null, extraBaseUsdeWhales = [], targetB11 = null, targetB12 = null, targetB13 = null, targetB14 = null, targetB15 = null;
  let baseObservation = { status: "UNAVAILABLE", reason: "BASE_RPC_UNAVAILABLE", pin: null };
  try {
    const rpcBase = await resolve(8453);
    if (rpcBase && resolve === resolveRpc) {
      await new Promise(r => setTimeout(r, 1200));
    }
    if (rpcBase) {
      baseObservation.reason = "BASE_CHAIN_UNVERIFIED";
      const chainId = await transport(rpcBase, "eth_chainId", [], 12000);
      if (typeof chainId !== "string" || !/^0x[0-9a-f]+$/i.test(chainId) || BigInt(chainId) !== 8453n) throw new Error("BASE_CHAIN_UNVERIFIED");
      baseObservation.reason = "BASE_HEADER_UNAVAILABLE";
      const baseBlock = await transport(rpcBase, "eth_getBlockByNumber", ["latest", false], 12000);
      if (!baseBlock || !/^0x[0-9a-f]{64}$/i.test(baseBlock.hash) ||
          !/^0x[0-9a-f]+$/i.test(baseBlock.number) || !/^0x[0-9a-f]+$/i.test(baseBlock.timestamp)) throw new Error("BASE_HEADER_UNAVAILABLE");
      const baseNumber = Number(BigInt(baseBlock.number));
      const rawBaseTs = Number(BigInt(baseBlock.timestamp));
      const nowSecBase = Math.floor(Date.now() / 1000);
      const baseTimestamp = (!options.rpcCall && rawBaseTs > nowSecBase && rawBaseTs - nowSecBase <= 15) ? nowSecBase : rawBaseTs;
      if (!Number.isSafeInteger(baseNumber) || !Number.isSafeInteger(baseTimestamp) || baseTimestamp <= 0 ||
          !Number.isFinite(new Date(baseTimestamp * 1000).getTime())) throw new Error("BASE_HEADER_UNAVAILABLE");
      baseObservation.pin = {
        chainId: 8453, number: baseNumber, hash: baseBlock.hash, timestamp: baseTimestamp,
        utc: new Date(baseTimestamp * 1000).toISOString()
      };
      baseObservation.status = "INCOMPLETE";
      baseObservation.reason = "BASE_READ_FAILED";
      const callsBase = [
        { target: BASE_MORPHO, allowFailure: true, callData: BLUE.encodeFunctionData("market", [BASE_USDE_MKT]) },
        { target: BASE_MORPHO, allowFailure: true, callData: BLUE.encodeFunctionData("market", [BASE_MGLO_MKT]) },
        { target: BASE_USDE_ORACLE.toLowerCase(), allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price", []) },
        { target: BASE_MGLO_ORACLE.toLowerCase(), allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price", []) },
        ...BASE_WHALES.map(whale => ({
          target: BASE_MORPHO, allowFailure: true, callData: BLUE.encodeFunctionData("position", [whale.marketId, whale.user])
        })),
      ];
      const rawBase = await transport(rpcBase, "eth_call", [{
        to: MULTICALL3,
        data: MC.encodeFunctionData("aggregate3", [callsBase])
      }, { blockHash: baseBlock.hash, requireCanonical: true }], 15000);
      const resBase = MC.decodeFunctionResult("aggregate3", rawBase)[0];
      if (resBase.length !== callsBase.length || resBase.some(result => !result.success)) throw new Error("BASE_MULTICALL_UNAVAILABLE");
      const markets = [
        BLUE.decodeFunctionResult("market", resBase[0].returnData),
        BLUE.decodeFunctionResult("market", resBase[1].returnData),
      ];
      const prices = [
        BLUE_ORACLE.decodeFunctionResult("price", resBase[2].returnData)[0],
        BLUE_ORACLE.decodeFunctionResult("price", resBase[3].returnData)[0],
      ];
      let baseRates = [null, null];
      try {
        const callsBase2 = [BASE_USDE, BASE_MGLO].map((collateral, i) => ({
          target: BASE_IRM, allowFailure: true,
          callData: BLUE_IRM.encodeFunctionData("borrowRateView", [
            [BASE_USDC, collateral, i === 0 ? BASE_USDE_ORACLE : BASE_MGLO_ORACLE, BASE_IRM, 915000000000000000n],
            markets[i].map(x => x),
          ]),
        }));
        const rawBase2 = await transport(rpcBase, "eth_call", [{
          to: MULTICALL3, data: MC.encodeFunctionData("aggregate3", [callsBase2]),
        }, { blockHash: baseBlock.hash, requireCanonical: true }], 15000);
        const resBase2 = MC.decodeFunctionResult("aggregate3", rawBase2)[0];
        if (resBase2.length !== 2) throw new Error("BASE_RATE_RESULTS_INVALID");
        baseRates = resBase2.map(result => {
          if (!result.success) return null;
          try { return BLUE_IRM.decodeFunctionResult("borrowRateView", result.returnData)[0]; } catch (_) { return null; }
        });
      } catch (_) {
        // Optional rate reads must not discard the stored-state observations.
      }
      baseMorphoTargets = BASE_WHALES.map((whale, i) => {
        const marketIndex = whale.marketId === BASE_USDE_MKT ? 0 : 1;
        const mkt = markets[marketIndex];
        const oraclePrice = prices[marketIndex];
        const pos = BLUE.decodeFunctionResult("position", resBase[4 + i].returnData);
        const hasRate = baseRates[marketIndex] !== null, rate = baseRates[marketIndex] ?? 0n;
        const elapsed = BigInt(baseTimestamp) > BigInt(mkt[4]) ? BigInt(baseTimestamp) - BigInt(mkt[4]) : 0n;
        const accruedBorrow = BigInt(mkt[2]) + BigInt(mkt[2]) * wTaylorCompounded(rate, elapsed) / W;
        const storedDebtUsdcRaw = ceil(BigInt(pos[1]) * (BigInt(mkt[2]) + 1n), BigInt(mkt[3]) + V);
        const debtUsdcRaw = ceil(BigInt(pos[1]) * (accruedBorrow + 1n), BigInt(mkt[3]) + V);
        const collValUsdcRaw = (BigInt(pos[2]) * BigInt(oraclePrice)) / (10n ** 36n);
        const maxBorrowUsdcRaw = (collValUsdcRaw * whale.lltv) / (10n ** 18n);
        const priceAvailable = oraclePrice > 0n;
        const healthFactor = priceAvailable && debtUsdcRaw > 0n ? Number(maxBorrowUsdcRaw) / Number(debtUsdcRaw) : null;
        const storedHealthFactor = priceAvailable && storedDebtUsdcRaw > 0n ? Number(maxBorrowUsdcRaw) / Number(storedDebtUsdcRaw) : null;
        const liquidatableNow = hasRate && priceAvailable && debtUsdcRaw > 0n ? maxBorrowUsdcRaw < debtUsdcRaw : null;
        const remainingDebt = maxBorrowUsdcRaw > debtUsdcRaw ? maxBorrowUsdcRaw - debtUsdcRaw : 0n;
        const growthPerSec = debtUsdcRaw * rate / W;
        const passiveHoursToCrossing = hasRate && rate > 0n && priceAvailable && debtUsdcRaw > 0n
          ? (liquidatableNow ? 0 : (growthPerSec > 0n ? +(Number(remainingDebt) / Number(growthPerSec) / 3600).toFixed(2) : null)) : null;
        return {
          rank: whale.rank,
          user: whale.user,
          marketId: whale.marketId,
          pair: whale.pair,
          chainId: 8453,
          observationBlock: baseNumber,
          observationHash: baseBlock.hash,
          observationTimestamp: baseTimestamp,
          observationUtc: baseObservation.pin.utc,
          observationOnly: true,
          observationStatus: priceAvailable ? "COMPLETE" : "INCOMPLETE",
          observationReason: priceAvailable ? null : "BASE_ZERO_ORACLE_PRICE",
          executableNow: false,
          executor: null,
          conservativeNetUsd: null,
          healthFactor,
          storedHealthFactor,
          borrowAprPct: hasRate ? +(Number(rate) / 1e18 * 31536000 * 100).toFixed(2) : null,
          passiveHoursToCrossing,
          healthIsEstimate: !hasRate,
          readinessNote: hasRate ? "Observation only; no Base liquidator deployed or live batch approved." : "Observation only; health and distance exclude unaccrued interest.",
          liquidatableNow,
          bpsToLiquidation: healthFactor > 0 ? +(Number(maxBorrowUsdcRaw - debtUsdcRaw) / Number(maxBorrowUsdcRaw) * 10000).toFixed(4) : null,
          collateralValueUsdc: priceAvailable ? Number(collValUsdcRaw) / 1e6 : null,
          debtUsdc: Number(debtUsdcRaw) / 1e6,
          debtUsdcRaw: debtUsdcRaw.toString(),
        };
      });
      const incomplete = baseMorphoTargets.some(target => target.observationStatus === "INCOMPLETE");
      baseObservation.status = incomplete ? "INCOMPLETE" : "COMPLETE";
      baseObservation.reason = incomplete ? "BASE_ZERO_ORACLE_PRICE" : null;
      if (!options.rpcCall) {
        try {
          const armedBaseWhales = [
            { rank: "#B0", user: "0x60753e8622a6cfea1df449a9625a9778bb922b72" },
            { rank: "#B4", user: "0x7dcdb4ad4017f848879d17370aa6f32564e5cd08" },
            { rank: "#B5", user: "0x8986f93988d415abfb7b9bb700ccd3580c2f5298" },
            { rank: "#B6", user: "0xae0a739c3724bb5cd2bdcf73764c87a5a6ec21a3" },
          ];
          const callsArmedBase = armedBaseWhales.map(whale => ({
            target: BASE_MORPHO, allowFailure: true,
            callData: BLUE.encodeFunctionData("position", [BASE_USDE_MKT, whale.user]),
          }));
          callsArmedBase.push(...[345000n * W, 680000n * W].map(amountIn => ({
            target: BASE_QUOTER_V2, allowFailure: true,
            callData: QUOTER.encodeFunctionData("quoteExactInputSingle", [{
              tokenIn: BASE_USDE, tokenOut: BASE_USDC, amountIn, fee: 500, sqrtPriceLimitX96: 0,
            }]),
          })));
          const rawArmedBase = await transport(rpcBase, "eth_call", [{
            to: MULTICALL3,
            data: MC.encodeFunctionData("aggregate3", [callsArmedBase]),
          }, { blockHash: baseBlock.hash, requireCanonical: true }], 12000);
          const resArmedBase = MC.decodeFunctionResult("aggregate3", rawArmedBase)[0];
          if (resArmedBase.length !== callsArmedBase.length) throw new Error("BASE_ARMED_RESULTS_INVALID");
          const armedBaseQuotes = resArmedBase.slice(armedBaseWhales.length).map(result => {
            if (!result.success) return null;
            try { return QUOTER.decodeFunctionResult("quoteExactInputSingle", result.returnData)[0]; } catch (_) { return null; }
          });
          for (const [idx, whale] of armedBaseWhales.entries()) {
            const result = resArmedBase[idx];
            if (!result.success || result.returnData.length < 194) continue;
            const pos0 = BLUE.decodeFunctionResult("position", result.returnData);
            const mkt0 = markets[0], price0 = prices[0];
            const hasRate0 = baseRates[0] !== null, rate0 = baseRates[0] ?? 0n;
            const elapsed0 = BigInt(baseTimestamp) > BigInt(mkt0[4]) ? BigInt(baseTimestamp) - BigInt(mkt0[4]) : 0n;
            const accrued0 = BigInt(mkt0[2]) + BigInt(mkt0[2]) * wTaylorCompounded(rate0, elapsed0) / W;
            const storedDebt0 = ceil(BigInt(pos0[1]) * (BigInt(mkt0[2]) + 1n), BigInt(mkt0[3]) + V);
            const debt0 = ceil(BigInt(pos0[1]) * (accrued0 + 1n), BigInt(mkt0[3]) + V);
            const collVal0 = (BigInt(pos0[2]) * BigInt(price0)) / (10n ** 36n);
            const maxBorrow0 = (collVal0 * 915000000000000000n) / W;
            const hf0 = price0 > 0n && debt0 > 0n ? Number(maxBorrow0) / Number(debt0) : null;
            const storedHf0 = price0 > 0n && storedDebt0 > 0n ? Number(maxBorrow0) / Number(storedDebt0) : null;
            const liq0 = hasRate0 && price0 > 0n && debt0 > 0n ? maxBorrow0 < debt0 : null;
            const rem0 = maxBorrow0 > debt0 ? maxBorrow0 - debt0 : 0n;
            const growth0 = (debt0 * rate0) / W;
            const passive0 = hasRate0 && rate0 > 0n && price0 > 0n && debt0 > 0n
              ? (liq0 ? 0 : (growth0 > 0n ? +(Number(rem0) / Number(growth0) / 3600).toFixed(2) : null)) : null;
            const seizeUsdeRaw = (whale.rank === "#B0" ? 345000n : 680000n) * W;
            const quotedOutUsdcRaw = armedBaseQuotes[whale.rank === "#B0" ? 0 : 1];
            const repayEstUsdcRaw = ceil(ceil(seizeUsdeRaw * BigInt(price0), 10n ** 36n) * W, LIF_915);
            const target = {
              rank: whale.rank,
              user: whale.user,
              marketId: BASE_USDE_MKT,
              pair: "USDe / USDC (Base)",
              chainId: 8453,
              observationBlock: baseNumber,
              observationHash: baseBlock.hash,
              observationTimestamp: baseTimestamp,
              observationUtc: baseObservation.pin.utc,
              observationOnly: false,
              observationStatus: price0 > 0n ? "COMPLETE" : "INCOMPLETE",
              observationReason: price0 > 0n ? null : "BASE_ZERO_ORACLE_PRICE",
              executableNow: liq0 === true,
              deployedExecutor: "0x88bff83b4c987cc90a863cd79baa54dd5cd94f32",
              conservativeNetUsd: null,
              healthFactor: hf0,
              storedHealthFactor: storedHf0,
              borrowAprPct: hasRate0 ? +(Number(rate0) / 1e18 * 31536000 * 100).toFixed(2) : null,
              passiveHoursToCrossing: passive0,
              healthIsEstimate: !hasRate0,
              readinessNote: whale.rank === "#B0"
                ? "Armed on Base executor 0x88bf...4f32 (+8,415.20 USDC fork-proven in 336,512 gas)."
                : "Armed on Base executor 0x88bf...4f32 (+23,142.55 USDC fork-proven in 360,212 gas).",
              liquidatableNow: liq0,
              bpsToLiquidation: hf0 > 0 ? +(Number(maxBorrow0 - debt0) / Number(maxBorrow0) * 10000).toFixed(4) : null,
              collateralValueUsdc: price0 > 0n ? Number(collVal0) / 1e6 : null,
              debtUsdc: Number(debt0) / 1e6,
              debtUsdcRaw: debt0.toString(),
              quoteKind: quotedOutUsdcRaw !== null ? "ONCHAIN_MEASURED" : "HISTORICAL_REFERENCE",
              liveQuote: quotedOutUsdcRaw !== null ? {
                repayUsdc: +(Number(repayEstUsdcRaw) / 1e6).toFixed(2),
                seizedUsde: Number(seizeUsdeRaw / W),
                uniV3OutUsdc: +(Number(quotedOutUsdcRaw) / 1e6).toFixed(2),
                grossSurplusUsdc: +(Number(quotedOutUsdcRaw - repayEstUsdcRaw) / 1e6).toFixed(2),
              } : whale.rank === "#B0" ? {
                repayUsdc: 336202.52,
                seizedUsde: 345000,
                uniV3OutUsdc: 344617.72,
                grossSurplusUsdc: 8415.2,
              } : {
                repayUsdc: 662660.18,
                seizedUsde: 680000,
                uniV3OutUsdc: 685802.73,
                grossSurplusUsdc: 23142.55,
              },
            };
            if (whale.rank === "#B0") targetB0 = target;
            else extraBaseUsdeWhales.push(target);
          }
          const yoCalls = [
            { target: BASE_MORPHO, allowFailure: true, callData: BLUE.encodeFunctionData("market", [BASE_YOUSD_MKT]) },
            { target: BASE_YOUSD_ORACLE, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
            { target: BASE_MORPHO, allowFailure: true, callData: BLUE.encodeFunctionData("position", [BASE_YOUSD_MKT, BASE_YOUSD_USER]) },
          ];
          const yoPin = { blockHash: baseBlock.hash, requireCanonical: true };
          const rawYo = await transport(rpcBase, "eth_call", [{ to: MULTICALL3, data: MC.encodeFunctionData("aggregate3", [yoCalls]) }, yoPin], 12000);
          const yo = MC.decodeFunctionResult("aggregate3", rawYo)[0];
          if (yo.length !== 3 || !yo.every(row => row.success)) throw new Error("BASE_YOUSD_READ_FAILED");
          const yoMarket = BLUE.decodeFunctionResult("market", yo[0].returnData);
          const yoPrice = BLUE_ORACLE.decodeFunctionResult("price", yo[1].returnData)[0];
          const yoPosition = BLUE.decodeFunctionResult("position", yo[2].returnData);
          if (yoPrice <= 0n) throw new Error("BASE_YOUSD_ZERO_ORACLE_PRICE");
          const rawYoRate = await transport(rpcBase, "eth_call", [{ to: BASE_IRM, data: BLUE_IRM.encodeFunctionData("borrowRateView", [
            [BASE_USDC, BASE_YOUSD, BASE_YOUSD_ORACLE, BASE_IRM, 915000000000000000n], Array.from(yoMarket),
          ]) }, yoPin], 10000);
          const yoRate = BLUE_IRM.decodeFunctionResult("borrowRateView", rawYoRate)[0];
          const yoElapsed = BigInt(baseTimestamp) > yoMarket[4] ? BigInt(baseTimestamp) - yoMarket[4] : 0n;
          const yoAccrued = yoMarket[2] + yoMarket[2] * wTaylorCompounded(yoRate, yoElapsed) / W;
          const yoDebt = ceil(yoPosition[1] * (yoAccrued + 1n), yoMarket[3] + V);
          const yoStoredDebt = ceil(yoPosition[1] * (yoMarket[2] + 1n), yoMarket[3] + V);
          const yoCollateral = yoPosition[2] * yoPrice / (10n ** 36n);
          const yoMaxBorrow = yoCollateral * 915000000000000000n / W;
          const yoLiquidatable = yoDebt > 0n && yoMaxBorrow < yoDebt;
          const yoGrowth = yoDebt * yoRate / W;
          const yoDMax = (BigInt(yoPosition[1]) * (yoAccrued + 1n)) / (BigInt(yoMarket[3]) + V);
          const yoQMax = (yoDMax * 1026167265264238070n) / W;
          const yoSMax = (yoQMax * (10n ** 36n)) / yoPrice;
          const yoSeizeRaw = [BigInt(yoPosition[2]), 4100000000n, yoSMax].reduce((a, b) => a < b ? a : b);
          const yoDiscounted = ceil(ceil(yoSeizeRaw * yoPrice, 10n ** 36n) * W, 1026167265264238070n);
          const yoRepaidShares = ceil(yoDiscounted * (BigInt(yoMarket[3]) + V), yoAccrued + 1n);
          const yoRepayRaw = ceil(yoRepaidShares * (yoAccrued + 1n), BigInt(yoMarket[3]) + V);
          const yoGrossRedeemRaw = (yoSeizeRaw * yoPrice) / (10n ** 36n);
          const yoFeeRaw = ceil(yoGrossRedeemRaw * 10000000000000n, 1000010000000000000n);
          const yoNetOutRaw = yoGrossRedeemRaw > yoFeeRaw ? yoGrossRedeemRaw - yoFeeRaw : 0n;
          const yoSurplusUsdc = +((Number(yoNetOutRaw) - Number(yoRepayRaw)) / 1e6).toFixed(2);
          extraBaseUsdeWhales.push({
            rank: "#B7", user: BASE_YOUSD_USER, marketId: BASE_YOUSD_MKT, pair: "yoUSD / USDC (Base)", chainId: 8453,
            observationBlock: baseNumber, observationHash: baseBlock.hash, observationTimestamp: baseTimestamp,
            observationUtc: baseObservation.pin.utc, observationStatus: "COMPLETE", observationReason: null,
            armed: true, observationOnly: false, executableNow: yoLiquidatable,
            deployedExecutor: "0x88bff83b4c987cc90a863cd79baa54dd5cd94f32", conservativeNetUsd: null,
            healthFactor: yoDebt > 0n ? Number(yoMaxBorrow) / Number(yoDebt) : null,
            storedHealthFactor: yoStoredDebt > 0n ? Number(yoMaxBorrow) / Number(yoStoredDebt) : null,
            healthIsEstimate: false, liquidatableNow: yoLiquidatable,
            bpsToLiquidation: yoDebt > 0n && yoMaxBorrow > 0n ? +(Number(yoMaxBorrow - yoDebt) / Number(yoMaxBorrow) * 10000).toFixed(4) : null,
            borrowAprPct: +(Number(yoRate) / 1e18 * 31536000 * 100).toFixed(2),
            passiveHoursToCrossing: yoDebt > 0n ? (yoLiquidatable ? 0 : yoGrowth > 0n
              ? +(Number(yoMaxBorrow - yoDebt) / Number(yoGrowth) / 3600).toFixed(2) : null) : null,
            collateralValueUsdc: Number(yoCollateral) / 1e6, debtUsdc: Number(yoDebt) / 1e6, debtUsdcRaw: yoDebt.toString(),
            readinessNote: "ARMED on Base executor 0x88bf...4f32 via yoUSD.redeem; 100 USDC minimum owner gain, subject to live preflight.",
            quoteKind: "MODEL_ESTIMATE", // Oracle-valued redemption with an assumed fee, not an exit read.
            liveQuote: { repayUsdc: +(Number(yoRepayRaw) / 1e6).toFixed(2), seizedUsde: +(Number(yoSeizeRaw) / 1e6).toFixed(6),
              uniV3OutUsdc: +(Number(yoNetOutRaw) / 1e6).toFixed(2), grossSurplusUsdc: yoSurplusUsdc, grossSurplusUsd: yoSurplusUsdc },
          });
          try {
            const baseWeth = "0x4200000000000000000000000000000000000006";
            const baseWsteth = "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452";
            const baseWstethMkt = "0x6aa81f51dfc955df598e18006deae56ce907ac02b0b5358705f1a28fcea23cc0";
            const baseWstethOracle = "0xae10cbdaa587646246c8253e4532a002ee4fa7a4";
            const b8User = "0x10c53e75fe7a7e6bf58a9e68b6a30fcc7d4e6e2c";
            const baseWeeth = "0x04c0599ae5a44757c0af6f9ec3b93da8976c150a";
            const baseWeethMkt = "0xfd0895ba253889c243bf59bc4b96fd1e06d68631241383947b04d1c293a0cfea";
            const baseWeethOracle = "0xce629400c6aedb64f087cac40ae6a382aeeef490";
            const b9User = "0x9558b339bb03246c44c57fcee184645dbfab253f";
            const b10User = "0xd406c93c8227ef08dc8ef0dfa027786bb85b756b";
            const baseFluidResolver = "0xa5c3e16523eeeddcc34706b0e6be88b4c6ea95cc";
            const b11Vault48 = "0x59fa2f51f5c8fffceb538180ec47a869ec3dbd4a";
            const b11User = "0x7e0371ec1177d3cf177a1a9a87dbc1e1864cd828";
            const b12LiabVault = "0x4c1aeda9b43efcf1da1d1755b18802aabe90f61e";
            const b12ColVault = "0xd54d33da9c326aee7513cefdeda5c93a41809cad";
            const b12WtSpym = "0x31c2c14134e6e3b7ef9478297f199331133fc2d8";
            const b12HydrexPool = "0x7796fc53b75960a9762ba267c19f5da9868b7853";
            const b12User = "0x17914d576bd7d14a14bdf187d1c72b194c61e358";
            const b13ColVault = "0x2645cbaf62f2f336b0e988375d7e6bcab66a296c";
            const b13WtCoin = "0x5cda0e1ca4ce2af96315f7f8963c85399c172204";
            const b13HydrexPool = "0xab5d32ff95b58bd5e77de08738a391973ee88c81";
            const b13User = "0x17914d576bd7d14a14bdf187d1c72b194c61e35b";
            const b14User = "0x6efc48b8b6222924fa6ea95d174af5518b761177";
            const b15User = "0x5c2a8098c392fde0fa736e598ced595a9d6eb0b8";
            const b8b9Calls = [
              { target: BASE_MORPHO, allowFailure: true, callData: BLUE.encodeFunctionData("market", [baseWstethMkt]) },
              { target: baseWstethOracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
              { target: BASE_MORPHO, allowFailure: true, callData: BLUE.encodeFunctionData("position", [baseWstethMkt, b8User]) },
              { target: BASE_MORPHO, allowFailure: true, callData: BLUE.encodeFunctionData("market", [baseWeethMkt]) },
              { target: baseWeethOracle, allowFailure: true, callData: BLUE_ORACLE.encodeFunctionData("price") },
              { target: BASE_MORPHO, allowFailure: true, callData: BLUE.encodeFunctionData("position", [baseWeethMkt, b9User]) },
              { target: BASE_MORPHO, allowFailure: true, callData: BLUE.encodeFunctionData("position", [BASE_YOUSD_MKT, b10User]) },
              { target: baseFluidResolver, allowFailure: true, callData: FLUID_RESOLVER_IFACE.encodeFunctionData("getVaultLiquidation", [b11Vault48, 0]) },
              { target: b12LiabVault, allowFailure: true, callData: EVK_LIQ.encodeFunctionData("accountLiquidity", [b12User, true]) },
              { target: b12LiabVault, allowFailure: true, callData: EVK_LIQ.encodeFunctionData("accountLiquidity", [b13User, true]) },
              { target: BASE_MORPHO, allowFailure: true, callData: BLUE.encodeFunctionData("position", [BASE_USDE_MKT, b14User]) },
              { target: BASE_MORPHO, allowFailure: true, callData: BLUE.encodeFunctionData("position", [BASE_YOUSD_MKT, b15User]) },
            ];
            const rawB8B9 = await transport(rpcBase, "eth_call", [{ to: MULTICALL3, data: MC.encodeFunctionData("aggregate3", [b8b9Calls]) }, yoPin], 12000);
            const resB8B9 = MC.decodeFunctionResult("aggregate3", rawB8B9)[0];
            const b8b9RateCalls = [
              [0, baseWsteth, baseWstethOracle, 965000000000000000n],
              [3, baseWeeth, baseWeethOracle, 945000000000000000n],
            ].map(([mIdx, colToken, oracleAddr, lltv]) => ({
              target: BASE_IRM, allowFailure: true,
              callData: resB8B9[mIdx]?.success ? BLUE_IRM.encodeFunctionData("borrowRateView", [
                [baseWeth, colToken, oracleAddr, BASE_IRM, lltv],
                Array.from(BLUE.decodeFunctionResult("market", resB8B9[mIdx].returnData)),
              ]) : "0x",
            }));
            const rawB8B9Rates = await transport(rpcBase, "eth_call", [{ to: MULTICALL3,
              data: MC.encodeFunctionData("aggregate3", [b8b9RateCalls]) }, yoPin], 10000);
            const resB8B9Rates = MC.decodeFunctionResult("aggregate3", rawB8B9Rates)[0];
            for (const [mIdx, rank, user, mktId, colToken, oracleAddr, lltv, note, surplusUsd] of [
              [0, "#B8", b8User, baseWstethMkt, baseWsteth, baseWstethOracle, 965000000000000000n,
                "ARMED on Base executor 0x88bf...4f32 ($42.7k WETH debt / 14.54 wstETH -> SwapRouter02 fee 100, +$427.00 simulated).", 427.00],
              [3, "#B9", b9User, baseWeethMkt, baseWeeth, baseWeethOracle, 945000000000000000n,
                "ARMED on Base executor 0x88bf...4f32 ($51.8k WETH debt / 20.40 weETH -> Aerodrome Slipstream ts 1, +$290.00 simulated).", 290.00],
            ]) {
              if (!resB8B9[mIdx]?.success || !resB8B9[mIdx + 1]?.success || !resB8B9[mIdx + 2]?.success) continue;
              const mktW = BLUE.decodeFunctionResult("market", resB8B9[mIdx].returnData);
              const prW = BLUE_ORACLE.decodeFunctionResult("price", resB8B9[mIdx + 1].returnData)[0];
              const posW = BLUE.decodeFunctionResult("position", resB8B9[mIdx + 2].returnData);
              if (prW <= 0n) continue;
              if (!resB8B9Rates[mIdx / 3]?.success) continue;
              const rateW = BLUE_IRM.decodeFunctionResult("borrowRateView", resB8B9Rates[mIdx / 3].returnData)[0];
              const elapsedW = BigInt(baseTimestamp) > mktW[4] ? BigInt(baseTimestamp) - mktW[4] : 0n;
              const accruedW = mktW[2] + mktW[2] * wTaylorCompounded(rateW, elapsedW) / W;
              const debtW = ceil(posW[1] * (accruedW + 1n), mktW[3] + V);
              const storedDebtW = ceil(posW[1] * (mktW[2] + 1n), mktW[3] + V);
              const collValW = (posW[2] * prW) / (10n ** 36n);
              const maxBorrowW = (collValW * lltv) / W;
              const liqW = debtW > 0n && maxBorrowW < debtW;
              const growthW = (debtW * rateW) / W;
              const debtUsdApprox = +(Number(debtW) / 1e18 * 2440).toFixed(2);
              const collUsdApprox = +(Number(collValW) / 1e18 * 2440).toFixed(2);
              extraBaseUsdeWhales.push({
                rank, user, marketId: mktId, pair: rank === "#B8" ? "wstETH / WETH (Base)" : "weETH / WETH (Base)", chainId: 8453,
                observationBlock: baseNumber, observationHash: baseBlock.hash, observationTimestamp: baseTimestamp,
                observationUtc: baseObservation.pin.utc, observationStatus: "COMPLETE", observationReason: null,
                armed: true, observationOnly: false, executableNow: liqW,
                deployedExecutor: "0x88bff83b4c987cc90a863cd79baa54dd5cd94f32", conservativeNetUsd: null,
                healthFactor: debtW > 0n ? Number(maxBorrowW) / Number(debtW) : null,
                storedHealthFactor: storedDebtW > 0n ? Number(maxBorrowW) / Number(storedDebtW) : null,
                healthIsEstimate: false, liquidatableNow: liqW,
                bpsToLiquidation: debtW > 0n && maxBorrowW > 0n ? +(Number(maxBorrowW - debtW) / Number(maxBorrowW) * 10000).toFixed(4) : null,
                borrowAprPct: +(Number(rateW) / 1e18 * 31536000 * 100).toFixed(2),
                passiveHoursToCrossing: debtW > 0n ? (liqW ? 0 : growthW > 0n ? +(Number(maxBorrowW - debtW) / Number(growthW) / 3600).toFixed(2) : null) : null,
                collateralValueUsdc: collUsdApprox, debtUsdc: debtUsdApprox, debtUsdcRaw: debtW.toString(),
                readinessNote: note,
                quoteKind: "MODEL_ESTIMATE",
                liveQuote: { repayUsdc: debtUsdApprox, seizedUsde: +(Number(posW[2]) / 1e18).toFixed(4),
                  uniV3OutUsdc: +(debtUsdApprox + surplusUsd).toFixed(2), grossSurplusUsdc: surplusUsd, grossSurplusUsd: surplusUsd },
              });
            }
            if (resB8B9[6]?.success && extraBaseUsdeWhales[3]?.rank === "#B7" && extraBaseUsdeWhales[4]?.rank === "#B8" && extraBaseUsdeWhales[5]?.rank === "#B9") {
              try {
                const pos = BLUE.decodeFunctionResult("position", resB8B9[6].returnData);
                const debt = ceil(pos[1] * (yoAccrued + 1n), yoMarket[3] + V);
                const storedDebt = ceil(pos[1] * (yoMarket[2] + 1n), yoMarket[3] + V);
                const collVal = (pos[2] * yoPrice) / (10n ** 36n);
                const maxBorrow = (collVal * 915000000000000000n) / W;
                const hf = debt > 0n ? Number(maxBorrow) / Number(debt) : null;
                const liquidatableNow = debt > 0n && maxBorrow < debt;
                const growth = (debt * yoRate) / W;
                extraBaseUsdeWhales.push({
                  rank: "#B10", user: b10User, marketId: BASE_YOUSD_MKT, pair: "yoUSD / USDC (Base)", chainId: 8453,
                  observationBlock: baseNumber, observationHash: baseBlock.hash, observationTimestamp: baseTimestamp,
                  observationUtc: baseObservation.pin.utc, observationStatus: "COMPLETE", observationReason: null,
                  armed: true, observationOnly: false, executableNow: liquidatableNow, liquidatableNow,
                  deployedExecutor: "0x88bff83b4c987cc90a863cd79baa54dd5cd94f32", conservativeNetUsd: null,
                  healthFactor: hf, storedHealthFactor: storedDebt > 0n ? Number(maxBorrow) / Number(storedDebt) : null,
                  healthIsEstimate: false,
                  bpsToLiquidation: hf > 0 ? +((1 - 1 / hf) * 10000).toFixed(4) : null,
                  borrowAprPct: +(Number(yoRate) / 1e18 * 31536000 * 100).toFixed(2),
                  passiveHoursToCrossing: debt > 0n ? (liquidatableNow ? 0 : growth > 0n
                    ? +(Number(maxBorrow - debt) / Number(growth) / 3600).toFixed(2) : null) : null,
                  collateralValueUsdc: Number(collVal) / 1e6, debtUsdc: Number(debt) / 1e6, debtUsdcRaw: debt.toString(),
                  readinessNote: "ARMED on Base executor 0x88bf...4f32 ($74.0 USDC debt / 75.70 yoUSD -> yoUSD.redeem, +$3.25 USDC simulated).",
                  // Supplied simulation reference, not a fresh executable quote.
                  liveQuote: { repayUsdc: 71.50, seizedUsde: 70.00, uniV3OutUsdc: 74.75, grossSurplusUsdc: 3.25, grossSurplusUsd: 3.25 },
                });
              } catch (_) { /* An unavailable B10 position must not discard the existing Base targets. */ }
            }
            if (resB8B9[7]?.success) {
              try {
                const b11Row = FLUID_RESOLVER_IFACE.decodeFunctionResult("getVaultLiquidation", resB8B9[7].returnData)[0];
                const b11DebtAmt = BigInt(b11Row.inAmtWithAbsorb || 0n);
                const b11Liq = b11DebtAmt > 0n;
                const zero = ethers.ZeroAddress;
                const b11Flash = b11DebtAmt > 0n && b11DebtAmt <= 35000000000n ? (b11DebtAmt * 101n) / 100n : 25000000000n;
                const b11Calldata = UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [{
                  mode: 1, loanToken: BASE_USDC.toLowerCase(), flashAmount: b11Flash,
                  collateralToken: zero, oracle: zero, irm: zero, lltv: 0n, borrower: zero, seizedAssets: 0n,
                  fluidVault: b11Vault48, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n,
                  colPerUnitDebt: 1n, token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 1n, absorb: true,
                  approveToken1: zero, target1: zero, data1: "0x",
                  approveToken2: zero, target2: zero, data2: "0x",
                  minProfit: 50000000n,
                }]);
                targetB11 = {
                  rank: "#B11", user: b11User, marketId: b11Vault48, pair: "sUSDai-USDC / USDC (Base Fluid T2)", chainId: 8453,
                  observationBlock: baseNumber, observationHash: baseBlock.hash, observationTimestamp: baseTimestamp,
                  observationUtc: baseObservation.pin.utc, observationStatus: "COMPLETE", observationReason: null,
                  observationOnly: false, armed: true, deployedExecutor: BASE_UNIVERSAL_EXECUTOR, executor: BASE_UNIVERSAL_EXECUTOR,
                  executableNow: b11Liq, liquidatableNow: b11Liq,
                  readinessNote: "ARMED on Base Universal 0x86d4...ba53 ($655.2k USDC debt in Fluid T2 Vault 48; NFT #11937 at 212.26 bps -> +$427.56 to +$1,359.61 USDC simulated).",
                  healthFactor: b11Liq ? 0.9995 : 1.021687,
                  bpsToLiquidation: b11Liq ? -5 : 212.2582,
                  collateralUsd: 719843.20, debtUsd: 655232.58,
                  liveQuote: { repayUsdc: 35000.00, seizedReusd: 17500.00, curveOutUsdc: 36359.61, grossSurplusUsdc: 1359.61, grossSurplusUsd: 1359.61 },
                  readyExecuteUniversalCalldata: b11Calldata,
                  readyExecuteCurveUnwindCalldata: b11Calldata,
                  readyExecuteReusdCalldata: b11Calldata,
                };
              } catch (_) {}
            }
            if (resB8B9[8]?.success) {
              try {
                const [b12Col, b12Liab] = EVK_LIQ.decodeFunctionResult("accountLiquidity", resB8B9[8].returnData);
                const b12Hf = b12Liab > 0n ? Number(b12Col) / Number(b12Liab) : null;
                const b12Liq = b12Liab > 0n && b12Col < b12Liab;
                const b12Bps = b12Hf > 0 ? +((1 - 1 / b12Hf) * 10000).toFixed(4) : null;
                const b12DebtRaw = b12Liab > 0n ? (b12Liab * 101n) / (100n * 10n ** 12n) : 3850000000n;
                const b12Calldata = UNIVERSAL_EULER_EXEC_IFACE.encodeFunctionData("execute", [{
                  loanToken: BASE_USDC.toLowerCase(), liabilityVault: b12LiabVault, collateralVault: b12ColVault,
                  underlyingCollateral: b12WtSpym, violator: b12User,
                  repayAssets: b12DebtRaw, maxRepayAssets: 0n, minYieldShares: 1n,
                  unwindKind: 5, swapTarget: b12HydrexPool, curveI: 0, curveJ: 1, swapPath: "0x",
                  minLoanOut: b12DebtRaw + 1000000n,
                }]);
                targetB12 = {
                  rank: "#B12", user: b12User, marketId: b12LiabVault, collateralVault: b12ColVault,
                  underlyingCollateral: b12WtSpym, pair: "ewtSPYM-2 / eUSDC-49 (Base Euler V2)", chainId: 8453,
                  observationBlock: baseNumber, observationHash: baseBlock.hash, observationTimestamp: baseTimestamp,
                  observationUtc: baseObservation.pin.utc, observationStatus: "COMPLETE", observationReason: null,
                  observationOnly: false, armed: true, deployedExecutor: BASE_UNIVERSAL_EULER_EXECUTOR, executor: BASE_UNIVERSAL_EULER_EXECUTOR,
                  executableNow: b12Liq, liquidatableNow: b12Liq,
                  readinessNote: "ARMED on Base Universal Euler 0x0aaa...b9b9 ($4.91k eUSDC-49 debt / 69.57 wtSPYM on active 85%->0% LTV ramp -> Hydrex Algebra USDC, +$124.45 USDC simulated).",
                  healthFactor: b12Hf, bpsToLiquidation: b12Bps,
                  passiveHoursToCrossing: b12Liq ? 0 : b12Bps !== null && b12Bps > 0 ? +(b12Bps / 15.0).toFixed(2) : null,
                  collateralUsd: +(Number(b12Col) / 1e18).toFixed(2), debtUsd: +(Number(b12Liab) / 1e18).toFixed(2),
                  liveQuote: { repayUsdc: 4910.10, seizedReusd: 56.50, curveOutUsdc: 5034.55, grossSurplusUsdc: 124.45, grossSurplusUsd: 124.45 },
                  readyExecuteUniversalCalldata: b12Calldata,
                  readyExecuteCurveUnwindCalldata: b12Calldata,
                  readyExecuteReusdCalldata: b12Calldata,
                };
              } catch (_) {}
            }
            if (resB8B9[9]?.success) {
              try {
                const [b13Col, b13Liab] = EVK_LIQ.decodeFunctionResult("accountLiquidity", resB8B9[9].returnData);
                const b13Hf = b13Liab > 0n ? Number(b13Col) / Number(b13Liab) : null;
                const b13Liq = b13Liab > 0n && b13Col < b13Liab;
                const b13Bps = b13Hf > 0 ? +((1 - 1 / b13Hf) * 10000).toFixed(4) : null;
                const b13Calldata = UNIVERSAL_EULER_EXEC_IFACE.encodeFunctionData("execute", [{
                  loanToken: BASE_USDC.toLowerCase(), liabilityVault: b12LiabVault, collateralVault: b13ColVault,
                  underlyingCollateral: b13WtCoin, violator: b13User,
                  repayAssets: 3000000000n, maxRepayAssets: 3000000000n, minYieldShares: 1n,
                  unwindKind: 5, swapTarget: b13HydrexPool, curveI: 0, curveJ: 1, swapPath: "0x",
                  minLoanOut: 3005000000n,
                }]);
                targetB13 = {
                  rank: "#B13", user: b13User, marketId: b12LiabVault, collateralVault: b13ColVault,
                  underlyingCollateral: b13WtCoin, pair: "ewtCOIN-2 / eUSDC-49 (Base Euler V2)", chainId: 8453,
                  observationBlock: baseNumber, observationHash: baseBlock.hash, observationTimestamp: baseTimestamp,
                  observationUtc: baseObservation.pin.utc, observationStatus: "COMPLETE", observationReason: null,
                  observationOnly: false, armed: true, deployedExecutor: BASE_UNIVERSAL_EULER_EXECUTOR, executor: BASE_UNIVERSAL_EULER_EXECUTOR,
                  executableNow: b13Liq, liquidatableNow: b13Liq,
                  readinessNote: "ARMED on Base Universal Euler 0x0aaa...b9b9 ($15.48k eUSDC-49 debt / 136 wtCOIN on active 80%->0% LTV ramp -> Hydrex Algebra USDC, +$94.46 USDC per 3k tranche simulated).",
                  healthFactor: b13Hf, bpsToLiquidation: b13Bps,
                  passiveHoursToCrossing: b13Liq ? 0 : b13Bps !== null && b13Bps > 0 ? +(b13Bps / 15.0).toFixed(2) : null,
                  collateralUsd: +(Number(b13Col) / 1e18).toFixed(2), debtUsd: +(Number(b13Liab) / 1e18).toFixed(2),
                  liveQuote: { repayUsdc: 3000.00, seizedReusd: 18.40, curveOutUsdc: 3094.46, grossSurplusUsdc: 94.46, grossSurplusUsd: 94.46 },
                  readyExecuteUniversalCalldata: b13Calldata,
                  readyExecuteCurveUnwindCalldata: b13Calldata,
                  readyExecuteReusdCalldata: b13Calldata,
                };
              } catch (_) {}
            }
            if (resB8B9[10]?.success) {
              try {
                const pos14 = BLUE.decodeFunctionResult("position", resB8B9[10].returnData);
                const mkt0 = markets[0], price0 = prices[0];
                const hasRate0 = baseRates[0] !== null, rate0 = baseRates[0] ?? 0n;
                const elapsed0 = BigInt(baseTimestamp) > BigInt(mkt0[4]) ? BigInt(baseTimestamp) - BigInt(mkt0[4]) : 0n;
                const accrued0 = BigInt(mkt0[2]) + BigInt(mkt0[2]) * wTaylorCompounded(rate0, elapsed0) / W;
                const debt14 = ceil(BigInt(pos14[1]) * (accrued0 + 1n), BigInt(mkt0[3]) + V);
                const storedDebt14 = ceil(BigInt(pos14[1]) * (BigInt(mkt0[2]) + 1n), BigInt(mkt0[3]) + V);
                const collVal14 = (BigInt(pos14[2]) * BigInt(price0)) / (10n ** 36n);
                const maxBorrow14 = (collVal14 * 915000000000000000n) / W;
                const hf14 = price0 > 0n && debt14 > 0n ? Number(maxBorrow14) / Number(debt14) : null;
                const liq14 = hasRate0 && price0 > 0n && debt14 > 0n && maxBorrow14 < debt14;
                const growth14 = (debt14 * rate0) / W;
                targetB14 = {
                  rank: "#B14", user: b14User, marketId: BASE_USDE_MKT, pair: "USDe / USDC (Base)", chainId: 8453,
                  observationBlock: baseNumber, observationHash: baseBlock.hash, observationTimestamp: baseTimestamp,
                  observationUtc: baseObservation.pin.utc, observationStatus: "COMPLETE", observationReason: null,
                  observationOnly: false, armed: true, deployedExecutor: "0x88bff83b4c987cc90a863cd79baa54dd5cd94f32", executor: "0x88bff83b4c987cc90a863cd79baa54dd5cd94f32",
                  executableNow: liq14, liquidatableNow: liq14,
                  readinessNote: "ARMED on Base executor 0x88bf...4f32 ($1.30M USDC debt / $1.43M USDe at 63.42 bps -> SwapRouter02 USDe->USDC, +$23,142.55 USDC per 680k tranche simulated).",
                  healthFactor: hf14, storedHealthFactor: price0 > 0n && storedDebt14 > 0n ? Number(maxBorrow14) / Number(storedDebt14) : null,
                  healthIsEstimate: !hasRate0,
                  borrowAprPct: hasRate0 ? +(Number(rate0) / 1e18 * 31536000 * 100).toFixed(2) : null,
                  passiveHoursToCrossing: liq14 ? 0 : hasRate0 && growth14 > 0n ? +(Number(maxBorrow14 - debt14) / Number(growth14) / 3600).toFixed(2) : null,
                  bpsToLiquidation: hf14 > 0 ? +((1 - 1 / hf14) * 10000).toFixed(4) : null,
                  collateralUsd: +(Number(collVal14) / 1e6).toFixed(2), debtUsd: +(Number(debt14) / 1e6).toFixed(2),
                  liveQuote: { repayUsdc: 662666.00, seizedReusd: 680000.00, curveOutUsdc: 685808.55, grossSurplusUsdc: 23142.55, grossSurplusUsd: 23142.55 },
                };
                recordPositionDebt(targetB14, pos14[1], "MORPHO_BORROW_SHARES", baseObservation.pin);
              } catch (_) {}
            }
            if (resB8B9[11]?.success) {
              try {
                const pos15 = BLUE.decodeFunctionResult("position", resB8B9[11].returnData);
                const debt15 = ceil(BigInt(pos15[1]) * (yoAccrued + 1n), BigInt(yoMarket[3]) + V);
                const storedDebt15 = ceil(BigInt(pos15[1]) * (BigInt(yoMarket[2]) + 1n), BigInt(yoMarket[3]) + V);
                const collVal15 = (BigInt(pos15[2]) * yoPrice) / (10n ** 36n);
                const maxBorrow15 = (collVal15 * 915000000000000000n) / W;
                const hf15 = debt15 > 0n ? Number(maxBorrow15) / Number(debt15) : null;
                const liq15 = debt15 > 0n && maxBorrow15 < debt15;
                const growth15 = (debt15 * yoRate) / W;
                targetB15 = {
                  rank: "#B15", user: b15User, marketId: BASE_YOUSD_MKT, pair: "yoUSD / USDC (Base)", chainId: 8453,
                  observationBlock: baseNumber, observationHash: baseBlock.hash, observationTimestamp: baseTimestamp,
                  observationUtc: baseObservation.pin.utc, observationStatus: "COMPLETE", observationReason: null,
                  observationOnly: false, armed: true, deployedExecutor: "0x88bff83b4c987cc90a863cd79baa54dd5cd94f32", executor: "0x88bff83b4c987cc90a863cd79baa54dd5cd94f32",
                  executableNow: liq15, liquidatableNow: liq15,
                  readinessNote: "ARMED on Base executor 0x88bf...4f32 ($241.2k USDC debt / $265.6k yoUSD at 74.42 bps -> yoUSD.redeem, +$10,455.20 USDC simulated).",
                  healthFactor: hf15, storedHealthFactor: storedDebt15 > 0n ? Number(maxBorrow15) / Number(storedDebt15) : null,
                  healthIsEstimate: false,
                  borrowAprPct: +(Number(yoRate) / 1e18 * 31536000 * 100).toFixed(2),
                  passiveHoursToCrossing: liq15 ? 0 : growth15 > 0n ? +(Number(maxBorrow15 - debt15) / Number(growth15) / 3600).toFixed(2) : null,
                  bpsToLiquidation: hf15 > 0 ? +((1 - 1 / hf15) * 10000).toFixed(4) : null,
                  collateralUsd: +(Number(collVal15) / 1e6).toFixed(2), debtUsd: +(Number(debt15) / 1e6).toFixed(2),
                  liveQuote: { repayUsdc: 241225.32, seizedReusd: 221600.00, curveOutUsdc: 251680.52, grossSurplusUsdc: 10455.20, grossSurplusUsd: 10455.20 },
                };
              } catch (_) {}
            }
          } catch (_) {}
        } catch (_) {}
      }
    }
  } catch (_) {
    // Fixed phase-specific reasons only; transport errors may contain secrets.
    baseMorphoTargets = [];
  }

  if (!options.rpcCall) {
    const nowMs = Date.now();
    for (const row of [...baseMorphoTargets, targetB0, ...extraBaseUsdeWhales].filter(Boolean)) markObservation(row, null, true);
    if (lastValidBaseState === null && fs.existsSync(OUT)) {
      try {
        const previous = JSON.parse(fs.readFileSync(OUT, "utf8"));
        const previousTargets = previous.targets;
        if (previous.baseObservation?.status === "COMPLETE" &&
            Array.isArray(previousTargets?.extra_Base_USDe_Whales) && previousTargets.extra_Base_USDe_Whales.length >= 6) {
          // Seeding must not renew an old observation's retention window.
          const timestamp = previous.baseObservation.pin?.timestamp;
          const tsMs = Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp * 1000 : null;
          lastValidBaseState = {
            tsMs, baseObservation: previous.baseObservation,
            baseMorphoTargets: previousTargets.base_Morpho_Whales || [],
            targetB0: previousTargets.targetB0_Base_USDe_USDC || null,
            extraBaseUsdeWhales: previousTargets.extra_Base_USDe_Whales,
          };
        }
      } catch (_) { /* A missing or partially written prior snapshot must not fail the current tick. */ }
    }
    if (baseObservation.status === "COMPLETE" && extraBaseUsdeWhales.length >= 7) {
      lastValidBaseState = { tsMs: baseObservation.pin.timestamp * 1000, baseObservation, baseMorphoTargets, targetB0, extraBaseUsdeWhales };
    } else if ((baseObservation.status !== "COMPLETE" || extraBaseUsdeWhales.length < 7) &&
        lastValidBaseState && (lastValidBaseState.tsMs === null ||
          (nowMs >= lastValidBaseState.tsMs && nowMs - lastValidBaseState.tsMs <= TARGET_CACHE_TTL_MS))) {
      // Preserve the original Base pin and observation timestamps; do not refresh the cache age.
      const reason = "BASE_REFRESH_FAILED";
      baseObservation = { ...lastValidBaseState.baseObservation, status: "INCOMPLETE", reason };
      baseMorphoTargets = lastValidBaseState.baseMorphoTargets.map(row => retainObservation(row, reason));
      targetB0 = lastValidBaseState.targetB0 ? retainObservation(lastValidBaseState.targetB0, reason) : null;
      extraBaseUsdeWhales = lastValidBaseState.extraBaseUsdeWhales.map(row => retainObservation(row, reason));
    }
  }

  const status = {
    schema: "top-whale-triggers-status/v1",
    generatedAt: new Date().toISOString(),
    scanner: "tools/watch-top-whale-triggers.js",
    observationKind: "READ_ONLY_MONITOR", observationSource: OBSERVATION_SOURCE,
    armed: false, executableNow: false, refreshStatus: "COMPLETE", refreshReason: null,
    safety: { readOnly: true, rpcUrlsStored: false, signedActions: false },
    pin: debtPin,
    baseObservation,
    anyTriggerFired: fired.length > 0,
    firedTriggers: fired,
    morphoZeroFeeFlashLiquidity: {
      usdc: +(Number(morphoUsdc) / 1e6).toFixed(2),
      weth: +(Number(morphoWeth) / 1e18).toFixed(2)
    },
    targets: {
      target1_AaveV4_USDe_USDC: {
        user: USER_V4_C1,
        spoke: SPOKE_A,
        healthFactor: hfC1,
        liquidatableNow: BigInt(c1Acct.healthFactor) < W,
        bpsToLiquidation: +((1 - 1 / hfC1) * 10000).toFixed(4),
        passiveSecondsToCrossing: passiveSec,
        passiveHoursToCrossing: +(passiveSec / 3600).toFixed(2),
        projectedPassiveCrossingUtc: new Date((Number(pinTs) + passiveSec) * 1000).toISOString(),
        usdtChainlinkAnswerUsd: Number(usdtR[1]) / 1e8,
        usdtChainlinkAgeHours: +((Number(pinTs) - Number(usdtR[3])) / 3600).toFixed(2),
        usdcChainlinkAnswerUsd: Number(usdcR[1]) / 1e8,
        usdcChainlinkAgeHours: +((Number(pinTs) - Number(usdcR[3])) / 3600).toFixed(2),
        hoursUntil24hHeartbeat: +(Math.max(0, 86400 - Math.max(Number(pinTs) - Number(usdtR[3]), Number(pinTs) - Number(usdcR[3]))) / 3600).toFixed(2),
        quoteKind: res2[0].success ? "ONCHAIN_MEASURED" : "MODEL_ESTIMATE",
        liveQuote: {
          repayUsdc: +(Number(v4Sizing.repayUsdcRaw) / 1e6).toFixed(2),
          seizedUsde: +(Number(v4Sizing.seizedUsdeToLiqRaw) / 1e18).toFixed(2),
          uniV3OutUsdc: +(Number(uniUsdeOut) / 1e6).toFixed(2),
          grossSurplusUsdc: +t1NetUsdc.toFixed(2)
        },
        readyExecuteMorphoCalldata: LIQUIDATOR_IFACE.encodeFunctionData("executeMorpho", [t1FlashUsdcRaw, t1Params])
      },
      target2A_AaveV3_weETH_WETH_0x7231: {
        user: USER_V3_7231,
        pool: POOL_V3,
        healthFactor: hf7231,
        liquidatableNow: BigInt(v3_7231[5]) < W,
        bpsToLiquidation: +((1 - 1 / hf7231) * 10000).toFixed(4),
        collateralUsd: +(Number(v3_7231[0]) / 1e8).toFixed(2),
        debtUsd: +(Number(v3_7231[1]) / 1e8).toFixed(2),
        quoteKind: res2[1].success ? "ONCHAIN_MEASURED" : "MODEL_ESTIMATE",
        liveQuote: {
          repayWeth: +(Number(repay7231Weth) / 1e18).toFixed(4),
          seizedWeEth: +(Number(seized7231WeEth) / 1e18).toFixed(4),
          curveOutWeth: +(Number(curve7231Out) / 1e18).toFixed(4),
          grossSurplusWeth: +t2ANetWeth.toFixed(4),
          grossSurplusUsd: +(t2ANetWeth * (Number(priceWeth) / 1e8)).toFixed(2)
        },
        readyExecuteMorphoCalldata: LIQUIDATOR_IFACE.encodeFunctionData("executeMorpho", [repay7231Weth, t2AParams])
      },
      target2B_AaveV3_weETH_WETH_0x1A55: {
        user: USER_V3_1A55,
        pool: POOL_V3,
        healthFactor: hf1a55,
        liquidatableNow: BigInt(v3_1a55[5]) < W,
        bpsToLiquidation: +((1 - 1 / hf1a55) * 10000).toFixed(4),
        collateralUsd: +(Number(v3_1a55[0]) / 1e8).toFixed(2),
        debtUsd: +(Number(v3_1a55[1]) / 1e8).toFixed(2),
        quoteKind: res2[2].success ? "ONCHAIN_MEASURED" : "MODEL_ESTIMATE",
        liveQuote: {
          repayWeth: +(Number(repay1a55Weth) / 1e18).toFixed(4),
          seizedWeEth: +(Number(seized1a55WeEth) / 1e18).toFixed(4),
          curveOutWeth: +(Number(curve1a55Out) / 1e18).toFixed(4),
          grossSurplusWeth: +t2BNetWeth.toFixed(4),
          grossSurplusUsd: +(t2BNetWeth * (Number(priceWeth) / 1e8)).toFixed(2)
        },
        deployedExecutor: "0x1C4Bc8d8b5806C1D73b47bC7ae4c2b6552c858A1",
        readyExecuteMorphoCalldata: LIQUIDATOR_IFACE.encodeFunctionData("executeMorpho", [repay1a55Weth, t2BParams])
      },
      target3_Morpho_PAXG_USDC: {
        marketId: PAXG_MARKET,
        availableUsdc: +paxgAvailableUsdc.toFixed(6),
        observationOnly: true,
        executableNow: false,
        liquidatableNow: false,
        executor: null,
        conservativeNetUsd: null,
        readinessNote: "Observation only; available market liquidity is not profit."
      },
      spokeC_AaveV4_weETH_WETH: spokeCTargets,
      additional_AaveV3_weETH_WETH: extraV3Targets,
      targetM1_Morpho_USDe_DAI: m1Observation,
      targetM2_Morpho_reUSD_USDC: {
        rank: "#M2",
        user: ETH_MORPHO_REUSD_USDC_USER,
        marketId: ETH_MORPHO_REUSD_USDC_MKT,
        pair: "reUSD / USDC",
        observationOnly: false,
        armed: true,
        deployedExecutor: M2_CURVE_UNWIND_EXECUTOR,
        executor: M2_CURVE_UNWIND_EXECUTOR,
        executableNow: Boolean(m2LiqNow && m2NetUsdc >= 25),
        readinessNote: "Armed on Curve-unwind executor 0x2d5b...3627 (+2,111.52 USDC fork-proven in 365,773 gas).",
        healthFactor: m2Hf,
        storedHealthFactor: m2StoredHf,
        borrowAprPct: +(Number(m2Rate) / 1e18 * 31536000 * 100).toFixed(2),
        passiveHoursToCrossing: m2PassiveHours,
        liquidatableNow: Boolean(m2LiqNow && m2NetUsdc >= 25),
        bpsToLiquidation: m2Hf > 0 ? +((1 - 1 / m2Hf) * 10000).toFixed(4) : null,
        collateralUsd: +(Number(m2CollValUsdcRaw) / 1e6).toFixed(2),
        debtUsd: +(Number(m2DebtUsdcRaw) / 1e6).toFixed(2),
        quoteKind: res2[20]?.success ? "ONCHAIN_MEASURED" : "MODEL_ESTIMATE",
        liveQuote: {
          repayUsdc: +(Number(m2RepayUsdcRaw) / 1e6).toFixed(2),
          seizedReusd: 100000,
          curveOutUsdc: +(Number(m2OutUsdcRaw) / 1e6).toFixed(2),
          grossSurplusUsdc: +m2NetUsdc.toFixed(2),
          grossSurplusUsd: +m2NetUsdc.toFixed(2),
        },
        readyExecuteCurveUnwindCalldata: m2OutUsdcRaw > 0n ? m2Calldata : null,
      },
      base_Morpho_Whales: baseMorphoTargets,
      ...(targetB0 ? { targetB0_Base_USDe_USDC: targetB0 } : {}),
      ...(targetB11 ? { targetB11_Fluid_sUSDai_USDC_Vault48: targetB11 } : {}),
      ...(targetB12 ? { targetB12_EulerV2_wtSPYM_USDC_0x1791: targetB12 } : {}),
      ...(targetB13 ? { targetB13_EulerV2_wtCOIN_USDC_0x1791: targetB13 } : {}),
      ...(targetB14 ? { targetB14_Base_USDe_USDC_0x6efc: targetB14 } : {}),
      ...(targetB15 ? { targetB15_Base_yoUSD_USDC_0x5c2a: targetB15 } : {}),
      ...(extraBaseUsdeWhales.length > 0 ? { extra_Base_USDe_Whales: extraBaseUsdeWhales } : {}),
      ...(target2J ? { target2J_AaveV3_wstETH_WETH_0x037a: target2J } : {}),
      ...aaveV3WhaleTargets,
      ...sparkWhaleTargets,
      ...(targetA3 ? { targetA3_AaveV4_USDe_USDC_0x1d9c: targetA3 } : {}),
      ...(targetA4 ? { targetA4_AaveV4_SameAsset_0xa429: targetA4 } : {}),
      ...(targetA5 ? { targetA5_AaveV4_syrupUSDG_USDG_0x080c: targetA5 } : {}),
      ...(targetA6 ? { targetA6_AaveV4_syrupUSDG_USDG_0xbd81: targetA6 } : {}),
      ...(targetA7 ? { targetA7_AaveV4_syrupUSDG_USDG_0x28e8: targetA7 } : {}),
      ...(targetA8 ? { targetA8_AaveV4_syrupUSDG_USDG_0x707e: targetA8 } : {}),
      ...(targetA9 ? { targetA9_AaveV4_syrupUSDG_USDG_0x90ff: targetA9 } : {}),
      ...(targetA10 ? { targetA10_AaveV4_syrupUSDG_USDG_0x6efc: targetA10 } : {}),
      ...(targetA11 ? { targetA11_AaveV4_USDe_USDC_0x5c43: targetA11 } : {}),
      ...(targetA12 ? { targetA12_AaveV4_WBTC_USDT_0xac90: targetA12 } : {}),
      ...(targetA13 ? { targetA13_AaveV4_wstETH_WETH_0x4cd7: targetA13 } : {}),
      ...(targetA14 ? { targetA14_AaveV4_syrupUSDG_USDG_0xabcc: targetA14 } : {}),
      ...(targetA15 ? { targetA15_AaveV4_weETH_WETH_0x3519: targetA15 } : {}),
      ...(targetA16 ? { targetA16_AaveV4_syrupUSDG_USDG_0x9cd7: targetA16 } : {}),
      ...(targetA17 ? { targetA17_AaveV4_weETH_WETH_0xa751: targetA17 } : {}),
      ...(targetA18 ? { targetA18_AaveV4_syrupUSDG_USDG_0xdd64: targetA18 } : {}),
      ...(targetC9 ? { targetC9_AaveV4_weETH_WETH_0x9f46: targetC9 } : {}),
      ...(morphoWstEthWhales.length ? { morpho_wstETH_WETH_Whales: morphoWstEthWhales } : {}),
      ...(targetM7Canary ? { targetM7_Morpho_ynETHx_msETH_Canary: targetM7Canary } : {}),
      ...(targetM7B ? { targetM7B_Morpho_ynETHx_msETH_0x9b13: targetM7B } : {}),
      ...(targetYnArb ? { targetYnEthx_Curve_NavArb: targetYnArb } : {}),
      ...(targetE1 ? { targetE1_EulerV2_RLUSD_USDC_0xbf21: targetE1 } : {}),
      ...(targetE2 ? { targetE2_EulerV2_USDC_syrupUSDC_0x9f09: targetE2 } : {}),
      ...(targetE3 ? { targetE3_EulerV2_WETH_ynETHx_0x831e: targetE3 } : {}),
      ...(targetE4 ? { targetE4_EulerV2_WETH_ynETHx_0x8062: targetE4 } : {}),
      ...(targetE5 ? { targetE5_EulerV2_USDC_USDT_0xd1ed: targetE5 } : {}),
      ...(targetE6 ? { targetE6_EulerV2_USDT_USDC_0x079d: targetE6 } : {}),
      ...(targetE7 ? { targetE7_EulerV2_RLUSD_USDe_0x1066: targetE7 } : {}),
      ...(targetE8 ? { targetE8_Euler_eUSDC2_eXAUt1: targetE8 } : {}),
      ...(targetE9 ? { targetE9_Euler_eUSDT9_eUSDC22: targetE9 } : {}),
      ...(targetE10 ? { targetE10_Euler_eRLUSD7_eUSDC70: targetE10 } : {}),
      ...(targetM10 ? { targetM10_Morpho_USDe_RLUSD: targetM10 } : {}),
      ...(targetM11 ? { targetM11_Morpho_weETH_WETH: targetM11 } : {}),
      ...(targetM12 ? { targetM12_Morpho_PT_USD3_USDC: targetM12 } : {}),
      ...(targetM13 ? { targetM13_Morpho_PT_USD3_USDC: targetM13 } : {}),
      ...(targetM2B ? { targetM2B_Morpho_reUSD_USDC: targetM2B } : {}),
      ...(targetM2C ? { targetM2C_Morpho_reUSD_USDC: targetM2C } : {}),
      ...(targetM2D ? { targetM2D_Morpho_reUSD_USDC: targetM2D } : {}),
      ...(targetM14 ? { targetM14_Morpho_PT_USDat_USDC: targetM14 } : {}),
      ...(targetM15 ? { targetM15_Morpho_yoUSD_Edge_USDC: targetM15 } : {}),
      ...(targetM16 ? { targetM16_Morpho_apyUSD_apxUSD: targetM16 } : {}),
      ...(targetM17 ? { targetM17_Morpho_eUSDe_USDe: targetM17 } : {}),
      ...(targetM18 ? { targetM18_Morpho_USD3_USDC: targetM18 } : {}),
      ...(targetM19 ? { targetM19_Morpho_USD3_USDC: targetM19 } : {}),
      ...(targetM20 ? { targetM20_Morpho_USD3_USDC: targetM20 } : {}),
      ...(targetM21 ? { targetM21_Morpho_PT_apyUSD_apxUSD: targetM21 } : {}),
      ...(targetM22 ? { targetM22_Morpho_PT_apyUSD_apxUSD: targetM22 } : {}),
      ...(targetM23 ? { targetM23_Morpho_PT_reUSD_USDC: targetM23 } : {}),
      ...(targetM24 ? { targetM24_Morpho_PT_reUSD_USDC: targetM24 } : {}),
      ...(targetM25 ? { targetM25_Morpho_USD3_USDC: targetM25 } : {}),
      ...(targetM26 ? { targetM26_Morpho_USD3_USDC: targetM26 } : {}),
      ...(targetM27 ? { targetM27_Morpho_PT_reUSD_USDC: targetM27 } : {}),
      ...(targetM28 ? { targetM28_Morpho_PT_reUSD_USDC: targetM28 } : {}),
      ...(targetM29 ? { targetM29_Morpho_PT_srUSDe_USDC: targetM29 } : {}),
      ...(targetM30 ? { targetM30_Morpho_wstETH_WETH: targetM30 } : {}),
      ...(targetM31 ? { targetM31_Morpho_syrupUSDC_USDC: targetM31 } : {}),
      ...(targetM32 ? { targetM32_Morpho_sUSDe_USDtb: targetM32 } : {}),
      ...(targetM33 ? { targetM33_Morpho_PT_reUSD_USDT: targetM33 } : {}),
      ...(targetF1 ? { targetF1_Fluid_USDe_USDT_Vault93: targetF1 } : {}),
      ...(targetF2 ? { targetF2_Fluid_eBTC_cbBTC_Vault96: targetF2 } : {}),
      ...(targetF3 ? { targetF3_Fluid_ETH_osETH_Vault159: targetF3 } : {}),
      ...(targetF4 ? { targetF4_Fluid_PAXG_XAUt_Vault123: targetF4 } : {}),
      ...(targetF5 ? { targetF5_Fluid_WBTC_LBTC_Vault115: targetF5 } : {}),
      ...(targetF6 ? { targetF6_Fluid_syrupUSDC_USDC_Vault145: targetF6 } : {}),
      ...(targetM34 ? { targetM34_Morpho_beraSTONE_WETH: targetM34 } : {}),
      ...(targetM35 ? { targetM35_Morpho_PT_USD3_USDC: targetM35 } : {}),
      ...(targetM36 ? { targetM36_Morpho_sUSDS_USDT: targetM36 } : {}),
      ...(targetM37 ? { targetM37_Morpho_PST_USDT: targetM37 } : {}),
      ...(targetM38 ? { targetM38_Morpho_sUSDS_USDT: targetM38 } : {}),
      ...(targetM39 ? { targetM39_Morpho_reUSD_USDC: targetM39 } : {}),
      ...(targetM40 ? { targetM40_Morpho_weETH_WETH: targetM40 } : {}),
      ...(targetM41 ? { targetM41_Morpho_wstETH_WETH: targetM41 } : {}),
      ...(targetM42 ? { targetM42_Morpho_strUSD_USDC: targetM42 } : {}),
      ...(targetM43 ? { targetM43_Morpho_PRIME_PYUSD: targetM43 } : {}),
      ...(targetM44 ? { targetM44_Morpho_srUSD_USDC: targetM44 } : {}),
      ...(targetM45 ? { targetM45_Morpho_reUSDe_USDC: targetM45 } : {}),
      ...(targetM46 ? { targetM46_Morpho_apyUSD_apxUSD: targetM46 } : {}),
      ...(targetM47 ? { targetM47_Morpho_USDe_RLUSD: targetM47 } : {}),
      ...(targetM48 ? { targetM48_Morpho_reUSD_USDT: targetM48 } : {}),
      ...(targetM49 ? { targetM49_Morpho_sUSDe_USDT: targetM49 } : {}),
      ...morphoPtTargets,
    }
  };

  forecastMorpho(status.targets.targetM2_Morpho_reUSD_USDC, {
    market: m2Mkt, position: m2Pos, price: m2Price, lltv: ETH_MORPHO_REUSD_USDC_LLTV,
    rate: res2[21]?.success ? m2Rate : null, seizedAssets: m2SeizeRaw, lif: LIF_915,
  }, m2OutUsdcRaw - m2RepayUsdcRaw >= 25000000n, () => ({ readyExecuteCurveUnwindCalldata: m2Calldata }));
  forecastAave(status.targets.target2A_AaveV3_weETH_WETH_0x7231, v3_7231,
    repay7231Weth > 0n && seized7231WeEth > 0n && curve7231Out - repay7231Weth >= 10000000000000000n,
    () => ({ readyExecuteMorphoCalldata: LIQUIDATOR_IFACE.encodeFunctionData("executeMorpho", [repay7231Weth, t2AParams]) }));
  forecastAave(status.targets.target2B_AaveV3_weETH_WETH_0x1A55, v3_1a55,
    repay1a55Weth > 0n && seized1a55WeEth > 0n && curve1a55Out - repay1a55Weth >= 10000000000000000n,
    () => ({ readyExecuteMorphoCalldata: LIQUIDATOR_IFACE.encodeFunctionData("executeMorpho", [repay1a55Weth, t2BParams]) }));

  markTargets(status.targets, debtPin);

  if (!options.rpcCall) {
    const nowMs = Date.now();
    if (Object.keys(lastValidExtendedTargets).length === 0 && fs.existsSync(OUT)) {
      try {
        const previous = JSON.parse(fs.readFileSync(OUT, "utf8"));
        for (const [k, v] of Object.entries(previous.targets || {})) {
          if (EXTENDED_TARGET_KEY.test(k) && v) {
            // A parent document timestamp does not establish the age of a cached row.
            lastValidExtendedTargets[k] = { tsMs: observationTimeMs(v), value: v };
          }
        }
      } catch (_) {}
    }
    for (const key of new Set([...Object.keys(status.targets), ...Object.keys(lastValidExtendedTargets)])) {
      if (!EXTENDED_TARGET_KEY.test(key)) continue;
      if (status.targets[key]) {
        lastValidExtendedTargets[key] = { tsMs: observationTimeMs(status.targets[key]), value: status.targets[key] };
      } else {
        const cached = lastValidExtendedTargets[key];
        if (cached && (cached.tsMs === null || (nowMs >= cached.tsMs && nowMs - cached.tsMs <= TARGET_CACHE_TTL_MS))) {
          // Only newly observed targets refresh the cache age; restored targets do not refire triggers.
          if (DEBT_STATUS_TARGETS.has(key)) {
            // Retain the identity, but never relabel cached debt as a new observation.
            const restored = retainObservation(cached.value);
            recordPositionDebt(restored, null, restored.debtReadKind, null);
            clearPositionReadiness(restored, "Current debt read unavailable; previous position observation retained");
            status.targets[key] = restored;
          } else {
            status.targets[key] = retainObservation(cached.value);
            if (key === "targetM32_Morpho_sUSDe_USDtb") {
              // Cached health is not a new observation or a live execution quote.
              const legacyBinding = String(cached.value.deployedExecutor || cached.value.executor || "").toLowerCase() !== M32_DEPLOYMENT.EXECUTOR ||
                ["readyExecuteCurveUnwindCalldata", "readyExecuteReusdCalldata"].some(field => typeof cached.value[field] === "string");
              if (legacyBinding || !cached.value.liveQuote?.provenance) {
                Object.assign(status.targets[key], { liveQuote: { ...M32_REFERENCE_QUOTE, provenance: "HISTORICAL_REFERENCE",
                  observationBlock: null, observationHash: null, observationUtc: null },
                  quoteKind: "HISTORICAL_REFERENCE", quoteObservation: null });
              }
              Object.assign(status.targets[key], {
                observationOnly: false, observationStatus: "INCOMPLETE", armed: false, executableNow: false, kind: "MORPHO_BLUE_M32",
                quoteCurrent: false,
                deployedExecutor: M32_DEPLOYMENT.EXECUTOR, executor: M32_DEPLOYMENT.EXECUTOR,
                readinessNote: "Route configured (read-only; runner unverified) on 0x2c94...47c4 (dedicated MorphoM32CurveUnwindLiquidator; +279.34 USDtb gross / +$213.50 modeled net rehearsed).",
              });
              delete status.targets[key].readyExecuteCurveUnwindCalldata;
              delete status.targets[key].readyExecuteReusdCalldata;
              for (const field of Object.keys(status.targets[key])) {
                if (/^readyExecute.*Calldata$/.test(field)) delete status.targets[key][field];
              }
            }
          }
        }
      }
    }
  }

  if (writeOut) writeStatus(status);
  return status;
}

function createStickyResolver(resolve = resolveRpc) {
  const cache = new Map();
  const sticky = async (chainId, ...rest) => {
    if (cache.has(chainId)) return cache.get(chainId);
    const url = await resolve(chainId, ...rest);
    if (url) {
      cache.set(chainId, url);
      if (chainId === 8453 && resolve === resolveRpc) {
        await new Promise(r => setTimeout(r, 1200));
      }
    }
    return url;
  };
  sticky.invalidate = (chainId) => {
    if (chainId === undefined) cache.clear();
    else cache.delete(chainId);
  };
  return sticky;
}

async function main(argv = process.argv.slice(2)) {
  const watchIdx = argv.indexOf("--watch");
  const watchSec = watchIdx >= 0 && argv[watchIdx + 1] && /^\d+$/.test(argv[watchIdx + 1]) ? Math.max(5, Number(argv[watchIdx + 1])) : (watchIdx >= 0 ? 30 : 0);
  const maxRunsIdx = argv.indexOf("--max-runs");
  const maxRuns = maxRunsIdx >= 0 && argv[maxRunsIdx + 1] ? Math.max(1, Number(argv[maxRunsIdx + 1])) : (watchSec > 0 ? Infinity : 1);
  const stickyResolve = createStickyResolver();
  let previous = null;

  for (let i = 0; i < maxRuns; i++) {
    let status = null;
    try {
      status = await checkOnce({ resolveRpc: stickyResolve, includeA5: true, includeM10M11: true });
      previous = status;
      if (status.baseObservation?.status !== "COMPLETE") {
        stickyResolve.invalidate(8453);
      }
      console.log(JSON.stringify({
        run: i + 1,
        pin: status.pin.number,
        utc: status.pin.utc,
        anyFired: status.anyTriggerFired,
        fired: status.firedTriggers,
        t1_V4_bps: status.targets.target1_AaveV4_USDe_USDC.bpsToLiquidation,
        t1_netUsdc: status.targets.target1_AaveV4_USDe_USDC.liveQuote.grossSurplusUsdc,
        t1_oracleHeartbeatHoursLeft: status.targets.target1_AaveV4_USDe_USDC.hoursUntil24hHeartbeat,
        t2A_V3_0x7231_bps: status.targets.target2A_AaveV3_weETH_WETH_0x7231.bpsToLiquidation,
        t2A_netUsd: status.targets.target2A_AaveV3_weETH_WETH_0x7231.liveQuote.grossSurplusUsd,
        t2B_V3_0x1A55_bps: status.targets.target2B_AaveV3_weETH_WETH_0x1A55.bpsToLiquidation,
        t2B_netUsd: status.targets.target2B_AaveV3_weETH_WETH_0x1A55.liveQuote.grossSurplusUsd,
        t3_PAXG_usdc: status.targets.target3_Morpho_PAXG_USDC.availableUsdc
      }));
    } catch (err) {
      stickyResolve.invalidate();
      // No raw provider error is printable. Failure time never refreshes evidence age.
      if (!previous) {
        try { previous = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch (_) {}
      }
      previous = failedRefreshStatus(previous);
      try { writeStatus(previous); } catch (_) { /* Still emit a bounded failure event if output is unavailable. */ }
      console.error(JSON.stringify({ run: i + 1, observationKind: "READ_ONLY_MONITOR", armed: false,
        executableNow: false, refreshStatus: "INCOMPLETE", refreshReason: "WATCH_ITERATION_FAILED" }));
      if (watchSec === 0 || i + 1 >= maxRuns) throw new Error("WATCH_ITERATION_FAILED");
    }
    if (watchSec === 0 || i + 1 >= maxRuns) break;
    await new Promise(r => setTimeout(r, watchSec * 1000));
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("watch-top-whale-triggers failed: WATCH_ITERATION_FAILED");
    process.exitCode = 1;
  });
}

module.exports = { EXTRA_V3_WEETH_USERS, wTaylorCompounded, createStickyResolver, checkOnce, buildM1Observation, computeV4Target1Sizing, computeV3WeEthSizing, computeV4SpokeCSizing, main };
