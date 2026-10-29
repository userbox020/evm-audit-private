#!/usr/bin/env node
// scan-venus-flux-phase0.js - read-only Phase 0 for Venus Flux on BNB.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, execution calldata, NFT IDs, owner addresses, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const DEPLOYMENTS = path.join(WORKSPACE, "targets", "fluid-contracts-public", "deployments");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "venus-flux-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "venus-flux-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";
const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const MATERIAL_USD = Number(process.env.VENUS_FLUX_MATERIAL_USD || "10000");
const HIGH_CF_BPS = Number(process.env.VENUS_FLUX_HIGH_CF_BPS || "9000");
const MAX_POSITION_SAMPLE_VAULTS = Number(process.env.VENUS_FLUX_MAX_POSITION_SAMPLE_VAULTS || "12");
const POSITION_SAMPLE_PAGES = Number(process.env.VENUS_FLUX_POSITION_SAMPLE_PAGES || "1");
const CALL_CONCURRENCY = Number(process.env.VENUS_FLUX_CALL_CONCURRENCY || "8");

const CHAIN = {
  chainId: 56,
  chain: "BNB Chain",
  folder: "bnb",
  coinSlug: "bsc",
  nativePriceKey: "coingecko:binancecoin",
  liquidity: "0x52Aa899454998Be5b000Ad077a46Bbe360F4e497",
  liquidityResolver: "0xca13A15de31235A37134B4717021C35A3CF25C60",
};

const STABLE_SYMBOLS = new Set([
  "AUSD", "DAI", "EURC", "FRAX", "GHO", "LUSD", "PYUSD", "SUSD", "SUSDS", "USDBC", "USDC", "USDE", "USDS", "USDT", "USDT0", "USDTB", "USD0", "USD+",
]);

const LIQUIDITY_RESOLVER = new ethers.Interface([
  "function listedTokens() view returns (address[])",
  "function getStatus() view returns (uint256)",
  "function getRevenueCollector() view returns (address)",
  "function getOverallTokensData(address[] tokens_) view returns ((uint256 borrowRate,uint256 supplyRate,uint256 fee,uint256 lastStoredUtilization,uint256 storageUpdateThreshold,uint256 lastUpdateTimestamp,uint256 supplyExchangePrice,uint256 borrowExchangePrice,uint256 supplyRawInterest,uint256 supplyInterestFree,uint256 borrowRawInterest,uint256 borrowInterestFree,uint256 totalSupply,uint256 totalBorrow,uint256 revenue,uint256 maxUtilization,(uint256 version,(address token,uint256 kink,uint256 rateAtUtilizationZero,uint256 rateAtUtilizationKink,uint256 rateAtUtilizationMax) rateDataV1,(address token,uint256 kink1,uint256 kink2,uint256 rateAtUtilizationZero,uint256 rateAtUtilizationKink1,uint256 rateAtUtilizationKink2,uint256 rateAtUtilizationMax) rateDataV2) rateData)[])",
]);
const LENDING_FACTORY = new ethers.Interface(["function allTokens() view returns (address[])"]);
const FTOKEN = new ethers.Interface([
  "function asset() view returns (address)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
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

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const text = readText(file).replace(/^\uFEFF/, ""); return text ? JSON.parse(text) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function safeText(value, max = 160) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatPctBps(value) { const n = asNumber(value); return n === null ? "n/a" : `${round(n / 100, 2)}%`; }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function unitsToNumber(value, decimals = 18) { try { return Number(ethers.formatUnits(toBig(value), Number(decimals ?? 18))); } catch (_) { return null; } }
function amountNumber(raw, meta) { return unitsToNumber(raw, meta?.decimals ?? 18); }
function usdAmount(raw, meta) { const amount = amountNumber(raw, meta); const price = asNumber(meta?.priceUsd); return amount === null || price === null ? null : amount * price; }
function absDivergenceBps(a, b) { const x = asNumber(a); const y = asNumber(b); return x !== null && y ? round((Math.abs(x - y) / x) * 10000, 4) : null; }
function tokenMapKey(chainId, address) { return `${chainId}:${lowerAddress(address)}`; }
function nonZeroAddress(address) { const addr = normalizeAddress(address); return addr && lowerAddress(addr) !== lowerAddress(ZERO) ? addr : null; }

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
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
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-venus-flux-phase0/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = 12_000) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr || !iface) return null;
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

async function latestBlock(rpc) {
  const num = await rpcCall(rpc, "eth_blockNumber", [], 8_000).catch(() => null);
  const block = num ? await rpcCall(rpc, "eth_getBlockByNumber", [num, false], 8_000).catch(() => null) : null;
  return { number: num ? Number(BigInt(num)) : null, timestamp: block?.timestamp ? Number(BigInt(block.timestamp)) : null };
}

function decodeBytes32String(value) {
  try {
    if (!value || value === "0x") return null;
    return safeText(ethers.decodeBytes32String(value), 80);
  } catch (_) { return null; }
}

function deploymentPath(folder, name) { return path.join(DEPLOYMENTS, folder, name); }
function loadDeployment(folder, name) {
  const json = readJson(deploymentPath(folder, name), null);
  const address = normalizeAddress(json?.address);
  return address ? { address, abi: json?.abi || null } : null;
}
function loadInterface(folder, name) {
  const dep = loadDeployment(folder, name);
  if (!dep?.abi) return null;
  try { return new ethers.Interface(dep.abi); } catch (_) { return null; }
}
function listDeploymentRows(folder, regex, kind) {
  const dir = path.join(DEPLOYMENTS, folder);
  const rows = [];
  if (!fs.existsSync(dir)) return rows;
  for (const file of fs.readdirSync(dir)) {
    if (!regex.test(file)) continue;
    const json = readJson(path.join(dir, file), null);
    const address = normalizeAddress(json?.address);
    if (!address) continue;
    rows.push({ kind, file, label: file.replace(/\.json$/i, ""), address });
  }
  const seen = new Set();
  return rows.filter((row) => {
    const key = lowerAddress(row.address);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function protocolMetadata() {
  const live = await fetchJson("https://api.llama.fi/protocol/venus-flux", 30_000);
  const discovery = readJson(PUBLIC_TARGETS, {});
  const rows = [
    ...(discovery.phase0Queue || []),
    ...(discovery.protocolCandidates || []),
    ...(discovery.targetedRefreshQueue || []),
    ...(discovery.consumerJoinFirst || []),
    ...(discovery.protocols || []),
  ];
  const row = rows.find((p) => p?.slug === "venus-flux" || p?.name === "Venus Flux");
  const bnbTvl = asNumber(live?.currentChainTvls?.Binance ?? live?.chainTvls?.Binance?.tvl?.[live?.chainTvls?.Binance?.tvl?.length - 1]?.totalLiquidityUSD);
  return {
    name: live?.name || row?.name || "Venus Flux",
    slug: live?.slug || row?.slug || "venus-flux",
    category: live?.category || row?.category || "Lending",
    module: live?.module || null,
    url: live?.url || null,
    chains: live?.chains || row?.chains || ["Binance"],
    tvlUsd: round(live?.tvl ?? row?.tvlUsd, 2),
    bnbTvlUsd: round(bnbTvl, 2),
    borrowedUsd: round(live?.currentChainTvls?.borrowed ?? live?.borrowed ?? null, 2),
    source: live ? "defillama-protocol-api" : row ? "public-audit-target-discovery" : "fallback",
  };
}

function getField(obj, name, index) {
  if (!obj) return null;
  if (obj[name] !== undefined) return obj[name];
  if (obj[index] !== undefined) return obj[index];
  return null;
}
function tupleAddress(tuple, name, index) { return normalizeAddress(getField(tuple, name, index)); }

async function tokenBasics(rpc, token) {
  const addr = normalizeAddress(token);
  if (!addr || lowerAddress(addr) === lowerAddress(ZERO)) return null;
  if (lowerAddress(addr) === lowerAddress(NATIVE_SENTINEL)) {
    return { chainId: CHAIN.chainId, chain: CHAIN.chain, address: addr, symbol: "BNB", name: "BNB", decimals: 18, codePresent: false, codeBytes: 0, totalSupplyRaw: null, priceKey: CHAIN.nativePriceKey, priceUsd: null };
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
  const name = safeText(nameRaw?.[0], 100) || decodeBytes32String(nameBytesRaw?.[0]);
  return {
    chainId: CHAIN.chainId,
    chain: CHAIN.chain,
    address: addr,
    symbol,
    name,
    decimals: decimalsRaw?.[0] === undefined ? 18 : Number(decimalsRaw[0]),
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    totalSupplyRaw: totalSupplyRaw?.[0] === undefined ? null : totalSupplyRaw[0].toString(),
    priceKey: `${CHAIN.coinSlug}:${addr.toLowerCase()}`,
    priceUsd: null,
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

function stableFallback(symbol) {
  const normalized = String(symbol || "").toUpperCase().replace(/[^A-Z0-9+]/g, "");
  return STABLE_SYMBOLS.has(normalized) ? 1 : null;
}

async function inspectFToken(rpc, row) {
  const [code, asset, symbol, name, decimals, totalAssets, totalSupply, oneShareAssets] = await Promise.all([
    getCode(rpc, row.address),
    safeCall(rpc, row.address, FTOKEN, "asset"),
    safeCall(rpc, row.address, FTOKEN, "symbol"),
    safeCall(rpc, row.address, FTOKEN, "name"),
    safeCall(rpc, row.address, FTOKEN, "decimals"),
    safeCall(rpc, row.address, FTOKEN, "totalAssets"),
    safeCall(rpc, row.address, FTOKEN, "totalSupply"),
    safeCall(rpc, row.address, FTOKEN, "convertToAssets", [10n ** 18n]),
  ]);
  return {
    ...row,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    symbol: safeText(symbol?.[0], 40),
    name: safeText(name?.[0], 100),
    decimals: decimals?.[0] === undefined ? null : Number(decimals[0]),
    asset: normalizeAddress(asset?.[0]),
    totalAssetsRaw: totalAssets?.[0] === undefined ? null : totalAssets[0].toString(),
    totalSupplyRaw: totalSupply?.[0] === undefined ? null : totalSupply[0].toString(),
    oneShareAssetsRaw: oneShareAssets?.[0] === undefined ? null : oneShareAssets[0].toString(),
  };
}

function parseVaultData(row, dataResult) {
  const data = dataResult?.[0];
  if (!data) return { ...row, resolverOk: false, error: "getVaultEntireData-failed" };
  const constants = getField(data, "constantVariables", 3);
  const configs = getField(data, "configs", 4);
  const totals = getField(data, "totalSupplyAndBorrow", 6);
  const limits = getField(data, "limitsAndAvailability", 7);
  const vaultState = getField(data, "vaultState", 8);
  const supplyToken = getField(constants, "supplyToken", 8);
  const borrowToken = getField(constants, "borrowToken", 9);
  const operatePrice = getField(configs, "oraclePriceOperate", 9)?.toString?.() || null;
  const liquidatePrice = getField(configs, "oraclePriceLiquidate", 10)?.toString?.() || null;
  return {
    ...row,
    resolverOk: true,
    vault: normalizeAddress(getField(data, "vault", 0)) || row.address,
    vaultType: Number(getField(constants, "vaultType", 11) ?? row.label.match(/^VaultT(\d)_/)?.[1] ?? 0),
    vaultId: getField(constants, "vaultId", 10)?.toString?.() || null,
    isSmartCol: Boolean(getField(data, "isSmartCol", 1)),
    isSmartDebt: Boolean(getField(data, "isSmartDebt", 2)),
    supply: normalizeAddress(getField(constants, "supply", 6)),
    borrow: normalizeAddress(getField(constants, "borrow", 7)),
    supplyToken0: tupleAddress(supplyToken, "token0", 0),
    supplyToken1: tupleAddress(supplyToken, "token1", 1),
    borrowToken0: tupleAddress(borrowToken, "token0", 0),
    borrowToken1: tupleAddress(borrowToken, "token1", 1),
    collateralFactorBps: Number(getField(configs, "collateralFactor", 2) ?? 0),
    liquidationThresholdBps: Number(getField(configs, "liquidationThreshold", 3) ?? 0),
    liquidationMaxLimitBps: Number(getField(configs, "liquidationMaxLimit", 4) ?? 0),
    liquidationPenaltyBps: Number(getField(configs, "liquidationPenalty", 6) ?? 0),
    borrowFeeBps: Number(getField(configs, "borrowFee", 7) ?? 0),
    oracle: normalizeAddress(getField(configs, "oracle", 8)),
    oraclePriceOperateRaw: operatePrice,
    oraclePriceLiquidateRaw: liquidatePrice,
    oracleOperateVsLiquidateDivergenceBps: absDivergenceBps(operatePrice, liquidatePrice),
    configLastUpdateTimestamp: Number(getField(configs, "lastUpdateTimestamp", 12) ?? 0) || null,
    rebalancer: normalizeAddress(getField(configs, "rebalancer", 11)),
    totalSupplyVaultRaw: getField(totals, "totalSupplyVault", 0)?.toString?.() || null,
    totalBorrowVaultRaw: getField(totals, "totalBorrowVault", 1)?.toString?.() || null,
    totalSupplyLiquidityOrDexRaw: getField(totals, "totalSupplyLiquidityOrDex", 2)?.toString?.() || null,
    totalBorrowLiquidityOrDexRaw: getField(totals, "totalBorrowLiquidityOrDex", 3)?.toString?.() || null,
    absorbedSupplyRaw: getField(totals, "absorbedSupply", 4)?.toString?.() || null,
    absorbedBorrowRaw: getField(totals, "absorbedBorrow", 5)?.toString?.() || null,
    borrowLimitRaw: getField(limits, "borrowLimit", 3)?.toString?.() || null,
    borrowableRaw: getField(limits, "borrowable", 5)?.toString?.() || null,
    borrowLimitUtilizationRaw: getField(limits, "borrowLimitUtilization", 6)?.toString?.() || null,
    minimumBorrowingRaw: getField(limits, "minimumBorrowing", 7)?.toString?.() || null,
    totalPositions: Number(getField(vaultState, "totalPositions", 0) ?? 0),
    topTick: getField(vaultState, "topTick", 1)?.toString?.() || null,
    vaultStateTotalBorrowRaw: getField(vaultState, "totalBorrow", 4)?.toString?.() || null,
    vaultStateTotalSupplyRaw: getField(vaultState, "totalSupply", 5)?.toString?.() || null,
  };
}

function enrichVaultUsd(row, tokenByAddress) {
  const borrow0 = tokenByAddress.get(tokenMapKey(row.chainId, row.borrowToken0));
  const borrow1 = tokenByAddress.get(tokenMapKey(row.chainId, row.borrowToken1));
  const supply0 = tokenByAddress.get(tokenMapKey(row.chainId, row.supplyToken0));
  const supply1 = tokenByAddress.get(tokenMapKey(row.chainId, row.supplyToken1));
  const singleBorrowToken = borrow0 && !nonZeroAddress(row.borrowToken1);
  const singleSupplyToken = supply0 && !nonZeroAddress(row.supplyToken1);
  const borrowableUsd = singleBorrowToken ? usdAmount(row.borrowableRaw, borrow0) : null;
  const totalBorrowUsd = singleBorrowToken ? usdAmount(row.totalBorrowVaultRaw, borrow0) : null;
  const totalSupplyUsd = singleSupplyToken ? usdAmount(row.totalSupplyVaultRaw, supply0) : null;
  return {
    ...row,
    supplySymbol: [supply0?.symbol, supply1?.symbol].filter(Boolean).join("/") || null,
    borrowSymbol: [borrow0?.symbol, borrow1?.symbol].filter(Boolean).join("/") || null,
    borrowTokenIsDexOrPair: Boolean(nonZeroAddress(row.borrowToken1)),
    supplyTokenIsDexOrPair: Boolean(nonZeroAddress(row.supplyToken1)),
    borrowableUsd: round(borrowableUsd, 2),
    totalBorrowUsd: round(totalBorrowUsd, 2),
    totalSupplyUsd: round(totalSupplyUsd, 2),
    highCf: row.collateralFactorBps >= HIGH_CF_BPS,
    highCfBorrowable: row.collateralFactorBps >= HIGH_CF_BPS && (borrowableUsd || 0) >= MATERIAL_USD,
    materialBorrow: (totalBorrowUsd || 0) >= MATERIAL_USD,
    routePositive: false,
  };
}

function enrichTokenRow(token, data, tokenByAddress, blockTimestamp) {
  const meta = tokenByAddress.get(tokenMapKey(CHAIN.chainId, token));
  const totalSupplyRaw = getField(data, "totalSupply", 12)?.toString?.() || null;
  const totalBorrowRaw = getField(data, "totalBorrow", 13)?.toString?.() || null;
  const supplyUsd = usdAmount(totalSupplyRaw, meta);
  const borrowUsd = usdAmount(totalBorrowRaw, meta);
  const cashUsd = supplyUsd === null || borrowUsd === null ? null : Math.max(0, supplyUsd - borrowUsd);
  const lastUpdateTimestamp = Number(getField(data, "lastUpdateTimestamp", 5) ?? 0) || null;
  return {
    chainId: CHAIN.chainId,
    chain: CHAIN.chain,
    token: normalizeAddress(token),
    symbol: meta?.symbol || null,
    decimals: meta?.decimals ?? null,
    priceUsd: meta?.priceUsd ?? null,
    totalSupplyRaw,
    totalBorrowRaw,
    totalSupply: amountNumber(totalSupplyRaw, meta),
    totalBorrow: amountNumber(totalBorrowRaw, meta),
    totalSupplyUsd: round(supplyUsd, 2),
    totalBorrowUsd: round(borrowUsd, 2),
    availableLiquidityUsd: round(cashUsd, 2),
    utilizationBps: supplyUsd && borrowUsd !== null ? round((borrowUsd / supplyUsd) * 10000, 2) : null,
    borrowRateRaw: getField(data, "borrowRate", 0)?.toString?.() || null,
    supplyRateRaw: getField(data, "supplyRate", 1)?.toString?.() || null,
    supplyExchangePriceRaw: getField(data, "supplyExchangePrice", 6)?.toString?.() || null,
    borrowExchangePriceRaw: getField(data, "borrowExchangePrice", 7)?.toString?.() || null,
    lastUpdateTimestamp,
    storedDataAgeSeconds: blockTimestamp && lastUpdateTimestamp ? blockTimestamp - lastUpdateTimestamp : null,
    materialBorrowToken: (borrowUsd || 0) >= MATERIAL_USD,
    materialCashToken: (cashUsd || 0) >= MATERIAL_USD,
    routePositive: false,
  };
}

function enrichFTokenUsd(row, tokenByAddress) {
  const meta = tokenByAddress.get(tokenMapKey(row.chainId, row.asset));
  return {
    ...row,
    assetSymbol: meta?.symbol || null,
    assetDecimals: meta?.decimals ?? null,
    assetPriceUsd: meta?.priceUsd ?? null,
    totalAssets: amountNumber(row.totalAssetsRaw, meta),
    totalAssetsUsd: round(usdAmount(row.totalAssetsRaw, meta), 2),
    materialAssets: (usdAmount(row.totalAssetsRaw, meta) || 0) >= MATERIAL_USD,
  };
}

function enrichLiquidationRow(item, vaultByAddress, tokenByAddress) {
  const vault = normalizeAddress(getField(item, "vault", 0));
  const row = {
    chainId: CHAIN.chainId,
    chain: CHAIN.chain,
    vault,
    vaultLabel: vaultByAddress.get(lowerAddress(vault))?.label || null,
    token0In: normalizeAddress(getField(item, "token0In", 1)),
    token0Out: normalizeAddress(getField(item, "token0Out", 2)),
    token1In: normalizeAddress(getField(item, "token1In", 3)),
    token1Out: normalizeAddress(getField(item, "token1Out", 4)),
    inAmtRaw: getField(item, "inAmt", 5)?.toString?.() || "0",
    outAmtRaw: getField(item, "outAmt", 6)?.toString?.() || "0",
    inAmtWithAbsorbRaw: getField(item, "inAmtWithAbsorb", 7)?.toString?.() || "0",
    outAmtWithAbsorbRaw: getField(item, "outAmtWithAbsorb", 8)?.toString?.() || "0",
    absorbAvailable: Boolean(getField(item, "absorbAvailable", 9)),
  };
  const token0In = tokenByAddress.get(tokenMapKey(row.chainId, row.token0In));
  const token0Out = tokenByAddress.get(tokenMapKey(row.chainId, row.token0Out));
  const token1In = tokenByAddress.get(tokenMapKey(row.chainId, row.token1In));
  const token1Out = tokenByAddress.get(tokenMapKey(row.chainId, row.token1Out));
  return {
    ...row,
    token0InSymbol: token0In?.symbol || null,
    token0OutSymbol: token0Out?.symbol || null,
    token1InSymbol: token1In?.symbol || null,
    token1OutSymbol: token1Out?.symbol || null,
    materialContext: false,
    routePositive: false,
    blocker: "resolver liquidation amounts are raw/context-only until exact quote normalization, route unwind, gas, slippage, and fork proof are added",
  };
}

async function samplePositions(rpc, resolverAddress, resolverIface, vaultRows, tokenByAddress) {
  if (!resolverAddress || !resolverIface || POSITION_SAMPLE_PAGES <= 0) return [];
  const candidates = vaultRows
    .filter((row) => row.resolverOk && row.totalPositions > 0)
    .sort((a, b) => (b.totalBorrowUsd || 0) - (a.totalBorrowUsd || 0) || (b.collateralFactorBps || 0) - (a.collateralFactorBps || 0))
    .slice(0, MAX_POSITION_SAMPLE_VAULTS);
  return await mapLimit(candidates, 3, async (vault) => {
    const borrowMeta = tokenByAddress.get(tokenMapKey(CHAIN.chainId, vault.borrowToken0));
    let sampledRows = 0;
    let debtRows = 0;
    let totalBorrowRaw = 0n;
    let maxBorrowRaw = 0n;
    let hasNextPage = false;
    let callFailed = false;
    for (let page = 0; page < POSITION_SAMPLE_PAGES; page++) {
      const idsResult = await safeCall(rpc, resolverAddress, resolverIface, "getAllVaultNftIdsPaged", [vault.vault, BigInt(page)], 30_000);
      if (!idsResult) { callFailed = true; break; }
      const nftIds = idsResult?.[0] || [];
      hasNextPage = Boolean(idsResult?.[1]);
      const positionsResult = nftIds.length ? await safeCall(rpc, resolverAddress, resolverIface, "getVaultPositionsForNftIds", [nftIds, vault.vault], 60_000) : null;
      const positions = positionsResult?.[0] || [];
      sampledRows += positions.length;
      for (const position of positions) {
        const borrow = toBig(getField(position, "borrow", 3));
        if (borrow > 0n) debtRows++;
        totalBorrowRaw += borrow;
        if (borrow > maxBorrowRaw) maxBorrowRaw = borrow;
      }
      if (!hasNextPage) break;
    }
    const totalUsd = usdAmount(totalBorrowRaw.toString(), vault.borrowTokenIsDexOrPair ? null : borrowMeta);
    const maxUsd = usdAmount(maxBorrowRaw.toString(), vault.borrowTokenIsDexOrPair ? null : borrowMeta);
    return {
      chainId: CHAIN.chainId,
      chain: CHAIN.chain,
      vault: vault.vault,
      vaultLabel: vault.label,
      borrowSymbol: vault.borrowSymbol,
      collateralFactorBps: vault.collateralFactorBps,
      pagesSampled: POSITION_SAMPLE_PAGES,
      sampledRows,
      debtRows,
      sampledBorrowRaw: totalBorrowRaw.toString(),
      sampledBorrowUsd: round(totalUsd, 2),
      maxSampledBorrowRaw: maxBorrowRaw.toString(),
      maxSampledBorrowUsd: round(maxUsd, 2),
      hasMorePages: hasNextPage,
      sampleCallFailed: callFailed,
      materialDebtRowsObserved: (totalUsd || 0) >= MATERIAL_USD,
      storedIdentifiers: false,
    };
  });
}

async function inspectChain(rpc) {
  const block = rpc ? await latestBlock(rpc) : { number: null, timestamp: null };
  const liquidity = loadDeployment(CHAIN.folder, "Liquidity.json") || { address: CHAIN.liquidity };
  const liquidityResolver = loadDeployment(CHAIN.folder, "LiquidityResolver.json") || { address: CHAIN.liquidityResolver };
  const vaultFactory = loadDeployment(CHAIN.folder, "VaultFactory.json");
  const lendingFactory = loadDeployment(CHAIN.folder, "LendingFactory.json");
  const vaultResolver = loadDeployment(CHAIN.folder, "VaultResolver.json");
  const vaultResolverIface = loadInterface(CHAIN.folder, "VaultResolver.json");
  const positionsResolver = loadDeployment(CHAIN.folder, "VaultPositionsResolver.json");
  const positionsResolverIface = loadInterface(CHAIN.folder, "VaultPositionsResolver.json");
  const vaultDeployments = listDeploymentRows(CHAIN.folder, /^VaultT[1-4]_.+\.json$/i, "vault").filter((row) => !/_Operate$/i.test(row.label));
  const fTokenDeployments = listDeploymentRows(CHAIN.folder, /^fToken_f.+\.json$/i, "fToken").filter((row) => !/(Rewards|Reward|Handler)$/i.test(row.label));

  if (!rpc) {
    return {
      chainId: CHAIN.chainId,
      chain: CHAIN.chain,
      rpcAvailable: false,
      block,
      tokenRows: [],
      fTokenRows: [],
      vaultRows: vaultDeployments,
      liquidationRows: [],
      positionSampleRows: [],
      errors: ["no-rpc-available"],
    };
  }

  const [liquidityResolverCode, liquidityCode, vaultFactoryCode, lendingFactoryCode, vaultResolverCode, positionsResolverCode, liquidityStatus, revenueCollector] = await Promise.all([
    getCode(rpc, liquidityResolver.address),
    getCode(rpc, liquidity.address),
    getCode(rpc, vaultFactory?.address),
    getCode(rpc, lendingFactory?.address),
    getCode(rpc, vaultResolver?.address),
    getCode(rpc, positionsResolver?.address),
    safeCall(rpc, liquidityResolver.address, LIQUIDITY_RESOLVER, "getStatus"),
    safeCall(rpc, liquidityResolver.address, LIQUIDITY_RESOLVER, "getRevenueCollector"),
  ]);

  const listedTokensRaw = await safeCall(rpc, liquidityResolver.address, LIQUIDITY_RESOLVER, "listedTokens", [], 20_000);
  const listedTokens = (listedTokensRaw?.[0] || []).map(normalizeAddress).filter(Boolean);
  const overallRaw = listedTokens.length ? await safeCall(rpc, liquidityResolver.address, LIQUIDITY_RESOLVER, "getOverallTokensData", [listedTokens], 60_000) : null;
  const overallData = overallRaw?.[0] || [];
  const factoryTokensRaw = lendingFactory?.address ? await safeCall(rpc, lendingFactory.address, LENDING_FACTORY, "allTokens", [], 20_000) : null;
  const factoryTokens = (factoryTokensRaw?.[0] || []).map(normalizeAddress).filter(Boolean);
  const fTokenRowsRaw = unique([...factoryTokens, ...fTokenDeployments.map((row) => row.address)]).map((address) => {
    const dep = fTokenDeployments.find((row) => lowerAddress(row.address) === lowerAddress(address));
    return { chainId: CHAIN.chainId, chain: CHAIN.chain, address, label: dep?.label || null, source: dep ? "deployment+factory" : "factory" };
  });
  const fTokenRowsBase = await mapLimit(fTokenRowsRaw, CALL_CONCURRENCY, (row) => inspectFToken(rpc, row));

  const vaultRowsBase = await mapLimit(vaultDeployments.map((row) => ({ ...row, chainId: CHAIN.chainId, chain: CHAIN.chain })), CALL_CONCURRENCY, async (row) => {
    const code = await getCode(rpc, row.address);
    const data = vaultResolver?.address && vaultResolverIface ? await safeCall(rpc, vaultResolver.address, vaultResolverIface, "getVaultEntireData", [row.address], 30_000) : null;
    return { ...parseVaultData(row, data), codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0 };
  });

  const tokenAddresses = new Set();
  for (const token of listedTokens) tokenAddresses.add(token);
  for (const row of fTokenRowsBase) if (row.asset) tokenAddresses.add(row.asset);
  for (const row of vaultRowsBase) {
    for (const token of [row.supplyToken0, row.supplyToken1, row.borrowToken0, row.borrowToken1]) if (nonZeroAddress(token)) tokenAddresses.add(token);
  }
  const basics = (await mapLimit([...tokenAddresses], CALL_CONCURRENCY, (token) => tokenBasics(rpc, token))).filter(Boolean);
  const priceKeys = unique(basics.map((row) => row.priceKey).filter(Boolean));
  const prices = await loadPrices(priceKeys);
  const tokenRowsMeta = basics.map((row) => ({ ...row, priceUsd: prices[String(row.priceKey || "").toLowerCase()] ?? stableFallback(row.symbol) }));
  const tokenByAddress = new Map(tokenRowsMeta.map((row) => [tokenMapKey(row.chainId, row.address), row]));

  const tokenRows = listedTokens.map((token, index) => enrichTokenRow(token, overallData[index] || null, tokenByAddress, block.timestamp));
  const fTokenRows = fTokenRowsBase.map((row) => enrichFTokenUsd(row, tokenByAddress));
  const vaultRows = vaultRowsBase.map((row) => enrichVaultUsd(row, tokenByAddress));
  const vaultByAddress = new Map(vaultRows.map((row) => [lowerAddress(row.vault || row.address), row]));
  const liquidationRawRows = vaultResolver?.address && vaultResolverIface
    ? await mapLimit(vaultRows.filter((row) => row.resolverOk), Math.min(4, CALL_CONCURRENCY), async (row) => {
        const result = await safeCall(rpc, vaultResolver.address, vaultResolverIface, "getVaultLiquidation", [row.vault || row.address, 0n], 45_000);
        return result?.[0] || null;
      })
    : [];
  const liquidationRows = liquidationRawRows
    .filter(Boolean)
    .map((row) => enrichLiquidationRow(row, vaultByAddress, tokenByAddress))
    .filter((row) => toBig(row.inAmtRaw) > 0n || toBig(row.outAmtRaw) > 0n || toBig(row.inAmtWithAbsorbRaw) > 0n || toBig(row.outAmtWithAbsorbRaw) > 0n);
  const positionSampleRows = await samplePositions(rpc, positionsResolver?.address, positionsResolverIface, vaultRows, tokenByAddress);

  return {
    chainId: CHAIN.chainId,
    chain: CHAIN.chain,
    rpcAvailable: true,
    block,
    contracts: {
      liquidityResolver: { address: normalizeAddress(liquidityResolver.address), codePresent: Boolean(liquidityResolverCode && liquidityResolverCode !== "0x"), codeBytes: liquidityResolverCode && liquidityResolverCode !== "0x" ? strip0x(liquidityResolverCode).length / 2 : 0 },
      liquidity: { address: normalizeAddress(liquidity.address), codePresent: Boolean(liquidityCode && liquidityCode !== "0x"), codeBytes: liquidityCode && liquidityCode !== "0x" ? strip0x(liquidityCode).length / 2 : 0, status: liquidityStatus?.[0] === undefined ? null : Number(liquidityStatus[0]), revenueCollector: normalizeAddress(revenueCollector?.[0]) },
      vaultFactory: { address: normalizeAddress(vaultFactory?.address), codePresent: Boolean(vaultFactoryCode && vaultFactoryCode !== "0x"), codeBytes: vaultFactoryCode && vaultFactoryCode !== "0x" ? strip0x(vaultFactoryCode).length / 2 : 0 },
      lendingFactory: { address: normalizeAddress(lendingFactory?.address), codePresent: Boolean(lendingFactoryCode && lendingFactoryCode !== "0x"), codeBytes: lendingFactoryCode && lendingFactoryCode !== "0x" ? strip0x(lendingFactoryCode).length / 2 : 0 },
      vaultResolver: { address: normalizeAddress(vaultResolver?.address), codePresent: Boolean(vaultResolverCode && vaultResolverCode !== "0x"), codeBytes: vaultResolverCode && vaultResolverCode !== "0x" ? strip0x(vaultResolverCode).length / 2 : 0 },
      vaultPositionsResolver: { address: normalizeAddress(positionsResolver?.address), codePresent: Boolean(positionsResolverCode && positionsResolverCode !== "0x"), codeBytes: positionsResolverCode && positionsResolverCode !== "0x" ? strip0x(positionsResolverCode).length / 2 : 0 },
    },
    tokenRows,
    fTokenRows,
    vaultRows,
    liquidationRows,
    positionSampleRows,
    tokenMetaRows: tokenRowsMeta,
    errors: [
      listedTokens.length && !overallData.length ? "overall-token-data-call-failed" : null,
      vaultResolver?.address && !liquidationRawRows.length ? "vault-liquidation-calls-empty-or-failed" : null,
    ].filter(Boolean),
  };
}

function summarize(chainResult, metadata) {
  const tokenRows = chainResult.tokenRows || [];
  const fTokenRows = chainResult.fTokenRows || [];
  const vaultRows = chainResult.vaultRows || [];
  const liquidationRows = chainResult.liquidationRows || [];
  const positionRows = chainResult.positionSampleRows || [];
  const contracts = Object.values(chainResult.contracts || {});
  const totalBorrowUsd = tokenRows.reduce((sum, row) => sum + (row.totalBorrowUsd || 0), 0);
  const totalSupplyUsd = tokenRows.reduce((sum, row) => sum + (row.totalSupplyUsd || 0), 0);
  const totalCashUsd = tokenRows.reduce((sum, row) => sum + (row.availableLiquidityUsd || 0), 0);
  const materialLiquidationRows = liquidationRows.filter((row) => row.materialContext);
  const highCfBorrowableRows = vaultRows.filter((row) => row.highCfBorrowable);
  const smartDebtHighCfRows = vaultRows.filter((row) => row.highCf && row.borrowTokenIsDexOrPair && (row.totalPositions || 0) > 0);
  const sampledPositionRows = positionRows.reduce((sum, row) => sum + (row.sampledRows || 0), 0);
  const sampledDebtRows = positionRows.reduce((sum, row) => sum + (row.debtRows || 0), 0);
  const watchCandidates = materialLiquidationRows.length;
  const routePositive = 0;
  return {
    defillamaCurrentTvlUsd: metadata.bnbTvlUsd ?? metadata.tvlUsd ?? null,
    defillamaProtocolTvlUsd: metadata.tvlUsd ?? null,
    defillamaBorrowedUsd: metadata.borrowedUsd ?? null,
    chainsInScope: 1,
    chainsScanned: chainResult.rpcAvailable ? 1 : 0,
    contractRows: contracts.length,
    contractRowsWithCode: contracts.filter((row) => row.codePresent).length,
    listedTokenRows: tokenRows.length,
    materialBorrowTokenRows: tokenRows.filter((row) => row.materialBorrowToken).length,
    materialCashTokenRows: tokenRows.filter((row) => row.materialCashToken).length,
    fTokenRows: fTokenRows.length,
    materialFTokenRows: fTokenRows.filter((row) => row.materialAssets).length,
    vaultDeploymentRows: vaultRows.length,
    vaultRowsWithCode: vaultRows.filter((row) => row.codePresent).length,
    vaultRowsResolved: vaultRows.filter((row) => row.resolverOk).length,
    highCfVaultRows: vaultRows.filter((row) => row.highCf).length,
    highCfBorrowableRows: highCfBorrowableRows.length,
    smartDebtHighCfRows: smartDebtHighCfRows.length,
    liquidationHintRows: liquidationRows.length,
    materialLiquidationHintRows: materialLiquidationRows.length,
    positionSampleVaultRows: positionRows.length,
    positionSampleRows: sampledPositionRows,
    positionSampleDebtRows: sampledDebtRows,
    materialPositionSampleRows: positionRows.filter((row) => row.materialDebtRowsObserved).length,
    totalSupplyUsd: round(totalSupplyUsd, 2),
    totalBorrowUsd: round(totalBorrowUsd, 2),
    totalAvailableLiquidityUsd: round(totalCashUsd, 2),
    watchCandidates,
    routePositive,
    executableNow: false,
    signedActionJustified: false,
    coverageClassification: "bounded-with-caveats",
    forkGate: routePositive ? "route-positive-needs-fork-proof" : "closed-route-positive-zero",
  };
}

function tableRows(rows, mapper, empty) {
  if (!rows.length) return empty;
  return rows.map(mapper).join("\n");
}

function buildReport(artifact) {
  const s = artifact.summary;
  const tokenRows = artifact.chainResult.tokenRows || [];
  const vaultRows = artifact.chainResult.vaultRows || [];
  const fTokenRows = artifact.chainResult.fTokenRows || [];
  const liquidationRows = artifact.chainResult.liquidationRows || [];
  const positionRows = artifact.chainResult.positionSampleRows || [];
  const topTokenRows = [...tokenRows].sort((a, b) => (b.totalBorrowUsd || 0) - (a.totalBorrowUsd || 0)).slice(0, 12);
  const topVaultRows = [...vaultRows].filter((row) => row.highCf || row.materialBorrow || row.borrowableUsd).sort((a, b) => (b.totalBorrowUsd || 0) - (a.totalBorrowUsd || 0) || (b.collateralFactorBps || 0) - (a.collateralFactorBps || 0)).slice(0, 12);
  const topFTokenRows = [...fTokenRows].sort((a, b) => (b.totalAssetsUsd || 0) - (a.totalAssetsUsd || 0)).slice(0, 10);
  const topLiquidationRows = [...liquidationRows].slice(0, 10);
  const topPositionRows = [...positionRows].sort((a, b) => (b.sampledBorrowUsd || 0) - (a.sampledBorrowUsd || 0)).slice(0, 8);

  return `# ${SIGNAL_DORMANT} - Venus Flux Phase 0 Triage

Generated: ${artifact.generatedAt}

Scanner: \`${artifact.scanner}\`

## Result

No confirmed permissionless exploit. Venus Flux is a Fluid-style BNB deployment, not a standard Venus isolated pool. The scanner mapped the shared Liquidity layer, listed tokens, fTokens, vault deployments, resolver configs, raw liquidation hints, and bounded position summaries. No row has exact positive liquidation, borrow, redemption, or unwind economics, and no signed action is justified.

## Summary

| Metric | Value |
|---|---:|
| BNB TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Protocol borrowed context | ${formatUsd(s.defillamaBorrowedUsd)} |
| Chains scanned | \`${s.chainsScanned}/${s.chainsInScope}\` |
| Contract rows with code | \`${s.contractRowsWithCode}/${s.contractRows}\` |
| Listed liquidity tokens | \`${s.listedTokenRows}\` |
| Material borrow token rows | \`${s.materialBorrowTokenRows}\` |
| Material cash token rows | \`${s.materialCashTokenRows}\` |
| fToken rows / material | \`${s.fTokenRows}/${s.materialFTokenRows}\` |
| Vault deployments / resolved | \`${s.vaultDeploymentRows}/${s.vaultRowsResolved}\` |
| High-CF vault rows | \`${s.highCfVaultRows}\` |
| High-CF borrowable rows | \`${s.highCfBorrowableRows}\` |
| Smart-debt high-CF rows | \`${s.smartDebtHighCfRows}\` |
| Liquidation hint rows | \`${s.liquidationHintRows}\` |
| Material liquidation hint rows | \`${s.materialLiquidationHintRows}\` |
| Bounded position sample vaults | \`${s.positionSampleVaultRows}\` |
| Bounded position rows sampled | \`${s.positionSampleRows}\` |
| Bounded debt rows sampled | \`${s.positionSampleDebtRows}\` |
| Listed-token supply context | ${formatUsd(s.totalSupplyUsd)} |
| Listed-token borrow context | ${formatUsd(s.totalBorrowUsd)} |
| Listed-token available liquidity context | ${formatUsd(s.totalAvailableLiquidityUsd)} |
| Watch candidates | \`${s.watchCandidates}\` |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |
| Coverage classification | \`${s.coverageClassification}\` |

## Top Borrow Tokens

| Chain | Token | Borrow | Available liquidity | Utilization | Stored data age |
|---|---|---:|---:|---:|---:|
${tableRows(topTokenRows, (row) => `| ${row.chain} | ${row.symbol || compactAddress(row.token)} | ${formatUsd(row.totalBorrowUsd)} | ${formatUsd(row.availableLiquidityUsd)} | ${formatPctBps(row.utilizationBps)} | ${row.storedDataAgeSeconds === null ? "n/a" : `${row.storedDataAgeSeconds}s`} |`, "| none | n/a | n/a | n/a | n/a | n/a |")}

## Top fTokens

| Chain | fToken | Asset | Total assets | Material |
|---|---|---|---:|---:|
${tableRows(topFTokenRows, (row) => `| ${row.chain} | ${row.symbol || compactAddress(row.address)} | ${row.assetSymbol || compactAddress(row.asset)} | ${formatUsd(row.totalAssetsUsd)} | ${row.materialAssets ? "yes" : "no"} |`, "| none | n/a | n/a | n/a | n/a |")}

## High-CF / Material Vault Rows

| Chain | Vault | Pair | CF / LT | Borrow | Borrowable | Oracle div. | Positions |
|---|---|---|---:|---:|---:|---:|---:|
${tableRows(topVaultRows, (row) => `| ${row.chain} | ${safeText(row.label, 48) || compactAddress(row.vault)} | ${row.supplySymbol || "n/a"} -> ${row.borrowSymbol || "n/a"} | ${formatPctBps(row.collateralFactorBps)} / ${formatPctBps(row.liquidationThresholdBps)} | ${formatUsd(row.totalBorrowUsd)} | ${formatUsd(row.borrowableUsd)} | ${row.oracleOperateVsLiquidateDivergenceBps === null ? "n/a" : `${row.oracleOperateVsLiquidateDivergenceBps}bps`} | ${row.totalPositions ?? 0} |`, "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |")}

## Liquidation Resolver Hints

| Chain | Vault | Token path | Raw in | Raw out | Absorb | Blocker |
|---|---|---|---:|---:|---:|---|
${tableRows(topLiquidationRows, (row) => `| ${row.chain} | ${safeText(row.vaultLabel, 42) || compactAddress(row.vault)} | ${row.token0InSymbol || compactAddress(row.token0In)} -> ${row.token0OutSymbol || compactAddress(row.token0Out)} | ${row.inAmtRaw} | ${row.outAmtRaw} | ${row.absorbAvailable ? "yes" : "no"} | raw context only; no exact route/fork proof |`, "| none | n/a | n/a | n/a | n/a | n/a | no current resolver liquidation context |")}

## Bounded Position Sampling

| Chain | Vault | Sampled rows | Debt rows | Sampled debt | Max sampled debt | More pages |
|---|---|---:|---:|---:|---:|---:|
${tableRows(topPositionRows, (row) => `| ${row.chain} | ${safeText(row.vaultLabel, 42) || compactAddress(row.vault)} | ${row.sampledRows} | ${row.debtRows} | ${formatUsd(row.sampledBorrowUsd)} | ${formatUsd(row.maxSampledBorrowUsd)} | ${row.hasMorePages ? "yes" : "no"} |`, "| none | n/a | n/a | n/a | n/a | n/a | n/a |")}

Position sampling is bounded and does not persist NFT IDs, owner addresses, calldata, or signed-action material.

## Blockers

- Resolver liquidation rows, if any, are context only until exact repay/acquire/exit quotes, gas, slippage, and fork extraction prove positive economics.
- High-CF and smart-debt vault rows are configuration context only without a current accepted-value divergence or exact positive borrow/liquidation route.
- Venus Flux does not appear in the legacy Venus isolated PoolRegistry; this pass treats it as Fluid-style \`venus-fluid\` and uses Fluid resolvers/deployments.
- Fluid DEX share consumers remain protocol-internal and were separately closed as route-negative unless an external consumer starts trusting Fluid DEX state.

## Reopen Triggers

- A resolver liquidation row maps to a material exact repay/acquire/exit route with positive net after gas/slippage.
- A high-CF vault accepts stale, under-bound, or overvalued oracle/accounting state while borrowable liquidity and exit liquidity are material.
- A Fluid DEX/share accounting bug or external consumer join turns internal DEX-share state into trusted collateral/accounting impact.

## Close-Out

Venus Flux remains dormant for the declared Phase 0 scope. No fork, executor, or live action is justified from this pass.
`;
}

async function main() {
  const metadata = await protocolMetadata();
  const rpcPool = await resolveRpcPool([CHAIN.chainId]);
  const chainResult = await inspectChain(rpcPool[CHAIN.chainId] || null);
  const summary = summarize(chainResult, metadata);
  const topRows = [...(chainResult.vaultRows || [])]
    .filter((row) => row.highCf || row.materialBorrow || row.borrowableUsd)
    .sort((a, b) => (b.totalBorrowUsd || 0) - (a.totalBorrowUsd || 0) || (b.collateralFactorBps || 0) - (a.collateralFactorBps || 0))
    .slice(0, 10)
    .map((row) => ({
      chain: row.chain,
      symbol: row.borrowSymbol || null,
      pair: `${row.supplySymbol || "n/a"}/${row.borrowSymbol || "n/a"}`,
      collateralSymbol: row.supplySymbol || null,
      borrowSymbol: row.borrowSymbol || null,
      totalBorrowUsd: row.totalBorrowUsd,
      liquidityUsd: row.borrowableUsd,
      edgeBps: row.oracleOperateVsLiquidateDivergenceBps,
      routePositive: false,
      blocker: "no exact-positive borrow/liquidation/unwind economics",
    }));
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-venus-flux-phase0.js",
    scope: "Read-only Venus Flux BNB Fluid-style Liquidity/fToken/vault/oracle/liquidation Phase 0 scan",
    target: { name: "Venus Flux", slug: "venus-flux", category: "Lending", surface: "fluid-style-lending-oracle-liquidation", metadata },
    safety: {
      publicApisOnlyForMetadata: true,
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      calldataStored: false,
      positionIdentifiersStored: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    thresholds: { materialUsd: MATERIAL_USD, highCollateralFactorBps: HIGH_CF_BPS, maxPositionSampleVaults: MAX_POSITION_SAMPLE_VAULTS, positionSamplePages: POSITION_SAMPLE_PAGES },
    docs: {
      adapter: "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/venus-fluid/index.js",
      source: "https://github.com/Instadapp/fluid-contracts-public",
      fluidLendingPhase0: "reports/fluid-lending-phase0-triage.md",
      fluidDexPhase0: "reports/fluid-dex-phase0-triage.md",
    },
    summary,
    topRows,
    chainResult,
    routePositive: false,
    executableNow: false,
    signedActionJustified: false,
    forkGate: summary.forkGate,
    blockers: [
      "No exact positive liquidation, borrow, redemption, or DEX unwind economics were proven",
      "High-CF and smart-debt rows are configuration context unless accepted value diverges in an attacker-favorable direction",
      "Resolver liquidation hints require exact route quotes and fork extraction before route-positive classification",
      "Venus Flux is Fluid-style venus-fluid, not a standard Venus isolated-pool PoolRegistry deployment",
    ],
    requiredForRoutePositive: [
      "material current liquidation, stale-oracle, or overvalued-collateral trigger",
      "permissionless repay/acquire/borrow/redeem path with usable liquidity",
      "exact positive net economics after fees, gas, and slippage",
      "fork extraction proof before any live preflight or signed action",
    ],
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, JSON.stringify(artifact, jsonReplacer, 2));
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));
  if (!QUIET) {
    console.log(`Venus Flux Phase 0: chains=${summary.chainsScanned}/${summary.chainsInScope} tokens=${summary.listedTokenRows} vaults=${summary.vaultRowsResolved}/${summary.vaultDeploymentRows} highCfBorrowable=${summary.highCfBorrowableRows} liquidationHints=${summary.materialLiquidationHintRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
