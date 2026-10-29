#!/usr/bin/env node
// scan-phase4-zero-tvl-vaults.js — Phase 4: find extremely small ERC4626 vaults listed as Morpho collateral.
// These are maximally donation-vulnerable: a small donation inflates the rate enormously.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "phase4-zero-tvl-vaults-2026-06-28.json");
const SOURCE = path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json");

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

const ERC4626 = new ethers.Interface([
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function asset() view returns (address)",
  "function totalSupply() view returns (uint256)",
]);

const MORPHO_IFACE = new ethers.Interface([
  "function market(bytes32) view returns (uint128, uint128, uint128, uint128, uint128, uint128)",
]);

async function main() {
  // 1. Extract all ERC4626 collateral addresses from consumer-first data
  const source = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
  let allRows = [];
  for (const r of source.results || []) { if (r.topRows) allRows = allRows.concat(r.topRows); }
  
  // Get unique collateral addresses with market info
  const vaultMap = new Map();
  for (const row of allRows) {
    const addr = row.collateral?.address;
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (!vaultMap.has(key)) {
      vaultMap.set(key, {
        address: addr,
        symbol: row.collateral?.symbol,
        chainId: row.chainId || 1,
        markets: [],
      });
    }
    const info = vaultMap.get(key);
    if (row.consumer?.marketId) info.markets.push({ marketId: row.consumer.marketId, borrowAssetsUsd: row.borrowAssetsUsd || 0, ltv: row.ltv || 0 });
  }

  console.log(`Unique ERC4626 collateral vaults: ${vaultMap.size}`);

  // 2. Query each vault's totalAssets (Ethereum only to save time)
  const rpc = await resolveRpc(1);
  if (!rpc) { console.log("Ethereum RPC unavailable"); process.exit(1); }
  const provider = new ethers.JsonRpcProvider(rpc, 1, { staticNetwork: true });

  const results = [];
  let count = 0;
  for (const [key, vault] of vaultMap) {
    if (vault.chainId !== 1) continue;
    count++;
    if (count > 200) break;
    
    try {
      const code = await provider.getCode(vault.address).catch(() => "0x");
      if (!code || code === "0x") continue;

      const [taRaw, tsRaw] = await Promise.all([
        provider.call({ to: vault.address, data: ERC4626.encodeFunctionData("totalAssets") }).catch(() => null),
        provider.call({ to: vault.address, data: ERC4626.encodeFunctionData("totalSupply") }).catch(() => null),
      ]);

      let totalAssets = null, totalSupply = null;
      try { totalAssets = ERC4626.decodeFunctionResult("totalAssets", taRaw)?.[0] ?? null; } catch(_) {}
      try { totalSupply = ERC4626.decodeFunctionResult("totalSupply", tsRaw)?.[0] ?? null; } catch(_) {}

      if (totalAssets === null) continue;

      const totalAssetsNum = Number(ethers.formatUnits(totalAssets, 18)); // assume 18 decimals
      
      // Get market data for this vault
      const marketData = [];
      for (const m of vault.markets) {
        try {
          const raw = await provider.call({ to: MORPHO, data: MORPHO_IFACE.encodeFunctionData("market", [m.marketId]) });
          const decoded = MORPHO_IFACE.decodeFunctionResult("market", raw);
          const supply = Number(ethers.formatUnits(decoded[0] || 0n, 6));
          const borrow = Number(ethers.formatUnits(decoded[2] || 0n, 6));
          marketData.push({
            marketId: m.marketId,
            availableCash: supply - borrow,
            ltv: m.ltv,
            borrowAssetsUsd: m.borrowAssetsUsd,
          });
        } catch(_) {}
      }

      if (totalAssetsNum < 50000) {
        results.push({
          address: vault.address,
          symbol: vault.symbol,
          totalAssets: parseInt(totalAssets.toString()),
          totalAssetsUsd: parseFloat(totalAssetsNum.toFixed(2)),
          totalSupply: totalSupply?.toString(),
          markets: marketData,
          hasMaterialCash: marketData.some(m => m.availableCash > 50000),
          extremelyVulnerable: totalAssetsNum < 1000,
        });
      }
    } catch(_) {}
  }

  // Sort by totalAssets ascending (smallest = most vulnerable)
  results.sort((a, b) => a.totalAssetsUsd - b.totalAssetsUsd);

  const extremeVulns = results.filter(r => r.extremelyVulnerable && r.hasMaterialCash);
  const smallVulns = results.filter(r => r.totalAssetsUsd < 5000 && r.hasMaterialCash);

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-phase4-zero-tvl-vaults.js",
    scope: "Phase 4: Find extremely small ERC4626 vaults listed as Morpho collateral with material borrow cash",
    totalScanned: count,
    extremeVulnerabilities: extremeVulns.length,
    smallVulnerabilities: smallVulns.length,
    totalFound: results.length,
    results: results.slice(0, 50),
    extremeVulns,
    summary: {
      totalScanned: count,
      vaultsUnder50k: results.length,
      vaultsUnder1k: results.filter(r => r.extremelyVulnerable).length,
      withMaterialCash: results.filter(r => r.hasMaterialCash).length,
      extremeWithCash: extremeVulns.length,
    },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");

  console.log(`\n=== PHASE 4 RESULTS ===`);
  console.log(`Vaults under $50K totalAssets: ${results.length}`);
  console.log(`Extremely vulnerable (<$1K): ${results.filter(r=>r.extremelyVulnerable).length}`);
  console.log(`With material cash: ${results.filter(r=>r.hasMaterialCash).length}`);
  console.log(`Extreme + cash = exploitable: ${extremeVulns.length}`);
  
  if (extremeVulns.length > 0) {
    console.log(`\n🔴 EXTREMELY VULNERABLE WITH CASH!`);
    extremeVulns.forEach(v => console.log(`  ${v.symbol} TA=$${v.totalAssetsUsd} markets=${v.markets.length} cash=$${Math.max(...v.markets.map(m=>m.availableCash||0))?.toLocaleString()}`));
  }
  console.log(`\nArtifact: ${path.relative(WORKSPACE, OUT)}`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err.stack || err.message); process.exit(1); });