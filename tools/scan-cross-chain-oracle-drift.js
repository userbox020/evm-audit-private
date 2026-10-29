#!/usr/bin/env node
// Artifact-only cross-chain oracle drift consolidator.
// Does not read endpoint inventories, .env files, keys, or send transactions.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "cross-chain-oracle-drift.json");
const MD_OUT = path.join(WORKSPACE, "reports", "cross-chain-oracle-drift-triage.md");
const QUIET = process.argv.includes("--quiet");

function argNumber(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (!arg) return fallback;
  const n = Number(arg.slice(prefix.length));
  return Number.isFinite(n) ? n : fallback;
}

const CONFIG = {
  minMaterialPriceGapBps: argNumber("min-price-gap-bps", 50),
  minMaterialAgeGapSeconds: argNumber("min-age-gap-seconds", 300),
  minBorrowLiquidityUsd: argNumber("min-borrow-liquidity-usd", 10_000),
  maxRows: argNumber("max-rows", 500),
  topRows: argNumber("top-rows", 25),
};

const INPUT_DEFS = [
  { key: "crossChainStaleness", rel: "reports/raw/fast/cross-chain-chainlink-staleness.json", role: "cross-chain feed price/staleness rows" },
  { key: "crossChainPriceDiscrepancy", rel: "reports/raw/fast/cross-chain-price-discrepancy.json", role: "cross-chain Chainlink price discrepancy rows" },
  { key: "oracleStalenessCrossRef", rel: "reports/raw/fast/oracle-staleness-cross-ref.json", role: "single-chain feed staleness/protocol cross-reference" },
  { key: "lrtOracleDriftRoutes", rel: "reports/raw/fast/lrt-oracle-drift-routes.json", role: "LST/LRT lending oracle drift consumer context" },
  { key: "lrtOraclePremiumProbe", rel: "reports/raw/fast/lrt-oracle-premium-probe.json", role: "LST/LRT oracle premium economics context", optional: true },
  { key: "stablecoinDepegLendingRoutes", rel: "reports/raw/fast/stablecoin-depeg-lending-routes.json", role: "stablecoin depeg lending consumer context" },
  { key: "hyperevmLstLrtOracleRoutes", rel: "reports/raw/fast/hyperevm-lst-lrt-oracle-routes.json", role: "HyperEVM LST/LRT lending oracle context" },
  { key: "consumerFirstHighLtvCollateral", rel: "reports/raw/fast/consumer-first-high-ltv-collateral.json", role: "consumer-first high-LTV collateral graph" },
  { key: "aaveEulerSiloConsumerGraph", rel: "reports/raw/fast/aave-euler-silo-consumer-graph.json", role: "Aave/Euler/Silo producer-consumer graph" },
  { key: "usdt0ConsumerRoutes", rel: "reports/raw/fast/usdt0-consumer-routes.json", role: "USDT0 wrapped-token consumer context", optional: true },
  { key: "usdt0OftRoutes", rel: "reports/raw/fast/usdt0-oft-routes.json", role: "USDT0 OFT/wrapped-token route context", optional: true },
  { key: "hyperliquidLinkedTokenConsumers", rel: "reports/raw/fast/hyperliquid-linked-token-consumers.json", role: "Hyperliquid linked-token consumer context", optional: true },
  { key: "layerzeroOftDvnConsumerJoins", rel: "reports/raw/fast/layerzero-oft-dvn-consumer-joins.json", role: "LayerZero/OFT DVN consumer join context", optional: true },
];

const CHAIN_NAMES = {
  1: "Ethereum",
  10: "Optimism",
  56: "BNB Chain",
  137: "Polygon",
  999: "HyperEVM",
  8453: "Base",
  42161: "Arbitrum",
  43114: "Avalanche",
};

function relPath(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function toWorkspacePath(rel) {
  return path.join(WORKSPACE, ...rel.split("/"));
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function stripUrl(value) {
  return String(value === null || value === undefined ? "" : value).replace(/https?:\/\/[^\s'\"<>)}\]]+/g, "[url-redacted]");
}

function truncate(value, max = 220) {
  const s = stripUrl(value);
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  const text = String(value).replace(/[$,%\s,_]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function truthy(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") return /^(1|true|yes)$/i.test(value.trim());
  return false;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = asNumber(value);
    if (n !== null) return n;
  }
  return null;
}

function safeSummary(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return truncate(value, 180);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.slice(0, 12).map((v) => safeSummary(v, depth + 1));
  if (typeof value === "object") {
    if (depth > 3) return "[object]";
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) out[k] = safeSummary(v, depth + 1);
    return out;
  }
  return String(value);
}

function readInputs() {
  const inputs = {};
  const data = {};
  const caveats = [];
  for (const def of INPUT_DEFS) {
    const file = toWorkspacePath(def.rel);
    const meta = { path: def.rel, role: def.role, optional: Boolean(def.optional), exists: false, ok: false };
    try {
      if (!fs.existsSync(file)) {
        meta.missing = true;
        caveats.push(`${def.rel} missing; omitted from artifact-only consolidation.`);
      } else {
        const text = fs.readFileSync(file, "utf8");
        const json = JSON.parse(text);
        data[def.key] = json;
        meta.exists = true;
        meta.ok = true;
        meta.bytes = Buffer.byteLength(text, "utf8");
        meta.generatedAt = json.generatedAt || null;
        meta.scanner = json.scanner || null;
        meta.summary = safeSummary(json.summary || null);
        meta.sourceRoutePositive = truthy(json?.summary?.routePositive) || truthy(json?.routePositive);
        meta.sourceWatchCandidates = sourceWatchCount(def.key, json);
      }
    } catch (err) {
      meta.exists = fs.existsSync(file);
      meta.ok = false;
      meta.error = truncate(err?.message || String(err));
      caveats.push(`${def.rel} could not be parsed: ${meta.error}`);
    }
    inputs[def.key] = meta;
  }
  return { inputs, data, caveats };
}

function sourceWatchCount(key, json) {
  const s = json?.summary || {};
  const direct = asNumber(s.watchCandidates);
  if (direct !== null) return direct;
  if (key === "crossChainStaleness") return firstNumber(s.pairsWithLargeGap, s.pairsWithGap, 0) || 0;
  if (key === "oracleStalenessCrossRef") return firstNumber(s.realProtocolExceeded, 0) || 0;
  if (key === "lrtOraclePremiumProbe") return firstNumber(s.preforkPremiumPositiveRows, s.positivePremiumRows, 0) || 0;
  if (key === "layerzeroOftDvnConsumerJoins") return firstNumber(s.weakConfigConsumerRows, 0) || 0;
  return 0;
}

function symbolKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function displaySymbol(value) {
  const s = String(value || "").trim();
  return s || null;
}

function symbolFromPair(pair) {
  const raw = String(pair || "").trim();
  if (!raw) return null;
  let s;
  if (raw.includes("/")) {
    s = raw.split("/")[0];
  } else if (raw.includes("_")) {
    const parts = raw.split("_");
    const last = parts[parts.length - 1];
    s = /^USD[TC]?$/i.test(last) && parts.length > 1 ? parts.slice(0, -1).join("_") : parts[0];
  } else {
    s = raw;
  }
  return displaySymbol(s.toUpperCase());
}

function chainName(chainId, fallback) {
  const n = asNumber(chainId);
  return fallback || (n !== null ? CHAIN_NAMES[n] || String(n) : null);
}

function basisPoints(high, low) {
  const h = asNumber(high);
  const l = asNumber(low);
  if (h === null || l === null || l === 0) return null;
  return ((h / l) - 1) * 10_000;
}

function materialFlags(priceGapBps, ageGapSeconds) {
  const priceGap = asNumber(priceGapBps);
  const ageGap = asNumber(ageGapSeconds);
  const materialPriceGap = priceGap === null ? null : Math.abs(priceGap) >= CONFIG.minMaterialPriceGapBps;
  const materialAgeGap = ageGap === null ? null : Math.abs(ageGap) >= CONFIG.minMaterialAgeGapSeconds;
  const staleOrDivergent = materialPriceGap === true || materialAgeGap === true
    ? true
    : materialPriceGap === false && materialAgeGap === false
      ? false
      : null;
  return { materialPriceGap, materialAgeGap, staleOrDivergent };
}

function buildPriceRows(data) {
  const rows = [];
  const staleness = data.crossChainStaleness;
  if (Array.isArray(staleness?.results)) {
    for (const result of staleness.results) {
      const symbol = symbolFromPair(result.pair);
      for (const feed of Array.isArray(result.feeds) ? result.feeds : []) {
        const price = asNumber(feed.price);
        if (price === null) continue;
        const ageSeconds = asNumber(feed.age);
        rows.push({
          symbol,
          pair: result.pair || null,
          chainId: asNumber(feed.chainId),
          chain: chainName(feed.chainId),
          feed: feed.feed || null,
          price: round(price, 8),
          updatedAt: asNumber(feed.updatedAt),
          ageSeconds,
          ageHours: ageSeconds === null ? null : round(ageSeconds / 3600, 4),
          description: feed.description ? truncate(feed.description, 80) : null,
          sourceArtifact: "reports/raw/fast/cross-chain-chainlink-staleness.json",
          sourceScanner: staleness.scanner || null,
        });
      }
    }
  }

  const discrepancy = data.crossChainPriceDiscrepancy;
  if (discrepancy?.prices && typeof discrepancy.prices === "object") {
    for (const [pair, byChain] of Object.entries(discrepancy.prices)) {
      const symbol = symbolFromPair(pair);
      for (const [chainId, value] of Object.entries(byChain || {})) {
        const price = asNumber(value?.price);
        if (price === null) continue;
        const ageSeconds = asNumber(value.age);
        rows.push({
          symbol,
          pair,
          chainId: asNumber(chainId),
          chain: chainName(chainId, value.chain),
          feed: null,
          price: round(price, 8),
          updatedAt: asNumber(value.updatedAt),
          ageSeconds,
          ageHours: firstNumber(value.ageHours, ageSeconds === null ? null : ageSeconds / 3600),
          description: null,
          sourceArtifact: "reports/raw/fast/cross-chain-price-discrepancy.json",
          sourceScanner: discrepancy.scanner || null,
        });
      }
    }
  }
  return rows;
}

function buildDriftRows(data) {
  const rows = [];
  const staleness = data.crossChainStaleness;
  if (Array.isArray(staleness?.results)) {
    for (const result of staleness.results) {
      const symbol = symbolFromPair(result.pair);
      const sourceFeeds = Array.isArray(result.feeds) ? result.feeds : [];
      const validFeeds = sourceFeeds.filter((f) => asNumber(f.price) !== null);
      const sourceStatus = result.status || null;
      const sourceFeedsConfigured = firstNumber(result.feedsConfigured, sourceFeeds.length);
      const sourceFeedsRead = firstNumber(result.feedsRead, validFeeds.length);
      const coverageGapCount = firstNumber(result.coverageGapCount, sourceFeeds.filter((feed) => Boolean(feed?.error)).length, 0) || 0;
      const sourceCoverageGap = validFeeds.length < 2 || /^coverage-gap/i.test(String(sourceStatus || ""));
      const maxAge = asNumber(result.maxAge);
      const minAge = asNumber(result.minAge);
      const derivedAgeGap = maxAge === null || minAge === null ? null : maxAge - minAge;
      const priceGapBps = sourceCoverageGap ? null : firstNumber(result.priceGapBps, basisPoints(result.maxPrice, result.minPrice));
      const ageGapSeconds = sourceCoverageGap ? null : firstNumber(result.ageGap, derivedAgeGap);
      const flags = materialFlags(priceGapBps, ageGapSeconds);
      rows.push({
        symbol,
        pair: result.pair || null,
        driftType: "cross-chain-chainlink-staleness",
        sourceArtifact: "reports/raw/fast/cross-chain-chainlink-staleness.json",
        sourceScanner: staleness.scanner || null,
        comparedChains: validFeeds.length,
        sourceStatus,
        sourceFeedsConfigured,
        sourceFeedsRead,
        sourceFeedCoveragePct: sourceFeedsConfigured ? round((sourceFeedsRead / sourceFeedsConfigured) * 100, 2) : null,
        coverageGapCount,
        sourceCoverageGap,
        priceGapBps: round(priceGapBps, 2),
        ageGapSeconds: round(ageGapSeconds, 0),
        freshestChain: result.freshestChain ?? null,
        freshestAgeSeconds: asNumber(result.freshestAge),
        stalestChain: result.stalestChain ?? null,
        stalestAgeSeconds: asNumber(result.stalestAge),
        highPrice: round(result.maxPrice, 8),
        lowPrice: round(result.minPrice, 8),
        sourceRoutePositive: truthy(result.routePositive),
        ...flags,
        watchSignal: flags.staleOrDivergent === true || truthy(result.routePositive)
          ? true
          : flags.staleOrDivergent === false
            ? false
            : null,
        routePositive: false,
        blockers: driftBlockers(flags, truthy(result.routePositive), { sourceCoverageGap, coverageGapCount, sourceStatus, sourceFeedsRead, sourceFeedsConfigured }),
      });
    }
  }

  const discrepancy = data.crossChainPriceDiscrepancy;
  if (discrepancy?.prices && typeof discrepancy.prices === "object") {
    for (const [pair, byChain] of Object.entries(discrepancy.prices)) {
      const symbol = symbolFromPair(pair);
      const valid = Object.entries(byChain || {})
        .map(([chainId, value]) => ({ chainId: asNumber(chainId), chain: value?.chain || chainName(chainId), price: asNumber(value?.price), age: asNumber(value?.age), ageHours: asNumber(value?.ageHours) }))
        .filter((row) => row.price !== null);
      if (valid.length < 2) continue;
      const high = valid.slice().sort((a, b) => b.price - a.price)[0];
      const low = valid.slice().sort((a, b) => a.price - b.price)[0];
      const ages = valid.map((v) => v.age).filter((v) => v !== null);
      const maxAge = ages.length ? Math.max(...ages) : null;
      const minAge = ages.length ? Math.min(...ages) : null;
      const priceGapBps = basisPoints(high.price, low.price);
      const ageGapSeconds = maxAge === null || minAge === null ? null : maxAge - minAge;
      const flags = materialFlags(priceGapBps, ageGapSeconds);
      rows.push({
        symbol,
        pair,
        driftType: "cross-chain-price-discrepancy-artifact",
        sourceArtifact: "reports/raw/fast/cross-chain-price-discrepancy.json",
        sourceScanner: discrepancy.scanner || null,
        comparedChains: valid.length,
        priceGapBps: round(priceGapBps, 2),
        ageGapSeconds: round(ageGapSeconds, 0),
        highChain: high.chain || high.chainId,
        highChainId: high.chainId,
        highPrice: round(high.price, 8),
        lowChain: low.chain || low.chainId,
        lowChainId: low.chainId,
        lowPrice: round(low.price, 8),
        freshestChain: minAge === null ? null : valid.find((v) => v.age === minAge)?.chain || null,
        freshestAgeSeconds: minAge,
        stalestChain: maxAge === null ? null : valid.find((v) => v.age === maxAge)?.chain || null,
        stalestAgeSeconds: maxAge,
        sourceRoutePositive: false,
        ...flags,
        watchSignal: flags.staleOrDivergent,
        routePositive: false,
        blockers: driftBlockers(flags, false),
      });
    }
  }

  if (Array.isArray(discrepancy?.discrepancies) && discrepancy.discrepancies.length) {
    for (const d of discrepancy.discrepancies) {
      const priceGapBps = asNumber(d.gapBps);
      const flags = materialFlags(priceGapBps, null);
      rows.push({
        symbol: symbolFromPair(d.pair),
        pair: d.pair || null,
        driftType: "source-reported-price-discrepancy",
        sourceArtifact: "reports/raw/fast/cross-chain-price-discrepancy.json",
        sourceScanner: discrepancy.scanner || null,
        comparedChains: asNumber(d.chainsQueried),
        priceGapBps: round(priceGapBps, 2),
        ageGapSeconds: null,
        highChain: d.highChain || null,
        highPrice: round(d.highPrice, 8),
        lowChain: d.lowChain || null,
        lowPrice: round(d.lowPrice, 8),
        sourceRoutePositive: false,
        ...flags,
        watchSignal: true,
        routePositive: false,
        blockers: driftBlockers(flags, false),
      });
    }
  }
  return rows;
}

function driftBlockers(flags, sourceRoutePositive, coverage = null) {
  return [
    coverage?.sourceCoverageGap || coverage?.coverageGapCount > 0
      ? `Source feed coverage is incomplete (${coverage.sourceFeedsRead ?? "?"}/${coverage.sourceFeedsConfigured ?? "?"}; gaps=${coverage.coverageGapCount ?? "?"}; status=${coverage.sourceStatus || "unknown"}); missing observations are not zero-divergence facts`
      : null,
    sourceRoutePositive ? "Source routePositive is stale/gap watch-only and downgraded without exact economics/fork proof" : null,
    flags.materialPriceGap ? "Material cross-chain price gap needs bridge/DEX cost model" : null,
    flags.materialAgeGap ? "Material cross-chain feed age gap needs consumer-specific stale-read path" : null,
    "No exact bridge, borrow, liquidation, or exit economics in this consolidator",
    "No local/fork proof of permissionless extraction",
  ].filter(Boolean);
}

function exactEconomicsCount(json) {
  const s = json?.summary || {};
  return firstNumber(s.exactEconomicsRows, s.preforkPremiumPositiveRows, s.researchPositiveRows, 0) || 0;
}

function forkProofCount(json) {
  const s = json?.summary || {};
  return firstNumber(s.forkProofRows, s.forkPositiveRows, 0) || 0;
}

function collectRoutePositiveRows(json) {
  const arrays = [];
  for (const key of ["results", "rows", "topRows", "discrepancies", "consumers", "watchCandidates"]) {
    if (Array.isArray(json?.[key])) arrays.push(...json[key]);
  }
  if (Array.isArray(json?.results)) {
    for (const r of json.results) {
      if (Array.isArray(r?.topRows)) arrays.push(...r.topRows);
      if (Array.isArray(r?.topMatches)) arrays.push(...r.topMatches);
      if (Array.isArray(r?.highLtvRowsDetail)) arrays.push(...r.highLtvRowsDetail);
    }
  }
  return arrays.filter((row) => truthy(row?.routePositive)).slice(0, 12).map((row) => ({
    pair: row.pair || null,
    symbol: row.symbol || row.collateral?.symbol || row.collateralAsset?.symbol || row.consumer?.collateralAsset?.symbol || symbolFromPair(row.pair) || null,
    protocol: row.protocol || row.market?.protocol || null,
    chainId: row.chainId || row.chain?.chainId || row.market?.chainId || null,
    priceGapBps: round(row.priceGapBps ?? row.gapBps, 2),
    ageGapSeconds: round(row.ageGap ?? row.ageGapSeconds, 0),
    watchCandidate: truthy(row.watchCandidate),
  }));
}

function buildDowngrades(inputs, data) {
  const rows = [];
  for (const def of INPUT_DEFS) {
    const json = data[def.key];
    if (!json) continue;
    const sourceRoutePositive = truthy(json?.summary?.routePositive) || truthy(json?.routePositive);
    const exact = exactEconomicsCount(json);
    const fork = forkProofCount(json);
    if (sourceRoutePositive && !(exact > 0 && fork > 0)) {
      rows.push({
        inputKey: def.key,
        sourceArtifact: def.rel,
        sourceScanner: json.scanner || null,
        sourceRoutePositive: json?.summary?.routePositive ?? json?.routePositive ?? true,
        exactEconomicsRows: exact,
        forkProofRows: fork,
        affectedRows: collectRoutePositiveRows(json),
        downgradeReason: "Route-positive source signal lacks exact positive economics and local/fork proof; kept as watch-only.",
        routePositive: false,
      });
    }
  }
  return rows;
}

function aliasSetForDriftSymbol(symbol) {
  const key = symbolKey(symbol);
  const aliases = new Set([key]);
  if (key === "eth") ["weth", "steth", "wsteth", "weeth", "eeth", "ezeth", "reth", "cbeth", "sfrxeth", "meth", "sweth", "rseth"].forEach((x) => aliases.add(x));
  if (key === "btc") ["wbtc", "cbbtc", "tbtc", "ubtc", "solvbtc"].forEach((x) => aliases.add(x));
  if (key === "usdt") ["usd0", "usdt0", "usdt", "usdtarb", "usdtsei"].forEach((x) => aliases.add(x));
  if (key === "usdc") ["usdc", "usdbc", "usdce"].forEach((x) => aliases.add(x));
  if (key === "dai") ["dai", "sdai"].forEach((x) => aliases.add(x));
  return aliases;
}

function matchedDriftSymbols(rowSymbols, driftSymbols) {
  const rowKeys = new Set(rowSymbols.map(symbolKey).filter(Boolean));
  const matched = [];
  for (const drift of driftSymbols) {
    const aliases = aliasSetForDriftSymbol(drift);
    for (const key of rowKeys) {
      if (aliases.has(key)) {
        matched.push(drift);
        break;
      }
    }
  }
  return [...new Set(matched)];
}

function addSymbol(out, value) {
  const s = displaySymbol(value);
  if (!s) return;
  if (/^0x[0-9a-f]{40}$/i.test(s)) return;
  if (s.length > 40) return;
  out.add(s);
}

function extractSymbols(row) {
  const out = new Set();
  addSymbol(out, row?.symbol);
  addSymbol(out, row?.token);
  addSymbol(out, row?.primarySymbol);
  addSymbol(out, row?.depegName);
  if (Array.isArray(row?.symbols)) for (const s of row.symbols) addSymbol(out, s);
  addSymbol(out, row?.collateral?.symbol);
  addSymbol(out, row?.collateralAsset?.symbol);
  addSymbol(out, row?.consumer?.collateralAsset?.symbol);
  addSymbol(out, row?.borrowAsset?.symbol);
  addSymbol(out, row?.loanAsset?.symbol);
  addSymbol(out, row?.consumer?.loanAsset?.symbol);
  addSymbol(out, row?.market?.symbol);
  addSymbol(out, row?.market?.collateralAsset?.symbol);
  addSymbol(out, row?.market?.loanAsset?.symbol);
  addSymbol(out, row?.producer?.symbol);
  addSymbol(out, row?.facts?.symbol);
  addSymbol(out, row?.baseToken?.symbol);
  addSymbol(out, row?.quoteToken?.symbol);
  return [...out];
}

function collateralSymbol(row) {
  return row?.collateral?.symbol || row?.collateralAsset?.symbol || row?.consumer?.collateralAsset?.symbol || row?.market?.collateralAsset?.symbol || row?.market?.symbol || null;
}

function borrowSymbol(row) {
  return row?.borrowAsset?.symbol || row?.loanAsset?.symbol || row?.consumer?.loanAsset?.symbol || row?.market?.loanAsset?.symbol || null;
}

function sourceCategory(key) {
  return {
    lrtOracleDriftRoutes: "lst-lrt-lending-oracle-watch",
    lrtOraclePremiumProbe: "lst-lrt-oracle-premium-economics-negative",
    stablecoinDepegLendingRoutes: "stablecoin-depeg-lending-watch",
    hyperevmLstLrtOracleRoutes: "hyperevm-lst-lrt-oracle-watch",
    usdt0ConsumerRoutes: "wrapped-stable-consumer-context",
    hyperliquidLinkedTokenConsumers: "hyperliquid-linked-token-consumer-context",
    layerzeroOftDvnConsumerJoins: "oft-dvn-consumer-context",
    oracleStalenessCrossRef: "single-chain-oracle-staleness-cross-ref",
  }[key] || "consumer-context";
}

function rowArrayForSource(key, json) {
  const arrays = [];
  if (Array.isArray(json?.topRows)) arrays.push(json.topRows);
  if (Array.isArray(json?.rows)) arrays.push(json.rows);
  if (Array.isArray(json?.consumers)) arrays.push(json.consumers);
  if (key === "oracleStalenessCrossRef") {
    if (Array.isArray(json?.exceededHeartbeat)) arrays.push(json.exceededHeartbeat);
    if (Array.isArray(json?.nearHeartbeat)) arrays.push(json.nearHeartbeat);
  }
  if (Array.isArray(json?.results)) {
    const nested = [];
    for (const r of json.results) {
      if (Array.isArray(r?.topRows)) nested.push(...r.topRows);
      if (Array.isArray(r?.topMatches)) nested.push(...r.topMatches);
    }
    if (nested.length) arrays.push(nested);
  }
  return arrays.find((a) => a.length) || [];
}

function summarizeConsumerRow(raw, opts) {
  const symbols = extractSymbols(raw);
  const ltv = firstNumber(raw?.ltv, raw?.lltv, raw?.effectiveLtv, raw?.economics?.lltv, raw?.market?.ltv);
  const lltv = firstNumber(raw?.lltv, raw?.market?.lltv);
  const routeLiquidityUsd = firstNumber(
    raw?.routeLiquidityUsd,
    raw?.liquidityUsd,
    raw?.cashUsd,
    raw?.market?.cashUsd,
    raw?.facts?.cashUsd,
    raw?.facts?.availableLiquidity,
    raw?.bestLiquidLiquidityUsd,
    raw?.bestLiquidityUsd,
    raw?.economics?.borrowCashUsd,
    raw?.borrowCashUsd
  );
  const netUsd = firstNumber(raw?.netUsd, raw?.bestNetUsd, raw?.bestLiquidNetUsd, raw?.estimatedNetUsd, raw?.economics?.estimatedNetUsd, raw?.netDepegUsd, raw?.economics?.netDepegUsd);
  const driftBps = firstNumber(raw?.premiumBps, raw?.depegBps, raw?.edgeBps, raw?.bestEdgeBps, raw?.bestLiquidEdgeBps, raw?.facts?.oracleVsRefPct === undefined ? null : raw.facts.oracleVsRefPct * 100);
  const highLtv = truthy(raw?.highLtv) || (ltv !== null && ltv >= 0.85) || (lltv !== null && lltv >= 0.85);
  const materialLiquidity = routeLiquidityUsd !== null && routeLiquidityUsd >= CONFIG.minBorrowLiquidityUsd;
  const watchCandidate = truthy(raw?.watchCandidate) || truthy(raw?.reviewCandidate) || (highLtv && materialLiquidity && (opts.matchedDriftSymbols || []).length > 0);
  const blockers = Array.isArray(raw?.blockers) ? raw.blockers.map((b) => truncate(b, 180)).slice(0, 6) : [];
  if (!blockers.length) blockers.push("No exact borrow/bridge/exit economics or fork proof in source context");
  return {
    category: opts.category,
    joinType: opts.joinType,
    sourceArtifact: opts.sourceArtifact,
    sourceKey: opts.sourceKey,
    matchedDriftSymbols: opts.matchedDriftSymbols || [],
    symbols,
    protocol: raw?.protocol || raw?.market?.protocol || null,
    chainId: raw?.chainId || raw?.chain?.chainId || raw?.producer?.chainId || raw?.market?.chainId || null,
    chain: raw?.chain || raw?.chain?.name || raw?.producer?.chain || raw?.market?.chain || null,
    marketId: raw?.marketId || raw?.consumer?.marketId || raw?.market?.marketId || null,
    oracle: raw?.oracle || raw?.consumer?.oracle || raw?.market?.oracle || raw?.market?.priceOracle || null,
    collateralSymbol: collateralSymbol(raw),
    borrowSymbol: borrowSymbol(raw),
    ltv: round(ltv, 6),
    lltv: round(lltv, 6),
    routeLiquidityUsd: round(routeLiquidityUsd, 2),
    supplyUsd: round(firstNumber(raw?.supplyUsd, raw?.supplyAssetsUsd, raw?.market?.supplyAssetsUsd), 2),
    borrowUsd: round(firstNumber(raw?.borrowUsd, raw?.borrowAssetsUsd, raw?.market?.borrowAssetsUsd), 2),
    driftBps: round(driftBps, 2),
    netUsd: round(netUsd, 2),
    highLtv,
    materialLiquidity,
    watchCandidate,
    sourceRoutePositive: truthy(raw?.routePositive),
    routePositive: false,
    blockers,
  };
}

function buildConsumerJoinRows(data, driftRows) {
  const materialSymbols = [...new Set(driftRows.filter((r) => r.staleOrDivergent || r.watchSignal).map((r) => r.symbol).filter(Boolean))];
  const directCandidates = [];

  const consumerFirst = data.consumerFirstHighLtvCollateral;
  if (Array.isArray(consumerFirst?.results)) {
    for (const result of consumerFirst.results) {
      for (const row of Array.isArray(result?.highLtvRowsDetail) ? result.highLtvRowsDetail : []) directCandidates.push({ key: "consumerFirstHighLtvCollateral", row });
      for (const row of Array.isArray(result?.topRows) ? result.topRows : []) directCandidates.push({ key: "consumerFirstHighLtvCollateral", row });
    }
  }

  const graph = data.aaveEulerSiloConsumerGraph;
  if (Array.isArray(graph?.results)) {
    for (const result of graph.results) {
      for (const row of Array.isArray(result?.topMatches) ? result.topMatches : []) directCandidates.push({ key: "aaveEulerSiloConsumerGraph", row });
    }
  }

  const rows = [];
  for (const candidate of directCandidates) {
    const symbols = extractSymbols(candidate.row);
    const matched = matchedDriftSymbols(symbols, materialSymbols);
    if (!matched.length) continue;
    rows.push(summarizeConsumerRow(candidate.row, {
      category: "lending-consumer-drift-symbol-join",
      joinType: "direct-drift-symbol-join",
      sourceArtifact: INPUT_DEFS.find((d) => d.key === candidate.key)?.rel,
      sourceKey: candidate.key,
      matchedDriftSymbols: matched,
    }));
    if (rows.length >= CONFIG.maxRows) break;
  }

  const contextKeys = [
    "lrtOracleDriftRoutes",
    "lrtOraclePremiumProbe",
    "stablecoinDepegLendingRoutes",
    "hyperevmLstLrtOracleRoutes",
    "usdt0ConsumerRoutes",
    "hyperliquidLinkedTokenConsumers",
    "layerzeroOftDvnConsumerJoins",
    "oracleStalenessCrossRef",
  ];
  for (const key of contextKeys) {
    const json = data[key];
    if (!json) continue;
    const def = INPUT_DEFS.find((d) => d.key === key);
    const sourceRows = rowArrayForSource(key, json).slice(0, Math.max(CONFIG.topRows, 30));
    let taken = 0;
    for (const raw of sourceRows) {
      const symbols = extractSymbols(raw);
      const matched = matchedDriftSymbols(symbols, materialSymbols);
      const row = summarizeConsumerRow(raw, {
        category: sourceCategory(key),
        joinType: matched.length ? "source-context-with-drift-symbol" : "source-context",
        sourceArtifact: def?.rel,
        sourceKey: key,
        matchedDriftSymbols: matched,
      });
      const include = row.watchCandidate || row.highLtv || row.materialLiquidity || row.driftBps !== null || key === "oracleStalenessCrossRef";
      if (!include) continue;
      rows.push(row);
      taken += 1;
      if (taken >= CONFIG.topRows) break;
      if (rows.length >= CONFIG.maxRows) break;
    }
    if (rows.length >= CONFIG.maxRows) break;
  }

  const seen = new Set();
  return rows.filter((row) => {
    const key = [row.sourceKey, row.joinType, row.protocol, row.chainId, row.marketId, row.oracle, row.collateralSymbol, row.borrowSymbol, row.routeLiquidityUsd, row.driftBps].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, CONFIG.maxRows);
}

function scoreRow(row) {
  const watch = truthy(row.watchCandidate || row.watchSignal) ? 1_000_000_000 : 0;
  const downgraded = row.category === "downgraded-source-route-positive" ? 500_000_000 : 0;
  const price = Math.abs(asNumber(row.priceGapBps ?? row.driftBps) || 0) * 10_000;
  const age = Math.abs(asNumber(row.ageGapSeconds) || 0);
  const liq = Math.min(asNumber(row.routeLiquidityUsd) || 0, 1_000_000_000) / 10;
  return watch + downgraded + price + age + liq;
}

function buildRows(driftRows, consumerJoinRows, downgrades) {
  const driftTriageRows = driftRows.filter((r) => r.watchSignal || r.staleOrDivergent || r.sourceCoverageGap || r.coverageGapCount > 0).map((r) => ({
    category: "cross-chain-price-or-staleness-watch",
    sourceArtifact: r.sourceArtifact,
    symbol: r.symbol,
    pair: r.pair,
    driftType: r.driftType,
    sourceStatus: r.sourceStatus,
    sourceFeedsConfigured: r.sourceFeedsConfigured,
    sourceFeedsRead: r.sourceFeedsRead,
    sourceFeedCoveragePct: r.sourceFeedCoveragePct,
    coverageGapCount: r.coverageGapCount,
    sourceCoverageGap: r.sourceCoverageGap,
    priceGapBps: r.priceGapBps,
    ageGapSeconds: r.ageGapSeconds,
    freshestChain: r.freshestChain,
    stalestChain: r.stalestChain,
    watchCandidate: true,
    sourceRoutePositive: r.sourceRoutePositive,
    routePositive: false,
    blockers: r.blockers,
  }));
  const downgradeRows = downgrades.map((d) => ({
    category: "downgraded-source-route-positive",
    sourceArtifact: d.sourceArtifact,
    inputKey: d.inputKey,
    sourceRoutePositive: d.sourceRoutePositive,
    exactEconomicsRows: d.exactEconomicsRows,
    forkProofRows: d.forkProofRows,
    affectedRows: d.affectedRows,
    watchCandidate: true,
    routePositive: false,
    blockers: [d.downgradeReason],
  }));
  return [...driftTriageRows, ...consumerJoinRows, ...downgradeRows]
    .sort((a, b) => scoreRow(b) - scoreRow(a))
    .slice(0, CONFIG.maxRows);
}

function maxNumber(rows, getter) {
  let best = null;
  for (const row of rows) {
    const n = asNumber(getter(row));
    if (n === null) continue;
    if (best === null || n > best) best = n;
  }
  return best;
}

function maxAbsNumber(rows, getter) {
  let best = null;
  for (const row of rows) {
    const n = asNumber(getter(row));
    if (n === null) continue;
    const abs = Math.abs(n);
    if (best === null || abs > Math.abs(best)) best = n;
  }
  return best;
}

function markdownTable(rows, columns) {
  if (!rows.length) return "_None._\n";
  const header = `| ${columns.map((c) => c.title).join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((c) => truncate(c.value(row) ?? "", 80).replace(/\|/g, "\\|")).join(" | ")} |`);
  return [header, sep, ...body].join("\n") + "\n";
}

function formatValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(round(value, 2));
  return String(value);
}

function buildMarkdown(artifact, downgrades) {
  const s = artifact.summary;
  const topDrift = artifact.driftRows.filter((r) => r.watchSignal || r.staleOrDivergent || r.sourceCoverageGap || r.coverageGapCount > 0).sort((a, b) => scoreRow(b) - scoreRow(a)).slice(0, 12);
  const topConsumers = artifact.consumerJoinRows.filter((r) => r.watchCandidate || r.highLtv || r.materialLiquidity).sort((a, b) => scoreRow(b) - scoreRow(a)).slice(0, 12);
  const lines = [];
  lines.push("# Cross-Chain Oracle Drift Triage");
  lines.push("");
  lines.push(`Run: \`${artifact.runId}\``);
  lines.push("");
  lines.push("Signal: WATCH_ONLY/COVERAGE_GAPPED/NO_ROUTE_PROOF — no confirmed permissionless extraction; missing feed coverage is not a zero-divergence fact; routePositive=0, executableNow=0, signedActionJustified=false.");
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push(markdownTable([
    { k: "assetsCompared", v: s.assetsCompared },
    { k: "chainPriceRows", v: s.chainPriceRows },
    { k: "driftRows", v: s.driftRows },
    { k: "materialDriftRows", v: s.materialDriftRows },
    { k: "coverageGapDriftRows", v: s.coverageGapDriftRows },
    { k: "nullGapDriftRows", v: s.nullGapDriftRows },
    { k: "consumerRowsJoined", v: s.consumerRowsJoined },
    { k: "sourceWatchCandidates", v: s.sourceWatchCandidates },
    { k: "watchCandidates", v: s.watchCandidates },
    { k: "sourceRoutePositiveDowngradedRows", v: s.sourceRoutePositiveDowngradedRows },
    { k: "bestDriftBps", v: s.bestDriftBps },
    { k: "bestAgeGapSeconds", v: s.bestAgeGapSeconds },
    { k: "bestRouteLiquidityUsd", v: s.bestRouteLiquidityUsd },
    { k: "bestNetUsd", v: s.bestNetUsd },
    { k: "status", v: s.status },
  ], [
    { title: "Metric", value: (r) => r.k },
    { title: "Value", value: (r) => formatValue(r.v) },
  ]));
  lines.push("## Top drift/watch rows");
  lines.push("");
  lines.push(markdownTable(topDrift, [
    { title: "Symbol", value: (r) => r.symbol },
    { title: "Pair", value: (r) => r.pair },
    { title: "Source", value: (r) => r.sourceArtifact },
    { title: "Gap bps", value: (r) => r.priceGapBps },
    { title: "Age gap sec", value: (r) => r.ageGapSeconds },
    { title: "Coverage", value: (r) => r.sourceFeedsConfigured ? `${r.sourceFeedsRead}/${r.sourceFeedsConfigured}` : "" },
    { title: "Fresh/Stale", value: (r) => `${formatValue(r.freshestChain || r.highChain || "?")} / ${formatValue(r.stalestChain || r.lowChain || "?")}` },
    { title: "Blocker", value: (r) => (r.blockers || [])[0] },
  ]));
  lines.push("## Consumer/context rows");
  lines.push("");
  lines.push(markdownTable(topConsumers, [
    { title: "Category", value: (r) => r.category },
    { title: "Protocol", value: (r) => r.protocol || "" },
    { title: "Chain", value: (r) => r.chain || r.chainId || "" },
    { title: "Symbols", value: (r) => (r.symbols || []).slice(0, 4).join(",") },
    { title: "Matched drift", value: (r) => (r.matchedDriftSymbols || []).join(",") },
    { title: "LTV", value: (r) => r.ltv ?? r.lltv ?? "" },
    { title: "Liquidity USD", value: (r) => r.routeLiquidityUsd },
    { title: "Net USD", value: (r) => r.netUsd },
  ]));
  lines.push("## Downgraded source route-positive caveat");
  lines.push("");
  if (downgrades.length) {
    lines.push(markdownTable(downgrades, [
      { title: "Input", value: (r) => r.inputKey },
      { title: "Source", value: (r) => r.sourceArtifact },
      { title: "Source routePositive", value: (r) => r.sourceRoutePositive },
      { title: "Exact econ", value: (r) => r.exactEconomicsRows },
      { title: "Fork proof", value: (r) => r.forkProofRows },
      { title: "Downgrade", value: (r) => r.downgradeReason },
    ]));
  } else {
    lines.push("_No source routePositive signals required downgrade._\n");
  }
  lines.push("## Blockers / completion gate");
  lines.push("");
  for (const item of artifact.requiredForRoutePositive) lines.push(`- ${item}`);
  lines.push("");
  lines.push("## Caveats");
  lines.push("");
  for (const caveat of artifact.caveats) lines.push(`- ${caveat}`);
  lines.push("");
  lines.push("## Next read-only step");
  lines.push("");
  lines.push(artifact.nextReadOnlyStep);
  lines.push("");
  return lines.join("\n");
}

function main() {
  const { inputs, data, caveats: inputCaveats } = readInputs();
  const priceRows = buildPriceRows(data).slice(0, CONFIG.maxRows * 4);
  const driftRows = buildDriftRows(data).slice(0, CONFIG.maxRows * 2);
  const downgrades = buildDowngrades(inputs, data);
  const consumerJoinRows = buildConsumerJoinRows(data, driftRows);
  const rows = buildRows(driftRows, consumerJoinRows, downgrades);
  const topRows = rows.slice(0, CONFIG.topRows);

  const sourceWatchCandidates = Object.values(inputs).reduce((sum, meta) => sum + (asNumber(meta.sourceWatchCandidates) || 0), 0);
  const materialDriftRows = driftRows.filter((r) => r.staleOrDivergent).length;
  const staleOrDivergentRows = driftRows.filter((r) => r.watchSignal || r.staleOrDivergent).length;
  const coverageGapDriftRows = driftRows.filter((r) => r.sourceCoverageGap || r.coverageGapCount > 0).length;
  const nullGapDriftRows = driftRows.filter((r) => r.priceGapBps === null || r.ageGapSeconds === null).length;
  const consumerWatchRows = consumerJoinRows.filter((r) => r.watchCandidate).length;
  const watchCandidates = materialDriftRows + sourceWatchCandidates + consumerWatchRows + downgrades.length;
  const status = watchCandidates > 0 ? "cross-chain-oracle-drift-watch-needs-exact-bridge-or-borrow-economics" : "cross-chain-oracle-drift-no-route-positive";
  const bestDriftBps = round(maxAbsNumber(driftRows, (r) => r.priceGapBps), 2);
  const bestAgeGapSeconds = round(maxNumber(driftRows, (r) => r.ageGapSeconds), 0);
  const bestRouteLiquidityUsd = round(maxNumber(consumerJoinRows, (r) => r.routeLiquidityUsd), 2);
  const bestNetUsd = round(maxNumber(consumerJoinRows, (r) => r.netUsd), 2);
  const highLtvConsumerRows = consumerJoinRows.filter((r) => r.highLtv).length;
  const assetsCompared = new Set([...priceRows.map((r) => r.symbol), ...driftRows.map((r) => r.symbol)].filter(Boolean)).size;
  const runId = `cross-chain-oracle-drift-${crypto.createHash("sha256").update(JSON.stringify({
    sourceRunId: data.crossChainStaleness?.runId || null,
    config: CONFIG,
    driftRows,
    consumerRows: consumerJoinRows.length,
    downgrades,
  })).digest("hex").slice(0, 20)}`;

  const caveats = [
    "Artifact-only consolidation: this scanner did not read rpc_endpoints.txt, .env files, endpoint inventories, private keys, or key material.",
    "Input artifacts were generated at different times; prices/ages are historical artifact values, not fresh live probes.",
    "Stale/divergent Chainlink signals are watch-only until joined to an exact consumer path, bridge/DEX/borrow economics, and fork/local proof.",
    "Any source routePositive lacking exact positive economics plus fork proof is downgraded and not propagated.",
    "Route liquidity/net values are copied from source artifact summaries/top rows and may be stale or model-dependent.",
    ...inputCaveats,
  ];
  if (downgrades.length) caveats.push(`${downgrades.length} source routePositive artifact(s) downgraded to watch-only.`);

  const requiredForRoutePositive = [
    "same-asset cross-chain price/staleness gap exceeds bridge, DEX spread, gas, slippage, and flash-fee costs",
    "affected lending/consumer market accepts the stale/divergent oracle value at material borrow/liquidation liquidity",
    "permissionless acquisition, bridge, borrow/redeem/liquidation, and exit route is available now",
    "exact economics are positive after all costs and liquidity limits",
    "local/fork proof demonstrates net value extraction without privileged roles or signed-action assumptions",
  ];
  const nextReadOnlyStep = watchCandidates > 0
    ? "For the top watch rows, run read-only route quote/economics probes and fork/static-call proof only if net-positive economics are demonstrated."
    : "Re-run artifact scanners after market volatility or oracle update anomalies; no route-positive follow-up currently indicated.";

  const artifact = {
    runId,
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-cross-chain-oracle-drift.js",
    scope: "Artifact-only consolidation of cross-chain price/staleness and lending consumer oracle-drift artifacts",
    safety: {
      artifactOnly: true,
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
    config: CONFIG,
    inputs,
    summary: {
      assetsCompared,
      chainPriceRows: priceRows.length,
      driftRows: driftRows.length,
      materialDriftRows,
      coverageGapDriftRows,
      nullGapDriftRows,
      staleOrDivergentRows,
      consumerRowsJoined: consumerJoinRows.length,
      highLtvConsumerRows,
      sourceWatchCandidates,
      sourceRoutePositiveDowngradedRows: downgrades.length,
      watchCandidates,
      exactEconomicsRows: 0,
      forkProofRows: 0,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      bestDriftBps,
      bestAgeGapSeconds,
      bestRouteLiquidityUsd,
      bestNetUsd,
      status,
    },
    priceRows,
    driftRows,
    consumerJoinRows,
    sourceRoutePositiveDowngradedRows: downgrades,
    rows,
    topRows,
    caveats,
    requiredForRoutePositive,
    nextReadOnlyStep,
  };

  ensureDir(RAW_OUT);
  ensureDir(MD_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(MD_OUT, buildMarkdown(artifact, downgrades));

  if (!QUIET) {
    console.log(JSON.stringify({
      runId,
      status,
      assetsCompared,
      chainPriceRows: priceRows.length,
      driftRows: driftRows.length,
      materialDriftRows,
      coverageGapDriftRows,
      nullGapDriftRows,
      consumerRowsJoined: consumerJoinRows.length,
      sourceWatchCandidates,
      sourceRoutePositiveDowngradedRows: downgrades.length,
      watchCandidates,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      raw: relPath(RAW_OUT),
      report: relPath(MD_OUT),
    }, null, 2));
  }
}

main();
