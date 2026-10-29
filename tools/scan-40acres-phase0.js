#!/usr/bin/env node
// scan-40acres-phase0.js - bounded read-only Phase 0 for 40 Acres.
// RPC URLs stay in memory via shared-rpc. Portfolio/borrower addresses are sampled in memory only and never persisted.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool, PUBLIC_FALLBACKS } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const TARGET_DIR = path.join(WORKSPACE, "targets", "40-acres-loan-contracts");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "40acres-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "40acres-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const ZERO = "0x0000000000000000000000000000000000000000";
const SIGNAL_DORMANT = "🟢 DORMANT";
const MAX_PORTFOLIOS_PER_FACTORY = Number(process.env.FORTY_ACRES_MAX_PORTFOLIOS_PER_FACTORY || "25");
const AUTH_LOG_BLOCKS = Number(process.env.FORTY_ACRES_AUTH_LOG_BLOCKS || "0");
const AUTH_LOG_CHUNK_BLOCKS = Number(process.env.FORTY_ACRES_AUTH_LOG_CHUNK_BLOCKS || "100000");
const MATERIAL_USD = Number(process.env.FORTY_ACRES_MATERIAL_USD || "10000");

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const CHAINS = [
  { chain: "Ethereum", chainId: 1, adapterKey: "ethereum", coinSlug: "ethereum", publicQueueScope: false },
  { chain: "Optimism", chainId: 10, adapterKey: "optimism", coinSlug: "optimism", publicQueueScope: true },
  { chain: "Base", chainId: 8453, adapterKey: "base", coinSlug: "base", publicQueueScope: true },
  { chain: "Avalanche", chainId: 43114, adapterKey: "avax", coinSlug: "avax", publicQueueScope: true },
];

const ADDRESS_FILES = [
  { platform: "yieldbasis-eth", file: path.join(TARGET_DIR, "addresses", "mainnet", "yieldbasis-eth.json"), patchSurface: true },
  { platform: "supernova", file: path.join(TARGET_DIR, "addresses", "mainnet", "supernova.json"), patchSurface: false },
  { platform: "aerodrome", file: path.join(TARGET_DIR, "addresses", "base", "aerodrome.json"), patchSurface: false },
  { platform: "hydrex", file: path.join(TARGET_DIR, "addresses", "base", "hydrex.json"), patchSurface: false },
  { platform: "velodrome", file: path.join(TARGET_DIR, "addresses", "optimism", "velodrome.json"), patchSurface: false },
  { platform: "pharaoh", file: path.join(TARGET_DIR, "addresses", "avalanche", "pharaoh.json"), patchSurface: false },
  { platform: "blackhole", file: path.join(TARGET_DIR, "addresses", "avalanche", "blackhole.json"), patchSurface: false },
];

const ADAPTER_ROWS = [
  { chain: "Optimism", chainId: 10, platform: "velodrome", role: "adapter.vault", address: "0x08dCDBf7baDe91Ccd42CB2a4EA8e5D199d285957", source: "defillama-helper" },
  { chain: "Optimism", chainId: 10, platform: "velodrome", role: "adapter.loan", address: "0xf132bD888897254521D13e2c401e109caABa06A7", source: "defillama-helper" },
  { chain: "Base", chainId: 8453, platform: "aerodrome", role: "adapter.vault", address: "0xB99B6dF96d4d5448cC0a5B3e0ef7896df9507Cf5", source: "defillama-helper" },
  { chain: "Base", chainId: 8453, platform: "aerodrome", role: "adapter.loan", address: "0x87f18b377e625b62c708D5f6EA96EC193558EFD0", source: "defillama-helper" },
  { chain: "Avalanche", chainId: 43114, platform: "pharaoh", role: "adapter.vault", address: "0x124D00b1ce4453Ffc5a5F65cE83aF13A7709baC7", source: "defillama-helper" },
  { chain: "Avalanche", chainId: 43114, platform: "pharaoh", role: "adapter.loan", address: "0xf6A044c3b2a3373eF2909E2474f3229f23279B5F", source: "defillama-helper" },
  { chain: "Avalanche", chainId: 43114, platform: "blackhole", role: "adapter.vault", address: "0xC0485C4bafB594Ae1457820fb6e5B67e8A04BCFD", source: "defillama-helper" },
  { chain: "Avalanche", chainId: 43114, platform: "blackhole", role: "adapter.loan", address: "0x5122f5154DF20E5F29df53E633cE1ac5b6623558", source: "defillama-helper" },
  { chain: "Optimism", chainId: 10, platform: "velodrome", role: "adapter.baseToken", symbol: "VELO", address: "0x3c8B650257cFb5f272f799F5e2b4e65093a11a05", source: "defillama-helper" },
  { chain: "Base", chainId: 8453, platform: "aerodrome", role: "adapter.baseToken", symbol: "AERO", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", source: "defillama-helper" },
  { chain: "Avalanche", chainId: 43114, platform: "pharaoh", role: "adapter.baseToken", symbol: "PHAR", address: "0x13a466998ce03db73abc2d4df3bbd845ed1f28e7", source: "defillama-helper" },
  { chain: "Avalanche", chainId: 43114, platform: "blackhole", role: "adapter.baseToken", symbol: "BLACK", address: "0xcd94a87696fac69edae3a70fe5725307ae1c43f6", source: "defillama-helper" },
  { chain: "Optimism", chainId: 10, platform: "velodrome", role: "adapter.veNft", symbol: "veVELO", address: "0xFAf8FD17D9840595845582fCB047DF13f006787d", source: "defillama-helper" },
  { chain: "Base", chainId: 8453, platform: "aerodrome", role: "adapter.veNft", symbol: "veAERO", address: "0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4", source: "defillama-helper" },
  { chain: "Avalanche", chainId: 43114, platform: "pharaoh", role: "adapter.veNft", symbol: "vePHAR", address: "0xAAAEa1fB9f3DE3F70E89f37B69Ab11B47eb9Ce6F", source: "defillama-helper" },
  { chain: "Avalanche", chainId: 43114, platform: "blackhole", role: "adapter.veNft", symbol: "veBLACK", address: "0xEac562811cc6abDbB2c9EE88719eCA4eE79Ad763", source: "defillama-helper" },
  { chain: "Base", chainId: 8453, platform: "global", role: "adapter.portfolioManager", address: "0x40ac2e40acb7bdd6ec83e468143262fe216529ec", source: "defillama-helper" },
  { chain: "Optimism", chainId: 10, platform: "global", role: "adapter.portfolioManager", address: "0x40ac2e40acb7bdd6ec83e468143262fe216529ec", source: "defillama-helper" },
  { chain: "Avalanche", chainId: 43114, platform: "pharaoh", role: "adapter.portfolioFactory", address: "0x52d43C377e498980135C8F2E858f120A18Ea96C2", source: "defillama-helper" },
  { chain: "Avalanche", chainId: 43114, platform: "pharaoh", role: "adapter.voterModule", address: "0x34F233F868CdB42446a18562710eE705d66f846b", source: "defillama-helper" },
];

const SELECTORS = {
  harvestLpFees: selector("harvestLpFees(uint256)"),
  getAvailableLpFeeYield: selector("getAvailableLpFeeYield()"),
  getDepositInfo: selector("getDepositInfo()"),
  yieldBasisBorrow: selector("borrow(uint256)"),
  topUp: selector("topUp()"),
  deposit: selector("deposit(uint256)"),
};

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);

const BEACON = new ethers.Interface(["function implementation() view returns (address)"]);
const VAULT = new ethers.Interface([
  "function asset() view returns (address)",
  "function lendingAsset() view returns (address)",
  "function lendingVault() view returns (address)",
  "function activeAssets() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function paused() view returns (bool)",
  "function originationFeeBps() view returns (uint256)",
  "function owner() view returns (address)",
  "function getTreasury() view returns (address)",
  "function getPortfolioFactory() view returns (address)",
  "function getDebtBalance(address borrower) view returns (uint256)",
  "function getEffectiveDebtBalance(address borrower) view returns (uint256)",
]);

const FACTORY = new ethers.Interface([
  "function facetRegistry() view returns (address)",
  "function portfolioManager() view returns (address)",
  "function portfolioFactoryConfig() view returns (address)",
  "function getAllPortfolios() view returns (address[])",
  "function getPortfoliosLength() view returns (uint256)",
  "function ownerOf(address portfolio) view returns (address)",
]);

const MANAGER = new ethers.Interface([
  "function getAllFactories() view returns (address[])",
  "function getFactoriesLength() view returns (uint256)",
  "function authorizedCallers(address caller) view returns (bool)",
  "function isAuthorizedCaller(address caller) view returns (bool)",
  "function owner() view returns (address)",
]);

const REGISTRY = new ethers.Interface([
  "function getFacetForSelector(bytes4 selector) view returns (address)",
  "function getSelectorsForFacet(address facet) view returns (bytes4[])",
  "function getFacetName(address facet) view returns (string)",
  "function getVersion() view returns (uint256)",
]);

const PORTFOLIO = new ethers.Interface([
  "function getAvailableLpFeeYield() view returns (uint256,uint256)",
  "function getDepositInfo() view returns (uint256,uint256,uint256)",
]);

const AUTH_EVENT = new ethers.Interface(["event AuthorizedCallerSet(address indexed caller, bool authorized)"]);

function selector(sig) { return ethers.id(sig).slice(0, 10); }
function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const text = readText(file).replace(/^\uFEFF/, ""); return text ? JSON.parse(text) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function nonZeroAddress(value) { const addr = normalizeAddress(value); return addr && addr !== ZERO ? addr : null; }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`; }
function formatPct(value) { const n = asNumber(value); return n === null ? "n/a" : `${round(n, 2)}%`; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function safeText(value, max = 120) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function unitsToNumber(value, decimals = 18) { try { const n = Number(ethers.formatUnits(toBig(value), Number(decimals))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function slotAddress(raw) { const addr = raw && raw !== "0x" && raw.length >= 66 ? normalizeAddress(`0x${raw.slice(26)}`) : null; return addr && addr !== ZERO ? addr : null; }
function sum(rows, field) { return rows.reduce((acc, row) => acc + (asNumber(row[field]) || 0), 0); }
function max(rows, field) { const vals = rows.map((row) => asNumber(row[field])).filter((n) => n !== null); return vals.length ? Math.max(...vals) : null; }
function chainMeta(chainId) { return CHAINS.find((row) => row.chainId === Number(chainId)); }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-40acres-phase0/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = 12_000, from = null) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr) return null;
  try {
    const tx = { to: addr, data: iface.encodeFunctionData(fn, args) };
    if (from && normalizeAddress(from)) tx.from = normalizeAddress(from);
    const raw = await rpcCall(rpc, "eth_call", [tx, "latest"], timeoutMs);
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) { return null; }
}

async function resolveRpcPoolFast(chainIds) {
  const result = {};
  const missing = [];
  for (const chainId of chainIds) {
    const fallback = PUBLIC_FALLBACKS[chainId];
    if (fallback) {
      const id = await rpcCall(fallback, "eth_chainId", [], 5_000).catch(() => null);
      if (id && Number(BigInt(id)) === Number(chainId)) {
        result[chainId] = fallback;
        continue;
      }
    }
    missing.push(chainId);
  }
  if (missing.length) {
    const resolved = await resolveRpcPool(missing);
    for (const [chainId, rpc] of Object.entries(resolved || {})) if (rpc) result[chainId] = rpc;
  }
  return result;
}

async function getCode(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return "0x";
  return await rpcCall(rpc, "eth_getCode", [addr, "latest"], 12_000).catch(() => "0x") || "0x";
}

async function latestBlock(rpc) {
  const raw = await rpcCall(rpc, "eth_blockNumber", [], 8_000).catch(() => null);
  return raw ? Number(BigInt(raw)) : null;
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

async function tokenMeta(rpc, token) {
  const addr = normalizeAddress(token);
  if (!rpc || !addr) return { address: addr, symbol: null, name: null, decimals: 18 };
  const [symbol, name, decimals] = await Promise.all([
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, ERC20, "decimals"),
  ]);
  return {
    address: addr,
    symbol: safeText(symbol?.[0], 32),
    name: safeText(name?.[0], 96),
    decimals: decimals?.[0] === undefined ? 18 : Number(decimals[0]),
  };
}

async function tokenBalance(rpc, token, owner) {
  const result = await safeCall(rpc, token, ERC20, "balanceOf", [owner]);
  return result?.[0] === undefined ? 0n : toBig(result[0]);
}

function parseRegistryRows() {
  const rows = [];
  for (const entry of ADDRESS_FILES) {
    const json = readJson(entry.file, null);
    if (!json?.contracts) continue;
    const chain = chainMeta(json.chainId)?.chain || json.network || `chain-${json.chainId}`;
    const platform = json.platform || entry.platform;
    function walk(value, parts) {
      if (typeof value === "string") {
        const address = normalizeAddress(value);
        if (address && address !== ZERO) rows.push({ chain, chainId: json.chainId, platform, role: parts.join("."), address, source: "source-registry", patchSurface: Boolean(entry.patchSurface) });
        return;
      }
      if (!value || typeof value !== "object") return;
      if (typeof value.prod === "string" || typeof value.dev === "string") {
        const address = normalizeAddress(value.prod || value.dev);
        if (address && address !== ZERO) rows.push({ chain, chainId: json.chainId, platform, role: `${parts.join(".")}.prod`, address, source: "source-registry", patchSurface: Boolean(entry.patchSurface) });
        return;
      }
      for (const [key, child] of Object.entries(value)) walk(child, [...parts, key]);
    }
    walk(json.contracts, []);
  }
  return rows;
}

function uniqueAddressRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const address = normalizeAddress(row.address);
    if (!address || address === ZERO) continue;
    const key = `${row.chainId}:${address.toLowerCase()}:${row.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...row, address });
  }
  return out;
}

function uniqueByChainAddress(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const address = normalizeAddress(row.address || row.factory || row.manager || row.vault || row.loan);
    if (!address || address === ZERO) continue;
    const key = `${row.chainId}:${address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...row, address });
  }
  return out;
}

function roleIncludes(row, words) {
  const text = `${row.role || ""} ${row.platform || ""}`.toLowerCase();
  return words.some((word) => text.includes(word));
}

function isVaultRole(row) {
  const role = String(row.role || "").toLowerCase();
  return role.includes("adapter.vault") || role.includes("supplyvault") || role === "supply" || role.endsWith(".supply");
}

function isLoanRole(row) {
  const role = String(row.role || "").toLowerCase();
  if (role.includes("loanconfig") || role.includes("usdc-loan.")) return false;
  return role.includes("adapter.loan") || role === "loan" || role.endsWith(".loan") || role.endsWith(".loan.prod");
}

function isFactoryRole(row) {
  const role = String(row.role || "").toLowerCase();
  if (role.includes("walletfactory") || role.includes("portfoliofactory")) return false;
  return role.includes(".factory.prod") || role === "factory" || role.endsWith(".factory");
}

async function fetchMetadata() {
  const json = await fetchJson("https://api.llama.fi/protocol/40-acres", 30_000);
  const discovery = readJson(path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json"), {});
  const queueRow = [discovery?.queues?.freshPhase0, discovery?.freshPhase0Targets, discovery?.combinedCandidates]
    .flatMap((items) => Array.isArray(items) ? items : [])
    .find((row) => String(row?.slug || row?.protocol?.slug || "").toLowerCase() === "40-acres");
  const currentChainTvls = json?.currentChainTvls || {};
  const chainTvlSum = [currentChainTvls.Base, currentChainTvls.Optimism, currentChainTvls.Avalanche].reduce((acc, value) => acc + (asNumber(value) || 0), 0);
  const tvlUsd = [json?.tvl, queueRow?.tvlUsd, queueRow?.tvl, chainTvlSum].map(asNumber).find((value) => value !== null);
  return {
    name: json?.name || queueRow?.name || "40 Acres",
    slug: json?.slug || "40-acres",
    category: json?.category || queueRow?.category || "Lending",
    module: json?.module || null,
    tvlUsd: round(tvlUsd, 2),
    baseTvlUsd: round(currentChainTvls.Base, 2),
    optimismTvlUsd: round(currentChainTvls.Optimism, 2),
    avalancheTvlUsd: round(currentChainTvls.Avalanche, 2),
    borrowedUsd: round(currentChainTvls.borrowed, 2),
    baseBorrowedUsd: round(currentChainTvls["Base-borrowed"], 2),
    optimismBorrowedUsd: round(currentChainTvls["Optimism-borrowed"], 2),
    avalancheBorrowedUsd: round(currentChainTvls["Avalanche-borrowed"], 2),
    chains: json?.chains || ["Base", "Optimism", "Avalanche"],
    methodology: safeText(json?.methodology, 260),
  };
}

function priceKey(chainId, token) {
  const chain = chainMeta(chainId);
  const addr = normalizeAddress(token);
  if (!chain || !addr) return null;
  return `${chain.coinSlug}:${addr}`;
}

async function fetchPrices(tokens) {
  const ids = [...new Set(tokens.map((row) => priceKey(row.chainId, row.address)).filter(Boolean))];
  const out = {};
  for (let i = 0; i < ids.length; i += 60) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${ids.slice(i, i + 60).join(",")}?searchWidth=6h`, 30_000) || { coins: {} };
    for (const [key, value] of Object.entries(json.coins || {})) out[key.toLowerCase()] = asNumber(value.price);
  }
  return out;
}

function priceFor(chainId, token, prices) {
  const key = priceKey(chainId, token);
  return key ? prices[String(key).toLowerCase()] ?? null : null;
}

async function probeAddressRows(rows, rpcPool) {
  const out = [];
  for (const row of rows) {
    const rpc = rpcPool[row.chainId];
    const code = await getCode(rpc, row.address);
    const meta = code && code !== "0x" ? await proxyMeta(rpc, row.address) : {};
    out.push({
      ...row,
      codePresent: Boolean(code && code !== "0x"),
      codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
      runtimeCodeHash: code && code !== "0x" ? ethers.keccak256(code) : null,
      ...meta,
    });
  }
  return out;
}

async function probeVaultRows(addressRows, rpcPool, prices) {
  const candidates = uniqueByChainAddress(addressRows.filter(isVaultRole));
  const rows = [];
  for (const row of candidates) {
    const rpc = rpcPool[row.chainId];
    if (!rpc || !row.codePresent) continue;
    const assetResult = await safeCall(rpc, row.address, VAULT, "asset") || await safeCall(rpc, row.address, VAULT, "lendingAsset");
    const asset = normalizeAddress(assetResult?.[0]);
    const assetMeta = asset ? await tokenMeta(rpc, asset) : { decimals: 18, symbol: null };
    const [balance, activeAssets, totalAssets, totalSupply, paused, origFee, owner, treasury, portfolioFactory] = await Promise.all([
      asset ? tokenBalance(rpc, asset, row.address) : Promise.resolve(0n),
      safeCall(rpc, row.address, VAULT, "activeAssets"),
      safeCall(rpc, row.address, VAULT, "totalAssets"),
      safeCall(rpc, row.address, VAULT, "totalSupply"),
      safeCall(rpc, row.address, VAULT, "paused"),
      safeCall(rpc, row.address, VAULT, "originationFeeBps"),
      safeCall(rpc, row.address, VAULT, "owner"),
      safeCall(rpc, row.address, VAULT, "getTreasury"),
      safeCall(rpc, row.address, VAULT, "getPortfolioFactory"),
    ]);
    const priceUsd = asset ? priceFor(row.chainId, asset, prices) : null;
    const liquid = unitsToNumber(balance, assetMeta.decimals);
    const borrowed = activeAssets?.[0] === undefined ? null : unitsToNumber(activeAssets[0], assetMeta.decimals);
    const assets = totalAssets?.[0] === undefined ? null : unitsToNumber(totalAssets[0], assetMeta.decimals);
    const shares = totalSupply?.[0] === undefined ? null : unitsToNumber(totalSupply[0], assetMeta.decimals);
    rows.push({
      chain: row.chain,
      chainId: row.chainId,
      platform: row.platform,
      role: row.role,
      vault: row.address,
      asset,
      assetSymbol: assetMeta.symbol,
      assetDecimals: assetMeta.decimals,
      priceUsd: round(priceUsd, 8),
      liquidAssets: round(liquid, 8),
      liquidAssetsUsd: round(priceUsd && liquid !== null ? priceUsd * liquid : null, 2),
      activeAssets: round(borrowed, 8),
      activeAssetsUsd: round(priceUsd && borrowed !== null ? priceUsd * borrowed : null, 2),
      totalAssets: round(assets, 8),
      totalAssetsUsd: round(priceUsd && assets !== null ? priceUsd * assets : null, 2),
      totalSupply: round(shares, 8),
      paused: paused?.[0] === undefined ? null : Boolean(paused[0]),
      originationFeeBps: origFee?.[0] === undefined ? null : Number(origFee[0]),
      owner: normalizeAddress(owner?.[0]),
      treasury: normalizeAddress(treasury?.[0]),
      portfolioFactory: normalizeAddress(portfolioFactory?.[0]),
    });
  }
  return rows;
}

async function probeLoanRows(addressRows, rpcPool, prices) {
  const candidates = uniqueByChainAddress(addressRows.filter(isLoanRole));
  const rows = [];
  for (const row of candidates) {
    const rpc = rpcPool[row.chainId];
    if (!rpc || !row.codePresent) continue;
    const assetResult = await safeCall(rpc, row.address, VAULT, "lendingAsset") || await safeCall(rpc, row.address, VAULT, "asset");
    const asset = normalizeAddress(assetResult?.[0]);
    const assetMeta = asset ? await tokenMeta(rpc, asset) : { decimals: 18, symbol: null };
    const [activeAssets, lendingVault, paused, owner] = await Promise.all([
      safeCall(rpc, row.address, VAULT, "activeAssets"),
      safeCall(rpc, row.address, VAULT, "lendingVault"),
      safeCall(rpc, row.address, VAULT, "paused"),
      safeCall(rpc, row.address, VAULT, "owner"),
    ]);
    const priceUsd = asset ? priceFor(row.chainId, asset, prices) : null;
    const active = activeAssets?.[0] === undefined ? null : unitsToNumber(activeAssets[0], assetMeta.decimals);
    rows.push({
      chain: row.chain,
      chainId: row.chainId,
      platform: row.platform,
      role: row.role,
      loan: row.address,
      asset,
      assetSymbol: assetMeta.symbol,
      assetDecimals: assetMeta.decimals,
      priceUsd: round(priceUsd, 8),
      activeAssets: round(active, 8),
      activeAssetsUsd: round(priceUsd && active !== null ? priceUsd * active : null, 2),
      lendingVault: normalizeAddress(lendingVault?.[0]),
      paused: paused?.[0] === undefined ? null : Boolean(paused[0]),
      owner: normalizeAddress(owner?.[0]),
    });
  }
  return rows;
}

async function scanAuthorizedLogs(rpc, manager, latest) {
  if (!rpc || !manager || latest === null || AUTH_LOG_BLOCKS <= 0) return { status: "skipped", callers: [] };
  const fromBlock = Math.max(0, latest - AUTH_LOG_BLOCKS);
  const topic0 = AUTH_EVENT.getEvent("AuthorizedCallerSet").topicHash;
  const callers = new Map();
  let chunks = 0;
  let errors = 0;
  for (let from = fromBlock; from <= latest; from += AUTH_LOG_CHUNK_BLOCKS) {
    const to = Math.min(latest, from + AUTH_LOG_CHUNK_BLOCKS - 1);
    chunks++;
    const logs = await rpcCall(rpc, "eth_getLogs", [{ address: manager, fromBlock: hexBlock(from), toBlock: hexBlock(to), topics: [topic0] }], 20_000).catch(() => null);
    if (!Array.isArray(logs)) { errors++; continue; }
    for (const log of logs) {
      try {
        const caller = normalizeAddress(`0x${String(log.topics?.[1] || "").slice(26)}`);
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["bool"], log.data || "0x");
        if (caller) callers.set(caller.toLowerCase(), { caller, authorized: Boolean(decoded[0]), blockNumber: Number(BigInt(log.blockNumber || 0)) });
      } catch (_) {}
    }
  }
  return { status: errors ? "bounded-partial" : "bounded-ok", chunks, errors, fromBlock, toBlock: latest, callers: [...callers.values()].sort((a, b) => (b.blockNumber || 0) - (a.blockNumber || 0)).slice(0, 30) };
}

async function probeManagerRows(addressRows, rpcPool) {
  const managers = uniqueByChainAddress(addressRows.filter((row) => roleIncludes(row, ["portfoliomanager"]))).filter((row) => row.codePresent);
  const rows = [];
  for (const row of managers) {
    const rpc = rpcPool[row.chainId];
    const latest = await latestBlock(rpc);
    const [owner, allFactories, factoryLength, selfAuth, logScan] = await Promise.all([
      safeCall(rpc, row.address, MANAGER, "owner"),
      safeCall(rpc, row.address, MANAGER, "getAllFactories"),
      safeCall(rpc, row.address, MANAGER, "getFactoriesLength"),
      safeCall(rpc, row.address, MANAGER, "authorizedCallers", [row.address]),
      scanAuthorizedLogs(rpc, row.address, latest),
    ]);
    rows.push({
      chain: row.chain,
      chainId: row.chainId,
      manager: row.address,
      owner: normalizeAddress(owner?.[0]),
      factoriesLength: factoryLength?.[0] === undefined ? (Array.isArray(allFactories?.[0]) ? allFactories[0].length : null) : Number(factoryLength[0]),
      factoriesDiscovered: Array.isArray(allFactories?.[0]) ? allFactories[0].map(normalizeAddress).filter(Boolean) : [],
      portfolioManagerAuthorizedSelf: selfAuth?.[0] === undefined ? null : Boolean(selfAuth[0]),
      authorizedLogScan: logScan.status,
      authorizedCallersObserved: (logScan.callers || []).filter((item) => item.authorized).map((item) => ({ caller: item.caller, blockNumber: item.blockNumber })),
    });
  }
  return rows;
}

async function probeFactoryRows(addressRows, managerRows, vaultRows, rpcPool) {
  const registryFactories = addressRows.filter(isFactoryRole);
  const liveFactories = managerRows.flatMap((manager) => (manager.factoriesDiscovered || []).map((address) => ({ chain: manager.chain, chainId: manager.chainId, platform: "manager-discovered", role: "manager.factory", address, source: "portfolio-manager" })));
  const candidates = uniqueByChainAddress([...registryFactories, ...liveFactories]).filter((row) => row.codePresent !== false);
  const rows = [];
  for (const row of candidates) {
    const rpc = rpcPool[row.chainId];
    if (!rpc) continue;
    const code = row.codePresent === undefined ? await getCode(rpc, row.address) : "0x01";
    if (!code || code === "0x") continue;
    const [facetRegistry, portfolioManager, config, portfolios, portfolioLength] = await Promise.all([
      safeCall(rpc, row.address, FACTORY, "facetRegistry"),
      safeCall(rpc, row.address, FACTORY, "portfolioManager"),
      safeCall(rpc, row.address, FACTORY, "portfolioFactoryConfig"),
      safeCall(rpc, row.address, FACTORY, "getAllPortfolios", [], 20_000),
      safeCall(rpc, row.address, FACTORY, "getPortfoliosLength"),
    ]);
    const registry = normalizeAddress(facetRegistry?.[0]);
    const manager = normalizeAddress(portfolioManager?.[0]);
    const configAddr = normalizeAddress(config?.[0]);
    const portfolioCount = portfolioLength?.[0] === undefined
      ? (Array.isArray(portfolios?.[0]) ? portfolios[0].length : null)
      : Number(portfolioLength[0]);
    const registryVersion = registry ? await safeCall(rpc, registry, REGISTRY, "getVersion") : null;
    const selectorFacets = {};
    for (const [name, sel] of Object.entries(SELECTORS)) {
      const facet = registry ? await safeCall(rpc, registry, REGISTRY, "getFacetForSelector", [sel]) : null;
      selectorFacets[name] = nonZeroAddress(facet?.[0]);
    }
    const harvestFacet = selectorFacets.harvestLpFees;
    let harvestFacetMeta = null;
    if (harvestFacet) {
      const facetCode = await getCode(rpc, harvestFacet);
      const principalString = Buffer.from("Would remove principal", "utf8").toString("hex");
      const debtString = Buffer.from("Debt exceeds max loan", "utf8").toString("hex");
      harvestFacetMeta = {
        facet: harvestFacet,
        codePresent: Boolean(facetCode && facetCode !== "0x"),
        runtimeCodeHash: facetCode && facetCode !== "0x" ? ethers.keccak256(facetCode) : null,
        containsWouldRemovePrincipalString: Boolean(facetCode && facetCode.toLowerCase().includes(principalString.toLowerCase())),
        containsDebtExceedsMaxLoanString: Boolean(facetCode && facetCode.toLowerCase().includes(debtString.toLowerCase())),
        patchStatus: facetCode && facetCode.toLowerCase().includes(principalString.toLowerCase()) ? "facet-bytecode-has-principal-guard-string" : "library-linked-or-unproven-from-facet-bytecode",
      };
    }
    const linkedVault = vaultRows.find((vault) => vault.chainId === row.chainId && lowerAddress(vault.portfolioFactory) === lowerAddress(row.address))
      || vaultRows.find((vault) => vault.chainId === row.chainId && vault.platform === row.platform);
    rows.push({
      chain: row.chain,
      chainId: row.chainId,
      platform: row.platform,
      role: row.role,
      factory: row.address,
      source: row.source,
      patchSurface: Boolean(row.patchSurface || row.platform === "yieldbasis-eth" || selectorFacets.harvestLpFees),
      portfolioManager: manager,
      config: configAddr,
      facetRegistry: registry,
      registryVersion: registryVersion?.[0] === undefined ? null : Number(registryVersion[0]),
      portfolioCount,
      selectorFacets,
      harvestFacetMeta,
      linkedVault: linkedVault?.vault || null,
      linkedAsset: linkedVault?.asset || null,
      linkedAssetSymbol: linkedVault?.assetSymbol || null,
      linkedAssetDecimals: linkedVault?.assetDecimals ?? null,
      linkedAssetPriceUsd: linkedVault?.priceUsd ?? null,
    });
  }
  return rows;
}

async function sampleFactoryPortfolios(factoryRows, managerRows, rpcPool) {
  const rows = [];
  for (const factory of factoryRows.filter((row) => row.selectorFacets?.getAvailableLpFeeYield || row.selectorFacets?.getDepositInfo)) {
    const rpc = rpcPool[factory.chainId];
    if (!rpc) continue;
    const portfoliosCall = await safeCall(rpc, factory.factory, FACTORY, "getAllPortfolios", [], 20_000);
    const portfolios = Array.isArray(portfoliosCall?.[0]) ? portfoliosCall[0].map(normalizeAddress).filter(Boolean) : [];
    const sample = portfolios.slice(0, MAX_PORTFOLIOS_PER_FACTORY);
    let withDeposit = 0;
    let withYield = 0;
    let withDebt = 0;
    let totalYield = 0;
    let maxYield = 0;
    let totalDebt = 0;
    let maxDebt = 0;
    let maxDepositValue = 0;
    const assetDecimals = factory.linkedAssetDecimals ?? 18;
    const priceUsd = asNumber(factory.linkedAssetPriceUsd);
    for (const portfolio of sample) {
      const [yieldResult, depositInfo, debtResult] = await Promise.all([
        safeCall(rpc, portfolio, PORTFOLIO, "getAvailableLpFeeYield"),
        safeCall(rpc, portfolio, PORTFOLIO, "getDepositInfo"),
        factory.linkedVault ? safeCall(rpc, factory.linkedVault, VAULT, "getDebtBalance", [portfolio]) : Promise.resolve(null),
      ]);
      const yieldUnderlying = yieldResult?.[0] === undefined ? null : unitsToNumber(yieldResult[0], assetDecimals);
      const deposited = depositInfo?.[1] === undefined ? null : unitsToNumber(depositInfo[1], assetDecimals);
      const debt = debtResult?.[0] === undefined ? null : unitsToNumber(debtResult[0], assetDecimals);
      if ((deposited || 0) > 0) withDeposit++;
      if ((yieldUnderlying || 0) > 0) { withYield++; totalYield += yieldUnderlying; maxYield = Math.max(maxYield, yieldUnderlying); }
      if ((debt || 0) > 0) { withDebt++; totalDebt += debt; maxDebt = Math.max(maxDebt, debt); }
      if ((deposited || 0) > 0) maxDepositValue = Math.max(maxDepositValue, deposited);
    }
    const manager = managerRows.find((row) => row.chainId === factory.chainId && lowerAddress(row.manager) === lowerAddress(factory.portfolioManager));
    rows.push({
      chain: factory.chain,
      chainId: factory.chainId,
      platform: factory.platform,
      factory: factory.factory,
      portfoliosDiscovered: portfolios.length,
      portfoliosSampled: sample.length,
      portfoliosWithDeposit: withDeposit,
      portfoliosWithYield: withYield,
      portfoliosWithDebt: withDebt,
      totalSampleYield: round(totalYield, 8),
      totalSampleYieldUsd: round(priceUsd ? totalYield * priceUsd : null, 2),
      maxSampleYield: round(maxYield, 8),
      maxSampleYieldUsd: round(priceUsd ? maxYield * priceUsd : null, 2),
      totalSampleDebt: round(totalDebt, 8),
      totalSampleDebtUsd: round(priceUsd ? totalDebt * priceUsd : null, 2),
      maxSampleDebt: round(maxDebt, 8),
      maxSampleDebtUsd: round(priceUsd ? maxDebt * priceUsd : null, 2),
      maxSampleDepositedValue: round(maxDepositValue, 8),
      maxSampleDepositedValueUsd: round(priceUsd ? maxDepositValue * priceUsd : null, 2),
      portfolioManagerAuthorizedSelf: manager?.portfolioManagerAuthorizedSelf ?? null,
      callableByPortfolioOwnerViaManager: Boolean(manager?.portfolioManagerAuthorizedSelf),
      persistedBorrowerAddresses: 0,
    });
  }
  return rows;
}

function rowMentions40Acres(value) {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return /40\s*acres|40acres|cd7079e32bf53093f60bf973c28e5d72937c12f2|3623567972ad7f44242ec354a38bdbacfc73aa42|5a9d6722994ef06612d27054ffef365e8e61ad6c7|c2e639ca5fcb8583bd9c85b07e21919850390f05/i.test(String(value));
  return Object.entries(value).some(([key, child]) => rowMentions40Acres(key) || rowMentions40Acres(child));
}

function shallowPendleRow(row) {
  return {
    protocol: row.protocol || "Pendle",
    category: row.category || null,
    chain: row.chain || null,
    chainId: row.chainId || null,
    marketName: row.marketName || null,
    market: row.market || null,
    pt: row.pt || null,
    yt: row.yt || null,
    sy: row.sy || null,
    underlyingAsset: row.underlyingAsset || null,
    symbol: row.symbol || null,
    expiry: row.expiry || null,
    liquidityUsdHint: round(row.liquidityUsdHint, 2),
    impliedApy: round(row.impliedApy, 8),
    ptPriceUsd: round(row.ptPriceUsd, 8),
    syPriceUsd: round(row.syPriceUsd, 8),
    blocker: row.blocker || null,
    routePositive: Boolean(row.routePositive),
  };
}

function collectPendleRows() {
  const files = [
    "reports/raw/fast/pendle-pt-multichain-consumer-graph.json",
    "reports/raw/fast/pendle-yt-collateral-routes.json",
  ];
  const rows = [];
  for (const rel of files) {
    const json = readJson(path.join(WORKSPACE, rel), null);
    const candidates = [];
    function walk(value) {
      if (!value) return;
      if (Array.isArray(value)) { for (const item of value) walk(item); return; }
      if (typeof value !== "object") return;
      const ownText = [value.marketName, value.symbol, value.sySymbol, value.underlyingAsset, value.pt, value.yt, value.sy]
        .filter(Boolean).join(" ");
      if (rowMentions40Acres(ownText)) candidates.push(value);
      for (const child of Object.values(value)) if (typeof child === "object") walk(child);
    }
    walk(json);
    for (const row of candidates.slice(0, 20)) rows.push({ artifact: rel, ...shallowPendleRow(row) });
  }
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.artifact}:${row.market || row.pt || row.yt || row.sy}:${row.category}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceCommit() {
  if (!fs.existsSync(path.join(TARGET_DIR, ".git"))) return null;
  const child = spawnSync("git", ["-C", TARGET_DIR, "log", "--oneline", "-1"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  return child.status === 0 ? safeText(child.stdout, 180) : null;
}

function classifyYieldBasisRisk(factoryRows, managerRows, portfolioSampleRows) {
  const rows = [];
  for (const factory of factoryRows.filter((row) => row.selectorFacets?.harvestLpFees)) {
    const manager = managerRows.find((row) => row.chainId === factory.chainId && lowerAddress(row.manager) === lowerAddress(factory.portfolioManager));
    const sample = portfolioSampleRows.find((row) => row.chainId === factory.chainId && lowerAddress(row.factory) === lowerAddress(factory.factory));
    const hasPrincipalGuardString = factory.harvestFacetMeta?.containsWouldRemovePrincipalString === true;
    const callableByOwner = manager?.portfolioManagerAuthorizedSelf === true;
    const currentSampleYieldUsd = asNumber(sample?.totalSampleYieldUsd) || 0;
    const currentSampleDebtUsd = asNumber(sample?.totalSampleDebtUsd) || 0;
    const watchCandidate = !hasPrincipalGuardString && callableByOwner && (currentSampleYieldUsd > 0 || currentSampleDebtUsd > MATERIAL_USD);
    rows.push({
      chain: factory.chain,
      chainId: factory.chainId,
      platform: factory.platform,
      factory: factory.factory,
      facetRegistry: factory.facetRegistry,
      harvestFacet: factory.selectorFacets.harvestLpFees,
      patchStatus: factory.harvestFacetMeta?.patchStatus || "no-bytecode-proof",
      containsWouldRemovePrincipalString: hasPrincipalGuardString,
      portfolioManagerAuthorizedSelf: manager?.portfolioManagerAuthorizedSelf ?? null,
      callableByPortfolioOwnerViaManager: callableByOwner,
      portfoliosSampled: sample?.portfoliosSampled || 0,
      portfoliosWithYield: sample?.portfoliosWithYield || 0,
      currentSampleYieldUsd: round(currentSampleYieldUsd, 2),
      currentSampleDebtUsd: round(currentSampleDebtUsd, 2),
      watchCandidate,
      routePositive: false,
      blocker: watchCandidate
        ? "Potential old YieldBasis harvest accounting needs fork proof and exact capital/liquidity economics; read-only pass cannot prove live exploit"
        : "Harvest path is authorized-caller gated and no permissionless exact-positive route is proven",
    });
  }
  return rows;
}

function writeReport(out) {
  const s = out.summary;
  const registryTable = out.contractRows.slice(0, 18).map((row) => `| ${row.chain} | ${row.platform || "?"} | ${row.role || "?"} | ${compactAddress(row.address)} | ${row.codePresent} | ${compactAddress(row.eip1967Implementation)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a |";
  const vaultTable = out.vaultRows.map((row) => `| ${row.chain} | ${row.platform || "?"} | ${compactAddress(row.vault)} | ${row.assetSymbol || "?"} | ${formatUsd(row.liquidAssetsUsd)} | ${formatUsd(row.activeAssetsUsd)} | ${formatUsd(row.totalAssetsUsd)} | ${row.paused ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const factoryTable = out.factoryRows.slice(0, 14).map((row) => `| ${row.chain} | ${row.platform || "?"} | ${compactAddress(row.factory)} | ${row.portfolioCount ?? "n/a"} | ${compactAddress(row.selectorFacets?.harvestLpFees)} | ${row.harvestFacetMeta?.patchStatus || "n/a"} | ${row.patchSurface} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const sampleTable = out.portfolioSampleRows.map((row) => `| ${row.chain} | ${row.platform || "?"} | ${row.portfoliosDiscovered} | ${row.portfoliosSampled} | ${row.portfoliosWithYield} | ${formatUsd(row.totalSampleYieldUsd)} | ${row.portfoliosWithDebt} | ${formatUsd(row.totalSampleDebtUsd)} | ${row.callableByPortfolioOwnerViaManager} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const ybTable = out.yieldBasisRiskRows.map((row) => `| ${row.chain} | ${row.platform || "?"} | ${compactAddress(row.harvestFacet)} | ${row.patchStatus} | ${row.callableByPortfolioOwnerViaManager} | ${row.portfoliosWithYield} | ${formatUsd(row.currentSampleYieldUsd)} | ${row.watchCandidate} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const pendleTable = out.pendleRows.map((row) => `| ${row.category || "?"} | ${row.chain || "?"} | ${row.marketName || "?"} | ${row.symbol || "?"} | ${formatUsd(row.liquidityUsdHint)} | ${formatPct((asNumber(row.impliedApy) || 0) * 100)} | ${row.blocker || "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";

  const content = `# ${SIGNAL_DORMANT} - 40 Acres Phase 0 Triage

Generated: ${out.generatedAt}

Scanner: \`tools/scan-40acres-phase0.js\`

Artifact: \`reports/raw/fast/40acres-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This bounded pass mapped 40 Acres public adapter contracts, the source address registry, live vault/borrow state, portfolio-manager authorization gates, the fresh YieldBasis LP-harvest patch surface, and existing Pendle 40acresUSDC context. The high-signal YieldBasis branch is still not fork-gated because \`harvestLpFees\` is authorized-caller gated, live patch status cannot be fully proven from read-only facet bytecode when linked libraries are involved, and no current exact-positive borrow/harvest/unwind route is proven.

## Summary

| Metric | Value |
|---|---:|
| DeFiLlama TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Base TVL | ${formatUsd(s.baseTvlUsd)} |
| Optimism TVL | ${formatUsd(s.optimismTvlUsd)} |
| Avalanche TVL | ${formatUsd(s.avalancheTvlUsd)} |
| DeFiLlama borrowed | ${formatUsd(s.defillamaBorrowedUsd)} |
| Contracts checked | \`${s.contractRows}\` |
| Contracts with code | \`${s.contractRowsWithCode}\` |
| Vault rows | \`${s.vaultRows}\` |
| Borrow rows | \`${s.loanRows}\` |
| Factories checked | \`${s.factoryRows}\` |
| YieldBasis harvest selector rows | \`${s.yieldBasisHarvestRows}\` |
| Portfolio samples | \`${s.portfoliosSampled}\` |
| Sample yield | ${formatUsd(s.sampleYieldUsd)} |
| Sample debt | ${formatUsd(s.sampleDebtUsd)} |
| Pendle 40acres rows | \`${s.pendleRows}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |

## Source / Patch Context

- Local source commit: \`${out.sourceCommit || "unavailable"}\`.
- The latest public source includes a YieldBasis LP-fee harvest principal-leak fix that holds \`depositedAssetValue\` fixed and re-checks \`Would remove principal\` after burning surplus shares.
- This scanner treats that as a high-signal residual branch only if a live harvest selector exists, the portfolio manager is authorized as a caller, and sampled debt/yield is material. No such branch is route-positive in this pass.

## Contract Map

| Chain | Platform | Role | Address | Code | EIP-1967 impl |
|---|---|---|---|---:|---|
${registryTable}

## Vault / Borrow State

| Chain | Platform | Vault | Asset | Liquid assets | Active borrowed | Total assets | Paused |
|---|---|---|---|---:|---:|---:|---:|
${vaultTable}

## Factory / Facet Surface

| Chain | Platform | Factory | Portfolios | Harvest facet | Patch bytecode check | Patch surface |
|---|---|---|---:|---|---|---:|
${factoryTable}

## Portfolio Sample Aggregates

Portfolio/borrower addresses were used only in memory for aggregate sampling and were not written to the artifact.

| Chain | Platform | Discovered | Sampled | With yield | Sample yield | With debt | Sample debt | Owner-call harvest via manager |
|---|---|---:|---:|---:|---:|---:|---:|---:|
${sampleTable}

## YieldBasis Residual Rows

| Chain | Platform | Harvest facet | Patch status | Owner-callable via manager | Yield portfolios | Sample yield | Watch |
|---|---|---|---|---:|---:|---:|---:|
${ybTable}

## Pendle Context

| Category | Chain | Market | Symbol | Liquidity hint | Implied APY | Blocker |
|---|---|---|---|---:|---:|---|
${pendleTable}

## Blockers

- \`harvestLpFees\` is gated by the portfolio manager authorized-caller set; no permissionless third-party call path was proven.
- The public TVL adapter exposes collateral/vault balances and borrowed totals, not liquidation semantics with a current borrower route.
- Pendle PT/YT 40acresUSDC rows remain context-only with no current consumer-specific positive economics.
- No exact fork/static-call route demonstrates borrow, harvest, redeem, or unwind profit after gas, fees, slippage, and any capital lock.
`;

  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  ensureDir(RAW_OUT);
  const generatedAt = new Date().toISOString();
  const rpcPool = await resolveRpcPoolFast(CHAINS.map((row) => row.chainId));
  const metadata = await fetchMetadata();
  const registryRows = parseRegistryRows();
  const seedRows = uniqueAddressRows([...registryRows, ...ADAPTER_ROWS]);
  const contractRows = await probeAddressRows(seedRows, rpcPool);
  let vaultRows = await probeVaultRows(contractRows, rpcPool, {});
  let loanRows = await probeLoanRows(contractRows, rpcPool, {});
  const priceSeedRows = [
    ...seedRows.filter((row) => roleIncludes(row, ["basetoken", "venft"])),
    ...vaultRows.map((row) => ({ chainId: row.chainId, address: row.asset })),
    ...loanRows.map((row) => ({ chainId: row.chainId, address: row.asset })),
  ].filter((row) => normalizeAddress(row.address));
  const prices = await fetchPrices(priceSeedRows);
  vaultRows = await probeVaultRows(contractRows, rpcPool, prices);
  loanRows = await probeLoanRows(contractRows, rpcPool, prices);
  const managerRows = await probeManagerRows(contractRows, rpcPool);
  const factoryRows = await probeFactoryRows(contractRows, managerRows, vaultRows, rpcPool);
  const portfolioSampleRows = await sampleFactoryPortfolios(factoryRows, managerRows, rpcPool);
  const pendleRows = collectPendleRows();
  const yieldBasisRiskRows = classifyYieldBasisRisk(factoryRows, managerRows, portfolioSampleRows);

  const watchCandidates = yieldBasisRiskRows.filter((row) => row.watchCandidate).length;
  const routePositive = 0;
  const summary = {
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    baseTvlUsd: metadata.baseTvlUsd,
    optimismTvlUsd: metadata.optimismTvlUsd,
    avalancheTvlUsd: metadata.avalancheTvlUsd,
    defillamaBorrowedUsd: metadata.borrowedUsd,
    baseBorrowedUsd: metadata.baseBorrowedUsd,
    optimismBorrowedUsd: metadata.optimismBorrowedUsd,
    avalancheBorrowedUsd: metadata.avalancheBorrowedUsd,
    sourceRegistryRows: registryRows.length,
    contractRows: contractRows.length,
    contractRowsWithCode: contractRows.filter((row) => row.codePresent).length,
    vaultRows: vaultRows.length,
    loanRows: loanRows.length,
    vaultLiquidAssetsUsd: round(sum(vaultRows, "liquidAssetsUsd"), 2),
    vaultActiveAssetsUsd: round(sum(vaultRows, "activeAssetsUsd"), 2),
    loanActiveAssetsUsd: round(sum(loanRows, "activeAssetsUsd"), 2),
    managerRows: managerRows.length,
    factoryRows: factoryRows.length,
    yieldBasisHarvestRows: yieldBasisRiskRows.length,
    yieldBasisWatchRows: watchCandidates,
    portfoliosSampled: sum(portfolioSampleRows, "portfoliosSampled"),
    sampleYieldUsd: round(sum(portfolioSampleRows, "totalSampleYieldUsd"), 2),
    sampleDebtUsd: round(sum(portfolioSampleRows, "totalSampleDebtUsd"), 2),
    maxSampleYieldUsd: round(max(portfolioSampleRows, "maxSampleYieldUsd"), 2),
    maxSampleDebtUsd: round(max(portfolioSampleRows, "maxSampleDebtUsd"), 2),
    pendleRows: pendleRows.length,
    maxPendleLiquidityUsd: round(max(pendleRows, "liquidityUsdHint"), 2),
    watchCandidates,
    routePositive,
    executableNow: 0,
    signedActionJustified: false,
    coverageClassification: "bounded-with-caveats",
    status: routePositive > 0 ? "route-positive-needs-fork-proof" : watchCandidates > 0 ? "watch-needs-fork-and-exact-economics" : "closed-route-positive-zero",
  };

  const out = {
    generatedAt,
    scanner: "tools/scan-40acres-phase0.js",
    signal: SIGNAL_DORMANT,
    protocol: metadata,
    sourceCommit: sourceCommit(),
    sourcePatchContext: {
      latestSourceMentionsFix: true,
      patchSummary: "YieldBasis LP fee harvest principal leak fixed in source by holding depositedAssetValue fixed and checking Would remove principal.",
      livePatchStatusCaveat: "Facet bytecode string checks can miss linked-library guards; route status remains bounded until fork/static proof.",
    },
    summary,
    contractRows,
    vaultRows,
    loanRows,
    managerRows,
    factoryRows,
    portfolioSampleRows,
    yieldBasisRiskRows,
    pendleRows,
    safety: {
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
      persistedBorrowerAddresses: 0,
      liveExecutionTouched: false,
      secretsPrinted: false,
    },
    blockers: [
      "No permissionless third-party harvest/borrow route proven",
      "YieldBasis branch is authorized-caller gated and needs fork/static proof if live old accounting is suspected",
      "Pendle 40acresUSDC rows are route-negative context only",
      "No exact positive economics after gas/slippage/capital constraints",
    ],
  };

  fs.writeFileSync(RAW_OUT, JSON.stringify(out, jsonReplacer, 2));
  writeReport(out);
  if (!QUIET) {
    console.log(JSON.stringify({ generatedAt, summary }, null, 2));
    console.log(`Wrote ${path.relative(WORKSPACE, RAW_OUT)} and ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(`40 Acres Phase 0 failed: ${err.message}`);
  process.exit(1);
});
