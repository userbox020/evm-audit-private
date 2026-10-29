#!/usr/bin/env node
// Read-only GAIB RWA/migration/pool-share route prefilter.
// RPC URLs are resolved in memory only via shared-rpc and are never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "prefilter-gaib-rwa-route-prefilter.json");
const AID = "0x18F52B3fb465118731d9e0d276d4Eb3599D57596";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const CHAINS = {
  1: { chain: "Ethereum", llamaKey: "ethereum", geckoNetwork: "eth", migration: "0x410c19f3f80b64c7486ae34890ee9251d0696433" },
  42161: { chain: "Arbitrum", llamaKey: "arbitrum", geckoNetwork: "arbitrum", migration: "0x77b69A6bAE1360A176452B00F61A0Fc21C7EF333" },
  8453: { chain: "Base", llamaKey: "base", geckoNetwork: "base", migration: "0xE2b908aa7C5DECBFC4260E52e138fc8d08272D03" },
  56: { chain: "BNB Chain", llamaKey: "bsc", geckoNetwork: "bsc", migration: "0x77b69A6bAE1360A176452B00F61A0Fc21C7EF333" },
  1329: { chain: "Sei", llamaKey: "sei", geckoNetwork: null, migration: null },
  1514: { chain: "Story", llamaKey: "story", geckoNetwork: null, migration: null },
};

const POOLS = [
  { chainId: 1, label: "AIDaUSDC", underlyingSymbol: "USDC", underlying: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", poolToken: "0xd5255Cc08EBAf6D54ac9448822a18d8A3da29A42" },
  { chainId: 1, label: "AIDaUSDT", underlyingSymbol: "USDT", underlying: "0xdAC17F958D2ee523a2206206994597C13D831ec7", poolToken: "0xDc45e7027A0489FE6C2E4A0735097d8E6952A340" },
  { chainId: 1, label: "AIDaUSR", underlyingSymbol: "USR", underlying: "0x66a1E37c9b0eAddca17d3662D6c05F4DECf3e110", poolToken: "0x5D976F56343e33A6a4d6e26AF7d59358d1359dd4" },
  { chainId: 1, label: "AIDaCUSDO", underlyingSymbol: "CUSDO", underlying: "0xaD55aebc9b8c03FC43cd9f62260391c13c23e7c0", poolToken: "0x17D02bCA29BD9E8cF4A39B25C9C902e6bF00AA54" },
  { chainId: 42161, label: "AIDaUSDC", underlyingSymbol: "USDC", underlying: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", poolToken: "0xd5255Cc08EBAf6D54ac9448822a18d8A3da29A42" },
  { chainId: 42161, label: "AIDaUSDT", underlyingSymbol: "USDT", underlying: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", poolToken: "0xDc45e7027A0489FE6C2E4A0735097d8E6952A340" },
  { chainId: 8453, label: "AIDaUSDC", underlyingSymbol: "USDC", underlying: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", poolToken: "0xd5255Cc08EBAf6D54ac9448822a18d8A3da29A42" },
  { chainId: 56, label: "AIDaUSD1", underlyingSymbol: "USD1", underlying: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d", poolToken: "0xd5255Cc08EBAf6D54ac9448822a18d8A3da29A42" },
  { chainId: 56, label: "AIDaUSDT", underlyingSymbol: "USDT", underlying: "0x55d398326f99059fF775485246999027B3197955", poolToken: "0xDc45e7027A0489FE6C2E4A0735097d8E6952A340" },
  { chainId: 1329, label: "AIDaUSDC", underlyingSymbol: "USDC", underlying: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392", poolToken: "0xd5255Cc08EBAf6D54ac9448822a18d8A3da29A42" },
  { chainId: 1329, label: "AIDaUSDT", underlyingSymbol: "USDT", underlying: "0x9151434b16b9763660705744891fA906F660EcC5", poolToken: "0xDc45e7027A0489FE6C2E4A0735097d8E6952A340" },
];

const LOCAL_MATCH_FILES = [
  "consumer-first-high-ltv-collateral.json",
  "euler-v2-phase0.json",
  "silo-v2-phase0.json",
  "rwa-nav-consumer-graph.json",
  "pendle-pt-consumer-graph.json",
  "pendle-pt-multichain-consumer-graph.json",
  "pancakeswap-infinity-phase0.json",
];
const LOCAL_TEXT_CACHE = new Map();

const ERC20 = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const POOL = new ethers.Interface([
  "function totalAssets() view returns (uint256)",
  "function asset() view returns (address)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
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

function round(value, decimals = 2) {
  if (!Number.isFinite(Number(value))) return null;
  const scale = 10 ** decimals;
  return Math.round(Number(value) * scale) / scale;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-gaib/1.0" }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchMetadata() {
  const json = await fetchJson("https://api.llama.fi/protocol/gaib", 45_000);
  if (!json) return { ok: false };
  const currentTvlUsd = Array.isArray(json.tvl) && json.tvl.length ? json.tvl[json.tvl.length - 1].totalLiquidityUSD : json.tvl;
  return { ok: true, name: json.name, slug: json.slug || "gaib", category: json.category, currentTvlUsd, chains: json.chains || [], audits: json.audits || null, url: json.url || null, adapter: "projects/gaib/index.js" };
}

async function sourcifyStatus(chainId, address) {
  const checks = [
    `https://repo.sourcify.dev/contracts/full_match/${chainId}/${address}/metadata.json`,
    `https://repo.sourcify.dev/contracts/partial_match/${chainId}/${address}/metadata.json`,
  ];
  for (const url of checks) {
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-gaib/1.0" } }).catch(() => null);
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

async function priceMap(rows) {
  const ids = new Set();
  for (const row of rows) {
    const chain = CHAINS[row.chainId];
    if (chain) ids.add(`${chain.llamaKey}:${row.address}`);
  }
  if (!ids.size) return {};
  const json = await fetchJson(`https://coins.llama.fi/prices/current/${Array.from(ids).join(",")}?searchWidth=6h`, 30_000);
  return json?.coins || {};
}

async function geckoPools(chainId, address) {
  const chain = CHAINS[chainId];
  if (!chain?.geckoNetwork) return [];
  const json = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${chain.geckoNetwork}/tokens/${address}/pools?page=1`, 20_000);
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.slice(0, 5).map((row) => ({ pool: row.id || null, dex: row.relationships?.dex?.data?.id || null, name: row.attributes?.name || null, reserveUsd: row.attributes?.reserve_in_usd ? Number(row.attributes.reserve_in_usd) : null, baseTokenPriceUsd: row.attributes?.base_token_price_usd ? Number(row.attributes.base_token_price_usd) : null }));
}

function localAddressMatches(address) {
  const needle = address.toLowerCase();
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

async function tokenMeta(provider, chainId, address, prices) {
  const chain = CHAINS[chainId];
  const [basic, symbolRaw, nameRaw, decimalsRaw, supplyRaw, pools] = await Promise.all([
    scanAddress(provider, chainId, address),
    call(provider, address, ERC20, "symbol"),
    call(provider, address, ERC20, "name"),
    call(provider, address, ERC20, "decimals"),
    call(provider, address, ERC20, "totalSupply"),
    geckoPools(chainId, address),
  ]);
  const decimals = Number(decimalsRaw?.[0] ?? 18n);
  const supply = supplyRaw?.[0] ?? 0n;
  const supplyUnits = units(supply, decimals);
  const price = Number(prices[`${chain.llamaKey}:${address}`]?.price || 0);
  return { ...basic, chainId, chain: chain.chain, symbol: symbolRaw?.[0] || null, name: nameRaw?.[0] || null, decimals, totalSupplyRaw: supply.toString(), totalSupply: ethers.formatUnits(supply, decimals), priceUsd: price || null, totalSupplyUsd: price && supplyUnits !== null ? supplyUnits * price : null, dexPools: pools, topDexLiquidityUsd: pools.length ? Math.max(...pools.map((row) => Number(row.reserveUsd || 0))) : 0, localMatches: localAddressMatches(address) };
}

async function scanPool(provider, row, prices) {
  const chain = CHAINS[row.chainId];
  const migration = chain.migration;
  const [poolMeta, underlyingMeta, migrationMeta, totalAssetsRaw, totalSupplyRaw, migrationBalRaw, assetRaw, convertRaw, previewRedeemRaw, ownerRaw, pausedRaw] = await Promise.all([
    tokenMeta(provider, row.chainId, row.poolToken, prices),
    tokenMeta(provider, row.chainId, row.underlying, prices),
    migration ? scanAddress(provider, row.chainId, migration) : Promise.resolve(null),
    call(provider, row.poolToken, POOL, "totalAssets"),
    call(provider, row.poolToken, ERC20, "totalSupply"),
    migration ? call(provider, row.poolToken, ERC20, "balanceOf", [migration]) : Promise.resolve(null),
    call(provider, row.poolToken, POOL, "asset"),
    call(provider, row.poolToken, POOL, "convertToAssets", [10n ** 18n]),
    call(provider, row.poolToken, POOL, "previewRedeem", [10n ** 18n]),
    call(provider, row.poolToken, POOL, "owner"),
    call(provider, row.poolToken, POOL, "paused"),
  ]);
  const totalAssets = totalAssetsRaw?.[0] ?? null;
  const supply = totalSupplyRaw?.[0] ?? 0n;
  const migrationBal = migrationBalRaw?.[0] ?? 0n;
  const claimableShares = supply > migrationBal ? supply - migrationBal : 0n;
  const claimableAssets = totalAssets !== null && supply > 0n ? (totalAssets * claimableShares) / supply : null;
  const underlyingPrice = Number(underlyingMeta.priceUsd || 0);
  const claimableUnits = claimableAssets === null ? null : units(claimableAssets, underlyingMeta.decimals || 18);
  return {
    ...row,
    chain: chain.chain,
    migration,
    poolMeta,
    underlyingMeta,
    migrationMeta,
    totalAssetsRaw: totalAssets?.toString() || null,
    totalSupplyRaw: supply.toString(),
    migrationBalanceRaw: migrationBal.toString(),
    claimableSharesRaw: claimableShares.toString(),
    claimableAssetsRaw: claimableAssets?.toString() || null,
    claimableAssets: claimableAssets === null ? null : ethers.formatUnits(claimableAssets, underlyingMeta.decimals || 18),
    claimableAssetsUsd: underlyingPrice && claimableUnits !== null ? claimableUnits * underlyingPrice : null,
    assetProbe: assetRaw?.[0] || null,
    oneShareConvertToAssetsRaw: convertRaw?.[0]?.toString() || null,
    oneSharePreviewRedeemRaw: previewRedeemRaw?.[0]?.toString() || null,
    owner: ownerRaw?.[0] || null,
    paused: pausedRaw?.[0] ?? null,
    localMatches: localAddressMatches(row.poolToken),
  };
}

async function main() {
  const metadataPromise = fetchMetadata();
  const tokenInputs = [];
  for (const chainId of [1, 42161, 8453, 56]) tokenInputs.push({ chainId, address: AID });
  for (const pool of POOLS) {
    tokenInputs.push({ chainId: pool.chainId, address: pool.poolToken });
    tokenInputs.push({ chainId: pool.chainId, address: pool.underlying });
  }
  const prices = await priceMap(tokenInputs);
  const chainIds = [...new Set([1, 42161, 8453, 56, 1329, 1514])];
  const rpcs = {};
  for (const chainId of chainIds) rpcs[chainId] = await resolveRpc(chainId);
  const metadata = await metadataPromise;
  const aidRows = [];
  const poolRows = [];
  const rpcBlocked = [];
  for (const chainId of [...new Set(POOLS.map((row) => row.chainId))]) {
    const rpc = rpcs[chainId];
    const chain = CHAINS[chainId];
    if (!rpc) {
      rpcBlocked.push({ protocol: "GAIB", chain: chain.chain, chainId, missingEndpointClass: "EVM RPC", skippedChecks: ["AID token state", "migration contract", "AIDa pool accounting", "DEX/consumer joins"] });
      continue;
    }
    const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    if ([1, 42161, 8453, 56].includes(chainId)) aidRows.push(await tokenMeta(provider, chainId, AID, prices));
    for (const pool of POOLS.filter((row) => row.chainId === chainId)) poolRows.push(await scanPool(provider, pool, prices));
  }
  for (const chainId of [1329, 1514]) {
    if (!rpcs[chainId]) rpcBlocked.push({ protocol: "GAIB", chain: CHAINS[chainId].chain, chainId, missingEndpointClass: "EVM RPC", skippedChecks: ["adapter TVL token state", "AID/AIDa pool accounting", "DEX/consumer joins"], retestTrigger: "Provide sanitized RPC endpoint/chain preset if a route depends on this chain" });
  }
  const localArtifactMatchRows = [...aidRows, ...poolRows].reduce((sum, row) => sum + (row.localMatches || []).reduce((s, m) => s + m.count, 0) + (row.poolMeta?.localMatches || []).reduce((s, m) => s + m.count, 0), 0);
  const dexRows = [...aidRows, ...poolRows.map((row) => row.poolMeta)].filter((row) => Number(row?.topDexLiquidityUsd || 0) >= 10000);
  const totalClaimableAssetsUsd = poolRows.reduce((sum, row) => sum + Number(row.claimableAssetsUsd || 0), 0);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-gaib-prefilter.js",
    scope: "GAIB AID/AIDa migration and pool-share route prefilter",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false, forkJustified: false },
    metadata,
    adapter: { source: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/gaib/index.js", aidToken: AID, methodology: "Legacy AIDa pool TVL via totalAssets() adjusted by migration-held shares; AID.v0 total supply across chains" },
    aidRows,
    poolRows,
    rpcBlocked,
    consumerContext: {
      localArtifactMatchRows,
      localMatches: [...aidRows, ...poolRows.map((row) => ({ chain: row.chain, label: row.label, address: row.poolToken, localMatches: row.localMatches }))].filter((row) => (row.localMatches || []).length),
      dexLiquidityRows: dexRows.map((row) => ({ chain: row.chain, symbol: row.symbol, address: row.address, topDexLiquidityUsd: row.topDexLiquidityUsd, pools: row.dexPools })),
    },
    summary: {
      aidRows: aidRows.length,
      poolRows: poolRows.length,
      rpcBlockedRows: rpcBlocked.length,
      codePresentPoolRows: poolRows.filter((row) => row.poolMeta?.codePresent).length,
      totalClaimableAssetsUsd,
      localArtifactMatchRows,
      consumerJoinRows: 0,
      dexLiquidityRows: dexRows.length,
      maxDexLiquidityUsd: dexRows.length ? Math.max(...dexRows.map((row) => Number(row.topDexLiquidityUsd || 0))) : 0,
      publicRedeemRows: poolRows.filter((row) => row.oneSharePreviewRedeemRaw || row.oneShareConvertToAssetsRaw).length,
      exactEconomicsRows: 0,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      forkJustified: false,
    },
    blockers: [
      "AIDa pool accounting is visible through totalAssets/totalSupply, but no public same-transaction redeem/migration extraction path is proven",
      "Exact DEX liquidity exists for some legacy pool tokens, but no accepted-value consumer or positive redeem route is joined",
      "Migration-held shares reduce claimable adapter TVL and do not imply permissionless extraction",
      "Story GAIB coverage is RPC-blocked in this workspace and remains a caveat, not route-negative closure",
      "No exact positive borrow, redeem, liquidation, migration claim, or DEX unwind route exists from current evidence",
    ],
    nextRoutePositiveCriteria: [
      "Public redeem/migrate/claim path converts discounted AIDa pool tokens into underlying at positive net value",
      "AID or AIDa is accepted by a live consumer with borrow/redeem/liquidation liquidity and accepted value exceeds acquisition cost",
      "Story adapter rows are resolved if a route depends on that chain",
    ],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`GAIB prefilter: pools=${poolRows.length} claimableUsd=${round(totalClaimableAssetsUsd, 2)} dexRows=${dexRows.length} artifactMatches=${localArtifactMatchRows} routePositive=0 rpcBlocked=${rpcBlocked.length}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
