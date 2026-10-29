#!/usr/bin/env node
// scan-euler-v2-phase0.js - read-only Phase 0 for Euler V2 EVK factories/vaults/LTV routes.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "euler-v2-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "euler-v2-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const MAX_VAULTS_PER_CHAIN = Number(process.env.EULER_V2_PHASE0_MAX_VAULTS_PER_CHAIN || "1000");
const MAX_LTVS_PER_VAULT = Number(process.env.EULER_V2_PHASE0_MAX_LTVS_PER_VAULT || "80");
const MIN_MATERIAL_BORROW_USD = Number(process.env.EULER_V2_PHASE0_MIN_BORROW_USD || "10000");
const HIGH_LTV_BPS = Number(process.env.EULER_V2_PHASE0_HIGH_LTV_BPS || "8500");

const CHAINS = [
  { key: "ethereum", adapterChain: "ethereum", chain: "Ethereum", chainId: 1, coinSlug: "ethereum", factory: "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e" },
  { key: "base", adapterChain: "base", chain: "Base", chainId: 8453, coinSlug: "base", factory: "0x7F321498A801A191a93C840750ed637149dDf8D0" },
  { key: "sonic", adapterChain: "sonic", chain: "Sonic", chainId: 146, coinSlug: "sonic", factory: "0xF075cC8660B51D0b8a4474e3f47eDAC5fA034cFB" },
  { key: "unichain", adapterChain: "unichain", chain: "Unichain", chainId: 130, coinSlug: "unichain", factory: "0xbAd8b5BDFB2bcbcd78Cc9f1573D3Aad6E865e752" },
  { key: "berachain", adapterChain: "berachain", chain: "Berachain", chainId: 80094, coinSlug: "berachain", factory: "0x5C13fb43ae9BAe8470f646ea647784534E9543AF" },
  { key: "avalanche", adapterChain: "avax", chain: "Avalanche", chainId: 43114, coinSlug: "avax", factory: "0xaf4B4c18B17F6a2B32F6c398a3910bdCD7f26181" },
  { key: "bnb", adapterChain: "bsc", chain: "BNB Chain", chainId: 56, coinSlug: "bsc", factory: "0x7F53E2755eB3c43824E162F7F6F087832B9C9Df6" },
  { key: "arbitrum", adapterChain: "arbitrum", chain: "Arbitrum", chainId: 42161, coinSlug: "arbitrum", factory: "0x78Df1CF5bf06a7f27f2ACc580B934238C1b80D50" },
  { key: "linea", adapterChain: "linea", chain: "Linea", chainId: 59144, coinSlug: "linea", factory: "0x84711986Fd3BF0bFe4a8e6d7f4E22E67f7f27F04" },
  { key: "mantle", adapterChain: "mantle", chain: "Mantle", chainId: 5000, coinSlug: "mantle", factory: "0x47Aaf2f062aa1D55AFa602f5C9597588f71E2d76" },
  { key: "hyperliquid", adapterChain: "hyperliquid", chain: "Hyperliquid", chainId: 999, coinSlug: "hyperliquid", factory: "0xcF5552580fD364cdBBFcB5Ae345f75674c59273A" },
];

const UNSUPPORTED_ADAPTER_CHAINS = [
  { adapterChain: "swellchain", reason: "no local RPC/chain preset in current inventory" },
  { adapterChain: "bob", reason: "no local RPC/chain preset in current inventory" },
  { adapterChain: "tac", reason: "no local RPC/chain preset in current inventory" },
  { adapterChain: "plasma", reason: "no local RPC/chain preset in current inventory" },
  { adapterChain: "monad", reason: "no local RPC/chain preset in current inventory" },
];

const FACTORY = new ethers.Interface([
  "function getProxyListLength() view returns (uint256)",
  "function getProxyListSlice(uint256 start,uint256 end) view returns (address[])",
  "function proxyList(uint256) view returns (address)",
]);
const EVAULT = new ethers.Interface([
  "function asset() view returns (address)",
  "function cash() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function LTVList() view returns (address[])",
  "function LTVBorrow(address collateral) view returns (uint16)",
  "function oracle() view returns (address)",
  "function unitOfAccount() view returns (address)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function maxMint(address receiver) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);
const ERC20 = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);
const BEACON = new ethers.Interface(["function implementation() view returns (address)"]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function safeText(value, max = 140) { return String(value || "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const text = String(value).replace(/[$,%\s,]/g, ""); if (!text) return null; const n = Number(text); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const factor = 10 ** decimals; return Math.round(n * factor) / factor; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatNumber(value, decimals = 2) { const n = asNumber(value); return n === null ? "n/a" : n.toLocaleString(undefined, { maximumFractionDigits: decimals }); }
function unitsToNumber(value, decimals = 18) { try { if (value === null || value === undefined) return null; return Number(ethers.formatUnits(BigInt(value), decimals)); } catch (_) { return null; } }
function slotAddress(raw) {
  const addr = raw && raw !== "0x" && raw.length >= 66 ? normalizeAddress(`0x${raw.slice(26)}`) : null;
  return addr && addr !== ZERO ? addr : null;
}

async function mapLimit(items, limit, fn) {
  const out = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-euler-v2-phase0/1.0" } });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { ok: res.ok, status: res.status, json, error: res.ok ? null : safeText(text || `HTTP ${res.status}`, 120) };
  } catch (err) { return { ok: false, status: null, json: null, error: safeText(err?.name || err?.message || "transport-error", 80) }; }
  finally { clearTimeout(timer); }
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

async function getSlotAddress(rpc, address, slot) {
  const raw = await rpcCall(rpc, "eth_getStorageAt", [address, slot, "latest"], 10_000).catch(() => null);
  return slotAddress(raw);
}

async function getImplementation(rpc, address) {
  const impl = await getSlotAddress(rpc, address, EIP1967_IMPL);
  if (impl) return { implementation: impl, beacon: null, source: "eip1967-impl" };
  const beacon = await getSlotAddress(rpc, address, EIP1967_BEACON);
  if (!beacon) return { implementation: null, beacon: null, source: null };
  const implFromBeacon = normalizeAddress((await safeCall(rpc, beacon, BEACON, "implementation"))?.[0]);
  return { implementation: implFromBeacon, beacon, source: implFromBeacon ? "eip1967-beacon" : "eip1967-beacon-unread" };
}

function protocolMetadata() {
  const d = readJson(PUBLIC_TARGETS, {});
  const rows = [...(d.phase0Queue || []), ...(d.consumerJoinFirst || []), ...(d.protocolCandidates || []), ...(d.targets || [])];
  const row = rows.find((p) => p?.slug === "euler-v2" || p?.name === "Euler V2");
  if (row) return { name: row.name, slug: row.slug, category: row.category, chains: row.chains || [], evmChains: row.evmChains || [], customSupportedChains: row.customSupportedChains || [], tvlUsd: row.tvlUsd, change1dPct: row.change1dPct, change7dPct: row.change7dPct, routePriority: row.routePriority || null, source: "public-audit-target-discovery" };
  return { name: "Euler V2", slug: "euler-v2", category: "Lending", chains: CHAINS.map((c) => c.chain), evmChains: CHAINS.map((c) => c.chain), tvlUsd: null };
}

async function discoverVaults(rpc, chain) {
  const lengthRes = await safeCall(rpc, chain.factory, FACTORY, "getProxyListLength");
  const proxyListLength = lengthRes?.[0] === undefined ? null : Number(lengthRes[0]);
  const max = proxyListLength === null ? 0 : Math.min(proxyListLength, MAX_VAULTS_PER_CHAIN);
  const capHit = proxyListLength !== null && proxyListLength > MAX_VAULTS_PER_CHAIN;
  const vaults = [];
  let sliceWorked = false;
  for (let start = 0; start < max; start += 100) {
    const end = Math.min(max, start + 100);
    const slice = await safeCall(rpc, chain.factory, FACTORY, "getProxyListSlice", [start, end], 18_000);
    const addrs = Array.isArray(slice?.[0]) ? slice[0].map(normalizeAddress).filter(Boolean) : [];
    if (!addrs.length) break;
    sliceWorked = true;
    for (let i = 0; i < addrs.length; i++) vaults.push({ address: addrs[i], proxyListIndex: start + i, discoverySource: "getProxyListSlice" });
  }
  if (!sliceWorked) {
    for (let i = 0; i < max; i++) {
      const res = await safeCall(rpc, chain.factory, FACTORY, "proxyList", [i], 8_000);
      const addr = normalizeAddress(res?.[0]);
      if (addr && addr !== ZERO) vaults.push({ address: addr, proxyListIndex: i, discoverySource: "proxyList" });
    }
  }
  const seen = new Set();
  const deduped = vaults.filter((row) => {
    const key = lowerAddress(row.address);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { proxyListLength, capHit, vaults: deduped, discoveryMethod: sliceWorked ? "getProxyListSlice" : "proxyList" };
}

async function inspectFactories(rpcs) {
  const rows = [];
  const discoveredByChain = new Map();
  for (const chain of CHAINS) {
    const rpc = rpcs[chain.chainId];
    const code = await getCode(rpc, chain.factory);
    const implInfo = code && code !== "0x" ? await getImplementation(rpc, chain.factory) : { implementation: null, beacon: null, source: null };
    const discovery = code && code !== "0x" ? await discoverVaults(rpc, chain) : { proxyListLength: null, capHit: false, vaults: [], discoveryMethod: null };
    discoveredByChain.set(chain.chainId, discovery.vaults);
    rows.push({
      ...chain,
      rpcResolved: Boolean(rpc),
      codePresent: Boolean(code && code !== "0x"),
      codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
      implementation: implInfo.implementation,
      beacon: implInfo.beacon,
      implementationSource: implInfo.source,
      proxyListLength: discovery.proxyListLength,
      vaultRowsDiscovered: discovery.vaults.length,
      vaultDiscoveryMethod: discovery.discoveryMethod,
      capHit: discovery.capHit,
      routePositive: false,
    });
  }
  return { rows, discoveredByChain };
}

async function tokenMeta(rpc, token) {
  const addr = normalizeAddress(token);
  if (!rpc || !addr) return { decimals: null, symbol: null, name: null };
  const [decimals, symbol, name] = await Promise.all([
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
  ]);
  return {
    decimals: decimals?.[0] === undefined ? null : Number(decimals[0]),
    symbol: safeText(symbol?.[0], 40),
    name: safeText(name?.[0], 80),
  };
}

async function inspectVaultBase(rpc, chain, discovered) {
  const vault = normalizeAddress(discovered.address);
  const code = await getCode(rpc, vault);
  const implInfo = code && code !== "0x" ? await getImplementation(rpc, vault) : { implementation: null, beacon: null, source: null };
  const [asset, cash, totalAssets, totalBorrows, totalSupply, ltvList, oracle, unitOfAccount, maxDeposit, maxMint, decimals, symbol, name] = await Promise.all([
    safeCall(rpc, vault, EVAULT, "asset"),
    safeCall(rpc, vault, EVAULT, "cash"),
    safeCall(rpc, vault, EVAULT, "totalAssets"),
    safeCall(rpc, vault, EVAULT, "totalBorrows"),
    safeCall(rpc, vault, EVAULT, "totalSupply"),
    safeCall(rpc, vault, EVAULT, "LTVList"),
    safeCall(rpc, vault, EVAULT, "oracle"),
    safeCall(rpc, vault, EVAULT, "unitOfAccount"),
    safeCall(rpc, vault, EVAULT, "maxDeposit", [ZERO]),
    safeCall(rpc, vault, EVAULT, "maxMint", [ZERO]),
    safeCall(rpc, vault, EVAULT, "decimals"),
    safeCall(rpc, vault, EVAULT, "symbol"),
    safeCall(rpc, vault, EVAULT, "name"),
  ]);
  const assetAddr = normalizeAddress(asset?.[0]);
  const assetInfo = await tokenMeta(rpc, assetAddr);
  const ltvAddrs = Array.isArray(ltvList?.[0]) ? ltvList[0].map(normalizeAddress).filter(Boolean) : [];
  const ltvRows = await mapLimit(ltvAddrs.slice(0, MAX_LTVS_PER_VAULT), 8, async (collateral) => {
    const b = await safeCall(rpc, vault, EVAULT, "LTVBorrow", [collateral]);
    return { collateralVault: collateral, ltvBorrowBps: b?.[0] === undefined ? null : Number(b[0]) };
  });
  return {
    chainId: chain.chainId,
    chain: chain.chain,
    adapterChain: chain.adapterChain,
    factory: chain.factory,
    vault,
    proxyListIndex: discovered.proxyListIndex,
    discoverySource: discovered.discoverySource,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    implementation: implInfo.implementation,
    beacon: implInfo.beacon,
    implementationSource: implInfo.source,
    asset: assetAddr,
    assetSymbol: assetInfo.symbol,
    assetName: assetInfo.name,
    assetDecimals: assetInfo.decimals,
    vaultSymbol: safeText(symbol?.[0], 40),
    vaultName: safeText(name?.[0], 80),
    vaultDecimals: decimals?.[0] === undefined ? null : Number(decimals[0]),
    oracle: normalizeAddress(oracle?.[0]),
    unitOfAccount: normalizeAddress(unitOfAccount?.[0]),
    cashRaw: cash?.[0]?.toString?.() || null,
    totalAssetsRaw: totalAssets?.[0]?.toString?.() || null,
    totalBorrowsRaw: totalBorrows?.[0]?.toString?.() || null,
    totalSupplyRaw: totalSupply?.[0]?.toString?.() || null,
    maxDepositRaw: maxDeposit?.[0]?.toString?.() || null,
    maxMintRaw: maxMint?.[0]?.toString?.() || null,
    ltvListLength: ltvAddrs.length,
    ltvRowsScanned: ltvRows.length,
    ltvRowsCapped: ltvAddrs.length > MAX_LTVS_PER_VAULT,
    ltvRows: ltvRows.filter((row) => row.ltvBorrowBps !== null),
    routePositive: false,
  };
}

async function fetchPrices(vaultRows) {
  const refs = [];
  for (const row of vaultRows) {
    const chain = CHAINS.find((c) => c.chainId === row.chainId);
    if (!chain || !row.asset) continue;
    refs.push({ key: `${chain.coinSlug}:${row.asset.toLowerCase()}`, chainId: row.chainId, address: row.asset });
  }
  const keys = unique(refs.map((r) => r.key.toLowerCase()));
  const prices = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const fetched = await fetchJson(`https://coins.llama.fi/prices/current/${keys.slice(i, i + 50).join(",")}?searchWidth=6h`, 30_000);
    for (const [key, row] of Object.entries(fetched.json?.coins || {})) {
      const price = Number(row?.price || 0);
      if (price > 0) prices.set(key.toLowerCase(), price);
    }
  }
  return prices;
}

function enrichVaultRows(vaultRows, prices) {
  return vaultRows.map((row) => {
    const chain = CHAINS.find((c) => c.chainId === row.chainId);
    const price = chain && row.asset ? prices.get(`${chain.coinSlug}:${row.asset.toLowerCase()}`) || null : null;
    const decimals = row.assetDecimals ?? row.vaultDecimals ?? 18;
    const cashAmount = unitsToNumber(row.cashRaw, decimals);
    const totalAssetsAmount = unitsToNumber(row.totalAssetsRaw, decimals);
    const totalBorrowsAmount = unitsToNumber(row.totalBorrowsRaw, decimals);
    const maxDepositAmount = unitsToNumber(row.maxDepositRaw, decimals);
    const maxMintAmount = unitsToNumber(row.maxMintRaw, row.vaultDecimals ?? decimals);
    const highLtvRows = row.ltvRows.filter((ltv) => (asNumber(ltv.ltvBorrowBps) || 0) >= HIGH_LTV_BPS);
    return {
      ...row,
      assetPriceUsd: price,
      cashAmount: round(cashAmount, 8),
      cashUsd: price ? round((cashAmount || 0) * price, 2) : null,
      totalAssetsAmount: round(totalAssetsAmount, 8),
      totalAssetsUsd: price ? round((totalAssetsAmount || 0) * price, 2) : null,
      totalBorrowsAmount: round(totalBorrowsAmount, 8),
      totalBorrowsUsd: price ? round((totalBorrowsAmount || 0) * price, 2) : null,
      maxDepositAmount: round(maxDepositAmount, 8),
      maxMintAmount: round(maxMintAmount, 8),
      maxLtvBorrowBps: highLtvRows.length ? Math.max(...highLtvRows.map((ltv) => asNumber(ltv.ltvBorrowBps) || 0)) : Math.max(0, ...row.ltvRows.map((ltv) => asNumber(ltv.ltvBorrowBps) || 0)),
      highLtvRows: highLtvRows.slice(0, 12),
      materialBorrowCash: (price ? (cashAmount || 0) * price : 0) >= MIN_MATERIAL_BORROW_USD,
      routePositive: false,
    };
  }).sort((a, b) => (asNumber(b.cashUsd) || 0) - (asNumber(a.cashUsd) || 0));
}

async function inspectVaults(rpcs, factoryRows, discoveredByChain) {
  const baseRows = [];
  for (const factory of factoryRows.filter((row) => row.rpcResolved && row.codePresent)) {
    const rpc = rpcs[factory.chainId];
    const discovered = discoveredByChain.get(factory.chainId) || [];
    const rows = await mapLimit(discovered, 10, (row) => inspectVaultBase(rpc, factory, row));
    baseRows.push(...rows.filter(Boolean));
  }
  const prices = await fetchPrices(baseRows);
  return enrichVaultRows(baseRows, prices);
}

function buildWatchCandidates(vaultRows) {
  const rows = [];
  for (const row of vaultRows) {
    if (!row.materialBorrowCash) continue;
    for (const ltv of row.highLtvRows || []) {
      rows.push({
        chain: row.chain,
        borrowVault: row.vault,
        borrowVaultSymbol: row.vaultSymbol,
        borrowAsset: row.asset,
        borrowAssetSymbol: row.assetSymbol,
        collateralVault: ltv.collateralVault,
        ltvBorrowBps: ltv.ltvBorrowBps,
        borrowCashUsd: row.cashUsd,
        totalBorrowsUsd: row.totalBorrowsUsd,
        oracle: row.oracle,
        reason: "High-LTV Euler V2 borrow vault with material cash; needs oracle adapter decode plus exact collateral acquisition/borrow/exit economics",
        routePositive: false,
        blocker: "No proven stale/manipulable oracle or exact positive acquisition/borrow/unwind economics",
      });
    }
  }
  return rows.sort((a, b) => (asNumber(b.borrowCashUsd) || 0) - (asNumber(a.borrowCashUsd) || 0)).slice(0, 60);
}

function primitiveAddresses(value, out = new Set()) {
  if (typeof value === "string") { for (const m of value.matchAll(/0x[0-9a-fA-F]{40}/g)) out.add(m[0].toLowerCase()); }
  else if (Array.isArray(value)) { for (const item of value) primitiveAddresses(item, out); }
  else if (value && typeof value === "object") { for (const item of Object.values(value)) primitiveAddresses(item, out); }
  return out;
}

function countAddressContext(factoryRows, vaultRows) {
  const eulerSpecific = new Set();
  const assets = new Set();
  for (const row of factoryRows) eulerSpecific.add(lowerAddress(row.factory));
  for (const row of vaultRows) {
    eulerSpecific.add(lowerAddress(row.vault));
    eulerSpecific.add(lowerAddress(row.oracle));
    if (lowerAddress(row.asset)) assets.add(lowerAddress(row.asset));
  }
  eulerSpecific.delete(null);
  assets.delete(null);
  const files = [
    ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
    ["current-profit-leads", "reports/raw/fast/current-profit-lead-triage.json"],
    ["market-launch-choreography", "reports/raw/fast/market-launch-choreography-routes.json"],
    ["bridge-nonlossless-collateral", "reports/raw/fast/bridge-nonlossless-collateral-join.json"],
    ["layerzero-oft-dvn", "reports/raw/fast/layerzero-oft-dvn-consumer-joins.json"],
  ];
  let eulerSpecificRows = 0;
  let assetContextRows = 0;
  const samples = [];
  for (const [source, rel] of files) {
    const json = readJson(path.join(WORKSPACE, rel), null);
    if (!json) continue;
    const hits = primitiveAddresses(json);
    const eulerHits = [...hits].filter((addr) => eulerSpecific.has(addr));
    const assetHits = [...hits].filter((addr) => assets.has(addr));
    if (eulerHits.length) eulerSpecificRows += 1;
    if (assetHits.length) assetContextRows += 1;
    if (samples.length < 12 && (eulerHits.length || assetHits.length)) samples.push({ source, eulerSpecificHits: eulerHits.slice(0, 8), assetHits: assetHits.slice(0, 8), routePositive: false });
  }
  return { eulerSpecificRows, assetContextRows, samples };
}

function buildReport(artifact) {
  const s = artifact.summary;
  const factoryTable = artifact.factoryRows.map((row) => `| ${row.chain} | ${compactAddress(row.factory)} | ${row.rpcResolved ? "yes" : "no"} | ${row.codePresent ? "yes" : "no"} | ${row.proxyListLength ?? "n/a"} | ${row.vaultRowsDiscovered} | ${row.capHit ? "yes" : "no"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const vaultTable = artifact.vaultRows.slice(0, 18).map((row) => `| ${row.chain} | ${compactAddress(row.vault)} | ${row.vaultSymbol || "n/a"} | ${row.assetSymbol || compactAddress(row.asset)} | ${formatUsd(row.cashUsd)} | ${formatUsd(row.totalBorrowsUsd)} | ${row.ltvListLength} | ${formatNumber((asNumber(row.maxLtvBorrowBps) || 0) / 100, 2)}% | ${compactAddress(row.oracle)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const watchTable = artifact.watchCandidates.slice(0, 18).map((row) => `| ${row.chain} | ${compactAddress(row.borrowVault)} | ${row.borrowVaultSymbol || "n/a"} | ${compactAddress(row.collateralVault)} | ${formatNumber((asNumber(row.ltvBorrowBps) || 0) / 100, 2)}% | ${formatUsd(row.borrowCashUsd)} | ${row.blocker} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | no high-LTV material-cash watch rows |";
  const unsupported = artifact.unsupportedAdapterChains.map((row) => `| ${row.adapterChain} | ${row.reason} |`).join("\n") || "| none | n/a |";
  return `# ${SIGNAL_DORMANT} - Euler V2 Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit for the covered Euler V2 factory/vault scope. The scanner mapped the DeFiLlama adapter factories on RPC-available chains, enumerated eVault proxy lists, sampled per-vault assets, cash, borrows, oracle addresses, and LTV collateral lists, then ranked high-LTV/material-cash rows as watch-only. Prior Euler V2 source review remains useful background, but this Phase 0 pass is a live-state deployment inventory; no row proves a stale/manipulable oracle, positive collateral acquisition, positive borrow/exit unwind, or fork/local extraction proof.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Adapter factories checked | ${s.factoryRows} |
| Factories with RPC/code | ${s.factoriesWithRpcAndCode} |
| Factory proxy-list length | ${s.factoryProxyListLengthTotal} |
| Vault rows scanned | ${s.vaultRows} |
| Vault rows with code | ${s.vaultRowsWithCode} |
| Vault rows with borrow cash | ${s.vaultRowsWithBorrowCash} |
| Material borrow-cash rows | ${s.materialBorrowCashRows} |
| High-LTV pair rows | ${s.highLtvPairRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |
| Coverage classification | ${s.coverageClassification} |

## Factories

| Chain | Factory | RPC | Code | Proxy list length | Vaults scanned | Cap hit |
|---|---|---|---|---:|---:|---|
${factoryTable}

## Top Vault Rows By Borrow Cash

| Chain | Vault | Vault symbol | Asset | Cash | Borrows | LTV entries | Max borrow LTV | Oracle |
|---|---|---|---|---:|---:|---:|---:|---|
${vaultTable}

## Watch Candidates

| Chain | Borrow vault | Symbol | Collateral vault | Borrow LTV | Borrow cash | Blocker |
|---|---|---|---|---:|---:|---|
${watchTable}

## Unsupported Adapter Chains

| Adapter chain | Reason |
|---|---|
${unsupported}

## Blockers

- High LTV plus borrow cash is only a watch shape; no accepted-vs-acquisition premium is proven.
- Per-vault oracle addresses were inventoried, but adapter semantics and stale/deviation behavior were not proven attacker-favorable in this Phase 0 pass.
- Existing Euler/eVault focused artifacts remain route-negative and do not supply exact positive acquisition/borrow/unwind economics.
- Some adapter chains are out of current local RPC scope and are treated as bounded coverage, not exhaustive protocol-wide proof.
- No fork/local proof and no signed-action authorization exist.

## Required For Route-Positive

- A specific Euler vault pair uses stale, manipulable, under-bound, or otherwise attacker-favorable oracle/accounting state.
- Collateral acquisition is permissionless and exact-quoted.
- Borrow-side liquidity and borrowed-asset exit are material and exact-quoted positive after gas/slippage/fees.
- Fork/local proof demonstrates positive net value.

Artifacts: \`reports/raw/fast/euler-v2-phase0.json\`.
`;
}

async function main() {
  const metadata = protocolMetadata();
  const rpcs = await resolveRpcPool(CHAINS.map((c) => c.chainId));
  const inspectedChains = CHAINS.filter((chain) => Boolean(rpcs[chain.chainId]));
  const { rows: factoryRows, discoveredByChain } = await inspectFactories(rpcs);
  const vaultRows = await inspectVaults(rpcs, factoryRows, discoveredByChain);
  const watchCandidates = buildWatchCandidates(vaultRows);
  const context = countAddressContext(factoryRows, vaultRows);
  const capHitRows = factoryRows.filter((row) => row.capHit).length + vaultRows.filter((row) => row.ltvRowsCapped).length;
  const summary = {
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    adapterChainsKnown: CHAINS.length + UNSUPPORTED_ADAPTER_CHAINS.length,
    adapterChainsWithChainId: CHAINS.length,
    adapterChainsInspected: inspectedChains.length,
    unsupportedAdapterChains: UNSUPPORTED_ADAPTER_CHAINS.length,
    factoryRows: factoryRows.length,
    factoryRowsWithRpc: factoryRows.filter((row) => row.rpcResolved).length,
    factoryRowsWithCode: factoryRows.filter((row) => row.codePresent).length,
    factoriesWithRpcAndCode: factoryRows.filter((row) => row.rpcResolved && row.codePresent).length,
    factoryProxyListLengthTotal: factoryRows.reduce((sum, row) => sum + (asNumber(row.proxyListLength) || 0), 0),
    factoryCapHitRows: factoryRows.filter((row) => row.capHit).length,
    vaultRows: vaultRows.length,
    vaultRowsWithCode: vaultRows.filter((row) => row.codePresent).length,
    vaultRowsWithBorrowCash: vaultRows.filter((row) => (asNumber(row.cashUsd) || 0) > 0).length,
    vaultRowsWithBorrows: vaultRows.filter((row) => (asNumber(row.totalBorrowsUsd) || 0) > 0).length,
    materialBorrowCashRows: vaultRows.filter((row) => row.materialBorrowCash).length,
    totalBorrowCashUsd: round(vaultRows.reduce((sum, row) => sum + (asNumber(row.cashUsd) || 0), 0), 2),
    totalBorrowsUsd: round(vaultRows.reduce((sum, row) => sum + (asNumber(row.totalBorrowsUsd) || 0), 0), 2),
    highLtvPairRows: vaultRows.reduce((sum, row) => sum + (row.highLtvRows || []).length, 0),
    ltvRowsCapped: vaultRows.filter((row) => row.ltvRowsCapped).length,
    externalEulerSpecificContextRows: context.eulerSpecificRows,
    assetContextRows: context.assetContextRows,
    watchCandidates: watchCandidates.length,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    coverageClassification: (UNSUPPORTED_ADAPTER_CHAINS.length || capHitRows) ? "bounded-with-caveats" : "full-enough-for-declared-scope",
    closedReason: "watch-only high-LTV/material-cash Euler V2 rows lack exact oracle/acquisition/borrow/unwind economics and proof",
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-euler-v2-phase0.js",
    scope: "Read-only Euler V2 EVK adapter factory/vault/LTV Phase 0 scan on RPC-available chains",
    target: { name: "Euler V2", slug: "euler-v2", category: "Lending", surface: "lending-oracle-liquidation", metadata },
    safety: { publicApisOnlyForMetadata: true, rpcInventoryRead: true, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false },
    docs: { adapter: "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/euler-v2/index.js", methodology: "TVL is supply balance minus borrows across EVK vaults; borrowed excludes unpriced/insolvent collateral contexts", priorTriage: "reports/euler-labs-triage.md" },
    thresholds: { maxVaultsPerChain: MAX_VAULTS_PER_CHAIN, maxLtvsPerVault: MAX_LTVS_PER_VAULT, highLtvBps: HIGH_LTV_BPS, minMaterialBorrowUsd: MIN_MATERIAL_BORROW_USD },
    inspectedChainRows: factoryRows.map(({ factory, chain, chainId, adapterChain, rpcResolved, codePresent, proxyListLength, vaultRowsDiscovered, capHit }) => ({ factory, chain, chainId, adapterChain, rpcResolved, codePresent, proxyListLength, vaultRowsDiscovered, capHit })),
    unsupportedAdapterChains: UNSUPPORTED_ADAPTER_CHAINS,
    factoryRows,
    vaultRows,
    watchCandidates,
    routePositiveRows: [],
    contextRows: context.samples,
    summary,
    blockers: [
      "High LTV plus borrow cash is watch-only without an attacker-favorable oracle/accounting trigger",
      "No exact positive collateral acquisition, borrow, liquidation, redemption, settlement, or DEX unwind economics",
      "Some adapter chains are outside current local RPC scope and make this a bounded live-state pass",
      "No fork/local extraction proof",
    ],
    requiredForRoutePositive: [
      "specific Euler vault pair uses stale, manipulable, under-bound, or otherwise attacker-favorable oracle/accounting state",
      "collateral acquisition is permissionless and exact-quoted",
      "borrow-side liquidity and borrowed-asset exit are positive after gas/slippage/fees",
      "fork/local proof",
    ],
    nextReadOnlyStep: "Decode oracle adapters for top high-LTV/material-cash watch rows and exact-quote only if accepted collateral value is attacker-favorable.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));
  if (!QUIET) console.log(`Euler V2 Phase 0: factories=${summary.factoryRows} vaults=${summary.vaultRows} materialBorrow=${summary.materialBorrowCashRows} highLtvPairs=${summary.highLtvPairRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
}

main().catch((err) => { console.error(err?.message || String(err)); process.exit(1); });
