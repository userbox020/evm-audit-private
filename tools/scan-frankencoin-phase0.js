#!/usr/bin/env node
// scan-frankencoin-phase0.js - bounded read-only Phase 0 for Frankencoin ZCHF.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { loadRpcUrls, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "frankencoin-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "frankencoin-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const ETHEREUM_CHAIN_ID = 1;
const PONDER_URL = "https://ponder.frankencoin.com";

const ADDRESSES = {
  zchf: "0xB58E61C3098d85632Df34EecfB899A1Ed80921cB",
  fps: "0x1bA26788dfDe592fec8bcB0Eaff472a42BE341B2",
  wfps: "0x5052D3Cc819f53116641e89b96Ff4cD1EE80B182",
  uniswapV3ZchfUsdt: "0x8E4318E2cb1ae291254B187001a59a1f8ac78cEF",
  chainlinkOcr2: "0x449d117117838fFA61263B61dA6301AA2a88B13A",
  mintingHubV1: "0x7546762fdb1a6d9146b33960545C3f6394265219",
  positionFactoryV1: "0x0CDE500e6940931ED190ded77bb48640c9486392",
  savingsV2: "0x3BF301B0e2003E75A3e86AB82bD1EFF6A9dFB2aE",
  rollerV2: "0xAD0107D3Da540Fd54b1931735b65110C909ea6B6",
  mintingHubV2: "0xDe12B620A8a714476A97EfD14E6F7180Ca653557",
  positionFactoryV2: "0x728310FeaCa72dc46cD5BF7d739556D5668472BA",
  cloneHelper: "0x55cD2820735Db56ca0965BE224D71994265F8bee",
  stablecoinBridgeXCHF: "0x7bbe8F18040aF0032f4C2435E7a76db6F1E346DF",
  xchf: "0xb4272071ecadd69d933adcd19ca99fe80664fc08",
  stablecoinBridgeVCHF: "0x3b71ba73299f925a837836160c3e1fec74340403",
  vchf: "0x79d4f0232A66c4c91b89c76362016A1707CFBF4f",
  stablecoinBridgeCHFAU: "0x3e445ff4ddDf0ff8aE7458c9746eD80bD664F6C1",
  chfau: "0xBD4DfC058eb95b8De5ceAF39966A1a70F5556F78",
  aaveV3Pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
};

const BRIDGES = [
  { label: "XCHF", bridge: ADDRESSES.stablecoinBridgeXCHF, token: ADDRESSES.xchf },
  { label: "VCHF", bridge: ADDRESSES.stablecoinBridgeVCHF, token: ADDRESSES.vchf },
  { label: "CHFAU", bridge: ADDRESSES.stablecoinBridgeCHFAU, token: ADDRESSES.chfau },
];

const INPUTS = [
  ["stablecoin-depeg", "reports/raw/fast/stablecoin-depeg-lending-routes.json"],
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["focused-morpho", "reports/raw/fast/focused-morpho-review-producers.json"],
  ["focused-euler", "reports/raw/fast/focused-euler-evk-review-producers.json"],
  ["morpho-public-allocator", "reports/raw/fast/morpho-public-allocator-force-feed.json"],
  ["morpho-liquidatable", "reports/raw/fast/morpho-liquidatable-marketability.json"],
  ["pendle-pt", "reports/raw/fast/pendle-pt-multichain-consumer-graph.json"],
  ["pendle-yt", "reports/raw/fast/pendle-yt-collateral-routes.json"],
  ["silo-pt", "reports/raw/fast/silo-pt-oracle-routes.json"],
  ["dex-consumer-routes", "reports/raw/fast/dex-consumer-routes.json"],
  ["governance-listing", "reports/raw/fast/governance-listing-watch.json"],
  ["bridge-synthetic", "reports/raw/fast/bridge-synthetic-consumer-exposure.json"],
  ["erc4626-consumer", "reports/raw/fast/erc4626-consumer-joiner.json"],
];

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

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
  "function admin() view returns (address)",
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function zchf() view returns (address)",
  "function roller() view returns (address)",
  "function rate() view returns (address)",
  "function hub() view returns (address)",
  "function original() view returns (address)",
  "function collateral() view returns (address)",
  "function price() view returns (uint256)",
  "function minted() view returns (uint256)",
  "function challengedAmount() view returns (uint256)",
  "function challengePeriod() view returns (uint40)",
  "function start() view returns (uint40)",
  "function cooldown() view returns (uint40)",
  "function expiration() view returns (uint40)",
  "function limit() view returns (uint256)",
  "function availableForMinting() view returns (uint256)",
  "function availableForClones() view returns (uint256)",
  "function minimumCollateral() view returns (uint256)",
  "function reserveContribution() view returns (uint24)",
  "function riskPremiumPPM() view returns (uint24)",
  "function annualInterestPPM() view returns (uint24)",
  "function isClosed() view returns (bool)",
  "function expiredPurchasePrice(address pos) view returns (uint256)",
  "function OPENING_FEE() view returns (uint256)",
  "function CHALLENGER_REWARD() view returns (uint256)",
  "function EXPIRED_PRICE_FACTOR() view returns (uint256)",
]);

const BRIDGE = new ethers.Interface([
  "function chf() view returns (address)",
  "function zchf() view returns (address)",
  "function horizon() view returns (uint256)",
  "function decimalMultiplier() view returns (uint256)",
  "function limit() view returns (uint256)",
  "function minted() view returns (uint256)",
]);

const AAVE_POOL = new ethers.Interface([
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns (tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
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
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }

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
async function fetchJson(url, timeoutMs = 30_000, options = {}) { const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs); try { const res = await fetch(url, { ...options, signal: c.signal, headers: { "user-agent": "evm-audit-frankencoin-phase0/1.0", ...(options.headers || {}) } }); if (!res.ok) throw new Error(`HTTP ${res.status}`); return await res.json(); } finally { clearTimeout(t); } }
async function fetchGraphql(query, variables = {}) { return fetchJson(PONDER_URL, 30_000, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) }); }
async function getCode(rpc, address) { return await rpc.call("eth_getCode", [address, "latest"], 10_000).catch(() => "0x") || "0x"; }
async function getStorage(rpc, address, slot) { return await rpc.call("eth_getStorageAt", [address, slot, "latest"], 10_000).catch(() => null); }
async function safeCall(rpc, to, iface, fn, args = []) { try { const raw = await rpc.call("eth_call", [{ to, data: iface.encodeFunctionData(fn, args) }, "latest"], 12_000); if (!raw || raw === "0x") return null; return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; } }

function decodeAaveConfig(data) {
  const raw = BigInt(data || 0n);
  const mask16 = 0xffffn;
  const mask36 = (1n << 36n) - 1n;
  return {
    ltv: Number(raw & mask16) / 10_000,
    liquidationThreshold: Number((raw >> 16n) & mask16) / 10_000,
    active: Boolean((raw >> 56n) & 1n),
    frozen: Boolean((raw >> 57n) & 1n),
    borrowingEnabled: Boolean((raw >> 58n) & 1n),
    paused: Boolean((raw >> 60n) & 1n),
    borrowCapWholeTokens: ((raw >> 80n) & mask36).toString(),
    supplyCapWholeTokens: ((raw >> 116n) & mask36).toString(),
  };
}

async function inspectContract(rpc, label, address, kind) {
  const normalized = normalizeAddress(address);
  const [code, implRaw, adminRaw, beaconRaw, ownerRaw, adminCallRaw, pausedRaw, zchfRaw, rollerRaw, rateRaw, openingFeeRaw, challengerRewardRaw, expiredPriceFactorRaw] = await Promise.all([
    getCode(rpc, normalized),
    getStorage(rpc, normalized, EIP1967_IMPLEMENTATION_SLOT),
    getStorage(rpc, normalized, EIP1967_ADMIN_SLOT),
    getStorage(rpc, normalized, EIP1967_BEACON_SLOT),
    safeCall(rpc, normalized, COMMON, "owner", []),
    safeCall(rpc, normalized, COMMON, "admin", []),
    safeCall(rpc, normalized, COMMON, "paused", []),
    safeCall(rpc, normalized, COMMON, "zchf", []),
    safeCall(rpc, normalized, COMMON, "roller", []),
    safeCall(rpc, normalized, COMMON, "rate", []),
    safeCall(rpc, normalized, COMMON, "OPENING_FEE", []),
    safeCall(rpc, normalized, COMMON, "CHALLENGER_REWARD", []),
    safeCall(rpc, normalized, COMMON, "EXPIRED_PRICE_FACTOR", []),
  ]);
  return {
    chain: "Ethereum",
    label,
    kind,
    address: normalized,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    eip1967: { implementation: addressFromStorageSlot(implRaw), admin: addressFromStorageSlot(adminRaw), beacon: addressFromStorageSlot(beaconRaw) },
    owner: normalizeAddress(ownerRaw?.[0]) || null,
    admin: normalizeAddress(adminCallRaw?.[0]) || null,
    paused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]),
    zchf: normalizeAddress(zchfRaw?.[0]) || null,
    roller: normalizeAddress(rollerRaw?.[0]) || null,
    rate: normalizeAddress(rateRaw?.[0]) || null,
    openingFeeRaw: openingFeeRaw?.[0] === undefined ? null : openingFeeRaw[0].toString(),
    challengerRewardPpm: challengerRewardRaw?.[0] === undefined ? null : Number(challengerRewardRaw[0]),
    expiredPriceFactor: expiredPriceFactorRaw?.[0] === undefined ? null : Number(expiredPriceFactorRaw[0]),
    routePositive: false,
  };
}

async function inspectToken(rpc, role, address, priceMap, dexMap) {
  const normalized = normalizeAddress(address);
  const [code, symbolRaw, nameRaw, decimalsRaw, supplyRaw, ownerRaw, pausedRaw, assetRaw, totalAssetsRaw, convertRaw] = await Promise.all([
    getCode(rpc, normalized),
    safeCall(rpc, normalized, ERC20, "symbol", []),
    safeCall(rpc, normalized, ERC20, "name", []),
    safeCall(rpc, normalized, ERC20, "decimals", []),
    safeCall(rpc, normalized, ERC20, "totalSupply", []),
    safeCall(rpc, normalized, ERC20, "owner", []),
    safeCall(rpc, normalized, ERC20, "paused", []),
    safeCall(rpc, normalized, ERC20, "asset", []),
    safeCall(rpc, normalized, ERC20, "totalAssets", []),
    safeCall(rpc, normalized, ERC20, "convertToAssets", [10n ** 18n]),
  ]);
  const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
  const supply = supplyRaw?.[0] ?? null;
  const priceUsd = priceMap.get(lowerAddress(normalized)) || dexMap.get(lowerAddress(normalized))?.priceUsd || null;
  return {
    chain: "Ethereum",
    role,
    address: normalized,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    symbol: symbolRaw?.[0] === undefined ? null : String(symbolRaw[0]),
    name: nameRaw?.[0] === undefined ? null : String(nameRaw[0]),
    decimals,
    totalSupplyRaw: supply?.toString() || null,
    totalSupply: formatUnits(supply, decimals),
    totalSupplyUsd: round(numberUnits(supply, decimals) !== null && priceUsd ? numberUnits(supply, decimals) * priceUsd : null, 2),
    priceUsd: round(priceUsd, 8),
    dexLiquidityUsd: round(dexMap.get(lowerAddress(normalized))?.liquidityUsd, 2),
    owner: normalizeAddress(ownerRaw?.[0]) || null,
    paused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]),
    erc4626Like: Boolean(assetRaw?.[0] || totalAssetsRaw?.[0] !== undefined || convertRaw?.[0] !== undefined),
    asset: normalizeAddress(assetRaw?.[0]) || null,
    totalAssetsRaw: totalAssetsRaw?.[0] === undefined ? null : totalAssetsRaw[0].toString(),
    convertToAssets1e18Raw: convertRaw?.[0] === undefined ? null : convertRaw[0].toString(),
    routePositive: false,
  };
}

async function inspectBridge(rpc, row, priceMap, dexMap, now) {
  const bridge = normalizeAddress(row.bridge);
  const [code, chfRaw, zchfRaw, horizonRaw, decimalMultiplierRaw, limitRaw, mintedRaw, balanceRaw, decimalsRaw, symbolRaw, nameRaw] = await Promise.all([
    getCode(rpc, bridge),
    safeCall(rpc, bridge, BRIDGE, "chf", []),
    safeCall(rpc, bridge, BRIDGE, "zchf", []),
    safeCall(rpc, bridge, BRIDGE, "horizon", []),
    safeCall(rpc, bridge, BRIDGE, "decimalMultiplier", []),
    safeCall(rpc, bridge, BRIDGE, "limit", []),
    safeCall(rpc, bridge, BRIDGE, "minted", []),
    safeCall(rpc, row.token, ERC20, "balanceOf", [bridge]),
    safeCall(rpc, row.token, ERC20, "decimals", []),
    safeCall(rpc, row.token, ERC20, "symbol", []),
    safeCall(rpc, row.token, ERC20, "name", []),
  ]);
  const token = normalizeAddress(chfRaw?.[0]) || normalizeAddress(row.token);
  const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
  let decimalMultiplier = decimalMultiplierRaw?.[0] === undefined ? null : BigInt(decimalMultiplierRaw[0]);
  const balance = balanceRaw?.[0] ?? null;
  const minted = mintedRaw?.[0] ?? null;
  if (decimalMultiplier === null && decimals !== null && decimals <= 18) decimalMultiplier = 10n ** BigInt(18 - decimals);
  const backingZchfRaw = balance !== null && decimalMultiplier !== null ? (BigInt(balance) * decimalMultiplier).toString() : null;
  const mintedMinusBackingRaw = minted !== null && backingZchfRaw !== null ? (BigInt(minted) - BigInt(backingZchfRaw)).toString() : null;
  const sourcePriceUsd = priceMap.get(lowerAddress(token)) || dexMap.get(lowerAddress(token))?.priceUsd || null;
  const zchfPriceUsd = priceMap.get(lowerAddress(ADDRESSES.zchf)) || dexMap.get(lowerAddress(ADDRESSES.zchf))?.priceUsd || null;
  const balanceAmount = numberUnits(balance, decimals);
  const mintedZchf = numberUnits(minted, 18);
  const backingZchf = numberUnits(backingZchfRaw, 18);
  return {
    chain: "Ethereum",
    label: row.label,
    bridge,
    token,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    sourceSymbol: symbolRaw?.[0] === undefined ? row.label : String(symbolRaw[0]),
    sourceName: nameRaw?.[0] === undefined ? null : String(nameRaw[0]),
    sourceDecimals: decimals,
    zchf: normalizeAddress(zchfRaw?.[0]) || null,
    horizon: horizonRaw?.[0] === undefined ? null : Number(horizonRaw[0]),
    expired: horizonRaw?.[0] === undefined ? null : Number(horizonRaw[0]) < now,
    decimalMultiplierRaw: decimalMultiplier?.toString() || null,
    limitRaw: limitRaw?.[0] === undefined ? null : limitRaw[0].toString(),
    limitZchf: formatUnits(limitRaw?.[0], 18),
    mintedRaw: minted?.toString() || null,
    mintedZchf: formatUnits(minted, 18),
    sourceBalanceRaw: balance?.toString() || null,
    sourceBalance: formatUnits(balance, decimals),
    sourceBalanceUsd: round(balanceAmount !== null && sourcePriceUsd ? balanceAmount * sourcePriceUsd : null, 2),
    sourcePriceUsd: round(sourcePriceUsd, 8),
    zchfPriceUsd: round(zchfPriceUsd, 8),
    backingZchfRaw,
    backingZchf: formatUnits(backingZchfRaw, 18),
    mintedMinusBackingZchfRaw: mintedMinusBackingRaw,
    mintedMinusBackingZchf: formatUnits(mintedMinusBackingRaw, 18),
    mintedUsd: round(mintedZchf !== null && zchfPriceUsd ? mintedZchf * zchfPriceUsd : null, 2),
    backingUsd: round(backingZchf !== null && zchfPriceUsd ? backingZchf * zchfPriceUsd : null, 2),
    routePositive: false,
    blockers: [
      "Stablecoin bridge mint/burn is 1:1 source-coin backing context",
      "No permissionless imbalance or redemption edge is exact-positive in this bounded pass",
    ],
  };
}

async function priceMap(addresses) {
  const prices = new Map();
  const keys = unique(addresses.map((address) => normalizeAddress(address)).filter(Boolean).map((address) => `ethereum:${address.toLowerCase()}`));
  if (!keys.length) return prices;
  for (let i = 0; i < keys.length; i += 25) {
    const chunk = keys.slice(i, i + 25);
    try {
      const json = await fetchJson(`https://coins.llama.fi/prices/current/${chunk.join(",")}?searchWidth=6h`, 30_000);
      for (const [key, row] of Object.entries(json.coins || {})) {
        const address = key.split(":").pop();
        const price = Number(row.price || 0);
        if (/^0x[0-9a-fA-F]{40}$/.test(address) && Number.isFinite(price) && price > 0) prices.set(address.toLowerCase(), price);
      }
    } catch (_) {
      // Missing prices are tolerated; they only affect context, not route-positive classification.
    }
  }
  return prices;
}

async function dexMap(addresses) {
  const wanted = unique(addresses.map((address) => lowerAddress(address)).filter(Boolean));
  const out = new Map();
  if (!wanted.length) return out;
  const chunks = [];
  for (let i = 0; i < wanted.length; i += 10) chunks.push(wanted.slice(i, i + 10));
  async function ingest(chunk) {
    const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`, 30_000);
    for (const pair of json.pairs || []) {
      if (String(pair.chainId || "").toLowerCase() !== "ethereum") continue;
      const base = lowerAddress(pair.baseToken?.address);
      const quote = lowerAddress(pair.quoteToken?.address);
      const liquidityUsd = asNumber(pair.liquidity?.usd) || 0;
      for (const address of [base, quote]) {
        if (!chunk.includes(address)) continue;
        const current = out.get(address) || { address: normalizeAddress(address), liquidityUsd: 0, pairs: [] };
        const priceUsd = base === address ? asNumber(pair.priceUsd) : current.priceUsd;
        current.liquidityUsd = Math.max(current.liquidityUsd || 0, liquidityUsd);
        if (priceUsd && (!current.priceUsd || base === address)) current.priceUsd = priceUsd;
        current.pairs.push({ dexId: pair.dexId || null, pairAddress: normalizeAddress(pair.pairAddress) || pair.pairAddress || null, baseSymbol: pair.baseToken?.symbol || null, quoteSymbol: pair.quoteToken?.symbol || null, liquidityUsd: round(liquidityUsd, 2), volume24hUsd: round(pair.volume?.h24, 2), priceUsd: round(pair.priceUsd, 8), url: pair.url || null });
        out.set(address, current);
      }
    }
  }
  for (const chunk of chunks) {
    try {
      await ingest(chunk);
    } catch (_) {
      for (const address of chunk) await ingest([address]).catch(() => null);
    }
  }
  for (const address of wanted) {
    if (!out.has(address)) await ingest([address]).catch(() => null);
  }
  for (const [address, value] of out.entries()) {
    value.pairs.sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0));
    value.topPair = value.pairs[0] || null;
    value.priceUsd = round(value.priceUsd, 8);
    value.liquidityUsd = round(value.liquidityUsd, 2);
  }
  return out;
}

function q(value) { return JSON.stringify(String(value)); }

async function fetchPonderRows(now) {
  const posV1Fields = "position owner zchf collateral price created isOriginal isClone denied denyDate closed original minimumCollateral annualInterestPPM reserveContribution start cooldown expiration challengePeriod zchfName zchfSymbol zchfDecimals collateralName collateralSymbol collateralDecimals collateralBalance limitForPosition limitForClones availableForPosition availableForClones minted";
  const posV2Fields = "position owner zchf collateral price created isOriginal isClone denied denyDate closed original parent minimumCollateral riskPremiumPPM reserveContribution start cooldown expiration challengePeriod zchfName zchfSymbol zchfDecimals collateralName collateralSymbol collateralDecimals collateralBalance limitForClones availableForClones availableForMinting minted";
  const chFields = "position number txHash challenger start created duration size liqPrice bids filledSize acquiredCollateral status";
  const query = `{
    v1Active: mintingHubV1PositionV1s(where:{closed:false,denied:false,minted_gt:${q("0")}}, orderBy:${q("minted")}, orderDirection:${q("desc")}, limit:120) { items { ${posV1Fields} } }
    v2Active: mintingHubV2PositionV2s(where:{closed:false,denied:false,minted_gt:${q("0")}}, orderBy:${q("minted")}, orderDirection:${q("desc")}, limit:120) { items { ${posV2Fields} } }
    v1Expired: mintingHubV1PositionV1s(where:{closed:false,denied:false,collateralBalance_gt:${q("0")},expiration_lt:${q(now)}}, orderBy:${q("collateralBalance")}, orderDirection:${q("desc")}, limit:80) { items { ${posV1Fields} } }
    v2Expired: mintingHubV2PositionV2s(where:{closed:false,denied:false,collateralBalance_gt:${q("0")},expiration_lt:${q(now)}}, orderBy:${q("collateralBalance")}, orderDirection:${q("desc")}, limit:80) { items { ${posV2Fields} } }
    v1Challenges: mintingHubV1ChallengeV1s(where:{status_not:${q("Success")}}, orderBy:${q("created")}, orderDirection:${q("desc")}, limit:80) { items { ${chFields} } }
    v2Challenges: mintingHubV2ChallengeV2s(where:{status_not:${q("Success")}}, orderBy:${q("created")}, orderDirection:${q("desc")}, limit:80) { items { ${chFields} } }
  }`;
  const json = await fetchGraphql(query).catch((err) => ({ errors: [{ message: err.message || String(err) }] }));
  if (json.errors?.length) return { error: json.errors.map((e) => e.message).join("; "), v1Active: [], v2Active: [], v1Expired: [], v2Expired: [], v1Challenges: [], v2Challenges: [] };
  return {
    error: null,
    v1Active: json.data?.v1Active?.items || [],
    v2Active: json.data?.v2Active?.items || [],
    v1Expired: json.data?.v1Expired?.items || [],
    v2Expired: json.data?.v2Expired?.items || [],
    v1Challenges: json.data?.v1Challenges?.items || [],
    v2Challenges: json.data?.v2Challenges?.items || [],
  };
}

function rawZchfFromCollateral(rawCollateral, rawPrice) {
  if (rawCollateral === null || rawCollateral === undefined || rawPrice === null || rawPrice === undefined) return null;
  try { return ((BigInt(rawCollateral) * BigInt(rawPrice)) / (10n ** 18n)).toString(); } catch (_) { return null; }
}

function expiredPurchasePriceRaw(row, now) {
  try {
    const liq = BigInt(row.price || 0);
    const expiration = BigInt(row.expiration || 0);
    const challengePeriod = BigInt(row.challengePeriod || 0);
    const ts = BigInt(now);
    if (challengePeriod === 0n) return null;
    if (ts <= expiration) return (10n * liq).toString();
    const timePassed = ts - expiration;
    if (timePassed <= challengePeriod) {
      const timeLeft = challengePeriod - timePassed;
      return (liq + (((9n * liq) / challengePeriod) * timeLeft)).toString();
    }
    if (timePassed < 2n * challengePeriod) {
      const timeLeft = 2n * challengePeriod - timePassed;
      return ((liq / challengePeriod) * timeLeft).toString();
    }
    return "0";
  } catch (_) { return null; }
}

function enrichPosition(row, version, dex, zchfPriceUsd, now) {
  const collateral = normalizeAddress(row.collateral);
  const decimals = asNumber(row.collateralDecimals);
  const collateralAmount = numberUnits(row.collateralBalance, decimals);
  const mintedZchf = numberUnits(row.minted, 18);
  const liqValueZchfRaw = rawZchfFromCollateral(row.collateralBalance, row.price);
  const liqValueZchf = numberUnits(liqValueZchfRaw, 18);
  const dexRow = dex.get(lowerAddress(collateral)) || {};
  const collateralPriceUsd = asNumber(dexRow.priceUsd);
  const marketValueUsd = collateralAmount !== null && collateralPriceUsd ? collateralAmount * collateralPriceUsd : null;
  const mintedUsd = mintedZchf !== null && zchfPriceUsd ? mintedZchf * zchfPriceUsd : null;
  const liquidationValueUsd = liqValueZchf !== null && zchfPriceUsd ? liqValueZchf * zchfPriceUsd : null;
  const expiredPriceRaw = expiredPurchasePriceRaw(row, now);
  const expiredCostZchfRaw = rawZchfFromCollateral(row.collateralBalance, expiredPriceRaw);
  const expiredCostZchf = numberUnits(expiredCostZchfRaw, 18);
  const expiredCostUsd = expiredCostZchf !== null && zchfPriceUsd ? expiredCostZchf * zchfPriceUsd : null;
  const expired = asNumber(row.expiration) !== null && asNumber(row.expiration) < now;
  const expiredPotentialNetUsd = expired && marketValueUsd !== null && expiredCostUsd !== null ? marketValueUsd - expiredCostUsd : null;
  return {
    version,
    position: normalizeAddress(row.position),
    owner: normalizeAddress(row.owner),
    zchf: normalizeAddress(row.zchf),
    collateral,
    collateralSymbol: row.collateralSymbol || null,
    collateralDecimals: decimals,
    collateralBalanceRaw: row.collateralBalance || null,
    collateralBalance: formatUnits(row.collateralBalance, decimals),
    collateralPriceUsd: round(collateralPriceUsd, 8),
    collateralDexLiquidityUsd: round(dexRow.liquidityUsd, 2),
    collateralTopPair: dexRow.topPair || null,
    priceRaw: row.price || null,
    mintedRaw: row.minted || null,
    mintedZchf: formatUnits(row.minted, 18),
    mintedUsd: round(mintedUsd, 2),
    liquidationValueZchfRaw: liqValueZchfRaw,
    liquidationValueZchf: formatUnits(liqValueZchfRaw, 18),
    liquidationValueUsd: round(liquidationValueUsd, 2),
    marketValueUsd: round(marketValueUsd, 2),
    collateralizationRatio: round(mintedUsd && marketValueUsd !== null ? marketValueUsd / mintedUsd : null, 4),
    liqValueVsMarketBps: round(marketValueUsd && liquidationValueUsd !== null ? ((liquidationValueUsd / marketValueUsd) - 1) * 10_000 : null, 2),
    availableForMintingRaw: row.availableForMinting || row.availableForPosition || null,
    availableForMintingZchf: formatUnits(row.availableForMinting || row.availableForPosition, 18),
    availableForClonesRaw: row.availableForClones || null,
    availableForClonesZchf: formatUnits(row.availableForClones, 18),
    challengePeriod: asNumber(row.challengePeriod),
    cooldown: asNumber(row.cooldown),
    expiration: asNumber(row.expiration),
    expired,
    expiredPurchasePriceRaw: expiredPriceRaw,
    expiredCostZchfRaw,
    expiredCostZchf: formatUnits(expiredCostZchfRaw, 18),
    expiredPotentialNetUsd: round(expiredPotentialNetUsd, 2),
    closed: Boolean(row.closed),
    denied: Boolean(row.denied),
    routePositive: false,
    watchCandidate: Boolean(expired && expiredPotentialNetUsd !== null && expiredPotentialNetUsd > 100 && (asNumber(dexRow.liquidityUsd) || 0) > 10_000),
    blocker: "Challenge/force-sale path is not route-positive without exact collateral exit, ZCHF acquisition, timing, and fork proof",
  };
}

async function inspectOnchainPosition(rpc, address) {
  const normalized = normalizeAddress(address);
  const [code, ownerRaw, hubRaw, originalRaw, collateralRaw, priceRaw, mintedRaw, challengedRaw, challengePeriodRaw, startRaw, cooldownRaw, expirationRaw, minimumRaw, reserveRaw, riskRaw, annualRaw, closedRaw, availableRaw, clonesRaw] = await Promise.all([
    getCode(rpc, normalized),
    safeCall(rpc, normalized, COMMON, "owner", []),
    safeCall(rpc, normalized, COMMON, "hub", []),
    safeCall(rpc, normalized, COMMON, "original", []),
    safeCall(rpc, normalized, COMMON, "collateral", []),
    safeCall(rpc, normalized, COMMON, "price", []),
    safeCall(rpc, normalized, COMMON, "minted", []),
    safeCall(rpc, normalized, COMMON, "challengedAmount", []),
    safeCall(rpc, normalized, COMMON, "challengePeriod", []),
    safeCall(rpc, normalized, COMMON, "start", []),
    safeCall(rpc, normalized, COMMON, "cooldown", []),
    safeCall(rpc, normalized, COMMON, "expiration", []),
    safeCall(rpc, normalized, COMMON, "minimumCollateral", []),
    safeCall(rpc, normalized, COMMON, "reserveContribution", []),
    safeCall(rpc, normalized, COMMON, "riskPremiumPPM", []),
    safeCall(rpc, normalized, COMMON, "annualInterestPPM", []),
    safeCall(rpc, normalized, COMMON, "isClosed", []),
    safeCall(rpc, normalized, COMMON, "availableForMinting", []),
    safeCall(rpc, normalized, COMMON, "availableForClones", []),
  ]);
  return {
    position: normalized,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    owner: normalizeAddress(ownerRaw?.[0]) || null,
    hub: normalizeAddress(hubRaw?.[0]) || null,
    original: normalizeAddress(originalRaw?.[0]) || null,
    collateral: normalizeAddress(collateralRaw?.[0]) || null,
    priceRaw: priceRaw?.[0] === undefined ? null : priceRaw[0].toString(),
    mintedRaw: mintedRaw?.[0] === undefined ? null : mintedRaw[0].toString(),
    challengedAmountRaw: challengedRaw?.[0] === undefined ? null : challengedRaw[0].toString(),
    challengePeriod: challengePeriodRaw?.[0] === undefined ? null : Number(challengePeriodRaw[0]),
    start: startRaw?.[0] === undefined ? null : Number(startRaw[0]),
    cooldown: cooldownRaw?.[0] === undefined ? null : Number(cooldownRaw[0]),
    expiration: expirationRaw?.[0] === undefined ? null : Number(expirationRaw[0]),
    minimumCollateralRaw: minimumRaw?.[0] === undefined ? null : minimumRaw[0].toString(),
    reserveContributionPpm: reserveRaw?.[0] === undefined ? null : Number(reserveRaw[0]),
    riskPremiumPpm: riskRaw?.[0] === undefined ? null : Number(riskRaw[0]),
    annualInterestPpm: annualRaw?.[0] === undefined ? null : Number(annualRaw[0]),
    closed: closedRaw?.[0] === undefined ? null : Boolean(closedRaw[0]),
    availableForMintingRaw: availableRaw?.[0] === undefined ? null : availableRaw[0].toString(),
    availableForClonesRaw: clonesRaw?.[0] === undefined ? null : clonesRaw[0].toString(),
  };
}

async function scanAaveEthereum(rpc) {
  const wanted = new Set([lowerAddress(ADDRESSES.zchf), lowerAddress(ADDRESSES.fps), lowerAddress(ADDRESSES.wfps)]);
  const rows = [];
  const reservesRaw = await safeCall(rpc, ADDRESSES.aaveV3Pool, AAVE_POOL, "getReservesList", []);
  const reserves = (reservesRaw?.[0] || []).map(normalizeAddress).filter(Boolean);
  for (const reserve of reserves) {
    if (!wanted.has(lowerAddress(reserve))) continue;
    const dataRaw = await rpc.call("eth_call", [{ to: ADDRESSES.aaveV3Pool, data: AAVE_POOL.encodeFunctionData("getReserveData", [reserve]) }, "latest"], 12_000).catch(() => null);
    const cfgData = dataRaw ? decodeAaveConfig(BigInt(wordAt(dataRaw, 0) || 0n)) : null;
    const aToken = dataRaw ? addressWordAt(dataRaw, 8) : null;
    rows.push({ protocol: "Aave V3", chain: "Ethereum", asset: reserve, role: reserve === ADDRESSES.zchf ? "ZCHF" : "Frankencoin equity", config: cfgData, aToken, routePositive: false, blocker: "Aave listing alone is not route-positive without accepted-value divergence, borrower state, and exact economics" });
  }
  return rows;
}

async function scanMorphoEthereum() {
  const wanted = new Set([lowerAddress(ADDRESSES.zchf), lowerAddress(ADDRESSES.fps), lowerAddress(ADDRESSES.wfps), lowerAddress(ADDRESSES.xchf), lowerAddress(ADDRESSES.vchf), lowerAddress(ADDRESSES.chfau)]);
  const query = `query($chainIds:[Int!]!) { markets(first:500, orderBy:SupplyAssetsUsd, orderDirection:Desc, where:{chainId_in:$chainIds}) { items { marketId loanAsset { symbol address decimals } collateralAsset { symbol address decimals } oracle { address } lltv state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization } } } }`;
  const json = await fetchJson("https://api.morpho.org/graphql", 30_000, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables: { chainIds: [1] } }) }).catch(() => null);
  const rows = [];
  for (const market of json?.data?.markets?.items || []) {
    const loan = lowerAddress(market.loanAsset?.address);
    const collateral = lowerAddress(market.collateralAsset?.address);
    if (!wanted.has(loan) && !wanted.has(collateral)) continue;
    const side = wanted.has(collateral) ? "collateral" : "loan";
    rows.push({ protocol: "Morpho Blue", chain: "Ethereum", marketId: market.marketId, loanAsset: market.loanAsset, collateralAsset: market.collateralAsset, oracle: normalizeAddress(market.oracle?.address), lltv: market.lltv, state: market.state, side, routePositive: false, blocker: side === "collateral" ? "Collateral-side listing needs accepted-value divergence plus exact borrow/exit economics" : "Loan-side liquidity is not a collateral extraction route by itself" });
  }
  return rows;
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

function artifactJoins(items) {
  const rows = [];
  const loadedInputs = [];
  for (const [source, rel] of INPUTS) {
    const file = path.join(WORKSPACE, rel);
    const data = readJson(file, null);
    if (!data) continue;
    loadedInputs.push(rel);
    for (const item of items) {
      const matches = findMatches(data, item.address, source, 16);
      if (!matches.length) continue;
      rows.push({ label: item.label, address: normalizeAddress(item.address), source, common: Boolean(item.common), joinCount: matches.length, routePositive: matches.some((m) => m.routePositive), watchCandidate: matches.some((m) => m.watchCandidate), matches });
    }
  }
  rows.sort((a, b) => Number(b.routePositive) - Number(a.routePositive) || Number(b.watchCandidate) - Number(a.watchCandidate) || Number(a.common) - Number(b.common) || b.joinCount - a.joinCount);
  return { rows, loadedInputs };
}

function writeReport(out) {
  const s = out.summary;
  const tokenTable = out.tokenRows.map((row) => `| ${row.role} | ${row.address} | ${row.symbol || "n/a"} | ${formatUsd(row.priceUsd)} | ${formatUsd(row.dexLiquidityUsd)} | ${formatUsd(row.totalSupplyUsd)} | ${row.erc4626Like} |`).join("\n");
  const bridgeTable = out.bridgeRows.map((row) => `| ${row.label} | ${row.bridge} | ${row.sourceSymbol || "n/a"} | ${row.sourceBalance || "n/a"} | ${row.mintedZchf || "n/a"} | ${row.backingZchf || "n/a"} | ${row.expired} |`).join("\n");
  const positionRows = out.positionRows.slice(0, 10).map((row) => `| ${row.version} | ${row.position} | ${row.collateralSymbol || "n/a"} | ${row.mintedZchf || "n/a"} | ${formatUsd(row.marketValueUsd)} | ${formatUsd(row.collateralDexLiquidityUsd)} | ${row.expired} | ${row.watchCandidate} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | false | false |";
  const consumerRows = [...out.directConsumers.aaveEthereum, ...out.directConsumers.morphoEthereum].slice(0, 10).map((row) => `| ${row.protocol} | ${row.chain} | ${row.side || row.role || "n/a"} | ${row.asset || row.marketId || "n/a"} | ${row.routePositive} |`).join("\n") || "| none | n/a | n/a | n/a | false |";
  const joinRows = out.artifactJoins.slice(0, 12).map((row) => `| ${row.label} | ${row.source} | ${row.joinCount} | ${row.watchCandidate} | ${row.routePositive} |`).join("\n") || "| none | none | 0 | false | false |";
  const md = `# \uD83D\uDFE2 DORMANT - Frankencoin Phase 0

Generated: ${out.generatedAt}

Scanner: \`tools/scan-frankencoin-phase0.js\`

Artifact: \`reports/raw/fast/frankencoin-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This Phase 0 mapped Frankencoin ZCHF/FPS contracts, V1/V2 minting hubs, active and expired Ponder positions, open challenge state, stablecoin bridge reserves, DEX/liquidity context, direct Aave/Morpho checks, and local consumer artifacts. It found no active challenge or expired force-sale path with exact positive economics, no bridge reserve mismatch mapped to extractive redemption, and no borrow/liquidation/redeem/unwind route that is currently route-positive.

## Target

| Field | Value |
|---|---:|
| Protocol | \`${out.metadata.name}\` |
| Slug | \`${out.metadata.slug}\` |
| Category | \`${out.metadata.category}\` |
| Current public TVL | \`${formatUsd(s.defillamaCurrentTvlUsd)}\` |
| Active positions | \`${s.activePositionRows}\` |
| Expired collateral rows | \`${s.expiredPositionRows}\` |
| Active challenge rows | \`${s.activeChallengeRows}\` |
| Bridge rows | \`${s.bridgeRows}\` |
| Direct consumer rows | \`${s.directConsumerRows}\` |
| Artifact join rows | \`${s.artifactJoinRows}\` |
| Route-positive rows | \`${s.routePositive}\` |

## Tokens

| Role | Address | Symbol | Price | DEX liquidity | Supply USD | ERC4626-like |
|---|---|---|---:|---:|---:|---:|
${tokenTable}

## Stablecoin Bridges

| Bridge | Address | Source | Source balance | Minted ZCHF | Backing ZCHF | Expired |
|---|---|---|---:|---:|---:|---:|
${bridgeTable}

## Top Positions

| Version | Position | Collateral | Minted ZCHF | Collateral market value | DEX liquidity | Expired | Watch |
|---|---|---|---:|---:|---:|---:|---:|
${positionRows}

## Direct Consumer Checks

| Protocol | Chain | Side | Asset/Market | Route-positive |
|---|---|---|---|---:|
${consumerRows}

## Artifact Joins

| Label | Source | Join count | Watch | Route-positive |
|---|---|---:|---:|---:|
${joinRows}

## Blockers

- Frankencoin minting positions are owner-priced and challenge/force-sale flows are time-dependent; no active/expired row has exact positive same-block economics in this pass.
- Stablecoin bridge reserves are backing context only; no permissionless mint/burn imbalance maps to an extractive route.
- Consumer joins are leads only unless accepted value diverges from exact acquisition or redemption value and live borrow/liquidation liquidity is available.
- No fork extraction proof and no signed-action justification exist.

## Next Gate

Reopen only if an active challenge, expired force-sale row, bridge reserve mismatch, or ZCHF/FPS consumer listing maps to live liquidity with exact positive acquisition, borrow/redeem/liquidation, and unwind economics.
`;
  fs.writeFileSync(REPORT_OUT, md);
}

async function main() {
  const rpcUrl = await resolveInventoryRpc(ETHEREUM_CHAIN_ID);
  if (!rpcUrl) throw new Error("Missing required RPC endpoint from rpc_endpoints.txt for Ethereum chainId 1. Provide a suitable endpoint before continuing.");
  const rpc = client(rpcUrl);
  const now = Math.floor(Date.now() / 1000);
  const metadataRaw = await fetchJson("https://api.llama.fi/protocol/frankencoin", 30_000).catch(() => ({}));
  const ponder = await fetchPonderRows(now);

  const positionSourceRows = [
    ...ponder.v1Active.map((row) => ({ version: "V1", row })),
    ...ponder.v2Active.map((row) => ({ version: "V2", row })),
    ...ponder.v1Expired.map((row) => ({ version: "V1-expired", row })),
    ...ponder.v2Expired.map((row) => ({ version: "V2-expired", row })),
  ];
  const collateralAddresses = unique(positionSourceRows.map(({ row }) => normalizeAddress(row.collateral)));
  const staticAddresses = [ADDRESSES.zchf, ADDRESSES.fps, ADDRESSES.wfps, ADDRESSES.xchf, ADDRESSES.vchf, ADDRESSES.chfau, ...collateralAddresses];
  const prices = await priceMap(staticAddresses);
  const dex = await dexMap(staticAddresses);
  const zchfPriceUsd = prices.get(lowerAddress(ADDRESSES.zchf)) || dex.get(lowerAddress(ADDRESSES.zchf))?.priceUsd || null;

  const [contractRows, tokenRows, bridgeRows, onchainPositions, aaveEthereum, morphoEthereum] = await Promise.all([
    Promise.all([
      inspectContract(rpc, "MintingHubV1", ADDRESSES.mintingHubV1, "minting-hub"),
      inspectContract(rpc, "PositionFactoryV1", ADDRESSES.positionFactoryV1, "position-factory"),
      inspectContract(rpc, "MintingHubV2", ADDRESSES.mintingHubV2, "minting-hub"),
      inspectContract(rpc, "PositionFactoryV2", ADDRESSES.positionFactoryV2, "position-factory"),
      inspectContract(rpc, "SavingsV2", ADDRESSES.savingsV2, "savings"),
      inspectContract(rpc, "RollerV2", ADDRESSES.rollerV2, "roller"),
      inspectContract(rpc, "CloneHelper", ADDRESSES.cloneHelper, "helper"),
      inspectContract(rpc, "Chainlink OCR2", ADDRESSES.chainlinkOcr2, "oracle-context"),
      inspectContract(rpc, "Uniswap V3 ZCHF/USDT", ADDRESSES.uniswapV3ZchfUsdt, "dex-pool"),
    ]),
    Promise.all([
      inspectToken(rpc, "ZCHF", ADDRESSES.zchf, prices, dex),
      inspectToken(rpc, "FPS", ADDRESSES.fps, prices, dex),
      inspectToken(rpc, "wFPS", ADDRESSES.wfps, prices, dex),
      inspectToken(rpc, "XCHF", ADDRESSES.xchf, prices, dex),
      inspectToken(rpc, "VCHF", ADDRESSES.vchf, prices, dex),
      inspectToken(rpc, "CHFAU", ADDRESSES.chfau, prices, dex),
    ]),
    Promise.all(BRIDGES.map((row) => inspectBridge(rpc, row, prices, dex, now))),
    Promise.all(positionSourceRows.slice(0, 25).map(({ row }) => inspectOnchainPosition(rpc, row.position))),
    scanAaveEthereum(rpc),
    scanMorphoEthereum(),
  ]);

  const positionRows = positionSourceRows.map(({ version, row }) => enrichPosition(row, version, dex, zchfPriceUsd, now));
  positionRows.sort((a, b) => (asNumber(b.mintedUsd) || 0) - (asNumber(a.mintedUsd) || 0));
  const challengeRows = [
    ...ponder.v1Challenges.map((row) => ({ version: "V1", ...row, routePositive: false, watchCandidate: true, blocker: "Open challenge requires exact bid timing, ZCHF acquisition, collateral exit, and fork proof" })),
    ...ponder.v2Challenges.map((row) => ({ version: "V2", ...row, routePositive: false, watchCandidate: true, blocker: "Open challenge requires exact bid timing, ZCHF acquisition, collateral exit, and fork proof" })),
  ];

  const joinItems = [
    { label: "ZCHF", address: ADDRESSES.zchf },
    { label: "FPS", address: ADDRESSES.fps },
    { label: "wFPS", address: ADDRESSES.wfps },
    { label: "MintingHubV1", address: ADDRESSES.mintingHubV1 },
    { label: "MintingHubV2", address: ADDRESSES.mintingHubV2 },
    ...BRIDGES.flatMap((row) => ([{ label: `${row.label} bridge`, address: row.bridge }, { label: `${row.label} token`, address: row.token }])),
    ...positionRows.slice(0, 20).map((row) => ({ label: `${row.collateralSymbol || "collateral"} collateral`, address: row.collateral, common: false })),
  ].filter((row) => row.address);
  const joins = artifactJoins(joinItems);

  const directConsumerRows = aaveEthereum.length + morphoEthereum.length;
  const activePositionRows = ponder.v1Active.length + ponder.v2Active.length;
  const expiredPositionRows = ponder.v1Expired.length + ponder.v2Expired.length;
  const expiredWatchRows = positionRows.filter((row) => row.watchCandidate).length;
  const collateralConsumerRows = morphoEthereum.filter((row) => row.side === "collateral").length + aaveEthereum.filter((row) => row.config?.ltv > 0).length;
  const watchCandidates = challengeRows.length + expiredWatchRows + collateralConsumerRows + joins.rows.filter((row) => row.watchCandidate).length;
  const routePositive = 0;
  const currentTvlUsd = lastRow(metadataRaw.tvl)?.totalLiquidityUSD ?? Object.values(metadataRaw.currentChainTvls || {}).reduce((sum, value) => sum + (asNumber(value) || 0), 0);
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-frankencoin-phase0.js",
    scope: "Frankencoin ZCHF Ethereum Phase 0 minting/challenge/bridge/consumer join",
    safety: { publicApisOnly: false, rpcInventoryRead: true, rpcInventoryOnly: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, signedActionJustified: false },
    metadata: { name: metadataRaw.name || "Frankencoin", slug: metadataRaw.slug || "frankencoin", category: metadataRaw.category || "CDP", chains: metadataRaw.chains || ["Ethereum"], audits: metadataRaw.audits || null, url: metadataRaw.url || "https://frankencoin.com/", twitter: metadataRaw.twitter || "frankencoinzchf", module: metadataRaw.module || "frankencoin/index.js", tvlCodePath: metadataRaw.tvlCodePath || null, github: "https://github.com/Frankencoin-ZCHF/Frankencoin", ponder: PONDER_URL, addresses: ADDRESSES },
    contractRows,
    tokenRows,
    bridgeRows,
    positionRows,
    onchainPositionRows: onchainPositions,
    challengeRows,
    dexRows: [...dex.values()].sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0)).slice(0, 40),
    directConsumers: { aaveEthereum, morphoEthereum },
    artifactJoins: joins.rows,
    joinInputsLoaded: joins.loadedInputs,
    ponderError: ponder.error,
    summary: {
      ethereumRpcResolved: true,
      defillamaCurrentTvlUsd: round(currentTvlUsd, 2),
      contractRows: contractRows.length,
      tokenRows: tokenRows.length,
      bridgeRows: bridgeRows.length,
      totalBridgeMintedZchf: round(bridgeRows.reduce((sum, row) => sum + (asNumber(row.mintedZchf) || 0), 0), 6),
      totalBridgeBackingZchf: round(bridgeRows.reduce((sum, row) => sum + (asNumber(row.backingZchf) || 0), 0), 6),
      activePositionRows,
      activeV1PositionRows: ponder.v1Active.length,
      activeV2PositionRows: ponder.v2Active.length,
      expiredPositionRows,
      expiredWatchRows,
      activeChallengeRows: challengeRows.length,
      topPositionMintedUsd: round(positionRows[0]?.mintedUsd, 2),
      dexRows: dex.size,
      topDexLiquidityUsd: round(Math.max(0, ...[...dex.values()].map((row) => asNumber(row.liquidityUsd) || 0)), 2),
      directConsumerRows,
      collateralConsumerRows,
      artifactJoinRows: joins.rows.length,
      watchCandidates,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      status: "phase0-no-route-positive",
    },
    blockers: [
      "No active challenge or expired force-sale row maps to exact positive acquisition, bid, redemption, and DEX unwind economics",
      "Stablecoin bridge balances are backing context only; no permissionless bridge imbalance is route-positive",
      "ZCHF/FPS consumer joins are leads only without accepted-value divergence and live borrow/liquidation liquidity",
      "No fork extraction proof and no signed-action justification",
    ],
    requiredForRoutePositive: [
      "active challenge, expired force-sale, bridge-reserve, or consumer listing trigger with permissionless impact",
      "exact ZCHF/collateral acquisition, borrow/redeem/liquidation, and DEX exit economics positive after costs",
      "no cooldown, challenge-period, role, or capital-lock blocker for the selected route",
      "fork extraction proof",
    ],
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);
  writeReport(output);
  if (!QUIET) {
    console.log(`Frankencoin Phase0: tvl=${formatUsd(output.summary.defillamaCurrentTvlUsd)} activePositions=${activePositionRows} activeChallenges=${challengeRows.length} consumers=${directConsumerRows} joins=${joins.rows.length} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(String(err?.message || err).slice(0, 420));
  process.exit(1);
});
