#!/usr/bin/env node
// Read-only Pendle YT-as-collateral consumer scanner.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "pendle-yt-collateral-routes.json");

const HIGH_LTV = path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json");
const AES_GRAPH = path.join(WORKSPACE, "reports", "raw", "fast", "aave-euler-silo-consumer-graph.json");

const MIN_LIQUIDITY_USD = Number(process.env.PENDLE_YT_MIN_LIQUIDITY_USD || "10000");
const MAX_MARKETS_PER_CHAIN = Number(process.env.PENDLE_YT_MAX_MARKETS_PER_CHAIN || "200");

const CHAINS = {
  1: { name: "Ethereum", aavePool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" },
  10: { name: "Optimism", aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" },
  56: { name: "BNB Chain" },
  137: { name: "Polygon", aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" },
  8453: { name: "Base", aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" },
  42161: { name: "Arbitrum", aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" },
  130: { name: "Unichain" },
};

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

function round(value, decimals = 6) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
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
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcPool(chainIds) {
  const wanted = new Set(chainIds.map(Number));
  const pool = {};
  for (const url of loadRpcUrls()) {
    try {
      const idHex = await rpcCall(url, "eth_chainId", [], 6000);
      const chainId = Number(BigInt(idHex));
      if (wanted.has(chainId) && !pool[chainId]) pool[chainId] = url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return pool;
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

async function tokenMeta(provider, address, fallback = {}) {
  const token = normalizeAddress(address);
  if (!token || !provider) return { address: token, addressLower: token?.toLowerCase() || null, symbol: fallback.symbol || null, decimals: fallback.decimals ?? 18 };
  const [symbolRaw, decimalsRaw] = await Promise.all([
    safeCall(provider, token, ERC20.encodeFunctionData("symbol", [])),
    safeCall(provider, token, ERC20.encodeFunctionData("decimals", [])),
  ]);
  return {
    address: token,
    addressLower: token.toLowerCase(),
    symbol: decodeString(symbolRaw, "symbol") || fallback.symbol || null,
    decimals: Number(decode(decimalsRaw, ERC20, "decimals")?.[0] ?? fallback.decimals ?? 18),
  };
}

async function fetchPendleMarkets(chainId, provider) {
  const json = await fetchJson(`https://api-v2.pendle.finance/core/v1/${chainId}/markets/active`, { timeoutMs: 30_000 }).catch(() => ({ markets: [] }));
  const markets = Array.isArray(json?.markets) ? json.markets.slice(0, MAX_MARKETS_PER_CHAIN) : [];
  const producers = [];
  for (const market of markets) {
    const yt = pendleAddress(market.yt);
    if (!yt) continue;
    const sy = pendleAddress(market.sy);
    const meta = await tokenMeta(provider, yt, { symbol: `YT-${market.name || yt.slice(0, 8)}` }).catch(() => ({ address: yt, addressLower: yt.toLowerCase(), symbol: `YT-${market.name || yt.slice(0, 8)}`, decimals: 18 }));
    const syMeta = sy ? await tokenMeta(provider, sy).catch(() => ({ symbol: null, decimals: 18 })) : { symbol: null, decimals: 18 };
    producers.push({
      protocol: "Pendle",
      category: "yield-token",
      chain: CHAINS[chainId]?.name || String(chainId),
      chainId,
      marketName: market.name || null,
      market: normalizeAddress(market.address),
      yt,
      address: yt,
      addressLower: yt.toLowerCase(),
      symbol: meta.symbol || `YT-${market.name || yt.slice(0, 8)}`,
      decimals: meta.decimals ?? 18,
      pt: pendleAddress(market.pt),
      sy,
      sySymbol: syMeta.symbol || null,
      syDecimals: Number(syMeta.decimals ?? 18),
      underlyingAsset: pendleAddress(market.underlyingAsset),
      expiry: market.expiry || null,
      liquidityUsdHint: Number(market.details?.liquidity || 0),
      impliedApy: Number(market.details?.impliedApy || 0) || null,
      blocker: "YT collateral requires exact decay/oracle/acquisition economics before fork",
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

async function fetchMorphoConsumers(chainId, producers, fieldName) {
  if (!producers.length) return [];
  const query = `query($chainIds:[Int!]!, $assets:[String!]!) {
    markets(first:100, orderBy:SupplyAssetsUsd, orderDirection:Desc,
      where:{chainId_in:$chainIds, ${fieldName}:$assets}) { items { ${morphoFields()} } }
  }`;
  const assets = producers.map((p) => p.addressLower);
  const rows = [];
  for (let i = 0; i < assets.length; i += 50) {
    rows.push(...await morphoQuery(query, { chainIds: [chainId], assets: assets.slice(i, i + 50) }).catch(() => []));
  }
  return rows;
}

function morphoLltvRatio(value) {
  try { return Number(BigInt(String(value || 0))) / 1e18; } catch (_) { return Number(value || 0); }
}

function classifyMatch(producer, protocol, side, market, extraBlockers = []) {
  const ltv = Number(market.ltv ?? market.lltv ?? market.maxLtv ?? 0);
  const liquidityUsd = Number(market.otherReserveCashUsd ?? market.liquidityAssetsUsd ?? market.oppositeLiquidityUsd ?? market.cashUsd ?? market.routeLiquidityUsd ?? 0);
  const collateralLike = /collateral|reserveAsset|priceSource|silo|oracle/i.test(side);
  const reviewCandidate = collateralLike && ltv > 0 && liquidityUsd >= MIN_LIQUIDITY_USD;
  return {
    protocol,
    chainId: producer.chainId,
    chain: producer.chain,
    side,
    producer,
    market,
    ltv,
    liquidityUsd: round(liquidityUsd, 6),
    reviewCandidate,
    watchCandidate: reviewCandidate,
    routePositive: false,
    blockers: [
      reviewCandidate ? "YT is collateral/oracle-side with material borrow liquidity; needs exact decay/acquisition/fork proof" : null,
      producer.blocker,
      ltv <= 0 ? "Collateral LTV disabled or unconfirmed" : null,
      liquidityUsd < MIN_LIQUIDITY_USD ? "Route-side liquidity below threshold or unpriced" : null,
      ...extraBlockers,
      "No exact YT acquisition/exit economics or fork proof",
    ].filter(Boolean),
  };
}

async function scanMorpho(producers) {
  const rows = [];
  const stats = {};
  for (const chainId of [...new Set(producers.map((p) => p.chainId))]) {
    const chainProducers = producers.filter((p) => p.chainId === chainId);
    const byAddr = new Map(chainProducers.map((p) => [p.addressLower, p]));
    const [collateral, loan] = await Promise.all([
      fetchMorphoConsumers(chainId, chainProducers, "collateralAssetAddress_in"),
      fetchMorphoConsumers(chainId, chainProducers, "loanAssetAddress_in"),
    ]);
    stats[chainId] = { collateralMatches: collateral.length, loanMatches: loan.length };
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
      }, ["YT is loan asset, not collateral-side overvaluation route"]));
    }
  }
  return { rows, stats };
}

async function scanAave(provider, chainId, producers) {
  const chain = CHAINS[chainId];
  if (!provider || !chain?.aavePool || !producers.length) return { rows: [], stats: { reservesScanned: 0, priceSourcesScanned: 0 } };
  const byAddr = new Map(producers.map((p) => [p.addressLower, p]));
  const reservesRaw = await safeCall(provider, chain.aavePool, AAVE_POOL_IFACE.encodeFunctionData("getReservesList", []));
  const reserves = (decode(reservesRaw, AAVE_POOL_IFACE, "getReservesList")?.[0] || []).map(normalizeAddress).filter(Boolean);
  const providerRaw = await safeCall(provider, chain.aavePool, AAVE_POOL_IFACE.encodeFunctionData("ADDRESSES_PROVIDER", []));
  const addressesProvider = normalizeAddress(decode(providerRaw, AAVE_POOL_IFACE, "ADDRESSES_PROVIDER")?.[0]);
  const oracleRaw = addressesProvider ? await safeCall(provider, addressesProvider, AAVE_ADDRESSES_PROVIDER.encodeFunctionData("getPriceOracle", [])) : null;
  const priceOracle = normalizeAddress(decode(oracleRaw, AAVE_ADDRESSES_PROVIDER, "getPriceOracle")?.[0]);
  const metas = [];
  for (const reserve of reserves) {
    const [dataRaw, symRaw] = await Promise.all([
      safeCall(provider, chain.aavePool, AAVE_POOL_IFACE.encodeFunctionData("getReserveData", [reserve])),
      safeCall(provider, reserve, ERC20.encodeFunctionData("symbol", [])),
    ]);
    if (!dataRaw || dataRaw === "0x") continue;
    const cfg = decodeAaveConfig(BigInt(wordAt(dataRaw, 0) || 0n));
    const aToken = normalizeAddress(addressWordAt(dataRaw, 8) || addressWordAt(dataRaw, 9));
    const cashRaw = aToken ? decode(await safeCall(provider, reserve, ERC20.encodeFunctionData("balanceOf", [aToken])), ERC20, "balanceOf")?.[0] || 0n : 0n;
    const sourceRaw = priceOracle ? await safeCall(provider, priceOracle, AAVE_ORACLE.encodeFunctionData("getSourceOfAsset", [reserve])) : null;
    const priceSource = normalizeAddress(decode(sourceRaw, AAVE_ORACLE, "getSourceOfAsset")?.[0]);
    const cash = formatUnitsNumber(cashRaw, cfg.decimals || 18);
    metas.push({ reserve, symbol: decodeString(symRaw, "symbol"), aToken, priceOracle, priceSource, cashRaw: cashRaw.toString(), cash, cashUsd: null, ...cfg });
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

function scanHighLtvArtifact(producers) {
  const byKey = new Map(producers.map((p) => [`${p.chainId}:${p.addressLower}`, p]));
  const artifact = readJson(HIGH_LTV, { results: [] });
  const rows = [];
  for (const result of artifact.results || []) {
    const chainId = Number(result.chainId);
    for (const row of result.highLtvRowsDetail || result.topRows || []) {
      const collateral = lowerAddress(row.collateral?.address || row.consumer?.collateralAsset?.address);
      const borrow = lowerAddress(row.borrowAsset?.address || row.consumer?.loanAsset?.address);
      const collateralProducer = collateral ? byKey.get(`${chainId}:${collateral}`) : null;
      const borrowProducer = borrow ? byKey.get(`${chainId}:${borrow}`) : null;
      if (collateralProducer) rows.push(classifyMatch(collateralProducer, row.protocol || "consumer-first", "collateralAsset", { ...row, ltv: row.ltv, routeLiquidityUsd: row.routeLiquidityUsd }));
      if (borrowProducer) rows.push(classifyMatch(borrowProducer, row.protocol || "consumer-first", "borrowAsset", { ...row, ltv: row.ltv, routeLiquidityUsd: row.routeLiquidityUsd }, ["YT is borrow asset, not collateral-side overvaluation route"]));
    }
  }
  return { rows, stats: { highLtvRowsRead: artifact.summary?.highLtvRows || 0 } };
}

function scanAesArtifact(producers) {
  const byKey = new Map(producers.map((p) => [`${p.chainId}:${p.addressLower}`, p]));
  const artifact = readJson(AES_GRAPH, { results: [] });
  const rows = [];
  const collect = (items) => {
    const list = Array.isArray(items)
      ? items
      : items && typeof items === "object"
        ? Object.values(items).flatMap((value) => Array.isArray(value) ? value : [])
        : [];
    for (const item of list) {
      const chainId = Number(item.chainId || item.chain?.id || item.market?.chainId || 0);
      const addresses = [item.producer?.address, item.collateral?.address, item.market?.collateral, item.market?.asset, item.asset?.address].map(lowerAddress).filter(Boolean);
      for (const address of addresses) {
        const producer = byKey.get(`${chainId}:${address}`);
        if (producer) rows.push(classifyMatch(producer, item.protocol || item.consumerProtocol || "Aave/Euler/Silo", item.side || item.matchType || "artifactReference", item, ["Artifact reference requires live consumer-specific validation"]));
      }
    }
  };
  collect(artifact.matches);
  for (const result of artifact.results || []) collect(result.matches || result.rows || []);
  return { rows, stats: { resultsRead: artifact.results?.length || 0 } };
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = [row.protocol, row.chainId, row.side, row.producer?.addressLower, row.market?.marketId || row.market?.consumer?.evault || row.market?.reserve || row.market?.id || ""].join(":").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const chainIds = Object.keys(CHAINS).map(Number);
  const rpcs = await resolveRpcPool(chainIds);
  const providers = new Map(Object.entries(rpcs).map(([chainId, rpc]) => [Number(chainId), new ethers.JsonRpcProvider(rpc, Number(chainId), { staticNetwork: true })]));
  const producers = [];
  const chainStats = {};
  for (const chainId of chainIds) {
    const provider = providers.get(chainId) || null;
    const chainProducers = await fetchPendleMarkets(chainId, provider);
    chainStats[chainId] = { chain: CHAINS[chainId].name, rpcResolved: Boolean(provider), ytProducers: chainProducers.length };
    producers.push(...chainProducers);
  }
  const [morpho, highLtv, aes] = await Promise.all([
    scanMorpho(producers),
    Promise.resolve(scanHighLtvArtifact(producers)),
    Promise.resolve(scanAesArtifact(producers)),
  ]);
  const aaveRows = [];
  const aaveStats = {};
  for (const chainId of chainIds) {
    const provider = providers.get(chainId);
    const chainProducers = producers.filter((p) => p.chainId === chainId);
    const result = await scanAave(provider, chainId, chainProducers).catch(() => ({ rows: [], stats: { reservesScanned: 0, priceSourcesScanned: 0 } }));
    aaveRows.push(...result.rows);
    aaveStats[chainId] = result.stats;
  }
  const matches = dedupeRows([...morpho.rows, ...aaveRows, ...highLtv.rows, ...aes.rows]);
  matches.sort((a, b) => Number(b.watchCandidate) - Number(a.watchCandidate) || Number(b.liquidityUsd || 0) - Number(a.liquidityUsd || 0));
  const reviewCandidates = matches.filter((row) => row.reviewCandidate).length;
  const watchCandidates = matches.filter((row) => row.watchCandidate).length;
  const routePositive = 0;
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-pendle-yt-collateral.js",
    scope: "Read-only Pendle yield-token-as-collateral consumer scan across live Morpho/Aave and reusable consumer artifacts",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    thresholds: { minLiquidityUsd: MIN_LIQUIDITY_USD, maxMarketsPerChain: MAX_MARKETS_PER_CHAIN },
    sourceArtifacts: {
      consumerFirstHighLtv: "reports/raw/fast/consumer-first-high-ltv-collateral.json",
      aaveEulerSiloConsumerGraph: "reports/raw/fast/aave-euler-silo-consumer-graph.json",
    },
    chains: chainStats,
    summary: {
      chainsScanned: chainIds.length,
      chainsWithRpc: providers.size,
      ytProducers: producers.length,
      matches: matches.length,
      reviewCandidates,
      watchCandidates,
      routePositive,
      signedActionJustified: false,
      byProtocol: matches.reduce((acc, row) => { acc[row.protocol] = (acc[row.protocol] || 0) + 1; return acc; }, {}),
      morphoStats: morpho.stats,
      aaveStats,
      highLtvStats: highLtv.stats,
      aesStats: aes.stats,
    },
    producers: producers.slice(0, 300),
    matches,
    topRows: matches.slice(0, 25),
    requiredForRoutePositive: [
      "YT is accepted as collateral or oracle input by a lending consumer",
      "consumer has live borrow-side liquidity above gas/slippage threshold",
      "YT acquisition and unwind/decay economics are exact-quoted",
      "fork proof extracts positive net value before any signed action",
    ],
    nextReadOnlyStep: watchCandidates > 0
      ? "Build exact YT acquisition/borrow/unwind economics for the top collateral-side match, then fork-test only if net-positive."
      : "Keep YT branch closed until a lending market lists a Pendle YT as collateral or oracle input with material borrow liquidity.",
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  console.log(`Pendle YT collateral scan: producers=${producers.length} matches=${matches.length} watch=${watchCandidates} routePositive=0`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
