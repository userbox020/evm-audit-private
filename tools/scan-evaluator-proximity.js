#!/usr/bin/env node
// scan-evaluator-proximity.js — read-only cross-evaluator proximity ranking.
// Aggregates sanitized monitor artifacts and public DeFiLlama signals only.

const fs = require("fs");
const path = require("path");
const { forceMonitorOnlyArtifact } = require("./monitor-minimal-env");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "evaluator-proximity.json");
const QUIET = process.argv.includes("--quiet");

const FILES = {
  state: path.join(WORKSPACE, "reports", "monitor", "state.json"),
  alerts: path.join(WORKSPACE, "reports", "monitor", "alerts.jsonl"),
  routePositiveSweep: path.join(WORKSPACE, "reports", "raw", "fast", "route-positive-sweep.json"),
  e12xRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "e12x-route-dry-runs.json"),
  e2QuoteVault: path.join(WORKSPACE, "reports", "raw", "fast", "e2-quotevault-candidates.json"),
  staleOracle: path.join(WORKSPACE, "reports", "raw", "fast", "stale-oracle-liquidity-candidates.json"),
  hyperlend: path.join(WORKSPACE, "reports", "raw", "fast", "hyperlend-live.json"),
  lorenzo: path.join(WORKSPACE, "reports", "raw", "fast", "lorenzo-susd1plus-live.json"),
  currentProfitTriage: path.join(WORKSPACE, "reports", "raw", "fast", "current-profit-lead-triage.json"),
  erc4626Joiner: path.join(WORKSPACE, "reports", "raw", "fast", "erc4626-consumer-joiner.json"),
  erc4626V4HookOverlaps: path.join(WORKSPACE, "reports", "raw", "fast", "erc4626-v4-hook-overlaps.json"),
  e15VaultDonationRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "e15-vault-donation-routes.json"),
  consumerFirstHighLtv: path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json"),
  focusedMorphoReview: path.join(WORKSPACE, "reports", "raw", "fast", "focused-morpho-review-producers.json"),
  morphoPublicAllocatorForceFeed: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-public-allocator-force-feed.json"),
  morphoHighApyLiquidationRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-high-apy-liquidation-routes.json"),
  aaveV4Hubs: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-hubs.json"),
  aaveV4Borrowers: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-spoke-borrowers.json"),
  curveIbStable: path.join(WORKSPACE, "reports", "raw", "fast", "curve-ib-stable-wrapper-route.json"),
  baseSyrupUsdc: path.join(WORKSPACE, "reports", "raw", "fast", "base-syrupusdc-routes.json"),
  baseCadc: path.join(WORKSPACE, "reports", "raw", "fast", "base-cadc-routes.json"),
  avalancheStableYield: path.join(WORKSPACE, "reports", "raw", "fast", "avalanche-stable-yield-routes.json"),
  venusBaseWsteth: path.join(WORKSPACE, "reports", "raw", "fast", "venus-base-wsteth-routes.json"),
  hyperliquidLinkedTokens: path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-linked-token-invariants.json"),
  hyperliquidLinkedTokenConsumers: path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-linked-token-consumers.json"),
  hyperliquidCoreDexDepth: path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-core-dex-depth-routes.json"),
  hyperevmLstLrtOracleRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "hyperevm-lst-lrt-oracle-routes.json"),
  hyperevmLstLrtExactQuotes: path.join(WORKSPACE, "reports", "raw", "fast", "hyperevm-lst-lrt-exact-quotes.json"),
  apyusdRedeemRoute: path.join(WORKSPACE, "reports", "raw", "fast", "apyusd-erc4626-redeem-route.json"),
  apyusdForkProof: path.join(WORKSPACE, "reports", "raw", "fast", "apyusd-erc4626-fork-proof.json"),
  originArmGrowth: path.join(WORKSPACE, "reports", "raw", "fast", "origin-arm-growth-map.json"),
  bridgersGrowth: path.join(WORKSPACE, "reports", "raw", "fast", "bridgers-growth-map.json"),
  usdt0OftRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "usdt0-oft-routes.json"),
  usdt0ConsumerRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "usdt0-consumer-routes.json"),
  pendlePtConsumerGraph: path.join(WORKSPACE, "reports", "raw", "fast", "pendle-pt-consumer-graph.json"),
  siloPtOracleRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "silo-pt-oracle-routes.json"),
  xstocksConsumerRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "xstocks-consumer-routes.json"),
  dexConsumerRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "dex-consumer-routes.json"),
  solanaConsumerRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "solana-consumer-routes.json"),
  jupiterLendOracleDivergence: path.join(WORKSPACE, "reports", "raw", "fast", "jupiter-lend-oracle-divergence.json"),
  perpsConsumerRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "perps-consumer-routes.json"),
  dexExitQuotes: path.join(WORKSPACE, "reports", "raw", "fast", "dex-exit-quotes.json"),
  lorenzoBscSupplyWatch: path.join(WORKSPACE, "reports", "raw", "fast", "lorenzo-bsc-supply-route-watch.json"),
  oracleStalenessCrossRef: path.join(WORKSPACE, "reports", "raw", "fast", "oracle-staleness-cross-ref.json"),
  hgethDexWatch: path.join(WORKSPACE, "reports", "raw", "fast", "hgeth-dex-liquidity-watch.json"),
  pendlePtMaturityRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "pendle-pt-maturity-routes.json"),
};

const PUBLIC_PROTOCOL_SLUGS = new Map([
  ["lorenzo-susd1+", "Lorenzo sUSD1+"],
  ["hyperlend-pooled", "HyperLend Pooled"],
  ["morpho-blue", "Morpho Blue"],
  ["venus", "Venus"],
  ["silo-v2", "Silo V2"],
  ["aave-v4", "Aave V4"],
  ["fluid-lending", "Fluid Lending"],
  ["compound-v3", "Compound V3"],
  ["avalon-usda", "Avalon USDa"],
  ["usd-ai", "USD AI"],
  ["derive-v2", "Derive V2"],
  ["xstocks", "xStocks"],
  ["solstice", "Solstice"],
  ["infinifi", "infiniFi"],
  ["sky-lending", "Sky Lending"],
]);

const PUBLIC_MAPPED_FILES = {
  "aave-v4": ["reports/aave-v4-hubs-triage.md", "reports/raw/fast/aave-v4-hubs.json"],
  "avalon-usda": ["reports/avalon-usda-triage.md", "reports/raw/fast/avalon-usda-live.json"],
  "derive-v2": ["reports/derive-v2-triage.md"],
  "xstocks": ["reports/xstocks-triage.md", "reports/raw/fast/xstocks-live.json"],
  "solstice": ["reports/solstice-triage.md", "reports/raw/fast/solstice-live.json"],
  "infinifi": ["reports/infinifi-triage.md"],
  "sky-lending": ["reports/sky-lending-triage.md"],
  "usd-ai": ["reports/usdai-arbitrum-triage.md", "reports/raw/fast/usdai-arbitrum-live.json"],
};

const PUBLIC_YIELD_PROJECT_RE = /morpho|venus|hyperlend|lorenzo|aave|compound|fluid|silo|gearbox/i;

function loadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function loadJsonl(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (_) {
    return [];
  }
}

function existingMappedPublicSlugs() {
  const mapped = new Set();
  for (const [slug, files] of Object.entries(PUBLIC_MAPPED_FILES)) {
    if (files.some((file) => fs.existsSync(path.join(WORKSPACE, file)))) mapped.add(slug);
  }
  return mapped;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function clamp(value, min = 0, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function round(value, decimals = 2) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[$,%\s,]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function latestByCondition(alerts, condition) {
  for (let i = alerts.length - 1; i >= 0; i--) {
    if (alerts[i]?.condition === condition) return alerts[i];
  }
  return null;
}

function maxBy(items, fn) {
  let best = null;
  let bestScore = -Infinity;
  for (const item of items || []) {
    const score = Number(fn(item));
    if (Number.isFinite(score) && score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

function severityRank(severity) {
  return ({ CRITICAL: 4, HIGH: 3, WARN: 2, ACTIVE: 2, DORMANT: 1, INFO: 0 }[severity] ?? 0);
}

function rankCandidate(candidate) {
  return {
    ...candidate,
    score: Math.round(clamp(candidate.score, 0, 100)),
    observedUpstreamAuthorizationSignal: Boolean(candidate.executableNow || candidate.signedActionJustified),
    executableNow: false,
    signedActionJustified: false,
  };
}

function readiness(status, autoExecutableWhenTriggered, details = {}) {
  return {
    status: /armed|executable|auto-enabled/i.test(status) ? "watch-only-upstream-signal-observed" : status,
    observedUpstreamAuthorizationSignal: Boolean(autoExecutableWhenTriggered),
    autoExecutableWhenTriggered: false,
    requiredTrigger: details.requiredTrigger || [],
    missingBeforeAutoExec: details.missingBeforeAutoExec || [],
    livePreflight: details.livePreflight || [],
  };
}

function routePositiveSweepCandidate(sweep = {}) {
  const summary = sweep?.summary || {};
  const top = Array.isArray(sweep?.ranked) ? sweep.ranked[0] : null;
  const routePositive = asNumber(summary.routePositive) || 0;
  const topScore = asNumber(summary.topPriorityScore ?? top?.priorityScore) || 0;
  const rankedCount = asNumber(summary.candidatesRanked) || (Array.isArray(sweep?.ranked) ? sweep.ranked.length : 0);
  const topRows = (Array.isArray(sweep?.ranked) ? sweep.ranked : []).slice(0, 6).map((row) => ({
    rank: row.rank,
    id: row.id,
    protocol: row.protocol,
    chain: row.chain,
    status: row.status,
    priorityScore: row.priorityScore,
    routePositive: row.routePositive,
    distance: row.distance,
  }));

  return rankCandidate({
    id: "route-positive-sweep",
    evaluator: "research",
    surface: "Unified read-only route-positive distance sweep",
    status: routePositive > 0 ? "route-positive-needs-fork-proof" : "ranked-no-route-positive",
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score: 28 + clamp(topScore / 100, 0, 1) * 50 + (routePositive > 0 ? 25 : 0),
    proximity: `${rankedCount} ranked; top ${summary.topCandidate || top?.id || "none"} score ${round(topScore, 0)}; route-positive ${routePositive}`,
    keyMetrics: {
      artifactsAvailable: summary.artifactsAvailable || 0,
      candidatesRanked: rankedCount,
      routePositive,
      executableNow: summary.executableNow || 0,
      signedActionJustified: Boolean(summary.signedActionJustified),
      topCandidate: summary.topCandidate || top?.id || null,
      topStatus: summary.topStatus || top?.status || null,
      topPriorityScore: topScore,
      topRows,
    },
    blockers: routePositive > 0
      ? ["Needs route-specific fork extraction proof before any live action"]
      : ["No source artifact has exact positive route economics", "Fork gate remains closed", "Signed action remains unjustified"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["source artifact routePositive > 0", "exact route economics positive after gas/slippage", "fork extraction proof"],
      missingBeforeAutoExec: ["route-positive source artifact", "fork proof", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh route-positive sweep", "fresh exact quote", "static call", "gas estimate", "minProfit/minOut gates"],
    }),
    nextReadOnlyStep: summary.nextBranch || top?.nextReadOnlyStep || "Refresh the top-ranked route surface; fork only after routePositive > 0.",
    sourceArtifacts: ["reports/raw/fast/route-positive-sweep.json"],
  });
}

function protocolSummary(protocols) {
  const out = {};
  for (const p of protocols || []) {
    if (!PUBLIC_PROTOCOL_SLUGS.has(p.slug)) continue;
    out[p.slug] = {
      name: p.name,
      category: p.category,
      tvlUsd: round(p.tvl, 0),
      change1dPct: round(p.change_1d, 2),
      change7dPct: round(p.change_7d, 2),
      chains: Array.isArray(p.chains) ? p.chains.slice(0, 10) : [],
    };
  }
  return out;
}

function publicGrowthScore(protocolsBySlug, slug) {
  const p = protocolsBySlug?.[slug];
  if (!p) return 0;
  const oneDay = clamp((p.change1dPct || 0) / 20, 0, 1);
  const sevenDay = clamp((p.change7dPct || 0) / 100, 0, 1);
  const tvl = clamp(Math.log10(Math.max(1, p.tvlUsd || 0)) / 9, 0, 1);
  return Math.round((oneDay * 5) + (sevenDay * 8) + (tvl * 5));
}

function yieldLeadsSummary(yields) {
  const rows = Array.isArray(yields?.data) ? yields.data : [];
  return rows
    .filter((p) => (p.tvlUsd || 0) > 100_000 && (p.apy || 0) > 5 && PUBLIC_YIELD_PROJECT_RE.test(`${p.project} ${p.symbol}`))
    .sort((a, b) => (b.apy || 0) - (a.apy || 0))
    .slice(0, 25)
    .map((p) => ({
      project: p.project,
      chain: p.chain,
      symbol: p.symbol,
      tvlUsd: round(p.tvlUsd, 0),
      apyPct: round(p.apy, 2),
      apyBasePct: round(p.apyBase, 2),
      stablecoin: p.stablecoin,
      ilRisk: p.ilRisk,
      pool: p.pool,
      underlying: Array.isArray(p.underlyingTokens) ? p.underlyingTokens.slice(0, 4) : [],
    }));
}

function lorenzoCandidate(state, live, protocolsBySlug) {
  const current = state.conditions?.["lorenzo-susd1plus-premium"]?.lastResult || {};
  const bsc = Array.isArray(live?.result) ? live.result.find((r) => r.chainId === 56) : null;
  const summary = live?.summary || {};
  const threshold = asNumber(current.thresholdBps) || 75;
  const bestNavDiffBps = asNumber(current.bestNavDiffBps) ?? Math.max(...(bsc?.dexPools || []).map((p) => asNumber(p.navDiffBps) ?? -Infinity), -Infinity);
  const bestStableLiquidity = asNumber(current.bestStableLiquidity) ?? Math.max(...(bsc?.dexPools || []).map((p) => asNumber(p.balances?.[1]?.formatted) ?? 0), 0);
  const bestInverseGrossEdgeBps = asNumber(summary.bestInverseGrossEdgeBps) || 0;
  const sameEpochPublicExitProven = Boolean(summary.sameEpochPublicExitProven);
  const spreadProgress = clamp(bestNavDiffBps / threshold, 0, 1);
  const liquidityOk = bestStableLiquidity >= (asNumber(current.minStableLiquidity) || 5_000);
  const growth = publicGrowthScore(protocolsBySlug, "lorenzo-susd1+");
  const inverseProgress = clamp(bestInverseGrossEdgeBps / 100, 0, 1);
  const score = 50 + spreadProgress * 24 + inverseProgress * 8 + (liquidityOk ? 8 : 0) + growth;
  const inverseExitBlocked = bestInverseGrossEdgeBps > 0 && !sameEpochPublicExitProven;
  return rankCandidate({
    id: "lorenzo-susd1plus-premium",
    evaluator: "LOR",
    surface: "BSC sUSD1+ DEX premium and inverse NAV-exit timing",
    status: bestNavDiffBps >= threshold && liquidityOk ? "fork-proof-candidate" : inverseExitBlocked ? "inverse-gross-positive-exit-blocked" : "dormant-spread-too-small",
    severity: "DORMANT",
    score,
    proximity: `${round(bestNavDiffBps, 2)} bps premium / ${threshold} bps; inverse ${round(bestInverseGrossEdgeBps, 2)} bps gross, exit ${sameEpochPublicExitProven ? "proven" : "blocked"}`,
    keyMetrics: {
      nav: round(current.nav, 8),
      bestQuote: round(current.bestQuote, 8),
      bestNavDiffBps: round(bestNavDiffBps, 2),
      thresholdBps: threshold,
      bestStableLiquidityUsd: round(bestStableLiquidity, 0),
      bestInverseGrossEdgeBps: round(bestInverseGrossEdgeBps, 2),
      bestInverseGrossEdgeUsd: round(summary.bestInverseGrossEdgeUsd, 6),
      exactInverseBuyQuotes: asNumber(summary.exactBuyQuotes) || 0,
      sameEpochPublicExitProven,
      publicGrowthScore: growth,
      transferable: current.transferable ?? bsc?.views?.transferable ?? null,
      paused: current.paused ?? bsc?.views?.paused ?? null,
    },
    blockers: bestNavDiffBps >= threshold ? [] : [summary.blocker, "DEX premium below execution-review threshold", "gas/slippage/fees consume current spread"].filter(Boolean),
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["BSC pool premium above NAV + fees/slippage/gas or exact inverse buy quote with positive net", "public same-epoch NAV exit proven for inverse route", "stable liquidity above threshold", "vault unpaused and transferable"],
      missingBeforeAutoExec: ["BSC executor", "current fork-positive supply-sell proof", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh NAV read", "fresh Pancake quote", "static call", "gas estimate", "minProfit/minOut gates"],
    }),
    nextReadOnlyStep: inverseExitBlocked ? "Prove or rule out a public same-epoch NAV exit path; keep routePositive=0 while withdrawal remains queued/cash-blocked." : "Keep BSC Pancake quotes and NAV update timing under fast watch; fork-proof only if spread exceeds threshold with stable liquidity.",
    sourceArtifacts: ["reports/raw/fast/lorenzo-susd1plus-live.json", "reports/monitor/state.json"],
  });
}

function hyperlendCandidate(state, live, protocolsBySlug) {
  const current = state.conditions?.hyperlend || {};
  const stale = live?.summary?.staleBorrowableCoreReserves || current.staleSourceWatchpoints || [];
  const maxAbsDiv = Math.max(0, ...stale.map((r) => Math.abs(asNumber(r.oracleVsRefPct ?? r.divergence) || 0)));
  const maxAge = Math.max(0, ...stale.map((r) => asNumber(r.ageSeconds ?? r.age) || 0));
  const routeCount = current.routeCandidates?.length || 0;
  const liquidity = current.reserveLiquidity || [];
  const borrowableCashUsd = liquidity.filter((r) => r.borrowing).reduce((sum, r) => sum + (asNumber(r.cashUsd) || 0), 0);
  const divergenceProgress = clamp(maxAbsDiv / 1, 0, 1);
  const score = 42 + divergenceProgress * 20 + clamp(maxAge / 14_400, 0, 1) * 8 + clamp(borrowableCashUsd / 25_000_000, 0, 1) * 8 + publicGrowthScore(protocolsBySlug, "hyperlend-pooled") - (routeCount ? 0 : 6);
  return rankCandidate({
    id: "hyperlend-stale-source-routes",
    evaluator: "E17",
    surface: "HyperLend stale-source borrow/liquidation route",
    status: routeCount > 0 ? "needs-fork-proof" : "dormant-no-route-candidates",
    severity: routeCount > 0 ? "HIGH" : "DORMANT",
    score,
    proximity: `${round(maxAbsDiv, 3)}% max divergence; ${routeCount} route candidates`,
    keyMetrics: {
      borrowableCount: current.borrowableCount ?? live?.summary?.borrowableCoreReserves ?? null,
      highLtvCount: current.highLtvCount ?? null,
      staleBorrowableCount: stale.length,
      maxAgeSeconds: round(maxAge, 0),
      maxAbsDivergencePct: round(maxAbsDiv, 4),
      routeCandidates: routeCount,
      borrowableCashUsd: round(borrowableCashUsd, 0),
      publicGrowthScore: publicGrowthScore(protocolsBySlug, "hyperlend-pooled"),
    },
    blockers: routeCount > 0 ? ["Needs fork proof and executor before any live action"] : ["No current route candidates", "Stale-source divergence below practical threshold"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["stale borrowable source divergence above threshold", "route liquidity above threshold", "borrow/collateral path unpaused"],
      missingBeforeAutoExec: ["HyperEVM executor", "route-specific fork proof", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh oracle/source reads", "fresh route quote", "static call", "gas estimate", "minProfit/minOut gates"],
    }),
    nextReadOnlyStep: "Re-score when any stale borrowable source crosses 1% divergence or routeCandidates becomes non-empty.",
    sourceArtifacts: ["reports/raw/fast/hyperlend-live.json", "reports/monitor/state.json"],
  });
}

function venusBaseCandidate(state, venusBaseWsteth = {}) {
  const artifact = venusBaseWsteth?.generatedAt ? venusBaseWsteth : null;
  const current = state.conditions?.["venus-base-wsteth"]?.lastStatus || {};
  const routes = current.borrowRoutes || [];
  const bestRoute = maxBy(routes, (r) => asNumber(r.cashUsd) || 0);
  const summary = artifact?.summary || {};
  const routeLiquidity = asNumber(summary.bestBorrowRouteLiquidityUsd) ?? asNumber(bestRoute?.cashUsd) ?? 0;
  const minRouteLiquidity = asNumber(artifact?.thresholds?.minRouteLiquidityUsd) ?? asNumber(current.minRouteLiquidityUsd) ?? 10_000;
  const divergence = Math.abs(asNumber(summary.divergencePct) ?? asNumber(current.divergence) ?? 0);
  const feedAge = asNumber(summary.feedAgeSeconds) ?? asNumber(current.feedAge) ?? 0;
  const maxStale = asNumber(summary.maxStaleSeconds) ?? asNumber(current.maxStale) ?? 93_600;
  const staleEnough = artifact ? feedAge >= (asNumber(artifact.thresholds?.minFeedAgeSeconds) || 1800) : Boolean(current.staleEnough);
  const routeProgress = clamp(routeLiquidity / minRouteLiquidity, 0, 1);
  const staleProgress = staleEnough ? 1 : clamp(feedAge / maxStale, 0, 1);
  const routePositive = asNumber(summary.routePositive) || 0;
  const score = 38 + staleProgress * 10 + routeProgress * 10 + clamp(divergence / 5, 0, 1) * 25 + (routePositive > 0 ? 20 : 0);
  const blockers = [...(artifact?.assessment?.blockers || [])];
  if (divergence < 5) blockers.push("wstETH ratio divergence below route threshold");
  if (routeLiquidity < minRouteLiquidity) blockers.push("borrow-side route liquidity below monitor gate");
  if (artifact?.markets?.wstETH?.borrowPaused ?? current.borrowPaused) blockers.push("wstETH borrow direction paused/capped");
  return rankCandidate({
    id: "venus-base-wsteth",
    evaluator: "VB",
    surface: "Venus Base single-source wstETH stale-oracle route",
    status: summary.classification || current.classification || "unknown",
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score,
    proximity: `${round(divergence, 3)}% divergence; best route $${round(routeLiquidity, 0)} / $${minRouteLiquidity}`,
    keyMetrics: {
      feedAgeSeconds: round(feedAge, 0),
      maxStaleSeconds: maxStale,
      divergencePct: round(summary.divergencePct ?? current.divergence, 4),
      acceptedByVenus: artifact?.oracle?.acceptedByVenus ?? current.acceptedByVenus ?? null,
      collateralFactor: summary.collateralFactor ?? current.collateralFactor ?? null,
      bestBorrowRoute: summary.bestBorrowRoute || bestRoute?.symbol || null,
      bestBorrowRouteCashUsd: round(routeLiquidity, 0),
      wstethBorrowLiquidityUsd: round(summary.wstethBorrowLiquidityUsd, 0),
      researchPositiveRows: summary.researchPositiveRows ?? null,
      routePositive,
    },
    blockers: [...new Set(blockers)],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["wstETH ratio divergence above threshold", "borrow-side route liquidity above threshold", "relevant borrow path unpaused/capped"],
      missingBeforeAutoExec: ["route-specific fork profit proof", "Base executor/handler if execution route is added", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh feed/reference reads", "fresh borrow liquidity", "fresh DEX quote", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: routePositive > 0 ? "Fork-proof the exact Venus Base route before any executor or signed action." : "Watch for nonzero divergence plus borrow-side liquidity; fork-proof before any live action.",
    sourceArtifacts: ["reports/raw/fast/venus-base-wsteth-routes.json", "reports/monitor/state.json", "reports/venus-base-triage.md"],
  });
}

function e12xCandidate(routes, protocolsBySlug) {
  const chains = routes?.chains || [];
  const summary = routes?.summary || {};
  const totalCandidates = asNumber(summary.candidateCount) ?? chains.reduce((sum, c) => sum + (asNumber(c.candidateCount) || 0), 0);
  const positiveCount = asNumber(summary.positiveCount) ?? chains.reduce((sum, c) => sum + (asNumber(c.positiveCount) || 0), 0);
  const allTop = chains.flatMap((c) => [
    ...(c.topPositiveDivergenceCandidates || []),
    ...(c.topNearPositiveCandidates || []),
    ...(c.topCandidates || []),
  ].map((r) => ({ ...r, chain: r.chain || c.name })));
  const best = maxBy(allTop.filter((r) => (asNumber(r.divergencePct) || 0) > 0), (r) => {
    const div = asNumber(r.divergencePct) || 0;
    const liquidity = asNumber(r.morphoLiquidityUsd) || 0;
    const net = asNumber(r.netProfitUsd) || -10_000;
    return div * 10 + Math.log10(Math.max(1, liquidity)) + Math.max(-10, net / 100);
  });
  const bestDiv = asNumber(summary.maxPositiveDivergencePct) ?? (asNumber(best?.divergencePct) || 0);
  const maxAbsDiv = asNumber(summary.maxAbsDivergencePct) || 0;
  const maxNegativeDiv = asNumber(summary.maxNegativeDivergencePct) || 0;
  const bestLiquidity = asNumber(best?.morphoLiquidityUsd) || 0;
  const routeDiagnostics = summary.routeDiagnostics || {};
  const score = 35 + (positiveCount > 0 ? 35 : 0) + clamp(bestDiv / 5, 0, 1) * 15 + clamp(bestLiquidity / 1_000_000, 0, 1) * 6 + publicGrowthScore(protocolsBySlug, "morpho-blue");
  return rankCandidate({
    id: "e12x-morpho-new-market",
    evaluator: "E12x",
    surface: "Morpho new-market stale-oracle route dry runs",
    status: positiveCount > 0 ? "route-positive-needs-preflight" : "dormant-no-route-positive",
    severity: positiveCount > 0 ? "CRITICAL" : "DORMANT",
    score,
    proximity: `${positiveCount}/${totalCandidates} route-positive; best positive divergence ${round(bestDiv, 3)}%`,
    keyMetrics: {
      candidateCount: totalCandidates,
      positiveCount,
      chains: chains.map((c) => ({ name: c.name, candidateCount: c.candidateCount, positiveCount: c.positiveCount })),
      bestChain: best?.chain || null,
      bestMarketId: best?.marketId || null,
      bestPositiveDivergencePct: round(bestDiv, 4),
      maxAbsDivergencePct: round(maxAbsDiv, 4),
      maxNegativeDivergencePct: round(maxNegativeDiv, 4),
      bestLiquidityUsd: round(bestLiquidity, 0),
      bestNetProfitUsd: round(best?.netProfitUsd, 2),
      routeDiagnostics: {
        positiveDivergenceRows: routeDiagnostics.positiveDivergenceRows || 0,
        positiveDivergenceWithLiquidityRows: routeDiagnostics.positiveDivergenceWithLiquidityRows || 0,
        positiveDivergenceWithQuoteRows: routeDiagnostics.positiveDivergenceWithQuoteRows || 0,
        quotedRows: routeDiagnostics.quotedRows || 0,
        missingQuoteRows: routeDiagnostics.missingQuoteRows || 0,
        missingQuoteWithPositiveDivergenceRows: routeDiagnostics.missingQuoteWithPositiveDivergenceRows || 0,
        swapOutputCoversRepaymentRows: routeDiagnostics.swapOutputCoversRepaymentRows || 0,
        netProfitPositiveRows: routeDiagnostics.netProfitPositiveRows || 0,
        bestPositiveDivergenceWithLiquidityCandidate: routeDiagnostics.bestPositiveDivergenceWithLiquidityCandidate || null,
        bestPositiveDivergenceWithQuoteCandidate: routeDiagnostics.bestPositiveDivergenceWithQuoteCandidate || null,
        bestQuotedNetCandidate: routeDiagnostics.bestQuotedNetCandidate || null,
      },
      maxDivergenceCandidate: summary.maxDivergenceCandidate || null,
      nearestPositiveCandidate: summary.nearestPositiveCandidate || null,
    },
    blockers: positiveCount > 0 ? ["Requires fresh route rebuild, staticCall, estimateGas, and artifact gates"] : ["No route-positive dry runs", "Max absolute divergence is under-valued collateral, not an overborrow route", "Current positive accepted-vs-live pricing is flat or swap output below repayment"],
    readiness: readiness(positiveCount > 0 ? "armed-ethereum-only" : "watch-only", positiveCount > 0, {
      requiredTrigger: ["chainId=1", "severity=CRITICAL", "autoExecutable=true", "executorVersion=GenericMorphoExploit:min-output-v3", "routeGuard=passed"],
      missingBeforeAutoExec: positiveCount > 0 ? [] : ["current route-positive trigger"],
      livePreflight: ["fresh route rebuild", "execute.staticCall()", "estimateGas()", "minCollateralOut/minProfit gates", "bytecode artifact verification"],
    }),
    nextReadOnlyStep: "Keep Ethereum/Base/Arbitrum dry runs active; do not enable non-Ethereum execution without deploy + bytecode verifier + chain-specific gate.",
    sourceArtifacts: ["reports/raw/fast/e12x-cross-chain-map.json", "reports/raw/fast/e12x-route-dry-runs.json", "reports/e12x-cross-chain-expansion.md"],
  });
}

function e2QuoteVaultCandidate(e2) {
  const count = asNumber(e2?.candidateCount) || 0;
  return rankCandidate({
    id: "e2-quotevault-scan",
    evaluator: "E2",
    surface: "Morpho quoteVault oracle borrower scan",
    status: count > 0 ? "candidates-present-needs-ranking" : "dormant-zero-candidates",
    severity: count > 0 ? "HIGH" : "DORMANT",
    score: count > 0 ? 58 : 24,
    proximity: `${count} candidate(s)`,
    keyMetrics: { candidateCount: count },
    blockers: count > 0 ? ["Needs borrower/route/fork ranking"] : ["No live targets with borrowers in current artifact"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["quoteVault candidate with borrowers", "routeable oracle/share-price impact", "positive fork proof"],
      missingBeforeAutoExec: ["route-specific executor", "fork proof", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh borrower state", "fresh oracle/vault state", "route quote", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: "Re-run quoteVault scanner after Morpho market growth or new borrower activity.",
    sourceArtifacts: ["reports/raw/fast/e2-quotevault-candidates.json"],
  });
}

function staleOracleCandidates(stale) {
  const candidates = stale?.candidates || [];
  const routeRows = candidates.filter((c) => ["E1", "E8", "manual"].includes(c.route));
  const actionable = routeRows.filter((c) => c.status === "actionable-for-fork-proof");
  const best = maxBy(routeRows, (c) => {
    const div = Math.abs(asNumber(c.divergencePct) || 0);
    const threshold = asNumber(c.minDivergencePct) || 1;
    return (div / threshold) * 100 + (c.status === "stale-but-flat" ? 10 : 0);
  });
  const existingAutoRouteReady = actionable.some((c) => ["E1", "E8"].includes(c.route));
  const div = Math.abs(asNumber(best?.divergencePct) || 0);
  const threshold = asNumber(best?.minDivergencePct) || 5;
  const score = 30 + (actionable.length ? 30 : 0) + clamp(div / threshold, 0, 1) * 20;
  return rankCandidate({
    id: "stale-oracle-liquidity",
    evaluator: "E1/E8/manual",
    surface: "Stale oracle route liquidity candidates",
    status: actionable.length ? "actionable-for-fork-proof" : "dormant-stale-but-flat",
    severity: actionable.length ? "CRITICAL" : "DORMANT",
    score,
    proximity: `${actionable.length} actionable; best ${best?.id || "none"} at ${round(div, 3)}% / ${threshold}%`,
    keyMetrics: {
      actionableCount: stale?.actionableCount ?? actionable.length,
      staleButFlatCount: stale?.staleButFlatCount ?? routeRows.filter((c) => c.status === "stale-but-flat").length,
      bestCandidate: best?.id || null,
      bestRoute: best?.route || null,
      bestDivergencePct: round(div, 4),
      bestThresholdPct: threshold,
    },
    blockers: actionable.length ? ["Needs fork proof before live action"] : ["Feeds can be stale, but divergence remains below route thresholds"],
    readiness: readiness(actionable.length ? "route-specific-review" : "armed-for-existing-e1-e8-triggers", existingAutoRouteReady, {
      requiredTrigger: ["route-specific alert, not generic staleness", "live divergence above configured threshold", "net profit above minProfit"],
      missingBeforeAutoExec: actionable.length ? ["fresh fork/static-call confirmation for manual routes"] : ["current route-positive trigger"],
      livePreflight: ["fresh route rebuild", "static call", "gas estimate", "minProfit/minOut gates", "artifact verification"],
    }),
    nextReadOnlyStep: "Refresh scanner during stale windows; only fork-proof if divergence crosses route threshold with liquidity.",
    sourceArtifacts: ["reports/raw/fast/stale-oracle-liquidity-candidates.json"],
  });
}

function liquidationCandidate(state, alerts) {
  const result = state.conditions?.["liquidation-hunter"]?.lastResult || latestByCondition(alerts, "liquidation-hunter") || {};
  const count = asNumber(result.count) || 0;
  const profitableCount = asNumber(result.profitableCount) || 0;
  const net = asNumber(result.topNetProfit) || 0;
  const hf = asNumber(result.topHF);
  const score = 30 + clamp(count / 10, 0, 1) * 10 + (profitableCount > 0 ? 35 : 0) + clamp(Math.max(0, net) / 500, 0, 1) * 15;
  return rankCandidate({
    id: "liquidation-hunter",
    evaluator: "E9",
    surface: "Live liquidation route hunter",
    status: profitableCount > 0 ? "profitable-needs-preflight" : "dormant-route-negative",
    severity: profitableCount > 0 ? "CRITICAL" : "DORMANT",
    score,
    proximity: `${count} liquidatable; top net $${round(net, 0)}`,
    keyMetrics: {
      liquidatableCount: count,
      profitableCount,
      topMarket: result.topMarket || null,
      topHealthFactor: hf,
      topBorrow: result.topBorrow || null,
      topNetProfitUsd: round(net, 2),
    },
    blockers: profitableCount > 0 ? ["Requires current route-specific preflight"] : ["Live route/gas quote is net negative"],
    readiness: readiness(profitableCount > 0 ? "armed" : "watch-only", profitableCount > 0, {
      requiredTrigger: ["severity=HIGH", "autoExecutable=true", "profitableCount>0", "profitablePositions[0].executable=true", "pricingTrusted=true", "netProfit>=minProfit"],
      missingBeforeAutoExec: profitableCount > 0 ? [] : ["current profitable route-positive liquidation"],
      livePreflight: ["fresh liquidation candidate rebuild", "live loan-token price validation", "collateral exit quote", "execute.staticCall()", "estimateGas()", "gas model cap"],
    }),
    nextReadOnlyStep: "Keep route quotes fresh; fork/sim only when topNetProfit turns positive after gas/slippage.",
    sourceArtifacts: ["reports/monitor/state.json", "reports/monitor/alerts.jsonl"],
  });
}

function vaultDonationCandidate(state, alerts, joiner = {}, v4Overlaps = {}, e15Routes = {}) {
  const recent = alerts.filter((a) => a.condition === "vault-new-deploy" || a.condition === "vault-donation");
  const byVault = new Map();
  for (const alert of recent) {
    const key = `${alert.chainId || "?"}:${(alert.vault || "").toLowerCase()}`;
    if (!alert.vault) continue;
    const prev = byVault.get(key);
    if (!prev || new Date(alert.timestamp) > new Date(prev.timestamp)) byVault.set(key, alert);
  }
  const rows = [...byVault.values()];
  const highRows = rows.filter((a) => ["CRITICAL", "HIGH"].includes(a.severity));
  const minAssets = Math.min(...highRows.map((a) => asNumber(a.totalAssets)).filter((n) => Number.isFinite(n)), Infinity);
  const known = state.conditions?.["vault-new-deploy"]?.knownVaults?.length || 0;
  const joinerSummary = joiner.summary || {};
  const joinerResults = Array.isArray(joiner.results) ? joiner.results : [];
  const joinedConsumers = joinerResults.reduce((sum, r) => sum
    + asNumber(r.morphoCollateralMatches || 0)
    + asNumber(r.morphoLoanMatches || 0)
    + asNumber(r.morphoOracleBytecodeMatches || 0)
    + asNumber(r.compoundMatches || 0)
    + asNumber(r.compoundPriceFeedBytecodeMatches || 0)
    + asNumber(r.venusMatches || 0)
    + asNumber(r.aaveReserveMatches || 0)
    + asNumber(r.aavePriceSourceBytecodeMatches || 0)
    + asNumber(r.eulerCollateralMatches || 0)
    + asNumber(r.eulerBorrowAssetMatches || 0)
    + asNumber(r.eulerOracleBytecodeMatches || 0)
    + asNumber(r.siloCollateralMatches || 0)
    + asNumber(r.siloOracleBytecodeMatches || 0), 0);
  const expandedGraphScanned = joinerResults.some((r) =>
    asNumber(r.aaveReservesScanned || 0) > 0
    || asNumber(r.eulerVaultsScanned || 0) > 0
    || asNumber(r.siloIdsScanned || 0) > 0);
  const liveLowTvl = joinerResults.reduce((sum, r) => sum + asNumber(r.vaultsLiveLowTvl || 0), 0);
  const watchCandidates = asNumber(joinerSummary.watchCandidates) || 0;
  const routePositive = asNumber(joinerSummary.routePositive) || 0;
  const e15Summary = e15Routes.summary || {};
  const e15Rows = asNumber(e15Summary.rows) || 0;
  const e15MorphoConsumers = asNumber(e15Summary.rowsWithMorphoMarketConsumer) || 0;
  const e15DexPools = asNumber(e15Summary.rowsWithDexSharePool) || 0;
  const e15RoutePositive = asNumber(e15Summary.routePositive) || 0;
  const focusedNoRoute = e15Rows > 0 && e15RoutePositive === 0 && e15MorphoConsumers === 0 && e15DexPools === 0;
  const v4Summary = v4Overlaps.summary || {};
  const v4PoolVaultRows = asNumber(v4Summary.rowsWherePoolTradesVault) || 0;
  const v4ActualHookRows = asNumber(v4Summary.rowsWhereVaultIsActualHook) || 0;
  const v4RecentSwapRows = asNumber(v4Summary.rowsWithRecentSwaps) || 0;
  const v4MisclassifiedRows = asNumber(v4Summary.rowsLikelyCurrencyMisclassifiedAsHook) || 0;
  const totalRoutePositive = routePositive + e15RoutePositive;
  const status = totalRoutePositive > 0
    ? "needs-fork-proof"
    : focusedNoRoute
      ? "dormant-focused-no-route"
    : watchCandidates > 0
      ? "linked-consumer-needs-fork-proof"
      : joinedConsumers > 0
        ? "linked-but-not-low-tvl-or-liquid"
        : highRows.length
          ? "dormant-low-tvl-no-borrow-route"
          : "quiet";
  const score = 26
    + clamp(highRows.length / 50, 0, 1) * 6
    + clamp(joinedConsumers / 10, 0, 1) * 6
    + clamp(watchCandidates / 3, 0, 1) * 18
    + (totalRoutePositive > 0 ? 25 : 0)
    + (minAssets <= 1 ? 4 : 0);
  return rankCandidate({
    id: "vault-donation-low-tvl",
    evaluator: "E15",
    surface: "Low/zero-TVL ERC4626 vault donation-inflation watch",
    status,
    severity: totalRoutePositive > 0 ? "HIGH" : "DORMANT",
    score,
    proximity: focusedNoRoute
      ? `${e15Rows} current alert(s); focused triage found no Morpho consumers or V3 share pools; route-positive 0`
      : joiner.generatedAt
      ? `${liveLowTvl} live low-TVL vaults; ${joinedConsumers} joined consumers; V4 pools ${v4PoolVaultRows}/${v4ActualHookRows} actual hooks; ${watchCandidates} watch; ${routePositive} route-positive`
      : `${highRows.length} high/critical low-TVL vault alert(s); no linked borrower route`,
    keyMetrics: {
      knownVaults: known,
      recentHighOrCriticalAlerts: highRows.length,
      liveLowTvlVaults: liveLowTvl,
      joinedConsumers,
      watchCandidates,
      routePositive: totalRoutePositive,
      e15Rows,
      e15MorphoConsumers,
      e15DexPools,
      v4PoolVaultRows,
      v4ActualHookRows,
      v4RecentSwapRows,
      v4MisclassifiedRows,
      expandedGraphScanned,
      minTotalAssets: Number.isFinite(minAssets) ? minAssets : null,
      newestVaultAlert: highRows.slice(-1)[0]?.timestamp || null,
      highestAlertSeverity: highRows.some((a) => a.severity === "CRITICAL") ? "CRITICAL" : highRows.some((a) => a.severity === "HIGH") ? "HIGH" : null,
    },
    blockers: totalRoutePositive > 0
      ? ["Needs route-specific fork proof and executor before any live action"]
      : focusedNoRoute
        ? ["Focused E15 triage found no Morpho market consumer", "Focused E15 triage found no Uniswap V3 share-liquidity pool", "Current alerted vaults return maxDeposit=0"]
      : watchCandidates > 0
        ? ["Linked consumer exists, but needs fork proof and route economics"]
        : joinedConsumers > 0
          ? ["Linked consumers are not currently low-TVL + liquid", "No route-positive fork target"]
          : ["No current borrower/oracle route tied to low-TVL vault", "Needs market integration before financial impact", "V4 overlap scan found vault-share pools, not actual hook-controlled route-positive impact"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["low-TVL vault becomes collateral/oracle input for a borrow market", "borrower/liquidity path exists", "positive fork proof"],
      missingBeforeAutoExec: ["linked market route", "executor", "fork proof", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh vault totalAssets", "fresh market borrower state", "route quote", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: watchCandidates > 0
      ? "Fork-proof only the linked low-TVL consumer with live liquidity."
      : expandedGraphScanned
        ? "Keep the expanded consumer graph on watch; reopen only if watchCandidates or routePositive turns nonzero."
        : "Extend the joiner beyond Morpho into Compound/Venus/Aave/Silo oracle-consumer graphs.",
    sourceArtifacts: ["reports/monitor/state.json", "reports/monitor/alerts.jsonl", "reports/raw/fast/erc4626-consumer-joiner.json", "reports/raw/fast/erc4626-v4-hook-overlaps.json", "reports/raw/fast/e15-vault-donation-routes.json", "reports/e15-vault-donation-routes-triage.md"],
  });
}

function consumerFirstHighLtvCandidate(consumer = {}, focused = {}) {
  const summary = consumer?.summary || {};
  const focusedSummary = focused?.summary || {};
  const rowsScanned = asNumber(summary.rowsScanned) || 0;
  const highLtvRows = asNumber(summary.highLtvRows) || 0;
  const reviewCandidates = asNumber(summary.reviewCandidates) || 0;
  const watchCandidates = (asNumber(summary.watchCandidates) || 0) + (asNumber(focusedSummary.watchCandidates) || 0);
  const routePositive = (asNumber(summary.routePositive) || 0) + (asNumber(focusedSummary.routePositive) || 0);
  const focusedRows = asNumber(focusedSummary.rowsInput) || 0;
  const focusedDirectQuotes = asNumber(focusedSummary.rowsWithDirectDexQuote) || 0;
  const focusedExactAcquisitions = asNumber(focusedSummary.rowsWithExactAcquisitionRoute) || focusedDirectQuotes;
  const focusedMintAcquisitions = asNumber(focusedSummary.rowsWithErc4626MintAcquisition) || 0;
  const focusedClosestGap = asNumber(focusedSummary.closestExactAcquisitionPremiumGapBps ?? focusedSummary.closestExactQuotePremiumGapBps);
  const focusedReference = asNumber(focusedSummary.rowsWithReferencePrice) || 0;
  const highLtvTopRows = (Array.isArray(consumer?.results) ? consumer.results : [])
    .flatMap((r) => (r.topRows || []).map((row) => ({ ...row, chain: row.chain || r.chain })))
    .sort((a, b) => Number(b.reviewCandidate) - Number(a.reviewCandidate) || Number(b.routeLiquidityUsd || 0) - Number(a.routeLiquidityUsd || 0))
    .slice(0, 5)
    .map((row) => ({
      protocol: row.protocol,
      chain: row.chain,
      collateral: row.collateral?.symbol || null,
      borrowAsset: row.borrowAsset?.symbol || null,
      ltv: round(row.ltv, 4),
      routeLiquidityUsd: round(row.routeLiquidityUsd, 0),
      riskTags: row.riskTags || [],
    }));
  const focusedTopRows = (Array.isArray(focused?.rows) ? focused.rows : [])
    .slice(0, 5)
    .map((row) => ({
      collateral: row.collateral?.symbol || null,
      loanAsset: row.loanAsset?.symbol || null,
      lltv: round(row.morpho?.lltv, 4),
      routeLiquidityUsd: round(row.morpho?.routeLiquidityUsd, 0),
      acceptedVsReferenceBps: round(row.economics?.acceptedVsReferenceBps, 2),
      premiumGapBps: round(row.economics?.quotePremiumGapBps ?? row.economics?.premiumGapBps, 2),
      producerType: row.producer?.primaryType || null,
      acquisitionMode: row.routeGate?.selectedAcquisitionMode || null,
      gateStatus: row.routeGate?.status || null,
      netEdgeUsd: round(row.economics?.netEdgeUsd, 0),
      routePositive: Boolean(row.routePositive),
    }));
  const score = 27
    + clamp(reviewCandidates / 175, 0, 1) * 8
    + clamp(highLtvRows / 300, 0, 1) * 5
    + clamp(focusedReference / Math.max(1, focusedRows), 0, 1) * 4
    + clamp(focusedExactAcquisitions / 5, 0, 1) * 3
    + (routePositive > 0 ? 25 : 0);
  const status = routePositive > 0
    ? "needs-fork-proof"
    : focused.generatedAt
      ? "focused-probed-no-route-positive"
      : reviewCandidates > 0
        ? "review-inventory-needs-focused-probes"
        : "mapped-no-route-positive";
  const sourceArtifacts = ["reports/raw/fast/consumer-first-high-ltv-collateral.json", "reports/consumer-first-high-ltv-collateral-triage.md"];
  if (focused.generatedAt) sourceArtifacts.push("reports/raw/fast/focused-morpho-review-producers.json", "reports/focused-morpho-review-producers-triage.md");
  return rankCandidate({
    id: "consumer-first-high-ltv-collateral",
    evaluator: "research",
    surface: "New collateral consumer graph across high-LTV lending markets",
    status,
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score,
    proximity: focused.generatedAt
      ? `${reviewCandidates} review rows; focused ${focusedRows}; exact-acq ${focusedExactAcquisitions}; closest gap ${round(focusedClosestGap, 2)}bps; route-positive ${routePositive}`
      : `${reviewCandidates} review rows; ${highLtvRows} high-LTV rows; route-positive ${routePositive}`,
    keyMetrics: {
      chainsScanned: summary.chainsScanned || 0,
      chainsWithRpc: summary.chainsWithRpc ?? summary.chainsScanned ?? 0,
      chainsMissingRpc: summary.chainsMissingRpc || [],
      knownLocalTokenAddresses: summary.knownLocalTokenAddresses || 0,
      rowsScanned,
      highLtvRows,
      reviewCandidates,
      watchCandidates,
      routePositive,
      focusedGeneratedAt: focused.generatedAt || null,
      focusedRows,
      focusedReference,
      focusedDirectQuotes,
      focusedExactAcquisitions,
      focusedMintAcquisitions,
      focusedClosestExactAcquisitionPremiumGapBps: round(focusedClosestGap, 4),
      focusedProducerPrimaryTypes: focusedSummary.byProducerPrimaryType || null,
      focusedRouteGateStatuses: focusedSummary.byRouteGateStatus || null,
      focusedRoutePositive: asNumber(focusedSummary.routePositive) || 0,
      breakdown: summary.breakdown || null,
      topRows: highLtvTopRows,
      focusedTopRows,
    },
    blockers: routePositive > 0
      ? ["Needs route-specific fork proof and executor before any live action"]
      : focused.generatedAt
        ? ["Focused Morpho producer rows are exact-acquisition negative", "No current LLTV-adjusted executable acquisition route", "No fork-positive route"]
        : ["High-LTV review inventory lacks focused producer/NAV/DEX economics", "No route-positive fork target"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["high-LTV consumer row joins to producer anomaly", "borrow-side liquidity and acquisition/exit route are live", "positive read-only economics and fork proof"],
      missingBeforeAutoExec: ["route-specific fork proof", "executor", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh consumer graph", "fresh producer/NAV/oracle reads", "fresh DEX quote", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: routePositive > 0
      ? "Fork-proof the exact joined collateral route before any live action."
      : focused.generatedAt
        ? "Refresh focused probes or add route-specific producer scanners only when new high-LTV rows or premiums appear."
        : "Run focused producer/NAV/DEX probes on top noncanonical high-LTV rows.",
    sourceArtifacts,
  });
}

function morphoPublicAllocatorForceFeedCandidate(artifact = {}) {
  const summary = artifact?.summary || {};
  const marketsInput = asNumber(summary.marketsInput) || 0;
  const vaultsScanned = asNumber(summary.vaultsScanned) || 0;
  const vaultsWithPublicAllocator = asNumber(summary.vaultsWithPublicAllocator) || 0;
  const marketsWithPositiveMaxIn = asNumber(summary.marketsWithPositiveMaxIn) || 0;
  const allocatorCapacityRows = asNumber(summary.allocatorCapacityRows) || 0;
  const marketsWithExactAcquisition = asNumber(summary.marketsWithExactAcquisition) || 0;
  const marketsWithAllocatorExactOverlap = asNumber(summary.marketsWithAllocatorExactOverlap) || 0;
  const allocatorExactOverlapRows = asNumber(summary.allocatorExactOverlapRows) || 0;
  const maxForceFeedCapacityUsd = asNumber(summary.maxForceFeedCapacityUsd) || 0;
  const bestPostAllocatorNetUsd = asNumber(summary.bestPostAllocatorNetUsd);
  const closestAllocatorExactGapBps = asNumber(summary.closestAllocatorExactGapBps);
  const watchCandidates = asNumber(summary.watchCandidates) || 0;
  const preforkAllocatorPositive = asNumber(summary.preforkAllocatorPositive) || 0;
  const routePositive = asNumber(summary.routePositive) || 0;
  const topRows = (Array.isArray(artifact?.results) ? artifact.results : [])
    .slice(0, 5)
    .map((row) => ({
      collateral: row.collateral?.symbol || null,
      loanAsset: row.loanAsset?.symbol || null,
      lltv: round(row.morpho?.lltv, 4),
      currentLiquidityUsd: round(row.morpho?.routeLiquidityUsd, 0),
      targetFlowCaps: row.allocatorSummary?.targetFlowCaps || 0,
      targetPositiveMaxIn: row.allocatorSummary?.targetPositiveMaxIn || 0,
      maxForceFeedCapacityUsd: round(row.allocatorSummary?.maxForceFeedCapacityUsd, 0),
      exactAcquisitionRows: row.allocatorSummary?.exactAcquisitionRows || 0,
      allocatorExactOverlapRows: row.allocatorSummary?.allocatorExactOverlapRows || 0,
      bestPostAllocatorNetUsd: round(row.allocatorSummary?.bestPostAllocatorNetUsd, 2),
      closestAllocatorExactGapBps: round(row.allocatorSummary?.closestAllocatorExactGapBps, 2),
      preforkAllocatorPositive: Boolean(row.preforkAllocatorPositive),
    }));
  const status = routePositive > 0
    ? "needs-fork-proof"
    : preforkAllocatorPositive > 0
      ? "prefork-positive-needs-fork-proof"
      : allocatorCapacityRows > 0
        ? "allocator-capacity-route-negative"
        : "no-current-force-feed-capacity";
  return rankCandidate({
    id: "morpho-public-allocator-force-feed",
    evaluator: "research",
    surface: "Morpho public allocator force-feed liquidity on high-LLTV markets",
    status,
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score: 27 + clamp(allocatorCapacityRows / 12, 0, 1) * 8 + clamp(maxForceFeedCapacityUsd / 10_000_000, 0, 1) * 8 + clamp(marketsWithPositiveMaxIn / 15, 0, 1) * 4 + clamp(marketsWithAllocatorExactOverlap / 3, 0, 1) * 5 + (routePositive > 0 ? 25 : 0),
    proximity: `${marketsInput} markets; ${allocatorCapacityRows} capacity rows; exact ${marketsWithExactAcquisition}; allocator/exact overlap ${marketsWithAllocatorExactOverlap}; best post-net $${round(bestPostAllocatorNetUsd, 0)}; route-positive ${routePositive}`,
    keyMetrics: {
      marketsInput,
      loanAssetsQueried: summary.loanAssetsQueried || 0,
      vaultsScanned,
      vaultsWithPublicAllocator,
      marketsWithTargetFlowCaps: summary.marketsWithTargetFlowCaps || 0,
      marketsWithPositiveMaxIn,
      marketsWithAllocatorCapacity: summary.marketsWithAllocatorCapacity || 0,
      marketsWithExactAcquisition,
      marketsWithAllocatorExactOverlap,
      allocatorCapacityRows,
      allocatorExactOverlapRows,
      maxForceFeedCapacityUsd: round(maxForceFeedCapacityUsd, 2),
      totalForceFeedCapacityUsd: round(summary.totalForceFeedCapacityUsd, 2),
      bestPostAllocatorNetUsd: round(bestPostAllocatorNetUsd, 2),
      closestAllocatorExactGapBps: round(closestAllocatorExactGapBps, 4),
      watchCandidates,
      preforkAllocatorPositive,
      routePositive,
      topRows,
      signedActionJustified: false,
    },
    blockers: routePositive > 0
      ? ["Needs route-specific fork proof and executor before any live action"]
      : marketsWithAllocatorExactOverlap > 0
        ? ["Allocator/exact overlaps remain LLTV-adjusted net-negative", "No fork-positive allocator route"]
        : ["Allocator force-feed capacity does not overlap exact acquisition rows", "Exact-acquisition rows have zero or missing target maxIn capacity", "No fork-positive allocator route"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["nonzero target maxIn and reachable source maxOut liquidity", "exact acquisition quote positive after LLTV haircut", "fork proof including allocator reallocation step"],
      missingBeforeAutoExec: ["route-specific fork proof", "executor", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh public allocator flow caps", "fresh vault allocation/liquidity state", "fresh exact DEX quote", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: routePositive > 0
      ? "Fork-proof the exact allocator reallocation plus borrow/extraction route."
      : "Reopen only when a target maxIn-capacity row also has exact positive acquisition economics; otherwise move to the next branch.",
    sourceArtifacts: ["reports/raw/fast/morpho-public-allocator-force-feed.json", "reports/morpho-public-allocator-force-feed-triage.md", "reports/raw/fast/focused-morpho-review-producers.json", "reports/raw/fast/morpho-exit-liquidity-stress.json"],
  });
}

function jupiterLendOracleDivergenceCandidate(artifact = {}) {
  const summary = artifact?.summary || {};
  const vaultsScanned = asNumber(summary.vaultsScanned) || 0;
  const oraclesScanned = asNumber(summary.oraclesScanned) || 0;
  const oracleRatesSimulated = asNumber(summary.oracleRatesSimulated) || 0;
  const divergentOracles = asNumber(summary.oracleOperateLiquidateDivergent) || 0;
  const debtVaultsWithDivergentOracle = asNumber(summary.debtVaultsWithDivergentOracle) || 0;
  const divergentDebtWatchRows = asNumber(summary.divergentDebtWatchRows) || 0;
  const liquidationFavorableDebtVaults = asNumber(summary.liquidationFavorableDebtVaults) || 0;
  const candidateRows = asNumber(summary.candidateRows) || 0;
  const routePositive = asNumber(summary.routePositive) || 0;
  const maxAbsBps = asNumber(summary.maxAbsLiquidateVsOperateBps) || 0;
  const maxLiquidatorBps = asNumber(summary.maxLiquidationFavorsLiquidatorBps) || 0;
  const maxAddedDebtTicks = asNumber(summary.maxAddedDebtTicksFromLiquidateRate) || 0;
  const maxAddedRiskyPositions = asNumber(summary.maxAddedRiskyPositionsFromLiquidateRate) || 0;
  const rows = Array.isArray(artifact?.vaultRows) ? artifact.vaultRows : [];
  const topRows = rows.slice(0, 5).map((row) => ({
    vaultId: row.vaultId,
    pair: row.pair || `${row.supplySymbol || "?"}/${row.borrowSymbol || "?"}`,
    totalBorrowUsd: round(row.totalBorrowUsd, 0),
    liquidateVsOperateBps: round(row.oracleDivergence?.liquidateVsOperateBps, 4),
    liquidateTickShift: row.liquidateTickShift,
    addedDebtTicks: row.addedDebtTicksFromLiquidateRate || 0,
    addedRiskyPositions: row.addedRiskyPositionsFromLiquidateRate || 0,
    candidate: Boolean(row.candidate),
  }));
  const status = routePositive > 0
    ? "needs-fork-proof"
    : candidateRows > 0
      ? "tick-flip-needs-exact-route"
      : liquidationFavorableDebtVaults > 0
        ? "divergent-no-liquidatable-tick"
        : "mapped-no-route-positive";
  return rankCandidate({
    id: "jupiter-lend-oracle-divergence",
    evaluator: "research",
    surface: "Jupiter Lend operate-vs-liquidate oracle divergence joined to debt ticks",
    status,
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score: 24
      + clamp(oracleRatesSimulated / Math.max(1, oraclesScanned), 0, 1) * 5
      + clamp(maxAbsBps / 25, 0, 1) * 7
      + clamp(debtVaultsWithDivergentOracle / 8, 0, 1) * 6
      + clamp(liquidationFavorableDebtVaults / 5, 0, 1) * 7
      + clamp(candidateRows / 2, 0, 1) * 12
      + (routePositive > 0 ? 25 : 0),
    proximity: `${vaultsScanned} vaults; ${divergentOracles} divergent oracles; liq-fav debt ${liquidationFavorableDebtVaults}; tick-flip candidates ${candidateRows}; route-positive ${routePositive}`,
    keyMetrics: {
      vaultsScanned,
      positionsScanned: summary.positionsScanned || 0,
      ticksScanned: summary.ticksScanned || 0,
      oraclesScanned,
      oracleRatesSimulated,
      divergentOracles,
      maxAbsLiquidateVsOperateBps: round(maxAbsBps, 4),
      maxLiquidationFavorsLiquidatorBps: round(maxLiquidatorBps, 4),
      debtVaultsWithDivergentOracle,
      divergentDebtWatchRows,
      liquidationFavorableDebtVaults,
      maxAddedDebtTicksFromLiquidateRate: maxAddedDebtTicks,
      maxAddedRiskyPositionsFromLiquidateRate: maxAddedRiskyPositions,
      candidateRows,
      routePositive,
      topRows,
      signedActionJustified: false,
    },
    blockers: routePositive > 0
      ? ["Needs route-specific fork proof and executor before any live action"]
      : candidateRows > 0
        ? ["No exact repay acquisition/collateral exit economics", "No local/fork proof", "No signed-action authorization"]
        : ["Liquidation-favorable oracle divergence does not add a debt-bearing tick or risky position", "No exact repay acquisition/collateral exit economics", "No local/fork proof"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["liquidation view newly makes a debt-bearing tick or position liquidatable", "repay acquisition and collateral exit are exact-quoted", "net route is positive after fees/slippage", "fork/local proof"],
      missingBeforeAutoExec: ["tick-flip candidate", "exact Solana route economics", "fork/local proof", "artifact execution gate"],
      livePreflight: ["fresh oracle simulation", "fresh vault/tick/position decode", "fresh repay and collateral-exit quotes", "local/fork proof"],
    }),
    nextReadOnlyStep: candidateRows > 0
      ? "Add exact repay acquisition and collateral-exit modeling for the tick-flip rows; fork/local proof only after routePositive > 0."
      : "Keep Jupiter Lend dormant; refresh only if operate/liquidate divergence increases enough to flip a debt-bearing tick.",
    sourceArtifacts: ["reports/raw/fast/jupiter-lend-oracle-divergence.json", "reports/jupiter-lend-oracle-divergence-triage.md"],
  });
}

function morphoHighApyLiquidationRoutesCandidate(artifact = {}) {
  const summary = artifact?.summary || {};
  const marketsScanned = asNumber(summary.marketsScanned) || 0;
  const positionsScored = asNumber(summary.positionsScored) || 0;
  const currentLiquidatable = asNumber(summary.currentLiquidatable) || 0;
  const rowsWithAnyQuote = asNumber(summary.rowsWithAnyQuote) || 0;
  const researchPositiveRoutes = asNumber(summary.researchPositiveRoutes) || 0;
  const routePositive = asNumber(summary.routePositive) || 0;
  const maxBorrowApy = asNumber(summary.maxBorrowApy) || 0;
  const bestRow = maxBy(artifact?.results || [], (row) => row.best?.best?.netProfitUsd ?? row.best?.netProfitUsd ?? -Infinity);
  const bestNet = asNumber(bestRow?.best?.best?.netProfitUsd ?? bestRow?.best?.netProfitUsd);
  const topRows = (Array.isArray(artifact?.results) ? artifact.results : []).slice(0, 5).map((row) => ({
    pair: row.pair || null,
    healthFactor: round(row.healthFactor, 4),
    borrowUsd: round(row.graph?.borrowAssetsUsd, 0),
    borrowApy: round(row.market?.borrowApy, 2),
    bestNetProfitUsd: round(row.best?.best?.netProfitUsd ?? row.best?.netProfitUsd, 2),
    routePositive: Boolean(row.routePositive),
  }));
  return rankCandidate({
    id: "morpho-high-apy-liquidation-routes",
    evaluator: "research",
    surface: "Morpho high-APY/high-utilization borrower liquidation routes",
    status: routePositive > 0 ? "needs-fork-proof" : rowsWithAnyQuote > 0 ? "quoted-route-negative" : "no-exit-quotes",
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score: 31 + clamp(currentLiquidatable / 10, 0, 1) * 8 + clamp(rowsWithAnyQuote / 5, 0, 1) * 5 + clamp(maxBorrowApy / 1000, 0, 1) * 4 + (routePositive > 0 ? 25 : 0),
    proximity: `${marketsScanned} markets; ${currentLiquidatable} liquidatable; quotes ${rowsWithAnyQuote}; best net $${round(bestNet, 2)}; route-positive ${routePositive}`,
    keyMetrics: {
      marketsScanned,
      highApyMarkets: summary.highApyMarkets || 0,
      highUtilizationMarkets: summary.highUtilizationMarkets || 0,
      maxBorrowApy: round(maxBorrowApy, 2),
      maxUtilization: summary.maxUtilization || 0,
      positionsDiscovered: summary.positionsDiscovered || 0,
      positionsScored,
      currentLiquidatable,
      nearLiquidatable: summary.nearLiquidatable || 0,
      rowsWithAnyQuote,
      rowsWithCurveQuote: summary.rowsWithCurveQuote || 0,
      watchCandidates: summary.watchCandidates || 0,
      researchPositiveRoutes,
      routePositive,
      bestNetProfitUsd: round(bestNet, 2),
      topRows,
      signedActionJustified: false,
    },
    blockers: routePositive > 0
      ? ["Needs route-specific fork proof and executor before any live action"]
      : ["Exact collateral-exit quotes are net negative", "Several high-APY markets are 100% utilized but bad-debt/dust liquidation rows do not pay", "No fork-positive liquidation route"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["currently liquidatable borrower", "exact exit quote covers repay plus gas/slippage", "trusted loan-token price and fork proof"],
      missingBeforeAutoExec: ["route-specific fork proof", "executor", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh high-APY market/borrower scan", "fresh on-chain Morpho market/position reads", "fresh exact collateral-exit quote", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: routePositive > 0
      ? "Fork-proof the exact liquidation route before any live action."
      : "Keep as a fast refresh branch; fork only if an exact quoted borrower flips net positive after gas/slippage.",
    sourceArtifacts: ["reports/raw/fast/morpho-high-apy-liquidation-routes.json", "reports/morpho-high-apy-liquidation-routes-triage.md"],
  });
}

function aaveV4HubsCandidate(aave, protocolsBySlug, borrowers = {}) {
  const summary = aave?.summary || {};
  const borrowerSummary = borrowers?.summary || {};
  const routePositive = (asNumber(summary.routePositive) || 0) + (asNumber(borrowerSummary.routePositive) || 0);
  const watchCandidates = asNumber(summary.watchCandidates) || 0;
  const totalCashUsd = asNumber(summary.totalCashUsd) || 0;
  const totalOwedUsd = asNumber(summary.totalOwedUsd) || 0;
  const reviewCandidates = asNumber(summary.reviewCandidates) || 0;
  const spokeTotals = summary.spokeDirectoryTotals || {};
  const activeBorrowers = asNumber(borrowerSummary.activeBorrowers) || 0;
  const nearLiquidation = asNumber(borrowerSummary.nearLiquidation) || 0;
  const liquidatable = asNumber(borrowerSummary.liquidatable) || 0;
  const borrowerWatch = liquidatable;
  const topReviewRows = Array.isArray(aave?.topReviewRows) ? aave.topReviewRows.slice(0, 5) : [];
  const p = protocolsBySlug["aave-v4"] || {};
  return rankCandidate({
    id: "aave-v4-hubs",
    evaluator: "research",
    surface: "Aave V4 Ethereum hub mapping",
    status: routePositive > 0 ? "needs-fork-proof" : liquidatable > 0 ? "liquidation-watch-needs-quotes" : nearLiquidation > 0 ? "near-liquidation-watch" : watchCandidates > 0 ? "watch-candidate-needs-fork-proof" : "mapped-no-route-positive",
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score: 28 + clamp(totalOwedUsd / 50_000_000, 0, 1) * 12 + clamp(totalCashUsd / 100_000_000, 0, 1) * 8 + clamp(reviewCandidates / 20, 0, 1) * 6 + clamp(activeBorrowers / 60, 0, 1) * 4 + clamp(nearLiquidation / 3, 0, 1) * 5 + (routePositive > 0 ? 20 : 0),
    proximity: `${reviewCandidates} review rows; ${spokeTotals.listedRows || 0} spokes; borrowers ${activeBorrowers}; near ${nearLiquidation}; liquidatable ${liquidatable}; route-positive ${routePositive}`,
    keyMetrics: {
      tvlUsd: p.tvlUsd || null,
      publicChange7dPct: p.change7dPct || null,
      hubsScanned: summary.hubsScanned || 0,
      assetsScanned: summary.assetsScanned || 0,
      totalCashUsd: round(totalCashUsd, 2),
      totalOwedUsd: round(totalOwedUsd, 2),
      topCashUsd: round(summary.topCashUsd, 2),
      topOwedUsd: round(summary.topOwedUsd, 2),
      reviewCandidates,
      watchCandidates,
      borrowerWatchCandidates: borrowerWatch,
      routePositive,
      unverifiedHubs: summary.unverifiedHubs || 0,
      configWord1Counts: summary.configWord1Counts || null,
      accountingViewSuccessCounts: summary.accountingViewSuccessCounts || null,
      spokeDirectoryTotals: summary.spokeDirectoryTotals || null,
      borrowerScan: borrowers?.generatedAt ? {
        generatedAt: borrowers.generatedAt,
        lookbackBlocks: borrowers.query?.lookbackBlocks || null,
        logsScanned: borrowerSummary.logsScanned || 0,
        usersScored: borrowerSummary.usersScored || 0,
        activeBorrowers,
        nearLiquidation,
        liquidatable,
        bestHealthFactor: borrowerSummary.bestHealthFactor || null,
      } : null,
      topReviewRows: topReviewRows.map((row) => ({ hub: row.hub, assetId: row.assetId, symbol: row.symbol, cashUsd: round(row.cashUsd, 0), owedUsd: round(row.totalOwedUsd, 0), configWord1: row.configWord1AsUint })),
    },
    blockers: routePositive > 0
      ? ["Needs route-specific fork proof and executor before any live action"]
      : liquidatable > 0
        ? ["Liquidatable users need exact repay acquisition and collateral exit quotes", "No gas-adjusted positive liquidation route", "No fork proof"]
        : ["No currently liquidatable Aave V4 spoke borrower in recent scan", "Oracle/reference drift below route-positive threshold", "No route-positive fork proof"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["decoded hub borrower/oracle/liquidation semantics", "specific live route with positive quote", "fork extraction proof"],
      missingBeforeAutoExec: ["route-specific executor", "fork proof", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh hub asset reads", "fresh oracle/config reads", "fresh DEX quote", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: liquidatable > 0 ? "Exact-quote repay/collateral exits for the liquidatable user, then fork-proof only if net positive." : "Keep borrower and oracle drift scans on watch; fork only after a liquidatable or overborrow route is exact-quote positive.",
    sourceArtifacts: ["reports/raw/fast/aave-v4-hubs.json", "reports/raw/fast/aave-v4-spoke-borrowers.json", "reports/aave-v4-hubs-triage.md"],
  });
}

function curveIbStableCandidate(curve) {
  const summary = curve?.summary || {};
  const researchPositive = asNumber(summary.researchPositiveRoutes) || 0;
  const cashBlocked = asNumber(summary.cashBlockedRoutes) || 0;
  const externalExitQuoted = asNumber(summary.externalExitQuotedRoutes) || 0;
  const externalExitPositive = asNumber(summary.externalExitPositiveRoutes) || 0;
  const watchCandidates = asNumber(summary.watchCandidates) || 0;
  const routePositive = asNumber(summary.routePositive) || 0;
  const bestNet = asNumber(summary.bestNetProfitUsd) || 0;
  return rankCandidate({
    id: "curve-ib-stable-wrapper-route",
    evaluator: "research",
    surface: "Curve ib3CRV interest-bearing stable wrapper NAV route",
    status: routePositive > 0 ? "needs-fork-proof" : cashBlocked > 0 ? "cash-blocked-no-route-positive" : "mapped-no-positive-route",
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score: 26 + clamp(researchPositive / 15, 0, 1) * 8 + clamp(bestNet / 10_000, 0, 1) * 8 - (cashBlocked > 0 ? 4 : 0) + (routePositive > 0 ? 20 : 0),
    proximity: `${researchPositive} research-positive; ${cashBlocked} cash-blocked; external exits ${externalExitQuoted}/${externalExitPositive}; route-positive ${routePositive}`,
    keyMetrics: {
      pool: curve?.pool?.address || null,
      apyPct: curve?.pool?.yieldMeta?.apy || null,
      volumeUsd1d: curve?.pool?.yieldMeta?.volumeUsd1d ?? null,
      routeQuotes: summary.routeQuotes || 0,
      researchPositiveRoutes: researchPositive,
      externalExitQuotedRoutes: externalExitQuoted,
      externalExitPositiveRoutes: externalExitPositive,
      cashBlockedRoutes: cashBlocked,
      watchCandidates,
      routePositive,
      bestNetProfitUsd: round(bestNet, 2),
      bestRoute: summary.bestRoute || null,
    },
    blockers: routePositive > 0
      ? ["Needs fork proof before any live action"]
      : cashBlocked > 0
        ? ["Output wrapper redeem cash is dust", "No exact positive external output-wrapper sale", "Positive quotes are trapped-liquidity research only", "No route-positive fork target"]
        : ["No current positive wrapper NAV route"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["wrapper getCash recovers materially", "external buyer/exit route for output wrapper", "fork-positive exchange/redeem proof"],
      missingBeforeAutoExec: ["route-specific executor", "fork proof", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh exchange rates", "fresh Curve quote", "fresh wrapper getCash", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: "Reopen only if Iron Bank wrapper redeem cash recovers or an external output-wrapper exit route appears.",
    sourceArtifacts: ["reports/raw/fast/curve-ib-stable-wrapper-route.json", "reports/curve-ib-stable-wrapper-triage.md"],
  });
}

function baseSyrupUsdcCandidate(syrup) {
  const summary = syrup?.summary || {};
  const routePositive = asNumber(summary.routePositive) || 0;
  const watchCandidates = asNumber(summary.watchCandidates) || 0;
  const navSpreadBps = asNumber(summary.navSpreadBps);
  const exitSpreadBps = asNumber(summary.exitSpreadBps);
  const aaveEdge = asNumber(summary.aaveBorrowableVsMarketBps);
  const fluidEdge = asNumber(summary.fluidBestBorrowableVsMarketBps);
  const bestProgress = Math.max(navSpreadBps || -Infinity, exitSpreadBps || -Infinity, aaveEdge || -Infinity, fluidEdge || -Infinity);
  return rankCandidate({
    id: "base-syrupusdc-routes",
    evaluator: "research",
    surface: "Base syrupUSDC DEX/NAV plus Aave/Fluid consumer routes",
    status: routePositive > 0 ? "needs-fork-proof" : watchCandidates > 0 ? "watch-candidate-needs-fork-proof" : "mapped-no-route-positive",
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score: 25 + clamp((bestProgress || 0) / 100, 0, 1) * 10 + clamp((syrup?.dexPair?.liquidityUsd || 0) / 500_000, 0, 1) * 6 + (routePositive > 0 ? 20 : 0),
    proximity: `NAV ${round(navSpreadBps, 2)}bps; Aave ${round(aaveEdge, 2)}bps; Fluid ${round(fluidEdge, 2)}bps; route-positive ${routePositive}`,
    keyMetrics: {
      marketPriceUsd: summary.marketPriceUsd ?? null,
      mapleExitUsd: summary.mapleExitUsd ?? null,
      navSpreadBps: round(navSpreadBps, 2),
      exitSpreadBps: round(exitSpreadBps, 2),
      aaveBorrowableVsMarketBps: round(aaveEdge, 2),
      fluidBestBorrowableVsMarketBps: round(fluidEdge, 2),
      dexLiquidityUsd: round(syrup?.dexPair?.liquidityUsd, 0),
      watchCandidates,
      routePositive,
    },
    blockers: routePositive > 0
      ? ["Needs fork proof before any live action"]
      : ["Base market is below Maple NAV/exit", "Base token mint/burn is role-gated", "Aave collateral LTV is zero", "Fluid CF haircut makes one-token borrow routes negative"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["DEX/NAV or lending oracle edge above fees/slippage/gas", "public bridge/redeem or borrow route proven", "fork-positive extraction proof"],
      missingBeforeAutoExec: ["route-specific executor", "fork proof", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh Maple NAV", "fresh Base DEX quote", "fresh Aave/Fluid config", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: "Reopen only if Base DEX premium or Aave/Fluid collateral economics cross the route-positive threshold.",
    sourceArtifacts: ["reports/raw/fast/base-syrupusdc-routes.json", "reports/base-syrupusdc-routes-triage.md"],
  });
}

function baseCadcCandidate(cadc) {
  const summary = cadc?.summary || {};
  const routePositive = asNumber(summary.routePositive) || 0;
  const watchCandidates = asNumber(summary.watchCandidates) || 0;
  const marketVsFxBps = asNumber(summary.marketVsCadFxBps);
  const aaveEdge = asNumber(summary.aaveBorrowableVsMarketBps);
  const morphoEdge = asNumber(summary.morphoBestBorrowableVsMarketBps);
  const bestProgress = Math.max(Math.abs(marketVsFxBps ?? 0), aaveEdge ?? -Infinity, morphoEdge ?? -Infinity);
  const fmtBps = (value) => value === null || value === undefined ? "n/a" : `${round(value, 2)}bps`;
  return rankCandidate({
    id: "base-cadc-routes",
    evaluator: "research",
    surface: "Base CADC DEX/FX plus lending-consumer routes",
    status: routePositive > 0 ? "needs-fork-proof" : watchCandidates > 0 ? "watch-candidate-needs-fork-proof" : "mapped-no-route-positive",
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score: 24 + clamp((bestProgress || 0) / 150, 0, 1) * 10 + clamp((summary.dexLiquidityUsd || 0) / 500_000, 0, 1) * 6 + (routePositive > 0 ? 20 : 0),
    proximity: `FX ${fmtBps(marketVsFxBps)}; Aave ${fmtBps(aaveEdge)}; Morpho ${fmtBps(morphoEdge)}; route-positive ${routePositive}`,
    keyMetrics: {
      marketPriceUsd: summary.marketPriceUsd ?? null,
      cadUsdFx: summary.cadUsdFx ?? null,
      marketVsCadFxBps: round(marketVsFxBps, 2),
      aaveBorrowableVsMarketBps: round(aaveEdge, 2),
      morphoBestBorrowableVsMarketBps: round(morphoEdge, 2),
      dexLiquidityUsd: round(summary.dexLiquidityUsd, 0),
      morphoCollateralMarkets: summary.morphoCollateralMarkets || 0,
      compoundCadcRows: summary.compoundCadcRows || 0,
      siloCadcRows: summary.siloCadcRows || 0,
      watchCandidates,
      routePositive,
    },
    blockers: routePositive > 0
      ? ["Needs fork proof before any live action"]
      : ["No public on-chain CADC mint/redeem route", "No positive Aave/Morpho/Compound/Silo borrow route", "FX redemption is off-chain/KYC and not permissionless"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["DEX/FX or lending oracle edge above fees/slippage/gas", "permissionless mint/redeem or borrow route proven", "fork-positive extraction proof"],
      missingBeforeAutoExec: ["route-specific executor", "fork proof", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh CAD/USD FX", "fresh Base DEX quote", "fresh lending configs", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: "Reopen only if CADC FX/DEX or lending-consumer economics cross the route-positive threshold with a permissionless path.",
    sourceArtifacts: ["reports/raw/fast/base-cadc-routes.json", "reports/base-cadc-routes-triage.md"],
  });
}

function avalancheStableYieldCandidate(avalanche) {
  const summary = avalanche?.summary || {};
  const routePositive = asNumber(summary.routePositive) || 0;
  const watchCandidates = asNumber(summary.watchCandidates) || 0;
  const bestEdgeBps = asNumber(summary.bestRouteEdgeBps) || 0;
  const usdtSpread = asNumber(summary.usdtDexVsReferenceBps);
  const susdeSpread = asNumber(summary.susdeDexVsReferenceBps);
  const aaveRoute = (avalanche?.aave?.rows || []).reduce((best, row) => {
    const edge = asNumber(row?.routeModel?.edgeBps);
    if (!Number.isFinite(edge)) return best;
    return !best || edge > best.edgeBps ? { symbol: row.symbol, edgeBps: edge, ltv: asNumber(row?.routeModel?.effectiveLtv), borrowCashUsd: asNumber(row?.routeModel?.bestBorrowCashUsd) } : best;
  }, null);
  const benqiRoute = (avalanche?.benqi?.rows || []).reduce((best, row) => {
    const edge = asNumber(row?.routeModel?.edgeBps);
    if (!Number.isFinite(edge)) return best;
    return !best || edge > best.edgeBps ? { symbol: row.qSymbol, edgeBps: edge, cf: asNumber(row.collateralFactor), borrowCashUsd: asNumber(row?.routeModel?.bestBorrowCashUsd) } : best;
  }, null);
  return rankCandidate({
    id: "avalanche-stable-yield-routes",
    evaluator: "research",
    surface: "Avalanche high-APY stable DEX/redeemability/lending routes",
    status: routePositive > 0 ? "needs-fork-proof" : watchCandidates > 0 ? "watch-candidate-route-negative" : "mapped-no-route-positive",
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score: 23 + clamp(Math.abs(bestEdgeBps) / 100, 0, 1) * 6 + clamp(watchCandidates / 4, 0, 1) * 8 + clamp((summary.usdtUsdcApy || 0) / 100, 0, 1) * 4 + (routePositive > 0 ? 20 : 0),
    proximity: `USDT ${round(usdtSpread, 2)}bps; sUSDe ${round(susdeSpread, 2)}bps; best route ${round(bestEdgeBps, 2)}bps; route-positive ${routePositive}`,
    keyMetrics: {
      usdtUsdcApyPct: round(summary.usdtUsdcApy, 2),
      usdtUsdcRewardOnly: summary.usdtUsdcRewardOnly ?? null,
      usdtDexVsReferenceBps: round(usdtSpread, 2),
      susdeUsdcApyPct: round(summary.susdeUsdcApy, 2),
      susdeUsdcRewardOnly: summary.susdeUsdcRewardOnly ?? null,
      susdeDexVsReferenceBps: round(susdeSpread, 2),
      susdePoolOneSided: summary.susdePoolOneSided ?? null,
      bestRouteEdgeBps: round(bestEdgeBps, 2),
      bestAaveRoute: aaveRoute ? { symbol: aaveRoute.symbol, edgeBps: round(aaveRoute.edgeBps, 2), ltv: aaveRoute.ltv, borrowCashUsd: round(aaveRoute.borrowCashUsd, 0) } : null,
      bestBenQiRoute: benqiRoute ? { symbol: benqiRoute.symbol, edgeBps: round(benqiRoute.edgeBps, 2), collateralFactor: benqiRoute.cf, borrowCashUsd: round(benqiRoute.borrowCashUsd, 0) } : null,
      watchCandidates,
      routePositive,
    },
    blockers: routePositive > 0
      ? ["Needs fork proof before any live action"]
      : ["High APY is reward-only", "DEX/reference spreads are below route threshold", "Aave/BenQi collateral haircuts make borrow routes negative", "No public sUSDe redeem/cooldown exit was proven"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["DEX/reference or lending oracle edge above fees/slippage/gas", "permissionless redeem/exit or borrow route proven", "fork-positive extraction proof"],
      missingBeforeAutoExec: ["route-specific executor", "fork proof", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh DefiLlama/APY and DEX quote", "fresh Aave/BenQi config", "fresh redeemability probes", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: "Reopen only if a live spread or lending-consumer edge crosses the route-positive threshold with a permissionless exit.",
    sourceArtifacts: ["reports/raw/fast/avalanche-stable-yield-routes.json", "reports/avalanche-stable-yield-routes-triage.md"],
  });
}

function hyperliquidLinkedTokensCandidate(linked) {
  const summary = linked?.summary || {};
  const routePositive = asNumber(summary.routePositive) || 0;
  const watchCandidates = asNumber(summary.watchCandidates) || 0;
  const reviewCandidates = asNumber(summary.reviewCandidates) || 0;
  const linkedTokensScanned = asNumber(summary.linkedTokensScanned) || 0;
  const topWatch = Array.isArray(linked?.topWatchRows) ? linked.topWatchRows.slice(0, 3) : [];
  return rankCandidate({
    id: "hyperliquid-linked-token-invariants",
    evaluator: "research",
    surface: "HyperCore spot <> HyperEVM linked-token bridge invariants",
    status: routePositive > 0 ? "needs-fork-proof" : watchCandidates > 0 ? "watch-candidate-needs-consumer-join" : "mapped-no-route-positive",
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score: 24 + clamp(linkedTokensScanned / 150, 0, 1) * 7 + clamp(watchCandidates / 3, 0, 1) * 8 + clamp(reviewCandidates / 100, 0, 1) * 4 + (routePositive > 0 ? 20 : 0),
    proximity: `${linkedTokensScanned} linked tokens; ${watchCandidates} watch; ${reviewCandidates} review; route-positive ${routePositive}`,
    keyMetrics: {
      chainId: linked?.chain?.chainId || null,
      blockNumber: linked?.chain?.blockNumber || null,
      linkedTokensScanned,
      decimalsMismatch: summary.decimalsMismatch || 0,
      systemTransferProbeFailures: summary.systemTransferProbeFailures || 0,
      systemBalanceExceedsSupply: summary.systemBalanceExceedsSupply || 0,
      proxyLikeRows: summary.proxyLikeRows || 0,
      codeMissing: summary.codeMissing || 0,
      reviewCandidates,
      watchCandidates,
      routePositive,
      topWatch,
    },
    blockers: routePositive > 0
      ? ["Needs route-specific fork proof and executor before any live action"]
      : ["Watch rows are bridge/accounting metadata only", "No joined lending/yield/DEX consumer route", "No route-positive fork target"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["linked-token invariant anomaly joins to lending/yield/DEX consumer", "borrow/exit liquidity exists", "fork-positive extraction proof"],
      missingBeforeAutoExec: ["consumer join", "route-specific executor", "fork proof", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh spotMetaAndAssetCtxs", "fresh HyperEVM token reads", "fresh consumer config", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: watchCandidates > 0 ? "Join watch rows to HyperEVM lending/yield/DEX consumers; fork only if a positive route appears." : "Keep linked-token invariants on watch; no consumer route currently mapped.",
    sourceArtifacts: ["reports/raw/fast/hyperliquid-linked-token-invariants.json", "reports/hyperliquid-linked-token-invariants-triage.md"],
  });
}

function hyperliquidLinkedTokenConsumersCandidate(consumers, depth = {}) {
  const summary = consumers?.summary || {};
  const diagnostics = summary.diagnostics || {};
  const depthSummary = depth?.summary || {};
  const routePositive = asNumber(summary.routePositive) || 0;
  const watchCandidates = asNumber(summary.watchCandidates) || 0;
  const joinedRows = asNumber(summary.joinedRows) || 0;
  const researchPositiveRows = asNumber(summary.researchPositiveRows) || 0;
  const consumerJoins = asNumber(summary.consumerJoins) || 0;
  const exactDepthDone = Boolean(depth?.generatedAt);
  const exactDepthRoutePositive = asNumber(depthSummary.routePositive) || 0;
  const exactDepthResearchPositiveRows = asNumber(depthSummary.researchPositiveRows) || 0;
  const exactDepthModeledNegative = exactDepthDone && exactDepthRoutePositive === 0 && exactDepthResearchPositiveRows === 0;
  const depthRows = Array.isArray(depth?.rows) ? depth.rows : [];
  const bestExactDepthRoute = depthRows.reduce((acc, row) => {
    const net = asNumber(row?.bestEstimatedRoute?.netUsd);
    if (!Number.isFinite(net)) return acc;
    return !acc || net > acc.netUsd ? { symbol: row.symbol, netUsd: net, direction: row.bestEstimatedRoute?.direction || null } : acc;
  }, null);
  const top = Array.isArray(consumers?.topRows) ? consumers.topRows.slice(0, 5) : [];
  const sourceArtifacts = ["reports/raw/fast/hyperliquid-linked-token-consumers.json", "reports/hyperliquid-linked-token-consumers-triage.md"];
  if (exactDepthDone) sourceArtifacts.push("reports/raw/fast/hyperliquid-core-dex-depth-routes.json", "reports/hyperliquid-core-dex-depth-routes-triage.md");
  return rankCandidate({
    id: "hyperliquid-linked-token-consumers",
    evaluator: "research",
    surface: "Hyperliquid linked-token consumer graph and DEX liquidity joins",
    status: routePositive > 0 ? "needs-fork-proof" : exactDepthModeledNegative ? "research-positive-depth-modeled-route-negative" : researchPositiveRows > 0 ? "research-positive-needs-executable-depth" : watchCandidates > 0 ? "watch-candidate-no-route" : "mapped-no-route-positive",
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score: 26 + clamp(joinedRows / 30, 0, 1) * 8 + clamp(researchPositiveRows / 12, 0, 1) * 7 + clamp(consumerJoins / 250, 0, 1) * 5 + (routePositive > 0 ? 20 : 0) - (exactDepthModeledNegative ? 5 : 0),
    proximity: exactDepthModeledNegative
      ? `${joinedRows} joined rows; exact-depth best $${round(bestExactDepthRoute?.netUsd, 2)}; route-positive ${routePositive}`
      : `${joinedRows} joined rows; ${researchPositiveRows} research-positive; ${watchCandidates} watch; route-positive ${routePositive}`,
    keyMetrics: {
      candidateRowsScanned: summary.candidateRowsScanned || 0,
      joinedRows,
      consumerJoins,
      hyperlendJoins: summary.hyperlendJoins || 0,
      yieldJoins: summary.yieldJoins || 0,
      dexJoins: summary.dexJoins || 0,
      researchPositiveRows,
      researchPositiveJoins: summary.researchPositiveJoins || 0,
      watchCandidates,
      routePositive,
      diagnostics: {
        invariantWatchCandidates: diagnostics.invariantWatchCandidates || 0,
        invariantWatchRowsJoined: diagnostics.invariantWatchRowsJoined || 0,
        invariantCriticalRowsJoined: diagnostics.invariantCriticalRowsJoined || 0,
        dexResearchPositiveJoins: diagnostics.dexResearchPositiveJoins || 0,
        hyperlendResearchPositiveJoins: diagnostics.hyperlendResearchPositiveJoins || 0,
        yieldWatchJoins: diagnostics.yieldWatchJoins || 0,
        maxDexLiquidityUsd: diagnostics.maxDexLiquidityUsd || 0,
        maxDexLiquidityToken: diagnostics.maxDexLiquidityToken || null,
        maxYieldTvlUsd: diagnostics.maxYieldTvlUsd || 0,
        maxYieldTvlToken: diagnostics.maxYieldTvlToken || null,
        maxBorrowCashUsd: diagnostics.maxBorrowCashUsd || 0,
        maxBorrowCashToken: diagnostics.maxBorrowCashToken || null,
        maxAbsEdgeBps: diagnostics.maxAbsEdgeBps || 0,
        maxAbsEdgeToken: diagnostics.maxAbsEdgeToken || null,
        topResearchTokens: diagnostics.topResearchTokens || [],
      },
      exactDepthGeneratedAt: depth?.generatedAt || null,
      exactDepthTargetsScanned: depthSummary.targetsScanned || 0,
      exactDepthRoutePositive,
      exactDepthResearchPositiveRows,
      bestExactDepthRoute,
      topRows: top.map((row) => ({ token: row.token, score: row.score, researchPositive: row.researchPositive, routePositive: row.routePositive, metrics: row.metrics })),
    },
    blockers: routePositive > 0
      ? ["Needs route-specific fork proof and executor before any live action"]
      : exactDepthModeledNegative
        ? ["Exact-depth follow-up modeled top rows route-negative", "DEX side is still estimated, not exact on-chain quote", "No fork-positive route"]
      : ["Raw spread/liquidity hints lack exact HyperCore order-book depth", "No executable transfer/unwind/fork proof", "HOPE invariant watch row has no consumer join"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["consumer-joined route with exact DEX quote and HyperCore depth", "permissionless transfer/unwind timing proven", "fork-positive extraction proof"],
      missingBeforeAutoExec: ["exact route model", "fork proof", "route-specific executor", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh linked-token invariant scan", "fresh DEX quotes", "fresh HyperCore order-book depth", "fresh lending configs", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: exactDepthModeledNegative ? "Exact-depth pass is route-negative; reopen only if exact on-chain DEX quoters/pool math or fresh depth turns routePositive > 0." : researchPositiveRows > 0 ? "Add exact HyperCore order-book depth and route quoting for top research-positive rows; keep routePositive=0 until executable economics are proven." : "Keep consumer graph on watch; no route-positive join exists.",
    sourceArtifacts,
  });
}

function hyperliquidCoreDexDepthCandidate(depth) {
  const summary = depth?.summary || {};
  const routePositive = asNumber(summary.routePositive) || 0;
  const researchPositiveRows = asNumber(summary.researchPositiveRows) || 0;
  const depthAvailable = asNumber(summary.depthAvailable) || 0;
  const dexPairsAvailable = asNumber(summary.dexPairsAvailable) || 0;
  const targetsScanned = asNumber(summary.targetsScanned) || 0;
  const rows = Array.isArray(depth?.rows) ? depth.rows : [];
  const best = rows.reduce((acc, row) => {
    const net = asNumber(row?.bestEstimatedRoute?.netUsd);
    if (!Number.isFinite(net)) return acc;
    return !acc || net > acc.netUsd ? { symbol: row.symbol, netUsd: net, direction: row.bestEstimatedRoute?.direction || null, market: row.hyperCoreMarket?.coin || null, dex: row.dex?.dexId || null } : acc;
  }, null);
  return rankCandidate({
    id: "hyperliquid-core-dex-depth-routes",
    evaluator: "research",
    surface: "HyperCore l2Book depth plus HyperEVM DEX route model",
    status: routePositive > 0 ? "needs-fork-proof" : researchPositiveRows > 0 ? "research-positive-needs-exact-dex-quote" : "depth-modeled-route-negative",
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score: 25 + clamp(depthAvailable / Math.max(1, targetsScanned), 0, 1) * 8 + clamp(dexPairsAvailable / Math.max(1, targetsScanned), 0, 1) * 6 + clamp(Math.max(0, best?.netUsd || 0) / 50, 0, 1) * 8 + (routePositive > 0 ? 20 : 0),
    proximity: `${targetsScanned} targets; depth ${depthAvailable}; dex ${dexPairsAvailable}; best net $${round(best?.netUsd, 2)}; route-positive ${routePositive}`,
    keyMetrics: {
      targetsScanned,
      directUsdcMarkets: summary.directUsdcMarkets || 0,
      depthAvailable,
      dexPairsAvailable,
      researchPositiveRows,
      routePositive,
      bestEstimatedRoute: best,
      exactDexQuoteRequired: depth?.thresholds?.exactDexQuoteRequired ?? null,
      coreFeeBps: depth?.thresholds?.coreFeeBps ?? null,
      dexFeeBps: depth?.thresholds?.dexFeeBps ?? null,
      delayBufferBps: depth?.thresholds?.delayBufferBps ?? null,
    },
    blockers: routePositive > 0
      ? ["Needs fork proof before any live action"]
      : ["No target clears net-profit threshold after l2Book depth and conservative costs", "DEX side is still estimated, not exact on-chain quote", "No fork-positive route"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["best estimated route exceeds profit threshold", "exact on-chain DEX quote integrated", "HyperCore transfer/unwind timing modeled", "fork-positive extraction proof"],
      missingBeforeAutoExec: ["exact DEX quote", "fork proof", "route-specific executor", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh HyperCore l2Book", "fresh DEX quote", "fresh gas", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: "Only continue Hyper DEX/Core route modeling if exact DEX quoters/pool math are added; current l2Book-depth pass is route-negative.",
    sourceArtifacts: ["reports/raw/fast/hyperliquid-core-dex-depth-routes.json", "reports/hyperliquid-core-dex-depth-routes-triage.md"],
  });
}

function hyperevmLstLrtOracleRoutesCandidate(routes) {
  const summary = routes?.summary || {};
  const targets = asNumber(summary.targets) || 0;
  const consumerRows = asNumber(summary.consumerRows) || 0;
  const morphoMarkets = asNumber(summary.morphoMarkets) || 0;
  const hyperlendRows = asNumber(summary.hyperlendRows) || 0;
  const watchCandidates = asNumber(summary.watchCandidates) || 0;
  const researchPositiveRows = asNumber(summary.researchPositiveRows) || 0;
  const routePositive = asNumber(summary.routePositive) || 0;
  const bestLiquidNet = asNumber(summary.bestLiquidNetUsd);
  const bestLiquidEdge = asNumber(summary.bestLiquidEdgeBps);
  const bestLiquidLiquidity = asNumber(summary.bestLiquidLiquidityUsd) || 0;
  const top = Array.isArray(routes?.topRows) ? routes.topRows.slice(0, 5) : [];
  return rankCandidate({
    id: "hyperevm-lst-lrt-oracle-routes",
    evaluator: "research",
    surface: "HyperEVM HYPE LST/LRT oracle routes across Morpho and HyperLend",
    status: routePositive > 0 ? "needs-fork-proof" : researchPositiveRows > 0 ? "research-positive-needs-exact-quote" : "modeled-route-negative",
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score: 30 + clamp(consumerRows / 50, 0, 1) * 8 + clamp(watchCandidates / 20, 0, 1) * 6 + clamp(Math.max(0, bestLiquidNet || 0) / 100, 0, 1) * 8 + (routePositive > 0 ? 20 : 0),
    proximity: `${targets} targets; ${morphoMarkets} Morpho; ${hyperlendRows} HyperLend; best liquid net $${round(bestLiquidNet, 2)} (${round(bestLiquidEdge, 2)}bps); route-positive ${routePositive}`,
    keyMetrics: {
      targets,
      morphoMarkets,
      hyperlendRows,
      consumerRows,
      watchCandidates,
      researchPositiveRows,
      routePositive,
      bestProtocol: summary.bestProtocol || null,
      bestSymbol: summary.bestSymbol || null,
      bestNetUsd: round(summary.bestNetUsd, 2),
      bestEdgeBps: round(summary.bestEdgeBps, 2),
      bestLiquidProtocol: summary.bestLiquidProtocol || null,
      bestLiquidSymbol: summary.bestLiquidSymbol || null,
      bestLiquidNetUsd: round(bestLiquidNet, 2),
      bestLiquidEdgeBps: round(bestLiquidEdge, 2),
      bestLiquidLiquidityUsd: round(bestLiquidLiquidity, 0),
      topRows: top.map((row) => ({ protocol: row.protocol, symbol: row.collateral?.symbol, ltv: row.ltv, liquidityUsd: round(row.liquidityUsd, 0), netUsd: round(row.bestRouteAttempt?.estimatedNetUsd, 2), edgeBps: round(row.bestRouteAttempt?.edgeBps, 2), routePositive: row.routePositive })),
    },
    blockers: routePositive > 0
      ? ["Needs route-specific fork proof and executor before any live action"]
      : ["LTV/LLTV-adjusted accepted values are below current acquisition costs", "DEX acquisition is estimated, not exact executable quote", "No fork-positive route"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["HYPE LST/LRT oracle value exceeds executable acquisition cost after LTV/LLTV", "borrow-side liquidity remains material", "fork-positive extraction proof"],
      missingBeforeAutoExec: ["exact DEX quote", "fork proof", "route-specific executor", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh Morpho/HyperLend oracle reads", "fresh exact DEX quote", "fresh borrow liquidity", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: routePositive > 0 ? "Fork-proof the exact HYPE wrapper route before any live action." : "Reopen only if a HYPE wrapper trades at a large discount or an exact quote flips the LLTV-adjusted route positive.",
    sourceArtifacts: ["reports/raw/fast/hyperevm-lst-lrt-oracle-routes.json", "reports/hyperevm-lst-lrt-oracle-routes-triage.md"],
  });
}

function hyperevmLstLrtExactQuotesCandidate(quotes) {
  const summary = quotes?.summary || {};
  const quoteRows = asNumber(summary.quoteRows) || 0;
  const exactRows = asNumber(summary.exactPoolQuoteRows) || 0;
  const configuredRows = asNumber(summary.configuredQuoterRows) || 0;
  const failedRows = asNumber(summary.failedQuoteRows) || 0;
  const routePositive = asNumber(summary.routePositive) || 0;
  const bestNet = asNumber(summary.bestNetUsd);
  const bestEdge = asNumber(summary.bestEdgeBps);
  const score = 29
    + clamp(exactRows / Math.max(1, quoteRows), 0, 1) * 8
    + clamp(configuredRows / Math.max(1, quoteRows), 0, 1) * 4
    + clamp(Math.max(0, bestNet || 0) / 100, 0, 1) * 8
    + (routePositive > 0 ? 25 : 0)
    - (bestNet !== null && bestNet < 0 ? 5 : 0);
  const topRows = (Array.isArray(quotes?.rows) ? quotes.rows : [])
    .slice(0, 5)
    .map((row) => ({
      protocol: row.protocol,
      collateral: row.collateral?.symbol || null,
      loanAsset: row.loanAsset?.symbol || null,
      dexId: row.quote?.dexId || null,
      quoteMethod: row.quote?.method || null,
      liquidityUsd: round(row.liquidityUsd ?? row.quote?.liquidityUsd, 0),
      netUsd: round(row.netUsd, 2),
      edgeBps: round(row.edgeBps, 2),
      routePositive: Boolean(row.routePositive),
    }));

  return rankCandidate({
    id: "hyperevm-lst-lrt-exact-quotes",
    evaluator: "research",
    surface: "HyperEVM HYPE LST/LRT exact DEX quote routes",
    status: routePositive > 0 ? "needs-fork-proof" : "exact-quoted-route-negative",
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score,
    proximity: `${exactRows}/${quoteRows} exact quote rows; best net $${round(bestNet, 2)} (${round(bestEdge, 2)}bps); route-positive ${routePositive}`,
    keyMetrics: {
      consumerRowsConsidered: summary.consumerRowsConsidered || 0,
      quoteRows,
      exactPoolQuoteRows: exactRows,
      configuredQuoterRows: configuredRows,
      failedQuoteRows: failedRows,
      bestNetUsd: round(bestNet, 2),
      bestEdgeBps: round(bestEdge, 2),
      bestCollateral: summary.bestCollateral || null,
      bestDexId: summary.bestDexId || null,
      bestQuoteMethod: summary.bestQuoteMethod || null,
      routePositive,
      topRows,
      signedActionJustified: false,
    },
    blockers: routePositive > 0
      ? ["Needs HyperEVM fork extraction proof before any live action"]
      : ["Exact pool/quoter rows are net-negative after LLTV/gas", "No HyperEVM fork-positive extraction proof", "Missing UltraSolid/secondary Hybra quoters remain coverage gaps, not positive impact"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["exact DEX quote net positive after LLTV/gas/slippage", "borrow-side liquidity remains material", "fork extraction proof"],
      missingBeforeAutoExec: ["fork proof", "route-specific executor", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh exact quote", "fresh borrow liquidity", "fresh gas", "static call", "estimateGas"],
    }),
    nextReadOnlyStep: "Reopen only if exact quote rows flip net positive or missing quoters materially change bestNetUsd.",
    sourceArtifacts: ["reports/raw/fast/hyperevm-lst-lrt-exact-quotes.json", "reports/raw/fast/hyperevm-dex-pool-interfaces.json", "reports/hyperevm-lst-lrt-oracle-routes-triage.md"],
  });
}

function apyusdForkProofCandidate(routeArtifact = {}, proof = {}) {
  const routeSummary = routeArtifact?.summary || {};
  const result = proof?.result || {};
  const staleRoutePositive = asNumber(routeSummary.routePositive) || Number(routeArtifact?.safety?.routePositive === true);
  const forkPositive = result.success === true && result.forkProfitPositive === true && (asNumber(result.netProfitUsd) || 0) > 0;
  const routePositive = forkPositive ? 1 : 0;
  const net = asNumber(result.netProfitUsd);
  return rankCandidate({
    id: "apyusd-erc4626-fork-proof",
    evaluator: "research",
    surface: "apyUSD ERC4626 redeem route fork-proof override",
    status: forkPositive ? "fork-positive-needs-live-preflight" : staleRoutePositive > 0 ? "fork-proof-negative-route-revoked" : "fork-proof-negative",
    severity: forkPositive ? "HIGH" : "DORMANT",
    score: forkPositive ? 88 : staleRoutePositive > 0 ? 44 : 24,
    proximity: `stale route-positive ${staleRoutePositive}; fork success=${Boolean(result.success)} net $${round(net, 2)}; route-positive ${routePositive}`,
    keyMetrics: {
      staleRoutePositive,
      forkBlock: proof?.fork?.forkBlock || null,
      success: Boolean(result.success),
      forkProfitPositive: Boolean(result.forkProfitPositive),
      redeemError: result.redeemError || null,
      sharesReceived: result.sharesReceived || null,
      maxRedeem: result.maxRedeem || null,
      netProfitUsd: round(net, 6),
      gasUsd: round(result.gasUsd, 6),
      routePositive,
      signedActionJustified: false,
    },
    blockers: forkPositive
      ? ["Needs fresh live preflight and explicit authorization before any signed action"]
      : (Array.isArray(result.blockers) && result.blockers.length ? result.blockers : ["Fork proof is not positive", "No signed action justified"]),
    readiness: readiness("fail-closed", false, {
      requiredTrigger: ["new exact route is positive", "fork redeem/extraction succeeds", "netProfitUsd > 0 after gas"],
      missingBeforeAutoExec: ["positive fork proof", "route-specific executor", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh route quote", "fresh redeem staticCall", "gas estimate", "minProfit/minOut gates"],
    }),
    nextReadOnlyStep: "Keep apyUSD fail-closed unless a new exact route and fork proof both turn positive.",
    sourceArtifacts: ["reports/raw/fast/apyusd-erc4626-redeem-route.json", "reports/raw/fast/apyusd-erc4626-fork-proof.json"],
  });
}

function growthMapCandidate(artifact = {}, cfg = {}) {
  const summary = artifact?.summary || {};
  const routePositive = asNumber(summary.routePositive) || 0;
  const watchCandidates = asNumber(summary.watchCandidates) || 0;
  const mapped = asNumber(summary[cfg.mappedField]) || 0;
  const input = asNumber(summary[cfg.inputField]) || 0;
  return rankCandidate({
    id: cfg.id,
    evaluator: "research",
    surface: cfg.surface,
    status: routePositive > 0 ? "needs-fork-proof" : watchCandidates > 0 ? "watch-candidate-needs-route" : "mapped-no-route-positive",
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score: cfg.baseScore + clamp(mapped / Math.max(1, input || mapped), 0, 1) * 8 + clamp(watchCandidates / 3, 0, 1) * 8 + (routePositive > 0 ? 20 : 0),
    proximity: `${mapped}/${input || mapped} mapped; watch ${watchCandidates}; route-positive ${routePositive}`,
    keyMetrics: {
      ...Object.fromEntries(Object.entries(summary).filter(([, value]) => typeof value !== "object")),
      routePositive,
      signedActionJustified: false,
    },
    blockers: routePositive > 0
      ? ["Needs route-specific fork proof before any live action"]
      : cfg.blockers,
    readiness: readiness("watch-only", false, {
      requiredTrigger: cfg.requiredTrigger,
      missingBeforeAutoExec: ["route-specific fork proof", "executor", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh producer map", "fresh consumer join", "fresh exact route quote", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: cfg.nextReadOnlyStep,
    sourceArtifacts: cfg.sourceArtifacts,
  });
}

function usdt0ConsumerRoutesCandidate(consumers, oft = {}) {
  const summary = consumers?.summary || {};
  const oftSummary = oft?.summary || {};
  const watchCandidates = asNumber(summary.watchCandidates) || 0;
  const routePositive = Math.max(asNumber(summary.routePositive) || 0, asNumber(oftSummary.routePositive) || 0);
  const consumersMapped = asNumber(summary.consumersMapped) || 0;
  const peerMismatches = asNumber(oftSummary.peerMismatches) || 0;
  const weakDvnConfigHints = asNumber(oftSummary.weakDvnConfigHints) || 0;
  const escrowMismatch = oft?.supplyEscrowCheck?.scannedRemoteSupplyExceedsSourceEscrow === true;
  const topWatch = Array.isArray(summary.topWatch) ? summary.topWatch.slice(0, 5) : [];

  return rankCandidate({
    id: "usdt0-oft-consumer-routes",
    evaluator: "research",
    surface: "USDT0 LayerZero OFT routes joined to lending consumers",
    status: routePositive > 0 ? "needs-fork-proof" : watchCandidates > 0 ? "watch-candidate-route-negative" : "mapped-no-route-positive",
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score: 28 + clamp(consumersMapped / 20, 0, 1) * 6 + clamp(watchCandidates / 4, 0, 1) * 8 + clamp((peerMismatches + weakDvnConfigHints + (escrowMismatch ? 1 : 0)) / 3, 0, 1) * 10 + (routePositive > 0 ? 20 : 0),
    proximity: `${watchCandidates} watch; peerMismatch ${peerMismatches}; weakDVN ${weakDvnConfigHints}; route-positive ${routePositive}`,
    keyMetrics: {
      consumersMapped,
      watchCandidates,
      topWatch,
      oftRowsScanned: oftSummary.scannedRows || 0,
      peerChecks: oftSummary.peerChecks || 0,
      peerMissing: oftSummary.peerMissing || 0,
      peerMismatches,
      weakDvnConfigHints,
      scannedRemoteSupplyExceedsSourceEscrow: escrowMismatch,
      routePositive,
      signedActionJustified: false,
    },
    blockers: routePositive > 0
      ? ["Needs route-specific fork proof before any live action"]
      : ["No current OFT peer/DVN/escrow anomaly", "No material USDT0 depeg or stale divergence", "Watch rows remain consumer-linked but route-negative"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["USDT0 producer anomaly or material stale/depeg divergence", "positive lending/DEX route economics", "fork-positive extraction proof"],
      missingBeforeAutoExec: ["fork proof", "route-specific executor", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh OFT peer/DVN/escrow state", "fresh consumer reserve/cap/pause state", "fresh DEX/reference price", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: "Reopen only if USDT0 depegs, a stale accepted oracle diverges materially, or an OFT peer/DVN/escrow anomaly appears on a consumer-linked route.",
    sourceArtifacts: ["reports/raw/fast/usdt0-consumer-routes.json", "reports/usdt0-consumer-routes-triage.md", "reports/raw/fast/usdt0-oft-routes.json", "reports/usdt0-oft-routes-triage.md"],
  });
}

function pendlePtConsumerCandidate(pendle = {}, silo = {}) {
  const summary = pendle?.summary || {};
  const siloSummary = silo?.summary || {};
  const routePositive = Math.max(asNumber(summary.routePositive) || 0, asNumber(siloSummary.routePositive) || 0);
  const matches = asNumber(summary.matches) || 0;
  const reviewCandidates = asNumber(summary.reviewCandidates) || 0;
  const watchCandidates = Math.max(asNumber(summary.watchCandidates) || 0, asNumber(siloSummary.watchCandidates) || 0);
  const morphoExecutableQuotes = asNumber(summary.morphoExecutableQuotes) || 0;
  const siloExecutableQuotes = asNumber(siloSummary.pendleExecutableQuotes) || 0;
  const bestPendle = Array.isArray(summary.topByNetEdge) ? summary.topByNetEdge[0] : null;
  const bestSilo = Array.isArray(siloSummary.topByNetEdge) ? siloSummary.topByNetEdge[0] : null;
  const bestNet = [asNumber(bestPendle?.netEdgeUsd), asNumber(bestSilo?.netEdgeUsd)].filter(Number.isFinite).sort((a, b) => b - a)[0] ?? null;

  return rankCandidate({
    id: "pendle-pt-consumer-routes",
    evaluator: "research",
    surface: "Pendle principal-token consumers with exact acquisition quotes",
    status: routePositive > 0 ? "needs-fork-proof" : "quoted-route-negative",
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score: 26 + clamp(matches / 60, 0, 1) * 7 + clamp(reviewCandidates / 14, 0, 1) * 7 + clamp((morphoExecutableQuotes + siloExecutableQuotes) / 4, 0, 1) * 5 + clamp(Math.max(0, bestNet || 0) / 1000, 0, 1) * 8 + (routePositive > 0 ? 20 : 0),
    proximity: `${matches} matches; ${reviewCandidates} review; quotes ${morphoExecutableQuotes + siloExecutableQuotes}; best net $${round(bestNet, 2)}; route-positive ${routePositive}`,
    keyMetrics: {
      producers: summary.producers || 0,
      matches,
      protocolCounts: summary.protocolCounts || {},
      reviewCandidates,
      morphoOraclePricedReviews: summary.morphoOraclePricedReviews || 0,
      morphoExecutableQuotes,
      siloReviewCandidates: siloSummary.reviewCandidates || 0,
      siloExecutableQuotes,
      bestPendle,
      bestSilo,
      bestNet,
      watchCandidates,
      routePositive,
      signedActionJustified: false,
    },
    blockers: routePositive > 0
      ? ["Needs route-specific fork proof before any live action"]
      : ["Accepted PT values remain below LTV/LLTV break-even", "Many rows still lack size-specific executable quotes", "No fork-positive PT route"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["accepted PT value exceeds executable acquisition cost after LTV haircut", "borrow-side liquidity remains material", "fork-positive extraction proof"],
      missingBeforeAutoExec: ["fork proof", "route-specific executor", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh Pendle market quote", "fresh consumer oracle price", "fresh borrow/cash state", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: "Reopen only if a PT accepted price/market quote crosses LTV break-even, or extend to multi-chain PT quotes if a consumer-linked row becomes close to break-even.",
    sourceArtifacts: ["reports/raw/fast/pendle-pt-consumer-graph.json", "reports/pendle-pt-consumer-graph-triage.md", "reports/raw/fast/silo-pt-oracle-routes.json", "reports/silo-pt-oracle-routes-triage.md"],
  });
}

function xstocksConsumerRoutesCandidate(artifact = {}) {
  const summary = artifact?.summary || {};
  const xstocks = artifact?.xstocksSummary || {};
  const consumerMatches = asNumber(summary.consumerMatches) || 0;
  const matchedTokens = asNumber(summary.matchedTokens) || 0;
  const anomalyRows = asNumber(summary.anomalyRows) || 0;
  const consumerLinkedAnomalies = asNumber(summary.consumerLinkedAnomalies) || 0;
  const watchCandidates = asNumber(summary.watchCandidates) || 0;
  const routePositive = asNumber(summary.routePositive) || 0;
  const topRows = (Array.isArray(artifact?.topProducts) ? artifact.topProducts : []).slice(0, 5).map((row) => ({
    symbol: row.symbol,
    arbitrumToken: row.arbitrumToken,
    solanaMint: row.solanaMint,
    riskFlags: row.riskFlags || [],
    consumerMatches: row.consumerMatches || 0,
    consumerLinkedAnomalies: row.consumerLinkedAnomalies || 0,
    routePositive: Boolean(row.routePositive),
  }));

  return rankCandidate({
    id: "xstocks-consumer-routes",
    evaluator: "research",
    surface: "xStocks Arbitrum wrapper and Solana Token-2022 consumer routes",
    status: routePositive > 0 ? "needs-fork-proof" : watchCandidates > 0 ? "watch-candidate-needs-exact-route" : consumerMatches > 0 ? "consumer-linked-no-current-anomaly" : "mapped-no-consumer-route",
    severity: routePositive > 0 ? "HIGH" : watchCandidates > 0 ? "DORMANT" : "INFO",
    score: 21
      + clamp(consumerMatches / 10, 0, 1) * 10
      + clamp(anomalyRows / 5, 0, 1) * 5
      + clamp(consumerLinkedAnomalies / 3, 0, 1) * 10
      + clamp((asNumber(xstocks.defillamaSolanaTvlUsd) || 0) / 500_000_000, 0, 1) * 4
      + (routePositive > 0 ? 25 : 0),
    proximity: `${consumerMatches} consumer matches; ${anomalyRows} anomaly rows; ${consumerLinkedAnomalies} linked anomalies; route-positive ${routePositive}`,
    keyMetrics: {
      productsMapped: summary.productsMapped || 0,
      arbitrumAddressesMapped: summary.arbitrumAddressesMapped || 0,
      consumerRowsScanned: summary.consumerRowsScanned || 0,
      consumerMatches,
      matchedTokens,
      anomalyRows,
      consumerLinkedAnomalies,
      watchCandidates,
      routePositive,
      closedReason: summary.closedReason || null,
      xstocksGeneratedAt: xstocks.generatedAt || null,
      arbitrumTvlUsd: round(xstocks.defillamaArbitrumTvlUsd, 2),
      solanaTvlUsd: round(xstocks.defillamaSolanaTvlUsd, 2),
      topRows,
      signedActionJustified: false,
    },
    blockers: routePositive > 0
      ? ["Needs route-specific fork proof before any live action"]
      : ["No current xStocks wrapper maps to a material lending-consumer route", "Residual xStocks authority/proof signals are not consumer-linked", "No exact positive acquisition/exit economics or fork proof"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["xStock wrapper maps to a liquid consumer", "current xStocks-side anomaly is permissionless-impacting", "exact route economics are positive after gas/slippage", "fork-positive extraction proof"],
      missingBeforeAutoExec: ["consumer-linked route-positive artifact", "fork proof", "route-specific executor", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh xstocks-live artifact", "fresh consumer graph", "fresh exact quote", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: routePositive > 0 ? "Fork-proof only the route-positive xStocks row before any live action." : "Refresh xStocks and consumer artifacts; reopen only if a wrapper is consumed or an exact consumer-linked anomaly appears.",
    sourceArtifacts: ["reports/raw/fast/xstocks-consumer-routes.json", "reports/raw/fast/xstocks-live.json", "reports/xstocks-triage.md"],
  });
}

function dexConsumerRoutesCandidate(artifact = {}) {
  const summary = artifact?.summary || {};
  const dexConsumerMatches = asNumber(summary.dexConsumerMatches) || 0;
  const factoryPairsChecked = asNumber(summary.factoryPairsChecked) || 0;
  const poolInfoChecked = asNumber(summary.poolInfoChecked) || 0;
  const uniqueProducers = asNumber(summary.uniqueProducers) || 0;
  const watchCandidates = asNumber(summary.watchCandidates) || 0;
  const routePositive = asNumber(summary.routePositive) || 0;
  const factoriesScanned = asNumber(summary.factoriesScanned) || 0;

  return rankCandidate({
    id: "dex-consumer-routes",
    evaluator: "research",
    surface: "DEX pool consumer bridge for tokens without direct lending listings",
    status: routePositive > 0 ? "needs-fork-proof" : watchCandidates > 0 ? "watch-candidate-needs-exact-quote" : dexConsumerMatches > 0 ? "dex-matched-no-current-anomaly" : "mapped-no-dex-consumer-route",
    severity: routePositive > 0 ? "HIGH" : watchCandidates > 0 ? "DORMANT" : "INFO",
    score: 20
      + clamp(dexConsumerMatches / 10, 0, 1) * 10
      + clamp(poolInfoChecked / 500, 0, 1) * 4
      + clamp(factoriesScanned / 8, 0, 1) * 3
      + (routePositive > 0 ? 25 : 0),
    proximity: `${dexConsumerMatches} DEX matches; ${poolInfoChecked} pool infos; ${factoriesScanned} factories; route-positive ${routePositive}`,
    keyMetrics: {
      chainsScanned: Array.isArray(summary.chainsScanned) ? summary.chainsScanned : [],
      factoriesScanned,
      factoryPairsChecked,
      poolInfoChecked,
      consumerAssets: asNumber(artifact?.consumerStats?.consumerAssets) || 0,
      producerAddresses: asNumber(artifact?.producerStats?.totalProducerAddresses) || 0,
      dexConsumerMatches,
      uniqueProducers,
      watchCandidates,
      routePositive,
      closedReason: summary.closedReason || null,
      signedActionJustified: false,
    },
    blockers: routePositive > 0
      ? ["Needs exact swap quote and fork proof before any live action"]
      : ["No DEX pool connects any anomalous producer token to a known lending consumer asset", "No exact swap economics or fork proof"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["DEX pool connects producer to consumer token", "pool liquidity is material", "exact swap quote is positive", "consumer lending state permits action", "fork-positive proof"],
      missingBeforeAutoExec: ["DEX-consumer route-positive artifact", "fork proof", "route-specific executor", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh DEX pool reserves/quote", "fresh consumer cap/pause state", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: routePositive > 0 ? "Fork-proof the specific DEX bridge route before any live action." : "Refresh producer/consumer artifacts and extend DEX factory coverage; reopen only if DEX links new producer tokens to liquid consumer assets.",
    sourceArtifacts: ["reports/raw/fast/dex-consumer-routes.json"],
  });
}

function solanaConsumerRoutesCandidate(artifact = {}) {
  const summary = artifact?.summary || {};
  const mintsScanned = asNumber(summary.mintsScanned) || 0;
  const totalAccountsChecked = asNumber(summary.totalAccountsChecked) || 0;
  const protocolMatches = asNumber(summary.protocolMatches) || 0;
  const matchedMints = asNumber(summary.matchedMints) || 0;
  const watchCandidates = asNumber(summary.watchCandidates) || 0;
  const routePositive = asNumber(summary.routePositive) || 0;

  return rankCandidate({
    id: "solana-consumer-routes",
    evaluator: "research",
    surface: "Solana lending/perps consumer scan for Token-2022 mints",
    status: routePositive > 0 ? "needs-fork-proof" : watchCandidates > 0 ? "watch-candidate-needs-exact-route" : protocolMatches > 0 ? "deposited-no-anomaly" : "mapped-no-solana-consumer",
    severity: routePositive > 0 ? "HIGH" : watchCandidates > 0 ? "DORMANT" : "INFO",
    score: 21
      + clamp(mintsScanned / 40, 0, 1) * 5
      + clamp(totalAccountsChecked / 1000, 0, 1) * 4
      + clamp(protocolMatches / 5, 0, 1) * 10
      + (routePositive > 0 ? 25 : 0),
    proximity: `${mintsScanned} mints; ${totalAccountsChecked} accounts; ${protocolMatches} protocol matches; route-positive ${routePositive}`,
    keyMetrics: {
      mintsScanned,
      totalAccountsChecked,
      protocolMatches,
      matchedMints,
      watchCandidates,
      routePositive,
      closedReason: summary.closedReason || null,
      slot: summary.slot || null,
      protocolsSearched: Object.keys(artifact?.targets?.protocolPrograms || {}),
      signedActionJustified: false,
    },
    blockers: routePositive > 0
      ? ["Needs exact Solana route economics and fork proof"]
      : ["No xStocks mint deposited in known Solana lending/perps protocols", "Token-2022 freeze/mint/permanent-delegate authorities remain centralized", "No exact Solana route economics or fork proof"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["Token-2022 mint appears in a Solana protocol", "protocol allows borrowing/margin", "xStocks-side signal is exploitable", "exact route economics positive", "fork-positive proof"],
      missingBeforeAutoExec: ["Solana consumer route-positive artifact", "fork proof", "route-specific executor", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh Solana protocol state", "fresh token account ownership", "fresh exact swap/liquidation quote", "gas estimate"],
    }),
    nextReadOnlyStep: routePositive > 0 ? "Fork-proof the specific Solana route before any live action." : "Reopen only if xStocks or new Token-2022 mints appear as collateral/margin in Solana protocols.",
    sourceArtifacts: ["reports/raw/fast/solana-consumer-routes.json", "reports/raw/fast/xstocks-live.json"],
  });
}

function perpsConsumerRoutesCandidate(artifact = {}) {
  const summary = artifact?.summary || {};
  const totalTokensQueried = asNumber(summary.totalTokensQueried) || 0;
  const totalErc20Tokens = asNumber(summary.totalErc20Tokens) || 0;
  const perpsMatches = asNumber(summary.perpsMatches) || 0;
  const watchCandidates = asNumber(summary.watchCandidates) || 0;
  const routePositive = asNumber(summary.routePositive) || 0;
  const protocolsSearched = asNumber(summary.protocolsSearched) || 0;
  const protocolResults = Array.isArray(artifact?.protocolResults) ? artifact.protocolResults : [];
  const queryErrors = protocolResults.filter((r) => (r.errors || 0) > 0);

  return rankCandidate({
    id: "perps-consumer-routes",
    evaluator: "research",
    surface: "EVM perps margin consumer scan for anomalous producer tokens",
    status: routePositive > 0 ? "needs-fork-proof" : watchCandidates > 0 ? "watch-candidate" : perpsMatches > 0 ? "matched-no-economics" : queryErrors.length === protocolResults.length ? "query-coverage-blocked" : "mapped-no-perps-consumer",
    severity: routePositive > 0 ? "HIGH" : watchCandidates > 0 ? "DORMANT" : "INFO",
    score: 18
      + clamp(protocolsSearched / 4, 0, 1) * 4
      + clamp(totalErc20Tokens / 50, 0, 1) * 8
      + clamp(perpsMatches / 5, 0, 1) * 10
      + (routePositive > 0 ? 25 : 0)
      - (queryErrors.length > 0 ? 5 : 0),
    proximity: `${protocolsSearched} protocols; ${totalErc20Tokens} tokens; ${perpsMatches} matches; ${queryErrors.length} query errors; route-positive ${routePositive}`,
    keyMetrics: {
      protocolsSearched,
      totalTokensQueried,
      totalErc20Tokens,
      perpsMatches,
      watchCandidates,
      routePositive,
      queryErrorProtocols: queryErrors.map((r) => r.protocol),
      closedReason: summary.closedReason || null,
      signedActionJustified: false,
    },
    blockers: routePositive > 0
      ? ["Needs exact perps route economics and fork proof"]
      : queryErrors.length === protocolResults.length
        ? ["Perps protocol ABI queries all failed; function selectors need verification against deployed bytecode", "No exact route economics or fork proof"]
        : ["No anomalous producer token in perps margin lists", "No exact route economics or fork proof"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["perps protocol asset list is successfully queried", "anomalous producer appears as perps margin", "exact position/swap/liquidation economics positive", "fork-positive proof"],
      missingBeforeAutoExec: ["perps consumer route-positive artifact", "fork proof", "route-specific executor", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh perps protocol state", "fresh exact quote", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: "Verify perps protocol function selectors via `cast 4byte`; reopen only when asset lists can be read and producer overlap is found.",
    sourceArtifacts: ["reports/raw/fast/perps-consumer-routes.json"],
  });
}

function dexExitQuotesCandidate(artifact = {}) {
  const summary = artifact?.summary || {};
  const collateralTokensInput = asNumber(summary.collateralTokensInput) || 0;
  const totalQuotesAttempted = asNumber(summary.totalQuotesAttempted) || 0;
  const tokensWithSuccessfulQuote = asNumber(summary.tokensWithSuccessfulQuote) || 0;
  const tokensWithNoQuote = asNumber(summary.tokensWithNoQuote) || 0;
  const routePositive = asNumber(summary.routePositive) || 0;

  const quoteRows = Array.isArray(artifact?.quoteRows) ? artifact.quoteRows : [];
  const bestQuotes = quoteRows.filter((r) => r.bestQuote).map((r) => ({
    symbol: r.symbol,
    dex: r.bestQuote?.dex,
    amountOut: round(r.bestQuote?.amountOut, 6),
  })).slice(0, 8);

  return rankCandidate({
    id: "dex-exit-quotes",
    evaluator: "research",
    surface: "Reusable exact DEX exit quote pipeline for liquidatable collateral",
    status: routePositive > 0 ? "needs-fork-proof" : tokensWithSuccessfulQuote > 0 ? "quoted-route-negative" : "no-exit-quote-available",
    severity: routePositive > 0 ? "HIGH" : "DORMANT",
    score: 22
      + clamp(tokensWithSuccessfulQuote / collateralTokensInput, 0, 1) * 10
      + clamp(totalQuotesAttempted / 20, 0, 1) * 5
      + (routePositive > 0 ? 25 : 0)
      - (tokensWithNoQuote > 0 ? 3 : 0),
    proximity: `${tokensWithSuccessfulQuote}/${collateralTokensInput} tokens quoted; ${totalQuotesAttempted} total quotes; route-positive ${routePositive}`,
    keyMetrics: {
      collateralTokensInput,
      totalQuotesAttempted,
      tokensWithSuccessfulQuote,
      tokensWithNoQuote,
      bestQuoteToken: summary.bestQuoteToken || null,
      bestQuoteAmountOut: round(summary.bestQuoteAmountOut, 6),
      routePositive,
      bestQuotes,
      signedActionJustified: false,
    },
    blockers: routePositive > 0
      ? ["Needs integration with liquidation scanner and fork proof"]
      : ["All exit quotes are net-negative after gas/fees", "PT/exotic tokens have no DEX exit route", "No route-positive exit economics or fork proof"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["collateral has liquid DEX exit route", "exit output exceeds repay plus gas", "liquidation integration shows net-positive route", "fork-positive proof"],
      missingBeforeAutoExec: ["net-positive exit route", "fork proof", "route-specific executor", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh DEX exit quote", "fresh gas estimate", "static call", "minProfit/minOut gates"],
    }),
    nextReadOnlyStep: "Feed exit quotes into liquidation scanner pipelines; fork-proof only net-positive routes.",
    sourceArtifacts: ["reports/raw/fast/dex-exit-quotes.json"],
  });
}

function lorenzoBscSupplyWatchCandidate(artifact = {}) {
  const nav = artifact?.navState || {};
  const quotes = artifact?.quotes || {};
  const navTimingWindow = Boolean(nav.navTimingWindow);
  const navPendingUpwardBps = asNumber(nav.navPendingUpwardBps);
  const sellRoutePositive = Boolean(artifact?.summary?.sellRoutePositive);
  const buyRoutePositive = Boolean(artifact?.summary?.buyRoutePositive);
  const routePositive = asNumber(artifact?.summary?.routePositive) || 0;
  const bestSellEdge = asNumber(quotes?.bestSell?.grossEdgeBps);
  const bestBuyEdge = asNumber(quotes?.bestBuy?.grossEdgeBps);

  return rankCandidate({
    id: "lorenzo-bsc-supply-watch",
    evaluator: "research",
    surface: "BSC Lorenzo sUSD1+ NAV-update supply-route watch",
    status: routePositive > 0 ? "needs-fork-proof" : navTimingWindow ? "nav-window-open-needs-exact-route" : sellRoutePositive ? "supply-route-positive-needs-fork" : buyRoutePositive ? "buy-route-positive-needs-fork" : "nav-supply-watch-closed",
    severity: routePositive > 0 ? "HIGH" : navTimingWindow ? "DORMANT" : "INFO",
    score: 28
      + (navTimingWindow ? 15 : 0)
      + clamp(Math.max(0, (bestSellEdge || -100) + 100) / 100, 0, 1) * 8
      + clamp(Math.max(0, (bestBuyEdge || -100) + 100) / 100, 0, 1) * 5
      + (routePositive > 0 ? 25 : 0),
    proximity: `sell edge ${round(bestSellEdge, 1)}bps; buy edge ${round(bestBuyEdge, 1)}bps; NAV window ${navTimingWindow}; route-positive ${routePositive}`,
    keyMetrics: {
      nav: round(nav.currentNav, 8),
      period: nav.settlementPeriod,
      navDeltaVsPrevBps: round(nav.navDeltaVsPrevBps, 2),
      navPendingUpwardBps: round(navPendingUpwardBps, 2),
      navTimingWindow,
      supplySelectable: Boolean(artifact?.vault?.supplySelectable),
      paused: Boolean(artifact?.vault?.paused),
      sellRouteEdgeBps: round(bestSellEdge, 2),
      buyRouteEdgeBps: round(bestBuyEdge, 2),
      sellRoutePositive,
      buyRoutePositive,
      routePositive,
      signedActionJustified: false,
    },
    blockers: navTimingWindow
      ? ["NAV timing window is open but supply-sell exact economics need verification"]
      : ["Supply-and-sell DEX spread is below breakeven", "No NAV-update timing window detected", "Inverse buy route is gross-positive but same-epoch exit is not proven"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["NAV update pending with positive delta", "supply() is public and unpaused", "DEX sell quote positive after NAV uplift", "fork-positive proof"],
      missingBeforeAutoExec: ["NAV-supply route-positive artifact", "fork proof", "BSC executor", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh NAV vs DEX sell quote", "fresh supply access check", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: navTimingWindow ? "Verify exact supply-sell route economics; fork-proof only if net-positive." : "Keep BSC Lorenzo on fast watch; reopen if sell spread narrows or NAV timing window opens.",
    sourceArtifacts: ["reports/raw/fast/lorenzo-bsc-supply-route-watch.json"],
  });
}

function oracleStalenessCrossRefCandidate(artifact = {}) {
  const summary = artifact?.summary || {};
  const feedsQueried = asNumber(summary.feedsQueried) || 0;
  const nearHeartbeat = asNumber(summary.nearHeartbeat) || 0;
  const exceededHeartbeat = asNumber(summary.exceededHeartbeat) || 0;
  const routePositive = asNumber(summary.routePositive) || 0;
  const topRows = (Array.isArray(artifact?.results) ? artifact.results : []).slice(0, 6).map(r => ({
    description: r.description, ageHours: r.ageHours, heartbeatExceeded: r.heartbeatExceeded, symbols: r.symbols,
  }));

  return rankCandidate({
    id: "oracle-staleness-cross-ref",
    evaluator: "research",
    surface: "Chainlink feed age vs protocol staleness threshold cross-reference",
    status: routePositive > 0 ? "needs-fork-proof" : exceededHeartbeat > 0 ? "heartbeat-exceeded-needs-protocol-threshold-check" : nearHeartbeat > 0 ? "approaching-heartbeat" : "all-feeds-within-heartbeat",
    severity: routePositive > 0 ? "HIGH" : exceededHeartbeat > 0 ? "DORMANT" : "INFO",
    score: 22
      + clamp(feedsQueried / 15, 0, 1) * 5
      + clamp(nearHeartbeat / 3, 0, 1) * 8
      + clamp(exceededHeartbeat / 1, 0, 1) * 12
      + (routePositive > 0 ? 25 : 0),
    proximity: `${feedsQueried} feeds; ${nearHeartbeat} near heartbeat; ${exceededHeartbeat} exceeded; route-positive ${routePositive}`,
    keyMetrics: {
      feedsQueried, nearHeartbeat, exceededHeartbeat, routePositive,
      highestAgeFeed: summary.highestAgeFeed || null,
      highestAgeSeconds: summary.highestAgeSeconds || 0,
      topRows, signedActionJustified: false,
    },
    blockers: routePositive > 0 ? ["Needs protocol-specific threshold verification and fork proof"]
      : ["No feed exceeds both Chainlink heartbeat AND any protocol-specific staleness threshold", "USDC at 13.77h is within 24h Chainlink heartbeat"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["feed exceeds Chainlink heartbeat", "feed exceeds protocol maxStalePeriod", "material market liquidity", "fork-positive proof"],
      missingBeforeAutoExec: ["protocol-specific threshold exceeded", "fork proof", "route-specific executor", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh feed age", "fresh protocol oracle config", "fresh market liquidity", "static call", "gas estimate"],
    }),
    nextReadOnlyStep: "Reopen only if any feed crosses both Chainlink heartbeat and a specific protocol's staleness threshold with material market liquidity.",
    sourceArtifacts: ["reports/raw/fast/oracle-staleness-cross-ref.json"],
  });
}

function publicLeadCandidates(protocolsBySlug, yieldLeads, mappedSlugs = new Set()) {
  const leads = [];
  for (const slug of ["aave-v4", "avalon-usda", "derive-v2", "xstocks", "solstice", "infinifi", "sky-lending", "usd-ai"]) {
    if (mappedSlugs.has(slug)) continue;
    const p = protocolsBySlug[slug];
    if (!p) continue;
    const growth = publicGrowthScore(protocolsBySlug, slug);
    leads.push(rankCandidate({
      id: `public-${slug}`,
      evaluator: "research",
      surface: `${p.name} public growth/config lead`,
      status: "research-only-not-mapped-to-executor",
      severity: "INFO",
      score: 20 + growth,
      proximity: `${round(p.change7dPct, 2)}% 7d, TVL $${round(p.tvlUsd, 0)}`,
      keyMetrics: {
        slug,
        category: p.category,
        tvlUsd: p.tvlUsd,
        change1dPct: p.change1dPct,
        change7dPct: p.change7dPct,
        chains: p.chains,
        relatedYieldLeadCount: yieldLeads.filter((y) => String(y.project || "").toLowerCase().includes(slug.split("-")[0])).length,
      },
      blockers: ["Not mapped to an executable evaluator", "Needs deployment/source review and live config scan"],
      nextReadOnlyStep: "Only escalate after a concrete on-chain invariant or route is mapped and fork-proven.",
      sourceArtifacts: ["https://api.llama.fi/protocols", "https://yields.llama.fi/pools"],
    }));
  }
  return leads;
}

function currentProfitTriageCandidate(triage) {
  const summary = triage?.summary || {};
  const watchCandidates = asNumber(summary.watchCandidates) || 0;
  const routePositive = asNumber(summary.routePositive) || 0;
  const mapped = asNumber(summary.tokensMapped) || 0;
  const erc4626 = asNumber(summary.erc4626Like) || 0;
  const compoundLike = asNumber(summary.compoundLike) || 0;
  return rankCandidate({
    id: "current-profit-public-leads",
    evaluator: "research",
    surface: "Public high-APY/growth leads mapped to token/vault semantics",
    status: routePositive > 0 ? "needs-fork-proof" : watchCandidates > 0 ? "watch-candidate-needs-fork-proof" : "mapped-no-positive-route",
    severity: routePositive > 0 ? "HIGH" : "INFO",
    score: 24 + clamp(mapped / 30, 0, 1) * 8 + clamp((erc4626 + compoundLike) / 8, 0, 1) * 8 + clamp(watchCandidates / 3, 0, 1) * 10 + (routePositive > 0 ? 15 : 0),
    proximity: `${mapped} tokens; ${erc4626} ERC4626; ${compoundLike} compound-like; ${watchCandidates} watch; ${routePositive} route-positive`,
    keyMetrics: {
      leadsScanned: summary.leadsScanned || 0,
      tokensMapped: mapped,
      erc4626Like: erc4626,
      compoundLike,
      watchCandidates,
      routePositive,
      signedActionJustified: false,
    },
    blockers: routePositive > 0 ? ["Needs route-specific fork proof and executor before any live action"] : ["No current positive NAV/market route", "No executor or artifact gate for these research leads"],
    readiness: readiness("watch-only", false, {
      requiredTrigger: ["concrete on-chain route with positive quote", "fork extraction proof", "gas/slippage/minProfit verified"],
      missingBeforeAutoExec: ["route-specific executor", "fork proof", "deployed bytecode verification", "artifact execution gate"],
      livePreflight: ["fresh token/vault reads", "fresh DEX quote", "static call", "gas estimate", "minProfit/minOut gates"],
    }),
    nextReadOnlyStep: watchCandidates > 0 ? "Fork-proof only the specific watch hint after a live DEX route quote is positive." : "Continue mapping public leads; no fork work justified by current artifact.",
    sourceArtifacts: ["reports/raw/fast/current-profit-lead-triage.json", "reports/raw/fast/current-profit-leads.json"],
  });
}

async function main() {
  const [protocols, yields] = await Promise.all([
    fetchJson("https://api.llama.fi/protocols", 30_000),
    fetchJson("https://yields.llama.fi/pools", 45_000),
  ]);

  const protocolsBySlug = protocolSummary(Array.isArray(protocols) ? protocols : []);
  const yieldLeads = yieldLeadsSummary(yields);

  const state = loadJson(FILES.state, {});
  const alerts = loadJsonl(FILES.alerts);
  const routePositiveSweep = loadJson(FILES.routePositiveSweep, {});
  const e12xRoutes = loadJson(FILES.e12xRoutes, {});
  const e2 = loadJson(FILES.e2QuoteVault, {});
  const stale = loadJson(FILES.staleOracle, {});
  const hyperlend = loadJson(FILES.hyperlend, {});
  const lorenzo = loadJson(FILES.lorenzo, {});
  const currentProfitTriage = loadJson(FILES.currentProfitTriage, {});
  const erc4626Joiner = loadJson(FILES.erc4626Joiner, {});
  const erc4626V4HookOverlaps = loadJson(FILES.erc4626V4HookOverlaps, {});
  const e15VaultDonationRoutes = loadJson(FILES.e15VaultDonationRoutes, {});
  const consumerFirstHighLtv = loadJson(FILES.consumerFirstHighLtv, {});
  const focusedMorphoReview = loadJson(FILES.focusedMorphoReview, {});
  const morphoPublicAllocatorForceFeed = loadJson(FILES.morphoPublicAllocatorForceFeed, {});
  const morphoHighApyLiquidationRoutes = loadJson(FILES.morphoHighApyLiquidationRoutes, {});
  const aaveV4Hubs = loadJson(FILES.aaveV4Hubs, {});
  const aaveV4Borrowers = loadJson(FILES.aaveV4Borrowers, {});
  const curveIbStable = loadJson(FILES.curveIbStable, {});
  const baseSyrupUsdc = loadJson(FILES.baseSyrupUsdc, {});
  const baseCadc = loadJson(FILES.baseCadc, {});
  const avalancheStableYield = loadJson(FILES.avalancheStableYield, {});
  const venusBaseWsteth = loadJson(FILES.venusBaseWsteth, {});
  const hyperliquidLinkedTokens = loadJson(FILES.hyperliquidLinkedTokens, {});
  const hyperliquidLinkedTokenConsumers = loadJson(FILES.hyperliquidLinkedTokenConsumers, {});
  const hyperliquidCoreDexDepth = loadJson(FILES.hyperliquidCoreDexDepth, {});
  const hyperevmLstLrtOracleRoutes = loadJson(FILES.hyperevmLstLrtOracleRoutes, {});
  const hyperevmLstLrtExactQuotes = loadJson(FILES.hyperevmLstLrtExactQuotes, {});
  const apyusdRedeemRoute = loadJson(FILES.apyusdRedeemRoute, {});
  const apyusdForkProof = loadJson(FILES.apyusdForkProof, {});
  const originArmGrowth = loadJson(FILES.originArmGrowth, {});
  const bridgersGrowth = loadJson(FILES.bridgersGrowth, {});
  const usdt0OftRoutes = loadJson(FILES.usdt0OftRoutes, {});
  const usdt0ConsumerRoutes = loadJson(FILES.usdt0ConsumerRoutes, {});
  const pendlePtConsumerGraph = loadJson(FILES.pendlePtConsumerGraph, {});
  const siloPtOracleRoutes = loadJson(FILES.siloPtOracleRoutes, {});
  const xstocksConsumerRoutes = loadJson(FILES.xstocksConsumerRoutes, {});
  const dexConsumerRoutes = loadJson(FILES.dexConsumerRoutes, {});
  const solanaConsumerRoutes = loadJson(FILES.solanaConsumerRoutes, {});
  const jupiterLendOracleDivergence = loadJson(FILES.jupiterLendOracleDivergence, {});
  const perpsConsumerRoutes = loadJson(FILES.perpsConsumerRoutes, {});
  const dexExitQuotes = loadJson(FILES.dexExitQuotes, {});
  const lorenzoBscSupplyWatch = loadJson(FILES.lorenzoBscSupplyWatch, {});
  const oracleStalenessCrossRef = loadJson(FILES.oracleStalenessCrossRef, {});
  const mappedPublicSlugs = existingMappedPublicSlugs();
  if (aaveV4Hubs?.generatedAt) mappedPublicSlugs.add("aave-v4");

  const candidates = [
    ...(routePositiveSweep?.generatedAt ? [routePositiveSweepCandidate(routePositiveSweep)] : []),
    lorenzoCandidate(state, lorenzo, protocolsBySlug),
    hyperlendCandidate(state, hyperlend, protocolsBySlug),
    venusBaseCandidate(state, venusBaseWsteth),
    e12xCandidate(e12xRoutes, protocolsBySlug),
    staleOracleCandidates(stale),
    liquidationCandidate(state, alerts),
    vaultDonationCandidate(state, alerts, erc4626Joiner, erc4626V4HookOverlaps, e15VaultDonationRoutes),
    ...(consumerFirstHighLtv?.generatedAt ? [consumerFirstHighLtvCandidate(consumerFirstHighLtv, focusedMorphoReview)] : []),
    ...(morphoPublicAllocatorForceFeed?.generatedAt ? [morphoPublicAllocatorForceFeedCandidate(morphoPublicAllocatorForceFeed)] : []),
    ...(morphoHighApyLiquidationRoutes?.generatedAt ? [morphoHighApyLiquidationRoutesCandidate(morphoHighApyLiquidationRoutes)] : []),
    currentProfitTriageCandidate(currentProfitTriage),
    e2QuoteVaultCandidate(e2),
    ...(aaveV4Hubs?.generatedAt ? [aaveV4HubsCandidate(aaveV4Hubs, protocolsBySlug, aaveV4Borrowers)] : []),
    ...(curveIbStable?.generatedAt ? [curveIbStableCandidate(curveIbStable)] : []),
    ...(baseSyrupUsdc?.generatedAt ? [baseSyrupUsdcCandidate(baseSyrupUsdc)] : []),
    ...(baseCadc?.generatedAt ? [baseCadcCandidate(baseCadc)] : []),
    ...(avalancheStableYield?.generatedAt ? [avalancheStableYieldCandidate(avalancheStableYield)] : []),
    ...(hyperliquidLinkedTokens?.generatedAt && !hyperliquidLinkedTokenConsumers?.generatedAt ? [hyperliquidLinkedTokensCandidate(hyperliquidLinkedTokens)] : []),
    ...(hyperliquidLinkedTokenConsumers?.generatedAt ? [hyperliquidLinkedTokenConsumersCandidate(hyperliquidLinkedTokenConsumers, hyperliquidCoreDexDepth)] : []),
    ...(hyperliquidCoreDexDepth?.generatedAt ? [hyperliquidCoreDexDepthCandidate(hyperliquidCoreDexDepth)] : []),
    ...(hyperevmLstLrtOracleRoutes?.generatedAt ? [hyperevmLstLrtOracleRoutesCandidate(hyperevmLstLrtOracleRoutes)] : []),
    ...(hyperevmLstLrtExactQuotes?.generatedAt ? [hyperevmLstLrtExactQuotesCandidate(hyperevmLstLrtExactQuotes)] : []),
    ...(apyusdForkProof?.generatedAt ? [apyusdForkProofCandidate(apyusdRedeemRoute, apyusdForkProof)] : []),
    ...(originArmGrowth?.generatedAt ? [growthMapCandidate(originArmGrowth, {
      id: "origin-arm-growth-map",
      surface: "Origin ARM growth map and ERC4626-like route joins",
      baseScore: 22,
      inputField: "armsInput",
      mappedField: "armsMapped",
      blockers: ["No watch candidates", "No route-positive consumer/exit economics"],
      requiredTrigger: ["ARM maps to liquid consumer route", "growth/share-price edge exceeds fees/gas", "fork-positive extraction proof"],
      nextReadOnlyStep: "Reopen only if ARM growth maps to a consumer route with positive exact economics.",
      sourceArtifacts: ["reports/raw/fast/origin-arm-growth-map.json", "reports/origin-arm-growth-triage.md"],
    })] : []),
    ...(bridgersGrowth?.generatedAt ? [growthMapCandidate(bridgersGrowth, {
      id: "bridgers-growth-map",
      surface: "Bridgers bridge/wrapper growth route map",
      baseScore: 22,
      inputField: "evmRowsInput",
      mappedField: "evmRowsCodePresent",
      blockers: ["No non-lossless hint tokens", "No route-positive bridge/lending consumer"],
      requiredTrigger: ["non-lossless bridge/wrapper behavior", "linked lending/DEX consumer with liquidity", "fork-positive extraction proof"],
      nextReadOnlyStep: "Reopen only if a non-lossless wrapped asset maps to a liquid consumer route.",
      sourceArtifacts: ["reports/raw/fast/bridgers-growth-map.json", "reports/bridgers-growth-triage.md"],
    })] : []),
    ...(usdt0ConsumerRoutes?.generatedAt ? [usdt0ConsumerRoutesCandidate(usdt0ConsumerRoutes, usdt0OftRoutes)] : []),
    ...(pendlePtConsumerGraph?.generatedAt ? [pendlePtConsumerCandidate(pendlePtConsumerGraph, siloPtOracleRoutes)] : []),
    ...(xstocksConsumerRoutes?.generatedAt ? [xstocksConsumerRoutesCandidate(xstocksConsumerRoutes)] : []),
    ...(dexConsumerRoutes?.generatedAt ? [dexConsumerRoutesCandidate(dexConsumerRoutes)] : []),
    ...(solanaConsumerRoutes?.generatedAt ? [solanaConsumerRoutesCandidate(solanaConsumerRoutes)] : []),
    ...(jupiterLendOracleDivergence?.generatedAt ? [jupiterLendOracleDivergenceCandidate(jupiterLendOracleDivergence)] : []),
    ...(perpsConsumerRoutes?.generatedAt ? [perpsConsumerRoutesCandidate(perpsConsumerRoutes)] : []),
    ...(dexExitQuotes?.generatedAt ? [dexExitQuotesCandidate(dexExitQuotes)] : []),
    ...(lorenzoBscSupplyWatch?.generatedAt ? [lorenzoBscSupplyWatchCandidate(lorenzoBscSupplyWatch)] : []),
    ...(oracleStalenessCrossRef?.generatedAt ? [oracleStalenessCrossRefCandidate(oracleStalenessCrossRef)] : []),
    ...publicLeadCandidates(protocolsBySlug, yieldLeads, mappedPublicSlugs),
  ].sort((a, b) => (b.executableNow - a.executableNow) || (b.score - a.score) || (severityRank(b.severity) - severityRank(a.severity)));

  const ranked = candidates.map((candidate, idx) => ({ rank: idx + 1, ...candidate }));
  const out = {
    generatedAt: new Date().toISOString(),
    scope: "Cross-evaluator read-only proximity ranking",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      signedActionJustified: ranked.some((r) => r.signedActionJustified === true),
    },
    sourceArtifacts: Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, path.relative(WORKSPACE, v)])),
    publicSignals: {
      protocolsAvailable: Array.isArray(protocols),
      yieldsAvailable: Boolean(yields?.data),
      trackedProtocols: protocolsBySlug,
      topRelatedYieldLeads: yieldLeads.slice(0, 12),
    },
    summary: {
      rankedCount: ranked.length,
      executableNowCount: ranked.filter((r) => r.executableNow).length,
      criticalCount: ranked.filter((r) => r.severity === "CRITICAL").length,
      highCount: ranked.filter((r) => r.severity === "HIGH").length,
      topSurface: ranked[0]?.id || null,
      signedActionJustified: ranked.some((r) => r.signedActionJustified === true),
    },
    ranked,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const persisted = forceMonitorOnlyArtifact(out);
  fs.writeFileSync(OUT, `${JSON.stringify(persisted, null, 2)}\n`);

  if (!QUIET) {
    console.log(`Wrote ${path.relative(WORKSPACE, OUT)}`);
    console.log(`Ranked ${ranked.length} surfaces; executableNow=${out.summary.executableNowCount}; signedActionJustified=${out.summary.signedActionJustified}`);
    for (const row of ranked.slice(0, 8)) {
      console.log(`#${row.rank} ${row.evaluator} ${row.id} score=${row.score} status=${row.status} proximity=${row.proximity}`);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err?.message || String(err));
    process.exit(1);
  });
}

module.exports = { rankCandidate, readiness, forceMonitorOnlyArtifact };
