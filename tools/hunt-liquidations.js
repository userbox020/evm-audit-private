#!/usr/bin/env node
// hunt-liquidations.js — Finds liquidatable positions on Morpho Blue via GraphQL
// Usage: node tools/hunt-liquidations.js [--verify-liquidity] [--fork-test]

const CHAINS = { 1: "ethereum", 8453: "base", 42161: "arbitrum", 10: "optimism", 137: "polygon" };
const MORPHO_BLUE = { 1: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" };

const ARGS = process.argv.slice(2);
const VERIFY_LIQUIDITY = ARGS.includes("--verify-liquidity");
const FORK_TEST = ARGS.includes("--fork-test");

async function graphql(query) {
  const r = await fetch("https://api.morpho.org/graphql", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (j.errors) return { errors: j.errors.map(e => e.message).join("; ") };
  return j.data;
}

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║     LIQUIDATION HUNTER                  ║");
  console.log("╚══════════════════════════════════════════╝\n");

  console.log("=== Morpho Blue (all chains) ===\n");

  // Direct query: undercollateralized positions with borrow shares > 0
  const query = `{
    marketPositions(
      first: 200,
      orderBy: BorrowShares,
      orderDirection: Desc,
      where: { healthFactor_lte: 1, borrowShares_gte: "1" }
    ) {
      items {
        user { address }
        market {
          uniqueKey
          chain { id }
          lltv
          loanAsset { symbol decimals }
          collateralAsset { symbol decimals }
        }
        collateral
        borrowAssets
        healthFactor
        state { collateralUsd borrowAssetsUsd }
      }
    }
  }`;

  const data = await graphql(query);
  if (data.errors) {
    console.error("GraphQL error:", data.errors);
    return;
  }

  const positions = data?.marketPositions?.items || [];
  console.log(`Positions scanned: ${positions.length}\n`);

  const liquidatable = [];
  for (const pos of positions) {
    const hf = parseFloat(pos.healthFactor || "1");
    if (hf >= 1) continue;
    if (!pos.market) continue;

    const m = pos.market;
    const collVal = parseFloat(pos.state?.collateralUsd || "0");
    const borrow = parseFloat(pos.state?.borrowAssetsUsd || "0");
    const lltv = parseFloat(m.lltv || "0") / 1e18; // WAD format
    const liqBonus = 0.05; // 5% liquidation bonus typical
    const maxLiq = borrow * 0.5; // close factor ~50%
    const profit = maxLiq * liqBonus;

    // Filter: skip dust positions and zero-collateral defaults
    if (borrow < 100 || collVal < 1) continue;

    liquidatable.push({
      chain: CHAINS[parseInt(m.chain?.id)] || m.chain?.id || "?",
      market: `${m.loanAsset?.symbol || "?"}/${m.collateralAsset?.symbol || "?"}`,
      llTV: (lltv * 100).toFixed(1) + "%",
      borrower: pos.user?.address || "?",
      healthFactor: hf.toFixed(4),
      collateralUSD: collVal.toFixed(2),
      borrowUSD: borrow.toFixed(2),
      maxLiquidatable: maxLiq.toFixed(2),
      estProfitUSD: profit.toFixed(2),
    });
  }

  if (liquidatable.length > 0) {
    console.log(`🔴 ${liquidatable.length} LIQUIDATABLE POSITIONS FOUND:\n`);
    for (const r of liquidatable.slice(0, 20)) {
      console.log(`[${r.chain}] ${r.market} (LLTV ${r.llTV})`);
      console.log(`  ${r.borrower}  HF: ${r.healthFactor}`);
      console.log(`  Collateral: $${r.collateralUSD}  Debt: $${r.borrowUSD}`);
      console.log(`  Max liquidatable: $${r.maxLiquidatable}  Est. profit: $${r.estProfitUSD}`);
      console.log();
    }
    console.log("⚠ Warning: Verify DEX liquidity for collateral tokens before executing.");
    console.log("   Illiquid collateral = worthless seizure = unprofitable liquidation.");
    if (!VERIFY_LIQUIDITY && !FORK_TEST) {
      console.log("   Run with --verify-liquidity to check DEX pools, --fork-test for fork commands.\n");
    }

    // Optional: verify DEX liquidity for collateral tokens
    if (VERIFY_LIQUIDITY) {
      console.log("\n=== DEX Liquidity Check ===\n");
      const seen = new Set();
      for (const r of liquidatable.slice(0, 5)) {
        const key = r.market;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const q = `{pools(first:1, where:{token0_:{symbol:"${r.market.split("/")[1]}"}, token1_:{symbol:"WETH"}, totalValueLockedUSD_gt:"1000"}}){id totalValueLockedUSD}}`;
          const subgraph = await fetch("https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:q})});
          const sg = await subgraph.json();
          const pools = sg.data?.pools || [];
          console.log(`  ${r.market}: ${pools.length > 0 ? `✅ $${Number(pools[0].totalValueLockedUSD).toLocaleString()} TVL` : "❌ No Uniswap V3 pool found"}`);
        } catch (e) {
          console.log(`  ${r.market}: ⚠ Query failed`);
        }
      }
    }

    // Optional: fork test commands
    if (FORK_TEST) {
      console.log("\n=== Fork Test Commands ===\n");
      console.log("# Start anvil fork:");
      console.log("# anvil --fork-url $RPC --fork-block-number LATEST --port 8546\n");
      for (const r of liquidatable.slice(0, 3)) {
        console.log(`# ${r.market} — ${r.borrower} (HF: ${r.healthFactor})`);
        console.log(`# 1. Impersonate liquidator with WETH`);
        console.log(`# 2. Call Morpho.liquidate(marketParams, ${r.borrower}, seized, repaid, data)`);
        console.log(`# 3. Sell seized ${r.market.split("/")[1]} for WETH`);
        console.log(`# 4. Verify profit: $${r.estProfitUSD}\n`);
      }
    }
  } else {
    console.log("⚪ No undercollateralized positions found in active markets\n");
  }

  // Also run quick Compound V3 market check via existing scanner
  console.log("=== Compound V3 Quick Check ===\n");
  const cp = require("child_process");
  try {
    const out = cp.execSync("node targets/compound-comet/scan-compound-live.js", { cwd: require("path").resolve(__dirname, ".."), timeout: 300000, stdio: ["ignore", "pipe", "pipe"] }).toString();
    const lines = out.split("\n").filter(l => l.includes("HIGH_BORROW_CF") || l.includes("BUY_COLLATERAL"));
    if (lines.length > 0) {
      console.log("High-CF collateral balances (potential liquidation targets):");
      for (const l of lines.slice(0, 10)) {
        const parts = l.split(",");
        console.log(`  ${parts[0]}/${parts[1]} ${parts[2]} CF=${parts[3]} $${parts.slice(-2)[1]}`);
      }
    }
    // Check for buyCollateral opportunities
    const disc = out.match(/Estimated buyCollateral[\s\S]*?(?=\n\n)/);
    if (disc && !disc[0].includes("chain,market")) console.log("\n" + disc[0].trim());
    else console.log("  No material buyCollateral discounts");
  } catch (e) {
    console.log("  Compound scanner unavailable");
  }

  console.log("\nRun periodically: node tools/hunt-liquidations.js");
}

main().catch(e => { console.error(e); process.exit(1); });
