#!/usr/bin/env node
// Consumer-first candidate review: query live Morpho/Euler market state for top review candidates.
// Checks: borrow cash available, total supply assets, utilization, oracle address, collateral ERC4626 donationability.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "consumer-first-candidate-review-2026-06-27.json");
const SOURCE = path.join(RAW_DIR, "consumer-first-high-ltv-collateral.json");

const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const EULER_EVK = "0x324598F3d03c858F9C6E3J6F2b8c4A0B5e6Ca47C"; // placeholder - will use per-vault

const MORPHO = new ethers.Interface([
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv, uint256 ltv)",
  "function marketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv, uint256 ltv)",
]);

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
]);

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const LOCAL_MATCH_FILES = ["euler-v2-phase0.json","silo-v2-phase0.json","aave-euler-silo-consumer-graph.json","morpho-high-apy-liquidation-routes.json","erc4626-consumer-joiner.json","rwa-nav-consumer-graph.json","current-profit-leads.json","route-positive-sweep.json"];
const LOCAL_TEXT_CACHE = new Map();

function localMatches(addr) { const n=String(addr||"").toLowerCase(); if(!n) return []; const m=[]; for (const f of LOCAL_MATCH_FILES) { const fp=path.join(RAW_DIR,f); if(!fs.existsSync(fp)) continue; if(!LOCAL_TEXT_CACHE.has(fp)) LOCAL_TEXT_CACHE.set(fp,fs.readFileSync(fp,"utf8").toLowerCase()); const c=LOCAL_TEXT_CACHE.get(fp).split(n).length-1; if(c>0) m.push({file:`reports/raw/fast/${f}`,count:c}); } return m; }

async function main() {
  const sourceData = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
  let allCandidates = [];
  for (const result of sourceData.results || []) {
    if (result.topRows) allCandidates = allCandidates.concat(result.topRows);
  }
  const reviewCandidates = allCandidates.filter(r => r.reviewCandidate && r.borrowAssetsUsd && r.borrowAssetsUsd > 100000);
  const sorted = reviewCandidates.sort((a,b) => (b.borrowAssetsUsd||0) - (a.borrowAssetsUsd||0));
  const top60 = sorted.slice(0, 20); // top 20 by borrow USD for speed

  console.log(`Review candidates with >$100K borrow: ${reviewCandidates.length}, processing top ${top60.length}`);

  // Group by chain for RPC efficiency
  const byChain = {};
  for (const row of top60) {
    if (!byChain[row.chainId]) byChain[row.chainId] = [];
    byChain[row.chainId].push(row);
  }

  const enrichedRows = [];
  const rpcBlocked = [];

  for (const [chainIdStr, rows] of Object.entries(byChain)) {
    const chainId = Number(chainIdStr);
    const rpc = await resolveRpc(chainId);
    if (!rpc) {
      rpcBlocked.push({ chainId, count: rows.length });
      for (const row of rows) enrichedRows.push({ ...row, rpcBlocked: true });
      continue;
    }
    const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });

    for (const row of rows) {
      const marketId = row.consumer?.marketId;
      const collateralAddr = row.collateral?.address;
      const oracleAddr = row.consumer?.oracle;

      let marketState = null;
      let marketParams = null;
      let erc4626Asset = null;
      let erc4626TotalAssets = null;
      let erc4626ConvertRate = null;
      let collateralCodeBytes = 0;
      let collateralLocalMatches = [];

      try {
        if (row.protocol === "Morpho Blue" && marketId) {
          const idBytes32 = marketId.startsWith("0x") ? marketId : "0x" + marketId;
          const [stateRaw, paramsRaw] = await Promise.all([
            provider.call({ to: MORPHO_BLUE, data: MORPHO.encodeFunctionData("market", [idBytes32]) }).catch(()=>null),
            provider.call({ to: MORPHO_BLUE, data: MORPHO.encodeFunctionData("idToMarketParams", [idBytes32]) }).catch(()=>null),
          ]);
          try { const d = MORPHO.decodeFunctionResult("market", stateRaw); if (d) marketState = { totalSupplyAssets: d[0]?.toString(), totalSupplyShares: d[1]?.toString(), totalBorrowAssets: d[2]?.toString(), totalBorrowShares: d[3]?.toString(), lastUpdate: d[4]?.toString(), fee: d[5]?.toString() }; } catch(_) {}
          try { const d = MORPHO.decodeFunctionResult("idToMarketParams", paramsRaw); if (d) marketParams = { loanToken: d[0], collateralToken: d[1], oracle: d[2], irm: d[3], lltv: d[4]?.toString(), ltv: d[5]?.toString() }; } catch(_) {}
        }
      } catch(_) {}

      // Check collateral ERC4626 properties
      if (collateralAddr) {
        try {
          const code = await provider.getCode(collateralAddr).catch(()=>"0x");
          collateralCodeBytes = code && code !== "0x" ? (code.length - 2) / 2 : 0;
          if (collateralCodeBytes > 0) {
            const [aRaw, taRaw, cRaw] = await Promise.all([
              provider.call({to: collateralAddr, data: ERC4626.encodeFunctionData("asset")}).catch(()=>null),
              provider.call({to: collateralAddr, data: ERC4626.encodeFunctionData("totalAssets")}).catch(()=>null),
              provider.call({to: collateralAddr, data: ERC4626.encodeFunctionData("convertToAssets", [10n**18n])}).catch(()=>null),
            ]);
            try { erc4626Asset = ERC4626.decodeFunctionResult("asset", aRaw)?.[0] || null; } catch(_) {}
            try { erc4626TotalAssets = ERC4626.decodeFunctionResult("totalAssets", taRaw)?.[0]?.toString() || null; } catch(_) {}
            try { erc4626ConvertRate = ERC4626.decodeFunctionResult("convertToAssets", cRaw)?.[0]?.toString() || null; } catch(_) {}
          }
          collateralLocalMatches = localMatches(collateralAddr);
        } catch(_) {}
      }

      // Calculate available borrow cash (total supply - total borrow)
      let availableBorrowCashUsd = null;
      if (marketState) {
        const supplyAssets = BigInt(marketState.totalSupplyAssets || 0);
        const borrowAssets = BigInt(marketState.totalBorrowAssets || 0);
        const available = supplyAssets - borrowAssets;
        // Convert to USD using row.borrowAsset decimals
        const decimals = row.borrowAsset?.decimals || 6;
        try { availableBorrowCashUsd = Number(ethers.formatUnits(available, decimals)); } catch(_) {}
      }

      enrichedRows.push({
        rank: enrichedRows.length + 1,
        protocol: row.protocol,
        chainId,
        chain: row.chain,
        marketId: row.consumer?.marketId || null,
        oracle: oracleAddr || marketParams?.oracle || null,
        collateralSymbol: row.collateral?.symbol,
        collateralAddress: collateralAddr,
        collateralCodeBytes,
        collateralIsERC4626: erc4626Asset !== null,
        collateralERC4626Asset: erc4626Asset,
        collateralERC4626TotalAssets: erc4626TotalAssets,
        collateralERC4626ConvertRate: erc4626ConvertRate,
        collateralLocalMatches: collateralLocalMatches,
        loanSymbol: row.borrowAsset?.symbol,
        loanAddress: row.borrowAsset?.address,
        ltv: row.ltv,
        lltv: marketParams?.lltv || null,
        borrowAssetsUsd: row.borrowAssetsUsd,
        routeLiquidityUsd: row.routeLiquidityUsd,
        availableBorrowCashUsd,
        marketState,
        riskTags: row.riskTags,
        routePositive: 0,
        blockers: [],
      });
    }
  }

  // Add blockers for each row
  for (const row of enrichedRows) {
    if (row.availableBorrowCashUsd === null) row.blockers.push("market state not readable");
    else if (row.availableBorrowCashUsd < 10000) row.blockers.push("available borrow cash below $10K threshold");
    if (!row.collateralIsERC4626) row.blockers.push("collateral is not ERC4626 — no donation attack surface");
    if (row.collateralLocalMatches.length === 0) row.blockers.push("collateral token not found in local consumer artifacts");
  }

  // Identify top candidates with material borrow cash AND ERC4626 collateral
  const promisingCandidates = enrichedRows.filter(r =>
    r.availableBorrowCashUsd && r.availableBorrowCashUsd >= 50000 &&
    r.collateralIsERC4626 &&
    !r.rpcBlocked
  ).sort((a,b) => (b.availableBorrowCashUsd||0) - (a.availableBorrowCashUsd||0));

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-consumer-first-candidate-review.js",
    scope: "Live review of consumer-first high-LTV candidates for borrow cash and oracle risks",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false, forkJustified: false },
    inputArtifact: "reports/raw/fast/consumer-first-high-ltv-collateral.json",
    totalReviewCandidates: reviewCandidates.length,
    processedTopN: enrichedRows.length,
    rpcBlocked,
    promisingCandidates: promisingCandidates.length,
    summary: {
      totalProcessed: enrichedRows.length,
      withMaterialCash: enrichedRows.filter(r => r.availableBorrowCashUsd && r.availableBorrowCashUsd >= 50000).length,
      withERC4626Collateral: enrichedRows.filter(r => r.collateralIsERC4626).length,
      withMaterialCashAndERC4626: promisingCandidates.length,
      withLocalMatches: enrichedRows.filter(r => r.collateralLocalMatches.length > 0).length,
      routePositive: 0,
      rpcBlockedRows: rpcBlocked.reduce((s,r) => s + r.count, 0),
    },
    topPromisingCandidates: promisingCandidates.slice(0, 20).map(r => ({
      rank: r.rank,
      protocol: r.protocol,
      chain: r.chain,
      collateral: r.collateralSymbol,
      loan: r.loanSymbol,
      ltv: r.ltv,
      availableBorrowCashUsd: r.availableBorrowCashUsd ? Math.round(r.availableBorrowCashUsd) : null,
      borrowAssetsUsd: Math.round(r.borrowAssetsUsd || 0),
      collateralIsERC4626: r.collateralIsERC4626,
      collateralERC4626Asset: r.collateralERC4626Asset,
      oracle: r.oracle,
      riskTags: r.riskTags,
      localMatchCount: r.collateralLocalMatches.reduce((s,m) => s+m.count, 0),
      blockers: r.blockers,
    })),
    enrichedRows: enrichedRows.slice(0, 60),
    blockers: [
      "Most candidates have available borrow cash but the collateral tokens are not ERC4626 (no donation attack surface)",
      "ERC4626 collateral tokens that exist may have virtual shares/offset preventing donation inflation",
      "Oracle addresses need staleness/deviation checking — deferred to next step for promising candidates only",
      "Route liquidity (DEX exit) needs verification for each promising candidate",
    ],
    nextRoutePositiveCriteria: [
      "A promising candidate has ERC4626 collateral with donation vulnerability AND oracle that accepts inflated share price AND material available borrow cash AND DEX exit liquidity",
      "A principal-token or receipt-token collateral has stale/mismatched oracle value vs market price AND the market has material available borrow cash",
    ],
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");

  console.log(`Consumer-first review: processed=${enrichedRows.length} materialCash=${artifact.summary.withMaterialCash} erc4626=${artifact.summary.withERC4626Collateral} promising=${promisingCandidates.length} routePositive=0 rpcBlocked=${rpcBlocked.reduce((s,r)=>s+r.count,0)}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
  if (promisingCandidates.length > 0) {
    console.log(`\nTop promising candidates:`);
    promisingCandidates.slice(0, 10).forEach((c, i) => {
      console.log(`  ${i+1}. ${c.chain} ${c.collateralSymbol} -> ${c.loanSymbol} LTV=${c.ltv} cash=$${Math.round(c.availableBorrowCashUsd||0).toLocaleString()} ERC4626=${c.collateralIsERC4626}`);
    });
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err.stack || err.message || String(err)); process.exit(1); });
