#!/usr/bin/env node
// Artifact-only two-market leverage-loop economics scanner.
// Computes reciprocal Euler eVault loop ratios from existing Phase 0 artifacts.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "two-market-leverage-loops.json");
const QUIET = process.argv.includes("--quiet");

const FILES = {
  eulerV2: path.join(RAW_DIR, "euler-v2-phase0.json"),
  evaultSensitivity: path.join(RAW_DIR, "evault-donation-sensitivity.json"),
  marketLaunch: path.join(RAW_DIR, "market-launch-choreography-routes.json"),
};

const DEFAULT_CONVERSION_EFFICIENCY_PER_LEG = 0.99;

function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 6) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function addr(value) {
  const text = String(value || "").toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(text) ? text : null;
}

function short(value) {
  const a = addr(value);
  return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : null;
}

function isOpenAmount(value) {
  try { return BigInt(String(value || 0)) > 0n; } catch (_) { return false; }
}

function buildEulerGraph(euler) {
  const vaults = new Map();
  for (const row of euler.vaultRows || []) {
    const key = addr(row.vault);
    if (!key) continue;
    vaults.set(key, row);
  }

  const edges = [];
  for (const row of euler.vaultRows || []) {
    const borrowVault = addr(row.vault);
    if (!borrowVault) continue;
    for (const ltvRow of row.ltvRows || []) {
      const collateralVault = addr(ltvRow.collateralVault);
      const ltv = asNumber(ltvRow.ltvBorrowBps) / 10_000;
      if (!collateralVault || !Number.isFinite(ltv) || ltv <= 0) continue;
      edges.push({
        chainId: row.chainId,
        chain: row.chain,
        borrowVault,
        collateralVault,
        ltv,
      });
    }
  }

  return { vaults, edges };
}

function vaultInfo(vaults, address) {
  const row = vaults.get(addr(address)) || {};
  return {
    vault: row.vault || address,
    vaultShort: short(row.vault || address),
    vaultSymbol: row.vaultSymbol || null,
    asset: row.asset || null,
    assetSymbol: row.assetSymbol || null,
    oracle: row.oracle || null,
    cashUsd: round(row.cashUsd, 2),
    totalBorrowsUsd: round(row.totalBorrowsUsd, 2),
    totalAssetsUsd: round(row.totalAssetsUsd, 2),
    maxDepositOpen: isOpenAmount(row.maxDepositRaw),
    maxMintOpen: isOpenAmount(row.maxMintRaw),
    materialBorrowCash: Boolean(row.materialBorrowCash),
  };
}

function pairKey(a, b) {
  return [addr(a), addr(b)].sort().join(":");
}

function collectReciprocalLoops(graph) {
  const directed = new Map();
  for (const edge of graph.edges) directed.set(`${edge.borrowVault}:${edge.collateralVault}`, edge);

  const seen = new Set();
  const loops = [];
  for (const edge of graph.edges) {
    const reverse = directed.get(`${edge.collateralVault}:${edge.borrowVault}`);
    if (!reverse) continue;
    const key = pairKey(edge.borrowVault, edge.collateralVault);
    if (seen.has(key)) continue;
    seen.add(key);

    const a = vaultInfo(graph.vaults, edge.borrowVault);
    const b = vaultInfo(graph.vaults, edge.collateralVault);
    const grossLoopRatio = edge.ltv * reverse.ltv;
    const netLoopRatio = grossLoopRatio * DEFAULT_CONVERSION_EFFICIENCY_PER_LEG * DEFAULT_CONVERSION_EFFICIENCY_PER_LEG;
    const finiteMultiplier = grossLoopRatio < 1 ? 1 / (1 - grossLoopRatio) : null;
    const netFiniteMultiplier = netLoopRatio < 1 ? 1 / (1 - netLoopRatio) : null;
    const requiredCombinedPremiumBps = grossLoopRatio > 0 ? (1 / grossLoopRatio - 1) * 10_000 : null;
    const minCashUsd = Math.min(asNumber(a.cashUsd) || 0, asNumber(b.cashUsd) || 0);
    const maxCashUsd = Math.max(asNumber(a.cashUsd) || 0, asNumber(b.cashUsd) || 0);
    const bothPublicDepositOpen = a.maxDepositOpen && b.maxDepositOpen && a.maxMintOpen && b.maxMintOpen;
    const grossUncapped = grossLoopRatio >= 1;
    const netUncapped = netLoopRatio >= 1;
    const watchCandidate = !netUncapped && (finiteMultiplier || 0) >= 4 && minCashUsd >= 10_000;
    const priorityScore = Math.round(
      (netUncapped && minCashUsd >= 10_000 ? 100 : 0)
      + (watchCandidate ? 50 : 0)
      + Math.min(30, grossLoopRatio * 30)
      + Math.min(25, minCashUsd / 1_000_000 * 4)
      + (bothPublicDepositOpen ? 5 : 0)
    );

    const blockers = [];
    if (!netUncapped) blockers.push("Net loop ratio is below 1; amplification is finite, not self-expanding");
    if (!grossUncapped) blockers.push(`Requires combined accepted-value/conversion premium of about ${round(requiredCombinedPremiumBps / 100, 2)}% before costs`);
    if (!bothPublicDepositOpen) blockers.push("One or both eVault deposit/mint paths are not confirmed open from artifact fields");
    if (minCashUsd < 10_000) blockers.push("Reciprocal loop has insufficient two-sided borrow cash for material extraction");
    blockers.push("No exact conversion/acquisition quote between vault assets");
    blockers.push("No fork extraction proof");

    loops.push({
      priorityScore,
      protocol: "Euler EVK",
      chain: edge.chain,
      chainId: edge.chainId,
      pair: `${a.vaultSymbol || a.vaultShort} <-> ${b.vaultSymbol || b.vaultShort}`,
      legA: {
        borrowVault: a,
        collateralVault: b,
        ltv: round(edge.ltv, 6),
      },
      legB: {
        borrowVault: b,
        collateralVault: a,
        ltv: round(reverse.ltv, 6),
      },
      economics: {
        grossLoopRatio: round(grossLoopRatio, 8),
        netLoopRatio: round(netLoopRatio, 8),
        conversionEfficiencyPerLeg: DEFAULT_CONVERSION_EFFICIENCY_PER_LEG,
        finiteMultiplier: round(finiteMultiplier, 4),
        netFiniteMultiplier: round(netFiniteMultiplier, 4),
        requiredCombinedPremiumBps: round(requiredCombinedPremiumBps, 4),
        minTwoSidedCashUsd: round(minCashUsd, 2),
        maxOneSidedCashUsd: round(maxCashUsd, 2),
      },
      grossUncapped,
      netUncapped,
      watchCandidate,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
      blockers,
    });
  }

  return loops.sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0) || (b.economics.grossLoopRatio || 0) - (a.economics.grossLoopRatio || 0) || (b.economics.minTwoSidedCashUsd || 0) - (a.economics.minTwoSidedCashUsd || 0));
}

function main() {
  const euler = readJson(FILES.eulerV2);
  const evaultSensitivity = readJson(FILES.evaultSensitivity);
  const marketLaunch = readJson(FILES.marketLaunch);
  const graph = buildEulerGraph(euler);
  const reciprocalLoops = collectReciprocalLoops(graph);
  const topRows = reciprocalLoops.slice(0, 40);
  const maxGrossLoopRatio = Math.max(0, ...reciprocalLoops.map((row) => asNumber(row.economics.grossLoopRatio) || 0));
  const maxFiniteMultiplier = Math.max(0, ...reciprocalLoops.map((row) => asNumber(row.economics.finiteMultiplier) || 0));

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-two-market-leverage-loops.js",
    scope: "Artifact-only two-market leverage-loop economics from Euler V2 reciprocal eVault collateral pairs",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    inputs: Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, path.relative(WORKSPACE, file).replace(/\\/g, "/")])),
    model: {
      formula: "R = LTV_A * premium_A * conversion_A * LTV_B * premium_B * conversion_B",
      grossAssumption: "premium_A=premium_B=conversion_A=conversion_B=1",
      netConversionEfficiencyPerLeg: DEFAULT_CONVERSION_EFFICIENCY_PER_LEG,
      uncappedGate: "R_net >= 1 with material cash, public paths, exact quotes, and fork proof",
    },
    summary: {
      eulerVaultRows: (euler.vaultRows || []).length,
      directedCollateralEdges: graph.edges.length,
      reciprocalPairs: reciprocalLoops.length,
      grossUncappedRows: reciprocalLoops.filter((row) => row.grossUncapped).length,
      netUncappedRows: reciprocalLoops.filter((row) => row.netUncapped).length,
      watchCandidates: reciprocalLoops.filter((row) => row.watchCandidate).length,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      maxGrossLoopRatio: round(maxGrossLoopRatio, 8),
      maxFiniteMultiplier: round(maxFiniteMultiplier, 4),
      topRankedGrossLoopRatio: round(reciprocalLoops[0]?.economics?.grossLoopRatio, 8),
      topRankedFiniteMultiplier: round(reciprocalLoops[0]?.economics?.finiteMultiplier, 4),
      evaultDonationSensitivityRoutePositive: asNumber(evaultSensitivity?.summary?.routePositive) || 0,
      marketLaunchRoutePositive: asNumber(marketLaunch?.summary?.routePositive) || 0,
      blocker: "No reciprocal pair has net loop ratio >= 1; current loops are bounded finite leverage only",
    },
    topRows,
    rows: reciprocalLoops,
    nextRoutePositiveCriteria: [
      "net reciprocal loop ratio exceeds 1 after accepted/reference value, conversion quotes, gas, slippage, and flash fees",
      "both markets have material live cash and cap headroom",
      "deposit/borrow paths are public and unpaused",
      "exact conversion/acquisition/unwind route is positive at target size",
      "fork proof demonstrates positive net extraction",
    ],
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Two-market leverage loops: reciprocal=${artifact.summary.reciprocalPairs} netUncapped=${artifact.summary.netUncappedRows} watch=${artifact.summary.watchCandidates} routePositive=0`);
  if (!QUIET) console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main();
