#!/usr/bin/env node
// scan-aave-v3-l2-borrowers.js — Find near-liquidation Aave V3 borrowers on Base + Arbitrum
const fs = require("fs"); const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-l2-borrowers.json");

const L2_POOLS = {
  8453: { name: "Base", pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" },
  42161: { name: "Arbitrum", pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" },
  10: { name: "Optimism", pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" },
};

async function ethCall(rpc, to, sel, args = "", ms = 8000) {
  const raw = await rpcCall(rpc, "eth_call", [{ to, data: "0x" + sel + args }, "latest"], ms);
  return (raw && raw !== "0x") ? raw : null;
}

function decodeHF(raw) {
  if (!raw || raw.length < 386) return null;
  const w = raw.slice(2);
  return {
    collateral: Number(BigInt("0x" + w.slice(0, 64))) / 1e8,
    debt: Number(BigInt("0x" + w.slice(64, 128))) / 1e8,
    hf: Number(BigInt("0x" + w.slice(320, 384))) / 1e18,
  };
}

async function main() {
  console.log("=== Aave V3 L2 Near-Liquidation Scan ===\n");

  const allResults = {};

  for (const [chainId, cfg] of Object.entries(L2_POOLS)) {
    const cid = Number(chainId);
    console.log(`${cfg.name} (c${cid})...`);
    const rpc = await resolveRpc(cid);
    if (!rpc) { console.log("  No RPC\n"); allResults[cid] = { error: "no-rpc" }; continue; }

    // Query Aave V3 GraphQL for top borrowers
    let borrowers = [];
    try {
      const r = await fetch("https://api.v3.aave.com/graphql", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.aave.com", Referer: "https://app.aave.com/" },
        body: JSON.stringify({
          query: `query { userBorrows(request: { chainIds: [${cid}], first: 30, orderBy: totalBorrowsUSD, orderDirection: desc }) { user { id } } }`
        }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json();
      borrowers = (j.data?.userBorrows || []).map(b => b.user?.id).filter(Boolean);
      console.log(`  GraphQL: ${borrowers.length} top borrowers`);
    } catch (e) { console.log("  GraphQL error: " + e.message); }

    // Check HF for each borrower on-chain
    const results = [];
    for (const addr of borrowers) {
      const raw = await ethCall(rpc, cfg.pool, "bf92857c", "000000000000000000000000" + addr.slice(2));
      if (!raw) continue;
      const d = decodeHF(raw);
      if (!d || d.debt < 5000 || d.hf > 1.05) continue;
      results.push({ address: addr, chainId: cid, pool: cfg.pool, ...d, hfStr: d.hf.toFixed(5), debtUsd: Math.round(d.debt), distanceBps: ((d.hf - 1) * 10000).toFixed(1) });
    }

    results.sort((a, b) => a.hf - b.hf);
    console.log(`  Near-liquidation (HF<1.05): ${results.length}`);
    for (const r of results.slice(0, 8)) {
      console.log(`  ${r.address.slice(0,12)}... HF=${r.hfStr} debt=$${(r.debtUsd/1e6).toFixed(2)}M coll=$${(r.collateral/1e6).toFixed(2)}M dist=${r.distanceBps}bps`);
    }
    allResults[cid] = { name: cfg.name, pool: cfg.pool, scanned: borrowers.length, nearLiq: results.length, borrowers: results };
    console.log("");
  }

  // Summary
  console.log("=== Best L2 Liquidation Targets ===");
  const all = Object.values(allResults).flatMap(r => r.borrowers || []).sort((a, b) => a.hf - b.hf);
  for (const b of all.slice(0, 5)) {
    const chain = Object.entries(allResults).find(([,v]) => v.borrowers?.includes(b))?.[1]?.name || "?";
    console.log(`  ${chain}: ${b.address.slice(0,12)}... HF=${b.hfStr} debt=$${(b.debtUsd/1e6).toFixed(2)}M`);
  }

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), results: allResults, top5: all.slice(0, 5) }, null, 2));
  console.log(`\nArtifact: ${OUT}`);
}
main().catch(e => { console.error(e); process.exit(1); });
