#!/usr/bin/env node
// scan-benqi-lending-phase0.js - read-only Benqi Lending Phase 0 scan.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpcPool, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "benqi-lending-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "benqi-lending-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_BANNER = "\uD83D\uDFE2 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";
const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const WAVAX = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7";

const MATERIAL_USD = Number(process.env.BENQI_PHASE0_MATERIAL_USD || "10000");
const HIGH_CF_BPS = Number(process.env.BENQI_PHASE0_HIGH_CF_BPS || "7000");
const DIVERGENCE_WATCH_BPS = Number(process.env.BENQI_PHASE0_DIVERGENCE_WATCH_BPS || "500");
const RECENT_BORROW_LOG_BLOCKS = Number(process.env.BENQI_PHASE0_RECENT_BORROW_LOG_BLOCKS || "50000");
const BORROW_LOG_CHUNK_BLOCKS = Number(process.env.BENQI_PHASE0_BORROW_LOG_CHUNK_BLOCKS || "5000");
const MAX_BORROWERS_PER_COMPTROLLER = Number(process.env.BENQI_PHASE0_MAX_BORROWERS_PER_COMPTROLLER || "120");

const COMPTROLLERS = [
  {
    label: "Benqi Core Comptroller",
    comptroller: "0x486Af39519B4Dc9a7fCcd318217352830E8AD9b4",
    cether: "0x5C0401e81Bc07Ca70fAD469b451682c0d747Ef1c",
    nativeSymbol: "AVAX",
    source: "DefiLlama projects/benqi/index.js first compoundExports row",
  },
  {
    label: "Benqi Secondary Comptroller",
    comptroller: "0xD7c4006d33DA2A0A8525791ed212bbCD7Aca763F",
    cether: null,
    nativeSymbol: "AVAX",
    source: "DefiLlama projects/benqi/index.js second compoundExports row",
  },
];

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

const QTOKEN_ABI = [
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
];

const ORACLE_ABI = [
  "function getUnderlyingPrice(address qiToken) view returns (uint256)",
  "function getFeeds(address qiToken) view returns (address edgeFeed,address chainlinkFeed)",
  "function assetConfigs(address qiToken) view returns (uint256 stalenessThreshold,bool isConfigured,uint256 deviationThreshold)",
  "function oracleMode() view returns (uint8)",
  "function deviationThreshold() view returns (uint256)",
  "function maxDeviationThreshold() view returns (uint256)",
  "function edgeOracle() view returns (address)",
  "function chainlinkOracle() view returns (address)",
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
  "function latestAnswer() view returns (int256)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
];

const BORROW_EVENT = new ethers.Interface(["event Borrow(address borrower,uint256 borrowAmount,uint256 accountBorrows,uint256 totalBorrows)"]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function safeText(value, max = 120) { const s = value === null || value === undefined ? "" : String(value); return s.replace(/[\r\n|]+/g, " ").slice(0, max); }
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
function unitsToNumber(value, decimals) { try { const n = Number(ethers.formatUnits(toBig(value), Number(decimals ?? 18))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function wadBps(value) { try { return Number((toBig(value) * 10000n) / 10n ** 18n); } catch (_) { return null; } }
function hexBlock(n) { return `0x${Number(n).toString(16)}`; }

async function fetchJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function tryCall(fn, fallback = null) {
  try { return await fn(); } catch (_) { return fallback; }
}

async function safeCode(provider, address) {
  const addr = normalizeAddress(address);
  if (!addr) return "0x";
  return await tryCall(() => provider.getCode(addr), "0x");
}

async function addressKind(provider, address) {
  const addr = normalizeAddress(address);
  if (!addr || addr === ZERO) return null;
  const code = await safeCode(provider, addr);
  return code && code !== "0x" ? "contract" : "eoa";
}

async function tokenMeta(provider, token, fallback = {}) {
  const addr = normalizeAddress(token);
  if (!addr || addr === NATIVE_TOKEN) return { address: token || NATIVE_TOKEN, symbol: fallback.symbol || "AVAX", name: fallback.name || "Avalanche", decimals: fallback.decimals ?? 18 };
  const c = new ethers.Contract(addr, ERC20_ABI, provider);
  const [symbol, name, decimals] = await Promise.all([
    tryCall(() => c.symbol(), fallback.symbol || null),
    tryCall(() => c.name(), fallback.name || null),
    tryCall(() => c.decimals(), fallback.decimals ?? 18),
  ]);
  return { address: addr, symbol: safeText(symbol || fallback.symbol || "UNK", 32), name: safeText(name || fallback.name || "", 80), decimals: Number(decimals ?? fallback.decimals ?? 18) };
}

function benqiOracleUsd(raw, underlyingDecimals) {
  if (raw === null || raw === undefined) return null;
  const decimals = 36 - Number(underlyingDecimals ?? 18);
  try {
    const n = Number(ethers.formatUnits(toBig(raw), decimals));
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

function parseOracleConfig(raw) {
  if (!raw) return null;
  return {
    stalenessThreshold: Number(raw[0]),
    isConfigured: Boolean(raw[1]),
    deviationThresholdBps: wadBps(raw[2]),
  };
}

async function feedInfo(provider, feedAddr, latestTimestamp, role) {
  const addr = normalizeAddress(feedAddr);
  if (!addr || addr === ZERO) return null;
  const f = new ethers.Contract(addr, FEED_ABI, provider);
  const [decimals, description, latestAnswer, roundData] = await Promise.all([
    tryCall(() => f.decimals(), null),
    tryCall(() => f.description(), null),
    tryCall(() => f.latestAnswer(), null),
    tryCall(() => f.latestRoundData(), null),
  ]);
  const updatedAt = roundData ? Number(roundData[3]) : null;
  const ageSeconds = updatedAt && latestTimestamp ? Math.max(0, Number(latestTimestamp) - updatedAt) : null;
  return {
    role,
    address: addr,
    description: safeText(description || "", 80) || null,
    decimals: decimals === null ? null : Number(decimals),
    latestAnswer: latestAnswer === null ? null : latestAnswer.toString(),
    updatedAt,
    ageSeconds,
  };
}

async function dexScreenerPrice(token) {
  const addr = normalizeAddress(token);
  if (!addr || addr === NATIVE_TOKEN) return null;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const json = await res.json();
    const pairs = (json.pairs || []).filter((p) => String(p.chainId).toLowerCase() === "avalanche");
    pairs.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
    const best = pairs[0];
    if (!best || !best.priceUsd) return null;
    return {
      priceUsd: Number(best.priceUsd),
      liquidityUsd: Number(best.liquidity?.usd || 0),
      pairAddress: normalizeAddress(best.pairAddress) || safeText(best.pairAddress, 80),
      dexId: safeText(best.dexId, 40),
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
  if (!addresses.length || fromBlock === null || fromBlock > toBlock) return { logs: [], errors: [] };
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
  const addresses = marketRows.map((row) => normalizeAddress(row.qToken)).filter(Boolean);
  const fromBlock = RECENT_BORROW_LOG_BLOCKS > 0 ? Math.max(0, latest.number - RECENT_BORROW_LOG_BLOCKS) : null;
  const logResult = fromBlock === null ? { logs: [], errors: [] } : await getBorrowLogs(rpc, addresses, fromBlock, latest.number);
  const borrowers = [];
  for (const log of logResult.logs) {
    if (borrowers.length >= MAX_BORROWERS_PER_COMPTROLLER) break;
    try {
      const parsed = BORROW_EVENT.parseLog({ topics: log.topics, data: log.data });
      const borrower = normalizeAddress(parsed.args.borrower);
      if (borrower && !borrowers.includes(borrower)) borrowers.push(borrower);
    } catch (_) {}
  }
  const rows = [];
  for (const borrower of borrowers) {
    const liq = await tryCall(() => comptroller.getAccountLiquidity(borrower), null);
    const liquidityUsd = liq ? unitsToNumber(liq[1], 18) : null;
    const shortfallUsd = liq ? unitsToNumber(liq[2], 18) : null;
    rows.push({
      borrower,
      liquidityUsd: round(liquidityUsd, 6),
      shortfallUsd: round(shortfallUsd, 6),
      liquidatable: (shortfallUsd || 0) > 0,
      materialLiquidatable: (shortfallUsd || 0) >= MATERIAL_USD,
      routePositive: false,
      blocker: "Sampled account row is not route-positive without exact repay/seize/exit economics and fork proof",
    });
  }
  rows.sort((a, b) => (asNumber(b.shortfallUsd) || 0) - (asNumber(a.shortfallUsd) || 0));
  return { rows, logsRead: logResult.logs.length, fromBlock, logErrors: logResult.errors };
}

async function scanMarket(provider, comptroller, oracle, cfg, qToken, latest) {
  const qAddr = normalizeAddress(qToken);
  const q = new ethers.Contract(qAddr, QTOKEN_ABI, provider);
  const isNativeMarket = lowerAddress(qAddr) === lowerAddress(cfg.cether);
  const [code, qSymbolRaw, qNameRaw, qDecimalsRaw, underlyingRaw, marketRaw, cashRaw, borrowsRaw, supplyRaw, reservesRaw, exchangeRateRaw, reserveFactorRaw, borrowIndexRaw, accrualRaw, irmRaw, mintPausedRaw, borrowPausedRaw, borrowCapRaw, priceRaw, dualFeedsRaw, oracleCfgRaw] = await Promise.all([
    safeCode(provider, qAddr),
    tryCall(() => q.symbol(), null),
    tryCall(() => q.name(), null),
    tryCall(() => q.decimals(), 8),
    isNativeMarket ? WAVAX : tryCall(() => q.underlying(), null),
    tryCall(() => comptroller.markets(qAddr), null),
    tryCall(() => q.getCash(), null),
    tryCall(() => q.totalBorrows(), null),
    tryCall(() => q.totalSupply(), null),
    tryCall(() => q.totalReserves(), null),
    tryCall(() => q.exchangeRateStored(), null),
    tryCall(() => q.reserveFactorMantissa(), null),
    tryCall(() => q.borrowIndex(), null),
    tryCall(() => q.accrualBlockNumber(), null),
    tryCall(() => q.interestRateModel(), null),
    tryCall(() => comptroller.mintGuardianPaused(qAddr), null),
    tryCall(() => comptroller.borrowGuardianPaused(qAddr), null),
    tryCall(() => comptroller.borrowCaps(qAddr), null),
    oracle ? tryCall(() => oracle.getUnderlyingPrice(qAddr), null) : null,
    oracle ? tryCall(() => oracle.getFeeds(qAddr), null) : null,
    oracle ? tryCall(() => oracle.assetConfigs(qAddr), null) : null,
  ]);

  const qSymbol = safeText(qSymbolRaw || "UNKNOWN", 40);
  const qName = safeText(qNameRaw || "", 80) || null;
  const asset = isNativeMarket ? WAVAX : normalizeAddress(underlyingRaw);
  const meta = await tokenMeta(provider, asset, { symbol: isNativeMarket ? cfg.nativeSymbol : qSymbol.replace(/^qi/i, ""), decimals: 18 });
  const market = marketRaw ? { listed: Boolean(marketRaw[0]), collateralFactorBps: wadBps(marketRaw[1]), isQi: Boolean(marketRaw[2]) } : { listed: false, collateralFactorBps: 0, isQi: false };
  const priceUsd = priceRaw === null ? null : benqiOracleUsd(priceRaw, meta.decimals);
  const cash = cashRaw === null ? null : unitsToNumber(cashRaw, meta.decimals);
  const borrows = borrowsRaw === null ? null : unitsToNumber(borrowsRaw, meta.decimals);
  const dex = asset ? await dexScreenerPrice(asset) : null;
  const refPrice = priceUsd ?? dex?.priceUsd ?? null;
  const cashUsd = cash !== null && refPrice !== null ? cash * refPrice : null;
  const borrowsUsd = borrows !== null && refPrice !== null ? borrows * refPrice : null;
  const oracleCfg = parseOracleConfig(oracleCfgRaw);
  const feeds = dualFeedsRaw ? {
    edge: await feedInfo(provider, dualFeedsRaw[0], latest.timestamp, "edge"),
    chainlink: await feedInfo(provider, dualFeedsRaw[1], latest.timestamp, "chainlink"),
  } : null;
  const feedList = feeds ? Object.values(feeds).filter(Boolean) : [];
  const staleThreshold = oracleCfg?.stalenessThreshold || null;
  const staleFeeds = staleThreshold ? feedList.filter((feed) => feed.ageSeconds !== null && feed.ageSeconds > staleThreshold) : [];
  const allFeedsStale = Boolean(feedList.length && staleFeeds.length === feedList.length);
  const staleButAccepted = Boolean(allFeedsStale && priceUsd !== null && priceUsd > 0);
  const oracleVsDexBps = priceUsd !== null && dex?.priceUsd ? ((priceUsd - dex.priceUsd) / dex.priceUsd) * 10000 : null;
  const divergent = Boolean(oracleVsDexBps !== null && Math.abs(oracleVsDexBps) >= DIVERGENCE_WATCH_BPS && (dex?.liquidityUsd || 0) >= MATERIAL_USD);
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
  if (divergent) flags.push("oracleDexDivergence");
  if (watchCandidate) flags.push("watchCandidate");

  return {
    chain: "Avalanche",
    chainId: 43114,
    comptroller: cfg.comptroller,
    comptrollerLabel: cfg.label,
    qToken: qAddr,
    qTokenCodePresent: Boolean(code && code !== "0x"),
    qTokenCodeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    qSymbol,
    qName,
    qDecimals: Number(qDecimalsRaw ?? 8),
    underlying: asset,
    underlyingSymbol: meta.symbol,
    underlyingDecimals: meta.decimals,
    listed: market.listed,
    collateralFactorBps: market.collateralFactorBps,
    isQi: market.isQi,
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
    reserveFactorBps: reserveFactorRaw === null ? null : wadBps(reserveFactorRaw),
    borrowIndexRaw: borrowIndexRaw?.toString?.() || null,
    accrualBlockNumber: accrualRaw === null ? null : Number(accrualRaw),
    interestRateModel: normalizeAddress(irmRaw),
    priceUsd: round(priceUsd, 10),
    priceRaw: priceRaw?.toString?.() || null,
    oracleConfig: oracleCfg,
    feeds,
    feedRows: feedList.length,
    staleFeedRows: staleFeeds.length,
    staleButAccepted,
    dex,
    oracleVsDexBps: round(oracleVsDexBps, 4),
    divergent,
    highCf,
    borrowable,
    watchCandidate,
    routePositive: false,
    flags: flags.join(","),
    blocker: watchCandidate
      ? "Watch-only: needs accepted-value divergence plus exact borrow/liquidation/exit economics and fork proof"
      : "No exact positive Benqi borrow or liquidation economics proven",
  };
}

async function scanComptroller(provider, rpc, cfg) {
  const comptrollerAddr = normalizeAddress(cfg.comptroller);
  const comptroller = new ethers.Contract(comptrollerAddr, COMPTROLLER_ABI, provider);
  const latest = await latestBlock(provider);
  const [code, marketsRaw, oracleAddrRaw, adminRaw, pendingAdminRaw, pauseGuardianRaw, borrowCapGuardianRaw, implRaw, pendingImplRaw, closeFactorRaw, liqIncentiveRaw, transferPausedRaw, seizePausedRaw] = await Promise.all([
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
  const oracleAddr = normalizeAddress(oracleAddrRaw);
  const oracle = oracleAddr ? new ethers.Contract(oracleAddr, ORACLE_ABI, provider) : null;
  const [oracleModeRaw, deviationRaw, maxDeviationRaw, edgeOracleRaw, chainlinkOracleRaw, oracleOwnerRaw, oracleAdminRaw] = oracle ? await Promise.all([
    tryCall(() => oracle.oracleMode(), null),
    tryCall(() => oracle.deviationThreshold(), null),
    tryCall(() => oracle.maxDeviationThreshold(), null),
    tryCall(() => oracle.edgeOracle(), null),
    tryCall(() => oracle.chainlinkOracle(), null),
    tryCall(() => oracle.owner(), null),
    tryCall(() => oracle.admin(), null),
  ]) : [null, null, null, null, null, null, null];

  const markets = unique((marketsRaw || []).map(normalizeAddress).filter(Boolean));
  const marketRows = [];
  for (const market of markets) {
    try {
      marketRows.push(await scanMarket(provider, comptroller, oracle, cfg, market, latest));
    } catch (err) {
      marketRows.push({ chain: "Avalanche", chainId: 43114, comptroller: comptrollerAddr, comptrollerLabel: cfg.label, qToken: market, error: safeText(err?.message || "market-scan-failed"), routePositive: false });
    }
  }
  marketRows.sort((a, b) => (asNumber(b.cashUsd) || 0) - (asNumber(a.cashUsd) || 0));
  const borrower = await borrowerRows(rpc, comptroller, marketRows, latest);
  const roleRows = [
    { role: "Comptroller admin", address: normalizeAddress(adminRaw), kind: await addressKind(provider, adminRaw) },
    { role: "Comptroller pendingAdmin", address: normalizeAddress(pendingAdminRaw), kind: await addressKind(provider, pendingAdminRaw) },
    { role: "Pause guardian", address: normalizeAddress(pauseGuardianRaw), kind: await addressKind(provider, pauseGuardianRaw) },
    { role: "Borrow cap guardian", address: normalizeAddress(borrowCapGuardianRaw), kind: await addressKind(provider, borrowCapGuardianRaw) },
    { role: "Oracle", address: oracleAddr, kind: await addressKind(provider, oracleAddr) },
    { role: "Oracle owner", address: normalizeAddress(oracleOwnerRaw), kind: await addressKind(provider, oracleOwnerRaw) },
    { role: "Oracle admin", address: normalizeAddress(oracleAdminRaw), kind: await addressKind(provider, oracleAdminRaw) },
  ].map((row) => ({ chain: "Avalanche", chainId: 43114, comptroller: comptrollerAddr, comptrollerLabel: cfg.label, ...row }));
  const listedRows = marketRows.filter((row) => row.listed);
  const watchRows = marketRows.filter((row) => row.watchCandidate);
  return {
    comptrollerRow: {
      chain: "Avalanche",
      chainId: 43114,
      label: cfg.label,
      comptroller: comptrollerAddr,
      source: cfg.source,
      rpcResolved: true,
      status: code && code !== "0x" ? "scanned" : "no-code",
      blockNumber: latest.number,
      blockTimestamp: latest.timestamp,
      comptrollerCodePresent: Boolean(code && code !== "0x"),
      comptrollerCodeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
      oracle: oracleAddr,
      oracleMode: oracleModeRaw === null ? null : Number(oracleModeRaw),
      oracleDeviationThresholdBps: deviationRaw === null ? null : wadBps(deviationRaw),
      oracleMaxDeviationThresholdBps: maxDeviationRaw === null ? null : wadBps(maxDeviationRaw),
      edgeOracle: normalizeAddress(edgeOracleRaw),
      chainlinkOracle: normalizeAddress(chainlinkOracleRaw),
      admin: normalizeAddress(adminRaw),
      pendingAdmin: normalizeAddress(pendingAdminRaw),
      pauseGuardian: normalizeAddress(pauseGuardianRaw),
      borrowCapGuardian: normalizeAddress(borrowCapGuardianRaw),
      comptrollerImplementation: normalizeAddress(implRaw),
      pendingComptrollerImplementation: normalizeAddress(pendingImplRaw),
      closeFactorBps: closeFactorRaw === null ? null : wadBps(closeFactorRaw),
      liquidationIncentiveBps: liqIncentiveRaw === null ? null : wadBps(liqIncentiveRaw),
      transferGuardianPaused: transferPausedRaw === null ? null : Boolean(transferPausedRaw),
      seizeGuardianPaused: seizePausedRaw === null ? null : Boolean(seizePausedRaw),
      marketRows: marketRows.length,
      listedRows: listedRows.length,
      highCfRows: marketRows.filter((row) => row.highCf).length,
      borrowableRows: marketRows.filter((row) => row.borrowable).length,
      highCfBorrowableRows: marketRows.filter((row) => row.highCf && row.borrowable).length,
      staleButAcceptedRows: marketRows.filter((row) => row.staleButAccepted).length,
      divergentRows: marketRows.filter((row) => row.divergent).length,
      watchCandidates: watchRows.length,
      sampledBorrowers: borrower.rows.length,
      sampledLiquidatableBorrowers: borrower.rows.filter((row) => row.liquidatable).length,
      materialSampledLiquidatableBorrowers: borrower.rows.filter((row) => row.materialLiquidatable).length,
      borrowLogsRead: borrower.logsRead,
      borrowLogFromBlock: borrower.fromBlock,
      totalCashUsd: round(marketRows.reduce((sum, row) => sum + (asNumber(row.cashUsd) || 0), 0), 2),
      totalBorrowsUsd: round(marketRows.reduce((sum, row) => sum + (asNumber(row.borrowsUsd) || 0), 0), 2),
      routePositive: 0,
      executableNow: false,
    },
    marketRows,
    borrowerRows: borrower.rows.map((row) => ({ chain: "Avalanche", chainId: 43114, comptroller: comptrollerAddr, comptrollerLabel: cfg.label, ...row })),
    roleRows,
    logErrors: borrower.logErrors.map((error) => ({ chain: "Avalanche", chainId: 43114, comptroller: comptrollerAddr, comptrollerLabel: cfg.label, error })),
  };
}

function protocolMetadataFromDiscovery() {
  const d = readJson(PUBLIC_TARGETS, {});
  const rows = [...(d.phase0Queue || []), ...(d.targetedRefreshQueue || []), ...(d.protocolCandidates || []), ...(d.consumerJoinFirst || [])];
  const row = rows.find((p) => p?.slug === "benqi-lending" || p?.name === "Benqi Lending");
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
  const json = await fetchJson("https://api.llama.fi/protocol/benqi-lending");
  const latestTvlRow = Array.isArray(json?.tvl) && json.tvl.length ? json.tvl[json.tvl.length - 1] : null;
  return {
    name: safeText(json?.name, 80) || local?.name || "Benqi Lending",
    slug: safeText(json?.slug, 80) || local?.slug || "benqi-lending",
    category: safeText(json?.category, 80) || local?.category || "Lending",
    chains: Array.isArray(json?.chains) ? json.chains.map((chain) => safeText(chain, 60)).filter(Boolean) : local?.chains || ["Avalanche"],
    evmChains: local?.evmChains || ["Avalanche"],
    tvlUsd: asNumber(latestTvlRow?.totalLiquidityUSD) || local?.tvlUsd || null,
    change1dPct: asNumber(json?.change_1d) ?? local?.change1dPct ?? null,
    change7dPct: asNumber(json?.change_7d) ?? local?.change7dPct ?? null,
    routePriority: local?.routePriority || null,
    source: json ? "defillama-protocol-api+public-discovery" : local?.source || "fallback-static",
  };
}

function topRows(rows, filter, sortField, limit = 12) {
  return rows.filter(filter).sort((a, b) => (asNumber(b[sortField]) || 0) - (asNumber(a[sortField]) || 0)).slice(0, limit);
}

function writeReport(out) {
  const s = out.summary;
  const comptrollerTable = out.comptrollerRows.map((row) => `| ${row.label} | ${row.status} | ${row.listedRows || 0} | ${row.highCfBorrowableRows || 0} | ${row.divergentRows || 0} | ${row.staleButAcceptedRows || 0} | ${row.sampledBorrowers || 0} | ${row.materialSampledLiquidatableBorrowers || 0} | ${formatUsd(row.totalCashUsd)} | ${formatUsd(row.totalBorrowsUsd)} |`).join("\n") || "| none | n/a | 0 | 0 | 0 | 0 | 0 | 0 | n/a | n/a |";
  const marketTable = topRows(out.marketRows, (row) => row.listed, "cashUsd", 12).map((row) => `| ${row.comptrollerLabel} | ${row.qSymbol || "n/a"} | ${row.underlyingSymbol || "n/a"} | ${formatPctBps(row.collateralFactorBps)} | ${formatUsd(row.cashUsd)} | ${formatUsd(row.borrowsUsd)} | ${row.borrowPaused ? "yes" : "no"} | ${formatBps(row.oracleVsDexBps)} | ${row.flags || "-"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const oracleTable = topRows(out.marketRows, (row) => row.feedRows || row.oracleConfig, "cashUsd", 12).map((row) => {
    const edge = row.feeds?.edge;
    const chainlink = row.feeds?.chainlink;
    const edgeAge = edge?.ageSeconds === null || edge?.ageSeconds === undefined ? "n/a" : `${Math.round(edge.ageSeconds)}s`;
    const chainlinkAge = chainlink?.ageSeconds === null || chainlink?.ageSeconds === undefined ? "n/a" : `${Math.round(chainlink.ageSeconds)}s`;
    return `| ${row.qSymbol || "n/a"} | ${row.underlyingSymbol || "n/a"} | ${row.oracleConfig?.stalenessThreshold ?? "n/a"} | ${formatBps(row.oracleConfig?.deviationThresholdBps)} | ${edgeAge} | ${chainlinkAge} | ${row.staleButAccepted ? "yes" : "no"} |`;
  }).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const borrowerTable = out.borrowerRows.slice(0, 10).map((row) => `| ${row.comptrollerLabel} | ${compactAddress(row.borrower)} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.shortfallUsd)} | ${row.liquidatable} |`).join("\n") || "| none sampled | n/a | n/a | n/a | false |";
  const lines = [
    `# ${SIGNAL_BANNER} - Benqi Lending Phase 0`,
    "",
    `Generated: ${out.generatedAt}`,
    "",
    "Scanner: `tools/scan-benqi-lending-phase0.js`",
    "",
    "## Result",
    "",
    "No confirmed permissionless exploit. Benqi Lending's Avalanche Compound-style markets, live dual-oracle/feed state, caps/pauses, high-CF rows, and bounded recent borrower state were mapped. No row has exact positive borrow, liquidation, redemption, or unwind economics, and no signed action is justified.",
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Public TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |`,
    `| Comptrollers scanned | \`${s.comptrollersScanned}/${s.comptrollersInScope}\` |`,
    `| Market rows / listed | \`${s.marketRows}/${s.listedRows}\` |`,
    `| High-CF rows | \`${s.highCfRows}\` |`,
    `| High-CF borrowable rows | \`${s.highCfBorrowableRows}\` |`,
    `| Material cash rows | \`${s.materialCashRows}\` |`,
    `| Material borrow rows | \`${s.materialBorrowRows}\` |`,
    `| Divergent rows | \`${s.divergentRows}\` |`,
    `| Stale-but-accepted rows | \`${s.staleButAcceptedRows}\` |`,
    `| Bounded sampled borrowers | \`${s.sampledBorrowers}\` |`,
    `| Material sampled liquidatable borrowers | \`${s.materialSampledLiquidatableBorrowers}\` |`,
    `| Total cash context | ${formatUsd(s.totalCashUsd)} |`,
    `| Total borrows context | ${formatUsd(s.totalBorrowsUsd)} |`,
    `| Watch candidates | \`${s.watchCandidates}\` |`,
    `| Route-positive | \`${s.routePositive}\` |`,
    `| Executable now | \`${s.executableNow}\` |`,
    `| Signed action justified | \`${s.signedActionJustified}\` |`,
    `| Coverage classification | \`${s.coverageClassification}\` |`,
    "",
    "## Comptrollers",
    "",
    "| Comptroller | Status | Listed | High-CF borrowable | Divergent | Stale accepted | Sampled borrowers | Material liquidatable | Cash | Borrows |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    comptrollerTable,
    "",
    "## Top Markets",
    "",
    "| Comptroller | qToken | Underlying | CF | Cash | Borrows | Borrow paused | Oracle vs DEX | Flags |",
    "|---|---|---|---:|---:|---:|---|---:|---|",
    marketTable,
    "",
    "## Dual-Oracle Context",
    "",
    "| qToken | Underlying | Stale threshold | Deviation threshold | Edge age | Chainlink age | Stale accepted |",
    "|---|---|---:|---:|---:|---:|---|",
    oracleTable,
    "",
    "## Bounded Borrower Sampling",
    "",
    "| Comptroller | Borrower | Liquidity | Shortfall | Liquidatable |",
    "|---|---|---:|---:|---|",
    borrowerTable,
    "",
    "Borrower sampling is bounded to recent Borrow logs and is not exhaustive. Rows are not actionable without exact repay/seize sizing, collateral-exit quotes, gas/slippage/fees, and fork proof.",
    "",
    "## Blockers",
    "",
    "- Dual-oracle/feed, high-CF, and oracle-vs-DEX rows are context only without a current accepted-value divergence that maps to borrowable cash and exact positive exit economics.",
    "- Bounded borrower sampling found no material liquidatable borrower; liquidation work waits for exact repay/seize/exit economics and fork proof.",
    "- Paused legacy or divergent rows stay blocked until borrow/mint state reopens and external liquidity corroborates the divergence.",
    "- No fork extraction proof exists, and no signed action is justified.",
    "",
    "## Reopen Triggers",
    "",
    "- A borrowable high-CF market accepts stale or divergent oracle state while live cash and exit liquidity are material.",
    "- A sampled or externally discovered borrower has material shortfall plus exact positive liquidation economics after gas/slippage.",
    "- Governance or market config changes weaken dual-oracle staleness/deviation checks, unpause a divergent market, or add a high-CF market with material borrow cash.",
    "",
    "## Close-Out",
    "",
    "Benqi Lending remains dormant for the declared Phase 0 scope. No fork, executor, or live action is justified from this pass.",
  ];
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, `${lines.join("\n")}\n`);
}

async function main() {
  const metadata = await protocolMetadata();
  const rpcPool = await resolveRpcPool([43114]);
  const rpc = rpcPool[43114];
  const safety = {
    publicApisOnlyForMetadata: true,
    rpcInventoryRead: true,
    rpcUrlsStored: false,
    privateKeysRead: false,
    signedActions: false,
    exploitExecuteCalls: false,
    forkTransactions: false,
    routePositive: false,
    executableNow: false,
    signedActionJustified: false,
  };
  if (!rpc) throw new Error("No Avalanche RPC endpoint resolved");
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1, staticNetwork: true });
  const comptrollerResults = [];
  for (const cfg of COMPTROLLERS) comptrollerResults.push(await scanComptroller(provider, rpc, cfg));
  const comptrollerRows = comptrollerResults.map((r) => r.comptrollerRow);
  const marketRows = comptrollerResults.flatMap((r) => r.marketRows);
  const borrowerRowsFlat = comptrollerResults.flatMap((r) => r.borrowerRows);
  const roleRows = comptrollerResults.flatMap((r) => r.roleRows);
  const logErrors = comptrollerResults.flatMap((r) => r.logErrors);
  const summary = {
    defillamaCurrentTvlUsd: round(metadata.tvlUsd, 2),
    comptrollersInScope: COMPTROLLERS.length,
    comptrollersScanned: comptrollerRows.filter((row) => row.status === "scanned").length,
    marketRows: marketRows.length,
    listedRows: marketRows.filter((row) => row.listed).length,
    highCfRows: marketRows.filter((row) => row.highCf).length,
    highCfBorrowableRows: marketRows.filter((row) => row.highCf && row.borrowable).length,
    materialCashRows: marketRows.filter((row) => (asNumber(row.cashUsd) || 0) >= MATERIAL_USD).length,
    materialBorrowRows: marketRows.filter((row) => (asNumber(row.borrowsUsd) || 0) >= MATERIAL_USD).length,
    divergentRows: marketRows.filter((row) => row.divergent).length,
    staleButAcceptedRows: marketRows.filter((row) => row.staleButAccepted).length,
    watchCandidates: marketRows.filter((row) => row.watchCandidate).length,
    sampledBorrowers: borrowerRowsFlat.length,
    sampledLiquidatableBorrowers: borrowerRowsFlat.filter((row) => row.liquidatable).length,
    materialSampledLiquidatableBorrowers: borrowerRowsFlat.filter((row) => row.materialLiquidatable).length,
    totalCashUsd: round(marketRows.reduce((sum, row) => sum + (asNumber(row.cashUsd) || 0), 0), 2),
    totalBorrowsUsd: round(marketRows.reduce((sum, row) => sum + (asNumber(row.borrowsUsd) || 0), 0), 2),
    logErrorRows: logErrors.length,
    routePositive: 0,
    executableNow: false,
    signedActionJustified: false,
    coverageClassification: "bounded-with-caveats",
    forkGate: "closed-route-positive-zero",
  };
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-benqi-lending-phase0.js",
    scope: "Read-only Benqi Lending Avalanche Compound-style market/oracle/liquidation Phase 0 scan",
    target: { name: "Benqi Lending", slug: "benqi-lending", category: "Lending", surface: "lending-oracle-liquidation", metadata },
    safety,
    thresholds: { materialUsd: MATERIAL_USD, highCollateralFactorBps: HIGH_CF_BPS, divergenceWatchBps: DIVERGENCE_WATCH_BPS, recentBorrowLogBlocks: RECENT_BORROW_LOG_BLOCKS, maxBorrowersPerComptroller: MAX_BORROWERS_PER_COMPTROLLER },
    docs: {
      adapter: "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/benqi/index.js",
      priorTriage: "reports/benqi-triage.md",
      priorScanner: "tools/scan-benqi-avalanche.js",
    },
    summary,
    comptrollerRows,
    marketRows,
    borrowerRows: borrowerRowsFlat,
    roleRows,
    logErrors,
    routePositiveRows: [],
    watchRows: marketRows.filter((row) => row.watchCandidate),
    blockers: [
      "High-CF and oracle context rows require current accepted-value divergence plus exact positive borrow/liquidation/exit economics",
      "Bounded borrower sample is not exhaustive and produced no material sampled liquidatable borrower",
      "Paused or divergent legacy rows require unpaused borrow/mint state and corroborated exit liquidity",
      "No fork extraction proof",
    ],
    requiredForRoutePositive: [
      "specific Benqi market accepts attacker-favorable stale or divergent oracle/accounting value",
      "borrow or liquidation path is unpaused and has material live liquidity",
      "collateral acquisition, borrow/repay, seized asset exit, and unwind are exact-quoted after gas/slippage/fees",
      "fork extraction proof",
    ],
    nextReadOnlyStep: "Keep Benqi on dual-oracle/high-CF/liquidation watch; exact-quote/fork only if a material market or borrower becomes exact-positive.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, JSON.stringify(out, jsonReplacer, 2));
  writeReport(out);
  if (!QUIET) {
    console.log(`Benqi Lending Phase 0: comptrollers=${summary.comptrollersScanned}/${summary.comptrollersInScope} markets=${summary.marketRows}/${summary.listedRows} highCfBorrowable=${summary.highCfBorrowableRows} sampledBorrowers=${summary.sampledBorrowers} materialLiquidatable=${summary.materialSampledLiquidatableBorrowers} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
    console.log(`Wrote ${path.relative(WORKSPACE, RAW_OUT)}`);
    console.log(`Report ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(`Benqi Lending Phase 0 failed: ${err.message}`);
  process.exitCode = 1;
});
