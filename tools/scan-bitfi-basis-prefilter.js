#!/usr/bin/env node
// Read-only BitFi Basis route prefilter.
// RPC URLs are resolved in memory only via shared-rpc and are never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "prefilter-bitfi-basis-route-prefilter.json");
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const CHAINS = {
  1: { chain: "Ethereum", llamaKey: "ethereum", geckoNetwork: "ethereum" },
  56: { chain: "BSC", llamaKey: "bsc", geckoNetwork: "bsc" },
  8453: { chain: "Base", llamaKey: "base", geckoNetwork: "base" },
};

const TOKENS = [
  { chainId: 1, label: "bfBTC", address: "0xCdFb58c8C859Cb3F62ebe9Cf2767F9e036C7fb15", assetSymbol: "WBTC", asset: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" },
  { chainId: 1, label: "bfUSD", address: "0xa3eB7A9e57FCa4e40b79E394eD5eB37fEd205A24", assetSymbol: "USDT", asset: "0xdAC17F958D2ee523a2206206994597C13d831ec7" },
  { chainId: 1, label: "hbfUSD", address: "0xde5D4ab42251Ba9AF6f247CF07c9a4793fA6eD88", assetSymbol: "bfUSD", asset: "0xa3eB7A9e57FCa4e40b79E394eD5eB37fEd205A24" },
  { chainId: 1, label: "pbfUSD", address: "0x4f85cBfDefBdb3fA96fCf1E38b0ee68dB9Ae438b", assetSymbol: "bfUSD", asset: "0xa3eB7A9e57FCa4e40b79E394eD5eB37fEd205A24" },
  { chainId: 56, label: "bfBTC", address: "0x623F2774d9f27B59bc6b954544487532CE79d9DF", assetSymbol: "BTCB", asset: "0x7130d2A12BfeBC0F1A6016464135747C254cFec1" },
  { chainId: 8453, label: "bfBTC", address: "0x623F2774d9f27B59bc6b954544487532CE79d9DF", assetSymbol: "cbBTC", asset: "0xcbB7C0000aB88B473b1f5aFd3ef3030fa9642037" },
];

const CONTRACTS = [
  { chainId: 1, label: "bfUSD-Minter-USDT", address: "0xa3dEaa934a4CC648a45d8269a012894315e53518" },
  { chainId: 1, label: "bfUSD-Minter-USDC", address: "0x0497DD14524dD59Bcd76da7DC977A0f6120b1AcA" },
  { chainId: 1, label: "InstantRedeemer", address: "0x0971cB672b4eF3E19284Aa64717aFb154A6fbeDF" },
  { chainId: 1, label: "StandardRedeemer", address: "0x1898f16583152a6af129e3df14f0C955ca6201f7" },
  { chainId: 1, label: "Ceffu-BTCB-Custody", address: "0x062900dcd4729af3bdbf3150b98eb9bcfdb822ac" },
];

const LOCAL_MATCH_FILES = [
  "consumer-first-high-ltv-collateral.json",
  "euler-v2-phase0.json",
  "silo-v2-phase0.json",
  "aave-euler-silo-consumer-graph.json",
  "erc4626-consumer-joiner.json",
  "rwa-nav-consumer-graph.json",
  "centrifuge-nav-consumer-graph.json",
  "pendle-pt-multichain-consumer-graph.json",
  "morpho-high-apy-liquidation-routes.json",
  "current-profit-leads.json",
  "route-positive-sweep.json",
];
const LOCAL_TEXT_CACHE = new Map();

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const ERC4622_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function maxMint(address receiver) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
];
const REDEEMER_ABI = [
  "function instantRedeemFeeBps() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function quota() view returns (uint256)",
  "function remainingQuota() view returns (uint256)",
  "function redeemedToday() view returns (uint256)",
  "function settlementDelay() view returns (uint256)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
];
const MINTER_ABI = [
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
  "function maxMint() view returns (uint256)",
];

function decode(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}

async function call(provider, address, iface, fn, args = []) {
  try {
    const raw = await provider.call({ to: address, data: iface.encodeFunctionData(fn, args) });
    return decode(raw, iface, fn);
  } catch (_) { return null; }
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
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-bitfi/1.0" }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(t); }
}

async function sourcifyStatus(chainId, address) {
  const checks = [
    `https://repo.sourcify.dev/contracts/full_match/${chainId}/${address}/metadata.json`,
    `https://repo.sourcify.dev/contracts/partial_match/${chainId}/${address}/metadata.json`,
  ];
  for (const url of checks) {
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-bitfi/1.0" } }).catch(() => null);
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
  }
  ids.add("coingecko:bitcoin");
  const json = await fetchJson(`https://coins.llama.fi/prices/current/${Array.from(ids).join(",")}?searchWidth=6h`, 30_000);
  return json?.coins || {};
}

function priceFor(prices, chainId, address) {
  if (!address && chainId === 1) return Number(prices["coingecko:bitcoin"]?.price || 0) || null;
  const chain = CHAINS[chainId];
  return Number(prices[`${chain?.llamaKey}:${address}`]?.price || 0) || null;
}

async function tokenMeta(provider, token, prices) {
  const chain = CHAINS[token.chainId];
  const isVault = token.label.startsWith("hbfUSD") || token.label.startsWith("pbfUSD");
  const abi = isVault ? ERC4622_ABI : ERC20_ABI;
  const [basic, symbolRaw, nameRaw, decimalsRaw, supplyRaw, pools, stratRaw, totalAssetsRaw, assetRaw, convertRaw, convertSharesRaw, previewRedeemRaw, previewDepositRaw, maxDepositRaw, maxMintRaw, maxWithdrawRaw, maxRedeemRaw, ownerRaw, pausedRaw] = await Promise.all([
    scanAddress(provider, token.chainId, token.address),
    call(provider, token.address, abi, "symbol"),
    call(provider, token.address, abi, "name"),
    call(provider, token.address, abi, "decimals"),
    call(provider, token.address, abi, "totalSupply"),
    geckoPools(token),
    isVault ? call(provider, token.address, abi, "convertToAssets", [10n ** 18n]) : null,
    isVault ? call(provider, token.address, abi, "totalAssets") : null,
    isVault ? call(provider, token.address, abi, "asset") : null,
    isVault ? call(provider, token.address, abi, "convertToShares", [10n ** 18n]) : null,
    null,
    isVault ? call(provider, token.address, abi, "previewRedeem", [10n ** 18n]) : null,
    isVault ? call(provider, token.address, abi, "previewDeposit", [10n ** 18n]) : null,
    isVault ? call(provider, token.address, abi, "maxDeposit", ["0x000000000000000000000000000000000000dEaD"]) : null,
    isVault ? call(provider, token.address, abi, "maxMint", ["0x000000000000000000000000000000000000dEaD"]) : null,
    isVault ? call(provider, token.address, abi, "maxWithdraw", ["0x000000000000000000000000000000000000dEaD"]) : null,
    isVault ? call(provider, token.address, abi, "maxRedeem", ["0x000000000000000000000000000000000000dEaD"]) : null,
    null,
    null,
  ]);

  const decimals = Number(decimalsRaw?.[0] ?? 18n);
  const supply = supplyRaw?.[0] ?? 0n;
  const supplyUnits = units(supply, decimals);
  const tokenPrice = priceFor(prices, token.chainId, token.address);
  const asset = assetRaw?.[0] || token.asset || null;
  const assetPrice = priceFor(prices, token.chainId, asset);

  // Determine asset decimals based on known assets
  let assetDecimals = 18;
  if (token.assetSymbol === "USDT" || token.assetSymbol === "USDC" || token.assetSymbol === "bfUSD") assetDecimals = 6;
  if (token.assetSymbol === "WBTC" || token.assetSymbol === "BTCB" || token.assetSymbol === "cbBTC") assetDecimals = 8;
  if (token.assetSymbol === "hemiBTC") assetDecimals = 8;

  const totalAssetsValue = totalAssetsRaw?.[0];
  const convertAssetsOne = stratRaw?.[0];

  return {
    ...token,
    chain: chain.chain,
    ...basic,
    symbol: symbolRaw?.[0] || null,
    name: nameRaw?.[0] || null,
    decimals,
    totalSupplyRaw: supply.toString(),
    totalSupply: formatUnits(supply, decimals),
    priceUsd: tokenPrice,
    totalSupplyUsd: tokenPrice && supplyUnits !== null ? tokenPrice * supplyUnits : null,
    assetProbe: asset,
    totalAssetsRaw: totalAssetsValue?.toString() || null,
    totalAssets: totalAssetsValue !== undefined ? formatUnits(totalAssetsValue, assetDecimals) : null,
    totalAssetsUsd: assetPrice && totalAssetsValue !== undefined ? assetPrice * units(totalAssetsValue, assetDecimals) : null,
    convertToAssetsOneShareRaw: convertAssetsOne?.toString() || null,
    convertToSharesOneAssetRaw: convertSharesRaw?.[0]?.toString() || null,
    previewRedeemOneShareRaw: previewRedeemRaw?.[0]?.toString() || null,
    previewDepositOneAssetRaw: previewDepositRaw?.[0]?.toString() || null,
    maxDepositRaw: maxDepositRaw?.[0]?.toString() || null,
    maxMintRaw: maxMintRaw?.[0]?.toString() || null,
    maxWithdrawRaw: maxWithdrawRaw?.[0]?.toString() || null,
    maxRedeemRaw: maxRedeemRaw?.[0]?.toString() || null,
    dexPools: pools,
    topDexLiquidityUsd: pools.length ? Math.max(...pools.map((row) => Number(row.reserveUsd || 0))) : 0,
    localMatches: localAddressMatches(token.address),
  };
}

async function contractMeta(provider, contract) {
  const chain = CHAINS[contract.chainId];
  const [basic, pausedRaw, ownerRaw] = await Promise.all([
    scanAddress(provider, contract.chainId, contract.address),
    call(provider, contract.address, REDEEMER_ABI, "paused"),
    call(provider, contract.address, REDEEMER_ABI, "owner"),
  ]);

  // Try various redeemer/minter selectors
  const [feeBpsRaw, quotaRaw, remainingQuotaRaw, redeemedTodayRaw, settlementDelayRaw, maxMintRaw] = await Promise.all([
    call(provider, contract.address, REDEEMER_ABI, "instantRedeemFeeBps").catch(() => null) || call(provider, contract.address, REDEEMER_ABI, "feeBps"),
    call(provider, contract.address, REDEEMER_ABI, "quota"),
    call(provider, contract.address, REDEEMER_ABI, "remainingQuota"),
    call(provider, contract.address, REDEEMER_ABI, "redeemedToday"),
    call(provider, contract.address, REDEEMER_ABI, "settlementDelay"),
    call(provider, contract.address, MINTER_ABI, "maxMint"),
  ]);

  return {
    ...contract,
    chain: chain.chain,
    ...basic,
    paused: pausedRaw?.[0] ?? null,
    owner: ownerRaw?.[0] || null,
    feeBps: feeBpsRaw?.[0]?.toString() || null,
    quota: quotaRaw?.[0]?.toString() || null,
    remainingQuota: remainingQuotaRaw?.[0]?.toString() || null,
    redeemedToday: redeemedTodayRaw?.[0]?.toString() || null,
    settlementDelay: settlementDelayRaw?.[0]?.toString() || null,
    maxMint: maxMintRaw?.[0]?.toString() || null,
    localMatches: localAddressMatches(contract.address),
  };
}

async function main() {
  const prices = await priceMap(TOKENS);
  const tokenRows = [];
  const contractRows = [];
  const rpcBlocked = [];

  for (const chainId of [...new Set(TOKENS.map((row) => row.chainId))]) {
    const rpc = await resolveRpc(chainId);
    if (!rpc) {
      rpcBlocked.push({ protocol: "BitFi Basis", chain: CHAINS[chainId].chain, chainId, missingEndpointClass: "EVM RPC", skippedChecks: ["token/vault state", "ERC4626 NAV", "consumer joins"] });
      continue;
    }
    const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    for (const token of TOKENS.filter((row) => row.chainId === chainId)) tokenRows.push(await tokenMeta(provider, token, prices));
  }

  // Probe Ethereum-only contracts
  const ethRpc = await resolveRpc(1);
  if (ethRpc) {
    const provider = new ethers.JsonRpcProvider(ethRpc, 1, { staticNetwork: true });
    for (const contract of CONTRACTS) contractRows.push(await contractMeta(provider, contract));
    // Check Ceffu BTCB custody balance
    for (const custody of CONTRACTS.filter((row) => row.label === "Ceffu-BTCB-Custody")) {
      const btcb = "0x7130d2A12BfeBC0F1A6016464135747C254cFec1"; // BTCB on BSC - but this is Ethereum
      // On Ethereum, the custody address might hold WBTC or other assets
      // Check WBTC balance
      const wbtcContract = new ethers.Contract("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", ERC20_ABI, provider);
      const wbtcBalance = await wbtcContract.balanceOf(custody.address).catch(() => null);
      custody.wbtcBalanceRaw = wbtcBalance?.toString() || null;
      custody.wbtcBalance = wbtcBalance ? formatUnits(wbtcBalance, 8) : null;
      custody.wbtcBalanceUsd = wbtcBalance ? Number(ethers.formatUnits(wbtcBalance, 8)) * (priceFor(prices, 1, "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599") || 0) : null;
    }
  } else {
    rpcBlocked.push({ protocol: "BitFi Basis", chain: "Ethereum", chainId: 1, missingEndpointClass: "EVM RPC", skippedChecks: ["redeemer/minter/custody state"] });
  }

  const metadata = await fetchJson("https://api.llama.fi/protocol/bitfi-basis", 45_000);
  const currentTvlUsd = Array.isArray(metadata?.tvl) && metadata.tvl.length ? metadata.tvl[metadata.tvl.length - 1].totalLiquidityUSD : metadata?.tvl;

  const localArtifactMatchRows = tokenRows.reduce((sum, row) => sum + (row.localMatches || []).reduce((s, m) => s + m.count, 0), 0) + contractRows.reduce((sum, row) => sum + (row.localMatches || []).reduce((s, m) => s + m.count, 0), 0);
  const dexRows = tokenRows.filter((row) => Number(row.topDexLiquidityUsd || 0) >= 10000);
  const vaultRows = tokenRows.filter((row) => row.label === "hbfUSD" || row.label === "pbfUSD");

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-bitfi-basis-prefilter.js",
    scope: "BitFi Basis bfBTC/bfUSD/hbfUSD/pbfUSD route prefilter",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false, forkJustified: false },
    metadata: metadata ? { name: metadata.name, slug: metadata.slug || "bitfi-basis", category: metadata.category, currentTvlUsd, chains: metadata.chains || [], audits: metadata.audits || null, url: metadata.url || null, adapter: metadata.module || "bitfi-cedefi/index.js", chainTvls: metadata.currentChainTvls || {} } : { ok: false },
    adapter: {
      source: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/bitfi-cedefi/index.js",
      methodology: "Adapter reads bfBTC.totalSupply() per chain and values at market price. Backing is off-chain BTC custody at Ceffu/Binance/OKX/Bybit.",
      backingWallets: {
        ceffuBTC: ["1BmKSPG4AcCNkxC29tQVXF6vfK9hvxUtRL", "1BNpsNMq96ypaPmH8zuYLAxHPxYQQdXEvU", "1BNmwHhD4SAogR1fxpZnNCEWrVqA1Djdjb", "1BR8fqjuapewZy6HjBHTHZthTot3pMT55y", "1BK4YdJCSmJNa6ptNwGb6M67ioivFuQQTe"],
        ceffuBTCB: "0x062900dcd4729af3bdbf3150b98eb9bcfdb822ac",
        binanceBTC: ["1J8hRVttPiZya2GnfZbBaQj2zxonbTn2cH", "1Mx5gBkvGqy8LPYcJfJ7yjhA5oVzLrNGFg", "15EBS4TJs7BfjDn9EeMzBhaDv4bddfWuNT", "1PqY7uSCCAMYfTvnJX6TpeZZxKWQjMjjgZ"],
        okxBTC: ["bc1qksyye79f03pr4uezx5ddtr5ap65ug3j3vfmds5arkfwtr4fjtt5qnnxnyk", "3LEt6F46QjBCrMMMp8getCrpjBmN6brXoG"],
        bybitBTC: ["1DGZtD885npNLuCvNFRwa5uh4m1TR5WpYz"],
      },
      oracle: { bfBTC: "RedStone bfbtc_fundamental (single-source)", bfUSD: "Chainlink USDC/USD for stablecoin drift" },
    },
    tokenRows,
    contractRows,
    rpcBlocked,
    consumerContext: {
      localArtifactMatchRows,
      localMatches: [...tokenRows, ...contractRows].filter((row) => (row.localMatches || []).length).map((row) => ({ chain: row.chain, label: row.label, address: row.address, localMatches: row.localMatches })),
      dexLiquidityRows: dexRows.map((row) => ({ chain: row.chain, label: row.label, address: row.address, topDexLiquidityUsd: row.topDexLiquidityUsd, pools: row.dexPools })),
      vaultRows: vaultRows.map((row) => ({ chain: row.chain, label: row.label, address: row.address, totalAssets: row.totalAssets, totalAssetsUsd: row.totalAssetsUsd, maxDeposit: row.maxDepositRaw, maxMint: row.maxMintRaw, convertToAssetsOneShare: row.convertToAssetsOneShareRaw, previewRedeemOneShare: row.previewRedeemOneShareRaw })),
    },
    summary: {
      tokenRows: tokenRows.length,
      codePresentRows: tokenRows.filter((row) => row.codePresent).length,
      vaultRows: vaultRows.length,
      vaultRowsWithCode: vaultRows.filter((row) => row.codePresent).length,
      contractRows: contractRows.length,
      contractRowsWithCode: contractRows.filter((row) => row.codePresent).length,
      totalSupplyUsd: tokenRows.filter((row) => row.label === "bfBTC").reduce((sum, row) => sum + Number(row.totalSupplyUsd || 0), 0),
      vaultTotalAssetsUsd: vaultRows.reduce((sum, row) => sum + Number(row.totalAssetsUsd || 0), 0),
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
      "bfBTC backing is off-chain BTC custody at Ceffu/Binance/OKX/Bybit, not on-chain collateralized; no on-chain proof/bypass exists",
      "bfBTC uses a single RedStone oracle (bfbtc_fundamental); no lending consumer has been joined yet",
      "bfUSD redemption is either instant (0.5% fee + quota gate) or standard (3-epoch delay), both capital-gated/timelocked",
      "hbfUSD and pbfUSD have supply caps that may block new deposits; no consumer join or DEX exit route is proven",
      "No exact positive acquire->redeem/borrow/liquidation/unwind route after fees, slippage, caps, and gas",
    ],
    nextRoutePositiveCriteria: [
      "bfBTC or bfUSD is accepted by a live lending consumer with material borrow cash and overvalues it versus market/redeem value",
      "hbfUSD or pbfUSD share price can be donated/inflated and the inflated shares accepted as collateral with positive borrow economics",
      "bfUSD instant redemption quota plus DEX acquisition creates a positive arbitrage after the 0.5% fee, slippage, and gas",
    ],
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`BitFi prefilter: tokens=${tokenRows.length} vaults=${vaultRows.length} contracts=${contractRows.length} dexRows=${dexRows.length} artifactMatches=${localArtifactMatchRows} routePositive=0 rpcBlocked=${rpcBlocked.length}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});