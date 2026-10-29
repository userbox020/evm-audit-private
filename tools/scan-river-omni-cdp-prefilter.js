#!/usr/bin/env node
// Read-only River Omni-CDP (Satoshi Protocol) route prefilter.
// RPC URLs are resolved in memory only via shared-rpc and are never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "prefilter-river-omni-cdp-route-prefilter.json");

const CHAINS = {
  1: { chain: "Ethereum", llamaKey: "ethereum", geckoNetwork: "ethereum" },
  56: { chain: "BSC", llamaKey: "bsc", geckoNetwork: "bsc" },
  8453: { chain: "Base", llamaKey: "base", geckoNetwork: "base" },
  42161: { chain: "Arbitrum", llamaKey: "arbitrum", geckoNetwork: "arbitrum" },
};

const TROVE_ABI = new ethers.Interface([
  "uint256:getEntireSystemColl",
  "address:collateralToken",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
]);

const NYM_ABI = new ethers.Interface([
  "function debtTokenMinted(address asset) view returns (uint256)",
  "function convertDebtTokenToAssetAmount(address asset, uint256 amount) view returns (uint256)",
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
]);

const ERC20_ABI = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);

const TROVES = [
  // Ethereum (active V2)
  { chainId: 1, label: "WETH-TroveV2", address: "0xb97E6219B0836E21ae671358e746f03dcdbCb6D8", collateral: "WETH" },
  { chainId: 1, label: "WBTC-TroveV2", address: "0xc03403DD8f27CEFA314Fc109D26777c81b0De895", collateral: "WBTC" },
  { chainId: 1, label: "weETH-TroveV2", address: "0x2135EfEF5aC35ba549Cc791cEc4D15E8C8115611", collateral: "weETH" },
  { chainId: 1, label: "uniBTC-TroveV2", address: "0x43891fa695f17E47C9b2A0DFD9fb48147d331934", collateral: "uniBTC" },
  { chainId: 1, label: "LBTC-TroveV2", address: "0x9644652540f78f9e27899a655067f205f9454a4a", collateral: "LBTC" },
  { chainId: 1, label: "enzoBTC-TroveV2", address: "0x4077ACA146357E1FbFF981939D7229aF9Fdc329A", collateral: "enzoBTC" },
  // BSC
  { chainId: 56, label: "WBTC-TroveV2", address: "0xb655775C4C7C6e0C2002935133c950FB89974928", collateral: "WBTC" },
  { chainId: 56, label: "BTCB-TroveV2", address: "0x5EA26D0A1a9aa6731F9BFB93fCd654cd1C3079Ec", collateral: "BTCB" },
  { chainId: 56, label: "SolvBTC-TroveV2", address: "0xDAc0551246A7F75503e8C908456005E828C35A40", collateral: "SolvBTC" },
  // Base
  { chainId: 8453, label: "WETH-TroveV2", address: "0xddac7d4e228c205197FE9961865FFE20173dE56B", collateral: "WETH" },
  { chainId: 8453, label: "WBTC-TroveV2", address: "0x4B37F38DF39C9E6D876b830ED3FF444533Aa2E45", collateral: "WBTC" },
  { chainId: 8453, label: "cbBTC-TroveV2", address: "0x50B02283f3c39A463DF3d84d44d46b5432D7D193", collateral: "cbBTC" },
  { chainId: 8453, label: "uniBTC-TroveV2", address: "0x5245E3CaD937C7086294A6d21F3C67a20309e313", collateral: "uniBTC" },
  // Arbitrum
  { chainId: 42161, label: "WETH-TroveV2", address: "0xb655775C4C7C6e0C2002935133c950FB89974928", collateral: "WETH" },
  { chainId: 42161, label: "WBTC-TroveV2", address: "0x5EA26D0A1a9aa6731F9BFB93fCd654cd1C3079Ec", collateral: "WBTC" },
  { chainId: 42161, label: "clBTC-TroveV2", address: "0xa7B54413129441e872F42C1c4fE7D1984332CA87", collateral: "clBTC" },
];

const NYM_CONTRACTS = [
  { chainId: 1, label: "NYM-1", address: "0x07BbC5A83B83a5C440D1CAedBF1081426d0AA4Ec", assets: ["USDT", "USDC"] },
  { chainId: 1, label: "NYM-2", address: "0xb8374e4DfF99202292da2FE34425e1dE665b67E6", assets: ["USDT", "USDC", "CRVUSD"] },
  { chainId: 56, label: "NYM-BSC", address: "0x07BbC5A83B83a5C440D1CAedBF1081426d0AA4Ec", assets: ["USDT", "USDC", "DAI", "USD1", "FDUSD"] },
  { chainId: 8453, label: "NYM-Base", address: "0x9a3c724ee9603A7550499bE73DC743B371811dd3", assets: ["USDT", "USDC", "DAI"] },
  { chainId: 42161, label: "NYM-Arb", address: "0x07BbC5A83B83a5C440D1CAedBF1081426d0AA4Ec", assets: ["USDT", "USDC", "USDC_N", "USDe", "sUSDe", "DAI"] },
];

const RIVER_TOKEN = { chainId: 1, label: "RIVER", address: "0xdA7AD9dea9397cffdDAE2F8a052B82f1484252B3" };

const SATUSD_CANDIDATES = [
  { chainId: 1, address: "0x5917901B88f2dB1c9a85e6FCFAaC7c8a1cC9Dd5C" },
  { chainId: 56, address: "0x1705EF0A14D8b8E5174CF40833a8cA13295D3a3F" },
];

const LOCAL_MATCH_FILES = [
  "consumer-first-high-ltv-collateral.json",
  "euler-v2-phase0.json",
  "silo-v2-phase0.json",
  "aave-euler-silo-consumer-graph.json",
  "erc4626-consumer-joiner.json",
  "rwa-nav-consumer-graph.json",
  "morpho-high-apy-liquidation-routes.json",
  "current-profit-leads.json",
  "route-positive-sweep.json",
];
const LOCAL_TEXT_CACHE = new Map();

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

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
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-river/1.0" }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(t); }
}

async function sourcifyStatus(chainId, address) {
  for (const prefix of ["full_match", "partial_match"]) {
    const url = `https://repo.sourcify.dev/contracts/${prefix}/${chainId}/${address}/metadata.json`;
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-river/1.0" } }).catch(() => null);
    if (res?.ok) return { verified: true, source: prefix === "full_match" ? "sourcify-full" : "sourcify-partial" };
  }
  return { verified: false, source: null };
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

async function geckoPools(chainId, address) {
  const chainMap = { ethereum: "ethereum", bsc: "bsc", base: "base", arbitrum: "arbitrum" };
  const network = chainMap[CHAINS[chainId]?.llamaKey];
  if (!network) return [];
  const json = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/pools?page=1`, 20_000);
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.slice(0, 5).map((row) => ({ pool: row.id, dex: row.relationships?.dex?.data?.id || null, name: row.attributes?.name || null, reserveUsd: row.attributes?.reserve_in_usd ? Number(row.attributes.reserve_in_usd) : null, baseTokenPriceUsd: row.attributes?.base_token_price_usd ? Number(row.attributes.base_token_price_usd) : null }));
}

async function priceMap(addresses) {
  const ids = new Set();
  for (const { chainId, address } of addresses) {
    const chain = CHAINS[chainId];
    if (chain) ids.add(`${chain.llamaKey}:${address}`);
  }
  ids.add("coingecko:bitcoin");
  ids.add("coingecko:ethereum");
  const json = await fetchJson(`https://coins.llama.fi/prices/current/${Array.from(ids).join(",")}?searchWidth=6h`, 30_000);
  return json?.coins || {};
}

function priceFor(prices, chainId, address) {
  const chain = CHAINS[chainId];
  return Number(prices[`${chain?.llamaKey}:${address}`]?.price || 0) || null;
}

async function scanTrove(provider, trove) {
  const [code, implRaw, collateralTokenRaw, entireSystemCollRaw, pausedRaw, ownerRaw, sourceStatus] = await Promise.all([
    provider.getCode(trove.address).catch(() => "0x"),
    provider.getStorage(trove.address, EIP1967_IMPL).catch(() => null),
    call(provider, trove.address, TROVE_ABI, "collateralToken"),
    call(provider, trove.address, TROVE_ABI, "getEntireSystemColl"),
    call(provider, trove.address, TROVE_ABI, "paused"),
    call(provider, trove.address, TROVE_ABI, "owner"),
    sourcifyStatus(trove.chainId, trove.address),
  ]);
  return {
    ...trove,
    chain: CHAINS[trove.chainId].chain,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
    proxy: { eip1967Implementation: slotAddress(implRaw) },
    sourceStatus,
    collateralToken: collateralTokenRaw?.[0] || null,
    entireSystemCollRaw: entireSystemCollRaw?.[0]?.toString() || null,
    entireSystemColl: entireSystemCollRaw?.[0] !== undefined ? formatUnits(entireSystemCollRaw[0], 18) : null,
    paused: pausedRaw?.[0] ?? null,
    owner: ownerRaw?.[0] || null,
    localMatches: localAddressMatches(trove.address),
  };
}

async function scanNYM(provider, nym, stablecoinAddresses) {
  const [code, implRaw, ownerRaw, pausedRaw, sourceStatus] = await Promise.all([
    provider.getCode(nym.address).catch(() => "0x"),
    provider.getStorage(nym.address, EIP1967_IMPL).catch(() => null),
    call(provider, nym.address, NYM_ABI, "owner"),
    call(provider, nym.address, NYM_ABI, "paused"),
    sourcifyStatus(nym.chainId, nym.address),
  ]);

  // Probe debtTokenMinted for each asset
  const debtRows = [];
  for (const [symbol, assetAddr] of Object.entries(stablecoinAddresses)) {
    const debtMinted = await call(provider, nym.address, NYM_ABI, "debtTokenMinted", [assetAddr]);
    let convertedAmount = null;
    if (debtMinted?.[0] && debtMinted[0] > 0n) {
      const converted = await call(provider, nym.address, NYM_ABI, "convertDebtTokenToAssetAmount", [assetAddr, debtMinted[0]]);
      convertedAmount = converted?.[0]?.toString() || null;
    }
    debtRows.push({
      assetSymbol: symbol,
      assetAddress: assetAddr,
      debtTokenMintedRaw: debtMinted?.[0]?.toString() || "0",
      debtTokenMinted: debtMinted?.[0] !== undefined ? formatUnits(debtMinted[0], 18) : null,
      convertedAssetAmountRaw: convertedAmount,
      convertedAssetAmount: convertedAmount !== null ? formatUnits(convertedAmount, 18) : null,
    });
  }

  return {
    ...nym,
    chain: CHAINS[nym.chainId].chain,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
    proxy: { eip1967Implementation: slotAddress(implRaw) },
    sourceStatus,
    owner: ownerRaw?.[0] || null,
    paused: pausedRaw?.[0] ?? null,
    debtRows,
    localMatches: localAddressMatches(nym.address),
  };
}

async function scanToken(provider, token, prices) {
  const chain = CHAINS[token.chainId];
  const [code, symbolRaw, nameRaw, decimalsRaw, supplyRaw, pools, sourceStatus] = await Promise.all([
    provider.getCode(token.address).catch(() => "0x"),
    call(provider, token.address, ERC20_ABI, "symbol"),
    call(provider, token.address, ERC20_ABI, "name"),
    call(provider, token.address, ERC20_ABI, "decimals"),
    call(provider, token.address, ERC20_ABI, "totalSupply"),
    geckoPools(token.chainId, token.address),
    sourcifyStatus(token.chainId, token.address),
  ]);
  const decimals = Number(decimalsRaw?.[0] ?? 18n);
  const supply = supplyRaw?.[0] ?? 0n;
  const supplyUnits = Number(formatUnits(supply, decimals) || 0);
  const tokenPrice = priceFor(prices, token.chainId, token.address);
  return {
    ...token,
    chain: chain.chain,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
    sourceStatus,
    symbol: symbolRaw?.[0] || null,
    name: nameRaw?.[0] || null,
    decimals,
    totalSupplyRaw: supply.toString(),
    totalSupply: formatUnits(supply, decimals),
    priceUsd: tokenPrice,
    totalSupplyUsd: tokenPrice ? tokenPrice * supplyUnits : null,
    dexPools: pools,
    topDexLiquidityUsd: pools.length ? Math.max(...pools.map((r) => Number(r.reserveUsd || 0))) : 0,
    localMatches: localAddressMatches(token.address),
  };
}

// Known stablecoin addresses for NYM asset probes
const STABLECOIN_ADDRESSES = {
  1: { USDT: "0xdAC17F958D2ee523a2206206994597C13d831ec7", USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", CRVUSD: "0xf939E0A03fb07F7A1D85c442c8E6025279bf2115" },
  56: { USDT: "0x55d398368f2a12Ba4472C7122d3F96a8c84Fd8D7", USDC: "0x8AC76A51cc950d9822DA68b8E4FEa36012F36d4d", DAI: "0x1AF3F329e8BE154074D8769D1BBaF1cae9268F15", USD1: "0x73a15FeD60Bf67631dC6cd7Bc5B6e8da8190aCF5", FDUSD: "0xc5f0f7B91d8c0F4c8Ad8516CBC04a84B73e75F87" },
  8453: { USDT: "0xfde4C96c8593536E59F887b41bc1f025b3e22c49", USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" },
  42161: { USDT: "0xFd086bD7AF09Db3D31424D5B4Fb9dB69B9f3e4d9", USDC: "0xFF970A61A04b1cA14834A43f5dE4533EbEDBd366", USDC_N: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", USDe: "0x5d3a1E510eEA09e4c70299043272D59B68BF402a", sUSDe: "0x5979D7b546E38E414F7E9822514be695667A7868", DAI: "0xDA10009cBd5D07dd0CeCc66161293c2e28154725" },
};

async function main() {
  const metadata = await fetchJson("https://api.llama.fi/protocol/river-omni-cdp", 45_000);
  const currentTvlUsd = metadata?.currentChainTvls ? Object.values(metadata.currentChainTvls).reduce((s, v) => s + Number(v || 0), 0) : null;

  // Collect all addresses for pricing
  const allPriceAddresses = [...TROVES.map((t) => ({ chainId: t.chainId, address: t.address })), ...NYM_CONTRACTS.map((n) => ({ chainId: n.chainId, address: n.address })), RIVER_TOKEN, ...SATUSD_CANDIDATES];
  const prices = await priceMap(allPriceAddresses);

  const troveRows = [];
  const nymRows = [];
  const tokenRows = [];
  const rpcBlocked = [];

  for (const chainId of [...new Set(TROVES.map((t) => t.chainId))]) {
    const rpc = await resolveRpc(chainId);
    if (!rpc) {
      rpcBlocked.push({ protocol: "River Omni-CDP", chain: CHAINS[chainId].chain, chainId, missingEndpointClass: "EVM RPC", skippedChecks: ["trove collateral", "NYM debt", "token state"] });
      continue;
    }
    const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    for (const trove of TROVES.filter((t) => t.chainId === chainId)) troveRows.push(await scanTrove(provider, trove));
    for (const nym of NYM_CONTRACTS.filter((n) => n.chainId === chainId)) nymRows.push(await scanNYM(provider, nym, STABLECOIN_ADDRESSES[chainId] || {}));
  }

  // Scan governance token and satUSD candidates
  const ethRpc = await resolveRpc(1);
  if (ethRpc) {
    const provider = new ethers.JsonRpcProvider(ethRpc, 1, { staticNetwork: true });
    tokenRows.push(await scanToken(provider, RIVER_TOKEN, prices));
    for (const sat of SATUSD_CANDIDATES.filter((s) => s.chainId === 1)) tokenRows.push(await scanToken(provider, sat, prices));
  }
  // BSC satUSD candidate
  const bscRpc = await resolveRpc(56);
  if (bscRpc) {
    const provider = new ethers.JsonRpcProvider(bscRpc, 56, { staticNetwork: true });
    for (const sat of SATUSD_CANDIDATES.filter((s) => s.chainId === 56)) tokenRows.push(await scanToken(provider, sat, prices));
  }

  const localArtifactMatchRows = [...troveRows, ...nymRows, ...tokenRows].reduce((sum, row) => sum + (row.localMatches || []).reduce((s, m) => s + m.count, 0), 0);
  const dexRows = tokenRows.filter((row) => Number(row.topDexLiquidityUsd || 0) >= 10000);
  const troveRowsWithColl = troveRows.filter((row) => row.entireSystemColl && Number(row.entireSystemColl) > 0);

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-river-omni-cdp-prefilter.js",
    scope: "River Omni-CDP (Satoshi Protocol) trove/NYM/token route prefilter",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false, forkJustified: false },
    metadata: {
      name: metadata?.name || "River Omni-CDP",
      slug: metadata?.slug || "river-omni-cdp",
      category: metadata?.category || "CeDeFi",
      currentTvlUsd,
      chains: metadata?.chains || [],
      audits: metadata?.audits || "3",
      url: metadata?.url || "https://app.river.inc/",
      adapter: metadata?.module || "satoshi-protocol/index.js",
      previousNames: metadata?.previousNames || ["Satoshi Protocol"],
      oraclesBreakdown: metadata?.oraclesBreakdown || [],
      chainTvls: metadata?.currentChainTvls || {},
      warningBanners: metadata?.warningBanners || [],
    },
    adapter: {
      source: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/satoshi-protocol/index.js",
      methodology: "Trove-based CDP (Liquity-fork). TVL = getEntireSystemColl per trove + debtTokenMinted/convertDebtTokenToAssetAmount per NYM + SmartVault deposits. satUSD stablecoin minted from collateral. Cross-chain via LayerZero OFT.",
      oracleSummary: {
        ethereum: "Chainlink 0.25-0.5% deviation, 3600-86400s heartbeat",
        bsc: "Chainlink primary, RedStone secondary on bfBTC, eOracle on some assets",
        base: "Chainlink 0.1-0.3%, Chainsight 10%/3600s on clBTC (wide band)",
        arbitrum: "Chainlink 0.05-0.1%, Chainsight 10%/3600s on clBTC (wide band)",
        hemi: "RedStone 0.5%/21600-86400s",
        bsquared: "APRO 0.5%/3600s",
        bevm: "DIA 0.5%/86400s",
        bob: "Chainlink 0.5%/86400s, Api3 on some assets",
        bitlayer: "APRO 0.5%/3600s",
      },
      keyRiskSurfaces: [
        "clBTC Chainsight oracle 10% deviation band on Arbitrum/Base — stale-price risk",
        "Cross-chain minting via LayerZero OFT — omni-CDP message tampering surface",
        "NYM convertDebtTokenToAssetAmount conversion math — rounding/rate risk",
        "Multi-oracle fallback logic (RedStone + eOracle on BSC/Hemi) — stale-handoff bugs",
      ],
    },
    troveRows,
    nymRows,
    tokenRows,
    rpcBlocked,
    consumerContext: {
      localArtifactMatchRows,
      localMatches: [...troveRows, ...nymRows, ...tokenRows].filter((row) => (row.localMatches || []).length).map((row) => ({ chain: row.chain, label: row.label, address: row.address, localMatches: row.localMatches })),
      dexLiquidityRows: dexRows.map((row) => ({ chain: row.chain, label: row.label, address: row.address, topDexLiquidityUsd: row.topDexLiquidityUsd, pools: row.dexPools })),
      troveRowsWithCollateral: troveRowsWithColl.map((row) => ({ chain: row.chain, label: row.label, address: row.address, collateral: row.collateral, collateralToken: row.collateralToken, entireSystemColl: row.entireSystemColl })),
    },
    summary: {
      troveRows: troveRows.length,
      troveRowsWithCode: troveRows.filter((r) => r.codePresent).length,
      troveRowsWithCollateral: troveRowsWithColl.length,
      nymRows: nymRows.length,
      nymRowsWithCode: nymRows.filter((r) => r.codePresent).length,
      tokenRows: tokenRows.length,
      tokenRowsWithCode: tokenRows.filter((r) => r.codePresent).length,
      localArtifactMatchRows,
      consumerJoinRows: 0,
      dexLiquidityRows: dexRows.length,
      maxDexLiquidityUsd: dexRows.length ? Math.max(...dexRows.map((r) => Number(r.topDexLiquidityUsd || 0))) : 0,
      exactEconomicsRows: 0,
      rpcBlockedRows: rpcBlocked.length,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      forkJustified: false,
    },
    blockers: [
      "No lending consumer has been joined to any River trove/NYM/satUSD address in local artifacts",
      "clBTC Chainsight oracle has 10% deviation band on Arbitrum/Base, but no consumer accepts clBTC-based satUSD as collateral with material borrow cash",
      "Cross-chain OFT minting surface exists but no proof-of-message-tampering or destination-chain oracle mismatch has been identified",
      "NYM debtTokenMinted conversion math is read-only context; no rounding/overflow exploit is proven",
      "No DEX exit liquidity or accepted-value divergence route is proven positive after fees, slippage, and gas",
    ],
    nextRoutePositiveCriteria: [
      "satUSD is accepted by a live lending consumer with material borrow cash and overvalues it versus market/redeem value",
      "clBTC Chainsight oracle returns a stale or manipulated price that is accepted by a trove, enabling over-borrowing or under-liquidation",
      "NYM convertDebtTokenToAssetAmount has a rounding/rate bug that allows extracting more assets than debt burned",
      "Cross-chain OFT message tampering mints satUSD on destination chain without matching collateral on source chain",
    ],
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`River prefilter: troves=${troveRows.length} trovesWithColl=${troveRowsWithColl.length} nym=${nymRows.length} tokens=${tokenRows.length} dexRows=${dexRows.length} artifactMatches=${localArtifactMatchRows} routePositive=0 rpcBlocked=${rpcBlocked.length}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});