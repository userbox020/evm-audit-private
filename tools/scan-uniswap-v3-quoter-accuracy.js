#!/usr/bin/env node
// Uniswap V3 QuoterV2 accuracy check — live chain only, no fork.
// Reads quotes for the top pairs used in lending exit models.
// Compares against what pool state suggests. RPC URLs in memory only.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "uniswap-v3-quoter-accuracy.json");
const CHAIN_ID = 1; const TIMEOUT_MS = 15000;

const QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";

// QuoterV2 uses tuple parameter (from E8 evaluator pattern)
const QUOTER_IFACE = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);

// Pool ABI for reading current sqrtPrice
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];

const PAIRS = [
  { tokenIn: WETH, tokenOut: USDC, fee: 500, label: "WETH→USDC 0.05%", decimalsIn: 18, decimalsOut: 6 },
  { tokenIn: WETH, tokenOut: USDC, fee: 3000, label: "WETH→USDC 0.3%", decimalsIn: 18, decimalsOut: 6 },
  { tokenIn: WSTETH, tokenOut: WETH, fee: 100, label: "wstETH→WETH 0.01%", decimalsIn: 18, decimalsOut: 18 },
  { tokenIn: USDC, tokenOut: USDT, fee: 100, label: "USDC→USDT 0.01%", decimalsIn: 6, decimalsOut: 6 },
  { tokenIn: USDC, tokenOut: USDT, fee: 500, label: "USDC→USDT 0.05%", decimalsIn: 6, decimalsOut: 6 },
];

const FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];

function round(v,d=6){const n=typeof v==="number"?v:Number(String(v).replace(/[$,%_\\s]/g,""));if(!Number.isFinite(n))return null;const f=10**d;return Math.round(n*f)/f}

main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
