#!/usr/bin/env node
// Read-only Curve Iron Bank stable-wrapper route scorer.
// Route model: mint cy/i-token with underlying stable -> Curve swap wrapper -> redeem output wrapper.
// RPC URLs are resolved in memory only and never printed or written.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "curve-ib-stable-wrapper-route.json");
const TIMEOUT_MS = 15_000;
const CHAIN_ID = 1;
const POOL = "0x2dded6Da1BF5DBdF597C45fcFaa3194e53EcfeAF";
const LP_TOKEN = "0x5282a4eF67D9C33135340fB3289cc1711c13638C";
const GAUGE = "0xf5194c3325202f456c95c1cf0ca36f8475c1949f";
const YIELD_POOL_ID = "7e218bc2-186c-473d-af0c-415bcdfe392b";
const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNISWAP_V3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ZERO = ethers.ZeroAddress;
const FEES = [100, 500, 3000, 10000];
const GAS_UNITS = Number(process.env.CURVE_IB_ROUTE_GAS_UNITS || "650000");
const MIN_NET_PROFIT_USD = Number(process.env.CURVE_IB_MIN_NET_PROFIT_USD || "25");
const ROUTE_SLIPPAGE_BUFFER_BPS = BigInt(process.env.CURVE_IB_ROUTE_SLIPPAGE_BUFFER_BPS || "50");
const EXTERNAL_EXIT_MAX_UNISWAP_PATHS = Number(process.env.CURVE_IB_EXTERNAL_EXIT_MAX_UNISWAP_PATHS || "24");
const EXTERNAL_EXIT_CURVE_MAX_POOLS = Number(process.env.CURVE_IB_EXTERNAL_EXIT_CURVE_MAX_POOLS || "2");
const BALANCER_MAX_POOLS_PER_PAIR = Number(process.env.CURVE_IB_BALANCER_MAX_POOLS_PER_PAIR || "3");
const TRADE_SIZES_USD = (process.env.CURVE_IB_TRADE_SIZES_USD || "100,1000,5000,10000,25000")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);

const COINS = [
  { index: 0, symbol: "iDAI", address: "0x8e595470Ed749b85C6F7669de83EAe304C2ec68F", underlyingSymbol: "DAI", underlying: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
  { index: 1, symbol: "iUSDC", address: "0x76Eb2FE28b36B3ee97F3Adae0C69606eeDB2A37c", underlyingSymbol: "USDC", underlying: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { index: 2, symbol: "iUSDT", address: "0x48759F220ED983dB51fA7A8C0D2AAb8f3ce4166a", underlyingSymbol: "USDT", underlying: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
];

const EXTRA_EXIT_TARGETS = [
  { symbol: "FRAX", address: "0x853d955aCEf822Db058eb8505911ED77F175b99e", decimals: 18 },
  { symbol: "crvUSD", address: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E", decimals: 18 },
  { symbol: "PYUSD", address: "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8", decimals: 6 },
  { symbol: "USDe", address: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3", decimals: 18 },
  { symbol: "USDS", address: "0xdC035D45d973E3EC169d2276DDab16f1e407384F", decimals: 18 },
];

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const CTOKEN = new ethers.Interface([
  "function underlying() view returns (address)",
  "function exchangeRateStored() view returns (uint256)",
  "function getCash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function totalReserves() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const CURVE_POOL = new ethers.Interface([
  "function coins(uint256) view returns (address)",
  "function balances(uint256) view returns (uint256)",
  "function fee() view returns (uint256)",
  "function get_virtual_price() view returns (uint256)",
  "function get_dy(int128,int128,uint256) view returns (uint256)",
  "function get_dy_underlying(int128,int128,uint256) view returns (uint256)",
]);
const FACTORY = new ethers.Interface(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)"]);
const QUOTER = new ethers.Interface([
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
const BALANCER = new ethers.Interface([
  "function queryBatchSwap(uint8 kind,(bytes32 poolId,uint256 assetInIndex,uint256 assetOutIndex,uint256 amount,bytes userData)[] swaps,address[] assets,(address sender,bool fromInternalBalance,address recipient,bool toInternalBalance) funds) returns (int256[] assetDeltas)",
]);
const CURVE_INT128 = new ethers.Interface(["function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)"]);
const CURVE_UINT256 = new ethers.Interface(["function get_dy(uint256 i,uint256 j,uint256 dx) view returns (uint256)"]);

const uniPoolCache = new Map();
const curveDyCache = new Map();
const balancerPairCache = new Map();

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
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

function encodePath(tokens, fees) {
  const types = [];
  const values = [];
  for (let i = 0; i < tokens.length; i++) {
    types.push("address");
    values.push(ethers.getAddress(tokens[i]));
    if (i < fees.length) {
      types.push("uint24");
      values.push(Number(fees[i]));
    }
  }
  return ethers.solidityPacked(types, values);
}

function routeLabel(tokens, fees) {
  return tokens.map((token, i) => {
    const addr = normalizeAddress(token) || String(token);
    const fee = i < fees.length ? `-${fees[i]}->` : "";
    return `${addr.slice(0, 10)}${fee}`;
  }).join("");
}

function gasCostUsd(gasUnits, gasPriceWei, ethPriceUsd) {
  const units = Number(toBigInt(gasUnits));
  const priceWei = Number(toBigInt(gasPriceWei));
  if (!Number.isFinite(units) || !Number.isFinite(priceWei) || !Number.isFinite(ethPriceUsd)) return null;
  return (units * priceWei / 1e18) * ethPriceUsd;
}

async function fetchJson(url, { timeoutMs = TIMEOUT_MS } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function loadRpcUrls() {
  const text = fs.readFileSync(RPC_FILE, "utf8");
  return [...text.matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
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
      // Try next endpoint.
    }
  }
  return null;
}

async function safeCall(provider, to, iface, name, args = []) {
  try {
    const raw = await provider.call({ to, data: iface.encodeFunctionData(name, args) });
    return { value: iface.decodeFunctionResult(name, raw), raw };
  } catch (e) {
    return { error: e?.shortMessage || e?.message || "call failed" };
  }
}

function formatAmount(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try {
    return Number(ethers.formatUnits(raw, decimals));
  } catch (_) {
    return null;
  }
}

function parseAmount(amount, decimals) {
  return ethers.parseUnits(Number(amount).toFixed(decimals), decimals);
}

function rawToUsd(raw, decimals, priceUsd) {
  const amount = formatAmount(raw, decimals);
  return Number.isFinite(amount) && Number.isFinite(priceUsd) ? amount * priceUsd : null;
}

async function fetchPrices(addresses) {
  const out = {};
  const unique = [...new Set(addresses.map((a) => ethers.getAddress(a)))];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const coins = chunk.map((a) => `ethereum:${a}`).join(",");
    try {
      const res = await fetch(`https://coins.llama.fi/prices/current/${coins}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) continue;
      const json = await res.json();
      for (const addr of chunk) out[addr.toLowerCase()] = json.coins?.[`ethereum:${addr}`]?.price ?? null;
    } catch (_) {
      for (const addr of chunk) out[addr.toLowerCase()] = null;
    }
  }
  return out;
}

async function fetchYieldMeta() {
  try {
    const res = await fetch("https://yields.llama.fi/pools", { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) return null;
    const json = await res.json();
    return (json.data || []).find((p) => p.pool === YIELD_POOL_ID) || null;
  } catch (_) {
    return null;
  }
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
  const key = `${[a.toLowerCase(), b.toLowerCase()].sort().join(":")}:${fee}`;
  if (uniPoolCache.has(key)) return uniPoolCache.get(key);
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
  uniPoolCache.set(key, pool);
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
        if (candidates.length >= EXTERNAL_EXIT_MAX_UNISWAP_PATHS) return candidates;
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
    .slice(0, EXTERNAL_EXIT_CURVE_MAX_POOLS);
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

async function fetchBalancerPoolsForPair(tokenIn, tokenOut) {
  const a = lowerAddress(tokenIn);
  const b = lowerAddress(tokenOut);
  if (!a || !b || a === b) return [];
  const key = [a, b].sort().join(":");
  if (balancerPairCache.has(key)) return balancerPairCache.get(key);
  const query = `query($tokens: [Bytes!]!) {
    pools(first: ${BALANCER_MAX_POOLS_PER_PAIR}, orderBy: totalLiquidity, orderDirection: desc,
      where: { tokensList_contains: $tokens, totalLiquidity_gt: 0, swapEnabled: true }) {
      id
      address
      symbol
      totalLiquidity
      swapFee
      tokens { address symbol decimals balance }
    }
  }`;
  const endpoints = [
    "https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-v2",
    "https://gateway.thegraph.com/api/subgraphs/id/C4ayEZP2yTXRAB8vSaTrgN4m9anTe9Mdm2ViyiAuV9TV",
  ];
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables: { tokens: [a, b] } }),
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const json = await res.json();
      const rows = (json?.data?.pools || []).map((p) => ({
        id: p.id,
        address: normalizeAddress(p.address),
        symbol: p.symbol || null,
        totalLiquidity: Number(p.totalLiquidity || 0),
        swapFee: p.swapFee || null,
        tokens: (p.tokens || []).map((t) => ({
          address: normalizeAddress(t.address),
          symbol: t.symbol || null,
          decimals: Number(t.decimals || 18),
          balance: t.balance || null,
        })).filter((t) => t.address),
      })).filter((p) => p.id && p.address);
      if (rows.length > 0) {
        balancerPairCache.set(key, rows);
        return rows;
      }
    } catch (_) {
      // Try the next endpoint.
    } finally {
      clearTimeout(timer);
    }
  }
  balancerPairCache.set(key, []);
  return [];
}

async function quoteBalancerExactInput(provider, tokenIn, tokenOut, amountIn) {
  const value = toBigInt(amountIn, 0n);
  if (value <= 0n) return [];
  const pools = await fetchBalancerPoolsForPair(tokenIn, tokenOut).catch(() => []);
  const out = [];
  for (const pool of pools) {
    try {
      const assets = [normalizeAddress(tokenIn), normalizeAddress(tokenOut)];
      const swaps = [{ poolId: pool.id, assetInIndex: 0, assetOutIndex: 1, amount: value, userData: "0x" }];
      const funds = { sender: ZERO, fromInternalBalance: false, recipient: ZERO, toInternalBalance: false };
      const raw = await provider.call({ to: BALANCER_VAULT, data: BALANCER.encodeFunctionData("queryBatchSwap", [0, swaps, assets, funds]) }).catch(() => null);
      if (!raw) continue;
      const [deltas] = BALANCER.decodeFunctionResult("queryBatchSwap", raw);
      const outDelta = toBigInt(deltas[1], 0n);
      const amountOut = outDelta < 0n ? -outDelta : 0n;
      if (amountOut <= 0n) continue;
      out.push({
        source: "Balancer V2 queryBatchSwap",
        pathKind: "balancer-v2-single",
        amountInRaw: value,
        amountOutRaw: amountOut,
        gasEstimate: 0n,
        path: { poolId: pool.id, pool: pool.address, symbol: pool.symbol, totalLiquidity: pool.totalLiquidity, swapFee: pool.swapFee, assets },
      });
    } catch (_) {}
  }
  return out;
}

async function quoteExternalOutputExit(provider, curvePools, tokenIn, amountIn, exitTargets, gasPrice, ethPrice, inputUsd, baseGasUsd) {
  const candidates = [];
  const intermediates = exitTargets.map((target) => target.address);
  for (const target of exitTargets) {
    if (!target.address || !Number.isFinite(target.decimals) || !Number.isFinite(target.priceUsd)) continue;
    if (sameAddress(tokenIn, target.address)) continue;
    const quotes = [
      ...await quoteUniswapExactInput(provider, tokenIn, target.address, amountIn, intermediates).catch(() => []),
      ...await quoteCurveExactInput(provider, curvePools, tokenIn, target.address, amountIn).catch(() => []),
      ...await quoteBalancerExactInput(provider, tokenIn, target.address, amountIn).catch(() => []),
    ];
    for (const quote of quotes) {
      const conservativeOutputRaw = subBps(toBigInt(quote.amountOutRaw), ROUTE_SLIPPAGE_BUFFER_BPS);
      const outputUsd = rawToUsd(quote.amountOutRaw, target.decimals, target.priceUsd);
      const conservativeOutputUsd = rawToUsd(conservativeOutputRaw, target.decimals, target.priceUsd);
      const extraGasUsd = gasCostUsd(quote.gasEstimate || 0n, gasPrice, ethPrice) || 0;
      const netProfitUsd = Number.isFinite(conservativeOutputUsd) && Number.isFinite(baseGasUsd)
        ? conservativeOutputUsd - inputUsd - baseGasUsd - extraGasUsd
        : null;
      candidates.push({
        ...quote,
        targetSymbol: target.symbol,
        targetAddress: target.address,
        targetDecimals: target.decimals,
        targetPriceUsd: target.priceUsd,
        conservativeOutputRaw,
        outputUsd,
        conservativeOutputUsd,
        baseGasUsd,
        extraGasUsd,
        netProfitUsd,
      });
    }
  }
  const seen = new Set();
  return candidates
    .filter((q) => q && toBigInt(q.amountOutRaw) > 0n)
    .sort((a, b) => (Number(b.netProfitUsd) || -Infinity) - (Number(a.netProfitUsd) || -Infinity))
    .filter((q) => {
      const key = `${q.pathKind}:${q.targetAddress}:${q.amountOutRaw.toString()}:${JSON.stringify(q.path || {})}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function cTokenFromUnderlyingRaw(underlyingRaw, exchangeRateRaw) {
  if (!exchangeRateRaw || exchangeRateRaw <= 0n) return 0n;
  return (underlyingRaw * 10n ** 18n) / exchangeRateRaw;
}

function underlyingFromCTokenRaw(cTokenRaw, exchangeRateRaw) {
  return (cTokenRaw * exchangeRateRaw) / (10n ** 18n);
}

function subBps(raw, bps) {
  return (raw * (10_000n - bps)) / 10_000n;
}

async function scanCoin(provider, coin, prices) {
  const [coinSymbol, coinDecimals, underlyingAddress, exchangeRate, getCash, totalBorrows, totalReserves, totalSupply, poolBalance, underlyingDecimals, underlyingSymbol] = await Promise.all([
    safeCall(provider, coin.address, ERC20, "symbol"),
    safeCall(provider, coin.address, ERC20, "decimals"),
    safeCall(provider, coin.address, CTOKEN, "underlying"),
    safeCall(provider, coin.address, CTOKEN, "exchangeRateStored"),
    safeCall(provider, coin.address, CTOKEN, "getCash"),
    safeCall(provider, coin.address, CTOKEN, "totalBorrows"),
    safeCall(provider, coin.address, CTOKEN, "totalReserves"),
    safeCall(provider, coin.address, CTOKEN, "totalSupply"),
    safeCall(provider, POOL, CURVE_POOL, "balances", [coin.index]),
    safeCall(provider, coin.underlying, ERC20, "decimals"),
    safeCall(provider, coin.underlying, ERC20, "symbol"),
  ]);
  const cDecimals = coinDecimals.value ? Number(coinDecimals.value[0]) : 8;
  const uDecimals = underlyingDecimals.value ? Number(underlyingDecimals.value[0]) : null;
  const rateRaw = exchangeRate.value ? exchangeRate.value[0] : null;
  const underlyingPerWholeCTokenRaw = rateRaw && uDecimals !== null ? underlyingFromCTokenRaw(10n ** BigInt(cDecimals), rateRaw) : null;
  const underlyingPerWholeCToken = underlyingPerWholeCTokenRaw !== null ? formatAmount(underlyingPerWholeCTokenRaw, uDecimals) : null;
  const underlyingPrice = prices[coin.underlying.toLowerCase()] ?? null;
  const wrapperPrice = prices[coin.address.toLowerCase()] ?? null;
  const redeemNavUsd = Number.isFinite(underlyingPerWholeCToken) && Number.isFinite(underlyingPrice) ? underlyingPerWholeCToken * underlyingPrice : null;
  const curveBalanceRaw = poolBalance.value ? poolBalance.value[0] : null;
  return {
    index: coin.index,
    address: ethers.getAddress(coin.address),
    symbol: coinSymbol.value ? String(coinSymbol.value[0]) : coin.symbol,
    decimals: cDecimals,
    underlying: ethers.getAddress(coin.underlying),
    underlyingResolved: underlyingAddress.value ? ethers.getAddress(underlyingAddress.value[0]) : null,
    underlyingSymbol: underlyingSymbol.value ? String(underlyingSymbol.value[0]) : coin.underlyingSymbol,
    underlyingDecimals: uDecimals,
    exchangeRateStoredRaw: rateRaw,
    underlyingPerWholeCToken,
    wrapperMarketPriceUsd: wrapperPrice,
    redeemNavUsd,
    navVsWrapperMarketPct: redeemNavUsd && wrapperPrice ? ((redeemNavUsd / wrapperPrice) - 1) * 100 : null,
    getCashRaw: getCash.value ? getCash.value[0] : null,
    getCashUsd: getCash.value && uDecimals !== null ? rawToUsd(getCash.value[0], uDecimals, underlyingPrice) : null,
    totalBorrowsRaw: totalBorrows.value ? totalBorrows.value[0] : null,
    totalBorrowsUsd: totalBorrows.value && uDecimals !== null ? rawToUsd(totalBorrows.value[0], uDecimals, underlyingPrice) : null,
    totalReservesRaw: totalReserves.value ? totalReserves.value[0] : null,
    totalSupplyRaw: totalSupply.value ? totalSupply.value[0] : null,
    curveBalanceRaw,
    curveBalance: curveBalanceRaw !== null ? formatAmount(curveBalanceRaw, cDecimals) : null,
    curveBalanceRedeemUsd: curveBalanceRaw !== null && rateRaw && uDecimals !== null ? rawToUsd(underlyingFromCTokenRaw(curveBalanceRaw, rateRaw), uDecimals, underlyingPrice) : null,
    errors: {
      exchangeRateStored: exchangeRate.error || null,
      getCash: getCash.error || null,
      poolBalance: poolBalance.error || null,
      underlying: underlyingAddress.error || null,
    },
  };
}

async function scoreRoute(provider, from, to, amountUsd, gasUsd, curvePools, exitTargets, gasPrice, ethPrice) {
  if (!Number.isFinite(from.underlyingDecimals) || !Number.isFinite(to.underlyingDecimals)) return null;
  const fromPrice = from.underlyingPriceUsd;
  const toPrice = to.underlyingPriceUsd;
  if (!Number.isFinite(fromPrice) || !Number.isFinite(toPrice)) return null;
  const inputUnderlying = amountUsd / fromPrice;
  const inputUnderlyingRaw = parseAmount(inputUnderlying, from.underlyingDecimals);
  const inputWrapperRaw = cTokenFromUnderlyingRaw(inputUnderlyingRaw, BigInt(from.exchangeRateStoredRaw));
  if (inputWrapperRaw <= 0n) return null;
  const quote = await safeCall(provider, POOL, CURVE_POOL, "get_dy", [from.index, to.index, inputWrapperRaw]);
  if (!quote.value) {
    return {
      from: from.symbol,
      to: to.symbol,
      amountUsd,
      quoteError: quote.error || "get_dy failed",
      routePositive: false,
    };
  }
  const outputWrapperRaw = quote.value[0];
  const outputUnderlyingRaw = underlyingFromCTokenRaw(outputWrapperRaw, BigInt(to.exchangeRateStoredRaw));
  const conservativeOutputUnderlyingRaw = subBps(outputUnderlyingRaw, ROUTE_SLIPPAGE_BUFFER_BPS);
  const outputUsd = rawToUsd(outputUnderlyingRaw, to.underlyingDecimals, toPrice);
  const conservativeOutputUsd = rawToUsd(conservativeOutputUnderlyingRaw, to.underlyingDecimals, toPrice);
  const grossProfitUsd = Number.isFinite(outputUsd) ? outputUsd - amountUsd : null;
  const netProfitUsd = Number.isFinite(conservativeOutputUsd) ? conservativeOutputUsd - amountUsd - gasUsd : null;
  const redeemCashUsd = to.getCashUsd;
  const redeemCashOk = Number.isFinite(redeemCashUsd) && Number.isFinite(conservativeOutputUsd) && redeemCashUsd >= conservativeOutputUsd;
  let externalExitQuotes = [];
  if (netProfitUsd !== null && netProfitUsd > 0 && (!redeemCashOk || netProfitUsd < MIN_NET_PROFIT_USD)) {
    externalExitQuotes = await quoteExternalOutputExit(provider, curvePools, to.address, outputWrapperRaw, exitTargets, gasPrice, ethPrice, amountUsd, gasUsd).catch(() => []);
  }
  const bestExternalExit = externalExitQuotes[0] || null;
  const externalExitOk = Boolean(bestExternalExit && bestExternalExit.netProfitUsd !== null && bestExternalExit.netProfitUsd >= MIN_NET_PROFIT_USD);
  const redeemRoutePositive = Boolean(netProfitUsd !== null && netProfitUsd >= MIN_NET_PROFIT_USD && redeemCashOk);
  const routePositive = Boolean(redeemRoutePositive || externalExitOk);
  const blockers = [];
  if (!redeemCashOk && !externalExitOk) blockers.push("output wrapper redeem cash below quoted output and no positive exact external sale found");
  if (grossProfitUsd === null || grossProfitUsd <= 0) blockers.push("gross redeem-NAV route output not above input");
  if (netProfitUsd === null || netProfitUsd < MIN_NET_PROFIT_USD) blockers.push(`redeem-NAV net profit below $${MIN_NET_PROFIT_USD}`);
  if (externalExitQuotes.length === 0 && netProfitUsd !== null && netProfitUsd > 0 && !redeemCashOk) blockers.push("no exact external output-wrapper exit quote");
  if (bestExternalExit && !externalExitOk) blockers.push(`best external output-wrapper exit net below $${MIN_NET_PROFIT_USD}`);
  return {
    from: `${from.underlyingSymbol}->${from.symbol}`,
    to: `${to.symbol}->${to.underlyingSymbol}`,
    amountUsd,
    inputUnderlyingRaw,
    inputWrapperRaw,
    outputWrapperRaw,
    outputUnderlyingRaw,
    conservativeOutputUnderlyingRaw,
    outputUsd,
    conservativeOutputUsd,
    grossProfitUsd,
    gasUsd,
    netProfitUsd,
    redeemCashUsd,
    redeemCashOk,
    redeemRoutePositive,
    externalExitQuoted: externalExitQuotes.length > 0,
    externalExitOk,
    bestExternalExit,
    externalExitQuotes: externalExitQuotes.slice(0, 5),
    selectedExitMode: redeemRoutePositive ? "redeem" : externalExitOk ? "external-sale" : null,
    routePositive,
    blockers,
  };
}

async function scoreUnderlying(provider, from, to, amountUsd, gasUsd) {
  if (!Number.isFinite(from.underlyingDecimals) || !Number.isFinite(to.underlyingDecimals)) return null;
  const fromPrice = from.underlyingPriceUsd;
  const toPrice = to.underlyingPriceUsd;
  if (!Number.isFinite(fromPrice) || !Number.isFinite(toPrice)) return null;
  const inputUnderlyingRaw = parseAmount(amountUsd / fromPrice, from.underlyingDecimals);
  const quote = await safeCall(provider, POOL, CURVE_POOL, "get_dy_underlying", [from.index, to.index, inputUnderlyingRaw]);
  if (!quote.value) return null;
  const outputUnderlyingRaw = quote.value[0];
  const outputUsd = rawToUsd(outputUnderlyingRaw, to.underlyingDecimals, toPrice);
  const netProfitUsd = Number.isFinite(outputUsd) ? outputUsd - amountUsd - gasUsd : null;
  return {
    from: from.underlyingSymbol,
    to: to.underlyingSymbol,
    amountUsd,
    inputUnderlyingRaw,
    outputUnderlyingRaw,
    outputUsd,
    gasUsd,
    netProfitUsd,
    routePositive: false,
    blockers: ["underlying exchange is reference-only; wrapper NAV route is primary gate", ...(netProfitUsd !== null && netProfitUsd > 0 ? [] : ["net output not positive after gas"])],
  };
}

async function main() {
  const rpcUrl = await resolveRpcUrl(CHAIN_ID);
  if (!rpcUrl) throw new Error("No Ethereum RPC endpoint resolved from local inventory");
  const provider = new ethers.JsonRpcProvider(rpcUrl, { chainId: CHAIN_ID, name: "ethereum" }, { staticNetwork: true });
  const [blockNumber, block, gasPrice, prices, yieldMeta, curvePools] = await Promise.all([
    provider.getBlockNumber(),
    provider.getBlock("latest"),
    provider.getFeeData().then((f) => f.gasPrice || 0n),
    fetchPrices([...COINS.map((c) => c.address), ...COINS.map((c) => c.underlying), ...EXTRA_EXIT_TARGETS.map((t) => t.address), WETH]),
    fetchYieldMeta(),
    fetchCurvePools().catch(() => []),
  ]);
  const ethPrice = prices[WETH.toLowerCase()] || null;
  const gasUsd = Number.isFinite(ethPrice) ? (Number(gasPrice) / 1e18) * GAS_UNITS * ethPrice : null;
  const [fee, virtualPrice, lpSupply, lpBalanceGauge] = await Promise.all([
    safeCall(provider, POOL, CURVE_POOL, "fee"),
    safeCall(provider, POOL, CURVE_POOL, "get_virtual_price"),
    safeCall(provider, LP_TOKEN, ERC20, "totalSupply"),
    safeCall(provider, LP_TOKEN, ERC20, "balanceOf", [GAUGE]),
  ]);
  const coins = [];
  for (const coin of COINS) {
    const row = await scanCoin(provider, coin, prices);
    row.underlyingPriceUsd = prices[row.underlying.toLowerCase()] ?? null;
    coins.push(row);
  }
  const exitTargets = [
    ...coins.map((coin) => ({ symbol: coin.underlyingSymbol, address: coin.underlying, decimals: coin.underlyingDecimals, priceUsd: coin.underlyingPriceUsd })),
    ...EXTRA_EXIT_TARGETS.map((target) => ({ ...target, address: normalizeAddress(target.address), priceUsd: prices[lowerAddress(target.address)] ?? null })),
    { symbol: "WETH", address: WETH, decimals: 18, priceUsd: ethPrice },
  ].filter((target) => target.address && Number.isFinite(target.decimals) && Number.isFinite(target.priceUsd))
    .filter((target, index, list) => list.findIndex((item) => sameAddress(item.address, target.address)) === index);
  const routes = [];
  const underlyingReferences = [];
  for (const from of coins) {
    for (const to of coins) {
      if (from.index === to.index) continue;
      for (const size of TRADE_SIZES_USD) {
        const scored = await scoreRoute(provider, from, to, size, gasUsd ?? 0, curvePools, exitTargets, gasPrice, ethPrice);
        if (scored) routes.push(scored);
        const underlying = await scoreUnderlying(provider, from, to, size, gasUsd ?? 0);
        if (underlying) underlyingReferences.push(underlying);
      }
    }
  }
  routes.sort((a, b) => (Number(b.netProfitUsd) || -Infinity) - (Number(a.netProfitUsd) || -Infinity));
  underlyingReferences.sort((a, b) => (Number(b.netProfitUsd) || -Infinity) - (Number(a.netProfitUsd) || -Infinity));
  const positiveRoutes = routes.filter((r) => r.routePositive);
  const researchPositiveRoutes = routes.filter((r) => Number.isFinite(r.netProfitUsd) && r.netProfitUsd > 0);
  const externalExitQuotedRoutes = routes.filter((r) => r.externalExitQuoted);
  const externalExitPositiveRoutes = routes.filter((r) => r.externalExitOk);
  const externalExitBalancerRoutes = routes.filter((r) => (r.externalExitQuotes || []).some((q) => q.pathKind === "balancer-v2-single"));
  const externalExitCurveRoutes = routes.filter((r) => (r.externalExitQuotes || []).some((q) => String(q.pathKind || "").includes("curve")));
  const externalExitUniswapRoutes = routes.filter((r) => (r.externalExitQuotes || []).some((q) => String(q.pathKind || "").includes("uniswap")));
  const cashBlockedRoutes = researchPositiveRoutes.filter((r) => !r.redeemCashOk && !r.externalExitOk);
  const watchCandidates = routes.filter((r) => Number.isFinite(r.netProfitUsd) && r.netProfitUsd > 0 && r.redeemCashOk && !r.routePositive).slice(0, 10);
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-curve-ib-stable-wrapper-route.js",
    scope: "Curve Ethereum cyDAI/cyUSDC/cyUSDT wrapper NAV route scoring",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: positiveRoutes.length > 0,
      signedActionJustified: false,
    },
    chain: { id: CHAIN_ID, name: "Ethereum", blockNumber, timestamp: block?.timestamp || null },
    pool: {
      address: POOL,
      lpToken: LP_TOKEN,
      gauge: GAUGE,
      name: "Curve.fi cyDAI/cyUSDC/cyUSDT",
      symbol: "ib3CRV",
      feeRaw: fee.value ? fee.value[0] : null,
      virtualPriceRaw: virtualPrice.value ? virtualPrice.value[0] : null,
      lpSupplyRaw: lpSupply.value ? lpSupply.value[0] : null,
      lpGaugeBalanceRaw: lpBalanceGauge.value ? lpBalanceGauge.value[0] : null,
      yieldMeta,
    },
    thresholds: {
      tradeSizesUsd: TRADE_SIZES_USD,
      gasUnits: GAS_UNITS,
      minNetProfitUsd: MIN_NET_PROFIT_USD,
      routeSlippageBufferBps: Number(ROUTE_SLIPPAGE_BUFFER_BPS),
      externalExitMaxUniswapPaths: EXTERNAL_EXIT_MAX_UNISWAP_PATHS,
      externalExitCurveMaxPools: EXTERNAL_EXIT_CURVE_MAX_POOLS,
      balancerMaxPoolsPerPair: BALANCER_MAX_POOLS_PER_PAIR,
    },
    gas: {
      gasPriceWei: gasPrice,
      ethPriceUsd: ethPrice,
      gasUsd,
    },
    summary: {
      coins: coins.length,
      routeQuotes: routes.length,
      underlyingReferenceQuotes: underlyingReferences.length,
      externalCurvePoolsLoaded: curvePools.length,
      externalExitTargets: exitTargets.length,
      researchPositiveRoutes: researchPositiveRoutes.length,
      externalExitQuotedRoutes: externalExitQuotedRoutes.length,
      externalExitUniswapRoutes: externalExitUniswapRoutes.length,
      externalExitCurveRoutes: externalExitCurveRoutes.length,
      externalExitBalancerRoutes: externalExitBalancerRoutes.length,
      externalExitPositiveRoutes: externalExitPositiveRoutes.length,
      cashBlockedRoutes: cashBlockedRoutes.length,
      watchCandidates: watchCandidates.length,
      routePositive: positiveRoutes.length,
      signedActionJustified: false,
      bestNetProfitUsd: routes[0]?.netProfitUsd ?? null,
      bestRoute: routes[0] ? `${routes[0].from} -> ${routes[0].to} @ $${routes[0].amountUsd}` : null,
    },
    coins,
    topRoutes: routes.slice(0, 20),
    researchPositiveRoutes: researchPositiveRoutes.slice(0, 20),
    externalExitQuotedRoutes: externalExitQuotedRoutes.slice(0, 20),
    externalExitPositiveRoutes,
    cashBlockedRoutes: cashBlockedRoutes.slice(0, 20),
    watchCandidates,
    positiveRoutes,
    underlyingReferences: underlyingReferences.slice(0, 12),
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
  console.log(`Curve IB route scan: quotes=${routes.length} watch=${watchCandidates.length} routePositive=${positiveRoutes.length} bestNet=$${Number(routes[0]?.netProfitUsd ?? 0).toFixed(4)}`);
  console.log(`Report: ${path.relative(WORKSPACE, OUT_FILE)}`);
}

main().catch((e) => {
  console.error(`scan-curve-ib-stable-wrapper-route failed: ${e.message}`);
  process.exitCode = 1;
});
