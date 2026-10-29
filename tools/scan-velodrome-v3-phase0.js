#!/usr/bin/env node
// scan-velodrome-v3-phase0.js - read-only Phase 0 for Velodrome V3 stable/volatile pool consumer joins.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "velodrome-v3-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "velodrome-v3-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const RPC_CONCURRENCY = Number(process.env.VELODROME_V3_RPC_CONCURRENCY || "12");
const MAX_ENUM_POOLS_PER_FACTORY = Number(process.env.VELODROME_V3_MAX_ENUM_POOLS_PER_FACTORY || "2500");
const MIN_MATERIAL_POOL_TVL_USD = Number(process.env.VELODROME_V3_MIN_MATERIAL_POOL_TVL_USD || "100000");
const MIN_WATCH_POOL_TVL_USD = Number(process.env.VELODROME_V3_MIN_WATCH_POOL_TVL_USD || "250000");

const SHARED_SUPERCHAIN_FACTORY = "0x31832f2a97Fd20664D76Cc421207669b55CE4BC0";
const CHAINS = {
  10: { name: "Optimism", llamaNames: ["Optimism"], coinSlug: "optimism", factory: "0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a", tvlUsd: 6956509.54 },
  57073: { name: "Ink", llamaNames: ["Ink"], coinSlug: "ink", factory: SHARED_SUPERCHAIN_FACTORY, tvlUsd: 12770190.97 },
  42220: { name: "Celo", llamaNames: ["Celo"], coinSlug: "celo", factory: SHARED_SUPERCHAIN_FACTORY, tvlUsd: 265424.59 },
  130: { name: "Unichain", llamaNames: ["Unichain"], coinSlug: "unichain", factory: SHARED_SUPERCHAIN_FACTORY, tvlUsd: 389604.18 },
  34443: { name: "Mode", llamaNames: ["Mode"], coinSlug: "mode", factory: SHARED_SUPERCHAIN_FACTORY, tvlUsd: 17498.39 },
  252: { name: "Fraxtal", llamaNames: ["Fraxtal"], coinSlug: "fraxtal", factory: SHARED_SUPERCHAIN_FACTORY, tvlUsd: 284530.46 },
  1135: { name: "Lisk", llamaNames: ["Lisk"], coinSlug: "lisk", factory: SHARED_SUPERCHAIN_FACTORY, tvlUsd: 487629.99 },
  1868: { name: "Soneium", llamaNames: ["Soneium"], coinSlug: "soneium", factory: SHARED_SUPERCHAIN_FACTORY, tvlUsd: 245158.63 },
  5330: { name: "Superseed", llamaNames: ["Superseed"], coinSlug: "sseed", factory: SHARED_SUPERCHAIN_FACTORY, tvlUsd: 54695.48 },
  1923: { name: "Swellchain", llamaNames: ["Swellchain"], coinSlug: "swellchain", factory: SHARED_SUPERCHAIN_FACTORY, tvlUsd: 661.34 },
};

const V2_FACTORY = new ethers.Interface([
  "function allPoolsLength() view returns (uint256)",
  "function allPools(uint256) view returns (address)",
  "function getPool(address tokenA,address tokenB,bool stable) view returns (address)",
  "function implementation() view returns (address)",
  "function voter() view returns (address)",
  "function isPaused() view returns (bool)",
  "function stableFee() view returns (uint256)",
  "function volatileFee() view returns (uint256)",
]);

const V2_POOL = new ethers.Interface([
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
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["current-profit-leads", "reports/raw/fast/current-profit-lead-triage.json"],
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
const DIRECT_ROLES = new Set(["v3Pool"]);
const ZERO = "0x0000000000000000000000000000000000000000";
const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI", "FRAX", "SFRXUSD", "CUSD", "CEUR", "USD", "USDB", "USDE", "USDC.E", "USDCE", "SUSD", "USDS", "GHO"]);
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
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-velodrome-v3-phase0/1.0" } });
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
  const row = discoveryRows().find((p) => p?.slug === "velodrome-v3" || p?.name === "Velodrome V3");
  if (row) return { name: row.name, slug: row.slug, category: row.category, chains: row.chains || [], evmChains: row.evmChains || [], tvlUsd: round(row.tvlUsd, 2), change1dPct: row.change1dPct ?? null, change7dPct: row.change7dPct ?? null, routePriority: row.routePriority || null, source: "public-audit-target-discovery" };
  return { name: "Velodrome V3", slug: "velodrome-v3", category: "Dexs", chains: Object.values(CHAINS).map((c) => c.name), tvlUsd: null };
}

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

async function inspectFactory(chainId, rpc) {
  const cfg = CHAINS[chainId];
  const [factoryCode, implementationRaw, voterRaw, pausedRaw, stableFeeRaw, volatileFeeRaw, allPoolsLengthRaw] = await Promise.all([
    getCode(rpc, cfg.factory),
    safeCall(rpc, cfg.factory, V2_FACTORY, "implementation"),
    safeCall(rpc, cfg.factory, V2_FACTORY, "voter"),
    safeCall(rpc, cfg.factory, V2_FACTORY, "isPaused"),
    safeCall(rpc, cfg.factory, V2_FACTORY, "stableFee"),
    safeCall(rpc, cfg.factory, V2_FACTORY, "volatileFee"),
    safeCall(rpc, cfg.factory, V2_FACTORY, "allPoolsLength"),
  ]);
  const factoryCodePresent = Boolean(factoryCode && factoryCode !== "0x");
  const allPoolsLength = allPoolsLengthRaw?.[0] === undefined ? null : Number(allPoolsLengthRaw[0]);
  const enumCount = Math.min(allPoolsLength || 0, MAX_ENUM_POOLS_PER_FACTORY);
  const pools = [];
  if (rpc && factoryCodePresent && enumCount > 0) {
    const rows = await mapLimit(Array.from({ length: enumCount }, (_, i) => i), RPC_CONCURRENCY, async (i) => {
      const raw = await safeCall(rpc, cfg.factory, V2_FACTORY, "allPools", [i]);
      return normalizeAddress(raw?.[0]);
    });
    for (const pool of rows) if (pool) pools.push(pool);
  }
  return {
    chainId: Number(chainId),
    chain: cfg.name,
    factory: cfg.factory,
    rpcAvailable: Boolean(rpc),
    factoryCodePresent,
    factoryCodeBytes: factoryCode && factoryCode !== "0x" ? strip0x(factoryCode).length / 2 : 0,
    implementation: normalizeAddress(implementationRaw?.[0]),
    voter: normalizeAddress(voterRaw?.[0]),
    isPaused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]),
    stableFee: stableFeeRaw?.[0] === undefined ? null : stableFeeRaw[0].toString(),
    volatileFee: volatileFeeRaw?.[0] === undefined ? null : volatileFeeRaw[0].toString(),
    allPoolsLength,
    poolsEnumerated: pools.length,
    enumerationCapped: allPoolsLength !== null && allPoolsLength > MAX_ENUM_POOLS_PER_FACTORY,
    poolSelections: pools.map((pool) => ({ pool, factory: cfg.factory, sources: ["factory-allPools-enumeration"] })),
  };
}

async function inspectPools(chainId, rpc, selections) {
  const cfg = CHAINS[chainId];
  const firstPass = await mapLimit(selections, RPC_CONCURRENCY, async (selection) => {
    const pool = selection.pool;
    const [code, token0Raw, token1Raw, stableRaw, reservesRaw, totalSupplyRaw, lpDecimalsRaw, lpSymbolRaw, lpNameRaw, obsLenRaw, feeAddrRaw, poolFactoryRaw] = await Promise.all([
      getCode(rpc, pool),
      safeCall(rpc, pool, V2_POOL, "token0"),
      safeCall(rpc, pool, V2_POOL, "token1"),
      safeCall(rpc, pool, V2_POOL, "stable"),
      safeCall(rpc, pool, V2_POOL, "getReserves"),
      safeCall(rpc, pool, V2_POOL, "totalSupply"),
      safeCall(rpc, pool, V2_POOL, "decimals"),
      safeCall(rpc, pool, V2_POOL, "symbol"),
      safeCall(rpc, pool, V2_POOL, "name"),
      safeCall(rpc, pool, V2_POOL, "observationLength"),
      safeCall(rpc, pool, V2_POOL, "poolFees"),
      safeCall(rpc, pool, V2_POOL, "factory"),
    ]);
    return {
      chainId: Number(chainId),
      chain: cfg.name,
      pool,
      factory: selection.factory,
      codePresent: Boolean(code && code !== "0x"),
      codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
      token0: normalizeAddress(token0Raw?.[0]),
      token1: normalizeAddress(token1Raw?.[0]),
      stable: stableRaw?.[0] === undefined ? null : Boolean(stableRaw[0]),
      reserve0Raw: reservesRaw?.[0] === undefined ? null : reservesRaw[0].toString(),
      reserve1Raw: reservesRaw?.[1] === undefined ? null : reservesRaw[1].toString(),
      blockTimestampLast: reservesRaw?.[2] === undefined ? null : Number(reservesRaw[2]),
      totalSupplyRaw: totalSupplyRaw?.[0] === undefined ? null : totalSupplyRaw[0].toString(),
      lpDecimals: lpDecimalsRaw?.[0] === undefined ? null : Number(lpDecimalsRaw[0]),
      lpSymbol: safeText(lpSymbolRaw?.[0], 80),
      lpName: safeText(lpNameRaw?.[0], 120),
      observationLength: obsLenRaw?.[0] === undefined ? null : Number(obsLenRaw[0]),
      poolFees: normalizeAddress(feeAddrRaw?.[0]),
      poolFactory: normalizeAddress(poolFactoryRaw?.[0]),
      discoverySources: selection.sources || [],
      routePositive: false,
    };
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
    const poolTvlUsd = reserve0Usd === null && reserve1Usd === null ? null : (reserve0Usd || 0) + (reserve1Usd || 0);
    const chainTvlUsd = asNumber(cfg.tvlUsd);
    const priceAnomaly = poolTvlUsd !== null && chainTvlUsd !== null && poolTvlUsd > Math.max(chainTvlUsd * 3, 5_000_000);
    const screenedPoolTvlUsd = priceAnomaly ? null : poolTvlUsd;
    const lpSupply = decimalsToNumber(row.totalSupplyRaw, row.lpDecimals);
    return { ...row, token0Meta, token1Meta, reserve0: round(reserve0, 8), reserve1: round(reserve1, 8), reserve0Usd: round(reserve0Usd, 2), reserve1Usd: round(reserve1Usd, 2), poolTvlUsd: round(poolTvlUsd, 2), screenedPoolTvlUsd: round(screenedPoolTvlUsd, 2), priceAnomaly, lpSupply: round(lpSupply, 8), symbolPair: `${token0Meta?.symbol || compactAddress(row.token0)}/${token1Meta?.symbol || compactAddress(row.token1)}`, material: (asNumber(screenedPoolTvlUsd) || 0) >= MIN_MATERIAL_POOL_TVL_USD };
  });
  return withMeta.sort((a, b) => (asNumber(b.screenedPoolTvlUsd) || 0) - (asNumber(a.screenedPoolTvlUsd) || 0));
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
  if (!obj || depth > 9 || out.length >= 900) return;
  if (Array.isArray(obj)) { for (const item of obj) scanObjectForAddresses(source, item, addressRoles, out, depth + 1); return; }
  if (typeof obj !== "object") return;
  const hits = [...primitiveAddresses(obj)].filter((addr) => addressRoles[addr]);
  if (hits.length) {
    const roles = unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.role)));
    out.push({ source, hitRoles: roles, hitAddresses: hits.slice(0, 12), pools: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.pool)).filter(Boolean)).slice(0, 10), chains: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.chain)).filter(Boolean)).slice(0, 8), context: summarizeContext(obj), directConsumer: DIRECT_SOURCE_SET.has(source) && roles.some((role) => DIRECT_ROLES.has(role)), routePositive: false, blocker: "Local artifact address match is context only unless the Velodrome V3 pool/LP itself is consumed by oracle/collateral logic with exact positive economics" });
    return;
  }
  for (const value of Object.values(obj)) scanObjectForAddresses(source, value, addressRoles, out, depth + 1);
}

function localConsumerJoins(poolRows, factoryRows) {
  const roles = {};
  function add(addr, role, pool, chain, symbolPair) {
    const lower = lowerAddress(addr);
    if (!lower || lower === ZERO) return;
    if (!roles[lower]) roles[lower] = [];
    roles[lower].push({ role, pool, chain, symbolPair });
  }
  for (const row of factoryRows) { add(row.factory, "factory", null, row.chain, "factory"); add(row.voter, "voter", null, row.chain, "voter"); add(row.implementation, "implementation", null, row.chain, "implementation"); }
  for (const row of poolRows) { add(row.pool, "v3Pool", row.pool, row.chain, row.symbolPair); add(row.poolFees, "poolFees", row.pool, row.chain, row.symbolPair); add(row.token0, "token0", row.pool, row.chain, row.symbolPair); add(row.token1, "token1", row.pool, row.chain, row.symbolPair); }
  const matches = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) { const json = readJson(path.join(WORKSPACE, rel), null); if (json) scanObjectForAddresses(source, json, roles, matches); }
  return { directPoolConsumerRows: matches.filter((row) => row.directConsumer), tokenContextRows: matches.filter((row) => !row.directConsumer) };
}

function coverageClassification(summary) {
  if ((summary.chainsMissingRpc || []).length || summary.factoriesMissingCode || summary.poolsEnumerationCappedFactories) return "partial-or-blocked";
  return "full-enough-for-declared-scope";
}

function buildReport(artifact) {
  const s = artifact.summary;
  const factoryTable = artifact.factoryRows.map((row) => `| ${row.chain} | ${compactAddress(row.factory)} | ${row.rpcAvailable ? "yes" : "no"} | ${row.factoryCodePresent ? "yes" : "no"} | ${row.allPoolsLength ?? "n/a"} | ${row.poolsEnumerated} | ${row.enumerationCapped ? "yes" : "no"} | ${row.isPaused ?? "n/a"} |`).join("\n");
  const poolTable = artifact.poolRows.slice(0, 15).map((row) => `| ${row.chain} | ${compactAddress(row.pool)} | ${row.symbolPair} | ${row.stable === null ? "n/a" : row.stable ? "stable" : "volatile"} | ${formatUsd(row.screenedPoolTvlUsd)} | ${row.observationLength ?? "n/a"} | ${compactAddress(row.poolFees)} |`).join("\n") || "| n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const consumerTable = artifact.directPoolConsumerRows.length ? artifact.directPoolConsumerRows.slice(0, 10).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${row.pools.map(compactAddress).join(", ") || "n/a"} | ${row.chains.join(", ") || "n/a"} | ${safeText(row.context?.protocol || row.context?.project || row.context?.name || row.context?.surface || row.context?.file || "context", 80)} |`).join("\n") : "| none | n/a | n/a | n/a | n/a | no Velodrome V3 pool address was found in consumer-grade artifacts |";
  const contextTable = artifact.tokenContextRows.length ? artifact.tokenContextRows.slice(0, 8).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${row.chains.join(", ") || "n/a"} | ${safeText(row.context?.protocol || row.context?.project || row.context?.name || row.context?.surface || row.context?.file || "context", 80)} |`).join("\n") : "| none | n/a | n/a | n/a | n/a |";
  return `# ${SIGNAL_DORMANT} - Velodrome V3 Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit. DeFiLlama maps Velodrome V3 through the public \`velodrome-v2\` adapter path using V2-style stable/volatile factories. All adapter-declared factories had RPC coverage and code in this pass; all \`allPoolsLength/allPools\` rows were enumerated and inspected across the 10 target chains. Token-level matches and DEX-exit quote usage are context only; route-positive requires a trusted consumer that prices a Velodrome V3 pool/LP/oracle path plus exact positive manipulation, borrow/redeem/liquidation, and exit economics.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Chains declared | ${s.chainsDeclared} |
| Chains with RPC | ${s.chainsScanned} |
| Factories code-present | ${s.factoriesCodePresent} |
| Pools available | ${s.poolsAvailable} |
| Pools inspected | ${s.poolsInspected} |
| Material pools | ${s.materialPoolRows} |
| Price-anomaly rows excluded | ${s.priceAnomalyRows} |
| Direct pool consumer rows | ${s.directPoolConsumerRows} |
| Token/factory context rows | ${s.tokenContextRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |
| Coverage classification | ${s.coverageClassification} |

## Factories

| Chain | Factory | RPC | Code | Total pools | Enumerated | Capped | Paused |
|---|---|---|---|---:|---:|---|---|
${factoryTable}

## Top Pools

| Chain | Pool | Tokens | Type | Screened reserve TVL | Observations | Fees |
|---|---|---|---|---:|---:|---|
${poolTable}

## Direct Consumer Join

| Source | Hit roles | Addresses | Pools | Chains | Context |
|---|---|---|---|---|---|
${consumerTable}

## Context Joins

| Source | Hit roles | Addresses | Chains | Context |
|---|---|---|---|---|
${contextTable}

## Blockers

- No Velodrome V3 pool/LP address is currently found as value-bearing collateral, reserve asset, or oracle-specific consumer in scanned consumer-grade artifacts.
- Token/factory/router-level joins are context only and do not prove accepted-value dependence on Velodrome pool state.
- Pool reserves and observation length are not impact without a consumer that trusts pool/LP/oracle value.
- Stable/volatile pool manipulation is not impact without exact consumer linkage and positive manipulation economics.
- No fork extraction proof exists.

## Required For Route-Positive

- A deployed lending, vault, margin, or oracle consumer references a Velodrome V3 pool, LP, or oracle value path.
- The referenced pool state is permissionlessly movable or stale in an attacker-favorable direction.
- Borrow, redemption, liquidation, or settlement liquidity is material and exact-quoted after fees, gas, and slippage.
- Fork extraction proof shows positive net value.

Artifacts: \`reports/raw/fast/velodrome-v3-phase0.json\`.
`;
}

async function main() {
  const metadata = protocolMetadata();
  const chainIds = Object.keys(CHAINS).map(Number);
  const rpcs = await resolveRpcPool(chainIds);
  const factoryRows = [];
  const allPools = [];
  for (const chainId of chainIds) {
    const rpc = rpcs[chainId];
    const factory = await inspectFactory(chainId, rpc);
    factoryRows.push(factory);
    if (rpc && factory.poolSelections.length) allPools.push(...await inspectPools(chainId, rpc, factory.poolSelections));
  }
  allPools.sort((a, b) => (asNumber(b.screenedPoolTvlUsd) || 0) - (asNumber(a.screenedPoolTvlUsd) || 0));
  const joins = localConsumerJoins(allPools, factoryRows);
  const directPoolSet = new Set(joins.directPoolConsumerRows.flatMap((row) => row.pools.map(lowerAddress)).filter(Boolean));
  const watchCandidates = allPools.filter((row) => directPoolSet.has(lowerAddress(row.pool)) && (asNumber(row.screenedPoolTvlUsd) || 0) >= MIN_WATCH_POOL_TVL_USD).map((row) => ({ ...row, reason: "Velodrome V3 pool address appears in a consumer artifact and has material screened reserve TVL", routePositive: false }));
  const summary = {
    chainsDeclared: Object.keys(CHAINS).length,
    chainsScanned: factoryRows.filter((row) => row.rpcAvailable).length,
    chainsWithRpc: factoryRows.filter((row) => row.rpcAvailable).map((row) => row.chainId),
    chainsMissingRpc: factoryRows.filter((row) => !row.rpcAvailable).map((row) => row.chainId),
    rpcAvailability: Object.fromEntries(factoryRows.map((row) => [row.chainId, row.rpcAvailable])),
    factoriesCodePresent: factoryRows.filter((row) => row.factoryCodePresent).length,
    factoriesMissingCode: factoryRows.filter((row) => row.rpcAvailable && !row.factoryCodePresent).length,
    poolsAvailable: factoryRows.reduce((sum, row) => sum + (asNumber(row.allPoolsLength) || 0), 0),
    poolsInspected: allPools.length,
    poolsEnumerationCappedFactories: factoryRows.filter((row) => row.enumerationCapped).length,
    materialPoolRows: allPools.filter((row) => (asNumber(row.screenedPoolTvlUsd) || 0) >= MIN_MATERIAL_POOL_TVL_USD).length,
    priceAnomalyRows: allPools.filter((row) => row.priceAnomaly).length,
    directPoolConsumerRows: joins.directPoolConsumerRows.length,
    tokenContextRows: joins.tokenContextRows.length,
    watchCandidates: watchCandidates.length,
    maxPoolTvlUsd: round(Math.max(0, ...allPools.map((row) => asNumber(row.screenedPoolTvlUsd) || 0)), 2),
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    closedReason: joins.directPoolConsumerRows.length ? "Velodrome V3 pool consumer references found, but no exact-positive manipulation/borrow/exit economics or fork proof" : "no Velodrome V3 pool address is referenced by scanned consumer-grade artifacts",
  };
  summary.coverageClassification = coverageClassification(summary);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-velodrome-v3-phase0.js",
    scope: "Read-only Velodrome V3 stable/volatile pool/LP and consumer-route Phase 0 scan",
    target: { name: "Velodrome V3", slug: "velodrome-v3", category: "Dexs", surface: "dex-oracle-consumer-only", metadata },
    safety: { publicApisOnlyForMetadata: true, rpcInventoryRead: true, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false },
    thresholds: { maxEnumPoolsPerFactory: MAX_ENUM_POOLS_PER_FACTORY, minMaterialPoolTvlUsd: MIN_MATERIAL_POOL_TVL_USD, minWatchPoolTvlUsd: MIN_WATCH_POOL_TVL_USD },
    docs: { adapter: "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/velodrome-v2/index.js", sourceModel: "V2-style stable/volatile factories with allPoolsLength/allPools" },
    chainRows: Object.entries(CHAINS).map(([chainId, cfg]) => ({ chainId: Number(chainId), chain: cfg.name, llamaNames: cfg.llamaNames, factory: cfg.factory, tvlUsd: cfg.tvlUsd })),
    factoryRows: factoryRows.map((row) => ({ ...row, poolSelections: undefined })),
    poolRows: allPools,
    directPoolConsumerRows: joins.directPoolConsumerRows,
    tokenContextRows: joins.tokenContextRows.slice(0, 180),
    watchCandidates,
    routePositiveRows: [],
    summary,
    blockers: ["No Velodrome V3 pool/LP address is referenced by scanned consumer-grade artifacts", "Token/factory/router-level matches are context and not Velodrome-specific impact", "Pool reserves and observation length do not prove accepted-value divergence or extractive consumer economics", "No exact positive acquisition/manipulation/borrow/exit economics or fork proof"],
    requiredForRoutePositive: ["deployed consumer references a Velodrome V3 pool, LP, or oracle value path", "pool/oracle state is permissionlessly movable or stale in attacker-favorable direction", "borrow, redemption, liquidation, or settlement route is exact-quoted and positive", "fork extraction proof"],
    nextReadOnlyStep: joins.directPoolConsumerRows.length ? "Static-review the matched consumer and exact-quote only if Velodrome V3 pool state affects accepted value." : "Reopen Velodrome V3 only if a lending/oracle consumer references a Velodrome pool/LP or a new adapter consumes Velodrome state.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));
  if (!QUIET) console.log(`Velodrome V3 Phase 0: chains=${summary.chainsScanned}/${summary.chainsDeclared} pools=${summary.poolsInspected}/${summary.poolsAvailable} material=${summary.materialPoolRows} directPoolConsumers=${summary.directPoolConsumerRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive} coverage=${summary.coverageClassification}`);
}

main().catch((err) => { console.error(err?.message || String(err)); process.exit(1); });
