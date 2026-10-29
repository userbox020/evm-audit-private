#!/usr/bin/env node
// Read-only Morpho high-APY borrower/liquidation route scanner.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "morpho-high-apy-liquidation-routes.json");

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const MORPHO_API = "https://api.morpho.org/graphql";
const FALLBACK_ETHEREUM_RPCS = [
  ["https://", "ethereum-rpc.publicnode.com"].join(""),
  ["https://", "rpc.flashbots.net"].join(""),
];
const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNISWAP_V3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const ZERO = ethers.ZeroAddress;

const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const VIRTUAL_SHARES = 1_000_000n;
const VIRTUAL_ASSETS = 1n;
const LIQUIDATION_CURSOR = 300_000_000_000_000_000n;
const MAX_LIQUIDATION_INCENTIVE_FACTOR = 1_150_000_000_000_000_000n;

const MAX_MARKETS = Number(process.env.MORPHO_HIGH_APY_MAX_MARKETS || "30");
const MAX_POSITIONS_PER_MARKET = Number(process.env.MORPHO_HIGH_APY_POSITIONS_PER_MARKET || "5");
const MAX_SCORE_POSITIONS = Number(process.env.MORPHO_HIGH_APY_MAX_SCORE_POSITIONS || "8");
const MIN_MARKET_BORROW_USD = Number(process.env.MORPHO_HIGH_APY_MIN_MARKET_BORROW_USD || "10000");
const MIN_POSITION_DEBT_USD = Number(process.env.MORPHO_HIGH_APY_MIN_POSITION_DEBT_USD || "100");
const NEAR_HEALTH_FACTOR = Number(process.env.MORPHO_HIGH_APY_NEAR_HF || "1.05");
const MIN_BORROW_APY = Number(process.env.MORPHO_HIGH_APY_MIN_BORROW_APY || "10");
const MIN_UTILIZATION = Number(process.env.MORPHO_HIGH_APY_MIN_UTILIZATION || "0.9");
const SIZE_FRACTIONS = String(process.env.MORPHO_HIGH_APY_SIZE_FRACTIONS || "0.01,0.05,0.1,0.25,0.5")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0 && x <= 1);
const SLIPPAGE_BPS = Number(process.env.MORPHO_HIGH_APY_SLIPPAGE_BPS || "100");
const LIQUIDATION_GAS_UNITS = Number(process.env.MORPHO_HIGH_APY_GAS_UNITS || "1800000");
const CURVE_MAX_POOLS_PER_PAIR = Number(process.env.MORPHO_HIGH_APY_CURVE_MAX_POOLS_PER_PAIR || "3");
const MAX_UNISWAP_PATHS = Number(process.env.MORPHO_HIGH_APY_MAX_UNISWAP_PATHS || "24");

const FEES = [100, 500, 3000, 10000];

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
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
  "function convertToAssets(uint256 shares) view returns (uint256 assets)",
]);

const poolCache = new Map();
const curveDyCache = new Map();

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

function asNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
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

function positionDebtUsd(position) {
  return Number(position?.state?.borrowAssetsUsd || 0);
}

function isCurrentLiquidatable(position) {
  const healthFactor = Number(position?.healthFactor || 0);
  return healthFactor > 0 && healthFactor < 1;
}

function parseFractionShares(borrowShares, fraction) {
  const shares = toBigInt(borrowShares, 0n);
  if (shares <= 0n) return 0n;
  if (fraction >= 1) return shares;
  const bps = BigInt(Math.max(1, Math.floor(Number(fraction) * 10_000)));
  const partial = shares * bps / 10_000n;
  return partial > 0n ? partial : 1n;
}

function routeLabel(tokens, fees) {
  const parts = [];
  for (let i = 0; i < tokens.length; i++) {
    parts.push(tokens[i].slice(0, 8));
    if (i < fees.length) parts.push(String(fees[i]));
  }
  return parts.join("-");
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

function loadRpcUrls() {
  if (process.env.MORPHO_SKIP_RPC_INVENTORY === "1") return [];
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 8000) {
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
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveEthereumRpc() {
  for (const url of [...loadRpcUrls(), ...FALLBACK_ETHEREUM_RPCS]) {
    try {
      if (Number(BigInt(await rpcCall(url, "eth_chainId"))) === 1) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30_000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function morphoQuery(query, variables = {}) {
  const json = await fetchJson(MORPHO_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    timeoutMs: 45_000,
  });
  if (json.errors) throw new Error(json.errors[0]?.message || "Morpho GraphQL error");
  return json.data || {};
}

async function fetchPrices(addresses) {
  const keys = [...new Set(addresses.map(lowerAddress).filter(Boolean).map((address) => `ethereum:${address}`))];
  const out = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.slice(i, i + 50).join(",")}?searchWidth=6h`, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    for (const [key, row] of Object.entries(json.coins || {})) {
      const address = key.split(":").pop().toLowerCase();
      const price = Number(row?.price || 0);
      if (price > 0) out.set(address, price);
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
  const raw = await provider.call({ to: feed, data: CHAINLINK.encodeFunctionData("latestRoundData", []) }).catch(() => null);
  const decRaw = await provider.call({ to: feed, data: CHAINLINK.encodeFunctionData("decimals", []) }).catch(() => null);
  if (!raw || !decRaw) return null;
  try {
    const [, answer,, updatedAt] = CHAINLINK.decodeFunctionResult("latestRoundData", raw);
    const [decimals] = CHAINLINK.decodeFunctionResult("decimals", decRaw);
    if (answer <= 0n) return null;
    const updated = Number(updatedAt || 0n);
    const age = Number(blockTimestamp || 0) - updated;
    if (!Number.isFinite(age) || age < 0 || age > maxAgeSeconds) return null;
    return { priceUsd: Number(answer) / (10 ** Number(decimals)), updatedAt: updated, age };
  } catch (_) {
    return null;
  }
}

async function tokenUsdPrice(provider, token, graphPrice, prices, blockTimestamp) {
  const address = lowerAddress(token);
  if (!address) return { priceUsd: graphPrice || null, trusted: false, source: "missing-token", reason: "invalid token address" };
  const cfg = CHAINLINK_FEEDS.get(address);
  if (cfg) {
    const live = await readChainlinkUsd(provider, cfg.feed, cfg.maxAgeSeconds, blockTimestamp).catch(() => null);
    if (live) return { priceUsd: live.priceUsd, trusted: true, source: `chainlink-${cfg.label.toLowerCase()}-usd`, age: live.age, reason: null };
  }
  const llama = priceOf(prices, token, graphPrice);
  return { priceUsd: llama, trusted: false, source: llama ? "defillama-reference-only" : "missing-price", reason: "no supported fresh Chainlink/live rate source for route-positive gating" };
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
      pools.push({
        source: `Curve ${registry}`,
        name: p.name || p.symbol || null,
        address,
        coins,
        usdTotal: Number(p.usdTotal || p.usdTotalExcludingBasePool || 0) || null,
        isBroken: Boolean(p.isBroken),
      });
    }
  }
  return pools;
}

async function getPool(provider, tokenA, tokenB, fee) {
  const a = normalizeAddress(tokenA);
  const b = normalizeAddress(tokenB);
  if (!a || !b || sameAddress(a, b)) return null;
  const key = [a.toLowerCase(), b.toLowerCase(), fee].sort().join(":");
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

async function buildUniswapPathCandidates(provider, tokenIn, tokenOut, intermediates) {
  const input = normalizeAddress(tokenIn);
  const output = normalizeAddress(tokenOut);
  if (!input || !output) return [];
  if (sameAddress(input, output)) return [{ tokens: [input, output], fees: [0], pools: [], label: "same-token", directSameToken: true }];
  const candidates = [];
  for (const fee of FEES) {
    const pool = await getPool(provider, input, output, fee);
    if (pool) candidates.push({ tokens: [input, output], fees: [fee], pools: [pool], label: routeLabel([input, output], [fee]), direct: true });
  }
  const mids = [...new Set(intermediates.map(normalizeAddress).filter(Boolean).map((x) => x.toLowerCase()))]
    .filter((x) => !sameAddress(x, input) && !sameAddress(x, output))
    .map((x) => ethers.getAddress(x));
  for (const mid of mids) {
    for (const fee1 of FEES) {
      const pool1 = await getPool(provider, input, mid, fee1);
      if (!pool1) continue;
      for (const fee2 of FEES) {
        const pool2 = await getPool(provider, mid, output, fee2);
        if (!pool2) continue;
        candidates.push({ tokens: [input, mid, output], fees: [fee1, fee2], pools: [pool1, pool2], label: routeLabel([input, mid, output], [fee1, fee2]), direct: false });
        if (candidates.length >= MAX_UNISWAP_PATHS) return candidates;
      }
    }
  }
  return candidates;
}

async function quoteUniswapExactInput(provider, tokenIn, tokenOut, amountIn, intermediates) {
  const value = toBigInt(amountIn, 0n);
  if (value <= 0n) return [];
  if (sameAddress(tokenIn, tokenOut)) {
    return [{ source: "same-token", pathKind: "same-token", amountInRaw: value, amountOutRaw: value, gasEstimate: 0n, path: { tokens: [normalizeAddress(tokenIn), normalizeAddress(tokenOut)], fees: [0], label: "same-token" } }];
  }
  const out = [];
  const paths = await buildUniswapPathCandidates(provider, tokenIn, tokenOut, intermediates);
  for (const p of paths) {
    if (p.directSameToken) continue;
    const raw = await provider.call({
      to: UNISWAP_V3_QUOTER_V2,
      data: QUOTER.encodeFunctionData("quoteExactInput", [encodePath(p.tokens, p.fees), value]),
    }).catch(() => null);
    if (!raw) continue;
    try {
      const [amountOut, , , gasEstimate] = QUOTER.decodeFunctionResult("quoteExactInput", raw);
      out.push({ source: p.direct ? "Uniswap V3 exact-input direct" : "Uniswap V3 routed exact-input", pathKind: p.direct ? "uniswap-v3-direct" : "uniswap-v3-routed", amountInRaw: value, amountOutRaw: amountOut, gasEstimate, path: p });
    } catch (_) {}
  }
  return out;
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
    const raw = await provider.call({
      to: pool.address,
      data: iface.encodeFunctionData("get_dy", [BigInt(i), BigInt(j), amount]),
    }).catch(() => null);
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
    out.push({ source: pool.source, pathKind: "curve-direct", amountInRaw: toBigInt(amountIn), amountOutRaw: amountOut, gasEstimate: 0n, path: { pool: pool.address, name: pool.name, tokenIn: pool.i.address, tokenOut: pool.j.address, coinIn: pool.i, coinOut: pool.j } });
  }
  return out;
}

function stableHopCandidates(tokenIn, tokenOut, intermediates) {
  const base = [TOKENS.WETH, TOKENS.WSTETH, TOKENS.WBTC, TOKENS.USDC, TOKENS.USDT, TOKENS.DAI, TOKENS.USDE, TOKENS.USDS, TOKENS.crvUSD, TOKENS.FRAX, TOKENS.PYUSD, TOKENS.USD0, ...intermediates];
  return [...new Set(base.map(normalizeAddress).filter(Boolean).map((x) => x.toLowerCase()))]
    .map((x) => ethers.getAddress(x))
    .filter((mid) => !sameAddress(mid, tokenIn) && !sameAddress(mid, tokenOut))
    .slice(0, 12);
}

async function quoteCurveStableHops(provider, curvePools, tokenIn, tokenOut, amountIn, intermediates) {
  const candidates = [];
  for (const mid of stableHopCandidates(tokenIn, tokenOut, intermediates)) {
    if (findCurvePools(curvePools, tokenIn, mid).length > 0) {
      const curveHeads = await quoteCurveExactInput(provider, curvePools, tokenIn, mid, amountIn).catch(() => []);
      const curveHead = curveHeads.sort((a, b) => (a.amountOutRaw > b.amountOutRaw ? -1 : a.amountOutRaw < b.amountOutRaw ? 1 : 0))[0];
      if (curveHead) {
        const uniTails = await quoteUniswapExactInput(provider, mid, tokenOut, curveHead.amountOutRaw, intermediates).catch(() => []);
        const bestTail = uniTails.sort((a, b) => (a.amountOutRaw > b.amountOutRaw ? -1 : a.amountOutRaw < b.amountOutRaw ? 1 : 0))[0];
        if (bestTail) candidates.push({ source: "Curve + Uniswap V3 exact-input", pathKind: "curve-to-uniswap-v3", amountInRaw: toBigInt(amountIn), amountOutRaw: bestTail.amountOutRaw, gasEstimate: toBigInt(bestTail.gasEstimate) + toBigInt(curveHead.gasEstimate), path: { legs: [curveHead.path, bestTail.path] } });
      }
    }
    if (findCurvePools(curvePools, mid, tokenOut).length > 0) {
      const uniHeads = await quoteUniswapExactInput(provider, tokenIn, mid, amountIn, intermediates).catch(() => []);
      const bestHead = uniHeads.sort((a, b) => (a.amountOutRaw > b.amountOutRaw ? -1 : a.amountOutRaw < b.amountOutRaw ? 1 : 0))[0];
      if (!bestHead) continue;
      const curveTails = await quoteCurveExactInput(provider, curvePools, mid, tokenOut, bestHead.amountOutRaw).catch(() => []);
      const bestTail = curveTails.sort((a, b) => (a.amountOutRaw > b.amountOutRaw ? -1 : a.amountOutRaw < b.amountOutRaw ? 1 : 0))[0];
      if (bestTail) candidates.push({ source: "Uniswap V3 + Curve exact-input", pathKind: "uniswap-v3-to-curve", amountInRaw: toBigInt(amountIn), amountOutRaw: bestTail.amountOutRaw, gasEstimate: toBigInt(bestHead.gasEstimate) + toBigInt(bestTail.gasEstimate), path: { legs: [bestHead.path, bestTail.path] } });
    }
  }
  return candidates;
}

async function quoteCurveCurveHops(provider, curvePools, tokenIn, tokenOut, amountIn, intermediates) {
  const candidates = [];
  for (const mid of stableHopCandidates(tokenIn, tokenOut, intermediates)) {
    if (!findCurvePools(curvePools, tokenIn, mid).length || !findCurvePools(curvePools, mid, tokenOut).length) continue;
    const curveHeads = await quoteCurveExactInput(provider, curvePools, tokenIn, mid, amountIn).catch(() => []);
    for (const curveHead of curveHeads.slice(0, CURVE_MAX_POOLS_PER_PAIR)) {
      const curveTails = await quoteCurveExactInput(provider, curvePools, mid, tokenOut, curveHead.amountOutRaw).catch(() => []);
      for (const curveTail of curveTails.slice(0, CURVE_MAX_POOLS_PER_PAIR)) {
        candidates.push({
          source: "Curve + Curve exact-input",
          pathKind: "curve-to-curve",
          amountInRaw: toBigInt(amountIn),
          amountOutRaw: curveTail.amountOutRaw,
          gasEstimate: toBigInt(curveHead.gasEstimate) + toBigInt(curveTail.gasEstimate),
          path: { intermediate: mid, intermediateAmountRaw: curveHead.amountOutRaw.toString(), legs: [curveHead.path, curveTail.path] },
        });
      }
    }
  }
  return candidates;
}

async function quoteDexExitCandidates(provider, curvePools, tokenIn, tokenOut, amountIn, intermediates) {
  const candidates = [];
  candidates.push(...await quoteUniswapExactInput(provider, tokenIn, tokenOut, amountIn, intermediates).catch(() => []));
  candidates.push(...await quoteCurveExactInput(provider, curvePools, tokenIn, tokenOut, amountIn).catch(() => []));
  candidates.push(...await quoteCurveStableHops(provider, curvePools, tokenIn, tokenOut, amountIn, intermediates).catch(() => []));
  candidates.push(...await quoteCurveCurveHops(provider, curvePools, tokenIn, tokenOut, amountIn, intermediates).catch(() => []));
  return candidates;
}

async function quoteErc4626RedeemExit(provider, curvePools, tokenIn, tokenOut, amountIn, intermediates) {
  const shares = toBigInt(amountIn, 0n);
  if (shares <= 0n) return [];
  const asset = await safeCall(provider, tokenIn, ERC4626, "asset", []).catch(() => null);
  const assetAddress = normalizeAddress(asset);
  if (!assetAddress || sameAddress(assetAddress, tokenIn)) return [];
  let assetsOut = await safeCall(provider, tokenIn, ERC4626, "previewRedeem", [shares]).catch(() => null);
  if (!assetsOut || toBigInt(assetsOut) <= 0n) assetsOut = await safeCall(provider, tokenIn, ERC4626, "convertToAssets", [shares]).catch(() => null);
  assetsOut = toBigInt(assetsOut, 0n);
  if (assetsOut <= 0n) return [];
  if (sameAddress(assetAddress, tokenOut)) {
    return [{
      source: "ERC4626 previewRedeem direct",
      pathKind: "erc4626-redeem-direct",
      amountInRaw: shares,
      amountOutRaw: assetsOut,
      gasEstimate: 0n,
      path: { vault: normalizeAddress(tokenIn), asset: assetAddress, previewRedeemAssetsRaw: assetsOut.toString() },
    }];
  }
  const tailIntermediates = [...intermediates, tokenIn, assetAddress];
  const tails = await quoteDexExitCandidates(provider, curvePools, assetAddress, tokenOut, assetsOut, tailIntermediates).catch(() => []);
  return tails.map((tail) => ({
    source: `ERC4626 previewRedeem + ${tail.source}`,
    pathKind: `erc4626-redeem-to-${tail.pathKind}`,
    amountInRaw: shares,
    amountOutRaw: tail.amountOutRaw,
    gasEstimate: toBigInt(tail.gasEstimate),
    path: { vault: normalizeAddress(tokenIn), asset: assetAddress, previewRedeemAssetsRaw: assetsOut.toString(), tail: tail.path },
  }));
}

async function quoteExitCandidates(provider, curvePools, tokenIn, tokenOut, amountIn, intermediates) {
  const candidates = await quoteDexExitCandidates(provider, curvePools, tokenIn, tokenOut, amountIn, intermediates);
  candidates.push(...await quoteErc4626RedeemExit(provider, curvePools, tokenIn, tokenOut, amountIn, intermediates).catch(() => []));
  const seen = new Set();
  return candidates
    .filter((q) => q && toBigInt(q.amountOutRaw) > 0n)
    .sort((a, b) => (toBigInt(a.amountOutRaw) > toBigInt(b.amountOutRaw) ? -1 : toBigInt(a.amountOutRaw) < toBigInt(b.amountOutRaw) ? 1 : 0))
    .filter((q) => {
      const key = `${q.pathKind}:${q.amountOutRaw.toString()}:${JSON.stringify(q.path || {})}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function fetchHighApyMarkets() {
  const query = `query($first:Int!, $minBorrowUsd:Float!, $minBorrowApy:Float!, $minUtilization:Float!) {
    highApy: markets(first:$first, orderBy:BorrowApy, orderDirection:Desc,
      where:{chainId_in:[1], borrowAssetsUsd_gte:$minBorrowUsd, borrowApy_gte:$minBorrowApy}) { items {
        marketId irmAddress lltv
        loanAsset { symbol address decimals }
        collateralAsset { symbol address decimals }
        oracle { address }
        state { borrowApy netBorrowApy supplyApy borrowAssetsUsd supplyAssetsUsd liquidityAssetsUsd utilization }
      } }
    highUtilization: markets(first:$first, orderBy:Utilization, orderDirection:Desc,
      where:{chainId_in:[1], borrowAssetsUsd_gte:$minBorrowUsd, utilization_gte:$minUtilization}) { items {
        marketId irmAddress lltv
        loanAsset { symbol address decimals }
        collateralAsset { symbol address decimals }
        oracle { address }
        state { borrowApy netBorrowApy supplyApy borrowAssetsUsd supplyAssetsUsd liquidityAssetsUsd utilization }
      } }
  }`;
  const data = await morphoQuery(query, { first: MAX_MARKETS, minBorrowUsd: MIN_MARKET_BORROW_USD, minBorrowApy: MIN_BORROW_APY, minUtilization: MIN_UTILIZATION });
  const out = [];
  const seen = new Set();
  for (const source of ["highApy", "highUtilization"]) {
    for (const market of data?.[source]?.items || []) {
      const key = String(market.marketId || "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ ...market, discoverySource: source });
    }
  }
  out.sort((a, b) => Number(b.state?.borrowApy || 0) - Number(a.state?.borrowApy || 0)
    || Number(b.state?.utilization || 0) - Number(a.state?.utilization || 0)
    || Number(b.state?.borrowAssetsUsd || 0) - Number(a.state?.borrowAssetsUsd || 0));
  return out.slice(0, MAX_MARKETS);
}

async function fetchNearPositions(marketId) {
  const query = `query($first:Int!, $marketId:String!, $nearHf:Float!) {
    marketPositions(first:$first, orderBy:HealthFactor, orderDirection:Asc,
      where:{chainId_in:[1], marketUniqueKey_in:[$marketId], borrowShares_gte:"1", healthFactor_lte:$nearHf}) {
      items {
        user { address }
        healthFactor
        state { collateral collateralUsd borrowAssets borrowAssetsUsd borrowShares marginUsd }
        market {
          marketId irmAddress lltv
          loanAsset { symbol address decimals }
          collateralAsset { symbol address decimals }
          oracle { address }
          state { borrowApy netBorrowApy supplyApy borrowAssetsUsd supplyAssetsUsd liquidityAssetsUsd utilization }
        }
      }
    }
  }`;
  const data = await morphoQuery(query, { first: MAX_POSITIONS_PER_MARKET, marketId, nearHf: NEAR_HEALTH_FACTOR }).catch(() => ({ marketPositions: { items: [] } }));
  return data?.marketPositions?.items || [];
}

async function readOnchainMarketPosition(provider, marketId, borrower, oracle) {
  const [marketRaw, positionRaw, oracleRaw] = await Promise.all([
    provider.call({ to: MORPHO, data: MORPHO_IFACE.encodeFunctionData("market", [marketId]) }).catch(() => null),
    provider.call({ to: MORPHO, data: MORPHO_IFACE.encodeFunctionData("position", [marketId, borrower]) }).catch(() => null),
    provider.call({ to: oracle, data: ORACLE.encodeFunctionData("price", []) }).catch(() => null),
  ]);
  if (!marketRaw || !positionRaw || !oracleRaw) return null;
  try {
    const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = MORPHO_IFACE.decodeFunctionResult("market", marketRaw);
    const [supplyShares, borrowShares, collateral] = MORPHO_IFACE.decodeFunctionResult("position", positionRaw);
    const [oraclePrice] = ORACLE.decodeFunctionResult("price", oracleRaw);
    return { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee, supplyShares, borrowShares, collateral, oraclePrice };
  } catch (_) {
    return null;
  }
}

function buildIntermediates(position) {
  const values = [
    TOKENS.WETH,
    TOKENS.WSTETH,
    TOKENS.WBTC,
    TOKENS.USDC,
    TOKENS.USDT,
    TOKENS.DAI,
    TOKENS.USDE,
    TOKENS.USDS,
    TOKENS.crvUSD,
    TOKENS.FRAX,
    TOKENS.PYUSD,
    TOKENS.USD0,
    position.market?.loanAsset?.address,
    position.market?.collateralAsset?.address,
  ];
  return [...new Set(values.map(normalizeAddress).filter(Boolean).map((x) => x.toLowerCase()))].map((x) => ethers.getAddress(x));
}

async function scorePosition(provider, curvePools, prices, block, gas, position) {
  const borrower = normalizeAddress(position.user?.address);
  const marketId = position.market?.marketId;
  const loan = normalizeAddress(position.market?.loanAsset?.address);
  const collateral = normalizeAddress(position.market?.collateralAsset?.address);
  const oracle = normalizeAddress(position.market?.oracle?.address);
  const loanDecimals = Number(position.market?.loanAsset?.decimals ?? 18);
  const collateralDecimals = Number(position.market?.collateralAsset?.decimals ?? 18);
  const healthFactor = Number(position.healthFactor || 0);
  const graphBorrowUsd = Number(position.state?.borrowAssetsUsd || 0);
  const graphBorrowRaw = toBigInt(position.state?.borrowAssets || 0n);
  const graphBorrowHuman = formatUnitsNumber(graphBorrowRaw, loanDecimals) || 0;
  const graphLoanPrice = graphBorrowHuman > 0 && graphBorrowUsd > 0 ? graphBorrowUsd / graphBorrowHuman : null;
  const loanPrice = await tokenUsdPrice(provider, loan, graphLoanPrice, prices, block?.timestamp);
  const collateralPriceUsd = priceOf(prices, collateral, null);
  const base = {
    borrower,
    marketId,
    pair: `${position.market?.loanAsset?.symbol || "?"}/${position.market?.collateralAsset?.symbol || "?"}`,
    healthFactor,
    currentLiquidatable: healthFactor > 0 && healthFactor < 1,
    graph: {
      borrowAssetsUsd: graphBorrowUsd,
      collateralUsd: Number(position.state?.collateralUsd || 0),
      borrowAssetsRaw: position.state?.borrowAssets || null,
      borrowSharesRaw: position.state?.borrowShares || null,
      collateralRaw: position.state?.collateral || null,
      marginUsd: Number(position.state?.marginUsd || 0),
    },
    market: {
      borrowApy: Number(position.market?.state?.borrowApy || 0),
      netBorrowApy: position.market?.state?.netBorrowApy ?? null,
      supplyApy: position.market?.state?.supplyApy ?? null,
      utilization: Number(position.market?.state?.utilization || 0),
      borrowAssetsUsd: Number(position.market?.state?.borrowAssetsUsd || 0),
      supplyAssetsUsd: Number(position.market?.state?.supplyAssetsUsd || 0),
      liquidityAssetsUsd: Number(position.market?.state?.liquidityAssetsUsd || 0),
      lltvRaw: position.market?.lltv || null,
      lltv: Number(toBigInt(position.market?.lltv || 0n)) / 1e18,
    },
    loanAsset: { address: loan, symbol: position.market?.loanAsset?.symbol || null, decimals: loanDecimals, priceUsd: loanPrice.priceUsd, pricingTrusted: loanPrice.trusted, priceSource: loanPrice.source, priceReason: loanPrice.reason || null },
    collateral: { address: collateral, symbol: position.market?.collateralAsset?.symbol || null, decimals: collateralDecimals, priceUsd: collateralPriceUsd },
    oracle,
    irm: normalizeAddress(position.market?.irmAddress),
    routePositive: false,
    watchCandidate: healthFactor >= 1 && healthFactor <= NEAR_HEALTH_FACTOR,
    signedActionJustified: false,
  };
  if (!base.currentLiquidatable) return { ...base, blockers: ["Position is not currently liquidatable"] };
  if (graphBorrowUsd < MIN_POSITION_DEBT_USD) return { ...base, blockers: [`Position debt below $${MIN_POSITION_DEBT_USD}`] };
  if (!borrower || !marketId || !loan || !collateral || !oracle) return { ...base, blockers: ["Invalid borrower, market, token, or oracle address"] };
  if (!loanPrice.priceUsd) return { ...base, blockers: ["Missing loan-token USD price for gas/profit conversion"] };
  const onchain = await readOnchainMarketPosition(provider, marketId, borrower, oracle).catch(() => null);
  if (!onchain || onchain.borrowShares <= 0n || onchain.collateral <= 0n || onchain.totalBorrowShares <= 0n || onchain.oraclePrice <= 0n) {
    return { ...base, onchainAvailable: false, blockers: ["Missing on-chain market/position/oracle data or no repayable debt/collateral"] };
  }
  const lifRaw = liquidationIncentiveFactorRaw(position.market?.lltv || 0n);
  const onchainBorrowAssets = toAssetsUp(onchain.borrowShares, onchain.totalBorrowAssets, onchain.totalBorrowShares);
  const onchainBorrowUsd = loanPrice.priceUsd ? (formatUnitsNumber(onchainBorrowAssets, loanDecimals) || 0) * loanPrice.priceUsd : null;
  const graphVsOnchainBorrowUsd = onchainBorrowUsd !== null ? graphBorrowUsd - onchainBorrowUsd : null;
  const graphVsOnchainBorrowPct = onchainBorrowUsd && onchainBorrowUsd > 0 ? (graphVsOnchainBorrowUsd / onchainBorrowUsd) * 100 : null;
  const maxRepayAssetsByCollateral = mulDivDown(mulDivDown(onchain.collateral, onchain.oraclePrice, ORACLE_PRICE_SCALE), WAD, lifRaw);
  const maxRepayByCollateralUsd = loanPrice.priceUsd ? (formatUnitsNumber(maxRepayAssetsByCollateral, loanDecimals) || 0) * loanPrice.priceUsd : null;
  const intermediates = buildIntermediates(position);
  const sizeResults = [];
  for (const fraction of SIZE_FRACTIONS) {
    const repaidShares = parseFractionShares(onchain.borrowShares, fraction);
    if (repaidShares <= 0n) continue;
    const repaidAssets = toAssetsUp(repaidShares, onchain.totalBorrowAssets, onchain.totalBorrowShares);
    const seizedCollateral = mulDivDown(mulDivDown(repaidAssets, lifRaw, WAD), ORACLE_PRICE_SCALE, onchain.oraclePrice);
    const seizedExceedsCollateral = seizedCollateral > onchain.collateral;
    const repayUsd = (formatUnitsNumber(repaidAssets, loanDecimals) || 0) * loanPrice.priceUsd;
    let quotes = [];
    if (!seizedExceedsCollateral && seizedCollateral > 0n) quotes = await quoteExitCandidates(provider, curvePools, collateral, loan, seizedCollateral, intermediates).catch(() => []);
    const scoredQuotes = quotes.slice(0, 8).map((quote) => {
      const expectedOutRaw = toBigInt(quote.amountOutRaw);
      const grossProfitRaw = expectedOutRaw - repaidAssets;
      const expectedOut = formatUnitsNumber(expectedOutRaw, loanDecimals) || 0;
      const expectedOutUsd = expectedOut * loanPrice.priceUsd;
      const grossProfitUsd = (formatUnitsNumber(grossProfitRaw, loanDecimals) || 0) * loanPrice.priceUsd;
      const slippageUsd = repayUsd * SLIPPAGE_BPS / 10_000;
      const netProfitUsd = grossProfitUsd - Number(gas.liquidationGasUsd || 0) - slippageUsd;
      const researchPositive = Boolean(grossProfitRaw > 0n && netProfitUsd > 0);
      const routePositive = Boolean(researchPositive && loanPrice.trusted);
      return {
        source: quote.source,
        pathKind: quote.pathKind,
        amountInRaw: quote.amountInRaw.toString(),
        amountOutRaw: expectedOutRaw.toString(),
        amountOut: expectedOut,
        expectedOutUsd,
        grossProfitRaw: grossProfitRaw.toString(),
        grossProfitUsd,
        slippageUsd,
        gasUsd: gas.liquidationGasUsd,
        netProfitUsd,
        gasEstimate: quote.gasEstimate?.toString?.() || null,
        researchPositive,
        routePositive,
        path: quote.path,
        blockers: [
          loanPrice.trusted ? null : "Loan-token price is not trusted for route-positive gating",
          grossProfitRaw > 0n ? null : "Exit quote does not cover repay assets",
          netProfitUsd > 0 ? null : "Net profit after gas/slippage is not positive",
        ].filter(Boolean),
      };
    }).sort((a, b) => Number(b.netProfitUsd ?? -Infinity) - Number(a.netProfitUsd ?? -Infinity));
    const best = scoredQuotes[0] || null;
    sizeResults.push({
      fraction,
      repaidSharesRaw: repaidShares.toString(),
      repaidAssetsRaw: repaidAssets.toString(),
      repayUsd,
      seizedCollateralRaw: seizedCollateral.toString(),
      seizedCollateral: formatUnitsNumber(seizedCollateral, collateralDecimals),
      seizedExceedsCollateral,
      liquidationIncentiveFactor: Number(lifRaw) / 1e18,
      quotes: scoredQuotes,
      best,
      routePositive: Boolean(best?.routePositive),
      researchPositive: Boolean(best?.researchPositive),
      blockers: [
        seizedExceedsCollateral ? "Partial repay would over-seize collateral" : null,
        scoredQuotes.length > 0 ? null : "No collateral-exit quote for this size",
        best?.routePositive ? null : "No route-positive quote for this size",
      ].filter(Boolean),
    });
  }
  sizeResults.sort((a, b) => Number(b.best?.netProfitUsd ?? -Infinity) - Number(a.best?.netProfitUsd ?? -Infinity));
  const quoteEligibleSizeCount = sizeResults.filter((s) => !s.seizedExceedsCollateral && toBigInt(s.seizedCollateralRaw) > 0n).length;
  const overSeizeOnly = sizeResults.length > 0 && quoteEligibleSizeCount === 0;
  const quoteEligible = Boolean(quoteEligibleSizeCount > 0 && maxRepayAssetsByCollateral > 0n);
  const routePositive = sizeResults.some((s) => s.routePositive);
  const researchPositive = sizeResults.some((s) => s.researchPositive);
  return {
    ...base,
    onchainAvailable: true,
    onchain: {
      totalBorrowAssetsRaw: onchain.totalBorrowAssets.toString(),
      totalBorrowSharesRaw: onchain.totalBorrowShares.toString(),
      borrowSharesRaw: onchain.borrowShares.toString(),
      collateralRaw: onchain.collateral.toString(),
      oraclePriceRaw: onchain.oraclePrice.toString(),
      lastUpdate: onchain.lastUpdate.toString(),
      fee: onchain.fee.toString(),
    },
    diagnostics: {
      onchainBorrowAssetsRaw: onchainBorrowAssets.toString(),
      onchainBorrowUsd,
      graphVsOnchainBorrowUsd,
      graphVsOnchainBorrowPct,
      maxRepayAssetsByCollateralRaw: maxRepayAssetsByCollateral.toString(),
      maxRepayByCollateralUsd,
      quoteEligibleSizeCount,
      quoteEligible,
      overSeizeOnly,
      graphDebtBelowMin: graphBorrowUsd < MIN_POSITION_DEBT_USD,
    },
    routedIntermediates: intermediates,
    sizeResults,
    best: sizeResults[0] || null,
    routePositive,
    researchPositive,
    watchCandidate: !routePositive && (researchPositive || (healthFactor >= 1 && healthFactor <= NEAR_HEALTH_FACTOR)),
    signedActionJustified: false,
    blockers: [
      routePositive ? null : "No route-positive liquidation size",
      researchPositive ? null : "No research-positive exact exit quote",
      loanPrice.trusted ? null : "Loan-token price is not trusted for route-positive gating",
      "Fork proof and signed-action authorization absent",
    ].filter(Boolean),
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rpc = await resolveEthereumRpc();
  if (!rpc) throw new Error("missing ethereum rpc");
  const provider = new ethers.JsonRpcProvider(rpc);
  const [block, gasPriceWei] = await Promise.all([
    provider.getBlock("latest"),
    provider.send("eth_gasPrice", []).then(BigInt).catch(() => 0n),
  ]);
  const markets = await fetchHighApyMarkets();
  const positions = [];
  for (const market of markets) {
    const items = await fetchNearPositions(market.marketId).catch(() => []);
    for (const item of items) positions.push({ ...item, discoverySource: market.discoverySource });
  }
  const seenPositions = new Set();
  const dedupedPositions = [];
  for (const position of positions) {
    const key = `${String(position.market?.marketId || "").toLowerCase()}:${lowerAddress(position.user?.address)}`;
    if (!key.includes("0x") || seenPositions.has(key)) continue;
    seenPositions.add(key);
    dedupedPositions.push(position);
  }
  dedupedPositions.sort((a, b) => Number(a.healthFactor || Infinity) - Number(b.healthFactor || Infinity)
    || Number(b.state?.borrowAssetsUsd || 0) - Number(a.state?.borrowAssetsUsd || 0));
  const scoreEligiblePositions = dedupedPositions.filter((p) => positionDebtUsd(p) >= MIN_POSITION_DEBT_USD);
  const dustSkippedPositions = dedupedPositions.filter((p) => positionDebtUsd(p) < MIN_POSITION_DEBT_USD);
  const liquidatableDustSkipped = dustSkippedPositions.filter(isCurrentLiquidatable).length;
  const scorePositions = scoreEligiblePositions.slice(0, MAX_SCORE_POSITIONS);
  const priceAddresses = [];
  for (const market of markets) priceAddresses.push(market.loanAsset?.address, market.collateralAsset?.address);
  for (const position of scorePositions) priceAddresses.push(position.market?.loanAsset?.address, position.market?.collateralAsset?.address);
  priceAddresses.push(...Object.values(TOKENS));
  const [prices, curvePools] = await Promise.all([
    fetchPrices(priceAddresses.filter(Boolean)),
    fetchCurvePools().catch(() => []),
  ]);
  const ethPriceUsd = priceOf(prices, TOKENS.WETH, null);
  const gas = {
    gasPriceWei: gasPriceWei.toString(),
    ethPriceUsd,
    liquidationGasUsd: ethPriceUsd && gasPriceWei > 0n ? LIQUIDATION_GAS_UNITS * Number(gasPriceWei) / 1e18 * ethPriceUsd : null,
  };
  const results = [];
  for (const position of scorePositions) {
    results.push(await scorePosition(provider, curvePools, prices, block, gas, position).catch((err) => ({
      borrower: normalizeAddress(position.user?.address),
      marketId: position.market?.marketId || null,
      pair: `${position.market?.loanAsset?.symbol || "?"}/${position.market?.collateralAsset?.symbol || "?"}`,
      healthFactor: Number(position.healthFactor || 0),
      error: err.message || String(err),
      routePositive: false,
      watchCandidate: false,
      signedActionJustified: false,
    })));
  }
  results.sort((a, b) => Number(b.routePositive) - Number(a.routePositive)
    || Number(b.researchPositive) - Number(a.researchPositive)
    || Number(b.best?.best?.netProfitUsd ?? -Infinity) - Number(a.best?.best?.netProfitUsd ?? -Infinity)
    || Number(a.healthFactor || Infinity) - Number(b.healthFactor || Infinity));
  const positiveRoutes = [];
  const researchPositiveRoutes = [];
  for (const row of results) {
    for (const size of row.sizeResults || []) {
      for (const quote of size.quotes || []) {
        const target = quote.routePositive ? positiveRoutes : quote.researchPositive ? researchPositiveRoutes : null;
        if (!target) continue;
        target.push({ borrower: row.borrower, marketId: row.marketId, pair: row.pair, healthFactor: row.healthFactor, fraction: size.fraction, repaidAssetsRaw: size.repaidAssetsRaw, seizedCollateralRaw: size.seizedCollateralRaw, source: quote.source, pathKind: quote.pathKind, netProfitUsd: quote.netProfitUsd });
      }
    }
  }
  const routePositive = positiveRoutes.length;
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-morpho-high-apy-liquidation-routes.js",
    scope: "Read-only Morpho high-APY/high-utilization borrower liquidation route scanner",
    safety: {
      rpcInventoryRead: process.env.MORPHO_SKIP_RPC_INVENTORY !== "1" && fs.existsSync(RPC_FILE),
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    block: { number: block?.number || null, timestamp: block?.timestamp || null, iso: block?.timestamp ? new Date(Number(block.timestamp) * 1000).toISOString() : null },
    thresholds: {
      maxMarkets: MAX_MARKETS,
      maxPositionsPerMarket: MAX_POSITIONS_PER_MARKET,
      maxScorePositions: MAX_SCORE_POSITIONS,
      minMarketBorrowUsd: MIN_MARKET_BORROW_USD,
      minPositionDebtUsd: MIN_POSITION_DEBT_USD,
      nearHealthFactor: NEAR_HEALTH_FACTOR,
      minBorrowApy: MIN_BORROW_APY,
      minUtilization: MIN_UTILIZATION,
      sizeFractions: SIZE_FRACTIONS,
      slippageBps: SLIPPAGE_BPS,
      liquidationGasUnits: LIQUIDATION_GAS_UNITS,
      curvePoolsDiscovered: curvePools.length,
    },
    gas,
    summary: {
      marketsScanned: markets.length,
      highApyMarkets: markets.filter((m) => m.discoverySource === "highApy").length,
      highUtilizationMarkets: markets.filter((m) => m.discoverySource === "highUtilization").length,
      maxBorrowApy: markets.reduce((best, m) => Math.max(best, Number(m.state?.borrowApy || 0)), 0),
      maxUtilization: markets.reduce((best, m) => Math.max(best, Number(m.state?.utilization || 0)), 0),
      positionsDiscovered: dedupedPositions.length,
      positionsScoreEligible: scoreEligiblePositions.length,
      positionsDustSkipped: dustSkippedPositions.length,
      liquidatableDustSkipped,
      positionsScored: results.length,
      currentLiquidatable: results.filter((r) => r.currentLiquidatable).length,
      currentLiquidatableDiscovered: dedupedPositions.filter(isCurrentLiquidatable).length,
      nearLiquidatable: results.filter((r) => !r.currentLiquidatable && Number(r.healthFactor || 0) <= NEAR_HEALTH_FACTOR).length,
      rowsQuoteEligible: results.filter((r) => r.diagnostics?.quoteEligible).length,
      rowsOverseizeOnly: results.filter((r) => r.diagnostics?.overSeizeOnly).length,
      rowsWithBorrowDiscrepancy: results.filter((r) => Math.abs(Number(r.diagnostics?.graphVsOnchainBorrowPct || 0)) >= 5).length,
      rowsWithAnyQuote: results.filter((r) => (r.sizeResults || []).some((s) => (s.quotes || []).length > 0)).length,
      rowsWithCurveQuote: results.filter((r) => (r.sizeResults || []).some((s) => (s.quotes || []).some((q) => String(q.pathKind || "").includes("curve")))).length,
      rowsWithCurveCurveQuote: results.filter((r) => (r.sizeResults || []).some((s) => (s.quotes || []).some((q) => q.pathKind === "curve-to-curve"))).length,
      rowsWithErc4626ExitQuote: results.filter((r) => (r.sizeResults || []).some((s) => (s.quotes || []).some((q) => String(q.pathKind || "").includes("erc4626-redeem")))).length,
      bestNetProfitUsd: results.reduce((best, r) => Math.max(best, Number(r.best?.best?.netProfitUsd ?? -Infinity)), -Infinity),
      watchCandidates: results.filter((r) => r.watchCandidate).length,
      researchPositiveRoutes: researchPositiveRoutes.length + positiveRoutes.length,
      routePositive,
      signedActionJustified: false,
    },
    topMarkets: markets.slice(0, 12).map((m) => ({
      marketId: m.marketId,
      pair: `${m.loanAsset?.symbol || "?"}/${m.collateralAsset?.symbol || "?"}`,
      borrowApy: m.state?.borrowApy ?? null,
      utilization: m.state?.utilization ?? null,
      borrowAssetsUsd: m.state?.borrowAssetsUsd ?? null,
      liquidityAssetsUsd: m.state?.liquidityAssetsUsd ?? null,
      discoverySource: m.discoverySource,
    })),
    positiveRoutes,
    researchPositiveRoutes,
    results,
    nextRoutePositiveCriteria: [
      "Borrower must be currently liquidatable and verified on-chain",
      "Repay shares/assets and seized collateral must be computed from current Morpho market state",
      "Exact collateral exit quote must exceed repaid assets after gas and slippage",
      "Loan-token USD price must be trusted for route-positive gating",
      "Fork proof is required before any executor or signed action work",
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(output, jsonReplacer, 2) + "\n");
  console.log(`Morpho high-APY liquidation scan: markets=${output.summary.marketsScanned} positions=${output.summary.positionsScored} eligible=${output.summary.rowsQuoteEligible} dustSkipped=${output.summary.positionsDustSkipped} quotes=${output.summary.rowsWithAnyQuote} routePositive=${output.summary.routePositive}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(String(err.stack || err.message || err).replace(/https?:\/\/[^\s'"<>]+/g, "[redacted-rpc]"));
  process.exitCode = 1;
});
