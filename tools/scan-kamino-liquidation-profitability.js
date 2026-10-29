#!/usr/bin/env node
// Phase 4: Kamino Liquidation Profitability — theoretical model
// Uses conservative DEX swap cost estimates since Jupiter API unavailable.
const fs = require("fs");
const path = require("path");
const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "kamino-liquidation-profitability.json");
const ORACLE_CONFIG = path.join(WORKSPACE, "reports", "raw", "fast", "kamino-oracle-config.json");
const QUIET = process.argv.includes("--quiet");

function round(v,d=6){const n=typeof v==="number"?v:Number(String(v).replace(/[$,%_\s]/g,""));if(!Number.isFinite(n))return null;const f=10**d;return Math.round(n*f)/f}

async function main(){
  const oracleConfig = JSON.parse(fs.readFileSync(ORACLE_CONFIG,"utf8"));
  const reserves = oracleConfig.reserves || [];
  const active = reserves.filter(r => r.status > 0 && r.min_liquidation_bonus_bps > 0);
  console.log(`Active reserves with liq bonus: ${active.length} of ${reserves.length}`);

  const results = [];
  for(const r of active){
    const bonusBps = r.min_liquidation_bonus_bps;
    const protocolFeePct = r.protocol_fee_pct / 100;
    const grossBonusPct = bonusBps / 10000;
    const protocolFeeOfBonus = grossBonusPct * protocolFeePct;
    const netBonusPct = grossBonusPct - protocolFeeOfBonus;
    // Conservative: 0.5% each for acquire-debt + sell-collateral = 1.0% total DEX cost
    const dexCostPct = 0.01;
    const netPct = netBonusPct - dexCostPct;
    // Solana priority fees: ~0.00005 SOL ($0.003 at $60 SOL), negligible for >$100 positions
    results.push({
      symbol: r.symbol, pubkey: r.pubkey,
      bonusBps, protocolFeePct: round(protocolFeePct,4),
      grossBonusPct: round(grossBonusPct,6),
      protocolFeeOfBonus: round(protocolFeeOfBonus,6),
      netBonusPct: round(netBonusPct,6),
      dexCostPct,
      netPercent: round(netPct,6),
      // At different position sizes
      size10k: round(10000 * netPct,2),
      size50k: round(50000 * netPct,2),
      size100k: round(100000 * netPct,2),
      theoreticallyPositive: netPct > 0,
    });
  }
  results.sort((a,b) => (b.netPercent||0) - (a.netPercent||0));

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-kamino-liquidation-profitability.js",
    scope: "Read-only Kamino liquidation profitability — theoretical model with conservative DEX cost estimates",
    safety: { rpcInventoryRead: false, rpcUrlsStored: false, signedActions: false },
    methodology: "netPercent = (bonusBps/10000 * (1-protocolFeePct)) - 0.01 dexCost. Assumes 0.5% per swap (acquire debt + sell collateral). Does NOT include Solana CPI flash-loan Rust program overhead, which would require separate development.",
    summary: {
      reservesAnalyzed: active.length,
      theoreticallyPositive: results.filter(r => r.theoreticallyPositive).length,
      bestNetPct: results.length ? Math.max(...results.map(r => r.netPercent||0)) : null,
      noLiveCandidates: true,
      routePositive: 0,
    },
    results,
    blockers: [
      "No live same-slot liquidatable obligations in current monitor (sameSlotLiquidatable=0 consistently)",
      "Solana flash-loan execution requires deploying a Rust/Anchor on-chain program — CPI-based, not EVM callback",
      "Jupiter quote API was unavailable from this machine for exact route modeling",
      "Conservative 1.0% DEX cost estimate was used in place of live quotes",
    ],
  };
  fs.mkdirSync(path.dirname(OUT),{recursive:true});
  fs.writeFileSync(OUT, JSON.stringify(artifact,null,2)+"\n");
  const pos = results.filter(r=>r.theoreticallyPositive).length;
  console.log(`Kamino profitability: reserves=${active.length} theoretically_positive=${pos} best=${artifact.summary.bestNetPct?.toFixed(4)}%`);
}
main().catch(e=>{console.error(e.stack);process.exitCode=1});
