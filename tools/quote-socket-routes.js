#!/usr/bin/env node
// Read-only Socket/Bungee v3 quote adapter.
// Queries public quote/metadata endpoints and stores sanitized route metadata only.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "socket-route-quotes.json");

const DEFAULT_API_BASE = "https://public-backend.socket.tech";
const DEFAULT_WALLET = "0x24e46e91dFAAD1FA3d49C48Aa85ca9306885ce0a";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SLIPPAGE = "0.5";
const DEFAULT_MAX_REQUESTS = 12;
const REQUEST_DELAY_MS = 700;
const RATE_LIMIT_RETRY_MS = 2_500;

const QUIET = process.argv.includes("--quiet");

const TOKENS = {
  ethUsdc: { chainId: 1, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
  ethWeth: { chainId: 1, address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18 },
  ethWeeth: { chainId: 1, address: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", symbol: "weETH", decimals: 18 },
  ethDeusd: { chainId: 1, address: "0x15700B564Ca08D9439C58cA5053166E8317aa138", symbol: "deUSD", decimals: 18 },
  ethRlp: { chainId: 1, address: "0x4956B52AE2ff65D74ca2d61207523288e4528F96", symbol: "RLP", decimals: 18 },
  ethWspyx: { chainId: 1, address: "0xc88FcD8B874fDb3256E8B55b3decB8c24EAb4c02", symbol: "wSPYx", decimals: 18 },
  baseUsdc: { chainId: 8453, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
  baseWeth: { chainId: 8453, address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
  arbUsdc: { chainId: 42161, address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", decimals: 6 },
  arbWeth: { chainId: 42161, address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", symbol: "WETH", decimals: 18 },
  opUsdc: { chainId: 10, address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", symbol: "USDC", decimals: 6 },
};

const DEFAULT_REQUESTS = [
  { id: "base-usdc-to-arb-usdc", label: "Base USDC -> Arbitrum USDC", input: TOKENS.baseUsdc, output: TOKENS.arbUsdc, amount: "1000000", branch: "cross-chain funding/bridge route" },
  { id: "arb-usdc-to-base-usdc", label: "Arbitrum USDC -> Base USDC", input: TOKENS.arbUsdc, output: TOKENS.baseUsdc, amount: "1000000", branch: "cross-chain funding/bridge route" },
  { id: "eth-usdc-to-base-usdc", label: "Ethereum USDC -> Base USDC", input: TOKENS.ethUsdc, output: TOKENS.baseUsdc, amount: "1000000", branch: "cross-chain funding/bridge route" },
  { id: "base-usdc-to-base-weth", label: "Base USDC -> Base WETH", input: TOKENS.baseUsdc, output: TOKENS.baseWeth, amount: "1000000", branch: "same-chain DEX route" },
  { id: "eth-weth-to-eth-usdc", label: "Ethereum WETH -> USDC", input: TOKENS.ethWeth, output: TOKENS.ethUsdc, amount: "1000000000000000", branch: "same-chain DEX route" },
  { id: "base-weth-to-base-usdc", label: "Base WETH -> USDC", input: TOKENS.baseWeth, output: TOKENS.baseUsdc, amount: "1000000000000000", branch: "same-chain DEX route" },
  { id: "arb-weth-to-arb-usdc", label: "Arbitrum WETH -> USDC", input: TOKENS.arbWeth, output: TOKENS.arbUsdc, amount: "1000000000000000", branch: "same-chain DEX route" },
  { id: "eth-weeth-to-eth-weth", label: "Ethereum weETH -> WETH", input: TOKENS.ethWeeth, output: TOKENS.ethWeth, amount: "10000000000000000", branch: "Aave V4 collateral exit intelligence" },
  { id: "eth-deusd-to-eth-usdc", label: "Ethereum deUSD -> USDC", input: TOKENS.ethDeusd, output: TOKENS.ethUsdc, amount: "1000000000000000000", branch: "Morpho high-APY collateral exit intelligence" },
  { id: "eth-rlp-to-eth-usdc", label: "Ethereum RLP -> USDC", input: TOKENS.ethRlp, output: TOKENS.ethUsdc, amount: "1000000000000000000", branch: "Morpho high-APY collateral exit intelligence" },
  { id: "eth-wspyx-to-eth-usdc", label: "Ethereum wSPYx -> USDC", input: TOKENS.ethWspyx, output: TOKENS.ethUsdc, amount: "1000000000000000000", branch: "Morpho/Pyth watch-row exit intelligence" },
  { id: "op-usdc-to-base-usdc", label: "Optimism USDC -> Base USDC", input: TOKENS.opUsdc, output: TOKENS.baseUsdc, amount: "1000000", branch: "cross-chain funding/bridge route" },
];

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 6) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAddress(value) {
  const text = String(value || "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text : null;
}

function compactAddress(value) {
  const address = normalizeAddress(value);
  return address ? address : null;
}

function sanitizeApiBase(value) {
  const text = String(value || DEFAULT_API_BASE).trim().replace(/\/+$/, "");
  return /^https:\/\/[A-Za-z0-9.-]+(?:\:\d+)?$/.test(text) ? text : DEFAULT_API_BASE;
}

function tokenSummary(token = {}) {
  return {
    chainId: asNumber(token.chainId),
    address: compactAddress(token.address),
    symbol: token.symbol || null,
    name: token.name || null,
    decimals: asNumber(token.decimals),
  };
}

function protocolSummary(protocol = {}) {
  if (!protocol) return null;
  return {
    name: protocol.name || null,
    displayName: protocol.displayName || null,
  };
}

function dataByteLength(data) {
  const text = String(data || "");
  if (!/^0x[0-9a-fA-F]*$/.test(text)) return null;
  return Math.max(0, (text.length - 2) / 2);
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = { success: false, message: text.slice(0, 300) };
    }
    return { httpStatus: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchQuoteJson(apiBase, request, wallet, slippage, timeoutMs) {
  const first = await fetchJson(quoteUrl(apiBase, request, wallet, slippage), timeoutMs);
  if (first.httpStatus !== 429) return first;
  await sleep(RATE_LIMIT_RETRY_MS);
  return fetchJson(quoteUrl(apiBase, request, wallet, slippage), timeoutMs);
}

function quoteUrl(apiBase, request, wallet, slippage) {
  const url = new URL(`${apiBase}/v3/swap/quote`);
  url.search = new URLSearchParams({
    userOps: "tx",
    originChainId: String(request.input.chainId),
    destinationChainId: String(request.output.chainId),
    inputToken: request.input.address,
    outputToken: request.output.address,
    inputAmount: request.amount,
    userAddress: wallet,
    receiverAddress: wallet,
    slippage,
  }).toString();
  return url;
}

function sanitizeRoute(route = {}, result = {}, request = {}) {
  const txObject = route.txData?.object || {};
  const dexDetails = route.routeDetails?.dexDetails || null;
  const bridgeDetails = route.routeDetails?.bridgeDetails || null;
  const feeDetails = route.routeDetails?.feeDetails || null;
  const statusCheck = route.statusCheck || null;
  return {
    requestId: request.id,
    label: request.label,
    branch: request.branch,
    userOp: route.userOp || null,
    quoteId: route.quoteId || null,
    expiresAt: asNumber(route.expiresAt),
    expiresAtIso: asNumber(route.expiresAt) ? new Date(asNumber(route.expiresAt) * 1000).toISOString() : null,
    originChainId: asNumber(result.originChainId ?? request.input.chainId),
    destinationChainId: asNumber(result.destinationChainId ?? request.output.chainId),
    input: {
      token: tokenSummary(result.input?.token || request.input),
      amount: String(result.input?.amount || request.amount),
      priceInUsd: round(result.input?.priceInUsd, 8),
      valueInUsd: round(result.input?.valueInUsd, 8),
    },
    output: {
      token: tokenSummary(route.output?.token || request.output),
      amount: route.output?.amount ? String(route.output.amount) : null,
      minAmountOut: route.output?.minAmountOut ? String(route.output.minAmountOut) : null,
      priceInUsd: round(route.output?.priceInUsd, 8),
      valueInUsd: round(route.output?.valueInUsd, 8),
    },
    estimatedTimeSec: asNumber(route.estimatedTime),
    slippagePct: round(route.slippage, 4),
    suggestedSlippagePct: round(route.suggestedSlippage, 4),
    routeTags: Array.isArray(route.routeTags) ? route.routeTags.slice(0, 8).map(String) : [],
    providers: {
      dex: protocolSummary(dexDetails?.protocol),
      bridge: protocolSummary(bridgeDetails?.protocol),
      feeApplied: Boolean(feeDetails),
    },
    routeDetails: {
      dex: dexDetails ? {
        inputTokenAddress: compactAddress(dexDetails.inputTokenAddress),
        outputTokenAddress: compactAddress(dexDetails.outputTokenAddress),
        amountIn: dexDetails.amountIn ? String(dexDetails.amountIn) : null,
        amountOut: dexDetails.amountOut ? String(dexDetails.amountOut) : null,
        minAmountOut: dexDetails.minAmountOut ? String(dexDetails.minAmountOut) : null,
        slippagePct: round(dexDetails.slippage, 4),
      } : null,
      bridge: bridgeDetails ? {
        inputTokenAddress: compactAddress(bridgeDetails.inputTokenAddress),
        outputTokenAddress: compactAddress(bridgeDetails.outputTokenAddress),
        amountIn: bridgeDetails.amountIn ? String(bridgeDetails.amountIn) : null,
        amountOut: bridgeDetails.amountOut ? String(bridgeDetails.amountOut) : null,
        minAmountOut: bridgeDetails.minAmountOut ? String(bridgeDetails.minAmountOut) : null,
        slippagePct: round(bridgeDetails.slippage, 4),
      } : null,
    },
    approval: route.approval ? {
      spenderAddress: compactAddress(route.approval.spenderAddress),
      tokenAddress: compactAddress(route.approval.tokenAddress),
      amount: route.approval.amount ? String(route.approval.amount) : null,
    } : null,
    txTarget: {
      kind: route.txData?.kind || null,
      chainId: asNumber(txObject.chainId),
      to: compactAddress(txObject.to),
      value: txObject.value ? String(txObject.value) : null,
      calldataBytes: dataByteLength(txObject.data),
      calldataStored: false,
    },
    gasFee: route.gasFee ? {
      gasToken: tokenSummary(route.gasFee.gasToken),
      gasLimit: route.gasFee.gasLimit ? String(route.gasFee.gasLimit) : null,
      gasPrice: route.gasFee.gasPrice ? String(route.gasFee.gasPrice) : null,
      estimatedFee: route.gasFee.estimatedFee ? String(route.gasFee.estimatedFee) : null,
      feeInUsd: round(route.gasFee.feeInUsd, 8),
    } : null,
    statusCheck: statusCheck ? {
      available: Boolean(statusCheck.endpoint),
      method: statusCheck.method || null,
      intervalSec: asNumber(statusCheck.intervalSec),
      maxDurationSec: asNumber(statusCheck.maxDurationSec),
      endpointStored: false,
    } : null,
    warnings: [
      "read-only quote metadata only",
      "full calldata intentionally not stored",
      "route is not route-positive without exact branch economics and fork proof",
      "future execution requires spender/target allowlists, staticCall, estimateGas, minOut, and explicit authorization",
    ],
    routePositive: false,
    signedActionJustified: false,
  };
}

function routeScore(route) {
  const outputUsd = asNumber(route.output?.valueInUsd) || 0;
  const gasUsd = asNumber(route.gasFee?.feeInUsd) || 0;
  return outputUsd - gasUsd;
}

function summarizeQuoteRow(request, result, httpStatus) {
  const routes = Array.isArray(result.routes)
    ? result.routes.map((route) => sanitizeRoute(route, result, request))
    : [];
  const bestRoute = routes.slice().sort((a, b) => routeScore(b) - routeScore(a))[0] || null;
  return {
    requestId: request.id,
    label: request.label,
    branch: request.branch,
    originChainId: request.input.chainId,
    destinationChainId: request.output.chainId,
    inputToken: tokenSummary(request.input),
    outputToken: tokenSummary(request.output),
    inputAmount: request.amount,
    httpStatus,
    routesReturned: routes.length,
    bestRoute: bestRoute ? {
      quoteId: bestRoute.quoteId,
      outputAmount: bestRoute.output.amount,
      minAmountOut: bestRoute.output.minAmountOut,
      outputValueUsd: bestRoute.output.valueInUsd,
      gasUsd: bestRoute.gasFee?.feeInUsd ?? null,
      estimatedTimeSec: bestRoute.estimatedTimeSec,
      routeTags: bestRoute.routeTags,
      dexProvider: bestRoute.providers.dex?.name || null,
      bridgeProvider: bestRoute.providers.bridge?.name || null,
      approvalSpender: bestRoute.approval?.spenderAddress || null,
      txTarget: bestRoute.txTarget.to || null,
      expiresAt: bestRoute.expiresAt,
    } : null,
    routes: routes.slice(0, 8),
    routePositive: false,
    signedActionJustified: false,
  };
}

function collectUnique(rows, getter) {
  const values = new Set();
  for (const row of rows) {
    for (const route of row.routes || []) {
      const value = getter(route);
      if (value) values.add(value);
    }
  }
  return [...values].sort();
}

async function fetchSupportedChains(apiBase, requestedChainIds, timeoutMs) {
  try {
    const { httpStatus, json } = await fetchJson(`${apiBase}/v3/swap/supported-chains`, timeoutMs);
    const chains = Array.isArray(json?.result) ? json.result : [];
    const requested = chains
      .filter((chain) => requestedChainIds.includes(asNumber(chain.chainId)))
      .map((chain) => ({
        chainId: asNumber(chain.chainId),
        name: chain.name || null,
        sendingEnabled: Boolean(chain.sendingEnabled),
        receivingEnabled: Boolean(chain.receivingEnabled),
        dexes: Array.isArray(chain.dexes) ? chain.dexes.slice(0, 12).map(String) : [],
        bridges: Array.isArray(chain.bridges) ? chain.bridges.slice(0, 16).map(String) : [],
      }));
    return {
      fetched: httpStatus === 200 && Array.isArray(json?.result),
      httpStatus,
      supportedChainsCount: chains.length,
      requestedChains: requested,
      error: httpStatus === 200 ? null : (json?.message || "metadata request failed"),
    };
  } catch (err) {
    return {
      fetched: false,
      httpStatus: null,
      supportedChainsCount: null,
      requestedChains: [],
      error: err?.message || String(err),
    };
  }
}

function topRowsFromQuoteRows(quoteRows) {
  return quoteRows
    .filter((row) => row.bestRoute)
    .sort((a, b) => (asNumber(b.bestRoute.outputValueUsd) || 0) - (asNumber(a.bestRoute.outputValueUsd) || 0))
    .slice(0, 8)
    .map((row) => ({
      protocol: "Socket/Bungee v3",
      chain: row.originChainId === row.destinationChainId ? String(row.originChainId) : `${row.originChainId}->${row.destinationChainId}`,
      pair: `${row.inputToken.symbol}/${row.outputToken.symbol}`,
      branch: row.branch,
      label: row.label,
      quoteId: row.bestRoute.quoteId,
      routeTags: row.bestRoute.routeTags,
      dexProvider: row.bestRoute.dexProvider,
      bridgeProvider: row.bestRoute.bridgeProvider,
      outputValueUsd: row.bestRoute.outputValueUsd,
      gasUsd: row.bestRoute.gasUsd,
      estimatedTimeSec: row.bestRoute.estimatedTimeSec,
      approvalSpender: row.bestRoute.approvalSpender,
      txTarget: row.bestRoute.txTarget,
      routePositive: false,
      blocker: "Socket quote is route intelligence only; exact branch economics and fork proof are required",
    }));
}

async function main() {
  const apiBase = sanitizeApiBase(argValue("--api-base", DEFAULT_API_BASE));
  const wallet = normalizeAddress(argValue("--wallet", DEFAULT_WALLET)) || DEFAULT_WALLET;
  const timeoutMs = Math.max(3_000, asNumber(argValue("--timeout-ms", DEFAULT_TIMEOUT_MS)) || DEFAULT_TIMEOUT_MS);
  const slippage = String(argValue("--slippage", DEFAULT_SLIPPAGE));
  const maxRequests = Math.max(1, Math.min(DEFAULT_REQUESTS.length, asNumber(argValue("--max-requests", DEFAULT_MAX_REQUESTS)) || DEFAULT_MAX_REQUESTS));
  const requests = DEFAULT_REQUESTS.slice(0, maxRequests);
  const requestedChainIds = [...new Set(requests.flatMap((r) => [r.input.chainId, r.output.chainId]))].sort((a, b) => a - b);

  const metadata = await fetchSupportedChains(apiBase, requestedChainIds, timeoutMs);
  const quoteRows = [];
  const errors = [];

  for (const request of requests) {
    try {
      const { httpStatus, json } = await fetchQuoteJson(apiBase, request, wallet, slippage, timeoutMs);
      if (json?.success !== true || !json?.result) {
        errors.push({
          requestId: request.id,
          label: request.label,
          httpStatus,
          message: json?.message || json?.error || "quote request failed",
          routePositive: false,
        });
        quoteRows.push({
          requestId: request.id,
          label: request.label,
          branch: request.branch,
          originChainId: request.input.chainId,
          destinationChainId: request.output.chainId,
          inputToken: tokenSummary(request.input),
          outputToken: tokenSummary(request.output),
          inputAmount: request.amount,
          httpStatus,
          routesReturned: 0,
          bestRoute: null,
          routes: [],
          error: json?.message || json?.error || "quote request failed",
          routePositive: false,
          signedActionJustified: false,
        });
      } else {
        quoteRows.push(summarizeQuoteRow(request, json.result, httpStatus));
      }
    } catch (err) {
      const message = err?.message || String(err);
      errors.push({ requestId: request.id, label: request.label, httpStatus: null, message, routePositive: false });
      quoteRows.push({
        requestId: request.id,
        label: request.label,
        branch: request.branch,
        originChainId: request.input.chainId,
        destinationChainId: request.output.chainId,
        inputToken: tokenSummary(request.input),
        outputToken: tokenSummary(request.output),
        inputAmount: request.amount,
        httpStatus: null,
        routesReturned: 0,
        bestRoute: null,
        routes: [],
        error: message,
        routePositive: false,
        signedActionJustified: false,
      });
    }
    await sleep(REQUEST_DELAY_MS);
  }

  const allRoutes = quoteRows.flatMap((row) => row.routes || []);
  const bestRoute = allRoutes.slice().sort((a, b) => routeScore(b) - routeScore(a))[0] || null;
  const sameChainRoutes = allRoutes.filter((route) => route.originChainId === route.destinationChainId).length;
  const crossChainRoutes = allRoutes.length - sameChainRoutes;
  const uniqueDexProviders = collectUnique(quoteRows, (route) => route.providers?.dex?.name);
  const uniqueBridgeProviders = collectUnique(quoteRows, (route) => route.providers?.bridge?.name);
  const uniqueApprovalSpenders = collectUnique(quoteRows, (route) => route.approval?.spenderAddress);
  const uniqueTxTargets = collectUnique(quoteRows, (route) => route.txTarget?.to);
  const rowsWithAnyQuote = quoteRows.filter((row) => row.routesReturned > 0).length;
  const topRows = topRowsFromQuoteRows(quoteRows);

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/quote-socket-routes.js",
    scope: "Read-only Socket/Bungee v3 same-chain and cross-chain quote adapter",
    api: {
      baseUrl: apiBase,
      quoteEndpoint: "/v3/swap/quote",
      statusEndpoint: "/v3/swap/status",
      supportedChainsEndpoint: "/v3/swap/supported-chains",
      userOps: "tx",
      slippagePct: slippage,
      publicEndpoint: apiBase === DEFAULT_API_BASE,
    },
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      calldataStored: false,
      statusPolled: false,
      routePositive: false,
      signedActionJustified: false,
    },
    executionPolicy: {
      liveExecutionEnabled: false,
      storesFullTxData: false,
      requiredBeforeAnyFutureExecution: [
        "route-specific exact positive economics after gas, slippage, and fees",
        "fork extraction proof or fork-equivalent proof with measured profit",
        "approval spender and tx target allowlists per chain",
        "fresh staticCall and estimateGas against returned tx target",
        "minProfit and minOut gates",
        "explicit operator authorization",
      ],
    },
    metadata,
    summary: {
      requestedPairs: requests.length,
      successfulRequests: quoteRows.filter((row) => row.httpStatus === 200).length,
      failedRequests: errors.length,
      rowsWithAnyQuote,
      rowsWithNoQuote: quoteRows.filter((row) => row.routesReturned === 0).length,
      routeCount: allRoutes.length,
      sameChainRoutes,
      crossChainRoutes,
      uniqueDexProviders: uniqueDexProviders.length,
      uniqueBridgeProviders: uniqueBridgeProviders.length,
      uniqueApprovalSpenders: uniqueApprovalSpenders.length,
      uniqueTxTargets: uniqueTxTargets.length,
      bestRouteLabel: bestRoute?.label || null,
      bestOutputValueUsd: round(bestRoute?.output?.valueInUsd, 8),
      bestGasUsd: round(bestRoute?.gasFee?.feeInUsd, 8),
      exactEconomicsRows: 0,
      forkProofRows: 0,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      closedReason: "Socket routes are quote intelligence only; no branch-specific exact positive economics or fork proof is present.",
    },
    providers: {
      dex: uniqueDexProviders,
      bridge: uniqueBridgeProviders,
      approvalSpenders: uniqueApprovalSpenders,
      txTargets: uniqueTxTargets,
    },
    quoteRows,
    topRows,
    errors,
    requiredForRoutePositive: [
      "Socket quote maps to a concrete exploit/liquidation/bridge branch with live state",
      "input acquisition, output unwind, gas, bridge fees, and slippage are exact and positive",
      "returned spender and tx target are verified against chain-specific allowlists",
      "fork extraction proof demonstrates positive net profit",
      "fresh preflight and explicit authorization exist before any signed action",
    ],
    nextReadOnlyStep: "Use sanitized Socket routes to enrich Aave V4, Morpho, HyperLend, and cross-chain funding comparisons; fork only after a branch becomes exact-economics positive.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);

  if (!QUIET) {
    console.log(`Socket routes: requests=${requests.length} routes=${allRoutes.length} rowsWithAnyQuote=${rowsWithAnyQuote} failures=${errors.length}`);
    console.log(`Providers: dex=${uniqueDexProviders.join(",") || "none"} bridge=${uniqueBridgeProviders.join(",") || "none"}`);
    console.log("routePositive=0 executableNow=0 signedActionJustified=false");
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
