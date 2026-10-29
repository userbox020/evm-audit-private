#!/usr/bin/env node
// Bounded, read-only cross-venue stable round-trip quote scan.
// Two routes share one chain-generic engine: Ethereum FRAX/USDC (Curve FraxBP
// <-> Uniswap V3 fee-500) and Base USDC/USDT (Curve StableSwap-NG <-> Uniswap V3
// fee-100). RPC endpoint material remains process-only and is never logged or persisted.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");
const { resolveWorkingRpc } = require("./scan-morpho-blue-l");
const economics = require("./frax-usdc-cross-venue-economics");

const WORKSPACE = path.resolve(__dirname, "..");
const COVERAGE_DIR = path.join(WORKSPACE, "reports", "monitor", "trigger-coverage");
const TIMEOUT_MS = 15_000;
const MAX_SIZE_USDC = 100_000n;
const SIZE_USDC = Object.freeze([100n, 1_000n, 10_000n, 100_000n]);

// --- Ethereum FRAX/USDC route (default; byte-identical to the original scan) --------------
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "cross-dex-arbitrage.json");
const COVERAGE_FILES = Object.freeze({
  Curve: path.join(COVERAGE_DIR, "ethereum-curve-frax-usdc-x.json"),
  "Uniswap V3": path.join(COVERAGE_DIR, "ethereum-uniswap-v3-frax-usdc-x.json"),
});

// Every binding below is present in the local evidence paths recorded in LOCAL_EVIDENCE.
const TOKENS = Object.freeze({
  FRAX: Object.freeze({ symbol: "FRAX", address: "0x853d955aCEf822Db058eb8505911ED77F175b99e", decimals: 18 }),
  USDC: Object.freeze({ symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }),
});
const CURVE = Object.freeze({
  name: "Curve FraxBP FRAX/USDC",
  type: "Curve StableSwap 2Pool",
  pool: "0xDcEF968d416a41Cdac0ED8702fAC8128A64241A2",
  coins: Object.freeze([TOKENS.FRAX.address, TOKENS.USDC.address]),
  feeDenominator: 10_000_000_000n,
  // Verified executable at the same pin. Keyless local fork at finalized
  // Ethereum pin 26012917
  // (0x7ef1b63814a6e4d2b731aa11471b5bffdf628b1864b8f69528353b8474ab0535):
  // Curve `get_dy` equals the mined `exchange` output exactly (0 bps) in both
  // directions and at two sizes — USDC->FRAX 1e9 = 1,008,042,011,056,832,380,102
  // and 1e8 = 100,808,074,376,818,794,377; FRAX->USDC 5e20 = 495,880,107 and
  // 1e20 = 99,177,716. QuoterV2 also equals the mined `exactInputSingle` exactly
  // in both directions (0.05% pool). No haircut is declared for this route.
  // Evidence: reports/raw/fast/fork-poc/eth-curve-probe.json and
  // reports/raw/fast/fork-poc/eth-univ3-probe.json.
  quoteSource: "get_dy",
  quoteExecutable: true,
});
const UNISWAP = Object.freeze({
  name: "Uniswap V3 FRAX/USDC 0.05%",
  type: "Uniswap V3",
  factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  fee: 500,
  feeDenominator: 1_000_000,
});
const CHAINLINK = Object.freeze({
  ethUsd: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  decimals: 8,
  maxAgeSeconds: 3600,
});

const LOCAL_EVIDENCE = Object.freeze([
  "targets/gearbox-core-v3/lib/@gearbox-protocol/sdk-gov/src/tokens/token.ts:169-194",
  "targets/gearbox-core-v3/lib/@gearbox-protocol/sdk-gov/src/tokens/decimals.ts:11-21",
  "targets/gearbox-core-v3/lib/@gearbox-protocol/sdk-gov/src/contracts/contracts.ts:178-193",
  "targets/gearbox-core-v3/lib/@gearbox-protocol/sdk-gov/src/tokens/curveLP.ts:123-129",
  "targets/fraxlend/src/contracts/interfaces/IStableSwap.sol:4-68",
  "targets/gearbox-core-v3/lib/@gearbox-protocol/sdk-gov/src/config/configs/wethConfigMainnet.ts:233-244",
  "targets/origin-dollar-37175c/contracts/utils/addresses.js:100-109",
  "targets/alchemix/src/interfaces/external/uniswap/IUniswapV3Factory.sol:35-52",
  "targets/etherfi-smart-contracts-1d3eba9/lib/v3-periphery/contracts/interfaces/IQuoterV2.sol:27-53",
]);

const ETH_ROUTE = Object.freeze({
  id: "ethereum-frax-usdc",
  chainId: 1,
  label: "FRAX/USDC",
  base: TOKENS.USDC,
  quote: TOKENS.FRAX,
  curve: CURVE,
  uniswap: UNISWAP,
  uniToken0: TOKENS.FRAX.address,
  uniToken1: TOKENS.USDC.address,
  chainlink: CHAINLINK,
  sizes: SIZE_USDC,
  maxSize: MAX_SIZE_USDC,
  gasPolicy: Object.freeze({ priorityFeeWei: 2_000_000_000n }),
  artifactPath: OUT,
  coverageFiles: COVERAGE_FILES,
  localEvidence: LOCAL_EVIDENCE,
  coverageRef: "bounded complete FRAX/USDC Curve FraxBP and Uniswap V3 fee-500 round trips at four USDC sizes and one finalized pin",
  nextActionFork: "Run one fixed-pin local-fork atomic FRAX/USDC round-trip for the emitted candidate values, including flash repayment, gas, slippage guard, and unwind.",
});

// --- Base USDC/USDT route -----------------------------------------------------------------
const BASE_TOKENS = Object.freeze({
  USDC: Object.freeze({ symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }),
  USDT: Object.freeze({ symbol: "USDT", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 }),
});
const BASE_CURVE = Object.freeze({
  name: "Curve USDC/USDT (StableSwap-NG)",
  type: "Curve StableSwap-NG",
  pool: "0x335BE1a364eA7f5DA30AaaF062103AB91bF44dD0",
  coins: Object.freeze([BASE_TOKENS.USDC.address, BASE_TOKENS.USDT.address]),
  feeDenominator: 10_000_000_000n,
  // The Curve leg is quoted with the pool's `get_dy` view, which is NOT an
  // executable quote for this pool. Same-pin adjudication in one keyless local
  // fork at finalized Base pin 51521633
  // (0x5373eef5ada4c233d2f40a81d8e646fcd5ba96263a5cd64983857b88ce9ca5c2):
  //   get_dy(0,1,1e9)=1,004,122,245 vs mined exchange(0,1,1e9,0)=999,205,630 (view +49.2 bps)
  //   get_dy(1,0,1e9)=  994,666,587 vs mined exchange(1,0,1e9,0)=999,562,649 (view -49.2 bps)
  // The ~49 bps gap is present at ONE pin in BOTH directions, so it is a
  // same-pin view/executable divergence, not cross-pin edge decay or latency
  // (mined output is invariant across pin+9..pin+2407 seconds). The mined
  // `exchange` ABI return equals the amount actually transferred. A simulated
  // `eth_call` of `exchange` (funded + approved actor) returns the inflated
  // `get_dy` value (1,004,122,245), NOT the mined amount, so a simulated-exchange
  // `eth_call` leg cannot screen this executably at a pinned fork. Keep `get_dy`
  // as a non-executable screen; the keyless fixed-pin mined fork remains the sole
  // adjudicator and correctly falsifies these view-only gross edges.
  quoteSource: "get_dy",
  quoteExecutable: false,
  // Conservative per-route quote-inflation haircut applied inside the fire gate.
  // Measured same-pin divergence at finalized Base pin 51521633
  // (0x5373eef5ada4c233d2f40a81d8e646fcd5ba96263a5cd64983857b88ce9ca5c2) was
  // ~49.2 bps in both directions (view 1,004,122,245 vs mined 999,205,630 for
  // 1e9 USDC->USDT; view 994,666,587 vs mined 999,562,649 for USDT->USDC). The
  // declared 60 bps adds margin over the measured 49.2 bps. The gate subtracts
  // ceil(amountInRaw * 60 / 10_000) from the quoted gross, so this can only
  // SUPPRESS a fire, never create one. The raw quoted gross and the haircut are
  // both retained in the scan artifact economics rows for a truthful record.
  quoteInflationBps: 60,
});
const BASE_UNISWAP = Object.freeze({
  name: "Uniswap V3 USDC/USDT 0.01%",
  type: "Uniswap V3",
  factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  fee: 100,
  feeDenominator: 1_000_000,
});
const BASE_CHAINLINK = Object.freeze({
  ethUsd: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  decimals: 8,
  maxAgeSeconds: 3600,
});
const OUT_BASE = path.join(WORKSPACE, "reports", "raw", "fast", "cross-dex-arbitrage-base.json");
const COVERAGE_FILES_BASE = Object.freeze({
  Curve: path.join(COVERAGE_DIR, "curve-base-x.json"),
  "Uniswap V3": path.join(COVERAGE_DIR, "uniswap-v3-base-x.json"),
});
// All four sizes return a complete two-leg quote on Base; 100k is depth-limited
// (no edge at the observed pin) and is retained as the documented upper bound.
const BASE_SIZES = Object.freeze([100n, 1_000n, 10_000n, 100_000n]);

const BASE_ROUTE = Object.freeze({
  id: "base-usdc-usdt",
  chainId: 8453,
  label: "USDC/USDT",
  base: BASE_TOKENS.USDC,
  quote: BASE_TOKENS.USDT,
  curve: BASE_CURVE,
  uniswap: BASE_UNISWAP,
  uniToken0: BASE_TOKENS.USDC.address,
  uniToken1: BASE_TOKENS.USDT.address,
  chainlink: BASE_CHAINLINK,
  sizes: BASE_SIZES,
  maxSize: MAX_SIZE_USDC,
  // Conservative Base priority-fee floor (0.1 gwei). Typical observed Base
  // priority fees are 0.001-0.01 gwei, so this is >=~100x norms and never below
  // the 0.05 gwei documented floor. Gas limit is unchanged at 2,000,000.
  gasPolicy: Object.freeze({ priorityFeeWei: 100_000_000n }),
  artifactPath: OUT_BASE,
  coverageFiles: COVERAGE_FILES_BASE,
  localEvidence: Object.freeze([
    "tools/trigger-coverage-universe.json:base-curve-x/base-uniswap-v3-x",
    "read-only Base qualification pin 51508023",
  ]),
  coverageRef: "bounded complete USDC/USDT Curve StableSwap-NG and Uniswap V3 fee-100 round trips at four USDC sizes and one finalized pin (100k depth-limited)",
  nextActionFork: "Run one fixed-pin local-fork atomic USDC/USDT round-trip for the emitted candidate values, including flash repayment, gas, slippage guard, and unwind.",
});

// --- Ethereum Balancer V2 <-> Uniswap V3 route -------------------------------------------
const BALANCER_TOKENS = Object.freeze({
  DAI: Object.freeze({ symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 }),
  USDC: Object.freeze({ symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }),
  USDT: Object.freeze({ symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 }),
});
const BALANCER_V2 = Object.freeze({
  name: "Balancer V2 DAI/USDC/USDT Stable",
  type: "Balancer V2 StablePool",
  vault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
  poolId: "0x06df3b2bbb68adc8b0e302443692037ed9f91b42000000000000000000000063",
  pool: "0x06Df3b2bbB68adc8B0e302443692037ED9f91b42",
  // coin order as returned by Vault.getPoolTokens: DAI(0), USDC(1), USDT(2)
  coins: Object.freeze([BALANCER_TOKENS.DAI.address, BALANCER_TOKENS.USDC.address, BALANCER_TOKENS.USDT.address]),
  // Balancer V2 swap fees are 1e18-scaled. The live pool reported 0.005%.
  feeDenominator: 1_000_000_000_000_000_000n,
  // STANDARD SAME-PIN PROBE (mandatory). Keyless local fork at finalized
  // Ethereum pin 26013013
  // (0x54dadd27aabfcbfe580b5f7c6e072fe5badc8c5990495d658228227a8a44b2ab):
  // `queryBatchSwap` (GIVEN_IN) equals the MINED `Vault.swap` output exactly
  // (0 bps) in both directions at three sizes — USDC->USDT 1e8/1e9/1e10 =
  // 100,010,580 / 1,000,053,151 / 9,991,663,536 and USDT->USDC =
  // 99,978,213 / 999,725,118 / 9,953,396,504. QuoterV2 also equals the mined
  // `exactInputSingle` exactly in both directions. No haircut is declared.
  // Evidence: reports/raw/fast/fork-poc/bal-samepin.json.
  quoteSource: "queryBatchSwap",
  quoteExecutable: true,
});
const BALANCER_UNISWAP = Object.freeze({
  name: "Uniswap V3 USDC/USDT 0.01%",
  type: "Uniswap V3",
  factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  fee: 100,
  feeDenominator: 1_000_000,
});
const OUT_BALANCER = path.join(WORKSPACE, "reports", "raw", "fast", "cross-dex-arbitrage-balancer-v2.json");
const COVERAGE_FILES_BALANCER = Object.freeze({
  "Balancer V2": path.join(COVERAGE_DIR, "balancer-v2-ethereum-x.json"),
});
const FLASH_COVERAGE_REF = "bounded flash-liquidity and fee observation";
const FLASH_COVERAGE_FILE_BALANCER = path.join(COVERAGE_DIR, "balancer-v2-ethereum-f.json");
// The Balancer 3pool holds ~10.7M DAI / 10.9M USDC / 13.7M USDT; 100k USDC is
// well inside depth and is retained as the documented upper bound.
const BALANCER_SIZES = Object.freeze([100n, 1_000n, 10_000n, 100_000n]);

const BALANCER_ROUTE = Object.freeze({
  id: "ethereum-balancer-v2-usdc-usdt",
  chainId: 1,
  venueKind: "balancer-v2",
  label: "USDC/USDT",
  base: BALANCER_TOKENS.USDC,
  quote: BALANCER_TOKENS.USDT,
  balancer: BALANCER_V2,
  uniswap: BALANCER_UNISWAP,
  uniToken0: BALANCER_TOKENS.USDC.address,
  uniToken1: BALANCER_TOKENS.USDT.address,
  chainlink: CHAINLINK,
  sizes: BALANCER_SIZES,
  maxSize: MAX_SIZE_USDC,
  gasPolicy: Object.freeze({ priorityFeeWei: 2_000_000_000n }),
  artifactPath: OUT_BALANCER,
  coverageFiles: COVERAGE_FILES_BALANCER,
  flashCoverageFile: FLASH_COVERAGE_FILE_BALANCER,
  localEvidence: Object.freeze([
    "tools/trigger-coverage-universe.json:ethereum-balancer-v2-x",
    "read-only Ethereum qualification pin 26012949 (Balancer V2 Vault 0xBA12...F2C8, pool 0x06df...0063)",
  ]),
  coverageRef: "bounded complete cross-venue round-trip observation",
  nextActionFork: "Run one fixed-pin local-fork atomic USDC/USDT Balancer V2 <-> Uniswap V3 round-trip for the emitted candidate values, including flash repayment, gas, slippage guard, and unwind.",
});

// --- Base Balancer V2 <-> Uniswap V3 route ------------------------------------------------
const BALANCER_BASE_TOKENS = Object.freeze({
  USDC: BASE_TOKENS.USDC,
  WETH: Object.freeze({ symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 }),
});
const BALANCER_BASE_V2 = Object.freeze({
  name: "Balancer V2 USDC/WETH (pool kind unqualified)",
  // Historical labels are not source/runtime proof of WeightedMath semantics.
  // Observed GYR reverts must not be decoded using the BAL error table.
  type: "Balancer V2 pool (kind unqualified)",
  vault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
  poolId: "0xc205ba80bfe089f364922c3439ee952302c3cd9c000200000000000000000371",
  pool: "0xc205BA80BFE089f364922c3439Ee952302C3CD9c",
  // coin order as returned by Vault.getPoolTokens: WETH(0), USDC(1)
  coins: Object.freeze([BALANCER_BASE_TOKENS.WETH.address, BALANCER_BASE_TOKENS.USDC.address]),
  // Balancer V2 swap fees are 1e18-scaled. The live pool reported 0.1%.
  feeDenominator: 1_000_000_000_000_000_000n,
  // STANDARD SAME-PIN PROBE (mandatory). Keyless local fork at finalized Base pin
  // 51526423
  // (0xd8825744dc2b5b7aadb5551f03700ef381660b28296a5664b08263f50fe9c411):
  // `queryBatchSwap` (GIVEN_IN) equals the MINED `Vault.swap` output exactly
  // (0 bps) in both directions at four sizes — USDC->WETH 1e7/2.5e7/5e7/1e8 and
  // WETH->USDC at the mirrored sizes. QuoterV2 also equals the mined
  // `exactInputSingle` exactly in both directions (0.05% pool). No haircut is
  // declared. Evidence: reports/raw/fast/fork-poc/bal-base-samepin.json.
  quoteSource: "queryBatchSwap",
  quoteExecutable: false,
  quoteQualification: "HISTORICAL_PROBE_ONLY_CURRENT_SOURCE_RUNTIME_UNQUALIFIED",
});
const BALANCER_BASE_UNISWAP = Object.freeze({
  name: "Uniswap V3 USDC/WETH 0.05%",
  type: "Uniswap V3",
  factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  fee: 500,
  feeDenominator: 1_000_000,
});
const OUT_BALANCER_BASE = path.join(WORKSPACE, "reports", "raw", "fast", "cross-dex-arbitrage-balancer-v2-base.json");
const COVERAGE_FILES_BALANCER_BASE = Object.freeze({
  "Balancer V2": path.join(COVERAGE_DIR, "balancer-v2-base-x.json"),
});
const FLASH_COVERAGE_FILE_BALANCER_BASE = path.join(COVERAGE_DIR, "balancer-v2-base-f.json");
// The Base Balancer USDC/WETH pool is shallow (Vault-registered reserves are on
// the order of a few thousand USDC), so the four sizes are depth-appropriate for
// that pool rather than the shared 100k upper bound. Measured price impact stays
// inside ~0.2% across all four sizes at the probe pin.
const BALANCER_BASE_SIZES = Object.freeze([10n, 25n, 50n, 100n]);

const BALANCER_BASE_ROUTE = Object.freeze({
  id: "base-balancer-v2-usdc-weth",
  chainId: 8453,
  venueKind: "balancer-v2",
  label: "USDC/WETH",
  base: BALANCER_BASE_TOKENS.USDC,
  quote: BALANCER_BASE_TOKENS.WETH,
  balancer: BALANCER_BASE_V2,
  uniswap: BALANCER_BASE_UNISWAP,
  uniToken0: BALANCER_BASE_TOKENS.WETH.address,
  uniToken1: BALANCER_BASE_TOKENS.USDC.address,
  chainlink: BASE_CHAINLINK,
  sizes: BALANCER_BASE_SIZES,
  maxSize: MAX_SIZE_USDC,
  // Conservative Base priority-fee floor (0.1 gwei), identical to the Base Curve
  // route: >=~100x typical observed Base priority fees.
  gasPolicy: Object.freeze({ priorityFeeWei: 100_000_000n }),
  artifactPath: OUT_BALANCER_BASE,
  coverageFiles: COVERAGE_FILES_BALANCER_BASE,
  flashCoverageFile: FLASH_COVERAGE_FILE_BALANCER_BASE,
  localEvidence: Object.freeze([
    "tools/trigger-coverage-universe.json:base-balancer-v2-x",
    "read-only Base qualification pin 51526423 (Balancer V2 Vault 0xBA12...F2C8, pool 0xc205...CD9c)",
  ]),
  coverageRef: "bounded complete cross-venue round-trip observation",
  nextActionFork: "Run one fixed-pin local-fork atomic USDC/WETH Balancer V2 <-> Uniswap V3 round-trip for the emitted candidate values, including flash repayment, gas, slippage guard, and unwind.",
});

const NUMBER_WORDS = Object.freeze(["zero", "one", "two", "three", "four"]);
function sizeWord(route) {
  return NUMBER_WORDS[route.sizes.length] || String(route.sizes.length);
}

const ERC20_I = new ethers.Interface([
  "function decimals() view returns (uint8)",
]);
const CURVE_I = new ethers.Interface([
  "function coins(uint256) view returns (address)",
  "function fee() view returns (uint256)",
  "function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)",
]);
const FACTORY_I = new ethers.Interface([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)",
]);
const POOL_I = new ethers.Interface([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);
const QUOTER_I = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const CHAINLINK_I = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);
const BALANCER_VAULT_I = new ethers.Interface([
  "function getPoolTokens(bytes32 poolId) view returns (address[] tokens,uint256[] balances,uint256 lastChangeBlock)",
  "function getPool(bytes32 poolId) view returns (address pool,uint8 specialization)",
  "function queryBatchSwap(uint8 kind,(bytes32 poolId,uint256 assetInIndex,uint256 assetOutIndex,uint256 amount,bytes userData)[] swaps,address[] assets,(address sender,bool fromInternalBalance,address recipient,bool toInternalBalance) funds) returns (int256[] assetDeltas)",
  "function getProtocolFeesCollector() view returns (address)",
]);
// Bounded flash-liquidity/fee observation (F class). The collector owns the
// flash-loan fee; the Vault's own token balance is the flash-liquidity a
// permissionless flashLoan can source at the pin.
const BALANCER_PROTOCOL_FEES_I = new ethers.Interface([
  "function getFlashLoanFeePercentage() view returns (uint256)",
]);
const ERC20_BALANCE_I = new ethers.Interface([
  "function balanceOf(address owner) view returns (uint256)",
]);
const BALANCER_POOL_I = new ethers.Interface([
  "function getPoolId() view returns (bytes32)",
  "function getVault() view returns (address)",
  "function getSwapFeePercentage() view returns (uint256)",
]);

class ScanFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function sanitizeFailure(error) {
  const allowed = new Set([
    "RPC_UNAVAILABLE", "BLOCK_UNAVAILABLE", "CALL_FAILED", "EMPTY_CODE", "ABI_DECODE_FAILED",
    "LOCAL_BINDING_MISMATCH", "CURVE_BINDING_MISMATCH", "UNISWAP_BINDING_MISMATCH", "QUOTE_FAILED",
    "ORACLE_STALE", "ORACLE_INVALID", "BASE_FEE_UNAVAILABLE", "PIN_RECHECK_FAILED",
    "POOL_MAX_IN_RATIO", "QUOTE_REVERT",
  ]);
  return allowed.has(error && error.code) ? error.code : "QUOTE_FAILED";
}

// Retain only an ABI-proven, bounded protocol code, never provider messages/URLs.
// Deployed meaning remains unqualified. Official reference-source mappings are
// retained separately and never substitute for the selected pool's runtime binding.
function quoteRevert(error) {
  if (![3, "CALL_EXCEPTION"].includes(error?.code) && error?.error?.code !== 3) return null;
  const raw = error?.data ?? error?.error?.data;
  if (typeof raw !== "string" || raw.length > 1024 || !/^0x08c379a0[0-9a-f]+$/i.test(raw)) return null;
  try {
    const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], `0x${raw.slice(10)}`);
    if (!/^(?:GYR|BAL)#[0-9]{3}$/.test(reason)) return null;
    return { selector: "0x08c379a0", protocolCode: reason, meaning: "unknown", qualifyingQuote: false,
      ...(reason === "GYR#357" ? { referenceSourceMeaning: "ASSET_BOUNDS_EXCEEDED",
        referenceSource: "gyrostable/concentrated-lps@86c6815c61d223f73b202b3709dd65a2b6b86b42",
        deployedSourceRuntimeBound: false } : {}) };
  } catch (_) { return null; }
}

function validateSizes(sizes, maxSize = MAX_SIZE_USDC) {
  if (!Array.isArray(sizes) || sizes.length === 0 || sizes.length > 4) throw new ScanFailure("LOCAL_BINDING_MISMATCH");
  for (const value of sizes) {
    if (typeof value !== "bigint" || value <= 0n || value > maxSize) throw new ScanFailure("LOCAL_BINDING_MISMATCH");
  }
  return sizes;
}

function formatRaw(value, decimals) {
  return ethers.formatUnits(value, decimals);
}

function grossBps(deltaRaw, inputRaw) {
  const scale = 1_000_000n;
  return Number((deltaRaw * 10_000n * scale) / inputRaw) / Number(scale);
}

function isBalancerRoute(route) {
  return route.venueKind === "balancer-v2";
}

// The venue leg is Curve for the FRAX/Base routes and Balancer V2 for the
// Balancer route. Curve routes return exactly the historical objects.
function venueConfig(route) {
  return isBalancerRoute(route) ? route.balancer : route.curve;
}

function venueLabel(route) {
  return isBalancerRoute(route) ? "Balancer V2" : "Curve";
}

function coinIndex(route, token) {
  const index = venueConfig(route).coins.findIndex((value) => sameAddress(value, token.address));
  if (index < 0) throw new ScanFailure("CURVE_BINDING_MISMATCH");
  return index;
}

function buildRouteLegs(direction, route = ETH_ROUTE) {
  const label = venueLabel(route);
  if (direction === "CURVE_TO_UNIV3") {
    return [
      { venue: label, tokenIn: route.base, tokenOut: route.quote, curveI: coinIndex(route, route.base), curveJ: coinIndex(route, route.quote) },
      { venue: "UniswapV3", tokenIn: route.quote, tokenOut: route.base, fee: route.uniswap.fee },
    ];
  }
  if (direction === "UNIV3_TO_CURVE") {
    return [
      { venue: "UniswapV3", tokenIn: route.base, tokenOut: route.quote, fee: route.uniswap.fee },
      { venue: label, tokenIn: route.quote, tokenOut: route.base, curveI: coinIndex(route, route.quote), curveJ: coinIndex(route, route.base) },
    ];
  }
  throw new ScanFailure("LOCAL_BINDING_MISMATCH");
}

async function executeRoundTrip({ direction, amountInRaw, quoteCurve, quoteUni, curveFeeRaw, route = ETH_ROUTE }) {
  const routeConfig = route || ETH_ROUTE;
  const legsSpec = buildRouteLegs(direction, routeConfig);
  const isVenueLeg = (venue) => venue !== "UniswapV3";
  let amount = amountInRaw;
  const legs = [];
  for (const leg of legsSpec) {
    try {
      const result = isVenueLeg(leg.venue)
        ? await quoteCurve({ i: leg.curveI, j: leg.curveJ, amountInRaw: amount })
        : await quoteUni({ tokenIn: leg.tokenIn.address, tokenOut: leg.tokenOut.address, amountInRaw: amount, fee: leg.fee });
      const amountOutRaw = typeof result === "bigint" ? result : result.amountOutRaw;
      if (typeof amountOutRaw !== "bigint" || amountOutRaw <= 0n) throw new ScanFailure("QUOTE_FAILED");
      legs.push({
        venue: leg.venue,
        tokenIn: leg.tokenIn.symbol,
        tokenOut: leg.tokenOut.symbol,
        amountInRaw: amount.toString(),
        amountIn: formatRaw(amount, leg.tokenIn.decimals),
        amountOutRaw: amountOutRaw.toString(),
        amountOut: formatRaw(amountOutRaw, leg.tokenOut.decimals),
        fee: isVenueLeg(leg.venue)
          ? { raw: curveFeeRaw.toString(), denominator: venueConfig(routeConfig).feeDenominator.toString(), includedInQuote: true }
          : { tier: leg.fee, denominator: routeConfig.uniswap.feeDenominator, bps: leg.fee / 100, includedInQuote: true },
        ...(isVenueLeg(leg.venue) ? { coinInIndex: leg.curveI, coinOutIndex: leg.curveJ } : {}),
        ...(result && typeof result === "object" && result.gasEstimate !== undefined
          ? { quoterGasEstimate: result.gasEstimate.toString() }
          : {}),
      });
      amount = amountOutRaw;
    } catch (error) {
      return {
        direction,
        amountInRaw: amountInRaw.toString(),
        amountIn: formatRaw(amountInRaw, routeConfig.base.decimals),
        legs,
        failedLeg: legs.length + 1,
        failure: sanitizeFailure(error),
        ...(error?.quoteRevert ? { quoteRevert: error.quoteRevert } : {}),
        ...(error?.liquidityDiagnostic ? { liquidityDiagnostic: error.liquidityDiagnostic } : {}),
        classification: "INCOMPLETE",
        grossDeltaRaw: null,
        grossDelta: null,
        grossBps: null,
        flashFee: "unknown",
        gas: "unknown",
        net: "unknown",
        routePositive: "unknown",
      };
    }
  }
  const delta = amount - amountInRaw;
  return {
    direction,
    amountInRaw: amountInRaw.toString(),
    amountIn: formatRaw(amountInRaw, routeConfig.base.decimals),
    amountOutRaw: amount.toString(),
    amountOut: formatRaw(amount, routeConfig.base.decimals),
    legs,
    classification: delta > 0n ? "GROSS_EDGE_FORK_REQUIRED" : "NO_CROSS_VENUE_EDGE",
    grossDeltaRaw: delta.toString(),
    grossDelta: formatRaw(delta, routeConfig.base.decimals),
    grossBps: grossBps(delta, amountInRaw),
    flashFee: "unknown",
    gas: "unknown",
    net: "unknown",
    routePositive: "unknown",
  };
}

async function callDecoded(rpc, target, iface, fn, args, blockTag, rpcCallImpl = rpcCall) {
  const data = iface.encodeFunctionData(fn, args);
  let raw;
  try {
    raw = await rpcCallImpl(rpc, "eth_call", [{ to: target, data }, blockTag], TIMEOUT_MS);
    if (raw?.error) throw raw.error;
  } catch (error) {
    const decoded = quoteRevert(error);
    if (!decoded) throw error;
    const failure = new ScanFailure("QUOTE_REVERT");
    failure.quoteRevert = decoded;
    throw failure;
  }
  if (typeof raw !== "string" || !/^0x[0-9a-f]*$/i.test(raw) || raw === "0x") throw new ScanFailure("CALL_FAILED");
  try {
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    throw new ScanFailure("ABI_DECODE_FAILED");
  }
}

async function requireCode(rpc, address, blockTag, rpcCallImpl = rpcCall) {
  const code = await rpcCallImpl(rpc, "eth_getCode", [address, blockTag], TIMEOUT_MS);
  if (typeof code !== "string" || !/^0x[0-9a-f]+$/i.test(code) || code === "0x") throw new ScanFailure("EMPTY_CODE");
}

async function selectPin(rpc, rpcCallImpl = rpcCall) {
  const block = await rpcCallImpl(rpc, "eth_getBlockByNumber", ["finalized", false], TIMEOUT_MS);
  validatePinBlock(block);
  return { block, blockTag: block.number, finality: "finalized" };
}

function validatePinBlock(block) {
  if (!block || !/^0x[0-9a-f]+$/i.test(block.number || "") || !/^0x[0-9a-f]{64}$/i.test(block.hash || "")) throw new ScanFailure("BLOCK_UNAVAILABLE");
  if (!/^0x[0-9a-f]+$/i.test(block.baseFeePerGas || "")) throw new ScanFailure("BASE_FEE_UNAVAILABLE");
  return true;
}

async function bindRoute(rpc, blockTag, route = ETH_ROUTE, rpcCallImpl = rpcCall) {
  const routeConfig = route || ETH_ROUTE;
  const balancer = isBalancerRoute(routeConfig);
  const venue = venueConfig(routeConfig);
  const venueAddresses = balancer
    ? [venue.vault, venue.pool]
    : [venue.pool];
  for (const address of [routeConfig.base.address, routeConfig.quote.address, ...venueAddresses,
    routeConfig.uniswap.factory, routeConfig.uniswap.quoterV2, routeConfig.chainlink.ethUsd]) {
    await requireCode(rpc, address, blockTag, rpcCallImpl);
  }
  const [baseDecimals] = await callDecoded(rpc, routeConfig.base.address, ERC20_I, "decimals", [], blockTag, rpcCallImpl);
  const [quoteDecimals] = await callDecoded(rpc, routeConfig.quote.address, ERC20_I, "decimals", [], blockTag, rpcCallImpl);
  if (Number(baseDecimals) !== routeConfig.base.decimals || Number(quoteDecimals) !== routeConfig.quote.decimals) {
    throw new ScanFailure("LOCAL_BINDING_MISMATCH");
  }
  let venueFeeRaw;
  let poolBalancesRaw = null;
  let protocolFeesCollector = null;
  if (balancer) {
    const [[poolId], [poolVault], [swapFee]] = await Promise.all([
      callDecoded(rpc, venue.pool, BALANCER_POOL_I, "getPoolId", [], blockTag, rpcCallImpl),
      callDecoded(rpc, venue.pool, BALANCER_POOL_I, "getVault", [], blockTag, rpcCallImpl),
      callDecoded(rpc, venue.pool, BALANCER_POOL_I, "getSwapFeePercentage", [], blockTag, rpcCallImpl),
    ]);
    if (String(poolId).toLowerCase() !== venue.poolId.toLowerCase() || !sameAddress(poolVault, venue.vault)) {
      throw new ScanFailure("CURVE_BINDING_MISMATCH");
    }
    const [tokens, balances] = await callDecoded(rpc, venue.vault, BALANCER_VAULT_I, "getPoolTokens", [venue.poolId], blockTag, rpcCallImpl);
    if (tokens.length !== venue.coins.length || balances.length !== tokens.length
        || !venue.coins.every((expected, index) => sameAddress(tokens[index], expected))) {
      throw new ScanFailure("CURVE_BINDING_MISMATCH");
    }
    const [collector] = await callDecoded(rpc, venue.vault, BALANCER_VAULT_I, "getProtocolFeesCollector", [], blockTag, rpcCallImpl);
    if (!sameAddress(collector, ethers.ZeroAddress)) protocolFeesCollector = ethers.getAddress(collector);
    venueFeeRaw = BigInt(swapFee);
    poolBalancesRaw = Array.from(balances, BigInt);
  } else {
    const [coin0] = await callDecoded(rpc, venue.pool, CURVE_I, "coins", [0], blockTag, rpcCallImpl);
    const [coin1] = await callDecoded(rpc, venue.pool, CURVE_I, "coins", [1], blockTag, rpcCallImpl);
    const [curveFeeRaw] = await callDecoded(rpc, venue.pool, CURVE_I, "fee", [], blockTag, rpcCallImpl);
    if (!sameAddress(coin0, venue.coins[0]) || !sameAddress(coin1, venue.coins[1])) {
      throw new ScanFailure("CURVE_BINDING_MISMATCH");
    }
    venueFeeRaw = BigInt(curveFeeRaw);
  }
  const [pool] = await callDecoded(
    rpc, routeConfig.uniswap.factory, FACTORY_I, "getPool", [routeConfig.base.address, routeConfig.quote.address, routeConfig.uniswap.fee], blockTag, rpcCallImpl,
  );
  if (sameAddress(pool, ethers.ZeroAddress)) throw new ScanFailure("UNISWAP_BINDING_MISMATCH");
  await requireCode(rpc, pool, blockTag, rpcCallImpl);
  const [[poolFactory], [token0], [token1], [poolFee]] = await Promise.all([
    callDecoded(rpc, pool, POOL_I, "factory", [], blockTag, rpcCallImpl),
    callDecoded(rpc, pool, POOL_I, "token0", [], blockTag, rpcCallImpl),
    callDecoded(rpc, pool, POOL_I, "token1", [], blockTag, rpcCallImpl),
    callDecoded(rpc, pool, POOL_I, "fee", [], blockTag, rpcCallImpl),
  ]);
  if (!sameAddress(poolFactory, routeConfig.uniswap.factory)
      || !sameAddress(token0, routeConfig.uniToken0)
      || !sameAddress(token1, routeConfig.uniToken1)
      || Number(poolFee) !== routeConfig.uniswap.fee) {
    throw new ScanFailure("UNISWAP_BINDING_MISMATCH");
  }
  return { pool: ethers.getAddress(pool), curveFeeRaw: venueFeeRaw, protocolFeesCollector, poolBalancesRaw };
}

// Bounded flash-liquidity/fee observation for the Balancer V2 routes. Reads the
// Vault's protocol fee collector flash-loan fee and the Vault's own balance of
// every declared pool coin (the flash-liquidity a permissionless flashLoan can
// source at the pin). Non-fatal to the X observation: a failure is recorded so
// the F binder fails closed instead of invalidating the cross-venue artifact.
async function readFlashLiquidity(rpc, blockTag, route, binding, rpcCallImpl = rpcCall) {
  const venue = route.balancer;
  const errors = [];
  const balances = [];
  let flashFeeRaw = null;
  let attempted = 0;
  let succeeded = 0;
  if (binding.protocolFeesCollector) {
    attempted += 1;
    try {
      const [fee] = await callDecoded(
        rpc, binding.protocolFeesCollector, BALANCER_PROTOCOL_FEES_I, "getFlashLoanFeePercentage", [], blockTag, rpcCallImpl,
      );
      flashFeeRaw = BigInt(fee);
      succeeded += 1;
    } catch (error) { errors.push(sanitizeFailure(error)); }
  } else {
    attempted += 1;
    errors.push("QUOTE_FAILED");
  }
  for (const coin of venue.coins) {
    attempted += 1;
    try {
      const [balance] = await callDecoded(rpc, coin, ERC20_BALANCE_I, "balanceOf", [venue.vault], blockTag, rpcCallImpl);
      balances.push({ token: coin, balanceRaw: BigInt(balance).toString() });
      succeeded += 1;
    } catch (error) { errors.push(sanitizeFailure(error)); }
  }
  return {
    protocolFeesCollector: binding.protocolFeesCollector,
    flashFeeRaw: flashFeeRaw === null ? null : flashFeeRaw.toString(),
    flashFeeBps: flashFeeRaw === null ? null : Number(flashFeeRaw) / 1e16,
    balances,
    reads: { attempted, succeeded, failed: attempted - succeeded, unclassifiedFailures: 0 },
    errors: [...new Set(errors)],
  };
}

async function readOracle(rpc, blockTag, blockTimestamp, rpcCallImpl = rpcCall, chainlink = CHAINLINK) {
  const [decimals] = await callDecoded(rpc, chainlink.ethUsd, CHAINLINK_I, "decimals", [], blockTag, rpcCallImpl);
  const [roundId, answer, , updatedAt, answeredInRound] = await callDecoded(rpc, chainlink.ethUsd, CHAINLINK_I, "latestRoundData", [], blockTag, rpcCallImpl);
  const age = validateOracleRound({ decimals: Number(decimals), roundId, answer, updatedAt, answeredInRound, blockTimestamp }, chainlink);
  return { feed: chainlink.ethUsd, decimals: chainlink.decimals, ethUsdRaw: answer.toString(), updatedAtRaw: updatedAt.toString(), ageSeconds: Number(age) };
}

function validateOracleRound({ decimals, roundId, answer, updatedAt, answeredInRound, blockTimestamp }, chainlink = CHAINLINK) {
  if (decimals !== chainlink.decimals || answer <= 0n || updatedAt <= 0n || answeredInRound < roundId || updatedAt > blockTimestamp + 60n) throw new ScanFailure("ORACLE_INVALID");
  const age = blockTimestamp - updatedAt;
  if (age > BigInt(chainlink.maxAgeSeconds)) throw new ScanFailure("ORACLE_STALE");
  return age;
}

function selectors(route = ETH_ROUTE) {
  const base = {
    curveGetDy: CURVE_I.getFunction("get_dy").selector,
    curveCoins: CURVE_I.getFunction("coins").selector,
    curveFee: CURVE_I.getFunction("fee").selector,
    factoryGetPool: FACTORY_I.getFunction("getPool").selector,
    quoterV2ExactInputSingle: QUOTER_I.getFunction("quoteExactInputSingle").selector,
  };
  // Balancer selectors are added only for the Balancer route so the Curve
  // routes keep byte-identical selector sets.
  if (isBalancerRoute(route)) {
    return {
      ...base,
      balancerQueryBatchSwap: BALANCER_VAULT_I.getFunction("queryBatchSwap").selector,
      balancerGetPoolTokens: BALANCER_VAULT_I.getFunction("getPoolTokens").selector,
    };
  }
  return base;
}

async function scan(options = {}) {
  const route = options.route || ETH_ROUTE;
  const rpcCallImpl = options.rpcCall || rpcCall;
  // Default to an endpoint-qualified resolver so a degraded shared endpoint
  // cannot silently fail the observation; injected resolvers are unchanged.
  const resolveRpcImpl = options.resolveRpc || resolveWorkingRpc;
  const directions = ["CURVE_TO_UNIV3", "UNIV3_TO_CURVE"];
  validateSizes(route.sizes, route.maxSize);
  const rpc = await resolveRpcImpl(route.chainId);
  if (!rpc) throw new ScanFailure("RPC_UNAVAILABLE");
  const { block, blockTag, finality } = await selectPin(rpc, rpcCallImpl);
  const binding = await bindRoute(rpc, blockTag, route, rpcCallImpl);
  const blockTimestampRaw = BigInt(block.timestamp);
  const oracle = await readOracle(rpc, blockTag, blockTimestampRaw, rpcCallImpl, route.chainlink);
  const flashObservation = isBalancerRoute(route)
    ? await readFlashLiquidity(rpc, blockTag, route, binding, rpcCallImpl)
    : null;
  const quoteCurve = async ({ i, j, amountInRaw }) => {
    if (isBalancerRoute(route)) {
      const venue = route.balancer;
      // WeightedMath caps fee-adjusted GIVEN_IN at 30% of the input reserve.
      // A formerly liquid pool can be withdrawn to dust while code/bindings
      // remain unchanged. Report that exact capacity blocker, not a generic
      // transport failure, and never manufacture a successful/zero quote.
      // Source: targets/raft/lib/balancer-v2-monorepo/pkg/pool-weighted/contracts/WeightedMath.sol.
      if (venue.type === "Balancer V2 WeightedPool" && binding.poolBalancesRaw) {
        const fee = (amountInRaw * binding.curveFeeRaw + venue.feeDenominator - 1n) / venue.feeDenominator;
        if (amountInRaw - fee > binding.poolBalancesRaw[i] * 3n / 10n) {
          throw new ScanFailure("POOL_MAX_IN_RATIO");
        }
      }
      // assetInIndex/assetOutIndex index into the supplied assets array, which
      // is the pool's own coin list, so i/j are the pool coin indices directly.
      let raw;
      try { raw = await callDecoded(rpc, venue.vault, BALANCER_VAULT_I, "queryBatchSwap", [0,
        [{ poolId: venue.poolId, assetInIndex: i, assetOutIndex: j, amount: amountInRaw, userData: "0x" }],
        [...venue.coins],
        [ethers.ZeroAddress, false, ethers.ZeroAddress, false]], blockTag, options.quoteRpcCall || rpcCallImpl);
      } catch (error) {
        const failure = error instanceof Error ? error : new ScanFailure("QUOTE_FAILED");
        if (binding.poolBalancesRaw) failure.liquidityDiagnostic = {
          inputReserveRaw: binding.poolBalancesRaw[i].toString(),
          outputReserveRaw: binding.poolBalancesRaw[j].toString(),
          inputExceedsRegisteredReserve: amountInRaw > binding.poolBalancesRaw[i],
          poolKind: venue.type,
          // Reserve dust is observed, but a source-unknown GYR revert is not no-edge proof.
          interpretation: "REGISTERED_RESERVES_ONLY_NOT_REVERT_CAUSAL_PROOF",
        };
        throw failure;
      }
      const [deltas] = raw;
      // queryBatchSwap returns signed deltas from the sender's perspective:
      // the out-asset delta is negative by the amount received.
      const out = -BigInt(deltas[j]);
      if (out <= 0n) throw new ScanFailure("QUOTE_FAILED");
      return out;
    }
    const [amountOutRaw] = await callDecoded(rpc, route.curve.pool, CURVE_I, "get_dy", [i, j, amountInRaw], blockTag, rpcCallImpl);
    return BigInt(amountOutRaw);
  };
  const quoteUni = async ({ tokenIn, tokenOut, amountInRaw, fee }) => {
    if (fee !== route.uniswap.fee) throw new ScanFailure("LOCAL_BINDING_MISMATCH");
    const [amountOutRaw, sqrtPriceX96After, initializedTicksCrossed, gasEstimate] = await callDecoded(
      rpc,
      route.uniswap.quoterV2,
      QUOTER_I,
      "quoteExactInputSingle",
      [{ tokenIn, tokenOut, amountIn: amountInRaw, fee, sqrtPriceLimitX96: 0n }],
      blockTag,
      rpcCallImpl,
    );
    return { amountOutRaw: BigInt(amountOutRaw), sqrtPriceX96After, initializedTicksCrossed, gasEstimate };
  };
  const rows = [];
  for (const size of route.sizes) {
    const amountInRaw = size * 10n ** BigInt(route.base.decimals);
    for (const direction of directions) {
      rows.push(await executeRoundTrip({ direction, amountInRaw, quoteCurve, quoteUni, curveFeeRaw: binding.curveFeeRaw, route }));
    }
  }
  const observedAt = new Date().toISOString();
  const blockTimestamp = Number(BigInt(block.timestamp));
  const pin = {
    number: Number(BigInt(block.number)),
    hash: block.hash,
    stateRoot: block.stateRoot || null,
    timestamp: new Date(blockTimestamp * 1000).toISOString(),
    finality,
    baseFeePerGasRaw: BigInt(block.baseFeePerGas).toString(),
  };
  const venue = venueConfig(route);
  const preliminary = {
    chainId: route.chainId, scannedAt: observedAt, pin, oracle, rows,
    gasPolicy: { priorityFeeWei: route.gasPolicy.priorityFeeWei.toString() },
    routeBinding: {
      // The economics gate reads `routeBinding.curve.pool` as the route key.
      // Curve routes bind the Curve pool; the Balancer route binds the Balancer
      // pool here so the same, byte-identical economics module applies.
      curve: {
        pool: venue.pool,
        ...(venue.quoteInflationBps !== undefined ? { quoteInflationBps: venue.quoteInflationBps } : {}),
      },
      uniswapV3: { pool: binding.pool },
    },
  };
  const economic = economics.evaluateScan(preliminary);
  const economicByEvent = new Map(economic.rows.map((row) => [`${row.direction}|${row.amountInRaw}`, row]));
  const evaluatedRows = rows.map((row) => ({ ...row, economics: economicByEvent.get(`${row.direction}|${row.amountInRaw}`) }));
  const forkCandidates = evaluatedRows.filter(row => row.economics.status === "ATOMIC_FORK_REQUIRED").map(row => {
    // The fork target is the EFFECTIVE (haircut-adjusted) output, not the raw
    // quoted view output: the route's `quoteInflationBps` is subtracted here too
    // so the emitted candidate's minimumFinalUsdc is achievable rather than
    // guaranteed to revert on the measured view/executable divergence. The
    // executor still independently requires finalUsdc > principal, so a
    // suppressed phantom can never become positive. Routes without an active
    // haircut keep byte-identical candidate fields.
    const quotedOutRaw = BigInt(row.amountOutRaw);
    const haircutRaw = row.economics.quoteInflationRaw !== undefined ? BigInt(row.economics.quoteInflationRaw) : 0n;
    const effectiveOutRaw = quotedOutRaw > haircutRaw ? quotedOutRaw - haircutRaw : 0n;
    const haircutAudit = haircutRaw > 0n
      ? {
        quotedExpectedOutRawAtPin: row.amountOutRaw,
        quotedGrossDeltaRawAtPin: row.grossDeltaRaw,
        quoteInflationRawAtPin: row.economics.quoteInflationRaw,
        quoteInflationBps: row.economics.quoteInflationBps,
      }
      : {};
    // Curve routes keep the historical `curve` object byte-identically. The
    // Balancer route emits a `balancer` object instead (plus the same pool in
    // `curve.pool` so shared consumers keep a stable route-key anchor).
    const venueBinding = isBalancerRoute(route)
      ? { balancer: { vault: route.balancer.vault, poolId: route.balancer.poolId, pool: route.balancer.pool, coins: [...route.balancer.coins] } }
      : { curve: { pool: route.curve.pool, coin0: route.curve.coins[0], coin1: route.curve.coins[1] } };
    return {
      direction: row.direction,
      amountInRaw: row.amountInRaw,
      amountInUsdc: row.amountIn,
      expectedOutRawAtPin: effectiveOutRaw.toString(),
      grossDeltaRawAtPin: row.economics.grossDeltaRaw,
      ...haircutAudit,
      curve: { pool: venue.pool, coin0: venue.coins[0], coin1: venue.coins[1] },
      ...venueBinding,
      uniswapV3: { factory: route.uniswap.factory, pool: binding.pool, quoterV2: route.uniswap.quoterV2, fee: route.uniswap.fee },
      blockPin: pin,
      oracle,
      routeKey: row.economics.routeKey,
      eventId: row.economics.eventId,
      gasCeilingUsdcRaw: row.economics.gasCeilingUsdcRaw,
    };
  });
  const recheck = await rpcCallImpl(rpc, "eth_getBlockByHash", [block.hash, false], TIMEOUT_MS);
  if (!recheck || String(recheck.hash).toLowerCase() !== String(block.hash).toLowerCase() || recheck.number !== block.number) throw new ScanFailure("PIN_RECHECK_FAILED");
  return {
    schemaVersion: 2,
    scannedAt: observedAt,
    scanner: "tools/scan-cross-dex-arbitrage.js",
    routeId: route.id,
    safety: { readOnly: true, signedActions: false, transactions: false, approvals: false, swaps: false, endpointMaterialPersisted: false },
    chainId: route.chainId,
    pin,
    oracle,
    ...(binding.poolBalancesRaw ? { poolLiquidity: {
      tokens: [...route.balancer.coins],
      balancesRaw: binding.poolBalancesRaw.map(String),
      ...(route.balancer.type === "Balancer V2 WeightedPool" ? { maxInRatioBps: 3000 } : {}),
    } } : {}),
    ...(flashObservation ? { flashObservation } : {}),
    freshness: {
      observedAt,
      blockAgeSecondsAtObservation: Math.max(0, Math.floor(Date.parse(observedAt) / 1000) - blockTimestamp),
      fixedPinUsedForEveryCall: true,
    },
    localEvidence: route.localEvidence,
    routeBinding: isBalancerRoute(route)
      ? {
        tokens: { base: route.base, quote: route.quote },
        balancer: { ...route.balancer, feeDenominator: route.balancer.feeDenominator.toString(), feeRawAtPin: binding.curveFeeRaw.toString(), feeBpsAtPin: Number(binding.curveFeeRaw) / 1e16 },
        uniswapV3: { ...route.uniswap, pool: binding.pool },
        selectors: selectors(route),
        runtimeChecksAtPin: { tokenDecimals: true, curveCoinOrdering: true, uniswapPoolImmutables: true, codePresent: true },
      }
      : {
        tokens: { base: route.base, quote: route.quote },
        curve: { ...route.curve, feeDenominator: route.curve.feeDenominator.toString(), feeRawAtPin: binding.curveFeeRaw.toString(), feeBpsAtPin: Number(binding.curveFeeRaw) / 1_000_000 },
        uniswapV3: { ...route.uniswap, pool: binding.pool },
        selectors: selectors(route),
        runtimeChecksAtPin: { tokenDecimals: true, curveCoinOrdering: true, uniswapPoolImmutables: true, codePresent: true },
      },
    methodology: {
      sizesUsdc: route.sizes.map(String),
      directions,
      completeRoundTripsOnly: true,
      venueQuotesIncludeVenueFees: true,
      feeDoubleCounting: false,
      flashFee: "0",
      gas: "bounded-ceiling",
      net: "unknown",
      routePositive: "unknown",
    },
    rows: evaluatedRows,
    economics: economic,
    grossPositiveRows: forkCandidates.length,
    forkCandidates,
    routePositive: "unknown",
    executableNow: "unknown",
    nextAction: forkCandidates.length > 0
      ? route.nextActionFork
      : "No fork: refresh the same bounded complete round-trip scan only after material state movement.",
  };
}

// One injected, hash-canonical current quote. This does NOT call scan(), resolve
// endpoints, publish, or change the finalized eight-row watcher contract.
async function quoteBase1000AtPin({ pin, rpc, rpcCall: read, now = Date.now } = {}) {
  const startedAtMs = now(), h32 = v => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
  const qty = v => typeof v === "string" && /^0x[0-9a-f]+$/i.test(v);
  if (!pin || Object.keys(pin).sort().join() !== "chainId,hash,number,stateRoot,timestamp" || pin.chainId !== 8453
    || !Number.isSafeInteger(pin.number) || pin.number <= 0 || !h32(pin.hash) || !h32(pin.stateRoot)
    || typeof pin.timestamp !== "string" || !/^[1-9][0-9]{0,12}$/.test(pin.timestamp)
    || !Number.isSafeInteger(Number(pin.timestamp) * 1000) || typeof read !== "function") throw new ScanFailure("LOCAL_BINDING_MISMATCH");
  pin = Object.freeze({ ...pin });
  const route = BASE_ROUTE, pool = "0xd56da2b74ba826f19015e6b7dd9dae1903e85da1";
  const allowed = new Set([route.base.address, route.quote.address, route.curve.pool, route.uniswap.factory,
    route.uniswap.quoterV2, route.chainlink.ethUsd, pool].map(a => a.toLowerCase()));
  const ref = Object.freeze({ blockHash: pin.hash, requireCanonical: true }), blockNumber = `0x${pin.number.toString(16)}`, runtime = {};
  const stateRead = async (opaque, method, params) => {
    if (opaque !== rpc || !["eth_getCode", "eth_call"].includes(method) || params.length !== 2 || params[1] !== ref
      || !allowed.has(String(method === "eth_call" ? params[0]?.to : params[0]).toLowerCase())) throw new ScanFailure("LOCAL_BINDING_MISMATCH");
    const result = await read(rpc, method, params, TIMEOUT_MS);
    if (method === "eth_getCode") {
      if (typeof result !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(result)) throw new ScanFailure("EMPTY_CODE");
      runtime[params[0].toLowerCase()] = ethers.keccak256(result);
    }
    return result;
  };
  const header = async () => {
    const b = await read(rpc, "eth_getBlockByNumber", [blockNumber, false], TIMEOUT_MS);
    if (!b || !qty(b.number) || BigInt(b.number) !== BigInt(pin.number) || !h32(b.hash) || b.hash.toLowerCase() !== pin.hash.toLowerCase()
      || !h32(b.stateRoot) || b.stateRoot.toLowerCase() !== pin.stateRoot.toLowerCase() || !qty(b.timestamp)
      || BigInt(b.timestamp) !== BigInt(pin.timestamp)) throw new ScanFailure("PIN_RECHECK_FAILED");
    return b;
  };
  try {
    const block = await header(), binding = await bindRoute(rpc, ref, route, stateRead);
    if (!sameAddress(binding.pool, pool)) throw new ScanFailure("UNISWAP_BINDING_MISMATCH");
    const oracle = await readOracle(rpc, ref, BigInt(pin.timestamp), stateRead, route.chainlink);
    const row = await executeRoundTrip({ direction: "UNIV3_TO_CURVE", amountInRaw: 1000000000n, route, curveFeeRaw: binding.curveFeeRaw,
      quoteUni: async ({ tokenIn, tokenOut, amountInRaw, fee }) => {
        const [amountOutRaw, , , gasEstimate] = await callDecoded(rpc, route.uniswap.quoterV2, QUOTER_I, "quoteExactInputSingle",
          [{ tokenIn, tokenOut, amountIn: amountInRaw, fee, sqrtPriceLimitX96: 0n }], ref, stateRead);
        return { amountOutRaw: BigInt(amountOutRaw), gasEstimate };
      },
      quoteCurve: async ({ i, j, amountInRaw }) => BigInt((await callDecoded(rpc, route.curve.pool, CURVE_I, "get_dy", [i, j, amountInRaw], ref, stateRead))[0]),
    });
    await header(); // by NUMBER: an old hash can remain retrievable after a reorg
    const baseFeeWei = qty(block.baseFeePerGas) ? BigInt(block.baseFeePerGas).toString() : null;
    const economic = economics.evaluateRow(row, { chainId: 8453, curvePool: route.curve.pool, uniPool: pool, blockHash: pin.hash,
      baseFeeWei: baseFeeWei === null ? undefined : baseFeeWei, ethUsdRaw: oracle.ethUsdRaw, priorityFeeWei: route.gasPolicy.priorityFeeWei,
      quoteInflationBps: 60 });
    const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
    return freeze({ schema: "base-usdc-usdt-current-quote/v1", status: row.classification === "INCOMPLETE" ? "UNKNOWN" : "OBSERVED",
      pin, row, oracle, runtime, economics: economic, pricing: { ethUsdRaw: oracle.ethUsdRaw, baseFeeWei, priorityFeeWei: route.gasPolicy.priorityFeeWei.toString() },
      startedAtMs, endedAtMs: now(), productionQuoteInflationBpsUnchanged: 60, routePositive: "unknown", liveReady: false });
  } catch (error) { throw new ScanFailure(sanitizeFailure(error)); }
}

function coverageEvidence(artifact, family, route = ETH_ROUTE) {
  const routeConfig = route || ETH_ROUTE;
  if (routeConfig.id === BALANCER_BASE_ROUTE.id) {
    const expected = routeConfig.sizes.length * 2;
    const keys = new Set(artifact.rows.map(row => `${row.direction}|${row.amountInRaw}`));
    const enumerated = artifact.chainId === 8453 && artifact.rows.length === expected && keys.size === expected
      && routeConfig.sizes.every(size => ["CURVE_TO_UNIV3", "UNIV3_TO_CURVE"].every(direction =>
        keys.has(`${direction}|${size * 10n ** 6n}`)));
    const succeeded = artifact.rows.filter(row => ["GROSS_EDGE_FORK_REQUIRED", "NO_CROSS_VENUE_EDGE"].includes(row.classification)
      && row.legs?.length === 2 && ["NO_GROSS_EDGE", "ATOMIC_FORK_REQUIRED", "GROSS_EDGE_NET_BLOCKED"].includes(row.economics?.status)).length;
    return {
      schema: "trigger-coverage-evidence/v1", observedAt: artifact.scannedAt,
      chainId: 8453, family, triggerClass: "X",
      enumeration: { kind: "BOUNDED_ARTIFACT", ref: routeConfig.coverageRef, boundDeclared: true, successful: enumerated },
      reads: { attempted: artifact.rows.length, succeeded, failed: artifact.rows.length - succeeded, unclassifiedFailures: 0 },
      classSemantics: { triggerClass: "X", exact: false }, coverage: { complete: false },
      onFire: { economics: false, keylessFixedPinFork: false, alert: false }, dispatchEnabled: false,
      evidence: [`${relPosix(routeConfig.artifactPath)}#rows`, "Base pool kind/current runtime semantics remain unqualified; historical probe is not current execution proof"],
      blockers: ["Current Base pool source/runtime qualification required", ...(!enumerated ? ["bounded direction/size enumeration incomplete"] : []),
        ...(succeeded !== expected ? ["failed/reverting quotes are not successful round trips"] : []), "current economics/fork/alert qualification not established"],
    };
  }
  const failed = artifact.rows.filter((row) => row.economics.status === "FAILED").length;
  const expected = routeConfig.sizes.length * 2;
  return {
    schema: "trigger-coverage-evidence/v1",
    observedAt: artifact.scannedAt,
    chainId: routeConfig.chainId,
    family,
    triggerClass: "X",
    enumeration: {
      kind: "BOUNDED_ARTIFACT",
      ref: routeConfig.coverageRef,
      boundDeclared: true,
      successful: failed === 0 && artifact.rows.length === expected,
    },
    reads: { attempted: expected, succeeded: expected - failed, failed, unclassifiedFailures: 0 },
    classSemantics: { triggerClass: "X", exact: true },
    coverage: { complete: failed === 0 && artifact.rows.length === expected },
    onFire: { economics: true, keylessFixedPinFork: true, alert: true },
    dispatchEnabled: true,
    evidence: [
      `${relPosix(routeConfig.artifactPath)}#rows`,
      `finalized pin ${artifact.pin.number} hash ${artifact.pin.hash}`,
      `${sizeWord(routeConfig)} exact USDC sizes in both ${venueLabel(routeConfig)}-to-UniswapV3 and UniswapV3-to-${venueLabel(routeConfig)} directions`,
    ],
    blockers: [],
  };
}

function flashCoverageEvidence(artifact, route = ETH_ROUTE) {
  const routeConfig = route || ETH_ROUTE;
  const observation = artifact.flashObservation || null;
  const reads = observation && observation.reads
    ? observation.reads
    : { attempted: 0, succeeded: 0, failed: 0, unclassifiedFailures: 0 };
  const complete = Boolean(observation) && reads.attempted > 0 && reads.failed === 0
    && reads.succeeded === reads.attempted && observation.flashFeeRaw !== null;
  const balances = observation && Array.isArray(observation.balances) ? observation.balances : [];
  const blockers = complete ? [] : ["bounded Balancer V2 flash-liquidity/fee observation is incomplete"];
  if (observation && Array.isArray(observation.errors) && observation.errors.length) {
    blockers.push(`flash observation errors: ${observation.errors.join(", ")}`);
  }
  return {
    schema: "trigger-coverage-evidence/v1",
    observedAt: artifact.scannedAt,
    chainId: routeConfig.chainId,
    family: "Balancer V2",
    triggerClass: "F",
    enumeration: {
      kind: "BOUNDED_ARTIFACT",
      ref: FLASH_COVERAGE_REF,
      boundDeclared: true,
      successful: complete,
    },
    reads,
    classSemantics: { triggerClass: "F", exact: true },
    coverage: { complete },
    onFire: { economics: true, keylessFixedPinFork: true, alert: true },
    dispatchEnabled: complete,
    evidence: [
      `${relPosix(routeConfig.artifactPath)}#flashObservation`,
      `finalized pin ${artifact.pin.number} hash ${artifact.pin.hash}`,
      `Balancer V2 Vault flash-loan fee ${observation ? observation.flashFeeBps : "unknown"} bps (collector ${observation && observation.protocolFeesCollector ? observation.protocolFeesCollector : "unbound"})`,
      `vault token balances observed for ${balances.length}/${routeConfig.balancer.coins.length} declared pool coins`,
    ],
    blockers,
  };
}

function relPosix(target) {
  return path.relative(WORKSPACE, target).split(path.sep).join("/");
}

function publish(artifact, options = {}) {
  const route = options.route || ETH_ROUTE;
  const fsImpl = options.fsImpl || fs;
  const out = options.outPath || route.artifactPath;
  const coverageFiles = options.coverageFiles || route.coverageFiles;
  fsImpl.mkdirSync(path.dirname(out), { recursive: true });
  for (const target of Object.values(coverageFiles)) fsImpl.mkdirSync(path.dirname(target), { recursive: true });
  fsImpl.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
  for (const family of Object.keys(coverageFiles)) fsImpl.writeFileSync(coverageFiles[family], `${JSON.stringify(coverageEvidence(artifact, family, route), null, 2)}\n`);
  if (route.flashCoverageFile && artifact.flashObservation) {
    fsImpl.mkdirSync(path.dirname(route.flashCoverageFile), { recursive: true });
    fsImpl.writeFileSync(route.flashCoverageFile, `${JSON.stringify(flashCoverageEvidence(artifact, route), null, 2)}\n`);
  }
  return artifact;
}

async function main() {
  const artifact = await scan();
  publish(artifact);
  for (const row of artifact.rows) {
    console.log(`${row.amountIn} USDC ${row.direction}: ${row.economics.status} grossBps=${row.grossBps === null ? "unknown" : row.grossBps}`);
  }
  console.log(`Pinned ${artifact.pin.finality} block ${artifact.pin.number}; gross-positive rows=${artifact.grossPositiveRows}`);
}

module.exports = {
  TOKENS,
  CURVE,
  UNISWAP,
  CHAINLINK,
  SIZE_USDC,
  MAX_SIZE_USDC,
  OUT,
  OUT_BASE,
  COVERAGE_FILES,
  COVERAGE_FILES_BASE,
  LOCAL_EVIDENCE,
  BASE_TOKENS,
  BASE_CURVE,
  BASE_UNISWAP,
  BASE_CHAINLINK,
  BASE_SIZES,
  ETH_ROUTE,
  BASE_ROUTE,
  BALANCER_TOKENS,
  BALANCER_V2,
  BALANCER_UNISWAP,
  BALANCER_SIZES,
  BALANCER_ROUTE,
  OUT_BALANCER,
  COVERAGE_FILES_BALANCER,
  BALANCER_BASE_TOKENS,
  BALANCER_BASE_V2,
  BALANCER_BASE_UNISWAP,
  BALANCER_BASE_SIZES,
  BALANCER_BASE_ROUTE,
  OUT_BALANCER_BASE,
  COVERAGE_FILES_BALANCER_BASE,
  isBalancerRoute,
  venueConfig,
  venueLabel,
  buildRouteLegs,
  executeRoundTrip,
  grossBps,
  sanitizeFailure,
  quoteRevert,
  callDecoded,
  selectors,
  validateSizes,
  selectPin,
  validatePinBlock,
  bindRoute,
  readOracle,
  validateOracleRound,
  coverageEvidence,
  flashCoverageEvidence,
  readFlashLiquidity,
  FLASH_COVERAGE_REF,
  FLASH_COVERAGE_FILE_BALANCER,
  FLASH_COVERAGE_FILE_BALANCER_BASE,
  publish,
  scan,
  quoteBase1000AtPin,
};

if (require.main === module) {
  main().catch(error => {
    console.error(`cross-dex scan failed: ${sanitizeFailure(error)}`);
    process.exitCode = 1;
  });
}
