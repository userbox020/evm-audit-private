#!/usr/bin/env node
// scan-aerodrome-v1-phase0.js - bounded read-only Phase 0 for Aerodrome V1 pool/LP consumer joins.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "aerodrome-v1-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "aerodrome-v1-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const RPC_CONCURRENCY = Number(process.env.AERODROME_V1_RPC_CONCURRENCY || "8");
const MAX_ENUM_POOLS_PER_FACTORY = Number(process.env.AERODROME_V1_MAX_ENUM_POOLS_PER_FACTORY || "160");
const MAX_TAIL_POOLS_PER_FACTORY = Number(process.env.AERODROME_V1_MAX_TAIL_POOLS_PER_FACTORY || "40");
const MIN_MATERIAL_POOL_TVL_USD = Number(process.env.AERODROME_V1_MIN_MATERIAL_POOL_TVL_USD || "100000");
const MIN_WATCH_POOL_TVL_USD = Number(process.env.AERODROME_V1_MIN_WATCH_POOL_TVL_USD || "250000");
const STABLE_FLAGS = [false, true];

const CHAINS = {
  8453: {
    name: "Base",
    llamaNames: ["Base"],
    coinSlug: "base",
    factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
    router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
    voter: "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5",
    coreAssets: {
      WETH: "0x4200000000000000000000000000000000000006",
      USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
      USDT: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
      cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      AERO: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
      MORPHO: "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842",
      AAVE: "0x63706e401c06ac8513145b7687A14804d17f814b",
      EURC: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42",
    },
  },
};
const UNSUPPORTED_PROTOCOL_CHAINS = [];

const V1_FACTORY = new ethers.Interface([
  "function allPoolsLength() view returns (uint256)",
  "function allPools(uint256) view returns (address)",
  "function getPool(address tokenA,address tokenB,bool stable) view returns (address)",
  "function implementation() view returns (address)",
  "function voter() view returns (address)",
  "function isPaused() view returns (bool)",
  "function stableFee() view returns (uint256)",
  "function volatileFee() view returns (uint256)",
]);

const V1_POOL = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function stable() view returns (bool)",
  "function getReserves() view returns (uint256 reserve0,uint256 reserve1,uint256 blockTimestampLast)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function reserve0CumulativeLast() view returns (uint256)",
  "function reserve1CumulativeLast() view returns (uint256)",
  "function observationLength() view returns (uint256)",
  "function poolFees() view returns (address)",
  "function factory() view returns (address)",
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
  ["base-cadc", "reports/raw/fast/base-cadc-routes.json"],
  ["base-syrupusdc", "reports/raw/fast/base-syrupusdc-routes.json"],
];

const DIRECT_SOURCE_SET = new Set([
  "aave-euler-silo",
  "consumer-first-high-ltv",
  "seven-chain-lending",
  "stablecoin-depeg",
  "erc4626-consumer",
  "evault-collateral-nav",
  "focused-morpho",
  "focused-euler",
  "morpho-public-allocator",
  "pool-share-snapshot",
  "public-lead-consumer",
]);
const DIRECT_ROLES = new Set(["v1Pool"]);
const ZERO = "0x0000000000000000000000000000000000000000";
const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI", "USDBC", "USDC.E", "USDCE", "EURC", "CUSD", "CEUR", "USD", "USDB", "USDE", "GHO"]);
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
function decodeBytes32String(value) { try { return safeText(ethers.decodeBytes32String(value), 40); } catch (_) { return null; } }
function stableFallback(symbol) { const s = String(symbol || "").toUpperCase(); return STABLE_SYMBOLS.has(s) ? 1 : null; }

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
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-aerodrome-v1-phase0/1.0" } });
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
    ...(d.phase0Queue || []),
    ...(d.consumerJoinFirst || []),
    ...(d.protocolCandidates || []),
    ...(d.targetedRefreshQueue || []),
    ...(d.yieldCandidates || []),
    ...(d.targets || []),
    ...(d.value || []),
  ];
}

function protocolMetadata() {
  const row = discoveryRows().find((p) => p?.slug === "aerodrome-v1" || p?.name === "Aerodrome V1");
  if (row) return { name: row.name, slug: row.slug, category: row.category, chains: row.chains || [], tvlUsd: round(row.tvlUsd, 2), change1dPct: row.change1dPct ?? null, change7dPct: row.change7dPct ?? null, routePriority: row.routePriority || null, source: "public-audit-target-discovery" };
  return { name: "Aerodrome V1", slug: "aerodrome-v1", category: "Dexs", chains: ["Base"], tvlUsd: null };
}

function yieldRows() {
  return discoveryRows()
    .filter((row) => row?.kind === "yield" && row?.project === "aerodrome-v1" && Array.isArray(row?.underlying) && row.underlying.length >= 2)
    .map((row) => ({ chain: row.chain, symbol: safeText(row.symbol, 80), tvlUsd: round(row.tvlUsd, 2), apyPct: round(row.apyPct, 4), poolId: safeText(row.pool, 90), underlying: row.underlying.map(normalizeAddress).filter(Boolean).slice(0, 2), routePositive: false }));
}

function chainForLlamaName(name) { return Object.entries(CHAINS).find(([, cfg]) => cfg.llamaNames.includes(name))?.[0] || null; }
function poolKey(tokenA, tokenB, stable) { return `${[lowerAddress(tokenA), lowerAddress(tokenB)].filter(Boolean).sort().join(":")}:${stable ? "stable" : "volatile"}`; }

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
  return { chainId: Number(chainId), chain: cfg.name, address: addr, symbol, name, decimals, codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0, totalSupplyRaw: totalSupplyRaw?.[0] === undefined ? null : totalSupplyRaw[0].toString(), priceUsd: prices[key] ?? stableFallback(symbol) };
}

async function resolvePool(rpc, factory, tokenA, tokenB, stable) {
  const raw = await safeCall(rpc, factory, V1_FACTORY, "getPool", [tokenA, tokenB, stable]);
  const pool = normalizeAddress(raw?.[0]);
  return pool && lowerAddress(pool) !== ZERO ? pool : null;
}

async function inspectFactory(chainId, rpc, chainYieldRows) {
  const cfg = CHAINS[chainId];
  const [factoryCode, routerCode, allPoolsLengthRaw, implementationRaw, voterRaw, isPausedRaw, stableFeeRaw, volatileFeeRaw] = await Promise.all([
    getCode(rpc, cfg.factory),
    cfg.router ? getCode(rpc, cfg.router) : Promise.resolve("0x"),
    safeCall(rpc, cfg.factory, V1_FACTORY, "allPoolsLength"),
    safeCall(rpc, cfg.factory, V1_FACTORY, "implementation"),
    safeCall(rpc, cfg.factory, V1_FACTORY, "voter"),
    safeCall(rpc, cfg.factory, V1_FACTORY, "isPaused"),
    safeCall(rpc, cfg.factory, V1_FACTORY, "stableFee"),
    safeCall(rpc, cfg.factory, V1_FACTORY, "volatileFee"),
  ]);
  const factoryCodePresent = Boolean(factoryCode && factoryCode !== "0x");
  const allPoolsLength = allPoolsLengthRaw?.[0] === undefined ? null : Number(allPoolsLengthRaw[0]);
  const selected = new Map();
  function add(pool, source, tokens = [], stable = null) {
    const addr = lowerAddress(pool);
    if (!addr) return;
    if (!selected.has(addr)) selected.set(addr, { pool: normalizeAddress(pool), sources: new Set(), sourceTokens: [], stable });
    selected.get(addr).sources.add(source);
    if (tokens.length) selected.get(addr).sourceTokens.push(tokens.map(normalizeAddress).filter(Boolean));
    if (stable !== null) selected.get(addr).stable = stable;
  }

  if (factoryCodePresent) {
    const core = Object.values(cfg.coreAssets || {}).map(normalizeAddress).filter(Boolean);
    const seenCore = new Set();
    const coreTasks = [];
    for (let i = 0; i < core.length; i++) {
      for (let j = i + 1; j < core.length; j++) {
        for (const stable of STABLE_FLAGS) {
          const key = poolKey(core[i], core[j], stable);
          if (seenCore.has(key)) continue;
          seenCore.add(key);
          coreTasks.push({ tokens: [core[i], core[j]], stable });
        }
      }
    }
    const corePools = await mapLimit(coreTasks, RPC_CONCURRENCY, async (task) => ({ ...task, pool: await resolvePool(rpc, cfg.factory, task.tokens[0], task.tokens[1], task.stable) }));
    for (const row of corePools) if (row.pool) add(row.pool, row.stable ? "core-stable-pool" : "core-volatile-pool", row.tokens, row.stable);

    const yieldTasks = [];
    for (const row of chainYieldRows) for (const stable of STABLE_FLAGS) yieldTasks.push({ source: `public-yield:${row.symbol || row.poolId || "row"}`, tokens: row.underlying, stable });
    const yieldPools = await mapLimit(yieldTasks, RPC_CONCURRENCY, async (task) => ({ ...task, pool: await resolvePool(rpc, cfg.factory, task.tokens[0], task.tokens[1], task.stable) }));
    for (const row of yieldPools) if (row.pool) add(row.pool, row.source, row.tokens, row.stable);

    const prefixCount = Math.min(allPoolsLength || 0, MAX_ENUM_POOLS_PER_FACTORY);
    const prefixPools = await mapLimit(Array.from({ length: prefixCount }, (_, i) => i), RPC_CONCURRENCY, async (i) => normalizeAddress((await safeCall(rpc, cfg.factory, V1_FACTORY, "allPools", [i]))?.[0]));
    for (const pool of prefixPools) add(pool, "factory-prefix-enumeration");

    const tailCount = Math.min(allPoolsLength || 0, MAX_TAIL_POOLS_PER_FACTORY);
    const tailStart = Math.max(0, (allPoolsLength || 0) - tailCount);
    const tailPools = await mapLimit(Array.from({ length: tailCount }, (_, i) => tailStart + i), RPC_CONCURRENCY, async (i) => normalizeAddress((await safeCall(rpc, cfg.factory, V1_FACTORY, "allPools", [i]))?.[0]));
    for (const pool of tailPools) add(pool, "factory-tail-enumeration");
  }

  return { chainId: Number(chainId), chain: cfg.name, factory: cfg.factory, router: cfg.router, voter: normalizeAddress(voterRaw?.[0]) || cfg.voter, implementation: normalizeAddress(implementationRaw?.[0]), factoryCodePresent, routerCodePresent: Boolean(routerCode && routerCode !== "0x"), factoryCodeBytes: factoryCode && factoryCode !== "0x" ? strip0x(factoryCode).length / 2 : 0, allPoolsLength, isPaused: isPausedRaw?.[0] === undefined ? null : Boolean(isPausedRaw[0]), stableFeeBps: stableFeeRaw?.[0] === undefined ? null : Number(stableFeeRaw[0]), volatileFeeBps: volatileFeeRaw?.[0] === undefined ? null : Number(volatileFeeRaw[0]), corePoolsResolved: [...selected.values()].filter((row) => row.sources.has("core-stable-pool") || row.sources.has("core-volatile-pool")).length, yieldPoolsResolved: [...selected.values()].filter((row) => [...row.sources].some((s) => s.startsWith("public-yield:"))).length, enumerationPoolsResolved: [...selected.values()].filter((row) => [...row.sources].some((s) => s.includes("enumeration"))).length, poolsSelected: selected.size, enumerationCapped: allPoolsLength !== null && allPoolsLength > (MAX_ENUM_POOLS_PER_FACTORY + MAX_TAIL_POOLS_PER_FACTORY), poolSelections: [...selected.values()].map((row) => ({ pool: row.pool, sources: [...row.sources], sourceTokens: row.sourceTokens.slice(0, 5), stable: row.stable })) };
}

async function inspectPools(chainId, rpc, selections) {
  const cfg = CHAINS[chainId];
  const firstPass = await mapLimit(selections, RPC_CONCURRENCY, async (selection) => {
    const pool = selection.pool;
    const [code, token0Raw, token1Raw, stableRaw, reservesRaw, totalSupplyRaw, decimalsRaw, symbolRaw, nameRaw, reserve0CumulativeRaw, reserve1CumulativeRaw, observationLengthRaw, poolFeesRaw, poolFactoryRaw] = await Promise.all([
      getCode(rpc, pool),
      safeCall(rpc, pool, V1_POOL, "token0"),
      safeCall(rpc, pool, V1_POOL, "token1"),
      safeCall(rpc, pool, V1_POOL, "stable"),
      safeCall(rpc, pool, V1_POOL, "getReserves"),
      safeCall(rpc, pool, V1_POOL, "totalSupply"),
      safeCall(rpc, pool, V1_POOL, "decimals"),
      safeCall(rpc, pool, V1_POOL, "symbol"),
      safeCall(rpc, pool, V1_POOL, "name"),
      safeCall(rpc, pool, V1_POOL, "reserve0CumulativeLast"),
      safeCall(rpc, pool, V1_POOL, "reserve1CumulativeLast"),
      safeCall(rpc, pool, V1_POOL, "observationLength"),
      safeCall(rpc, pool, V1_POOL, "poolFees"),
      safeCall(rpc, pool, V1_POOL, "factory"),
    ]);
    return { chainId: Number(chainId), chain: cfg.name, pool, factory: normalizeAddress(poolFactoryRaw?.[0]) || cfg.factory, codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0, token0: normalizeAddress(token0Raw?.[0]), token1: normalizeAddress(token1Raw?.[0]), stable: stableRaw?.[0] === undefined ? selection.stable : Boolean(stableRaw[0]), reserve0Raw: reservesRaw?.[0] === undefined ? null : reservesRaw[0].toString(), reserve1Raw: reservesRaw?.[1] === undefined ? null : reservesRaw[1].toString(), blockTimestampLast: reservesRaw?.[2] === undefined ? null : Number(reservesRaw[2]), totalSupplyRaw: totalSupplyRaw?.[0] === undefined ? null : totalSupplyRaw[0].toString(), decimals: decimalsRaw?.[0] === undefined ? 18 : Number(decimalsRaw[0]), symbol: safeText(symbolRaw?.[0], 60), name: safeText(nameRaw?.[0], 120), reserve0CumulativeLastRaw: reserve0CumulativeRaw?.[0] === undefined ? null : reserve0CumulativeRaw[0].toString(), reserve1CumulativeLastRaw: reserve1CumulativeRaw?.[0] === undefined ? null : reserve1CumulativeRaw[0].toString(), observationLength: observationLengthRaw?.[0] === undefined ? null : Number(observationLengthRaw[0]), poolFees: normalizeAddress(poolFeesRaw?.[0]), discoverySources: selection.sources || [], routePositive: false };
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
    const reserve0 = decimalsToNumber(row.reserve0Raw, token0Meta?.decimals);
    const reserve1 = decimalsToNumber(row.reserve1Raw, token1Meta?.decimals);
    const reserve0Usd = reserve0 !== null && token0Meta?.priceUsd !== null && token0Meta?.priceUsd !== undefined ? reserve0 * token0Meta.priceUsd : null;
    const reserve1Usd = reserve1 !== null && token1Meta?.priceUsd !== null && token1Meta?.priceUsd !== undefined ? reserve1 * token1Meta.priceUsd : null;
    const knownUsd = (reserve0Usd || 0) + (reserve1Usd || 0);
    const poolTvlUsd = reserve0Usd !== null && reserve1Usd !== null ? knownUsd : knownUsd > 0 ? knownUsd * 2 : null;
    const totalSupply = decimalsToNumber(row.totalSupplyRaw, row.decimals);
    const lpPriceUsd = poolTvlUsd !== null && totalSupply ? poolTvlUsd / totalSupply : null;
    return { ...row, token0Meta, token1Meta, reserve0: round(reserve0, 8), reserve1: round(reserve1, 8), reserve0Usd: round(reserve0Usd, 2), reserve1Usd: round(reserve1Usd, 2), poolTvlUsd: round(poolTvlUsd, 2), poolTvlInferred: reserve0Usd === null || reserve1Usd === null, lpPriceUsd: round(lpPriceUsd, 8), symbolPair: `${token0Meta?.symbol || compactAddress(row.token0)}/${token1Meta?.symbol || compactAddress(row.token1)}`, material: (asNumber(poolTvlUsd) || 0) >= MIN_MATERIAL_POOL_TVL_USD };
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
    out.push({ source, hitRoles: roles, hitAddresses: hits.slice(0, 12), pools: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.pool)).filter(Boolean)).slice(0, 10), context: summarizeContext(obj), directConsumer: DIRECT_SOURCE_SET.has(source) && roles.some((role) => DIRECT_ROLES.has(role)), routePositive: false, blocker: "Local artifact address match is context only unless the Aerodrome V1 pool/LP itself is consumed by oracle/collateral logic with exact positive economics" });
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
  for (const row of poolRows) { add(row.pool, "v1Pool", row.pool, row.chain, row.symbolPair); add(row.poolFees, "poolFees", row.pool, row.chain, row.symbolPair); add(row.factory, "factory", row.pool, row.chain, row.symbolPair); add(row.token0, "token0", row.pool, row.chain, row.symbolPair); add(row.token1, "token1", row.pool, row.chain, row.symbolPair); }
  const matches = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) { const json = readJson(path.join(WORKSPACE, rel), null); if (json) scanObjectForAddresses(source, json, roles, matches); }
  return { directPoolConsumerRows: matches.filter((row) => row.directConsumer), tokenContextRows: matches.filter((row) => !row.directConsumer) };
}

function buildReport(artifact) {
  const s = artifact.summary;
  const factoryTable = artifact.factoryRows.map((row) => `| ${row.chain} | ${compactAddress(row.factory)} | ${row.factoryCodePresent ? "yes" : "no"} | ${row.allPoolsLength ?? "n/a"} | ${row.isPaused ?? "n/a"} | ${row.volatileFeeBps ?? "n/a"} | ${row.stableFeeBps ?? "n/a"} | ${row.poolsSelected} | ${row.corePoolsResolved} | ${row.yieldPoolsResolved} |`).join("\n");
  const poolTable = artifact.poolRows.slice(0, 12).map((row) => `| ${row.chain} | ${compactAddress(row.pool)} | ${row.symbolPair} | ${row.stable ? "stable" : "volatile"} | ${formatUsd(row.poolTvlUsd)} | ${row.observationLength ?? "n/a"} | ${row.discoverySources.slice(0, 2).join(", ") || "n/a"} | ${row.poolTvlInferred ? "yes" : "no"} |`).join("\n") || "| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const yieldTable = artifact.yieldRows.length ? artifact.yieldRows.slice(0, 8).map((row) => `| ${row.chain} | ${row.symbol || "n/a"} | ${formatUsd(row.tvlUsd)} | ${row.apyPct ?? "n/a"} | ${row.underlying.map(compactAddress).join(", ")} |`).join("\n") : "| none | n/a | n/a | n/a | n/a |";
  const consumerTable = artifact.directPoolConsumerRows.length ? artifact.directPoolConsumerRows.slice(0, 10).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${row.pools.map(compactAddress).join(", ") || "n/a"} | ${safeText(row.context?.protocol || row.context?.project || row.context?.name || row.context?.surface || row.context?.file || "context", 80)} |`).join("\n") : "| none | n/a | n/a | n/a | no Aerodrome V1 pool/LP address was found in consumer-grade artifacts |";
  return `# ${SIGNAL_DORMANT} - Aerodrome V1 Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit. Aerodrome V1 factory, selected core/yield/enumerated stable and volatile pools, reserve/LP pricing context, oracle observation context, and local consumer joins were mapped on Base. Token-level matches and DEX-exit quote usage are context only; route-positive requires a trusted consumer that prices an Aerodrome V1 LP/pool or oracle path plus exact positive manipulation, borrow/redeem/liquidation, and exit economics.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Chains with RPC | ${s.chainsScanned} |
| Factories code-present | ${s.factoriesCodePresent} |
| Pools available | ${s.poolsAvailable} |
| Pools selected | ${s.poolsSelected} |
| Pools inspected | ${s.poolsInspected} |
| Material pools | ${s.materialPoolRows} |
| Public yield rows | ${s.publicYieldRows} |
| Direct pool consumer rows | ${s.directPoolConsumerRows} |
| Token context rows | ${s.tokenContextRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |

## Factory

| Chain | Factory | Code | Total pools | Paused | Volatile fee bps | Stable fee bps | Selected | Core pools | Yield pools |
|---|---|---|---:|---|---:|---:|---:|---:|---:|
${factoryTable}

## Top Selected Pools

| Chain | Pool | Tokens | Type | Pool TVL | Observations | Discovery | Inferred TVL |
|---|---|---|---|---:|---:|---|---|
${poolTable}

## Public Yield Rows

| Chain | Symbol | TVL | APY % | Underlying |
|---|---|---:|---:|---|
${yieldTable}

## Direct Consumer Join

| Source | Hit roles | Addresses | Pools | Context |
|---|---|---|---|---|
${consumerTable}

## Blockers

- No Aerodrome V1 pool/LP address is currently found as value-bearing collateral, reserve asset, or oracle-specific consumer in scanned consumer-grade artifacts.
- Token-level joins are dominated by common assets and DEX-exit quote usage.
- Public yield APY and pool reserves do not prove accepted-value divergence or extractive consumer economics.
- Stable/volatile spot or TWAP manipulation is not impact without exact consumer linkage and positive manipulation economics.
- No fork extraction proof exists.

## Required For Route-Positive

- A deployed lending, vault, margin, or oracle consumer references an Aerodrome V1 pool/LP or oracle path.
- The referenced pool state is permissionlessly movable or stale in an attacker-favorable direction.
- Borrow, redemption, liquidation, or settlement liquidity is material and exact-quoted after fees, gas, and slippage.
- Fork extraction proof shows positive net value.

Artifacts: \`reports/raw/fast/aerodrome-v1-phase0.json\`.
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
    if (!rpc) {
      factoryRows.push({ chainId, chain: cfg.name, factory: cfg.factory, rpcAvailable: false, factoryCodePresent: false, allPoolsLength: null, poolsSelected: 0, corePoolsResolved: 0, yieldPoolsResolved: 0, enumerationPoolsResolved: 0, poolSelections: [] });
      continue;
    }
    const factory = await inspectFactory(chainId, rpc, chainYieldRows);
    factory.rpcAvailable = true;
    factoryRows.push(factory);
    if (factory.poolSelections.length) allPools.push(...await inspectPools(chainId, rpc, factory.poolSelections.map((row) => ({ ...row, sources: row.sources || [] }))));
  }

  allPools.sort((a, b) => (asNumber(b.poolTvlUsd) || 0) - (asNumber(a.poolTvlUsd) || 0));
  const joins = localConsumerJoins(allPools);
  const directPoolSet = new Set(joins.directPoolConsumerRows.flatMap((row) => row.pools.map(lowerAddress)).filter(Boolean));
  const watchCandidates = allPools.filter((row) => directPoolSet.has(lowerAddress(row.pool)) && (asNumber(row.poolTvlUsd) || 0) >= MIN_WATCH_POOL_TVL_USD).map((row) => ({ ...row, reason: "Aerodrome V1 pool/LP address appears in a consumer artifact and has material reserve TVL", routePositive: false }));
  const summary = {
    chainsScanned: factoryRows.filter((row) => row.rpcAvailable).length ? 1 : 0,
    chainsWithRpc: factoryRows.filter((row) => row.rpcAvailable).length ? [8453] : [],
    chainsMissingRpc: factoryRows.filter((row) => row.rpcAvailable).length ? [] : [8453],
    unsupportedProtocolChains: UNSUPPORTED_PROTOCOL_CHAINS.length,
    factoriesCodePresent: factoryRows.filter((row) => row.factoryCodePresent).length,
    poolsAvailable: factoryRows.reduce((sum, row) => sum + (asNumber(row.allPoolsLength) || 0), 0),
    poolsSelected: factoryRows.reduce((sum, row) => sum + (asNumber(row.poolsSelected) || 0), 0),
    poolsInspected: allPools.length,
    materialPoolRows: allPools.filter((row) => (asNumber(row.poolTvlUsd) || 0) >= MIN_MATERIAL_POOL_TVL_USD).length,
    publicYieldRows: yRows.length,
    publicYieldRowsResolved: factoryRows.reduce((sum, row) => sum + (asNumber(row.yieldPoolsResolved) || 0), 0),
    directPoolConsumerRows: joins.directPoolConsumerRows.length,
    tokenContextRows: joins.tokenContextRows.length,
    watchCandidates: watchCandidates.length,
    maxPoolTvlUsd: round(Math.max(0, ...allPools.map((row) => asNumber(row.poolTvlUsd) || 0)), 2),
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    closedReason: joins.directPoolConsumerRows.length ? "Aerodrome V1 pool consumer references found, but no exact-positive manipulation/borrow/exit economics or fork proof" : "no Aerodrome V1 pool/LP address is referenced by scanned consumer-grade artifacts",
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-aerodrome-v1-phase0.js",
    scope: "Read-only Aerodrome V1 pool/LP and consumer-route Phase 0 scan",
    target: { name: "Aerodrome V1", slug: "aerodrome-v1", category: "Dexs", surface: "dex-oracle-consumer-only", metadata },
    safety: { publicApisOnlyForMetadata: true, rpcInventoryRead: true, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false },
    thresholds: { stableFlags: STABLE_FLAGS, maxEnumPoolsPerFactory: MAX_ENUM_POOLS_PER_FACTORY, maxTailPoolsPerFactory: MAX_TAIL_POOLS_PER_FACTORY, minMaterialPoolTvlUsd: MIN_MATERIAL_POOL_TVL_USD, minWatchPoolTvlUsd: MIN_WATCH_POOL_TVL_USD },
    docs: { adapter: "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/aerodrome-v1/index.js", source: "https://github.com/aerodrome-finance/contracts", localSource: "targets/aerodrome-contracts" },
    unsupportedProtocolChains: UNSUPPORTED_PROTOCOL_CHAINS,
    yieldRows: yRows,
    factoryRows: factoryRows.map((row) => ({ ...row, poolSelections: undefined })),
    poolRows: allPools,
    directPoolConsumerRows: joins.directPoolConsumerRows,
    tokenContextRows: joins.tokenContextRows.slice(0, 150),
    watchCandidates,
    routePositiveRows: [],
    summary,
    blockers: ["No Aerodrome V1 pool/LP address is referenced by scanned consumer-grade artifacts", "Token-level matches are common-asset context and not Aerodrome-specific impact", "Public yield APY and pool reserves do not prove accepted-value divergence or extractive consumer economics", "No exact positive acquisition/manipulation/borrow/exit economics or fork proof"],
    requiredForRoutePositive: ["deployed consumer references an Aerodrome V1 pool/LP or oracle path", "pool/oracle state is permissionlessly movable or stale in attacker-favorable direction", "borrow, redemption, liquidation, or settlement route is exact-quoted and positive", "fork extraction proof"],
    nextReadOnlyStep: joins.directPoolConsumerRows.length ? "Static-review the matched consumer and exact-quote only if Aerodrome V1 pool state affects accepted value." : "Reopen Aerodrome V1 only if a lending/oracle consumer references a V1 pool/LP or a new adapter consumes Aerodrome V1 state.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));
  if (!QUIET) console.log(`Aerodrome V1 Phase 0: pools=${summary.poolsInspected} material=${summary.materialPoolRows} directPoolConsumers=${summary.directPoolConsumerRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
}

main().catch((err) => { console.error(err?.message || String(err)); process.exit(1); });
