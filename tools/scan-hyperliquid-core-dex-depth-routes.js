#!/usr/bin/env node
// Read-only HyperCore order-book depth + HyperEVM DEX liquidity route model.
// Exact on HyperCore l2Book side; DEX side is conservative DexScreener-liquidity estimate.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-core-dex-depth-routes.json");
const HYPERLIQUID_INFO_URL = ["https://", "api.", "hyperliquid.", "xyz/info"].join("");
const HYPEREVM_RPC_URL = ["https://", "rpc.", "hyperliquid.", "xyz/evm"].join("");
const HYPEREVM_CHAIN_ID = 999;
const WHYPE = "0x5555555555555555555555555555555555555555";

const TARGET_SYMBOLS = (process.env.HYPERLIQUID_DEPTH_TARGETS || "PURR,KNTQ,KHYPE,STHYPE,UBTC,USDT0")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const MAX_CONSUMER_TARGETS = Math.max(0, Number(process.env.HYPERLIQUID_DEPTH_MAX_CONSUMER_TARGETS || "10") || 0);
const TEST_SIZES_USD = (process.env.HYPERLIQUID_DEPTH_SIZES_USD || "100,500,1000,5000,10000,25000")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);

const MIN_RESEARCH_NET_USD = Number(process.env.HYPERLIQUID_DEPTH_MIN_RESEARCH_NET_USD || "10");
const MIN_ROUTE_NET_USD = Number(process.env.HYPERLIQUID_DEPTH_MIN_ROUTE_NET_USD || "50");
const MIN_DEX_LIQUIDITY_USD = Number(process.env.HYPERLIQUID_DEPTH_MIN_DEX_LIQUIDITY_USD || "10000");
const CORE_FEE_BPS = Number(process.env.HYPERLIQUID_DEPTH_CORE_FEE_BPS || "10");
const DEX_FEE_BPS = Number(process.env.HYPERLIQUID_DEPTH_DEX_FEE_BPS || "30");
const DELAY_BUFFER_BPS = Number(process.env.HYPERLIQUID_DEPTH_DELAY_BUFFER_BPS || "50");
const GAS_UNITS = BigInt(process.env.HYPERLIQUID_DEPTH_GAS_UNITS || "250000");
const EXACT_DEX_QUOTE_REQUIRED = process.env.HYPERLIQUID_DEPTH_ALLOW_ESTIMATED_DEX_ROUTE !== "1";
const TIMEOUT_MS = Number(process.env.HYPERLIQUID_DEPTH_TIMEOUT_MS || "30000");

const LINKED_INVARIANTS = path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-linked-token-invariants.json");
const LINKED_CONSUMERS = path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-linked-token-consumers.json");

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const POOL = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
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

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function norm(value) {
  const s = String(value || "").toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(s) ? s : null;
}

function checksum(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function lowerAddress(value) {
  const address = checksum(value);
  return address ? address.toLowerCase() : null;
}

function sanitizeError(error) {
  return String(error?.shortMessage || error?.message || error || "error").replace(/https?:\/\/\S+/g, "[redacted-url]").slice(0, 240);
}

function symbolKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 4) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function bps(a, b) {
  const x = asNumber(a);
  const y = asNumber(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0) return null;
  return ((x - y) / y) * 10_000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstValue(result) {
  try { return Array.from(result?.value || [])[0] ?? null; } catch (_) { return null; }
}

async function getCodeSafe(provider, address) {
  try { return await provider.getCode(address); } catch (_) { return null; }
}

async function safeCall(provider, target, iface, name, args = []) {
  try {
    const to = checksum(target);
    if (!to) return { ok: false, error: "invalid target address" };
    const raw = await provider.call({ to, data: iface.encodeFunctionData(name, args) });
    return { ok: true, value: iface.decodeFunctionResult(name, raw) };
  } catch (error) {
    return { ok: false, error: sanitizeError(error) };
  }
}

function decimalString(value, decimals = 18) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0";
  const places = Math.max(0, Math.min(Number(decimals) || 0, 18));
  return n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: places });
}

function amountToRaw(value, decimals) {
  try { return ethers.parseUnits(decimalString(value, decimals), Number(decimals)); } catch (_) { return null; }
}

function rawToNumber(raw, decimals) {
  try { return Number(ethers.formatUnits(raw, Number(decimals))); } catch (_) { return null; }
}

async function fetchJson(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function infoPost(body) {
  return fetchJson(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function rpc(method, params) {
  const data = await fetchJson(HYPEREVM_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (data?.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data?.result ?? null;
}

function tokenPriceFromCtx(ctx) {
  return asNumber(ctx?.midPx) ?? asNumber(ctx?.markPx);
}

function findToken(meta, symbol) {
  const wanted = symbolKey(symbol);
  return (meta.tokens || []).find((token) => symbolKey(token.name) === wanted || symbolKey(token.fullName) === wanted) || null;
}

function marketCoin(market, ctx) {
  return ctx?.coin || market?.name || (market?.index !== undefined ? `@${market.index}` : null);
}

function chooseMarket(meta, ctxs, token) {
  const markets = (meta.universe || [])
    .filter((market) => Array.isArray(market.tokens) && market.tokens.includes(token.index))
    .map((market) => ({ market, ctx: ctxs?.[market.index] || null, quoteIndex: market.tokens[1], baseIndex: market.tokens[0] }))
    .filter((item) => item.baseIndex === token.index);
  const directUsdc = markets.find((item) => item.quoteIndex === 0 && marketCoin(item.market, item.ctx));
  if (directUsdc) return { ...directUsdc, reason: "direct-usdc" };
  const liquid = markets
    .filter((item) => marketCoin(item.market, item.ctx))
    .sort((a, b) => (asNumber(b.ctx?.dayNtlVlm) || 0) - (asNumber(a.ctx?.dayNtlVlm) || 0))[0];
  return liquid ? { ...liquid, reason: "best-available-non-usdc" } : null;
}

async function l2Book(coin) {
  try {
    const data = await infoPost({ type: "l2Book", coin });
    const bids = Array.isArray(data?.levels?.[0]) ? data.levels[0].map((l) => ({ px: asNumber(l.px), sz: asNumber(l.sz), n: asNumber(l.n) })).filter((l) => l.px > 0 && l.sz > 0) : [];
    const asks = Array.isArray(data?.levels?.[1]) ? data.levels[1].map((l) => ({ px: asNumber(l.px), sz: asNumber(l.sz), n: asNumber(l.n) })).filter((l) => l.px > 0 && l.sz > 0) : [];
    return { ok: true, coin: data?.coin || coin, time: data?.time || null, bids, asks };
  } catch (error) {
    return { ok: false, coin, error: String(error?.message || error).replace(/https?:\/\/\S+/g, "[redacted-url]") };
  }
}

function fillBuyBaseFromAsks(asks, quoteBudgetUsd) {
  let remaining = quoteBudgetUsd;
  let base = 0;
  let quoteSpent = 0;
  const fills = [];
  for (const level of asks) {
    if (remaining <= 0) break;
    const canSpend = level.px * level.sz;
    const spend = Math.min(remaining, canSpend);
    const takeBase = spend / level.px;
    base += takeBase;
    quoteSpent += spend;
    remaining -= spend;
    fills.push({ px: level.px, base: takeBase, quote: spend });
  }
  return {
    complete: remaining <= 1e-9,
    base,
    quoteSpent,
    avgPx: base > 0 ? quoteSpent / base : null,
    unfilledQuote: Math.max(0, remaining),
    levelsUsed: fills.length,
  };
}

function fillSellBaseToBids(bids, baseAmount) {
  let remaining = baseAmount;
  let baseSold = 0;
  let quoteOut = 0;
  const fills = [];
  for (const level of bids) {
    if (remaining <= 0) break;
    const takeBase = Math.min(remaining, level.sz);
    const quote = takeBase * level.px;
    baseSold += takeBase;
    quoteOut += quote;
    remaining -= takeBase;
    fills.push({ px: level.px, base: takeBase, quote });
  }
  return {
    complete: remaining <= 1e-12,
    baseSold,
    quoteOut,
    avgPx: baseSold > 0 ? quoteOut / baseSold : null,
    unfilledBase: Math.max(0, remaining),
    levelsUsed: fills.length,
  };
}

async function dexPairs(address) {
  try {
    const data = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {}, 45_000);
    return (Array.isArray(data?.pairs) ? data.pairs : []).filter((pair) => pair && typeof pair === "object" && /hyper/i.test(pair.chainId || ""));
  } catch (_) {
    return [];
  }
}

function pairTokenSide(pair, address) {
  const target = norm(address);
  const base = norm(pair?.baseToken?.address);
  const quote = norm(pair?.quoteToken?.address);
  if (base === target) return "base";
  if (quote === target) return "quote";
  return null;
}

function targetPriceUsdFromPair(pair, address) {
  const side = pairTokenSide(pair, address);
  const priceUsd = asNumber(pair?.priceUsd);
  const priceNative = asNumber(pair?.priceNative);
  if (side === "base") return priceUsd;
  if (side === "quote" && priceUsd && priceNative) return priceUsd / priceNative;
  return null;
}

function tokenPriceUsdFromPair(pair, address) {
  const addr = lowerAddress(address);
  const base = lowerAddress(pair?.baseToken?.address);
  const quote = lowerAddress(pair?.quoteToken?.address);
  const priceUsd = asNumber(pair?.priceUsd);
  const priceNative = asNumber(pair?.priceNative);
  if (addr === base) return priceUsd || null;
  if (addr === quote && priceUsd && priceNative) return priceUsd / priceNative;
  return null;
}

function usdLikeToken(token) {
  const key = symbolKey(token?.symbol || token?.name || "");
  if (!key) return false;
  return /^(usdc|usdt|usdt0|usde|usdx|usdhl|feusd|dai|usdl|usdb)$/.test(key) || /^usd/.test(key);
}

async function tokenInfo(provider, address, fallbackSymbol = null) {
  const target = checksum(address);
  if (!target) return null;
  const [symbolRaw, decimalsRaw] = await Promise.all([
    safeCall(provider, target, ERC20, "symbol"),
    safeCall(provider, target, ERC20, "decimals"),
  ]);
  return {
    address: target,
    symbol: symbolRaw.ok ? String(symbolRaw.value[0]) : fallbackSymbol,
    decimals: decimalsRaw.ok ? Number(decimalsRaw.value[0]) : 18,
  };
}

async function quoteViaConfiguredQuoter(provider, poolMeta, input, output, amountInRaw) {
  const factoryKey = lowerAddress(poolMeta?.factory);
  const config = factoryKey ? QUOTER_BY_FACTORY.get(factoryKey) : null;
  if (!config) return { ok: false, error: "no configured quoter for pool factory" };
  const primaryQuoter = checksum(config.quoter);
  const fee = Number(poolMeta?.fee ?? 0);
  const tickSpacing = Number(poolMeta?.tickSpacing ?? 0);
  const sqrtPriceLimitX96 = 0n;
  const attempts = [];
  if (config.kind === "uni-v3-fee-struct") {
    attempts.push({ target: primaryQuoter, iface: UNI_V3_QUOTER, name: "quoteExactInputSingle", args: [[input, output, amountInRaw, fee, sqrtPriceLimitX96]], method: `${config.label}.QuoterV2.quoteExactInputSingle(fee=${fee})` });
  } else if (config.kind === "hyperswap-mixed-v3") {
    attempts.push({ target: primaryQuoter, iface: HYPERSWAP_MIXED_QUOTER, name: "quoteExactInputSingleV3", args: [[input, output, amountInRaw, fee, sqrtPriceLimitX96]], method: `${config.label}.MixedRouteQuoter.quoteExactInputSingleV3(fee=${fee})` });
  } else if (config.kind === "tick-spacing-struct") {
    attempts.push({ target: primaryQuoter, iface: TICK_SPACING_QUOTER, name: "quoteExactInputSingle", args: [[input, output, amountInRaw, tickSpacing, sqrtPriceLimitX96]], method: `${config.label}.QuoterV2.quoteExactInputSingle(tickSpacing=${tickSpacing})` });
    if (config.fallbackQuoter) attempts.push({ target: checksum(config.fallbackQuoter), iface: RAMSES_OLD_QUOTER, name: "quoteExactInputSingle", args: [input, output, tickSpacing, amountInRaw, sqrtPriceLimitX96], method: `${config.label}.Quoter.quoteExactInputSingle(tickSpacing=${tickSpacing})` });
  } else if (config.kind === "algebra-struct") {
    attempts.push({ target: primaryQuoter, iface: ALGEBRA_QUOTER, name: "quoteExactInputSingle", args: [[input, output, amountInRaw, sqrtPriceLimitX96]], method: `${config.label}.QuoterV2.quoteExactInputSingle` });
    if (config.fallbackQuoter) attempts.push({ target: checksum(config.fallbackQuoter), iface: ALGEBRA_OLD_QUOTER, name: "quoteExactInputSingle", args: [input, output, amountInRaw, sqrtPriceLimitX96], method: `${config.label}.Quoter.quoteExactInputSingle` });
  }
  const errors = [];
  for (const attempt of attempts) {
    if (!attempt.target) continue;
    const code = await getCodeSafe(provider, attempt.target);
    if (!code || code === "0x") {
      errors.push(`${attempt.method}: quoter has no code`);
      continue;
    }
    const result = await safeCall(provider, attempt.target, attempt.iface, attempt.name, attempt.args);
    const amountOutRaw = firstValue(result);
    if (result.ok && amountOutRaw !== null) {
      return {
        ok: true,
        amountOutRaw,
        method: attempt.method,
        quoter: attempt.target,
        quoterLabel: config.label,
        factory: poolMeta.factory,
        poolFee: fee || null,
        tickSpacing: tickSpacing || null,
      };
    }
    errors.push(`${attempt.method}: ${result.error || "empty result"}`);
  }
  return { ok: false, error: errors.join("; ").slice(0, 420) || "configured quoter failed" };
}

async function exactDexContext(provider, pair, targetAddress) {
  const pairAddress = checksum(pair?.pairAddress);
  const target = checksum(targetAddress);
  if (!pairAddress || !target) return { ok: false, error: "missing pair or target address" };
  const code = await getCodeSafe(provider, pairAddress);
  if (!code || code === "0x") return { ok: false, pairAddress, error: "pair has no code" };
  const [token0Raw, token1Raw, factoryRaw, feeRaw, tickSpacingRaw] = await Promise.all([
    safeCall(provider, pairAddress, POOL, "token0"),
    safeCall(provider, pairAddress, POOL, "token1"),
    safeCall(provider, pairAddress, POOL, "factory"),
    safeCall(provider, pairAddress, POOL, "fee"),
    safeCall(provider, pairAddress, POOL, "tickSpacing"),
  ]);
  const token0 = checksum(firstValue(token0Raw));
  const token1 = checksum(firstValue(token1Raw));
  const factory = checksum(firstValue(factoryRaw));
  if (!token0 || !token1) return { ok: false, pairAddress, error: "pool token0/token1 unavailable" };
  const targetKey = lowerAddress(target);
  const counterpartyAddress = lowerAddress(token0) === targetKey ? token1 : lowerAddress(token1) === targetKey ? token0 : null;
  if (!counterpartyAddress) return { ok: false, pairAddress, token0, token1, error: "pool does not contain target token" };
  const [targetToken, counterpartyToken] = await Promise.all([
    tokenInfo(provider, target, pairTokenSide(pair, target) === "base" ? pair?.baseToken?.symbol : pair?.quoteToken?.symbol),
    tokenInfo(provider, counterpartyAddress, pairTokenSide(pair, counterpartyAddress) === "base" ? pair?.baseToken?.symbol : pair?.quoteToken?.symbol),
  ]);
  const targetPriceUsd = tokenPriceUsdFromPair(pair, target) || null;
  const counterpartyPriceUsd = tokenPriceUsdFromPair(pair, counterpartyAddress) || (usdLikeToken(counterpartyToken) ? 1 : null);
  const factoryKey = lowerAddress(factory);
  const quoterConfig = factoryKey ? QUOTER_BY_FACTORY.get(factoryKey) : null;
  return {
    ok: Boolean(quoterConfig && targetToken && counterpartyToken && counterpartyPriceUsd),
    pairAddress,
    dexId: pair?.dexId || null,
    url: pair?.url || null,
    token0,
    token1,
    factory,
    fee: firstValue(feeRaw) !== null ? Number(firstValue(feeRaw)) : null,
    tickSpacing: firstValue(tickSpacingRaw) !== null ? Number(firstValue(tickSpacingRaw)) : null,
    targetToken,
    counterpartyToken,
    targetPriceUsd,
    counterpartyPriceUsd,
    counterpartyUsdLike: usdLikeToken(counterpartyToken),
    quoterConfigured: Boolean(quoterConfig),
    quoterLabel: quoterConfig?.label || null,
    error: quoterConfig ? null : "no configured quoter for pool factory",
  };
}

async function exactDexSellBaseToUsd(provider, ctx, baseAmount) {
  if (!ctx?.ok) return { ok: false, error: ctx?.error || "exact DEX context unavailable" };
  const amountInRaw = amountToRaw(baseAmount, ctx.targetToken.decimals);
  if (!amountInRaw || amountInRaw <= 0n) return { ok: false, error: "invalid target amount for exact quote" };
  const quote = await quoteViaConfiguredQuoter(provider, ctx, ctx.targetToken.address, ctx.counterpartyToken.address, amountInRaw);
  if (!quote.ok) return { ok: false, error: quote.error };
  const amountOut = rawToNumber(quote.amountOutRaw, ctx.counterpartyToken.decimals);
  const usdOut = amountOut !== null && ctx.counterpartyPriceUsd ? amountOut * ctx.counterpartyPriceUsd : null;
  return {
    ok: usdOut !== null,
    usdOut,
    amountOut,
    amountOutRaw: quote.amountOutRaw.toString(),
    method: quote.method,
    exactDexQuote: true,
    counterparty: ctx.counterpartyToken,
    counterpartyPriceUsd: ctx.counterpartyPriceUsd,
    counterpartyUsdLike: ctx.counterpartyUsdLike,
    quoter: quote.quoter,
    quoterLabel: quote.quoterLabel,
  };
}

async function exactDexBuyBaseWithUsd(provider, ctx, usdBudget) {
  if (!ctx?.ok) return { ok: false, error: ctx?.error || "exact DEX context unavailable" };
  if (!(ctx.counterpartyPriceUsd > 0)) return { ok: false, error: "missing counterparty USD reference" };
  const amountIn = usdBudget / ctx.counterpartyPriceUsd;
  return exactDexBuyBaseWithCounterparty(provider, ctx, amountIn);
}

async function exactDexBuyBaseWithCounterparty(provider, ctx, amountIn) {
  if (!ctx?.ok) return { ok: false, error: ctx?.error || "exact DEX context unavailable" };
  const amountInRaw = amountToRaw(amountIn, ctx.counterpartyToken.decimals);
  if (!amountInRaw || amountInRaw <= 0n) return { ok: false, error: "invalid counterparty amount for exact quote" };
  const quote = await quoteViaConfiguredQuoter(provider, ctx, ctx.counterpartyToken.address, ctx.targetToken.address, amountInRaw);
  if (!quote.ok) return { ok: false, error: quote.error };
  const baseOut = rawToNumber(quote.amountOutRaw, ctx.targetToken.decimals);
  return {
    ok: baseOut !== null,
    baseOut,
    amountIn,
    amountInRaw: amountInRaw.toString(),
    amountOutRaw: quote.amountOutRaw.toString(),
    method: quote.method,
    exactDexQuote: true,
    counterparty: ctx.counterpartyToken,
    counterpartyPriceUsd: ctx.counterpartyPriceUsd,
    counterpartyUsdLike: ctx.counterpartyUsdLike,
    quoter: quote.quoter,
    quoterLabel: quote.quoterLabel,
  };
}

async function bestUsdUnwindContext(provider, tokenAddress) {
  const pairs = await dexPairs(tokenAddress);
  const scoredPairs = pairs
    .map((pair) => ({ pair, liquidityUsd: asNumber(pair?.liquidity?.usd) || 0 }))
    .filter((row) => row.liquidityUsd >= MIN_DEX_LIQUIDITY_USD)
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
    .slice(0, 12);
  const candidates = [];
  for (const item of scoredPairs) {
    const ctx = await exactDexContext(provider, item.pair, tokenAddress).catch((error) => ({ ok: false, error: sanitizeError(error) }));
    if (ctx?.ok && ctx.counterpartyUsdLike) candidates.push({ ...ctx, liquidityUsd: item.liquidityUsd });
  }
  return candidates.sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0))[0] || null;
}

function estimateDexSellBaseToUsd(pair, address, baseAmount) {
  const priceUsd = targetPriceUsdFromPair(pair, address);
  const liquidityUsd = asNumber(pair?.liquidity?.usd);
  const side = pairTokenSide(pair, address);
  const reserveBase = side === "base" ? asNumber(pair?.liquidity?.base) : side === "quote" ? asNumber(pair?.liquidity?.quote) : null;
  if (!priceUsd || !liquidityUsd || !reserveBase || reserveBase <= 0) return null;
  const noImpactUsd = baseAmount * priceUsd;
  const impact = baseAmount / (reserveBase + baseAmount);
  const fee = DEX_FEE_BPS / 10_000;
  return {
    usdOut: noImpactUsd * (1 - impact) * (1 - fee),
    noImpactUsd,
    impactPct: impact * 100,
    priceUsd,
    liquidityUsd,
    reserveBase,
    exactDexQuote: false,
  };
}

function estimateDexBuyBaseWithUsd(pair, address, usdBudget) {
  const priceUsd = targetPriceUsdFromPair(pair, address);
  const liquidityUsd = asNumber(pair?.liquidity?.usd);
  const side = pairTokenSide(pair, address);
  const reserveBase = side === "base" ? asNumber(pair?.liquidity?.base) : side === "quote" ? asNumber(pair?.liquidity?.quote) : null;
  if (!priceUsd || !liquidityUsd || !reserveBase || reserveBase <= 0) return null;
  const noImpactBase = usdBudget / priceUsd;
  const impact = noImpactBase / (reserveBase + noImpactBase);
  const fee = DEX_FEE_BPS / 10_000;
  return {
    baseOut: noImpactBase * (1 - impact) * (1 - fee),
    noImpactBase,
    impactPct: impact * 100,
    priceUsd,
    liquidityUsd,
    reserveBase,
    exactDexQuote: false,
  };
}

function bestPairForToken(pairs, address) {
  const scored = pairs
    .map((pair) => ({ pair, side: pairTokenSide(pair, address), liquidityUsd: asNumber(pair?.liquidity?.usd) || 0, priceUsd: targetPriceUsdFromPair(pair, address) }))
    .filter((x) => x.side && x.priceUsd && x.liquidityUsd > 0)
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  return scored[0] || null;
}

async function hypePriceUsd(meta, ctxs) {
  const hype = findToken(meta, "HYPE");
  if (!hype) return null;
  const market = chooseMarket(meta, ctxs, hype);
  return tokenPriceFromCtx(market?.ctx) || null;
}

async function gasCostUsd(hypeUsd) {
  try {
    const gasPriceHex = await rpc("eth_gasPrice", []);
    const gasWei = BigInt(gasPriceHex || "0x0");
    const hype = Number(gasWei * GAS_UNITS) / 1e18;
    return { gasPriceWei: gasWei.toString(), gasUnits: GAS_UNITS.toString(), gasHype: hype, gasUsd: hypeUsd ? hype * hypeUsd : null };
  } catch (error) {
    return { error: String(error?.message || error).replace(/https?:\/\/\S+/g, "[redacted-url]") };
  }
}

function routeCostsUsd(notionalUsd, gasUsd) {
  const delay = notionalUsd * DELAY_BUFFER_BPS / 10_000;
  return {
    delayBufferUsd: delay,
    gasUsd: gasUsd || 0,
    totalFixedAndDelayUsd: delay + (gasUsd || 0),
  };
}

async function modelRoutesForSize(provider, sizeUsd, book, dexPair, tokenAddress, gasUsd, exactCtx, usdUnwindCtx) {
  const out = [];
  const costs = routeCostsUsd(sizeUsd, gasUsd);
  const coreBuy = fillBuyBaseFromAsks(book.asks, sizeUsd);
  if (coreBuy.complete) {
    const coreCostWithFee = coreBuy.quoteSpent * (1 + CORE_FEE_BPS / 10_000);
    const exactDexSell = await exactDexSellBaseToUsd(provider, exactCtx, coreBuy.base).catch((error) => ({ ok: false, error: sanitizeError(error) }));
    let dexSell = exactDexSell.ok ? exactDexSell : estimateDexSellBaseToUsd(dexPair, tokenAddress, coreBuy.base);
    if (exactDexSell.ok && !exactDexSell.counterpartyUsdLike && usdUnwindCtx?.ok && lowerAddress(exactDexSell.counterparty?.address) === lowerAddress(usdUnwindCtx.targetToken?.address)) {
      const unwind = await exactDexSellBaseToUsd(provider, usdUnwindCtx, exactDexSell.amountOut).catch((error) => ({ ok: false, error: sanitizeError(error) }));
      if (unwind.ok && unwind.counterpartyUsdLike) {
        dexSell = {
          ...exactDexSell,
          usdOut: unwind.usdOut,
          counterpartyUsdLike: true,
          finalCounterparty: unwind.counterparty,
          finalCounterpartyPriceUsd: unwind.counterpartyPriceUsd,
          multiHopExact: true,
          unwind,
        };
      }
    }
    if (dexSell) {
      const netUsd = dexSell.usdOut - coreCostWithFee - costs.totalFixedAndDelayUsd;
      const researchPositive = netUsd >= MIN_RESEARCH_NET_USD;
      const routePositive = Boolean(
        exactDexSell.ok
        && dexSell.counterpartyUsdLike
        && netUsd >= MIN_ROUTE_NET_USD
      );
      out.push({
        direction: "core-buy-evm-sell",
        sizeUsd,
        core: { complete: true, avgBuyPx: round(coreBuy.avgPx, 10), baseBought: round(coreBuy.base, 10), quoteSpent: round(coreBuy.quoteSpent, 4), levelsUsed: coreBuy.levelsUsed, feeBps: CORE_FEE_BPS, costWithFeeUsd: round(coreCostWithFee, 4) },
        dex: exactDexSell.ok ? {
          usdOut: round(dexSell.usdOut, 4),
          amountOut: round(dexSell.amountOut, 10),
          amountOutRaw: dexSell.amountOutRaw,
          counterparty: dexSell.counterparty ? { symbol: dexSell.counterparty.symbol, address: dexSell.counterparty.address, decimals: dexSell.counterparty.decimals, priceUsd: round(dexSell.counterpartyPriceUsd, 10), usdLike: usdLikeToken(dexSell.counterparty) } : null,
          finalCounterparty: dexSell.finalCounterparty ? { symbol: dexSell.finalCounterparty.symbol, address: dexSell.finalCounterparty.address, decimals: dexSell.finalCounterparty.decimals, priceUsd: round(dexSell.finalCounterpartyPriceUsd, 10), usdLike: true } : null,
          multiHopExact: Boolean(dexSell.multiHopExact),
          unwind: dexSell.unwind ? { method: dexSell.unwind.method, quoterLabel: dexSell.unwind.quoterLabel, amountOut: round(dexSell.unwind.amountOut, 10), amountOutRaw: dexSell.unwind.amountOutRaw } : null,
          method: dexSell.method,
          quoterLabel: dexSell.quoterLabel,
          exactDexQuote: true,
        } : { priceUsd: round(dexSell.priceUsd, 10), usdOut: round(dexSell.usdOut, 4), noImpactUsd: round(dexSell.noImpactUsd, 4), impactPct: round(dexSell.impactPct, 6), liquidityUsd: round(dexSell.liquidityUsd, 2), exactDexQuote: false, exactQuoteError: exactDexSell.error || null },
        costs: { ...costs, delayBufferUsd: round(costs.delayBufferUsd, 4), gasUsd: round(costs.gasUsd, 4), totalFixedAndDelayUsd: round(costs.totalFixedAndDelayUsd, 4) },
        netUsd: round(netUsd, 4),
        netBps: round(bps(netUsd + sizeUsd, sizeUsd), 2),
        researchPositive,
        routePositive,
        blockers: [
          exactDexSell.ok ? null : `DEX exact quote unavailable: ${exactDexSell.error || "unknown"}`,
          exactDexSell.ok ? null : "DEX side uses DexScreener liquidity estimate, not exact executable quote",
          exactDexSell.ok && !dexSell.counterpartyUsdLike ? "DEX counterparty is not USD-like and exact multi-hop unwind is unavailable" : null,
          EXACT_DEX_QUOTE_REQUIRED && !exactDexSell.ok ? "exact DEX quote required before routePositive" : null,
          researchPositive ? null : "net below research threshold after conservative costs",
          exactDexSell.ok && netUsd < MIN_ROUTE_NET_USD ? "net below route-positive threshold after exact quote and costs" : null,
        ].filter(Boolean),
      });
    }
  }
  let exactDexBuy = await exactDexBuyBaseWithUsd(provider, exactCtx, sizeUsd).catch((error) => ({ ok: false, error: sanitizeError(error) }));
  if (exactCtx?.ok && !exactCtx.counterpartyUsdLike && usdUnwindCtx?.ok && lowerAddress(exactCtx.counterpartyToken?.address) === lowerAddress(usdUnwindCtx.targetToken?.address)) {
    const acquisition = await exactDexBuyBaseWithUsd(provider, usdUnwindCtx, sizeUsd).catch((error) => ({ ok: false, error: sanitizeError(error) }));
    if (acquisition.ok) {
      const targetBuy = await exactDexBuyBaseWithCounterparty(provider, exactCtx, acquisition.baseOut).catch((error) => ({ ok: false, error: sanitizeError(error) }));
      if (targetBuy.ok) {
        exactDexBuy = {
          ...targetBuy,
          amountIn: acquisition.amountIn,
          amountInRaw: acquisition.amountInRaw,
          counterparty: acquisition.counterparty,
          counterpartyPriceUsd: acquisition.counterpartyPriceUsd,
          counterpartyUsdLike: true,
          multiHopExact: true,
          acquisition,
        };
      }
    }
  }
  const dexBuy = exactDexBuy.ok ? exactDexBuy : estimateDexBuyBaseWithUsd(dexPair, tokenAddress, sizeUsd);
  if (dexBuy) {
    const baseOut = dexBuy.baseOut ?? dexBuy.baseBought;
    const coreSell = fillSellBaseToBids(book.bids, baseOut);
    if (coreSell.complete) {
      const coreOutWithFee = coreSell.quoteOut * (1 - CORE_FEE_BPS / 10_000);
      const dexCostWithFee = sizeUsd;
      const netUsd = coreOutWithFee - dexCostWithFee - costs.totalFixedAndDelayUsd;
      const researchPositive = netUsd >= MIN_RESEARCH_NET_USD;
      const routePositive = Boolean(
        exactDexBuy.ok
        && dexBuy.counterpartyUsdLike
        && netUsd >= MIN_ROUTE_NET_USD
      );
      out.push({
        direction: "evm-buy-core-sell",
        sizeUsd,
        dex: exactDexBuy.ok ? {
          amountIn: round(dexBuy.amountIn, 10),
          amountInRaw: dexBuy.amountInRaw,
          baseBought: round(dexBuy.baseOut, 10),
          amountOutRaw: dexBuy.amountOutRaw,
          counterparty: dexBuy.counterparty ? { symbol: dexBuy.counterparty.symbol, address: dexBuy.counterparty.address, decimals: dexBuy.counterparty.decimals, priceUsd: round(dexBuy.counterpartyPriceUsd, 10), usdLike: dexBuy.counterpartyUsdLike } : null,
          multiHopExact: Boolean(dexBuy.multiHopExact),
          acquisition: dexBuy.acquisition ? { method: dexBuy.acquisition.method, quoterLabel: dexBuy.acquisition.quoterLabel, baseBought: round(dexBuy.acquisition.baseOut, 10), amountOutRaw: dexBuy.acquisition.amountOutRaw } : null,
          method: dexBuy.method,
          quoterLabel: dexBuy.quoterLabel,
          exactDexQuote: true,
        } : { priceUsd: round(dexBuy.priceUsd, 10), baseBought: round(dexBuy.baseOut, 10), noImpactBase: round(dexBuy.noImpactBase, 10), impactPct: round(dexBuy.impactPct, 6), liquidityUsd: round(dexBuy.liquidityUsd, 2), exactDexQuote: false, exactQuoteError: exactDexBuy.error || null },
        core: { complete: true, avgSellPx: round(coreSell.avgPx, 10), baseSold: round(coreSell.baseSold, 10), quoteOut: round(coreSell.quoteOut, 4), levelsUsed: coreSell.levelsUsed, feeBps: CORE_FEE_BPS, outWithFeeUsd: round(coreOutWithFee, 4) },
        costs: { ...costs, delayBufferUsd: round(costs.delayBufferUsd, 4), gasUsd: round(costs.gasUsd, 4), totalFixedAndDelayUsd: round(costs.totalFixedAndDelayUsd, 4) },
        netUsd: round(netUsd, 4),
        netBps: round(bps(netUsd + sizeUsd, sizeUsd), 2),
        researchPositive,
        routePositive,
        blockers: [
          exactDexBuy.ok ? null : `DEX exact quote unavailable: ${exactDexBuy.error || "unknown"}`,
          exactDexBuy.ok ? null : "DEX side uses DexScreener liquidity estimate, not exact executable quote",
          exactDexBuy.ok && !dexBuy.counterpartyUsdLike ? "DEX counterparty is not USD-like and exact multi-hop acquisition is unavailable" : null,
          EXACT_DEX_QUOTE_REQUIRED && !exactDexBuy.ok ? "exact DEX quote required before routePositive" : null,
          researchPositive ? null : "net below research threshold after conservative costs",
          exactDexBuy.ok && netUsd < MIN_ROUTE_NET_USD ? "net below route-positive threshold after exact quote and costs" : null,
        ].filter(Boolean),
      });
    }
  }
  return out;
}

function linkedRowBySymbol(linked, symbol) {
  const wanted = symbolKey(symbol);
  return (linked?.rows || []).find((row) => symbolKey(row?.token?.name) === wanted || symbolKey(row?.evm?.symbol) === wanted) || null;
}

function consumerRowBySymbol(consumers, symbol) {
  const wanted = symbolKey(symbol);
  return (consumers?.rows || []).find((row) => symbolKey(row?.token?.name) === wanted || symbolKey(row?.token?.symbol) === wanted) || null;
}

function expandedTargetSymbols(consumers) {
  const ranked = (consumers?.summary?.diagnostics?.topResearchTokens || [])
    .map((row) => String(row?.token || "").trim())
    .filter(Boolean)
    .slice(0, MAX_CONSUMER_TARGETS);
  const seen = new Set();
  const out = [];
  for (const symbol of [...TARGET_SYMBOLS, ...ranked]) {
    const key = symbolKey(symbol);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(symbol);
  }
  return out;
}

async function main() {
  const [metaAndCtxs, linked, consumers] = await Promise.all([
    infoPost({ type: "spotMetaAndAssetCtxs" }),
    Promise.resolve(readJson(LINKED_INVARIANTS, {})),
    Promise.resolve(readJson(LINKED_CONSUMERS, {})),
  ]);
  const provider = new ethers.JsonRpcProvider(HYPEREVM_RPC_URL, { chainId: HYPEREVM_CHAIN_ID, name: "hyperevm" }, { staticNetwork: true });
  const meta = Array.isArray(metaAndCtxs) ? metaAndCtxs[0] : metaAndCtxs;
  const ctxs = Array.isArray(metaAndCtxs) ? metaAndCtxs[1] : [];
  const hypeUsd = await hypePriceUsd(meta, ctxs);
  const gas = await gasCostUsd(hypeUsd);
  const whypeUsdContext = await bestUsdUnwindContext(provider, WHYPE).catch((error) => ({ ok: false, error: sanitizeError(error) }));
  const targetSymbols = expandedTargetSymbols(consumers);
  const rows = [];

  for (const symbol of targetSymbols) {
    const token = findToken(meta, symbol);
    if (!token) {
      rows.push({ symbol, found: false, routePositive: false, blockers: ["token not found in HyperCore spot metadata"] });
      continue;
    }
    const evmAddress = norm(typeof token.evmContract === "string" ? token.evmContract : token.evmContract?.address);
    const market = chooseMarket(meta, ctxs, token);
    const coin = market ? marketCoin(market.market, market.ctx) : null;
    const book = coin ? await l2Book(coin) : { ok: false, error: "no spot market found" };
    const pairs = evmAddress ? await dexPairs(evmAddress) : [];
    const bestPair = bestPairForToken(pairs, evmAddress);
    const exactCtx = bestPair?.pair ? await exactDexContext(provider, bestPair.pair, evmAddress).catch((error) => ({ ok: false, error: sanitizeError(error) })) : null;
    const routes = [];
    if (book.ok && market?.quoteIndex === 0 && bestPair?.pair) {
      for (const sizeUsd of TEST_SIZES_USD) routes.push(...await modelRoutesForSize(provider, sizeUsd, book, bestPair.pair, evmAddress, gas.gasUsd, exactCtx, whypeUsdContext));
    }
    const bestResearch = routes.filter((r) => r.researchPositive).sort((a, b) => (b.netUsd || -Infinity) - (a.netUsd || -Infinity))[0] || null;
    const bestNet = routes.slice().sort((a, b) => (b.netUsd || -Infinity) - (a.netUsd || -Infinity))[0] || null;
    const bestExact = routes.filter((r) => r.dex?.exactDexQuote).sort((a, b) => (b.netUsd || -Infinity) - (a.netUsd || -Infinity))[0] || null;
    const bestRoutePositive = routes.filter((r) => r.routePositive).sort((a, b) => (b.netUsd || -Infinity) - (a.netUsd || -Infinity))[0] || null;
    const hasMultiHopExact = routes.some((r) => r.dex?.multiHopExact || r.dex?.unwind || r.dex?.acquisition);
    const linkedRow = linkedRowBySymbol(linked, symbol);
    const consumerRow = consumerRowBySymbol(consumers, symbol);
    const blockers = [
      market ? null : "no HyperCore spot market found",
      market && market.quoteIndex !== 0 ? "selected HyperCore market is not USDC-quoted; exact USD route not modeled" : null,
      book.ok ? null : `l2Book unavailable: ${book.error || "unknown"}`,
      book.ok && (!book.bids.length || !book.asks.length) ? "l2Book has empty bid/ask side" : null,
      bestPair?.pair ? null : "no usable HyperEVM DexScreener pair with target token price/liquidity",
      bestPair?.pair && !exactCtx?.ok ? `exact DEX quote unavailable: ${exactCtx?.error || "unknown"}` : null,
      exactCtx?.ok && !exactCtx.counterpartyUsdLike && !hasMultiHopExact ? "best DEX counterparty is not USD-like; route-positive needs multi-hop unwind/acquisition model" : null,
      bestPair?.liquidityUsd < MIN_DEX_LIQUIDITY_USD ? "best DEX liquidity below threshold" : null,
      bestResearch ? "research-positive only: exact DEX quote and HyperCore transfer/unwind timing still required" : "no profitable estimated route after depth/cost model",
      EXACT_DEX_QUOTE_REQUIRED && !bestExact ? "routePositive blocked until exact on-chain DEX quote is available" : null,
      bestExact && !bestRoutePositive ? "best exact route is still below route-positive economics or lacks USD-like unwind" : null,
    ].filter(Boolean);
    rows.push({
      symbol,
      found: true,
      token: {
        index: token.index,
        name: token.name,
        fullName: token.fullName || null,
        evmContract: evmAddress,
        szDecimals: token.szDecimals,
        weiDecimals: token.weiDecimals,
        evmExtraWeiDecimals: typeof token.evmContract === "object" ? token.evmContract.evm_extra_wei_decimals : null,
      },
      candidateClass: ["PURR", "KNTQ"].includes(symbol.toUpperCase()) ? "near-term-dex-core-spread" : "high-impact-integrated",
      invariant: linkedRow ? { watchCandidate: linkedRow.watchCandidate, criticalFlags: linkedRow.criticalFlags || [], flags: linkedRow.flags || [] } : null,
      consumer: consumerRow ? { watchCandidate: consumerRow.watchCandidate, researchPositive: consumerRow.researchPositive, joinCount: consumerRow.metrics?.joinCount || 0, maxDexLiquidityUsd: consumerRow.metrics?.maxDexLiquidityUsd || 0, maxYieldTvlUsd: consumerRow.metrics?.maxYieldTvlUsd || 0, maxBorrowCashUsd: consumerRow.metrics?.maxBorrowCashUsd || 0 } : null,
      hyperCoreMarket: market ? {
        index: market.market.index,
        coin,
        name: market.market.name,
        reason: market.reason,
        baseTokenIndex: market.baseIndex,
        quoteTokenIndex: market.quoteIndex,
        contextMidPx: market.ctx?.midPx || null,
        contextMarkPx: market.ctx?.markPx || null,
        dayNtlVlm: market.ctx?.dayNtlVlm || null,
      } : null,
      l2Book: book.ok ? {
        time: book.time,
        topBid: book.bids[0] || null,
        topAsk: book.asks[0] || null,
        bidLevels: book.bids.length,
        askLevels: book.asks.length,
      } : { ok: false, error: book.error || null },
      dex: bestPair ? {
        chainId: bestPair.pair.chainId || null,
        dexId: bestPair.pair.dexId || null,
        pairAddress: bestPair.pair.pairAddress || null,
        targetSide: bestPair.side,
        priceUsd: round(bestPair.priceUsd, 10),
        liquidityUsd: round(bestPair.liquidityUsd, 2),
        volume24hUsd: round(asNumber(bestPair.pair.volume?.h24), 2),
        url: bestPair.pair.url || null,
        exactDexQuote: Boolean(bestExact),
        exactQuoteConfigured: Boolean(exactCtx?.quoterConfigured),
        exactQuoteError: exactCtx?.ok ? null : exactCtx?.error || null,
        factory: exactCtx?.factory || null,
        quoterLabel: exactCtx?.quoterLabel || null,
        counterparty: exactCtx?.counterpartyToken ? { symbol: exactCtx.counterpartyToken.symbol, address: exactCtx.counterpartyToken.address, decimals: exactCtx.counterpartyToken.decimals, priceUsd: round(exactCtx.counterpartyPriceUsd, 10), usdLike: exactCtx.counterpartyUsdLike } : null,
      } : null,
      routes,
      bestEstimatedRoute: bestNet,
      bestExactRoute: bestExact,
      bestResearchPositiveRoute: bestResearch,
      researchPositive: Boolean(bestResearch),
      routePositive: Boolean(bestRoutePositive),
      blockers,
    });
    await sleep(300);
  }

  const routePositiveRows = rows.filter((r) => r.routePositive);
  const researchPositiveRows = rows.filter((r) => r.researchPositive);
  const exactQuoteRows = rows.filter((r) => r.dex?.exactDexQuote);
  const multiHopExactRows = rows.filter((r) => (r.routes || []).some((route) => route.dex?.multiHopExact || route.dex?.unwind || route.dex?.acquisition));
  const bestNetUsd = rows
    .map((row) => asNumber(row.bestEstimatedRoute?.netUsd))
    .filter((value) => value !== null)
    .sort((a, b) => b - a)[0] ?? null;
  const bestExactNetUsd = rows
    .map((row) => asNumber(row.bestExactRoute?.netUsd))
    .filter((value) => value !== null)
    .sort((a, b) => b - a)[0] ?? null;
  const out = {
    generatedAt: new Date().toISOString(),
    scope: "Hyperliquid exact HyperCore depth plus conservative HyperEVM DEX quote model",
    safety: {
      publicApiOnly: true,
      publicRpcOnly: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositiveRows.length > 0,
      signedActionJustified: false,
    },
    sourceArtifacts: {
      linkedTokenInvariants: path.relative(WORKSPACE, LINKED_INVARIANTS),
      linkedTokenConsumers: path.relative(WORKSPACE, LINKED_CONSUMERS),
      hyperCoreInfoApi: "https://api.hyperliquid.xyz/info",
      hyperEvmPublicRpc: "https://rpc.hyperliquid.xyz/evm",
      publicDex: "https://api.dexscreener.com/latest/dex/tokens/{address}",
      exactHyperEvmQuoters: "configured factory-specific read-only HyperEVM quoters",
    },
    exactUsdUnwind: whypeUsdContext?.ok ? {
      token: whypeUsdContext.targetToken?.symbol || "WHYPE",
      dexId: whypeUsdContext.dexId,
      pairAddress: whypeUsdContext.pairAddress,
      quoterLabel: whypeUsdContext.quoterLabel,
      counterparty: whypeUsdContext.counterpartyToken ? { symbol: whypeUsdContext.counterpartyToken.symbol, address: whypeUsdContext.counterpartyToken.address, decimals: whypeUsdContext.counterpartyToken.decimals, priceUsd: round(whypeUsdContext.counterpartyPriceUsd, 10), usdLike: whypeUsdContext.counterpartyUsdLike } : null,
      liquidityUsd: round(whypeUsdContext.liquidityUsd, 2),
    } : { ok: false, error: whypeUsdContext?.error || "no exact USD unwind context found" },
    thresholds: {
      targetSymbols,
      configuredTargetSymbols: TARGET_SYMBOLS,
      maxConsumerTargets: MAX_CONSUMER_TARGETS,
      testSizesUsd: TEST_SIZES_USD,
      minResearchNetUsd: MIN_RESEARCH_NET_USD,
      minRouteNetUsd: MIN_ROUTE_NET_USD,
      minDexLiquidityUsd: MIN_DEX_LIQUIDITY_USD,
      coreFeeBps: CORE_FEE_BPS,
      dexFeeBps: DEX_FEE_BPS,
      delayBufferBps: DELAY_BUFFER_BPS,
      exactDexQuoteRequired: EXACT_DEX_QUOTE_REQUIRED,
    },
    gas,
    summary: {
      targetsScanned: rows.length,
      directUsdcMarkets: rows.filter((r) => r.hyperCoreMarket?.quoteTokenIndex === 0).length,
      depthAvailable: rows.filter((r) => r.l2Book?.topBid && r.l2Book?.topAsk).length,
      dexPairsAvailable: rows.filter((r) => r.dex).length,
      exactDexQuoteRows: exactQuoteRows.length,
      multiHopExactRows: multiHopExactRows.length,
      researchPositiveRows: researchPositiveRows.length,
      bestNetUsd: round(bestNetUsd, 6),
      bestExactNetUsd: round(bestExactNetUsd, 6),
      routePositive: routePositiveRows.length,
      signedActionJustified: false,
    },
    rows,
  };

  ensureDir(OUT);
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Wrote ${path.relative(WORKSPACE, OUT)}`);
  console.log(`Hyperliquid depth routes: targets=${out.summary.targetsScanned}; researchPositive=${out.summary.researchPositiveRows}; routePositive=${out.summary.routePositive}; depthAvailable=${out.summary.depthAvailable}; dexPairs=${out.summary.dexPairsAvailable}`);
  for (const row of rows) {
    console.log(`${row.symbol}: market=${row.hyperCoreMarket?.coin || "none"}; dex=${row.dex?.dexId || "none"}; exact=${row.dex?.exactDexQuote || false}; bestNet=${row.bestEstimatedRoute?.netUsd ?? "n/a"}; researchPositive=${row.researchPositive}; routePositive=${row.routePositive}`);
  }
}

main().catch((err) => {
  console.error(String(err?.message || err).replace(/https?:\/\/\S+/g, "[redacted-url]"));
  process.exit(1);
});
