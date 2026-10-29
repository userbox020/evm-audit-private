#!/usr/bin/env node
// Focused read-only scanner for Silo PT-sUSDf-29JAN2026/USDC.
// RPC URLs are read in memory only and never printed or written.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "falcon-silo-pt-oracle-route.json");

const ADDR = {
  marketConfig: "0x6D0c2c897101dA51755ea06587CAfbE189099628",
  pt: "0x48E502FBB6Ff2CC687d049150E2C8AdDC765A43a",
  siloOracle: "0xaACAa013c4394325A7A0545F983d18266b29d370",
  linearAggregator: "0x56e5577fa22a250D41AA69849787410fE49170D3",
  sUSDf: "0xc8CF6D7991f15525488b2A83Df53468D682Ba4B0",
  USDf: "0xFa2B947eEc368f42195f24F36d2aF29f7c24CeC2",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  usdfUsdFeed: "0xb177857a1799aA5F7fEb5799Fdf12CbE8fdF78B1",
  susdfUsdfFeed: "0xe471bc940AA9831a0AeA21E6F40C1A1236EB4BB3",
};

const THRESHOLDS = {
  routeLiquidityUsd: Number(process.env.FALCON_SILO_ROUTE_LIQUIDITY_USD || "10000"),
  producerDivergenceBps: Number(process.env.FALCON_SILO_PRODUCER_DIVERGENCE_BPS || "100"),
  oraclePremiumBps: Number(process.env.FALCON_SILO_ORACLE_PREMIUM_BPS || "100"),
  gasUnits: Number(process.env.FALCON_SILO_GAS_UNITS || "1200000"),
  slippageBps: Number(process.env.FALCON_SILO_SLIPPAGE_BPS || "100"),
};

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
]);
const CHAINLINK = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const PT_LINEAR_ORACLE = new ethers.Interface([
  "function VERSION() view returns (string)",
  "function baseDiscountPerYear() view returns (uint256)",
  "function baseToken() view returns (address)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function oracleConfig() view returns (address)",
  "function quote(uint256,address) view returns (uint256)",
  "function quoteToken() view returns (address)",
]);
const PT_LINEAR_CONFIG = new ethers.Interface([
  "function getConfig() view returns (tuple(address linearOracle,address ptToken,address hardcodedQuoteToken,uint256 normalizationDivider))",
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

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
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
      const chainIdHex = await rpcCall(url, "eth_chainId", [], 6000);
      if (Number(BigInt(chainIdHex)) === 1) return url;
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

function formatUnitsSafe(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try { return ethers.formatUnits(raw, Number(decimals)); } catch (_) { return null; }
}

function numberUnits(raw, decimals) {
  const formatted = formatUnitsSafe(raw, decimals);
  return formatted === null ? null : Number(formatted);
}

function bpsDiff(reference, observed) {
  const ref = Number(reference || 0);
  const obs = Number(observed || 0);
  if (!Number.isFinite(ref) || !Number.isFinite(obs) || ref <= 0 || obs <= 0) return null;
  return ((obs / ref) - 1) * 10_000;
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
    const url = `https://coins.llama.fi/prices/current/${keys.slice(i, i + 50).join(",")}?searchWidth=6h`;
    const json = await fetchJson(url, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    for (const [key, row] of Object.entries(json.coins || {})) prices.set(key.split(":").pop().toLowerCase(), Number(row.price || 0));
  }
  return prices;
}

async function tokenMeta(provider, address, prices, extraBalances = []) {
  const token = normalizeAddress(address);
  const [code, symbolRaw, nameRaw, decimalsRaw, supplyRaw, assetRaw, totalAssetsRaw, convertRaw] = await Promise.all([
    provider.getCode(token).catch(() => "0x"),
    safeCall(provider, token, ERC20.encodeFunctionData("symbol", [])),
    safeCall(provider, token, ERC20.encodeFunctionData("name", [])),
    safeCall(provider, token, ERC20.encodeFunctionData("decimals", [])),
    safeCall(provider, token, ERC20.encodeFunctionData("totalSupply", [])),
    safeCall(provider, token, ERC4626.encodeFunctionData("asset", [])),
    safeCall(provider, token, ERC4626.encodeFunctionData("totalAssets", [])),
    safeCall(provider, token, ERC4626.encodeFunctionData("convertToAssets", [10n ** 18n])),
  ]);
  const decimals = Number(decode(decimalsRaw, ERC20, "decimals")?.[0] ?? 18n);
  const supply = decode(supplyRaw, ERC20, "totalSupply")?.[0] ?? null;
  const totalAssets = decode(totalAssetsRaw, ERC4626, "totalAssets")?.[0] ?? null;
  const convertOne = decode(convertRaw, ERC4626, "convertToAssets")?.[0] ?? null;
  const balances = {};
  for (const holder of extraBalances.map(normalizeAddress).filter(Boolean)) {
    const raw = decode(await safeCall(provider, token, ERC20.encodeFunctionData("balanceOf", [holder])), ERC20, "balanceOf")?.[0] ?? null;
    balances[holder] = { raw: raw?.toString() || null, formatted: raw === null ? null : formatUnitsSafe(raw, decimals) };
  }
  return {
    address: token,
    codePresent: Boolean(code && code !== "0x"),
    symbol: decodeString(symbolRaw, ERC20, "symbol"),
    name: decodeString(nameRaw, ERC20, "name"),
    decimals,
    totalSupplyRaw: supply?.toString() || null,
    totalSupply: supply === null ? null : formatUnitsSafe(supply, decimals),
    priceUsd: prices.get(token.toLowerCase()) || null,
    balances,
    erc4626: {
      asset: normalizeAddress(decode(assetRaw, ERC4626, "asset")?.[0]) || null,
      totalAssetsRaw: totalAssets?.toString() || null,
      totalAssets: totalAssets === null ? null : formatUnitsSafe(totalAssets, decimals),
      convertOneShareToAssetsRaw: convertOne?.toString() || null,
      convertOneShareToAssets: convertOne === null ? null : formatUnitsSafe(convertOne, decimals),
    },
  };
}

async function feedState(provider, address, blockTimestamp) {
  const feed = normalizeAddress(address);
  const [code, decimalsRaw, descriptionRaw, roundRaw] = await Promise.all([
    provider.getCode(feed).catch(() => "0x"),
    safeCall(provider, feed, CHAINLINK.encodeFunctionData("decimals", [])),
    safeCall(provider, feed, CHAINLINK.encodeFunctionData("description", [])),
    safeCall(provider, feed, CHAINLINK.encodeFunctionData("latestRoundData", [])),
  ]);
  const decimals = Number(decode(decimalsRaw, CHAINLINK, "decimals")?.[0] ?? 8n);
  const round = decode(roundRaw, CHAINLINK, "latestRoundData");
  const answer = round?.[1] ?? null;
  const updatedAt = round?.[3] ? Number(round[3]) : null;
  return {
    address: feed,
    codePresent: Boolean(code && code !== "0x"),
    description: decodeString(descriptionRaw, CHAINLINK, "description"),
    decimals,
    answerRaw: answer?.toString() || null,
    answer: answer === null ? null : Number(formatUnitsSafe(answer, decimals)),
    updatedAt,
    ageSeconds: updatedAt ? Math.max(0, blockTimestamp - updatedAt) : null,
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

async function scanSilo(provider, prices) {
  const silosRaw = await safeCall(provider, ADDR.marketConfig, SILO_CONFIG.encodeFunctionData("getSilos", []));
  const silos = (decode(silosRaw, SILO_CONFIG, "getSilos") || []).map(normalizeAddress).filter(Boolean);
  const sides = [];
  for (const silo of silos) {
    const [cfgRaw, liquidityRaw, storageRaw] = await Promise.all([
      safeCall(provider, ADDR.marketConfig, SILO_CONFIG.encodeFunctionData("getConfig", [silo])),
      safeCall(provider, silo, SILO.encodeFunctionData("getLiquidity", [])),
      safeCall(provider, silo, SILO.encodeFunctionData("getSiloStorage", [])),
    ]);
    const cfg = parseSiloSide(decode(cfgRaw, SILO_CONFIG, "getConfig"));
    if (!cfg) continue;
    const meta = await tokenMeta(provider, cfg.token, prices, [silo, cfg.collateralShareToken, cfg.debtShareToken]);
    const liquidity = decode(liquidityRaw, SILO, "getLiquidity")?.[0] || 0n;
    const storage = decode(storageRaw, SILO, "getSiloStorage");
    const liquidityFormatted = numberUnits(liquidity, meta.decimals);
    sides.push({
      ...cfg,
      symbol: meta.symbol,
      decimals: meta.decimals,
      priceUsd: meta.priceUsd,
      liquidityRaw: liquidity.toString(),
      liquidity: liquidityFormatted,
      liquidityUsd: meta.priceUsd === null ? null : liquidityFormatted * Number(meta.priceUsd || 0),
      collateralAssetsRaw: (storage?.[3] || 0n).toString(),
      debtAssetsRaw: (storage?.[4] || 0n).toString(),
      tokenMeta: meta,
    });
  }
  return {
    config: ADDR.marketConfig,
    silos,
    sides,
    ptSide: sides.find((s) => s.token?.toLowerCase() === ADDR.pt.toLowerCase()) || null,
    usdcSide: sides.find((s) => s.token?.toLowerCase() === ADDR.USDC.toLowerCase()) || null,
  };
}

async function scanOracle(provider) {
  const [versionRaw, configRaw, baseRaw, quoteTokenRaw, descriptionRaw, latestRaw, quoteRaw, discountRaw] = await Promise.all([
    safeCall(provider, ADDR.siloOracle, PT_LINEAR_ORACLE.encodeFunctionData("VERSION", [])),
    safeCall(provider, ADDR.siloOracle, PT_LINEAR_ORACLE.encodeFunctionData("oracleConfig", [])),
    safeCall(provider, ADDR.siloOracle, PT_LINEAR_ORACLE.encodeFunctionData("baseToken", [])),
    safeCall(provider, ADDR.siloOracle, PT_LINEAR_ORACLE.encodeFunctionData("quoteToken", [])),
    safeCall(provider, ADDR.siloOracle, PT_LINEAR_ORACLE.encodeFunctionData("description", [])),
    safeCall(provider, ADDR.siloOracle, PT_LINEAR_ORACLE.encodeFunctionData("latestRoundData", [])),
    safeCall(provider, ADDR.siloOracle, PT_LINEAR_ORACLE.encodeFunctionData("quote", [10n ** 18n, ADDR.pt])),
    safeCall(provider, ADDR.siloOracle, PT_LINEAR_ORACLE.encodeFunctionData("baseDiscountPerYear", [])),
  ]);
  const configAddress = normalizeAddress(decode(configRaw, PT_LINEAR_ORACLE, "oracleConfig")?.[0]);
  const configTuple = configAddress
    ? decode(await safeCall(provider, configAddress, PT_LINEAR_CONFIG.encodeFunctionData("getConfig", [])), PT_LINEAR_CONFIG, "getConfig")?.[0]
    : null;
  const decodedConfig = configTuple ? {
    linearOracle: normalizeAddress(configTuple.linearOracle),
    ptToken: normalizeAddress(configTuple.ptToken),
    hardcodedQuoteToken: normalizeAddress(configTuple.hardcodedQuoteToken),
    normalizationDivider: configTuple.normalizationDivider.toString(),
  } : null;
  const configMatchesExpected = Boolean(
    decodedConfig
    && decodedConfig.linearOracle?.toLowerCase() === ADDR.linearAggregator.toLowerCase()
    && decodedConfig.ptToken?.toLowerCase() === ADDR.pt.toLowerCase()
    && decodedConfig.hardcodedQuoteToken?.toLowerCase() === ADDR.USDC.toLowerCase()
    && decodedConfig.normalizationDivider !== "0"
  );
  const latest = decode(latestRaw, PT_LINEAR_ORACLE, "latestRoundData");
  const quote = decode(quoteRaw, PT_LINEAR_ORACLE, "quote")?.[0] ?? null;
  const aggregatorState = await feedState(provider, ADDR.linearAggregator, 0);
  return {
    address: ADDR.siloOracle,
    version: decodeString(versionRaw, PT_LINEAR_ORACLE, "VERSION"),
    description: decodeString(descriptionRaw, PT_LINEAR_ORACLE, "description"),
    configAddress,
    configDecodeStatus: configTuple ? (configMatchesExpected ? "matches-expected-pt-linear-config" : "unexpected-wrapper-or-abi-mismatch") : "not-readable",
    config: configMatchesExpected ? decodedConfig : null,
    rawDecodedConfig: configMatchesExpected ? null : decodedConfig,
    baseToken: normalizeAddress(decode(baseRaw, PT_LINEAR_ORACLE, "baseToken")?.[0]),
    quoteToken: normalizeAddress(decode(quoteTokenRaw, PT_LINEAR_ORACLE, "quoteToken")?.[0]),
    latestRoundAnswerRaw: latest?.[1]?.toString() || null,
    latestRoundAnswerAs18: latest?.[1] === undefined ? null : Number(formatUnitsSafe(latest[1], 18)),
    quoteOnePtRaw: quote?.toString() || null,
    quoteOnePtAs18: quote === null ? null : Number(formatUnitsSafe(quote, 18)),
    quoteOnePtAsUsdcUnits: quote === null ? null : Number(formatUnitsSafe(quote, 6)),
    baseDiscountPerYearRaw: decode(discountRaw, PT_LINEAR_ORACLE, "baseDiscountPerYear")?.[0]?.toString() || null,
    linearAggregator: aggregatorState,
  };
}

async function scanPt(provider) {
  const [expiryRaw, syRaw] = await Promise.all([
    safeCall(provider, ADDR.pt, PENDLE_PT.encodeFunctionData("expiry", [])),
    safeCall(provider, ADDR.pt, PENDLE_PT.encodeFunctionData("SY", [])),
  ]);
  const expiry = decode(expiryRaw, PENDLE_PT, "expiry")?.[0];
  return {
    token: ADDR.pt,
    expiry: expiry ? Number(expiry) : null,
    expiryIso: expiry ? new Date(Number(expiry) * 1000).toISOString() : null,
    sy: normalizeAddress(decode(syRaw, PENDLE_PT, "SY")?.[0]),
  };
}

function walk(value, visitor, out = [], pathParts = []) {
  if (out.length > 200) return out;
  if (!value || typeof value !== "object") return out;
  if (visitor(value, pathParts)) out.push({ path: pathParts.join("."), value });
  if (Array.isArray(value)) value.forEach((child, i) => walk(child, visitor, out, pathParts.concat(String(i))));
  else Object.entries(value).forEach(([key, child]) => walk(child, visitor, out, pathParts.concat(key)));
  return out;
}

async function fetchPendleDiscovery() {
  const endpoints = [
    "https://api-v2.pendle.finance/core/v1/1/markets/active",
    "https://api-v2.pendle.finance/core/v1/1/markets",
    "https://api-v2.pendle.finance/core/v2/1/markets/active",
    "https://api-v2.pendle.finance/core/v2/1/markets",
  ];
  const attempts = [];
  const needle = ADDR.pt.toLowerCase();
  for (const url of endpoints) {
    try {
      const json = await fetchJson(url, { timeoutMs: 20_000 });
      const hits = walk(json, (obj) => Object.values(obj).some((v) => String(v || "").toLowerCase() === needle || String(v || "").toLowerCase().includes(needle))).slice(0, 8);
      attempts.push({ url, ok: true, hits: hits.length, sample: hits.map((h) => h.value).slice(0, 2) });
      if (hits.length) return { found: true, attempts };
    } catch (err) {
      attempts.push({ url, ok: false, error: err.message || String(err) });
    }
  }
  return { found: false, attempts };
}

function computeEconomics({ oracle, silo, prices, producerSignals, gas }) {
  const acceptedUsdPerPt = oracle.quoteOnePtAs18;
  const publicPtUsd = prices.get(ADDR.pt.toLowerCase()) || null;
  const usdcLiquidityUsd = silo.usdcSide?.liquidityUsd || 0;
  const maxLtv = silo.ptSide?.maxLtv || 0;
  const borrowCapacityUsd = usdcLiquidityUsd;
  const acceptedVsPublicBps = bpsDiff(publicPtUsd, acceptedUsdPerPt);
  const gasUsd = gas?.gasUsd || null;
  const slippageUsd = borrowCapacityUsd * THRESHOLDS.slippageBps / 10_000;
  const borrowablePerPtUsd = Number(acceptedUsdPerPt || 0) * maxLtv;
  const ptRequiredForFullBorrow = borrowablePerPtUsd > 0 ? borrowCapacityUsd / borrowablePerPtUsd : null;
  const acquisitionCostUsd = ptRequiredForFullBorrow === null || publicPtUsd === null ? null : ptRequiredForFullBorrow * publicPtUsd;
  const grossEdgeUsd = acquisitionCostUsd === null ? null : borrowCapacityUsd - acquisitionCostUsd;
  const netEdgeUsd = grossEdgeUsd === null ? null : grossEdgeUsd - Number(gasUsd || 0) - slippageUsd;
  const ltvBreakEvenPremiumBps = maxLtv > 0 ? ((1 / maxLtv) - 1) * 10_000 : null;
  const gasBpsAtCapacity = gasUsd && borrowCapacityUsd > 0 ? gasUsd / borrowCapacityUsd * 10_000 : null;
  const requiredPremiumBps = ltvBreakEvenPremiumBps === null ? null : ltvBreakEvenPremiumBps + THRESHOLDS.slippageBps + Number(gasBpsAtCapacity || 0);
  const hasProducerAnomaly = Boolean(producerSignals.currentProducerAnomaly);
  const hasOraclePremium = acceptedVsPublicBps !== null && requiredPremiumBps !== null && acceptedVsPublicBps >= requiredPremiumBps;
  const executableExitQuote = false;
  const routePositive = false;
  return {
    acceptedUsdPerPt,
    publicPtUsd,
    acceptedVsPublicBps,
    maxLtv,
    borrowablePerPtUsd,
    ltvBreakEvenPremiumBps,
    requiredPremiumBps,
    usdcLiquidityUsd,
    borrowCapacityUsd,
    ptRequiredForFullBorrow,
    acquisitionCostUsd,
    grossEdgeUsd,
    netEdgeUsd,
    gasUsd,
    gasBpsAtCapacity,
    slippageUsd,
    executableExitQuote,
    hasProducerAnomaly,
    hasOraclePremium,
    routePositive,
    blockers: [
      hasProducerAnomaly ? null : "no current Falcon/sUSDf/PT producer anomaly",
      hasOraclePremium ? null : "Silo accepted PT value is below LTV break-even premium versus public PT reference",
      executableExitQuote ? null : "no reliable executable Pendle/PT exit quote discovered",
      usdcLiquidityUsd >= THRESHOLDS.routeLiquidityUsd ? null : "USDC-side borrow liquidity below threshold",
    ].filter(Boolean),
  };
}

async function main() {
  ensureDir(OUT);
  const rpc = await resolveEthereumRpc();
  if (!rpc) throw new Error("Ethereum RPC unavailable from local inventory");
  const provider = new ethers.JsonRpcProvider(rpc);
  const [block, gasPrice] = await Promise.all([provider.getBlock("latest"), provider.getFeeData()]);
  const prices = await fetchPrices([ADDR.pt, ADDR.sUSDf, ADDR.USDf, ADDR.USDC]);
  const ethPrice = await fetchJson("https://coins.llama.fi/prices/current/coingecko:ethereum", { timeoutMs: 20_000 }).then((j) => j.coins?.["coingecko:ethereum"]?.price || null).catch(() => null);

  const silo = await scanSilo(provider, prices);
  const [oracle, pt, usdfMeta, susdfMeta, ptMeta, usdcMeta, usdfFeed, susdfFeed, pendle] = await Promise.all([
    scanOracle(provider),
    scanPt(provider),
    tokenMeta(provider, ADDR.USDf, prices),
    tokenMeta(provider, ADDR.sUSDf, prices),
    tokenMeta(provider, ADDR.pt, prices),
    tokenMeta(provider, ADDR.USDC, prices, silo.silos || []),
    feedState(provider, ADDR.usdfUsdFeed, Number(block.timestamp)),
    feedState(provider, ADDR.susdfUsdfFeed, Number(block.timestamp)),
    fetchPendleDiscovery(),
  ]);

  const feedUsdfUsd = usdfFeed.answer || null;
  const feedSusdfUsd = usdfFeed.answer && susdfFeed.answer ? usdfFeed.answer * susdfFeed.answer : null;
  const producerSignals = {
    usdfFeed,
    susdfFeed,
    feedUsdfUsd,
    feedSusdfUsd,
    usdfPriceUsd: usdfMeta.priceUsd,
    susdfPriceUsd: susdfMeta.priceUsd,
    ptPriceUsd: ptMeta.priceUsd,
    usdfVsLiveBps: bpsDiff(usdfMeta.priceUsd, feedUsdfUsd),
    susdfVsLiveBps: bpsDiff(susdfMeta.priceUsd, feedSusdfUsd),
  };
  producerSignals.currentProducerAnomaly = [producerSignals.usdfVsLiveBps, producerSignals.susdfVsLiveBps].some((v) => v !== null && Math.abs(v) >= THRESHOLDS.producerDivergenceBps);

  const gas = {
    gasPriceWei: gasPrice.gasPrice?.toString() || null,
    ethPriceUsd: ethPrice,
    gasUnits: THRESHOLDS.gasUnits,
    gasUsd: gasPrice.gasPrice && ethPrice ? Number(ethers.formatEther(gasPrice.gasPrice * BigInt(THRESHOLDS.gasUnits))) * Number(ethPrice) : null,
  };
  const economics = computeEconomics({ oracle, silo, prices, producerSignals, gas });
  const routePositive = Boolean(economics.routePositive);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-falcon-silo-pt-oracle-route.js",
    scope: "Focused read-only Silo PT-sUSDf-29JAN2026/USDC oracle route check",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive,
      signedActionJustified: false,
    },
    thresholds: THRESHOLDS,
    addresses: ADDR,
    block: { number: block.number, timestamp: Number(block.timestamp), iso: new Date(Number(block.timestamp) * 1000).toISOString() },
    oracle,
    silo,
    pt,
    tokens: { USDf: usdfMeta, sUSDf: susdfMeta, PT_sUSDf_29JAN2026: ptMeta, USDC: usdcMeta },
    producerSignals,
    pendleDiscovery: pendle,
    gas,
    economics,
    summary: {
      acceptedUsdPerPt: economics.acceptedUsdPerPt,
      publicPtUsd: economics.publicPtUsd,
      acceptedVsPublicBps: economics.acceptedVsPublicBps,
      usdcLiquidityUsd: economics.usdcLiquidityUsd,
      routePositive: routePositive ? 1 : 0,
      signedActionJustified: false,
      forkJustified: routePositive,
      blockers: economics.blockers,
    },
    nextRoutePositiveCriteria: [
      "Silo accepted PT value exceeds live executable PT exit/acquisition value by enough to cover LTV, gas, and slippage",
      "Falcon/sUSDf/PT producer anomaly is current, not just stale-but-flat feeds",
      "Pendle/PT exit quote is executable with enough liquidity",
      "Silo USDC borrow liquidity is material",
      "fork simulation extracts positive value from this exact Silo market",
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  console.log(`Falcon/Silo PT route: acceptedVsPublicBps=${economics.acceptedVsPublicBps === null ? "null" : economics.acceptedVsPublicBps.toFixed(2)} usdcLiquidityUsd=${economics.usdcLiquidityUsd.toFixed(2)} routePositive=${artifact.summary.routePositive}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
