#!/usr/bin/env node
// scan-fluid-dex-phase0.js - bounded read-only Phase 0 for Fluid DEX pool/share consumer joins.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "fluid-dex-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "fluid-dex-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const TARGET_DEPLOYMENTS = path.join(WORKSPACE, "targets", "fluid-contracts-public", "deployments");
const QUIET = process.argv.includes("--quiet");

const RPC_CONCURRENCY = Number(process.env.FLUID_DEX_RPC_CONCURRENCY || "8");
const MIN_MATERIAL_POOL_TVL_USD = Number(process.env.FLUID_DEX_MIN_MATERIAL_POOL_TVL_USD || "100000");
const MIN_WATCH_POOL_TVL_USD = Number(process.env.FLUID_DEX_MIN_WATCH_POOL_TVL_USD || "250000");

const CHAINS = {
  1: { name: "Ethereum", llamaNames: ["Ethereum"], coinSlug: "ethereum", deploymentDir: "mainnet", resolver: "0x7af0C11F5c787632e567e6418D74e5832d8FFd4c" },
  42161: { name: "Arbitrum", llamaNames: ["Arbitrum"], coinSlug: "arbitrum", deploymentDir: "arbitrum", resolver: "0x1De42938De444d376eBc298E15D21F409b946E6D" },
  8453: { name: "Base", llamaNames: ["Base"], coinSlug: "base", deploymentDir: "base", resolver: "0xa3B18522827491f10Fc777d00E69B3669Bf8c1f8" },
  137: { name: "Polygon", llamaNames: ["Polygon"], coinSlug: "polygon", deploymentDir: "polygon", resolver: "0xa17798d03bB563c618b9C44cAd937340Bad99138" },
};
const UNSUPPORTED_PROTOCOL_CHAINS = ["Plasma"];

const RESOLVER = new ethers.Interface([
  "function getAllDexAddresses() view returns (address[])",
  "function getDexTokens(address dex_) view returns (address token0_, address token1_)",
  "function getDexCollateralReserves(address dex_) view returns ((uint256 token0RealReserves,uint256 token1RealReserves,uint256 token0ImaginaryReserves,uint256 token1ImaginaryReserves))",
  "function FACTORY() view returns (address)",
  "function LIQUIDITY() view returns (address)",
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
const DIRECT_ROLES = new Set(["fluidDex"]);
const ZERO = "0x0000000000000000000000000000000000000000";
const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const NATIVE_META = {
  1: { symbol: "ETH", name: "Ether", priceKey: "coingecko:ethereum" },
  42161: { symbol: "ETH", name: "Ether", priceKey: "coingecko:ethereum" },
  8453: { symbol: "ETH", name: "Ether", priceKey: "coingecko:ethereum" },
  137: { symbol: "POL", name: "Polygon Ecosystem Token", priceKey: "coingecko:polygon-ecosystem-token" },
};
const STABLE_SYMBOLS = new Set(["USDC", "USDT", "USDT0", "DAI", "USDC.E", "USDCE", "GHO", "USDE", "SUSDE", "USDS", "SUSDS", "USD", "USDB"]);
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
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-fluid-dex-phase0/1.0" } });
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
  const protocolRow = discoveryRows.find((p) => p?.slug === "fluid-dex" || p?.name === "Fluid DEX");
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
  return { name: "Fluid DEX", slug: "fluid-dex", category: "Dexs", chains: Object.values(CHAINS).map((c) => c.name), tvlUsd: null };
}

async function tokenMeta(rpc, chainId, address, prices) {
  const cfg = CHAINS[chainId];
  const addr = normalizeAddress(address);
  if (!cfg || !addr || lowerAddress(addr) === ZERO) return null;
  if (lowerAddress(addr) === NATIVE_SENTINEL) {
    const native = NATIVE_META[chainId] || { symbol: "NATIVE", name: "Native token", priceKey: null };
    return { chainId: Number(chainId), chain: cfg.name, address: addr, symbol: native.symbol, name: native.name, decimals: 18, codePresent: false, codeBytes: 0, totalSupplyRaw: null, priceUsd: native.priceKey ? prices[native.priceKey] ?? null : null };
  }
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

function reserveField(reserves, index, name) {
  const value = reserves?.[0]?.[name] ?? reserves?.[0]?.[index];
  return value === undefined || value === null ? null : value.toString();
}

async function inspectResolver(chainId, rpc) {
  const cfg = CHAINS[chainId];
  const [resolverCode, factoryRaw, liquidityRaw, dexesRaw] = await Promise.all([
    getCode(rpc, cfg.resolver),
    safeCall(rpc, cfg.resolver, RESOLVER, "FACTORY"),
    safeCall(rpc, cfg.resolver, RESOLVER, "LIQUIDITY"),
    safeCall(rpc, cfg.resolver, RESOLVER, "getAllDexAddresses", [], 20_000),
  ]);
  const dexes = (dexesRaw?.[0] || []).map(normalizeAddress).filter(Boolean);
  return {
    chainId: Number(chainId),
    chain: cfg.name,
    resolver: cfg.resolver,
    resolverCodePresent: Boolean(resolverCode && resolverCode !== "0x"),
    resolverCodeBytes: resolverCode && resolverCode !== "0x" ? strip0x(resolverCode).length / 2 : 0,
    factory: normalizeAddress(factoryRaw?.[0]),
    liquidity: normalizeAddress(liquidityRaw?.[0]),
    dexCount: dexes.length,
    dexes,
  };
}

async function inspectDexes(chainId, rpc, dexes) {
  const cfg = CHAINS[chainId];
  const firstPass = await mapLimit(dexes, RPC_CONCURRENCY, async (dex) => {
    const [code, tokensRaw, reservesRaw] = await Promise.all([
      getCode(rpc, dex),
      safeCall(rpc, cfg.resolver, RESOLVER, "getDexTokens", [dex]),
      safeCall(rpc, cfg.resolver, RESOLVER, "getDexCollateralReserves", [dex]),
    ]);
    return {
      chainId: Number(chainId),
      chain: cfg.name,
      dex,
      resolver: cfg.resolver,
      codePresent: Boolean(code && code !== "0x"),
      codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
      token0: normalizeAddress(tokensRaw?.[0]),
      token1: normalizeAddress(tokensRaw?.[1]),
      token0RealReserveRaw: reserveField(reservesRaw, 0, "token0RealReserves"),
      token1RealReserveRaw: reserveField(reservesRaw, 1, "token1RealReserves"),
      token0ImaginaryReserveRaw: reserveField(reservesRaw, 2, "token0ImaginaryReserves"),
      token1ImaginaryReserveRaw: reserveField(reservesRaw, 3, "token1ImaginaryReserves"),
      routePositive: false,
    };
  });

  const priceKeys = [];
  for (const row of firstPass) {
    for (const token of [row.token0, row.token1]) {
      const addr = lowerAddress(token);
      if (!addr || addr === ZERO) continue;
      if (addr === NATIVE_SENTINEL) {
        const nativeKey = NATIVE_META[chainId]?.priceKey;
        if (nativeKey) priceKeys.push(nativeKey);
      } else {
        priceKeys.push(`${cfg.coinSlug}:${addr}`);
      }
    }
  }
  const prices = await loadPrices(priceKeys);
  const metaCache = new Map();
  async function meta(token) {
    const addr = lowerAddress(token);
    if (!addr || addr === ZERO) return null;
    const key = `${chainId}:${addr}`;
    if (!metaCache.has(key)) metaCache.set(key, tokenMeta(rpc, chainId, token, prices));
    return await metaCache.get(key);
  }

  const withMeta = await mapLimit(firstPass, RPC_CONCURRENCY, async (row) => {
    const [token0Meta, token1Meta] = await Promise.all([meta(row.token0), meta(row.token1)]);
    const reserve0 = decimalsToNumber(row.token0RealReserveRaw, token0Meta?.decimals);
    const reserve1 = decimalsToNumber(row.token1RealReserveRaw, token1Meta?.decimals);
    const reserve0Usd = reserve0 !== null && token0Meta?.priceUsd !== null && token0Meta?.priceUsd !== undefined ? reserve0 * token0Meta.priceUsd : null;
    const reserve1Usd = reserve1 !== null && token1Meta?.priceUsd !== null && token1Meta?.priceUsd !== undefined ? reserve1 * token1Meta.priceUsd : null;
    const knownUsd = (reserve0Usd || 0) + (reserve1Usd || 0);
    const poolTvlUsd = reserve0Usd !== null && reserve1Usd !== null ? knownUsd : knownUsd > 0 ? knownUsd * 2 : null;
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
      symbolPair: `${token0Meta?.symbol || compactAddress(row.token0)}/${token1Meta?.symbol || compactAddress(row.token1)}`,
      material: (asNumber(poolTvlUsd) || 0) >= MIN_MATERIAL_POOL_TVL_USD,
    };
  });

  return withMeta.sort((a, b) => (asNumber(b.poolTvlUsd) || 0) - (asNumber(a.poolTvlUsd) || 0));
}

function listJsonFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) listJsonFiles(full, out);
    else if (item.isFile() && item.name.endsWith(".json")) out.push(full);
  }
  return out;
}

function isDexTokenTuple(tuple) {
  return lowerAddress(tuple?.token0) && lowerAddress(tuple?.token1) && lowerAddress(tuple?.token1) !== ZERO;
}

function loadFluidVaultRows() {
  const rows = [];
  for (const [chainId, cfg] of Object.entries(CHAINS)) {
    const dir = path.join(TARGET_DEPLOYMENTS, cfg.deploymentDir);
    const files = listJsonFiles(dir).filter((file) => /VaultT[234].*DEX/i.test(path.basename(file)) && !/_Operate\.json$/i.test(file));
    for (const file of files) {
      const json = readJson(file, null);
      const args = json?.args?.[0] || {};
      const supplyDex = isDexTokenTuple(args.supplyToken) ? normalizeAddress(args.supply) : null;
      const borrowDex = isDexTokenTuple(args.borrowToken) ? normalizeAddress(args.borrow) : null;
      const dexAddresses = unique([supplyDex, borrowDex].map(normalizeAddress).filter(Boolean));
      if (!dexAddresses.length) continue;
      rows.push({
        chainId: Number(chainId),
        chain: cfg.name,
        file: path.relative(WORKSPACE, file).replace(/\\/g, "/"),
        name: path.basename(file, ".json"),
        vault: normalizeAddress(json?.address),
        vaultId: args.vaultId === undefined ? null : Number(args.vaultId),
        vaultType: args.vaultType === undefined ? null : Number(args.vaultType),
        supplyDex,
        borrowDex,
        dexAddresses,
        supplyToken0: normalizeAddress(args.supplyToken?.token0),
        supplyToken1: normalizeAddress(args.supplyToken?.token1),
        borrowToken0: normalizeAddress(args.borrowToken?.token0),
        borrowToken1: normalizeAddress(args.borrowToken?.token1),
        routePositive: false,
        blocker: "Fluid DEX vault consumer row is not impact without positive share/reserve manipulation economics and fork proof",
      });
    }
  }
  return rows;
}

async function annotateVaultCode(vaultRows, rpcs) {
  return await mapLimit(vaultRows, RPC_CONCURRENCY, async (row) => {
    const rpc = rpcs[row.chainId];
    const code = rpc ? await getCode(rpc, row.vault) : "0x";
    return { ...row, rpcAvailable: Boolean(rpc), codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0 };
  });
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
  const context = summarizeContext(obj);
  if (hits.length && (depth > 0 || Object.keys(context).length)) {
    const roles = unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.role)));
    out.push({
      source,
      hitRoles: roles,
      hitAddresses: hits.slice(0, 12),
      dexes: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.dex)).filter(Boolean)).slice(0, 10),
      context,
      directConsumer: DIRECT_SOURCE_SET.has(source) && roles.some((role) => DIRECT_ROLES.has(role)),
      routePositive: false,
      blocker: "Local artifact address match is context only unless Fluid DEX share/reserve state is consumed with exact positive economics",
    });
  }
  for (const value of Object.values(obj)) scanObjectForAddresses(source, value, addressRoles, out, depth + 1);
}

function localConsumerJoins(dexRows, resolverRows, vaultRows) {
  const roles = {};
  function add(addr, role, dex, chain, symbolPair) {
    const lower = lowerAddress(addr);
    if (!lower || lower === ZERO) return;
    if (!roles[lower]) roles[lower] = [];
    roles[lower].push({ role, dex, chain, symbolPair });
  }
  for (const row of resolverRows) {
    add(row.resolver, "resolver", null, row.chain, null);
    add(row.factory, "factory", null, row.chain, null);
    add(row.liquidity, "liquidity", null, row.chain, null);
  }
  for (const row of dexRows) {
    add(row.dex, "fluidDex", row.dex, row.chain, row.symbolPair);
    add(row.token0, "token0", row.dex, row.chain, row.symbolPair);
    add(row.token1, "token1", row.dex, row.chain, row.symbolPair);
  }
  for (const row of vaultRows) {
    add(row.vault, "fluidVaultConsumer", null, row.chain, row.name);
    for (const dex of row.dexAddresses || []) add(dex, "fluidVaultDexReference", dex, row.chain, row.name);
  }
  const matches = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) {
    const json = readJson(path.join(WORKSPACE, rel), null);
    if (!json) continue;
    scanObjectForAddresses(source, json, roles, matches);
  }
  const externalDirectConsumerRows = matches.filter((row) => row.directConsumer);
  const tokenContextRows = matches.filter((row) => !row.directConsumer);
  return { matches, externalDirectConsumerRows, tokenContextRows };
}

function buildReport(artifact) {
  const s = artifact.summary;
  const resolverTable = artifact.resolverRows.map((row) => `| ${row.chain} | ${compactAddress(row.resolver)} | ${row.resolverCodePresent ? "yes" : "no"} | ${row.dexCount} | ${compactAddress(row.factory)} | ${compactAddress(row.liquidity)} |`).join("\n");
  const topDexes = artifact.dexRows.slice(0, 12);
  const dexTable = topDexes.length ? topDexes.map((row) => `| ${row.chain} | ${compactAddress(row.dex)} | ${row.symbolPair} | ${formatUsd(row.poolTvlUsd)} | ${row.poolTvlInferred ? "yes" : "no"} | ${round(row.reserve0, 4) ?? "n/a"} | ${round(row.reserve1, 4) ?? "n/a"} |`).join("\n") : "| n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const vaultRows = artifact.fluidVaultConsumerRows.slice(0, 12);
  const vaultTable = vaultRows.length ? vaultRows.map((row) => `| ${row.chain} | ${row.vaultId ?? "n/a"} | ${row.name} | ${compactAddress(row.vault)} | ${row.dexAddresses.map(compactAddress).join(", ")} | ${row.codePresent ? "yes" : "no"} |`).join("\n") : "| none | n/a | n/a | n/a | n/a | n/a |";
  const consumerTable = artifact.externalDirectConsumerRows.length ? artifact.externalDirectConsumerRows.slice(0, 10).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${row.dexes.map(compactAddress).join(", ") || "n/a"} | ${safeText(row.context?.protocol || row.context?.project || row.context?.name || row.context?.surface || row.context?.file || "context", 80)} |`).join("\n") : "| none | n/a | n/a | n/a | no external Fluid DEX address consumer was found in scanned consumer-grade artifacts |";

  return `# ${SIGNAL_DORMANT} - Fluid DEX Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit. Fluid DEX resolver addresses, DEX token pairs, real collateral reserves, local Fluid VaultT2/T3/T4 DEX-share consumers, and external consumer joins were mapped across RPC-available EVM chains. Internal Fluid vault consumers are known protocol-native consumers, but existing source/live triage found no positive donation/reserve-skew path; route-positive requires a trusted consumer plus exact positive share/reserve manipulation, borrow/redeem/liquidation, and exit economics.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Chains with RPC | ${s.chainsScanned} |
| Unsupported protocol chains | ${artifact.unsupportedProtocolChains.join(", ") || "none"} |
| Resolvers code-present | ${s.resolversCodePresent} |
| DEXes discovered | ${s.dexesDiscovered} |
| DEXes inspected | ${s.dexesInspected} |
| Material DEX rows | ${s.materialDexRows} |
| Fluid vault DEX consumers | ${s.fluidVaultConsumerRows} |
| External direct consumer rows | ${s.externalDirectConsumerRows} |
| Token/context rows | ${s.tokenContextRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |

## Resolvers

| Chain | Resolver | Code | DEXes | Factory | Liquidity |
|---|---|---|---:|---|---|
${resolverTable}

## Top DEX Rows

| Chain | DEX | Tokens | Real Reserve TVL | Inferred TVL | Reserve0 | Reserve1 |
|---|---|---|---:|---|---:|---:|
${dexTable}

## Fluid Vault DEX Consumers

| Chain | Vault ID | Name | Vault | DEX refs | Code |
|---|---:|---|---|---|---|
${vaultTable}

## External Direct Consumer Join

| Source | Hit roles | Addresses | DEXes | Context |
|---|---|---|---|---|
${consumerTable}

## Blockers

- No external lending, vault, margin, or oracle artifact currently references a Fluid DEX address as a value-bearing consumer.
- Fluid VaultT2/T3/T4 rows are internal protocol-native DEX-share consumers; prior Fluid source/live triage found no positive donation or reserve-skew path.
- Token-level joins are common-asset context, not Fluid DEX-specific impact.
- Fluid DEX real reserves and share accounting do not prove accepted-value divergence or extractive consumer economics by themselves.
- No exact positive acquisition, share/reserve manipulation, borrow, and exit economics or fork proof exists.

## Required For Route-Positive

- A deployed consumer references a Fluid DEX address/share path or Fluid DEX oracle state.
- Fluid DEX share/reserve accounting is permissionlessly movable, stale, donation-sensitive, or rounding-sensitive in an attacker-favorable direction.
- Borrow, redemption, liquidation, or settlement liquidity is material and exact-quoted after fees, gas, and slippage.
- Fork extraction proof shows positive net value.

Artifacts: \`reports/raw/fast/fluid-dex-phase0.json\`.
`;
}

async function main() {
  const metadata = protocolMetadata();
  const chainIds = Object.keys(CHAINS).map(Number);
  const rpcs = await resolveRpcPool(chainIds);
  const resolverRows = [];
  const allDexRows = [];

  for (const chainId of chainIds) {
    const rpc = rpcs[chainId];
    const cfg = CHAINS[chainId];
    if (!rpc) {
      resolverRows.push({ chainId, chain: cfg.name, resolver: cfg.resolver, rpcAvailable: false, resolverCodePresent: false, resolverCodeBytes: 0, factory: null, liquidity: null, dexCount: 0, dexes: [] });
      continue;
    }
    const resolver = await inspectResolver(chainId, rpc);
    resolver.rpcAvailable = true;
    resolverRows.push(resolver);
    if (resolver.dexes.length) {
      const dexRows = await inspectDexes(chainId, rpc, resolver.dexes);
      allDexRows.push(...dexRows);
    }
  }

  allDexRows.sort((a, b) => (asNumber(b.poolTvlUsd) || 0) - (asNumber(a.poolTvlUsd) || 0));
  const rawVaultRows = loadFluidVaultRows();
  const dexSet = new Set(allDexRows.map((row) => lowerAddress(row.dex)).filter(Boolean));
  const fluidVaultConsumerRows = (await annotateVaultCode(rawVaultRows, rpcs))
    .map((row) => ({ ...row, matchedCurrentResolverDexes: row.dexAddresses.filter((addr) => dexSet.has(lowerAddress(addr))) }))
    .filter((row) => row.matchedCurrentResolverDexes.length > 0);
  const joins = localConsumerJoins(allDexRows, resolverRows, fluidVaultConsumerRows);
  const externalDirectConsumerRows = joins.externalDirectConsumerRows;
  const directDexSet = new Set(externalDirectConsumerRows.flatMap((row) => row.dexes.map(lowerAddress)).filter(Boolean));
  const watchCandidates = allDexRows
    .filter((row) => directDexSet.has(lowerAddress(row.dex)) && (asNumber(row.poolTvlUsd) || 0) >= MIN_WATCH_POOL_TVL_USD)
    .map((row) => ({ ...row, reason: "External consumer artifact references a Fluid DEX address and reserve TVL is material", routePositive: false }));

  const summary = {
    chainsScanned: resolverRows.filter((row) => row.rpcAvailable).length,
    chainsWithRpc: resolverRows.filter((row) => row.rpcAvailable).map((row) => row.chainId),
    chainsMissingRpc: resolverRows.filter((row) => !row.rpcAvailable).map((row) => row.chainId),
    unsupportedProtocolChains: UNSUPPORTED_PROTOCOL_CHAINS.length,
    resolversCodePresent: resolverRows.filter((row) => row.resolverCodePresent).length,
    dexesDiscovered: resolverRows.reduce((sum, row) => sum + (asNumber(row.dexCount) || 0), 0),
    dexesInspected: allDexRows.length,
    materialDexRows: allDexRows.filter((row) => (asNumber(row.poolTvlUsd) || 0) >= MIN_MATERIAL_POOL_TVL_USD).length,
    fluidVaultConsumerRows: fluidVaultConsumerRows.length,
    externalDirectConsumerRows: externalDirectConsumerRows.length,
    tokenContextRows: joins.tokenContextRows.length,
    watchCandidates: watchCandidates.length,
    maxPoolTvlUsd: round(Math.max(0, ...allDexRows.map((row) => asNumber(row.poolTvlUsd) || 0)), 2),
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    closedReason: externalDirectConsumerRows.length
      ? "external Fluid DEX consumer references found, but no exact-positive manipulation/borrow/exit economics or fork proof"
      : "no external Fluid DEX address is referenced by scanned consumer-grade artifacts",
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-fluid-dex-phase0.js",
    scope: "Read-only Fluid DEX resolver/share and consumer-route Phase 0 scan",
    target: { name: "Fluid DEX", slug: "fluid-dex", category: "Dexs", surface: "dex-oracle-consumer-only", metadata },
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
    thresholds: { minMaterialPoolTvlUsd: MIN_MATERIAL_POOL_TVL_USD, minWatchPoolTvlUsd: MIN_WATCH_POOL_TVL_USD },
    docs: {
      adapter: "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/fluid-dex/index.js",
      source: "https://github.com/Instadapp/fluid-contracts-public",
      priorTriage: "reports/fluid-triage.md",
    },
    unsupportedProtocolChains: UNSUPPORTED_PROTOCOL_CHAINS,
    resolverRows: resolverRows.map((row) => ({ ...row, dexes: undefined })),
    dexRows: allDexRows,
    fluidVaultConsumerRows,
    externalDirectConsumerRows,
    tokenContextRows: joins.tokenContextRows.slice(0, 150),
    watchCandidates,
    routePositiveRows: [],
    summary,
    blockers: [
      "No external Fluid DEX address is referenced by scanned consumer-grade artifacts",
      "Fluid VaultT2/T3/T4 rows are internal protocol-native consumers and prior triage found no positive donation/reserve-skew path",
      "Token-level matches are common-asset context and not Fluid DEX-specific impact",
      "No exact positive acquisition/share-reserve manipulation/borrow/exit economics or fork proof",
    ],
    requiredForRoutePositive: [
      "deployed consumer references a Fluid DEX address/share path or Fluid DEX oracle state",
      "Fluid DEX share/reserve state is permissionlessly movable or stale in attacker-favorable direction",
      "borrow, redemption, liquidation, or settlement route is exact-quoted and positive",
      "fork extraction proof",
    ],
    nextReadOnlyStep: externalDirectConsumerRows.length
      ? "Static-review matched external consumer and exact-quote only if Fluid DEX state affects accepted value."
      : "Reopen Fluid DEX only if an external lending/oracle consumer references a Fluid DEX address/share path or a new adapter consumes Fluid DEX state.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));

  if (!QUIET) {
    console.log(`Fluid DEX Phase 0: dexes=${summary.dexesInspected} material=${summary.materialDexRows} vaultConsumers=${summary.fluidVaultConsumerRows} externalConsumers=${summary.externalDirectConsumerRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
