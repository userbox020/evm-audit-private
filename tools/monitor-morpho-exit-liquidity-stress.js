#!/usr/bin/env node
// Read-only Morpho high-LLTV exit-liquidity stress monitor.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const IN_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "focused-morpho-review-producers.json");
const OUT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "morpho-exit-liquidity-stress.json");

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

const FEES = [100, 500, 3000, 10000];
const SHOCKS = String(process.env.MORPHO_STRESS_SHOCKS || "1,3,5,10,15,20")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0 && x < 100);
const SIZE_FRACTIONS = String(process.env.MORPHO_STRESS_SIZE_FRACTIONS || "0.01,0.05,0.1,0.25,0.5,0.75,1")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0 && x <= 1);
const MAX_ROWS = Number(process.env.MORPHO_STRESS_MAX_ROWS || "14");
const MAX_POSITIONS_PER_MARKET = Number(process.env.MORPHO_STRESS_MAX_POSITIONS || "20");
const SLIPPAGE_BPS = Number(process.env.MORPHO_STRESS_SLIPPAGE_BPS || "100");
const ACQUISITION_GAS_UNITS = Number(process.env.MORPHO_STRESS_ACQUISITION_GAS_UNITS || "2200000");
const LIQUIDATION_GAS_UNITS = Number(process.env.MORPHO_STRESS_LIQUIDATION_GAS_UNITS || "1800000");
const WATCH_GAP_BPS = Number(process.env.MORPHO_STRESS_WATCH_GAP_BPS || "1000");
const MIN_ROUTE_LIQUIDITY_USD = Number(process.env.MORPHO_STRESS_MIN_ROUTE_LIQUIDITY_USD || "10000");
const CURVE_MAX_POOLS_PER_PAIR = Number(process.env.MORPHO_STRESS_CURVE_MAX_POOLS_PER_PAIR || "1");

const TOKENS = {
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  PYUSD: "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8",
  rUSD: "0x09D4214C03D01F49544C0448DBE3A27f768F2b34",
  EURCV: "0x5F7827FDeb7c20b443265Fc2F40845B715385Ff2",
  crvUSD: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
  FRAX: "0x853d955aCEf822Db058eb8505911ED77F175b99e",
};

const ERC20 = new ethers.Interface([
  "function asset() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function symbol() view returns (string)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const FACTORY = new ethers.Interface(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)"]);
const QUOTER = new ethers.Interface([
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
  "function quoteExactOutput(bytes path,uint256 amountOut) returns (uint256 amountIn,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
const CURVE_INT128 = new ethers.Interface(["function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)"]);
const CURVE_UINT256 = new ethers.Interface(["function get_dy(uint256 i,uint256 j,uint256 dx) view returns (uint256)"]);
const MORPHO_IFACE = new ethers.Interface([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function position(bytes32 id,address user) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)",
]);
const ORACLE = new ethers.Interface(["function price() view returns (uint256)"]);

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
  const addr = normalizeAddress(value);
  return addr ? addr.toLowerCase() : null;
}

function sameAddress(a, b) {
  return lowerAddress(a) === lowerAddress(b);
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 12_000) {
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
  for (const url of loadRpcUrls()) {
    try {
      if (Number(BigInt(await rpcCall(url, "eth_chainId", [], 6000))) === 1) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
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
  const eth = await fetchJson("https://coins.llama.fi/prices/current/coingecko:ethereum", { timeoutMs: 20_000 }).catch(() => null);
  const ethPrice = Number(eth?.coins?.["coingecko:ethereum"]?.price || 0);
  if (ethPrice > 0) out.set(TOKENS.WETH.toLowerCase(), ethPrice);
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

function toAssetsDown(shares, totalAssets, totalShares) {
  return mulDivDown(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
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

function lltvRawFromRatio(ratio) {
  const n = Number(ratio || 0);
  if (!(n > 0)) return 0n;
  return ethers.parseUnits(n.toFixed(18), 18);
}

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined) return null;
  try { return Number(ethers.formatUnits(toBigInt(raw), Number(decimals))); } catch (_) { return null; }
}

function decimalToUnits(value, decimals) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const places = Math.min(Math.max(Number(decimals) || 18, 0), 18);
  const fixed = n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: places });
  try { return ethers.parseUnits(fixed, Number(decimals) || 18); } catch (_) { return null; }
}

function bpsDiff(reference, observed) {
  const ref = Number(reference || 0);
  const obs = Number(observed || 0);
  if (!(ref > 0) || !(obs > 0)) return null;
  return ((obs / ref) - 1) * 10_000;
}

function routeLabel(tokens, fees) {
  const parts = [];
  for (let i = 0; i < tokens.length; i++) {
    parts.push(tokens[i].slice(0, 8));
    if (i < fees.length) parts.push(String(fees[i]));
  }
  return parts.join("-");
}

function encodePath(tokens, fees, exactOutput = false) {
  const pathTokens = exactOutput ? [...tokens].reverse() : tokens;
  const pathFees = exactOutput ? [...fees].reverse() : fees;
  const types = [];
  const values = [];
  for (let i = 0; i < pathTokens.length; i++) {
    types.push("address");
    values.push(pathTokens[i]);
    if (i < pathFees.length) {
      types.push("uint24");
      values.push(pathFees[i]);
    }
  }
  return ethers.solidityPacked(types, values);
}

const poolCache = new Map();
const curveDyCache = new Map();
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

async function buildPathCandidates(provider, tokenIn, tokenOut, intermediates) {
  const input = normalizeAddress(tokenIn);
  const output = normalizeAddress(tokenOut);
  if (!input || !output) return [];
  if (sameAddress(input, output)) return [{ tokens: [input, output], fees: [0], directSameToken: true, label: "same-token" }];
  const mids = [...new Set(intermediates.map(normalizeAddress).filter(Boolean).map((x) => x.toLowerCase()))]
    .filter((x) => !sameAddress(x, input) && !sameAddress(x, output))
    .map((x) => ethers.getAddress(x));
  const candidates = [];
  for (const fee of FEES) {
    const pool = await getPool(provider, input, output, fee);
    if (pool) candidates.push({ tokens: [input, output], fees: [fee], pools: [pool], label: routeLabel([input, output], [fee]) });
  }
  for (const mid of mids) {
    for (const fee1 of FEES) {
      const pool1 = await getPool(provider, input, mid, fee1);
      if (!pool1) continue;
      for (const fee2 of FEES) {
        const pool2 = await getPool(provider, mid, output, fee2);
        if (!pool2) continue;
        candidates.push({ tokens: [input, mid, output], fees: [fee1, fee2], pools: [pool1, pool2], label: routeLabel([input, mid, output], [fee1, fee2]) });
      }
    }
  }
  return candidates.slice(0, Number(process.env.MORPHO_STRESS_MAX_PATHS || "80"));
}

async function quoteExactOutputRouted(provider, tokenIn, tokenOut, amountOut, intermediates) {
  if (toBigInt(amountOut) <= 0n) return null;
  if (sameAddress(tokenIn, tokenOut)) return { amountInRaw: amountOut, amountOutRaw: amountOut, gasEstimate: 0n, path: { tokens: [normalizeAddress(tokenIn), normalizeAddress(tokenOut)], fees: [0], label: "same-token" } };
  const paths = await buildPathCandidates(provider, tokenIn, tokenOut, intermediates);
  let best = null;
  for (const p of paths) {
    if (p.directSameToken) continue;
    const raw = await provider.call({
      to: UNISWAP_V3_QUOTER_V2,
      data: QUOTER.encodeFunctionData("quoteExactOutput", [encodePath(p.tokens, p.fees, true), amountOut]),
    }).catch(() => null);
    if (!raw) continue;
    try {
      const [amountIn, , , gasEstimate] = QUOTER.decodeFunctionResult("quoteExactOutput", raw);
      if (!best || amountIn < best.amountInRaw) best = { amountInRaw: amountIn, amountOutRaw: amountOut, gasEstimate, path: p };
    } catch (_) {}
  }
  return best;
}

async function quoteExactInputRouted(provider, tokenIn, tokenOut, amountIn, intermediates) {
  if (toBigInt(amountIn) <= 0n) return null;
  if (sameAddress(tokenIn, tokenOut)) return { amountInRaw: amountIn, amountOutRaw: amountIn, gasEstimate: 0n, path: { tokens: [normalizeAddress(tokenIn), normalizeAddress(tokenOut)], fees: [0], label: "same-token" } };
  const paths = await buildPathCandidates(provider, tokenIn, tokenOut, intermediates);
  let best = null;
  for (const p of paths) {
    if (p.directSameToken) continue;
    const raw = await provider.call({
      to: UNISWAP_V3_QUOTER_V2,
      data: QUOTER.encodeFunctionData("quoteExactInput", [encodePath(p.tokens, p.fees, false), amountIn]),
    }).catch(() => null);
    if (!raw) continue;
    try {
      const [amountOut, , , gasEstimate] = QUOTER.decodeFunctionResult("quoteExactInput", raw);
      if (!best || amountOut > best.amountOutRaw) best = { amountInRaw: amountIn, amountOutRaw: amountOut, gasEstimate, path: p };
    } catch (_) {}
  }
  return best;
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

function rescaleAmount(amount, fromDecimals, toDecimals) {
  const value = toBigInt(amount, 0n);
  const from = BigInt(Math.max(Number(fromDecimals) || 18, 0));
  const to = BigInt(Math.max(Number(toDecimals) || 18, 0));
  if (to >= from) return value * (10n ** (to - from));
  return value / (10n ** (from - to));
}

async function quoteCurveExactInput(provider, curvePools, tokenIn, tokenOut, amountIn) {
  let best = null;
  for (const pool of findCurvePools(curvePools, tokenIn, tokenOut)) {
    const amountOut = await curveGetDy(provider, pool, pool.i.index, pool.j.index, amountIn).catch(() => null);
    if (!amountOut || amountOut <= 0n) continue;
    if (!best || amountOut > best.amountOutRaw) {
      best = {
        source: pool.source,
        pool: pool.address,
        name: pool.name,
        amountInRaw: toBigInt(amountIn),
        amountOutRaw: amountOut,
        gasEstimate: 0n,
        coinIn: pool.i,
        coinOut: pool.j,
      };
    }
  }
  return best;
}

async function quoteCurveExactOutput(provider, curvePools, tokenIn, tokenOut, amountOut) {
  let best = null;
  for (const pool of findCurvePools(curvePools, tokenIn, tokenOut)) {
    const target = toBigInt(amountOut, 0n);
    if (target <= 0n) continue;
    let low = 0n;
    let high = rescaleAmount(target, pool.j.decimals, pool.i.decimals) * 2n + 1n;
    let dy = await curveGetDy(provider, pool, pool.i.index, pool.j.index, high).catch(() => null);
    let expansions = 0;
    while ((!dy || dy < target) && expansions < 16) {
      high *= 2n;
      dy = await curveGetDy(provider, pool, pool.i.index, pool.j.index, high).catch(() => null);
      expansions++;
    }
    if (!dy || dy < target) continue;
    for (let step = 0; step < 28 && high - low > 1n; step++) {
      const mid = (low + high) / 2n;
      const out = await curveGetDy(provider, pool, pool.i.index, pool.j.index, mid).catch(() => null);
      if (out && out >= target) high = mid;
      else low = mid;
    }
    const finalOut = await curveGetDy(provider, pool, pool.i.index, pool.j.index, high).catch(() => null);
    if (!finalOut || finalOut < target) continue;
    if (!best || high < best.amountInRaw) {
      best = {
        source: pool.source,
        pool: pool.address,
        name: pool.name,
        amountInRaw: high,
        amountOutRaw: target,
        gasEstimate: 0n,
        coinIn: pool.i,
        coinOut: pool.j,
      };
    }
  }
  return best;
}

function stableHopCandidates(tokenIn, tokenOut, intermediates) {
  if (!sameAddress(tokenIn, TOKENS.PYUSD) && !sameAddress(tokenOut, TOKENS.PYUSD)) return [];
  const stables = [TOKENS.USDC, TOKENS.USDT, TOKENS.DAI, TOKENS.PYUSD, TOKENS.crvUSD, TOKENS.FRAX, TOKENS.rUSD, TOKENS.EURCV];
  return [...new Set(stables.map(normalizeAddress).filter(Boolean).map((x) => x.toLowerCase()))]
    .map((x) => ethers.getAddress(x))
    .filter((mid) => !sameAddress(mid, tokenIn) && !sameAddress(mid, tokenOut));
}

async function quoteBestAcquisitionExactOutput(provider, curvePools, tokenIn, tokenOut, amountOut, intermediates) {
  const candidates = [];
  const uni = await quoteExactOutputRouted(provider, tokenIn, tokenOut, amountOut, intermediates).catch(() => null);
  if (uni) candidates.push({ ...uni, source: "Uniswap V3 routed exact-output", pathKind: "uniswap-v3" });
  for (const mid of stableHopCandidates(tokenIn, tokenOut, intermediates)) {
    if (findCurvePools(curvePools, tokenIn, mid).length === 0) continue;
    const uniTail = await quoteExactOutputRouted(provider, mid, tokenOut, amountOut, intermediates).catch(() => null);
    if (!uniTail) continue;
    const curveHead = await quoteCurveExactOutput(provider, curvePools, tokenIn, mid, uniTail.amountInRaw).catch(() => null);
    if (!curveHead) continue;
    candidates.push({
      source: "Curve stable-hop + Uniswap V3 exact-output",
      pathKind: "curve-to-uniswap-v3",
      amountInRaw: curveHead.amountInRaw,
      amountOutRaw: amountOut,
      gasEstimate: toBigInt(uniTail.gasEstimate) + toBigInt(curveHead.gasEstimate),
      path: {
        label: `${curveHead.coinIn.symbol || curveHead.coinIn.address.slice(0, 8)}->${curveHead.coinOut.symbol || curveHead.coinOut.address.slice(0, 8)}::${uniTail.path?.label || "uni"}`,
        legs: [
          { source: curveHead.source, pool: curveHead.pool, name: curveHead.name, tokenIn: curveHead.coinIn.address, tokenOut: curveHead.coinOut.address, amountInRaw: curveHead.amountInRaw.toString(), amountOutRaw: curveHead.amountOutRaw.toString() },
          { source: "Uniswap V3", path: uniTail.path, amountInRaw: uniTail.amountInRaw.toString(), amountOutRaw: uniTail.amountOutRaw.toString() },
        ],
      },
    });
  }
  candidates.sort((a, b) => (a.amountInRaw < b.amountInRaw ? -1 : a.amountInRaw > b.amountInRaw ? 1 : 0));
  return candidates[0] || null;
}

async function quoteBestExitExactInput(provider, curvePools, tokenIn, tokenOut, amountIn, intermediates) {
  const candidates = [];
  const uni = await quoteExactInputRouted(provider, tokenIn, tokenOut, amountIn, intermediates).catch(() => null);
  if (uni) candidates.push({ ...uni, source: "Uniswap V3 routed exact-input", pathKind: "uniswap-v3" });
  for (const mid of stableHopCandidates(tokenIn, tokenOut, intermediates)) {
    if (findCurvePools(curvePools, mid, tokenOut).length === 0) continue;
    const uniHead = await quoteExactInputRouted(provider, tokenIn, mid, amountIn, intermediates).catch(() => null);
    if (!uniHead) continue;
    const curveTail = await quoteCurveExactInput(provider, curvePools, mid, tokenOut, uniHead.amountOutRaw).catch(() => null);
    if (!curveTail) continue;
    candidates.push({
      source: "Uniswap V3 + Curve stable-hop exact-input",
      pathKind: "uniswap-v3-to-curve",
      amountInRaw: amountIn,
      amountOutRaw: curveTail.amountOutRaw,
      gasEstimate: toBigInt(uniHead.gasEstimate) + toBigInt(curveTail.gasEstimate),
      path: {
        label: `${uniHead.path?.label || "uni"}::${curveTail.coinIn.symbol || curveTail.coinIn.address.slice(0, 8)}->${curveTail.coinOut.symbol || curveTail.coinOut.address.slice(0, 8)}`,
        legs: [
          { source: "Uniswap V3", path: uniHead.path, amountInRaw: uniHead.amountInRaw.toString(), amountOutRaw: uniHead.amountOutRaw.toString() },
          { source: curveTail.source, pool: curveTail.pool, name: curveTail.name, tokenIn: curveTail.coinIn.address, tokenOut: curveTail.coinOut.address, amountInRaw: curveTail.amountInRaw.toString(), amountOutRaw: curveTail.amountOutRaw.toString() },
        ],
      },
    });
  }
  candidates.sort((a, b) => (a.amountOutRaw > b.amountOutRaw ? -1 : a.amountOutRaw < b.amountOutRaw ? 1 : 0));
  return candidates[0] || null;
}

async function fetchMorphoMarketAndPositions(marketId) {
  const query = `query($chainId: Int!, $marketId: String!, $first: Int!) {
    marketById(chainId: $chainId, marketId: $marketId) {
      marketId
      loanAsset { symbol address decimals }
      collateralAsset { symbol address decimals }
      oracle { address }
      irmAddress
      lltv
      state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization }
    }
    marketPositions(first: $first, orderBy: BorrowShares, orderDirection: Desc,
      where: { chainId_in: [$chainId], marketUniqueKey_in: [$marketId], borrowShares_gte: "1" }) {
      items {
        user { address }
        healthFactor
        priceVariationToLiquidationPrice
        state { collateral collateralUsd borrowAssets borrowAssetsUsd borrowShares marginUsd }
      }
    }
  }`;
  const json = await fetchJson("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { chainId: 1, marketId, first: MAX_POSITIONS_PER_MARKET } }),
    timeoutMs: 30_000,
  }).catch(() => null);
  if (!json || json.errors) return { market: null, positions: [], error: json?.errors?.[0]?.message || "Morpho GraphQL unavailable" };
  return { market: json.data?.marketById || null, positions: json.data?.marketPositions?.items || [], error: null };
}

async function readMarketState(provider, marketId) {
  const raw = await provider.call({ to: MORPHO, data: MORPHO_IFACE.encodeFunctionData("market", [marketId]) }).catch(() => null);
  if (!raw) return null;
  try {
    const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = MORPHO_IFACE.decodeFunctionResult("market", raw);
    return { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee, liquidityAssets: totalSupplyAssets > totalBorrowAssets ? totalSupplyAssets - totalBorrowAssets : 0n };
  } catch (_) {
    return null;
  }
}

async function readOnchainPosition(provider, marketId, borrower) {
  const raw = await provider.call({ to: MORPHO, data: MORPHO_IFACE.encodeFunctionData("position", [marketId, borrower]) }).catch(() => null);
  if (!raw) return null;
  try {
    const [supplyShares, borrowShares, collateral] = MORPHO_IFACE.decodeFunctionResult("position", raw);
    return { supplyShares, borrowShares, collateral };
  } catch (_) {
    return null;
  }
}

async function probeWrapper(provider, collateral, decimals, prices) {
  const one = 10n ** BigInt(Math.min(Number(decimals) || 18, 36));
  const [asset, totalSupply, totalAssets, convertToAssets, previewRedeem, maxRedeemZero] = await Promise.all([
    safeCall(provider, collateral, ERC20, "asset"),
    safeCall(provider, collateral, ERC20, "totalSupply"),
    safeCall(provider, collateral, ERC20, "totalAssets"),
    safeCall(provider, collateral, ERC20, "convertToAssets", [one]),
    safeCall(provider, collateral, ERC20, "previewRedeem", [one]),
    safeCall(provider, collateral, ERC20, "maxRedeem", [ZERO]),
  ]);
  const assetAddr = normalizeAddress(asset);
  const assetDecimals = assetAddr ? await safeCall(provider, assetAddr, ERC20, "decimals").then((x) => x === null ? null : Number(x)).catch(() => null) : null;
  const assetPriceUsd = assetAddr ? priceOf(prices, assetAddr, null) : null;
  const convertHuman = convertToAssets !== null && assetDecimals !== null ? formatUnitsNumber(convertToAssets, assetDecimals) : null;
  const previewHuman = previewRedeem !== null && assetDecimals !== null ? formatUnitsNumber(previewRedeem, assetDecimals) : null;
  return {
    erc4626Like: Boolean(assetAddr && (convertToAssets !== null || previewRedeem !== null)),
    asset: assetAddr,
    assetDecimals,
    assetPriceUsd,
    totalSupplyRaw: totalSupply?.toString() || null,
    totalAssetsRaw: totalAssets?.toString() || null,
    convertOneShareToAssetsRaw: convertToAssets?.toString() || null,
    previewRedeemOneShareRaw: previewRedeem?.toString() || null,
    maxRedeemZeroRaw: maxRedeemZero?.toString() || null,
    convertOneShareToAssets: convertHuman,
    previewRedeemOneShare: previewHuman,
    redemptionProbe: assetAddr ? "view-only" : "not-erc4626-or-unsupported-view",
  };
}

function selectRows(focused) {
  const rows = (focused?.rows || []).filter((r) => Number(r.chainId) === 1 && r.protocol === "Morpho Blue");
  const prioritySymbols = new Set(["SolvBTC", "PRIME", "wJAAA", "wsrUSD", "EUTBL", "PT-USDG-28MAY2026", "PWrUSDC-hyper"]);
  const directQuoteRows = rows.filter((r) => r.economics?.directUniswapV3ExactOutputQuote);
  const priority = rows.filter((r) => prioritySymbols.has(r.collateral?.symbol));
  const highLiquidity = rows.filter((r) => Number(r.morpho?.routeLiquidityUsd || 0) >= MIN_ROUTE_LIQUIDITY_USD)
    .sort((a, b) => Number(b.morpho?.routeLiquidityUsd || 0) - Number(a.morpho?.routeLiquidityUsd || 0));
  const seen = new Set();
  const out = [];
  for (const row of [...directQuoteRows, ...priority, ...highLiquidity]) {
    const key = `${lowerAddress(row.collateral?.address)}:${lowerAddress(row.loanAsset?.address)}:${row.marketId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}

function buildIntermediates(row, wrapper) {
  const values = [
    TOKENS.WETH,
    TOKENS.WBTC,
    TOKENS.USDC,
    TOKENS.USDT,
    TOKENS.DAI,
    TOKENS.PYUSD,
    TOKENS.rUSD,
    TOKENS.EURCV,
    wrapper?.asset,
    row.loanAsset?.address,
    row.collateral?.address,
  ];
  return [...new Set(values.map(normalizeAddress).filter(Boolean).map((x) => x.toLowerCase()))].map((x) => ethers.getAddress(x));
}

async function scoreAcquisitionLadder(provider, row, market, marketState, oraclePrice, prices, gasUsd, intermediates, curvePools) {
  const loan = normalizeAddress(row.loanAsset?.address || market?.loanAsset?.address);
  const collateral = normalizeAddress(row.collateral?.address || market?.collateralAsset?.address);
  const loanDecimals = Number(row.loanAsset?.decimals ?? market?.loanAsset?.decimals ?? 18);
  const collateralDecimals = Number(row.collateral?.decimals ?? market?.collateralAsset?.decimals ?? 18);
  const loanPriceUsd = priceOf(prices, loan, row.loanAsset?.priceUsd);
  const collateralPriceUsd = priceOf(prices, collateral, row.collateral?.priceUsd || row.economics?.referenceUsdPerCollateral);
  const lltv = Number(row.morpho?.lltv || row.ltv || (market?.lltv ? Number(BigInt(market.lltv)) / 1e18 : 0));
  const availableLoanRaw = marketState?.liquidityAssets || decimalToUnits(Number(row.morpho?.routeLiquidityUsd || 0) / Number(loanPriceUsd || 1), loanDecimals) || 0n;
  const availableLoanUsd = loanPriceUsd ? formatUnitsNumber(availableLoanRaw, loanDecimals) * loanPriceUsd : Number(row.morpho?.routeLiquidityUsd || 0);
  const oneCollateral = 10n ** BigInt(collateralDecimals);
  const acceptedLoanPerCollateralRaw = oraclePrice > 0n ? mulDivDown(oneCollateral, oraclePrice, ORACLE_PRICE_SCALE) : 0n;
  const acceptedLoanPerCollateral = formatUnitsNumber(acceptedLoanPerCollateralRaw, loanDecimals);
  const acceptedUsdPerCollateral = acceptedLoanPerCollateral && loanPriceUsd ? acceptedLoanPerCollateral * loanPriceUsd : null;
  const referenceUsdPerCollateral = collateralPriceUsd || row.economics?.referenceUsdPerCollateral || null;
  const acceptedVsReferenceBps = bpsDiff(referenceUsdPerCollateral, acceptedUsdPerCollateral);
  const ltvBreakEvenPremiumBps = lltv > 0 ? ((1 / lltv) - 1) * 10_000 : null;
  const results = [];
  for (const fraction of SIZE_FRACTIONS) {
    const borrowUsd = Number(availableLoanUsd || 0) * fraction;
    const borrowRaw = decimalToUnits(loanPriceUsd ? borrowUsd / loanPriceUsd : 0, loanDecimals);
    const collateralNeeded = acceptedUsdPerCollateral && lltv > 0 ? borrowUsd / (acceptedUsdPerCollateral * lltv) : null;
    const collateralNeededRaw = decimalToUnits(collateralNeeded, collateralDecimals);
    let quote = null;
    if (collateralNeededRaw && collateralNeededRaw > 0n && loan && collateral) {
      quote = await quoteBestAcquisitionExactOutput(provider, curvePools, loan, collateral, collateralNeededRaw, intermediates).catch(() => null);
    }
    const quoteLoanIn = quote ? formatUnitsNumber(quote.amountInRaw, loanDecimals) : null;
    const quoteAcquisitionUsd = quoteLoanIn !== null && loanPriceUsd ? quoteLoanIn * loanPriceUsd : null;
    const quoteAcquisitionUsdPerCollateral = quoteAcquisitionUsd !== null && collateralNeeded ? quoteAcquisitionUsd / collateralNeeded : null;
    const acceptedVsQuoteBps = bpsDiff(quoteAcquisitionUsdPerCollateral, acceptedUsdPerCollateral);
    const gasBps = borrowUsd > 0 && gasUsd ? gasUsd / borrowUsd * 10_000 : null;
    const requiredPremiumBps = ltvBreakEvenPremiumBps === null ? null : ltvBreakEvenPremiumBps + SLIPPAGE_BPS + Number(gasBps || 0);
    const grossEdgeUsd = quoteAcquisitionUsd === null ? null : borrowUsd - quoteAcquisitionUsd;
    const slippageUsd = borrowUsd * SLIPPAGE_BPS / 10_000;
    const netEdgeUsd = grossEdgeUsd === null ? null : grossEdgeUsd - slippageUsd - Number(gasUsd || 0);
    const gapToRequiredBps = acceptedVsQuoteBps !== null && requiredPremiumBps !== null ? requiredPremiumBps - acceptedVsQuoteBps : null;
    const routePositive = Boolean(quote && acceptedVsQuoteBps !== null && requiredPremiumBps !== null && acceptedVsQuoteBps >= requiredPremiumBps && netEdgeUsd !== null && netEdgeUsd > 0);
    results.push({
      fraction,
      borrowUsd,
      borrowRaw: borrowRaw?.toString() || null,
      collateralNeeded,
      collateralNeededRaw: collateralNeededRaw?.toString() || null,
      quote: quote ? {
        source: quote.source || "Uniswap V3 routed exact-output",
        pathKind: quote.pathKind || "uniswap-v3",
        amountInRaw: quote.amountInRaw.toString(),
        amountIn: quoteLoanIn,
        gasEstimate: quote.gasEstimate?.toString() || null,
        path: quote.path,
        quoteAcquisitionUsdPerCollateral,
      } : null,
      acceptedVsQuoteBps,
      requiredPremiumBps,
      gapToRequiredBps,
      grossEdgeUsd,
      slippageUsd,
      gasUsd,
      netEdgeUsd,
      routePositive,
      blockers: [
        quote ? null : "No routed Uniswap V3 exact-output acquisition quote for this size",
        acceptedVsQuoteBps === null ? "Missing accepted-vs-quote premium" : null,
        gapToRequiredBps !== null && gapToRequiredBps > 0 ? `Needs quote improvement of ${gapToRequiredBps.toFixed(2)}bps` : null,
        netEdgeUsd !== null && netEdgeUsd > 0 ? null : "Net acquisition-borrow edge is not positive",
      ].filter(Boolean),
    });
  }
  results.sort((a, b) => Number(b.netEdgeUsd ?? -Infinity) - Number(a.netEdgeUsd ?? -Infinity));
  return {
    loanPriceUsd,
    collateralPriceUsd,
    acceptedLoanPerCollateral,
    acceptedUsdPerCollateral,
    referenceUsdPerCollateral,
    acceptedVsReferenceBps,
    lltv,
    ltvBreakEvenPremiumBps,
    availableLoanRaw: availableLoanRaw.toString(),
    availableLoanUsd,
    sizeResults: results,
    best: results[0] || null,
  };
}

async function scoreLiquidations(provider, row, market, positions, marketState, oraclePrice, prices, gasUsd, intermediates, curvePools) {
  const loan = normalizeAddress(row.loanAsset?.address || market?.loanAsset?.address);
  const collateral = normalizeAddress(row.collateral?.address || market?.collateralAsset?.address);
  const loanDecimals = Number(row.loanAsset?.decimals ?? market?.loanAsset?.decimals ?? 18);
  const collateralDecimals = Number(row.collateral?.decimals ?? market?.collateralAsset?.decimals ?? 18);
  const loanPriceUsd = priceOf(prices, loan, row.loanAsset?.priceUsd);
  const lltvRaw = market?.lltv ? toBigInt(market.lltv) : lltvRawFromRatio(row.morpho?.lltv || row.ltv);
  const lifRaw = liquidationIncentiveFactorRaw(lltvRaw);
  const current = [];
  const dormant = [];
  const shockBuckets = Object.fromEntries(SHOCKS.map((s) => [String(s), 0]));
  for (const pos of positions || []) {
    const hf = Number(pos.healthFactor || 0);
    if (!(hf > 0)) continue;
    const dropToLiquidationPct = hf > 1 ? Math.max(0, (1 - 1 / hf) * 100) : 0;
    for (const shock of SHOCKS) if (hf * (1 - shock / 100) < 1) shockBuckets[String(shock)] += 1;
    const base = {
      borrower: normalizeAddress(pos.user?.address),
      healthFactor: hf,
      dropToLiquidationPct,
      borrowAssetsUsd: Number(pos.state?.borrowAssetsUsd || 0),
      collateralUsd: Number(pos.state?.collateralUsd || 0),
      graphBorrowShares: pos.state?.borrowShares || null,
    };
    if (hf >= 1) {
      dormant.push(base);
      continue;
    }
    if (!base.borrower || !marketState || marketState.totalBorrowShares <= 0n || oraclePrice <= 0n || !loanPriceUsd) {
      current.push({ ...base, routePositive: false, blockers: ["Missing on-chain market, oracle, borrower, or loan price data"] });
      continue;
    }
    const onchain = await readOnchainPosition(provider, row.marketId, base.borrower);
    if (!onchain || onchain.borrowShares <= 0n || onchain.collateral <= 0n) {
      current.push({ ...base, routePositive: false, blockers: ["On-chain position unavailable or no repayable debt/collateral"] });
      continue;
    }
    const repaidAssets = toAssetsUp(onchain.borrowShares, marketState.totalBorrowAssets, marketState.totalBorrowShares);
    const seizedCollateral = mulDivDown(mulDivDown(repaidAssets, lifRaw, WAD), ORACLE_PRICE_SCALE, oraclePrice);
    const seizedExceedsCollateral = seizedCollateral > onchain.collateral;
    const quote = seizedExceedsCollateral ? null : await quoteBestExitExactInput(provider, curvePools, collateral, loan, seizedCollateral, intermediates).catch(() => null);
    const expectedLoanOutRaw = quote?.amountOutRaw || 0n;
    const borrowUsd = formatUnitsNumber(repaidAssets, loanDecimals) * loanPriceUsd;
    const expectedLoanOutUsd = formatUnitsNumber(expectedLoanOutRaw, loanDecimals) * loanPriceUsd;
    const grossProfitUsd = expectedLoanOutUsd - borrowUsd;
    const netProfitUsd = grossProfitUsd - Number(gasUsd || 0);
    const routePositive = Boolean(quote && !seizedExceedsCollateral && expectedLoanOutRaw > repaidAssets && netProfitUsd > 0);
    current.push({
      ...base,
      repaidAssetsRaw: repaidAssets.toString(),
      seizedCollateralRaw: seizedCollateral.toString(),
      seizedExceedsCollateral,
      liquidationIncentiveFactor: Number(lifRaw) / 1e18,
      quote: quote ? {
        source: quote.source || "Uniswap V3 routed exact-input",
        pathKind: quote.pathKind || "uniswap-v3",
        amountOutRaw: quote.amountOutRaw.toString(),
        amountOut: formatUnitsNumber(quote.amountOutRaw, loanDecimals),
        gasEstimate: quote.gasEstimate?.toString() || null,
        path: quote.path,
      } : null,
      expectedLoanOutUsd,
      borrowUsd,
      grossProfitUsd,
      gasUsd,
      netProfitUsd,
      routePositive,
      blockers: [
        seizedExceedsCollateral ? "Full repay would over-seize collateral" : null,
        quote ? null : "No routed Uniswap V3 collateral-exit quote",
        expectedLoanOutRaw > repaidAssets ? null : "Exit quote does not cover repay assets",
        netProfitUsd > 0 ? null : "Liquidation net profit is not positive",
      ].filter(Boolean),
    });
  }
  current.sort((a, b) => Number(b.netProfitUsd ?? -Infinity) - Number(a.netProfitUsd ?? -Infinity));
  dormant.sort((a, b) => a.dropToLiquidationPct - b.dropToLiquidationPct);
  return {
    positionsSampled: positions?.length || 0,
    currentLiquidatable: current.length,
    currentRoutePositive: current.filter((p) => p.routePositive).length,
    shockBuckets,
    nearestDormant: dormant.slice(0, 5),
    current: current.slice(0, 5),
  };
}

async function enrichRow(provider, row, prices, gas, curvePools) {
  const collateral = normalizeAddress(row.collateral?.address);
  const loan = normalizeAddress(row.loanAsset?.address);
  const [graph, marketState, oracleRaw] = await Promise.all([
    fetchMorphoMarketAndPositions(row.marketId),
    readMarketState(provider, row.marketId),
    safeCall(provider, row.oracle, ORACLE, "price"),
  ]);
  const wrapper = await probeWrapper(provider, collateral, Number(row.collateral?.decimals || 18), prices);
  const intermediates = buildIntermediates(row, wrapper);
  const loanPriceUsd = priceOf(prices, loan, row.loanAsset?.priceUsd);
  const gasUsdAcquisition = loanPriceUsd && gas.ethPriceUsd ? gas.acquisitionGasUsd : null;
  const gasUsdLiquidation = loanPriceUsd && gas.ethPriceUsd ? gas.liquidationGasUsd : null;
  const oraclePrice = toBigInt(oracleRaw, 0n);
  const acquisition = await scoreAcquisitionLadder(provider, row, graph.market, marketState, oraclePrice, prices, gasUsdAcquisition, intermediates, curvePools).catch((err) => ({ error: err.message || String(err), sizeResults: [], best: null }));
  const liquidation = await scoreLiquidations(provider, row, graph.market, graph.positions, marketState, oraclePrice, prices, gasUsdLiquidation, intermediates, curvePools).catch((err) => ({ error: err.message || String(err), positionsSampled: 0, currentLiquidatable: 0, currentRoutePositive: 0 }));
  const best = acquisition.best || null;
  const routePositive = Boolean((best && best.routePositive) || liquidation.currentRoutePositive > 0);
  const bestGap = best?.gapToRequiredBps;
  const watchCandidate = Boolean(!routePositive && best && best.quote && bestGap !== null && bestGap >= 0 && bestGap <= WATCH_GAP_BPS);
  return {
    protocol: row.protocol,
    chain: row.chain,
    chainId: row.chainId,
    marketId: row.marketId,
    oracle: row.oracle,
    collateral: row.collateral,
    loanAsset: row.loanAsset,
    morphoGraphql: graph.error ? { error: graph.error } : {
      irm: graph.market?.irmAddress || null,
      lltvRaw: graph.market?.lltv || null,
      liquidityAssetsUsd: Number(graph.market?.state?.liquidityAssetsUsd || row.morpho?.routeLiquidityUsd || 0),
      supplyAssetsUsd: Number(graph.market?.state?.supplyAssetsUsd || row.morpho?.supplyAssetsUsd || 0),
      borrowAssetsUsd: Number(graph.market?.state?.borrowAssetsUsd || row.morpho?.borrowAssetsUsd || 0),
      utilization: graph.market?.state?.utilization ?? row.morpho?.utilization ?? null,
    },
    onchainMarket: marketState ? {
      totalSupplyAssetsRaw: marketState.totalSupplyAssets.toString(),
      totalBorrowAssetsRaw: marketState.totalBorrowAssets.toString(),
      totalBorrowSharesRaw: marketState.totalBorrowShares.toString(),
      liquidityAssetsRaw: marketState.liquidityAssets.toString(),
      lastUpdate: marketState.lastUpdate.toString(),
      fee: marketState.fee.toString(),
    } : null,
    oraclePriceRaw: oraclePrice > 0n ? oraclePrice.toString() : null,
    wrapper,
    routedIntermediates: intermediates,
    acquisitionStress: acquisition,
    liquidationStress: liquidation,
    watchCandidate,
    routePositive,
    signedActionJustified: false,
    blockers: [
      routePositive ? null : "No current route-positive acquisition-borrow or liquidation route",
      best?.quote ? null : "No best routed exact-output acquisition quote",
      liquidation.currentRoutePositive > 0 ? null : "No current profitable liquidation route in sampled positions",
      "Fork proof and signed-action authorization absent",
    ].filter(Boolean),
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const focused = readJson(IN_FILE, null);
  if (!focused) throw new Error(`missing input artifact ${path.relative(WORKSPACE, IN_FILE)}`);
  const rpc = await resolveEthereumRpc();
  if (!rpc) throw new Error("missing ethereum rpc");
  const provider = new ethers.JsonRpcProvider(rpc);
  const block = await provider.getBlock("latest");
  const rows = selectRows(focused);
  const priceAddresses = [];
  for (const row of rows) {
    priceAddresses.push(row.collateral?.address, row.loanAsset?.address, row.erc4626?.asset, ...Object.values(TOKENS));
  }
  const prices = await fetchPrices(priceAddresses.filter(Boolean));
  const curvePools = await fetchCurvePools().catch(() => []);
  const gasPriceWei = await provider.send("eth_gasPrice", []).then(BigInt).catch(() => 0n);
  const ethPriceUsd = priceOf(prices, TOKENS.WETH, null);
  const gas = {
    gasPriceWei: gasPriceWei.toString(),
    ethPriceUsd,
    acquisitionGasUsd: ethPriceUsd && gasPriceWei > 0n ? ACQUISITION_GAS_UNITS * Number(gasPriceWei) / 1e18 * ethPriceUsd : null,
    liquidationGasUsd: ethPriceUsd && gasPriceWei > 0n ? LIQUIDATION_GAS_UNITS * Number(gasPriceWei) / 1e18 * ethPriceUsd : null,
  };
  const results = [];
  for (const row of rows) {
    results.push(await enrichRow(provider, row, prices, gas, curvePools).catch((err) => ({
      marketId: row.marketId,
      collateral: row.collateral,
      loanAsset: row.loanAsset,
      error: err.message || String(err),
      watchCandidate: false,
      routePositive: false,
      signedActionJustified: false,
    })));
  }
  results.sort((a, b) => Number(b.routePositive) - Number(a.routePositive)
    || Number(b.watchCandidate) - Number(a.watchCandidate)
    || Number(b.acquisitionStress?.best?.netEdgeUsd ?? -Infinity) - Number(a.acquisitionStress?.best?.netEdgeUsd ?? -Infinity));

  const routePositive = results.filter((r) => r.routePositive).length;
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/monitor-morpho-exit-liquidity-stress.js",
    scope: "Read-only Morpho high-LLTV routed acquisition and liquidation stress monitor",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    block: { number: block?.number || null, timestamp: block?.timestamp || null, iso: block?.timestamp ? new Date(Number(block.timestamp) * 1000).toISOString() : null },
    thresholds: {
      maxRows: MAX_ROWS,
      minRouteLiquidityUsd: MIN_ROUTE_LIQUIDITY_USD,
      sizeFractions: SIZE_FRACTIONS,
      shocks: SHOCKS,
      slippageBps: SLIPPAGE_BPS,
      watchGapBps: WATCH_GAP_BPS,
      acquisitionGasUnits: ACQUISITION_GAS_UNITS,
      liquidationGasUnits: LIQUIDATION_GAS_UNITS,
      curvePoolsDiscovered: curvePools.length,
    },
    gas,
    summary: {
      rowsInput: rows.length,
      rowsWithRoutedAcquisitionQuote: results.filter((r) => r.acquisitionStress?.sizeResults?.some((s) => s.quote)).length,
      rowsWithCurveStableHopQuote: results.filter((r) => r.acquisitionStress?.sizeResults?.some((s) => s.quote?.pathKind && s.quote.pathKind !== "uniswap-v3")).length,
      rowsWithSampledPositions: results.filter((r) => Number(r.liquidationStress?.positionsSampled || 0) > 0).length,
      currentLiquidatableRows: results.filter((r) => Number(r.liquidationStress?.currentLiquidatable || 0) > 0).length,
      watchCandidates: results.filter((r) => r.watchCandidate).length,
      routePositive,
      signedActionJustified: false,
    },
    results,
    nextRoutePositiveCriteria: [
      "Routed exact-output acquisition quote must cover the modeled collateral size and beat Morpho accepted value after LLTV haircut, gas, and slippage",
      "Or current liquidatable borrower must have an on-chain full-repay liquidation whose routed collateral exit covers repay assets plus gas",
      "Wrapper/redemption views must not contradict transferability or exit assumptions",
      "Fork proof is required before any executor or signed action work",
    ],
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, jsonReplacer, 2) + "\n");
  console.log(`Morpho exit-liquidity stress: rows=${output.summary.rowsInput} routedQuotes=${output.summary.rowsWithRoutedAcquisitionQuote} liquidatableRows=${output.summary.currentLiquidatableRows} watch=${output.summary.watchCandidates} routePositive=${output.summary.routePositive}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT_FILE).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
