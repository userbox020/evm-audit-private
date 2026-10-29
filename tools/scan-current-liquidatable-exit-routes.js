#!/usr/bin/env node
// scan-current-liquidatable-exit-routes.js - artifact-only liquidation exit-route gap ranker.
// No RPC, env, key, deploy, or signed-action access. It consolidates current liquidation artifacts
// and keeps routePositive=0 unless an upstream artifact already proves exact positive economics.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "current-liquidatable-exit-routes.json");
const QUIET = process.argv.includes("--quiet");

const FILES = {
  morphoHighApy: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-high-apy-liquidation-routes.json"),
  morphoHighApyNonDex: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-high-apy-nondex-exit-classification.json"),
  e9Salvage: path.join(WORKSPACE, "reports", "raw", "fast", "e9-liquidation-salvage-routes.json"),
  aaveV3RouteDistance: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-route-distance.json"),
  aaveV4Watch: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-watch.json"),
  aaveV4Quotes: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-quotes.json"),
  dexExitQuotes: path.join(WORKSPACE, "reports", "raw", "fast", "dex-exit-quotes.json"),
};

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

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function ageMinutes(iso) {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, ms / 60_000) : null;
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function rowKey(row) {
  return `${lower(row.marketId)}:${lower(row.borrower || row.user)}`;
}

function flattenQuotes(row) {
  const quotes = [];
  for (const size of row?.sizeResults || []) {
    for (const quote of size?.quotes || []) {
      quotes.push({
        fraction: size.fraction,
        repayUsd: asNumber(size.repayUsd),
        seizedCollateral: asNumber(size.seizedCollateral),
        seizedExceedsCollateral: Boolean(size.seizedExceedsCollateral),
        source: quote.source || null,
        pathKind: quote.pathKind || null,
        executorCompatible: Boolean(quote.executorCompatible),
        referenceOnly: Boolean(quote.referenceOnly),
        researchPositive: Boolean(quote.researchPositive),
        routePositive: Boolean(quote.routePositive),
        netProfitUsd: asNumber(quote.netProfitUsd),
        grossProfitUsd: asNumber(quote.grossProfitUsd),
        gasUsd: asNumber(quote.gasUsd),
        slippageUsd: asNumber(quote.slippageUsd),
        blockers: Array.isArray(quote.blockers) ? quote.blockers : [],
      });
    }
  }
  return quotes.sort((a, b) => (asNumber(b.netProfitUsd) ?? -Infinity) - (asNumber(a.netProfitUsd) ?? -Infinity));
}

function classifyRow(row, source, nonDexRow = null) {
  const quotes = flattenQuotes(row);
  const bestQuote = quotes[0] || null;
  const exactPositiveQuotes = quotes.filter((q) => q.routePositive);
  const researchPositiveQuotes = quotes.filter((q) => q.researchPositive && !q.routePositive);
  const executorPositiveQuotes = exactPositiveQuotes.filter((q) => q.executorCompatible);
  const bestSize = (row.sizeResults || []).find((s) => (s.quotes || []).length > 0) || row.best || (row.sizeResults || [])[0] || null;
  const nonDex = nonDexRow?.classification || null;
  const currentLiquidatable = row.currentLiquidatable !== false && (asNumber(row.healthFactor) ?? 2) < 1;
  const routePositive = exactPositiveQuotes.length > 0 || row.routePositive === true || asNumber(row.routePositive) > 0;
  let status = "liquidatable-exit-unquoted";
  if (!currentLiquidatable) status = "not-currently-liquidatable";
  else if (routePositive) status = "route-positive-needs-fork-proof";
  else if (researchPositiveQuotes.length) status = "research-positive-preview-or-nonexecutor";
  else if (bestQuote) status = "exact-quoted-route-negative";
  else if (nonDex?.exactSameBlockExitProven) status = "nondex-exit-needs-economics";
  else if (nonDex) status = "nondex-exit-unproven";

  const blockers = [];
  if (!currentLiquidatable) blockers.push("Row is not currently liquidatable");
  if (currentLiquidatable && !bestQuote) blockers.push("No exact DEX/Curve/Balancer/wrapper exit quote on the current artifact");
  if (bestQuote && !routePositive) blockers.push(bestQuote.netProfitUsd > 0 ? "Best positive route is research-only, preview-only, reference-only, or not executor-compatible" : "Best exact quote is not positive after gas/slippage/repay costs");
  if (bestQuote?.blockers?.length) blockers.push(...bestQuote.blockers);
  if (researchPositiveQuotes.length) blockers.push("Research-positive quote needs fork proof and verified executor semantics before routePositive");
  if (nonDex && !nonDex.exactSameBlockExitProven) blockers.push("Non-DEX classifier did not prove exact same-block collateral exit");
  blockers.push("No fork extraction proof", "Signed action remains fail-closed");

  return {
    id: `${source}:${rowKey(row)}`,
    source,
    protocol: source === "e9-salvage" || source === "morpho-high-apy" ? "Morpho Blue" : "unknown",
    chain: "Ethereum",
    marketId: row.marketId || null,
    borrower: row.borrower || row.user || null,
    pair: row.pair || null,
    status,
    healthFactor: round(row.healthFactor, 6),
    currentLiquidatable,
    materialDebt: (asNumber(row.graph?.borrowAssetsUsd) || 0) >= 100,
    debtUsd: round(row.graph?.borrowAssetsUsd, 2),
    collateralUsd: round(row.graph?.collateralUsd, 2),
    loanAsset: row.loanAsset ? { symbol: row.loanAsset.symbol || null, address: row.loanAsset.address || null, pricingTrusted: Boolean(row.loanAsset.pricingTrusted) } : null,
    collateral: row.collateral ? { symbol: row.collateral.symbol || null, address: row.collateral.address || null, priceUsd: round(row.collateral.priceUsd, 6) } : null,
    quote: {
      rowsWithAnyQuote: quotes.length > 0 ? 1 : 0,
      quoteCount: quotes.length,
      exactPositiveQuotes: exactPositiveQuotes.length,
      researchPositiveQuotes: researchPositiveQuotes.length,
      executorPositiveQuotes: executorPositiveQuotes.length,
      bestSource: bestQuote?.source || null,
      bestPathKind: bestQuote?.pathKind || null,
      bestFraction: bestQuote?.fraction ?? bestSize?.fraction ?? null,
      bestRepayUsd: round(bestQuote?.repayUsd ?? bestSize?.repayUsd, 6),
      bestNetUsd: round(bestQuote?.netProfitUsd, 6),
      bestGrossUsd: round(bestQuote?.grossProfitUsd, 6),
      bestExecutorCompatible: Boolean(bestQuote?.executorCompatible),
      bestReferenceOnly: Boolean(bestQuote?.referenceOnly),
      bestResearchPositive: Boolean(bestQuote?.researchPositive),
      bestRoutePositive: Boolean(bestQuote?.routePositive),
      bestBlockers: bestQuote?.blockers || [],
    },
    nonDex: nonDex ? {
      tags: nonDex.tags || [],
      exactSameBlockExitProven: Boolean(nonDex.exactSameBlockExitProven),
      sameBlockExitObserved: Boolean(nonDex.sameBlockExitObserved),
      queueOrCooldownObserved: Boolean(nonDex.queueOrCooldownObserved),
      routePositive: Boolean(nonDex.routePositive),
    } : null,
    routePositive: routePositive ? 1 : 0,
    executableNow: 0,
    signedActionJustified: false,
    blockers: blockers.filter(Boolean),
  };
}

function collectMorphoHighApy(morpho, nonDex) {
  const nonDexRows = new Map((nonDex?.rows || []).map((row) => [rowKey(row), row]));
  return (morpho?.results || [])
    .filter((row) => row.currentLiquidatable || (asNumber(row.healthFactor) ?? 2) < 1)
    .map((row) => classifyRow(row, "morpho-high-apy", nonDexRows.get(rowKey(row))));
}

function collectE9Salvage(e9) {
  return (e9?.results || [])
    .filter((row) => !row.error && (row.routePositive || (asNumber(row.healthFactor) ?? 2) < 1))
    .map((row) => classifyRow(row, "e9-salvage"));
}

function collectZeroLiquidatableProtocolRows(aaveV3, aaveV4, aaveV4Quotes) {
  return [
    {
      protocol: "Aave V3",
      artifact: "reports/raw/fast/aave-v3-route-distance.json",
      currentLiquidatableRows: asNumber(aaveV3?.summary?.currentLiquidatable) || 0,
      materialLiquidatableRows: asNumber(aaveV3?.summary?.materialLiquidatable) || 0,
      exactEconomicsRows: asNumber(aaveV3?.summary?.exactEconomicsRows) || 0,
      routePositive: asNumber(aaveV3?.summary?.routePositive) || 0,
      status: (asNumber(aaveV3?.summary?.currentLiquidatable) || 0) > 0 ? "liquidatable-needs-exit-integration" : "no-current-liquidatable-row",
    },
    {
      protocol: "Aave V4",
      artifact: "reports/raw/fast/aave-v4-liquidation-watch.json",
      currentLiquidatableRows: asNumber(aaveV4?.summary?.liquidatable) || 0,
      materialLiquidatableRows: asNumber(aaveV4?.summary?.materialLiquidatable) || 0,
      exactEconomicsRows: asNumber(aaveV4Quotes?.summary?.rowsQuoted) || 0,
      routePositive: asNumber(aaveV4Quotes?.summary?.routePositive) || 0,
      status: (asNumber(aaveV4?.summary?.liquidatable) || 0) > 0 ? "liquidatable-needs-exit-integration" : "no-current-liquidatable-row",
    },
  ];
}

function priorityScore(row) {
  const debt = asNumber(row.debtUsd) || 0;
  const bestNet = asNumber(row.quote?.bestNetUsd);
  const quotes = asNumber(row.quote?.quoteCount) || 0;
  const research = asNumber(row.quote?.researchPositiveQuotes) || 0;
  const hf = asNumber(row.healthFactor) || 1;
  return Math.round(
    45
    + Math.min(18, debt / 10_000)
    + Math.max(0, Math.min(12, (1 - hf) * 100))
    + Math.min(8, quotes * 2)
    + Math.min(12, research * 4)
    + (bestNet !== null ? Math.max(-10, Math.min(10, bestNet)) : -4)
    + (row.routePositive ? 25 : 0)
  );
}

function main() {
  const artifacts = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, readJson(file, {})]));
  const morphoRows = collectMorphoHighApy(artifacts.morphoHighApy, artifacts.morphoHighApyNonDex);
  const e9Rows = collectE9Salvage(artifacts.e9Salvage);
  const rows = [...e9Rows, ...morphoRows]
    .map((row) => ({ priorityScore: priorityScore(row), ...row }))
    .sort((a, b) => (b.routePositive - a.routePositive)
      || (b.priorityScore - a.priorityScore)
      || ((asNumber(b.quote?.bestNetUsd) ?? -Infinity) - (asNumber(a.quote?.bestNetUsd) ?? -Infinity))
      || ((asNumber(b.debtUsd) || 0) - (asNumber(a.debtUsd) || 0)));

  const exactPositiveRows = rows.filter((row) => row.routePositive > 0).length;
  const researchPositiveRows = rows.filter((row) => (asNumber(row.quote?.researchPositiveQuotes) || 0) > 0 && row.routePositive === 0).length;
  const rowsWithAnyQuote = rows.filter((row) => (asNumber(row.quote?.quoteCount) || 0) > 0).length;
  const bestNetRow = rows.find((row) => asNumber(row.quote?.bestNetUsd) !== null) || null;
  const routePositive = exactPositiveRows;
  const zeroProtocolRows = collectZeroLiquidatableProtocolRows(artifacts.aaveV3RouteDistance, artifacts.aaveV4Watch, artifacts.aaveV4Quotes);

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-current-liquidatable-exit-routes.js",
    scope: "Artifact-only ranker for currently liquidatable positions with missing exit-route proof",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive > 0,
      executableNow: false,
      signedActionJustified: false,
    },
    sourceArtifacts: Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, path.relative(WORKSPACE, file)])),
    sourceFreshnessMinutes: Object.fromEntries(Object.entries(artifacts).map(([key, artifact]) => [key, round(ageMinutes(artifact?.generatedAt || artifact?.scannedAt), 2)])),
    summary: {
      currentLiquidatableRows: rows.length,
      materialLiquidatableRows: rows.filter((row) => row.materialDebt).length,
      rowsWithAnyQuote,
      exactPositiveRows,
      researchPositiveRows,
      executorCompatiblePositiveRows: rows.filter((row) => (asNumber(row.quote?.executorPositiveQuotes) || 0) > 0).length,
      nonDexExactSameBlockExitRows: rows.filter((row) => row.nonDex?.exactSameBlockExitProven).length,
      zeroCurrentLiquidatableProtocolRows: zeroProtocolRows.filter((row) => row.currentLiquidatableRows === 0).length,
      bestNetUsd: round(bestNetRow?.quote?.bestNetUsd, 6),
      bestNetSource: bestNetRow?.source || null,
      bestNetPair: bestNetRow?.pair || null,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      status: routePositive > 0 ? "route-positive-needs-fork-proof" : researchPositiveRows > 0 ? "research-positive-exit-proof-gap" : rowsWithAnyQuote > 0 ? "liquidatable-exact-quotes-negative" : "liquidatable-exit-unquoted",
      blocker: routePositive > 0
        ? "Exact positive liquidation route still requires fork/static proof before any signed action"
        : researchPositiveRows > 0
          ? "Best current edge is preview-only/research-positive; no fork-proven same-block exit or verified executor semantics"
          : "No current liquidatable row has positive exact exit economics after repay, gas, slippage, and proof gates",
    },
    zeroProtocolRows,
    topRows: rows.slice(0, 20),
    requiredForRoutePositive: [
      "borrower is currently liquidatable under live on-chain state",
      "repay amount and seized collateral are exact for a non-overseizing liquidation size",
      "collateral exit is exact-quoted into the loan token or flash-repay token",
      "net profit remains positive after gas, slippage, flash fee, and executor constraints",
      "wrapper/non-DEX exits are fork-proven same-block, not preview-only",
    ],
    nextReadOnlyPlan: routePositive > 0
      ? "Fork/static-proof the top exact-positive route before any signed action."
      : researchPositiveRows > 0
        ? "Fork-probe the top research-positive wrapper preview route only if its net edge is large enough to survive redeem semantics and executor changes; otherwise keep scanning for exact DEX-positive rows."
        : "Keep current-liquidatable Morpho rows refreshed; broaden exact-exit quoting only for rows with material debt and non-dust collateral.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  if (!QUIET) {
    console.log(`currentLiquidatableExit rows=${out.summary.currentLiquidatableRows} quotes=${out.summary.rowsWithAnyQuote} researchPositive=${out.summary.researchPositiveRows} routePositive=${out.summary.routePositive}`);
    console.log(`Report: ${path.relative(WORKSPACE, OUT)}`);
  }
}

main();
