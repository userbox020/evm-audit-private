#!/usr/bin/env node
// scan-uniswap-v3-phase0.js - bounded read-only Phase 0 for Uniswap V3 pool/TWAP consumer joins.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "uniswap-v3-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "uniswap-v3-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const RPC_CONCURRENCY = Number(process.env.UNISWAP_V3_RPC_CONCURRENCY || "8");
const MIN_MATERIAL_POOL_TVL_USD = Number(process.env.UNISWAP_V3_MIN_MATERIAL_POOL_TVL_USD || "100000");
const MIN_WATCH_POOL_TVL_USD = Number(process.env.UNISWAP_V3_MIN_WATCH_POOL_TVL_USD || "250000");
const FEE_TIERS = [100, 500, 3000, 10000];

const V3_FACTORY = new ethers.Interface([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
  "function owner() view returns (address)",
  "function feeAmountTickSpacing(uint24 fee) view returns (int24)",
]);

const V3_POOL = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function observations(uint256 index) view returns (uint32 blockTimestamp,int56 tickCumulative,uint160 secondsPerLiquidityCumulativeX128,bool initialized)",
]);

const ERC20 = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

const BYTES32_TOKEN = new ethers.Interface([
  "function symbol() view returns (bytes32)",
  "function name() view returns (bytes32)",
]);

const DEFAULT_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const CHAINS = {
  1: { name: "Ethereum", llamaNames: ["Ethereum"], coinSlug: "ethereum", factory: DEFAULT_FACTORY, coreAssets: { WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7", DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F", WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", WSTETH: "0x7f39C581f595b53c5cb19bD0b3f8da6c935E2Ca0" } },
  10: { name: "Optimism", llamaNames: ["Optimism"], coinSlug: "optimism", factory: DEFAULT_FACTORY, coreAssets: { WETH: "0x4200000000000000000000000000000000000006", USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", USDT: "0x94b008aD8351c65A0B3bAEd0798C00ffF0bB6fE", DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", WBTC: "0x68f180fcCe6836688e9084f035309E29Bf0A2095" } },
  56: { name: "BNB Chain", llamaNames: ["Binance", "BSC", "BNB"], coinSlug: "bsc", factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7", coreAssets: { ETH: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", USDT: "0x55d398326f99059fF775485246999027B3197955", BTCB: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" } },
  137: { name: "Polygon", llamaNames: ["Polygon"], coinSlug: "polygon", factory: DEFAULT_FACTORY, coreAssets: { WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", WPOL: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270" } },
  8453: { name: "Base", llamaNames: ["Base"], coinSlug: "base", factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", coreAssets: { WETH: "0x4200000000000000000000000000000000000006", USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" } },
  42161: { name: "Arbitrum", llamaNames: ["Arbitrum"], coinSlug: "arbitrum", factory: DEFAULT_FACTORY, coreAssets: { WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", WBTC: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" } },
};

const UNSUPPORTED_PROTOCOL_CHAINS = ["Plasma", "X Layer", "xDai", "Celo", "Avalanche", "Unichain", "World Chain", "Mantle", "Sonic", "Scroll", "Linea", "Blast"];

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
  ["uniswap-v3-quoter", "reports/raw/fast/uniswap-v3-quoter-accuracy.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["current-profit-leads", "reports/raw/fast/current-profit-lead-triage.json"],
];

const DIRECT_SOURCE_SET = new Set(["aave-euler-silo", "consumer-first-high-ltv", "seven-chain-lending", "stablecoin-depeg", "small-cap-oracle", "erc4626-consumer", "evault-collateral-nav", "focused-morpho", "focused-euler", "morpho-public-allocator", "pool-share-snapshot", "public-lead-consumer"]);
const DIRECT_ROLES = new Set(["v3Pool"]);
const ZERO = "0x0000000000000000000000000000000000000000";
const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI", "USDC.E", "USDCE", "USD", "USDB", "USDE"]);
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
  try { const n = Number(ethers.formatUnits(BigInt(value), Number(decimals))); return Number.isFinite(n) ? n : null; } catch (_) { return null; }
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
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-uniswap-v3-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = 12_000) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr) return null;
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ to: addr, data: iface.encodeFunctionData(fn, args) }, "latest"], timeoutMs);
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) { return null; }
}

async function getCode(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return "0x";
  return await rpcCall(rpc, "eth_getCode", [addr, "latest"], 10_000).catch(() => "0x") || "0x";
}

function discoveryRows() {
  const d = readJson(PUBLIC_TARGETS, {});
  return [
    ...(d.phase0Queue || []), ...(d.consumerJoinFirst || []), ...(d.protocolCandidates || []), ...(d.targetedRefreshQueue || []), ...(d.yieldCandidates || []), ...(d.targets || []), ...(d.value || []),
  ];
}

function protocolMetadata() {
  const row = discoveryRows().find((p) => p?.slug === "uniswap-v3" || p?.name === "Uniswap V3");
  if (row) return { name: row.name, slug: row.slug, category: row.category, chains: row.chains || [], tvlUsd: round(row.tvlUsd, 2), change1dPct: row.change1dPct ?? null, change7dPct: row.change7dPct ?? null, routePriority: row.routePriority || null, source: "public-audit-target-discovery" };
  return { name: "Uniswap V3", slug: "uniswap-v3", category: "Dexs", chains: Object.values(CHAINS).map((c) => c.name), tvlUsd: null };
}

function yieldRows() {
  return discoveryRows()
    .filter((row) => row?.kind === "yield" && row?.project === "uniswap-v3" && Array.isArray(row?.underlying) && row.underlying.length >= 2)
    .map((row) => ({ chain: row.chain, symbol: safeText(row.symbol, 80), tvlUsd: round(row.tvlUsd, 2), apyPct: round(row.apyPct, 4), poolId: safeText(row.pool, 90), underlying: row.underlying.map(normalizeAddress).filter(Boolean).slice(0, 2), routePositive: false }));
}

function chainForLlamaName(name) { return Object.entries(CHAINS).find(([, cfg]) => cfg.llamaNames.includes(name))?.[0] || null; }

async function loadPrices(keys) {
  const out = {};
  const uniqueKeys = unique(keys).map((k) => String(k).toLowerCase());
  for (let i = 0; i < uniqueKeys.length; i += 80) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${uniqueKeys.slice(i, i + 80).join(",")}?searchWidth=6h`, 30_000);
    for (const [key, value] of Object.entries(json?.coins || {})) {
      const price = asNumber(value?.price);
      if (price !== null) out[key.toLowerCase()] = price;
    }
  }
  return out;
}

async function tokenMeta(rpc, chainId, address, prices) {
  const cfg = CHAINS[chainId];
  const addr = normalizeAddress(address);
  if (!cfg || !addr) return null;
  const [code, decimalsRaw, symbolRaw, symbolBytesRaw, nameRaw, nameBytesRaw, totalSupplyRaw] = await Promise.all([
    getCode(rpc, addr), safeCall(rpc, addr, ERC20, "decimals"), safeCall(rpc, addr, ERC20, "symbol"), safeCall(rpc, addr, BYTES32_TOKEN, "symbol"), safeCall(rpc, addr, ERC20, "name"), safeCall(rpc, addr, BYTES32_TOKEN, "name"), safeCall(rpc, addr, ERC20, "totalSupply"),
  ]);
  const symbol = safeText(symbolRaw?.[0], 40) || decodeBytes32String(symbolBytesRaw?.[0]);
  const name = safeText(nameRaw?.[0], 80) || decodeBytes32String(nameBytesRaw?.[0]);
  const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
  const key = `${cfg.coinSlug}:${addr.toLowerCase()}`;
  return { chainId: Number(chainId), chain: cfg.name, address: addr, symbol, name, decimals, codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0, totalSupplyRaw: totalSupplyRaw?.[0] === undefined ? null : totalSupplyRaw[0].toString(), priceUsd: prices[key] ?? stableFallback(symbol) };
}

async function resolvePool(rpc, factory, tokenA, tokenB, fee) {
  const raw = await safeCall(rpc, factory, V3_FACTORY, "getPool", [tokenA, tokenB, fee]);
  const pool = normalizeAddress(raw?.[0]);
  return pool && lowerAddress(pool) !== ZERO ? pool : null;
}

async function inspectFactory(chainId, rpc, chainYieldRows) {
  const cfg = CHAINS[chainId];
  const [factoryCode, ownerRaw] = await Promise.all([getCode(rpc, cfg.factory), safeCall(rpc, cfg.factory, V3_FACTORY, "owner")]);
  const factoryCodePresent = Boolean(factoryCode && factoryCode !== "0x");
  const selected = new Map();
  function add(pool, source, tokens = [], fee = null) {
    const addr = lowerAddress(pool);
    if (!addr) return;
    if (!selected.has(addr)) selected.set(addr, { pool: normalizeAddress(pool), sources: new Set(), sourceTokens: [], fee });
    selected.get(addr).sources.add(source);
    if (tokens.length) selected.get(addr).sourceTokens.push(tokens.map(normalizeAddress).filter(Boolean));
  }

  const tickSpacings = {};
  if (factoryCodePresent) {
    for (const fee of FEE_TIERS) {
      const spacing = await safeCall(rpc, cfg.factory, V3_FACTORY, "feeAmountTickSpacing", [fee]);
      tickSpacings[fee] = spacing?.[0] === undefined ? null : Number(spacing[0]);
    }
    const core = Object.values(cfg.coreAssets || {}).map(normalizeAddress).filter(Boolean);
    for (let i = 0; i < core.length; i++) {
      for (let j = i + 1; j < core.length; j++) {
        for (const fee of FEE_TIERS) {
          const pool = await resolvePool(rpc, cfg.factory, core[i], core[j], fee);
          if (pool) add(pool, "core-asset-pool", [core[i], core[j]], fee);
        }
      }
    }
    for (const row of chainYieldRows) {
      for (const fee of FEE_TIERS) {
        const pool = await resolvePool(rpc, cfg.factory, row.underlying[0], row.underlying[1], fee);
        if (pool) add(pool, `public-yield:${row.symbol || row.poolId || "row"}`, row.underlying, fee);
      }
    }
  }

  return { chainId: Number(chainId), chain: cfg.name, factory: cfg.factory, factoryCodePresent, owner: normalizeAddress(ownerRaw?.[0]), tickSpacings, corePoolsResolved: [...selected.values()].filter((row) => row.sources.has("core-asset-pool")).length, yieldPoolsResolved: [...selected.values()].filter((row) => [...row.sources].some((s) => s.startsWith("public-yield:"))).length, poolsSelected: selected.size, poolSelections: [...selected.values()].map((row) => ({ pool: row.pool, sources: [...row.sources], sourceTokens: row.sourceTokens.slice(0, 5), fee: row.fee })) };
}

async function inspectPools(chainId, rpc, selections) {
  const cfg = CHAINS[chainId];
  const firstPass = await mapLimit(selections, RPC_CONCURRENCY, async (selection) => {
    const pool = selection.pool;
    const [code, token0Raw, token1Raw, feeRaw, liquidityRaw, slot0Raw] = await Promise.all([
      getCode(rpc, pool), safeCall(rpc, pool, V3_POOL, "token0"), safeCall(rpc, pool, V3_POOL, "token1"), safeCall(rpc, pool, V3_POOL, "fee"), safeCall(rpc, pool, V3_POOL, "liquidity"), safeCall(rpc, pool, V3_POOL, "slot0"),
    ]);
    return { chainId: Number(chainId), chain: cfg.name, pool, factory: cfg.factory, codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0, token0: normalizeAddress(token0Raw?.[0]), token1: normalizeAddress(token1Raw?.[0]), fee: feeRaw?.[0] === undefined ? selection.fee : Number(feeRaw[0]), liquidityRaw: liquidityRaw?.[0] === undefined ? null : liquidityRaw[0].toString(), sqrtPriceX96Raw: slot0Raw?.[0] === undefined ? null : slot0Raw[0].toString(), tick: slot0Raw?.[1] === undefined ? null : Number(slot0Raw[1]), observationIndex: slot0Raw?.[2] === undefined ? null : Number(slot0Raw[2]), observationCardinality: slot0Raw?.[3] === undefined ? null : Number(slot0Raw[3]), observationCardinalityNext: slot0Raw?.[4] === undefined ? null : Number(slot0Raw[4]), unlocked: slot0Raw?.[6] === undefined ? null : Boolean(slot0Raw[6]), discoverySources: selection.sources || [], routePositive: false };
  });

  const priceKeys = [];
  for (const row of firstPass) for (const token of [row.token0, row.token1]) { const addr = lowerAddress(token); if (addr) priceKeys.push(`${cfg.coinSlug}:${addr}`); }
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
    const [balance0Raw, balance1Raw] = await Promise.all([
      token0Meta?.address ? safeCall(rpc, token0Meta.address, ERC20, "balanceOf", [row.pool]) : null,
      token1Meta?.address ? safeCall(rpc, token1Meta.address, ERC20, "balanceOf", [row.pool]) : null,
    ]);
    const balance0 = decimalsToNumber(balance0Raw?.[0]?.toString(), token0Meta?.decimals);
    const balance1 = decimalsToNumber(balance1Raw?.[0]?.toString(), token1Meta?.decimals);
    const balance0Usd = balance0 !== null && token0Meta?.priceUsd !== null && token0Meta?.priceUsd !== undefined ? balance0 * token0Meta.priceUsd : null;
    const balance1Usd = balance1 !== null && token1Meta?.priceUsd !== null && token1Meta?.priceUsd !== undefined ? balance1 * token1Meta.priceUsd : null;
    const poolTvlUsd = balance0Usd === null && balance1Usd === null ? null : (balance0Usd || 0) + (balance1Usd || 0);
    return { ...row, token0Meta, token1Meta, balance0: round(balance0, 8), balance1: round(balance1, 8), balance0Usd: round(balance0Usd, 2), balance1Usd: round(balance1Usd, 2), poolTvlUsd: round(poolTvlUsd, 2), symbolPair: `${token0Meta?.symbol || compactAddress(row.token0)}/${token1Meta?.symbol || compactAddress(row.token1)}`, material: (asNumber(poolTvlUsd) || 0) >= MIN_MATERIAL_POOL_TVL_USD };
  });
  return withMeta.sort((a, b) => (asNumber(b.poolTvlUsd) || 0) - (asNumber(a.poolTvlUsd) || 0));
}

function primitiveAddresses(value, out = new Set()) {
  if (typeof value === "string") { for (const m of value.matchAll(/0x[0-9a-fA-F]{40}/g)) out.add(m[0].toLowerCase()); }
  else if (Array.isArray(value)) { for (const item of value) primitiveAddresses(item, out); }
  else if (value && typeof value === "object") { for (const item of Object.values(value)) primitiveAddresses(item, out); }
  return out;
}

function summarizeContext(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const fields = ["id", "protocol", "project", "name", "chain", "chainId", "surface", "side", "symbol", "asset", "token", "collateral", "borrowAsset", "loanAsset", "oracle", "source", "status", "routePositive", "watchCandidate", "liquidityUsd", "borrowCashUsd", "cashUsd", "borrowAssetsUsd", "supplyAssetsUsd", "file", "rootFile"];
  const out = {};
  for (const field of fields) { const value = obj[field]; if (value === undefined) continue; out[field] = typeof value === "object" ? safeText(JSON.stringify(value), 180) : safeText(value, 180); }
  return out;
}

function scanObjectForAddresses(source, obj, addressRoles, out, depth = 0) {
  if (!obj || depth > 9 || out.length >= 700) return;
  if (Array.isArray(obj)) { for (const item of obj) scanObjectForAddresses(source, item, addressRoles, out, depth + 1); return; }
  if (typeof obj !== "object") return;
  const hits = [...primitiveAddresses(obj)].filter((addr) => addressRoles[addr]);
  if (hits.length) {
    const roles = unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.role)));
    out.push({ source, hitRoles: roles, hitAddresses: hits.slice(0, 12), pools: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.pool)).filter(Boolean)).slice(0, 10), context: summarizeContext(obj), directConsumer: DIRECT_SOURCE_SET.has(source) && roles.some((role) => DIRECT_ROLES.has(role)), routePositive: false, blocker: "Local artifact address match is context only unless the Uniswap V3 pool itself is consumed by oracle/collateral logic with exact positive economics" });
    return;
  }
  for (const value of Object.values(obj)) scanObjectForAddresses(source, value, addressRoles, out, depth + 1);
}

function localConsumerJoins(poolRows) {
  const roles = {};
  function add(addr, role, pool, chain, symbolPair) {
    const lower = lowerAddress(addr);
    if (!lower || lower === ZERO) return;
    if (!roles[lower]) roles[lower] = [];
    roles[lower].push({ role, pool, chain, symbolPair });
  }
  for (const row of poolRows) { add(row.pool, "v3Pool", row.pool, row.chain, row.symbolPair); add(row.factory, "factory", row.pool, row.chain, row.symbolPair); add(row.token0, "token0", row.pool, row.chain, row.symbolPair); add(row.token1, "token1", row.pool, row.chain, row.symbolPair); }
  const matches = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) { const json = readJson(path.join(WORKSPACE, rel), null); if (json) scanObjectForAddresses(source, json, roles, matches); }
  return { directPoolConsumerRows: matches.filter((row) => row.directConsumer), tokenContextRows: matches.filter((row) => !row.directConsumer) };
}

function buildReport(artifact) {
  const s = artifact.summary;
  const factoryTable = artifact.factoryRows.map((row) => `| ${row.chain} | ${compactAddress(row.factory)} | ${row.factoryCodePresent ? "yes" : "no"} | ${row.poolsSelected} | ${row.corePoolsResolved} | ${row.yieldPoolsResolved} |`).join("\n");
  const pairTable = artifact.poolRows.slice(0, 12).map((row) => `| ${row.chain} | ${compactAddress(row.pool)} | ${row.symbolPair} | ${row.fee} | ${formatUsd(row.poolTvlUsd)} | ${row.observationCardinality ?? "n/a"} | ${row.discoverySources.slice(0, 2).join(", ") || "n/a"} |`).join("\n") || "| n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const yieldTable = artifact.yieldRows.length ? artifact.yieldRows.slice(0, 8).map((row) => `| ${row.chain} | ${row.symbol || "n/a"} | ${formatUsd(row.tvlUsd)} | ${row.apyPct ?? "n/a"} | ${row.underlying.map(compactAddress).join(", ")} |`).join("\n") : "| none | n/a | n/a | n/a | n/a |";
  const consumerTable = artifact.directPoolConsumerRows.length ? artifact.directPoolConsumerRows.slice(0, 10).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${row.pools.map(compactAddress).join(", ") || "n/a"} | ${safeText(row.context?.protocol || row.context?.project || row.context?.name || row.context?.surface || row.context?.file || "context", 80)} |`).join("\n") : "| none | n/a | n/a | n/a | no Uniswap V3 pool address was found in consumer-grade artifacts |";
  return `# ${SIGNAL_DORMANT} - Uniswap V3 Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit. Uniswap V3 factories, selected core/yield pools, pool token balances, observation-cardinality context, and local consumer joins were mapped across configured RPC-available chains. Token-level matches and DEX-exit quote usage are context only; route-positive requires a trusted consumer that prices a Uniswap V3 pool/TWAP/NFT position plus exact positive manipulation, borrow/redeem/liquidation, and exit economics.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Chains with RPC | ${s.chainsScanned} |
| Unsupported protocol chains | ${artifact.unsupportedProtocolChains.length} |
| Factories code-present | ${s.factoriesCodePresent} |
| Pools selected | ${s.poolsSelected} |
| Pools inspected | ${s.poolsInspected} |
| Material pools | ${s.materialPoolRows} |
| Public yield rows | ${s.publicYieldRows} |
| Direct pool consumer rows | ${s.directPoolConsumerRows} |
| Token context rows | ${s.tokenContextRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |

## Factories

| Chain | Factory | Code | Selected | Core pools | Yield pools |
|---|---|---|---:|---:|---:|
${factoryTable}

## Top Selected Pools

| Chain | Pool | Tokens | Fee | Pool token-balance TVL | Obs cardinality | Discovery |
|---|---|---|---:|---:|---:|---|
${pairTable}

## Public Yield Rows

| Chain | Symbol | TVL | APY % | Underlying |
|---|---|---:|---:|---|
${yieldTable}

## Direct Consumer Join

| Source | Hit roles | Addresses | Pools | Context |
|---|---|---|---|---|
${consumerTable}

## Blockers

- No Uniswap V3 pool address is currently found as value-bearing collateral, reserve asset, or oracle-specific consumer in scanned consumer-grade artifacts.
- Token-level joins are dominated by common assets and DEX-exit quote usage.
- Public yield APY and pool token balances are not impact without a consumer that trusts pool/TWAP/NFT-position value.
- V3 spot/TWAP manipulation is not impact without exact consumer linkage and positive manipulation economics.
- No fork extraction proof exists.

## Required For Route-Positive

- A deployed lending, vault, margin, or oracle consumer references a Uniswap V3 pool, TWAP, or NFT-position value path.
- The referenced pool state is permissionlessly movable or stale in an attacker-favorable direction.
- Borrow, redemption, liquidation, or settlement liquidity is material and exact-quoted after fees, gas, and slippage.
- Fork extraction proof shows positive net value.

Artifacts: \`reports/raw/fast/uniswap-v3-phase0.json\`.
`;
}

async function main() {
  const metadata = protocolMetadata();
  const yRows = yieldRows();
  const chainIds = Object.keys(CHAINS).map(Number);
  const rpcs = await resolveRpcPool(chainIds);
  const factoryRows = [];
  const allPools = [];
  for (const chainId of chainIds) {
    const cfg = CHAINS[chainId];
    const rpc = rpcs[chainId];
    const chainYieldRows = yRows.filter((row) => String(chainForLlamaName(row.chain)) === String(chainId));
    if (!rpc) { factoryRows.push({ chainId, chain: cfg.name, factory: cfg.factory, rpcAvailable: false, factoryCodePresent: false, poolsSelected: 0, corePoolsResolved: 0, yieldPoolsResolved: 0, poolSelections: [] }); continue; }
    const factory = await inspectFactory(chainId, rpc, chainYieldRows);
    factory.rpcAvailable = true;
    factoryRows.push(factory);
    if (factory.poolSelections.length) allPools.push(...await inspectPools(chainId, rpc, factory.poolSelections.map((row) => ({ ...row, sources: row.sources || [] }))));
  }
  allPools.sort((a, b) => (asNumber(b.poolTvlUsd) || 0) - (asNumber(a.poolTvlUsd) || 0));
  const joins = localConsumerJoins(allPools);
  const directPoolSet = new Set(joins.directPoolConsumerRows.flatMap((row) => row.pools.map(lowerAddress)).filter(Boolean));
  const watchCandidates = allPools.filter((row) => directPoolSet.has(lowerAddress(row.pool)) && (asNumber(row.poolTvlUsd) || 0) >= MIN_WATCH_POOL_TVL_USD).map((row) => ({ ...row, reason: "Uniswap V3 pool address appears in a consumer artifact and has material token-balance TVL", routePositive: false }));
  const summary = { chainsScanned: factoryRows.filter((row) => row.rpcAvailable).length, chainsWithRpc: factoryRows.filter((row) => row.rpcAvailable).map((row) => row.chainId), chainsMissingRpc: factoryRows.filter((row) => !row.rpcAvailable).map((row) => row.chainId), unsupportedProtocolChains: UNSUPPORTED_PROTOCOL_CHAINS.length, factoriesCodePresent: factoryRows.filter((row) => row.factoryCodePresent).length, poolsSelected: factoryRows.reduce((sum, row) => sum + (asNumber(row.poolsSelected) || 0), 0), poolsInspected: allPools.length, materialPoolRows: allPools.filter((row) => (asNumber(row.poolTvlUsd) || 0) >= MIN_MATERIAL_POOL_TVL_USD).length, publicYieldRows: yRows.length, publicYieldRowsResolved: factoryRows.reduce((sum, row) => sum + (asNumber(row.yieldPoolsResolved) || 0), 0), directPoolConsumerRows: joins.directPoolConsumerRows.length, tokenContextRows: joins.tokenContextRows.length, watchCandidates: watchCandidates.length, maxPoolTvlUsd: round(Math.max(0, ...allPools.map((row) => asNumber(row.poolTvlUsd) || 0)), 2), defillamaCurrentTvlUsd: metadata.tvlUsd, routePositive: 0, executableNow: 0, signedActionJustified: false, closedReason: joins.directPoolConsumerRows.length ? "Uniswap V3 pool consumer references found, but no exact-positive manipulation/borrow/exit economics or fork proof" : "no Uniswap V3 pool address is referenced by scanned consumer-grade artifacts" };
  const artifact = { generatedAt: new Date().toISOString(), scanner: "tools/scan-uniswap-v3-phase0.js", scope: "Read-only Uniswap V3 pool/TWAP and consumer-route Phase 0 scan", target: { name: "Uniswap V3", slug: "uniswap-v3", category: "Dexs", surface: "dex-oracle-consumer-only", metadata }, safety: { publicApisOnlyForMetadata: true, rpcInventoryRead: true, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false }, thresholds: { feeTiers: FEE_TIERS, minMaterialPoolTvlUsd: MIN_MATERIAL_POOL_TVL_USD, minWatchPoolTvlUsd: MIN_WATCH_POOL_TVL_USD }, docs: { factorySource: "https://github.com/Uniswap/v3-core", peripherySource: "https://github.com/Uniswap/v3-periphery" }, unsupportedProtocolChains: UNSUPPORTED_PROTOCOL_CHAINS, yieldRows: yRows, factoryRows: factoryRows.map((row) => ({ ...row, poolSelections: undefined })), poolRows: allPools, directPoolConsumerRows: joins.directPoolConsumerRows, tokenContextRows: joins.tokenContextRows.slice(0, 150), watchCandidates, routePositiveRows: [], summary, blockers: ["No Uniswap V3 pool address is referenced by scanned consumer-grade artifacts", "Token-level matches are common-asset context and not Uniswap-specific impact", "Public yield APY and V3 pool token balances do not prove accepted-value divergence or extractive consumer economics", "No exact positive acquisition/manipulation/borrow/exit economics or fork proof"], requiredForRoutePositive: ["deployed consumer references a Uniswap V3 pool, TWAP, or NFT-position value path", "pool/oracle state is permissionlessly movable or stale in attacker-favorable direction", "borrow, redemption, liquidation, or settlement route is exact-quoted and positive", "fork extraction proof"], nextReadOnlyStep: joins.directPoolConsumerRows.length ? "Static-review the matched consumer and exact-quote only if Uniswap V3 pool state affects accepted value." : "Reopen Uniswap V3 only if a lending/oracle consumer references a V3 pool/TWAP or a new adapter consumes V3 state." };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));
  if (!QUIET) console.log(`Uniswap V3 Phase 0: pools=${summary.poolsInspected} material=${summary.materialPoolRows} directPoolConsumers=${summary.directPoolConsumerRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
}

main().catch((err) => { console.error(err?.message || String(err)); process.exit(1); });
