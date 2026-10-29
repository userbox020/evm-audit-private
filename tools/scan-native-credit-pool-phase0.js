#!/usr/bin/env node
// scan-native-credit-pool-phase0.js - read-only Phase 0 for Native Credit Pool vault/LP markets.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, calldata, borrower addresses, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "native-credit-pool-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "native-credit-pool-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_DORMANT = "🟢 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";
const MARKET_LISTED_TOPIC = ethers.id("MarketListed(address)");
const MAX_LOG_CHUNKS = Number(process.env.NATIVE_CREDIT_MAX_LOG_CHUNKS || "80");
const MATERIAL_USD = Number(process.env.NATIVE_CREDIT_MATERIAL_USD || "10000");

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const CHAINS = [
  { key: "ethereum", chain: "Ethereum", chainId: 1, coinSlug: "ethereum", vault: "0xe3D41d19564922C9952f692C5Dd0563030f5f2EF", vaultFromBlock: 22173196, logChunkBlocks: 250000 },
  { key: "bsc", chain: "BNB Chain", chainId: 56, coinSlug: "bsc", vault: "0xBA8dB0CAf781cAc69b6acf6C848aC148264Cc05d", vaultFromBlock: 47980948, logChunkBlocks: 1000000 },
  { key: "base", chain: "Base", chainId: 8453, coinSlug: "base", vault: "0x74a4Cd023e5AfB88369E3f22b02440F2614a1367", vaultFromBlock: 32578350, logChunkBlocks: 500000 },
  { key: "arbitrum", chain: "Arbitrum", chainId: 42161, coinSlug: "arbitrum", vault: "0xbA1cf8A63227b46575AF823BEB4d83D1025eff09", vaultFromBlock: 355397381, logChunkBlocks: 2000000 },
  { key: "monad", chain: "Monad", chainId: null, coinSlug: "monad", vault: "0xcD1D2D602C3e7394515DaAe96e4FFe16DE71e5B4", vaultFromBlock: 70146973, unsupportedReason: "No current sanitized Monad RPC support in shared inventory" },
];

const CONSUMER_ARTIFACTS = [
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["seven-chain-lending", "reports/raw/fast/seven-chain-lending-coverage.json"],
  ["stablecoin-depeg", "reports/raw/fast/stablecoin-depeg-lending-routes.json"],
  ["erc4626-consumer", "reports/raw/fast/erc4626-consumer-joiner.json"],
  ["evault-collateral-nav", "reports/raw/fast/evault-collateral-nav-manipulation.json"],
  ["focused-morpho", "reports/raw/fast/focused-morpho-review-producers.json"],
  ["focused-euler", "reports/raw/fast/focused-euler-evk-review-producers.json"],
  ["morpho-pyth-unsafe-consumers", "reports/raw/fast/morpho-pyth-unsafe-consumers.json"],
  ["morpho-exit-liquidity-stress", "reports/raw/fast/morpho-exit-liquidity-stress.json"],
  ["morpho-public-allocator", "reports/raw/fast/morpho-public-allocator-force-feed.json"],
  ["morpho-liquidatable", "reports/raw/fast/morpho-liquidatable-marketability.json"],
  ["morpho-wrapper-exit", "reports/raw/fast/morpho-wrapper-exit-proof-gaps.json"],
  ["pool-share-snapshot", "reports/raw/fast/pool-share-snapshot-drift.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["pendle-pt", "reports/raw/fast/pendle-pt-multichain-consumer-graph.json"],
  ["silo-pt", "reports/raw/fast/silo-pt-oracle-routes.json"],
  ["dex-consumer-routes", "reports/raw/fast/dex-consumer-routes.json"],
  ["current-profit-leads", "reports/raw/fast/current-profit-lead-triage.json"],
  ["bridge-proof-binding", "reports/raw/fast/bridge-proof-binding.json"],
  ["bridge-synthetic-consumer", "reports/raw/fast/bridge-synthetic-consumer-exposure.json"],
];
const DIRECT_ROLES = new Set(["vault", "lpMarket"]);

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const BYTES32_META = new ethers.Interface(["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"]);
const LP = new ethers.Interface([
  "event MarketListed(address lpToken)",
  "event MarketListed(address indexed lpToken)",
  "function underlying() view returns (address)",
  "function asset() view returns (address)",
  "function totalUnderlying() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function getCash() view returns (uint256)",
  "function cash() view returns (uint256)",
  "function totalBorrowed() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function borrowCap() view returns (uint256)",
  "function supplyCap() view returns (uint256)",
  "function paused() view returns (bool)",
  "function isPaused() view returns (bool)",
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function marketManager() view returns (address)",
  "function comptroller() view returns (address)",
  "function oracle() view returns (address)",
]);
const BEACON = new ethers.Interface(["function implementation() view returns (address)"]);

const SELECTOR_SIGS = {
  marketListing: ["listMarket(address)", "addMarket(address)", "supportMarket(address)", "setMarket(address,bool)"],
  supplyRedeem: ["deposit(address,uint256)", "deposit(uint256,address)", "withdraw(address,uint256)", "withdraw(uint256,address,address)", "redeem(uint256)", "mint(uint256)"],
  borrowRepay: ["borrow(address,uint256)", "borrow(uint256)", "borrow(address,uint256,address)", "repay(address,uint256)", "repayBorrow(uint256)"],
  liquidate: ["liquidate(address,address,uint256)", "liquidateBorrow(address,uint256,address)", "seize(address,address,uint256)"],
  admin: ["pause()", "unpause()", "setPaused(bool)", "setBorrowCap(address,uint256)", "setOracle(address)", "setMarketConfig(address,uint256)", "upgradeTo(address)"],
};

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function safeText(value, max = 140) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`; }
function unitsToNumber(value, decimals = 18) { try { const n = Number(ethers.formatUnits(BigInt(value ?? 0), Number(decimals))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function toHexBlock(value) { return `0x${Math.max(0, Number(value) || 0).toString(16)}`; }
function slotAddress(raw) { const hex = strip0x(raw || "").padStart(64, "0"); if (!hex || /^0+$/.test(hex)) return null; return normalizeAddress(`0x${hex.slice(-40)}`); }
function decodeBytes32String(value) { try { return safeText(ethers.decodeBytes32String(value), 40); } catch (_) { return null; } }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-native-credit-phase0/1.0" } });
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

async function getStorageAddress(rpc, address, slot) {
  const raw = await rpcCall(rpc, "eth_getStorageAt", [address, slot, "latest"], 10_000).catch(() => null);
  return slotAddress(raw);
}

async function proxyMeta(rpc, address) {
  const [impl, admin, beacon] = await Promise.all([
    getStorageAddress(rpc, address, EIP1967_IMPL),
    getStorageAddress(rpc, address, EIP1967_ADMIN),
    getStorageAddress(rpc, address, EIP1967_BEACON),
  ]);
  const beaconImpl = beacon ? await safeCall(rpc, beacon, BEACON, "implementation") : null;
  return { eip1967Implementation: impl, eip1967Admin: admin, eip1967Beacon: beacon, eip1967BeaconImplementation: normalizeAddress(beaconImpl?.[0]) };
}

async function latestBlock(rpc) {
  const hex = await rpcCall(rpc, "eth_blockNumber", [], 10_000).catch(() => null);
  return hex ? parseInt(hex, 16) : null;
}

function protocolMetadata(apiRaw) {
  const d = readJson(PUBLIC_TARGETS, {});
  const rows = [...(d.phase0Queue || []), ...(d.targetedRefreshQueue || []), ...(d.protocolCandidates || []), ...(d.targets || [])];
  const row = rows.find((p) => p?.slug === "native-credit-pool" || p?.name === "Native Credit Pool");
  const apiTvl = Array.isArray(apiRaw?.tvl) ? asNumber(apiRaw.tvl.slice(-1)?.[0]?.totalLiquidityUSD) : asNumber(apiRaw?.tvl);
  const chainMetrics = latestChainMetrics(apiRaw);
  return {
    name: apiRaw?.name || row?.name || "Native Credit Pool",
    slug: apiRaw?.slug || row?.slug || "native-credit-pool",
    category: apiRaw?.category || row?.category || "Lending",
    module: apiRaw?.module || "native-lend/index.js",
    tvlCodePath: apiRaw?.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/native-lend/index.js",
    methodology: safeText(apiRaw?.methodology || "Gets assets deposited by LPs in Native Credit Pool for PMMs to facilitate trades for Native Swap.", 260),
    description: safeText(apiRaw?.description || row?.description, 260),
    audits: apiRaw?.audits ?? null,
    chains: apiRaw?.chains || row?.chains || ["Ethereum", "BNB Chain", "Base", "Arbitrum", "Monad"],
    evmChains: row?.evmChains || ["Ethereum", "BNB Chain", "Base", "Arbitrum"],
    tvlUsd: round(apiTvl || row?.tvlUsd, 2),
    defillamaChainTvls: chainMetrics.chainTvls,
    defillamaBorrowedTvls: chainMetrics.borrowedTvls,
    defillamaBorrowedUsd: chainMetrics.borrowedTotalUsd,
    change1dPct: row?.change1dPct ?? apiRaw?.change_1d ?? null,
    change7dPct: row?.change7dPct ?? apiRaw?.change_7d ?? null,
    routePriority: row?.routePriority || null,
    sourceAvailability: "adapter-and-live-bytecode; no public Native Credit source repo resolved in this pass",
  };
}

function latestChainMetrics(apiRaw) {
  const chainTvls = {};
  const borrowedTvls = {};
  for (const [key, value] of Object.entries(apiRaw?.chainTvls || {})) {
    const latest = Array.isArray(value?.tvl) ? value.tvl.at(-1)?.totalLiquidityUSD : null;
    const rounded = round(latest, 2);
    if (rounded === null) continue;
    if (key === "borrowed") continue;
    if (key.endsWith("-borrowed")) borrowedTvls[key.replace(/-borrowed$/, "")] = rounded;
    else chainTvls[key] = rounded;
  }
  const borrowedTotalUsd = round(Array.isArray(apiRaw?.chainTvls?.borrowed?.tvl) ? apiRaw.chainTvls.borrowed.tvl.at(-1)?.totalLiquidityUSD : null, 2)
    ?? round(Object.values(borrowedTvls).reduce((acc, value) => acc + (asNumber(value) || 0), 0), 2);
  return { chainTvls, borrowedTvls, borrowedTotalUsd };
}

function decodeMarketListed(log) {
  try {
    const parsed = LP.parseLog({ topics: log.topics || [], data: log.data || "0x" });
    const addr = normalizeAddress(parsed?.args?.lpToken ?? parsed?.args?.[0]);
    if (addr) return addr;
  } catch (_) {}
  const topicAddr = log.topics?.[1] ? normalizeAddress(`0x${String(log.topics[1]).slice(-40)}`) : null;
  if (topicAddr) return topicAddr;
  const data = strip0x(log.data || "");
  return data.length >= 64 ? normalizeAddress(`0x${data.slice(-40)}`) : null;
}

async function getLogsBounded(rpc, chain, latest) {
  if (!rpc || !latest || !chain.vaultFromBlock || chain.vaultFromBlock > latest) return { logs: [], errors: [], chunks: 0 };
  const span = latest - chain.vaultFromBlock + 1;
  const chunkSize = Math.max(chain.logChunkBlocks || 500000, Math.ceil(span / MAX_LOG_CHUNKS));
  const logs = [];
  const errors = [];
  let errorCount = 0;
  let chunks = 0;
  for (let from = chain.vaultFromBlock; from <= latest; from += chunkSize) {
    const to = Math.min(latest, from + chunkSize - 1);
    chunks++;
    const res = await rpcCall(rpc, "eth_getLogs", [{ address: chain.vault, fromBlock: toHexBlock(from), toBlock: toHexBlock(to), topics: [MARKET_LISTED_TOPIC] }], 25_000).catch(() => null);
    if (Array.isArray(res)) logs.push(...res);
    else {
      errorCount++;
      if (errors.length < 12) errors.push({ fromBlock: from, toBlock: to, reason: "eth_getLogs returned no array" });
    }
  }
  return { logs, errors, errorCount, chunks };
}

function selectorHits(code) {
  const body = strip0x(code).toLowerCase();
  const out = {};
  for (const [group, sigs] of Object.entries(SELECTOR_SIGS)) {
    const hits = [];
    for (const sig of sigs) {
      const sel = ethers.id(sig).slice(2, 10).toLowerCase();
      if (body.includes(sel)) hits.push(sig);
    }
    out[group] = hits;
  }
  return out;
}

async function tokenMeta(rpc, token) {
  const address = normalizeAddress(token);
  if (!address) return { address: null, symbol: null, name: null, decimals: 18 };
  const [symbol, symbolB32, name, nameB32, decimals] = await Promise.all([
    safeCall(rpc, address, ERC20, "symbol"),
    safeCall(rpc, address, BYTES32_META, "symbol"),
    safeCall(rpc, address, ERC20, "name"),
    safeCall(rpc, address, BYTES32_META, "name"),
    safeCall(rpc, address, ERC20, "decimals"),
  ]);
  return {
    address,
    symbol: safeText(symbol?.[0], 40) || decodeBytes32String(symbolB32?.[0]) || "UNKNOWN",
    name: safeText(name?.[0], 100) || decodeBytes32String(nameB32?.[0]),
    decimals: decimals?.[0] === undefined ? 18 : Number(decimals[0]),
  };
}

async function fetchPrices(markets) {
  const ids = unique(markets.map((m) => `${m.coinSlug}:${normalizeAddress(m.underlying)}`).filter((id) => !id.endsWith(":null")));
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${ids.slice(i, i + 50).join(",")}?searchWidth=6h`, 30_000) || { coins: {} };
    for (const [key, value] of Object.entries(json.coins || {})) out[key.toLowerCase()] = asNumber(value.price);
  }
  return out;
}

function priceFor(market, prices) {
  return prices[`${market.coinSlug}:${normalizeAddress(market.underlying)}`.toLowerCase()] ?? null;
}

async function tokenBalance(rpc, token, owner) {
  const res = await safeCall(rpc, token, ERC20, "balanceOf", [owner]);
  return res?.[0] === undefined ? 0n : toBig(res[0]);
}

async function lpAddressValue(rpc, lp, fn) {
  const res = await safeCall(rpc, lp, LP, fn);
  return normalizeAddress(res?.[0]);
}

async function lpNumericValue(rpc, lp, fn) {
  const res = await safeCall(rpc, lp, LP, fn);
  return res?.[0] === undefined ? null : toBig(res[0]);
}

async function lpBoolValue(rpc, lp, fn) {
  const res = await safeCall(rpc, lp, LP, fn);
  return res?.[0] === undefined ? null : Boolean(res[0]);
}

async function lpAddressFn(rpc, lp, fn) {
  const res = await safeCall(rpc, lp, LP, fn);
  return normalizeAddress(res?.[0]);
}

async function scanChain(rpc, chain) {
  if (!chain.chainId) return { chain: chain.chain, chainId: null, vault: chain.vault, rpcResolved: false, unsupportedReason: chain.unsupportedReason, vaultCodePresent: false, markets: [], logErrors: [] };
  if (!rpc) return { chain: chain.chain, chainId: chain.chainId, vault: chain.vault, rpcResolved: false, unsupportedReason: "No RPC resolved", vaultCodePresent: false, markets: [], logErrors: [] };
  const latest = await latestBlock(rpc);
  const vaultCode = await getCode(rpc, chain.vault);
  const vaultCodePresent = vaultCode.length > 10;
  const vaultProxy = vaultCodePresent ? await proxyMeta(rpc, chain.vault) : {};
  const vaultSelectorHits = vaultCodePresent ? selectorHits(vaultCode) : {};
  const logsResult = vaultCodePresent ? await getLogsBounded(rpc, chain, latest) : { logs: [], errors: [], chunks: 0 };
  const listedLpAddresses = unique(logsResult.logs.map(decodeMarketListed).filter(Boolean));
  const markets = [];
  for (const lp of listedLpAddresses) {
    const lpCode = await getCode(rpc, lp);
    const codePresent = lpCode.length > 10;
    const underlying = await lpAddressValue(rpc, lp, "underlying") || await lpAddressValue(rpc, lp, "asset");
    const meta = underlying ? await tokenMeta(rpc, underlying) : { address: null, symbol: null, name: null, decimals: 18 };
    const [totalUnderlying, totalAssets, getCash, cashFn, totalBorrowedFn, totalBorrows, balanceRaw, lpSupply, borrowCap, supplyCap, paused, isPaused, owner, admin, marketManager, comptroller, oracle] = await Promise.all([
      lpNumericValue(rpc, lp, "totalUnderlying"),
      lpNumericValue(rpc, lp, "totalAssets"),
      lpNumericValue(rpc, lp, "getCash"),
      lpNumericValue(rpc, lp, "cash"),
      lpNumericValue(rpc, lp, "totalBorrowed"),
      lpNumericValue(rpc, lp, "totalBorrows"),
      underlying ? tokenBalance(rpc, underlying, chain.vault) : Promise.resolve(0n),
      lpNumericValue(rpc, lp, "totalSupply"),
      lpNumericValue(rpc, lp, "borrowCap"),
      lpNumericValue(rpc, lp, "supplyCap"),
      lpBoolValue(rpc, lp, "paused"),
      lpBoolValue(rpc, lp, "isPaused"),
      lpAddressFn(rpc, lp, "owner"),
      lpAddressFn(rpc, lp, "admin"),
      lpAddressFn(rpc, lp, "marketManager"),
      lpAddressFn(rpc, lp, "comptroller"),
      lpAddressFn(rpc, lp, "oracle"),
    ]);
    const lockedRaw = totalUnderlying ?? totalAssets ?? 0n;
    const cashRaw = getCash ?? cashFn ?? balanceRaw;
    const borrowedRaw = totalBorrowedFn ?? totalBorrows ?? (lockedRaw > cashRaw ? lockedRaw - cashRaw : 0n);
    markets.push({
      chain: chain.chain,
      chainId: chain.chainId,
      vault: normalizeAddress(chain.vault),
      lpToken: normalizeAddress(lp),
      codePresent,
      codeBytes: codePresent ? Math.floor((lpCode.length - 2) / 2) : 0,
      underlying: meta.address,
      underlyingSymbol: meta.symbol,
      underlyingName: meta.name,
      underlyingDecimals: meta.decimals,
      totalUnderlyingRaw: lockedRaw.toString(),
      vaultCashRaw: cashRaw.toString(),
      borrowedRaw: borrowedRaw.toString(),
      lpSupplyRaw: lpSupply?.toString() ?? null,
      totalUnderlying: round(unitsToNumber(lockedRaw, meta.decimals), 8),
      vaultCash: round(unitsToNumber(cashRaw, meta.decimals), 8),
      borrowed: round(unitsToNumber(borrowedRaw, meta.decimals), 8),
      borrowCap: borrowCap === null ? null : round(unitsToNumber(borrowCap, meta.decimals), 8),
      supplyCap: supplyCap === null ? null : round(unitsToNumber(supplyCap, meta.decimals), 8),
      paused: paused ?? isPaused,
      owner,
      admin,
      marketManager,
      comptroller,
      oracle,
      proxy: codePresent ? await proxyMeta(rpc, lp) : {},
      selectorHits: codePresent ? selectorHits(lpCode) : {},
      routePositive: false,
    });
  }
  return {
    chain: chain.chain,
    key: chain.key,
    chainId: chain.chainId,
    vault: normalizeAddress(chain.vault),
    rpcResolved: true,
    latestBlock: latest,
    vaultFromBlock: chain.vaultFromBlock,
    vaultCodePresent,
    vaultCodeBytes: vaultCodePresent ? Math.floor((vaultCode.length - 2) / 2) : 0,
    vaultProxy,
    vaultSelectorHits,
    logChunks: logsResult.chunks,
    logErrors: logsResult.errors,
    logErrorCount: logsResult.errorCount || 0,
    listedMarketEvents: logsResult.logs.length,
    listedLpAddresses: listedLpAddresses.length,
    markets,
  };
}

function attachUsd(markets, prices) {
  for (const market of markets) {
    const price = priceFor(market, prices);
    market.priceUsd = round(price, 10);
    market.totalUnderlyingUsd = price === null ? null : round((market.totalUnderlying || 0) * price, 2);
    market.vaultCashUsd = price === null ? null : round((market.vaultCash || 0) * price, 2);
    market.borrowedUsd = price === null ? null : round((market.borrowed || 0) * price, 2);
    market.borrowUtilizationPct = market.totalUnderlying && market.totalUnderlying > 0 ? round(((market.borrowed || 0) / market.totalUnderlying) * 100, 4) : null;
  }
}

function findConsumerJoins(addressRows) {
  const rows = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) {
    const file = path.join(WORKSPACE, rel);
    const text = readText(file).toLowerCase();
    if (!text) continue;
    for (const row of addressRows) {
      const addr = lowerAddress(row.address);
      if (!addr || !text.includes(addr)) continue;
      rows.push({ source, artifact: rel, role: row.role, chain: row.chain, address: row.address, symbol: row.symbol || null, direct: DIRECT_ROLES.has(row.role), routePositive: false });
    }
  }
  return rows;
}

function sumUsd(rows, field) { return round(rows.reduce((acc, row) => acc + (asNumber(row[field]) || 0), 0), 2); }
function countMaterial(rows, field) { return rows.filter((row) => (asNumber(row[field]) || 0) >= MATERIAL_USD).length; }

function writeReport(raw) {
  const s = raw.summary;
  const lines = [];
  lines.push(`# ${SIGNAL_DORMANT} — Native Credit Pool Phase 0`);
  lines.push("");
  lines.push(`Generated: ${raw.generatedAt}`);
  lines.push("");
  lines.push("## Result");
  lines.push("");
  lines.push("No permissionless route-positive exploit is claimed. Native Credit maps as adapter-discovered vault-owned LP markets used by PMMs, with source limited to the public DeFiLlama adapter plus live bytecode in this pass.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---:|");
  lines.push(`| Public TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |`);
  lines.push(`| Public borrowed context | ${formatUsd(s.defillamaBorrowedUsd)} |`);
  lines.push(`| Chains scanned | \`${s.chainsScanned}\` |`);
  lines.push(`| Vault rows with code | \`${s.vaultRowsWithCode}\` |`);
  lines.push(`| LP markets resolved | \`${s.marketRows}\` |`);
  lines.push(`| Material cash rows | \`${s.materialCashRows}\` |`);
  lines.push(`| Material borrowed rows | \`${s.materialBorrowedRows}\` |`);
  lines.push(`| RPC-resolved vault cash context | ${formatUsd(s.totalVaultCashUsd)} |`);
  lines.push(`| RPC-resolved borrowed context | ${formatUsd(s.totalBorrowedUsd)} |`);
  lines.push(`| Direct consumer joins | \`${s.directConsumerRows}\` |`);
  lines.push(`| Token context joins | \`${s.tokenContextRows}\` |`);
  lines.push(`| Watch candidates | \`${s.watchCandidates}\` |`);
  lines.push(`| Route-positive | \`${s.routePositive}\` |`);
  lines.push("");
  lines.push("## Chain Coverage");
  lines.push("");
  lines.push("| Chain | Vault | Code | Listed LPs | Markets | Log chunks | Log errors |");
  lines.push("|---|---|---:|---:|---:|---:|---:|");
  for (const row of raw.chainRows) {
    lines.push(`| ${row.chain} | \`${compactAddress(row.vault)}\` | ${row.vaultCodePresent ? "yes" : "no"} | \`${row.listedLpAddresses || 0}\` | \`${row.markets?.length || 0}\` | \`${row.logChunks || 0}\` | \`${row.logErrorCount || row.logErrors?.length || 0}\` |`);
  }
  lines.push("");
  lines.push("## Top Market Rows");
  lines.push("");
  lines.push("| Chain | LP | Asset | Cash | Borrowed | Utilization | Selector hints |");
  lines.push("|---|---|---|---:|---:|---:|---|");
  for (const row of raw.marketRows.slice().sort((a, b) => (asNumber(b.totalUnderlyingUsd) || 0) - (asNumber(a.totalUnderlyingUsd) || 0)).slice(0, 12)) {
    const hints = Object.entries(row.selectorHits || {}).filter(([, hits]) => hits.length).map(([k, hits]) => `${k}:${hits.length}`).join(", ") || "none";
    lines.push(`| ${row.chain} | \`${compactAddress(row.lpToken)}\` | ${row.underlyingSymbol || "UNKNOWN"} | ${formatUsd(row.vaultCashUsd)} | ${formatUsd(row.borrowedUsd)} | ${row.borrowUtilizationPct === null ? "n/a" : `${row.borrowUtilizationPct}%`} | ${safeText(hints, 80)} |`);
  }
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  lines.push("- DeFiLlama adapter exposes vault cash and borrowed accounting but not account-level PMM borrower health or a public liquidation path.");
  lines.push("- No direct Native vault/LP consumer join mapped to material external lending, oracle, redemption, bridge, or liquidation economics.");
  lines.push("- Borrow-like and admin selector hints are bytecode context only; source/ABI and role checks are required before any static-call/fork proof.");
  lines.push("- Monad adapter row is out of current sanitized RPC scope.");
  lines.push("- BNB/Arbitrum historical log coverage is bounded by RPC `eth_getLogs` range limits; public DeFiLlama chain TVL/borrowed values are retained as context.");
  lines.push("- No exact positive borrow, repay, withdrawal, liquidation, redemption, or DEX unwind economics and no fork extraction proof.");
  lines.push("");
  lines.push("## Required For Route-Positive");
  lines.push("");
  lines.push("- Exact Native vault or LP function path is permissionless and changes cash, debt, accounting, or withdrawals in an attacker-favorable way.");
  lines.push("- The affected asset maps to material borrow, redemption, liquidation, or DEX unwind liquidity.");
  lines.push("- Static-call/fork proof demonstrates positive economics after gas, slippage, and fees.");
  lines.push("- Signed action remains fail-closed until explicit authorization and route-specific gates pass.");
  lines.push("");
  lines.push("## Next Read-Only Step");
  lines.push("");
  lines.push("Reopen Native Credit only if verified source/ABI or a live account/role endpoint maps the vault/LP accounting to permissionless material borrow, withdrawal, liquidation, or consumer economics.");
  lines.push("");
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, `${lines.join("\n")}\n`);
}

async function main() {
  const apiRaw = await fetchJson("https://api.llama.fi/protocol/native-credit-pool", 45_000);
  const protocol = protocolMetadata(apiRaw);
  const supportedChains = CHAINS.filter((row) => row.chainId).map((row) => row.chainId);
  const rpcPool = await resolveRpcPool(supportedChains);
  const chainRows = [];
  for (const chain of CHAINS) {
    chainRows.push(await scanChain(chain.chainId ? rpcPool[chain.chainId] : null, chain));
  }
  const marketRows = chainRows.flatMap((row) => row.markets || []);
  const prices = await fetchPrices(marketRows.map((row) => ({ coinSlug: CHAINS.find((c) => c.chain === row.chain)?.coinSlug, underlying: row.underlying })));
  for (const market of marketRows) market.coinSlug = CHAINS.find((c) => c.chain === market.chain)?.coinSlug;
  attachUsd(marketRows, prices);

  const addressRows = [];
  for (const chain of chainRows) {
    if (chain.vault) addressRows.push({ role: "vault", chain: chain.chain, address: chain.vault });
    for (const market of chain.markets || []) {
      addressRows.push({ role: "lpMarket", chain: market.chain, address: market.lpToken, symbol: market.underlyingSymbol });
      if (market.underlying) addressRows.push({ role: "underlyingToken", chain: market.chain, address: market.underlying, symbol: market.underlyingSymbol });
    }
  }
  const artifactJoinRows = findConsumerJoins(addressRows);
  const directConsumerRows = artifactJoinRows.filter((row) => row.direct);
  const tokenContextRows = artifactJoinRows.filter((row) => !row.direct);
  const codeSelectorRows = [
    ...chainRows.filter((row) => Object.values(row.vaultSelectorHits || {}).some((hits) => hits.length)).map((row) => ({ chain: row.chain, role: "vault", address: row.vault, selectorHits: row.vaultSelectorHits })),
    ...marketRows.filter((row) => Object.values(row.selectorHits || {}).some((hits) => hits.length)).map((row) => ({ chain: row.chain, role: "lpMarket", address: row.lpToken, symbol: row.underlyingSymbol, selectorHits: row.selectorHits })),
  ];
  const watchCandidates = directConsumerRows.length > 0 ? directConsumerRows.length : 0;
  const summary = {
    defillamaCurrentTvlUsd: protocol.tvlUsd,
    defillamaBorrowedUsd: protocol.defillamaBorrowedUsd,
    defillamaChainTvls: protocol.defillamaChainTvls,
    defillamaBorrowedTvls: protocol.defillamaBorrowedTvls,
    chainsConfigured: CHAINS.length,
    chainsScanned: chainRows.filter((row) => row.rpcResolved).length,
    unsupportedChains: chainRows.filter((row) => row.unsupportedReason).length,
    vaultRows: chainRows.length,
    vaultRowsWithCode: chainRows.filter((row) => row.vaultCodePresent).length,
    marketRows: marketRows.length,
    marketRowsWithCode: marketRows.filter((row) => row.codePresent).length,
    materialCashRows: countMaterial(marketRows, "vaultCashUsd"),
    materialBorrowedRows: countMaterial(marketRows, "borrowedUsd"),
    totalVaultCashUsd: sumUsd(marketRows, "vaultCashUsd"),
    totalBorrowedUsd: sumUsd(marketRows, "borrowedUsd"),
    maxMarketTotalUnderlyingUsd: round(Math.max(0, ...marketRows.map((row) => asNumber(row.totalUnderlyingUsd) || 0)), 2),
    maxMarketBorrowedUsd: round(Math.max(0, ...marketRows.map((row) => asNumber(row.borrowedUsd) || 0)), 2),
    directConsumerRows: directConsumerRows.length,
    tokenContextRows: tokenContextRows.length,
    artifactJoinRows: artifactJoinRows.length,
    selectorHintRows: codeSelectorRows.length,
    logErrorRows: chainRows.reduce((acc, row) => acc + (row.logErrorCount ?? row.logErrors?.length ?? 0), 0),
    watchCandidates,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    coverageClassification: "bounded-with-caveats",
    status: "closed-route-positive-zero",
  };
  const raw = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-native-credit-pool-phase0.js",
    signal: SIGNAL_DORMANT,
    protocol,
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, calldataStored: false, borrowerAddressesStored: false, routePositive: false, signedActionJustified: false },
    adapterContext: {
      module: "native-lend/index.js",
      vaultDiscovery: "MarketListed(address) logs from adapter-declared vaultFromBlock, then LP underlying()/totalUnderlying() plus vault token balanceOf(vault)",
      unsupported: ["Monad adapter row skipped: no current sanitized RPC support"],
    },
    summary,
    chainRows,
    marketRows,
    artifactJoinRows: artifactJoinRows.slice(0, 200),
    directConsumerRows,
    tokenContextRows: tokenContextRows.slice(0, 120),
    codeSelectorRows: codeSelectorRows.slice(0, 120),
    blockers: [
      "Adapter exposes vault/LP accounting but no account-level PMM borrower health or public liquidation path",
      "No direct Native vault/LP consumer route with material external economics",
      "Bytecode selector hits are context only until verified source/ABI and role checks are available",
      "BNB/Arbitrum historical log coverage is bounded by RPC eth_getLogs range limits",
      "Monad adapter row is outside current sanitized RPC scope",
      "No exact positive route or fork extraction proof",
    ],
    requiredForRoutePositive: [
      "permissionless Native vault/LP accounting or withdrawal/borrow path with material impact",
      "material borrow, redemption, liquidation, or DEX unwind liquidity",
      "static-call/fork proof with positive economics after costs",
      "explicit authorization before any signed action",
    ],
    nextReadOnlyStep: "Reopen only if verified source/ABI or account/role state maps Native vault/LP accounting to material permissionless economics.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, JSON.stringify(raw, jsonReplacer, 2));
  writeReport(raw);
  if (!QUIET) {
    console.log(`Native Credit Pool Phase 0: markets=${summary.marketRows} directConsumers=${summary.directConsumerRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(`Native Credit Pool Phase 0 failed: ${safeText(err?.message || err, 160)}`);
  process.exit(1);
});
