#!/usr/bin/env node
// Read-only HyperEVM HYPE LST/LRT oracle-route scanner.
// RPC URLs are resolved in memory only and are never printed or written.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "hyperevm-lst-lrt-oracle-routes.json");
const HYPERLIQUID_INFO_URL = ["https://", "api.", "hyperliquid.", "xyz/info"].join("");
const FALLBACK_RPC = ["https://", "rpc.", "hyperliquid.", "xyz/evm"].join("");

const FILES = {
  hyperlend: path.join(WORKSPACE, "reports", "raw", "fast", "hyperlend-live.json"),
  linkedTokens: path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-linked-token-invariants.json"),
  linkedConsumers: path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-linked-token-consumers.json"),
  consumerFirst: path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json"),
};

const CHAIN_ID = 999;
const TARGET_SYMBOL_RE = /^(kHYPE|KHYPE|wstHYPE|STHYPE|stHYPE|lstHYPE|beHYPE|hbHYPE)$/i;
const HYPE_SYMBOL_RE = /hype/i;
const TARGET_ENV = (process.env.HYPEREVM_LST_TARGETS || "KHYPE,STHYPE,wstHYPE,kHYPE,lstHYPE,beHYPE,hbHYPE")
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);
const TEST_SIZES_USD = (process.env.HYPEREVM_LST_TEST_SIZES_USD || "1000,10000,50000,100000")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);
const MIN_BORROW_LIQUIDITY_USD = Number(process.env.HYPEREVM_LST_MIN_BORROW_LIQUIDITY_USD || "10000");
const MIN_DEX_LIQUIDITY_USD = Number(process.env.HYPEREVM_LST_MIN_DEX_LIQUIDITY_USD || "10000");
const MIN_RESEARCH_NET_USD = Number(process.env.HYPEREVM_LST_MIN_RESEARCH_NET_USD || "25");
const MIN_ROUTE_NET_USD = Number(process.env.HYPEREVM_LST_MIN_ROUTE_NET_USD || "100");
const MIN_ROUTE_EDGE_BPS = Number(process.env.HYPEREVM_LST_MIN_ROUTE_EDGE_BPS || "50");
const DEX_FEE_BPS = Number(process.env.HYPEREVM_LST_DEX_FEE_BPS || "30");
const GAS_BUFFER_USD = Number(process.env.HYPEREVM_LST_GAS_BUFFER_USD || "25");
const ALLOW_ESTIMATED_ROUTE = process.env.HYPEREVM_LST_ALLOW_ESTIMATED_ROUTE === "1";
const TIMEOUT_MS = Number(process.env.HYPEREVM_LST_TIMEOUT_MS || "30000");

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const TOKEN_VIEWS = new ethers.Interface([
  "function asset() view returns (address)",
  "function underlying() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
  "function getRate() view returns (uint256)",
  "function exchangeRate() view returns (uint256)",
  "function getExchangeRate() view returns (uint256)",
  "function HYPE() view returns (address)",
  "function stHYPE() view returns (address)",
]);
const MORPHO_ORACLE = new ethers.Interface(["function price() view returns (uint256)"]);

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function sanitizeError(error) {
  return String(error?.shortMessage || error?.message || error || "error").replace(/https?:\/\/\S+/g, "[redacted-url]").slice(0, 240);
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function lowerAddress(value) {
  const addr = normalizeAddress(value);
  return addr ? addr.toLowerCase() : null;
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

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try {
    const n = Number(ethers.formatUnits(raw, decimals));
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 15_000) {
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

async function resolveRpcUrl() {
  const candidates = [...loadRpcUrls(), FALLBACK_RPC];
  const seen = new Set();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const got = await rpcCall(url, "eth_chainId", [], 5_000);
      if (Number(BigInt(got)) === CHAIN_ID) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

async function safeCall(provider, target, iface, name, args = []) {
  try {
    const raw = await provider.call({ to: target, data: iface.encodeFunctionData(name, args) });
    const value = iface.decodeFunctionResult(name, raw);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: sanitizeError(error) };
  }
}

async function fetchJson(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function infoPost(body) {
  try {
    return await fetchJson(HYPERLIQUID_INFO_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (_) {
    return null;
  }
}

async function fetchDexPairs(addresses) {
  const out = new Map();
  const unique = [...new Set(addresses.map(lowerAddress).filter(Boolean))];
  for (let i = 0; i < unique.length; i += 25) {
    const batch = unique.slice(i, i + 25);
    try {
      const data = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(",")}`, {}, 45_000);
      for (const pair of Array.isArray(data?.pairs) ? data.pairs : []) {
        if (!pair || !/hyper/i.test(pair.chainId || "")) continue;
        const base = lowerAddress(pair.baseToken?.address);
        const quote = lowerAddress(pair.quoteToken?.address);
        for (const token of [base, quote]) {
          if (!token) continue;
          if (!out.has(token)) out.set(token, []);
          out.get(token).push(pair);
        }
      }
    } catch (_) {
      for (const token of batch) if (!out.has(token)) out.set(token, []);
    }
  }
  return out;
}

function pairTokenSide(pair, address) {
  const target = lowerAddress(address);
  const base = lowerAddress(pair?.baseToken?.address);
  const quote = lowerAddress(pair?.quoteToken?.address);
  if (target && base === target) return "base";
  if (target && quote === target) return "quote";
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

function estimateDexBuy(pair, address, usdBudget) {
  const priceUsd = targetPriceUsdFromPair(pair, address);
  const liquidityUsd = asNumber(pair?.liquidity?.usd);
  const side = pairTokenSide(pair, address);
  const reserveBase = side === "base" ? asNumber(pair?.liquidity?.base) : side === "quote" ? asNumber(pair?.liquidity?.quote) : null;
  if (!priceUsd || !liquidityUsd || !reserveBase || reserveBase <= 0) return null;
  const noImpactBase = usdBudget / priceUsd;
  const impact = noImpactBase / (reserveBase + noImpactBase);
  const fee = DEX_FEE_BPS / 10_000;
  const baseOut = noImpactBase * (1 - impact) * (1 - fee);
  return {
    source: `${pair.dexId || "dex"}:${pair.pairAddress || "unknown"}`,
    pairAddress: pair.pairAddress || null,
    dexId: pair.dexId || null,
    url: pair.url || null,
    exact: false,
    usdBudget,
    baseOut,
    effectivePriceUsd: baseOut > 0 ? usdBudget / baseOut : null,
    noImpactPriceUsd: priceUsd,
    impactPct: impact * 100,
    liquidityUsd,
    volume24hUsd: asNumber(pair?.volume?.h24),
    baseToken: pair.baseToken || null,
    quoteToken: pair.quoteToken || null,
  };
}

function bestDexBuys(pairs, address) {
  const usable = (pairs || []).filter((pair) => targetPriceUsdFromPair(pair, address) && asNumber(pair?.liquidity?.usd) >= MIN_DEX_LIQUIDITY_USD);
  return TEST_SIZES_USD.map((sizeUsd) => {
    const quotes = usable.map((pair) => estimateDexBuy(pair, address, sizeUsd)).filter((q) => q && q.baseOut > 0 && Number.isFinite(q.effectivePriceUsd));
    quotes.sort((a, b) => a.effectivePriceUsd - b.effectivePriceUsd);
    return quotes[0] || null;
  }).filter(Boolean);
}

function morphoLltvRatio(value) {
  try { return Number(BigInt(String(value || 0))) / 1e18; } catch (_) { return Number(value || 0); }
}

function morphoLoanPerCollateral(priceRaw, collateralDecimals, loanDecimals) {
  if (priceRaw === null || priceRaw === undefined || collateralDecimals === null || loanDecimals === null) return null;
  try {
    return formatUnitsNumber((10n ** BigInt(collateralDecimals)) * BigInt(priceRaw) / (10n ** 36n), loanDecimals);
  } catch (_) {
    return null;
  }
}

async function morphoQuery(query, variables) {
  const json = await fetchJson("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  }, 45_000);
  if (json.errors) throw new Error(json.errors[0]?.message || "Morpho GraphQL error");
  return json.data || {};
}

async function fetchMorphoMarkets(targetAddresses) {
  const assets = [...new Set(targetAddresses.map(normalizeAddress).filter(Boolean))];
  if (!assets.length) return [];
  const query = `query($chainIds:[Int!]!, $assets:[String!]!) {
    markets(first:100, orderBy:SupplyAssetsUsd, orderDirection:Desc,
      where:{chainId_in:$chainIds, collateralAssetAddress_in:$assets}) {
      items { marketId loanAsset { symbol address decimals } collateralAsset { symbol address decimals } oracle { address } lltv state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization } }
    }
  }`;
  try {
    const data = await morphoQuery(query, { chainIds: [CHAIN_ID], assets });
    return data.markets?.items || [];
  } catch (_) {
    return [];
  }
}

function targetFromArtifacts(hyperlend, linked, linkedConsumers, consumerFirst) {
  const byAddress = new Map();
  function add(address, symbol, source, extra = {}) {
    const normalized = normalizeAddress(address);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    const item = byAddress.get(key) || { address: normalized, symbols: new Set(), sources: new Set(), extra: {} };
    if (symbol) item.symbols.add(String(symbol));
    item.sources.add(source);
    item.extra = { ...item.extra, ...extra };
    byAddress.set(key, item);
  }

  for (const row of hyperlend?.coreReserves || []) {
    if (TARGET_SYMBOL_RE.test(row.symbol || "") || (HYPE_SYMBOL_RE.test(row.symbol || "") && Number(row.ltv || 0) > 0)) add(row.token, row.symbol, "hyperlend-live", { hyperlendReserve: true });
  }
  for (const row of linked?.rows || []) {
    const name = row?.token?.name || row?.evm?.symbol;
    if (TARGET_SYMBOL_RE.test(name || "") || TARGET_ENV.includes(symbolKey(name))) add(row?.token?.evmContract, name, "linked-token-invariants", { linkedIndex: row?.token?.index });
  }
  for (const row of linkedConsumers?.topRows || []) {
    const name = row?.token;
    if (TARGET_SYMBOL_RE.test(name || "") || TARGET_ENV.includes(symbolKey(name))) add(row.evmContract, name, "linked-token-consumers", { linkedConsumerScore: row.score });
  }
  const highLtvRows = (consumerFirst?.results || []).flatMap((result) => result?.highLtvRowsDetail || []);
  for (const row of highLtvRows) {
    if (row.chainId !== CHAIN_ID || row.protocol !== "Morpho Blue") continue;
    const symbol = row.collateral?.symbol || row.consumer?.collateralAsset?.symbol;
    const borrowSymbol = String(row.borrowAsset?.symbol || row.consumer?.loanAsset?.symbol || "");
    if (TARGET_SYMBOL_RE.test(symbol || "") || (HYPE_SYMBOL_RE.test(symbol || "") && HYPE_SYMBOL_RE.test(borrowSymbol))) {
      add(row.collateral?.address || row.consumer?.collateralAsset?.address, symbol, "consumer-first-high-ltv", { highLtv: true });
    }
  }

  return [...byAddress.values()].map((item) => ({ ...item, symbols: [...item.symbols], sources: [...item.sources] }));
}

function linkedRowFor(linked, address) {
  const key = lowerAddress(address);
  return (linked?.rows || []).find((row) => lowerAddress(row?.token?.evmContract) === key) || null;
}

function coreRefsFor(spot, linkedRow, symbol) {
  const out = [];
  const wanted = symbolKey(symbol || linkedRow?.token?.name);
  const tokenIndex = linkedRow?.token?.index;
  if (Array.isArray(spot) && spot.length >= 2) {
    const meta = spot[0] || {};
    const ctxs = spot[1] || [];
    const token = (meta.tokens || []).find((t) => t.index === tokenIndex || symbolKey(t.name) === wanted || symbolKey(t.fullName) === wanted);
    if (token) {
      for (const market of meta.universe || []) {
        if (!Array.isArray(market.tokens) || !market.tokens.includes(token.index)) continue;
        const ctx = ctxs?.[market.index] || null;
        out.push({
          source: "hypercore-spotMetaAndAssetCtxs",
          tokenIndex: token.index,
          marketIndex: market.index,
          coin: ctx?.coin || market.name || `@${market.index}`,
          baseIndex: market.tokens[0],
          quoteIndex: market.tokens[1],
          midPx: asNumber(ctx?.midPx),
          markPx: asNumber(ctx?.markPx),
          prevDayPx: asNumber(ctx?.prevDayPx),
          dayNtlVlm: asNumber(ctx?.dayNtlVlm),
          dayBaseVlm: asNumber(ctx?.dayBaseVlm),
        });
      }
    }
  }
  for (const market of linkedRow?.spotMarkets || []) {
    out.push({
      source: "linked-token-invariants-artifact",
      marketIndex: market.index,
      coin: market.ctx?.coin || null,
      midPx: asNumber(market.ctx?.midPx),
      markPx: asNumber(market.ctx?.markPx),
      prevDayPx: asNumber(market.ctx?.prevDayPx),
      dayNtlVlm: asNumber(market.ctx?.dayNtlVlm),
      dayBaseVlm: asNumber(market.ctx?.dayBaseVlm),
    });
  }
  return out;
}

async function probeToken(provider, address, whypeAddress, whypePriceUsd) {
  const decimalsRaw = await safeCall(provider, address, ERC20, "decimals");
  const decimals = decimalsRaw.ok ? Number(decimalsRaw.value[0]) : 18;
  const one = 10n ** BigInt(decimals);
  const names = ["asset", "underlying", "totalAssets", "convertToAssets", "previewRedeem", "getRate", "exchangeRate", "getExchangeRate", "HYPE", "stHYPE"];
  const views = {};
  for (const name of names) {
    const args = name === "convertToAssets" || name === "previewRedeem" ? [one] : [];
    const iface = name === "asset" || name === "underlying" || name === "totalAssets" || name === "convertToAssets" || name === "previewRedeem" || name === "getRate" || name === "exchangeRate" || name === "getExchangeRate" || name === "HYPE" || name === "stHYPE" ? TOKEN_VIEWS : ERC20;
    const result = await safeCall(provider, address, iface, name, args);
    views[name] = result.ok ? { ok: true, raw: result.value[0] } : { ok: false, error: result.error };
  }
  const navCandidates = [];
  for (const name of ["convertToAssets", "previewRedeem"]) {
    if (!views[name]?.ok) continue;
    const amount = formatUnitsNumber(views[name].raw, decimals);
    if (Number.isFinite(amount)) navCandidates.push({ source: `${name}(1 token)`, underlyingPerToken: amount, priceUsd: Number.isFinite(whypePriceUsd) ? amount * whypePriceUsd : null });
  }
  for (const name of ["getRate", "exchangeRate", "getExchangeRate"]) {
    if (!views[name]?.ok) continue;
    const raw = views[name].raw;
    for (const scale of [18, 27, decimals]) {
      const amount = formatUnitsNumber(raw, scale);
      if (Number.isFinite(amount) && amount > 0 && amount < 10) navCandidates.push({ source: `${name}()/1e${scale}`, underlyingPerToken: amount, priceUsd: Number.isFinite(whypePriceUsd) ? amount * whypePriceUsd : null });
    }
  }
  const bestNav = navCandidates
    .filter((x) => Number.isFinite(x.priceUsd))
    .sort((a, b) => Math.abs((a.underlyingPerToken || 0) - 1) - Math.abs((b.underlyingPerToken || 0) - 1))[0] || null;
  return { decimals, views, navCandidates, bestNav, whypeAddress };
}

async function enrichMorpho(provider, markets, whypePriceUsd, targetByAddress, dexByAddress) {
  const rows = [];
  for (const market of markets) {
    const collateral = market.collateralAsset || {};
    const loan = market.loanAsset || {};
    const collateralAddress = normalizeAddress(collateral.address);
    const loanAddress = normalizeAddress(loan.address);
    const target = targetByAddress.get(lowerAddress(collateralAddress));
    if (!target) continue;
    const oracle = normalizeAddress(market.oracle?.address);
    const priceRaw = oracle ? await safeCall(provider, oracle, MORPHO_ORACLE, "price") : { ok: false, error: "missing oracle" };
    const lltv = morphoLltvRatio(market.lltv);
    const collateralDecimals = Number(collateral.decimals ?? target.tokenProbe?.decimals ?? 18);
    const loanDecimals = Number(loan.decimals ?? 18);
    const loanPerCollateral = priceRaw.ok ? morphoLoanPerCollateral(priceRaw.value[0], collateralDecimals, loanDecimals) : null;
    const loanPriceUsd = lowerAddress(loanAddress) === lowerAddress(target.whypeAddress) ? whypePriceUsd : null;
    const acceptedCollateralUsd = Number.isFinite(loanPerCollateral) && Number.isFinite(loanPriceUsd) ? loanPerCollateral * loanPriceUsd : null;
    const borrowablePerTokenUsd = Number.isFinite(acceptedCollateralUsd) ? acceptedCollateralUsd * lltv : null;
    const acquisitions = evaluateAcquisitions(collateralAddress, dexByAddress.get(lowerAddress(collateralAddress)) || [], target, borrowablePerTokenUsd, Number(market.state?.liquidityAssetsUsd || 0));
    const best = bestRouteAttempt(acquisitions);
    rows.push({
      protocol: "Morpho Blue",
      consumerType: "lending-market",
      marketId: market.marketId,
      oracle,
      collateralAsset: { symbol: collateral.symbol || target.primarySymbol, address: collateralAddress, decimals: collateralDecimals },
      loanAsset: { symbol: loan.symbol || null, address: loanAddress, decimals: loanDecimals, priceUsd: loanPriceUsd },
      ltv: lltv,
      state: {
        supplyAssetsUsd: Number(market.state?.supplyAssetsUsd || 0),
        borrowAssetsUsd: Number(market.state?.borrowAssetsUsd || 0),
        liquidityAssetsUsd: Number(market.state?.liquidityAssetsUsd || 0),
        utilization: market.state?.utilization ?? null,
      },
      oraclePriceRaw: priceRaw.ok ? priceRaw.value[0] : null,
      oracleReadError: priceRaw.ok ? null : priceRaw.error,
      loanPerCollateral,
      acceptedCollateralUsd,
      borrowablePerTokenUsd,
      acquisitions,
      bestRouteAttempt: best,
      watchCandidate: Boolean(Number(market.state?.liquidityAssetsUsd || 0) >= MIN_BORROW_LIQUIDITY_USD),
      researchPositive: Boolean(best?.researchPositive),
      routePositive: Boolean(best?.routePositive),
      blockers: routeBlockers(best, priceRaw.ok, Number(market.state?.liquidityAssetsUsd || 0), "Morpho"),
    });
  }
  return rows.sort((a, b) => Number(b.bestRouteAttempt?.estimatedNetUsd || -Infinity) - Number(a.bestRouteAttempt?.estimatedNetUsd || -Infinity));
}

function evaluateAcquisitions(address, pairs, target, borrowablePerTokenUsd, routeLiquidityUsd) {
  const attempts = [];
  for (const quote of bestDexBuys(pairs, address)) {
    const tokensAcquired = quote.baseOut;
    const borrowedValueUsd = Number.isFinite(borrowablePerTokenUsd) ? tokensAcquired * borrowablePerTokenUsd : null;
    const estimatedNetUsd = Number.isFinite(borrowedValueUsd) ? borrowedValueUsd - quote.usdBudget - GAS_BUFFER_USD : null;
    const edgeBps = Number.isFinite(borrowablePerTokenUsd) ? bps(borrowablePerTokenUsd, quote.effectivePriceUsd) : null;
    attempts.push({
      acquisitionSource: "dexscreener-estimated-buy",
      exactAcquisitionQuote: false,
      sizeUsd: quote.usdBudget,
      source: quote.source,
      dexId: quote.dexId,
      pairAddress: quote.pairAddress,
      effectiveAcquisitionPriceUsd: quote.effectivePriceUsd,
      noImpactPriceUsd: quote.noImpactPriceUsd,
      impactPct: quote.impactPct,
      liquidityUsd: quote.liquidityUsd,
      volume24hUsd: quote.volume24hUsd,
      tokensAcquired,
      borrowablePerTokenUsd,
      borrowedValueUsd,
      estimatedNetUsd,
      edgeBps,
      researchPositive: Boolean(estimatedNetUsd !== null && estimatedNetUsd >= MIN_RESEARCH_NET_USD && (edgeBps || 0) >= MIN_ROUTE_EDGE_BPS && routeLiquidityUsd >= quote.usdBudget),
      routePositive: Boolean(ALLOW_ESTIMATED_ROUTE && estimatedNetUsd !== null && estimatedNetUsd >= MIN_ROUTE_NET_USD && (edgeBps || 0) >= MIN_ROUTE_EDGE_BPS && routeLiquidityUsd >= quote.usdBudget),
      blockers: [
        "DexScreener quote is estimated from pool-reported liquidity, not exact executable pool math",
        !ALLOW_ESTIMATED_ROUTE ? "estimated DEX route cannot set routePositive without exact quote integration" : null,
      ].filter(Boolean),
    });
  }
  const nav = target.tokenProbe?.bestNav;
  if (nav?.priceUsd && Number.isFinite(borrowablePerTokenUsd)) {
    const edgeBps = bps(borrowablePerTokenUsd, nav.priceUsd);
    attempts.push({
      acquisitionSource: "onchain-token-nav-reference",
      exactAcquisitionQuote: false,
      sizeUsd: null,
      source: nav.source,
      effectiveAcquisitionPriceUsd: nav.priceUsd,
      underlyingPerToken: nav.underlyingPerToken,
      borrowablePerTokenUsd,
      estimatedNetUsd: null,
      edgeBps,
      researchPositive: false,
      routePositive: false,
      blockers: ["NAV/share-rate is a reference, not a permissionless acquisition quote"],
    });
  }
  return attempts.sort((a, b) => Number(b.estimatedNetUsd ?? -Infinity) - Number(a.estimatedNetUsd ?? -Infinity));
}

function bestRouteAttempt(attempts) {
  return attempts.find((a) => a.routePositive) || attempts.find((a) => a.researchPositive) || attempts[0] || null;
}

function routeBlockers(best, oracleOk, routeLiquidityUsd, label) {
  const blockers = [];
  if (!oracleOk) blockers.push(`${label} oracle price() could not be decoded`);
  if (routeLiquidityUsd < MIN_BORROW_LIQUIDITY_USD) blockers.push("borrow-side route liquidity below threshold");
  if (!best) blockers.push("no DEX/NAV acquisition reference available");
  if (best && !best.researchPositive && !best.routePositive) blockers.push("LTV/LLTV-adjusted accepted value is below acquisition cost plus route threshold");
  if (best && !best.exactAcquisitionQuote) blockers.push("exact executable acquisition quote not integrated; fail closed");
  blockers.push("no HyperEVM fork-positive extraction proof");
  return [...new Set(blockers)];
}

function enrichHyperlend(hyperlend, whypePriceUsd, targetByAddress, dexByAddress) {
  const borrowReserves = (hyperlend?.coreReserves || []).filter((row) => row.active && !row.paused && row.borrowingEnabled && Number(row.cashUsd || 0) >= MIN_BORROW_LIQUIDITY_USD);
  const bestBorrow = borrowReserves.sort((a, b) => Number(b.cashUsd || 0) - Number(a.cashUsd || 0))[0] || null;
  return (hyperlend?.coreReserves || [])
    .filter((row) => targetByAddress.has(lowerAddress(row.token)))
    .map((row) => {
      const target = targetByAddress.get(lowerAddress(row.token));
      const ltv = Number(row.ltv || 0) / 100;
      const borrowablePerTokenUsd = Number(row.priceUsd || 0) * ltv;
      const routeLiquidityUsd = Number(bestBorrow?.cashUsd || 0);
      const acquisitions = evaluateAcquisitions(row.token, dexByAddress.get(lowerAddress(row.token)) || [], target, borrowablePerTokenUsd, routeLiquidityUsd);
      const best = bestRouteAttempt(acquisitions);
      return {
        protocol: "HyperLend",
        consumerType: "core-reserve",
        collateralAsset: { symbol: row.symbol, address: normalizeAddress(row.token), decimals: row.decimals },
        borrowAsset: bestBorrow ? { symbol: bestBorrow.symbol, address: normalizeAddress(bestBorrow.token), cashUsd: bestBorrow.cashUsd, priceUsd: bestBorrow.priceUsd } : null,
        ltv,
        liquidationThreshold: Number(row.liquidationThreshold || 0) / 100,
        active: row.active,
        frozen: row.frozen,
        borrowingEnabled: row.borrowingEnabled,
        paused: row.paused,
        oracleSource: row.oracleSource,
        oracleSourceInfo: row.oracleSourceInfo || null,
        oracleFeedAgeSeconds: row.oracleFeedAgeSeconds ?? null,
        acceptedCollateralUsd: row.priceUsd,
        borrowablePerTokenUsd,
        routeLiquidityUsd,
        acquisitions,
        bestRouteAttempt: best,
        watchCandidate: Boolean(ltv > 0 && routeLiquidityUsd >= MIN_BORROW_LIQUIDITY_USD),
        researchPositive: Boolean(best?.researchPositive),
        routePositive: Boolean(best?.routePositive),
        blockers: routeBlockers(best, true, routeLiquidityUsd, "HyperLend"),
      };
    });
}

async function main() {
  const hyperlend = readJson(FILES.hyperlend, {});
  const linked = readJson(FILES.linkedTokens, {});
  const linkedConsumers = readJson(FILES.linkedConsumers, {});
  const consumerFirst = readJson(FILES.consumerFirst, {});
  const rpcUrl = await resolveRpcUrl();
  if (!rpcUrl) throw new Error("No HyperEVM RPC endpoint resolved from local inventory or public fallback");
  const provider = new ethers.JsonRpcProvider(rpcUrl, { chainId: CHAIN_ID, name: "hyperevm" }, { staticNetwork: true });
  const [blockNumber, block, spot] = await Promise.all([
    provider.getBlockNumber(),
    provider.getBlock("latest"),
    infoPost({ type: "spotMetaAndAssetCtxs" }),
  ]);

  const whype = (hyperlend?.coreReserves || []).find((r) => String(r.symbol || "").toUpperCase() === "WHYPE") || null;
  const whypeAddress = normalizeAddress(whype?.token || "0x5555555555555555555555555555555555555555");
  const whypePriceUsd = Number(whype?.priceUsd || 0) || null;
  const targets = targetFromArtifacts(hyperlend, linked, linkedConsumers, consumerFirst)
    .filter((target) => target.symbols.some((s) => TARGET_SYMBOL_RE.test(s) || TARGET_ENV.includes(symbolKey(s))));

  const dexByAddress = await fetchDexPairs(targets.map((target) => target.address));
  const targetByAddress = new Map();
  for (const target of targets) {
    const linkedRow = linkedRowFor(linked, target.address);
    const primarySymbol = target.symbols.find((s) => TARGET_SYMBOL_RE.test(s)) || target.symbols[0] || linkedRow?.evm?.symbol || linkedRow?.token?.name || "UNKNOWN";
    const tokenProbe = await probeToken(provider, target.address, whypeAddress, whypePriceUsd);
    const dexPairs = (dexByAddress.get(lowerAddress(target.address)) || []).map((pair) => ({
      dexId: pair.dexId || null,
      pairAddress: pair.pairAddress || null,
      priceUsd: targetPriceUsdFromPair(pair, target.address),
      liquidityUsd: asNumber(pair?.liquidity?.usd),
      volume24hUsd: asNumber(pair?.volume?.h24),
      baseToken: pair.baseToken || null,
      quoteToken: pair.quoteToken || null,
      url: pair.url || null,
    })).sort((a, b) => Number(b.liquidityUsd || 0) - Number(a.liquidityUsd || 0));
    targetByAddress.set(lowerAddress(target.address), {
      ...target,
      primarySymbol,
      linked: linkedRow ? {
        tokenIndex: linkedRow.token?.index,
        hyperCoreMarkPx: asNumber(linkedRow.hyperCoreDetails?.markPx),
        hyperCoreMidPx: asNumber(linkedRow.hyperCoreDetails?.midPx),
        flags: linkedRow.flags || [],
        criticalFlags: linkedRow.criticalFlags || [],
        evmSupply: linkedRow.evm?.totalSupply ?? null,
        coreSupply: linkedRow.hyperCoreDetails?.totalSupply ?? null,
      } : null,
      coreRefs: coreRefsFor(spot, linkedRow, primarySymbol),
      tokenProbe,
      dexPairs,
      whypeAddress,
    });
  }

  const morphoMarkets = await fetchMorphoMarkets([...targetByAddress.keys()]);
  const [morphoRows, hyperlendRows] = await Promise.all([
    enrichMorpho(provider, morphoMarkets, whypePriceUsd, targetByAddress, dexByAddress),
    Promise.resolve(enrichHyperlend(hyperlend, whypePriceUsd, targetByAddress, dexByAddress)),
  ]);
  const consumerRows = [...morphoRows, ...hyperlendRows]
    .sort((a, b) => Number(b.bestRouteAttempt?.estimatedNetUsd ?? -Infinity) - Number(a.bestRouteAttempt?.estimatedNetUsd ?? -Infinity));
  const watchCandidates = consumerRows.filter((row) => row.watchCandidate);
  const researchPositiveRows = consumerRows.filter((row) => row.researchPositive);
  const positiveRoutes = consumerRows.filter((row) => row.routePositive);
  const best = consumerRows[0] || null;
  const bestLiquid = consumerRows
    .filter((row) => Number(row.state?.liquidityAssetsUsd ?? row.routeLiquidityUsd ?? 0) >= MIN_BORROW_LIQUIDITY_USD)
    .sort((a, b) => Number(b.bestRouteAttempt?.estimatedNetUsd ?? -Infinity) - Number(a.bestRouteAttempt?.estimatedNetUsd ?? -Infinity))[0] || best;

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-hyperevm-lst-lrt-oracle-routes.js",
    scope: "HyperEVM HYPE LST/LRT lending oracle routes across Morpho and HyperLend",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: positiveRoutes.length > 0,
      signedActionJustified: false,
      estimatedRoutesAllowed: ALLOW_ESTIMATED_ROUTE,
    },
    chain: { id: CHAIN_ID, name: "HyperEVM", blockNumber, timestamp: block?.timestamp || null },
    sourceArtifacts: {
      hyperlend: path.relative(WORKSPACE, FILES.hyperlend),
      linkedTokens: path.relative(WORKSPACE, FILES.linkedTokens),
      linkedConsumers: path.relative(WORKSPACE, FILES.linkedConsumers),
      consumerFirst: path.relative(WORKSPACE, FILES.consumerFirst),
      dex: "https://api.dexscreener.com/latest/dex/tokens/{addresses}",
      hyperCore: "https://api.hyperliquid.xyz/info spotMetaAndAssetCtxs",
      morphoApi: "https://api.morpho.org/graphql",
    },
    thresholds: {
      targetSymbols: TARGET_ENV,
      testSizesUsd: TEST_SIZES_USD,
      minBorrowLiquidityUsd: MIN_BORROW_LIQUIDITY_USD,
      minDexLiquidityUsd: MIN_DEX_LIQUIDITY_USD,
      minResearchNetUsd: MIN_RESEARCH_NET_USD,
      minRouteNetUsd: MIN_ROUTE_NET_USD,
      minRouteEdgeBps: MIN_ROUTE_EDGE_BPS,
      gasBufferUsd: GAS_BUFFER_USD,
      dexFeeBps: DEX_FEE_BPS,
    },
    gates: {
      routePositiveRequires: [
        "current lending/CDP accepted collateral value decoded from oracle or reserve",
        "exact executable acquisition quote for collateral token at route size",
        "borrow-side liquidity above route size",
        "gas/slippage/fee-adjusted net profit above threshold",
        "fork-positive extraction proof before any signed action",
      ],
    },
    summary: {
      targets: targetByAddress.size,
      morphoMarkets: morphoRows.length,
      hyperlendRows: hyperlendRows.length,
      consumerRows: consumerRows.length,
      watchCandidates: watchCandidates.length,
      researchPositiveRows: researchPositiveRows.length,
      routePositive: positiveRoutes.length,
      signedActionJustified: false,
      bestProtocol: best?.protocol || null,
      bestSymbol: best?.collateralAsset?.symbol || null,
      bestNetUsd: round(best?.bestRouteAttempt?.estimatedNetUsd, 2),
      bestEdgeBps: round(best?.bestRouteAttempt?.edgeBps, 2),
      bestLiquidityUsd: round(best?.state?.liquidityAssetsUsd ?? best?.routeLiquidityUsd, 2),
      bestLiquidProtocol: bestLiquid?.protocol || null,
      bestLiquidSymbol: bestLiquid?.collateralAsset?.symbol || null,
      bestLiquidNetUsd: round(bestLiquid?.bestRouteAttempt?.estimatedNetUsd, 2),
      bestLiquidEdgeBps: round(bestLiquid?.bestRouteAttempt?.edgeBps, 2),
      bestLiquidLiquidityUsd: round(bestLiquid?.state?.liquidityAssetsUsd ?? bestLiquid?.routeLiquidityUsd, 2),
    },
    targets: [...targetByAddress.values()].map((target) => ({
      address: target.address,
      symbols: target.symbols,
      primarySymbol: target.primarySymbol,
      sources: target.sources,
      linked: target.linked,
      bestNav: target.tokenProbe?.bestNav || null,
      navCandidates: (target.tokenProbe?.navCandidates || []).slice(0, 8),
      coreRefs: target.coreRefs,
      dexPairs: target.dexPairs.slice(0, 8),
    })),
    topRows: consumerRows.slice(0, 20).map((row) => ({
      protocol: row.protocol,
      marketId: row.marketId || null,
      collateral: row.collateralAsset,
      loanOrBorrow: row.loanAsset || row.borrowAsset,
      ltv: row.ltv,
      acceptedCollateralUsd: round(row.acceptedCollateralUsd, 8),
      borrowablePerTokenUsd: round(row.borrowablePerTokenUsd, 8),
      liquidityUsd: round(row.state?.liquidityAssetsUsd ?? row.routeLiquidityUsd, 2),
      bestRouteAttempt: row.bestRouteAttempt,
      researchPositive: row.researchPositive,
      routePositive: row.routePositive,
      blockers: row.blockers,
    })),
    rows: consumerRows,
    watchCandidates,
    positiveRoutes,
  };

  ensureDir(OUT);
  fs.writeFileSync(OUT, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
  console.log(`HyperEVM LST/LRT routes: targets=${out.summary.targets} morpho=${out.summary.morphoMarkets} hyperlend=${out.summary.hyperlendRows} research=${out.summary.researchPositiveRows} routePositive=${out.summary.routePositive}`);
  console.log(`Report: ${path.relative(WORKSPACE, OUT)}`);
}

main().catch((error) => {
  console.error(`scan-hyperevm-lst-lrt-oracle-routes failed: ${sanitizeError(error)}`);
  process.exitCode = 1;
});
