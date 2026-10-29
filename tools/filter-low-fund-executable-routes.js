#!/usr/bin/env node
// filter-low-fund-executable-routes.js - artifact-only low-fund executable route filter.
// No RPC, no env/key reads, no signed actions.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const ROUTE_SWEEP = path.join(WORKSPACE, "reports", "raw", "fast", "route-positive-sweep.json");
const DISABLED_ROUTES = path.join(WORKSPACE, "reports", "monitor", "autopilot-disabled-routes.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "low-fund-executable-route-filter.json");
const WATCH_ONLY_LIMIT = Number(process.env.LOW_FUND_WATCH_ONLY_LIMIT || "20");
const TOP_RANK_WATCH_RETENTION = Number(process.env.LOW_FUND_TOP_RANK_WATCH_RETENTION || "12");

function loadJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[$,%\s,]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function lowerText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.toLowerCase();
  if (Array.isArray(value)) return value.map(lowerText).join(" ");
  if (typeof value === "object") return Object.values(value).map(lowerText).join(" ");
  return String(value).toLowerCase();
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function disabledMatch(row, disabledRows) {
  const text = lowerText([row.id, row.protocol, row.surface, row.status, row.blockers, row.nextReadOnlyStep]);
  for (const disabled of disabledRows) {
    const disabledText = lowerText([disabled.id, disabled.name, disabled.category, disabled.reason]);
    if (!disabledText) continue;
    if (/apyusd/.test(text) && /apyusd/.test(disabledText)) return disabled;
    if (/lorenzo|susd1/.test(text) && /lorenzo|susd1/.test(disabledText)) return disabled;
    if (/aave v4|aave-v4/.test(text) && /aave v4|aave-v4/.test(disabledText) && /direct|capital/.test(disabledText)) return disabled;
    if (/liquity|bold|steth/.test(text) && /liquity|bold|steth/.test(disabledText)) return disabled;
  }
  return null;
}

function classifyCapitalAndDelay(row, disabledRows) {
  const text = lowerText([row.id, row.protocol, row.surface, row.status, row.blockers, row.requiredForRoutePositive, row.nextReadOnlyStep]);
  const disabled = disabledMatch(row, disabledRows);
  const capitalOrDelay = Boolean(disabled)
    || hasAny(text, [
      /capital[-\s]?locked/,
      /capital[-\s]?required/,
      /own capital/,
      /manual capital/,
      /separately funded/,
      /receipt/,
      /soulbound/,
      /\block(?:ed|up|s|ing)?\b/,
      /queued|queue|cooldown/,
      /same[-\s]?epoch.*unproven/,
      /withdrawal queue/,
      /delayed/,
    ]);
  const reason = disabled?.reason || (capitalOrDelay ? "Text or disabled-route policy indicates own-capital, lock, queue, receipt, or delay gating." : null);
  return { capitalOrDelay, disabled, reason };
}

function scoreRow(row, classification) {
  const routePositive = asNumber(row.routePositive) || 0;
  const executableNow = asNumber(row.executableNow) || 0;
  const priority = asNumber(row.priorityScore) || 0;
  const distance = row.distance || {};
  const economics = row.economics || {};
  const watchCandidates = asNumber(distance.watchCandidates) || 0;
  const currentLiquidatable = asNumber(distance.currentLiquidatable) || 0;
  const rowsWithAnyQuote = asNumber(distance.rowsWithAnyQuote) || 0;
  const materialDivergenceRows = asNumber(distance.materialDivergenceRows) || 0;
  const bestNet = asNumber(economics.bestNetProfitUsd ?? economics.bestNetUsd ?? economics.stablePairCollateralFlashNetUsd ?? distance.bestNetUsd);
  const bestGap = asNumber(economics.bestNetGapToPositiveUsd ?? distance.bestNetGapToPositiveUsd);
  let score = priority;
  if (routePositive > 0) score += 40;
  if (executableNow > 0) score += 80;
  if (watchCandidates > 0) score += Math.min(20, watchCandidates * 3);
  if (currentLiquidatable > 0) score += 15;
  if (rowsWithAnyQuote > 0) score += 10;
  if (materialDivergenceRows > 0) score += 15;
  if (bestNet !== null && bestNet > 0) score += Math.min(25, bestNet / 10);
  if (bestGap !== null && bestGap > 0) score += Math.max(-15, -Math.min(15, bestGap));
  if (classification.capitalOrDelay) score -= 70;
  return Math.round(score);
}

function rowState(row, classification) {
  const routePositive = asNumber(row.routePositive) || 0;
  const executableNow = asNumber(row.executableNow) || 0;
  const text = lowerText([row.status, row.blockers, row.nextReadOnlyStep, row.requiredForRoutePositive]);
  if (classification.capitalOrDelay) return "disabled-capital-or-delay";
  if (executableNow > 0) return "escalation-ready-executable-now";
  if (routePositive > 0 && !hasAny(text, [/needs fork|no fork|fork proof absent|fork extraction proof/])) return "escalation-ready-route-positive";
  if (routePositive > 0) return "route-positive-needs-proof";
  if (hasAny(text, [/watch|near|trigger|liquidatable|candidate|divergence|stale|exact quote|same-block/])) return "watch-only-needs-route-positive";
  return "closed-route-negative";
}

function summarizeRow(row, disabledRows) {
  const classification = classifyCapitalAndDelay(row, disabledRows);
  const state = rowState(row, classification);
  const score = scoreRow(row, classification);
  return {
    rank: row.rank,
    id: row.id,
    protocol: row.protocol,
    chain: row.chain,
    surface: row.surface,
    status: row.status,
    filterState: state,
    lowFundEligible: !classification.capitalOrDelay,
    capitalOrDelayBlocked: classification.capitalOrDelay,
    capitalOrDelayReason: classification.reason,
    disabledRouteId: classification.disabled?.id || null,
    routePositive: asNumber(row.routePositive) || 0,
    executableNow: asNumber(row.executableNow) || 0,
    signedActionJustified: Boolean(row.signedActionJustified),
    priorityScore: asNumber(row.priorityScore) || 0,
    filterScore: score,
    distance: {
      watchCandidates: asNumber(row.distance?.watchCandidates) || 0,
      currentLiquidatable: asNumber(row.distance?.currentLiquidatable) || 0,
      rowsWithAnyQuote: asNumber(row.distance?.rowsWithAnyQuote) || 0,
      materialDivergenceRows: asNumber(row.distance?.materialDivergenceRows) || 0,
      bestBpsToLiquidation: round(row.distance?.bestBpsToLiquidation, 2),
      bestHealthFactor: round(row.distance?.bestHealthFactor, 6),
    },
    economics: {
      bestNetProfitUsd: round(row.economics?.bestNetProfitUsd ?? row.economics?.bestNetUsd ?? row.distance?.bestNetUsd, 6),
      bestNetGapToPositiveUsd: round(row.economics?.bestNetGapToPositiveUsd ?? row.distance?.bestNetGapToPositiveUsd, 6),
      bestRouteLiquidityUsd: round(row.economics?.bestRouteLiquidityUsd ?? row.distance?.bestRouteLiquidityUsd, 2),
      bestEdgeBps: round(row.economics?.bestEdgeBps, 4),
    },
    blockers: Array.isArray(row.blockers) ? row.blockers.slice(0, 4) : [],
    nextReadOnlyStep: row.nextReadOnlyStep || null,
    sourceArtifacts: Array.isArray(row.sourceArtifacts) ? row.sourceArtifacts : [],
  };
}

function main() {
  const sweep = loadJson(ROUTE_SWEEP, {});
  const disabled = loadJson(DISABLED_ROUTES, {});
  const disabledRows = Array.isArray(disabled.disabledRoutes) ? disabled.disabledRoutes : [];
  const ranked = Array.isArray(sweep.ranked) ? sweep.ranked : [];
  const rows = ranked.map((row) => summarizeRow(row, disabledRows));
  const escalationReady = rows
    .filter((row) => row.lowFundEligible && (row.filterState === "escalation-ready-executable-now" || row.filterState === "escalation-ready-route-positive"))
    .sort((a, b) => b.filterScore - a.filterScore);
  const routePositiveNeedsProof = rows
    .filter((row) => row.lowFundEligible && row.filterState === "route-positive-needs-proof")
    .sort((a, b) => b.filterScore - a.filterScore);
  const watchOnlyRows = rows
    .filter((row) => row.lowFundEligible && row.filterState === "watch-only-needs-route-positive")
    .sort((a, b) => b.filterScore - a.filterScore);
  const watchOnlyById = new Map();
  for (const row of watchOnlyRows.slice(0, WATCH_ONLY_LIMIT)) watchOnlyById.set(row.id, row);
  // Always retain top-ranked route-sweep watch rows, even if their low-fund
  // filter score falls outside the display cap after a refresh. The consistency
  // audit treats top aggregate rows as required classifier coverage.
  for (const row of watchOnlyRows.filter((row) => row.rank > 0 && row.rank <= TOP_RANK_WATCH_RETENTION)) {
    watchOnlyById.set(row.id, row);
  }
  const watchOnly = [...watchOnlyById.values()].sort((a, b) => b.filterScore - a.filterScore);
  const disabledOrCapital = rows
    .filter((row) => row.capitalOrDelayBlocked)
    .sort((a, b) => (b.routePositive - a.routePositive) || (a.rank - b.rank));

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/filter-low-fund-executable-routes.js",
    scope: "Artifact-only filter for low-fund, no-lock executable route candidates",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: escalationReady.length > 0,
      executableNow: escalationReady.some((row) => row.executableNow > 0),
      signedActionJustified: false,
    },
    sourceArtifacts: {
      routeSweep: path.relative(WORKSPACE, ROUTE_SWEEP),
      disabledRoutes: path.relative(WORKSPACE, DISABLED_ROUTES),
    },
    gates: {
      escalationReadyRequires: [
        "not capital-locked, queued, delayed, receipt-based, or manual-capital-only",
        "routePositive > 0 or executableNow > 0 on the source artifact",
        "exact live economics positive after gas/slippage/flash fees",
        "fork/static proof present or explicitly not required by the source artifact",
      ],
      forkOnlyAfter: [
        "same branch has a concrete positive path",
        "fresh exact quote/economics are positive",
        "no own-capital lock or delayed exit is required",
      ],
    },
    summary: {
      sourceGeneratedAt: sweep.generatedAt || null,
      rowsClassified: rows.length,
      escalationReady: escalationReady.length,
      routePositiveNeedsProof: routePositiveNeedsProof.length,
      watchOnly: watchOnly.length,
      disabledOrCapital: disabledOrCapital.length,
      executableNow: escalationReady.filter((row) => row.executableNow > 0).length,
      signedActionJustified: false,
      status: escalationReady.length > 0 ? "low-fund-escalation-candidate" : "no-low-fund-executable-route",
      topWatchOnly: watchOnly[0]?.id || null,
      topDisabledOrCapital: disabledOrCapital[0]?.id || null,
      nextAction: escalationReady.length > 0
        ? "Inspect the top escalation-ready row and run branch-specific fork/static proof."
        : watchOnly.length > 0
          ? "Keep watch-only branches refreshed; build new route discovery rather than executor code."
          : "No route-positive low-fund branch in current artifacts; run fresh discovery scanners.",
    },
    escalationReady,
    routePositiveNeedsProof,
    watchOnly,
    disabledOrCapital,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`lowFundFilter status=${out.summary.status} escalationReady=${out.summary.escalationReady} watchOnly=${out.summary.watchOnly} disabledOrCapital=${out.summary.disabledOrCapital}`);
  console.log(`Report: ${path.relative(WORKSPACE, OUT)}`);
}

main();
