#!/usr/bin/env node
// scan-morpho-l2-borrowers.js — Find HF<1 Morpho Blue positions on Base + Arbitrum
const fs = require("fs"); const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "morpho-l2-borrowers.json");

// Standard LRT/LST collateral tokens — filter out exotic illiquid tokens
const STANDARD_COLLATERAL = ["wstETH","weETH","rETH","cbETH","WETH","WBTC","USDC","USDT","DAI","sUSDe","USDe"];

async function main() {
  console.log("=== Morpho Blue L2 HF<1 Scan ===\n");

  // Query Morpho GraphQL for HF<1 positions on Base + Arbitrum
  let items = [];
  try {
    const query = "{ marketPositions(first:100, where:{ healthFactor_lte: \"0.99\", borrowShares_gte: \"1\" }, orderBy:BorrowAssets, orderDirection:Desc) { items { user { address } borrowAssets borrowShares collateral healthFactor market { id chain { id } lltv collateralAsset { symbol address } loanAsset { symbol address } oracle { address } state { borrowAssets borrowAssetsUsd } } } } }";
    const r = await fetch("https://api.morpho.org/graphql", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    items = j.data?.marketPositions?.items || [];
  } catch (e) { console.log("GraphQL error: " + e.message); }

  console.log("Total HF<1 positions: " + items.length);

  // Filter: only Base (8453) and Arbitrum (42161) + standard collateral
  const results = [];
  for (const p of items) {
    const chainId = Number(p.market?.chain?.id);
    if (chainId !== 8453 && chainId !== 42161) continue;
    const colSymbol = p.market?.collateralAsset?.symbol || "";
    const loanSymbol = p.market?.loanAsset?.symbol || "";
    const isStandard = STANDARD_COLLATERAL.includes(colSymbol) || STANDARD_COLLATERAL.includes(loanSymbol);
    if (!isStandard) continue; // skip exotic tokens

    const borrowUsd = Number(p.market?.state?.borrowAssetsUsd || "0");
    if (borrowUsd < 100) continue; // skip dust

    results.push({
      chainId, chain: chainId === 8453 ? "Base" : "Arbitrum",
      pair: colSymbol + "/" + loanSymbol,
      borrower: p.user?.address,
      hf: Number(p.healthFactor || "1"),
      lltv: (Number(p.market?.lltv) / 1e16).toFixed(1),
      borrowUsd: Math.round(borrowUsd),
      oracle: p.market?.oracle?.address?.slice(0, 10) + "...",
      marketId: p.market?.id?.slice(0, 16) + "...",
    });
  }

  // Sort by borrow USD descending
  results.sort((a, b) => b.borrowUsd - a.borrowUsd);

  const baseResults = results.filter(r => r.chainId === 8453);
  const arbResults = results.filter(r => r.chainId === 42161);
  console.log(`\nBase: ${baseResults.length} positions`);
  console.log(`Arbitrum: ${arbResults.length} positions\n`);

  for (const r of results.slice(0, 15)) {
    console.log(`  ${r.chain} ${r.pair} HF=${r.hf.toFixed(4)} LLTV=${r.lltv}% borrow=$${(r.borrowUsd/1e6).toFixed(2)}M borrower=${r.borrower.slice(0,10)}...`);
  }

  if (results.length === 0) {
    console.log("  No standard-collateral HF<1 positions found on L2s.");
    console.log("  Checking ALL L2 HF<1 regardless of collateral:");
    const allL2 = items.filter(p => [8453,42161].includes(Number(p.market?.chain?.id)));
    for (const p of allL2.slice(0, 10)) {
      const col = p.market?.collateralAsset?.symbol || "?";
      const loan = p.market?.loanAsset?.symbol || "?";
      const usd = Math.round(Number(p.market?.state?.borrowAssetsUsd || "0") / 1e6);
      console.log(`  ${p.market?.chain?.id} ${col}/${loan} HF=${Number(p.healthFactor||1).toFixed(3)} borrow=$${usd}M`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), totalHF1: items.length, l2Standard: results.length, base: baseResults.length, arb: arbResults.length, positions: results }, null, 2));
  console.log(`\nArtifact: ${OUT}`);
}
main().catch(e => { console.error(e); process.exit(1); });
