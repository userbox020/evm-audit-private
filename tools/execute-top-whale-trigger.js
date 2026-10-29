#!/usr/bin/env node
"use strict";

// Import-inert unified runner. Aave V3 plus separately authorized Morpho M1 by default; PAXG remains disabled.
const fs = require("node:fs"), path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const m1Live = require("./lib/m1-live-evidence.js");
const { Interface, AbiCoder, keccak256 } = require("./node_modules/ethers");
const guard = require("./lib/wallet-execution-guard.js");
const nextExecution = require("./lib/next-block-execution.js");
const { createPinnedRpc, loadRpcCandidates, httpRpc } = require("./lib/executor-pinned-rpc.js");
const { EXTRA_V3_WEETH_USERS } = require("./watch-top-whale-triggers.js");
const { MAIN_ACCOUNT, requireThat, uint, atomicJson, safeError } = guard;
const ROOT = path.resolve(__dirname, "..");
const BUNDLE = path.join(ROOT, "coordination/live-execution-batch-aave-v4-v3-morpho.json");
const MORPHO_BUNDLE = path.join(ROOT, "coordination/live-execution-batch-morpho-trigger.json");
const BUNDLE_RENEWAL = path.join(ROOT, "coordination/live-execution-batch-aave-v4-v3-morpho-renewal-20261027.json");
const MORPHO_BUNDLE_RENEWAL = path.join(ROOT, "coordination/live-execution-batch-morpho-trigger-renewal-20261027.json");
const STATUS_FILE = path.join(ROOT, "reports/raw/fast/top-whale-executor-live-watch.json");
const CURRENT_2K_2L_STATUS_FILE = path.join(ROOT, "reports/raw/fast/top-whale-executor-live-watch-2k-2l.json");
const OBSERVATION_FILE = path.join(ROOT, "reports/raw/fast/top-whale-triggers-status.json");
const DEPLOYED_EXECUTOR = "0xf09a01a6c23b936d5a51abce87a6ec8442a44262";
const A4_SPOKE = "0x94e7a5dcbe816e498b89ab752661904e2f56c485", A4_BORROWER = "0xa4298746f662119a4df27fa57f20e18e44ccb767";
const POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2", WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const SPARK_POOL = "0xc13e21b648a5ee794902342038ff3adab66be987";
const WEETH = "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee", CURVE = "0xdb74dfdd3bb46be8ce6c33dc9d82777bcfc3ded5";
const MORPHO_EXECUTOR = "0xaf5b033e23ac555c09096bf39979a855e09907ba";
const MORPHO_BLUE = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb", BALANCER_VAULT = "0xba12222222228d8ba445958a75a0704d566bf2c8";
const UNI_ROUTER = "0xe592427a0aece92de3edee1f18e0157c05861564", QUOTER_V2 = "0x61ffe014ba17989e743c5f6cb21bf9697530b21e";
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f", USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDE = "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", M1_BORROWER = "0xa3609cf7872faa7804281c7c5edb8b2d33001089";
const M1_ORACLE = "0xae4750d0813b5e37a51f7629beedd72af1f9ca35", M1_IRM = "0x870ac11d48b15db9a138cf899d20f13f79ba00bc";
const M1_LLTV = 860000000000000000n, M1_SEIZE = 108500000000000000000000n;
const M1_PATH = "0x4c9edd5852cd905f086c759e8383e09bff1e68b3000064a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000646b175474e89094c44da98b954eedeac495271d0f";
const M7_EXECUTOR = "0xc06326bc6fbd4305cdab4de8e239b7b80feb2eb4";
const MSETH = "0x64351fc9810adad17a690e4e1717df5e7e085160", YNETHX = "0x657d9aba1dbb59e53f9f3ecaa878447dcfc96dcb";
const M7_BORROWER = "0x14bcd9da052cdc6fe0b9446d5a616d5b7b4d4550", M7_ORACLE = "0xc28f86c86f79282e2d2a1f45442339c55f7eb22d";
const M7B_BORROWER = "0x9b1303ebf09bc51b7fac376c9e421e8daae63b82";
const M7_LLTV = 915000000000000000n, CURVE_MSETH_WETH = "0xa4c567c662349bec3d0fb94c4e7f85ba95e208e4";
const YN_ARB_EXECUTOR = "0x91a07a51ca9c2abd333d80ca876f0dfde4d8cd35", CURVE_YNETHX_WETH = "0xd65ed4bce447195187f37ce7d82f56adf1826f8f";
const EULER_EVK_EXECUTOR = "0xac262ce4319b887aeac069730c7978c98a8c5fe6", RLUSD = "0x8292bb45bf1ee4d140127049757c2e0ff06317ed";
const UNIV4_FLASH_EXECUTOR = "0x61251a22540e7148cc8ba58cfb0916a898865e1f";
const PENDLE_PT_EXECUTOR = "0xd53ee7b5806c4d7f36422eab99dc46563d18b84d";
const PT_USDE = "0x917459337caac939d41d7493b3999f571d20d667", PT_ORACLE = "0xfcae69bef9b6c96d89d58664d8aea84bddce2e5c";
const PENDLE_YT = "0x733ee9ba88f16023146ebc965b7a1da18a322464", PENDLE_SY = "0xb47cbf6697a6518222c7af4098a43aefe2739c8c";
const M8_BORROWER = "0x9b75df7f7cd5b74b8f0f0de8f4751c3f8e9695bb", M9_BORROWER = "0x64d85278a093ee5c57739c6c0de6c4eef53a1e02";
const A5_SPOKE = "0x774b9655413c34809c1f1b16b654465a89ebe989", A5_BORROWER = "0x080ccea8654fd4ff80b81e46cff2278689d88fb0";
const USDG = "0xe343167631d89b6ffc58b88d6b7fb0228795491d", SYRUP_USDG = "0x87b65c4aaffa76881f9e96f3e7ed945ddfc3cd7a";
const E2_BORROWER = "0x9f09502a0b68edbccdff5e6c59270ad150def361", E2_LIABILITY_VAULT = "0x9bd52f2805c6af014132874124686e7b248c2cbb", E2_COLL_VAULT = "0x4bc68f0cc010a0beda0e3f63cfbecdee5ad55a18", SYRUP_USDC = "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b";
const E1_BORROWER = "0xbf21702d7213bc7a95fc0ecb1e4a4e43c2380772", E1_LIABILITY_VAULT = "0xe1ce9af672f8854845e5474400b6ddc7ae458a10", E1_COLL_VAULT = "0xe0a80d35bb6618cba260120b279d357978c42bce", CURVE_USDC_RLUSD = "0xd001ae433f254283fece51d4acce8c53263aa186";
const E3_BORROWER = "0x831ec4f2aba6deab29fb1aefdf9b049721d3c366", E3_LIABILITY_VAULT = "0x45c3b59d53e2e148aaa6a857521059676d5c0489", E3_COLL_VAULT = "0x6d18f74aad8494b789ae34b5455816f79664d209";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7", E_USDT_VAULT = "0x7c280dbdef569e96c7919251bd2b0edf0734c5a8";
const CURVE_USDC_USDT = "0x4f493b7de8aac7d55f71853688b1f7c8f0243c85";
const M2_EXECUTOR = "0x2d5bca1b846e89965544c7f03d09a25126803627";
const REUSD = "0x5086bf358635b81d8c47c66d1c8b9e567db70c72", M2_BORROWER = "0xaa34d20be3f9623ccf5bff53ef4dfa765c3f5dd5";
const M2_ORACLE = "0xa66a4f03fd8031973f8c7718904ce32385f54e70", M2_LLTV = 915000000000000000n;
const CURVE_REUSD_USDC = "0xf74c91b36c26543a0aa820bef407a577e5498bf0", M2_SEIZE = 100000000000000000000000n;
const WSTETH = "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", USER_V3_037A = "0x037a4486b28f0e3b34a4a6e7c4a915280e731a45";
const WSTETH_MORPHO_ORACLE = "0xbd60a6770b27e084e8617335dde769241b0e71d8", WST_SEIZE = 500000000000000000000n;
const WST_PATH = "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0000064c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const M10_BORROWER = "0x8d54e7f07f5502dc6428644c72850790c5dbc198", M10_ORACLE = "0x0c13eec9b02cd9d85facc9edf17e71feafc3d8d7";
const M10_SEIZE = 35000000000000000000000n;
const M10_PATH = "0x4c9edd5852cd905f086c759e8383e09bff1e68b3000064a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000648292bb45bf1ee4d140127049757c2e0ff06317ed";
const M11_BORROWER = "0x4b441cd7c5085d0c255eff3db7ec3417cca1a1a0", M11_ORACLE = "0xbdd2f2d473e8d63d1bfb0185b5bdb8046ca48a72";
const M11_SEIZE = 450000000000000000000n;
const WEETH_PATH = "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee000064c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const M2B_BORROWER = "0x115ea1d4f996a6305d029102a9a159827278adbc";
const M2C_BORROWER = "0x9d9dcf7d05593cbca6869ee10695da6c6c137f4a";
const M2D_BORROWER = "0x822eb2e51965f3a8b0ee7463853d563a0dd63c40";
const M14_BORROWER = "0x09c67aa4ee667872a9e8e2c0310b4a7fe8d3fc44", M14_PT = "0x1d69402390657308c91179aa184bf992908c1e08", M14_ORACLE = "0xda25bff53bf9e12c728cd83ff9fc22c581f564cd";
const M14_YT = "0x076a3ea71e83ca09319b161e40f5fb3bb943d3c6", M14_SY = "0x7a7de491e1be5287874904e2b7c8488249a4d0a9", USDAT = "0x23238f20b894f29041f48d88ee91131c395aaa71", CURVE_USDAT_USDC = "0xf4d0cf32908b2c7f1021339c43df0f77f06896d7";
const M29_BORROWER = "0x723cf98bfa71d786e3962140b79823637d0bbc0b", M29_PT = "0x1fb3c5c35d95f48e48ffc8e36bcce5cb5f29f57c", M29_ORACLE = "0x2a0326538ef89ba50d532aa061badcb5c87e1e8e";
const M29_YT = "0xbb9a3d650959386d40e52e6e9e5f242738b1ac76", M29_SY = "0xc69c87351bf66cab8e5676d6f2d4b63299ad0835", SUSDE = "0x9d39a5de30e57443bff2a8307a4256c8797a3497", CURVE_ROUTER_NG = "0x16c6521dff6bab339122a0fe25a9116693265353";
const M30_BORROWER = "0xfa4400264abd97fa6d61ab04471dacad081928de", M30_SEIZE = 200000000000000000n;
const M31_BORROWER = "0x950fd558f47e234a2fde23b7d61f7ccdbcb4a86f", M31_ORACLE = "0x80032f4cb6e3573b9ed61e888af658e48fb790cc", KYBER_ROUTER = "0x6131b5fae19ea4f9d964eac0408e4408b66337b5";
const M32_BORROWER = "0xc17a3f83798c8dfe5b6bc4f05825fccf08889c65", M32_USDTB = "0xc139190f447e929f090edeb554d95abb8b18ac1c", M32_ORACLE = "0x67bcc03438d7d71c39343d7ad21cb73dc19adb89";
const UNIVERSAL_EXECUTOR = "0xc50321a07dab061d59b992e57a2ef4dca0d33089";
const F1_VAULT_93 = "0x989a44cb4dbb7ebe20e0abf3c1e1d727bf90f881", F1_BORROWER = "0x60753e8622a6cfea1df449a9625a9778bb922b72";
const F2_VAULT_96 = "0x43d1ca906c72f09d96291b4913d7255e241f428d", F2_BORROWER = "0x3fb6784e263643656f386a0371644931133d7b78";
const F3_VAULT_159 = "0x40d0aa5041d4c591d26a5ce59fb62629d0c23b8d", F3_BORROWER = "0x2685c0e39eeaad383fb71ec3f493991d532a87ae";
const ETH_UNIVERSAL_EULER_EXECUTOR = "0xa8964ab01c35f8e7de8457223861624b66007a6a";
const E7_BORROWER = "0x1066e8f077dce3f9540426569a4653cb4f70cf12", E7_COL_VAULT = "0x2daca71cb58285212dc05d65cfd4f59a82bc4cf6";
const E8_BORROWER = "0x3a8306fb4fa0811a86955f4421600e3b500a9e44", E8_LIAB_VAULT = "0x797dd80692c3b2dadabce8e30c07fde5307d48a9", E8_COL_VAULT = "0x5a96128c18018a2cef539f46bbed037dad3caae8", E8_XAUT = "0x68749665ff8d2d112fa859aa293f07a622782f38";
const E9_BORROWER = "0x852839977253c27146168cb2df856bec78261a71", E9_LIAB_VAULT = "0x7c280dbdef569e96c7919251bd2b0edf0734c5a8", E9_COL_VAULT = "0xe0a80d35bb6618cba260120b279d357978c42bce";
const E10_BORROWER = "0x09e6691f61a2bc16725ea53ed1ac7e4e7517a468", E10_LIAB_VAULT = "0xaf5372792a29dc6b296d6ffd4aa3386aff8f9bb2", E10_COL_VAULT = "0x9bd52f2805c6af014132874124686e7b248c2cbb";
const UNIVERSAL_EULER_EXEC_IFACE = new Interface(["function execute((address loanToken,address liabilityVault,address collateralVault,address underlyingCollateral,address violator,uint256 repayAssets,uint256 maxRepayAssets,uint256 minYieldShares,uint8 unwindKind,address swapTarget,int128 curveI,int128 curveJ,bytes swapPath,uint256 minLoanOut) plan) external returns (uint256 profitOut)"]);
const M34_BORROWER = "0x52426c8065974821e99fa3c9aad73e47b9f1d6fc", M34_BERASTONE = "0x97ad75064b20fb2b2447fed4fa953bf7f007a706", M34_ORACLE = "0xae95c514054fe072036035f3aefc4bf31ea9dee5";
const UNIVERSAL_EXEC_IFACE = new Interface(["function execute((uint8 mode,address loanToken,uint256 flashAmount,address collateralToken,address oracle,address irm,uint256 lltv,address borrower,uint256 seizedAssets,address fluidVault,uint256 token0DebtAmt,uint256 token1DebtAmt,uint256 debtSharesMin,uint256 colPerUnitDebt,uint256 token0ColAmtPerUnitShares,uint256 token1ColAmtPerUnitShares,bool absorb,address approveToken1,address target1,bytes data1,address approveToken2,address target2,bytes data2,uint256 minProfit) plan) external returns (uint256 profitOut)"]);
const A12_SPOKE = "0x973a023a77420ba610f06b3858ad991df6d85a08", A12_BORROWER = "0xac90a9f2cf5636202919455f263746e5f98f937d", WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
const CURVE_ROUTER_NG_IFACE = new Interface(["function exchange(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, uint256 _expected, address[5] _pools, address _receiver) external payable returns (uint256)"]);
const M15_BORROWER = "0xe9b7f44e18c1afe573c937c5124b55eeeaff95fe", M15_YOUSD_EDGE = "0x5dd8bfa6c5c68d05d25ef6143e05c11e26c4cdb7", M15_ORACLE = "0x7c2f9a2530d26448de086d11c9fe474326068303";
const M16_BORROWER = "0xfb74196eccf35a260dd5cfd300baa37ae058b6c0", M16_APYUSD = "0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a", M16_APXUSD = "0x98a878b1cd98131b271883b390f68d2c90674665", M16_ORACLE = "0x770661ee520ff9f7d8facadc4eff885739bd8872", CURVE_APY_APX = "0xe41be7b340f7c2eda4da1e99b42ee1b228b526b7";
const M17_BORROWER = "0x6adac55e197c09001a605e54042670f5adced052", M17_EUSDE = "0x90d2af7d622ca3141efa4d8f1f24d86e5974cc8f", M17_ORACLE = "0xae4750d0813b5e37a51f7629beedd72af1f9ca35";
const M18_BORROWER = "0x599275be9753ecd8e6c380a7ef78e38711b8f212", M18_USD3 = "0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc", M18_ORACLE = "0x68b4c2b2b2e245ab54a3bd55dfd5a9d84f029c06";
const M19_BORROWER = "0x0a907c7ce498b6a1d1dc42dad1acbd97d96392e8";
const M20_BORROWER = "0x2385233abb910357e2b97a16d40e0443e53d0769";
const M21_BORROWER = "0x35316f7c2452958385e444bfc182f0192bee2dd4", M22_BORROWER = "0x687f584fd1f4a4d9eb277c03a24fe28f4b0675b7";
const M21_PT_APY = "0xb5be35d8ff83d431899b95851cb17a2b4bcef150", M21_ORACLE = "0xd3acb26e38465613b9a974cad2ba56fbcc7b87e9";
const PENDLE_APY_MARKET = "0xc5f938a8ef5f3bf9e72f5aa094baf5e03f4727d3", PENDLE_SWAP = "0xd4f480965d2347d421f1bec7f545682e5ec2151d";
const M23_BORROWER = "0x64fbb84b9a101227af977ab5916cdead0de630bb", M24_BORROWER = "0x0794e8e138825ab2f5cf91c4a4bf235276416333";
const M25_BORROWER = "0xaa34d20be3f9623ccf5bff53ef4dfa765c3f5dd5", M26_BORROWER = "0xb47c72be8a2968dec42d3b9d8c6f464224605bfd";
const M27_BORROWER = "0xcc58accacd0db8010e4c8a20ba49d2dc9d4d7f59", M28_BORROWER = "0xf4766c366f15ab0f338ecc9bef49bbaac13649a6";
const M23_PT_REUSD = "0xecfafdc7741323a945a163ed068b5a3c43483957", M23_ORACLE = "0x217d6ddcdb95112c51657f6270e8c079cfdb51f0";
const PENDLE_REUSD_MARKET = "0x13285bcbc27f92b47b4edb99d744c07b48c977c0";
const ERC4626_REDEEM_IFACE = new Interface(["function redeem(uint256 shares, address receiver, address owner) returns (uint256)"]);
const ERC4626_REDEEM4_IFACE = new Interface(["function redeem(uint256 shares, address receiver, address owner, uint256 maxLoss) returns (uint256)"]);
const PT_USD3 = "0x7f47c3e6b2c00fc4eb4d5ae50d0ab0ab6888eb4d", PT_USD3_ORACLE = "0xe5e6ec063e63a9d0c6ac041d0ad2bd03f7f08d72", PT_USD3_NEW_ORACLE = "0x716021a5d598c22851764923271c90a0aa704754";
const PENDLE_USD3_MARKET = "0x4a5067c3ff1abb7449244025b0e37feaf77d8e3e", PENDLE_ROUTER_V4 = "0x888888888889758f76e7103c6cbf23abbf58f946";
const M12_BORROWER = "0x92ee32937f3a86bb897e3b15de55078f18cb7cb2", M13_BORROWER = "0x2e598eb2703069ebaabec95adcf684bc12a3eafd", M35_BORROWER = "0x0a12127877a785941fc79f0deabe354a79390f0f";
const M36_BORROWER = "0x56f91d80cdf27b9e7abe845fa4bfec05f7de2794", M36_SUSDS = "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd", M36_ORACLE = "0x0c426d174fc88b7a25d59945ab2f7274bf7b4c79";
const M37_PST = "0x22ae3d9a738471f405169af055d31c687087d4c7", M37_ORACLE = "0x2ee12805a458366f75459065e6f8add14a65f1bf", M37_FLUID_PST_USDC = "0x40d66b5f8f1521f97c2aca54dd200fe3ca035328";
const F4_VAULT_123 = "0x78ec4dfb48f9dee98a1793854e94b5eaf4305516", F4_BORROWER = "0x0558284633e383f7dad328ce84c77a7b2fe4303b";
const F5_VAULT_115 = "0x57a9f4e109ecef8990bc794df0d159fb29861f2a", F5_BORROWER = "0xc0cff473726061e22b64b7680cd8c2e09cea5d86";
const F6_VAULT_145 = "0x01510793df6ad5c1a8ae592158713176cbd17a62", F6_BORROWER = "0xa651887052a78dd9a279ad089ef8b7b979889fe4";
const M39_BORROWER = "0x5d8604fcbda7ef027d79eab8300aa8c85d247c84";
const M40_BORROWER = "0xd7583e3cf08bbcab66f1242195227bbf9f865fda";
const M41_BORROWER = "0x43c0ec5456b67c8a7471b3dcadebee0e2a272e72";
const M42_STRUSD = "0x280839980a7ed0d7717f64125fe241012e5f5815", M42_ORACLE = "0x1506c98ce61ac63c8438b710c054a51c5dd9a6a4", M42_CURVE = "0x25a637c80ad90177d0b3ff28aa2d3f74f7165ccb", M42_FLUID = "0x97f32e5091d0e6aee24beb398e6592ae111dee9c";
const M43_PRIME = "0x19ebb35279a16207ec4ba82799cc64715065f7f6", M43_PYUSD = "0x6c3ea9036406852006290770bedfcaba0e23a0e8", M43_ORACLE = "0x335e5718bc20028d5e357473a3736c187ca6b07e", M43_PAYPOOL = "0x383e6b4437b59fff47b619cba855ca29342a8559";
const M44_BORROWER = "0x76f768dbeaa0264185b7a4952540656ad7b54148", M44_SRUSD = "0x738d1115b90efa71ae468f1287fc864775e23a31", M44_ORACLE = "0xf3fb6f72f1bbd5dffc03c8c120e7692559643b6d", M44_SAVING = "0x5475611dffb8ef4d697ae39df9395513b6e947d7", M44_PSM = "0x4809010926aec940b550d34a46a52739f996d75d";
const M45_REUSDE = "0xddc0f880ff6e4e22e4b74632fbb43ce4df6ccc5a", M45_ORACLE = "0x0d63495e3e827297c2686158055989da78eb47fe";
const M47_BORROWER = "0x6efc48b8b6222924fa6ea95d174af5518b761177";
const M48_BORROWER = "0x1cb432f80416f07db4420b8c20447924a0658894", M48_ORACLE = "0xa66a4f03fd8031973f8c7718904ce32385f54e70";
const M49_BORROWER = "0x52ac2d6711c30c389433bada0ad8f8ebb1c3f6f7", M49_ORACLE = "0xe47e36457d0cf83a74ae1e45382b7a044f7abd99", M49_FLUID_SUSDE_USDT = "0x1dd125c32e4b5086c63cc13b3ca02c4a2a61fa9b";
const UNIV3_EXACT_INPUT_IFACE = new Interface(["function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256 amountOut)"]);
const PENDLE_ROUTER_V4_IFACE = new Interface(["function swapExactPtForToken(address receiver, address market, uint256 exactPtIn, (address tokenOut, uint256 minTokenOut, address tokenRedeemSy, address pendleSwap, (uint8 swapType, address extRouter, bytes extCalldata, bool needScale) swapData) output, (address limitRouter, uint256 epsSkipMarket, ((uint256,uint256,uint256,uint8,address,address,address,address,uint256,uint256,uint256,bytes),bytes,uint256)[] normalFills, ((uint256,uint256,uint256,uint8,address,address,address,address,uint256,uint256,uint256,bytes),bytes,uint256)[] flashFills, bytes optData) limit) returns (uint256 netTokenOut, uint256 netSyFee, uint256 netSyInterm)"]);
const MORPHO_WST_BORROWERS = new Set([
  "0xb224f589297a5a207e6069de5dafd4b120129817",
  "0x4b441cd7c5085d0c255eff3db7ec3417cca1a1a0",
  "0xfb74196eccf35a260dd5cfd300baa37ae058b6c0",
]);
const UNIFIED_IFACE = new Interface(["function executeMorpho(uint256 flashAmount, (bool isAaveV3,address target,address borrower,address debtToken,address collateralToken,uint256 collateralReserveId,uint256 debtReserveId,uint256 minCollateralSeized,uint8 swapKind,address swapTarget,address swapSpender,uint24 uniFee,int128 curveI,int128 curveJ,uint256 minDebtTokenOut,uint256 minProfitDebtToken) params) external"]);
const CURVE_IFACE = new Interface(["function get_dy(int128 i,int128 j,uint256 dx) view returns(uint256)"]);
const MORPHO_EXEC_IFACE = new Interface(["function execute((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,address borrower,uint256 seizedAssets,uint256 repaidShares,uint256 minProfitWei,uint256 minOut,address router,bytes routerSwapData) external"]);
const M7_EXEC_IFACE = new Interface(["function execute((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv,address borrower,uint256 seizedAssets,address intermediateToken,address curvePool,int128 curveI,int128 curveJ,uint256 minLoanOut) plan) external"]);
const YN_ARB_EXEC_IFACE = new Interface(["function execute((address loanToken,address vaultToken,address curvePool,int128 curveI,int128 curveJ,uint256 flashAmount,uint256 minSharesOut,uint256 minLoanOut) plan) external"]);
const EULER_EVK_EXEC_IFACE = new Interface(["function execute((address loanToken,address liabilityVault,address collateralVault,address underlyingCollateral,address violator,uint256 repayAssets,uint256 minYieldShares,uint8 unwindKind,address swapTarget,int128 curveI,int128 curveJ,uint256 minLoanOut) plan) external"]);
const UNIV4_FLASH_EXEC_IFACE = new Interface(["function execute((uint8 mode,address target,address collateralVault,uint256 collateralReserveId,uint256 debtReserveId,address borrower,address debtAsset,address collateralAsset,uint256 flashAmount,uint256 debtToCover,uint256 minCollateralSeized,uint256 minSwapOut,uint256 minProfit,uint256 deadline,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne) plan) external returns (uint256 profitOut)"]);
const PENDLE_PT_EXEC_IFACE = new Interface(["function execute((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv,address borrower,uint256 seizedAssets,address pendleYt,address pendleSy,address redeemedToken,address swapTarget,uint256 minLoanOut) plan, bytes swapData) external"]);
const M2_EXEC_IFACE = new Interface(["function execute((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv,address borrower,uint256 seizedAssets,address swapTarget,uint256 minLoanOut) plan, bytes swapData) external"]);
const CURVE_EXCHANGE_IFACE = new Interface(["function exchange(int128 i,int128 j,uint256 dx,uint256 min_dy) returns (uint256)"]);
const QUOTER_IFACE = new Interface(["function quoteExactInput(bytes path,uint256 amountIn) view returns(uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)"]);
const SAVING_REDEEM1_IFACE = new Interface(["function redeem(uint256 amount) external"]);
const FLUID_DEX_SWAP_IFACE = new Interface(["function swapIn(bool swap0to1, uint256 amountIn, uint256 amountOutMin, address to) external payable returns (uint256 amountOut)"]);
function scaleInnerSwapData(hexData, num, den, minOut) {
  if (!hexData || hexData === "0x" || (num === den && minOut === undefined)) return hexData;
  const sel = hexData.slice(0, 10).toLowerCase();
  if (sel === "0xc04b8d59") {
    const p = UNIV3_EXACT_INPUT_IFACE.decodeFunctionData("exactInput", hexData)[0];
    return UNIV3_EXACT_INPUT_IFACE.encodeFunctionData("exactInput", [{
      path: p.path, recipient: p.recipient, deadline: p.deadline,
      amountIn: (p.amountIn * num) / den, amountOutMinimum: minOut ?? (p.amountOutMinimum * num) / den,
    }]);
  }
  if (sel === "0x3df02124") {
    const d = CURVE_EXCHANGE_IFACE.decodeFunctionData("exchange", hexData);
    return CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [d[0], d[1], (d[2] * num) / den, minOut ?? (d[3] * num) / den]);
  }
  if (sel === FLUID_DEX_SWAP_IFACE.getFunction("swapIn").selector.toLowerCase()) {
    const d = FLUID_DEX_SWAP_IFACE.decodeFunctionData("swapIn", hexData);
    return FLUID_DEX_SWAP_IFACE.encodeFunctionData("swapIn", [d[0], (d[1] * num) / den, minOut ?? (d[2] * num) / den, d[3]]);
  }
  if (sel === SAVING_REDEEM1_IFACE.getFunction("redeem").selector.toLowerCase()) {
    const d = SAVING_REDEEM1_IFACE.decodeFunctionData("redeem", hexData);
    return SAVING_REDEEM1_IFACE.encodeFunctionData("redeem", [(d[0] * num) / den]);
  }
  if (sel === "0xba087652") {
    const d = ERC4626_REDEEM_IFACE.decodeFunctionData("redeem", hexData);
    return ERC4626_REDEEM_IFACE.encodeFunctionData("redeem", [(d[0] * num) / den, d[1], d[2]]);
  }
  if (sel === ERC4626_REDEEM4_IFACE.getFunction("redeem").selector.toLowerCase()) {
    const d = ERC4626_REDEEM4_IFACE.decodeFunctionData("redeem", hexData);
    return ERC4626_REDEEM4_IFACE.encodeFunctionData("redeem", [(d[0] * num) / den, d[1], d[2], d[3]]);
  }
  if (sel === CURVE_ROUTER_NG_IFACE.getFunction("exchange").selector.toLowerCase()) {
    const d = CURVE_ROUTER_NG_IFACE.decodeFunctionData("exchange", hexData);
    return CURVE_ROUTER_NG_IFACE.encodeFunctionData("exchange", [d[0], d[1], (d[2] * num) / den, minOut ?? (d[3] * num) / den, d[4], d[5]]);
  }
  if (sel === "0x594a88cc") {
    const d = PENDLE_ROUTER_V4_IFACE.decodeFunctionData("swapExactPtForToken", hexData);
    const sd = d[3].swapData.toObject();
    if (sd.extCalldata && sd.extCalldata !== "0x" && !sd.needScale) return null;
    const out = { ...d[3].toObject(), minTokenOut: minOut ?? (d[3].minTokenOut * num) / den, swapData: sd };
    return PENDLE_ROUTER_V4_IFACE.encodeFunctionData("swapExactPtForToken", [d[0], d[1], (d[2] * num) / den, out, d[4]]);
  }
  return null;
}
// A native-profit proof belongs to one exact size, not its scaled calldata.
// An explicit map overrides the base too; missing/null entries mean unknown.
function variantConservativeProfit(options, bps) {
  if (options.variantProfitByBps !== undefined) return options.variantProfitByBps?.[bps] ?? null;
  return bps === 10000 ? options.conservativeProfitBeforeGasWei ?? null : null;
}
function buildYnVariantSizes(candidate) {
  return [10n, 8n, 5n, 3n, 2n, 1n].map(mult => ({ mult, flashAmount: candidate.flashAmount * mult,
    conservativeProfitBeforeGasWei: variantConservativeProfit(candidate, Number(mult * 10000n)) }))
    .filter(variant => variant.flashAmount <= 45000000000000000000n);
}
function buildScaledUniversalVariants(data, minProfitRaw, options = {}) {
  const variants = [{ data, minProfitRaw, conservativeProfitBeforeGasWei: variantConservativeProfit(options, 10000) }];
  try {
    const p = UNIVERSAL_EXEC_IFACE.decodeFunctionData("execute", data)[0].toObject();
    for (const [num, den] of [[50n, 100n], [25n, 100n]]) {
      const d1 = scaleInnerSwapData(p.data1, num, den);
      const d2 = scaleInnerSwapData(p.data2, num, den);
      if (d1 === null || d2 === null) continue;
      const scaledMinProfit = (minProfitRaw * num) / den > 0n ? (minProfitRaw * num) / den : 1n;
      const scaledPlan = {
        ...p,
        flashAmount: (p.flashAmount * num) / den,
        seizedAssets: (p.seizedAssets * num) / den,
        data1: d1,
        data2: d2,
        minProfit: scaledMinProfit,
      };
      variants.push({ data: UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", [scaledPlan]), minProfitRaw: scaledMinProfit,
        conservativeProfitBeforeGasWei: variantConservativeProfit(options, Number(num * 10000n / den)) });
    }
  } catch (_) {}
  return variants;
}
function buildScaledEulerVariants(data, minProfitRaw, options = {}) {
  const variants = [{ data, minProfitRaw, conservativeProfitBeforeGasWei: variantConservativeProfit(options, 10000) }];
  try {
    const p = UNIVERSAL_EULER_EXEC_IFACE.decodeFunctionData("execute", data)[0].toObject();
    for (const [num, den] of [[50n, 100n], [25n, 100n]]) {
      const scaledRepay = (p.repayAssets * num) / den;
      const scaledMinProfit = (minProfitRaw * num) / den > 0n ? (minProfitRaw * num) / den : 1n;
      const scaledPlan = {
        ...p,
        repayAssets: scaledRepay,
        maxRepayAssets: scaledRepay,
        minYieldShares: 1n,
        minLoanOut: scaledRepay + scaledMinProfit,
      };
      variants.push({ data: UNIVERSAL_EULER_EXEC_IFACE.encodeFunctionData("execute", [scaledPlan]), minProfitRaw: scaledMinProfit,
        conservativeProfitBeforeGasWei: variantConservativeProfit(options, Number(num * 10000n / den)) });
    }
  } catch (_) {}
  return variants;
}
function isM31KyberSwap(candidate, plan, swapData) {
  return candidate.id === "targetM31_Morpho_syrupUSDC_USDC" && candidate.executor?.toLowerCase() === M2_EXECUTOR &&
    plan.swapTarget.toLowerCase() === KYBER_ROUTER && plan.collateralToken.toLowerCase() === SYRUP_USDC &&
    plan.loanToken.toLowerCase() === USDC && swapData.toLowerCase().startsWith("0xe21fd0e9");
}
function validM31KyberSwapData(data) {
  return typeof data === "string" && data.length > 100 && /^0xe21fd0e9(?:[0-9a-fA-F]{2})+$/.test(data);
}
async function buildM31KyberUniV4SwapData(amountIn) {
  const amount = uint(amountIn, "M31_KYBER_AMOUNT_INVALID");
  requireThat(amount > 0n, "M31_KYBER_AMOUNT_INVALID");
  const signal = AbortSignal.timeout(5000);
  const routeResponse = await fetch(`https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?tokenIn=${SYRUP_USDC}&tokenOut=${USDC}&amountIn=${amount}&includedSources=uniswap-v4`, {
    method: "GET", headers: { "x-client-id": "opencode-audit" }, signal,
  });
  requireThat(routeResponse.ok, "M31_KYBER_ROUTE_UNAVAILABLE");
  const routeSummary = (await routeResponse.json())?.data?.routeSummary;
  requireThat(routeSummary && typeof routeSummary === "object", "M31_KYBER_ROUTE_UNAVAILABLE");
  const buildResponse = await fetch("https://aggregator-api.kyberswap.com/ethereum/api/v1/route/build", {
    method: "POST", headers: { "content-type": "application/json", "x-client-id": "opencode-audit" }, signal,
    // M2_EXECUTOR is the monitor's M2_CURVE_UNWIND_EXECUTOR, not the wallet.
    body: JSON.stringify({ routeSummary, sender: M2_EXECUTOR, recipient: M2_EXECUTOR,
      slippageTolerance: 100, deadline: 2147483647 }),
  });
  requireThat(buildResponse.ok, "M31_KYBER_ROUTE_UNAVAILABLE");
  const data = (await buildResponse.json())?.data?.data;
  requireThat(validM31KyberSwapData(data), "M31_KYBER_ROUTE_UNAVAILABLE");
  return data;
}
// Preserve the synchronous, IO-free array API. Only the async wrapper fetches
// opaque Kyber calldata; replacements are keyed by the exact seized amount.
function buildScaledM2Variants(candidate, rebuiltKyberSwapData = new Map()) {
  const fullLadder = candidate.useFullBpsLadder === true || candidate.id === "targetM32_Morpho_sUSDe_USDtb";
  const base = fullLadder || candidate.variantProfitByBps !== undefined ? { ...candidate,
    ...(fullLadder ? { bps: 10000 } : {}),
    ...(candidate.variantProfitByBps !== undefined ? { conservativeProfitBeforeGasWei:
      variantConservativeProfit(candidate, 10000) } : {}) } : candidate;
  const variants = candidate.fullRepaidSharesVariant ? [candidate.fullRepaidSharesVariant, base] : [base];
  try {
    const decoded = M2_EXEC_IFACE.decodeFunctionData("execute", candidate.data);
    const p = decoded[0].toObject();
    const swapData = decoded[1];
    const baseSwapMinOut = candidate.innerSwapMinOut ?? candidate.minOutUsdc;
    const principalEst = p.minLoanOut > candidate.minProfitUsdc ? p.minLoanOut - candidate.minProfitUsdc : p.minLoanOut;
    const scales = fullLadder
      ? [[95n, 100n], [90n, 100n], [80n, 100n], [70n, 100n], [50n, 100n], [25n, 100n]]
      : [[50n, 100n], [25n, 100n]];
    for (const [num, den] of scales) {
      const scaledMinOut = (candidate.minOutUsdc * num + den - 1n) / den;
      const scaledSwapMinOut = (baseSwapMinOut * num + den - 1n) / den;
      const scaledSeize = (p.seizedAssets * num) / den;
      let scaledSwap = scaleInnerSwapData(swapData, num, den, scaledSwapMinOut);
      if (scaledSwap === null && isM31KyberSwap(candidate, p, swapData)) {
        const rebuilt = rebuiltKyberSwapData.get(scaledSeize);
        if (validM31KyberSwapData(rebuilt)) scaledSwap = rebuilt;
      }
      if (scaledSwap === null) continue;
      const scaledMinProfit = (candidate.minProfitUsdc * num) / den > 0n ? (candidate.minProfitUsdc * num) / den : 1n;
      const scaledMinLoanOut = (principalEst * num) / den + scaledMinProfit;
      const scaledPlan = { ...p, seizedAssets: scaledSeize, minLoanOut: scaledMinLoanOut };
      variants.push({
        ...candidate,
        bps: Number((num * 10000n) / den),
        data: M2_EXEC_IFACE.encodeFunctionData("execute", [scaledPlan, scaledSwap]),
        seizedAssets: scaledSeize,
        minLoanOut: scaledMinLoanOut,
        minOutUsdc: scaledMinOut,
        innerSwapMinOut: candidate.innerSwapMinOut !== undefined ? scaledSwapMinOut : undefined,
        minProfitUsdc: scaledMinProfit,
        conservativeProfitBeforeGasWei: variantConservativeProfit(candidate, Number((num * 10000n) / den)),
      });
    }
  } catch (_) {}
  return variants;
}
async function* buildScaledM2VariantsWithKyber(candidate, rebuildKyberSwapData = buildM31KyberUniV4SwapData) {
  yield* buildScaledM2Variants(candidate);
  let plan, swapData;
  try { const decoded = M2_EXEC_IFACE.decodeFunctionData("execute", candidate.data); plan = decoded[0]; swapData = decoded[1]; }
  catch (_) { return; }
  if (!isM31KyberSwap(candidate, plan, swapData)) return;
  const sizes = candidate.useFullBpsLadder === true ? [9500, 9000, 8000, 7000, 5000, 2500] : [5000, 2500];
  for (const bps of sizes) {
    const amountIn = plan.seizedAssets * BigInt(bps) / 10000n;
    if (amountIn === 0n) continue;
    try {
      const swap = await rebuildKyberSwapData(amountIn);
      const variant = buildScaledM2Variants(candidate, new Map([[amountIn, swap]])).find(row => row.bps === bps);
      if (variant) yield variant;
    } catch (_) { /* Skip only this unavailable size; never reuse full-size opaque calldata. */ }
  }
}
function buildScaledM1Variants(candidate, isWst) {
  const variants = [candidate.variantProfitByBps !== undefined ? { ...candidate,
    conservativeProfitBeforeGasWei: variantConservativeProfit(candidate, 10000) } : candidate];
  try {
    const d = MORPHO_EXEC_IFACE.decodeFunctionData("execute", candidate.data);
    const mp = d[0].toObject();
    const floor = isWst ? (candidate.usePlanMinProfit ? 1000000000000000n : 10000000000000000n) : 5000000000000000000n;
    for (const [num, den] of [[50n, 100n], [25n, 100n]]) {
      const scaledSeize = (d[2] * num) / den;
      let scaledMinProfit = (d[4] * num) / den;
      scaledMinProfit = scaledMinProfit > floor ? scaledMinProfit : floor;
      const scaledMinOut = (d[5] * num + den - 1n) / den;
      const scaledData = MORPHO_EXEC_IFACE.encodeFunctionData("execute", [
        mp, d[1], scaledSeize, d[3], scaledMinProfit, scaledMinOut, d[6], d[7],
      ]);
      variants.push({
        ...candidate,
        data: scaledData,
        seizedAssets: scaledSeize,
        conservativeProfitBeforeGasWei: variantConservativeProfit(candidate, Number(num * 10000n / den)),
        ...(isWst ? { minProfitWeth: scaledMinProfit, minOutWeth: scaledMinOut } : { minProfitDai: scaledMinProfit, minOutDai: scaledMinOut }),
      });
    }
  } catch (_) {}
  return variants;
}
function buildScaledUniV4Variants(data, minProfitRaw, options = {}) {
  const variants = [{ data, minProfitRaw, conservativeProfitBeforeGasWei: variantConservativeProfit(options, 10000) }];
  try {
    const p = UNIV4_FLASH_EXEC_IFACE.decodeFunctionData("execute", data)[0].toObject();
    const pk = p.poolKey.toObject();
    for (const [num, den] of [[50n, 100n], [25n, 100n]]) {
      const scaledFlash = (p.flashAmount * num) / den;
      const scaledMinProfit = (minProfitRaw * num) / den > 0n ? (minProfitRaw * num) / den : 1n;
      const scaledPlan = {
        ...p,
        poolKey: pk,
        flashAmount: scaledFlash,
        debtToCover: p.debtToCover === 0n ? 0n : p.debtToCover > p.flashAmount ? scaledFlash : (p.debtToCover * num) / den,
        minCollateralSeized: (p.minCollateralSeized * num) / den,
        minSwapOut: (p.minSwapOut * num) / den,
        minProfit: scaledMinProfit,
      };
      variants.push({ data: UNIV4_FLASH_EXEC_IFACE.encodeFunctionData("execute", [scaledPlan]), minProfitRaw: scaledMinProfit,
        conservativeProfitBeforeGasWei: variantConservativeProfit(options, Number(num * 10000n / den)) });
    }
  } catch (_) {}
  return variants;
}
function buildScaledUnifiedWethVariants(candidate) {
  const variants = [candidate];
  const sameAsset = candidate.kind === "AAVE_V4_SAME_ASSET_WETH";
  if (sameAsset && candidate.params?.isAaveV3 !== true) return variants;
  try {
    const d = UNIFIED_IFACE.decodeFunctionData("executeMorpho", candidate.data);
    const flash = d[0];
    const p = d[1].toObject();
    const floor = sameAsset ? 10000000000000000n : candidate.usePlanMinProfit ? 1000000000000000n : 2500000000000000n;
    for (const [num, den] of [[50n, 100n], [25n, 100n]]) {
      const scaledFlash = (flash * num) / den;
      let scaledMinProfit = (p.minProfitDebtToken * num) / den;
      scaledMinProfit = scaledMinProfit > floor ? scaledMinProfit : floor;
      const scaledParams = {
        ...p,
        minCollateralSeized: (p.minCollateralSeized * num) / den,
        minDebtTokenOut: (p.minDebtTokenOut * num + den - 1n) / den,
        minProfitDebtToken: scaledMinProfit,
      };
      variants.push({
        ...candidate,
        data: UNIFIED_IFACE.encodeFunctionData("executeMorpho", [scaledFlash, scaledParams]),
        flashAmount: scaledFlash,
        conservativeProfitBeforeGasWei: variantConservativeProfit(candidate, Number(num * 10000n / den)),
        params: sameAsset ? { ...scaledParams, minDebtTokenOut: scaledFlash + scaledMinProfit } : scaledParams,
      });
    }
  } catch (_) {}
  return variants;
}
function buildScaledPendlePtVariants(data, minProfitRaw, options = {}) {
  const fullLadder = options.useFullBpsLadder === true;
  const variants = [{ data, minProfitRaw, ...(fullLadder ? { bps: 10000 } : {}),
    conservativeProfitBeforeGasWei: variantConservativeProfit(options, 10000) }];
  try {
    const decoded = PENDLE_PT_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0].toObject(), swapData = decoded[1];
    const principalEst = p.minLoanOut > minProfitRaw ? p.minLoanOut - minProfitRaw : p.minLoanOut;
    const scales = fullLadder ? [[95n, 100n], [90n, 100n], [80n, 100n], [70n, 100n], [50n, 100n], [25n, 100n]] : [[50n, 100n], [25n, 100n]];
    for (const [num, den] of scales) {
      const scaledSwap = scaleInnerSwapData(swapData, num, den);
      if (scaledSwap === null) continue;
      const scaledSeize = (p.seizedAssets * num) / den;
      const scaledMinProfit = (minProfitRaw * num) / den > 0n ? (minProfitRaw * num) / den : 1n;
      const scaledPlan = {
        ...p,
        seizedAssets: scaledSeize,
        minLoanOut: (principalEst * num) / den + scaledMinProfit,
      };
      variants.push({ data: PENDLE_PT_EXEC_IFACE.encodeFunctionData("execute", [scaledPlan, scaledSwap]), minProfitRaw: scaledMinProfit,
        ...(fullLadder ? { bps: Number((num * 10000n) / den) } : {}),
        conservativeProfitBeforeGasWei: variantConservativeProfit(options, Number((num * 10000n) / den)) });
    }
  } catch (_) {}
  return variants;
}
const V3_TARGETS = Object.freeze([
  { key: "target2A_AaveV3_weETH_WETH_0x7231", borrower: "0x7231eaeea108e3ea05c993cbee21f23ddd7a44bf" },
  { key: "target2B_AaveV3_weETH_WETH_0x1A55", borrower: "0x1a557354c5b8d7df38ea914209e416dc7065b158" },
  { key: "target2N_AaveV3_weETH_WETH_0xee28", borrower: "0xee2826453a4fd5afeb7ceffeef3ffa2320081268" },
  { key: "target2O_AaveV3_weETH_WETH_0x5047", borrower: "0x5047e08c576778fffce5934ac658c80ada1fcc4c" },
  { key: "target2P_AaveV3_weETH_WETH_0x1d46", borrower: "0x1d46ce6b1d12b1ce9252034e9fb7a292db762e38" },
  { key: "target2Q_AaveV3_weETH_WETH_0x5410", borrower: "0x5410d09be697e57cd7c4ffa83759abed3219e020" }
]);
const REQUIRED_TARGETS = [POOL, CURVE, "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb", "0xe592427a0aece92de3edee1f18e0157c05861564"];
function shouldDelegateAaveV4ToDedicatedRunner(argv = []) {
  guard.parseMode(argv, "--execute");
  return argv.includes("--skip-aave-v4") || !argv.includes("--include-aave-v4"); // No telemetry-dependent ownership.
}
function validateAuthorization(batch, now) { return guard.validateBatch(batch, { kind: "unified", requiredTargets: REQUIRED_TARGETS, now }); }
function readBatchWithRenewal(primaryPath, renewalPath, currentNow = Date.now()) {
  const primary = JSON.parse(fs.readFileSync(primaryPath, "utf8"));
  const expiredApproval = primary?.schema === "live-execution-batch/v1" && primary.approved === true && primary.revoked !== true && Number.isFinite(currentNow) &&
    typeof primary.approvedAt === "string" && primary.approvedAt.trim() !== "" && Number.isFinite(Date.parse(primary.approvedAt)) && Date.parse(primary.approvedAt) <= currentNow &&
    typeof primary.expiresAt === "string" && primary.expiresAt.trim() !== "" && Number.isFinite(Date.parse(primary.expiresAt)) && currentNow >= Date.parse(primary.expiresAt);
  return expiredApproval && fs.existsSync(renewalPath)
    ? JSON.parse(fs.readFileSync(renewalPath, "utf8")) : primary;
}
function requireVerifiedCurrentProfit(profitBeforeGasWei) {
  requireThat(typeof profitBeforeGasWei === "bigint" ||
    typeof profitBeforeGasWei === "string" && /^[0-9]+$/.test(profitBeforeGasWei), "PROFIT_UNVERIFIED");
  const profit = BigInt(profitBeforeGasWei);
  requireThat(profit > 0n, "PROFIT_UNVERIFIED");
  return profit;
}
function requireVerifiedCurrentVariant(candidate) {
  let iface, variants;
  switch (candidate.kind) {
    case "MORPHO_BLUE_M2": iface = M2_EXEC_IFACE; variants = buildScaledM2Variants(candidate); break;
    case "MORPHO_BLUE_WSTETH": iface = MORPHO_EXEC_IFACE; variants = buildScaledM1Variants(candidate, true); break;
    case "MORPHO_PENDLE_PT_REDEEM": iface = PENDLE_PT_EXEC_IFACE; variants = buildScaledPendlePtVariants(candidate.data, candidate.minProfitRaw, candidate); break;
    case "UNIV4_FLASH_LIQUIDATION": iface = UNIV4_FLASH_EXEC_IFACE; variants = buildScaledUniV4Variants(candidate.data, candidate.minProfitRaw, candidate); break;
    case "UNIVERSAL_FLUID_MORPHO_LIQUIDATION": iface = UNIVERSAL_EXEC_IFACE; variants = buildScaledUniversalVariants(candidate.data, candidate.minProfitRaw, candidate); break;
    case "UNIVERSAL_EULER_EVK_LIQUIDATION": iface = UNIVERSAL_EULER_EXEC_IFACE; variants = buildScaledEulerVariants(candidate.data, candidate.minProfitRaw, candidate); break;
    case "CURVE_BUY_VAULT_REDEEM_YN": iface = YN_ARB_EXEC_IFACE; variants = buildYnVariantSizes(candidate); break;
    case "MORPHO_BLUE_M7": iface = M7_EXEC_IFACE; variants = [candidate]; break;
    case "EULER_EVK_E1": iface = EULER_EVK_EXEC_IFACE; variants = [candidate]; break;
    default: return;
  }
  const canonical = data => {
    try { return iface.encodeFunctionData("execute", iface.decodeFunctionData("execute", data)).toLowerCase() === data.toLowerCase(); }
    catch (_) { return false; }
  };
  requireThat(canonical(candidate.data), "EXECUTION_CALLDATA_INVALID");
  // Admission is not a proof producer. Count only existing, supported variants,
  // never arbitrary map keys or opaque sizes awaiting an external rebuild.
  requireThat(variants.some(variant => {
    if (candidate.kind !== "CURVE_BUY_VAULT_REDEEM_YN" && !canonical(variant.data)) return false;
    try { requireVerifiedCurrentProfit(variant.conservativeProfitBeforeGasWei); return true; }
    catch (_) { return false; }
  }), "PROFIT_UNVERIFIED");
}
function retainExecutorObservation(value) {
  if (Array.isArray(value)) return value.map(retainExecutorObservation);
  if (!value || typeof value !== "object") return value;
  const original = value.debtObservation || value.pin;
  const timestamp = value.observationTimestamp ?? original?.timestamp ?? null;
  const date = Number.isSafeInteger(timestamp) && timestamp > 0 ? new Date(timestamp * 1000) : null;
  const reason = "EXECUTOR_OBSERVATION_RETAINED";
  const row = { ...value,
    observationKind: "READ_ONLY_MONITOR", observationStatus: "INCOMPLETE", observationReason: reason,
    refreshStatus: "INCOMPLETE", refreshReason: reason,
    chainId: value.chainId ?? original?.chainId ?? null,
    observationBlock: value.observationBlock ?? original?.number ?? null,
    observationHash: value.observationHash ?? original?.hash ?? null,
    observationTimestamp: timestamp,
    observationUtc: value.observationUtc ?? original?.utc ?? (date && Number.isFinite(date.getTime()) ? date.toISOString() : null),
    quoteObservation: value.quoteObservation ?? null,
    armed: false, executableNow: false, eligibleForPreflight: false, quoteCurrent: false,
  };
  if (value.liveQuote) row.liveQuote = { ...value.liveQuote,
    observationBlock: value.liveQuote.observationBlock ?? null,
    observationHash: value.liveQuote.observationHash ?? null,
    observationUtc: value.liveQuote.observationUtc ?? null };
  delete row.nextBlockForecast;
  if (Array.isArray(value.additionalBorrowers)) row.additionalBorrowers = value.additionalBorrowers.map(retainExecutorObservation);
  return row;
}
function validateMorphoAuthorization(morphoBatch, now) {
  requireThat(morphoBatch?.schema === "live-execution-batch/v1" && morphoBatch.approved === true && morphoBatch.revoked !== true && Number.isFinite(now) &&
    typeof morphoBatch.approvedAt === "string" && morphoBatch.approvedAt.trim() !== "" && Number.isFinite(Date.parse(morphoBatch.approvedAt)) && Date.parse(morphoBatch.approvedAt) <= now &&
    typeof morphoBatch.expiresAt === "string" && morphoBatch.expiresAt.trim() !== "" && Number.isFinite(Date.parse(morphoBatch.expiresAt)) && now < Date.parse(morphoBatch.expiresAt),
  "BATCH_INVALID_OR_EXPIRED");
  requireThat(morphoBatch.chainId === 1 && morphoBatch.chain === "ethereum" && morphoBatch.account?.address?.toLowerCase() === MAIN_ACCOUNT, "BATCH_SCOPE_MISMATCH");
  requireThat(Array.isArray(morphoBatch.targets) && morphoBatch.targets.some(t => t.address?.toLowerCase() === MORPHO_EXECUTOR) && morphoBatch.targets.some(t => t.address?.toLowerCase() === BALANCER_VAULT), "BATCH_TARGET_NOT_APPROVED");
  requireThat(Array.isArray(morphoBatch.actions) && morphoBatch.actions.some(a => typeof a === "string" && a.startsWith("executor.execute(MarketParams, borrower, seizedAssets, repaidShares, minProfitWei, minOut, router, routerSwapData)")), "BATCH_ACTION_NOT_APPROVED");
  const c = morphoBatch.caps || {};
  const gasCap = uint(c.maxGasLimitPerTransaction, "BATCH_CAP_INVALID"), spendCap = uint(c.maxNativeSpendPerTransactionWei, "BATCH_CAP_INVALID"), dailyCap = uint(c.signedExecutionsPerDay, "BATCH_CAP_INVALID");
  requireThat(gasCap > 0n && spendCap > 0n && dailyCap > 0n, "BATCH_CAP_INVALID");
  return { gasCap, spendCap, feeCap: null, dailyCap, lifetimeCap: c.signedExecutionsTotal === undefined ? null : uint(c.signedExecutionsTotal, "BATCH_CAP_INVALID"),
    minProfitDai: 25000000000000000000n };
}
// Monitor eligibility nominates a plan only. It supplies neither native-profit
// evidence nor authorization, and cannot make a retained row current again.
function currentNominationEligible(row, pin, legacyEligible = true) {
  if (row?.observationKind !== "READ_ONLY_MONITOR") return legacyEligible;
  if (row.eligibleForPreflight !== true || row.observationStatus !== "COMPLETE" || row.refreshStatus !== "COMPLETE" ||
      row.chainId !== 1 || !Number.isSafeInteger(row.observationBlock) || row.observationBlock < 0 ||
      !/^0x[0-9a-f]{64}$/i.test(row.observationHash || "") ||
      !Number.isSafeInteger(row.observationTimestamp) || row.observationTimestamp <= 0) return false;
  // Selection-only callers may supply a self-contained observed row. A runner
  // supplies its collection pin; never rebind old row provenance to that pin.
  return pin == null || pin.chainId === row.chainId && pin.number === row.observationBlock &&
    pin.hash?.toLowerCase() === row.observationHash.toLowerCase() && pin.timestamp === row.observationTimestamp;
}
function selectValidatedCandidates(status, argv = []) {
  const delegate = shouldDelegateAaveV4ToDedicatedRunner(argv);
  const definitions = V3_TARGETS.map(t => ({ ...t, isV3: true, target: POOL }));
  for (const [i, borrower] of EXTRA_V3_WEETH_USERS.entries()) {
    const rank = String.fromCharCode(67 + i);
    const item = status.targets.additional_AaveV3_weETH_WETH?.find(v => v.user?.toLowerCase() === borrower);
    definitions.push({ key: `target2_${rank}_${borrower.slice(0, 6)}`, borrower, isV3: true, target: POOL, item });
  }
  if (!delegate) {
    const { TARGET_PLANS } = require("./execute-aave-v4-liquidation.js");
    for (const t of TARGET_PLANS) {
      const item = t.id.startsWith("spokeA") ? status.targets.target1_AaveV4_USDe_USDC : status.targets.spokeC_AaveV4_weETH_WETH?.find(v => v.user?.toLowerCase() === t.borrower);
      definitions.push({ key: t.id, borrower: t.borrower, target: t.spoke, isV3: false, item });
    }
  }
  const selected = [];
  for (const definition of definitions) {
    const item = definition.item || status.targets[definition.key];
    if (item?.liquidatableNow !== true || !item.readyExecuteMorphoCalldata) continue;
    requireThat(item.user?.toLowerCase() === definition.borrower, "COLLECTOR_TARGET_MISMATCH");
    const data = item.readyExecuteMorphoCalldata, decoded = UNIFIED_IFACE.decodeFunctionData("executeMorpho", data), p = decoded[1];
    requireThat(UNIFIED_IFACE.encodeFunctionData("executeMorpho", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.isAaveV3 === definition.isV3 && p.target.toLowerCase() === definition.target && p.borrower.toLowerCase() === definition.borrower, "EXECUTION_TARGET_MISMATCH");
    // USDC V4 execution remains with the dedicated runner: this runner has no exact USD/native gas conversion.
    requireThat(p.debtToken.toLowerCase() === WETH && p.collateralToken.toLowerCase() === WEETH && p.swapKind === 2n &&
      p.swapTarget.toLowerCase() === CURVE && p.swapSpender.toLowerCase() === CURVE && p.uniFee === 0n && p.curveI === 1n && p.curveJ === 0n &&
      p.collateralReserveId === 0n && p.debtReserveId === (definition.isV3 ? 0n : 1n), "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(decoded[0] > 0n && p.minCollateralSeized > 0n && p.minDebtTokenOut > 0n && p.minProfitDebtToken >= 10000000000000000n, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    selected.push({ id: definition.key, target: definition.target, borrower: definition.borrower, data, params: p, flashAmount: decoded[0] });
  }
  for (const [id, borrower, flashAmount, minProfit] of [
    ["target2K_AaveV3_WETH_WETH_0x7a05", "0x7a0575018b57cb64434fcd794f4f0c624fd0fbd3", 5400000000000000000n, 10000000000000000n],
    ["target2L_AaveV3_WETH_WETH_0xd185", "0xd185e7fafa5d75c7fcb3ff0844fe4c307d8fd57a", 12000000000000000000n, 100000000000000000n],
    ["target2M_AaveV3_WETH_WETH_0xf316", "0xf316d8b6fa4e13af2fbf51c0e17dd2742fb0dc2c", 4500000000000000000n, 10000000000000000n],
  ]) {
    const item = status.targets?.[id];
    if (item?.liquidatableNow !== true || !item.readyExecuteMorphoCalldata) continue;
    requireThat(item.user?.toLowerCase() === borrower, "COLLECTOR_TARGET_MISMATCH");
    const data = item.readyExecuteMorphoCalldata, decoded = UNIFIED_IFACE.decodeFunctionData("executeMorpho", data), p = decoded[1].toObject();
    requireThat(UNIFIED_IFACE.encodeFunctionData("executeMorpho", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.isAaveV3 === true && p.target.toLowerCase() === POOL && p.borrower.toLowerCase() === borrower, "EXECUTION_TARGET_MISMATCH");
    requireThat(p.debtToken.toLowerCase() === WETH && p.collateralToken.toLowerCase() === WETH && p.swapKind === 0n &&
      p.collateralReserveId === 0n && p.debtReserveId === 0n && p.minDebtTokenOut === 0n && p.minCollateralSeized === 0n &&
      p.swapTarget === "0x0000000000000000000000000000000000000000" && p.swapSpender === "0x0000000000000000000000000000000000000000" &&
      p.uniFee === 0n && p.curveI === 0n && p.curveJ === 0n && decoded[0] === flashAmount, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.minProfitDebtToken >= minProfit, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    selected.push({ id, kind: "AAVE_V4_SAME_ASSET_WETH", target: POOL, borrower, data, flashAmount,
      params: { ...p, minDebtTokenOut: flashAmount + p.minProfitDebtToken } });
  }
  // A4 is not owned by the dedicated V4 runner; retain it even with --skip-aave-v4.
  const a4 = status.targets?.targetA4_AaveV4_SameAsset_0xa429;
  if (a4?.liquidatableNow === true && a4.readyExecuteMorphoCalldata) {
    requireThat(a4.user?.toLowerCase() === A4_BORROWER, "COLLECTOR_TARGET_MISMATCH");
    const data = a4.readyExecuteMorphoCalldata, decoded = UNIFIED_IFACE.decodeFunctionData("executeMorpho", data);
    // Convert ethers Result to named fields before spreading params for priority/preflight.
    const p = decoded[1].toObject();
    requireThat(UNIFIED_IFACE.encodeFunctionData("executeMorpho", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.isAaveV3 === false && p.target.toLowerCase() === A4_SPOKE && p.borrower.toLowerCase() === A4_BORROWER, "EXECUTION_TARGET_MISMATCH");
    requireThat(p.debtToken.toLowerCase() === WETH && p.collateralToken.toLowerCase() === WETH && p.swapKind === 0n &&
      p.collateralReserveId === 0n && p.debtReserveId === 0n && p.minSwapOut === undefined && p.minDebtTokenOut === 0n && p.minCollateralSeized === 0n &&
      p.swapTarget === "0x0000000000000000000000000000000000000000" && p.swapSpender === "0x0000000000000000000000000000000000000000" &&
      p.uniFee === 0n && p.curveI === 0n && p.curveJ === 0n && decoded[0] === 755000000000000000n, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.minProfitDebtToken >= 10000000000000000n, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    selected.push({ id: "targetA4_AaveV4_SameAsset_0xa429", kind: "AAVE_V4_SAME_ASSET_WETH", target: A4_SPOKE, borrower: A4_BORROWER,
      data, params: { ...p, minDebtTokenOut: decoded[0] + p.minProfitDebtToken }, flashAmount: decoded[0] });
  }
  for (const [cItem, cBorrower, cId] of [
    [status.targets?.targetC9_AaveV4_weETH_WETH_0x9f46, "0x9f4625288fb381f74285ba84230403ce4b8a6c1d", "targetC9_AaveV4_weETH_WETH_0x9f46"],
    [status.targets?.targetA15_AaveV4_weETH_WETH_0x3519, "0x3519ee4d387150f230baca90f5c50e9d296164c6", "targetA15_AaveV4_weETH_WETH_0x3519"],
    [status.targets?.targetA17_AaveV4_weETH_WETH_0xa751, "0xa7512e41d75b27f5a79b5f21aee1fee372fded5e", "targetA17_AaveV4_weETH_WETH_0xa751"],
  ]) {
    if (cItem?.liquidatableNow !== true || !cItem.readyExecuteMorphoCalldata) continue;
    const c9Spoke = "0xbf10bdfe177de0336afd7fccf80a904e15386219";
    requireThat(cItem.user?.toLowerCase() === cBorrower, "COLLECTOR_TARGET_MISMATCH");
    const data = cItem.readyExecuteMorphoCalldata, decoded = UNIFIED_IFACE.decodeFunctionData("executeMorpho", data), p = decoded[1];
    requireThat(UNIFIED_IFACE.encodeFunctionData("executeMorpho", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.isAaveV3 === false && p.target.toLowerCase() === c9Spoke && p.borrower.toLowerCase() === cBorrower, "EXECUTION_TARGET_MISMATCH");
    requireThat(p.debtToken.toLowerCase() === WETH && p.collateralToken.toLowerCase() === WEETH && p.swapKind === 2n &&
      p.swapTarget.toLowerCase() === CURVE && p.swapSpender.toLowerCase() === CURVE && p.uniFee === 0n && p.curveI === 1n && p.curveJ === 0n &&
      p.collateralReserveId === 0n && p.debtReserveId === 1n, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(decoded[0] > 0n && p.minCollateralSeized > 0n && p.minDebtTokenOut > 0n && p.minProfitDebtToken >= 10000000000000000n, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    selected.push({ id: cId, target: c9Spoke, borrower: cBorrower, data, params: p, flashAmount: decoded[0] });
  }
  const a13 = status.targets?.targetA13_AaveV4_wstETH_WETH_0x4cd7;
  if (a13?.liquidatableNow === true && a13.readyExecuteMorphoCalldata) {
    const a13Borrower = "0x4cd76521f616db4d6978a4a80aeb77ccc9e890ec";
    const a13Spoke = "0xe1900480ac69f0b296841cd01cc37546d92f35cd";
    requireThat(a13.user?.toLowerCase() === a13Borrower, "COLLECTOR_TARGET_MISMATCH");
    const data = a13.readyExecuteMorphoCalldata, decoded = UNIFIED_IFACE.decodeFunctionData("executeMorpho", data), p = decoded[1];
    requireThat(UNIFIED_IFACE.encodeFunctionData("executeMorpho", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.isAaveV3 === false && p.target.toLowerCase() === a13Spoke && p.borrower.toLowerCase() === a13Borrower, "EXECUTION_TARGET_MISMATCH");
    requireThat(p.debtToken.toLowerCase() === WETH && p.collateralToken.toLowerCase() === WSTETH && p.swapKind === 1n &&
      p.swapTarget.toLowerCase() === UNI_ROUTER && p.swapSpender.toLowerCase() === UNI_ROUTER && p.uniFee === 100n &&
      p.collateralReserveId === 0n && p.debtReserveId === 1n, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(decoded[0] > 0n && p.minCollateralSeized > 0n && p.minDebtTokenOut > 0n && p.minProfitDebtToken >= 2000000000000000n, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    selected.push({ id: "targetA13_AaveV4_wstETH_WETH_0x4cd7", target: a13Spoke, borrower: a13Borrower, data, params: p, flashAmount: decoded[0], usePlanMinProfit: true });
  }
  for (const [id, borrower, pool] of [
    ["target2J_AaveV3_wstETH_WETH_0x037a", USER_V3_037A, POOL],
    ["targetS1_Spark_wstETH_WETH_0x4b28", "0x4b2877a94ead57e8a5e07b7b044eaeb59f605886", SPARK_POOL],
    ["targetS2_Spark_wstETH_WETH_0xf8f5", "0xf8f59620f260583e833d43a1940e6d210d0ce912", SPARK_POOL],
    ["targetS3_Spark_wstETH_WETH_0x0f8f", "0x0f8f3f27a9626de852cff35c9ed1a261131b70fe", SPARK_POOL],
    ["targetS4_Spark_wstETH_WETH_0x1964", "0x19647b0e6f6e3776378dac18047148d324472e02", SPARK_POOL],
  ]) {
    const item = status.targets?.[id];
    if (item?.liquidatableNow !== true || !item.readyExecuteMorphoCalldata) continue;
    requireThat(item.user?.toLowerCase() === borrower, "COLLECTOR_TARGET_MISMATCH");
    const data = item.readyExecuteMorphoCalldata, decoded = UNIFIED_IFACE.decodeFunctionData("executeMorpho", data), p = decoded[1];
    requireThat(UNIFIED_IFACE.encodeFunctionData("executeMorpho", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.isAaveV3 === true && p.target.toLowerCase() === pool && p.borrower.toLowerCase() === borrower, "EXECUTION_TARGET_MISMATCH");
    requireThat(p.debtToken.toLowerCase() === WETH && p.collateralToken.toLowerCase() === WSTETH && p.swapKind === 1n &&
      p.swapTarget.toLowerCase() === UNI_ROUTER && p.swapSpender.toLowerCase() === UNI_ROUTER && p.uniFee === 100n &&
      p.collateralReserveId === 0n && p.debtReserveId === 0n, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(decoded[0] > 0n && p.minCollateralSeized > 0n && p.minDebtTokenOut > 0n &&
      p.minProfitDebtToken >= (pool === SPARK_POOL ? 100000000000000000n : 10000000000000000n), "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    selected.push({ id, target: pool, borrower, data, params: p, flashAmount: decoded[0] });
  }
  const m1 = status.targets?.targetM1_Morpho_USDe_DAI;
  if (m1?.liquidatableNow === true && (m1.m1Nomination || m1.readyExecuteMorphoBlueCalldata)) {
    requireThat(m1.user?.toLowerCase() === M1_BORROWER, "COLLECTOR_TARGET_MISMATCH");
    const data = m1.m1Nomination?.calldataTemplate || m1.readyExecuteMorphoBlueCalldata, decoded = MORPHO_EXEC_IFACE.decodeFunctionData("execute", data), mp = decoded[0];
    if (m1.m1Nomination) m1Live.nominationBinding(m1.m1Nomination, status.pin, data);
    requireThat(MORPHO_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(mp.loanToken.toLowerCase() === DAI && mp.collateralToken.toLowerCase() === USDE && mp.oracle.toLowerCase() === M1_ORACLE &&
      mp.irm.toLowerCase() === M1_IRM && mp.lltv === M1_LLTV && decoded[1].toLowerCase() === M1_BORROWER, "EXECUTION_TARGET_MISMATCH");
    requireThat(decoded[2] > 0n && decoded[2] <= M1_SEIZE && decoded[3] === 0n && decoded[6].toLowerCase() === UNI_ROUTER && decoded[7].toLowerCase() === M1_PATH, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(decoded[4] >= 25000000000000000000n && (m1.m1Nomination ? decoded[5] === 0n &&
      decoded[2] === uint(m1.m1Nomination.ceilingRaw) : decoded[5] > 0n), "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    selected.push({ id: "targetM1_Morpho_USDe_DAI", kind: "MORPHO_BLUE_M1", executor: MORPHO_EXECUTOR, profitToken: DAI,
      target: MORPHO_BLUE, borrower: M1_BORROWER, data, seizedAssets: decoded[2], minProfitDai: decoded[4], minOutDai: decoded[5],
      ...(m1.m1Nomination ? { m1Nomination: m1.m1Nomination, observationPin: status.pin } : {}),
      // Fixed 2400 DAI/WETH sizing heuristic only; not a live price or net-profit estimate.
      flashAmount: 43309583333333333333n * decoded[2] / M1_SEIZE, params: { minDebtTokenOut: decoded[5] / 2400n, minProfitDebtToken: decoded[4] } });
  }
  for (const w of status.targets?.morpho_wstETH_WETH_Whales || []) {
    if (w?.liquidatableNow !== true || !w.readyExecuteMorphoBlueCalldata) continue;
    const borrower = w.user?.toLowerCase();
    requireThat(MORPHO_WST_BORROWERS.has(borrower), "COLLECTOR_TARGET_MISMATCH");
    const data = w.readyExecuteMorphoBlueCalldata, decoded = MORPHO_EXEC_IFACE.decodeFunctionData("execute", data), mp = decoded[0];
    requireThat(MORPHO_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(mp.loanToken.toLowerCase() === WETH && mp.collateralToken.toLowerCase() === WSTETH && mp.oracle.toLowerCase() === WSTETH_MORPHO_ORACLE &&
      mp.irm.toLowerCase() === M1_IRM && (mp.lltv === 965000000000000000n || mp.lltv === 945000000000000000n) && decoded[1].toLowerCase() === borrower, "EXECUTION_TARGET_MISMATCH");
    requireThat(decoded[2] > 0n && decoded[2] <= WST_SEIZE && decoded[3] === 0n && decoded[6].toLowerCase() === UNI_ROUTER && decoded[7].toLowerCase() === WST_PATH, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(decoded[4] >= 50000000000000000n && decoded[5] > 0n, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    const repayEstWeth = (mp.lltv === 965000000000000000n ? 616800000000000000000n : 613060000000000000000n) * decoded[2] / WST_SEIZE;
    selected.push({ id: `target_${w.rank || "M_WST"}_${borrower.slice(0, 6)}`, kind: "MORPHO_BLUE_WSTETH", executor: MORPHO_EXECUTOR, profitToken: WETH,
      target: MORPHO_BLUE, borrower, data, seizedAssets: decoded[2], minProfitWeth: decoded[4], minOutWeth: decoded[5],
      flashAmount: repayEstWeth, params: { minDebtTokenOut: decoded[5], minProfitDebtToken: decoded[4] } });
  }
  for (const [m2, expectedBorrower, targetId] of [
    [status.targets?.targetM2_Morpho_reUSD_USDC, M2_BORROWER, "targetM2_Morpho_reUSD_USDC"],
    [status.targets?.targetM2B_Morpho_reUSD_USDC, M2B_BORROWER, "targetM2B_Morpho_reUSD_USDC"],
    [status.targets?.targetM2C_Morpho_reUSD_USDC, M2C_BORROWER, "targetM2C_Morpho_reUSD_USDC"],
    [status.targets?.targetM2D_Morpho_reUSD_USDC, M2D_BORROWER, "targetM2D_Morpho_reUSD_USDC"],
    [status.targets?.targetM39_Morpho_reUSD_USDC, M39_BORROWER, "targetM39_Morpho_reUSD_USDC"],
  ]) {
    if (m2?.liquidatableNow !== true || !m2.readyExecuteCurveUnwindCalldata) continue;
    requireThat(m2.user?.toLowerCase() === expectedBorrower, "COLLECTOR_TARGET_MISMATCH");
    const data = m2.readyExecuteCurveUnwindCalldata, decoded = M2_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0], swapData = decoded[1];
    requireThat(M2_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    const ex = CURVE_EXCHANGE_IFACE.decodeFunctionData("exchange", swapData);
    requireThat(CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", ex).toLowerCase() === swapData.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(ex[0] === 0n && ex[1] === 1n && ex[2] === p.seizedAssets && ex[3] > 0n, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.loanToken.toLowerCase() === USDC && p.collateralToken.toLowerCase() === REUSD && p.oracle.toLowerCase() === M2_ORACLE &&
      p.irm.toLowerCase() === M1_IRM && p.lltv === M2_LLTV && p.borrower.toLowerCase() === expectedBorrower, "EXECUTION_TARGET_MISMATCH");
    requireThat(p.swapTarget.toLowerCase() === CURVE_REUSD_USDC && p.seizedAssets > 0n && p.seizedAssets <= M2_SEIZE, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.minLoanOut > 25000000n, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    selected.push({ id: targetId, kind: "MORPHO_BLUE_M2", executor: M2_EXECUTOR, profitToken: USDC,
      target: MORPHO_BLUE, borrower: expectedBorrower, data, seizedAssets: p.seizedAssets, minLoanOut: p.minLoanOut, minOutUsdc: ex[3], minProfitUsdc: 25000000n,
      flashAmount: 43309583333333333333n * p.seizedAssets / M2_SEIZE,
      params: { minDebtTokenOut: ex[3] * 10n ** 12n / 2400n, minProfitDebtToken: 25000000n * 10n ** 12n } });
  }
  for (const [mPt, expectedBorrower, targetId, maxSeizePt, minProfitUsdc] of [
    [status.targets?.targetM12_Morpho_PT_USD3_USDC, M12_BORROWER, "targetM12_Morpho_PT_USD3_USDC", 500000000000n, 10000000000n],
    [status.targets?.targetM13_Morpho_PT_USD3_USDC, M13_BORROWER, "targetM13_Morpho_PT_USD3_USDC", 105000000000n, 2000000000n],
    [status.targets?.targetM35_Morpho_PT_USD3_USDC, M35_BORROWER, "targetM35_Morpho_PT_USD3_USDC", 105000000000n, 2000000000n],
  ]) {
    if (mPt?.liquidatableNow !== true || !mPt.readyExecuteCurveUnwindCalldata) continue;
    requireThat(mPt.user?.toLowerCase() === expectedBorrower, "COLLECTOR_TARGET_MISMATCH");
    const data = mPt.readyExecuteCurveUnwindCalldata, decoded = M2_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0], swapData = decoded[1];
    requireThat(M2_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    const ptDecoded = PENDLE_ROUTER_V4_IFACE.decodeFunctionData("swapExactPtForToken", swapData);
    requireThat(PENDLE_ROUTER_V4_IFACE.encodeFunctionData("swapExactPtForToken", ptDecoded).toLowerCase() === swapData.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(ptDecoded[0].toLowerCase() === M2_EXECUTOR && ptDecoded[1].toLowerCase() === PENDLE_USD3_MARKET && ptDecoded[2] === p.seizedAssets &&
      ptDecoded[3].tokenOut.toLowerCase() === USDC && ptDecoded[3].tokenRedeemSy.toLowerCase() === USDC && ptDecoded[3].minTokenOut >= minProfitUsdc, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.loanToken.toLowerCase() === USDC && p.collateralToken.toLowerCase() === PT_USD3 &&
      (p.oracle.toLowerCase() === PT_USD3_ORACLE || p.oracle.toLowerCase() === PT_USD3_NEW_ORACLE) &&
      p.irm.toLowerCase() === M1_IRM && p.lltv === M1_LLTV && p.borrower.toLowerCase() === expectedBorrower, "EXECUTION_TARGET_MISMATCH");
    requireThat(p.swapTarget.toLowerCase() === PENDLE_ROUTER_V4 && p.seizedAssets > 0n && p.seizedAssets <= maxSeizePt, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.minLoanOut > minProfitUsdc, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    selected.push({ id: targetId, kind: "MORPHO_BLUE_M2", executor: M2_EXECUTOR, profitToken: USDC,
      target: MORPHO_BLUE, borrower: expectedBorrower, data, seizedAssets: p.seizedAssets, minLoanOut: p.minLoanOut,
      minOutUsdc: ptDecoded[3].minTokenOut, minProfitUsdc, skipCurveQuote: true,
      flashAmount: p.seizedAssets * 10n ** 12n / 2400n,
      params: { minDebtTokenOut: ptDecoded[3].minTokenOut * 10n ** 12n / 2400n, minProfitDebtToken: minProfitUsdc * 10n ** 12n } });
  }
  const m15 = status.targets?.targetM15_Morpho_yoUSD_Edge_USDC;
  if (m15?.liquidatableNow === true && m15.readyExecuteCurveUnwindCalldata) {
    requireThat(m15.user?.toLowerCase() === M15_BORROWER, "COLLECTOR_TARGET_MISMATCH");
    const data = m15.readyExecuteCurveUnwindCalldata, decoded = M2_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0], swapData = decoded[1];
    requireThat(M2_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    const rDecoded = ERC4626_REDEEM_IFACE.decodeFunctionData("redeem", swapData);
    requireThat(ERC4626_REDEEM_IFACE.encodeFunctionData("redeem", rDecoded).toLowerCase() === swapData.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(rDecoded[0] === p.seizedAssets && rDecoded[1].toLowerCase() === M2_EXECUTOR && rDecoded[2].toLowerCase() === M2_EXECUTOR, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.loanToken.toLowerCase() === USDC && p.collateralToken.toLowerCase() === M15_YOUSD_EDGE && p.oracle.toLowerCase() === M15_ORACLE &&
      p.irm.toLowerCase() === M1_IRM && p.lltv === 770000000000000000n && p.borrower.toLowerCase() === M15_BORROWER &&
      p.swapTarget.toLowerCase() === M15_YOUSD_EDGE && p.seizedAssets > 0n && p.seizedAssets <= 6800000000n && p.minLoanOut > 400000000n, "EXECUTION_TARGET_MISMATCH");
    selected.push({ id: "targetM15_Morpho_yoUSD_Edge_USDC", kind: "MORPHO_BLUE_M2", executor: M2_EXECUTOR, profitToken: USDC,
      target: MORPHO_BLUE, borrower: M15_BORROWER, data, seizedAssets: p.seizedAssets, minLoanOut: p.minLoanOut,
      minOutUsdc: p.minLoanOut, minProfitUsdc: 400000000n, skipCurveQuote: true,
      flashAmount: p.seizedAssets * 10n ** 12n / 2400n,
      params: { minDebtTokenOut: p.minLoanOut * 10n ** 12n / 2400n, minProfitDebtToken: 400000000n * 10n ** 12n } });
  }
  for (const [m16, expectedBorrower, id, minProf] of [
    [status.targets?.targetM16_Morpho_apyUSD_apxUSD, M16_BORROWER, "targetM16_Morpho_apyUSD_apxUSD", 5000000000000000000000n],
    [status.targets?.targetM46_Morpho_apyUSD_apxUSD, M25_BORROWER, "targetM46_Morpho_apyUSD_apxUSD", 2500000000000000000000n],
  ]) {
    if (m16?.liquidatableNow !== true || !m16.readyExecuteCurveUnwindCalldata) continue;
    requireThat(m16.user?.toLowerCase() === expectedBorrower, "COLLECTOR_TARGET_MISMATCH");
    const data = m16.readyExecuteCurveUnwindCalldata, decoded = M2_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0], swapData = decoded[1];
    requireThat(M2_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    const ex = CURVE_EXCHANGE_IFACE.decodeFunctionData("exchange", swapData);
    requireThat(CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", ex).toLowerCase() === swapData.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(ex[0] === 0n && ex[1] === 1n && ex[2] === p.seizedAssets && ex[3] > 0n, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.loanToken.toLowerCase() === M16_APXUSD && p.collateralToken.toLowerCase() === M16_APYUSD && p.oracle.toLowerCase() === M16_ORACLE &&
      p.irm.toLowerCase() === M1_IRM && p.lltv === M1_LLTV && p.borrower.toLowerCase() === expectedBorrower &&
      p.swapTarget.toLowerCase() === CURVE_APY_APX && p.seizedAssets > 0n && p.seizedAssets <= 500000000000000000000000n && p.minLoanOut > minProf, "EXECUTION_TARGET_MISMATCH");
    selected.push({ id, kind: "MORPHO_BLUE_M2", executor: M2_EXECUTOR, profitToken: M16_APXUSD,
      target: MORPHO_BLUE, borrower: expectedBorrower, data, seizedAssets: p.seizedAssets, minLoanOut: p.minLoanOut,
      minOutUsdc: ex[3], minProfitUsdc: minProf, skipCurveQuote: true,
      flashAmount: p.seizedAssets / 2400n,
      params: { minDebtTokenOut: ex[3] / 2400n, minProfitDebtToken: minProf / 2400n } });
  }
  const m17 = status.targets?.targetM17_Morpho_eUSDe_USDe;
  const m17Calldata = m17?.readyExecuteCurveUnwindCalldata || m17?.readyExecuteReusdCalldata;
  if (m17?.liquidatableNow === true && m17Calldata) {
    requireThat(m17.user?.toLowerCase() === M17_BORROWER, "COLLECTOR_TARGET_MISMATCH");
    const data = m17Calldata, decoded = M2_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0], swapData = decoded[1];
    requireThat(M2_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    const rDecoded = ERC4626_REDEEM_IFACE.decodeFunctionData("redeem", swapData);
    requireThat(ERC4626_REDEEM_IFACE.encodeFunctionData("redeem", rDecoded).toLowerCase() === swapData.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(rDecoded[0] === p.seizedAssets && rDecoded[1].toLowerCase() === M2_EXECUTOR && rDecoded[2].toLowerCase() === M2_EXECUTOR, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.loanToken.toLowerCase() === USDE && p.collateralToken.toLowerCase() === M17_EUSDE && p.oracle.toLowerCase() === M17_ORACLE &&
      p.irm.toLowerCase() === M1_IRM && p.lltv === M2_LLTV && p.borrower.toLowerCase() === M17_BORROWER &&
      p.swapTarget.toLowerCase() === M17_EUSDE && p.seizedAssets > 0n && p.seizedAssets <= 30000000000000000000000n && p.minLoanOut > 20000000000000000000n, "EXECUTION_TARGET_MISMATCH");
    selected.push({ id: "targetM17_Morpho_eUSDe_USDe", kind: "MORPHO_BLUE_M2", executor: M2_EXECUTOR, profitToken: USDE,
      target: MORPHO_BLUE, borrower: M17_BORROWER, data, seizedAssets: p.seizedAssets, minLoanOut: p.minLoanOut,
      minOutUsdc: p.minLoanOut, minProfitUsdc: 20000000000000000000n, skipCurveQuote: true,
      flashAmount: p.seizedAssets / 2400n,
      params: { minDebtTokenOut: p.minLoanOut / 2400n, minProfitDebtToken: 20000000000000000000n / 2400n } });
  }
  for (const [mUsd3, expectedBorrower, targetId, maxSeizeUsd3, minProfitUsdc] of [
    [status.targets?.targetM18_Morpho_USD3_USDC, M18_BORROWER, "targetM18_Morpho_USD3_USDC", 130000000000n, 500000000n],
    [status.targets?.targetM19_Morpho_USD3_USDC, M19_BORROWER, "targetM19_Morpho_USD3_USDC", 500000000000n, 2500000000n],
    [status.targets?.targetM20_Morpho_USD3_USDC, M20_BORROWER, "targetM20_Morpho_USD3_USDC", 500000000000n, 2500000000n],
    [status.targets?.targetM25_Morpho_USD3_USDC, M25_BORROWER, "targetM25_Morpho_USD3_USDC", 150000000000n, 750000000n],
    [status.targets?.targetM26_Morpho_USD3_USDC, M26_BORROWER, "targetM26_Morpho_USD3_USDC", 500000000000n, 2500000000n],
  ]) {
    const m18Calldata = mUsd3?.readyExecuteCurveUnwindCalldata || mUsd3?.readyExecuteReusdCalldata;
    if (mUsd3?.liquidatableNow !== true || !m18Calldata) continue;
    requireThat(mUsd3.user?.toLowerCase() === expectedBorrower, "COLLECTOR_TARGET_MISMATCH");
    const data = m18Calldata, decoded = M2_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0], swapData = decoded[1];
    requireThat(M2_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    const rDecoded = ERC4626_REDEEM4_IFACE.decodeFunctionData("redeem", swapData);
    requireThat(ERC4626_REDEEM4_IFACE.encodeFunctionData("redeem", rDecoded).toLowerCase() === swapData.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(rDecoded[0] === p.seizedAssets && rDecoded[1].toLowerCase() === M2_EXECUTOR && rDecoded[2].toLowerCase() === M2_EXECUTOR && rDecoded[3] === 0n, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.loanToken.toLowerCase() === USDC && p.collateralToken.toLowerCase() === M18_USD3 && p.oracle.toLowerCase() === M18_ORACLE &&
      p.irm.toLowerCase() === M1_IRM && p.lltv === M2_LLTV && p.borrower.toLowerCase() === expectedBorrower &&
      p.swapTarget.toLowerCase() === M18_USD3 && p.seizedAssets > 0n && p.seizedAssets <= maxSeizeUsd3 && p.minLoanOut > minProfitUsdc, "EXECUTION_TARGET_MISMATCH");
    selected.push({ id: targetId, kind: "MORPHO_BLUE_M2", executor: M2_EXECUTOR, profitToken: USDC,
      target: MORPHO_BLUE, borrower: expectedBorrower, data, seizedAssets: p.seizedAssets, minLoanOut: p.minLoanOut,
      minOutUsdc: p.minLoanOut, minProfitUsdc, skipCurveQuote: true,
      flashAmount: p.seizedAssets * 10n ** 12n / 2400n,
      params: { minDebtTokenOut: p.minLoanOut * 10n ** 12n / 2400n, minProfitDebtToken: minProfitUsdc * 10n ** 12n } });
  }
  for (const [mPtApy, expectedBorrower, targetId, maxSeizePt, minProfitApx] of [
    [status.targets?.targetM21_Morpho_PT_apyUSD_apxUSD, M21_BORROWER, "targetM21_Morpho_PT_apyUSD_apxUSD", 100000000000000000000000n, 200000000000000000000n],
    [status.targets?.targetM22_Morpho_PT_apyUSD_apxUSD, M22_BORROWER, "targetM22_Morpho_PT_apyUSD_apxUSD", 250000000000000000000000n, 500000000000000000000n],
  ]) {
    const ptApyCalldata = mPtApy?.readyExecuteCurveUnwindCalldata || mPtApy?.readyExecuteReusdCalldata;
    if (mPtApy?.liquidatableNow !== true || !ptApyCalldata) continue;
    requireThat(mPtApy.user?.toLowerCase() === expectedBorrower, "COLLECTOR_TARGET_MISMATCH");
    const data = ptApyCalldata, decoded = M2_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0], swapData = decoded[1];
    requireThat(M2_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    const ptDecoded = PENDLE_ROUTER_V4_IFACE.decodeFunctionData("swapExactPtForToken", swapData);
    requireThat(PENDLE_ROUTER_V4_IFACE.encodeFunctionData("swapExactPtForToken", ptDecoded).toLowerCase() === swapData.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(ptDecoded[0].toLowerCase() === M2_EXECUTOR && ptDecoded[1].toLowerCase() === PENDLE_APY_MARKET && ptDecoded[2] === p.seizedAssets &&
      ptDecoded[3].tokenOut.toLowerCase() === M16_APXUSD && ptDecoded[3].tokenRedeemSy.toLowerCase() === M16_APYUSD &&
      ptDecoded[3].pendleSwap.toLowerCase() === PENDLE_SWAP && ptDecoded[3].swapData.extRouter.toLowerCase() === CURVE_APY_APX &&
      ptDecoded[3].minTokenOut >= minProfitApx, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.loanToken.toLowerCase() === M16_APXUSD && p.collateralToken.toLowerCase() === M21_PT_APY && p.oracle.toLowerCase() === M21_ORACLE &&
      p.irm.toLowerCase() === M1_IRM && p.lltv === M2_LLTV && p.borrower.toLowerCase() === expectedBorrower &&
      p.swapTarget.toLowerCase() === PENDLE_ROUTER_V4 && p.seizedAssets > 0n && p.seizedAssets <= maxSeizePt && p.minLoanOut > minProfitApx, "EXECUTION_TARGET_MISMATCH");
    selected.push({ id: targetId, kind: "MORPHO_BLUE_M2", executor: M2_EXECUTOR, profitToken: M16_APXUSD,
      target: MORPHO_BLUE, borrower: expectedBorrower, data, seizedAssets: p.seizedAssets, minLoanOut: p.minLoanOut,
      minOutUsdc: ptDecoded[3].minTokenOut, minProfitUsdc: minProfitApx, skipCurveQuote: true,
      flashAmount: p.seizedAssets / 2400n,
      params: { minDebtTokenOut: ptDecoded[3].minTokenOut / 2400n, minProfitDebtToken: minProfitApx / 2400n } });
  }
  for (const [mPtReusd, expectedBorrower, targetId, maxSeizePt, minProfitUsdc] of [
    [status.targets?.targetM23_Morpho_PT_reUSD_USDC, M23_BORROWER, "targetM23_Morpho_PT_reUSD_USDC", 8500000000n, 50000000n],
    [status.targets?.targetM24_Morpho_PT_reUSD_USDC, M24_BORROWER, "targetM24_Morpho_PT_reUSD_USDC", 40000000000n, 150000000n],
    [status.targets?.targetM27_Morpho_PT_reUSD_USDC, M27_BORROWER, "targetM27_Morpho_PT_reUSD_USDC", 40000000000n, 150000000n],
    [status.targets?.targetM28_Morpho_PT_reUSD_USDC, M28_BORROWER, "targetM28_Morpho_PT_reUSD_USDC", 40000000000n, 150000000n],
  ]) {
    const ptReusdCalldata = mPtReusd?.readyExecuteCurveUnwindCalldata || mPtReusd?.readyExecuteReusdCalldata;
    if (mPtReusd?.liquidatableNow !== true || !ptReusdCalldata) continue;
    requireThat(mPtReusd.user?.toLowerCase() === expectedBorrower, "COLLECTOR_TARGET_MISMATCH");
    const data = ptReusdCalldata, decoded = M2_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0], swapData = decoded[1];
    requireThat(M2_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    const ptDecoded = PENDLE_ROUTER_V4_IFACE.decodeFunctionData("swapExactPtForToken", swapData);
    requireThat(PENDLE_ROUTER_V4_IFACE.encodeFunctionData("swapExactPtForToken", ptDecoded).toLowerCase() === swapData.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(ptDecoded[0].toLowerCase() === M2_EXECUTOR && ptDecoded[1].toLowerCase() === PENDLE_REUSD_MARKET && ptDecoded[2] === p.seizedAssets &&
      ptDecoded[3].tokenOut.toLowerCase() === USDC && ptDecoded[3].tokenRedeemSy.toLowerCase() === REUSD &&
      ptDecoded[3].pendleSwap.toLowerCase() === PENDLE_SWAP && ptDecoded[3].swapData.extRouter.toLowerCase() === CURVE_REUSD_USDC &&
      ptDecoded[3].minTokenOut >= minProfitUsdc, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.loanToken.toLowerCase() === USDC && p.collateralToken.toLowerCase() === M23_PT_REUSD &&
      p.irm.toLowerCase() === M1_IRM && p.lltv === M2_LLTV && p.borrower.toLowerCase() === expectedBorrower &&
      p.swapTarget.toLowerCase() === PENDLE_ROUTER_V4 && p.seizedAssets > 0n && p.seizedAssets <= maxSeizePt && p.minLoanOut > minProfitUsdc, "EXECUTION_TARGET_MISMATCH");
    selected.push({ id: targetId, kind: "MORPHO_BLUE_M2", executor: M2_EXECUTOR, profitToken: USDC,
      target: MORPHO_BLUE, borrower: expectedBorrower, data, seizedAssets: p.seizedAssets, minLoanOut: p.minLoanOut,
      minOutUsdc: ptDecoded[3].minTokenOut, minProfitUsdc, skipCurveQuote: true,
      flashAmount: p.seizedAssets * 10n ** 12n / 2400n,
      params: { minDebtTokenOut: ptDecoded[3].minTokenOut * 10n ** 12n / 2400n, minProfitDebtToken: minProfitUsdc * 10n ** 12n } });
  }
  for (const [m10, expectedBorrower, id] of [
    [status.targets?.targetM10_Morpho_USDe_RLUSD, M10_BORROWER, "targetM10_Morpho_USDe_RLUSD"],
    [status.targets?.targetM47_Morpho_USDe_RLUSD, M47_BORROWER, "targetM47_Morpho_USDe_RLUSD"],
  ]) {
    if (m10?.liquidatableNow !== true || !m10.readyExecuteCurveUnwindCalldata) continue;
    requireThat(m10.user?.toLowerCase() === expectedBorrower, "COLLECTOR_TARGET_MISMATCH");
    const data = m10.readyExecuteCurveUnwindCalldata, decoded = M2_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0], swapData = decoded[1];
    requireThat(M2_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    const exDecoded = UNIV3_EXACT_INPUT_IFACE.decodeFunctionData("exactInput", swapData), ex = exDecoded[0];
    requireThat(UNIV3_EXACT_INPUT_IFACE.encodeFunctionData("exactInput", exDecoded).toLowerCase() === swapData.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(ex.path.toLowerCase() === M10_PATH && ex.recipient.toLowerCase() === M2_EXECUTOR && ex.amountIn === p.seizedAssets && ex.amountOutMinimum >= (p.seizedAssets * 34800n) / 35000n, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.loanToken.toLowerCase() === RLUSD && p.collateralToken.toLowerCase() === USDE && p.oracle.toLowerCase() === M10_ORACLE &&
      p.irm.toLowerCase() === M1_IRM && p.lltv === M2_LLTV && p.borrower.toLowerCase() === expectedBorrower, "EXECUTION_TARGET_MISMATCH");
    requireThat(p.swapTarget.toLowerCase() === UNI_ROUTER && p.seizedAssets > 0n && p.seizedAssets <= M10_SEIZE, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.minLoanOut >= (p.seizedAssets * 9000n) / 10000n + 100000000000000000000n, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    selected.push({ id, kind: "MORPHO_BLUE_M2", executor: M2_EXECUTOR, profitToken: RLUSD,
      target: MORPHO_BLUE, borrower: expectedBorrower, data, seizedAssets: p.seizedAssets, minLoanOut: p.minLoanOut,
      minOutUsdc: ex.amountOutMinimum, minProfitUsdc: 100000000000000000000n, swapPath: M10_PATH,
      flashAmount: p.seizedAssets / 2400n,
      params: { minDebtTokenOut: ex.amountOutMinimum / 2400n, minProfitDebtToken: 100000000000000000000n / 2400n } });
  }
  for (const [mWe, expectedBorrower, id] of [
    [status.targets?.targetM11_Morpho_weETH_WETH, M11_BORROWER, "targetM11_Morpho_weETH_WETH"],
    [status.targets?.targetM40_Morpho_weETH_WETH, M40_BORROWER, "targetM40_Morpho_weETH_WETH"],
  ]) {
    if (mWe?.liquidatableNow !== true || !mWe.readyExecuteMorphoBlueCalldata) continue;
    requireThat(mWe.user?.toLowerCase() === expectedBorrower, "COLLECTOR_TARGET_MISMATCH");
    const data = mWe.readyExecuteMorphoBlueCalldata, decoded = MORPHO_EXEC_IFACE.decodeFunctionData("execute", data), mp = decoded[0];
    requireThat(MORPHO_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(mp.loanToken.toLowerCase() === WETH && mp.collateralToken.toLowerCase() === WEETH && mp.oracle.toLowerCase() === M11_ORACLE &&
      mp.irm.toLowerCase() === M1_IRM && mp.lltv === 945000000000000000n && decoded[1].toLowerCase() === expectedBorrower, "EXECUTION_TARGET_MISMATCH");
    requireThat(decoded[2] > 0n && decoded[2] <= M11_SEIZE && decoded[3] === 0n && decoded[6].toLowerCase() === UNI_ROUTER && decoded[7].toLowerCase() === WEETH_PATH, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(decoded[4] >= 50000000000000000n && decoded[5] > 0n, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    const repayEstWeth = 468200000000000000000n * decoded[2] / M11_SEIZE;
    selected.push({ id, kind: "MORPHO_BLUE_WSTETH", executor: MORPHO_EXECUTOR, profitToken: WETH,
      target: MORPHO_BLUE, borrower: expectedBorrower, data, seizedAssets: decoded[2], minProfitWeth: decoded[4], minOutWeth: decoded[5], swapPath: WEETH_PATH,
      flashAmount: repayEstWeth, params: { minDebtTokenOut: decoded[5], minProfitDebtToken: decoded[4] } });
  }
  for (const [m30, expectedBorrower, id] of [
    [status.targets?.targetM30_Morpho_wstETH_WETH, M30_BORROWER, "targetM30_Morpho_wstETH_WETH"],
    [status.targets?.targetM41_Morpho_wstETH_WETH, M41_BORROWER, "targetM41_Morpho_wstETH_WETH"],
  ]) {
    if (m30?.liquidatableNow !== true || !m30.readyExecuteMorphoBlueCalldata) continue;
    requireThat(m30.user?.toLowerCase() === expectedBorrower, "COLLECTOR_TARGET_MISMATCH");
    const data = m30.readyExecuteMorphoBlueCalldata, decoded = MORPHO_EXEC_IFACE.decodeFunctionData("execute", data), mp = decoded[0];
    requireThat(MORPHO_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(mp.loanToken.toLowerCase() === WETH && mp.collateralToken.toLowerCase() === WSTETH && mp.oracle.toLowerCase() === WSTETH_MORPHO_ORACLE &&
      mp.irm.toLowerCase() === M1_IRM && mp.lltv === 965000000000000000n && decoded[1].toLowerCase() === expectedBorrower, "EXECUTION_TARGET_MISMATCH");
    requireThat(decoded[2] > 0n && decoded[2] <= M30_SEIZE && decoded[3] === 0n && decoded[6].toLowerCase() === UNI_ROUTER && decoded[7].toLowerCase() === WST_PATH, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(decoded[4] >= 1000000000000000n && decoded[5] > 0n, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    const repayEstWeth = 242000000000000000n * decoded[2] / M30_SEIZE;
    selected.push({ id, kind: "MORPHO_BLUE_WSTETH", executor: MORPHO_EXECUTOR, profitToken: WETH,
      target: MORPHO_BLUE, borrower: expectedBorrower, data, seizedAssets: decoded[2], minProfitWeth: decoded[4], minOutWeth: decoded[5],
      usePlanMinProfit: true, flashAmount: repayEstWeth, params: { minDebtTokenOut: decoded[5], minProfitDebtToken: decoded[4] } });
  }
  const m31 = status.targets?.targetM31_Morpho_syrupUSDC_USDC;
  const m31Calldata = m31?.readyExecuteCurveUnwindCalldata || m31?.readyExecuteReusdCalldata;
  if (m31?.liquidatableNow === true && m31Calldata) {
    requireThat(m31.user?.toLowerCase() === M31_BORROWER, "COLLECTOR_TARGET_MISMATCH");
    const data = m31Calldata, decoded = M2_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0], swapData = decoded[1];
    requireThat(M2_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    // A fresh injected collector has only the selector until its Kyber route is hydrated.
    const unhydratedSwap = typeof swapData === "string" && swapData.toLowerCase() === "0xe21fd0e9";
    requireThat(unhydratedSwap || typeof swapData === "string" && swapData.toLowerCase().startsWith("0xe21fd0e9") && swapData.length > 100, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.loanToken.toLowerCase() === USDC && p.collateralToken.toLowerCase() === SYRUP_USDC && p.oracle.toLowerCase() === M31_ORACLE &&
      p.irm.toLowerCase() === M1_IRM && p.lltv === M2_LLTV && p.borrower.toLowerCase() === M31_BORROWER &&
      p.swapTarget.toLowerCase() === KYBER_ROUTER && p.seizedAssets > 0n && p.seizedAssets <= 800000000n && p.minLoanOut > 5000000n, "EXECUTION_TARGET_MISMATCH");
    if (!unhydratedSwap) selected.push({ id: "targetM31_Morpho_syrupUSDC_USDC", kind: "MORPHO_BLUE_M2", executor: M2_EXECUTOR, profitToken: USDC,
      target: MORPHO_BLUE, borrower: M31_BORROWER, data, seizedAssets: p.seizedAssets, minLoanOut: p.minLoanOut,
      minOutUsdc: p.minLoanOut, minProfitUsdc: 5000000n, skipCurveQuote: true,
      flashAmount: p.seizedAssets * 10n ** 12n / 2400n,
      params: { minDebtTokenOut: p.minLoanOut * 10n ** 12n / 2400n, minProfitDebtToken: 5000000n * 10n ** 12n } });
  }
  // M32 is not an M2 calldata route. Its separate health nomination is prepared
  // only by the fixed attended CALL entrypoint with fresh authenticated evidence.
  const m33 = status.targets?.targetM33_Morpho_PT_reUSD_USDT;
  const m33Calldata = m33?.readyExecuteUniversalCalldata || m33?.readyExecuteCurveUnwindCalldata;
  if (m33?.liquidatableNow === true && m33Calldata) {
    requireThat(m33.user?.toLowerCase() === M24_BORROWER, "COLLECTOR_TARGET_MISMATCH");
    const data = m33Calldata, decoded = UNIVERSAL_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0];
    requireThat(UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.mode === 0n && p.loanToken.toLowerCase() === USDT && p.collateralToken.toLowerCase() === M23_PT_REUSD &&
      p.oracle.toLowerCase() === M23_ORACLE && p.irm.toLowerCase() === M1_IRM && p.lltv === M2_LLTV &&
      p.borrower.toLowerCase() === M24_BORROWER && p.seizedAssets > 0n && p.seizedAssets <= 40000000000n &&
      p.target1.toLowerCase() === PENDLE_ROUTER_V4 && p.target2.toLowerCase() === CURVE_USDC_USDT && p.minProfit >= 100000000n, "EXECUTION_TARGET_MISMATCH");
    const priorityAmount = amount => amount * 10n ** 12n / 2400n;
    selected.push({ id: "targetM33_Morpho_PT_reUSD_USDT", kind: "UNIVERSAL_FLUID_MORPHO_LIQUIDATION", executor: UNIVERSAL_EXECUTOR, profitToken: USDT,
      target: MORPHO_BLUE, borrower: M24_BORROWER, data, minProfitRaw: p.minProfit,
      flashAmount: priorityAmount(p.flashAmount),
      params: { minDebtTokenOut: priorityAmount(p.flashAmount + p.minProfit), minProfitDebtToken: priorityAmount(p.minProfit) } });
  }
  const f1 = status.targets?.targetF1_Fluid_USDe_USDT_Vault93;
  const f1Calldata = f1?.readyExecuteUniversalCalldata || f1?.readyExecuteCurveUnwindCalldata;
  if (f1?.liquidatableNow === true && f1Calldata) {
    requireThat(f1.user?.toLowerCase() === F1_BORROWER, "COLLECTOR_TARGET_MISMATCH");
    const data = f1Calldata, decoded = UNIVERSAL_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0];
    requireThat(UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.mode === 1n && p.loanToken.toLowerCase() === USDT && p.fluidVault.toLowerCase() === F1_VAULT_93 &&
      p.flashAmount > 0n && p.minProfit >= 5000000n, "EXECUTION_TARGET_MISMATCH");
    const priorityAmount = amount => amount * 10n ** 12n / 2400n;
    selected.push({ id: "targetF1_Fluid_USDe_USDT_Vault93", kind: "UNIVERSAL_FLUID_MORPHO_LIQUIDATION", executor: UNIVERSAL_EXECUTOR, profitToken: USDT,
      target: F1_VAULT_93, borrower: F1_BORROWER, data, minProfitRaw: p.minProfit,
      flashAmount: priorityAmount(p.flashAmount),
      params: { minDebtTokenOut: priorityAmount(p.flashAmount + p.minProfit), minProfitDebtToken: priorityAmount(p.minProfit) } });
  }
  const f2 = status.targets?.targetF2_Fluid_eBTC_cbBTC_Vault96;
  const f2Calldata = f2?.readyExecuteUniversalCalldata || f2?.readyExecuteCurveUnwindCalldata;
  if (f2?.liquidatableNow === true && f2Calldata) {
    requireThat(f2.user?.toLowerCase() === F2_BORROWER, "COLLECTOR_TARGET_MISMATCH");
    const data = f2Calldata, decoded = UNIVERSAL_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0];
    requireThat(UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.mode === 1n && p.loanToken.toLowerCase() === WBTC && p.fluidVault.toLowerCase() === F2_VAULT_96 &&
      p.flashAmount > 0n && p.minProfit >= 100000n, "EXECUTION_TARGET_MISMATCH");
    const priorityAmount = amount => amount * 10n ** 10n * 34n;
    selected.push({ id: "targetF2_Fluid_eBTC_cbBTC_Vault96", kind: "UNIVERSAL_FLUID_MORPHO_LIQUIDATION", executor: UNIVERSAL_EXECUTOR, profitToken: WBTC,
      target: F2_VAULT_96, borrower: F2_BORROWER, data, minProfitRaw: p.minProfit,
      flashAmount: priorityAmount(p.flashAmount),
      params: { minDebtTokenOut: priorityAmount(p.flashAmount + p.minProfit), minProfitDebtToken: priorityAmount(p.minProfit) } });
  }
  const f3 = status.targets?.targetF3_Fluid_ETH_osETH_Vault159;
  const f3Calldata = f3?.readyExecuteUniversalCalldata || f3?.readyExecuteCurveUnwindCalldata;
  if (f3?.liquidatableNow === true && f3Calldata) {
    requireThat(f3.user?.toLowerCase() === F3_BORROWER, "COLLECTOR_TARGET_MISMATCH");
    const data = f3Calldata, decoded = UNIVERSAL_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0];
    requireThat(UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.mode === 1n && p.loanToken.toLowerCase() === WSTETH && p.fluidVault.toLowerCase() === F3_VAULT_159 &&
      p.flashAmount > 0n && p.minProfit >= 1000000000000000000n, "EXECUTION_TARGET_MISMATCH");
    selected.push({ id: "targetF3_Fluid_ETH_osETH_Vault159", kind: "UNIVERSAL_FLUID_MORPHO_LIQUIDATION", executor: UNIVERSAL_EXECUTOR, profitToken: WSTETH,
      target: F3_VAULT_159, borrower: F3_BORROWER, data, minProfitRaw: p.minProfit,
      flashAmount: p.flashAmount,
      params: { minDebtTokenOut: p.flashAmount + p.minProfit, minProfitDebtToken: p.minProfit } });
  }
  const e7 = status.targets?.targetE7_EulerV2_RLUSD_USDe_0x1066;
  const e7Calldata = e7?.readyExecuteUniversalCalldata || e7?.readyExecuteCurveUnwindCalldata;
  if (e7?.liquidatableNow === true && e7Calldata) {
    requireThat(e7.user?.toLowerCase() === E7_BORROWER, "COLLECTOR_TARGET_MISMATCH");
    const data = e7Calldata, decoded = UNIVERSAL_EULER_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0];
    requireThat(UNIVERSAL_EULER_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.loanToken.toLowerCase() === RLUSD && p.liabilityVault.toLowerCase() === E1_LIABILITY_VAULT &&
      p.collateralVault.toLowerCase() === E7_COL_VAULT && p.underlyingCollateral.toLowerCase() === USDE &&
      p.violator.toLowerCase() === E7_BORROWER && p.unwindKind === 2n && p.minLoanOut > p.repayAssets, "EXECUTION_TARGET_MISMATCH");
    const minProfitRaw = p.minLoanOut - p.repayAssets;
    selected.push({ id: "targetE7_EulerV2_RLUSD_USDe_0x1066", kind: "UNIVERSAL_EULER_EVK_LIQUIDATION", executor: ETH_UNIVERSAL_EULER_EXECUTOR, profitToken: RLUSD,
      target: E1_LIABILITY_VAULT, borrower: E7_BORROWER, data, minProfitRaw,
      flashAmount: p.repayAssets / 2400n,
      params: { minDebtTokenOut: p.minLoanOut / 2400n, minProfitDebtToken: minProfitRaw / 2400n } });
  }
  const e8 = status.targets?.targetE8_Euler_eUSDC2_eXAUt1;
  const e8Calldata = e8?.readyExecuteUniversalCalldata || e8?.readyExecuteCurveUnwindCalldata;
  if (e8?.liquidatableNow === true && e8Calldata) {
    requireThat(e8.user?.toLowerCase() === E8_BORROWER, "COLLECTOR_TARGET_MISMATCH");
    const data = e8Calldata, decoded = UNIVERSAL_EULER_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0];
    requireThat(UNIVERSAL_EULER_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.loanToken.toLowerCase() === USDC && p.liabilityVault.toLowerCase() === E8_LIAB_VAULT &&
      p.collateralVault.toLowerCase() === E8_COL_VAULT && p.underlyingCollateral.toLowerCase() === E8_XAUT &&
      p.violator.toLowerCase() === E8_BORROWER && p.unwindKind === 2n && p.minLoanOut > p.repayAssets, "EXECUTION_TARGET_MISMATCH");
    const minProfitRaw = p.minLoanOut - p.repayAssets;
    selected.push({ id: "targetE8_Euler_eUSDC2_eXAUt1", kind: "UNIVERSAL_EULER_EVK_LIQUIDATION", executor: ETH_UNIVERSAL_EULER_EXECUTOR, profitToken: USDC,
      target: E8_LIAB_VAULT, borrower: E8_BORROWER, data, minProfitRaw,
      flashAmount: p.repayAssets * 10n ** 12n / 2400n,
      params: { minDebtTokenOut: p.minLoanOut * 10n ** 12n / 2400n, minProfitDebtToken: minProfitRaw * 10n ** 12n / 2400n } });
  }
  const e9 = status.targets?.targetE9_Euler_eUSDT9_eUSDC22;
  const e9Calldata = e9?.readyExecuteUniversalCalldata || e9?.readyExecuteCurveUnwindCalldata;
  if (e9?.liquidatableNow === true && e9Calldata) {
    requireThat(e9.user?.toLowerCase() === E9_BORROWER, "COLLECTOR_TARGET_MISMATCH");
    const data = e9Calldata, decoded = UNIVERSAL_EULER_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0];
    requireThat(UNIVERSAL_EULER_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.loanToken.toLowerCase() === USDT && p.liabilityVault.toLowerCase() === E9_LIAB_VAULT &&
      p.collateralVault.toLowerCase() === E9_COL_VAULT && p.underlyingCollateral.toLowerCase() === USDC &&
      p.violator.toLowerCase() === E9_BORROWER && p.unwindKind === 2n && p.minLoanOut > p.repayAssets, "EXECUTION_TARGET_MISMATCH");
    const minProfitRaw = p.minLoanOut - p.repayAssets;
    selected.push({ id: "targetE9_Euler_eUSDT9_eUSDC22", kind: "UNIVERSAL_EULER_EVK_LIQUIDATION", executor: ETH_UNIVERSAL_EULER_EXECUTOR, profitToken: USDT,
      target: E9_LIAB_VAULT, borrower: E9_BORROWER, data, minProfitRaw,
      flashAmount: p.repayAssets * 10n ** 12n / 2400n,
      params: { minDebtTokenOut: p.minLoanOut * 10n ** 12n / 2400n, minProfitDebtToken: minProfitRaw * 10n ** 12n / 2400n } });
  }
  const e10 = status.targets?.targetE10_Euler_eRLUSD7_eUSDC70;
  const e10Calldata = e10?.readyExecuteUniversalCalldata || e10?.readyExecuteCurveUnwindCalldata;
  if (e10?.liquidatableNow === true && e10Calldata) {
    requireThat(e10.user?.toLowerCase() === E10_BORROWER, "COLLECTOR_TARGET_MISMATCH");
    const data = e10Calldata, decoded = UNIVERSAL_EULER_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0];
    requireThat(UNIVERSAL_EULER_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.loanToken.toLowerCase() === RLUSD && p.liabilityVault.toLowerCase() === E10_LIAB_VAULT &&
      p.collateralVault.toLowerCase() === E10_COL_VAULT && p.underlyingCollateral.toLowerCase() === USDC &&
      p.violator.toLowerCase() === E10_BORROWER && p.unwindKind === 2n && p.minLoanOut > p.repayAssets, "EXECUTION_TARGET_MISMATCH");
    const minProfitRaw = p.minLoanOut - p.repayAssets;
    selected.push({ id: "targetE10_Euler_eRLUSD7_eUSDC70", kind: "UNIVERSAL_EULER_EVK_LIQUIDATION", executor: ETH_UNIVERSAL_EULER_EXECUTOR, profitToken: RLUSD,
      target: E10_LIAB_VAULT, borrower: E10_BORROWER, data, minProfitRaw,
      flashAmount: p.repayAssets / 2400n,
      params: { minDebtTokenOut: p.minLoanOut / 2400n, minProfitDebtToken: minProfitRaw / 2400n } });
  }
  const m34 = status.targets?.targetM34_Morpho_beraSTONE_WETH;
  const m34Calldata = m34?.readyExecuteUniversalCalldata || m34?.readyExecuteCurveUnwindCalldata;
  if (m34?.liquidatableNow === true && m34Calldata) {
    requireThat(m34.user?.toLowerCase() === M34_BORROWER, "COLLECTOR_TARGET_MISMATCH");
    const data = m34Calldata, decoded = UNIVERSAL_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0];
    requireThat(UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.mode === 0n && p.loanToken.toLowerCase() === WETH && p.collateralToken.toLowerCase() === M34_BERASTONE &&
      p.oracle.toLowerCase() === M34_ORACLE && p.irm.toLowerCase() === M1_IRM && p.lltv === M2_LLTV &&
      p.borrower.toLowerCase() === M34_BORROWER && p.seizedAssets > 0n && p.seizedAssets <= 210000000000000000n &&
      p.target1.toLowerCase() === UNI_ROUTER && p.minProfit >= 1000000000000000n, "EXECUTION_TARGET_MISMATCH");
    selected.push({ id: "targetM34_Morpho_beraSTONE_WETH", kind: "UNIVERSAL_FLUID_MORPHO_LIQUIDATION", executor: UNIVERSAL_EXECUTOR, profitToken: WETH,
      target: MORPHO_BLUE, borrower: M34_BORROWER, data, minProfitRaw: p.minProfit,
      flashAmount: p.flashAmount,
      params: { minDebtTokenOut: p.flashAmount + p.minProfit, minProfitDebtToken: p.minProfit } });
  }
  for (const [mSusds, expectedBorrower, id] of [
    [status.targets?.targetM36_Morpho_sUSDS_USDT, M36_BORROWER, "targetM36_Morpho_sUSDS_USDT"],
    [status.targets?.targetM38_Morpho_sUSDS_USDT, M10_BORROWER, "targetM38_Morpho_sUSDS_USDT"],
  ]) {
    const m36Calldata = mSusds?.readyExecuteUniversalCalldata || mSusds?.readyExecuteCurveUnwindCalldata;
    if (mSusds?.liquidatableNow === true && m36Calldata) {
      requireThat(mSusds.user?.toLowerCase() === expectedBorrower, "COLLECTOR_TARGET_MISMATCH");
      const data = m36Calldata, decoded = UNIVERSAL_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0];
      requireThat(UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
      requireThat(p.mode === 0n && p.loanToken.toLowerCase() === USDT && p.collateralToken.toLowerCase() === M36_SUSDS &&
        p.oracle.toLowerCase() === M36_ORACLE && p.irm.toLowerCase() === M1_IRM && p.lltv === 965000000000000000n &&
        p.borrower.toLowerCase() === expectedBorrower && p.seizedAssets > 0n && [CURVE_ROUTER_NG, KYBER_ROUTER].includes(p.target1.toLowerCase()) && p.minProfit >= 50000000n, "EXECUTION_TARGET_MISMATCH");
      const priorityAmount = amount => amount * 10n ** 12n / 2400n;
      selected.push({ id, kind: "UNIVERSAL_FLUID_MORPHO_LIQUIDATION", executor: UNIVERSAL_EXECUTOR, profitToken: USDT,
        target: MORPHO_BLUE, borrower: expectedBorrower, data, minProfitRaw: p.minProfit,
        flashAmount: priorityAmount(p.flashAmount),
        params: { minDebtTokenOut: priorityAmount(p.flashAmount + p.minProfit), minProfitDebtToken: priorityAmount(p.minProfit) } });
    }
  }
  for (const [mUniv, id, borrowerAddr, loanTok, colTok, orcAddr, lltvVal, t1Addr, t2Addr, minProf] of [
    [status.targets?.targetM42_Morpho_strUSD_USDC, "targetM42_Morpho_strUSD_USDC", M25_BORROWER, USDC, M42_STRUSD, M42_ORACLE, M1_LLTV, M42_CURVE, M42_FLUID, 100000000n],
    [status.targets?.targetM43_Morpho_PRIME_PYUSD, "targetM43_Morpho_PRIME_PYUSD", M10_BORROWER, M43_PYUSD, M43_PRIME, M43_ORACLE, M1_LLTV, UNI_ROUTER, M43_PAYPOOL, 50000000n],
    [status.targets?.targetM44_Morpho_srUSD_USDC, "targetM44_Morpho_srUSD_USDC", M44_BORROWER, USDC, M44_SRUSD, M44_ORACLE, M2_LLTV, M44_SAVING, M44_PSM, 50000000n],
    [status.targets?.targetM45_Morpho_reUSDe_USDC, "targetM45_Morpho_reUSDe_USDC", M25_BORROWER, USDC, M45_REUSDE, M45_ORACLE, 770000000000000000n, KYBER_ROUTER, "0x0000000000000000000000000000000000000000", 100000000n],
    [status.targets?.targetM48_Morpho_reUSD_USDT, "targetM48_Morpho_reUSD_USDT", M48_BORROWER, USDT, REUSD, M48_ORACLE, M2_LLTV, CURVE_REUSD_USDC, UNI_ROUTER, 100000000n],
    [status.targets?.targetM49_Morpho_sUSDe_USDT, "targetM49_Morpho_sUSDe_USDT", M49_BORROWER, USDT, SUSDE, M49_ORACLE, M2_LLTV, M49_FLUID_SUSDE_USDT, "0x0000000000000000000000000000000000000000", 100000000n],
  ]) {
    const uCalldata = mUniv?.readyExecuteUniversalCalldata || mUniv?.readyExecuteCurveUnwindCalldata;
    if (mUniv?.liquidatableNow === true && uCalldata) {
      requireThat(mUniv.user?.toLowerCase() === borrowerAddr, "COLLECTOR_TARGET_MISMATCH");
      const data = uCalldata, decoded = UNIVERSAL_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0];
      requireThat(UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
      requireThat(p.mode === 0n && p.loanToken.toLowerCase() === loanTok && p.collateralToken.toLowerCase() === colTok &&
        p.oracle.toLowerCase() === orcAddr && p.irm.toLowerCase() === M1_IRM && p.lltv === lltvVal &&
        p.borrower.toLowerCase() === borrowerAddr && p.seizedAssets > 0n &&
        (id === "targetM45_Morpho_reUSDe_USDC" ? [CURVE_ROUTER_NG, KYBER_ROUTER].includes(p.target1.toLowerCase()) : p.target1.toLowerCase() === t1Addr) &&
        p.target2.toLowerCase() === t2Addr && p.minProfit >= minProf, "EXECUTION_TARGET_MISMATCH");
      const priorityAmount = amount => amount * 10n ** 12n / 2400n;
      selected.push({ id, kind: "UNIVERSAL_FLUID_MORPHO_LIQUIDATION", executor: UNIVERSAL_EXECUTOR, profitToken: loanTok,
        target: MORPHO_BLUE, borrower: borrowerAddr, data, minProfitRaw: p.minProfit,
        flashAmount: priorityAmount(p.flashAmount),
        params: { minDebtTokenOut: priorityAmount(p.flashAmount + p.minProfit), minProfitDebtToken: priorityAmount(p.minProfit) } });
    }
  }
  const m37 = status.targets?.targetM37_Morpho_PST_USDT;
  const m37Calldata = m37?.readyExecuteUniversalCalldata || m37?.readyExecuteCurveUnwindCalldata;
  if (m37?.liquidatableNow === true && m37Calldata) {
    requireThat(m37.user?.toLowerCase() === M24_BORROWER, "COLLECTOR_TARGET_MISMATCH");
    const data = m37Calldata, decoded = UNIVERSAL_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0];
    requireThat(UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.mode === 0n && p.loanToken.toLowerCase() === USDT && p.collateralToken.toLowerCase() === M37_PST &&
      p.oracle.toLowerCase() === M37_ORACLE && p.irm.toLowerCase() === M1_IRM && p.lltv === M1_LLTV &&
      p.borrower.toLowerCase() === M24_BORROWER && p.seizedAssets > 0n && p.target1.toLowerCase() === M37_FLUID_PST_USDC &&
      p.target2.toLowerCase() === UNI_ROUTER && p.minProfit >= 100000000n, "EXECUTION_TARGET_MISMATCH");
    const priorityAmount = amount => amount * 10n ** 12n / 2400n;
    selected.push({ id: "targetM37_Morpho_PST_USDT", kind: "UNIVERSAL_FLUID_MORPHO_LIQUIDATION", executor: UNIVERSAL_EXECUTOR, profitToken: USDT,
      target: MORPHO_BLUE, borrower: M24_BORROWER, data, minProfitRaw: p.minProfit,
      flashAmount: priorityAmount(p.flashAmount),
      params: { minDebtTokenOut: priorityAmount(p.flashAmount + p.minProfit), minProfitDebtToken: priorityAmount(p.minProfit) } });
  }
  for (const [fRow, id, vaultAddr, borrowerAddr, loanTok, minProf, scaleFn] of [
    [status.targets?.targetF4_Fluid_PAXG_XAUt_Vault123, "targetF4_Fluid_PAXG_XAUt_Vault123", F4_VAULT_123, F4_BORROWER, USDT, 2000000n, a => a * 10n ** 12n / 2400n],
    [status.targets?.targetF5_Fluid_WBTC_LBTC_Vault115, "targetF5_Fluid_WBTC_LBTC_Vault115", F5_VAULT_115, F5_BORROWER, WBTC, 10000n, a => a * 10n ** 10n * 34n],
    [status.targets?.targetF6_Fluid_syrupUSDC_USDC_Vault145, "targetF6_Fluid_syrupUSDC_USDC_Vault145", F6_VAULT_145, F6_BORROWER, USDC, 10000000n, a => a * 10n ** 12n / 2400n],
  ]) {
    const fCalldata = fRow?.readyExecuteUniversalCalldata || fRow?.readyExecuteCurveUnwindCalldata;
    if (fRow?.liquidatableNow === true && fCalldata) {
      requireThat(fRow.user?.toLowerCase() === borrowerAddr, "COLLECTOR_TARGET_MISMATCH");
      const data = fCalldata, decoded = UNIVERSAL_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0];
      requireThat(UNIVERSAL_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
      requireThat(p.mode === 1n && p.loanToken.toLowerCase() === loanTok && p.fluidVault.toLowerCase() === vaultAddr &&
        p.flashAmount > 0n && p.minProfit >= minProf, "EXECUTION_TARGET_MISMATCH");
      selected.push({ id, kind: "UNIVERSAL_FLUID_MORPHO_LIQUIDATION", executor: UNIVERSAL_EXECUTOR, profitToken: loanTok,
        target: vaultAddr, borrower: borrowerAddr, data, minProfitRaw: p.minProfit,
        flashAmount: scaleFn(p.flashAmount),
        params: { minDebtTokenOut: scaleFn(p.flashAmount + p.minProfit), minProfitDebtToken: scaleFn(p.minProfit) } });
    }
  }
  for (const [m7, borrower, id] of [
    [status.targets?.targetM7_Morpho_ynETHx_msETH_Canary, M7_BORROWER, "targetM7_Morpho_ynETHx_msETH"],
    [status.targets?.targetM7B_Morpho_ynETHx_msETH_0x9b13, M7B_BORROWER, "targetM7B_Morpho_ynETHx_msETH_0x9b13"],
  ]) {
    if (m7?.liquidatableNow !== true || !m7.readyExecuteVaultRedeemCalldata) continue;
    requireThat(m7.user?.toLowerCase() === borrower, "COLLECTOR_TARGET_MISMATCH");
    const data = m7.readyExecuteVaultRedeemCalldata, decoded = M7_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0];
    requireThat(M7_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.loanToken.toLowerCase() === MSETH && p.collateralToken.toLowerCase() === YNETHX && p.oracle.toLowerCase() === M7_ORACLE &&
      p.irm.toLowerCase() === M1_IRM && p.lltv === M7_LLTV && p.borrower.toLowerCase() === borrower, "EXECUTION_TARGET_MISMATCH");
    requireThat(p.seizedAssets >= 1000000000000000000n && p.seizedAssets <= 50000000000000000000n &&
      p.intermediateToken.toLowerCase() === WETH && p.curvePool.toLowerCase() === CURVE_MSETH_WETH && p.curveI === 1n && p.curveJ === 0n, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.minLoanOut > p.seizedAssets, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    selected.push({ id, kind: "MORPHO_BLUE_M7", executor: M7_EXECUTOR, profitToken: MSETH,
      target: MORPHO_BLUE, borrower, data, seizedAssets: p.seizedAssets, minLoanOut: p.minLoanOut,
      minProfitWeth: 50000000000000000n, flashAmount: p.seizedAssets,
      params: { minDebtTokenOut: p.minLoanOut, minProfitDebtToken: 50000000000000000n } });
  }
  const yn = status.targets?.targetYnEthx_Curve_NavArb;
  if (yn?.liquidatableNow === true && yn.readyExecuteCurveRedeemCalldata) {
    requireThat(yn.user?.toLowerCase() === CURVE_YNETHX_WETH, "COLLECTOR_TARGET_MISMATCH");
    const data = yn.readyExecuteCurveRedeemCalldata, decoded = YN_ARB_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0];
    requireThat(YN_ARB_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.loanToken.toLowerCase() === WETH && p.vaultToken.toLowerCase() === YNETHX && p.curvePool.toLowerCase() === CURVE_YNETHX_WETH &&
      p.curveI === 1n && p.curveJ === 0n, "EXECUTION_TARGET_MISMATCH");
    requireThat(p.flashAmount >= 1000000000000000000n && p.flashAmount <= 45000000000000000000n && p.minSharesOut > 0n, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.minLoanOut >= p.flashAmount + 50000000000000000n, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    selected.push({ id: "targetYnEthx_Curve_NavArb", kind: "CURVE_BUY_VAULT_REDEEM_YN", executor: YN_ARB_EXECUTOR, profitToken: WETH,
      target: MORPHO_BLUE, borrower: CURVE_YNETHX_WETH, data, flashAmount: p.flashAmount, minSharesOut: p.minSharesOut, minLoanOut: p.minLoanOut,
      minProfitWeth: 50000000000000000n, params: { minDebtTokenOut: p.minLoanOut, minProfitDebtToken: 50000000000000000n } });
  }
  const e1 = status.targets?.targetE1_EulerV2_RLUSD_USDC_0xbf21;
  if (e1?.liquidatableNow === true && e1.readyExecuteEulerEvkCalldata) {
    requireThat(e1.user?.toLowerCase() === E1_BORROWER, "COLLECTOR_TARGET_MISMATCH");
    const data = e1.readyExecuteEulerEvkCalldata, decoded = EULER_EVK_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0];
    requireThat(EULER_EVK_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.loanToken.toLowerCase() === RLUSD && p.liabilityVault.toLowerCase() === E1_LIABILITY_VAULT && p.collateralVault.toLowerCase() === E1_COLL_VAULT &&
      p.underlyingCollateral.toLowerCase() === USDC && p.violator.toLowerCase() === E1_BORROWER, "EXECUTION_TARGET_MISMATCH");
    requireThat(p.unwindKind === 1n && p.swapTarget.toLowerCase() === CURVE_USDC_RLUSD && p.curveI === 0n && p.curveJ === 1n && p.repayAssets > 0n && p.minYieldShares > 0n, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.minLoanOut >= p.repayAssets + 50000000000000000000n, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    selected.push({ id: "targetE1_EulerV2_RLUSD_USDC_0xbf21", kind: "EULER_EVK_E1", executor: EULER_EVK_EXECUTOR, profitToken: RLUSD,
      target: MORPHO_BLUE, borrower: E1_BORROWER, data, repayAssets: p.repayAssets, minLoanOut: p.minLoanOut,
      minProfitRlusd: 50000000000000000000n, flashAmount: p.repayAssets / 2400n,
      params: { minDebtTokenOut: p.minLoanOut / 2400n, minProfitDebtToken: 50000000000000000000n / 2400n } });
  }
  for (const candidate of [
    { id: "targetE3_EulerV2_WETH_ynETHx_0x831e", borrower: E3_BORROWER,
      loanToken: WETH, liabilityVault: E3_LIABILITY_VAULT, collateralVault: E3_COLL_VAULT, underlying: YNETHX,
      repayAssets: 515000000000000000n, minYieldShares: 505000000000000000n, unwindKind: 0n,
      swapTarget: "0x0000000000000000000000000000000000000000", curveI: 0n, curveJ: 0n, minProfitRaw: 35000000000000000n },
    { id: "targetE4_EulerV2_WETH_ynETHx_0x8062", borrower: "0x8062511602a163fe84d1d2300117ea8cc1600cbd",
      loanToken: WETH, liabilityVault: E3_LIABILITY_VAULT, collateralVault: E3_COLL_VAULT, underlying: YNETHX,
      repayAssets: 202000000000000000n, minYieldShares: 195000000000000000n, unwindKind: 0n,
      swapTarget: "0x0000000000000000000000000000000000000000", curveI: 0n, curveJ: 0n, minProfitRaw: 10000000000000000n },
    { id: "targetE5_EulerV2_USDC_USDT_0xd1ed", borrower: "0xd1edf7fc3d913c94e6c649985ce36bbc2e871d0f",
      loanToken: USDC, liabilityVault: E1_COLL_VAULT, collateralVault: E_USDT_VAULT, underlying: USDT,
      repayAssets: 1400000000n, minYieldShares: 1300000000n, unwindKind: 1n,
      swapTarget: CURVE_USDC_USDT, curveI: 1n, curveJ: 0n, minProfitRaw: 10000000n },
    { id: "targetE6_EulerV2_USDT_USDC_0x079d", borrower: "0x079dfb0a62b4723b45166abb7892fe362543ad8d",
      loanToken: USDT, liabilityVault: E_USDT_VAULT, collateralVault: E1_COLL_VAULT, underlying: USDC,
      repayAssets: 5450000000n, minYieldShares: 5100000000n, unwindKind: 1n,
      swapTarget: CURVE_USDC_USDT, curveI: 0n, curveJ: 1n, minProfitRaw: 15000000n },
  ]) {
    const item = status.targets?.[candidate.id];
    if (!currentNominationEligible(item, status.pin, item?.executableNow === true) || item.liquidatableNow !== true || !item.readyExecuteEulerEvkCalldata) continue;
    requireThat(item.user?.toLowerCase() === candidate.borrower, "COLLECTOR_TARGET_MISMATCH");
    const data = item.readyExecuteEulerEvkCalldata, decoded = EULER_EVK_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0];
    requireThat(EULER_EVK_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.loanToken.toLowerCase() === candidate.loanToken && p.liabilityVault.toLowerCase() === candidate.liabilityVault &&
      p.collateralVault.toLowerCase() === candidate.collateralVault && p.underlyingCollateral.toLowerCase() === candidate.underlying &&
      p.violator.toLowerCase() === candidate.borrower, "EXECUTION_TARGET_MISMATCH");
    requireThat(p.unwindKind === candidate.unwindKind && p.swapTarget.toLowerCase() === candidate.swapTarget &&
      p.curveI === candidate.curveI && p.curveJ === candidate.curveJ && p.repayAssets === candidate.repayAssets &&
      p.minYieldShares >= candidate.minYieldShares, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.minLoanOut >= p.repayAssets + candidate.minProfitRaw, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    // Normalize only the priority heuristic, retaining native token units in the guarded intent.
    const priorityAmount = amount => candidate.loanToken === WETH ? amount : amount * 10n ** 12n / 2400n;
    selected.push({ id: candidate.id, kind: "EULER_EVK_E1", executor: EULER_EVK_EXECUTOR, profitToken: candidate.loanToken,
      target: candidate.liabilityVault, borrower: candidate.borrower, data, repayAssets: p.repayAssets, minLoanOut: p.minLoanOut,
      minProfitRaw: candidate.minProfitRaw, flashAmount: priorityAmount(p.repayAssets),
      params: { minDebtTokenOut: priorityAmount(p.minLoanOut), minProfitDebtToken: priorityAmount(candidate.minProfitRaw) } });
  }
  for (const candidate of [
    { id: "targetA5_AaveV4_syrupUSDG_USDG_0x080c", mode: 0n, target: A5_SPOKE, collateralVault: "0x0000000000000000000000000000000000000000",
      collateralReserveId: 1n, debtReserveId: 3n, borrower: A5_BORROWER, debtAsset: USDG, collateralAsset: SYRUP_USDG,
      flashAmount: 850000000000n, minCollateralSeized: 830000000000n, minProfitRaw: 10000000000n,
      currency0: SYRUP_USDG, currency1: USDG, fee: 800n, tickSpacing: 5n },
    { id: "targetA6_AaveV4_syrupUSDG_USDG_0xbd81", mode: 0n, target: A5_SPOKE, collateralVault: "0x0000000000000000000000000000000000000000",
      collateralReserveId: 1n, debtReserveId: 0n, borrower: "0xbd810c549c287c759ff9044efeb1712bc1a58edd", debtAsset: USDG, collateralAsset: SYRUP_USDG,
      flashAmount: 65000000000n, minCollateralSeized: 64000000000n, minProfitRaw: 1000000000n,
      debtToCover: 65000000000n, minSwapOut: 66000000000n,
      currency0: SYRUP_USDG, currency1: USDG, fee: 800n, tickSpacing: 5n },
    { id: "targetA7_AaveV4_syrupUSDG_USDG_0x28e8", mode: 0n, target: A5_SPOKE, collateralVault: "0x0000000000000000000000000000000000000000",
      collateralReserveId: 1n, debtReserveId: 0n, borrower: "0x28e81c2230bf90ed002aa4a0451acbae49559e2b", debtAsset: USDG, collateralAsset: SYRUP_USDG,
      flashAmount: 850000000000n, minCollateralSeized: 830000000000n, minProfitRaw: 10000000000n,
      debtToCover: 850000000000n, minSwapOut: 860000000000n,
      currency0: SYRUP_USDG, currency1: USDG, fee: 800n, tickSpacing: 5n },
    { id: "targetA8_AaveV4_syrupUSDG_USDG_0x707e", mode: 0n, target: A5_SPOKE, collateralVault: "0x0000000000000000000000000000000000000000",
      collateralReserveId: 1n, debtReserveId: 0n, borrower: "0x707ecbafef8dbc3b248b8a6fd6ca45e7c569a85c", debtAsset: USDG, collateralAsset: SYRUP_USDG,
      flashAmount: 850000000000n, minCollateralSeized: 830000000000n, minProfitRaw: 10000000000n,
      debtToCover: 850000000000n, minSwapOut: 860000000000n,
      currency0: SYRUP_USDG, currency1: USDG, fee: 800n, tickSpacing: 5n },
    { id: "targetA9_AaveV4_syrupUSDG_USDG_0x90ff", mode: 0n, target: A5_SPOKE, collateralVault: "0x0000000000000000000000000000000000000000",
      collateralReserveId: 1n, debtReserveId: 0n, borrower: "0x90fff1dad57875e08df86df05bcebb3fd3514dfb", debtAsset: USDG, collateralAsset: SYRUP_USDG,
      flashAmount: 850000000000n, minCollateralSeized: 830000000000n, minProfitRaw: 10000000000n,
      debtToCover: 850000000000n, minSwapOut: 860000000000n,
      currency0: SYRUP_USDG, currency1: USDG, fee: 800n, tickSpacing: 5n },
    { id: "targetA10_AaveV4_syrupUSDG_USDG_0x6efc", mode: 0n, target: A5_SPOKE, collateralVault: "0x0000000000000000000000000000000000000000",
      collateralReserveId: 1n, debtReserveId: 0n, borrower: "0x6efc48b8b6222924fa6ea95d174af5518b761177", debtAsset: USDG, collateralAsset: SYRUP_USDG,
      flashAmount: 650000000000n, minCollateralSeized: 635000000000n, minProfitRaw: 8000000000n,
      debtToCover: 650000000000n, minSwapOut: 658000000000n,
      currency0: SYRUP_USDG, currency1: USDG, fee: 800n, tickSpacing: 5n },
    { id: "targetA14_AaveV4_syrupUSDG_USDG_0xabcc", mode: 0n, target: A5_SPOKE, collateralVault: "0x0000000000000000000000000000000000000000",
      collateralReserveId: 1n, debtReserveId: 0n, borrower: "0xabcc4b4227fc2bcf0fda9776bbe7ffce69e23d64", debtAsset: USDG, collateralAsset: SYRUP_USDG,
      flashAmount: 850000000000n, minCollateralSeized: 830000000000n, minProfitRaw: 10000000000n,
      debtToCover: 850000000000n, minSwapOut: 860000000000n,
      currency0: SYRUP_USDG, currency1: USDG, fee: 800n, tickSpacing: 5n },
    { id: "targetA16_AaveV4_syrupUSDG_USDG_0x9cd7", mode: 0n, target: A5_SPOKE, collateralVault: "0x0000000000000000000000000000000000000000",
      collateralReserveId: 1n, debtReserveId: 0n, borrower: "0x9cd74118eed35372672e66bb6af6e6454f94df05", debtAsset: USDG, collateralAsset: SYRUP_USDG,
      flashAmount: 250000000000n, minCollateralSeized: 240000000000n, minProfitRaw: 3000000000n,
      debtToCover: 250000000000n, minSwapOut: 253000000000n,
      currency0: SYRUP_USDG, currency1: USDG, fee: 800n, tickSpacing: 5n },
    { id: "targetA18_AaveV4_syrupUSDG_USDG_0xdd64", mode: 0n, target: A5_SPOKE, collateralVault: "0x0000000000000000000000000000000000000000",
      collateralReserveId: 1n, debtReserveId: 0n, borrower: "0xdd647ce113505b34c62412d2a804ce1bfbcfc737", debtAsset: USDG, collateralAsset: SYRUP_USDG,
      flashAmount: 850000000000n, minCollateralSeized: 830000000000n, minProfitRaw: 10000000000n,
      debtToCover: 850000000000n, minSwapOut: 860000000000n,
      currency0: SYRUP_USDG, currency1: USDG, fee: 800n, tickSpacing: 5n },
    { id: "targetA12_AaveV4_WBTC_USDT_0xac90", mode: 0n, target: A12_SPOKE, collateralVault: "0x0000000000000000000000000000000000000000",
      collateralReserveId: 1n, debtReserveId: 5n, borrower: A12_BORROWER, debtAsset: USDT, collateralAsset: WBTC,
      flashAmount: 28000000000n, minCollateralSeized: 35000000n, minProfitRaw: 500000000n,
      debtToCover: 28000000000n, minSwapOut: 28500000000n,
      currency0: WBTC, currency1: USDT, fee: 500n, tickSpacing: 10n },
    { id: "targetE2_EulerV2_USDC_syrupUSDC_0x9f09", mode: 1n, target: E2_LIABILITY_VAULT, collateralVault: E2_COLL_VAULT,
      collateralReserveId: 0n, debtReserveId: 0n, borrower: E2_BORROWER, debtAsset: USDC, collateralAsset: SYRUP_USDC,
      flashAmount: 401000000000n, minCollateralSeized: 335000000000n, minProfitRaw: 1000000000n,
      currency0: SYRUP_USDC, currency1: USDC, fee: 800n, tickSpacing: 5n },
  ]) {
    const item = status.targets?.[candidate.id];
    if (!currentNominationEligible(item, status.pin, item?.executableNow === true) || item.liquidatableNow !== true || !item.readyExecuteUniV4FlashCalldata) continue;
    requireThat(item.user?.toLowerCase() === candidate.borrower, "COLLECTOR_TARGET_MISMATCH");
    const data = item.readyExecuteUniV4FlashCalldata, decoded = UNIV4_FLASH_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0];
    requireThat(UNIV4_FLASH_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.mode === candidate.mode && p.target.toLowerCase() === candidate.target && p.collateralVault.toLowerCase() === candidate.collateralVault &&
      p.collateralReserveId === candidate.collateralReserveId && p.debtReserveId === candidate.debtReserveId &&
      p.borrower.toLowerCase() === candidate.borrower && p.debtAsset.toLowerCase() === candidate.debtAsset &&
      p.collateralAsset.toLowerCase() === candidate.collateralAsset, "EXECUTION_TARGET_MISMATCH");
    requireThat(p.flashAmount === candidate.flashAmount && p.minCollateralSeized >= candidate.minCollateralSeized &&
      p.poolKey.currency0.toLowerCase() === candidate.currency0 && p.poolKey.currency1.toLowerCase() === candidate.currency1 &&
      p.poolKey.fee === candidate.fee && p.poolKey.tickSpacing === candidate.tickSpacing &&
      p.poolKey.hooks.toLowerCase() === "0x0000000000000000000000000000000000000000" && p.zeroForOne === true, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.minProfit >= candidate.minProfitRaw && p.minSwapOut > 0n, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    if (candidate.debtToCover !== undefined) {
      requireThat(p.debtToCover === candidate.debtToCover && p.deadline === 9999999999n, "EXECUTION_ROUTE_NOT_ALLOWED");
      requireThat(p.minSwapOut >= candidate.minSwapOut, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    }
    const priorityAmount = amount => amount * 10n ** 12n / 2400n;
    selected.push({ id: candidate.id, kind: "UNIV4_FLASH_LIQUIDATION", executor: UNIV4_FLASH_EXECUTOR, profitToken: candidate.debtAsset,
      target: candidate.target, borrower: candidate.borrower, data, minProfitRaw: candidate.minProfitRaw,
      flashAmount: priorityAmount(p.flashAmount),
      params: { minDebtTokenOut: priorityAmount(p.flashAmount + candidate.minProfitRaw), minProfitDebtToken: priorityAmount(candidate.minProfitRaw) } });
  }
  for (const candidate of [
    { id: "targetM8_Morpho_PT_USDe_DAI", borrower: M8_BORROWER, seizedPt: 30000n * 10n ** 18n, minProfitDai: 200n * 10n ** 18n },
    { id: "targetM9_Morpho_PT_USDe_DAI", borrower: M9_BORROWER, seizedPt: 11500n * 10n ** 18n, minProfitDai: 75n * 10n ** 18n },
  ]) {
    const item = status.targets?.[candidate.id];
    if (!currentNominationEligible(item, status.pin, item?.executableNow === true) || item.liquidatableNow !== true || !item.readyExecutePendlePtCalldata) continue;
    requireThat(item.user?.toLowerCase() === candidate.borrower, "COLLECTOR_TARGET_MISMATCH");
    const data = item.readyExecutePendlePtCalldata, decoded = PENDLE_PT_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0], swapData = decoded[1];
    requireThat(PENDLE_PT_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(p.loanToken.toLowerCase() === DAI && p.collateralToken.toLowerCase() === PT_USDE &&
      p.oracle.toLowerCase() === PT_ORACLE && p.irm.toLowerCase() === M1_IRM && p.lltv === M2_LLTV &&
      p.borrower.toLowerCase() === candidate.borrower && p.seizedAssets === candidate.seizedPt &&
      p.pendleYt.toLowerCase() === PENDLE_YT && p.pendleSy.toLowerCase() === PENDLE_SY &&
      p.redeemedToken.toLowerCase() === USDE && p.swapTarget.toLowerCase() === UNI_ROUTER &&
      swapData && swapData.length > 10, "EXECUTION_TARGET_MISMATCH");
    requireThat(p.minLoanOut >= candidate.seizedPt + candidate.minProfitDai || p.minLoanOut > candidate.minProfitDai, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
    const priorityAmount = amount => amount / 2400n;
      selected.push({ id: candidate.id, kind: "MORPHO_PENDLE_PT_REDEEM", executor: PENDLE_PT_EXECUTOR, profitToken: DAI,
      target: MORPHO_BLUE, borrower: candidate.borrower, data, minProfitRaw: candidate.minProfitDai,
      flashAmount: priorityAmount(candidate.seizedPt),
      params: { minDebtTokenOut: priorityAmount(p.minLoanOut), minProfitDebtToken: priorityAmount(candidate.minProfitDai) } });
  }
  const m14 = status.targets?.targetM14_Morpho_PT_USDat_USDC;
  if (currentNominationEligible(m14, status.pin, m14?.executableNow === true) && m14.liquidatableNow === true && m14.readyExecutePendlePtCalldata) {
    requireThat(m14.user?.toLowerCase() === M14_BORROWER, "COLLECTOR_TARGET_MISMATCH");
    const data = m14.readyExecutePendlePtCalldata, decoded = PENDLE_PT_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0], swapData = decoded[1];
    requireThat(PENDLE_PT_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    const ex = CURVE_EXCHANGE_IFACE.decodeFunctionData("exchange", swapData);
    requireThat(CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", ex).toLowerCase() === swapData.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(ex[0] === 1n && ex[1] === 0n && ex[2] === p.seizedAssets && ex[3] > 0n, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.loanToken.toLowerCase() === USDC && p.collateralToken.toLowerCase() === M14_PT &&
      p.oracle.toLowerCase() === M14_ORACLE && p.irm.toLowerCase() === M1_IRM && p.lltv === M2_LLTV &&
      p.borrower.toLowerCase() === M14_BORROWER && p.seizedAssets > 0n && p.seizedAssets <= 5400000000n &&
      p.pendleYt.toLowerCase() === M14_YT && p.pendleSy.toLowerCase() === M14_SY &&
      p.redeemedToken.toLowerCase() === USDAT && p.swapTarget.toLowerCase() === CURVE_USDAT_USDC &&
      p.minLoanOut > 25000000n, "EXECUTION_TARGET_MISMATCH");
    const priorityAmount = amount => amount * 10n ** 12n / 2400n;
    selected.push({ id: "targetM14_Morpho_PT_USDat_USDC", kind: "MORPHO_PENDLE_PT_REDEEM", executor: PENDLE_PT_EXECUTOR, profitToken: USDC,
      target: MORPHO_BLUE, borrower: M14_BORROWER, data, minProfitRaw: 25000000n,
      flashAmount: priorityAmount(p.seizedAssets),
      params: { minDebtTokenOut: priorityAmount(p.minLoanOut), minProfitDebtToken: priorityAmount(25000000n) } });
  }
  const m29 = status.targets?.targetM29_Morpho_PT_srUSDe_USDC;
  if (currentNominationEligible(m29, status.pin, m29?.executableNow === true) && m29.liquidatableNow === true && m29.readyExecutePendlePtCalldata) {
    requireThat(m29.user?.toLowerCase() === M29_BORROWER, "COLLECTOR_TARGET_MISMATCH");
    const data = m29.readyExecutePendlePtCalldata, decoded = PENDLE_PT_EXEC_IFACE.decodeFunctionData("execute", data), p = decoded[0], swapData = decoded[1];
    requireThat(PENDLE_PT_EXEC_IFACE.encodeFunctionData("execute", decoded).toLowerCase() === data.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    const ex = CURVE_ROUTER_NG_IFACE.decodeFunctionData("exchange", swapData);
    requireThat(CURVE_ROUTER_NG_IFACE.encodeFunctionData("exchange", ex).toLowerCase() === swapData.toLowerCase(), "EXECUTION_CALLDATA_INVALID");
    requireThat(ex[0][0].toLowerCase() === SUSDE && ex[0][4].toLowerCase() === USDC && ex[3] >= 20000000n && ex[5].toLowerCase() === PENDLE_PT_EXECUTOR, "EXECUTION_ROUTE_NOT_ALLOWED");
    requireThat(p.loanToken.toLowerCase() === USDC && p.collateralToken.toLowerCase() === M29_PT &&
      p.oracle.toLowerCase() === M29_ORACLE && p.irm.toLowerCase() === M1_IRM && p.lltv === M2_LLTV &&
      p.borrower.toLowerCase() === M29_BORROWER && p.seizedAssets > 0n && p.seizedAssets <= 4200000000000000000000n &&
      p.pendleYt.toLowerCase() === M29_YT && p.pendleSy.toLowerCase() === M29_SY &&
      p.redeemedToken.toLowerCase() === SUSDE && p.swapTarget.toLowerCase() === CURVE_ROUTER_NG &&
      p.minLoanOut > 20000000n, "EXECUTION_TARGET_MISMATCH");
    const priorityAmount = amount => amount * 10n ** 12n / 2400n;
    selected.push({ id: "targetM29_Morpho_PT_srUSDe_USDC", kind: "MORPHO_PENDLE_PT_REDEEM", executor: PENDLE_PT_EXECUTOR, profitToken: USDC,
      target: MORPHO_BLUE, borrower: M29_BORROWER, data, minProfitRaw: 20000000n,
      flashAmount: p.seizedAssets / 2400n,
      params: { minDebtTokenOut: priorityAmount(p.minLoanOut), minProfitDebtToken: priorityAmount(20000000n) } });
  }
  // No PAXG candidate, supply, borrow or fallback signing path exists here.
  selected.sort((a, b) => {
    const sa = a.params.minDebtTokenOut - a.flashAmount;
    const sb = b.params.minDebtTokenOut - b.flashAmount;
    if (sb !== sa) return sb > sa ? 1 : -1;
    if (b.flashAmount !== a.flashAmount) return b.flashAmount > a.flashAmount ? 1 : -1;
    return 0;
  });
  return selected;
}
function canonicalPosition(candidate) {
  if (candidate.kind === "MORPHO_BLUE_M32") return `1:${MORPHO_BLUE}:${M32_BORROWER}:0x88a18b2f4d94e7ad27a381b15531c06abf05a7c99dd5d3c3679875fed6f7e742`;
  let venue = candidate.target?.toLowerCase(), market = "";
  const interfaces = {
    MORPHO_BLUE_M1: MORPHO_EXEC_IFACE, MORPHO_BLUE_WSTETH: MORPHO_EXEC_IFACE, MORPHO_BLUE_M2: M2_EXEC_IFACE,
    MORPHO_BLUE_M7: M7_EXEC_IFACE, MORPHO_PENDLE_PT_REDEEM: PENDLE_PT_EXEC_IFACE,
    UNIVERSAL_FLUID_MORPHO_LIQUIDATION: UNIVERSAL_EXEC_IFACE, EULER_EVK_E1: EULER_EVK_EXEC_IFACE,
    UNIVERSAL_EULER_EVK_LIQUIDATION: UNIVERSAL_EULER_EXEC_IFACE, UNIV4_FLASH_LIQUIDATION: UNIV4_FLASH_EXEC_IFACE,
  };
  const iface = interfaces[candidate.kind];
  if (iface) {
    const p = iface.decodeFunctionData("execute", candidate.data)[0];
    if (p.oracle && p.irm && p.lltv !== undefined && !(p.fluidVault && p.mode !== 0n)) {
      market = keccak256(AbiCoder.defaultAbiCoder().encode(["address", "address", "address", "address", "uint256"],
        [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv]));
      venue = MORPHO_BLUE;
    } else venue = (p.liabilityVault || (p.mode === 1n ? p.fluidVault : p.target) || venue).toLowerCase();
  }
  requireThat(venue && candidate.borrower, "EXECUTION_TARGET_MISMATCH");
  return `1:${venue}:${candidate.borrower.toLowerCase()}:${market}`;
}
const FORECAST_FIELDS = Object.freeze(["readyExecuteMorphoCalldata", "readyExecuteMorphoBlueCalldata", "readyExecuteCurveUnwindCalldata",
  "readyExecuteReusdCalldata", "readyExecuteVaultRedeemCalldata", "readyExecuteEulerEvkCalldata", "readyExecuteUniV4FlashCalldata",
  "readyExecutePendlePtCalldata", "readyExecuteUniversalCalldata"]);
function selectCandidates(status, argv = [], { nextBlockContext } = {}) {
  const mapTargets = fn => Object.fromEntries(Object.entries(status.targets || {}).map(([key, value]) => [key,
    Array.isArray(value) ? value.map(row => fn(row, key)).filter(Boolean) : fn(value, key)]));
  const current = selectValidatedCandidates({ ...status, targets: mapTargets((row, key) => {
    if (!nextExecution.activePosition(row) || !currentNominationEligible(row, status.pin) ||
        row.liquidatableNow === false && key !== "targetYnEthx_Curve_NavArb") return undefined;
    if (key === m1Live.ID && row.m1Nomination) {
      try { if (row.debtReadStatus !== "COMPLETE" || uint(row.currentDebtRaw) <= uint(row.maxBorrowRaw)) return undefined; }
      catch (_) { return undefined; }
    }
    return row;
  }) }, argv);
  const m32 = status.targets?.targetM32_Morpho_sUSDe_USDtb;
  if (m32?.liquidatableNow === true && typeof m32.user === "string" && m32.user.toLowerCase() === M32_BORROWER &&
      typeof m32.marketId === "string" && m32.marketId.toLowerCase() === "0x88a18b2f4d94e7ad27a381b15531c06abf05a7c99dd5d3c3679875fed6f7e742" &&
      nextExecution.activePosition(m32) && currentNominationEligible(m32, status.pin)) {
    current.push({ id: "targetM32_Morpho_sUSDe_USDtb", kind: "MORPHO_BLUE_M32", executor: require("./lib/m32-deployment.js").EXECUTOR,
      target: MORPHO_BLUE, borrower: M32_BORROWER, marketId: m32.marketId.toLowerCase(), nominationOnly: true, executableNow: false });
  }
  const seen = new Set(), selected = current.filter(candidate => {
    const key = canonicalPosition(candidate); if (seen.has(key)) return false; seen.add(key); return true;
  });
  if (!nextBlockContext) return selected;
  const forecastTargets = mapTargets((row, key) => {
    // #1 remains dedicated-owned, even with --include-aave-v4. #YN/Fluid are current-only.
    if (key === "target1_AaveV4_USDe_USDC" || key === "targetYnEthx_Curve_NavArb" || /^targetF\d+_Fluid_/.test(key) ||
      !nextExecution.forecastEligible(row, nextBlockContext)) return undefined;
    const plans = row.nextBlockForecast.plans;
    if (!Object.keys(plans).length || Object.keys(plans).some(k => !FORECAST_FIELDS.includes(k) || typeof plans[k] !== "string")) return undefined;
    // Eligibility is a proposal from this collection only, never simulation evidence.
    // Clear all current plans so no cached/alternate field can become an execution plan.
    return { ...row, ...Object.fromEntries(FORECAST_FIELDS.map(k => [k, null])), ...plans,
      liquidatableNow: true, eligibleForPreflight: true, executableNow: row.observationKind !== "READ_ONLY_MONITOR" };
  });
  for (const candidate of selectValidatedCandidates({ ...status, targets: forecastTargets }, argv)) {
    const key = canonicalPosition(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({ ...candidate, canonicalPosition: key, executionMode: "NEXT_BLOCK_PASSIVE", nextBlockContext });
  }
  return selected;
}

function forecastRoute(candidate) {
  // M1 has its own source-bound, dynamic-size final-settlement lane. Never
  // authorize it through the generic preliminary-simulation route adapter.
  if (candidate.kind === "MORPHO_BLUE_M1") return null;
  const morpho = candidate.kind === "MORPHO_BLUE_M1" || candidate.kind === "MORPHO_BLUE_WSTETH";
  const unified = !candidate.kind || candidate.kind === "AAVE_V4_SAME_ASSET_WETH";
  if (!morpho && !unified) return null; // Generic routes lack exact future quote/slippage proof; no current-pin fallback.
  const iface = morpho ? MORPHO_EXEC_IFACE : UNIFIED_IFACE, method = morpho ? "execute" : "executeMorpho";
  const d = iface.decodeFunctionData(method, candidate.data), p = morpho ? d[0] : d[1];
  const token = morpho ? p.loanToken.toLowerCase() : p.debtToken.toLowerCase();
  if (token !== WETH && token !== DAI) return null;
  const executor = morpho ? MORPHO_EXECUTOR : DEPLOYED_EXECUTOR;
  const noSwap = !morpho && p.swapKind === 0n, useCurve = !morpho && p.swapKind === 2n;
  const collateral = p.collateralToken.toLowerCase(), quotePath = morpho ? d[7] : WST_PATH;
  if (!noSwap && ![USDE, WSTETH, WEETH].includes(collateral)) return null;
  const recipient = noSwap ? null : useCurve ? CURVE : nextExecution.v3InputPool(
    quotePath.slice(0, 42), "0x" + quotePath.slice(48, 88), BigInt("0x" + quotePath.slice(42, 48)));
  const actualInput = logs => nextExecution.swapInput(logs, { token: collateral, executor, recipient,
    minimum: morpho ? d[2] : p.minCollateralSeized, ...(morpho ? { exact: d[2] } : {}) });
  return {
    executor, profitToken: token, actualInput,
    checkReturn: raw => { iface.decodeFunctionResult(method, raw); requireThat(raw === "0x", "EXECUTION_ABI_INVALID"); },
    prepare: async simulateCall => {
      const minimumProfit = morpho ? d[4] : p.minProfitDebtToken;
      if (noSwap) return { data: candidate.data, minimumProfit, slippageLoss: 0n, quoteEvidence: { kind: "SAME_ASSET_NO_SWAP" } };
      // Establish the executor's actual spend first; minCollateralSeized is only
      // a lower bound. Missing/ambiguous logs HOLD, never fall back to that bound.
      const preliminary = await simulateCall({ to: executor, data: candidate.data });
      iface.decodeFunctionResult(method, preliminary.returnData);
      requireThat(preliminary.returnData === "0x", "EXECUTION_ABI_INVALID");
      const input = actualInput(preliminary.logs);
      const call = useCurve ? { to: CURVE, data: CURVE_IFACE.encodeFunctionData("get_dy", [1, 0, input]) }
        : { to: QUOTER_V2, data: QUOTER_IFACE.encodeFunctionData("quoteExactInput", [quotePath, input]) };
      const qIface = useCurve ? CURVE_IFACE : QUOTER_IFACE, qMethod = useCurve ? "get_dy" : "quoteExactInput";
      const raw = (await simulateCall(call)).returnData, decoded = qIface.decodeFunctionResult(qMethod, raw), quote = decoded[0];
      requireThat(qIface.encodeFunctionResult(qMethod, decoded).toLowerCase() === raw.toLowerCase() && quote > 0n, "NEXT_BLOCK_QUOTE_INVALID");
      const floor = (quote * 9950n + 9999n) / 10000n, original = morpho ? d[5] : p.minDebtTokenOut;
      const minimum = original > floor ? original : floor;
      requireThat(minimum <= quote && minimum * 10000n >= quote * 9950n, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
      // Only tighten output bounds. Borrower, amount, market, route and profit floor remain exactly validated above.
      const data = morpho ? MORPHO_EXEC_IFACE.encodeFunctionData("execute", [d[0], d[1], d[2], d[3], d[4], minimum, d[6], d[7]])
        : UNIFIED_IFACE.encodeFunctionData("executeMorpho", [d[0], { ...p.toObject(), minDebtTokenOut: minimum }]);
      return { data, minimumProfit, slippageLoss: quote - minimum,
        quoteEvidence: { context: candidate.nextBlockContext, inputRaw: input.toString(), outputRaw: quote.toString(),
          inputToken: collateral, inputRecipient: recipient, preliminaryCalldataHash: keccak256(candidate.data),
          minOutputRaw: minimum.toString(), maxSlippageBps: 50, quoteCalldataHash: keccak256(call.data) } };
    },
  };
}
function validateForecastBase(batches, candidate, now, { readFile = fs.readFileSync } = {}) {
  const primaryCaps = validateAuthorization(batches[0], now), morphoCaps = validateMorphoAuthorization(batches[1], now);
  const executor = candidate.executor || DEPLOYED_EXECUTOR;
  if (executor === MORPHO_EXECUTOR) {
    requireThat(candidate.kind === "MORPHO_BLUE_M1" || candidate.kind === "MORPHO_BLUE_WSTETH", "NEXT_BLOCK_SCOPE_NOT_APPROVED");
    requireThat(candidate.kind !== "MORPHO_BLUE_M1", "M1_LIVE_EVIDENCE_REQUIRED");
    if (candidate.kind !== "MORPHO_BLUE_M1") {
      const marketId = canonicalPosition(candidate).split(":")[3];
      requireThat(batches[1].targetWhales?.some(t => t.borrower?.toLowerCase() === candidate.borrower && t.executor?.toLowerCase() === executor &&
        t.marketId?.toLowerCase() === marketId), "NEXT_BLOCK_SCOPE_NOT_APPROVED");
    }
    return morphoCaps;
  }
  requireThat(executor === DEPLOYED_EXECUTOR && batches[0].targets.some(t => t.address?.toLowerCase() === candidate.target), "NEXT_BLOCK_SCOPE_NOT_APPROVED");
  const p = UNIFIED_IFACE.decodeFunctionData("executeMorpho", candidate.data)[1];
  requireThat(batches[1].targetWhales?.some(t => t.borrower?.toLowerCase() === candidate.borrower && t.executor?.toLowerCase() === executor &&
    (t.pool || t.spoke)?.toLowerCase() === candidate.target && t.debtToken?.toLowerCase() === p.debtToken.toLowerCase() &&
    t.collateralToken?.toLowerCase() === p.collateralToken.toLowerCase()), "NEXT_BLOCK_SCOPE_NOT_APPROVED");
  return primaryCaps;
}
function createPhaseTimings({ now = Date.now, monotonic = () => performance.now() } = {}) {
  const start = monotonic(), phases = { acquisition: null, focusedM1Collection: null, admission: null,
    preparation: { source: null, runtime: null, state: null, feeds: null, variants: null }, broadCollection: null }, boundaries = [];
  const bounded = ms => Math.round(Math.max(0, Math.min(86400000, ms)) * 1000) / 1000;
  const boundary = (phase, edge, pin) => {
    if (boundaries.length < 24) boundaries.push({ phase, edge, elapsedMs: bounded(monotonic() - start),
      parentAgeMs: pin ? now() - pin.timestamp * 1000 : null, childHeadroomMs: pin ? (pin.timestamp + 12) * 1000 - now() : null });
  };
  return {
    begin(name, pin) {
      const preparation = Object.hasOwn(phases.preparation, name), target = preparation ? phases.preparation : phases;
      requireThat(Object.hasOwn(target, name) && name !== "preparation", "TIMING_PHASE_INVALID");
      const began = monotonic(); boundary(name, "start", pin); let ended = false;
      return (endPin = pin) => { if (!ended) { ended = true; target[name] = bounded(monotonic() - began); boundary(name, "end", endPin); } };
    },
    snapshot() { return { ...phases, preparation: { ...phases.preparation }, total: bounded(monotonic() - start), boundaries: [...boundaries] }; },
  };
}
const CURRENT_2K_ID = "target2K_AaveV3_WETH_WETH_0x7a05";
const CURRENT_2L_ID = "target2L_AaveV3_WETH_WETH_0xd185";
const CURRENT_2K_2L_PLANS = Object.freeze([
  Object.freeze({ id: CURRENT_2K_ID, rank: "#2K", borrower: "0x7a0575018b57cb64434fcd794f4f0c624fd0fbd3", flash: 5400000000000000000n, floor: 10000000000000000n }),
  Object.freeze({ id: CURRENT_2L_ID, rank: "#2L", borrower: "0xd185e7fafa5d75c7fcb3ff0844fe4c307d8fd57a", flash: 12000000000000000000n, floor: 100000000000000000n }),
]);
function current2K2LMaxSpend(argv) {
  const flag = "--current-2k-2l-max-spend-wei", code = "CURRENT_2K_2L_MAX_SPEND_INVALID";
  const matches = argv.filter(value => typeof value === "string" && (value === flag || value.startsWith(flag + "=")));
  if (!matches.length) return null;
  const index = argv.indexOf(flag), value = argv[index + 1];
  requireThat(argv.includes("--current-only-2k-2l") && matches.length === 1 && index >= 0 &&
    !argv.some(value => typeof value === "string" && (value === "--current-only-2k" || value === "--current-2k-max-spend-wei" || value.startsWith("--current-2k-max-spend-wei="))) &&
    typeof value === "string" && value.length <= 78 && /^[1-9][0-9]*$/.test(value), code);
  const ceiling = BigInt(value);
  requireThat(ceiling < (1n << 256n), code);
  return ceiling;
}
function current2K2LCaps(caps, ceiling) {
  if (ceiling === null) return caps;
  requireThat(ceiling <= caps.spendCap, "CURRENT_2K_2L_MAX_SPEND_EXCEEDS_AUTHORIZATION");
  return { ...caps, spendCap: ceiling };
}
function currentOnly2K2LMode(argv) {
  const flag = "--current-only-2k-2l", enabled = argv.includes(flag), code = "CURRENT_2K_2L_MODE_CONFLICT";
  const matches = argv.filter(value => typeof value === "string" && (value === flag || value.startsWith(flag + "=")));
  requireThat(matches.length <= 1 && matches.every(value => value === flag), code);
  requireThat(!enabled || !argv.some(value => ["--current-only-2k", "--current-2k-max-spend-wei", "--m1-only", "--next-block", "--measure-only",
    "--reuse-qualified-pair", "--m1-hot-path-v2", "--m1-ws-heads", "--m1-capability-v1", "--m32-only", "--m32-warm-watch"].includes(value) ||
    typeof value === "string" && (value.startsWith("--current-only-2k=") || value.startsWith("--current-2k-max-spend-wei="))), code);
  current2K2LMaxSpend(argv);
  return enabled;
}
function current2K2LStatusFile(file = CURRENT_2K_2L_STATUS_FILE) {
  requireThat(typeof file === "string" && ![STATUS_FILE, OBSERVATION_FILE].some(protectedFile =>
    path.resolve(file).toLowerCase() === path.resolve(protectedFile).toLowerCase()), "CURRENT_2K_2L_STATUS_PATH_CONFLICT");
  return file;
}
function currentTwoK2LStatus(status, pin) {
  const code = "CURRENT_2K_2L_EVIDENCE_REQUIRED", rows = status.targets;
  requireThat(rows && typeof rows === "object" && !Array.isArray(rows) && Object.keys(rows).length === 2 &&
    CURRENT_2K_2L_PLANS.every(plan => Object.hasOwn(rows, plan.id)), code);
  const targets = {};
  for (const { id, rank, borrower, flash, floor } of CURRENT_2K_2L_PLANS) {
    const row = rows[id], monitor = row?.observationKind === "READ_ONLY_MONITOR";
    const matches = (value, expected) => typeof value === "string" && value.toLowerCase() === expected;
    requireThat(row && !Array.isArray(row) && matches(row.user, borrower) && matches(row.pool, POOL) && row.chainId === 1 &&
      (row.rank === undefined || row.rank === rank) && (row.id === undefined || row.id === id) && (row.targetId === undefined || row.targetId === id) &&
      [["borrower", borrower], ["target", POOL], ["marketId", POOL], ["debtToken", WETH], ["collateralToken", WETH],
        ["executor", DEPLOYED_EXECUTOR], ["deployedExecutor", DEPLOYED_EXECUTOR], ["liquidatorAddress", DEPLOYED_EXECUTOR]]
        .every(([field, expected]) => row[field] === undefined || matches(row[field], expected)) &&
      typeof row.liquidatableNow === "boolean" && Number.isFinite(row.debtUsd) && row.debtUsd > 0 &&
      Number.isFinite(row.healthFactor) && row.healthFactor > 0 && (row.liquidatableNow ? row.healthFactor <= 1 : row.healthFactor >= 1) &&
      nextExecution.activePosition(row) && row.retained !== true && (row.inactive === undefined || row.inactive === false) &&
      (row.positionStatus === undefined || row.positionStatus === "OPEN") && (row.debtReadStatus === undefined || row.debtReadStatus === "COMPLETE") &&
      (row.debtRaw === undefined || typeof row.debtRaw === "string" && /^[0-9]+$/.test(row.debtRaw) && BigInt(row.debtRaw) > 0n) &&
      (row.observationKind === undefined || monitor) && (row.observationOnly === false || monitor) &&
      row.observationStatus === "COMPLETE" && row.refreshStatus === "COMPLETE" &&
      row.observationBlock === pin.number && matches(row.observationHash, pin.hash.toLowerCase()) && row.observationTimestamp === pin.timestamp &&
      (monitor ? row.executableNow === false && row.eligibleForPreflight === row.liquidatableNow : row.executableNow === row.liquidatableNow), code);
    const zero = "0x0000000000000000000000000000000000000000";
    const exact = UNIFIED_IFACE.encodeFunctionData("executeMorpho", [flash, {
      isAaveV3: true, target: POOL, borrower, debtToken: WETH, collateralToken: WETH,
      collateralReserveId: 0, debtReserveId: 0, minCollateralSeized: 0, swapKind: 0, swapTarget: zero, swapSpender: zero,
      uniFee: 0, curveI: 0, curveJ: 0, minDebtTokenOut: 0, minProfitDebtToken: floor,
    }]);
    // Healthy observations must bind the same complete fixed plan as eligible ones.
    requireThat(typeof row.readyExecuteMorphoCalldata === "string" && row.readyExecuteMorphoCalldata.toLowerCase() === exact,
      "CURRENT_2K_2L_CALLDATA_INVALID");
    const { nextBlockForecast, ...current } = row;
    targets[id] = current;
  }
  return { ...status, targets };
}
function current2KMaxSpend(argv) {
  const flag = "--current-2k-max-spend-wei", code = "CURRENT_2K_MAX_SPEND_INVALID";
  const matches = argv.filter(value => typeof value === "string" && (value === flag || value.startsWith(flag + "=")));
  if (!matches.length) return null;
  const index = argv.indexOf(flag), value = argv[index + 1];
  requireThat(argv.includes("--current-only-2k") && matches.length === 1 && index >= 0 &&
    typeof value === "string" && value.length <= 78 && /^[1-9][0-9]*$/.test(value), code);
  const ceiling = BigInt(value);
  requireThat(ceiling < (1n << 256n), code);
  return ceiling;
}
function current2KCaps(caps, ceiling) {
  if (ceiling === null) return caps;
  requireThat(ceiling <= caps.spendCap, "CURRENT_2K_MAX_SPEND_EXCEEDS_AUTHORIZATION");
  return { ...caps, spendCap: ceiling }; // Local budget view only; never mutate or replace the approval.
}
function currentOnly2KMode(argv) {
  current2KMaxSpend(argv); // Reject malformed/unscoped budgets before any special dispatch or dependencies.
  const enabled = argv.includes("--current-only-2k");
  requireThat(!enabled || !argv.some(flag => ["--m1-only", "--next-block", "--measure-only", "--reuse-qualified-pair",
    "--m1-hot-path-v2", "--m1-ws-heads", "--m1-capability-v1", "--m32-only", "--m32-warm-watch"].includes(flag)), "CURRENT_2K_MODE_CONFLICT");
  return enabled;
}
function currentTwoKStatus(status, pin) {
  const row = status.targets?.[CURRENT_2K_ID], code = "CURRENT_2K_EVIDENCE_REQUIRED";
  const monitor = row?.observationKind === "READ_ONLY_MONITOR";
  // The producer derives liquidatableNow from positive debt and raw HF. Require
  // its explicit boolean plus present, consistent displays, never mere absence
  // of a nomination. Display USD/HF values are not execution-profit evidence.
  requireThat(row && !Array.isArray(row) && row.user?.toLowerCase() === "0x7a0575018b57cb64434fcd794f4f0c624fd0fbd3" &&
    row.pool?.toLowerCase() === POOL && typeof row.liquidatableNow === "boolean" &&
    Number.isFinite(row.debtUsd) && row.debtUsd > 0 && Number.isFinite(row.healthFactor) && row.healthFactor > 0 &&
    (row.liquidatableNow ? row.healthFactor <= 1 : row.healthFactor >= 1) &&
    nextExecution.activePosition(row) && row.retained !== true &&
    (row.inactive === undefined || row.inactive === false) && (row.positionStatus === undefined || row.positionStatus === "OPEN") &&
    (row.debtReadStatus === undefined || row.debtReadStatus === "COMPLETE") &&
    (row.debtRaw === undefined || typeof row.debtRaw === "string" && /^[0-9]+$/.test(row.debtRaw) && BigInt(row.debtRaw) > 0n) &&
    (row.observationKind === undefined || monitor) && (row.observationOnly === false || monitor) &&
    [row.observationStatus, row.refreshStatus].every(value => value === undefined || value === "COMPLETE") &&
    typeof row.readyExecuteMorphoCalldata === "string" && /^0x[0-9a-f]+$/i.test(row.readyExecuteMorphoCalldata), code);
  if (monitor) {
    // Canonical observations are nonauthorizing (including observationOnly:true).
    // Healthy rows have eligibleForPreflight:false; retain their provenance gate.
    requireThat(row.observationStatus === "COMPLETE" && row.refreshStatus === "COMPLETE" &&
      row.chainId === 1 && row.observationBlock === pin.number && row.observationHash?.toLowerCase() === pin.hash.toLowerCase() &&
      row.observationTimestamp === pin.timestamp && row.executableNow === false && row.eligibleForPreflight === row.liquidatableNow, code);
  } else requireThat(row.executableNow === row.liquidatableNow, code);
  const { nextBlockForecast, ...current } = row;
  return { ...status, targets: { [CURRENT_2K_ID]: current } };
}
function parseRunnerMode(argv, execute = false) {
  currentOnly2K2LMode(argv);
  currentOnly2KMode(argv);
  const measureOnly = argv.includes("--measure-only"), m1Only = argv.includes("--m1-only"), reuseQualifiedPair = argv.includes("--reuse-qualified-pair");
  const m1HotPathV2 = argv.includes("--m1-hot-path-v2"), wsHeads = argv.includes("--m1-ws-heads");
  const m1CapabilityV1 = argv.includes("--m1-capability-v1");
  requireThat(!measureOnly || !execute && !argv.some(flag => ["--execute", "--execute-if-liquidatable"].includes(flag)), "MEASURE_ONLY_EXECUTION_FORBIDDEN");
  requireThat(!reuseQualifiedPair || m1Only, "QUALIFIED_PAIR_REQUIRES_M1_ONLY");
  requireThat(!m1HotPathV2 || m1Only, "M1_HOT_PATH_REQUIRES_M1_ONLY");
  requireThat(!m1HotPathV2 || !reuseQualifiedPair, "M1_HOT_PATH_REUSE_CONFLICT");
  requireThat(!m1CapabilityV1 || m1HotPathV2 && m1Only, "M1_CAPABILITY_REQUIRES_HOT_PATH");
  requireThat(!wsHeads || m1HotPathV2, "M1_WS_REQUIRES_HOT_PATH");
  const mode = guard.parseMode([...argv, ...(execute ? ["--execute"] : [])], "--execute");
  return { ...mode, measureOnly, m1Only, reuseQualifiedPair, m1HotPathV2, m1CapabilityV1, wsHeads: wsHeads && !measureOnly,
    execute: measureOnly ? false : mode.execute, writeOut: !measureOnly && mode.writeOut };
}
const HOT_TIMING_PHASES = new Set(["poolQualification", "pairQualification", "futureQualification", "pinAcquisition", "m1Collection", "preparation",
  "source", "runtime", "state", "feeds", "variants", "lockWait", "finalValidation", "sign", "send", "sendAck", "receipt", "wsArrival"]);
function createHotPathTimings({ onTiming, now = Date.now, monotonic = () => performance.now() } = {}) {
  const events = [], pending = [];
  const observe = event => {
    try {
      if (!event || Object.keys(event).some(key => !["phase", "edge", "atMonoMs", "atWallMs", "durationMs"].includes(key)) ||
        !HOT_TIMING_PHASES.has(event.phase) || !["start", "end", "point"].includes(event.edge) ||
        !Number.isFinite(event.atMonoMs) || event.atMonoMs < 0 || !Number.isSafeInteger(event.atWallMs) || event.atWallMs < 0 ||
        (event.durationMs !== undefined && (!Number.isFinite(event.durationMs) || event.durationMs < 0))) return;
      const row = Object.freeze({ phase: event.phase, edge: event.edge, atMonoMs: event.atMonoMs, atWallMs: event.atWallMs,
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }) });
      if (events.length === 128) events.shift(); events.push(row);
      if (typeof onTiming === "function") { if (pending.length === 128) pending.shift(); pending.push(row); }
    } catch (_) {}
  };
  const flush = () => {
    // Capturing from B/C or the transport is synchronous but callback-free.
    // External observers run only after the pass ends, never between guards.
    for (const row of pending.splice(0)) { try { Promise.resolve(onTiming(row)).catch(() => {}); } catch (_) {} }
  };
  return { observe, flush, snapshot: () => events.slice(), begin(phase) {
    let start;
    try { start = monotonic(); observe({ phase, edge: "start", atMonoMs: start, atWallMs: now() }); } catch (_) {}
    return () => { try { const end = monotonic(); observe({ phase, edge: "end", atMonoMs: end, atWallMs: now(), durationMs: Math.max(0, end - start) }); } catch (_) {} };
  } };
}
// Ephemeral owner records only. A notification, injected result or JSON field
// cannot mint a continuation; only main registers the exact lease here.
const futureContinuationOwners = new WeakMap();
const m1V2Budgets = new WeakSet();
function createM1V2Budget({ wallNow = Date.now, monotonicNow = () => performance.now() } = {}) {
  let detection, last, binding, accepted, failure, childHeadroomMs = null;
  const latch = fn => {
    if (failure) throw failure;
    try { return fn(); } catch (error) { failure = error; throw error; }
  };
  const clock = () => {
    let wall, mono;
    try { mono = monotonicNow(); wall = wallNow(); } catch (_) { throw new guard.ExecutionError("M1_V2_CLOCK_INVALID"); }
    requireThat(Number.isSafeInteger(wall) && wall >= 0 && Number.isFinite(mono) && mono >= 0 &&
      (!last || wall >= last.wall && mono >= last.mono) &&
      // Only millisecond wall-clock quantization is tolerated, not clock drift.
      (!detection || Math.abs((wall - detection.wall) - (mono - detection.mono)) <= 2), "M1_V2_CLOCK_INVALID");
    last = { wall, mono }; return last;
  };
  detection = clock();
  const check = (lease, active, context) => latch(() => {
    requireThat(binding && lease === binding.lease && lease.current === binding.current &&
      JSON.stringify(lease.current.pin) === binding.pin && JSON.stringify(active.pin) === binding.pin &&
      (context ? active.nextBlock?.context && nextExecution.matchesContext(context, active.nextBlock.context) &&
        context.parentHash === binding.hash && context.parentNumber === binding.number && context.parentTimestamp === binding.timestamp &&
        context.timestamp === binding.timestamp + 12 : active === binding.current) &&
      (!accepted || active === accepted.active && JSON.stringify(context) === accepted.context), "M1_V2_BUDGET_BINDING_INVALID");
    const sample = clock(), elapsed = Math.max(sample.wall - detection.wall, sample.mono - detection.mono);
    childHeadroomMs = (context ? context.timestamp : binding.timestamp + 12) * 1000 -
      Math.max(sample.wall, detection.wall + (sample.mono - detection.mono));
    requireThat(accepted || elapsed <= 6000, "M1_V2_UNSIGNED_BUDGET_EXCEEDED");
    requireThat(childHeadroomMs >= 2000, "M1_V2_CHILD_HEADROOM_INSUFFICIENT");
    return { sample, elapsed };
  });
  const budget = Object.freeze({
    bind(lease) { latch(() => {
      requireThat(!binding && lease?.current?.pin && Number.isSafeInteger(lease.current.pin.timestamp), "M1_V2_BUDGET_BINDING_INVALID");
      const pin = lease.current.pin;
      binding = { lease, current: lease.current, pin: JSON.stringify(pin), timestamp: pin.timestamp, number: pin.number, hash: pin.hash };
      check(lease, lease.current, null);
    }); },
    assert(lease, active, context = null) { check(lease, active, context); },
    acceptUnsigned(lease, active, context = null) {
      const { sample, elapsed } = check(lease, active, context);
      latch(() => { requireThat(!accepted, "M1_V2_UNSIGNED_ALREADY_ACCEPTED");
        accepted = { ...sample, elapsed, active, context: JSON.stringify(context), headroom: childHeadroomMs }; });
    },
    assertDispatch(lease, active, context = null) {
      latch(() => requireThat(accepted, "M1_V2_UNSIGNED_NOT_ACCEPTED")); check(lease, active, context);
    },
    snapshot: () => ({ detectionWallMs: detection.wall, detectionMonoMs: detection.mono,
      unsignedReadyWallMs: accepted?.wall ?? null, unsignedReadyMonoMs: accepted?.mono ?? null,
      fullUnsignedElapsedMs: accepted?.elapsed ?? null, childHeadroomMs,
      unsignedReadyChildHeadroomMs: accepted?.headroom ?? null }),
  });
  m1V2Budgets.add(budget); return budget;
}
async function runPass({ execute = false, argv = [], batch, loadBatch,
  morphoBatch, loadMorphoBatch,
  pinned, checkOnce, now = Date.now, writeOut = false,
  statusFile, observationFile = OBSERVATION_FILE, signTransaction = guard.signWithProcessKey, secondarySendRawTransaction, executionOptions = {},
  amendmentReadFile = fs.readFileSync, m1ReadFile = fs.readFileSync, timings = createPhaseTimings({ now }), hotPathLease, hotPathTimings, onTiming,
  allowFutureContinuation = false, futureContinuationOwner, m1Budget }) {
  const currentOnly2K2L = currentOnly2K2LMode(argv), currentOnly2K = currentOnly2KMode(argv);
  const localMaxSpendWei = currentOnly2K2L ? current2K2LMaxSpend(argv) : current2KMaxSpend(argv);
  const scopedCaps = currentOnly2K2L ? current2K2LCaps : current2KCaps;
  requireThat(!currentOnly2K2L || allowFutureContinuation === false && futureContinuationOwner === undefined &&
    hotPathLease === undefined && hotPathTimings === undefined && m1Budget === undefined, "CURRENT_2K_2L_MODE_CONFLICT");
  requireThat(!currentOnly2K || allowFutureContinuation === false && futureContinuationOwner === undefined &&
    hotPathLease === undefined && hotPathTimings === undefined && m1Budget === undefined, "CURRENT_2K_MODE_CONFLICT");
  statusFile = currentOnly2K2L ? current2K2LStatusFile(statusFile) : statusFile === undefined ? STATUS_FILE : statusFile;
  const suppliedBatch = batch;
  if (loadBatch === undefined) loadBatch = () => suppliedBatch !== undefined ? suppliedBatch : readBatchWithRenewal(BUNDLE, BUNDLE_RENEWAL, now());
  if (loadMorphoBatch === undefined) loadMorphoBatch = () => morphoBatch !== undefined ? morphoBatch :
    (fs.existsSync(MORPHO_BUNDLE) ? readBatchWithRenewal(MORPHO_BUNDLE, MORPHO_BUNDLE_RENEWAL, now()) : null);
  const measureOnly = argv.includes("--measure-only"), m1Only = argv.includes("--m1-only");
  const m1HotPathV2 = argv.includes("--m1-hot-path-v2");
  const hotTiming = m1HotPathV2 ? hotPathTimings || createHotPathTimings({ now, onTiming }) : null;
  writeOut = writeOut && !argv.includes("--no-write") && !measureOnly;
  let compactTargets = [], partial = true, signedAttempt = false, candidateCount = 0;
  const requested = argv.includes("--next-block"); let qualifiedAtAcquisition = pinned.evidence?.nextBlockQualified === true;
  const owner = allowFutureContinuation === true && m1HotPathV2 && m1Only && requested && !measureOnly
    ? futureContinuationOwners.get(futureContinuationOwner) : null;
  const canContinue = owner?.lease === hotPathLease && typeof hotPathLease?.isFutureReady === "function";
  let retained = false, continuationPhase = false;
  let nextBlockContext = null, nextBlockHold = null, knownContextInvalid = false, lastHeadCheckAt = null, focusedError = null;
  const preflightFailures = [];
  const acquiredPin = JSON.stringify(pinned.pin);
  const assertBudget = () => { if (m1Budget) m1Budget.assert(hotPathLease, pinned, nextBlockContext); };
  const assertBase = () => { pinned.assertUsable(); requireThat(JSON.stringify(pinned.pin) === acquiredPin, "PIN_EVIDENCE_INVALIDATED"); assertBudget(); };
  if (m1HotPathV2 && typeof secondarySendRawTransaction === "function") {
    const secondary = secondarySendRawTransaction;
    secondarySendRawTransaction = signed => {
      // B invokes this inside its concurrent relay microtask. Check the active
      // facade here, not when constructing the callback or final validation.
      const active = pinned, context = nextBlockContext, assertDispatch = () => {
        active.assertUsable(); m1Budget.assertDispatch(hotPathLease, active, context);
      };
      assertDispatch(); return secondary(signed, assertDispatch);
    };
  }
  const originalSigner = signTransaction;
  signTransaction = async transaction => {
    if (m1HotPathV2) {
      m1Live.strictContext(pinned, nextBlockContext, now());
      m1Budget.acceptUnsigned(hotPathLease, pinned, nextBlockContext);
      // Reassert live trust after sampling budget clocks, synchronously at the
      // signer boundary; neither an awaited validation nor stable pin bytes suffice.
      m1Live.strictContext(pinned, nextBlockContext, now());
    }
    signedAttempt = true; return originalSigner(transaction);
  };
  const headChecked = () => { lastHeadCheckAt = new Date(now()).toISOString(); };
  const currentFuture = () => {
    if (nextBlockContext) {
      try { nextExecution.assertContext(pinned, nextBlockContext, now()); }
      catch (error) { knownContextInvalid = true; nextBlockHold = safeError(error); nextBlockContext = null; }
    }
    return nextBlockContext;
  };
  const snapshot = () => {
    currentFuture();
    let checked = now;
    if (m1Budget) checked = () => {
      try { const value = now(); if (Number.isSafeInteger(value) && value >= 0) return value; } catch (_) {}
      return m1Budget.snapshot().unsignedReadyWallMs ?? m1Budget.snapshot().detectionWallMs;
    };
    const child = pinned.nextBlock?.context, remaining = child ? child.timestamp * 1000 - checked() : null;
    return { ok: true, armed: execute && !measureOnly, mode: measureOnly ? "MEASURE_ONLY" : execute ? "EXECUTE_IF_LIQUIDATABLE" : "CHECK_ONLY",
      checkedAt: new Date(checked()).toISOString(), pin: pinned.pin, evidence: pinned.evidence, owner: MAIN_ACCOUNT, liquidatorAddress: DEPLOYED_EXECUTOR,
      partial, targets: compactTargets, candidateCount, phaseTimingsMs: timings.snapshot(),
      ...(m1HotPathV2 ? { timingEvents: hotTiming.snapshot(), ...(m1Budget ? { m1Budget: m1Budget.snapshot() } : {}) } : {}),
      ...(canContinue ? { passPhase: continuationPhase ? "FUTURE_CONTINUATION" : "CURRENT" } : {}),
      ...(m1Only ? { collectionScope: "M1_ONLY", partial: true } : {}),
      ...(currentOnly2K ? { collectionScope: "CURRENT_2K_ONLY" } : {}),
      ...(currentOnly2K2L ? { collectionScope: "CURRENT_2K_2L_ONLY" } : {}),
      ...(localMaxSpendWei !== null ? { localMaxSpendWei: localMaxSpendWei.toString() } : {}),
      partition: currentOnly2K2L ? "CURRENT_2K_2L_ONLY" : currentOnly2K ? "CURRENT_2K_ONLY" : m1Only ? "M1_ONLY" : shouldDelegateAaveV4ToDedicatedRunner(argv) ? "V3_ONLY" : "V3_AND_EXPLICIT_V4_WETH", morphoExecution: "M1_REQUIRES_FRESH_SOURCE_BOUND_LIVE_PROOF; PAXG_DISABLED",
      m1EvidenceGate: "STRICT_FIXED_PAIR; ORIGINAL_RUNTIME_SHA256; EXACT_FINAL_ENVELOPE; ACCRUED_STATE; ZERO_INVENTORY; POSITIVE_NET; CURRENT_CONTRACTUAL_OR_CHILD_SETTLEMENT_PROOF",
      profitConvention: "TOKEN_FLOOR_BEFORE_GAS; REALIZED_NET_UNKNOWN",
      ...(focusedError ? { focusedError } : {}), ...(preflightFailures.length ? { preflightFailures } : {}),
      ...(requested || measureOnly ? { nextBlock: { requested, qualifiedAtAcquisition, enabled: Boolean(nextBlockContext) && !measureOnly,
        deadlineValidAtCheck: remaining !== null && checked() >= child.parentTimestamp * 1000 && remaining > 0,
        knownContextInvalid, remainingMsAtCheck: remaining, lastHeadCheckAt, context: nextBlockContext, hold: nextBlockHold,
        m1EvidenceGate: "M1_LIVE_AMENDMENT_AND_STRICT_PAIR; HEALTHY_NEAR_PARENT_AND_UNHEALTHY_CHILD; FINAL_EXACT_SETTLEMENT_REQUIRED" } } : {}),
      ...(measureOnly ? { measurements: { futureQualification: "NOT_MEASURED_NONCE_FORBIDDEN", exactExecution: "NOT_MEASURED_NONCE_FORBIDDEN",
        ...(m1Only ? { fullPreparation: "NOT_MEASURED_NONCE_FORBIDDEN" } : {}) } } : {}) };
  };
  const finish = (fields = {}, fired = false) => {
    // Standalone callers own their collector; execution has ended here. Take
    // the telemetry snapshot after delivery so elapsed child context is not
    // advertised as still enabled. main delivers its shared collector later.
    if (m1HotPathV2 && !hotPathTimings) hotTiming.flush();
    const summary = { ...snapshot(), ...fields };
    if (writeOut) atomicJson(statusFile, summary);
    return { fired, summary };
  };
  const compact = status => Object.values(status.targets || {}).flat().filter(Boolean)
    .map(({ rank, user, bpsToLiquidation, inactive, positionStatus, debtReadStatus, debtRaw, nextBlockForecast }) =>
      ({ rank, user, bpsToLiquidation, inactive, positionStatus, debtReadStatus, debtRaw, nextBlockForecast }));
  const checkPin = status => requireThat(status.pin?.chainId === 1 && status.pin.hash?.toLowerCase() === pinned.pin.hash &&
    status.pin.number === pinned.pin.number && (status.pin.timestamp === undefined || status.pin.timestamp === pinned.pin.timestamp), "COLLECTOR_PIN_MISMATCH");
  const sendRawTransaction = async signed => {
    const [primary] = await Promise.allSettled([
      Promise.resolve().then(() => pinned.send(signed)),
      ...(typeof secondarySendRawTransaction === "function" ? [Promise.resolve().then(() => secondarySendRawTransaction(signed))] : []),
    ]);
    if (primary.status === "rejected") throw primary.reason;
    return primary.value;
  };
  try {
    parseRunnerMode(argv, execute);
    if (m1HotPathV2) requireThat(hotPathLease?.current === pinned && typeof hotPathLease.takeFuture === "function" &&
      typeof hotPathLease.cancelFuture === "function", "M1_HOT_PATH_LEASE_REQUIRED");
    requireThat(!m1HotPathV2 || (!execute && !m1Budget) || m1V2Budgets.has(m1Budget), "M1_V2_BUDGET_REQUIRED");
    requireThat(m1HotPathV2 || m1Budget === undefined, "M1_V2_BUDGET_UNEXPECTED");
    assertBudget();
    if ((execute || localMaxSpendWei !== null) && batch === undefined) batch = loadBatch();
    const caps = execute || localMaxSpendWei !== null ? scopedCaps(validateAuthorization(batch, now()), localMaxSpendWei) : null;
    if (requested && !measureOnly && !m1HotPathV2) {
      try {
        nextExecution.loadAuthorization({ readFile: amendmentReadFile, now: now() });
        nextExecution.assertContext(pinned, pinned.nextBlock?.context, now());
        await pinned.nextBlock.recheck(); headChecked(); nextBlockContext = pinned.nextBlock.context;
      } catch (error) { knownContextInvalid = true; nextBlockHold = safeError(error); }
    }
    const collect = checkOnce || require("./watch-top-whale-triggers.js").checkOnce;
    let focused, m1Candidate, endPhase;
    if (!currentOnly2K && !currentOnly2K2L) {
    endPhase = timings.begin("focusedM1Collection", pinned.pin);
    const endCollection = hotTiming?.begin("m1Collection");
    try {
      focused = await collect({ ...pinned.collectorOptions, writeOut: false, m1Only: true, now,
        pin: { ...pinned.pin, chainId: 1 }, nextBlockContext: currentFuture() });
      assertBase(); checkPin(focused);
      // An injected collector must not sneak unrelated rows into focused admission.
      focused = { ...focused, targets: { [m1Live.ID]: focused.targets?.[m1Live.ID] } };
      compactTargets = compact(focused).filter(row => !m1Only || row.user?.toLowerCase() === m1Live.BORROWER);
    } catch (error) {
      focusedError = safeError(error);
      preflightFailures.push({ targetId: m1Live.ID, reason: focusedError });
      if (m1Only) { focused = undefined; compactTargets = []; }
      assertBase();
    } finally { endPhase(); endCollection?.(); }
    endPhase = timings.begin("admission", pinned.pin);
    try {
      if (focused) m1Candidate = selectCandidates(focused, argv, { nextBlockContext: currentFuture() })[0];
      if (m1Candidate) {
        candidateCount++;
        m1Live.strictContext(pinned, m1Candidate.executionMode ? currentFuture() : null, now());
      }
    } catch (error) {
      assertBase(); preflightFailures.push({ targetId: m1Live.ID, reason: safeError(error) }); m1Candidate = null;
    } finally { endPhase(); }
    const admitFuture = async future => {
      try {
        requireThat(JSON.stringify(future.pin) === acquiredPin, "PIN_EVIDENCE_INVALIDATED");
        nextExecution.loadAuthorization({ readFile: amendmentReadFile, now: now() });
        nextExecution.assertContext(future, future.nextBlock?.context, now());
        await future.nextBlock.recheck(); headChecked();
        pinned = future; qualifiedAtAcquisition = true; nextBlockContext = future.nextBlock.context;
        const end = hotTiming.begin("m1Collection");
        try {
          const forecast = await collect({ ...future.collectorOptions, writeOut: false, m1Only: true, now,
            pin: { ...future.pin, chainId: 1 }, nextBlockContext });
          assertBase(); checkPin(forecast);
          focused = { ...forecast, targets: { [m1Live.ID]: forecast.targets?.[m1Live.ID] } };
          compactTargets = compact(focused).filter(item => item.user?.toLowerCase() === m1Live.BORROWER);
          // Never relabel a CURRENT nomination as child evidence.
          m1Candidate = selectCandidates(focused, argv, { nextBlockContext }).find(candidate => candidate.executionMode === "NEXT_BLOCK_PASSIVE");
          if (m1Candidate) { candidateCount++; m1Live.strictContext(future, nextBlockContext, now()); }
        } finally { end(); }
      } catch (error) {
        assertBase(); m1Candidate = null; nextBlockContext = null; knownContextInvalid = true; nextBlockHold = safeError(error);
        preflightFailures.push({ targetId: m1Live.ID, reason: safeError(error) });
      }
    };
    const executeFocused = async () => {
      if (execute && m1Candidate) {
        try {
          const receipt = await m1Live.executeM1({ candidate: m1Candidate, pinned, now, readFile: m1ReadFile,
            phase: name => timings.begin(name, pinned.pin), onHeadCheck: headChecked,
            ...(m1HotPathV2 ? { preparationMode: "parallel-v2", onTiming: hotTiming.observe, assertBudget,
              additionalSyncDispatchGuard: () => { pinned.assertUsable(); m1Budget.assertDispatch(hotPathLease, pinned, nextBlockContext); } } : {}),
            validateBase: (batches, time) => {
              requireThat(isDeepStrictEqual(loadBatch(), batches[0]) && isDeepStrictEqual(loadMorphoBatch(), batches[1]), "M1_LIVE_APPROVAL_REQUIRED");
              validateAuthorization(batches[0], time); return validateMorphoAuthorization(batches[1], time);
            }, signTransaction, secondarySendRawTransaction, executionOptions });
          return finish({ armed: !["SENT", "PREPARED", "UNCERTAIN"].includes(receipt.stage), execution: receipt }, true);
        } catch (error) {
          preflightFailures.push({ targetId: m1Live.ID, executionMode: m1Candidate.executionMode || "CURRENT", reason: safeError(error) });
          if (signedAttempt) return finish({ armed: false, reason: "SIGNED_ATTEMPT_ENDED_PASS" });
          assertBase();
          if (m1Candidate.executionMode === "NEXT_BLOCK_PASSIVE") {
            knownContextInvalid = true; nextBlockContext = null; nextBlockHold = safeError(error);
          }
        }
      }
      return null;
    };
    if (m1HotPathV2) {
      const row = focused?.targets?.[m1Live.ID];
      if (m1Candidate) hotPathLease.cancelFuture();
      else if (!measureOnly && requested && preflightFailures.length === 0 && nextExecution.activePosition(row) && row.liquidatableNow === false && row.hfUnderwaterNow !== true) {
        let admitted = true;
        if (canContinue) {
          // Retention requires explicit, successful ACTIVE/HEALTHY admission,
          // not absence of a CURRENT nomination or a rounded display HF.
          try {
            admitted = row.user?.toLowerCase() === m1Live.BORROWER && row.positionStatus === "OPEN" && row.inactive === false &&
              row.debtReadStatus === "COMPLETE" && uint(row.debtRaw) > 0n && uint(row.currentDebtRaw) > 0n &&
              uint(row.currentDebtRaw) <= uint(row.maxBorrowRaw);
            if (admitted) m1Live.strictContext(pinned, null, now());
          } catch (error) { admitted = false; assertBase(); preflightFailures.push({ targetId: m1Live.ID, reason: safeError(error) }); }
        }
        if (!admitted) hotPathLease.cancelFuture();
        else if (canContinue && !hotPathLease.isFutureReady()) {
          assertBase();
          const result = finish({ armed: false, futureContinuation: "WAITING" });
          focused = undefined; m1Candidate = null;
          let consumed = false;
          owner.resume = async () => {
            requireThat(!consumed && futureContinuationOwners.get(futureContinuationOwner) === owner, "M1_FUTURE_CONTINUATION_INVALID");
            consumed = true; continuationPhase = true; timings = createPhaseTimings({ now });
            // Do not carry CURRENT rows/nominations into this fresh forecast.
            focused = undefined; m1Candidate = null; compactTargets = []; candidateCount = 0;
            try {
              assertBase();
              const future = hotPathLease.takeFuture();
              if (!future) return finish({ armed: false, futureContinuation: "UNAVAILABLE" });
              await admitFuture(future);
              const executed = await executeFocused(); if (executed) return executed;
              assertBase(); return finish({ armed: false, ...(preflightFailures.length ? { reason: "NO_CANDIDATE_PASSED_PREFLIGHT" } : {}) });
            } catch (error) {
              knownContextInvalid = true; nextBlockContext = null;
              error.passSummary = finish({ ok: false, armed: false, mode: "BLOCKED", reason: safeError(error) }).summary;
              throw error;
            } finally { hotPathLease.cancelFuture(); }
          };
          retained = true; return result;
        } else {
          const future = hotPathLease.takeFuture(); if (future) await admitFuture(future);
        }
      } else hotPathLease.cancelFuture();
    }
    const executed = await executeFocused(); if (executed) return executed;
    // The M1 path has had its sole admission/preparation opportunity at this pin.
    // Unsigned holds may continue only while the original base pin is usable.
    assertBase();
    // Narrow collection only; every existing M1 execution gate still ran above.
    if (m1Only) return finish({ armed: false, ...(preflightFailures.length ? { reason: "NO_CANDIDATE_PASSED_PREFLIGHT" } : {}) });
    }
    endPhase = timings.begin("broadCollection", pinned.pin);
    let status;
    try {
    status = await collect({ ...pinned.collectorOptions, writeOut: false, includeExtendedDiscoveries: true, includeA4: true, includeA5: true, includeA6A7: true, includeM10M11: true, includeM7B: true, includeEulerYn: true, includeEulerExtended: true,
      ...(currentOnly2K || currentOnly2K2L ? { m1Only: false } : {}),
      nextBlockContext: currentFuture(),
      ...(!checkOnce ? { includeV3Whales: true, includeSparkWhales: true } : {}) }); assertBase();
    checkPin(status); requireThat(status.partial !== true, "BROAD_COLLECTION_PARTIAL");
    if (currentOnly2K) status = currentTwoKStatus(status, pinned.pin);
    if (currentOnly2K2L) {
      // The native collector is broad by contract. Project only that trusted
      // adapter; an injected scoped collector must itself return exactly two rows.
      if (!checkOnce) status = { ...status, targets: Object.fromEntries(CURRENT_2K_2L_PLANS.map(({ id }) => [id, status.targets?.[id]])) };
      status = currentTwoK2LStatus(status, pinned.pin);
    }
    compactTargets = [...(!status.targets?.[m1Live.ID] && focused ? compact(focused) : []), ...compact(status)]; partial = false;
    await pinned.recheck();
    if (currentFuture()) {
      try { await pinned.nextBlock.recheck(); headChecked(); }
      catch (error) { knownContextInvalid = true; nextBlockHold = safeError(error); nextBlockContext = null; assertBase(); }
    }
    } finally { endPhase(); }
    // Select only freshly collected rows, before legacy observation-file carry-forward.
    const unrelated = currentOnly2K || currentOnly2K2L ? status : { ...status, targets: { ...status.targets, [m1Live.ID]: undefined } };
    let candidates = selectCandidates(unrelated, argv, { nextBlockContext: currentFuture() });
    if (currentOnly2K) requireThat(candidates.length === (status.targets[CURRENT_2K_ID].liquidatableNow ? 1 : 0), "CURRENT_2K_EVIDENCE_REQUIRED");
    if (currentOnly2K2L) requireThat(candidates.length === CURRENT_2K_2L_PLANS.reduce((count, { id }) => count + Number(status.targets[id].liquidatableNow), 0) &&
      candidates.every(candidate => CURRENT_2K_2L_PLANS.some(({ id }) => id === candidate.id) && candidate.params?.isAaveV3 === true), "CURRENT_2K_2L_EVIDENCE_REQUIRED");
    candidateCount += candidates.length;
    // Dedicated failure/absence never falls back to the shared M2 executor and
    // never prevents unrelated candidates from continuing through their gates.
    const m32DedicatedHold = candidates.some(candidate => candidate.kind === "MORPHO_BLUE_M32");
    candidates = candidates.filter(candidate => {
      if (candidate.kind !== "MORPHO_BLUE_M32") return true;
      preflightFailures.push({ targetId: candidate.id, reason: "M32_DEDICATED_ONLY_REQUIRED" }); return false;
    });
    // Keep own status writes while leaving coordinator-owned observations untouched on request.
    if (writeOut && !currentOnly2K && !currentOnly2K2L && !argv.includes("--no-observation-write")) {
      if (!checkOnce && fs.existsSync(observationFile)) {
        try {
          const prev = JSON.parse(fs.readFileSync(observationFile, "utf8"));
          if (status.baseObservation?.status !== "COMPLETE" && prev?.baseObservation?.status === "COMPLETE") {
            status.baseObservation = { ...retainExecutorObservation(prev.baseObservation), status: "INCOMPLETE", reason: "EXECUTOR_OBSERVATION_RETAINED" };
          }
          for (const k of ["targetB0_Base_USDe_USDC", "extra_Base_USDe_Whales", "base_Morpho_Whales", "targetC9_AaveV4_weETH_WETH_0x9f46", "targetA11_AaveV4_USDe_USDC_0x5c43"]) {
            if (status.targets && status.targets[k] === undefined && prev?.targets?.[k] !== undefined) {
              status.targets[k] = retainExecutorObservation(prev.targets[k]);
            }
          }
        } catch (_) {}
      }
      atomicJson(observationFile, status);
    }
    if (m32DedicatedHold && candidates.length === 0) return finish({ armed: false, reason: "NO_CANDIDATE_PASSED_PREFLIGHT" });
    if (execute) {
      // CURRENT admission must precede reconciliation, which itself takes the
      // wallet lock. Token floors/returns do not prove liquid native proceeds.
      const hadCandidates = candidates.length > 0;
      assertBase();
      candidates = candidates.filter(candidate => {
        if (candidate.executionMode === "NEXT_BLOCK_PASSIVE") return true;
        try {
          requireVerifiedCurrentVariant(candidate);
          return true;
        } catch (error) {
          pinned.assertUsable(); preflightFailures.push({ targetId: candidate.id, reason: safeError(error) }); return false;
        }
      });
      if (hadCandidates && candidates.length === 0) return finish({ armed: false, reason: "NO_CANDIDATE_PASSED_PREFLIGHT" });
      await guard.reconcileWallet({ ...executionOptions, account: MAIN_ACCOUNT, receiptRpc: hash => pinned.receipt(hash) });
      scopedCaps(validateAuthorization(loadBatch(), now()), localMaxSpendWei);
    }
    if (!execute || candidates.length === 0) return finish(preflightFailures.length ? { armed: false, reason: "NO_CANDIDATE_PASSED_PREFLIGHT" } : {});
    for (const candidate of candidates) {
      if (candidate.executionMode === "NEXT_BLOCK_PASSIVE" && !currentFuture()) continue;
      if (candidate.executionMode === "NEXT_BLOCK_PASSIVE") {
        try {
          const receipt = await nextExecution.executeForecast({ candidate, pinned, route: forecastRoute(candidate),
            validateBase: validateForecastBase,
            readFile: amendmentReadFile, now, signTransaction, secondarySendRawTransaction, executionOptions });
          const out = { ...snapshot(), armed: !["SENT", "PREPARED", "UNCERTAIN"].includes(receipt.stage), execution: receipt };
          if (writeOut) atomicJson(statusFile, out); return { fired: true, summary: out };
        } catch (error) {
          // A durable PREPARED/SENT/UNCERTAIN record is still an indefinite wallet blocker.
          preflightFailures.push({ targetId: candidate.id, executionMode: candidate.executionMode, reason: safeError(error) });
          if (signedAttempt) return finish({ armed: false, reason: "SIGNED_ATTEMPT_ENDED_PASS" });
          pinned.assertUsable();
          knownContextInvalid = true; nextBlockContext = null; nextBlockHold = safeError(error);
          continue;
        }
      }
      if (candidate.kind === "MORPHO_BLUE_M2") {
        const mBatch = loadMorphoBatch(), mCaps = validateMorphoAuthorization(mBatch, now());
        requireThat(mBatch.targets.some(t => t.address?.toLowerCase() === M2_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
        let fees, chosenVariant, lastErr;
        for await (let variant of buildScaledM2VariantsWithKyber(candidate)) {
          try {
            requireVerifiedCurrentProfit(variant.conservativeProfitBeforeGasWei);
            if (!variant.skipCurveQuote) {
              const quote = variant.swapPath
                ? QUOTER_IFACE.decodeFunctionResult("quoteExactInput", await pinned.call({ to: QUOTER_V2,
                  data: QUOTER_IFACE.encodeFunctionData("quoteExactInput", [variant.swapPath, variant.seizedAssets]) }))[0]
                : CURVE_IFACE.decodeFunctionResult("get_dy", await pinned.call({ to: CURVE_REUSD_USDC,
                  data: CURVE_IFACE.encodeFunctionData("get_dy", [0, 1, variant.seizedAssets]) }))[0];
              if (variant !== candidate && variant.minOutUsdc * 10000n < quote * 9800n) {
                const minOut = (quote * 9800n + 9999n) / 10000n;
                const decoded = M2_EXEC_IFACE.decodeFunctionData("execute", variant.data);
                const swapData = scaleInnerSwapData(decoded[1], 1n, 1n, minOut);
                requireThat(swapData !== null, "EXECUTION_ROUTE_NOT_ALLOWED");
                variant = { ...variant, data: M2_EXEC_IFACE.encodeFunctionData("execute", [decoded[0], swapData]), minOutUsdc: minOut };
              }
              requireThat(variant.minOutUsdc * 10000n <= quote * 10000n && variant.minOutUsdc * 10000n >= quote * 9800n, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
            }
            const call = { from: MAIN_ACCOUNT, to: M2_EXECUTOR, data: variant.data };
            const simulation = await pinned.call(call); M2_EXEC_IFACE.decodeFunctionResult("execute", simulation);
            requireThat(simulation === "0x", "EXECUTION_ABI_INVALID");
            fees = guard.buildFees(await pinned.estimateGas(call), pinned.pin.baseFeePerGas, mCaps, variant.conservativeProfitBeforeGasWei);
            chosenVariant = variant; lastErr = null; break;
          } catch (error) { pinned.assertUsable(); lastErr = error; }
        }
        if (!chosenVariant) { preflightFailures.push({ targetId: candidate.id, reason: safeError(lastErr) }); continue; }
        const validate = async () => {
          const initial = loadMorphoBatch(); validateMorphoAuthorization(initial, now());
          requireThat(initial.targets.some(t => t.address?.toLowerCase() === M2_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
          await pinned.recheck();
          const current = loadMorphoBatch(), currentCaps = validateMorphoAuthorization(current, now());
          requireThat(current.targets.some(t => t.address?.toLowerCase() === M2_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
          return currentCaps;
        };
        const receipt = await guard.executeGuarded({ ...executionOptions, now, account: MAIN_ACCOUNT,
          intent: { targetId: candidate.id, to: M2_EXECUTOR, profitToken: candidate.profitToken || USDC, pinHash: pinned.pin.hash,
            simulatedProfitBeforeGasRaw: null, minProfitBeforeGasRaw: chosenVariant.minProfitUsdc.toString() },
          prepare: async () => { await validate(); const nonce = Number(uint(await pinned.nonce(MAIN_ACCOUNT)));
            return { transaction: { type: 2, chainId: 1, nonce, to: M2_EXECUTOR, data: chosenVariant.data, value: 0n, ...fees }, caps: await validate(),
              conservativeProfitBeforeGasWei: chosenVariant.conservativeProfitBeforeGasWei }; },
          validate, signTransaction, sendRawTransaction, receiptRpc: (hash, timeoutMs) => pinned.receipt(hash, timeoutMs) });
        const out = { ...snapshot(), armed: !["SENT", "PREPARED", "UNCERTAIN"].includes(receipt.stage), execution: receipt };
        if (writeOut) atomicJson(statusFile, out); return { fired: true, summary: out };
      }
      if (candidate.kind === "MORPHO_BLUE_M7") {
        const mBatch = loadMorphoBatch(), mCaps = validateMorphoAuthorization(mBatch, now());
        requireThat(mBatch.targets.some(t => t.address?.toLowerCase() === M7_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
        const call = { from: MAIN_ACCOUNT, to: M7_EXECUTOR, data: candidate.data }; let fees;
        try {
          const quote = CURVE_IFACE.decodeFunctionResult("get_dy", await pinned.call({ to: CURVE_MSETH_WETH,
            data: CURVE_IFACE.encodeFunctionData("get_dy", [1, 0, candidate.seizedAssets]) }))[0];
          requireThat(quote > 0n, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
          const simulation = await pinned.call(call); M7_EXEC_IFACE.decodeFunctionResult("execute", simulation);
          requireThat(simulation === "0x", "EXECUTION_ABI_INVALID");
          fees = guard.buildFees(await pinned.estimateGas(call), pinned.pin.baseFeePerGas, mCaps);
        } catch (error) { pinned.assertUsable(); preflightFailures.push({ targetId: candidate.id, reason: safeError(error) }); continue; }
        const validate = async () => {
          const initial = loadMorphoBatch(); validateMorphoAuthorization(initial, now());
          requireThat(initial.targets.some(t => t.address?.toLowerCase() === M7_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
          await pinned.recheck();
          const current = loadMorphoBatch(), currentCaps = validateMorphoAuthorization(current, now());
          requireThat(current.targets.some(t => t.address?.toLowerCase() === M7_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
          return currentCaps;
        };
        const receipt = await guard.executeGuarded({ ...executionOptions, now, account: MAIN_ACCOUNT,
          intent: { targetId: candidate.id, to: M7_EXECUTOR, profitToken: MSETH, pinHash: pinned.pin.hash,
            simulatedProfitBeforeGasRaw: null, minProfitBeforeGasRaw: candidate.minProfitWeth.toString() },
          prepare: async () => { await validate(); const nonce = Number(uint(await pinned.nonce(MAIN_ACCOUNT)));
            return { transaction: { type: 2, chainId: 1, nonce, to: M7_EXECUTOR, data: candidate.data, value: 0n, ...fees }, caps: await validate(),
              conservativeProfitBeforeGasWei: candidate.conservativeProfitBeforeGasWei }; },
          validate, signTransaction, sendRawTransaction, receiptRpc: (hash, timeoutMs) => pinned.receipt(hash, timeoutMs) });
        const out = { ...snapshot(), armed: !["SENT", "PREPARED", "UNCERTAIN"].includes(receipt.stage), execution: receipt };
        if (writeOut) atomicJson(statusFile, out); return { fired: true, summary: out };
      }
      if (candidate.kind === "CURVE_BUY_VAULT_REDEEM_YN") {
        const mBatch = loadMorphoBatch(), mCaps = validateMorphoAuthorization(mBatch, now());
        requireThat(mBatch.targets.some(t => t.address?.toLowerCase() === YN_ARB_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
        let fees, chosenVariant, lastErr;
        const basePlan = YN_ARB_EXEC_IFACE.decodeFunctionData("execute", candidate.data)[0].toObject();
        for (const variant of buildYnVariantSizes(candidate)) {
          try {
            const { mult, flashAmount: flashAmt } = variant;
            const conservativeProfitBeforeGasWei = requireVerifiedCurrentProfit(variant.conservativeProfitBeforeGasWei);
            const quote = CURVE_IFACE.decodeFunctionResult("get_dy", await pinned.call({ to: CURVE_YNETHX_WETH,
              data: CURVE_IFACE.encodeFunctionData("get_dy", [1, 0, flashAmt]) }))[0];
            let variantData = candidate.data, variantMinProfit = candidate.minProfitWeth;
            if (mult === 1n) {
              requireThat(quote >= candidate.minSharesOut, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
            } else {
              const minShares = (quote * 9950n) / 10000n;
              variantMinProfit = candidate.minProfitWeth * mult;
              variantData = YN_ARB_EXEC_IFACE.encodeFunctionData("execute", [{
                ...basePlan,
                flashAmount: flashAmt,
                minSharesOut: minShares,
                minLoanOut: flashAmt + variantMinProfit,
              }]);
            }
            const call = { from: MAIN_ACCOUNT, to: YN_ARB_EXECUTOR, data: variantData };
            const simulation = await pinned.call(call); YN_ARB_EXEC_IFACE.decodeFunctionResult("execute", simulation);
            requireThat(simulation === "0x", "EXECUTION_ABI_INVALID");
            fees = guard.buildFees(await pinned.estimateGas(call), pinned.pin.baseFeePerGas, mCaps, conservativeProfitBeforeGasWei);
            chosenVariant = { data: variantData, minProfitRaw: variantMinProfit, conservativeProfitBeforeGasWei }; lastErr = null; break;
          } catch (error) { pinned.assertUsable(); lastErr = error; }
        }
        if (!chosenVariant) { preflightFailures.push({ targetId: candidate.id, reason: safeError(lastErr) }); continue; }
        const validate = async () => {
          const initial = loadMorphoBatch(); validateMorphoAuthorization(initial, now());
          requireThat(initial.targets.some(t => t.address?.toLowerCase() === YN_ARB_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
          await pinned.recheck();
          const current = loadMorphoBatch(), currentCaps = validateMorphoAuthorization(current, now());
          requireThat(current.targets.some(t => t.address?.toLowerCase() === YN_ARB_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
          return currentCaps;
        };
        const receipt = await guard.executeGuarded({ ...executionOptions, now, account: MAIN_ACCOUNT,
          intent: { targetId: candidate.id, to: YN_ARB_EXECUTOR, profitToken: WETH, pinHash: pinned.pin.hash,
            simulatedProfitBeforeGasRaw: null, minProfitBeforeGasRaw: chosenVariant.minProfitRaw.toString() },
          prepare: async () => { await validate(); const nonce = Number(uint(await pinned.nonce(MAIN_ACCOUNT)));
            return { transaction: { type: 2, chainId: 1, nonce, to: YN_ARB_EXECUTOR, data: chosenVariant.data, value: 0n, ...fees }, caps: await validate(),
              conservativeProfitBeforeGasWei: chosenVariant.conservativeProfitBeforeGasWei }; },
          validate, signTransaction, sendRawTransaction, receiptRpc: (hash, timeoutMs) => pinned.receipt(hash, timeoutMs) });
        const out = { ...snapshot(), armed: !["SENT", "PREPARED", "UNCERTAIN"].includes(receipt.stage), execution: receipt };
        if (writeOut) atomicJson(statusFile, out); return { fired: true, summary: out };
      }
      if (candidate.kind === "EULER_EVK_E1") {
        const mBatch = loadMorphoBatch(), mCaps = validateMorphoAuthorization(mBatch, now());
        requireThat(mBatch.targets.some(t => t.address?.toLowerCase() === EULER_EVK_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
        const call = { from: MAIN_ACCOUNT, to: EULER_EVK_EXECUTOR, data: candidate.data }; let fees;
        try {
          const simulation = await pinned.call(call); EULER_EVK_EXEC_IFACE.decodeFunctionResult("execute", simulation);
          requireThat(simulation === "0x", "EXECUTION_ABI_INVALID");
          fees = guard.buildFees(await pinned.estimateGas(call), pinned.pin.baseFeePerGas, mCaps);
        } catch (error) { pinned.assertUsable(); preflightFailures.push({ targetId: candidate.id, reason: safeError(error) }); continue; }
        const validate = async () => {
          const initial = loadMorphoBatch(); validateMorphoAuthorization(initial, now());
          requireThat(initial.targets.some(t => t.address?.toLowerCase() === EULER_EVK_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
          await pinned.recheck();
          const current = loadMorphoBatch(), currentCaps = validateMorphoAuthorization(current, now());
          requireThat(current.targets.some(t => t.address?.toLowerCase() === EULER_EVK_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
          return currentCaps;
        };
        const receipt = await guard.executeGuarded({ ...executionOptions, now, account: MAIN_ACCOUNT,
          intent: { targetId: candidate.id, to: EULER_EVK_EXECUTOR, profitToken: candidate.profitToken || RLUSD, pinHash: pinned.pin.hash,
            simulatedProfitBeforeGasRaw: null, minProfitBeforeGasRaw: (candidate.minProfitRaw ?? candidate.minProfitRlusd).toString() },
          prepare: async () => { await validate(); const nonce = Number(uint(await pinned.nonce(MAIN_ACCOUNT)));
            return { transaction: { type: 2, chainId: 1, nonce, to: EULER_EVK_EXECUTOR, data: candidate.data, value: 0n, ...fees }, caps: await validate(),
              conservativeProfitBeforeGasWei: candidate.conservativeProfitBeforeGasWei }; },
          validate, signTransaction, sendRawTransaction, receiptRpc: (hash, timeoutMs) => pinned.receipt(hash, timeoutMs) });
        const out = { ...snapshot(), armed: !["SENT", "PREPARED", "UNCERTAIN"].includes(receipt.stage), execution: receipt };
        if (writeOut) atomicJson(statusFile, out); return { fired: true, summary: out };
      }
      if (candidate.kind === "UNIV4_FLASH_LIQUIDATION") {
        const mBatch = loadMorphoBatch(), mCaps = validateMorphoAuthorization(mBatch, now());
        requireThat(mBatch.targets.some(t => t.address?.toLowerCase() === UNIV4_FLASH_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
        let fees, simulatedProfit, chosenVariant, lastErr;
        for (const variant of buildScaledUniV4Variants(candidate.data, candidate.minProfitRaw, candidate)) {
          try {
            requireVerifiedCurrentProfit(variant.conservativeProfitBeforeGasWei);
            const call = { from: MAIN_ACCOUNT, to: UNIV4_FLASH_EXECUTOR, data: variant.data };
            const simulation = await pinned.call(call);
            const decoded = UNIV4_FLASH_EXEC_IFACE.decodeFunctionResult("execute", simulation);
            requireThat(UNIV4_FLASH_EXEC_IFACE.encodeFunctionResult("execute", decoded).toLowerCase() === simulation.toLowerCase(), "EXECUTION_ABI_INVALID");
            simulatedProfit = uint(decoded[0]);
            requireThat(simulatedProfit >= variant.minProfitRaw, "SIMULATED_PROFIT_BELOW_MIN");
            fees = guard.buildFees(await pinned.estimateGas(call), pinned.pin.baseFeePerGas, mCaps, variant.conservativeProfitBeforeGasWei);
            chosenVariant = variant; lastErr = null; break;
          } catch (error) { pinned.assertUsable(); lastErr = error; }
        }
        if (!chosenVariant) { preflightFailures.push({ targetId: candidate.id, reason: safeError(lastErr) }); continue; }
        const validate = async () => {
          const initial = loadMorphoBatch(); validateMorphoAuthorization(initial, now());
          requireThat(initial.targets.some(t => t.address?.toLowerCase() === UNIV4_FLASH_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
          await pinned.recheck();
          const current = loadMorphoBatch(), currentCaps = validateMorphoAuthorization(current, now());
          requireThat(current.targets.some(t => t.address?.toLowerCase() === UNIV4_FLASH_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
          return currentCaps;
        };
        const receipt = await guard.executeGuarded({ ...executionOptions, now, account: MAIN_ACCOUNT,
          intent: { targetId: candidate.id, to: UNIV4_FLASH_EXECUTOR, profitToken: candidate.profitToken, pinHash: pinned.pin.hash,
            simulatedProfitBeforeGasRaw: simulatedProfit.toString(), minProfitBeforeGasRaw: chosenVariant.minProfitRaw.toString() },
          prepare: async () => { await validate(); const nonce = Number(uint(await pinned.nonce(MAIN_ACCOUNT)));
            return { transaction: { type: 2, chainId: 1, nonce, to: UNIV4_FLASH_EXECUTOR, data: chosenVariant.data, value: 0n, ...fees }, caps: await validate(),
              conservativeProfitBeforeGasWei: chosenVariant.conservativeProfitBeforeGasWei }; },
          validate, signTransaction, sendRawTransaction, receiptRpc: (hash, timeoutMs) => pinned.receipt(hash, timeoutMs) });
        const out = { ...snapshot(), armed: !["SENT", "PREPARED", "UNCERTAIN"].includes(receipt.stage), execution: receipt };
        if (writeOut) atomicJson(statusFile, out); return { fired: true, summary: out };
      }
      if (candidate.kind === "UNIVERSAL_FLUID_MORPHO_LIQUIDATION") {
        const mBatch = loadMorphoBatch(), mCaps = validateMorphoAuthorization(mBatch, now());
        requireThat(mBatch.targets.some(t => t.address?.toLowerCase() === UNIVERSAL_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
        let fees, simulatedProfit, chosenVariant, lastErr;
        for (const variant of buildScaledUniversalVariants(candidate.data, candidate.minProfitRaw, candidate)) {
          try {
            requireVerifiedCurrentProfit(variant.conservativeProfitBeforeGasWei);
            const call = { from: MAIN_ACCOUNT, to: UNIVERSAL_EXECUTOR, data: variant.data };
            const simulation = await pinned.call(call);
            const decoded = UNIVERSAL_EXEC_IFACE.decodeFunctionResult("execute", simulation);
            requireThat(UNIVERSAL_EXEC_IFACE.encodeFunctionResult("execute", decoded).toLowerCase() === simulation.toLowerCase(), "EXECUTION_ABI_INVALID");
            simulatedProfit = uint(decoded[0]);
            requireThat(simulatedProfit >= variant.minProfitRaw, "SIMULATED_PROFIT_BELOW_MIN");
            fees = guard.buildFees(await pinned.estimateGas(call), pinned.pin.baseFeePerGas, mCaps, variant.conservativeProfitBeforeGasWei);
            chosenVariant = variant; lastErr = null; break;
          } catch (error) { pinned.assertUsable(); lastErr = error; }
        }
        if (!chosenVariant) { preflightFailures.push({ targetId: candidate.id, reason: safeError(lastErr) }); continue; }
        const validate = async () => {
          const initial = loadMorphoBatch(); validateMorphoAuthorization(initial, now());
          requireThat(initial.targets.some(t => t.address?.toLowerCase() === UNIVERSAL_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
          await pinned.recheck();
          const current = loadMorphoBatch(), currentCaps = validateMorphoAuthorization(current, now());
          requireThat(current.targets.some(t => t.address?.toLowerCase() === UNIVERSAL_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
          return currentCaps;
        };
        const receipt = await guard.executeGuarded({ ...executionOptions, now, account: MAIN_ACCOUNT,
          intent: { targetId: candidate.id, to: UNIVERSAL_EXECUTOR, profitToken: candidate.profitToken, pinHash: pinned.pin.hash,
            simulatedProfitBeforeGasRaw: simulatedProfit.toString(), minProfitBeforeGasRaw: chosenVariant.minProfitRaw.toString() },
          prepare: async () => { await validate(); const nonce = Number(uint(await pinned.nonce(MAIN_ACCOUNT)));
            return { transaction: { type: 2, chainId: 1, nonce, to: UNIVERSAL_EXECUTOR, data: chosenVariant.data, value: 0n, ...fees }, caps: await validate(),
              conservativeProfitBeforeGasWei: chosenVariant.conservativeProfitBeforeGasWei }; },
          validate, signTransaction, sendRawTransaction, receiptRpc: (hash, timeoutMs) => pinned.receipt(hash, timeoutMs) });
        const out = { ...snapshot(), armed: !["SENT", "PREPARED", "UNCERTAIN"].includes(receipt.stage), execution: receipt };
        if (writeOut) atomicJson(statusFile, out); return { fired: true, summary: out };
      }
      if (candidate.kind === "UNIVERSAL_EULER_EVK_LIQUIDATION") {
        const mBatch = loadMorphoBatch(), mCaps = validateMorphoAuthorization(mBatch, now());
        requireThat(mBatch.targets.some(t => t.address?.toLowerCase() === ETH_UNIVERSAL_EULER_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
        let fees, simulatedProfit, chosenVariant, lastErr;
        for (const variant of buildScaledEulerVariants(candidate.data, candidate.minProfitRaw, candidate)) {
          try {
            requireVerifiedCurrentProfit(variant.conservativeProfitBeforeGasWei);
            const call = { from: MAIN_ACCOUNT, to: ETH_UNIVERSAL_EULER_EXECUTOR, data: variant.data };
            const simulation = await pinned.call(call);
            const decoded = UNIVERSAL_EULER_EXEC_IFACE.decodeFunctionResult("execute", simulation);
            requireThat(UNIVERSAL_EULER_EXEC_IFACE.encodeFunctionResult("execute", decoded).toLowerCase() === simulation.toLowerCase(), "EXECUTION_ABI_INVALID");
            simulatedProfit = uint(decoded[0]);
            requireThat(simulatedProfit >= variant.minProfitRaw, "SIMULATED_PROFIT_BELOW_MIN");
            fees = guard.buildFees(await pinned.estimateGas(call), pinned.pin.baseFeePerGas, mCaps, variant.conservativeProfitBeforeGasWei);
            chosenVariant = variant; lastErr = null; break;
          } catch (error) { pinned.assertUsable(); lastErr = error; }
        }
        if (!chosenVariant) { preflightFailures.push({ targetId: candidate.id, reason: safeError(lastErr) }); continue; }
        const validate = async () => {
          const initial = loadMorphoBatch(); validateMorphoAuthorization(initial, now());
          requireThat(initial.targets.some(t => t.address?.toLowerCase() === ETH_UNIVERSAL_EULER_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
          await pinned.recheck();
          const current = loadMorphoBatch(), currentCaps = validateMorphoAuthorization(current, now());
          requireThat(current.targets.some(t => t.address?.toLowerCase() === ETH_UNIVERSAL_EULER_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
          return currentCaps;
        };
        const receipt = await guard.executeGuarded({ ...executionOptions, now, account: MAIN_ACCOUNT,
          intent: { targetId: candidate.id, to: ETH_UNIVERSAL_EULER_EXECUTOR, profitToken: candidate.profitToken, pinHash: pinned.pin.hash,
            simulatedProfitBeforeGasRaw: simulatedProfit.toString(), minProfitBeforeGasRaw: chosenVariant.minProfitRaw.toString() },
          prepare: async () => { await validate(); const nonce = Number(uint(await pinned.nonce(MAIN_ACCOUNT)));
            return { transaction: { type: 2, chainId: 1, nonce, to: ETH_UNIVERSAL_EULER_EXECUTOR, data: chosenVariant.data, value: 0n, ...fees }, caps: await validate(),
              conservativeProfitBeforeGasWei: chosenVariant.conservativeProfitBeforeGasWei }; },
          validate, signTransaction, sendRawTransaction, receiptRpc: (hash, timeoutMs) => pinned.receipt(hash, timeoutMs) });
        const out = { ...snapshot(), armed: !["SENT", "PREPARED", "UNCERTAIN"].includes(receipt.stage), execution: receipt };
        if (writeOut) atomicJson(statusFile, out); return { fired: true, summary: out };
      }
      if (candidate.kind === "MORPHO_PENDLE_PT_REDEEM") {
        const mBatch = loadMorphoBatch(), mCaps = validateMorphoAuthorization(mBatch, now());
        requireThat(mBatch.targets.some(t => t.address?.toLowerCase() === PENDLE_PT_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
        let fees, chosenVariant, lastErr;
        for (const variant of buildScaledPendlePtVariants(candidate.data, candidate.minProfitRaw, candidate)) {
          try {
            requireVerifiedCurrentProfit(variant.conservativeProfitBeforeGasWei);
            const call = { from: MAIN_ACCOUNT, to: PENDLE_PT_EXECUTOR, data: variant.data };
            const simulation = await pinned.call(call); PENDLE_PT_EXEC_IFACE.decodeFunctionResult("execute", simulation);
            requireThat(simulation === "0x", "EXECUTION_ABI_INVALID");
            fees = guard.buildFees(await pinned.estimateGas(call), pinned.pin.baseFeePerGas, mCaps, variant.conservativeProfitBeforeGasWei);
            chosenVariant = variant; lastErr = null; break;
          } catch (error) { pinned.assertUsable(); lastErr = error; }
        }
        if (!chosenVariant) { preflightFailures.push({ targetId: candidate.id, reason: safeError(lastErr) }); continue; }
        const validate = async () => {
          const initial = loadMorphoBatch(); validateMorphoAuthorization(initial, now());
          requireThat(initial.targets.some(t => t.address?.toLowerCase() === PENDLE_PT_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
          await pinned.recheck();
          const current = loadMorphoBatch(), currentCaps = validateMorphoAuthorization(current, now());
          requireThat(current.targets.some(t => t.address?.toLowerCase() === PENDLE_PT_EXECUTOR), "BATCH_TARGET_NOT_APPROVED");
          return currentCaps;
        };
        const receipt = await guard.executeGuarded({ ...executionOptions, now, account: MAIN_ACCOUNT,
          intent: { targetId: candidate.id, to: PENDLE_PT_EXECUTOR, profitToken: candidate.profitToken || DAI, pinHash: pinned.pin.hash,
            simulatedProfitBeforeGasRaw: null, minProfitBeforeGasRaw: chosenVariant.minProfitRaw.toString() },
          prepare: async () => { await validate(); const nonce = Number(uint(await pinned.nonce(MAIN_ACCOUNT)));
            return { transaction: { type: 2, chainId: 1, nonce, to: PENDLE_PT_EXECUTOR, data: chosenVariant.data, value: 0n, ...fees }, caps: await validate(),
              conservativeProfitBeforeGasWei: chosenVariant.conservativeProfitBeforeGasWei }; },
          validate, signTransaction, sendRawTransaction, receiptRpc: (hash, timeoutMs) => pinned.receipt(hash, timeoutMs) });
        const out = { ...snapshot(), armed: !["SENT", "PREPARED", "UNCERTAIN"].includes(receipt.stage), execution: receipt };
        if (writeOut) atomicJson(statusFile, out); return { fired: true, summary: out };
      }
      if (candidate.kind === "MORPHO_BLUE_WSTETH") {
        const authorize = () => validateMorphoAuthorization(loadMorphoBatch(), now());
        const mCaps = authorize();
        let fees, chosenVariant, lastErr;
        for (let variant of buildScaledM1Variants(candidate, true)) {
          try {
            requireVerifiedCurrentProfit(variant.conservativeProfitBeforeGasWei);
            const rawQuote = await pinned.call({ to: QUOTER_V2,
              data: QUOTER_IFACE.encodeFunctionData("quoteExactInput", [variant.swapPath || WST_PATH, variant.seizedAssets]) });
            const decodedQuote = QUOTER_IFACE.decodeFunctionResult("quoteExactInput", rawQuote), quote = decodedQuote[0];
            requireThat(quote > 0n && QUOTER_IFACE.encodeFunctionResult("quoteExactInput", decodedQuote).toLowerCase() === rawQuote.toLowerCase(), "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
            if (variant !== candidate && variant.minOutWeth * 10000n < quote * 9800n) {
              const minOut = (quote * 9800n + 9999n) / 10000n;
              const d = MORPHO_EXEC_IFACE.decodeFunctionData("execute", variant.data);
              variant = { ...variant, data: MORPHO_EXEC_IFACE.encodeFunctionData("execute", [d[0], d[1], d[2], d[3], d[4], minOut, d[6], d[7]]), minOutWeth: minOut };
            }
            requireThat(variant.minOutWeth * 10000n >= quote * 9800n && variant.minProfitWeth >= (variant.usePlanMinProfit ? 1000000000000000n : 10000000000000000n), "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
            const call = { from: MAIN_ACCOUNT, to: MORPHO_EXECUTOR, data: variant.data };
            const simulation = await pinned.call(call); MORPHO_EXEC_IFACE.decodeFunctionResult("execute", simulation);
            requireThat(simulation === "0x", "EXECUTION_ABI_INVALID");
            fees = guard.buildFees(await pinned.estimateGas(call), pinned.pin.baseFeePerGas, mCaps, variant.conservativeProfitBeforeGasWei);
            chosenVariant = variant; lastErr = null; break;
          } catch (error) { pinned.assertUsable(); lastErr = error; }
        }
        if (!chosenVariant) { preflightFailures.push({ targetId: candidate.id, reason: safeError(lastErr) }); continue; }
        const validate = async () => {
          authorize(); await pinned.recheck();
          return authorize();
        };
        const minProfitRaw = chosenVariant.minProfitWeth;
        const receipt = await guard.executeGuarded({ ...executionOptions, now, account: MAIN_ACCOUNT,
          intent: { targetId: candidate.id, to: MORPHO_EXECUTOR, profitToken: WETH, pinHash: pinned.pin.hash,
            simulatedProfitBeforeGasRaw: null, minProfitBeforeGasRaw: minProfitRaw.toString() },
          prepare: async () => { await validate(); const nonce = Number(uint(await pinned.nonce(MAIN_ACCOUNT)));
            return { transaction: { type: 2, chainId: 1, nonce, to: MORPHO_EXECUTOR, data: chosenVariant.data, value: 0n, ...fees }, caps: await validate(),
              conservativeProfitBeforeGasWei: chosenVariant.conservativeProfitBeforeGasWei }; },
          validate, signTransaction, sendRawTransaction, receiptRpc: (hash, timeoutMs) => pinned.receipt(hash, timeoutMs) });
        const out = { ...snapshot(), armed: !["SENT", "PREPARED", "UNCERTAIN"].includes(receipt.stage), execution: receipt };
        if (writeOut) atomicJson(statusFile, out); return { fired: true, summary: out };
      }
      requireThat(batch.targets.some(t => t.address?.toLowerCase() === candidate.target), "BATCH_TARGET_NOT_APPROVED");
      const balanceAware2K = candidate.params?.isAaveV3 === true && currentOnly2K && candidate.id === CURRENT_2K_ID;
      const balanceAware2K2L = candidate.params?.isAaveV3 === true && currentOnly2K2L && (candidate.id === CURRENT_2K_ID || candidate.id === CURRENT_2L_ID);
      const balanceAware = balanceAware2K || balanceAware2K2L;
      const balanceCode = balanceAware2K2L ? "CURRENT_2K_2L_NATIVE_BALANCE" : "CURRENT_2K_NATIVE_BALANCE";
      const readNativeBalance = async () => {
        requireThat(typeof pinned.balance === "function", balanceCode + "_UNAVAILABLE");
        const balance = uint(await pinned.balance(MAIN_ACCOUNT), balanceCode + "_INVALID");
        if (balanceAware2K2L) requireThat(balance < (1n << 256n), balanceCode + "_INVALID");
        return balance;
      };
      let feeCaps;
      if (balanceAware) {
        const authorizedCaps = scopedCaps(validateAuthorization(loadBatch(), now()), localMaxSpendWei);
        // Corroborated balance at the existing pin only, not latest/inclusion state.
        // Attenuate pricing without mutating approval caps or introducing a reserve.
        const balance = await readNativeBalance();
        feeCaps = { ...authorizedCaps, spendCap: balance < authorizedCaps.spendCap ? balance : authorizedCaps.spendCap };
      }
      let fees, chosenVariant = candidate, lastErr;
      for (const variant of balanceAware ? [candidate] : buildScaledUnifiedWethVariants(candidate)) {
        try {
          const vp = variant.params;
          // executeMorpho enforces this WETH floor after flash repayment (native wei 1:1).
          requireVerifiedCurrentProfit(vp.minProfitDebtToken);
          if (variant.kind === "AAVE_V4_SAME_ASSET_WETH") {
            requireThat(vp.minProfitDebtToken >= caps.minProfitWeth, "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
          } else {
            const quote = vp.collateralToken.toLowerCase() === WSTETH
              ? QUOTER_IFACE.decodeFunctionResult("quoteExactInput", await pinned.call({ to: QUOTER_V2, data: QUOTER_IFACE.encodeFunctionData("quoteExactInput", [WST_PATH, vp.minCollateralSeized]) }))[0]
              : CURVE_IFACE.decodeFunctionResult("get_dy", await pinned.call({ to: CURVE, data: CURVE_IFACE.encodeFunctionData("get_dy", [1, 0, vp.minCollateralSeized]) }))[0];
            if (variant !== candidate && vp.minDebtTokenOut * 10000n < quote * 9950n) {
              vp.minDebtTokenOut = (quote * 9950n + 9999n) / 10000n;
              variant.data = UNIFIED_IFACE.encodeFunctionData("executeMorpho", [variant.flashAmount, vp]);
            }
            requireThat(vp.minDebtTokenOut * 10000n >= quote * 9950n && vp.minProfitDebtToken >= (variant.usePlanMinProfit ? 1000000000000000n : 2500000000000000n), "PLAN_PROFIT_OR_SLIPPAGE_INVALID");
          }
          const call = { from: MAIN_ACCOUNT, to: DEPLOYED_EXECUTOR, data: variant.data };
          const simulation = await pinned.call(call); UNIFIED_IFACE.decodeFunctionResult("executeMorpho", simulation);
          requireThat(simulation === "0x", "EXECUTION_ABI_INVALID");
          if (balanceAware) fees = guard.buildFees(await pinned.estimateGas(call), pinned.pin.baseFeePerGas, feeCaps, vp.minProfitDebtToken);
          else fees = guard.buildFees(await pinned.estimateGas(call), pinned.pin.baseFeePerGas, caps, vp.minProfitDebtToken);
          requireThat(vp.minProfitDebtToken > fees.gasLimit * fees.maxFeePerGas, "PROFIT_FLOOR_BELOW_GAS_BUDGET");
          chosenVariant = variant; lastErr = null; break;
        } catch (error) {
          pinned.assertUsable();
          lastErr = error.code === "PROFIT_NET_NONPOSITIVE" ? new guard.ExecutionError("PROFIT_FLOOR_BELOW_GAS_BUDGET") : error;
        }
      }
      if (lastErr) { preflightFailures.push({ targetId: candidate.id, reason: safeError(lastErr) }); continue; }
      const assertTargetApproved = batch => requireThat(batch.targets.some(t => t.address?.toLowerCase() === candidate.target), "BATCH_TARGET_NOT_APPROVED");
      const validatePreparedCaps = currentCaps => {
        if (balanceAware2K2L) requireThat(fees.gasLimit <= currentCaps.gasCap && fees.gasLimit * fees.maxFeePerGas <= currentCaps.spendCap &&
          (currentCaps.feeCap === null || fees.maxFeePerGas <= currentCaps.feeCap), "TX_CAP_EXCEEDED");
        return currentCaps;
      };
      const validate = async () => {
        scopedCaps(validateAuthorization(loadBatch(), now()), localMaxSpendWei); await pinned.recheck();
        let currentBatch = loadBatch(), currentCaps = validatePreparedCaps(scopedCaps(validateAuthorization(currentBatch, now()), localMaxSpendWei));
        assertTargetApproved(currentBatch);
        // Repeat the same pin-bound read at each existing guard validation boundary.
        // Never repin/reprice a bound transaction; post-pin external debits remain unknown.
        if (balanceAware) {
          requireThat(await readNativeBalance() >= fees.gasLimit * fees.maxFeePerGas, balanceCode + "_INSUFFICIENT");
          // Only the new exact two-target mode adds the post-await reload. The legacy
          // #2K-only path keeps its existing call/boundary behavior unchanged.
          if (balanceAware2K2L) {
            // The balance await can outlive the authorization snapshot above, so expiry,
            // revocation or tightening during it must not escape this boundary. Reload
            // with a fresh clock and revalidate the UNCHANGED prepared transaction.
            currentBatch = loadBatch();
            currentCaps = validatePreparedCaps(scopedCaps(validateAuthorization(currentBatch, now()), localMaxSpendWei));
            assertTargetApproved(currentBatch);
          }
        }
        return currentCaps;
      };
      const receipt = await guard.executeGuarded({ ...executionOptions, now, account: MAIN_ACCOUNT,
        intent: { targetId: candidate.id, to: DEPLOYED_EXECUTOR, profitToken: WETH, pinHash: pinned.pin.hash,
          simulatedProfitBeforeGasRaw: null, minProfitBeforeGasRaw: chosenVariant.params.minProfitDebtToken.toString() },
        prepare: async () => { await validate(); const nonce = Number(uint(await pinned.nonce(MAIN_ACCOUNT)));
          return { transaction: { type: 2, chainId: 1, nonce, to: DEPLOYED_EXECUTOR, data: chosenVariant.data, value: 0n, ...fees }, caps: validatePreparedCaps(scopedCaps(validateAuthorization(loadBatch(), now()), localMaxSpendWei)),
            conservativeProfitBeforeGasWei: chosenVariant.params.minProfitDebtToken.toString() }; },
        validate, signTransaction, sendRawTransaction, receiptRpc: (hash, timeoutMs) => pinned.receipt(hash, timeoutMs) });
      const out = { ...snapshot(), armed: !["SENT", "PREPARED", "UNCERTAIN"].includes(receipt.stage), execution: receipt };
      if (writeOut) atomicJson(statusFile, out); return { fired: true, summary: out };
    }
    return finish({ armed: false, reason: "NO_CANDIDATE_PASSED_PREFLIGHT" });
  } catch (error) {
    knownContextInvalid = true; nextBlockContext = null;
    const { summary } = finish({ ok: false, armed: false, mode: measureOnly ? "MEASURE_ONLY" : "BLOCKED", reason: safeError(error) });
    error.passSummary = summary;
    throw error;
  } finally { if (m1HotPathV2 && !retained) hotPathLease?.cancelFuture(); }
}
function shouldImmediateFollowUp(summary) {
  return Boolean(summary?.execution?.stage === "RECEIPT_VERIFIED" && summary?.armed === true);
}
function computeEthPollIntervalMs(summary, baseIntervalMs) {
  if (shouldImmediateFollowUp(summary)) return 0;
  const near = Object.values(summary?.targets || {}).flat()
    .some(t => nextExecution.activePosition(t) && t.bpsToLiquidation !== null && t.bpsToLiquidation !== undefined &&
      t.bpsToLiquidation !== "" && typeof t.bpsToLiquidation !== "boolean" && Number.isFinite(Number(t.bpsToLiquidation)) && Number(t.bpsToLiquidation) <= 5.0);
  return near ? Math.min(baseIntervalMs, 6000) : baseIntervalMs;
}
function createHeadWakeLatch({ isReady } = {}) {
  let pending = false, notify = null, closed = false;
  return {
    signal() { if (!closed) { pending = true; notify?.(); } },
    async wait(ms, sleep, now) {
      const start = now(); let timer;
      try {
        if (!pending) await Promise.race([
          sleep ? sleep(ms) : new Promise(resolve => { timer = setTimeout(resolve, ms); }),
          new Promise(resolve => { notify = resolve; if (pending || closed) resolve(); }),
        ]);
        if (pending) { pending = false; const left = isReady?.() === true ? 0 : Math.min(ms, 300) - (now() - start);
          if (left > 0) await (sleep ? sleep(left) : new Promise(resolve => { clearTimeout(timer); timer = setTimeout(resolve, left); })); }
      } finally { clearTimeout(timer); notify = null; }
    },
    close() { closed = true; pending = false; notify?.(); },
  };
}
async function waitForNewHead(lastPassPin, { intervalMs, liveHeadNumber, wake,
  sleep, now = () => performance.now(), absoluteDeadline, futureReady }) {
  const pause = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  if (intervalMs <= 0) return;
  const cap = Math.max(5000, intervalMs);
  const deadline = absoluteDeadline ?? now() + cap, timedOut = Symbol("HEAD_WAIT_CAP");
  if (typeof liveHeadNumber !== "function" || !Number.isSafeInteger(lastPassPin?.number)) {
    if (absoluteDeadline === undefined) return wake ? wake.wait(cap, sleep, now) : pause(cap);
    // No advisory head witness: readiness still needs the mandatory child
    // recheck. Keep the original absolute idle deadline even after a wake.
    while (now() < deadline) {
      if (futureReady?.() === true) return "FUTURE_READY";
      const left = deadline - now(); if (wake) await wake.wait(left, sleep, now); else await pause(left);
    }
    return;
  }
  while (now() < deadline) {
    let timer;
    try {
      const head = await Promise.race([
        Promise.resolve().then(liveHeadNumber),
        new Promise(resolve => { timer = setTimeout(() => resolve(timedOut), Math.max(0, deadline - now())); }),
      ]);
      if (head === timedOut) return;
      requireThat(Number.isSafeInteger(head) && head >= 0, "LIVE_HEAD_INVALID");
      if (head > lastPassPin.number) return;
      if (now() < deadline && futureReady?.() === true) return "FUTURE_READY";
    } catch (_) {
      // Head polling is advisory only: a failed read retains the original delay.
      clearTimeout(timer);
      if (absoluteDeadline !== undefined) return waitForNewHead(lastPassPin, { intervalMs, wake, sleep, now, absoluteDeadline: deadline, futureReady });
      return wake ? wake.wait(cap, sleep, now) : pause(cap);
    } finally { clearTimeout(timer); }
    const remaining = deadline - now();
    if (remaining > 0) { if (wake) await wake.wait(Math.min(300, remaining), sleep, now); else await pause(Math.min(300, remaining)); }
  }
}
async function connectForPass({ argv, candidates, rpc, create = createPinnedRpc, qualifiedPairFactory, hotPathFactory }) {
  if (argv.includes("--m1-capability-v1")) parseRunnerMode(argv);
  if (argv.includes("--m1-hot-path-v2")) {
    parseRunnerMode(argv);
    requireThat(typeof hotPathFactory?.acquire === "function", "M1_HOT_PATH_FACTORY_REQUIRED");
    return hotPathFactory.acquire({ candidates });
  }
  if (argv.includes("--reuse-qualified-pair")) {
    parseRunnerMode(argv);
    requireThat(typeof qualifiedPairFactory?.acquire === "function", "QUALIFIED_PAIR_FACTORY_REQUIRED");
    // Fixed strict profile: any failure holds this pass, including unavailable
    // next-block qualification. Never enter the lower-capability fallback ladder.
    return qualifiedPairFactory.acquire({ candidates });
  }
  if (argv.includes("--measure-only")) {
    parseRunnerMode(argv);
    // Future capability qualification probes a nonce. Measurement forbids it,
    // including all fallback attempts; current strict qualification only.
    return create({ candidates, rpc, requireStrictEvidence: true });
  }
  if (argv.includes("--next-block")) {
    try { return await create({ candidates, rpc, requireStrictEvidence: true, requireNextBlock: true }); } catch (_) {}
    try { return await create({ candidates, rpc, requireStrictEvidence: true }); } catch (_) {}
    try { return await create({ candidates, rpc, requireNextBlock: true }); } catch (_) { /* future capability never disables the current lane */ }
    return create({ candidates, rpc });
  }
  try { return await create({ candidates, rpc, requireStrictEvidence: true }); } catch (_) { /* M1 holds on nonstrict fallback; unrelated routes retain original availability. */ }
  return create({ candidates, rpc });
}
async function main(argv = process.argv.slice(2), dependencies = {}) {
  const currentOnly2K2L = currentOnly2K2LMode(argv);
  const currentOnly2K = currentOnly2KMode(argv); // Must precede special dispatch and all live dependency work.
  const localMaxSpendWei = currentOnly2K2L ? current2K2LMaxSpend(argv) : current2KMaxSpend(argv);
  const scopedCaps = currentOnly2K2L ? current2K2LCaps : current2KCaps;
  const statusFile = currentOnly2K2L ? current2K2LStatusFile() : STATUS_FILE;
  if (argv.includes("--m32-only")) {
    // Dispatch BEFORE legacy batch loading, provider qualification or partitions.
    const flags = new Set(["--m32-only", "--check", "--dry-run", "--execute-if-liquidatable", "--watch", "--m32-warm-watch", "--max-runs", "--no-write"]);
    const seen = new Set(); let watching = false, interval = 20000, maxRuns;
    let explicitInterval = false;
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i]; requireThat(flags.has(flag) && !seen.has(flag), "M32_ARGUMENTS_REJECTED"); seen.add(flag);
      if (flag === "--watch") {
        watching = true;
        if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
          requireThat(/^[1-9][0-9]*$/.test(argv[i + 1]) && Number(argv[i + 1]) >= 5 && Number(argv[i + 1]) <= 3600, "M32_ARGUMENTS_REJECTED"); interval = Number(argv[++i]) * 1000;
          explicitInterval = true;
        }
      } else if (flag === "--max-runs") {
        requireThat(/^[1-9][0-9]*$/.test(argv[i + 1] || "") && Number.isSafeInteger(Number(argv[i + 1])), "M32_ARGUMENTS_REJECTED"); maxRuns = Number(argv[++i]);
      }
    }
    requireThat(!(seen.has("--execute-if-liquidatable") && (seen.has("--check") || seen.has("--dry-run"))), "CONFLICTING_EXECUTION_FLAGS");
    requireThat(!seen.has("--check") || !seen.has("--dry-run"), "M32_ARGUMENTS_REJECTED");
    requireThat(!seen.has("--m32-warm-watch") || (watching && !explicitInterval), "M32_ARGUMENTS_REJECTED");
    const command = require("./lib/m32-attended-call.cjs"), output = dependencies.output || (value => console.log(JSON.stringify(value)));
    const pause = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    if (seen.has("--m32-warm-watch")) {
      const watch = command.createWatchSession(maxRuns === undefined ? {} : { maxRuns });
      try {
        for (let run = 1; run <= (maxRuns ?? Infinity); run++) {
          const result = await watch[seen.has("--execute-if-liquidatable") ? "nextExecute" : "nextCheck"](); output({ run, collectionScope: "M32_ONLY", ...result });
          if (run === maxRuns || result.watchStopped || result.preparedBoundaryEntered || result.irreversibleHold || result.liquidationVerified) break;
        }
      } finally { await watch.close(); }
      return;
    }
    for (let run = 1; run <= (maxRuns ?? (watching ? Infinity : 1)); run++) {
      const result = await command[seen.has("--execute-if-liquidatable") ? "execute" : "check"](); output({ run, collectionScope: "M32_ONLY", ...result });
      if (!watching || run === maxRuns || result.preparedBoundaryEntered || result.irreversibleHold || result.liquidationVerified) break;
      await pause(interval);
    }
    return;
  }
  const { execute, writeOut, measureOnly, m1Only, reuseQualifiedPair, m1HotPathV2, m1CapabilityV1, wsHeads } = parseRunnerMode(argv), watch = argv.indexOf("--watch");
  const wallNow = dependencies.wallNow || Date.now, monotonicNow = dependencies.monotonicNow || (() => performance.now());
  // Offline overrides must be complete BEFORE optional catches, factories or
  // lazy live imports. An explicit headConnect bypasses every default head
  // loader/connector/transport; without the flag none of them is resolved.
  if (wsHeads && dependencies.connect) requireThat(typeof dependencies.createAdvisoryHeadWakeup === "function" &&
    (typeof dependencies.headConnect === "function" || typeof dependencies.createM1HeadConnector === "function" &&
      typeof dependencies.loadHeadCandidates === "function" && typeof dependencies.WebSocketImpl === "function" &&
      typeof dependencies.fetchImpl === "function"), "M1_WS_INJECTION_REQUIRED");
  const connect = dependencies.connect || connectForPass, loadCandidates = dependencies.loadCandidates || loadRpcCandidates;
  const output = dependencies.output || (value => console.log(JSON.stringify(value)));
  const pass = dependencies.runPass || runPass, loadBatch = dependencies.loadBatch || (() => dependencies.batch !== undefined
    ? dependencies.batch : readBatchWithRenewal(BUNDLE, BUNDLE_RENEWAL, wallNow()));
  const loadMorphoBatch = dependencies.loadMorphoBatch || (() => dependencies.morphoBatch !== undefined ? dependencies.morphoBatch :
    (fs.existsSync(MORPHO_BUNDLE) ? readBatchWithRenewal(MORPHO_BUNDLE, MORPHO_BUNDLE_RENEWAL, wallNow()) : null));
  const interval = watch < 0 ? 0 : Math.max(5, Number(argv[watch + 1]) || 20) * 1000;
  const maxIndex = argv.indexOf("--max-runs"), maxRuns = maxIndex < 0 ? (interval ? Infinity : 1) : Math.max(1, Number(argv[maxIndex + 1]) || 1);
  const allowFutureContinuation = m1HotPathV2 && interval > 0 && argv.includes("--next-block") && !measureOnly;
  const secondarySendRawTransaction = (signed, assertDispatch) => httpRpc({ handle: "https://rpc.flashbots.net/fast" }, "eth_sendRawTransaction", [signed], 3500, assertDispatch);
  let qualifiedPairFactory, hotPathFactory, advisory, retainedLease = null, unsubscribeReady = null, continuationOwner = null;
  const hotPathTimings = m1HotPathV2 ? createHotPathTimings({ onTiming: dependencies.onTiming }) : null;
  const wake = wsHeads || allowFutureContinuation ? createHeadWakeLatch({ isReady: () => retainedLease?.isFutureReady?.() === true }) : null;
  const releaseContinuation = () => {
    unsubscribeReady?.(); unsubscribeReady = null;
    retainedLease?.cancelFuture(); retainedLease = null;
    if (continuationOwner) futureContinuationOwners.delete(continuationOwner);
    continuationOwner = null;
  };
  if (reuseQualifiedPair) {
    // An overridden connector must explicitly inject the factory too; never
    // initialize production transport behind an offline connector override.
    requireThat(!dependencies.connect || typeof dependencies.createQualifiedPairFactory === "function", "QUALIFIED_PAIR_FACTORY_INJECTION_REQUIRED");
    const createFactory = dependencies.createQualifiedPairFactory || require("./lib/executor-pinned-rpc.js").createQualifiedPairFactory;
    requireThat(typeof createFactory === "function", "QUALIFIED_PAIR_FACTORY_UNAVAILABLE");
    qualifiedPairFactory = createFactory(Object.freeze({ rpc: httpRpc, ttlMs: 60000, requireStrictEvidence: true,
      requireNextBlock: argv.includes("--next-block") && !measureOnly, requireTrace: false }));
  }
  try {
  if (m1HotPathV2) {
    requireThat(!dependencies.connect || typeof dependencies.createM1HotPathFactory === "function", "M1_HOT_PATH_FACTORY_INJECTION_REQUIRED");
    const createFactory = dependencies.createM1HotPathFactory || require("./lib/executor-pinned-rpc.js").createM1HotPathFactory;
    hotPathFactory = createFactory(Object.freeze({ rpc: httpRpc, allowFuture: argv.includes("--next-block") && !measureOnly,
      qualificationMode: m1CapabilityV1 ? "capability-v1" : "fresh", onTiming: hotPathTimings.observe }));
  }
  if (wsHeads) {
    try {
      const createWakeup = dependencies.createAdvisoryHeadWakeup || require("./lib/advisory-head-wakeup.js").createAdvisoryHeadWakeup;
      const headConnect = dependencies.headConnect || (dependencies.createM1HeadConnector || require("./lib/m1-head-connector.js").createM1HeadConnector)({
        loadHeadCandidates: dependencies.loadHeadCandidates || (() => require("./shared-rpc.js").loadHeadCandidates({ maxCandidates: 32 })),
        WebSocketImpl: dependencies.WebSocketImpl || require("./node_modules/ws"), fetchImpl: dependencies.fetchImpl || globalThis.fetch });
      advisory = createWakeup({ connect: headConnect, onWake: () => wake.signal(), onTiming: hotPathTimings.observe });
      Promise.resolve().then(() => advisory.start()).catch(() => {});
    } catch (_) { /* Optional notification setup can never disable strict HTTP acquisition. */ }
  }
  for (let run = 1; run <= maxRuns; run++) {
    let pollIntervalMs = interval, pinned, lastPassPin, hotPathLease, continuation, m1Budget;
    const timings = createPhaseTimings();
    try {
      if (m1HotPathV2) m1Budget = createM1V2Budget({ wallNow, monotonicNow });
      const batch = measureOnly ? undefined : loadBatch();
      if (execute || localMaxSpendWei !== null) scopedCaps(validateAuthorization(batch, m1HotPathV2 ? wallNow() : Date.now()), localMaxSpendWei);
      const endAcquisition = timings.begin("acquisition");
      try {
        const candidates = loadCandidates();
        if (m1HotPathV2) hotPathFactory.maintain({ candidates });
        const acquired = await connect({ argv, candidates, rpc: httpRpc,
          ...(reuseQualifiedPair ? { qualifiedPairFactory } : {}), ...(m1HotPathV2 ? { hotPathFactory } : {}) });
        if (m1HotPathV2) { hotPathLease = acquired; pinned = acquired.current; m1Budget.bind(hotPathLease); } else pinned = acquired;
      } finally { endAcquisition(pinned?.pin); }
      lastPassPin = { ...pinned.pin };
      if (allowFutureContinuation && run < maxRuns && typeof hotPathLease?.onFutureReady === "function" && typeof hotPathLease.isFutureReady === "function") {
        retainedLease = hotPathLease; continuationOwner = Object.freeze({});
        continuation = { lease: hotPathLease, resume: null }; futureContinuationOwners.set(continuationOwner, continuation);
        // Register before CURRENT collection. This callback can only set a
        // bounded scheduling latch; it never collects, prepares or executes.
        unsubscribeReady = hotPathLease.onFutureReady(() => wake.signal());
      }
      const result = await pass({ execute, argv, batch, pinned, writeOut, timings,
        ...(currentOnly2K2L ? { statusFile } : {}),
        loadBatch, loadMorphoBatch, secondarySendRawTransaction, ...(m1HotPathV2 ? { hotPathLease, hotPathTimings, m1Budget, now: wallNow, onTiming: hotPathTimings.observe } : {}),
        ...(continuation ? { allowFutureContinuation: true, futureContinuationOwner: continuationOwner } : {}) });
      output({ run, ...result.summary, ...(m1HotPathV2 ? { timingEvents: hotPathTimings.snapshot() } : {}) });
      pollIntervalMs = computeEthPollIntervalMs(result.summary, interval);
    } catch (error) {
      if (continuation) continuation.resume = null;
      const result = error.passSummary || { ok: false, armed: false, mode: measureOnly ? "MEASURE_ONLY" : "BLOCKED", checkedAt: new Date().toISOString(), reason: safeError(error),
        ...(m1Only ? { collectionScope: "M1_ONLY", partial: true, targets: [] } : {}),
        ...(currentOnly2K ? { collectionScope: "CURRENT_2K_ONLY", partition: "CURRENT_2K_ONLY", partial: true, targets: [] } : {}),
        ...(currentOnly2K2L ? { collectionScope: "CURRENT_2K_2L_ONLY", partition: "CURRENT_2K_2L_ONLY", partial: true, targets: [] } : {}),
        ...(localMaxSpendWei !== null ? { localMaxSpendWei: localMaxSpendWei.toString() } : {}),
        phaseTimingsMs: timings.snapshot(), ...(m1HotPathV2 ? { timingEvents: hotPathTimings.snapshot(), ...(m1Budget ? { m1Budget: m1Budget.snapshot() } : {}) } : {}), ...(measureOnly ? { measurements: { futureQualification: "NOT_MEASURED_NONCE_FORBIDDEN", exactExecution: "NOT_MEASURED_NONCE_FORBIDDEN",
          ...(m1Only ? { fullPreparation: "NOT_MEASURED_NONCE_FORBIDDEN" } : {}) } } : {}) };
      if (writeOut) atomicJson(statusFile, result); output({ run, ...result }); if (!interval) process.exitCode = 1;
    } finally {
      if (!continuation?.resume) { hotPathLease?.cancelFuture(); releaseContinuation(); }
      hotPathTimings?.flush();
    }
    if (!interval || run === maxRuns) break;
    try {
      if (pollIntervalMs > 0) {
        const idleNow = dependencies.now || (() => performance.now());
        const deadline = idleNow() + Math.max(5000, pollIntervalMs);
        const waitOptions = { intervalMs: pollIntervalMs,
          liveHeadNumber: dependencies.liveHeadNumber ? () => dependencies.liveHeadNumber(pinned) : pinned?.liveHeadNumber?.bind(pinned),
          sleep: dependencies.sleep, now: idleNow, ...(wake ? { wake } : {}) };
        if (continuation?.resume) {
          // One owner, one polling loop, one absolute idle budget. Readiness
          // interrupts the sleep, not an in-flight head read; no orphan poller
          // or concurrent CURRENT/forecast pass can survive the handoff.
          const event = await waitForNewHead(lastPassPin, { ...waitOptions, absoluteDeadline: deadline,
            futureReady: () => hotPathLease.isFutureReady() });
          if (event === "FUTURE_READY" && idleNow() < deadline) {
            const resume = continuation.resume; continuation.resume = null; unsubscribeReady?.(); unsubscribeReady = null;
            try {
              const result = await resume();
              output({ run, ...result.summary, timingEvents: hotPathTimings.snapshot() });
              if (shouldImmediateFollowUp(result.summary)) continue;
            } catch (error) {
              output({ run, ...(error.passSummary || { ok: false, armed: false, passPhase: "FUTURE_CONTINUATION", reason: safeError(error),
                collectionScope: "M1_ONLY", partial: true, targets: [] }) });
            } finally { releaseContinuation(); hotPathTimings.flush(); }
            await waitForNewHead(lastPassPin, { ...waitOptions, absoluteDeadline: deadline });
          }
        } else await waitForNewHead(lastPassPin, waitOptions);
      }
    } finally { releaseContinuation(); }
  }
  } finally {
    releaseContinuation();
    wake?.close();
    await Promise.allSettled([advisory, hotPathFactory].map(item => Promise.resolve().then(() => item?.close())));
    hotPathTimings?.flush();
    if (qualifiedPairFactory) await qualifiedPairFactory.close();
  }
}
if (require.main === module) main().catch(error => {
  const output = process.argv.includes("--measure-only") ? console.log : console.error;
  output(JSON.stringify({ ok: false, armed: false, reason: safeError(error),
    ...(process.argv.includes("--m1-only") ? { collectionScope: "M1_ONLY", partial: true, targets: [] } : {}),
    ...(process.argv.includes("--current-only-2k") ? { collectionScope: "CURRENT_2K_ONLY", partition: "CURRENT_2K_ONLY", partial: true, targets: [] } : {}),
    ...(process.argv.includes("--current-only-2k-2l") ? { collectionScope: "CURRENT_2K_2L_ONLY", partition: "CURRENT_2K_2L_ONLY", partial: true, targets: [] } : {}) })); process.exitCode = 1;
});
module.exports = { V3_TARGETS, REQUIRED_TARGETS, UNIFIED_IFACE, CURVE_IFACE, CURVE_EXCHANGE_IFACE, MORPHO_EXEC_IFACE, M2_EXEC_IFACE, M7_EXEC_IFACE, QUOTER_IFACE, DEPLOYED_EXECUTOR, A4_SPOKE, A4_BORROWER, MORPHO_EXECUTOR, M2_EXECUTOR, M7_EXECUTOR, M7B_BORROWER, shouldDelegateAaveV4ToDedicatedRunner,
  buildScaledUniversalVariants, buildScaledEulerVariants, buildScaledM2Variants, buildScaledM2VariantsWithKyber, buildM31KyberUniV4SwapData, buildScaledM1Variants, buildScaledUniV4Variants, buildScaledUnifiedWethVariants, buildScaledPendlePtVariants,
  validateAuthorization, validateMorphoAuthorization, readBatchWithRenewal, requireVerifiedCurrentProfit, selectCandidates, canonicalPosition, forecastRoute, validateForecastBase, connectForPass, loadRpcCandidates, httpRpc,
  runPass, createM1V2Budget, createPhaseTimings, createHotPathTimings, createHeadWakeLatch, parseRunnerMode, shouldImmediateFollowUp, computeEthPollIntervalMs, waitForNewHead, main };
