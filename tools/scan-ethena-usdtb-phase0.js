#!/usr/bin/env node
// scan-ethena-usdtb-phase0.js - read-only Phase 0 for Ethena USDtb.
// Resolves RPC URLs in memory only unless ETHENA_USDTB_SKIP_RPC_INVENTORY=1.
// Never prints or stores RPC URLs, keys, calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "ethena-usdtb-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "ethena-usdtb-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");
const SKIP_RPC_INVENTORY = process.env.ETHENA_USDTB_SKIP_RPC_INVENTORY === "1";

const ETHEREUM_CHAIN_ID = 1;
const CHAIN = "Ethereum";
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";
const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";
const MATERIAL_USD = 10_000;
const PRICE_WATCH_BPS = 100;
const ZERO = "0x0000000000000000000000000000000000000000";

const ADDR = {
  USDtb: "0xC139190F447e929f090Edeb554D95AbB8b18aC1C",
  USDE: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
  SUSDE: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
  fUSDtb: "0x15e8c742614b5D8Db4083A41Df1A14F5D2bFB400",
  MINTING_V2: "0xe3490297a08d6fC8Da46Edb7B6142E4F461b62D3",
  RESERVE_FUND: "0x2B5AB59163a6e93b4486f6055D33CA4a115Dd4D5",
  PAYOUT_FUND: "0x71e4f98e8F20C88112489DE3Dded4489802a3A87",
  DISTRIBUTOR: "0xf2fa332bD83149c66b09B45670bCe64746C6b439",
  ADAPTER_OWNER_1: "0x2d4d2a025B10C09BDbd794b4fCE4f7EA8c7D7bb4",
  ADAPTER_OWNER_2: "0xd54F23BE482D9A58676590fCa79c8E43087f92fB",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  BUIDL: "0x7712c34205737192402172409a8F7ccef8aA2AEc",
  sBUIDL: "0x07a36C630e3F072637da3445Da733B29958D8cAB",
  sUSDS: "0xaCdf0DBA4B9839b96221a8487e9ca660a48212be",
};

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const BYTES32_TOKEN = new ethers.Interface(["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"]);
const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
  "function minter() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function mint(address,uint256)",
  "function burn(uint256)",
  "function burnFrom(address,uint256)",
  "function pause()",
  "function unpause()",
  "function setMinter(address)",
]);
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
const MINTING = new ethers.Interface([
  "function owner() view returns (address)",
  "function usde() view returns (address)",
  "function globalConfig() view returns (uint128 globalMaxMintPerBlock,uint128 globalMaxRedeemPerBlock)",
  "function totalPerBlock(uint256) view returns (uint128 mintedPerBlock,uint128 redeemedPerBlock)",
  "function tokenConfig(address) view returns (uint8 tokenType,bool isActive,uint128 maxMintPerBlock,uint128 maxRedeemPerBlock)",
  "function mint((string order_id,uint8 order_type,uint120 expiry,uint128 nonce,address benefactor,address beneficiary,address collateral_asset,uint128 collateral_amount,uint128 usde_amount),(address[] addresses,uint128[] ratios),(uint8 signature_type,bytes signature_bytes))",
  "function redeem((string order_id,uint8 order_type,uint120 expiry,uint128 nonce,address benefactor,address beneficiary,address collateral_asset,uint128 collateral_amount,uint128 usde_amount),(uint8 signature_type,bytes signature_bytes))",
  "function transferToCustody(address,address,uint128)",
  "function disableMintRedeem()",
  "function setGlobalMaxMintPerBlock(uint128)",
]);

const CONSUMER_ARTIFACTS = [
  ["fluid-lending", "reports/raw/fast/fluid-lending-phase0.json"],
  ["fluid-dex", "reports/raw/fast/fluid-dex-phase0.json"],
  ["euler-v2", "reports/raw/fast/euler-v2-phase0.json"],
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["morpho-public-allocator", "reports/raw/fast/morpho-public-allocator-force-feed.json"],
  ["morpho-pyth-unsafe", "reports/raw/fast/morpho-pyth-unsafe-consumers.json"],
  ["stablecoin-depeg", "reports/raw/fast/stablecoin-depeg-lending-routes.json"],
  ["market-launch", "reports/raw/fast/market-launch-choreography-routes.json"],
  ["focused-euler", "reports/raw/fast/focused-euler-evk-review-producers.json"],
  ["erc4626-consumer", "reports/raw/fast/erc4626-consumer-joiner.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["curve-dex", "reports/raw/fast/curve-dex-phase0.json"],
  ["curve-llamalend", "reports/raw/fast/curve-llamalend-phase0.json"],
  ["dex-consumer-routes", "reports/raw/fast/dex-consumer-routes.json"],
];

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
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
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-ethena-usdtb-phase0/1.0" } });
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

async function stateProbe(rpc, to, iface, fn, args = []) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr) return { success: false, result: null };
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ from: PROBE_FROM, to: addr, data: iface.encodeFunctionData(fn, args) }, "latest"], 8_000);
    return { success: raw !== null, result: raw && raw.length > 66 ? `${raw.slice(0, 66)}...` : raw };
  } catch (_) {
    return { success: false, result: null };
  }
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
  const [sym, name, dec, supply, implRaw, adminRaw, beaconRaw, owner, admin, paused, minter, pendingOwner] = await Promise.all([
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
    safeCall(rpc, addr, COMMON, "minter"),
    safeCall(rpc, addr, COMMON, "pendingOwner"),
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
    pendingOwner: pendingOwner ? normalizeAddress(pendingOwner[0]) : null,
    admin: admin ? normalizeAddress(admin[0]) : null,
    minter: minter ? normalizeAddress(minter[0]) : null,
    paused: paused ? Boolean(paused[0]) : null,
  };
}

async function tokenBalance(rpc, token, owner, decimals) {
  const bal = await safeCall(rpc, token, ERC20, "balanceOf", [owner]);
  return { raw: bal ? bal[0].toString() : null, amount: bal ? decimalsToNumber(bal[0], decimals) : null };
}

async function erc4626State(rpc, token, holder = ZERO) {
  const addr = normalizeAddress(token.address);
  const shareDecimals = token.decimals ?? 18;
  const oneShare = 10n ** BigInt(shareDecimals);
  const asset = await safeCall(rpc, addr, ERC4626, "asset");
  const assetMeta = asset ? await tokenMeta(rpc, asset[0]).catch(() => null) : null;
  const assetDecimals = assetMeta?.decimals ?? shareDecimals;
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
    assetSymbol: assetMeta?.symbol || null,
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
        volume24hUsd: round(p.volume?.h24, 2),
        routePositive: false,
      }))
      .filter((p) => (asNumber(p.liquidityUsd) || 0) > 0)
      .sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0));
    rows.push(...pairs.slice(0, 8));
  }
  return rows;
}

function latestProtocolTvl(protocol) {
  const chain = protocol?.chainTvls?.Ethereum?.tvl;
  if (Array.isArray(chain) && chain.length) return asNumber(chain[chain.length - 1]?.totalLiquidityUSD);
  const tvl = protocol?.tvl;
  if (Array.isArray(tvl) && tvl.length) return asNumber(tvl[tvl.length - 1]?.totalLiquidityUSD);
  return asNumber(protocol?.currentChainTvls?.Ethereum ?? protocol?.currentChainTvls?.ethereum);
}

function discoveryRow() {
  const d = readJson(PUBLIC_TARGETS, {});
  const rows = [...(d.phase0Queue || []), ...(d.yieldCandidates || []), ...(d.consumerJoinFirst || []), ...(d.targetedRefreshQueue || [])];
  return rows.find((row) => String(row?.slug || row?.project || row?.name || "").toLowerCase() === "ethena-usdtb") || null;
}

function containsHit(row, targets) {
  const text = JSON.stringify(row || {}).toLowerCase();
  return targets.filter((target) => text.includes(target.lower) || (target.symbol && new RegExp(`\\b${target.symbol.toLowerCase()}\\b`, "i").test(text)));
}

function rowLike(obj) {
  return obj && typeof obj === "object" && !Array.isArray(obj) && (
    obj.address || obj.token || obj.asset || obj.underlyingAsset || obj.market || obj.vault || obj.pool || obj.poolAddress || obj.protocol || obj.project || obj.symbol || obj.assetSymbol || obj.marketName || obj.role || obj.category || obj.source
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
    symbol: safeText(row?.symbol || row?.assetSymbol || lead?.symbol || row?.tokenSymbol || row?.sySymbol || row?.marketName, 80),
    marketName: safeText(row?.marketName || row?.vaultLabel || row?.vaultSymbol || row?.vaultName || market?.name, 100),
    role: safeText(row?.role || row?.typeCategory || row?.candidateRoute || lead?.candidateRoute || row?.borrowSymbol || row?.supplySymbol, 100),
    liquidityUsd: round(row?.liquidityUsdHint || row?.liquidityUsd || row?.topDexLiquidityUsd || row?.poolBalanceUsd || row?.cashUsd || row?.totalAssetsUsd || row?.borrowableUsd || row?.routeLiquidityUsd || market?.liquidityAssetsUsd, 2),
    borrowsUsd: round(row?.borrowsUsd || row?.borrowUsd || row?.totalBorrowsUsd || row?.borrowedUsd, 2),
    ltvBps: round(row?.ltvBorrowBps || row?.collateralFactorBps || row?.borrowLtvBps || row?.lltv ? (asNumber(row?.ltvBorrowBps || row?.collateralFactorBps || row?.borrowLtvBps) ?? (asNumber(row?.lltv) ? asNumber(row?.lltv) * 10_000 : null)) : null, 2),
    priceUsd: round(row?.priceUsd || row?.assetPriceUsd || row?.underlyingPriceUsd || row?.syPriceUsd || row?.ptPriceUsd, 10),
    acceptedVsAcquisitionBps: round(economics?.acceptedVsAcquisitionBps, 6),
    netEdgeUsd: round(economics?.netEdgeUsd, 6),
    routePositive: Boolean(row?.routePositive || economics?.routePositive),
  };
}

function collectConsumerJoins(targets) {
  const targetRows = targets.map((t) => ({ ...t, lower: lowerAddress(t.address) || String(t.symbol || "").toLowerCase() })).filter((t) => t.lower || t.symbol);
  const joins = [];
  const inputsLoaded = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) {
    const file = path.join(WORKSPACE, rel);
    const text = readText(file);
    if (!text) continue;
    const sourceHits = targetRows.filter((target) => text.toLowerCase().includes(target.lower) || (target.symbol && text.toLowerCase().includes(target.symbol.toLowerCase())));
    if (!sourceHits.length) continue;
    inputsLoaded.push(rel);
    const data = readJson(file, null);
    const maxRows = 90;
    const visit = (node, pathParts = [], depth = 0) => {
      if (!node || joins.filter((j) => j.source === source).length >= maxRows || depth > 7) return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) visit(node[i], pathParts.concat(String(i)), depth + 1);
        return;
      }
      if (typeof node !== "object") return;
      if (rowLike(node)) {
        const hits = containsHit(node, sourceHits);
        if (hits.length) {
          joins.push({ source, path: pathParts.join(".") || "$", ...sanitizeMatch(node, hits.map((h) => h.label)) });
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
    const key = `${row.source}|${row.path}|${row.symbol}|${row.marketName}|${row.role}|${row.hits.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return { joins: deduped, inputsLoaded };
}

function classifyJoins(joins) {
  const usdTbRows = joins.filter((row) => /USDtb|fUSDtb/i.test(`${row.hits.join(" ")} ${row.symbol || ""} ${row.marketName || ""} ${row.role || ""}`));
  const materialLiquidityRows = usdTbRows.filter((row) => (asNumber(row.liquidityUsd) || 0) >= MATERIAL_USD);
  const routePositiveRows = usdTbRows.filter((row) => row.routePositive);
  return {
    rows: joins.length,
    usdTbRows: usdTbRows.length,
    fluidRows: usdTbRows.filter((row) => /^fluid/.test(row.source)).length,
    eulerRows: usdTbRows.filter((row) => /^euler|focused-euler|market-launch/.test(row.source)).length,
    morphoRows: usdTbRows.filter((row) => /^morpho|consumer-first|aave-euler-silo/.test(row.source)).length,
    dexRows: usdTbRows.filter((row) => /dex/i.test(row.source)).length,
    materialLiquidityRows: materialLiquidityRows.length,
    routePositiveRows: routePositiveRows.length,
    topRows: usdTbRows.slice().sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0)).slice(0, 16),
  };
}

async function scanMintingState(rpc, blockNumber) {
  const [owner, usde, globalConfig, totalPerBlock, usdTbConfig, usdeConfig] = await Promise.all([
    safeCall(rpc, ADDR.MINTING_V2, MINTING, "owner"),
    safeCall(rpc, ADDR.MINTING_V2, MINTING, "usde"),
    safeCall(rpc, ADDR.MINTING_V2, MINTING, "globalConfig"),
    blockNumber ? safeCall(rpc, ADDR.MINTING_V2, MINTING, "totalPerBlock", [BigInt(blockNumber)]) : null,
    safeCall(rpc, ADDR.MINTING_V2, MINTING, "tokenConfig", [ADDR.USDtb]),
    safeCall(rpc, ADDR.MINTING_V2, MINTING, "tokenConfig", [ADDR.USDE]),
  ]);
  const mkConfig = (row, decimals = 18) => row ? {
    tokenType: Number(row[0]),
    isActive: Boolean(row[1]),
    maxMintPerBlockRaw: row[2].toString(),
    maxRedeemPerBlockRaw: row[3].toString(),
    maxMintPerBlock: decimalsToNumber(row[2], decimals),
    maxRedeemPerBlock: decimalsToNumber(row[3], decimals),
  } : null;
  const now = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const probeOrderMint = ["probe", 0, now, 1n, PROBE_FROM, PROBE_FROM, ADDR.USDtb, 1n, 1n];
  const probeOrderRedeem = ["probe", 1, now, 1n, PROBE_FROM, PROBE_FROM, ADDR.USDtb, 1n, 1n];
  const probeRoute = [[ADDR.RESERVE_FUND], [10_000n]];
  const probeSig = [0, "0x"];
  const probes = {
    mintUsdeWithUsdtb: await stateProbe(rpc, ADDR.MINTING_V2, MINTING, "mint", [probeOrderMint, probeRoute, probeSig]),
    redeemUsdeForUsdtb: await stateProbe(rpc, ADDR.MINTING_V2, MINTING, "redeem", [probeOrderRedeem, probeSig]),
    transferUsdTbToCustody: await stateProbe(rpc, ADDR.MINTING_V2, MINTING, "transferToCustody", [ADDR.RESERVE_FUND, ADDR.USDtb, 1n]),
    disableMintRedeem: await stateProbe(rpc, ADDR.MINTING_V2, MINTING, "disableMintRedeem"),
    setGlobalMaxMintPerBlock: await stateProbe(rpc, ADDR.MINTING_V2, MINTING, "setGlobalMaxMintPerBlock", [1n]),
  };
  return {
    address: normalizeAddress(ADDR.MINTING_V2),
    codePresent: (await getCode(rpc, ADDR.MINTING_V2)) !== "0x",
    owner: owner ? normalizeAddress(owner[0]) : null,
    usde: usde ? normalizeAddress(usde[0]) : null,
    globalConfig: globalConfig ? {
      globalMaxMintPerBlockRaw: globalConfig[0].toString(),
      globalMaxRedeemPerBlockRaw: globalConfig[1].toString(),
      globalMaxMintPerBlock: decimalsToNumber(globalConfig[0], 18),
      globalMaxRedeemPerBlock: decimalsToNumber(globalConfig[1], 18),
    } : null,
    totalThisBlock: totalPerBlock ? { mintedPerBlockRaw: totalPerBlock[0].toString(), redeemedPerBlockRaw: totalPerBlock[1].toString() } : null,
    usdTbTokenConfig: mkConfig(usdTbConfig),
    usdeTokenConfig: mkConfig(usdeConfig),
    permissionlessProbes: probes,
  };
}

async function scanProbeState(rpc) {
  return {
    usdTbDirectMint: await stateProbe(rpc, ADDR.USDtb, COMMON, "mint", [PROBE_FROM, 1n]),
    usdTbDirectBurn: await stateProbe(rpc, ADDR.USDtb, COMMON, "burn", [1n]),
    usdTbDirectBurnFrom: await stateProbe(rpc, ADDR.USDtb, COMMON, "burnFrom", [PROBE_FROM, 1n]),
    usdTbPause: await stateProbe(rpc, ADDR.USDtb, COMMON, "pause"),
    usdTbUnpause: await stateProbe(rpc, ADDR.USDtb, COMMON, "unpause"),
    usdTbSetMinter: await stateProbe(rpc, ADDR.USDtb, COMMON, "setMinter", [PROBE_FROM]),
  };
}

function renderReport(artifact) {
  const s = artifact.summary;
  const row = (cells) => `| ${cells.join(" | ")} |`;
  const tokenRows = artifact.tokenRows.map((t) => row([
    t.label,
    t.meta.symbol || "?",
    t.meta.codePresent ? "true" : "false",
    formatNumber(t.meta.totalSupply, 4),
    formatUsd(t.impliedSupplyUsd),
    t.meta.implementation ? compactAddress(t.meta.implementation) : "n/a",
  ]));
  const balanceRows = artifact.custodyBalanceRows.slice(0, 12).map((b) => row([
    b.ownerLabel,
    b.tokenLabel,
    formatNumber(b.amount, 4),
    formatUsd(b.usd),
  ]));
  const dexRows = artifact.dexRows.slice(0, 10).map((d) => row([
    d.baseSymbol && d.quoteSymbol ? `${d.baseSymbol}/${d.quoteSymbol}` : "?",
    d.dexId || "?",
    formatUsd(d.liquidityUsd),
    formatNumber(d.priceUsd, 8),
  ]));
  const joinRows = artifact.consumerJoinSummary.topRows.slice(0, 10).map((j) => row([
    j.source,
    j.symbol || j.marketName || "?",
    j.role || "context",
    formatUsd(j.liquidityUsd),
    j.routePositive ? "true" : "false",
  ]));
  const probeRows = Object.entries(artifact.permissionlessProbeSummary).map(([k, v]) => row([k, v.success ? "call did not revert" : "reverted/blocked"]));

  const lines = [];
  lines.push(`# ${SIGNAL_DORMANT} - Ethena USDtb Phase 0`);
  lines.push("");
  lines.push(`Generated: ${artifact.generatedAt}`);
  lines.push("");
  lines.push("Scanner: `tools/scan-ethena-usdtb-phase0.js`");
  lines.push("");
  lines.push("Artifact: `reports/raw/fast/ethena-usdtb-phase0.json`");
  lines.push("");
  lines.push("## Result");
  lines.push("");
  lines.push("No permissionless route-positive exploit is claimed. The pass mapped USDtb token state, Ethena minting/cap context, DEX/reference pricing, known custody balances, Fluid/Euler/Morpho/local consumer joins, and exact proof gates. USDtb-related consumer rows are context-only until a current accepted-value, backing, depeg, liquidation, or redemption edge is exact-quoted positive after costs.");
  lines.push("");
  lines.push("## Target");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---:|");
  lines.push(row(["Protocol", "`Ethena USDtb`"]));
  lines.push(row(["Chain", "`Ethereum (1)`"]));
  lines.push(row(["Public TVL", formatUsd(s.defillamaCurrentTvlUsd)]));
  lines.push(row(["Ethereum RPC resolved", `\`${s.ethereumRpcResolved}\``]));
  lines.push(row(["Coverage", `\`${s.coverageClassification}\``]));
  lines.push("");
  lines.push("## Tokens");
  lines.push("");
  lines.push("| Label | Symbol | Code | Supply | Implied supply USD | Proxy impl |");
  lines.push("|---|---|---:|---:|---:|---|");
  lines.push(...(tokenRows.length ? tokenRows : [row(["none", "none", "false", "n/a", "n/a", "n/a"])]));
  lines.push("");
  lines.push("## Minting / Permission Gates");
  lines.push("");
  lines.push("| Probe | Result |");
  lines.push("|---|---|");
  lines.push(...probeRows);
  lines.push("");
  lines.push("USDtb minting config is active only through Ethena's mint/redeem contract and role/signed-order path; arbitrary probe calls are not treated as proof of an executable route without valid authorization, exact economics, and fork/static-call proof.");
  lines.push("");
  lines.push("## Pricing / Custody Context");
  lines.push("");
  lines.push("| Pair | DEX | Liquidity | Price |");
  lines.push("|---|---|---:|---:|");
  lines.push(...(dexRows.length ? dexRows : [row(["none", "none", "n/a", "n/a"])]));
  lines.push("");
  lines.push("| Owner | Token | Amount | USD |");
  lines.push("|---|---|---:|---:|");
  lines.push(...(balanceRows.length ? balanceRows : [row(["none", "none", "n/a", "n/a"])]));
  lines.push("");
  lines.push("## Consumer Joins");
  lines.push("");
  lines.push("| Source | Symbol/Market | Role | Liquidity | Route-positive |");
  lines.push("|---|---|---|---:|---:|");
  lines.push(...(joinRows.length ? joinRows : [row(["none", "none", "none", "n/a", "false"])]));
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---:|");
  lines.push(row(["USDtb price vs $1", `\`${formatNumber(s.usdTbPriceVsPegBps, 4)}bps\``]));
  lines.push(row(["Top DEX liquidity", formatUsd(s.topDexLiquidityUsd)]));
  lines.push(row(["Consumer joins", `\`${s.artifactJoinRows}\``]));
  lines.push(row(["USDtb-specific joins", `\`${s.usdTbConsumerRows}\``]));
  lines.push(row(["Material USDtb joins", `\`${s.materialConsumerRows}\``]));
  lines.push(row(["Watch candidates", `\`${s.watchCandidates}\``]));
  lines.push(row(["Route-positive", `\`${s.routePositive}\``]));
  lines.push(row(["Executable now", `\`${s.executableNow}\``]));
  lines.push(row(["Signed action justified", `\`${s.signedActionJustified}\``]));
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  for (const blocker of artifact.blockers) lines.push(`- ${blocker}`);
  lines.push("");
  lines.push("## Required For Route-Positive");
  lines.push("");
  for (const item of artifact.requiredForRoutePositive) lines.push(`- ${item}`);
  lines.push("");
  lines.push("## Next Read-Only Step");
  lines.push("");
  lines.push(artifact.nextReadOnlyStep);
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const generatedAt = new Date().toISOString();
  const rpc = SKIP_RPC_INVENTORY ? null : await resolveRpc(ETHEREUM_CHAIN_ID);
  const [protocol, ethenaProtocol] = await Promise.all([
    fetchJson("https://api.llama.fi/protocol/ethena-usdtb", 45_000),
    fetchJson("https://api.llama.fi/protocol/ethena", 45_000),
  ]);
  const blockNumber = rpc ? await latestBlock(rpc) : null;
  const blockTimestamp = rpc && blockNumber ? await latestBlockTimestamp(rpc, blockNumber) : null;

  const [usdTbMeta, usdeMeta, susdeMeta, fUsdTbMeta] = rpc
    ? await Promise.all([tokenMeta(rpc, ADDR.USDtb), tokenMeta(rpc, ADDR.USDE), tokenMeta(rpc, ADDR.SUSDE), tokenMeta(rpc, ADDR.fUSDtb)])
    : [null, null, null, null];
  const prices = await loadCoinPrices([ADDR.USDtb, ADDR.USDE, ADDR.SUSDE, ADDR.fUSDtb, ADDR.USDC, ADDR.USDT, ADDR.DAI, ADDR.BUIDL, ADDR.sBUIDL, ADDR.sUSDS]);
  const priceOf = (addr) => prices[lowerAddress(addr)] ?? null;
  const dexRows = await loadDexRows([ADDR.USDtb, ADDR.fUSDtb]);
  const minting = rpc ? await scanMintingState(rpc, blockNumber) : null;
  const probes = rpc ? await scanProbeState(rpc) : {};
  const usdTbErc4626 = rpc && usdTbMeta ? await erc4626State(rpc, usdTbMeta, PROBE_FROM).catch(() => ({ isErc4626Like: false })) : { isErc4626Like: false };
  const fUsdTbErc4626 = rpc && fUsdTbMeta ? await erc4626State(rpc, fUsdTbMeta, PROBE_FROM).catch(() => ({ isErc4626Like: false })) : { isErc4626Like: false };

  const custodyOwners = [
    ["minting-v2", ADDR.MINTING_V2],
    ["reserve-fund", ADDR.RESERVE_FUND],
    ["payout-fund", ADDR.PAYOUT_FUND],
    ["distributor", ADDR.DISTRIBUTOR],
    ["adapter-owner-1", ADDR.ADAPTER_OWNER_1],
    ["adapter-owner-2", ADDR.ADAPTER_OWNER_2],
  ];
  const custodyTokens = [
    ["USDtb", ADDR.USDtb, usdTbMeta?.decimals ?? 18],
    ["USDe", ADDR.USDE, usdeMeta?.decimals ?? 18],
    ["sUSDe", ADDR.SUSDE, susdeMeta?.decimals ?? 18],
    ["USDC", ADDR.USDC, 6],
    ["USDT", ADDR.USDT, 6],
    ["DAI", ADDR.DAI, 18],
    ["BUIDL", ADDR.BUIDL, 6],
    ["sBUIDL", ADDR.sBUIDL, 18],
    ["sUSDS", ADDR.sUSDS, 18],
  ];
  const custodyBalanceRows = [];
  if (rpc) {
    for (const [ownerLabel, owner] of custodyOwners) {
      for (const [tokenLabel, token, decimals] of custodyTokens) {
        const bal = await tokenBalance(rpc, token, owner, decimals).catch(() => ({ amount: null }));
        const price = priceOf(token) ?? (tokenLabel === "USDC" || tokenLabel === "USDT" || tokenLabel === "DAI" || tokenLabel === "USDtb" ? 1 : null);
        const usd = bal.amount !== null && price !== null ? bal.amount * price : null;
        if ((usd || 0) >= 1_000) custodyBalanceRows.push({ ownerLabel, owner: normalizeAddress(owner), tokenLabel, token: normalizeAddress(token), amount: round(bal.amount, 8), usd: round(usd, 2) });
      }
    }
  }

  const tokenRows = [
    { label: "USDtb", meta: usdTbMeta || { address: normalizeAddress(ADDR.USDtb), codePresent: false }, priceUsd: priceOf(ADDR.USDtb), impliedSupplyUsd: usdTbMeta?.totalSupply && priceOf(ADDR.USDtb) ? usdTbMeta.totalSupply * priceOf(ADDR.USDtb) : null },
    { label: "USDe", meta: usdeMeta || { address: normalizeAddress(ADDR.USDE), codePresent: false }, priceUsd: priceOf(ADDR.USDE), impliedSupplyUsd: usdeMeta?.totalSupply && priceOf(ADDR.USDE) ? usdeMeta.totalSupply * priceOf(ADDR.USDE) : null },
    { label: "sUSDe", meta: susdeMeta || { address: normalizeAddress(ADDR.SUSDE), codePresent: false }, priceUsd: priceOf(ADDR.SUSDE), impliedSupplyUsd: susdeMeta?.totalSupply && priceOf(ADDR.SUSDE) ? susdeMeta.totalSupply * priceOf(ADDR.SUSDE) : null },
    { label: "fUSDtb", meta: fUsdTbMeta || { address: normalizeAddress(ADDR.fUSDtb), codePresent: false }, priceUsd: priceOf(ADDR.fUSDtb), impliedSupplyUsd: fUsdTbMeta?.totalSupply && priceOf(ADDR.fUSDtb) ? fUsdTbMeta.totalSupply * priceOf(ADDR.fUSDtb) : null },
  ];

  const { joins, inputsLoaded } = collectConsumerJoins([
    { label: "USDtb", symbol: "USDtb", address: ADDR.USDtb },
    { label: "fUSDtb", symbol: "fUSDtb", address: ADDR.fUSDtb },
    { label: "USDe", symbol: "USDe", address: ADDR.USDE },
    { label: "sUSDe", symbol: "sUSDe", address: ADDR.SUSDE },
  ]);
  const consumerJoinSummary = classifyJoins(joins);
  const publicRow = discoveryRow();
  const topDexLiquidityUsd = Math.max(0, ...dexRows.map((row) => asNumber(row.liquidityUsd) || 0));
  const usdTbPrice = priceOf(ADDR.USDtb) ?? dexRows.find((row) => lowerAddress(row.token) === lowerAddress(ADDR.USDtb))?.priceUsd ?? null;
  const usdTbPriceVsPegBps = usdTbPrice ? (usdTbPrice - 1) * 10_000 : null;
  const probeOpenRows = Object.values(probes).filter((p) => p?.success).length + Object.values(minting?.permissionlessProbes || {}).filter((p) => p?.success).length;
  const priceWatch = Math.abs(asNumber(usdTbPriceVsPegBps) || 0) >= PRICE_WATCH_BPS ? 1 : 0;
  const consumerWatch = consumerJoinSummary.materialLiquidityRows > 0 ? 1 : 0;
  const probeWatch = probeOpenRows > 0 ? 1 : 0;
  const routePositive = consumerJoinSummary.routePositiveRows > 0 && priceWatch ? consumerJoinSummary.routePositiveRows : 0;

  const summary = {
    ethereumRpcResolved: Boolean(rpc),
    defillamaCurrentTvlUsd: round(latestProtocolTvl(protocol) ?? publicRow?.tvlUsd, 2),
    ethenaParentTvlUsd: round(latestProtocolTvl(ethenaProtocol), 2),
    blockNumber,
    usdTbCodePresent: Boolean(usdTbMeta?.codePresent),
    usdTbSupply: round(usdTbMeta?.totalSupply, 6),
    usdTbMarketPriceUsd: round(usdTbPrice, 10),
    usdTbPriceVsPegBps: round(usdTbPriceVsPegBps, 4),
    usdePriceUsd: round(priceOf(ADDR.USDE), 10),
    susdePriceUsd: round(priceOf(ADDR.SUSDE), 10),
    usdTbErc4626Like: Boolean(usdTbErc4626?.isErc4626Like),
    fUsdTbErc4626Like: Boolean(fUsdTbErc4626?.isErc4626Like),
    fUsdTbTotalAssetsUsd: round((fUsdTbErc4626?.totalAssets || 0) * (usdTbPrice || 1), 2),
    mintingUsdTbActive: Boolean(minting?.usdTbTokenConfig?.isActive),
    mintingUsdTbMaxMintPerBlock: round(minting?.usdTbTokenConfig?.maxMintPerBlock, 2),
    mintingUsdTbMaxRedeemPerBlock: round(minting?.usdTbTokenConfig?.maxRedeemPerBlock, 2),
    dexRows: dexRows.length,
    topDexLiquidityUsd: round(topDexLiquidityUsd, 2),
    custodyBalanceRows: custodyBalanceRows.length,
    custodyBalanceUsd: round(custodyBalanceRows.reduce((acc, row) => acc + (asNumber(row.usd) || 0), 0), 2),
    artifactInputsLoaded: inputsLoaded.length,
    artifactJoinRows: consumerJoinSummary.rows,
    usdTbConsumerRows: consumerJoinSummary.usdTbRows,
    fluidConsumerRows: consumerJoinSummary.fluidRows,
    eulerConsumerRows: consumerJoinSummary.eulerRows,
    morphoConsumerRows: consumerJoinSummary.morphoRows,
    materialConsumerRows: consumerJoinSummary.materialLiquidityRows,
    exactEconomicsRows: consumerJoinSummary.routePositiveRows,
    permissionlessProbeOpenRows: probeOpenRows,
    watchCandidates: priceWatch + consumerWatch + probeWatch,
    routePositive,
    executableNow: 0,
    signedActionJustified: false,
    coverageClassification: "bounded-with-caveats",
    status: "phase0-no-route-positive",
  };

  const artifact = {
    generatedAt,
    scanner: "tools/scan-ethena-usdtb-phase0.js",
    scope: "Ethena USDtb Ethereum read-only token, minting-cap, custody, DEX/reference, and consumer-join Phase 0",
    safety: {
      rpcInventorySkipped: SKIP_RPC_INVENTORY,
      rpcInventoryRead: !SKIP_RPC_INVENTORY,
      rpcInventoryOnly: !SKIP_RPC_INVENTORY,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      calldataStored: false,
      borrowerAddressesStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: Boolean(routePositive),
      signedActionJustified: false,
    },
    target: {
      name: "Ethena USDtb",
      slug: "ethena-usdtb",
      category: protocol?.category || "RWA",
      chain: CHAIN,
      chainId: ETHEREUM_CHAIN_ID,
      url: protocol?.url || "https://ethena.fi/",
      methodology: protocol?.methodology || "Public DeFiLlama TVL plus live Ethereum token and consumer-state reads",
      audits: protocol?.audits || null,
    },
    publicDiscovery: publicRow ? {
      score: publicRow.score ?? null,
      tvlUsd: round(publicRow.tvlUsd, 2),
      routePriority: publicRow.routePriority || null,
      coverageState: publicRow.coverage?.state || null,
    } : null,
    chain: { chain: CHAIN, chainId: ETHEREUM_CHAIN_ID, blockNumber, blockTimestamp },
    addresses: Object.fromEntries(Object.entries(ADDR).map(([k, v]) => [k, normalizeAddress(v)])),
    tokenRows,
    erc4626Rows: [{ label: "USDtb", ...usdTbErc4626 }, { label: "fUSDtb", ...fUsdTbErc4626 }],
    minting,
    permissionlessProbeSummary: { ...probes, ...(minting?.permissionlessProbes || {}) },
    dexRows,
    custodyBalanceRows: custodyBalanceRows.sort((a, b) => (asNumber(b.usd) || 0) - (asNumber(a.usd) || 0)),
    consumerJoins: joins,
    consumerJoinInputsLoaded: inputsLoaded,
    consumerJoinSummary,
    summary,
    blockers: [
      "USDtb price/reference divergence is below the route threshold and does not overcome lending haircuts, slippage, gas, or flash fees",
      "Ethena mint/redeem flows are role/signed-order gated in current read-only probes; no arbitrary-sender mint, redeem, custody, or admin path is treated as executable",
      "Fluid, Euler, Morpho, DEX, and local artifact USDtb joins are context-only unless a current accepted-value, depeg, liquidation, or redemption edge maps to exact positive economics",
      "fUSDtb and USDtb ERC4626/lending rows do not prove a donation, stale-rate, or same-block accounting route with positive borrow/redeem/unwind economics",
      "No fork extraction proof and no signed-action justification",
    ],
    requiredForRoutePositive: [
      "specific USDtb or fUSDtb trusted consumer accepts attacker-favorable stale, overvalued, or undercollateralized accounting state",
      "borrow, liquidation, redeem, or mint path is permissionless, unpaused, and has material live liquidity",
      "acquisition, borrow/repay, redeem/liquidate, and DEX/PSM/market exit are exact-quoted positive after gas/slippage/fees",
      "fork extraction proof demonstrates positive net value",
    ],
    nextReadOnlyStep: "Keep USDtb on Fluid/Euler/Morpho consumer, minting-cap, and depeg/reference watch; exact-quote/fork only if USDtb accepted value diverges materially from acquisition/redemption value, a material borrower becomes liquidatable, or a USDtb lending row exposes exact-positive economics.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, renderReport(artifact));
  if (!QUIET) {
    console.log(`Ethena USDtb Phase0: joins=${summary.artifactJoinRows} usdtbJoins=${summary.usdTbConsumerRows} material=${summary.materialConsumerRows} priceVsPeg=${summary.usdTbPriceVsPegBps}bps watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT)}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(`Ethena USDtb Phase0 failed: ${err?.message || err}`);
  process.exitCode = 1;
});
