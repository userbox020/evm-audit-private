#!/usr/bin/env node
// Read-only small-cap oracle manipulation route discovery.
// RPC URLs are resolved from local inventory in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
let ethers;
try { ({ ethers } = require("ethers")); } catch (_) { ({ ethers } = require("./node_modules/ethers")); }

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const CONSUMER_FIRST = path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json");
const FOCUSED_EULER = path.join(WORKSPACE, "reports", "raw", "fast", "focused-euler-evk-review-producers.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "small-cap-oracle-manipulation-routes.json");

const QUIET = process.argv.includes("--quiet");
const TIMEOUT_MS = 15_000;
const MIN_ROUTE_LIQUIDITY_USD = Number(process.env.SMALL_CAP_ORACLE_MIN_ROUTE_LIQUIDITY_USD || "10000");
const MAX_ROWS = Number(process.env.SMALL_CAP_ORACLE_MAX_ROWS || "90");
const MIN_POOL_RESERVE_USD = Number(process.env.SMALL_CAP_ORACLE_MIN_POOL_RESERVE_USD || "250");
const MAX_POOL_RESERVE_USD = Number(process.env.SMALL_CAP_ORACLE_MAX_POOL_RESERVE_USD || "500000");
const SAFETY_BPS = Number(process.env.SMALL_CAP_ORACLE_SAFETY_BPS || "250");
const SLIPPAGE_BUFFER_BPS = Number(process.env.SMALL_CAP_ORACLE_SLIPPAGE_BUFFER_BPS || "100");
const MIN_PROFIT_USD = Number(process.env.SMALL_CAP_ORACLE_MIN_PROFIT_USD || "25");
const GAS_UNITS = Number(process.env.SMALL_CAP_ORACLE_GAS_UNITS || "2500000");

const CHAIN_CONFIGS = {
  1: {
    name: "Ethereum",
    coinSlug: "ethereum",
    gasPriceKey: "coingecko:ethereum",
    baseTokens: [
      { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
      { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
    ],
  },
  10: {
    name: "Optimism",
    coinSlug: "optimism",
    gasPriceKey: "coingecko:ethereum",
    baseTokens: [
      { symbol: "WETH", address: "0x4200000000000000000000000000000000000006" },
      { symbol: "USDC", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
      { symbol: "USDT", address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58" },
      { symbol: "DAI", address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" },
    ],
  },
  56: {
    name: "BNB Chain",
    coinSlug: "bsc",
    gasPriceKey: "coingecko:binancecoin",
    baseTokens: [
      { symbol: "WBNB", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" },
      { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955" },
      { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" },
      { symbol: "DAI", address: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3" },
    ],
  },
  137: {
    name: "Polygon",
    coinSlug: "polygon",
    gasPriceKey: "coingecko:matic-network",
    baseTokens: [
      { symbol: "WMATIC", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270" },
      { symbol: "USDC", address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" },
      { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" },
      { symbol: "DAI", address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063" },
    ],
  },
  8453: {
    name: "Base",
    coinSlug: "base",
    gasPriceKey: "coingecko:ethereum",
    baseTokens: [
      { symbol: "WETH", address: "0x4200000000000000000000000000000000000006" },
      { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      { symbol: "USDbC", address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA" },
      { symbol: "DAI", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" },
    ],
  },
  42161: {
    name: "Arbitrum",
    coinSlug: "arbitrum",
    gasPriceKey: "coingecko:ethereum",
    baseTokens: [
      { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" },
      { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
      { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" },
      { symbol: "DAI", address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" },
    ],
  },
};

const DEX_FACTORIES = {
  1: [
    { name: "UniswapV2", address: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", feeBps: 30 },
    { name: "SushiV2", address: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac", feeBps: 30 },
  ],
  10: [
    { name: "Velodrome", address: "0x25CbdDb98b35ab1FF77413456B31EC81A6B6B746", feeBps: 30 },
  ],
  56: [
    { name: "PancakeV2", address: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73", feeBps: 25 },
    { name: "SushiV2", address: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", feeBps: 30 },
  ],
  137: [
    { name: "QuickSwap", address: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32", feeBps: 30 },
    { name: "SushiV2", address: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", feeBps: 30 },
  ],
  8453: [
    { name: "SushiV2", address: "0x71524B4f93c58fcbF659783284E38825f0622859", feeBps: 30 },
    { name: "Aerodrome", address: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da", feeBps: 30 },
  ],
  42161: [
    { name: "SushiV2", address: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", feeBps: 30 },
  ],
};

const ERC20 = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const V2_FACTORY = new ethers.Interface(["function getPair(address,address) view returns (address)"]);
const V2_PAIR = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function lowerAddress(value) {
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
}

function round(value, decimals = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
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

function countBy(rows, getKey) {
  const out = {};
  for (const row of rows || []) {
    const key = getKey(row) || "unknown";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function maxNumber(rows, getValue) {
  const values = (rows || []).map(getValue).filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

function minNumber(rows, getValue) {
  const values = (rows || []).map(getValue).filter((value) => Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcPool(chainIds) {
  const wanted = new Set(chainIds.map(Number));
  const pool = {};
  for (const url of loadRpcUrls()) {
    try {
      const chainId = Number(BigInt(await rpcCall(url, "eth_chainId", [], 6000)));
      if (wanted.has(chainId) && !pool[chainId]) pool[chainId] = url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return pool;
}

async function safeCall(provider, to, iface, fn, args = []) {
  try {
    const target = normalizeAddress(to);
    if (!target) return null;
    const raw = await provider.call({ to: target, data: iface.encodeFunctionData(fn, args) });
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
}

async function tokenMeta(provider, token, fallback = {}) {
  const address = normalizeAddress(token);
  if (!address) return null;
  const [symbolRaw, decimalsRaw] = await Promise.all([
    safeCall(provider, address, ERC20, "symbol"),
    safeCall(provider, address, ERC20, "decimals"),
  ]);
  return {
    address,
    symbol: symbolRaw?.[0] ? String(symbolRaw[0]) : fallback.symbol || null,
    decimals: Number(decimalsRaw?.[0] ?? fallback.decimals ?? 18),
  };
}

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try { return Number(ethers.formatUnits(BigInt(raw), Number(decimals))); } catch (_) { return null; }
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 20_000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function priceKey(chainId, address) {
  const cfg = CHAIN_CONFIGS[Number(chainId)];
  const lower = lowerAddress(address);
  return cfg?.coinSlug && lower ? `${cfg.coinSlug}:${lower}`.toLowerCase() : null;
}

async function fetchPrices(refs, coinKeys = []) {
  const keyToRefs = new Map();
  for (const ref of refs || []) {
    const key = priceKey(ref?.chainId, ref?.address);
    if (!key) continue;
    const list = keyToRefs.get(key) || [];
    list.push({ chainId: Number(ref.chainId), address: lowerAddress(ref.address) });
    keyToRefs.set(key, list);
  }
  for (const key of coinKeys || []) {
    if (!key) continue;
    if (!keyToRefs.has(String(key).toLowerCase())) keyToRefs.set(String(key).toLowerCase(), []);
  }
  const keys = [...keyToRefs.keys()];
  const byAddress = new Map();
  const byCoinKey = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.slice(i, i + 50).join(",")}?searchWidth=6h`, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    for (const [key, row] of Object.entries(json.coins || {})) {
      const price = Number(row?.price || 0);
      if (price <= 0) continue;
      const lowerKey = key.toLowerCase();
      byCoinKey.set(lowerKey, price);
      for (const ref of keyToRefs.get(lowerKey) || []) byAddress.set(`${ref.chainId}:${ref.address}`, price);
    }
  }
  return { byAddress, byCoinKey };
}

function priceFromMap(prices, chainId, address) {
  const lower = lowerAddress(address);
  return lower ? prices.byAddress.get(`${Number(chainId)}:${lower}`) || null : null;
}

function focusedEulerOracleMap() {
  const artifact = readJson(FOCUSED_EULER, {});
  const map = new Map();
  for (const row of artifact?.rows || []) {
    const key = rowKey(row);
    const oracle = normalizeAddress(row?.euler?.oracle);
    if (key && oracle) map.set(key, oracle);
  }
  return map;
}

function rowKey(row) {
  const chainId = Number(row?.chainId);
  const consumer = lowerAddress(row?.consumer?.evault || row?.consumer?.comet || row?.consumer?.silo || row?.consumer?.marketId || row?.consumer?.id);
  const collateral = lowerAddress(row?.collateral?.address || row?.consumer?.collateralAsset?.address);
  const borrow = lowerAddress(row?.borrowAsset?.address || row?.consumer?.asset || row?.consumer?.baseToken);
  if (!chainId || !collateral || !borrow) return null;
  return `${chainId}:${consumer || "unknown"}:${collateral}:${borrow}`;
}

function oracleAddresses(row, eulerOracleByKey) {
  const candidates = [
    row?.consumer?.oracle,
    row?.consumer?.priceFeed,
    row?.consumer?.solvencyOracle,
    row?.consumer?.maxLtvOracle,
    row?.consumer?.priceOracle,
    row?.oracle,
    eulerOracleByKey.get(rowKey(row)),
  ];
  return [...new Set(candidates.map(normalizeAddress).filter(Boolean))];
}

function collectRows() {
  const artifact = readJson(CONSUMER_FIRST, {});
  const eulerOracleByKey = focusedEulerOracleMap();
  const rows = [];
  for (const result of artifact?.results || []) {
    const chainId = Number(result?.chainId);
    if (!CHAIN_CONFIGS[chainId] || !DEX_FACTORIES[chainId]) continue;
    for (const row of result?.highLtvRowsDetail || []) {
      const collateral = lowerAddress(row?.collateral?.address || row?.consumer?.collateralAsset?.address);
      const borrow = lowerAddress(row?.borrowAsset?.address || row?.consumer?.asset || row?.consumer?.baseToken);
      const ltv = Number(row?.ltv || 0);
      const routeLiquidityUsd = Number(row?.routeLiquidityUsd || row?.baseCash || 0);
      if (!collateral || !borrow || ltv <= 0 || routeLiquidityUsd < MIN_ROUTE_LIQUIDITY_USD) continue;
      rows.push({ ...row, chainId, oracleAddresses: oracleAddresses(row, eulerOracleByKey) });
    }
  }
  const seen = new Set();
  const deduped = [];
  for (const row of rows.sort((a, b) => Number(b.routeLiquidityUsd || 0) - Number(a.routeLiquidityUsd || 0))) {
    const key = rowKey(row) || `${row.chainId}:${lowerAddress(row.collateral?.address)}:${lowerAddress(row.borrowAsset?.address)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped.slice(0, MAX_ROWS);
}

async function findPair(provider, factory, tokenA, tokenB) {
  const raw = await safeCall(provider, factory.address, V2_FACTORY, "getPair", [tokenA, tokenB]);
  const pair = raw?.[0] ? normalizeAddress(raw[0]) : null;
  return pair && pair !== ethers.ZeroAddress ? pair : null;
}

async function pairInfo(provider, pairAddress) {
  const [token0Raw, token1Raw, reservesRaw] = await Promise.all([
    safeCall(provider, pairAddress, V2_PAIR, "token0"),
    safeCall(provider, pairAddress, V2_PAIR, "token1"),
    safeCall(provider, pairAddress, V2_PAIR, "getReserves"),
  ]);
  const token0 = normalizeAddress(token0Raw?.[0]);
  const token1 = normalizeAddress(token1Raw?.[0]);
  if (!token0 || !token1 || !reservesRaw) return null;
  return { token0, token1, reserve0Raw: BigInt(reservesRaw[0]), reserve1Raw: BigInt(reservesRaw[1]) };
}

function hexContainsAddress(code, address) {
  const body = String(code || "").toLowerCase();
  const needle = String(address || "").toLowerCase().replace(/^0x/, "");
  return Boolean(needle && body.includes(needle));
}

async function oracleCodeLinks(provider, oracleAddressesForRow, pair, collateral, quoteToken) {
  const links = [];
  for (const oracle of oracleAddressesForRow || []) {
    try {
      const code = await provider.getCode(oracle);
      if (!code || code === "0x") {
        links.push({ oracle, codePresent: false, referencesPair: false, referencesCollateral: false, referencesQuoteToken: false, linkStrength: "none" });
        continue;
      }
      const referencesPair = hexContainsAddress(code, pair);
      const referencesCollateral = hexContainsAddress(code, collateral);
      const referencesQuoteToken = hexContainsAddress(code, quoteToken);
      const linkStrength = referencesPair ? "pool-address" : referencesCollateral && referencesQuoteToken ? "both-token-addresses" : referencesCollateral || referencesQuoteToken ? "single-token-address" : "none";
      links.push({ oracle, codePresent: true, codeBytes: (code.length - 2) / 2, referencesPair, referencesCollateral, referencesQuoteToken, linkStrength });
    } catch (_) {
      links.push({ oracle, codePresent: null, referencesPair: false, referencesCollateral: false, referencesQuoteToken: false, linkStrength: "query-failed" });
    }
  }
  return links;
}

function modelManipulation({ ltv, routeLiquidityUsd, quoteReserveUsd, feeBps, gasUsd }) {
  if (!Number.isFinite(ltv) || ltv <= 0 || ltv >= 1 || !Number.isFinite(quoteReserveUsd) || quoteReserveUsd <= 0) return null;
  const samePoolBreakEvenBps = ((1 / (ltv * ltv)) - 1) * 10_000;
  const preOwnedBreakEvenBps = ((1 / ltv) - 1) * 10_000;
  const targetPremiumBps = samePoolBreakEvenBps + SAFETY_BPS;
  const targetMultiplier = 1 + targetPremiumBps / 10_000;
  const sqrtMultiplier = Math.sqrt(targetMultiplier);
  const feeRate = Math.max(0, Number(feeBps || 30)) / 10_000;
  const quoteInUsd = quoteReserveUsd * (sqrtMultiplier - 1) / Math.max(0.0001, 1 - feeRate);
  const acquiredFairCollateralUsd = quoteInUsd / sqrtMultiplier;
  const inflatedBorrowCapacityUsd = acquiredFairCollateralUsd * targetMultiplier * ltv;
  const borrowUsd = Math.min(routeLiquidityUsd, inflatedBorrowCapacityUsd);
  const roundTripFeeUsd = quoteInUsd * feeRate * 2;
  const slippageBufferUsd = quoteInUsd * SLIPPAGE_BUFFER_BPS / 10_000;
  const estimatedManipCostUsd = roundTripFeeUsd + slippageBufferUsd + (gasUsd || 0);
  const modeledNetUsd = borrowUsd - quoteInUsd - estimatedManipCostUsd;
  return {
    preOwnedBreakEvenBps: round(preOwnedBreakEvenBps, 6),
    samePoolBreakEvenBps: round(samePoolBreakEvenBps, 6),
    targetPremiumBps: round(targetPremiumBps, 6),
    targetMultiplier: round(targetMultiplier, 9),
    quoteInUsd: round(quoteInUsd, 6),
    acquiredFairCollateralUsd: round(acquiredFairCollateralUsd, 6),
    inflatedBorrowCapacityUsd: round(inflatedBorrowCapacityUsd, 6),
    borrowUsd: round(borrowUsd, 6),
    roundTripFeeUsd: round(roundTripFeeUsd, 6),
    slippageBufferUsd: round(slippageBufferUsd, 6),
    gasUsd: round(gasUsd || 0, 6),
    estimatedManipCostUsd: round(estimatedManipCostUsd, 6),
    modeledNetUsd: round(modeledNetUsd, 6),
  };
}

async function gasByChain(providers, prices) {
  const out = {};
  for (const [chainId, provider] of providers.entries()) {
    const cfg = CHAIN_CONFIGS[chainId];
    const gasPriceWei = await provider.send("eth_gasPrice", []).then(BigInt).catch(() => 0n);
    const nativeBasePriceUsd = cfg?.baseTokens?.[0]?.address ? priceFromMap(prices, chainId, cfg.baseTokens[0].address) : null;
    const gasAssetPriceUsd = cfg?.gasPriceKey ? prices.byCoinKey.get(cfg.gasPriceKey.toLowerCase()) || nativeBasePriceUsd : nativeBasePriceUsd;
    out[chainId] = {
      chainId,
      chain: cfg?.name || String(chainId),
      gasPriceWei: gasPriceWei.toString(),
      gasAssetPriceUsd,
      gasUsd: gasAssetPriceUsd && gasPriceWei > 0n ? Number(gasPriceWei) * GAS_UNITS / 1e18 * gasAssetPriceUsd : null,
    };
  }
  return out;
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rows = collectRows();
  const chainIds = [...new Set(rows.map((row) => Number(row.chainId)))].sort((a, b) => a - b);
  const rpcPool = await resolveRpcPool(chainIds);
  const providers = new Map();
  const blocks = {};
  for (const chainId of chainIds) {
    if (!rpcPool[chainId]) continue;
    const provider = new ethers.JsonRpcProvider(rpcPool[chainId], chainId, { staticNetwork: true });
    providers.set(chainId, provider);
    const block = await provider.getBlock("latest").catch(() => null);
    if (block) blocks[chainId] = { chain: CHAIN_CONFIGS[chainId]?.name || String(chainId), number: block.number, timestamp: block.timestamp, iso: new Date(Number(block.timestamp) * 1000).toISOString() };
  }

  const priceRefs = [];
  for (const row of rows) {
    priceRefs.push({ chainId: row.chainId, address: row.collateral?.address }, { chainId: row.chainId, address: row.borrowAsset?.address });
    for (const base of CHAIN_CONFIGS[row.chainId]?.baseTokens || []) priceRefs.push({ chainId: row.chainId, address: base.address });
  }
  const prices = await fetchPrices(priceRefs, chainIds.map((chainId) => CHAIN_CONFIGS[chainId]?.gasPriceKey));
  const gas = await gasByChain(providers, prices);

  const tokenMetaCache = new Map();
  async function cachedTokenMeta(provider, token, fallback = {}) {
    const key = `${provider?._network?.chainId || "unknown"}:${lowerAddress(token)}`;
    if (tokenMetaCache.has(key)) return tokenMetaCache.get(key);
    const meta = await tokenMeta(provider, token, fallback);
    tokenMetaCache.set(key, meta);
    return meta;
  }

  const poolCache = new Map();
  async function poolsForCollateral(provider, chainId, collateral) {
    const lower = lowerAddress(collateral);
    const key = `${chainId}:${lower}`;
    if (poolCache.has(key)) return poolCache.get(key);
    const pools = [];
    const bases = CHAIN_CONFIGS[chainId]?.baseTokens || [];
    for (const factory of DEX_FACTORIES[chainId] || []) {
      for (const base of bases) {
        const baseAddress = normalizeAddress(base.address);
        if (!baseAddress || lowerAddress(baseAddress) === lower) continue;
        const pair = await findPair(provider, factory, collateral, baseAddress).catch(() => null);
        if (!pair) continue;
        const info = await pairInfo(provider, pair).catch(() => null);
        if (!info) continue;
        pools.push({ factory, base: { ...base, address: baseAddress }, pair, info });
      }
    }
    poolCache.set(key, pools);
    return pools;
  }

  const enriched = [];
  let dexPairsFound = 0;
  let dexPairsModeled = 0;
  let oracleLinkedRows = 0;
  for (const row of rows) {
    const chainId = Number(row.chainId);
    const provider = providers.get(chainId);
    const collateralAddress = normalizeAddress(row.collateral?.address);
    const borrowAddress = normalizeAddress(row.borrowAsset?.address || row.consumer?.asset || row.consumer?.baseToken);
    if (!provider || !collateralAddress || !borrowAddress) {
      enriched.push({ protocol: row.protocol, chainId, chain: row.chain || CHAIN_CONFIGS[chainId]?.name || String(chainId), collateral: row.collateral || null, borrowAsset: row.borrowAsset || null, routePositive: false, watchCandidate: false, blockers: [provider ? "Missing collateral or borrow token address" : "Missing RPC for configured chain"] });
      continue;
    }
    const [collateralMeta, borrowMeta] = await Promise.all([
      cachedTokenMeta(provider, collateralAddress, row.collateral || {}),
      cachedTokenMeta(provider, borrowAddress, row.borrowAsset || {}),
    ]);
    const pools = await poolsForCollateral(provider, chainId, collateralAddress);
    dexPairsFound += pools.length;
    const routeLiquidityUsd = Number(row.routeLiquidityUsd || row.baseCash || 0);
    const ltv = Number(row.ltv || 0);
    const modeledPools = [];

    for (const pool of pools) {
      const quoteToken = lowerAddress(pool.info.token0) === lowerAddress(collateralAddress) ? pool.info.token1 : pool.info.token0;
      const collateralIs0 = lowerAddress(pool.info.token0) === lowerAddress(collateralAddress);
      const quoteReserveRaw = collateralIs0 ? pool.info.reserve1Raw : pool.info.reserve0Raw;
      const collateralReserveRaw = collateralIs0 ? pool.info.reserve0Raw : pool.info.reserve1Raw;
      const quoteMeta = await cachedTokenMeta(provider, quoteToken, pool.base);
      const quotePriceUsd = priceFromMap(prices, chainId, quoteToken);
      const collateralPriceUsd = priceFromMap(prices, chainId, collateralAddress);
      const quoteReserve = formatUnitsNumber(quoteReserveRaw, quoteMeta?.decimals ?? 18);
      const collateralReserve = formatUnitsNumber(collateralReserveRaw, collateralMeta?.decimals ?? 18);
      const quoteReserveUsd = quoteReserve !== null && quotePriceUsd ? quoteReserve * quotePriceUsd : null;
      const collateralReserveUsd = collateralReserve !== null && collateralPriceUsd ? collateralReserve * collateralPriceUsd : null;
      const poolReserveUsd = Math.max(quoteReserveUsd || 0, collateralReserveUsd || 0);
      if (!Number.isFinite(poolReserveUsd) || poolReserveUsd < MIN_POOL_RESERVE_USD) continue;
      dexPairsModeled += 1;
      const economics = modelManipulation({ ltv, routeLiquidityUsd, quoteReserveUsd: poolReserveUsd, feeBps: pool.factory.feeBps, gasUsd: gas[chainId]?.gasUsd || 0 });
      const oracleLinks = await oracleCodeLinks(provider, row.oracleAddresses || [], pool.pair, collateralAddress, quoteToken);
      const hasStrongOracleLink = oracleLinks.some((link) => link.linkStrength === "pool-address" || link.linkStrength === "both-token-addresses");
      modeledPools.push({
        dex: pool.factory.name,
        factory: pool.factory.address,
        pair: pool.pair,
        feeBps: pool.factory.feeBps,
        quoteToken,
        quoteSymbol: quoteMeta?.symbol || pool.base.symbol || null,
        quoteReserve: round(quoteReserve, 6),
        collateralReserve: round(collateralReserve, 6),
        quoteReserveUsd: round(quoteReserveUsd, 6),
        collateralReserveUsd: round(collateralReserveUsd, 6),
        poolReserveUsd: round(poolReserveUsd, 6),
        belowMaxSmallCapReserve: poolReserveUsd <= MAX_POOL_RESERVE_USD,
        oracleLinks,
        hasStrongOracleLink,
        economics,
      });
    }

    modeledPools.sort((a, b) => Number(b.hasStrongOracleLink) - Number(a.hasStrongOracleLink)
      || Number(b.economics?.modeledNetUsd ?? -Infinity) - Number(a.economics?.modeledNetUsd ?? -Infinity)
      || Number(a.poolReserveUsd ?? Infinity) - Number(b.poolReserveUsd ?? Infinity));
    const best = modeledPools[0] || null;
    const preforkManipulationPositive = Boolean(
      best?.hasStrongOracleLink
      && best?.belowMaxSmallCapReserve
      && Number(best?.economics?.modeledNetUsd || 0) > MIN_PROFIT_USD
      && Number(best?.economics?.borrowUsd || 0) <= routeLiquidityUsd + 1e-6
    );
    if (modeledPools.some((pool) => pool.hasStrongOracleLink)) oracleLinkedRows += 1;
    const watchCandidate = preforkManipulationPositive;
    const blockers = [];
    if (!row.oracleAddresses?.length) blockers.push("No oracle/source address available in reusable consumer artifacts");
    if (!modeledPools.length) blockers.push("No V2-style DEX pool with priced reserve above minimum threshold");
    if (modeledPools.length && !modeledPools.some((pool) => pool.belowMaxSmallCapReserve)) blockers.push("DEX pools found but reserves are above small-cap manipulation threshold");
    if (modeledPools.length && !modeledPools.some((pool) => pool.hasStrongOracleLink)) blockers.push("Known oracle bytecode does not directly reference the modeled DEX pool or both pool tokens");
    if (modeledPools.some((pool) => pool.hasStrongOracleLink) && !(Number(best?.economics?.modeledNetUsd || 0) > MIN_PROFIT_USD)) blockers.push("Conservative same-pool acquisition/manipulation model is not net-positive");
    blockers.push("No fork proof or manipulated-oracle static validation");

    enriched.push({
      protocol: row.protocol,
      chainId,
      chain: row.chain || CHAIN_CONFIGS[chainId]?.name || String(chainId),
      consumer: row.consumer || null,
      collateral: collateralMeta,
      borrowAsset: borrowMeta,
      ltv,
      liquidationThreshold: asNumber(row.liquidationThreshold),
      routeLiquidityUsd: round(routeLiquidityUsd, 6),
      riskTags: row.riskTags || [],
      oracleAddresses: row.oracleAddresses || [],
      dexPoolsFound: pools.length,
      modeledPools: modeledPools.slice(0, 6),
      bestModeledPool: best,
      reviewCandidate: true,
      watchCandidate,
      preforkManipulationPositive,
      routePositive: false,
      routeGate: {
        status: watchCandidate ? "prefork-positive-needs-oracle-staticcall-and-fork" : modeledPools.length ? "modeled-route-blocked" : "no-priced-dex-pool",
        strongOraclePoolLink: Boolean(best?.hasStrongOracleLink),
        smallCapPool: Boolean(best?.belowMaxSmallCapReserve),
        exactOracleManipulationValidated: false,
        forkProof: false,
      },
      blockers,
    });
  }

  enriched.sort((a, b) => Number(b.watchCandidate) - Number(a.watchCandidate)
    || Number(b.preforkManipulationPositive) - Number(a.preforkManipulationPositive)
    || Number(b.bestModeledPool?.hasStrongOracleLink) - Number(a.bestModeledPool?.hasStrongOracleLink)
    || Number(b.bestModeledPool?.economics?.modeledNetUsd ?? -Infinity) - Number(a.bestModeledPool?.economics?.modeledNetUsd ?? -Infinity)
    || Number(b.routeLiquidityUsd || 0) - Number(a.routeLiquidityUsd || 0));

  const watchCandidates = enriched.filter((row) => row.watchCandidate).length;
  const preforkManipulationPositive = enriched.filter((row) => row.preforkManipulationPositive).length;
  const routePositive = 0;
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-small-cap-oracle-manipulation-routes.js",
    scope: "Read-only high-LTV lending consumer join against small-cap DEX manipulation cost and oracle bytecode links",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    inputs: {
      consumerFirstHighLtv: "reports/raw/fast/consumer-first-high-ltv-collateral.json",
      focusedEulerReview: "reports/raw/fast/focused-euler-evk-review-producers.json",
    },
    thresholds: {
      minRouteLiquidityUsd: MIN_ROUTE_LIQUIDITY_USD,
      maxRows: MAX_ROWS,
      minPoolReserveUsd: MIN_POOL_RESERVE_USD,
      maxPoolReserveUsd: MAX_POOL_RESERVE_USD,
      safetyBps: SAFETY_BPS,
      slippageBufferBps: SLIPPAGE_BUFFER_BPS,
      gasUnits: GAS_UNITS,
      minProfitUsd: MIN_PROFIT_USD,
    },
    blocks,
    gas,
    dexFactoriesScanned: DEX_FACTORIES,
    chainsWithRpc: Object.keys(rpcPool).map(Number),
    chainsMissingRpc: chainIds.filter((chainId) => !rpcPool[chainId]),
    summary: {
      rowsInput: rows.length,
      rowsScored: enriched.length,
      chainsInput: chainIds.length,
      chainsWithRpc: providers.size,
      byProtocol: countBy(enriched, (row) => row.protocol),
      byChain: countBy(enriched, (row) => row.chain),
      rowsWithOracleAddress: enriched.filter((row) => row.oracleAddresses?.length).length,
      dexPairsFound,
      dexPairsModeled,
      oracleLinkedRows,
      preforkManipulationPositive,
      watchCandidates,
      routePositive,
      signedActionJustified: false,
      bestModeledNetUsd: maxNumber(enriched, (row) => row.bestModeledPool?.economics?.modeledNetUsd),
      lowestModeledPoolReserveUsd: minNumber(enriched.flatMap((row) => row.modeledPools || []), (pool) => pool.poolReserveUsd),
      bestRouteLiquidityUsd: maxNumber(enriched, (row) => row.routeLiquidityUsd),
    },
    rows: enriched,
    topRows: enriched.slice(0, 25),
    requiredForRoutePositive: [
      "lending consumer uses a manipulable DEX pool or token-pair oracle source",
      "borrow-side liquidity is material and unpaused",
      "same-pool acquisition/manipulation model is positive after fees, slippage, and gas",
      "read-only static validation shows the oracle price changes under the modeled manipulation",
      "fork extraction proof demonstrates positive net value",
    ],
    nextReadOnlyStep: watchCandidates
      ? "Run route-specific oracle staticCall/fork validation for watch candidates before any signed action."
      : "Refresh high-LTV and focused oracle artifacts; reopen only when an oracle-linked low-depth DEX pool has positive modeled economics.",
  };

  fs.writeFileSync(OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  if (!QUIET) {
    console.log(`Small-cap oracle manipulation scan: rows=${artifact.summary.rowsScored} pairs=${dexPairsFound} modeled=${dexPairsModeled} oracleLinked=${oracleLinkedRows} watch=${watchCandidates} routePositive=0`);
    console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  const message = String(err?.stack || err?.message || err).replace(/https?:\/\/[^\s'"<>]+/g, "[redacted-url]");
  console.error(message);
  process.exitCode = 1;
});
