#!/usr/bin/env node
// Read-only coverage scanner for RPC-available chains that lack deep lending coverage.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "seven-chain-lending-coverage.json");
const QUIET = process.argv.includes("--quiet");

const TIMEOUT_MS = Number(process.env.SEVEN_CHAIN_TIMEOUT_MS || "15000");
const MIN_LTV = Number(process.env.SEVEN_CHAIN_MIN_LTV || "0.80");
const MIN_BORROW_LIQUIDITY_USD = Number(process.env.SEVEN_CHAIN_MIN_BORROW_LIQUIDITY_USD || "10000");
const MORPHO_TOP_N = Number(process.env.SEVEN_CHAIN_MORPHO_TOP_N || "300");
const MAX_AAVE_RESERVES = Number(process.env.SEVEN_CHAIN_MAX_AAVE_RESERVES || "80");

// Expanded to 28-chain coverage (was 7)
const CHAINS = {
  1:    { name: "Ethereum",  coinSlug: "ethereum",       llamaNames: ["Ethereum"],  aavePools: [{ protocol: "Aave V3", address: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" }] },
  10:   { name: "Optimism",  coinSlug: "optimism",        llamaNames: ["Optimism"], aavePools: [{ protocol: "Aave V3", address: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" }] },
  56:   { name: "BSC",       coinSlug: "binance-smart-chain", llamaNames: ["BSC","BNB"], aavePools: [{ protocol: "Aave V3", address: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB" }] },
  100:  { name: "Gnosis",    coinSlug: "xdai",             llamaNames: ["Gnosis","xDai"], aavePools: [{ protocol: "Aave V3", address: "0xb50201558B00496A145fE76f7424749556E326D8" }] },
  130:  { name: "Unichain",  coinSlug: "unichain",         llamaNames: ["Unichain"], aavePools: [] },
  137:  { name: "Polygon",   coinSlug: "polygon",          llamaNames: ["Polygon"], aavePools: [{ protocol: "Aave V3", address: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" }] },
  146:  { name: "Sonic",     coinSlug: "sonic",            llamaNames: ["Sonic"], aavePools: [] },
  204:  { name: "opBNB",     coinSlug: "opbnb",            llamaNames: ["opBNB"], aavePools: [] },
  250:  { name: "Fantom",    coinSlug: "fantom",           llamaNames: ["Fantom"], aavePools: [{ protocol: "Aave V3", address: "0x9FAD24f572045c7869117160A571B2e50b10d068" }] },
  324:  { name: "zkSync",    coinSlug: "zksync",           llamaNames: ["zkSync"], aavePools: [] },
  480:  { name: "WorldChain",coinSlug: "worldchain",       llamaNames: ["WorldChain"], aavePools: [] },
  999:  { name: "HyperEVM",  coinSlug: "hyperevm",         llamaNames: ["Hyperliquid"], aavePools: [] },
  1088: { name: "Metis",     coinSlug: "metis",            llamaNames: ["Metis"], aavePools: [] },
  1284: { name: "Moonbeam",  coinSlug: "moonbeam",         llamaNames: ["Moonbeam"], aavePools: [] },
  1285: { name: "Moonriver", coinSlug: "moonriver",        llamaNames: ["Moonriver"], aavePools: [] },
  2222: { name: "Kava",      coinSlug: "kava",             llamaNames: ["Kava"], aavePools: [] },
  5000: { name: "Mantle",    coinSlug: "mantle",           llamaNames: ["Mantle"], aavePools: [] },
  8453: { name: "Base",      coinSlug: "base",             llamaNames: ["Base"], aavePools: [{ protocol: "Aave V3", address: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" }] },
  42161:{ name: "Arbitrum",  coinSlug: "arbitrum",         llamaNames: ["Arbitrum"], aavePools: [{ protocol: "Aave V3", address: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" }] },
  42220:{ name: "Celo",      coinSlug: "celo",             llamaNames: ["Celo"], aavePools: [{ protocol: "Aave V3", address: "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402" }] },
  43114:{ name: "Avalanche", coinSlug: "avalanche",        llamaNames: ["Avalanche"], aavePools: [{ protocol: "Aave V3", address: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" }] },
  81457:{ name: "Blast",     coinSlug: "blast",            llamaNames: ["Blast"], aavePools: [] },
  534352:{ name: "Scroll",   coinSlug: "scroll",           llamaNames: ["Scroll"], aavePools: [{ protocol: "Aave V3", address: "0x11fCfe756c05AD438e312a7fd934381537D3cFfe" }] },
  59144:{ name: "Linea",     coinSlug: "linea",            llamaNames: ["Linea"], aavePools: [{ protocol: "Aave V3", address: "0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac" }] },
  57073:{ name: "Ink",       coinSlug: "ink",              llamaNames: ["Ink"], aavePools: [] },
  80094:{ name: "Bera",      coinSlug: "bera",             llamaNames: ["Berachain"], aavePools: [] },
  25:   { name: "Cronos",    coinSlug: "cronos",           llamaNames: ["Cronos"], aavePools: [] },
  14:   { name: "Flare",     coinSlug: "flare",            llamaNames: ["Flare"], aavePools: [] },
  1313161554: { name: "Aurora",   coinSlug: "aurora",     llamaNames: ["Aurora"], aavePools: [] },
  1666600000: { name: "Harmony",  coinSlug: "harmony",    llamaNames: ["Harmony"], aavePools: [] },
};

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);

const AAVE_POOL = new ethers.Interface([
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns (tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
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

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[$,%\s,_]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 6) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try { return Number(ethers.formatUnits(raw, Number(decimals))); } catch (_) { return null; }
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
  const wanted = new Set(chainIds.map(Number));
  const pool = {};
  for (const url of loadRpcUrls()) {
    try {
      const chainId = Number(BigInt(await rpcCall(url, "eth_chainId", [], 6000)));
      if (wanted.has(chainId) && !pool[chainId]) pool[chainId] = url;
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
    isolationMode: Boolean((raw >> 61n) & 1n),
    borrowCapWholeTokens: ((raw >> 80n) & mask36).toString(),
    supplyCapWholeTokens: ((raw >> 116n) & mask36).toString(),
    liquidationProtocolFeeBps: Number((raw >> 152n) & mask16),
  };
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

async function erc20Balance(provider, token, account) {
  const raw = await safeProviderCall(provider, token, ERC20.encodeFunctionData("balanceOf", [account]));
  return decodeUintResult(raw, "balanceOf") || 0n;
}

async function erc20TotalSupply(provider, token) {
  const raw = await safeProviderCall(provider, token, ERC20.encodeFunctionData("totalSupply", []));
  return decodeUintResult(raw, "totalSupply") || 0n;
}

async function fetchAddressPrices(chain, addresses) {
  const keys = [...new Set((addresses || []).map(lowerAddress).filter(Boolean).map((address) => `${chain.coinSlug}:${address}`))];
  const out = {};
  for (let i = 0; i < keys.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.slice(i, i + 50).join(",")}?searchWidth=6h`, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    Object.assign(out, json.coins || {});
  }
  const map = new Map();
  for (const [key, row] of Object.entries(out)) {
    const address = lowerAddress(key.slice(key.indexOf(":") + 1));
    const price = Number(row?.price || 0);
    if (address && Number.isFinite(price) && price > 0) map.set(address, price);
  }
  return map;
}

const CANONICAL_SYMBOLS = new Set([
  "AAVE", "ARB", "BGB", "BLAST", "CELO", "COMP", "DAI", "EUROC", "EURC", "FRAX", "GNO", "GHO", "LINK", "MNT", "OP", "S", "USDB", "USDC", "USDC.E", "USDT", "WBTC", "WCELO", "WETH", "WFTM", "WMNT", "WXDAI", "XDAI", "WSTETH", "cbBTC", "cbETH", "rETH", "weETH", "ezETH", "rsETH", "mETH",
].map((x) => x.toUpperCase()));

function classifyTokenRisk(row, chain) {
  const text = `${row.collateral?.symbol || ""} ${row.collateral?.name || ""}`;
  const upper = text.toUpperCase();
  const tags = [];
  if (/PT[-_ ]|PENDLE|PRINCIPAL TOKEN/.test(upper)) tags.push("principal-token");
  if (/VAULT|SHARE|ERC4626|STAKED|STAKING|SAVING|YIELD|RECEIPT|SAVINGS/.test(upper) || /^S[A-Z0-9]{2,}/.test(String(row.collateral?.symbol || ""))) tags.push("receipt-or-yield-bearing");
  if (/OFT|BRIDGE|WARP|WORMHOLE|LAYERZERO|AXELAR/.test(upper)) tags.push("bridge-wrapper");
  if (/RWA|TREASUR|T-BILL|CREDIT|BOND|BACKED|USDY|OUSG|BUIDL|SYRUP|MAPLE/.test(upper)) tags.push("rwa-or-credit");
  if (chain.chainId === 81457 && /WETH|ETH|USDB|BLAST/.test(upper)) tags.push("blast-native-yield-surface");
  if (!CANONICAL_SYMBOLS.has(String(row.collateral?.symbol || "").toUpperCase())) tags.push("noncanonical-or-unknown");
  return [...new Set(tags)];
}

function classifyRow(row, chain) {
  const riskTags = classifyTokenRisk(row, chain);
  const highLtv = Number(row.ltv || 0) >= MIN_LTV;
  const materialBorrowLiquidity = Number(row.routeLiquidityUsd || 0) >= MIN_BORROW_LIQUIDITY_USD;
  const novelRisk = riskTags.some((tag) => ["principal-token", "receipt-or-yield-bearing", "bridge-wrapper", "rwa-or-credit", "blast-native-yield-surface", "noncanonical-or-unknown"].includes(tag));
  const capRisk = row.consumer?.borrowCapWholeTokens === "0" || row.consumer?.supplyCapWholeTokens === "0" ? false : (row.consumer?.borrowCapWholeTokens === "68719476735" || row.consumer?.supplyCapWholeTokens === "68719476735");
  const watchCandidate = highLtv && materialBorrowLiquidity && novelRisk;
  return {
    ...row,
    riskTags,
    highLtv,
    materialBorrowLiquidity,
    reviewCandidate: highLtv && materialBorrowLiquidity,
    watchCandidate,
    capRisk,
    routePositive: false,
    blockers: [
      watchCandidate ? "Watch-only: needs producer/oracle-specific exact acquisition and exit economics" : null,
      !highLtv ? `Collateral LTV below ${MIN_LTV}` : null,
      !materialBorrowLiquidity ? `Borrow-side liquidity below $${MIN_BORROW_LIQUIDITY_USD}` : null,
      !novelRisk ? "Canonical collateral shape; no current producer-risk anomaly" : null,
      "No exact acquisition/borrow/exit route or fork proof",
    ].filter(Boolean),
  };
}

async function morphoQuery(chainId) {
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
  const json = await fetchJson("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { chainIds: [chainId], minSupply: 1 } }),
    timeoutMs: 30_000,
  }).catch(() => null);
  return json?.data?.markets?.items || [];
}

function morphoLltvRatio(value) {
  try { return Number(BigInt(String(value || 0))) / 1e18; } catch (_) { return Number(value || 0); }
}

async function scanMorpho(chainId, chain) {
  const markets = await morphoQuery(chainId);
  return {
    rows: markets.map((market) => ({
      protocol: "Morpho Blue",
      chainId,
      chain: chain.name,
      consumer: { marketId: market.marketId, oracle: normalizeAddress(market.oracle?.address), loanAsset: market.loanAsset, collateralAsset: market.collateralAsset },
      collateral: { address: normalizeAddress(market.collateralAsset?.address), symbol: market.collateralAsset?.symbol || null, decimals: market.collateralAsset?.decimals ?? null },
      borrowAsset: { address: normalizeAddress(market.loanAsset?.address), symbol: market.loanAsset?.symbol || null, decimals: market.loanAsset?.decimals ?? null },
      ltv: morphoLltvRatio(market.lltv),
      routeLiquidityUsd: Number(market.state?.liquidityAssetsUsd || 0),
      supplyAssetsUsd: Number(market.state?.supplyAssetsUsd || 0),
      borrowAssetsUsd: Number(market.state?.borrowAssetsUsd || 0),
      utilization: market.state?.utilization ?? null,
    })),
    stats: { marketsScanned: markets.length },
  };
}

async function scanAavePool(provider, chainId, chain, candidate) {
  const pool = normalizeAddress(candidate.address);
  if (!provider || !pool) return { rows: [], pool: { ...candidate, valid: false, reason: "missing-provider-or-address" } };
  const code = await provider.getCode(pool).catch(() => "0x");
  if (!code || code === "0x") return { rows: [], pool: { ...candidate, valid: false, reason: "no-code" } };
  const reservesRaw = await safeProviderCall(provider, pool, AAVE_POOL.encodeFunctionData("getReservesList", []));
  const reserves = (decodeResult(reservesRaw, AAVE_POOL, "getReservesList")?.[0] || []).map(normalizeAddress).filter(Boolean).slice(0, MAX_AAVE_RESERVES);
  if (!reserves.length) return { rows: [], pool: { ...candidate, valid: false, reason: "getReservesList-empty-or-failed", codeBytes: Math.max(0, (code.length - 2) / 2) } };

  const rows = [];
  const tokenSet = new Set();
  for (const reserve of reserves) tokenSet.add(reserve.toLowerCase());
  const metas = new Map();
  for (const reserve of reserves) metas.set(reserve.toLowerCase(), await tokenMeta(provider, reserve, {}));

  const prices = await fetchAddressPrices(chain, reserves);
  let totalBorrowableCashUsd = 0;
  const rawRows = [];
  for (const reserve of reserves) {
    const dataRaw = await safeProviderCall(provider, pool, AAVE_POOL.encodeFunctionData("getReserveData", [reserve]));
    if (!dataRaw || dataRaw === "0x") continue;
    const cfg = decodeAaveConfig(BigInt(wordAt(dataRaw, 0) || 0n));
    const meta = metas.get(reserve.toLowerCase()) || { address: reserve, decimals: cfg.decimals || 18 };
    const aToken = normalizeAddress(addressWordAt(dataRaw, 8));
    const stableDebtToken = normalizeAddress(addressWordAt(dataRaw, 9));
    const variableDebtToken = normalizeAddress(addressWordAt(dataRaw, 10));
    const decimals = cfg.decimals || meta.decimals || 18;
    const [cashRaw, stableDebtRaw, variableDebtRaw] = await Promise.all([
      aToken ? erc20Balance(provider, reserve, aToken).catch(() => 0n) : 0n,
      stableDebtToken ? erc20TotalSupply(provider, stableDebtToken).catch(() => 0n) : 0n,
      variableDebtToken ? erc20TotalSupply(provider, variableDebtToken).catch(() => 0n) : 0n,
    ]);
    const cash = formatUnitsNumber(cashRaw, decimals) || 0;
    const debt = formatUnitsNumber(stableDebtRaw + variableDebtRaw, decimals) || 0;
    const price = Number(prices.get(reserve.toLowerCase()) || 0);
    const cashUsd = cash * price;
    const debtUsd = debt * price;
    if (cfg.active && !cfg.paused && cfg.borrowingEnabled) totalBorrowableCashUsd += cashUsd;
    rawRows.push({ reserve, cfg, meta, aToken, stableDebtToken, variableDebtToken, cashRaw, stableDebtRaw, variableDebtRaw, cash, debt, price, cashUsd, debtUsd });
  }

  for (const raw of rawRows) {
    rows.push({
      protocol: candidate.protocol || "Aave V3",
      chainId,
      chain: chain.name,
      consumer: {
        pool,
        poolLabel: candidate.label,
        aToken: raw.aToken,
        stableDebtToken: raw.stableDebtToken,
        variableDebtToken: raw.variableDebtToken,
        active: raw.cfg.active,
        frozen: raw.cfg.frozen,
        paused: raw.cfg.paused,
        borrowingEnabled: raw.cfg.borrowingEnabled,
        isolationMode: raw.cfg.isolationMode,
        borrowCapWholeTokens: raw.cfg.borrowCapWholeTokens,
        supplyCapWholeTokens: raw.cfg.supplyCapWholeTokens,
      },
      collateral: raw.meta,
      borrowAsset: { address: null, symbol: "multi-reserve", decimals: null },
      ltv: raw.cfg.ltv,
      liquidationThreshold: raw.cfg.liquidationThreshold,
      routeLiquidityUsd: Math.max(0, totalBorrowableCashUsd - raw.cashUsd),
      cash: round(raw.cash, 6),
      cashUsd: round(raw.cashUsd, 2),
      debt: round(raw.debt, 6),
      debtUsd: round(raw.debtUsd, 2),
      priceUsd: raw.price || null,
    });
  }

  return {
    rows,
    pool: { ...candidate, address: pool, valid: true, reservesScanned: rows.length, totalBorrowableCashUsd: round(totalBorrowableCashUsd, 2), codeBytes: Math.max(0, (code.length - 2) / 2) },
  };
}

async function scanAave(provider, chainId, chain) {
  const pools = [];
  const rows = [];
  for (const candidate of chain.aavePools || []) {
    const result = await scanAavePool(provider, chainId, chain, candidate);
    pools.push(result.pool);
    rows.push(...result.rows);
  }
  return { rows, stats: { poolsChecked: pools.length, poolsValid: pools.filter((p) => p.valid).length, pools } };
}

async function fetchLlamaProtocols() {
  const protocols = await fetchJson("https://api.llama.fi/protocols", { timeoutMs: 30_000 }).catch(() => []);
  const byChain = {};
  for (const [chainIdText, chain] of Object.entries(CHAINS)) {
    const names = new Set((chain.llamaNames || [chain.name]).map((name) => String(name).toLowerCase()));
    const rows = (protocols || []).filter((p) => {
      const category = String(p.category || "").toLowerCase();
      if (!/(lend|cdp|yield|liquid staking|restaking|derivatives|dexs)/.test(category)) return false;
      return (p.chains || []).some((name) => names.has(String(name).toLowerCase()));
    }).map((p) => ({ name: p.name, slug: p.slug, category: p.category, tvl: round(p.tvl, 2), chains: (p.chains || []).filter((name) => names.has(String(name).toLowerCase())) }))
      .sort((a, b) => (Number(b.tvl || 0) - Number(a.tvl || 0)))
      .slice(0, 30);
    byChain[Number(chainIdText)] = rows;
  }
  return byChain;
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = [row.protocol, row.chainId, lowerAddress(row.collateral?.address), row.consumer?.marketId || row.consumer?.pool || "", row.borrowAsset?.address || row.borrowAsset?.symbol || ""].join(":").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function summarizeRows(rows) {
  const summary = { byChain: {}, byProtocol: {}, byRiskTag: {} };
  for (const row of rows || []) {
    summary.byChain[row.chain] = (summary.byChain[row.chain] || 0) + 1;
    summary.byProtocol[row.protocol] = (summary.byProtocol[row.protocol] || 0) + 1;
    for (const tag of row.riskTags || []) summary.byRiskTag[tag] = (summary.byRiskTag[tag] || 0) + 1;
  }
  return summary;
}

async function scanChain(chainId, rpc, llamaProtocols) {
  const chain = { ...CHAINS[chainId], chainId };
  const provider = rpc ? new ethers.JsonRpcProvider(rpc, Number(chainId), { staticNetwork: true }) : null;
  const blockNumber = provider ? await provider.getBlockNumber().catch(() => null) : null;
  if (!QUIET) console.log(`Scanning ${chain.name}: seven-chain lending coverage`);
  const [morpho, aave] = await Promise.all([
    scanMorpho(chainId, chain),
    scanAave(provider, chainId, chain),
  ]);
  const rows = dedupeRows([...morpho.rows, ...aave.rows]).map((row) => classifyRow(row, chain));
  const highLtvRows = rows.filter((row) => row.highLtv && row.materialBorrowLiquidity);
  const watchRows = highLtvRows.filter((row) => row.watchCandidate);
  highLtvRows.sort((a, b) => Number(b.watchCandidate) - Number(a.watchCandidate) || Number(b.ltv || 0) - Number(a.ltv || 0) || Number(b.routeLiquidityUsd || 0) - Number(a.routeLiquidityUsd || 0));
  return {
    chainId,
    chain: chain.name,
    rpcResolved: Boolean(provider),
    blockNumber,
    protocolDiscovery: llamaProtocols || [],
    rowsScanned: rows.length,
    highLtvRows: highLtvRows.length,
    reviewCandidates: highLtvRows.length,
    watchCandidates: watchRows.length,
    routePositive: 0,
    stats: {
      morphoMarketsScanned: morpho.stats.marketsScanned,
      aavePoolsChecked: aave.stats.poolsChecked,
      aavePoolsValid: aave.stats.poolsValid,
      aavePools: aave.stats.pools,
    },
    breakdown: summarizeRows(highLtvRows),
    highLtvRowsDetail: highLtvRows,
    topRows: highLtvRows.slice(0, 60),
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const chainIds = Object.keys(CHAINS).map(Number);
  const [rpcPool, protocolsByChain] = await Promise.all([
    resolveRpcPool(chainIds),
    fetchLlamaProtocols(),
  ]);
  const results = [];
  for (const chainId of chainIds) results.push(await scanChain(chainId, rpcPool[chainId], protocolsByChain[chainId] || []));
  const allHighLtv = results.flatMap((r) => r.highLtvRowsDetail || []);
  const watchRows = allHighLtv.filter((row) => row.watchCandidate);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-seven-chain-lending-coverage.js",
    scope: "Read-only lending coverage expansion for Gnosis, Linea, Scroll, Celo, Fantom, Blast, and Mantle",
    safety: {
      rpcInventoryRead: Object.keys(rpcPool).length > 0,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    thresholds: {
      minLtv: MIN_LTV,
      minBorrowLiquidityUsd: MIN_BORROW_LIQUIDITY_USD,
      morphoTopN: MORPHO_TOP_N,
      maxAaveReserves: MAX_AAVE_RESERVES,
    },
    summary: {
      chainsScanned: results.length,
      chainsWithRpc: results.filter((r) => r.rpcResolved).length,
      chainsMissingRpc: results.filter((r) => !r.rpcResolved).map((r) => r.chain),
      protocolDiscoveryRows: results.reduce((sum, r) => sum + (r.protocolDiscovery || []).length, 0),
      rowsScanned: results.reduce((sum, r) => sum + Number(r.rowsScanned || 0), 0),
      highLtvRows: allHighLtv.length,
      reviewCandidates: allHighLtv.length,
      watchCandidates: watchRows.length,
      routePositive: 0,
      signedActionJustified: false,
      aavePoolsChecked: results.reduce((sum, r) => sum + Number(r.stats?.aavePoolsChecked || 0), 0),
      aavePoolsValid: results.reduce((sum, r) => sum + Number(r.stats?.aavePoolsValid || 0), 0),
      morphoMarketsScanned: results.reduce((sum, r) => sum + Number(r.stats?.morphoMarketsScanned || 0), 0),
      breakdown: summarizeRows(allHighLtv),
    },
    topRows: allHighLtv.slice().sort((a, b) => Number(b.watchCandidate) - Number(a.watchCandidate) || Number(b.routeLiquidityUsd || 0) - Number(a.routeLiquidityUsd || 0)).slice(0, 100),
    results,
    nextRoutePositiveCriteria: [
      "high-LTV lending consumer row maps to current producer/oracle/accounting anomaly",
      "borrow-side liquidity is material and unpaused",
      "collateral acquisition and borrowed-asset exit are exact-quoted",
      "gas/slippage/flash-fee adjusted economics are positive",
      "local fork extraction proof measures positive net value",
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  if (!QUIET) {
    console.log(`Seven-chain lending coverage: rows=${artifact.summary.rowsScanned} highLtv=${artifact.summary.highLtvRows} watch=${artifact.summary.watchCandidates} routePositive=0`);
    console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
  } else {
    console.log(`Seven-chain lending coverage: rows=${artifact.summary.rowsScanned} highLtv=${artifact.summary.highLtvRows} watch=${artifact.summary.watchCandidates} routePositive=0`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
