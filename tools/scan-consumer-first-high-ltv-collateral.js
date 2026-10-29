#!/usr/bin/env node
// Read-only consumer-first high-LTV collateral discovery scanner.
// RPC URLs are resolved from local inventory in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json");
const SILO_CORE_DEPLOYMENTS = path.join(WORKSPACE, "targets", "silo-contracts-v2", "silo-core", "deployments");
const COMPOUND_DEPLOYMENTS = path.join(WORKSPACE, "targets", "compound-comet", "deployments");

const TIMEOUT_MS = 15_000;
const RPC_BATCH_SIZE = 20;
const MIN_LTV = Number(process.env.CONSUMER_FIRST_MIN_LTV || "0.85");
const MIN_ROUTE_LIQUIDITY_USD = Number(process.env.CONSUMER_FIRST_MIN_LIQUIDITY_USD || "10000");
const MORPHO_TOP_N = Number(process.env.CONSUMER_FIRST_MORPHO_TOP_N || "500");
const MAX_EULER_VAULTS = Number(process.env.CONSUMER_FIRST_MAX_EULER_VAULTS || "700");
const MAX_SILO_IDS = Number(process.env.CONSUMER_FIRST_MAX_SILO_IDS || "700");

const CHAINS = {
  1: { name: "Ethereum", coinSlug: "ethereum", aavePool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", eulerFactory: "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e", siloFolder: "mainnet", compoundFolder: "mainnet" },
  10: { name: "Optimism", coinSlug: "optimism", aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", siloFolder: "optimism", compoundFolder: "optimism" },
  56: { name: "BNB Chain", coinSlug: "bsc", siloFolder: "bnb" },
  137: { name: "Polygon", coinSlug: "polygon", aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", compoundFolder: "polygon" },
  146: { name: "Sonic", coinSlug: "sonic", siloFolder: "sonic" },
  8453: { name: "Base", coinSlug: "base", aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", siloFolder: "base", compoundFolder: "base" },
  42161: { name: "Arbitrum", coinSlug: "arbitrum", aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", siloFolder: "arbitrum_one" },
  57073: { name: "Ink", coinSlug: "ink", aavePool: "0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA", siloFolder: "ink" },
  130: { name: "Unichain", coinSlug: "unichain" },
  480: { name: "World Chain", coinSlug: "world-chain" },
  999: { name: "HyperEVM", coinSlug: "hyperliquid" },
  80094: { name: "Berachain", coinSlug: "berachain" },
};

const FILES = {
  rwaNav: path.join(WORKSPACE, "reports", "raw", "fast", "rwa-nav-consumer-graph.json"),
  centrifuge: path.join(WORKSPACE, "reports", "raw", "fast", "centrifuge-nav-consumer-graph.json"),
  pendlePt: path.join(WORKSPACE, "reports", "raw", "fast", "pendle-pt-consumer-graph.json"),
  usdt0: path.join(WORKSPACE, "reports", "raw", "fast", "usdt0-oft-routes.json"),
  hyperlane: path.join(WORKSPACE, "reports", "raw", "fast", "hyperlane-warp-routes.json"),
  aesGraph: path.join(WORKSPACE, "reports", "raw", "fast", "aave-euler-silo-consumer-graph.json"),
  erc4626Joiner: path.join(WORKSPACE, "reports", "raw", "fast", "erc4626-consumer-joiner.json"),
};

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);
const AAVE_POOL = new ethers.Interface([
  "function ADDRESSES_PROVIDER() view returns (address)",
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns (tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
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
  "function symbol() view returns (string)",
  "function totalBorrows() view returns (uint256)",
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

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function lowerAddress(value) {
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
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
  const pool = {};
  for (const url of loadRpcUrls()) {
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
  try { return await provider.call({ to, data }); } catch (_) { return null; }
}

function decodeResult(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}

function decodeStringResult(raw, fn) {
  if (!raw || raw === "0x") return null;
  try { return String(ERC20.decodeFunctionResult(fn, raw)[0]); } catch (_) {
    const hex = strip0x(raw);
    if (hex.length === 64) return Buffer.from(hex, "hex").toString("utf8").replace(/\u0000+$/g, "") || null;
    return null;
  }
}

function decodeUintResult(raw, fn) {
  if (!raw || raw === "0x") return null;
  try { return BigInt(ERC20.decodeFunctionResult(fn, raw)[0]); } catch (_) {
    try { return BigInt(raw); } catch (_) { return null; }
  }
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
    borrowCapWholeTokens: ((raw >> 80n) & mask36).toString(),
    supplyCapWholeTokens: ((raw >> 116n) & mask36).toString(),
  };
}

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try { return Number(ethers.formatUnits(raw, Number(decimals))); } catch (_) { return null; }
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

async function tokenMeta(provider, address, fallback = {}) {
  const token = normalizeAddress(address);
  if (!provider || !token) return { address: token, symbol: fallback.symbol || null, name: fallback.name || null, decimals: fallback.decimals ?? 18 };
  const [symbolRaw, nameRaw, decimalsRaw] = await Promise.all([
    safeProviderCall(provider, token, ERC20.encodeFunctionData("symbol", [])),
    safeProviderCall(provider, token, ERC20.encodeFunctionData("name", [])),
    safeProviderCall(provider, token, ERC20.encodeFunctionData("decimals", [])),
  ]);
  return {
    address: token,
    symbol: decodeStringResult(symbolRaw, "symbol") || fallback.symbol || null,
    name: decodeStringResult(nameRaw, "name") || fallback.name || null,
    decimals: Number(decodeUintResult(decimalsRaw, "decimals") ?? BigInt(fallback.decimals ?? 18)),
  };
}

async function fetchAddressPrices(chain, addresses) {
  const keys = [];
  for (const address of addresses || []) {
    const normalized = lowerAddress(address);
    if (normalized) keys.push(`${chain.coinSlug}:${normalized}`);
  }
  const uniq = [...new Set(keys.map((x) => x.toLowerCase()))];
  const out = {};
  for (let i = 0; i < uniq.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${uniq.slice(i, i + 50).join(",")}?searchWidth=6h`, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    Object.assign(out, json.coins || {});
  }
  return out;
}

function pricesToAddressMap(chain, prices) {
  const out = new Map();
  for (const [key, row] of Object.entries(prices || {})) {
    const prefix = `${chain.coinSlug}:`;
    if (!key.toLowerCase().startsWith(prefix)) continue;
    const address = lowerAddress(key.slice(prefix.length));
    const price = Number(row?.price || 0);
    if (address && Number.isFinite(price) && price > 0) out.set(address, price);
  }
  return out;
}

function loadSiloDeployment(chainId, name) {
  const folder = CHAINS[chainId]?.siloFolder;
  if (!folder) return null;
  const file = path.join(SILO_CORE_DEPLOYMENTS, folder, `${name}.sol.json`);
  const json = readJson(file, null);
  return normalizeAddress(json?.address || json?.deployedTo || json?.contractAddress);
}

function addKnownToken(map, address, source, symbol = null, chainId = null) {
  const lower = lowerAddress(address);
  if (!lower) return;
  const row = map.get(lower) || { address: normalizeAddress(address), sources: new Set(), symbols: new Set(), chainIds: new Set() };
  if (source) row.sources.add(source);
  if (symbol) row.symbols.add(String(symbol));
  if (chainId) row.chainIds.add(Number(chainId));
  map.set(lower, row);
}

function collectKnownTokensFromObject(map, obj, source, chainId = null) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) collectKnownTokensFromObject(map, item, source, chainId);
    return;
  }
  const nextChainId = Number(obj.chainId || obj.chain_id || chainId || 0) || chainId;
  const address = obj.address || obj.token || obj.pt || obj.asset || obj.collateralAddressOrDenom || obj.addressOrDenom;
  if (address && (obj.symbol || obj.name || obj.category || obj.protocol || obj.marketName)) addKnownToken(map, address, source, obj.symbol || obj.name || null, nextChainId);
  for (const value of Object.values(obj)) collectKnownTokensFromObject(map, value, source, nextChainId);
}

function collectKnownTokens() {
  const map = new Map();
  for (const [source, file] of Object.entries(FILES)) collectKnownTokensFromObject(map, readJson(file, null), source);
  const out = new Map();
  for (const [address, row] of map.entries()) {
    out.set(address, {
      address: row.address,
      sources: [...row.sources].sort(),
      symbols: [...row.symbols].sort().slice(0, 8),
      chainIds: [...row.chainIds].sort((a, b) => a - b),
    });
  }
  return out;
}

const CANONICAL_SYMBOLS = new Set([
  "AERO", "ARB", "BAL", "COMP", "DAI", "EURC", "FRAX", "GHO", "LINK", "OP", "POL", "S", "SUSDS", "USDBC", "USDC", "USDE", "USDS", "USDT", "USDCE", "WBTC", "WETH", "WLD", "WMATIC", "WSTETH", "cbBTC", "cbETH", "rETH", "weETH", "ezETH", "rsETH", "tBTC",
].map((x) => x.toUpperCase()));

function classifyTokenRisk(symbol, name, known) {
  const text = `${symbol || ""} ${name || ""}`;
  const upper = text.toUpperCase();
  const tags = [];
  if (/\bPT[-_ ]|PRINCIPAL TOKEN|PENDLE/.test(upper)) tags.push("principal-token");
  if (/OUSG|USDY|USTB|USCC|TBILL|STBT|BACKED|TOKENIZED|TREASUR|T-BILL|BOND|GOVERNMENT|CREDIT|SYRUP|MAPLE|RWA/.test(upper)) tags.push("rwa-or-credit");
  if (/OFT|USDT0|WARP|HYP|BRIDGE|LAYERZERO|WORMHOLE|AXELAR/.test(upper)) tags.push("bridge-wrapper");
  if (/ERC4626|VAULT|SHARE|STAKED|STAKING|YIELD|SAVING|WRAPPED|RECEIPT/.test(upper) || /^S[A-Z0-9]{2,}/.test(String(symbol || ""))) tags.push("receipt-or-yield-bearing");
  if (known) tags.push("known-local-artifact-token");
  if (!CANONICAL_SYMBOLS.has(String(symbol || "").toUpperCase())) tags.push("noncanonical-or-unknown");
  return [...new Set(tags)];
}

function classifyRow(row, knownTokens) {
  const lower = lowerAddress(row.collateral?.address);
  const known = lower ? knownTokens.get(lower) : null;
  const tags = classifyTokenRisk(row.collateral?.symbol, row.collateral?.name, known);
  const highLtv = Number(row.ltv || 0) >= MIN_LTV;
  const hasLiquidity = Number(row.routeLiquidityUsd || 0) >= MIN_ROUTE_LIQUIDITY_USD;
  const noncanonical = tags.includes("noncanonical-or-unknown");
  const reviewCandidate = highLtv && hasLiquidity && noncanonical;
  return {
    ...row,
    riskTags: tags,
    knownLocalToken: known || null,
    highLtv,
    reviewCandidate,
    watchCandidate: false,
    routePositive: false,
    blockers: [
      "Consumer-first row has no mapped current producer anomaly",
      reviewCandidate ? "Needs producer-specific NAV/oracle/DEX/redemption economics before fork" : null,
      !highLtv ? `Collateral LTV below threshold ${MIN_LTV}` : null,
      !hasLiquidity ? `Route-side liquidity below threshold $${MIN_ROUTE_LIQUIDITY_USD}` : null,
      !noncanonical ? "Canonical/blue-chip collateral; no novel producer-risk shape from this scan" : null,
      "No executable route quote or fork proof",
    ].filter(Boolean),
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
  return json.data?.markets?.items || [];
}

function morphoLltvRatio(value) {
  try { return Number(BigInt(String(value || 0))) / 1e18; } catch (_) { return Number(value || 0); }
}

async function scanMorpho(chainId, chain) {
  const query = `query($chainIds:[Int!]!, $minSupply:Float!) {
    markets(first:${MORPHO_TOP_N}, orderBy:SupplyAssetsUsd, orderDirection:Desc,
      where:{chainId_in:$chainIds, supplyAssetsUsd_gte:$minSupply}) { items {
        marketId
        loanAsset { symbol address decimals }
        collateralAsset { symbol address decimals }
        oracle { address }
        lltv
        state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization }
      } }
  }`;
  const markets = await morphoQuery(query, { chainIds: [chainId], minSupply: 1 }).catch(() => []);
  return markets.map((market) => ({
    protocol: "Morpho Blue",
    chainId,
    chain: chain.name,
    consumer: { marketId: market.marketId, oracle: market.oracle?.address || null, loanAsset: market.loanAsset, collateralAsset: market.collateralAsset },
    collateral: { address: normalizeAddress(market.collateralAsset?.address), symbol: market.collateralAsset?.symbol || null, decimals: market.collateralAsset?.decimals ?? null },
    borrowAsset: { address: normalizeAddress(market.loanAsset?.address), symbol: market.loanAsset?.symbol || null, decimals: market.loanAsset?.decimals ?? null },
    ltv: morphoLltvRatio(market.lltv),
    routeLiquidityUsd: Number(market.state?.liquidityAssetsUsd || 0),
    supplyAssetsUsd: Number(market.state?.supplyAssetsUsd || 0),
    borrowAssetsUsd: Number(market.state?.borrowAssetsUsd || 0),
    utilization: market.state?.utilization ?? null,
  }));
}

async function scanAave(provider, chainId, chain) {
  const pool = normalizeAddress(chain.aavePool);
  if (!provider || !pool) return { rows: [], stats: { reservesScanned: 0 } };
  const reservesRaw = await safeProviderCall(provider, pool, AAVE_POOL.encodeFunctionData("getReservesList", []));
  const reserves = (decodeResult(reservesRaw, AAVE_POOL, "getReservesList")?.[0] || []).map(normalizeAddress).filter(Boolean);
  const metas = [];
  for (const reserve of reserves) {
    const [dataRaw, symbolRaw, nameRaw] = await Promise.all([
      safeProviderCall(provider, pool, AAVE_POOL.encodeFunctionData("getReserveData", [reserve])),
      safeProviderCall(provider, reserve, ERC20.encodeFunctionData("symbol", [])),
      safeProviderCall(provider, reserve, ERC20.encodeFunctionData("name", [])),
    ]);
    if (!dataRaw || dataRaw === "0x") continue;
    const cfg = decodeAaveConfig(BigInt(wordAt(dataRaw, 0) || 0n));
    const aToken = normalizeAddress(addressWordAt(dataRaw, 8) || addressWordAt(dataRaw, 9));
    const decimals = cfg.decimals || await erc20Decimals(provider, reserve).catch(() => 18);
    const cashRaw = aToken ? await erc20Balance(provider, reserve, aToken).catch(() => 0n) : 0n;
    metas.push({
      protocol: "Aave V3",
      chainId,
      chain: chain.name,
      consumer: { pool, aToken, active: cfg.active, frozen: cfg.frozen, paused: cfg.paused, borrowingEnabled: cfg.borrowingEnabled, borrowCapWholeTokens: cfg.borrowCapWholeTokens, supplyCapWholeTokens: cfg.supplyCapWholeTokens },
      collateral: { address: reserve, symbol: decodeStringResult(symbolRaw, "symbol"), name: decodeStringResult(nameRaw, "name"), decimals },
      ltv: cfg.ltv,
      liquidationThreshold: cfg.liquidationThreshold,
      rawCash: cashRaw,
      cash: formatUnitsNumber(cashRaw, decimals),
    });
  }
  const prices = pricesToAddressMap(chain, await fetchAddressPrices(chain, metas.map((m) => m.collateral.address)));
  for (const meta of metas) meta.cashUsd = Number(meta.cash || 0) * Number(prices.get(meta.collateral.address.toLowerCase()) || 0);
  const borrowableCashUsd = metas.filter((m) => m.consumer.active && !m.consumer.paused && m.consumer.borrowingEnabled).reduce((sum, m) => sum + Number(m.cashUsd || 0), 0);
  for (const meta of metas) meta.routeLiquidityUsd = Math.max(0, borrowableCashUsd - Number(meta.cashUsd || 0));
  return { rows: metas, stats: { reservesScanned: metas.length } };
}

async function scanEuler(provider, chainId, chain) {
  const factory = normalizeAddress(chain.eulerFactory);
  if (!provider || !factory) return { rows: [], stats: { factoryListLength: 0, vaultsScanned: 0 } };
  const lengthRaw = await safeProviderCall(provider, factory, GENERIC_FACTORY.encodeFunctionData("getProxyListLength", []));
  const length = Number(decodeResult(lengthRaw, GENERIC_FACTORY, "getProxyListLength")?.[0] || 0n);
  const start = Math.max(0, length - MAX_EULER_VAULTS);
  const evaults = [];
  for (let cursor = start; cursor < length; cursor += 100) {
    const end = Math.min(length, cursor + 100);
    const raw = await safeProviderCall(provider, factory, GENERIC_FACTORY.encodeFunctionData("getProxyListSlice", [cursor, end]));
    evaults.push(...(decodeResult(raw, GENERIC_FACTORY, "getProxyListSlice")?.[0] || []).map(normalizeAddress).filter(Boolean));
  }
  const metas = [];
  for (let i = 0; i < evaults.length; i += RPC_BATCH_SIZE) {
    const batch = evaults.slice(i, i + RPC_BATCH_SIZE);
    metas.push(...(await Promise.all(batch.map(async (evault) => {
      const [assetRaw, cashRaw, symbolRaw, ltvListRaw] = await Promise.all([
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("asset", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("cash", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("symbol", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("LTVList", [])),
      ]);
      const asset = normalizeAddress(decodeResult(assetRaw, EVAULT, "asset")?.[0]);
      if (!asset) return [];
      const assetDecimals = await erc20Decimals(provider, asset).catch(() => 18);
      const assetMeta = await tokenMeta(provider, asset, {});
      const cash = decodeResult(cashRaw, EVAULT, "cash")?.[0] || 0n;
      const ltvList = (decodeResult(ltvListRaw, EVAULT, "LTVList")?.[0] || []).map(normalizeAddress).filter(Boolean).slice(0, 40);
      const ltvRows = [];
      for (const collateral of ltvList) {
        const [ltvRaw, collMeta] = await Promise.all([
          safeProviderCall(provider, evault, EVAULT.encodeFunctionData("LTVBorrow", [collateral])),
          tokenMeta(provider, collateral, {}),
        ]);
        ltvRows.push({ evault, asset, assetSymbol: assetMeta.symbol, evaultSymbol: decodeStringResult(symbolRaw, "symbol"), cashRaw: cash, assetDecimals, collateral: collMeta, ltv: Number(decodeResult(ltvRaw, EVAULT, "LTVBorrow")?.[0] || 0) / 10_000 });
      }
      return ltvRows;
    })) ).flat());
  }
  const prices = pricesToAddressMap(chain, await fetchAddressPrices(chain, metas.map((m) => m.asset)));
  return {
    rows: metas.map((m) => ({
      protocol: "Euler EVK",
      chainId,
      chain: chain.name,
      consumer: { evault: m.evault, asset: m.asset, assetSymbol: m.assetSymbol, evaultSymbol: m.evaultSymbol },
      collateral: m.collateral,
      borrowAsset: { address: m.asset, symbol: m.assetSymbol, decimals: m.assetDecimals },
      ltv: m.ltv,
      routeLiquidityUsd: Number(formatUnitsNumber(m.cashRaw, m.assetDecimals) || 0) * Number(prices.get(m.asset.toLowerCase()) || 0),
      cashRaw: m.cashRaw.toString(),
    })),
    stats: { factoryListLength: length, factoryListStart: start, vaultsScanned: evaults.length },
  };
}

function parseSiloConfig(decoded) {
  const row = decoded?.[0];
  if (!row) return null;
  const silo = normalizeAddress(row[2]);
  const token = normalizeAddress(row[3]);
  if (!silo || !token) return null;
  return { silo, token, solvencyOracle: normalizeAddress(row[7]), maxLtvOracle: normalizeAddress(row[8]), maxLtv: Number(row[10] || 0n) / 1e18, lt: Number(row[11] || 0n) / 1e18 };
}

async function scanSilo(provider, chainId, chain) {
  const factory = loadSiloDeployment(chainId, "SiloFactory");
  if (!provider || !factory) return { rows: [], stats: { idsScanned: 0, marketsScanned: 0 } };
  const nextRaw = await safeProviderCall(provider, factory, SILO_FACTORY.encodeFunctionData("getNextSiloId", []));
  const nextId = decodeResult(nextRaw, SILO_FACTORY, "getNextSiloId")?.[0];
  if (!nextId) return { rows: [], stats: { idsScanned: 0, marketsScanned: 0 } };
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
      const [configRaw, liquidityRaw, storageRaw] = await Promise.all([
        safeProviderCall(provider, config, SILO_CONFIG.encodeFunctionData("getConfig", [silo])),
        safeProviderCall(provider, silo, SILO.encodeFunctionData("getLiquidity", [])),
        safeProviderCall(provider, silo, SILO.encodeFunctionData("getSiloStorage", [])),
      ]);
      const cfg = parseSiloConfig(decodeResult(configRaw, SILO_CONFIG, "getConfig"));
      if (!cfg) continue;
      const liquidity = decodeResult(liquidityRaw, SILO, "getLiquidity")?.[0] || 0n;
      const storage = decodeResult(storageRaw, SILO, "getSiloStorage");
      tokenSet.add(cfg.token.toLowerCase());
      sides.push({ ...cfg, id: id.toString(), config, liquidityRaw: liquidity, collateralAssetsRaw: (storage?.[3] || 0n).toString(), debtAssetsRaw: (storage?.[4] || 0n).toString() });
    }
    if (sides.length === 2) pairs.push({ id: id.toString(), config, sides });
  }
  const prices = pricesToAddressMap(chain, await fetchAddressPrices(chain, [...tokenSet]));
  const metas = new Map();
  for (const token of tokenSet) metas.set(token, await tokenMeta(provider, token, {}));
  const rows = [];
  for (const pair of pairs) {
    for (let i = 0; i < pair.sides.length; i++) {
      const side = pair.sides[i];
      const opposite = pair.sides[i === 0 ? 1 : 0];
      const meta = metas.get(side.token.toLowerCase()) || { address: side.token, decimals: 18 };
      const oppositeMeta = metas.get(opposite.token.toLowerCase()) || { address: opposite.token, decimals: 18 };
      const oppositeLiquidity = formatUnitsNumber(opposite.liquidityRaw, oppositeMeta.decimals);
      rows.push({
        protocol: "Silo V3",
        chainId,
        chain: chain.name,
        consumer: { id: pair.id, config: pair.config, silo: side.silo, oppositeSilo: opposite.silo, solvencyOracle: side.solvencyOracle, maxLtvOracle: side.maxLtvOracle },
        collateral: meta,
        borrowAsset: { address: opposite.token, symbol: oppositeMeta.symbol, name: oppositeMeta.name, decimals: oppositeMeta.decimals },
        ltv: side.maxLtv,
        liquidationThreshold: side.lt,
        routeLiquidityUsd: Number(oppositeLiquidity || 0) * Number(prices.get(opposite.token.toLowerCase()) || 0),
        collateralAssetsRaw: side.collateralAssetsRaw,
        debtAssetsRaw: side.debtAssetsRaw,
      });
    }
  }
  return { rows, stats: { idsScanned: Number(nextId - start), marketsScanned: pairs.length } };
}

function listCompoundConfigs(chain) {
  const folder = chain.compoundFolder ? path.join(COMPOUND_DEPLOYMENTS, chain.compoundFolder) : null;
  if (!folder || !fs.existsSync(folder)) return [];
  const rows = [];
  for (const marketName of fs.readdirSync(folder)) {
    const marketFolder = path.join(folder, marketName);
    if (!fs.statSync(marketFolder).isDirectory()) continue;
    const config = readJson(path.join(marketFolder, "configuration.json"), null);
    const roots = readJson(path.join(marketFolder, "roots.json"), null);
    if (config && roots?.comet) rows.push({ marketName, config, comet: normalizeAddress(roots.comet) });
  }
  return rows;
}

async function scanCompound(provider, chainId, chain) {
  const configs = listCompoundConfigs(chain);
  const rows = [];
  const baseTokens = configs.map((c) => c.config.baseTokenAddress).filter(Boolean);
  const prices = pricesToAddressMap(chain, await fetchAddressPrices(chain, baseTokens));
  for (const row of configs) {
    const baseToken = normalizeAddress(row.config.baseTokenAddress);
    const baseDecimals = provider && baseToken ? await erc20Decimals(provider, baseToken).catch(() => 18) : 18;
    const baseCashRaw = provider && baseToken && row.comet ? await erc20Balance(provider, baseToken, row.comet).catch(() => 0n) : 0n;
    const baseCash = formatUnitsNumber(baseCashRaw, baseDecimals);
    const baseCashUsd = Number(baseCash || 0) * Number(prices.get(baseToken?.toLowerCase()) || 0);
    for (const [symbol, asset] of Object.entries(row.config.assets || {})) {
      const collateral = { address: normalizeAddress(asset.address), symbol, decimals: Number(String(asset.decimals || "18").replace(/[^0-9]/g, "") || 18) };
      rows.push({
        protocol: "Compound Comet",
        chainId,
        chain: chain.name,
        consumer: { marketName: row.marketName, comet: row.comet, baseToken, baseTokenSymbol: row.config.baseToken, supplyCap: asset.supplyCap || null, priceFeed: normalizeAddress(asset.priceFeed) },
        collateral,
        borrowAsset: { address: baseToken, symbol: row.config.baseToken, decimals: baseDecimals },
        ltv: Number(asset.borrowCF || 0),
        liquidationThreshold: Number(asset.liquidateCF || 0),
        routeLiquidityUsd: baseCashUsd,
        baseCash,
        baseCashRaw: baseCashRaw.toString(),
      });
    }
  }
  return { rows, stats: { marketsScanned: configs.length } };
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = [row.protocol, row.chainId, lowerAddress(row.collateral?.address), row.consumer?.marketId || row.consumer?.pool || row.consumer?.evault || row.consumer?.config || row.consumer?.comet || "", row.borrowAsset?.address || row.borrowAsset?.symbol || ""].join(":").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function summarizeRows(rows) {
  const summary = { byProtocol: {}, byChain: {}, byRiskTag: {} };
  for (const row of rows) {
    summary.byProtocol[row.protocol] = (summary.byProtocol[row.protocol] || 0) + 1;
    summary.byChain[row.chain] = (summary.byChain[row.chain] || 0) + 1;
    for (const tag of row.riskTags || []) summary.byRiskTag[tag] = (summary.byRiskTag[tag] || 0) + 1;
  }
  return summary;
}

async function scanChain(chainId, rpc, knownTokens) {
  const chain = CHAINS[chainId];
  const provider = rpc ? new ethers.JsonRpcProvider(rpc) : null;
  const blockNumber = provider ? await provider.getBlockNumber().catch(() => null) : null;
  console.log(`Scanning ${chain.name}: consumer-first high-LTV`);
  const [morpho, aave, euler, silo, compound] = await Promise.all([
    scanMorpho(chainId, chain),
    scanAave(provider, chainId, chain),
    scanEuler(provider, chainId, chain),
    scanSilo(provider, chainId, chain),
    scanCompound(provider, chainId, chain),
  ]);
  const rows = dedupeRows([...morpho, ...aave.rows, ...euler.rows, ...silo.rows, ...compound.rows]).map((row) => classifyRow(row, knownTokens));
  const highLtvRows = rows.filter((row) => row.highLtv && Number(row.routeLiquidityUsd || 0) >= MIN_ROUTE_LIQUIDITY_USD);
  highLtvRows.sort((a, b) => Number(b.reviewCandidate) - Number(a.reviewCandidate) || Number(b.ltv || 0) - Number(a.ltv || 0) || Number(b.routeLiquidityUsd || 0) - Number(a.routeLiquidityUsd || 0));
  return {
    chainId,
    chain: chain.name,
    rpcResolved: Boolean(provider),
    blockNumber,
    rowsScanned: rows.length,
    highLtvRows: highLtvRows.length,
    reviewCandidates: highLtvRows.filter((row) => row.reviewCandidate).length,
    watchCandidates: 0,
    routePositive: 0,
    stats: {
      morphoMarketsScanned: morpho.length,
      aaveReservesScanned: aave.stats.reservesScanned,
      eulerFactoryListLength: euler.stats.factoryListLength,
      eulerVaultsScanned: euler.stats.vaultsScanned,
      siloIdsScanned: silo.stats.idsScanned,
      siloMarketsScanned: silo.stats.marketsScanned,
      compoundMarketsScanned: compound.stats.marketsScanned,
    },
    breakdown: summarizeRows(highLtvRows),
    highLtvRowsDetail: highLtvRows,
    topRows: highLtvRows.slice(0, 80),
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const chainIds = Object.keys(CHAINS).map(Number);
  const knownTokens = collectKnownTokens();
  const rpcPool = await resolveRpcPool(chainIds);
  const results = [];
  for (const chainId of chainIds) results.push(await scanChain(chainId, rpcPool[chainId], knownTokens));
  const highLtvRows = results.reduce((sum, r) => sum + Number(r.highLtvRows || 0), 0);
  const reviewCandidates = results.reduce((sum, r) => sum + Number(r.reviewCandidates || 0), 0);
  const routePositive = 0;
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-consumer-first-high-ltv-collateral.js",
    scope: "Read-only consumer-first discovery of high-LTV/high-liquidity collateral rows across Morpho, Aave, Euler, Silo, and Compound",
    safety: {
      rpcInventoryRead: Object.keys(rpcPool).length > 0,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    thresholds: {
      minLtv: MIN_LTV,
      minRouteLiquidityUsd: MIN_ROUTE_LIQUIDITY_USD,
      morphoTopN: MORPHO_TOP_N,
      maxEulerVaults: MAX_EULER_VAULTS,
      maxSiloIds: MAX_SILO_IDS,
    },
    knownTokenSources: Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, path.relative(WORKSPACE, file).replace(/\\/g, "/")])),
    summary: {
      chainsScanned: results.length,
      chainsWithRpc: results.filter((r) => r.rpcResolved).length,
      chainsMissingRpc: results.filter((r) => !r.rpcResolved).map((r) => r.chain),
      knownLocalTokenAddresses: knownTokens.size,
      rowsScanned: results.reduce((sum, r) => sum + Number(r.rowsScanned || 0), 0),
      highLtvRows,
      reviewCandidates,
      watchCandidates: 0,
      routePositive,
      signedActionJustified: false,
      breakdown: summarizeRows(results.flatMap((r) => r.highLtvRowsDetail || [])),
    },
    results,
    nextRoutePositiveCriteria: [
      "A high-LTV consumer row maps to a producer with current NAV/oracle/bridge/share anomaly",
      "Borrow-side liquidity is live and above gas/slippage threshold",
      "Acquisition and exit are permissionless and executable for the exact token and route size",
      "Read-only economics are positive after gas, slippage, and liquidation/LLTV haircut",
      "Fork simulation extracts positive value from the exact joined route",
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  console.log(`Consumer-first high-LTV collateral: rows=${artifact.summary.rowsScanned} highLtv=${highLtvRows} review=${reviewCandidates} routePositive=${routePositive}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
