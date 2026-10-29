#!/usr/bin/env node
// Read-only Base syrupUSDC route mapper.
// Resolves Maple NAV, Base DEX market, Aave/Fluid consumers, and route economics without signed calls.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "base-syrupusdc-routes.json");
const TIMEOUT_MS = 15_000;
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";
const MIN_NET_PROFIT_USD = Number(process.env.BASE_SYRUP_MIN_NET_PROFIT_USD || "25");
const MIN_ROUTE_EDGE_BPS = Number(process.env.BASE_SYRUP_MIN_ROUTE_EDGE_BPS || "100");
const MIN_BORROW_CASH_USD = Number(process.env.BASE_SYRUP_MIN_BORROW_CASH_USD || "10000");

const ETHEREUM_CHAIN_ID = 1;
const BASE_CHAIN_ID = 8453;
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const MAINNET_SYRUP_POOL = "0x80ac24aA929eaF5013f6436cdA2a7ba190f5Cc0b";
const MAINNET_SYRUP_ROUTER = "0x134cCaaA4F1e4552eC8aEcb9E4A2360dDcF8df76";
const BASE_SYRUP = "0x660975730059246A68521a3e2FBD4740173100f5";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_GHO = "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee";
const BASE_AERODROME_POOL = "0x5d0Ee6273f9ad78E80418C2dd203269b2aafCF8B";

const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const AAVE_ORACLE = "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156";
const AAVE_USDC_ATOKEN = "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB";
const AAVE_GHO_ATOKEN = "0x067ae75628177FD257c2B1e500993e1a0baBcBd1";
const AAVE_SYRUP_ATOKEN = "0xD7424238CcbE7b7198Ab3cFE232e0271E22da7bd";

const FLUID_LIQUIDITY = "0x52Aa899454998Be5b000Ad077a46Bbe360F4e497";
const FLUID_VAULT_RESOLVER_FILE = path.join(WORKSPACE, "targets", "fluid-contracts-public", "deployments", "base", "VaultResolver.json");
const FLUID_DEX_RESOLVER_FILE = path.join(WORKSPACE, "targets", "fluid-contracts-public", "deployments", "base", "DexResolver.json");
const FLUID_VAULTS = [
  { name: "VaultT1_syrupUSDC_USDC", address: "0xB9Bb0b2354884B4B9dBDDaeb01feEcf507695e33", collateralType: "single-token", supplyDecimals: 6, borrowToken: BASE_USDC, borrowSymbol: "USDC", borrowDecimals: 6 },
  { name: "VaultT1_syrupUSDC_GHO", address: "0x2d38ca861aC948BF90cC682fC1455138173c1923", collateralType: "single-token", supplyDecimals: 6, borrowToken: BASE_GHO, borrowSymbol: "GHO", borrowDecimals: 18 },
  { name: "VaultT2_DEX-syrupUSDC-USDC_USDC", address: "0xA9FF23CfF9439c418DA08CE7954a92E46311761e", collateralType: "fluid-dex-lp", supplyDecimals: null, borrowToken: BASE_USDC, borrowSymbol: "USDC", borrowDecimals: 6 },
];
const FLUID_DEX = "0xc800b0e15c40a1Ff0539218100c86F4c1BAC8D9C";

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const MAPLE_POOL = new ethers.Interface([
  "function asset() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function BOOTSTRAP_MINT() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function convertToExitAssets(uint256) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function manager() view returns (address)",
  "function maxDeposit(address) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const AAVE_POOL_IFACE = new ethers.Interface([
  "function getReserveData(address asset) view returns (tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
  "function getEModeCategoryData(uint8 id) view returns (uint16 ltv,uint16 liquidationThreshold,uint16 liquidationBonus,address priceSource,string label)",
]);
const AAVE_ORACLE_IFACE = new ethers.Interface([
  "function BASE_CURRENCY_UNIT() view returns (uint256)",
  "function getAssetPrice(address asset) view returns (uint256)",
  "function getSourceOfAsset(address asset) view returns (address)",
]);
const TOKEN_ROLES = new ethers.Interface([
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function MINTER_ROLE() view returns (bytes32)",
  "function BURNER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function getCCIPAdmin() view returns (address)",
  "function owner() view returns (address)",
  "function mint(address,uint256)",
  "function burn(uint256)",
  "function burnFrom(address,uint256)",
]);
const GENERIC_ORACLE = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function latestAnswer() view returns (int256)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function description() view returns (string)",
]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
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
      const got = await rpcCall(url, "eth_chainId", []);
      if (Number(BigInt(got)) === chainId) return url;
    } catch (_) {
      // Keep endpoints secret; try next URL.
    }
  }
  return null;
}

async function safeCall(provider, to, iface, name, args = []) {
  try {
    const raw = await provider.call({ to, data: iface.encodeFunctionData(name, args) });
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

function sanitizeError(error) {
  return String(error?.shortMessage || error?.message || error || "call failed").replace(/https?:\/\/\S+/g, "[redacted-url]").slice(0, 180);
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
  try { return ethers.getAddress(`0x${hex.slice(-40)}`); } catch (_) { return null; }
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

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try { return Number(ethers.formatUnits(BigInt(raw), Number(decimals))); } catch (_) { return null; }
}

function formatUnitsString(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try { return ethers.formatUnits(BigInt(raw), Number(decimals)); } catch (_) { return null; }
}

function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function bps(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / b) * 10_000;
}

function rate27(raw) {
  if (raw === null || raw === undefined) return null;
  try { return Number(ethers.formatUnits(BigInt(raw), 27)); } catch (_) { return null; }
}

function fluidDebtPerCollateralUnit(raw, supplyDecimals, borrowDecimals) {
  if (raw === null || raw === undefined || supplyDecimals === null || borrowDecimals === null) return null;
  try {
    const debtRaw = BigInt(raw) * (10n ** BigInt(supplyDecimals)) / (10n ** 27n);
    return formatUnitsNumber(debtRaw, borrowDecimals);
  } catch (_) {
    return null;
  }
}

async function tokenMeta(provider, address) {
  const [symbol, name, decimals, supply] = await Promise.all([
    safeCall(provider, address, ERC20, "symbol"),
    safeCall(provider, address, ERC20, "name"),
    safeCall(provider, address, ERC20, "decimals"),
    safeCall(provider, address, ERC20, "totalSupply"),
  ]);
  const dec = decimals.ok ? Number(decimals.value[0]) : null;
  const supplyRaw = supply.ok ? supply.value[0] : null;
  return {
    address: ethers.getAddress(address),
    symbol: symbol.ok ? String(symbol.value[0]) : null,
    name: name.ok ? String(name.value[0]) : null,
    decimals: dec,
    totalSupplyRaw: supplyRaw,
    totalSupply: formatUnitsString(supplyRaw, dec),
  };
}

async function erc20Balance(provider, token, account, decimals = null) {
  const raw = await safeCall(provider, token, ERC20, "balanceOf", [account]);
  const value = raw.ok ? raw.value[0] : null;
  return { raw: value, formatted: formatUnitsString(value, decimals), number: formatUnitsNumber(value, decimals), error: raw.error || null };
}

async function fetchJson(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-base-syrupusdc/1.0" }, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPrices() {
  const coins = [
    `ethereum:${MAINNET_USDC}`,
    `base:${BASE_USDC}`,
    `base:${BASE_GHO}`,
    `base:${BASE_SYRUP}`,
  ].join(",");
  const json = await fetchJson(`https://coins.llama.fi/prices/current/${coins}`);
  const price = (coin) => {
    const row = json?.coins?.[coin];
    return row?.price && Number(row.price) > 0 ? Number(row.price) : null;
  };
  return {
    mainnetUsdc: price(`ethereum:${MAINNET_USDC}`) || 1,
    baseUsdc: price(`base:${BASE_USDC}`) || 1,
    baseGho: price(`base:${BASE_GHO}`) || 1,
    baseSyrup: price(`base:${BASE_SYRUP}`),
  };
}

async function fetchDexPair() {
  const json = await fetchJson(`https://api.dexscreener.com/latest/dex/pairs/base/${BASE_AERODROME_POOL}`, 20_000);
  const pair = json?.pair || (Array.isArray(json?.pairs) ? json.pairs[0] : null);
  if (!pair) return null;
  return {
    chainId: pair.chainId || "base",
    dexId: pair.dexId || null,
    pairAddress: pair.pairAddress || BASE_AERODROME_POOL,
    priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
    priceNative: pair.priceNative ? Number(pair.priceNative) : null,
    liquidityUsd: pair.liquidity?.usd ? Number(pair.liquidity.usd) : null,
    volume24hUsd: pair.volume?.h24 ? Number(pair.volume.h24) : null,
    baseToken: pair.baseToken ? { address: pair.baseToken.address, symbol: pair.baseToken.symbol } : null,
    quoteToken: pair.quoteToken ? { address: pair.quoteToken.address, symbol: pair.quoteToken.symbol } : null,
  };
}

async function scanMaple(provider, prices) {
  const [poolMeta, asset, totalAssets, totalSupply, nav, exitNav, sharesForUsdc, bootstrapMint, maxDeposit, poolCash, routerCash, routerShares] = await Promise.all([
    tokenMeta(provider, MAINNET_SYRUP_POOL),
    safeCall(provider, MAINNET_SYRUP_POOL, MAPLE_POOL, "asset"),
    safeCall(provider, MAINNET_SYRUP_POOL, MAPLE_POOL, "totalAssets"),
    safeCall(provider, MAINNET_SYRUP_POOL, MAPLE_POOL, "totalSupply"),
    safeCall(provider, MAINNET_SYRUP_POOL, MAPLE_POOL, "convertToAssets", [1_000_000n]),
    safeCall(provider, MAINNET_SYRUP_POOL, MAPLE_POOL, "convertToExitAssets", [1_000_000n]),
    safeCall(provider, MAINNET_SYRUP_POOL, MAPLE_POOL, "convertToShares", [1_000_000n]),
    safeCall(provider, MAINNET_SYRUP_POOL, MAPLE_POOL, "BOOTSTRAP_MINT"),
    safeCall(provider, MAINNET_SYRUP_POOL, MAPLE_POOL, "maxDeposit", [PROBE_FROM]),
    erc20Balance(provider, MAINNET_USDC, MAINNET_SYRUP_POOL, 6),
    erc20Balance(provider, MAINNET_USDC, MAINNET_SYRUP_ROUTER, 6),
    erc20Balance(provider, MAINNET_SYRUP_POOL, MAINNET_SYRUP_ROUTER, 6),
  ]);
  const navAsset = nav.ok ? formatUnitsNumber(nav.value[0], 6) : null;
  const exitAsset = exitNav.ok ? formatUnitsNumber(exitNav.value[0], 6) : null;
  return {
    pool: MAINNET_SYRUP_POOL,
    router: MAINNET_SYRUP_ROUTER,
    token: poolMeta,
    asset: asset.ok ? ethers.getAddress(asset.value[0]) : null,
    totalAssetsRaw: totalAssets.ok ? totalAssets.value[0] : null,
    totalAssets: totalAssets.ok ? formatUnitsString(totalAssets.value[0], 6) : null,
    totalSupplyRaw: totalSupply.ok ? totalSupply.value[0] : null,
    totalSupply: totalSupply.ok ? formatUnitsString(totalSupply.value[0], poolMeta.decimals) : null,
    oneShareToAssetsRaw: nav.ok ? nav.value[0] : null,
    oneShareToAssets: navAsset,
    oneShareNavUsd: navAsset !== null ? navAsset * prices.mainnetUsdc : null,
    oneShareExitAssetsRaw: exitNav.ok ? exitNav.value[0] : null,
    oneShareExitAssets: exitAsset,
    oneShareExitUsd: exitAsset !== null ? exitAsset * prices.mainnetUsdc : null,
    oneUsdcToSharesRaw: sharesForUsdc.ok ? sharesForUsdc.value[0] : null,
    bootstrapMintRaw: bootstrapMint.ok ? bootstrapMint.value[0] : null,
    bootstrapMint: bootstrapMint.ok ? formatUnitsString(bootstrapMint.value[0], poolMeta.decimals) : null,
    maxDepositProbeRaw: maxDeposit.ok ? maxDeposit.value[0] : null,
    maxDepositProbe: maxDeposit.ok ? formatUnitsString(maxDeposit.value[0], 6) : null,
    poolCash,
    routerCash,
    routerShares,
    errors: {
      convertToAssets: nav.error || null,
      convertToExitAssets: exitNav.error || null,
      maxDeposit: maxDeposit.error || null,
    },
  };
}

async function scanBaseToken(provider) {
  const [meta, ccipAdmin, owner, defaultAdminRole, minterRole, burnerRole, mintProbe, burnProbe, burnFromProbe] = await Promise.all([
    tokenMeta(provider, BASE_SYRUP),
    safeCall(provider, BASE_SYRUP, TOKEN_ROLES, "getCCIPAdmin"),
    safeCall(provider, BASE_SYRUP, TOKEN_ROLES, "owner"),
    safeCall(provider, BASE_SYRUP, TOKEN_ROLES, "DEFAULT_ADMIN_ROLE"),
    safeCall(provider, BASE_SYRUP, TOKEN_ROLES, "MINTER_ROLE"),
    safeCall(provider, BASE_SYRUP, TOKEN_ROLES, "BURNER_ROLE"),
    safeEthCall(provider, { from: PROBE_FROM, to: BASE_SYRUP, data: TOKEN_ROLES.encodeFunctionData("mint", [PROBE_FROM, 1n]) }),
    safeEthCall(provider, { from: PROBE_FROM, to: BASE_SYRUP, data: TOKEN_ROLES.encodeFunctionData("burn", [1n]) }),
    safeEthCall(provider, { from: PROBE_FROM, to: BASE_SYRUP, data: TOKEN_ROLES.encodeFunctionData("burnFrom", [PROBE_FROM, 1n]) }),
  ]);
  async function hasRole(roleResult, account) {
    if (!roleResult.ok || !account) return null;
    const result = await safeCall(provider, BASE_SYRUP, TOKEN_ROLES, "hasRole", [roleResult.value[0], account]);
    return result.ok ? Boolean(result.value[0]) : null;
  }
  const admin = ccipAdmin.ok ? ethers.getAddress(ccipAdmin.value[0]) : (owner.ok ? ethers.getAddress(owner.value[0]) : null);
  return {
    token: meta,
    ccipAdmin: ccipAdmin.ok ? ethers.getAddress(ccipAdmin.value[0]) : null,
    owner: owner.ok ? ethers.getAddress(owner.value[0]) : null,
    roleChecks: {
      probeIsDefaultAdmin: await hasRole(defaultAdminRole, PROBE_FROM),
      probeIsMinter: await hasRole(minterRole, PROBE_FROM),
      probeIsBurner: await hasRole(burnerRole, PROBE_FROM),
      adminIsMinter: await hasRole(minterRole, admin),
      adminIsBurner: await hasRole(burnerRole, admin),
    },
    arbitrarySenderProbes: {
      mint: { ok: mintProbe.ok, error: mintProbe.error || null },
      burn: { ok: burnProbe.ok, error: burnProbe.error || null },
      burnFrom: { ok: burnFromProbe.ok, error: burnFromProbe.error || null },
    },
  };
}

async function scanAaveReserve(provider, asset, priceUsd) {
  const raw = await safeCall(provider, AAVE_POOL, AAVE_POOL_IFACE, "getReserveData", [asset]);
  if (!raw.ok) return { asset, error: raw.error };
  const config = decodeAaveConfig(BigInt(wordAt(raw.raw, 0) || 0n));
  const aToken = addressWordAt(raw.raw, 8) || addressWordAt(raw.raw, 9);
  const decimals = config.decimals || (await tokenMeta(provider, asset)).decimals;
  const cash = aToken ? await erc20Balance(provider, asset, aToken, decimals) : { raw: null, number: null, formatted: null };
  return {
    asset: ethers.getAddress(asset),
    config,
    aToken,
    cashRaw: cash.raw,
    cash: cash.formatted,
    cashUsd: Number.isFinite(cash.number) && Number.isFinite(priceUsd) ? cash.number * priceUsd : null,
  };
}

async function scanAave(provider, marketPriceUsd, prices) {
  const [unit, syrupPrice, syrupSource, sourceLatest, syrupReserve, usdcReserve, ghoReserve] = await Promise.all([
    safeCall(provider, AAVE_ORACLE, AAVE_ORACLE_IFACE, "BASE_CURRENCY_UNIT"),
    safeCall(provider, AAVE_ORACLE, AAVE_ORACLE_IFACE, "getAssetPrice", [BASE_SYRUP]),
    safeCall(provider, AAVE_ORACLE, AAVE_ORACLE_IFACE, "getSourceOfAsset", [BASE_SYRUP]),
    safeCall(provider, "0xa61f10Bb2f05A94728734A8a95673ADbCA9B8397", GENERIC_ORACLE, "latestRoundData"),
    scanAaveReserve(provider, BASE_SYRUP, marketPriceUsd),
    scanAaveReserve(provider, BASE_USDC, prices.baseUsdc),
    scanAaveReserve(provider, BASE_GHO, prices.baseGho),
  ]);
  const oracleUnit = unit.ok ? Number(unit.value[0]) : 1e8;
  const oracleUsd = syrupPrice.ok ? Number(syrupPrice.value[0]) / oracleUnit : null;
  const eModeCategoryId = syrupReserve.config?.eModeCategoryId || 0;
  const eModeRaw = eModeCategoryId ? await safeCall(provider, AAVE_POOL, AAVE_POOL_IFACE, "getEModeCategoryData", [eModeCategoryId]) : { ok: false };
  const eMode = eModeRaw.ok ? {
    id: eModeCategoryId,
    ltv: Number(eModeRaw.value[0]) / 10_000,
    liquidationThreshold: Number(eModeRaw.value[1]) / 10_000,
    liquidationBonus: Number(eModeRaw.value[2]) / 10_000,
    priceSource: ethers.getAddress(eModeRaw.value[3]),
    label: String(eModeRaw.value[4] || ""),
  } : null;
  const baseLtv = syrupReserve.config?.ltv || 0;
  const effectiveLtv = eMode?.ltv || baseLtv;
  const borrowablePerSyrupUsd = Number.isFinite(oracleUsd) ? oracleUsd * effectiveLtv : null;
  const bestBorrowCashUsd = Math.max(Number(usdcReserve.cashUsd || 0), Number(ghoReserve.cashUsd || 0));
  const edgeBps = bps(borrowablePerSyrupUsd, marketPriceUsd);
  const routePositive = Boolean(edgeBps !== null && edgeBps >= MIN_ROUTE_EDGE_BPS && bestBorrowCashUsd >= MIN_BORROW_CASH_USD && !syrupReserve.config?.paused && !syrupReserve.config?.frozen && syrupReserve.config?.active);
  return {
    pool: AAVE_POOL,
    oracle: AAVE_ORACLE,
    assetOraclePriceRaw: syrupPrice.ok ? syrupPrice.value[0] : null,
    oracleUnit,
    assetOraclePriceUsd: oracleUsd,
    sourceOfAsset: syrupSource.ok ? ethers.getAddress(syrupSource.value[0]) : null,
    sourceLatestRoundData: sourceLatest.ok ? {
      roundId: sourceLatest.value[0],
      answer: sourceLatest.value[1],
      startedAt: sourceLatest.value[2],
      updatedAt: sourceLatest.value[3],
      answeredInRound: sourceLatest.value[4],
    } : null,
    reserves: {
      syrupUSDC: { ...syrupReserve, expectedAToken: AAVE_SYRUP_ATOKEN },
      USDC: { ...usdcReserve, expectedAToken: AAVE_USDC_ATOKEN },
      GHO: { ...ghoReserve, expectedAToken: AAVE_GHO_ATOKEN },
    },
    eMode,
    routeModel: {
      route: "buy Base syrupUSDC -> supply Aave -> borrow USDC/GHO",
      marketPriceUsd,
      baseLtv,
      effectiveLtv,
      eModeCategoryId,
      borrowablePerSyrupUsd,
      edgeBps,
      bestBorrowCashUsd,
      minEdgeBps: MIN_ROUTE_EDGE_BPS,
      minBorrowCashUsd: MIN_BORROW_CASH_USD,
      routePositive,
      blockers: routePositive ? [] : lendingBlockers(edgeBps, bestBorrowCashUsd, syrupReserve.config),
    },
  };
}

function lendingBlockers(edgeBps, borrowCashUsd, config) {
  const blockers = [];
  if (edgeBps === null || edgeBps < MIN_ROUTE_EDGE_BPS) blockers.push("oracle LTV borrowable value is below current market cost plus edge threshold");
  if (!Number.isFinite(borrowCashUsd) || borrowCashUsd < MIN_BORROW_CASH_USD) blockers.push("borrow cash below route threshold");
  if (!config?.active) blockers.push("reserve/vault inactive");
  if (config?.paused) blockers.push("reserve/vault paused");
  if (config?.frozen) blockers.push("reserve/vault frozen");
  return blockers;
}

function loadDeployment(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function compactVaultData(row) {
  const cfg = row.configs || {};
  const totals = row.totalSupplyAndBorrow || {};
  const limits = row.limitsAndAvailability || {};
  const rates = row.exchangePricesAndRates || {};
  const constants = row.constantVariables || {};
  return { cfg, totals, limits, rates, constants };
}

async function scanFluid(provider, marketPriceUsd, prices) {
  const vaultDeployment = loadDeployment(FLUID_VAULT_RESOLVER_FILE);
  const dexDeployment = loadDeployment(FLUID_DEX_RESOLVER_FILE);
  const vaultResolver = new ethers.Contract(vaultDeployment.address, vaultDeployment.abi, provider);
  const dexResolver = new ethers.Contract(dexDeployment.address, dexDeployment.abi, provider);
  const vaults = [];
  for (const target of FLUID_VAULTS) {
    try {
      const row = await vaultResolver.getVaultEntireData(target.address);
      const { cfg, totals, limits, rates, constants } = compactVaultData(row);
      const cf = cfg.collateralFactor !== undefined ? Number(cfg.collateralFactor) / 10_000 : null;
      const debtPerCollateralUnit = target.collateralType === "single-token"
        ? fluidDebtPerCollateralUnit(cfg.oraclePriceOperate, target.supplyDecimals, target.borrowDecimals)
        : null;
      const borrowPrice = target.borrowToken.toLowerCase() === BASE_GHO.toLowerCase() ? prices.baseGho : prices.baseUsdc;
      const borrowablePerSyrupUsd = target.collateralType === "single-token" && Number.isFinite(debtPerCollateralUnit) && Number.isFinite(cf)
        ? debtPerCollateralUnit * cf * (Number.isFinite(borrowPrice) ? borrowPrice : 1)
        : null;
      const borrowableRaw = limits.borrowable ?? null;
      const borrowable = formatUnitsNumber(borrowableRaw, target.borrowDecimals);
      const borrowableUsd = Number.isFinite(borrowable) && Number.isFinite(borrowPrice) ? borrowable * borrowPrice : null;
      const edgeBps = target.collateralType === "single-token" ? bps(borrowablePerSyrupUsd, marketPriceUsd) : null;
      const activeConfig = { active: true, paused: false, frozen: false };
      const routePositive = Boolean(target.collateralType === "single-token" && edgeBps !== null && edgeBps >= MIN_ROUTE_EDGE_BPS && borrowableUsd >= MIN_BORROW_CASH_USD);
      const blockers = target.collateralType === "single-token"
        ? lendingBlockers(edgeBps, borrowableUsd, activeConfig)
        : ["smart-collateral LP route needs separate LP mint/withdraw and oracle-component proof", "single-token syrupUSDC market price is not enough to prove LP collateral extraction"];
      vaults.push({
        name: target.name,
        address: target.address,
        collateralType: target.collateralType,
        isSmartCol: Boolean(row.isSmartCol),
        isSmartDebt: Boolean(row.isSmartDebt),
        supplyToken: constants.supplyToken ? { token0: constants.supplyToken.token0, token1: constants.supplyToken.token1 } : constants.supplyToken || null,
        borrowToken: constants.borrowToken ? { token0: constants.borrowToken.token0, token1: constants.borrowToken.token1 } : constants.borrowToken || target.borrowToken,
        oracle: cfg.oracle || null,
        oraclePriceOperateRaw: cfg.oraclePriceOperate ?? null,
        oraclePriceLiquidateRaw: cfg.oraclePriceLiquidate ?? null,
        oracleDebtPerCollateralUnit: debtPerCollateralUnit,
        collateralFactor: cf,
        liquidationThreshold: cfg.liquidationThreshold !== undefined ? Number(cfg.liquidationThreshold) / 10_000 : null,
        liquidationMaxLimit: cfg.liquidationMaxLimit !== undefined ? Number(cfg.liquidationMaxLimit) / 10_000 : null,
        borrowFeeBps: cfg.borrowFee !== undefined ? Number(cfg.borrowFee) : null,
        totalSupplyRaw: totals.totalSupplyVault ?? null,
        totalBorrowRaw: totals.totalBorrowVault ?? null,
        borrowableRaw,
        borrowable,
        borrowableUsd,
        rates: {
          liquiditySupplyExchangePrice: rates.liquiditySupplyExchangePrice ?? null,
          liquidityBorrowExchangePrice: rates.liquidityBorrowExchangePrice ?? null,
          vaultSupplyExchangePrice: rates.vaultSupplyExchangePrice ?? null,
          vaultBorrowExchangePrice: rates.vaultBorrowExchangePrice ?? null,
        },
        routeModel: {
          route: target.collateralType === "single-token" ? `buy Base syrupUSDC -> supply Fluid ${target.name} -> borrow ${target.borrowSymbol}` : "supply Fluid syrupUSDC/USDC DEX shares -> borrow USDC",
          marketPriceUsd,
          borrowablePerSyrupUsd,
          edgeBps,
          minEdgeBps: MIN_ROUTE_EDGE_BPS,
          minBorrowCashUsd: MIN_BORROW_CASH_USD,
          routePositive,
          blockers,
        },
      });
    } catch (e) {
      vaults.push({ name: target.name, address: target.address, error: sanitizeError(e), routeModel: { routePositive: false, blockers: ["resolver read failed"] } });
    }
  }

  let dex = null;
  try {
    const row = await dexResolver.getDexEntireData.staticCall(FLUID_DEX);
    dex = {
      address: FLUID_DEX,
      token0: row.constantViews?.token0 || BASE_SYRUP,
      token1: row.constantViews?.token1 || BASE_USDC,
      centerPrice: row.dexState?.centerPrice ? rate27(row.dexState.centerPrice) : null,
      fee: row.configs?.fee !== undefined ? Number(row.configs.fee) : null,
      isSmartCollateralEnabled: row.configs?.isSmartCollateralEnabled ?? null,
      isSmartDebtEnabled: row.configs?.isSmartDebtEnabled ?? null,
      totalSupplyShares: row.dexState?.totalSupplyShares ?? null,
      totalBorrowShares: row.dexState?.totalBorrowShares ?? null,
    };
  } catch (e) {
    dex = { address: FLUID_DEX, error: sanitizeError(e) };
  }

  return { liquidity: FLUID_LIQUIDITY, resolver: vaultDeployment.address, dexResolver: dexDeployment.address, vaults, dex };
}

function routeRows(maple, dexPair, baseToken, aave, fluid) {
  const marketPriceUsd = dexPair?.priceUsd || baseToken?.token?.priceUsd || null;
  const navUsd = maple?.oneShareNavUsd ?? null;
  const exitUsd = maple?.oneShareExitUsd ?? null;
  const navSpreadBps = bps(marketPriceUsd, navUsd);
  const exitSpreadBps = bps(marketPriceUsd, exitUsd);
  const routes = [];
  routes.push({
    id: "eth-mint-bridge-base-sell",
    description: "Mint/redeem Maple syrupUSDC on Ethereum, bridge to Base, sell on Aerodrome",
    marketPriceUsd,
    navUsd,
    exitUsd,
    navSpreadBps,
    exitSpreadBps,
    routePositive: false,
    blockers: [
      exitSpreadBps !== null && exitSpreadBps >= MIN_ROUTE_EDGE_BPS ? "cross-chain bridge leg and Base sell quote need fork/proof" : "Base market price is not above Maple NAV/exit price by edge threshold",
      "Base token mint is role-gated BurnMint-style token; no public Base-side mint/redeem function",
      "cross-chain CCIP timing/fees are not atomic arbitrage proof",
    ],
  });
  routes.push({
    id: "base-buy-aave-borrow",
    description: "Buy Base syrupUSDC, supply to Aave V3 Base, borrow USDC/GHO",
    ...(aave?.routeModel || {}),
  });
  for (const vault of fluid?.vaults || []) {
    routes.push({
      id: `base-buy-fluid-${vault.name}`,
      description: vault.routeModel?.route || vault.name,
      ...(vault.routeModel || { routePositive: false }),
    });
  }
  return routes;
}

async function main() {
  const [ethRpc, baseRpc] = await Promise.all([resolveRpcUrl(ETHEREUM_CHAIN_ID), resolveRpcUrl(BASE_CHAIN_ID)]);
  if (!ethRpc || !baseRpc) throw new Error("missing required Ethereum/Base RPC from inventory");
  const eth = new ethers.JsonRpcProvider(ethRpc);
  const base = new ethers.JsonRpcProvider(baseRpc);
  const [ethBlock, baseBlock, prices, dexPair] = await Promise.all([
    eth.getBlockNumber(),
    base.getBlockNumber(),
    fetchPrices(),
    fetchDexPair(),
  ]);
  const [maple, baseToken] = await Promise.all([
    scanMaple(eth, prices),
    scanBaseToken(base),
  ]);
  baseToken.token.priceUsd = prices.baseSyrup;
  const marketPriceUsd = dexPair?.priceUsd || prices.baseSyrup || maple.oneShareNavUsd || null;
  const [aave, fluid] = await Promise.all([
    scanAave(base, marketPriceUsd, prices),
    scanFluid(base, marketPriceUsd, prices),
  ]);
  const routes = routeRows(maple, dexPair, baseToken, aave, fluid);
  const routePositive = routes.filter((r) => r.routePositive === true).length;
  const watchCandidates = routes.filter((r) => (r.edgeBps !== null && r.edgeBps !== undefined && r.edgeBps >= MIN_ROUTE_EDGE_BPS) || (r.exitSpreadBps !== null && r.exitSpreadBps !== undefined && r.exitSpreadBps >= MIN_ROUTE_EDGE_BPS)).length;
  const lendingEdges = routes.map((r) => r.edgeBps).filter((v) => v !== null && v !== undefined).map(Number).filter(Number.isFinite);
  const bestLendingEdgeBps = lendingEdges.length ? Math.max(...lendingEdges) : -Infinity;
  const out = {
    generatedAt: new Date().toISOString(),
    scope: "Base syrupUSDC public high-yield/consumer route scan",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    chainBlocks: { ethereum: ethBlock, base: baseBlock },
    thresholds: { minRouteEdgeBps: MIN_ROUTE_EDGE_BPS, minBorrowCashUsd: MIN_BORROW_CASH_USD, minNetProfitUsd: MIN_NET_PROFIT_USD },
    summary: {
      marketPriceUsd: round(marketPriceUsd, 8),
      mapleNavUsd: round(maple.oneShareNavUsd, 8),
      mapleExitUsd: round(maple.oneShareExitUsd, 8),
      navSpreadBps: round(bps(marketPriceUsd, maple.oneShareNavUsd), 2),
      exitSpreadBps: round(bps(marketPriceUsd, maple.oneShareExitUsd), 2),
      aaveBorrowableVsMarketBps: round(aave.routeModel.edgeBps, 2),
      fluidBestBorrowableVsMarketBps: Number.isFinite(bestLendingEdgeBps) ? round(bestLendingEdgeBps, 2) : null,
      watchCandidates,
      routePositive,
      signedActionJustified: false,
    },
    prices,
    maple,
    baseToken,
    dexPair,
    aave,
    fluid,
    routes,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
  console.log(`Wrote ${path.relative(WORKSPACE, OUT_FILE)}`);
  console.log(`Base syrupUSDC: routePositive=${routePositive}; watchCandidates=${watchCandidates}; market=$${round(marketPriceUsd, 6)}; Maple exit=$${round(maple.oneShareExitUsd, 6)}; Aave edge=${round(aave.routeModel.edgeBps, 2)}bps; Fluid best=${Number.isFinite(bestLendingEdgeBps) ? `${round(bestLendingEdgeBps, 2)}bps` : "n/a"}`);
}

main().catch((err) => {
  console.error(sanitizeError(err));
  process.exit(1);
});
