#!/usr/bin/env node
// Reusable exact DEX exit quoter.
// Given token→output pairs, queries Uniswap V3 Quoter V2 (with fee-tier discovery),
// Uniswap V2 Router, and SushiSwap Router for exact-input swap quotes.
// Designed to be consumed by liquidation scanners.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "dex-exit-quotes.json");
const QUIET = process.argv.includes("--quiet");

const TIMEOUT_MS = 15_000;

const UNISWAP_V3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNISWAP_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const SUSHISWAP_V2_ROUTER = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";

const STABLE_OUTPUTS = [
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
  "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
];

const QUOTER_IFACE = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const FACTORY_IFACE = new ethers.Interface([
  "function getPool(address,address,uint24) view returns (address)",
]);
const V2_IFACE = new ethers.Interface([
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
]);

const FEE_TIERS = [100, 500, 3000, 10000];

const FILES = {
  morphoLiquidationRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-high-apy-liquidation-routes.json"),
  consumerFirstHighLtv: path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json"),
};

function readJson(file, fallback = null) {
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

function round(value, decimals = 6) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function lowerAddress(value) {
  const text = String(value || "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text.toLowerCase() : null;
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
  const pool = {};
  for (const url of loadRpcUrls()) {
    try {
      const idHex = await rpcCall(url, "eth_chainId", [], 6000);
      const chainId = Number(BigInt(idHex));
      if (chainIds.includes(chainId) && !pool[chainId]) pool[chainId] = url;
    } catch (_) {}
  }
  return pool;
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

async function safeProviderCall(provider, to, data) {
  try { return await provider.call({ to, data }); } catch (_) { return null; }
}

async function findUniV3Pools(provider, tokenA, tokenB) {
  const pools = [];
  for (const fee of FEE_TIERS) {
    try {
      const data = FACTORY_IFACE.encodeFunctionData("getPool", [tokenA, tokenB, fee]);
      const raw = await safeProviderCall(provider, UNISWAP_V3_FACTORY, data);
      if (raw && raw !== "0x") {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["address"], raw);
        if (decoded[0] && decoded[0] !== ethers.ZeroAddress) {
          pools.push({ fee, address: String(decoded[0]).toLowerCase() });
        }
      }
    } catch (_) {}
  }
  return pools;
}

async function quoteUniV3ExactInput(provider, tokenIn, tokenOut, amountIn) {
  const results = [];
  const pools = await findUniV3Pools(provider, tokenIn, tokenOut);
  for (const pool of pools) {
    try {
      const data = QUOTER_IFACE.encodeFunctionData("quoteExactInputSingle", [
        { tokenIn, tokenOut, amountIn, fee: pool.fee, sqrtPriceLimitX96: 0n },
      ]);
      const raw = await safeProviderCall(provider, UNISWAP_V3_QUOTER_V2, data);
      if (!raw) continue;
      const decoded = QUOTER_IFACE.decodeFunctionResult("quoteExactInputSingle", raw);
      results.push({
        dex: "Uniswap V3",
        method: "quoteExactInputSingle",
        fee: pool.fee,
        pool: pool.address,
        amountOutRaw: decoded[0].toString(),
        amountOut: Number(ethers.formatUnits(decoded[0], 6)),
        gasEstimateRaw: decoded[3].toString(),
        gasEstimate: Number(decoded[3]),
      });
    } catch (_) {}
  }
  return results;
}

async function quoteUniV2ExactInput(provider, tokenIn, tokenOut, amountIn, routerAddr, dexName) {
  const results = [];
  try {
    const data = V2_IFACE.encodeFunctionData("getAmountsOut", [amountIn, [tokenIn, tokenOut]]);
    const raw = await safeProviderCall(provider, routerAddr, data);
    if (!raw) return results;
    const decoded = V2_IFACE.decodeFunctionResult("getAmountsOut", raw);
    const amountOut = decoded[0]?.[decoded[0].length - 1];
    if (amountOut && amountOut > 0n) {
      results.push({
        dex: dexName,
        method: "getAmountsOut",
        path: [tokenIn, tokenOut],
        amountOutRaw: amountOut.toString(),
        amountOut: Number(ethers.formatUnits(amountOut, 6)),
        gasEstimateRaw: "150000",
        gasEstimate: 150000,
      });
    }
  } catch (_) {}
  return results;
}

async function quoteTokenExit(provider, tokenIn, amountInRaw) {
  const tokenInLC = lowerAddress(tokenIn);
  if (!tokenInLC) return [];
  const allQuotes = [];

  for (const stableOut of STABLE_OUTPUTS) {
    const stableLC = lowerAddress(stableOut);
    if (tokenInLC === stableLC) {
      allQuotes.push({
        outputToken: stableLC,
        amountOutRaw: amountInRaw.toString(),
        amountOut: Number(ethers.formatUnits(BigInt(amountInRaw), 6)),
        dex: "identity",
        method: "same-token",
      });
      continue;
    }

    const v3Quotes = await quoteUniV3ExactInput(provider, tokenIn, stableOut, amountInRaw);
    allQuotes.push(...v3Quotes.map((q) => ({ ...q, outputToken: stableLC })));

    const v2Quotes = await quoteUniV2ExactInput(provider, tokenIn, stableOut, amountInRaw, UNISWAP_V2_ROUTER, "Uniswap V2");
    allQuotes.push(...v2Quotes.map((q) => ({ ...q, outputToken: stableLC })));

    const sushiQuotes = await quoteUniV2ExactInput(provider, tokenIn, stableOut, amountInRaw, SUSHISWAP_V2_ROUTER, "SushiSwap V2");
    allQuotes.push(...sushiQuotes.map((q) => ({ ...q, outputToken: stableLC })));
  }

  return allQuotes;
}

async function main() {
  const morpho = readJson(FILES.morphoLiquidationRoutes, {});
  const consumerFirst = readJson(FILES.consumerFirstHighLtv, {});

  const rpcs = await resolveRpcPool([1]);
  const rpcUrl = rpcs[1];
  if (!rpcUrl) {
    console.log("No Ethereum RPC available");
    return;
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });

  const collateralTokens = new Map();
  const morphoResults = Array.isArray(morpho?.results) ? morpho.results : [];

  for (const result of morphoResults) {
    const position = result?.position || result;
    const collateralAddr = lowerAddress(position?.collateral?.address || position?.collateralAsset?.address);
    const collateralSymbol = position?.collateral?.symbol || position?.collateralAsset?.symbol;
    const loanAddr = lowerAddress(position?.loanAsset?.address);
    const loanSymbol = position?.loanAsset?.symbol;
    const marketId = position?.marketId || position?.consumer?.marketId || null;
    const pair = position?.pair || `${collateralSymbol}/${loanSymbol}`;

    if (!collateralAddr) continue;

    if (!collateralTokens.has(collateralAddr)) {
      collateralTokens.set(collateralAddr, {
        address: collateralAddr,
        symbol: collateralSymbol || "unknown",
        pairs: [],
        morphoMarketIds: [],
      });
    }
    const entry = collateralTokens.get(collateralAddr);
    entry.pairs.push(pair);
    if (marketId && !entry.morphoMarketIds.includes(marketId)) {
      entry.morphoMarketIds.push(marketId);
    }
  }

  const consumerCollateralSet = new Set();
  for (const result of consumerFirst?.results || []) {
    for (const row of result?.highLtvRowsDetail || []) {
      const addr = lowerAddress(row?.collateral?.address || row?.consumer?.collateralAsset?.address);
      if (addr) consumerCollateralSet.add(addr);
    }
  }

  const quoteRows = [];
  let totalQuotes = 0;
  let successfulQuotes = 0;
  let bestQuoteUsd = -Infinity;
  let bestToken = null;

  const tokenList = [...collateralTokens.values()];
  for (const token of tokenList) {
    const amountInRaw = ethers.parseUnits("1", 18).toString();
    const quotes = await quoteTokenExit(provider, token.address, amountInRaw);

    const best = quotes
      .filter((q) => q.amountOut > 0)
      .sort((a, b) => (b.amountOut || 0) - (a.amountOut || 0))[0] || null;

    totalQuotes += quotes.length;
    if (best) successfulQuotes += 1;
    if (best && (best.amountOut || 0) > bestQuoteUsd) {
      bestQuoteUsd = best.amountOut || 0;
      bestToken = token.symbol;
    }

    quoteRows.push({
      collateral: token.address,
      symbol: token.symbol,
      pairs: token.pairs,
      morphoMarketIds: token.morphoMarketIds,
      inConsumerGraph: consumerCollateralSet.has(token.address),
      quotesCount: quotes.length,
      successfulQuotes: quotes.filter((q) => q.amountOut > 0).length,
      bestQuote: best ? {
        dex: best.dex,
        method: best.method,
        outputToken: best.outputToken,
        amountOut: round(best.amountOut, 6),
        gasEstimate: best.gasEstimate || null,
        feeBps: best.fee ? best.fee / 100 : null,
      } : null,
      allQuotes: quotes.slice(0, 10).map((q) => ({
        dex: q.dex,
        outputToken: q.outputToken,
        amountOut: round(q.amountOut, 6),
        gasEstimate: q.gasEstimate || null,
      })),
    });
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/quote-dex-exit.js",
    scope: "Reusable exact DEX exit quoter for liquidation collateral tokens",
    inputs: {
      morphoLiquidationRoutes: FILES.morphoLiquidationRoutes,
      consumerFirstHighLtv: FILES.consumerFirstHighLtv,
    },
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    quoterConfig: {
      uniswapV3Quoter: UNISWAP_V3_QUOTER_V2,
      uniswapV3Factory: UNISWAP_V3_FACTORY,
      uniswapV2Router: UNISWAP_V2_ROUTER,
      sushiV2Router: SUSHISWAP_V2_ROUTER,
      feeTiers: FEE_TIERS,
      stableOutputs: STABLE_OUTPUTS,
    },
    summary: {
      collateralTokensInput: tokenList.length,
      totalQuotesAttempted: totalQuotes,
      tokensWithSuccessfulQuote: quoteRows.filter((r) => r.successfulQuotes > 0).length,
      tokensWithNoQuote: quoteRows.filter((r) => r.successfulQuotes === 0).length,
      bestQuoteToken: bestToken,
      bestQuoteAmountOut: round(bestQuoteUsd, 6),
      routePositive: 0,
      signedActionJustified: false,
      closedReason: quoteRows.filter((r) => r.successfulQuotes > 0).length
        ? "Exit quotes available; needs per-token lending/economics integration"
        : "No exit quote available for any collateral token via UniV3/V2/Sushi",
    },
    quoteRows: quoteRows.slice(0, 100),
    perTokenQuotes: quoteRows.filter((r) => r.allQuotes?.length > 0).slice(0, 50),
    requiredForRoutePositive: [
      "collateral token has liquid DEX exit route to a stable output",
      "exit output exceeds repay amount after gas",
      "integration with liquidation scanner shows net-positive route",
      "fork extraction proof",
    ],
    nextReadOnlyStep: "Feed exit quotes into Morpho liquidation scanner; fork-proof only the net-positive routes.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");

  if (!QUIET) {
    console.log(`DEX exit quotes: tokens=${tokenList.length} quotes=${totalQuotes} successTokens=${quoteRows.filter((r) => r.successfulQuotes > 0).length} noQuoteTokens=${quoteRows.filter((r) => r.successfulQuotes === 0).length} best=${bestToken}@${round(bestQuoteUsd, 4)}`);
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
