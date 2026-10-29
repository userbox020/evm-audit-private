#!/usr/bin/env node
// quote-hyperevm-lst-lrt-exact-routes.js - targeted read-only exact quote probe.
// RPC URLs are resolved in memory only and are never printed or written.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const BASE_ARTIFACT = path.join(WORKSPACE, "reports", "raw", "fast", "hyperevm-lst-lrt-oracle-routes.json");
const POOL_INTERFACES = path.join(WORKSPACE, "reports", "raw", "fast", "hyperevm-dex-pool-interfaces.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "hyperevm-lst-lrt-exact-quotes.json");
const CHAIN_ID = 999;
const FALLBACK_RPC = ["https://", "rpc.", "hyperliquid.", "xyz/evm"].join("");
const WHYPE = "0x5555555555555555555555555555555555555555";

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const PAIR = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)",
]);
const PAIR_THREE_ARG = new ethers.Interface([
  "function getAmountOut(uint256 amountIn, address tokenIn, address tokenOut) view returns (uint256)",
]);
const UNI_V3_QUOTER = new ethers.Interface([
  "function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const HYPERSWAP_MIXED_QUOTER = new ethers.Interface([
  "function quoteExactInputSingleV3(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const TICK_SPACING_QUOTER = new ethers.Interface([
  "function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const RAMSES_OLD_QUOTER = new ethers.Interface([
  "function quoteExactInputSingle(address tokenIn,address tokenOut,int24 tickSpacing,uint256 amountIn,uint160 sqrtPriceLimitX96) returns (uint256 amountOut)",
]);
const ALGEBRA_QUOTER = new ethers.Interface([
  "function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint256 amountInUsed,uint160 sqrtPriceAfter,uint32 initializedTicksCrossed,uint256 gasEstimate,uint16 fee)",
]);
const ALGEBRA_OLD_QUOTER = new ethers.Interface([
  "function quoteExactInputSingle(address tokenIn,address tokenOut,uint256 amountIn,uint160 sqrtPriceLimitX96) returns (uint256 amountOut,uint16 fee)",
]);

const QUOTER_BY_FACTORY = new Map([
  ["0xff7b3e8c00e57ea31477c32a5b52a58eea47b072", { label: "prjx", quoter: "0x239F11a7A3E08f2B8110D4CA9F6B95d4c8865258", kind: "uni-v3-fee-struct" }],
  ["0xb1c0fa0b789320044a6f623cfe5ebda9562602e3", { label: "hyperswap", quoter: "0xEc8F3D08Dd762e935fb914bD2b2E788e5E423516", kind: "hyperswap-mixed-v3" }],
  ["0x07e60782535752be279929e2dffdd136db2e6b45", { label: "ramses", quoter: "0x403Bf94fe505cA0F0b1563C350B57dCeC8303ECd", fallbackQuoter: "0x5126e63dD031301ACCDf1a5137EA5CAEB1125D52", kind: "tick-spacing-struct" }],
  ["0x32b9da73215255d50d84feb51540b75acc1324c2", { label: "hybra", quoter: "0x8CD6acfF822eE9E3240501b3CeDa64364791e4E2", kind: "tick-spacing-struct" }],
  ["0xf77bd082c627aa54591cf2f2eaa811fd1ab3b1f3", { label: "nest", quoter: "0xBea20609A4772311c5b81F814Cd4f9ECaEF5DFAd", fallbackQuoter: "0x89C3aB4F5342498e9EdAC5C43C07e9Bd9AE4DB78", kind: "algebra-struct" }],
]);

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function sanitizeError(error) {
  return String(error?.shortMessage || error?.message || error || "error").replace(/https?:\/\/\S+/g, "[redacted-url]").slice(0, 180);
}

function lowerAddress(value) {
  try { return ethers.getAddress(value).toLowerCase(); } catch (_) { return null; }
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 4) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function bps(a, b) {
  const x = asNumber(a);
  const y = asNumber(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0) return null;
  return ((x - y) / y) * 10_000;
}

function decimalString(value, precision = 12) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0";
  return n.toFixed(precision).replace(/0+$/g, "").replace(/\.$/g, "");
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 10_000) {
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
    return json.result || null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcUrl() {
  const seen = new Set();
  const candidates = [...loadRpcUrls(), FALLBACK_RPC].filter((url) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
  for (let round = 0; round < 3; round += 1) {
    for (const url of candidates) {
      const got = await rpcCall(url, "eth_chainId", [], 12_000);
      try {
        if (got && Number(BigInt(got)) === CHAIN_ID) return url;
      } catch (_) {
        // ignore
      }
    }
  }
  return null;
}

async function withRetry(fn, attempts = 3) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

async function getCodeSafe(provider, address) {
  try {
    return await withRetry(() => provider.getCode(address), 2);
  } catch (_) {
    return null;
  }
}

async function safeCall(provider, target, iface, name, args = []) {
  try {
    const raw = await provider.call({ to: target, data: iface.encodeFunctionData(name, args) });
    return { ok: true, value: iface.decodeFunctionResult(name, raw) };
  } catch (error) {
    return { ok: false, error: sanitizeError(error) };
  }
}

async function safeQuoterCall(provider, target, iface, name, args = []) {
  try {
    const raw = await provider.call({ to: target, data: iface.encodeFunctionData(name, args) });
    return { ok: true, value: iface.decodeFunctionResult(name, raw) };
  } catch (error) {
    return { ok: false, error: sanitizeError(error) };
  }
}

function firstValue(result) {
  try { return Array.from(result?.value || [])[0] ?? null; } catch (_) { return null; }
}

function poolMetaFor(poolInterfaces, pairAddress) {
  const key = lowerAddress(pairAddress);
  return (poolInterfaces?.rows || []).find((row) => lowerAddress(row.pairAddress) === key) || null;
}

async function quoteViaConfiguredQuoter(provider, poolMeta, input, output, amountInRaw) {
  const factoryKey = lowerAddress(poolMeta?.factory);
  const config = factoryKey ? QUOTER_BY_FACTORY.get(factoryKey) : null;
  if (!config) return { ok: false, error: "no verified quoter configured for pool factory" };
  const quoter = ethers.getAddress(config.quoter);
  const code = await getCodeSafe(provider, quoter);
  if (!code || code === "0x") return { ok: false, error: "configured quoter has no code", quoter, quoterLabel: config.label };
  const fee = Number(poolMeta?.interfaces?.fee ?? 0);
  const tickSpacing = Number(poolMeta?.interfaces?.tickSpacing ?? 0);
  const sqrtPriceLimitX96 = 0n;
  const errors = [];
  const attempts = [];
  if (config.kind === "uni-v3-fee-struct") {
    attempts.push({ target: quoter, iface: UNI_V3_QUOTER, name: "quoteExactInputSingle", args: [[input, output, amountInRaw, fee, sqrtPriceLimitX96]], method: `${config.label}.QuoterV2.quoteExactInputSingle(fee=${fee})` });
  } else if (config.kind === "hyperswap-mixed-v3") {
    attempts.push({ target: quoter, iface: HYPERSWAP_MIXED_QUOTER, name: "quoteExactInputSingleV3", args: [[input, output, amountInRaw, fee, sqrtPriceLimitX96]], method: `${config.label}.MixedRouteQuoter.quoteExactInputSingleV3(fee=${fee})` });
  } else if (config.kind === "tick-spacing-struct") {
    attempts.push({ target: quoter, iface: TICK_SPACING_QUOTER, name: "quoteExactInputSingle", args: [[input, output, amountInRaw, tickSpacing, sqrtPriceLimitX96]], method: `${config.label}.QuoterV2.quoteExactInputSingle(tickSpacing=${tickSpacing})` });
    if (config.fallbackQuoter) attempts.push({ target: ethers.getAddress(config.fallbackQuoter), iface: RAMSES_OLD_QUOTER, name: "quoteExactInputSingle", args: [input, output, tickSpacing, amountInRaw, sqrtPriceLimitX96], method: `${config.label}.Quoter.quoteExactInputSingle(tickSpacing=${tickSpacing})` });
  } else if (config.kind === "algebra-struct") {
    attempts.push({ target: quoter, iface: ALGEBRA_QUOTER, name: "quoteExactInputSingle", args: [[input, output, amountInRaw, sqrtPriceLimitX96]], method: `${config.label}.QuoterV2.quoteExactInputSingle` });
    if (config.fallbackQuoter) attempts.push({ target: ethers.getAddress(config.fallbackQuoter), iface: ALGEBRA_OLD_QUOTER, name: "quoteExactInputSingle", args: [input, output, amountInRaw, sqrtPriceLimitX96], method: `${config.label}.Quoter.quoteExactInputSingle` });
  }
  for (const attempt of attempts) {
    const attemptCode = await getCodeSafe(provider, attempt.target);
    if (!attemptCode || attemptCode === "0x") {
      errors.push(`${attempt.method}: quoter has no code`);
      continue;
    }
    const result = await safeQuoterCall(provider, attempt.target, attempt.iface, attempt.name, attempt.args);
    const amountOutRaw = firstValue(result);
    if (result.ok && amountOutRaw !== null) {
      return {
        ok: true,
        quoter: attempt.target,
        quoterLabel: config.label,
        method: attempt.method,
        amountOutRaw,
        factory: poolMeta.factory,
        poolFee: fee || null,
        tickSpacing: tickSpacing || null,
      };
    }
    errors.push(`${attempt.method}: ${result.error || "empty result"}`);
  }
  return { ok: false, quoter, quoterLabel: config.label, error: errors.join("; ").slice(0, 420) };
}

async function tokenInfo(provider, address, fallbackSymbol = null) {
  const [symbolRaw, decimalsRaw] = await Promise.all([
    safeCall(provider, address, ERC20, "symbol"),
    safeCall(provider, address, ERC20, "decimals"),
  ]);
  return {
    address: ethers.getAddress(address),
    symbol: symbolRaw.ok ? String(symbolRaw.value[0]) : fallbackSymbol,
    decimals: decimalsRaw.ok ? Number(decimalsRaw.value[0]) : 18,
  };
}

function pairContains(pair, a, b) {
  const base = lowerAddress(pair?.baseToken?.address);
  const quote = lowerAddress(pair?.quoteToken?.address);
  const aa = lowerAddress(a);
  const bb = lowerAddress(b);
  return (base === aa && quote === bb) || (base === bb && quote === aa);
}

function selectConsumerRows(artifact) {
  const rows = Array.isArray(artifact?.rows) ? artifact.rows : [];
  return rows
    .filter((row) => row.protocol === "Morpho Blue")
    .filter((row) => /hype/i.test(row.collateralAsset?.symbol || ""))
    .filter((row) => lowerAddress(row.loanAsset?.address) === lowerAddress(WHYPE) || /whype/i.test(row.loanAsset?.symbol || ""))
    .filter((row) => Number(row.state?.liquidityAssetsUsd || 0) >= Number(artifact?.thresholds?.minBorrowLiquidityUsd || 10_000))
    .sort((a, b) => Number(b.bestRouteAttempt?.estimatedNetUsd ?? -Infinity) - Number(a.bestRouteAttempt?.estimatedNetUsd ?? -Infinity))
    .slice(0, 10);
}

function targetFor(artifact, collateralAddress) {
  const key = lowerAddress(collateralAddress);
  return (artifact?.targets || []).find((target) => lowerAddress(target.address) === key) || null;
}

async function quotePair(provider, pair, collateral, whype, whypePriceUsd, sizeUsd, reserveFeeBps, poolMeta) {
  const pairAddress = ethers.getAddress(pair.pairAddress);
  const code = await getCodeSafe(provider, pairAddress);
  const codePresent = code && code !== "0x";
  if (!codePresent) return { pairAddress, codePresent: false, sizeUsd, ok: false, error: "pair has no code" };

  const [token0Raw, token1Raw] = await Promise.all([
    safeCall(provider, pairAddress, PAIR, "token0"),
    safeCall(provider, pairAddress, PAIR, "token1"),
  ]);
  if (!token0Raw.ok || !token1Raw.ok) {
    return { pairAddress, codePresent: true, sizeUsd, ok: false, error: "token0/token1 not available" };
  }
  const token0 = ethers.getAddress(token0Raw.value[0]);
  const token1 = ethers.getAddress(token1Raw.value[0]);
  const input = ethers.getAddress(whype.address);
  const output = ethers.getAddress(collateral.address);
  const inputIs0 = lowerAddress(token0) === lowerAddress(input);
  const inputIs1 = lowerAddress(token1) === lowerAddress(input);
  const outputIs0 = lowerAddress(token0) === lowerAddress(output);
  const outputIs1 = lowerAddress(token1) === lowerAddress(output);
  if (!(inputIs0 || inputIs1) || !(outputIs0 || outputIs1)) {
    return { pairAddress, codePresent: true, token0, token1, sizeUsd, ok: false, error: "pair token set does not match WHYPE/collateral" };
  }

  const amountInRaw = ethers.parseUnits(decimalString(sizeUsd / whypePriceUsd), whype.decimals);
  const direct = await safeCall(provider, pairAddress, PAIR, "getAmountOut", [amountInRaw, input]);
  let method = null;
  let amountOutRaw = null;
  let exactPoolQuote = false;
  let readError = null;
  if (direct.ok) {
    method = "pair.getAmountOut(uint256,address)";
    amountOutRaw = direct.value[0];
    exactPoolQuote = true;
  } else {
    const threeArg = await safeCall(provider, pairAddress, PAIR_THREE_ARG, "getAmountOut", [amountInRaw, input, output]);
    if (threeArg.ok) {
      method = "pair.getAmountOut(uint256,address,address)";
      amountOutRaw = threeArg.value[0];
      exactPoolQuote = true;
    } else {
      readError = `${direct.error}; ${threeArg.error}`;
    }
  }

  let reserves = null;
  if (!amountOutRaw) {
    const reservesRaw = await safeCall(provider, pairAddress, PAIR, "getReserves");
    if (reservesRaw.ok) {
      const reserve0 = reservesRaw.value[0];
      const reserve1 = reservesRaw.value[1];
      const reserveIn = inputIs0 ? reserve0 : reserve1;
      const reserveOut = outputIs0 ? reserve0 : reserve1;
      const feeDenom = 10_000n;
      const feeNumer = BigInt(Math.max(0, 10_000 - reserveFeeBps));
      const amountInWithFee = amountInRaw * feeNumer;
      amountOutRaw = (amountInWithFee * reserveOut) / (reserveIn * feeDenom + amountInWithFee);
      method = `v2-reserve-math-assumed-${reserveFeeBps}bps-fee`;
      exactPoolQuote = false;
      reserves = { reserve0: reserve0.toString(), reserve1: reserve1.toString() };
    }
  }

  if (!amountOutRaw) {
    const quoterResult = await quoteViaConfiguredQuoter(provider, poolMeta, input, output, amountInRaw);
    if (quoterResult.ok) {
      amountOutRaw = quoterResult.amountOutRaw;
      method = quoterResult.method;
      exactPoolQuote = true;
      reserves = {
        quoter: quoterResult.quoter,
        quoterLabel: quoterResult.quoterLabel,
        factory: quoterResult.factory,
        poolFee: quoterResult.poolFee,
        tickSpacing: quoterResult.tickSpacing,
      };
    } else {
      readError = [readError, quoterResult.error].filter(Boolean).join("; ");
    }
  }

  if (!amountOutRaw) {
    return { pairAddress, codePresent: true, token0, token1, sizeUsd, ok: false, exactPoolQuote: false, error: readError || "no exact quote or reserve math available" };
  }

  const tokensOut = Number(ethers.formatUnits(amountOutRaw, collateral.decimals));
  const effectiveAcquisitionPriceUsd = tokensOut > 0 ? sizeUsd / tokensOut : null;
  return {
    pairAddress,
    codePresent: true,
    dexId: pair.dexId || null,
    url: pair.url || null,
    token0,
    token1,
    sizeUsd,
    input: { symbol: whype.symbol, address: whype.address, amountRaw: amountInRaw.toString(), amount: round(sizeUsd / whypePriceUsd, 8) },
    output: { symbol: collateral.symbol, address: collateral.address, amountRaw: amountOutRaw.toString(), amount: round(tokensOut, 8) },
    method,
    exactPoolQuote,
    reserves,
    effectiveAcquisitionPriceUsd,
    noImpactPriceUsd: asNumber(pair.priceUsd),
    liquidityUsd: asNumber(pair.liquidityUsd),
    volume24hUsd: asNumber(pair.volume24hUsd),
    ok: true,
  };
}

async function main() {
  const artifact = readJson(BASE_ARTIFACT, null);
  const poolInterfaces = readJson(POOL_INTERFACES, {});
  if (!artifact) throw new Error("missing hyperevm-lst-lrt-oracle-routes artifact");
  const rpcUrl = await resolveRpcUrl();
  if (!rpcUrl) throw new Error("No HyperEVM RPC endpoint resolved from local inventory or public fallback");
  const provider = new ethers.JsonRpcProvider(rpcUrl, { chainId: CHAIN_ID, name: "hyperevm" }, { staticNetwork: true });
  const [blockNumber, block] = await Promise.all([
    withRetry(() => provider.getBlockNumber()),
    withRetry(() => provider.getBlock("latest")),
  ]);

  const whypePriceUsd = selectConsumerRows(artifact).map((row) => asNumber(row.loanAsset?.priceUsd)).find((x) => Number.isFinite(x) && x > 0)
    || asNumber(artifact?.targets?.find((t) => /whype/i.test(t.primarySymbol || ""))?.bestNav?.priceUsd)
    || null;
  if (!whypePriceUsd) throw new Error("missing WHYPE USD reference price in base artifact");

  const rows = [];
  const sizes = (artifact.thresholds?.testSizesUsd || [1000, 10000, 50000, 100000]).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  const reserveFeeBps = Number(process.env.HYPEREVM_LST_RESERVE_MATH_FEE_BPS || artifact.thresholds?.dexFeeBps || 30);
  const minRouteNetUsd = Number(artifact.thresholds?.minRouteNetUsd || 100);
  const minRouteEdgeBps = Number(artifact.thresholds?.minRouteEdgeBps || 50);
  const gasBufferUsd = Number(artifact.thresholds?.gasBufferUsd || 25);
  const whypeInfo = await tokenInfo(provider, WHYPE, "WHYPE");

  for (const consumer of selectConsumerRows(artifact)) {
    const collateralInfo = await tokenInfo(provider, consumer.collateralAsset.address, consumer.collateralAsset.symbol);
    const target = targetFor(artifact, consumer.collateralAsset.address);
    const pairs = (target?.dexPairs || [])
      .filter((pair) => pair.pairAddress && pairContains(pair, collateralInfo.address, WHYPE))
      .filter((pair) => asNumber(pair.liquidityUsd) >= Number(artifact.thresholds?.minDexLiquidityUsd || 10_000))
      .sort((a, b) => Number(b.liquidityUsd || 0) - Number(a.liquidityUsd || 0))
      .slice(0, 6);
    for (const pair of pairs) {
      for (const sizeUsd of sizes.filter((size) => size <= Number(consumer.state?.liquidityAssetsUsd || 0))) {
        const quote = await quotePair(provider, pair, collateralInfo, whypeInfo, whypePriceUsd, sizeUsd, reserveFeeBps, poolMetaFor(poolInterfaces, pair.pairAddress));
        const borrowedValueUsd = quote.ok ? Number(quote.output.amount) * Number(consumer.borrowablePerTokenUsd || 0) : null;
        const netUsd = Number.isFinite(borrowedValueUsd) ? borrowedValueUsd - sizeUsd - gasBufferUsd : null;
        const edgeBps = quote.ok ? bps(consumer.borrowablePerTokenUsd, quote.effectiveAcquisitionPriceUsd) : null;
        const routePositive = Boolean(
          quote.ok &&
          quote.exactPoolQuote &&
          netUsd >= minRouteNetUsd &&
          (edgeBps || 0) >= minRouteEdgeBps &&
          Number(consumer.state?.liquidityAssetsUsd || 0) >= sizeUsd
        );
        rows.push({
          protocol: consumer.protocol,
          marketId: consumer.marketId,
          collateral: collateralInfo,
          loanAsset: consumer.loanAsset,
          lltv: consumer.ltv,
          liquidityUsd: Number(consumer.state?.liquidityAssetsUsd || 0),
          acceptedCollateralUsd: consumer.acceptedCollateralUsd,
          borrowablePerTokenUsd: consumer.borrowablePerTokenUsd,
          quote,
          borrowedValueUsd,
          gasBufferUsd,
          netUsd,
          edgeBps,
          routePositive,
          blockers: [
            !quote.ok ? quote.error : null,
            quote.ok && !quote.exactPoolQuote ? "reserve-math quote is not an exact executable pool quote; fail closed" : null,
            quote.ok && netUsd < minRouteNetUsd ? "LLTV-adjusted borrowed value is below acquisition cost plus gas/threshold" : null,
            quote.ok && (edgeBps || 0) < minRouteEdgeBps ? "edge is below route threshold" : null,
            "no HyperEVM fork-positive extraction proof",
          ].filter(Boolean),
        });
      }
    }
  }

  rows.sort((a, b) => Number(b.netUsd ?? -Infinity) - Number(a.netUsd ?? -Infinity));
  const exactRows = rows.filter((row) => row.quote?.exactPoolQuote);
  const positiveRows = rows.filter((row) => row.routePositive);
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/quote-hyperevm-lst-lrt-exact-routes.js",
    scope: "Targeted HyperEVM HYPE LST/LRT WHYPE acquisition exact-quote probe",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: positiveRows.length > 0,
      signedActionJustified: false,
    },
    chain: { id: CHAIN_ID, name: "HyperEVM", blockNumber, timestamp: block?.timestamp || null },
    sourceArtifact: path.relative(WORKSPACE, BASE_ARTIFACT),
    poolInterfaceArtifact: path.relative(WORKSPACE, POOL_INTERFACES),
    gates: {
      routePositiveRequires: [
        "pool exact quote, not DexScreener estimate or assumed-fee reserve math",
        "LLTV-adjusted borrowed value exceeds acquisition cost, gas, and threshold",
        "borrow-side liquidity covers route size",
        "local fork extraction proof before any signed action",
      ],
    },
    summary: {
      consumerRowsConsidered: selectConsumerRows(artifact).length,
      quoteRows: rows.length,
      exactPoolQuoteRows: exactRows.length,
      reserveMathRows: rows.filter((row) => row.quote?.ok && !row.quote?.exactPoolQuote).length,
      configuredQuoterRows: rows.filter((row) => /Quoter|MixedRouteQuoter/i.test(row.quote?.method || "")).length,
      failedQuoteRows: rows.filter((row) => !row.quote?.ok).length,
      routePositive: positiveRows.length,
      signedActionJustified: false,
      bestNetUsd: round(rows[0]?.netUsd, 2),
      bestEdgeBps: round(rows[0]?.edgeBps, 2),
      bestCollateral: rows[0]?.collateral?.symbol || null,
      bestDexId: rows[0]?.quote?.dexId || null,
      bestQuoteMethod: rows[0]?.quote?.method || null,
    },
    rows: rows.slice(0, 80),
    positiveRows,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
  console.log(`HyperEVM exact quotes: rows=${out.summary.quoteRows} exact=${out.summary.exactPoolQuoteRows} routePositive=${out.summary.routePositive} bestNet=${out.summary.bestNetUsd}`);
  console.log(`Report: ${path.relative(WORKSPACE, OUT)}`);
}

main().catch((error) => {
  console.error(`quote-hyperevm-lst-lrt-exact-routes failed: ${sanitizeError(error)}`);
  process.exitCode = 1;
});
