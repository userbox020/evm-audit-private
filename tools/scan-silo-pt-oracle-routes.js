#!/usr/bin/env node
// Read-only scanner for Silo mainnet PT collateral oracle routes.
// Resolves RPC URLs in memory only and never prints or stores endpoints.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "silo-pt-oracle-routes.json");

const FILES = {
  addressBook: path.join(WORKSPACE, "targets", "silo-contracts-v2", "common", "addresses", "mainnet.json"),
  deployments: path.join(WORKSPACE, "targets", "silo-contracts-v2", "silo-core", "deploy", "silo", "_siloDeployments.json"),
  inputsDir: path.join(WORKSPACE, "targets", "silo-contracts-v2", "silo-core", "deploy", "input", "mainnet"),
};

const THRESHOLDS = {
  routeLiquidityUsd: Number(process.env.SILO_PT_ROUTE_LIQUIDITY_USD || "10000"),
  oraclePremiumBps: Number(process.env.SILO_PT_ORACLE_PREMIUM_BPS || "100"),
  gasUnits: Number(process.env.SILO_PT_GAS_UNITS || "1200000"),
  slippageBps: Number(process.env.SILO_PT_SLIPPAGE_BPS || "100"),
  pendleQuoteIterations: Number(process.env.SILO_PT_PENDLE_QUOTE_ITERATIONS || "32"),
};

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const ORACLE = new ethers.Interface([
  "function VERSION() view returns (string)",
  "function baseToken() view returns (address)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function oracle() view returns (address)",
  "function oracleConfig() view returns (address)",
  "function quote(uint256,address) view returns (uint256)",
  "function quoteToken() view returns (address)",
]);
const SILO_CONFIG = new ethers.Interface([
  "function getSilos() view returns (address,address)",
  "function getConfig(address silo) view returns ((uint256,uint256,address,address,address,address,address,address,address,address,uint256,uint256,uint256,uint256,uint256,address,bool))",
]);
const SILO = new ethers.Interface([
  "function getLiquidity() view returns (uint256)",
  "function getSiloStorage() view returns (uint192,uint64,uint256,uint256,uint256)",
]);
const PENDLE_PT = new ethers.Interface([
  "function expiry() view returns (uint256)",
  "function SY() view returns (address)",
]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
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
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveEthereumRpc() {
  for (const url of loadRpcUrls()) {
    try {
      const idHex = await rpcCall(url, "eth_chainId", [], 6000);
      if (Number(BigInt(idHex)) === 1) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

async function safeCall(provider, to, data) {
  try { return await provider.call({ to, data }); } catch (_) { return null; }
}

function decode(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}

function decodeString(raw, iface, fn) {
  const decoded = decode(raw, iface, fn);
  return decoded?.[0] === undefined ? null : String(decoded[0]);
}

function formatUnits(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try { return ethers.formatUnits(raw, Number(decimals)); } catch (_) { return null; }
}

function numberUnits(raw, decimals) {
  const out = formatUnits(raw, decimals);
  return out === null ? null : Number(out);
}

function bpsDiff(reference, observed) {
  const ref = Number(reference || 0);
  const obs = Number(observed || 0);
  if (!Number.isFinite(ref) || !Number.isFinite(obs) || ref <= 0 || obs <= 0) return null;
  return ((obs / ref) - 1) * 10_000;
}

function decimalToUnits(value, decimals) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0 || decimals === null || decimals === undefined) return null;
  const places = Math.min(Number(decimals), 18);
  const fixed = Number(value).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: places });
  try { return ethers.parseUnits(fixed, Number(decimals)); } catch (_) { return null; }
}

function pendleAddress(value) {
  const raw = String(value || "");
  const part = raw.includes("-") ? raw.split("-").pop() : raw;
  return normalizeAddress(part);
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 20_000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPrices(addresses) {
  const keys = [...new Set(addresses.map(normalizeAddress).filter(Boolean).map((address) => `ethereum:${address.toLowerCase()}`))];
  const prices = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.slice(i, i + 50).join(",")}?searchWidth=6h`, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    for (const [key, row] of Object.entries(json.coins || {})) prices.set(key.split(":").pop().toLowerCase(), Number(row.price || 0));
  }
  return prices;
}

async function fetchPendleMarketIndex(ptRows) {
  const needles = new Set(ptRows.map((row) => row.ptToken.toLowerCase()));
  const attempts = [];
  const marketsByPt = new Map();
  for (const url of [
    "https://api-v2.pendle.finance/core/v1/1/markets/active",
    "https://api-v2.pendle.finance/core/v1/1/markets",
  ]) {
    try {
      const json = await fetchJson(url, { timeoutMs: 30_000 });
      const markets = Array.isArray(json?.markets) ? json.markets : [];
      const hits = [];
      for (const market of markets) {
        const pt = pendleAddress(market.pt);
        if (!pt || !needles.has(pt.toLowerCase())) continue;
        const normalized = {
          name: market.name || null,
          address: normalizeAddress(market.address),
          expiry: market.expiry || null,
          pt,
          yt: pendleAddress(market.yt),
          sy: pendleAddress(market.sy),
          underlyingAsset: pendleAddress(market.underlyingAsset),
          details: market.details || {},
          isActiveEndpoint: url.endsWith("/active"),
          sourceUrl: url,
        };
        hits.push(pt.toLowerCase());
        if (!marketsByPt.has(pt.toLowerCase()) || normalized.isActiveEndpoint) marketsByPt.set(pt.toLowerCase(), normalized);
      }
      attempts.push({ url, ok: true, marketCount: markets.length, hits: [...new Set(hits)] });
    } catch (err) {
      attempts.push({ url, ok: false, error: err.message || String(err) });
    }
  }
  return { attempts, marketsByPt };
}

function loadPtInputs(addressBook, deployments) {
  const deployed = deployments?.mainnet || {};
  const deploymentEntries = Object.entries(deployed).map(([key, address]) => ({ key, keyNorm: normalizeName(key), address: normalizeAddress(address) }));
  const rows = [];
  for (const fileName of fs.readdirSync(FILES.inputsDir)) {
    if (!fileName.endsWith(".json")) continue;
    const name = fileName.replace(/\.json$/i, "");
    const input = readJson(path.join(FILES.inputsDir, fileName), null);
    if (!input) continue;
    const ptSides = [0, 1].filter((i) => String(input[`token${i}`] || "").startsWith("PT-"));
    if (!ptSides.length) continue;
    const norm = normalizeName(name);
    const deployment = deploymentEntries.find((d) => d.keyNorm === norm) || deploymentEntries.find((d) => d.keyNorm.startsWith(norm) || norm.startsWith(d.keyNorm));
    for (const sideIndex of ptSides) {
      const ptSymbol = input[`token${sideIndex}`];
      const quoteSymbol = input[`token${sideIndex === 0 ? 1 : 0}`];
      rows.push({
        id: `${name}:${ptSymbol}`,
        name,
        inputFile: path.relative(WORKSPACE, path.join(FILES.inputsDir, fileName)).replace(/\\/g, "/"),
        deploymentKey: deployment?.key || null,
        config: deployment?.address || null,
        input,
        sideIndex,
        ptSymbol,
        ptToken: normalizeAddress(addressBook[ptSymbol]),
        quoteSymbol,
        quoteToken: normalizeAddress(addressBook[quoteSymbol]),
      });
    }
  }
  return rows.filter((row) => row.ptToken && row.config);
}

async function tokenMeta(provider, address, prices) {
  const token = normalizeAddress(address);
  const [symbolRaw, nameRaw, decimalsRaw, supplyRaw] = await Promise.all([
    safeCall(provider, token, ERC20.encodeFunctionData("symbol", [])),
    safeCall(provider, token, ERC20.encodeFunctionData("name", [])),
    safeCall(provider, token, ERC20.encodeFunctionData("decimals", [])),
    safeCall(provider, token, ERC20.encodeFunctionData("totalSupply", [])),
  ]);
  const decimals = Number(decode(decimalsRaw, ERC20, "decimals")?.[0] ?? 18n);
  const supply = decode(supplyRaw, ERC20, "totalSupply")?.[0] ?? null;
  return {
    address: token,
    symbol: decodeString(symbolRaw, ERC20, "symbol"),
    name: decodeString(nameRaw, ERC20, "name"),
    decimals,
    totalSupplyRaw: supply?.toString() || null,
    totalSupply: supply === null ? null : formatUnits(supply, decimals),
    priceUsd: prices.get(token.toLowerCase()) || null,
  };
}

function parseSiloSide(decoded) {
  const row = decoded?.[0];
  if (!row) return null;
  return {
    silo: normalizeAddress(row[2]),
    token: normalizeAddress(row[3]),
    protectedShareToken: normalizeAddress(row[4]),
    collateralShareToken: normalizeAddress(row[5]),
    debtShareToken: normalizeAddress(row[6]),
    solvencyOracle: normalizeAddress(row[7]),
    maxLtvOracle: normalizeAddress(row[8]),
    maxLtv: Number(row[10] || 0n) / 1e18,
    liquidationThreshold: Number(row[11] || 0n) / 1e18,
  };
}

async function scanSiloMarket(provider, row, prices, metaCache) {
  const silosRaw = await safeCall(provider, row.config, SILO_CONFIG.encodeFunctionData("getSilos", []));
  const silos = (decode(silosRaw, SILO_CONFIG, "getSilos") || []).map(normalizeAddress).filter(Boolean);
  const sides = [];
  for (const silo of silos) {
    const [cfgRaw, liquidityRaw, storageRaw] = await Promise.all([
      safeCall(provider, row.config, SILO_CONFIG.encodeFunctionData("getConfig", [silo])),
      safeCall(provider, silo, SILO.encodeFunctionData("getLiquidity", [])),
      safeCall(provider, silo, SILO.encodeFunctionData("getSiloStorage", [])),
    ]);
    const cfg = parseSiloSide(decode(cfgRaw, SILO_CONFIG, "getConfig"));
    if (!cfg) continue;
    const meta = await getMeta(provider, cfg.token, prices, metaCache);
    const liquidity = decode(liquidityRaw, SILO, "getLiquidity")?.[0] || 0n;
    const storage = decode(storageRaw, SILO, "getSiloStorage");
    const liquidityNumber = numberUnits(liquidity, meta.decimals);
    sides.push({
      ...cfg,
      symbol: meta.symbol,
      decimals: meta.decimals,
      priceUsd: meta.priceUsd,
      liquidityRaw: liquidity.toString(),
      liquidity: liquidityNumber,
      liquidityUsd: meta.priceUsd === null ? null : liquidityNumber * Number(meta.priceUsd || 0),
      collateralAssetsRaw: (storage?.[3] || 0n).toString(),
      debtAssetsRaw: (storage?.[4] || 0n).toString(),
    });
  }
  const ptSide = sides.find((s) => s.token?.toLowerCase() === row.ptToken.toLowerCase()) || null;
  const oppositeSide = sides.find((s) => s.token?.toLowerCase() !== row.ptToken.toLowerCase()) || null;
  return { silos, sides, ptSide, oppositeSide };
}

async function getMeta(provider, address, prices, cache) {
  const key = normalizeAddress(address)?.toLowerCase();
  if (!key) return null;
  if (!cache.has(key)) cache.set(key, await tokenMeta(provider, address, prices));
  return cache.get(key);
}

async function scanOracle(provider, oracleAddress, ptToken, ptDecimals, quoteToken, prices) {
  const oracle = normalizeAddress(oracleAddress);
  if (!oracle || oracle === ethers.ZeroAddress) return { address: oracle, present: false, blockers: ["oracle missing or zero"] };
  const baseAmount = 10n ** BigInt(ptDecimals || 18);
  const [code, versionRaw, baseRaw, quoteTokenRaw, descriptionRaw, latestRaw, quoteRaw, wrappedRaw, configRaw] = await Promise.all([
    provider.getCode(oracle).catch(() => "0x"),
    safeCall(provider, oracle, ORACLE.encodeFunctionData("VERSION", [])),
    safeCall(provider, oracle, ORACLE.encodeFunctionData("baseToken", [])),
    safeCall(provider, oracle, ORACLE.encodeFunctionData("quoteToken", [])),
    safeCall(provider, oracle, ORACLE.encodeFunctionData("description", [])),
    safeCall(provider, oracle, ORACLE.encodeFunctionData("latestRoundData", [])),
    safeCall(provider, oracle, ORACLE.encodeFunctionData("quote", [baseAmount, ptToken])),
    safeCall(provider, oracle, ORACLE.encodeFunctionData("oracle", [])),
    safeCall(provider, oracle, ORACLE.encodeFunctionData("oracleConfig", [])),
  ]);
  const quote = decode(quoteRaw, ORACLE, "quote")?.[0] ?? null;
  const latest = decode(latestRaw, ORACLE, "latestRoundData");
  const quoteTokenRead = normalizeAddress(decode(quoteTokenRaw, ORACLE, "quoteToken")?.[0]) || quoteToken;
  const quoteTokenUsd = prices.get(quoteTokenRead?.toLowerCase()) || null;
  const acceptedQuoteAs18 = quote === null ? null : Number(formatUnits(quote, 18));
  return {
    address: oracle,
    codePresent: Boolean(code && code !== "0x"),
    version: decodeString(versionRaw, ORACLE, "VERSION"),
    description: decodeString(descriptionRaw, ORACLE, "description"),
    baseToken: normalizeAddress(decode(baseRaw, ORACLE, "baseToken")?.[0]),
    quoteToken: quoteTokenRead,
    wrappedOracle: normalizeAddress(decode(wrappedRaw, ORACLE, "oracle")?.[0]),
    oracleConfig: normalizeAddress(decode(configRaw, ORACLE, "oracleConfig")?.[0]),
    latestRoundAnswerRaw: latest?.[1]?.toString() || null,
    latestRoundAnswerAs18: latest?.[1] === undefined ? null : Number(formatUnits(latest[1], 18)),
    quoteOnePtRaw: quote?.toString() || null,
    quoteOnePtAs18: acceptedQuoteAs18,
    quoteTokenUsd,
    acceptedUsdPerPt: acceptedQuoteAs18 === null || quoteTokenUsd === null ? acceptedQuoteAs18 : acceptedQuoteAs18 * quoteTokenUsd,
  };
}

async function scanPt(provider, ptToken) {
  const [expiryRaw, syRaw] = await Promise.all([
    safeCall(provider, ptToken, PENDLE_PT.encodeFunctionData("expiry", [])),
    safeCall(provider, ptToken, PENDLE_PT.encodeFunctionData("SY", [])),
  ]);
  const expiry = decode(expiryRaw, PENDLE_PT, "expiry")?.[0];
  return {
    expiry: expiry ? Number(expiry) : null,
    expiryIso: expiry ? new Date(Number(expiry) * 1000).toISOString() : null,
    sy: normalizeAddress(decode(syRaw, PENDLE_PT, "SY")?.[0]),
  };
}

async function fetchPendleSwappingPrice(marketAddress) {
  const market = normalizeAddress(marketAddress);
  if (!market) return { ok: false, error: "market address unavailable" };
  const url = `https://api-v2.pendle.finance/core/v1/sdk/1/markets/${market}/swapping-prices`;
  try {
    const json = await fetchJson(url, { timeoutMs: 20_000 });
    return {
      ok: true,
      url,
      underlyingToken: normalizeAddress(json.underlyingToken),
      underlyingTokenToPtRate: json.underlyingTokenToPtRate === null ? null : Number(json.underlyingTokenToPtRate),
      ptToUnderlyingTokenRate: json.ptToUnderlyingTokenRate === null ? null : Number(json.ptToUnderlyingTokenRate),
      underlyingTokenToYtRate: json.underlyingTokenToYtRate === null ? null : Number(json.underlyingTokenToYtRate),
      ytToUnderlyingTokenRate: json.ytToUnderlyingTokenRate === null ? null : Number(json.ytToUnderlyingTokenRate),
      impliedApy: json.impliedApy === null ? null : Number(json.impliedApy),
    };
  } catch (err) {
    return { ok: false, url, error: err.message || String(err) };
  }
}

async function quotePendleMarketOrder(marketAddress, syInRaw) {
  const market = normalizeAddress(marketAddress);
  if (!market || syInRaw <= 0n) return null;
  const body = {
    chainId: 1,
    type: 0, // TOKEN_FOR_PT, netFromTaker is in SY units.
    netFromTaker: syInRaw.toString(),
    market,
  };
  return fetchJson("https://api-v2.pendle.finance/core/v3/limit-orders/market-order", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 30_000,
  });
}

function marketOrderPtOutRaw(quote) {
  try { return BigInt(quote?.totalTrade?.netToTaker || "0"); } catch (_) { return 0n; }
}

async function findSyInForPtOut(marketAddress, targetPtRaw, estimateSyRaw) {
  if (!marketAddress || !targetPtRaw || targetPtRaw <= 0n || !estimateSyRaw || estimateSyRaw <= 0n) return null;
  let low = 0n;
  let high = estimateSyRaw;
  let highQuote = null;
  for (let i = 0; i < 8; i++) {
    highQuote = await quotePendleMarketOrder(marketAddress, high).catch(() => null);
    if (marketOrderPtOutRaw(highQuote) >= targetPtRaw) break;
    high *= 2n;
    highQuote = null;
  }
  if (!highQuote) return { ok: false, reason: "Pendle market-order quote could not satisfy target PT amount", highSyInRaw: high.toString() };
  let best = { syInRaw: high, quote: highQuote };
  for (let i = 0; i < THRESHOLDS.pendleQuoteIterations; i++) {
    const mid = (low + high) / 2n;
    if (mid <= low) break;
    const quote = await quotePendleMarketOrder(marketAddress, mid).catch(() => null);
    const out = marketOrderPtOutRaw(quote);
    if (quote && out >= targetPtRaw) {
      high = mid;
      best = { syInRaw: mid, quote };
    } else {
      low = mid;
    }
  }
  return { ok: true, ...best };
}

async function scanPendleQuote(provider, market, row, silo, oracle, ptMeta, prices, metaCache) {
  if (!market?.address) return { marketFound: false, executableQuote: false, blocker: "no Pendle market mapped for PT" };
  const [swappingPrice, syMeta, underlyingMeta] = await Promise.all([
    fetchPendleSwappingPrice(market.address),
    market.sy ? getMeta(provider, market.sy, prices, metaCache) : null,
    market.underlyingAsset ? getMeta(provider, market.underlyingAsset, prices, metaCache) : null,
  ]);
  const syPriceUsd = prices.get(market.sy?.toLowerCase()) || prices.get(market.underlyingAsset?.toLowerCase()) || syMeta?.priceUsd || underlyingMeta?.priceUsd || null;
  const acceptedUsdPerPt = oracle.acceptedUsdPerPt;
  const oppositeLiquidityUsd = Number(silo.oppositeSide?.liquidityUsd || 0);
  const maxLtv = Number(silo.ptSide?.maxLtv || 0);
  const ptRequiredForFullBorrow = acceptedUsdPerPt && maxLtv ? oppositeLiquidityUsd / (acceptedUsdPerPt * maxLtv) : null;
  const targetPtRaw = decimalToUnits(ptRequiredForFullBorrow, ptMeta.decimals);
  const spotRate = swappingPrice?.underlyingTokenToPtRate;
  const estimateSyRaw = targetPtRaw && spotRate && syMeta?.decimals !== undefined
    ? decimalToUnits(Number(ethers.formatUnits(targetPtRaw, ptMeta.decimals)) / Number(spotRate), syMeta.decimals)
    : null;
  const quote = targetPtRaw && estimateSyRaw ? await findSyInForPtOut(market.address, targetPtRaw, estimateSyRaw) : null;
  const syInRaw = quote?.ok ? quote.syInRaw : null;
  const syIn = syInRaw && syMeta?.decimals !== undefined ? Number(ethers.formatUnits(syInRaw, syMeta.decimals)) : null;
  const acquisitionCostUsd = syIn !== null && syPriceUsd ? syIn * Number(syPriceUsd) : null;
  return {
    marketFound: true,
    executableQuote: Boolean(quote?.ok && acquisitionCostUsd !== null),
    market: {
      name: market.name,
      address: market.address,
      expiry: market.expiry,
      pt: market.pt,
      yt: market.yt,
      sy: market.sy,
      underlyingAsset: market.underlyingAsset,
      liquidityUsdHint: market.details?.liquidity ?? null,
      impliedApyHint: market.details?.impliedApy ?? null,
      sourceUrl: market.sourceUrl,
    },
    swappingPrice,
    sy: syMeta,
    underlying: underlyingMeta,
    quote: quote?.ok ? {
      type: "TOKEN_FOR_PT",
      source: "Pendle limit-order market-order quote-only endpoint",
      targetPtRaw: targetPtRaw?.toString() || null,
      targetPt: targetPtRaw ? ethers.formatUnits(targetPtRaw, ptMeta.decimals) : null,
      syInRaw: syInRaw?.toString() || null,
      syIn,
      syPriceUsd,
      acquisitionCostUsd,
      totalTrade: quote.quote?.totalTrade || null,
      marketTrade: quote.quote?.marketTrade || null,
      normalOrderCount: Array.isArray(quote.quote?.normalOrders) ? quote.quote.normalOrders.length : null,
      flashOrderCount: Array.isArray(quote.quote?.flashOrders) ? quote.quote.flashOrders.length : null,
    } : null,
    blocker: quote?.ok ? null : (quote?.reason || "Pendle market-order size quote unavailable"),
  };
}

function computeEconomics(row, silo, oracle, gasUsd, publicPtUsd, pendleQuote) {
  const acceptedUsdPerPt = oracle.acceptedUsdPerPt;
  const oppositeLiquidityUsd = Number(silo.oppositeSide?.liquidityUsd || 0);
  const maxLtv = Number(silo.ptSide?.maxLtv || 0);
  const acceptedVsPublicBps = bpsDiff(publicPtUsd, acceptedUsdPerPt);
  const borrowCapacityUsd = oppositeLiquidityUsd;
  const ltvBreakEvenPremiumBps = maxLtv > 0 ? ((1 / maxLtv) - 1) * 10_000 : null;
  const gasBpsAtCapacity = gasUsd && borrowCapacityUsd > 0 ? gasUsd / borrowCapacityUsd * 10_000 : null;
  const requiredPremiumBps = ltvBreakEvenPremiumBps === null ? null : ltvBreakEvenPremiumBps + THRESHOLDS.slippageBps + Number(gasBpsAtCapacity || 0);
  const ptRequiredForFullBorrow = acceptedUsdPerPt && maxLtv ? borrowCapacityUsd / (acceptedUsdPerPt * maxLtv) : null;
  const quoteAcquisitionCostUsd = pendleQuote?.quote?.acquisitionCostUsd ?? null;
  const quoteAcquisitionUsdPerPt = quoteAcquisitionCostUsd !== null && ptRequiredForFullBorrow ? quoteAcquisitionCostUsd / ptRequiredForFullBorrow : null;
  const referenceAcquisitionUsdPerPt = quoteAcquisitionUsdPerPt ?? publicPtUsd;
  const acceptedVsAcquisitionBps = bpsDiff(referenceAcquisitionUsdPerPt, acceptedUsdPerPt);
  const acquisitionCostUsd = quoteAcquisitionCostUsd ?? (ptRequiredForFullBorrow !== null && publicPtUsd ? ptRequiredForFullBorrow * publicPtUsd : null);
  const slippageUsd = borrowCapacityUsd * THRESHOLDS.slippageBps / 10_000;
  const grossEdgeUsd = acquisitionCostUsd === null ? null : borrowCapacityUsd - acquisitionCostUsd;
  const netEdgeUsd = grossEdgeUsd === null ? null : grossEdgeUsd - Number(gasUsd || 0) - slippageUsd;
  const reviewCandidate = oppositeLiquidityUsd >= THRESHOLDS.routeLiquidityUsd && maxLtv > 0;
  const hasBreakEvenPremium = acceptedVsAcquisitionBps !== null && requiredPremiumBps !== null && acceptedVsAcquisitionBps >= requiredPremiumBps;
  const executablePendleQuote = Boolean(pendleQuote?.executableQuote);
  const routePositive = Boolean(reviewCandidate && executablePendleQuote && hasBreakEvenPremium && netEdgeUsd !== null && netEdgeUsd > 0);
  return {
    acceptedUsdPerPt,
    publicPtUsd,
    acceptedVsPublicBps,
    quoteAcquisitionUsdPerPt,
    acceptedVsAcquisitionBps,
    acquisitionReference: quoteAcquisitionUsdPerPt ? "pendle-market-order" : (publicPtUsd ? "public-token-price" : null),
    maxLtv,
    ltvBreakEvenPremiumBps,
    requiredPremiumBps,
    oppositeLiquidityUsd,
    borrowCapacityUsd,
    ptRequiredForFullBorrow,
    acquisitionCostUsd,
    grossEdgeUsd,
    gasUsd,
    gasBpsAtCapacity,
    slippageUsd,
    netEdgeUsd,
    reviewCandidate,
    executablePendleQuote,
    routePositive,
    blockers: [
      referenceAcquisitionUsdPerPt ? null : "no public or executable PT price reference",
      acceptedUsdPerPt ? null : "oracle quote unavailable",
      maxLtv > 0 ? null : "PT collateral LTV disabled",
      oppositeLiquidityUsd >= THRESHOLDS.routeLiquidityUsd ? null : "opposite-side liquidity below threshold",
      hasBreakEvenPremium ? null : "accepted PT value below LTV break-even premium",
      executablePendleQuote ? null : (pendleQuote?.blocker || "no executable PT exit/acquisition quote wired yet"),
    ].filter(Boolean),
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rpc = await resolveEthereumRpc();
  if (!rpc) throw new Error("Ethereum RPC unavailable from local inventory");
  const provider = new ethers.JsonRpcProvider(rpc);
  const addressBook = readJson(FILES.addressBook, {});
  const deployments = readJson(FILES.deployments, {});
  const ptRows = loadPtInputs(addressBook, deployments);
  const pendleMarketIndex = await fetchPendleMarketIndex(ptRows);
  const priceAddresses = [];
  for (const row of ptRows) priceAddresses.push(row.ptToken, row.quoteToken);
  for (const market of pendleMarketIndex.marketsByPt.values()) priceAddresses.push(market.sy, market.underlyingAsset);
  priceAddresses.push(addressBook.USDC, addressBook.WETH);
  const prices = await fetchPrices(priceAddresses.filter(Boolean));
  const metaCache = new Map();
  const [block, feeData, ethPriceJson] = await Promise.all([
    provider.getBlock("latest"),
    provider.getFeeData(),
    fetchJson("https://coins.llama.fi/prices/current/coingecko:ethereum", { timeoutMs: 20_000 }).catch(() => null),
  ]);
  const ethPrice = ethPriceJson?.coins?.["coingecko:ethereum"]?.price || null;
  const gasUsd = feeData.gasPrice && ethPrice ? Number(ethers.formatEther(feeData.gasPrice * BigInt(THRESHOLDS.gasUnits))) * Number(ethPrice) : null;
  const rows = [];
  for (const row of ptRows) {
    const [ptMeta, quoteMeta, silo, ptInfo] = await Promise.all([
      getMeta(provider, row.ptToken, prices, metaCache),
      getMeta(provider, row.quoteToken, prices, metaCache),
      scanSiloMarket(provider, row, prices, metaCache),
      scanPt(provider, row.ptToken),
    ]);
    const oracleAddress = row.sideIndex === 0 ? silo.ptSide?.solvencyOracle : silo.ptSide?.solvencyOracle;
    const oracle = await scanOracle(provider, oracleAddress, row.ptToken, ptMeta.decimals, row.quoteToken, prices);
    const pendleQuote = await scanPendleQuote(provider, pendleMarketIndex.marketsByPt.get(row.ptToken.toLowerCase()), row, silo, oracle, ptMeta, prices, metaCache);
    const economics = computeEconomics(row, silo, oracle, gasUsd, ptMeta.priceUsd, pendleQuote);
    rows.push({
      id: row.id,
      name: row.name,
      deploymentKey: row.deploymentKey,
      config: row.config,
      inputFile: row.inputFile,
      ptSymbol: row.ptSymbol,
      ptToken: row.ptToken,
      quoteSymbol: row.quoteSymbol,
      quoteToken: row.quoteToken,
      input: {
        token0: row.input.token0,
        token1: row.input.token1,
        solvencyOracle0: row.input.solvencyOracle0,
        solvencyOracle1: row.input.solvencyOracle1,
        maxLtv0: row.input.maxLtv0,
        maxLtv1: row.input.maxLtv1,
        lt0: row.input.lt0,
        lt1: row.input.lt1,
      },
      pt: { ...ptMeta, ...ptInfo },
      quote: quoteMeta,
      silo: {
        silos: silo.silos,
        ptSide: silo.ptSide,
        oppositeSide: silo.oppositeSide,
      },
      oracle,
      pendleQuote,
      economics,
      reviewCandidate: economics.reviewCandidate,
      routePositive: economics.routePositive,
      blockers: economics.blockers,
    });
  }
  rows.sort((a, b) => Number(b.routePositive) - Number(a.routePositive) || Number(b.reviewCandidate) - Number(a.reviewCandidate) || Number(b.economics.netEdgeUsd ?? -1e18) - Number(a.economics.netEdgeUsd ?? -1e18));
  const reviewCandidates = rows.filter((r) => r.reviewCandidate);
  const routePositive = rows.filter((r) => r.routePositive);
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-silo-pt-oracle-routes.js",
    scope: "Read-only generalized Silo mainnet PT oracle route scan",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive.length > 0,
      signedActionJustified: false,
    },
    thresholds: THRESHOLDS,
    inputs: Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, path.relative(WORKSPACE, file).replace(/\\/g, "/")])),
    block: { number: block.number, timestamp: Number(block.timestamp), iso: new Date(Number(block.timestamp) * 1000).toISOString() },
    gas: { gasPriceWei: feeData.gasPrice?.toString() || null, ethPriceUsd: ethPrice, gasUnits: THRESHOLDS.gasUnits, gasUsd },
    pendleMarketDiscovery: {
      attempts: pendleMarketIndex.attempts,
      marketsMapped: pendleMarketIndex.marketsByPt.size,
      marketsByPt: Object.fromEntries([...pendleMarketIndex.marketsByPt.entries()]),
    },
    summary: {
      ptInputsMapped: ptRows.length,
      rows: rows.length,
      reviewCandidates: reviewCandidates.length,
      routePositive: routePositive.length,
      signedActionJustified: false,
      pendleMarketsMapped: pendleMarketIndex.marketsByPt.size,
      pendleExecutableQuotes: rows.filter((r) => r.pendleQuote?.executableQuote).length,
      topReview: reviewCandidates.slice(0, 8).map((r) => r.id),
      topByNetEdge: rows.slice(0, 8).map((r) => ({ id: r.id, netEdgeUsd: r.economics.netEdgeUsd, acceptedVsPublicBps: r.economics.acceptedVsPublicBps, acceptedVsAcquisitionBps: r.economics.acceptedVsAcquisitionBps, acquisitionReference: r.economics.acquisitionReference, oppositeLiquidityUsd: r.economics.oppositeLiquidityUsd })),
    },
    rows,
    nextRoutePositiveCriteria: [
      "accepted PT value exceeds live executable PT acquisition/exit by more than LTV break-even plus gas/slippage",
      "opposite-side borrow liquidity is material",
      "public PT price is backed by an executable quote or on-chain market route",
      "oracle path is decoded and not just a wrapper/scaler black box",
      "fork simulation extracts positive value from the exact Silo market",
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(out, jsonReplacer, 2) + "\n");
  console.log(`Silo PT routes: rows=${rows.length} review=${reviewCandidates.length} routePositive=${routePositive.length}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
