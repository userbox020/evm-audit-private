#!/usr/bin/env node
// Read-only Ember Protocol ERC4626/vault receipt route prefilter.
// RPC URLs are resolved in memory only via shared-rpc and are never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "prefilter-ember-protocol-route-prefilter.json");
const CONFIG_URL = "https://vaults.api.sui-prod.bluefin.io/api/v2/vaults";
const SUI_BLACKLISTED_VAULTS = new Set([
  "0xb3ccbc12cd633d3a8da0cf97a4d89f771a9bd8c0cd8ce321de13edc11cfb3e1c",
]);
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const RECEIVER = "0x000000000000000000000000000000000000dEaD";

const CHAINS = {
  ethereum: { chain: "Ethereum", chainId: 1, llamaKey: "ethereum", geckoNetwork: "eth" },
  base: { chain: "Base", chainId: 8453, llamaKey: "base", geckoNetwork: "base" },
  pharos: { chain: "Pharos", chainId: null, llamaKey: "pharos", geckoNetwork: null },
  sui: { chain: "Sui", chainId: null, llamaKey: "sui", geckoNetwork: null },
};

const LOCAL_MATCH_FILES = [
  "rwa-nav-consumer-graph.json",
  "aave-euler-silo-consumer-graph.json",
  "consumer-first-high-ltv-collateral.json",
  "euler-v2-phase0.json",
  "silo-v2-phase0.json",
  "pendle-pt-consumer-graph.json",
  "pendle-pt-multichain-consumer-graph.json",
  "morpho-high-apy-liquidation-routes.json",
  "morpho-liquidatable-marketability.json",
  "pancakeswap-infinity-phase0.json",
];
const LOCAL_TEXT_CACHE = new Map();

const ERC20 = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);

const VAULT = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function maxMint(address receiver) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
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
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-ember/1.0" }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchMetadata() {
  const json = await fetchJson("https://api.llama.fi/protocol/ember-protocol", 45_000);
  if (!json) return { ok: false };
  const currentTvlUsd = Array.isArray(json.tvl) && json.tvl.length ? json.tvl[json.tvl.length - 1].totalLiquidityUSD : json.tvl;
  return { ok: true, name: json.name, slug: json.slug || "ember-protocol", category: json.category, currentTvlUsd, chains: json.chains || [], audits: json.audits || null, url: json.url || null, adapter: "projects/ember-protocol/index.js" };
}

async function sourcifyStatus(chainId, address) {
  const checks = [
    `https://repo.sourcify.dev/contracts/full_match/${chainId}/${address}/metadata.json`,
    `https://repo.sourcify.dev/contracts/partial_match/${chainId}/${address}/metadata.json`,
  ];
  for (const url of checks) {
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-ember/1.0" } }).catch(() => null);
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

async function geckoPools(chainKey, address) {
  const chain = CHAINS[chainKey];
  if (!chain?.geckoNetwork) return [];
  const json = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${chain.geckoNetwork}/tokens/${address}/pools?page=1`, 20_000);
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.slice(0, 5).map((row) => ({ pool: row.id || null, dex: row.relationships?.dex?.data?.id || null, name: row.attributes?.name || null, reserveUsd: row.attributes?.reserve_in_usd ? Number(row.attributes.reserve_in_usd) : null, baseTokenPriceUsd: row.attributes?.base_token_price_usd ? Number(row.attributes.base_token_price_usd) : null }));
}

function localAddressMatches(address) {
  const needle = String(address || "").toLowerCase();
  if (!needle.startsWith("0x")) return [];
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

function normalizeEvmAddress(address) {
  try { return ethers.getAddress(address); } catch (_) { return null; }
}

function chainRowsFromConfig(config) {
  const rows = [];
  for (const vault of Object.values(config || {})) {
    for (const [chainKey, detail] of Object.entries(vault.detailsByChain || {})) {
      rows.push({
        id: vault.id || null,
        name: vault.name || null,
        longName: vault.longName || null,
        status: vault.status || null,
        publicType: vault.publicType || null,
        isPrivate: Boolean(vault.isPrivate),
        isBridgeable: Boolean(vault.isBridgeable),
        withdrawalPeriodDays: Number(vault.withdrawalPeriodDays ?? 0),
        maxDepositsAllowed: Number(vault.maxDepositsAllowedE18 || 0) / 1e18,
        minWithdrawalShares: Number(vault.minWithdrawalSharesE18 || 0) / 1e18,
        rate: Number(vault.rateE18 || 0) / 1e18,
        totalDepositsUsd: Number(vault.totalDepositsInUsdE9 || 0) / 1e9,
        chainKey,
        chain: CHAINS[chainKey]?.chain || chainKey,
        chainId: CHAINS[chainKey]?.chainId ?? null,
        address: detail.address || null,
        evmAddress: normalizeEvmAddress(detail.address),
        baseDepositCoin: detail.baseDepositCoin ? { symbol: detail.baseDepositCoin.symbol || null, address: detail.baseDepositCoin.address || null } : null,
        receiptCoin: detail.receiptCoin ? { symbol: detail.receiptCoin.symbol || null, address: detail.receiptCoin.address || null } : null,
      });
    }
  }
  return rows;
}

async function priceMap(rows) {
  const ids = new Set();
  for (const row of rows) {
    const chain = CHAINS[row.chainKey];
    if (!chain?.llamaKey || !row.address) continue;
    ids.add(`${chain.llamaKey}:${row.address}`);
    if (row.baseDepositCoin?.address?.startsWith("0x")) ids.add(`${chain.llamaKey}:${row.baseDepositCoin.address}`);
  }
  if (!ids.size) return {};
  const json = await fetchJson(`https://coins.llama.fi/prices/current/${Array.from(ids).join(",")}?searchWidth=6h`, 30_000);
  return json?.coins || {};
}

function priceFor(prices, chainKey, address) {
  const chain = CHAINS[chainKey];
  return Number(prices[`${chain?.llamaKey}:${address}`]?.price || 0) || null;
}

async function tokenLite(provider, chainKey, address, prices) {
  if (!address) return null;
  const chain = CHAINS[chainKey];
  const [basic, symbolRaw, nameRaw, decimalsRaw, supplyRaw, pools] = await Promise.all([
    scanAddress(provider, chain.chainId, address),
    call(provider, address, ERC20, "symbol"),
    call(provider, address, ERC20, "name"),
    call(provider, address, ERC20, "decimals"),
    call(provider, address, ERC20, "totalSupply"),
    geckoPools(chainKey, address),
  ]);
  const decimals = Number(decimalsRaw?.[0] ?? 18n);
  const supply = supplyRaw?.[0] ?? 0n;
  const supplyUnits = units(supply, decimals);
  const priceUsd = priceFor(prices, chainKey, address);
  return { ...basic, chainId: chain.chainId, chain: chain.chain, symbol: symbolRaw?.[0] || null, name: nameRaw?.[0] || null, decimals, totalSupplyRaw: supply.toString(), totalSupply: formatUnits(supply, decimals), priceUsd, totalSupplyUsd: priceUsd && supplyUnits !== null ? supplyUnits * priceUsd : null, dexPools: pools, topDexLiquidityUsd: pools.length ? Math.max(...pools.map((row) => Number(row.reserveUsd || 0))) : 0, localMatches: localAddressMatches(address) };
}

async function scanVault(provider, row, prices) {
  const vaultToken = await tokenLite(provider, row.chainKey, row.evmAddress, prices);
  const decimals = vaultToken?.decimals ?? 18;
  const oneShare = 10n ** BigInt(Math.min(Math.max(decimals, 0), 36));
  const [assetRaw, totalAssetsRaw, convertRaw, previewRedeemRaw, maxDepositRaw, maxMintRaw, maxWithdrawRaw, maxRedeemRaw, ownerRaw, pausedRaw] = await Promise.all([
    call(provider, row.evmAddress, VAULT, "asset"),
    call(provider, row.evmAddress, VAULT, "totalAssets"),
    call(provider, row.evmAddress, VAULT, "convertToAssets", [oneShare]),
    call(provider, row.evmAddress, VAULT, "previewRedeem", [oneShare]),
    call(provider, row.evmAddress, VAULT, "maxDeposit", [RECEIVER]),
    call(provider, row.evmAddress, VAULT, "maxMint", [RECEIVER]),
    call(provider, row.evmAddress, VAULT, "maxWithdraw", [RECEIVER]),
    call(provider, row.evmAddress, VAULT, "maxRedeem", [RECEIVER]),
    call(provider, row.evmAddress, VAULT, "owner"),
    call(provider, row.evmAddress, VAULT, "paused"),
  ]);
  const asset = normalizeEvmAddress(assetRaw?.[0] || row.baseDepositCoin?.address);
  const assetMeta = asset ? await tokenLite(provider, row.chainKey, asset, prices) : null;
  const assetDecimals = assetMeta?.decimals ?? 18;
  const totalAssets = totalAssetsRaw?.[0] ?? null;
  const totalAssetsUnits = totalAssets === null ? null : units(totalAssets, assetDecimals);
  const assetPriceUsd = assetMeta?.priceUsd || priceFor(prices, row.chainKey, asset);
  const totalAssetsUsd = assetPriceUsd && totalAssetsUnits !== null ? assetPriceUsd * totalAssetsUnits : null;
  const maxDeposit = maxDepositRaw?.[0] ?? null;
  const maxMint = maxMintRaw?.[0] ?? null;
  const localMatches = localAddressMatches(row.evmAddress);
  return {
    ...row,
    token: vaultToken,
    erc4626Probe: {
      asset,
      assetMeta,
      totalAssetsRaw: totalAssets?.toString() || null,
      totalAssets: totalAssets === null ? null : formatUnits(totalAssets, assetDecimals),
      totalAssetsUsd,
      convertToAssetsOneShareRaw: convertRaw?.[0]?.toString() || null,
      previewRedeemOneShareRaw: previewRedeemRaw?.[0]?.toString() || null,
      maxDepositRaw: maxDeposit?.toString() || null,
      maxDeposit: maxDeposit === null ? null : formatUnits(maxDeposit, assetDecimals),
      maxMintRaw: maxMint?.toString() || null,
      maxMint: maxMint === null ? null : formatUnits(maxMint, decimals),
      maxWithdrawRaw: maxWithdrawRaw?.[0]?.toString() || null,
      maxRedeemRaw: maxRedeemRaw?.[0]?.toString() || null,
      owner: ownerRaw?.[0] || null,
      paused: pausedRaw?.[0] ?? null,
    },
    localMatches,
  };
}

async function main() {
  const [metadata, config] = await Promise.all([fetchMetadata(), fetchJson(CONFIG_URL, 45_000)]);
  const configRows = chainRowsFromConfig(config || {});
  const chainCounts = configRows.reduce((acc, row) => { acc[row.chainKey] = (acc[row.chainKey] || 0) + 1; return acc; }, {});
  const evmRows = configRows.filter((row) => ["ethereum", "base"].includes(row.chainKey) && row.evmAddress);
  const pharosRows = configRows.filter((row) => row.chainKey === "pharos");
  const suiRows = configRows.filter((row) => row.chainKey === "sui");
  const prices = await priceMap(evmRows);
  const rpcs = { 1: await resolveRpc(1), 8453: await resolveRpc(8453) };
  const vaultRows = [];
  const rpcBlocked = [];
  for (const chainKey of ["ethereum", "base"]) {
    const chain = CHAINS[chainKey];
    if (!rpcs[chain.chainId]) {
      rpcBlocked.push({ protocol: "Ember Protocol", chain: chain.chain, chainId: chain.chainId, missingEndpointClass: "EVM RPC", vaultRows: evmRows.filter((row) => row.chainKey === chainKey).length, skippedChecks: ["ERC4626 vault state", "deposit/redeem caps", "DEX/consumer joins"] });
      continue;
    }
    const provider = new ethers.JsonRpcProvider(rpcs[chain.chainId], chain.chainId, { staticNetwork: true });
    for (const row of evmRows.filter((item) => item.chainKey === chainKey)) vaultRows.push(await scanVault(provider, row, prices));
  }
  if (pharosRows.length) {
    rpcBlocked.push({ protocol: "Ember Protocol", chain: "Pharos", chainId: null, missingEndpointClass: "EVM RPC/chain preset", vaultRows: pharosRows.length, skippedChecks: ["ERC4626 vault state", "deposit/redeem caps", "DEX/consumer joins"], retestTrigger: "Provide sanitized Pharos RPC endpoint and chain preset if a route depends on Pharos" });
  }

  const localArtifactMatchRows = vaultRows.reduce((sum, row) => sum + (row.localMatches || []).reduce((s, m) => s + m.count, 0) + (row.token?.localMatches || []).reduce((s, m) => s + m.count, 0), 0);
  const dexRows = vaultRows.map((row) => row.token).filter((row) => Number(row?.topDexLiquidityUsd || 0) >= 10000);
  const publicDepositRows = vaultRows.filter((row) => row.erc4626Probe.maxDepositRaw && row.erc4626Probe.maxDepositRaw !== "0").length;
  const sameEpochConfigRows = vaultRows.filter((row) => Number(row.withdrawalPeriodDays || 0) === 0).length;
  const activePublicRows = vaultRows.filter((row) => row.status === "active" && !row.isPrivate).length;
  const totalOnchainAssetsUsd = vaultRows.reduce((sum, row) => sum + Number(row.erc4626Probe.totalAssetsUsd || 0), 0);
  const configScannedDepositsUsd = evmRows.reduce((sum, row) => sum + Number(row.totalDepositsUsd || 0), 0);
  const configEvmIncludingPharosDepositsUsd = [...evmRows, ...pharosRows].reduce((sum, row) => sum + Number(row.totalDepositsUsd || 0), 0);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-ember-protocol-prefilter.js",
    scope: "Ember Protocol vault receipt / allocator NAV route prefilter",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false, forkJustified: false },
    metadata,
    adapter: { source: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/ember-protocol/index.js", vaultConfig: CONFIG_URL, methodology: "EVM TVL via sumERC4626Vaults over Bluefin/Ember vault config; Sui TVL via package view in adapter" },
    configSummary: { totalVaults: Object.keys(config || {}).length, chainCounts, evmConfigRows: evmRows.length + pharosRows.length, evmScannedRows: vaultRows.length, pharosRows: pharosRows.length, suiRows: suiRows.length, suiAdapterBlacklistedRows: suiRows.filter((row) => SUI_BLACKLISTED_VAULTS.has(String(row.address).toLowerCase())).length },
    vaultRows,
    pharosRows,
    nonEvmCoverage: [{ chain: "Sui", vaultRows: suiRows.length, adapterBlacklistedRows: suiRows.filter((row) => SUI_BLACKLISTED_VAULTS.has(String(row.address).toLowerCase())).length, skippedChecks: ["Sui package get_vault_tvl live query", "Sui receipt transfer/redeem gating", "Sui consumer joins"], caveat: "Sui coverage is not route-negative in this EVM-focused prefilter" }],
    rpcBlocked,
    consumerContext: {
      localArtifactMatchRows,
      localMatches: vaultRows.filter((row) => (row.localMatches || []).length || (row.token?.localMatches || []).length).map((row) => ({ chain: row.chain, name: row.name, address: row.evmAddress, tokenMatches: row.token?.localMatches || [], rowMatches: row.localMatches || [] })),
      dexLiquidityRows: dexRows.map((row) => ({ chain: row.chain, symbol: row.symbol, address: row.address, topDexLiquidityUsd: row.topDexLiquidityUsd, pools: row.dexPools })),
    },
    summary: {
      configVaults: Object.keys(config || {}).length,
      configChainRows: configRows.length,
      evmConfigRows: evmRows.length + pharosRows.length,
      evmScannedRows: vaultRows.length,
      codePresentRows: vaultRows.filter((row) => row.token?.codePresent).length,
      activePublicRows,
      sameEpochConfigRows,
      publicDepositRows,
      privateRows: vaultRows.filter((row) => row.isPrivate).length,
      delayedWithdrawalRows: vaultRows.filter((row) => Number(row.withdrawalPeriodDays || 0) > 0).length,
      configScannedDepositsUsd,
      configEvmIncludingPharosDepositsUsd,
      totalOnchainAssetsUsd,
      localArtifactMatchRows,
      consumerJoinRows: 0,
      dexLiquidityRows: dexRows.length,
      maxDexLiquidityUsd: dexRows.length ? Math.max(...dexRows.map((row) => Number(row.topDexLiquidityUsd || 0))) : 0,
      exactEconomicsRows: 0,
      rpcBlockedRows: rpcBlocked.length,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      forkJustified: false,
    },
    blockers: [
      "ERC4626/accounting probes are visible on scanned EVM vaults, but no accepted-value consumer join is proven",
      "Configured withdrawal delays or private flags block many same-block low/no-capital routes",
      "Local artifact matches are address references, not exact borrow/redeem/liquidation consumer rows",
      "DEX liquidity is absent or insufficient for receipt-token acquisition/unwind at material size",
      "Pharos and Sui coverage remain caveats and are not route-negative closures",
      "No exact positive borrow, redeem, liquidation, or DEX unwind route exists from current evidence",
    ],
    nextRoutePositiveCriteria: [
      "A public same-block deposit/redeem or withdrawal path prices a receipt below redeemable assets after fees, delay, caps, and gas",
      "An Ember receipt is accepted by a live consumer with material borrow/redeem/liquidation liquidity and accepted value exceeds acquisition cost",
      "Pharos and Sui adapter rows are resolved if a route depends on those chains",
    ],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Ember prefilter: evmScanned=${vaultRows.length} onchainAssetsUsd=${round(totalOnchainAssetsUsd, 2)} depositRows=${publicDepositRows} dexRows=${dexRows.length} artifactMatches=${localArtifactMatchRows} routePositive=0 rpcBlocked=${rpcBlocked.length}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
