#!/usr/bin/env node
// Read-only ERC4626 consumer joiner.
// Joins low/zero-TVL ERC4626 vault alerts to lending/oracle consumers so E15
// can move from noisy vault discovery to exact fork-test candidates.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const VAULT_INVENTORY = path.join(WORKSPACE, "reports", "monitor", "vault-inventory.json");
const OUT = process.env.ERC4626_JOINER_OUT
  ? path.resolve(WORKSPACE, process.env.ERC4626_JOINER_OUT)
  : path.join(WORKSPACE, "reports", "raw", "fast", "erc4626-consumer-joiner.json");
const COMPOUND_DEPLOYMENTS = path.join(WORKSPACE, "targets", "compound-comet", "deployments");
const SILO_CORE_DEPLOYMENTS = path.join(WORKSPACE, "targets", "silo-contracts-v2", "silo-core", "deployments");

const TIMEOUT_MS = 15_000;
const LOW_TVL_USD = Number(process.env.ERC4626_JOINER_LOW_TVL_USD || "100000");
const ROUTE_LIQUIDITY_USD = Number(process.env.ERC4626_JOINER_ROUTE_LIQUIDITY_USD || "10000");
const MAX_VAULTS_PER_CHAIN = Number(process.env.ERC4626_JOINER_MAX_VAULTS_PER_CHAIN || "1000");
const MORPHO_MARKET_TOP_N = Number(process.env.ERC4626_JOINER_MORPHO_TOP_N || "500");
const MAX_EULER_VAULTS = Number(process.env.ERC4626_JOINER_MAX_EULER_VAULTS || "700");
const MAX_SILO_IDS = Number(process.env.ERC4626_JOINER_MAX_SILO_IDS || "700");
const BATCH_SIZE = 40;
const RPC_BATCH_SIZE = 20;
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const CHAINS = {
  1: {
    name: "Ethereum",
    coinSlug: "ethereum",
    morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    aavePool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    eulerFactory: "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e",
    siloFolder: "mainnet",
  },
  8453: {
    name: "Base",
    coinSlug: "base",
    morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    siloFolder: "base",
  },
};

const COMPOUND_NETWORK_BY_CHAIN = {
  1: "mainnet",
  8453: "base",
};

const VENUS_COMPTROLLERS = {
  1: { name: "Venus Ethereum", address: "0x687a01ecF6d3907658f7A7c714749fAC32336D1B" },
  8453: { name: "Venus Base Core", address: "0x0C7973F9598AA62f9e03B94E92C967fD5437426C" },
};

const ERC20 = new ethers.Interface([
  "function asset() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const COMET = new ethers.Interface([
  "function baseToken() view returns (address)",
  "function getAssetInfo(uint8 i) view returns (uint8 offset,address asset,address priceFeed,uint64 scale,uint64 borrowCollateralFactor,uint64 liquidateCollateralFactor,uint64 liquidationFactor,uint128 supplyCap)",
  "function numAssets() view returns (uint8)",
]);
const VENUS_COMPTROLLER = new ethers.Interface([
  "function getAllMarkets() view returns (address[])",
  "function markets(address vToken) view returns (bool isListed,uint256 collateralFactorMantissa,uint256 liquidationThresholdMantissa)",
]);
const VTOKEN = new ethers.Interface([
  "function getCash() view returns (uint256)",
  "function underlying() view returns (address)",
  "function symbol() view returns (string)",
]);
const AAVE_POOL = new ethers.Interface([
  "function ADDRESSES_PROVIDER() view returns (address)",
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns (tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
]);
const AAVE_ADDRESSES_PROVIDER = new ethers.Interface([
  "function getPriceOracle() view returns (address)",
]);
const AAVE_ORACLE = new ethers.Interface([
  "function getSourceOfAsset(address asset) view returns (address)",
]);
const GENERIC_FACTORY = new ethers.Interface([
  "function getProxyListLength() view returns (uint256)",
  "function getProxyListSlice(uint256 start,uint256 end) view returns (address[])",
]);
const EVAULT = new ethers.Interface([
  "function asset() view returns (address)",
  "function cash() view returns (uint256)",
  "function LTVBorrow(address collateral) view returns (uint16)",
  "function LTVList() view returns (address[])",
  "function oracle() view returns (address)",
  "function symbol() view returns (string)",
  "function totalBorrows() view returns (uint256)",
  "function unitOfAccount() view returns (address)",
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
const BEACON = new ethers.Interface([
  "function implementation() view returns (address)",
]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function normalizeAddress(value) {
  try {
    return ethers.getAddress(value);
  } catch (_) {
    return null;
  }
}

function lowerAddress(value) {
  const addr = normalizeAddress(value);
  return addr ? addr.toLowerCase() : null;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
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
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcPool(chainIds) {
  const urls = loadRpcUrls();
  const pool = {};
  for (const url of urls) {
    try {
      const idHex = await rpcCall(url, "eth_chainId", [], 6000);
      const chainId = Number(BigInt(idHex));
      if (chainIds.includes(chainId) && !pool[chainId]) pool[chainId] = url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return pool;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function safeProviderCall(provider, to, data) {
  try {
    return await provider.call({ to, data });
  } catch (_) {
    return null;
  }
}

function decodeResult(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try {
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
}

function addressFromStorageSlot(raw) {
  if (!raw || raw === "0x") return null;
  const hex = strip0x(raw).padStart(64, "0");
  if (/^0+$/.test(hex)) return null;
  return normalizeAddress(`0x${hex.slice(-40)}`);
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
  return addressFromStorageSlot(word);
}

async function firstContractAddress(provider, candidates) {
  for (const candidate of candidates.map(normalizeAddress).filter(Boolean)) {
    const code = await provider.getCode(candidate).catch(() => "0x");
    if (code && code !== "0x") return candidate;
  }
  return null;
}

async function safeGetStorage(provider, address, slot) {
  try {
    return await provider.getStorage(address, slot);
  } catch (_) {
    return null;
  }
}

async function getReferenceCodes(provider, address) {
  const target = normalizeAddress(address);
  if (!target) return [];

  const out = [];
  const targetCode = await provider.getCode(target).catch(() => "0x");
  if (targetCode && targetCode !== "0x") out.push({ kind: "target", address: target, code: targetCode });

  const impl = addressFromStorageSlot(await safeGetStorage(provider, target, EIP1967_IMPLEMENTATION_SLOT));
  if (impl) {
    const code = await provider.getCode(impl).catch(() => "0x");
    if (code && code !== "0x") out.push({ kind: "eip1967Implementation", address: impl, code });
  }

  const beacon = addressFromStorageSlot(await safeGetStorage(provider, target, EIP1967_BEACON_SLOT));
  if (beacon) {
    const implRaw = await safeProviderCall(provider, beacon, BEACON.encodeFunctionData("implementation", []));
    const decoded = decodeResult(implRaw, BEACON, "implementation");
    const beaconImpl = normalizeAddress(decoded?.[0]);
    if (beaconImpl) {
      const code = await provider.getCode(beaconImpl).catch(() => "0x");
      if (code && code !== "0x") out.push({ kind: "eip1967BeaconImplementation", beacon, address: beaconImpl, code });
    }
  }

  const seen = new Set();
  return out.filter((row) => {
    const key = `${row.kind}:${row.beacon || ""}:${row.address}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function findVaultReferencesInAddress(provider, address, vaults) {
  const rows = [];
  for (const codeRef of await getReferenceCodes(provider, address)) {
    for (const vault of codeReferencesVault(codeRef.code, vaults)) {
      rows.push({
        vault,
        reference: {
          address: codeRef.address,
          kind: codeRef.kind,
          beacon: codeRef.beacon || null,
          codeBytes: strip0x(codeRef.code).length / 2,
        },
      });
    }
  }
  return rows;
}

function decodeUint(raw) {
  if (!raw || raw === "0x") return null;
  try {
    return BigInt(raw);
  } catch (_) {
    return null;
  }
}

function decodeAddressResult(raw, fn) {
  if (!raw || raw === "0x") return null;
  try {
    return normalizeAddress(ERC20.decodeFunctionResult(fn, raw)[0]);
  } catch (_) {
    return null;
  }
}

function decodeUintResult(raw, fn) {
  if (!raw || raw === "0x") return null;
  try {
    return BigInt(ERC20.decodeFunctionResult(fn, raw)[0]);
  } catch (_) {
    return decodeUint(raw);
  }
}

function decodeStringResult(raw, fn) {
  if (!raw || raw === "0x") return null;
  try {
    return String(ERC20.decodeFunctionResult(fn, raw)[0]);
  } catch (_) {
    const hex = strip0x(raw);
    if (hex.length === 64) {
      return Buffer.from(hex, "hex").toString("utf8").replace(/\u0000+$/g, "") || null;
    }
    return null;
  }
}

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try {
    return Number(ethers.formatUnits(raw, Number(decimals)));
  } catch (_) {
    return null;
  }
}

function loadVaultInputs() {
  const inventory = readJson(VAULT_INVENTORY, { chains: {} });
  const byChain = {};
  for (const [chainIdText, row] of Object.entries(inventory.chains || {})) {
    const chainId = Number(chainIdText);
    if (!CHAINS[chainId]) continue;
    const out = [];
    for (const vault of row.vaults || []) {
      const address = normalizeAddress(vault.address);
      if (!address) continue;
      if (vault.flag && vault.flag !== "ERROR" && Number(vault.totalAssets || 0) <= LOW_TVL_USD) {
        out.push({
          chainId,
          chain: CHAINS[chainId].name,
          address,
          addressLower: address.toLowerCase(),
          deployBlock: vault.deployBlock || null,
          inventoryTotalAssets: vault.totalAssets ?? null,
          inventoryDecimals: vault.decimals ?? null,
          inventoryFlag: vault.flag,
        });
      }
    }
    byChain[chainId] = out.slice(0, MAX_VAULTS_PER_CHAIN);
  }
  return byChain;
}

async function enrichVault(provider, vault) {
  const [assetRaw, symbolRaw, nameRaw, decimalsRaw, totalAssetsRaw, totalSupplyRaw] = await Promise.all([
    safeProviderCall(provider, vault.address, ERC20.encodeFunctionData("asset", [])),
    safeProviderCall(provider, vault.address, ERC20.encodeFunctionData("symbol", [])),
    safeProviderCall(provider, vault.address, ERC20.encodeFunctionData("name", [])),
    safeProviderCall(provider, vault.address, ERC20.encodeFunctionData("decimals", [])),
    safeProviderCall(provider, vault.address, ERC20.encodeFunctionData("totalAssets", [])),
    safeProviderCall(provider, vault.address, ERC20.encodeFunctionData("totalSupply", [])),
  ]);
  const asset = decodeAddressResult(assetRaw, "asset");
  const vaultDecimalsRaw = decodeUintResult(decimalsRaw, "decimals");
  const vaultDecimals = vaultDecimalsRaw === null ? vault.inventoryDecimals ?? 18 : Number(vaultDecimalsRaw);
  const totalAssetsRawValue = decodeUintResult(totalAssetsRaw, "totalAssets");
  const totalSupplyRawValue = decodeUintResult(totalSupplyRaw, "totalSupply");

  let assetDecimals = null;
  if (asset) {
    const assetDecimalsRaw = await safeProviderCall(provider, asset, ERC20.encodeFunctionData("decimals", []));
    const decoded = decodeUintResult(assetDecimalsRaw, "decimals");
    assetDecimals = decoded === null ? null : Number(decoded);
  }

  let oneShareAssetsRaw = null;
  if (vaultDecimals !== null && vaultDecimals >= 0 && vaultDecimals <= 36) {
    const oneShare = 10n ** BigInt(vaultDecimals);
    const convertRaw = await safeProviderCall(provider, vault.address, ERC20.encodeFunctionData("convertToAssets", [oneShare]));
    oneShareAssetsRaw = decodeUintResult(convertRaw, "convertToAssets");
  }

  return {
    ...vault,
    symbol: decodeStringResult(symbolRaw, "symbol"),
    name: decodeStringResult(nameRaw, "name"),
    asset,
    assetLower: asset ? asset.toLowerCase() : null,
    vaultDecimals,
    assetDecimals,
    totalAssetsRaw: totalAssetsRawValue === null ? null : totalAssetsRawValue.toString(),
    totalSupplyRaw: totalSupplyRawValue === null ? null : totalSupplyRawValue.toString(),
    oneShareAssetsRaw: oneShareAssetsRaw === null ? null : oneShareAssetsRaw.toString(),
    totalAssets: formatUnitsNumber(totalAssetsRawValue, assetDecimals ?? vaultDecimals),
    totalSupply: formatUnitsNumber(totalSupplyRawValue, vaultDecimals),
    sharePriceAssets: formatUnitsNumber(oneShareAssetsRaw, assetDecimals ?? vaultDecimals),
  };
}

async function enrichVaults(provider, vaults) {
  const out = [];
  for (let i = 0; i < vaults.length; i += RPC_BATCH_SIZE) {
    const batch = vaults.slice(i, i + RPC_BATCH_SIZE);
    out.push(...await Promise.all(batch.map((v) => enrichVault(provider, v).catch((err) => ({ ...v, error: err.message || String(err) })))));
    process.stdout.write(`\r  Enriched ${Math.min(i + RPC_BATCH_SIZE, vaults.length)}/${vaults.length} vaults`);
  }
  if (vaults.length) console.log("");
  return out;
}

async function fetchPrices(chain, vaults) {
  return fetchAddressPrices(chain, vaults.flatMap((vault) => [vault.addressLower, vault.assetLower]).filter(Boolean));
}

async function fetchAddressPrices(chain, addresses) {
  const keys = [];
  for (const address of addresses || []) {
    const normalized = lowerAddress(address);
    if (normalized) keys.push(`${chain.coinSlug}:${normalized}`);
  }
  const uniq = [...new Set(keys.filter(Boolean).map((x) => x.toLowerCase()))];
  const out = {};
  for (let i = 0; i < uniq.length; i += 50) {
    const url = `https://coins.llama.fi/prices/current/${uniq.slice(i, i + 50).join(",")}?searchWidth=6h`;
    const json = await fetchJson(url, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    Object.assign(out, json.coins || {});
  }
  return out;
}

function pricesToAddressMap(chain, prices) {
  const out = new Map();
  for (const [key, value] of Object.entries(prices || {})) {
    const prefix = `${chain.coinSlug}:`.toLowerCase();
    if (!key.toLowerCase().startsWith(prefix)) continue;
    const address = lowerAddress(key.slice(prefix.length));
    const price = Number(value?.price || 0);
    if (address && Number.isFinite(price) && price > 0) out.set(address, price);
  }
  return out;
}

async function fetchVaultPricesLegacy(chain, vaults) {
  const keys = [];
  for (const vault of vaults) {
    keys.push(`${chain.coinSlug}:${vault.addressLower}`);
    if (vault.assetLower) keys.push(`${chain.coinSlug}:${vault.assetLower}`);
  }
  const uniq = [...new Set(keys.filter(Boolean).map((x) => x.toLowerCase()))];
  const out = {};
  for (let i = 0; i < uniq.length; i += 50) {
    const url = `https://coins.llama.fi/prices/current/${uniq.slice(i, i + 50).join(",")}?searchWidth=6h`;
    const json = await fetchJson(url, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    Object.assign(out, json.coins || {});
  }
  return out;
}

function addPriceFields(chain, vaults, prices) {
  for (const vault of vaults) {
    const vaultCoin = prices[`${chain.coinSlug}:${vault.addressLower}`];
    const assetCoin = vault.assetLower ? prices[`${chain.coinSlug}:${vault.assetLower}`] : null;
    vault.vaultPriceUsd = Number(vaultCoin?.price || 0) || null;
    vault.assetPriceUsd = Number(assetCoin?.price || 0) || null;
    vault.totalAssetsUsd = vault.assetPriceUsd && Number.isFinite(vault.totalAssets)
      ? vault.totalAssets * vault.assetPriceUsd
      : null;
  }
  return vaults;
}

async function morphoQuery(query, variables) {
  const json = await fetchJson("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    timeoutMs: 30_000,
  });
  if (json.errors) throw new Error(json.errors[0]?.message || "Morpho GraphQL error");
  return json.data?.markets?.items || [];
}

function morphoMarketFields() {
  return `
    marketId
    creationTimestamp
    loanAsset { symbol address decimals }
    collateralAsset { symbol address decimals }
    oracle { address }
    irmAddress
    lltv
    state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization }
  `;
}

async function fetchMorphoAssetConsumers(chainId, vaults, fieldName) {
  const query = `query($chainIds:[Int!]!, $assets:[String!]!) {
    markets(first:100, orderBy:SupplyAssetsUsd, orderDirection:Desc,
      where:{chainId_in:$chainIds, ${fieldName}:$assets}) { items { ${morphoMarketFields()} } }
  }`;
  const out = [];
  const assets = vaults.map((v) => v.addressLower);
  for (let i = 0; i < assets.length; i += BATCH_SIZE) {
    const batch = assets.slice(i, i + BATCH_SIZE);
    out.push(...await morphoQuery(query, { chainIds: [chainId], assets: batch }).catch(() => []));
  }
  return out;
}

async function fetchTopMorphoMarkets(chainId) {
  const query = `query($chainIds:[Int!]!, $minSupply:Float!) {
    markets(first:${MORPHO_MARKET_TOP_N}, orderBy:SupplyAssetsUsd, orderDirection:Desc,
      where:{chainId_in:$chainIds, supplyAssetsUsd_gte:$minSupply}) { items { ${morphoMarketFields()} } }
  }`;
  return morphoQuery(query, { chainIds: [chainId], minSupply: 1 }).catch(() => []);
}

function marketKey(market) {
  return `${market.marketId || "unknown"}:${market.oracle?.address || ""}:${market.loanAsset?.address || ""}:${market.collateralAsset?.address || ""}`.toLowerCase();
}

function lltvPct(lltv) {
  try {
    return Number(BigInt(String(lltv))) / 1e16;
  } catch (_) {
    const n = Number(lltv);
    return Number.isFinite(n) ? n * 100 : null;
  }
}

function toNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function classifyCandidate(vault, side, market, reason) {
  const liquidityUsd = toNumber(market.state?.liquidityAssetsUsd);
  const borrowUsd = toNumber(market.state?.borrowAssetsUsd);
  const supplyUsd = toNumber(market.state?.supplyAssetsUsd);
  const lowTvlUsd = vault.totalAssetsUsd === null || vault.totalAssetsUsd === undefined
    ? Number(vault.inventoryTotalAssets || 0)
    : vault.totalAssetsUsd;
  const watchCandidate = side !== "loanAsset"
    && liquidityUsd >= ROUTE_LIQUIDITY_USD
    && lowTvlUsd <= LOW_TVL_USD;
  return {
    type: "morpho-blue-consumer",
    side,
    reason,
    routePositive: false,
    watchCandidate,
    blockers: watchCandidate
      ? ["Needs route-specific oracle/source review", "Needs fork proof for donation/share-price manipulation", "No executor or artifact gate"]
      : ["No current route-positive proof", liquidityUsd < ROUTE_LIQUIDITY_USD ? "Borrow liquidity below threshold" : null, side === "loanAsset" ? "Vault is loan asset, not collateral/oracle input" : null].filter(Boolean),
    market: {
      marketId: market.marketId,
      loanAsset: market.loanAsset,
      collateralAsset: market.collateralAsset,
      oracle: market.oracle,
      irmAddress: market.irmAddress,
      lltvRaw: market.lltv,
      lltvPct: lltvPct(market.lltv),
      supplyAssetsUsd: supplyUsd,
      borrowAssetsUsd: borrowUsd,
      liquidityAssetsUsd: liquidityUsd,
      utilization: market.state?.utilization ?? null,
    },
  };
}

function classifyCompoundCandidate(vault, consumer, reason) {
  const liquidityUsd = Number(consumer.baseCashUsd || 0);
  const lowTvlUsd = vault.totalAssetsUsd === null || vault.totalAssetsUsd === undefined
    ? Number(vault.inventoryTotalAssets || 0)
    : vault.totalAssetsUsd;
  const watchCandidate = consumer.side !== "loanAsset"
    && liquidityUsd >= ROUTE_LIQUIDITY_USD
    && lowTvlUsd <= LOW_TVL_USD
    && Number(consumer.borrowCollateralFactor || 0) > 0;
  return {
    type: "compound-v3-consumer",
    side: consumer.side,
    reason,
    routePositive: false,
    watchCandidate,
    blockers: watchCandidate
      ? ["Needs Compound route-specific fork proof", "Needs oracle/share-price manipulation proof", "No executor or artifact gate"]
      : [
          "No current route-positive proof",
          liquidityUsd < ROUTE_LIQUIDITY_USD ? "Base borrow liquidity below threshold" : null,
          Number(consumer.borrowCollateralFactor || 0) <= 0 ? "Collateral factor disabled" : null,
          consumer.side === "priceFeedBytecodeReference" ? "Only bytecode reference; needs source-level oracle confirmation" : null,
        ].filter(Boolean),
    market: consumer,
  };
}

function classifyVenusCandidate(vault, consumer, reason) {
  const liquidityUsd = Number(consumer.otherMarketCashUsd || 0);
  const lowTvlUsd = vault.totalAssetsUsd === null || vault.totalAssetsUsd === undefined
    ? Number(vault.inventoryTotalAssets || 0)
    : vault.totalAssetsUsd;
  const watchCandidate = liquidityUsd >= ROUTE_LIQUIDITY_USD
    && lowTvlUsd <= LOW_TVL_USD
    && Number(consumer.collateralFactor || 0) > 0;
  return {
    type: "venus-consumer",
    side: "underlyingCollateral",
    reason,
    routePositive: false,
    watchCandidate,
    blockers: watchCandidate
      ? ["Needs Venus route-specific fork proof", "Needs oracle/source manipulation proof", "No executor or artifact gate"]
      : [
          "No current route-positive proof",
          liquidityUsd < ROUTE_LIQUIDITY_USD ? "Other-market borrow liquidity below threshold" : null,
          Number(consumer.collateralFactor || 0) <= 0 ? "Collateral factor disabled" : null,
        ].filter(Boolean),
    market: consumer,
  };
}

function classifyAaveCandidate(vault, consumer, reason) {
  const liquidityUsd = Number(consumer.otherReserveCashUsd || 0);
  const lowTvlUsd = vault.totalAssetsUsd === null || vault.totalAssetsUsd === undefined
    ? Number(vault.inventoryTotalAssets || 0)
    : vault.totalAssetsUsd;
  const ltv = Number(consumer.ltv || 0);
  const watchCandidate = liquidityUsd >= ROUTE_LIQUIDITY_USD
    && lowTvlUsd <= LOW_TVL_USD
    && ltv > 0
    && consumer.active
    && !consumer.paused
    && !consumer.frozen;
  return {
    type: "aave-v3-consumer",
    side: consumer.side,
    reason,
    routePositive: false,
    watchCandidate,
    blockers: watchCandidate
      ? ["Needs Aave route-specific fork proof", "Needs oracle/share-price manipulation proof", "No executor or artifact gate"]
      : [
          "No current route-positive proof",
          liquidityUsd < ROUTE_LIQUIDITY_USD ? "Other-reserve borrow liquidity below threshold" : null,
          ltv <= 0 ? "Collateral LTV disabled" : null,
          !consumer.active ? "Reserve inactive" : null,
          consumer.paused ? "Reserve paused" : null,
          consumer.frozen ? "Reserve frozen" : null,
          consumer.side === "priceSourceBytecodeReference" ? "Only bytecode reference; needs source-level oracle confirmation" : null,
        ].filter(Boolean),
    market: consumer,
  };
}

function classifyEulerCandidate(vault, consumer, reason) {
  const liquidityUsd = Number(consumer.cashUsd || 0);
  const lowTvlUsd = vault.totalAssetsUsd === null || vault.totalAssetsUsd === undefined
    ? Number(vault.inventoryTotalAssets || 0)
    : vault.totalAssetsUsd;
  const ltv = Number(consumer.borrowLtv || consumer.maxBorrowLtv || 0);
  const watchCandidate = consumer.side !== "borrowAsset"
    && liquidityUsd >= ROUTE_LIQUIDITY_USD
    && lowTvlUsd <= LOW_TVL_USD
    && ltv > 0;
  return {
    type: "euler-evk-consumer",
    side: consumer.side,
    reason,
    routePositive: false,
    watchCandidate,
    blockers: watchCandidate
      ? ["Needs Euler route-specific fork proof", "Needs oracle/share-price manipulation proof", "No executor or artifact gate"]
      : [
          "No current route-positive proof",
          liquidityUsd < ROUTE_LIQUIDITY_USD ? "Debt-vault cash below threshold" : null,
          ltv <= 0 ? "Borrow LTV disabled or unconfirmed" : null,
          consumer.side === "borrowAsset" ? "Vault is borrow asset, not collateral/oracle input" : null,
          consumer.side === "oracleBytecodeReference" ? "Only bytecode reference; needs source-level oracle pair confirmation" : null,
        ].filter(Boolean),
    market: consumer,
  };
}

function classifySiloCandidate(vault, consumer, reason) {
  const liquidityUsd = Number(consumer.oppositeLiquidityUsd || 0);
  const lowTvlUsd = vault.totalAssetsUsd === null || vault.totalAssetsUsd === undefined
    ? Number(vault.inventoryTotalAssets || 0)
    : vault.totalAssetsUsd;
  const maxLtv = Number(consumer.maxLtv || 0);
  const watchCandidate = liquidityUsd >= ROUTE_LIQUIDITY_USD
    && lowTvlUsd <= LOW_TVL_USD
    && maxLtv > 0;
  return {
    type: "silo-v3-consumer",
    side: consumer.side,
    reason,
    routePositive: false,
    watchCandidate,
    blockers: watchCandidate
      ? ["Needs Silo route-specific fork proof", "Needs oracle/share-price manipulation proof", "No executor or artifact gate"]
      : [
          "No current route-positive proof",
          liquidityUsd < ROUTE_LIQUIDITY_USD ? "Opposite-silo borrow liquidity below threshold" : null,
          maxLtv <= 0 ? "Max LTV disabled" : null,
          consumer.side === "oracleBytecodeReference" ? "Only bytecode reference; needs source-level oracle confirmation" : null,
        ].filter(Boolean),
    market: consumer,
  };
}

function loadCompoundComets(chainId) {
  const network = COMPOUND_NETWORK_BY_CHAIN[chainId];
  if (!network) return [];
  const dir = path.join(COMPOUND_DEPLOYMENTS, network);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const marketName of fs.readdirSync(dir)) {
    const roots = readJson(path.join(dir, marketName, "roots.json"), null);
    const comet = normalizeAddress(roots?.comet);
    if (!comet) continue;
    out.push({ protocol: "Compound V3", marketName, comet, configurator: normalizeAddress(roots?.configurator) });
  }
  return out;
}

function loadSiloDeployment(chainId, name) {
  const folder = CHAINS[chainId]?.siloFolder;
  if (!folder) return null;
  const file = path.join(SILO_CORE_DEPLOYMENTS, folder, `${name}.sol.json`);
  const json = readJson(file, null);
  return normalizeAddress(json?.address);
}

function decodeAaveConfig(data) {
  const raw = BigInt(data || 0n);
  const mask16 = 0xffffn;
  const mask36 = (1n << 36n) - 1n;
  return {
    data: raw.toString(),
    ltv: Number(raw & mask16) / 10_000,
    liquidationThreshold: Number((raw >> 16n) & mask16) / 10_000,
    liquidationBonus: Number((raw >> 32n) & mask16) / 10_000,
    decimals: Number((raw >> 48n) & 0xffn),
    active: Boolean((raw >> 56n) & 1n),
    frozen: Boolean((raw >> 57n) & 1n),
    borrowingEnabled: Boolean((raw >> 58n) & 1n),
    paused: Boolean((raw >> 60n) & 1n),
    borrowCapWholeTokens: ((raw >> 80n) & mask36).toString(),
    supplyCapWholeTokens: ((raw >> 116n) & mask36).toString(),
  };
}

function ltvBpsToRatio(value) {
  return Number(value || 0) / 10_000;
}

function siloLtvToRatio(value) {
  return Number(value || 0n) / 1e18;
}

async function erc20Decimals(provider, token) {
  const raw = await safeProviderCall(provider, token, ERC20.encodeFunctionData("decimals", []));
  const decoded = decodeUintResult(raw, "decimals");
  return decoded === null ? 18 : Number(decoded);
}

async function erc20Balance(provider, token, account) {
  const raw = await safeProviderCall(provider, token, ERC20.encodeFunctionData("balanceOf", [account]));
  return decodeUintResult(raw, "balanceOf") || 0n;
}

function codeReferencesVault(code, vaults) {
  const lowerCode = strip0x(code).toLowerCase();
  if (!lowerCode) return [];
  return vaults.filter((vault) => lowerCode.includes(strip0x(vault.addressLower)));
}

async function fetchCompoundConsumers(provider, chain, chainId, vaults) {
  const vaultByAddress = new Map(vaults.map((v) => [v.addressLower, v]));
  const comets = loadCompoundComets(chainId);
  const rawRows = [];
  const priceFeedRows = [];
  const baseTokens = new Set();

  for (const cometRow of comets) {
    const code = await provider.getCode(cometRow.comet).catch(() => "0x");
    if (!code || code === "0x") continue;
    const [baseRaw, numAssetsRaw] = await Promise.all([
      safeProviderCall(provider, cometRow.comet, COMET.encodeFunctionData("baseToken", [])),
      safeProviderCall(provider, cometRow.comet, COMET.encodeFunctionData("numAssets", [])),
    ]);
    let baseToken = decodeAddressResult(baseRaw, "asset");
    if (!baseToken) {
      try { [baseToken] = COMET.decodeFunctionResult("baseToken", baseRaw); } catch (_) { baseToken = null; }
    }
    const numAssets = Number(decodeUintResult(numAssetsRaw, "decimals") || 0n);
    if (baseToken) baseTokens.add(baseToken.toLowerCase());

    for (let i = 0; i < numAssets; i++) {
      const raw = await safeProviderCall(provider, cometRow.comet, COMET.encodeFunctionData("getAssetInfo", [i]));
      if (!raw) continue;
      let decoded;
      try { decoded = COMET.decodeFunctionResult("getAssetInfo", raw); } catch (_) { continue; }
      const asset = normalizeAddress(decoded.asset);
      const priceFeed = normalizeAddress(decoded.priceFeed);
      if (!asset) continue;
      const consumer = {
        ...cometRow,
        side: "collateralAsset",
        baseToken,
        asset,
        priceFeed,
        assetIndex: i,
        borrowCollateralFactor: Number(decoded.borrowCollateralFactor) / 1e18,
        liquidateCollateralFactor: Number(decoded.liquidateCollateralFactor) / 1e18,
        liquidationFactor: Number(decoded.liquidationFactor) / 1e18,
        supplyCapRaw: decoded.supplyCap.toString(),
      };
      const vault = vaultByAddress.get(asset.toLowerCase());
      if (vault) rawRows.push({ vault, consumer, reason: "vault is Compound V3 collateral asset" });
      if (priceFeed) priceFeedRows.push({ ...consumer, side: "priceFeedBytecodeReference" });
    }
  }

  const basePrices = pricesToAddressMap(chain, await fetchAddressPrices(chain, [...baseTokens]));
  const baseMeta = new Map();
  for (const baseToken of baseTokens) {
    const token = normalizeAddress(baseToken);
    if (!token) continue;
    const decimals = await erc20Decimals(provider, token).catch(() => 18);
    baseMeta.set(token.toLowerCase(), { decimals, priceUsd: basePrices.get(token.toLowerCase()) || null });
  }

  for (const row of rawRows) {
    const token = row.consumer.baseToken ? row.consumer.baseToken.toLowerCase() : null;
    const meta = token ? baseMeta.get(token) : null;
    const cashRaw = token ? await erc20Balance(provider, row.consumer.baseToken, row.consumer.comet).catch(() => 0n) : 0n;
    row.consumer.baseCashRaw = cashRaw.toString();
    row.consumer.baseCash = formatUnitsNumber(cashRaw, meta?.decimals ?? 18);
    row.consumer.baseCashUsd = meta?.priceUsd && Number.isFinite(row.consumer.baseCash) ? row.consumer.baseCash * meta.priceUsd : 0;
  }

  const bytecodeRows = [];
  const uniqueFeeds = [...new Set(priceFeedRows.map((r) => r.priceFeed?.toLowerCase()).filter(Boolean))];
  for (let i = 0; i < uniqueFeeds.length; i += RPC_BATCH_SIZE) {
    const batch = uniqueFeeds.slice(i, i + RPC_BATCH_SIZE);
    const refs = await Promise.all(batch.map(async (feed) => ({ feed, refs: await findVaultReferencesInAddress(provider, feed, vaults).catch(() => []) })));
    for (const { feed, refs: matchedRefs } of refs) {
      if (!matchedRefs.length) continue;
      for (const consumer of priceFeedRows.filter((r) => r.priceFeed?.toLowerCase() === feed)) {
        for (const ref of matchedRefs) bytecodeRows.push({ vault: ref.vault, consumer: { ...consumer, priceFeedReference: ref.reference }, reason: "vault address appears in Compound V3 price-feed/proxy implementation bytecode" });
      }
    }
  }

  return [...rawRows, ...bytecodeRows];
}

async function fetchVenusConsumers(provider, chain, chainId, vaults) {
  const cfg = VENUS_COMPTROLLERS[chainId];
  if (!cfg) return [];
  const vaultByAddress = new Map(vaults.map((v) => [v.addressLower, v]));
  const marketsRaw = await safeProviderCall(provider, cfg.address, VENUS_COMPTROLLER.encodeFunctionData("getAllMarkets", []));
  if (!marketsRaw) return [];
  let markets = [];
  try { [markets] = VENUS_COMPTROLLER.decodeFunctionResult("getAllMarkets", marketsRaw); } catch (_) { return []; }

  const rows = [];
  const marketMetas = [];
  const underlyings = new Set();
  for (const vToken of markets.map(normalizeAddress).filter(Boolean)) {
    const [underlyingRaw, symbolRaw, marketRaw, cashRaw] = await Promise.all([
      safeProviderCall(provider, vToken, VTOKEN.encodeFunctionData("underlying", [])),
      safeProviderCall(provider, vToken, VTOKEN.encodeFunctionData("symbol", [])),
      safeProviderCall(provider, cfg.address, VENUS_COMPTROLLER.encodeFunctionData("markets", [vToken])),
      safeProviderCall(provider, vToken, VTOKEN.encodeFunctionData("getCash", [])),
    ]);
    let underlying = null;
    try { [underlying] = VTOKEN.decodeFunctionResult("underlying", underlyingRaw); underlying = normalizeAddress(underlying); } catch (_) {}
    if (!underlying) continue;
    let decodedMarket = null;
    try { decodedMarket = VENUS_COMPTROLLER.decodeFunctionResult("markets", marketRaw); } catch (_) {}
    const cash = decodeUintResult(cashRaw, "getCash") || 0n;
    underlyings.add(underlying.toLowerCase());
    marketMetas.push({
      protocol: cfg.name,
      comptroller: cfg.address,
      vToken,
      symbol: decodeStringResult(symbolRaw, "symbol"),
      underlying,
      isListed: Boolean(decodedMarket?.isListed ?? decodedMarket?.[0]),
      collateralFactor: Number(decodedMarket?.collateralFactorMantissa ?? decodedMarket?.[1] ?? 0n) / 1e18,
      liquidationThreshold: Number(decodedMarket?.liquidationThresholdMantissa ?? decodedMarket?.[2] ?? 0n) / 1e18,
      cashRaw: cash.toString(),
    });
  }

  const prices = pricesToAddressMap(chain, await fetchAddressPrices(chain, [...underlyings]));
  let otherMarketCashUsd = 0;
  for (const meta of marketMetas) {
    const decimals = await erc20Decimals(provider, meta.underlying).catch(() => 18);
    meta.underlyingDecimals = decimals;
    meta.cash = formatUnitsNumber(BigInt(meta.cashRaw), decimals);
    meta.cashUsd = (prices.get(meta.underlying.toLowerCase()) || 0) * (Number(meta.cash) || 0);
  }
  otherMarketCashUsd = marketMetas.reduce((sum, m) => sum + Number(m.cashUsd || 0), 0);

  for (const meta of marketMetas) {
    const vault = vaultByAddress.get(meta.underlying.toLowerCase());
    if (!vault) continue;
    rows.push({ vault, consumer: { ...meta, otherMarketCashUsd: Math.max(0, otherMarketCashUsd - Number(meta.cashUsd || 0)) }, reason: "vault is Venus underlying collateral market" });
  }
  return rows;
}

async function fetchAaveConsumers(provider, chain, chainId, vaults) {
  const pool = normalizeAddress(CHAINS[chainId]?.aavePool);
  if (!pool) return [];
  const vaultByAddress = new Map(vaults.map((v) => [v.addressLower, v]));
  const reservesRaw = await safeProviderCall(provider, pool, AAVE_POOL.encodeFunctionData("getReservesList", []));
  const reservesDecoded = decodeResult(reservesRaw, AAVE_POOL, "getReservesList");
  const reserves = (reservesDecoded?.[0] || []).map(normalizeAddress).filter(Boolean);
  if (!reserves.length) return [];

  const providerRaw = await safeProviderCall(provider, pool, AAVE_POOL.encodeFunctionData("ADDRESSES_PROVIDER", []));
  const addressesProvider = normalizeAddress(decodeResult(providerRaw, AAVE_POOL, "ADDRESSES_PROVIDER")?.[0]);
  let priceOracle = null;
  if (addressesProvider) {
    const oracleRaw = await safeProviderCall(provider, addressesProvider, AAVE_ADDRESSES_PROVIDER.encodeFunctionData("getPriceOracle", []));
    priceOracle = normalizeAddress(decodeResult(oracleRaw, AAVE_ADDRESSES_PROVIDER, "getPriceOracle")?.[0]);
  }

  const metas = [];
  for (const reserve of reserves) {
    const [dataRaw, symbolRaw] = await Promise.all([
      safeProviderCall(provider, pool, AAVE_POOL.encodeFunctionData("getReserveData", [reserve])),
      safeProviderCall(provider, reserve, ERC20.encodeFunctionData("symbol", [])),
    ]);
    if (!dataRaw || dataRaw === "0x") continue;
    const cfg = decodeAaveConfig(BigInt(wordAt(dataRaw, 0) || 0n));
    const aToken = await firstContractAddress(provider, [addressWordAt(dataRaw, 8), addressWordAt(dataRaw, 9)]);
    const variableDebtToken = await firstContractAddress(provider, [addressWordAt(dataRaw, 10), addressWordAt(dataRaw, 11)]);
    const priceSource = priceOracle
      ? normalizeAddress(decodeResult(
        await safeProviderCall(provider, priceOracle, AAVE_ORACLE.encodeFunctionData("getSourceOfAsset", [reserve])),
        AAVE_ORACLE,
        "getSourceOfAsset",
      )?.[0])
      : null;
    const decimals = cfg.decimals || await erc20Decimals(provider, reserve).catch(() => 18);
    const cashRaw = aToken ? await erc20Balance(provider, reserve, aToken).catch(() => 0n) : 0n;
    metas.push({
      protocol: "Aave V3",
      pool,
      addressesProvider,
      priceOracle,
      reserve,
      symbol: decodeStringResult(symbolRaw, "symbol"),
      aToken,
      variableDebtToken,
      priceSource,
      cashRaw: cashRaw.toString(),
      cash: formatUnitsNumber(cashRaw, decimals),
      ...cfg,
    });
  }

  const prices = pricesToAddressMap(chain, await fetchAddressPrices(chain, metas.map((m) => m.reserve)));
  for (const meta of metas) meta.cashUsd = (prices.get(meta.reserve.toLowerCase()) || 0) * (Number(meta.cash) || 0);
  const borrowableCashUsd = metas
    .filter((m) => m.active && !m.paused && m.borrowingEnabled)
    .reduce((sum, m) => sum + Number(m.cashUsd || 0), 0);

  const rows = [];
  for (const meta of metas) {
    const vault = vaultByAddress.get(meta.reserve.toLowerCase());
    if (!vault) continue;
    rows.push({
      vault,
      consumer: { ...meta, side: "reserveAsset", otherReserveCashUsd: Math.max(0, borrowableCashUsd - Number(meta.cashUsd || 0)) },
      reason: "vault is Aave V3 reserve asset",
    });
  }

  const uniqueSources = [...new Set(metas.map((m) => m.priceSource?.toLowerCase()).filter(Boolean))];
  for (let i = 0; i < uniqueSources.length; i += RPC_BATCH_SIZE) {
    const batch = uniqueSources.slice(i, i + RPC_BATCH_SIZE);
    const refs = await Promise.all(batch.map(async (source) => ({ source, refs: await findVaultReferencesInAddress(provider, source, vaults).catch(() => []) })));
    for (const { source, refs: matchedRefs } of refs) {
      if (!matchedRefs.length) continue;
      for (const meta of metas.filter((m) => m.priceSource?.toLowerCase() === source)) {
        for (const ref of matchedRefs) {
          rows.push({
            vault: ref.vault,
            consumer: { ...meta, side: "priceSourceBytecodeReference", priceSourceReference: ref.reference, otherReserveCashUsd: Math.max(0, borrowableCashUsd - Number(meta.cashUsd || 0)) },
            reason: "vault address appears in Aave price-source/proxy implementation bytecode",
          });
        }
      }
    }
  }

  rows.stats = { reservesScanned: metas.length, priceSourcesScanned: uniqueSources.length };
  return rows;
}

async function fetchEulerConsumers(provider, chain, chainId, vaults) {
  const factory = normalizeAddress(CHAINS[chainId]?.eulerFactory);
  if (!factory) return [];
  const vaultByAddress = new Map(vaults.map((v) => [v.addressLower, v]));
  const lengthRaw = await safeProviderCall(provider, factory, GENERIC_FACTORY.encodeFunctionData("getProxyListLength", []));
  const length = Number(decodeResult(lengthRaw, GENERIC_FACTORY, "getProxyListLength")?.[0] || 0n);
  if (!length) return [];
  const start = Math.max(0, length - MAX_EULER_VAULTS);
  const evaults = [];
  for (let cursor = start; cursor < length; cursor += 100) {
    const end = Math.min(length, cursor + 100);
    const raw = await safeProviderCall(provider, factory, GENERIC_FACTORY.encodeFunctionData("getProxyListSlice", [cursor, end]));
    const decoded = decodeResult(raw, GENERIC_FACTORY, "getProxyListSlice");
    evaults.push(...(decoded?.[0] || []).map(normalizeAddress).filter(Boolean));
  }

  const metas = [];
  for (let i = 0; i < evaults.length; i += RPC_BATCH_SIZE) {
    const batch = evaults.slice(i, i + RPC_BATCH_SIZE);
    const rows = await Promise.all(batch.map(async (evault) => {
      const [assetRaw, oracleRaw, unitRaw, cashRaw, borrowsRaw, symbolRaw, ltvListRaw] = await Promise.all([
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("asset", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("oracle", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("unitOfAccount", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("cash", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("totalBorrows", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("symbol", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("LTVList", [])),
      ]);
      const asset = normalizeAddress(decodeResult(assetRaw, EVAULT, "asset")?.[0]);
      if (!asset) return null;
      const ltvList = (decodeResult(ltvListRaw, EVAULT, "LTVList")?.[0] || []).map(normalizeAddress).filter(Boolean);
      const ltvEntries = [];
      for (const collateral of ltvList.slice(0, 40)) {
        const raw = await safeProviderCall(provider, evault, EVAULT.encodeFunctionData("LTVBorrow", [collateral]));
        const ltv = ltvBpsToRatio(decodeResult(raw, EVAULT, "LTVBorrow")?.[0] || 0);
        ltvEntries.push({ collateral, borrowLtv: ltv });
      }
      const cash = decodeResult(cashRaw, EVAULT, "cash")?.[0] || 0n;
      const borrows = decodeResult(borrowsRaw, EVAULT, "totalBorrows")?.[0] || 0n;
      return {
        protocol: "Euler EVK",
        factory,
        evault,
        asset,
        symbol: decodeStringResult(symbolRaw, "symbol"),
        oracle: normalizeAddress(decodeResult(oracleRaw, EVAULT, "oracle")?.[0]),
        unitOfAccount: normalizeAddress(decodeResult(unitRaw, EVAULT, "unitOfAccount")?.[0]),
        cashRaw: cash.toString(),
        totalBorrowsRaw: borrows.toString(),
        ltvEntries,
        maxBorrowLtv: ltvEntries.reduce((max, row) => Math.max(max, Number(row.borrowLtv || 0)), 0),
      };
    }));
    metas.push(...rows.filter(Boolean));
  }

  const prices = pricesToAddressMap(chain, await fetchAddressPrices(chain, metas.map((m) => m.asset)));
  for (const meta of metas) {
    const decimals = await erc20Decimals(provider, meta.asset).catch(() => 18);
    meta.assetDecimals = decimals;
    meta.cash = formatUnitsNumber(BigInt(meta.cashRaw), decimals);
    meta.totalBorrows = formatUnitsNumber(BigInt(meta.totalBorrowsRaw), decimals);
    meta.cashUsd = (prices.get(meta.asset.toLowerCase()) || 0) * (Number(meta.cash) || 0);
  }

  const rows = [];
  for (const meta of metas) {
    const borrowVault = vaultByAddress.get(meta.asset.toLowerCase());
    if (borrowVault) rows.push({ vault: borrowVault, consumer: { ...meta, side: "borrowAsset" }, reason: "vault is Euler EVK borrow vault asset" });
    for (const ltv of meta.ltvEntries) {
      const collateralVault = vaultByAddress.get(ltv.collateral.toLowerCase());
      if (!collateralVault) continue;
      rows.push({ vault: collateralVault, consumer: { ...meta, side: "collateralVault", collateral: ltv.collateral, borrowLtv: ltv.borrowLtv }, reason: "vault is Euler EVK configured collateral" });
    }
  }

  const oracleMarkets = new Map();
  for (const meta of metas) {
    const oracle = lowerAddress(meta.oracle);
    if (!oracle || oracle === ethers.ZeroAddress.toLowerCase()) continue;
    if (!oracleMarkets.has(oracle)) oracleMarkets.set(oracle, []);
    oracleMarkets.get(oracle).push(meta);
  }
  const oracleEntries = [...oracleMarkets.entries()];
  for (let i = 0; i < oracleEntries.length; i += RPC_BATCH_SIZE) {
    const batch = oracleEntries.slice(i, i + RPC_BATCH_SIZE);
    const refs = await Promise.all(batch.map(async ([oracle]) => ({ oracle, refs: await findVaultReferencesInAddress(provider, oracle, vaults).catch(() => []) })));
    for (const { oracle, refs: matchedRefs } of refs) {
      for (const ref of matchedRefs) {
        for (const meta of oracleMarkets.get(oracle) || []) {
          rows.push({ vault: ref.vault, consumer: { ...meta, side: "oracleBytecodeReference", oracleReference: ref.reference }, reason: "vault address appears in Euler oracle/proxy implementation bytecode" });
        }
      }
    }
  }

  rows.stats = { factoryListLength: length, factoryListStart: start, evaultsScanned: metas.length, oracleContractsScanned: oracleEntries.length };
  return rows;
}

function parseSiloConfig(decoded) {
  const row = decoded?.[0];
  if (!row) return null;
  const token = normalizeAddress(row[3]);
  const silo = normalizeAddress(row[2]);
  if (!token || !silo) return null;
  return {
    silo,
    token,
    protectedShareToken: normalizeAddress(row[4]),
    collateralShareToken: normalizeAddress(row[5]),
    debtShareToken: normalizeAddress(row[6]),
    solvencyOracle: normalizeAddress(row[7]),
    maxLtvOracle: normalizeAddress(row[8]),
    interestRateModel: normalizeAddress(row[9]),
    maxLtv: siloLtvToRatio(row[10] || 0n),
    lt: siloLtvToRatio(row[11] || 0n),
    liquidationTargetLtv: siloLtvToRatio(row[12] || 0n),
    liquidationFee: siloLtvToRatio(row[13] || 0n),
    flashloanFee: siloLtvToRatio(row[14] || 0n),
    hookReceiver: normalizeAddress(row[15]),
  };
}

async function fetchSiloConsumers(provider, chain, chainId, vaults) {
  const factory = loadSiloDeployment(chainId, "SiloFactory");
  if (!factory) return [];
  const vaultByAddress = new Map(vaults.map((v) => [v.addressLower, v]));
  const nextRaw = await safeProviderCall(provider, factory, SILO_FACTORY.encodeFunctionData("getNextSiloId", []));
  const nextId = decodeResult(nextRaw, SILO_FACTORY, "getNextSiloId")?.[0];
  if (!nextId) return [];
  const start = nextId > BigInt(MAX_SILO_IDS) ? nextId - BigInt(MAX_SILO_IDS) : 1n;
  const pairs = [];
  const tokenSet = new Set();

  for (let id = start; id < nextId; id++) {
    const cfgRaw = await safeProviderCall(provider, factory, SILO_FACTORY.encodeFunctionData("idToSiloConfig", [id]));
    const config = normalizeAddress(decodeResult(cfgRaw, SILO_FACTORY, "idToSiloConfig")?.[0]);
    if (!config || config === ethers.ZeroAddress) continue;
    const silosRaw = await safeProviderCall(provider, config, SILO_CONFIG.encodeFunctionData("getSilos", []));
    const silosDecoded = decodeResult(silosRaw, SILO_CONFIG, "getSilos");
    const silos = [normalizeAddress(silosDecoded?.[0]), normalizeAddress(silosDecoded?.[1])].filter(Boolean);
    if (silos.length < 2) continue;
    const sides = [];
    for (const silo of silos) {
      const [configRaw, liquidityRaw, storageRaw, symbolRaw] = await Promise.all([
        safeProviderCall(provider, config, SILO_CONFIG.encodeFunctionData("getConfig", [silo])),
        safeProviderCall(provider, silo, SILO.encodeFunctionData("getLiquidity", [])),
        safeProviderCall(provider, silo, SILO.encodeFunctionData("getSiloStorage", [])),
        null,
      ]);
      const cfg = parseSiloConfig(decodeResult(configRaw, SILO_CONFIG, "getConfig"));
      if (!cfg) continue;
      const storage = decodeResult(storageRaw, SILO, "getSiloStorage");
      const liquidity = decodeResult(liquidityRaw, SILO, "getLiquidity")?.[0] || 0n;
      tokenSet.add(cfg.token.toLowerCase());
      sides.push({
        ...cfg,
        id: id.toString(),
        config,
        liquidityRaw: liquidity.toString(),
        protectedAssetsRaw: (storage?.[2] || 0n).toString(),
        collateralAssetsRaw: (storage?.[3] || 0n).toString(),
        debtAssetsRaw: (storage?.[4] || 0n).toString(),
        symbolRaw,
      });
    }
    if (sides.length === 2) pairs.push({ id: id.toString(), config, sides });
  }

  const prices = pricesToAddressMap(chain, await fetchAddressPrices(chain, [...tokenSet]));
  const tokenMeta = new Map();
  for (const token of tokenSet) {
    const address = normalizeAddress(token);
    if (!address) continue;
    const [decimals, symbolRaw] = await Promise.all([
      erc20Decimals(provider, address).catch(() => 18),
      safeProviderCall(provider, address, ERC20.encodeFunctionData("symbol", [])),
    ]);
    tokenMeta.set(address.toLowerCase(), { decimals, symbol: decodeStringResult(symbolRaw, "symbol"), priceUsd: prices.get(address.toLowerCase()) || 0 });
  }

  for (const pair of pairs) {
    for (const side of pair.sides) {
      const meta = tokenMeta.get(side.token.toLowerCase()) || { decimals: 18, priceUsd: 0 };
      side.tokenSymbol = meta.symbol;
      side.tokenDecimals = meta.decimals;
      side.liquidity = formatUnitsNumber(BigInt(side.liquidityRaw), meta.decimals);
      side.liquidityUsd = Number(side.liquidity || 0) * Number(meta.priceUsd || 0);
    }
  }

  const rows = [];
  const oracleRows = [];
  for (const pair of pairs) {
    for (let idx = 0; idx < pair.sides.length; idx++) {
      const side = pair.sides[idx];
      const opposite = pair.sides[idx === 0 ? 1 : 0];
      const consumer = {
        protocol: "Silo V3",
        factory,
        id: pair.id,
        config: pair.config,
        side: "collateralToken",
        silo: side.silo,
        token: side.token,
        tokenSymbol: side.tokenSymbol,
        tokenDecimals: side.tokenDecimals,
        solvencyOracle: side.solvencyOracle,
        maxLtvOracle: side.maxLtvOracle,
        maxLtv: side.maxLtv,
        lt: side.lt,
        liquidityRaw: side.liquidityRaw,
        liquidity: side.liquidity,
        liquidityUsd: side.liquidityUsd,
        oppositeSilo: opposite.silo,
        oppositeToken: opposite.token,
        oppositeTokenSymbol: opposite.tokenSymbol,
        oppositeLiquidityRaw: opposite.liquidityRaw,
        oppositeLiquidity: opposite.liquidity,
        oppositeLiquidityUsd: opposite.liquidityUsd,
      };
      const vault = vaultByAddress.get(side.token.toLowerCase());
      if (vault) rows.push({ vault, consumer, reason: "vault is Silo V3 market collateral token" });
      for (const oracle of [side.solvencyOracle, side.maxLtvOracle]) {
        const normalizedOracle = lowerAddress(oracle);
        if (!normalizedOracle || normalizedOracle === ethers.ZeroAddress.toLowerCase()) continue;
        oracleRows.push({ oracle: normalizedOracle, consumer });
      }
    }
  }

  const uniqueOracles = [...new Set(oracleRows.map((row) => row.oracle))];
  for (let i = 0; i < uniqueOracles.length; i += RPC_BATCH_SIZE) {
    const batch = uniqueOracles.slice(i, i + RPC_BATCH_SIZE);
    const refs = await Promise.all(batch.map(async (oracle) => ({ oracle, refs: await findVaultReferencesInAddress(provider, oracle, vaults).catch(() => []) })));
    for (const { oracle, refs: matchedRefs } of refs) {
      for (const ref of matchedRefs) {
        for (const row of oracleRows.filter((r) => r.oracle === oracle)) {
          rows.push({ vault: ref.vault, consumer: { ...row.consumer, side: "oracleBytecodeReference", oracle, oracleReference: ref.reference }, reason: "vault address appears in Silo oracle/proxy implementation bytecode" });
        }
      }
    }
  }

  rows.stats = { idsScanned: Number(nextId - start), marketsScanned: pairs.length, oracleContractsScanned: uniqueOracles.length };
  return rows;
}

async function fetchOracleBytecodeMatches(provider, chainId, vaults) {
  const topMarkets = await fetchTopMorphoMarkets(chainId);
  const oracleMarkets = new Map();
  for (const market of topMarkets) {
    const oracle = lowerAddress(market.oracle?.address);
    if (!oracle || oracle === ethers.ZeroAddress.toLowerCase()) continue;
    if (!oracleMarkets.has(oracle)) oracleMarkets.set(oracle, []);
    oracleMarkets.get(oracle).push(market);
  }

  const matches = [];
  const oracleEntries = [...oracleMarkets.entries()];
  for (let i = 0; i < oracleEntries.length; i += RPC_BATCH_SIZE) {
    const batch = oracleEntries.slice(i, i + RPC_BATCH_SIZE);
    const refs = await Promise.all(batch.map(async ([oracle]) => ({ oracle, refs: await findVaultReferencesInAddress(provider, oracle, vaults).catch(() => []) })));
    for (const { oracle, refs: matchedRefs } of refs) {
      for (const ref of matchedRefs) {
        for (const market of oracleMarkets.get(oracle) || []) {
          matches.push({ vault: ref.vault, market, oracle, reference: ref.reference });
        }
      }
    }
  }
  return matches;
}

async function scanChain(chainId, rpc, inputVaults) {
  const chain = CHAINS[chainId];
  const provider = new ethers.JsonRpcProvider(rpc);
  const blockNumber = await provider.getBlockNumber();
  console.log(`Scanning ${chain.name}: vaults=${inputVaults.length}`);

  const enriched = await enrichVaults(provider, inputVaults);
  const prices = await fetchPrices(chain, enriched);
  addPriceFields(chain, enriched, prices);

  const vaultByAddress = new Map(enriched.map((v) => [v.addressLower, v]));
  const [collateralMarkets, loanMarkets, oracleMatchesRaw, compoundRows, venusRows, aaveRows, eulerRows, siloRows] = await Promise.all([
    fetchMorphoAssetConsumers(chainId, enriched, "collateralAssetAddress_in"),
    fetchMorphoAssetConsumers(chainId, enriched, "loanAssetAddress_in"),
    fetchOracleBytecodeMatches(provider, chainId, enriched),
    fetchCompoundConsumers(provider, chain, chainId, enriched),
    fetchVenusConsumers(provider, chain, chainId, enriched),
    fetchAaveConsumers(provider, chain, chainId, enriched),
    fetchEulerConsumers(provider, chain, chainId, enriched),
    fetchSiloConsumers(provider, chain, chainId, enriched),
  ]);

  const candidates = [];
  const seen = new Set();
  for (const market of collateralMarkets) {
    const vault = vaultByAddress.get(lowerAddress(market.collateralAsset?.address));
    if (!vault) continue;
    const key = `collateral:${marketKey(market)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ chainId, chain: chain.name, vault, ...classifyCandidate(vault, "collateralAsset", market, "vault is Morpho collateral asset") });
  }
  for (const market of loanMarkets) {
    const vault = vaultByAddress.get(lowerAddress(market.loanAsset?.address));
    if (!vault) continue;
    const key = `loan:${marketKey(market)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ chainId, chain: chain.name, vault, ...classifyCandidate(vault, "loanAsset", market, "vault is Morpho loan asset") });
  }
  for (const row of oracleMatchesRaw) {
    const key = `oracle:${row.vault.addressLower}:${marketKey(row.market)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      chainId,
      chain: chain.name,
      vault: row.vault,
      oracleBytecode: { oracle: row.oracle, reference: row.reference },
      ...classifyCandidate(row.vault, "oracleBytecodeReference", row.market, "vault address appears in Morpho oracle bytecode"),
    });
  }
  for (const row of compoundRows) {
    const key = `compound:${row.vault.addressLower}:${row.consumer.comet}:${row.consumer.asset || row.consumer.priceFeed}:${row.consumer.side}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ chainId, chain: chain.name, vault: row.vault, ...classifyCompoundCandidate(row.vault, row.consumer, row.reason) });
  }
  for (const row of venusRows) {
    const key = `venus:${row.vault.addressLower}:${row.consumer.vToken}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ chainId, chain: chain.name, vault: row.vault, ...classifyVenusCandidate(row.vault, row.consumer, row.reason) });
  }
  for (const row of aaveRows) {
    const key = `aave:${row.vault.addressLower}:${row.consumer.reserve}:${row.consumer.side}:${row.consumer.priceSourceReference?.kind || ""}:${row.consumer.priceSourceReference?.address || ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ chainId, chain: chain.name, vault: row.vault, ...classifyAaveCandidate(row.vault, row.consumer, row.reason) });
  }
  for (const row of eulerRows) {
    const key = `euler:${row.vault.addressLower}:${row.consumer.evault}:${row.consumer.side}:${row.consumer.oracleReference?.kind || row.consumer.collateral || ""}:${row.consumer.oracleReference?.address || ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ chainId, chain: chain.name, vault: row.vault, ...classifyEulerCandidate(row.vault, row.consumer, row.reason) });
  }
  for (const row of siloRows) {
    const key = `silo:${row.vault.addressLower}:${row.consumer.config}:${row.consumer.silo}:${row.consumer.side}:${row.consumer.oracleReference?.kind || ""}:${row.consumer.oracleReference?.address || ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ chainId, chain: chain.name, vault: row.vault, ...classifySiloCandidate(row.vault, row.consumer, row.reason) });
  }

  candidates.sort((a, b) => {
    const aw = a.watchCandidate ? 1 : 0;
    const bw = b.watchCandidate ? 1 : 0;
    if (aw !== bw) return bw - aw;
    return toNumber(b.market?.liquidityAssetsUsd) - toNumber(a.market?.liquidityAssetsUsd);
  });

  return {
    chainId,
    chain: chain.name,
    rpcResolved: true,
    blockNumber,
    vaultsInput: inputVaults.length,
    vaultsEnriched: enriched.length,
    vaultsWithAsset: enriched.filter((v) => v.asset).length,
    vaultsLiveLowTvl: enriched.filter((v) => (v.totalAssetsUsd ?? v.inventoryTotalAssets ?? 0) <= LOW_TVL_USD).length,
    morphoCollateralMatches: collateralMarkets.length,
    morphoLoanMatches: loanMarkets.length,
    morphoOracleBytecodeMatches: oracleMatchesRaw.length,
    compoundMatches: compoundRows.filter((r) => r.consumer.side === "collateralAsset").length,
    compoundPriceFeedBytecodeMatches: compoundRows.filter((r) => r.consumer.side === "priceFeedBytecodeReference").length,
    venusMatches: venusRows.length,
    aaveReservesScanned: aaveRows.stats?.reservesScanned || 0,
    aavePriceSourcesScanned: aaveRows.stats?.priceSourcesScanned || 0,
    aaveReserveMatches: aaveRows.filter((r) => r.consumer.side === "reserveAsset").length,
    aavePriceSourceBytecodeMatches: aaveRows.filter((r) => r.consumer.side === "priceSourceBytecodeReference").length,
    eulerFactoryListLength: eulerRows.stats?.factoryListLength || 0,
    eulerFactoryListStart: eulerRows.stats?.factoryListStart || 0,
    eulerVaultsScanned: eulerRows.stats?.evaultsScanned || 0,
    eulerOracleContractsScanned: eulerRows.stats?.oracleContractsScanned || 0,
    eulerCollateralMatches: eulerRows.filter((r) => r.consumer.side === "collateralVault").length,
    eulerBorrowAssetMatches: eulerRows.filter((r) => r.consumer.side === "borrowAsset").length,
    eulerOracleBytecodeMatches: eulerRows.filter((r) => r.consumer.side === "oracleBytecodeReference").length,
    siloIdsScanned: siloRows.stats?.idsScanned || 0,
    siloMarketsScanned: siloRows.stats?.marketsScanned || 0,
    siloOracleContractsScanned: siloRows.stats?.oracleContractsScanned || 0,
    siloCollateralMatches: siloRows.filter((r) => r.consumer.side === "collateralToken").length,
    siloOracleBytecodeMatches: siloRows.filter((r) => r.consumer.side === "oracleBytecodeReference").length,
    watchCandidates: candidates.filter((c) => c.watchCandidate).length,
    routePositive: 0,
    topCandidates: candidates.slice(0, 50),
  };
}

async function main() {
  const byChain = loadVaultInputs();
  const chainIds = Object.keys(byChain).map(Number).filter((id) => byChain[id]?.length);
  const rpcPool = await resolveRpcPool(chainIds);
  const results = [];
  for (const chainId of chainIds) {
    if (!rpcPool[chainId]) {
      results.push({ chainId, chain: CHAINS[chainId].name, rpcResolved: false, error: "missing-rpc", vaultsInput: byChain[chainId].length });
      continue;
    }
    results.push(await scanChain(chainId, rpcPool[chainId], byChain[chainId]));
  }

  const watchCandidates = results.reduce((sum, r) => sum + Number(r.watchCandidates || 0), 0);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-erc4626-consumer-joiner.js",
    safety: {
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
    },
    thresholds: {
      lowTvlUsd: LOW_TVL_USD,
      routeLiquidityUsd: ROUTE_LIQUIDITY_USD,
      maxVaultsPerChain: MAX_VAULTS_PER_CHAIN,
      morphoMarketTopN: MORPHO_MARKET_TOP_N,
      maxEulerVaults: MAX_EULER_VAULTS,
      maxSiloIds: MAX_SILO_IDS,
    },
    scope: {
      included: [
        "Morpho Vault V2 low/zero-TVL inventory",
        "Morpho Blue market asset consumers",
        "Morpho Blue top-market oracle/proxy implementation bytecode references",
        "Compound V3 collateral configs and price-feed/proxy implementation bytecode references",
        "Venus Comptroller market underlying configs",
        "Aave V3 reserve configs and price-source/proxy implementation bytecode references",
        "Euler EVK collateral/borrow configs and oracle/proxy implementation bytecode references",
        "Silo V3 market configs and oracle/proxy implementation bytecode references",
      ],
      pending: ["route-specific economics for any watch candidates"],
    },
    summary: {
      chainsScanned: results.filter((r) => r.rpcResolved).length,
      chainsMissingRpc: results.filter((r) => !r.rpcResolved).map((r) => r.chain),
      vaultsInput: results.reduce((sum, r) => sum + Number(r.vaultsInput || 0), 0),
      watchCandidates,
      routePositive: 0,
      signedActionJustified: false,
    },
    results,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  console.log(`ERC4626 consumer joiner wrote ${path.relative(WORKSPACE, OUT)}; watchCandidates=${watchCandidates}; routePositive=0`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
