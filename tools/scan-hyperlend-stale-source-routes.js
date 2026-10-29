#!/usr/bin/env node
// Read-only HyperLend stale-source route mapper.
// Consumes sanitized live/monitor artifacts only; no RPC endpoints or signed calls.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "hyperlend-stale-source-routes.json");

const FILES = {
  live: path.join(WORKSPACE, "reports", "raw", "fast", "hyperlend-live.json"),
  state: path.join(WORKSPACE, "reports", "monitor", "state.json"),
};

const MIN_STALE_SECONDS = Number(process.env.HL_STALE_SOURCE_MIN_AGE_SECONDS || "3600");
const DEFAULT_MIN_ROUTE_LIQUIDITY_USD = Number(process.env.HL_MIN_ROUTE_LIQUIDITY_USD || "10000");

const WATCHLIST = {
  "0x9fdbda0a5e284c32744d2f17ee5c74b284993463": { symbol: "UBTC", minDivergencePct: 5, kind: "volatile" },
  "0xbe6727b535545c67d5caa73dea54865b92cf7907": { symbol: "UETH", minDivergencePct: 5, kind: "volatile" },
  "0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29": { symbol: "USOL", minDivergencePct: 5, kind: "volatile" },
  "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34": { symbol: "USDe", minDivergencePct: 1, kind: "stable" },
  "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb": { symbol: "USDt0", minDivergencePct: 1, kind: "stable" },
  "0xb50a96253abdf803d85efcdce07ad8becbc52bd5": { symbol: "USDHL", minDivergencePct: 1, kind: "stable" },
  "0xb88339cb7199b77e23db6e890353e22632ba630f": { symbol: "USDC", minDivergencePct: 1, kind: "stable" },
  "0x111111a1a0667d36bd57c0a9f569b98057111111": { symbol: "USDH", minDivergencePct: 1, kind: "stable" },
};

const STABLE_ASSETS = new Set(Object.entries(WATCHLIST)
  .filter(([, meta]) => meta.kind === "stable")
  .map(([asset]) => asset));

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function norm(value) {
  const s = String(value || "").toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(s) ? s : null;
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 4) {
  const n = asNumber(value);
  if (n === null) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function extractSourceDescription(info) {
  if (!info || typeof info !== "object") return null;
  return info.feed?.description || info.source?.description || info.adapter?.description || info.description || null;
}

function monitorLiquidityMap(state) {
  const rows = state?.conditions?.hyperlend?.reserveLiquidity || [];
  const byAsset = new Map();
  const bySymbol = new Map();
  for (const row of rows) {
    const asset = norm(row.asset);
    if (asset) byAsset.set(asset, row);
    if (row.symbol) bySymbol.set(String(row.symbol).toLowerCase(), row);
  }
  return { byAsset, bySymbol };
}

function enrichReserves(live, state) {
  const liquidity = monitorLiquidityMap(state);
  return (live?.coreReserves || []).map((reserve) => {
    const asset = norm(reserve.token);
    const watch = asset ? WATCHLIST[asset] : null;
    const liq = (asset && liquidity.byAsset.get(asset)) || liquidity.bySymbol.get(String(reserve.symbol || "").toLowerCase()) || null;
    const liveCashUsd = asNumber(reserve.cashUsd);
    const monitorCashUsd = asNumber(liq?.cashUsd);
    const cashUsd = liveCashUsd !== null ? liveCashUsd : monitorCashUsd;
    return {
      asset,
      symbol: watch?.symbol || reserve.symbol || liq?.symbol || "UNKNOWN",
      rawSymbol: reserve.symbol || null,
      watchlisted: Boolean(watch),
      kind: watch?.kind || (asset && STABLE_ASSETS.has(asset) ? "stable" : "other"),
      minDivergencePct: watch?.minDivergencePct ?? null,
      priceUsd: asNumber(reserve.priceUsd),
      liveRefPrice: asNumber(reserve.liveRefPrice),
      oracleVsRefPct: asNumber(reserve.oracleVsRefPct),
      ltv: asNumber(reserve.ltv),
      liquidationThreshold: asNumber(reserve.liquidationThreshold),
      active: Boolean(reserve.active),
      frozen: Boolean(reserve.frozen),
      borrowingEnabled: Boolean(reserve.borrowingEnabled),
      paused: Boolean(reserve.paused),
      oracleSource: reserve.oracleSource || null,
      oracleSourceType: reserve.oracleSourceInfo?.type || null,
      oracleSourceDescription: extractSourceDescription(reserve.oracleSourceInfo),
      oracleFeedAgeSeconds: asNumber(reserve.oracleFeedAgeSeconds),
      cashUsd,
      cashSource: cashUsd === null ? null : (liveCashUsd !== null ? "reports/raw/fast/hyperlend-live.json" : "reports/monitor/state.json:conditions.hyperlend.reserveLiquidity"),
    };
  });
}

function isRouteBorrowable(row, minRouteLiquidityUsd) {
  return Boolean(row && row.active && !row.frozen && !row.paused && row.borrowingEnabled && asNumber(row.cashUsd) !== null && row.cashUsd >= minRouteLiquidityUsd);
}

function bestStableReserve(rows, minRouteLiquidityUsd, excludeAsset = null, requireCollateral = false) {
  const exclude = norm(excludeAsset);
  return rows
    .filter((row) => row.kind === "stable")
    .filter((row) => row.asset && row.asset !== exclude)
    .filter((row) => isRouteBorrowable(row, minRouteLiquidityUsd))
    .filter((row) => !requireCollateral || Number(row.ltv || 0) > 0)
    .sort((a, b) => Number(b.cashUsd || 0) - Number(a.cashUsd || 0))[0] || null;
}

function buildRoute(row, rows, minRouteLiquidityUsd) {
  const divergence = asNumber(row.oracleVsRefPct);
  if (divergence === null) return null;

  if (divergence > 0) {
    if (!(Number(row.ltv || 0) > 0)) return null;
    const borrowReserve = bestStableReserve(rows, minRouteLiquidityUsd, row.asset, false);
    if (!borrowReserve) return null;
    return {
      direction: "overvalued-collateral",
      collateralAsset: row.asset,
      collateralSymbol: row.symbol,
      borrowAsset: borrowReserve.asset,
      borrowSymbol: borrowReserve.symbol,
      routeLiquidityUsd: round(borrowReserve.cashUsd, 2),
      estimatedGrossEdgeUsd: round(Number(borrowReserve.cashUsd || 0) * Math.abs(divergence) / 100, 2),
      model: "borrow stable liquidity against stale-overpriced collateral; research-only until fork proof",
    };
  }

  if (!isRouteBorrowable(row, minRouteLiquidityUsd)) return null;
  const collateralReserve = bestStableReserve(rows, minRouteLiquidityUsd, row.asset, true);
  if (!collateralReserve) return null;
  return {
    direction: "underpriced-borrow",
    collateralAsset: collateralReserve.asset,
    collateralSymbol: collateralReserve.symbol,
    borrowAsset: row.asset,
    borrowSymbol: row.symbol,
    routeLiquidityUsd: round(row.cashUsd, 2),
    estimatedGrossEdgeUsd: round(Number(row.cashUsd || 0) * Math.abs(divergence) / 100, 2),
    model: "borrow stale-underpriced asset against stable collateral; research-only until fork proof",
  };
}

function classifyRow(row, rows, minRouteLiquidityUsd) {
  const age = asNumber(row.oracleFeedAgeSeconds);
  const divergence = asNumber(row.oracleVsRefPct);
  const minDivergencePct = row.minDivergencePct ?? (row.kind === "stable" ? 1 : 5);
  const staleAccepted = Boolean(row.watchlisted && row.active && !row.paused && age !== null && age >= MIN_STALE_SECONDS);
  const materialDivergence = divergence !== null && Math.abs(divergence) >= minDivergencePct;
  const route = buildRoute(row, rows, minRouteLiquidityUsd);
  const hasRouteLiquidity = Boolean(route && Number(route.routeLiquidityUsd || 0) >= minRouteLiquidityUsd);
  const watchCandidate = Boolean(staleAccepted && materialDivergence && hasRouteLiquidity);
  const blockers = [];

  if (!row.watchlisted) blockers.push("not in HyperLend stale-source watchlist");
  if (!row.active) blockers.push("reserve inactive");
  if (row.frozen) blockers.push("reserve frozen");
  if (row.paused) blockers.push("reserve paused");
  if (age === null) blockers.push("oracle source age unavailable");
  else if (age < MIN_STALE_SECONDS) blockers.push(`source age ${Math.round(age)}s below ${MIN_STALE_SECONDS}s stale gate`);
  if (divergence === null) blockers.push("live reference divergence unavailable");
  else if (!materialDivergence) blockers.push(`divergence ${round(divergence, 4)}% below ${minDivergencePct}% route gate`);
  if (materialDivergence && !route) blockers.push("no borrow/collateral side route with sufficient liquidity");
  if (route && !hasRouteLiquidity) blockers.push("route liquidity below threshold");
  if (watchCandidate) blockers.push("no fresh executable route quote with gas/slippage/minProfit checks");

  return {
    asset: row.asset,
    symbol: row.symbol,
    rawSymbol: row.rawSymbol,
    kind: row.kind,
    ltv: row.ltv,
    liquidationThreshold: row.liquidationThreshold,
    active: row.active,
    frozen: row.frozen,
    borrowingEnabled: row.borrowingEnabled,
    paused: row.paused,
    cashUsd: row.cashUsd === null ? null : round(row.cashUsd, 2),
    oracleSource: row.oracleSource,
    oracleSourceType: row.oracleSourceType,
    oracleSourceDescription: row.oracleSourceDescription,
    oracleFeedAgeSeconds: age === null ? null : Math.round(age),
    priceUsd: row.priceUsd,
    liveRefPrice: row.liveRefPrice,
    oracleVsRefPct: divergence === null ? null : round(divergence, 6),
    minDivergencePct,
    staleAccepted,
    materialDivergence,
    divergenceProgress: divergence === null ? null : round(Math.abs(divergence) / minDivergencePct, 4),
    route,
    watchCandidate,
    routePositive: false,
    blockers,
  };
}

function main() {
  const live = readJson(FILES.live, {});
  const state = readJson(FILES.state, {});
  const stateMinLiquidity = asNumber(state?.conditions?.hyperlend?.minRouteLiquidityUsd);
  const minRouteLiquidityUsd = stateMinLiquidity || DEFAULT_MIN_ROUTE_LIQUIDITY_USD;
  const rows = enrichReserves(live, state);
  const watchRows = rows.filter((row) => row.watchlisted).map((row) => classifyRow(row, rows, minRouteLiquidityUsd));
  const staleRows = watchRows.filter((row) => row.staleAccepted);
  const divergentRows = watchRows.filter((row) => row.materialDivergence);
  const pathRows = watchRows.filter((row) => row.route);
  const watchCandidates = watchRows.filter((row) => row.watchCandidate);
  const routePositiveRows = watchRows.filter((row) => row.routePositive);

  const report = {
    generatedAt: new Date().toISOString(),
    chain: live.chain || { id: 999 },
    sourceArtifacts: ["reports/raw/fast/hyperlend-live.json", "reports/monitor/state.json"],
    gates: {
      minStaleSeconds: MIN_STALE_SECONDS,
      minRouteLiquidityUsd,
      routePositiveRequires: [
        "stale accepted oracle source",
        "live reference divergence above asset threshold",
        "borrow/collateral side liquidity above threshold",
        "fresh executable route quote with gas/slippage/minProfit checks",
      ],
      signedActionRequires: [
        "HyperEVM fork-positive extraction proof",
        "deployed verified executor with staticCall, gas, minProfit, and slippage gates",
        "explicit operator authorization",
      ],
    },
    summary: {
      totalCoreReserves: rows.length,
      watchRows: watchRows.length,
      staleAcceptedRows: staleRows.length,
      materialDivergenceRows: divergentRows.length,
      rowsWithResearchRoute: pathRows.length,
      watchCandidates: watchCandidates.length,
      routePositive: routePositiveRows.length,
      signedActionJustified: false,
    },
    watchRows,
    reserveLiquidity: rows
      .filter((row) => row.kind === "stable" || row.watchlisted)
      .map((row) => ({
        asset: row.asset,
        symbol: row.symbol,
        kind: row.kind,
        ltv: row.ltv,
        borrowingEnabled: row.borrowingEnabled,
        active: row.active,
        frozen: row.frozen,
        paused: row.paused,
        cashUsd: row.cashUsd === null ? null : round(row.cashUsd, 2),
      })),
  };

  ensureDir(OUT);
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  console.log("HyperLend stale-source route map");
  console.log(`  Watch rows: ${watchRows.length}`);
  console.log(`  Stale accepted: ${staleRows.length}`);
  console.log(`  Material divergence: ${divergentRows.length}`);
  console.log(`  Research routes: ${pathRows.length}`);
  console.log(`  Watch candidates: ${watchCandidates.length}`);
  console.log(`  routePositive: ${routePositiveRows.length}`);
  console.log(`Report: ${OUT}`);
}

main();
