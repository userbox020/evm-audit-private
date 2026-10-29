#!/usr/bin/env node
// scan-uniswap-twap-consumers.js — Uniswap V3 TWAP Oracle Manipulation Scanner
// Finds lending protocols using UniV3 TWAP oracles and models manipulation cost per pool.
// Attack: flash-loan → manipulate TWAP pool → borrow at inflated collateral → repay.
const fs = require("fs");
const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "uniswap-twap-consumers.json");
const CHAIN_ID = 1;

// Known TWAP oracle consumers (protocol → contract → lookup method)
const TWAP_CONSUMERS = [
  {
    protocol: "Euler V2",
    factory: "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e",
    oracleFactory: "0x70B3f6F61b7Bf237DF04589DdAA842121072326A",
    note: "Uniswap V3 TWAP adapter in EulerRouter. Per-vault configurable window.",
  },
  {
    protocol: "Silo V3",
    factory: "0xAFd8F792cb025A76C4916652CfC8e20eee3b6fe2",
    note: "Silo supports TWAP oracle config per silo via ChainlinkV3Oracle (ignores heartbeat). PTLinearOracle and CustomMethodOracle also possible.",
    chainId: 42161,
  },
  {
    protocol: "Fraxlend V3",
    registry: "0xd6e9d27c75afd88ad24cd5edccdc76fd2fc3a751",
    note: "Triple Oracle (Chainlink + UniV3 TWAP + RedStone). Freshness check on TWAP. Max deviation 5000 (50%).",
  },
  {
    protocol: "Morpho Blue",
    morphoAddr: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    note: "Markets can use MorphoChainlinkOracleV2 which wraps Chainlink, not TWAP. But Morpho vault V2 can use any oracle.",
  },
];

// Uniswap V3 factory + known high-TV pools
const UNI_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const KEY_POOLS = [
  { pair: "WETH/USDC", token0: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", token1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", fee: 500, tvlEst: 200000000 },
  { pair: "WBTC/WETH", token0: "0x2260FAC5E5542a773aa44bCFfeDf7C193bc2c599", token1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", fee: 500, tvlEst: 150000000 },
  { pair: "wstETH/WETH", token0: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", token1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", fee: 100, tvlEst: 80000000 },
  { pair: "USDC/USDT", token0: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", token1: "0xdAC17F958D2ee523a2206206994597C13D831ec7", fee: 100, tvlEst: 50000000 },
  { pair: "weETH/WETH", token0: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", token1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", fee: 500, tvlEst: 40000000 },
];

async function ethCall(rpc, to, sel, args = "", ms = 8000) {
  const raw = await rpcCall(rpc, "eth_call", [{ to, data: "0x" + sel + args }, "latest"], ms);
  if (!raw || raw === "0x") return null;
  return raw;
}

async function getPoolAddress(rpc, factory, t0, t1, fee) {
  // getPool(tokenA, tokenB, fee) → address
  const sel = "1698ee82";
  const args = "000000000000000000000000" + t0.slice(2) + "000000000000000000000000" + t1.slice(2) + fee.toString(16).padStart(64, "0");
  const raw = await ethCall(rpc, factory, sel, args);
  if (!raw) return null;
  return "0x" + raw.slice(26);
}

async function getPoolLiquidity(rpc, poolAddr) {
  // slot0: sqrtPriceX96, tick, observationIndex, observationCardinality, observationCardinalityNext, feeProtocol, unlocked
  const slot0 = await ethCall(rpc, poolAddr, "3850c7bd");
  if (!slot0) return null;
  // liquidity()
  const liq = await ethCall(rpc, poolAddr, "1a686502");
  return liq ? BigInt(liq) : null;
}

async function main() {
  console.log("=== Uniswap V3 TWAP Oracle Manipulation Scanner ===\n");

  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) { console.error("No ETH RPC"); process.exit(1); }

  const results = [];
  const poolData = [];

  // 1. Resolve all key pools
  console.log("Resolving pools...");
  for (const p of KEY_POOLS) {
    const addr = await getPoolAddress(rpc, UNI_V3_FACTORY, p.token0, p.token1, p.fee);
    if (!addr) { poolData.push({ ...p, poolAddr: "not-found" }); continue; }
    const liq = await getPoolLiquidity(rpc, addr);
    const liqVal = liq ? Number(liq) : 0;
    poolData.push({ ...p, poolAddr: addr, liquidity: liqVal });
    console.log(`  ${p.pair} (${p.fee/10000}%): addr=${addr.slice(0,10)}... liq=${(liqVal/1e18).toFixed(1)}e18`);
  }

  // 2. Model manipulation cost per pool
  console.log("\nTWAP Manipulation Model:");
  console.log("  (flash-loan amount needed to shift price by 5% against TWAP window)");

  for (const p of poolData) {
    if (!p.liquidity || p.liquidity === 0) continue;
    // Manipulation cost: to shift sqrt price by 5% in Uniswap V3:
    // Δx ≈ liquidity × ΔsqrtPrice
    // 5% price shift → ΔsqrtPrice ≈ sqrtPrice × (√1.05 - 1)
    // Simplified: manipulateCost ≈ pool_tvl × 0.025 (2.5% for 5% price shift)
    const poolTvl = p.tvlEst || 0;
    const manipulateCost5pct = poolTvl * 0.025;
    const flashLoanFee = manipulateCost5pct * 0.0005; // 5bps on Balancer/Aave
    
    results.push({
      pool: p.pair,
      poolAddr: p.poolAddr,
      estimatedTvl: poolTvl,
      manipulateCostUsd_5pct: Math.round(manipulateCost5pct),
      flashLoanFeeUsd: Math.round(flashLoanFee),
      manipulationRatio: poolTvl > 0 ? (manipulateCost5pct / poolTvl * 100).toFixed(1) + "%" : "N/A",
      risk: poolTvl < 5000000 ? "HIGH" : poolTvl < 50000000 ? "MEDIUM" : "LOW",
      note: poolTvl < 5000000 ? `Low TVL ($${(poolTvl/1e6).toFixed(1)}M) — feasible flash-loan manipulation` : 
             poolTvl < 50000000 ? `Medium TVL — manipulation possible with large flash-loan` :
             `High TVL — manipulation cost prohibitive without capital`,
    });
  }

  // 3. Cross-reference with TWAP consumers
  console.log("\nTWAP Consumer Protocol Coverage:");
  for (const c of TWAP_CONSUMERS) {
    const rpcC = (c.chainId || CHAIN_ID) !== CHAIN_ID ? await resolveRpc(c.chainId) : rpc;
    const status = rpcC ? "RPC available" : "no RPC";
    console.log(`  ${c.protocol}: ${status} — ${c.note.slice(0, 80)}...`);
    results.push({
      protocol: c.protocol,
      chainId: c.chainId || CHAIN_ID,
      rpcAvailable: !!rpcC,
      status: rpcC ? "monitored" : "no-rpc",
      note: c.note,
    });
  }

  // Summary
  console.log("\n=== Summary ===");
  const highRisk = poolData.filter(p => (p.tvlEst || 0) < 5000000);
  const medRisk = poolData.filter(p => (p.tvlEst || 0) >= 5000000 && (p.tvlEst || 0) < 50000000);
  console.log(`TWAP-vulnerable pools: HIGH=${highRisk.length} MEDIUM=${medRisk.length} LOW=${poolData.length - highRisk.length - medRisk.length}`);
  console.log(`TWAP consumer protocols: ${TWAP_CONSUMERS.map(c => c.protocol).join(", ")}`);
  console.log(`Most vulnerable: ${highRisk.map(p => p.pair).join(", ") || "none (all pools >$5M TVL)"}`);

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), pools: poolData, consumers: TWAP_CONSUMERS.map(c => ({ protocol: c.protocol, note: c.note })), twapVulnerablePools: highRisk.length + medRisk.length }, null, 2));
  console.log(`\nArtifact: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
