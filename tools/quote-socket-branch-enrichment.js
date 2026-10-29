#!/usr/bin/env node
// Branch-specific read-only Socket/Bungee v3 route enrichment.
// Uses existing hot-branch artifacts to quote exact seized-collateral exit sizes.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "socket-branch-enrichment.json");

const DEFAULT_API_BASE = "https://public-backend.socket.tech";
const DEFAULT_WALLET = "0x24e46e91dFAAD1FA3d49C48Aa85ca9306885ce0a";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SLIPPAGE = "0.5";
const REQUEST_DELAY_MS = 900;
const RATE_LIMIT_RETRY_MS = 2_750;
const MAX_REQUESTS_DEFAULT = 12;

const QUIET = process.argv.includes("--quiet");

const FILES = {
  aaveWatch: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-watch.json"),
  aaveShadowQuotes: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-shadow-quotes.json"),
  morphoHighApy: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-high-apy-liquidation-routes.json"),
  hyperlendStaleSource: path.join(WORKSPACE, "reports", "raw", "fast", "hyperlend-stale-source-routes.json"),
};

function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

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
    decimals: asNumber(token.decimals),
  };
}

function protocolSummary(protocol = {}) {
  if (!protocol) return null;
  return { name: protocol.name || null, displayName: protocol.displayName || null };
}

function rawToNumber(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try {
    const value = BigInt(String(raw));
    const scale = 10n ** BigInt(decimals);
    const whole = value / scale;
    const frac = value % scale;
    const fracText = frac.toString().padStart(Number(decimals), "0").slice(0, 12);
    return Number(`${whole.toString()}.${fracText}`);
  } catch (_) {
    return null;
  }
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
    const res = await fetch(url, { method: "GET", headers: { accept: "application/json" }, signal: controller.signal });
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

async function fetchQuoteJson(apiBase, request, wallet, slippage, timeoutMs) {
  const first = await fetchJson(quoteUrl(apiBase, request, wallet, slippage), timeoutMs);
  if (first.httpStatus !== 429) return first;
  await sleep(RATE_LIMIT_RETRY_MS);
  return fetchJson(quoteUrl(apiBase, request, wallet, slippage), timeoutMs);
}

function sanitizeRoute(route = {}, result = {}, request = {}) {
  const txObject = route.txData?.object || {};
  const dexDetails = route.routeDetails?.dexDetails || null;
  const bridgeDetails = route.routeDetails?.bridgeDetails || null;
  return {
    quoteId: route.quoteId || null,
    expiresAt: asNumber(route.expiresAt),
    originChainId: asNumber(result.originChainId ?? request.input.chainId),
    destinationChainId: asNumber(result.destinationChainId ?? request.output.chainId),
    input: {
      token: tokenSummary(result.input?.token || request.input),
      amount: String(result.input?.amount || request.amount),
      valueInUsd: round(result.input?.valueInUsd, 8),
      priceInUsd: round(result.input?.priceInUsd, 8),
    },
    output: {
      token: tokenSummary(route.output?.token || request.output),
      amount: route.output?.amount ? String(route.output.amount) : null,
      minAmountOut: route.output?.minAmountOut ? String(route.output.minAmountOut) : null,
      valueInUsd: round(route.output?.valueInUsd, 8),
      priceInUsd: round(route.output?.priceInUsd, 8),
    },
    estimatedTimeSec: asNumber(route.estimatedTime),
    routeTags: Array.isArray(route.routeTags) ? route.routeTags.slice(0, 8).map(String) : [],
    providers: {
      dex: protocolSummary(dexDetails?.protocol),
      bridge: protocolSummary(bridgeDetails?.protocol),
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
      gasLimit: route.gasFee.gasLimit ? String(route.gasFee.gasLimit) : null,
      estimatedFee: route.gasFee.estimatedFee ? String(route.gasFee.estimatedFee) : null,
      feeInUsd: round(route.gasFee.feeInUsd, 8),
    } : null,
  };
}

function routeScore(route) {
  return (asNumber(route.output?.valueInUsd) || 0) - (asNumber(route.gasFee?.feeInUsd) || 0);
}

function conservativeMinOutUsd(route) {
  const minOut = route.output?.minAmountOut;
  const decimals = asNumber(route.output?.token?.decimals);
  const price = asNumber(route.output?.priceInUsd);
  const amount = rawToNumber(minOut, decimals);
  if (amount === null || price === null) return null;
  return amount * price;
}

function routeRawAmountUsd(rawAmount, decimals, priceUsd) {
  const amount = rawToNumber(rawAmount, decimals);
  const price = asNumber(priceUsd);
  if (amount === null || price === null) return null;
  return amount * price;
}

function branchRepayTokenPriceUsd(source = {}) {
  const repayAmount = rawToNumber(source.repayRaw, source.repayTokenDecimals);
  const repayUsd = asNumber(source.repayUsd);
  if (repayAmount === null || repayAmount <= 0 || repayUsd === null) return null;
  return repayUsd / repayAmount;
}

function bestSanitizedRoute(routes) {
  return routes.slice().sort((a, b) => routeScore(b) - routeScore(a))[0] || null;
}

function aaveRequests(aaveWatch = {}, aaveShadow = {}) {
  const watchSummary = aaveWatch?.latest?.summary || {};
  const rows = Array.isArray(aaveShadow.rows) ? aaveShadow.rows : [];
  return rows.slice(0, 6).map((row) => {
    const tokens = row.quote?.path?.tokens || [];
    const inputAddress = compactAddress(tokens[0]);
    const outputAddress = compactAddress(tokens[tokens.length - 1]);
    if (!inputAddress || !outputAddress || !row.collateral?.seizedRaw) return null;
    return {
      id: `aave-v4-${row.fraction}`,
      branch: "aave-v4-near-liquidation",
      label: `Aave V4 ${row.collateral.symbol}->${row.repay.symbol} fraction ${row.fraction}`,
      input: { chainId: 1, address: inputAddress, symbol: row.collateral.symbol, decimals: 18 },
      output: { chainId: 1, address: outputAddress, symbol: row.repay.symbol, decimals: 18 },
      amount: String(row.collateral.seizedRaw),
      source: {
        user: row.user,
        fraction: row.fraction,
        healthFactor: asNumber(watchSummary.closestHealthFactor ?? row.healthFactor),
        bpsToLiquidation: asNumber(watchSummary.closestBpsToLiquidation ?? row.bpsToLiquidation),
        currentlyLiquidatable: Boolean(row.liquidatable || false),
        repayUsd: asNumber(row.repay?.amountUsd),
        repayRaw: row.repay?.amountRaw ? String(row.repay.amountRaw) : null,
        repayTokenDecimals: 18,
        repayTokenSymbol: row.repay?.symbol || null,
        branchGasUsd: asNumber(row.gasUsd),
        existingNetProfitUsd: asNumber(row.netProfitUsd),
        blocker: "Aave borrower is not currently liquidatable while HF is above 1",
      },
    };
  }).filter(Boolean);
}

function morphoRequests(morpho = {}) {
  const rows = Array.isArray(morpho.results) ? morpho.results : [];
  const requests = [];
  for (const row of rows) {
    const inputAddress = compactAddress(row.collateral?.address);
    const outputAddress = compactAddress(row.loanAsset?.address);
    if (!inputAddress || !outputAddress) continue;
    const sizeResults = Array.isArray(row.sizeResults) ? row.sizeResults : [];
    for (const size of sizeResults) {
      if (!size?.seizedCollateralRaw || size.seizedExceedsCollateral) continue;
      requests.push({
        id: `morpho-${row.marketId?.slice(0, 10) || requests.length}-${size.fraction}`,
        branch: "morpho-high-apy-liquidation",
        label: `Morpho ${row.pair} fraction ${size.fraction}`,
        input: { chainId: 1, address: inputAddress, symbol: row.collateral?.symbol, decimals: asNumber(row.collateral?.decimals) || 18 },
        output: { chainId: 1, address: outputAddress, symbol: row.loanAsset?.symbol, decimals: asNumber(row.loanAsset?.decimals) || 18 },
        amount: String(size.seizedCollateralRaw),
        source: {
          borrower: row.borrower,
          marketId: row.marketId,
          pair: row.pair,
          fraction: size.fraction,
          currentlyLiquidatable: Boolean(row.currentLiquidatable),
          repayUsd: asNumber(size.repayUsd),
          repayRaw: size.repaidAssetsRaw ? String(size.repaidAssetsRaw) : null,
          repayTokenDecimals: asNumber(row.loanAsset?.decimals) || 18,
          repayTokenSymbol: row.loanAsset?.symbol || null,
          branchGasUsd: asNumber(morpho.gas?.liquidationGasUsd),
          existingBestNetProfitUsd: Math.max(...(size.quotes || []).map((q) => asNumber(q.netProfitUsd)).filter((n) => n !== null), -Infinity),
          blocker: "Morpho row still needs fork proof and full liquidation simulation even if an exit quote improves",
        },
      });
    }
  }
  return requests.slice(0, 6);
}

function hyperlendSkippedRows(hyperlend = {}, supportedChainIds = new Set()) {
  const chainId = asNumber(hyperlend.chain?.id) || 999;
  const supported = supportedChainIds.has(chainId);
  return (hyperlend.watchRows || []).filter((row) => row.route).slice(0, 6).map((row) => ({
    branch: "hyperlend-stale-source",
    label: `HyperLend ${row.route?.borrowSymbol || row.symbol} route`,
    chainId,
    socketSupportedChain: supported,
    routeLiquidityUsd: round(row.route?.routeLiquidityUsd, 2),
    estimatedGrossEdgeUsd: round(row.route?.estimatedGrossEdgeUsd, 6),
    staleAccepted: Boolean(row.staleAccepted),
    materialDivergence: Boolean(row.materialDivergence),
    routePositive: false,
    blocker: supported
      ? "Socket chain support exists, but HyperLend divergence gates are still below threshold"
      : "Socket v3 public metadata did not list HyperEVM chain support for tx routes",
  }));
}

async function supportedChains(apiBase, timeoutMs) {
  try {
    const { httpStatus, json } = await fetchJson(`${apiBase}/v3/swap/supported-chains`, timeoutMs);
    const rows = Array.isArray(json?.result) ? json.result : [];
    return {
      httpStatus,
      chainIds: new Set(rows.map((row) => asNumber(row.chainId)).filter((n) => n !== null)),
      rows: rows.map((row) => ({ chainId: asNumber(row.chainId), name: row.name || null })).filter((row) => row.chainId !== null),
    };
  } catch (err) {
    return { httpStatus: null, chainIds: new Set(), rows: [], error: err?.message || String(err) };
  }
}

async function enrichRequest(apiBase, request, wallet, slippage, timeoutMs) {
  const { httpStatus, json } = await fetchQuoteJson(apiBase, request, wallet, slippage, timeoutMs);
  if (json?.success !== true || !json?.result) {
    return {
      id: request.id,
      branch: request.branch,
      label: request.label,
      httpStatus,
      input: tokenSummary(request.input),
      output: tokenSummary(request.output),
      amount: request.amount,
      routesReturned: 0,
      bestRoute: null,
      economics: null,
      source: request.source,
      routePositive: false,
      blocker: json?.message || "Socket quote failed",
    };
  }
  const routes = (json.result.routes || []).map((route) => sanitizeRoute(route, json.result, request));
  const best = bestSanitizedRoute(routes);
  const branchPriceUsd = branchRepayTokenPriceUsd(request.source);
  const minOutUsdFromBranchPrice = best ? routeRawAmountUsd(best.output?.minAmountOut, best.output?.token?.decimals, branchPriceUsd) : null;
  const outputUsdFromBranchPrice = best ? routeRawAmountUsd(best.output?.amount, best.output?.token?.decimals, branchPriceUsd) : null;
  const minOutUsd = minOutUsdFromBranchPrice ?? (best ? conservativeMinOutUsd(best) : null);
  const outputUsd = outputUsdFromBranchPrice ?? asNumber(best?.output?.valueInUsd);
  const repayUsd = asNumber(request.source?.repayUsd);
  const socketGasUsd = asNumber(best?.gasFee?.feeInUsd) || 0;
  const branchGasUsd = asNumber(request.source?.branchGasUsd) || 0;
  const conservativeNetUsd = minOutUsd !== null && repayUsd !== null
    ? minOutUsd - repayUsd - socketGasUsd - branchGasUsd
    : null;
  const optimisticNetUsd = outputUsd !== null && repayUsd !== null
    ? outputUsd - repayUsd - socketGasUsd - branchGasUsd
    : null;
  const exactEconomicsPositive = conservativeNetUsd !== null && conservativeNetUsd > 0;
  const triggerReady = request.branch === "aave-v4-near-liquidation"
    ? Boolean(request.source?.currentlyLiquidatable)
    : Boolean(request.source?.currentlyLiquidatable);
  return {
    id: request.id,
    branch: request.branch,
    label: request.label,
    httpStatus,
    input: tokenSummary(request.input),
    output: tokenSummary(request.output),
    amount: request.amount,
    routesReturned: routes.length,
    bestRoute: best ? {
      quoteId: best.quoteId,
      outputAmount: best.output.amount,
      minAmountOut: best.output.minAmountOut,
      outputValueUsd: best.output.valueInUsd,
      gasUsd: best.gasFee?.feeInUsd ?? null,
      estimatedTimeSec: best.estimatedTimeSec,
      routeTags: best.routeTags,
      dexProvider: best.providers.dex?.name || null,
      bridgeProvider: best.providers.bridge?.name || null,
      approvalSpender: best.approval?.spenderAddress || null,
      txTarget: best.txTarget.to || null,
      calldataStored: false,
    } : null,
    economics: {
      repayUsd: round(repayUsd, 6),
      minOutUsd: round(minOutUsd, 6),
      outputUsd: round(outputUsd, 6),
      socketGasUsd: round(socketGasUsd, 6),
      branchGasUsd: round(branchGasUsd, 6),
      conservativeNetUsd: round(conservativeNetUsd, 6),
      optimisticNetUsd: round(optimisticNetUsd, 6),
      priceBasis: branchPriceUsd !== null ? "branch-repay-token-price" : "socket-output-value-usd",
      branchRepayTokenPriceUsd: round(branchPriceUsd, 8),
      exactEconomicsPositive,
      triggerReady,
    },
    source: request.source,
    routes: routes.slice(0, 4),
    routePositive: false,
    blocker: exactEconomicsPositive
      ? "Socket quote improves exact exit economics, but route remains fail-closed pending trigger state, fork proof, and execution allowlists"
      : "Socket quote does not make conservative branch economics positive",
  };
}

function unique(items) {
  return [...new Set((items || []).filter(Boolean))].sort();
}

async function main() {
  const apiBase = sanitizeApiBase(argValue("--api-base", DEFAULT_API_BASE));
  const wallet = normalizeAddress(argValue("--wallet", DEFAULT_WALLET)) || DEFAULT_WALLET;
  const timeoutMs = Math.max(3_000, asNumber(argValue("--timeout-ms", DEFAULT_TIMEOUT_MS)) || DEFAULT_TIMEOUT_MS);
  const slippage = String(argValue("--slippage", DEFAULT_SLIPPAGE));
  const maxRequests = Math.max(1, asNumber(argValue("--max-requests", MAX_REQUESTS_DEFAULT)) || MAX_REQUESTS_DEFAULT);

  const aaveWatch = readJson(FILES.aaveWatch, {});
  const aaveShadow = readJson(FILES.aaveShadowQuotes, {});
  const morpho = readJson(FILES.morphoHighApy, {});
  const hyperlend = readJson(FILES.hyperlendStaleSource, {});
  const chainMeta = await supportedChains(apiBase, timeoutMs);

  const requests = [
    ...aaveRequests(aaveWatch, aaveShadow),
    ...morphoRequests(morpho),
  ].slice(0, maxRequests);

  const quoteRows = [];
  for (const request of requests) {
    quoteRows.push(await enrichRequest(apiBase, request, wallet, slippage, timeoutMs));
    await sleep(REQUEST_DELAY_MS);
  }

  const hyperlendRows = hyperlendSkippedRows(hyperlend, chainMeta.chainIds);
  const exactEconomicsRows = quoteRows.filter((row) => row.economics?.exactEconomicsPositive).length;
  const triggerReadyRows = quoteRows.filter((row) => row.economics?.triggerReady).length;
  const triggerReadyExactEconomicsRows = quoteRows.filter((row) => row.economics?.exactEconomicsPositive && row.economics?.triggerReady).length;
  const quotedRows = quoteRows.filter((row) => row.routesReturned > 0).length;
  const topRows = quoteRows
    .filter((row) => row.bestRoute)
    .sort((a, b) => (asNumber(b.economics?.conservativeNetUsd) || -Infinity) - (asNumber(a.economics?.conservativeNetUsd) || -Infinity))
    .slice(0, 8)
    .map((row) => ({
      protocol: row.branch === "aave-v4-near-liquidation" ? "Aave V4" : "Morpho Blue",
      chain: "Ethereum",
      pair: `${row.input.symbol}/${row.output.symbol}`,
      label: row.label,
      conservativeNetUsd: row.economics?.conservativeNetUsd,
      optimisticNetUsd: row.economics?.optimisticNetUsd,
      exactEconomicsPositive: row.economics?.exactEconomicsPositive,
      triggerReady: row.economics?.triggerReady,
      dexProvider: row.bestRoute?.dexProvider || null,
      routePositive: false,
      blocker: row.blocker,
    }));

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/quote-socket-branch-enrichment.js",
    scope: "Read-only Socket quote enrichment for Aave V4, Morpho high-APY, and HyperLend stale-source branches",
    api: {
      baseUrl: apiBase,
      quoteEndpoint: "/v3/swap/quote",
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
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    sourceArtifacts: {
      aaveWatch: "reports/raw/fast/aave-v4-liquidation-watch.json",
      aaveShadowQuotes: "reports/raw/fast/aave-v4-liquidation-shadow-quotes.json",
      morphoHighApy: "reports/raw/fast/morpho-high-apy-liquidation-routes.json",
      hyperlendStaleSource: "reports/raw/fast/hyperlend-stale-source-routes.json",
    },
    metadata: {
      supportedChainsHttpStatus: chainMeta.httpStatus,
      supportedChainsCount: chainMeta.rows.length,
      hyperlendChainSupportedBySocket: chainMeta.chainIds.has(asNumber(hyperlend.chain?.id) || 999),
    },
    summary: {
      requestsBuilt: requests.length,
      quotedRows,
      failedQuoteRows: quoteRows.filter((row) => row.routesReturned === 0).length,
      totalRoutesReturned: quoteRows.reduce((acc, row) => acc + (asNumber(row.routesReturned) || 0), 0),
      aaveRowsQuoted: quoteRows.filter((row) => row.branch === "aave-v4-near-liquidation" && row.routesReturned > 0).length,
      morphoRowsQuoted: quoteRows.filter((row) => row.branch === "morpho-high-apy-liquidation" && row.routesReturned > 0).length,
      hyperlendRowsSkipped: hyperlendRows.length,
      exactEconomicsRows,
      triggerReadyRows,
      triggerReadyExactEconomicsRows,
      forkProofRows: 0,
      uniqueDexProviders: unique(quoteRows.map((row) => row.bestRoute?.dexProvider)).length,
      uniqueApprovalSpenders: unique(quoteRows.map((row) => row.bestRoute?.approvalSpender)).length,
      bestConservativeNetUsd: round(Math.max(...quoteRows.map((row) => asNumber(row.economics?.conservativeNetUsd)).filter((n) => n !== null), -Infinity), 6),
      bestOptimisticNetUsd: round(Math.max(...quoteRows.map((row) => asNumber(row.economics?.optimisticNetUsd)).filter((n) => n !== null), -Infinity), 6),
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      closedReason: "Socket branch quotes do not satisfy trigger-ready plus exact-economics plus fork-proof gates.",
    },
    providers: {
      dex: unique(quoteRows.map((row) => row.bestRoute?.dexProvider)),
      bridge: unique(quoteRows.map((row) => row.bestRoute?.bridgeProvider)),
      approvalSpenders: unique(quoteRows.map((row) => row.bestRoute?.approvalSpender)),
      txTargets: unique(quoteRows.map((row) => row.bestRoute?.txTarget)),
    },
    quoteRows,
    hyperlendRows,
    topRows,
    requiredForRoutePositive: [
      "branch trigger is live now (Aave HF < 1, Morpho exact liquidation/fork route, or HyperLend material divergence)",
      "Socket quote remains exact-economics positive after gas, slippage, and branch costs",
      "returned spender and tx target are chain-specific allowlisted and independently simulated",
      "fork extraction proof demonstrates positive net value",
      "fresh staticCall/estimateGas/minOut/minProfit gates and explicit authorization before any signed action",
    ],
    nextReadOnlyStep: "Keep Aave V4 watcher hot; rerun branch Socket enrichment only after HF < 1 or Morpho/HyperLend route gates materially improve.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);

  if (!QUIET) {
    console.log(`Socket branch enrichment: requests=${requests.length} quoted=${quotedRows} exactEconomicsRows=${exactEconomicsRows} triggerReadyRows=${triggerReadyRows}`);
    console.log(`routePositive=0 executableNow=0 signedActionJustified=false`);
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
