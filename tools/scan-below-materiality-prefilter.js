#!/usr/bin/env node
// scan-below-materiality-prefilter.js - cheap read-only route prefilter for sub-threshold public targets.
// Public APIs/RPC only. Never reads rpc_endpoints.txt, env files, private keys, or signed-action inputs.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "below-materiality-prefilter.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "below-materiality-prefilter-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const ETH_RPC = "https://ethereum.publicnode.com";
const BASE_RPC = "https://base.publicnode.com";
const AVAX_RPC = "https://avalanche.publicnode.com";
const MATERIAL_USD = Number(process.env.BELOW_MATERIALITY_PREFILTER_MATERIAL_USD || "10000000");
const BORROW_MATERIAL_USD = Number(process.env.BELOW_MATERIALITY_PREFILTER_BORROW_MATERIAL_USD || "10000000");
const MAX_JOIN_MATCHES = Number(process.env.BELOW_MATERIALITY_PREFILTER_MAX_JOIN_MATCHES || "24");
const LOG_CHUNK = Number(process.env.BELOW_MATERIALITY_PREFILTER_LOG_CHUNK || "50000");
const FIRA_FROM_BLOCK = Number(process.env.BELOW_MATERIALITY_PREFILTER_FIRA_FROM_BLOCK || "23000000");

const FIRA = {
  fixed: "0x280ddD897F39C33fEf1CbF863B386Cb9a8e53a0e",
  variable: "0xc8Db629192a96D6840e88a8451F17655880A2e4D",
  legacyUzr: "0xa428723eE8ffD87088C36121d72100B43F11fb6A",
  usd0: "0x73A15FeD60Bf67631dC6cd7Bc5B6e8da8190aCF5",
  bUsd0: "0x35D8949372D46B7a3D5A56006AE77B215fc69bC0",
  fwUsdc: "0x62F5366C9E21A95326C461a098a408e034e017b3",
  uzrOracle: "0x30Da78355FcEA04D1fa34AF3c318BE203C6F2145",
  uzrIrm: "0xdfCF197B0B65066183b04B88d50ACDC0C4b01385",
  uzrWhitelist: "0xFE7C47895eDb12a990b311Df33B90Cfea1D44c24",
};
const ZEEBU_ZBU_BASE = "0x2C8C89C442436CC6C0A77943E09C8DAF49DA3161";
const BLACKHOLE = {
  factory: "0x512eb749541B7cf294be882D636218c84a5e9E5F",
  wavax: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
  usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  blacklisted: "0xD9C5A9b5Fe4006CD0fce1f4020BeB9020cbcc6F1",
};

const CONSUMER_ARTIFACTS = [
  "reports/raw/fast/consumer-first-high-ltv-collateral.json",
  "reports/raw/fast/aave-euler-silo-consumer-graph.json",
  "reports/raw/fast/erc4626-consumer-joiner.json",
  "reports/raw/fast/rwa-nav-consumer-graph.json",
  "reports/raw/fast/centrifuge-nav-consumer-graph.json",
  "reports/raw/fast/pendle-pt-multichain-consumer-graph.json",
  "reports/raw/fast/curve-llamalend-phase0.json",
  "reports/raw/fast/morpho-high-apy-liquidation-routes.json",
  "reports/raw/fast/public-lead-consumer-joins.json",
];

const CREATE_MARKET = new ethers.Interface([
  "event CreateMarket(bytes32 indexed id,(address loanToken,address collateralToken,address oracle,address irm,uint256 ltv,uint256 lltv,address whitelist) marketParams)",
]);
const MARKET_ABI = [
  "function market((address loanToken,address collateralToken,address oracle,address irm,uint256 ltv,uint256 lltv,address whitelist) marketParams) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
];
const BLACKHOLE_FACTORY_ABI = ["function allPairsLength() view returns (uint256)", "function allPairs(uint256) view returns (address)"];
const PAIR_ABI = ["function token0() view returns (address)", "function token1() view returns (address)", "function getReserves() view returns (uint112,uint112,uint32)", "function totalSupply() view returns (uint256)"];
const ERC20_ABI = ["function symbol() view returns (string)", "function name() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)"];
const BYTES32_ABI = ["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"];

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const text = readText(file).replace(/^\uFEFF/, ""); return text ? JSON.parse(text) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function unitsToNumber(value, decimals = 18) { try { const n = Number(ethers.formatUnits(toBig(value), Number(decimals ?? 18))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`; }
function safeText(value, max = 160) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function uniq(items) { return [...new Set((items || []).filter(Boolean))]; }

async function tryCall(fn, fallback = null) {
  try { return await fn(); } catch (_) { return fallback; }
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-below-materiality-prefilter/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function decodeBytes32(value) {
  try { return value && value !== "0x" ? safeText(ethers.decodeBytes32String(value), 80) : null; } catch (_) { return null; }
}

async function tokenMeta(provider, token, fallback = {}) {
  const addr = normalizeAddress(token);
  if (!addr) return { address: null, symbol: fallback.symbol || null, name: fallback.name || null, decimals: fallback.decimals ?? 18 };
  const erc = new ethers.Contract(addr, ERC20_ABI, provider);
  const b32 = new ethers.Contract(addr, BYTES32_ABI, provider);
  const [symbol, symbol32, name, name32, decimals, totalSupply] = await Promise.all([
    tryCall(() => erc.symbol(), null),
    tryCall(() => b32.symbol(), null),
    tryCall(() => erc.name(), null),
    tryCall(() => b32.name(), null),
    tryCall(() => erc.decimals(), fallback.decimals ?? 18),
    tryCall(() => erc.totalSupply(), null),
  ]);
  return {
    address: addr,
    symbol: safeText(symbol || decodeBytes32(symbol32) || fallback.symbol || "UNK", 32),
    name: safeText(name || decodeBytes32(name32) || fallback.name || "", 96),
    decimals: Number(decimals ?? fallback.decimals ?? 18),
    totalSupplyRaw: totalSupply?.toString?.() || null,
  };
}

async function llamaPrices(chainAddressPairs) {
  const keys = uniq(chainAddressPairs.map((x) => `${x.chain}:${normalizeAddress(x.address)}`).filter((x) => !/null$/i.test(x))).slice(0, 80);
  if (!keys.length) return {};
  const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.join(",")}`, 20_000);
  const out = {};
  for (const [key, row] of Object.entries(json?.coins || {})) out[key.toLowerCase()] = asNumber(row?.price);
  return out;
}

async function dexScreener(chainSlug, token) {
  const addr = normalizeAddress(token);
  if (!addr) return null;
  const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, 12_000);
  const rows = (json?.pairs || [])
    .filter((p) => String(p?.chainId || "").toLowerCase() === chainSlug)
    .map((p) => ({
      dexId: safeText(p.dexId, 40),
      pairAddress: normalizeAddress(p.pairAddress),
      baseSymbol: safeText(p.baseToken?.symbol, 32),
      quoteSymbol: safeText(p.quoteToken?.symbol, 32),
      priceUsd: round(p.priceUsd, 10),
      liquidityUsd: round(p.liquidity?.usd, 2),
      volume24hUsd: round(p.volume?.h24, 2),
    }))
    .sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  return rows[0] || null;
}

function discoveryRows() {
  const json = readJson(PUBLIC_TARGETS, {});
  return [
    ...(json.phase0Queue || []),
    ...(json.protocolCandidates || []),
    ...(json.yieldCandidates || []),
    ...(json.targetedRefreshQueue || []),
    ...(json.consumerJoinFirst || []),
  ];
}

async function protocolMetadata(slug, fallbackRow = {}) {
  const live = await fetchJson(`https://api.llama.fi/protocol/${slug}`, 30_000);
  const tvlSeries = Array.isArray(live?.tvl) ? live.tvl : [];
  const latestTvl = tvlSeries.length ? tvlSeries[tvlSeries.length - 1]?.totalLiquidityUSD : null;
  return {
    name: live?.name || fallbackRow.name || fallbackRow.project || slug,
    slug,
    category: live?.category || fallbackRow.category || null,
    tvlUsd: round(latestTvl ?? fallbackRow.tvlUsd, 2),
    borrowedUsd: round(live?.currentChainTvls?.borrowed ?? live?.currentChainTvls?.["Ethereum-borrowed"] ?? live?.borrowed, 2),
    chains: live?.chains || fallbackRow.chains || [fallbackRow.chain].filter(Boolean),
    url: live?.url || null,
    twitter: live?.twitter || null,
    tvlCodePath: live?.tvlCodePath || null,
    audits: live?.audit_links || live?.audits || fallbackRow.audits || [],
  };
}

async function getLogsChunked(provider, address, fromBlock, toBlock, topics) {
  const rows = [];
  const chunks = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK + 1) {
    chunks.push([start, Math.min(toBlock, start + LOG_CHUNK)]);
  }
  for (const [from, to] of chunks) {
    const logs = await tryCall(() => provider.getLogs({ address, fromBlock: from, toBlock: to, topics }), []);
    for (const log of logs) rows.push(log);
  }
  return { rows, chunks: chunks.length };
}

function marketParamsFromLog(log) {
  const decoded = CREATE_MARKET.decodeEventLog("CreateMarket", log.data, log.topics);
  const id = decoded.id?.toString?.() || decoded[0]?.toString?.() || null;
  const p = decoded.marketParams || decoded[1];
  const params = [p.loanToken ?? p[0], p.collateralToken ?? p[1], p.oracle ?? p[2], p.irm ?? p[3], p.ltv ?? p[4], p.lltv ?? p[5], p.whitelist ?? p[6]];
  return {
    id,
    params: params.map((x, i) => i < 4 || i === 6 ? normalizeAddress(x) : toBig(x).toString()),
  };
}

function stableFallback(symbol) {
  return ["USDC", "USDT", "DAI", "USD0", "BUSD0", "CRVUSD", "FRXUSD"].includes(String(symbol || "").toUpperCase()) ? 1 : null;
}

async function scanFira(discoveryRow) {
  const metadata = await protocolMetadata("fira", discoveryRow);
  const provider = new ethers.JsonRpcProvider(ETH_RPC);
  const latest = await provider.getBlockNumber();
  const topic = CREATE_MARKET.getEvent("CreateMarket").topicHash;
  const marketContracts = [FIRA.fixed, FIRA.variable];
  const discovered = [];
  let chunksScanned = 0;
  for (const target of marketContracts) {
    const { rows, chunks } = await getLogsChunked(provider, target, FIRA_FROM_BLOCK, latest, [topic]);
    chunksScanned += chunks;
    for (const log of rows) {
      const decoded = marketParamsFromLog(log);
      discovered.push({ target: normalizeAddress(target), id: decoded.id, params: decoded.params, blockNumber: log.blockNumber });
    }
  }
  discovered.push({
    target: FIRA.legacyUzr,
    id: "legacy-uzr-static",
    params: [FIRA.usd0, FIRA.bUsd0, FIRA.uzrOracle, FIRA.uzrIrm, "880000000000000000", "999900000000000000", FIRA.uzrWhitelist].map((x) => normalizeAddress(x) || x),
    blockNumber: null,
  });

  const seen = new Set();
  const markets = [];
  for (const row of discovered) {
    const key = `${lowerAddress(row.target)}:${row.params.join(":").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const market = new ethers.Contract(row.target, MARKET_ABI, provider);
    const data = await tryCall(() => market.market(row.params), null);
    const loan = await tokenMeta(provider, row.params[0], { decimals: 18 });
    const collateral = await tokenMeta(provider, row.params[1], { decimals: 18 });
    markets.push({ ...row, loan, collateral, marketData: data ? {
      totalSupplyAssets: data.totalSupplyAssets?.toString?.() || data[0]?.toString?.() || null,
      totalBorrowAssets: data.totalBorrowAssets?.toString?.() || data[2]?.toString?.() || null,
      lastUpdate: data.lastUpdate?.toString?.() || data[4]?.toString?.() || null,
      fee: data.fee?.toString?.() || data[5]?.toString?.() || null,
    } : null });
  }

  const prices = await llamaPrices(markets.flatMap((m) => [{ chain: "ethereum", address: m.loan.address }, { chain: "ethereum", address: m.collateral.address }]));
  for (const market of markets) {
    const loanPrice = prices[`ethereum:${lowerAddress(market.loan.address)}`] ?? stableFallback(market.loan.symbol);
    const collateralPrice = prices[`ethereum:${lowerAddress(market.collateral.address)}`] ?? stableFallback(market.collateral.symbol);
    const borrowAmount = unitsToNumber(market.marketData?.totalBorrowAssets, market.loan.decimals);
    const supplyAmount = unitsToNumber(market.marketData?.totalSupplyAssets, market.loan.decimals);
    market.loanPriceUsd = round(loanPrice, 10);
    market.collateralPriceUsd = round(collateralPrice, 10);
    market.borrowUsd = round(borrowAmount !== null && loanPrice !== null ? borrowAmount * loanPrice : null, 2);
    market.supplyUsd = round(supplyAmount !== null && loanPrice !== null ? supplyAmount * loanPrice : null, 2);
    market.ltvBps = round(Number(toBig(market.params[4]) * 10000n / 10n ** 18n), 2);
    market.lltvBps = round(Number(toBig(market.params[5]) * 10000n / 10n ** 18n), 2);
    market.dex = await dexScreener("ethereum", market.collateral.address);
  }

  const addresses = uniq([FIRA.fixed, FIRA.variable, FIRA.legacyUzr, FIRA.usd0, FIRA.bUsd0, FIRA.fwUsdc, ...markets.flatMap((m) => [m.loan.address, m.collateral.address, m.params[2]])]);
  const joins = findArtifactJoins(addresses.map((addr) => ({ chain: "Ethereum", address: addr, symbol: markets.find((m) => lowerAddress(m.loan.address) === lowerAddress(addr))?.loan.symbol || markets.find((m) => lowerAddress(m.collateral.address) === lowerAddress(addr))?.collateral.symbol || null })));
  const totalBorrowUsd = round(markets.reduce((acc, m) => acc + (m.borrowUsd || 0), 0), 2);
  const materialBorrowExposure = (metadata.borrowedUsd || totalBorrowUsd || 0) >= BORROW_MATERIAL_USD;
  return {
    id: "fira-prefilter",
    name: "Fira",
    chain: "Ethereum",
    surface: "lending-oracle-liquidation",
    tvlUsd: metadata.tvlUsd,
    borrowedUsd: metadata.borrowedUsd,
    belowTvlMateriality: (metadata.tvlUsd || 0) < MATERIAL_USD,
    materialBorrowExposure,
    fullPhase0Recommended: materialBorrowExposure,
    promotionReason: materialBorrowExposure ? "borrowed-exposure-material-despite-low-tvl" : null,
    routePositive: false,
    watchCandidate: materialBorrowExposure || joins.watchCandidates > 0,
    scanned: { latestBlock: latest, fromBlock: FIRA_FROM_BLOCK, chunksScanned, marketRows: markets.length },
    summary: { totalBorrowUsd, marketsWithBorrow: markets.filter((m) => (m.borrowUsd || 0) > 0).length, maxMarketBorrowUsd: round(Math.max(0, ...markets.map((m) => m.borrowUsd || 0)), 2), joinRows: joins.rows.length, joinWatchCandidates: joins.watchCandidates, joinRoutePositive: joins.routePositive },
    topMarkets: markets.sort((a, b) => (b.borrowUsd || 0) - (a.borrowUsd || 0)).slice(0, 12),
    joins,
    blockers: [
      "Borrowed exposure is material, but this prefilter does not prove borrower-level liquidation state or exact route economics.",
      "Needs full Fira Phase 0 before fork: market/oracle config, borrower sampling, caps/pauses/whitelist, DEX exits, and liquidation math.",
    ],
  };
}

async function scanZeebu(row) {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const token = await tokenMeta(provider, ZEEBU_ZBU_BASE, { symbol: "ZBU", decimals: 18 });
  const dex = await dexScreener("base", token.address);
  const joins = findArtifactJoins([{ chain: "Base", address: token.address, symbol: token.symbol }]);
  const hasMaterialExit = (dex?.liquidityUsd || 0) >= MATERIAL_USD;
  const promote = joins.routePositive > 0 || (joins.watchCandidates > 0 && hasMaterialExit);
  return {
    id: "zeebu-zbu-prefilter",
    name: "Zeebu ZBU",
    chain: "Base",
    surface: "vault-yield-allocator",
    tvlUsd: round(row?.tvlUsd, 2),
    apyPct: round(row?.apyPct, 4),
    belowTvlMateriality: (row?.tvlUsd || 0) < MATERIAL_USD,
    token,
    dex,
    materialConsumerJoin: joins.watchCandidates > 0 || joins.routePositive > 0,
    materialExitLiquidity: hasMaterialExit,
    fullPhase0Recommended: promote,
    promotionReason: promote ? "consumer-join-with-material-exit" : null,
    routePositive: joins.routePositive > 0,
    watchCandidate: joins.watchCandidates > 0,
    joins,
    blockers: promote ? [] : ["ZBU row is below materiality and no existing consumer artifact join or material route-positive exit was found."],
  };
}

async function scanBlackhole(row) {
  const provider = new ethers.JsonRpcProvider(AVAX_RPC);
  const factory = new ethers.Contract(BLACKHOLE.factory, BLACKHOLE_FACTORY_ABI, provider);
  const lengthRaw = await tryCall(() => factory.allPairsLength(), 0n);
  const length = Number(lengthRaw || 0n);
  const wavax = lowerAddress(BLACKHOLE.wavax);
  const usdc = lowerAddress(BLACKHOLE.usdc);
  const matches = [];
  for (let i = 0; i < length; i++) {
    const pairAddr = normalizeAddress(await tryCall(() => factory.allPairs(i), null));
    if (!pairAddr) continue;
    const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
    const [token0, token1, reserves, totalSupply] = await Promise.all([
      tryCall(() => pair.token0(), null),
      tryCall(() => pair.token1(), null),
      tryCall(() => pair.getReserves(), null),
      tryCall(() => pair.totalSupply(), null),
    ]);
    const a = lowerAddress(token0);
    const b = lowerAddress(token1);
    if (!((a === wavax && b === usdc) || (a === usdc && b === wavax))) continue;
    matches.push({
      index: i,
      pair: pairAddr,
      token0: normalizeAddress(token0),
      token1: normalizeAddress(token1),
      reserve0Raw: reserves?.[0]?.toString?.() || null,
      reserve1Raw: reserves?.[1]?.toString?.() || null,
      totalSupplyRaw: totalSupply?.toString?.() || null,
    });
  }
  const dexRows = [];
  for (const pair of matches) {
    const top = await dexScreener("avalanche", pair.pair);
    dexRows.push({ pair: pair.pair, top });
  }
  const joins = findArtifactJoins(matches.map((m) => ({ chain: "Avalanche", address: m.pair, symbol: "Blackhole WAVAX-USDC LP" })));
  const bestLiquidity = Math.max(0, ...dexRows.map((r) => r.top?.liquidityUsd || 0));
  const promote = joins.routePositive > 0 || (joins.watchCandidates > 0 && bestLiquidity >= MATERIAL_USD);
  return {
    id: "blackhole-clmm-prefilter",
    name: "blackhole-clmm WAVAX-USDC",
    chain: "Avalanche",
    surface: "vault-yield-allocator",
    tvlUsd: round(row?.tvlUsd, 2),
    apyPct: round(row?.apyPct, 4),
    belowTvlMateriality: (row?.tvlUsd || 0) < MATERIAL_USD,
    factory: BLACKHOLE.factory,
    factoryPairs: length,
    matchingPairs: matches,
    dexRows,
    materialExitLiquidity: bestLiquidity >= MATERIAL_USD,
    fullPhase0Recommended: promote,
    promotionReason: promote ? "lp-consumer-join-with-material-exit" : null,
    routePositive: joins.routePositive > 0,
    watchCandidate: joins.watchCandidates > 0,
    joins,
    blockers: promote ? [] : ["WAVAX/USDC are common assets and no Blackhole LP consumer route-positive join was found for the matched pair."],
  };
}

function contextSummary(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const fields = ["id", "protocol", "chain", "chainId", "consumerType", "side", "symbol", "pair", "assetSymbol", "collateralSymbol", "borrowSymbol", "ltv", "lltv", "liquidityUsd", "cashUsd", "borrowCashUsd", "routeLiquidityUsd", "maxDexLiquidityUsd", "maxBorrowCashUsd", "bestNetEdgeUsd", "bestNetUsd", "routePositive", "watchCandidate", "signedActionJustified"];
  const out = {};
  for (const field of fields) if (obj[field] !== undefined && typeof obj[field] !== "object") out[field] = safeText(obj[field], 120);
  if (Array.isArray(obj.blockers)) out.blockers = obj.blockers.slice(0, 2).map((x) => safeText(x, 120));
  return out;
}

function ctxRoutePositive(ctx) { return ctx.routePositive === true || ctx.routePositive === "true" || ctx.routePositive === 1 || ctx.routePositive === "1"; }
function ctxWatch(ctx) { return ctxRoutePositive(ctx) || ctx.watchCandidate === true || ctx.watchCandidate === "true" || ctx.watchCandidate === 1 || ctx.watchCandidate === "1"; }
function ctxLiquidity(ctx) { return Math.max(asNumber(ctx.liquidityUsd) || 0, asNumber(ctx.cashUsd) || 0, asNumber(ctx.borrowCashUsd) || 0, asNumber(ctx.routeLiquidityUsd) || 0, asNumber(ctx.maxDexLiquidityUsd) || 0, asNumber(ctx.maxBorrowCashUsd) || 0); }

function findArtifactJoins(tokens) {
  const wanted = tokens.map((t) => ({ ...t, addressLower: lowerAddress(t.address) })).filter((t) => t.addressLower);
  const rows = [];
  const loaded = [];
  for (const rel of CONSUMER_ARTIFACTS) {
    const data = readJson(path.join(WORKSPACE, rel), null);
    if (!data) continue;
    loaded.push(rel);
    const counts = new Map(wanted.map((t) => [t.addressLower, 0]));
    function walk(value, objectPath, parent) {
      if (typeof value === "string") {
        const lower = lowerAddress(value);
        if (!lower || !counts.has(lower) || counts.get(lower) >= MAX_JOIN_MATCHES) return;
        const ctx = contextSummary(parent);
        if (!Object.keys(ctx).length) return;
        const token = wanted.find((t) => t.addressLower === lower);
        rows.push({
          source: rel,
          token: { chain: token.chain, address: token.address, symbol: token.symbol || null },
          path: objectPath,
          context: ctx,
          routePositive: ctxRoutePositive(ctx),
          watchCandidate: ctxWatch(ctx),
          maxContextLiquidityUsd: round(ctxLiquidity(ctx), 2),
        });
        counts.set(lower, counts.get(lower) + 1);
        return;
      }
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) walk(value[i], `${objectPath}[${i}]`, parent);
        return;
      }
      for (const [key, child] of Object.entries(value)) walk(child, objectPath ? `${objectPath}.${key}` : key, value);
    }
    walk(data, "", null);
  }
  rows.sort((a, b) => (b.routePositive - a.routePositive) || (b.watchCandidate - a.watchCandidate) || ((b.maxContextLiquidityUsd || 0) - (a.maxContextLiquidityUsd || 0)));
  return {
    artifactsLoaded: loaded,
    rows: rows.slice(0, 80),
    joinedRows: rows.length,
    watchCandidates: rows.filter((row) => row.watchCandidate && !row.routePositive).length,
    routePositive: rows.filter((row) => row.routePositive).length,
    maxContextLiquidityUsd: round(Math.max(0, ...rows.map((row) => row.maxContextLiquidityUsd || 0)), 2),
  };
}

function renderReport(artifact) {
  const rows = artifact.targetRows.map((row) => `| ${row.name} | ${row.chain} | ${formatUsd(row.tvlUsd)} | ${formatUsd(row.borrowedUsd || row.summary?.totalBorrowUsd)} | ${row.fullPhase0Recommended ? "yes" : "no"} | ${row.routePositive ? "yes" : "no"} | ${row.promotionReason || row.blockers?.[0] || "none"} |`).join("\n");
  return `# \uD83D\uDFE2 DORMANT - Below-Materiality Prefilter Triage

Generated: ${artifact.generatedAt}

Scanner: \`${artifact.scanner}\`

Artifact: \`reports/raw/fast/below-materiality-prefilter.json\`

## Result

No below-materiality row is route-positive or executable from this prefilter. Fira is promoted to a full Phase 0 candidate because borrowed exposure is material despite low TVL; Zeebu ZBU and blackhole-clmm remain cheap-watch only.

## Summary

| Metric | Value |
|---|---:|
| Targets considered | ${artifact.summary.targetsConsidered} |
| Full Phase 0 promotions | ${artifact.summary.fullPhase0Promotions} |
| Route-positive rows | ${artifact.summary.routePositive} |
| Executable now | ${artifact.summary.executableNow} |
| Signed action justified | ${artifact.summary.signedActionJustified} |

## Target Rows

| Target | Chain | TVL | Borrowed / Debt Context | Promote Full Phase 0 | Route Positive | Reason |
|---|---|---:|---:|---:|---:|---|
${rows}

## Next Step

Start Fira full Phase 0 before Republic Note because the prefilter found material borrowed exposure. Do not build executors unless a later artifact finds exact-positive economics and fork proof.
`;
}

async function main() {
  const rows = discoveryRows();
  const firaRow = rows.find((row) => row.slug === "fira" || row.name === "Fira");
  const zeebuRow = rows.find((row) => row.project === "zeebu" && row.symbol === "ZBU");
  const blackholeRow = rows.find((row) => row.project === "blackhole-clmm" && row.symbol === "WAVAX-USDC");

  const targetRows = [];
  targetRows.push(await scanFira(firaRow || {}));
  targetRows.push(await scanZeebu(zeebuRow || {}));
  targetRows.push(await scanBlackhole(blackholeRow || {}));

  const routePositive = targetRows.filter((row) => row.routePositive).length;
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-below-materiality-prefilter.js",
    scope: "Cheap read-only route prefilter for below-materiality public queue rows: Fira, Zeebu ZBU, blackhole-clmm WAVAX-USDC",
    safety: {
      publicApisOnlyForMetadata: true,
      publicRpcOnly: true,
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      calldataStored: false,
      borrowerAddressesStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    thresholds: { materialUsd: MATERIAL_USD, borrowMaterialUsd: BORROW_MATERIAL_USD, firaFromBlock: FIRA_FROM_BLOCK },
    summary: {
      targetsConsidered: targetRows.length,
      belowTvlTargets: targetRows.filter((row) => row.belowTvlMateriality).length,
      materialBorrowExposureTargets: targetRows.filter((row) => row.materialBorrowExposure).length,
      fullPhase0Promotions: targetRows.filter((row) => row.fullPhase0Recommended).length,
      watchCandidates: targetRows.filter((row) => row.watchCandidate && !row.routePositive).length,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      nextFullPhase0Target: targetRows.find((row) => row.fullPhase0Recommended)?.name || "Republic Note",
    },
    targetRows,
    blockers: [
      "No below-materiality row has exact-positive route economics or fork proof.",
      "Fira is promoted because borrowed exposure is material, not because this prefilter proves an executable route.",
    ],
    requiredForRoutePositive: [
      "specific target token/share/LP joins a material trusted consumer or borrower state",
      "borrow, liquidation, redemption, or exit liquidity is live and exact-quoted positive after costs",
      "fork extraction proof",
    ],
    nextReadOnlyStep: "Run full Fira Phase 0 before Republic Note; keep Zeebu and blackhole-clmm on cheap-watch unless a consumer join or exact-positive trigger appears.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, renderReport(artifact));
  if (!QUIET) console.log(`belowMaterialityPrefilter targets=${artifact.summary.targetsConsidered} promotions=${artifact.summary.fullPhase0Promotions} routePositive=${artifact.summary.routePositive} next=${artifact.summary.nextFullPhase0Target}`);
}

main().catch((err) => {
  console.error(`belowMaterialityPrefilter error: ${err.message}`);
  process.exitCode = 1;
});
