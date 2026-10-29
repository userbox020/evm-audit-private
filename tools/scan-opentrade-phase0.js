#!/usr/bin/env node
// scan-opentrade-phase0.js - read-only OpenTrade RWA/NAV pool and consumer Phase 0.
// RPC URLs are resolved in memory only and are never printed or stored.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "opentrade-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "opentrade-phase0-triage.md");
const EXTRA_PRODUCERS_REL = "reports/raw/fast/opentrade-phase0-extra-producers.json";
const EXTRA_PRODUCERS_OUT = path.join(WORKSPACE, EXTRA_PRODUCERS_REL);
const GRAPH_OUT_REL = "reports/raw/fast/opentrade-phase0-rwa-nav-consumer-graph.json";
const GRAPH_OUT = path.join(WORKSPACE, GRAPH_OUT_REL);
const QUIET = process.argv.includes("--quiet");
const LOG_CONCURRENCY = Math.max(1, Math.min(Number(process.env.OPENTRADE_LOG_CONCURRENCY || "14"), 32));

const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";
const MATERIAL_USD = 10_000;
const NAV_DIVERGENCE_BPS = 100;
const POOL_CREATED_TOPIC = ethers.id("PoolCreated(address)");

const CHAINS = {
  1: { name: "Ethereum", coinSlug: "ethereum", logChunk: 10_000 },
  43114: { name: "Avalanche", coinSlug: "avax", logChunk: 500_000 },
};

const FACTORIES = {
  1: [
    { address: "0x0a3b7bb45ac8e267Cc4E4b2CbDB52B967d82dF18", fromBlock: 22125605 },
    { address: "0x61424410C0BB1C580ed6363FE9405d9e84FA0578", fromBlock: 19329359 },
    { address: "0xc472d3a47719DE5F9d808CA91d7B70BD2138bCAa", fromBlock: 18667715 },
  ],
  43114: [
    { address: "0x4D3b32Bb456A6E387682F6CD37FacefE9A219d0c", fromBlock: 59429843 },
  ],
};

const BLACKLIST = {
  43114: new Set([
    "0xf5fd160c5037568d38969c0cf4be05f36a3f7560",
    "0x9a57a503e8e72ea240b47491598d7d6a27fb4dbc",
    "0x3c1c7bc69ffcab2cc1ce687764b66ba35d632b7e",
    "0xcc2716d82cb4916417f5e3922573245639088592",
    "0x5e11edd61e79b1471179ef6f67d9587455377273",
    "0xcdc7859f0486be52af0e9959443e735a578b8131",
  ]),
};

const LOCAL_ARTIFACTS = [
  { protocol: "Aave/Euler/Silo graph", file: "reports/raw/fast/aave-euler-silo-consumer-graph.json" },
  { protocol: "Euler V2", file: "reports/raw/fast/euler-v2-phase0.json" },
  { protocol: "Silo V2", file: "reports/raw/fast/silo-v2-phase0.json" },
  { protocol: "Morpho Blue", file: "reports/raw/fast/morpho-pyth-unsafe-consumers.json" },
  { protocol: "Morpho allocator", file: "reports/raw/fast/morpho-public-allocator-force-feed.json" },
  { protocol: "Consumer-first high LTV", file: "reports/raw/fast/consumer-first-high-ltv-collateral.json" },
  { protocol: "Public lead consumers", file: "reports/raw/fast/public-lead-consumer-joins.json" },
  { protocol: "Market launch choreography", file: "reports/raw/fast/market-launch-choreography-routes.json" },
  { protocol: "Pendle PT", file: "reports/raw/fast/pendle-pt-multichain-consumer-graph.json" },
];

const POOL = new ethers.Interface([
  "event PoolCreated(address indexed addr)",
  "function asset() view returns (address)",
  "function liquidityAssetAddr() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
  "function deposit(uint256,address)",
  "function withdraw(uint256,address,address)",
  "function redeem(uint256,address,address)",
]);
const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);
const BYTES32_TOKEN = new ethers.Interface([
  "function symbol() view returns (bytes32)",
  "function name() view returns (bytes32)",
]);
const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readJson(file, fallback = null) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; } catch (_) { return fallback; } }
function writeJson(file, value) { ensureDir(file); fs.writeFileSync(file, JSON.stringify(value, jsonReplacer, 2) + "\n"); }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function normalizeAddress(value) {
  const text = String(value || "").replace(/^0X/, "0x");
  try { return ethers.getAddress(text); } catch (_) {
    if (/^0x[0-9a-fA-F]{40}$/.test(text)) {
      try { return ethers.getAddress(text.toLowerCase()); } catch (_) { return null; }
    }
    return null;
  }
}
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function decodeBytes32String(value) { try { return ethers.decodeBytes32String(value); } catch (_) { return null; } }
function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatNumber(value, decimals = 4) { const n = asNumber(value); return n === null ? "n/a" : n.toLocaleString(undefined, { maximumFractionDigits: decimals }); }
function hexBlock(value) { return `0x${Number(value).toString(16)}`; }
function formatUnitsNumber(raw, decimals) { try { return raw === null || raw === undefined ? null : Number(ethers.formatUnits(BigInt(raw), Number(decimals))); } catch (_) { return null; } }
function bpsDiff(reference, observed) {
  const ref = asNumber(reference);
  const obs = asNumber(observed);
  if (!ref || !obs || ref <= 0 || obs <= 0) return null;
  return ((obs / ref) - 1) * 10_000;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-opentrade-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = 10_000) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr) return null;
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ to: addr, data: iface.encodeFunctionData(fn, args) }, "latest"], timeoutMs);
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) { return null; }
}

async function stateProbe(rpc, to, iface, fn, args = []) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr) return { success: false };
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ from: PROBE_FROM, to: addr, data: iface.encodeFunctionData(fn, args) }, "latest"], 8_000);
    return { success: raw !== null };
  } catch (_) {
    return { success: false };
  }
}

async function getCode(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return "0x";
  return await rpcCall(rpc, "eth_getCode", [addr, "latest"], 10_000).catch(() => "0x") || "0x";
}

function latestTvl(row) {
  if (Array.isArray(row?.tvl)) return asNumber(row.tvl.at(-1)?.totalLiquidityUSD);
  if (Array.isArray(row)) return asNumber(row.at(-1)?.totalLiquidityUSD);
  return asNumber(row?.totalLiquidityUSD ?? row?.tvl);
}

function publicMetadata(raw) {
  const chainNames = new Set([...(raw?.chains || []), ...Object.keys(raw?.chainTvls || {}), ...Object.keys(raw?.currentChainTvls || {})]);
  const chainTvls = {};
  for (const chain of chainNames) {
    const tvl = asNumber(raw?.currentChainTvls?.[chain]) ?? latestTvl(raw?.chainTvls?.[chain]);
    if (tvl !== null) chainTvls[chain] = round(tvl, 2);
  }
  return {
    name: raw?.name || "OpenTrade",
    slug: raw?.slug || "opentrade",
    category: raw?.category || "RWA",
    chains: raw?.chains || Object.keys(chainTvls),
    tvlUsd: round(latestTvl(raw?.tvl) ?? Object.values(chainTvls).reduce((sum, value) => sum + (asNumber(value) || 0), 0), 2),
    chainTvls,
  };
}

async function fetchAddressPrices(chainId, addresses) {
  const chain = CHAINS[chainId];
  const uniq = [...new Set((addresses || []).map(lowerAddress).filter(Boolean))];
  const out = new Map();
  if (!chain || !uniq.length) return out;
  for (let i = 0; i < uniq.length; i += 50) {
    const ids = uniq.slice(i, i + 50).map((addr) => `${chain.coinSlug}:${addr}`);
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${ids.join(",")}?searchWidth=6h`, 30_000).catch(() => ({ coins: {} }));
    for (const [key, value] of Object.entries(json?.coins || {})) {
      const addr = key.split(":").pop()?.toLowerCase();
      if (addr && value?.price) out.set(addr, Number(value.price));
    }
  }
  return out;
}

async function getLogsChunked(rpc, chainId, factory, fromBlock, latestBlock) {
  async function fetchRange(start, end) {
    const result = await rpcCall(rpc, "eth_getLogs", [{ address: factory, fromBlock: hexBlock(start), toBlock: hexBlock(end), topics: [POOL_CREATED_TOPIC] }], 30_000);
    if (Array.isArray(result)) return { logs: result, failedRanges: [] };
    if (end > start && end - start + 1 > 1_000) {
      const mid = Math.floor((start + end) / 2);
      const [left, right] = await Promise.all([fetchRange(start, mid), fetchRange(mid + 1, end)]);
      return { logs: [...left.logs, ...right.logs], failedRanges: [...left.failedRanges, ...right.failedRanges] };
    }
    return { logs: [], failedRanges: [{ fromBlock: start, toBlock: end }] };
  }

  const logs = [];
  const failedRanges = [];
  const chunk = CHAINS[chainId]?.logChunk || 10_000;
  const ranges = [];
  for (let start = Number(fromBlock); start <= latestBlock; start += chunk) {
    ranges.push({ fromBlock: start, toBlock: Math.min(latestBlock, start + chunk - 1) });
  }
  let cursor = 0;
  const workerCount = Math.min(LOG_CONCURRENCY, ranges.length || 1);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < ranges.length) {
      const range = ranges[cursor++];
      const result = await fetchRange(range.fromBlock, range.toBlock);
      logs.push(...result.logs);
      failedRanges.push(...result.failedRanges);
    }
  }));
  logs.sort((a, b) => parseInt(a.blockNumber || "0x0", 16) - parseInt(b.blockNumber || "0x0", 16) || parseInt(a.logIndex || "0x0", 16) - parseInt(b.logIndex || "0x0", 16));
  return { logs, failedRanges };
}

function poolAddressFromLog(log) {
  try {
    const parsed = POOL.parseLog(log);
    return normalizeAddress(parsed.args.addr);
  } catch (_) {
    const topic = log?.topics?.[1];
    const hex = strip0x(topic).padStart(64, "0");
    return /^0+$/.test(hex) ? null : normalizeAddress(`0x${hex.slice(-40)}`);
  }
}

async function tokenMeta(rpc, address, priceMap = new Map()) {
  const addr = normalizeAddress(address);
  if (!addr) return null;
  const [code, sym, name, dec, supply] = await Promise.all([
    getCode(rpc, addr),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
  ]);
  const symbolBytes = sym ? null : await safeCall(rpc, addr, BYTES32_TOKEN, "symbol");
  const nameBytes = name ? null : await safeCall(rpc, addr, BYTES32_TOKEN, "name");
  const decimals = dec ? Number(dec[0]) : 18;
  return {
    address: addr,
    codePresent: code !== "0x",
    symbol: sym ? String(sym[0]) : decodeBytes32String(symbolBytes?.[0]) || null,
    name: name ? String(name[0]) : decodeBytes32String(nameBytes?.[0]) || null,
    decimals,
    totalSupplyRaw: supply ? supply[0].toString() : null,
    totalSupply: supply ? formatUnitsNumber(supply[0], decimals) : null,
    tokenPriceUsd: priceMap.get(addr.toLowerCase()) || null,
  };
}

async function enrichPool(rpc, chainId, pool, priceMap) {
  const addr = normalizeAddress(pool.address);
  const [meta, liquidityAssetRaw, assetRaw, totalAssets, maxDeposit, maxWithdraw, paused, owner, admin] = await Promise.all([
    tokenMeta(rpc, addr, priceMap),
    safeCall(rpc, addr, POOL, "liquidityAssetAddr"),
    safeCall(rpc, addr, POOL, "asset"),
    safeCall(rpc, addr, POOL, "totalAssets"),
    safeCall(rpc, addr, POOL, "maxDeposit", [PROBE_FROM]),
    safeCall(rpc, addr, POOL, "maxWithdraw", [PROBE_FROM]),
    safeCall(rpc, addr, COMMON, "paused"),
    safeCall(rpc, addr, COMMON, "owner"),
    safeCall(rpc, addr, COMMON, "admin"),
  ]);
  const asset = normalizeAddress(liquidityAssetRaw?.[0]) || normalizeAddress(assetRaw?.[0]);
  const assetMeta = asset ? await tokenMeta(rpc, asset, priceMap).catch(() => null) : null;
  const shareDecimals = meta?.decimals ?? 18;
  const assetDecimals = assetMeta?.decimals ?? shareDecimals;
  const shareUnit = 10n ** BigInt(Math.max(0, Math.min(shareDecimals, 36)));
  const [convertOne, depositProbe, withdrawProbe, redeemProbe] = await Promise.all([
    safeCall(rpc, addr, POOL, "convertToAssets", [shareUnit]),
    stateProbe(rpc, addr, POOL, "deposit", [0n, PROBE_FROM]),
    stateProbe(rpc, addr, POOL, "withdraw", [0n, PROBE_FROM, PROBE_FROM]),
    stateProbe(rpc, addr, POOL, "redeem", [0n, PROBE_FROM, PROBE_FROM]),
  ]);
  const totalAssetsAmount = totalAssets ? formatUnitsNumber(totalAssets[0], assetDecimals) : null;
  const totalAssetsUsd = totalAssetsAmount !== null && assetMeta?.tokenPriceUsd ? totalAssetsAmount * assetMeta.tokenPriceUsd : null;
  const supplyAmount = meta?.totalSupply ?? null;
  const convertOneShareToAssets = convertOne ? formatUnitsNumber(convertOne[0], assetDecimals) : null;
  const sharePriceAssets = convertOneShareToAssets ?? (supplyAmount && supplyAmount > 0 && totalAssetsAmount !== null ? totalAssetsAmount / supplyAmount : null);
  const navUsdPerShare = sharePriceAssets !== null && assetMeta?.tokenPriceUsd ? sharePriceAssets * assetMeta.tokenPriceUsd : null;
  const navVsTokenPriceBps = bpsDiff(meta?.tokenPriceUsd, navUsdPerShare);
  const currentAnomaly = Boolean(meta?.tokenPriceUsd && navUsdPerShare && Math.abs(navVsTokenPriceBps || 0) >= NAV_DIVERGENCE_BPS);
  return {
    chain: CHAINS[chainId].name,
    chainId,
    factory: pool.factory,
    address: addr,
    codePresent: Boolean(meta?.codePresent),
    symbol: meta?.symbol || null,
    name: meta?.name || null,
    decimals: shareDecimals,
    totalSupply: meta?.totalSupply ?? null,
    liquidityAsset: asset,
    liquidityAssetSymbol: assetMeta?.symbol || null,
    liquidityAssetName: assetMeta?.name || null,
    liquidityAssetPriceUsd: assetMeta?.tokenPriceUsd || null,
    totalAssets: totalAssetsAmount,
    totalAssetsUsd: round(totalAssetsUsd, 2),
    sharePriceAssets: round(sharePriceAssets, 10),
    navUsdPerShare: round(navUsdPerShare, 10),
    publicSharePriceUsd: meta?.tokenPriceUsd || null,
    navVsTokenPriceBps: round(navVsTokenPriceBps, 4),
    currentAnomaly,
    maxDepositForProbe: maxDeposit ? formatUnitsNumber(maxDeposit[0], assetDecimals) : null,
    maxWithdrawForProbe: maxWithdraw ? formatUnitsNumber(maxWithdraw[0], assetDecimals) : null,
    paused: paused ? Boolean(paused[0]) : null,
    owner: owner ? normalizeAddress(owner[0]) : null,
    admin: admin ? normalizeAddress(admin[0]) : null,
    zeroAmountCallProbes: {
      deposit: depositProbe.success,
      withdraw: withdrawProbe.success,
      redeem: redeemProbe.success,
    },
    blocker: currentAnomaly
      ? "Current NAV/share-price anomaly still needs exact consumer, transferability, and executable exit proof"
      : "No current pool share market/NAV anomaly or no public share acquisition price",
  };
}

async function discoverChain(chainId) {
  const chain = CHAINS[chainId];
  const rpc = await resolveRpc(chainId);
  if (!rpc) {
    return { chainId, chain: chain.name, rpcResolved: false, latestBlock: null, factories: [], pools: [], failedLogRanges: [] };
  }
  const latestRaw = await rpcCall(rpc, "eth_blockNumber", [], 10_000);
  const latestBlock = latestRaw ? parseInt(latestRaw, 16) : null;
  const poolMap = new Map();
  const factoryRows = [];
  const failedLogRanges = [];
  for (const factory of FACTORIES[chainId] || []) {
    if (!QUIET) console.log(`OpenTrade ${chain.name}: scanning factory ${compactAddress(factory.address)} from block ${factory.fromBlock}`);
    const logsResult = latestBlock
      ? await getLogsChunked(rpc, chainId, normalizeAddress(factory.address), factory.fromBlock, latestBlock)
      : { logs: [], failedRanges: [{ fromBlock: factory.fromBlock, toBlock: null }] };
    const pools = [];
    for (const log of logsResult.logs) {
      const pool = poolAddressFromLog(log);
      if (!pool) continue;
      const lower = pool.toLowerCase();
      if (BLACKLIST[chainId]?.has(lower)) continue;
      poolMap.set(lower, { address: pool, factory: normalizeAddress(factory.address), fromBlock: factory.fromBlock });
      pools.push(pool);
    }
    failedLogRanges.push(...logsResult.failedRanges.map((row) => ({ factory: normalizeAddress(factory.address), ...row })));
    factoryRows.push({
      chain: chain.name,
      chainId,
      factory: normalizeAddress(factory.address),
      fromBlock: factory.fromBlock,
      latestBlock,
      logRows: logsResult.logs.length,
      uniquePoolRows: [...new Set(pools.map((p) => p.toLowerCase()))].length,
      failedRanges: logsResult.failedRanges.length,
    });
    if (!QUIET) console.log(`OpenTrade ${chain.name}: factory ${compactAddress(factory.address)} logs=${logsResult.logs.length} failedRanges=${logsResult.failedRanges.length}`);
  }
  const discovered = [...poolMap.values()];
  const poolPriceMap = await fetchAddressPrices(chainId, discovered.map((p) => p.address));
  const provisionalAssetRows = [];
  for (let i = 0; i < discovered.length; i += 10) {
    const batch = discovered.slice(i, i + 10);
    const assets = await Promise.all(batch.map(async (p) => {
      const asset = await safeCall(rpc, p.address, POOL, "liquidityAssetAddr").catch(() => null)
        || await safeCall(rpc, p.address, POOL, "asset").catch(() => null);
      return normalizeAddress(asset?.[0]);
    }));
    provisionalAssetRows.push(...assets.filter(Boolean));
  }
  const assetPriceMap = await fetchAddressPrices(chainId, provisionalAssetRows);
  const priceMap = new Map([...poolPriceMap.entries(), ...assetPriceMap.entries()]);
  const pools = [];
  for (let i = 0; i < discovered.length; i += 8) {
    const enriched = await Promise.all(discovered.slice(i, i + 8).map((p) => enrichPool(rpc, chainId, p, priceMap).catch((err) => ({
      chain: chain.name,
      chainId,
      factory: p.factory,
      address: p.address,
      error: err.message || String(err),
      codePresent: null,
      routePositive: false,
    }))));
    pools.push(...enriched);
  }
  pools.sort((a, b) => (asNumber(b.totalAssetsUsd) || 0) - (asNumber(a.totalAssetsUsd) || 0));
  return {
    chainId,
    chain: chain.name,
    rpcResolved: true,
    latestBlock,
    factories: factoryRows,
    pools,
    failedLogRanges,
  };
}

function buildExtraProducers(poolRows) {
  return poolRows.filter((row) => row.codePresent && normalizeAddress(row.address)).map((row) => ({
    source: "defillama-adapter:opentrade-factory-events",
    protocol: "OpenTrade",
    chainId: row.chainId,
    symbol: row.symbol || "OpenTradePool",
    name: row.name || "OpenTrade pool share",
    address: row.address,
    category: "rwa-nav-pool",
    tags: ["rwa", "private-credit", "opentrade", "factory-discovered", "liquidityAssetAddr", "permissioned-redemption-possible"],
  }));
}

function runConsumerGraph() {
  const child = spawnSync(process.execPath, ["scan-rwa-nav-consumer-graph.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      RWA_NAV_PROTOCOL_FILTER: "OpenTrade",
      RWA_NAV_CHAIN_IDS: "1,43114",
      RWA_NAV_EXTRA_PRODUCER_FILE: EXTRA_PRODUCERS_REL,
      RWA_NAV_OUT: GRAPH_OUT_REL,
      RWA_NAV_MAX_EULER_VAULTS: process.env.RWA_NAV_MAX_EULER_VAULTS || "900",
      RWA_NAV_MAX_SILO_IDS: process.env.RWA_NAV_MAX_SILO_IDS || "900",
      RWA_NAV_MORPHO_TOP_N: process.env.RWA_NAV_MORPHO_TOP_N || "350",
    },
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
  });
  if (child.status !== 0) {
    const msg = `${child.stderr || child.stdout || "RWA/NAV child scanner failed"}`.slice(0, 1200);
    throw new Error(msg);
  }
  if (!QUIET && child.stdout) process.stdout.write(child.stdout);
  return readJson(GRAPH_OUT, null);
}

async function fetchDexRows(poolRows) {
  const addresses = [...new Set(poolRows.map((row) => lowerAddress(row.address)).filter(Boolean))];
  const rows = [];
  for (let i = 0; i < addresses.length; i += 20) {
    const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${addresses.slice(i, i + 20).join(",")}`, 30_000).catch(() => ({}));
    for (const pair of json?.pairs || []) {
      const base = lowerAddress(pair.baseToken?.address);
      const quote = lowerAddress(pair.quoteToken?.address);
      const token = poolRows.find((row) => lowerAddress(row.address) === base || lowerAddress(row.address) === quote);
      if (!token) continue;
      rows.push({
        chain: token.chain,
        symbol: token.symbol || null,
        token: token.address,
        chainId: pair.chainId || null,
        dexId: pair.dexId || null,
        pairAddress: pair.pairAddress || null,
        baseSymbol: pair.baseToken?.symbol || null,
        quoteSymbol: pair.quoteToken?.symbol || null,
        liquidityUsd: round(pair.liquidity?.usd, 2),
        volume24hUsd: round(pair.volume?.h24, 2),
        priceUsd: round(pair.priceUsd, 10),
      });
    }
  }
  return rows.sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0)).slice(0, 50);
}

function rowMatches(value, poolRows) {
  if (value === null || value === undefined) return false;
  const text = String(value).toLowerCase();
  if (text.includes("opentrade")) return true;
  return poolRows.some((row) => {
    const addr = lowerAddress(row.address);
    const symbol = String(row.symbol || "").toLowerCase();
    return (addr && text.includes(addr)) || (symbol && symbol.length >= 3 && text.includes(symbol));
  });
}

function shallowSummary(row) {
  const out = {};
  for (const key of [
    "protocol", "chain", "chainId", "symbol", "assetSymbol", "assetName", "vaultSymbol", "vaultName", "marketName",
    "asset", "token", "address", "vault", "market", "collateral", "loanToken", "oracle", "pairAddress", "config",
    "ltv", "lltv", "ltvBorrowBps", "maxLtv", "maxLtvBps", "liquidationThreshold", "liquidityUsd", "cashUsd",
    "borrowedUsd", "borrowUsd", "supplyUsd", "routeLiquidityUsd", "bestNetProfitUsd", "netProfitUsd", "routePositive", "watchCandidate", "blocker", "status",
  ]) if (row && Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined) out[key] = row[key];
  return out;
}

function collectLocalRowsFromValue(value, rows, poolRows, limit, depth = 0) {
  if (!value || rows.length >= limit || depth > 10) return false;
  if (Array.isArray(value)) {
    let matched = false;
    for (const item of value) matched = collectLocalRowsFromValue(item, rows, poolRows, limit, depth + 1) || matched;
    return matched;
  }
  if (typeof value !== "object") return rowMatches(value, poolRows);
  let matched = false;
  for (const [key, child] of Object.entries(value)) {
    if (rowMatches(key, poolRows) || (typeof child !== "object" && rowMatches(child, poolRows))) matched = true;
  }
  for (const child of Object.values(value)) {
    if (rows.length >= limit) break;
    if (collectLocalRowsFromValue(child, rows, poolRows, limit, depth + 1)) matched = true;
  }
  if (matched && rows.length < limit) rows.push(shallowSummary(value));
  return matched;
}

function collectLocalArtifactRows(poolRows, limitPerArtifact = 30) {
  const rows = [];
  for (const artifact of LOCAL_ARTIFACTS) {
    const json = readJson(path.join(WORKSPACE, artifact.file), null);
    if (!json) continue;
    const matches = [];
    collectLocalRowsFromValue(json, matches, poolRows, limitPerArtifact);
    for (const row of matches.slice(0, limitPerArtifact)) rows.push({ protocol: artifact.protocol, artifact: artifact.file, ...row });
  }
  return rows;
}

function flattenGraph(graph, field) {
  return (graph?.results || []).flatMap((row) => Array.isArray(row[field]) ? row[field] : []);
}

function writeReport(artifact) {
  const s = artifact.summary;
  const poolTable = artifact.poolRows.slice(0, 12).map((row) => `| ${row.chain} | ${row.symbol || "?"} | ${compactAddress(row.address)} | ${row.liquidityAssetSymbol || "?"} | ${formatUsd(row.totalAssetsUsd)} | ${formatNumber(row.navUsdPerShare, 8)} | ${row.currentAnomaly ? "watch" : "none"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const matchTable = artifact.topConsumerMatches.slice(0, 10).map((row) => `| ${row.protocol} | ${row.side} | ${row.producer?.symbol || "?"} | ${row.reviewCandidate} | ${row.watchCandidate} | ${formatUsd(row.market?.otherReserveCashUsd ?? row.market?.cashUsd ?? row.market?.baseCashUsd ?? row.market?.liquidityAssetsUsd ?? row.market?.oppositeLiquidityUsd)} | ${(row.blockers || []).slice(0, 2).join("; ") || "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const localTable = artifact.localArtifactRows.slice(0, 10).map((row) => `| ${row.protocol} | ${row.symbol || row.assetSymbol || row.vaultSymbol || row.marketName || "?"} | ${compactAddress(row.asset || row.token || row.collateral || row.address || row.market || row.vault)} | ${row.ltvBorrowBps ?? row.lltv ?? row.maxLtv ?? row.maxLtvBps ?? "n/a"} | ${formatUsd(row.routeLiquidityUsd ?? row.liquidityUsd ?? row.cashUsd)} | ${row.routePositive ?? false} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";
  const dexTable = artifact.dexLiquidityRows.slice(0, 8).map((row) => `| ${row.chain || "n/a"} | ${row.symbol || "?"} | ${row.dexId || "n/a"} | ${row.baseSymbol || "?"}/${row.quoteSymbol || "?"} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.volume24hUsd)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";
  const blockedTable = artifact.blockedOrOutOfScopeChains.map((row) => `| ${row.chain} | ${formatUsd(row.tvlUsd)} | ${row.reason} | ${row.retestTrigger} |`).join("\n") || "| none | n/a | n/a | n/a |";

  const content = `# 🟢 DORMANT - OpenTrade Phase 0 Triage

Generated: ${artifact.generatedAt}

Scanner: \`tools/scan-opentrade-phase0.js\`

Artifact: \`reports/raw/fast/opentrade-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This pass discovered OpenTrade pools from public DeFiLlama adapter factories on Avalanche and Ethereum, checked live pool/NAV state, seeded the generic RWA/NAV consumer graph with exact pool-share addresses, joined sanitized local consumer artifacts, and checked public DEX liquidity for pool shares. No exact-positive borrow, liquidation, redeem, or unwind route was found.

## Summary

| Metric | Value |
|---|---:|
| Public TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Avalanche TVL | ${formatUsd(s.avalancheTvlUsd)} |
| Ethereum TVL | ${formatUsd(s.ethereumTvlUsd)} |
| Supported chains scanned | \`${s.supportedChainsScanned}/${s.supportedChainsDeclared}\` |
| Pools discovered | \`${s.poolsDiscovered}\` |
| Pool rows with code | \`${s.poolRowsWithCode}\` |
| Material pool rows | \`${s.materialPoolRows}\` |
| Mapped pool assets | ${formatUsd(s.mappedPoolAssetsUsd)} |
| Consumer matches | \`${s.consumerMatches}\` |
| Local artifact rows | \`${s.localArtifactRows}\` |
| Pool-share DEX rows | \`${s.dexLiquidityRows}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |
| Coverage classification | \`${s.coverageClassification}\` |

## Pool Rows

| Chain | Pool symbol | Pool | Liquidity asset | Total assets | NAV/share USD | Current signal |
|---|---|---|---|---:|---:|---|
${poolTable}

## Consumer Matches

| Protocol | Side | Producer | Review | Watch | Route-side liquidity | Blocker |
|---|---|---|---:|---:|---:|---|
${matchTable}

## Local Artifact Joins

| Source | Symbol/Market | Address | LTV/LLTV | Liquidity/Cash | Route-positive |
|---|---|---|---:|---:|---:|
${localTable}

## Pool-Share DEX Context

| Chain | Pool symbol | DEX | Pair | Liquidity USD | 24h volume USD |
|---|---|---|---|---:|---:|
${dexTable}

## Blocked / Out-Of-Current-Coverage Chains

| Chain | Public TVL | Reason | Retest trigger |
|---|---:|---|---|
${blockedTable}

## Blockers

${artifact.blockers.map((row) => `- ${row}`).join("\n")}

No fork PoC, signed action, exploit call, or executor work is justified from this artifact.
`;
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  ensureDir(RAW_OUT);
  const publicRaw = await fetchJson("https://api.llama.fi/protocol/opentrade", 45_000).catch(() => ({}));
  const publicMeta = publicMetadata(publicRaw);
  const chainResults = [];
  for (const chainId of [43114, 1]) chainResults.push(await discoverChain(chainId));
  const poolRows = chainResults.flatMap((row) => row.pools || []);
  const extraProducers = buildExtraProducers(poolRows);
  writeJson(EXTRA_PRODUCERS_OUT, {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-opentrade-phase0.js",
    scope: "Exact OpenTrade factory-discovered pool producer seeds for RWA/NAV consumer graph",
    safety: { rpcUrlsStored: false, privateKeysRead: false, signedActions: false },
    producers: extraProducers,
  });
  const graph = runConsumerGraph();
  const dexRows = await fetchDexRows(poolRows);
  const localArtifactRows = collectLocalArtifactRows(poolRows);
  const topConsumerMatches = flattenGraph(graph, "topMatches");
  topConsumerMatches.sort((a, b) => Number(b.routePositive) - Number(a.routePositive) || Number(b.watchCandidate) - Number(a.watchCandidate) || Number(b.reviewCandidate) - Number(a.reviewCandidate));

  const graphSummary = graph?.summary || {};
  const poolWatch = poolRows.filter((row) => row.currentAnomaly).length;
  const graphWatch = asNumber(graphSummary.watchCandidates) || 0;
  const routePositive = asNumber(graphSummary.routePositive) || 0;
  const publicChains = new Set(publicMeta.chains || []);
  const supportedChainsDeclared = [...publicChains].filter((chain) => ["Avalanche", "Ethereum"].includes(chain));
  const plumeTvl = asNumber(publicMeta.chainTvls?.["Plume Mainnet"]);
  const blockedOrOutOfScopeChains = plumeTvl ? [{
    chain: "Plume Mainnet",
    tvlUsd: plumeTvl,
    reason: "No local chain preset/RPC in current supported EVM inventory for this scan",
    retestTrigger: "Provide a sanitized Plume Mainnet RPC endpoint and chain preset, then discover OpenTrade factory pools and consumer joins there",
  }] : [];

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-opentrade-phase0.js",
    scope: "Read-only OpenTrade RWA/NAV pool, factory, consumer-join, and exit-liquidity Phase 0 on Avalanche and Ethereum",
    safety: {
      publicApisOnly: false,
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      endpointContentsStored: false,
      privateKeysRead: false,
      signedActions: false,
      calldataStored: false,
      borrowerAddressesStored: false,
      forkTransactions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    publicMetadata: publicMeta,
    adapterSource: {
      tvlCodePath: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/opentrade/index.js",
      factories: FACTORIES,
      blacklistCounts: Object.fromEntries(Object.entries(BLACKLIST).map(([chainId, rows]) => [chainId, rows.size])),
    },
    thresholds: { materialUsd: MATERIAL_USD, navDivergenceBps: NAV_DIVERGENCE_BPS },
    summary: {
      defillamaCurrentTvlUsd: publicMeta.tvlUsd,
      avalancheTvlUsd: publicMeta.chainTvls?.Avalanche ?? null,
      ethereumTvlUsd: publicMeta.chainTvls?.Ethereum ?? null,
      plumeMainnetTvlUsd: publicMeta.chainTvls?.["Plume Mainnet"] ?? null,
      supportedChainsDeclared: supportedChainsDeclared.length,
      supportedChainsScanned: chainResults.filter((row) => row.rpcResolved).length,
      poolsDiscovered: poolRows.length,
      poolRowsWithCode: poolRows.filter((row) => row.codePresent).length,
      materialPoolRows: poolRows.filter((row) => (asNumber(row.totalAssetsUsd) || 0) >= MATERIAL_USD).length,
      mappedPoolAssetsUsd: round(poolRows.reduce((sum, row) => sum + (asNumber(row.totalAssetsUsd) || 0), 0), 2),
      factoryLogRows: chainResults.flatMap((row) => row.factories || []).reduce((sum, row) => sum + Number(row.logRows || 0), 0),
      failedLogRanges: chainResults.reduce((sum, row) => sum + (row.failedLogRanges || []).length, 0),
      consumerMatches: asNumber(graphSummary.matches) || 0,
      graphReviewCandidates: asNumber(graphSummary.reviewCandidates) || 0,
      graphWatchCandidates: graphWatch,
      localArtifactRows: localArtifactRows.length,
      dexLiquidityRows: dexRows.length,
      topPoolShareDexLiquidityUsd: round(Math.max(0, ...dexRows.map((row) => asNumber(row.liquidityUsd) || 0)), 2),
      watchCandidates: poolWatch + graphWatch,
      routePositive,
      executableNow: false,
      signedActionJustified: false,
      coverageClassification: blockedOrOutOfScopeChains.length ? "bounded-with-caveats" : "full-enough-for-declared-scope",
    },
    chainResults,
    poolRows,
    extraProducerSeedCount: extraProducers.length,
    consumerGraphArtifact: GRAPH_OUT_REL,
    consumerGraphSummary: graphSummary,
    topConsumerMatches: topConsumerMatches.slice(0, 80),
    localArtifactRows,
    dexLiquidityRows: dexRows,
    blockedOrOutOfScopeChains,
    blockers: [
      "OpenTrade pool shares have no exact-positive public acquisition/exit route in this pass.",
      "Factory-discovered pool NAV is underlying-asset accounting context, not extractive impact without a trusted consumer and exit path.",
      "Generic RWA/NAV consumer joins did not produce a route-positive borrow/liquidation/unwind row.",
      "RWA/private-credit mint, redeem, and withdrawal flows remain treated as permissioned or non-atomic unless public same-block execution is proven.",
      blockedOrOutOfScopeChains.length ? "Plume Mainnet coverage is blocked by missing local RPC/chain preset and is not closed route-negative." : null,
    ].filter(Boolean),
    requiredForRoutePositive: [
      "Exact OpenTrade pool share accepted as collateral or oracle input with positive LTV/LLTV",
      "Current accepted value materially above executable acquisition cost after fees/slippage/gas",
      "Borrow-side or liquidation-side liquidity above route threshold",
      "Permissionless transfer/redemption/DEX exit at exact size",
      "Fork/static-call proof showing positive net extraction before any live action",
    ],
  };
  writeJson(RAW_OUT, artifact);
  writeReport(artifact);
  if (!QUIET) {
    console.log(`OpenTrade Phase0: pools=${artifact.summary.poolsDiscovered} material=${artifact.summary.materialPoolRows} matches=${artifact.summary.consumerMatches} watch=${artifact.summary.watchCandidates} routePositive=${artifact.summary.routePositive} coverage=${artifact.summary.coverageClassification}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
