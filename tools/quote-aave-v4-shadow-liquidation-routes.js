#!/usr/bin/env node
// quote-aave-v4-shadow-liquidation-routes.js - read-only pre-trigger Aave V4 liquidation economics.
// RPC URLs are resolved in memory only, never printed or written.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const WATCH_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-watch.json");
const BORROWERS_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-spoke-borrowers.json");
const HUBS_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-hubs.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-shadow-quotes.json");

const QUIET = process.argv.includes("--quiet");
const ETHEREUM_CHAIN_ID = 1;
const TIMEOUT_MS = 15_000;
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const ETH_FEED = "0x5f4eC3Df9cbd43714FE2740f5e3616155c5b8419";
const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const ZERO = ethers.ZeroAddress;
const GAS_UNITS = Number(process.env.AAVE_V4_LIQUIDATION_GAS_UNITS || "1800000");
const SLIPPAGE_BPS = Number(process.env.AAVE_V4_LIQUIDATION_SLIPPAGE_BPS || "100");
const MIN_NET_PROFIT_USD = Number(process.env.AAVE_V4_MIN_NET_PROFIT_USD || "25");
const CURVE_MAX_POOLS_PER_PAIR = Number(process.env.AAVE_V4_CURVE_MAX_POOLS_PER_PAIR || "3");
const BALANCER_MAX_POOLS_PER_PAIR = Number(process.env.AAVE_V4_BALANCER_MAX_POOLS_PER_PAIR || "3");
const MAX_ROWS = Math.max(1, Number(argValue("--max-rows") || process.env.AAVE_V4_SHADOW_MAX_ROWS || "3") || 3);
const PAIR_LIMIT_PER_ROW = Math.max(1, Number(argValue("--pair-limit") || process.env.AAVE_V4_SHADOW_PAIR_LIMIT || "4") || 4);
const TRIGGER_BPS = Math.max(0, Number(argValue("--trigger-bps") || process.env.AAVE_V4_SHADOW_TRIGGER_BPS || "150") || 150);
const SIZE_FRACTIONS = String(argValue("--size-fractions") || process.env.AAVE_V4_LIQUIDATION_SIZE_FRACTIONS || "0.1,0.25,0.5,1")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0 && x <= 1);
const FEES = [100, 500, 3000, 10000];

const QUOTER = new ethers.Interface([
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
const FEED = new ethers.Interface([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
]);
const CURVE_INT128 = new ethers.Interface(["function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)"]);
const CURVE_UINT256 = new ethers.Interface(["function get_dy(uint256 i,uint256 j,uint256 dx) view returns (uint256)"]);
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
  "function convertToAssets(uint256 shares) view returns (uint256 assets)",
]);
const BALANCER = new ethers.Interface([
  "function queryBatchSwap(uint8 kind,(bytes32 poolId,uint256 assetInIndex,uint256 assetOutIndex,uint256 amount,bytes userData)[] swaps,address[] assets,(address sender,bool fromInternalBalance,address recipient,bool toInternalBalance) funds) returns (int256[] assetDeltas)",
]);

const balancerPairCache = new Map();

const COMMON = {
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  wstETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
  weETH: "0xcd5fE23C85820F7B72D0926FC9b05b43E359b7ee",
  rETH: "0xae78736Cd615f374D3085123A210448E74Fc6393",
  cbETH: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704",
};

function argValue(name) {
  const prefix = `${name}=`;
  const item = process.argv.find((arg) => arg.startsWith(prefix));
  if (item) return item.slice(prefix.length);
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

function loadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[$,%\s,]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

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

function loadRpcUrls() {
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
      // Try the next configured endpoint.
    }
  }
  return null;
}

async function fetchJson(url, timeoutMs = 30_000) {
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

function buildAssetIndex(hubs) {
  const byHubAsset = new Map();
  const bySymbol = new Map(Object.entries(COMMON).map(([symbol, address]) => [symbol.toLowerCase(), { symbol, underlying: address }]));
  for (const hub of hubs?.hubs || []) {
    for (const asset of hub.assets || []) {
      const row = {
        hub: hub.name,
        hubAddress: hub.address,
        assetId: asset.assetId,
        symbol: asset.symbol,
        underlying: asset.underlying,
        decimals: asset.decimals,
        priceUsd: asset.priceUsd,
      };
      byHubAsset.set(`${hub.name}:${asset.assetId}`, row);
      const key = String(asset.symbol || "").toLowerCase();
      const existing = bySymbol.get(key) || {};
      bySymbol.set(key, { ...existing, ...row, underlying: row.underlying || existing.underlying });
    }
  }
  return { byHubAsset, bySymbol };
}

function findBorrowerDetail(borrowers, quoteRow) {
  for (const spoke of borrowers?.spokes || []) {
    if (quoteRow.spoke && String(spoke.spoke).toLowerCase() !== String(quoteRow.spoke).toLowerCase()) continue;
    for (const user of spoke.topUsers || []) {
      if (String(user.user).toLowerCase() === String(quoteRow.user).toLowerCase()) return { spoke, user };
    }
  }
  return null;
}

function tokenMeta(assetIndex, hubName, reserve) {
  const byAsset = assetIndex.byHubAsset.get(`${hubName}:${reserve.assetId}`);
  const bySymbol = assetIndex.bySymbol.get(String(reserve.symbol || "").toLowerCase());
  const meta = byAsset || bySymbol || {};
  return {
    reserveId: reserve.reserveId,
    assetId: reserve.assetId,
    symbol: reserve.symbol || meta.symbol || null,
    address: meta.underlying || null,
    decimals: reserve.decimals ?? meta.decimals ?? null,
    priceUsd: reserve.oracleData?.referencePriceUsd ?? reserve.oracleData?.price ?? meta.priceUsd ?? null,
    debtUsd: reserve.debtUsd || null,
    suppliedUsd: reserve.suppliedUsd || null,
    liquidationBonusBps: reserve.liquidationBonusBps || reserve.dynamicConfig?.maxLiquidationBonusBps || null,
  };
}

function encodePath(tokens, fees) {
  let out = tokens[0].toLowerCase();
  for (let i = 0; i < fees.length; i++) {
    out += fees[i].toString(16).padStart(6, "0") + tokens[i + 1].toLowerCase().replace(/^0x/, "");
  }
  return out;
}

function candidatePaths(tokenIn, tokenOut) {
  const direct = FEES.map((fee) => ({ tokens: [tokenIn, tokenOut], fees: [fee], label: `${fee}` }));
  const mids = Object.values(COMMON)
    .filter((mid) => mid && mid.toLowerCase() !== tokenIn.toLowerCase() && mid.toLowerCase() !== tokenOut.toLowerCase());
  const routed = [];
  for (const mid of mids) {
    for (const f0 of [100, 500, 3000]) {
      for (const f1 of [100, 500, 3000]) routed.push({ tokens: [tokenIn, mid, tokenOut], fees: [f0, f1], label: `${f0}/${String(mid).slice(0, 8)}/${f1}` });
    }
  }
  return [...direct, ...routed];
}

async function quotePath(provider, amountInRaw, tokenIn, tokenOut) {
  const out = [];
  for (const pathDef of candidatePaths(tokenIn, tokenOut)) {
    try {
      const pathData = encodePath(pathDef.tokens, pathDef.fees);
      const raw = await provider.call({ to: QUOTER_V2, data: QUOTER.encodeFunctionData("quoteExactInput", [pathData, amountInRaw]) });
      const [amountOut, , , gasEstimate] = QUOTER.decodeFunctionResult("quoteExactInput", raw);
      if (amountOut > 0n) out.push({
        ...pathDef,
        source: pathDef.tokens.length === 2 ? "Uniswap V3 exact-input direct" : "Uniswap V3 routed exact-input",
        pathKind: pathDef.tokens.length === 2 ? "uniswap-v3-direct" : "uniswap-v3-routed",
        amountOutRaw: amountOut,
        gasEstimate,
        path: { tokens: pathDef.tokens, fees: pathDef.fees, label: pathDef.label },
      });
    } catch (_) {
      // Many candidate paths do not exist; fail closed and try the next one.
    }
  }
  return out.sort((a, b) => (a.amountOutRaw > b.amountOutRaw ? -1 : a.amountOutRaw < b.amountOutRaw ? 1 : 0));
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
  for (const iface of [CURVE_INT128, CURVE_UINT256]) {
    const raw = await provider.call({ to: pool.address, data: iface.encodeFunctionData("get_dy", [BigInt(i), BigInt(j), amount]) }).catch(() => null);
    if (!raw) continue;
    try {
      const [dy] = iface.decodeFunctionResult("get_dy", raw);
      if (dy > 0n) return dy;
    } catch (_) {}
  }
  return null;
}

async function quoteCurveExactInput(provider, curvePools, tokenIn, tokenOut, amountIn) {
  const out = [];
  for (const pool of findCurvePools(curvePools, tokenIn, tokenOut)) {
    const amountOut = await curveGetDy(provider, pool, pool.i.index, pool.j.index, amountIn).catch(() => null);
    if (!amountOut || amountOut <= 0n) continue;
    out.push({
      source: pool.source,
      pathKind: "curve-direct",
      amountOutRaw: amountOut,
      gasEstimate: 0n,
      path: { pool: pool.address, name: pool.name, tokenIn: pool.i.address, tokenOut: pool.j.address, coinIn: pool.i, coinOut: pool.j },
    });
  }
  return out;
}

function hopCandidates(tokenIn, tokenOut) {
  return [...new Set(Object.values(COMMON).map(normalizeAddress).filter(Boolean).map((x) => x.toLowerCase()))]
    .map((x) => ethers.getAddress(x))
    .filter((mid) => !sameAddress(mid, tokenIn) && !sameAddress(mid, tokenOut))
    .slice(0, 12);
}

async function quoteCurveHops(provider, curvePools, tokenIn, tokenOut, amountIn) {
  const candidates = [];
  for (const mid of hopCandidates(tokenIn, tokenOut)) {
    if (findCurvePools(curvePools, tokenIn, mid).length > 0) {
      const heads = await quoteCurveExactInput(provider, curvePools, tokenIn, mid, amountIn).catch(() => []);
      const head = heads.sort((a, b) => (a.amountOutRaw > b.amountOutRaw ? -1 : a.amountOutRaw < b.amountOutRaw ? 1 : 0))[0];
      if (head) {
        const tails = await quotePath(provider, head.amountOutRaw, mid, tokenOut).catch(() => []);
        const tail = tails[0] || null;
        if (tail) candidates.push({ source: "Curve + Uniswap V3 exact-input", pathKind: "curve-to-uniswap-v3", amountOutRaw: tail.amountOutRaw, gasEstimate: toBigInt(head.gasEstimate) + toBigInt(tail.gasEstimate), path: { legs: [head.path, tail.path] } });
      }
    }
    if (findCurvePools(curvePools, mid, tokenOut).length > 0) {
      const heads = await quotePath(provider, amountIn, tokenIn, mid).catch(() => []);
      const head = heads[0] || null;
      if (!head) continue;
      const tails = await quoteCurveExactInput(provider, curvePools, mid, tokenOut, head.amountOutRaw).catch(() => []);
      const tail = tails.sort((a, b) => (a.amountOutRaw > b.amountOutRaw ? -1 : a.amountOutRaw < b.amountOutRaw ? 1 : 0))[0];
      if (tail) candidates.push({ source: "Uniswap V3 + Curve exact-input", pathKind: "uniswap-v3-to-curve", amountOutRaw: tail.amountOutRaw, gasEstimate: toBigInt(head.gasEstimate) + toBigInt(tail.gasEstimate), path: { legs: [head.path, tail.path] } });
    }
    if (findCurvePools(curvePools, tokenIn, mid).length > 0 && findCurvePools(curvePools, mid, tokenOut).length > 0) {
      const heads = await quoteCurveExactInput(provider, curvePools, tokenIn, mid, amountIn).catch(() => []);
      for (const head of heads.slice(0, CURVE_MAX_POOLS_PER_PAIR)) {
        const tails = await quoteCurveExactInput(provider, curvePools, mid, tokenOut, head.amountOutRaw).catch(() => []);
        const tail = tails[0] || null;
        if (tail) candidates.push({ source: "Curve + Curve exact-input", pathKind: "curve-to-curve", amountOutRaw: tail.amountOutRaw, gasEstimate: toBigInt(head.gasEstimate) + toBigInt(tail.gasEstimate), path: { intermediate: mid, intermediateAmountRaw: head.amountOutRaw.toString(), legs: [head.path, tail.path] } });
      }
    }
  }
  return candidates;
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
        tokens: (p.tokens || []).map((t) => ({ address: normalizeAddress(t.address), symbol: t.symbol || null, decimals: Number(t.decimals || 18), balance: t.balance || null })).filter((t) => t.address),
      })).filter((p) => p.id && p.address);
      if (rows.length > 0) {
        balancerPairCache.set(key, rows);
        return rows;
      }
    } catch (_) {
      // Try the next subgraph endpoint.
    } finally {
      clearTimeout(timer);
    }
  }
  balancerPairCache.set(key, []);
  return [];
}

async function quoteBalancerExactInput(provider, tokenIn, tokenOut, amountIn) {
  const pools = await fetchBalancerPoolsForPair(tokenIn, tokenOut).catch(() => []);
  const candidates = [];
  for (const pool of pools) {
    try {
      const assets = [normalizeAddress(tokenIn), normalizeAddress(tokenOut)];
      const swaps = [{ poolId: pool.id, assetInIndex: 0, assetOutIndex: 1, amount: toBigInt(amountIn), userData: "0x" }];
      const funds = { sender: ZERO, fromInternalBalance: false, recipient: ZERO, toInternalBalance: false };
      const raw = await provider.call({ to: BALANCER_VAULT, data: BALANCER.encodeFunctionData("queryBatchSwap", [0, swaps, assets, funds]) }).catch(() => null);
      if (!raw) continue;
      const [deltas] = BALANCER.decodeFunctionResult("queryBatchSwap", raw);
      const outDelta = toBigInt(deltas[1], 0n);
      const amountOut = outDelta < 0n ? -outDelta : 0n;
      if (amountOut <= 0n) continue;
      candidates.push({
        source: "Balancer V2 queryBatchSwap",
        pathKind: "balancer-v2-single",
        amountOutRaw: amountOut,
        gasEstimate: 0n,
        path: { poolId: pool.id, pool: pool.address, symbol: pool.symbol, totalLiquidity: pool.totalLiquidity, swapFee: pool.swapFee, assets },
      });
    } catch (_) {}
  }
  return candidates;
}

async function safeCall(provider, to, iface, name, callArgs = []) {
  try {
    const target = normalizeAddress(to);
    if (!target) return null;
    const raw = await provider.call({ to: target, data: iface.encodeFunctionData(name, callArgs) });
    return iface.decodeFunctionResult(name, raw)[0];
  } catch (_) {
    return null;
  }
}

async function quoteErc4626RedeemExit(provider, curvePools, tokenIn, tokenOut, amountIn) {
  const shares = toBigInt(amountIn, 0n);
  if (shares <= 0n) return [];
  const asset = normalizeAddress(await safeCall(provider, tokenIn, ERC4626, "asset", []).catch(() => null));
  if (!asset || sameAddress(asset, tokenIn)) return [];
  let assetsOut = toBigInt(await safeCall(provider, tokenIn, ERC4626, "previewRedeem", [shares]).catch(() => 0n), 0n);
  if (assetsOut <= 0n) assetsOut = toBigInt(await safeCall(provider, tokenIn, ERC4626, "convertToAssets", [shares]).catch(() => 0n), 0n);
  if (assetsOut <= 0n) return [];
  if (sameAddress(asset, tokenOut)) {
    return [{ source: "ERC4626 previewRedeem direct", pathKind: "erc4626-redeem-direct", amountOutRaw: assetsOut, gasEstimate: 0n, path: { vault: normalizeAddress(tokenIn), asset, previewRedeemAssetsRaw: assetsOut.toString() } }];
  }
  const tails = await quoteExitCandidates(provider, curvePools, asset, tokenOut, assetsOut, false).catch(() => []);
  return tails.map((tail) => ({
    source: `ERC4626 previewRedeem + ${tail.source}`,
    pathKind: `erc4626-redeem-to-${tail.pathKind}`,
    amountOutRaw: tail.amountOutRaw,
    gasEstimate: toBigInt(tail.gasEstimate),
    path: { vault: normalizeAddress(tokenIn), asset, previewRedeemAssetsRaw: assetsOut.toString(), tail: tail.path },
  }));
}

async function quoteExitCandidates(provider, curvePools, tokenIn, tokenOut, amountIn, includeRedeem = true) {
  const candidates = [];
  candidates.push(...await quotePath(provider, amountIn, tokenIn, tokenOut).catch(() => []));
  candidates.push(...await quoteCurveExactInput(provider, curvePools, tokenIn, tokenOut, amountIn).catch(() => []));
  candidates.push(...await quoteCurveHops(provider, curvePools, tokenIn, tokenOut, amountIn).catch(() => []));
  candidates.push(...await quoteBalancerExactInput(provider, tokenIn, tokenOut, amountIn).catch(() => []));
  if (includeRedeem) candidates.push(...await quoteErc4626RedeemExit(provider, curvePools, tokenIn, tokenOut, amountIn).catch(() => []));
  return candidates.sort((a, b) => (a.amountOutRaw > b.amountOutRaw ? -1 : a.amountOutRaw < b.amountOutRaw ? 1 : 0));
}

async function ethUsd(provider) {
  try {
    const [roundRaw, decimalsRaw] = await Promise.all([
      provider.call({ to: ETH_FEED, data: FEED.encodeFunctionData("latestRoundData", []) }),
      provider.call({ to: ETH_FEED, data: FEED.encodeFunctionData("decimals", []) }),
    ]);
    const [, answer] = FEED.decodeFunctionResult("latestRoundData", roundRaw);
    const [decimals] = FEED.decodeFunctionResult("decimals", decimalsRaw);
    return Number(answer) / 10 ** Number(decimals);
  } catch (_) {
    return null;
  }
}

function amountFromUsd(usd, priceUsd, decimals) {
  if (!(usd > 0) || !(priceUsd > 0) || !Number.isFinite(Number(decimals))) return 0n;
  return ethers.parseUnits(String((usd / priceUsd).toFixed(Math.min(12, Number(decimals)))), Number(decimals));
}

function usdFromRaw(raw, decimals, priceUsd) {
  if (!raw || !(priceUsd > 0)) return 0;
  return Number(ethers.formatUnits(raw, Number(decimals))) * priceUsd;
}

function shadowCandidates(watch) {
  const latest = watch?.latest || {};
  const rows = [
    ...(Array.isArray(latest.materialTriggerRows) ? latest.materialTriggerRows : []),
    ...(Array.isArray(latest.triggerRows) ? latest.triggerRows : []),
    ...(Array.isArray(latest.topRows) ? latest.topRows : []),
  ];
  const seen = new Set();
  return rows
    .filter((row) => row && row.user && row.spoke)
    .filter((row) => {
      const key = `${String(row.spoke).toLowerCase()}:${String(row.user).toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter((row) => (asNumber(row.debtUsd) || 0) > 0)
    .filter((row) => (asNumber(row.bpsToLiquidation) ?? Infinity) <= TRIGGER_BPS)
    .sort((a, b) => (asNumber(a.bpsToLiquidation) ?? Infinity) - (asNumber(b.bpsToLiquidation) ?? Infinity) || (asNumber(b.debtUsd) || 0) - (asNumber(a.debtUsd) || 0))
    .slice(0, MAX_ROWS);
}

async function quoteShadowRow(provider, curvePools, gasUsd, quoteRow, detail, assetIndex) {
  const reserves = Array.isArray(detail.user.reserves) ? detail.user.reserves : [];
  const debts = reserves.filter((r) => (asNumber(r.debtUsd) || 0) > 0).map((r) => tokenMeta(assetIndex, detail.spoke.hub, r));
  const collaterals = reserves.filter((r) => r.usingAsCollateral !== false && (asNumber(r.suppliedUsd) || 0) > 0).map((r) => tokenMeta(assetIndex, detail.spoke.hub, r));
  const pairs = [];
  for (const debt of debts) {
    for (const collateral of collaterals) {
      if (!debt.address || !collateral.address || debt.address.toLowerCase() === collateral.address.toLowerCase()) continue;
      const debtUsd = asNumber(debt.debtUsd) || 0;
      const collateralUsd = asNumber(collateral.suppliedUsd) || 0;
      const debtPrice = asNumber(debt.priceUsd);
      const collateralPrice = asNumber(collateral.priceUsd);
      const debtDecimals = asNumber(debt.decimals);
      const collateralDecimals = asNumber(collateral.decimals);
      const bonusBps = asNumber(collateral.liquidationBonusBps) || 10000;
      if (!(debtUsd > 0) || !(collateralUsd > 0) || !(debtPrice > 0) || !(collateralPrice > 0)) continue;
      pairs.push({ debt, collateral, debtUsd, collateralUsd, debtPrice, collateralPrice, debtDecimals, collateralDecimals, bonusBps, sizeUsd: Math.min(debtUsd, collateralUsd) });
    }
  }

  const rows = [];
  for (const pair of pairs.sort((a, b) => b.sizeUsd - a.sizeUsd).slice(0, PAIR_LIMIT_PER_ROW)) {
    const maxRepayUsd = Math.min(pair.debtUsd, pair.collateralUsd * 10000 / Math.max(10000, pair.bonusBps));
    for (const fraction of SIZE_FRACTIONS) {
      const repayUsd = maxRepayUsd * fraction;
      const repayRaw = amountFromUsd(repayUsd, pair.debtPrice, pair.debtDecimals);
      const seizedCollateralUsd = repayUsd * pair.bonusBps / 10000;
      const seizedCollateralRaw = amountFromUsd(seizedCollateralUsd, pair.collateralPrice, pair.collateralDecimals);
      if (repayRaw <= 0n || seizedCollateralRaw <= 0n) continue;
      const quotes = await quoteExitCandidates(provider, curvePools, pair.collateral.address, pair.debt.address, seizedCollateralRaw);
      const best = quotes[0] || null;
      const exitUsd = best ? usdFromRaw(best.amountOutRaw, pair.debtDecimals, pair.debtPrice) : 0;
      const grossProfitUsd = exitUsd - repayUsd;
      const slippageUsd = repayUsd * SLIPPAGE_BPS / 10000;
      const netProfitUsd = grossProfitUsd - slippageUsd - gasUsd;
      const liquidatableNow = Boolean(quoteRow.liquidatable) || (asNumber(quoteRow.healthFactor) || 2) < 1;
      rows.push({
        user: quoteRow.user,
        hub: quoteRow.hub,
        spoke: quoteRow.spoke,
        shadowOnly: !liquidatableNow,
        healthFactor: round(quoteRow.healthFactor, 9),
        bpsToLiquidation: round(quoteRow.bpsToLiquidation, 2),
        fraction,
        repay: { symbol: pair.debt.symbol, reserveId: pair.debt.reserveId, address: pair.debt.address, decimals: pair.debtDecimals, priceUsd: round(pair.debtPrice, 8), amountUsd: round(repayUsd, 2), amountRaw: repayRaw },
        collateral: { symbol: pair.collateral.symbol, reserveId: pair.collateral.reserveId, address: pair.collateral.address, decimals: pair.collateralDecimals, priceUsd: round(pair.collateralPrice, 8), seizedUsd: round(seizedCollateralUsd, 2), seizedRaw: seizedCollateralRaw, liquidationBonusBps: pair.bonusBps },
        quote: best ? {
          source: best.source || "unknown exact-input quote",
          pathKind: best.pathKind || null,
          path: best.path || { tokens: (best.tokens || []).map((token) => token.slice(0, 10)), fees: best.fees || [] },
          fees: best.fees || null,
          amountOutRaw: best.amountOutRaw,
          amountOutUsd: round(exitUsd, 2),
          gasEstimate: best.gasEstimate,
        } : null,
        grossProfitUsd: round(grossProfitUsd, 2),
        gasUsd: round(gasUsd, 2),
        slippageUsd: round(slippageUsd, 2),
        netProfitUsd: round(netProfitUsd, 2),
        shadowResearchPositive: netProfitUsd > MIN_NET_PROFIT_USD,
        routePositive: false,
        blockers: [
          liquidatableNow ? "Aave V4 liquidation staticCall/fork extraction proof is not validated" : "Borrower is not currently liquidatable; this is pre-trigger shadow economics only",
          best ? "Repay-token source/flash route and fork extraction proof are not validated" : "No exact collateral-exit quote found through configured Uniswap V3/Curve/ERC4626 paths",
          ...(best && netProfitUsd <= MIN_NET_PROFIT_USD ? ["Shadow exit quote is not profitable after gas/slippage"] : []),
        ],
      });
    }
  }
  return rows;
}

async function main() {
  const watch = loadJson(WATCH_FILE, {});
  const candidates = shadowCandidates(watch);
  const outBase = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/quote-aave-v4-shadow-liquidation-routes.js",
    scope: "Aave V4 near-liquidation shadow quote artifact",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    sourceArtifacts: {
      watch: path.relative(WORKSPACE, WATCH_FILE),
      borrowers: path.relative(WORKSPACE, BORROWERS_FILE),
      hubs: path.relative(WORKSPACE, HUBS_FILE),
    },
    gates: {
      routePositiveRequires: [
        "borrower is currently liquidatable",
        "exact collateral-exit quote positive after gas/slippage",
        "repay-token acquisition or flash source validated",
        "Aave V4 liquidation staticCall/fork extraction proof",
      ],
    },
  };

  if (!candidates.length) {
    const out = {
      ...outBase,
      summary: {
        shadowCandidateRows: 0,
        shadowRowsQuoted: 0,
        shadowResearchPositiveRoutes: 0,
        routePositive: 0,
        signedActionJustified: false,
        blocker: `No near-liquidation rows within ${TRIGGER_BPS}bps were available to shadow-quote.`,
      },
      rows: [],
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
    if (!QUIET) console.log(`Aave V4 shadow quotes: no candidates; wrote ${path.relative(WORKSPACE, OUT)}`);
    return;
  }

  const rpcUrl = await resolveRpcUrl(ETHEREUM_CHAIN_ID);
  if (!rpcUrl) throw new Error("No Ethereum RPC endpoint resolved from local inventory");
  const provider = new ethers.JsonRpcProvider(rpcUrl, { chainId: ETHEREUM_CHAIN_ID, name: "ethereum" }, { staticNetwork: true });
  const [gasPriceRaw, ethPriceUsd, borrowers, hubs, curvePools] = await Promise.all([
    provider.send("eth_gasPrice", []).then(BigInt),
    ethUsd(provider),
    Promise.resolve(loadJson(BORROWERS_FILE, {})),
    Promise.resolve(loadJson(HUBS_FILE, {})),
    fetchCurvePools().catch(() => []),
  ]);
  const assetIndex = buildAssetIndex(hubs);
  const gasEthPriceUsd = ethPriceUsd || asNumber(assetIndex.bySymbol.get("weth")?.priceUsd) || asNumber(assetIndex.bySymbol.get("eth")?.priceUsd) || 0;
  const gasUsd = gasEthPriceUsd ? (GAS_UNITS * Number(gasPriceRaw) / 1e18) * gasEthPriceUsd : 0;
  const rows = [];
  const missingDetails = [];
  for (const candidate of candidates) {
    const detail = findBorrowerDetail(borrowers, candidate);
    if (!detail) {
      missingDetails.push({ user: candidate.user, spoke: candidate.spoke });
      continue;
    }
    rows.push(...await quoteShadowRow(provider, curvePools, gasUsd, candidate, detail, assetIndex));
  }

  rows.sort((a, b) => (asNumber(b.netProfitUsd) || -Infinity) - (asNumber(a.netProfitUsd) || -Infinity));
  const best = rows[0] || null;
  const closestCandidate = candidates[0] || null;
  const closestRows = closestCandidate
    ? rows.filter((row) => String(row.user).toLowerCase() === String(closestCandidate.user).toLowerCase()
      && String(row.spoke).toLowerCase() === String(closestCandidate.spoke).toLowerCase())
    : [];
  const closestBest = closestRows.slice().sort((a, b) => (asNumber(b.netProfitUsd) || -Infinity) - (asNumber(a.netProfitUsd) || -Infinity))[0] || null;
  const shadowPositive = rows.filter((row) => row.shadowResearchPositive).length;
  const out = {
    ...outBase,
    safety: { ...outBase.safety, rpcInventoryRead: true },
    config: {
      maxRows: MAX_ROWS,
      pairLimitPerRow: PAIR_LIMIT_PER_ROW,
      triggerBps: TRIGGER_BPS,
      curvePoolsDiscovered: curvePools.length,
    },
    gas: {
      gasPriceWei: gasPriceRaw,
      gasUnits: GAS_UNITS,
      ethPriceUsd: round(gasEthPriceUsd, 2),
      ethPriceSource: ethPriceUsd ? "chainlink" : gasEthPriceUsd ? "aave-hub-weth" : "unavailable",
      gasUsd: round(gasUsd, 2),
      slippageBps: SLIPPAGE_BPS,
      minNetProfitUsd: MIN_NET_PROFIT_USD,
    },
    summary: {
      shadowCandidateRows: candidates.length,
      shadowRowsQuoted: rows.length,
      shadowResearchPositiveRoutes: shadowPositive,
      bestNetProfitUsd: round(best?.netProfitUsd, 2),
      bestGrossProfitUsd: round(best?.grossProfitUsd, 2),
      bestRepayUsd: round(best?.repay?.amountUsd, 2),
      bestPair: best ? `${best.collateral.symbol}->${best.repay.symbol}` : null,
      bestSource: best?.quote?.source || null,
      bestPathKind: best?.quote?.pathKind || null,
      closestBestNetProfitUsd: round(closestBest?.netProfitUsd, 2),
      closestBestGrossProfitUsd: round(closestBest?.grossProfitUsd, 2),
      closestBestRepayUsd: round(closestBest?.repay?.amountUsd, 2),
      closestBestFraction: round(closestBest?.fraction, 4),
      closestBestPair: closestBest ? `${closestBest.collateral.symbol}->${closestBest.repay.symbol}` : null,
      closestBestSource: closestBest?.quote?.source || null,
      closestBestPathKind: closestBest?.quote?.pathKind || null,
      closestBpsToLiquidation: round(Math.min(...candidates.map((row) => asNumber(row.bpsToLiquidation) ?? Infinity)), 2),
      routePositive: 0,
      signedActionJustified: false,
      blocker: shadowPositive > 0
        ? "Shadow exit quote is positive, but borrower is not currently liquidatable and repay/staticCall/fork proof are not validated."
        : "No shadow collateral-exit quote is positive after gas/slippage.",
      missingDetails,
    },
    candidates: candidates.map((row) => ({
      user: row.user,
      hub: row.hub,
      spoke: row.spoke,
      healthFactor: row.healthFactor,
      bpsToLiquidation: row.bpsToLiquidation,
      debtUsd: row.debtUsd,
      topDebt: row.topDebt,
      topCollateral: row.topCollateral,
    })),
    rows: rows.slice(0, 50),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
  if (!QUIET) console.log(`Aave V4 shadow quotes: rows=${rows.length} shadowPositive=${shadowPositive} routePositive=0`);
}

main().catch((err) => {
  console.error(`quote-aave-v4-shadow-liquidation-routes failed: ${err?.message || String(err)}`);
  process.exitCode = 1;
});
