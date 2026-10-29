#!/usr/bin/env node
// scan-saturn-susdat-phase0.js - read-only Phase 0 for Saturn USDat/sUSDat yield/backing/consumer joins.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "saturn-susdat-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "saturn-susdat-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const ETHEREUM_CHAIN_ID = 1;
const CHAIN = "Ethereum";
const YIELD_POOL = "47e72726-3b2b-4fe6-b4a9-a26e1fcd9a50";
const US_DAT = "0x23238f20b894f29041f48D88eE91131C395Aaa71";
const S_US_DAT = "0xD166337499E176bbC38a1FBd113Ab144e5bd2Df7";
const M_TOKEN = "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const STRC_DECIMALS = 6;
const ZERO = "0x0000000000000000000000000000000000000000";
const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const BYTES32_TOKEN = new ethers.Interface(["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"]);
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
  "function previewDeposit(uint256) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
]);
const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
  "function strcBalance() view returns (uint256)",
]);

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const CONSUMER_ARTIFACTS = [
  ["pendle-pt-multichain", "reports/raw/fast/pendle-pt-multichain-consumer-graph.json"],
  ["pendle-pt", "reports/raw/fast/pendle-pt-consumer-graph.json"],
  ["pendle-yt", "reports/raw/fast/pendle-yt-collateral-routes.json"],
  ["ccip", "reports/raw/fast/ccip-phase0.json"],
  ["current-profit", "reports/raw/fast/current-profit-lead-triage.json"],
  ["dex-consumer-routes", "reports/raw/fast/dex-consumer-routes.json"],
  ["erc4626-consumer", "reports/raw/fast/erc4626-consumer-joiner.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["euler-v2", "reports/raw/fast/euler-v2-phase0.json"],
  ["silo-v2", "reports/raw/fast/silo-v2-phase0.json"],
  ["morpho-liquidatable", "reports/raw/fast/morpho-liquidatable-marketability.json"],
  ["morpho-wrapper-exit", "reports/raw/fast/morpho-wrapper-exit-proof-gaps.json"],
  ["bridge-synthetic-consumer", "reports/raw/fast/bridge-synthetic-consumer-exposure.json"],
  ["rwa-nav-consumer", "reports/raw/fast/rwa-nav-consumer-graph.json"],
];

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function decodeBytes32String(value) { try { return ethers.decodeBytes32String(value); } catch (_) { return null; } }
function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const factor = 10 ** decimals; return Math.round(n * factor) / factor; }
function decimalsToNumber(value, decimals) { try { if (value === null || value === undefined || decimals === null || decimals === undefined) return null; const n = Number(ethers.formatUnits(BigInt(value), Number(decimals))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatNumber(value, decimals = 6) { const n = asNumber(value); return n === null ? "n/a" : n.toLocaleString(undefined, { maximumFractionDigits: decimals }); }
function safeText(value, max = 160) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function addressFromStorageSlot(raw) { if (!raw || raw === "0x") return null; const hex = strip0x(raw).padStart(64, "0"); if (/^0+$/.test(hex)) return null; return normalizeAddress(`0x${hex.slice(-40)}`); }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-saturn-phase0/1.0" } });
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

async function latestBlockTimestamp(rpc, blockNumber) {
  const block = blockNumber ? await rpcCall(rpc, "eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false], 10_000).catch(() => null) : null;
  return block?.timestamp ? parseInt(block.timestamp, 16) : null;
}

async function tokenMeta(rpc, address) {
  const addr = normalizeAddress(address);
  const code = await getCode(rpc, addr);
  const [sym, name, dec, supply, implRaw, adminRaw, beaconRaw, owner, admin, paused] = await Promise.all([
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
    getStorage(rpc, addr, EIP1967_IMPLEMENTATION_SLOT),
    getStorage(rpc, addr, EIP1967_ADMIN_SLOT),
    getStorage(rpc, addr, EIP1967_BEACON_SLOT),
    safeCall(rpc, addr, COMMON, "owner"),
    safeCall(rpc, addr, COMMON, "admin"),
    safeCall(rpc, addr, COMMON, "paused"),
  ]);
  const symbolBytes = sym ? null : await safeCall(rpc, addr, BYTES32_TOKEN, "symbol");
  const nameBytes = name ? null : await safeCall(rpc, addr, BYTES32_TOKEN, "name");
  const decimals = dec ? Number(dec[0]) : 18;
  return {
    address: addr,
    codePresent: code !== "0x",
    codeBytes: Math.max(0, (code.length - 2) / 2),
    implementation: addressFromStorageSlot(implRaw),
    adminSlot: addressFromStorageSlot(adminRaw),
    beacon: addressFromStorageSlot(beaconRaw),
    symbol: sym ? String(sym[0]) : decodeBytes32String(symbolBytes?.[0]) || null,
    name: name ? String(name[0]) : decodeBytes32String(nameBytes?.[0]) || null,
    decimals,
    totalSupplyRaw: supply ? supply[0].toString() : null,
    totalSupply: supply ? decimalsToNumber(supply[0], decimals) : null,
    owner: owner ? normalizeAddress(owner[0]) : null,
    admin: admin ? normalizeAddress(admin[0]) : null,
    paused: paused ? Boolean(paused[0]) : null,
  };
}

async function erc4626State(rpc, token, holder = ZERO, assetDecimalsOverride = null) {
  const addr = normalizeAddress(token.address);
  const shareDecimals = token.decimals ?? 18;
  const oneShare = 10n ** BigInt(shareDecimals);
  const asset = await safeCall(rpc, addr, ERC4626, "asset");
  const assetDecimals = assetDecimalsOverride ?? shareDecimals;
  const oneAsset = 10n ** BigInt(assetDecimals);
  const [totalAssets, oneShareToAssets, oneAssetToShares, maxDeposit, maxWithdraw, previewDeposit, previewRedeem] = await Promise.all([
    safeCall(rpc, addr, ERC4626, "totalAssets"),
    safeCall(rpc, addr, ERC4626, "convertToAssets", [oneShare]),
    safeCall(rpc, addr, ERC4626, "convertToShares", [oneAsset]),
    safeCall(rpc, addr, ERC4626, "maxDeposit", [holder]),
    safeCall(rpc, addr, ERC4626, "maxWithdraw", [holder]),
    safeCall(rpc, addr, ERC4626, "previewDeposit", [oneAsset]),
    safeCall(rpc, addr, ERC4626, "previewRedeem", [oneShare]),
  ]);
  return {
    isErc4626Like: Boolean(asset),
    asset: asset ? normalizeAddress(asset[0]) : null,
    totalAssetsRaw: totalAssets ? totalAssets[0].toString() : null,
    totalAssets: totalAssets ? decimalsToNumber(totalAssets[0], assetDecimals) : null,
    oneShareToAssetsRaw: oneShareToAssets ? oneShareToAssets[0].toString() : null,
    oneShareToAssets: oneShareToAssets ? decimalsToNumber(oneShareToAssets[0], assetDecimals) : null,
    oneAssetToSharesRaw: oneAssetToShares ? oneAssetToShares[0].toString() : null,
    oneAssetToShares: oneAssetToShares ? decimalsToNumber(oneAssetToShares[0], shareDecimals) : null,
    maxDepositRaw: maxDeposit ? maxDeposit[0].toString() : null,
    maxDeposit: maxDeposit ? decimalsToNumber(maxDeposit[0], assetDecimals) : null,
    maxWithdrawRaw: maxWithdraw ? maxWithdraw[0].toString() : null,
    maxWithdraw: maxWithdraw ? decimalsToNumber(maxWithdraw[0], assetDecimals) : null,
    previewDepositRaw: previewDeposit ? previewDeposit[0].toString() : null,
    previewRedeemRaw: previewRedeem ? previewRedeem[0].toString() : null,
  };
}

async function tokenBalance(rpc, token, owner, decimals) {
  const bal = await safeCall(rpc, token, ERC20, "balanceOf", [owner]);
  return {
    raw: bal ? bal[0].toString() : null,
    amount: bal ? decimalsToNumber(bal[0], decimals) : null,
  };
}

async function loadCoinPrices(addresses) {
  const keys = unique(addresses.map((addr) => normalizeAddress(addr)).filter(Boolean).map((addr) => `ethereum:${addr.toLowerCase()}`));
  const out = {};
  for (let i = 0; i < keys.length; i += 80) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.slice(i, i + 80).join(",")}?searchWidth=6h`, 30_000);
    for (const [key, value] of Object.entries(json?.coins || {})) out[key.split(":")[1].toLowerCase()] = asNumber(value?.price);
  }
  return out;
}

async function loadDexRows(addresses) {
  const rows = [];
  for (const addr of unique(addresses.map(normalizeAddress))) {
    const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, 30_000);
    const pairs = (json?.pairs || [])
      .filter((p) => String(p.chainId || "").toLowerCase() === "ethereum")
      .map((p) => ({
        token: addr,
        pairAddress: normalizeAddress(p.pairAddress) || p.pairAddress || null,
        dexId: p.dexId || null,
        baseSymbol: p.baseToken?.symbol || null,
        quoteSymbol: p.quoteToken?.symbol || null,
        priceUsd: round(p.priceUsd, 10),
        liquidityUsd: round(p.liquidity?.usd, 2),
        fdv: round(p.fdv, 2),
        volume24hUsd: round(p.volume?.h24, 2),
        routePositive: false,
      }))
      .filter((p) => (asNumber(p.liquidityUsd) || 0) > 0)
      .sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0));
    rows.push(...pairs.slice(0, 6));
  }
  return rows;
}

function latestProtocolTvl(protocol) {
  const chain = protocol?.chainTvls?.Ethereum?.tvl;
  if (Array.isArray(chain) && chain.length) return asNumber(chain[chain.length - 1]?.totalLiquidityUSD);
  const tvl = protocol?.tvl;
  if (Array.isArray(tvl) && tvl.length) return asNumber(tvl[tvl.length - 1]?.totalLiquidityUSD);
  return asNumber(protocol?.currentChainTvls?.Ethereum);
}

function latestProtocolToken(protocol, key) {
  const rows = protocol?.chainTvls?.Ethereum?.tokens;
  if (!Array.isArray(rows) || !rows.length) return null;
  return asNumber(rows[rows.length - 1]?.tokens?.[key]);
}

function latestProtocolTokenUsd(protocol, key) {
  const rows = protocol?.chainTvls?.Ethereum?.tokensInUsd;
  if (!Array.isArray(rows) || !rows.length) return null;
  return asNumber(rows[rows.length - 1]?.tokens?.[key]);
}

function latestYield(chart) {
  const rows = Array.isArray(chart?.data) ? chart.data : [];
  const latest = rows[rows.length - 1] || null;
  const prior = rows.length > 1 ? rows[rows.length - 2] : null;
  const maxApy = rows.reduce((acc, row) => Math.max(acc, asNumber(row.apy) || 0), 0);
  const minPps = rows.reduce((acc, row) => Math.min(acc, asNumber(row.pricePerShare) ?? Infinity), Infinity);
  const maxPps = rows.reduce((acc, row) => Math.max(acc, asNumber(row.pricePerShare) || 0), 0);
  return {
    points: rows.length,
    latestTimestamp: latest?.timestamp || null,
    latestTvlUsd: round(latest?.tvlUsd, 2),
    latestApyPct: round(latest?.apy, 6),
    latestApyBasePct: round(latest?.apyBase, 6),
    latestPricePerShare: round(latest?.pricePerShare, 10),
    priorPricePerShare: round(prior?.pricePerShare, 10),
    pricePerShareChangeBps: latest && prior && asNumber(prior.pricePerShare) ? round(((asNumber(latest.pricePerShare) - asNumber(prior.pricePerShare)) / asNumber(prior.pricePerShare)) * 10_000, 4) : null,
    maxApyPct: round(maxApy, 6),
    minPricePerShare: Number.isFinite(minPps) ? round(minPps, 10) : null,
    maxPricePerShare: maxPps ? round(maxPps, 10) : null,
  };
}

function discoveryRow() {
  const d = readJson(PUBLIC_TARGETS, {});
  const rows = [...(d.phase0Queue || []), ...(d.yieldCandidates || []), ...(d.consumerJoinFirst || []), ...(d.targetedRefreshQueue || [])];
  return rows.find((row) => String(row?.project || row?.name || "").toLowerCase() === "saturn" && String(row?.symbol || "").toUpperCase().includes("SUSDAT")) || null;
}

function containsAnyAddress(row, addresses) {
  const text = JSON.stringify(row || {}).toLowerCase();
  return addresses.some((addr) => text.includes(addr));
}

function rowLike(obj) {
  return obj && typeof obj === "object" && !Array.isArray(obj) && (
    obj.address || obj.token || obj.underlyingAsset || obj.market || obj.pool || obj.poolAddress || obj.lead || obj.protocol || obj.project || obj.symbol || obj.typeAndVersion || obj.category || obj.source
  );
}

function sanitizeMatch(row, hitLabels) {
  const lead = row?.lead || {};
  const market = row?.market || {};
  const economics = row?.morphoOracleEconomics || row?.economics || market?.morphoOracleEconomics || {};
  return {
    hits: hitLabels,
    protocol: safeText(row?.protocol || lead?.project || row?.project || row?.name || row?.category, 80),
    chain: safeText(row?.chain || lead?.chain || row?.chainName, 40),
    chainId: asNumber(row?.chainId || lead?.chainId),
    symbol: safeText(row?.symbol || lead?.symbol || row?.tokenSymbol || row?.sySymbol || row?.marketName, 80),
    marketName: safeText(row?.marketName || market?.name, 80),
    role: safeText(row?.role || row?.typeCategory || row?.candidateRoute || lead?.candidateRoute, 80),
    liquidityUsd: round(row?.liquidityUsdHint || row?.liquidityUsd || row?.topDexLiquidityUsd || row?.poolBalanceUsd || market?.liquidityAssetsUsd, 2),
    tvlUsd: round(row?.tvlUsd || lead?.tvlUsd, 2),
    apyPct: round(row?.apyPct || lead?.apyPct || row?.impliedApy, 6),
    priceUsd: round(row?.priceUsd || row?.underlyingPriceUsd || row?.syPriceUsd || row?.ptPriceUsd, 10),
    acceptedVsAcquisitionBps: round(economics?.acceptedVsAcquisitionBps, 6),
    netEdgeUsd: round(economics?.netEdgeUsd, 6),
    routePositive: Boolean(row?.routePositive || economics?.routePositive),
  };
}

function collectConsumerJoins(targets) {
  const targetAddresses = targets.map((t) => ({ ...t, lower: lowerAddress(t.address) })).filter((t) => t.lower);
  const joins = [];
  const inputsLoaded = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) {
    const file = path.join(WORKSPACE, rel);
    const text = readText(file);
    if (!text) continue;
    const sourceHits = targetAddresses.filter((target) => text.toLowerCase().includes(target.lower));
    if (!sourceHits.length) continue;
    inputsLoaded.push(rel);
    const data = readJson(file, null);
    const maxRows = 60;
    const visit = (node, pathParts = [], depth = 0) => {
      if (!node || joins.filter((j) => j.source === source).length >= maxRows || depth > 7) return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) visit(node[i], pathParts.concat(String(i)), depth + 1);
        return;
      }
      if (typeof node !== "object") return;
      if (rowLike(node)) {
        const hits = sourceHits.filter((target) => containsAnyAddress(node, [target.lower]));
        if (hits.length) {
          joins.push({
            source,
            path: pathParts.join(".") || "$",
            ...sanitizeMatch(node, hits.map((h) => h.label)),
          });
          return;
        }
      }
      for (const [key, value] of Object.entries(node)) {
        if (["sourceArtifacts", "files", "abis", "errors"].includes(key)) continue;
        visit(value, pathParts.concat(key), depth + 1);
      }
    };
    visit(data, []);
  }
  const deduped = [];
  const seen = new Set();
  for (const row of joins) {
    const key = `${row.source}|${row.path}|${row.symbol}|${row.marketName}|${row.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return { joins: deduped, inputsLoaded };
}

function classifyJoins(joins) {
  const pendleRows = joins.filter((row) => /^pendle/.test(row.source));
  const ccipRows = joins.filter((row) => row.source === "ccip");
  const routePositiveRows = joins.filter((row) => row.routePositive);
  const materialLiquidityRows = joins.filter((row) => (asNumber(row.liquidityUsd) || 0) >= 10_000);
  const saturnSpecificRows = joins.filter((row) => /USDat|sUSDat|SUSDAT/i.test(`${row.symbol || ""} ${row.marketName || ""} ${row.protocol || ""}`));
  return {
    rows: joins.length,
    pendleRows: pendleRows.length,
    ccipRows: ccipRows.length,
    saturnSpecificRows: saturnSpecificRows.length,
    materialLiquidityRows: materialLiquidityRows.length,
    routePositiveRows: routePositiveRows.length,
    topRows: joins
      .slice()
      .sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0))
      .slice(0, 12),
  };
}

function renderReport(artifact) {
  const s = artifact.summary;
  const y = artifact.yieldPool;
  const row = (cells) => `| ${cells.join(" | ")} |`;
  const tokenRows = artifact.tokenRows.map((t) => row([
    t.label,
    t.meta.symbol || "?",
    t.meta.codePresent ? "true" : "false",
    formatNumber(t.meta.totalSupply, 4),
    formatUsd(t.priceUsd ? t.meta.totalSupply * t.priceUsd : null),
    t.meta.implementation ? compactAddress(t.meta.implementation) : "n/a",
  ]));
  const backingRows = artifact.backingRows.map((b) => row([
    b.tokenLabel,
    b.symbol || "?",
    formatNumber(b.amount, 4),
    formatUsd(b.usd),
    b.context,
  ]));
  const dexRows = artifact.dexRows.slice(0, 8).map((d) => row([
    d.baseSymbol && d.quoteSymbol ? `${d.baseSymbol}/${d.quoteSymbol}` : "?",
    d.dexId || "?",
    formatUsd(d.liquidityUsd),
    formatNumber(d.priceUsd, 8),
  ]));
  const joinRows = artifact.consumerJoinSummary.topRows.slice(0, 8).map((j) => row([
    j.source,
    j.symbol || j.marketName || "?",
    j.role || "context",
    formatUsd(j.liquidityUsd),
    j.routePositive ? "true" : "false",
  ]));

  const lines = [];
  lines.push(`# ${SIGNAL_DORMANT} - saturn SUSDAT Phase 0`);
  lines.push("");
  lines.push(`Generated: ${artifact.generatedAt}`);
  lines.push("");
  lines.push("Scanner: `tools/scan-saturn-susdat-phase0.js`");
  lines.push("");
  lines.push("Artifact: `reports/raw/fast/saturn-susdat-phase0.json`");
  lines.push("");
  lines.push("## Result");
  lines.push("");
  lines.push("No permissionless route-positive exploit is claimed. The pass mapped USDat/sUSDat token state, public backing methodology, sUSDat ERC4626/STRC accounting, DEX liquidity, and local Pendle/CCIP/consumer joins. The APY spike and share-price movement remain leads only because no exact positive borrow, redemption, bridge, liquidation, or DEX unwind route is proven.");
  lines.push("");
  lines.push("## Target");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---:|");
  lines.push(row(["Protocol", "`saturn` / Saturn"]));
  lines.push(row(["Chain", "`Ethereum (1)`"]));
  lines.push(row(["Yield pool", `\`${YIELD_POOL}\``]));
  lines.push(row(["Pool TVL", formatUsd(y.latestTvlUsd)]));
  lines.push(row(["Latest APY", `\`${formatNumber(y.latestApyPct, 4)}%\``]));
  lines.push(row(["Latest price/share", `\`${formatNumber(y.latestPricePerShare, 8)}\``]));
  lines.push(row(["Protocol TVL", formatUsd(s.defillamaProtocolTvlUsd)]));
  lines.push(row(["Ethereum RPC resolved", `\`${s.ethereumRpcResolved}\``]));
  lines.push(row(["Coverage", `\`${s.coverageClassification}\``]));
  lines.push("");
  lines.push("## Tokens");
  lines.push("");
  lines.push("| Label | Symbol | Code | Supply | Implied supply USD | Proxy impl |");
  lines.push("|---|---|---:|---:|---:|---|");
  lines.push(...(tokenRows.length ? tokenRows : [row(["none", "none", "false", "n/a", "n/a", "n/a"])]));
  lines.push("");
  lines.push("## Backing / Accounting Context");
  lines.push("");
  lines.push("| Component | Symbol | Amount | USD | Context |");
  lines.push("|---|---|---:|---:|---|");
  lines.push(...(backingRows.length ? backingRows : [row(["none", "none", "n/a", "n/a", "n/a"])]));
  lines.push("");
  lines.push("## DEX / Consumer Joins");
  lines.push("");
  lines.push("| Pair | DEX | Liquidity | Price |");
  lines.push("|---|---|---:|---:|");
  lines.push(...(dexRows.length ? dexRows : [row(["none", "none", "n/a", "n/a"])]));
  lines.push("");
  lines.push("| Source | Symbol/Market | Role | Liquidity | Route-positive |");
  lines.push("|---|---|---|---:|---:|");
  lines.push(...(joinRows.length ? joinRows : [row(["none", "none", "none", "n/a", "false"])]));
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---:|");
  lines.push(row(["DEX rows", `\`${s.dexRows}\``]));
  lines.push(row(["Consumer joins", `\`${s.artifactJoinRows}\``]));
  lines.push(row(["Saturn-specific joins", `\`${s.saturnSpecificJoinRows}\``]));
  lines.push(row(["Pendle joins", `\`${s.pendleJoinRows}\``]));
  lines.push(row(["CCIP joins", `\`${s.ccipJoinRows}\``]));
  lines.push(row(["Watch candidates", `\`${s.watchCandidates}\``]));
  lines.push(row(["Route-positive rows", `\`${s.routePositive}\``]));
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  for (const blocker of artifact.blockers) lines.push(`- ${blocker}`);
  lines.push("");
  lines.push("## Next Gate");
  lines.push("");
  lines.push(artifact.nextReadOnlyStep);
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const generatedAt = new Date().toISOString();
  const rpc = await resolveRpc(ETHEREUM_CHAIN_ID);
  const [protocol, chart] = await Promise.all([
    fetchJson("https://api.llama.fi/protocol/saturn", 45_000),
    fetchJson(`https://yields.llama.fi/chart/${YIELD_POOL}`, 45_000),
  ]);
  const blockNumber = rpc ? await latestBlock(rpc) : null;
  const blockTimestamp = rpc && blockNumber ? await latestBlockTimestamp(rpc, blockNumber) : null;

  const [usdatMeta, susdatMeta, mMeta, usdcMeta] = rpc
    ? await Promise.all([tokenMeta(rpc, US_DAT), tokenMeta(rpc, S_US_DAT), tokenMeta(rpc, M_TOKEN), tokenMeta(rpc, USDC)])
    : [null, null, null, null];
  const prices = await loadCoinPrices([US_DAT, S_US_DAT, M_TOKEN, USDC]);
  const priceOf = (addr) => prices[lowerAddress(addr)] ?? null;
  const dexRows = await loadDexRows([US_DAT, S_US_DAT]);

  const [mBacking, usdcBacking, susdatErc4626, strcRaw] = rpc
    ? await Promise.all([
      tokenBalance(rpc, M_TOKEN, US_DAT, mMeta?.decimals ?? 6),
      tokenBalance(rpc, USDC, US_DAT, usdcMeta?.decimals ?? 6),
      erc4626State(rpc, susdatMeta || { address: S_US_DAT, decimals: 18 }, ZERO, usdatMeta?.decimals ?? 6),
      safeCall(rpc, S_US_DAT, COMMON, "strcBalance"),
    ])
    : [null, null, null, null];

  const strcBalance = strcRaw ? decimalsToNumber(strcRaw[0], STRC_DECIMALS) : latestProtocolToken(protocol, "STRC");
  const strcUsd = latestProtocolTokenUsd(protocol, "STRC");
  const strcPriceUsd = strcBalance && strcUsd ? strcUsd / strcBalance : null;
  const mUsd = (mBacking?.amount || 0) * (priceOf(M_TOKEN) || (latestProtocolTokenUsd(protocol, "M") && latestProtocolToken(protocol, "M") ? latestProtocolTokenUsd(protocol, "M") / latestProtocolToken(protocol, "M") : 0));
  const usdcUsd = (usdcBacking?.amount || 0) * (priceOf(USDC) || 1);
  const strcBackingUsd = (strcBalance || 0) * (strcPriceUsd || 0);
  const usdatBackingUsd = mUsd + usdcUsd;
  const usdatBackingPerToken = usdatMeta?.totalSupply ? usdatBackingUsd / usdatMeta.totalSupply : null;
  const susdatBackingPerShare = susdatMeta?.totalSupply ? strcBackingUsd / susdatMeta.totalSupply : null;
  const susdatAssetPrice = susdatErc4626?.asset ? priceOf(susdatErc4626.asset) || (lowerAddress(susdatErc4626.asset) === lowerAddress(US_DAT) ? priceOf(US_DAT) : null) : null;
  const susdatConvertShareUsd = susdatErc4626?.oneShareToAssets && susdatAssetPrice ? susdatErc4626.oneShareToAssets * susdatAssetPrice : null;
  const yieldPool = latestYield(chart || {});
  const publicRow = discoveryRow();
  const { joins, inputsLoaded } = collectConsumerJoins([
    { label: "USDat", address: US_DAT },
    { label: "sUSDat", address: S_US_DAT },
  ]);
  const consumerJoinSummary = classifyJoins(joins);

  const backingRows = [
    { tokenLabel: "USDat backing", token: normalizeAddress(M_TOKEN), symbol: mMeta?.symbol || "M", amount: round(mBacking?.amount, 6), usd: round(mUsd, 2), context: "$M balance held by USDat contract" },
    { tokenLabel: "USDat backing", token: normalizeAddress(USDC), symbol: usdcMeta?.symbol || "USDC", amount: round(usdcBacking?.amount, 6), usd: round(usdcUsd, 2), context: "USDC balance held by USDat contract" },
    { tokenLabel: "sUSDat backing", token: "offchain-tradfi-strc", symbol: "STRC", amount: round(strcBalance, 6), usd: round(strcBackingUsd, 2), context: "sUSDat strcBalance valued from public DefiLlama tradfi feed" },
  ];
  const tokenRows = [
    { label: "USDat", meta: usdatMeta || { address: normalizeAddress(US_DAT), codePresent: false }, priceUsd: priceOf(US_DAT) },
    { label: "sUSDat", meta: susdatMeta || { address: normalizeAddress(S_US_DAT), codePresent: false }, priceUsd: priceOf(S_US_DAT) || yieldPool.latestPricePerShare },
  ];

  const directBackingVsMarketBps = usdatBackingPerToken && priceOf(US_DAT) ? ((usdatBackingPerToken - priceOf(US_DAT)) / priceOf(US_DAT)) * 10_000 : null;
  const susdatBackingVsYieldPpsBps = susdatBackingPerShare && yieldPool.latestPricePerShare ? ((susdatBackingPerShare - yieldPool.latestPricePerShare) / yieldPool.latestPricePerShare) * 10_000 : null;
  const topDexLiquidityUsd = Math.max(0, ...dexRows.map((row) => asNumber(row.liquidityUsd) || 0));
  const pendleWatch = consumerJoinSummary.pendleRows > 0 ? 1 : 0;
  const ccipWatch = consumerJoinSummary.ccipRows > 0 ? 1 : 0;
  const backingWatch = Math.max(Math.abs(asNumber(directBackingVsMarketBps) || 0), Math.abs(asNumber(susdatBackingVsYieldPpsBps) || 0)) >= 100 ? 1 : 0;
  const watchCandidates = pendleWatch + ccipWatch + backingWatch;

  const summary = {
    ethereumRpcResolved: Boolean(rpc),
    defillamaProtocolTvlUsd: round(latestProtocolTvl(protocol), 2),
    yieldPoolTvlUsd: yieldPool.latestTvlUsd,
    yieldPoolApyPct: yieldPool.latestApyPct,
    yieldPoolPricePerShare: yieldPool.latestPricePerShare,
    blockNumber,
    usdatCodePresent: Boolean(usdatMeta?.codePresent),
    susdatCodePresent: Boolean(susdatMeta?.codePresent),
    usdatSupply: round(usdatMeta?.totalSupply, 6),
    susdatSupply: round(susdatMeta?.totalSupply, 6),
    usdatMarketPriceUsd: round(priceOf(US_DAT), 10),
    susdatMarketPriceUsd: round(priceOf(S_US_DAT), 10),
    usdatBackingUsd: round(usdatBackingUsd, 2),
    usdatBackingPerToken: round(usdatBackingPerToken, 10),
    usdatBackingVsMarketBps: round(directBackingVsMarketBps, 4),
    susdatErc4626Like: Boolean(susdatErc4626?.isErc4626Like),
    susdatAsset: susdatErc4626?.asset || null,
    susdatOneShareToAssets: round(susdatErc4626?.oneShareToAssets, 10),
    susdatConvertShareUsd: round(susdatConvertShareUsd, 10),
    strcBalance: round(strcBalance, 6),
    strcPriceUsd: round(strcPriceUsd, 10),
    strcBackingUsd: round(strcBackingUsd, 2),
    susdatBackingPerShare: round(susdatBackingPerShare, 10),
    susdatBackingVsYieldPpsBps: round(susdatBackingVsYieldPpsBps, 4),
    dexRows: dexRows.length,
    topDexLiquidityUsd: round(topDexLiquidityUsd, 2),
    artifactInputsLoaded: inputsLoaded.length,
    artifactJoinRows: consumerJoinSummary.rows,
    saturnSpecificJoinRows: consumerJoinSummary.saturnSpecificRows,
    pendleJoinRows: consumerJoinSummary.pendleRows,
    ccipJoinRows: consumerJoinSummary.ccipRows,
    materialJoinRows: consumerJoinSummary.materialLiquidityRows,
    proofWeaknessRows: 0,
    exactEconomicsRows: 0,
    watchCandidates,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    coverageClassification: "bounded-with-caveats",
    status: "phase0-no-route-positive",
  };

  const artifact = {
    generatedAt,
    scanner: "tools/scan-saturn-susdat-phase0.js",
    scope: "Saturn USDat/sUSDat Ethereum read-only backing, ERC4626/accounting, DEX, Pendle/CCIP, and consumer-join Phase 0",
    safety: {
      rpcInventoryRead: true,
      rpcInventoryOnly: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    target: {
      name: "Saturn",
      slug: "saturn",
      project: "saturn",
      yieldSymbol: "SUSDAT",
      pool: YIELD_POOL,
      category: protocol?.category || "Stablecoin Wrapper",
      chain: CHAIN,
      tvlCodePath: protocol?.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/saturn-protocol/index.js",
      audits: protocol?.audits || "0",
      methodology: protocol?.methodology || "USDat backing plus sUSDat STRC exposure per public adapter",
      url: protocol?.url || "https://app.saturn.credit/",
    },
    publicDiscovery: publicRow ? {
      score: publicRow.score ?? null,
      tvlUsd: round(publicRow.tvlUsd, 2),
      apyPct: round(publicRow.apyPct, 6),
      routePriority: publicRow.routePriority || null,
      coverageState: publicRow.coverage?.state || null,
    } : null,
    chain: { chain: CHAIN, chainId: ETHEREUM_CHAIN_ID, blockNumber, blockTimestamp },
    yieldPool,
    tokenRows,
    erc4626Rows: [{ label: "sUSDat", ...susdatErc4626, routePositive: false }],
    backingRows,
    dexRows,
    consumerJoins: joins,
    consumerJoinInputsLoaded: inputsLoaded,
    consumerJoinSummary,
    summary,
    blockers: [
      "Public APY and share-price movement are not impact without a trusted consumer route or permissionless redemption edge",
      "USDat backing and sUSDat STRC accounting are context only until mint/redeem/liquidation/borrow economics are exact and permissionless",
      "Pendle, CCIP, DEX, and local artifact joins are consumer leads, not proof of a proof-binding, accounting, or accepted-value exploit",
      "No material current liquidatable borrower or exact positive borrow/redeem/liquidation/unwind route was proven",
      "No fork extraction proof and no signed-action justification",
    ],
    requiredForRoutePositive: [
      "specific USDat/sUSDat accepted-value, backing, oracle, bridge, or ERC4626 accounting divergence with permissionless impact",
      "trusted consumer with material borrow, redemption, liquidation, bridge, or DEX unwind liquidity",
      "exact acquisition, borrow/repay, redeem/liquidate, and exit economics positive after gas/slippage/fees",
      "fork extraction proof",
    ],
    nextReadOnlyStep: "Reopen saturn only if USDat/sUSDat backing, STRC accounting, Pendle maturity state, bridge proof state, or a trusted consumer listing creates exact positive borrow, redemption, liquidation, or unwind economics.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, renderReport(artifact));
  if (!QUIET) {
    console.log(`saturn SUSDAT Phase0: tokenRows=${tokenRows.length} joins=${summary.artifactJoinRows} pendle=${summary.pendleJoinRows} ccip=${summary.ccipJoinRows} dex=${summary.dexRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT)}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(`saturn SUSDAT Phase0 failed: ${err?.message || err}`);
  process.exitCode = 1;
});
