#!/usr/bin/env node
// Read-only Morpho Blue Pyth/unsafe-oracle consumer join scanner.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
let ethers;
try { ({ ethers } = require("ethers")); } catch (_) { ({ ethers } = require("./node_modules/ethers")); }
const { resolveRpc, getImpl } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "morpho-pyth-unsafe-consumers.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "morpho-pyth-unsafe-consumers-triage.md");
const QUIET = process.argv.includes("--quiet");

const MORPHO_GQL = "https://api.morpho.org/graphql";
const DEFAULT_CHAINS = [1, 8453, 42161, 10, 137, 130, 42220, 1135, 1868, 534352, 146, 57073, 59144, 34443];
const CHAINS = parseChainIds(argValue("--chains") || process.env.MORPHO_PYTH_CHAIN_IDS, DEFAULT_CHAINS);
const MIN_LLTV_PCT = Number(process.env.MORPHO_PYTH_MIN_LLTV_PCT || "70");
const MIN_LIQUIDITY_USD = Number(process.env.MORPHO_PYTH_MIN_LIQUIDITY_USD || "10000");
const MAX_MARKETS_PER_CHAIN = Number(process.env.MORPHO_PYTH_MAX_MARKETS_PER_CHAIN || "1000");
const MAX_BYTECODE_MARKETS_PER_CHAIN = Number(process.env.MORPHO_PYTH_MAX_BYTECODE_MARKETS_PER_CHAIN || "250");
const BYTECODE_CONCURRENCY = Number(process.env.MORPHO_PYTH_BYTECODE_CONCURRENCY || "8");

const CHAIN_NAMES = {
  1: "Ethereum",
  10: "Optimism",
  130: "Unichain",
  137: "Polygon",
  146: "Sonic",
  1135: "Lisk",
  1868: "Soneium",
  8453: "Base",
  34443: "Mode",
  42161: "Arbitrum",
  42220: "Celo",
  534352: "Scroll",
  57073: "Ink",
  59144: "Linea",
};
const PYTH_CORE = {
  1: [
    "0x4305FB66699C3B2702D4d05CF36551390A4c69C6",
    "0x14b9932cc9AC8Ee03301665a8644A753f46D8552",
  ],
  8453: [
    "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a",
    "0xbC16aee60f64864882BC6C4E428e148Fc0E272F5",
  ],
  42161: [
    "0xff1a0f4744e8582DF1aE09D5611b887B6a12925C",
    "0xe15357fB7ab31E091583b9c4b4135BB2f176f38e",
  ],
};
const MORPHO_PYTH_FACTORIES = {
  1: "0x1ed187354d6bfb983932d9983917b199a7253ab9",
  8453: "0x0A250c472cb43fb4F476cc6f47da9CA85E071Bbb",
  42161: "0x3e2D5966bF67Ed2F66edfbc325f6bCf3d64EaA0A",
};

const ORACLE = new ethers.Interface(["function price() view returns (uint256)"]);
const PYTH_SELECTORS = [
  "getPriceUnsafe(bytes32)",
  "getEmaPriceUnsafe(bytes32)",
  "getPriceNoOlderThan(bytes32,uint256)",
  "getEmaPriceNoOlderThan(bytes32,uint256)",
  "updatePriceFeeds(bytes[])",
  "parsePriceFeedUpdates(bytes[],bytes32[],uint64,uint64)",
].map((sig) => ({ sig, selector: ethers.id(sig).slice(2, 10).toLowerCase() }));

function argValue(name) {
  const prefix = `${name}=`;
  const item = process.argv.find((arg) => arg.startsWith(prefix));
  if (item) return item.slice(prefix.length);
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

function parseChainIds(text, fallback) {
  if (!text) return fallback;
  const parsed = String(text)
    .split(/[\s,]+/)
    .map((item) => Number(item.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
  return parsed.length ? [...new Set(parsed)] : fallback;
}

function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[$,%\s,]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function lowerAddress(value) {
  const normalized = normalizeAddress(value);
  return normalized ? normalized.toLowerCase() : null;
}

function addressNeedle(address) {
  const normalized = lowerAddress(address);
  return normalized ? normalized.slice(2) : null;
}

function unique(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function lltvPct(raw) {
  const n = asNumber(raw);
  if (n === null) return null;
  return n / 1e16;
}

async function gql(query, variables = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(MORPHO_GQL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0]?.message || "Morpho GraphQL error");
    return json.data || {};
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMarkets(chainId) {
  const query = `query($first:Int!) {
    markets(first:$first, where:{chainId_in:[${Number(chainId)}]}) { items {
      marketId lltv
      loanAsset { address symbol decimals }
      collateralAsset { address symbol decimals }
      oracle { address }
      state { liquidityAssetsUsd supplyAssetsUsd borrowAssetsUsd utilization }
    } }
  }`;
  const data = await gql(query, { first: MAX_MARKETS_PER_CHAIN }).catch(() => ({ markets: { items: [] } }));
  return data?.markets?.items || [];
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let index = 0;
  async function worker() {
    for (;;) {
      const i = index;
      index += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

async function inspectOracle(provider, rpc, chainId, oracleAddress) {
  const oracle = normalizeAddress(oracleAddress);
  if (!oracle) return { oracle: null, codeBytes: 0, impl: null, pythLinked: false, unsafeSelectorHits: [], pythAddressHits: [] };
  const code = await provider.getCode(oracle).catch(() => "0x");
  const impl = await getImpl(rpc, oracle).catch(() => null);
  const implCode = impl ? await provider.getCode(impl).catch(() => "0x") : "0x";
  const combined = `${code}${implCode}`.toLowerCase();
  const unsafeSelectorHits = PYTH_SELECTORS
    .filter((entry) => combined.includes(entry.selector))
    .map((entry) => entry.sig);
  const pythAddressHits = unique((PYTH_CORE[chainId] || [])
    .filter((address) => {
      const needle = addressNeedle(address);
      return needle && combined.includes(needle);
    })
    .map((address) => normalizeAddress(address)));
  const factoryNeedle = addressNeedle(MORPHO_PYTH_FACTORIES[chainId]);
  const factoryAddressHit = Boolean(factoryNeedle && combined.includes(factoryNeedle));
  let priceStaticCallOk = false;
  let priceRaw = null;
  try {
    const raw = await provider.call({ to: oracle, data: ORACLE.encodeFunctionData("price", []) });
    [priceRaw] = ORACLE.decodeFunctionResult("price", raw);
    priceStaticCallOk = true;
  } catch (_) {
    // Non-Morpho oracle interface or reverted price call.
  }
  return {
    oracle,
    codeBytes: Math.max(0, (code.length - 2) / 2),
    impl: impl ? normalizeAddress(impl) : null,
    implCodeBytes: Math.max(0, (implCode.length - 2) / 2),
    pythLinked: unsafeSelectorHits.length > 0 || pythAddressHits.length > 0 || factoryAddressHit,
    unsafeSelectorHits,
    pythAddressHits,
    factoryAddressHit,
    priceStaticCallOk,
    priceRaw: priceRaw !== null && priceRaw !== undefined ? priceRaw.toString() : null,
  };
}

function marketRow(chainId, market, oracleInfo) {
  const lltv = lltvPct(market.lltv);
  const liquidityUsd = asNumber(market.state?.liquidityAssetsUsd) || 0;
  const supplyUsd = asNumber(market.state?.supplyAssetsUsd) || 0;
  const borrowUsd = asNumber(market.state?.borrowAssetsUsd) || 0;
  const materialLiquidity = liquidityUsd >= MIN_LIQUIDITY_USD;
  const highLltv = lltv !== null && lltv >= MIN_LLTV_PCT;
  const inspected = Boolean(oracleInfo);
  const pythUnsafe = inspected && oracleInfo.unsafeSelectorHits.some((sig) => /Unsafe/.test(sig));
  const watchCandidate = Boolean(inspected && oracleInfo.pythLinked && materialLiquidity && highLltv);
  return {
    chainId,
    chain: CHAIN_NAMES[chainId] || String(chainId),
    marketId: market.marketId,
    pair: `${market.collateralAsset?.symbol || "?"}/${market.loanAsset?.symbol || "?"}`,
    collateral: market.collateralAsset || null,
    loanAsset: market.loanAsset || null,
    lltvPct: round(lltv, 2),
    liquidityUsd: round(liquidityUsd, 2),
    supplyUsd: round(supplyUsd, 2),
    borrowUsd: round(borrowUsd, 2),
    utilization: round(asNumber(market.state?.utilization), 6),
    oracle: inspected ? oracleInfo.oracle : normalizeAddress(market.oracle?.address),
    oracleImpl: inspected ? oracleInfo.impl : null,
    oracleCodeBytes: inspected ? oracleInfo.codeBytes : null,
    oracleImplCodeBytes: inspected ? oracleInfo.implCodeBytes : null,
    oracleInspected: inspected,
    pythLinked: inspected && oracleInfo.pythLinked,
    pythUnsafe,
    unsafeSelectorHits: inspected ? oracleInfo.unsafeSelectorHits : [],
    pythAddressHits: inspected ? oracleInfo.pythAddressHits : [],
    factoryAddressHit: inspected && oracleInfo.factoryAddressHit,
    priceStaticCallOk: inspected && oracleInfo.priceStaticCallOk,
    materialLiquidity,
    highLltv,
    watchCandidate,
    routePositive: false,
    blocker: watchCandidate
      ? "Pyth-linked Morpho oracle with material liquidity; needs feed-id/staleness/deviation decode and exact borrow/exit economics before fork."
      : inspected ? "No route-positive Pyth-linked high-LLTV liquid market in this row." : "Skipped bytecode inspection because row was below route-relevant liquidity/LLTV limits.",
  };
}

function renderReport(artifact) {
  const s = artifact.summary;
  const topRows = artifact.rows.slice(0, 8).map((row) => `| ${row.chain} | ${row.pair} | ${row.lltvPct ?? "n/a"} | ${row.liquidityUsd ?? 0} | ${row.pythLinked ? "yes" : "no"} | ${row.pythUnsafe ? "yes" : "no"} | ${row.routePositive ? "yes" : "no"} |`).join("\n");
  return [
    "# 🟢 DORMANT — Morpho Pyth Unsafe Oracle Consumers",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    `**Dormant / route-negative.** Scanned Morpho Blue markets across ${s.chainsScanned} configured chains (${s.chainsWithRpc} with RPC) for Pyth-linked or unsafe oracle bytecode. Watch rows are not executable until a current Pyth feed-id/staleness/deviation path maps to positive borrow or liquidation economics and fork proof.`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Markets fetched | ${s.marketsFetched} |`,
    `| Route-relevant markets inspected | ${s.routeRelevantMarketsInspected} |`,
    `| Unique oracles inspected | ${s.uniqueOraclesInspected} |`,
    `| Pyth-linked markets | ${s.pythLinkedMarkets} |`,
    `| Unsafe selector markets | ${s.pythUnsafeMarkets} |`,
    `| Watch candidates | ${s.watchCandidates} |`,
    `| Route-positive | ${s.routePositive} |`,
    "",
    "## Top Rows",
    "",
    "| Chain | Pair | LLTV % | Liquidity USD | Pyth-linked | Unsafe selector | RoutePositive |",
    "| --- | --- | ---: | ---: | --- | --- | --- |",
    topRows || "| n/a | n/a | n/a | 0 | no | no | no |",
    "",
    "## Gate",
    "",
    "Route-positive remains closed until the scanner decodes a feed ID/current Pyth state, accepted Morpho oracle value diverges from live/executable acquisition value beyond LLTV break-even, exact borrow and exit routes are positive, and a local fork extraction proves net profit.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/morpho-pyth-unsafe-consumers.json`",
    "- Scanner: `tools/scan-morpho-pyth-unsafe-consumers.js`",
    "",
  ].join("\n");
}

async function main() {
  const byChain = {};
  const markets = [];
  const oracleCache = new Map();
  for (const chainId of CHAINS) {
    const rpc = await resolveRpc(chainId);
    if (!rpc) {
      byChain[chainId] = { chain: CHAIN_NAMES[chainId], rpcResolved: false, marketsFetched: 0, marketsScored: 0 };
      continue;
    }
    const fetched = await fetchMarkets(chainId);
    const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    const routeRelevant = fetched
      .filter((market) => (asNumber(market.state?.liquidityAssetsUsd) || 0) >= MIN_LIQUIDITY_USD && (lltvPct(market.lltv) || 0) >= MIN_LLTV_PCT && lowerAddress(market.oracle?.address))
      .sort((a, b) => (asNumber(b.state?.liquidityAssetsUsd) || 0) - (asNumber(a.state?.liquidityAssetsUsd) || 0))
      .slice(0, MAX_BYTECODE_MARKETS_PER_CHAIN);
    const oracleKeys = unique(routeRelevant.map((market) => `${chainId}:${lowerAddress(market.oracle?.address)}`));
    await mapLimit(oracleKeys, BYTECODE_CONCURRENCY, async (key) => {
      const [, oracle] = key.split(":");
      if (!oracleCache.has(key)) oracleCache.set(key, await inspectOracle(provider, rpc, chainId, oracle));
    });
    for (const market of routeRelevant) {
      const oracle = lowerAddress(market.oracle?.address);
      markets.push(marketRow(chainId, market, oracleCache.get(`${chainId}:${oracle}`)));
    }
    byChain[chainId] = {
      chain: CHAIN_NAMES[chainId],
      rpcResolved: true,
      marketsFetched: fetched.length,
      routeRelevantMarkets: routeRelevant.length,
      uniqueRouteRelevantOracles: oracleKeys.length,
      marketsScored: routeRelevant.length,
    };
  }

  const rows = markets.sort((a, b) => Number(b.watchCandidate) - Number(a.watchCandidate)
    || Number(b.pythLinked) - Number(a.pythLinked)
    || (b.liquidityUsd || 0) - (a.liquidityUsd || 0)
    || (b.lltvPct || 0) - (a.lltvPct || 0));
  const summary = {
    chainsScanned: CHAINS.length,
    chainsWithRpc: Object.values(byChain).filter((x) => x.rpcResolved).length,
    marketsFetched: Object.values(byChain).reduce((sum, row) => sum + (row.marketsFetched || 0), 0),
    routeRelevantMarketsInspected: rows.length,
    uniqueOraclesInspected: oracleCache.size,
    pythLinkedMarkets: rows.filter((row) => row.pythLinked).length,
    pythUnsafeMarkets: rows.filter((row) => row.pythUnsafe).length,
    watchCandidates: rows.filter((row) => row.watchCandidate).length,
    maxLiquidityUsd: round(Math.max(0, ...rows.map((row) => row.liquidityUsd || 0)), 2),
    maxWatchLiquidityUsd: round(Math.max(0, ...rows.filter((row) => row.watchCandidate).map((row) => row.liquidityUsd || 0)), 2),
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    status: rows.some((row) => row.watchCandidate) ? "watch-candidates-need-feed-decode-and-exact-economics" : "no-pyth-linked-liquid-high-lltv-market",
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-morpho-pyth-unsafe-consumers.js",
    scope: "Read-only Morpho Blue Pyth/unsafe-oracle consumer join across configured Morpho chains",
    safety: {
      rpcInventoryRead: true,
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
    thresholds: { chains: CHAINS, minLltvPct: MIN_LLTV_PCT, minLiquidityUsd: MIN_LIQUIDITY_USD, maxMarketsPerChain: MAX_MARKETS_PER_CHAIN, maxBytecodeMarketsPerChain: MAX_BYTECODE_MARKETS_PER_CHAIN, bytecodeConcurrency: BYTECODE_CONCURRENCY },
    knownPythCore: Object.fromEntries(Object.entries(PYTH_CORE).map(([chainId, addresses]) => [chainId, addresses.map((address) => normalizeAddress(address))])),
    knownMorphoPythFactories: Object.fromEntries(Object.entries(MORPHO_PYTH_FACTORIES).map(([chainId, address]) => [chainId, normalizeAddress(address)])),
    byChain,
    summary,
    rows: rows.slice(0, 100),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  fs.writeFileSync(REPORT_OUT, renderReport(artifact));
  if (!QUIET) {
    console.log(`Morpho Pyth unsafe consumers: marketsFetched=${summary.marketsFetched} inspected=${summary.routeRelevantMarketsInspected} pythLinked=${summary.pythLinkedMarkets} watch=${summary.watchCandidates} routePositive=0`);
    console.log(`Report: ${path.relative(WORKSPACE, OUT)}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
