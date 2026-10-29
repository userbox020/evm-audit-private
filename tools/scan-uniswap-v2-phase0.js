#!/usr/bin/env node
// scan-uniswap-v2-phase0.js - bounded read-only Phase 0 for Uniswap V2 pair/LP consumer joins.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "uniswap-v2-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "uniswap-v2-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const PROTOCOLS = path.join(WORKSPACE, "reports", "raw", "defillama-protocols-full.json");
const TEMP_PROTOCOLS = path.join(WORKSPACE, ".opencode", "temp_protocols.json");
const QUIET = process.argv.includes("--quiet");

const MAX_ENUM_PAIRS_PER_CHAIN = Number(process.env.UNISWAP_V2_MAX_ENUM_PAIRS_PER_CHAIN || "80");
const RPC_CONCURRENCY = Number(process.env.UNISWAP_V2_RPC_CONCURRENCY || "8");
const MIN_MATERIAL_POOL_TVL_USD = Number(process.env.UNISWAP_V2_MIN_MATERIAL_POOL_TVL_USD || "100000");
const MIN_WATCH_POOL_TVL_USD = Number(process.env.UNISWAP_V2_MIN_WATCH_POOL_TVL_USD || "250000");

const V2_FACTORY = new ethers.Interface([
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
  "function getPair(address,address) view returns (address)",
  "function feeTo() view returns (address)",
  "function feeToSetter() view returns (address)",
]);

const V2_PAIR = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function price0CumulativeLast() view returns (uint256)",
  "function price1CumulativeLast() view returns (uint256)",
]);

const ERC20 = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);

const BYTES32_TOKEN = new ethers.Interface([
  "function symbol() view returns (bytes32)",
  "function name() view returns (bytes32)",
]);

const CHAINS = {
  1: {
    name: "Ethereum", llamaNames: ["Ethereum"], coinSlug: "ethereum", factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    coreAssets: {
      WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7", DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F", WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" },
  },
  10: {
    name: "Optimism", llamaNames: ["Optimism"], coinSlug: "optimism", factory: "0x0c3c1c532F1e39EdF36BE9Fe0bE1410313E074Bf", router: null,
    coreAssets: {
      WETH: "0x4200000000000000000000000000000000000006", USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", USDT: "0x94b008aD8351c65A0B3bAEd0798C00ffF0bB6fE", DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", WBTC: "0x68f180fcCe6836688e9084f035309E29Bf0A2095" },
  },
  56: {
    name: "BNB Chain", llamaNames: ["Binance", "BSC", "BNB"], coinSlug: "bsc", factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6", router: null,
    coreAssets: {
      WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", USDT: "0x55d398326f99059fF775485246999027B3197955", USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", ETH: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", BTCB: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c" },
  },
  130: {
    name: "Unichain", llamaNames: ["Unichain"], coinSlug: "unichain", factory: "0x1F98400000000000000000000000000000000002", router: null,
    coreAssets: {
      WETH: "0x4200000000000000000000000000000000000006", USDC: "0x078D782b760474a361dDA0AF3839290b0EF57AD6" },
  },
  137: {
    name: "Polygon", llamaNames: ["Polygon"], coinSlug: "polygon", factory: "0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C", router: null,
    coreAssets: {
      WPOL: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6" },
  },
  8453: {
    name: "Base", llamaNames: ["Base"], coinSlug: "base", factory: "0x8909dc15e40173ff4699343b6eb8132c65e18ec6", router: null,
    coreAssets: {
      WETH: "0x4200000000000000000000000000000000000006", USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" },
  },
  42161: {
    name: "Arbitrum", llamaNames: ["Arbitrum"], coinSlug: "arbitrum", factory: "0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9", router: null,
    coreAssets: {
      WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", WBTC: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" },
  },
  42220: {
    name: "Celo", llamaNames: ["Celo"], coinSlug: "celo", factory: "0x79a530c8e2fA8748B7B40dd3629C0520c2cCf03f", router: null,
    coreAssets: {
      CELO: "0x471EcE3750Da237f93B8E339c536989b8978a438", cUSD: "0x765DE816845861e75A25fCA122bb6898B8B1282a", cEUR: "0xD8763CBA276a3738E6DE85b4b3bF5FDed6D6cA73", USDC: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e" },
  },
  43114: {
    name: "Avalanche", llamaNames: ["Avalanche"], coinSlug: "avalanche", factory: "0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C", router: null,
    coreAssets: {
      WAVAX: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", USDC: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", USDt: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", BTCb: "0x152b9d0FdC40C096757F570A51E494bd4b943E50" },
  },
};

const UNSUPPORTED_PROTOCOL_CHAINS = ["Monad", "X Layer", "Tempo", "Zora"];

const CONSUMER_ARTIFACTS = [
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["seven-chain-lending", "reports/raw/fast/seven-chain-lending-coverage.json"],
  ["stablecoin-depeg", "reports/raw/fast/stablecoin-depeg-lending-routes.json"],
  ["small-cap-oracle", "reports/raw/fast/small-cap-oracle-manipulation-routes.json"],
  ["erc4626-consumer", "reports/raw/fast/erc4626-consumer-joiner.json"],
  ["evault-collateral-nav", "reports/raw/fast/evault-collateral-nav-manipulation.json"],
  ["focused-morpho", "reports/raw/fast/focused-morpho-review-producers.json"],
  ["focused-euler", "reports/raw/fast/focused-euler-evk-review-producers.json"],
  ["morpho-public-allocator", "reports/raw/fast/morpho-public-allocator-force-feed.json"],
  ["pool-share-snapshot", "reports/raw/fast/pool-share-snapshot-drift.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["current-profit-leads", "reports/raw/fast/current-profit-lead-triage.json"],
];

const DIRECT_SOURCE_SET = new Set([
  "aave-euler-silo",
  "consumer-first-high-ltv",
  "seven-chain-lending",
  "stablecoin-depeg",
  "small-cap-oracle",
  "erc4626-consumer",
  "evault-collateral-nav",
  "focused-morpho",
  "focused-euler",
  "morpho-public-allocator",
  "pool-share-snapshot",
  "public-lead-consumer",
]);

const DIRECT_ROLES = new Set(["v2Pair"]);
const ZERO = "0x0000000000000000000000000000000000000000";
const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI", "USDC.E", "USDCE", "CUSD", "CEUR", "USD", "USDB", "USDE"]);
const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(value); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function formatUsd(value) {
  const n = asNumber(value);
  return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`;
}

function safeText(value, max = 140) {
  return String(value || "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max) || null;
}

function decodeBytes32String(value) { try { return safeText(ethers.decodeBytes32String(value), 40); } catch (_) { return null; } }
function stableFallback(symbol) { const s = String(symbol || "").toUpperCase(); return STABLE_SYMBOLS.has(s) ? 1 : null; }

function decimalsToNumber(value, decimals) {
  if (value === null || value === undefined || decimals === null || decimals === undefined) return null;
  try {
    const n = Number(ethers.formatUnits(BigInt(value), Number(decimals)));
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-uniswap-v2-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = 12_000) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr) return null;
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ to: addr, data: iface.encodeFunctionData(fn, args) }, "latest"], timeoutMs);
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
}

async function getCode(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return "0x";
  return await rpcCall(rpc, "eth_getCode", [addr, "latest"], 10_000).catch(() => "0x") || "0x";
}

function protocolMetadata() {
  const discovery = readJson(PUBLIC_TARGETS, {});
  const discoveryRows = [
    ...(discovery.phase0Queue || []),
    ...(discovery.consumerJoinFirst || []),
    ...(discovery.protocolCandidates || []),
    ...(discovery.targetedRefreshQueue || []),
    ...(discovery.protocols || []),
    ...(discovery.targets || []),
    ...(discovery.value || []),
  ];
  const protocolRow = discoveryRows.find((p) => p?.slug === "uniswap-v2" || p?.name === "Uniswap V2");
  if (protocolRow) {
    return {
      name: protocolRow.name,
      slug: protocolRow.slug,
      category: protocolRow.category,
      chains: protocolRow.chains || [],
      tvlUsd: round(protocolRow.tvlUsd, 2),
      change1dPct: protocolRow.change1dPct ?? null,
      change7dPct: protocolRow.change7dPct ?? null,
      routePriority: protocolRow.routePriority || null,
      source: "public-audit-target-discovery",
    };
  }
  for (const file of [PROTOCOLS, TEMP_PROTOCOLS]) {
    const raw = readJson(file, null);
    const arr = Array.isArray(raw) ? raw : raw?.value || raw?.protocols || [];
    const hit = arr.find((p) => p?.slug === "uniswap-v2" || p?.name === "Uniswap V2");
    if (hit) return { name: hit.name, slug: hit.slug, category: hit.category, chains: hit.chains || [], tvlUsd: round(hit.tvl, 2), module: hit.module || null, tvlCodePath: hit.tvlCodePath || null };
  }
  return { name: "Uniswap V2", slug: "uniswap-v2", category: "Dexs", chains: Object.values(CHAINS).map((c) => c.name), tvlUsd: null };
}

function uniswapYieldRows() {
  const discovery = readJson(PUBLIC_TARGETS, {});
  const rows = Array.isArray(discovery) ? discovery : [
    ...(discovery.yieldCandidates || []),
    ...(discovery.phase0Queue || []),
    ...(discovery.targetedRefreshQueue || []),
    ...(discovery.consumerJoinFirst || []),
    ...(discovery.yields || []),
    ...(discovery.targets || []),
    ...(discovery.value || []),
  ];
  return rows
    .filter((row) => row?.kind === "yield" && row?.project === "uniswap-v2" && Array.isArray(row?.underlying) && row.underlying.length >= 2)
    .map((row) => ({
      chain: row.chain,
      symbol: safeText(row.symbol, 80),
      tvlUsd: round(row.tvlUsd, 2),
      apyPct: round(row.apyPct, 4),
      poolId: safeText(row.pool, 90),
      underlying: row.underlying.map(normalizeAddress).filter(Boolean).slice(0, 2),
      routePositive: false,
    }));
}

function chainForLlamaName(name) {
  return Object.entries(CHAINS).find(([, cfg]) => cfg.llamaNames.includes(name))?.[0] || null;
}

async function tokenMeta(rpc, chainId, address, prices) {
  const cfg = CHAINS[chainId];
  const addr = normalizeAddress(address);
  if (!cfg || !addr) return null;
  const [code, decimalsRaw, symbolRaw, symbolBytesRaw, nameRaw, nameBytesRaw, totalSupplyRaw] = await Promise.all([
    getCode(rpc, addr),
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, BYTES32_TOKEN, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, BYTES32_TOKEN, "name"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
  ]);
  const symbol = safeText(symbolRaw?.[0], 40) || decodeBytes32String(symbolBytesRaw?.[0]);
  const name = safeText(nameRaw?.[0], 80) || decodeBytes32String(nameBytesRaw?.[0]);
  const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
  const key = `${cfg.coinSlug}:${addr.toLowerCase()}`;
  return {
    chainId: Number(chainId),
    chain: cfg.name,
    address: addr,
    symbol,
    name,
    decimals,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    totalSupplyRaw: totalSupplyRaw?.[0] === undefined ? null : totalSupplyRaw[0].toString(),
    priceUsd: prices[key] ?? stableFallback(symbol),
  };
}

async function loadPrices(keys) {
  const out = {};
  const uniqueKeys = unique(keys).map((k) => String(k).toLowerCase());
  for (let i = 0; i < uniqueKeys.length; i += 80) {
    const chunk = uniqueKeys.slice(i, i + 80);
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${chunk.join(",")}?searchWidth=6h`, 30_000);
    for (const [key, value] of Object.entries(json?.coins || {})) {
      const price = asNumber(value?.price);
      if (price !== null) out[key.toLowerCase()] = price;
    }
  }
  return out;
}

async function resolvePair(rpc, factory, tokenA, tokenB) {
  const raw = await safeCall(rpc, factory, V2_FACTORY, "getPair", [tokenA, tokenB]);
  const pair = normalizeAddress(raw?.[0]);
  return pair && lowerAddress(pair) !== ZERO ? pair : null;
}

function pairKey(tokenA, tokenB) {
  return [lowerAddress(tokenA), lowerAddress(tokenB)].filter(Boolean).sort().join(":");
}

async function inspectFactory(chainId, rpc, yieldRows) {
  const cfg = CHAINS[chainId];
  const [factoryCode, routerCode, allPairsLengthRaw, feeToRaw, feeToSetterRaw] = await Promise.all([
    getCode(rpc, cfg.factory),
    cfg.router ? getCode(rpc, cfg.router) : Promise.resolve("0x"),
    safeCall(rpc, cfg.factory, V2_FACTORY, "allPairsLength"),
    safeCall(rpc, cfg.factory, V2_FACTORY, "feeTo"),
    safeCall(rpc, cfg.factory, V2_FACTORY, "feeToSetter"),
  ]);
  const factoryCodePresent = Boolean(factoryCode && factoryCode !== "0x");
  const allPairsLength = allPairsLengthRaw?.[0] === undefined ? null : Number(allPairsLengthRaw[0]);
  const selected = new Map();
  function add(pair, source, tokens = []) {
    const addr = lowerAddress(pair);
    if (!addr) return;
    if (!selected.has(addr)) selected.set(addr, { pair: normalizeAddress(pair), sources: new Set(), sourceTokens: [] });
    selected.get(addr).sources.add(source);
    if (tokens.length) selected.get(addr).sourceTokens.push(tokens.map(normalizeAddress).filter(Boolean));
  }

  const coreAssets = Object.values(cfg.coreAssets || {}).map(normalizeAddress).filter(Boolean);
  const seenCore = new Set();
  if (factoryCodePresent) {
    for (let i = 0; i < coreAssets.length; i++) {
      for (let j = i + 1; j < coreAssets.length; j++) {
        const key = pairKey(coreAssets[i], coreAssets[j]);
        if (seenCore.has(key)) continue;
        seenCore.add(key);
        const pair = await resolvePair(rpc, cfg.factory, coreAssets[i], coreAssets[j]);
        if (pair) add(pair, "core-asset-pair", [coreAssets[i], coreAssets[j]]);
      }
    }
    for (const row of yieldRows) {
      const pair = await resolvePair(rpc, cfg.factory, row.underlying[0], row.underlying[1]);
      if (pair) add(pair, `public-yield:${row.symbol || row.poolId || "row"}`, row.underlying);
    }
    const enumCount = Math.min(allPairsLength || 0, MAX_ENUM_PAIRS_PER_CHAIN);
    const enumPairs = await mapLimit(Array.from({ length: enumCount }, (_, i) => i), RPC_CONCURRENCY, async (i) => {
      const raw = await safeCall(rpc, cfg.factory, V2_FACTORY, "allPairs", [i]);
      return normalizeAddress(raw?.[0]);
    });
    for (const pair of enumPairs) add(pair, "factory-prefix-enumeration");
  }

  return {
    chainId: Number(chainId),
    chain: cfg.name,
    factory: cfg.factory,
    router: cfg.router,
    factoryCodePresent,
    routerCodePresent: Boolean(routerCode && routerCode !== "0x"),
    allPairsLength,
    feeTo: normalizeAddress(feeToRaw?.[0]),
    feeToSetter: normalizeAddress(feeToSetterRaw?.[0]),
    corePairsResolved: [...selected.values()].filter((row) => row.sources.has("core-asset-pair")).length,
    yieldPairsResolved: [...selected.values()].filter((row) => [...row.sources].some((s) => s.startsWith("public-yield:"))).length,
    pairsSelected: selected.size,
    enumerationCapped: allPairsLength !== null && allPairsLength > MAX_ENUM_PAIRS_PER_CHAIN,
    pairSelections: [...selected.values()].map((row) => ({ pair: row.pair, sources: [...row.sources], sourceTokens: row.sourceTokens.slice(0, 5) })),
  };
}

async function inspectPairs(chainId, rpc, selections) {
  const cfg = CHAINS[chainId];
  const firstPass = await mapLimit(selections, RPC_CONCURRENCY, async (selection) => {
    const pair = selection.pair;
    const [code, token0Raw, token1Raw, reservesRaw, totalSupplyRaw, decimalsRaw, symbolRaw, nameRaw, price0Raw, price1Raw] = await Promise.all([
      getCode(rpc, pair),
      safeCall(rpc, pair, V2_PAIR, "token0"),
      safeCall(rpc, pair, V2_PAIR, "token1"),
      safeCall(rpc, pair, V2_PAIR, "getReserves"),
      safeCall(rpc, pair, V2_PAIR, "totalSupply"),
      safeCall(rpc, pair, V2_PAIR, "decimals"),
      safeCall(rpc, pair, V2_PAIR, "symbol"),
      safeCall(rpc, pair, V2_PAIR, "name"),
      safeCall(rpc, pair, V2_PAIR, "price0CumulativeLast"),
      safeCall(rpc, pair, V2_PAIR, "price1CumulativeLast"),
    ]);
    return {
      chainId: Number(chainId),
      chain: cfg.name,
      pair,
      factory: cfg.factory,
      codePresent: Boolean(code && code !== "0x"),
      codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
      token0: normalizeAddress(token0Raw?.[0]),
      token1: normalizeAddress(token1Raw?.[0]),
      reserve0Raw: reservesRaw?.[0] === undefined ? null : reservesRaw[0].toString(),
      reserve1Raw: reservesRaw?.[1] === undefined ? null : reservesRaw[1].toString(),
      blockTimestampLast: reservesRaw?.[2] === undefined ? null : Number(reservesRaw[2]),
      totalSupplyRaw: totalSupplyRaw?.[0] === undefined ? null : totalSupplyRaw[0].toString(),
      decimals: decimalsRaw?.[0] === undefined ? 18 : Number(decimalsRaw[0]),
      symbol: safeText(symbolRaw?.[0], 60),
      name: safeText(nameRaw?.[0], 120),
      price0CumulativeLastRaw: price0Raw?.[0] === undefined ? null : price0Raw[0].toString(),
      price1CumulativeLastRaw: price1Raw?.[0] === undefined ? null : price1Raw[0].toString(),
      discoverySources: selection.sources || [],
      routePositive: false,
    };
  });

  const priceKeys = [];
  for (const row of firstPass) {
    for (const token of [row.token0, row.token1]) {
      const addr = lowerAddress(token);
      if (addr) priceKeys.push(`${cfg.coinSlug}:${addr}`);
    }
  }
  const prices = await loadPrices(priceKeys);
  const metaCache = new Map();
  async function meta(token) {
    const addr = lowerAddress(token);
    if (!addr) return null;
    const key = `${chainId}:${addr}`;
    if (!metaCache.has(key)) metaCache.set(key, tokenMeta(rpc, chainId, token, prices));
    return await metaCache.get(key);
  }

  const withMeta = await mapLimit(firstPass, RPC_CONCURRENCY, async (row) => {
    const [token0Meta, token1Meta] = await Promise.all([meta(row.token0), meta(row.token1)]);
    const reserve0 = decimalsToNumber(row.reserve0Raw, token0Meta?.decimals);
    const reserve1 = decimalsToNumber(row.reserve1Raw, token1Meta?.decimals);
    const reserve0Usd = reserve0 !== null && token0Meta?.priceUsd !== null && token0Meta?.priceUsd !== undefined ? reserve0 * token0Meta.priceUsd : null;
    const reserve1Usd = reserve1 !== null && token1Meta?.priceUsd !== null && token1Meta?.priceUsd !== undefined ? reserve1 * token1Meta.priceUsd : null;
    const knownUsd = (reserve0Usd || 0) + (reserve1Usd || 0);
    const poolTvlUsd = reserve0Usd !== null && reserve1Usd !== null ? knownUsd : knownUsd > 0 ? knownUsd * 2 : null;
    const totalSupply = decimalsToNumber(row.totalSupplyRaw, row.decimals);
    const lpPriceUsd = poolTvlUsd !== null && totalSupply ? poolTvlUsd / totalSupply : null;
    return {
      ...row,
      token0Meta,
      token1Meta,
      reserve0: round(reserve0, 8),
      reserve1: round(reserve1, 8),
      reserve0Usd: round(reserve0Usd, 2),
      reserve1Usd: round(reserve1Usd, 2),
      poolTvlUsd: round(poolTvlUsd, 2),
      poolTvlInferred: reserve0Usd === null || reserve1Usd === null,
      lpPriceUsd: round(lpPriceUsd, 8),
      symbolPair: `${token0Meta?.symbol || compactAddress(row.token0)}/${token1Meta?.symbol || compactAddress(row.token1)}`,
      material: (asNumber(poolTvlUsd) || 0) >= MIN_MATERIAL_POOL_TVL_USD,
    };
  });

  return withMeta.sort((a, b) => (asNumber(b.poolTvlUsd) || 0) - (asNumber(a.poolTvlUsd) || 0));
}

function primitiveAddresses(value, out = new Set()) {
  if (typeof value === "string") {
    for (const m of value.matchAll(/0x[0-9a-fA-F]{40}/g)) out.add(m[0].toLowerCase());
  } else if (Array.isArray(value)) {
    for (const item of value) primitiveAddresses(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) primitiveAddresses(item, out);
  }
  return out;
}

function summarizeContext(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const fields = ["id", "protocol", "project", "name", "chain", "chainId", "surface", "side", "symbol", "asset", "token", "collateral", "borrowAsset", "loanAsset", "oracle", "source", "status", "routePositive", "watchCandidate", "liquidityUsd", "borrowCashUsd", "cashUsd", "borrowAssetsUsd", "supplyAssetsUsd", "file", "rootFile"];
  const out = {};
  for (const field of fields) {
    const value = obj[field];
    if (value === undefined) continue;
    if (typeof value === "object") out[field] = safeText(JSON.stringify(value), 180);
    else out[field] = safeText(value, 180);
  }
  return out;
}

function scanObjectForAddresses(source, obj, addressRoles, out, depth = 0) {
  if (!obj || depth > 9 || out.length >= 700) return;
  if (Array.isArray(obj)) {
    for (const item of obj) scanObjectForAddresses(source, item, addressRoles, out, depth + 1);
    return;
  }
  if (typeof obj !== "object") return;
  const addrs = primitiveAddresses(obj);
  const hits = [...addrs].filter((addr) => addressRoles[addr]);
  if (hits.length) {
    const roles = unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.role)));
    out.push({
      source,
      hitRoles: roles,
      hitAddresses: hits.slice(0, 12),
      pairs: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.pair)).filter(Boolean)).slice(0, 10),
      context: summarizeContext(obj),
      directConsumer: DIRECT_SOURCE_SET.has(source) && roles.some((role) => DIRECT_ROLES.has(role)),
      routePositive: false,
      blocker: "Local artifact address match is context only unless the Uniswap V2 LP/pair itself is consumed by oracle/collateral logic with exact positive economics",
    });
    return;
  }
  for (const value of Object.values(obj)) scanObjectForAddresses(source, value, addressRoles, out, depth + 1);
}

function localConsumerJoins(pairRows) {
  const roles = {};
  function add(addr, role, pair, chain, symbolPair) {
    const lower = lowerAddress(addr);
    if (!lower || lower === ZERO) return;
    if (!roles[lower]) roles[lower] = [];
    roles[lower].push({ role, pair, chain, symbolPair });
  }
  for (const row of pairRows) {
    add(row.pair, "v2Pair", row.pair, row.chain, row.symbolPair);
    add(row.factory, "factory", row.pair, row.chain, row.symbolPair);
    add(row.token0, "token0", row.pair, row.chain, row.symbolPair);
    add(row.token1, "token1", row.pair, row.chain, row.symbolPair);
  }
  const matches = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) {
    const json = readJson(path.join(WORKSPACE, rel), null);
    if (!json) continue;
    scanObjectForAddresses(source, json, roles, matches);
  }
  const directPairConsumerRows = matches.filter((row) => row.directConsumer);
  const tokenContextRows = matches.filter((row) => !row.directConsumer);
  return { matches, directPairConsumerRows, tokenContextRows };
}

function buildReport(artifact) {
  const s = artifact.summary;
  const factoryTable = artifact.factoryRows.map((row) => `| ${row.chain} | ${compactAddress(row.factory)} | ${row.factoryCodePresent ? "yes" : "no"} | ${row.allPairsLength ?? "n/a"} | ${row.pairsSelected} | ${row.corePairsResolved} | ${row.yieldPairsResolved} |`).join("\n");
  const topPairs = artifact.pairRows.slice(0, 12);
  const pairTable = topPairs.length ? topPairs.map((row) => `| ${row.chain} | ${compactAddress(row.pair)} | ${row.symbolPair} | ${formatUsd(row.poolTvlUsd)} | ${row.discoverySources.slice(0, 2).join(", ") || "n/a"} | ${row.poolTvlInferred ? "yes" : "no"} |`).join("\n") : "| n/a | n/a | n/a | n/a | n/a | n/a |";
  const yieldTable = artifact.yieldRows.length ? artifact.yieldRows.slice(0, 8).map((row) => `| ${row.chain} | ${row.symbol || "n/a"} | ${formatUsd(row.tvlUsd)} | ${row.apyPct ?? "n/a"} | ${row.underlying.map(compactAddress).join(", ")} |`).join("\n") : "| none | n/a | n/a | n/a | n/a |";
  const consumerTable = artifact.directPairConsumerRows.length ? artifact.directPairConsumerRows.slice(0, 10).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${row.pairs.map(compactAddress).join(", ") || "n/a"} | ${safeText(row.context?.protocol || row.context?.project || row.context?.name || row.context?.surface || row.context?.file || "context", 80)} |`).join("\n") : "| none | n/a | n/a | n/a | no Uniswap V2 pair/LP address was found in consumer-grade artifacts |";

  return `# ${SIGNAL_DORMANT} - Uniswap V2 Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit. Uniswap V2 factories, selected core/yield pairs, reserves, LP pricing context, and local consumer joins were mapped across RPC-available chains. Token-level matches are common-asset context only; route-positive requires a trusted consumer that prices a Uniswap V2 LP/pair or oracle path plus exact positive manipulation, borrow/redeem/liquidation, and exit economics.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Chains with RPC | ${s.chainsScanned} |
| Unsupported protocol chains | ${artifact.unsupportedProtocolChains.join(", ") || "none"} |
| Factories code-present | ${s.factoriesCodePresent} |
| Pairs selected | ${s.pairsSelected} |
| Pairs inspected | ${s.pairsInspected} |
| Material pairs | ${s.materialPairRows} |
| Public yield rows | ${s.publicYieldRows} |
| Direct pair consumer rows | ${s.directPairConsumerRows} |
| Token context rows | ${s.tokenContextRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |

## Factories

| Chain | Factory | Code | Total pairs | Selected | Core pairs | Yield pairs |
|---|---|---|---:|---:|---:|---:|
${factoryTable}

## Top Selected Pairs

| Chain | Pair | Tokens | Pool TVL | Discovery | Inferred TVL |
|---|---|---|---:|---|---|
${pairTable}

## Public Yield Rows

| Chain | Symbol | TVL | APY % | Underlying |
|---|---|---:|---:|---|
${yieldTable}

## Direct Consumer Join

| Source | Hit roles | Addresses | Pairs | Context |
|---|---|---|---|---|
${consumerTable}

## Blockers

- No Uniswap V2 pair/LP address is currently found as value-bearing collateral, reserve asset, or oracle-specific consumer in scanned consumer-grade artifacts.
- Token-level joins are dominated by common assets such as WETH, USDC, USDT, DAI, WBTC, and native wrappers.
- Public yield APY is not impact without a consumer that trusts the LP/share value or a permissionless redemption/borrow route.
- V2 spot/TWAP manipulation is not impact without a consumer and exact positive manipulation economics.
- No fork extraction proof exists.

## Required For Route-Positive

- A deployed lending, vault, margin, or oracle consumer references a Uniswap V2 pair/LP or V2 oracle path.
- The referenced pair state is permissionlessly movable or stale in an attacker-favorable direction.
- Borrow, redemption, liquidation, or settlement liquidity is material and exact-quoted after fees, gas, and slippage.
- Fork extraction proof shows positive net value.

Artifacts: \`reports/raw/fast/uniswap-v2-phase0.json\`.
`;
}

async function main() {
  const metadata = protocolMetadata();
  const yieldRows = uniswapYieldRows();
  const chainIds = Object.keys(CHAINS).map(Number);
  const rpcs = await resolveRpcPool(chainIds);
  const factoryRows = [];
  const allPairs = [];

  for (const chainId of chainIds) {
    const rpc = rpcs[chainId];
    const cfg = CHAINS[chainId];
    const chainYieldRows = yieldRows.filter((row) => String(chainForLlamaName(row.chain)) === String(chainId));
    if (!rpc) {
      factoryRows.push({ chainId, chain: cfg.name, factory: cfg.factory, rpcAvailable: false, factoryCodePresent: false, allPairsLength: null, pairsSelected: 0, corePairsResolved: 0, yieldPairsResolved: 0, pairSelections: [] });
      continue;
    }
    const factory = await inspectFactory(chainId, rpc, chainYieldRows);
    factory.rpcAvailable = true;
    factoryRows.push(factory);
    if (factory.pairSelections.length) {
      const pairRows = await inspectPairs(chainId, rpc, factory.pairSelections.map((row) => ({ ...row, sources: row.sources || [] })));
      allPairs.push(...pairRows);
    }
  }

  allPairs.sort((a, b) => (asNumber(b.poolTvlUsd) || 0) - (asNumber(a.poolTvlUsd) || 0));
  const joins = localConsumerJoins(allPairs);
  const directPairConsumerRows = joins.directPairConsumerRows;
  const directPairSet = new Set(directPairConsumerRows.flatMap((row) => row.pairs.map(lowerAddress)).filter(Boolean));
  const watchCandidates = allPairs
    .filter((row) => directPairSet.has(lowerAddress(row.pair)) && (asNumber(row.poolTvlUsd) || 0) >= MIN_WATCH_POOL_TVL_USD)
    .map((row) => ({ ...row, reason: "Uniswap V2 pair/LP address appears in a consumer artifact and has material TVL", routePositive: false }));

  const summary = {
    chainsScanned: factoryRows.filter((row) => row.rpcAvailable).length,
    chainsWithRpc: factoryRows.filter((row) => row.rpcAvailable).map((row) => row.chainId),
    chainsMissingRpc: factoryRows.filter((row) => !row.rpcAvailable).map((row) => row.chainId),
    unsupportedProtocolChains: UNSUPPORTED_PROTOCOL_CHAINS.length,
    factoriesCodePresent: factoryRows.filter((row) => row.factoryCodePresent).length,
    pairsAvailable: factoryRows.reduce((sum, row) => sum + (asNumber(row.allPairsLength) || 0), 0),
    pairsSelected: factoryRows.reduce((sum, row) => sum + (asNumber(row.pairsSelected) || 0), 0),
    pairsInspected: allPairs.length,
    materialPairRows: allPairs.filter((row) => (asNumber(row.poolTvlUsd) || 0) >= MIN_MATERIAL_POOL_TVL_USD).length,
    publicYieldRows: yieldRows.length,
    publicYieldRowsResolved: factoryRows.reduce((sum, row) => sum + (asNumber(row.yieldPairsResolved) || 0), 0),
    directPairConsumerRows: directPairConsumerRows.length,
    tokenContextRows: joins.tokenContextRows.length,
    watchCandidates: watchCandidates.length,
    maxPoolTvlUsd: round(Math.max(0, ...allPairs.map((row) => asNumber(row.poolTvlUsd) || 0)), 2),
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    closedReason: directPairConsumerRows.length
      ? "Uniswap V2 pair consumer references found, but no exact-positive manipulation/borrow/exit economics or fork proof"
      : "no Uniswap V2 pair/LP address is referenced by scanned consumer-grade artifacts",
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-uniswap-v2-phase0.js",
    scope: "Read-only Uniswap V2 pair/LP and consumer-route Phase 0 scan",
    target: {
      name: "Uniswap V2",
      slug: "uniswap-v2",
      category: "Dexs",
      surface: "dex-oracle-consumer-only",
      metadata,
    },
    safety: {
      publicApisOnlyForMetadata: true,
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    thresholds: {
      maxEnumPairsPerChain: MAX_ENUM_PAIRS_PER_CHAIN,
      minMaterialPoolTvlUsd: MIN_MATERIAL_POOL_TVL_USD,
      minWatchPoolTvlUsd: MIN_WATCH_POOL_TVL_USD,
    },
    docs: {
      adapter: "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/uniswap-v2/index.js",
      factorySource: "https://github.com/Uniswap/v2-core",
      peripherySource: "https://github.com/Uniswap/v2-periphery",
    },
    unsupportedProtocolChains: UNSUPPORTED_PROTOCOL_CHAINS,
    yieldRows,
    factoryRows: factoryRows.map((row) => ({ ...row, pairSelections: undefined })),
    pairRows: allPairs,
    directPairConsumerRows,
    tokenContextRows: joins.tokenContextRows.slice(0, 150),
    watchCandidates,
    routePositiveRows: [],
    summary,
    blockers: [
      "No Uniswap V2 pair/LP address is referenced by scanned consumer-grade artifacts",
      "Token-level matches are common-asset context and not Uniswap-specific impact",
      "Public yield APY and V2 reserves do not prove accepted-value divergence or extractive consumer economics",
      "No exact positive acquisition/manipulation/borrow/exit economics or fork proof",
    ],
    requiredForRoutePositive: [
      "deployed consumer references a Uniswap V2 pair/LP or V2 oracle path",
      "pair/oracle state is permissionlessly movable or stale in attacker-favorable direction",
      "borrow, redemption, liquidation, or settlement route is exact-quoted and positive",
      "fork extraction proof",
    ],
    nextReadOnlyStep: directPairConsumerRows.length
      ? "Static-review the matched consumer and exact-quote only if Uniswap V2 pair state affects accepted value."
      : "Reopen Uniswap V2 only if a lending/oracle consumer references a V2 pair/LP or a new adapter consumes V2 oracle state.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));

  if (!QUIET) {
    console.log(`Uniswap V2 Phase 0: pairs=${summary.pairsInspected} material=${summary.materialPairRows} directPairConsumers=${summary.directPairConsumerRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
