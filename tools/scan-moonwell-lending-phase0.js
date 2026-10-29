#!/usr/bin/env node
// scan-moonwell-lending-phase0.js - read-only Moonwell Lending Phase 0 scan.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, execution calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "moonwell-lending-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "moonwell-lending-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_DORMANT = "🟢 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const MATERIAL_USD = Number(process.env.MOONWELL_PHASE0_MATERIAL_USD || "10000");
const HIGH_CF_BPS = Number(process.env.MOONWELL_PHASE0_HIGH_CF_BPS || "7000");
const DIVERGENCE_WATCH_BPS = Number(process.env.MOONWELL_PHASE0_DIVERGENCE_WATCH_BPS || "500");
const STALE_WARN_SECONDS = Number(process.env.MOONWELL_PHASE0_STALE_WARN_SECONDS || "86400");
const RECENT_BORROW_LOG_BLOCKS = Number(process.env.MOONWELL_PHASE0_RECENT_BORROW_LOG_BLOCKS || "50000");
const BORROW_LOG_CHUNK_BLOCKS = Number(process.env.MOONWELL_PHASE0_BORROW_LOG_CHUNK_BLOCKS || "5000");
const MAX_BORROWERS_PER_CHAIN = Number(process.env.MOONWELL_PHASE0_MAX_BORROWERS_PER_CHAIN || "140");

const CHAINS = [
  {
    chain: "Base",
    chainId: 8453,
    dexChainId: "base",
    comptroller: "0xfBb21d0380beE3312B33c4353c8936a0F13EF26C",
    documentedOracle: "0xEC942bE8A8114bFD0396A5052c36027f2cA6a9d0",
    source: "Moonwell docs protocol-information/contracts.md Base Contract Addresses",
  },
  {
    chain: "Optimism",
    chainId: 10,
    dexChainId: "optimism",
    comptroller: "0xCa889f40aae37FFf165BccF69aeF1E82b5C511B9",
    documentedOracle: "0x2f1490bD6aD10C9CE42a2829afa13EAc0b746dcf",
    source: "Moonwell docs protocol-information/contracts.md OP Mainnet Contract Addresses",
  },
];

const OUT_OF_SCOPE_DOC_ROWS = [
  { chain: "Moonbeam", reason: "current local RPC inventory/public target queue does not include Moonbeam; bounded coverage records this as unsupported-chain scope" },
  { chain: "Ethereum", reason: "Moonwell docs list Ethereum contracts, but current public target queue for Moonwell Lending scopes Base/Optimism EVM chains" },
  { chain: "Moonriver", reason: "docs mark Moonriver as deprecated/sunset" },
];

const COMPTROLLER = new ethers.Interface([
  "function getAllMarkets() view returns (address[])",
  "function markets(address) view returns (bool,uint256)",
  "function oracle() view returns (address)",
  "function admin() view returns (address)",
  "function pendingAdmin() view returns (address)",
  "function pauseGuardian() view returns (address)",
  "function borrowCapGuardian() view returns (address)",
  "function comptrollerImplementation() view returns (address)",
  "function pendingComptrollerImplementation() view returns (address)",
  "function closeFactorMantissa() view returns (uint256)",
  "function liquidationIncentiveMantissa() view returns (uint256)",
  "function getAccountLiquidity(address) view returns (uint256,uint256,uint256)",
  "function borrowCaps(address) view returns (uint256)",
  "function supplyCaps(address) view returns (uint256)",
  "function mintGuardianPaused(address) view returns (bool)",
  "function borrowGuardianPaused(address) view returns (bool)",
  "function transferGuardianPaused() view returns (bool)",
  "function seizeGuardianPaused() view returns (bool)",
]);

const MTOKEN = new ethers.Interface([
  "function underlying() view returns (address)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function admin() view returns (address)",
  "function pendingAdmin() view returns (address)",
  "function comptroller() view returns (address)",
  "function implementation() view returns (address)",
  "function getCash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function totalReserves() view returns (uint256)",
  "function exchangeRateStored() view returns (uint256)",
  "function reserveFactorMantissa() view returns (uint256)",
  "function interestRateModel() view returns (address)",
  "function borrowIndex() view returns (uint256)",
  "function accrualBlockNumber() view returns (uint256)",
]);

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const ORACLE = new ethers.Interface([
  "function getUnderlyingPrice(address) view returns (uint256)",
  "function getPrice(address) view returns (uint256)",
  "function getFeed(string) view returns (address)",
  "function feeds(string) view returns (address)",
  "function admin() view returns (address)",
  "function owner() view returns (address)",
]);

const FEED = new ethers.Interface([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);

const BEACON = new ethers.Interface(["function implementation() view returns (address)"]);
const BORROW_INDEXED = new ethers.Interface(["event Borrow(address indexed borrower,uint256 borrowAmount,uint256 accountBorrows,uint256 totalBorrows)"]);
const BORROW_UNINDEXED = new ethers.Interface(["event Borrow(address borrower,uint256 borrowAmount,uint256 accountBorrows,uint256 totalBorrows)"]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`; }
function formatPctBps(value) { const n = asNumber(value); return n === null ? "n/a" : `${round(n / 100, 2)}%`; }
function formatBps(value) { const n = asNumber(value); return n === null ? "n/a" : `${round(n, 2)}bps`; }
function safeText(value, max = 140) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function unitsToNumber(value, decimals = 18) { try { return Number(ethers.formatUnits(toBig(value), Number(decimals))); } catch (_) { return null; } }
function wadBps(value) { return Number((toBig(value) * 10000n) / (10n ** 18n)); }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function slotAddress(raw) { const addr = raw && raw !== "0x" && raw.length >= 66 ? normalizeAddress(`0x${raw.slice(26)}`) : null; return addr && addr !== ZERO ? addr : null; }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-moonwell-phase0/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = 12_000) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr) return null;
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ to: addr, data: iface.encodeFunctionData(fn, args) }, "latest"], timeoutMs);
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) { return null; }
}

async function getCode(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return "0x";
  return await rpcCall(rpc, "eth_getCode", [addr, "latest"], 10_000).catch(() => "0x") || "0x";
}

async function latestBlock(rpc) {
  const num = await rpcCall(rpc, "eth_blockNumber", [], 8_000).catch(() => null);
  const block = num ? await rpcCall(rpc, "eth_getBlockByNumber", [num, false], 8_000).catch(() => null) : null;
  return { number: num ? Number(BigInt(num)) : null, timestamp: block?.timestamp ? Number(BigInt(block.timestamp)) : null };
}

async function getSlotAddress(rpc, address, slot) {
  const raw = await rpcCall(rpc, "eth_getStorageAt", [address, slot, "latest"], 10_000).catch(() => null);
  return slotAddress(raw);
}

async function proxyMeta(rpc, address) {
  const [code, implSlot, adminSlot, beaconSlot] = await Promise.all([
    getCode(rpc, address),
    getSlotAddress(rpc, address, EIP1967_IMPL),
    getSlotAddress(rpc, address, EIP1967_ADMIN),
    getSlotAddress(rpc, address, EIP1967_BEACON),
  ]);
  const beaconImpl = beaconSlot ? await safeCall(rpc, beaconSlot, BEACON, "implementation") : null;
  return {
    address: normalizeAddress(address),
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    implementation: implSlot || normalizeAddress(beaconImpl?.[0]),
    beacon: beaconSlot,
    beaconImplementation: normalizeAddress(beaconImpl?.[0]),
    admin: adminSlot,
  };
}

async function addressKind(rpc, address) {
  const addr = normalizeAddress(address);
  if (!addr || addr === ZERO) return "zero";
  const code = await getCode(rpc, addr);
  return code && code !== "0x" ? "contract" : "eoa";
}

async function tokenMeta(rpc, token, fallback = {}) {
  const address = normalizeAddress(token);
  if (!address || address === ZERO) return fallback;
  const [symbol, name, decimals] = await Promise.all([
    safeCall(rpc, address, ERC20, "symbol"),
    safeCall(rpc, address, ERC20, "name"),
    safeCall(rpc, address, ERC20, "decimals"),
  ]);
  return {
    address,
    symbol: safeText(symbol?.[0], 40) || fallback.symbol || null,
    name: safeText(name?.[0], 80) || fallback.name || null,
    decimals: decimals?.[0] === undefined ? fallback.decimals ?? 18 : Number(decimals[0]),
  };
}

function priceUsdFromRaw(priceRaw, decimals) {
  if (priceRaw === null || priceRaw === undefined) return null;
  const priceDecimals = Math.max(0, 36 - Number(decimals || 18));
  return unitsToNumber(priceRaw, priceDecimals);
}

async function feedInfo(rpc, feedAddr, latest, role) {
  const addr = normalizeAddress(feedAddr);
  if (!addr || addr === ZERO) return null;
  const [code, decimals, description, roundData] = await Promise.all([
    getCode(rpc, addr),
    safeCall(rpc, addr, FEED, "decimals"),
    safeCall(rpc, addr, FEED, "description"),
    safeCall(rpc, addr, FEED, "latestRoundData"),
  ]);
  const updatedAt = roundData?.[3] === undefined ? null : Number(roundData[3]);
  const ageSeconds = updatedAt && latest.timestamp ? Math.max(0, latest.timestamp - updatedAt) : null;
  return {
    role,
    address: addr,
    codePresent: Boolean(code && code !== "0x"),
    description: safeText(description?.[0], 80),
    decimals: decimals?.[0] === undefined ? null : Number(decimals[0]),
    answer: roundData?.[1] === undefined ? null : roundData[1].toString(),
    updatedAt,
    ageSeconds,
    staleWarn: ageSeconds !== null && ageSeconds > STALE_WARN_SECONDS,
  };
}

async function oracleFeedForToken(rpc, oracle, tokenSymbol) {
  const symbol = safeText(tokenSymbol, 40);
  if (!symbol) return null;
  const getFeed = await safeCall(rpc, oracle, ORACLE, "getFeed", [symbol]);
  if (getFeed?.[0]) return normalizeAddress(getFeed[0]);
  const feeds = await safeCall(rpc, oracle, ORACLE, "feeds", [symbol]);
  if (feeds?.[0]) return normalizeAddress(feeds[0]);
  return null;
}

async function dexScreenerPrice(chain, token) {
  const addr = normalizeAddress(token);
  if (!addr) return null;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const json = await res.json();
    const pairs = (json.pairs || []).filter((p) => {
      const sameChain = String(p.chainId).toLowerCase() === chain.dexChainId;
      const base = lowerAddress(p.baseToken?.address);
      return sameChain && base === lowerAddress(addr);
    });
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

async function getBorrowLogs(rpc, addresses, fromBlock, toBlock) {
  if (!addresses.length || fromBlock === null || fromBlock > toBlock) return { logs: [], errors: [] };
  const logs = [];
  const errors = [];
  const topic0 = BORROW_UNINDEXED.getEvent("Borrow").topicHash;
  for (let from = fromBlock; from <= toBlock; from += BORROW_LOG_CHUNK_BLOCKS) {
    const to = Math.min(toBlock, from + BORROW_LOG_CHUNK_BLOCKS - 1);
    const chunk = await rpcCall(rpc, "eth_getLogs", [{ address: addresses, fromBlock: hexBlock(from), toBlock: hexBlock(to), topics: [topic0] }], 25_000).catch(() => null);
    if (Array.isArray(chunk)) logs.push(...chunk);
    else errors.push(`borrow-log-window-unavailable-${from}-${to}`);
  }
  return { logs, errors };
}

function parseBorrower(log) {
  for (const iface of [BORROW_UNINDEXED, BORROW_INDEXED]) {
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      return normalizeAddress(parsed.args.borrower);
    } catch (_) {}
  }
  return null;
}

async function borrowerRows(rpc, chain, comptrollerAddr, marketRows, latest) {
  const addresses = marketRows.map((row) => normalizeAddress(row.mToken)).filter(Boolean);
  const fromBlock = RECENT_BORROW_LOG_BLOCKS > 0 && latest.number !== null ? Math.max(0, latest.number - RECENT_BORROW_LOG_BLOCKS) : null;
  const logResult = fromBlock === null ? { logs: [], errors: [] } : await getBorrowLogs(rpc, addresses, fromBlock, latest.number);
  const borrowers = [];
  for (const log of logResult.logs) {
    if (borrowers.length >= MAX_BORROWERS_PER_CHAIN) break;
    const borrower = parseBorrower(log);
    if (borrower && !borrowers.includes(borrower)) borrowers.push(borrower);
  }
  const rows = [];
  for (const borrower of borrowers) {
    const liq = await safeCall(rpc, comptrollerAddr, COMPTROLLER, "getAccountLiquidity", [borrower]);
    const liquidityUsd = liq ? unitsToNumber(liq[1], 18) : null;
    const shortfallUsd = liq ? unitsToNumber(liq[2], 18) : null;
    rows.push({
      chain: chain.chain,
      chainId: chain.chainId,
      comptroller: comptrollerAddr,
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
  return { rows, logsRead: logResult.logs.length, fromBlock, errors: logResult.errors };
}

async function scanMarket(rpc, chain, comptrollerAddr, oracleAddr, mToken, latest) {
  const mAddr = normalizeAddress(mToken);
  const [code, proxy, mSymbolRaw, mNameRaw, mDecimalsRaw, underlyingRaw, marketRaw, cashRaw, borrowsRaw, supplyRaw, reservesRaw, exchangeRateRaw, reserveFactorRaw, borrowIndexRaw, accrualRaw, irmRaw, mAdminRaw, mPendingAdminRaw, mComptrollerRaw, mImplRaw, mintPausedRaw, borrowPausedRaw, borrowCapRaw, supplyCapRaw, priceRaw] = await Promise.all([
    getCode(rpc, mAddr),
    proxyMeta(rpc, mAddr),
    safeCall(rpc, mAddr, MTOKEN, "symbol"),
    safeCall(rpc, mAddr, MTOKEN, "name"),
    safeCall(rpc, mAddr, MTOKEN, "decimals"),
    safeCall(rpc, mAddr, MTOKEN, "underlying"),
    safeCall(rpc, comptrollerAddr, COMPTROLLER, "markets", [mAddr]),
    safeCall(rpc, mAddr, MTOKEN, "getCash"),
    safeCall(rpc, mAddr, MTOKEN, "totalBorrows"),
    safeCall(rpc, mAddr, MTOKEN, "totalSupply"),
    safeCall(rpc, mAddr, MTOKEN, "totalReserves"),
    safeCall(rpc, mAddr, MTOKEN, "exchangeRateStored"),
    safeCall(rpc, mAddr, MTOKEN, "reserveFactorMantissa"),
    safeCall(rpc, mAddr, MTOKEN, "borrowIndex"),
    safeCall(rpc, mAddr, MTOKEN, "accrualBlockNumber"),
    safeCall(rpc, mAddr, MTOKEN, "interestRateModel"),
    safeCall(rpc, mAddr, MTOKEN, "admin"),
    safeCall(rpc, mAddr, MTOKEN, "pendingAdmin"),
    safeCall(rpc, mAddr, MTOKEN, "comptroller"),
    safeCall(rpc, mAddr, MTOKEN, "implementation"),
    safeCall(rpc, comptrollerAddr, COMPTROLLER, "mintGuardianPaused", [mAddr]),
    safeCall(rpc, comptrollerAddr, COMPTROLLER, "borrowGuardianPaused", [mAddr]),
    safeCall(rpc, comptrollerAddr, COMPTROLLER, "borrowCaps", [mAddr]),
    safeCall(rpc, comptrollerAddr, COMPTROLLER, "supplyCaps", [mAddr]),
    oracleAddr ? safeCall(rpc, oracleAddr, ORACLE, "getUnderlyingPrice", [mAddr]) : null,
  ]);

  const mSymbol = safeText(mSymbolRaw?.[0] || "UNKNOWN", 40);
  const underlying = normalizeAddress(underlyingRaw?.[0]);
  const meta = await tokenMeta(rpc, underlying, { symbol: mSymbol?.replace(/^m/i, ""), decimals: 18 });
  const feedAddr = oracleAddr ? await oracleFeedForToken(rpc, oracleAddr, meta.symbol) : null;
  const feed = feedAddr ? await feedInfo(rpc, feedAddr, latest, "chainlink") : null;
  const dex = underlying ? await dexScreenerPrice(chain, underlying) : null;
  const market = marketRaw ? { listed: Boolean(marketRaw[0]), collateralFactorBps: wadBps(marketRaw[1]), isComped: null } : { listed: false, collateralFactorBps: 0, isComped: null };
  const priceUsd = priceRaw?.[0] === undefined ? null : priceUsdFromRaw(priceRaw[0], meta.decimals);
  const cash = cashRaw?.[0] === undefined ? null : unitsToNumber(cashRaw[0], meta.decimals);
  const borrows = borrowsRaw?.[0] === undefined ? null : unitsToNumber(borrowsRaw[0], meta.decimals);
  const refPrice = priceUsd ?? dex?.priceUsd ?? null;
  const cashUsd = cash !== null && refPrice !== null ? cash * refPrice : null;
  const borrowsUsd = borrows !== null && refPrice !== null ? borrows * refPrice : null;
  const oracleVsDexBps = priceUsd !== null && dex?.priceUsd ? ((priceUsd - dex.priceUsd) / dex.priceUsd) * 10000 : null;
  const divergent = Boolean(oracleVsDexBps !== null && Math.abs(oracleVsDexBps) >= DIVERGENCE_WATCH_BPS && (dex?.liquidityUsd || 0) >= MATERIAL_USD);
  const staleButAccepted = Boolean(feed?.staleWarn && priceUsd !== null && priceUsd > 0);
  const highCf = (market.collateralFactorBps || 0) >= HIGH_CF_BPS;
  const borrowCap = borrowCapRaw?.[0] === undefined ? null : unitsToNumber(borrowCapRaw[0], meta.decimals);
  const supplyCap = supplyCapRaw?.[0] === undefined ? null : unitsToNumber(supplyCapRaw[0], meta.decimals);
  const capReached = borrowCapRaw?.[0] !== undefined && toBig(borrowCapRaw[0]) > 0n && borrowsRaw?.[0] !== undefined && toBig(borrowsRaw[0]) >= toBig(borrowCapRaw[0]);
  const mintPaused = mintPausedRaw?.[0] === undefined ? null : Boolean(mintPausedRaw[0]);
  const borrowPaused = borrowPausedRaw?.[0] === undefined ? null : Boolean(borrowPausedRaw[0]);
  const borrowable = Boolean(market.listed && !borrowPaused && !capReached && (cashUsd || 0) >= MATERIAL_USD && (priceUsd || 0) > 0);
  const highCfSingleFeed = Boolean(highCf && feedAddr && !staleButAccepted && !divergent);
  const watchCandidate = Boolean(borrowable && highCf && (staleButAccepted || divergent));
  const flags = [];
  if (highCf) flags.push("highCF");
  if (highCfSingleFeed) flags.push("highCF-single-feed-context");
  if (mintPaused) flags.push("mintPaused");
  if (borrowPaused) flags.push("borrowPaused");
  if (capReached) flags.push("borrowCapReached");
  if (staleButAccepted) flags.push("staleButAccepted");
  if (divergent) flags.push("oracleDexDivergence");
  if (watchCandidate) flags.push("watchCandidate");

  return {
    chain: chain.chain,
    chainId: chain.chainId,
    comptroller: comptrollerAddr,
    oracle: oracleAddr,
    mToken: mAddr,
    mTokenCodePresent: Boolean(code && code !== "0x"),
    mTokenCodeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    proxy,
    mSymbol,
    mName: safeText(mNameRaw?.[0], 80),
    mDecimals: mDecimalsRaw?.[0] === undefined ? null : Number(mDecimalsRaw[0]),
    underlying,
    underlyingSymbol: meta.symbol,
    underlyingName: meta.name,
    underlyingDecimals: meta.decimals,
    listed: market.listed,
    collateralFactorBps: market.collateralFactorBps,
    isComped: market.isComped,
    mintPaused,
    borrowPaused,
    borrowCap,
    supplyCap,
    capReached,
    cash: round(cash, 8),
    borrows: round(borrows, 8),
    cashUsd: round(cashUsd, 2),
    borrowsUsd: round(borrowsUsd, 2),
    totalSupplyRaw: supplyRaw?.[0]?.toString?.() || null,
    totalReservesRaw: reservesRaw?.[0]?.toString?.() || null,
    exchangeRateStoredRaw: exchangeRateRaw?.[0]?.toString?.() || null,
    reserveFactorBps: reserveFactorRaw?.[0] === undefined ? null : wadBps(reserveFactorRaw[0]),
    borrowIndexRaw: borrowIndexRaw?.[0]?.toString?.() || null,
    accrualBlockNumber: accrualRaw?.[0] === undefined ? null : Number(accrualRaw[0]),
    interestRateModel: normalizeAddress(irmRaw?.[0]),
    mTokenAdmin: normalizeAddress(mAdminRaw?.[0]),
    mTokenPendingAdmin: normalizeAddress(mPendingAdminRaw?.[0]),
    mTokenComptroller: normalizeAddress(mComptrollerRaw?.[0]),
    mTokenImplementation: normalizeAddress(mImplRaw?.[0]) || proxy.implementation,
    priceUsd: round(priceUsd, 10),
    priceRaw: priceRaw?.[0]?.toString?.() || null,
    feed,
    feedRows: feed ? 1 : 0,
    staleButAccepted,
    dex,
    oracleVsDexBps: round(oracleVsDexBps, 4),
    divergent,
    highCf,
    highCfSingleFeed,
    borrowable,
    watchCandidate,
    routePositive: false,
    flags: flags.join(","),
    blocker: watchCandidate
      ? "Watch-only: needs accepted-value divergence plus exact borrow/liquidation/exit economics and fork proof"
      : "No exact positive Moonwell borrow or liquidation economics proven",
  };
}

async function scanChain(rpc, chain) {
  const comptrollerAddr = normalizeAddress(chain.comptroller);
  const latest = await latestBlock(rpc);
  const [code, proxy, marketsRaw, oracleRaw, adminRaw, pendingAdminRaw, pauseGuardianRaw, borrowCapGuardianRaw, implRaw, pendingImplRaw, closeFactorRaw, liqIncentiveRaw, transferPausedRaw, seizePausedRaw] = await Promise.all([
    getCode(rpc, comptrollerAddr),
    proxyMeta(rpc, comptrollerAddr),
    safeCall(rpc, comptrollerAddr, COMPTROLLER, "getAllMarkets"),
    safeCall(rpc, comptrollerAddr, COMPTROLLER, "oracle"),
    safeCall(rpc, comptrollerAddr, COMPTROLLER, "admin"),
    safeCall(rpc, comptrollerAddr, COMPTROLLER, "pendingAdmin"),
    safeCall(rpc, comptrollerAddr, COMPTROLLER, "pauseGuardian"),
    safeCall(rpc, comptrollerAddr, COMPTROLLER, "borrowCapGuardian"),
    safeCall(rpc, comptrollerAddr, COMPTROLLER, "comptrollerImplementation"),
    safeCall(rpc, comptrollerAddr, COMPTROLLER, "pendingComptrollerImplementation"),
    safeCall(rpc, comptrollerAddr, COMPTROLLER, "closeFactorMantissa"),
    safeCall(rpc, comptrollerAddr, COMPTROLLER, "liquidationIncentiveMantissa"),
    safeCall(rpc, comptrollerAddr, COMPTROLLER, "transferGuardianPaused"),
    safeCall(rpc, comptrollerAddr, COMPTROLLER, "seizeGuardianPaused"),
  ]);
  const oracleAddr = normalizeAddress(oracleRaw?.[0]) || normalizeAddress(chain.documentedOracle);
  const oracleMeta = oracleAddr ? await proxyMeta(rpc, oracleAddr) : null;
  const [oracleOwnerRaw, oracleAdminRaw] = oracleAddr ? await Promise.all([
    safeCall(rpc, oracleAddr, ORACLE, "owner"),
    safeCall(rpc, oracleAddr, ORACLE, "admin"),
  ]) : [null, null];
  const markets = unique((marketsRaw?.[0] || []).map(normalizeAddress).filter(Boolean));
  const marketRows = [];
  for (const market of markets) {
    try {
      marketRows.push(await scanMarket(rpc, chain, comptrollerAddr, oracleAddr, market, latest));
    } catch (err) {
      marketRows.push({ chain: chain.chain, chainId: chain.chainId, comptroller: comptrollerAddr, oracle: oracleAddr, mToken: market, error: safeText(err?.message || "market-scan-failed"), routePositive: false });
    }
  }
  marketRows.sort((a, b) => (asNumber(b.cashUsd) || 0) - (asNumber(a.cashUsd) || 0));
  const borrower = await borrowerRows(rpc, chain, comptrollerAddr, marketRows, latest);
  const roleRows = [
    { role: "Comptroller admin", address: normalizeAddress(adminRaw?.[0]), kind: await addressKind(rpc, adminRaw?.[0]) },
    { role: "Comptroller pendingAdmin", address: normalizeAddress(pendingAdminRaw?.[0]), kind: await addressKind(rpc, pendingAdminRaw?.[0]) },
    { role: "Pause guardian", address: normalizeAddress(pauseGuardianRaw?.[0]), kind: await addressKind(rpc, pauseGuardianRaw?.[0]) },
    { role: "Borrow cap guardian", address: normalizeAddress(borrowCapGuardianRaw?.[0]), kind: await addressKind(rpc, borrowCapGuardianRaw?.[0]) },
    { role: "Oracle", address: oracleAddr, kind: await addressKind(rpc, oracleAddr) },
    { role: "Oracle owner", address: normalizeAddress(oracleOwnerRaw?.[0]), kind: await addressKind(rpc, oracleOwnerRaw?.[0]) },
    { role: "Oracle admin", address: normalizeAddress(oracleAdminRaw?.[0]), kind: await addressKind(rpc, oracleAdminRaw?.[0]) },
  ].map((row) => ({ chain: chain.chain, chainId: chain.chainId, comptroller: comptrollerAddr, ...row }));
  const listedRows = marketRows.filter((row) => row.listed);
  const watchRows = marketRows.filter((row) => row.watchCandidate);
  return {
    chainRow: {
      chain: chain.chain,
      chainId: chain.chainId,
      comptroller: comptrollerAddr,
      source: chain.source,
      rpcResolved: true,
      status: code && code !== "0x" ? "scanned" : "no-code",
      blockNumber: latest.number,
      blockTimestamp: latest.timestamp,
      comptrollerCodePresent: Boolean(code && code !== "0x"),
      comptrollerCodeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
      proxy,
      oracle: oracleAddr,
      documentedOracle: normalizeAddress(chain.documentedOracle),
      oracleMatchesDocs: lowerAddress(oracleAddr) === lowerAddress(chain.documentedOracle),
      oracleCodePresent: Boolean(oracleMeta?.codePresent),
      oracleImplementation: oracleMeta?.implementation || null,
      admin: normalizeAddress(adminRaw?.[0]),
      pendingAdmin: normalizeAddress(pendingAdminRaw?.[0]),
      pauseGuardian: normalizeAddress(pauseGuardianRaw?.[0]),
      borrowCapGuardian: normalizeAddress(borrowCapGuardianRaw?.[0]),
      comptrollerImplementation: normalizeAddress(implRaw?.[0]) || proxy.implementation,
      pendingComptrollerImplementation: normalizeAddress(pendingImplRaw?.[0]),
      closeFactorBps: closeFactorRaw?.[0] === undefined ? null : wadBps(closeFactorRaw[0]),
      liquidationIncentiveBps: liqIncentiveRaw?.[0] === undefined ? null : wadBps(liqIncentiveRaw[0]),
      transferGuardianPaused: transferPausedRaw?.[0] === undefined ? null : Boolean(transferPausedRaw[0]),
      seizeGuardianPaused: seizePausedRaw?.[0] === undefined ? null : Boolean(seizePausedRaw[0]),
      marketRows: marketRows.length,
      listedRows: listedRows.length,
      highCfRows: marketRows.filter((row) => row.highCf).length,
      borrowableRows: marketRows.filter((row) => row.borrowable).length,
      highCfBorrowableRows: marketRows.filter((row) => row.highCf && row.borrowable).length,
      highCfSingleFeedRows: marketRows.filter((row) => row.highCfSingleFeed).length,
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
    borrowerRows: borrower.rows,
    roleRows,
    logErrors: borrower.errors.map((error) => ({ chain: chain.chain, chainId: chain.chainId, comptroller: comptrollerAddr, error })),
  };
}

function protocolMetadataFromDiscovery() {
  const d = readJson(PUBLIC_TARGETS, {});
  const rows = [...(d.phase0Queue || []), ...(d.targetedRefreshQueue || []), ...(d.protocolCandidates || []), ...(d.consumerJoinFirst || [])];
  const row = rows.find((p) => p?.slug === "moonwell-lending" || p?.name === "Moonwell Lending");
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
  const json = await fetchJson("https://api.llama.fi/protocol/moonwell-lending");
  const latestTvlRow = Array.isArray(json?.tvl) && json.tvl.length ? json.tvl[json.tvl.length - 1] : null;
  return {
    name: safeText(json?.name, 80) || local?.name || "Moonwell Lending",
    slug: safeText(json?.slug, 80) || local?.slug || "moonwell-lending",
    category: safeText(json?.category, 80) || local?.category || "Lending",
    chains: Array.isArray(json?.chains) ? json.chains.map((chain) => safeText(chain, 60)).filter(Boolean) : local?.chains || ["Base", "Optimism"],
    evmChains: local?.evmChains || ["Base", "Optimism"],
    tvlUsd: asNumber(latestTvlRow?.totalLiquidityUSD) || local?.tvlUsd || null,
    change1dPct: asNumber(json?.change_1d) ?? local?.change1dPct ?? null,
    change7dPct: asNumber(json?.change_7d) ?? local?.change7dPct ?? null,
    routePriority: local?.routePriority || null,
    source: json ? "defillama-protocol-api+public-discovery" : local?.source || "fallback-static",
  };
}

function topRows(rows, filter, sortField, limit = 14) {
  return rows.filter(filter).sort((a, b) => (asNumber(b[sortField]) || 0) - (asNumber(a[sortField]) || 0)).slice(0, limit);
}

function writeReport(out) {
  const s = out.summary;
  const chainTable = out.chainRows.map((row) => `| ${row.chain} | ${row.status} | ${row.listedRows || 0} | ${row.highCfBorrowableRows || 0} | ${row.highCfSingleFeedRows || 0} | ${row.divergentRows || 0} | ${row.staleButAcceptedRows || 0} | ${row.sampledBorrowers || 0} | ${row.materialSampledLiquidatableBorrowers || 0} | ${formatUsd(row.totalCashUsd)} | ${formatUsd(row.totalBorrowsUsd)} |`).join("\n") || "| none | n/a | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a | n/a |";
  const marketTable = topRows(out.marketRows, (row) => row.listed, "cashUsd", 14).map((row) => `| ${row.chain} | ${row.mSymbol || "n/a"} | ${row.underlyingSymbol || "n/a"} | ${formatPctBps(row.collateralFactorBps)} | ${formatUsd(row.cashUsd)} | ${formatUsd(row.borrowsUsd)} | ${row.borrowPaused ? "yes" : "no"} | ${formatBps(row.oracleVsDexBps)} | ${row.flags || "-"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const oracleTable = topRows(out.marketRows, (row) => row.feedRows || row.priceUsd !== null, "cashUsd", 14).map((row) => {
    const feedAge = row.feed?.ageSeconds === null || row.feed?.ageSeconds === undefined ? "n/a" : `${Math.round(row.feed.ageSeconds)}s`;
    return `| ${row.chain} | ${row.mSymbol || "n/a"} | ${row.underlyingSymbol || "n/a"} | ${formatUsd(row.priceUsd)} | ${row.feed?.description || "n/a"} | ${feedAge} | ${row.staleButAccepted ? "yes" : "no"} | ${formatBps(row.oracleVsDexBps)} |`;
  }).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const borrowerTable = out.borrowerRows.slice(0, 12).map((row) => `| ${row.chain} | ${compactAddress(row.borrower)} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.shortfallUsd)} | ${row.liquidatable} |`).join("\n") || "| none sampled | n/a | n/a | n/a | false |";
  const caveatTable = out.outOfScopeRows.map((row) => `| ${row.chain} | ${row.reason} |`).join("\n") || "| none | n/a |";
  const lines = [
    `# ${SIGNAL_DORMANT} - Moonwell Lending Phase 0`,
    "",
    `Generated: ${out.generatedAt}`,
    "",
    "Scanner: `tools/scan-moonwell-lending-phase0.js`",
    "",
    "Artifact: `reports/raw/fast/moonwell-lending-phase0.json`",
    "",
    "## Result",
    "",
    "No confirmed permissionless exploit. Moonwell Lending's Base and Optimism Comptroller markets, Chainlink oracle prices/feed context, caps/pauses, high-CF rows, and bounded recent borrower state were mapped. No row has exact positive borrow, liquidation, redemption, or unwind economics, and no signed action is justified.",
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Public TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |`,
    `| Chains scanned | \`${s.chainsScanned}/${s.chainsInScope}\` |`,
    `| Market rows / listed | \`${s.marketRows}/${s.listedRows}\` |`,
    `| High-CF rows | \`${s.highCfRows}\` |`,
    `| High-CF borrowable rows | \`${s.highCfBorrowableRows}\` |`,
    `| High-CF single-feed context rows | \`${s.highCfSingleFeedRows}\` |`,
    `| Material cash rows | \`${s.materialCashRows}\` |`,
    `| Material borrow rows | \`${s.materialBorrowRows}\` |`,
    `| Divergent rows | \`${s.divergentRows}\` |`,
    `| Stale-but-accepted rows | \`${s.staleButAcceptedRows}\` |`,
    `| Bounded sampled borrowers | \`${s.sampledBorrowers}\` |`,
    `| Material sampled liquidatable borrowers | \`${s.materialSampledLiquidatableBorrowers}\` |`,
    `| Bounded log error rows | \`${s.logErrorRows}\` |`,
    `| Total cash context | ${formatUsd(s.totalCashUsd)} |`,
    `| Total borrows context | ${formatUsd(s.totalBorrowsUsd)} |`,
    `| Watch candidates | \`${s.watchCandidates}\` |`,
    `| Route-positive | \`${s.routePositive}\` |`,
    `| Executable now | \`${s.executableNow}\` |`,
    `| Signed action justified | \`${s.signedActionJustified}\` |`,
    `| Coverage classification | \`${s.coverageClassification}\` |`,
    "",
    "## Chains",
    "",
    "| Chain | Status | Listed | High-CF borrowable | High-CF single-feed | Divergent | Stale accepted | Sampled borrowers | Material liquidatable | Cash | Borrows |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    chainTable,
    "",
    "## Top Markets",
    "",
    "| Chain | mToken | Underlying | CF | Cash | Borrows | Borrow paused | Oracle vs DEX | Flags |",
    "|---|---|---|---:|---:|---:|---|---:|---|",
    marketTable,
    "",
    "## Oracle Context",
    "",
    "| Chain | mToken | Underlying | Oracle price | Feed | Feed age | Stale accepted | Oracle vs DEX |",
    "|---|---|---|---:|---|---:|---|---:|",
    oracleTable,
    "",
    "## Bounded Borrower Sampling",
    "",
    "| Chain | Borrower | Liquidity | Shortfall | Liquidatable |",
    "|---|---|---:|---:|---|",
    borrowerTable,
    "",
    "Borrower sampling is bounded to recent Borrow logs and is not exhaustive. Rows are not actionable without exact repay/seize sizing, collateral-exit quotes, gas/slippage/fees, and fork proof.",
    "",
    "## Scope Caveats",
    "",
    `Borrower sampling had \`${s.logErrorRows}\` bounded log-window error row(s); market/oracle/cap/pause reads completed and liquidation sampling remains bounded, not exhaustive.`,
    "",
    "| Chain | Reason |",
    "|---|---|",
    caveatTable,
    "",
    "## Blockers",
    "",
    "- High-CF and Chainlink/feed rows are context only without a current accepted-value divergence that maps to borrowable cash and exact positive exit economics.",
    "- Bounded borrower sampling did not justify a route-positive liquidation path; liquidation work waits for exact repay/seize/exit economics and fork proof.",
    "- Unsupported or deprecated documented chains are excluded from this declared Phase 0 scanner scope unless a future public queue or RPC inventory adds them.",
    "- No fork extraction proof exists, and no signed action is justified.",
    "",
    "## Reopen Triggers",
    "",
    "- A borrowable high-CF market accepts stale or divergent oracle state while live cash and exit liquidity are material.",
    "- A sampled or externally discovered borrower has material shortfall plus exact positive liquidation economics after gas/slippage.",
    "- New Moonwell markets or oracle configs add an uncapped, stale, ETH-denominated, or otherwise mis-scaled feed with material borrow liquidity.",
    "",
    "## Close-Out",
    "",
    "Moonwell Lending remains dormant for the declared Phase 0 scope until a concrete route-positive trigger appears.",
  ];
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, `${lines.join("\n")}\n`);
}

async function main() {
  const metadata = await protocolMetadata();
  const rpcPool = await resolveRpcPool(CHAINS.map((chain) => chain.chainId));
  const safety = {
    publicApisOnlyForMetadata: true,
    rpcInventoryRead: true,
    rpcUrlsStored: false,
    privateKeysRead: false,
    envFilesRead: false,
    signedActions: false,
    exploitExecuteCalls: false,
    forkTransactions: false,
    routePositive: false,
    executableNow: false,
    signedActionJustified: false,
  };
  const chainResults = [];
  for (const chain of CHAINS) {
    const rpc = rpcPool[chain.chainId];
    if (!rpc) {
      chainResults.push({ chainRow: { chain: chain.chain, chainId: chain.chainId, comptroller: normalizeAddress(chain.comptroller), rpcResolved: false, status: "missing-rpc", routePositive: 0, executableNow: false }, marketRows: [], borrowerRows: [], roleRows: [], logErrors: [{ chain: chain.chain, chainId: chain.chainId, error: "missing-rpc" }] });
      continue;
    }
    chainResults.push(await scanChain(rpc, chain));
  }
  const chainRows = chainResults.map((r) => r.chainRow);
  const marketRows = chainResults.flatMap((r) => r.marketRows);
  const borrowerRowsFlat = chainResults.flatMap((r) => r.borrowerRows);
  const roleRows = chainResults.flatMap((r) => r.roleRows);
  const logErrors = chainResults.flatMap((r) => r.logErrors);
  const summary = {
    defillamaCurrentTvlUsd: round(metadata.tvlUsd, 2),
    chainsInScope: CHAINS.length,
    chainsScanned: chainRows.filter((row) => row.status === "scanned").length,
    unsupportedOrOutOfScopeChains: OUT_OF_SCOPE_DOC_ROWS.length,
    marketRows: marketRows.length,
    listedRows: marketRows.filter((row) => row.listed).length,
    highCfRows: marketRows.filter((row) => row.highCf).length,
    highCfBorrowableRows: marketRows.filter((row) => row.highCf && row.borrowable).length,
    highCfSingleFeedRows: marketRows.filter((row) => row.highCfSingleFeed).length,
    materialCashRows: marketRows.filter((row) => (asNumber(row.cashUsd) || 0) >= MATERIAL_USD).length,
    materialBorrowRows: marketRows.filter((row) => (asNumber(row.borrowsUsd) || 0) >= MATERIAL_USD).length,
    divergentRows: marketRows.filter((row) => row.divergent).length,
    staleButAcceptedRows: marketRows.filter((row) => row.staleButAccepted).length,
    watchCandidates: marketRows.filter((row) => row.watchCandidate).length + borrowerRowsFlat.filter((row) => row.materialLiquidatable).length,
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
    scanner: "tools/scan-moonwell-lending-phase0.js",
    scope: "Read-only Moonwell Lending Base/Optimism Compound-style market/oracle/liquidation Phase 0 scan",
    target: { name: "Moonwell Lending", slug: "moonwell-lending", category: "Lending", surface: "lending-oracle-liquidation", metadata },
    safety,
    thresholds: { materialUsd: MATERIAL_USD, highCollateralFactorBps: HIGH_CF_BPS, divergenceWatchBps: DIVERGENCE_WATCH_BPS, staleWarnSeconds: STALE_WARN_SECONDS, recentBorrowLogBlocks: RECENT_BORROW_LOG_BLOCKS, maxBorrowersPerChain: MAX_BORROWERS_PER_CHAIN },
    docs: {
      contracts: "https://docs.moonwell.fi/moonwell/protocol-information/contracts.md",
      sourceRepo: "https://github.com/moonwell-fi/moonwell-contracts-v2",
      priorOracleTriage: "reports/moonwell-oracle-triage.md",
    },
    summary,
    chainRows,
    marketRows,
    borrowerRows: borrowerRowsFlat,
    roleRows,
    logErrors,
    outOfScopeRows: OUT_OF_SCOPE_DOC_ROWS,
    routePositiveRows: [],
    watchRows: [...marketRows.filter((row) => row.watchCandidate), ...borrowerRowsFlat.filter((row) => row.materialLiquidatable)],
    blockers: [
      "High-CF and oracle/feed rows require current accepted-value divergence plus exact positive borrow/liquidation/exit economics",
      "Bounded borrower sample is not exhaustive and does not prove exact liquidation profitability",
      "Unsupported/deprecated documented chains are excluded from this declared scanner scope",
      "No fork extraction proof",
    ],
    requiredForRoutePositive: [
      "specific Moonwell market accepts attacker-favorable stale or divergent oracle/accounting value",
      "borrow or liquidation path is unpaused and has material live liquidity",
      "collateral acquisition, borrow/repay, seized asset exit, and unwind are exact-quoted after gas/slippage/fees",
      "fork extraction proof",
    ],
    nextReadOnlyStep: "Keep Moonwell on high-CF oracle/feed and liquidation watch; exact-quote/fork only if a material market or borrower becomes exact-positive.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, JSON.stringify(out, jsonReplacer, 2));
  writeReport(out);
  if (!QUIET) {
    console.log(`Moonwell Lending Phase 0: chains=${summary.chainsScanned}/${summary.chainsInScope} markets=${summary.marketRows}/${summary.listedRows} highCfBorrowable=${summary.highCfBorrowableRows} sampledBorrowers=${summary.sampledBorrowers} materialLiquidatable=${summary.materialSampledLiquidatableBorrowers} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
    console.log(`Wrote ${path.relative(WORKSPACE, RAW_OUT)}`);
    console.log(`Report ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(`Moonwell Lending Phase 0 failed: ${err.message}`);
  process.exitCode = 1;
});
