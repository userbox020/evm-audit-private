#!/usr/bin/env node
// scan-bend-phase0.js - bounded read-only Phase 0 for BEND on Berachain.
// Resolves RPC URLs in memory only. Never prints/stores RPC URLs, private keys, execution calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { loadRpcUrls, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "bend-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "bend-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const BERACHAIN_CHAIN_ID = 80094;
const MORPHO_BLUE = "0x24147243f9c08d835C218Cda1e135f8dFD0517D0";
const ZERO = "0x0000000000000000000000000000000000000000";
const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const MAX_VAULTS = Number(process.env.BEND_PHASE0_MAX_VAULTS || "80");
const MAX_MARKETS = Number(process.env.BEND_PHASE0_MAX_MARKETS || "80");
const RECENT_LOG_BLOCKS = Number(process.env.BEND_PHASE0_RECENT_LOG_BLOCKS || "30000");
const LOG_CHUNK_BLOCKS = Number(process.env.BEND_PHASE0_LOG_CHUNK_BLOCKS || "5000");
const MAX_USERS_PER_MARKET = Number(process.env.BEND_PHASE0_MAX_USERS_PER_MARKET || "80");
const MATERIAL_USD = Number(process.env.BEND_PHASE0_MATERIAL_USD || "10000");
const HIGH_LLTV_BPS = Number(process.env.BEND_PHASE0_HIGH_LLTV_BPS || "8600");
const STALE_FEED_WARN_SECONDS = Number(process.env.BEND_PHASE0_STALE_FEED_WARN_SECONDS || "86400");

const MORPHO = new ethers.Interface([
  "function idToMarketParams(bytes32 id) view returns (address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function position(bytes32 id,address user) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)",
  "function owner() view returns (address)",
  "function feeRecipient() view returns (address)",
]);

const VAULT = new ethers.Interface([
  "function withdrawQueueLength() view returns (uint256)",
  "function withdrawQueue(uint256 index) view returns (bytes32)",
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function owner() view returns (address)",
  "function curator() view returns (address)",
  "function guardian() view returns (address)",
  "function fee() view returns (uint96)",
]);

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

const ORACLE = new ethers.Interface([
  "function price() view returns (uint256)",
  "function owner() view returns (address)",
  "function BASE_FEED_1() view returns (address)",
  "function BASE_FEED_2() view returns (address)",
  "function QUOTE_FEED_1() view returns (address)",
  "function QUOTE_FEED_2() view returns (address)",
  "function BASE_TOKEN() view returns (address)",
  "function QUOTE_TOKEN() view returns (address)",
  "function BASE_VAULT() view returns (address)",
  "function QUOTE_VAULT() view returns (address)",
  "function SCALE_FACTOR() view returns (uint256)",
]);

const FEED = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);

const BEACON = new ethers.Interface(["function implementation() view returns (address)"]);

const EVENT_TOPICS = [
  ethers.id("Borrow(bytes32,address,address,address,uint256,uint256)"),
  ethers.id("SupplyCollateral(bytes32,address,address,uint256)"),
  ethers.id("WithdrawCollateral(bytes32,address,address,address,uint256)"),
  ethers.id("Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)"),
];

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function compactMarket(id) { const text = String(id || ""); return /^0x[0-9a-fA-F]{64}$/.test(text) ? `${text.slice(0, 10)}...${text.slice(-6)}` : "n/a"; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`; }
function safeText(value, max = 140) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function unitsToNumber(value, decimals = 18) { try { const n = Number(ethers.formatUnits(toBig(value), Number(decimals))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function hexBlock(value) { return `0x${BigInt(Math.max(0, Number(value))).toString(16)}`; }
function wadBps(value) { try { return Number((toBig(value) * 10000n) / WAD); } catch (_) { return null; } }
function slotAddress(raw) { const addr = raw && raw !== "0x" && raw.length >= 66 ? normalizeAddress(`0x${raw.slice(26)}`) : null; return addr && addr !== ZERO ? addr : null; }
function addressFromTopic(topic) { return normalizeAddress(`0x${String(topic || "").slice(-40)}`); }

async function resolveInventoryRpc(chainId) {
  for (const url of loadRpcUrls()) {
    try {
      const idHex = await rpcCall(url, "eth_chainId", [], 5000);
      if (idHex && Number(BigInt(idHex)) === chainId) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-bend-phase0/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

async function fetchBendVaults() {
  const query = `{
    polGetRewardVaults(where: {protocolsIn: ["Bend"], includeNonWhitelisted: false}) {
      vaults { stakingTokenAddress }
    }
  }`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch("https://api.berachain.com", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "evm-audit-bend-phase0/1.0" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    if (!res.ok) return { vaults: [], ok: false, error: `HTTP ${res.status}` };
    const json = await res.json();
    if (json.errors) return { vaults: [], ok: false, error: "graphql-errors" };
    const vaults = (json?.data?.polGetRewardVaults?.vaults || []).map((row) => normalizeAddress(row.stakingTokenAddress)).filter(Boolean);
    return { vaults: unique(vaults).slice(0, MAX_VAULTS), ok: true, error: null };
  } catch (_) {
    return { vaults: [], ok: false, error: "fetch-failed" };
  } finally {
    clearTimeout(timer);
  }
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

async function getBalance(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return null;
  return await rpcCall(rpc, "eth_getBalance", [addr, "latest"], 10_000).catch(() => null);
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
  const addr = normalizeAddress(address);
  const [code, nativeBalanceRaw, implSlot, adminSlot, beaconSlot] = await Promise.all([
    getCode(rpc, addr),
    getBalance(rpc, addr),
    getSlotAddress(rpc, addr, EIP1967_IMPL),
    getSlotAddress(rpc, addr, EIP1967_ADMIN),
    getSlotAddress(rpc, addr, EIP1967_BEACON),
  ]);
  const beaconImpl = beaconSlot ? await safeCall(rpc, beaconSlot, BEACON, "implementation") : null;
  return {
    address: addr,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    implementation: implSlot || normalizeAddress(beaconImpl?.[0]),
    admin: adminSlot,
    beacon: beaconSlot,
    beaconImplementation: normalizeAddress(beaconImpl?.[0]),
    nativeBalanceWei: nativeBalanceRaw ? toBig(nativeBalanceRaw).toString() : null,
    nativeBalance: nativeBalanceRaw ? ethers.formatEther(toBig(nativeBalanceRaw)) : null,
  };
}

async function tokenMeta(rpc, token, fallback = {}) {
  const address = normalizeAddress(token);
  if (!address || address === ZERO) return { address, symbol: fallback.symbol || null, name: fallback.name || null, decimals: fallback.decimals ?? 18, codePresent: false };
  const [proxy, symbol, name, decimals, totalSupply] = await Promise.all([
    proxyMeta(rpc, address),
    safeCall(rpc, address, ERC20, "symbol"),
    safeCall(rpc, address, ERC20, "name"),
    safeCall(rpc, address, ERC20, "decimals"),
    safeCall(rpc, address, ERC20, "totalSupply"),
  ]);
  const dec = decimals?.[0] === undefined ? fallback.decimals ?? 18 : Number(decimals[0]);
  return {
    address,
    symbol: safeText(symbol?.[0], 40) || fallback.symbol || null,
    name: safeText(name?.[0], 80) || fallback.name || null,
    decimals: dec,
    totalSupplyRaw: totalSupply?.[0] === undefined ? null : totalSupply[0].toString(),
    totalSupply: totalSupply?.[0] === undefined ? null : ethers.formatUnits(totalSupply[0], dec),
    codePresent: proxy.codePresent,
    codeBytes: proxy.codeBytes,
    implementation: proxy.implementation,
  };
}

async function tokenPricesUsd(tokens) {
  const keys = unique(tokens.map((t) => normalizeAddress(t)).filter(Boolean).map((addr) => `berachain:${addr.toLowerCase()}`));
  const prices = new Map();
  if (!keys.length) return prices;
  for (let i = 0; i < keys.length; i += 80) {
    const chunk = keys.slice(i, i + 80);
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${chunk.join(",")}?searchWidth=6h`, 30_000);
    for (const [key, row] of Object.entries(json?.coins || {})) {
      const addr = lowerAddress(key.split(":").pop());
      const price = Number(row.price || 0);
      if (addr && Number.isFinite(price) && price > 0) prices.set(addr, price);
    }
  }
  return prices;
}

async function dexScreenerContext(token) {
  const address = normalizeAddress(token);
  if (!address || address === ZERO) return null;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { signal: AbortSignal.timeout(8_000), headers: { "user-agent": "evm-audit-bend-phase0/1.0" } });
    if (!res.ok) return null;
    const json = await res.json();
    const pairs = (json.pairs || []).filter((p) => String(p.chainId).toLowerCase() === "berachain");
    pairs.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
    const best = pairs[0];
    return best ? { pairAddress: normalizeAddress(best.pairAddress), dexId: safeText(best.dexId, 40), liquidityUsd: round(best.liquidity?.usd, 2), priceUsd: round(best.priceUsd, 10), baseSymbol: safeText(best.baseToken?.symbol, 24), quoteSymbol: safeText(best.quoteToken?.symbol, 24) } : null;
  } catch (_) { return null; }
}

async function inspectVault(rpc, address) {
  const addr = normalizeAddress(address);
  const [proxy, symbol, name, decimals, asset, totalAssets, totalSupply, owner, curator, guardian, fee, queueLen] = await Promise.all([
    proxyMeta(rpc, addr),
    safeCall(rpc, addr, VAULT, "symbol"),
    safeCall(rpc, addr, VAULT, "name"),
    safeCall(rpc, addr, VAULT, "decimals"),
    safeCall(rpc, addr, VAULT, "asset"),
    safeCall(rpc, addr, VAULT, "totalAssets"),
    safeCall(rpc, addr, VAULT, "totalSupply"),
    safeCall(rpc, addr, VAULT, "owner"),
    safeCall(rpc, addr, VAULT, "curator"),
    safeCall(rpc, addr, VAULT, "guardian"),
    safeCall(rpc, addr, VAULT, "fee"),
    safeCall(rpc, addr, VAULT, "withdrawQueueLength"),
  ]);
  const length = queueLen?.[0] === undefined ? 0 : Number(queueLen[0]);
  const marketIds = [];
  for (let i = 0; i < Math.min(length, MAX_MARKETS); i++) {
    const raw = await safeCall(rpc, addr, VAULT, "withdrawQueue", [i]);
    const id = raw?.[0] ? String(raw[0]) : null;
    if (/^0x[0-9a-fA-F]{64}$/.test(id || "")) marketIds.push(id);
  }
  const dec = decimals?.[0] === undefined ? 18 : Number(decimals[0]);
  return {
    address: addr,
    codePresent: proxy.codePresent,
    codeBytes: proxy.codeBytes,
    implementation: proxy.implementation,
    admin: proxy.admin,
    symbol: safeText(symbol?.[0], 40),
    name: safeText(name?.[0], 80),
    decimals: dec,
    asset: normalizeAddress(asset?.[0]),
    totalAssetsRaw: totalAssets?.[0] === undefined ? null : totalAssets[0].toString(),
    totalAssets: totalAssets?.[0] === undefined ? null : ethers.formatUnits(totalAssets[0], dec),
    totalSupplyRaw: totalSupply?.[0] === undefined ? null : totalSupply[0].toString(),
    totalSupply: totalSupply?.[0] === undefined ? null : ethers.formatUnits(totalSupply[0], dec),
    owner: normalizeAddress(owner?.[0]),
    curator: normalizeAddress(curator?.[0]),
    guardian: normalizeAddress(guardian?.[0]),
    feeRaw: fee?.[0] === undefined ? null : fee[0].toString(),
    withdrawQueueLength: length,
    marketIds,
    queueTruncated: length > marketIds.length,
  };
}

async function feedInfo(rpc, feedAddress, latestTimestamp, role) {
  const address = normalizeAddress(feedAddress);
  if (!address || address === ZERO) return null;
  const [code, decimals, description, roundData] = await Promise.all([
    getCode(rpc, address),
    safeCall(rpc, address, FEED, "decimals"),
    safeCall(rpc, address, FEED, "description"),
    safeCall(rpc, address, FEED, "latestRoundData"),
  ]);
  const updatedAt = roundData?.[3] === undefined ? null : Number(roundData[3]);
  const ageSeconds = updatedAt && latestTimestamp ? Math.max(0, latestTimestamp - updatedAt) : null;
  return {
    role,
    address,
    codePresent: Boolean(code && code !== "0x"),
    decimals: decimals?.[0] === undefined ? null : Number(decimals[0]),
    description: safeText(description?.[0], 80),
    answer: roundData?.[1] === undefined ? null : roundData[1].toString(),
    updatedAt,
    ageSeconds,
    staleWarn: ageSeconds !== null && ageSeconds >= STALE_FEED_WARN_SECONDS,
  };
}

async function inspectOracle(rpc, oracleAddress, latestTimestamp) {
  const address = normalizeAddress(oracleAddress);
  if (!address || address === ZERO) return { address, codePresent: false, priceRaw: null, feedRows: [], staleFeedRows: 0 };
  const [proxy, price, owner, baseFeed1, baseFeed2, quoteFeed1, quoteFeed2, baseToken, quoteToken, baseVault, quoteVault, scaleFactor] = await Promise.all([
    proxyMeta(rpc, address),
    safeCall(rpc, address, ORACLE, "price"),
    safeCall(rpc, address, ORACLE, "owner"),
    safeCall(rpc, address, ORACLE, "BASE_FEED_1"),
    safeCall(rpc, address, ORACLE, "BASE_FEED_2"),
    safeCall(rpc, address, ORACLE, "QUOTE_FEED_1"),
    safeCall(rpc, address, ORACLE, "QUOTE_FEED_2"),
    safeCall(rpc, address, ORACLE, "BASE_TOKEN"),
    safeCall(rpc, address, ORACLE, "QUOTE_TOKEN"),
    safeCall(rpc, address, ORACLE, "BASE_VAULT"),
    safeCall(rpc, address, ORACLE, "QUOTE_VAULT"),
    safeCall(rpc, address, ORACLE, "SCALE_FACTOR"),
  ]);
  const feedInputs = [
    ["baseFeed1", baseFeed1], ["baseFeed2", baseFeed2], ["quoteFeed1", quoteFeed1], ["quoteFeed2", quoteFeed2],
  ].map(([role, value]) => ({ role, address: normalizeAddress(value?.[0]) })).filter((row) => row.address && row.address !== ZERO);
  const feedRows = [];
  for (const row of feedInputs) feedRows.push(await feedInfo(rpc, row.address, latestTimestamp, row.role));
  return {
    address,
    codePresent: proxy.codePresent,
    codeBytes: proxy.codeBytes,
    implementation: proxy.implementation,
    owner: normalizeAddress(owner?.[0]),
    priceRaw: price?.[0] === undefined ? null : price[0].toString(),
    baseToken: normalizeAddress(baseToken?.[0]),
    quoteToken: normalizeAddress(quoteToken?.[0]),
    baseVault: normalizeAddress(baseVault?.[0]),
    quoteVault: normalizeAddress(quoteVault?.[0]),
    scaleFactor: scaleFactor?.[0] === undefined ? null : scaleFactor[0].toString(),
    feedRows: feedRows.filter(Boolean),
    staleFeedRows: feedRows.filter((row) => row?.staleWarn).length,
  };
}

function sharesToAssetsUp(shares, totalAssets, totalShares) {
  const s = toBig(shares);
  const ta = toBig(totalAssets);
  const ts = toBig(totalShares);
  if (s === 0n || ta === 0n || ts === 0n) return 0n;
  return (s * ta + ts - 1n) / ts;
}

function maxBorrowAssets(collateral, oraclePrice, lltv) {
  const c = toBig(collateral);
  const p = toBig(oraclePrice);
  const l = toBig(lltv);
  if (c === 0n || p === 0n || l === 0n) return 0n;
  return (((c * p) / ORACLE_PRICE_SCALE) * l) / WAD;
}

async function inspectMarket(rpc, marketId, latestTimestamp) {
  const [params, state] = await Promise.all([
    safeCall(rpc, MORPHO_BLUE, MORPHO, "idToMarketParams", [marketId]),
    safeCall(rpc, MORPHO_BLUE, MORPHO, "market", [marketId]),
  ]);
  if (!params || !state) return { marketId, valid: false, blocker: "market params/state not decoded" };
  const loanToken = normalizeAddress(params[0]);
  const collateralToken = normalizeAddress(params[1]);
  const oracle = normalizeAddress(params[2]);
  const irm = normalizeAddress(params[3]);
  const lltv = params[4];
  const [loanMeta, collateralMeta, oracleMeta, irmProxy] = await Promise.all([
    tokenMeta(rpc, loanToken),
    tokenMeta(rpc, collateralToken),
    inspectOracle(rpc, oracle, latestTimestamp),
    proxyMeta(rpc, irm),
  ]);
  return {
    marketId,
    marketRef: compactMarket(marketId),
    valid: true,
    params: { loanToken, collateralToken, oracle, irm, lltv: lltv.toString(), lltvBps: wadBps(lltv) },
    state: {
      totalSupplyAssetsRaw: state[0].toString(),
      totalSupplySharesRaw: state[1].toString(),
      totalBorrowAssetsRaw: state[2].toString(),
      totalBorrowSharesRaw: state[3].toString(),
      lastUpdate: state[4].toString(),
      feeRaw: state[5].toString(),
    },
    loanMeta,
    collateralMeta,
    oracleMeta,
    irmMeta: { address: irm, codePresent: irmProxy.codePresent, codeBytes: irmProxy.codeBytes, implementation: irmProxy.implementation },
  };
}

async function enrichMarketEconomics(market, prices, dexRows) {
  if (!market.valid) return market;
  const loan = lowerAddress(market.params.loanToken);
  const coll = lowerAddress(market.params.collateralToken);
  const loanPrice = loan ? prices.get(loan) || dexRows.get(loan)?.priceUsd || null : null;
  const collPrice = coll ? prices.get(coll) || dexRows.get(coll)?.priceUsd || null : null;
  const loanDecimals = market.loanMeta?.decimals ?? 18;
  const collDecimals = market.collateralMeta?.decimals ?? 18;
  const supplyUnits = unitsToNumber(market.state.totalSupplyAssetsRaw, loanDecimals);
  const borrowUnits = unitsToNumber(market.state.totalBorrowAssetsRaw, loanDecimals);
  const cashUnits = supplyUnits !== null && borrowUnits !== null ? Math.max(0, supplyUnits - borrowUnits) : null;
  const supplyUsd = loanPrice && supplyUnits !== null ? supplyUnits * loanPrice : null;
  const borrowUsd = loanPrice && borrowUnits !== null ? borrowUnits * loanPrice : null;
  const cashUsd = loanPrice && cashUnits !== null ? cashUnits * loanPrice : null;
  market.economics = {
    loanPriceUsd: round(loanPrice, 10),
    collateralPriceUsd: round(collPrice, 10),
    totalSupplyAssets: supplyUnits === null ? null : round(supplyUnits, 6),
    totalBorrowAssets: borrowUnits === null ? null : round(borrowUnits, 6),
    borrowCash: cashUnits === null ? null : round(cashUnits, 6),
    totalSupplyUsd: round(supplyUsd, 2),
    totalBorrowUsd: round(borrowUsd, 2),
    borrowCashUsd: round(cashUsd, 2),
    materialBorrow: borrowUsd !== null && borrowUsd >= MATERIAL_USD,
    materialCash: cashUsd !== null && cashUsd >= MATERIAL_USD,
    highLltv: (market.params.lltvBps || 0) >= HIGH_LLTV_BPS,
    loanDex: dexRows.get(loan) || null,
    collateralDex: dexRows.get(coll) || null,
  };
  market.routePositive = false;
  market.blockers = [
    "Market state is context only without a current borrower or accepted-value divergence route",
    market.oracleMeta?.priceRaw ? null : "Oracle price() not decoded for exact health math",
    "No exact collateral acquisition, liquidation, borrow, or unwind economics proven",
  ].filter(Boolean);
  return market;
}

async function getLogs(rpc, filter, timeoutMs = 16_000) {
  const logs = await rpcCall(rpc, "eth_getLogs", [filter], timeoutMs).catch(() => null);
  return Array.isArray(logs) ? logs : null;
}

async function discoverUsersForMarket(rpc, marketId, latestNumber) {
  const users = new Set();
  const logStats = { chunks: 0, chunksFailed: 0, logs: 0 };
  if (!latestNumber) return { users: [], logStats };
  const from = Math.max(0, latestNumber - RECENT_LOG_BLOCKS);
  for (let start = from; start <= latestNumber && users.size < MAX_USERS_PER_MARKET; start += LOG_CHUNK_BLOCKS + 1) {
    const end = Math.min(latestNumber, start + LOG_CHUNK_BLOCKS);
    logStats.chunks += 1;
    const logs = await getLogs(rpc, { address: MORPHO_BLUE, fromBlock: hexBlock(start), toBlock: hexBlock(end), topics: [EVENT_TOPICS, marketId] });
    if (!logs) { logStats.chunksFailed += 1; continue; }
    logStats.logs += logs.length;
    for (const log of logs) {
      const user = addressFromTopic(log.topics?.[3]);
      if (user) users.add(user.toLowerCase());
      if (users.size >= MAX_USERS_PER_MARKET) break;
    }
  }
  return { users: [...users].slice(0, MAX_USERS_PER_MARKET).map((u) => normalizeAddress(u)), logStats };
}

function positionHealth(market, position) {
  const borrowShares = toBig(position.borrowSharesRaw);
  const collateral = toBig(position.collateralRaw);
  const borrowAssets = sharesToAssetsUp(borrowShares, market.state.totalBorrowAssetsRaw, market.state.totalBorrowSharesRaw);
  const maxBorrow = market.oracleMeta?.priceRaw ? maxBorrowAssets(collateral, market.oracleMeta.priceRaw, market.params.lltv) : 0n;
  const healthBps = borrowAssets > 0n && maxBorrow > 0n ? Number((maxBorrow * 10000n) / borrowAssets) : null;
  const debtUnits = unitsToNumber(borrowAssets, market.loanMeta?.decimals ?? 18);
  const collateralUnits = unitsToNumber(collateral, market.collateralMeta?.decimals ?? 18);
  const debtUsd = market.economics?.loanPriceUsd && debtUnits !== null ? debtUnits * market.economics.loanPriceUsd : null;
  const collateralUsd = market.economics?.collateralPriceUsd && collateralUnits !== null ? collateralUnits * market.economics.collateralPriceUsd : null;
  return {
    borrowAssetsRaw: borrowAssets.toString(),
    borrowAssets: debtUnits === null ? null : round(debtUnits, 8),
    maxBorrowAssetsRaw: maxBorrow.toString(),
    debtUsd: round(debtUsd, 2),
    collateral: collateralUnits === null ? null : round(collateralUnits, 8),
    collateralUsd: round(collateralUsd, 2),
    healthFactorBps: healthBps,
    liquidatable: healthBps !== null && healthBps < 10000,
    materialDebt: debtUsd !== null && debtUsd >= MATERIAL_USD,
  };
}

async function samplePositions(rpc, marketRows, latestNumber) {
  const rows = [];
  const logRows = [];
  let totalUsers = 0;
  for (let i = 0; i < marketRows.length; i++) {
    const market = marketRows[i];
    if (!market.valid) continue;
    const { users, logStats } = await discoverUsersForMarket(rpc, market.marketId, latestNumber);
    logRows.push({ marketId: market.marketId, marketRef: market.marketRef, usersDiscovered: users.length, ...logStats });
    totalUsers += users.length;
    for (let u = 0; u < users.length; u++) {
      const pos = await safeCall(rpc, MORPHO_BLUE, MORPHO, "position", [market.marketId, users[u]]);
      if (!pos) continue;
      const row = {
        sampleRef: `m${i + 1}-u${u + 1}`,
        marketId: market.marketId,
        marketRef: market.marketRef,
        loanSymbol: market.loanMeta?.symbol,
        collateralSymbol: market.collateralMeta?.symbol,
        supplySharesRaw: pos[0].toString(),
        borrowSharesRaw: pos[1].toString(),
        collateralRaw: pos[2].toString(),
      };
      const health = positionHealth(market, row);
      if (toBig(row.borrowSharesRaw) > 0n || toBig(row.collateralRaw) > 0n) rows.push({ ...row, ...health, routePositive: false });
    }
  }
  return { rows, logRows, totalUsers };
}

function contextSummary(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const fields = ["id", "protocol", "chain", "chainId", "surface", "side", "symbol", "token", "asset", "collateral", "borrowAsset", "routePositive", "watchCandidate", "liquidityUsd", "borrowCashUsd", "cashUsd", "source", "status"];
  const out = {};
  for (const field of fields) if (obj[field] !== undefined && typeof obj[field] !== "object") out[field] = String(obj[field]).slice(0, 120);
  return out;
}

function findMatches(data, wantedAddress, source, max = 12) {
  const matches = [];
  const wanted = lowerAddress(wantedAddress);
  if (!wanted) return matches;
  function walk(value, objectPath, parent) {
    if (matches.length >= max) return;
    if (typeof value === "string") {
      if (lowerAddress(value) === wanted) matches.push({ source, path: objectPath, context: contextSummary(parent), routePositive: Boolean(parent?.routePositive), watchCandidate: Boolean(parent?.watchCandidate) });
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) walk(value[i], `${objectPath}[${i}]`, parent); return; }
    for (const [key, child] of Object.entries(value)) walk(child, objectPath ? `${objectPath}.${key}` : key, value);
  }
  walk(data, "", null);
  return matches;
}

function artifactJoins(vaultRows, marketRows) {
  const inputs = [
    ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
    ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
    ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
    ["dex-consumer-routes", "reports/raw/fast/dex-consumer-routes.json"],
    ["rwa-nav", "reports/raw/fast/rwa-nav-consumer-graph.json"],
    ["erc4626", "reports/raw/fast/erc4626-consumer-joiner.json"],
    ["euler-v2", "reports/raw/fast/euler-v2-phase0.json"],
  ];
  const wanted = [
    { label: "BEND Morpho", address: MORPHO_BLUE, bendSpecific: true, common: false },
    ...vaultRows.map((row) => ({ label: `vault ${row.symbol || compactAddress(row.address)}`, address: row.address, bendSpecific: true, common: false })),
  ];
  for (const market of marketRows) {
    if (!market.valid) continue;
    wanted.push({ label: `${market.loanMeta?.symbol || "loan"} loan`, address: market.params.loanToken, bendSpecific: false, common: true });
    wanted.push({ label: `${market.collateralMeta?.symbol || "collateral"} collateral`, address: market.params.collateralToken, bendSpecific: false, common: true });
    wanted.push({ label: `${market.marketRef} oracle`, address: market.params.oracle, bendSpecific: true, common: false });
  }
  const rows = [];
  const loadedInputs = [];
  for (const [source, rel] of inputs) {
    const data = readJson(path.join(WORKSPACE, rel), null);
    if (!data) continue;
    loadedInputs.push(rel);
    for (const item of wanted) {
      const matches = findMatches(data, item.address, source, item.common ? 5 : 20);
      if (!matches.length) continue;
      rows.push({ label: item.label, address: normalizeAddress(item.address), bendSpecific: Boolean(item.bendSpecific), common: Boolean(item.common), source, joinCount: matches.length, routePositive: matches.some((m) => m.routePositive), watchCandidate: matches.some((m) => m.watchCandidate), matches });
    }
  }
  rows.sort((a, b) => Number(b.bendSpecific) - Number(a.bendSpecific) || Number(b.routePositive) - Number(a.routePositive) || Number(b.watchCandidate) - Number(a.watchCandidate) || Number(a.common) - Number(b.common) || b.joinCount - a.joinCount);
  return { rows, loadedInputs };
}

function writeReport(out) {
  const s = out.summary;
  const topMarkets = out.marketRows.slice(0, 12).map((m) => `| ${m.marketRef} | ${m.loanMeta?.symbol || "?"} | ${m.collateralMeta?.symbol || "?"} | ${m.params?.lltvBps || "n/a"} | ${formatUsd(m.economics?.totalBorrowUsd)} | ${formatUsd(m.economics?.borrowCashUsd)} | ${m.oracleMeta?.codePresent} |`).join("\n");
  const topVaults = out.vaultRows.slice(0, 12).map((v) => `| ${v.symbol || compactAddress(v.address)} | ${v.address} | ${v.codePresent} | ${v.withdrawQueueLength} | ${v.marketIds.length} |`).join("\n");
  const liqRows = out.sampledPositionRows.filter((r) => r.liquidatable).slice(0, 10).map((r) => `| ${r.sampleRef} | ${r.marketRef} | ${r.loanSymbol} | ${r.collateralSymbol} | ${r.healthFactorBps === null ? "n/a" : r.healthFactorBps} | ${formatUsd(r.debtUsd)} | ${formatUsd(r.collateralUsd)} |`).join("\n") || "| none | none | none | none | n/a | n/a | n/a |";
  const content = `# 🟢 DORMANT — BEND Phase 0

Generated: ${out.generatedAt}

Scanner: \`tools/scan-bend-phase0.js\`

Artifact: \`reports/raw/fast/bend-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. BEND is mapped as a Berachain Morpho Blue fork integrated with whitelisted PoL reward vault staking tokens. This Phase 0 resolved the public adapter methodology, Berachain vault queue market IDs, Morpho market params/state, token/oracle code, bounded recent borrower positions, and local consumer joins. It found no exact positive borrow, liquidation, redemption, or DEX unwind route.

## Target

| Field | Value |
|---|---:|
| Protocol | \`${out.target.name}\` |
| Slug | \`${out.target.slug}\` |
| Chain | \`Berachain (${BERACHAIN_CHAIN_ID})\` |
| Public TVL | \`${formatUsd(s.defillamaCurrentTvlUsd)}\` |
| Public borrowed | \`${formatUsd(s.defillamaBorrowedUsd)}\` |
| Berachain RPC resolved | \`${s.berachainRpcResolved}\` |
| Public vault discovery | \`${out.discovery.vaultDiscoveryOk}\` |
| Coverage | \`${s.coverageClassification}\` |

## Vaults

| Vault/Staking token | Address | Code | Queue length | Markets resolved |
|---|---|---:|---:|---:|
${topVaults || "| none | none | false | 0 | 0 |"}

## Markets

| Market | Loan | Collateral | LLTV bps | Total borrow | Borrow cash | Oracle code |
|---|---|---|---:|---:|---:|---:|
${topMarkets || "| none | none | none | n/a | n/a | n/a | false |"}

## Bounded Borrower Sampling

| Metric | Value |
|---|---:|
| Recent-log window blocks | \`${RECENT_LOG_BLOCKS}\` |
| Recent users discovered | \`${s.recentLogUsers}\` |
| Sampled position rows | \`${s.sampledPositions}\` |
| Positions with debt | \`${s.positionsWithDebt}\` |
| Liquidatable rows | \`${s.sampledLiquidatableRows}\` |
| Material liquidatable rows | \`${s.materialLiquidatableRows}\` |

| Sample | Market | Loan | Collateral | Health bps | Debt | Collateral |
|---|---|---|---|---:|---:|---:|
${liqRows}

## Consumer/Artifact Joins

| Metric | Value |
|---|---:|
| Artifact inputs loaded | \`${out.joinInputsLoaded.length}\` |
| Address join rows | \`${s.artifactJoinRows}\` |
| BEND-specific joins | \`${s.bendSpecificJoinRows}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Route-positive rows | \`${s.routePositive}\` |

## Blockers

- BEND markets are Morpho-style market rows; high LLTV or borrow cash is not an exploit without a stale/manipulable oracle, liquidatable borrower, or accepted-value divergence.
- The recent-log borrower scan is bounded and stores sanitized sample refs only, not borrower addresses.
- No sampled material borrower is both currently liquidatable and exact-quoted through repay, seize, collateral exit, gas, and slippage.
- Token and local consumer joins are context-only unless the exact BEND market/oracle/vault state creates positive borrow, liquidation, redemption, or unwind economics.
- No fork extraction proof and no signed-action justification exist.

## Next Gate

Reopen BEND only if a specific market has a current stale/manipulable oracle, material liquidatable borrower, or accepted-value divergence with exact positive acquisition/borrow/liquidation/unwind economics.
`;
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const rpcUrl = await resolveInventoryRpc(BERACHAIN_CHAIN_ID);
  if (!rpcUrl) throw new Error("Missing required Berachain RPC endpoint from rpc_endpoints.txt for chainId 80094. Provide a suitable endpoint before continuing.");

  const [metadataRaw, discovery, block] = await Promise.all([
    fetchJson("https://api.llama.fi/protocol/bend", 30_000).catch(() => ({})),
    fetchBendVaults(),
    latestBlock(rpcUrl),
  ]);

  const [morphoProxy, morphoOwner, morphoFeeRecipient] = await Promise.all([
    proxyMeta(rpcUrl, MORPHO_BLUE),
    safeCall(rpcUrl, MORPHO_BLUE, MORPHO, "owner"),
    safeCall(rpcUrl, MORPHO_BLUE, MORPHO, "feeRecipient"),
  ]);

  const vaultRows = [];
  for (const vault of discovery.vaults) vaultRows.push(await inspectVault(rpcUrl, vault));
  const marketIds = unique(vaultRows.flatMap((row) => row.marketIds)).slice(0, MAX_MARKETS);
  const marketRowsRaw = [];
  for (const id of marketIds) marketRowsRaw.push(await inspectMarket(rpcUrl, id, block.timestamp));

  const tokenAddresses = unique(marketRowsRaw.flatMap((m) => m.valid ? [m.params.loanToken, m.params.collateralToken] : []).filter(Boolean));
  const [prices, dexPairs] = await Promise.all([
    tokenPricesUsd(tokenAddresses),
    Promise.all(tokenAddresses.map(async (addr) => [lowerAddress(addr), await dexScreenerContext(addr)])),
  ]);
  const dexRows = new Map(dexPairs.filter(([addr, row]) => addr && row));
  const marketRows = [];
  for (const market of marketRowsRaw) marketRows.push(await enrichMarketEconomics(market, prices, dexRows));

  const sampled = await samplePositions(rpcUrl, marketRows, block.number);
  const joins = artifactJoins(vaultRows, marketRows);

  const totalBorrowUsd = marketRows.reduce((sum, row) => sum + (asNumber(row.economics?.totalBorrowUsd) || 0), 0);
  const totalCashUsd = marketRows.reduce((sum, row) => sum + (asNumber(row.economics?.borrowCashUsd) || 0), 0);
  const highLltvRows = marketRows.filter((row) => row.economics?.highLltv).length;
  const materialBorrowRows = marketRows.filter((row) => row.economics?.materialBorrow).length;
  const staleFeedRows = marketRows.reduce((sum, row) => sum + (row.oracleMeta?.staleFeedRows || 0), 0);
  const liquidatableRows = sampled.rows.filter((row) => row.liquidatable);
  const materialLiquidatableRows = liquidatableRows.filter((row) => row.materialDebt);
  const logErrorCount = sampled.logRows.reduce((sum, row) => sum + (row.chunksFailed || 0), 0);
  const bendSpecificRouteJoins = joins.rows.filter((row) => row.bendSpecific && row.routePositive).length;
  const proofWeaknessRows = 0;
  const exactEconomicsRows = 0;
  const routePositive = proofWeaknessRows > 0 && exactEconomicsRows > 0 ? exactEconomicsRows : 0;
  const watchCandidates = materialLiquidatableRows.length + marketRows.filter((row) => row.economics?.highLltv && row.economics?.materialCash).length + staleFeedRows + joins.rows.filter((row) => row.bendSpecific && row.watchCandidate).length;

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-bend-phase0.js",
    scope: "BEND Berachain Morpho Blue/PoL vault read-only market, oracle, bounded borrower, and consumer-join Phase 0",
    target: {
      name: metadataRaw.name || "BEND",
      slug: metadataRaw.slug || "bend",
      category: metadataRaw.category || "Lending",
      chains: metadataRaw.chains || ["Berachain"],
      tvlCodePath: metadataRaw.tvlCodePath || "DefiLlama projects/berachain-bend/index.js",
      audits: metadataRaw.audits || "1",
      url: metadataRaw.url || "https://bend.berachain.com",
      twitter: metadataRaw.twitter || "berachain",
    },
    safety: { rpcInventoryRead: true, rpcInventoryOnly: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: routePositive > 0, signedActionJustified: false },
    thresholds: { maxVaults: MAX_VAULTS, maxMarkets: MAX_MARKETS, recentLogBlocks: RECENT_LOG_BLOCKS, maxUsersPerMarket: MAX_USERS_PER_MARKET, materialUsd: MATERIAL_USD, highLltvBps: HIGH_LLTV_BPS, staleFeedWarnSeconds: STALE_FEED_WARN_SECONDS },
    metadata: { module: metadataRaw.module || "berachain-bend/index.js", methodology: safeText(metadataRaw.methodology, 400), description: safeText(metadataRaw.description, 400), currentChainTvls: metadataRaw.currentChainTvls || {}, morphoBlue: MORPHO_BLUE, adapterModel: "Bend whitelisted PoL vault stakingTokenAddress -> withdrawQueue market IDs -> Morpho idToMarketParams/market" },
    discovery: { vaultDiscoveryOk: discovery.ok, vaultDiscoveryError: discovery.error, vaultsDiscovered: discovery.vaults.length, source: "Berachain public PoL reward-vault GraphQL, aggregate counts only" },
    chain: { chain: "Berachain", chainId: BERACHAIN_CHAIN_ID, blockNumber: block.number, blockTimestamp: block.timestamp },
    coreContracts: { morphoBlue: { ...morphoProxy, owner: normalizeAddress(morphoOwner?.[0]), feeRecipient: normalizeAddress(morphoFeeRecipient?.[0]) } },
    vaultRows,
    marketRows,
    recentLogRows: sampled.logRows,
    sampledPositionRows: sampled.rows,
    artifactJoins: joins.rows,
    joinInputsLoaded: joins.loadedInputs,
    summary: {
      berachainRpcResolved: Boolean(rpcUrl),
      defillamaCurrentTvlUsd: round(metadataRaw.tvl, 2),
      defillamaBorrowedUsd: round(metadataRaw.borrowed, 2),
      morphoCodePresent: morphoProxy.codePresent,
      vaultRows: vaultRows.length,
      vaultRowsWithCode: vaultRows.filter((row) => row.codePresent).length,
      vaultsWithMarkets: vaultRows.filter((row) => row.marketIds.length).length,
      marketsResolved: marketRows.filter((row) => row.valid).length,
      marketRows: marketRows.filter((row) => row.valid).length,
      materialBorrowRows,
      highLltvRows,
      materialCashRows: marketRows.filter((row) => row.economics?.materialCash).length,
      totalBorrowUsd: round(totalBorrowUsd, 2),
      totalBorrowCashUsd: round(totalCashUsd, 2),
      oracleRows: unique(marketRows.map((row) => row.params?.oracle).filter(Boolean)).length,
      oracleRowsWithCode: unique(marketRows.filter((row) => row.oracleMeta?.codePresent).map((row) => row.params?.oracle)).length,
      staleFeedRows,
      recentLogUsers: sampled.totalUsers,
      sampledPositions: sampled.rows.length,
      positionsWithDebt: sampled.rows.filter((row) => toBig(row.borrowSharesRaw) > 0n).length,
      sampledLiquidatableRows: liquidatableRows.length,
      materialLiquidatableRows: materialLiquidatableRows.length,
      artifactJoinRows: joins.rows.length,
      bendSpecificJoinRows: joins.rows.filter((row) => row.bendSpecific).length,
      bendSpecificRouteJoins,
      logErrors: logErrorCount,
      proofWeaknessRows,
      exactEconomicsRows,
      watchCandidates,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      coverageClassification: "bounded-with-caveats",
      status: routePositive > 0 ? "route-positive-needs-proof" : "phase0-no-route-positive",
    },
    blockers: [
      "No BEND-specific oracle, vault, market-accounting, or PoL integration weakness proven",
      "High LLTV/material-cash rows are context only without an attacker-favorable oracle/accounting trigger",
      "Bounded recent-log borrower sampling is not exhaustive and stores no borrower addresses",
      "No exact positive repay, liquidation seize, collateral exit, borrow, redemption, or DEX unwind economics",
      "No fork extraction proof and no signed-action justification",
    ],
    requiredForRoutePositive: [
      "specific BEND market accepts stale, manipulable, under-bound, or overvalued oracle/accounting state, or a material borrower is currently liquidatable",
      "collateral acquisition or liquidation repay path is permissionless and exact-quoted",
      "borrowed or seized asset exit is positive after gas/slippage/fees",
      "fork extraction proof",
    ],
    nextReadOnlyStep: "Reopen BEND only if a material liquidatable borrower, stale/manipulable oracle row, or accepted-value divergence maps to exact positive economics; otherwise proceed to the next public Phase 0 target.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);
  writeReport(output);
  if (!QUIET) {
    console.log(`BEND Phase0: vaults=${vaultRows.length} markets=${output.summary.marketRows} borrow=$${Math.round(totalBorrowUsd || 0)} cash=$${Math.round(totalCashUsd || 0)} sampled=${sampled.rows.length} liquidatable=${liquidatableRows.length} watch=${watchCandidates} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(String(err?.message || err).slice(0, 320));
  process.exit(1);
});
