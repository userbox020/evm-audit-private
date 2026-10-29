#!/usr/bin/env node
// scan-felix-cdp-phase0.js - read-only Phase 0 for Felix feUSD CDP on HyperEVM.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, or execution calldata.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { getOrigin, resolveRpc, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "felix-cdp-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "felix-cdp-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const HYPER_CONSUMERS = path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-linked-token-consumers.json");
const HYPER_INVARIANTS = path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-linked-token-invariants.json");

const QUIET = process.argv.includes("--quiet");
const SIGNAL_VULNERABLE = "\uD83D\uDFE1 VULNERABLE";
const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";
const HYPEREVM_CHAIN_ID = 999;
const CALL_FROM = "0x000000000000000000000000000000000000dEaD";
const WHYPE = "0x5555555555555555555555555555555555555555";
const FEUSD = "0x02c6a2fa58cc01a18b8d9e00ea48d65e4df26c70";
const USDC = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";
const ETH_GAS_COMPENSATION_RAW = ethers.parseUnits("0.0375", 18);
const COLL_GAS_COMPENSATION_CAP_RAW = ethers.parseUnits("2", 18);
const COLL_GAS_COMPENSATION_DIVISOR = 200n;
const MIN_FEUSD_LEFT_IN_SP_RAW = ethers.parseUnits("1", 18);
const MIN_MATERIAL_DEBT_USD = Number(process.env.FELIX_MIN_MATERIAL_DEBT_USD || "1000");
const NEAR_MCR_BPS = Number(process.env.FELIX_NEAR_MCR_BPS || "500");
const MIN_DEX_LIQUIDITY_USD = Number(process.env.FELIX_MIN_DEX_LIQUIDITY_USD || "10000");
const MIN_ROUTE_NET_USD = Number(process.env.FELIX_MIN_ROUTE_NET_USD || "50");
const MAX_TROVES_PER_BRANCH = Number(process.env.FELIX_MAX_TROVES_PER_BRANCH || "1000");
const REQUEST_TIMEOUT_MS = Number(process.env.FELIX_REQUEST_TIMEOUT_MS || "30000");

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const BRANCHES = [
  {
    key: "whype",
    name: "WHYPE",
    docsStatus: "live",
    collateralDocs: "WHYPE",
    collateral: WHYPE,
    zapper: "0x999876BC29Bc2251539C900a1bCfC6C934991F49",
    deprecatedZapper: "0xd389c600B302C05e619a25112B27eA07C62A6c8c",
    activePool: "0x39ebba742b6917d49d4a9ac7cf5c70f84d34cc9e",
    addressRegistry: "0x7201fb5c3ba06f10a858819f62221ae2f473815d",
    borrowerOperations: "0x5b271dc20ba7beb8eee276eb4f1644b6a217f0a3",
    collateralSurplusPool: "0x9182e36bd7cceb71812c766c4464208ad9c122ca",
    defaultPool: "0xa1e95e74d07fec324a82cd2ef19ebcb33907c605",
    gasPool: "0x7560059081ede2ff6c6b980fd1ee9a53df4e9935",
    priceFeed: "0x12a1868b89789900e413a6241ca9032dd1873a51",
    sortedTroves: "0xd1caa4218808eb94d36e1df7247f7406f43f2ef6",
    stabilityPool: "0x576c9c501473e01ae23748de28415a74425efd6b",
    troveManager: "0x3100f4e7bda2ed2452d9a57eb30260ab071bbe62",
    troveNFT: "0x5ad1512e7006fdbd0f3ebb8aa35c5e9234a03aa7",
  },
  {
    key: "ubtc",
    name: "UBTC",
    docsStatus: "live",
    collateralDocs: "UBTC / feUBTC wrapper",
    sourceToken: "0x9fdbda0a5e284c32744d2f17ee5c74b284993463",
    collateral: "0xefbd9cfe88235f0e648aefb52c8e8dc152a9ad6f",
    activePool: "0x8d99575ebbbda038a626ca769561c16fdd7a5939",
    addressRegistry: "0xfc4e20bd9f0e4f8782bea92a7bd8002367882407",
    borrowerOperations: "0x36b7bd65276eda7cdc5f730da5cdb7ee7736672e",
    collateralSurplusPool: "0xe7aba857f8e2c95462e69b93c7ea78ac19aafe38",
    defaultPool: "0x50743a84c68a9d14d93364ed31afa4012183df1c",
    gasPool: "0x8b71c92edf02dff693042e4e808d0568ccf0a137",
    priceFeed: "0xf59f338424062dd1d44a9b4dd2721128a45358ab",
    sortedTroves: "0x642d979341eaac9c10623f5a58283aa72f6e2fa9",
    stabilityPool: "0xabf0369530205ae56dd4c49629474c65d1168924",
    troveManager: "0xbbe5f227275f24b64bd290a91f55723a00214885",
    troveNFT: "0xad8a43ac8da98990efa4d5ec7b91135965d5846b",
  },
  {
    key: "khype",
    name: "kHYPE",
    docsStatus: "live",
    collateralDocs: "kHYPE",
    collateral: "0xfd739d4e423301ce9385c1fb8850539d657c296d",
    activePool: "0xbfd0b103a49faf426f36864d19f5d871bf411a5a",
    addressRegistry: "0x382d2fe4eed8e35a5855321e62fd45ad60ca589f",
    borrowerOperations: "0x3a2a181ab6e4ffb77c87ee201041a0806dadc397",
    collateralSurplusPool: "0x246aceb6b121fe2cb7ec76fcf8e667fb8096f7b0",
    defaultPool: "0xee6d1804feb4817d6db77f6f31b86673d7fc195f",
    gasPool: "0xea5d5a859be7c96aa0481ed35170af8e277a9f8e",
    priceFeed: "0x0a04e685f12e47b22b03c3763add63f1dd73265c",
    sortedTroves: "0x6bc81472c10ec526c14c8b0e8faa282f9368f86f",
    stabilityPool: "0x56a346e0730cb209a93964c41cd36098030779ab",
    troveManager: "0x7c07bb77b1cf9a5b40d92f805c10d90c90957e4a",
    troveNFT: "0x9d08780deec2270b8296f520b3fb28346abf6036",
  },
  {
    key: "wsthype",
    name: "wstHYPE",
    docsStatus: "docs-say-coming-soon-but-live-code-scanned",
    collateralDocs: "wstHYPE",
    collateral: "0x94e8396e0869c9f2200760af0621afd240e1cf38",
    activePool: "0x7abca40474d6b5f000f801d7fe7e0df4c89425ff",
    addressRegistry: "0x6a1ce00901c3deb2683a6c63fcd158cc3adc2740",
    borrowerOperations: "0x389c03c1f77981d158fbe286e7cafac2bb2fe83e",
    collateralSurplusPool: "0x339d10ba20f3575ec9b44275f978dd38386f0f32",
    defaultPool: "0x535a9ff6bfd0d9f1b64fe03f185b0af8ddeb7bd1",
    gasPool: "0x5db69b925c35b85905255f0b9443bfefda97fce0",
    priceFeed: "0x067e69ad6bdb8ee95cac31b34626f48eb6f169a2",
    sortedTroves: "0xa82c325553baee63bd97604e10a7cc40482008a1",
    stabilityPool: "0xadfba621a75beced7dd1727b2067047b7eeedc8b",
    troveManager: "0x58446c58caa8a6f6cc8be343f812ebf0b997c001",
    troveNFT: "0x7d29515fc4eaef2a01c46218b4cb8d2d8ae437e4",
  },
];

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const ACTIVE_POOL = new ethers.Interface([
  "function getCollBalance() view returns (uint256)",
  "function getBoldDebt() view returns (uint256)",
  "function getfeUSDDebt() view returns (uint256)",
  "function shutdownTime() view returns (uint256)",
  "function aggRecordedDebt() view returns (uint256)",
  "function calcPendingAggInterest() view returns (uint256)",
]);
const STABILITY_POOL = new ethers.Interface([
  "function getTotalBoldDeposits() view returns (uint256)",
  "function getTotalfeUSDDeposits() view returns (uint256)",
  "function getTotalFelixDeposits() view returns (uint256)",
  "function getCollBalance() view returns (uint256)",
  "function currentScale() view returns (uint256)",
  "function P() view returns (uint256)",
]);
const REGISTRY = new ethers.Interface([
  "function MCR() view returns (uint256)",
  "function CCR() view returns (uint256)",
  "function SCR() view returns (uint256)",
  "function BCR() view returns (uint256)",
  "function LIQUIDATION_PENALTY_SP() view returns (uint256)",
  "function LIQUIDATION_PENALTY_REDISTRIBUTION() view returns (uint256)",
  "function collToken() view returns (address)",
  "function troveManager() view returns (address)",
  "function stabilityPool() view returns (address)",
  "function priceFeed() view returns (address)",
  "function activePool() view returns (address)",
  "function collateralRegistry() view returns (address)",
  "function boldToken() view returns (address)",
]);
const PRICE_FEED = new ethers.Interface([
  "function lastGoodPrice() view returns (uint256)",
  "function fetchPrice() returns (uint256,bool)",
  "function fetchRedemptionPrice() returns (uint256,bool)",
]);
const TROVE = new ethers.Interface([
  "function getTroveIdsCount() view returns (uint256)",
  "function getTroveFromTroveIdsArray(uint256) view returns (uint256)",
  "function getCurrentICR(uint256,uint256) view returns (uint256)",
  "function getTroveStatus(uint256) view returns (uint8)",
  "function shutdownTime() view returns (uint256)",
  "function batchLiquidateTroves(uint256[] troveArray)",
  "function getLatestTroveData(uint256) view returns (tuple(uint256 entireDebt,uint256 entireColl,uint256 redistBoldDebtGain,uint256 redistCollGain,uint256 accruedInterest,uint256 recordedDebt,uint256 annualInterestRate,uint256 weightedRecordedDebt,uint256 accruedBatchManagementFee,uint256 lastInterestRateAdjTime))",
]);
const PAUSABLE = new ethers.Interface(["function paused() view returns (bool)"]);
const OWNABLE = new ethers.Interface(["function owner() view returns (address)"]);
const POOL = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
]);
const UNI_V3_QUOTER = new ethers.Interface([
  "function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const HYPERSWAP_MIXED_QUOTER = new ethers.Interface([
  "function quoteExactInputSingleV3(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const TICK_SPACING_QUOTER = new ethers.Interface([
  "function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const RAMSES_OLD_QUOTER = new ethers.Interface([
  "function quoteExactInputSingle(address tokenIn,address tokenOut,int24 tickSpacing,uint256 amountIn,uint160 sqrtPriceLimitX96) returns (uint256 amountOut)",
]);
const ALGEBRA_QUOTER = new ethers.Interface([
  "function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint256 amountInUsed,uint160 sqrtPriceAfter,uint32 initializedTicksCrossed,uint256 gasEstimate,uint16 fee)",
]);
const ALGEBRA_OLD_QUOTER = new ethers.Interface([
  "function quoteExactInputSingle(address tokenIn,address tokenOut,uint256 amountIn,uint160 sqrtPriceLimitX96) returns (uint256 amountOut,uint16 fee)",
]);

const QUOTER_BY_FACTORY = new Map([
  ["0xff7b3e8c00e57ea31477c32a5b52a58eea47b072", { label: "prjx", quoter: "0x239F11a7A3E08f2B8110D4CA9F6B95d4c8865258", kind: "uni-v3-fee-struct" }],
  ["0xb1c0fa0b789320044a6f623cfe5ebda9562602e3", { label: "hyperswap", quoter: "0xEc8F3D08Dd762e935fb914bD2b2E788e5E423516", kind: "hyperswap-mixed-v3" }],
  ["0x07e60782535752be279929e2dffdd136db2e6b45", { label: "ramses", quoter: "0x403Bf94fe505cA0F0b1563C350B57dCeC8303ECd", fallbackQuoter: "0x5126e63dD031301ACCDf1a5137EA5CAEB1125D52", kind: "tick-spacing-struct" }],
  ["0x32b9da73215255d50d84feb51540b75acc1324c2", { label: "hybra", quoter: "0x8CD6acfF822eE9E3240501b3CeDa64364791e4E2", kind: "tick-spacing-struct" }],
  ["0xf77bd082c627aa54591cf2f2eaa811fd1ab3b1f3", { label: "nest", quoter: "0xBea20609A4772311c5b81F814Cd4f9ECaEF5DFAd", fallbackQuoter: "0x89C3aB4F5342498e9EdAC5C43C07e9Bd9AE4DB78", kind: "algebra-struct" }],
]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const text = readText(file).replace(/^\uFEFF/, ""); return text ? JSON.parse(text) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function sanitizeError(error, max = 220) { return String(error?.shortMessage || error?.message || error || "error").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/0x[a-fA-F0-9]{120,}/g, "[redacted-calldata]").slice(0, max); }
function safeText(value, max = 160) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function round(value, decimals = 4) { const n = Number(value); if (!Number.isFinite(n)) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function pct(value) { return value === null || value === undefined ? null : round(Number(value) * 100, 2); }
function bpsDiff(a, b) { const x = Number(a); const y = Number(b); return Number.isFinite(x) && Number.isFinite(y) && y !== 0 ? round(((x - y) / y) * 10_000, 2) : null; }
function fmt(value, decimals = 2) { const n = Number(value); return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: decimals }) : "n/a"; }
function fmtUsd(value) { const n = Number(value); return Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "n/a"; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "")); } catch (_) { return null; } }
function lowerAddress(value) { const a = normalizeAddress(value); return a ? a.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function slotAddress(raw) { const addr = raw && raw !== "0x" && raw.length >= 66 ? normalizeAddress(`0x${raw.slice(26)}`) : null; return addr && addr !== ZERO ? addr : null; }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function rawToNumber(raw, decimals = 18) { try { return Number(ethers.formatUnits(toBig(raw), Number(decimals))); } catch (_) { return null; } }
function amountToRaw(value, decimals = 18) { try { return ethers.parseUnits(Number(value).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: Math.min(Number(decimals) || 18, 18) }), Number(decimals)); } catch (_) { return null; } }
function shaRef(value) { return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16); }
function isUsdLike(symbol) { return /^(usdc|usdt|usdt0|usde|usdhl|feusd|dai|usdx|usdl|usdb)$/i.test(String(symbol || "")) || /^usd/i.test(String(symbol || "")); }
function firstValue(result) { try { return Array.from(result || [])[0] ?? null; } catch (_) { return null; } }

async function fetchJson(url, timeoutMs = REQUEST_TIMEOUT_MS, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, headers: { "user-agent": "evm-audit-felix-cdp-phase0/1.0", ...(options.headers || {}) } });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { ok: res.ok, status: res.status, json, error: res.ok ? null : safeText(text || `HTTP ${res.status}`, 140) };
  } catch (error) {
    return { ok: false, status: null, json: null, error: sanitizeError(error, 120) };
  } finally { clearTimeout(timer); }
}

async function jsonRpc(url, method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { "content-type": "application/json" };
  const origin = getOrigin(url);
  if (origin) headers.origin = origin;
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: controller.signal });
    const json = await res.json().catch(() => null);
    if (json?.error) return { ok: false, result: null, error: sanitizeError(json.error?.message || JSON.stringify(json.error)) };
    return { ok: true, result: json?.result ?? null, error: null };
  } catch (error) {
    return { ok: false, result: null, error: sanitizeError(error) };
  } finally { clearTimeout(timer); }
}

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = REQUEST_TIMEOUT_MS) {
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
  if (!addr) return "0x";
  return await rpcCall(rpc, "eth_getCode", [addr, "latest"], 12_000).catch(() => "0x") || "0x";
}

async function getSlotAddress(rpc, address, slot) {
  const addr = normalizeAddress(address);
  if (!addr) return null;
  const raw = await rpcCall(rpc, "eth_getStorageAt", [addr, slot, "latest"], 12_000).catch(() => null);
  return slotAddress(raw);
}

async function latestBlock(rpc) {
  const num = await rpcCall(rpc, "eth_blockNumber", [], 10_000).catch(() => null);
  const block = num ? await rpcCall(rpc, "eth_getBlockByNumber", [num, false], 10_000).catch(() => null) : null;
  return { number: num ? Number(BigInt(num)) : null, timestamp: block?.timestamp ? Number(BigInt(block.timestamp)) : null };
}

async function tokenMeta(rpc, address, fallbackSymbol = null) {
  const addr = normalizeAddress(address);
  if (!addr) return null;
  const [symbol, name, decimals, totalSupply, code] = await Promise.all([
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
    getCode(rpc, addr),
  ]);
  const dec = decimals?.[0] === undefined ? null : Number(decimals[0]);
  const supplyRaw = totalSupply?.[0]?.toString?.() || null;
  return {
    address: addr,
    symbol: safeText(symbol?.[0], 48) || fallbackSymbol,
    name: safeText(name?.[0], 96),
    decimals: dec,
    totalSupplyRaw: supplyRaw,
    totalSupply: dec === null || supplyRaw === null ? null : round(rawToNumber(supplyRaw, dec), 6),
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
  };
}

function pairTokenSide(pair, address) {
  const addr = lowerAddress(address);
  if (!addr) return null;
  if (lowerAddress(pair?.baseToken?.address) === addr) return "base";
  if (lowerAddress(pair?.quoteToken?.address) === addr) return "quote";
  return null;
}

function tokenPriceUsdFromPair(pair, address) {
  const side = pairTokenSide(pair, address);
  const priceUsd = Number(pair?.priceUsd || 0);
  const priceNative = Number(pair?.priceNative || 0);
  if (side === "base" && priceUsd > 0) return priceUsd;
  if (side === "quote" && priceUsd > 0 && priceNative > 0) return priceUsd / priceNative;
  return null;
}

async function dexPairs(address) {
  const addr = normalizeAddress(address);
  if (!addr) return [];
  const res = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, REQUEST_TIMEOUT_MS);
  return Array.isArray(res.json?.pairs) ? res.json.pairs.filter((p) => String(p?.chainId || "").toLowerCase() === "hyperevm") : [];
}

function bestPairForToken(pairs, address) {
  return pairs.map((pair) => ({ pair, side: pairTokenSide(pair, address), liquidityUsd: Number(pair?.liquidity?.usd || 0), priceUsd: tokenPriceUsdFromPair(pair, address) }))
    .filter((row) => row.side && row.priceUsd > 0 && row.liquidityUsd >= MIN_DEX_LIQUIDITY_USD)
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0] || null;
}

async function exactDexContext(rpc, pair, targetAddress) {
  const pairAddress = normalizeAddress(pair?.pairAddress);
  const target = normalizeAddress(targetAddress);
  if (!pairAddress || !target) return { ok: false, error: "missing pair or target" };
  const code = await getCode(rpc, pairAddress);
  if (!code || code === "0x") return { ok: false, pairAddress, error: "pair has no code" };
  const [token0Raw, token1Raw, factoryRaw, feeRaw, tickSpacingRaw] = await Promise.all([
    safeCall(rpc, pairAddress, POOL, "token0"),
    safeCall(rpc, pairAddress, POOL, "token1"),
    safeCall(rpc, pairAddress, POOL, "factory"),
    safeCall(rpc, pairAddress, POOL, "fee"),
    safeCall(rpc, pairAddress, POOL, "tickSpacing"),
  ]);
  const token0 = normalizeAddress(firstValue(token0Raw));
  const token1 = normalizeAddress(firstValue(token1Raw));
  const factory = normalizeAddress(firstValue(factoryRaw));
  if (!token0 || !token1) return { ok: false, pairAddress, error: "pool token0/token1 unavailable" };
  const targetKey = lowerAddress(target);
  const counterparty = lowerAddress(token0) === targetKey ? token1 : lowerAddress(token1) === targetKey ? token0 : null;
  if (!counterparty) return { ok: false, pairAddress, token0, token1, error: "pair does not contain target" };
  const [targetToken, counterpartyToken] = await Promise.all([
    tokenMeta(rpc, target, pairTokenSide(pair, target) === "base" ? pair?.baseToken?.symbol : pair?.quoteToken?.symbol),
    tokenMeta(rpc, counterparty, pairTokenSide(pair, counterparty) === "base" ? pair?.baseToken?.symbol : pair?.quoteToken?.symbol),
  ]);
  const factoryKey = lowerAddress(factory);
  const quoterConfig = factoryKey ? QUOTER_BY_FACTORY.get(factoryKey) : null;
  const counterpartyPriceUsd = tokenPriceUsdFromPair(pair, counterparty) || (isUsdLike(counterpartyToken?.symbol) ? 1 : null);
  return {
    ok: Boolean(quoterConfig && targetToken && counterpartyToken && counterpartyPriceUsd),
    pairAddress,
    dexId: pair?.dexId || null,
    token0,
    token1,
    factory,
    fee: firstValue(feeRaw) !== null ? Number(firstValue(feeRaw)) : null,
    tickSpacing: firstValue(tickSpacingRaw) !== null ? Number(firstValue(tickSpacingRaw)) : null,
    targetToken,
    counterpartyToken,
    targetPriceUsd: tokenPriceUsdFromPair(pair, target),
    counterpartyPriceUsd,
    counterpartyUsdLike: isUsdLike(counterpartyToken?.symbol),
    quoterConfigured: Boolean(quoterConfig),
    quoterLabel: quoterConfig?.label || null,
    liquidityUsd: Number(pair?.liquidity?.usd || 0),
    error: quoterConfig ? null : "no configured quoter for pool factory",
  };
}

async function quoteViaConfiguredQuoter(rpc, ctx, input, output, amountInRaw) {
  const factoryKey = lowerAddress(ctx?.factory);
  const config = factoryKey ? QUOTER_BY_FACTORY.get(factoryKey) : null;
  if (!config) return { ok: false, error: "no configured quoter" };
  const primaryQuoter = normalizeAddress(config.quoter);
  const fee = Number(ctx?.fee || 0);
  const tickSpacing = Number(ctx?.tickSpacing || 0);
  const sqrtPriceLimitX96 = 0n;
  const attempts = [];
  if (config.kind === "uni-v3-fee-struct") attempts.push({ target: primaryQuoter, iface: UNI_V3_QUOTER, fn: "quoteExactInputSingle", args: [[input, output, amountInRaw, fee, sqrtPriceLimitX96]], method: `${config.label}.quoteExactInputSingle(fee=${fee})` });
  else if (config.kind === "hyperswap-mixed-v3") attempts.push({ target: primaryQuoter, iface: HYPERSWAP_MIXED_QUOTER, fn: "quoteExactInputSingleV3", args: [[input, output, amountInRaw, fee, sqrtPriceLimitX96]], method: `${config.label}.quoteExactInputSingleV3(fee=${fee})` });
  else if (config.kind === "tick-spacing-struct") {
    attempts.push({ target: primaryQuoter, iface: TICK_SPACING_QUOTER, fn: "quoteExactInputSingle", args: [[input, output, amountInRaw, tickSpacing, sqrtPriceLimitX96]], method: `${config.label}.quoteExactInputSingle(tickSpacing=${tickSpacing})` });
    if (config.fallbackQuoter) attempts.push({ target: normalizeAddress(config.fallbackQuoter), iface: RAMSES_OLD_QUOTER, fn: "quoteExactInputSingle", args: [input, output, tickSpacing, amountInRaw, sqrtPriceLimitX96], method: `${config.label}.oldQuoteExactInputSingle(tickSpacing=${tickSpacing})` });
  } else if (config.kind === "algebra-struct") {
    attempts.push({ target: primaryQuoter, iface: ALGEBRA_QUOTER, fn: "quoteExactInputSingle", args: [[input, output, amountInRaw, sqrtPriceLimitX96]], method: `${config.label}.quoteExactInputSingle` });
    if (config.fallbackQuoter) attempts.push({ target: normalizeAddress(config.fallbackQuoter), iface: ALGEBRA_OLD_QUOTER, fn: "quoteExactInputSingle", args: [input, output, amountInRaw, sqrtPriceLimitX96], method: `${config.label}.oldQuoteExactInputSingle` });
  }
  const errors = [];
  for (const attempt of attempts) {
    if (!attempt.target) continue;
    const code = await getCode(rpc, attempt.target);
    if (!code || code === "0x") { errors.push(`${attempt.method}: quoter has no code`); continue; }
    const result = await safeCall(rpc, attempt.target, attempt.iface, attempt.fn, attempt.args, REQUEST_TIMEOUT_MS);
    const amountOutRaw = firstValue(result);
    if (amountOutRaw !== null) return { ok: true, amountOutRaw, method: attempt.method, quoterLabel: config.label };
    errors.push(`${attempt.method}: quote failed`);
  }
  return { ok: false, error: errors.join("; ").slice(0, 320) || "quote failed" };
}

async function exactSellToCounterparty(rpc, ctx, baseAmount) {
  if (!ctx?.ok) return { ok: false, error: ctx?.error || "no exact context" };
  const amountInRaw = amountToRaw(baseAmount, ctx.targetToken.decimals);
  if (!amountInRaw || amountInRaw <= 0n) return { ok: false, error: "invalid amount" };
  const quote = await quoteViaConfiguredQuoter(rpc, ctx, ctx.targetToken.address, ctx.counterpartyToken.address, amountInRaw);
  if (!quote.ok) return quote;
  const amountOut = rawToNumber(quote.amountOutRaw, ctx.counterpartyToken.decimals);
  const usdOut = amountOut !== null && ctx.counterpartyPriceUsd ? amountOut * ctx.counterpartyPriceUsd : null;
  return {
    ok: usdOut !== null,
    amountInRaw: amountInRaw.toString(),
    amountOutRaw: quote.amountOutRaw.toString(),
    amountOut,
    usdOut,
    method: quote.method,
    quoterLabel: quote.quoterLabel,
    counterparty: { symbol: ctx.counterpartyToken.symbol, address: ctx.counterpartyToken.address, decimals: ctx.counterpartyToken.decimals, usdLike: ctx.counterpartyUsdLike, priceUsd: round(ctx.counterpartyPriceUsd, 10) },
  };
}

async function exactSellToUsd(rpc, ctx, baseAmount, unwindCtx = null) {
  const first = await exactSellToCounterparty(rpc, ctx, baseAmount);
  if (!first.ok) return first;
  if (first.counterparty?.usdLike) return { ...first, exactDexQuote: true, multiHopExact: false };
  if (!unwindCtx?.ok || lowerAddress(first.counterparty?.address) !== lowerAddress(unwindCtx.targetToken?.address)) return { ...first, ok: false, error: "counterparty not USD-like and no unwind context" };
  const unwind = await exactSellToCounterparty(rpc, unwindCtx, first.amountOut);
  if (!unwind.ok || !unwind.counterparty?.usdLike) return { ...first, ok: false, error: unwind.error || "unwind quote failed" };
  return {
    ok: true,
    exactDexQuote: true,
    multiHopExact: true,
    usdOut: unwind.usdOut,
    firstHop: { amountOut: first.amountOut, amountOutRaw: first.amountOutRaw, method: first.method, quoterLabel: first.quoterLabel, counterparty: first.counterparty },
    unwind: { amountOut: unwind.amountOut, amountOutRaw: unwind.amountOutRaw, method: unwind.method, quoterLabel: unwind.quoterLabel, counterparty: unwind.counterparty },
  };
}

async function bestUsdUnwindContext(rpc, tokenAddress) {
  const pairs = await dexPairs(tokenAddress);
  const best = bestPairForToken(pairs, tokenAddress);
  if (!best?.pair) return null;
  return exactDexContext(rpc, best.pair, tokenAddress);
}

function protocolMetadata() {
  const discovery = readJson(PUBLIC_TARGETS, {});
  const rows = [...(discovery.phase0Queue || []), ...(discovery.protocolCandidates || []), ...(discovery.consumerJoinFirst || [])];
  const row = rows.find((x) => x?.slug === "felix-cdp" || x?.name === "Felix CDP");
  return row ? { name: row.name, slug: row.slug, category: row.category, chains: row.chains || [], customSupportedChains: row.customSupportedChains || [], tvlUsd: row.tvlUsd, change1dPct: row.change1dPct, change7dPct: row.change7dPct, routePriority: row.routePriority || null, source: "public-audit-target-discovery" } : { name: "Felix CDP", slug: "felix-cdp", category: "CDP", chains: ["Hyperliquid L1"], customSupportedChains: ["Hyperliquid L1"], tvlUsd: null };
}

async function defillamaMetadata() {
  const fetched = await fetchJson("https://api.llama.fi/protocol/felix-cdp", REQUEST_TIMEOUT_MS);
  const j = fetched.json || {};
  return {
    ok: fetched.ok,
    status: fetched.status,
    error: fetched.error,
    name: j.name || null,
    category: j.category || null,
    description: safeText(j.description, 240),
    audits: j.audits || null,
    auditLinksCount: Array.isArray(j.audit_links) ? j.audit_links.length : 0,
    chains: j.chains || [],
    currentChainTvls: j.currentChainTvls || null,
  };
}

function consumerContextRows() {
  const consumers = readJson(HYPER_CONSUMERS, {});
  const invariants = readJson(HYPER_INVARIANTS, {});
  const addresses = new Set([FEUSD, ...BRANCHES.flatMap((b) => [b.collateral, b.sourceToken]).filter(Boolean)].map((a) => lowerAddress(a)));
  const rows = [];
  for (const row of consumers.rows || []) {
    const text = JSON.stringify(row).toLowerCase();
    if (![...addresses].some((addr) => addr && text.includes(addr)) && !/felix-cdp|feusd/i.test(text)) continue;
    rows.push({
      symbol: row?.token?.name || row?.token?.symbol || row?.symbol || null,
      token: row?.token?.evmContract || row?.token?.address || null,
      watchCandidate: Boolean(row?.watchCandidate),
      researchPositive: Boolean(row?.researchPositive),
      routePositive: Boolean(row?.routePositive),
      joinCount: row?.metrics?.joinCount ?? (row?.joins || []).length,
      maxYieldTvlUsd: row?.metrics?.maxYieldTvlUsd ?? null,
      maxDexLiquidityUsd: row?.metrics?.maxDexLiquidityUsd ?? null,
      maxBorrowCashUsd: row?.metrics?.maxBorrowCashUsd ?? null,
      topJoins: (row?.joins || []).slice(0, 8).map((j) => ({ protocol: j.protocol, consumerType: j.consumerType, symbol: j.symbol, tvlUsd: j.tvlUsd ?? null, liquidityUsd: j.liquidityUsd ?? null, cashUsd: j.cashUsd ?? null, routePositive: Boolean(j.routePositive), blockers: (j.blockers || []).slice(0, 2) })),
      blockers: (row?.blockers || []).slice(0, 4),
    });
  }
  const invariantRows = [];
  for (const row of invariants.rows || []) {
    const addr = lowerAddress(row?.token?.evmContract || row?.evm?.address || row?.address);
    if (!addresses.has(addr)) continue;
    invariantRows.push({ symbol: row?.token?.name || row?.evm?.symbol || null, token: row?.token?.evmContract || row?.evm?.address || null, watchCandidate: Boolean(row?.watchCandidate || row?.invariant?.watchCandidate), flags: row?.flags || row?.invariant?.flags || [] });
  }
  return { consumerRows: rows, invariantRows };
}

async function inspectContract(rpc, name, address, branch = null) {
  const addr = normalizeAddress(address);
  if (!addr) return null;
  const [code, impl, admin, beacon, paused, owner] = await Promise.all([
    getCode(rpc, addr),
    getSlotAddress(rpc, addr, EIP1967_IMPL),
    getSlotAddress(rpc, addr, EIP1967_ADMIN),
    getSlotAddress(rpc, addr, EIP1967_BEACON),
    safeCall(rpc, addr, PAUSABLE, "paused"),
    safeCall(rpc, addr, OWNABLE, "owner"),
  ]);
  return { branch, name, address: addr, codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0, implementation: impl, proxyAdmin: admin, beacon, paused: paused?.[0] ?? null, owner: normalizeAddress(owner?.[0]) || null };
}

async function inspectContracts(rpc) {
  const named = new Map([["feUSD", FEUSD], ["CollateralRegistry", "0x9de1e57049c475736289cb006212f3e1dce4711b"], ["HintHelpers", "0xa32e89c658f7fdcc0bdb2717f253bacd99f864d4"], ["WHYPE", WHYPE], ["USDC", USDC]]);
  for (const b of BRANCHES) {
    for (const [key, value] of Object.entries(b)) {
      if (typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value)) named.set(`${b.name}.${key}`, value);
    }
  }
  const rows = [];
  for (const [name, address] of named.entries()) rows.push(await inspectContract(rpc, name, address, name.includes(".") ? name.split(".")[0] : null));
  return rows.filter(Boolean);
}

async function branchParams(rpc, branch) {
  const reg = branch.addressRegistry;
  const [mcr, ccr, scr, bcr, penaltySp, penaltyRedist, collToken, troveManager, stabilityPool, priceFeed, activePool, boldToken] = await Promise.all([
    safeCall(rpc, reg, REGISTRY, "MCR"),
    safeCall(rpc, reg, REGISTRY, "CCR"),
    safeCall(rpc, reg, REGISTRY, "SCR"),
    safeCall(rpc, reg, REGISTRY, "BCR"),
    safeCall(rpc, reg, REGISTRY, "LIQUIDATION_PENALTY_SP"),
    safeCall(rpc, reg, REGISTRY, "LIQUIDATION_PENALTY_REDISTRIBUTION"),
    safeCall(rpc, reg, REGISTRY, "collToken"),
    safeCall(rpc, reg, REGISTRY, "troveManager"),
    safeCall(rpc, reg, REGISTRY, "stabilityPool"),
    safeCall(rpc, reg, REGISTRY, "priceFeed"),
    safeCall(rpc, reg, REGISTRY, "activePool"),
    safeCall(rpc, reg, REGISTRY, "boldToken"),
  ]);
  return {
    MCR: mcr?.[0]?.toString?.() || null,
    CCR: ccr?.[0]?.toString?.() || null,
    SCR: scr?.[0]?.toString?.() || null,
    BCR: bcr?.[0]?.toString?.() || null,
    liquidationPenaltySP: penaltySp?.[0]?.toString?.() || null,
    liquidationPenaltyRedistribution: penaltyRedist?.[0]?.toString?.() || null,
    MCRPct: pct(rawToNumber(mcr?.[0], 18)),
    CCRPct: pct(rawToNumber(ccr?.[0], 18)),
    SCRPct: pct(rawToNumber(scr?.[0], 18)),
    liquidationPenaltySPPct: pct(rawToNumber(penaltySp?.[0], 18)),
    liquidationPenaltyRedistributionPct: pct(rawToNumber(penaltyRedist?.[0], 18)),
    liveAddressesMatchDocs: {
      collToken: lowerAddress(collToken?.[0]) === lowerAddress(branch.collateral),
      troveManager: lowerAddress(troveManager?.[0]) === lowerAddress(branch.troveManager),
      stabilityPool: lowerAddress(stabilityPool?.[0]) === lowerAddress(branch.stabilityPool),
      priceFeed: lowerAddress(priceFeed?.[0]) === lowerAddress(branch.priceFeed),
      activePool: lowerAddress(activePool?.[0]) === lowerAddress(branch.activePool),
      boldToken: lowerAddress(boldToken?.[0]) === lowerAddress(FEUSD),
    },
  };
}

function simulateDirectComp(collRaw, debtRaw, spAvailableRaw) {
  const debtToOffset = debtRaw < spAvailableRaw ? debtRaw : spAvailableRaw;
  if (debtToOffset <= 0n || debtRaw <= 0n) return { debtToOffset: 0n, collGasCompRaw: 0n, collSPPortionRaw: 0n };
  const collSPPortionRaw = collRaw * debtToOffset / debtRaw;
  const gasRaw = collSPPortionRaw / COLL_GAS_COMPENSATION_DIVISOR;
  return { debtToOffset, collSPPortionRaw, collGasCompRaw: gasRaw < COLL_GAS_COMPENSATION_CAP_RAW ? gasRaw : COLL_GAS_COMPENSATION_CAP_RAW };
}

async function modelDirectLiquidationCompensation(rpc, branch, collMeta, _params, _priceRaw, spDepositsRaw, liquidatableRows, whypeUsdCtx) {
  const sorted = liquidatableRows.slice().sort((a, b) => (a.icrPct || Infinity) - (b.icrPct || Infinity));
  let remainingSp = toBig(spDepositsRaw) > MIN_FEUSD_LEFT_IN_SP_RAW ? toBig(spDepositsRaw) - MIN_FEUSD_LEFT_IN_SP_RAW : 0n;
  let collGasCompRaw = 0n;
  let debtOffsetRaw = 0n;
  let liquidatedCount = 0;
  const selectedIds = [];
  for (const row of sorted) {
    if (!row.liquidatable) continue;
    const debt = toBig(row.entireDebtRaw);
    const coll = toBig(row.entireCollRaw);
    const sim = simulateDirectComp(coll, debt, remainingSp);
    if (debt > 0n) {
      selectedIds.push(row.troveRef);
      liquidatedCount += 1;
    }
    remainingSp -= sim.debtToOffset;
    debtOffsetRaw += sim.debtToOffset;
    collGasCompRaw += sim.collGasCompRaw;
  }
  const compensationWhypeRaw = ETH_GAS_COMPENSATION_RAW * BigInt(liquidatedCount);
  const idsForCall = [];
  for (const row of sorted) {
    // Refs only are persisted. The live trove IDs are deliberately not available here.
    if (row._liveId !== undefined) idsForCall.push(row._liveId);
  }
  const exact = await exactCompensationQuote(rpc, branch.collateral, collMeta, collGasCompRaw, compensationWhypeRaw, whypeUsdCtx);
  const staticCall = await simulateBatchLiquidationCall(rpc, branch.troveManager, sorted.map((r) => r._liveId).filter((x) => x !== undefined));
  const gas = await estimateBatchLiquidationGas(rpc, branch.troveManager, sorted.map((r) => r._liveId).filter((x) => x !== undefined), whypeUsdCtx);
  const compensationUsd = (exact?.collateralQuote?.usdOut || 0) + (exact?.whypeQuote?.usdOut || 0);
  const gasUsd = gas?.gasUsd ?? null;
  const netUsd = gasUsd === null ? null : compensationUsd - gasUsd;
  const routePositive = Boolean(staticCall.success && exact.collateralQuote?.ok && exact.whypeQuote?.ok && netUsd !== null && netUsd >= MIN_ROUTE_NET_USD);
  return {
    routeType: "permissionless-batchLiquidateTroves-caller-gas-compensation",
    liquidationBranch: branch.name,
    liquidatableRows: liquidatableRows.length,
    selectedRows: sorted.length,
    selectedRefs: selectedIds.slice(0, 20),
    troveIdsStored: false,
    executionCalldataStored: false,
    debtOffsetRaw: debtOffsetRaw.toString(),
    debtOffsetUsd: round(rawToNumber(debtOffsetRaw, 18), 4),
    collGasCompRaw: collGasCompRaw.toString(),
    collGasComp: round(rawToNumber(collGasCompRaw, collMeta?.decimals ?? 18), 8),
    whypeGasCompRaw: compensationWhypeRaw.toString(),
    whypeGasComp: round(rawToNumber(compensationWhypeRaw, 18), 8),
    exactCompensationQuote: exact,
    staticCall,
    gas,
    compensationUsd: round(compensationUsd, 4),
    netUsd: round(netUsd, 4),
    routePositive,
    executableNow: false,
    signedActionJustified: false,
    blockers: [
      routePositive ? null : "read-only direct compensation net is not route-positive",
      staticCall.success ? null : "batchLiquidateTroves static call did not succeed",
      exact.collateralQuote?.ok ? null : "collateral exact DEX unwind quote unavailable",
      exact.whypeQuote?.ok ? null : "WHYPE exact DEX unwind quote unavailable",
      "fork extraction proof is required before any signed action",
      "operator authorization is required before any live transaction",
    ].filter(Boolean),
  };
}

async function exactCompensationQuote(rpc, collateral, collMeta, collGasCompRaw, whypeRaw, whypeUsdCtx) {
  const collAmount = rawToNumber(collGasCompRaw, collMeta?.decimals ?? 18) || 0;
  const pairs = await dexPairs(collateral);
  const best = bestPairForToken(pairs, collateral);
  const collateralCtx = best?.pair ? await exactDexContext(rpc, best.pair, collateral) : null;
  const collateralQuote = collAmount > 0 && collateralCtx?.ok ? await exactSellToUsd(rpc, collateralCtx, collAmount, whypeUsdCtx) : { ok: false, error: best?.pair ? "exact context unavailable" : "no DEX pair" };
  const whypeAmount = rawToNumber(whypeRaw, 18) || 0;
  const whypeQuote = whypeAmount > 0 && whypeUsdCtx?.ok ? await exactSellToUsd(rpc, whypeUsdCtx, whypeAmount, null) : { ok: false, error: "WHYPE unwind context unavailable" };
  return {
    collateralPair: best?.pair ? { dexId: best.pair.dexId, pairAddress: best.pair.pairAddress, liquidityUsd: round(best.liquidityUsd, 2), priceUsd: round(best.priceUsd, 8), quoterLabel: collateralCtx?.quoterLabel || null, counterparty: collateralCtx?.counterpartyToken ? { symbol: collateralCtx.counterpartyToken.symbol, address: collateralCtx.counterpartyToken.address, usdLike: collateralCtx.counterpartyUsdLike } : null } : null,
    collateralQuote: collateralQuote.ok ? { ok: true, usdOut: round(collateralQuote.usdOut, 4), exactDexQuote: true, multiHopExact: Boolean(collateralQuote.multiHopExact), firstHop: collateralQuote.firstHop ? { method: collateralQuote.firstHop.method, quoterLabel: collateralQuote.firstHop.quoterLabel, amountOut: round(collateralQuote.firstHop.amountOut, 8), counterparty: collateralQuote.firstHop.counterparty } : null, unwind: collateralQuote.unwind ? { method: collateralQuote.unwind.method, quoterLabel: collateralQuote.unwind.quoterLabel, amountOut: round(collateralQuote.unwind.amountOut, 8), counterparty: collateralQuote.unwind.counterparty } : null } : { ok: false, error: collateralQuote.error || "quote failed" },
    whypePair: whypeUsdCtx?.ok ? { pairAddress: whypeUsdCtx.pairAddress, dexId: whypeUsdCtx.dexId, liquidityUsd: round(whypeUsdCtx.liquidityUsd, 2), priceUsd: round(whypeUsdCtx.targetPriceUsd, 8), quoterLabel: whypeUsdCtx.quoterLabel, counterparty: whypeUsdCtx.counterpartyToken ? { symbol: whypeUsdCtx.counterpartyToken.symbol, address: whypeUsdCtx.counterpartyToken.address, usdLike: whypeUsdCtx.counterpartyUsdLike } : null } : null,
    whypeQuote: whypeQuote.ok ? { ok: true, usdOut: round(whypeQuote.usdOut, 4), exactDexQuote: true, method: whypeQuote.method, quoterLabel: whypeQuote.quoterLabel, amountOut: round(whypeQuote.amountOut, 8), counterparty: whypeQuote.counterparty } : { ok: false, error: whypeQuote.error || "quote failed" },
  };
}

async function simulateBatchLiquidationCall(rpc, troveManager, ids) {
  if (!ids.length) return { attempted: false, success: false, error: "no live ids retained in memory" };
  const data = TROVE.encodeFunctionData("batchLiquidateTroves", [ids]);
  const res = await jsonRpc(rpc, "eth_call", [{ from: CALL_FROM, to: troveManager, data }, "latest"], REQUEST_TIMEOUT_MS);
  return { attempted: true, success: Boolean(res.ok), error: res.ok ? null : res.error || "static call failed", calldataStored: false };
}

async function estimateBatchLiquidationGas(rpc, troveManager, ids, whypeUsdCtx) {
  if (!ids.length) return { attempted: false, error: "no live ids retained in memory" };
  const data = TROVE.encodeFunctionData("batchLiquidateTroves", [ids]);
  const [estimate, gasPriceRaw] = await Promise.all([
    jsonRpc(rpc, "eth_estimateGas", [{ from: CALL_FROM, to: troveManager, data, gasPrice: "0x0" }], REQUEST_TIMEOUT_MS),
    rpcCall(rpc, "eth_gasPrice", [], 10_000).catch(() => null),
  ]);
  const gasEstimate = estimate.ok && estimate.result ? BigInt(estimate.result) : null;
  const gasPrice = gasPriceRaw ? BigInt(gasPriceRaw) : null;
  const hypePrice = whypeUsdCtx?.targetPriceUsd || whypeUsdCtx?.counterpartyPriceUsd || null;
  const gasHype = gasEstimate !== null && gasPrice !== null ? Number(gasEstimate * gasPrice) / 1e18 : null;
  return { attempted: true, success: Boolean(gasEstimate), gasEstimate: gasEstimate?.toString?.() || null, gasPriceWei: gasPrice?.toString?.() || null, gasHype: round(gasHype, 8), gasUsd: gasHype !== null && hypePrice ? round(gasHype * hypePrice, 6) : null, error: estimate.ok ? null : estimate.error, calldataStored: false };
}

async function inspectBranchBase(rpc, branch, whypeUsdCtx) {
  const [collMeta, sourceMeta, params, priceLast, priceFetch, redemptionPrice, activeCollRes, activeDebtFelix, activeDebtBold, activeShutdown, recordedDebt, pendingInterest, spDepositsFelix, spDepositsBold, spDepositsLegacy, spCollRes, spScale, tmShutdown, troveCountRaw] = await Promise.all([
    tokenMeta(rpc, branch.collateral, branch.name),
    branch.sourceToken ? tokenMeta(rpc, branch.sourceToken, branch.name) : Promise.resolve(null),
    branchParams(rpc, branch),
    safeCall(rpc, branch.priceFeed, PRICE_FEED, "lastGoodPrice"),
    safeCall(rpc, branch.priceFeed, PRICE_FEED, "fetchPrice"),
    safeCall(rpc, branch.priceFeed, PRICE_FEED, "fetchRedemptionPrice"),
    safeCall(rpc, branch.activePool, ACTIVE_POOL, "getCollBalance"),
    safeCall(rpc, branch.activePool, ACTIVE_POOL, "getfeUSDDebt"),
    safeCall(rpc, branch.activePool, ACTIVE_POOL, "getBoldDebt"),
    safeCall(rpc, branch.activePool, ACTIVE_POOL, "shutdownTime"),
    safeCall(rpc, branch.activePool, ACTIVE_POOL, "aggRecordedDebt"),
    safeCall(rpc, branch.activePool, ACTIVE_POOL, "calcPendingAggInterest"),
    safeCall(rpc, branch.stabilityPool, STABILITY_POOL, "getTotalfeUSDDeposits"),
    safeCall(rpc, branch.stabilityPool, STABILITY_POOL, "getTotalBoldDeposits"),
    safeCall(rpc, branch.stabilityPool, STABILITY_POOL, "getTotalFelixDeposits"),
    safeCall(rpc, branch.stabilityPool, STABILITY_POOL, "getCollBalance"),
    safeCall(rpc, branch.stabilityPool, STABILITY_POOL, "currentScale"),
    safeCall(rpc, branch.troveManager, TROVE, "shutdownTime"),
    safeCall(rpc, branch.troveManager, TROVE, "getTroveIdsCount"),
  ]);
  const priceRaw = priceFetch?.[0] ?? priceLast?.[0] ?? null;
  const price = rawToNumber(priceRaw, 18);
  const lastGoodPrice = rawToNumber(priceLast?.[0], 18);
  const redemptionPriceUsd = rawToNumber(redemptionPrice?.[0], 18);
  const collDecimals = collMeta?.decimals ?? 18;
  const activeDebtRaw = activeDebtFelix?.[0] ?? activeDebtBold?.[0] ?? null;
  const spDepositsRaw = spDepositsFelix?.[0] ?? spDepositsBold?.[0] ?? spDepositsLegacy?.[0] ?? 0n;
  const troveCount = Number(troveCountRaw?.[0] || 0n);
  const scanCount = Math.min(troveCount, MAX_TROVES_PER_BRANCH);
  const troveRows = [];
  const liveIdByRef = new Map();
  const mcrRaw = toBig(params.MCR);
  const nearLimitRaw = mcrRaw + (mcrRaw * BigInt(Math.max(0, NEAR_MCR_BPS)) / 10_000n);
  for (let i = 0; i < scanCount; i++) {
    const id = (await safeCall(rpc, branch.troveManager, TROVE, "getTroveFromTroveIdsArray", [BigInt(i)]))?.[0];
    if (id === undefined) continue;
    const ref = shaRef(id);
    liveIdByRef.set(ref, id);
    const [statusRaw, latest, icrRaw] = await Promise.all([
      safeCall(rpc, branch.troveManager, TROVE, "getTroveStatus", [id]),
      safeCall(rpc, branch.troveManager, TROVE, "getLatestTroveData", [id]),
      priceRaw ? safeCall(rpc, branch.troveManager, TROVE, "getCurrentICR", [id, priceRaw]) : Promise.resolve(null),
    ]);
    const status = Number(statusRaw?.[0] ?? -1);
    const data = latest?.[0];
    const entireDebtRaw = toBig(data?.entireDebt ?? data?.[0]);
    const entireCollRaw = toBig(data?.entireColl ?? data?.[1]);
    const icr = icrRaw?.[0] !== undefined ? toBig(icrRaw[0]) : null;
    const debt = rawToNumber(entireDebtRaw, 18);
    const coll = rawToNumber(entireCollRaw, collDecimals);
    const active = status === 1;
    const liquidatable = Boolean(active && icr !== null && mcrRaw > 0n && icr < mcrRaw);
    const near = Boolean(active && icr !== null && mcrRaw > 0n && icr >= mcrRaw && icr <= nearLimitRaw);
    troveRows.push({ branch: branch.name, troveRef: ref, arrayIndex: i, status, active, liquidatable, nearMcr: near, materialDebt: active && debt !== null && debt >= MIN_MATERIAL_DEBT_USD, entireDebtRaw: entireDebtRaw.toString(), entireDebtUsd: round(debt, 4), entireCollRaw: entireCollRaw.toString(), entireColl: round(coll, 8), icrRaw: icr?.toString?.() || null, icrPct: icr === null ? null : pct(rawToNumber(icr, 18)), annualInterestRatePct: pct(rawToNumber(data?.annualInterestRate ?? data?.[6], 18)) });
  }
  const activeRows = troveRows.filter((r) => r.active);
  const liquidatableRows = activeRows.filter((r) => r.liquidatable);
  const materialLiquidatableRows = liquidatableRows.filter((r) => r.materialDebt);
  const nearRows = activeRows.filter((r) => r.nearMcr);
  const activeDebtUsd = rawToNumber(activeDebtRaw, 18);
  const activeColl = rawToNumber(activeCollRes?.[0], collDecimals);
  const activeCollUsd = activeColl !== null && price !== null ? activeColl * price : null;
  const stabilityDeposits = rawToNumber(spDepositsRaw, 18);
  const stabilityColl = rawToNumber(spCollRes?.[0], collDecimals);
  for (const row of liquidatableRows) row._liveId = liveIdByRef.get(row.troveRef);
  let directRoute = null;
  if (liquidatableRows.length) directRoute = await modelDirectLiquidationCompensation(rpc, branch, collMeta, params, priceRaw, spDepositsRaw, liquidatableRows, whypeUsdCtx);
  const persistedLiquidatableRows = liquidatableRows.slice().sort((a, b) => (a.icrPct || Infinity) - (b.icrPct || Infinity)).slice(0, 12).map((r) => ({ troveRef: r.troveRef, status: r.status, icrPct: r.icrPct, entireDebtUsd: r.entireDebtUsd, entireColl: r.entireColl, annualInterestRatePct: r.annualInterestRatePct }));
  return {
    key: branch.key,
    branch: branch.name,
    docsStatus: branch.docsStatus,
    collateralDocs: branch.collateralDocs,
    collateral: collMeta,
    sourceToken: sourceMeta,
    params,
    price: { executionPriceSource: priceFetch?.[0] !== undefined ? "fetchPrice" : "lastGoodPrice", lastGoodPriceRaw: priceLast?.[0]?.toString?.() || null, lastGoodPriceUsd: round(lastGoodPrice, 8), fetchPriceRaw: priceFetch?.[0]?.toString?.() || null, fetchPriceFlag: priceFetch?.[1] ?? null, priceUsd: round(price, 8), fetchVsLastGoodBps: bpsDiff(price, lastGoodPrice), fetchRedemptionPriceRaw: redemptionPrice?.[0]?.toString?.() || null, redemptionPriceUsd: round(redemptionPriceUsd, 8) },
    activePool: { collBalanceRaw: activeCollRes?.[0]?.toString?.() || null, collBalance: round(activeColl, 8), collBalanceUsd: round(activeCollUsd, 2), feUSDDebtRaw: activeDebtRaw?.toString?.() || null, feUSDDebtUsd: round(activeDebtUsd, 2), aggRecordedDebtRaw: recordedDebt?.[0]?.toString?.() || null, pendingInterestRaw: pendingInterest?.[0]?.toString?.() || null, shutdownTime: activeShutdown?.[0] !== undefined ? Number(activeShutdown[0]) : null },
    stabilityPool: { totalDepositsRaw: spDepositsRaw?.toString?.() || null, totalDepositsUsd: round(stabilityDeposits, 2), collBalanceRaw: spCollRes?.[0]?.toString?.() || null, collBalance: round(stabilityColl, 8), currentScale: spScale?.[0]?.toString?.() || null },
    troves: { totalIds: troveCount, scannedIds: scanCount, activeRows: activeRows.length, liquidatableRows: liquidatableRows.length, materialLiquidatableRows: materialLiquidatableRows.length, nearMcrRows: nearRows.length, minActiveIcrPct: activeRows.length ? round(Math.min(...activeRows.map((r) => r.icrPct ?? Infinity)), 2) : null, totalLiquidatableDebtUsd: round(liquidatableRows.reduce((s, r) => s + (r.entireDebtUsd || 0), 0), 2), totalLiquidatableColl: round(liquidatableRows.reduce((s, r) => s + (r.entireColl || 0), 0), 8), topLiquidatableRows: persistedLiquidatableRows, topNearRows: nearRows.slice().sort((a, b) => (a.icrPct || Infinity) - (b.icrPct || Infinity)).slice(0, 8).map((r) => ({ troveRef: r.troveRef, icrPct: r.icrPct, entireDebtUsd: r.entireDebtUsd, entireColl: r.entireColl })), troveManagerShutdownTime: tmShutdown?.[0] !== undefined ? Number(tmShutdown[0]) : null, troveIdsStored: false },
    directLiquidationRoute: directRoute,
  };
}

async function main() {
  const generatedAt = new Date().toISOString();
  const rpc = await resolveRpc(HYPEREVM_CHAIN_ID);
  if (!rpc) throw new Error("No HyperEVM RPC available from sanitized resolver");
  const [block, metadata, llama, feusdMeta, contractRows, whypeUsdCtx] = await Promise.all([
    latestBlock(rpc),
    Promise.resolve(protocolMetadata()),
    defillamaMetadata(),
    tokenMeta(rpc, FEUSD, "feUSD"),
    inspectContracts(rpc),
    bestUsdUnwindContext(rpc, WHYPE),
  ]);
  const branchRows = [];
  for (const branch of BRANCHES) branchRows.push(await inspectBranchBase(rpc, branch, whypeUsdCtx));
  const joins = consumerContextRows();
  const summary = {
    defillamaCurrentTvlUsd: metadata.tvlUsd ?? llama.currentChainTvls?.["Hyperliquid L1"] ?? null,
    chainsInspected: 1,
    branchRows: branchRows.length,
    contractRows: contractRows.length,
    contractsWithCode: contractRows.filter((r) => r.codePresent).length,
    proxyLikeRows: contractRows.filter((r) => r.implementation || r.proxyAdmin || r.beacon).length,
    totalTroveIds: branchRows.reduce((s, r) => s + (r.troves.totalIds || 0), 0),
    scannedTroveIds: branchRows.reduce((s, r) => s + (r.troves.scannedIds || 0), 0),
    activeTroveRows: branchRows.reduce((s, r) => s + (r.troves.activeRows || 0), 0),
    liquidatableRows: branchRows.reduce((s, r) => s + (r.troves.liquidatableRows || 0), 0),
    materialLiquidatableRows: branchRows.reduce((s, r) => s + (r.troves.materialLiquidatableRows || 0), 0),
    nearMcrRows: branchRows.reduce((s, r) => s + (r.troves.nearMcrRows || 0), 0),
    totalFeUSDDebtUsd: round(branchRows.reduce((s, r) => s + (r.activePool.feUSDDebtUsd || 0), 0), 2),
    totalCollateralUsdAtFelixOracle: round(branchRows.reduce((s, r) => s + (r.activePool.collBalanceUsd || 0), 0), 2),
    totalStabilityPoolDepositsUsd: round(branchRows.reduce((s, r) => s + (r.stabilityPool.totalDepositsUsd || 0), 0), 2),
    lastGoodFetchDivergenceRows: branchRows.filter((r) => Math.abs(r.price.fetchVsLastGoodBps || 0) >= 1000).length,
    directRoutePositiveRows: branchRows.filter((r) => r.directLiquidationRoute?.routePositive).length,
    bestDirectGasCompNetUsd: round(Math.max(0, ...branchRows.map((r) => r.directLiquidationRoute?.netUsd || 0)), 4),
    consumerContextRows: joins.consumerRows.length,
    invariantContextRows: joins.invariantRows.length,
    watchCandidates: branchRows.filter((r) => r.troves.liquidatableRows > 0 || r.directLiquidationRoute?.routePositive).length,
    routePositive: branchRows.some((r) => r.directLiquidationRoute?.routePositive) ? 1 : 0,
    executableNow: 0,
    signedActionJustified: false,
    coverageClassification: "bounded-with-caveats",
  };
  const artifact = {
    generatedAt,
    scanner: "tools/scan-felix-cdp-phase0.js",
    scope: "Felix feUSD CDP Phase 0 on Hyperliquid L1/HyperEVM using public docs addresses, upstream Liquity V2 interfaces, and read-only live state",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, staticCallOnly: true, executionCalldataStored: false, troveIdsStored: false, routePositive: Boolean(summary.routePositive), executableNow: false, signedActionJustified: false },
    chain: { name: "Hyperliquid L1 / HyperEVM", chainId: HYPEREVM_CHAIN_ID, blockNumber: block.number, blockTimestamp: block.timestamp },
    source: { defillama: metadata, defillamaLive: llama, docs: { source: "Felix GitBook developers/market-1-feusd-cdp.md", sourcePersisted: false }, upstreamReference: { repo: "liquity/bold", localTarget: "targets/liquity-bold", lastObservedCommit: "3fcaf602 chore: update version number to 1.11.0", purpose: "ABI/interface and liquidation math reference only" }, felixSpecificSourceAvailability: "not found in public metadata; live-bytecode/docs bounded" },
    thresholds: { minMaterialDebtUsd: MIN_MATERIAL_DEBT_USD, nearMcrBps: NEAR_MCR_BPS, minDexLiquidityUsd: MIN_DEX_LIQUIDITY_USD, minRouteNetUsd: MIN_ROUTE_NET_USD, maxTrovesPerBranch: MAX_TROVES_PER_BRANCH },
    summary,
    tokens: { feUSD: feusdMeta, WHYPE },
    contractRows,
    branchRows,
    consumerContext: joins,
    blockers: [
      "No fork extraction proof has been run in this pass",
      "No live transaction is authorized or justified without fork proof plus explicit operator authorization",
      "Felix-specific source was not found in public metadata; scanner uses public docs addresses and upstream Liquity V2 interfaces",
      "Trove IDs and encoded liquidation calldata are intentionally not persisted",
    ],
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, JSON.stringify(artifact, jsonReplacer, 2));
  fs.writeFileSync(REPORT_OUT, renderReport(artifact));
  if (!QUIET) {
    console.log(`Felix CDP Phase 0: branches=${summary.branchRows} activeTroves=${summary.activeTroveRows} liquidatable=${summary.liquidatableRows} materialLiquidatable=${summary.materialLiquidatableRows} routePositive=${summary.routePositive} bestNetUsd=${summary.bestDirectGasCompNetUsd}`);
    console.log(`Wrote ${path.relative(WORKSPACE, RAW_OUT)} and ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

function renderReport(a) {
  const signal = a.summary.routePositive ? `${SIGNAL_VULNERABLE} - Felix CDP kHYPE liquidation caller-compensation route is read-only positive; fork proof pending` : `${SIGNAL_DORMANT} - Felix CDP has no read-only route-positive CDP path in bounded scope`;
  const lines = [];
  lines.push(signal);
  lines.push("");
  lines.push("# Felix CDP Phase 0 Triage");
  lines.push("");
  lines.push("## Summary");
  lines.push(`- Generated: \`${a.generatedAt}\` at HyperEVM block \`${a.chain.blockNumber ?? "n/a"}\`.`);
  lines.push(`- Scope: Felix feUSD CDP branches from public docs, live read-only state, and upstream Liquity V2 liquidation math reference.`);
  lines.push(`- TVL context: ${fmtUsd(a.summary.defillamaCurrentTvlUsd)}; active feUSD debt scanned: ${fmtUsd(a.summary.totalFeUSDDebtUsd)}; collateral at Felix oracle prices: ${fmtUsd(a.summary.totalCollateralUsdAtFelixOracle)}.`);
  lines.push(`- Troves: ${a.summary.scannedTroveIds}/${a.summary.totalTroveIds} IDs scanned, ${a.summary.activeTroveRows} active, ${a.summary.liquidatableRows} liquidatable, ${a.summary.materialLiquidatableRows} material liquidatable.`);
  lines.push(`- Oracle execution-path check: ${a.summary.lastGoodFetchDivergenceRows} branch(es) had >=1000bps lastGood-vs-fetch divergence; liquidation eligibility was evaluated with \`fetchPrice()\`, matching the liquidation call path.`);
  lines.push(`- Route state: \`routePositive=${a.summary.routePositive}\`, \`executableNow=0\`, \`signedActionJustified=false\`, best read-only direct net ${fmtUsd(a.summary.bestDirectGasCompNetUsd)}.`);
  lines.push("");
  lines.push("## Branch State");
  lines.push("| Branch | Exec Price | LastGood Divergence | MCR | Active Debt | SP feUSD | Active Troves | Liquidatable | Min ICR |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of a.branchRows) {
    lines.push(`| ${r.branch} | $${fmt(r.price.priceUsd, 4)} | ${fmt(r.price.fetchVsLastGoodBps, 2)}bps | ${fmt(r.params.MCRPct, 2)}% | ${fmtUsd(r.activePool.feUSDDebtUsd)} | ${fmtUsd(r.stabilityPool.totalDepositsUsd)} | ${r.troves.activeRows} | ${r.troves.liquidatableRows} | ${fmt(r.troves.minActiveIcrPct, 2)}% |`);
  }
  lines.push("");
  const routeRows = a.branchRows.filter((r) => r.directLiquidationRoute);
  if (routeRows.length) {
    lines.push("## Read-Only Route");
    for (const r of routeRows) {
      const d = r.directLiquidationRoute;
      lines.push(`- ${r.branch}: ${d.liquidatableRows} liquidatable rows, offset debt ${fmtUsd(d.debtOffsetUsd)}, caller compensation ${fmt(d.collGasComp, 6)} ${r.branch} plus ${fmt(d.whypeGasComp, 6)} WHYPE.`);
      lines.push(`- ${r.branch}: exact compensation quote ${fmtUsd(d.compensationUsd)}, estimated gas ${fmtUsd(d.gas?.gasUsd)}, read-only net ${fmtUsd(d.netUsd)}, staticCall=${d.staticCall?.success ? "success" : "failed"}.`);
      lines.push(`- ${r.branch}: trove IDs and encoded calldata were not persisted; fork proof and explicit authorization are required before any signed action.`);
    }
    lines.push("");
  }
  lines.push("## Consumer Context");
  lines.push(`- Local Hyperliquid consumer graph rows matched: ${a.summary.consumerContextRows}; invariant context rows matched: ${a.summary.invariantContextRows}.`);
  for (const row of a.consumerContext.consumerRows.slice(0, 6)) {
    lines.push(`- ${row.symbol || "token"}: joins=${row.joinCount}, maxYield=${fmtUsd(row.maxYieldTvlUsd)}, maxDex=${fmtUsd(row.maxDexLiquidityUsd)}, maxBorrowCash=${fmtUsd(row.maxBorrowCashUsd)}, routePositive=${row.routePositive}.`);
  }
  lines.push("");
  lines.push("## Coverage And Blockers");
  lines.push("- Coverage classification: `bounded-with-caveats`.");
  lines.push("- Felix-specific source was not found in public metadata; live checks use published docs addresses plus upstream Liquity V2 interfaces at local commit `3fcaf602`.");
  lines.push("- All four documented branches were scanned; docs label wstHYPE as coming soon, but deployed code and active troves were present and included.");
  lines.push("- No fork extraction proof was run; no transaction was signed or sent; `signedActionJustified=false`.");
  lines.push("- Next gate: keep Felix on execution-path oracle/liquidation watch; only run a fork proof if a future `fetchPrice()` pass creates material liquidatable rows with exact positive compensation economics.");
  return `${lines.join("\n")}\n`;
}

main().catch((error) => {
  console.error(`Felix CDP Phase 0 failed: ${sanitizeError(error)}`);
  process.exit(1);
});
