#!/usr/bin/env node
// scan-pancakeswap-amm-v3-phase0.js - bounded read-only Phase 0 for PancakeSwap AMM V3 pool/TWAP consumer joins.
// Reuses the vetted Uniswap V3 Phase 0 scanner logic with PancakeSwap V3-specific factories, fee tiers, and metadata.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BASE = path.join(__dirname, "scan-uniswap-v3-phase0.js");

const PANCAKE_V3_CHAINS = `const PANCAKE_V3_FACTORY = "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865";
const CHAINS = {
  1: { name: "Ethereum", llamaNames: ["Ethereum"], coinSlug: "ethereum", factory: PANCAKE_V3_FACTORY, coreAssets: { WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7", DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F", WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", CAKE: "0x152649eA73beAb28c5b49B26eb48f7EAD6d4c898" } },
  56: { name: "BNB Chain", llamaNames: ["Binance", "BSC", "BNB"], coinSlug: "bsc", factory: PANCAKE_V3_FACTORY, coreAssets: { WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", USDT: "0x55d398326f99059fF775485246999027B3197955", USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", ETH: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", BTCB: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", FDUSD: "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409", CAKE: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82" } },
  8453: { name: "Base", llamaNames: ["Base"], coinSlug: "base", factory: PANCAKE_V3_FACTORY, coreAssets: { WETH: "0x4200000000000000000000000000000000000006", USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", USDT: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" } },
  42161: { name: "Arbitrum", llamaNames: ["Arbitrum"], coinSlug: "arbitrum", factory: PANCAKE_V3_FACTORY, coreAssets: { WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", WBTC: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", ARB: "0x912CE59144191C1204E64559FE8253a0e49E6548" } },
  59144: { name: "Linea", llamaNames: ["Linea"], coinSlug: "linea", factory: PANCAKE_V3_FACTORY, coreAssets: { WETH: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5CF34f", USDC: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", USDT: "0xA219439258ca9da29E9Cc4cE5596924745e12B93", WBTC: "0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4" } },
};`;

function replaceBlock(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`Unable to replace block ${startMarker}`);
  return `${source.slice(0, start)}${replacement}\n\n${source.slice(end)}`;
}

let source = fs.readFileSync(BASE, "utf8");

source = source
  .replace(/scan-uniswap-v3-phase0\.js/g, "scan-pancakeswap-amm-v3-phase0.js")
  .replace(/uniswap-v3-phase0/g, "pancakeswap-amm-v3-phase0")
  .replace(/UNISWAP_V3/g, "PANCAKESWAP_AMM_V3")
  .replace(/Uniswap V3/g, "PancakeSwap AMM V3")
  .replace(/uniswap-v3/g, "pancakeswap-amm-v3")
  .replace(/Uniswap-specific/g, "PancakeSwap-specific")
  .replace(/https:\/\/github\.com\/Uniswap\/v3-core/g, "https://github.com/pancakeswap/pancake-v3-contracts")
  .replace(/https:\/\/github\.com\/Uniswap\/v3-periphery/g, "https://github.com/pancakeswap/pancake-v3-contracts")
  .replace(/evm-audit-pancakeswap-amm-v3-phase0\/1\.0/g, "evm-audit-pancakeswap-amm-v3-phase0/1.0");

source = source.replace(/const FEE_TIERS = \[[^\]]*\];/, "const FEE_TIERS = [100, 500, 2500, 10000];");
source = replaceBlock(source, "const DEFAULT_FACTORY =", "const UNSUPPORTED_PROTOCOL_CHAINS", PANCAKE_V3_CHAINS);
source = source.replace(
  /const UNSUPPORTED_PROTOCOL_CHAINS = \[[^\]]*\];/,
  'const UNSUPPORTED_PROTOCOL_CHAINS = ["Solana", "Monad", "zkSync Era", "Polygon zkEVM", "Op_Bnb"];'
);

// The small-cap oracle artifact can embed DEX quote rows; keep Pancake V3 quote context out of direct consumer joins.
source = source.replace(/  \["small-cap-oracle", "reports\/raw\/fast\/small-cap-oracle-manipulation-routes\.json"\],\n/, "");

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
}, { filename: "scan-pancakeswap-amm-v3-phase0.generated.js" });
