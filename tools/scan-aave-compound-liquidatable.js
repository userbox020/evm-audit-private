#!/usr/bin/env node
// scan-aave-compound-liquidatable.js — Phase 1: multi-chain liquidation scanner for Aave V3 + Compound V3.
// Read-only: queries recent borrow events and checks user health across all accessible chains.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "aave-compound-liquidatable-2026-06-28.json");
const QUIET = process.argv.includes("--quiet");

// Chains to scan
const CHAINS = {
  1: { name: "Ethereum" },
  8453: { name: "Base" },
  42161: { name: "Arbitrum" },
  10: { name: "Optimism" },
  137: { name: "Polygon" },
  43114: { name: "Avalanche" },
  56: { name: "BNB Chain" },
};

// Aave V3 pool addresses per chain (from Aave official docs)
const AAVE_V3_POOLS = {
  1: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  8453: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  42161: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  10: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  137: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  43114: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  56: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
};

// Compound V3 Comet addresses per chain
const COMPOUND_COMETS = {
  1: ["0xA17581A9E3356d9A858b789D68B4d866e593aE94", "0xc3d688B66703497DAA19211EEdff47f25384cdc3"],
  8453: ["0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", "0xb125E6687d4313864e53df431d5425969c15Eb2F"],
  42161: ["0xA5EDBDD9646f8dFF606d7448e41424660b22E2fD"],
  10: ["0x2e44e174f7D53F0212823acC11C01A11d58c5bCB"],
  137: ["0xF25212E676D1F7F89Cd72fFEe66158f541246445"],
};

// Borrow event topic for Aave V3
const AAVE_BORROW_TOPIC = "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0"; // Borrow(address,address,address,uint256,uint8,...)

// Aave V3 ABI
const AAVE_POOL = new ethers.Interface([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

const COMPOUND_COMET = new ethers.Interface([
  "function isLiquidatable(address account) view returns (bool)",
  "function collateralBalanceOf(address account, address asset) view returns (uint128)",
  "function borrowBalanceOf(address account) view returns (uint256)",
  "function baseTokenPriceFeed() view returns (address)",
  "function getAssetInfoByAddress(address asset) view returns (tuple(uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))",
]);

function logPrint(msg) { if (!QUIET) console.log(`[AaveComp-Liq] ${msg}`); }

async function main() {
  const results = [];
  const rpcBlocked = [];

  for (const [chainIdStr, chain] of Object.entries(CHAINS)) {
    const chainId = Number(chainIdStr);
    const rpc = await resolveRpc(chainId);
    if (!rpc) { rpcBlocked.push({ chain: chain.name, chainId }); continue; }

    const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    const latest = await provider.getBlockNumber().catch(() => null);
    if (!latest) { logPrint(`${chain.name}: block fetch failed`); continue; }

    const chainResult = { chainId, chain: chain.name, latestBlock: latest, aave: null, compound: null };

    // Aave V3 scan
    const aavePool = AAVE_V3_POOLS[chainId];
    if (aavePool) {
      logPrint(`${chain.name}: Scanning Aave V3 recent borrows...`);
      const aaveResults = [];
      try {
        // Get recent Borrow events (last 5000 blocks ~3.5 hours)
        const fromBlock = Math.max(0, latest - 5000);
        const logs = await provider.getLogs({ address: aavePool, fromBlock, toBlock: latest, topics: [AAVE_BORROW_TOPIC] }).catch(() => []);
        logPrint(`  ${chain.name} Aave: ${logs.length} Borrow events`);

        // Deduplicate users
        const users = [...new Set(logs.map(l => {
          try { return ethers.getAddress("0x" + l.topics[2].slice(26)); } catch (_) { return null; }
        }).filter(Boolean))];

        // Check health of each user (batch of 20 at a time to avoid RPC limits)
        for (let i = 0; i < users.length && i < 200; i++) {
          try {
            const data = await provider.call({ to: aavePool, data: AAVE_POOL.encodeFunctionData("getUserAccountData", [users[i]]) });
            const decoded = AAVE_POOL.decodeFunctionResult("getUserAccountData", data);
            const hf = Number(decoded[5]) / 1e18;
            const totalCollateralBase = Number(decoded[0]) / 1e8;
            const totalDebtBase = Number(decoded[1]) / 1e8;

            if (hf < 1.5) {
              aaveResults.push({
                user: users[i],
                healthFactor: parseFloat(hf.toFixed(4)),
                totalCollateralUsd: Math.round(totalCollateralBase),
                totalDebtUsd: Math.round(totalDebtBase),
                liquidatable: hf < 1.0,
              });
            }
          } catch (e) {
            // Skip users that reverted (no borrows)
          }
        }

        // Sort by health factor (lowest first = most liquidatable)
        aaveResults.sort((a, b) => a.healthFactor - b.healthFactor);
        chainResult.aave = {
          borrowersScanned: users.length,
          nearLiquidation: aaveResults.filter(r => r.healthFactor < 1.5).length,
          liquidatable: aaveResults.filter(r => r.liquidatable).length,
          topRisky: aaveResults.slice(0, 20),
        };
        logPrint(`  ${chain.name} Aave: ${aaveResults.length} positions near liquidation, ${aaveResults.filter(r=>r.liquidatable).length} liquidatable`);
      } catch (e) {
        logPrint(`  ${chain.name} Aave: scan error - ${e.message?.slice(0,80)}`);
      }
    }

    // Compound V3 scan
    const comets = COMPOUND_COMETS[chainId] || [];
    for (const cometAddr of comets) {
      logPrint(`${chain.name}: Scanning Compound Comet ${cometAddr.slice(0,10)}...`);
      try {
        // Compound doesn't have easy borrower enumeration. Check base token supply/borrow
        // and check if any recent interactions hint at near-liquidatable accounts.
        const code = await provider.getCode(cometAddr).catch(() => "0x");
        if (!code || code === "0x") continue;

        // Check total supply and borrow
        const totalSupplyRaw = await provider.call({ to: cometAddr, data: "0x18160ddd" }).catch(() => null); // totalSupply()
        const totalBorrowRaw = await provider.call({ to: cometAddr, data: "0xfc7b9c32" }).catch(() => null); // totalBorrow()

        let totalSupply = 0, totalBorrow = 0;
        try { totalSupply = Number(ethers.formatUnits(BigInt(totalSupplyRaw || "0"), 6)); } catch (_) {}
        try { totalBorrow = Number(ethers.formatUnits(BigInt(totalBorrowRaw || "0"), 6)); } catch (_) {}

        const utilization = totalSupply > 0 ? (totalBorrow / totalSupply * 100) : 0;

        // Get base token price
        let basePrice = null;
        try {
          const feedRaw = await provider.call({ to: cometAddr, data: "0x74ebfb21" }); // baseTokenPriceFeed()
          const feed = "0x" + feedRaw.slice(26);
          if (feed !== "0x0000000000000000000000000000000000000000") {
            const priceRaw = await provider.call({ to: feed, data: "0x50d25bcd" }); // latestRoundData()
            if (priceRaw && priceRaw.length >= 194) {
              const answer = BigInt("0x" + priceRaw.slice(66, 130));
              basePrice = Number(answer) / 1e8;
            }
          }
        } catch (_) {}

        if (!chainResult.compound) chainResult.compound = [];
        chainResult.compound.push({
          comet: cometAddr,
          totalSupplyUsd: totalSupply * (basePrice || 1),
          totalBorrowUsd: totalBorrow * (basePrice || 1),
          utilizationPct: parseFloat(utilization.toFixed(1)),
          basePriceUsd: basePrice,
        });
      } catch (e) {
        logPrint(`  ${chain.name} Compound ${cometAddr.slice(0,10)}: ${e.message?.slice(0,60)}`);
      }
    }

    results.push(chainResult);
  }

  // Aggregate summary
  const totalAaveLiquidatable = results.reduce((s, r) => s + (r.aave?.liquidatable || 0), 0);
  const totalAaveNear = results.reduce((s, r) => s + (r.aave?.nearLiquidation || 0), 0);

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-aave-compound-liquidatable.js",
    scope: "Phase 1: Multi-chain Aave V3 + Compound V3 liquidation scanner",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, signedActions: false, exploitExecuteCalls: false, routePositive: false },
    rpcBlocked,
    results,
    summary: {
      chainsScanned: results.length,
      rpcBlocked: rpcBlocked.length,
      aaveBorrowersScanned: results.reduce((s, r) => s + (r.aave?.borrowersScanned || 0), 0),
      aaveLiquidatable: totalAaveLiquidatable,
      aaveNearLiquidation: totalAaveNear,
      compoundCometsScanned: results.reduce((s, r) => s + (r.compound?.length || 0), 0),
      totalCompoundSupplyUsd: results.reduce((s, r) => s + (r.compound || []).reduce((a, c) => a + (c.totalSupplyUsd || 0), 0), 0),
      totalCompoundBorrowUsd: results.reduce((s, r) => s + (r.compound || []).reduce((a, c) => a + (c.totalBorrowUsd || 0), 0), 0),
      routePositive: totalAaveLiquidatable > 0 ? 1 : 0,
    },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");

  console.log(`\n=== PHASE 1 RESULTS ===`);
  console.log(`Aave V3: ${artifact.summary.aaveBorrowersScanned} borrowers scanned, ${totalAaveLiquidatable} LIQUIDATABLE, ${totalAaveNear} near liquidation`);
  console.log(`Compound V3: ${artifact.summary.compoundCometsScanned} comets, $${Math.round(artifact.summary.totalCompoundBorrowUsd).toLocaleString()} borrowed`);
  console.log(`Route positive: ${artifact.summary.routePositive}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT)}`);

  if (totalAaveLiquidatable > 0) {
    console.log(`\n🔴 LIQUIDATABLE POSITIONS FOUND! Fork-verify top candidates immediately.`);
    results.filter(r => r.aave?.liquidatable > 0).forEach(r => {
      const top = r.aave.topRisky?.filter(u => u.liquidatable).slice(0, 5);
      top.forEach(u => console.log(`  ${r.chain} ${u.user} HF=${u.healthFactor} debt=$${u.totalDebtUsd?.toLocaleString()} collateral=$${u.totalCollateralUsd?.toLocaleString()}`));
    });
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});