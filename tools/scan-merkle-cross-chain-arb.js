#!/usr/bin/env node
// scan-merkle-cross-chain-arb.js — Cross-chain price monitoring via Merkle RPCs
// Compares WETH/USDC prices on BSC (PancakeSwap) vs Base (Aerodrome/UniV3)
const fs = require("fs"); const path = require("path");
const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "merkle-cross-chain-arb.json");

// Merkle RPCs
const BSC_RPC = "https://bsc.merkle.io";
const BASE_RPC = "https://base.merkle.io";

// Token addresses
const WETH = {
  bsc: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", // WETH on BSC (Bridged)
  base: "0x4200000000000000000000000000000000000006", // WETH on Base
};
const USDC = {
  bsc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // USDC on BSC
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
};

// QuoterV2 addresses (Uniswap V3)
const QUOTER_V2 = {
  bsc: "0x78D78E420Da98ad378D7799bE8f6902ea4C50b1c", // PancakeSwap QuoterV2
  base: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", // Uniswap V3 QuoterV2
};

// Chainlink feeds
const CL_FEEDS = {
  bsc: "0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e", // ETH/USD BSC
  base: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", // ETH/USD Base
};

async function rpcCall(url, method, params, ms = 8000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  } catch (e) { return { _err: e.message }; }
  finally { clearTimeout(t); }
}

function encodeQuoteExactInputSingle(tokenIn, tokenOut, fee, amountIn) {
  // quoteExactInputSingle(address,address,uint24,uint256,uint160)
  const sel = "0xf7729d43";
  const tIn = tokenIn.slice(2).padStart(64, "0");
  const tOut = tokenOut.slice(2).padStart(64, "0");
  const f = fee.toString(16).padStart(64, "0");
  const amt = amountIn.toString(16).padStart(64, "0");
  const sqrtPrice = "0".padStart(64, "0"); // sqrtPriceLimitX96=0
  return sel + tIn + tOut + f + amt + sqrtPrice;
}

async function getDexPrice(rpc, quoter, tokenIn, tokenOut, fee, amountIn) {
  const data = encodeQuoteExactInputSingle(tokenIn, tokenOut, fee, amountIn);
  const raw = await rpcCall(rpc, "eth_call", [{ to: quoter, data }, "latest"], 10000);
  if (!raw || raw._err || raw === "0x") return null;
  const out = BigInt(raw);
  return Number(out) / 1e6; // USDC = 6 decimals
}

async function getChainlinkPrice(rpc, feed) {
  const raw = await rpcCall(rpc, "eth_call", [{ to: feed, data: "0xfeaf968c" }, "latest"], 8000);
  if (!raw || raw._err || raw === "0x" || raw.length < 258) return null;
  const answer = BigInt("0x" + raw.slice(2 + 64, 2 + 128));
  return Number(answer) / 1e8;
}

async function main() {
  console.log("=== Merkle Cross-Chain Arb (BSC vs Base) ===\n");

  // 1. Verify RPC health
  const [bscId, baseId] = await Promise.all([
    rpcCall(BSC_RPC, "eth_chainId", [], 5000),
    rpcCall(BASE_RPC, "eth_chainId", [], 5000),
  ]);
  console.log(`BSC RPC chainId: ${bscId ? parseInt(bscId, 16) : "FAIL"}`);
  console.log(`Base RPC chainId: ${baseId ? parseInt(baseId, 16) : "FAIL"}\n`);

  // 2. Get DEX prices (WETH → USDC, 1 ETH)
  const amountIn = 1000000000000000000n; // 1e18 = 1 WETH
  const fee = 500; // 0.05% pool

  const [bscDex, baseDex, bscCL, baseCL] = await Promise.all([
    getDexPrice(BSC_RPC, QUOTER_V2.bsc, WETH.bsc, USDC.bsc, fee, amountIn),
    getDexPrice(BASE_RPC, QUOTER_V2.base, WETH.base, USDC.base, fee, amountIn),
    getChainlinkPrice(BSC_RPC, CL_FEEDS.bsc),
    getChainlinkPrice(BASE_RPC, CL_FEEDS.base),
  ]);

  console.log("DEX WETH/USDC (1 WETH → USDC):");
  console.log(`  BSC:  $${bscDex?.toFixed(2) || "FAIL"}`);
  console.log(`  Base: $${baseDex?.toFixed(2) || "FAIL"}`);

  if (bscDex && baseDex) {
    const spread = ((baseDex - bscDex) / bscDex * 100).toFixed(3);
    console.log(`  Spread: ${spread}% (Base relative to BSC)`);
    if (Math.abs(Number(spread)) > 0.3) {
      console.log(`  ARBITRAGE WINDOW: ${spread}% > 0.3% threshold`);
    } else {
      console.log(`  No arb (below 0.3%)`);
    }
  }

  console.log("\nChainlink ETH/USD:");
  console.log(`  BSC:  $${bscCL?.toFixed(2) || "FAIL"}`);
  console.log(`  Base: $${baseCL?.toFixed(2) || "FAIL"}`);

  fs.writeFileSync(OUT, JSON.stringify({
    scannedAt: new Date().toISOString(),
    bscChainId: bscId ? parseInt(bscId, 16) : null,
    baseChainId: baseId ? parseInt(baseId, 16) : null,
    bscDexPrice: bscDex, baseDexPrice: baseDex,
    bscChainlinkPrice: bscCL, baseChainlinkPrice: baseCL,
    spreadPct: bscDex && baseDex ? ((baseDex - bscDex) / bscDex * 100).toFixed(3) : null,
  }, null, 2));
  console.log(`\nArtifact: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
