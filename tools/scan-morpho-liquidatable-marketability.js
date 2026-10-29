#!/usr/bin/env node
// scan-morpho-liquidatable-marketability.js - broad read-only Morpho current-liquidation marketability ranker.
// Resolves RPCs in memory only. Does not store RPC URLs, private keys, or send signed transactions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("./node_modules/ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "morpho-liquidatable-marketability.json");

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNISWAP_V3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const ZERO = ethers.ZeroAddress;

const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const VIRTUAL_SHARES = 1_000_000n;
const VIRTUAL_ASSETS = 1n;
const LIQUIDATION_CURSOR = 300_000_000_000_000_000n;
const MAX_LIQUIDATION_INCENTIVE_FACTOR = 1_150_000_000_000_000_000n;

const GRAPHQL_FIRST = Number(process.env.MORPHO_LIQ_MARKETABILITY_GRAPHQL_FIRST || "500");
const MAX_ROWS = Number(process.env.MORPHO_LIQ_MARKETABILITY_MAX_ROWS || "80");
const QUOTE_ROWS = Number(process.env.MORPHO_LIQ_MARKETABILITY_QUOTE_ROWS || "12");
const SUPPLEMENT_MARKETS = Number(process.env.MORPHO_LIQ_MARKETABILITY_SUPPLEMENT_MARKETS || "30");
const SUPPLEMENT_POSITIONS_PER_MARKET = Number(process.env.MORPHO_LIQ_MARKETABILITY_SUPPLEMENT_POSITIONS_PER_MARKET || "5");
const MIN_DEBT_USD = Number(process.env.MORPHO_LIQ_MARKETABILITY_MIN_DEBT_USD || "100");
const MIN_COLLATERAL_USD = Number(process.env.MORPHO_LIQ_MARKETABILITY_MIN_COLLATERAL_USD || "1");
const LIQUIDATION_GAS_UNITS = Number(process.env.MORPHO_LIQ_MARKETABILITY_GAS_UNITS || "1800000");
const SLIPPAGE_BPS = Number(process.env.MORPHO_LIQ_MARKETABILITY_SLIPPAGE_BPS || "100");
const CURVE_MAX_POOLS_PER_PAIR = Number(process.env.MORPHO_LIQ_MARKETABILITY_CURVE_MAX_POOLS_PER_PAIR || "1");
const SIZE_FRACTIONS = String(process.env.MORPHO_LIQ_MARKETABILITY_SIZE_FRACTIONS || "0.001,0.005,0.01,0.05")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0 && x <= 1);

const TOKENS = {
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  WSTETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
  WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  USDE: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
  USDS: "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
  GHO: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f",
  FRAX: "0x853d955aCEf822Db058eb8505911ED77F175b99e",
  crvUSD: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
  PYUSD: "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8",
  USD0: "0x73A15FeD60Bf67631dC6cd7Bc5B6e8da8190aCF5",
};

const CHAINLINK_FEEDS = new Map([
  [TOKENS.WETH.toLowerCase(), { feed: "0x5f4eC3Df9cbd43714FE2740f5e3616155c5b8419", maxAgeSeconds: 3 * 3600, label: "WETH" }],
  [TOKENS.USDC.toLowerCase(), { feed: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6", maxAgeSeconds: 30 * 3600, label: "USDC" }],
  [TOKENS.USDT.toLowerCase(), { feed: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D", maxAgeSeconds: 30 * 3600, label: "USDT" }],
  [TOKENS.DAI.toLowerCase(), { feed: "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9", maxAgeSeconds: 3 * 3600, label: "DAI" }],
  [TOKENS.WBTC.toLowerCase(), { feed: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c", maxAgeSeconds: 3 * 3600, label: "WBTC" }],
  [TOKENS.USDE.toLowerCase(), { feed: "0xa569d910839Ae8865Da8F8e70FfFb0cBA869F961", maxAgeSeconds: 30 * 3600, label: "USDe" }],
  [TOKENS.GHO.toLowerCase(), { feed: "0x3f12643D3f6f874d39c2A4c9f2cd6f2DbAC877fc", maxAgeSeconds: 30 * 3600, label: "GHO" }],
  [TOKENS.FRAX.toLowerCase(), { feed: "0xB9E1E3A9feFf48998E45Fa90847ed4D467E8BcfD", maxAgeSeconds: 30 * 3600, label: "FRAX" }],
  [TOKENS.crvUSD.toLowerCase(), { feed: "0xeef0C605546958c1f899b6fb336c20671f9cd49f", maxAgeSeconds: 30 * 3600, label: "crvUSD" }],
]);

const ERC20 = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const FACTORY = new ethers.Interface(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)"]);
const QUOTER = new ethers.Interface([
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
const MORPHO_IFACE = new ethers.Interface([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function position(bytes32 id,address user) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)",
]);
const ORACLE = new ethers.Interface(["function price() view returns (uint256)"]);
const CHAINLINK = new ethers.Interface([
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);
const CURVE_INT128 = new ethers.Interface(["function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)"]);
const CURVE_UINT256 = new ethers.Interface(["function get_dy(uint256 i,uint256 j,uint256 dx) view returns (uint256)"]);

const poolCache = new Map();
const curveDyCache = new Map();

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function normalizeAddress(value) {
  try { return ethers.getAddress(String(value).toLowerCase()); } catch (_) { return null; }
}

function lowerAddress(value) {
  const addr = normalizeAddress(value);
  return addr ? addr.toLowerCase() : null;
}

function sameAddress(a, b) {
  const aa = lowerAddress(a);
  const bb = lowerAddress(b);
  return Boolean(aa && bb && aa === bb);
}

function toBigInt(value, fallback = 0n) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    return BigInt(value);
  } catch (_) {
    return fallback;
  }
}

function mulDivDown(x, y, d) {
  if (d === 0n) return 0n;
  return x * y / d;
}

function mulDivUp(x, y, d) {
  if (d === 0n) return 0n;
  return (x * y + d - 1n) / d;
}

function toAssetsUp(shares, totalAssets, totalShares) {
  return mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
}

function liquidationIncentiveFactorRaw(lltvRaw) {
  const lltv = toBigInt(lltvRaw);
  if (lltv <= 0n || lltv >= WAD) return 1_050_000_000_000_000_000n;
  const cursorTerm = mulDivDown(LIQUIDATION_CURSOR, WAD - lltv, WAD);
  const factor = mulDivDown(WAD, WAD, WAD - cursorTerm);
  return factor > MAX_LIQUIDATION_INCENTIVE_FACTOR ? MAX_LIQUIDATION_INCENTIVE_FACTOR : factor;
}

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined) return null;
  try { return Number(ethers.formatUnits(toBigInt(raw), Number(decimals))); } catch (_) { return null; }
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function parseFractionShares(borrowShares, fraction) {
  const shares = toBigInt(borrowShares, 0n);
  if (shares <= 0n) return 0n;
  if (fraction >= 1) return shares;
  const bps = BigInt(Math.max(1, Math.floor(Number(fraction) * 10_000)));
  const partial = shares * bps / 10_000n;
  return partial > 0n ? partial : 1n;
}

function percentDiff(a, b) {
  const x = Number(a || 0);
  const y = Number(b || 0);
  if (!(x > 0) || !(y > 0)) return null;
  return Math.abs(x - y) / ((x + y) / 2) * 100;
}

function encodePath(tokens, fees) {
  const types = [];
  const values = [];
  for (let i = 0; i < tokens.length; i++) {
    types.push("address");
    values.push(tokens[i]);
    if (i < fees.length) {
      types.push("uint24");
      values.push(fees[i]);
    }
  }
  return ethers.solidityPacked(types, values);
}

function marketId(marketParams) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address", "uint256"],
    [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, toBigInt(marketParams.lltv)]
  ));
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

async function morphoQuery(query, variables = {}) {
  const json = await fetchJson("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    timeoutMs: 30_000,
  });
  if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 300));
  return json.data || {};
}

async function safeCall(provider, to, iface, fn, args = []) {
  try {
    const target = normalizeAddress(to);
    if (!target) return null;
    const raw = await provider.call({ to: target, data: iface.encodeFunctionData(fn, args) });
    return iface.decodeFunctionResult(fn, raw)[0];
  } catch (_) {
    return null;
  }
}

async function readChainlinkUsd(provider, feed, maxAgeSeconds, blockTimestamp) {
  try {
    const feedAddr = normalizeAddress(feed);
    if (!feedAddr) return null;
    const [roundRaw, decimalsRaw] = await Promise.all([
      provider.call({ to: feedAddr, data: CHAINLINK.encodeFunctionData("latestRoundData", []) }),
      provider.call({ to: feedAddr, data: CHAINLINK.encodeFunctionData("decimals", []) }),
    ]);
    const [, answer, , updatedAt] = CHAINLINK.decodeFunctionResult("latestRoundData", roundRaw);
    const [decimals] = CHAINLINK.decodeFunctionResult("decimals", decimalsRaw);
    if (answer <= 0n || updatedAt <= 0n) return null;
    const now = Number(blockTimestamp || Math.floor(Date.now() / 1000));
    const age = now - Number(updatedAt);
    if (age < 0 || age > maxAgeSeconds) return null;
    return { priceUsd: Number(answer) / (10 ** Number(decimals)), age, feed: feedAddr };
  } catch (_) {
    return null;
  }
}

async function fetchUsd(url, pathFn, timeoutMs = 8000) {
  try {
    const json = await fetchJson(url, { timeoutMs });
    const price = Number(pathFn(json));
    return price > 0 ? price : null;
  } catch (_) {
    return null;
  }
}

async function getEthUsd(provider, blockTimestamp) {
  const sources = [];
  const chainlink = await readChainlinkUsd(provider, CHAINLINK_FEEDS.get(TOKENS.WETH.toLowerCase()).feed, 3 * 3600, blockTimestamp).catch(() => null);
  if (chainlink) sources.push({ source: "chainlink", price: chainlink.priceUsd });
  const coingecko = await fetchUsd("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", (j) => j?.ethereum?.usd);
  if (coingecko) sources.push({ source: "coingecko", price: coingecko });
  const binance = await fetchUsd("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT", (j) => j?.price);
  if (binance) sources.push({ source: "binance", price: binance });
  return sources[0]?.price || null;
}

async function fetchPrices(addresses) {
  const keys = [...new Set(addresses.map(lowerAddress).filter(Boolean).map((addr) => `ethereum:${addr}`))];
  const out = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.slice(i, i + 50).join(",")}?searchWidth=6h`, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    for (const [key, row] of Object.entries(json.coins || {})) {
      const addr = key.split(":").pop().toLowerCase();
      const price = Number(row?.price || 0);
      if (price > 0) out.set(addr, price);
    }
  }
  return out;
}

function priceOf(prices, address, fallback = null) {
  const key = lowerAddress(address);
  const live = key ? Number(prices.get(key) || 0) : 0;
  if (live > 0) return live;
  const fb = Number(fallback || 0);
  return fb > 0 ? fb : null;
}

async function trustedLoanPrice(provider, token, graphPriceUsd, prices, blockTimestamp) {
  const tokenLc = lowerAddress(token);
  const graph = Number(graphPriceUsd || 0);
  if (!tokenLc) return { priceUsd: null, trusted: false, source: "invalid-token" };
  const cfg = CHAINLINK_FEEDS.get(tokenLc);
  if (cfg) {
    const live = await readChainlinkUsd(provider, cfg.feed, cfg.maxAgeSeconds, blockTimestamp).catch(() => null);
    if (live) return { priceUsd: live.priceUsd, trusted: true, source: `chainlink-${cfg.label.toLowerCase()}-usd`, graphDeviationPct: percentDiff(live.priceUsd, graph) };
  }
  const llama = priceOf(prices, token, graph);
  return { priceUsd: llama, trusted: false, source: llama ? "defillama-reference-only" : "missing-price", graphDeviationPct: percentDiff(llama, graph) };
}

async function fetchMorphoLiquidationItems() {
  async function fetchOrdered(orderBy, orderDirection = "Desc") {
    const query = `query($first: Int!) {
    marketPositions(first: $first, orderBy: ${orderBy}, orderDirection: ${orderDirection},
      where: { healthFactor_lte: 0.99, borrowShares_gte: "1" }) {
      items {
        user { address }
        market {
          chain { id network }
          loanAsset { symbol address decimals }
          collateralAsset { symbol address decimals }
          oracle { address }
          irmAddress
          lltv
        }
        healthFactor
        state { collateral collateralUsd borrowAssets borrowAssetsUsd borrowShares marginUsd }
      }
    }
  }`;
    const json = await fetchJson("https://api.morpho.org/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { first: GRAPHQL_FIRST } }),
      timeoutMs: 30_000,
    }).catch(() => null);
    if (!json || json.errors) return [];
    return json.data?.marketPositions?.items || [];
  }

  const pages = await Promise.all([
    fetchOrdered("BorrowShares", "Desc"),
    fetchOrdered("BorrowAssets", "Desc"),
    fetchOrdered("HealthFactor", "Asc"),
    fetchHighApySupplementItems(),
  ]);
  const seen = new Set();
  const out = [];
  for (const item of pages.flat()) {
    const key = [
      lowerAddress(item.user?.address),
      lowerAddress(item.market?.loanAsset?.address),
      lowerAddress(item.market?.collateralAsset?.address),
      lowerAddress(item.market?.oracle?.address),
      lowerAddress(item.market?.irmAddress),
      String(item.market?.lltv || ""),
    ].join(":");
    if (!key.includes("0x") || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function fetchHighApySupplementItems() {
  const query = `query($first:Int!) {
    highApy: markets(first:$first, orderBy:BorrowApy, orderDirection:Desc,
      where:{chainId_in:[1], borrowAssetsUsd_gte:10000, borrowApy_gte:10}) { items {
        marketId irmAddress lltv
        loanAsset { symbol address decimals }
        collateralAsset { symbol address decimals }
        oracle { address }
        state { borrowApy utilization borrowAssetsUsd liquidityAssetsUsd }
      } }
    highUtilization: markets(first:$first, orderBy:Utilization, orderDirection:Desc,
      where:{chainId_in:[1], borrowAssetsUsd_gte:10000, utilization_gte:0.9}) { items {
        marketId irmAddress lltv
        loanAsset { symbol address decimals }
        collateralAsset { symbol address decimals }
        oracle { address }
        state { borrowApy utilization borrowAssetsUsd liquidityAssetsUsd }
      } }
  }`;
  const data = await morphoQuery(query, { first: SUPPLEMENT_MARKETS }).catch(() => ({}));
  const markets = [];
  const seen = new Set();
  for (const source of ["highApy", "highUtilization"]) {
    for (const market of data?.[source]?.items || []) {
      const key = String(market.marketId || "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      markets.push({ ...market, discoverySource: source });
    }
  }
  const out = [];
  for (const market of markets) {
    const positionQuery = `query($first:Int!, $marketId:String!) {
      marketPositions(first:$first, orderBy:HealthFactor, orderDirection:Asc,
        where:{chainId_in:[1], marketUniqueKey_in:[$marketId], borrowShares_gte:"1", healthFactor_lte:0.99}) {
        items {
          user { address }
          healthFactor
          state { collateral collateralUsd borrowAssets borrowAssetsUsd borrowShares marginUsd }
          market {
            marketId irmAddress lltv
            chain { id network }
            loanAsset { symbol address decimals }
            collateralAsset { symbol address decimals }
            oracle { address }
            state { borrowApy utilization borrowAssetsUsd liquidityAssetsUsd }
          }
        }
      }
    }`;
    const data = await morphoQuery(positionQuery, { first: SUPPLEMENT_POSITIONS_PER_MARKET, marketId: market.marketId }).catch(() => ({}));
    for (const item of data?.marketPositions?.items || []) out.push({ ...item, discoverySource: market.discoverySource });
  }
  return out;
}

async function readOnchainMarketPosition(provider, marketParams, borrower) {
  const id = marketId(marketParams);
  const [marketRaw, positionRaw, oracleRaw] = await Promise.all([
    provider.call({ to: MORPHO, data: MORPHO_IFACE.encodeFunctionData("market", [id]) }).catch(() => null),
    provider.call({ to: MORPHO, data: MORPHO_IFACE.encodeFunctionData("position", [id, borrower]) }).catch(() => null),
    provider.call({ to: marketParams.oracle, data: ORACLE.encodeFunctionData("price", []) }).catch(() => null),
  ]);
  if (!marketRaw || !positionRaw || !oracleRaw) return null;
  try {
    const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = MORPHO_IFACE.decodeFunctionResult("market", marketRaw);
    const [supplyShares, borrowShares, collateral] = MORPHO_IFACE.decodeFunctionResult("position", positionRaw);
    const [oraclePrice] = ORACLE.decodeFunctionResult("price", oracleRaw);
    return { id, totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee, supplyShares, borrowShares, collateral, oraclePrice };
  } catch (_) {
    return null;
  }
}

async function getPool(provider, tokenA, tokenB, fee) {
  const a = normalizeAddress(tokenA);
  const b = normalizeAddress(tokenB);
  if (!a || !b || sameAddress(a, b)) return null;
  const key = `${a.toLowerCase()}:${b.toLowerCase()}:${fee}`;
  if (poolCache.has(key)) return poolCache.get(key);
  const raw = await provider.call({
    to: UNISWAP_V3_FACTORY,
    data: FACTORY.encodeFunctionData("getPool", [a, b, fee]),
  }).catch(() => null);
  let pool = null;
  if (raw) {
    try {
      const [decoded] = FACTORY.decodeFunctionResult("getPool", raw);
      pool = decoded && decoded !== ZERO ? decoded : null;
    } catch (_) {}
  }
  poolCache.set(key, pool);
  return pool;
}

function routeLabel(tokens, fees) {
  const parts = [];
  for (let i = 0; i < tokens.length; i++) {
    parts.push(tokens[i].slice(0, 8));
    if (i < fees.length) parts.push(String(fees[i]));
  }
  return parts.join("-");
}

async function buildUniswapPathCandidates(provider, tokenIn, tokenOut, includeTwoHop = true) {
  const input = normalizeAddress(tokenIn);
  const output = normalizeAddress(tokenOut);
  if (!input || !output) return [];
  if (sameAddress(input, output)) return [{ tokens: [input, output], fees: [0], pools: [], label: "same-token", directSameToken: true }];
  const candidates = [];
  const fees = [100, 500, 3000, 10000];
  for (const fee of fees) {
    const pool = await getPool(provider, input, output, fee);
    if (pool) candidates.push({ tokens: [input, output], fees: [fee], pools: [pool], label: routeLabel([input, output], [fee]), direct: true });
  }
  if (!includeTwoHop) return candidates;
  const mids = [...new Set(Object.values(TOKENS).map(normalizeAddress).filter(Boolean).map((x) => x.toLowerCase()))]
    .map((x) => ethers.getAddress(x))
    .filter((mid) => !sameAddress(mid, input) && !sameAddress(mid, output))
    .slice(0, 12);
  for (const mid of mids) {
    for (const f1 of fees) {
      const p1 = await getPool(provider, input, mid, f1);
      if (!p1) continue;
      for (const f2 of fees) {
        const p2 = await getPool(provider, mid, output, f2);
        if (!p2) continue;
        candidates.push({ tokens: [input, mid, output], fees: [f1, f2], pools: [p1, p2], label: routeLabel([input, mid, output], [f1, f2]), direct: false });
      }
    }
  }
  return candidates.slice(0, 32);
}

async function quoteUniswapExactInput(provider, tokenIn, tokenOut, amountIn) {
  const value = toBigInt(amountIn, 0n);
  if (value <= 0n) return [];
  if (sameAddress(tokenIn, tokenOut)) return [{ source: "same-token", pathKind: "same-token", amountOutRaw: value, gasEstimate: 0n, path: { tokens: [normalizeAddress(tokenIn), normalizeAddress(tokenOut)], fees: [0] } }];
  const out = [];
  const paths = await buildUniswapPathCandidates(provider, tokenIn, tokenOut, true);
  for (const p of paths) {
    if (p.directSameToken) continue;
    const raw = await provider.call({ to: UNISWAP_V3_QUOTER_V2, data: QUOTER.encodeFunctionData("quoteExactInput", [encodePath(p.tokens, p.fees), value]) }).catch(() => null);
    if (!raw) continue;
    try {
      const [amountOut, , , gasEstimate] = QUOTER.decodeFunctionResult("quoteExactInput", raw);
      out.push({ source: p.direct ? "Uniswap V3 exactInputSingle" : "Uniswap V3 routed exact-input", pathKind: p.direct ? "uniswap-v3-single" : "uniswap-v3-routed", amountOutRaw: amountOut, gasEstimate, path: p });
    } catch (_) {}
  }
  return out;
}

async function fetchCurvePools() {
  const registries = ["main", "factory", "factory-stable-ng", "crypto", "factory-crypto"];
  const pools = [];
  for (const registry of registries) {
    const json = await fetchJson(`https://api.curve.fi/v1/getPools/ethereum/${registry}`, { timeoutMs: 30_000 }).catch(() => null);
    for (const p of json?.data?.poolData || []) {
      const address = normalizeAddress(p.address);
      const coins = (p.coins || []).map((coin, index) => ({
        index,
        address: normalizeAddress(coin.address),
        symbol: coin.symbol || null,
        decimals: Number(coin.decimals ?? 18),
      })).filter((coin) => coin.address);
      if (!address || coins.length < 2) continue;
      pools.push({ source: `Curve ${registry}`, name: p.name || p.symbol || null, address, coins, usdTotal: Number(p.usdTotal || p.usdTotalExcludingBasePool || 0) || null, isBroken: Boolean(p.isBroken) });
    }
  }
  return pools;
}

function findCurvePools(curvePools, tokenIn, tokenOut) {
  const input = lowerAddress(tokenIn);
  const output = lowerAddress(tokenOut);
  if (!input || !output || input === output) return [];
  return (curvePools || []).map((pool) => {
    const i = pool.coins.find((coin) => lowerAddress(coin.address) === input);
    const j = pool.coins.find((coin) => lowerAddress(coin.address) === output);
    return i && j && !pool.isBroken ? { ...pool, i, j } : null;
  }).filter(Boolean)
    .sort((a, b) => Number(b.usdTotal || 0) - Number(a.usdTotal || 0))
    .slice(0, CURVE_MAX_POOLS_PER_PAIR);
}

async function curveGetDy(provider, pool, i, j, dx) {
  const amount = toBigInt(dx, 0n);
  if (amount <= 0n) return null;
  const key = `${pool.address}:${i}:${j}:${amount.toString()}`;
  if (curveDyCache.has(key)) return curveDyCache.get(key);
  for (const iface of [CURVE_INT128, CURVE_UINT256]) {
    const raw = await provider.call({ to: pool.address, data: iface.encodeFunctionData("get_dy", [BigInt(i), BigInt(j), amount]) }).catch(() => null);
    if (!raw) continue;
    try {
      const [dy] = iface.decodeFunctionResult("get_dy", raw);
      if (dy > 0n) {
        curveDyCache.set(key, dy);
        return dy;
      }
    } catch (_) {}
  }
  curveDyCache.set(key, null);
  return null;
}

async function quoteCurveExactInput(provider, curvePools, tokenIn, tokenOut, amountIn) {
  const out = [];
  for (const pool of findCurvePools(curvePools, tokenIn, tokenOut)) {
    const amountOut = await curveGetDy(provider, pool, pool.i.index, pool.j.index, amountIn).catch(() => null);
    if (!amountOut || amountOut <= 0n) continue;
    out.push({ source: pool.source, pathKind: "curve-direct", amountOutRaw: amountOut, gasEstimate: 0n, path: { pool: pool.address, name: pool.name, tokenIn: pool.i.address, tokenOut: pool.j.address } });
  }
  return out;
}

async function quoteExactExit(provider, curvePools, tokenIn, tokenOut, amountIn) {
  const quotes = [];
  quotes.push(...await quoteUniswapExactInput(provider, tokenIn, tokenOut, amountIn).catch(() => []));
  quotes.push(...await quoteCurveExactInput(provider, curvePools, tokenIn, tokenOut, amountIn).catch(() => []));
  return quotes
    .filter((q) => q && toBigInt(q.amountOutRaw) > 0n)
    .sort((a, b) => (toBigInt(a.amountOutRaw) > toBigInt(b.amountOutRaw) ? -1 : toBigInt(a.amountOutRaw) < toBigInt(b.amountOutRaw) ? 1 : 0))
    .slice(0, 8);
}

function marketabilityTags(row) {
  const symbol = String(row.collateral?.symbol || "");
  const tags = [];
  if (/USD|DAI|FRAX|GHO|crvUSD/i.test(symbol)) tags.push("stable-like");
  if (/ETH|stETH|weETH|ezETH|rsETH|rETH/i.test(symbol)) tags.push("eth-like");
  if (/BTC|WBTC|tBTC/i.test(symbol)) tags.push("btc-like");
  if (/PT-|YT-|Pendle/i.test(symbol)) tags.push("principal-token");
  if (/LP|RLP|BPT|UNI-V|Curve/i.test(symbol)) tags.push("lp-or-receipt");
  if (/USD|ETH|BTC|DAI|FRAX|GHO|USDC|USDT|crvUSD/i.test(symbol)) tags.push("symbol-marketable");
  return [...new Set(tags)];
}

function baseScore(row) {
  const debt = Number(row.graph?.borrowAssetsUsd || 0);
  const collateral = Number(row.graph?.collateralUsd || 0);
  const hf = Number(row.healthFactor || 0);
  const tags = marketabilityTags(row);
  return Math.round(
    20
    + Math.min(25, Math.log10(Math.max(1, collateral)) * 7)
    + Math.min(15, Math.log10(Math.max(1, debt)) * 3)
    + Math.max(0, Math.min(10, (1 - hf) * 20))
    + (tags.includes("symbol-marketable") ? 10 : 0)
    + (tags.includes("principal-token") ? -8 : 0)
    + (tags.includes("lp-or-receipt") ? -4 : 0)
  );
}

async function scoreRow(provider, curvePools, prices, gas, item, quoteEnabled) {
  const borrower = normalizeAddress(item.user?.address);
  const loan = normalizeAddress(item.market?.loanAsset?.address);
  const collateral = normalizeAddress(item.market?.collateralAsset?.address);
  const oracle = normalizeAddress(item.market?.oracle?.address);
  const irm = normalizeAddress(item.market?.irmAddress);
  const loanDecimals = Number(item.market?.loanAsset?.decimals ?? 18);
  const collateralDecimals = Number(item.market?.collateralAsset?.decimals ?? 18);
  const marketParams = { loanToken: loan, collateralToken: collateral, oracle, irm, lltv: item.market?.lltv || "0" };
  const loanPrice = await trustedLoanPrice(provider, loan, Number(item.state?.borrowAssetsUsd || 0) / Math.max(1e-18, formatUnitsNumber(item.state?.borrowAssets || 0n, loanDecimals) || 0), prices, gas.blockTimestamp);
  const onchain = borrower && loan && collateral && oracle && irm ? await readOnchainMarketPosition(provider, marketParams, borrower).catch(() => null) : null;
  const tags = marketabilityTags({ collateral: { symbol: item.market?.collateralAsset?.symbol } });
  const row = {
    borrower,
    marketId: loan && collateral && oracle && irm ? marketId(marketParams) : null,
    pair: `${item.market?.loanAsset?.symbol || "?"}/${item.market?.collateralAsset?.symbol || "?"}`,
    healthFactor: Number(item.healthFactor || 0),
    graph: {
      borrowAssetsUsd: Number(item.state?.borrowAssetsUsd || 0),
      collateralUsd: Number(item.state?.collateralUsd || 0),
      borrowAssetsRaw: item.state?.borrowAssets || null,
      borrowSharesRaw: item.state?.borrowShares || null,
      collateralRaw: item.state?.collateral || null,
    },
    loanAsset: { address: loan, symbol: item.market?.loanAsset?.symbol || null, decimals: loanDecimals, priceUsd: loanPrice.priceUsd, pricingTrusted: loanPrice.trusted, priceSource: loanPrice.source },
    collateral: { address: collateral, symbol: item.market?.collateralAsset?.symbol || null, decimals: collateralDecimals, priceUsd: priceOf(prices, collateral, Number(item.state?.collateralUsd || 0) > 0 && Number(item.state?.collateral || 0) > 0 ? null : null) },
    marketability: { tags, baseScore: 0, quoteEnabled },
    onchainAvailable: Boolean(onchain),
    quote: null,
    researchPositive: false,
    routePositive: false,
    executableNow: false,
    signedActionJustified: false,
  };
  row.marketability.baseScore = baseScore(row);
  if (!onchain || onchain.borrowShares <= 0n || onchain.collateral <= 0n || onchain.totalBorrowShares <= 0n || onchain.oraclePrice <= 0n) {
    row.blockers = ["Missing on-chain market/position/oracle data or no repayable debt/collateral"];
    return row;
  }
  row.onchain = {
    totalBorrowAssetsRaw: onchain.totalBorrowAssets.toString(),
    totalBorrowSharesRaw: onchain.totalBorrowShares.toString(),
    borrowSharesRaw: onchain.borrowShares.toString(),
    collateralRaw: onchain.collateral.toString(),
    oraclePriceRaw: onchain.oraclePrice.toString(),
  };

  const lifRaw = liquidationIncentiveFactorRaw(marketParams.lltv);
  const sizes = [];
  for (const fraction of SIZE_FRACTIONS) {
    const repaidShares = parseFractionShares(onchain.borrowShares, fraction);
    if (repaidShares <= 0n) continue;
    const repaidAssets = toAssetsUp(repaidShares, onchain.totalBorrowAssets, onchain.totalBorrowShares);
    const seizedCollateral = mulDivDown(mulDivDown(repaidAssets, lifRaw, WAD), ORACLE_PRICE_SCALE, onchain.oraclePrice);
    const seizedExceedsCollateral = seizedCollateral > onchain.collateral;
    sizes.push({ fraction, repaidShares, repaidAssets, seizedCollateral, seizedExceedsCollateral });
  }
  const quoteSize = sizes.find((s) => !s.seizedExceedsCollateral && s.seizedCollateral > 0n) || null;
  row.marketability.quoteEligible = Boolean(quoteSize);
  row.marketability.overseizeOnly = !quoteSize;
  if (!quoteSize || !quoteEnabled) {
    row.quote = quoteSize ? { probed: false, reason: "lower-ranked row not exact-quote probed", bestFraction: quoteSize.fraction, bestRepayUsd: round((formatUnitsNumber(quoteSize.repaidAssets, loanDecimals) || 0) * Number(loanPrice.priceUsd || 0), 6) } : { probed: false, reason: "all configured repay sizes over-seize collateral" };
    row.blockers = [quoteSize ? "Exact quote skipped for lower-ranked row" : "Configured partial repay sizes would over-seize collateral"];
    return row;
  }

  const quotes = await quoteExactExit(provider, curvePools, collateral, loan, quoteSize.seizedCollateral);
  const repayUsd = (formatUnitsNumber(quoteSize.repaidAssets, loanDecimals) || 0) * Number(loanPrice.priceUsd || 0);
  const scoredQuotes = quotes.map((quote) => {
    const expectedOutRaw = toBigInt(quote.amountOutRaw);
    const grossProfitRaw = expectedOutRaw - quoteSize.repaidAssets;
    const expectedOut = formatUnitsNumber(expectedOutRaw, loanDecimals) || 0;
    const expectedOutUsd = expectedOut * Number(loanPrice.priceUsd || 0);
    const grossProfitUsd = (formatUnitsNumber(grossProfitRaw, loanDecimals) || 0) * Number(loanPrice.priceUsd || 0);
    const slippageUsd = repayUsd * SLIPPAGE_BPS / 10_000;
    const netProfitUsd = grossProfitUsd - Number(gas.liquidationGasUsd || 0) - slippageUsd;
    const researchPositive = Boolean(loanPrice.trusted && grossProfitRaw > 0n && netProfitUsd > 0);
    return { source: quote.source, pathKind: quote.pathKind, amountOutRaw: expectedOutRaw.toString(), expectedOutUsd, grossProfitUsd, gasUsd: gas.liquidationGasUsd, slippageUsd, netProfitUsd, researchPositive, routePositive: false, path: quote.path };
  }).sort((a, b) => Number(b.netProfitUsd ?? -Infinity) - Number(a.netProfitUsd ?? -Infinity));
  const best = scoredQuotes[0] || null;
  row.quote = {
    probed: true,
    bestFraction: quoteSize.fraction,
    repayAssetsRaw: quoteSize.repaidAssets.toString(),
    seizedCollateralRaw: quoteSize.seizedCollateral.toString(),
    repayUsd,
    seizedCollateral: formatUnitsNumber(quoteSize.seizedCollateral, collateralDecimals),
    quoteCount: scoredQuotes.length,
    bestSource: best?.source || null,
    bestPathKind: best?.pathKind || null,
    bestNetProfitUsd: best ? round(best.netProfitUsd, 6) : null,
    bestGrossProfitUsd: best ? round(best.grossProfitUsd, 6) : null,
    bestResearchPositive: Boolean(best?.researchPositive),
    quotes: scoredQuotes.slice(0, 5),
  };
  row.researchPositive = Boolean(best?.researchPositive);
  row.blockers = [
    best ? null : "No exact Uniswap/Curve quote for the selected repay size",
    loanPrice.trusted ? null : "Loan token price is not trusted for positive gating",
    best?.netProfitUsd > 0 ? null : "Best exact quote is not positive after gas/slippage",
    "No fork extraction proof",
    "Signed action remains fail-closed",
  ].filter(Boolean);
  return row;
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rpc = await resolveRpc(1);
  if (!rpc) throw new Error("missing ethereum rpc");
  const provider = new ethers.JsonRpcProvider(rpc, { chainId: 1, name: "ethereum" }, { staticNetwork: true });
  const [block, gasPriceWei, allItems] = await Promise.all([
    provider.getBlock("latest"),
    provider.send("eth_gasPrice", []).then(BigInt).catch(() => 0n),
    fetchMorphoLiquidationItems(),
  ]);
  const items = allItems.filter((p) => Number(p.market?.chain?.id) === 1
    && Number(p.healthFactor || 0) > 0
    && Number(p.healthFactor || 0) < 1
    && Number(p.state?.borrowAssetsUsd || 0) >= MIN_DEBT_USD
    && Number(p.state?.collateralUsd || 0) >= MIN_COLLATERAL_USD
    && normalizeAddress(p.user?.address)
    && normalizeAddress(p.market?.loanAsset?.address)
    && normalizeAddress(p.market?.collateralAsset?.address)
    && normalizeAddress(p.market?.oracle?.address)
    && normalizeAddress(p.market?.irmAddress));
  items.sort((a, b) => baseScore({ healthFactor: b.healthFactor, graph: b.state, collateral: { symbol: b.market?.collateralAsset?.symbol } })
    - baseScore({ healthFactor: a.healthFactor, graph: a.state, collateral: { symbol: a.market?.collateralAsset?.symbol } })
    || Number(b.state?.collateralUsd || 0) - Number(a.state?.collateralUsd || 0));
  const selected = items.slice(0, MAX_ROWS);
  const priceAddresses = [];
  for (const item of selected) priceAddresses.push(item.market?.loanAsset?.address, item.market?.collateralAsset?.address);
  priceAddresses.push(...Object.values(TOKENS));
  const [prices, curvePools, ethUsd] = await Promise.all([
    fetchPrices(priceAddresses),
    fetchCurvePools().catch(() => []),
    getEthUsd(provider, block?.timestamp).catch(() => null),
  ]);
  const gas = {
    blockTimestamp: Number(block?.timestamp || Math.floor(Date.now() / 1000)),
    gasPriceWei: gasPriceWei.toString(),
    ethPriceUsd: ethUsd,
    liquidationGasUsd: ethUsd && gasPriceWei > 0n ? LIQUIDATION_GAS_UNITS * Number(gasPriceWei) / 1e18 * ethUsd : null,
  };
  const rows = [];
  for (let i = 0; i < selected.length; i++) {
    const quoteEnabled = i < QUOTE_ROWS;
    rows.push(await scoreRow(provider, curvePools, prices, gas, selected[i], quoteEnabled).catch((err) => ({
      borrower: normalizeAddress(selected[i].user?.address),
      pair: `${selected[i].market?.loanAsset?.symbol || "?"}/${selected[i].market?.collateralAsset?.symbol || "?"}`,
      error: err.message || String(err),
      routePositive: false,
      signedActionJustified: false,
    })));
  }
  rows.sort((a, b) => Number(b.researchPositive) - Number(a.researchPositive)
    || Number(b.quote?.bestNetProfitUsd ?? -Infinity) - Number(a.quote?.bestNetProfitUsd ?? -Infinity)
    || Number(b.marketability?.baseScore || 0) - Number(a.marketability?.baseScore || 0)
    || Number(b.graph?.collateralUsd || 0) - Number(a.graph?.collateralUsd || 0));
  const exactPositiveRows = rows.filter((r) => r.researchPositive).length;
  const rowsWithAnyQuote = rows.filter((r) => (r.quote?.quoteCount || 0) > 0).length;
  const best = rows.find((r) => r.quote?.bestNetProfitUsd !== null && r.quote?.bestNetProfitUsd !== undefined) || null;
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-morpho-liquidatable-marketability.js",
    scope: "Broad read-only Morpho current-liquidation marketability and bounded exact-exit ranker",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    block: { number: block?.number || null, timestamp: block?.timestamp || null, iso: block?.timestamp ? new Date(Number(block.timestamp) * 1000).toISOString() : null },
    thresholds: {
      graphqlFirst: GRAPHQL_FIRST,
      maxRows: MAX_ROWS,
      quoteRows: QUOTE_ROWS,
      minDebtUsd: MIN_DEBT_USD,
      minCollateralUsd: MIN_COLLATERAL_USD,
      sizeFractions: SIZE_FRACTIONS,
      slippageBps: SLIPPAGE_BPS,
      liquidationGasUnits: LIQUIDATION_GAS_UNITS,
      curvePoolsDiscovered: curvePools.length,
      curveMaxPoolsPerPair: CURVE_MAX_POOLS_PER_PAIR,
    },
    gas,
    summary: {
      graphqlRows: allItems.length,
      ethCurrentLiquidatableRows: allItems.filter((p) => Number(p.market?.chain?.id) === 1 && Number(p.healthFactor || 0) > 0 && Number(p.healthFactor || 0) < 1).length,
      materialRows: items.length,
      rowsRanked: rows.length,
      rowsQuoteProbed: rows.filter((r) => r.quote?.probed).length,
      rowsWithAnyQuote,
      exactPositiveRows,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      bestNetProfitUsd: best?.quote?.bestNetProfitUsd ?? null,
      bestPair: best?.pair || null,
      bestStatus: exactPositiveRows > 0 ? "research-positive-needs-fork-proof" : "no-exact-positive-exit",
      blocker: exactPositiveRows > 0 ? "Exact-positive rows are research-only until fork/static proof and executor semantics are verified" : "No bounded exact Uniswap/Curve exit quote is positive after gas/slippage",
    },
    topRows: rows.slice(0, 30),
    nextRoutePositiveCriteria: [
      "current Morpho borrower remains liquidatable on-chain",
      "non-overseizing repay size has exact collateral exit quote into the loan token",
      "loan-token price is trusted",
      "net remains positive after gas and slippage",
      "fork/static proof verifies liquidation and unwind semantics",
      "signed action remains disabled unless explicitly authorized",
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(output, jsonReplacer, 2) + "\n");
  console.log(`morphoMarketability rows=${output.summary.rowsRanked} quoteProbed=${output.summary.rowsQuoteProbed} quotes=${output.summary.rowsWithAnyQuote} exactPositive=${output.summary.exactPositiveRows} routePositive=0`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
