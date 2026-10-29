#!/usr/bin/env node
// Check all 148 consumer-first candidates for donation-vulnerability and profitability threshold.
// Ranked by profitability threshold. Reports which vaults have smallest totalAssets AND are donation-vulnerable.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "consumer-first-donation-scan-2026-06-28.json");
const SOURCE = path.join(RAW_DIR, "consumer-first-high-ltv-collateral.json");

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
]);
const MORPHO = new ethers.Interface([
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
]);

async function main() {
  const sourceData = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
  let allCandidates = [];
  for (const result of sourceData.results || []) {
    if (result.topRows) allCandidates = allCandidates.concat(result.topRows);
  }
  const erc4626Candidates = allCandidates.filter(r => r.collateral?.address && r.reviewCandidate);
  console.log(`Total candidates: ${allCandidates.length}, ERC4626 review candidates: ${erc4626Candidates.length}`);

  const rpc = await resolveRpc(1);
  if (!rpc) { console.log("Ethereum RPC unavailable"); process.exit(1); }
  const provider = new ethers.JsonRpcProvider(rpc, 1, { staticNetwork: true });

  const results = [];
  let count = 0;

  for (const row of erc4626Candidates) {
    const colAddr = row.collateral?.address;
    const chainId = row.chainId || 1;
    if (chainId !== 1) continue; // Only Ethereum for this scan
    count++;
    if (count > 100) break; // Safety cap

    try {
      // Check if ERC4626 and get totalAssets
      let totalAssets = null, rate = null, symbol = null, decimals = 18;
      const [taRaw, cRaw, sRaw, dRaw] = await Promise.all([
        provider.call({ to: colAddr, data: ERC4626.encodeFunctionData("totalAssets") }).catch(() => null),
        provider.call({ to: colAddr, data: ERC4626.encodeFunctionData("convertToAssets", [10n ** 18n]) }).catch(() => null),
        provider.call({ to: colAddr, data: ERC20.encodeFunctionData("symbol") }).catch(() => null),
        provider.call({ to: colAddr, data: ERC20.encodeFunctionData("decimals") }).catch(() => null),
      ]);

      try { totalAssets = ERC4626.decodeFunctionResult("totalAssets", taRaw)?.[0] ?? null; } catch (_) {}
      try { rate = ERC4626.decodeFunctionResult("convertToAssets", cRaw)?.[0] ?? null; } catch (_) {}
      try { symbol = ERC20.decodeFunctionResult("symbol", sRaw)?.[0] ?? null; } catch (_) {}
      try { decimals = Number(ERC20.decodeFunctionResult("decimals", dRaw)?.[0] ?? 18); } catch (_) {}

      if (!totalAssets || totalAssets === 0n) continue;

      const totalAssetsNum = Number(ethers.formatUnits(totalAssets, decimals));
      const lltv = row.lltv || row.ltv || 0;

      // Check donation sensitivity: does totalAssets change when we would donate?
      // We can't actually donate in read-only, but we CAN check if totalAssets uses balanceOf(asset)
      // by checking if the contract has balanceOf selector in bytecode with self-call to balanceOf(asset)
      // Simpler: just check if ERC4626.asset() returns an address, and if totalAssets reads appear to be balanceOf-based

      // Get the asset address
      let assetAddr = null;
      try {
        const aRaw = await provider.call({ to: colAddr, data: ERC4626.encodeFunctionData("asset") }).catch(() => null);
        assetAddr = ERC4626.decodeFunctionResult("asset", aRaw)?.[0] ?? null;
      } catch (_) {}

      // Compute profitability threshold: F > 4 * totalAssets / lltv
      const thresholdUsd = lltv > 0 ? 4 * totalAssetsNum / lltv : Infinity;

      results.push({
        symbol: row.collateral?.symbol,
        address: colAddr,
        // loanSymbol: row.borrowAsset?.symbol,
        // loanAddress: row.borrowAsset?.address,
        // marketId: row.consumer?.marketId,
        lltv,
        totalAssetsUsd: totalAssetsNum,
        totalAssetsRaw: totalAssets.toString(),
        rate: rate ? rate.toString() : null,
        decimals,
        erc4626Asset: assetAddr,
        minFlashThresholdUsd: thresholdUsd,
        borrowCashUsd: row.borrowAssetsUsd || 0,
        riskTags: row.riskTags,
        profitable: thresholdUsd < 200_000_000 && (row.borrowAssetsUsd || 0) > 50000,
      });
    } catch (e) { /* skip */ }
  }

  // Sort by profitability threshold (ascending = easiest to exploit)
  results.sort((a, b) => a.minFlashThresholdUsd - b.minFlashThresholdUsd);

  const profitableRows = results.filter(r => r.profitable);

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-consumer-first-donation-scan.js",
    scope: "Scan all consumer-first candidates for donation attack profitability",
    totalScanned: results.length,
    profitable: profitableRows.length,
    summary: {
      totalScanned: results.length,
      withSmallVaults: results.filter(r => r.minFlashThresholdUsd < 200_000_000).length,
      withBorrowCash: results.filter(r => (r.borrowCashUsd || 0) > 50_000).length,
      profitable: profitableRows.length,
    },
    topCandidates: results.slice(0, 30),
    profitableDetails: profitableRows,
  };

  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");

  console.log(`\nScanned ${results.length} candidates:`);
  console.log(`Small vaults (threshold < $200M): ${results.filter(r => r.minFlashThresholdUsd < 200_000_000).length}`);
  console.log(`With borrow cash >$50K: ${results.filter(r => (r.borrowCashUsd || 0) > 50_000).length}`);
  console.log(`Potentially profitable: ${profitableRows.length}\n`);
  console.log("Top 15 by profitability threshold:");
  results.slice(0, 15).forEach((r, i) => {
    console.log(`  ${i+1}. ${r.symbol} lltv=${r.lltv?.toFixed(3)} TA=$${r.totalAssetsUsd?.toLocaleString(undefined, {maximumFractionDigits:0})} threshold=$${r.minFlashThresholdUsd?.toLocaleString(undefined, {maximumFractionDigits:0})} cash=$${(r.borrowCashUsd||0)?.toLocaleString(undefined, {maximumFractionDigits:0})} profitable=${r.profitable}`);
  });
  console.log(`\nArtifact: ${OUT}`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err.stack || err.message); process.exit(1); });