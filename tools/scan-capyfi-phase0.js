#!/usr/bin/env node
// scan-capyfi-phase0.js - bounded read-only Phase 0 for Capyfi Compound V2 fork.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, execution calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "capyfi-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "capyfi-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";
const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const DEFAULT_ADMIN_ROLE = "0x" + "0".repeat(64);
const WHITELISTED_ROLE = ethers.id("WHITELISTED_ROLE");
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const RECENT_BORROW_LOG_BLOCKS = Number(process.env.CAPYFI_RECENT_BORROW_LOG_BLOCKS || "50000");
const BORROW_LOG_CHUNK_BLOCKS = Number(process.env.CAPYFI_BORROW_LOG_CHUNK_BLOCKS || "5000");
const MAX_BORROWERS_PER_MARKET = Number(process.env.CAPYFI_MAX_BORROWERS_PER_MARKET || "40");
const MATERIAL_USD = Number(process.env.CAPYFI_MATERIAL_USD || "10000");
const HIGH_CF_BPS = Number(process.env.CAPYFI_HIGH_CF_BPS || "7500");
const FIXED_ORACLE_WATCH_CF_BPS = Number(process.env.CAPYFI_FIXED_ORACLE_WATCH_CF_BPS || "5000");
const STALE_WARN_SECONDS = Number(process.env.CAPYFI_STALE_WARN_SECONDS || "86400");

const LOCAL_PUBLIC_FALLBACKS = {
  274: [
    "https://rpc1.mainnet.lachain.network",
    "https://rpc2.mainnet.lachain.network",
    "https://lachain.rpc-nodes.cedalio.dev",
  ],
  480: [
    "https://worldchain-mainnet.g.alchemy.com/public",
    "https://480.rpc.thirdweb.com",
  ],
};

const CHAINS = [
  {
    chain: "Ethereum",
    adapterKey: "ethereum",
    chainId: 1,
    comptroller: "0x0b9af1fd73885aD52680A1aeAa7A3f17AC702afA",
    implementation: "0x00dc4965916e03A734190fA382633657c71f867E",
    oracle: "0xfbA2712d3bbcf32c6E0178a21955b61FE1FF424A",
    cether: "0x37DE57183491Fa9745d8Fa5DCd950f0c3a4645c9",
    whitelist: "0x4B3535047C2B193Bc0c95ED2EF435A6BA6Dc2609",
    nativeSymbol: "ETH",
    source: "LaChain/capyfi-sc docs/audit-docs.md and registries/compound.js",
    blacklistedTokens: ["0xbaa6bc4e24686d710b9318b49b0bb16ec7c46bfa"],
    expectedMarkets: {
      caUXD: "0x98Ac8AC56d833bD69d34F909Ac15226772FAc9aa",
      caETH: "0x37DE57183491Fa9745d8Fa5DCd950f0c3a4645c9",
      caLAC: "0x0568F6cb5A0E84FACa107D02f81ddEB1803f3B50",
      caWBTC: "0xDa5928d59ECE82808Af2cbBE4f2872FeA8E12CD6",
      caUSDT: "0x0f864A3e50D1070adDE5100fd848446C0567362B",
      caUSDC: "0xc3aD34De18B59A24BD0877e454Fb924181F09C8f",
    },
  },
  {
    chain: "World Chain",
    adapterKey: "wc",
    chainId: 480,
    comptroller: "0x589d63300976759a0fc74ea6fA7D951f581252D7",
    cether: "0xaAd91abe333c4536FFbF02b83daBaB49C9Aa23ed",
    nativeSymbol: "ETH",
    source: "DefiLlama registries/compound.js capyfi.wc",
    expectedMarkets: {},
  },
  {
    chain: "LaChain Network",
    adapterKey: "lac",
    chainId: 274,
    comptroller: "0x123Abe3A273FDBCeC7fc0EBedc05AaeF4eE63060",
    implementation: "0xB45435f4d5Fa43C8Fd59199beA39D5A023D0d20c",
    oracle: "0x4E07BDEec540D3a2318A91fAEe130E692506a360",
    cether: "0x465ebfceb3953e2922b686f2b4006173664d16ce",
    nativeSymbol: "LAC",
    source: "LaChain/capyfi-sc HelperConfig.s.sol and registries/compound.js capyfi.lac",
    expectedMarkets: {
      caUXD: "0x8A3e793Ea2120A615dA2119b03CA015ceE59DB5c",
      caWETH: "0xe06651160F514b8a6bA65f83f07dEca2889b3C46",
      caLAC: "0x465ebFCeB3953e2922B686F2B4006173664D16cE",
      caWBTC: "0x694C3940B4680504a82d6c30E64377B0D2e9d251",
      caUSDT: "0x87153302A2b8B2dCf29642D149F5C88C73ee4bf6",
      caUSDC: "0x08dfCC0eE2659d131bb82e4f15e15513F643063E",
    },
  },
];

const COMPTROLLER = new ethers.Interface([
  "function getAllMarkets() view returns (address[])",
  "function markets(address) view returns (bool,uint256,bool)",
  "function oracle() view returns (address)",
  "function admin() view returns (address)",
  "function pendingAdmin() view returns (address)",
  "function pauseGuardian() view returns (address)",
  "function borrowCapGuardian() view returns (address)",
  "function comptrollerImplementation() view returns (address)",
  "function pendingComptrollerImplementation() view returns (address)",
  "function closeFactorMantissa() view returns (uint256)",
  "function liquidationIncentiveMantissa() view returns (uint256)",
  "function borrowCaps(address) view returns (uint256)",
  "function mintGuardianPaused(address) view returns (bool)",
  "function borrowGuardianPaused(address) view returns (bool)",
  "function transferGuardianPaused() view returns (bool)",
  "function seizeGuardianPaused() view returns (bool)",
  "function getAccountLiquidity(address) view returns (uint256,uint256,uint256)",
]);

const CTOKEN = new ethers.Interface([
  "function underlying() view returns (address)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function admin() view returns (address)",
  "function pendingAdmin() view returns (address)",
  "function comptroller() view returns (address)",
  "function implementation() view returns (address)",
  "function whitelist() view returns (address)",
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
  "function getConfig(address) view returns (tuple(uint8 underlyingAssetDecimals,address priceFeed,uint256 fixedPrice))",
  "function owner() view returns (address)",
  "function assetPrices(address) view returns (uint256)",
  "function authorizedAddresses(address) view returns (bool)",
]);

const FEED = new ethers.Interface([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);

const WHITELIST = new ethers.Interface([
  "function isActive() view returns (bool)",
  "function isAdmin(address) view returns (bool)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function getRoleMemberCount(bytes32) view returns (uint256)",
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
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatPctBps(value) { const n = asNumber(value); return n === null ? "n/a" : `${round(n / 100, 2)}%`; }
function safeText(value, max = 140) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function unitsToNumber(value, decimals = 18) { try { return Number(ethers.formatUnits(toBig(value), decimals)); } catch (_) { return null; } }
function wadBps(value) { return Number((toBig(value) * 10000n) / (10n ** 18n)); }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function slotAddress(raw) { const addr = raw && raw !== "0x" && raw.length >= 66 ? normalizeAddress(`0x${raw.slice(26)}`) : null; return addr && addr !== ZERO ? addr : null; }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-capyfi-phase0/1.0" } });
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

async function proxyMeta(rpc, address, label) {
  const [code, implSlot, adminSlot, beaconSlot] = await Promise.all([
    getCode(rpc, address),
    getSlotAddress(rpc, address, EIP1967_IMPL),
    getSlotAddress(rpc, address, EIP1967_ADMIN),
    getSlotAddress(rpc, address, EIP1967_BEACON),
  ]);
  const beaconImpl = beaconSlot ? await safeCall(rpc, beaconSlot, BEACON, "implementation") : null;
  return {
    label,
    address: normalizeAddress(address),
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    eip1967Implementation: implSlot,
    eip1967Admin: adminSlot,
    eip1967Beacon: beaconSlot,
    eip1967BeaconImplementation: normalizeAddress(beaconImpl?.[0]),
  };
}

async function addressKind(rpc, address) {
  const addr = normalizeAddress(address);
  if (!addr || addr === ZERO) return "zero";
  const code = await getCode(rpc, addr);
  return code && code !== "0x" ? "contract" : "eoa";
}

async function firstWorkingRpc(chainId, candidates) {
  for (const url of candidates || []) {
    const id = await rpcCall(url, "eth_chainId", [], 5000).catch(() => null);
    if (id && Number(BigInt(id)) === Number(chainId)) return url;
  }
  return null;
}

async function rpcPool() {
  const ids = CHAINS.map((chain) => chain.chainId);
  const pool = await resolveRpcPool(ids);
  for (const chain of CHAINS) {
    if (!pool[chain.chainId] && LOCAL_PUBLIC_FALLBACKS[chain.chainId]) {
      pool[chain.chainId] = await firstWorkingRpc(chain.chainId, LOCAL_PUBLIC_FALLBACKS[chain.chainId]);
    }
  }
  return pool;
}

async function tokenMeta(rpc, token, fallback = {}) {
  const address = normalizeAddress(token);
  if (!address || address === ZERO) return fallback;
  if (lowerAddress(address) === lowerAddress(NATIVE_TOKEN)) {
    return { address, symbol: fallback.symbol || "NATIVE", name: fallback.name || "Native token", decimals: fallback.decimals ?? 18 };
  }
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

function parseMarket(raw) {
  if (!raw) return { listed: false, cfBps: 0, comped: false };
  return { listed: Boolean(raw[0]), cfBps: wadBps(raw[1]), comped: Boolean(raw[2]) };
}

function parseOracleConfig(raw) {
  const cfg = raw?.[0] || raw;
  if (!cfg) return null;
  return {
    underlyingAssetDecimals: cfg.underlyingAssetDecimals === undefined ? Number(cfg[0] ?? 18) : Number(cfg.underlyingAssetDecimals),
    priceFeed: normalizeAddress(cfg.priceFeed ?? cfg[1]) || ZERO,
    fixedPriceRaw: (cfg.fixedPrice ?? cfg[2])?.toString?.() || null,
  };
}

async function feedMeta(rpc, feed, blockTimestamp) {
  const addr = normalizeAddress(feed);
  if (!addr || addr === ZERO) return null;
  const [round, decimals, description] = await Promise.all([
    safeCall(rpc, addr, FEED, "latestRoundData"),
    safeCall(rpc, addr, FEED, "decimals"),
    safeCall(rpc, addr, FEED, "description"),
  ]);
  const updatedAt = round?.[3] === undefined ? null : Number(round[3]);
  return {
    feed: addr,
    decimals: decimals?.[0] === undefined ? null : Number(decimals[0]),
    description: safeText(description?.[0], 100),
    answerRaw: round?.[1]?.toString?.() || null,
    updatedAt,
    ageSeconds: updatedAt && blockTimestamp ? Math.max(0, blockTimestamp - updatedAt) : null,
    answeredInRound: round?.[4]?.toString?.() || null,
  };
}

async function whitelistMeta(rpc, whitelist, knownAdmin) {
  const addr = normalizeAddress(whitelist);
  if (!addr || addr === ZERO) return null;
  const [code, active, adminCountRaw, whitelistedCountRaw, knownAdminRoleRaw, eipProxy] = await Promise.all([
    getCode(rpc, addr),
    safeCall(rpc, addr, WHITELIST, "isActive"),
    safeCall(rpc, addr, WHITELIST, "getRoleMemberCount", [DEFAULT_ADMIN_ROLE]),
    safeCall(rpc, addr, WHITELIST, "getRoleMemberCount", [WHITELISTED_ROLE]),
    knownAdmin ? safeCall(rpc, addr, WHITELIST, "hasRole", [DEFAULT_ADMIN_ROLE, knownAdmin]) : null,
    proxyMeta(rpc, addr, "Whitelist"),
  ]);
  return {
    whitelist: addr,
    codePresent: Boolean(code && code !== "0x"),
    active: active?.[0] === undefined ? null : Boolean(active[0]),
    defaultAdminRoleCount: adminCountRaw?.[0] === undefined ? null : Number(adminCountRaw[0]),
    whitelistedRoleCount: whitelistedCountRaw?.[0] === undefined ? null : Number(whitelistedCountRaw[0]),
    knownAdminHasDefaultAdminRole: knownAdminRoleRaw?.[0] === undefined ? null : Boolean(knownAdminRoleRaw[0]),
    eip1967Implementation: eipProxy.eip1967Implementation,
    eip1967Admin: eipProxy.eip1967Admin,
    eip1967Beacon: eipProxy.eip1967Beacon,
  };
}

async function getLogsChunked(rpc, addresses, fromBlock, toBlock) {
  if (!rpc || !addresses.length || !Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || toBlock < fromBlock || RECENT_BORROW_LOG_BLOCKS <= 0) return { logs: [], errors: [] };
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

async function borrowerRows(rpc, chain, comptroller, markets, latest) {
  const addresses = markets.map((row) => normalizeAddress(row.cToken)).filter(Boolean);
  const fromBlock = latest.number && RECENT_BORROW_LOG_BLOCKS > 0 ? Math.max(0, latest.number - RECENT_BORROW_LOG_BLOCKS) : null;
  const logResult = fromBlock === null ? { logs: [], errors: [] } : await getLogsChunked(rpc, addresses, fromBlock, latest.number);
  const byMarket = new Map();
  for (const log of logResult.logs) {
    try {
      const parsed = log.topics?.length > 1
        ? BORROW_INDEXED.parseLog({ topics: log.topics, data: log.data })
        : BORROW_UNINDEXED.parseLog({ topics: log.topics, data: log.data });
      const cToken = lowerAddress(log.address);
      const borrower = normalizeAddress(parsed.args.borrower);
      if (!borrower) continue;
      if (!byMarket.has(cToken)) byMarket.set(cToken, []);
      const arr = byMarket.get(cToken);
      if (!arr.includes(borrower) && arr.length < MAX_BORROWERS_PER_MARKET) arr.push(borrower);
    } catch (_) {}
  }
  const uniqueBorrowers = unique([...byMarket.values()].flat());
  const rows = [];
  for (const borrower of uniqueBorrowers) {
    const liq = await safeCall(rpc, comptroller, COMPTROLLER, "getAccountLiquidity", [borrower], 12_000);
    const liquidityUsd = liq?.[1] === undefined ? null : unitsToNumber(liq[1], 18);
    const shortfallUsd = liq?.[2] === undefined ? null : unitsToNumber(liq[2], 18);
    rows.push({
      chain: chain.chain,
      chainId: chain.chainId,
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
  return { rows, logsRead: logResult.logs.length, fromBlock, logErrors: logResult.errors };
}

async function scanMarket(rpc, chain, comptroller, oracle, cToken, latest, chainPause, whitelistCache) {
  const cTokenAddress = normalizeAddress(cToken);
  const isNativeMarket = lowerAddress(cTokenAddress) === lowerAddress(chain.cether);
  const [code, marketRaw, underlyingRaw, symbolRaw, nameRaw, cDecimalsRaw, cashRaw, borrowsRaw, supplyRaw, reservesRaw, exchangeRateRaw, reserveFactorRaw, borrowIndexRaw, accrualRaw, irmRaw, cAdminRaw, cPendingAdminRaw, cComptrollerRaw, cImplRaw, whitelistRaw, borrowCapRaw, mintPausedRaw, borrowPausedRaw, priceRaw, oracleCfgRaw] = await Promise.all([
    getCode(rpc, cTokenAddress),
    safeCall(rpc, comptroller, COMPTROLLER, "markets", [cTokenAddress]),
    isNativeMarket ? null : safeCall(rpc, cTokenAddress, CTOKEN, "underlying"),
    safeCall(rpc, cTokenAddress, CTOKEN, "symbol"),
    safeCall(rpc, cTokenAddress, CTOKEN, "name"),
    safeCall(rpc, cTokenAddress, CTOKEN, "decimals"),
    safeCall(rpc, cTokenAddress, CTOKEN, "getCash"),
    safeCall(rpc, cTokenAddress, CTOKEN, "totalBorrows"),
    safeCall(rpc, cTokenAddress, CTOKEN, "totalSupply"),
    safeCall(rpc, cTokenAddress, CTOKEN, "totalReserves"),
    safeCall(rpc, cTokenAddress, CTOKEN, "exchangeRateStored"),
    safeCall(rpc, cTokenAddress, CTOKEN, "reserveFactorMantissa"),
    safeCall(rpc, cTokenAddress, CTOKEN, "borrowIndex"),
    safeCall(rpc, cTokenAddress, CTOKEN, "accrualBlockNumber"),
    safeCall(rpc, cTokenAddress, CTOKEN, "interestRateModel"),
    safeCall(rpc, cTokenAddress, CTOKEN, "admin"),
    safeCall(rpc, cTokenAddress, CTOKEN, "pendingAdmin"),
    safeCall(rpc, cTokenAddress, CTOKEN, "comptroller"),
    safeCall(rpc, cTokenAddress, CTOKEN, "implementation"),
    safeCall(rpc, cTokenAddress, CTOKEN, "whitelist"),
    safeCall(rpc, comptroller, COMPTROLLER, "borrowCaps", [cTokenAddress]),
    safeCall(rpc, comptroller, COMPTROLLER, "mintGuardianPaused", [cTokenAddress]),
    safeCall(rpc, comptroller, COMPTROLLER, "borrowGuardianPaused", [cTokenAddress]),
    oracle ? safeCall(rpc, oracle, ORACLE, "getUnderlyingPrice", [cTokenAddress]) : null,
    oracle ? safeCall(rpc, oracle, ORACLE, "getConfig", [cTokenAddress]) : null,
  ]);

  const symbol = safeText(symbolRaw?.[0], 40) || null;
  const name = safeText(nameRaw?.[0], 80) || null;
  const market = parseMarket(marketRaw);
  const asset = isNativeMarket ? NATIVE_TOKEN : normalizeAddress(underlyingRaw?.[0]);
  const assetMeta = await tokenMeta(rpc, asset, { symbol: isNativeMarket ? chain.nativeSymbol : symbol?.replace(/^ca/i, ""), decimals: 18 });
  const oracleCfg = parseOracleConfig(oracleCfgRaw);
  const oracleDecimals = oracleCfg?.underlyingAssetDecimals ?? assetMeta.decimals ?? 18;
  const priceUsd = priceUsdFromRaw(priceRaw?.[0], oracleDecimals);
  const cash = unitsToNumber(cashRaw?.[0], assetMeta.decimals ?? 18) || 0;
  const borrows = unitsToNumber(borrowsRaw?.[0], assetMeta.decimals ?? 18) || 0;
  const cashUsd = priceUsd === null ? null : cash * priceUsd;
  const borrowsUsd = priceUsd === null ? null : borrows * priceUsd;
  const borrowCap = borrowCapRaw?.[0] === undefined ? null : unitsToNumber(borrowCapRaw[0], assetMeta.decimals ?? 18);
  const capReached = borrowCapRaw?.[0] !== undefined && toBig(borrowCapRaw[0]) > 0n && toBig(borrowsRaw?.[0]) >= toBig(borrowCapRaw[0]);
  const feed = oracleCfg?.priceFeed && oracleCfg.priceFeed !== ZERO ? await feedMeta(rpc, oracleCfg.priceFeed, latest.timestamp) : null;
  const whitelistAddr = normalizeAddress(whitelistRaw?.[0]);
  let whitelist = null;
  if (whitelistAddr && whitelistAddr !== ZERO) {
    const key = whitelistAddr.toLowerCase();
    if (!whitelistCache.has(key)) whitelistCache.set(key, await whitelistMeta(rpc, whitelistAddr, normalizeAddress(cAdminRaw?.[0])));
    whitelist = whitelistCache.get(key);
  }
  const highCf = market.listed && market.cfBps >= HIGH_CF_BPS;
  const fixedOracle = Boolean(oracleCfg?.fixedPriceRaw && toBig(oracleCfg.fixedPriceRaw) > 0n);
  const chainlinkOracle = Boolean(feed);
  const noStaleGuard = chainlinkOracle;
  const feedAge = asNumber(feed?.ageSeconds);
  const staleButAccepted = Boolean(noStaleGuard && feedAge !== null && feedAge > STALE_WARN_SECONDS && (priceUsd || 0) > 0);
  const mintWhitelistActive = Boolean(whitelist?.active);
  const mintPaused = Boolean(mintPausedRaw?.[0]);
  const borrowPaused = Boolean(borrowPausedRaw?.[0]);
  const transferPaused = Boolean(chainPause.transferGuardianPaused);
  const seizePaused = Boolean(chainPause.seizeGuardianPaused);
  const borrowable = market.listed && !borrowPaused && !capReached && (priceUsd || 0) > 0 && (cashUsd || 0) >= MATERIAL_USD;
  const fixedOracleWatch = Boolean(fixedOracle && market.cfBps >= FIXED_ORACLE_WATCH_CF_BPS && borrowable);
  const watchCandidate = Boolean((staleButAccepted && highCf && borrowable) || (fixedOracleWatch && (cashUsd || 0) >= MATERIAL_USD));
  const flags = [];
  if (highCf) flags.push("highCF");
  if (fixedOracle) flags.push("fixedOracle");
  if (chainlinkOracle) flags.push("chainlinkNoStaleGuard");
  if (staleButAccepted) flags.push("staleButAccepted");
  if (mintWhitelistActive) flags.push("mintWhitelistActive");
  if (mintPaused) flags.push("mintPaused");
  if (borrowPaused) flags.push("borrowPaused");
  if (transferPaused) flags.push("transferPaused");
  if (seizePaused) flags.push("seizePaused");
  if (capReached) flags.push("borrowCapReached");
  if (watchCandidate) flags.push("watchCandidate");

  return {
    chain: chain.chain,
    chainId: chain.chainId,
    comptroller,
    cToken: cTokenAddress,
    cTokenCodePresent: Boolean(code && code !== "0x"),
    cTokenCodeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    symbol,
    name,
    cTokenDecimals: cDecimalsRaw?.[0] === undefined ? null : Number(cDecimalsRaw[0]),
    asset: assetMeta.address || asset,
    assetSymbol: assetMeta.symbol,
    assetDecimals: assetMeta.decimals,
    isNativeMarket,
    listed: market.listed,
    collateralFactorBps: market.cfBps,
    comped: market.comped,
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
    cTokenAdmin: normalizeAddress(cAdminRaw?.[0]),
    cTokenPendingAdmin: normalizeAddress(cPendingAdminRaw?.[0]),
    cTokenComptroller: normalizeAddress(cComptrollerRaw?.[0]),
    cTokenImplementation: normalizeAddress(cImplRaw?.[0]),
    whitelist: whitelist ? {
      address: whitelist.whitelist,
      active: whitelist.active,
      defaultAdminRoleCount: whitelist.defaultAdminRoleCount,
      whitelistedRoleCount: whitelist.whitelistedRoleCount,
      knownAdminHasDefaultAdminRole: whitelist.knownAdminHasDefaultAdminRole,
    } : null,
    borrowCap,
    capReached,
    mintPaused,
    borrowPaused,
    transferPaused,
    seizePaused,
    priceUsd: round(priceUsd, 10),
    priceRaw: priceRaw?.[0]?.toString?.() || null,
    oracle: {
      oracle,
      configResolved: Boolean(oracleCfg),
      underlyingAssetDecimals: oracleDecimals,
      priceFeed: oracleCfg?.priceFeed || null,
      fixedPriceRaw: oracleCfg?.fixedPriceRaw || null,
      fixedOracle,
      chainlinkOracle,
      noStaleGuard,
      feed,
    },
    highCf,
    borrowable,
    fixedOracleWatch,
    staleButAccepted,
    mintWhitelistActive,
    watchCandidate,
    routePositive: false,
    flags: flags.join(","),
    blocker: watchCandidate
      ? "Watch-only: needs accepted-value divergence plus exact borrow/exit economics and fork proof"
      : "No route-positive borrow/liquidation economics proven",
  };
}

async function scanChain(chain, rpc) {
  const comptroller = normalizeAddress(chain.comptroller);
  const base = { chain: chain.chain, chainId: chain.chainId, adapterKey: chain.adapterKey, comptroller, deploymentSource: chain.source, rpcResolved: Boolean(rpc) };
  if (!rpc) return { chainRow: { ...base, status: "rpc-unresolved", marketRows: 0 }, marketRows: [], borrowerRows: [], proxyRows: [], whitelistRows: [], roleRows: [], logErrors: [] };
  const [latest, code, unitrollerProxy, allMarketsRaw, oracleRaw, adminRaw, pendingAdminRaw, pauseGuardianRaw, borrowCapGuardianRaw, implRaw, pendingImplRaw, closeFactorRaw, liqIncentiveRaw, transferPausedRaw, seizePausedRaw] = await Promise.all([
    latestBlock(rpc),
    getCode(rpc, comptroller),
    proxyMeta(rpc, comptroller, "Unitroller/Comptroller"),
    safeCall(rpc, comptroller, COMPTROLLER, "getAllMarkets"),
    safeCall(rpc, comptroller, COMPTROLLER, "oracle"),
    safeCall(rpc, comptroller, COMPTROLLER, "admin"),
    safeCall(rpc, comptroller, COMPTROLLER, "pendingAdmin"),
    safeCall(rpc, comptroller, COMPTROLLER, "pauseGuardian"),
    safeCall(rpc, comptroller, COMPTROLLER, "borrowCapGuardian"),
    safeCall(rpc, comptroller, COMPTROLLER, "comptrollerImplementation"),
    safeCall(rpc, comptroller, COMPTROLLER, "pendingComptrollerImplementation"),
    safeCall(rpc, comptroller, COMPTROLLER, "closeFactorMantissa"),
    safeCall(rpc, comptroller, COMPTROLLER, "liquidationIncentiveMantissa"),
    safeCall(rpc, comptroller, COMPTROLLER, "transferGuardianPaused"),
    safeCall(rpc, comptroller, COMPTROLLER, "seizeGuardianPaused"),
  ]);
  const oracle = normalizeAddress(oracleRaw?.[0]) || normalizeAddress(chain.oracle);
  const marketsRaw = Array.isArray(allMarketsRaw?.[0]) ? allMarketsRaw[0].map(normalizeAddress).filter(Boolean) : [];
  const expectedMarkets = Object.values(chain.expectedMarkets || {}).map(normalizeAddress).filter(Boolean);
  const markets = unique([...marketsRaw, ...expectedMarkets]);
  const whitelistCache = new Map();
  const chainPause = {
    transferGuardianPaused: transferPausedRaw?.[0] === undefined ? null : Boolean(transferPausedRaw[0]),
    seizeGuardianPaused: seizePausedRaw?.[0] === undefined ? null : Boolean(seizePausedRaw[0]),
  };
  const marketRows = [];
  for (const market of markets) {
    try {
      marketRows.push(await scanMarket(rpc, chain, comptroller, oracle, market, latest, chainPause, whitelistCache));
    } catch (err) {
      marketRows.push({ chain: chain.chain, chainId: chain.chainId, comptroller, cToken: market, error: safeText(err?.message || "market-scan-failed"), routePositive: false });
    }
  }
  const borrower = await borrowerRows(rpc, chain, comptroller, marketRows, latest);
  const admin = normalizeAddress(adminRaw?.[0]);
  const pendingAdmin = normalizeAddress(pendingAdminRaw?.[0]);
  const pauseGuardian = normalizeAddress(pauseGuardianRaw?.[0]);
  const borrowCapGuardian = normalizeAddress(borrowCapGuardianRaw?.[0]);
  const oracleOwnerRaw = oracle ? await safeCall(rpc, oracle, ORACLE, "owner") : null;
  const oracleOwner = normalizeAddress(oracleOwnerRaw?.[0]);
  const [adminKind, pendingAdminKind, pauseGuardianKind, borrowCapGuardianKind, oracleKind, oracleOwnerKind] = await Promise.all([
    addressKind(rpc, admin),
    addressKind(rpc, pendingAdmin),
    addressKind(rpc, pauseGuardian),
    addressKind(rpc, borrowCapGuardian),
    addressKind(rpc, oracle),
    addressKind(rpc, oracleOwner),
  ]);
  const whitelistRows = [...whitelistCache.values()].map((row) => ({ chain: chain.chain, chainId: chain.chainId, ...row }));
  const roleRows = [
    { chain: chain.chain, chainId: chain.chainId, role: "Unitroller admin", address: admin, kind: adminKind, expectedMultisig: lowerAddress(admin) === lowerAddress("0x6C15e4Bc44CC5674b1d7956D0e9596d2E509eD24") || null },
    { chain: chain.chain, chainId: chain.chainId, role: "Unitroller pendingAdmin", address: pendingAdmin, kind: pendingAdminKind },
    { chain: chain.chain, chainId: chain.chainId, role: "Pause guardian", address: pauseGuardian, kind: pauseGuardianKind },
    { chain: chain.chain, chainId: chain.chainId, role: "Borrow cap guardian", address: borrowCapGuardian, kind: borrowCapGuardianKind },
    { chain: chain.chain, chainId: chain.chainId, role: "Oracle", address: oracle, kind: oracleKind },
    { chain: chain.chain, chainId: chain.chainId, role: "Oracle owner", address: oracleOwner, kind: oracleOwnerKind },
  ];
  const listedRows = marketRows.filter((row) => row.listed);
  const watchRows = marketRows.filter((row) => row.watchCandidate);
  return {
    chainRow: {
      ...base,
      status: code && code !== "0x" ? "scanned" : "no-code",
      blockNumber: latest.number,
      blockTimestamp: latest.timestamp,
      comptrollerCodePresent: Boolean(code && code !== "0x"),
      comptrollerCodeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
      oracle,
      expectedOracle: normalizeAddress(chain.oracle),
      admin,
      pendingAdmin,
      pauseGuardian,
      borrowCapGuardian,
      comptrollerImplementation: normalizeAddress(implRaw?.[0]) || normalizeAddress(chain.implementation),
      pendingComptrollerImplementation: normalizeAddress(pendingImplRaw?.[0]),
      closeFactorBps: closeFactorRaw?.[0] === undefined ? null : wadBps(closeFactorRaw[0]),
      liquidationIncentiveBps: liqIncentiveRaw?.[0] === undefined ? null : wadBps(liqIncentiveRaw[0]),
      transferGuardianPaused: chainPause.transferGuardianPaused,
      seizeGuardianPaused: chainPause.seizeGuardianPaused,
      marketRows: marketRows.length,
      listedRows: listedRows.length,
      highCfRows: marketRows.filter((row) => row.highCf).length,
      borrowableRows: marketRows.filter((row) => row.borrowable).length,
      highCfBorrowableRows: marketRows.filter((row) => row.highCf && row.borrowable).length,
      fixedOracleRows: marketRows.filter((row) => row.oracle?.fixedOracle).length,
      chainlinkNoStaleGuardRows: marketRows.filter((row) => row.oracle?.noStaleGuard).length,
      staleButAcceptedRows: marketRows.filter((row) => row.staleButAccepted).length,
      mintWhitelistActiveRows: marketRows.filter((row) => row.mintWhitelistActive).length,
      watchCandidates: watchRows.length,
      sampledBorrowers: borrower.rows.length,
      sampledLiquidatableBorrowers: borrower.rows.filter((row) => row.liquidatable).length,
      materialSampledLiquidatableBorrowers: borrower.rows.filter((row) => row.materialLiquidatable).length,
      borrowLogsRead: borrower.logsRead,
      borrowLogFromBlock: borrower.fromBlock,
      totalCashUsd: round(marketRows.reduce((sum, row) => sum + (asNumber(row.cashUsd) || 0), 0), 2),
      totalBorrowsUsd: round(marketRows.reduce((sum, row) => sum + (asNumber(row.borrowsUsd) || 0), 0), 2),
      routePositive: 0,
      executableNow: 0,
    },
    marketRows,
    borrowerRows: borrower.rows,
    proxyRows: [
      { chain: chain.chain, chainId: chain.chainId, ...unitrollerProxy, unitrollerImplementation: normalizeAddress(implRaw?.[0]) || normalizeAddress(chain.implementation), pendingUnitrollerImplementation: normalizeAddress(pendingImplRaw?.[0]) },
      ...(oracle ? [{ chain: chain.chain, chainId: chain.chainId, ...(await proxyMeta(rpc, oracle, "Oracle")) }] : []),
    ],
    whitelistRows,
    roleRows,
    logErrors: borrower.logErrors.map((error) => ({ chain: chain.chain, chainId: chain.chainId, error })),
  };
}

function protocolMetadataFromDiscovery() {
  const d = readJson(PUBLIC_TARGETS, {});
  const rows = [...(d.phase0Queue || []), ...(d.targetedRefreshQueue || []), ...(d.protocolCandidates || []), ...(d.consumerJoinFirst || [])];
  const row = rows.find((p) => p?.slug === "capyfi" || p?.name === "Capyfi");
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
  const json = await fetchJson("https://api.llama.fi/protocol/capyfi");
  const currentChainTvls = json?.currentChainTvls && typeof json.currentChainTvls === "object" ? json.currentChainTvls : {};
  const latestTvlRow = Array.isArray(json?.tvl) && json.tvl.length ? json.tvl[json.tvl.length - 1] : null;
  return {
    name: safeText(json?.name, 80) || local?.name || "Capyfi",
    slug: safeText(json?.slug, 80) || local?.slug || "capyfi",
    category: safeText(json?.category, 80) || local?.category || "Lending",
    chains: Array.isArray(json?.chains) ? json.chains.map((chain) => safeText(chain, 60)).filter(Boolean) : local?.chains || [],
    evmChains: local?.evmChains || ["Ethereum", "World Chain", "LaChain Network"],
    tvlUsd: asNumber(latestTvlRow?.totalLiquidityUSD) || local?.tvlUsd || null,
    currentChainTvls: Object.fromEntries(Object.entries(currentChainTvls).filter(([key]) => !String(key).includes("-")).map(([key, value]) => [safeText(key, 60), round(value, 2)])),
    change1dPct: asNumber(json?.change_1d) ?? local?.change1dPct ?? null,
    change7dPct: asNumber(json?.change_7d) ?? local?.change7dPct ?? null,
    routePriority: local?.routePriority || null,
    source: json ? "defillama-protocol-api+public-discovery" : local?.source || "fallback-static",
  };
}

function topRows(rows, filter, limit = 10) {
  return rows.filter(filter).sort((a, b) => (asNumber(b.cashUsd) || 0) - (asNumber(a.cashUsd) || 0)).slice(0, limit);
}

function writeReport(out) {
  const s = out.summary;
  const chainTable = out.chainRows.map((row) => `| ${row.chain} | ${row.status} | ${row.marketRows || 0} | ${row.highCfBorrowableRows || 0} | ${row.fixedOracleRows || 0} | ${row.chainlinkNoStaleGuardRows || 0} | ${row.mintWhitelistActiveRows || 0} | ${row.watchCandidates || 0} | ${formatUsd(row.totalCashUsd)} | ${formatUsd(row.totalBorrowsUsd)} |`).join("\n") || "| none | n/a | 0 | 0 | 0 | 0 | 0 | 0 | n/a | n/a |";
  const marketTable = topRows(out.marketRows, (row) => row.listed, 12).map((row) => `| ${row.chain} | ${row.symbol || "n/a"} | ${row.assetSymbol || "n/a"} | ${formatPctBps(row.collateralFactorBps)} | ${formatUsd(row.cashUsd)} | ${formatUsd(row.borrowsUsd)} | ${row.oracle?.fixedOracle ? "fixed" : row.oracle?.chainlinkOracle ? "chainlink-no-stale" : "unknown"} | ${row.mintWhitelistActive ? "active" : "inactive/none"} | ${row.flags || "-"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const oracleTable = topRows(out.marketRows, (row) => row.oracle?.fixedOracle || row.oracle?.chainlinkOracle, 12).map((row) => {
    const feed = row.oracle?.feed || {};
    const age = feed.ageSeconds === null || feed.ageSeconds === undefined ? "n/a" : `${Math.round(feed.ageSeconds)}s`;
    return `| ${row.chain} | ${row.symbol || "n/a"} | ${row.assetSymbol || "n/a"} | ${row.oracle?.fixedOracle ? "fixed" : "feed"} | ${compactAddress(row.oracle?.priceFeed)} | ${feed.description || "n/a"} | ${age} | ${row.staleButAccepted ? "stale-accepted" : row.oracle?.chainlinkOracle ? "fresh/unchecked" : "n/a"} |`;
  }).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const roleTable = out.roleRows.map((row) => `| ${row.chain} | ${row.role} | ${compactAddress(row.address)} | ${row.kind || "n/a"} | ${row.expectedMultisig === true ? "matches Ethereum multisig" : row.expectedMultisig === false ? "not Ethereum multisig" : "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a |";
  const whitelistTable = out.whitelistRows.map((row) => `| ${row.chain} | ${compactAddress(row.whitelist)} | ${row.active} | ${row.defaultAdminRoleCount ?? "n/a"} | ${row.whitelistedRoleCount ?? "n/a"} | ${compactAddress(row.eip1967Implementation)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";
  const borrowerTable = out.borrowerRows.slice(0, 10).map((row) => `| ${row.chain} | ${compactAddress(row.borrower)} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.shortfallUsd)} | ${row.liquidatable} |`).join("\n") || "| none sampled | n/a | n/a | n/a | false |";
  const lines = [
    `# ${SIGNAL_DORMANT} - Capyfi Phase 0`,
    "",
    `Date: ${out.generatedAt}`,
    "",
    "## Result",
    "",
    "No permissionless route-positive exploit is claimed. This read-only pass mapped Capyfi's Compound V2 fork deployments from source docs and DeFiLlama's Compound registry, then queried live market/oracle/whitelist/admin state and bounded recent borrower health. Current rows are configuration/oracle-dependency context only; no row has accepted-value divergence, exact positive borrow/liquidation economics, fork proof, or signed-action justification.",
    "",
    "## Summary",
    "",
    `- DeFiLlama target: ${out.metadata.name || "Capyfi"} (${out.metadata.slug || "capyfi"}), TVL ${formatUsd(out.metadata.tvlUsd)}.`,
    `- Chains scoped: ${s.chainsScoped}; RPC-resolved and scanned: ${s.chainsWithRpc}.`,
    `- Markets scanned: ${s.marketRows}; listed: ${s.listedRows}; high-CF borrowable: ${s.highCfBorrowableRows}.`,
    `- Fixed-oracle rows: ${s.fixedOracleRows}; Chainlink-without-oracle-stale-guard rows: ${s.chainlinkNoStaleGuardRows}; stale-but-accepted rows: ${s.staleButAcceptedRows}.`,
    `- Active whitelist rows: ${s.mintWhitelistActiveRows}; sampled borrowers: ${s.sampledBorrowers}; material liquidatable sampled rows: ${s.materialSampledLiquidatableBorrowers}.`,
    `- Watch candidates: ${s.watchCandidates}; route-positive: ${s.routePositive}; executableNow: ${s.executableNow}; signedActionJustified: ${s.signedActionJustified}.`,
    "",
    "## Chain Coverage",
    "",
    "| Chain | Status | Markets | High-CF Borrowable | Fixed Oracle | CL No Stale Guard | Active Whitelist | Watch | Cash | Borrows |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    chainTable,
    "",
    "## Market Rows",
    "",
    "| Chain | cToken | Asset | CF | Cash | Borrows | Oracle | Whitelist | Flags |",
    "|---|---|---|---:|---:|---:|---|---|---|",
    marketTable,
    "",
    "## Oracle Rows",
    "",
    "| Chain | cToken | Asset | Type | Feed | Description | Age | Status |",
    "|---|---|---|---|---|---|---:|---|",
    oracleTable,
    "",
    "## Roles",
    "",
    "| Chain | Role | Address | Kind | Note |",
    "|---|---|---|---|---|",
    roleTable,
    "",
    "## Whitelist",
    "",
    "| Chain | Whitelist | Active | Admin Role Count | Whitelisted Count | Impl |",
    "|---|---|---:|---:|---:|---|",
    whitelistTable,
    "",
    "## Borrower Sampling",
    "",
    `Borrower sampling is bounded to recent ${out.thresholds.recentBorrowLogBlocks} blocks per scanned chain and is not exhaustive.`,
    "",
    "| Chain | Borrower | Liquidity | Shortfall | Liquidatable |",
    "|---|---|---:|---:|---|",
    borrowerTable,
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
  const rpcs = await rpcPool();
  const scanResults = [];
  for (const chain of CHAINS) scanResults.push(await scanChain(chain, rpcs[chain.chainId] || null));
  const chainRows = scanResults.map((result) => result.chainRow);
  const marketRows = scanResults.flatMap((result) => result.marketRows);
  const borrowerRowsAll = scanResults.flatMap((result) => result.borrowerRows);
  const proxyRows = scanResults.flatMap((result) => result.proxyRows);
  const whitelistRows = scanResults.flatMap((result) => result.whitelistRows);
  const roleRows = scanResults.flatMap((result) => result.roleRows);
  const logErrors = scanResults.flatMap((result) => result.logErrors);
  const watchRows = marketRows.filter((row) => row.watchCandidate);
  const materialLiquidatable = borrowerRowsAll.filter((row) => row.materialLiquidatable);
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-capyfi-phase0.js",
    scope: "Capyfi Phase 0 using DeFiLlama protocol/Compound registry metadata, Capyfi public source docs/config, and live read-only EVM state",
    scopeChains: CHAINS.map((chain) => ({ chain: chain.chain, chainId: chain.chainId, adapterKey: chain.adapterKey, comptroller: chain.comptroller, cether: chain.cether })),
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
      repo: "LaChain/capyfi-sc",
      repoHead: "99d5313e4b14b3da07e4bc8e47248cb3e18954c8",
      forkedFrom: "compound-finance/compound-protocol@a3214f67b73310d547e00fc578e8355911c9d376",
      defillamaRegistry: "registries/compound.js capyfi entry",
      docs: ["docs/audit-docs.md", "script/HelperConfig.s.sol", "script/capyfi/config/ProdConfig.sol"],
      sourceAvailability: "public GitHub source and docs were used for address recovery; scanner did not clone/build or run fork transactions",
    },
    thresholds: {
      materialUsd: MATERIAL_USD,
      highCollateralFactorBps: HIGH_CF_BPS,
      fixedOracleWatchCollateralFactorBps: FIXED_ORACLE_WATCH_CF_BPS,
      staleWarnSeconds: STALE_WARN_SECONDS,
      recentBorrowLogBlocks: RECENT_BORROW_LOG_BLOCKS,
      maxBorrowersPerMarket: MAX_BORROWERS_PER_MARKET,
    },
    chainRows,
    marketRows: marketRows.sort((a, b) => (asNumber(b.cashUsd) || 0) - (asNumber(a.cashUsd) || 0)),
    borrowerRows: borrowerRowsAll.sort((a, b) => (asNumber(b.shortfallUsd) || 0) - (asNumber(a.shortfallUsd) || 0)),
    proxyRows,
    whitelistRows,
    roleRows,
    logErrors,
    topRows: topRows(marketRows, (row) => row.listed, 10),
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
      fixedOracleRows: marketRows.filter((row) => row.oracle?.fixedOracle).length,
      fixedOracleWatchRows: marketRows.filter((row) => row.fixedOracleWatch).length,
      chainlinkNoStaleGuardRows: marketRows.filter((row) => row.oracle?.noStaleGuard).length,
      staleButAcceptedRows: marketRows.filter((row) => row.staleButAccepted).length,
      mintWhitelistActiveRows: marketRows.filter((row) => row.mintWhitelistActive).length,
      mintPausedRows: marketRows.filter((row) => row.mintPaused).length,
      borrowPausedRows: marketRows.filter((row) => row.borrowPaused).length,
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
      status: "capyfi-phase0-no-route-positive",
    },
    blockers: [
      "Fixed-price and Chainlink-no-stale-guard oracle rows are configuration dependencies, not extractive routes without a current accepted-value divergence",
      "Active whitelist gates direct mint/supply paths; cToken acquisition, borrow, and unwind economics are not exact-quoted",
      "High-CF ETH/WBTC-like rows require stale/divergent accepted price plus material borrow cash and exact positive exit economics",
      "Bounded recent borrower sampling is not exhaustive and found no fork-proven exact positive liquidation route in this pass",
      "No fork extraction proof and no signed-action justification",
    ],
    requiredForRoutePositive: [
      "specific Capyfi market accepts an attacker-favorable stale, fixed, or divergent oracle value",
      "collateral acquisition or mint path is permissionless/unblocked and has material same-block liquidity",
      "borrow or liquidation path is unpaused and has material live liquidity",
      "borrowed/seized asset exit is exact-quoted positive after gas/slippage/fees",
      "fork extraction proof demonstrates positive net value",
    ],
    nextReadOnlyStep: "Keep Capyfi on oracle/whitelist/liquidation watch; exact-quote/fork only if a fixed or no-stale-guard oracle row becomes accepted-divergent, or a material liquidatable borrower appears.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
  writeReport(out);
  if (!QUIET) {
    console.log(`Wrote ${path.relative(WORKSPACE, RAW_OUT)}`);
    console.log(`Wrote ${path.relative(WORKSPACE, REPORT_OUT)}`);
    console.log(`Capyfi: chainsScanned=${out.summary.chainsScanned}/${out.summary.chainsScoped} markets=${out.summary.marketRows} highCfBorrowable=${out.summary.highCfBorrowableRows} watchCandidates=${out.summary.watchCandidates} routePositive=0`);
  }
}

main().catch((err) => { console.error(err?.message || err); process.exit(1); });
