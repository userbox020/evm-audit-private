#!/usr/bin/env node
// Read-only multi-chain Pendle PT consumer graph scanner.
// Ports the LoopScale-style PT unit-mismatch search beyond Ethereum.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "pendle-pt-multichain-consumer-graph.json");
const HIGH_LTV = path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json");
const AES_GRAPH = path.join(WORKSPACE, "reports", "raw", "fast", "aave-euler-silo-consumer-graph.json");

const DEFAULT_CHAIN_IDS = [1, 56, 8453, 42161];
const CHAIN_IDS = String(process.env.PENDLE_PT_MULTI_CHAIN_IDS || DEFAULT_CHAIN_IDS.join(","))
  .split(/[,\s]+/)
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const ROUTE_LIQUIDITY_USD = Number(process.env.PENDLE_PT_MULTI_ROUTE_LIQUIDITY_USD || "10000");
const GAS_UNITS = Number(process.env.PENDLE_PT_MULTI_ROUTE_GAS_UNITS || "1600000");
const SLIPPAGE_BPS = Number(process.env.PENDLE_PT_MULTI_ROUTE_SLIPPAGE_BPS || "100");
const QUOTE_ITERATIONS = Number(process.env.PENDLE_PT_MULTI_QUOTE_ITERATIONS || "22");
const MAX_MARKETS_PER_CHAIN = Number(process.env.PENDLE_PT_MULTI_MAX_MARKETS_PER_CHAIN || "120");

const CHAINS = {
  1: { name: "Ethereum", coinSlug: "ethereum", gasPriceKey: "coingecko:ethereum", aavePool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" },
  10: { name: "Optimism", coinSlug: "optimism", gasPriceKey: "coingecko:ethereum", aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" },
  56: { name: "BNB Chain", coinSlug: "bsc", gasPriceKey: "coingecko:binancecoin" },
  137: { name: "Polygon", coinSlug: "polygon", gasPriceKey: "coingecko:matic-network", aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" },
  8453: { name: "Base", coinSlug: "base", gasPriceKey: "coingecko:ethereum", aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" },
  42161: { name: "Arbitrum", coinSlug: "arbitrum", gasPriceKey: "coingecko:ethereum", aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" },
  130: { name: "Unichain", coinSlug: "unichain", gasPriceKey: "coingecko:ethereum" },
  43114: { name: "Avalanche", coinSlug: "avalanche", gasPriceKey: "coingecko:avalanche-2" },
};

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const AAVE_POOL_IFACE = new ethers.Interface([
  "function ADDRESSES_PROVIDER() view returns (address)",
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns (tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
]);
const AAVE_ADDRESSES_PROVIDER = new ethers.Interface(["function getPriceOracle() view returns (address)"]);
const AAVE_ORACLE = new ethers.Interface(["function getSourceOfAsset(address asset) view returns (address)"]);
const MORPHO_ORACLE = new ethers.Interface(["function price() view returns (uint256)"]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
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

function pendleAddress(value) {
  const raw = String(value || "");
  const part = raw.includes("-") ? raw.split("-").pop() : raw;
  return normalizeAddress(part);
}

function round(value, decimals = 6) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function asFiniteNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function maxFinite(values) {
  const nums = (values || []).map(asFiniteNumber).filter((n) => n !== null);
  return nums.length ? Math.max(...nums) : null;
}

function minFinite(values) {
  const nums = (values || []).map(asFiniteNumber).filter((n) => n !== null);
  return nums.length ? Math.min(...nums) : null;
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 15_000) {
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
      const idHex = await rpcCall(url, "eth_chainId", [], 6000);
      const chainId = Number(BigInt(idHex));
      if (wanted.has(chainId) && !pool[chainId]) pool[chainId] = url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return pool;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 20_000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonRetry(url, options = {}, attempts = 4) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchJson(url, options);
    } catch (err) {
      lastErr = err;
      if (i + 1 < attempts) await sleep(1000 * (i + 1));
    }
  }
  throw lastErr || new Error("fetch failed");
}

async function safeCall(provider, to, data) {
  try {
    const target = normalizeAddress(to);
    if (!provider || !target) return null;
    return await provider.call({ to: target, data });
  } catch (_) {
    return null;
  }
}

function decode(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}

function decodeString(raw, fn) {
  return decode(raw, ERC20, fn)?.[0]?.toString() || null;
}

function wordAt(raw, index) {
  const hex = strip0x(raw);
  const start = index * 64;
  if (!hex || hex.length < start + 64) return null;
  return `0x${hex.slice(start, start + 64)}`;
}

function addressFromWord(raw) {
  if (!raw || raw === "0x") return null;
  const hex = strip0x(raw).padStart(64, "0");
  if (/^0+$/.test(hex)) return null;
  return normalizeAddress(`0x${hex.slice(-40)}`);
}

function addressWordAt(raw, index) {
  const word = wordAt(raw, index);
  return word ? addressFromWord(word) : null;
}

function decodeAaveConfig(rawData) {
  const raw = BigInt(rawData || 0n);
  const mask16 = 0xffffn;
  return {
    ltv: Number(raw & mask16) / 10_000,
    liquidationThreshold: Number((raw >> 16n) & mask16) / 10_000,
    decimals: Number((raw >> 48n) & 0xffn),
    active: Boolean((raw >> 56n) & 1n),
    frozen: Boolean((raw >> 57n) & 1n),
    borrowingEnabled: Boolean((raw >> 58n) & 1n),
    paused: Boolean((raw >> 60n) & 1n),
  };
}

function formatUnitsNumber(raw, decimals) {
  try { return Number(ethers.formatUnits(raw || 0n, Number(decimals || 18))); } catch (_) { return null; }
}

function decimalToUnits(value, decimals) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0 || decimals === null || decimals === undefined) return null;
  const places = Math.min(Number(decimals), 18);
  const fixed = Number(value).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: places });
  try { return ethers.parseUnits(fixed, Number(decimals)); } catch (_) { return null; }
}

function bpsDiff(reference, observed) {
  const ref = Number(reference || 0);
  const obs = Number(observed || 0);
  if (!Number.isFinite(ref) || !Number.isFinite(obs) || ref <= 0 || obs <= 0) return null;
  return ((obs / ref) - 1) * 10_000;
}

async function tokenMeta(provider, address, fallback = {}) {
  const token = normalizeAddress(address);
  if (!token || !provider) return { address: token, addressLower: token?.toLowerCase() || null, symbol: fallback.symbol || null, decimals: fallback.decimals ?? 18 };
  const [symbolRaw, decimalsRaw] = await Promise.all([
    safeCall(provider, token, ERC20.encodeFunctionData("symbol", [])),
    safeCall(provider, token, ERC20.encodeFunctionData("decimals", [])),
  ]);
  return {
    address: token,
    addressLower: token.toLowerCase(),
    symbol: decodeString(symbolRaw, "symbol") || fallback.symbol || null,
    decimals: Number(decode(decimalsRaw, ERC20, "decimals")?.[0] ?? fallback.decimals ?? 18),
  };
}

function priceMapKey(chainId, address) {
  const lower = lowerAddress(address);
  return lower ? `${Number(chainId)}:${lower}` : null;
}

function priceFromMap(prices, chainId, address) {
  const key = priceMapKey(chainId, address);
  return key ? prices.get(key) || null : null;
}

async function fetchPrices(refs) {
  const keyToRefs = new Map();
  for (const ref of refs || []) {
    const cfg = CHAINS[Number(ref?.chainId)];
    const lower = lowerAddress(ref?.address);
    if (!cfg?.coinSlug || !lower) continue;
    const coinKey = `${cfg.coinSlug}:${lower}`.toLowerCase();
    const list = keyToRefs.get(coinKey) || [];
    list.push({ chainId: Number(ref.chainId), address: lower });
    keyToRefs.set(coinKey, list);
  }
  const out = new Map();
  const keys = [...keyToRefs.keys()];
  for (let i = 0; i < keys.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.slice(i, i + 50).join(",")}?searchWidth=6h`, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    for (const [key, row] of Object.entries(json.coins || {})) {
      const price = Number(row?.price || 0);
      if (price <= 0) continue;
      for (const ref of keyToRefs.get(key.toLowerCase()) || []) out.set(`${ref.chainId}:${ref.address}`, price);
    }
  }
  return out;
}

async function fetchCoinKeyPrices(keys) {
  const uniq = [...new Set((keys || []).filter(Boolean).map((key) => String(key).toLowerCase()))];
  const out = new Map();
  for (let i = 0; i < uniq.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${uniq.slice(i, i + 50).join(",")}?searchWidth=6h`, { timeoutMs: 20_000 }).catch(() => ({ coins: {} }));
    for (const [key, row] of Object.entries(json.coins || {})) {
      const price = Number(row?.price || 0);
      if (price > 0) out.set(key.toLowerCase(), price);
    }
  }
  return out;
}

async function quotePendleMarketOrder(chainId, marketAddress, syInRaw) {
  const market = normalizeAddress(marketAddress);
  if (!market || syInRaw <= 0n) return null;
  return fetchJson("https://api-v2.pendle.finance/core/v3/limit-orders/market-order", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: Number(chainId), type: 0, netFromTaker: syInRaw.toString(), market }),
    timeoutMs: 30_000,
  });
}

function marketOrderPtOutRaw(quote) {
  try { return BigInt(quote?.totalTrade?.netToTaker || "0"); } catch (_) { return 0n; }
}

async function findSyInForPtOut(chainId, marketAddress, targetPtRaw, estimateSyRaw) {
  if (!marketAddress || !targetPtRaw || targetPtRaw <= 0n || !estimateSyRaw || estimateSyRaw <= 0n) return null;
  let low = 0n;
  let high = estimateSyRaw;
  let highQuote = null;
  for (let i = 0; i < 8; i++) {
    highQuote = await quotePendleMarketOrder(chainId, marketAddress, high).catch(() => null);
    if (marketOrderPtOutRaw(highQuote) >= targetPtRaw) break;
    high *= 2n;
    highQuote = null;
  }
  if (!highQuote) return { ok: false, reason: "Pendle quote could not satisfy target PT amount" };
  let best = { syInRaw: high, quote: highQuote };
  for (let i = 0; i < QUOTE_ITERATIONS; i++) {
    const mid = (low + high) / 2n;
    if (mid <= low) break;
    const quote = await quotePendleMarketOrder(chainId, marketAddress, mid).catch(() => null);
    if (quote && marketOrderPtOutRaw(quote) >= targetPtRaw) {
      high = mid;
      best = { syInRaw: mid, quote };
    } else {
      low = mid;
    }
  }
  return { ok: true, ...best };
}

function fallbackPtPriceUsd(producer) {
  const syPrice = Number(producer.syPriceUsd || producer.underlyingPriceUsd || 0);
  if (syPrice <= 0) return null;
  const expiryTime = producer.expiry ? Date.parse(producer.expiry) : NaN;
  const years = Number.isFinite(expiryTime) ? Math.max(0, (expiryTime - Date.now()) / (365 * 24 * 3600 * 1000)) : 0.25;
  const apy = Number(producer.impliedApy || 0);
  const discountFactor = apy > 0 ? 1 / (1 + apy * years) : 0.95;
  return syPrice * Math.max(0.01, Math.min(1, discountFactor));
}

async function fetchPendleMarkets(chainId, provider) {
  const json = await fetchJsonRetry(`https://api-v2.pendle.finance/core/v1/${chainId}/markets/active`, { timeoutMs: 30_000 }, 5).catch(() => ({ markets: [] }));
  const markets = Array.isArray(json?.markets) ? json.markets.slice(0, MAX_MARKETS_PER_CHAIN) : [];
  const producers = [];
  for (const market of markets) {
    const pt = pendleAddress(market.pt);
    if (!pt) continue;
    const sy = pendleAddress(market.sy);
    const [meta, syMeta] = await Promise.all([
      tokenMeta(provider, pt, { symbol: `PT-${market.name || pt.slice(0, 8)}` }).catch(() => ({ address: pt, addressLower: pt.toLowerCase(), symbol: `PT-${market.name || pt.slice(0, 8)}`, decimals: 18 })),
      sy ? tokenMeta(provider, sy).catch(() => ({ symbol: null, decimals: 18 })) : Promise.resolve({ symbol: null, decimals: 18 }),
    ]);
    producers.push({
      protocol: "Pendle",
      category: "principal-token",
      chain: CHAINS[chainId]?.name || String(chainId),
      chainId,
      marketName: market.name || null,
      market: normalizeAddress(market.address),
      pt,
      address: pt,
      addressLower: pt.toLowerCase(),
      symbol: meta.symbol || `PT-${market.name || pt.slice(0, 8)}`,
      decimals: Number(meta.decimals ?? 18),
      yt: pendleAddress(market.yt),
      sy,
      sySymbol: syMeta.symbol || null,
      syDecimals: Number(syMeta.decimals ?? 18),
      underlyingAsset: pendleAddress(market.underlyingAsset),
      expiry: market.expiry || null,
      liquidityUsdHint: Number(market.details?.liquidity || 0),
      impliedApy: Number(market.details?.impliedApy || 0) || null,
      blocker: "No current PT consumer-specific positive economics",
    });
  }
  return producers;
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

function morphoFields() {
  return `
    marketId
    loanAsset { symbol address decimals }
    collateralAsset { symbol address decimals }
    oracle { address }
    lltv
    state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization }
  `;
}

async function fetchMorphoConsumers(chainId, producers, fieldName) {
  if (!producers.length) return [];
  const query = `query($chainIds:[Int!]!, $assets:[String!]!) {
    markets(first:100, orderBy:SupplyAssetsUsd, orderDirection:Desc,
      where:{chainId_in:$chainIds, ${fieldName}:$assets}) { items { ${morphoFields()} } }
  }`;
  const assets = producers.map((p) => p.addressLower);
  const rows = [];
  for (let i = 0; i < assets.length; i += 50) {
    rows.push(...await morphoQuery(query, { chainIds: [Number(chainId)], assets: assets.slice(i, i + 50) }).catch(() => []));
  }
  return rows;
}

function morphoLltvRatio(value) {
  try { return Number(BigInt(String(value || 0))) / 1e18; } catch (_) { return Number(value || 0); }
}

function classifyMatch(producer, protocol, side, market, extraBlockers = []) {
  const ltv = Number(market.ltv ?? market.lltv ?? market.maxLtv ?? 0);
  const liquidityUsd = Number(market.otherReserveCashUsd ?? market.liquidityAssetsUsd ?? market.oppositeLiquidityUsd ?? market.cashUsd ?? market.routeLiquidityUsd ?? 0);
  const collateralLike = /collateral|reserveAsset|priceSource|silo|oracle/i.test(side);
  const reviewCandidate = collateralLike && ltv > 0 && liquidityUsd >= ROUTE_LIQUIDITY_USD;
  return {
    protocol,
    chainId: producer.chainId,
    chain: producer.chain,
    side,
    producer,
    market,
    ltv,
    liquidityUsd: round(liquidityUsd, 6),
    reviewCandidate,
    watchCandidate: reviewCandidate,
    routePositive: false,
    blockers: [
      reviewCandidate ? "PT is collateral/oracle-side with material borrow liquidity; needs exact oracle/acquisition/fork proof" : null,
      producer.blocker,
      ltv <= 0 ? "Collateral LTV disabled or unconfirmed" : null,
      liquidityUsd < ROUTE_LIQUIDITY_USD ? "Route-side liquidity below threshold or unpriced" : null,
      ...extraBlockers,
      "No fork proof before route-positive gate",
    ].filter(Boolean),
  };
}

async function scanMorpho(producers) {
  const rows = [];
  const stats = {};
  for (const chainId of [...new Set(producers.map((p) => p.chainId))]) {
    const chainProducers = producers.filter((p) => p.chainId === chainId);
    const byAddr = new Map(chainProducers.map((p) => [p.addressLower, p]));
    const [collateral, loan] = await Promise.all([
      fetchMorphoConsumers(chainId, chainProducers, "collateralAssetAddress_in"),
      fetchMorphoConsumers(chainId, chainProducers, "loanAssetAddress_in"),
    ]);
    stats[chainId] = { collateralMatches: collateral.length, loanMatches: loan.length };
    for (const market of collateral) {
      const producer = byAddr.get(lowerAddress(market.collateralAsset?.address));
      if (!producer) continue;
      rows.push(classifyMatch(producer, "Morpho Blue", "collateralAsset", {
        marketId: market.marketId,
        loanAsset: market.loanAsset,
        collateralAsset: market.collateralAsset,
        oracle: market.oracle,
        lltv: morphoLltvRatio(market.lltv),
        liquidityAssetsUsd: Number(market.state?.liquidityAssetsUsd || 0),
        borrowAssetsUsd: Number(market.state?.borrowAssetsUsd || 0),
        supplyAssetsUsd: Number(market.state?.supplyAssetsUsd || 0),
      }));
    }
    for (const market of loan) {
      const producer = byAddr.get(lowerAddress(market.loanAsset?.address));
      if (!producer) continue;
      rows.push(classifyMatch(producer, "Morpho Blue", "loanAsset", {
        marketId: market.marketId,
        loanAsset: market.loanAsset,
        collateralAsset: market.collateralAsset,
        oracle: market.oracle,
        lltv: morphoLltvRatio(market.lltv),
        liquidityAssetsUsd: Number(market.state?.liquidityAssetsUsd || 0),
        borrowAssetsUsd: Number(market.state?.borrowAssetsUsd || 0),
        supplyAssetsUsd: Number(market.state?.supplyAssetsUsd || 0),
      }, ["PT is loan asset, not collateral-side overvaluation route"]));
    }
  }
  return { rows, stats };
}

async function scanAave(provider, chainId, producers, prices) {
  const chain = CHAINS[chainId];
  if (!provider || !chain?.aavePool || !producers.length) return { rows: [], stats: { reservesScanned: 0, priceSourcesScanned: 0 } };
  const byAddr = new Map(producers.map((p) => [p.addressLower, p]));
  const reservesRaw = await safeCall(provider, chain.aavePool, AAVE_POOL_IFACE.encodeFunctionData("getReservesList", []));
  const reserves = (decode(reservesRaw, AAVE_POOL_IFACE, "getReservesList")?.[0] || []).map(normalizeAddress).filter(Boolean);
  const providerRaw = await safeCall(provider, chain.aavePool, AAVE_POOL_IFACE.encodeFunctionData("ADDRESSES_PROVIDER", []));
  const addressesProvider = normalizeAddress(decode(providerRaw, AAVE_POOL_IFACE, "ADDRESSES_PROVIDER")?.[0]);
  const oracleRaw = addressesProvider ? await safeCall(provider, addressesProvider, AAVE_ADDRESSES_PROVIDER.encodeFunctionData("getPriceOracle", [])) : null;
  const priceOracle = normalizeAddress(decode(oracleRaw, AAVE_ADDRESSES_PROVIDER, "getPriceOracle")?.[0]);
  const metas = [];
  for (const reserve of reserves) {
    const [dataRaw, symRaw] = await Promise.all([
      safeCall(provider, chain.aavePool, AAVE_POOL_IFACE.encodeFunctionData("getReserveData", [reserve])),
      safeCall(provider, reserve, ERC20.encodeFunctionData("symbol", [])),
    ]);
    if (!dataRaw || dataRaw === "0x") continue;
    const cfg = decodeAaveConfig(BigInt(wordAt(dataRaw, 0) || 0n));
    const aToken = normalizeAddress(addressWordAt(dataRaw, 8) || addressWordAt(dataRaw, 9));
    const cashRaw = aToken ? decode(await safeCall(provider, reserve, ERC20.encodeFunctionData("balanceOf", [aToken])), ERC20, "balanceOf")?.[0] || 0n : 0n;
    const sourceRaw = priceOracle ? await safeCall(provider, priceOracle, AAVE_ORACLE.encodeFunctionData("getSourceOfAsset", [reserve])) : null;
    const priceSource = normalizeAddress(decode(sourceRaw, AAVE_ORACLE, "getSourceOfAsset")?.[0]);
    const cash = formatUnitsNumber(cashRaw, cfg.decimals || 18);
    const price = priceFromMap(prices, chainId, reserve) || 0;
    metas.push({ reserve, symbol: decodeString(symRaw, "symbol"), aToken, priceOracle, priceSource, cashRaw: cashRaw.toString(), cash, cashUsd: cash * price, ...cfg });
  }
  const borrowableCashUsd = metas.filter((m) => m.active && !m.paused && m.borrowingEnabled).reduce((sum, m) => sum + Number(m.cashUsd || 0), 0);
  const rows = [];
  for (const meta of metas) {
    const producer = byAddr.get(meta.reserve.toLowerCase());
    if (producer) rows.push(classifyMatch(producer, "Aave V3", "reserveAsset", { ...meta, otherReserveCashUsd: Math.max(0, borrowableCashUsd - Number(meta.cashUsd || 0)) }));
  }
  const producersByNeedle = producers.map((p) => ({ producer: p, needle: strip0x(p.addressLower) }));
  for (const meta of metas.filter((m) => m.priceSource)) {
    const code = await provider.getCode(meta.priceSource).catch(() => "0x");
    const lowerCode = strip0x(code).toLowerCase();
    for (const { producer, needle } of producersByNeedle) {
      if (needle && lowerCode.includes(needle)) rows.push(classifyMatch(producer, "Aave V3", "priceSourceBytecodeReference", { ...meta, otherReserveCashUsd: Math.max(0, borrowableCashUsd - Number(meta.cashUsd || 0)) }, ["Bytecode reference needs source-level oracle confirmation"]));
    }
  }
  return { rows, stats: { reservesScanned: metas.length, priceSourcesScanned: metas.filter((m) => m.priceSource).length } };
}

function scanHighLtvArtifact(producers) {
  const byKey = new Map(producers.map((p) => [`${p.chainId}:${p.addressLower}`, p]));
  const artifact = readJson(HIGH_LTV, { results: [] });
  const rows = [];
  for (const result of artifact.results || []) {
    const chainId = Number(result.chainId);
    for (const row of result.highLtvRowsDetail || result.topRows || []) {
      const collateral = lowerAddress(row.collateral?.address || row.consumer?.collateralAsset?.address);
      const borrow = lowerAddress(row.borrowAsset?.address || row.consumer?.loanAsset?.address);
      const collateralProducer = collateral ? byKey.get(`${chainId}:${collateral}`) : null;
      const borrowProducer = borrow ? byKey.get(`${chainId}:${borrow}`) : null;
      if (collateralProducer) rows.push(classifyMatch(collateralProducer, row.protocol || "consumer-first", "collateralAsset", { ...row, ltv: row.ltv, routeLiquidityUsd: row.routeLiquidityUsd }, ["Reusable high-LTV artifact match requires live consumer-specific validation"]));
      if (borrowProducer) rows.push(classifyMatch(borrowProducer, row.protocol || "consumer-first", "borrowAsset", { ...row, ltv: row.ltv, routeLiquidityUsd: row.routeLiquidityUsd }, ["PT is borrow asset, not collateral-side overvaluation route"]));
    }
  }
  return { rows, stats: { highLtvRowsRead: artifact.summary?.highLtvRows || 0 } };
}

function scanAesArtifact(producers) {
  const byKey = new Map(producers.map((p) => [`${p.chainId}:${p.addressLower}`, p]));
  const artifact = readJson(AES_GRAPH, { results: [] });
  const rows = [];
  const collect = (items) => {
    const list = Array.isArray(items)
      ? items
      : items && typeof items === "object"
        ? Object.values(items).flatMap((value) => Array.isArray(value) ? value : [])
        : [];
    for (const item of list) {
      const chainId = Number(item.chainId || item.chain?.id || item.market?.chainId || 0);
      const addresses = [item.producer?.address, item.collateral?.address, item.market?.collateral, item.market?.asset, item.asset?.address].map(lowerAddress).filter(Boolean);
      for (const address of addresses) {
        const producer = byKey.get(`${chainId}:${address}`);
        if (producer) rows.push(classifyMatch(producer, item.protocol || item.consumerProtocol || "Aave/Euler/Silo", item.side || item.matchType || "artifactReference", item, ["Artifact reference requires live consumer-specific validation"]));
      }
    }
  };
  collect(artifact.matches);
  for (const result of artifact.results || []) collect(result.matches || result.rows || []);
  return { rows, stats: { resultsRead: artifact.results?.length || 0 } };
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = [row.protocol, row.chainId, row.side, row.producer?.addressLower, row.market?.marketId || row.market?.consumer?.evault || row.market?.reserve || row.market?.id || row.market?.config || ""].join(":").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function enrichMorphoRouteEconomics(providers, matches, prices, gasByChain) {
  for (const row of matches.filter((m) => m.protocol === "Morpho Blue" && m.side === "collateralAsset" && m.reviewCandidate)) {
    const provider = providers.get(Number(row.chainId));
    const producer = row.producer;
    const chainId = Number(producer.chainId);
    const oracleAddress = normalizeAddress(row.market?.oracle?.address);
    const loanAsset = normalizeAddress(row.market?.loanAsset?.address);
    const loanDecimals = Number(row.market?.loanAsset?.decimals ?? 18);
    const collateralDecimals = Number(row.market?.collateralAsset?.decimals ?? producer.decimals ?? 18);
    const syDecimals = Number(producer.syDecimals ?? 18);
    const lltv = Number(row.market?.lltv || 0);
    const borrowCapacityUsd = Number(row.market?.liquidityAssetsUsd || 0);
    const loanPriceUsd = loanAsset ? Number(priceFromMap(prices, chainId, loanAsset) || 0) : 0;
    const syPriceUsd = Number(producer.syPriceUsd || producer.underlyingPriceUsd || 0);
    const oracleRaw = provider && oracleAddress
      ? decode(await safeCall(provider, oracleAddress, MORPHO_ORACLE.encodeFunctionData("price", [])), MORPHO_ORACLE, "price")?.[0] || null
      : null;

    const onePtRaw = 10n ** BigInt(collateralDecimals);
    const loanPerPtRaw = oracleRaw ? (onePtRaw * BigInt(oracleRaw)) / (10n ** 36n) : null;
    const loanPerPt = loanPerPtRaw === null ? null : Number(ethers.formatUnits(loanPerPtRaw, loanDecimals));
    const acceptedUsdPerPt = loanPerPt !== null && loanPriceUsd > 0 ? loanPerPt * loanPriceUsd : null;
    const ptRequiredForFullBorrow = acceptedUsdPerPt && lltv > 0 ? borrowCapacityUsd / (acceptedUsdPerPt * lltv) : null;
    const targetPtRaw = decimalToUnits(ptRequiredForFullBorrow, collateralDecimals);
    const publicPtUsd = Number(producer.ptPriceUsd || 0) || fallbackPtPriceUsd(producer);
    const publicEstimateSy = publicPtUsd && syPriceUsd > 0 && ptRequiredForFullBorrow ? (ptRequiredForFullBorrow * publicPtUsd) / syPriceUsd : null;
    const estimateSyRaw = decimalToUnits(publicEstimateSy, syDecimals);
    const quote = targetPtRaw && estimateSyRaw ? await findSyInForPtOut(chainId, producer.market, targetPtRaw, estimateSyRaw) : null;
    const requestedSyInRaw = quote?.ok ? quote.syInRaw : null;
    const actualSyInRaw = quote?.ok ? (() => { try { return BigInt(quote.quote?.totalTrade?.netFromTaker || "0"); } catch (_) { return 0n; } })() : null;
    const actualPtOutRaw = quote?.ok ? marketOrderPtOutRaw(quote.quote) : 0n;
    const syInRaw = actualSyInRaw && actualSyInRaw > 0n ? actualSyInRaw : null;
    const syIn = syInRaw ? Number(ethers.formatUnits(syInRaw, syDecimals)) : null;
    const acquisitionCostUsd = syIn !== null && syPriceUsd > 0 ? syIn * syPriceUsd : null;
    const quoteAcquisitionUsdPerPt = acquisitionCostUsd !== null && ptRequiredForFullBorrow ? acquisitionCostUsd / ptRequiredForFullBorrow : null;
    const acceptedVsAcquisitionBps = bpsDiff(quoteAcquisitionUsdPerPt ?? publicPtUsd, acceptedUsdPerPt);
    const ltvBreakEvenPremiumBps = lltv > 0 ? ((1 / lltv) - 1) * 10_000 : null;
    const gasUsd = gasByChain[chainId]?.gasUsd ?? null;
    const gasBpsAtCapacity = gasUsd && borrowCapacityUsd > 0 ? gasUsd / borrowCapacityUsd * 10_000 : null;
    const requiredPremiumBps = ltvBreakEvenPremiumBps === null ? null : ltvBreakEvenPremiumBps + SLIPPAGE_BPS + Number(gasBpsAtCapacity || 0);
    const slippageUsd = borrowCapacityUsd * SLIPPAGE_BPS / 10_000;
    const grossEdgeUsd = acquisitionCostUsd === null ? null : borrowCapacityUsd - acquisitionCostUsd;
    const netEdgeUsd = grossEdgeUsd === null ? null : grossEdgeUsd - Number(gasUsd || 0) - slippageUsd;
    const quoteOk = Boolean(quote?.ok && syInRaw && actualPtOutRaw >= targetPtRaw && acquisitionCostUsd !== null);
    const hasBreakEvenPremium = acceptedVsAcquisitionBps !== null && requiredPremiumBps !== null && acceptedVsAcquisitionBps >= requiredPremiumBps;
    const routePositive = Boolean(quoteOk && hasBreakEvenPremium && netEdgeUsd !== null && netEdgeUsd > 0);

    row.market.morphoOracleEconomics = {
      oracle: oracleAddress,
      oraclePriceRaw: oracleRaw?.toString() || null,
      loanPerPtRaw: loanPerPtRaw?.toString() || null,
      loanPerPt: round(loanPerPt, 12),
      loanPriceUsd: round(loanPriceUsd, 8),
      acceptedUsdPerPt: round(acceptedUsdPerPt, 12),
      publicPtUsd: round(publicPtUsd, 12),
      quoteAcquisitionUsdPerPt: round(quoteAcquisitionUsdPerPt, 12),
      acceptedVsAcquisitionBps: round(acceptedVsAcquisitionBps, 6),
      lltv,
      ltvBreakEvenPremiumBps: round(ltvBreakEvenPremiumBps, 6),
      requiredPremiumBps: round(requiredPremiumBps, 6),
      borrowCapacityUsd: round(borrowCapacityUsd, 6),
      ptRequiredForFullBorrow: round(ptRequiredForFullBorrow, 12),
      targetPtRaw: targetPtRaw?.toString() || null,
      syPriceUsd: round(syPriceUsd, 12),
      syDecimals,
      requestedSyInRaw: requestedSyInRaw?.toString() || null,
      syInRaw: syInRaw?.toString() || null,
      actualPtOutRaw: actualPtOutRaw ? actualPtOutRaw.toString() : null,
      syIn: round(syIn, 12),
      acquisitionCostUsd: round(acquisitionCostUsd, 6),
      grossEdgeUsd: round(grossEdgeUsd, 6),
      gasUsd: round(gasUsd, 6),
      gasBpsAtCapacity: round(gasBpsAtCapacity, 6),
      slippageUsd: round(slippageUsd, 6),
      netEdgeUsd: round(netEdgeUsd, 6),
      quoteSource: quoteOk ? "Pendle limit-order market-order quote-only endpoint" : null,
      quoteOk,
      routePositive,
      blockers: [
        oracleRaw ? null : "Morpho oracle price unavailable",
        loanPriceUsd > 0 ? null : "loan asset USD price unavailable",
        syPriceUsd > 0 ? null : "SY/underlying USD price unavailable",
        quoteOk ? null : (quote?.reason || "Pendle size-specific acquisition quote unavailable"),
        hasBreakEvenPremium ? null : "accepted PT value below LLTV break-even premium",
        netEdgeUsd !== null && netEdgeUsd > 0 ? null : "full-liquidity net edge is not positive",
      ].filter(Boolean),
    };
    row.routePositive = routePositive;
    row.watchCandidate = row.reviewCandidate && !routePositive;
    row.blockers = row.market.morphoOracleEconomics.blockers.length ? row.market.morphoOracleEconomics.blockers : ["Fork proof still required before any signed action"];
  }
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rpcs = await resolveRpcPool(CHAIN_IDS);
  const providers = new Map(Object.entries(rpcs).map(([chainId, rpc]) => [Number(chainId), new ethers.JsonRpcProvider(rpc, Number(chainId), { staticNetwork: true })]));
  const gasAssetPrices = await fetchCoinKeyPrices(CHAIN_IDS.map((chainId) => CHAINS[chainId]?.gasPriceKey));
  const gasByChain = {};
  const blocks = {};
  const producers = [];
  const chainStats = {};

  for (const chainId of CHAIN_IDS) {
    const provider = providers.get(chainId) || null;
    const chain = CHAINS[chainId] || { name: String(chainId) };
    const block = provider ? await provider.getBlock("latest").catch(() => null) : null;
    if (block) blocks[chainId] = { chain: chain.name, number: block.number, timestamp: Number(block.timestamp), iso: new Date(Number(block.timestamp) * 1000).toISOString() };
    const gasPriceWei = provider ? await provider.send("eth_gasPrice", []).then(BigInt).catch(() => 0n) : 0n;
    const gasAssetPriceUsd = chain.gasPriceKey ? gasAssetPrices.get(chain.gasPriceKey.toLowerCase()) || null : null;
    gasByChain[chainId] = { chainId, chain: chain.name, gasPriceWei: gasPriceWei.toString(), gasAssetPriceUsd, gasUsd: gasAssetPriceUsd && gasPriceWei > 0n ? Number(gasPriceWei) * GAS_UNITS / 1e18 * gasAssetPriceUsd : null };
    const chainProducers = await fetchPendleMarkets(chainId, provider);
    chainStats[chainId] = { chain: chain.name, rpcResolved: Boolean(provider), ptProducers: chainProducers.length };
    producers.push(...chainProducers);
  }

  const priceRefs = [];
  for (const producer of producers) priceRefs.push({ chainId: producer.chainId, address: producer.pt }, { chainId: producer.chainId, address: producer.sy }, { chainId: producer.chainId, address: producer.underlyingAsset });
  const prices = await fetchPrices(priceRefs);
  for (const producer of producers) {
    producer.ptPriceUsd = priceFromMap(prices, producer.chainId, producer.pt) || null;
    producer.syPriceUsd = priceFromMap(prices, producer.chainId, producer.sy) || null;
    producer.underlyingPriceUsd = priceFromMap(prices, producer.chainId, producer.underlyingAsset) || null;
  }

  const morpho = await scanMorpho(producers);
  const extraLoanPrices = morpho.rows.map((row) => ({ chainId: row.chainId, address: row.market?.loanAsset?.address })).filter((ref) => ref.address);
  const loanPrices = await fetchPrices(extraLoanPrices);
  for (const [key, price] of loanPrices.entries()) prices.set(key, price);
  const highLtv = scanHighLtvArtifact(producers);
  const aes = scanAesArtifact(producers);
  const aaveRows = [];
  const aaveStats = {};
  for (const chainId of CHAIN_IDS) {
    const provider = providers.get(chainId);
    const chainProducers = producers.filter((p) => p.chainId === chainId);
    const result = await scanAave(provider, chainId, chainProducers, prices).catch(() => ({ rows: [], stats: { reservesScanned: 0, priceSourcesScanned: 0 } }));
    aaveRows.push(...result.rows);
    aaveStats[chainId] = result.stats;
  }

  const matches = dedupeRows([...morpho.rows, ...aaveRows, ...highLtv.rows, ...aes.rows]);
  await enrichMorphoRouteEconomics(providers, matches, prices, gasByChain);
  matches.sort((a, b) => Number(b.routePositive) - Number(a.routePositive)
    || Number(b.reviewCandidate) - Number(a.reviewCandidate)
    || (asFiniteNumber(b.market?.morphoOracleEconomics?.netEdgeUsd) ?? -1e18) - (asFiniteNumber(a.market?.morphoOracleEconomics?.netEdgeUsd) ?? -1e18)
    || Number(b.liquidityUsd || 0) - Number(a.liquidityUsd || 0));
  const reviewCandidates = matches.filter((m) => m.reviewCandidate);
  const watchCandidates = matches.filter((m) => m.watchCandidate);
  const routePositive = matches.filter((m) => m.routePositive);
  const priced = matches.filter((m) => m.market?.morphoOracleEconomics);

  if (producers.length === 0) {
    const previous = readJson(OUT, null);
    if ((previous?.summary?.ptProducers || 0) > 0) {
      previous.lastRefreshAttempt = {
        generatedAt: new Date().toISOString(),
        status: "pendle-api-empty-result-preserved-previous-artifact",
        attemptedChainIds: CHAIN_IDS,
        maxMarketsPerChain: MAX_MARKETS_PER_CHAIN,
      };
      fs.writeFileSync(OUT, JSON.stringify(previous, jsonReplacer, 2) + "\n");
      console.log(`Multi-chain Pendle PT scan: Pendle API returned zero producers; preserved previous artifact with producers=${previous.summary.ptProducers}`);
      console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
      return;
    }
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-pendle-pt-multichain-consumer-graph.js",
    scope: "Read-only multi-chain Pendle PT consumer graph for LoopScale-style oracle unit-mismatch variants",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: routePositive.length > 0,
      signedActionJustified: false,
    },
    thresholds: { chainIds: CHAIN_IDS, routeLiquidityUsd: ROUTE_LIQUIDITY_USD, maxMarketsPerChain: MAX_MARKETS_PER_CHAIN, gasUnits: GAS_UNITS, slippageBps: SLIPPAGE_BPS },
    blocks,
    gas: { byChain: gasByChain },
    sourceArtifacts: {
      consumerFirstHighLtv: "reports/raw/fast/consumer-first-high-ltv-collateral.json",
      aaveEulerSiloConsumerGraph: "reports/raw/fast/aave-euler-silo-consumer-graph.json",
    },
    chains: chainStats,
    summary: {
      chainsScanned: CHAIN_IDS.length,
      chainsWithRpc: providers.size,
      ptProducers: producers.length,
      matches: matches.length,
      byChain: matches.reduce((acc, row) => { acc[row.chain] = (acc[row.chain] || 0) + 1; return acc; }, {}),
      byProtocol: matches.reduce((acc, row) => { acc[row.protocol] = (acc[row.protocol] || 0) + 1; return acc; }, {}),
      reviewCandidates: reviewCandidates.length,
      watchCandidates: watchCandidates.length,
      routePositive: routePositive.length,
      signedActionJustified: false,
      morphoOraclePricedReviews: priced.length,
      morphoExecutableQuotes: priced.filter((m) => m.market?.morphoOracleEconomics?.quoteOk).length,
      bestNetEdgeUsd: round(maxFinite(priced.map((m) => m.market?.morphoOracleEconomics?.netEdgeUsd)), 6),
      bestAcceptedVsAcquisitionBps: round(maxFinite(priced.map((m) => m.market?.morphoOracleEconomics?.acceptedVsAcquisitionBps)), 6),
      minBreakEvenGapBps: round(minFinite(priced.map((m) => {
        const e = m.market?.morphoOracleEconomics;
        if (asFiniteNumber(e?.acceptedVsAcquisitionBps) === null || asFiniteNumber(e?.requiredPremiumBps) === null) return null;
        return Number(e.requiredPremiumBps) - Number(e.acceptedVsAcquisitionBps);
      })), 6),
      topByNetEdge: priced.slice(0, 10).map((m) => ({
        chain: m.chain,
        protocol: m.protocol,
        symbol: m.producer.symbol,
        loan: m.market.loanAsset?.symbol,
        lltv: m.market.lltv,
        acceptedVsAcquisitionBps: m.market.morphoOracleEconomics.acceptedVsAcquisitionBps,
        requiredPremiumBps: m.market.morphoOracleEconomics.requiredPremiumBps,
        netEdgeUsd: m.market.morphoOracleEconomics.netEdgeUsd,
        routePositive: m.routePositive,
      })),
      stats: { morpho: morpho.stats, aave: aaveStats, highLtv: highLtv.stats, aes: aes.stats },
    },
    producers: producers.slice(0, 500),
    matches,
    topRows: matches.slice(0, 30),
    requiredForRoutePositive: [
      "PT is accepted as collateral by a consumer with material borrow-side liquidity",
      "consumer oracle accepts PT value above live executable Pendle acquisition cost after LTV, gas, and slippage",
      "exact executable acquisition and borrowed-asset exit route exists for the required PT size",
      "local fork proof extracts positive net value",
    ],
    nextReadOnlyStep: routePositive.length > 0
      ? "Fork-test the top route-positive multi-chain PT row before any live signed action."
      : watchCandidates.length > 0
        ? "Keep as watch-only; add protocol-specific oracle/source decoding for top collateral-side PT rows if a premium approaches break-even."
        : "Keep branch dormant until a non-Ethereum lending consumer accepts a Pendle PT as collateral with material liquidity.",
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  console.log(`Multi-chain Pendle PT scan: producers=${artifact.summary.ptProducers} matches=${artifact.summary.matches} review=${artifact.summary.reviewCandidates} routePositive=${artifact.summary.routePositive}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
