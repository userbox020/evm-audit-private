#!/usr/bin/env node
// Read-only Pendle PT consumer graph scanner.
// Resolves RPC URLs in memory only and never prints or stores endpoints.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "pendle-pt-consumer-graph.json");
const SILO_PT_ARTIFACT = path.join(WORKSPACE, "reports", "raw", "fast", "silo-pt-oracle-routes.json");

const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const ROUTE_LIQUIDITY_USD = Number(process.env.PENDLE_PT_ROUTE_LIQUIDITY_USD || "10000");
const GAS_UNITS = Number(process.env.PENDLE_PT_ROUTE_GAS_UNITS || "1600000");
const SLIPPAGE_BPS = Number(process.env.PENDLE_PT_ROUTE_SLIPPAGE_BPS || "100");
const QUOTE_ITERATIONS = Number(process.env.PENDLE_PT_QUOTE_ITERATIONS || "24");

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const AAVE_POOL_IFACE = new ethers.Interface([
  "function ADDRESSES_PROVIDER() view returns (address)",
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns (tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
]);
const AAVE_ADDRESSES_PROVIDER = new ethers.Interface(["function getPriceOracle() view returns (address)"]);
const AAVE_ORACLE = new ethers.Interface(["function getSourceOfAsset(address asset) view returns (address)"]);
const MORPHO_ORACLE = new ethers.Interface(["function price() view returns (uint256)"]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function lowerAddress(value) {
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
}

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function pendleAddress(value) {
  const raw = String(value || "");
  const part = raw.includes("-") ? raw.split("-").pop() : raw;
  return normalizeAddress(part);
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

async function safeCall(provider, to, data) {
  try { return await provider.call({ to, data }); } catch (_) { return null; }
}

function decode(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}

function decodeString(raw, fn) {
  return decode(raw, ERC20, fn)?.[0]?.toString() || null;
}

function wordAt(raw, index) {
  const hex = strip0x(raw);
  const start = index * 64;
  if (!hex || hex.length < start + 64) return null;
  return `0x${hex.slice(start, start + 64)}`;
}

function addressFromWord(raw) {
  if (!raw || raw === "0x") return null;
  const hex = strip0x(raw).padStart(64, "0");
  if (/^0+$/.test(hex)) return null;
  return normalizeAddress(`0x${hex.slice(-40)}`);
}

function addressWordAt(raw, index) {
  const word = wordAt(raw, index);
  return word ? addressFromWord(word) : null;
}

function decodeAaveConfig(rawData) {
  const raw = BigInt(rawData || 0n);
  const mask16 = 0xffffn;
  return {
    ltv: Number(raw & mask16) / 10_000,
    liquidationThreshold: Number((raw >> 16n) & mask16) / 10_000,
    decimals: Number((raw >> 48n) & 0xffn),
    active: Boolean((raw >> 56n) & 1n),
    frozen: Boolean((raw >> 57n) & 1n),
    borrowingEnabled: Boolean((raw >> 58n) & 1n),
    paused: Boolean((raw >> 60n) & 1n),
  };
}

function formatUnitsNumber(raw, decimals) {
  try { return Number(ethers.formatUnits(raw || 0n, Number(decimals || 18))); } catch (_) { return null; }
}

function decimalToUnits(value, decimals) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0 || decimals === null || decimals === undefined) return null;
  const places = Math.min(Number(decimals), 18);
  const fixed = Number(value).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: places });
  try { return ethers.parseUnits(fixed, Number(decimals)); } catch (_) { return null; }
}

function bpsDiff(reference, observed) {
  const ref = Number(reference || 0);
  const obs = Number(observed || 0);
  if (!Number.isFinite(ref) || !Number.isFinite(obs) || ref <= 0 || obs <= 0) return null;
  return ((obs / ref) - 1) * 10_000;
}

async function tokenMeta(provider, address) {
  const token = normalizeAddress(address);
  const [symbolRaw, decimalsRaw] = await Promise.all([
    safeCall(provider, token, ERC20.encodeFunctionData("symbol", [])),
    safeCall(provider, token, ERC20.encodeFunctionData("decimals", [])),
  ]);
  return {
    address: token,
    addressLower: token?.toLowerCase() || null,
    symbol: decodeString(symbolRaw, "symbol"),
    decimals: Number(decode(decimalsRaw, ERC20, "decimals")?.[0] ?? 18n),
  };
}

async function fetchPrices(addresses) {
  const keys = [...new Set(addresses.map(normalizeAddress).filter(Boolean).map((address) => `ethereum:${address.toLowerCase()}`))];
  const out = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.slice(i, i + 50).join(",")}?searchWidth=6h`, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    for (const [key, row] of Object.entries(json.coins || {})) out.set(key.split(":").pop().toLowerCase(), Number(row.price || 0));
  }
  return out;
}

async function fetchEthPrice() {
  const json = await fetchJson("https://coins.llama.fi/prices/current/coingecko:ethereum", { timeoutMs: 20_000 }).catch(() => null);
  return Number(json?.coins?.["coingecko:ethereum"]?.price || 0) || null;
}

async function quotePendleMarketOrder(marketAddress, syInRaw) {
  const market = normalizeAddress(marketAddress);
  if (!market || syInRaw <= 0n) return null;
  return fetchJson("https://api-v2.pendle.finance/core/v3/limit-orders/market-order", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: 1, type: 0, netFromTaker: syInRaw.toString(), market }),
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
  if (!highQuote) return { ok: false, reason: "Pendle quote could not satisfy target PT amount" };
  let best = { syInRaw: high, quote: highQuote };
  for (let i = 0; i < QUOTE_ITERATIONS; i++) {
    const mid = (low + high) / 2n;
    if (mid <= low) break;
    const quote = await quotePendleMarketOrder(marketAddress, mid).catch(() => null);
    if (quote && marketOrderPtOutRaw(quote) >= targetPtRaw) {
      high = mid;
      best = { syInRaw: mid, quote };
    } else {
      low = mid;
    }
  }
  return { ok: true, ...best };
}

async function fetchPendleMarkets(provider) {
  const json = await fetchJson("https://api-v2.pendle.finance/core/v1/1/markets/active", { timeoutMs: 30_000 });
  const markets = Array.isArray(json?.markets) ? json.markets : [];
  const producers = [];
  for (const market of markets) {
    const pt = pendleAddress(market.pt);
    if (!pt) continue;
    const sy = pendleAddress(market.sy);
    const meta = await tokenMeta(provider, pt).catch(() => ({ address: pt, addressLower: pt.toLowerCase(), symbol: null, decimals: null }));
    const syMeta = sy ? await tokenMeta(provider, sy).catch(() => ({ symbol: null, decimals: 18 })) : { symbol: null, decimals: 18 };
    producers.push({
      protocol: "Pendle",
      category: "principal-token",
      chain: "Ethereum",
      chainId: 1,
      marketName: market.name || null,
      market: normalizeAddress(market.address),
      pt,
      address: pt,
      addressLower: pt.toLowerCase(),
      symbol: meta.symbol || `PT-${market.name || pt.slice(0, 8)}`,
      decimals: meta.decimals,
      yt: pendleAddress(market.yt),
      sy,
      sySymbol: syMeta.symbol,
      syDecimals: Number(syMeta.decimals ?? 18),
      underlyingAsset: pendleAddress(market.underlyingAsset),
      expiry: market.expiry || null,
      liquidityUsdHint: Number(market.details?.liquidity || 0),
      impliedApy: Number(market.details?.impliedApy || 0) || null,
      currentAnomaly: false,
      blocker: "No current PT producer anomaly or consumer-specific positive economics",
    });
  }
  return producers;
}

async function morphoQuery(query, variables) {
  const json = await fetchJson("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    timeoutMs: 30_000,
  });
  if (json.errors) throw new Error(json.errors[0]?.message || "Morpho GraphQL error");
  return json.data?.markets?.items || [];
}

function morphoFields() {
  return `
    marketId
    loanAsset { symbol address decimals }
    collateralAsset { symbol address decimals }
    oracle { address }
    lltv
    state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization }
  `;
}

async function fetchMorphoConsumers(producers, fieldName) {
  const query = `query($chainIds:[Int!]!, $assets:[String!]!) {
    markets(first:100, orderBy:SupplyAssetsUsd, orderDirection:Desc,
      where:{chainId_in:$chainIds, ${fieldName}:$assets}) { items { ${morphoFields()} } }
  }`;
  const assets = producers.map((p) => p.addressLower);
  const rows = [];
  for (let i = 0; i < assets.length; i += 50) {
    rows.push(...await morphoQuery(query, { chainIds: [1], assets: assets.slice(i, i + 50) }).catch(() => []));
  }
  return rows;
}

function morphoLltvRatio(value) {
  try { return Number(BigInt(String(value || 0))) / 1e18; } catch (_) { return Number(value || 0); }
}

function classifyMatch(producer, protocol, side, market, extraBlockers = []) {
  const ltv = Number(market.ltv ?? market.lltv ?? market.maxLtv ?? 0);
  const liquidityUsd = Number(market.otherReserveCashUsd ?? market.liquidityAssetsUsd ?? market.oppositeLiquidityUsd ?? market.cashUsd ?? 0);
  const collateralLike = /collateral|reserveAsset|priceSource|silo/i.test(side);
  const reviewCandidate = collateralLike && ltv > 0 && liquidityUsd >= ROUTE_LIQUIDITY_USD;
  return {
    protocol,
    side,
    producer,
    market,
    reviewCandidate,
    watchCandidate: false,
    routePositive: false,
    blockers: [
      reviewCandidate ? "Needs consumer-specific oracle/economics proof before fork" : null,
      producer.blocker,
      ltv <= 0 ? "Collateral LTV disabled or unconfirmed" : null,
      liquidityUsd < ROUTE_LIQUIDITY_USD ? "Route-side liquidity below threshold or unpriced" : null,
      ...extraBlockers,
    ].filter(Boolean),
  };
}

async function scanMorpho(producers) {
  const byAddr = new Map(producers.map((p) => [p.addressLower, p]));
  const [collateral, loan] = await Promise.all([
    fetchMorphoConsumers(producers, "collateralAssetAddress_in"),
    fetchMorphoConsumers(producers, "loanAssetAddress_in"),
  ]);
  const rows = [];
  for (const market of collateral) {
    const producer = byAddr.get(lowerAddress(market.collateralAsset?.address));
    if (!producer) continue;
    rows.push(classifyMatch(producer, "Morpho Blue", "collateralAsset", {
      marketId: market.marketId,
      loanAsset: market.loanAsset,
      collateralAsset: market.collateralAsset,
      oracle: market.oracle,
      lltv: morphoLltvRatio(market.lltv),
      liquidityAssetsUsd: Number(market.state?.liquidityAssetsUsd || 0),
      borrowAssetsUsd: Number(market.state?.borrowAssetsUsd || 0),
      supplyAssetsUsd: Number(market.state?.supplyAssetsUsd || 0),
    }));
  }
  for (const market of loan) {
    const producer = byAddr.get(lowerAddress(market.loanAsset?.address));
    if (!producer) continue;
    rows.push(classifyMatch(producer, "Morpho Blue", "loanAsset", {
      marketId: market.marketId,
      loanAsset: market.loanAsset,
      collateralAsset: market.collateralAsset,
      oracle: market.oracle,
      lltv: morphoLltvRatio(market.lltv),
      liquidityAssetsUsd: Number(market.state?.liquidityAssetsUsd || 0),
      borrowAssetsUsd: Number(market.state?.borrowAssetsUsd || 0),
      supplyAssetsUsd: Number(market.state?.supplyAssetsUsd || 0),
    }, ["PT is loan asset, not collateral-side overvaluation route"]));
  }
  return { rows, stats: { collateralMatches: collateral.length, loanMatches: loan.length } };
}

async function scanAave(provider, producers) {
  const byAddr = new Map(producers.map((p) => [p.addressLower, p]));
  const reservesRaw = await safeCall(provider, AAVE_POOL, AAVE_POOL_IFACE.encodeFunctionData("getReservesList", []));
  const reserves = (decode(reservesRaw, AAVE_POOL_IFACE, "getReservesList")?.[0] || []).map(normalizeAddress).filter(Boolean);
  const providerRaw = await safeCall(provider, AAVE_POOL, AAVE_POOL_IFACE.encodeFunctionData("ADDRESSES_PROVIDER", []));
  const addressesProvider = normalizeAddress(decode(providerRaw, AAVE_POOL_IFACE, "ADDRESSES_PROVIDER")?.[0]);
  const oracleRaw = addressesProvider ? await safeCall(provider, addressesProvider, AAVE_ADDRESSES_PROVIDER.encodeFunctionData("getPriceOracle", [])) : null;
  const priceOracle = normalizeAddress(decode(oracleRaw, AAVE_ADDRESSES_PROVIDER, "getPriceOracle")?.[0]);
  const prices = await fetchPrices(reserves);
  const metas = [];
  for (const reserve of reserves) {
    const [dataRaw, symRaw] = await Promise.all([
      safeCall(provider, AAVE_POOL, AAVE_POOL_IFACE.encodeFunctionData("getReserveData", [reserve])),
      safeCall(provider, reserve, ERC20.encodeFunctionData("symbol", [])),
    ]);
    if (!dataRaw || dataRaw === "0x") continue;
    const cfg = decodeAaveConfig(BigInt(wordAt(dataRaw, 0) || 0n));
    const aToken = normalizeAddress(addressWordAt(dataRaw, 8) || addressWordAt(dataRaw, 9));
    const cashRaw = aToken ? decode(await safeCall(provider, reserve, ERC20.encodeFunctionData("balanceOf", [aToken])), ERC20, "balanceOf")?.[0] || 0n : 0n;
    const sourceRaw = priceOracle ? await safeCall(provider, priceOracle, AAVE_ORACLE.encodeFunctionData("getSourceOfAsset", [reserve])) : null;
    const priceSource = normalizeAddress(decode(sourceRaw, AAVE_ORACLE, "getSourceOfAsset")?.[0]);
    const cash = formatUnitsNumber(cashRaw, cfg.decimals || 18);
    metas.push({ reserve, symbol: decodeString(symRaw, "symbol"), aToken, priceOracle, priceSource, cashRaw: cashRaw.toString(), cash, cashUsd: cash * Number(prices.get(reserve.toLowerCase()) || 0), ...cfg });
  }
  const borrowableCashUsd = metas.filter((m) => m.active && !m.paused && m.borrowingEnabled).reduce((sum, m) => sum + Number(m.cashUsd || 0), 0);
  const rows = [];
  for (const meta of metas) {
    const producer = byAddr.get(meta.reserve.toLowerCase());
    if (producer) rows.push(classifyMatch(producer, "Aave V3", "reserveAsset", { ...meta, otherReserveCashUsd: Math.max(0, borrowableCashUsd - Number(meta.cashUsd || 0)) }));
  }
  const producersByNeedle = producers.map((p) => ({ producer: p, needle: strip0x(p.addressLower) }));
  for (const meta of metas.filter((m) => m.priceSource)) {
    const code = await provider.getCode(meta.priceSource).catch(() => "0x");
    const lowerCode = strip0x(code).toLowerCase();
    for (const { producer, needle } of producersByNeedle) {
      if (needle && lowerCode.includes(needle)) rows.push(classifyMatch(producer, "Aave V3", "priceSourceBytecodeReference", { ...meta, otherReserveCashUsd: Math.max(0, borrowableCashUsd - Number(meta.cashUsd || 0)) }, ["Bytecode reference needs source-level oracle confirmation"]));
    }
  }
  return { rows, stats: { reservesScanned: metas.length, priceSourcesScanned: metas.filter((m) => m.priceSource).length } };
}

function scanSiloArtifact(producers) {
  const byAddr = new Map(producers.map((p) => [p.addressLower, p]));
  const artifact = readJson(SILO_PT_ARTIFACT, { rows: [] });
  const rows = [];
  for (const row of artifact.rows || []) {
    const producer = byAddr.get(lowerAddress(row.ptToken));
    if (!producer) continue;
    rows.push(classifyMatch(producer, "Silo V3", "siloPtCollateral", {
      id: row.id,
      config: row.config,
      maxLtv: row.silo?.ptSide?.maxLtv || 0,
      liquidationThreshold: row.silo?.ptSide?.liquidationThreshold || 0,
      oppositeLiquidityUsd: row.economics?.oppositeLiquidityUsd || 0,
      netEdgeUsd: row.economics?.netEdgeUsd ?? null,
      acceptedVsAcquisitionBps: row.economics?.acceptedVsAcquisitionBps ?? null,
      executablePendleQuote: Boolean(row.economics?.executablePendleQuote),
      routePositive: Boolean(row.routePositive),
    }, [row.routePositive ? null : "Latest Silo PT scanner is not route-positive"]));
  }
  return { rows, stats: { siloRowsRead: artifact.rows?.length || 0 } };
}

async function enrichMorphoRouteEconomics(provider, matches, prices, gasUsd) {
  for (const row of matches.filter((m) => m.protocol === "Morpho Blue" && m.side === "collateralAsset" && m.reviewCandidate)) {
    const producer = row.producer;
    const oracleAddress = normalizeAddress(row.market?.oracle?.address);
    const loanAsset = normalizeAddress(row.market?.loanAsset?.address);
    const loanDecimals = Number(row.market?.loanAsset?.decimals ?? 18);
    const collateralDecimals = Number(row.market?.collateralAsset?.decimals ?? producer.decimals ?? 18);
    const syDecimals = Number(producer.syDecimals ?? 18);
    const lltv = Number(row.market?.lltv || 0);
    const borrowCapacityUsd = Number(row.market?.liquidityAssetsUsd || 0);
    const loanPriceUsd = loanAsset ? Number(prices.get(loanAsset.toLowerCase()) || 0) : 0;
    const syPriceUsd = Number(producer.syPriceUsd || producer.underlyingPriceUsd || 0);
    const oracleRaw = oracleAddress
      ? decode(await safeCall(provider, oracleAddress, MORPHO_ORACLE.encodeFunctionData("price", [])), MORPHO_ORACLE, "price")?.[0] || null
      : null;

    const onePtRaw = 10n ** BigInt(collateralDecimals);
    const loanPerPtRaw = oracleRaw ? (onePtRaw * BigInt(oracleRaw)) / (10n ** 36n) : null;
    const loanPerPt = loanPerPtRaw === null ? null : Number(ethers.formatUnits(loanPerPtRaw, loanDecimals));
    const acceptedUsdPerPt = loanPerPt !== null && loanPriceUsd > 0 ? loanPerPt * loanPriceUsd : null;
    const ptRequiredForFullBorrow = acceptedUsdPerPt && lltv > 0 ? borrowCapacityUsd / (acceptedUsdPerPt * lltv) : null;
    const targetPtRaw = decimalToUnits(ptRequiredForFullBorrow, collateralDecimals);
    const publicPtUsd = Number(producer.ptPriceUsd || 0) || null;
    const publicEstimateSy = publicPtUsd && syPriceUsd > 0 && ptRequiredForFullBorrow ? (ptRequiredForFullBorrow * publicPtUsd) / syPriceUsd : null;
    const estimateSyRaw = decimalToUnits(publicEstimateSy, syDecimals);
    const quote = targetPtRaw && estimateSyRaw ? await findSyInForPtOut(producer.market, targetPtRaw, estimateSyRaw) : null;
    const requestedSyInRaw = quote?.ok ? quote.syInRaw : null;
    const actualSyInRaw = quote?.ok ? (() => { try { return BigInt(quote.quote?.totalTrade?.netFromTaker || "0"); } catch (_) { return 0n; } })() : null;
    const actualPtOutRaw = quote?.ok ? marketOrderPtOutRaw(quote.quote) : 0n;
    const syInRaw = actualSyInRaw && actualSyInRaw > 0n ? actualSyInRaw : null;
    const syIn = syInRaw ? Number(ethers.formatUnits(syInRaw, syDecimals)) : null;
    const acquisitionCostUsd = syIn !== null && syPriceUsd > 0 ? syIn * syPriceUsd : null;
    const quoteAcquisitionUsdPerPt = acquisitionCostUsd !== null && ptRequiredForFullBorrow ? acquisitionCostUsd / ptRequiredForFullBorrow : null;
    const acceptedVsAcquisitionBps = bpsDiff(quoteAcquisitionUsdPerPt ?? publicPtUsd, acceptedUsdPerPt);
    const ltvBreakEvenPremiumBps = lltv > 0 ? ((1 / lltv) - 1) * 10_000 : null;
    const gasBpsAtCapacity = gasUsd && borrowCapacityUsd > 0 ? gasUsd / borrowCapacityUsd * 10_000 : null;
    const requiredPremiumBps = ltvBreakEvenPremiumBps === null ? null : ltvBreakEvenPremiumBps + SLIPPAGE_BPS + Number(gasBpsAtCapacity || 0);
    const slippageUsd = borrowCapacityUsd * SLIPPAGE_BPS / 10_000;
    const grossEdgeUsd = acquisitionCostUsd === null ? null : borrowCapacityUsd - acquisitionCostUsd;
    const netEdgeUsd = grossEdgeUsd === null ? null : grossEdgeUsd - Number(gasUsd || 0) - slippageUsd;
    const quoteOk = Boolean(quote?.ok && syInRaw && actualPtOutRaw >= targetPtRaw && acquisitionCostUsd !== null);
    const hasBreakEvenPremium = acceptedVsAcquisitionBps !== null && requiredPremiumBps !== null && acceptedVsAcquisitionBps >= requiredPremiumBps;
    const routePositive = Boolean(quoteOk && hasBreakEvenPremium && netEdgeUsd !== null && netEdgeUsd > 0);

    row.market.morphoOracleEconomics = {
      oracle: oracleAddress,
      oraclePriceRaw: oracleRaw?.toString() || null,
      loanPerPtRaw: loanPerPtRaw?.toString() || null,
      loanPerPt,
      loanPriceUsd,
      acceptedUsdPerPt,
      publicPtUsd,
      quoteAcquisitionUsdPerPt,
      acceptedVsAcquisitionBps,
      lltv,
      ltvBreakEvenPremiumBps,
      requiredPremiumBps,
      borrowCapacityUsd,
      ptRequiredForFullBorrow,
      targetPtRaw: targetPtRaw?.toString() || null,
      syPriceUsd,
      syDecimals,
      requestedSyInRaw: requestedSyInRaw?.toString() || null,
      syInRaw: syInRaw?.toString() || null,
      actualPtOutRaw: actualPtOutRaw ? actualPtOutRaw.toString() : null,
      syIn,
      acquisitionCostUsd,
      grossEdgeUsd,
      gasUsd,
      gasBpsAtCapacity,
      slippageUsd,
      netEdgeUsd,
      quoteSource: quoteOk ? "Pendle limit-order market-order quote-only endpoint" : null,
      quoteTotalTrade: quote?.ok ? quote.quote?.totalTrade || null : null,
      quoteOk,
      routePositive,
      blockers: [
        oracleRaw ? null : "Morpho oracle price unavailable",
        loanPriceUsd > 0 ? null : "loan asset USD price unavailable",
        syPriceUsd > 0 ? null : "SY/underlying USD price unavailable",
        quoteOk ? null : (quote?.reason || "Pendle size-specific acquisition quote unavailable"),
        hasBreakEvenPremium ? null : "accepted PT value below LLTV break-even premium",
        netEdgeUsd !== null && netEdgeUsd > 0 ? null : "full-liquidity net edge is not positive",
      ].filter(Boolean),
    };
    row.routePositive = routePositive;
    row.blockers = row.market.morphoOracleEconomics.blockers.length ? row.market.morphoOracleEconomics.blockers : ["Fork proof still required before any signed action"];
  }
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rpc = await resolveEthereumRpc();
  if (!rpc) throw new Error("Ethereum RPC unavailable from local inventory");
  const provider = new ethers.JsonRpcProvider(rpc);
  const [block, feeData, ethPriceUsd] = await Promise.all([
    provider.getBlock("latest"),
    provider.getFeeData(),
    fetchEthPrice(),
  ]);
  const gasUsd = feeData.gasPrice && ethPriceUsd ? Number(ethers.formatEther(feeData.gasPrice * BigInt(GAS_UNITS))) * Number(ethPriceUsd) : null;
  const producers = await fetchPendleMarkets(provider);
  const prices = await fetchPrices(producers.flatMap((p) => [p.pt, p.sy, p.underlyingAsset]));
  for (const producer of producers) {
    producer.ptPriceUsd = prices.get(producer.pt.toLowerCase()) || null;
    producer.syPriceUsd = producer.sy ? prices.get(producer.sy.toLowerCase()) || null : null;
    producer.underlyingPriceUsd = producer.underlyingAsset ? prices.get(producer.underlyingAsset.toLowerCase()) || null : null;
  }
  const [morpho, aave] = await Promise.all([scanMorpho(producers), scanAave(provider, producers)]);
  const silo = scanSiloArtifact(producers);
  const extraLoanPrices = morpho.rows.map((r) => r.market?.loanAsset?.address).filter(Boolean);
  const loanPrices = await fetchPrices(extraLoanPrices);
  for (const [address, price] of loanPrices.entries()) prices.set(address, price);
  const matches = [...silo.rows, ...morpho.rows, ...aave.rows].sort((a, b) => Number(b.reviewCandidate) - Number(a.reviewCandidate) || Number(b.market?.oppositeLiquidityUsd || b.market?.liquidityAssetsUsd || b.market?.otherReserveCashUsd || 0) - Number(a.market?.oppositeLiquidityUsd || a.market?.liquidityAssetsUsd || a.market?.otherReserveCashUsd || 0));
  await enrichMorphoRouteEconomics(provider, matches, prices, gasUsd);
  matches.sort((a, b) => Number(b.routePositive) - Number(a.routePositive) || Number(b.reviewCandidate) - Number(a.reviewCandidate) || Number(b.market?.morphoOracleEconomics?.netEdgeUsd ?? -1e18) - Number(a.market?.morphoOracleEconomics?.netEdgeUsd ?? -1e18));
  const reviewCandidates = matches.filter((m) => m.reviewCandidate);
  const routePositive = matches.filter((m) => m.routePositive);
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-pendle-pt-consumer-graph.js",
    scope: "Read-only Ethereum Pendle PT consumer graph across Silo, Morpho, and Aave",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive.length > 0,
      signedActionJustified: false,
    },
    block: { number: block.number, timestamp: Number(block.timestamp), iso: new Date(Number(block.timestamp) * 1000).toISOString() },
    thresholds: { routeLiquidityUsd: ROUTE_LIQUIDITY_USD },
    gas: { gasPriceWei: feeData.gasPrice?.toString() || null, ethPriceUsd, gasUnits: GAS_UNITS, gasUsd, slippageBps: SLIPPAGE_BPS },
    summary: {
      producers: producers.length,
      matches: matches.length,
      protocolCounts: matches.reduce((acc, row) => { acc[row.protocol] = (acc[row.protocol] || 0) + 1; return acc; }, {}),
      reviewCandidates: reviewCandidates.length,
      watchCandidates: matches.filter((m) => m.watchCandidate).length,
      routePositive: routePositive.length,
      signedActionJustified: false,
      morphoOraclePricedReviews: matches.filter((m) => m.market?.morphoOracleEconomics).length,
      morphoExecutableQuotes: matches.filter((m) => m.market?.morphoOracleEconomics?.quoteOk).length,
      topReview: reviewCandidates.slice(0, 8).map((m) => `${m.protocol}:${m.side}:${m.producer.symbol}`),
      topByNetEdge: matches.filter((m) => m.market?.morphoOracleEconomics).slice(0, 8).map((m) => ({
        protocol: m.protocol,
        symbol: m.producer.symbol,
        loan: m.market.loanAsset?.symbol,
        lltv: m.market.lltv,
        acceptedVsAcquisitionBps: m.market.morphoOracleEconomics.acceptedVsAcquisitionBps,
        requiredPremiumBps: m.market.morphoOracleEconomics.requiredPremiumBps,
        netEdgeUsd: m.market.morphoOracleEconomics.netEdgeUsd,
        routePositive: m.routePositive,
      })),
      stats: { silo: silo.stats, morpho: morpho.stats, aave: aave.stats },
    },
    producers,
    matches,
    nextRoutePositiveCriteria: [
      "PT is accepted as collateral by a consumer with material borrow-side liquidity",
      "Consumer oracle accepts a PT value above live executable Pendle acquisition cost after LTV, gas, and slippage",
      "Exact executable acquisition/exit route exists for required PT size",
      "Fork simulation extracts positive value from the exact consumer market",
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(out, jsonReplacer, 2) + "\n");
  console.log(`Pendle PT consumer graph: producers=${out.summary.producers} matches=${out.summary.matches} review=${out.summary.reviewCandidates} routePositive=${out.summary.routePositive}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
