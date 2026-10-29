#!/usr/bin/env node
// Read-only Overnight Finance m2m/strategy NAV route prefilter.
// RPC URLs are resolved in memory only via shared-rpc and are never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "prefilter-overnight-finance-route-prefilter.json");
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const CHAINS = {
  8453: { chain: "Base", llamaKey: "base", geckoNetwork: "base" },
  42161: { chain: "Arbitrum", llamaKey: "arbitrum", geckoNetwork: "arbitrum" },
  81457: { chain: "Blast", llamaKey: "blast", geckoNetwork: "blast" },
};

const TOKENS = [
  { chainId: 8453, label: "USD+", address: "0x1F4947Cd5A5c058DD5EA6Fd1CCd5c311aDa9E6Fb", assetSymbol: "USDC", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  { chainId: 8453, label: "DAI+", address: "0x7a62315519A39d562c1E49EB35b300d2E6742f86", assetSymbol: "DAI", asset: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" },
  { chainId: 8453, label: "USDC+", address: "0x96aa0bBe4D0dea7C4AF4739c53dBFA0300262253", assetSymbol: "USDC", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  { chainId: 42161, label: "USD+", address: "0x9Af655c4DBe940962F776b685d6700F538B90fcf", assetSymbol: "USDC", asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  { chainId: 42161, label: "ETH+", address: "0x672F0f9ECF78406E4E31cd531b0CefE32f0A84B5", assetSymbol: "native/ETH", asset: null },
  { chainId: 81457, label: "USD+", address: "0x93dD104528B35E82c061BB0D521096dCF11628FA", assetSymbol: "USDB", asset: "0x4300000000000000000000000000000000000003" },
  { chainId: 81457, label: "USDC+", address: "0x1d48DD3094EbB4B9a2c5Ab96dF4ef05bFF562F26", assetSymbol: "USDB", asset: "0x4300000000000000000000000000000000000003" },
];

const LOCAL_MATCH_FILES = [
  "consumer-first-high-ltv-collateral.json",
  "euler-v2-phase0.json",
  "silo-v2-phase0.json",
  "aave-euler-silo-consumer-graph.json",
  "velodrome-v3-phase0.json",
  "aerodrome-v1-phase0.json",
  "curve-dex-phase0.json",
  "pancakeswap-infinity-phase0.json",
  "current-profit-leads.json",
];
const LOCAL_TEXT_CACHE = new Map();

const ERC20 = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const M2M = new ethers.Interface([
  "function strategyAssets() view returns (tuple(address strategy,uint256 netAssetValue,uint256 liquidationValue)[])",
  "function totalAssets() view returns (uint256)",
  "function asset() view returns (address)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
]);

function decode(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}

async function call(provider, address, iface, fn, args = []) {
  try {
    const raw = await provider.call({ to: address, data: iface.encodeFunctionData(fn, args) });
    return decode(raw, iface, fn);
  } catch (_) {
    return null;
  }
}

function slotAddress(raw) {
  if (!raw || raw === "0x" || /^0x0+$/.test(raw)) return null;
  try { return ethers.getAddress(`0x${raw.slice(-40)}`); } catch (_) { return null; }
}

function units(raw, decimals) {
  try { return Number(ethers.formatUnits(raw, decimals)); } catch (_) { return null; }
}

function formatUnits(raw, decimals) {
  if (raw === null || raw === undefined) return null;
  try { return ethers.formatUnits(raw, decimals); } catch (_) { return null; }
}

function round(value, decimals = 2) {
  if (!Number.isFinite(Number(value))) return null;
  const scale = 10 ** decimals;
  return Math.round(Number(value) * scale) / scale;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-overnight/1.0" }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchMetadata() {
  const json = await fetchJson("https://api.llama.fi/protocol/overnight-finance", 45_000);
  if (!json) return { ok: false };
  const currentTvlUsd = Array.isArray(json.tvl) && json.tvl.length ? json.tvl[json.tvl.length - 1].totalLiquidityUSD : json.tvl;
  const chainTvls = {};
  for (const [chain, value] of Object.entries(json.chainTvls || {})) chainTvls[chain] = Array.isArray(value?.tvl) && value.tvl.length ? value.tvl[value.tvl.length - 1].totalLiquidityUSD : value?.tvl ?? null;
  return { ok: true, name: json.name, slug: json.slug || "overnight-finance", category: json.category, currentTvlUsd, chains: json.chains || [], audits: json.audits || null, url: json.url || null, adapter: json.module || "projects/overnight-fi/index.js", chainTvls };
}

async function sourcifyStatus(chainId, address) {
  const checks = [
    `https://repo.sourcify.dev/contracts/full_match/${chainId}/${address}/metadata.json`,
    `https://repo.sourcify.dev/contracts/partial_match/${chainId}/${address}/metadata.json`,
  ];
  for (const url of checks) {
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-overnight/1.0" } }).catch(() => null);
    if (res?.ok) return { verified: true, source: url.includes("full_match") ? "sourcify-full" : "sourcify-partial" };
  }
  return { verified: false, source: null };
}

async function scanAddress(provider, chainId, address) {
  const [code, implRaw, adminRaw, sourceStatus] = await Promise.all([
    provider.getCode(address).catch(() => "0x"),
    provider.getStorage(address, EIP1967_IMPL).catch(() => null),
    provider.getStorage(address, EIP1967_ADMIN).catch(() => null),
    sourcifyStatus(chainId, address),
  ]);
  return { address, codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0, proxy: { eip1967Implementation: slotAddress(implRaw), eip1967Admin: slotAddress(adminRaw) }, sourceStatus };
}

async function geckoPools(token) {
  const chain = CHAINS[token.chainId];
  if (!chain?.geckoNetwork) return [];
  const json = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${chain.geckoNetwork}/tokens/${token.address}/pools?page=1`, 20_000);
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.slice(0, 5).map((row) => ({ pool: row.id || null, dex: row.relationships?.dex?.data?.id || null, name: row.attributes?.name || null, reserveUsd: row.attributes?.reserve_in_usd ? Number(row.attributes.reserve_in_usd) : null, baseTokenPriceUsd: row.attributes?.base_token_price_usd ? Number(row.attributes.base_token_price_usd) : null }));
}

function localAddressMatches(address) {
  const needle = String(address || "").toLowerCase();
  const matches = [];
  for (const file of LOCAL_MATCH_FILES) {
    const filePath = path.join(RAW_DIR, file);
    if (!fs.existsSync(filePath)) continue;
    if (!LOCAL_TEXT_CACHE.has(filePath)) LOCAL_TEXT_CACHE.set(filePath, fs.readFileSync(filePath, "utf8").toLowerCase());
    const text = LOCAL_TEXT_CACHE.get(filePath);
    const count = text.split(needle).length - 1;
    if (count > 0) matches.push({ file: `reports/raw/fast/${file}`, count });
  }
  return matches;
}

async function priceMap(tokens) {
  const ids = new Set();
  for (const token of tokens) {
    const chain = CHAINS[token.chainId];
    ids.add(`${chain.llamaKey}:${token.address}`);
    if (token.asset) ids.add(`${chain.llamaKey}:${token.asset}`);
    if (token.assetSymbol === "native/ETH") ids.add("coingecko:ethereum");
  }
  const json = await fetchJson(`https://coins.llama.fi/prices/current/${Array.from(ids).join(",")}?searchWidth=6h`, 30_000);
  return json?.coins || {};
}

function priceFor(prices, chainId, address) {
  if (!address && chainId === 42161) return Number(prices["coingecko:ethereum"]?.price || 0) || null;
  const chain = CHAINS[chainId];
  return Number(prices[`${chain?.llamaKey}:${address}`]?.price || 0) || null;
}

async function tokenMeta(provider, token, prices) {
  const chain = CHAINS[token.chainId];
  const [basic, symbolRaw, nameRaw, decimalsRaw, supplyRaw, pools, stratRaw, totalAssetsRaw, assetRaw, convertRaw, previewRaw, maxDepositRaw, ownerRaw, pausedRaw, assetDecimalsRaw] = await Promise.all([
    scanAddress(provider, token.chainId, token.address),
    call(provider, token.address, ERC20, "symbol"),
    call(provider, token.address, ERC20, "name"),
    call(provider, token.address, ERC20, "decimals"),
    call(provider, token.address, ERC20, "totalSupply"),
    geckoPools(token),
    call(provider, token.address, M2M, "strategyAssets"),
    call(provider, token.address, M2M, "totalAssets"),
    call(provider, token.address, M2M, "asset"),
    call(provider, token.address, M2M, "convertToAssets", [10n ** 18n]),
    call(provider, token.address, M2M, "previewRedeem", [10n ** 18n]),
    call(provider, token.address, M2M, "maxDeposit", ["0x000000000000000000000000000000000000dEaD"]),
    call(provider, token.address, M2M, "owner"),
    call(provider, token.address, M2M, "paused"),
    token.asset ? call(provider, token.asset, ERC20, "decimals") : null,
  ]);
  const decimals = Number(decimalsRaw?.[0] ?? 18n);
  const supply = supplyRaw?.[0] ?? 0n;
  const supplyUnits = units(supply, decimals);
  const tokenPrice = priceFor(prices, token.chainId, token.address);
  const asset = assetRaw?.[0] || token.asset || null;
  const assetPrice = asset || token.assetSymbol === "native/ETH" ? priceFor(prices, token.chainId, asset) : null;
  const assetDecimals = Number(assetDecimalsRaw?.[0] ?? (token.assetSymbol === "native/ETH" || token.assetSymbol === "DAI" || token.assetSymbol === "USDB" ? 18 : 6));
  const strategies = Array.from(stratRaw?.[0] || []).map((row) => ({ strategy: row.strategy, netAssetValueRaw: row.netAssetValue.toString(), liquidationValueRaw: row.liquidationValue.toString(), netAssetValue: formatUnits(row.netAssetValue, assetDecimals), liquidationValue: formatUnits(row.liquidationValue, assetDecimals) }));
  const netAssetValue = strategies.reduce((sum, row) => sum + Number(row.netAssetValue || 0), 0);
  const liquidationValue = strategies.reduce((sum, row) => sum + Number(row.liquidationValue || 0), 0);
  return { ...token, chain: chain.chain, ...basic, symbol: symbolRaw?.[0] || null, name: nameRaw?.[0] || null, decimals, totalSupplyRaw: supply.toString(), totalSupply: formatUnits(supply, decimals), priceUsd: tokenPrice, totalSupplyUsd: tokenPrice && supplyUnits !== null ? tokenPrice * supplyUnits : null, assetProbe: asset, totalAssetsRaw: totalAssetsRaw?.[0]?.toString() || null, totalAssets: totalAssetsRaw?.[0] === undefined ? null : formatUnits(totalAssetsRaw[0], assetDecimals), totalAssetsUsd: assetPrice && totalAssetsRaw?.[0] !== undefined ? assetPrice * units(totalAssetsRaw[0], assetDecimals) : null, convertToAssetsOneShareRaw: convertRaw?.[0]?.toString() || null, previewRedeemOneShareRaw: previewRaw?.[0]?.toString() || null, maxDepositRaw: maxDepositRaw?.[0]?.toString() || null, owner: ownerRaw?.[0] || null, paused: pausedRaw?.[0] ?? null, strategyRows: strategies, strategyRowsCount: strategies.length, strategyNetAssetValue: netAssetValue, strategyLiquidationValue: liquidationValue, strategyNetAssetValueUsd: assetPrice ? netAssetValue * assetPrice : null, strategyLiquidationValueUsd: assetPrice ? liquidationValue * assetPrice : null, dexPools: pools, topDexLiquidityUsd: pools.length ? Math.max(...pools.map((row) => Number(row.reserveUsd || 0))) : 0, localMatches: localAddressMatches(token.address) };
}

async function main() {
  const metadataPromise = fetchMetadata();
  const prices = await priceMap(TOKENS);
  const tokenRows = [];
  const rpcBlocked = [];
  for (const chainId of [...new Set(TOKENS.map((row) => row.chainId))]) {
    const rpc = await resolveRpc(chainId);
    if (!rpc) {
      rpcBlocked.push({ protocol: "Overnight Finance", chain: CHAINS[chainId].chain, chainId, missingEndpointClass: "EVM RPC", skippedChecks: ["m2m token state", "strategyAssets NAV", "DEX/consumer joins"] });
      continue;
    }
    const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    for (const token of TOKENS.filter((row) => row.chainId === chainId)) tokenRows.push(await tokenMeta(provider, token, prices));
  }
  const metadata = await metadataPromise;
  const localArtifactMatchRows = tokenRows.reduce((sum, row) => sum + (row.localMatches || []).reduce((s, m) => s + m.count, 0), 0);
  const dexRows = tokenRows.filter((row) => Number(row.topDexLiquidityUsd || 0) >= 10000);
  const strategyNetAssetValueUsd = tokenRows.reduce((sum, row) => sum + Number(row.strategyNetAssetValueUsd || 0), 0);
  const strategyLiquidationValueUsd = tokenRows.reduce((sum, row) => sum + Number(row.strategyLiquidationValueUsd || 0), 0);
  const strategyValueGapUsd = strategyNetAssetValueUsd - strategyLiquidationValueUsd;
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-overnight-finance-prefilter.js",
    scope: "Overnight Finance USD+/DAI+/USDC+/ETH+ strategy NAV route prefilter",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false, forkJustified: false },
    metadata,
    adapter: { source: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/overnight-fi/index.js", methodology: "Adapter reads strategyAssets() and adds netAssetValue by configured underlying asset" },
    tokenRows,
    rpcBlocked,
    consumerContext: { localArtifactMatchRows, localMatches: tokenRows.filter((row) => (row.localMatches || []).length).map((row) => ({ chain: row.chain, label: row.label, address: row.address, localMatches: row.localMatches })), dexLiquidityRows: dexRows.map((row) => ({ chain: row.chain, label: row.label, address: row.address, topDexLiquidityUsd: row.topDexLiquidityUsd, pools: row.dexPools })) },
    summary: { tokenRows: tokenRows.length, codePresentRows: tokenRows.filter((row) => row.codePresent).length, strategyProbeRows: tokenRows.filter((row) => row.strategyRowsCount > 0).length, totalStrategyRows: tokenRows.reduce((sum, row) => sum + Number(row.strategyRowsCount || 0), 0), strategyNetAssetValueUsd, strategyLiquidationValueUsd, strategyValueGapUsd, localArtifactMatchRows, consumerJoinRows: 0, dexLiquidityRows: dexRows.length, maxDexLiquidityUsd: dexRows.length ? Math.max(...dexRows.map((row) => Number(row.topDexLiquidityUsd || 0))) : 0, exactEconomicsRows: 0, rpcBlockedRows: rpcBlocked.length, routePositive: 0, executableNow: 0, signedActionJustified: false, forkJustified: false },
    blockers: [
      "strategyAssets NAV is visible but no accepted-value consumer route is joined",
      "Local exact seed addresses do not appear in lending/oracle consumer artifacts in this workspace",
      "DEX liquidity rows are exit context only without a cheaper acquisition, stale NAV, redeem, or borrow route",
      "Protocol TVL remains borderline and no exact positive liquidation, borrow, redemption, or unwind route exists",
    ],
    nextRoutePositiveCriteria: [
      "USD+/DAI+/USDC+/ETH+ can be acquired below redeemable strategy value and redeemed/unwound atomically after fees, slippage, and gas",
      "A live lending/oracle consumer accepts an Overnight receipt with material borrow cash or liquidatable debt and overvalues it versus market/redeem value",
    ],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Overnight prefilter: tokens=${tokenRows.length} strategyUsd=${round(strategyNetAssetValueUsd, 2)} dexRows=${dexRows.length} artifactMatches=${localArtifactMatchRows} routePositive=0 rpcBlocked=${rpcBlocked.length}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
