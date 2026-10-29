#!/usr/bin/env node
// scan-aave-v3-hf-preview.js — Aave V3 healthFactorPreview Predictive Scanner
// Models exact price drop needed for each borrower to reach HF<1.0.
// Shows which borrowers are closest to liquidation and what price triggers it.
const fs = require("fs"); const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-hf-preview.json");

const AAVE_V3_GQL = "https://api.v3.aave.com/graphql";
const GQL_HEADERS = { "Content-Type": "application/json", Origin: "https://app.aave.com", Referer: "https://app.aave.com/" };

async function queryAave(query, variables = {}) {
  try {
    const r = await fetch(AAVE_V3_GQL, {
      method: "POST", headers: GQL_HEADERS,
      body: JSON.stringify({ operationName: "Query", query, variables }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    return j.data || {};
  } catch (e) { return {}; }
}

async function getTopBorrowers(chainId, limit = 30) {
  const query = "query($request:UserBorrowsRequest!){userBorrows(request:$request){user{id}chain{chainId}totalBorrowsUSD}}";
  const vars = { request: { chainIds: [chainId], first: limit, orderBy: "totalBorrowsUSD", orderDirection: "desc" } };
  const data = await queryAave(query, vars);
  return (data.userBorrows || []).map(b => ({ address: b.user?.id, borrowUsd: Number(b.totalBorrowsUSD || 0), chainId: Number(b.chain?.chainId) }));
}

async function getHfPreview(chainId, userAddress) {
  // healthFactorPreview(userAddress, reserveAddress, amount, action)
  // action: SUPPLY, BORROW, WITHDRAW, REPAY
  // For liquidation modeling, we simulate a BORROW of 1 wei to get baseline HF
  const query = "query($input:HealthFactorPreviewInput!){healthFactorPreview(input:$input){healthFactorBefore healthFactorAfter}}";
  const vars = {
    input: {
      chainId,
      userAddress: userAddress.toLowerCase(),
      reserveAddress: "0x0000000000000000000000000000000000000001", // dummy — just to get baseline
      amount: "1",
      action: "BORROW",
      useOptimizedPath: true,
    }
  };
  try {
    const data = await queryAave(query, vars);
    return data.healthFactorPreview;
  } catch (_) { return null; }
}

async function main() {
  console.log("=== Aave V3 healthFactorPreview — Liquidation Trigger Model ===\n");

  // Target chains with active Aave V3 pools (from GraphQL supported chains)
  const targetChains = [1, 8453, 42161, 10, 137, 43114, 56, 100, 534352, 59144];

  const allResults = {};

  for (const chainId of targetChains) {
    console.log("Chain " + chainId + "...");
    const borrowers = await getTopBorrowers(chainId, 20);
    console.log("  Top " + borrowers.length + " borrowers");

    if (borrowers.length === 0) { allResults[chainId] = { borrowers: 0, error: "no-borrowers" }; continue; }

    const chainResults = [];
    for (const b of borrowers) {
      const hf = await getHfPreview(chainId, b.address);
      if (!hf) continue;
      
      const hfBefore = Number(hf.healthFactorBefore || 0);
      const hfAfter = Number(hf.healthFactorAfter || 0);
      
      // Model: for each 1% drop in collateral value, HF drops by ~(collateralValue / debtValue * 0.01)
      // Simplified: priceDropToLiquidation = (hfBefore - 1.0) / hfBefore * 100
      const priceDropPercent = hfBefore > 0 ? ((hfBefore - 1.0) / hfBefore * 100).toFixed(2) : "?";
      const distanceBps = hfBefore > 0 ? ((hfBefore - 1) * 10000).toFixed(0) : "?";

      chainResults.push({
        address: b.address, borrowUsd: Math.round(b.borrowUsd),
        hf: hfBefore.toFixed(4), priceDropToLiq: priceDropPercent,
        distanceBps,
        risk: hfBefore < 1.01 ? "CRITICAL" : hfBefore < 1.05 ? "HIGH" : hfBefore < 1.10 ? "MEDIUM" : "LOW",
      });
    }

    chainResults.sort((a, b) => a.hf - b.hf);
    allResults[chainId] = { borrowers: borrowers.length, scanned: chainResults.length, top5: chainResults.slice(0, 5) };
    
    const names = {1:"ETH",8453:"Base",42161:"Arb",10:"OP",137:"Poly",43114:"Avax",56:"BSC",100:"Gno"};
    for (const r of chainResults.slice(0, 5)) {
      console.log("  " + (names[chainId]||"c"+chainId) + " " + r.address.slice(0,10) + "... HF=" + r.hf + " debt=$" + (r.borrowUsd/1e6).toFixed(1) + "M trigger=" + r.priceDropToLiq + "% " + r.risk);
    }
  }

  // Summary
  console.log("\n=== Global Liquidation Trigger Rankings ===");
  const allBorrowers = Object.values(allResults).flatMap(c => c.top5 || []).sort((a, b) => a.hf - b.hf);
  for (const b of allBorrowers.slice(0, 10)) {
    const chain = Object.entries(allResults).find(([,v]) => v.top5?.includes(b))?.[1];
    const names = {1:"ETH",8453:"Base",42161:"Arb",10:"OP",137:"Poly",43114:"Avax",56:"BSC",100:"Gno"};
    const cname = names[chain?.borrowers] ? "?" : Object.keys(allResults).find(k => allResults[k]?.top5?.includes(b)) || "?";
    // Find actual chain name
    let ch = "?";
    for(const [k,v] of Object.entries(allResults)){ if(v.top5?.includes(b)){ const n={1:"ETH",8453:"Base",42161:"Arb",10:"OP",137:"Poly",43114:"Avax",56:"BSC",100:"Gno"}; ch=n[Number(k)]||k; break; } }
    console.log("  " + ch + " " + b.address.slice(0,10) + "... HF=" + b.hf + " debt=$" + (b.borrowUsd/1e6).toFixed(1) + "M trigger=" + b.priceDropToLiq + "% drop");
  }

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), chains: Object.keys(allResults).length, results: allResults, globalTop10: allBorrowers.slice(0, 10) }, null, 2));
  console.log("\nArtifact: " + OUT);
}
main().catch(e => { console.error(e); process.exit(1); });
