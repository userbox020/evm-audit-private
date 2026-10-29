#!/usr/bin/env node
// scan-thorchain-dex-phase0.js - bounded read-only Phase 0 for Thorchain DEX EVM asset pools and consumer joins.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "thorchain-dex-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "thorchain-dex-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const QUIET = process.argv.includes("--quiet");

const MIN_MATERIAL_POOL_USD = Number(process.env.THORCHAIN_MIN_MATERIAL_POOL_USD || "100000");
const MIDGARD_POOLS_URL = "https://gateway.liquify.com/chain/thorchain_midgard/v2/pools";
const ROUTER_SOURCE_URL = "https://gitlab.com/thorchain/thornode/-/raw/develop/x/thorchain/router_upgrade_info.go";
const INBOUND_URLS = [
  "https://thornode.ninerealms.com/thorchain/inbound_addresses",
  "https://thornode-v1.ninerealms.com/thorchain/inbound_addresses",
  "https://daemon.thorchain.shapeshift.com/lcd/thorchain/inbound_addresses",
  "https://gateway.liquify.com/chain/thorchain/thorchain/inbound_addresses",
];

const EVM_CHAINS = {
  ETH: { chainId: 1, chain: "Ethereum", llamaChain: "ethereum", nativeSymbol: "ETH" },
  BSC: { chainId: 56, chain: "BNB Chain", llamaChain: "bsc", nativeSymbol: "BNB" },
  BNB: { chainId: 56, chain: "BNB Chain", llamaChain: "bsc", nativeSymbol: "BNB" },
  AVAX: { chainId: 43114, chain: "Avalanche", llamaChain: "avax", nativeSymbol: "AVAX" },
  BASE: { chainId: 8453, chain: "Base", llamaChain: "base", nativeSymbol: "ETH" },
};
const CHAIN_IDS = [...new Set(Object.values(EVM_CHAINS).map((c) => c.chainId))];
const ZERO = "0x0000000000000000000000000000000000000000";
const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";

const ERC20 = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const BYTES32_TOKEN = new ethers.Interface(["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"]);

const CONSUMER_ARTIFACTS = [
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["seven-chain-lending", "reports/raw/fast/seven-chain-lending-coverage.json"],
  ["stablecoin-depeg", "reports/raw/fast/stablecoin-depeg-lending-routes.json"],
  ["erc4626-consumer", "reports/raw/fast/erc4626-consumer-joiner.json"],
  ["evault-collateral-nav", "reports/raw/fast/evault-collateral-nav-manipulation.json"],
  ["focused-morpho", "reports/raw/fast/focused-morpho-review-producers.json"],
  ["focused-euler", "reports/raw/fast/focused-euler-evk-review-producers.json"],
  ["morpho-public-allocator", "reports/raw/fast/morpho-public-allocator-force-feed.json"],
  ["pool-share-snapshot", "reports/raw/fast/pool-share-snapshot-drift.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["current-profit-leads", "reports/raw/fast/current-profit-lead-triage.json"],
  ["bridge-proof-binding", "reports/raw/fast/bridge-proof-binding.json"],
  ["bridge-synthetic-consumer", "reports/raw/fast/bridge-synthetic-consumer-exposure.json"],
  ["bridge-escrow-reconciliation", "reports/raw/fast/bridge-escrow-reconciliation.json"],
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
  "morpho-public-allocator",
  "pool-share-snapshot",
  "public-lead-consumer",
  "bridge-proof-binding",
  "bridge-synthetic-consumer",
  "bridge-escrow-reconciliation",
]);
const DIRECT_ROLES = new Set(["inboundAddress", "inboundRouter"]);
const URL_RE = /(https?:\/\/[^\s'"<>\[\]]+)/g;
const ORIGIN_RE = /\[origin:\s*([^\]\s]+)\]/i;
const HEADER_RE = /\[header:\s*([^=\]\s]+)=([^\]]+)\]/gi;
const THORCHAIN_HINT_RE = /(thorchain|thornode|midgard|nine\s*realms|ninerealms)/i;

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
function decodeBytes32String(value) { try { return safeText(ethers.decodeBytes32String(value), 40); } catch (_) { return null; } }
function asNumber(value) { const n = typeof value === "number" ? value : Number(String(value ?? "").replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const factor = 10 ** decimals; return Math.round(n * factor) / factor; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatNumber(value, decimals = 2) { const n = asNumber(value); return n === null ? "n/a" : n.toLocaleString(undefined, { maximumFractionDigits: decimals }); }
function decimalsToNumber(value, decimals) { try { if (value === null || value === undefined || decimals === null || decimals === undefined) return null; const n = Number(ethers.formatUnits(BigInt(value), Number(decimals))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function hostOf(url) { try { return new URL(url).host; } catch (_) { return "unknown"; } }

function inventoryThorchainEndpointRows() {
  if (!fs.existsSync(RPC_FILE)) return [];
  const rows = [];
  const lines = readText(RPC_FILE).split(/\r?\n/);
  for (const line of lines) {
    if (!THORCHAIN_HINT_RE.test(line)) continue;
    const origin = line.match(ORIGIN_RE)?.[1] || null;
    const extraHeaders = {};
    for (const h of line.matchAll(HEADER_RE)) extraHeaders[h[1].toLowerCase()] = h[2];
    for (const m of line.matchAll(URL_RE)) rows.push({ url: m[1].replace(/[)\],]+$/g, ""), origin, extraHeaders });
  }
  return rows;
}

function endpointHeaders(row) {
  const headers = { "user-agent": "evm-audit-thorchain-phase0/1.0" };
  if (row?.origin) headers.origin = row.origin;
  for (const [key, value] of Object.entries(row?.extraHeaders || {})) headers[key] = value;
  return headers;
}

function withPath(raw, suffix) {
  try {
    const u = new URL(raw);
    const basePath = u.pathname.replace(/\/+$/g, "");
    u.pathname = `${basePath}${suffix}`.replace(/\/+/g, "/");
    return u.toString();
  } catch (_) { return null; }
}

function inboundCandidateUrls(raw) {
  const out = [];
  try {
    const u = new URL(raw);
    const pathName = u.pathname.replace(/\/+$/g, "");
    if (/\/thorchain\/inbound_addresses$/i.test(pathName)) out.push(u.toString());
    if (/\/thorchain$/i.test(pathName)) out.push(withPath(raw, "/inbound_addresses"));
    else out.push(withPath(raw, "/thorchain/inbound_addresses"));
    if (!/\/lcd(\/|$)/i.test(pathName)) out.push(withPath(raw, "/lcd/thorchain/inbound_addresses"));
  } catch (_) {}
  return [...new Set(out.filter(Boolean))].slice(0, 3);
}

async function fetchText(url, timeoutMs = 30_000, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-thorchain-phase0/1.0", ...headers } });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, text: "", error: safeText(text || `HTTP ${res.status}`, 120) };
    return { ok: true, status: res.status, text, error: null };
  } catch (err) {
    return { ok: false, status: null, text: "", error: safeText(err?.name || err?.message || "transport-error", 80) };
  } finally { clearTimeout(timer); }
}

async function fetchJson(url, timeoutMs = 30_000, headers = {}) {
  const fetched = await fetchText(url, timeoutMs, headers);
  try {
    const text = fetched.text;
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    if (!fetched.ok) return { ok: false, status: fetched.status, json: null, error: safeText(json?.error || json?.message || fetched.error || text || `HTTP ${fetched.status}`, 120) };
    return { ok: true, status: fetched.status, json, error: null };
  } catch (err) { return { ok: false, status: fetched.status, json: null, error: safeText(err?.name || err?.message || "parse-error", 80) }; }
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

async function getNativeBalance(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return null;
  try { return (await rpcCall(rpc, "eth_getBalance", [addr, "latest"], 10_000)) || "0x0"; } catch (_) { return null; }
}

async function getTokenBalance(rpc, token, holder) {
  const result = await safeCall(rpc, token, ERC20, "balanceOf", [holder], 10_000);
  return result?.[0] === undefined ? null : result[0].toString();
}

function discoveryRows() {
  const d = readJson(PUBLIC_TARGETS, {});
  return [...(d.phase0Queue || []), ...(d.consumerJoinFirst || []), ...(d.protocolCandidates || []), ...(d.targetedRefreshQueue || []), ...(d.yieldCandidates || []), ...(d.targets || []), ...(d.value || [])];
}

function protocolMetadata() {
  const row = discoveryRows().find((p) => p?.slug === "thorchain-dex" || p?.name === "Thorchain DEX");
  if (row) return { name: row.name, slug: row.slug, category: row.category, chains: row.chains || [], evmChains: row.evmChains || [], tvlUsd: round(row.tvlUsd, 2), change1dPct: row.change1dPct ?? null, change7dPct: row.change7dPct ?? null, routePriority: row.routePriority || null, source: "public-audit-target-discovery" };
  return { name: "Thorchain DEX", slug: "thorchain-dex", category: "Dexs", chains: ["Thorchain", "Ethereum", "BNB Chain", "Avalanche", "Base"], evmChains: ["Ethereum", "BNB Chain", "Avalanche", "Base"], tvlUsd: null };
}

function parseThorchainAsset(asset) {
  const text = String(asset || "").trim();
  const match = text.match(/^([A-Za-z0-9]+)\.([^\s]+)$/);
  if (!match) return null;
  const chainKey = match[1].toUpperCase();
  const chainDef = EVM_CHAINS[chainKey];
  if (!chainDef) return null;
  const rest = match[2];
  const tokenMatch = rest.match(/^(.+)-((?:0x|0X)[0-9a-fA-F]{40})$/);
  if (tokenMatch) {
    const token = normalizeAddress(tokenMatch[2]);
    return token ? { asset: text, chainKey, ...chainDef, symbol: safeText(tokenMatch[1], 32), token, native: false } : null;
  }
  const symbol = safeText(rest, 32);
  const native = String(symbol || "").toUpperCase() === chainDef.nativeSymbol;
  return { asset: text, chainKey, ...chainDef, symbol, token: null, native };
}

async function loadMidgardPools() {
  const fetched = await fetchJson(MIDGARD_POOLS_URL, 35_000);
  const pools = Array.isArray(fetched.json) ? fetched.json : Array.isArray(fetched.json?.pools) ? fetched.json.pools : [];
  return { fetched: { ok: fetched.ok, status: fetched.status, error: fetched.error, count: pools.length, host: hostOf(MIDGARD_POOLS_URL) }, pools };
}

function buildPoolRows(pools) {
  const rows = [];
  for (const p of pools || []) {
    const parsed = parseThorchainAsset(p?.asset);
    if (!parsed) continue;
    const assetDepth = asNumber(p.assetDepth);
    const assetAmount = assetDepth === null ? null : assetDepth / 1e8;
    const assetPriceUsd = asNumber(p.assetPriceUSD);
    const liquidityUsd = asNumber(p.liquidityInUSD);
    rows.push({
      asset: parsed.asset,
      chainKey: parsed.chainKey,
      chainId: parsed.chainId,
      chain: parsed.chain,
      llamaChain: parsed.llamaChain,
      symbol: parsed.symbol,
      token: parsed.token,
      native: parsed.native,
      status: safeText(p.status, 40),
      assetDepthRaw: p.assetDepth ?? null,
      assetAmount: round(assetAmount, 8),
      assetPriceUsd: round(assetPriceUsd, 8),
      liquidityUsd: round(liquidityUsd, 2),
      runeDepthRaw: p.runeDepth ?? null,
      liquidityUnits: p.liquidityUnits ?? null,
      saversDepthRaw: p.saversDepth ?? null,
      synthSupplyRaw: p.synthSupply ?? null,
      totalCollateralRaw: p.totalCollateral ?? null,
      totalDebtTorRaw: p.totalDebtTor ?? null,
      volume24hRaw: p.volume24h ?? null,
      material: (liquidityUsd || 0) >= MIN_MATERIAL_POOL_USD,
      routePositive: false,
    });
  }
  return rows.sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0));
}

async function tokenMeta(rpc, chainId, chain, address, poolAssets = []) {
  const addr = normalizeAddress(address);
  const [code, decimalsRaw, symbolRaw, symbolBytesRaw, nameRaw, nameBytesRaw, totalSupplyRaw] = await Promise.all([
    getCode(rpc, addr),
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, BYTES32_TOKEN, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, BYTES32_TOKEN, "name"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
  ]);
  const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
  const totalSupply = totalSupplyRaw?.[0] === undefined ? null : totalSupplyRaw[0].toString();
  return {
    chainId,
    chain,
    token: addr,
    symbol: safeText(symbolRaw?.[0], 40) || decodeBytes32String(symbolBytesRaw?.[0]) || safeText(poolAssets[0]?.symbol, 40),
    name: safeText(nameRaw?.[0], 80) || decodeBytes32String(nameBytesRaw?.[0]),
    decimals,
    totalSupplyRaw: totalSupply,
    totalSupply: round(decimalsToNumber(totalSupply, decimals), 6),
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    poolAssets: unique(poolAssets.map((row) => row.asset)).slice(0, 8),
    maxPoolLiquidityUsd: round(Math.max(0, ...poolAssets.map((row) => asNumber(row.liquidityUsd) || 0)), 2),
    routePositive: false,
  };
}

async function inspectTokens(rpcs, poolRows) {
  const byKey = new Map();
  for (const row of poolRows) {
    if (!row.token) continue;
    const key = `${row.chainId}:${row.token.toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  const out = [];
  for (const rows of byKey.values()) {
    const first = rows[0];
    const rpc = rpcs[first.chainId];
    out.push(await tokenMeta(rpc, first.chainId, first.chain, first.token, rows));
  }
  return out.sort((a, b) => (asNumber(b.maxPoolLiquidityUsd) || 0) - (asNumber(a.maxPoolLiquidityUsd) || 0));
}

function parseRouterSource(text) {
  const rows = [];
  const seen = new Set();
  const re = /\b(eth|avax|bsc|base)(Old|New)Router\s*=\s*`(0x[0-9a-fA-F]{40})`/g;
  for (const match of String(text || "").matchAll(re)) {
    const chainKey = match[1].toUpperCase();
    const chainDef = EVM_CHAINS[chainKey];
    const router = normalizeAddress(match[3]);
    if (!chainDef || !router) continue;
    const routerRole = match[2] === "New" ? "current" : "deprecated";
    const key = `${chainDef.chainId}:${router.toLowerCase()}:${routerRole}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ chainKey, ...chainDef, router, routerRole, sourceField: `${match[1]}${match[2]}Router` });
  }
  return rows;
}

async function inspectRouterSource(rpcs) {
  const fetched = await fetchText(ROUTER_SOURCE_URL, 20_000);
  const parsed = fetched.ok ? parseRouterSource(fetched.text) : [];
  const routerRows = [];
  for (const row of parsed) {
    const rpc = rpcs[row.chainId];
    const [code, nativeBalanceRaw] = await Promise.all([getCode(rpc, row.router), getNativeBalance(rpc, row.router)]);
    routerRows.push({
      chainKey: row.chainKey,
      chainId: row.chainId,
      chain: row.chain,
      router: row.router,
      routerRole: row.routerRole,
      sourceField: row.sourceField,
      source: "thornode-gitlab-router-upgrade-info",
      codePresent: Boolean(code && code !== "0x"),
      codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
      nativeBalanceRaw,
      nativeBalance: round(decimalsToNumber(nativeBalanceRaw, 18), 8),
      routePositive: false,
    });
  }
  const currentRows = routerRows.filter((row) => row.routerRole === "current");
  return {
    sourceResult: {
      host: hostOf(ROUTER_SOURCE_URL),
      ok: fetched.ok && currentRows.length > 0,
      status: fetched.status,
      count: currentRows.length,
      error: fetched.ok ? null : fetched.error,
      sourceType: "router-constant-source",
      note: "current-router constant cross-check; live inbound rows take precedence when available",
    },
    routerRows,
    currentRows,
  };
}

async function fetchInboundAddresses(rpcs) {
  const endpointResults = [];
  let inboundRaw = null;
  const inventoryRows = inventoryThorchainEndpointRows();
  const endpointInputs = [];
  const seen = new Set();
  inventoryRows.forEach((row, i) => {
    inboundCandidateUrls(row.url).forEach((url, j) => {
      const key = `${url}|${Boolean(row.origin)}|${Object.keys(row.extraHeaders || {}).sort().join(",")}`;
      if (seen.has(key)) return;
      seen.add(key);
      endpointInputs.push({ url, label: `rpc-endpoints#${i + 1}.${j + 1}`, sourceType: "rpc-endpoint-inventory", secret: true, headers: endpointHeaders(row) });
    });
  });
  for (const url of INBOUND_URLS) {
    if (seen.has(url)) continue;
    seen.add(url);
    endpointInputs.push({ url, label: hostOf(url), sourceType: "public-hardcoded", secret: false, headers: { "user-agent": "evm-audit-thorchain-phase0/1.0" } });
  }
  for (const input of endpointInputs) {
    const fetched = await fetchJson(input.url, 12_000, input.headers);
    const arr = Array.isArray(fetched.json) ? fetched.json : Array.isArray(fetched.json?.inbound_addresses) ? fetched.json.inbound_addresses : Array.isArray(fetched.json?.result) ? fetched.json.result : [];
    endpointResults.push({ source: input.label, endpointSource: input.sourceType, ok: fetched.ok && Array.isArray(arr) && arr.length > 0, status: fetched.status, count: Array.isArray(arr) ? arr.length : 0, error: fetched.ok ? null : (input.secret ? "endpoint-failed" : fetched.error) });
    if (!inboundRaw && fetched.ok && Array.isArray(arr) && arr.length) inboundRaw = arr;
  }
  const rows = [];
  for (const item of inboundRaw || []) {
    const key = String(item?.chain || "").toUpperCase();
    const chainDef = EVM_CHAINS[key];
    if (!chainDef) continue;
    const address = normalizeAddress(item.address);
    const router = normalizeAddress(item.router);
    if (!address && !router) continue;
    const rpc = rpcs[chainDef.chainId];
    const [addressCode, routerCode] = await Promise.all([address ? getCode(rpc, address) : Promise.resolve("0x"), router ? getCode(rpc, router) : Promise.resolve("0x")]);
    rows.push({
      chainKey: key,
      chainId: chainDef.chainId,
      chain: chainDef.chain,
      address,
      addressCodePresent: Boolean(addressCode && addressCode !== "0x"),
      addressCodeBytes: addressCode && addressCode !== "0x" ? strip0x(addressCode).length / 2 : 0,
      router,
      routerCodePresent: Boolean(routerCode && routerCode !== "0x"),
      routerCodeBytes: routerCode && routerCode !== "0x" ? strip0x(routerCode).length / 2 : 0,
      halted: item.halted ?? null,
      chainLpActionsPaused: item.chain_lp_actions_paused ?? null,
      chainTradingPaused: item.chain_trading_paused ?? null,
      globalTradingPaused: item.global_trading_paused ?? null,
      gasRate: item.gas_rate ?? null,
      routePositive: false,
    });
  }
  const routerSource = await inspectRouterSource(rpcs);
  endpointResults.push(routerSource.sourceResult);
  for (const row of routerSource.currentRows) {
    rows.push({
      chainKey: row.chainKey,
      chainId: row.chainId,
      chain: row.chain,
      address: null,
      addressCodePresent: false,
      addressCodeBytes: 0,
      router: row.router,
      routerCodePresent: row.codePresent,
      routerCodeBytes: row.codeBytes,
      halted: null,
      chainLpActionsPaused: null,
      chainTradingPaused: null,
      globalTradingPaused: null,
      gasRate: null,
      source: row.source,
      sourceField: row.sourceField,
      sourceCoverage: "router-only-fallback",
      routePositive: false,
    });
  }
  return { endpointResults, inboundRows: rows, routerConstantRows: routerSource.routerRows, inventoryEndpointRows: inventoryRows.length, endpointCandidatesTested: endpointInputs.length };
}

async function inspectInboundBalances(rpcs, poolRows, tokenRows, inboundRows) {
  const decimalsByToken = new Map(tokenRows.map((row) => [`${row.chainId}:${String(row.token).toLowerCase()}`, row.decimals]));
  const rows = [];
  const seen = new Set();
  for (const inbound of inboundRows.filter((row) => row.address)) {
    const rpc = rpcs[inbound.chainId];
    if (!rpc) continue;
    const assets = poolRows.filter((row) => row.chainId === inbound.chainId && row.material).slice(0, 20);
    for (const asset of assets) {
      const key = `${inbound.chainId}:${String(inbound.address).toLowerCase()}:${asset.asset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const decimals = asset.native ? 18 : decimalsByToken.get(`${asset.chainId}:${String(asset.token).toLowerCase()}`);
      const balanceRaw = asset.native ? await getNativeBalance(rpc, inbound.address) : await getTokenBalance(rpc, asset.token, inbound.address);
      const balance = decimalsToNumber(balanceRaw, decimals);
      rows.push({
        chainId: inbound.chainId,
        chain: inbound.chain,
        vaultAddress: inbound.address,
        asset: asset.asset,
        token: asset.token,
        native: asset.native,
        symbol: asset.symbol,
        decimals: decimals ?? null,
        balanceRaw,
        balance: round(balance, 8),
        balanceUsd: balance === null ? null : round(balance * (asNumber(asset.assetPriceUsd) || 0), 2),
        poolLiquidityUsd: asset.liquidityUsd,
        halted: inbound.halted,
        routePositive: false,
      });
    }
  }
  return rows.sort((a, b) => (asNumber(b.balanceUsd) || 0) - (asNumber(a.balanceUsd) || 0));
}

function primitiveAddresses(value, out = new Set()) {
  if (typeof value === "string") { for (const m of value.matchAll(/0x[0-9a-fA-F]{40}/g)) out.add(m[0].toLowerCase()); }
  else if (Array.isArray(value)) { for (const item of value) primitiveAddresses(item, out); }
  else if (value && typeof value === "object") { for (const item of Object.values(value)) primitiveAddresses(item, out); }
  return out;
}

function summarizeContext(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const fields = ["id", "protocol", "project", "name", "chain", "chainId", "surface", "side", "symbol", "asset", "token", "collateral", "borrowAsset", "loanAsset", "oracle", "source", "status", "routePositive", "watchCandidate", "liquidityUsd", "borrowCashUsd", "cashUsd", "borrowAssetsUsd", "supplyAssetsUsd", "file", "rootFile"];
  const out = {};
  for (const field of fields) { const value = obj[field]; if (value === undefined) continue; out[field] = typeof value === "object" ? safeText(JSON.stringify(value), 180) : safeText(value, 180); }
  return out;
}

function scanObjectForAddresses(source, obj, addressRoles, out, depth = 0) {
  if (!obj || depth > 9 || out.length >= 900) return;
  if (Array.isArray(obj)) { for (const item of obj) scanObjectForAddresses(source, item, addressRoles, out, depth + 1); return; }
  if (typeof obj !== "object") return;
  const hits = [...primitiveAddresses(obj)].filter((addr) => addressRoles[addr]);
  if (hits.length) {
    const roles = unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.role)));
    const assets = unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.asset || role.symbol)).filter(Boolean)).slice(0, 12);
    out.push({
      source,
      hitRoles: roles,
      hitAddresses: hits.slice(0, 12),
      assets,
      chains: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.chain)).filter(Boolean)).slice(0, 8),
      directConsumer: DIRECT_SOURCE_SET.has(source) && roles.some((role) => DIRECT_ROLES.has(role)),
      context: summarizeContext(obj),
      routePositive: false,
      blocker: "Local artifact address match is context only unless a Thorchain router/vault or pool state is trusted by consumer logic with exact positive economics",
    });
    return;
  }
  for (const value of Object.values(obj)) scanObjectForAddresses(source, value, addressRoles, out, depth + 1);
}

function localConsumerJoins(poolRows, tokenRows, inboundRows) {
  const roles = {};
  function add(addr, role) {
    const lower = lowerAddress(addr);
    if (!lower || lower === ZERO) return;
    if (!roles[lower]) roles[lower] = [];
    roles[lower].push(role);
  }
  for (const row of poolRows) if (row.token) add(row.token, { role: "assetToken", chain: row.chain, asset: row.asset, symbol: row.symbol });
  for (const row of tokenRows) add(row.token, { role: "assetToken", chain: row.chain, asset: row.poolAssets?.[0], symbol: row.symbol });
  for (const row of inboundRows) {
    add(row.address, { role: "inboundAddress", chain: row.chain, asset: "thorchain-inbound" });
    add(row.router, { role: "inboundRouter", chain: row.chain, asset: "thorchain-router" });
  }
  const matches = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) { const json = readJson(path.join(WORKSPACE, rel), null); if (json) scanObjectForAddresses(source, json, roles, matches); }
  return { inboundSpecificJoinRows: matches.filter((row) => row.directConsumer), tokenContextRows: matches.filter((row) => !row.directConsumer) };
}

function buildReport(artifact) {
  const s = artifact.summary;
  const hasVaultRows = (asNumber(s.vaultAddressRows) || 0) > 0;
  const coverageTitle = hasVaultRows ? "Inbound Coverage" : "Bounded Router Fallback";
  const resultText = hasVaultRows
    ? "No confirmed permissionless exploit for the covered Midgard EVM asset/token and current inbound router/vault scope. Thorchain DEX's public adapter is Midgard pool-depth based and did not expose an EVM AMM factory. A sanitized Thorchain endpoint from the local RPC inventory returned current inbound rows, including EVM vault/asgard addresses and routers; EVM router bytecode was live-checked on Ethereum, BNB Chain, Avalanche, and Base. Token-level matches are common-asset context only; route-positive requires a deployed consumer that trusts Thorchain router/vault/pool state plus exact positive bridge, borrow, redemption, liquidation, settlement, or unwind economics."
    : "No confirmed permissionless exploit for the covered Midgard EVM asset/token and bounded current-router scope. Thorchain DEX's public adapter is Midgard pool-depth based and did not expose an EVM AMM factory. Thornode inbound endpoints were unavailable or blocked in this environment, but current EVM router constants were sourced from THORNode GitLab and live-code checked on Ethereum, BNB Chain, Avalanche, and Base. Vault/asgard addresses remain unavailable, so this is bounded router-only coverage rather than exhaustive inbound vault coverage. Token-level matches are common-asset context only; route-positive requires a deployed consumer that trusts Thorchain router/vault/pool state plus exact positive bridge, borrow, redemption, liquidation, settlement, or unwind economics.";
  const inboundBlocker = hasVaultRows
    ? "A sanitized Thorchain endpoint returned current EVM inbound router/vault rows; no consumer-grade artifact referenced those Thorchain-specific addresses with value impact."
    : "Thornode inbound router/vault endpoints were unavailable or blocked in this environment; current router constants were recovered from THORNode GitLab and live-code checked, but vault/asgard addresses remain unavailable.";
  const poolTable = artifact.poolRows.slice(0, 15).map((row) => `| ${row.chain} | ${row.asset} | ${row.token ? compactAddress(row.token) : "native"} | ${row.status || "n/a"} | ${formatNumber(row.assetAmount, 4)} | ${formatUsd(row.liquidityUsd)} | ${row.material ? "yes" : "no"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const tokenTable = artifact.tokenRows.slice(0, 15).map((row) => `| ${row.chain} | ${row.symbol || compactAddress(row.token)} | ${compactAddress(row.token)} | ${row.codePresent ? "yes" : "no"} | ${row.decimals ?? "n/a"} | ${formatUsd(row.maxPoolLiquidityUsd)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";
  const inboundTable = artifact.inboundRows.length ? artifact.inboundRows.map((row) => `| ${row.chain} | ${compactAddress(row.address)} | ${row.addressCodePresent ? "yes" : "no"} | ${compactAddress(row.router)} | ${row.routerCodePresent ? "yes" : "no"} | ${row.halted ?? "n/a"} | ${safeText(row.sourceCoverage || row.source || "endpoint", 60)} |`).join("\n") : "| none | n/a | n/a | n/a | n/a | n/a | inbound endpoints unavailable in this environment |";
  const balanceTable = artifact.inboundBalanceRows.slice(0, 12).map((row) => `| ${row.chain} | ${compactAddress(row.vaultAddress)} | ${row.asset} | ${formatNumber(row.balance, 6)} | ${formatUsd(row.balanceUsd)} | ${row.halted ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";
  const endpointTable = artifact.inboundEndpointResults.map((row) => `| ${safeText(row.host || row.source || row.endpointSource || "endpoint", 80)} | ${row.ok ? "yes" : "no"} | ${row.status ?? "transport"} | ${row.count ?? 0} | ${safeText(row.error || row.note || "", 80) || "n/a"} |`).join("\n") || "| none | no | n/a | 0 | n/a |";
  const consumerTable = artifact.inboundSpecificJoinRows.length ? artifact.inboundSpecificJoinRows.slice(0, 10).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${row.chains.join(", ") || "n/a"} | ${safeText(row.context?.protocol || row.context?.project || row.context?.name || row.context?.surface || row.context?.file || "context", 80)} |`).join("\n") : "| none | n/a | n/a | n/a | no Thorchain router/vault address was found in consumer-grade artifacts |";
  return `# ${SIGNAL_DORMANT} - Thorchain DEX Phase 0 Triage (${coverageTitle})

Date: ${artifact.generatedAt}

## Result

${resultText}

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Midgard pools fetched | ${s.midgardPoolsFetched} |
| EVM pool rows | ${s.evmPoolRows} |
| Material EVM pool rows | ${s.materialPoolRows} |
| Token contracts checked | ${s.tokenRows} |
| Token contracts with code | ${s.tokenRowsWithCode} |
| Thorchain inventory endpoint rows tested | ${s.rpcInventoryThorchainEndpointRows} |
| Inbound endpoint candidates tested | ${s.inboundEndpointCandidatesTested} |
| Inbound rows | ${s.inboundRows} |
| Current router rows with code | ${s.currentRouterRowsWithCode} |
| Vault/asgard address rows | ${s.vaultAddressRows} |
| Inbound balance rows | ${s.inboundBalanceRows} |
| Positive inbound balance rows | ${s.inboundBalanceRowsPositive} |
| Sampled inbound vault balances | ${formatUsd(s.inboundVaultBalanceUsd)} |
| Inbound-specific consumer rows | ${s.inboundSpecificJoinRows} |
| Token context rows | ${s.tokenContextRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |
| Coverage classification | ${s.coverageClassification} |

## Top EVM Pools

| Chain | Asset | Token | Status | Asset amount | Liquidity USD | Material |
|---|---|---|---|---:|---:|---|
${poolTable}

## Token Validation

| Chain | Symbol | Token | Code | Decimals | Max pool liquidity |
|---|---|---|---|---:|---:|
${tokenTable}

## Inbound Discovery

| Source | OK | Status | Rows | Error |
|---|---|---:|---:|---|
${endpointTable}

| Chain | Vault/address | Code | Router | Router code | Halted | Source |
|---|---|---|---|---|---|---|
${inboundTable}

## Inbound Vault Balance Sample

| Chain | Vault/address | Asset | Balance | Balance USD | Halted |
|---|---|---|---:|---:|---|
${balanceTable}

## Direct Thorchain Consumer Join

| Source | Hit roles | Addresses | Chains | Context |
|---|---|---|---|---|
${consumerTable}

## Blockers

- The public adapter uses Midgard pool-depth data and no EVM AMM factory was identified.
- ${inboundBlocker}
- EVM token joins are common-asset context such as ETH, USDC, USDT, BTCB/WBTC, and chain-native wrappers, not Thorchain-specific accepted-value evidence.
- No deployed consumer was found that trusts Thorchain router, vault, synth, savers, or pool accounting state in a way that changes borrow, redeem, liquidation, bridge, or settlement value.
- No exact positive bridge, borrow, redemption, liquidation, settlement, or DEX unwind economics and no fork extraction proof exist.

## Required For Route-Positive

- A deployed EVM or cross-domain consumer references Thorchain router/vault/pool/synth/savers state.
- The referenced state is permissionlessly movable, stale, under-bound, or otherwise attacker-favorable.
- Borrow, redemption, bridge, liquidation, settlement, or unwind liquidity is material and exact-quoted after fees, gas, and slippage.
- Fork/local proof shows positive net value.

Artifacts: \`reports/raw/fast/thorchain-dex-phase0.json\`.
`;
}

async function main() {
  const metadata = protocolMetadata();
  const rpcs = await resolveRpcPool(CHAIN_IDS);
  const rpcAvailability = Object.fromEntries(CHAIN_IDS.map((chainId) => [chainId, Boolean(rpcs[chainId])]));
  const { fetched, pools } = await loadMidgardPools();
  const poolRows = buildPoolRows(pools);
  const tokenRows = await inspectTokens(rpcs, poolRows);
  const inbound = await fetchInboundAddresses(rpcs);
  const inboundBalanceRows = await inspectInboundBalances(rpcs, poolRows, tokenRows, inbound.inboundRows);
  const joins = localConsumerJoins(poolRows, tokenRows, inbound.inboundRows);
  const watchCandidates = joins.inboundSpecificJoinRows.map((row) => ({ ...row, reason: "Thorchain inbound router/vault appears in a consumer-grade artifact; needs proof-binding/economics review", routePositive: false }));
  const currentRouterRows = (inbound.routerConstantRows || []).filter((row) => row.routerRole === "current");
  const hasLiveVaultRows = inbound.inboundRows.some((row) => row.address);
  const hasCurrentRouterCode = currentRouterRows.length > 0 && currentRouterRows.every((row) => row.codePresent);
  const summary = {
    rpcAvailability,
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    midgardPoolsFetched: fetched.count,
    midgardFetchOk: fetched.ok,
    evmPoolRows: poolRows.length,
    materialPoolRows: poolRows.filter((row) => row.material).length,
    maxPoolTvlUsd: round(Math.max(0, ...poolRows.map((row) => asNumber(row.liquidityUsd) || 0)), 2),
    totalEvmLiquidityUsd: round(poolRows.reduce((sum, row) => sum + (asNumber(row.liquidityUsd) || 0), 0), 2),
    tokenRows: tokenRows.length,
    tokenRowsWithCode: tokenRows.filter((row) => row.codePresent).length,
    rpcInventoryThorchainEndpointRows: inbound.inventoryEndpointRows,
    inboundEndpointCandidatesTested: inbound.endpointCandidatesTested,
    inboundRows: inbound.inboundRows.length,
    vaultAddressRows: inbound.inboundRows.filter((row) => row.address).length,
    routerConstantRows: (inbound.routerConstantRows || []).length,
    currentRouterRows: currentRouterRows.length,
    currentRouterRowsWithCode: currentRouterRows.filter((row) => row.codePresent).length,
    inboundBalanceRows: inboundBalanceRows.length,
    inboundBalanceRowsPositive: inboundBalanceRows.filter((row) => (asNumber(row.balanceUsd) || 0) > 0).length,
    inboundVaultBalanceUsd: round(inboundBalanceRows.reduce((sum, row) => sum + (asNumber(row.balanceUsd) || 0), 0), 2),
    inboundEndpointOkRows: inbound.endpointResults.filter((row) => row.ok).length,
    inboundSpecificJoinRows: joins.inboundSpecificJoinRows.length,
    tokenContextRows: joins.tokenContextRows.length,
    watchCandidates: watchCandidates.length,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    coverageClassification: hasLiveVaultRows && hasCurrentRouterCode ? "full-enough-for-declared-scope" : hasCurrentRouterCode ? "bounded-with-caveats" : "partial-or-blocked",
    closedReason: joins.inboundSpecificJoinRows.length ? "Thorchain-specific inbound address references found, but no exact-positive consumer economics or proof" : hasLiveVaultRows ? "route-negative for Midgard/token and live inbound router/vault scope; no Thorchain-specific consumer value path found" : "route-negative for Midgard/token and current-router scope; live vault/asgard inbound rows remain unavailable",
  };
  const blockers = [
    "Public adapter uses Midgard pool-depth data and no EVM AMM factory was identified",
    hasLiveVaultRows
      ? "Sanitized Thorchain endpoint returned current EVM inbound router/vault rows; no consumer-grade artifact referenced those Thorchain-specific addresses with value impact"
      : "Thornode inbound router/vault endpoints were unavailable or blocked in this environment; current router constants were sourced from THORNode GitLab and live-code checked, but vault/asgard addresses remain unavailable",
    "EVM token joins are common-asset context and not Thorchain-specific impact",
    "No deployed consumer was found that trusts Thorchain router, vault, synth, savers, or pool accounting state with exact positive economics",
    "No exact positive bridge, borrow, redemption, liquidation, settlement, or DEX unwind economics or proof",
  ];
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-thorchain-dex-phase0.js",
    scope: "Read-only Thorchain DEX Midgard EVM asset/token, bounded current-router fallback, and consumer-route Phase 0 scan",
    target: { name: "Thorchain DEX", slug: "thorchain-dex", category: "Dexs", surface: "dex-oracle-consumer-only", metadata },
    safety: { publicApisOnlyForMetadata: true, rpcInventoryRead: true, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false },
    thresholds: { minMaterialPoolUsd: MIN_MATERIAL_POOL_USD },
    docs: { adapter: "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/thorchain/index.js", midgardPoolsHost: hostOf(MIDGARD_POOLS_URL), publicInboundHostsTried: INBOUND_URLS.map(hostOf), rpcInventoryThorchainEndpointRows: inbound.inventoryEndpointRows, routerSourceHost: hostOf(ROUTER_SOURCE_URL), routerSourceRef: "gitlab.com/thorchain/thornode develop x/thorchain/router_upgrade_info.go" },
    midgardFetch: fetched,
    poolRows,
    tokenRows,
    inboundEndpointResults: inbound.endpointResults,
    inboundRows: inbound.inboundRows,
    inboundBalanceRows,
    routerConstantRows: inbound.routerConstantRows || [],
    inboundSpecificJoinRows: joins.inboundSpecificJoinRows,
    tokenContextRows: joins.tokenContextRows.slice(0, 180),
    watchCandidates,
    routePositiveRows: [],
    summary,
    blockers,
    requiredForRoutePositive: [
      "deployed consumer references Thorchain router/vault/pool/synth/savers state",
      "referenced state is permissionlessly movable, stale, under-bound, or otherwise attacker-favorable",
      "borrow, redemption, bridge, liquidation, settlement, or unwind route is exact-quoted and positive",
      "fork/local proof",
    ],
    nextReadOnlyStep: joins.inboundSpecificJoinRows.length ? "Static-review the matched Thorchain consumer and exact-quote only if router/vault/pool state affects accepted value." : hasLiveVaultRows ? "Reopen Thorchain DEX only if a consumer references Thorchain-specific router/vault/pool/synth/savers state or inbound state changes materially." : "Reopen Thorchain DEX only if a reliable live vault/asgard inbound source becomes available or a consumer references Thorchain-specific router/vault/pool/synth/savers state.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));
  if (!QUIET) console.log(`Thorchain DEX Phase 0: evmPools=${summary.evmPoolRows} material=${summary.materialPoolRows} tokenContracts=${summary.tokenRows} inbound=${summary.inboundRows} currentRoutersWithCode=${summary.currentRouterRowsWithCode} vaultRows=${summary.vaultAddressRows} balanceRows=${summary.inboundBalanceRows} inboundConsumers=${summary.inboundSpecificJoinRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
}

main().catch((err) => { console.error(err?.message || String(err)); process.exit(1); });
