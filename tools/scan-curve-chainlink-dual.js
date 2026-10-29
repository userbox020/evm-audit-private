#!/usr/bin/env node
// scan-curve-chainlink-dual.js — Curve Pool EMA + Chainlink Dual Oracle Scanner
// Works for Prisma ($250M), Liquity V2 forks, and any protocol using Curve pool as oracle
const fs = require("fs"); const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "curve-chainlink-dual.json");

// Key Curve ETH pools used as oracles by lending protocols
const CURVE_POOLS = [
  { name:"ETH/stETH", pool:"0xDC24316b9AE028F1497c275EB9192a3Ea0f67022", clFeed:"0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419", chain:1, note:"Prisma/Liquity uses this for ETH price" },
  { name:"ETH/frxETH", pool:"0xa1F8A6807c402E4A15ef4EBa36528A3FED24E577", clFeed:"0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419", chain:1, note:"Liquity V2 wstETH collateral pricing" },
];

// Curve pool interface
const CURVE_ABI = {
  get_virtual_price: "0xbb7b8b80", // virtual price (LP token ratio)
  get_dy: "0x5e0d443f", // get_dy(i,j,amount) → amount out
  balances: "0x4906b0d5", // get_balances() → uint256[]
  price_oracle: "0x86fc88d3", // price_oracle() → uint256 (EMA oracle, no args)
  get_p: "0x4d8002c4", // get_p() → uint256
};

async function probePool(rpc, poolCfg) {
  const result = { ...poolCfg, curve: null, chainlink: null };
  
  // 1. Try price_oracle(0) — Curve v2 pools expose EMA price oracle
  const priceRaw = await rpcCall(rpc, "eth_call", [{ to: poolCfg.pool, data: "0x86fc88d3" + "0".repeat(64) }, "latest"], 8000);
  if (priceRaw && priceRaw !== "0x" && priceRaw.length >= 66) {
    const curvePrice = Number(BigInt("0x" + priceRaw.slice(2, 66))) / 1e18;
    result.curve = { price: curvePrice, method: "price_oracle(0)" };
  }

  // 2. Chainlink ETH/USD for same chain
  if (poolCfg.clFeed) {
    const clRaw = await rpcCall(rpc, "eth_call", [{ to: poolCfg.clFeed, data: "0xfeaf968c" }, "latest"], 8000);
    if (clRaw && clRaw.length >= 258) {
      const answer = BigInt("0x" + clRaw.slice(2 + 64, 2 + 128));
      const updatedAt = Number(BigInt("0x" + clRaw.slice(2 + 192, 2 + 256)));
      result.chainlink = { price: Number(answer) / 1e8, updatedAt, age: Math.floor(Date.now() / 1000) - updatedAt };
    }
  }

  // 3. Divergence
  if (result.curve?.price && result.chainlink?.price) {
    const div = ((result.curve.price - result.chainlink.price) / result.chainlink.price * 100).toFixed(3);
    result.divergence = div;
    result.risk = Math.abs(Number(div)) > 2 ? "HIGH — Curve pool diverged >2% from Chainlink" :
                  Math.abs(Number(div)) > 0.5 ? "MEDIUM — >0.5% divergence" : "LOW";
  }

  // 4. Get pool balances to estimate TVL and manipulation cost
  const balRaw = await rpcCall(rpc, "eth_call", [{ to: poolCfg.pool, data: "0x4906b0d5" + "0".repeat(64) }, "latest"], 5000);
  if (balRaw && balRaw !== "0x" && balRaw.length >= 130) {
    // get_balances returns uint256[N_COINS] dynamic array
    const offset = parseInt(balRaw.slice(2, 66), 16) * 2;
    const count = parseInt(balRaw.slice(offset + 2, offset + 66), 16);
    if (count >= 1) {
      const bal0 = Number(BigInt("0x" + balRaw.slice(offset + 66, offset + 130))) / 1e18;
      result.poolBal0 = bal0;
      result.poolTvlEst = bal0 * (result.curve?.price || 1600);
      result.manipulationCost5pct = result.poolTvlEst ? Math.round(result.poolTvlEst * 0.025) : 0;
    }
  }

  return result;
}

async function main() {
  console.log("=== Curve EMA + Chainlink Dual Oracle Scanner ===\n");

  const rpc = await resolveRpc(1);
  if (!rpc) { console.error("No ETH RPC"); return; }

  const results = [];
  for (const pool of CURVE_POOLS) {
    console.log(pool.name + " (" + pool.pool.slice(0,10) + "...)...");
    const r = await probePool(rpc, pool);
    results.push(r);
    const curve = r.curve ? r.curve.price.toFixed(2) : "N/A";
    const cl = r.chainlink ? "$"+r.chainlink.price.toFixed(2)+" ("+r.chainlink.age+"s)" : "N/A";
    const div = r.divergence || "N/A";
    console.log("  Curve: " + curve + " | CL: " + cl + " | Div: " + div + " | " + (r.risk||""));
    if (r.poolTvlEst) console.log("  Pool TVL: $" + (r.poolTvlEst/1e6).toFixed(1) + "M | Manip 5%: $" + r.manipulationCost5pct);
  }

  console.log("\n=== Attack Model (Prisma $250M + Liquity V2 forks) ===");
  console.log("1. Curve pool price_oracle(0) provides ETH/stETH EMA");
  console.log("2. Prisma compares Curve EMA vs Chainlink ETH/USD");
  console.log("3. If both within threshold → borrow allowed");
  console.log("4. Attack: flash-loan manipulate Curve pool → EMA drifts → divergence < threshold but borrowable");
  console.log("5. At current prices: pool TVL determines manipulation cost");
  console.log("6. If manipulation cost < borrow profit: execute");

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), results }, null, 2));
  console.log("\nArtifact: " + OUT);
}
main().catch(e => { console.error(e.message); process.exit(1); });
