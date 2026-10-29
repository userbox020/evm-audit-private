#!/usr/bin/env node
// Read-only WETH/yETH alternate-exit probe for the top current Morpho liquidation row.
// Resolves RPC URLs in memory only. Never stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("./node_modules/ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "morpho-yeth-alternate-exits.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "morpho-yeth-alternate-exits-triage.md");
const QUIET = process.argv.includes("--quiet");

const INPUTS = {
  e9Salvage: path.join(WORKSPACE, "reports", "raw", "fast", "e9-liquidation-salvage-routes.json"),
  currentLiquidatable: path.join(WORKSPACE, "reports", "raw", "fast", "current-liquidatable-exit-routes.json"),
  wrapperProof: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-wrapper-exit-proof-gaps.json"),
};

const ZERO = ethers.ZeroAddress;
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";
const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNISWAP_V3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const FEES = [100, 500, 3000, 10000];
const MAX_UNISWAP_PATHS = Number(process.env.YETH_EXIT_MAX_UNISWAP_PATHS || "120");
const CURVE_MAX_POOLS_PER_TOKEN = Number(process.env.YETH_EXIT_CURVE_MAX_POOLS_PER_TOKEN || "16");
const BALANCER_MAX_POOLS = Number(process.env.YETH_EXIT_BALANCER_MAX_POOLS || "12");
const BALANCER_MAX_TOKENS_PER_POOL = Number(process.env.YETH_EXIT_BALANCER_MAX_TOKENS_PER_POOL || "10");

const TOKENS = {
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  yETH: "0x8464F6eCAe1EA58EC816C13f964030eAb8Ec123A",
  WSTETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
  STETH: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
  RETH: "0xae78736Cd615f374D3085123A210448E74Fc6393",
  CBETH: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704",
  WEETH: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee",
  FRXETH: "0x5E8422345238F34275888049021821E8E08CAa1f",
  SFRXETH: "0xac3E018457B222d93114458476f3E3416Abbe38F",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
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
const WRAPPER_MANAGER = new ethers.Interface([
  "function manager() view returns (address)",
  "function maxRedeemCap(address yToken) view returns (uint256)",
  "function withdrawAssets(address yToken,address asset) view returns (bool)",
]);
const FACTORY = new ethers.Interface(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)"]);
const QUOTER = new ethers.Interface([
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
const CURVE_INT128 = new ethers.Interface(["function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)"]);
const CURVE_UINT256 = new ethers.Interface(["function get_dy(uint256 i,uint256 j,uint256 dx) view returns (uint256)"]);
const BALANCER = new ethers.Interface([
  "function queryBatchSwap(uint8 kind,(bytes32 poolId,uint256 assetInIndex,uint256 assetOutIndex,uint256 amount,bytes userData)[] swaps,address[] assets,(address sender,bool fromInternalBalance,address recipient,bool toInternalBalance) funds) returns (int256[] assetDeltas)",
]);

const poolCache = new Map();
const curveDyCache = new Map();

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

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

function asNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 6) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function formatUnitsNumber(value, decimals = 18) {
  try {
    const n = Number(ethers.formatUnits(toBigInt(value), decimals));
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

function compact(value, max = 120) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function loadRpcUrls() {
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
  for (const url of loadRpcUrls()) {
    try {
      if (Number(BigInt(await rpcCall(url, "eth_chainId", [], 6000))) === 1) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

async function fetchJson(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 20_000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function safeCall(provider, to, iface, fn, args = [], from = undefined) {
  try {
    const target = normalizeAddress(to);
    if (!target) return null;
    const raw = await provider.call({ to: target, from, data: iface.encodeFunctionData(fn, args) });
    return iface.decodeFunctionResult(fn, raw)[0];
  } catch (_) {
    return null;
  }
}

function encodePath(tokens, fees) {
  let out = "0x";
  for (let i = 0; i < tokens.length; i += 1) {
    out += normalizeAddress(tokens[i]).slice(2);
    if (i < fees.length) out += Number(fees[i]).toString(16).padStart(6, "0");
  }
  return out;
}

function routeLabel(tokens, fees) {
  return tokens.map((token, index) => `${compact(token, 8)}${index < fees.length ? `-${fees[index]}-` : ""}`).join("");
}

async function getUniPool(provider, tokenA, tokenB, fee) {
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

function defaultIntermediates() {
  return [
    TOKENS.WSTETH,
    TOKENS.STETH,
    TOKENS.RETH,
    TOKENS.CBETH,
    TOKENS.WEETH,
    TOKENS.FRXETH,
    TOKENS.SFRXETH,
    TOKENS.USDC,
    TOKENS.USDT,
    TOKENS.DAI,
  ];
}

async function buildUniPaths(provider, tokenIn, tokenOut, intermediates, includeDirect = true, includeTwoHop = true) {
  const input = normalizeAddress(tokenIn);
  const output = normalizeAddress(tokenOut);
  if (!input || !output) return [];
  if (sameAddress(input, output)) return [{ tokens: [input, output], fees: [0], pools: [], directSameToken: true, direct: true, label: "same-token" }];
  const paths = [];
  if (includeDirect) {
    for (const fee of FEES) {
      const pool = await getUniPool(provider, input, output, fee);
      if (pool) paths.push({ tokens: [input, output], fees: [fee], pools: [pool], direct: true, label: routeLabel([input, output], [fee]) });
    }
  }
  if (includeTwoHop) {
    const mids = [...new Set((intermediates || []).map(normalizeAddress).filter(Boolean).map((x) => x.toLowerCase()))]
      .filter((x) => !sameAddress(x, input) && !sameAddress(x, output))
      .map((x) => ethers.getAddress(x));
    for (const mid of mids) {
      for (const fee1 of FEES) {
        const pool1 = await getUniPool(provider, input, mid, fee1);
        if (!pool1) continue;
        for (const fee2 of FEES) {
          const pool2 = await getUniPool(provider, mid, output, fee2);
          if (!pool2) continue;
          paths.push({ tokens: [input, mid, output], fees: [fee1, fee2], pools: [pool1, pool2], direct: false, label: routeLabel([input, mid, output], [fee1, fee2]) });
          if (paths.length >= MAX_UNISWAP_PATHS) return paths;
        }
      }
    }
  }
  return paths;
}

async function quoteUni(provider, tokenIn, tokenOut, amountIn, intermediates, includeDirect = true, includeTwoHop = true) {
  const value = toBigInt(amountIn, 0n);
  if (value <= 0n) return [];
  if (sameAddress(tokenIn, tokenOut)) {
    return [{
      source: "same-token",
      pathKind: "same-token",
      amountInRaw: value,
      amountOutRaw: value,
      gasEstimate: 0n,
      path: { tokens: [normalizeAddress(tokenIn), normalizeAddress(tokenOut)], fees: [0], label: "same-token" },
    }];
  }
  const out = [];
  for (const p of await buildUniPaths(provider, tokenIn, tokenOut, intermediates, includeDirect, includeTwoHop)) {
    if (p.directSameToken) continue;
    const raw = await provider.call({
      to: UNISWAP_V3_QUOTER_V2,
      data: QUOTER.encodeFunctionData("quoteExactInput", [encodePath(p.tokens, p.fees), value]),
    }).catch(() => null);
    if (!raw) continue;
    try {
      const [amountOut, , , gasEstimate] = QUOTER.decodeFunctionResult("quoteExactInput", raw);
      if (amountOut > 0n) out.push({
        source: p.direct ? "Uniswap V3 exactInputSingle" : "Uniswap V3 routed exact-input",
        pathKind: p.direct ? "uniswap-v3-single" : "uniswap-v3-routed",
        amountInRaw: value,
        amountOutRaw: amountOut,
        gasEstimate,
        path: p,
      });
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

function curvePoolsContaining(curvePools, token) {
  const input = lowerAddress(token);
  if (!input) return [];
  return (curvePools || [])
    .filter((pool) => !pool.isBroken && pool.coins.some((coin) => lowerAddress(coin.address) === input))
    .sort((a, b) => Number(b.usdTotal || 0) - Number(a.usdTotal || 0))
    .slice(0, CURVE_MAX_POOLS_PER_TOKEN);
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
    .slice(0, CURVE_MAX_POOLS_PER_TOKEN);
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

async function quoteCurveDirect(provider, curvePools, tokenIn, tokenOut, amountIn) {
  const out = [];
  for (const pool of findCurvePools(curvePools, tokenIn, tokenOut)) {
    const amountOut = await curveGetDy(provider, pool, pool.i.index, pool.j.index, amountIn).catch(() => null);
    if (!amountOut || amountOut <= 0n) continue;
    out.push({
      source: pool.source,
      pathKind: "curve-direct",
      amountInRaw: toBigInt(amountIn),
      amountOutRaw: amountOut,
      gasEstimate: 0n,
      path: { pool: pool.address, name: pool.name, tokenIn: pool.i.address, tokenOut: pool.j.address, coinIn: pool.i, coinOut: pool.j },
    });
  }
  return out;
}

async function quoteCurveHeads(provider, curvePools, tokenIn, amountIn) {
  const out = [];
  for (const pool of curvePoolsContaining(curvePools, tokenIn)) {
    const i = pool.coins.find((coin) => sameAddress(coin.address, tokenIn));
    if (!i) continue;
    for (const j of pool.coins.filter((coin) => !sameAddress(coin.address, tokenIn))) {
      const amountOut = await curveGetDy(provider, pool, i.index, j.index, amountIn).catch(() => null);
      if (!amountOut || amountOut <= 0n) continue;
      out.push({
        source: pool.source,
        pathKind: "curve-head",
        amountInRaw: toBigInt(amountIn),
        amountOutRaw: amountOut,
        midToken: j.address,
        midSymbol: j.symbol,
        gasEstimate: 0n,
        path: { pool: pool.address, name: pool.name, tokenIn: i.address, tokenOut: j.address, coinIn: i, coinOut: j },
      });
    }
  }
  return out;
}

async function fetchBalancerPoolsContaining(token) {
  const t = lowerAddress(token);
  if (!t) return { pools: [], errors: [] };
  const query = `query($tokens: [Bytes!]!) {
    pools(first: ${BALANCER_MAX_POOLS}, orderBy: totalLiquidity, orderDirection: desc,
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
  const errors = [];
  for (const endpoint of endpoints) {
    const json = await fetchJson(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { tokens: [t] } }),
      timeoutMs: 12_000,
    }).catch((err) => ({ __error: err?.message || String(err) }));
    if (json?.__error || json?.errors) {
      errors.push({ endpoint: endpoint.includes("gateway.thegraph.com") ? "thegraph-gateway" : "thegraph-hosted", error: compact(json?.__error || JSON.stringify(json?.errors), 180) });
      continue;
    }
    const rows = (json?.data?.pools || []).map((p) => ({
      id: p.id,
      address: normalizeAddress(p.address),
      symbol: p.symbol || null,
      totalLiquidity: Number(p.totalLiquidity || 0),
      swapFee: p.swapFee || null,
      tokens: (p.tokens || [])
        .map((row) => ({ address: normalizeAddress(row.address), symbol: row.symbol || null, decimals: Number(row.decimals || 18), balance: row.balance || null }))
        .filter((row) => row.address),
    })).filter((row) => row.id && row.address);
    if (rows.length > 0) return { pools: rows, errors };
  }
  return { pools: [], errors };
}

async function quoteBalancerPool(provider, pool, tokenIn, tokenOut, amountIn) {
  try {
    const assets = [normalizeAddress(tokenIn), normalizeAddress(tokenOut)];
    if (!assets[0] || !assets[1] || sameAddress(assets[0], assets[1])) return null;
    const swaps = [{ poolId: pool.id, assetInIndex: 0, assetOutIndex: 1, amount: toBigInt(amountIn), userData: "0x" }];
    const funds = { sender: ZERO, fromInternalBalance: false, recipient: ZERO, toInternalBalance: false };
    const raw = await provider.call({ to: BALANCER_VAULT, data: BALANCER.encodeFunctionData("queryBatchSwap", [0, swaps, assets, funds]) }).catch(() => null);
    if (!raw) return null;
    const [deltas] = BALANCER.decodeFunctionResult("queryBatchSwap", raw);
    const outDelta = toBigInt(deltas[1], 0n);
    const amountOut = outDelta < 0n ? -outDelta : 0n;
    if (amountOut <= 0n) return null;
    return {
      source: "Balancer V2 queryBatchSwap",
      pathKind: "balancer-v2-single",
      amountInRaw: toBigInt(amountIn),
      amountOutRaw: amountOut,
      midToken: normalizeAddress(tokenOut),
      gasEstimate: 0n,
      path: { poolId: pool.id, pool: pool.address, symbol: pool.symbol, totalLiquidity: pool.totalLiquidity, swapFee: pool.swapFee, assets },
    };
  } catch (_) {
    return null;
  }
}

async function quoteBalancerHeads(provider, balancerPools, tokenIn, amountIn) {
  const out = [];
  for (const pool of balancerPools || []) {
    const tokens = (pool.tokens || []).filter((token) => token.address && !sameAddress(token.address, tokenIn)).slice(0, BALANCER_MAX_TOKENS_PER_POOL);
    for (const token of tokens) {
      const quote = await quoteBalancerPool(provider, pool, tokenIn, token.address, amountIn);
      if (quote) out.push({ ...quote, midSymbol: token.symbol });
    }
  }
  return out;
}

async function quoteTailToWeth(provider, curvePools, head, intermediates) {
  const mid = normalizeAddress(head.midToken || head.path?.tokenOut);
  if (!mid) return [];
  if (sameAddress(mid, TOKENS.WETH)) return [{ ...head, pathKind: head.pathKind.replace(/-head$/, "-direct"), source: head.source, amountOutRaw: head.amountOutRaw }];
  const tails = [];
  for (const tail of await quoteUni(provider, mid, TOKENS.WETH, head.amountOutRaw, intermediates, true, true).catch(() => [])) {
    tails.push({
      source: `${head.source} + ${tail.source}`,
      pathKind: `${head.pathKind}-to-${tail.pathKind}`,
      amountInRaw: head.amountInRaw,
      amountOutRaw: tail.amountOutRaw,
      gasEstimate: toBigInt(head.gasEstimate) + toBigInt(tail.gasEstimate),
      path: { legs: [head.path, tail.path] },
    });
  }
  for (const tail of await quoteCurveDirect(provider, curvePools, mid, TOKENS.WETH, head.amountOutRaw).catch(() => [])) {
    tails.push({
      source: `${head.source} + ${tail.source}`,
      pathKind: `${head.pathKind}-to-curve-direct`,
      amountInRaw: head.amountInRaw,
      amountOutRaw: tail.amountOutRaw,
      gasEstimate: toBigInt(head.gasEstimate) + toBigInt(tail.gasEstimate),
      path: { legs: [head.path, tail.path] },
    });
  }
  return tails;
}

function bestSize(row) {
  const sizes = Array.isArray(row?.sizeResults) ? row.sizeResults : [];
  return sizes
    .filter((size) => !size.seizedExceedsCollateral && toBigInt(size.seizedCollateralRaw, 0n) > 0n)
    .sort((a, b) => (asNumber(b.best?.netProfitUsd) ?? -Infinity) - (asNumber(a.best?.netProfitUsd) ?? -Infinity))[0]
    || sizes[0]
    || null;
}

function sourceContext(inputs) {
  const e9Row = (inputs.e9Salvage?.results || []).find((row) => sameAddress(row?.collateral?.address, TOKENS.yETH) && sameAddress(row?.loanAsset?.address, TOKENS.WETH));
  const currentRow = (inputs.currentLiquidatable?.topRows || []).find((row) => sameAddress(row?.collateral?.address, TOKENS.yETH) && sameAddress(row?.loanAsset?.address, TOKENS.WETH));
  const wrapperRow = (inputs.wrapperProof?.rows || []).find((row) => sameAddress(row?.collateral?.address, TOKENS.yETH) && sameAddress(row?.loanAsset?.address, TOKENS.WETH));
  const size = bestSize(e9Row);
  return {
    marketId: e9Row?.marketId || currentRow?.marketId || wrapperRow?.marketId || null,
    borrower: e9Row?.borrower || currentRow?.borrower || wrapperRow?.borrower || null,
    pair: e9Row?.pair || currentRow?.pair || wrapperRow?.pair || "WETH/yETH",
    healthFactor: round(e9Row?.healthFactor ?? currentRow?.healthFactor ?? wrapperRow?.healthFactor, 6),
    debtUsd: round(e9Row?.graph?.borrowAssetsUsd ?? currentRow?.debtUsd ?? wrapperRow?.debtUsd, 6),
    collateralUsd: round(e9Row?.graph?.collateralUsd ?? currentRow?.collateralUsd ?? wrapperRow?.collateralUsd, 6),
    loanPriceUsd: asNumber(e9Row?.loanAsset?.priceUsd) || 0,
    gasUsd: asNumber(inputs.e9Salvage?.gas?.liquidationGasUsd) || 0,
    slippageBps: asNumber(inputs.e9Salvage?.thresholds?.slippageBps) || 100,
    repayRaw: size?.repaidAssetsRaw || wrapperRow?.repayRawForMaxSeized || null,
    seizedRaw: size?.seizedCollateralRaw || wrapperRow?.maxSeizedRaw || null,
    flashFeeRaw: size?.flashFeeRaw || "0",
    bestExisting: size?.best || currentRow?.quote || null,
    sourceGeneratedAt: {
      e9Salvage: inputs.e9Salvage?.generatedAt || null,
      currentLiquidatable: inputs.currentLiquidatable?.generatedAt || null,
      wrapperProof: inputs.wrapperProof?.generatedAt || null,
    },
  };
}

async function wrapperProbe(provider, seizedRaw) {
  const seized = toBigInt(seizedRaw, 0n);
  const [assetRaw, totalSupplyRaw, totalAssetsRaw, previewRaw, convertRaw, maxRedeemZeroRaw] = await Promise.all([
    safeCall(provider, TOKENS.yETH, ERC20, "asset"),
    safeCall(provider, TOKENS.yETH, ERC20, "totalSupply"),
    safeCall(provider, TOKENS.yETH, ERC20, "totalAssets"),
    safeCall(provider, TOKENS.yETH, ERC20, "previewRedeem", [seized]),
    safeCall(provider, TOKENS.yETH, ERC20, "convertToAssets", [seized]),
    safeCall(provider, TOKENS.yETH, ERC20, "maxRedeem", [PROBE_FROM]),
  ]);
  const asset = normalizeAddress(assetRaw);
  const manager = normalizeAddress(await safeCall(provider, TOKENS.yETH, WRAPPER_MANAGER, "manager"));
  let managerProof = null;
  if (manager && asset) {
    const [withdrawEnabled, maxRedeemCapRaw, managerAssetBalanceRaw, wrapperAssetBalanceRaw] = await Promise.all([
      safeCall(provider, manager, WRAPPER_MANAGER, "withdrawAssets", [TOKENS.yETH, asset]),
      safeCall(provider, manager, WRAPPER_MANAGER, "maxRedeemCap", [TOKENS.yETH]),
      safeCall(provider, asset, ERC20, "balanceOf", [manager]),
      safeCall(provider, asset, ERC20, "balanceOf", [TOKENS.yETH]),
    ]);
    const maxRedeemCap = toBigInt(maxRedeemCapRaw, 0n);
    const managerLiquidity = toBigInt(managerAssetBalanceRaw, 0n);
    const wrapperLiquidity = toBigInt(wrapperAssetBalanceRaw, 0n);
    const totalInstantLiquidity = managerLiquidity + wrapperLiquidity;
    const preview = toBigInt(previewRaw, 0n);
    managerProof = {
      manager,
      withdrawAssetEnabled: Boolean(withdrawEnabled),
      maxRedeemCapRaw: maxRedeemCap.toString(),
      managerAssetBalanceRaw: managerLiquidity.toString(),
      wrapperAssetBalanceRaw: wrapperLiquidity.toString(),
      totalInstantLiquidityRaw: totalInstantLiquidity.toString(),
      capCoversSeizedShares: seized > 0n && maxRedeemCap >= seized,
      liquidityCoversPreviewAssets: preview > 0n && totalInstantLiquidity >= preview,
      instantCapacitySufficient: Boolean(withdrawEnabled && seized > 0n && preview > 0n && maxRedeemCap >= seized && totalInstantLiquidity >= preview),
    };
  }
  return {
    erc4626Like: Boolean(asset),
    asset,
    directLoanAsset: Boolean(asset && sameAddress(asset, TOKENS.WETH)),
    totalSupplyRaw: totalSupplyRaw?.toString?.() || null,
    totalAssetsRaw: totalAssetsRaw?.toString?.() || null,
    previewRedeemRaw: previewRaw?.toString?.() || null,
    convertToAssetsRaw: convertRaw?.toString?.() || null,
    maxRedeemProbeFromRaw: maxRedeemZeroRaw?.toString?.() || null,
    managerProof,
    sameBlockAssetTransferCapacity: Boolean(managerProof?.instantCapacitySufficient && asset && sameAddress(asset, TOKENS.WETH)),
    sameBlockAssetTransferProven: false,
  };
}

function scoreQuote(quote, ctx) {
  const amountOutRaw = toBigInt(quote.amountOutRaw, 0n);
  const repayRaw = toBigInt(ctx.repayRaw, 0n);
  const flashFeeRaw = toBigInt(ctx.flashFeeRaw, 0n);
  const loanPriceUsd = asNumber(ctx.loanPriceUsd) || 0;
  const grossProfitRaw = amountOutRaw - repayRaw - flashFeeRaw;
  const amountOut = formatUnitsNumber(amountOutRaw, 18) || 0;
  const expectedOutUsd = amountOut * loanPriceUsd;
  const grossProfitUsd = (formatUnitsNumber(grossProfitRaw, 18) || 0) * loanPriceUsd;
  const repayUsd = (formatUnitsNumber(repayRaw, 18) || 0) * loanPriceUsd;
  const slippageUsd = repayUsd * (asNumber(ctx.slippageBps) || 0) / 10_000;
  const netProfitUsd = grossProfitUsd - (asNumber(ctx.gasUsd) || 0) - slippageUsd;
  const exactSameBlockQuote = !quote.previewOnly && !quote.referenceOnly;
  const positive = Boolean(exactSameBlockQuote && grossProfitRaw > 0n && netProfitUsd > 0);
  const previewPositive = Boolean(quote.previewOnly && grossProfitRaw > 0n && netProfitUsd > 0);
  return {
    source: quote.source,
    pathKind: quote.pathKind,
    previewOnly: Boolean(quote.previewOnly),
    referenceOnly: Boolean(quote.referenceOnly),
    exactSameBlockQuote,
    amountInRaw: toBigInt(quote.amountInRaw, toBigInt(ctx.seizedRaw, 0n)).toString(),
    amountOutRaw: amountOutRaw.toString(),
    amountOut,
    expectedOutUsd,
    grossProfitRaw: grossProfitRaw.toString(),
    grossProfitUsd,
    slippageUsd,
    gasUsd: ctx.gasUsd,
    netProfitUsd,
    gasEstimate: quote.gasEstimate?.toString?.() || null,
    researchPositive: positive,
    previewPositive,
    routePositive: positive,
    path: quote.path,
    blockers: [
      quote.previewOnly ? "Wrapper preview is not same-block asset transfer proof" : null,
      quote.referenceOnly ? "Reference-only quote" : null,
      grossProfitRaw > 0n ? null : "Exit quote does not cover repay assets plus flash fee",
      netProfitUsd > 0 ? null : "Net profit after gas/slippage is not positive",
      positive ? null : "No fork extraction proof",
      "Signed action remains fail-closed",
    ].filter(Boolean),
  };
}

function dedupeQuotes(quotes) {
  const seen = new Set();
  return quotes
    .filter((q) => q && toBigInt(q.amountOutRaw, 0n) > 0n)
    .sort((a, b) => (toBigInt(a.amountOutRaw) > toBigInt(b.amountOutRaw) ? -1 : toBigInt(a.amountOutRaw) < toBigInt(b.amountOutRaw) ? 1 : 0))
    .filter((q) => {
      const key = `${q.pathKind}:${q.amountOutRaw.toString()}:${JSON.stringify(q.path || {})}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function quoteAll(provider, curvePools, balancerPools, ctx, wrapper) {
  const amountIn = toBigInt(ctx.seizedRaw, 0n);
  const intermediates = defaultIntermediates();
  const quotes = [];

  if (wrapper?.previewRedeemRaw && toBigInt(wrapper.previewRedeemRaw, 0n) > 0n) {
    quotes.push({
      source: "ERC4626 previewRedeem to WETH",
      pathKind: "erc4626-preview-redeem",
      previewOnly: true,
      amountInRaw: amountIn,
      amountOutRaw: toBigInt(wrapper.previewRedeemRaw, 0n),
      gasEstimate: 0n,
      path: { wrapper: TOKENS.yETH, asset: wrapper.asset, previewAssetsRaw: wrapper.previewRedeemRaw },
    });
  }

  quotes.push(...await quoteUni(provider, TOKENS.yETH, TOKENS.WETH, amountIn, intermediates, true, true).catch(() => []));
  quotes.push(...await quoteCurveDirect(provider, curvePools, TOKENS.yETH, TOKENS.WETH, amountIn).catch(() => []));

  for (const head of await quoteCurveHeads(provider, curvePools, TOKENS.yETH, amountIn).catch(() => [])) {
    quotes.push(...await quoteTailToWeth(provider, curvePools, head, intermediates).catch(() => []));
  }
  for (const head of await quoteBalancerHeads(provider, balancerPools, TOKENS.yETH, amountIn).catch(() => [])) {
    quotes.push(...await quoteTailToWeth(provider, curvePools, head, intermediates).catch(() => []));
  }

  return dedupeQuotes(quotes).map((quote) => scoreQuote(quote, ctx));
}

async function tokenBalance(provider, token, holder) {
  const balance = await safeCall(provider, token, ERC20, "balanceOf", [holder]).catch(() => null);
  return balance?.toString?.() || null;
}

async function poolInventory(provider, curvePools, balancerPools) {
  const uniPairs = [];
  const pairTokens = [TOKENS.WETH, ...defaultIntermediates()];
  for (const token of pairTokens) {
    if (sameAddress(token, TOKENS.yETH)) continue;
    for (const fee of FEES) {
      const pool = await getUniPool(provider, TOKENS.yETH, token, fee).catch(() => null);
      if (!pool) continue;
      const [yethBalanceRaw, otherBalanceRaw, symbolRaw] = await Promise.all([
        tokenBalance(provider, TOKENS.yETH, pool),
        tokenBalance(provider, token, pool),
        safeCall(provider, token, ERC20, "symbol").catch(() => null),
      ]);
      uniPairs.push({ token: normalizeAddress(token), symbol: typeof symbolRaw === "string" ? symbolRaw : null, fee, pool, yethBalanceRaw, otherBalanceRaw });
    }
  }
  const curveYethPools = curvePoolsContaining(curvePools, TOKENS.yETH).map((pool) => ({
    source: pool.source,
    name: pool.name,
    address: pool.address,
    usdTotal: pool.usdTotal,
    coins: pool.coins,
  }));
  const balancerYethPools = (balancerPools || []).map((pool) => ({
    id: pool.id,
    address: pool.address,
    symbol: pool.symbol,
    totalLiquidity: pool.totalLiquidity,
    swapFee: pool.swapFee,
    tokens: pool.tokens,
  }));
  return { uniswapV3Pairs: uniPairs, curveYethPools, balancerYethPools };
}

function writeReport(out) {
  const s = out.summary;
  const best = out.bestQuote;
  const lines = [];
  lines.push("# 🟢 DORMANT - Morpho WETH/yETH Alternate Exit Probe");
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push("No live execution is justified. The current WETH/yETH liquidation remains blocked unless an exact same-block yETH->WETH exit becomes positive or the yETH wrapper gains instant redeem capacity and fork-proven asset transfer semantics.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---:|");
  lines.push(`| Quotes scored | ${s.quotesScored} |`);
  lines.push(`| Exact same-block quotes | ${s.exactSameBlockQuotes} |`);
  lines.push(`| Exact positive rows | ${s.exactPositiveRows} |`);
  lines.push(`| Preview-positive rows | ${s.previewPositiveRows} |`);
  lines.push(`| Route positive | ${s.routePositive} |`);
  lines.push(`| Best exact net USD | ${s.bestExactNetUsd === null ? "n/a" : `$${s.bestExactNetUsd}`} |`);
  lines.push(`| Best preview net USD | ${s.bestPreviewNetUsd === null ? "n/a" : `$${s.bestPreviewNetUsd}`} |`);
  lines.push(`| Uniswap V3 yETH pairs | ${s.uniswapV3Pairs} |`);
  lines.push(`| Curve yETH pools | ${s.curveYethPools} |`);
  lines.push(`| Balancer yETH pools | ${s.balancerYethPools} |`);
  lines.push(`| Wrapper instant capacity | ${s.wrapperInstantCapacity ? "true" : "false"} |`);
  lines.push("");
  lines.push("## Best Quote");
  lines.push("");
  if (best) {
    lines.push(`- Source: \`${best.source}\``);
    lines.push(`- Path kind: \`${best.pathKind}\``);
    lines.push(`- Net USD: \`${round(best.netProfitUsd, 6)}\``);
    lines.push(`- Route positive: \`${best.routePositive}\``);
    lines.push(`- Blockers: ${best.blockers.map((b) => `\`${compact(b, 100)}\``).join(", ")}`);
  } else {
    lines.push("- No quote was produced for the probed seized size.");
  }
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  for (const blocker of out.blockers) lines.push(`- ${blocker}`);
  lines.push("");
  lines.push("## Artifacts");
  lines.push("");
  lines.push(`- Raw: \`${rel(RAW_OUT)}\``);
  lines.push("- Scanner: `tools/scan-morpho-yeth-alternate-exits.js`");
  fs.writeFileSync(REPORT_OUT, `${lines.join("\n")}\n`);
}

async function main() {
  const inputs = Object.fromEntries(Object.entries(INPUTS).map(([key, file]) => [key, readJson(file, {})]));
  const ctx = sourceContext(inputs);
  if (!ctx.marketId || toBigInt(ctx.seizedRaw, 0n) <= 0n || toBigInt(ctx.repayRaw, 0n) <= 0n) {
    throw new Error("missing WETH/yETH source context; refresh e9 liquidation salvage first");
  }
  const rpc = await resolveEthereumRpc();
  if (!rpc) throw new Error("missing ethereum rpc");
  const provider = new ethers.JsonRpcProvider(rpc, 1, { staticNetwork: true });
  const [block, curvePools, balancerResult, wrapper] = await Promise.all([
    provider.getBlock("latest").catch(() => null),
    fetchCurvePools().catch(() => []),
    fetchBalancerPoolsContaining(TOKENS.yETH).catch((err) => ({ pools: [], errors: [{ endpoint: "balancer", error: compact(err?.message || String(err), 180) }] })),
    wrapperProbe(provider, ctx.seizedRaw).catch(() => null),
  ]);
  const balancerPools = balancerResult?.pools || [];
  const quotes = await quoteAll(provider, curvePools, balancerPools, ctx, wrapper || {}).catch(() => []);
  quotes.sort((a, b) => Number(b.netProfitUsd ?? -Infinity) - Number(a.netProfitUsd ?? -Infinity));
  const inventory = await poolInventory(provider, curvePools, balancerPools).catch(() => ({ uniswapV3Pairs: [], curveYethPools: [], balancerYethPools: [] }));
  const exactQuotes = quotes.filter((q) => q.exactSameBlockQuote);
  const exactPositiveRows = quotes.filter((q) => q.routePositive);
  const previewPositiveRows = quotes.filter((q) => q.previewPositive);
  const bestExact = exactQuotes.sort((a, b) => Number(b.netProfitUsd ?? -Infinity) - Number(a.netProfitUsd ?? -Infinity))[0] || null;
  const bestPreview = quotes.filter((q) => q.previewOnly).sort((a, b) => Number(b.netProfitUsd ?? -Infinity) - Number(a.netProfitUsd ?? -Infinity))[0] || null;
  const bestQuote = quotes[0] || null;
  const blockers = [
    exactPositiveRows.length ? null : "No exact same-block yETH->WETH route is positive after repay, gas, and slippage",
    previewPositiveRows.length ? "Best positive edge is wrapper preview-only, not same-block transfer proof" : null,
    wrapper?.managerProof?.maxRedeemCapRaw === "0" ? "Wrapper manager instant redeem cap is zero" : null,
    wrapper?.managerProof?.totalInstantLiquidityRaw === "0" ? "Wrapper manager/wrapper instant WETH liquidity is zero" : null,
    wrapper?.sameBlockAssetTransferProven ? null : "No fork/static trace proves same-block yETH redemption transfers WETH",
    "No fork extraction proof",
    "Signed action remains fail-closed",
  ].filter(Boolean);
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-morpho-yeth-alternate-exits.js",
    scope: "Read-only alternate-exit inventory for the top Morpho WETH/yETH current-liquidation proof gap",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      liveTransactions: false,
      routePositive: exactPositiveRows.length > 0,
      signedActionJustified: false,
    },
    block: block ? { number: block.number, timestamp: block.timestamp, iso: new Date(Number(block.timestamp) * 1000).toISOString() } : null,
    sourceArtifacts: Object.fromEntries(Object.entries(INPUTS).map(([key, file]) => [key, rel(file)])),
    sourceGeneratedAt: ctx.sourceGeneratedAt,
    context: {
      marketId: ctx.marketId,
      borrower: ctx.borrower,
      pair: ctx.pair,
      healthFactor: ctx.healthFactor,
      debtUsd: ctx.debtUsd,
      collateralUsd: ctx.collateralUsd,
      loanAsset: { symbol: "WETH", address: TOKENS.WETH, priceUsd: ctx.loanPriceUsd },
      collateral: { symbol: "yETH", address: TOKENS.yETH },
      repayRaw: ctx.repayRaw,
      seizedRaw: ctx.seizedRaw,
      flashFeeRaw: ctx.flashFeeRaw,
      gasUsd: ctx.gasUsd,
      slippageBps: ctx.slippageBps,
    },
    wrapper,
    inventory,
    balancerErrors: balancerResult?.errors || [],
    summary: {
      quotesScored: quotes.length,
      exactSameBlockQuotes: exactQuotes.length,
      exactPositiveRows: exactPositiveRows.length,
      previewPositiveRows: previewPositiveRows.length,
      routePositive: exactPositiveRows.length,
      executableNow: 0,
      signedActionJustified: false,
      bestExactNetUsd: bestExact ? round(bestExact.netProfitUsd, 6) : null,
      bestPreviewNetUsd: bestPreview ? round(bestPreview.netProfitUsd, 6) : null,
      bestNetUsd: bestQuote ? round(bestQuote.netProfitUsd, 6) : null,
      bestSource: bestQuote?.source || null,
      bestPathKind: bestQuote?.pathKind || null,
      uniswapV3Pairs: inventory.uniswapV3Pairs.length,
      curveYethPools: inventory.curveYethPools.length,
      balancerYethPools: inventory.balancerYethPools.length,
      wrapperInstantCapacity: Boolean(wrapper?.sameBlockAssetTransferCapacity),
      status: exactPositiveRows.length ? "exact-positive-needs-fork-proof" : previewPositiveRows.length ? "preview-positive-wrapper-capacity-blocked" : "no-positive-exact-yeth-exit",
      blocker: blockers[0] || null,
    },
    bestQuote,
    quotes: quotes.slice(0, 24),
    blockers,
    requiredForRoutePositive: [
      "current WETH/yETH borrower remains liquidatable on-chain",
      "seized yETH size and repay WETH size are exact and non-overseizing",
      "same-block yETH->WETH exit is exact-quoted positive after repay, gas, slippage, and flash fees",
      "wrapper redeem path has instant cap and WETH liquidity if wrapper preview is used",
      "fork/static trace proves seized yETH can transfer WETH in the same transaction",
      "fork extraction proof before any signed action",
    ],
  };
  fs.mkdirSync(path.dirname(RAW_OUT), { recursive: true });
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);
  writeReport(output);
  if (!QUIET) {
    console.log(`morphoYethAlternateExits quotes=${output.summary.quotesScored} exactPositive=${output.summary.exactPositiveRows} previewPositive=${output.summary.previewPositiveRows} routePositive=${output.summary.routePositive}`);
    console.log(`Report: ${rel(REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
