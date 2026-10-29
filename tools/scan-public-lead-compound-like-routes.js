#!/usr/bin/env node
// scan-public-lead-compound-like-routes.js - artifact-only route filter for public high-APY Compound-like leads.
// Consumes sanitized current-profit lead triage only. No RPC, env, keys, or signed actions.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const IN = path.join(WORKSPACE, "reports", "raw", "fast", "current-profit-lead-triage.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "public-lead-compound-like-routes.json");

const MIN_DEX_LIQUIDITY_USD = Number(process.env.PUBLIC_LEAD_COMPOUND_MIN_DEX_LIQUIDITY_USD || "10000");
const MIN_REDEEM_CASH_USD = Number(process.env.PUBLIC_LEAD_COMPOUND_MIN_REDEEM_CASH_USD || "10000");
const MIN_NAV_DIVERGENCE_PCT = Number(process.env.PUBLIC_LEAD_COMPOUND_MIN_NAV_DIVERGENCE_PCT || "0.5");

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function num(value) {
  const n = Number(String(value ?? "").replace(/[$,%_\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 6) {
  const n = num(value);
  if (n === null) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function impliedUnderlyingPriceUsd(compound) {
  const navUsd = num(compound?.navUsd);
  const oneTokenUnderlying = num(compound?.oneTokenUnderlying);
  if (navUsd === null || oneTokenUnderlying === null || oneTokenUnderlying <= 0) return null;
  return navUsd / oneTokenUnderlying;
}

function classifyRow(lead, assessment) {
  const compound = assessment.compound || {};
  const underlyingPriceUsd = impliedUnderlyingPriceUsd(compound);
  const cash = num(compound.cash);
  const cashUsd = cash !== null && underlyingPriceUsd !== null ? cash * underlyingPriceUsd : null;
  const topDexLiquidityUsd = num(assessment.topDexLiquidityUsd) || 0;
  const navMarketDivergencePct = num(compound.navMarketDivergencePct);
  const absNavMarketDivergencePct = navMarketDivergencePct === null ? null : Math.abs(navMarketDivergencePct);

  const hasDexLiquidity = topDexLiquidityUsd >= MIN_DEX_LIQUIDITY_USD;
  const hasRedeemCash = cashUsd !== null && cashUsd >= MIN_REDEEM_CASH_USD;
  const materialDivergence = absNavMarketDivergencePct !== null && absNavMarketDivergencePct >= MIN_NAV_DIVERGENCE_PCT;
  const routePositive = hasDexLiquidity && hasRedeemCash && materialDivergence;

  const blockers = [];
  if (!hasDexLiquidity) blockers.push(`cToken DEX liquidity ${round(topDexLiquidityUsd, 2) || 0} below $${MIN_DEX_LIQUIDITY_USD}`);
  if (!hasRedeemCash) blockers.push(`redeem cash ${cashUsd === null ? "unknown" : "$" + round(cashUsd, 2)} below $${MIN_REDEEM_CASH_USD}`);
  if (!materialDivergence) blockers.push(`NAV/market divergence ${round(navMarketDivergencePct, 6)}% below ${MIN_NAV_DIVERGENCE_PCT}% route gate`);
  if (!routePositive) blockers.push("No exact borrow/redeem/DEX route or fork proof");

  return {
    lead: lead.label,
    project: lead.lead?.project || lead.lead?.name || null,
    chain: lead.chain,
    poolSymbol: lead.lead?.symbol || null,
    leadApyPct: round(lead.lead?.apyPct, 4),
    token: {
      address: assessment.address,
      symbol: assessment.token?.symbol || null,
      name: assessment.token?.name || null,
    },
    underlying: compound.underlyingMeta ? {
      address: compound.underlying,
      symbol: compound.underlyingMeta.symbol || null,
      decimals: compound.underlyingMeta.decimals ?? null,
    } : null,
    metrics: {
      oneTokenUnderlying: round(compound.oneTokenUnderlying, 10),
      navUsd: round(compound.navUsd, 8),
      marketPriceUsd: round(compound.marketPriceUsd, 8),
      navMarketDivergencePct: round(navMarketDivergencePct, 6),
      absNavMarketDivergencePct: round(absNavMarketDivergencePct, 6),
      cash: round(compound.cash, 10),
      cashUsd: round(cashUsd, 4),
      borrows: round(compound.borrows, 4),
      reserves: round(compound.reserves, 4),
      topDexLiquidityUsd: round(topDexLiquidityUsd, 2),
    },
    gates: {
      hasDexLiquidity,
      hasRedeemCash,
      materialDivergence,
    },
    watchCandidate: hasDexLiquidity || hasRedeemCash || materialDivergence,
    routePositive,
    signedActionJustified: false,
    blockers,
  };
}

function main() {
  const artifact = readJson(IN, {});
  const leads = Array.isArray(artifact.leads) ? artifact.leads : [];
  const rows = [];

  for (const lead of leads) {
    for (const assessment of lead.tokenAssessments || []) {
      if (!assessment?.compound?.isCompoundLike) continue;
      rows.push(classifyRow(lead, assessment));
    }
  }

  rows.sort((a, b) => (b.routePositive - a.routePositive)
    || ((b.metrics.absNavMarketDivergencePct || 0) - (a.metrics.absNavMarketDivergencePct || 0))
    || ((b.metrics.cashUsd || 0) - (a.metrics.cashUsd || 0)));

  const routePositiveRows = rows.filter((row) => row.routePositive);
  const watchRows = rows.filter((row) => row.watchCandidate && !row.routePositive);
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-public-lead-compound-like-routes.js",
    scope: "Focused artifact-only filter for public high-APY Compound-like lead routes",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: routePositiveRows.length > 0,
      signedActionJustified: false,
    },
    input: "reports/raw/fast/current-profit-lead-triage.json",
    thresholds: {
      minDexLiquidityUsd: MIN_DEX_LIQUIDITY_USD,
      minRedeemCashUsd: MIN_REDEEM_CASH_USD,
      minNavDivergencePct: MIN_NAV_DIVERGENCE_PCT,
    },
    summary: {
      inputGeneratedAt: artifact.generatedAt || null,
      leadsScanned: leads.length,
      compoundLikeRows: rows.length,
      rowsWithDexLiquidity: rows.filter((row) => row.gates.hasDexLiquidity).length,
      rowsWithRedeemCash: rows.filter((row) => row.gates.hasRedeemCash).length,
      materialNavDivergenceRows: rows.filter((row) => row.gates.materialDivergence).length,
      watchCandidates: watchRows.length,
      routePositive: routePositiveRows.length,
      executableNow: 0,
      signedActionJustified: false,
      bestAbsNavDivergencePct: rows.length ? Math.max(...rows.map((row) => row.metrics.absNavMarketDivergencePct || 0)) : null,
      bestRedeemCashUsd: rows.length ? Math.max(...rows.map((row) => row.metrics.cashUsd || 0)) : null,
      blocker: routePositiveRows.length ? null : "No public Compound-like lead has cToken liquidity, redeem cash, and material NAV/market divergence at the same time.",
    },
    topRows: rows.slice(0, 20),
    rows,
  };

  ensureDir(OUT);
  fs.writeFileSync(OUT, JSON.stringify(output, null, 2) + "\n");
  console.log(`Public Compound-like lead routes: rows=${rows.length} watch=${watchRows.length} routePositive=${routePositiveRows.length}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main();
