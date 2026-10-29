#!/usr/bin/env node
// quote-aave-v4-liquidation-trigger.js - fail-closed exact-quote scaffold for Aave V4 liquidatable rows.
// RPC URLs are resolved in memory only, never printed or written.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const context = require("./lib/aave-v4-quote-context");

const WORKSPACE = path.resolve(__dirname, "..");
const WATCH_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-watch.json");
const BORROWERS_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-spoke-borrowers.json");
const HUBS_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-hubs.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-quotes.json");

const QUIET = process.argv.includes("--quiet");
const INCLUDE_NEAR_LIQUIDATION = process.argv.includes("--include-near-liquidation");
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const ZERO = ethers.ZeroAddress;
const SLIPPAGE_BPS = Number(process.env.AAVE_V4_LIQUIDATION_SLIPPAGE_BPS || "100");
const MIN_NET_PROFIT_USD = Number(process.env.AAVE_V4_MIN_NET_PROFIT_USD || "25");
const CURVE_MAX_POOLS_PER_PAIR = context.LIMITS.pools;
const BALANCER_MAX_POOLS_PER_PAIR = context.LIMITS.pools;
const SIZE_FRACTIONS = String(argValue("--size-fractions") || process.env.AAVE_V4_LIQUIDATION_SIZE_FRACTIONS || "0.1,0.25,0.5,1")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0 && x <= 1).slice(0, context.LIMITS.sizes);
const FEES = [100, 500, 3000, 10000];

const QUOTER = new ethers.Interface([
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
const CURVE_INT128 = new ethers.Interface(["function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)"]);
const CURVE_UINT256 = new ethers.Interface(["function get_dy(uint256 i,uint256 j,uint256 dx) view returns (uint256)"]);
const CURVE_COINS = new ethers.Interface(["function coins(uint256) view returns (address)"]);
const CURVE_MAX_COINS = 8;
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
  "function convertToAssets(uint256 shares) view returns (uint256 assets)",
]);
const BALANCER = new ethers.Interface([
  "function queryBatchSwap(uint8 kind,(bytes32 poolId,uint256 assetInIndex,uint256 assetOutIndex,uint256 amount,bytes userData)[] swaps,address[] assets,(address sender,bool fromInternalBalance,address recipient,bool toInternalBalance) funds) returns (int256[] assetDeltas)",
]);
const HUB = new ethers.Interface([
  "function previewAddByAssets(uint256 assetId,uint256 assets) view returns (uint256)",
  "function previewRemoveByShares(uint256 assetId,uint256 shares) view returns (uint256)",
]);
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL = new ethers.Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])",
]);

const balancerPairCaches = new WeakMap();

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
  USDe: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
  sUSDe: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
  USDG: "0xe343167631d89B6Ffc58B88d6b7fB0228795491D",
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

async function discoveryJson(session, url, options = {}) {
  return session.discover(async signal => {
    const res = await fetch(url, { ...options, redirect: "error", signal });
    if (!res.ok) throw new context.QuoteError("DISCOVERY_HTTP_UNAVAILABLE");
    // Bound bytes as well as dispatch/time; discovery is never evidence of state.
    const chunks = []; let bytes = 0;
    for await (const chunk of res.body) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new context.QuoteError("DISCOVERY_RESPONSE_CAP");
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  });
}

async function fetchCurvePools(session) {
  const registries = ["main", "factory", "factory-stable-ng", "crypto", "factory-crypto"];
  const pools = [];
  for (const registry of registries) {
    const json = await discoveryJson(session, `https://api.curve.fi/v1/getPools/ethereum/${registry}`).catch(() => null);
    for (const p of (json?.data?.poolData || []).slice(0, 32)) {
      const address = normalizeAddress(p.address);
      const coins = (p.coins || []).slice(0, CURVE_MAX_COINS).map((coin, index) => ({
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
  const bySpokeReserve = new Map();
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
      for (const spoke of asset.spokeDirectory?.rows || []) {
        if (spoke.reserve?.reserveId === null || spoke.reserve?.reserveId === undefined) continue;
        bySpokeReserve.set(`${lowerAddress(spoke.address)}:${spoke.reserve.reserveId}`, {
          ...row, liquidationConfig: spoke.reserve.liquidationConfig,
        });
      }
      const key = String(asset.symbol || "").toLowerCase();
      const existing = bySymbol.get(key) || {};
      bySymbol.set(key, { ...existing, ...row, underlying: row.underlying || existing.underlying });
    }
  }
  return { byHubAsset, bySymbol, bySpokeReserve };
}

function findBorrowerDetail(borrowers, quoteRow) {
  for (const spoke of borrowers?.spokes || []) {
    if (quoteRow.spoke && String(spoke.spoke).toLowerCase() !== String(quoteRow.spoke).toLowerCase()) continue;
    for (const user of spoke.topUsers || []) {
      if (String(user.user).toLowerCase() === String(quoteRow.user).toLowerCase()) return { spoke, user };
    }
  }
  const user = (borrowers?.topUsers || []).find(user => sameAddress(user.user, quoteRow.user)
    && (!quoteRow.spoke || sameAddress(user.spoke, quoteRow.spoke)));
  if (user) return {
    spoke: (borrowers.spokes || []).find(spoke => sameAddress(spoke.spoke, user.spoke)) || { hub: user.hub, spoke: user.spoke },
    user,
  };
  return null;
}

function tokenMeta(assetIndex, hubName, reserve, spokeAddress = null) {
  const meta = assetIndex.bySpokeReserve?.get(`${lowerAddress(spokeAddress)}:${reserve.reserveId}`);
  if (!meta?.identityBound) throw new context.QuoteError("PINNED_IDENTITY_REQUIRED");
  return {
    reserveId: reserve.reserveId,
    assetId: meta.assetId,
    hubAddress: meta.hubAddress,
    symbol: reserve.symbol || meta.symbol || null,
    address: meta.underlying || null,
    decimals: meta.decimals,
    priceUsd: meta.priceOracleUnit,
    oracle: meta.oracle, oracleSource: meta.oracleSource, oraclePriceRaw: meta.oraclePriceRaw,
    oracleDecimals: meta.oracleDecimals, oracleQualification: meta.oracleQualification,
    positionDynamicConfigKey: meta.positionDynamicConfigKey, currentDynamicConfigKey: meta.currentDynamicConfigKey,
    debtRaw: reserve.debtRaw || null,
    suppliedRaw: reserve.suppliedRaw || null,
    debtUsd: reserve.debtUsd || null,
    suppliedUsd: reserve.suppliedUsd || null,
    liquidationBonusBps: meta.liquidationBonusBps,
    collateralFactorBps: meta.collateralFactorBps,
    liquidationFeeBps: meta.liquidationFeeBps,
    liquidationConfig: meta.liquidationConfig || null,
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
    .filter((mid) => mid && mid.toLowerCase() !== tokenIn.toLowerCase() && mid.toLowerCase() !== tokenOut.toLowerCase()).slice(0, context.LIMITS.mids);
  const routed = [];
  for (const mid of mids) {
    for (const f0 of [100, 500, 3000]) {
      for (const f1 of [100, 500, 3000]) routed.push({ tokens: [tokenIn, mid, tokenOut], fees: [f0, f1], label: `${f0}/${String(mid).slice(0, 8)}/${f1}` });
    }
  }
  return [...direct, ...routed].slice(0, context.LIMITS.paths);
}

async function quotePath(provider, amountInRaw, tokenIn, tokenOut) {
  const session = context.sessionFor(provider);
  session.truncation.add("BOUNDED_UNISWAP_PATH_SEARCH");
  await session.captureRuntime(QUOTER_V2);
  const out = [];
  const paths = candidatePaths(tokenIn, tokenOut);
  // Bound each batch instead of serializing hundreds of mostly nonexistent
  // paths per size. Calls retain individual success/revert accounting.
  for (let start = 0; start < paths.length; start += 32) {
    const batch = paths.slice(start, start + 32);
    const calls = batch.map(pathDef => ({ target: QUOTER_V2, allowFailure: true,
      callData: QUOTER.encodeFunctionData("quoteExactInput", [encodePath(pathDef.tokens, pathDef.fees), amountInRaw]),
    }));
    let results;
    try {
      const raw = await provider.call({ to: MULTICALL3, data: MULTICALL.encodeFunctionData("aggregate3", [calls]) });
      [results] = MULTICALL.decodeFunctionResult("aggregate3", raw);
      if (results.length !== batch.length) throw new Error("quote-batch-invalid");
    } catch (_) {
      results = [];
      for (const call of calls) {
        const raw = await provider.call({ to: call.target, data: call.callData }).catch(() => null);
        results.push({ success: Boolean(raw), returnData: raw || "0x" });
      }
    }
    results.forEach((result, index) => {
      if (!result.success) return;
      const pathDef = batch[index];
      try {
        const raw = result.returnData;
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
    });
  }
  return out.sort((a, b) => (a.amountOutRaw > b.amountOutRaw ? -1 : a.amountOutRaw < b.amountOutRaw ? 1 : 0));
}

function findCurvePools(curvePools, tokenIn, tokenOut) {
  const input = lowerAddress(tokenIn);
  const output = lowerAddress(tokenOut);
  if (!input || !output || input === output) return [];
  return (curvePools || []).map((pool) => {
    const i = pool.coins?.find((coin) => lowerAddress(coin.address) === input);
    const j = pool.coins?.find((coin) => lowerAddress(coin.address) === output);
    return i && j && !pool.isBroken ? { ...pool, i, j } : null;
  }).filter(Boolean)
    .sort((a, b) => Number(b.usdTotal || 0) - Number(a.usdTotal || 0))
    .slice(0, CURVE_MAX_POOLS_PER_PAIR);
}

async function curveCoinBinding(provider, pool, tokenIn, tokenOut) {
  context.sessionFor(provider); // Including on any future context-local cache hit.
  const target = normalizeAddress(pool.address), input = lowerAddress(tokenIn), output = lowerAddress(tokenOut);
  const indices = [pool.i.index, pool.j.index];
  if (!target || !input || !output || input === output || input === ZERO || output === ZERO
    || indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= CURVE_MAX_COINS)
    || indices[0] === indices[1]) return null;
  const observed = [];
  for (const index of indices) {
    let raw;
    try { raw = await provider.call({ to: target, data: CURVE_COINS.encodeFunctionData("coins", [index]) }); }
    catch (error) {
      if (error.code === "CALL_EXCEPTION") return null; // Unsupported identity getter: exclude, never trust discovery.
      throw error; // Transport/budget failures stay poisoned even if a caller catches them.
    }
    try { observed.push(lowerAddress(CURVE_COINS.decodeFunctionResult("coins", raw)[0])); }
    catch (_) { return null; }
  }
  if (observed[0] !== input || observed[1] !== output) return null;
  return { status: "PINNED_COIN_INDICES", signature: "coins(uint256)", indices, tokens: observed };
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
    const identity = await curveCoinBinding(provider, pool, tokenIn, tokenOut);
    if (!identity) continue;
    const amountOut = await curveGetDy(provider, pool, pool.i.index, pool.j.index, amountIn).catch(() => null);
    if (!amountOut || amountOut <= 0n) continue;
    out.push({
      source: pool.source,
      pathKind: "curve-direct",
      amountOutRaw: amountOut,
      gasEstimate: 0n,
      path: { pool: pool.address, name: pool.name, tokenIn: identity.tokens[0], tokenOut: identity.tokens[1], coinIn: pool.i, coinOut: pool.j, identity },
    });
  }
  return out;
}

function hopCandidates(tokenIn, tokenOut) {
  return [...new Set(Object.values(COMMON).map(normalizeAddress).filter(Boolean).map((x) => x.toLowerCase()))]
    .map((x) => ethers.getAddress(x))
    .filter((mid) => !sameAddress(mid, tokenIn) && !sameAddress(mid, tokenOut))
    .slice(0, context.LIMITS.mids);
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

async function fetchBalancerPoolsForPair(provider, tokenIn, tokenOut) {
  const session = context.sessionFor(provider);
  if (!balancerPairCaches.has(provider)) balancerPairCaches.set(provider, new Map());
  const balancerPairCache = balancerPairCaches.get(provider);
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
    try {
      const json = await discoveryJson(session, endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables: { tokens: [a, b] } }),
      });
      const rows = (json?.data?.pools || []).slice(0, BALANCER_MAX_POOLS_PER_PAIR).map((p) => ({
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
    }
  }
  balancerPairCache.set(key, []);
  return [];
}

async function quoteBalancerExactInput(provider, tokenIn, tokenOut, amountIn) {
  const pools = await fetchBalancerPoolsForPair(provider, tokenIn, tokenOut).catch(() => []);
  const candidates = [];
  for (const pool of pools) {
    try {
      await context.sessionFor(provider).captureRuntime(pool.address);
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
  context.sessionFor(provider);
  const candidates = [];
  candidates.push(...await quotePath(provider, amountIn, tokenIn, tokenOut).catch(() => []));
  candidates.push(...await quoteCurveExactInput(provider, curvePools, tokenIn, tokenOut, amountIn).catch(() => []));
  candidates.push(...await quoteCurveHops(provider, curvePools, tokenIn, tokenOut, amountIn).catch(() => []));
  candidates.push(...await quoteBalancerExactInput(provider, tokenIn, tokenOut, amountIn).catch(() => []));
  if (includeRedeem) candidates.push(...await quoteErc4626RedeemExit(provider, curvePools, tokenIn, tokenOut, amountIn).catch(() => []));
  return candidates.sort((a, b) => (a.amountOutRaw > b.amountOutRaw ? -1 : a.amountOutRaw < b.amountOutRaw ? 1 : 0));
}

function amountFromUsd(usd, priceUsd, decimals) {
  if (!(usd > 0) || !(priceUsd > 0) || !Number.isFinite(Number(decimals))) return 0n;
  return ethers.parseUnits(String((usd / priceUsd).toFixed(Math.min(12, Number(decimals)))), Number(decimals));
}

function usdFromRaw(raw, decimals, priceUsd) {
  if (!raw || !(priceUsd > 0)) return 0;
  return Number(ethers.formatUnits(raw, Number(decimals))) * priceUsd;
}

async function liquidatorCollateral(provider, collateral, grossRaw, bonusBps, feeBps, netBonusBps) {
  const fallback = grossRaw * BigInt(netBonusBps) / BigInt(bonusBps);
  if (!collateral.hubAddress || collateral.assetId === null || collateral.assetId === undefined) {
    return { receivedRaw: fallback, exactShareFee: false };
  }
  const shares = await safeCall(provider, collateral.hubAddress, HUB, "previewAddByAssets", [collateral.assetId, grossRaw]);
  if (shares === null) return { receivedRaw: fallback, exactShareFee: false };
  const grossShares = BigInt(shares);
  const numerator = grossShares * BigInt(feeBps) * BigInt(bonusBps - 10000);
  const denominator = BigInt(bonusBps) * 10000n;
  const feeShares = (numerator + denominator - 1n) / denominator;
  const receivedShares = grossShares - feeShares;
  const receivedRaw = await safeCall(provider, collateral.hubAddress, HUB, "previewRemoveByShares", [collateral.assetId, receivedShares]);
  if (receivedRaw === null) return { receivedRaw: fallback, exactShareFee: false };
  return { receivedRaw: BigInt(receivedRaw), exactShareFee: true, grossShares, feeShares, receivedShares };
}

async function quotePair(provider, curvePools, gasUsd, quoteRow, detail, assetIndex) {
  const session = context.assertPrepared(provider, assetIndex, quoteRow, detail);
  const gas = gasUsd;
  gasUsd = gas?.valid === true ? gas.gasUsd : null;
  if (!Number.isFinite(SLIPPAGE_BPS) || SLIPPAGE_BPS < 0 || SLIPPAGE_BPS > 10000 || !SIZE_FRACTIONS.length) throw new context.QuoteError("QUOTE_SETTINGS_INVALID");
  const reserves = Array.isArray(detail.user.reserves) ? detail.user.reserves : [];
  const debts = reserves.filter((r) => (asNumber(r.debtUsd) || 0) > 0).map((r) => tokenMeta(assetIndex, detail.spoke.hub, r, quoteRow.spoke));
  const collaterals = reserves.filter((r) => r.usingAsCollateral !== false && (asNumber(r.suppliedUsd) || 0) > 0).map((r) => tokenMeta(assetIndex, detail.spoke.hub, r, quoteRow.spoke));
  const observedHealthFactor = asNumber(detail.user.account?.healthFactor ?? quoteRow.healthFactor);
  const nearLiquidationPreQuote = quoteRow.nearLiquidationPreQuote === true && observedHealthFactor >= 1;
  const modeledHealthFactor = nearLiquidationPreQuote ? 0.9999 : observedHealthFactor;
  const totalDebtUsd = debts.reduce((sum, debt) => sum + (asNumber(debt.debtUsd) || 0), 0);
  const rows = [];

  let pairs = 0;
  for (const debt of debts) {
    for (const collateral of collaterals) {
      if (!debt.address || !collateral.address || debt.address.toLowerCase() === collateral.address.toLowerCase()) continue;
      if (++pairs > context.LIMITS.pairs) { session.truncation.add("PAIR_CAP"); break; }
      const debtUsd = asNumber(debt.debtUsd) || 0;
      const collateralUsd = asNumber(collateral.suppliedUsd) || 0;
      const debtPrice = asNumber(debt.priceUsd);
      const collateralPrice = asNumber(collateral.priceUsd);
      const debtDecimals = asNumber(debt.decimals);
      const collateralDecimals = asNumber(collateral.decimals);
       const bonusBps = asNumber(collateral.liquidationBonusBps);
      const collateralFactorBps = collateral.collateralFactorBps;
      const liquidationFeeBps = collateral.liquidationFeeBps;
      const targetHealthFactor = asNumber(detail.spoke?.liquidationConfig?.targetHealthFactor ?? collateral.liquidationConfig?.targetHealthFactor);
      if (!(debtUsd > 0) || !(collateralUsd > 0) || !(debtPrice > 0) || !(collateralPrice > 0)) continue;
      if (!(collateralFactorBps > 0) || !Number.isInteger(bonusBps) || bonusBps < 10000
          || !Number.isInteger(liquidationFeeBps) || liquidationFeeBps < 0 || liquidationFeeBps > 10000
          || !(targetHealthFactor >= 1) || modeledHealthFactor === null || modeledHealthFactor >= 1) continue;
      const penalty = bonusBps * collateralFactorBps / 100000000;
      if (!(targetHealthFactor > penalty)) continue;
      const targetHfCloseFraction = Math.min(1, Math.max(0,
        (targetHealthFactor - modeledHealthFactor) / (targetHealthFactor - penalty)));
      const netBonusBps = 10000 + Math.floor((bonusBps - 10000) * (10000 - liquidationFeeBps) / 10000);
      const maxRepayUsd = Math.min(debtUsd, collateralUsd * 10000 / bonusBps, totalDebtUsd * targetHfCloseFraction);
      // Pre-stage the target-HF-sized unwind once; the live trigger retains its
      // existing configured size ladder.
      for (const fraction of nearLiquidationPreQuote ? [1] : SIZE_FRACTIONS) {
        const requestedRaw = amountFromUsd(maxRepayUsd * fraction, debtPrice, debtDecimals);
        const repayRaw = requestedRaw > BigInt(debt.debtRaw) ? BigInt(debt.debtRaw) : requestedRaw;
        const repayUsd = usdFromRaw(repayRaw, debtDecimals, debtPrice);
        let grossSeizedRaw = amountFromUsd(repayUsd * bonusBps / 10000, collateralPrice, collateralDecimals);
        const suppliedRaw = toBigInt(collateral.suppliedRaw, grossSeizedRaw);
        if (grossSeizedRaw > suppliedRaw) grossSeizedRaw = suppliedRaw;
        const received = await liquidatorCollateral(provider, collateral, grossSeizedRaw, bonusBps, liquidationFeeBps, netBonusBps);
        if (!received.exactShareFee) session.fatal.add("REQUIRED_HUB_PREVIEW_UNAVAILABLE");
        const seizedCollateralRaw = received.receivedRaw;
        const seizedCollateralUsd = usdFromRaw(seizedCollateralRaw, collateralDecimals, collateralPrice);
        if (repayRaw <= 0n || seizedCollateralRaw <= 0n) continue;
        const funding = await session.funding(debt.address, repayRaw);
        const quotes = await quoteExitCandidates(provider, curvePools, collateral.address, debt.address, seizedCollateralRaw);
        const best = quotes[0] || null;
        const exitUsd = best ? usdFromRaw(best.amountOutRaw, debtDecimals, debtPrice) : 0;
        const grossProfitUsd = exitUsd - repayUsd;
        const slippageUsd = repayUsd * SLIPPAGE_BPS / 10000;
        const netProfitUsd = gasUsd === null || !best ? null : grossProfitUsd - slippageUsd - gasUsd;
        rows.push({
          user: quoteRow.user,
          hub: quoteRow.hub,
          spoke: quoteRow.spoke,
          fraction,
          observedHealthFactor,
          modeledHealthFactor,
          targetHealthFactor,
          targetHfCloseFraction,
          nearLiquidationPreQuote,
          signedActionJustified: false, currentQualified: false, freshnessQualified: false,
          executableNow: false,
          valuationDenomination: "UNKNOWN_ORACLE_UNIT_USD_FIELDS_PROVISIONAL",
          oracleQualification: session.oracleQualification,
          observationPin: session.validated.pin,
          funding,
          config: { positionKey: collateral.positionDynamicConfigKey, currentKey: collateral.currentDynamicConfigKey },
          repay: { symbol: debt.symbol, reserveId: debt.reserveId, hubAddress: debt.hubAddress, assetId: debt.assetId,
            address: debt.address, decimals: debtDecimals, priceUsd: round(debtPrice, 8), amountUsd: round(repayUsd, 2), amountRaw: repayRaw,
            oracle: debt.oracle, oracleSource: debt.oracleSource, oraclePriceRaw: debt.oraclePriceRaw, oracleDecimals: debt.oracleDecimals },
          collateral: {
            symbol: collateral.symbol, reserveId: collateral.reserveId, address: collateral.address, decimals: collateralDecimals,
            hubAddress: collateral.hubAddress, assetId: collateral.assetId,
            oracle: collateral.oracle, oracleSource: collateral.oracleSource, oraclePriceRaw: collateral.oraclePriceRaw, oracleDecimals: collateral.oracleDecimals,
            priceUsd: round(collateralPrice, 8), seizedUsd: round(seizedCollateralUsd, 2), seizedRaw: seizedCollateralRaw,
            grossSeizedRaw, liquidatorReceivedRaw: seizedCollateralRaw,
            liquidationBonusBps: bonusBps, netBonusBps, collateralFactorBps, liquidationFeeBps,
            grossSharesRaw: received.grossShares ?? null, liquidationFeeSharesRaw: received.feeShares ?? null,
            liquidatorReceivedSharesRaw: received.receivedShares ?? null,
            exactShareFee: received.exactShareFee,
            amountSemantics: "Hub share fee exact for modeled seizure; full liquidation/staticCall remains unvalidated",
          },
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
          economicsStatus: gas?.valid && best ? "PROVISIONAL_VIEW_ASSUMPTIONS" : "UNAVAILABLE",
          gasUsd: round(gasUsd, 2),
          slippageUsd: round(slippageUsd, 2),
          netProfitUsd: round(netProfitUsd, 2),
          researchPositive: false,
          hypotheticalResearchPositive: false,
          routePositive: false,
          blockers: [
            "Oracle denomination, source heartbeat freshness and reviewed-runtime qualification are UNKNOWN",
            "Full-path cost, funding execution and immediate redemption cash are unproven; view arithmetic only",
            ...(!gas?.valid ? ["Gas projection unavailable; current economics invalid"] : []),
            ...(funding.status !== "PASS" ? ["Funding balance coverage missing or insufficient"] : []),
            ...(nearLiquidationPreQuote ? ["Hypothetical HF=0.9999 pre-quote only; observed user is not currently liquidatable"] : []),
            ...(!received.exactShareFee ? ["Hub collateral-share fee conversion is unavailable; amount is a conservative estimate"] : []),
            ...(best
            ? netProfitUsd === null ? ["Net economics unavailable; no profitability conclusion"]
              : netProfitUsd > MIN_NET_PROFIT_USD
              ? ["Repay-token execution and full-path payout are not validated"]
              : ["Exact collateral-exit quote is not profitable after gas/slippage"]
            : ["No exact collateral-exit quote found through configured Uniswap V3/Curve/ERC4626 paths"]),
          ],
        });
      }
    }
  }
  return rows.sort((a, b) => (asNumber(b.netProfitUsd) || -Infinity) - (asNumber(a.netProfitUsd) || -Infinity));
}

async function runQuotes(options = {}) {
  const now = options.now || Date.now;
  const sources = options.sources || { watch: loadJson(WATCH_FILE), borrowers: loadJson(BORROWERS_FILE), hubs: loadJson(HUBS_FILE) };
  const previous = options.previous || {};
  let preQuotes = context.historical(previous), quoteContext = null, capture = null, gas = null;
  let rows = [], nearRows = [], selected = [], failures = [];
  const validation = context.validateSources(sources, now(), options.consumerMaxAgeMs);
  const requiredRows = sources.watch?.latest?.quoteRequiredRows;
  const startedAt = new Date(now()).toISOString();
  if (!validation.valid) failures.push(...validation.failures);
  else {
    // Candidate enumeration may use cached ranking; authoritative amounts/prices
    // are replaced by quote-local same-pin reads before sizing any pair.
    selected = requiredRows.slice(0, context.LIMITS.candidates);
    if (!selected.length && options.includeNear) {
      selected = (sources.borrowers.topUsers || []).filter(user => {
        const hf = asNumber(user.account?.healthFactor);
        return hf !== null && hf >= 1 && hf < 1.015;
      }).slice(0, context.LIMITS.candidates).map(user => ({ user: user.user, spoke: user.spoke, nearLiquidationPreQuote: true }));
    }
    try {
      quoteContext = await context.begin(sources, { ...options,
        fundingEvidence: options.fundingEvidence === undefined
          ? loadJson(path.join(WORKSPACE, "reports/raw/fast/aave-v4-whale-liquidation-prestage-20261018.json"))?.funding
          : options.fundingEvidence });
      if ((requiredRows?.length || 0) > context.LIMITS.candidates) quoteContext.truncation.add("CANDIDATE_CAP");
      let curvePools = [];
      if (selected.length) {
        gas = await quoteContext.readGas(options.gasProjection);
        curvePools = options.curvePools === undefined ? await fetchCurvePools(quoteContext) : options.curvePools;
      }
      for (const row of selected) {
        const detail = findBorrowerDetail(sources.borrowers, row);
        if (!detail) throw new context.QuoteError("CAPTURED_USER_UNAVAILABLE");
        const hydrated = await quoteContext.prepareUser(detail, row);
        const quoted = await quotePair(quoteContext.provider, curvePools, gas, row, hydrated.detail, hydrated.assetIndex);
        (row.nearLiquidationPreQuote ? nearRows : rows).push(...quoted);
      }
    } catch (error) {
      // Never persist raw provider errors or arbitrary error messages.
      failures.push(context.failureCode(error));
    } finally {
      if (quoteContext) capture = await quoteContext.finalize();
    }
  }
  const finalValidation = context.validateSources(sources, now(), options.consumerMaxAgeMs);
  failures.push(...finalValidation.failures, ...(capture?.failures || []));
  // Missing cost assumptions do not invalidate otherwise bound state observations.
  // In contrast, source/state/terminal failures above still discard current rows.
  if (gas?.valid && !context.validGasProjection(gas.projection, now())) gas = {
    ...gas, valid: false, gasUsd: null, reason: "GAS_PROJECTION_STALE_AT_PUBLICATION",
  };
  const economicsUnavailable = selected.length && !gas?.valid
    ? ["CURRENT_ECONOMICS_UNAVAILABLE", gas?.reason || "GAS_PROJECTION_UNAVAILABLE"] : [];
  if (economicsUnavailable.length) for (const row of [...rows, ...nearRows]) {
    row.gasUsd = null; row.netProfitUsd = null; row.economicsStatus = "UNAVAILABLE";
    row.blockers = row.blockers.filter(blocker => blocker !== "Exact collateral-exit quote is not profitable after gas/slippage");
    row.blockers.push("Gas projection unavailable at publication; net economics unknown");
  }
  failures = [...new Set(failures)];
  const status = failures.length ? "UNAVAILABLE" : economicsUnavailable.length
    ? "PINNED_VIEW_UNPRICED_UNQUALIFIED" : "PINNED_VIEW_UNQUALIFIED";
  if (!failures.length && nearRows.length) preQuotes = {
    generatedAt: new Date(now()).toISOString(), startedAt, pin: capture.pin,
    observationPin: capture.attestation, status, current: true,
    currentQualified: false, freshnessQualified: false, rows: nearRows,
  };
  // Failed attempts never replace historical preQuotes or count them as current.
  if (failures.length) { rows = []; nearRows = []; }
  const artifact = {
    schema: "aave-v4-quote-context/v1", generatedAt: new Date(now()).toISOString(), startedAt,
    scanner: "tools/quote-aave-v4-liquidation-trigger.js", status,
    nearLiquidationPreQuotes: false, // hypothetical output is always separated
    observationPin: capture?.attestation || null, pin: capture?.pin || null,
    sourceObservationPin: validation.pin, sources: finalValidation.provenance,
    capture, gas, limits: context.LIMITS, failures,
    economics: { status: failures.length ? "UNAVAILABLE" : economicsUnavailable.length ? "UNAVAILABLE"
      : selected.length ? "PROVISIONAL_VIEW_ASSUMPTIONS" : "NOT_EVALUATED", reasons: economicsUnavailable },
    oracleQualification: quoteContext?.oracleQualification || { denomination: "UNKNOWN", heartbeat: "UNKNOWN", reviewedRuntime: "UNKNOWN" },
    constraints: ["Borrower HF/raw amounts reused from validated capture, not refreshed to head",
      "USD fields are provisional oracle-unit arithmetic; denomination/heartbeat/runtime qualification unknown",
      "No executed funding, fee, full-path cost, redemption cash or payout proof; all positive gates closed",
      "Gas requires a separately timestamped injected eth_gasPrice projection; pinned collector does not provide that method",
      "Without a valid gas projection, bound observations are retained but gas/net economics are null and all qualification gates remain closed",
      "Bounded candidate and venue enumeration; empty trigger list is not universal absence of liquidations"],
    safety: { rpcInventoryRead: Boolean(quoteContext), rpcUrlsStored: false, signedActions: false,
      routePositive: false, executableNow: false, signedActionJustified: false },
    researchPositive: false, freshnessQualified: false, currentQualified: false,
    routePositive: false, executableNow: false, signedActionJustified: false,
    summary: { quoteRequiredRows: Array.isArray(requiredRows) ? requiredRows.length : null,
      rowsQuoted: rows.length, currentPreQuoteRows: nearRows.length,
      researchPositiveRoutes: 0, hypotheticalResearchPositiveRoutes: 0, routePositive: 0,
      executableNow: false, signedActionJustified: false,
      blocker: failures.length ? "Required source/state/pin validation unavailable; current rows excluded"
        : economicsUnavailable.length ? "Pinned observations retained; gas/net economics unavailable and all qualification gates closed"
        : "View observations only; oracle qualification and execution remain unproven" },
    rows, ...(preQuotes ? { preQuotes } : {}),
  };
  return context.safeArtifact(artifact);
}

function atomicWrite(file, artifact) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`, { flag: "wx" }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

async function main(options = {}) {
  const output = options.output || argValue("--output") || OUT;
  const artifact = await runQuotes({ includeNear: INCLUDE_NEAR_LIQUIDATION,
    previous: loadJson(OUT, {}), ...options });
  atomicWrite(output, artifact);
  if (!QUIET) console.log(`Aave V4 quotes: status=${artifact.status} currentRows=${artifact.summary.rowsQuoted} qualifiedPositive=0`);
  return artifact;
}

if (require.main === module) main().catch(() => {
  console.error("quote-aave-v4-liquidation-trigger failed: quote-refresh-failed");
  process.exitCode = 1;
});

module.exports = { quotePair, tokenMeta, buildAssetIndex, candidatePaths, COMMON, runQuotes, main };
