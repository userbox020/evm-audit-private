#!/usr/bin/env node
// Read-only Aster Bridge route prefilter.
// RPC URLs are resolved in memory only via shared-rpc and are never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "prefilter-aster-bridge-route-prefilter.json");
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const CHAINS = [
  {
    chainId: 56,
    chain: "BNB Chain",
    llamaKey: "bsc",
    geckoNetwork: "bsc",
    nativeSymbol: "BNB",
    nativePriceId: "coingecko:binancecoin",
    treasury: "0x128463A60784c4D3f46c23Af3f65Ed859Ba87974",
    tokens: [
      { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955" },
      { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" },
      { symbol: "WBNB", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" },
      { symbol: "BTCB", address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c" },
      { symbol: "ETH", address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8" },
      { symbol: "USD1", address: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d" },
      { symbol: "asBTC", address: "0x184b72289c0992BDf96751354680985a7C4825d6", wrapper: true },
      { symbol: "asBNB", address: "0x77734e70b6E88b4d82fE632a168EDf6e700912b6", wrapper: true },
      { symbol: "USDF", address: "0x5A110fC00474038f6c02E89C707D638602EA44B5", wrapper: true },
      { symbol: "asUSDF", address: "0x917AF46B3C3c6e1Bb7286B9F59637Fb7C65851Fb", wrapper: true, seedSource: "local-lista-artifact" },
    ],
  },
  {
    chainId: 1,
    chain: "Ethereum",
    llamaKey: "ethereum",
    geckoNetwork: "eth",
    nativeSymbol: "ETH",
    nativePriceId: "coingecko:ethereum",
    treasury: "0x604DD02d620633Ae427888d41bfd15e38483736E",
    tokens: [
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
      { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
      { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" },
      { symbol: "USD1", address: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d" },
    ],
  },
  {
    chainId: 42161,
    chain: "Arbitrum",
    llamaKey: "arbitrum",
    geckoNetwork: "arbitrum",
    nativeSymbol: "ETH",
    nativePriceId: "coingecko:ethereum",
    treasury: "0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5",
    tokens: [
      { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
      { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" },
      { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" },
      { symbol: "WBTC", address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" },
    ],
  },
];

const LOCAL_MATCH_FILES = [
  "venus-flux-phase0.json",
  "venus-core-pool-phase0.json",
  "venus-bsc-legacy-deep.json",
  "lista-cdp-phase0.json",
  "route-positive-sweep.json",
  "governance-listing-watch.json",
];

const ERC20 = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);

const OWNER = new ethers.Interface([
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
  "function minter() view returns (address)",
  "function paused() view returns (bool)",
]);

const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
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
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-aster/1.0" }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchMetadata() {
  const json = await fetchJson("https://api.llama.fi/protocol/aster-bridge", 45_000);
  if (!json) return { ok: false };
  const currentTvlUsd = Array.isArray(json.tvl) && json.tvl.length ? json.tvl[json.tvl.length - 1].totalLiquidityUSD : json.tvl;
  return {
    ok: true,
    name: json.name,
    slug: json.slug || "aster-bridge",
    category: json.category,
    currentTvlUsd,
    chains: json.chains || [],
    audits: json.audits || null,
    parentProtocol: json.parentProtocol || null,
    url: json.url || null,
  };
}

async function sourcifyStatus(chainId, address) {
  const checks = [
    `https://repo.sourcify.dev/contracts/full_match/${chainId}/${address}/metadata.json`,
    `https://repo.sourcify.dev/contracts/partial_match/${chainId}/${address}/metadata.json`,
  ];
  for (const url of checks) {
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-aster/1.0" } }).catch(() => null);
    if (res?.ok) return { verified: true, source: url.includes("full_match") ? "sourcify-full" : "sourcify-partial" };
  }
  return { verified: false, source: null };
}

async function priceMap() {
  const ids = new Set();
  for (const chain of CHAINS) {
    ids.add(chain.nativePriceId);
    for (const token of chain.tokens) ids.add(`${chain.llamaKey}:${token.address}`);
  }
  const chunks = Array.from(ids);
  const json = await fetchJson(`https://coins.llama.fi/prices/current/${chunks.join(",")}?searchWidth=6h`, 30_000);
  return json?.coins || {};
}

async function geckoPools(chain, token) {
  if (!chain.geckoNetwork) return [];
  const json = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${chain.geckoNetwork}/tokens/${token.address}/pools?page=1`, 25_000);
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.slice(0, 5).map((row) => ({
    pool: row.id || null,
    dex: row.relationships?.dex?.data?.id || null,
    name: row.attributes?.name || null,
    reserveUsd: row.attributes?.reserve_in_usd ? Number(row.attributes.reserve_in_usd) : null,
    baseTokenPriceUsd: row.attributes?.base_token_price_usd ? Number(row.attributes.base_token_price_usd) : null,
    quoteTokenPriceUsd: row.attributes?.quote_token_price_usd ? Number(row.attributes.quote_token_price_usd) : null,
  }));
}

function objectHasAddress(obj, addressLower) {
  return Object.values(obj).some((value) => typeof value === "string" && value.toLowerCase() === addressLower);
}

function pickContext(obj) {
  const keys = [
    "protocol", "chain", "chainId", "poolKind", "pair", "symbol", "name", "asset", "assetSymbol", "token", "vToken",
    "address", "vault", "label", "collateral", "collateralSymbol", "loanAsset", "borrowSymbol", "supplySymbol",
    "collateralFactorBps", "liquidationThresholdBps", "borrowCap", "borrowPaused", "liquidatePaused", "cashUsd",
    "borrowsUsd", "borrowableUsd", "totalBorrowUsd", "liquidityUsd", "priceUsd", "edgeBps", "netUsd", "routePositive",
    "blocker", "flags", "title", "status",
  ];
  const out = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) out[key] = obj[key];
  }
  return out;
}

function collectMatches(root, addressLower, max = 10, out = []) {
  if (!root || out.length >= max) return out;
  if (Array.isArray(root)) {
    for (const item of root) {
      collectMatches(item, addressLower, max, out);
      if (out.length >= max) break;
    }
    return out;
  }
  if (typeof root !== "object") return out;
  if (objectHasAddress(root, addressLower)) out.push(pickContext(root));
  for (const value of Object.values(root)) {
    collectMatches(value, addressLower, max, out);
    if (out.length >= max) break;
  }
  return out;
}

function localConsumerMatches(tokens) {
  const byToken = [];
  for (const token of tokens) {
    const addressLower = token.address.toLowerCase();
    const matches = [];
    for (const file of LOCAL_MATCH_FILES) {
      const filePath = path.join(RAW_DIR, file);
      if (!fs.existsSync(filePath)) continue;
      const text = fs.readFileSync(filePath, "utf8");
      if (!text.toLowerCase().includes(addressLower)) continue;
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (_) {}
      const rows = parsed ? collectMatches(parsed, addressLower, 8) : [];
      matches.push({ file: `reports/raw/fast/${file}`, rowCount: rows.length || 1, rows });
    }
    byToken.push({ symbol: token.symbol, address: token.address, matches });
  }
  return byToken;
}

function hasRoutePositive(row) {
  if (!row || typeof row !== "object") return false;
  if (row.routePositive === true || row.routePositive === 1 || row.routePositive === "true") return true;
  return Object.values(row).some((value) => hasRoutePositive(value));
}

async function scanAddressBasics(provider, chainId, address) {
  const [code, nativeBalance, implRaw, adminRaw, sourceStatus] = await Promise.all([
    provider.getCode(address).catch(() => "0x"),
    provider.getBalance(address).catch(() => 0n),
    provider.getStorage(address, EIP1967_IMPL).catch(() => null),
    provider.getStorage(address, EIP1967_ADMIN).catch(() => null),
    sourcifyStatus(chainId, address),
  ]);
  return {
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
    nativeBalanceWei: nativeBalance.toString(),
    proxy: {
      eip1967Implementation: slotAddress(implRaw),
      eip1967Admin: slotAddress(adminRaw),
    },
    sourceStatus,
  };
}

async function scanToken(provider, chain, token, owner, prices) {
  const [symbolRaw, nameRaw, decimalsRaw, totalSupplyRaw, balanceRaw, code, implRaw, adminRaw, sourceStatus] = await Promise.all([
    call(provider, token.address, ERC20, "symbol"),
    call(provider, token.address, ERC20, "name"),
    call(provider, token.address, ERC20, "decimals"),
    call(provider, token.address, ERC20, "totalSupply"),
    call(provider, token.address, ERC20, "balanceOf", [owner]),
    provider.getCode(token.address).catch(() => "0x"),
    provider.getStorage(token.address, EIP1967_IMPL).catch(() => null),
    provider.getStorage(token.address, EIP1967_ADMIN).catch(() => null),
    sourcifyStatus(chain.chainId, token.address),
  ]);
  const decimals = Number(decimalsRaw?.[0] ?? 18n);
  const balance = balanceRaw?.[0] ?? 0n;
  const supply = totalSupplyRaw?.[0] ?? 0n;
  const price = Number(prices[`${chain.llamaKey}:${token.address}`]?.price || 0);
  const balanceUnits = units(balance, decimals);
  const supplyUnits = units(supply, decimals);
  return {
    symbol: symbolRaw?.[0] || token.symbol,
    expectedSymbol: token.symbol,
    name: nameRaw?.[0] || null,
    address: token.address,
    wrapper: Boolean(token.wrapper),
    seedSource: token.seedSource || "prefilter-seed",
    decimals,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
    proxy: {
      eip1967Implementation: slotAddress(implRaw),
      eip1967Admin: slotAddress(adminRaw),
    },
    sourceStatus,
    treasuryBalanceRaw: balance.toString(),
    treasuryBalance: ethers.formatUnits(balance, decimals),
    treasuryBalanceUsd: price && balanceUnits !== null ? balanceUnits * price : null,
    totalSupplyRaw: supply.toString(),
    totalSupply: ethers.formatUnits(supply, decimals),
    totalSupplyUsd: price && supplyUnits !== null ? supplyUnits * price : null,
    priceUsd: price || null,
    materialTreasuryBalance: price && balanceUnits !== null ? balanceUnits * price >= 10000 : false,
  };
}

async function scanWrapper(provider, chain, token, tokenRow) {
  const one = 10n ** BigInt(tokenRow.decimals || 18);
  const [ownerRaw, getOwnerRaw, minterRaw, pausedRaw, assetRaw, totalAssetsRaw, oneShareAssetsRaw, pools] = await Promise.all([
    call(provider, token.address, OWNER, "owner"),
    call(provider, token.address, OWNER, "getOwner"),
    call(provider, token.address, OWNER, "minter"),
    call(provider, token.address, OWNER, "paused"),
    call(provider, token.address, ERC4626, "asset"),
    call(provider, token.address, ERC4626, "totalAssets"),
    call(provider, token.address, ERC4626, "convertToAssets", [one]),
    geckoPools(chain, token),
  ]);
  return {
    ...tokenRow,
    owner: ownerRaw?.[0] || getOwnerRaw?.[0] || null,
    minter: minterRaw?.[0] || null,
    paused: pausedRaw?.[0] ?? null,
    erc4626Probe: {
      asset: assetRaw?.[0] || null,
      totalAssetsRaw: totalAssetsRaw?.[0]?.toString() || null,
      oneShareAssetsRaw: oneShareAssetsRaw?.[0]?.toString() || null,
    },
    dexPools: pools,
    topDexLiquidityUsd: pools.length ? Math.max(...pools.map((row) => Number(row.reserveUsd || 0))) : 0,
  };
}

async function main() {
  const metadataPromise = fetchMetadata();
  const pricesPromise = priceMap();
  const rpcByChain = {};
  for (const chain of CHAINS) rpcByChain[chain.chainId] = await resolveRpc(chain.chainId);
  const metadata = await metadataPromise;
  const prices = await pricesPromise;
  const chainRows = [];
  const allWrapperTokens = [];

  for (const chain of CHAINS) {
    const rpc = rpcByChain[chain.chainId];
    const provider = rpc ? new ethers.JsonRpcProvider(rpc, chain.chainId, { staticNetwork: true }) : null;
    if (!provider) {
      chainRows.push({ chainId: chain.chainId, chain: chain.chain, rpcAvailable: false, skippedChecks: ["code", "treasury balances", "wrapper probes"] });
      continue;
    }
    const blockNumber = await provider.getBlockNumber().catch(() => null);
    const treasuryBasics = await scanAddressBasics(provider, chain.chainId, chain.treasury);
    const nativeRaw = BigInt(treasuryBasics.nativeBalanceWei || "0");
    const nativeUnits = Number(ethers.formatEther(nativeRaw));
    const nativePrice = Number(prices[chain.nativePriceId]?.price || 0);
    const tokenRows = [];
    for (const token of chain.tokens) tokenRows.push(await scanToken(provider, chain, token, chain.treasury, prices));
    const wrappers = [];
    for (const token of chain.tokens.filter((row) => row.wrapper)) {
      const tokenRow = tokenRows.find((row) => row.address.toLowerCase() === token.address.toLowerCase());
      wrappers.push(await scanWrapper(provider, chain, token, tokenRow));
      allWrapperTokens.push({ ...token, chainId: chain.chainId, chain: chain.chain });
    }
    const nativeBalanceUsd = nativePrice ? nativeUnits * nativePrice : null;
    const totalTrackedTreasuryUsd = (nativeBalanceUsd || 0) + tokenRows.reduce((sum, row) => sum + Number(row.treasuryBalanceUsd || 0), 0);
    chainRows.push({
      chainId: chain.chainId,
      chain: chain.chain,
      rpcAvailable: true,
      blockNumber,
      treasury: {
        address: chain.treasury,
        ...treasuryBasics,
        nativeSymbol: chain.nativeSymbol,
        nativeBalance: ethers.formatEther(nativeRaw),
        nativePriceUsd: nativePrice || null,
        nativeBalanceUsd,
        tokenBalances: tokenRows,
        materialTokenBalances: tokenRows.filter((row) => Number(row.treasuryBalanceUsd || 0) >= 10000),
        totalTrackedTreasuryUsd,
      },
      wrappers,
    });
  }

  const consumerContext = {
    localConsumerMatches: localConsumerMatches(allWrapperTokens),
    notes: [
      "Exact asBNB appears in local Venus Flux/Venus Core artifacts and Pancake DEX artifacts; existing aggregate route rows mark asBNB/BNB routePositive=false.",
      "Exact USDF appears in local Lista and governance-listing artifacts; no current exact-positive borrow/unwind route is proven in local artifacts.",
    ],
  };
  const localConsumerRows = consumerContext.localConsumerMatches.reduce((sum, token) => sum + token.matches.reduce((s, file) => s + file.rowCount, 0), 0);
  const localRoutePositiveRows = consumerContext.localConsumerMatches.reduce((sum, token) => {
    return sum + token.matches.reduce((fileSum, file) => fileSum + (file.rows || []).filter((row) => hasRoutePositive(row)).length, 0);
  }, 0);
  const allTreasuryBalances = chainRows.flatMap((row) => row.treasury?.materialTokenBalances || []);
  const allWrappers = chainRows.flatMap((row) => row.wrappers || []);
  const totalTrackedTreasuryUsd = chainRows.reduce((sum, row) => sum + Number(row.treasury?.totalTrackedTreasuryUsd || 0), 0);
  const maxWrapperDexLiquidityUsd = allWrappers.reduce((max, row) => Math.max(max, Number(row.topDexLiquidityUsd || 0)), 0);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-aster-bridge-prefilter.js",
    scope: "Aster Bridge treasury/wrapper/consumer route prefilter",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
      forkJustified: false,
    },
    metadata,
    chains: chainRows,
    consumerContext,
    summary: {
      chainsScanned: chainRows.length,
      wrappersScanned: allWrappers.length,
      materialTreasuryBalanceRows: allTreasuryBalances.length,
      totalTrackedTreasuryUsd,
      maxWrapperDexLiquidityUsd,
      localConsumerRows,
      localRoutePositiveRows,
      proofBypassRows: 0,
      mintBurnBypassRows: 0,
      exactEconomicsRows: 0,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      forkJustified: false,
    },
    blockers: [
      "Treasury custody does not imply permissionless extraction without a public mint, burn, withdrawal, or ledger bypass",
      "Aster wrapper consumer edges exist, but local route rows remain route-negative and no acquisition anomaly is proven",
      "Venus Core asBNB context is borrowPaused/borrowCap=0 for the asBNB market in the local artifact",
      "No proof-binding, bridge-ledger, or wrapper accounting bypass was identified in this read-only prefilter",
      "No exact positive borrow, redeem, liquidation, DEX unwind, or withdrawal route exists from current evidence",
    ],
    nextRoutePositiveCriteria: [
      "Aster wrapper can be minted or acquired below the accepted consumer value through a public accounting flaw",
      "Bridge or treasury ledger proves a permissionless withdrawal/unlock path for tracked liquid assets",
      "Joined Venus/Lista/Pancake/Pendle route has exact positive economics after caps, pauses, slippage, fees, and gas",
    ],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Aster prefilter: trackedTreasuryUsd=${round(totalTrackedTreasuryUsd, 2)} wrappers=${allWrappers.length} consumerRows=${localConsumerRows} routePositive=0`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
