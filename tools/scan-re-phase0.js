#!/usr/bin/env node
// scan-re-phase0.js - bounded read-only Phase 0 for Re Protocol RWA tokens and consumers.
// RPC URLs stay in memory through shared-rpc and are never printed or stored.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");
const { resolveRpcPool, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "re-phase0.json");
const GRAPH_OUT_REL = "reports/raw/fast/re-phase0-rwa-nav-consumer-graph.json";
const GRAPH_OUT = path.join(WORKSPACE, GRAPH_OUT_REL);
const REPORT_OUT = path.join(WORKSPACE, "reports", "re-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const RE_OFFCHAIN_ORACLE_AVAX = "0xc79a363a3f849d8b3F6A1932f748eA9d4fB2f607";

const CHAINS = {
  1: { name: "Ethereum", llamaKey: "Ethereum", adapterKey: "ethereum", coinSlug: "ethereum", coreKey: "ethereum" },
  8453: { name: "Base", llamaKey: "Base", adapterKey: "base", coinSlug: "base", coreKey: "base" },
  42161: { name: "Arbitrum", llamaKey: "Arbitrum", adapterKey: "arbitrum", coinSlug: "arbitrum", coreKey: "arbitrum" },
  43114: { name: "Avalanche", llamaKey: "Avalanche", adapterKey: "avax", coinSlug: "avax", coreKey: "avax" },
};

const ADAPTER_OWNERS = {
  1: [
    ["reUSD custodial wallet", "0x295f67fdb21255a3db82964445628a706fbe689e"],
    ["reUSDe custodial wallet", "0xd4374008c88321Eb2e59ABD311156C44B25831e9"],
    ["redemptions wallet", "0x9eA38e09F41A9DE53972a68268BA0Dcc6d2fAdf8"],
    ["redemption contract", "0x5C454f5526e41fBE917b63475CD8CA7E4631B147"],
    ["reUSD adapter contract", "0x4691C475bE804Fa85f91c2D6D0aDf03114de3093"],
    ["reUSDe adapter contract", "0xE1886BE2bA8B2496c2044a77516F63a734193082"],
  ],
  8453: [
    ["reUSD custodial wallet", "0x295F67Fdb21255A3Db82964445628a706FBe689E"],
    ["redemptions wallet", "0x19aff1C007397Bdb7f82BdA18151C28AB4335896"],
    ["redemptions contract", "0x9AB62AebAbE738AB233C447eEdCE88D1D0a61FE3"],
    ["reUSD contract", "0x7D214438D0F27AfCcC23B3d1e1a53906aCE5CFEa"],
  ],
  42161: [
    ["reUSD custodial wallet", "0x295F67Fdb21255A3Db82964445628a706FBe689E"],
    ["redemptions wallet", "0xfB602cb83c9c15b4cc49340dc9aD7a8C23754BB0"],
    ["redemptions contract", "0xfd4016Ea13ca8acc04A11a99702dF076A4d3B852"],
    ["reUSD contract", "0x802eDbB1Ec20548A4388ABC337E4011718eb0291"],
  ],
  43114: [
    ["reUSD custodial wallet", "0x295F67Fdb21255A3Db82964445628a706FBe689E"],
    ["redemptions wallet", "0x4F1ff9b995472B27A6BAfEc967986F35Bf1aDaE4"],
    ["redemptions contract", "0xe13292F97E38da0C64398De5E0bFc95180DE9d23"],
    ["reUSD contract", "0xb22a8533e6cd81598f82514a42F0B3161745fbe1"],
  ],
};

const TOKEN_TARGETS = [
  { chainId: 1, role: "adapter-reUSD-contract", symbol: "reUSD-adapter", address: "0x4691C475bE804Fa85f91c2D6D0aDf03114de3093" },
  { chainId: 1, role: "adapter-reUSDe-contract", symbol: "reUSDe-adapter", address: "0xE1886BE2bA8B2496c2044a77516F63a734193082" },
  { chainId: 1, role: "liquid-reUSD-deposit-token", symbol: "reUSD", address: "0x5086bf358635B81D8C47C66d1C8b9E567Db70c72" },
  { chainId: 1, role: "liquid-reUSDe-token", symbol: "reUSDe", address: "0xdDC0f880ff6e4e22E4B74632fBb43Ce4DF6cCC5a" },
  { chainId: 8453, role: "adapter-reUSD-contract", symbol: "reUSD", address: "0x7D214438D0F27AfCcC23B3d1e1a53906aCE5CFEa" },
  { chainId: 42161, role: "adapter-reUSD-contract", symbol: "reUSD", address: "0x802eDbB1Ec20548A4388ABC337E4011718eb0291" },
  { chainId: 43114, role: "adapter-reUSD-contract", symbol: "reUSD-adapter", address: "0xb22a8533e6cd81598f82514a42F0B3161745fbe1" },
  { chainId: 43114, role: "local-silo-reUSD-token", symbol: "reUSD", address: "0x180aF87b47Bf272B2df59dccf2D76a6eaFa625Bf" },
];

const LOCAL_ARTIFACTS = [
  { protocol: "Fluid Lending", file: "reports/raw/fast/fluid-lending-phase0.json" },
  { protocol: "Fluid DEX", file: "reports/raw/fast/fluid-dex-phase0.json" },
  { protocol: "Euler V2", file: "reports/raw/fast/euler-v2-phase0.json" },
  { protocol: "Silo V2", file: "reports/raw/fast/silo-v2-phase0.json" },
  { protocol: "Curve DEX", file: "reports/raw/fast/curve-dex-phase0.json" },
  { protocol: "Velodrome V3", file: "reports/raw/fast/velodrome-v3-phase0.json" },
  { protocol: "Public Lead Consumer", file: "reports/raw/fast/public-lead-consumer-joins.json" },
  { protocol: "Current Profit Leads", file: "reports/raw/fast/current-profit-lead-triage.json" },
  { protocol: "Pendle PT", file: "reports/raw/fast/pendle-pt-multichain-consumer-graph.json" },
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
]);
const ORACLE = new ethers.Interface(["function latestAnswer() view returns (int256)"]);

const TOKEN_SET = new Set(TOKEN_TARGETS.map((row) => row.address.toLowerCase()));

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readJson(file, fallback = null) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; } catch (_) { return fallback; } }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function normalizeAddress(value) { try { return ethers.getAddress(value); } catch (_) { const text = String(value || ""); if (/^0x[0-9a-fA-F]{40}$/.test(text)) { try { return ethers.getAddress(text.toLowerCase()); } catch (_) {} } return null; } }
function lowerAddress(value) { const address = normalizeAddress(value); return address ? address.toLowerCase() : null; }
function addressFromStorageSlot(raw) { if (!raw || raw === "0x") return null; const hex = strip0x(raw).padStart(64, "0"); if (/^0+$/.test(hex)) return null; return normalizeAddress(`0x${hex.slice(-40)}`); }
function formatUnits(value, decimals) { if (value === null || value === undefined || decimals === null || decimals === undefined) return null; try { return ethers.formatUnits(BigInt(value), Number(decimals)); } catch (_) { return null; } }
function numberUnits(value, decimals) { const text = formatUnits(value, decimals); const n = Number(text); return Number.isFinite(n) ? n : null; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "boolean") return value ? 1 : 0; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const factor = 10 ** decimals; return Math.round(n * factor) / factor; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatBps(value) { const n = asNumber(value); return n === null ? "n/a" : `${round(n, 4)}bps`; }
function shortAddress(value) { const text = String(value || ""); return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${text.slice(0, 6)}...${text.slice(-4)}` : text || "n/a"; }
function latestRow(rows) { return Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null; }
function flattenResults(consumerGraph, field) { return (consumerGraph?.results || []).flatMap((row) => Array.isArray(row[field]) ? row[field] : []); }
function maxNumber(...values) { const nums = values.map(asNumber).filter((n) => n !== null); return nums.length ? Math.max(...nums) : null; }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function client(url) { return { call: (method, params = [], timeoutMs = 10_000) => rpcCall(url, method, params, timeoutMs) }; }

async function fetchJson(url, timeoutMs = 30_000, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, headers: { "user-agent": "evm-audit-re-phase0/1.0", ...(options.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}
async function getCode(rpc, address) { return await rpc.call("eth_getCode", [address, "latest"], 10_000).catch(() => "0x") || "0x"; }
async function getStorage(rpc, address, slot) { return await rpc.call("eth_getStorageAt", [address, slot, "latest"], 10_000).catch(() => null); }
async function safeCall(rpc, to, iface, fn, args = []) { try { const raw = await rpc.call("eth_call", [{ to, data: iface.encodeFunctionData(fn, args) }, "latest"], 12_000); if (!raw || raw === "0x") return null; return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; } }

async function loadCoreAssets() {
  try { return await fetchJson("https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/helper/coreAssets.json", 30_000); } catch (_) { return {}; }
}

function coreTokensForChain(coreAssets, chainId) {
  const cfg = CHAINS[chainId];
  const row = coreAssets[cfg.coreKey] || {};
  const keysByChain = {
    1: ["USDC", "sUSDe", "USDT", "USDe", "USDS"],
    8453: ["USDC", "USDe", "sUSDe", "USDT"],
    42161: ["USDC", "USDC_CIRCLE", "USDe", "sUSDe", "USDT"],
    43114: ["USDC", "USDe", "sUSDe", "USDt"],
  };
  return (keysByChain[chainId] || []).map((key) => row[key] ? { key, address: normalizeAddress(row[key]) } : null).filter((x) => x?.address);
}

async function priceMap(coreAssets) {
  const keys = [];
  for (const token of TOKEN_TARGETS) keys.push(`${CHAINS[token.chainId].coinSlug}:${token.address.toLowerCase()}`);
  for (const chainId of Object.keys(CHAINS).map(Number)) {
    for (const token of coreTokensForChain(coreAssets, chainId)) keys.push(`${CHAINS[chainId].coinSlug}:${token.address.toLowerCase()}`);
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

async function inspectOwner(rpc, chainId, label, address) {
  const normalized = normalizeAddress(address);
  const [code, implRaw, adminRaw, beaconRaw, ownerRaw, adminCallRaw, pausedRaw] = await Promise.all([
    getCode(rpc, normalized), getStorage(rpc, normalized, EIP1967_IMPLEMENTATION_SLOT), getStorage(rpc, normalized, EIP1967_ADMIN_SLOT), getStorage(rpc, normalized, EIP1967_BEACON_SLOT), safeCall(rpc, normalized, COMMON, "owner", []), safeCall(rpc, normalized, COMMON, "admin", []), safeCall(rpc, normalized, COMMON, "paused", []),
  ]);
  return { chainId, chain: CHAINS[chainId].name, label, address: normalized, codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0, eip1967: { implementation: addressFromStorageSlot(implRaw), admin: addressFromStorageSlot(adminRaw), beacon: addressFromStorageSlot(beaconRaw) }, owner: normalizeAddress(ownerRaw?.[0]) || null, admin: normalizeAddress(adminCallRaw?.[0]) || null, paused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]), routePositive: false };
}

async function inspectToken(rpc, target, prices) {
  const chain = CHAINS[target.chainId];
  const normalized = normalizeAddress(target.address);
  const [code, implRaw, adminRaw, beaconRaw, symbolRaw, nameRaw, decimalsRaw, supplyRaw, ownerRaw, pausedRaw, assetRaw, totalAssetsRaw, convertRaw] = await Promise.all([
    getCode(rpc, normalized), getStorage(rpc, normalized, EIP1967_IMPLEMENTATION_SLOT), getStorage(rpc, normalized, EIP1967_ADMIN_SLOT), getStorage(rpc, normalized, EIP1967_BEACON_SLOT), safeCall(rpc, normalized, ERC20, "symbol", []), safeCall(rpc, normalized, ERC20, "name", []), safeCall(rpc, normalized, ERC20, "decimals", []), safeCall(rpc, normalized, ERC20, "totalSupply", []), safeCall(rpc, normalized, ERC20, "owner", []), safeCall(rpc, normalized, ERC20, "paused", []), safeCall(rpc, normalized, ERC20, "asset", []), safeCall(rpc, normalized, ERC20, "totalAssets", []), safeCall(rpc, normalized, ERC20, "convertToAssets", [10n ** 18n]),
  ]);
  const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
  const priceUsd = prices.get(`${chain.coinSlug}:${normalized.toLowerCase()}`) || null;
  const totalSupply = supplyRaw?.[0] ?? null;
  const totalSupplyAmount = numberUnits(totalSupply, decimals);
  return { chainId: target.chainId, chain: chain.name, role: target.role, address: normalized, codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0, eip1967: { implementation: addressFromStorageSlot(implRaw), admin: addressFromStorageSlot(adminRaw), beacon: addressFromStorageSlot(beaconRaw) }, symbol: symbolRaw?.[0] === undefined ? target.symbol : String(symbolRaw[0]), name: nameRaw?.[0] === undefined ? null : String(nameRaw[0]), decimals, totalSupplyRaw: totalSupply?.toString() || null, totalSupply: formatUnits(totalSupply, decimals), totalSupplyUsd: round(totalSupplyAmount !== null && priceUsd ? totalSupplyAmount * priceUsd : null, 2), priceUsd: round(priceUsd, 8), priceVsParBps: round(priceUsd ? (priceUsd - 1) * 10_000 : null, 4), owner: normalizeAddress(ownerRaw?.[0]) || null, paused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]), erc4626Like: Boolean(assetRaw?.[0] || totalAssetsRaw?.[0] !== undefined || convertRaw?.[0] !== undefined), asset: normalizeAddress(assetRaw?.[0]) || null, totalAssetsRaw: totalAssetsRaw?.[0] === undefined ? null : totalAssetsRaw[0].toString(), convertToAssets1e18Raw: convertRaw?.[0] === undefined ? null : convertRaw[0].toString(), currentAnomaly: false, routePositive: false };
}

async function inspectOwnerBalances(rpc, chainId, coreAssets, prices) {
  const owners = ADAPTER_OWNERS[chainId] || [];
  const tokens = coreTokensForChain(coreAssets, chainId);
  const rows = [];
  for (const [ownerLabel, owner] of owners) {
    for (const token of tokens) {
      const [symbolRaw, nameRaw, decimalsRaw, balanceRaw] = await Promise.all([safeCall(rpc, token.address, ERC20, "symbol", []), safeCall(rpc, token.address, ERC20, "name", []), safeCall(rpc, token.address, ERC20, "decimals", []), safeCall(rpc, token.address, ERC20, "balanceOf", [owner])]);
      const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
      const balance = balanceRaw?.[0] ?? null;
      const price = prices.get(`${CHAINS[chainId].coinSlug}:${token.address.toLowerCase()}`) || null;
      const amount = numberUnits(balance, decimals);
      rows.push({ chainId, chain: CHAINS[chainId].name, ownerLabel, owner: normalizeAddress(owner), tokenKey: token.key, token: token.address, symbol: symbolRaw?.[0] === undefined ? token.key : String(symbolRaw[0]), name: nameRaw?.[0] === undefined ? null : String(nameRaw[0]), decimals, balanceRaw: balance?.toString() || null, balance: formatUnits(balance, decimals), priceUsd: round(price, 8), balanceUsd: round(amount !== null && price ? amount * price : null, 2), routePositive: false });
    }
  }
  return rows;
}

async function inspectOffchainOracle(rpc) {
  const raw = await safeCall(rpc, RE_OFFCHAIN_ORACLE_AVAX, ORACLE, "latestAnswer", []);
  if (raw?.[0] === undefined) return { chainId: 43114, chain: "Avalanche", oracle: RE_OFFCHAIN_ORACLE_AVAX, latestAnswerRaw: null, offchainAssetsUsd: null, routePositive: false };
  const answer = Number(raw[0]);
  return { chainId: 43114, chain: "Avalanche", oracle: RE_OFFCHAIN_ORACLE_AVAX, latestAnswerRaw: raw[0].toString(), scale: "adapter divides by 100 into USDC raw units; scanner normalizes by USDC 1e6 decimals", offchainAssetsUsd: Number.isFinite(answer) ? round(answer / 100 / 1e6, 2) : null, routePositive: false };
}

async function fetchDexRows() {
  const addresses = [...new Set(TOKEN_TARGETS.map((row) => row.address))];
  try {
    const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${addresses.join(",")}`, 30_000);
    const wanted = new Set(addresses.map((a) => a.toLowerCase()));
    const rows = [];
    for (const pair of json.pairs || []) {
      const base = String(pair.baseToken?.address || "").toLowerCase();
      const quote = String(pair.quoteToken?.address || "").toLowerCase();
      if (!wanted.has(base) && !wanted.has(quote)) continue;
      rows.push({ chain: pair.chainId || null, dexId: pair.dexId || null, pairAddress: pair.pairAddress || null, baseSymbol: pair.baseToken?.symbol || null, quoteSymbol: pair.quoteToken?.symbol || null, liquidityUsd: round(pair.liquidity?.usd, 2), volume24hUsd: round(pair.volume?.h24, 2), priceUsd: round(pair.priceUsd, 8), routePositive: false });
    }
    return rows.sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0)).slice(0, 40);
  } catch (_) { return []; }
}

function tokenMentionsRe(value) {
  const text = String(value || "");
  if (TOKEN_SET.has(text.toLowerCase())) return true;
  return /(^|[^a-z0-9])reusd(e)?([^a-z0-9]|$)/i.test(text) || /re protocol/i.test(text);
}
function objectMentionsRe(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  for (const value of Object.values(obj)) {
    if (typeof value === "string" && tokenMentionsRe(value)) return true;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (["symbol", "name", "assetSymbol", "loanTokenName", "supplySymbol", "borrowSymbol", "symbolPair", "tokenName", "tokenSymbol", "poolSymbol"].some((k) => tokenMentionsRe(value[k]))) return true;
    }
  }
  return false;
}
function rowish(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  return Boolean(obj.label || obj.name || obj.market || obj.assetSymbol || obj.supplySymbol || obj.loanTokenName || obj.vaultSymbol || obj.symbol || obj.asset || obj.address || obj.tokenName || obj.poolSymbol || obj.poolTvlUsd !== undefined || obj.topDexLiquidityUsd !== undefined || obj.tokenBalanceUsd !== undefined);
}
function collectObjects(root, limit = 220) {
  const rows = [];
  const seen = new Set();
  function walk(value) {
    if (rows.length >= limit || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (rowish(value) && objectMentionsRe(value)) {
      const key = JSON.stringify([value.chainId || value.chain || value.chainName || "", value.address || value.vault || value.silo || value.pool || value.marketId || value.name || value.label || value.vaultSymbol || value.poolSymbol || "", value.asset || value.token || value.token0 || value.token1 || value.symbol || value.assetSymbol || ""]).slice(0, 700);
      if (!seen.has(key)) { seen.add(key); rows.push(value); }
    }
    for (const child of Object.values(value)) walk(child);
  }
  walk(root);
  return rows;
}
function inferChain(obj) { return obj.chainName || obj.chain || (obj.chainId === 1 || obj.chainId === "1" ? "Ethereum" : obj.chainId === 8453 || obj.chainId === "8453" ? "Base" : obj.chainId === 42161 || obj.chainId === "42161" ? "Arbitrum" : obj.chainId === 43114 || obj.chainId === "43114" ? "Avalanche" : obj.chainId === 57073 || obj.chainId === "57073" ? "Ink" : "n/a"); }
function labelValue(value) { if (value === null || value === undefined) return null; if (typeof value === "string" || typeof value === "number") return String(value); if (typeof value === "object") return value.symbol || value.name || value.label || value.poolSymbol || value.address || null; return null; }
function inferLabel(obj) { return labelValue(obj.label) || labelValue(obj.name) || labelValue(obj.vaultSymbol) || labelValue(obj.market) || labelValue(obj.poolSymbol) || labelValue(obj.symbolPair) || labelValue(obj.symbol) || labelValue(obj.assetSymbol) || labelValue(obj.tokenSymbol) || labelValue(obj.vaultLabel) || "Re row"; }
function inferSide(obj) { if (tokenMentionsRe(obj.borrowSymbol) || tokenMentionsRe(obj.loanTokenName)) return "borrow-or-loan"; if (tokenMentionsRe(obj.symbolPair) || tokenMentionsRe(obj.poolSymbol) || tokenMentionsRe(obj.label)) return "pool-or-pair"; return "collateral-or-asset"; }
function inferLtv(obj) { if (obj.collateralFactorBps !== undefined || obj.liquidationThresholdBps !== undefined) return `${round((asNumber(obj.collateralFactorBps) || 0) / 100, 2)}% / ${round((asNumber(obj.liquidationThresholdBps) || 0) / 100, 2)}%`; if (obj.maxLtv !== undefined || obj.lt !== undefined) return `${round((asNumber(obj.maxLtv) || 0) * 100, 2)}% / ${round((asNumber(obj.lt) || 0) * 100, 2)}%`; if (obj.maxLtvBorrowBps !== undefined || obj.ltvBorrowBps !== undefined) return `${round((asNumber(obj.maxLtvBorrowBps ?? obj.ltvBorrowBps) || 0) / 100, 2)}%`; return "n/a"; }
function inferAnomalyBps(obj) { return maxNumber(obj.externalDivergenceBps, obj.oracleOperateVsLiquidateDivergenceBps, obj.priceVsReferenceBps, obj.oracleVsDexBps, obj.navMarketDivergencePct === undefined ? null : asNumber(obj.navMarketDivergencePct) * 100); }
function inferBlocker(obj) { if (obj.blocker) return obj.blocker; if (obj.routePositive === false) return "source artifact marks this Re row route-negative"; if (obj.watchCandidate === false) return "source artifact does not classify this Re row as a watch candidate"; return "context row only; exact accepted-value, acquisition, borrow/liquidation/redemption, and unwind economics are not proven"; }
function toLocalRow(source, obj) {
  return { sourceArtifact: source.file, protocol: source.protocol, chain: inferChain(obj), label: inferLabel(obj), side: inferSide(obj), ltv: inferLtv(obj), routeLiquidityUsd: round(maxNumber(obj.borrowableUsd, obj.marketBaseCashUsd, obj.cashUsd, obj.borrowLiquidityUsd, obj.liquidityUsd), 2), contextUsd: round(maxNumber(obj.totalSupplyUsd, obj.totalAssetsUsd, obj.tokenBalanceUsd, obj.balanceUsd, obj.knownOwnerBalanceUsd, obj.totalTvlUsd, obj.poolTvlUsd, obj.usdTotal, obj.topDexLiquidityUsd), 2), anomalyBps: round(inferAnomalyBps(obj), 4), routePositive: Boolean(obj.routePositive), watchCandidate: Boolean(obj.watchCandidate || false), blocker: inferBlocker(obj) };
}
function collectLocalArtifactRows() {
  const rows = [];
  for (const source of LOCAL_ARTIFACTS) {
    const json = readJson(path.join(WORKSPACE, source.file), null);
    if (!json) continue;
    rows.push(...collectObjects(json).map((obj) => toLocalRow(source, obj)));
  }
  const seen = new Set();
  return rows.filter((row) => { const key = `${row.protocol}:${row.chain}:${row.label}:${row.side}`.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }).sort((a, b) => Number(b.routePositive) - Number(a.routePositive) || (asNumber(b.routeLiquidityUsd) || 0) - (asNumber(a.routeLiquidityUsd) || 0) || (asNumber(b.contextUsd) || 0) - (asNumber(a.contextUsd) || 0));
}

function runConsumerGraph() {
  ensureDir(GRAPH_OUT);
  const child = spawnSync(process.execPath, ["scan-rwa-nav-consumer-graph.js"], {
    cwd: __dirname,
    env: { ...process.env, RWA_NAV_PROTOCOL_FILTER: "Re Protocol", RWA_NAV_CHAIN_IDS: "1,8453,42161,43114", RWA_NAV_MAX_EULER_VAULTS: process.env.RWA_NAV_MAX_EULER_VAULTS || "350", RWA_NAV_MAX_SILO_IDS: process.env.RWA_NAV_MAX_SILO_IDS || "350", RWA_NAV_MORPHO_TOP_N: process.env.RWA_NAV_MORPHO_TOP_N || "200", RWA_NAV_OUT: GRAPH_OUT_REL },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(`${child.stderr || child.stdout || "RWA/NAV child scanner failed"}`.slice(0, 1000));
  if (!QUIET && child.stdout) process.stdout.write(child.stdout);
  return readJson(GRAPH_OUT, null);
}

async function inspectChain(chainId, rpcUrl, coreAssets, prices) {
  const rpc = client(rpcUrl);
  const ownerRows = [];
  for (const [label, address] of ADAPTER_OWNERS[chainId] || []) ownerRows.push(await inspectOwner(rpc, chainId, label, address));
  const tokenRows = [];
  for (const target of TOKEN_TARGETS.filter((row) => row.chainId === chainId)) tokenRows.push(await inspectToken(rpc, target, prices));
  const custodyBalanceRows = await inspectOwnerBalances(rpc, chainId, coreAssets, prices);
  return { chainId, chain: CHAINS[chainId].name, rpcResolved: true, ownerRows, tokenRows, custodyBalanceRows };
}

function writeReport(out) {
  const s = out.summary;
  const tokenTable = out.tokenRows.map((row) => `| ${row.chain} | ${row.role} | ${shortAddress(row.address)} | ${row.codePresent} | ${row.symbol || "n/a"} | ${row.totalSupply || "n/a"} | ${formatUsd(row.totalSupplyUsd)} | ${formatUsd(row.priceUsd)} | ${formatBps(row.priceVsParBps)} | ${row.erc4626Like} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const ownerTable = out.ownerRows.slice(0, 18).map((row) => `| ${row.chain} | ${row.label} | ${shortAddress(row.address)} | ${row.codePresent} | ${shortAddress(row.eip1967?.implementation)} | ${row.paused ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";
  const balanceTable = out.custodyBalanceRows.filter((row) => (asNumber(row.balanceUsd) || 0) >= 1).slice(0, 18).map((row) => `| ${row.chain} | ${row.ownerLabel} | ${row.symbol || row.tokenKey} | ${row.balance || "0"} | ${formatUsd(row.balanceUsd)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a |";
  const matchTable = out.topMatches.slice(0, 12).map((row) => `| ${row.protocol} | ${row.side} | ${row.producer?.chain || "n/a"} | ${row.producer?.symbol || "?"} | ${row.reviewCandidate} | ${row.watchCandidate} | ${formatUsd(row.market?.otherReserveCashUsd ?? row.market?.cashUsd ?? row.market?.baseCashUsd ?? row.market?.liquidityAssetsUsd ?? row.market?.oppositeLiquidityUsd)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const localTable = out.localArtifactRows.slice(0, 18).map((row) => `| ${row.protocol} | ${row.chain} | ${row.label} | ${row.side} | ${row.ltv} | ${formatUsd(row.routeLiquidityUsd)} | ${formatUsd(row.contextUsd)} | ${formatBps(row.anomalyBps)} | ${row.routePositive} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const dexTable = out.dexLiquidityRows.slice(0, 12).map((row) => `| ${row.chain} | ${row.dexId || "n/a"} | ${row.baseSymbol || "?"}/${row.quoteSymbol || "?"} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.volume24hUsd)} | ${row.priceUsd ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";
  const content = `# 🟢 DORMANT — Re Phase 0 Triage

Generated: ${out.generatedAt}

Scanner: \`tools/scan-re-phase0.js\`

Artifact: \`reports/raw/fast/re-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This pass resolved the public Re adapter model, custody/redemption owners, Re token contracts, the Avalanche off-chain asset oracle, public DEX context, the generic RWA/NAV consumer graph, and local Fluid/Euler/Silo/Curve/Pendle artifact joins. Existing Re rows are material context, but none combine attacker-favorable accepted-value divergence with exact acquisition, borrow/liquidation/redemption, exit liquidity, and fork proof.

## Summary

| Metric | Value |
|---|---:|
| DeFiLlama TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Ethereum TVL | ${formatUsd(s.ethereumTvlUsd)} |
| Base TVL | ${formatUsd(s.baseTvlUsd)} |
| Arbitrum TVL | ${formatUsd(s.arbitrumTvlUsd)} |
| Avalanche TVL | ${formatUsd(s.avalancheTvlUsd)} |
| Token rows | \`${s.tokenRows}\` |
| Token rows with code | \`${s.tokenRowsWithCode}\` |
| Owner rows with code | \`${s.ownerRowsWithCode}/${s.ownerRows}\` |
| Custody balance rows | \`${s.custodyBalanceRows}\` |
| Material custody balance rows | \`${s.materialCustodyBalanceRows}\` |
| Tracked custody/reserve balances | ${formatUsd(s.trackedCustodyBalanceUsd)} |
| Off-chain oracle assets | ${formatUsd(s.offchainOracleUsd)} |
| Generic consumer matches | \`${s.matches}\` |
| Local artifact Re rows | \`${s.localArtifactRows}\` |
| Fluid rows | \`${s.fluidReRows}\` |
| Euler rows | \`${s.eulerReRows}\` |
| Silo rows | \`${s.siloReRows}\` |
| Curve rows | \`${s.curveReRows}\` |
| Pendle/public lead rows | \`${s.pendleReRows}\` |
| Review candidates | \`${s.reviewCandidates}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Top DEX liquidity | ${formatUsd(s.topDexLiquidityUsd)} |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |

## Token Rows

| Chain | Role | Token | Code | Symbol | Total supply | Supply USD | Public price | Price vs $1 | ERC4626-like |
|---|---|---|---:|---|---:|---:|---:|---:|---:|
${tokenTable}

## Adapter Owners

| Chain | Label | Address | Code | EIP1967 impl | Paused |
|---|---|---|---:|---|---:|
${ownerTable}

## Custody / Reserve Balances

| Chain | Owner | Token | Balance | USD |
|---|---|---|---:|---:|
${balanceTable}

## Generic Consumer Matches

| Protocol | Side | Producer chain | Symbol | Review | Watch | Route-side liquidity |
|---|---|---|---|---:|---:|---:|
${matchTable}

## Local Artifact Joins

| Protocol | Chain | Label | Side | LTV | Route liquidity | Context USD | Anomaly | Route-positive |
|---|---|---|---|---:|---:|---:|---:|---:|
${localTable}

## DEX Context

| Chain | DEX | Pair | Liquidity USD | 24h volume USD | Price USD |
|---|---|---|---:|---:|---:|
${dexTable}

## Blockers

- Re issuance, custody, off-chain asset accounting, and redemption remain treated as permissioned/restricted absent public atomic exit proof.
- No ERC4626 NAV interface or current NAV/reference anomaly is resolved for the exact Re token rows.
- Pendle, Fluid, Euler, Silo, Curve, and public DEX rows are context-only or source-classified route-negative.
- No material lending/liquidation consumer currently has attacker-favorable accepted-value divergence plus exact positive acquisition/borrow/unwind economics.
- No fork extraction proof and no signed-action justification exist.

## Required For Route-Positive

- Re token accepted by a material lending, margin, redemption, or liquidation consumer.
- Permissionless NAV/oracle/backing/accepted-value divergence or current liquidatable borrower condition.
- Exact acquisition, borrow/repay, redeem/liquidate, and exit economics positive after costs and permission constraints.
- Fork extraction proof.

## Next Read-Only Step

Keep Re on RWA/NAV, Pendle PT, Fluid DEX/Lending, Euler, Silo, and Curve watch. Reopen for exact quoting only if a material borrower becomes liquidatable, a trusted accepted-value divergence clears the haircut, or a permissionless redemption/DEX exit becomes exact-positive after costs.
`;
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const chainIds = Object.keys(CHAINS).map(Number);
  const consumerGraph = runConsumerGraph();
  const [metadataRaw, coreAssets, rpcs, dexLiquidityRows] = await Promise.all([
    fetchJson("https://api.llama.fi/protocol/re", 45_000).catch(() => ({})),
    loadCoreAssets(),
    resolveRpcPool(chainIds),
    fetchDexRows(),
  ]);
  const prices = await priceMap(coreAssets);
  const chainResults = [];
  for (const chainId of chainIds) {
    if (!rpcs[chainId]) { chainResults.push({ chainId, chain: CHAINS[chainId].name, rpcResolved: false, ownerRows: [], tokenRows: [], custodyBalanceRows: [] }); continue; }
    chainResults.push(await inspectChain(chainId, rpcs[chainId], coreAssets, prices));
  }
  const avaxRpc = rpcs[43114] ? client(rpcs[43114]) : null;
  const offchainOracle = avaxRpc ? await inspectOffchainOracle(avaxRpc) : { chainId: 43114, chain: "Avalanche", oracle: RE_OFFCHAIN_ORACLE_AVAX, latestAnswerRaw: null, offchainAssetsUsd: null, routePositive: false };
  const localArtifactRows = collectLocalArtifactRows();
  const tokenRows = chainResults.flatMap((row) => row.tokenRows);
  const ownerRows = chainResults.flatMap((row) => row.ownerRows);
  const custodyBalanceRows = chainResults.flatMap((row) => row.custodyBalanceRows);
  const topMatches = flattenResults(consumerGraph, "topMatches");
  const graphTokenRows = flattenResults(consumerGraph, "topProducers");
  const latestTvl = latestRow(metadataRaw.tvl)?.totalLiquidityUSD ?? Object.values(metadataRaw.currentChainTvls || {}).reduce((sum, value) => sum + (asNumber(value) || 0), 0);
  const graphWatchCandidates = asNumber(consumerGraph?.summary?.watchCandidates) || 0;
  const routePositive = (asNumber(consumerGraph?.summary?.routePositive) || 0) + localArtifactRows.filter((row) => row.routePositive).length;
  const watchCandidates = graphWatchCandidates + localArtifactRows.filter((row) => row.routePositive || (row.watchCandidate && Math.abs(asNumber(row.anomalyBps) || 0) >= 100 && (asNumber(row.routeLiquidityUsd) || 0) >= 10_000)).length;
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-re-phase0.js",
    scope: "Re public Phase 0 custody/reserve/off-chain oracle, token, consumer graph, local artifact joins, and exit-liquidity triage",
    safety: { publicApisOnly: false, rpcInventoryRead: true, rpcInventoryOnly: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: routePositive > 0, signedActionJustified: false },
    metadata: { name: metadataRaw.name || "Re", slug: metadataRaw.slug || "re", category: metadataRaw.category || "RWA", chains: metadataRaw.chains || ["Ethereum", "Base", "Arbitrum", "Avalanche"], module: metadataRaw.module || "re-protocol/index.js", tvlCodePath: metadataRaw.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/re-protocol/index.js", methodology: metadataRaw.methodology || null },
    chainResults,
    ownerRows,
    tokenRows,
    graphTokenRows,
    custodyBalanceRows,
    offchainOracle,
    dexLiquidityRows,
    topMatches,
    localArtifactRows,
    consumerGraph,
    summary: {
      defillamaCurrentTvlUsd: round(latestTvl, 2),
      ethereumTvlUsd: round(metadataRaw.currentChainTvls?.Ethereum ?? latestRow(metadataRaw.chainTvls?.Ethereum?.tvl)?.totalLiquidityUSD, 2),
      baseTvlUsd: round(metadataRaw.currentChainTvls?.Base ?? latestRow(metadataRaw.chainTvls?.Base?.tvl)?.totalLiquidityUSD, 2),
      arbitrumTvlUsd: round(metadataRaw.currentChainTvls?.Arbitrum ?? latestRow(metadataRaw.chainTvls?.Arbitrum?.tvl)?.totalLiquidityUSD, 2),
      avalancheTvlUsd: round(metadataRaw.currentChainTvls?.Avalanche ?? latestRow(metadataRaw.chainTvls?.Avalanche?.tvl)?.totalLiquidityUSD, 2),
      chainsWithRpc: chainResults.filter((row) => row.rpcResolved).length,
      tokenRows: tokenRows.length,
      tokenRowsWithCode: tokenRows.filter((row) => row.codePresent).length,
      graphTokenRows: graphTokenRows.length,
      ownerRows: ownerRows.length,
      ownerRowsWithCode: ownerRows.filter((row) => row.codePresent).length,
      custodyBalanceRows: custodyBalanceRows.length,
      materialCustodyBalanceRows: custodyBalanceRows.filter((row) => (asNumber(row.balanceUsd) || 0) >= 10_000).length,
      trackedCustodyBalanceUsd: round(custodyBalanceRows.reduce((sum, row) => sum + (asNumber(row.balanceUsd) || 0), 0), 2),
      offchainOracleUsd: round(offchainOracle.offchainAssetsUsd, 2),
      matches: asNumber(consumerGraph?.summary?.matches) || 0,
      localArtifactRows: localArtifactRows.length,
      fluidReRows: localArtifactRows.filter((row) => row.protocol === "Fluid Lending" || row.protocol === "Fluid DEX").length,
      eulerReRows: localArtifactRows.filter((row) => row.protocol === "Euler V2").length,
      siloReRows: localArtifactRows.filter((row) => row.protocol === "Silo V2").length,
      curveReRows: localArtifactRows.filter((row) => row.protocol === "Curve DEX").length,
      pendleReRows: localArtifactRows.filter((row) => row.protocol === "Pendle PT" || row.protocol === "Public Lead Consumer" || row.protocol === "Current Profit Leads").length,
      reviewCandidates: (asNumber(consumerGraph?.summary?.reviewCandidates) || 0) + localArtifactRows.filter((row) => (asNumber(row.routeLiquidityUsd) || 0) >= 10_000 || (asNumber(row.contextUsd) || 0) >= 10_000).length,
      watchCandidates,
      dexLiquidityRows: dexLiquidityRows.length,
      topDexLiquidityUsd: round(dexLiquidityRows[0]?.liquidityUsd, 2),
      routePositive,
      executableNow: false,
      signedActionJustified: false,
      coverageClassification: "bounded-with-caveats",
      status: routePositive > 0 ? "re-route-positive-needs-proof" : watchCandidates > 0 ? "re-watch-needs-nav-consumer-economics" : "re-phase0-no-route-positive",
    },
    blockers: ["No Re consumer-side borrow/liquidation/redeem route with current accepted-value divergence and material exact-positive economics was found", "No ERC4626 NAV reference or current NAV/reference divergence above threshold was resolved for exact Re token rows", "Custody/redemption/off-chain asset accounting is permissioned context unless a public atomic exit is proven", "Fluid, Euler, Silo, Curve, Pendle, and public DEX rows are context-only or route-negative in source artifacts", "No fork extraction proof and no signed-action justification"],
    requiredForRoutePositive: ["Re token accepted by a material lending, margin, redemption, or liquidation consumer", "permissionless NAV/oracle/backing/accepted-value divergence or current liquidatable borrower condition", "exact acquisition, borrow/repay, redeem/liquidate, and exit economics positive after costs", "fork extraction proof"],
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);
  writeReport(output);
  if (!QUIET) {
    console.log(`Re Phase0: tvl=${formatUsd(output.summary.defillamaCurrentTvlUsd)} tokens=${output.summary.tokenRows} graphMatches=${output.summary.matches} localRows=${output.summary.localArtifactRows} watch=${watchCandidates} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => { console.error(String(err?.message || err).slice(0, 1000)); process.exit(1); });
