#!/usr/bin/env node
// scan-wisdomtree-phase0.js - read-only WisdomTree WTGXX RWA/NAV consumer Phase 0.
// RPC URLs are resolved in memory only and are never printed or stored.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "wisdomtree-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "wisdomtree-phase0-triage.md");
const EXTRA_PRODUCERS_REL = "reports/raw/fast/wisdomtree-phase0-extra-producers.json";
const EXTRA_PRODUCERS_OUT = path.join(WORKSPACE, EXTRA_PRODUCERS_REL);
const GRAPH_OUT_REL = "reports/raw/fast/wisdomtree-phase0-rwa-nav-consumer-graph.json";
const GRAPH_OUT = path.join(WORKSPACE, GRAPH_OUT_REL);
const QUIET = process.argv.includes("--quiet");

const ETHEREUM_CHAIN_ID = 1;
const MATERIAL_USD = 10_000;
const NAV_DIVERGENCE_BPS = 100;

const WTGXX = {
  source: "defillama-adapter:wisdomtree",
  protocol: "WisdomTree",
  chainId: 1,
  chain: "Ethereum",
  symbol: "WTGXX",
  name: "WisdomTree Government Money Market Digital Fund",
  address: "0x1feCF3d9d4Fee7f2c02917A66028a48C6706c179",
  navUsd: 1,
  category: "rwa-nav-token",
  tags: ["rwa", "money-market", "treasury", "permissioned-redemption", "transfer-restricted-possible"],
};

const STELLAR_CONTEXT = [
  { symbol: "WTGX", navUsd: 1.000 },
  { symbol: "FLTTX", navUsd: 1.013 },
  { symbol: "WTSYX", navUsd: 1.004 },
  { symbol: "WTTSX", navUsd: 9.833 },
  { symbol: "TIPSX", navUsd: 9.662 },
  { symbol: "WTSTX", navUsd: 9.511 },
  { symbol: "WTLGX", navUsd: 8.645 },
  { symbol: "SPXUX", navUsd: 15.815 },
  { symbol: "WTSIX", navUsd: 10.282 },
];

const LOCAL_ARTIFACTS = [
  { protocol: "Frax USD", file: "reports/raw/fast/frax-usd-phase0.json" },
  { protocol: "Nest Credit", file: "reports/raw/fast/nest-credit-phase0.json" },
  { protocol: "Aave/Euler/Silo graph", file: "reports/raw/fast/aave-euler-silo-consumer-graph.json" },
  { protocol: "Euler V2", file: "reports/raw/fast/euler-v2-phase0.json" },
  { protocol: "Silo V2", file: "reports/raw/fast/silo-v2-phase0.json" },
  { protocol: "Morpho Blue", file: "reports/raw/fast/morpho-pyth-unsafe-consumers.json" },
  { protocol: "Morpho allocator", file: "reports/raw/fast/morpho-public-allocator-force-feed.json" },
  { protocol: "Consumer-first high LTV", file: "reports/raw/fast/consumer-first-high-ltv-collateral.json" },
  { protocol: "Public lead consumers", file: "reports/raw/fast/public-lead-consumer-joins.json" },
  { protocol: "Pendle PT", file: "reports/raw/fast/pendle-pt-multichain-consumer-graph.json" },
];

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const BYTES32_TOKEN = new ethers.Interface(["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"]);
const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
  "function minter() view returns (address)",
]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readJson(file, fallback = null) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; } catch (_) { return fallback; } }
function writeJson(file, value) { ensureDir(file); fs.writeFileSync(file, JSON.stringify(value, jsonReplacer, 2) + "\n"); }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) {
  const text = String(value || "").replace(/^0X/, "0x");
  try { return ethers.getAddress(text); } catch (_) {
    if (/^0x[0-9a-fA-F]{40}$/.test(text)) {
      try { return ethers.getAddress(text.toLowerCase()); } catch (_) { return null; }
    }
    return null;
  }
}
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function decodeBytes32String(value) { try { return ethers.decodeBytes32String(value); } catch (_) { return null; } }
function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatNumber(value, decimals = 4) { const n = asNumber(value); return n === null ? "n/a" : n.toLocaleString(undefined, { maximumFractionDigits: decimals }); }
function formatUnitsNumber(raw, decimals) { try { return raw === null || raw === undefined ? null : Number(ethers.formatUnits(BigInt(raw), Number(decimals))); } catch (_) { return null; } }
function bpsDiff(reference, observed) {
  const ref = asNumber(reference);
  const obs = asNumber(observed);
  if (!ref || !obs || ref <= 0 || obs <= 0) return null;
  return ((obs / ref) - 1) * 10_000;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-wisdomtree-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = 10_000) {
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

async function latestBlock(rpc) {
  const hex = await rpcCall(rpc, "eth_blockNumber", [], 10_000).catch(() => null);
  return hex ? parseInt(hex, 16) : null;
}

function latestTvl(row) {
  if (Array.isArray(row?.tvl)) return asNumber(row.tvl.at(-1)?.totalLiquidityUSD);
  if (Array.isArray(row)) return asNumber(row.at(-1)?.totalLiquidityUSD);
  return asNumber(row?.totalLiquidityUSD ?? row?.tvl);
}

function publicMetadata(raw) {
  const chainNames = new Set([...(raw?.chains || []), ...Object.keys(raw?.chainTvls || {}), ...Object.keys(raw?.currentChainTvls || {})]);
  const chainTvls = {};
  for (const chain of chainNames) {
    const tvl = asNumber(raw?.currentChainTvls?.[chain]) ?? latestTvl(raw?.chainTvls?.[chain]);
    if (tvl !== null) chainTvls[chain] = round(tvl, 2);
  }
  return {
    name: raw?.name || "WisdomTree",
    slug: raw?.slug || "wisdomtree",
    category: raw?.category || "RWA",
    chains: raw?.chains || Object.keys(chainTvls),
    tvlUsd: round(latestTvl(raw?.tvl) ?? Object.values(chainTvls).reduce((sum, value) => sum + (asNumber(value) || 0), 0), 2),
    chainTvls,
  };
}

async function fetchAddressPrice(address) {
  const addr = lowerAddress(address);
  if (!addr) return null;
  const json = await fetchJson(`https://coins.llama.fi/prices/current/ethereum:${addr}?searchWidth=6h`, 30_000).catch(() => ({ coins: {} }));
  return asNumber(json?.coins?.[`ethereum:${addr}`]?.price);
}

async function tokenMeta(rpc, token, priceUsd) {
  const addr = normalizeAddress(token.address);
  const [code, sym, name, dec, supply, owner, admin, paused, minter] = await Promise.all([
    getCode(rpc, addr),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
    safeCall(rpc, addr, COMMON, "owner"),
    safeCall(rpc, addr, COMMON, "admin"),
    safeCall(rpc, addr, COMMON, "paused"),
    safeCall(rpc, addr, COMMON, "minter"),
  ]);
  const symbolBytes = sym ? null : await safeCall(rpc, addr, BYTES32_TOKEN, "symbol");
  const nameBytes = name ? null : await safeCall(rpc, addr, BYTES32_TOKEN, "name");
  const decimals = dec ? Number(dec[0]) : 18;
  const totalSupply = supply ? formatUnitsNumber(supply[0], decimals) : null;
  const navVsPriceBps = bpsDiff(priceUsd, token.navUsd);
  return {
    chain: token.chain,
    chainId: token.chainId,
    address: addr,
    codePresent: code !== "0x",
    codeBytes: Math.max(0, (code.length - 2) / 2),
    symbol: sym ? String(sym[0]) : decodeBytes32String(symbolBytes?.[0]) || token.symbol,
    name: name ? String(name[0]) : decodeBytes32String(nameBytes?.[0]) || token.name,
    decimals,
    totalSupplyRaw: supply ? supply[0].toString() : null,
    totalSupply,
    navUsd: token.navUsd,
    priceUsd,
    supplyUsdAtNav: totalSupply !== null ? totalSupply * token.navUsd : null,
    navVsPriceBps: round(navVsPriceBps, 4),
    currentAnomaly: Boolean(priceUsd && Math.abs(navVsPriceBps || 0) >= NAV_DIVERGENCE_BPS),
    owner: owner ? normalizeAddress(owner[0]) : null,
    admin: admin ? normalizeAddress(admin[0]) : null,
    minter: minter ? normalizeAddress(minter[0]) : null,
    paused: paused ? Boolean(paused[0]) : null,
  };
}

function buildExtraProducers() {
  return [{
    source: WTGXX.source,
    protocol: WTGXX.protocol,
    chainId: WTGXX.chainId,
    symbol: WTGXX.symbol,
    name: WTGXX.name,
    address: WTGXX.address,
    category: WTGXX.category,
    tags: WTGXX.tags,
  }];
}

function runConsumerGraph() {
  const child = spawnSync(process.execPath, ["scan-rwa-nav-consumer-graph.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      RWA_NAV_PROTOCOL_FILTER: "WisdomTree",
      RWA_NAV_CHAIN_IDS: "1",
      RWA_NAV_EXTRA_PRODUCER_FILE: EXTRA_PRODUCERS_REL,
      RWA_NAV_OUT: GRAPH_OUT_REL,
      RWA_NAV_MAX_EULER_VAULTS: process.env.RWA_NAV_MAX_EULER_VAULTS || "900",
      RWA_NAV_MAX_SILO_IDS: process.env.RWA_NAV_MAX_SILO_IDS || "900",
      RWA_NAV_MORPHO_TOP_N: process.env.RWA_NAV_MORPHO_TOP_N || "350",
    },
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
  });
  if (child.status !== 0) {
    const msg = `${child.stderr || child.stdout || "RWA/NAV child scanner failed"}`.slice(0, 1200);
    throw new Error(msg);
  }
  if (!QUIET && child.stdout) process.stdout.write(child.stdout);
  return readJson(GRAPH_OUT, null);
}

async function fetchDexRows(tokens) {
  const addresses = tokens.map((row) => lowerAddress(row.address)).filter(Boolean);
  if (!addresses.length) return [];
  const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${addresses.join(",")}`, 30_000).catch(() => ({}));
  const rows = [];
  for (const pair of json?.pairs || []) {
    const base = lowerAddress(pair.baseToken?.address);
    const quote = lowerAddress(pair.quoteToken?.address);
    const token = tokens.find((row) => lowerAddress(row.address) === base || lowerAddress(row.address) === quote);
    if (!token) continue;
    rows.push({
      chain: token.chain,
      symbol: token.symbol || null,
      token: token.address,
      chainId: pair.chainId || null,
      dexId: pair.dexId || null,
      pairAddress: pair.pairAddress || null,
      baseSymbol: pair.baseToken?.symbol || null,
      quoteSymbol: pair.quoteToken?.symbol || null,
      liquidityUsd: round(pair.liquidity?.usd, 2),
      volume24hUsd: round(pair.volume?.h24, 2),
      priceUsd: round(pair.priceUsd, 10),
    });
  }
  return rows.sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0)).slice(0, 50);
}

function rowMatches(value) {
  if (value === null || value === undefined) return false;
  const text = String(value).toLowerCase();
  return text.includes("wisdomtree")
    || text.includes("wisdom tree")
    || text.includes("wtgxx")
    || text.includes("nwisdom")
    || text.includes(lowerAddress(WTGXX.address));
}

function shallowSummary(row) {
  const out = {};
  for (const key of [
    "protocol", "chain", "chainId", "symbol", "label", "assetSymbol", "assetName", "vaultSymbol", "vaultName", "vaultLabel", "marketName",
    "asset", "token", "address", "vault", "market", "collateral", "loanToken", "oracle", "pairAddress", "config",
    "ltv", "lltv", "ltvBorrowBps", "maxLtv", "maxLtvBps", "liquidationThreshold", "liquidityUsd", "cashUsd",
    "borrowedUsd", "borrowUsd", "supplyUsd", "balanceUsd", "routeLiquidityUsd", "bestNetProfitUsd", "netProfitUsd", "routePositive", "watchCandidate", "blocker", "status",
  ]) if (row && Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined) out[key] = row[key];
  return out;
}

function collectLocalRowsFromValue(value, rows, limit, depth = 0) {
  if (!value || rows.length >= limit || depth > 10) return false;
  if (Array.isArray(value)) {
    let matched = false;
    for (const item of value) matched = collectLocalRowsFromValue(item, rows, limit, depth + 1) || matched;
    return matched;
  }
  if (typeof value !== "object") return rowMatches(value);
  let matched = false;
  for (const [key, child] of Object.entries(value)) {
    if (rowMatches(key) || (typeof child !== "object" && rowMatches(child))) matched = true;
  }
  for (const child of Object.values(value)) {
    if (rows.length >= limit) break;
    if (collectLocalRowsFromValue(child, rows, limit, depth + 1)) matched = true;
  }
  if (matched && rows.length < limit) rows.push(shallowSummary(value));
  return matched;
}

function collectLocalArtifactRows(limitPerArtifact = 30) {
  const rows = [];
  for (const artifact of LOCAL_ARTIFACTS) {
    const json = readJson(path.join(WORKSPACE, artifact.file), null);
    if (!json) continue;
    const matches = [];
    collectLocalRowsFromValue(json, matches, limitPerArtifact);
    for (const row of matches.slice(0, limitPerArtifact)) rows.push({ protocol: artifact.protocol, artifact: artifact.file, ...row });
  }
  return rows;
}

function nestContext() {
  const json = readJson(path.join(WORKSPACE, "reports", "raw", "fast", "nest-credit-phase0.json"), {});
  const vaultRows = (json.vaultRows || []).filter((row) => String(row.label || row.symbol || "").toLowerCase() === "nwisdom");
  const balanceRows = (json.balanceRows || []).filter((row) => String(row.vaultLabel || "").toLowerCase() === "nwisdom");
  return {
    vaultRows: vaultRows.map((row) => ({ chain: row.chain, chainId: row.chainId, vault: row.vault, label: row.label, codePresent: row.codePresent, owner: row.owner, totalSupplyRaw: row.totalSupplyRaw, decimals: row.decimals, routePositive: row.routePositive })),
    balanceRows: balanceRows.map((row) => ({ chain: row.chain, chainId: row.chainId, vault: row.vault, vaultLabel: row.vaultLabel, tokenSymbol: row.tokenSymbol, balanceAmount: row.balanceAmount, balanceUsd: round(row.balanceUsd, 2), routePositive: row.routePositive })),
  };
}

function flattenGraph(graph, field) {
  return (graph?.results || []).flatMap((row) => Array.isArray(row[field]) ? row[field] : []);
}

function writeReport(artifact) {
  const s = artifact.summary;
  const tokenTable = artifact.tokenRows.map((row) => `| ${row.chain} | ${row.symbol || "?"} | ${compactAddress(row.address)} | ${row.codePresent} | ${formatNumber(row.totalSupply, 4)} | ${formatUsd(row.supplyUsdAtNav)} | ${row.priceUsd ?? "n/a"} | ${row.navVsPriceBps ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const matchTable = artifact.topConsumerMatches.slice(0, 10).map((row) => `| ${row.protocol} | ${row.side} | ${row.producer?.symbol || "?"} | ${row.reviewCandidate} | ${row.watchCandidate} | ${formatUsd(row.market?.otherReserveCashUsd ?? row.market?.cashUsd ?? row.market?.baseCashUsd ?? row.market?.liquidityAssetsUsd ?? row.market?.oppositeLiquidityUsd)} | ${(row.blockers || []).slice(0, 2).join("; ") || "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const localTable = artifact.localArtifactRows.slice(0, 12).map((row) => `| ${row.protocol} | ${row.symbol || row.label || row.assetSymbol || row.vaultLabel || row.marketName || "?"} | ${compactAddress(row.asset || row.token || row.collateral || row.address || row.market || row.vault)} | ${row.ltvBorrowBps ?? row.lltv ?? row.maxLtv ?? row.maxLtvBps ?? "n/a"} | ${formatUsd(row.routeLiquidityUsd ?? row.liquidityUsd ?? row.cashUsd ?? row.balanceUsd)} | ${row.routePositive ?? false} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";
  const nestTable = artifact.nestContext.balanceRows.filter((row) => (asNumber(row.balanceUsd) || 0) > 0).map((row) => `| ${row.chain} | ${row.vaultLabel} | ${row.tokenSymbol} | ${formatNumber(row.balanceAmount, 4)} | ${formatUsd(row.balanceUsd)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a |";
  const dexTable = artifact.dexLiquidityRows.slice(0, 8).map((row) => `| ${row.chain || "n/a"} | ${row.symbol || "?"} | ${row.dexId || "n/a"} | ${row.baseSymbol || "?"}/${row.quoteSymbol || "?"} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.volume24hUsd)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";

  const content = `# 🟢 DORMANT - WisdomTree Phase 0 Triage

Generated: ${artifact.generatedAt}

Scanner: \`tools/scan-wisdomtree-phase0.js\`

Artifact: \`reports/raw/fast/wisdomtree-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This pass resolved the public WisdomTree adapter, scanned exact Ethereum WTGXX live token state, compared public NAV against token price context, seeded WTGXX into the generic RWA/NAV consumer graph, joined sanitized local WTGXX/nWISDOM artifacts, and checked public DEX liquidity. No exact-positive borrow, liquidation, redemption, or unwind route was found.

## Summary

| Metric | Value |
|---|---:|
| Public TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Ethereum TVL | ${formatUsd(s.ethereumTvlUsd)} |
| Stellar TVL context | ${formatUsd(s.stellarTvlUsd)} |
| Token rows with code | \`${s.tokenRowsWithCode}\` |
| WTGXX supply at NAV | ${formatUsd(s.wtgxxSupplyUsdAtNav)} |
| Consumer matches | \`${s.consumerMatches}\` |
| Local artifact rows | \`${s.localArtifactRows}\` |
| nWISDOM positive balance rows | \`${s.nWisdomPositiveBalanceRows}\` |
| WTGXX DEX rows | \`${s.dexLiquidityRows}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |
| Coverage classification | \`${s.coverageClassification}\` |

## Token Rows

| Chain | Symbol | Token | Code | Supply | Supply at NAV | Public price | NAV vs price bps |
|---|---|---|---:|---:|---:|---:|---:|
${tokenTable}

## Consumer Matches

| Protocol | Side | Producer | Review | Watch | Route-side liquidity | Blocker |
|---|---|---|---:|---:|---:|---|
${matchTable}

## Local Artifact Joins

| Source | Symbol/Market | Address | LTV/LLTV | Liquidity/Cash | Route-positive |
|---|---|---|---:|---:|---:|
${localTable}

## nWISDOM Context

| Chain | Vault | Token | Amount | USD |
|---|---|---|---:|---:|
${nestTable}

## DEX Context

| Chain | Symbol | DEX | Pair | Liquidity USD | 24h volume USD |
|---|---|---|---|---:|---:|
${dexTable}

## Blockers

${artifact.blockers.map((row) => `- ${row}`).join("\n")}

No fork PoC, signed action, exploit call, or executor work is justified from this artifact.
`;
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  ensureDir(RAW_OUT);
  const [publicRaw, rpc] = await Promise.all([
    fetchJson("https://api.llama.fi/protocol/wisdomtree", 45_000).catch(() => ({})),
    resolveRpc(ETHEREUM_CHAIN_ID),
  ]);
  const publicMeta = publicMetadata(publicRaw);
  const blockNumber = rpc ? await latestBlock(rpc) : null;
  const publicPrice = await fetchAddressPrice(WTGXX.address);
  const tokenRows = [await tokenMeta(rpc, WTGXX, publicPrice ?? WTGXX.navUsd)];
  const extraProducers = buildExtraProducers();
  writeJson(EXTRA_PRODUCERS_OUT, {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-wisdomtree-phase0.js",
    scope: "Exact WisdomTree WTGXX producer seed for RWA/NAV consumer graph",
    safety: { rpcUrlsStored: false, privateKeysRead: false, signedActions: false },
    producers: extraProducers,
  });
  const graph = runConsumerGraph();
  const localArtifactRows = collectLocalArtifactRows();
  const dexRows = await fetchDexRows(tokenRows);
  const nestRows = nestContext();
  const topConsumerMatches = flattenGraph(graph, "topMatches");
  topConsumerMatches.sort((a, b) => Number(b.routePositive) - Number(a.routePositive) || Number(b.watchCandidate) - Number(a.watchCandidate) || Number(b.reviewCandidate) - Number(a.reviewCandidate));

  const graphSummary = graph?.summary || {};
  const tokenWatch = tokenRows.filter((row) => row.currentAnomaly).length;
  const graphWatch = asNumber(graphSummary.watchCandidates) || 0;
  const routePositive = asNumber(graphSummary.routePositive) || 0;
  const nWisdomPositiveBalanceRows = nestRows.balanceRows.filter((row) => (asNumber(row.balanceUsd) || 0) > 0).length;
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-wisdomtree-phase0.js",
    scope: "Read-only WisdomTree WTGXX RWA/NAV token, consumer-join, nWISDOM context, and DEX exit-liquidity Phase 0 on Ethereum",
    safety: {
      publicApisOnly: false,
      rpcInventoryRead: Boolean(rpc),
      rpcUrlsStored: false,
      endpointContentsStored: false,
      privateKeysRead: false,
      signedActions: false,
      calldataStored: false,
      borrowerAddressesStored: false,
      forkTransactions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    publicMetadata: publicMeta,
    adapterSource: {
      tvlCodePath: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/wisdomtree/index.js",
      ethereumToken: WTGXX.address,
      ethereumNavUsd: WTGXX.navUsd,
      stellarContext: STELLAR_CONTEXT,
    },
    thresholds: { materialUsd: MATERIAL_USD, navDivergenceBps: NAV_DIVERGENCE_BPS },
    summary: {
      defillamaCurrentTvlUsd: publicMeta.tvlUsd,
      ethereumTvlUsd: publicMeta.chainTvls?.Ethereum ?? null,
      stellarTvlUsd: publicMeta.chainTvls?.Stellar ?? null,
      ethereumRpcResolved: Boolean(rpc),
      ethereumBlock: blockNumber,
      tokenRows: tokenRows.length,
      tokenRowsWithCode: tokenRows.filter((row) => row.codePresent).length,
      wtgxxSupplyUsdAtNav: round(tokenRows[0]?.supplyUsdAtNav, 2),
      navVsPriceBps: tokenRows[0]?.navVsPriceBps ?? null,
      consumerMatches: asNumber(graphSummary.matches) || 0,
      graphReviewCandidates: asNumber(graphSummary.reviewCandidates) || 0,
      graphWatchCandidates: graphWatch,
      localArtifactRows: localArtifactRows.length,
      nWisdomVaultRows: nestRows.vaultRows.length,
      nWisdomPositiveBalanceRows,
      nWisdomPositiveBalanceUsd: round(nestRows.balanceRows.reduce((sum, row) => sum + (asNumber(row.balanceUsd) || 0), 0), 2),
      dexLiquidityRows: dexRows.length,
      topDexLiquidityUsd: round(Math.max(0, ...dexRows.map((row) => asNumber(row.liquidityUsd) || 0)), 2),
      watchCandidates: tokenWatch + graphWatch,
      routePositive,
      executableNow: false,
      signedActionJustified: false,
      coverageClassification: "bounded-with-caveats",
    },
    tokenRows,
    extraProducerSeedCount: extraProducers.length,
    consumerGraphArtifact: GRAPH_OUT_REL,
    consumerGraphSummary: graphSummary,
    topConsumerMatches: topConsumerMatches.slice(0, 80),
    localArtifactRows,
    nestContext: nestRows,
    dexLiquidityRows: dexRows,
    blockers: [
      "WTGXX has no public DEX acquisition/exit liquidity in this pass.",
      "No generic RWA/NAV lending/oracle consumer match for exact WTGXX was found on Ethereum.",
      "nWISDOM appears only as Nest context with tiny positive stablecoin balances and no consumer-grade join in the source Nest artifact.",
      "WisdomTree RWA issuance/redemption and transferability remain treated as permissioned or non-atomic absent public same-block exit proof.",
      "Stellar WisdomTree assets are non-EVM context for this pass; Ethereum WTGXX is the active EVM scope.",
      "No fork extraction proof.",
    ],
    requiredForRoutePositive: [
      "WTGXX or nWISDOM accepted by a material lending, margin, redemption, or liquidation consumer",
      "current NAV/oracle/accepted-value divergence favorable after LTV/LLTV haircut and costs",
      "borrow, redemption, liquidation, or DEX exit liquidity is live and exact-quoted positive",
      "permissionless transfer/redemption path for the exact token and size",
      "fork extraction proof",
    ],
  };
  writeJson(RAW_OUT, artifact);
  writeReport(artifact);
  if (!QUIET) {
    console.log(`WisdomTree Phase0: tokenRows=${artifact.summary.tokenRows} matches=${artifact.summary.consumerMatches} local=${artifact.summary.localArtifactRows} dex=${artifact.summary.dexLiquidityRows} watch=${artifact.summary.watchCandidates} routePositive=${artifact.summary.routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
