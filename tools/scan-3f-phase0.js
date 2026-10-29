#!/usr/bin/env node
// scan-3f-phase0.js - read-only Phase 0 for 3F wrapper-token TVL and consumer joins.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool, loadRpcUrls, PUBLIC_FALLBACKS } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "3f-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "3f-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const ETHEREUM_CHAIN_ID = 1;
const CHAIN = "Ethereum";
const COIN_SLUG = "ethereum";
const FACTORY = "0x54f862fa0612a8709f6dec4a7b39af015cd4e82e";
const ADAPTER_FROM_BLOCK = 24841246;
const LOG_CHUNK_BLOCKS = Number(process.env.THREE_F_LOG_CHUNK_BLOCKS || "100000");
const MIN_LOG_CHUNK_BLOCKS = Number(process.env.THREE_F_MIN_LOG_CHUNK_BLOCKS || "5000");
const HISTORICAL_PROBE_BLOCKS = Number(process.env.THREE_F_HISTORICAL_PROBE_BLOCKS || "50000");
const MIN_MATERIAL_BALANCE_USD = Number(process.env.THREE_F_MIN_MATERIAL_BALANCE_USD || "100000");
const ZERO = "0x0000000000000000000000000000000000000000";
const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";

const DEPLOY = new ethers.Interface([
  "event Deployed(address indexed proxy, address indexed implementation, address indexed admin)",
]);
const WRAPPER = new ethers.Interface([
  "function underlying() view returns (address)",
  "function asset() view returns (address)",
  "function balanceOf(address account) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const BYTES32_TOKEN = new ethers.Interface(["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"]);
const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
]);

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

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
const DIRECT_SOURCE_SET = new Set([
  "aave-euler-silo",
  "consumer-first-high-ltv",
  "seven-chain-lending",
  "stablecoin-depeg",
  "erc4626-consumer",
  "evault-collateral-nav",
  "focused-morpho",
  "focused-euler",
  "morpho-pyth-unsafe-consumers",
  "morpho-exit-liquidity-stress",
  "morpho-public-allocator",
  "morpho-liquidatable",
  "morpho-wrapper-exit",
  "pool-share-snapshot",
  "public-lead-consumer",
  "pendle-pt",
  "silo-pt",
  "dex-consumer-routes",
  "bridge-proof-binding",
  "bridge-synthetic-consumer",
]);
const DIRECT_ROLES = new Set(["wrapper"]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function safeText(value, max = 140) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function decodeBytes32String(value) { try { return safeText(ethers.decodeBytes32String(value), 40); } catch (_) { return null; } }
function asNumber(value) { const n = typeof value === "number" ? value : Number(String(value ?? "").replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const factor = 10 ** decimals; return Math.round(n * factor) / factor; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatNumber(value, decimals = 6) { const n = asNumber(value); return n === null ? "n/a" : n.toLocaleString(undefined, { maximumFractionDigits: decimals }); }
function decimalsToNumber(value, decimals) { try { if (value === null || value === undefined || decimals === null || decimals === undefined) return null; const n = Number(ethers.formatUnits(BigInt(value), Number(decimals))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function toHexBlock(n) { return `0x${Math.max(0, Number(n) || 0).toString(16)}`; }
function addressFromStorageSlot(raw) { if (!raw || raw === "0x") return null; const hex = strip0x(raw).padStart(64, "0"); if (/^0+$/.test(hex)) return null; return normalizeAddress(`0x${hex.slice(-40)}`); }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-3f-phase0/1.0" } });
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

async function getStorage(rpc, address, slot) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return null;
  return await rpcCall(rpc, "eth_getStorageAt", [addr, slot, "latest"], 10_000).catch(() => null);
}

async function latestBlock(rpc) {
  const hex = await rpcCall(rpc, "eth_blockNumber", [], 10_000).catch(() => null);
  return hex ? parseInt(hex, 16) : null;
}

function discoveryRows() {
  const d = readJson(PUBLIC_TARGETS, {});
  return [...(d.phase0Queue || []), ...(d.consumerJoinFirst || []), ...(d.protocolCandidates || []), ...(d.targetedRefreshQueue || []), ...(d.yieldCandidates || []), ...(d.targets || []), ...(d.value || [])];
}

function protocolMetadata(apiRaw) {
  const row = discoveryRows().find((p) => p?.slug === "3f" || p?.name === "3F");
  const apiChainTvl = asNumber(apiRaw?.currentChainTvls?.Ethereum);
  const apiTvl = apiChainTvl || asNumber(apiRaw?.tvl?.slice?.(-1)?.[0]?.totalLiquidityUSD);
  return {
    name: apiRaw?.name || row?.name || "3F",
    slug: apiRaw?.slug || row?.slug || "3f",
    category: apiRaw?.category || row?.category || "RWA Lending",
    chains: apiRaw?.chains || row?.chains || [CHAIN],
    evmChains: row?.evmChains || [CHAIN],
    tvlUsd: round(apiTvl || row?.tvlUsd, 2),
    change1dPct: row?.change1dPct ?? apiRaw?.change_1d ?? null,
    change7dPct: row?.change7dPct ?? apiRaw?.change_7d ?? null,
    routePriority: row?.routePriority || null,
    source: apiRaw ? "api.llama.fi+public-audit-target-discovery" : "public-audit-target-discovery",
  };
}

async function supportsHistoricalDeployLogs(rpc) {
  if (!rpc) return false;
  const id = await rpcCall(rpc, "eth_chainId", [], 4_000).catch(() => null);
  if (!id || parseInt(id, 16) !== ETHEREUM_CHAIN_ID) return false;
  const to = ADAPTER_FROM_BLOCK + HISTORICAL_PROBE_BLOCKS - 1;
  const logs = await rpcCall(rpc, "eth_getLogs", [{ address: normalizeAddress(FACTORY), fromBlock: toHexBlock(ADAPTER_FROM_BLOCK), toBlock: toHexBlock(to), topics: [DEPLOY.getEvent("Deployed").topicHash] }], 15_000).catch(() => null);
  return Array.isArray(logs);
}

async function resolveHistoricalLogRpc(fallbackRpc) {
  const sanitized = { historicalSupported: false, selected: "default", candidatesTested: 0, supportingCandidatesSeen: 0 };
  if (await supportsHistoricalDeployLogs(fallbackRpc)) {
    sanitized.historicalSupported = true;
    sanitized.candidatesTested = 1;
    return { rpc: fallbackRpc, sanitized };
  }
  const urls = [...loadRpcUrls(), PUBLIC_FALLBACKS[ETHEREUM_CHAIN_ID]].filter(Boolean);
  const seen = new Set();
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sanitized.candidatesTested += 1;
    const ok = await supportsHistoricalDeployLogs(url);
    if (!ok) continue;
    sanitized.historicalSupported = true;
    sanitized.supportingCandidatesSeen += 1;
    sanitized.selected = fallbackRpc && url === fallbackRpc ? "default" : "historical-capable-inventory-candidate";
    return { rpc: url, sanitized };
  }
  return { rpc: fallbackRpc, sanitized };
}

async function getLogsChunked(rpc, filter, fromBlock, toBlock) {
  const out = [];
  const errors = [];
  let chunks = 0;
  let chunkBlocks = LOG_CHUNK_BLOCKS;
  let start = Number(fromBlock);
  const last = Number(toBlock);
  while (start <= last) {
    const end = Math.min(last, start + chunkBlocks - 1);
    const part = await rpcCall(rpc, "eth_getLogs", [{ ...filter, fromBlock: toHexBlock(start), toBlock: toHexBlock(end) }], 15_000);
    if (Array.isArray(part)) {
      out.push(...part);
      chunks += 1;
      start = end + 1;
      if (chunkBlocks < LOG_CHUNK_BLOCKS && part.length < 2000) chunkBlocks = Math.min(LOG_CHUNK_BLOCKS, chunkBlocks * 2);
      continue;
    }
    if (chunkBlocks > MIN_LOG_CHUNK_BLOCKS) {
      chunkBlocks = Math.max(MIN_LOG_CHUNK_BLOCKS, Math.floor(chunkBlocks / 2));
      continue;
    }
    errors.push({ fromBlock: start, toBlock: end, reason: "eth_getLogs-null-result" });
    chunks += 1;
    start = end + 1;
  }
  return { logs: out, chunks, errors };
}

function parseDeployLog(log) {
  try {
    const parsed = DEPLOY.parseLog(log);
    return {
      chainId: ETHEREUM_CHAIN_ID,
      chain: CHAIN,
      wrapper: normalizeAddress(parsed.args.proxy),
      eventImplementation: normalizeAddress(parsed.args.implementation),
      eventAdmin: normalizeAddress(parsed.args.admin),
      blockNumber: parseInt(log.blockNumber, 16),
      transactionHash: log.transactionHash || null,
      routePositive: false,
    };
  } catch (_) { return null; }
}

async function loadPrices(addresses) {
  const keys = unique(addresses.map((addr) => normalizeAddress(addr)).filter(Boolean).map((addr) => `${COIN_SLUG}:${addr.toLowerCase()}`));
  const out = {};
  for (let i = 0; i < keys.length; i += 80) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.slice(i, i + 80).join(",")}?searchWidth=6h`, 30_000);
    for (const [key, value] of Object.entries(json?.coins || {})) {
      const price = asNumber(value?.price);
      if (price !== null) out[key.toLowerCase()] = { price, symbol: safeText(value?.symbol, 40), confidence: asNumber(value?.confidence), timestamp: value?.timestamp ?? null };
    }
  }
  return out;
}

async function tokenMeta(rpc, address, prices) {
  const addr = normalizeAddress(address);
  if (!addr) return null;
  const [code, decimalsRaw, symbolRaw, symbolBytesRaw, nameRaw, nameBytesRaw, totalSupplyRaw] = await Promise.all([
    getCode(rpc, addr),
    safeCall(rpc, addr, WRAPPER, "decimals"),
    safeCall(rpc, addr, WRAPPER, "symbol"),
    safeCall(rpc, addr, BYTES32_TOKEN, "symbol"),
    safeCall(rpc, addr, WRAPPER, "name"),
    safeCall(rpc, addr, BYTES32_TOKEN, "name"),
    safeCall(rpc, addr, WRAPPER, "totalSupply"),
  ]);
  const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
  const totalSupply = totalSupplyRaw?.[0] === undefined ? null : totalSupplyRaw[0].toString();
  const priceRow = prices[`${COIN_SLUG}:${addr.toLowerCase()}`] || null;
  return {
    address: addr,
    symbol: safeText(symbolRaw?.[0], 40) || decodeBytes32String(symbolBytesRaw?.[0]) || priceRow?.symbol,
    name: safeText(nameRaw?.[0], 80) || decodeBytes32String(nameBytesRaw?.[0]),
    decimals,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    totalSupplyRaw: totalSupply,
    totalSupply: round(decimalsToNumber(totalSupply, decimals), 6),
    priceUsd: priceRow?.price ?? null,
    priceConfidence: priceRow?.confidence ?? null,
    priceTimestamp: priceRow?.timestamp ?? null,
  };
}

async function inspectWrapper(rpc, deployRow, prices) {
  const wrapper = normalizeAddress(deployRow.wrapper);
  const [code, implRaw, adminRaw, beaconRaw, ownerRaw, adminCallRaw, pausedRaw, underlyingRaw, assetRaw, totalAssetsRaw, convertRaw] = await Promise.all([
    getCode(rpc, wrapper),
    getStorage(rpc, wrapper, EIP1967_IMPLEMENTATION_SLOT),
    getStorage(rpc, wrapper, EIP1967_ADMIN_SLOT),
    getStorage(rpc, wrapper, EIP1967_BEACON_SLOT),
    safeCall(rpc, wrapper, COMMON, "owner"),
    safeCall(rpc, wrapper, COMMON, "admin"),
    safeCall(rpc, wrapper, COMMON, "paused"),
    safeCall(rpc, wrapper, WRAPPER, "underlying"),
    safeCall(rpc, wrapper, WRAPPER, "asset"),
    safeCall(rpc, wrapper, WRAPPER, "totalAssets"),
    safeCall(rpc, wrapper, WRAPPER, "convertToAssets", [10n ** 18n]),
  ]);
  const wrapperMeta = await tokenMeta(rpc, wrapper, prices);
  const underlying = normalizeAddress(underlyingRaw?.[0]) || normalizeAddress(assetRaw?.[0]);
  const underlyingMeta = underlying ? await tokenMeta(rpc, underlying, prices) : null;
  const balanceRaw = underlying && underlyingMeta ? await safeCall(rpc, underlying, WRAPPER, "balanceOf", [wrapper]) : null;
  const balance = decimalsToNumber(balanceRaw?.[0]?.toString(), underlyingMeta?.decimals);
  const balanceUsd = balance !== null && underlyingMeta?.priceUsd !== null && underlyingMeta?.priceUsd !== undefined ? balance * underlyingMeta.priceUsd : null;
  const totalAssets = decimalsToNumber(totalAssetsRaw?.[0]?.toString(), underlyingMeta?.decimals);
  const convertToAssets1e18 = decimalsToNumber(convertRaw?.[0]?.toString(), underlyingMeta?.decimals);
  return {
    ...deployRow,
    wrapper,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    eip1967: { implementation: addressFromStorageSlot(implRaw), admin: addressFromStorageSlot(adminRaw), beacon: addressFromStorageSlot(beaconRaw) },
    owner: normalizeAddress(ownerRaw?.[0]),
    admin: normalizeAddress(adminCallRaw?.[0]),
    paused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]),
    wrapperSymbol: wrapperMeta?.symbol || null,
    wrapperName: wrapperMeta?.name || null,
    wrapperDecimals: wrapperMeta?.decimals ?? null,
    wrapperTotalSupplyRaw: wrapperMeta?.totalSupplyRaw ?? null,
    wrapperTotalSupply: wrapperMeta?.totalSupply ?? null,
    underlying,
    underlyingSymbol: underlyingMeta?.symbol || null,
    underlyingName: underlyingMeta?.name || null,
    underlyingDecimals: underlyingMeta?.decimals ?? null,
    underlyingCodePresent: Boolean(underlyingMeta?.codePresent),
    underlyingTotalSupplyRaw: underlyingMeta?.totalSupplyRaw ?? null,
    underlyingTotalSupply: underlyingMeta?.totalSupply ?? null,
    underlyingPriceUsd: round(underlyingMeta?.priceUsd, 8),
    underlyingPriceConfidence: underlyingMeta?.priceConfidence ?? null,
    underlyingBalanceRaw: balanceRaw?.[0] === undefined ? null : balanceRaw[0].toString(),
    underlyingBalance: round(balance, 8),
    underlyingBalanceUsd: round(balanceUsd, 2),
    totalAssetsRaw: totalAssetsRaw?.[0] === undefined ? null : totalAssetsRaw[0].toString(),
    totalAssets: round(totalAssets, 8),
    convertToAssets1e18Raw: convertRaw?.[0] === undefined ? null : convertRaw[0].toString(),
    convertToAssets1e18: round(convertToAssets1e18, 8),
    validAdapterPair: Boolean(underlying && balanceRaw?.[0] !== undefined),
    material: (asNumber(balanceUsd) || 0) >= MIN_MATERIAL_BALANCE_USD,
    routePositive: false,
  };
}

function primitiveAddresses(value, out = new Set()) {
  if (typeof value === "string") { for (const m of value.matchAll(/0x[0-9a-fA-F]{40}/g)) out.add(m[0].toLowerCase()); }
  else if (Array.isArray(value)) { for (const item of value) primitiveAddresses(item, out); }
  else if (value && typeof value === "object") { for (const item of Object.values(value)) primitiveAddresses(item, out); }
  return out;
}

function summarizeContext(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const fields = ["id", "protocol", "project", "name", "chain", "chainId", "marketId", "pair", "surface", "side", "symbol", "asset", "token", "consumer", "collateral", "borrowAsset", "loanAsset", "oracle", "ltv", "lltvPct", "source", "status", "routePositive", "watchCandidate", "liquidityUsd", "routeLiquidityUsd", "borrowCashUsd", "cashUsd", "borrowAssetsUsd", "supplyAssetsUsd", "file", "rootFile"];
  const out = {};
  for (const field of fields) { const value = obj[field]; if (value === undefined) continue; out[field] = typeof value === "object" ? safeText(JSON.stringify(value), 180) : safeText(value, 180); }
  return out;
}

function isContextRecord(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  return ["marketId", "pair", "consumer", "collateral", "loanAsset", "borrowAsset", "oracle", "ltv", "lltvPct", "routeLiquidityUsd", "liquidityUsd", "protocol"].some((field) => obj[field] !== undefined);
}

function scanObjectForAddresses(source, obj, addressRoles, out, depth = 0) {
  if (!obj || depth > 9 || out.length >= 900) return;
  if (Array.isArray(obj)) { for (const item of obj) scanObjectForAddresses(source, item, addressRoles, out, depth + 1); return; }
  if (typeof obj !== "object") return;
  const hits = isContextRecord(obj) ? [...primitiveAddresses(obj)].filter((addr) => addressRoles[addr]) : [];
  if (hits.length) {
    const roles = unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.role)));
    out.push({
      source,
      hitRoles: roles,
      hitAddresses: hits.slice(0, 12),
      wrappers: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.wrapper)).filter(Boolean)).slice(0, 10),
      underlyings: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.underlying)).filter(Boolean)).slice(0, 10),
      context: summarizeContext(obj),
      directConsumer: DIRECT_SOURCE_SET.has(source) && roles.some((role) => DIRECT_ROLES.has(role)),
      routePositive: false,
      blocker: "Local artifact address match is context only unless a 3F wrapper is trusted by consumer logic with exact positive economics",
    });
    return;
  }
  for (const value of Object.values(obj)) scanObjectForAddresses(source, value, addressRoles, out, depth + 1);
}

function dedupeJoinRows(rows) {
  const deduped = new Map();
  for (const row of rows) {
    const contextKey = row.context?.marketId || row.context?.id || row.context?.pair || row.context?.protocol || row.context?.name || JSON.stringify(row.context || {});
    const key = [row.source, contextKey, row.hitRoles.slice().sort().join("/"), row.wrappers.map(lowerAddress).filter(Boolean).sort().join("/"), row.underlyings.map(lowerAddress).filter(Boolean).sort().join("/")].join("|");
    if (!deduped.has(key)) deduped.set(key, row);
  }
  return [...deduped.values()];
}

function localConsumerJoins(wrapperRows) {
  const roles = {};
  function add(addr, role, wrapper, underlying) {
    const lower = lowerAddress(addr);
    if (!lower || lower === ZERO) return;
    if (!roles[lower]) roles[lower] = [];
    roles[lower].push({ role, wrapper, underlying });
  }
  add(FACTORY, "factory", null, null);
  for (const row of wrapperRows) {
    add(row.wrapper, "wrapper", row.wrapper, row.underlying);
    add(row.underlying, "underlying", row.wrapper, row.underlying);
    add(row.eventImplementation, "implementation", row.wrapper, row.underlying);
    add(row.eventAdmin, "admin", row.wrapper, row.underlying);
  }
  const matches = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) { const json = readJson(path.join(WORKSPACE, rel), null); if (json) scanObjectForAddresses(source, json, roles, matches); }
  const deduped = dedupeJoinRows(matches);
  return { wrapperConsumerRows: deduped.filter((row) => row.directConsumer), tokenContextRows: deduped.filter((row) => !row.directConsumer) };
}

function coverageClassification(summary) {
  if (!summary.ethereumRpcAvailable || !summary.factoryCodePresent || summary.logErrors > 0 || summary.historicalLogSupportedChains < summary.chainsWithRpc) return "partial-or-blocked";
  return "full-enough-for-declared-scope";
}

function buildReport(artifact) {
  const s = artifact.summary;
  const hasWrapperConsumers = artifact.wrapperConsumerRows.length > 0;
  const resultText = hasWrapperConsumers
    ? `No confirmed permissionless exploit. DeFiLlama maps 3F through the public \`three-f/index.js\` adapter as wrapper-token TVL: factory deployment logs are enumerated from block ${ADAPTER_FROM_BLOCK}, \`underlying()\` is read on each deployed wrapper, and underlying balances held by wrappers are summed. This pass found 3F wrappers in Morpho Blue collateral/economics artifacts, including material wJAAA and wFalconX rows, but every matched route remains watch-only: no exact positive acquisition, borrow, liquidation, settlement, redemption, or DEX unwind economics were proven.`
    : `No confirmed permissionless exploit. DeFiLlama maps 3F through the public \`three-f/index.js\` adapter as wrapper-token TVL: factory deployment logs are enumerated from block ${ADAPTER_FROM_BLOCK}, \`underlying()\` is read on each deployed wrapper, and underlying balances held by wrappers are summed. This pass found no 3F wrapper accepted by scanned consumer-grade artifacts. Underlying-token matches are context only; route-positive requires a deployed consumer that trusts a 3F wrapper/NAV/accounting path plus exact positive borrow, redemption, liquidation, settlement, or unwind economics.`;
  const consumerBlocker = hasWrapperConsumers
    ? "3F wrapper collateral rows exist in Morpho Blue, but scanned economics remain watch-only without exact positive acquisition, borrow, liquidation, redemption, settlement, or exit proof."
    : "No 3F wrapper address is currently found as collateral, reserve asset, oracle-specific consumer, bridge proof target, or settlement target in scanned consumer-grade artifacts.";
  const wrapperTable = artifact.wrapperRows.map((row) => `| ${compactAddress(row.wrapper)} | ${row.wrapperSymbol || "n/a"} | ${compactAddress(row.underlying)} | ${row.underlyingSymbol || "n/a"} | ${formatNumber(row.underlyingBalance, 8)} | ${formatUsd(row.underlyingBalanceUsd)} | ${row.validAdapterPair ? "yes" : "no"} | ${row.material ? "yes" : "no"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const consumerTable = artifact.wrapperConsumerRows.length ? artifact.wrapperConsumerRows.slice(0, 10).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${row.wrappers.map(compactAddress).join(", ") || "n/a"} | ${safeText(row.context?.pair || row.context?.marketId || row.context?.protocol || row.context?.project || row.context?.name || row.context?.surface || row.context?.file || "context", 80)} |`).join("\n") : "| none | n/a | n/a | n/a | no 3F wrapper address was found in consumer-grade artifacts |";
  const contextTable = artifact.tokenContextRows.length ? artifact.tokenContextRows.slice(0, 8).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${row.underlyings.map(compactAddress).join(", ") || "n/a"} | ${safeText(row.context?.pair || row.context?.marketId || row.context?.protocol || row.context?.project || row.context?.name || row.context?.surface || row.context?.file || "context", 80)} |`).join("\n") : "| none | n/a | n/a | n/a | n/a |";
  return `# ${SIGNAL_DORMANT} - 3F Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

${resultText}

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Ethereum RPC available | ${s.ethereumRpcAvailable ? "yes" : "no"} |
| Historical logs supported | ${s.historicalLogSupportedChains}/${s.chainsWithRpc} |
| Factory code-present | ${s.factoryCodePresent ? "yes" : "no"} |
| Deploy logs | ${s.deployLogs} |
| Log errors | ${s.logErrors} |
| Wrappers discovered | ${s.wrappersDiscovered} |
| Valid adapter wrapper pairs | ${s.validWrapperPairs} |
| Material balance rows | ${s.materialBalanceRows} |
| Tracked wrapper balance USD | ${formatUsd(s.trackedWrapperBalanceUsd)} |
| Wrapper consumer rows | ${s.wrapperConsumerRows} |
| Token/factory context rows | ${s.tokenContextRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |
| Coverage classification | ${s.coverageClassification} |

## Wrappers

| Wrapper | Symbol | Underlying | Underlying Symbol | Balance | USD | Adapter-valid | Material |
|---|---|---|---|---:|---:|---|---|
${wrapperTable}

## Wrapper Consumer Join

| Source | Hit roles | Addresses | Wrappers | Context |
|---|---|---|---|---|
${consumerTable}

## Context Joins

| Source | Hit roles | Addresses | Underlyings | Context |
|---|---|---|---|---|
${contextTable}

## Blockers

- The adapter surface is wrapper-token custody/NAV context, not a borrow market or AMM factory.
- ${consumerBlocker}
- Underlying RWA token joins are not 3F-specific impact without a consumer that trusts the 3F wrapper or accounting path.
- Wrapper-held balances do not prove a permissionless redemption, mint, price, accounting, or settlement bypass.
- No exact positive borrow, redemption, liquidation, settlement, or DEX unwind economics and no fork extraction proof exist.

## Required For Route-Positive

- A deployed consumer references a 3F wrapper, wrapper NAV/accounting state, or a wrapper-specific oracle path.
- The referenced wrapper state is permissionlessly movable, stale, donation-sensitive, under-bound, or otherwise attacker-favorable.
- Borrow, redemption, liquidation, or settlement liquidity is material and exact-quoted after fees, gas, and slippage.
- Fork/local proof shows positive net value.

Artifacts: \`reports/raw/fast/3f-phase0.json\`.
`;
}

async function main() {
  const apiRaw = await fetchJson("https://api.llama.fi/protocol/3f", 30_000);
  const metadata = protocolMetadata(apiRaw);
  const rpcs = await resolveRpcPool([ETHEREUM_CHAIN_ID]);
  const defaultRpc = rpcs[ETHEREUM_CHAIN_ID] || null;
  const chainIdHex = defaultRpc ? await rpcCall(defaultRpc, "eth_chainId", [], 6_000) : null;
  const ethereumRpcAvailable = Boolean(chainIdHex && parseInt(chainIdHex, 16) === ETHEREUM_CHAIN_ID);
  const resolved = ethereumRpcAvailable ? await resolveHistoricalLogRpc(defaultRpc) : { rpc: null, sanitized: { historicalSupported: false, selected: "none", candidatesTested: 0, supportingCandidatesSeen: 0 } };
  const rpc = resolved.rpc;
  const latest = rpc ? await latestBlock(rpc) : null;
  const [factoryCode, logsResult] = await Promise.all([
    rpc ? getCode(rpc, FACTORY) : Promise.resolve("0x"),
    rpc && latest ? getLogsChunked(rpc, { address: normalizeAddress(FACTORY), topics: [DEPLOY.getEvent("Deployed").topicHash] }, ADAPTER_FROM_BLOCK, latest) : Promise.resolve({ logs: [], chunks: 0, errors: [{ reason: "missing-rpc-or-latest-block" }] }),
  ]);
  const deduped = new Map();
  for (const log of logsResult.logs) {
    const row = parseDeployLog(log);
    if (!row) continue;
    const key = lowerAddress(row.wrapper);
    const prev = deduped.get(key);
    if (!prev || row.blockNumber < prev.blockNumber) deduped.set(key, row);
  }
  const deployRows = [...deduped.values()].sort((a, b) => a.blockNumber - b.blockNumber);
  const preliminaryUnderlying = [];
  for (const row of deployRows) {
    const underlyingRaw = await safeCall(rpc, row.wrapper, WRAPPER, "underlying");
    const assetRaw = await safeCall(rpc, row.wrapper, WRAPPER, "asset");
    const underlying = normalizeAddress(underlyingRaw?.[0]) || normalizeAddress(assetRaw?.[0]);
    if (underlying) preliminaryUnderlying.push(underlying);
  }
  const prices = await loadPrices([...deployRows.map((row) => row.wrapper), ...preliminaryUnderlying]);
  const wrapperRows = [];
  for (const row of deployRows) wrapperRows.push(await inspectWrapper(rpc, row, prices));
  wrapperRows.sort((a, b) => (asNumber(b.underlyingBalanceUsd) || 0) - (asNumber(a.underlyingBalanceUsd) || 0));
  const joins = localConsumerJoins(wrapperRows);
  const wrapperJoinSet = new Set(joins.wrapperConsumerRows.flatMap((row) => row.wrappers.map(lowerAddress)).filter(Boolean));
  const watchCandidates = wrapperRows.filter((row) => wrapperJoinSet.has(lowerAddress(row.wrapper)) && (asNumber(row.underlyingBalanceUsd) || 0) >= MIN_MATERIAL_BALANCE_USD).map((row) => ({ ...row, reason: "3F wrapper appears in Morpho collateral/economics artifacts and has material underlying balance, but exact route economics are not positive/proven", routePositive: false }));
  const summary = {
    ethereumRpcAvailable,
    rpcAvailability: { [ETHEREUM_CHAIN_ID]: ethereumRpcAvailable },
    chainsWithRpc: ethereumRpcAvailable ? 1 : 0,
    historicalLogSupportedChains: resolved.sanitized.historicalSupported ? 1 : 0,
    historicalLogSelection: resolved.sanitized.selected,
    factory: normalizeAddress(FACTORY),
    factoryCodePresent: Boolean(factoryCode && factoryCode !== "0x"),
    factoryCodeBytes: factoryCode && factoryCode !== "0x" ? strip0x(factoryCode).length / 2 : 0,
    adapterFromBlock: ADAPTER_FROM_BLOCK,
    latestBlock: latest,
    logScanMode: resolved.sanitized.historicalSupported ? "adapter-from-block" : "bounded-or-unavailable",
    deployLogs: logsResult.logs.length,
    deployLogRows: deployRows.length,
    logChunks: logsResult.chunks,
    logErrors: logsResult.errors.length,
    wrappersDiscovered: wrapperRows.length,
    wrappersWithCode: wrapperRows.filter((row) => row.codePresent).length,
    validWrapperPairs: wrapperRows.filter((row) => row.validAdapterPair).length,
    underlyingTokensResolved: unique(wrapperRows.map((row) => lowerAddress(row.underlying))).length,
    trackedWrapperBalanceUsd: round(wrapperRows.reduce((sum, row) => sum + (asNumber(row.underlyingBalanceUsd) || 0), 0), 2),
    maxWrapperBalanceUsd: round(Math.max(0, ...wrapperRows.map((row) => asNumber(row.underlyingBalanceUsd) || 0)), 2),
    materialBalanceRows: wrapperRows.filter((row) => (asNumber(row.underlyingBalanceUsd) || 0) >= MIN_MATERIAL_BALANCE_USD).length,
    wrapperConsumerRows: joins.wrapperConsumerRows.length,
    tokenContextRows: joins.tokenContextRows.length,
    watchCandidates: watchCandidates.length,
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    closedReason: joins.wrapperConsumerRows.length ? "3F wrapper references found, but no exact-positive consumer economics or proof" : "no 3F wrapper address is referenced by scanned consumer-grade artifacts",
  };
  summary.coverageClassification = coverageClassification(summary);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-3f-phase0.js",
    scope: "Read-only 3F Ethereum wrapper-token TVL and consumer-route Phase 0 scan",
    target: { name: "3F", slug: "3f", category: "RWA Lending", surface: "lending-oracle-liquidation", metadata },
    safety: { publicApisOnlyForMetadata: true, rpcInventoryRead: true, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false },
    thresholds: { minMaterialBalanceUsd: MIN_MATERIAL_BALANCE_USD, logChunkBlocks: LOG_CHUNK_BLOCKS, minLogChunkBlocks: MIN_LOG_CHUNK_BLOCKS },
    docs: { adapter: "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/three-f/index.js", sourceModel: "WrapperAssetFactory Deployed logs -> wrapper underlying() -> underlying balance held by wrapper" },
    rpcSelection: { historicalLogSupported: resolved.sanitized.historicalSupported, selected: resolved.sanitized.selected, candidatesTested: resolved.sanitized.candidatesTested, supportingCandidatesSeen: resolved.sanitized.supportingCandidatesSeen },
    factoryRow: { chainId: ETHEREUM_CHAIN_ID, chain: CHAIN, factory: normalizeAddress(FACTORY), adapterFromBlock: ADAPTER_FROM_BLOCK, factoryCodePresent: summary.factoryCodePresent, factoryCodeBytes: summary.factoryCodeBytes, latestBlock: latest },
    logStats: { logs: logsResult.logs.length, chunks: logsResult.chunks, errors: logsResult.errors.length, errorSamples: logsResult.errors.slice(0, 8) },
    deployRows,
    wrapperRows,
    rows: wrapperRows,
    wrapperConsumerRows: joins.wrapperConsumerRows,
    tokenContextRows: joins.tokenContextRows.slice(0, 180),
    watchCandidates,
    routePositiveRows: [],
    summary,
    blockers: [
      "Adapter exposes wrapper-token TVL, not a borrow market or AMM factory",
      joins.wrapperConsumerRows.length ? "3F wrapper collateral rows exist in Morpho Blue, but scanned economics remain watch-only without exact positive acquisition, borrow, liquidation, redemption, settlement, or exit proof" : "No 3F wrapper address is referenced by scanned consumer-grade artifacts",
      "Underlying RWA token matches are context without 3F-specific wrapper impact",
      "Wrapper balances do not prove a permissionless redemption, mint, accounting, oracle, or settlement weakness",
      "No exact positive borrow, redemption, liquidation, settlement, or DEX unwind economics or proof",
    ],
    requiredForRoutePositive: [
      "deployed consumer references a 3F wrapper, wrapper NAV/accounting state, or wrapper oracle path",
      "referenced wrapper state is permissionlessly movable, stale, donation-sensitive, under-bound, or otherwise attacker-favorable",
      "borrow, redemption, liquidation, or settlement route is exact-quoted and positive",
      "fork/local proof",
    ],
    nextReadOnlyStep: joins.wrapperConsumerRows.length ? "Static-review the matched consumer and exact-quote only if 3F wrapper state affects accepted value." : "Reopen 3F only if a consumer references a 3F wrapper/NAV path or a wrapper-specific permissionless state weakness appears.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));
  if (!QUIET) console.log(`3F Phase 0: logs=${summary.deployLogs} wrappers=${summary.wrappersDiscovered} valid=${summary.validWrapperPairs} material=${summary.materialBalanceRows} wrapperConsumers=${summary.wrapperConsumerRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive} coverage=${summary.coverageClassification}`);
}

main().catch((err) => { console.error(err?.message || String(err)); process.exit(1); });
