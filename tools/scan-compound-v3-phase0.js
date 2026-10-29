#!/usr/bin/env node
// scan-compound-v3-phase0.js - read-only Phase 0 for Compound V3 Comet live state.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, execution calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const DEPLOYMENTS = path.join(WORKSPACE, "targets", "compound-comet", "deployments");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "compound-v3-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "compound-v3-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";
const WAD = 10n ** 18n;
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const RECENT_LOG_BLOCKS = Number(process.env.COMPOUND_V3_RECENT_LOG_BLOCKS || "0");
const LOG_CHUNK_BLOCKS = Number(process.env.COMPOUND_V3_LOG_CHUNK_BLOCKS || "10000");
const MAX_ACCOUNTS_PER_MARKET = Number(process.env.COMPOUND_V3_MAX_ACCOUNTS_PER_MARKET || "40");
const MAX_LOGS_PER_MARKET = Number(process.env.COMPOUND_V3_MAX_LOGS_PER_MARKET || "2500");
const BORROWER_DEBT_USD_MIN = Number(process.env.COMPOUND_V3_BORROWER_DEBT_USD_MIN || "1000");
const HIGH_CF_BPS = Number(process.env.COMPOUND_V3_HIGH_CF_BPS || "8500");
const MATERIAL_USD = Number(process.env.COMPOUND_V3_MATERIAL_USD || "10000");
const STALE_FEED_SECONDS = Number(process.env.COMPOUND_V3_STALE_FEED_SECONDS || "86400");
const DIVERGENCE_WATCH_BPS = Number(process.env.COMPOUND_V3_DIVERGENCE_WATCH_BPS || "300");

const CHAINS = {
  mainnet: { chainId: 1, chain: "Ethereum", coinSlug: "ethereum" },
  base: { chainId: 8453, chain: "Base", coinSlug: "base" },
  arbitrum: { chainId: 42161, chain: "Arbitrum", coinSlug: "arbitrum" },
  optimism: { chainId: 10, chain: "Optimism", coinSlug: "optimism" },
  polygon: { chainId: 137, chain: "Polygon", coinSlug: "polygon" },
  unichain: { chainId: 130, chain: "Unichain", coinSlug: "unichain" },
  scroll: { chainId: 534352, chain: "Scroll", coinSlug: "scroll" },
  linea: { chainId: 59144, chain: "Linea", coinSlug: "linea" },
  mantle: { chainId: 5000, chain: "Mantle", coinSlug: "mantle" },
};

const PUBLIC_UNSUPPORTED_CHAINS = [
  { chain: "Ronin", reason: "not in current local RPC preset/inventory for this scanner" },
];

const COMET = new ethers.Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function numAssets() view returns (uint8)",
  "function getAssetInfo(uint8) view returns (tuple(uint8 offset,address asset,address priceFeed,uint64 scale,uint64 borrowCollateralFactor,uint64 liquidateCollateralFactor,uint64 liquidationFactor,uint128 supplyCap))",
  "function getPrice(address) view returns (uint256)",
  "function getCollateralReserves(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function totalBorrow() view returns (uint256)",
  "function getReserves() view returns (int256)",
  "function targetReserves() view returns (uint256)",
  "function baseScale() view returns (uint64)",
  "function baseToken() view returns (address)",
  "function baseTokenPriceFeed() view returns (address)",
  "function storeFrontPriceFactor() view returns (uint64)",
  "function isSupplyPaused() view returns (bool)",
  "function isTransferPaused() view returns (bool)",
  "function isWithdrawPaused() view returns (bool)",
  "function isAbsorbPaused() view returns (bool)",
  "function isBuyPaused() view returns (bool)",
  "function borrowBalanceOf(address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function isBorrowCollateralized(address) view returns (bool)",
  "function isLiquidatable(address) view returns (bool)",
  "function collateralBalanceOf(address,address) view returns (uint128)",
  "function userBasic(address) view returns (tuple(int104 principal,uint64 baseTrackingIndex,uint64 baseTrackingAccrued,uint16 assetsIn,uint8 _reserved))",
]);
const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);
const FEED = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function safeText(value, max = 160) { return String(value || "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatNumber(value, decimals = 2) { const n = asNumber(value); return n === null ? "n/a" : n.toLocaleString(undefined, { maximumFractionDigits: decimals }); }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function bnAbs(value) { const v = toBig(value); return v < 0n ? -v : v; }
function factorBps(value) { return Number((toBig(value) * 10000n) / WAD); }
function unitsToNumber(value, decimals = 18) { try { return Number(ethers.formatUnits(toBig(value), decimals)); } catch (_) { return null; } }
function signedUnitsToNumber(value, decimals = 18) { try { const v = toBig(value); return v < 0n ? -Number(ethers.formatUnits(-v, decimals)) : Number(ethers.formatUnits(v, decimals)); } catch (_) { return null; } }
function stableUsdGuess(symbol) { return /^(USDC|USDT|USDS|USDBC|USDE|DAI|USD\+?|USDA)$/i.test(String(symbol || "")) ? 1 : null; }
function slotAddress(raw) { const addr = raw && raw !== "0x" && raw.length >= 66 ? normalizeAddress(`0x${raw.slice(26)}`) : null; return addr && addr !== ZERO ? addr : null; }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-compound-v3-phase0/1.0" } });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { ok: res.ok, status: res.status, json, error: res.ok ? null : safeText(text || `HTTP ${res.status}`, 120) };
  } catch (err) { return { ok: false, status: null, json: null, error: safeText(err?.name || err?.message || "transport-error", 80) }; }
  finally { clearTimeout(timer); }
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

async function getSlotAddress(rpc, address, slot) {
  const raw = await rpcCall(rpc, "eth_getStorageAt", [address, slot, "latest"], 10_000).catch(() => null);
  return slotAddress(raw);
}

async function latestBlock(rpc) {
  const num = await rpcCall(rpc, "eth_blockNumber", [], 8_000).catch(() => null);
  const block = num ? await rpcCall(rpc, "eth_getBlockByNumber", [num, false], 8_000).catch(() => null) : null;
  return { number: num ? Number(BigInt(num)) : null, timestamp: block?.timestamp ? Number(BigInt(block.timestamp)) : null };
}

async function tokenMeta(rpc, address, fallbackSymbol = null) {
  const addr = normalizeAddress(address);
  const [decimals, symbol, name, code] = await Promise.all([
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    getCode(rpc, addr),
  ]);
  return {
    address: addr,
    symbol: safeText(symbol?.[0], 40) || fallbackSymbol,
    name: safeText(name?.[0], 80),
    decimals: decimals?.[0] === undefined ? null : Number(decimals[0]),
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
  };
}

async function feedMeta(rpc, address, blockTimestamp) {
  const addr = normalizeAddress(address);
  const [decimals, description, round, code] = await Promise.all([
    safeCall(rpc, addr, FEED, "decimals"),
    safeCall(rpc, addr, FEED, "description"),
    safeCall(rpc, addr, FEED, "latestRoundData"),
    getCode(rpc, addr),
  ]);
  const updatedAt = round?.[3] === undefined ? null : Number(round[3]);
  return {
    priceFeed: addr,
    description: safeText(description?.[0], 120),
    decimals: decimals?.[0] === undefined ? null : Number(decimals[0]),
    answerRaw: round?.[1]?.toString?.() || null,
    updatedAt,
    ageSeconds: updatedAt && blockTimestamp ? Math.max(0, blockTimestamp - updatedAt) : null,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
  };
}

function protocolMetadata() {
  const d = readJson(PUBLIC_TARGETS, {});
  const rows = [...(d.phase0Queue || []), ...(d.protocolCandidates || []), ...(d.consumerJoinFirst || [])];
  const row = rows.find((p) => p?.slug === "compound-v3" || p?.name === "Compound V3");
  return row ? { name: row.name, slug: row.slug, category: row.category, chains: row.chains || [], evmChains: row.evmChains || [], tvlUsd: row.tvlUsd, change1dPct: row.change1dPct, change7dPct: row.change7dPct, routePriority: row.routePriority || null, source: "public-audit-target-discovery" } : { name: "Compound V3", slug: "compound-v3", category: "Lending", tvlUsd: null };
}

function loadTargets() {
  const out = [];
  if (!fs.existsSync(DEPLOYMENTS)) return out;
  for (const folder of Object.keys(CHAINS)) {
    const chainDir = path.join(DEPLOYMENTS, folder);
    if (!fs.existsSync(chainDir)) continue;
    for (const market of fs.readdirSync(chainDir).sort()) {
      const rootPath = path.join(chainDir, market, "roots.json");
      const configPath = path.join(chainDir, market, "configuration.json");
      const roots = readJson(rootPath, null);
      const config = readJson(configPath, null);
      const comet = normalizeAddress(roots?.comet);
      if (!comet || !config) continue;
      out.push({ ...CHAINS[folder], folder, market, comet, configurator: normalizeAddress(roots?.configurator), rewards: normalizeAddress(roots?.rewards), bulker: normalizeAddress(roots?.bulker), configPath: path.relative(WORKSPACE, configPath).replace(/\\/g, "/"), rootsPath: path.relative(WORKSPACE, rootPath).replace(/\\/g, "/"), config });
    }
  }
  return out;
}

async function fetchPrices(targets, tokenRows) {
  const keys = [];
  for (const row of tokenRows) {
    const chain = targets.find((t) => t.chainId === row.chainId);
    if (chain?.coinSlug && row.address) keys.push(`${chain.coinSlug}:${row.address.toLowerCase()}`);
  }
  const uniq = unique(keys);
  if (!uniq.length) return { prices: new Map(), fetched: { ok: false, status: null, count: 0, error: "no-token-keys" } };
  const fetched = await fetchJson(`https://coins.llama.fi/prices/current/${uniq.join(",")}?searchWidth=6h`, 30_000);
  const prices = new Map();
  for (const [key, row] of Object.entries(fetched.json?.coins || {})) {
    const price = Number(row?.price || 0);
    if (price > 0) prices.set(key.toLowerCase(), price);
  }
  return { prices, fetched: { ok: fetched.ok, status: fetched.status, count: prices.size, error: fetched.error } };
}

function priceKey(row) { return `${row.coinSlug}:${String(row.address || row.token || "").toLowerCase()}`; }
function priceFor(prices, chain, tokenMetaRow) { return prices.get(`${chain.coinSlug}:${tokenMetaRow.address.toLowerCase()}`) || stableUsdGuess(tokenMetaRow.symbol); }

function estimateBaseRaw(amountRaw, asset, basePriceRaw, baseScale) {
  const amount = toBig(amountRaw);
  const price = toBig(asset.cometPriceRaw);
  const scale = toBig(asset.scaleRaw);
  const basePrice = toBig(basePriceRaw);
  const bScale = toBig(baseScale);
  if (amount <= 0n || price <= 0n || scale <= 0n || basePrice <= 0n || bScale <= 0n) return 0n;
  return (amount * price * bScale) / scale / basePrice;
}

function buyDiscountBps(storeFrontPriceFactorRaw, liquidationFactorRaw) {
  const store = toBig(storeFrontPriceFactorRaw);
  const liq = toBig(liquidationFactorRaw);
  if (store <= 0n || liq <= 0n || liq >= WAD) return 0;
  return Number((store * (WAD - liq) * 10000n) / WAD / WAD);
}

function classifyFeed(description) {
  const d = String(description || "").toLowerCase();
  const tags = [];
  if (/4626|vault|susd|sfrx|wusdm|sdeusd|deusd|susde/.test(d)) tags.push("erc4626-or-vault-like");
  if (/capo|correlated|wsteth|weeth|reth|rseth|ezeth|rsweth|exchange|rate|scaling|stethpertoken/.test(d)) tags.push("lst-lrt-rate-or-capo");
  if (/chainlink|usd|eth/.test(d)) tags.push("oracle-wrapper");
  return tags;
}

function compareConfig(target, assetRows) {
  const configAssets = Object.entries(target.config?.assets || {}).map(([symbol, row]) => ({ symbol, address: lowerAddress(row.address), borrowCFBps: Math.round(Number(row.borrowCF || 0) * 10000), liquidateCFBps: Math.round(Number(row.liquidateCF || 0) * 10000), supplyCap: String(row.supplyCap || "") }));
  const liveByAddress = new Map(assetRows.map((row) => [lowerAddress(row.asset), row]));
  const configByAddress = new Map(configAssets.filter((row) => row.address).map((row) => [row.address, row]));
  const drift = [];
  for (const live of assetRows) {
    const cfg = configByAddress.get(lowerAddress(live.asset));
    if (!cfg) { drift.push({ type: "live-asset-not-in-local-config", chain: target.chain, market: target.market, asset: live.asset, symbol: live.assetSymbol, routePositive: false }); continue; }
    const borrowDiff = Math.abs((live.borrowCFBps || 0) - (cfg.borrowCFBps || 0));
    const liqDiff = Math.abs((live.liquidateCFBps || 0) - (cfg.liquidateCFBps || 0));
    if (borrowDiff >= 50 || liqDiff >= 50) drift.push({ type: "cf-drift", chain: target.chain, market: target.market, asset: live.asset, symbol: live.assetSymbol, liveBorrowCFBps: live.borrowCFBps, configBorrowCFBps: cfg.borrowCFBps, liveLiquidateCFBps: live.liquidateCFBps, configLiquidateCFBps: cfg.liquidateCFBps, routePositive: false });
  }
  for (const cfg of configAssets) {
    if (cfg.address && !liveByAddress.get(cfg.address)) drift.push({ type: "local-config-asset-not-live", chain: target.chain, market: target.market, asset: cfg.address, symbol: cfg.symbol, routePositive: false });
  }
  return drift;
}

async function inspectMarket(rpc, target, block) {
  const code = await getCode(rpc, target.comet);
  const [impl, admin, name, symbol, baseToken, baseTokenPriceFeed, baseScale, totalSupply, totalBorrow, reserves, targetReserves, storeFrontPriceFactor, numAssets, supplyPaused, transferPaused, withdrawPaused, absorbPaused, buyPaused] = await Promise.all([
    getSlotAddress(rpc, target.comet, EIP1967_IMPL),
    getSlotAddress(rpc, target.comet, EIP1967_ADMIN),
    safeCall(rpc, target.comet, COMET, "name"),
    safeCall(rpc, target.comet, COMET, "symbol"),
    safeCall(rpc, target.comet, COMET, "baseToken"),
    safeCall(rpc, target.comet, COMET, "baseTokenPriceFeed"),
    safeCall(rpc, target.comet, COMET, "baseScale"),
    safeCall(rpc, target.comet, COMET, "totalSupply"),
    safeCall(rpc, target.comet, COMET, "totalBorrow"),
    safeCall(rpc, target.comet, COMET, "getReserves"),
    safeCall(rpc, target.comet, COMET, "targetReserves"),
    safeCall(rpc, target.comet, COMET, "storeFrontPriceFactor"),
    safeCall(rpc, target.comet, COMET, "numAssets"),
    safeCall(rpc, target.comet, COMET, "isSupplyPaused"),
    safeCall(rpc, target.comet, COMET, "isTransferPaused"),
    safeCall(rpc, target.comet, COMET, "isWithdrawPaused"),
    safeCall(rpc, target.comet, COMET, "isAbsorbPaused"),
    safeCall(rpc, target.comet, COMET, "isBuyPaused"),
  ]);
  const base = await tokenMeta(rpc, baseToken?.[0], target.config?.baseToken || null);
  const baseFeed = await feedMeta(rpc, baseTokenPriceFeed?.[0], block.timestamp);
  const baseBalance = await safeCall(rpc, base.address, ERC20, "balanceOf", [target.comet]);
  const basePriceRaw = await safeCall(rpc, target.comet, COMET, "getPrice", [baseFeed.priceFeed]);
  const market = {
    chainId: target.chainId,
    chain: target.chain,
    coinSlug: target.coinSlug,
    folder: target.folder,
    market: target.market,
    comet: target.comet,
    configurator: target.configurator,
    rewards: target.rewards,
    bulker: target.bulker,
    name: safeText(name?.[0], 80) || target.config?.name || target.market,
    symbol: safeText(symbol?.[0], 40) || target.config?.symbol || target.market,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    implementation: impl,
    proxyAdmin: admin,
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
    baseToken: base.address,
    baseSymbol: base.symbol,
    baseDecimals: base.decimals,
    baseTokenPriceFeed: baseFeed.priceFeed,
    baseFeedDescription: baseFeed.description,
    baseFeedAgeSeconds: baseFeed.ageSeconds,
    basePriceRaw: basePriceRaw?.[0]?.toString?.() || null,
    baseScaleRaw: baseScale?.[0]?.toString?.() || null,
    baseCashRaw: baseBalance?.[0]?.toString?.() || "0",
    totalSupplyRaw: totalSupply?.[0]?.toString?.() || null,
    totalBorrowRaw: totalBorrow?.[0]?.toString?.() || null,
    reservesRaw: reserves?.[0]?.toString?.() || null,
    targetReservesRaw: targetReserves?.[0]?.toString?.() || null,
    storeFrontPriceFactorRaw: storeFrontPriceFactor?.[0]?.toString?.() || null,
    numAssets: Number(numAssets?.[0] || 0),
    pauses: { supply: Boolean(supplyPaused?.[0]), transfer: Boolean(transferPaused?.[0]), withdraw: Boolean(withdrawPaused?.[0]), absorb: Boolean(absorbPaused?.[0]), buy: Boolean(buyPaused?.[0]) },
    configPath: target.configPath,
    routePositive: false,
  };
  const assetRows = [];
  for (let i = 0; i < market.numAssets; i++) {
    const decoded = await safeCall(rpc, target.comet, COMET, "getAssetInfo", [i]);
    const info = decoded?.[0];
    if (!info) continue;
    const asset = normalizeAddress(info.asset ?? info[1]);
    const priceFeed = normalizeAddress(info.priceFeed ?? info[2]);
    const token = await tokenMeta(rpc, asset);
    const [balance, collateralReserves, cometPrice, fmeta] = await Promise.all([
      safeCall(rpc, asset, ERC20, "balanceOf", [target.comet]),
      safeCall(rpc, target.comet, COMET, "getCollateralReserves", [asset]),
      safeCall(rpc, target.comet, COMET, "getPrice", [priceFeed]),
      feedMeta(rpc, priceFeed, block.timestamp),
    ]);
    const row = {
      chainId: target.chainId,
      chain: target.chain,
      market: target.market,
      comet: target.comet,
      assetIndex: i,
      asset,
      assetSymbol: token.symbol,
      assetDecimals: token.decimals,
      assetCodePresent: token.codePresent,
      priceFeed,
      feedDescription: fmeta.description,
      feedAgeSeconds: fmeta.ageSeconds,
      feedAnswerRaw: fmeta.answerRaw,
      feedTags: classifyFeed(fmeta.description),
      scaleRaw: (info.scale ?? info[3])?.toString?.() || null,
      borrowCFBps: factorBps(info.borrowCollateralFactor ?? info[4]),
      liquidateCFBps: factorBps(info.liquidateCollateralFactor ?? info[5]),
      liquidationFactorBps: factorBps(info.liquidationFactor ?? info[6]),
      liquidationFactorRaw: (info.liquidationFactor ?? info[6])?.toString?.() || null,
      supplyCapRaw: (info.supplyCap ?? info[7])?.toString?.() || null,
      cometAssetBalanceRaw: balance?.[0]?.toString?.() || "0",
      collateralReservesRaw: collateralReserves?.[0]?.toString?.() || "0",
      cometPriceRaw: cometPrice?.[0]?.toString?.() || null,
      routePositive: false,
    };
    assetRows.push(row);
  }
  return { market, base, baseFeed, assetRows, configDriftRows: compareConfig(target, assetRows) };
}

function enrichMarketRows(scanRows, prices) {
  for (const row of scanRows) {
    const baseUsd = priceFor(prices, row.market, { address: row.market.baseToken, symbol: row.market.baseSymbol }) || stableUsdGuess(row.market.baseSymbol);
    row.market.baseTokenPriceUsd = baseUsd;
    row.market.baseCash = round(unitsToNumber(row.market.baseCashRaw, row.market.baseDecimals ?? 18), 8);
    row.market.baseCashUsd = baseUsd ? round((row.market.baseCash || 0) * baseUsd, 2) : null;
    row.market.totalBorrow = round(unitsToNumber(row.market.totalBorrowRaw, row.market.baseDecimals ?? 18), 8);
    row.market.totalBorrowUsd = baseUsd ? round((row.market.totalBorrow || 0) * baseUsd, 2) : null;
    row.market.totalSupply = round(unitsToNumber(row.market.totalSupplyRaw, row.market.baseDecimals ?? 18), 8);
    row.market.totalSupplyUsd = baseUsd ? round((row.market.totalSupply || 0) * baseUsd, 2) : null;
    row.market.reserves = round(signedUnitsToNumber(row.market.reservesRaw, row.market.baseDecimals ?? 18), 8);
    row.market.targetReserves = round(unitsToNumber(row.market.targetReservesRaw, row.market.baseDecimals ?? 18), 8);
    row.market.reservesBelowTarget = toBig(row.market.reservesRaw) < toBig(row.market.targetReservesRaw);
    for (const asset of row.assetRows) {
      const assetAmount = unitsToNumber(asset.cometAssetBalanceRaw, asset.assetDecimals ?? 18) || 0;
      const reserveAmount = unitsToNumber(asset.collateralReservesRaw, asset.assetDecimals ?? 18) || 0;
      const supplyCapAmount = unitsToNumber(asset.supplyCapRaw, asset.assetDecimals ?? 18) || 0;
      const valueBaseRaw = estimateBaseRaw(asset.cometAssetBalanceRaw, asset, row.market.basePriceRaw, row.market.baseScaleRaw);
      const reserveValueBaseRaw = estimateBaseRaw(asset.collateralReservesRaw, asset, row.market.basePriceRaw, row.market.baseScaleRaw);
      const oneUnit = 10n ** BigInt(asset.assetDecimals ?? 18);
      const oneUnitBaseRaw = estimateBaseRaw(oneUnit, asset, row.market.basePriceRaw, row.market.baseScaleRaw);
      const assetUsd = priceFor(prices, row.market, { address: asset.asset, symbol: asset.assetSymbol });
      const cometAssetUsd = baseUsd ? (unitsToNumber(oneUnitBaseRaw, row.market.baseDecimals ?? 18) || 0) * baseUsd : null;
      const divergenceBps = assetUsd && cometAssetUsd ? ((cometAssetUsd - assetUsd) / assetUsd) * 10000 : null;
      const discountBps = buyDiscountBps(row.market.storeFrontPriceFactorRaw, asset.liquidationFactorRaw);
      const reserveValueBase = unitsToNumber(reserveValueBaseRaw, row.market.baseDecimals ?? 18) || 0;
      const reserveValueUsd = baseUsd ? reserveValueBase * baseUsd : null;
      asset.assetAmount = round(assetAmount, 8);
      asset.assetValueBase = round(unitsToNumber(valueBaseRaw, row.market.baseDecimals ?? 18), 8);
      asset.assetValueUsd = baseUsd ? round((asset.assetValueBase || 0) * baseUsd, 2) : null;
      asset.collateralReserveAmount = round(reserveAmount, 8);
      asset.collateralReserveValueBase = round(reserveValueBase, 8);
      asset.collateralReserveValueUsd = reserveValueUsd === null ? null : round(reserveValueUsd, 2);
      asset.supplyCapAmount = round(supplyCapAmount, 8);
      asset.externalTokenPriceUsd = assetUsd || null;
      asset.cometImpliedTokenPriceUsd = cometAssetUsd === null ? null : round(cometAssetUsd, 8);
      asset.externalDivergenceBps = divergenceBps === null ? null : round(divergenceBps, 4);
      asset.estimatedBuyDiscountBps = discountBps;
      asset.estimatedBuyDiscountUsd = reserveValueUsd === null ? null : round((reserveValueUsd * discountBps) / 10000, 2);
      asset.highCF = asset.borrowCFBps >= HIGH_CF_BPS;
      asset.materialBalance = (asset.assetValueUsd || 0) >= MATERIAL_USD;
      asset.materialBorrowCash = (row.market.baseCashUsd || 0) >= MATERIAL_USD;
      asset.staleFeedWatch = asset.highCF && asset.materialBorrowCash && (asset.feedAgeSeconds || 0) >= STALE_FEED_SECONDS;
      asset.divergenceWatch = asset.highCF && asset.materialBorrowCash && asset.externalDivergenceBps !== null && asset.externalDivergenceBps >= DIVERGENCE_WATCH_BPS;
      asset.buyOpportunityWatch = !row.market.pauses.buy && row.market.reservesBelowTarget && (asset.estimatedBuyDiscountUsd || 0) >= 100 && (asset.collateralReserveValueUsd || 0) >= 1000;
      asset.watchCandidate = Boolean(asset.staleFeedWatch || asset.divergenceWatch || asset.buyOpportunityWatch);
    }
  }
}

function parseTopicAddress(topic) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(topic || ""))) return null;
  return normalizeAddress(`0x${String(topic).slice(26)}`);
}

async function collectRecentAccounts(rpc, market, assetRows, latestNumber) {
  if (!latestNumber || RECENT_LOG_BLOCKS <= 0 || MAX_ACCOUNTS_PER_MARKET <= 0) return { accounts: [], errors: [], logsScanned: 0 };
  const exclude = new Set([market.comet, market.configurator, market.rewards, market.bulker, market.baseToken, market.baseTokenPriceFeed, ...assetRows.flatMap((row) => [row.asset, row.priceFeed])].map(lowerAddress).filter(Boolean));
  const fromBlock = Math.max(0, latestNumber - RECENT_LOG_BLOCKS);
  const accounts = new Set();
  const errors = [];
  let logsScanned = 0;
  for (let start = fromBlock; start <= latestNumber && accounts.size < MAX_ACCOUNTS_PER_MARKET && logsScanned < MAX_LOGS_PER_MARKET; start += LOG_CHUNK_BLOCKS + 1) {
    const end = Math.min(latestNumber, start + LOG_CHUNK_BLOCKS);
    const logs = await rpcCall(rpc, "eth_getLogs", [{ address: market.comet, fromBlock: hexBlock(start), toBlock: hexBlock(end) }], 18_000).catch(() => null);
    if (!Array.isArray(logs)) { errors.push({ market: market.market, chain: market.chain, fromBlock: start, toBlock: end, error: "eth_getLogs returned no usable rows" }); continue; }
    logsScanned += logs.length;
    for (const log of logs) {
      for (const topic of (log.topics || []).slice(1)) {
        const addr = parseTopicAddress(topic);
        const lower = lowerAddress(addr);
        if (!lower || lower === ZERO.toLowerCase() || exclude.has(lower)) continue;
        accounts.add(normalizeAddress(addr));
        if (accounts.size >= MAX_ACCOUNTS_PER_MARKET || logsScanned >= MAX_LOGS_PER_MARKET) break;
      }
      if (accounts.size >= MAX_ACCOUNTS_PER_MARKET || logsScanned >= MAX_LOGS_PER_MARKET) break;
    }
  }
  return { accounts: [...accounts], errors, logsScanned };
}

async function inspectBorrowers(rpc, market, assetRows, accounts) {
  const rows = [];
  for (const account of accounts || []) {
    const [borrow, supply, liquidatable, collateralized, userBasic] = await Promise.all([
      safeCall(rpc, market.comet, COMET, "borrowBalanceOf", [account]),
      safeCall(rpc, market.comet, COMET, "balanceOf", [account]),
      safeCall(rpc, market.comet, COMET, "isLiquidatable", [account]),
      safeCall(rpc, market.comet, COMET, "isBorrowCollateralized", [account]),
      safeCall(rpc, market.comet, COMET, "userBasic", [account]),
    ]);
    const borrowRaw = borrow?.[0]?.toString?.() || "0";
    const supplyRaw = supply?.[0]?.toString?.() || "0";
    const borrowAmount = unitsToNumber(borrowRaw, market.baseDecimals ?? 18) || 0;
    const borrowUsd = market.baseTokenPriceUsd ? borrowAmount * market.baseTokenPriceUsd : null;
    if ((borrowUsd || 0) < BORROWER_DEBT_USD_MIN) continue;
    let topCollateral = null;
    for (const asset of assetRows) {
      const bal = await safeCall(rpc, market.comet, COMET, "collateralBalanceOf", [account, asset.asset]);
      const raw = bal?.[0]?.toString?.() || "0";
      const valueBaseRaw = estimateBaseRaw(raw, asset, market.basePriceRaw, market.baseScaleRaw);
      const valueBase = unitsToNumber(valueBaseRaw, market.baseDecimals ?? 18) || 0;
      const valueUsd = market.baseTokenPriceUsd ? valueBase * market.baseTokenPriceUsd : null;
      if (!topCollateral || (valueUsd || 0) > (topCollateral.valueUsd || 0)) topCollateral = { asset: asset.asset, symbol: asset.assetSymbol, balanceRaw: raw, valueUsd: valueUsd === null ? null : round(valueUsd, 2) };
    }
    const principal = userBasic?.[0]?.principal ?? userBasic?.[0]?.[0] ?? null;
    rows.push({
      chainId: market.chainId,
      chain: market.chain,
      market: market.market,
      comet: market.comet,
      account,
      borrowRaw,
      borrowAmount: round(borrowAmount, 8),
      borrowUsd: borrowUsd === null ? null : round(borrowUsd, 2),
      supplyRaw,
      supplyAmount: round(unitsToNumber(supplyRaw, market.baseDecimals ?? 18) || 0, 8),
      principalRaw: principal === null ? null : principal.toString(),
      isLiquidatable: Boolean(liquidatable?.[0]),
      isBorrowCollateralized: collateralized?.[0] === undefined ? null : Boolean(collateralized[0]),
      topCollateral,
      watchCandidate: Boolean(liquidatable?.[0]),
      routePositive: false,
      blocker: liquidatable?.[0] ? "Liquidatable account still needs exact absorb/buyCollateral/exit economics and fork proof" : "Recent debt account is not currently a proven profitable liquidation route",
    });
  }
  return rows.sort((a, b) => (asNumber(b.borrowUsd) || 0) - (asNumber(a.borrowUsd) || 0));
}

function buildReport(artifact) {
  const s = artifact.summary;
  const borrowerMode = s.borrowerSamplingMode === "disabled" ? "Recent borrower log sampling was disabled for this run (`COMPOUND_V3_RECENT_LOG_BLOCKS=0`) to keep the Phase 0 pass bounded and reliable." : "A bounded recent borrower/account sample was checked from Comet logs.";
  const marketTable = artifact.marketRows.slice(0, 20).map((row) => `| ${row.chain} | ${row.market} | ${row.symbol} | ${compactAddress(row.comet)} | ${row.numAssets} | ${formatUsd(row.baseCashUsd)} | ${formatUsd(row.totalBorrowUsd)} | ${row.pauses && Object.entries(row.pauses).filter(([, v]) => v).map(([k]) => k).join(",") || "none"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const collateralTable = artifact.highCfRows.slice(0, 20).map((row) => `| ${row.chain} | ${row.market} | ${row.assetSymbol} | ${(row.borrowCFBps / 100).toFixed(2)}% | ${formatUsd(row.assetValueUsd)} | ${formatUsd(row.marketBaseCashUsd)} | ${row.feedAgeSeconds ?? "n/a"} | ${row.externalDivergenceBps === null ? "n/a" : `${row.externalDivergenceBps}bps`} | ${row.feedTags.join(",") || "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const buyTable = artifact.buyOpportunityRows.length ? artifact.buyOpportunityRows.slice(0, 12).map((row) => `| ${row.chain} | ${row.market} | ${row.assetSymbol} | ${formatUsd(row.collateralReserveValueUsd)} | ${row.estimatedBuyDiscountBps} | ${formatUsd(row.estimatedBuyDiscountUsd)} |`).join("\n") : "| none | n/a | n/a | n/a | n/a | no material discounted collateral-reserve row |";
  const borrowerTable = artifact.borrowerRows.slice(0, 12).map((row) => `| ${row.chain} | ${row.market} | ${compactAddress(row.account)} | ${formatUsd(row.borrowUsd)} | ${row.isLiquidatable ? "yes" : "no"} | ${row.topCollateral?.symbol || "n/a"} | ${formatUsd(row.topCollateral?.valueUsd)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const unsupported = artifact.unsupportedChains.map((row) => `| ${row.chain || row.folder} | ${row.reason} |`).join("\n") || "| none | n/a |";
  return `# ${SIGNAL_DORMANT} - Compound V3 Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit for the covered current Compound V3 Comet scope. The scan refreshed live Comet deployments from local Compound source deployments across RPC-available chains, checked collateral factors, base borrow cash, oracle/feed wrapper state, and protocol collateral reserves. ${borrowerMode} High-collateral-factor and rate-wrapper rows remain context/watch-only without an attacker-favorable oracle/accounting trigger plus exact positive acquisition, borrow, liquidation, buyCollateral, and exit economics.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Deployment markets loaded | ${s.deploymentMarketsLoaded} |
| Chains inspected | ${s.chainsInspected} |
| Markets scanned | ${s.marketsScanned} |
| Market rows with code | ${s.marketRowsWithCode} |
| Collateral asset rows | ${s.assetRows} |
| High-CF material rows | ${s.highCfRows} |
| Stale feed watch rows | ${s.staleFeedRows} |
| Divergence watch rows | ${s.divergenceRows} |
| Buy-opportunity watch rows | ${s.buyOpportunityRows} |
| Borrower rows sampled | ${s.borrowerRows} |
| Liquidatable borrower rows | ${s.liquidatableBorrowerRows} |
| Config drift rows | ${s.configDriftRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |
| Coverage classification | ${s.coverageClassification} |

## Markets

| Chain | Market | Symbol | Comet | Assets | Base cash | Total borrow | Paused |
|---|---|---|---|---:|---:|---:|---|
${marketTable}

## High-CF Material Collateral

| Chain | Market | Asset | Borrow CF | Comet balance value | Base cash | Feed age sec | External divergence | Feed tags |
|---|---|---|---:|---:|---:|---:|---:|---|
${collateralTable}

## BuyCollateral Gross Discount Rows

| Chain | Market | Asset | Protocol collateral reserves | Discount bps | Estimated gross discount |
|---|---|---|---:|---:|---:|
${buyTable}

## Recent Borrower Sample

| Chain | Market | Account | Debt | Liquidatable | Top collateral | Top collateral value |
|---|---|---|---:|---|---|---:|
${borrowerTable}

## Unsupported / Bounded Scope

| Chain | Reason |
|---|---|
${unsupported}

## Blockers

- High-CF collateral rows do not prove accepted-value overpricing or cheap manipulation.
- Feed wrapper/rate-provider context needs source-specific manipulation or stale acceptance proof.
- Recent borrower sampling is ${s.borrowerSamplingMode === "disabled" ? "disabled in this artifact" : "bounded"} and does not provide exhaustive account-level liquidation coverage.
- Any current liquidatable account still needs exact absorb/buyCollateral/exit economics and fork proof.
- No DEX/borrow/repay/exit route is exact-positive after gas/slippage/fees, and no fork/local proof exists.

## Required For Route-Positive

- A specific Comet collateral oracle/accounting path overvalues collateral or exposes profitable liquidation/buyCollateral state.
- Borrow-side base liquidity and collateral acquisition/exit liquidity are exact-quoted.
- Gas, slippage, flash fees, and liquidation/buyCollateral sequencing leave positive net value.
- Fork/local proof demonstrates positive extraction.

Artifacts: \`reports/raw/fast/compound-v3-phase0.json\`.
`;
}

async function main() {
  const metadata = protocolMetadata();
  const targets = loadTargets();
  const chainIds = unique(targets.map((t) => t.chainId));
  const rpcs = await resolveRpcPool(chainIds);
  const blockByChain = {};
  for (const chainId of chainIds) blockByChain[chainId] = await latestBlock(rpcs[chainId]);
  const scanRows = [];
  const unsupportedChains = [...PUBLIC_UNSUPPORTED_CHAINS];
  for (const target of targets) {
    const rpc = rpcs[target.chainId];
    if (!rpc) { unsupportedChains.push({ folder: target.folder, chain: target.chain, reason: "no RPC resolved" }); continue; }
    const block = blockByChain[target.chainId] || { number: null, timestamp: null };
    try { scanRows.push({ target, ...(await inspectMarket(rpc, target, block)) }); }
    catch (err) { unsupportedChains.push({ folder: target.folder, chain: target.chain, market: target.market, reason: safeText(err?.message || "market-scan-error") }); }
  }
  const tokenRows = [];
  for (const row of scanRows) {
    tokenRows.push({ chainId: row.market.chainId, coinSlug: row.target.coinSlug, chain: row.market.chain, address: row.market.baseToken, symbol: row.market.baseSymbol, role: "baseToken" });
    for (const asset of row.assetRows) tokenRows.push({ chainId: row.market.chainId, coinSlug: row.target.coinSlug, chain: row.market.chain, address: asset.asset, symbol: asset.assetSymbol, role: "collateralAsset" });
  }
  const priceFetch = await fetchPrices(targets, tokenRows);
  enrichMarketRows(scanRows, priceFetch.prices);
  const borrowerRows = [];
  const logErrors = [];
  let logsScanned = 0;
  for (const row of scanRows) {
    const rpc = rpcs[row.market.chainId];
    const recent = await collectRecentAccounts(rpc, row.market, row.assetRows, row.market.blockNumber);
    logsScanned += recent.logsScanned;
    logErrors.push(...recent.errors);
    const borrowers = await inspectBorrowers(rpc, row.market, row.assetRows, recent.accounts);
    borrowerRows.push(...borrowers);
  }
  const marketRows = scanRows.map((row) => row.market).sort((a, b) => (asNumber(b.totalBorrowUsd) || 0) - (asNumber(a.totalBorrowUsd) || 0));
  const assetRows = scanRows.flatMap((row) => row.assetRows.map((asset) => ({ ...asset, marketBaseCashUsd: row.market.baseCashUsd, marketTotalBorrowUsd: row.market.totalBorrowUsd, baseSymbol: row.market.baseSymbol })));
  const highCfRows = assetRows.filter((row) => row.highCF && ((row.assetValueUsd || 0) >= MATERIAL_USD || (row.marketBaseCashUsd || 0) >= MATERIAL_USD)).sort((a, b) => (asNumber(b.assetValueUsd) || 0) - (asNumber(a.assetValueUsd) || 0));
  const staleFeedRows = assetRows.filter((row) => row.staleFeedWatch).sort((a, b) => (b.feedAgeSeconds || 0) - (a.feedAgeSeconds || 0));
  const divergenceRows = assetRows.filter((row) => row.divergenceWatch).sort((a, b) => (asNumber(b.externalDivergenceBps) || 0) - (asNumber(a.externalDivergenceBps) || 0));
  const buyOpportunityRows = assetRows.filter((row) => row.buyOpportunityWatch).sort((a, b) => (asNumber(b.estimatedBuyDiscountUsd) || 0) - (asNumber(a.estimatedBuyDiscountUsd) || 0));
  const configDriftRows = scanRows.flatMap((row) => row.configDriftRows);
  const watchCandidates = [...staleFeedRows, ...divergenceRows, ...buyOpportunityRows, ...borrowerRows.filter((row) => row.watchCandidate)];
  const summary = {
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    deploymentMarketsLoaded: targets.length,
    chainsInspected: unique(marketRows.map((row) => row.chainId)).length,
    unsupportedChains: unsupportedChains.length,
    marketsScanned: marketRows.length,
    marketRowsWithCode: marketRows.filter((row) => row.codePresent).length,
    assetRows: assetRows.length,
    highCfRows: highCfRows.length,
    staleFeedRows: staleFeedRows.length,
    divergenceRows: divergenceRows.length,
    buyOpportunityRows: buyOpportunityRows.length,
    borrowerRows: borrowerRows.length,
    liquidatableBorrowerRows: borrowerRows.filter((row) => row.isLiquidatable).length,
    configDriftRows: configDriftRows.length,
    logsScanned,
    logErrors: logErrors.length,
    borrowerSamplingMode: RECENT_LOG_BLOCKS > 0 ? "bounded-recent-logs" : "disabled",
    totalBaseCashUsd: round(marketRows.reduce((sum, row) => sum + (asNumber(row.baseCashUsd) || 0), 0), 2),
    totalBorrowUsd: round(marketRows.reduce((sum, row) => sum + (asNumber(row.totalBorrowUsd) || 0), 0), 2),
    watchCandidates: watchCandidates.length,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    coverageClassification: unsupportedChains.length || logErrors.length ? "bounded-with-caveats" : "full-enough-for-declared-scope",
    closedReason: "current Comet state has no exact-positive oracle, liquidation, buyCollateral, or borrow/unwind route",
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-compound-v3-phase0.js",
    scope: "Read-only Compound V3 Comet live-state Phase 0 scan",
    target: { name: "Compound V3", slug: "compound-v3", category: "Lending", surface: "lending-oracle-liquidation", metadata },
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false },
    thresholds: { recentLogBlocks: RECENT_LOG_BLOCKS, logChunkBlocks: LOG_CHUNK_BLOCKS, maxAccountsPerMarket: MAX_ACCOUNTS_PER_MARKET, maxLogsPerMarket: MAX_LOGS_PER_MARKET, borrowerDebtUsdMin: BORROWER_DEBT_USD_MIN, highCfBps: HIGH_CF_BPS, materialUsd: MATERIAL_USD, staleFeedSeconds: STALE_FEED_SECONDS, divergenceWatchBps: DIVERGENCE_WATCH_BPS },
    source: { localTarget: "targets/compound-comet", deployments: "targets/compound-comet/deployments", priorReports: ["reports/compound-triage.md", "reports/compound-capo-triage.md", "reports/raw/fast/phase6-compound-v3.json"] },
    priceFetch: priceFetch.fetched,
    unsupportedChains,
    logErrors: logErrors.slice(0, 80),
    marketRows,
    assetRows,
    highCfRows: highCfRows.slice(0, 160),
    staleFeedRows: staleFeedRows.slice(0, 80),
    divergenceRows: divergenceRows.slice(0, 80),
    buyOpportunityRows: buyOpportunityRows.slice(0, 80),
    borrowerRows: borrowerRows.slice(0, 160),
    configDriftRows: configDriftRows.slice(0, 160),
    watchCandidates: watchCandidates.slice(0, 160).map((row) => ({ chain: row.chain, market: row.market, asset: row.asset || row.topCollateral?.asset || null, symbol: row.assetSymbol || row.topCollateral?.symbol || null, account: row.account || null, reason: row.staleFeedWatch ? "stale-feed" : row.divergenceWatch ? "oracle-market-divergence" : row.buyOpportunityWatch ? "buy-collateral-discount" : row.isLiquidatable ? "sampled-liquidatable-account" : "watch", routePositive: false })),
    routePositiveRows: [],
    summary,
    blockers: [
      "High-CF collateral rows do not prove accepted-value overpricing or cheap manipulation",
      "Feed wrapper/rate-provider context needs source-specific manipulation or stale acceptance proof",
      "Recent borrower sampling is bounded and not exhaustive account-level liquidation coverage",
      "Current liquidatable or buyCollateral rows still need exact absorb/buy/exit economics and fork proof",
      "No exact positive borrow, liquidation, buyCollateral, redemption, DEX unwind economics, or proof",
    ],
    requiredForRoutePositive: [
      "specific Comet collateral oracle/accounting path overvalues collateral or exposes profitable liquidation/buyCollateral state",
      "borrow-side base liquidity and collateral acquisition/exit liquidity are exact-quoted",
      "positive net value after gas, slippage, flash fees, and liquidation/buyCollateral sequencing",
      "fork/local proof",
    ],
    nextReadOnlyStep: "Reopen Compound V3 if a high-CF oracle/rate wrapper becomes attacker-favorable, a sampled liquidatable account maps to exact positive absorb/buy/exit economics, or governance/config drift creates a concrete unsafe window.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));
  if (!QUIET) console.log(`Compound V3 Phase 0: markets=${summary.marketsScanned} assets=${summary.assetRows} highCf=${summary.highCfRows} stale=${summary.staleFeedRows} divergence=${summary.divergenceRows} borrowers=${summary.borrowerRows} liquidatable=${summary.liquidatableBorrowerRows} watch=${summary.watchCandidates} routePositive=0`);
}

main().catch((err) => { console.error(safeText(err?.message || String(err), 240)); process.exit(1); });
