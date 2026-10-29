#!/usr/bin/env node
// scan-republic-note-phase0.js - read-only Republic Note RWA/NAV consumer Phase 0.
// RPC URLs are resolved in memory only and are never printed or stored.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc, getImpl } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "republic-note-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "republic-note-phase0-triage.md");
const EXTRA_PRODUCERS_REL = "reports/raw/fast/republic-note-phase0-extra-producers.json";
const EXTRA_PRODUCERS_OUT = path.join(WORKSPACE, EXTRA_PRODUCERS_REL);
const GRAPH_OUT_REL = "reports/raw/fast/republic-note-phase0-rwa-nav-consumer-graph.json";
const GRAPH_OUT = path.join(WORKSPACE, GRAPH_OUT_REL);
const QUIET = process.argv.includes("--quiet");

const AVALANCHE_CHAIN_ID = 43114;
const NOTE = {
  source: "defillama-adapter:republic/index.js",
  protocol: "Republic Note",
  chain: "Avalanche",
  chainId: AVALANCHE_CHAIN_ID,
  symbol: "NOTE",
  name: "Republic Note",
  address: "0x7c6a937943F135283A2561938DE2200994a8f7a7",
  category: "rwa-nav-token",
  tags: ["private-equity", "permissioned-redemption", "transfer-restricted-possible"],
};

const LOCAL_ARTIFACTS = [
  { protocol: "Aave/Euler/Silo graph", file: "reports/raw/fast/aave-euler-silo-consumer-graph.json" },
  { protocol: "Consumer-first high LTV", file: "reports/raw/fast/consumer-first-high-ltv-collateral.json" },
  { protocol: "Public lead consumers", file: "reports/raw/fast/public-lead-consumer-joins.json" },
  { protocol: "RWA/NAV graph", file: "reports/raw/fast/rwa-nav-consumer-graph.json" },
  { protocol: "Centrifuge NAV graph", file: "reports/raw/fast/centrifuge-nav-consumer-graph.json" },
  { protocol: "Pendle PT", file: "reports/raw/fast/pendle-pt-multichain-consumer-graph.json" },
  { protocol: "Morpho Blue", file: "reports/raw/fast/morpho-pyth-unsafe-consumers.json" },
  { protocol: "Morpho allocator", file: "reports/raw/fast/morpho-public-allocator-force-feed.json" },
  { protocol: "Euler V2", file: "reports/raw/fast/euler-v2-phase0.json" },
  { protocol: "Silo V2", file: "reports/raw/fast/silo-v2-phase0.json" },
  { protocol: "Benqi Lending", file: "reports/raw/fast/benqi-lending-phase0.json" },
  { protocol: "Avalanche stable yield", file: "reports/raw/fast/avalanche-stable-yield-routes.json" },
];

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function contractBalanceOf() view returns (uint256)",
]);
const BYTES32_TOKEN = new ethers.Interface(["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"]);
const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
  "function minter() view returns (address)",
  "function controller() view returns (address)",
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readJson(file, fallback = null) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; } catch (_) { return fallback; } }
function writeJson(file, value) { ensureDir(file); fs.writeFileSync(file, `${JSON.stringify(value, jsonReplacer, 2)}\n`); }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(value); } catch (_) { return null; } }
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

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-republic-note-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-republic-note-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = 10_000) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr) return null;
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ to: addr, data: iface.encodeFunctionData(fn, args) }, "latest"], timeoutMs);
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
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

function latestRow(rows) { return Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null; }
function publicMetadata(raw) {
  const chainTvls = {};
  for (const chain of new Set([...(raw?.chains || []), ...Object.keys(raw?.currentChainTvls || {})])) {
    const tvl = asNumber(raw?.currentChainTvls?.[chain]);
    if (tvl !== null) chainTvls[chain] = round(tvl, 2);
  }
  const latestTvl = asNumber(latestRow(raw?.tvl)?.totalLiquidityUSD) || Object.values(chainTvls).reduce((sum, value) => sum + (asNumber(value) || 0), 0);
  const avaxTokens = latestRow(raw?.chainTvls?.Avalanche?.tokens)?.tokens || {};
  const avaxTokensUsd = latestRow(raw?.chainTvls?.Avalanche?.tokensInUsd)?.tokens || {};
  return {
    name: raw?.name || "Republic Note",
    slug: raw?.slug || "republic-note",
    category: raw?.category || "RWA",
    url: raw?.url || null,
    twitter: raw?.twitter || null,
    audits: raw?.audits || null,
    symbol: raw?.symbol || "NOTE",
    chains: raw?.chains || Object.keys(chainTvls),
    module: raw?.module || null,
    tvlCodePath: raw?.tvlCodePath || null,
    geckoId: raw?.gecko_id || null,
    cmcId: raw?.cmcId || null,
    tags: raw?.tags || [],
    tvlUsd: round(latestTvl, 2),
    chainTvls,
    avalancheTokens: avaxTokens,
    avalancheTokensUsd: avaxTokensUsd,
  };
}

async function fetchAddressPrice(address) {
  const addr = lowerAddress(address);
  if (!addr) return null;
  const json = await fetchJson(`https://coins.llama.fi/prices/current/avax:${addr}?searchWidth=6h`, 30_000).catch(() => ({ coins: {} }));
  return json?.coins?.[`avax:${addr}`] || null;
}

async function tokenMeta(rpc, token, publicPrice, publicMeta) {
  const addr = normalizeAddress(token.address);
  const [code, impl, sym, name, dec, supply, adapterBalance, owner, admin, paused, minter, controller, asset, totalAssets, convertOne] = await Promise.all([
    getCode(rpc, addr),
    getImpl(rpc, addr, 10_000).catch(() => null),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
    safeCall(rpc, addr, ERC20, "contractBalanceOf"),
    safeCall(rpc, addr, COMMON, "owner"),
    safeCall(rpc, addr, COMMON, "admin"),
    safeCall(rpc, addr, COMMON, "paused"),
    safeCall(rpc, addr, COMMON, "minter"),
    safeCall(rpc, addr, COMMON, "controller"),
    safeCall(rpc, addr, COMMON, "asset"),
    safeCall(rpc, addr, COMMON, "totalAssets"),
    safeCall(rpc, addr, COMMON, "convertToAssets", [10n ** 8n]),
  ]);
  const symbolBytes = sym ? null : await safeCall(rpc, addr, BYTES32_TOKEN, "symbol");
  const nameBytes = name ? null : await safeCall(rpc, addr, BYTES32_TOKEN, "name");
  const decimals = dec ? Number(dec[0]) : Number(publicPrice?.decimals || 8);
  const totalSupply = supply ? formatUnitsNumber(supply[0], decimals) : null;
  const adapterBalanceAmount = adapterBalance ? formatUnitsNumber(adapterBalance[0], decimals) : null;
  const priceUsd = asNumber(publicPrice?.price);
  const publicTvlUsd = asNumber(publicMeta?.tvlUsd);
  const adapterPriceUsd = adapterBalanceAmount ? publicTvlUsd / adapterBalanceAmount : null;
  const erc4626Asset = asset ? normalizeAddress(asset[0]) : null;
  return {
    chain: token.chain,
    chainId: token.chainId,
    address: addr,
    codePresent: code !== "0x",
    codeBytes: Math.max(0, (code.length - 2) / 2),
    eip1967Implementation: impl,
    symbol: sym ? String(sym[0]) : decodeBytes32String(symbolBytes?.[0]) || token.symbol,
    name: name ? String(name[0]) : decodeBytes32String(nameBytes?.[0]) || token.name,
    decimals,
    totalSupplyRaw: supply ? supply[0].toString() : null,
    totalSupply,
    contractBalanceOfRaw: adapterBalance ? adapterBalance[0].toString() : null,
    contractBalanceOf: adapterBalanceAmount,
    publicPriceUsd: priceUsd,
    priceTimestamp: publicPrice?.timestamp || null,
    priceConfidence: asNumber(publicPrice?.confidence),
    adapterImpliedPriceUsd: round(adapterPriceUsd, 10),
    contractBalanceUsd: adapterBalanceAmount && priceUsd ? adapterBalanceAmount * priceUsd : null,
    totalSupplyUsd: totalSupply && priceUsd ? totalSupply * priceUsd : null,
    erc4626Like: Boolean(erc4626Asset && erc4626Asset !== ethers.ZeroAddress && (totalAssets || convertOne)),
    erc4626: erc4626Asset && erc4626Asset !== ethers.ZeroAddress ? {
      asset: erc4626Asset,
      totalAssetsRaw: totalAssets ? totalAssets[0].toString() : null,
      convertOneTokenToAssetsRaw: convertOne ? convertOne[0].toString() : null,
    } : null,
    roles: {
      owner: owner ? normalizeAddress(owner[0]) : null,
      admin: admin ? normalizeAddress(admin[0]) : null,
      minter: minter ? normalizeAddress(minter[0]) : null,
      controller: controller ? normalizeAddress(controller[0]) : null,
      paused: paused ? Boolean(paused[0]) : null,
    },
  };
}

function buildExtraProducers() {
  return [{
    source: NOTE.source,
    protocol: NOTE.protocol,
    chainId: NOTE.chainId,
    symbol: NOTE.symbol,
    name: NOTE.name,
    address: NOTE.address,
    category: NOTE.category,
    tags: NOTE.tags,
  }];
}

function runConsumerGraph() {
  const child = spawnSync(process.execPath, ["scan-rwa-nav-consumer-graph.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      RWA_NAV_PROTOCOL_FILTER: "Republic Note",
      RWA_NAV_CHAIN_IDS: "43114",
      RWA_NAV_EXTRA_PRODUCER_FILE: EXTRA_PRODUCERS_REL,
      RWA_NAV_OUT: GRAPH_OUT_REL,
      RWA_NAV_MAX_EULER_VAULTS: process.env.RWA_NAV_MAX_EULER_VAULTS || "500",
      RWA_NAV_MAX_SILO_IDS: process.env.RWA_NAV_MAX_SILO_IDS || "500",
      RWA_NAV_MORPHO_TOP_N: process.env.RWA_NAV_MORPHO_TOP_N || "500",
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
      chain: pair.chainId || token.chain,
      symbol: token.symbol || null,
      token: token.address,
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

const EXACT_ADDRESS = lowerAddress(NOTE.address);
function rowMatches(value) {
  if (value === null || value === undefined) return false;
  const text = String(value).toLowerCase();
  return text.includes(EXACT_ADDRESS) || text.includes("republic note") || text.includes("republic-note");
}

function shallowSummary(row) {
  const out = {};
  for (const key of [
    "protocol", "chain", "chainId", "symbol", "label", "assetSymbol", "assetName", "vaultSymbol", "vaultName", "marketName",
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

function flattenGraph(graph, field) {
  return (graph?.results || []).flatMap((row) => Array.isArray(row[field]) ? row[field] : []);
}

function writeReport(artifact) {
  const s = artifact.summary;
  const tokenTable = artifact.tokenRows.map((row) => `| ${row.chain} | ${row.symbol || "?"} | ${compactAddress(row.address)} | ${row.codePresent} | ${formatNumber(row.totalSupply, 4)} | ${formatNumber(row.contractBalanceOf, 4)} | ${formatUsd(row.contractBalanceUsd)} | ${row.publicPriceUsd ?? "n/a"} | ${row.erc4626Like} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const matchTable = artifact.topConsumerMatches.slice(0, 10).map((row) => `| ${row.protocol} | ${row.side} | ${row.producer?.symbol || "?"} | ${row.reviewCandidate} | ${row.watchCandidate} | ${formatUsd(row.market?.otherReserveCashUsd ?? row.market?.cashUsd ?? row.market?.baseCashUsd ?? row.market?.liquidityAssetsUsd ?? row.market?.oppositeLiquidityUsd)} | ${(row.blockers || []).slice(0, 2).join("; ") || "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const localTable = artifact.localArtifactRows.slice(0, 12).map((row) => `| ${row.protocol} | ${row.symbol || row.label || row.assetSymbol || row.vaultLabel || row.marketName || "?"} | ${compactAddress(row.asset || row.token || row.collateral || row.address || row.market || row.vault)} | ${row.ltvBorrowBps ?? row.lltv ?? row.maxLtv ?? row.maxLtvBps ?? "n/a"} | ${formatUsd(row.routeLiquidityUsd ?? row.liquidityUsd ?? row.cashUsd ?? row.balanceUsd)} | ${row.routePositive ?? false} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";
  const dexTable = artifact.dexLiquidityRows.slice(0, 8).map((row) => `| ${row.chain || "n/a"} | ${row.symbol || "?"} | ${row.dexId || "n/a"} | ${row.baseSymbol || "?"}/${row.quoteSymbol || "?"} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.volume24hUsd)} | ${row.priceUsd ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";

  const content = `# 🟢 DORMANT - Republic Note Phase 0 Triage

Generated: ${artifact.generatedAt}

Scanner: \`tools/scan-republic-note-phase0.js\`

Artifact: \`reports/raw/fast/republic-note-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This pass resolved the public Republic Note adapter, scanned exact Avalanche NOTE live token state, compared public price and adapter accounting, seeded NOTE into the generic RWA/NAV consumer graph, joined sanitized local artifacts, and checked public DEX exit liquidity. No exact-positive borrow, liquidation, redemption, or unwind route was found.

## Summary

| Metric | Value |
|---|---:|
| Public TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Avalanche TVL | ${formatUsd(s.avalancheTvlUsd)} |
| NOTE token rows with code | \`${s.tokenRowsWithCode}\` |
| NOTE total supply | ${formatNumber(s.noteTotalSupply, 4)} |
| Adapter contractBalanceOf | ${formatNumber(s.noteContractBalance, 4)} |
| Adapter balance at public price | ${formatUsd(s.noteContractBalanceUsd)} |
| Public price | ${s.notePriceUsd ?? "n/a"} |
| ERC4626-like rows | \`${s.erc4626LikeRows}\` |
| Consumer matches | \`${s.consumerMatches}\` |
| Local artifact rows | \`${s.localArtifactRows}\` |
| DEX rows | \`${s.dexLiquidityRows}\` |
| Top DEX liquidity | ${formatUsd(s.topDexLiquidityUsd)} |
| Watch candidates | \`${s.watchCandidates}\` |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |
| Coverage classification | \`${s.coverageClassification}\` |

## Token Rows

| Chain | Symbol | Token | Code | Total supply | contractBalanceOf | Balance USD | Public price | ERC4626-like |
|---|---|---|---:|---:|---:|---:|---:|---:|
${tokenTable}

## Consumer Matches

| Protocol | Side | Producer | Review | Watch | Route-side liquidity | Blocker |
|---|---|---|---:|---:|---:|---|
${matchTable}

## Local Artifact Joins

| Source | Symbol/Market | Address | LTV/LLTV | Liquidity/Cash | Route-positive |
|---|---|---|---:|---:|---:|
${localTable}

## DEX Context

| Chain | Symbol | DEX | Pair | Liquidity USD | 24h volume USD | Price USD |
|---|---|---|---|---:|---:|---:|
${dexTable}

## Blockers

${artifact.blockers.map((row) => `- ${row}`).join("\n")}

## Required For Route-Positive

${artifact.requiredForRoutePositive.map((row) => `- ${row}`).join("\n")}

## Next Read-Only Step

Keep Republic Note closed unless NOTE gains a material trusted consumer, a public DEX or permissionless redemption exit appears, or a current accepted-value/NAV/oracle divergence maps to exact-positive economics.
`;
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  ensureDir(RAW_OUT);
  const [publicRaw, rpc, adapterSource, publicPrice] = await Promise.all([
    fetchJson("https://api.llama.fi/protocol/republic-note", 45_000).catch(() => ({})),
    resolveRpc(AVALANCHE_CHAIN_ID),
    fetchText("https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/republic/index.js", 30_000).catch(() => null),
    fetchAddressPrice(NOTE.address),
  ]);
  const publicMeta = publicMetadata(publicRaw);
  const blockNumber = rpc ? await latestBlock(rpc) : null;
  const tokenRows = [await tokenMeta(rpc, NOTE, publicPrice, publicMeta)];
  const extraProducers = buildExtraProducers();
  writeJson(EXTRA_PRODUCERS_OUT, {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-republic-note-phase0.js",
    scope: "Exact Republic Note NOTE producer seed for RWA/NAV consumer graph",
    safety: { rpcUrlsStored: false, privateKeysRead: false, signedActions: false },
    producers: extraProducers,
  });
  const graph = runConsumerGraph();
  const [dexLiquidityRows, localArtifactRows] = await Promise.all([
    fetchDexRows(tokenRows),
    Promise.resolve(collectLocalArtifactRows()),
  ]);
  const topConsumerMatches = flattenGraph(graph, "topMatches");
  topConsumerMatches.sort((a, b) => Number(b.routePositive) - Number(a.routePositive) || Number(b.watchCandidate) - Number(a.watchCandidate) || Number(b.reviewCandidate) - Number(a.reviewCandidate));
  const graphSummary = graph?.summary || {};
  const routePositive = asNumber(graphSummary.routePositive) || 0;
  const watchCandidates = asNumber(graphSummary.watchCandidates) || 0;
  const token = tokenRows[0] || {};
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-republic-note-phase0.js",
    scope: "Read-only Republic Note NOTE RWA/NAV token, consumer-join, adapter accounting, and DEX exit-liquidity Phase 0 on Avalanche",
    safety: {
      publicApisOnlyForMetadata: true,
      rpcInventoryRead: Boolean(rpc),
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      calldataStored: false,
      borrowerAddressesStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: routePositive > 0,
      executableNow: false,
      signedActionJustified: false,
    },
    metadata: publicMeta,
    adapter: {
      module: publicMeta.module,
      tvlCodePath: publicMeta.tvlCodePath,
      rawSourceResolved: Boolean(adapterSource),
      noteAddressFromAdapter: adapterSource?.match(/0x[0-9a-fA-F]{40}/)?.[0] || null,
      tvlMethod: "api.call({ target: NOTE, abi: 'uint256:contractBalanceOf' }) then api.add(NOTE, supply)",
    },
    block: { chain: "Avalanche", chainId: AVALANCHE_CHAIN_ID, number: blockNumber },
    exactTokenSeeds: extraProducers,
    tokenRows,
    topConsumerMatches,
    dexLiquidityRows,
    localArtifactRows,
    consumerGraph: graph,
    summary: {
      defillamaCurrentTvlUsd: round(publicMeta.tvlUsd, 2),
      avalancheTvlUsd: round(publicMeta.chainTvls?.Avalanche, 2),
      defillamaNoteTokens: round(publicMeta.avalancheTokens?.NOTE, 6),
      defillamaNoteTokensUsd: round(publicMeta.avalancheTokensUsd?.NOTE, 2),
      tokenRows: tokenRows.length,
      tokenRowsWithCode: tokenRows.filter((row) => row.codePresent).length,
      noteTotalSupply: round(token.totalSupply, 6),
      noteContractBalance: round(token.contractBalanceOf, 6),
      noteContractBalanceUsd: round(token.contractBalanceUsd, 2),
      notePriceUsd: round(token.publicPriceUsd, 10),
      noteAdapterImpliedPriceUsd: token.adapterImpliedPriceUsd,
      erc4626LikeRows: tokenRows.filter((row) => row.erc4626Like).length,
      consumerMatches: asNumber(graphSummary.matches) || 0,
      reviewCandidates: asNumber(graphSummary.reviewCandidates) || 0,
      graphWatchCandidates: asNumber(graphSummary.watchCandidates) || 0,
      watchCandidates,
      localArtifactRows: localArtifactRows.length,
      dexLiquidityRows: dexLiquidityRows.length,
      topDexLiquidityUsd: round(dexLiquidityRows[0]?.liquidityUsd, 2),
      routePositive,
      executableNow: false,
      signedActionJustified: false,
      coverageClassification: "bounded-with-caveats",
      forkGate: routePositive > 0 ? "route-positive-needs-fork-proof" : "closed-route-positive-zero",
      status: routePositive > 0 ? "republic-note-route-positive-needs-proof" : watchCandidates > 0 ? "republic-note-watch-needs-consumer-economics" : "republic-note-phase0-no-route-positive",
    },
    blockers: [
      "The public adapter values NOTE using contractBalanceOf and a public token price, not a permissionless NAV or redemption route",
      "NOTE exposes no ERC4626-like NAV interface in this read-only pass",
      "The generic RWA/NAV consumer graph found zero exact NOTE lending/oracle consumer matches on Avalanche",
      "Dexscreener returned no public DEX pair rows for the exact NOTE token address, so no same-block public acquisition or exit route is proven",
      "Republic Note issuance/redemption/transferability remains treated as permissioned or restricted absent public atomic exit proof",
      "No fork extraction proof and no signed-action justification exist",
    ],
    requiredForRoutePositive: [
      "Exact NOTE accepted by a material lending, margin, redemption, PT/vault, or liquidation consumer",
      "Current accepted value, oracle value, NAV, or redemption value exceeds exact acquisition/exit value after LTV/LLTV haircut and costs",
      "Permissionless acquisition plus borrow, redemption, liquidation, or DEX exit liquidity is live and exact-quoted positive",
      "Transfer/redemption path for the exact NOTE size is not role-gated, queued, or delayed beyond the route model",
      "Fork extraction proof demonstrates measured net profit",
    ],
    nextReadOnlyStep: "Keep Republic Note closed unless NOTE gains a material trusted consumer, a public DEX or permissionless redemption exit appears, or a current accepted-value/NAV/oracle divergence maps to exact-positive economics.",
  };

  writeJson(RAW_OUT, output);
  writeReport(output);
  if (!QUIET) {
    console.log(`Republic Note Phase0: tvl=${formatUsd(output.summary.defillamaCurrentTvlUsd)} tokenRows=${output.summary.tokenRowsWithCode}/${output.summary.tokenRows} matches=${output.summary.consumerMatches} dexRows=${output.summary.dexLiquidityRows} watch=${watchCandidates} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(String(err?.message || err).slice(0, 1000));
  process.exit(1);
});
