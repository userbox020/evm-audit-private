#!/usr/bin/env node
// Read-only Base CADC route mapper.
// Resolves CADC FX/DEX pricing, token controls, and Aave/Morpho/Compound/Silo consumers without signed calls.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "base-cadc-routes.json");
const TIMEOUT_MS = 15_000;
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";

const BASE_CHAIN_ID = 8453;
const BASE = { chainId: BASE_CHAIN_ID, chain: "Base", coinSlug: "base" };
const CADC = "0x043eB4B75d0805c43D7C834902E335621983Cf03";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const CADC_USDC_AERODROME_POOL = "0x09Da4832d34BeBBB55783340d5bede7A70F5c48e";
const DEFILLAMA_POOL_ID = "8c0d3027-f688-4255-b926-48efdae2e74a";

const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const AAVE_ORACLE = "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156";
const COMPOUND_DEPLOYMENTS = path.join(WORKSPACE, "targets", "compound-comet", "deployments", "base");
const SILO_DEPLOYMENTS = path.join(WORKSPACE, "targets", "silo-contracts-v2", "silo-core", "deployments", "base");
const FLUID_DEPLOYMENTS = path.join(WORKSPACE, "targets", "fluid-contracts-public", "deployments", "base");

const MIN_ROUTE_EDGE_BPS = Number(process.env.BASE_CADC_MIN_ROUTE_EDGE_BPS || "100");
const MIN_BORROW_CASH_USD = Number(process.env.BASE_CADC_MIN_BORROW_CASH_USD || "10000");
const MAX_SILO_IDS = Number(process.env.BASE_CADC_MAX_SILO_IDS || "700");
const MORPHO_FIRST = Number(process.env.BASE_CADC_MORPHO_FIRST || "100");

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const TOKEN_CONTROL = new ethers.Interface([
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function MINTER_ROLE() view returns (bytes32)",
  "function BURNER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function owner() view returns (address)",
  "function masterMinter() view returns (address)",
  "function pauser() view returns (address)",
  "function blacklister() view returns (address)",
  "function rescuer() view returns (address)",
  "function getCCIPAdmin() view returns (address)",
  "function currency() view returns (string)",
  "function mint(address,uint256)",
  "function burn(uint256)",
  "function burnFrom(address,uint256)",
  "function redeem(uint256)",
  "function redeem(address,uint256)",
]);
const AAVE_POOL_IFACE = new ethers.Interface([
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns (tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
  "function getEModeCategoryData(uint8 id) view returns (uint16 ltv,uint16 liquidationThreshold,uint16 liquidationBonus,address priceSource,string label)",
]);
const AAVE_ORACLE_IFACE = new ethers.Interface([
  "function BASE_CURRENCY_UNIT() view returns (uint256)",
  "function getAssetPrice(address asset) view returns (uint256)",
  "function getSourceOfAsset(address asset) view returns (address)",
]);
const CHAINLINK = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const MORPHO_ORACLE = new ethers.Interface([
  "function price() view returns (uint256)",
]);
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

const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function sanitizeError(error) {
  return String(error?.shortMessage || error?.message || error || "call failed").replace(/https?:\/\/\S+/g, "[redacted-url]").slice(0, 180);
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function lowerAddress(value) {
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
}

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function wordAt(raw, index) {
  const hex = strip0x(raw);
  const start = index * 64;
  if (!hex || hex.length < start + 64) return null;
  return `0x${hex.slice(start, start + 64)}`;
}

function addressWordAt(raw, index) {
  const word = wordAt(raw, index);
  if (!word) return null;
  const hex = strip0x(word).padStart(64, "0");
  if (/^0+$/.test(hex)) return null;
  return normalizeAddress(`0x${hex.slice(-40)}`);
}

function round(value, decimals = 4) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function bps(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / b) * 10_000;
}

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try { return Number(ethers.formatUnits(BigInt(raw), Number(decimals))); } catch (_) { return null; }
}

function formatUnitsString(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try { return ethers.formatUnits(BigInt(raw), Number(decimals)); } catch (_) { return null; }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
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
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcUrl(chainId) {
  for (const url of loadRpcUrls()) {
    try {
      const got = await rpcCall(url, "eth_chainId", [], 6000);
      if (Number(BigInt(got)) === chainId) return url;
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
  try {
    const raw = await provider.call(tx);
    return { ok: true, raw };
  } catch (e) {
    return { ok: false, error: sanitizeError(e) };
  }
}

async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
  const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "evm-audit-base-cadc/1.0", ...(fetchOptions.headers || {}) },
      ...fetchOptions,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCadUsdFx() {
  const sources = [
    {
      source: "frankfurter",
      url: "https://api.frankfurter.app/latest?from=CAD&to=USD",
      parse: (json) => ({ priceUsd: Number(json?.rates?.USD), asOf: json?.date || null }),
    },
    {
      source: "open-er-api",
      url: "https://open.er-api.com/v6/latest/CAD",
      parse: (json) => ({ priceUsd: Number(json?.rates?.USD), asOf: json?.time_last_update_utc || null }),
    },
  ];
  const errors = [];
  for (const item of sources) {
    try {
      const parsed = item.parse(await fetchJson(item.url, { timeoutMs: 15_000 }));
      if (Number.isFinite(parsed.priceUsd) && parsed.priceUsd > 0) return { ...parsed, source: item.source };
      errors.push(`${item.source}: missing USD rate`);
    } catch (e) {
      errors.push(`${item.source}: ${sanitizeError(e)}`);
    }
  }
  return { priceUsd: null, asOf: null, source: null, errors };
}

async function fetchBasePrices(addresses) {
  const keys = [...new Set((addresses || []).map(lowerAddress).filter(Boolean).map((address) => `${BASE.coinSlug}:${address}`))];
  const prices = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const slice = keys.slice(i, i + 50);
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${slice.join(",")}?searchWidth=6h`, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    for (const [key, row] of Object.entries(json.coins || {})) {
      const address = lowerAddress(key.split(":").pop());
      const price = Number(row?.price || 0);
      if (address && Number.isFinite(price) && price > 0) prices.set(address, { priceUsd: price, source: "defillama-coins", timestamp: row.timestamp || null });
    }
  }
  return prices;
}

async function fetchDexPair() {
  const json = await fetchJson(`https://api.dexscreener.com/latest/dex/pairs/base/${CADC_USDC_AERODROME_POOL}`, { timeoutMs: 20_000 }).catch(() => null);
  const pair = json?.pair || (Array.isArray(json?.pairs) ? json.pairs[0] : null);
  if (!pair) return null;
  const cadcIsBase = lowerAddress(pair.baseToken?.address) === lowerAddress(CADC);
  return {
    chainId: pair.chainId || "base",
    dexId: pair.dexId || null,
    pairAddress: pair.pairAddress || CADC_USDC_AERODROME_POOL,
    cadcIsBase,
    priceUsd: cadcIsBase && pair.priceUsd ? Number(pair.priceUsd) : null,
    priceNative: pair.priceNative ? Number(pair.priceNative) : null,
    liquidityUsd: pair.liquidity?.usd ? Number(pair.liquidity.usd) : null,
    volume24hUsd: pair.volume?.h24 ? Number(pair.volume.h24) : null,
    fdv: pair.fdv ? Number(pair.fdv) : null,
    baseToken: pair.baseToken ? { address: pair.baseToken.address, symbol: pair.baseToken.symbol } : null,
    quoteToken: pair.quoteToken ? { address: pair.quoteToken.address, symbol: pair.quoteToken.symbol } : null,
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
    codeBytes: code && code !== "0x" ? (strip0x(code).length / 2) : 0,
    symbol: symbol.ok ? String(symbol.value[0]) : null,
    name: name.ok ? String(name.value[0]) : null,
    decimals: dec,
    totalSupplyRaw: supplyRaw,
    totalSupply: formatUnitsString(supplyRaw, dec),
    priceUsd: price?.priceUsd || null,
    priceSource: price?.source || null,
  };
}

function slotAddress(value) {
  const hex = strip0x(value).padStart(64, "0");
  if (/^0+$/.test(hex)) return null;
  return normalizeAddress(`0x${hex.slice(-40)}`);
}

async function proxySlots(provider, address) {
  const [impl, admin, beacon] = await Promise.all([
    provider.getStorage(address, EIP1967_IMPL_SLOT).catch(() => null),
    provider.getStorage(address, EIP1967_ADMIN_SLOT).catch(() => null),
    provider.getStorage(address, EIP1967_BEACON_SLOT).catch(() => null),
  ]);
  return {
    eip1967Implementation: slotAddress(impl),
    eip1967Admin: slotAddress(admin),
    eip1967Beacon: slotAddress(beacon),
  };
}

async function scanPoolOnchain(provider) {
  const [token0, token1, fee, liquidity, slot0, reserves, stable] = await Promise.all([
    safeCall(provider, CADC_USDC_AERODROME_POOL, SLIPSTREAM_POOL, "token0"),
    safeCall(provider, CADC_USDC_AERODROME_POOL, SLIPSTREAM_POOL, "token1"),
    safeCall(provider, CADC_USDC_AERODROME_POOL, SLIPSTREAM_POOL, "fee"),
    safeCall(provider, CADC_USDC_AERODROME_POOL, SLIPSTREAM_POOL, "liquidity"),
    safeCall(provider, CADC_USDC_AERODROME_POOL, SLIPSTREAM_POOL, "slot0"),
    safeCall(provider, CADC_USDC_AERODROME_POOL, V2_PAIR, "getReserves"),
    safeCall(provider, CADC_USDC_AERODROME_POOL, V2_PAIR, "stable"),
  ]);
  return {
    address: CADC_USDC_AERODROME_POOL,
    token0: token0.ok ? normalizeAddress(token0.value[0]) : null,
    token1: token1.ok ? normalizeAddress(token1.value[0]) : null,
    fee: fee.ok ? Number(fee.value[0]) : null,
    liquidityRaw: liquidity.ok ? liquidity.value[0] : null,
    slot0: slot0.ok ? {
      sqrtPriceX96: slot0.value[0],
      tick: Number(slot0.value[1]),
      unlocked: Boolean(slot0.value[5]),
    } : null,
    v2Reserves: reserves.ok ? {
      reserve0: reserves.value[0],
      reserve1: reserves.value[1],
      blockTimestampLast: Number(reserves.value[2]),
    } : null,
    stable: stable.ok ? Boolean(stable.value[0]) : null,
    errors: {
      slot0: slot0.error || null,
      getReserves: reserves.error || null,
      stable: stable.error || null,
    },
  };
}

async function scanTokenControls(provider, prices) {
  const [meta, slots, owner, masterMinter, pauser, blacklister, rescuer, ccipAdmin, currency, defaultAdminRole, minterRole, burnerRole] = await Promise.all([
    tokenMeta(provider, CADC, prices),
    proxySlots(provider, CADC),
    safeCall(provider, CADC, TOKEN_CONTROL, "owner"),
    safeCall(provider, CADC, TOKEN_CONTROL, "masterMinter"),
    safeCall(provider, CADC, TOKEN_CONTROL, "pauser"),
    safeCall(provider, CADC, TOKEN_CONTROL, "blacklister"),
    safeCall(provider, CADC, TOKEN_CONTROL, "rescuer"),
    safeCall(provider, CADC, TOKEN_CONTROL, "getCCIPAdmin"),
    safeCall(provider, CADC, TOKEN_CONTROL, "currency"),
    safeCall(provider, CADC, TOKEN_CONTROL, "DEFAULT_ADMIN_ROLE"),
    safeCall(provider, CADC, TOKEN_CONTROL, "MINTER_ROLE"),
    safeCall(provider, CADC, TOKEN_CONTROL, "BURNER_ROLE"),
  ]);

  async function hasRole(roleResult, account) {
    const target = normalizeAddress(account);
    if (!roleResult.ok || !target) return null;
    const result = await safeCall(provider, CADC, TOKEN_CONTROL, "hasRole", [roleResult.value[0], target]);
    return result.ok ? Boolean(result.value[0]) : null;
  }

  const probeCalls = [
    ["mint(address,uint256)", [PROBE_FROM, 1n]],
    ["burn(uint256)", [1n]],
    ["burnFrom(address,uint256)", [PROBE_FROM, 1n]],
    ["redeem(uint256)", [1n]],
    ["redeem(address,uint256)", [PROBE_FROM, 1n]],
  ];
  const arbitrarySenderProbes = {};
  for (const [signature, args] of probeCalls) {
    const call = await safeEthCall(provider, { from: PROBE_FROM, to: CADC, data: TOKEN_CONTROL.encodeFunctionData(signature, args) });
    arbitrarySenderProbes[signature] = { ok: call.ok, error: call.error || null };
  }

  const adminAccounts = {
    owner: owner.ok ? normalizeAddress(owner.value[0]) : null,
    masterMinter: masterMinter.ok ? normalizeAddress(masterMinter.value[0]) : null,
    pauser: pauser.ok ? normalizeAddress(pauser.value[0]) : null,
    blacklister: blacklister.ok ? normalizeAddress(blacklister.value[0]) : null,
    rescuer: rescuer.ok ? normalizeAddress(rescuer.value[0]) : null,
    ccipAdmin: ccipAdmin.ok ? normalizeAddress(ccipAdmin.value[0]) : null,
  };

  return {
    token: meta,
    proxy: slots,
    currency: currency.ok ? String(currency.value[0]) : null,
    adminAccounts,
    roleChecks: {
      probeIsDefaultAdmin: await hasRole(defaultAdminRole, PROBE_FROM),
      probeIsMinter: await hasRole(minterRole, PROBE_FROM),
      probeIsBurner: await hasRole(burnerRole, PROBE_FROM),
      ownerIsMinter: await hasRole(minterRole, adminAccounts.owner),
      masterMinterIsMinter: await hasRole(minterRole, adminAccounts.masterMinter),
    },
    arbitrarySenderProbes,
    errors: {
      owner: owner.error || null,
      masterMinter: masterMinter.error || null,
      pauser: pauser.error || null,
      blacklister: blacklister.error || null,
      rescuer: rescuer.error || null,
      ccipAdmin: ccipAdmin.error || null,
      currency: currency.error || null,
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

async function scanAaveReserve(provider, asset, listed, priceUsd, prices) {
  const raw = await safeCall(provider, AAVE_POOL, AAVE_POOL_IFACE, "getReserveData", [asset]);
  if (!raw.ok) return { asset: normalizeAddress(asset), listed: false, error: raw.error };
  const config = decodeAaveConfig(BigInt(wordAt(raw.raw, 0) || 0n));
  const aToken = addressWordAt(raw.raw, 8);
  const meta = await tokenMeta(provider, asset, prices).catch(() => ({ decimals: config.decimals || null }));
  const decimals = config.decimals || meta.decimals;
  const cash = aToken ? await erc20Balance(provider, asset, aToken, decimals) : { raw: null, number: null, formatted: null };
  return {
    asset: normalizeAddress(asset),
    listed,
    token: meta,
    config,
    aToken,
    cashRaw: cash.raw,
    cash: cash.formatted,
    cashUsd: Number.isFinite(cash.number) && Number.isFinite(priceUsd) ? cash.number * priceUsd : null,
  };
}

function lendingBlockers(edgeBps, borrowCashUsd, config, extra = []) {
  const blockers = [...extra];
  if (edgeBps === null || edgeBps < MIN_ROUTE_EDGE_BPS) blockers.push("oracle LTV borrowable value is below current market cost plus edge threshold");
  if (!Number.isFinite(borrowCashUsd) || borrowCashUsd < MIN_BORROW_CASH_USD) blockers.push("borrow cash below route threshold");
  if (!config?.active) blockers.push("reserve/vault inactive or not listed");
  if (config?.paused) blockers.push("reserve/vault paused");
  if (config?.frozen) blockers.push("reserve/vault frozen");
  if (!Number(config?.ltv || 0)) blockers.push("collateral LTV is zero");
  return [...new Set(blockers)];
}

async function scanAave(provider, marketPriceUsd, prices) {
  const reservesRaw = await safeCall(provider, AAVE_POOL, AAVE_POOL_IFACE, "getReservesList");
  const reserves = reservesRaw.ok ? [...reservesRaw.value[0]].map(normalizeAddress).filter(Boolean) : [];
  const cadcListed = reserves.map((x) => x.toLowerCase()).includes(lowerAddress(CADC));
  const usdcPrice = prices.get(lowerAddress(BASE_USDC))?.priceUsd || null;
  const [unit, cadcPrice, cadcSource, cadcReserve, usdcReserve] = await Promise.all([
    safeCall(provider, AAVE_ORACLE, AAVE_ORACLE_IFACE, "BASE_CURRENCY_UNIT"),
    safeCall(provider, AAVE_ORACLE, AAVE_ORACLE_IFACE, "getAssetPrice", [CADC]),
    safeCall(provider, AAVE_ORACLE, AAVE_ORACLE_IFACE, "getSourceOfAsset", [CADC]),
    scanAaveReserve(provider, CADC, cadcListed, marketPriceUsd, prices),
    scanAaveReserve(provider, BASE_USDC, reserves.map((x) => x.toLowerCase()).includes(lowerAddress(BASE_USDC)), usdcPrice, prices),
  ]);
  const oracleUnit = unit.ok ? Number(unit.value[0]) : null;
  const oracleUsd = cadcPrice.ok && oracleUnit ? Number(cadcPrice.value[0]) / oracleUnit : null;
  const eModeCategoryId = cadcReserve.config?.eModeCategoryId || 0;
  const eModeRaw = eModeCategoryId ? await safeCall(provider, AAVE_POOL, AAVE_POOL_IFACE, "getEModeCategoryData", [eModeCategoryId]) : { ok: false };
  const eMode = eModeRaw.ok ? {
    id: eModeCategoryId,
    ltv: Number(eModeRaw.value[0]) / 10_000,
    liquidationThreshold: Number(eModeRaw.value[1]) / 10_000,
    liquidationBonus: Number(eModeRaw.value[2]) / 10_000,
    priceSource: normalizeAddress(eModeRaw.value[3]),
    label: String(eModeRaw.value[4] || ""),
  } : null;
  const baseLtv = cadcReserve.config?.ltv || 0;
  const effectiveLtv = eMode?.ltv || baseLtv;
  const borrowablePerCadcUsd = Number.isFinite(oracleUsd) ? oracleUsd * effectiveLtv : null;
  const edgeBps = bps(borrowablePerCadcUsd, marketPriceUsd);
  const bestBorrowCashUsd = Number(usdcReserve.cashUsd || 0);
  const routePositive = Boolean(cadcListed && edgeBps !== null && edgeBps >= MIN_ROUTE_EDGE_BPS && bestBorrowCashUsd >= MIN_BORROW_CASH_USD && cadcReserve.config?.active && !cadcReserve.config?.paused && !cadcReserve.config?.frozen && effectiveLtv > 0);
  return {
    pool: AAVE_POOL,
    oracle: AAVE_ORACLE,
    reservesListed: reserves.length,
    cadcListed,
    assetOraclePriceRaw: cadcPrice.ok ? cadcPrice.value[0] : null,
    oracleUnit,
    assetOraclePriceUsd: oracleUsd,
    sourceOfAsset: cadcSource.ok ? normalizeAddress(cadcSource.value[0]) : null,
    reserves: { CADC: cadcReserve, USDC: usdcReserve },
    eMode,
    routeModel: {
      route: "buy Base CADC -> supply Aave V3 Base -> borrow USDC",
      marketPriceUsd,
      baseLtv,
      effectiveLtv,
      eModeCategoryId,
      borrowablePerCadcUsd,
      edgeBps,
      bestBorrowCashUsd,
      minEdgeBps: MIN_ROUTE_EDGE_BPS,
      minBorrowCashUsd: MIN_BORROW_CASH_USD,
      watchCandidate: Boolean(cadcListed && effectiveLtv > 0),
      routePositive,
      blockers: routePositive ? [] : lendingBlockers(edgeBps, bestBorrowCashUsd, cadcReserve.config, cadcListed ? [] : ["CADC is not in Aave Base reserves list"]),
    },
  };
}

async function morphoQuery(query, variables) {
  const json = await fetchJson("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    timeoutMs: 30_000,
  });
  if (json.errors) throw new Error(json.errors[0]?.message || "Morpho GraphQL error");
  return json.data || {};
}

function morphoLltvRatio(value) {
  try { return Number(BigInt(String(value || 0))) / 1e18; } catch (_) { return Number(value || 0); }
}

function morphoLoanPerCollateral(priceRaw, collateralDecimals, loanDecimals) {
  if (priceRaw === null || priceRaw === undefined || collateralDecimals === null || loanDecimals === null) return null;
  try {
    const loanRaw = (10n ** BigInt(collateralDecimals)) * BigInt(priceRaw) / (10n ** 36n);
    return formatUnitsNumber(loanRaw, loanDecimals);
  } catch (_) {
    return null;
  }
}

async function scanMorpho(provider, marketPriceUsd, prices) {
  const query = `query($chainIds:[Int!]!, $assets:[String!]!) {
    collateral: markets(first:${MORPHO_FIRST}, orderBy:SupplyAssetsUsd, orderDirection:Desc,
      where:{chainId_in:$chainIds, collateralAssetAddress_in:$assets}) { items {
        marketId
        loanAsset { symbol address decimals }
        collateralAsset { symbol address decimals }
        oracle { address }
        lltv
        state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization }
      } }
    loan: markets(first:${MORPHO_FIRST}, orderBy:SupplyAssetsUsd, orderDirection:Desc,
      where:{chainId_in:$chainIds, loanAssetAddress_in:$assets}) { items {
        marketId
        loanAsset { symbol address decimals }
        collateralAsset { symbol address decimals }
        oracle { address }
        lltv
        state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization }
      } }
  }`;
  let data;
  try {
    data = await morphoQuery(query, { chainIds: [BASE_CHAIN_ID], assets: [CADC] });
  } catch (e) {
    return { error: sanitizeError(e), collateralMarkets: [], loanMarkets: [], summary: { collateralMarkets: 0, loanMarkets: 0, routePositive: 0, watchCandidates: 0 } };
  }

  async function enrich(market, side) {
    const lltv = morphoLltvRatio(market.lltv);
    const oracle = normalizeAddress(market.oracle?.address);
    const oracleRaw = side === "collateral" && oracle ? await safeCall(provider, oracle, MORPHO_ORACLE, "price") : { ok: false };
    const loan = market.loanAsset || {};
    const collateral = market.collateralAsset || {};
    const loanPrice = prices.get(lowerAddress(loan.address))?.priceUsd || null;
    const loanPerCadc = side === "collateral" && oracleRaw.ok ? morphoLoanPerCollateral(oracleRaw.value[0], Number(collateral.decimals ?? 18), Number(loan.decimals ?? 18)) : null;
    const borrowablePerCadcUsd = Number.isFinite(loanPerCadc) && Number.isFinite(loanPrice) ? loanPerCadc * loanPrice * lltv : null;
    const edgeBps = bps(borrowablePerCadcUsd, marketPriceUsd);
    const liquidityUsd = Number(market.state?.liquidityAssetsUsd || 0);
    const routePositive = Boolean(side === "collateral" && edgeBps !== null && edgeBps >= MIN_ROUTE_EDGE_BPS && liquidityUsd >= MIN_BORROW_CASH_USD);
    const blockers = [];
    if (side !== "collateral") blockers.push("CADC is loan asset, not collateral for borrow extraction");
    if (!oracleRaw.ok && side === "collateral") blockers.push("Morpho oracle price() not decoded; fail closed");
    if (side === "collateral" && (edgeBps === null || edgeBps < MIN_ROUTE_EDGE_BPS)) blockers.push("LLTV-adjusted oracle value is below market cost plus edge threshold");
    if (liquidityUsd < MIN_BORROW_CASH_USD) blockers.push("borrow liquidity below route threshold");
    return {
      side,
      marketId: market.marketId,
      loanAsset: { symbol: loan.symbol || null, address: normalizeAddress(loan.address), decimals: loan.decimals ?? null, priceUsd: loanPrice },
      collateralAsset: { symbol: collateral.symbol || null, address: normalizeAddress(collateral.address), decimals: collateral.decimals ?? null },
      oracle,
      lltv,
      state: {
        supplyAssetsUsd: Number(market.state?.supplyAssetsUsd || 0),
        borrowAssetsUsd: Number(market.state?.borrowAssetsUsd || 0),
        liquidityAssetsUsd: liquidityUsd,
        utilization: market.state?.utilization ?? null,
      },
      oraclePriceRaw: oracleRaw.ok ? oracleRaw.value[0] : null,
      loanPerCadc,
      routeModel: {
        route: side === "collateral" ? `buy Base CADC -> supply Morpho market -> borrow ${loan.symbol || "loan asset"}` : "borrow CADC side market mapping only",
        marketPriceUsd,
        borrowablePerCadcUsd,
        edgeBps,
        minEdgeBps: MIN_ROUTE_EDGE_BPS,
        minBorrowCashUsd: MIN_BORROW_CASH_USD,
        watchCandidate: Boolean(side === "collateral"),
        routePositive,
        blockers: [...new Set(blockers)],
      },
    };
  }

  const collateralMarkets = await Promise.all((data.collateral?.items || []).map((m) => enrich(m, "collateral")));
  const loanMarkets = await Promise.all((data.loan?.items || []).map((m) => enrich(m, "loan")));
  return {
    collateralMarkets,
    loanMarkets,
    summary: {
      collateralMarkets: collateralMarkets.length,
      loanMarkets: loanMarkets.length,
      watchCandidates: collateralMarkets.filter((m) => m.routeModel.watchCandidate).length,
      routePositive: collateralMarkets.filter((m) => m.routeModel.routePositive).length,
      bestCollateralEdgeBps: Math.max(...collateralMarkets.map((m) => Number(m.routeModel.edgeBps)).filter(Number.isFinite), -Infinity),
    },
  };
}

async function feedState(provider, address, blockTimestamp) {
  const feed = normalizeAddress(address);
  if (!feed) return null;
  const [decimalsRaw, descriptionRaw, roundRaw] = await Promise.all([
    safeCall(provider, feed, CHAINLINK, "decimals"),
    safeCall(provider, feed, CHAINLINK, "description"),
    safeCall(provider, feed, CHAINLINK, "latestRoundData"),
  ]);
  const decimals = decimalsRaw.ok ? Number(decimalsRaw.value[0]) : 8;
  const latest = roundRaw.ok ? roundRaw.value : null;
  const answer = latest ? latest[1] : null;
  const updatedAt = latest?.[3] ? Number(latest[3]) : null;
  return {
    address: feed,
    description: descriptionRaw.ok ? String(descriptionRaw.value[0]) : null,
    decimals,
    answerRaw: answer,
    answer: answer === null ? null : Number(ethers.formatUnits(answer, decimals)),
    updatedAt,
    ageSeconds: updatedAt && blockTimestamp ? blockTimestamp - updatedAt : null,
    error: roundRaw.error || null,
  };
}

function listCompoundConfigs() {
  if (!fs.existsSync(COMPOUND_DEPLOYMENTS)) return [];
  const rows = [];
  for (const marketName of fs.readdirSync(COMPOUND_DEPLOYMENTS)) {
    const marketFolder = path.join(COMPOUND_DEPLOYMENTS, marketName);
    if (!fs.statSync(marketFolder).isDirectory()) continue;
    const config = readJson(path.join(marketFolder, "configuration.json"), null);
    const roots = readJson(path.join(marketFolder, "roots.json"), null);
    if (config && roots?.comet) rows.push({ marketName, config, comet: normalizeAddress(roots.comet) });
  }
  return rows;
}

async function scanCompound(provider, blockTimestamp, marketPriceUsd, prices) {
  const configs = listCompoundConfigs();
  const rows = [];
  for (const row of configs) {
    const baseToken = normalizeAddress(row.config.baseTokenAddress);
    const baseMeta = baseToken ? await tokenMeta(provider, baseToken, prices).catch(() => ({ address: baseToken, decimals: 18, symbol: row.config.baseToken })) : null;
    const baseCash = baseToken && row.comet ? await erc20Balance(provider, baseToken, row.comet, baseMeta?.decimals ?? 18).catch(() => ({ number: 0, raw: null })) : { number: 0, raw: null };
    const basePrice = baseToken ? prices.get(lowerAddress(baseToken))?.priceUsd || null : null;
    const baseCashUsd = Number.isFinite(baseCash.number) && Number.isFinite(basePrice) ? baseCash.number * basePrice : null;
    if (lowerAddress(baseToken) === lowerAddress(CADC)) {
      rows.push({
        side: "baseToken",
        protocol: "Compound Comet",
        marketName: row.marketName,
        comet: row.comet,
        baseToken: baseMeta,
        baseCashRaw: baseCash.raw,
        baseCash: baseCash.formatted,
        baseCashUsd,
        routeModel: { routePositive: false, watchCandidate: false, blockers: ["CADC is borrow/base asset, not collateral route"] },
      });
    }
    for (const [symbol, asset] of Object.entries(row.config.assets || {})) {
      if (lowerAddress(asset.address) !== lowerAddress(CADC)) continue;
      const feed = await feedState(provider, asset.priceFeed, blockTimestamp);
      const borrowCF = Number(asset.borrowCF || 0);
      const borrowablePerCadcUsd = Number.isFinite(feed?.answer) ? feed.answer * borrowCF : null;
      const edgeBps = bps(borrowablePerCadcUsd, marketPriceUsd);
      const routePositive = Boolean(edgeBps !== null && edgeBps >= MIN_ROUTE_EDGE_BPS && Number(baseCashUsd || 0) >= MIN_BORROW_CASH_USD);
      rows.push({
        side: "collateral",
        protocol: "Compound Comet",
        marketName: row.marketName,
        comet: row.comet,
        baseToken: baseMeta,
        collateral: { symbol, address: normalizeAddress(asset.address), decimals: Number(String(asset.decimals || "18").replace(/[^0-9]/g, "") || 18) },
        priceFeed: feed,
        borrowCF,
        liquidateCF: Number(asset.liquidateCF || 0),
        baseCashRaw: baseCash.raw,
        baseCash: baseCash.formatted,
        baseCashUsd,
        routeModel: {
          route: `buy Base CADC -> supply Compound ${row.marketName} -> borrow ${row.config.baseToken || "base asset"}`,
          marketPriceUsd,
          borrowablePerCadcUsd,
          edgeBps,
          minEdgeBps: MIN_ROUTE_EDGE_BPS,
          minBorrowCashUsd: MIN_BORROW_CASH_USD,
          watchCandidate: true,
          routePositive,
          blockers: routePositive ? [] : lendingBlockers(edgeBps, baseCashUsd, { active: true, ltv: borrowCF }),
        },
      });
    }
  }
  return { rows, summary: { marketsScanned: configs.length, cadcRows: rows.length, watchCandidates: rows.filter((r) => r.routeModel.watchCandidate).length, routePositive: rows.filter((r) => r.routeModel.routePositive).length } };
}

function loadSiloFactory() {
  const file = path.join(SILO_DEPLOYMENTS, "SiloFactory.sol.json");
  const json = readJson(file, null);
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
  if (!factory) return { factory: null, rows: [], summary: { idsScanned: 0, marketsScanned: 0, cadcRows: 0, watchCandidates: 0, routePositive: 0 } };
  const nextRaw = await safeCall(provider, factory, SILO_FACTORY, "getNextSiloId");
  const nextId = nextRaw.ok ? nextRaw.value[0] : null;
  if (!nextId) return { factory, rows: [], summary: { idsScanned: 0, marketsScanned: 0, cadcRows: 0, watchCandidates: 0, routePositive: 0 }, error: nextRaw.error || null };
  const start = nextId > BigInt(MAX_SILO_IDS) ? nextId - BigInt(MAX_SILO_IDS) : 1n;
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
      const [configRaw, liquidityRaw, storageRaw] = await Promise.all([
        safeCall(provider, config, SILO_CONFIG, "getConfig", [silo]),
        safeCall(provider, silo, SILO, "getLiquidity"),
        safeCall(provider, silo, SILO, "getSiloStorage"),
      ]);
      const cfg = parseSiloConfig(configRaw.ok ? configRaw.value : null);
      if (!cfg) continue;
      const storage = storageRaw.ok ? storageRaw.value : null;
      sides.push({ ...cfg, id: id.toString(), config, liquidityRaw: liquidityRaw.ok ? liquidityRaw.value[0] : 0n, collateralAssetsRaw: (storage?.[3] || 0n).toString(), debtAssetsRaw: (storage?.[4] || 0n).toString() });
    }
    if (sides.length !== 2) continue;
    marketsScanned++;
    if (!sides.some((side) => lowerAddress(side.token) === lowerAddress(CADC))) continue;
    const metas = new Map();
    for (const side of sides) metas.set(lowerAddress(side.token), await tokenMeta(provider, side.token, prices).catch(() => ({ address: side.token, decimals: 18, symbol: null })));
    for (let i = 0; i < sides.length; i++) {
      const side = sides[i];
      const opposite = sides[i === 0 ? 1 : 0];
      if (lowerAddress(side.token) !== lowerAddress(CADC) && lowerAddress(opposite.token) !== lowerAddress(CADC)) continue;
      const sideMeta = metas.get(lowerAddress(side.token));
      const oppositeMeta = metas.get(lowerAddress(opposite.token));
      const oppositeLiquidity = formatUnitsNumber(opposite.liquidityRaw, oppositeMeta?.decimals ?? 18);
      const oppositePrice = prices.get(lowerAddress(opposite.token))?.priceUsd || null;
      const routeLiquidityUsd = Number.isFinite(oppositeLiquidity) && Number.isFinite(oppositePrice) ? oppositeLiquidity * oppositePrice : null;
      const cadcIsCollateralSide = lowerAddress(side.token) === lowerAddress(CADC);
      rows.push({
        side: cadcIsCollateralSide ? "collateral" : "borrowAsset",
        protocol: "Silo V3",
        id: id.toString(),
        config,
        silo: side.silo,
        oppositeSilo: opposite.silo,
        collateral: sideMeta,
        borrowAsset: oppositeMeta,
        solvencyOracle: side.solvencyOracle,
        maxLtvOracle: side.maxLtvOracle,
        maxLtv: side.maxLtv,
        liquidationThreshold: side.lt,
        routeLiquidityUsd,
        collateralAssetsRaw: side.collateralAssetsRaw,
        debtAssetsRaw: side.debtAssetsRaw,
        routeModel: {
          route: cadcIsCollateralSide ? `buy Base CADC -> supply Silo ${id.toString()} -> borrow ${oppositeMeta?.symbol || "opposite asset"}` : "CADC borrow side mapping only",
          watchCandidate: Boolean(cadcIsCollateralSide),
          routePositive: false,
          blockers: cadcIsCollateralSide
            ? ["Silo oracle valuation not decoded into executable borrowable value; fail closed", "No fork-positive Silo CADC route"]
            : ["CADC is borrow asset, not collateral route"],
        },
      });
    }
  }
  return {
    factory,
    rows,
    summary: {
      idsScanned: Number(nextId - start),
      marketsScanned,
      cadcRows: rows.length,
      watchCandidates: rows.filter((r) => r.routeModel.watchCandidate).length,
      routePositive: 0,
    },
  };
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
  const roots = [
    COMPOUND_DEPLOYMENTS,
    SILO_DEPLOYMENTS,
    FLUID_DEPLOYMENTS,
    path.join(WORKSPACE, "targets", "venus-protocol", "deployments"),
    path.join(WORKSPACE, "targets", "venus-isolated-pools", "deployments"),
    path.join(WORKSPACE, "targets", "venus-oracle", "deployments"),
  ];
  const needle = lowerAddress(CADC);
  const refs = [];
  for (const root of roots) {
    for (const file of listFilesRecursive(root)) {
      if (!/\.(json|md|txt)$/i.test(file)) continue;
      const rel = path.relative(WORKSPACE, file).replace(/\\/g, "/");
      if (!/base/i.test(rel) && !/compound-comet\/deployments\/base|fluid-contracts-public\/deployments\/base|silo-contracts-v2\/silo-core\/deployments\/base/i.test(rel)) continue;
      const text = fs.readFileSync(file, "utf8");
      if (text.toLowerCase().includes(needle)) refs.push(rel);
    }
  }
  return refs.slice(0, 50);
}

function routeRows(fx, dexPair, tokenControls, aave, morpho, compound, silo) {
  const marketPriceUsd = dexPair?.priceUsd || tokenControls?.token?.priceUsd || null;
  const fxPriceUsd = fx?.priceUsd ?? null;
  const marketVsFxBps = bps(marketPriceUsd, fxPriceUsd);
  const publicMintOk = Boolean(tokenControls?.arbitrarySenderProbes?.["mint(address,uint256)"]?.ok);
  const publicRedeemOk = Boolean(tokenControls?.arbitrarySenderProbes?.["redeem(uint256)"]?.ok || tokenControls?.arbitrarySenderProbes?.["redeem(address,uint256)"]?.ok);
  const rows = [
    {
      id: "cad-fx-mint-sell",
      description: "Mint CADC at CAD FX value, sell CADC on Base DEX",
      marketPriceUsd,
      cadUsdFx: fxPriceUsd,
      marketVsFxBps,
      routePositive: false,
      watchCandidate: Boolean(marketVsFxBps !== null && marketVsFxBps >= MIN_ROUTE_EDGE_BPS),
      blockers: [
        marketVsFxBps !== null && marketVsFxBps >= MIN_ROUTE_EDGE_BPS ? null : "CADC DEX price is not above live CAD/USD by edge threshold",
        publicMintOk ? "public mint probe succeeded; requires immediate fork proof before any action" : "arbitrary sender mint is not open",
        "fiat issuance/settlement is not an atomic permissionless route",
      ].filter(Boolean),
    },
    {
      id: "cadc-buy-redeem-fx",
      description: "Buy discounted CADC and redeem to CAD/USD reference value",
      marketPriceUsd,
      cadUsdFx: fxPriceUsd,
      marketVsFxBps,
      routePositive: false,
      watchCandidate: Boolean(marketVsFxBps !== null && marketVsFxBps <= -MIN_ROUTE_EDGE_BPS),
      blockers: [
        marketVsFxBps !== null && marketVsFxBps <= -MIN_ROUTE_EDGE_BPS ? null : "CADC DEX discount is not above edge threshold",
        publicRedeemOk ? "public redeem probe succeeded; requires fork proof and withdrawal semantics" : "arbitrary sender redeem is not open",
        "off-chain fiat redemption/KYC is not a permissionless on-chain exit route",
      ].filter(Boolean),
    },
    { id: "base-buy-aave-borrow", description: "Buy Base CADC, supply Aave V3 Base, borrow USDC", ...(aave?.routeModel || { routePositive: false, watchCandidate: false }) },
  ];
  for (const market of morpho?.collateralMarkets || []) rows.push({ id: `base-buy-morpho-${market.marketId}`, description: market.routeModel.route, ...market.routeModel });
  for (const market of morpho?.loanMarkets || []) rows.push({ id: `morpho-cadc-loan-${market.marketId}`, description: market.routeModel.route, ...market.routeModel });
  for (const row of compound?.rows || []) rows.push({ id: `compound-${row.marketName}-${row.side}`, description: row.routeModel.route || row.marketName, ...row.routeModel });
  for (const row of silo?.rows || []) rows.push({ id: `silo-${row.id}-${row.side}`, description: row.routeModel.route || `Silo ${row.id}`, ...row.routeModel });
  return rows;
}

async function main() {
  const baseRpc = await resolveRpcUrl(BASE_CHAIN_ID);
  if (!baseRpc) throw new Error("missing required Base RPC from inventory");
  const provider = new ethers.JsonRpcProvider(baseRpc);
  const [blockNumber, latestBlock, fx, dexPair, prices] = await Promise.all([
    provider.getBlockNumber(),
    provider.getBlock("latest"),
    fetchCadUsdFx(),
    fetchDexPair(),
    fetchBasePrices([CADC, BASE_USDC, BASE_WETH]),
  ]);
  const blockTimestamp = latestBlock?.timestamp ? Number(latestBlock.timestamp) : null;
  const tokenControls = await scanTokenControls(provider, prices);
  const marketPriceUsd = dexPair?.priceUsd || tokenControls.token.priceUsd || null;
  const [poolOnchain, aave, morphoSeed] = await Promise.all([
    scanPoolOnchain(provider),
    scanAave(provider, marketPriceUsd, prices),
    scanMorpho(provider, marketPriceUsd, prices),
  ]);
  const morphoLoanAssets = [...(morphoSeed.collateralMarkets || []), ...(morphoSeed.loanMarkets || [])].map((m) => m.loanAsset?.address).filter(Boolean);
  const expandedPrices = morphoLoanAssets.length ? await fetchBasePrices([CADC, BASE_USDC, BASE_WETH, ...morphoLoanAssets]) : prices;
  for (const [key, value] of expandedPrices.entries()) prices.set(key, value);
  const [morpho, compound, silo] = await Promise.all([
    scanMorpho(provider, marketPriceUsd, prices),
    scanCompound(provider, blockTimestamp, marketPriceUsd, prices),
    scanSilo(provider, prices),
  ]);
  const refs = localDeploymentReferences();
  const routes = routeRows(fx, dexPair, tokenControls, aave, morpho, compound, silo);
  const routePositive = routes.filter((r) => r.routePositive === true).length;
  const watchCandidates = routes.filter((r) => r.watchCandidate === true).length;
  const lendingEdges = [
    aave.routeModel?.edgeBps,
    ...(morpho.collateralMarkets || []).map((m) => m.routeModel.edgeBps),
    ...(compound.rows || []).map((r) => r.routeModel.edgeBps),
  ].filter((value) => value !== null && value !== undefined).map(Number).filter(Number.isFinite);
  const bestLendingEdgeBps = lendingEdges.length ? Math.max(...lendingEdges) : -Infinity;
  const out = {
    generatedAt: new Date().toISOString(),
    scope: "Base CADC public high-yield/FX/consumer route scan",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    chainBlocks: { base: blockNumber },
    thresholds: { minRouteEdgeBps: MIN_ROUTE_EDGE_BPS, minBorrowCashUsd: MIN_BORROW_CASH_USD, maxSiloIds: MAX_SILO_IDS, morphoFirst: MORPHO_FIRST },
    lead: {
      project: "aerodrome-slipstream",
      chain: "Base",
      symbol: "CADC-USDC",
      defillamaPoolId: DEFILLAMA_POOL_ID,
      underlying: [CADC, BASE_USDC],
    },
    summary: {
      marketPriceUsd: round(marketPriceUsd, 8),
      cadUsdFx: round(fx.priceUsd, 8),
      marketVsCadFxBps: round(bps(marketPriceUsd, fx.priceUsd), 2),
      dexLiquidityUsd: round(dexPair?.liquidityUsd, 0),
      dexVolume24hUsd: round(dexPair?.volume24hUsd, 0),
      aaveBorrowableVsMarketBps: round(aave.routeModel.edgeBps, 2),
      morphoCollateralMarkets: morpho.summary.collateralMarkets,
      morphoLoanMarkets: morpho.summary.loanMarkets,
      morphoBestBorrowableVsMarketBps: Number.isFinite(morpho.summary.bestCollateralEdgeBps) ? round(morpho.summary.bestCollateralEdgeBps, 2) : null,
      compoundCadcRows: compound.summary.cadcRows,
      siloCadcRows: silo.summary.cadcRows,
      localDeploymentReferences: refs.length,
      bestLendingEdgeBps: Number.isFinite(bestLendingEdgeBps) ? round(bestLendingEdgeBps, 2) : null,
      watchCandidates,
      routePositive,
      signedActionJustified: false,
    },
    fx,
    prices: Object.fromEntries([...prices.entries()].map(([address, row]) => [address, row])),
    tokenControls,
    dexPair,
    poolOnchain,
    aave,
    morpho,
    compound,
    silo,
    localDeploymentReferences: refs,
    routes,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
  console.log(`Wrote ${path.relative(WORKSPACE, OUT_FILE)}`);
  console.log(`Base CADC: routePositive=${routePositive}; watchCandidates=${watchCandidates}; market=$${round(marketPriceUsd, 6)}; CAD/USD=$${round(fx.priceUsd, 6)}; marketVsFx=${round(bps(marketPriceUsd, fx.priceUsd), 2)}bps; Aave edge=${round(aave.routeModel.edgeBps, 2)}bps; Morpho collateral=${morpho.summary.collateralMarkets}; Compound rows=${compound.summary.cadcRows}; Silo rows=${silo.summary.cadcRows}`);
}

main().catch((err) => {
  console.error(sanitizeError(err));
  process.exit(1);
});
