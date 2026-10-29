#!/usr/bin/env node
// Read-only route probe for current Aave V4 stable-pair liquidation rows.
// RPC URLs are resolved in memory only and never printed or written.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const SHADOW_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-shadow-quotes.json");
const WATCH_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-watch.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-stable-pair-route-probe.json");

const CHAIN_ID = 1;
const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const SLIPPAGE_BPS = Number(process.env.AAVE_V4_LIQUIDATION_SLIPPAGE_BPS || "100");
const MIN_NET_PROFIT_USD = Number(process.env.AAVE_V4_MIN_NET_PROFIT_USD || "25");
const BALANCER_FLASH_FEE_BPS = Number(process.env.BALANCER_FLASH_FEE_BPS || "0");
const CURVE_MAX_POOLS_PER_PAIR = Number(process.env.AAVE_V4_CURVE_MAX_POOLS_PER_PAIR || "4");
const BALANCER_MAX_POOLS_PER_PAIR = Number(process.env.AAVE_V4_BALANCER_MAX_POOLS_PER_PAIR || "4");

const TOKENS = {
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  frxUSD: "0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29",
  FRAX: "0x853d955aCEf822Db058eb8505911ED77F175b99e",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  crvUSD: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
  GHO: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f",
  USDe: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
  USDS: "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
  PYUSD: "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
};

const STABLE_MIDS = ["FRAX", "USDT", "DAI", "crvUSD", "GHO", "USDe", "USDS", "PYUSD", "WETH"];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const QUOTER = new ethers.Interface([
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
const V2_ROUTER = new ethers.Interface([
  "function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[] amounts)",
]);
const CURVE_INT128 = new ethers.Interface([
  "function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)",
  "function get_dy_underlying(int128 i,int128 j,uint256 dx) view returns (uint256)",
]);
const CURVE_UINT256 = new ethers.Interface([
  "function get_dy(uint256 i,uint256 j,uint256 dx) view returns (uint256)",
  "function get_dy_underlying(uint256 i,uint256 j,uint256 dx) view returns (uint256)",
]);
const BALANCER = new ethers.Interface([
  "function queryBatchSwap(uint8 kind,(bytes32 poolId,uint256 assetInIndex,uint256 assetOutIndex,uint256 amount,bytes userData)[] swaps,address[] assets,(address sender,bool fromInternalBalance,address recipient,bool toInternalBalance) funds) returns (int256[] assetDeltas)",
]);

const V2_ROUTERS = [
  { name: "Fraxswap V2", address: "0xC14d550632db8592D1243Edc8B95b0Ad06703867" },
  { name: "Fraxswap V2 multihop", address: "0x25e9acA5951262241290841b6f863d59D37DC4f0" },
  { name: "Uniswap V2", address: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" },
  { name: "SushiSwap", address: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F" },
];

function loadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeArtifact(out) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function sameAddress(a, b) {
  const aa = normalizeAddress(a);
  const bb = normalizeAddress(b);
  return Boolean(aa && bb && aa.toLowerCase() === bb.toLowerCase());
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
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function formatUnitsSafe(raw, decimals) {
  try { return ethers.formatUnits(toBigInt(raw), Number(decimals)); } catch (_) { return null; }
}

function encodePath(tokens, fees) {
  let out = tokens[0].toLowerCase();
  for (let i = 0; i < fees.length; i++) {
    out += Number(fees[i]).toString(16).padStart(6, "0") + tokens[i + 1].toLowerCase().replace(/^0x/, "");
  }
  return out;
}

async function fetchJson(url, timeoutMs = 25_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCurvePools() {
  const registries = ["main", "factory", "factory-stable-ng", "crypto", "factory-crypto"];
  const pools = [];
  for (const registry of registries) {
    const json = await fetchJson(`https://api.curve.fi/v1/getPools/ethereum/${registry}`).catch(() => null);
    for (const p of json?.data?.poolData || []) {
      const address = normalizeAddress(p.address);
      if (!address || p.isBroken) continue;
      const coinLists = [];
      for (const [kind, rawCoins] of [["coins", p.coins], ["underlying", p.underlyingCoins]]) {
        const coins = (rawCoins || []).map((coin, index) => ({
          index,
          address: normalizeAddress(coin.address),
          symbol: coin.symbol || null,
          decimals: Number(coin.decimals ?? 18),
        })).filter((coin) => coin.address);
        if (coins.length >= 2) coinLists.push({ kind, coins });
      }
      if (!coinLists.length) continue;
      pools.push({
        source: `Curve ${registry}`,
        name: p.name || p.symbol || null,
        address,
        usdTotal: Number(p.usdTotal || p.usdTotalExcludingBasePool || 0) || null,
        coinLists,
      });
    }
  }
  return pools;
}

function findCurvePools(curvePools, tokenIn, tokenOut) {
  const input = normalizeAddress(tokenIn)?.toLowerCase();
  const output = normalizeAddress(tokenOut)?.toLowerCase();
  if (!input || !output || input === output) return [];
  const found = [];
  const seen = new Set();
  for (const pool of curvePools || []) {
    for (const list of pool.coinLists || []) {
      const i = list.coins.find((coin) => coin.address.toLowerCase() === input);
      const j = list.coins.find((coin) => coin.address.toLowerCase() === output);
      if (!i || !j) continue;
      const key = `${pool.address}:${list.kind}:${i.index}:${j.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ ...pool, coinListKind: list.kind, i, j });
    }
  }
  return found.sort((a, b) => Number(b.usdTotal || 0) - Number(a.usdTotal || 0)).slice(0, CURVE_MAX_POOLS_PER_PAIR);
}

async function curveGetDy(provider, pool, i, j, dx) {
  const methods = pool.coinListKind === "underlying"
    ? ["get_dy_underlying", "get_dy"]
    : ["get_dy", "get_dy_underlying"];
  for (const method of methods) {
    for (const iface of [CURVE_INT128, CURVE_UINT256]) {
      const raw = await provider.call({ to: pool.address, data: iface.encodeFunctionData(method, [BigInt(i), BigInt(j), dx]) }).catch(() => null);
      if (!raw) continue;
      try {
        const [dy] = iface.decodeFunctionResult(method, raw);
        if (dy > 0n) return { amountOutRaw: dy, method };
      } catch (_) {}
    }
  }
  return null;
}

async function quoteCurveDirect(provider, curvePools, tokenIn, tokenOut, amountIn) {
  const out = [];
  for (const pool of findCurvePools(curvePools, tokenIn, tokenOut)) {
    const q = await curveGetDy(provider, pool, pool.i.index, pool.j.index, amountIn).catch(() => null);
    if (!q?.amountOutRaw) continue;
    out.push({
      source: `${pool.source} ${pool.name || "pool"}`,
      pathKind: q.method === "get_dy_underlying" ? "curve-underlying-direct" : "curve-direct",
      amountOutRaw: q.amountOutRaw,
      gasEstimate: 0n,
      path: { pool: pool.address, name: pool.name, coinListKind: pool.coinListKind, method: q.method, tokenIn: pool.i.address, tokenOut: pool.j.address, coinIn: pool.i, coinOut: pool.j },
    });
  }
  return out;
}

async function quoteCurveHops(provider, curvePools, tokenIn, tokenOut, amountIn) {
  const out = [];
  for (const symbol of STABLE_MIDS) {
    const mid = TOKENS[symbol];
    if (!mid || sameAddress(mid, tokenIn) || sameAddress(mid, tokenOut)) continue;
    const heads = await quoteCurveDirect(provider, curvePools, tokenIn, mid, amountIn).catch(() => []);
    const head = heads[0] || null;
    if (!head) continue;
    const tails = await quoteCurveDirect(provider, curvePools, mid, tokenOut, head.amountOutRaw).catch(() => []);
    const tail = tails[0] || null;
    if (!tail) continue;
    out.push({
      source: `${head.source} + ${tail.source}`,
      pathKind: "curve-hop",
      amountOutRaw: tail.amountOutRaw,
      gasEstimate: 0n,
      path: { intermediate: { symbol, address: mid }, legs: [head.path, tail.path], intermediateAmountRaw: head.amountOutRaw },
    });
  }
  return out;
}

function uniswapV3PathDefs(tokenIn, tokenOut) {
  const directFees = [100, 500, 3000, 10000].map((fee) => ({ tokens: [tokenIn, tokenOut], fees: [fee], label: `${fee}` }));
  const routed = [];
  const feePairs = [[100, 100], [100, 500], [500, 100], [500, 500], [500, 3000], [3000, 500], [3000, 3000]];
  for (const symbol of STABLE_MIDS) {
    const mid = TOKENS[symbol];
    if (!mid || sameAddress(mid, tokenIn) || sameAddress(mid, tokenOut)) continue;
    for (const fees of feePairs) routed.push({ tokens: [tokenIn, mid, tokenOut], fees, label: `${fees[0]}/${symbol}/${fees[1]}` });
  }
  return [...directFees, ...routed];
}

async function quoteUniswapV3(provider, tokenIn, tokenOut, amountIn) {
  const out = [];
  for (const pathDef of uniswapV3PathDefs(tokenIn, tokenOut)) {
    const pathData = encodePath(pathDef.tokens, pathDef.fees);
    const raw = await provider.call({ to: QUOTER_V2, data: QUOTER.encodeFunctionData("quoteExactInput", [pathData, amountIn]) }).catch(() => null);
    if (!raw) continue;
    try {
      const [amountOut, , , gasEstimate] = QUOTER.decodeFunctionResult("quoteExactInput", raw);
      if (amountOut <= 0n) continue;
      out.push({
        source: pathDef.tokens.length === 2 ? "Uniswap V3 exact-input direct" : "Uniswap V3 exact-input routed",
        pathKind: pathDef.tokens.length === 2 ? "uniswap-v3-direct" : "uniswap-v3-routed",
        amountOutRaw: amountOut,
        gasEstimate,
        path: pathDef,
      });
    } catch (_) {}
  }
  return out;
}

function v2PathDefs(tokenIn, tokenOut) {
  const direct = [{ tokens: [tokenIn, tokenOut], label: "direct" }];
  const routed = [];
  for (const symbol of STABLE_MIDS) {
    const mid = TOKENS[symbol];
    if (!mid || sameAddress(mid, tokenIn) || sameAddress(mid, tokenOut)) continue;
    routed.push({ tokens: [tokenIn, mid, tokenOut], label: symbol });
  }
  return [...direct, ...routed];
}

async function quoteV2Routers(provider, tokenIn, tokenOut, amountIn) {
  const out = [];
  for (const router of V2_ROUTERS) {
    for (const pathDef of v2PathDefs(tokenIn, tokenOut)) {
      const raw = await provider.call({ to: router.address, data: V2_ROUTER.encodeFunctionData("getAmountsOut", [amountIn, pathDef.tokens]) }).catch(() => null);
      if (!raw) continue;
      try {
        const [amounts] = V2_ROUTER.decodeFunctionResult("getAmountsOut", raw);
        const amountOut = toBigInt(amounts[amounts.length - 1], 0n);
        if (amountOut <= 0n) continue;
        out.push({
          source: `${router.name} getAmountsOut`,
          pathKind: pathDef.tokens.length === 2 ? "v2-direct" : "v2-routed",
          amountOutRaw: amountOut,
          gasEstimate: 0n,
          path: { router: router.address, ...pathDef },
        });
      } catch (_) {}
    }
  }
  return out;
}

async function fetchBalancerPoolsForPair(tokenIn, tokenOut) {
  const a = normalizeAddress(tokenIn)?.toLowerCase();
  const b = normalizeAddress(tokenOut)?.toLowerCase();
  if (!a || !b || a === b) return [];
  const query = `query($tokens: [Bytes!]!) {
    pools(first: ${BALANCER_MAX_POOLS_PER_PAIR}, orderBy: totalLiquidity, orderDirection: desc,
      where: { tokensList_contains: $tokens, totalLiquidity_gt: 0, swapEnabled: true }) {
      id address symbol totalLiquidity swapFee tokens { address symbol decimals balance }
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
      })).filter((p) => p.id && p.address);
      if (rows.length) return rows;
    } catch (_) {
      // Try the next endpoint.
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

async function quoteBalancerDirect(provider, tokenIn, tokenOut, amountIn) {
  const out = [];
  const pools = await fetchBalancerPoolsForPair(tokenIn, tokenOut).catch(() => []);
  for (const pool of pools) {
    const assets = [normalizeAddress(tokenIn), normalizeAddress(tokenOut)];
    const swaps = [{ poolId: pool.id, assetInIndex: 0, assetOutIndex: 1, amount: amountIn, userData: "0x" }];
    const funds = { sender: ethers.ZeroAddress, fromInternalBalance: false, recipient: ethers.ZeroAddress, toInternalBalance: false };
    const raw = await provider.call({ to: BALANCER_VAULT, data: BALANCER.encodeFunctionData("queryBatchSwap", [0, swaps, assets, funds]) }).catch(() => null);
    if (!raw) continue;
    try {
      const [deltas] = BALANCER.decodeFunctionResult("queryBatchSwap", raw);
      const outDelta = toBigInt(deltas[1], 0n);
      const amountOut = outDelta < 0n ? -outDelta : 0n;
      if (amountOut <= 0n) continue;
      out.push({
        source: "Balancer V2 queryBatchSwap",
        pathKind: "balancer-v2-single",
        amountOutRaw: amountOut,
        gasEstimate: 0n,
        path: { poolId: pool.id, pool: pool.address, symbol: pool.symbol, totalLiquidity: pool.totalLiquidity, swapFee: pool.swapFee, assets },
      });
    } catch (_) {}
  }
  return out;
}

async function quoteStoredCurveLeg(provider, leg, amountIn) {
  const method = leg.method || "get_dy";
  for (const iface of [CURVE_INT128, CURVE_UINT256]) {
    const raw = await provider.call({
      to: leg.pool,
      data: iface.encodeFunctionData(method, [BigInt(leg.coinIn.index), BigInt(leg.coinOut.index), amountIn]),
    }).catch(() => null);
    if (!raw) continue;
    try {
      const [amountOut] = iface.decodeFunctionResult(method, raw);
      if (amountOut > 0n) return amountOut;
    } catch (_) {}
  }
  return 0n;
}

async function quoteStoredRoute(provider, route, amountIn) {
  if (!route || amountIn <= 0n) return 0n;

  if (route.pathKind === "curve-hop") {
    let amount = amountIn;
    for (const leg of route.path?.legs || []) {
      amount = await quoteStoredCurveLeg(provider, leg, amount);
      if (amount <= 0n) return 0n;
    }
    return amount;
  }

  if (route.pathKind === "curve-direct" || route.pathKind === "curve-underlying-direct") {
    return quoteStoredCurveLeg(provider, route.path, amountIn);
  }

  if (route.pathKind === "uniswap-v3-direct" || route.pathKind === "uniswap-v3-routed") {
    const pathData = encodePath(route.path.tokens, route.path.fees);
    const raw = await provider.call({ to: QUOTER_V2, data: QUOTER.encodeFunctionData("quoteExactInput", [pathData, amountIn]) }).catch(() => null);
    if (!raw) return 0n;
    try {
      const [amountOut] = QUOTER.decodeFunctionResult("quoteExactInput", raw);
      return amountOut;
    } catch (_) {
      return 0n;
    }
  }

  if (route.pathKind === "v2-direct" || route.pathKind === "v2-routed") {
    const raw = await provider.call({ to: route.path.router, data: V2_ROUTER.encodeFunctionData("getAmountsOut", [amountIn, route.path.tokens]) }).catch(() => null);
    if (!raw) return 0n;
    try {
      const [amounts] = V2_ROUTER.decodeFunctionResult("getAmountsOut", raw);
      return toBigInt(amounts[amounts.length - 1], 0n);
    } catch (_) {
      return 0n;
    }
  }

  if (route.pathKind === "balancer-v2-single") {
    const assets = route.path.assets;
    const swaps = [{ poolId: route.path.poolId, assetInIndex: 0, assetOutIndex: 1, amount: amountIn, userData: "0x" }];
    const funds = { sender: ethers.ZeroAddress, fromInternalBalance: false, recipient: ethers.ZeroAddress, toInternalBalance: false };
    const raw = await provider.call({ to: BALANCER_VAULT, data: BALANCER.encodeFunctionData("queryBatchSwap", [0, swaps, assets, funds]) }).catch(() => null);
    if (!raw) return 0n;
    try {
      const [deltas] = BALANCER.decodeFunctionResult("queryBatchSwap", raw);
      const outDelta = toBigInt(deltas[1], 0n);
      return outDelta < 0n ? -outDelta : 0n;
    } catch (_) {
      return 0n;
    }
  }

  return 0n;
}

async function minInputForOutput(provider, route, targetOut, upperBound) {
  if (targetOut <= 0n || upperBound <= 0n) return null;
  const maxOut = await quoteStoredRoute(provider, route, upperBound);
  if (maxOut < targetOut) return null;
  let lo = 0n;
  let hi = upperBound;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const out = await quoteStoredRoute(provider, route, mid);
    if (out >= targetOut) hi = mid;
    else lo = mid;
  }
  return hi;
}

function chooseTarget(shadow, watch) {
  const rows = Array.isArray(shadow?.rows) ? shadow.rows : [];
  const row = rows.find((r) => String(r?.repay?.symbol || "").toLowerCase() === "frxusd" && String(r?.collateral?.symbol || "").toLowerCase() === "usdc") || rows[0] || null;
  if (row?.repay?.address && row?.collateral?.address) return row;

  const top = watch?.latest?.topRows?.[0] || null;
  return {
    user: top?.user || null,
    spoke: top?.spoke || null,
    shadowOnly: !top?.liquidatable,
    healthFactor: top?.healthFactor ?? null,
    bpsToLiquidation: top?.bpsToLiquidation ?? null,
    fraction: null,
    repay: { symbol: top?.topDebt?.symbol || "frxUSD", reserveId: top?.topDebt?.reserveId ?? null, address: TOKENS.frxUSD, decimals: 18, priceUsd: 1, amountUsd: null, amountRaw: null },
    collateral: { symbol: top?.topCollateral?.symbol || "USDC", reserveId: top?.topCollateral?.reserveId ?? null, address: TOKENS.USDC, decimals: 6, priceUsd: 1, seizedUsd: null, seizedRaw: null, liquidationBonusBps: top?.topCollateral?.liquidationBonusBps ?? null },
  };
}

async function tokenInfo(provider, address, fallback = {}) {
  const token = new ethers.Contract(address, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([
    token.symbol().catch(() => fallback.symbol || null),
    token.decimals().catch(() => fallback.decimals ?? 18),
  ]);
  return { address: normalizeAddress(address), symbol: symbol || fallback.symbol || null, decimals: Number(decimals) };
}

function decorateRows(rows, target, gasUsd) {
  const debtDecimals = Number(target.repay.decimals ?? 18);
  const debtPriceUsd = asNumber(target.repay.priceUsd) || 1;
  const repayUsd = asNumber(target.repay.amountUsd) || 0;
  const slippageUsd = repayUsd * SLIPPAGE_BPS / 10_000;
  return rows
    .map((row) => {
      const amountOut = Number(ethers.formatUnits(row.amountOutRaw, debtDecimals));
      const amountOutUsd = amountOut * debtPriceUsd;
      const grossProfitUsd = repayUsd > 0 ? amountOutUsd - repayUsd : null;
      const netProfitUsd = grossProfitUsd === null ? null : grossProfitUsd - slippageUsd - gasUsd;
      return {
        ...row,
        amountOut: round(amountOut, 8),
        amountOutUsd: round(amountOutUsd, 2),
        grossProfitUsd: grossProfitUsd === null ? null : round(grossProfitUsd, 2),
        slippageUsd: round(slippageUsd, 2),
        gasUsd: round(gasUsd, 2),
        netProfitUsd: netProfitUsd === null ? null : round(netProfitUsd, 2),
        researchPositive: netProfitUsd !== null && netProfitUsd > MIN_NET_PROFIT_USD,
      };
    })
    .sort((a, b) => toBigInt(b.amountOutRaw) > toBigInt(a.amountOutRaw) ? 1 : toBigInt(b.amountOutRaw) < toBigInt(a.amountOutRaw) ? -1 : 0);
}

async function main() {
  const shadow = loadJson(SHADOW_FILE, {});
  const watch = loadJson(WATCH_FILE, {});
  const target = chooseTarget(shadow, watch);

  const tokenIn = normalizeAddress(target?.collateral?.address || TOKENS.USDC);
  const tokenOut = normalizeAddress(target?.repay?.address || TOKENS.frxUSD);
  const amountIn = toBigInt(target?.collateral?.seizedRaw, 0n);
  if (!tokenIn || !tokenOut || amountIn <= 0n) {
    writeArtifact({
      generatedAt: new Date().toISOString(),
      scanner: "tools/probe-aave-v4-stable-pair-routes.js",
      safety: { rpcInventoryRead: false, rpcUrlsStored: false, signedActions: false, exploitExecuteCalls: false, routePositive: false, signedActionJustified: false },
      verdict: "missing-target-amount",
      blocker: "No Aave V4 stable-pair target with collateral seized amount is available. Refresh shadow quotes first.",
    });
    console.log("Aave V4 stable-pair route probe: missing target amount.");
    return;
  }

  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) throw new Error("No Ethereum RPC endpoint resolved from local inventory");
  const provider = new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
  const [blockNumber, gasPriceRaw, debtMeta, collateralMeta, debtFlashRaw, collateralFlashRaw, curvePools] = await Promise.all([
    provider.getBlockNumber(),
    provider.send("eth_gasPrice", []).then(BigInt).catch(() => 0n),
    tokenInfo(provider, tokenOut, target.repay).catch(() => ({ address: tokenOut, symbol: target.repay?.symbol || "frxUSD", decimals: Number(target.repay?.decimals || 18) })),
    tokenInfo(provider, tokenIn, target.collateral).catch(() => ({ address: tokenIn, symbol: target.collateral?.symbol || "USDC", decimals: Number(target.collateral?.decimals || 6) })),
    new ethers.Contract(tokenOut, ERC20_ABI, provider).balanceOf(BALANCER_VAULT).catch(() => null),
    new ethers.Contract(tokenIn, ERC20_ABI, provider).balanceOf(BALANCER_VAULT).catch(() => null),
    fetchCurvePools().catch(() => []),
  ]);

  target.repay.address = tokenOut;
  target.repay.symbol = debtMeta.symbol || target.repay.symbol;
  target.repay.decimals = debtMeta.decimals;
  target.collateral.address = tokenIn;
  target.collateral.symbol = collateralMeta.symbol || target.collateral.symbol;
  target.collateral.decimals = collateralMeta.decimals;

  const gasUsd = asNumber(shadow?.gas?.gasUsd) || 0;
  const [uniV3, curveDirect, curveHops, balancer, v2] = await Promise.all([
    quoteUniswapV3(provider, tokenIn, tokenOut, amountIn),
    quoteCurveDirect(provider, curvePools, tokenIn, tokenOut, amountIn),
    quoteCurveHops(provider, curvePools, tokenIn, tokenOut, amountIn),
    quoteBalancerDirect(provider, tokenIn, tokenOut, amountIn),
    quoteV2Routers(provider, tokenIn, tokenOut, amountIn),
  ]);

  const rows = decorateRows([...uniV3, ...curveDirect, ...curveHops, ...balancer, ...v2], target, gasUsd);
  const best = rows[0] || null;
  const fraction = asNumber(target.fraction);
  const repayRaw = toBigInt(target?.repay?.amountRaw, 0n);
  const fullRepayEstimateRaw = fraction && fraction > 0 && repayRaw > 0n ? repayRaw * 1_000_000n / BigInt(Math.round(fraction * 1_000_000)) : null;
  const debtPriceUsd = asNumber(target.repay.priceUsd) || 1;
  const debtFlashFormatted = debtFlashRaw === null ? null : formatUnitsSafe(debtFlashRaw, debtMeta.decimals);
  const debtFlashUsd = debtFlashFormatted === null ? null : Number(debtFlashFormatted) * debtPriceUsd;
  const collateralPriceUsd = asNumber(target.collateral.priceUsd) || 1;
  const collateralFlashFormatted = collateralFlashRaw === null ? null : formatUnitsSafe(collateralFlashRaw, collateralMeta.decimals);
  const collateralFlashUsd = collateralFlashFormatted === null ? null : Number(collateralFlashFormatted) * collateralPriceUsd;

  let collateralFlashPlan = null;
  if (best && repayRaw > 0n && amountIn > 0n && toBigInt(best.amountOutRaw) >= repayRaw) {
    const requiredCollateralInRaw = await minInputForOutput(provider, best, repayRaw, amountIn).catch(() => null);
    if (requiredCollateralInRaw !== null) {
      const flashFeeRaw = requiredCollateralInRaw * BigInt(Math.max(0, Math.round(BALANCER_FLASH_FEE_BPS))) / 10_000n;
      const profitRaw = amountIn > requiredCollateralInRaw + flashFeeRaw ? amountIn - requiredCollateralInRaw - flashFeeRaw : 0n;
      const profitUsd = Number(ethers.formatUnits(profitRaw, collateralMeta.decimals)) * collateralPriceUsd;
      const slippageBufferUsd = Number(ethers.formatUnits(requiredCollateralInRaw, collateralMeta.decimals)) * collateralPriceUsd * SLIPPAGE_BPS / 10_000;
      const netUsd = profitUsd - slippageBufferUsd - gasUsd;
      collateralFlashPlan = {
        flow: "flash-collateral-token-swap-to-debt-token-liquidate-repay-collateral-token",
        flashToken: collateralMeta,
        debtToken: debtMeta,
        quoteSource: best.source,
        quotePathKind: best.pathKind,
        availableFlashRaw: collateralFlashRaw,
        availableFlash: collateralFlashFormatted,
        availableFlashUsd: collateralFlashUsd === null ? null : round(collateralFlashUsd, 2),
        requiredFlashRaw: requiredCollateralInRaw,
        requiredFlash: formatUnitsSafe(requiredCollateralInRaw, collateralMeta.decimals),
        flashFeeBps: BALANCER_FLASH_FEE_BPS,
        flashFeeRaw,
        seizedCollateralRaw: amountIn,
        profitRaw,
        profitUsd: round(profitUsd, 2),
        slippageBufferUsd: round(slippageBufferUsd, 2),
        gasUsd: round(gasUsd, 2),
        netUsd: round(netUsd, 2),
        flashSufficient: collateralFlashRaw === null ? null : collateralFlashRaw >= requiredCollateralInRaw + flashFeeRaw,
        researchPositive: netUsd > MIN_NET_PROFIT_USD && (collateralFlashRaw === null || collateralFlashRaw >= requiredCollateralInRaw + flashFeeRaw),
        blockers: [
          "Borrower is not currently liquidatable",
          "No fork extraction proof for flash-token != debt-token flow",
          "Executor does not yet implement pre-liquidation debt-token acquisition",
        ],
      };
    }
  }

  const researchPositiveRoutes = rows.filter((row) => row.researchPositive).length;
  const liquidatableNow = Boolean(!target.shadowOnly && (asNumber(target.healthFactor) || 2) < 1);
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/probe-aave-v4-stable-pair-routes.js",
    scope: "Read-only Aave V4 stable-pair collateral-exit and flash-liquidity probe",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    sourceArtifacts: {
      shadowQuotes: path.relative(WORKSPACE, SHADOW_FILE),
      watch: path.relative(WORKSPACE, WATCH_FILE),
    },
    config: {
      slippageBps: SLIPPAGE_BPS,
      minNetProfitUsd: MIN_NET_PROFIT_USD,
      balancerFlashFeeBps: BALANCER_FLASH_FEE_BPS,
      curvePoolsDiscovered: curvePools.length,
      v2Routers: V2_ROUTERS.map((r) => ({ name: r.name, address: r.address })),
      stableIntermediates: STABLE_MIDS,
    },
    live: {
      chainId: CHAIN_ID,
      blockNumber,
      gasPriceWei: gasPriceRaw,
      user: target.user || null,
      spoke: target.spoke || null,
      healthFactor: target.healthFactor ?? null,
      bpsToLiquidation: target.bpsToLiquidation ?? null,
      liquidatableNow,
    },
    target: {
      collateral: target.collateral,
      repay: target.repay,
      amountInRaw: amountIn,
      repayAmountRaw: repayRaw || null,
      fraction: target.fraction ?? null,
    },
    flashLiquidity: {
      source: "Balancer Vault token balances",
      debtToken: {
        ...debtMeta,
        balanceRaw: debtFlashRaw,
        balance: debtFlashFormatted,
        balanceUsd: debtFlashUsd === null ? null : round(debtFlashUsd, 2),
      },
      collateralToken: {
        ...collateralMeta,
        balanceRaw: collateralFlashRaw,
        balance: collateralFlashFormatted,
        balanceUsd: collateralFlashUsd === null ? null : round(collateralFlashUsd, 2),
      },
      currentProbeRepayRaw: repayRaw || null,
      currentProbeSufficient: debtFlashRaw === null || repayRaw <= 0n ? null : debtFlashRaw >= repayRaw,
      fullRepayEstimateRaw,
      fullRepayEstimateSufficient: debtFlashRaw === null || fullRepayEstimateRaw === null ? null : debtFlashRaw >= fullRepayEstimateRaw,
    },
    collateralFlashPlan,
    summary: {
      routeRows: rows.length,
      researchPositiveRoutes,
      collateralFlashResearchPositive: Boolean(collateralFlashPlan?.researchPositive),
      hasExactExit: rows.length > 0,
      bestSource: best?.source || null,
      bestPathKind: best?.pathKind || null,
      bestAmountOutUsd: best?.amountOutUsd ?? null,
      bestNetProfitUsd: best?.netProfitUsd ?? null,
      flashSufficientForProbe: debtFlashRaw === null || repayRaw <= 0n ? null : debtFlashRaw >= repayRaw,
      flashSufficientForFullRepayEstimate: debtFlashRaw === null || fullRepayEstimateRaw === null ? null : debtFlashRaw >= fullRepayEstimateRaw,
      collateralFlashSufficientForProbe: collateralFlashPlan?.flashSufficient ?? null,
      collateralFlashNetUsd: collateralFlashPlan?.netUsd ?? null,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      blocker: !liquidatableNow
        ? "Borrower is not liquidatable; route data is pre-trigger only."
        : researchPositiveRoutes > 0
          ? "Exact route exists, but fork extraction proof and live gates are still required."
          : "No exact positive route after gas/slippage.",
    },
    rows: rows.slice(0, 25),
  };

  writeArtifact(out);
  console.log(`Aave V4 stable-pair route probe: rows=${rows.length} researchPositive=${researchPositiveRoutes} best=${best?.source || "none"} routePositive=0`);
}

main().catch((e) => {
  console.error(`probe-aave-v4-stable-pair-routes failed: ${e?.message || String(e)}`);
  process.exitCode = 1;
});
