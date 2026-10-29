#!/usr/bin/env node
// Read-only Avalanche high-APY stable route mapper.
// Covers Pharaoh USDT-USDC and Blackhole sUSDe-USDC without signed calls.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "avalanche-stable-yield-routes.json");
const SILO_DEPLOYMENTS = path.join(WORKSPACE, "targets", "silo-contracts-v2", "silo-core", "deployments", "avalanche");
const LOCAL_REF_ROOTS = [
  path.join(WORKSPACE, "targets", "silo-contracts-v2"),
  path.join(WORKSPACE, "targets", "aave-governance-v3"),
  path.join(WORKSPACE, "targets", "spark-vaults-v2"),
  path.join(WORKSPACE, "targets", "spark-alm-controller"),
  path.join(WORKSPACE, "targets", "gmx-synthetics", "deployments", "avalanche"),
];

const TIMEOUT_MS = 15_000;
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";
const CHAIN_ID = 43114;
const CHAIN = { chainId: CHAIN_ID, chain: "Avalanche", coinSlug: "avalanche" };
const PUBLIC_AVAX_RPC = "https://api.avax.network/ext/bc/C/rpc";
const MIN_ROUTE_EDGE_BPS = Number(process.env.AVALANCHE_STABLE_MIN_ROUTE_EDGE_BPS || "100");
const MIN_BORROW_CASH_USD = Number(process.env.AVALANCHE_STABLE_MIN_BORROW_CASH_USD || "10000");
const MAX_SILO_IDS = Number(process.env.AVALANCHE_STABLE_MAX_SILO_IDS || "700");
const MORPHO_FIRST = Number(process.env.AVALANCHE_STABLE_MORPHO_FIRST || "100");

const TOKENS = {
  USDT: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
  USDC: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  USDe: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
  sUSDe: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2",
  WAVAX: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
};
const POOLS = {
  usdtUsdc: {
    id: "avalanche-usdt-usdc",
    label: "Pharaoh USDT-USDC",
    project: "pharaoh-v3",
    symbol: "USDT-USDC",
    defillamaPoolId: "58990934-9fb1-45f2-8882-d493c4627768",
    pair: "0x9bFE3108Cc16D17a9Ec65545a0f50B2CA1C970c0",
    baseToken: TOKENS.USDT,
    quoteToken: TOKENS.USDC,
  },
  susdeUsdc: {
    id: "avalanche-susde-usdc",
    label: "Blackhole sUSDe-USDC",
    project: "blackhole-clmm",
    symbol: "SUSDE-USDC",
    defillamaPoolId: "a4287be0-23e5-4d40-96e4-286849bd3106",
    pair: "0x5AF652d03a7151fC233Fde83a0f8217Fff7cFdfB",
    baseToken: TOKENS.sUSDe,
    quoteToken: TOKENS.USDC,
  },
};

const AAVE_ADDRESSES_PROVIDER = "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb";
const BENQI_COMPTROLLER = "0x486Af39519B4Dc9a7fCcd318217352830E8AD9b4";

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function previewWithdraw(uint256 assets) view returns (uint256)",
  "function cooldownDuration() view returns (uint24)",
  "function silo() view returns (address)",
  "function redeem(uint256 shares,address receiver,address owner) returns (uint256)",
  "function withdraw(uint256 assets,address receiver,address owner) returns (uint256)",
  "function cooldownAssets(uint256 assets) returns (uint256)",
  "function cooldownShares(uint256 shares) returns (uint256)",
  "function unstake(address receiver)",
]);
const TOKEN_CONTROL = new ethers.Interface([
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function MINTER_ROLE() view returns (bytes32)",
  "function BURNER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function owner() view returns (address)",
  "function minter() view returns (address)",
  "function masterMinter() view returns (address)",
  "function pauser() view returns (address)",
  "function blacklister() view returns (address)",
  "function getCCIPAdmin() view returns (address)",
  "function mint(address,uint256)",
  "function mint(uint256,address)",
  "function burn(uint256)",
  "function burnFrom(address,uint256)",
]);
const AAVE_PROVIDER = new ethers.Interface([
  "function getPool() view returns (address)",
  "function getPriceOracle() view returns (address)",
]);
const AAVE_POOL = new ethers.Interface([
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns (tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
  "function getEModeCategoryData(uint8 id) view returns (tuple(uint16 ltv,uint16 liquidationThreshold,uint16 liquidationBonus,address priceSource,string label))",
]);
const AAVE_ORACLE = new ethers.Interface([
  "function BASE_CURRENCY_UNIT() view returns (uint256)",
  "function getAssetPrice(address asset) view returns (uint256)",
  "function getSourceOfAsset(address asset) view returns (address)",
]);
const CHAINLINK = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestAnswer() view returns (int256)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const MORPHO_ORACLE = new ethers.Interface(["function price() view returns (uint256)"]);
const SLIPSTREAM_POOL = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,bool unlocked)",
]);
const V2_PAIR = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
  "function stable() view returns (bool)",
]);
const SILO_FACTORY = new ethers.Interface([
  "function getNextSiloId() view returns (uint256)",
  "function idToSiloConfig(uint256 id) view returns (address)",
]);
const SILO_CONFIG = new ethers.Interface([
  "function getSilos() view returns (address,address)",
  "function getConfig(address silo) view returns ((uint256,uint256,address,address,address,address,address,address,address,address,uint256,uint256,uint256,uint256,uint256,address,bool))",
]);
const SILO = new ethers.Interface([
  "function getLiquidity() view returns (uint256)",
  "function getSiloStorage() view returns (uint192,uint64,uint256,uint256,uint256)",
]);
const BENQI_COMP = new ethers.Interface([
  "function oracle() view returns (address)",
  "function getAllMarkets() view returns (address[])",
  "function markets(address) view returns (bool isListed,uint256 collateralFactorMantissa,bool isQi)",
  "function mintGuardianPaused(address) view returns (bool)",
  "function borrowGuardianPaused(address) view returns (bool)",
]);
const BENQI_QTOKEN = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function underlying() view returns (address)",
  "function getCash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function exchangeRateStored() view returns (uint256)",
]);
const BENQI_ORACLE = new ethers.Interface(["function getUnderlyingPrice(address qiToken) view returns (uint256)"]);

const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function sanitizeError(error) { return String(error?.shortMessage || error?.message || error || "call failed").replace(/https?:\/\/\S+/g, "[redacted-url]").slice(0, 180); }
function normalizeAddress(value) { try { return ethers.getAddress(value); } catch (_) { return null; } }
function lowerAddress(value) { const address = normalizeAddress(value); return address ? address.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function wordAt(raw, index) { const hex = strip0x(raw); const start = index * 64; return hex.length >= start + 64 ? `0x${hex.slice(start, start + 64)}` : null; }
function addressWordAt(raw, index) { const word = wordAt(raw, index); if (!word) return null; const hex = strip0x(word).padStart(64, "0"); return /^0+$/.test(hex) ? null : normalizeAddress(`0x${hex.slice(-40)}`); }
function round(value, decimals = 4) { if (value === null || value === undefined) return null; const n = Number(value); if (!Number.isFinite(n)) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function bps(a, b) { if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null; return ((a - b) / b) * 10_000; }
function formatUnitsNumber(raw, decimals) { if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null; try { return Number(ethers.formatUnits(BigInt(raw), Number(decimals))); } catch (_) { return null; } }
function formatUnitsString(raw, decimals) { if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null; try { return ethers.formatUnits(BigInt(raw), Number(decimals)); } catch (_) { return null; } }
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; } }

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: controller.signal });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcUrl() {
  for (const url of [PUBLIC_AVAX_RPC, ...loadRpcUrls()]) {
    try {
      const got = await rpcCall(url, "eth_chainId", [], 6000);
      if (Number(BigInt(got)) !== CHAIN_ID) continue;
      const block = await rpcCall(url, "eth_blockNumber", [], 6000);
      const decimals = await rpcCall(url, "eth_call", [{ to: TOKENS.USDC, data: ERC20.encodeFunctionData("decimals", []) }, "latest"], 6000);
      if (block && decimals && decimals !== "0x") return url;
    } catch (_) {
      // Keep endpoints secret; try next URL.
    }
  }
  return null;
}

async function safeCall(provider, to, iface, name, args = []) {
  const target = normalizeAddress(to);
  if (!target) return { ok: false, error: "invalid target address" };
  try {
    const raw = await provider.call({ to: target, data: iface.encodeFunctionData(name, args) });
    return { ok: true, value: iface.decodeFunctionResult(name, raw), raw };
  } catch (e) {
    return { ok: false, error: sanitizeError(e) };
  }
}

async function safeEthCall(provider, tx) {
  try { return { ok: true, raw: await provider.call(tx) }; } catch (e) { return { ok: false, error: sanitizeError(e) }; }
}

async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
  const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-avalanche-stable-yield/1.0", ...(fetchOptions.headers || {}) }, ...fetchOptions, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPrices(addresses) {
  const keys = [...new Set((addresses || []).map(lowerAddress).filter(Boolean).map((address) => `${CHAIN.coinSlug}:${address}`))];
  const prices = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.slice(i, i + 50).join(",")}?searchWidth=6h`, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    for (const [key, row] of Object.entries(json.coins || {})) {
      const address = lowerAddress(key.split(":").pop());
      const price = Number(row?.price || 0);
      if (address && Number.isFinite(price) && price > 0) prices.set(address, { priceUsd: price, source: "defillama-coins", timestamp: row.timestamp || null, confidence: row.confidence ?? null });
    }
  }
  return prices;
}

async function fetchYieldChart(poolId) {
  const json = await fetchJson(`https://yields.llama.fi/chart/${poolId}`, { timeoutMs: 30_000 }).catch(() => null);
  const rows = Array.isArray(json?.data) ? json.data : [];
  const latest = rows[rows.length - 1] || null;
  const recent = rows.slice(-14);
  const maxRecent = Math.max(...recent.map((r) => Number(r.apy || 0)).filter(Number.isFinite), 0);
  return {
    poolId,
    rows: rows.length,
    latest: latest ? {
      timestamp: latest.timestamp,
      tvlUsd: Number(latest.tvlUsd || 0),
      apy: Number(latest.apy || 0),
      apyBase: Number(latest.apyBase || 0),
      apyReward: Number(latest.apyReward || 0),
    } : null,
    recentMaxApy: maxRecent,
    rewardOnly: Boolean(latest && Number(latest.apyBase || 0) === 0 && Number(latest.apyReward || 0) > 0),
  };
}

async function fetchDexPair(pool) {
  const json = await fetchJson(`https://api.dexscreener.com/latest/dex/pairs/avalanche/${pool.pair}`, { timeoutMs: 20_000 }).catch(() => null);
  const pair = json?.pair || (Array.isArray(json?.pairs) ? json.pairs[0] : null);
  if (!pair) return { pairAddress: pool.pair, error: "DexScreener pair missing" };
  const baseAmount = Number(pair.liquidity?.base || 0);
  const quoteAmount = Number(pair.liquidity?.quote || 0);
  const priceUsd = pair.priceUsd ? Number(pair.priceUsd) : null;
  const quotePriceUsd = pair.priceNative && priceUsd ? priceUsd / Number(pair.priceNative || 1) : null;
  const baseValueUsd = Number.isFinite(baseAmount) && Number.isFinite(priceUsd) ? baseAmount * priceUsd : null;
  const quoteValueUsd = Number.isFinite(quoteAmount) && Number.isFinite(quotePriceUsd) ? quoteAmount * quotePriceUsd : null;
  const sideImbalanceRatio = Number.isFinite(baseValueUsd) && Number.isFinite(quoteValueUsd) && Math.max(baseValueUsd, quoteValueUsd) > 0
    ? Math.min(baseValueUsd, quoteValueUsd) / Math.max(baseValueUsd, quoteValueUsd)
    : null;
  return {
    chainId: pair.chainId || "avalanche",
    dexId: pair.dexId || null,
    pairAddress: pair.pairAddress || pool.pair,
    labels: pair.labels || [],
    priceUsd,
    priceNative: pair.priceNative ? Number(pair.priceNative) : null,
    liquidityUsd: pair.liquidity?.usd ? Number(pair.liquidity.usd) : null,
    liquidityBase: Number.isFinite(baseAmount) ? baseAmount : null,
    liquidityQuote: Number.isFinite(quoteAmount) ? quoteAmount : null,
    baseValueUsd,
    quoteValueUsd,
    sideImbalanceRatio,
    oneSided: sideImbalanceRatio !== null && sideImbalanceRatio < 0.05,
    volume24hUsd: pair.volume?.h24 ? Number(pair.volume.h24) : null,
    txns24h: pair.txns?.h24 || null,
    priceChange24hPct: pair.priceChange?.h24 ?? null,
    fdv: pair.fdv ? Number(pair.fdv) : null,
    baseToken: pair.baseToken ? { address: normalizeAddress(pair.baseToken.address), symbol: pair.baseToken.symbol } : null,
    quoteToken: pair.quoteToken ? { address: normalizeAddress(pair.quoteToken.address), symbol: pair.quoteToken.symbol } : null,
    url: pair.url || null,
  };
}

async function tokenMeta(provider, address, prices = new Map()) {
  const token = normalizeAddress(address);
  const [code, symbol, name, decimals, supply] = await Promise.all([
    provider.getCode(token).catch(() => "0x"),
    safeCall(provider, token, ERC20, "symbol"),
    safeCall(provider, token, ERC20, "name"),
    safeCall(provider, token, ERC20, "decimals"),
    safeCall(provider, token, ERC20, "totalSupply"),
  ]);
  const dec = decimals.ok ? Number(decimals.value[0]) : null;
  const supplyRaw = supply.ok ? supply.value[0] : null;
  const price = prices.get(lowerAddress(token)) || null;
  return {
    address: token,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    symbol: symbol.ok ? String(symbol.value[0]) : null,
    name: name.ok ? String(name.value[0]) : null,
    decimals: dec,
    totalSupplyRaw: supplyRaw,
    totalSupply: formatUnitsString(supplyRaw, dec),
    priceUsd: price?.priceUsd || null,
    priceSource: price?.source || null,
  };
}

function slotAddress(value) { const hex = strip0x(value).padStart(64, "0"); return /^0+$/.test(hex) ? null : normalizeAddress(`0x${hex.slice(-40)}`); }
async function proxySlots(provider, address) {
  const [impl, admin, beacon] = await Promise.all([
    provider.getStorage(address, EIP1967_IMPL_SLOT).catch(() => null),
    provider.getStorage(address, EIP1967_ADMIN_SLOT).catch(() => null),
    provider.getStorage(address, EIP1967_BEACON_SLOT).catch(() => null),
  ]);
  return { eip1967Implementation: slotAddress(impl), eip1967Admin: slotAddress(admin), eip1967Beacon: slotAddress(beacon) };
}

async function scanPoolOnchain(provider, pool) {
  const [token0, token1, fee, liquidity, slot0, reserves, stable] = await Promise.all([
    safeCall(provider, pool.pair, SLIPSTREAM_POOL, "token0"),
    safeCall(provider, pool.pair, SLIPSTREAM_POOL, "token1"),
    safeCall(provider, pool.pair, SLIPSTREAM_POOL, "fee"),
    safeCall(provider, pool.pair, SLIPSTREAM_POOL, "liquidity"),
    safeCall(provider, pool.pair, SLIPSTREAM_POOL, "slot0"),
    safeCall(provider, pool.pair, V2_PAIR, "getReserves"),
    safeCall(provider, pool.pair, V2_PAIR, "stable"),
  ]);
  return {
    address: pool.pair,
    token0: token0.ok ? normalizeAddress(token0.value[0]) : null,
    token1: token1.ok ? normalizeAddress(token1.value[0]) : null,
    fee: fee.ok ? Number(fee.value[0]) : null,
    liquidityRaw: liquidity.ok ? liquidity.value[0] : null,
    slot0: slot0.ok ? { sqrtPriceX96: slot0.value[0], tick: Number(slot0.value[1]), unlocked: Boolean(slot0.value[5]) } : null,
    v2Reserves: reserves.ok ? { reserve0: reserves.value[0], reserve1: reserves.value[1], blockTimestampLast: Number(reserves.value[2]) } : null,
    stable: stable.ok ? Boolean(stable.value[0]) : null,
    errors: { slot0: slot0.error || null, getReserves: reserves.error || null, stable: stable.error || null },
  };
}

async function scanErc4626(provider, token, meta) {
  const oneShare = meta?.decimals !== null && meta?.decimals !== undefined ? 10n ** BigInt(meta.decimals) : 10n ** 18n;
  const [asset, totalAssets, convertToAssets, convertToShares, maxRedeem, maxWithdraw, previewRedeem, cooldownDuration, silo] = await Promise.all([
    safeCall(provider, token, ERC4626, "asset"),
    safeCall(provider, token, ERC4626, "totalAssets"),
    safeCall(provider, token, ERC4626, "convertToAssets", [oneShare]),
    safeCall(provider, token, ERC4626, "convertToShares", [oneShare]),
    safeCall(provider, token, ERC4626, "maxRedeem", [PROBE_FROM]),
    safeCall(provider, token, ERC4626, "maxWithdraw", [PROBE_FROM]),
    safeCall(provider, token, ERC4626, "previewRedeem", [oneShare]),
    safeCall(provider, token, ERC4626, "cooldownDuration"),
    safeCall(provider, token, ERC4626, "silo"),
  ]);
  const assetAddress = asset.ok ? normalizeAddress(asset.value[0]) : null;
  return {
    isErc4626Like: Boolean(asset.ok && convertToAssets.ok),
    asset: assetAddress,
    totalAssetsRaw: totalAssets.ok ? totalAssets.value[0] : null,
    totalAssets: totalAssets.ok ? formatUnitsString(totalAssets.value[0], meta?.decimals ?? 18) : null,
    oneShareToAssetsRaw: convertToAssets.ok ? convertToAssets.value[0] : null,
    oneShareToAssets: convertToAssets.ok ? formatUnitsNumber(convertToAssets.value[0], meta?.decimals ?? 18) : null,
    oneAssetToSharesRaw: convertToShares.ok ? convertToShares.value[0] : null,
    maxRedeemProbeRaw: maxRedeem.ok ? maxRedeem.value[0] : null,
    maxWithdrawProbeRaw: maxWithdraw.ok ? maxWithdraw.value[0] : null,
    previewRedeemOneShareRaw: previewRedeem.ok ? previewRedeem.value[0] : null,
    cooldownDuration: cooldownDuration.ok ? Number(cooldownDuration.value[0]) : null,
    silo: silo.ok ? normalizeAddress(silo.value[0]) : null,
    errors: {
      asset: asset.error || null,
      totalAssets: totalAssets.error || null,
      convertToAssets: convertToAssets.error || null,
      cooldownDuration: cooldownDuration.error || null,
    },
  };
}

async function scanTokenControls(provider, token, prices) {
  const [meta, slots, owner, minter, masterMinter, pauser, blacklister, ccipAdmin, defaultAdminRole, minterRole, burnerRole] = await Promise.all([
    tokenMeta(provider, token, prices),
    proxySlots(provider, token),
    safeCall(provider, token, TOKEN_CONTROL, "owner"),
    safeCall(provider, token, TOKEN_CONTROL, "minter"),
    safeCall(provider, token, TOKEN_CONTROL, "masterMinter"),
    safeCall(provider, token, TOKEN_CONTROL, "pauser"),
    safeCall(provider, token, TOKEN_CONTROL, "blacklister"),
    safeCall(provider, token, TOKEN_CONTROL, "getCCIPAdmin"),
    safeCall(provider, token, TOKEN_CONTROL, "DEFAULT_ADMIN_ROLE"),
    safeCall(provider, token, TOKEN_CONTROL, "MINTER_ROLE"),
    safeCall(provider, token, TOKEN_CONTROL, "BURNER_ROLE"),
  ]);
  async function hasRole(roleResult, account) {
    const target = normalizeAddress(account);
    if (!roleResult.ok || !target) return null;
    const result = await safeCall(provider, token, TOKEN_CONTROL, "hasRole", [roleResult.value[0], target]);
    return result.ok ? Boolean(result.value[0]) : null;
  }
  const probes = [
    [TOKEN_CONTROL, "mint(address,uint256)", [PROBE_FROM, 1n]],
    [TOKEN_CONTROL, "mint(uint256,address)", [1n, PROBE_FROM]],
    [TOKEN_CONTROL, "burn(uint256)", [1n]],
    [TOKEN_CONTROL, "burnFrom(address,uint256)", [PROBE_FROM, 1n]],
    [ERC4626, "redeem(uint256,address,address)", [1n, PROBE_FROM, PROBE_FROM]],
    [ERC4626, "withdraw(uint256,address,address)", [1n, PROBE_FROM, PROBE_FROM]],
    [ERC4626, "cooldownAssets(uint256)", [1n]],
    [ERC4626, "cooldownShares(uint256)", [1n]],
    [ERC4626, "unstake(address)", [PROBE_FROM]],
  ];
  const arbitrarySenderProbes = {};
  for (const [iface, signature, args] of probes) {
    const call = await safeEthCall(provider, { from: PROBE_FROM, to: token, data: iface.encodeFunctionData(signature, args) });
    arbitrarySenderProbes[signature] = { ok: call.ok, error: call.error || null };
  }
  const adminAccounts = {
    owner: owner.ok ? normalizeAddress(owner.value[0]) : null,
    minter: minter.ok ? normalizeAddress(minter.value[0]) : null,
    masterMinter: masterMinter.ok ? normalizeAddress(masterMinter.value[0]) : null,
    pauser: pauser.ok ? normalizeAddress(pauser.value[0]) : null,
    blacklister: blacklister.ok ? normalizeAddress(blacklister.value[0]) : null,
    ccipAdmin: ccipAdmin.ok ? normalizeAddress(ccipAdmin.value[0]) : null,
  };
  return {
    token: meta,
    proxy: slots,
    erc4626: await scanErc4626(provider, token, meta),
    adminAccounts,
    roleChecks: {
      probeIsDefaultAdmin: await hasRole(defaultAdminRole, PROBE_FROM),
      probeIsMinter: await hasRole(minterRole, PROBE_FROM),
      probeIsBurner: await hasRole(burnerRole, PROBE_FROM),
      ownerIsMinter: await hasRole(minterRole, adminAccounts.owner),
      minterIsMinter: await hasRole(minterRole, adminAccounts.minter),
    },
    arbitrarySenderProbes,
    errors: {
      owner: owner.error || null,
      minter: minter.error || null,
      masterMinter: masterMinter.error || null,
      pauser: pauser.error || null,
      blacklister: blacklister.error || null,
      ccipAdmin: ccipAdmin.error || null,
    },
  };
}

function decodeAaveConfig(data) {
  const raw = BigInt(data || 0n);
  const mask16 = 0xffffn;
  const mask36 = (1n << 36n) - 1n;
  return {
    ltv: Number(raw & mask16) / 10_000,
    liquidationThreshold: Number((raw >> 16n) & mask16) / 10_000,
    decimals: Number((raw >> 48n) & 0xffn),
    active: Boolean((raw >> 56n) & 1n),
    frozen: Boolean((raw >> 57n) & 1n),
    borrowingEnabled: Boolean((raw >> 58n) & 1n),
    paused: Boolean((raw >> 60n) & 1n),
    borrowCapWholeTokens: Number((raw >> 80n) & mask36),
    supplyCapWholeTokens: Number((raw >> 116n) & mask36),
    eModeCategoryId: Number((raw >> 168n) & 0xffn),
  };
}

async function erc20Balance(provider, token, account, decimals = null) {
  const raw = await safeCall(provider, token, ERC20, "balanceOf", [account]);
  const value = raw.ok ? raw.value[0] : null;
  return { raw: value, formatted: formatUnitsString(value, decimals), number: formatUnitsNumber(value, decimals), error: raw.error || null };
}

function lendingBlockers(edgeBps, borrowCashUsd, config, extra = []) {
  const blockers = [...extra];
  if (edgeBps === null || edgeBps < MIN_ROUTE_EDGE_BPS) blockers.push("LTV/LLTV-adjusted borrowable value is below market cost plus edge threshold");
  if (!Number.isFinite(borrowCashUsd) || borrowCashUsd < MIN_BORROW_CASH_USD) blockers.push("borrow cash below route threshold");
  if (!config?.active) blockers.push("reserve/market inactive or not listed");
  if (config?.paused) blockers.push("reserve/market paused");
  if (config?.frozen) blockers.push("reserve/market frozen");
  if (!Number(config?.ltv || 0)) blockers.push("collateral LTV is zero");
  return [...new Set(blockers)];
}

async function scanAaveReserve(provider, pool, asset, listed, priceUsd, prices) {
  const raw = await safeCall(provider, pool, AAVE_POOL, "getReserveData", [asset]);
  if (!raw.ok) return { asset: normalizeAddress(asset), listed: false, error: raw.error };
  const config = decodeAaveConfig(BigInt(wordAt(raw.raw, 0) || 0n));
  const aToken = addressWordAt(raw.raw, 8);
  const meta = await tokenMeta(provider, asset, prices).catch(() => ({ decimals: config.decimals || null }));
  const decimals = config.decimals || meta.decimals;
  const cash = aToken ? await erc20Balance(provider, asset, aToken, decimals) : { raw: null, number: null, formatted: null };
  return { asset: normalizeAddress(asset), listed, token: meta, config, aToken, cashRaw: cash.raw, cash: cash.formatted, cashUsd: Number.isFinite(cash.number) && Number.isFinite(priceUsd) ? cash.number * priceUsd : null };
}

async function scanAave(provider, marketPrices, prices) {
  const [poolRaw, oracleRaw] = await Promise.all([
    safeCall(provider, AAVE_ADDRESSES_PROVIDER, AAVE_PROVIDER, "getPool"),
    safeCall(provider, AAVE_ADDRESSES_PROVIDER, AAVE_PROVIDER, "getPriceOracle"),
  ]);
  const pool = poolRaw.ok ? normalizeAddress(poolRaw.value[0]) : null;
  const oracle = oracleRaw.ok ? normalizeAddress(oracleRaw.value[0]) : null;
  if (!pool || !oracle) return { pool, oracle, error: "Aave pool/oracle resolution failed", rows: [], summary: { watchCandidates: 0, routePositive: 0 } };
  const reservesRaw = await safeCall(provider, pool, AAVE_POOL, "getReservesList");
  const reserves = reservesRaw.ok ? [...reservesRaw.value[0]].map(normalizeAddress).filter(Boolean) : [];
  const unit = await safeCall(provider, oracle, AAVE_ORACLE, "BASE_CURRENCY_UNIT");
  const oracleUnit = unit.ok ? Number(unit.value[0]) : 1e8;
  const usdcReserve = await scanAaveReserve(provider, pool, TOKENS.USDC, reserves.map((x) => x.toLowerCase()).includes(lowerAddress(TOKENS.USDC)), prices.get(lowerAddress(TOKENS.USDC))?.priceUsd, prices);
  const usdtReserve = await scanAaveReserve(provider, pool, TOKENS.USDT, reserves.map((x) => x.toLowerCase()).includes(lowerAddress(TOKENS.USDT)), prices.get(lowerAddress(TOKENS.USDT))?.priceUsd, prices);
  const borrowCashUsd = Math.max(Number(usdcReserve.cashUsd || 0), Number(usdtReserve.cashUsd || 0));
  const rows = [];
  for (const asset of [TOKENS.USDT, TOKENS.sUSDe, TOKENS.USDe]) {
    const listed = reserves.map((x) => x.toLowerCase()).includes(lowerAddress(asset));
    const reserve = await scanAaveReserve(provider, pool, asset, listed, marketPrices.get(lowerAddress(asset)) || prices.get(lowerAddress(asset))?.priceUsd, prices);
    const price = await safeCall(provider, oracle, AAVE_ORACLE, "getAssetPrice", [asset]);
    const source = await safeCall(provider, oracle, AAVE_ORACLE, "getSourceOfAsset", [asset]);
    const oracleUsd = price.ok && oracleUnit ? Number(price.value[0]) / oracleUnit : null;
    const eModeRaw = reserve.config?.eModeCategoryId ? await safeCall(provider, pool, AAVE_POOL, "getEModeCategoryData", [reserve.config.eModeCategoryId]) : { ok: false };
    const eModeData = eModeRaw.ok ? eModeRaw.value[0] : null;
    const eMode = eModeData ? {
      id: reserve.config.eModeCategoryId,
      ltv: Number(eModeData.ltv ?? eModeData[0]) / 10_000,
      liquidationThreshold: Number(eModeData.liquidationThreshold ?? eModeData[1]) / 10_000,
      liquidationBonus: Number(eModeData.liquidationBonus ?? eModeData[2]) / 10_000,
      priceSource: normalizeAddress(eModeData.priceSource ?? eModeData[3]),
      label: String((eModeData.label ?? eModeData[4]) || ""),
    } : null;
    const effectiveLtv = eMode?.ltv || reserve.config?.ltv || 0;
    const marketPriceUsd = marketPrices.get(lowerAddress(asset)) || prices.get(lowerAddress(asset))?.priceUsd || null;
    const borrowablePerTokenUsd = Number.isFinite(oracleUsd) ? oracleUsd * effectiveLtv : null;
    const edgeBps = bps(borrowablePerTokenUsd, marketPriceUsd);
    const routePositive = Boolean(listed && edgeBps !== null && edgeBps >= MIN_ROUTE_EDGE_BPS && borrowCashUsd >= MIN_BORROW_CASH_USD && reserve.config?.active && !reserve.config?.paused && !reserve.config?.frozen && effectiveLtv > 0);
    rows.push({
      asset,
      symbol: reserve.token?.symbol || null,
      listed,
      reserve,
      oraclePriceRaw: price.ok ? price.value[0] : null,
      oraclePriceUsd: oracleUsd,
      sourceOfAsset: source.ok ? normalizeAddress(source.value[0]) : null,
      eMode,
      routeModel: {
        route: `buy ${reserve.token?.symbol || "asset"} -> supply Aave V3 Avalanche -> borrow USDC/USDt`,
        marketPriceUsd,
        effectiveLtv,
        borrowablePerTokenUsd,
        edgeBps,
        bestBorrowCashUsd: borrowCashUsd,
        watchCandidate: Boolean(listed && effectiveLtv > 0),
        routePositive,
        blockers: routePositive ? [] : lendingBlockers(edgeBps, borrowCashUsd, reserve.config, listed ? [] : [`${reserve.token?.symbol || asset} is not in Aave Avalanche reserves list`]),
      },
    });
  }
  return { pool, oracle, reservesListed: reserves.length, borrowReserves: { USDC: usdcReserve, USDT: usdtReserve }, rows, summary: { watchCandidates: rows.filter((r) => r.routeModel.watchCandidate).length, routePositive: rows.filter((r) => r.routeModel.routePositive).length } };
}

function benqiOracleUsd(raw, underlyingDecimals) {
  if (raw === null || raw === undefined || underlyingDecimals === null || underlyingDecimals === undefined) return null;
  try { return Number(ethers.formatUnits(BigInt(raw), 36 - Number(underlyingDecimals))); } catch (_) { return null; }
}

async function scanBenQi(provider, marketPrices, prices) {
  const [oracleRaw, marketsRaw] = await Promise.all([
    safeCall(provider, BENQI_COMPTROLLER, BENQI_COMP, "oracle"),
    safeCall(provider, BENQI_COMPTROLLER, BENQI_COMP, "getAllMarkets"),
  ]);
  const oracle = oracleRaw.ok ? normalizeAddress(oracleRaw.value[0]) : null;
  const qTokens = marketsRaw.ok ? [...marketsRaw.value[0]].map(normalizeAddress).filter(Boolean) : [];
  const allRows = [];
  for (const qToken of qTokens) {
    const [symbol, name, qDecimalsRaw, underlyingRaw, marketRaw, cashRaw, borrowsRaw, priceRaw, mintPausedRaw, borrowPausedRaw] = await Promise.all([
      safeCall(provider, qToken, BENQI_QTOKEN, "symbol"),
      safeCall(provider, qToken, BENQI_QTOKEN, "name"),
      safeCall(provider, qToken, BENQI_QTOKEN, "decimals"),
      safeCall(provider, qToken, BENQI_QTOKEN, "underlying"),
      safeCall(provider, BENQI_COMPTROLLER, BENQI_COMP, "markets", [qToken]),
      safeCall(provider, qToken, BENQI_QTOKEN, "getCash"),
      safeCall(provider, qToken, BENQI_QTOKEN, "totalBorrows"),
      oracle ? safeCall(provider, oracle, BENQI_ORACLE, "getUnderlyingPrice", [qToken]) : { ok: false },
      safeCall(provider, BENQI_COMPTROLLER, BENQI_COMP, "mintGuardianPaused", [qToken]),
      safeCall(provider, BENQI_COMPTROLLER, BENQI_COMP, "borrowGuardianPaused", [qToken]),
    ]);
    const underlying = underlyingRaw.ok ? normalizeAddress(underlyingRaw.value[0]) : null;
    if (!underlying) continue;
    const meta = await tokenMeta(provider, underlying, prices).catch(() => ({ address: underlying, decimals: 18 }));
    const cash = cashRaw.ok ? formatUnitsNumber(cashRaw.value[0], meta.decimals) : null;
    const borrows = borrowsRaw.ok ? formatUnitsNumber(borrowsRaw.value[0], meta.decimals) : null;
    const underlyingPrice = prices.get(lowerAddress(underlying))?.priceUsd || marketPrices.get(lowerAddress(underlying)) || null;
    allRows.push({
      qToken,
      qSymbol: symbol.ok ? String(symbol.value[0]) : null,
      qName: name.ok ? String(name.value[0]) : null,
      qDecimals: qDecimalsRaw.ok ? Number(qDecimalsRaw.value[0]) : null,
      underlying: meta,
      isListed: marketRaw.ok ? Boolean(marketRaw.value[0]) : false,
      collateralFactor: marketRaw.ok ? Number(ethers.formatUnits(marketRaw.value[1], 18)) : 0,
      mintPaused: mintPausedRaw.ok ? Boolean(mintPausedRaw.value[0]) : null,
      borrowPaused: borrowPausedRaw.ok ? Boolean(borrowPausedRaw.value[0]) : null,
      cashRaw: cashRaw.ok ? cashRaw.value[0] : null,
      cash,
      cashUsd: Number.isFinite(cash) && Number.isFinite(underlyingPrice) ? cash * underlyingPrice : null,
      totalBorrowsRaw: borrowsRaw.ok ? borrowsRaw.value[0] : null,
      totalBorrows: borrows,
      oraclePriceRaw: priceRaw.ok ? priceRaw.value[0] : null,
      oraclePriceUsd: priceRaw.ok ? benqiOracleUsd(priceRaw.value[0], meta.decimals) : null,
    });
  }
  const borrowCashUsd = allRows.filter((r) => r.isListed && !r.borrowPaused).reduce((sum, r) => sum + Number(r.cashUsd || 0), 0);
  const targetSet = new Set([lowerAddress(TOKENS.USDT), lowerAddress(TOKENS.sUSDe), lowerAddress(TOKENS.USDe)]);
  const rows = allRows.filter((r) => targetSet.has(lowerAddress(r.underlying.address))).map((row) => {
    const marketPriceUsd = marketPrices.get(lowerAddress(row.underlying.address)) || prices.get(lowerAddress(row.underlying.address))?.priceUsd || null;
    const borrowablePerTokenUsd = Number.isFinite(row.oraclePriceUsd) ? row.oraclePriceUsd * row.collateralFactor : null;
    const edgeBps = bps(borrowablePerTokenUsd, marketPriceUsd);
    const routePositive = Boolean(row.isListed && !row.mintPaused && edgeBps !== null && edgeBps >= MIN_ROUTE_EDGE_BPS && borrowCashUsd >= MIN_BORROW_CASH_USD && row.collateralFactor > 0);
    return {
      ...row,
      routeModel: {
        route: `buy ${row.underlying.symbol || "asset"} -> supply BenQi -> borrow available assets`,
        marketPriceUsd,
        borrowablePerTokenUsd,
        edgeBps,
        bestBorrowCashUsd: borrowCashUsd,
        watchCandidate: Boolean(row.isListed && row.collateralFactor > 0),
        routePositive,
        blockers: routePositive ? [] : lendingBlockers(edgeBps, borrowCashUsd, { active: row.isListed, paused: row.mintPaused, frozen: false, ltv: row.collateralFactor }, row.isListed ? [] : [`${row.underlying.symbol || row.underlying.address} is not listed on BenQi`]),
      },
    };
  });
  return { comptroller: BENQI_COMPTROLLER, oracle, marketsScanned: allRows.length, rows, summary: { watchCandidates: rows.filter((r) => r.routeModel.watchCandidate).length, routePositive: rows.filter((r) => r.routeModel.routePositive).length } };
}

async function morphoQuery(query, variables) {
  const json = await fetchJson("https://api.morpho.org/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }), timeoutMs: 30_000 });
  if (json.errors) throw new Error(json.errors[0]?.message || "Morpho GraphQL error");
  return json.data || {};
}

function morphoLltvRatio(value) { try { return Number(BigInt(String(value || 0))) / 1e18; } catch (_) { return Number(value || 0); } }
function morphoLoanPerCollateral(priceRaw, collateralDecimals, loanDecimals) {
  if (priceRaw === null || priceRaw === undefined || collateralDecimals === null || loanDecimals === null) return null;
  try { return formatUnitsNumber((10n ** BigInt(collateralDecimals)) * BigInt(priceRaw) / (10n ** 36n), loanDecimals); } catch (_) { return null; }
}

async function scanMorpho(provider, marketPrices, prices) {
  const assets = [TOKENS.USDT, TOKENS.sUSDe, TOKENS.USDe];
  const query = `query($chainIds:[Int!]!, $assets:[String!]!) {
    collateral: markets(first:${MORPHO_FIRST}, orderBy:SupplyAssetsUsd, orderDirection:Desc,
      where:{chainId_in:$chainIds, collateralAssetAddress_in:$assets}) { items { marketId loanAsset { symbol address decimals } collateralAsset { symbol address decimals } oracle { address } lltv state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization } } }
    loan: markets(first:${MORPHO_FIRST}, orderBy:SupplyAssetsUsd, orderDirection:Desc,
      where:{chainId_in:$chainIds, loanAssetAddress_in:$assets}) { items { marketId loanAsset { symbol address decimals } collateralAsset { symbol address decimals } oracle { address } lltv state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization } } }
  }`;
  let data;
  try { data = await morphoQuery(query, { chainIds: [CHAIN_ID], assets }); } catch (e) { return { error: sanitizeError(e), collateralMarkets: [], loanMarkets: [], summary: { collateralMarkets: 0, loanMarkets: 0, routePositive: 0, watchCandidates: 0 } }; }
  async function enrich(market, side) {
    const lltv = morphoLltvRatio(market.lltv);
    const oracle = normalizeAddress(market.oracle?.address);
    const oracleRaw = side === "collateral" && oracle ? await safeCall(provider, oracle, MORPHO_ORACLE, "price") : { ok: false };
    const loan = market.loanAsset || {};
    const collateral = market.collateralAsset || {};
    const loanPrice = prices.get(lowerAddress(loan.address))?.priceUsd || null;
    const collateralMarketPrice = marketPrices.get(lowerAddress(collateral.address)) || prices.get(lowerAddress(collateral.address))?.priceUsd || null;
    const loanPerCollateral = side === "collateral" && oracleRaw.ok ? morphoLoanPerCollateral(oracleRaw.value[0], Number(collateral.decimals ?? 18), Number(loan.decimals ?? 18)) : null;
    const borrowablePerTokenUsd = Number.isFinite(loanPerCollateral) && Number.isFinite(loanPrice) ? loanPerCollateral * loanPrice * lltv : null;
    const edgeBps = bps(borrowablePerTokenUsd, collateralMarketPrice);
    const liquidityUsd = Number(market.state?.liquidityAssetsUsd || 0);
    const routePositive = Boolean(side === "collateral" && edgeBps !== null && edgeBps >= MIN_ROUTE_EDGE_BPS && liquidityUsd >= MIN_BORROW_CASH_USD);
    const blockers = [];
    if (side !== "collateral") blockers.push("target asset is loan asset, not collateral for borrow extraction");
    if (!oracleRaw.ok && side === "collateral") blockers.push("Morpho oracle price() not decoded; fail closed");
    if (side === "collateral" && (edgeBps === null || edgeBps < MIN_ROUTE_EDGE_BPS)) blockers.push("LLTV-adjusted oracle value is below market cost plus edge threshold");
    if (liquidityUsd < MIN_BORROW_CASH_USD) blockers.push("borrow liquidity below route threshold");
    return { side, marketId: market.marketId, loanAsset: { symbol: loan.symbol || null, address: normalizeAddress(loan.address), decimals: loan.decimals ?? null, priceUsd: loanPrice }, collateralAsset: { symbol: collateral.symbol || null, address: normalizeAddress(collateral.address), decimals: collateral.decimals ?? null }, oracle, lltv, state: { supplyAssetsUsd: Number(market.state?.supplyAssetsUsd || 0), borrowAssetsUsd: Number(market.state?.borrowAssetsUsd || 0), liquidityAssetsUsd: liquidityUsd, utilization: market.state?.utilization ?? null }, oraclePriceRaw: oracleRaw.ok ? oracleRaw.value[0] : null, loanPerCollateral, routeModel: { route: side === "collateral" ? `buy ${collateral.symbol || "target"} -> supply Morpho -> borrow ${loan.symbol || "loan asset"}` : "loan-side mapping only", marketPriceUsd: collateralMarketPrice, borrowablePerTokenUsd, edgeBps, watchCandidate: side === "collateral", routePositive, blockers: [...new Set(blockers)] } };
  }
  const collateralMarkets = await Promise.all((data.collateral?.items || []).map((m) => enrich(m, "collateral")));
  const loanMarkets = await Promise.all((data.loan?.items || []).map((m) => enrich(m, "loan")));
  return { collateralMarkets, loanMarkets, summary: { collateralMarkets: collateralMarkets.length, loanMarkets: loanMarkets.length, watchCandidates: collateralMarkets.filter((m) => m.routeModel.watchCandidate).length, routePositive: collateralMarkets.filter((m) => m.routeModel.routePositive).length, bestCollateralEdgeBps: Math.max(...collateralMarkets.map((m) => Number(m.routeModel.edgeBps)).filter(Number.isFinite), -Infinity) } };
}

function loadSiloFactory() {
  const json = readJson(path.join(SILO_DEPLOYMENTS, "SiloFactory.sol.json"), null);
  return normalizeAddress(json?.address || json?.deployedTo || json?.contractAddress);
}

function parseSiloConfig(decoded) {
  const row = decoded?.[0];
  if (!row) return null;
  const silo = normalizeAddress(row[2]);
  const token = normalizeAddress(row[3]);
  if (!silo || !token) return null;
  return { silo, token, solvencyOracle: normalizeAddress(row[7]), maxLtvOracle: normalizeAddress(row[8]), maxLtv: Number(row[10] || 0n) / 1e18, lt: Number(row[11] || 0n) / 1e18 };
}

async function scanSilo(provider, prices) {
  const factory = loadSiloFactory();
  if (!factory) return { factory: null, rows: [], summary: { idsScanned: 0, marketsScanned: 0, targetRows: 0, watchCandidates: 0, routePositive: 0 } };
  const nextRaw = await safeCall(provider, factory, SILO_FACTORY, "getNextSiloId");
  const nextId = nextRaw.ok ? nextRaw.value[0] : null;
  if (!nextId) return { factory, rows: [], summary: { idsScanned: 0, marketsScanned: 0, targetRows: 0, watchCandidates: 0, routePositive: 0 }, error: nextRaw.error || null };
  const start = nextId > BigInt(MAX_SILO_IDS) ? nextId - BigInt(MAX_SILO_IDS) : 1n;
  const targetSet = new Set([lowerAddress(TOKENS.USDT), lowerAddress(TOKENS.sUSDe), lowerAddress(TOKENS.USDe)]);
  const rows = [];
  let marketsScanned = 0;
  for (let id = start; id < nextId; id++) {
    const cfgRaw = await safeCall(provider, factory, SILO_FACTORY, "idToSiloConfig", [id]);
    const config = normalizeAddress(cfgRaw.ok ? cfgRaw.value[0] : null);
    if (!config || config === ethers.ZeroAddress) continue;
    const silosRaw = await safeCall(provider, config, SILO_CONFIG, "getSilos");
    const silos = silosRaw.ok ? [normalizeAddress(silosRaw.value[0]), normalizeAddress(silosRaw.value[1])].filter(Boolean) : [];
    if (silos.length < 2) continue;
    const sides = [];
    for (const silo of silos) {
      const [configRaw, liquidityRaw, storageRaw] = await Promise.all([safeCall(provider, config, SILO_CONFIG, "getConfig", [silo]), safeCall(provider, silo, SILO, "getLiquidity"), safeCall(provider, silo, SILO, "getSiloStorage")]);
      const cfg = parseSiloConfig(configRaw.ok ? configRaw.value : null);
      if (!cfg) continue;
      const storage = storageRaw.ok ? storageRaw.value : null;
      sides.push({ ...cfg, id: id.toString(), config, liquidityRaw: liquidityRaw.ok ? liquidityRaw.value[0] : 0n, collateralAssetsRaw: (storage?.[3] || 0n).toString(), debtAssetsRaw: (storage?.[4] || 0n).toString() });
    }
    if (sides.length !== 2) continue;
    marketsScanned++;
    if (!sides.some((side) => targetSet.has(lowerAddress(side.token)))) continue;
    const metas = new Map();
    for (const side of sides) metas.set(lowerAddress(side.token), await tokenMeta(provider, side.token, prices).catch(() => ({ address: side.token, decimals: 18, symbol: null })));
    for (let i = 0; i < sides.length; i++) {
      const side = sides[i];
      const opposite = sides[i === 0 ? 1 : 0];
      if (!targetSet.has(lowerAddress(side.token)) && !targetSet.has(lowerAddress(opposite.token))) continue;
      const sideMeta = metas.get(lowerAddress(side.token));
      const oppositeMeta = metas.get(lowerAddress(opposite.token));
      const oppositeLiquidity = formatUnitsNumber(opposite.liquidityRaw, oppositeMeta?.decimals ?? 18);
      const oppositePrice = prices.get(lowerAddress(opposite.token))?.priceUsd || null;
      const routeLiquidityUsd = Number.isFinite(oppositeLiquidity) && Number.isFinite(oppositePrice) ? oppositeLiquidity * oppositePrice : null;
      const targetIsCollateralSide = targetSet.has(lowerAddress(side.token));
      rows.push({ side: targetIsCollateralSide ? "collateral" : "borrowAsset", protocol: "Silo V3", id: id.toString(), config, silo: side.silo, oppositeSilo: opposite.silo, collateral: sideMeta, borrowAsset: oppositeMeta, solvencyOracle: side.solvencyOracle, maxLtvOracle: side.maxLtvOracle, maxLtv: side.maxLtv, liquidationThreshold: side.lt, routeLiquidityUsd, collateralAssetsRaw: side.collateralAssetsRaw, debtAssetsRaw: side.debtAssetsRaw, routeModel: { route: targetIsCollateralSide ? `buy ${sideMeta?.symbol || "target"} -> supply Silo ${id.toString()} -> borrow ${oppositeMeta?.symbol || "opposite asset"}` : "target borrow-side mapping only", watchCandidate: Boolean(targetIsCollateralSide), routePositive: false, blockers: targetIsCollateralSide ? ["Silo oracle valuation not decoded into executable borrowable value; fail closed", "No fork-positive Silo target route"] : ["target is borrow asset, not collateral route"] } });
    }
  }
  return { factory, rows, summary: { idsScanned: Number(nextId - start), marketsScanned, targetRows: rows.length, watchCandidates: rows.filter((r) => r.routeModel.watchCandidate).length, routePositive: 0 } };
}

function listFilesRecursive(root, out = []) {
  if (!root || !fs.existsSync(root)) return out;
  for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) listFilesRecursive(file, out);
    else out.push(file);
  }
  return out;
}

function localDeploymentReferences() {
  const needles = new Set([TOKENS.USDT, TOKENS.USDC, TOKENS.USDe, TOKENS.sUSDe].map((x) => x.toLowerCase()));
  const refs = [];
  for (const root of LOCAL_REF_ROOTS) {
    for (const file of listFilesRecursive(root)) {
      if (!/\.(json|md|txt)$/i.test(file)) continue;
      const rel = path.relative(WORKSPACE, file).replace(/\\/g, "/");
      if (!/avalanche/i.test(rel)) continue;
      const text = fs.readFileSync(file, "utf8").toLowerCase();
      for (const needle of needles) {
        if (text.includes(needle)) { refs.push(rel); break; }
      }
    }
  }
  return [...new Set(refs)].slice(0, 80);
}

function routeRows(pools, tokenControls, aave, benqi, morpho, silo, prices) {
  const routes = [];
  const usdtPair = pools.usdtUsdc;
  const susdePair = pools.susdeUsdc;
  const usdtPrice = prices.get(lowerAddress(TOKENS.USDT))?.priceUsd || null;
  const usdcPrice = prices.get(lowerAddress(TOKENS.USDC))?.priceUsd || null;
  const susdePrice = prices.get(lowerAddress(TOKENS.sUSDe))?.priceUsd || null;
  const usdtDexEdgeBps = bps(usdtPair?.dexPair?.priceUsd, usdtPrice || usdcPrice || 1);
  const susdeDexEdgeBps = bps(susdePair?.dexPair?.priceUsd, susdePrice);
  const susdeRedeemOpen = Boolean(tokenControls.sUSDe?.arbitrarySenderProbes?.["redeem(uint256,address,address)"]?.ok || tokenControls.sUSDe?.arbitrarySenderProbes?.["withdraw(uint256,address,address)"]?.ok || tokenControls.sUSDe?.arbitrarySenderProbes?.["cooldownAssets(uint256)"]?.ok || tokenControls.sUSDe?.arbitrarySenderProbes?.["cooldownShares(uint256)"]?.ok);
  routes.push({
    id: "usdt-usdc-dex-peg",
    description: "Buy/sell Avalanche USDt against USDC on Pharaoh",
    marketPriceUsd: usdtPair?.dexPair?.priceUsd || null,
    referencePriceUsd: usdtPrice || usdcPrice || null,
    edgeBps: usdtDexEdgeBps,
    routePositive: false,
    watchCandidate: false,
    blockers: [
      usdtDexEdgeBps !== null && Math.abs(usdtDexEdgeBps) >= MIN_ROUTE_EDGE_BPS ? null : "USDt/USDC DEX spread is below route edge threshold",
      usdtPair?.yield?.rewardOnly ? "DefiLlama APY is reward-only (apyBase=0)" : null,
      "No lending/redeem leg turns the small stable spread into extractable profit",
    ].filter(Boolean),
  });
  routes.push({
    id: "susde-dex-nav-exit",
    description: "Buy/sell Avalanche sUSDe against USDC and compare to sUSDe reference/NAV",
    marketPriceUsd: susdePair?.dexPair?.priceUsd || null,
    referencePriceUsd: susdePrice || null,
    edgeBps: susdeDexEdgeBps,
    routePositive: false,
    watchCandidate: false,
    blockers: [
      susdeDexEdgeBps !== null && Math.abs(susdeDexEdgeBps) >= MIN_ROUTE_EDGE_BPS ? null : "sUSDe DEX/reference spread is below route edge threshold",
      susdeRedeemOpen ? "redeem/cooldown probe did not prove positive economics; requires fork before reopening" : "No arbitrary-sender sUSDe redeem/cooldown exit is open/proven",
      susdePair?.dexPair?.oneSided ? "Blackhole pool is extremely one-sided by DexScreener reserves" : null,
      susdePair?.yield?.rewardOnly ? "DefiLlama APY is reward-only (apyBase=0)" : null,
    ].filter(Boolean),
  });
  for (const row of aave.rows || []) routes.push({ id: `aave-${row.symbol || row.asset}`, description: row.routeModel.route, ...row.routeModel });
  for (const row of benqi.rows || []) routes.push({ id: `benqi-${row.qSymbol || row.qToken}`, description: row.routeModel.route, ...row.routeModel });
  for (const market of morpho.collateralMarkets || []) routes.push({ id: `morpho-${market.marketId}`, description: market.routeModel.route, ...market.routeModel });
  for (const market of morpho.loanMarkets || []) routes.push({ id: `morpho-loan-${market.marketId}`, description: market.routeModel.route, ...market.routeModel });
  for (const row of silo.rows || []) routes.push({ id: `silo-${row.id}-${row.side}`, description: row.routeModel.route, ...row.routeModel });
  return routes;
}

async function main() {
  const rpc = await resolveRpcUrl();
  if (!rpc) throw new Error("missing required Avalanche RPC from inventory");
  const provider = new ethers.JsonRpcProvider(rpc, { chainId: CHAIN_ID, name: "avalanche" }, { staticNetwork: true, batchMaxCount: 1 });
  const [blockNumber, latestBlock, prices, usdtYield, susdeYield, usdtDex, susdeDex] = await Promise.all([
    provider.getBlockNumber(),
    provider.getBlock("latest"),
    fetchPrices([TOKENS.USDT, TOKENS.USDC, TOKENS.USDe, TOKENS.sUSDe, TOKENS.WAVAX]),
    fetchYieldChart(POOLS.usdtUsdc.defillamaPoolId),
    fetchYieldChart(POOLS.susdeUsdc.defillamaPoolId),
    fetchDexPair(POOLS.usdtUsdc),
    fetchDexPair(POOLS.susdeUsdc),
  ]);
  const pools = {
    usdtUsdc: { ...POOLS.usdtUsdc, yield: usdtYield, dexPair: usdtDex, onchain: await scanPoolOnchain(provider, POOLS.usdtUsdc) },
    susdeUsdc: { ...POOLS.susdeUsdc, yield: susdeYield, dexPair: susdeDex, onchain: await scanPoolOnchain(provider, POOLS.susdeUsdc) },
  };
  const tokenControls = {
    USDT: await scanTokenControls(provider, TOKENS.USDT, prices),
    USDC: await scanTokenControls(provider, TOKENS.USDC, prices),
    USDe: await scanTokenControls(provider, TOKENS.USDe, prices),
    sUSDe: await scanTokenControls(provider, TOKENS.sUSDe, prices),
  };
  const marketPrices = new Map([
    [lowerAddress(TOKENS.USDT), pools.usdtUsdc.dexPair?.priceUsd || prices.get(lowerAddress(TOKENS.USDT))?.priceUsd || null],
    [lowerAddress(TOKENS.USDC), prices.get(lowerAddress(TOKENS.USDC))?.priceUsd || 1],
    [lowerAddress(TOKENS.sUSDe), pools.susdeUsdc.dexPair?.priceUsd || prices.get(lowerAddress(TOKENS.sUSDe))?.priceUsd || null],
    [lowerAddress(TOKENS.USDe), prices.get(lowerAddress(TOKENS.USDe))?.priceUsd || 1],
  ]);
  const [aave, benqiSeed, morphoSeed, silo] = await Promise.all([
    scanAave(provider, marketPrices, prices),
    scanBenQi(provider, marketPrices, prices),
    scanMorpho(provider, marketPrices, prices),
    scanSilo(provider, prices),
  ]);
  const morphoLoanAssets = [...(morphoSeed.collateralMarkets || []), ...(morphoSeed.loanMarkets || [])].map((m) => m.loanAsset?.address).filter(Boolean);
  if (morphoLoanAssets.length) {
    const expandedPrices = await fetchPrices([...morphoLoanAssets]);
    for (const [key, value] of expandedPrices.entries()) prices.set(key, value);
  }
  const morpho = morphoLoanAssets.length ? await scanMorpho(provider, marketPrices, prices) : morphoSeed;
  const benqi = benqiSeed;
  const refs = localDeploymentReferences();
  const routes = routeRows(pools, tokenControls, aave, benqi, morpho, silo, prices);
  const routePositive = routes.filter((r) => r.routePositive === true).length;
  const watchCandidates = routes.filter((r) => r.watchCandidate === true).length;
  const lendingEdges = routes.map((r) => r.edgeBps).filter((v) => v !== null && v !== undefined).map(Number).filter(Number.isFinite);
  const bestLendingEdgeBps = lendingEdges.length ? Math.max(...lendingEdges) : -Infinity;
  const out = {
    generatedAt: new Date().toISOString(),
    scope: "Avalanche high-APY stable pool DEX/redeemability/consumer route scan",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, signedActions: false, exploitExecuteCalls: false, routePositive: routePositive > 0, signedActionJustified: false },
    chainBlocks: { avalanche: blockNumber, timestamp: latestBlock?.timestamp ? Number(latestBlock.timestamp) : null },
    thresholds: { minRouteEdgeBps: MIN_ROUTE_EDGE_BPS, minBorrowCashUsd: MIN_BORROW_CASH_USD, maxSiloIds: MAX_SILO_IDS, morphoFirst: MORPHO_FIRST },
    summary: {
      usdtUsdcApy: round(usdtYield.latest?.apy, 4),
      usdtUsdcApyBase: round(usdtYield.latest?.apyBase, 4),
      usdtUsdcApyReward: round(usdtYield.latest?.apyReward, 4),
      usdtUsdcRewardOnly: usdtYield.rewardOnly,
      usdtDexPriceUsd: round(pools.usdtUsdc.dexPair?.priceUsd, 8),
      usdtReferencePriceUsd: round(prices.get(lowerAddress(TOKENS.USDT))?.priceUsd, 8),
      usdtDexVsReferenceBps: round(bps(pools.usdtUsdc.dexPair?.priceUsd, prices.get(lowerAddress(TOKENS.USDT))?.priceUsd), 2),
      susdeUsdcApy: round(susdeYield.latest?.apy, 4),
      susdeUsdcApyBase: round(susdeYield.latest?.apyBase, 4),
      susdeUsdcApyReward: round(susdeYield.latest?.apyReward, 4),
      susdeUsdcRewardOnly: susdeYield.rewardOnly,
      susdeDexPriceUsd: round(pools.susdeUsdc.dexPair?.priceUsd, 8),
      susdeReferencePriceUsd: round(prices.get(lowerAddress(TOKENS.sUSDe))?.priceUsd, 8),
      susdeDexVsReferenceBps: round(bps(pools.susdeUsdc.dexPair?.priceUsd, prices.get(lowerAddress(TOKENS.sUSDe))?.priceUsd), 2),
      susdePoolOneSided: pools.susdeUsdc.dexPair?.oneSided ?? null,
      aaveRows: aave.rows?.length || 0,
      benqiRows: benqi.rows?.length || 0,
      morphoCollateralMarkets: morpho.summary.collateralMarkets,
      morphoLoanMarkets: morpho.summary.loanMarkets,
      siloTargetRows: silo.summary.targetRows,
      localDeploymentReferences: refs.length,
      bestRouteEdgeBps: Number.isFinite(bestLendingEdgeBps) ? round(bestLendingEdgeBps, 2) : null,
      watchCandidates,
      routePositive,
      signedActionJustified: false,
    },
    prices: Object.fromEntries([...prices.entries()].map(([address, row]) => [address, row])),
    pools,
    tokenControls,
    aave,
    benqi,
    morpho,
    silo,
    localDeploymentReferences: refs,
    routes,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
  console.log(`Wrote ${path.relative(WORKSPACE, OUT_FILE)}`);
  console.log(`Avalanche stable routes: routePositive=${routePositive}; watchCandidates=${watchCandidates}; USDT spread=${round(out.summary.usdtDexVsReferenceBps, 2)}bps; sUSDe spread=${round(out.summary.susdeDexVsReferenceBps, 2)}bps; Aave rows=${out.summary.aaveRows}; BenQi rows=${out.summary.benqiRows}; Morpho collateral=${out.summary.morphoCollateralMarkets}; Silo rows=${out.summary.siloTargetRows}`);
}

main().catch((err) => {
  console.error(sanitizeError(err));
  process.exit(1);
});
