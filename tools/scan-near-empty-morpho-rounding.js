#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpcPool, rpcCall } = require("./shared-rpc");
const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "near-empty-morpho-rounding.json");
const QUIET = process.argv.includes("--quiet");

function ensureDir(f) { fs.mkdirSync(path.dirname(f), { recursive: true }); }
function jsonReplacer(_k, v) { return typeof v === "bigint" ? v.toString() : v; }
function round(v, d = 2) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * (10 ** d)) / (10 ** d) : null; }

async function main() {
  const chains = [1, 10, 8453, 42161, 137, 43114, 56, 534352, 59144, 5000, 81457, 57073, 130, 480];
  const allMarkets = [];
  for (const cid of chains) {
    const q = `{ markets(first: 100, where: { chainId_in: [${cid}] }, orderBy: BorrowAssetsUsd, orderDirection: Asc) { items { collateralAsset { symbol address decimals } loanAsset { symbol address decimals } oracle { address } lltv state { supplyAssetsUsd supplyShares borrowAssetsUsd } } } }`;
    try {
      const res = await fetch("https://blue-api.morpho.org/graphql", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      const data = await res.json();
      const items = (data?.data?.markets?.items || []).map(m => ({ ...m, chainId: cid }));
      allMarkets.push(...items);
      if (!QUIET) console.error(`Chain ${cid}: ${items.length} markets`);
    } catch (_) {}
  }

  const lowSupply = allMarkets
    .filter(m => { const su = Number(m.state?.supplyAssetsUsd) || 0; return su > 0 && su <= 100000; })
    .map(m => {
      const supplyUsd = round(Number(m.state?.supplyAssetsUsd) || 0, 2);
      const supplyShares = m.state?.supplyShares;
      const collDec = m.collateralAsset?.decimals || 18;
      let exchangeRate = null;
      if (supplyShares && supplyShares !== "0") {
        const rate = round(Number(ethers.formatUnits(BigInt(supplyShares), collDec)), 8);
        exchangeRate = rate > 0 && supplyUsd > 0 ? round(supplyUsd / rate, 8) : null;
      }
      const smallShares = supplyShares ? BigInt(supplyShares) < 10n ** 18n : false;
      const borrowUsd = round(Number(m.state?.borrowAssetsUsd) || 0, 2);
      let score = 0; const risks = [];
      if (supplyUsd < 100) { score += 40; risks.push("dust-supply"); }
      else if (supplyUsd < 1000) { score += 30; risks.push("ultra-low"); }
      else if (supplyUsd < 10000) { score += 20; risks.push("very-low"); }
      else { score += 10; risks.push("low-supply"); }
      if (smallShares) { score += 30; risks.push("tiny-shares"); }
      if (Number(m.lltv) > 0.9) { score += 15; risks.push("high-LLTV"); }
      if (borrowUsd > 100) { score += 10; risks.push("has-material-borrows"); }
      return { chainId: m.chainId, collateral: m.collateralAsset?.symbol, collateralAddr: m.collateralAsset?.address, loan: m.loanAsset?.symbol, loanAddr: m.loanAsset?.address, oracle: m.oracle?.address, lltv: Number(m.lltv), supplyUsd, borrowUsd, supplyShares, smallShares, exchangeRate, riskScore: score, risks };
    })
    .sort((a, b) => b.riskScore - a.riskScore);

  const candidates = lowSupply.filter(m => m.smallShares).map(m => ({
    ...m,
    watchCandidate: true,
    routePositive: false,
    executableNow: false,
    signedActionJustified: false,
    routeGate: {
      status: "near-empty-rounding-watch-needs-exact-accounting-economics-and-fork",
      exactAccountingBypass: false,
      exactBorrowExitRoute: false,
      exactEconomicsPositive: false,
      forkProof: false,
    },
    blockers: [
      "Tiny shares/dust supply are launch-risk indicators only, not an accounting bypass.",
      "No exact share/asset rounding profit model tied to current Morpho borrow liquidity.",
      "No exact collateral acquisition, borrow, exit economics, or fork proof.",
    ],
  }));

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-near-empty-morpho-rounding.js",
    scope: "Near-empty Morpho market exchange-rate rounding attack surface",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, signedActions: false, routePositive: false, executableNow: false, signedActionJustified: false },
    summary: {
      marketsScanned: allMarkets.length,
      lowSupplyMarkets: lowSupply.length,
      tinyShareCandidates: candidates.length,
      watchCandidates: candidates.length,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      status: "watch-only-no-exact-rounding-route",
    },
    candidates: candidates.slice(0, 30),
  };

  ensureDir(OUT);
  fs.writeFileSync(OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);
  console.log(JSON.stringify({ scanned: allMarkets.length, lowSupply: lowSupply.length, tinyShareCandidates: candidates.length, top5: candidates.slice(0, 5).map(c => ({ chainId: c.chainId, collateral: c.collateral, loan: c.loan, supplyUsd: c.supplyUsd, lltv: c.lltv, exchangeRate: c.exchangeRate, risks: c.risks })) }, null, 2));
}

main().catch(err => { console.error(JSON.stringify({ ok: false, error: String(err) })); process.exit(1); });
