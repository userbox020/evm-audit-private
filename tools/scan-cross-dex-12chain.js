#!/usr/bin/env node
// scan-cross-dex-12chain.js — Cross-chain DEX WETH/USDC price via slot0
// Per-chain factories + multi-RPC fallback. Sequential to avoid rate limits.
const fs = require("fs"); const path = require("path");
const { rpcCall } = require("./shared-rpc");
const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "cross-dex-12chain.json");

const INFURA_KEY = "5b98a22672004ef1bf40a80123c5c48d";

// Per-chain config: [name, chainId, factory, WETH, USDC, usdcDecimals, RPC URLs...]
// Working chains with confirmed Uniswap V3 factories + active WETH/USDC pools
const CHAINS = [
  ["Ethereum", 1, "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6,
    "https://mainnet.infura.io/v3/" + INFURA_KEY, "https://lb.nodies.app/v1/685a68cebea644a5bda56d7d86c7a58d", "https://ethereum.publicnode.com"],
  ["Arbitrum", 42161, "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 6,
    "https://arbitrum-mainnet.infura.io/v3/" + INFURA_KEY, "https://lb.nodies.app/v1/5067d159444c4d159b9d2c7ebc356c1a", "https://arbitrum-one.publicnode.com"],
  ["Optimism", 10, "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    "0x4200000000000000000000000000000000000006", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", 6,
    "https://optimism-mainnet.infura.io/v3/" + INFURA_KEY, "https://optimism.publicnode.com"],
  ["Base", 8453, "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    "0x4200000000000000000000000000000000000006", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6,
    "https://base-mainnet.infura.io/v3/" + INFURA_KEY, "https://lb.nodies.app/v1/0abc2c55fd444b198a6b2f72b17529bb", "https://base.publicnode.com", "https://lb.drpc.live/base/Avibgvi26EjPsw76UtdwmsQOcPkUJIUR8YARurWHF38a"],
  ["Polygon", 137, "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", 6,
    "https://polygon-mainnet.infura.io/v3/" + INFURA_KEY, "https://polygon-bor.publicnode.com"],
  ["BSC", 56, "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
    "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", 18,
    "https://bsc-mainnet.infura.io/v3/" + INFURA_KEY, "https://lb.nodies.app/v1/2e310df0bb5746dfa7b75c789b5a86a6", "https://bsc.publicnode.com"],
];
// Not included (no V3 / 0 liquidity / wrong factory):
// Linea: pools exist but all have 0 liquidity. Celo/Scroll/zkSync/Gnosis/Avalanche: no V3 factory deployed.

async function getPoolPriceOnRpc(rpc, factory, weth, usdc, usdcDecimals) {
  for (const fee of [500, 100, 3000]) {
    const d = "1698ee82" + "000000000000000000000000" + weth.slice(2) +
              "000000000000000000000000" + usdc.slice(2) +
              fee.toString(16).padStart(64, "0");
    const pr = await rpcCall(rpc, "eth_call", [{ to: factory, data: "0x" + d }, "latest"], 8000);
    if (!pr || pr === "0x") continue;
    const pool = "0x" + pr.slice(26);
    if (pool === "0x" + "0".repeat(40) || pool.length !== 42) continue;

    const s0 = await rpcCall(rpc, "eth_call", [{ to: pool, data: "0x3850c7bd" }, "latest"], 8000);
    if (!s0 || s0 === "0x" || s0.length < 130) continue;

    // Filter out idle pools — require minimum liquidity
    const liq = await rpcCall(rpc, "eth_call", [{ to: pool, data: "0x1a686502" }, "latest"], 5000);
    if (!liq || BigInt(liq) < 1000000000000000n) continue; // min 0.001e18 liquidity

    // Token order matters: smaller hex = token0. Formula differs by order.
    // Normalization: price = ratio * 10^(18 - usdcDecimals) or 1/ratio * 10^(18 - usdcDecimals)
    const sp = BigInt("0x" + s0.slice(2, 66));
    const f = Number(sp) / Math.pow(2, 96);
    const adj = Math.pow(10, 18 - usdcDecimals);
    const wethIsToken0 = BigInt(weth) < BigInt(usdc);
    const price = wethIsToken0 ? (f * f) * adj : adj / (f * f);
    if (price > 100 && price < 100000) return { price, fee, pool };
  }
  return null;
}

async function main() {
  console.log("=== Cross-Chain DEX WETH/USDC (multi-RPC) ===\n");
  const results = [];

  for (const [name, id, factory, weth, usdc, usdcDec, ...rpcs] of CHAINS) {
    let found = false;
    for (const rpc of rpcs) {
      const p = await getPoolPriceOnRpc(rpc, factory, weth, usdc, usdcDec);
      if (p) {
        results.push({ name, chainId: id, price: p.price, fee: p.fee, pool: p.pool.slice(0,10) + "..." });
        console.log(name.padEnd(10) + ": $" + p.price.toFixed(2) + " (fee=" + p.fee + " via " + rpc.slice(8, 25) + ")");
        found = true;
        break;
      }
    }
    if (!found) console.log(name.padEnd(10) + ": no pool at fee 100/500/3000");
  }

  console.log("\n=== Spread ===");
  if (results.length < 2) { console.log("Need >=2 chains with pools"); return; }
  results.sort((a, b) => a.price - b.price);
  const spread = ((results[results.length-1].price - results[0].price) / results[0].price * 100).toFixed(4);
  console.log("Chains: " + results.length + "/" + CHAINS.length + " | Spread: " + spread + "%");
  for (const r of results) console.log("  " + r.name.padEnd(10) + ": $" + r.price.toFixed(2));
  console.log(Number(spread) > 0.3 ? "ARBITRAGE: " + spread + "%" : "No arb (<0.3%)");

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), results, spread }, null, 2));
  console.log("\n" + OUT);
}
main().catch(e => { console.error(e.message); process.exit(1); });
