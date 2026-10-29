#!/usr/bin/env node
// Read-only Hyperliquid linked-token consumer join scanner.
// Joins linked HyperCore<>HyperEVM token invariants to public DEX/yield/lending consumers.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-linked-token-consumers.json");

const FILES = {
  linked: path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-linked-token-invariants.json"),
  hyperlend: path.join(WORKSPACE, "reports", "raw", "fast", "hyperlend-live.json"),
  monitorState: path.join(WORKSPACE, "reports", "monitor", "state.json"),
  termmaxMarkets: path.join(WORKSPACE, "targets", "termmax", "script", "deploy", "deploydata", "hyperevm-mainnet-markets.json"),
  termmaxMarkets2: path.join(WORKSPACE, "targets", "termmax-contract-v2", "script", "deploy", "deploydata", "hyperevm-mainnet-markets.json"),
};

const MIN_ROUTE_EDGE_BPS = Number(process.env.HYPERLIQUID_CONSUMER_MIN_ROUTE_EDGE_BPS || "100");
const MIN_DEX_LIQUIDITY_USD = Number(process.env.HYPERLIQUID_CONSUMER_MIN_DEX_LIQUIDITY_USD || "10000");
const MIN_BORROW_CASH_USD = Number(process.env.HYPERLIQUID_CONSUMER_MIN_BORROW_CASH_USD || "10000");
const WATCH_ONLY_FIRST = Number(process.env.HYPERLIQUID_CONSUMER_REVIEW_LIMIT || "120");
const DEX_BATCH = Number(process.env.HYPERLIQUID_CONSUMER_DEX_BATCH || "30");
const TIMEOUT_MS = Number(process.env.HYPERLIQUID_CONSUMER_TIMEOUT_MS || "30000");

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

function symbolKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function bps(a, b) {
  const x = asNumber(a);
  const y = asNumber(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0) return null;
  return ((x - y) / y) * 10_000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLlamaYields() {
  try {
    const data = await fetchJson("https://yields.llama.fi/pools", 45_000);
    return Array.isArray(data?.data) ? data.data : [];
  } catch (_) {
    return [];
  }
}

async function fetchDexPairs(addresses) {
  const out = new Map();
  const unique = [...new Set(addresses.map(norm).filter(Boolean))];
  for (let i = 0; i < unique.length; i += DEX_BATCH) {
    const batch = unique.slice(i, i + DEX_BATCH);
    try {
      const data = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(",")}`, 45_000);
      for (const pair of Array.isArray(data?.pairs) ? data.pairs : []) {
        if (!pair || typeof pair !== "object") continue;
        const base = norm(pair.baseToken?.address);
        const quote = norm(pair.quoteToken?.address);
        for (const token of [base, quote]) {
          if (!token) continue;
          if (!out.has(token)) out.set(token, []);
          out.get(token).push(pair);
        }
      }
    } catch (_) {
      for (const token of batch) if (!out.has(token)) out.set(token, []);
    }
    await sleep(350);
  }
  return out;
}

function linkedRowsByAddress(linked) {
  const rows = Array.isArray(linked?.rows) ? linked.rows : [];
  const byAddress = new Map();
  const bySymbol = new Map();
  for (const row of rows) {
    const address = norm(row?.token?.evmContract);
    const symbol = symbolKey(row?.token?.name || row?.evm?.symbol);
    if (address) byAddress.set(address, row);
    if (symbol) {
      if (!bySymbol.has(symbol)) bySymbol.set(symbol, []);
      bySymbol.get(symbol).push(row);
    }
  }
  return { rows, byAddress, bySymbol };
}

function corePrice(row) {
  return asNumber(row?.hyperCoreDetails?.midPx) ?? asNumber(row?.hyperCoreDetails?.markPx) ?? asNumber(row?.spotMarkets?.[0]?.ctx?.midPx) ?? asNumber(row?.spotMarkets?.[0]?.ctx?.markPx);
}

function dexJoins(row, dexByAddress) {
  const address = norm(row?.token?.evmContract);
  const pairs = (dexByAddress.get(address) || [])
    .filter((pair) => pair?.chainId && /hyper/i.test(pair.chainId))
    .map((pair) => {
      const dexPrice = asNumber(pair.priceUsd);
      const reference = corePrice(row);
      const edgeBps = bps(dexPrice, reference);
      const liquidityUsd = asNumber(pair.liquidity?.usd);
      const researchPositive = Boolean(edgeBps !== null && Math.abs(edgeBps) >= MIN_ROUTE_EDGE_BPS && liquidityUsd >= MIN_DEX_LIQUIDITY_USD);
      return {
        protocol: pair.dexId || "DexScreener",
        consumerType: "dex-pair",
        chainId: pair.chainId || null,
        pairAddress: pair.pairAddress || null,
        baseToken: pair.baseToken || null,
        quoteToken: pair.quoteToken || null,
        priceUsd: dexPrice,
        referenceCorePriceUsd: reference,
        dexVsCoreBps: edgeBps === null ? null : round(edgeBps, 2),
        liquidityUsd: round(liquidityUsd, 2),
        volume24hUsd: round(asNumber(pair.volume?.h24), 2),
        url: pair.url || null,
        watchCandidate: Boolean(liquidityUsd >= MIN_DEX_LIQUIDITY_USD || Math.abs(edgeBps || 0) >= MIN_ROUTE_EDGE_BPS),
        researchPositive,
        routePositive: false,
        blockers: [
          edgeBps === null ? "missing core-vs-DEX price comparison" : Math.abs(edgeBps) < MIN_ROUTE_EDGE_BPS ? "core-vs-DEX spread below route threshold" : null,
          liquidityUsd < MIN_DEX_LIQUIDITY_USD ? "DEX liquidity below route threshold" : null,
          researchPositive ? "raw Core-vs-DEX spread is research-only until exact HyperCore order-book depth, transfer timing, fees, and executable quote are proven" : null,
        ].filter(Boolean),
      };
    });
  return pairs;
}

function hyperlendJoins(row, hyperlend, linkedByAddress) {
  const address = norm(row?.token?.evmContract);
  const out = [];
  const reserves = Array.isArray(hyperlend?.coreReserves) ? hyperlend.coreReserves : [];
  const borrowReserves = reserves.filter((r) => r.active && !r.paused && r.borrowingEnabled && asNumber(r.cashUsd) > 0);
  for (const reserve of reserves) {
    if (norm(reserve.token) !== address) continue;
    const marketPrice = corePrice(row);
    const borrowablePerTokenUsd = asNumber(reserve.priceUsd) * (asNumber(reserve.ltv) || 0) / 100;
    const bestBorrowCashUsd = Math.max(0, ...borrowReserves.map((r) => asNumber(r.cashUsd) || 0));
    const edgeBps = bps(borrowablePerTokenUsd, marketPrice);
    const researchPositive = Boolean(edgeBps !== null && edgeBps >= MIN_ROUTE_EDGE_BPS && bestBorrowCashUsd >= MIN_BORROW_CASH_USD && asNumber(reserve.ltv) > 0);
    out.push({
      protocol: "HyperLend",
      consumerType: "lending-reserve",
      token: reserve.token,
      symbol: reserve.symbol,
      ltv: reserve.ltv,
      liquidationThreshold: reserve.liquidationThreshold,
      active: reserve.active,
      borrowingEnabled: reserve.borrowingEnabled,
      paused: reserve.paused,
      oraclePriceUsd: reserve.priceUsd,
      coreReferencePriceUsd: marketPrice,
      borrowablePerTokenUsd: round(borrowablePerTokenUsd, 8),
      borrowableVsCoreBps: edgeBps === null ? null : round(edgeBps, 2),
      bestBorrowCashUsd: round(bestBorrowCashUsd, 2),
      cashUsd: round(reserve.cashUsd, 2),
      oracleFeedAgeSeconds: reserve.oracleFeedAgeSeconds ?? null,
      oracleVsRefPct: reserve.oracleVsRefPct ?? null,
      watchCandidate: Boolean(asNumber(reserve.ltv) > 0 || asNumber(reserve.cashUsd) >= MIN_BORROW_CASH_USD),
      researchPositive,
      routePositive: false,
      blockers: [
        asNumber(reserve.ltv) <= 0 ? "collateral LTV is zero" : null,
        edgeBps === null ? "missing market/core reference for borrow route" : edgeBps < MIN_ROUTE_EDGE_BPS ? "LTV-adjusted borrowable value below route threshold" : null,
        bestBorrowCashUsd < MIN_BORROW_CASH_USD ? "borrow liquidity below route threshold" : null,
        researchPositive ? "lending edge is research-only until exact acquisition, borrow, exit, gas, and fork proof are modeled" : null,
      ].filter(Boolean),
      linkedTokenMatch: linkedByAddress.has(norm(reserve.token)),
    });
  }
  return out;
}

function yieldJoins(row, yields) {
  const sym = symbolKey(row?.token?.name || row?.evm?.symbol);
  const address = norm(row?.token?.evmContract);
  if (!sym && !address) return [];
  return yields
    .filter((pool) => /hyperliquid|hyperevm/i.test(pool.chain || ""))
    .filter((pool) => {
      const poolSymbol = symbolKey(pool.symbol);
      const underlying = Array.isArray(pool.underlyingTokens) ? pool.underlyingTokens.map(norm).filter(Boolean) : [];
      return (sym && poolSymbol.split(/[-_/]/).some((part) => part === sym)) || underlying.includes(address);
    })
    .slice(0, 20)
    .map((pool) => ({
      protocol: pool.project,
      consumerType: "defillama-yield-pool",
      chain: pool.chain,
      symbol: pool.symbol,
      pool: pool.pool,
      tvlUsd: round(asNumber(pool.tvlUsd), 2),
      apy: round(asNumber(pool.apy), 4),
      apyBase: round(asNumber(pool.apyBase), 4),
      apyReward: round(asNumber(pool.apyReward), 4),
      stablecoin: pool.stablecoin ?? null,
      ilRisk: pool.ilRisk ?? null,
      watchCandidate: Boolean(asNumber(pool.tvlUsd) >= MIN_DEX_LIQUIDITY_USD),
      routePositive: false,
      blockers: ["yield pool is not an extraction route without borrow/redeem/DEX leg", "needs protocol-specific source/runtime mapping"],
    }));
}

function flattenTermmaxConfigs(termmax) {
  const configs = termmax?.configs && typeof termmax.configs === "object" ? Object.values(termmax.configs) : [];
  return configs.filter(Boolean);
}

function termmaxJoins(row, termmaxFiles) {
  const address = norm(row?.token?.evmContract);
  const out = [];
  for (const [source, data] of termmaxFiles) {
    for (const cfg of flattenTermmaxConfigs(data)) {
      const underlying = norm(cfg?.underlyingConfig?.tokenAddr);
      const collateral = norm(cfg?.collateralConfig?.tokenAddr);
      if (underlying !== address && collateral !== address) continue;
      out.push({
        protocol: "TermMax",
        consumerType: underlying === address ? "termmax-underlying" : "termmax-collateral",
        source,
        marketName: cfg.marketName || null,
        marketSymbol: cfg.marketSymbol || null,
        maturity: cfg.marketConfig?.maturity || null,
        maxLtv: cfg.loanConfig?.maxLtv ? Number(cfg.loanConfig.maxLtv) / 1e6 : null,
        liquidationLtv: cfg.loanConfig?.liquidationLtv ? Number(cfg.loanConfig.liquidationLtv) / 1e6 : null,
        liquidatable: cfg.loanConfig?.liquidatable ?? null,
        tokenRole: underlying === address ? "underlying" : "collateral",
        watchCandidate: true,
        routePositive: false,
        blockers: ["local deployment config only", "needs live market balances/orderbook and oracle reads"],
      });
    }
  }
  return out;
}

function rankRow(row, joins) {
  const routePositive = joins.some((j) => j.routePositive);
  const researchPositive = joins.some((j) => j.researchPositive);
  const watchCandidate = row.watchCandidate || joins.some((j) => j.watchCandidate);
  const maxDexLiquidity = Math.max(0, ...joins.map((j) => asNumber(j.liquidityUsd) || 0));
  const maxYieldTvl = Math.max(0, ...joins.map((j) => asNumber(j.tvlUsd) || 0));
  const maxBorrowCash = Math.max(0, ...joins.map((j) => asNumber(j.bestBorrowCashUsd) || 0));
  const maxAbsEdgeBps = Math.max(0, ...joins.map((j) => Math.abs(asNumber(j.dexVsCoreBps ?? j.borrowableVsCoreBps) || 0)));
  return {
    score: Math.round((row.watchCandidate ? 15 : 0) + Math.min(20, joins.length * 3) + Math.min(15, Math.log10(Math.max(1, maxDexLiquidity + maxYieldTvl + maxBorrowCash))) + Math.min(20, maxAbsEdgeBps / 10) + (researchPositive ? 8 : 0) + (routePositive ? 40 : 0)),
    watchCandidate,
    researchPositive,
    routePositive,
    maxDexLiquidity,
    maxYieldTvl,
    maxBorrowCash,
    maxAbsEdgeBps,
  };
}

function summarizeDiagnostics(linked, joinedRows, routePositiveRows) {
  const invariantWatchCandidates = asNumber(linked?.summary?.watchCandidates) || 0;
  const invariantReviewCandidates = asNumber(linked?.summary?.reviewCandidates) || 0;
  const dexJoins = joinedRows.flatMap((row) => row.joins.filter((j) => j.consumerType === "dex-pair"));
  const yieldJoins = joinedRows.flatMap((row) => row.joins.filter((j) => j.consumerType === "defillama-yield-pool"));
  const hyperlendJoins = joinedRows.flatMap((row) => row.joins.filter((j) => j.protocol === "HyperLend"));
  const researchRows = joinedRows.filter((row) => row.researchPositive);
  const maxByMetric = (rows, fn) => rows.reduce((best, row) => {
    const value = Number(fn(row) || 0);
    return value > Number(best?.value || 0) ? { row, value } : best;
  }, null);
  const maxDex = maxByMetric(joinedRows, (row) => row.metrics.maxDexLiquidityUsd);
  const maxYield = maxByMetric(joinedRows, (row) => row.metrics.maxYieldTvlUsd);
  const maxBorrow = maxByMetric(joinedRows, (row) => row.metrics.maxBorrowCashUsd);
  const maxEdge = maxByMetric(joinedRows, (row) => row.metrics.maxAbsEdgeBps);
  return {
    invariantWatchCandidates,
    invariantReviewCandidates,
    invariantWatchRowsJoined: joinedRows.filter((row) => row.invariant.watchCandidate).length,
    invariantCriticalRowsJoined: joinedRows.filter((row) => row.invariant.criticalFlags.length > 0).length,
    dexResearchPositiveJoins: dexJoins.filter((join) => join.researchPositive).length,
    hyperlendResearchPositiveJoins: hyperlendJoins.filter((join) => join.researchPositive).length,
    yieldWatchJoins: yieldJoins.filter((join) => join.watchCandidate).length,
    routePositiveRows: routePositiveRows.length,
    maxDexLiquidityUsd: round(maxDex?.value, 2),
    maxDexLiquidityToken: maxDex?.row?.token?.name || null,
    maxYieldTvlUsd: round(maxYield?.value, 2),
    maxYieldTvlToken: maxYield?.row?.token?.name || null,
    maxBorrowCashUsd: round(maxBorrow?.value, 2),
    maxBorrowCashToken: maxBorrow?.row?.token?.name || null,
    maxAbsEdgeBps: round(maxEdge?.value, 2),
    maxAbsEdgeToken: maxEdge?.row?.token?.name || null,
    topResearchTokens: researchRows.slice(0, 10).map((row) => ({
      token: row.token?.name || null,
      score: row.score,
      maxDexLiquidityUsd: row.metrics.maxDexLiquidityUsd,
      maxYieldTvlUsd: row.metrics.maxYieldTvlUsd,
      maxBorrowCashUsd: row.metrics.maxBorrowCashUsd,
      maxAbsEdgeBps: row.metrics.maxAbsEdgeBps,
    })),
  };
}

async function main() {
  const linked = readJson(FILES.linked, {});
  const hyperlend = readJson(FILES.hyperlend, {});
  const termmaxFiles = [
    [path.relative(WORKSPACE, FILES.termmaxMarkets), readJson(FILES.termmaxMarkets, null)],
    [path.relative(WORKSPACE, FILES.termmaxMarkets2), readJson(FILES.termmaxMarkets2, null)],
  ].filter(([, data]) => data);
  const { rows, byAddress } = linkedRowsByAddress(linked);
  const candidateRows = rows
    .filter((row) => row.watchCandidate || row.reviewCandidate)
    .sort((a, b) => (b.watchCandidate - a.watchCandidate) || ((b.criticalFlags?.length || 0) - (a.criticalFlags?.length || 0)))
    .slice(0, WATCH_ONLY_FIRST);
  const yields = await fetchLlamaYields();
  const dexByAddress = await fetchDexPairs(candidateRows.map((row) => row?.token?.evmContract));

  const joined = candidateRows.map((row) => {
    const joins = [
      ...hyperlendJoins(row, hyperlend, byAddress),
      ...yieldJoins(row, yields),
      ...dexJoins(row, dexByAddress),
      ...termmaxJoins(row, termmaxFiles),
    ];
    const rank = rankRow(row, joins);
    return {
      token: row.token,
      invariant: {
        watchCandidate: row.watchCandidate,
        reviewCandidate: row.reviewCandidate,
        criticalFlags: row.criticalFlags || [],
        flags: row.flags || [],
        corePriceUsd: corePrice(row),
        evmDecimals: row.evm?.decimals ?? null,
        expectedEvmDecimals: row.token?.expectedEvmDecimals ?? null,
      },
      joins,
      score: rank.score,
      watchCandidate: rank.watchCandidate,
      researchPositive: rank.researchPositive,
      routePositive: rank.routePositive,
      metrics: {
        joinCount: joins.length,
        maxDexLiquidityUsd: round(rank.maxDexLiquidity, 2),
        maxYieldTvlUsd: round(rank.maxYieldTvl, 2),
        maxBorrowCashUsd: round(rank.maxBorrowCash, 2),
        maxAbsEdgeBps: round(rank.maxAbsEdgeBps, 2),
      },
      blockers: rank.routePositive ? [] : [
        joins.length === 0 ? "no consumer join found" : null,
        joins.some((j) => j.researchPositive) ? "raw spread/liquidity hints are research-only until exact executable quotes and HyperCore depth are proven" : null,
        !joins.some((j) => j.routePositive) ? "no joined consumer route has executable positive economics" : null,
        "fork proof blocked until routePositive > 0",
      ].filter(Boolean),
    };
  }).sort((a, b) => (b.routePositive - a.routePositive) || (b.watchCandidate - a.watchCandidate) || (b.score - a.score));

  const joinedRows = joined.filter((row) => row.joins.length > 0);
  const watchRows = joined.filter((row) => row.watchCandidate && row.joins.length > 0);
  const routePositiveRows = joined.filter((row) => row.routePositive);
  const researchPositiveRows = joined.filter((row) => row.researchPositive);
  const diagnostics = summarizeDiagnostics(linked, joinedRows, routePositiveRows);
  const out = {
    generatedAt: new Date().toISOString(),
    scope: "Hyperliquid linked-token consumer graph join",
    safety: {
      publicApiOnly: true,
      directRpcCalls: false,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    sourceArtifacts: {
      linkedTokenInvariants: path.relative(WORKSPACE, FILES.linked),
      hyperlend: path.relative(WORKSPACE, FILES.hyperlend),
      termmaxMarkets: termmaxFiles.map(([source]) => source),
      publicYields: "https://yields.llama.fi/pools",
      publicDex: "https://api.dexscreener.com/latest/dex/tokens/{addresses}",
    },
    thresholds: {
      minRouteEdgeBps: MIN_ROUTE_EDGE_BPS,
      minDexLiquidityUsd: MIN_DEX_LIQUIDITY_USD,
      minBorrowCashUsd: MIN_BORROW_CASH_USD,
      reviewLimit: WATCH_ONLY_FIRST,
    },
    summary: {
      linkedTokensInput: rows.length,
      candidateRowsScanned: candidateRows.length,
      joinedRows: joinedRows.length,
      consumerJoins: joinedRows.reduce((sum, row) => sum + row.joins.length, 0),
      hyperlendJoins: joinedRows.reduce((sum, row) => sum + row.joins.filter((j) => j.protocol === "HyperLend").length, 0),
      yieldJoins: joinedRows.reduce((sum, row) => sum + row.joins.filter((j) => j.consumerType === "defillama-yield-pool").length, 0),
      dexJoins: joinedRows.reduce((sum, row) => sum + row.joins.filter((j) => j.consumerType === "dex-pair").length, 0),
      termmaxJoins: joinedRows.reduce((sum, row) => sum + row.joins.filter((j) => j.protocol === "TermMax").length, 0),
      researchPositiveRows: researchPositiveRows.length,
      researchPositiveJoins: joinedRows.reduce((sum, row) => sum + row.joins.filter((j) => j.researchPositive).length, 0),
      watchCandidates: watchRows.length,
      routePositive: routePositiveRows.length,
      signedActionJustified: false,
      diagnostics,
    },
    topRows: joined.slice(0, 25).map((row) => ({
      token: row.token?.name,
      index: row.token?.index,
      evmContract: row.token?.evmContract,
      score: row.score,
      watchCandidate: row.watchCandidate,
      researchPositive: row.researchPositive,
      routePositive: row.routePositive,
      metrics: row.metrics,
      invariantCriticalFlags: row.invariant.criticalFlags,
      joinTypes: row.joins.map((j) => `${j.protocol}:${j.consumerType}`).slice(0, 10),
      blockers: row.blockers,
    })),
    rows: joined,
  };

  ensureDir(OUT);
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Wrote ${path.relative(WORKSPACE, OUT)}`);
  console.log(`Hyperliquid consumer join: joinedRows=${out.summary.joinedRows}; watchCandidates=${out.summary.watchCandidates}; routePositive=${out.summary.routePositive}; dexJoins=${out.summary.dexJoins}; yieldJoins=${out.summary.yieldJoins}; hyperlendJoins=${out.summary.hyperlendJoins}`);
  for (const row of out.topRows.slice(0, 8)) console.log(`# ${row.token} joins=${row.joinTypes.join(",") || "none"} routePositive=${row.routePositive} score=${row.score}`);
}

main().catch((err) => {
  console.error(String(err?.message || err).replace(/https?:\/\/\S+/g, "[redacted-url]"));
  process.exit(1);
});
