#!/usr/bin/env node
// scan-flux-finance-phase0.js - bounded read-only Flux Finance Phase 0 scan.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, calldata, borrower addresses, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpcPool, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "flux-finance-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "flux-finance-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_BANNER = "\uD83D\uDFE2 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";
const MATERIAL_USD = Number(process.env.FLUX_FINANCE_PHASE0_MATERIAL_USD || "10000");
const HIGH_CF_BPS = Number(process.env.FLUX_FINANCE_PHASE0_HIGH_CF_BPS || "7500");
const DIVERGENCE_WATCH_BPS = Number(process.env.FLUX_FINANCE_PHASE0_DIVERGENCE_WATCH_BPS || "100");
const STALE_WARN_SECONDS = Number(process.env.FLUX_FINANCE_PHASE0_STALE_WARN_SECONDS || "86400");
const RECENT_BORROW_LOG_BLOCKS = Number(process.env.FLUX_FINANCE_PHASE0_RECENT_BORROW_LOG_BLOCKS || "50000");
const BORROW_LOG_CHUNK_BLOCKS = Number(process.env.FLUX_FINANCE_PHASE0_BORROW_LOG_CHUNK_BLOCKS || "5000");
const MAX_BORROWERS = Number(process.env.FLUX_FINANCE_PHASE0_MAX_BORROWERS || "80");
const MAX_LOCAL_ARTIFACT_BYTES = Number(process.env.FLUX_FINANCE_PHASE0_MAX_LOCAL_ARTIFACT_BYTES || "2500000");

const FLUX = {
  chain: "Ethereum",
  chainId: 1,
  comptroller: "0x95Af143a021DF745bc78e845b54591C53a8B3A51",
  markets: {
    fUSDC: "0x465a5a630482f3abD6d3b84B39B29b07214d19e5",
    fUSDT: "0x81994b9607e06ab3d5cF3AffF9a67374f05F27d7",
    fFRAX: "0x1C9A2d6b33B4826757273D47ebEe0e2DddcD978B",
    fDAI: "0xe2bA8693cE7474900A045757fe0efCa900F6530b",
  },
  expectedUnderlyings: {
    fUSDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    fUSDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    fFRAX: "0x853d955aCEf822Db058eb8505911ED77F175b99e",
    fDAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  },
  chainlinkFeeds: {
    USDC: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",
    USDT: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D",
    FRAX: "0xB9E1E3A9feFf48998E45Fa90847ed4D467E8BcfD",
    DAI: "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9",
  },
};

const COMPTROLLER_ABI = [
  "function oracle() view returns (address)",
  "function getAllMarkets() view returns (address[])",
  "function markets(address) view returns (bool,uint256,bool)",
  "function closeFactorMantissa() view returns (uint256)",
  "function liquidationIncentiveMantissa() view returns (uint256)",
  "function admin() view returns (address)",
  "function pendingAdmin() view returns (address)",
  "function pauseGuardian() view returns (address)",
  "function borrowCapGuardian() view returns (address)",
  "function comptrollerImplementation() view returns (address)",
  "function pendingComptrollerImplementation() view returns (address)",
  "function borrowCaps(address) view returns (uint256)",
  "function mintGuardianPaused(address) view returns (bool)",
  "function borrowGuardianPaused(address) view returns (bool)",
  "function transferGuardianPaused() view returns (bool)",
  "function seizeGuardianPaused() view returns (bool)",
  "function getAccountLiquidity(address) view returns (uint256,uint256,uint256)",
];

const FTOKEN_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function underlying() view returns (address)",
  "function getCash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function totalReserves() view returns (uint256)",
  "function exchangeRateStored() view returns (uint256)",
  "function reserveFactorMantissa() view returns (uint256)",
  "function borrowIndex() view returns (uint256)",
  "function accrualBlockNumber() view returns (uint256)",
  "function interestRateModel() view returns (address)",
  "function comptroller() view returns (address)",
  "function admin() view returns (address)",
  "function pendingAdmin() view returns (address)",
  "function implementation() view returns (address)",
];

const ORACLE_ABI = [
  "function getUnderlyingPrice(address cToken) view returns (uint256)",
  "function assetPrices(address asset) view returns (uint256)",
  "function owner() view returns (address)",
  "function admin() view returns (address)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
];

const FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
];

const BORROW_EVENT = new ethers.Interface(["event Borrow(address borrower,uint256 borrowAmount,uint256 accountBorrows,uint256 totalBorrows)"]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`; }
function formatPctBps(value) { const n = asNumber(value); return n === null ? "n/a" : `${round(n / 100, 2)}%`; }
function formatBps(value) { const n = asNumber(value); return n === null ? "n/a" : `${round(n, 2)}bps`; }
function safeText(value, max = 120) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function unitsToNumber(value, decimals = 18) { try { const n = Number(ethers.formatUnits(toBig(value), Number(decimals))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function wadBps(value) { try { return Number((toBig(value) * 10000n) / 10n ** 18n); } catch (_) { return null; } }
function hexBlock(n) { return `0x${Number(n).toString(16)}`; }

async function tryCall(fn, fallback = null) {
  try { return await fn(); } catch (_) { return fallback; }
}

async function fetchJson(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-flux-finance-phase0/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function safeCode(provider, address) {
  const addr = normalizeAddress(address);
  if (!addr) return "0x";
  return await tryCall(() => provider.getCode(addr), "0x");
}

async function addressKind(provider, address) {
  const addr = normalizeAddress(address);
  if (!addr || addr === ZERO) return "zero";
  const code = await safeCode(provider, addr);
  return code && code !== "0x" ? "contract" : "eoa";
}

async function tokenMeta(provider, token, fallback = {}) {
  const addr = normalizeAddress(token);
  if (!addr) return { address: null, symbol: fallback.symbol || null, name: fallback.name || null, decimals: fallback.decimals ?? 18 };
  const c = new ethers.Contract(addr, ERC20_ABI, provider);
  const [symbol, name, decimals] = await Promise.all([
    tryCall(() => c.symbol(), fallback.symbol || null),
    tryCall(() => c.name(), fallback.name || null),
    tryCall(() => c.decimals(), fallback.decimals ?? 18),
  ]);
  return {
    address: addr,
    symbol: safeText(symbol || fallback.symbol || "UNK", 32),
    name: safeText(name || fallback.name || "", 80),
    decimals: Number(decimals ?? fallback.decimals ?? 18),
  };
}

function compoundOracleUsd(raw, underlyingDecimals) {
  if (raw === null || raw === undefined) return null;
  const decimals = 36 - Number(underlyingDecimals ?? 18);
  try {
    const n = Number(ethers.formatUnits(toBig(raw), decimals));
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

async function feedInfo(provider, feedAddr, latestTimestamp) {
  const addr = normalizeAddress(feedAddr);
  if (!addr || addr === ZERO) return null;
  const f = new ethers.Contract(addr, FEED_ABI, provider);
  const [decimals, description, roundData] = await Promise.all([
    tryCall(() => f.decimals(), null),
    tryCall(() => f.description(), null),
    tryCall(() => f.latestRoundData(), null),
  ]);
  const feedDecimals = decimals === null ? null : Number(decimals);
  const answerRaw = roundData ? roundData[1] : null;
  const answer = feedDecimals === null || answerRaw === null ? null : unitsToNumber(answerRaw, feedDecimals);
  const updatedAt = roundData ? Number(roundData[3]) : null;
  return {
    address: addr,
    description: safeText(description || "", 80),
    decimals: feedDecimals,
    answer: round(answer, 10),
    answerRaw: answerRaw?.toString?.() || null,
    updatedAt,
    ageSeconds: updatedAt && latestTimestamp ? Math.max(0, Number(latestTimestamp) - updatedAt) : null,
  };
}

async function dexScreenerPrice(token) {
  const addr = normalizeAddress(token);
  if (!addr) return null;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const json = await res.json();
    const pairs = (json.pairs || []).filter((p) => String(p.chainId).toLowerCase() === "ethereum");
    pairs.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
    const best = pairs[0];
    if (!best || !best.priceUsd) return null;
    return {
      priceUsd: Number(best.priceUsd),
      liquidityUsd: Number(best.liquidity?.usd || 0),
      dexId: safeText(best.dexId, 40),
      pairAddress: normalizeAddress(best.pairAddress) || safeText(best.pairAddress, 80),
    };
  } catch (_) {
    return null;
  }
}

async function latestBlock(provider) {
  const block = await provider.getBlock("latest");
  return { number: Number(block.number), timestamp: Number(block.timestamp) };
}

async function getBorrowLogs(rpc, addresses, fromBlock, toBlock) {
  if (!addresses.length || fromBlock === null || fromBlock > toBlock || RECENT_BORROW_LOG_BLOCKS <= 0) return { logs: [], errors: [] };
  const logs = [];
  const errors = [];
  const topic0 = BORROW_EVENT.getEvent("Borrow").topicHash;
  for (let from = fromBlock; from <= toBlock; from += BORROW_LOG_CHUNK_BLOCKS) {
    const to = Math.min(toBlock, from + BORROW_LOG_CHUNK_BLOCKS - 1);
    const chunk = await rpcCall(rpc, "eth_getLogs", [{ address: addresses, fromBlock: hexBlock(from), toBlock: hexBlock(to), topics: [topic0] }], 25_000).catch(() => null);
    if (Array.isArray(chunk)) logs.push(...chunk);
    else errors.push(`borrow-log-window-unavailable-${from}-${to}`);
  }
  return { logs, errors };
}

async function borrowerRows(rpc, comptroller, marketRows, latest) {
  const addresses = marketRows.map((row) => normalizeAddress(row.fToken)).filter(Boolean);
  const fromBlock = RECENT_BORROW_LOG_BLOCKS > 0 ? Math.max(0, latest.number - RECENT_BORROW_LOG_BLOCKS) : null;
  const logResult = fromBlock === null ? { logs: [], errors: [] } : await getBorrowLogs(rpc, addresses, fromBlock, latest.number);
  const borrowers = [];
  for (const log of logResult.logs) {
    if (borrowers.length >= MAX_BORROWERS) break;
    try {
      const parsed = BORROW_EVENT.parseLog({ topics: log.topics, data: log.data });
      const borrower = normalizeAddress(parsed.args.borrower);
      if (borrower && !borrowers.includes(borrower)) borrowers.push(borrower);
    } catch (_) {}
  }
  const rows = [];
  for (const [idx, borrower] of borrowers.entries()) {
    const liq = await tryCall(() => comptroller.getAccountLiquidity(borrower), null);
    const liquidityUsd = liq ? unitsToNumber(liq[1], 18) : null;
    const shortfallUsd = liq ? unitsToNumber(liq[2], 18) : null;
    rows.push({
      sampleId: `sample-${String(idx + 1).padStart(3, "0")}`,
      liquidityUsd: round(liquidityUsd, 6),
      shortfallUsd: round(shortfallUsd, 6),
      liquidatable: (shortfallUsd || 0) > 0,
      materialLiquidatable: (shortfallUsd || 0) >= MATERIAL_USD,
      routePositive: false,
      blocker: "Anonymized borrower sample is not route-positive without exact repay/seize/exit economics and fork proof",
    });
  }
  rows.sort((a, b) => (asNumber(b.shortfallUsd) || 0) - (asNumber(a.shortfallUsd) || 0));
  return { rows, logsRead: logResult.logs.length, fromBlock, logErrors: logResult.errors };
}

function parseMarket(raw) {
  if (!raw) return { listed: false, collateralFactorBps: 0, comped: false };
  return { listed: Boolean(raw[0]), collateralFactorBps: wadBps(raw[1]), comped: Boolean(raw[2]) };
}

function knownFeedFor(symbol) {
  const key = String(symbol || "").replace(/^f/i, "").toUpperCase();
  return normalizeAddress(FLUX.chainlinkFeeds[key]);
}

async function scanMarket(provider, comptroller, oracle, fToken, expectedLabel, latest) {
  const fAddr = normalizeAddress(fToken);
  const f = new ethers.Contract(fAddr, FTOKEN_ABI, provider);
  const [code, fSymbolRaw, fNameRaw, fDecimalsRaw, underlyingRaw, marketRaw, cashRaw, borrowsRaw, supplyRaw, reservesRaw, exchangeRateRaw, reserveFactorRaw, borrowIndexRaw, accrualRaw, irmRaw, fComptrollerRaw, fAdminRaw, fPendingAdminRaw, fImplRaw, mintPausedRaw, borrowPausedRaw, borrowCapRaw, priceRaw] = await Promise.all([
    safeCode(provider, fAddr),
    tryCall(() => f.symbol(), expectedLabel || null),
    tryCall(() => f.name(), null),
    tryCall(() => f.decimals(), 8),
    tryCall(() => f.underlying(), FLUX.expectedUnderlyings[expectedLabel] || null),
    tryCall(() => comptroller.markets(fAddr), null),
    tryCall(() => f.getCash(), null),
    tryCall(() => f.totalBorrows(), null),
    tryCall(() => f.totalSupply(), null),
    tryCall(() => f.totalReserves(), null),
    tryCall(() => f.exchangeRateStored(), null),
    tryCall(() => f.reserveFactorMantissa(), null),
    tryCall(() => f.borrowIndex(), null),
    tryCall(() => f.accrualBlockNumber(), null),
    tryCall(() => f.interestRateModel(), null),
    tryCall(() => f.comptroller(), null),
    tryCall(() => f.admin(), null),
    tryCall(() => f.pendingAdmin(), null),
    tryCall(() => f.implementation(), null),
    tryCall(() => comptroller.mintGuardianPaused(fAddr), null),
    tryCall(() => comptroller.borrowGuardianPaused(fAddr), null),
    tryCall(() => comptroller.borrowCaps(fAddr), null),
    oracle ? tryCall(() => oracle.getUnderlyingPrice(fAddr), null) : null,
  ]);

  const fSymbol = safeText(fSymbolRaw || expectedLabel || "UNKNOWN", 40);
  const fName = safeText(fNameRaw || "", 80);
  const underlying = normalizeAddress(underlyingRaw);
  const meta = await tokenMeta(provider, underlying, { symbol: fSymbol?.replace(/^f/i, ""), decimals: 18 });
  const market = parseMarket(marketRaw);
  const priceUsd = priceRaw === null ? null : compoundOracleUsd(priceRaw, meta.decimals);
  const cash = cashRaw === null ? null : unitsToNumber(cashRaw, meta.decimals);
  const borrows = borrowsRaw === null ? null : unitsToNumber(borrowsRaw, meta.decimals);
  const feedAddr = knownFeedFor(fSymbol);
  const feed = await feedInfo(provider, feedAddr, latest.timestamp);
  const dex = await dexScreenerPrice(underlying);
  const refPrice = priceUsd ?? feed?.answer ?? dex?.priceUsd ?? null;
  const cashUsd = cash !== null && refPrice !== null ? cash * refPrice : null;
  const borrowsUsd = borrows !== null && refPrice !== null ? borrows * refPrice : null;
  const exchangeRateScale = 18 + Number(meta.decimals || 18) - Number(fDecimalsRaw ?? 8);
  const exchangeRateUnderlying = exchangeRateRaw === null ? null : unitsToNumber(exchangeRateRaw, exchangeRateScale);
  const oracleVsChainlinkBps = priceUsd !== null && feed?.answer ? ((priceUsd - feed.answer) / feed.answer) * 10000 : null;
  const oracleVsDexBps = priceUsd !== null && dex?.priceUsd ? ((priceUsd - dex.priceUsd) / dex.priceUsd) * 10000 : null;
  const maxAbsDivergenceBps = Math.max(0, Math.abs(asNumber(oracleVsChainlinkBps) || 0), Math.abs(asNumber(oracleVsDexBps) || 0));
  const staleButAccepted = Boolean(feed?.ageSeconds !== null && feed?.ageSeconds !== undefined && feed.ageSeconds > STALE_WARN_SECONDS && (priceUsd || 0) > 0);
  const divergent = Boolean(maxAbsDivergenceBps >= DIVERGENCE_WATCH_BPS && ((dex?.liquidityUsd || 0) >= MATERIAL_USD || feed?.answer));
  const borrowCap = borrowCapRaw === null ? null : unitsToNumber(borrowCapRaw, meta.decimals);
  const capReached = borrowCapRaw !== null && toBig(borrowCapRaw) > 0n && toBig(borrowsRaw) >= toBig(borrowCapRaw);
  const mintPaused = mintPausedRaw === null ? null : Boolean(mintPausedRaw);
  const borrowPaused = borrowPausedRaw === null ? null : Boolean(borrowPausedRaw);
  const highCf = (market.collateralFactorBps || 0) >= HIGH_CF_BPS;
  const borrowable = Boolean(market.listed && !borrowPaused && !capReached && (cashUsd || 0) >= MATERIAL_USD && (priceUsd || 0) > 0);
  const watchCandidate = Boolean(borrowable && highCf && (staleButAccepted || divergent));
  const flags = [];
  if (highCf) flags.push("highCF");
  if (mintPaused) flags.push("mintPaused");
  if (borrowPaused) flags.push("borrowPaused");
  if (capReached) flags.push("borrowCapReached");
  if (staleButAccepted) flags.push("staleButAccepted");
  if (divergent) flags.push("oracleReferenceDivergence");
  if (watchCandidate) flags.push("watchCandidate");

  return {
    chain: FLUX.chain,
    chainId: FLUX.chainId,
    comptroller: FLUX.comptroller,
    fToken: fAddr,
    expectedLabel: expectedLabel || null,
    fTokenCodePresent: Boolean(code && code !== "0x"),
    fTokenCodeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    fSymbol,
    fName,
    fDecimals: Number(fDecimalsRaw ?? 8),
    underlying,
    underlyingExpected: normalizeAddress(FLUX.expectedUnderlyings[expectedLabel]),
    underlyingMatchesExpected: lowerAddress(underlying) === lowerAddress(FLUX.expectedUnderlyings[expectedLabel]),
    underlyingSymbol: meta.symbol,
    underlyingDecimals: meta.decimals,
    listed: market.listed,
    collateralFactorBps: market.collateralFactorBps,
    comped: market.comped,
    mintPaused,
    borrowPaused,
    borrowCap,
    capReached,
    cash: round(cash, 8),
    borrows: round(borrows, 8),
    cashUsd: round(cashUsd, 2),
    borrowsUsd: round(borrowsUsd, 2),
    totalSupplyRaw: supplyRaw?.toString?.() || null,
    totalReservesRaw: reservesRaw?.toString?.() || null,
    exchangeRateStoredRaw: exchangeRateRaw?.toString?.() || null,
    exchangeRateUnderlying: round(exchangeRateUnderlying, 12),
    reserveFactorBps: reserveFactorRaw === null ? null : wadBps(reserveFactorRaw),
    borrowIndexRaw: borrowIndexRaw?.toString?.() || null,
    accrualBlockNumber: accrualRaw === null ? null : Number(accrualRaw),
    interestRateModel: normalizeAddress(irmRaw),
    fTokenComptroller: normalizeAddress(fComptrollerRaw),
    fTokenAdmin: normalizeAddress(fAdminRaw),
    fTokenPendingAdmin: normalizeAddress(fPendingAdminRaw),
    fTokenImplementation: normalizeAddress(fImplRaw),
    priceUsd: round(priceUsd, 10),
    priceRaw: priceRaw?.toString?.() || null,
    reference: {
      chainlinkFeed: feed,
      dex,
      oracleVsChainlinkBps: round(oracleVsChainlinkBps, 4),
      oracleVsDexBps: round(oracleVsDexBps, 4),
      maxAbsDivergenceBps: round(maxAbsDivergenceBps, 4),
    },
    staleButAccepted,
    divergent,
    highCf,
    borrowable,
    watchCandidate,
    routePositive: false,
    flags: flags.join(","),
    blocker: watchCandidate
      ? "Watch-only: needs accepted-value divergence plus exact borrow/liquidation/exit economics and fork proof"
      : "No exact positive Flux borrow or liquidation economics proven",
  };
}

function protocolMetadataFromDiscovery() {
  const d = readJson(PUBLIC_TARGETS, {});
  const rows = [...(d.phase0Queue || []), ...(d.targetedRefreshQueue || []), ...(d.protocolCandidates || []), ...(d.consumerJoinFirst || [])];
  const row = rows.find((p) => p?.slug === "flux-finance" || p?.name === "Flux Finance");
  return row ? {
    name: row.name,
    slug: row.slug,
    category: row.category,
    chains: row.chains || [],
    evmChains: row.evmChains || [],
    tvlUsd: row.tvlUsd,
    change1dPct: row.change1dPct,
    change7dPct: row.change7dPct,
    routePriority: row.routePriority || null,
    source: "public-audit-target-discovery",
  } : null;
}

async function protocolMetadata() {
  const local = protocolMetadataFromDiscovery();
  const json = await fetchJson("https://api.llama.fi/protocol/flux-finance");
  const latestTvlRow = Array.isArray(json?.tvl) && json.tvl.length ? json.tvl[json.tvl.length - 1] : null;
  return {
    name: safeText(json?.name, 80) || local?.name || "Flux Finance",
    slug: safeText(json?.slug, 80) || local?.slug || "flux-finance",
    category: safeText(json?.category, 80) || local?.category || "Lending",
    chains: Array.isArray(json?.chains) ? json.chains.map((chain) => safeText(chain, 60)).filter(Boolean) : local?.chains || ["Ethereum"],
    evmChains: local?.evmChains || ["Ethereum"],
    tvlUsd: asNumber(latestTvlRow?.totalLiquidityUSD) || local?.tvlUsd || null,
    change1dPct: asNumber(json?.change_1d) ?? local?.change1dPct ?? null,
    change7dPct: asNumber(json?.change_7d) ?? local?.change7dPct ?? null,
    routePriority: local?.routePriority || null,
    source: json ? "defillama-protocol-api+public-discovery" : local?.source || "fallback-static",
  };
}

function scanLocalArtifactRows() {
  const needles = [
    ...Object.values(FLUX.markets),
    FLUX.comptroller,
    "flux-finance",
    "Flux Finance",
  ].map((v) => String(v).toLowerCase());
  const roots = [path.join(WORKSPACE, "reports"), path.join(WORKSPACE, "targets", "reserve-protocol")];
  const rows = [];
  for (const root of roots) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (/node_modules|cache|artifacts|out|coverage/i.test(entry.name)) continue;
          stack.push(file);
          continue;
        }
        if (!/\.(json|md|ts|sol)$/i.test(entry.name)) continue;
        let stat = null;
        try { stat = fs.statSync(file); } catch (_) { continue; }
        if (stat.size > MAX_LOCAL_ARTIFACT_BYTES) continue;
        const text = readText(file).toLowerCase();
        const hits = needles.filter((needle) => needle && text.includes(needle));
        if (!hits.length) continue;
        rows.push({
          file: path.relative(WORKSPACE, file).replace(/\\/g, "/"),
          hits: hits.length,
          exactAddressHits: hits.filter((hit) => hit.startsWith("0x")).length,
          routePositive: false,
          note: "Local source/artifact hit only; not route-positive without live consumer economics",
        });
      }
    }
  }
  rows.sort((a, b) => b.exactAddressHits - a.exactAddressHits || b.hits - a.hits || a.file.localeCompare(b.file));
  return rows.slice(0, 80);
}

function topRows(rows, filter, sortField, limit = 12) {
  return rows.filter(filter).sort((a, b) => (asNumber(b[sortField]) || 0) - (asNumber(a[sortField]) || 0)).slice(0, limit);
}

function writeReport(out) {
  const s = out.summary;
  const marketTable = topRows(out.marketRows, (row) => row.listed, "cashUsd", 12).map((row) => `| ${row.fSymbol || "n/a"} | ${row.underlyingSymbol || "n/a"} | ${formatPctBps(row.collateralFactorBps)} | ${formatUsd(row.cashUsd)} | ${formatUsd(row.borrowsUsd)} | ${row.borrowPaused ? "yes" : "no"} | ${formatBps(row.reference?.oracleVsChainlinkBps)} | ${formatBps(row.reference?.oracleVsDexBps)} | ${row.flags || "-"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const borrowerTable = out.borrowerRows.slice(0, 10).map((row) => `| ${row.sampleId} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.shortfallUsd)} | ${row.liquidatable} |`).join("\n") || "| none sampled | n/a | n/a | false |";
  const roleTable = out.roleRows.map((row) => `| ${row.role} | ${compactAddress(row.address)} | ${row.kind || "n/a"} |`).join("\n") || "| none | n/a | n/a |";
  const artifactTable = out.localArtifactRows.slice(0, 10).map((row) => `| ${row.file} | ${row.hits} | ${row.exactAddressHits} |`).join("\n") || "| none | 0 | 0 |";
  const lines = [
    `# ${SIGNAL_BANNER} - Flux Finance Phase 0`,
    "",
    `Generated: ${out.generatedAt}`,
    "",
    "Scanner: `tools/scan-flux-finance-phase0.js`",
    "",
    "## Result",
    "",
    "No confirmed permissionless exploit. This bounded read-only pass mapped Flux Finance's Ethereum Compound V2/fToken markets, oracle/reference values, caps/pauses, cash/borrows, bounded anonymized borrower health, local fToken source/artifact joins, and admin context. No row has exact positive borrow, liquidation, redemption, or unwind economics, and no signed action is justified.",
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Public TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |`,
    `| Markets scanned / listed | \`${s.marketRows}/${s.listedRows}\` |`,
    `| High-CF borrowable rows | \`${s.highCfBorrowableRows}\` |`,
    `| Material cash rows | \`${s.materialCashRows}\` |`,
    `| Material borrow rows | \`${s.materialBorrowRows}\` |`,
    `| Divergent rows | \`${s.divergentRows}\` |`,
    `| Stale-but-accepted rows | \`${s.staleButAcceptedRows}\` |`,
    `| Bounded anonymized borrower samples | \`${s.sampledBorrowers}\` |`,
    `| Material sampled liquidatable borrowers | \`${s.materialSampledLiquidatableBorrowers}\` |`,
    `| Total cash context | ${formatUsd(s.totalCashUsd)} |`,
    `| Total borrows context | ${formatUsd(s.totalBorrowsUsd)} |`,
    `| Local artifact/source hit rows | \`${s.localArtifactRows}\` |`,
    `| Watch candidates | \`${s.watchCandidates}\` |`,
    `| Route-positive | \`${s.routePositive}\` |`,
    `| Executable now | \`${s.executableNow}\` |`,
    `| Signed action justified | \`${s.signedActionJustified}\` |`,
    `| Coverage classification | \`${s.coverageClassification}\` |`,
    "",
    "## Markets",
    "",
    "| fToken | Underlying | CF | Cash | Borrows | Borrow paused | Oracle vs Chainlink | Oracle vs DEX | Flags |",
    "|---|---|---:|---:|---:|---|---:|---:|---|",
    marketTable,
    "",
    "## Anonymized Borrower Sampling",
    "",
    `Borrower sampling is bounded to recent ${out.thresholds.recentBorrowLogBlocks} Borrow-log blocks and intentionally does not persist borrower addresses.`,
    "",
    "| Sample | Liquidity | Shortfall | Liquidatable |",
    "|---|---:|---:|---|",
    borrowerTable,
    "",
    "## Roles",
    "",
    "| Role | Address | Kind |",
    "|---|---|---|",
    roleTable,
    "",
    "## Local Artifact / Consumer Context",
    "",
    "| File | Hits | Exact Address Hits |",
    "|---|---:|---:|",
    artifactTable,
    "",
    "These rows include Reserve Protocol fToken collateral source/config hits and local artifact references. They are not route-positive without live accepted-value divergence, borrow/liquidation/redemption liquidity, and exact exit economics.",
    "",
    "## Blockers",
    "",
    ...out.blockers.map((b) => `- ${b}`),
    "",
    "## Required For Route-Positive",
    "",
    ...out.requiredForRoutePositive.map((b) => `- ${b}`),
    "",
    "## Next Read-Only Step",
    "",
    out.nextReadOnlyStep,
    "",
    "## Artifacts",
    "",
    `- Raw JSON: \`${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}\``,
    `- Scanner: \`${path.relative(WORKSPACE, __filename).replace(/\\/g, "/")}\``,
  ];
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, `${lines.join("\n")}\n`);
}

async function main() {
  const metadata = await protocolMetadata();
  const rpcPool = await resolveRpcPool([1]);
  const rpc = rpcPool[1];
  if (!rpc) throw new Error("No Ethereum RPC endpoint resolved for Flux Finance; ask the user for a suitable endpoint instead of skipping the chain");
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1, staticNetwork: true });
  const latest = await latestBlock(provider);
  const comptrollerAddr = normalizeAddress(FLUX.comptroller);
  const comptroller = new ethers.Contract(comptrollerAddr, COMPTROLLER_ABI, provider);
  const [code, allMarketsRaw, oracleRaw, adminRaw, pendingAdminRaw, pauseGuardianRaw, borrowCapGuardianRaw, implRaw, pendingImplRaw, closeFactorRaw, liqIncentiveRaw, transferPausedRaw, seizePausedRaw] = await Promise.all([
    safeCode(provider, comptrollerAddr),
    tryCall(() => comptroller.getAllMarkets(), []),
    tryCall(() => comptroller.oracle(), null),
    tryCall(() => comptroller.admin(), null),
    tryCall(() => comptroller.pendingAdmin(), null),
    tryCall(() => comptroller.pauseGuardian(), null),
    tryCall(() => comptroller.borrowCapGuardian(), null),
    tryCall(() => comptroller.comptrollerImplementation(), null),
    tryCall(() => comptroller.pendingComptrollerImplementation(), null),
    tryCall(() => comptroller.closeFactorMantissa(), null),
    tryCall(() => comptroller.liquidationIncentiveMantissa(), null),
    tryCall(() => comptroller.transferGuardianPaused(), null),
    tryCall(() => comptroller.seizeGuardianPaused(), null),
  ]);
  const oracleAddr = normalizeAddress(oracleRaw);
  const oracle = oracleAddr ? new ethers.Contract(oracleAddr, ORACLE_ABI, provider) : null;
  const knownByAddr = new Map(Object.entries(FLUX.markets).map(([label, addr]) => [lowerAddress(addr), label]));
  const markets = unique([...(allMarketsRaw || []).map(normalizeAddress), ...Object.values(FLUX.markets).map(normalizeAddress)].filter(Boolean));
  const marketRows = [];
  for (const market of markets) {
    const label = knownByAddr.get(lowerAddress(market)) || null;
    try {
      marketRows.push(await scanMarket(provider, comptroller, oracle, market, label, latest));
    } catch (err) {
      marketRows.push({ chain: FLUX.chain, chainId: FLUX.chainId, comptroller: comptrollerAddr, fToken: market, expectedLabel: label, error: safeText(err?.message || "market-scan-failed"), routePositive: false });
    }
  }
  marketRows.sort((a, b) => (asNumber(b.cashUsd) || 0) - (asNumber(a.cashUsd) || 0));
  const borrower = await borrowerRows(rpc, comptroller, marketRows, latest);
  const [oracleOwnerRaw, oracleAdminRaw] = oracle ? await Promise.all([
    tryCall(() => oracle.owner(), null),
    tryCall(() => oracle.admin(), null),
  ]) : [null, null];
  const roleRows = [
    { role: "Comptroller admin", address: normalizeAddress(adminRaw), kind: await addressKind(provider, adminRaw) },
    { role: "Comptroller pendingAdmin", address: normalizeAddress(pendingAdminRaw), kind: await addressKind(provider, pendingAdminRaw) },
    { role: "Pause guardian", address: normalizeAddress(pauseGuardianRaw), kind: await addressKind(provider, pauseGuardianRaw) },
    { role: "Borrow cap guardian", address: normalizeAddress(borrowCapGuardianRaw), kind: await addressKind(provider, borrowCapGuardianRaw) },
    { role: "Oracle", address: oracleAddr, kind: await addressKind(provider, oracleAddr) },
    { role: "Oracle owner", address: normalizeAddress(oracleOwnerRaw), kind: await addressKind(provider, oracleOwnerRaw) },
    { role: "Oracle admin", address: normalizeAddress(oracleAdminRaw), kind: await addressKind(provider, oracleAdminRaw) },
  ];
  const localArtifactRows = scanLocalArtifactRows();
  const materialLiquidatable = borrower.rows.filter((row) => row.materialLiquidatable);
  const watchRows = marketRows.filter((row) => row.watchCandidate);
  const summary = {
    defillamaCurrentTvlUsd: round(metadata.tvlUsd, 2),
    chainsScoped: 1,
    chainsWithRpc: 1,
    chainsBlockedMissingRpc: 0,
    comptrollerCodePresent: Boolean(code && code !== "0x"),
    blockNumber: latest.number,
    marketRows: marketRows.length,
    listedRows: marketRows.filter((row) => row.listed).length,
    knownSeedRows: Object.keys(FLUX.markets).length,
    highCfRows: marketRows.filter((row) => row.highCf).length,
    borrowableRows: marketRows.filter((row) => row.borrowable).length,
    highCfBorrowableRows: marketRows.filter((row) => row.highCf && row.borrowable).length,
    materialCashRows: marketRows.filter((row) => (asNumber(row.cashUsd) || 0) >= MATERIAL_USD).length,
    materialBorrowRows: marketRows.filter((row) => (asNumber(row.borrowsUsd) || 0) >= MATERIAL_USD).length,
    divergentRows: marketRows.filter((row) => row.divergent).length,
    staleButAcceptedRows: marketRows.filter((row) => row.staleButAccepted).length,
    watchCandidates: watchRows.length + materialLiquidatable.length,
    sampledBorrowers: borrower.rows.length,
    sampledLiquidatableBorrowers: borrower.rows.filter((row) => row.liquidatable).length,
    materialSampledLiquidatableBorrowers: materialLiquidatable.length,
    borrowLogsRead: borrower.logsRead,
    borrowLogErrorRows: borrower.logErrors.length,
    localArtifactRows: localArtifactRows.length,
    totalCashUsd: round(marketRows.reduce((sum, row) => sum + (asNumber(row.cashUsd) || 0), 0), 2),
    totalBorrowsUsd: round(marketRows.reduce((sum, row) => sum + (asNumber(row.borrowsUsd) || 0), 0), 2),
    routePositive: 0,
    executableNow: false,
    signedActionJustified: false,
    coverageClassification: "bounded-with-caveats",
    forkGate: "closed-route-positive-zero",
  };
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-flux-finance-phase0.js",
    scope: "Read-only Flux Finance Ethereum Compound V2/fToken market/oracle/liquidation Phase 0 scan",
    target: { name: "Flux Finance", slug: "flux-finance", category: "Lending", surface: "lending-oracle-liquidation", metadata },
    safety: {
      publicApisOnlyForMetadata: true,
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      privateKeysRead: false,
      calldataStored: false,
      borrowerAddressesStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    thresholds: { materialUsd: MATERIAL_USD, highCollateralFactorBps: HIGH_CF_BPS, divergenceWatchBps: DIVERGENCE_WATCH_BPS, staleWarnSeconds: STALE_WARN_SECONDS, recentBorrowLogBlocks: RECENT_BORROW_LOG_BLOCKS, maxBorrowers: MAX_BORROWERS },
    deployment: {
      chain: FLUX.chain,
      chainId: FLUX.chainId,
      comptroller: comptrollerAddr,
      comptrollerCodePresent: Boolean(code && code !== "0x"),
      comptrollerCodeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
      oracle: oracleAddr,
      comptrollerImplementation: normalizeAddress(implRaw),
      pendingComptrollerImplementation: normalizeAddress(pendingImplRaw),
      closeFactorBps: closeFactorRaw === null ? null : wadBps(closeFactorRaw),
      liquidationIncentiveBps: liqIncentiveRaw === null ? null : wadBps(liqIncentiveRaw),
      transferGuardianPaused: transferPausedRaw === null ? null : Boolean(transferPausedRaw),
      seizeGuardianPaused: seizePausedRaw === null ? null : Boolean(seizePausedRaw),
    },
    source: {
      localSeedSource: "targets/reserve-protocol/common/configuration.ts and Flux fToken collateral tests",
      localTestNote: "Reserve Protocol tests state: FTokens are just CompoundV2 CTokens",
      forkBlockReference: "targets/reserve-protocol/test/integration/fork-block-numbers.ts flux-finance=16836855",
    },
    summary,
    marketRows,
    borrowerRows: borrower.rows,
    roleRows,
    localArtifactRows,
    logErrors: borrower.logErrors.map((error) => ({ chain: FLUX.chain, chainId: FLUX.chainId, error })),
    routePositiveRows: [],
    watchRows,
    blockers: [
      "High-CF fToken rows require current accepted-value divergence plus exact positive borrow/liquidation/exit economics",
      "Chainlink/oracle and DEX reference differences are context only unless they clear LTV haircuts, gas, slippage, fees, and caps",
      "Bounded borrower sampling is anonymized and not exhaustive; no material sampled liquidatable borrower is route-positive without exact repay/seize/exit economics",
      "Local Reserve Protocol fToken collateral hits are consumer context, not impact without live accepted-value divergence and borrow liquidity",
      "No fork extraction proof",
    ],
    requiredForRoutePositive: [
      "specific Flux fToken market accepts attacker-favorable stale or divergent oracle/accounting value",
      "borrow or liquidation path is permissionless, unpaused, uncapped or cap-available, and has material live liquidity",
      "collateral acquisition, borrow/repay, seized asset exit, and unwind are exact-quoted after gas/slippage/fees",
      "fork extraction proof demonstrates positive net value",
    ],
    nextReadOnlyStep: "Keep Flux Finance on high-CF stablecoin oracle/liquidation watch; exact-quote/fork only if a material borrower becomes liquidatable or a fToken accepted-value/reference divergence clears full route costs.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
  writeReport(out);
  if (!QUIET) {
    console.log(`Flux Finance Phase 0: markets=${summary.marketRows}/${summary.listedRows} highCfBorrowable=${summary.highCfBorrowableRows} sampledBorrowers=${summary.sampledBorrowers} materialLiquidatable=${summary.materialSampledLiquidatableBorrowers} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
    console.log(`Wrote ${path.relative(WORKSPACE, RAW_OUT)}`);
    console.log(`Report ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(`Flux Finance Phase 0 failed: ${err.message}`);
  process.exitCode = 1;
});
