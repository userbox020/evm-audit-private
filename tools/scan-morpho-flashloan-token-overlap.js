#!/usr/bin/env node
// Artifact-only Morpho 0-fee flashLoan overlap ranker.
// Reads existing route/consumer artifacts, does not resolve RPC, read env files, or send transactions.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "morpho-flashloan-token-overlap.json");
const QUIET = process.argv.includes("--quiet");

const FILES = {
  lrtRoutes: path.join(RAW_DIR, "lrt-oracle-drift-routes.json"),
  premiumProbe: path.join(RAW_DIR, "lrt-oracle-premium-probe.json"),
  consumerFirst: path.join(RAW_DIR, "consumer-first-high-ltv-collateral.json"),
  aesConsumerGraph: path.join(RAW_DIR, "aave-euler-silo-consumer-graph.json"),
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

function tokenKey(token) {
  return addr(token?.address || token) || null;
}

function tokenLabel(token) {
  if (!token) return "unknown";
  const symbol = token.symbol || token.name || "token";
  const address = token.address || token;
  return `${symbol}:${String(address).slice(0, 10)}`;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function collectMorphoRows(lrtRoutes) {
  const rows = [...(lrtRoutes.rows || []), ...(lrtRoutes.topRows || [])]
    .filter((row) => row?.protocol === "Morpho Blue")
    .filter((row) => row.marketId && tokenKey(row.borrowAsset) && tokenKey(row.collateral));
  return uniqueBy(rows, (row) => row.marketId.toLowerCase()).map((row) => ({
    protocol: "Morpho Blue",
    chainId: 1,
    chain: "Ethereum",
    marketId: row.marketId,
    oracle: row.oracle || null,
    collateral: row.collateral,
    loanAsset: row.borrowAsset,
    lltv: asNumber(row.lltv),
    routeLiquidityUsd: round(row.routeLiquidityUsd, 2),
    supplyUsd: round(row.supplyUsd, 2),
    utilization: round(row.utilization, 6),
    upstreamWatchCandidate: Boolean(row.watchCandidate),
    upstreamRoutePositive: Boolean(row.routePositive),
  }));
}

function premiumMap(premiumProbe) {
  const flashFeeBps = asNumber(premiumProbe?.config?.flashFeeBps) || 0;
  const rows = [...(premiumProbe.rows || []), ...(premiumProbe.topRows || [])];
  const map = new Map();
  for (const row of rows) {
    if (!row?.marketId) continue;
    const economics = row.economics || {};
    const required = asNumber(economics.requiredPremiumBps);
    const premium = asNumber(row.premiumBps);
    const zeroFeeRequired = required === null ? null : Math.max(0, required - flashFeeBps);
    map.set(row.marketId.toLowerCase(), {
      oraclePrice: round(row.oraclePrice, 12),
      marketRatio: round(row.marketRatio, 12),
      premiumBps: round(premium, 4),
      requiredPremiumBps: round(required, 4),
      zeroFeeRequiredPremiumBps: round(zeroFeeRequired, 4),
      premiumGapBps: premium === null || required === null ? null : round(required - premium, 4),
      zeroFeePremiumGapBps: premium === null || zeroFeeRequired === null ? null : round(zeroFeeRequired - premium, 4),
      preforkPremiumPositive: Boolean(row.preforkPremiumPositive),
      estimatedNetUsd: round(economics.estimatedNetUsd, 6),
      flashFeeBps,
      probeStatus: row.probeStatus || null,
    });
  }
  return map;
}

function pushOverlap(index, tokenAddress, overlap) {
  const key = addr(tokenAddress);
  if (!key) return;
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(overlap);
}

function collectConsumerFirst(index, artifact) {
  for (const result of artifact.results || []) {
    for (const row of result.highLtvRowsDetail || []) {
      const base = {
        source: "consumer-first-high-ltv-collateral",
        protocol: row.protocol || row.consumer?.protocol || "unknown",
        chainId: row.chainId,
        chain: row.chain,
        marketId: row.consumer?.marketId || row.marketId || null,
        ltv: round(row.ltv, 6),
        routeLiquidityUsd: round(row.routeLiquidityUsd, 2),
        supplyAssetsUsd: round(row.supplyAssetsUsd, 2),
        borrowAssetsUsd: round(row.borrowAssetsUsd, 2),
        utilization: round(row.utilization, 6),
        riskTags: row.riskTags || [],
        watchCandidate: Boolean(row.watchCandidate),
        routePositive: Boolean(row.routePositive),
      };
      pushOverlap(index, row.collateral?.address || row.consumer?.collateralAsset?.address, { ...base, side: "collateralAsset", token: row.collateral || row.consumer?.collateralAsset });
      pushOverlap(index, row.borrowAsset?.address || row.consumer?.loanAsset?.address, { ...base, side: "borrowAsset", token: row.borrowAsset || row.consumer?.loanAsset });
    }
  }
}

function collectAes(index, artifact) {
  for (const result of artifact.results || []) {
    for (const match of result.topMatches || []) {
      const market = match.market || {};
      const producer = match.producer || {};
      const base = {
        source: "aave-euler-silo-consumer-graph",
        protocol: match.protocol || market.protocol || "unknown",
        side: match.side || "unknown",
        chainId: producer.chainId || result.chainId || null,
        chain: producer.chain || result.chain || null,
        marketId: market.marketId || market.evault || market.silo || market.pool || null,
        ltv: round(market.ltv ?? market.maxLtv ?? market.borrowLtv, 6),
        routeLiquidityUsd: round(market.cashUsd ?? market.otherReserveCashUsd ?? market.borrowCashUsd, 2),
        cashUsd: round(market.cashUsd, 2),
        borrowCashUsd: round(market.borrowCashUsd, 2),
        active: market.active ?? null,
        borrowingEnabled: market.borrowingEnabled ?? null,
        paused: market.paused ?? null,
        watchCandidate: Boolean(match.watchCandidate),
        routePositive: Boolean(match.routePositive),
      };
      pushOverlap(index, producer.address, { ...base, token: { symbol: producer.symbol, address: producer.address } });
      pushOverlap(index, market.reserve || market.asset || market.borrowAsset || market.collateralToken, { ...base, side: base.side, token: { symbol: market.symbol, address: market.reserve || market.asset || market.borrowAsset || market.collateralToken } });
    }
  }
}

function dedupeOverlaps(overlaps) {
  return uniqueBy(overlaps, (row) => [row.source, row.protocol, row.side, row.marketId, tokenKey(row.token)].join(":"));
}

function classify(row, premium, loanOverlaps, collateralOverlaps) {
  const routeLiquidityUsd = asNumber(row.routeLiquidityUsd) || 0;
  const lltv = asNumber(row.lltv) || 0;
  const overlapCount = loanOverlaps.length + collateralOverlaps.length;
  const zeroFeeGap = asNumber(premium?.zeroFeePremiumGapBps);
  const score = Math.round(
    Math.min(45, routeLiquidityUsd / 1_000_000 * 6)
    + Math.min(20, lltv * 20)
    + Math.min(25, overlapCount * 4)
    + Math.max(-20, Math.min(15, -1 * ((zeroFeeGap ?? 2000) / 100)))
    + (premium?.preforkPremiumPositive ? 50 : 0)
  );

  const blockerSet = new Set();
  if (!loanOverlaps.length) blockerSet.add("No external consumer overlap found for Morpho loan/flash asset in current artifacts");
  if (!collateralOverlaps.length) blockerSet.add("No external consumer overlap found for Morpho collateral token in current artifacts");
  if (!premium) blockerSet.add("No oracle-premium probe row for this market");
  if (premium && !premium.preforkPremiumPositive) blockerSet.add("Oracle premium does not clear LLTV break-even even after removing external flash-fee bps");
  blockerSet.add("No exact cross-protocol borrow/deposit/unwind route quote");
  blockerSet.add("No fork extraction proof");
  blockerSet.add("Existing FlashLiquidateMorpho source uses Balancer flash loans; Morpho zero-fee flashLoan executor is not wired");

  return {
    priorityScore: score,
    protocol: row.protocol,
    chain: row.chain,
    marketId: row.marketId,
    oracle: row.oracle,
    flashLoanAsset: row.loanAsset,
    collateral: row.collateral,
    lltv: row.lltv,
    routeLiquidityUsd: row.routeLiquidityUsd,
    supplyUsd: row.supplyUsd,
    utilization: row.utilization,
    premium: premium || null,
    overlaps: {
      loanAsset: loanOverlaps.slice(0, 12),
      collateral: collateralOverlaps.slice(0, 12),
      total: overlapCount,
    },
    watchCandidate: overlapCount > 0 && routeLiquidityUsd >= 50_000,
    routePositive: false,
    executableNow: false,
    signedActionJustified: false,
    blockers: [...blockerSet],
  };
}

function main() {
  const lrtRoutes = readJson(FILES.lrtRoutes);
  const premiumProbe = readJson(FILES.premiumProbe);
  const consumerFirst = readJson(FILES.consumerFirst);
  const aesConsumerGraph = readJson(FILES.aesConsumerGraph);

  const morphoRows = collectMorphoRows(lrtRoutes);
  const premiums = premiumMap(premiumProbe);
  const overlapIndex = new Map();
  collectConsumerFirst(overlapIndex, consumerFirst);
  collectAes(overlapIndex, aesConsumerGraph);

  const rows = morphoRows.map((row) => {
    const loanOverlaps = dedupeOverlaps(overlapIndex.get(tokenKey(row.loanAsset)) || []);
    const collateralOverlaps = dedupeOverlaps(overlapIndex.get(tokenKey(row.collateral)) || []);
    return classify(row, premiums.get(row.marketId.toLowerCase()), loanOverlaps, collateralOverlaps);
  }).sort((a, b) => b.priorityScore - a.priorityScore || (b.routeLiquidityUsd || 0) - (a.routeLiquidityUsd || 0));

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-morpho-flashloan-token-overlap.js",
    scope: "Artifact-only Morpho 0-fee flashLoan token-overlap ranking against existing consumer graphs",
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
    summary: {
      morphoRows: morphoRows.length,
      rankedRows: rows.length,
      rowsWithAnyOverlap: rows.filter((row) => row.overlaps.total > 0).length,
      rowsWithLoanAssetOverlap: rows.filter((row) => row.overlaps.loanAsset.length > 0).length,
      rowsWithCollateralOverlap: rows.filter((row) => row.overlaps.collateral.length > 0).length,
      watchCandidates: rows.filter((row) => row.watchCandidate).length,
      preforkPremiumPositiveRows: rows.filter((row) => row.premium?.preforkPremiumPositive).length,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      blocker: "Overlaps are leads only; no row has exact cross-protocol route economics or fork proof",
    },
    topRows: rows.slice(0, 25),
    rows,
    nextRoutePositiveCriteria: [
      "Morpho flashLoan asset is available with enough same-block liquidity",
      "overlapped consumer accepts the same asset/collateral in an unpaused public path",
      "accepted value exceeds acquisition/reference value after LTV/LLTV and zero flash fee",
      "exact unwind quote is positive after gas/slippage/caps",
      "fork proof demonstrates positive net extraction",
    ],
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Morpho flashLoan overlap: rows=${artifact.summary.rankedRows} overlaps=${artifact.summary.rowsWithAnyOverlap} watch=${artifact.summary.watchCandidates} routePositive=0`);
  if (!QUIET) console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main();
