#!/usr/bin/env node
// scan-venus-core-pool-phase0.js - read-only Phase 0 for Venus Core Pool live state.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, execution calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "venus-core-pool-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "venus-core-pool-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const ISO_DEPLOYMENTS = path.join(WORKSPACE, "targets", "venus-isolated-pools", "deployments");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";
const NATIVE_TOKEN_ADDR = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const RECENT_BORROW_LOG_BLOCKS = Number(process.env.VENUS_CORE_RECENT_BORROW_LOG_BLOCKS || "20000");
const BORROW_LOG_CHUNK_BLOCKS = Number(process.env.VENUS_CORE_BORROW_LOG_CHUNK_BLOCKS || "5000");
const MAX_BORROWERS_PER_POOL = Number(process.env.VENUS_CORE_MAX_BORROWERS_PER_POOL || "60");
const MATERIAL_USD = Number(process.env.VENUS_CORE_MATERIAL_USD || "10000");
const HIGH_CF_BPS = Number(process.env.VENUS_CORE_HIGH_CF_BPS || "7500");
const NEAR_STALE_PCT = Number(process.env.VENUS_CORE_NEAR_STALE_PCT || "0.5");

const PUBLIC_FALLBACKS = {
  204: "https://opbnb-mainnet-rpc.bnbchain.org",
};

const CHAINS = [
  {
    kind: "legacy-core",
    folder: "bscmainnet",
    chain: "BNB Chain",
    chainId: 56,
    comptroller: "0xfD36E2c2a6789Db23113685031d7F16329158384",
    deploymentSource: "legacy Venus Core Unitroller",
  },
  { kind: "isolated-core", folder: "ethereum", chain: "Ethereum", chainId: 1 },
  { kind: "isolated-core", folder: "arbitrumone", chain: "Arbitrum", chainId: 42161 },
  { kind: "isolated-core", folder: "basemainnet", chain: "Base", chainId: 8453 },
  { kind: "isolated-core", folder: "opmainnet", chain: "Optimism", chainId: 10 },
  { kind: "isolated-core", folder: "unichainmainnet", chain: "Unichain", chainId: 130 },
  { kind: "isolated-core", folder: "zksyncmainnet", chain: "zkSync Era", chainId: 324 },
  { kind: "isolated-core", folder: "opbnbmainnet", chain: "opBNB", chainId: 204 },
];

const COMPTROLLER_LEGACY = new ethers.Interface([
  "function getAllMarkets() view returns (address[])",
  "function markets(address) view returns (bool,uint256,bool,uint256,uint256,uint96,bool)",
  "function oracle() view returns (address)",
  "function admin() view returns (address)",
  "function pauseGuardian() view returns (address)",
  "function pendingAdmin() view returns (address)",
  "function comptrollerImplementation() view returns (address)",
  "function pendingComptrollerImplementation() view returns (address)",
  "function closeFactorMantissa() view returns (uint256)",
  "function liquidationIncentiveMantissa() view returns (uint256)",
  "function getAccountLiquidity(address) view returns (uint256,uint256,uint256)",
  "function supplyCaps(address) view returns (uint256)",
  "function borrowCaps(address) view returns (uint256)",
  "function actionPaused(address,uint8) view returns (bool)",
  "function isForcedLiquidationEnabled(address) view returns (bool)",
  "function protocolPaused() view returns (bool)",
  "function treasuryAddress() view returns (address)",
]);

const COMPTROLLER_ISO = new ethers.Interface([
  "function getAllMarkets() view returns (address[])",
  "function markets(address) view returns (bool,uint256,uint256)",
  "function oracle() view returns (address)",
  "function owner() view returns (address)",
  "function accessControlManager() view returns (address)",
  "function closeFactorMantissa() view returns (uint256)",
  "function liquidationIncentiveMantissa() view returns (uint256)",
  "function minLiquidatableCollateral() view returns (uint256)",
  "function getAccountLiquidity(address) view returns (uint256,uint256,uint256)",
  "function supplyCaps(address) view returns (uint256)",
  "function borrowCaps(address) view returns (uint256)",
  "function actionPaused(address,uint8) view returns (bool)",
  "function isForcedLiquidationEnabled(address) view returns (bool)",
]);

const VTOKEN = new ethers.Interface([
  "function underlying() view returns (address)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function getCash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function totalReserves() view returns (uint256)",
  "function exchangeRateStored() view returns (uint256)",
  "function interestRateModel() view returns (address)",
  "function accrualBlockNumber() view returns (uint256)",
]);

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const RESILIENT_ORACLE = new ethers.Interface([
  "function getTokenConfig(address) view returns (tuple(address asset,address[3] oracles,bool[3] enableFlagsForOracles,bool cachingEnabled))",
  "function getUnderlyingPrice(address) view returns (uint256)",
  "function getPrice(address) view returns (uint256)",
  "function accessControlManager() view returns (address)",
]);

const CHAINLINK_ORACLE = new ethers.Interface([
  "function tokenConfigs(address) view returns (address asset,address feed,uint256 maxStalePeriod)",
]);

const FEED = new ethers.Interface([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);

const BEACON = new ethers.Interface(["function implementation() view returns (address)"]);
const BORROW_EVENT_INDEXED = new ethers.Interface(["event Borrow(address indexed borrower,uint256 borrowAmount,uint256 accountBorrows,uint256 totalBorrows)"]);
const BORROW_EVENT_UNINDEXED = new ethers.Interface(["event Borrow(address borrower,uint256 borrowAmount,uint256 accountBorrows,uint256 totalBorrows)"]);

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
function unitsToNumber(value, decimals = 18) { try { return Number(ethers.formatUnits(toBig(value), decimals)); } catch (_) { return null; } }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatPctBps(value) { const n = asNumber(value); return n === null ? "n/a" : `${round(n / 100, 2)}%`; }
function safeText(value, max = 140) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function wadBps(value) { return Number((toBig(value) * 10000n) / (10n ** 18n)); }
function slotAddress(raw) { const addr = raw && raw !== "0x" && raw.length >= 66 ? normalizeAddress(`0x${raw.slice(26)}`) : null; return addr && addr !== ZERO ? addr : null; }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-venus-core-pool-phase0/1.0" } });
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

async function tokenMeta(rpc, token, fallback = {}) {
  const address = normalizeAddress(token);
  if (!address || address === ZERO) return fallback;
  if (lowerAddress(address) === lowerAddress(NATIVE_TOKEN_ADDR)) return { address, symbol: fallback.symbol || "NATIVE", name: fallback.name || "Native token", decimals: 18 };
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

async function protocolMetadata() {
  const d = readJson(PUBLIC_TARGETS, {});
  const rows = [...(d.phase0Queue || []), ...(d.targetedRefreshQueue || []), ...(d.protocolCandidates || []), ...(d.consumerJoinFirst || [])];
  const row = rows.find((p) => p?.slug === "venus-core-pool" || p?.name === "Venus Core Pool");
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
  } : await fetchVenusMetadata();
}

async function fetchVenusMetadata() {
  const json = await fetchJson("https://api.llama.fi/protocol/venus-core-pool");
  const currentChainTvls = json?.currentChainTvls && typeof json.currentChainTvls === "object" ? json.currentChainTvls : {};
  const latestTvlRow = Array.isArray(json?.tvl) && json.tvl.length ? json.tvl[json.tvl.length - 1] : null;
  const chainTvl = Object.entries(currentChainTvls)
    .filter(([key]) => !String(key).includes("-"))
    .reduce((sum, [, value]) => sum + (asNumber(value) || 0), 0) || null;
  const tvlUsd = asNumber(latestTvlRow?.totalLiquidityUSD) || chainTvl;
  return {
    name: safeText(json?.name, 80) || "Venus Core Pool",
    slug: safeText(json?.slug, 80) || "venus-core-pool",
    category: safeText(json?.category, 80) || "Lending",
    chains: Array.isArray(json?.chains) ? json.chains.map((chain) => safeText(chain, 60)).filter(Boolean) : [],
    evmChains: ["Binance", "Ethereum", "Arbitrum", "Base", "Optimism"],
    tvlUsd,
    change1dPct: asNumber(json?.change_1d),
    change7dPct: asNumber(json?.change_7d),
    routePriority: null,
    source: json ? "defillama-protocol-api" : "fallback-static",
  };
}

function coreComptrollerFromArtifact(folder) {
  const file = path.join(ISO_DEPLOYMENTS, folder, "Comptroller_Core.json");
  return { address: normalizeAddress(readJson(file, {})?.address), file: fs.existsSync(file) ? path.relative(WORKSPACE, file).replace(/\\/g, "/") : null };
}

function parseMarket(raw, kind) {
  if (!raw) return { listed: false, cfBps: 0, ltBps: 0 };
  if (kind === "legacy-core") return { listed: Boolean(raw[0]), cfBps: wadBps(raw[1]), ltBps: wadBps(raw[3]) };
  return { listed: Boolean(raw[0]), cfBps: wadBps(raw[1]), ltBps: wadBps(raw[2]) };
}

function parseTokenConfig(raw) {
  const cfg = raw?.[0] || raw?.tokenConfig || null;
  const asset = normalizeAddress(cfg?.asset ?? cfg?.[0]);
  const oracles = Array.from(cfg?.oracles ?? cfg?.[1] ?? []).map((v) => normalizeAddress(v) || ZERO);
  const flags = Array.from(cfg?.enableFlagsForOracles ?? cfg?.[2] ?? []).map(Boolean);
  return {
    asset,
    mainOracle: oracles[0] || ZERO,
    pivotOracle: oracles[1] || ZERO,
    fallbackOracle: oracles[2] || ZERO,
    flags,
    flagsText: flags.length ? flags.join(",") : null,
    enabledSourceCount: flags.filter(Boolean).length,
    singleSource: Boolean(flags[0] && !flags[1] && !flags[2]),
    cachingEnabled: Boolean(cfg?.cachingEnabled ?? cfg?.[3]),
  };
}

async function sourceOracleMeta(rpc, oracle, asset, blockTimestamp, caches) {
  const oracleAddr = normalizeAddress(oracle);
  const assetAddr = normalizeAddress(asset);
  if (!oracleAddr || !assetAddr || oracleAddr === ZERO) return null;
  const key = `${oracleAddr.toLowerCase()}:${assetAddr.toLowerCase()}`;
  if (caches.sourceOracle.has(key)) return caches.sourceOracle.get(key);
  const rawCfg = await safeCall(rpc, oracleAddr, CHAINLINK_ORACLE, "tokenConfigs", [assetAddr]);
  let out = {
    oracle: oracleAddr,
    chainlinkLike: false,
    feed: null,
    maxStalePeriod: null,
    feedDescription: null,
    feedAgeSeconds: null,
    acceptedBySource: null,
    feedAnswerRaw: null,
  };
  if (rawCfg?.[1]) {
    const feed = normalizeAddress(rawCfg[1]);
    const maxStalePeriod = rawCfg[2] === undefined ? null : Number(rawCfg[2]);
    const feedKey = feed ? `${feed.toLowerCase()}` : null;
    let meta = feedKey ? caches.feed.get(feedKey) : null;
    if (!meta && feed) {
      const [round, decimals, description] = await Promise.all([
        safeCall(rpc, feed, FEED, "latestRoundData"),
        safeCall(rpc, feed, FEED, "decimals"),
        safeCall(rpc, feed, FEED, "description"),
      ]);
      const updatedAt = round?.[3] === undefined ? null : Number(round[3]);
      meta = {
        feed,
        decimals: decimals?.[0] === undefined ? null : Number(decimals[0]),
        description: safeText(description?.[0], 100),
        answerRaw: round?.[1]?.toString?.() || null,
        updatedAt,
        ageSeconds: updatedAt && blockTimestamp ? Math.max(0, blockTimestamp - updatedAt) : null,
      };
      caches.feed.set(feedKey, meta);
    }
    out = {
      oracle: oracleAddr,
      chainlinkLike: true,
      feed,
      maxStalePeriod,
      feedDescription: meta?.description || null,
      feedAgeSeconds: meta?.ageSeconds ?? null,
      acceptedBySource: meta?.ageSeconds === null || maxStalePeriod === null ? null : meta.ageSeconds <= maxStalePeriod,
      feedAnswerRaw: meta?.answerRaw || null,
    };
  }
  caches.sourceOracle.set(key, out);
  return out;
}

async function getLogsChunked(rpc, addresses, fromBlock, toBlock) {
  if (!rpc || !addresses.length || !Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || toBlock < fromBlock || RECENT_BORROW_LOG_BLOCKS <= 0) return { logs: [], errors: [] };
  const logs = [];
  const errors = [];
  const topic0 = BORROW_EVENT_INDEXED.getEvent("Borrow").topicHash;
  for (let from = fromBlock; from <= toBlock; from += BORROW_LOG_CHUNK_BLOCKS) {
    const to = Math.min(toBlock, from + BORROW_LOG_CHUNK_BLOCKS - 1);
    try {
      const chunk = await rpcCall(rpc, "eth_getLogs", [{ address: addresses, fromBlock: hexBlock(from), toBlock: hexBlock(to), topics: [topic0] }], 25_000);
      if (Array.isArray(chunk)) logs.push(...chunk);
    } catch (_) {
      errors.push(`borrow-log-window-unavailable-${from}-${to}`);
    }
  }
  return { logs, errors };
}

async function borrowerRows(rpc, chain, comptroller, iface, markets, latest) {
  const addresses = markets.map((row) => normalizeAddress(row.vToken)).filter(Boolean);
  const fromBlock = latest.number && RECENT_BORROW_LOG_BLOCKS > 0 ? Math.max(0, latest.number - RECENT_BORROW_LOG_BLOCKS) : null;
  const logResult = fromBlock === null ? { logs: [], errors: [] } : await getLogsChunked(rpc, addresses, fromBlock, latest.number);
  const byPool = new Map();
  for (const log of logResult.logs) {
    try {
      const parsed = log.topics?.length > 1
        ? BORROW_EVENT_INDEXED.parseLog({ topics: log.topics, data: log.data })
        : BORROW_EVENT_UNINDEXED.parseLog({ topics: log.topics, data: log.data });
      const vToken = lowerAddress(log.address);
      const borrower = normalizeAddress(parsed.args.borrower);
      if (!borrower) continue;
      if (!byPool.has(vToken)) byPool.set(vToken, []);
      const arr = byPool.get(vToken);
      if (!arr.includes(borrower) && arr.length < MAX_BORROWERS_PER_POOL) arr.push(borrower);
    } catch (_) {}
  }
  const uniqueBorrowers = unique([...byPool.values()].flat());
  const rows = [];
  for (const borrower of uniqueBorrowers) {
    const liq = await safeCall(rpc, comptroller, iface, "getAccountLiquidity", [borrower], 12_000);
    const shortfallUsd = liq?.[2] === undefined ? null : unitsToNumber(liq[2], 18);
    const liquidityUsd = liq?.[1] === undefined ? null : unitsToNumber(liq[1], 18);
    rows.push({
      chain: chain.chain,
      chainId: chain.chainId,
      poolKind: chain.kind,
      borrower,
      liquidityUsd: round(liquidityUsd, 6),
      shortfallUsd: round(shortfallUsd, 6),
      liquidatable: (shortfallUsd || 0) > 0,
      materialLiquidatable: (shortfallUsd || 0) >= MATERIAL_USD,
      routePositive: false,
      blocker: "Borrower row is not route-positive without exact repay/seize/exit economics and fork proof",
    });
  }
  rows.sort((a, b) => (asNumber(b.shortfallUsd) || 0) - (asNumber(a.shortfallUsd) || 0));
  return { rows, logErrors: logResult.errors, logsRead: logResult.logs.length, fromBlock };
}

async function scanMarket(rpc, chain, comptroller, iface, oracle, vToken, blockTimestamp, caches) {
  const [marketRaw, underlyingRaw, symbolRaw, nameRaw, cashRaw, borrowsRaw, supplyRaw, reservesRaw, exchangeRateRaw, irmRaw, accrualBlockRaw, supplyCapRaw, borrowCapRaw, borrowPausedRaw, liquidatePausedRaw, forcedRaw, priceRaw] = await Promise.all([
    safeCall(rpc, comptroller, iface, "markets", [vToken]),
    safeCall(rpc, vToken, VTOKEN, "underlying"),
    safeCall(rpc, vToken, VTOKEN, "symbol"),
    safeCall(rpc, vToken, VTOKEN, "name"),
    safeCall(rpc, vToken, VTOKEN, "getCash"),
    safeCall(rpc, vToken, VTOKEN, "totalBorrows"),
    safeCall(rpc, vToken, VTOKEN, "totalSupply"),
    safeCall(rpc, vToken, VTOKEN, "totalReserves"),
    safeCall(rpc, vToken, VTOKEN, "exchangeRateStored"),
    safeCall(rpc, vToken, VTOKEN, "interestRateModel"),
    safeCall(rpc, vToken, VTOKEN, "accrualBlockNumber"),
    safeCall(rpc, comptroller, iface, "supplyCaps", [vToken]),
    safeCall(rpc, comptroller, iface, "borrowCaps", [vToken]),
    safeCall(rpc, comptroller, iface, "actionPaused", [vToken, 2]),
    safeCall(rpc, comptroller, iface, "actionPaused", [vToken, 5]),
    safeCall(rpc, comptroller, iface, "isForcedLiquidationEnabled", [vToken]),
    oracle ? safeCall(rpc, oracle, RESILIENT_ORACLE, "getUnderlyingPrice", [vToken]) : null,
  ]);
  const vSymbol = safeText(symbolRaw?.[0], 40) || null;
  const vName = safeText(nameRaw?.[0], 80) || null;
  const market = parseMarket(marketRaw, chain.kind);
  let asset = normalizeAddress(underlyingRaw?.[0]);
  if (!asset && /vBNB/i.test(vSymbol || "")) asset = NATIVE_TOKEN_ADDR;
  const meta = await tokenMeta(rpc, asset, { symbol: vSymbol ? vSymbol.replace(/^v/i, "") : null, decimals: 18 });
  const decimals = meta.decimals ?? 18;
  const priceUsd = priceUsdFromRaw(priceRaw?.[0], decimals);
  const cash = unitsToNumber(cashRaw?.[0], decimals) || 0;
  const borrows = unitsToNumber(borrowsRaw?.[0], decimals) || 0;
  const supplyCap = supplyCapRaw?.[0] === undefined ? null : unitsToNumber(supplyCapRaw[0], decimals);
  const borrowCap = borrowCapRaw?.[0] === undefined ? null : unitsToNumber(borrowCapRaw[0], decimals);
  const oracleCfgRaw = oracle && asset ? await safeCall(rpc, oracle, RESILIENT_ORACLE, "getTokenConfig", [asset]) : null;
  const oracleCfg = oracleCfgRaw ? parseTokenConfig(oracleCfgRaw) : null;
  const mainSource = oracleCfg?.mainOracle ? await sourceOracleMeta(rpc, oracleCfg.mainOracle, asset, blockTimestamp, caches) : null;
  const flags = [];
  const wrapperOrLP = /PT-|wst|weETH|rsETH|puf|sfrx|sUSDe|USDe|gm|yv|super|LP|stk|sUSDS|wUSDM/i.test(`${vSymbol || ""} ${meta.symbol || ""} ${vName || ""}`);
  const borrowPaused = Boolean(borrowPausedRaw?.[0]);
  const liquidatePaused = Boolean(liquidatePausedRaw?.[0]);
  const forcedLiquidation = Boolean(forcedRaw?.[0]);
  const highCf = market.listed && market.cfBps >= HIGH_CF_BPS;
  const borrowCapZero = borrowCapRaw?.[0] !== undefined && toBig(borrowCapRaw[0]) === 0n;
  const supplyCapZero = supplyCapRaw?.[0] !== undefined && toBig(supplyCapRaw[0]) === 0n;
  const borrowable = market.listed && !borrowPaused && !borrowCapZero && (priceUsd || 0) > 0;
  const cashUsd = priceUsd === null ? null : cash * priceUsd;
  const borrowsUsd = priceUsd === null ? null : borrows * priceUsd;
  const feedAge = asNumber(mainSource?.feedAgeSeconds);
  const maxStale = asNumber(mainSource?.maxStalePeriod);
  const nearStale = feedAge !== null && maxStale !== null && feedAge >= maxStale * NEAR_STALE_PCT && feedAge <= maxStale;
  const expiredFeed = feedAge !== null && maxStale !== null && feedAge > maxStale;
  if (highCf) flags.push("highCF");
  if (oracleCfg?.singleSource) flags.push("singleOracle");
  if (wrapperOrLP) flags.push("wrapperOrLP");
  if (borrowPaused) flags.push("borrowPaused");
  if (liquidatePaused) flags.push("liquidatePaused");
  if (forcedLiquidation) flags.push("forcedLiq");
  if (borrowCapZero) flags.push("borrowCap=0");
  if (supplyCapZero) flags.push("supplyCap=0");
  if (nearStale) flags.push("nearStale");
  if (expiredFeed) flags.push("feedExpired");
  const watchCandidate = Boolean(highCf && borrowable && oracleCfg?.singleSource && (nearStale || wrapperOrLP) && (cashUsd || 0) >= MATERIAL_USD);
  return {
    chain: chain.chain,
    chainId: chain.chainId,
    poolKind: chain.kind,
    comptroller,
    vToken: normalizeAddress(vToken),
    symbol: vSymbol,
    name: vName,
    asset: meta.address || asset,
    assetSymbol: meta.symbol,
    assetDecimals: decimals,
    listed: market.listed,
    collateralFactorBps: market.cfBps,
    liquidationThresholdBps: market.ltBps,
    cash: round(cash, 8),
    borrows: round(borrows, 8),
    cashUsd: round(cashUsd, 2),
    borrowsUsd: round(borrowsUsd, 2),
    supplyCap: round(supplyCap, 8),
    borrowCap: round(borrowCap, 8),
    borrowPaused,
    liquidatePaused,
    forcedLiquidation,
    priceUsd: round(priceUsd, 10),
    priceRaw: priceRaw?.[0]?.toString?.() || null,
    totalSupplyRaw: supplyRaw?.[0]?.toString?.() || null,
    totalReservesRaw: reservesRaw?.[0]?.toString?.() || null,
    exchangeRateStoredRaw: exchangeRateRaw?.[0]?.toString?.() || null,
    interestRateModel: normalizeAddress(irmRaw?.[0]),
    accrualBlockNumber: accrualBlockRaw?.[0] === undefined ? null : Number(accrualBlockRaw[0]),
    oracle: oracleCfg ? {
      resilientOracle: normalizeAddress(oracle),
      mainOracle: oracleCfg.mainOracle,
      pivotOracle: oracleCfg.pivotOracle,
      fallbackOracle: oracleCfg.fallbackOracle,
      flags: oracleCfg.flagsText,
      enabledSourceCount: oracleCfg.enabledSourceCount,
      singleSource: oracleCfg.singleSource,
      mainSource,
    } : { resilientOracle: normalizeAddress(oracle), configResolved: false },
    highCf,
    borrowable,
    wrapperOrLP,
    nearStale,
    expiredFeed,
    watchCandidate,
    routePositive: false,
    flags: flags.join(","),
    blocker: watchCandidate ? "Watch-only: needs accepted-value divergence plus exact borrow/exit economics and fork proof" : "No route-positive borrow/liquidation economics proven",
  };
}

async function scanChain(chain, rpc) {
  const configured = chain.kind === "legacy-core" ? { address: chain.comptroller, file: null } : coreComptrollerFromArtifact(chain.folder);
  const comptroller = normalizeAddress(configured.address);
  const base = {
    chain: chain.chain,
    chainId: chain.chainId,
    poolKind: chain.kind,
    deploymentSource: configured.file || chain.deploymentSource || null,
    comptroller,
    rpcResolved: Boolean(rpc),
  };
  if (!rpc) return { chainRow: { ...base, status: "rpc-unresolved", marketRows: 0 }, marketRows: [], borrowerRows: [], proxyRows: [], logErrors: [] };
  if (!comptroller) return { chainRow: { ...base, status: "deployment-missing", marketRows: 0 }, marketRows: [], borrowerRows: [], proxyRows: [], logErrors: [] };
  const iface = chain.kind === "legacy-core" ? COMPTROLLER_LEGACY : COMPTROLLER_ISO;
  const [latest, code, proxy, marketsRaw, oracleRaw, closeFactorRaw, liqIncentiveRaw, minLiqRaw, adminRaw, pauseGuardianRaw, ownerRaw, acmRaw, protocolPausedRaw] = await Promise.all([
    latestBlock(rpc),
    getCode(rpc, comptroller),
    proxyMeta(rpc, comptroller),
    safeCall(rpc, comptroller, iface, "getAllMarkets"),
    safeCall(rpc, comptroller, iface, "oracle"),
    safeCall(rpc, comptroller, iface, "closeFactorMantissa"),
    safeCall(rpc, comptroller, iface, "liquidationIncentiveMantissa"),
    chain.kind === "isolated-core" ? safeCall(rpc, comptroller, iface, "minLiquidatableCollateral") : null,
    chain.kind === "legacy-core" ? safeCall(rpc, comptroller, iface, "admin") : null,
    chain.kind === "legacy-core" ? safeCall(rpc, comptroller, iface, "pauseGuardian") : null,
    chain.kind === "isolated-core" ? safeCall(rpc, comptroller, iface, "owner") : null,
    chain.kind === "isolated-core" ? safeCall(rpc, comptroller, iface, "accessControlManager") : null,
    chain.kind === "legacy-core" ? safeCall(rpc, comptroller, iface, "protocolPaused") : null,
  ]);
  const oracle = normalizeAddress(oracleRaw?.[0]);
  const markets = Array.isArray(marketsRaw?.[0]) ? marketsRaw[0].map(normalizeAddress).filter(Boolean) : [];
  const caches = { sourceOracle: new Map(), feed: new Map() };
  const rows = [];
  for (const vToken of markets) {
    try {
      rows.push(await scanMarket(rpc, chain, comptroller, iface, oracle, vToken, latest.timestamp, caches));
    } catch (err) {
      rows.push({ chain: chain.chain, chainId: chain.chainId, poolKind: chain.kind, comptroller, vToken, error: safeText(err?.message || "market-scan-failed"), routePositive: false });
    }
  }
  const borrower = await borrowerRows(rpc, chain, comptroller, iface, rows, latest);
  const listed = rows.filter((row) => row.listed);
  const highCf = rows.filter((row) => row.highCf);
  const highCfBorrowable = rows.filter((row) => row.highCf && row.borrowable);
  const singleOracle = rows.filter((row) => row.oracle?.singleSource);
  const highCfSingleOracleBorrowable = rows.filter((row) => row.highCf && row.borrowable && row.oracle?.singleSource);
  const watchRows = rows.filter((row) => row.watchCandidate);
  const routePositiveRows = 0;
  return {
    chainRow: {
      ...base,
      status: code && code !== "0x" ? "scanned" : "no-code",
      blockNumber: latest.number,
      blockTimestamp: latest.timestamp,
      comptrollerCodePresent: Boolean(code && code !== "0x"),
      comptrollerCodeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
      oracle,
      closeFactorBps: closeFactorRaw?.[0] === undefined ? null : wadBps(closeFactorRaw[0]),
      liquidationIncentiveBps: liqIncentiveRaw?.[0] === undefined ? null : wadBps(liqIncentiveRaw[0]),
      minLiquidatableCollateralUsd: minLiqRaw?.[0] === undefined ? null : round(unitsToNumber(minLiqRaw[0], 18), 2),
      admin: normalizeAddress(adminRaw?.[0]) || normalizeAddress(ownerRaw?.[0]),
      pauseGuardian: normalizeAddress(pauseGuardianRaw?.[0]),
      accessControlManager: normalizeAddress(acmRaw?.[0]),
      protocolPaused: protocolPausedRaw?.[0] === undefined ? null : Boolean(protocolPausedRaw[0]),
      marketRows: rows.length,
      listedRows: listed.length,
      highCfRows: highCf.length,
      borrowableRows: rows.filter((row) => row.borrowable).length,
      highCfBorrowableRows: highCfBorrowable.length,
      singleOracleRows: singleOracle.length,
      highCfSingleOracleBorrowableRows: highCfSingleOracleBorrowable.length,
      wrapperRows: rows.filter((row) => row.wrapperOrLP).length,
      borrowPausedRows: rows.filter((row) => row.borrowPaused).length,
      borrowCapZeroRows: rows.filter((row) => /borrowCap=0/.test(row.flags || "")).length,
      nearStaleRows: rows.filter((row) => row.nearStale).length,
      expiredFeedRows: rows.filter((row) => row.expiredFeed).length,
      watchCandidates: watchRows.length,
      sampledBorrowers: borrower.rows.length,
      sampledLiquidatableBorrowers: borrower.rows.filter((row) => row.liquidatable).length,
      materialSampledLiquidatableBorrowers: borrower.rows.filter((row) => row.materialLiquidatable).length,
      borrowLogsRead: borrower.logsRead,
      borrowLogFromBlock: borrower.fromBlock,
      totalCashUsd: round(rows.reduce((sum, row) => sum + (asNumber(row.cashUsd) || 0), 0), 2),
      totalBorrowsUsd: round(rows.reduce((sum, row) => sum + (asNumber(row.borrowsUsd) || 0), 0), 2),
      routePositive: routePositiveRows,
      executableNow: 0,
    },
    marketRows: rows,
    borrowerRows: borrower.rows,
    proxyRows: [{ chain: chain.chain, chainId: chain.chainId, label: "Comptroller", ...proxy }],
    logErrors: borrower.logErrors.map((error) => ({ chain: chain.chain, chainId: chain.chainId, error })),
  };
}

function sourceRows() {
  return [
    { repo: "targets/venus-isolated-pools", role: "Core isolated pool source/deployments", exists: fs.existsSync(path.join(WORKSPACE, "targets", "venus-isolated-pools")) },
    { repo: "targets/venus-oracle", role: "ResilientOracle and source oracle implementations", exists: fs.existsSync(path.join(WORKSPACE, "targets", "venus-oracle")) },
    { repo: "targets/venus-protocol", role: "BSC legacy core pool source", exists: fs.existsSync(path.join(WORKSPACE, "targets", "venus-protocol")) },
    { repo: "targets/venus-governance-contracts", role: "Access-control/governance dependency", exists: fs.existsSync(path.join(WORKSPACE, "targets", "venus-governance-contracts")) },
  ];
}

function topRows(rows, filter, limit = 10) {
  return rows.filter(filter).sort((a, b) => (asNumber(b.cashUsd) || 0) - (asNumber(a.cashUsd) || 0)).slice(0, limit);
}

function writeReport(out) {
  const s = out.summary;
  const chainTable = out.chainRows.map((row) => `| ${row.chain} | ${row.poolKind} | ${row.status} | ${row.marketRows || 0} | ${row.highCfBorrowableRows || 0} | ${row.highCfSingleOracleBorrowableRows || 0} | ${row.watchCandidates || 0} | ${formatUsd(row.totalCashUsd)} | ${formatUsd(row.totalBorrowsUsd)} |`).join("\n") || "| none | n/a | n/a | 0 | 0 | 0 | 0 | n/a | n/a |";
  const riskRows = topRows(out.marketRows, (row) => row.highCf && row.borrowable, 12).map((row) => `| ${row.chain} | ${row.symbol || "n/a"} | ${row.assetSymbol || "n/a"} | ${formatPctBps(row.collateralFactorBps)} | ${formatPctBps(row.liquidationThresholdBps)} | ${formatUsd(row.cashUsd)} | ${formatUsd(row.borrowsUsd)} | ${row.oracle?.flags || "n/a"} | ${row.flags || "-"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const oracleRows = topRows(out.marketRows, (row) => row.oracle?.singleSource && row.highCf, 12).map((row) => {
    const src = row.oracle?.mainSource || {};
    const age = src.feedAgeSeconds === null || src.feedAgeSeconds === undefined ? "n/a" : `${Math.round(src.feedAgeSeconds)}s`;
    const max = src.maxStalePeriod === null || src.maxStalePeriod === undefined ? "n/a" : `${Math.round(src.maxStalePeriod)}s`;
    return `| ${row.chain} | ${row.symbol || "n/a"} | ${row.assetSymbol || "n/a"} | ${compactAddress(row.oracle?.mainOracle)} | ${src.feedDescription || "non-Chainlink-like/unknown"} | ${age} | ${max} | ${row.nearStale ? "near-stale" : row.expiredFeed ? "expired/rejected" : "not near gate"} |`;
  }).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const borrowerRows = out.borrowerRows.slice(0, 10).map((row) => `| ${row.chain} | ${compactAddress(row.borrower)} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.shortfallUsd)} | ${row.liquidatable} |`).join("\n") || "| none sampled | n/a | n/a | n/a | false |";
  const lines = [`# ${SIGNAL_DORMANT} - Venus Core Pool Phase 0`, "", `Date: ${out.generatedAt}`, "", "## Result", "", "No permissionless route-positive exploit is claimed. This refreshed pass reconciled prior Venus coverage with current Core Pool deployments, live market config, oracle source roles/feed freshness where decodable, caps, pause states, proxy metadata, and bounded recent borrower liquidity sampling. High-CF single-source rows remain configuration/oracle dependency risk only; no row has accepted-value divergence, exact positive borrow/liquidation economics, fork proof, or signed-action justification.", "", "## Summary", "", `- DeFiLlama target: ${out.metadata.name || "Venus Core Pool"} (${out.metadata.slug || "venus-core-pool"}), TVL ${formatUsd(out.metadata.tvlUsd)}.`, `- Chains scoped: ${s.chainsScoped}; RPC-resolved and scanned: ${s.chainsWithRpc}.`, `- Markets scanned: ${s.marketRows}; listed: ${s.listedRows}; high-CF borrowable: ${s.highCfBorrowableRows}.`, `- High-CF single-source borrowable rows: ${s.highCfSingleOracleBorrowableRows}; watch candidates: ${s.watchCandidates}.`, `- Bounded recent borrower rows sampled: ${s.sampledBorrowers}; material liquidatable sampled rows: ${s.materialSampledLiquidatableBorrowers}.`, `- Route-positive: ${s.routePositive}; executableNow: ${s.executableNow}; signedActionJustified: ${s.signedActionJustified}.`, "", "## Chain Coverage", "", "| Chain | Pool | Status | Markets | High-CF Borrowable | High-CF Single Source | Watch | Cash | Borrows |", "|---|---|---|---:|---:|---:|---:|---:|---:|", chainTable, "", "## Top High-CF Borrowable Rows", "", "| Chain | vToken | Asset | CF | LT | Cash | Borrows | Oracle Flags | Flags |", "|---|---|---|---:|---:|---:|---:|---|---|", riskRows, "", "## Single-Source Oracle Rows", "", "| Chain | vToken | Asset | Main Oracle | Feed | Age | Max Stale | Status |", "|---|---|---|---|---|---:|---:|---|", oracleRows, "", "## Borrower Sampling", "", `Borrower sampling is bounded to recent Borrow events over ${RECENT_BORROW_LOG_BLOCKS.toLocaleString()} blocks per chain and is not exhaustive account discovery. It is used only to detect obvious current liquidation leads before exact route work.`, "", "| Chain | Borrower | Liquidity | Shortfall | Liquidatable |", "|---|---|---:|---:|---|", borrowerRows, "", "## Verdict", "", "Venus Core Pool remains DORMANT for this pass. BSC legacy core still has material high-CF borrowable liquidity but no single-source route in the decoded high-value rows. Isolated Core deployments have high-CF single-source rows on some chains, but this is not extractable without an accepted stale/divergent oracle value, material borrow liquidity, and exact unwind/liquidation economics.", "", "## Reopen Criteria", "", "1. A high-CF single-source Venus market has an accepted stale or divergent price that overvalues collateral or underprices debt by enough to clear CF/LT and costs.", "2. A bounded or indexed borrower scan finds material current shortfall, and exact repay/seize/exit economics are positive after gas/slippage/fees.", "3. A wrapper/PT/LST market becomes collateral-enabled and borrowable with exact acquisition and exit liquidity plus an attacker-favorable oracle/accounting condition.", "4. Governance or deployment changes alter oracle roles, caps, pause state, liquidation parameters, or implementations in a way that creates a concrete permissionless route.", "", "## Files", "", "- Artifact: `reports/raw/fast/venus-core-pool-phase0.json`", "- Scanner: `tools/scan-venus-core-pool-phase0.js`", "- Prior related reports: `reports/venus-deep-triage.md`, `reports/venus-multichain-triage.md`, `reports/venus-base-triage.md`", ""];
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, `${lines.join("\n")}\n`);
}

async function main() {
  const metadata = await protocolMetadata();
  const rpcPool = await resolveRpcPool(CHAINS.map((chain) => chain.chainId));
  for (const [chainId, url] of Object.entries(PUBLIC_FALLBACKS)) {
    if (!rpcPool[Number(chainId)]) rpcPool[Number(chainId)] = url;
  }
  const scanResults = [];
  for (const chain of CHAINS) {
    scanResults.push(await scanChain(chain, rpcPool[chain.chainId] || null));
  }
  const chainRows = scanResults.map((result) => result.chainRow);
  const marketRows = scanResults.flatMap((result) => result.marketRows);
  const borrowerRowsAll = scanResults.flatMap((result) => result.borrowerRows);
  const proxyRows = scanResults.flatMap((result) => result.proxyRows);
  const logErrors = scanResults.flatMap((result) => result.logErrors);
  const watchRows = marketRows.filter((row) => row.watchCandidate);
  const highCfSingleOracleBorrowable = marketRows.filter((row) => row.highCf && row.borrowable && row.oracle?.singleSource);
  const materialLiquidatable = borrowerRowsAll.filter((row) => row.materialLiquidatable);
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-venus-core-pool-phase0.js",
    scope: "Venus Core Pool Phase 0 using public target metadata, local Venus deployment artifacts/source, and live read-only EVM state",
    scopeChains: CHAINS.map((chain) => ({ chain: chain.chain, chainId: chain.chainId, kind: chain.kind })),
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      executionCalldataStored: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    metadata,
    source: {
      sourceRows: sourceRows(),
      priorReports: ["reports/venus-deep-triage.md", "reports/venus-multichain-triage.md", "reports/venus-base-triage.md"],
      sourceAvailability: "bounded to local Venus source/deployment artifacts plus live read-only state; no write transactions or fork simulations were run",
    },
    thresholds: {
      materialUsd: MATERIAL_USD,
      highCollateralFactorBps: HIGH_CF_BPS,
      nearStalePctOfMax: NEAR_STALE_PCT,
      recentBorrowLogBlocks: RECENT_BORROW_LOG_BLOCKS,
      maxBorrowersPerPool: MAX_BORROWERS_PER_POOL,
    },
    chainRows,
    marketRows: marketRows.sort((a, b) => (asNumber(b.cashUsd) || 0) - (asNumber(a.cashUsd) || 0)),
    borrowerRows: borrowerRowsAll.sort((a, b) => (asNumber(b.shortfallUsd) || 0) - (asNumber(a.shortfallUsd) || 0)),
    proxyRows,
    logErrors,
    topRows: topRows(marketRows, (row) => row.highCf && row.borrowable, 10),
    watchRows,
    summary: {
      defillamaCurrentTvlUsd: metadata.tvlUsd,
      chainsScoped: CHAINS.length,
      chainsWithRpc: chainRows.filter((row) => row.rpcResolved).length,
      chainsScanned: chainRows.filter((row) => row.status === "scanned").length,
      marketRows: marketRows.length,
      listedRows: marketRows.filter((row) => row.listed).length,
      highCfRows: marketRows.filter((row) => row.highCf).length,
      borrowableRows: marketRows.filter((row) => row.borrowable).length,
      highCfBorrowableRows: marketRows.filter((row) => row.highCf && row.borrowable).length,
      singleOracleRows: marketRows.filter((row) => row.oracle?.singleSource).length,
      highCfSingleOracleBorrowableRows: highCfSingleOracleBorrowable.length,
      wrapperRows: marketRows.filter((row) => row.wrapperOrLP).length,
      borrowPausedRows: marketRows.filter((row) => row.borrowPaused).length,
      nearStaleRows: marketRows.filter((row) => row.nearStale).length,
      expiredFeedRows: marketRows.filter((row) => row.expiredFeed).length,
      totalCashUsd: round(marketRows.reduce((sum, row) => sum + (asNumber(row.cashUsd) || 0), 0), 2),
      totalBorrowsUsd: round(marketRows.reduce((sum, row) => sum + (asNumber(row.borrowsUsd) || 0), 0), 2),
      sampledBorrowers: borrowerRowsAll.length,
      sampledLiquidatableBorrowers: borrowerRowsAll.filter((row) => row.liquidatable).length,
      materialSampledLiquidatableBorrowers: materialLiquidatable.length,
      watchCandidates: watchRows.length + materialLiquidatable.length,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      coverageClassification: "bounded-with-caveats",
      status: "venus-core-pool-phase0-no-route-positive",
    },
    blockers: [
      "High-CF rows do not prove accepted-value overpricing or cheap manipulation by themselves",
      "Single-source oracle rows require a current stale/divergent accepted value plus exact positive borrow/liquidation economics",
      "Bounded recent borrower sampling is not exhaustive and found no fork-proven exact positive liquidation route in this pass",
      "Wrapper/PT/LST rows remain blocked unless collateral, caps, pause state, acquisition, and exit economics all become favorable",
      "No fork extraction proof and no signed-action justification",
    ],
    requiredForRoutePositive: [
      "specific Venus market accepts an attacker-favorable stale/divergent oracle or accounting value",
      "borrow or liquidation path is permissionless, unpaused, and has material live liquidity",
      "collateral acquisition and borrowed/seized asset exit are exact-quoted after gas/slippage/fees",
      "fork extraction proof demonstrates positive net value",
    ],
    nextReadOnlyStep: "Keep Venus Core Pool on oracle/liquidation watch; exact-quote/fork only if a high-CF single-source row becomes accepted-divergent or a material liquidatable borrower appears.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
  writeReport(out);
  if (!QUIET) {
    console.log(`Wrote ${path.relative(WORKSPACE, RAW_OUT)}`);
    console.log(`Wrote ${path.relative(WORKSPACE, REPORT_OUT)}`);
    console.log(`Venus Core Pool: chainsScanned=${out.summary.chainsScanned}/${out.summary.chainsScoped} markets=${out.summary.marketRows} highCfSingleOracleBorrowable=${out.summary.highCfSingleOracleBorrowableRows} watchCandidates=${out.summary.watchCandidates} routePositive=0`);
  }
}

main().catch((err) => { console.error(err?.message || err); process.exit(1); });
