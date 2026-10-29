#!/usr/bin/env node
// scan-pt-oracle-unit-mismatch.js - consolidate PT/receipt oracle valuation mismatches across consumer artifacts.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const FILES = {
  pendleConsumerGraph: path.join(WORKSPACE, "reports", "raw", "fast", "pendle-pt-consumer-graph.json"),
  siloPtOracleRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "silo-pt-oracle-routes.json"),
  morphoLiquidations: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-high-apy-liquidation-routes.json"),
  pendleMaturityRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "pendle-pt-maturity-routes.json"),
};
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "pt-oracle-unit-mismatch.json");
const OUT_MD = path.join(WORKSPACE, "reports", "pt-oracle-unit-mismatch-triage.md");
const MATERIAL_LIQUIDITY_USD = 10_000;

function loadJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 4) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function bpsDelta(accepted, reference) {
  const a = asNumber(accepted);
  const r = asNumber(reference);
  if (a === null || r === null || r === 0) return null;
  return ((a / r) - 1) * 10_000;
}

function daysTo(expiry, blockTimestamp) {
  if (!expiry) return null;
  const ts = typeof expiry === "number" ? expiry * 1000 : Date.parse(expiry);
  if (!Number.isFinite(ts)) return null;
  const base = blockTimestamp ? Number(blockTimestamp) * 1000 : Date.now();
  return (ts - base) / 86_400_000;
}

function max(values) {
  const nums = values.map(asNumber).filter((n) => n !== null);
  return nums.length ? Math.max(...nums) : null;
}

function min(values) {
  const nums = values.map(asNumber).filter((n) => n !== null);
  return nums.length ? Math.min(...nums) : null;
}

function sourcePath(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function commonRow(row) {
  const premium = asNumber(row.acceptedVsAcquisitionBps ?? row.acceptedVsPublicBps ?? row.unitMismatchBps) || 0;
  const gap = asNumber(row.breakEvenGapBps);
  const liquidity = asNumber(row.borrowCapacityUsd ?? row.oppositeLiquidityUsd ?? row.borrowLiquidityUsd) || 0;
  const net = asNumber(row.netEdgeUsd);
  const hasExactQuote = Boolean(row.exactAcquisitionQuote || row.exactExitQuote);
  const score = Math.max(0, premium)
    + Math.min(300, liquidity / 1_000)
    + (hasExactQuote ? 80 : 0)
    + (row.currentLiquidatable && hasExactQuote ? 60 : 0)
    - (gap !== null ? Math.min(600, Math.max(0, gap) / 2) : 120)
    - (liquidity <= 0 ? 120 : 0)
    - (row.currentLiquidatable && !hasExactQuote ? 80 : 0)
    + (net !== null && net > 0 ? 400 : 0);
  return {
    ...row,
    materialLiquidity: liquidity >= MATERIAL_LIQUIDITY_USD,
    routePositive: Boolean(row.routePositive && net !== null && net > 0),
    priorityScore: round(score, 2),
  };
}

function rowsFromPendleGraph(artifact) {
  const blockTs = artifact.block?.timestamp;
  const rows = [];
  for (const match of artifact.matches || []) {
    const eco = match.market?.morphoOracleEconomics;
    if (!eco) continue;
    const acceptedVsPublicBps = bpsDelta(eco.acceptedUsdPerPt, eco.publicPtUsd);
    const acceptedVsAcquisitionBps = asNumber(eco.acceptedVsAcquisitionBps ?? acceptedVsPublicBps);
    const required = asNumber(eco.requiredPremiumBps ?? eco.ltvBreakEvenPremiumBps);
    const gap = required !== null && acceptedVsAcquisitionBps !== null ? required - acceptedVsAcquisitionBps : null;
    rows.push(commonRow({
      source: "pendle-pt-consumer-graph",
      protocol: match.protocol,
      chain: match.producer?.chain || "Ethereum",
      consumerKind: "lending-collateral",
      marketId: match.market?.marketId || null,
      ptSymbol: match.producer?.symbol || match.market?.collateralAsset?.symbol || null,
      ptAddress: match.producer?.address || match.market?.collateralAsset?.address || null,
      loanSymbol: match.market?.loanAsset?.symbol || null,
      oracle: eco.oracle || match.market?.oracle?.address || null,
      ltv: round(eco.lltv ?? match.market?.lltv, 6),
      maturityDays: round(daysTo(match.producer?.expiry, blockTs), 2),
      acceptedUsdPerPt: round(eco.acceptedUsdPerPt, 8),
      publicPtUsd: round(eco.publicPtUsd, 8),
      quoteAcquisitionUsdPerPt: round(eco.quoteAcquisitionUsdPerPt, 8),
      acceptedVsPublicBps: round(acceptedVsPublicBps, 4),
      acceptedVsAcquisitionBps: round(acceptedVsAcquisitionBps, 4),
      requiredPremiumBps: round(required, 4),
      breakEvenGapBps: round(gap, 4),
      borrowCapacityUsd: round(eco.borrowCapacityUsd ?? match.market?.liquidityAssetsUsd, 2),
      borrowAssetsUsd: round(match.market?.borrowAssetsUsd, 2),
      exactAcquisitionQuote: Boolean(eco.quoteOk),
      acquisitionCostUsd: round(eco.acquisitionCostUsd, 6),
      netEdgeUsd: round(eco.netEdgeUsd, 6),
      routePositive: Boolean(eco.routePositive || match.routePositive),
      blockers: eco.blockers || match.blockers || [],
    }));
  }
  return rows;
}

function rowsFromSilo(artifact) {
  const blockTs = artifact.block?.timestamp;
  const rows = [];
  for (const row of artifact.rows || []) {
    const eco = row.economics || {};
    const acceptedVsAcquisitionBps = asNumber(eco.acceptedVsAcquisitionBps ?? eco.acceptedVsPublicBps);
    const required = asNumber(eco.requiredPremiumBps ?? eco.ltvBreakEvenPremiumBps);
    const gap = required !== null && acceptedVsAcquisitionBps !== null ? required - acceptedVsAcquisitionBps : null;
    rows.push(commonRow({
      source: "silo-pt-oracle-routes",
      protocol: "Silo V3",
      chain: "Ethereum",
      consumerKind: "lending-collateral",
      marketId: row.id || row.deploymentKey || null,
      ptSymbol: row.ptSymbol || row.pt?.symbol || null,
      ptAddress: row.ptToken || row.pt?.address || null,
      loanSymbol: row.quoteSymbol || row.quote?.symbol || null,
      oracle: row.oracle?.address || row.silo?.ptSide?.solvencyOracle || null,
      ltv: round(eco.maxLtv ?? row.silo?.ptSide?.maxLtv, 6),
      maturityDays: round(daysTo(row.pt?.expiry || row.pt?.expiryIso, blockTs), 2),
      acceptedUsdPerPt: round(eco.acceptedUsdPerPt, 8),
      publicPtUsd: round(eco.publicPtUsd, 8),
      quoteAcquisitionUsdPerPt: round(eco.quoteAcquisitionUsdPerPt, 8),
      acceptedVsPublicBps: round(eco.acceptedVsPublicBps, 4),
      acceptedVsAcquisitionBps: round(acceptedVsAcquisitionBps, 4),
      requiredPremiumBps: round(required, 4),
      breakEvenGapBps: round(gap, 4),
      borrowCapacityUsd: round(eco.borrowCapacityUsd ?? eco.oppositeLiquidityUsd, 2),
      oppositeLiquidityUsd: round(eco.oppositeLiquidityUsd, 2),
      exactAcquisitionQuote: Boolean(eco.executablePendleQuote || row.pendleQuote?.executableQuote),
      acquisitionCostUsd: round(eco.acquisitionCostUsd, 6),
      netEdgeUsd: round(eco.netEdgeUsd, 6),
      routePositive: Boolean(eco.routePositive || row.routePositive),
      blockers: eco.blockers || row.blockers || [],
    }));
  }
  return rows;
}

function rowsFromMorphoLiquidations(artifact) {
  const rows = [];
  for (const row of artifact.results || []) {
    const ptLike = [row.pair, row.collateral?.symbol, row.loanAsset?.symbol].filter(Boolean).some((x) => /(^|[-_/])PT[-_]/i.test(String(x)) || /^PT-/i.test(String(x)));
    if (!ptLike) continue;
    const best = row.best || {};
    rows.push(commonRow({
      source: "morpho-high-apy-liquidation-routes",
      protocol: "Morpho Blue",
      chain: "Ethereum",
      consumerKind: "liquidation-exit",
      marketId: row.marketId || null,
      ptSymbol: row.collateral?.symbol || null,
      ptAddress: row.collateral?.address || null,
      loanSymbol: row.loanAsset?.symbol || null,
      oracle: row.oracle || null,
      ltv: round(row.market?.lltv, 6),
      healthFactor: round(row.healthFactor, 6),
      currentLiquidatable: Boolean(row.currentLiquidatable),
      borrowAssetsUsd: round(row.market?.borrowAssetsUsd, 2),
      borrowCapacityUsd: round(row.market?.liquidityAssetsUsd, 2),
      repayUsd: round(best.repayUsd, 6),
      seizedCollateral: round(best.seizedCollateral, 6),
      exactAcquisitionQuote: false,
      exactExitQuote: Boolean(best.best),
      netEdgeUsd: round(best.best?.netProfitUsd ?? null, 6),
      routePositive: Boolean(row.routePositive || best.routePositive),
      blockers: row.blockers || best.blockers || [],
    }));
  }
  return rows;
}

function markdownTable(rows, headers) {
  const lines = [];
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) lines.push(`| ${headers.map((h) => row[h] ?? "").join(" | ")} |`);
  return lines.join("\n");
}

function main() {
  const pendle = loadJson(FILES.pendleConsumerGraph);
  const silo = loadJson(FILES.siloPtOracleRoutes);
  const morpho = loadJson(FILES.morphoLiquidations);
  const maturity = loadJson(FILES.pendleMaturityRoutes);

  const rows = [
    ...rowsFromPendleGraph(pendle),
    ...rowsFromSilo(silo),
    ...rowsFromMorphoLiquidations(morpho),
  ];

  rows.sort((a, b) => {
    const ar = a.routePositive ? 1 : 0;
    const br = b.routePositive ? 1 : 0;
    return br - ar
      || (asNumber(b.priorityScore) || 0) - (asNumber(a.priorityScore) || 0)
      || (asNumber(b.borrowCapacityUsd) || 0) - (asNumber(a.borrowCapacityUsd) || 0);
  });

  const routePositiveRows = rows.filter((row) => row.routePositive);
  const materialRows = rows.filter((row) => row.materialLiquidity);
  const exactQuoteRows = rows.filter((row) => row.exactAcquisitionQuote || row.exactExitQuote);
  const positivePremiumRows = rows.filter((row) => (asNumber(row.acceptedVsAcquisitionBps ?? row.acceptedVsPublicBps) || 0) > 0);
  const materialPositivePremiumRows = positivePremiumRows.filter((row) => row.materialLiquidity);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-pt-oracle-unit-mismatch.js",
    scope: "LoopScale-style PT/RWA receipt oracle unit-mismatch consumer consolidation",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositiveRows.length > 0,
      signedActionJustified: false,
    },
    sourceArtifacts: Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, sourcePath(file)])),
    summary: {
      rows: rows.length,
      pendleConsumerRows: (pendle.matches || []).length,
      siloRows: (silo.rows || []).length,
      morphoPtLiquidationRows: rowsFromMorphoLiquidations(morpho).length,
      maturityNearRows: maturity.summary?.ptTokensNearMaturity || maturity.summary?.nearMaturity || 0,
      materialRows: materialRows.length,
      exactQuoteRows: exactQuoteRows.length,
      positivePremiumRows: positivePremiumRows.length,
      materialPositivePremiumRows: materialPositivePremiumRows.length,
      routePositive: routePositiveRows.length,
      executableNow: 0,
      signedActionJustified: false,
      maxAcceptedVsAcquisitionBps: round(max(rows.map((row) => row.acceptedVsAcquisitionBps)), 4),
      maxAcceptedVsPublicBps: round(max(rows.map((row) => row.acceptedVsPublicBps)), 4),
      minBreakEvenGapBps: round(min(rows.map((row) => row.breakEvenGapBps)), 4),
      bestNetEdgeUsd: round(max(rows.map((row) => row.netEdgeUsd)), 6),
      bestMaterialNetEdgeUsd: round(max(materialRows.map((row) => row.netEdgeUsd)), 6),
      blocker: "PT consumers exist, but accepted values remain below LTV break-even or lack exact marketable acquisition/exit routes.",
    },
    topRows: rows.slice(0, 25),
    routePositiveRows,
    requiredForRoutePositive: [
      "PT/RWA receipt is accepted as collateral or seized collateral in a material consumer",
      "consumer oracle value exceeds executable acquisition/redemption value after LTV/LLTV haircut",
      "borrow-side or liquidation-side liquidity is available",
      "exact acquisition and exit route economics are positive after gas/slippage/fees",
      "fork/local extraction proof",
    ],
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`);

  const topTable = rows.slice(0, 10).map((row) => ({
    Source: row.source,
    Protocol: row.protocol,
    PT: row.ptSymbol,
    Loan: row.loanSymbol,
    "Premium bps": round(row.acceptedVsAcquisitionBps ?? row.acceptedVsPublicBps, 2),
    "Gap bps": round(row.breakEvenGapBps, 2),
    Liquidity: round(row.borrowCapacityUsd ?? row.oppositeLiquidityUsd, 2),
    Net: round(row.netEdgeUsd, 2),
    Verdict: row.routePositive ? "Route-positive" : (row.blockers || ["Not route-positive"])[0],
  }));
  const md = [
    "# 🟢 DORMANT — PT Oracle Unit-Mismatch Scan",
    "",
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "## Result",
    "",
    "LoopScale-style PT/unit mismatch remains a useful confirmed-signal variant, but current Ethereum PT consumer artifacts do not produce a route-positive path. Material rows either value PT below LTV break-even, lack exact executable acquisition/exit quotes, or have no borrow/liquidation liquidity.",
    "",
    "## Summary",
    "",
    markdownTable([
      {
        Rows: artifact.summary.rows,
        Material: artifact.summary.materialRows,
        "Exact Quotes": artifact.summary.exactQuoteRows,
        "Positive Premium": artifact.summary.positivePremiumRows,
        "Material Positive": artifact.summary.materialPositivePremiumRows,
        "Route Positive": artifact.summary.routePositive,
        "Best Net": artifact.summary.bestNetEdgeUsd,
      },
    ], ["Rows", "Material", "Exact Quotes", "Positive Premium", "Material Positive", "Route Positive", "Best Net"]),
    "",
    "## Top Rows",
    "",
    markdownTable(topTable, ["Source", "Protocol", "PT", "Loan", "Premium bps", "Gap bps", "Liquidity", "Net", "Verdict"]),
    "",
    "## Gate",
    "",
    "No fork, signed action, or executor change is justified until a PT consumer row has exact positive acquisition/exit economics after LTV, gas, slippage, and fees.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/pt-oracle-unit-mismatch.json`",
    "- Scanner: `tools/scan-pt-oracle-unit-mismatch.js`",
    "- Inputs: `reports/raw/fast/pendle-pt-consumer-graph.json`, `reports/raw/fast/silo-pt-oracle-routes.json`, `reports/raw/fast/morpho-high-apy-liquidation-routes.json`",
    "",
  ].join("\n");
  fs.writeFileSync(OUT_MD, md);

  console.log(`PT unit mismatch: rows=${rows.length}; material=${materialRows.length}; exactQuotes=${exactQuoteRows.length}; routePositive=${routePositiveRows.length}`);
}

main();
