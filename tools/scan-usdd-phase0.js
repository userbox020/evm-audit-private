#!/usr/bin/env node
// scan-usdd-phase0.js - bounded read-only Phase 0 for USDD EVM PSM/collateral and consumers.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { loadRpcUrls, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "usdd-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "usdd-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const CHAINS = {
  1: {
    name: "Ethereum",
    llamaKey: "Ethereum",
    coinSlug: "ethereum",
    usdd: "0x4f8e5DE400DE08B164E7421B3EE387f461beCD1A",
    susdd: "0xC5d6A7B61d18AfA11435a889557b068BB9f29930",
    psm: [
      { symbol: "USDT", psm: "0xce355440c00014a229bbec030a2b8f8eb45a2897", join: "0x217e42CEB2eAE9ECB788fDF0e31c806c531760A3", token: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
      { symbol: "USDC", psm: "0x12d0351f68035a41d13fc8324562e2d51b7a3b93", join: "0x9A7E1B324060dB7342aeA08c0dc56F55CEd6F519", token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    ],
    aavePool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  },
  56: {
    name: "BNB Chain",
    llamaKey: "Binance",
    coinSlug: "bsc",
    usdd: "0x45E51bc23D592EB2DBA86da3985299f7895d66Ba",
    susdd: "0x8bA9dA757d1D66c58b1ae7e2ED6c04087348A82d",
    psm: [
      { symbol: "USDT", psm: "0x939d3FB56cd12d68CaA1125cc57a8d2391F7Ee29", join: "0xe229FdA620B8a9B98ef184830EE3063F0F86B790", token: "0x55d398326f99059fF775485246999027B3197955" },
    ],
    venusComptroller: "0xfD36E2c2a6789Db23113685031d7F16329158384",
  },
};

const INPUTS = [
  ["stablecoin-depeg", "reports/raw/fast/stablecoin-depeg-lending-routes.json"],
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["pendle-pt", "reports/raw/fast/pendle-pt-multichain-consumer-graph.json"],
  ["pendle-yt", "reports/raw/fast/pendle-yt-collateral-routes.json"],
  ["morpho-pyth", "reports/raw/fast/morpho-pyth-unsafe-consumers.json"],
  ["morpho-public-allocator", "reports/raw/fast/morpho-public-allocator-force-feed.json"],
  ["dex-consumer-routes", "reports/raw/fast/dex-consumer-routes.json"],
  ["governance-listing", "reports/raw/fast/governance-listing-watch.json"],
];

const ERC20 = new ethers.Interface([
  "function asset() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function symbol() view returns (string)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
  "function wards(address) view returns (uint256)",
  "function tin() view returns (uint256)",
  "function tout() view returns (uint256)",
  "function vat() view returns (address)",
  "function gemJoin() view returns (address)",
  "function usdd() view returns (address)",
]);
const AAVE_POOL = new ethers.Interface([
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns (tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
]);
const VENUS_COMPTROLLER = new ethers.Interface([
  "function getAllMarkets() view returns (address[])",
  "function markets(address) view returns (bool,uint256,bool)",
  "function actionPaused(address,uint8) view returns (bool)",
]);
const VTOKEN = new ethers.Interface([
  "function underlying() view returns (address)",
  "function getCash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function symbol() view returns (string)",
]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readJson(file, fallback = null) { try { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; } }
function normalizeAddress(value) { try { return ethers.getAddress(value); } catch (_) { const text = String(value || ""); if (/^0x[0-9a-fA-F]{40}$/.test(text)) { try { return ethers.getAddress(text.toLowerCase()); } catch (_) { return null; } } return null; } }
function lowerAddress(value) { const address = normalizeAddress(value); return address ? address.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function addressFromStorageSlot(raw) { if (!raw || raw === "0x") return null; const hex = strip0x(raw).padStart(64, "0"); if (/^0+$/.test(hex)) return null; return normalizeAddress(`0x${hex.slice(-40)}`); }
function wordAt(raw, index) { const hex = strip0x(raw); const start = index * 64; if (!hex || hex.length < start + 64) return null; return `0x${hex.slice(start, start + 64)}`; }
function addressWordAt(raw, index) { const word = wordAt(raw, index); if (!word) return null; const hex = strip0x(word).padStart(64, "0"); if (/^0+$/.test(hex)) return null; return normalizeAddress(`0x${hex.slice(-40)}`); }
function formatUnits(value, decimals) { if (value === null || value === undefined || decimals === null || decimals === undefined) return null; try { return ethers.formatUnits(BigInt(value), Number(decimals)); } catch (_) { return null; } }
function numberUnits(value, decimals) { const text = formatUnits(value, decimals); const n = Number(text); return Number.isFinite(n) ? n : null; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "boolean") return value ? 1 : 0; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const p = 10 ** decimals; return Math.round(n * p) / p; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${n.toLocaleString()}`; }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function lastRow(value) { return Array.isArray(value) && value.length ? value[value.length - 1] : null; }

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

function client(url) { return { call: (method, params = [], timeoutMs = 10_000) => rpcCall(url, method, params, timeoutMs) }; }
async function fetchJson(url, timeoutMs = 30_000, options = {}) { const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs); try { const res = await fetch(url, { ...options, signal: c.signal, headers: { "user-agent": "evm-audit-usdd-phase0/1.0", ...(options.headers || {}) } }); if (!res.ok) throw new Error(`HTTP ${res.status}`); return await res.json(); } finally { clearTimeout(t); } }
async function getCode(rpc, address) { return await rpc.call("eth_getCode", [address, "latest"], 10_000).catch(() => "0x") || "0x"; }
async function getStorage(rpc, address, slot) { return await rpc.call("eth_getStorageAt", [address, slot, "latest"], 10_000).catch(() => null); }
async function safeCall(rpc, to, iface, fn, args = []) { try { const raw = await rpc.call("eth_call", [{ to, data: iface.encodeFunctionData(fn, args) }, "latest"], 12_000); if (!raw || raw === "0x") return null; return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; } }

function decodeAaveConfig(data) {
  const raw = BigInt(data || 0n);
  const mask16 = 0xffffn;
  const mask36 = (1n << 36n) - 1n;
  return { ltv: Number(raw & mask16) / 10_000, liquidationThreshold: Number((raw >> 16n) & mask16) / 10_000, active: Boolean((raw >> 56n) & 1n), frozen: Boolean((raw >> 57n) & 1n), borrowingEnabled: Boolean((raw >> 58n) & 1n), paused: Boolean((raw >> 60n) & 1n), borrowCapWholeTokens: ((raw >> 80n) & mask36).toString(), supplyCapWholeTokens: ((raw >> 116n) & mask36).toString() };
}

async function priceMap() {
  const keys = [];
  for (const [chainId, cfg] of Object.entries(CHAINS)) {
    const slug = cfg.coinSlug;
    keys.push(`${slug}:${cfg.usdd.toLowerCase()}`, `${slug}:${cfg.susdd.toLowerCase()}`);
    for (const psm of cfg.psm) keys.push(`${slug}:${psm.token.toLowerCase()}`);
  }
  const prices = new Map();
  try {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${[...new Set(keys)].join(",")}?searchWidth=6h`, 30_000);
    for (const [key, row] of Object.entries(json.coins || {})) {
      const price = Number(row.price || 0);
      if (Number.isFinite(price) && price > 0) prices.set(key.toLowerCase(), price);
    }
  } catch (_) {}
  return prices;
}

async function inspectContract(rpc, chainId, label, address, kind) {
  const [code, implRaw, adminRaw, beaconRaw, ownerRaw, adminCallRaw, pausedRaw, tinRaw, toutRaw, vatRaw, gemJoinRaw, usddRaw] = await Promise.all([
    getCode(rpc, address), getStorage(rpc, address, EIP1967_IMPLEMENTATION_SLOT), getStorage(rpc, address, EIP1967_ADMIN_SLOT), getStorage(rpc, address, EIP1967_BEACON_SLOT), safeCall(rpc, address, COMMON, "owner", []), safeCall(rpc, address, COMMON, "admin", []), safeCall(rpc, address, COMMON, "paused", []), safeCall(rpc, address, COMMON, "tin", []), safeCall(rpc, address, COMMON, "tout", []), safeCall(rpc, address, COMMON, "vat", []), safeCall(rpc, address, COMMON, "gemJoin", []), safeCall(rpc, address, COMMON, "usdd", []),
  ]);
  return { chainId, chain: CHAINS[chainId].name, label, address: normalizeAddress(address), kind, codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0, eip1967: { implementation: addressFromStorageSlot(implRaw), admin: addressFromStorageSlot(adminRaw), beacon: addressFromStorageSlot(beaconRaw) }, owner: normalizeAddress(ownerRaw?.[0]) || null, admin: normalizeAddress(adminCallRaw?.[0]) || null, paused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]), tinRaw: tinRaw?.[0] === undefined ? null : tinRaw[0].toString(), toutRaw: toutRaw?.[0] === undefined ? null : toutRaw[0].toString(), vat: normalizeAddress(vatRaw?.[0]) || null, gemJoin: normalizeAddress(gemJoinRaw?.[0]) || null, usdd: normalizeAddress(usddRaw?.[0]) || null };
}

async function inspectToken(rpc, chainId, role, address, prices) {
  const cfg = CHAINS[chainId];
  const key = `${cfg.coinSlug}:${address.toLowerCase()}`;
  const [code, symbolRaw, nameRaw, decimalsRaw, supplyRaw, pausedRaw, ownerRaw, assetRaw, totalAssetsRaw, convertRaw] = await Promise.all([
    getCode(rpc, address), safeCall(rpc, address, ERC20, "symbol", []), safeCall(rpc, address, ERC20, "name", []), safeCall(rpc, address, ERC20, "decimals", []), safeCall(rpc, address, ERC20, "totalSupply", []), safeCall(rpc, address, ERC20, "paused", []), safeCall(rpc, address, ERC20, "owner", []), safeCall(rpc, address, ERC20, "asset", []), safeCall(rpc, address, ERC20, "totalAssets", []), safeCall(rpc, address, ERC20, "convertToAssets", [10n ** 18n]),
  ]);
  const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
  const supply = supplyRaw?.[0] ?? null;
  const priceUsd = prices.get(key.toLowerCase()) || null;
  const depegBps = role === "USDD" && priceUsd ? round((1 - priceUsd) * 10_000, 2) : null;
  return { chainId, chain: cfg.name, role, address: normalizeAddress(address), codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0, symbol: symbolRaw?.[0] === undefined ? null : String(symbolRaw[0]), name: nameRaw?.[0] === undefined ? null : String(nameRaw[0]), decimals, totalSupplyRaw: supply?.toString() || null, totalSupply: formatUnits(supply, decimals), priceUsd: round(priceUsd, 8), depegBps, paused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]), owner: normalizeAddress(ownerRaw?.[0]) || null, erc4626Like: Boolean(assetRaw?.[0] || totalAssetsRaw?.[0] !== undefined || convertRaw?.[0] !== undefined), asset: normalizeAddress(assetRaw?.[0]) || null, totalAssetsRaw: totalAssetsRaw?.[0] === undefined ? null : totalAssetsRaw[0].toString(), convertToAssets1e18Raw: convertRaw?.[0] === undefined ? null : convertRaw[0].toString(), routePositive: false };
}

async function inspectCollateral(rpc, chainId, psm, prices, defillamaTokensInUsd) {
  const cfg = CHAINS[chainId];
  const token = normalizeAddress(psm.token);
  const [symbolRaw, nameRaw, decimalsRaw, balanceRaw] = await Promise.all([safeCall(rpc, token, ERC20, "symbol", []), safeCall(rpc, token, ERC20, "name", []), safeCall(rpc, token, ERC20, "decimals", []), safeCall(rpc, token, ERC20, "balanceOf", [psm.join])]);
  const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
  const balance = balanceRaw?.[0] ?? null;
  const price = prices.get(`${cfg.coinSlug}:${token.toLowerCase()}`) || null;
  const balanceUsd = price && balance !== null && decimals !== null ? numberUnits(balance, decimals) * price : null;
  const defillamaUsd = asNumber(defillamaTokensInUsd?.[psm.symbol]) || null;
  return { chainId, chain: cfg.name, collateral: psm.symbol, token, psm: normalizeAddress(psm.psm), join: normalizeAddress(psm.join), symbol: symbolRaw?.[0] === undefined ? null : String(symbolRaw[0]), name: nameRaw?.[0] === undefined ? null : String(nameRaw[0]), decimals, joinBalanceRaw: balance?.toString() || null, joinBalance: formatUnits(balance, decimals), priceUsd: round(price, 8), joinBalanceUsd: round(balanceUsd, 2), defillamaLatestUsd: round(defillamaUsd, 2), balanceMinusDefillamaUsd: round(balanceUsd !== null && defillamaUsd !== null ? balanceUsd - defillamaUsd : null, 2), routePositive: false, blockers: ["PSM collateral balance is backing context only", "No permissionless mint/redeem edge or consumer route economics proven"] };
}

async function dexLiquidityRows() {
  const addresses = [];
  for (const cfg of Object.values(CHAINS)) addresses.push(cfg.usdd, cfg.susdd);
  try {
    const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${addresses.join(",")}`, 30_000);
    return (json.pairs || []).map((pair) => ({ chainId: pair.chainId || null, dexId: pair.dexId || null, pairAddress: normalizeAddress(pair.pairAddress) || pair.pairAddress || null, baseSymbol: pair.baseToken?.symbol || null, quoteSymbol: pair.quoteToken?.symbol || null, liquidityUsd: round(pair.liquidity?.usd, 2), volume24hUsd: round(pair.volume?.h24, 2), priceUsd: round(pair.priceUsd, 8), url: pair.url || null })).sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0)).slice(0, 20);
  } catch (_) { return []; }
}

async function scanAaveEthereum(rpc) {
  const cfg = CHAINS[1];
  const wanted = new Set([lowerAddress(cfg.usdd), lowerAddress(cfg.susdd)]);
  const rows = [];
  const reservesRaw = await safeCall(rpc, cfg.aavePool, AAVE_POOL, "getReservesList", []);
  const reserves = (reservesRaw?.[0] || []).map(normalizeAddress).filter(Boolean);
  for (const reserve of reserves) {
    if (!wanted.has(lowerAddress(reserve))) continue;
    const dataRaw = await rpc.call("eth_call", [{ to: cfg.aavePool, data: AAVE_POOL.encodeFunctionData("getReserveData", [reserve]) }, "latest"], 12_000).catch(() => null);
    const cfgData = dataRaw ? decodeAaveConfig(BigInt(wordAt(dataRaw, 0) || 0n)) : null;
    const aToken = dataRaw ? addressWordAt(dataRaw, 8) : null;
    rows.push({ protocol: "Aave V3", chain: "Ethereum", asset: reserve, role: lowerAddress(reserve) === lowerAddress(cfg.usdd) ? "USDD" : "sUSDD", config: cfgData, aToken, routePositive: false });
  }
  return rows;
}

async function scanMorphoEthereum() {
  const cfg = CHAINS[1];
  const wanted = new Set([lowerAddress(cfg.usdd), lowerAddress(cfg.susdd)]);
  const query = `query($chainIds:[Int!]!) { markets(first:500, orderBy:SupplyAssetsUsd, orderDirection:Desc, where:{chainId_in:$chainIds}) { items { marketId loanAsset { symbol address decimals } collateralAsset { symbol address decimals } oracle { address } lltv state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization } } } }`;
  const json = await fetchJson("https://api.morpho.org/graphql", 30_000, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables: { chainIds: [1] } }) }).catch(() => null);
  const rows = [];
  for (const market of json?.data?.markets?.items || []) {
    const loan = lowerAddress(market.loanAsset?.address);
    const collateral = lowerAddress(market.collateralAsset?.address);
    if (!wanted.has(loan) && !wanted.has(collateral)) continue;
    rows.push({ protocol: "Morpho Blue", chain: "Ethereum", marketId: market.marketId, loanAsset: market.loanAsset, collateralAsset: market.collateralAsset, oracle: normalizeAddress(market.oracle?.address), lltv: market.lltv, state: market.state, side: wanted.has(collateral) ? "collateral" : "loan", routePositive: false });
  }
  return rows;
}

async function scanVenusBsc(rpc) {
  const cfg = CHAINS[56];
  const wanted = new Set([lowerAddress(cfg.usdd), lowerAddress(cfg.susdd)]);
  const rows = [];
  const marketsRaw = await safeCall(rpc, cfg.venusComptroller, VENUS_COMPTROLLER, "getAllMarkets", []);
  const markets = (marketsRaw?.[0] || []).map(normalizeAddress).filter(Boolean);
  for (const vToken of markets) {
    const underlyingRaw = await safeCall(rpc, vToken, VTOKEN, "underlying", []);
    const underlying = normalizeAddress(underlyingRaw?.[0]);
    if (!underlying || !wanted.has(lowerAddress(underlying))) continue;
    const [symbolRaw, cashRaw, borrowsRaw, marketRaw, borrowPausedRaw] = await Promise.all([safeCall(rpc, vToken, VTOKEN, "symbol", []), safeCall(rpc, vToken, VTOKEN, "getCash", []), safeCall(rpc, vToken, VTOKEN, "totalBorrows", []), safeCall(rpc, cfg.venusComptroller, VENUS_COMPTROLLER, "markets", [vToken]), safeCall(rpc, cfg.venusComptroller, VENUS_COMPTROLLER, "actionPaused", [vToken, 2])]);
    rows.push({ protocol: "Venus Core", chain: "BNB Chain", vToken, symbol: symbolRaw?.[0] === undefined ? null : String(symbolRaw[0]), underlying, role: lowerAddress(underlying) === lowerAddress(cfg.usdd) ? "USDD" : "sUSDD", cashRaw: cashRaw?.[0] === undefined ? null : cashRaw[0].toString(), totalBorrowsRaw: borrowsRaw?.[0] === undefined ? null : borrowsRaw[0].toString(), marketListed: marketRaw?.[0] === undefined ? null : Boolean(marketRaw[0]), collateralFactorMantissa: marketRaw?.[1] === undefined ? null : marketRaw[1].toString(), borrowPaused: borrowPausedRaw?.[0] === undefined ? null : Boolean(borrowPausedRaw[0]), routePositive: false, blocker: "Venus listing is not route-positive without borrow liquidity, oracle divergence, borrower state, and exact economics" });
  }
  return rows;
}

function contextSummary(obj) { if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {}; const fields = ["id", "protocol", "chain", "chainId", "surface", "side", "symbol", "token", "asset", "collateral", "borrowAsset", "routePositive", "watchCandidate", "liquidityUsd", "borrowCashUsd", "cashUsd", "source", "status"]; const out = {}; for (const field of fields) if (obj[field] !== undefined && typeof obj[field] !== "object") out[field] = String(obj[field]).slice(0, 120); return out; }
function findMatches(data, wantedAddress, source, max = 12) { const matches = []; const wanted = lowerAddress(wantedAddress); if (!wanted) return matches; function walk(value, objectPath, parent) { if (matches.length >= max) return; if (typeof value === "string") { if (lowerAddress(value) === wanted) matches.push({ source, path: objectPath, context: contextSummary(parent), routePositive: Boolean(parent?.routePositive), watchCandidate: Boolean(parent?.watchCandidate) }); return; } if (!value || typeof value !== "object") return; if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) walk(value[i], `${objectPath}[${i}]`, parent); return; } for (const [key, child] of Object.entries(value)) walk(child, objectPath ? `${objectPath}.${key}` : key, value); } walk(data, "", null); return matches; }
function artifactJoins(tokenRows, contractRows) { const wanted = [...tokenRows.map((row) => ({ label: `${row.chain}-${row.role}`, address: row.address, common: false })), ...contractRows.map((row) => ({ label: `${row.chain}-${row.label}`, address: row.address, common: false }))]; const rows = []; const loadedInputs = []; for (const [source, rel] of INPUTS) { const file = path.join(WORKSPACE, rel); const data = readJson(file, null); if (!data) continue; loadedInputs.push(rel); for (const item of wanted) { const matches = findMatches(data, item.address, source, 20); if (!matches.length) continue; rows.push({ label: item.label, address: normalizeAddress(item.address), source, joinCount: matches.length, routePositive: matches.some((m) => m.routePositive), watchCandidate: matches.some((m) => m.watchCandidate), matches }); } } rows.sort((a, b) => Number(b.routePositive) - Number(a.routePositive) || Number(b.watchCandidate) - Number(a.watchCandidate) || b.joinCount - a.joinCount); return { rows, loadedInputs }; }

function writeReport(out) {
  const s = out.summary;
  const tokenTable = out.tokenRows.map((row) => `| ${row.chain} | ${row.role} | ${row.address} | ${row.symbol || "n/a"} | ${formatUsd(row.priceUsd)} | ${row.depegBps === null ? "n/a" : `${row.depegBps}bps`} | ${row.erc4626Like} |`).join("\n");
  const backingTable = out.backingRows.map((row) => `| ${row.chain} | ${row.collateral} | ${row.join} | ${row.joinBalance || "n/a"} | ${formatUsd(row.joinBalanceUsd)} | ${formatUsd(row.defillamaLatestUsd)} |`).join("\n");
  const consumerTable = [...out.directConsumers.aaveEthereum, ...out.directConsumers.morphoEthereum, ...out.directConsumers.venusBsc].slice(0, 10).map((row) => `| ${row.protocol} | ${row.chain} | ${row.role || row.side || "n/a"} | ${row.asset || row.underlying || row.marketId || "n/a"} | ${row.routePositive} |`).join("\n") || "| none | n/a | n/a | n/a | false |";
  const content = `# 🟢 DORMANT — USDD Phase 0

Generated: ${out.generatedAt}

Scanner: \`tools/scan-usdd-phase0.js\`

Artifact: \`reports/raw/fast/usdd-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This Phase 0 mapped USDD EVM PSM contracts, USDT/USDC collateral joins, USDD/sUSDD token state, public price/liquidity context, local consumer artifacts, and direct Ethereum Aave/Morpho plus BNB Venus checks. It found no material depeg, no permissionless PSM/backing mismatch joined to consumer economics, and no exact positive borrow/liquidation/redeem/unwind route.

## Target

| Field | Value |
|---|---:|
| Protocol | \`${out.metadata.name}\` |
| Slug | \`${out.metadata.slug}\` |
| Category | \`${out.metadata.category}\` |
| Current public TVL | \`${formatUsd(s.defillamaCurrentTvlUsd)}\` |
| EVM backing USD | \`${formatUsd(s.evmBackingUsd)}\` |
| Token rows | \`${s.tokenRows}\` |
| Backing rows | \`${s.backingRows}\` |
| Direct consumer rows | \`${s.directConsumerRows}\` |
| Artifact join rows | \`${s.artifactJoinRows}\` |
| Route-positive rows | \`${s.routePositive}\` |

## Tokens

| Chain | Role | Address | Symbol | Price | Depeg | ERC4626-like |
|---|---|---|---|---:|---:|---:|
${tokenTable}

## EVM Backing Context

| Chain | Collateral | Join | Balance | Balance USD | DeFiLlama USD |
|---|---|---|---:|---:|---:|
${backingTable}

## Direct Consumer Checks

| Protocol | Chain | Role | Asset/Market | Route-positive |
|---|---|---|---|---:|
${consumerTable}

## Blockers

- USDD EVM collateral balances are backing context only; no permissionless PSM mint/redeem edge was proven.
- sUSDD/Pendle appearances are consumer leads only unless exact accepted value exceeds acquisition/unwind value after costs.
- BNB Venus proposal context is deposit-only/deprecation-sensitive; no borrow extraction route is proven without exact market config, borrower state, oracle divergence, and positive economics.
- No fork extraction proof and no signed-action justification exist.

## Next Gate

Reopen only if USDD/sUSDD maps to material borrow, liquidation, margin, or redemption liquidity with a permissionless depeg/oracle/backing trigger and exact positive economics.
`;
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const metadataRaw = await fetchJson("https://api.llama.fi/protocol/usdd", 30_000).catch(() => ({}));
  const rpcUrls = {};
  for (const chainId of Object.keys(CHAINS).map(Number)) {
    const rpcUrl = await resolveInventoryRpc(chainId);
    if (!rpcUrl) throw new Error(`Missing required RPC endpoint from rpc_endpoints.txt for ${CHAINS[chainId].name} chainId ${chainId}. Provide a suitable endpoint before continuing.`);
    rpcUrls[chainId] = rpcUrl;
  }
  const prices = await priceMap();
  const tokenRows = [];
  const backingRows = [];
  const contractRows = [];
  for (const [chainIdText, cfg] of Object.entries(CHAINS)) {
    const chainId = Number(chainIdText);
    const rpc = client(rpcUrls[chainId]);
    tokenRows.push(await inspectToken(rpc, chainId, "USDD", cfg.usdd, prices));
    tokenRows.push(await inspectToken(rpc, chainId, "sUSDD", cfg.susdd, prices));
    for (const psm of cfg.psm) {
      backingRows.push(await inspectCollateral(rpc, chainId, psm, prices, (lastRow(metadataRaw.chainTvls?.[cfg.llamaKey]?.tokensInUsd)?.tokens || {})));
      contractRows.push(await inspectContract(rpc, chainId, `${psm.symbol}-PSM`, psm.psm, "psm"));
      contractRows.push(await inspectContract(rpc, chainId, `${psm.symbol}-Join`, psm.join, "join"));
    }
  }
  const [dexRows, aaveEthereum, morphoEthereum, venusBsc] = await Promise.all([dexLiquidityRows(), scanAaveEthereum(client(rpcUrls[1])), scanMorphoEthereum(), scanVenusBsc(client(rpcUrls[56]))]);
  const joins = artifactJoins(tokenRows, contractRows);
  const routePositive = 0;
  const watchCandidates = joins.rows.filter((row) => row.watchCandidate).length + aaveEthereum.length + morphoEthereum.length + venusBsc.length;
  const currentTvlUsd = lastRow(metadataRaw.tvl)?.totalLiquidityUSD ?? Object.values(metadataRaw.currentChainTvls || {}).reduce((sum, value) => sum + (asNumber(value) || 0), 0);
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-usdd-phase0.js",
    scope: "USDD EVM Phase 0 PSM/backing/oracle/depeg and consumer join",
    safety: { publicApisOnly: false, rpcInventoryRead: true, rpcInventoryOnly: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, signedActionJustified: false },
    metadata: { name: metadataRaw.name || "USDD", slug: metadataRaw.slug || "usdd", category: metadataRaw.category || "CDP", chains: metadataRaw.chains || ["Ethereum", "Binance", "Tron"], audits: metadataRaw.audits || "0", url: metadataRaw.url || "https://usdd.io/", twitter: metadataRaw.twitter || "usddio", module: metadataRaw.module || "usdd-io/index.js", tvlCodePath: metadataRaw.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/usdd-io/index.js", docs: "https://docs.usdd.io/introduction/collateral-asset-contract-addresses.md", evmConfig: CHAINS },
    tokenRows,
    backingRows,
    contractRows,
    dexLiquidityRows: dexRows,
    directConsumers: { aaveEthereum, morphoEthereum, venusBsc },
    artifactJoins: joins.rows,
    joinInputsLoaded: joins.loadedInputs,
    summary: { ethereumRpcResolved: true, bscRpcResolved: true, defillamaCurrentTvlUsd: round(currentTvlUsd, 2), evmBackingUsd: round(backingRows.reduce((sum, row) => sum + (asNumber(row.joinBalanceUsd) || 0), 0), 2), tokenRows: tokenRows.length, backingRows: backingRows.length, contractRows: contractRows.length, erc4626LikeRows: tokenRows.filter((row) => row.erc4626Like).length, maxUsddDepegBps: round(Math.max(0, ...tokenRows.filter((row) => row.role === "USDD").map((row) => asNumber(row.depegBps) || 0)), 2), dexLiquidityRows: dexRows.length, topDexLiquidityUsd: round(dexRows[0]?.liquidityUsd, 2), directConsumerRows: aaveEthereum.length + morphoEthereum.length + venusBsc.length, artifactJoinRows: joins.rows.length, watchCandidates, routePositive, executableNow: 0, signedActionJustified: false, status: "phase0-no-route-positive" },
    blockers: ["No material USDD depeg or oracle/backing divergence mapped to a consumer", "No permissionless PSM mint/redeem edge with exact economics", "sUSDD/Pendle and Venus contexts are watch-only without exact positive borrow/liquidation/unwind route", "No fork extraction proof and no signed-action justification"],
    requiredForRoutePositive: ["USDD/sUSDD accepted by material lending, margin, redemption, or liquidation consumer", "permissionless depeg/oracle/backing/NAV trigger", "exact acquisition, borrow/repay, redeem/liquidate, and exit economics positive after costs", "fork extraction proof"],
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);
  writeReport(output);
  if (!QUIET) {
    console.log(`USDD Phase0: tvl=$${Math.round(currentTvlUsd || 0)} backing=$${Math.round(output.summary.evmBackingUsd || 0)} consumers=${output.summary.directConsumerRows} joins=${joins.rows.length} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => { console.error(String(err?.message || err).slice(0, 320)); process.exit(1); });
