#!/usr/bin/env node
// scan-pancakeswap-amm-phase0.js - bounded read-only Phase 0 for PancakeSwap AMM V2-style pair/LP consumer joins.
// Reuses the vetted V2 Phase 0 scanner logic with Pancake-specific factories and metadata.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BASE = path.join(__dirname, "scan-uniswap-v2-phase0.js");

const PANCAKE_CHAINS = `const CHAINS = {
  1: {
    name: "Ethereum", llamaNames: ["Ethereum"], coinSlug: "ethereum", factory: "0x1097053Fd2ea711dad45caCcc45EfF7548fCB362", router: null,
    coreAssets: {
      WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7", DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F", WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" },
  },
  56: {
    name: "BNB Chain", llamaNames: ["Binance", "BSC", "BNB"], coinSlug: "bsc", factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73", router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    coreAssets: {
      WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", USDT: "0x55d398326f99059fF775485246999027B3197955", USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", ETH: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", BTCB: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", FDUSD: "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409", CAKE: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82" },
  },
  8453: {
    name: "Base", llamaNames: ["Base"], coinSlug: "base", factory: "0x02a84c1b3bbd7401a5f7fa98a384ebc70bb5749e", router: null,
    coreAssets: {
      WETH: "0x4200000000000000000000000000000000000006", USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" },
  },
  42161: {
    name: "Arbitrum", llamaNames: ["Arbitrum"], coinSlug: "arbitrum", factory: "0x02a84c1b3bbd7401a5f7fa98a384ebc70bb5749e", router: null,
    coreAssets: {
      WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", WBTC: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" },
  },
  59144: {
    name: "Linea", llamaNames: ["Linea"], coinSlug: "linea", factory: "0x02a84c1b3bbd7401a5f7fa98a384ebc70bb5749e", router: null,
    coreAssets: {
      WETH: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5CF34f", USDC: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", USDT: "0xA219439258ca9da29E9Cc4cE5596924745e12B93", WBTC: "0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4" },
  },
};`;

function replaceBlock(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`Unable to replace block ${startMarker}`);
  return `${source.slice(0, start)}${replacement}\n\n${source.slice(end)}`;
}

let source = fs.readFileSync(BASE, "utf8");

source = source
  .replace(/scan-uniswap-v2-phase0\.js/g, "scan-pancakeswap-amm-phase0.js")
  .replace(/uniswap-v2-phase0/g, "pancakeswap-amm-phase0")
  .replace(/UNISWAP_V2/g, "PANCAKESWAP_AMM")
  .replace(/Uniswap V2/g, "PancakeSwap AMM")
  .replace(/uniswap-v2/g, "pancakeswap-amm")
  .replace(/Uniswap-specific/g, "PancakeSwap-specific")
  .replace(/https:\/\/raw\.githubusercontent\.com\/DefiLlama\/DefiLlama-Adapters\/main\/projects\/pancakeswap-amm\/index\.js/g, "https://api.llama.fi/protocol/pancakeswap-amm")
  .replace(/https:\/\/github\.com\/Uniswap\/v2-core/g, "https://github.com/pancakeswap/pancake-swap-core")
  .replace(/https:\/\/github\.com\/Uniswap\/v2-periphery/g, "https://github.com/pancakeswap/pancake-swap-periphery")
  .replace(/evm-audit-pancakeswap-amm-phase0\/1\.0/g, "evm-audit-pancakeswap-amm-phase0/1.0");

source = replaceBlock(source, "const CHAINS = {", "const UNSUPPORTED_PROTOCOL_CHAINS", PANCAKE_CHAINS);
source = source.replace(
  /const UNSUPPORTED_PROTOCOL_CHAINS = \[[^\]]*\];/,
  'const UNSUPPORTED_PROTOCOL_CHAINS = ["Aptos", "zkSync Era", "Op_Bnb", "Polygon zkEVM", "Monad"];'
);
vm.runInNewContext(source, {
  require,
  console,
  process,
  __dirname,
  __filename,
  Buffer,
  setTimeout,
  clearTimeout,
  AbortController,
  fetch,
}, { filename: "scan-pancakeswap-amm-phase0.generated.js" });
