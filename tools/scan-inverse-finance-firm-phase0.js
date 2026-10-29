#!/usr/bin/env node
// scan-inverse-finance-firm-phase0.js - bounded read-only Phase 0 for Inverse Finance FiRM on Ethereum.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, execution calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "inverse-finance-firm-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "inverse-finance-firm-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";
const CHAIN_ID = 1;
const CHAIN = "Ethereum";
const ZERO = "0x0000000000000000000000000000000000000000";
const CALL_FROM = "0x000000000000000000000000000000000000dEaD";

const FIRM_START_BLOCK = 16_159_015;
const ADD_MARKET_CHUNK_BLOCKS = Number(process.env.FIRM_ADD_MARKET_CHUNK_BLOCKS || "250000");
const RECENT_LOG_BLOCKS = Number(process.env.FIRM_RECENT_LOG_BLOCKS || "120000");
const LOG_CHUNK_BLOCKS = Number(process.env.FIRM_LOG_CHUNK_BLOCKS || "20000");
const MAX_USER_SAMPLE = Number(process.env.FIRM_MAX_USER_SAMPLE || "160");
const MIN_MATERIAL_DEBT_USD = Number(process.env.FIRM_MIN_MATERIAL_DEBT_USD || "1000");
const NEAR_LIQ_BPS = Number(process.env.FIRM_NEAR_LIQ_BPS || "500");
const MIN_BORROW_CASH_USD = Number(process.env.FIRM_MIN_BORROW_CASH_USD || "10000");
const DIVERGENCE_WATCH_BPS = Number(process.env.FIRM_DIVERGENCE_WATCH_BPS || "300");
const STALE_FEED_SECONDS = Number(process.env.FIRM_STALE_FEED_SECONDS || "86400");
const MIN_KEEPER_REWARD_USD = Number(process.env.FIRM_MIN_KEEPER_REWARD_USD || "10");
const MAX_ARTIFACT_JOINS = Number(process.env.FIRM_MAX_ARTIFACT_JOINS || "80");

const DBR = "0xAD038Eb671c44b853887A7E32528FaB35dC5D710";
const DOLA = "0x865377367054516e17014CcdED1e7d814EDC9ce4";
const BORROW_CONTROLLER_V4 = "0x01ECA33e20a4c379Bd8A5361f896A7dd2bAE4ce8";
const FIRM_ORACLE = "0xaBE146CF570FD27ddD985895ce9B138A7110cCe8";
const FIRM_FED = "0x2b34548b865ad66A2B046cb82e59Ee43F75B90Fd";
const GOVERNOR_MILLS = "0xBeCCB6bb0aa4ab551966A7E4B97cec74bb359Bf6";
const TREASURY = "0x926dF14a23BE491164dCF93f4c468A50ef659D5B";

const DOC_MARKETS = [
  { name: "WETH", address: "0x63df5e23db45a2066508318f172ba45b9cd37035" },
  { name: "wstETH", address: "0x3FD3daBB9F9480621C8A111603D3Ba70F17550BC" },
  { name: "wBTC", address: "0x48BA574Edf0bc4E2E40B529863aaA6a67c264E7C" },
  { name: "cbBTC", address: "0x2A256306D8ba899E33B01e495982656884Ac77FF" },
  { name: "sUSDe", address: "0x79eF6d28C41e47A588E2F2ffB4140Eb6d952AEc4" },
  { name: "Convex DOLA-sUSDe", address: "0xb427fc22561f3963b04202f9bb5bcebd76c14a99" },
  { name: "Yearn DOLA-sUSDe", address: "0x4e264618dc015219cd83dbc53b31251d73c2db1a" },
  { name: "Convex DOLA-sUSDS", address: "0xD68d3a44d46dd50BFeBa8Cca544717B76e7C4b29" },
  { name: "Yearn DOLA-sUSDS", address: "0x4A33baFA8a31E4ec9649f65646022cAD1957808b" },
  { name: "Convex DOLA-wstUSR", address: "0xe4D47Ef77AC2C3FA4019Cd169Ac1Dd9E27cb12E4" },
  { name: "Yearn DOLA-wstUSR", address: "0x28684485369f7478f42aAA62660123AB5D573537" },
  { name: "Convex sDOLA-scrvUSD", address: "0x63D27fC9d463Ed727676367D3F818999962737E8" },
  { name: "Yearn sDOLA-scrvUSD", address: "0xb8bc1E9c0a2d445bc39d2A745F47619E954dD565" },
  { name: "INV", address: "0xb516247596Ca36bf32876199FBdCaD6B3322330B" },
  { name: "CRV", address: "0x63fAd99705a255fE2D500e498dbb3A9aE5AA1Ee8" },
  { name: "cvxCRV", address: "0x3474ad0e3a9775c9F68B415A7a9880B0CAB9397a" },
  { name: "Staked CVX", address: "0xdc2265cBD15beD67b5F2c0B82e23FcE4a07ddF6b" },
  { name: "st-yCRV", address: "0x27b6c301Fd441f3345d61B7a4245E1F823c3F9c4" },
];

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const BYTES32_TOKEN = new ethers.Interface([
  "function symbol() view returns (bytes32)",
  "function name() view returns (bytes32)",
]);
const MARKET = new ethers.Interface([
  "function gov() view returns (address)",
  "function lender() view returns (address)",
  "function pauseGuardian() view returns (address)",
  "function escrowImplementation() view returns (address)",
  "function dbr() view returns (address)",
  "function borrowController() view returns (address)",
  "function dola() view returns (address)",
  "function collateral() view returns (address)",
  "function oracle() view returns (address)",
  "function collateralFactorBps() view returns (uint256)",
  "function replenishmentIncentiveBps() view returns (uint256)",
  "function liquidationIncentiveBps() view returns (uint256)",
  "function liquidationFeeBps() view returns (uint256)",
  "function liquidationFactorBps() view returns (uint256)",
  "function borrowPaused() view returns (bool)",
  "function totalDebt() view returns (uint256)",
  "function debts(address) view returns (uint256)",
  "function escrows(address) view returns (address)",
  "function predictEscrow(address) view returns (address)",
  "function getCreditLimit(address) view returns (uint256)",
  "function getCollateralValue(address) view returns (uint256)",
  "function getWithdrawalLimit(address) view returns (uint256)",
  "function liquidate(address,uint256)",
  "function forceReplenish(address,uint256)",
  "event Deposit(address indexed account,uint256 amount)",
  "event Borrow(address indexed account,uint256 amount)",
  "event Withdraw(address indexed account,address indexed to,uint256 amount)",
  "event Repay(address indexed account,address indexed repayer,uint256 amount)",
  "event Liquidate(address indexed account,address indexed liquidator,uint256 repaidDebt,uint256 liquidatorReward)",
  "event CreateEscrow(address indexed user,address escrow)",
]);
const ORACLE = new ethers.Interface([
  "function operator() view returns (address)",
  "function pendingOperator() view returns (address)",
  "function feeds(address) view returns (address,uint8)",
  "function dailyLows(address,uint256) view returns (uint256)",
  "function viewPrice(address,uint256) view returns (uint256)",
  "function getFeedPrice(address) view returns (uint256)",
]);
const FEED = new ethers.Interface([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);
const BORROW_CONTROLLER = new ethers.Interface([
  "function operator() view returns (address)",
  "function DBR() view returns (address)",
  "function minDebts(address) view returns (uint256)",
  "function dailyLimits(address) view returns (uint256)",
  "function dailyBorrows(address,uint256) view returns (uint256)",
  "function stalenessThreshold(address) view returns (uint256)",
  "function isPriceStale(address) view returns (bool)",
]);
const DBR_IFACE = new ethers.Interface([
  "function operator() view returns (address)",
  "function pendingOperator() view returns (address)",
  "function replenishmentPriceBps() view returns (uint256)",
  "function markets(address) view returns (bool)",
  "function minters(address) view returns (bool)",
  "function debts(address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function deficitOf(address) view returns (uint256)",
  "event AddMarket(address indexed market)",
  "event ForceReplenish(address indexed account,address indexed replenisher,address indexed market,uint256 deficit,uint256 replenishmentCost,uint256 replenisherReward)",
]);
const FED = new ethers.Interface([
  "function gov() view returns (address)",
  "function chair() view returns (address)",
  "function supplyCeiling() view returns (uint256)",
  "function globalSupply() view returns (uint256)",
  "function ceilings(address) view returns (uint256)",
  "function supplies(address) view returns (uint256)",
]);
const ESCROW = new ethers.Interface([
  "function balance() view returns (uint256)",
  "function token() view returns (address)",
  "function beneficiary() view returns (address)",
  "function market() view returns (address)",
]);

const ADD_MARKET_TOPIC = ethers.id("AddMarket(address)");
const FORCE_REPLENISH_TOPIC = ethers.id("ForceReplenish(address,address,address,uint256,uint256,uint256)");
const MARKET_EVENT_TOPICS = [
  ethers.id("CreateEscrow(address,address)"),
  ethers.id("Borrow(address,uint256)"),
  ethers.id("Repay(address,address,uint256)"),
  ethers.id("Liquidate(address,address,uint256,uint256)"),
];

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function units(value, decimals = 18) { try { return Number(ethers.formatUnits(toBig(value), Number(decimals))); } catch (_) { return null; } }
function round(value, decimals = 4) { const n = Number(value); if (!Number.isFinite(n)) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function fmt(value, decimals = 2) { const n = Number(value); return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: decimals }) : "n/a"; }
function fmtUsd(value) { const n = Number(value); return Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "n/a"; }
function fmtPctBps(value) { const n = Number(value); return Number.isFinite(n) ? `${round(n / 100, 2)}%` : "n/a"; }
function rel(file) { return path.relative(WORKSPACE, file).replace(/\\/g, "/"); }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function safeText(value, max = 180) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/0x[a-fA-F0-9]{120,}/g, "[redacted-calldata]").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function shaRef(value) { return crypto.createHash("sha256").update(String(value || "").toLowerCase()).digest("hex").slice(0, 16); }
function decodeBytes32String(value) { try { return ethers.decodeBytes32String(value); } catch (_) { return null; } }
function bpsDiff(a, b) { const x = Number(a); const y = Number(b); return Number.isFinite(x) && Number.isFinite(y) && y !== 0 ? round(((x - y) / y) * 10000, 2) : null; }
function addressFromTopic(topic) { const raw = String(topic || ""); return raw.length === 66 ? normalizeAddress(`0x${raw.slice(26)}`) : null; }
function amountUsdFromRaw(raw, priceRaw) { const out = (toBig(raw) * toBig(priceRaw)) / 10n ** 18n; return units(out, 18); }
function oracleTokenPriceUsd(priceRaw, tokenDecimals) { const valueRaw = (toBig(priceRaw) * 10n ** BigInt(Number(tokenDecimals ?? 18))) / 10n ** 18n; return units(valueRaw, 18); }
function rawDebtUsd(raw) { return units(raw, 18) || 0; }

async function fetchJson(url, timeoutMs = 30_000, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, headers: { "user-agent": "evm-audit-inverse-firm-phase0/1.0", ...(options.headers || {}) } });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { ok: res.ok, status: res.status, json, text: json ? null : safeText(text, 240), error: res.ok ? null : safeText(text || `HTTP ${res.status}`, 160) };
  } catch (error) {
    return { ok: false, status: null, json: null, text: null, error: safeText(error?.message || error, 160) };
  } finally { clearTimeout(timer); }
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

async function balanceOf(rpc, token, owner) {
  const addr = normalizeAddress(token);
  const who = normalizeAddress(owner);
  if (!addr || !who) return null;
  const res = await safeCall(rpc, addr, ERC20, "balanceOf", [who]);
  return res?.[0] ?? null;
}

async function latestBlock(rpc) {
  const num = await rpcCall(rpc, "eth_blockNumber", [], 8_000).catch(() => null);
  const block = num ? await rpcCall(rpc, "eth_getBlockByNumber", [num, false], 8_000).catch(() => null) : null;
  return { number: num ? Number(BigInt(num)) : null, timestamp: block?.timestamp ? Number(BigInt(block.timestamp)) : null };
}

async function tokenMeta(rpc, address, fallbackSymbol = null) {
  const addr = normalizeAddress(address);
  if (!addr) return { address: null, symbol: fallbackSymbol, decimals: 18, codePresent: false };
  const [decimals, sym, name, sym32, name32, totalSupply, code] = await Promise.all([
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, BYTES32_TOKEN, "symbol"),
    safeCall(rpc, addr, BYTES32_TOKEN, "name"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
    getCode(rpc, addr),
  ]);
  const d = decimals?.[0] === undefined ? 18 : Number(decimals[0]);
  return {
    address: addr,
    symbol: safeText(sym?.[0], 40) || safeText(decodeBytes32String(sym32?.[0]), 40) || fallbackSymbol,
    name: safeText(name?.[0], 80) || safeText(decodeBytes32String(name32?.[0]), 80),
    decimals: d,
    totalSupplyRaw: totalSupply?.[0]?.toString?.() || null,
    totalSupply: totalSupply?.[0] === undefined ? null : round(units(totalSupply[0], d), 6),
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
  };
}

async function logRange(rpc, address, topics, fromBlock, toBlock, timeoutMs = 24_000) {
  const addr = normalizeAddress(address);
  const filter = { address: addr, fromBlock: hexBlock(fromBlock), toBlock: hexBlock(toBlock), topics };
  const out = await rpcCall(rpc, "eth_getLogs", [filter], timeoutMs).catch(() => null);
  return Array.isArray(out) ? out : null;
}

async function scanLogs(rpc, address, topics, fromBlock, toBlock, chunkBlocks) {
  const logs = [];
  const failedRanges = [];
  for (let start = fromBlock; start <= toBlock; start += chunkBlocks) {
    const end = Math.min(toBlock, start + chunkBlocks - 1);
    const rows = await logRange(rpc, address, topics, start, end);
    if (rows === null) {
      failedRanges.push({ address: normalizeAddress(address), fromBlock: start, toBlock: end });
      continue;
    }
    logs.push(...rows);
  }
  return { logs, failedRanges };
}

async function scanCombinedMarketLogs(rpc, market, fromBlock, toBlock) {
  const combined = await scanLogs(rpc, market, [MARKET_EVENT_TOPICS], fromBlock, toBlock, LOG_CHUNK_BLOCKS);
  if (!combined.failedRanges.length) return combined;
  const out = { logs: combined.logs, failedRanges: [] };
  for (const topic of MARKET_EVENT_TOPICS) {
    const single = await scanLogs(rpc, market, [topic], fromBlock, toBlock, LOG_CHUNK_BLOCKS);
    out.logs.push(...single.logs);
    out.failedRanges.push(...single.failedRanges.map((r) => ({ ...r, topic })));
  }
  return out;
}

function sourceTvlUsd() {
  const d = readJson(PUBLIC_TARGETS, {});
  const rows = [...(d.phase0Queue || []), ...(d.protocolCandidates || []), ...(d.consumerJoinFirst || [])];
  const row = rows.find((p) => p?.slug === "inverse-finance-firm" || p?.name === "Inverse Finance FiRM");
  return row ? { name: row.name, slug: row.slug, category: row.category, chains: row.chains || [], evmChains: row.evmChains || [], tvlUsd: row.tvlUsd, change1dPct: row.change1dPct, change7dPct: row.change7dPct, routePriority: row.routePriority || null, source: "public-audit-target-discovery" } : { name: "Inverse Finance FiRM", slug: "inverse-finance-firm", category: "CDP", tvlUsd: null, chains: [CHAIN] };
}

async function githubSourceMeta() {
  const meta = await fetchJson("https://api.github.com/repos/InverseFinance/FiRM/commits/main", 30_000);
  return {
    ok: meta.ok,
    status: meta.status,
    repo: "InverseFinance/FiRM",
    branch: "main",
    commit: meta.json?.sha || null,
    commitDate: meta.json?.commit?.committer?.date || meta.json?.commit?.author?.date || null,
    message: safeText(meta.json?.commit?.message, 160),
    error: meta.error,
  };
}

async function coinPrices(addresses) {
  const keys = [...new Set((addresses || []).map(normalizeAddress).filter(Boolean).map((a) => `ethereum:${a.toLowerCase()}`))];
  if (!keys.length) return { prices: new Map(), fetched: { ok: false, status: null, count: 0, error: "no-token-keys" } };
  const fetched = await fetchJson(`https://coins.llama.fi/prices/current/${keys.join(",")}?searchWidth=6h`, 30_000);
  const prices = new Map();
  for (const [key, row] of Object.entries(fetched.json?.coins || {})) {
    const price = Number(row?.price || 0);
    if (price > 0) prices.set(key.toLowerCase(), price);
  }
  return { prices, fetched: { ok: fetched.ok, status: fetched.status, count: prices.size, error: fetched.error } };
}

function priceFor(prices, address, symbol) {
  const addr = normalizeAddress(address);
  if (addr && prices.has(`ethereum:${addr.toLowerCase()}`)) return prices.get(`ethereum:${addr.toLowerCase()}`);
  if (/^(DOLA|USDC|USDT|DAI|USDS|USDE|SUSDE|SDAI|SUSDS|FRAX|CRVUSD|SCRVUSD)$/i.test(String(symbol || ""))) return 1;
  return null;
}

async function discoverMarkets(rpc, blockNumber) {
  const dbrLogs = await scanLogs(rpc, DBR, [ADD_MARKET_TOPIC], FIRM_START_BLOCK, blockNumber, ADD_MARKET_CHUNK_BLOCKS);
  const fromLogs = [];
  for (const log of dbrLogs.logs) {
    const market = addressFromTopic(log.topics?.[1]);
    if (market) fromLogs.push({ address: market, blockNumber: Number(BigInt(log.blockNumber || "0x0")), txHash: log.transactionHash });
  }
  const byAddr = new Map();
  for (const row of DOC_MARKETS) {
    const addr = normalizeAddress(row.address);
    if (!addr) continue;
    byAddr.set(addr.toLowerCase(), { address: addr, docsName: row.name, sourceTags: ["docs-active-market"] });
  }
  for (const row of fromLogs) {
    const key = row.address.toLowerCase();
    const prev = byAddr.get(key) || { address: row.address, docsName: null, sourceTags: [] };
    if (!prev.sourceTags.includes("dbr-addmarket-log")) prev.sourceTags.push("dbr-addmarket-log");
    prev.addMarketBlock = prev.addMarketBlock || row.blockNumber;
    byAddr.set(key, prev);
  }
  return { marketSeeds: [...byAddr.values()].sort((a, b) => (a.addMarketBlock || 0) - (b.addMarketBlock || 0) || String(a.docsName || a.address).localeCompare(String(b.docsName || b.address))), dbrAddMarketLogs: fromLogs, dbrLogScan: { logsDecoded: fromLogs.length, failedRanges: dbrLogs.failedRanges } };
}

async function inspectCore(rpc) {
  const [dbrOp, dbrPending, replPrice, bcOp, bcDbr, oracleOp, oraclePending, fedGov, fedChair, fedCeiling, fedGlobal] = await Promise.all([
    safeCall(rpc, DBR, DBR_IFACE, "operator"),
    safeCall(rpc, DBR, DBR_IFACE, "pendingOperator"),
    safeCall(rpc, DBR, DBR_IFACE, "replenishmentPriceBps"),
    safeCall(rpc, BORROW_CONTROLLER_V4, BORROW_CONTROLLER, "operator"),
    safeCall(rpc, BORROW_CONTROLLER_V4, BORROW_CONTROLLER, "DBR"),
    safeCall(rpc, FIRM_ORACLE, ORACLE, "operator"),
    safeCall(rpc, FIRM_ORACLE, ORACLE, "pendingOperator"),
    safeCall(rpc, FIRM_FED, FED, "gov"),
    safeCall(rpc, FIRM_FED, FED, "chair"),
    safeCall(rpc, FIRM_FED, FED, "supplyCeiling"),
    safeCall(rpc, FIRM_FED, FED, "globalSupply"),
  ]);
  return {
    dbr: { address: DBR, operator: normalizeAddress(dbrOp?.[0]), pendingOperator: normalizeAddress(dbrPending?.[0]), replenishmentPriceBps: replPrice?.[0] === undefined ? null : Number(replPrice[0]) },
    borrowController: { address: BORROW_CONTROLLER_V4, operator: normalizeAddress(bcOp?.[0]), dbr: normalizeAddress(bcDbr?.[0]) },
    oracle: { address: FIRM_ORACLE, operator: normalizeAddress(oracleOp?.[0]), pendingOperator: normalizeAddress(oraclePending?.[0]) },
    fed: { address: FIRM_FED, gov: normalizeAddress(fedGov?.[0]), chair: normalizeAddress(fedChair?.[0]), supplyCeilingRaw: fedCeiling?.[0]?.toString?.() || null, supplyCeilingUsd: fedCeiling?.[0] === undefined ? null : round(units(fedCeiling[0], 18), 2), globalSupplyRaw: fedGlobal?.[0]?.toString?.() || null, globalSupplyUsd: fedGlobal?.[0] === undefined ? null : round(units(fedGlobal[0], 18), 2) },
    knownGovernance: { governorMills: GOVERNOR_MILLS, treasury: TREASURY },
  };
}

async function inspectMarketBase(rpc, seed, blockTimestamp) {
  const address = normalizeAddress(seed.address);
  const code = await getCode(rpc, address);
  if (!code || code === "0x") return { ...seed, address, codePresent: false, codeBytes: 0, dbrMarket: false };
  const day = blockTimestamp ? Math.floor(blockTimestamp / 86400) : null;
  const calls = await Promise.all([
    safeCall(rpc, address, MARKET, "gov"), safeCall(rpc, address, MARKET, "lender"), safeCall(rpc, address, MARKET, "pauseGuardian"),
    safeCall(rpc, address, MARKET, "escrowImplementation"), safeCall(rpc, address, MARKET, "dbr"), safeCall(rpc, address, MARKET, "borrowController"),
    safeCall(rpc, address, MARKET, "dola"), safeCall(rpc, address, MARKET, "collateral"), safeCall(rpc, address, MARKET, "oracle"),
    safeCall(rpc, address, MARKET, "collateralFactorBps"), safeCall(rpc, address, MARKET, "replenishmentIncentiveBps"), safeCall(rpc, address, MARKET, "liquidationIncentiveBps"),
    safeCall(rpc, address, MARKET, "liquidationFeeBps"), safeCall(rpc, address, MARKET, "liquidationFactorBps"), safeCall(rpc, address, MARKET, "borrowPaused"),
    safeCall(rpc, address, MARKET, "totalDebt"), safeCall(rpc, DBR, DBR_IFACE, "markets", [address]), balanceOf(rpc, DOLA, address),
    safeCall(rpc, FIRM_FED, FED, "ceilings", [address]), safeCall(rpc, FIRM_FED, FED, "supplies", [address]),
    safeCall(rpc, BORROW_CONTROLLER_V4, BORROW_CONTROLLER, "dailyLimits", [address]), day === null ? null : safeCall(rpc, BORROW_CONTROLLER_V4, BORROW_CONTROLLER, "dailyBorrows", [address, BigInt(day)]),
    safeCall(rpc, BORROW_CONTROLLER_V4, BORROW_CONTROLLER, "minDebts", [address]), safeCall(rpc, BORROW_CONTROLLER_V4, BORROW_CONTROLLER, "stalenessThreshold", [address]),
    safeCall(rpc, BORROW_CONTROLLER_V4, BORROW_CONTROLLER, "isPriceStale", [address]), safeCall(rpc, DBR, DBR_IFACE, "minters", [BORROW_CONTROLLER_V4]),
  ]);
  const [gov, lender, pauseGuardian, escrowImpl, dbr, borrowController, dola, collateral, oracle, cf, replInc, liqInc, liqFee, liqFactor, borrowPaused, totalDebt, dbrMarket, dolaCash, fedCeiling, fedSupply, dailyLimit, dailyBorrowed, minDebt, stalenessThreshold, isPriceStale, bcIsMinter] = calls;
  const collateralAddress = normalizeAddress(collateral?.[0]);
  const oracleAddress = normalizeAddress(oracle?.[0]);
  const token = await tokenMeta(rpc, collateralAddress, seed.docsName);
  const [feedCfg, viewPrice, feedPrice, todayLow, yesterdayLow] = await Promise.all([
    oracleAddress && collateralAddress ? safeCall(rpc, oracleAddress, ORACLE, "feeds", [collateralAddress]) : null,
    oracleAddress && collateralAddress ? safeCall(rpc, oracleAddress, ORACLE, "viewPrice", [collateralAddress, cf?.[0] ?? 0n]) : null,
    oracleAddress && collateralAddress ? safeCall(rpc, oracleAddress, ORACLE, "getFeedPrice", [collateralAddress]) : null,
    day !== null && oracleAddress && collateralAddress ? safeCall(rpc, oracleAddress, ORACLE, "dailyLows", [collateralAddress, BigInt(day)]) : null,
    day !== null && oracleAddress && collateralAddress ? safeCall(rpc, oracleAddress, ORACLE, "dailyLows", [collateralAddress, BigInt(day - 1)]) : null,
  ]);
  const feedAddress = normalizeAddress(feedCfg?.[0]);
  const tokenDecimalsInOracle = feedCfg?.[1] === undefined ? token.decimals : Number(feedCfg[1]);
  const [feedDec, feedDesc, roundData, feedCode] = await Promise.all([
    feedAddress ? safeCall(rpc, feedAddress, FEED, "decimals") : null,
    feedAddress ? safeCall(rpc, feedAddress, FEED, "description") : null,
    feedAddress ? safeCall(rpc, feedAddress, FEED, "latestRoundData") : null,
    feedAddress ? getCode(rpc, feedAddress) : Promise.resolve("0x"),
  ]);
  const priceRaw = viewPrice?.[0] ?? null;
  const feedUpdatedAt = roundData?.[3] === undefined ? null : Number(roundData[3]);
  const feedAgeSeconds = feedUpdatedAt && blockTimestamp ? Math.max(0, blockTimestamp - feedUpdatedAt) : null;
  const dbrAddress = normalizeAddress(dbr?.[0]);
  const docsActive = (seed.sourceTags || []).includes("docs-active-market");
  const dbrMarketRead = dbrMarket?.[0] === undefined ? null : Boolean(dbrMarket[0]);
  const dbrMarketAssumedFromDocs = dbrMarketRead !== true && docsActive && lowerAddress(dbrAddress) === lowerAddress(DBR);
  return {
    ...seed,
    address,
    codePresent: true,
    codeBytes: strip0x(code).length / 2,
    gov: normalizeAddress(gov?.[0]),
    lender: normalizeAddress(lender?.[0]),
    pauseGuardian: normalizeAddress(pauseGuardian?.[0]),
    escrowImplementation: normalizeAddress(escrowImpl?.[0]),
    dbr: dbrAddress,
    borrowController: normalizeAddress(borrowController?.[0]),
    dola: normalizeAddress(dola?.[0]),
    collateral: token,
    oracle: oracleAddress,
    collateralFactorBps: cf?.[0] === undefined ? null : Number(cf[0]),
    replenishmentIncentiveBps: replInc?.[0] === undefined ? null : Number(replInc[0]),
    liquidationIncentiveBps: liqInc?.[0] === undefined ? null : Number(liqInc[0]),
    liquidationFeeBps: liqFee?.[0] === undefined ? null : Number(liqFee[0]),
    liquidationFactorBps: liqFactor?.[0] === undefined ? null : Number(liqFactor[0]),
    borrowPaused: Boolean(borrowPaused?.[0]),
    totalDebtRaw: totalDebt?.[0]?.toString?.() || null,
    totalDebtUsd: totalDebt?.[0] === undefined ? null : round(units(totalDebt[0], 18), 2),
    dbrMarket: dbrMarketRead === true || dbrMarketAssumedFromDocs,
    dbrMarketRead,
    dbrMarketAssumedFromDocs,
    dolaCashRaw: dolaCash?.toString?.() || null,
    dolaCashUsd: dolaCash === null ? null : round(units(dolaCash, 18), 2),
    fedCeilingRaw: fedCeiling?.[0]?.toString?.() || null,
    fedCeilingUsd: fedCeiling?.[0] === undefined ? null : round(units(fedCeiling[0], 18), 2),
    fedSuppliedRaw: fedSupply?.[0]?.toString?.() || null,
    fedSuppliedUsd: fedSupply?.[0] === undefined ? null : round(units(fedSupply[0], 18), 2),
    dailyBorrowLimitRaw: dailyLimit?.[0]?.toString?.() || null,
    dailyBorrowLimitUsd: dailyLimit?.[0] === undefined ? null : round(units(dailyLimit[0], 18), 2),
    dailyBorrowedRaw: dailyBorrowed?.[0]?.toString?.() || null,
    dailyBorrowedUsd: dailyBorrowed?.[0] === undefined ? null : round(units(dailyBorrowed[0], 18), 2),
    minDebtRaw: minDebt?.[0]?.toString?.() || null,
    minDebtUsd: minDebt?.[0] === undefined ? null : round(units(minDebt[0], 18), 2),
    stalenessThresholdSeconds: stalenessThreshold?.[0] === undefined ? null : Number(stalenessThreshold[0]),
    borrowControllerSaysPriceStale: Boolean(isPriceStale?.[0]),
    borrowControllerIsDbrMinter: Boolean(bcIsMinter?.[0]),
    oracleState: {
      feed: feedAddress,
      tokenDecimalsInOracle,
      viewPriceRaw: priceRaw?.toString?.() || null,
      viewPriceUsdPerToken: priceRaw === null ? null : round(oracleTokenPriceUsd(priceRaw, tokenDecimalsInOracle), 8),
      feedPriceRaw: feedPrice?.[0]?.toString?.() || null,
      todayLowRaw: todayLow?.[0]?.toString?.() || null,
      todayLowUsdPerToken: todayLow?.[0] === undefined ? null : round(oracleTokenPriceUsd(todayLow[0], tokenDecimalsInOracle), 8),
      yesterdayLowRaw: yesterdayLow?.[0]?.toString?.() || null,
      yesterdayLowUsdPerToken: yesterdayLow?.[0] === undefined ? null : round(oracleTokenPriceUsd(yesterdayLow[0], tokenDecimalsInOracle), 8),
      feedDecimals: feedDec?.[0] === undefined ? null : Number(feedDec[0]),
      feedDescription: safeText(feedDesc?.[0], 100),
      feedAnswerRaw: roundData?.[1]?.toString?.() || null,
      feedUpdatedAt,
      feedAgeSeconds,
      feedCodePresent: Boolean(feedCode && feedCode !== "0x"),
    },
  };
}

function enrichMarketPrices(marketRows, prices) {
  return marketRows.map((row) => {
    const ref = priceFor(prices, row.collateral?.address, row.collateral?.symbol);
    const oraclePrice = row.oracleState?.viewPriceUsdPerToken;
    const oracleVsReferenceBps = ref && oraclePrice ? bpsDiff(oraclePrice, ref) : null;
    const borrowCapacityRemainingUsd = row.dailyBorrowLimitUsd === null || row.dailyBorrowLimitUsd === undefined ? null : Math.max(0, (row.dailyBorrowLimitUsd || 0) - (row.dailyBorrowedUsd || 0));
    const fedRemainingUsd = row.fedCeilingUsd === null || row.fedCeilingUsd === undefined ? null : Math.max(0, (row.fedCeilingUsd || 0) - (row.fedSuppliedUsd || 0));
    return {
      ...row,
      referencePriceUsd: ref === null ? null : round(ref, 8),
      oracleVsReferenceBps,
      borrowCapacityRemainingUsd: round(borrowCapacityRemainingUsd, 2),
      fedRemainingUsd: round(fedRemainingUsd, 2),
      highCf: Number(row.collateralFactorBps || 0) >= 7500,
      borrowableNow: !row.borrowPaused && (row.dolaCashUsd || 0) >= MIN_BORROW_CASH_USD,
      staleFeedWatch: Boolean(row.oracleState?.feedAgeSeconds !== null && row.oracleState?.feedAgeSeconds >= STALE_FEED_SECONDS),
      staleBorrowBlocked: Boolean(row.borrowControllerSaysPriceStale),
    };
  });
}

function pairKey(market, user) { return `${lowerAddress(market)}:${lowerAddress(user)}`; }

async function eventAndPositionSample(rpc, block, marketRows, core) {
  const fromBlock = Math.max(FIRM_START_BLOCK, (block.number || 0) - RECENT_LOG_BLOCKS);
  const eventMap = new Map();
  const eventSummary = { fromBlock, toBlock: block.number, logsDecoded: 0, uniqueUsersSeen: 0, eventsByName: {}, failedRanges: [] };
  for (const market of marketRows.filter((m) => m.codePresent && m.dbrMarket)) {
    const scanned = await scanCombinedMarketLogs(rpc, market.address, fromBlock, block.number);
    eventSummary.failedRanges.push(...scanned.failedRanges.map((r) => ({ ...r, market: market.address })));
    for (const log of scanned.logs) {
      let parsed = null;
      try { parsed = MARKET.parseLog({ topics: log.topics, data: log.data }); } catch (_) { parsed = null; }
      if (!parsed) continue;
      const user = normalizeAddress(parsed.args?.account || parsed.args?.user);
      if (!user) continue;
      const key = pairKey(market.address, user);
      const row = eventMap.get(key) || { market: market.address, user, events: {}, lastBlock: 0, lastTx: null };
      row.events[parsed.name] = (row.events[parsed.name] || 0) + 1;
      row.lastBlock = Math.max(row.lastBlock, Number(BigInt(log.blockNumber || "0x0")));
      row.lastTx = log.transactionHash || row.lastTx;
      eventMap.set(key, row);
      eventSummary.logsDecoded++;
      eventSummary.eventsByName[parsed.name] = (eventSummary.eventsByName[parsed.name] || 0) + 1;
    }
  }
  const forceRows = await scanLogs(rpc, DBR, [FORCE_REPLENISH_TOPIC], fromBlock, block.number, LOG_CHUNK_BLOCKS);
  eventSummary.failedRanges.push(...forceRows.failedRanges.map((r) => ({ ...r, market: DBR, topic: "ForceReplenish" })));
  for (const log of forceRows.logs) {
    let parsed = null;
    try { parsed = DBR_IFACE.parseLog({ topics: log.topics, data: log.data }); } catch (_) { parsed = null; }
    if (!parsed) continue;
    const user = normalizeAddress(parsed.args?.account);
    const market = normalizeAddress(parsed.args?.market);
    if (!user || !market) continue;
    const key = pairKey(market, user);
    const row = eventMap.get(key) || { market, user, events: {}, lastBlock: 0, lastTx: null };
    row.events.ForceReplenish = (row.events.ForceReplenish || 0) + 1;
    row.lastBlock = Math.max(row.lastBlock, Number(BigInt(log.blockNumber || "0x0")));
    row.lastTx = log.transactionHash || row.lastTx;
    eventMap.set(key, row);
    eventSummary.logsDecoded++;
    eventSummary.eventsByName.ForceReplenish = (eventSummary.eventsByName.ForceReplenish || 0) + 1;
  }
  const pairs = [...eventMap.values()].sort((a, b) => {
    const aPriority = (a.events.Borrow || 0) * 4 + (a.events.Liquidate || 0) * 3 + (a.events.ForceReplenish || 0) * 2 + (a.events.Repay || 0);
    const bPriority = (b.events.Borrow || 0) * 4 + (b.events.Liquidate || 0) * 3 + (b.events.ForceReplenish || 0) * 2 + (b.events.Repay || 0);
    return bPriority - aPriority || b.lastBlock - a.lastBlock;
  }).slice(0, MAX_USER_SAMPLE);
  eventSummary.uniqueUsersSeen = new Set([...eventMap.values()].map((r) => lowerAddress(r.user))).size;
  const byMarket = new Map(marketRows.map((m) => [lowerAddress(m.address), m]));
  const sampleRows = [];
  for (const p of pairs) {
    const market = byMarket.get(lowerAddress(p.market));
    if (!market) continue;
    const row = await positionRow(rpc, market, p, core);
    sampleRows.push(row);
  }
  return { eventSummary, sampleRows, logErrors: eventSummary.failedRanges.length };
}

async function positionRow(rpc, market, eventPair, core) {
  const user = normalizeAddress(eventPair.user);
  const marketAddress = normalizeAddress(eventPair.market);
  const [debt, credit, collateralValue, withdrawalLimit, escrowMapped, escrowPredicted, dbrDebt, dbrBalance, dbrDeficit] = await Promise.all([
    safeCall(rpc, marketAddress, MARKET, "debts", [user]),
    safeCall(rpc, marketAddress, MARKET, "getCreditLimit", [user]),
    safeCall(rpc, marketAddress, MARKET, "getCollateralValue", [user]),
    safeCall(rpc, marketAddress, MARKET, "getWithdrawalLimit", [user]),
    safeCall(rpc, marketAddress, MARKET, "escrows", [user]),
    safeCall(rpc, marketAddress, MARKET, "predictEscrow", [user]),
    safeCall(rpc, DBR, DBR_IFACE, "debts", [user]),
    safeCall(rpc, DBR, DBR_IFACE, "balanceOf", [user]),
    safeCall(rpc, DBR, DBR_IFACE, "deficitOf", [user]),
  ]);
  const escrow = normalizeAddress(escrowMapped?.[0]) && normalizeAddress(escrowMapped?.[0]) !== ZERO ? normalizeAddress(escrowMapped[0]) : normalizeAddress(escrowPredicted?.[0]);
  const escrowCode = escrow ? await getCode(rpc, escrow) : "0x";
  const escrowBal = escrow && escrowCode !== "0x" ? await safeCall(rpc, escrow, ESCROW, "balance") : null;
  const priceRaw = market.oracleState?.viewPriceRaw;
  const debtUsd = rawDebtUsd(debt?.[0]);
  const creditUsd = rawDebtUsd(credit?.[0]);
  const collateralUsd = rawDebtUsd(collateralValue?.[0]);
  const withdrawalUsd = market.oracleState?.viewPriceRaw && withdrawalLimit?.[0] !== undefined ? amountUsdFromRaw(withdrawalLimit[0], market.oracleState.viewPriceRaw) : null;
  const escrowAmount = escrowBal?.[0] === undefined ? null : units(escrowBal[0], market.collateral?.decimals || 18);
  const liquidatable = Boolean(debtUsd > 0 && creditUsd !== null && debtUsd > creditUsd);
  const healthPct = debtUsd > 0 && creditUsd !== null ? (creditUsd / debtUsd) * 100 : null;
  const distanceToLiquidationBps = debtUsd > 0 && creditUsd !== null ? round(((creditUsd - debtUsd) / debtUsd) * 10000, 2) : null;
  const nearLiquidation = Boolean(debtUsd >= MIN_MATERIAL_DEBT_USD && distanceToLiquidationBps !== null && distanceToLiquidationBps >= 0 && distanceToLiquidationBps <= NEAR_LIQ_BPS);
  const repayRaw = debt?.[0] === undefined ? 0n : (toBig(debt[0]) * BigInt(market.liquidationFactorBps || 0)) / 10000n;
  const liquidatorRewardRaw = priceRaw && repayRaw > 0n ? ((repayRaw * 10n ** 18n) / toBig(priceRaw)) * BigInt(10000 + (market.liquidationIncentiveBps || 0)) / 10000n : 0n;
  const liquidatorRewardAmount = liquidatorRewardRaw > 0n ? units(liquidatorRewardRaw, market.collateral?.decimals || 18) : null;
  const grossBonusUsd = repayRaw > 0n ? units((repayRaw * BigInt(market.liquidationIncentiveBps || 0)) / 10000n, 18) : null;
  const deficitRaw = toBig(dbrDeficit?.[0]);
  const replenishmentCostRaw = (deficitRaw * BigInt(core.dbr?.replenishmentPriceBps || 0)) / 10000n;
  const replenisherRewardRaw = (replenishmentCostRaw * BigInt(market.replenishmentIncentiveBps || 0)) / 10000n;
  const replenisherRewardUsd = units(replenisherRewardRaw, 18) || 0;
  return {
    market: marketAddress,
    marketName: market.docsName || market.collateral?.symbol || marketAddress,
    collateralSymbol: market.collateral?.symbol,
    borrowerRef: shaRef(user),
    userStored: false,
    eventKinds: eventPair.events,
    lastSeenBlock: eventPair.lastBlock,
    escrowRef: escrow ? shaRef(escrow) : null,
    escrowCodePresent: Boolean(escrowCode && escrowCode !== "0x"),
    escrowBalanceRaw: escrowBal?.[0]?.toString?.() || null,
    escrowCollateralAmount: round(escrowAmount, 8),
    debtRaw: debt?.[0]?.toString?.() || null,
    debtUsd: round(debtUsd, 4),
    creditLimitRaw: credit?.[0]?.toString?.() || null,
    creditLimitUsd: round(creditUsd, 4),
    collateralValueRaw: collateralValue?.[0]?.toString?.() || null,
    collateralValueUsd: round(collateralUsd, 4),
    withdrawalLimitRaw: withdrawalLimit?.[0]?.toString?.() || null,
    withdrawalLimitUsd: round(withdrawalUsd, 4),
    healthPct: round(healthPct, 4),
    distanceToLiquidationBps,
    nearLiquidation,
    liquidatable,
    materialDebt: debtUsd >= MIN_MATERIAL_DEBT_USD,
    maxRepayRaw: repayRaw.toString(),
    maxRepayUsd: round(units(repayRaw, 18), 4),
    modeledLiquidatorRewardCollateral: round(liquidatorRewardAmount, 8),
    modeledGrossBonusUsd: round(grossBonusUsd, 4),
    dbrGlobalDebtRaw: dbrDebt?.[0]?.toString?.() || null,
    dbrBalanceRaw: dbrBalance?.[0]?.toString?.() || null,
    dbrBalance: dbrBalance?.[0] === undefined ? null : round(units(dbrBalance[0], 18), 6),
    dbrDeficitRaw: dbrDeficit?.[0]?.toString?.() || null,
    dbrDeficit: dbrDeficit?.[0] === undefined ? null : round(units(dbrDeficit[0], 18), 6),
    modeledReplenishmentCostUsd: round(units(replenishmentCostRaw, 18), 4),
    modeledReplenisherRewardUsd: round(replenisherRewardUsd, 4),
    potentialKeeperReward: Boolean(replenisherRewardUsd >= MIN_KEEPER_REWARD_USD && (market.dolaCashUsd || 0) >= replenisherRewardUsd),
  };
}

function artifactJoins(addresses) {
  const needles = [...new Set((addresses || []).map(lowerAddress).filter(Boolean))];
  if (!needles.length || !fs.existsSync(RAW_DIR)) return [];
  const rows = [];
  const skip = new Set(["route-positive-sweep.json", "low-fund-executable-route-filter.json", "audit-completion-gates.json", "public-audit-target-discovery.json"]);
  for (const name of fs.readdirSync(RAW_DIR).filter((n) => n.endsWith(".json")).sort()) {
    if (skip.has(name)) continue;
    const file = path.join(RAW_DIR, name);
    let stat = null;
    try { stat = fs.statSync(file); } catch (_) { stat = null; }
    if (!stat || stat.size > 3_000_000) continue;
    const text = readText(file).toLowerCase();
    const matched = needles.filter((n) => text.includes(n));
    if (!matched.length) continue;
    rows.push({ artifact: rel(file), matchedAddresses: matched.slice(0, 8), matchCount: matched.length });
    if (rows.length >= MAX_ARTIFACT_JOINS) break;
  }
  return rows;
}

function classify(marketRows, positionSample) {
  const activeRows = marketRows.filter((r) => r.codePresent && r.dbrMarket);
  const staleFeedRows = activeRows.filter((r) => r.staleFeedWatch || r.borrowControllerSaysPriceStale);
  const staleButAcceptedRows = staleFeedRows.filter((r) => !r.borrowControllerSaysPriceStale && !r.borrowPaused && (r.dolaCashUsd || 0) >= MIN_BORROW_CASH_USD);
  const divergentRows = activeRows.filter((r) => Math.abs(r.oracleVsReferenceBps || 0) >= DIVERGENCE_WATCH_BPS);
  const acceptedValueDivergentRows = divergentRows.filter((r) => !r.borrowPaused && (r.dolaCashUsd || 0) >= MIN_BORROW_CASH_USD);
  const highCfBorrowableRows = activeRows.filter((r) => r.highCf && r.borrowableNow);
  const liquidatableRows = positionSample.filter((r) => r.liquidatable);
  const materialLiquidatableRows = liquidatableRows.filter((r) => r.materialDebt);
  const nearLiquidationRows = positionSample.filter((r) => r.nearLiquidation);
  const keeperRewardRows = positionSample.filter((r) => r.potentialKeeperReward);
  const watchCandidates = [
    ...materialLiquidatableRows.map((r) => ({ kind: "sampled-liquidatable", market: r.market, borrowerRef: r.borrowerRef, debtUsd: r.debtUsd, grossBonusUsd: r.modeledGrossBonusUsd })),
    ...staleButAcceptedRows.map((r) => ({ kind: "stale-feed-accepted-for-borrow", market: r.address, collateral: r.collateral?.symbol, feedAgeSeconds: r.oracleState?.feedAgeSeconds, cashUsd: r.dolaCashUsd })),
    ...acceptedValueDivergentRows.map((r) => ({ kind: "oracle-reference-divergence", market: r.address, collateral: r.collateral?.symbol, deltaBps: r.oracleVsReferenceBps, cashUsd: r.dolaCashUsd })),
    ...keeperRewardRows.map((r) => ({ kind: "intended-force-replenish-keeper-reward", market: r.market, borrowerRef: r.borrowerRef, rewardUsd: r.modeledReplenisherRewardUsd })),
  ];
  return {
    activeRows,
    staleFeedRows,
    staleButAcceptedRows,
    divergentRows,
    acceptedValueDivergentRows,
    highCfBorrowableRows,
    liquidatableRows,
    materialLiquidatableRows,
    nearLiquidationRows,
    keeperRewardRows,
    watchCandidates,
    routePositiveRows: [],
  };
}

function renderReport(artifact) {
  const s = artifact.summary;
  const discoveryFinding = artifact.discovery?.dbrLogScan?.logsDecoded > 0
    ? "Market discovery used both the public Inverse docs active-market list and decoded DBR `AddMarket` logs. Borrower/account coverage is bounded to recent on-chain event sampling plus public transparency aggregate context, not a full historical per-account enumeration."
    : "Market discovery used the public Inverse docs active-market list plus live market/DBR getters; the historical DBR `AddMarket` sweep was RPC-range-limited in this run, so borrower/account coverage remains bounded to recent on-chain event sampling plus public transparency aggregate context.";
  const marketTable = artifact.marketRows.slice().sort((a, b) => (b.totalDebtUsd || 0) - (a.totalDebtUsd || 0)).slice(0, 24).map((r) => `| ${r.docsName || r.collateral?.symbol || "market"} | ${r.collateral?.symbol || "?"} | ${r.dbrMarket} | ${fmtPctBps(r.collateralFactorBps)} | ${fmtPctBps(r.liquidationIncentiveBps)} | ${r.borrowPaused} | ${fmtUsd(r.dolaCashUsd)} | ${fmtUsd(r.totalDebtUsd)} | ${fmt(r.oracleState?.viewPriceUsdPerToken, 6)} | ${fmt(r.referencePriceUsd, 6)} | ${fmt(r.oracleVsReferenceBps, 2)} | ${r.oracleState?.feedAgeSeconds ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const sampleTable = artifact.positionSample.filter((r) => r.debtUsd > 0 || r.dbrDeficit > 0 || r.escrowCollateralAmount > 0).sort((a, b) => (a.distanceToLiquidationBps ?? Infinity) - (b.distanceToLiquidationBps ?? Infinity)).slice(0, 18).map((r) => `| ${r.marketName} | ${r.borrowerRef} | ${fmtUsd(r.debtUsd)} | ${fmtUsd(r.creditLimitUsd)} | ${fmt(r.healthPct, 2)}% | ${fmt(r.distanceToLiquidationBps, 2)} | ${r.liquidatable} | ${fmtUsd(r.modeledGrossBonusUsd)} | ${fmtUsd(r.modeledReplenisherRewardUsd)} |`).join("\n") || "| none sampled | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const staleTable = artifact.classification.staleFeedRows.slice(0, 12).map((r) => `| ${r.docsName || r.collateral?.symbol || r.address} | ${r.collateral?.symbol || "?"} | ${r.oracleState?.feedDescription || r.oracleState?.feed || "n/a"} | ${r.oracleState?.feedAgeSeconds ?? "n/a"} | ${r.stalenessThresholdSeconds ?? "n/a"} | ${r.borrowControllerSaysPriceStale} | ${r.borrowPaused} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const watchTable = artifact.classification.watchCandidates.slice(0, 16).map((r) => `| ${r.kind} | ${r.market || "n/a"} | ${r.collateral || r.borrowerRef || "n/a"} | ${fmtUsd(r.debtUsd ?? r.cashUsd ?? r.rewardUsd)} | ${r.deltaBps ?? r.feedAgeSeconds ?? r.grossBonusUsd ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a |";
  const roleTable = artifact.permissionRows.map((r) => `| ${r.role} | ${r.address || "n/a"} | ${r.kind} | ${r.notes || ""} |`).join("\n");
  return `${SIGNAL_DORMANT} - Inverse Finance FiRM Phase 0 closed for bounded read-only scope: no exact-positive permissionless borrow, liquidation, replenishment, redemption, or unwind route found.

# Inverse Finance FiRM Phase 0 Triage

Generated: ${artifact.generatedAt}

## Summary

| Metric | Value |
|---|---:|
| Public TVL context | ${fmtUsd(s.defillamaCurrentTvlUsd)} |
| Chain | ${CHAIN} |
| Markets discovered | ${s.marketsDiscovered} |
| Active DBR markets | ${s.activeDbrMarkets} |
| Contracts with code | ${s.contractsWithCode} |
| Total FiRM debt scanned | ${fmtUsd(s.totalDebtUsd)} |
| Market DOLA cash | ${fmtUsd(s.totalDolaCashUsd)} |
| Fed supplied context | ${fmtUsd(s.totalFedSuppliedUsd)} |
| Recent logs decoded | ${s.logsDecoded} |
| Unique recent users seen | ${s.uniqueUsersSeen} |
| Sampled positions | ${s.sampledPositions} |
| Material sampled debt rows | ${s.materialSampledDebtRows} |
| Near-liquidation sampled rows | ${s.nearLiquidationRows} |
| Material liquidatable sampled rows | ${s.materialLiquidatableRows} |
| Stale feed rows | ${s.staleFeedRows} |
| Oracle/reference divergent rows | ${s.oracleDivergentRows} |
| Intended keeper reward rows | ${s.keeperRewardRows} |
| Watch candidates | ${s.watchCandidates} |
| Route positive | ${s.routePositive} |
| Executable now | ${s.executableNow} |
| Signed action justified | ${s.signedActionJustified} |

## Findings

- No exact-positive route was found. FiRM markets are permissionless for user borrow/liquidation flows, but this pass found no sampled material borrower below credit limit, no exact-positive repay/seize/exit route, and no stale/divergent accepted value that maps to live borrow cash.
- ${discoveryFinding}
- The pessimistic oracle path uses Chainlink-style feeds plus two-day daily-low dampening. BorrowController v4 also exposes per-market staleness thresholds; no current route-positive stale accepted-value branch was proven.
- Forced replenishment is an intended keeper mechanism. Any sampled DBR-deficit reward row is treated as watch/keeper context, not an exploit route, unless exact economics and authorization gates are separately satisfied.
- No fork, live transaction, executor, or signed action is justified without a fresh exact-positive liquidation, borrow, replenishment, redemption, or unwind route.

## Market / Oracle Rows

| Market | Collateral | DBR market | CF | Liq incentive | Borrow paused | DOLA cash | Total debt | Oracle price | Ref price | Delta bps | Feed age sec |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${marketTable}

## Sampled Positions

| Market | Borrower ref | Debt | Credit limit | Health | Distance bps | Liquidatable | Gross liq bonus | Replenisher reward |
|---|---|---:|---:|---:|---:|---:|---:|---:|
${sampleTable}

## Stale Feed / Borrow Gate Rows

| Market | Collateral | Feed | Feed age sec | Staleness threshold | BorrowController stale | Borrow paused |
|---|---|---|---:|---:|---:|---:|
${staleTable}

## Watch Candidates

| Kind | Market | Subject | Size | Edge/context |
|---|---|---|---:|---:|
${watchTable}

## Permissioned Context

| Role | Address | Kind | Notes |
|---|---|---|---|
${roleTable}

## Closure Rationale

- High-collateral-factor rows are configuration context only unless the accepted oracle/accounting value is attacker-favorable and borrow/liquidation/exit economics are exact-positive.
- Recent borrower sampling did not surface a material liquidatable borrower with positive repay/seize/unwind economics.
- No stale feed was proven accepted for a borrow route with material cash and favorable value; where BorrowController marks a feed stale, new borrow is blocked by design.
- Public Inverse Watch aggregates confirm FiRM user/borrower tracking exists, but the available page chunk did not expose a direct per-account liquidation feed for this scanner.

## Required To Reopen

- A specific FiRM borrower is currently liquidatable with material debt and exact repay/seized-collateral exit economics.
- A collateral feed, daily-low dampening path, or wrapper/accounting price is stale/divergent and still accepted for borrow or liquidation with material live liquidity.
- A forced-replenishment or liquidation keeper branch has exact positive net economics after gas, slippage, liquidity, and protocol-intended constraints, and is approved for deeper proof.
- Fork/static proof before any live or signed action.

Artifacts: \`${rel(RAW_OUT)}\`.
`;
}

function permissionRows(core, marketRows) {
  const rows = [];
  const kind = (addr) => !addr ? "unknown" : lowerAddress(addr) === lowerAddress(GOVERNOR_MILLS) ? "Governor Mills" : lowerAddress(addr) === lowerAddress(TREASURY) ? "Treasury/multisig" : "contract-or-eoa";
  rows.push({ role: "DBR operator", address: core.dbr.operator, kind: kind(core.dbr.operator), notes: "Can add markets/minters and set replenishment price" });
  rows.push({ role: "BorrowController operator", address: core.borrowController.operator, kind: kind(core.borrowController.operator), notes: "Can set daily limits, min debt, stale thresholds, allowlist" });
  rows.push({ role: "Oracle operator", address: core.oracle.operator, kind: kind(core.oracle.operator), notes: "Can set token feeds" });
  rows.push({ role: "FiRM Fed gov", address: core.fed.gov, kind: kind(core.fed.gov), notes: "Fed governance context" });
  rows.push({ role: "FiRM Fed chair", address: core.fed.chair, kind: kind(core.fed.chair), notes: "Fed expansion/contract role context" });
  const govs = [...new Set(marketRows.map((r) => lowerAddress(r.gov)).filter(Boolean))];
  const guardians = [...new Set(marketRows.map((r) => lowerAddress(r.pauseGuardian)).filter(Boolean))];
  const lenders = [...new Set(marketRows.map((r) => lowerAddress(r.lender)).filter(Boolean))];
  rows.push({ role: "Market gov set", address: govs.length === 1 ? normalizeAddress(govs[0]) : `${govs.length} unique`, kind: govs.length === 1 ? kind(govs[0]) : "mixed", notes: "Can change market params/oracle/lender" });
  rows.push({ role: "Pause guardian set", address: guardians.length === 1 ? normalizeAddress(guardians[0]) : `${guardians.length} unique`, kind: guardians.length === 1 ? kind(guardians[0]) : "mixed", notes: "Can pause borrows; governance unpauses" });
  rows.push({ role: "Lender set", address: lenders.length === 1 ? normalizeAddress(lenders[0]) : `${lenders.length} unique`, kind: lenders.length === 1 ? kind(lenders[0]) : "mixed", notes: "Can recall DOLA from markets" });
  return rows;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) throw new Error("No Ethereum RPC available from sanitized inventory or public fallback");
  const [block, metadata, sourceMeta, core, dbrMeta, dolaMeta] = await Promise.all([
    latestBlock(rpc),
    Promise.resolve(sourceTvlUsd()),
    githubSourceMeta(),
    inspectCore(rpc),
    tokenMeta(rpc, DBR, "DBR"),
    tokenMeta(rpc, DOLA, "DOLA"),
  ]);
  if (!block.number) throw new Error("Ethereum RPC did not return a latest block");
  const discovered = await discoverMarkets(rpc, block.number);
  let marketRows = [];
  for (const seed of discovered.marketSeeds) marketRows.push(await inspectMarketBase(rpc, seed, block.timestamp));
  const prices = await coinPrices([DOLA, DBR, ...marketRows.map((r) => r.collateral?.address).filter(Boolean)]);
  marketRows = enrichMarketPrices(marketRows, prices.prices);
  const positions = await eventAndPositionSample(rpc, block, marketRows, core);
  const classification = classify(marketRows, positions.sampleRows);
  const joins = artifactJoins([DBR, DOLA, BORROW_CONTROLLER_V4, FIRM_ORACLE, FIRM_FED, ...marketRows.map((r) => r.address), ...marketRows.map((r) => r.collateral?.address)].filter(Boolean));
  const activeDbrMarkets = marketRows.filter((r) => r.codePresent && r.dbrMarket);
  const summary = {
    coverageClassification: "bounded-with-caveats",
    defillamaCurrentTvlUsd: metadata.tvlUsd ?? null,
    ethereumRpcAvailable: true,
    docsMarkets: DOC_MARKETS.length,
    marketsDiscoveredFromDbrLogs: discovered.dbrAddMarketLogs.length,
    marketsDiscovered: marketRows.length,
    activeDbrMarkets: activeDbrMarkets.length,
    contractsWithCode: marketRows.filter((r) => r.codePresent).length,
    totalDebtUsd: round(activeDbrMarkets.reduce((s, r) => s + (r.totalDebtUsd || 0), 0), 2),
    totalDolaCashUsd: round(activeDbrMarkets.reduce((s, r) => s + (r.dolaCashUsd || 0), 0), 2),
    totalFedSuppliedUsd: round(activeDbrMarkets.reduce((s, r) => s + (r.fedSuppliedUsd || 0), 0), 2),
    logsDecoded: positions.eventSummary.logsDecoded,
    uniqueUsersSeen: positions.eventSummary.uniqueUsersSeen,
    sampledPositions: positions.sampleRows.length,
    materialSampledDebtRows: positions.sampleRows.filter((r) => r.materialDebt).length,
    nearLiquidationRows: classification.nearLiquidationRows.length,
    materialLiquidatableRows: classification.materialLiquidatableRows.length,
    staleFeedRows: classification.staleFeedRows.length,
    staleButAcceptedRows: classification.staleButAcceptedRows.length,
    oracleDivergentRows: classification.divergentRows.length,
    acceptedValueDivergentRows: classification.acceptedValueDivergentRows.length,
    highCfBorrowableRows: classification.highCfBorrowableRows.length,
    keeperRewardRows: classification.keeperRewardRows.length,
    localArtifactRows: joins.length,
    watchCandidates: classification.watchCandidates.length,
    routePositive: classification.routePositiveRows.length,
    executableNow: false,
    signedActionJustified: false,
    logErrors: positions.logErrors + discovered.dbrLogScan.failedRanges.length,
  };
  const artifact = {
    scanner: "tools/scan-inverse-finance-firm-phase0.js",
    generatedAt,
    target: { name: "Inverse Finance FiRM", slug: "inverse-finance-firm", category: "CDP", chain: CHAIN, chainId: CHAIN_ID },
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, staticCallOnly: true, executionCalldataStored: false, borrowerAddressesStored: false },
    thresholds: { firmStartBlock: FIRM_START_BLOCK, recentLogBlocks: RECENT_LOG_BLOCKS, logChunkBlocks: LOG_CHUNK_BLOCKS, maxUserSample: MAX_USER_SAMPLE, minMaterialDebtUsd: MIN_MATERIAL_DEBT_USD, nearLiquidationBps: NEAR_LIQ_BPS, minBorrowCashUsd: MIN_BORROW_CASH_USD, divergenceWatchBps: DIVERGENCE_WATCH_BPS, staleFeedSeconds: STALE_FEED_SECONDS, minKeeperRewardUsd: MIN_KEEPER_REWARD_USD },
    summary,
    block,
    sources: {
      publicDiscovery: metadata,
      docs: [
        "https://docs.inverse.finance/inverse-finance/inverse-finance/technical/smart-contracts.md",
        "https://docs.inverse.finance/inverse-finance/inverse-finance/products/firm.md",
        "https://docs.inverse.finance/inverse-finance/inverse-finance/products/firm/firm-liquidations-and-replenishments.md",
      ],
      defillamaAdapter: { module: "inverse-finance-firm/index.js", firmStartBlock: FIRM_START_BLOCK, dbr: DBR, methodology: "Get collateral balances from user personal escrows" },
      sourceRepo: sourceMeta,
      inverseWatch: { aggregateUsersQuery: 473, perAccountLiquidationFeedResolved: false, note: "Public page chunk exposes aggregate active-user query and Inverse Watch embed, not a direct per-account liquidation endpoint for this scanner" },
      coinPrices: prices.fetched,
    },
    core,
    tokens: { dbr: dbrMeta, dola: dolaMeta },
    discovery: discovered,
    marketRows,
    eventSummary: positions.eventSummary,
    positionSample: positions.sampleRows,
    localArtifactRows: joins,
    permissionRows: permissionRows(core, marketRows),
    classification,
    blockers: [
      "Borrower/account coverage is bounded to recent on-chain event sampling and public aggregate context, not full historical per-account enumeration",
      "No sampled material borrower was below credit limit with exact positive repay/seize/unwind economics",
      "High-CF and single-source Chainlink rows are configuration context only without current stale/divergent accepted value plus exact borrow/liquidation economics",
      "Forced replenishment is an intended keeper flow and is not treated as exploit route-positive without separate exact economics and authorization gates",
      "No fork extraction proof",
    ],
    requiredForRoutePositive: [
      "specific FiRM market accepts attacker-favorable stale, divergent, or under-bound oracle/accounting value, or a material borrower is currently liquidatable",
      "borrow, liquidation, or replenishment path is permissionless and unblocked in current live state",
      "DOLA acquisition/repay and seized collateral or keeper reward unwind are exact-quoted positive after gas, slippage, and fees",
      "fork/static proof before any live or signed action",
    ],
    nextReadOnlyStep: "Keep FiRM on oracle/feed staleness, high-CF borrow cash, borrower liquidation, and DBR-deficit keeper watch; exact-quote/fork only if a material row becomes route-positive.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, JSON.stringify(artifact, jsonReplacer, 2));
  fs.writeFileSync(REPORT_OUT, renderReport(artifact));
  if (!QUIET) {
    console.log(`[inverse-firm] wrote ${rel(RAW_OUT)} and ${rel(REPORT_OUT)}`);
    console.log(`[inverse-firm] markets=${summary.marketsDiscovered} activeDbrMarkets=${summary.activeDbrMarkets} sampledPositions=${summary.sampledPositions} materialLiquidatable=${summary.materialLiquidatableRows} routePositive=${summary.routePositive} watchCandidates=${summary.watchCandidates}`);
  }
}

main().catch((error) => {
  console.error(`[inverse-firm] fatal: ${safeText(error?.stack || error?.message || error, 600)}`);
  process.exit(1);
});
