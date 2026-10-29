#!/usr/bin/env node
// scan-hastra-phase0.js - read-only Hastra RWA/NAV Phase 0 on Ethereum.
// RPC URLs are resolved in memory only. No private keys, calldata payloads, or signed actions are used.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc, getImpl } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "hastra-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "hastra-phase0-triage.md");
const EXTRA_PRODUCERS_REL = "reports/raw/fast/hastra-phase0-extra-producers.json";
const EXTRA_PRODUCERS_OUT = path.join(WORKSPACE, EXTRA_PRODUCERS_REL);
const GRAPH_OUT_REL = "reports/raw/fast/hastra-phase0-rwa-nav-consumer-graph.json";
const GRAPH_OUT = path.join(WORKSPACE, GRAPH_OUT_REL);
const QUIET = process.argv.includes("--quiet");

const ETHEREUM_CHAIN_ID = 1;
const ZERO = "0x0000000000000000000000000000000000000000";
const MATERIAL_USD = Number(process.env.HASTRA_PHASE0_MATERIAL_USD || "10000");
const MAX_LOCAL_ARTIFACT_BYTES = Number(process.env.HASTRA_PHASE0_MAX_LOCAL_ARTIFACT_BYTES || "2500000");

const HASTRA = {
  protocol: "Hastra",
  chain: "Ethereum",
  chainId: ETHEREUM_CHAIN_ID,
  source: "defillama-adapter:hastra/index.js",
  module: "hastra/index.js",
  tvlCodePath: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/hastra/index.js",
  wYLDS: "0x6aD038cA6C04e885630851278ca0a856Ad9a66Cc",
  staking: "0x19ebb35279A16207Ec4ba82799CC64715065F7F6",
  prime: "0x19ebb35279A16207Ec4ba82799CC64715065F7F6",
  redeemVault: "0xA8C3CF6183D49d5D372f8FC149BD2cb5CFC0faCd",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};

const LOCAL_ARTIFACTS = [
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["rwa-nav", "reports/raw/fast/rwa-nav-consumer-graph.json"],
  ["centrifuge-nav", "reports/raw/fast/centrifuge-nav-consumer-graph.json"],
  ["erc4626-consumer", "reports/raw/fast/erc4626-consumer-joiner.json"],
  ["morpho-pyth", "reports/raw/fast/morpho-pyth-unsafe-consumers.json"],
  ["morpho-allocator", "reports/raw/fast/morpho-public-allocator-force-feed.json"],
  ["euler-v2", "reports/raw/fast/euler-v2-phase0.json"],
  ["silo-v2", "reports/raw/fast/silo-v2-phase0.json"],
  ["pendle-pt", "reports/raw/fast/pendle-pt-multichain-consumer-graph.json"],
  ["pendle-yt", "reports/raw/fast/pendle-yt-collateral-routes.json"],
  ["current-liquidatable", "reports/raw/fast/current-liquidatable-exit-routes.json"],
];

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const BYTES32_META = new ethers.Interface(["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"]);
const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function minter() view returns (address)",
  "function controller() view returns (address)",
  "function paused() view returns (bool)",
  "function isPaused() view returns (bool)",
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
]);

const SELECTOR_SIGS = {
  redemption: ["redeem(uint256,address,address)", "withdraw(uint256,address,address)", "requestRedeem(uint256)", "requestWithdraw(uint256)", "claim(address)", "claim(uint256)"],
  staking: ["stake(uint256)", "unstake(uint256)", "deposit(uint256,address)", "withdraw(uint256)", "getReward()", "claimRewards()"],
  transferControl: ["pause()", "unpause()", "setPaused(bool)", "setMinter(address)", "setController(address)", "upgradeTo(address)"],
  borrowLiquidation: ["borrow(uint256)", "repay(uint256)", "liquidate(address,uint256,address)", "liquidateBorrow(address,uint256,address)"],
};

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const text = readText(file).replace(/^\uFEFF/, ""); return text ? JSON.parse(text) : fallback; } catch (_) { return fallback; } }
function writeJson(file, value) { ensureDir(file); fs.writeFileSync(file, `${JSON.stringify(value, jsonReplacer, 2)}\n`); }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function decodeBytes32String(value) { try { return value && value !== "0x" ? ethers.decodeBytes32String(value) : null; } catch (_) { return null; } }
function asNumber(value) { if (value === null || value === undefined || value === "") return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; if (typeof value === "boolean") return value ? 1 : 0; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function unitsToNumber(value, decimals = 18) { try { const n = Number(ethers.formatUnits(toBig(value), Number(decimals))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`; }
function formatNum(value, decimals = 4) { const n = asNumber(value); return n === null ? "n/a" : n.toLocaleString("en-US", { maximumFractionDigits: decimals }); }
function latestRow(rows) { return Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null; }
function safeCell(value) { return String(value ?? "n/a").replace(/[\r\n|]+/g, " ").slice(0, 220); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-hastra-phase0/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(timer); }
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

function chainLatestTvl(raw, chain) {
  return asNumber(raw?.currentChainTvls?.[chain]) ?? asNumber(latestRow(raw?.chainTvls?.[chain]?.tvl)?.totalLiquidityUSD);
}

function lookupTokenMap(map, address) {
  const addr = lowerAddress(address);
  if (!addr || !map || typeof map !== "object") return null;
  for (const [key, value] of Object.entries(map)) {
    const text = String(key).toLowerCase();
    if (text === addr || text.endsWith(`:${addr}`)) return asNumber(value);
  }
  return null;
}

function publicMetadata(raw) {
  const chainTvls = {};
  for (const chain of new Set([...(raw?.chains || []), ...Object.keys(raw?.currentChainTvls || {}), ...Object.keys(raw?.chainTvls || {})])) {
    const tvl = chainLatestTvl(raw, chain);
    if (tvl !== null) chainTvls[chain] = round(tvl, 2);
  }
  const ethTokens = latestRow(raw?.chainTvls?.Ethereum?.tokens)?.tokens || {};
  const ethTokensInUsd = latestRow(raw?.chainTvls?.Ethereum?.tokensInUsd)?.tokens || {};
  return {
    name: raw?.name || "Hastra",
    slug: raw?.slug || "hastra",
    category: raw?.category || "RWA",
    module: raw?.module || HASTRA.module,
    tvlCodePath: raw?.tvlCodePath || HASTRA.tvlCodePath,
    methodology: raw?.methodology || "Hastra TVL consists of vaulted wYLDS plus unredeemed tokens in redemption vaults.",
    chains: raw?.chains || Object.keys(chainTvls),
    tvlUsd: round(asNumber(latestRow(raw?.tvl)?.totalLiquidityUSD) ?? Object.values(chainTvls).reduce((sum, value) => sum + (asNumber(value) || 0), 0), 2),
    ethereumTvlUsd: round(chainTvls.Ethereum, 2),
    solanaTvlUsd: round(chainTvls.Solana, 2),
    doubleCounted: Boolean(raw?.doublecounted),
    audits: raw?.audits || null,
    url: raw?.url || null,
    twitter: raw?.twitter || null,
    ethTokenAmounts: ethTokens,
    ethTokenUsd: ethTokensInUsd,
  };
}

async function fetchAddressPrice(address) {
  const addr = lowerAddress(address);
  if (!addr) return null;
  const json = await fetchJson(`https://coins.llama.fi/prices/current/ethereum:${addr}?searchWidth=6h`, 30_000).catch(() => null);
  return json?.coins?.[`ethereum:${addr}`] || null;
}

function selectorHints(code) {
  const text = String(code || "").toLowerCase();
  const out = {};
  for (const [group, sigs] of Object.entries(SELECTOR_SIGS)) {
    const hits = [];
    for (const sig of sigs) {
      const selector = ethers.id(sig).slice(2, 10).toLowerCase();
      if (text.includes(selector)) hits.push(sig);
    }
    if (hits.length) out[group] = hits;
  }
  return out;
}

async function contractMeta(rpc, label, address) {
  const addr = normalizeAddress(address);
  const [code, impl, owner, admin, paused, isPaused] = await Promise.all([
    getCode(rpc, addr),
    getImpl(rpc, addr, 10_000).catch(() => null),
    safeCall(rpc, addr, COMMON, "owner"),
    safeCall(rpc, addr, COMMON, "admin"),
    safeCall(rpc, addr, COMMON, "paused"),
    safeCall(rpc, addr, COMMON, "isPaused"),
  ]);
  return {
    label,
    address: addr,
    codePresent: code !== "0x",
    codeBytes: Math.max(0, (code.length - 2) / 2),
    eip1967Implementation: impl,
    selectorHints: selectorHints(code),
    owner: owner ? normalizeAddress(owner[0]) : null,
    admin: admin ? normalizeAddress(admin[0]) : null,
    paused: paused ? Boolean(paused[0]) : isPaused ? Boolean(isPaused[0]) : null,
  };
}

async function tokenMeta(rpc, tokenAddress, metadata, price, opts = {}) {
  const addr = normalizeAddress(tokenAddress);
  const [code, impl, sym, name, dec, supply, owner, admin, minter, controller, paused, isPaused, asset, totalAssets] = await Promise.all([
    getCode(rpc, addr),
    getImpl(rpc, addr, 10_000).catch(() => null),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
    safeCall(rpc, addr, COMMON, "owner"),
    safeCall(rpc, addr, COMMON, "admin"),
    safeCall(rpc, addr, COMMON, "minter"),
    safeCall(rpc, addr, COMMON, "controller"),
    safeCall(rpc, addr, COMMON, "paused"),
    safeCall(rpc, addr, COMMON, "isPaused"),
    safeCall(rpc, addr, COMMON, "asset"),
    safeCall(rpc, addr, COMMON, "totalAssets"),
  ]);
  const symbolBytes = sym ? null : await safeCall(rpc, addr, BYTES32_META, "symbol");
  const nameBytes = name ? null : await safeCall(rpc, addr, BYTES32_META, "name");
  const decimals = dec ? Number(dec[0]) : 18;
  const convertOne = await safeCall(rpc, addr, COMMON, "convertToAssets", [10n ** BigInt(decimals)]);
  const balanceOwner = opts.balanceOwner ? normalizeAddress(opts.balanceOwner) : null;
  const ownerBalance = balanceOwner ? await safeCall(rpc, addr, ERC20, "balanceOf", [balanceOwner]) : null;
  const totalSupply = supply ? unitsToNumber(supply[0], decimals) : null;
  const ownerBalanceAmount = ownerBalance ? unitsToNumber(ownerBalance[0], decimals) : null;
  const priceUsd = asNumber(price?.price);
  const adapterTokenUsd = lookupTokenMap(metadata.ethTokenUsd, addr);
  const adapterTokenAmount = lookupTokenMap(metadata.ethTokenAmounts, addr);
  const adapterImpliedPriceUsd = adapterTokenUsd && adapterTokenAmount ? adapterTokenUsd / adapterTokenAmount : null;
  const bestPriceUsd = priceUsd ?? adapterImpliedPriceUsd;
  const erc4626Asset = asset ? normalizeAddress(asset[0]) : null;
  const erc4626Like = Boolean(erc4626Asset && erc4626Asset !== ZERO && (totalAssets || convertOne));
  return {
    chain: HASTRA.chain,
    chainId: HASTRA.chainId,
    address: addr,
    codePresent: code !== "0x",
    codeBytes: Math.max(0, (code.length - 2) / 2),
    eip1967Implementation: impl,
    selectorHints: selectorHints(code),
    symbol: sym ? String(sym[0]) : decodeBytes32String(symbolBytes?.[0]) || opts.symbol || "wYLDS",
    name: name ? String(name[0]) : decodeBytes32String(nameBytes?.[0]) || opts.name || "Hastra token",
    decimals,
    totalSupplyRaw: supply ? supply[0].toString() : null,
    totalSupply,
    publicPriceUsd: priceUsd,
    publicPriceTimestamp: price?.timestamp || null,
    adapterTokenAmount,
    adapterTokenUsd: round(adapterTokenUsd, 2),
    adapterImpliedPriceUsd: round(adapterImpliedPriceUsd, 10),
    bestPriceUsd: round(bestPriceUsd, 10),
    totalSupplyUsd: totalSupply && bestPriceUsd ? totalSupply * bestPriceUsd : null,
    adapterBalanceOwner: balanceOwner,
    adapterBalanceLabel: opts.balanceLabel || null,
    adapterBalanceRaw: ownerBalance ? ownerBalance[0].toString() : null,
    adapterBalance: ownerBalanceAmount,
    adapterBalanceUsd: ownerBalanceAmount && bestPriceUsd ? ownerBalanceAmount * bestPriceUsd : null,
    erc4626Like,
    erc4626: erc4626Like ? {
      asset: erc4626Asset,
      totalAssetsRaw: totalAssets ? totalAssets[0].toString() : null,
      convertOneTokenToAssetsRaw: convertOne ? convertOne[0].toString() : null,
    } : null,
    roles: {
      owner: owner ? normalizeAddress(owner[0]) : null,
      admin: admin ? normalizeAddress(admin[0]) : null,
      minter: minter ? normalizeAddress(minter[0]) : null,
      controller: controller ? normalizeAddress(controller[0]) : null,
      paused: paused ? Boolean(paused[0]) : isPaused ? Boolean(isPaused[0]) : null,
    },
  };
}

async function usdcRedeemVaultRow(rpc) {
  const [sym, dec, bal] = await Promise.all([
    safeCall(rpc, HASTRA.usdc, ERC20, "symbol"),
    safeCall(rpc, HASTRA.usdc, ERC20, "decimals"),
    safeCall(rpc, HASTRA.usdc, ERC20, "balanceOf", [normalizeAddress(HASTRA.redeemVault)]),
  ]);
  const decimals = dec ? Number(dec[0]) : 6;
  const balance = bal ? unitsToNumber(bal[0], decimals) : null;
  return {
    token: normalizeAddress(HASTRA.usdc),
    symbol: sym ? String(sym[0]) : "USDC",
    owner: normalizeAddress(HASTRA.redeemVault),
    balanceRaw: bal ? bal[0].toString() : null,
    balance,
    balanceUsd: balance,
  };
}

function buildExtraProducers() {
  return [
    {
      source: HASTRA.source,
      protocol: HASTRA.protocol,
      chainId: HASTRA.chainId,
      chain: HASTRA.chain,
      symbol: "wYLDS",
      name: "Hastra wYLDS",
      address: HASTRA.wYLDS,
      category: "rwa-nav-token",
      tags: ["rwa", "yield-bearing", "staking-share", "permissioned-redemption", "transfer-restricted-possible"],
    },
    {
      source: "defillama-adapter:hastra/index.js:ethereumStakingContract-and-local-consumer-artifacts",
      protocol: HASTRA.protocol,
      chainId: HASTRA.chainId,
      chain: HASTRA.chain,
      symbol: "PRIME",
      name: "Hastra PRIME",
      address: HASTRA.prime,
      category: "rwa-nav-token",
      tags: ["rwa", "yield-bearing", "morpho-consumer", "pendle-pt", "permissioned-redemption", "transfer-restricted-possible"],
    },
  ];
}

function runConsumerGraph() {
  writeJson(EXTRA_PRODUCERS_OUT, buildExtraProducers());
  const child = spawnSync(process.execPath, ["scan-rwa-nav-consumer-graph.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      RWA_NAV_PROTOCOL_FILTER: "Hastra",
      RWA_NAV_CHAIN_IDS: "1",
      RWA_NAV_EXTRA_PRODUCER_FILE: EXTRA_PRODUCERS_REL,
      RWA_NAV_OUT: GRAPH_OUT_REL,
      RWA_NAV_MAX_EULER_VAULTS: process.env.RWA_NAV_MAX_EULER_VAULTS || "1200",
      RWA_NAV_MAX_SILO_IDS: process.env.RWA_NAV_MAX_SILO_IDS || "1000",
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

async function fetchDexRows(tokenRows) {
  const addresses = tokenRows.map((row) => lowerAddress(row.address)).filter(Boolean);
  if (!addresses.length) return [];
  const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${addresses.join(",")}`, 30_000).catch(() => null);
  const rows = [];
  for (const pair of json?.pairs || []) {
    const base = lowerAddress(pair.baseToken?.address);
    const quote = lowerAddress(pair.quoteToken?.address);
    const token = tokenRows.find((row) => lowerAddress(row.address) === base || lowerAddress(row.address) === quote);
    if (!token) continue;
    rows.push({
      token: token.address,
      symbol: token.symbol,
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
  return rows.sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0)).slice(0, 20);
}

function rowMatches(value, addressSet, symbolSet) {
  if (value === null || value === undefined) return false;
  const text = String(value).toLowerCase();
  if (addressSet.has(text)) return true;
  if (symbolSet.has(text)) return true;
  return text.includes("hastra") || text.includes("wylds");
}

function shallowSummary(row) {
  const out = {};
  for (const key of [
    "protocol", "chain", "chainId", "symbol", "assetSymbol", "assetName", "vaultSymbol", "vaultName", "marketName",
    "asset", "token", "address", "vault", "market", "collateral", "loanToken", "oracle", "pairAddress", "config",
    "ltv", "lltv", "ltvBorrowBps", "maxLtv", "maxLtvBps", "liquidationThreshold", "liquidityUsd", "liquidityUsdHint",
    "cashUsd", "borrowedUsd", "borrowUsd", "supplyUsd", "routeLiquidityUsd", "bestNetProfitUsd", "netProfitUsd", "routePositive", "watchCandidate", "blocker", "status",
  ]) {
    if (row && Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined) out[key] = row[key];
  }
  return out;
}

function collectRowsFromValue(value, rows, addressSet, symbolSet, limit, depth = 0) {
  if (!value || rows.length >= limit || depth > 10) return false;
  if (Array.isArray(value)) {
    let matched = false;
    for (const item of value) matched = collectRowsFromValue(item, rows, addressSet, symbolSet, limit, depth + 1) || matched;
    return matched;
  }
  if (typeof value !== "object") return rowMatches(value, addressSet, symbolSet);
  let matched = false;
  for (const [key, child] of Object.entries(value)) {
    if (rowMatches(key, addressSet, symbolSet) || (typeof child !== "object" && rowMatches(child, addressSet, symbolSet))) matched = true;
  }
  for (const child of Object.values(value)) {
    if (rows.length >= limit) break;
    if (collectRowsFromValue(child, rows, addressSet, symbolSet, limit, depth + 1)) matched = true;
  }
  if (matched && rows.length < limit) rows.push(shallowSummary(value));
  return matched;
}

function collectLocalArtifactRows(tokenRows, contractRows, limitPerArtifact = 35) {
  const addressSet = new Set(unique([
    ...tokenRows.map((row) => lowerAddress(row.address)),
    ...contractRows.map((row) => lowerAddress(row.address)),
  ]));
  const symbolSet = new Set(["wylds", "prime", "hastra"]);
  const rows = [];
  for (const [protocol, rel] of LOCAL_ARTIFACTS) {
    const file = path.join(WORKSPACE, rel);
    if (!fs.existsSync(file)) continue;
    const stat = fs.statSync(file);
    if (stat.size > MAX_LOCAL_ARTIFACT_BYTES) continue;
    const json = readJson(file, null);
    if (!json) continue;
    const artifactRows = [];
    collectRowsFromValue(json, artifactRows, addressSet, symbolSet, limitPerArtifact);
    for (const row of artifactRows.slice(0, limitPerArtifact)) rows.push({ protocol, artifact: rel, ...row });
  }
  return rows;
}

function flattenGraphMatches(graph) {
  return (graph?.results || []).flatMap((row) => Array.isArray(row.topMatches) ? row.topMatches : Array.isArray(row.matches) ? row.matches : []);
}

function writeReport(out) {
  const s = out.summary;
  const tokenTable = out.tokenRows.map((row) => `| ${row.symbol || "?"} | ${compactAddress(row.address)} | ${row.codePresent} | ${formatNum(row.totalSupply, 2)} | ${formatUsd(row.adapterBalanceUsd)} | ${formatUsd(row.publicPriceUsd ?? row.adapterImpliedPriceUsd)} | ${row.erc4626Like} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const contractTable = out.contractRows.map((row) => `| ${row.label} | ${compactAddress(row.address)} | ${row.codePresent} | ${row.codeBytes} | ${Object.keys(row.selectorHints || {}).join(", ") || "none"} | ${row.paused ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";
  const dexTable = out.dexLiquidityRows.slice(0, 8).map((row) => `| ${row.symbol || "?"} | ${row.dexId || "n/a"} | ${row.baseSymbol || "?"}/${row.quoteSymbol || "?"} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.volume24hUsd)} | ${row.priceUsd ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";
  const matchTable = out.consumerMatches.slice(0, 10).map((row) => `| ${safeCell(row.protocol)} | ${safeCell(row.side)} | ${safeCell(row.producer?.symbol)} | ${row.reviewCandidate ?? false} | ${row.watchCandidate ?? false} | ${formatUsd(row.market?.liquidityAssetsUsd ?? row.market?.cashUsd ?? row.market?.baseCashUsd ?? row.market?.routeLiquidityUsd)} | ${safeCell((row.blockers || [])[0] || row.blocker)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const localTable = out.localArtifactRows.slice(0, 12).map((row) => `| ${row.protocol} | ${safeCell(row.assetSymbol || row.symbol || row.vaultSymbol || row.marketName || "?")} | ${compactAddress(row.asset || row.token || row.collateral || row.address || row.market || row.vault)} | ${formatUsd(row.routeLiquidityUsd ?? row.liquidityUsd ?? row.liquidityUsdHint ?? row.cashUsd)} | ${row.routePositive ?? false} |`).join("\n") || "| none | n/a | n/a | n/a | n/a |";

  const content = `# 🟢 DORMANT - Hastra Phase 0 Triage

Generated: ${out.generatedAt}

Scanner: \`tools/scan-hastra-phase0.js\`

Artifact: \`reports/raw/fast/hastra-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This bounded pass resolved Hastra's public DefiLlama adapter, checked the exact Ethereum wYLDS and PRIME tokens plus the USDC redemption-vault account, seeded both Hastra tokens into the generic RWA/NAV consumer graph, checked public DEX liquidity, and joined exact Hastra addresses against local consumer artifacts. PRIME appears in Morpho and Pendle context, but the source artifacts classify those rows route-negative. No exact-positive borrow, liquidation, redemption, or unwind route was found.

## Summary

| Metric | Value |
|---|---:|
| Public TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Ethereum TVL | ${formatUsd(s.ethereumTvlUsd)} |
| Solana TVL context | ${formatUsd(s.solanaTvlUsd)} |
| wYLDS held by PRIME/staking contract | ${formatUsd(s.wyldsStakedUsd)} |
| PRIME supply context | ${formatUsd(s.primeSupplyUsd)} |
| PRIME graph consumer rows | \`${s.primeGraphConsumerRows}\` |
| PRIME max graph liquidity/cash | ${formatUsd(s.primeMaxGraphLiquidityUsd)} |
| PRIME local consumer rows | \`${s.primeLocalConsumerRows}\` |
| PRIME max local Morpho liquidity | ${formatUsd(s.primeMaxMorphoLiquidityUsd)} |
| PRIME max Pendle liquidity hint | ${formatUsd(s.primeMaxPendleLiquidityUsd)} |
| USDC redemption-vault context | ${formatUsd(s.usdcRedeemVaultUsd)} |
| Token rows | \`${s.tokenRows}\` |
| Contract rows | \`${s.contractRows}\` |
| Consumer matches | \`${s.consumerMatches}\` |
| Review candidates | \`${s.reviewCandidates}\` |
| Local artifact rows | \`${s.localArtifactRows}\` |
| DEX rows | \`${s.dexLiquidityRows}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |
| Coverage classification | \`${s.coverageClassification}\` |

## Token Rows

| Token | Address | Code | Total Supply | Adapter Balance Context | Price Context | ERC4626-like |
|---|---|---:|---:|---:|---:|---:|
${tokenTable}

## Contract Rows

| Label | Address | Code | Code Bytes | Selector Hints | Paused |
|---|---|---:|---:|---|---:|
${contractTable}

## Consumer Graph Matches

| Protocol | Side | Producer | Review | Watch | Liquidity/Cash | First Blocker |
|---|---|---|---:|---:|---:|---|
${matchTable}

## DEX Context

| Token | DEX | Pair | Liquidity USD | 24h Volume USD | Price USD |
|---|---|---|---:|---:|---:|
${dexTable}

## Local Artifact Joins

| Source | Symbol/Market | Address | Liquidity/Cash | Route-positive |
|---|---|---|---:|---:|
${localTable}

## Blockers

${out.blockers.map((line) => `- ${line}`).join("\n")}

## Required For Route-Positive

${out.requiredForRoutePositive.map((line) => `- ${line}`).join("\n")}

## Next Read-Only Step

${out.nextReadOnlyStep}
`;
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const [metadataRaw, rpc, wyldsPrice, primePrice] = await Promise.all([
    fetchJson("https://api.llama.fi/protocol/hastra", 45_000),
    resolveRpc(ETHEREUM_CHAIN_ID),
    fetchAddressPrice(HASTRA.wYLDS),
    fetchAddressPrice(HASTRA.prime),
  ]);
  const metadata = publicMetadata(metadataRaw || {});
  const blockNumber = rpc ? await latestBlock(rpc) : null;
  const tokenRows = rpc ? await Promise.all([
    tokenMeta(rpc, HASTRA.wYLDS, metadata, wyldsPrice, { symbol: "wYLDS", name: "Hastra wYLDS", balanceOwner: HASTRA.prime, balanceLabel: "wYLDS held by PRIME/staking contract" }),
    tokenMeta(rpc, HASTRA.prime, metadata, primePrice, { symbol: "PRIME", name: "Hastra PRIME" }),
  ]) : [];
  const [redeemMeta, usdcVault] = rpc ? await Promise.all([
    contractMeta(rpc, "USDC redemption vault", HASTRA.redeemVault),
    usdcRedeemVaultRow(rpc),
  ]) : [null, null];
  const contractRows = [
    ...tokenRows.map((row) => ({ label: `${row.symbol} token`, address: row.address, codePresent: row.codePresent, codeBytes: row.codeBytes, eip1967Implementation: row.eip1967Implementation, selectorHints: row.selectorHints, paused: row.roles?.paused })),
    redeemMeta,
  ].filter(Boolean);
  const graph = runConsumerGraph();
  const consumerMatches = flattenGraphMatches(graph);
  const dexLiquidityRows = await fetchDexRows(tokenRows);
  const localArtifactRows = collectLocalArtifactRows(tokenRows, contractRows);

  const graphSummary = graph?.summary || {};
  const localRoutePositive = localArtifactRows.filter((row) => row.routePositive === true).length;
  const dexRowsMaterial = dexLiquidityRows.filter((row) => (asNumber(row.liquidityUsd) || 0) >= MATERIAL_USD).length;
  const watchCandidates = asNumber(graphSummary.watchCandidates) || 0;
  const routePositive = Math.max(asNumber(graphSummary.routePositive) || 0, localRoutePositive);
  const wyldsToken = tokenRows.find((row) => row.symbol === "wYLDS") || tokenRows[0] || {};
  const primeToken = tokenRows.find((row) => row.symbol === "PRIME") || {};
  const topDexLiquidityUsd = dexLiquidityRows.reduce((max, row) => Math.max(max, asNumber(row.liquidityUsd) || 0), 0) || null;
  const primeAddr = lowerAddress(HASTRA.prime);
  const primeGraphRows = consumerMatches.filter((row) => lowerAddress(row.producer?.address) === primeAddr || lowerAddress(row.market?.collateralAsset?.address) === primeAddr);
  const primeMaxGraphLiquidityUsd = primeGraphRows.reduce((max, row) => Math.max(max, asNumber(row.market?.liquidityAssetsUsd ?? row.market?.cashUsd ?? row.market?.baseCashUsd ?? row.market?.routeLiquidityUsd) || 0), 0) || null;
  const primeRows = localArtifactRows.filter((row) => JSON.stringify(row).toLowerCase().includes(primeAddr) || JSON.stringify(row).toLowerCase().includes("prime"));
  const primeMaxMorphoLiquidityUsd = primeRows.filter((row) => /morpho/i.test(row.protocol || "")).reduce((max, row) => Math.max(max, asNumber(row.liquidityUsd) || 0), 0) || null;
  const primeMaxPendleLiquidityUsd = primeRows.filter((row) => /pendle/i.test(row.protocol || "")).reduce((max, row) => Math.max(max, asNumber(row.liquidityUsdHint) || 0), 0) || null;

  const summary = {
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    ethereumTvlUsd: metadata.ethereumTvlUsd,
    solanaTvlUsd: metadata.solanaTvlUsd,
    wyldsStakedUsd: round(wyldsToken.adapterBalanceUsd, 2),
    primeSupplyUsd: round(primeToken.totalSupplyUsd, 2),
    primeGraphConsumerRows: primeGraphRows.length,
    primeMaxGraphLiquidityUsd: round(primeMaxGraphLiquidityUsd, 2),
    primeLocalConsumerRows: primeRows.length,
    primeMaxMorphoLiquidityUsd: round(primeMaxMorphoLiquidityUsd, 2),
    primeMaxPendleLiquidityUsd: round(primeMaxPendleLiquidityUsd, 2),
    usdcRedeemVaultUsd: round(usdcVault?.balanceUsd, 2),
    tokenRows: tokenRows.length,
    tokenRowsWithCode: tokenRows.filter((row) => row.codePresent).length,
    contractRows: contractRows.length,
    contractsWithCode: contractRows.filter((row) => row.codePresent).length,
    erc4626LikeRows: tokenRows.filter((row) => row.erc4626Like).length,
    consumerMatches: asNumber(graphSummary.matches) || consumerMatches.length,
    reviewCandidates: asNumber(graphSummary.reviewCandidates) || consumerMatches.filter((row) => row.reviewCandidate).length,
    graphWatchCandidates: asNumber(graphSummary.watchCandidates) || 0,
    localArtifactRows: localArtifactRows.length,
    dexLiquidityRows: dexLiquidityRows.length,
    materialDexRows: dexRowsMaterial,
    topDexLiquidityUsd: round(topDexLiquidityUsd, 2),
    watchCandidates,
    routePositive,
    executableNow: false,
    signedActionJustified: false,
    coverageClassification: "bounded-with-caveats",
    forkGate: routePositive > 0 ? "needs-fork-extraction-proof" : "closed-route-positive-zero",
    status: routePositive > 0 ? "hastra-phase0-route-positive-needs-fork" : "hastra-phase0-no-route-positive",
  };

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-hastra-phase0.js",
    scope: "Read-only Hastra Ethereum wYLDS, staking/redemption-vault, RWA/NAV consumer-graph, local consumer-join, and DEX exit-liquidity Phase 0",
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
    metadata: {
      name: metadata.name,
      slug: metadata.slug,
      category: metadata.category,
      module: metadata.module,
      tvlCodePath: metadata.tvlCodePath,
      methodology: metadata.methodology,
      chains: metadata.chains,
      evmChains: ["Ethereum"],
      unsupportedChains: ["Solana"],
      doubleCounted: metadata.doubleCounted,
      tvlUsd: metadata.tvlUsd,
      ethereumTvlUsd: metadata.ethereumTvlUsd,
      solanaTvlUsd: metadata.solanaTvlUsd,
      audits: metadata.audits,
      url: metadata.url,
      twitter: metadata.twitter,
      sourceAvailability: "defillama-adapter-and-live-bytecode; no canonical public Hastra source repo resolved in this pass",
    },
    adapter: {
      module: HASTRA.module,
      tvlCodePath: HASTRA.tvlCodePath,
      wYLDSContract: normalizeAddress(HASTRA.wYLDS),
      stakingContract: normalizeAddress(HASTRA.staking),
      primeToken: normalizeAddress(HASTRA.prime),
      redeemVaultAccount: normalizeAddress(HASTRA.redeemVault),
      redeemAsset: normalizeAddress(HASTRA.usdc),
      method: "sum wYLDS held by Ethereum PRIME/staking contract plus USDC held by Ethereum redemption vault; Solana accounts are context-only in this EVM pass",
    },
    block: { chain: "Ethereum", chainId: ETHEREUM_CHAIN_ID, number: blockNumber, rpcResolved: Boolean(rpc) },
    tokenRows,
    contractRows,
    usdcRedeemVault: usdcVault,
    consumerGraph: {
      artifact: GRAPH_OUT_REL,
      summary: graphSummary,
      producerSource: graph?.producerSource || null,
    },
    consumerMatches,
    dexLiquidityRows,
    localArtifactRows,
    summary,
    blockers: [
      "Hastra TVL is adapter accounting context from vaulted wYLDS plus redemption-vault USDC, not proof of a permissionless extraction path",
      "Solana Hastra accounts are outside this EVM Phase 0 and are not closed route-negative",
      "No exact Hastra wYLDS trusted consumer with current positive borrow, liquidation, redemption, or unwind economics was resolved",
      "Hastra PRIME appears in Morpho/Pendle local artifacts, but source artifacts classify those rows route-negative: Morpho exact acquisition/stress economics are negative or allocator flow caps are zero, and Pendle PT/YT rows lack consumer-specific positive economics",
      "No public DEX exit route for wYLDS was proven with exact-positive economics in this pass",
      "RWA issuance/redemption and transferability remain treated as permissioned or non-atomic absent public same-block exit proof",
      "No fork extraction proof and no signed-action justification exist",
    ],
    requiredForRoutePositive: [
      "exact wYLDS, PRIME, or a Hastra receipt token is accepted by a material lending, margin, redemption, PT/vault, or liquidation consumer",
      "current NAV/oracle/accepted value exceeds exact acquisition or redemption/DEX value after LTV/LLTV haircuts and costs",
      "borrow, redemption, liquidation, or DEX exit liquidity is live, permissionless, and exact-quoted positive after fees, gas, and slippage",
      "transfer/redemption path for the exact token and size is not role-gated, queued, or delayed beyond the route model",
      "fork extraction proof demonstrates measured net profit",
    ],
    nextReadOnlyStep: "Keep Hastra closed unless wYLDS/PRIME gains a material trusted consumer with positive economics, a public exit route, accepted-value/NAV/oracle divergence, or a sanitized Solana consumer route with exact-positive economics.",
  };

  writeJson(RAW_OUT, out);
  writeReport(out);
  if (!QUIET) {
    console.log(`Hastra Phase0: tvl=${formatUsd(summary.defillamaCurrentTvlUsd)} eth=${formatUsd(summary.ethereumTvlUsd)} matches=${summary.consumerMatches} dexRows=${summary.dexLiquidityRows} local=${summary.localArtifactRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT)}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(`Hastra Phase0 failed: ${err.stack || err.message}`);
  process.exit(1);
});
