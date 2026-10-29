#!/usr/bin/env node
// scan-quickswap-dex-phase0.js - bounded read-only Phase 0 for Quickswap Dex V2-style pair/LP consumer joins.
// Reuses the vetted V2 Phase 0 scanner logic with Quickswap-specific factories and metadata.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BASE = path.join(__dirname, "scan-uniswap-v2-phase0.js");

const QUICKSWAP_CHAINS = `const CHAINS = {
  137: {
    name: "Polygon", llamaNames: ["Polygon"], coinSlug: "polygon", factory: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32", router: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    coreAssets: {
      WPOL: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", QUICK: "0xB5C064F955D8e7F38fE0460C556a72987494eE17", QUICK_OLD: "0x831753DD7087CaC61aB5644b308642cc1c33Dc13" },
  },
  8453: {
    name: "Base", llamaNames: ["Base"], coinSlug: "base", factory: "0xEC6540261aaaE13F236A032d454dc9287E52e56A", router: null,
    coreAssets: {
      WETH: "0x4200000000000000000000000000000000000006", USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", USDT: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" },
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
  .replace(/scan-uniswap-v2-phase0\.js/g, "scan-quickswap-dex-phase0.js")
  .replace(/uniswap-v2-phase0/g, "quickswap-dex-phase0")
  .replace(/UNISWAP_V2/g, "QUICKSWAP_DEX")
  .replace(/Uniswap V2/g, "Quickswap Dex")
  .replace(/uniswap-v2/g, "quickswap-dex")
  .replace(/Uniswap-specific/g, "Quickswap-specific")
  .replace(/https:\/\/raw\.githubusercontent\.com\/DefiLlama\/DefiLlama-Adapters\/main\/projects\/quickswap-dex\/index\.js/g, "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/quickswap/index.js")
  .replace(/https:\/\/github\.com\/Uniswap\/v2-core/g, "https://github.com/QuickSwap/quickswap-core")
  .replace(/https:\/\/github\.com\/Uniswap\/v2-periphery/g, "https://github.com/QuickSwap/quickswap-periphery")
  .replace(/evm-audit-quickswap-dex-phase0\/1\.0/g, "evm-audit-quickswap-dex-phase0/1.0");

// The small-cap oracle artifact embeds Quickswap factory/pair addresses as DEX quote context;
// its own scan reports no oracle-linked/watch rows, so keep it context-only here.
source = source.replace(/  "small-cap-oracle",\n/, "");

source = replaceBlock(source, "const CHAINS = {", "const UNSUPPORTED_PROTOCOL_CHAINS", QUICKSWAP_CHAINS);
source = source.replace(
  /const UNSUPPORTED_PROTOCOL_CHAINS = \[[^\]]*\];/,
  "const UNSUPPORTED_PROTOCOL_CHAINS = [];"
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
}, { filename: "scan-quickswap-dex-phase0.generated.js" });
