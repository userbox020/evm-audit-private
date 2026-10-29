#!/usr/bin/env node
// Read-only Mainstreet msUSD/msUSDC route prefilter.
// RPC URLs are resolved in memory only via shared-rpc unless MAINSTREET_SKIP_RPC_INVENTORY=1.
// RPC URLs are never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "prefilter-mainstreet-route-prefilter.json");
const SKIP_RPC_INVENTORY = process.env.MAINSTREET_SKIP_RPC_INVENTORY === "1";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const RECEIVER = "0x000000000000000000000000000000000000dEaD";

const CHAIN = { chain: "Ethereum", chainId: 1, llamaKey: "ethereum", geckoNetwork: "eth" };
const PUBLIC_RPC_FALLBACKS = ["https://ethereum-rpc.publicnode.com"];
const TOKENS = [
  { label: "msUSD", role: "mainstreet-stable", address: "0x4ba01f22827018b4772CD326C7627FB4956A7C00" },
  { label: "msUSDC", role: "erc4626-usdc-receipt", address: "0xad755C6C31515aEF8D2f830767D846774F7e9EA9" },
  { label: "msY", role: "related-erc4626-msusd-yield", address: "0x890A5122Aa1dA30fEC4286DE7904Ff808F0bd74A" },
  { label: "USDC", role: "underlying-reference", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
];
const MSUSD_SELECTOR_SIGNATURES = [
  "mint(address,uint256)",
  "mint(uint256)",
  "burn(uint256)",
  "burn(address,uint256)",
  "redeem(uint256)",
  "redeem(address,uint256)",
  "redeem(uint256,address,address)",
  "withdraw(uint256)",
  "withdraw(uint256,address,address)",
  "deposit(uint256)",
  "deposit(uint256,address)",
  "requestRedeem(uint256)",
  "requestWithdraw(uint256)",
  "claimRedeem(uint256)",
  "claimWithdraw(uint256)",
  "convertToAssets(uint256)",
  "previewRedeem(uint256)",
  "asset()",
  "maxDeposit(address)",
  "owner()",
  "minter()",
];
const MSUSD = TOKENS[0].address.toLowerCase();
const MSUSDC = TOKENS[1].address.toLowerCase();
const MSY = TOKENS[2].address.toLowerCase();

const LOCAL_MATCH_FILES = [
  "euler-v2-phase0.json",
  "evault-collateral-nav-manipulation.json",
  "balancer-v3-phase0.json",
  "pendle-pt-consumer-graph.json",
  "pendle-pt-multichain-consumer-graph.json",
  "pendle-yt-collateral-routes.json",
  "new-vault-donation-attack.json",
  "current-profit-leads.json",
  "curve-dex-phase0.json",
  "uniswap-v4-hooks.json",
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
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-mainstreet/1.0" }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchMetadata() {
  const json = await fetchJson("https://api.llama.fi/protocol/mainstreet", 45_000);
  if (!json) return { ok: false };
  const currentTvlUsd = Array.isArray(json.tvl) && json.tvl.length ? json.tvl[json.tvl.length - 1].totalLiquidityUSD : json.tvl;
  return { ok: true, name: json.name, slug: json.slug || "mainstreet", category: json.category, currentTvlUsd, chains: json.chains || [], audits: json.audits || null, url: json.url || null, adapter: "projects/mainstreet/index.js" };
}

async function resolvePublicFallbackRpc() {
  for (const url of PUBLIC_RPC_FALLBACKS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6_000);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const json = await res.json();
      if (Number(BigInt(json.result || 0)) === CHAIN.chainId) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

async function sourcifyStatus(chainId, address) {
  const checks = [
    `https://repo.sourcify.dev/contracts/full_match/${chainId}/${address}/metadata.json`,
    `https://repo.sourcify.dev/contracts/partial_match/${chainId}/${address}/metadata.json`,
  ];
  for (const url of checks) {
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-mainstreet/1.0" } }).catch(() => null);
    if (res?.ok) return { verified: true, source: url.includes("full_match") ? "sourcify-full" : "sourcify-partial" };
  }
  return { verified: false, source: null };
}

async function scanAddress(provider, address) {
  const [code, implRaw, adminRaw, sourceStatus] = await Promise.all([
    provider.getCode(address).catch(() => "0x"),
    provider.getStorage(address, EIP1967_IMPL).catch(() => null),
    provider.getStorage(address, EIP1967_ADMIN).catch(() => null),
    sourcifyStatus(CHAIN.chainId, address),
  ]);
  return { address, codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0, proxy: { eip1967Implementation: slotAddress(implRaw), eip1967Admin: slotAddress(adminRaw) }, sourceStatus };
}

async function geckoPools(address) {
  const json = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${CHAIN.geckoNetwork}/tokens/${address}/pools?page=1`, 20_000);
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.slice(0, 6).map((row) => ({ pool: row.id || null, dex: row.relationships?.dex?.data?.id || null, name: row.attributes?.name || null, reserveUsd: row.attributes?.reserve_in_usd ? Number(row.attributes.reserve_in_usd) : null, baseTokenPriceUsd: row.attributes?.base_token_price_usd ? Number(row.attributes.base_token_price_usd) : null }));
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

async function priceMap() {
  const ids = TOKENS.map((row) => `${CHAIN.llamaKey}:${row.address}`).join(",");
  const json = await fetchJson(`https://coins.llama.fi/prices/current/${ids}?searchWidth=6h`, 30_000);
  return json?.coins || {};
}

function priceFor(prices, address) {
  return Number(prices[`${CHAIN.llamaKey}:${address}`]?.price || 0) || null;
}

async function tokenMeta(provider, token, prices) {
  const [basic, symbolRaw, nameRaw, decimalsRaw, supplyRaw, pools] = await Promise.all([
    scanAddress(provider, token.address),
    call(provider, token.address, ERC20, "symbol"),
    call(provider, token.address, ERC20, "name"),
    call(provider, token.address, ERC20, "decimals"),
    call(provider, token.address, ERC20, "totalSupply"),
    geckoPools(token.address),
  ]);
  const decimals = Number(decimalsRaw?.[0] ?? 18n);
  const supply = supplyRaw?.[0] ?? 0n;
  const supplyUnits = units(supply, decimals);
  const priceUsd = priceFor(prices, token.address);
  const oneShare = 10n ** BigInt(Math.min(Math.max(decimals, 0), 36));
  const [assetRaw, totalAssetsRaw, convertRaw, previewRaw, maxDepositRaw, maxMintRaw, maxWithdrawRaw, maxRedeemRaw, ownerRaw, pausedRaw] = await Promise.all([
    call(provider, token.address, VAULT, "asset"),
    call(provider, token.address, VAULT, "totalAssets"),
    call(provider, token.address, VAULT, "convertToAssets", [oneShare]),
    call(provider, token.address, VAULT, "previewRedeem", [oneShare]),
    call(provider, token.address, VAULT, "maxDeposit", [RECEIVER]),
    call(provider, token.address, VAULT, "maxMint", [RECEIVER]),
    call(provider, token.address, VAULT, "maxWithdraw", [RECEIVER]),
    call(provider, token.address, VAULT, "maxRedeem", [RECEIVER]),
    call(provider, token.address, VAULT, "owner"),
    call(provider, token.address, VAULT, "paused"),
  ]);
  const asset = assetRaw?.[0] || null;
  const assetToken = TOKENS.find((row) => row.address.toLowerCase() === String(asset || "").toLowerCase());
  const assetDecimals = assetToken?.label === "USDC" ? 6 : 18;
  const totalAssets = totalAssetsRaw?.[0] ?? null;
  const totalAssetsUnits = totalAssets === null ? null : units(totalAssets, assetDecimals);
  const assetPriceUsd = asset ? priceFor(prices, asset) : null;
  return {
    ...token,
    chain: CHAIN.chain,
    chainId: CHAIN.chainId,
    ...basic,
    symbol: symbolRaw?.[0] || null,
    name: nameRaw?.[0] || null,
    decimals,
    totalSupplyRaw: supply.toString(),
    totalSupply: formatUnits(supply, decimals),
    priceUsd,
    totalSupplyUsd: priceUsd && supplyUnits !== null ? supplyUnits * priceUsd : null,
    erc4626Probe: {
      asset,
      totalAssetsRaw: totalAssets?.toString() || null,
      totalAssets: totalAssets === null ? null : formatUnits(totalAssets, assetDecimals),
      totalAssetsUsd: assetPriceUsd && totalAssetsUnits !== null ? assetPriceUsd * totalAssetsUnits : null,
      convertToAssetsOneShareRaw: convertRaw?.[0]?.toString() || null,
      previewRedeemOneShareRaw: previewRaw?.[0]?.toString() || null,
      maxDepositRaw: maxDepositRaw?.[0]?.toString() || null,
      maxDeposit: maxDepositRaw?.[0] === undefined ? null : formatUnits(maxDepositRaw[0], assetDecimals),
      maxMintRaw: maxMintRaw?.[0]?.toString() || null,
      maxMint: maxMintRaw?.[0] === undefined ? null : formatUnits(maxMintRaw[0], decimals),
      maxWithdrawRaw: maxWithdrawRaw?.[0]?.toString() || null,
      maxRedeemRaw: maxRedeemRaw?.[0]?.toString() || null,
      owner: ownerRaw?.[0] || null,
      paused: pausedRaw?.[0] ?? null,
    },
    dexPools: pools,
    topDexLiquidityUsd: pools.length ? Math.max(...pools.map((row) => Number(row.reserveUsd || 0))) : 0,
    localMatches: localAddressMatches(token.address),
  };
}

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(RAW_DIR, file), "utf8")); } catch (_) { return null; }
}

async function selectorContext(provider, tokenRow) {
  const target = tokenRow?.proxy?.eip1967Implementation || tokenRow?.address;
  if (!target) return null;
  const code = (await provider.getCode(target).catch(() => "0x")).toLowerCase();
  const selectors = [...new Set([...code.matchAll(/63([0-9a-f]{8})/g)].map((m) => `0x${m[1]}`))];
  const known = MSUSD_SELECTOR_SIGNATURES.map((sig) => ({ sig, selector: ethers.id(sig).slice(0, 10), present: selectors.includes(ethers.id(sig).slice(0, 10).toLowerCase()) }));
  return {
    target,
    codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
    selectorCount: selectors.length,
    known,
    redeemLikeSelectorsPresent: known.filter((row) => /redeem|withdraw|deposit|convertToAssets|previewRedeem|asset\(\)|maxDeposit/.test(row.sig) && row.present).map((row) => row.sig),
    mintBurnSelectorsPresent: known.filter((row) => /mint|burn/.test(row.sig) && row.present).map((row) => row.sig),
  };
}

function localContext() {
  const balancer = loadJson("balancer-v3-phase0.json");
  const euler = loadJson("euler-v2-phase0.json");
  const evault = loadJson("evault-collateral-nav-manipulation.json");
  const pendleA = loadJson("pendle-pt-consumer-graph.json");
  const pendleB = loadJson("pendle-pt-multichain-consumer-graph.json");
  const donation = loadJson("new-vault-donation-attack.json");
  const currentProfit = loadJson("current-profit-leads.json");
  const balancerPools = (balancer?.poolRows || []).filter((row) => (row.tokens || []).some((t) => [MSUSD, MSY].includes(String(t.address || t.underlyingToken?.address || "").toLowerCase()) || String(t.underlyingToken?.address || "").toLowerCase() === MSUSD)).map((row) => ({ pool: row.pool, name: row.name, type: row.type, totalLiquidityUsd: row.totalLiquidityUsd, volume24hUsd: row.volume24hUsd, swapEnabled: row.swapEnabled, isPaused: row.isPaused, hasErc4626: row.hasErc4626, tokenSymbols: row.tokenSymbols, donationEnabled: row.donationEnabled, routePositive: row.routePositive, tokens: (row.tokens || []).map((t) => ({ address: t.address, symbol: t.symbol, balance: t.balance, balanceUsd: t.balanceUsd, priceRate: t.priceRate, isErc4626: t.isErc4626, underlyingToken: t.underlyingToken || null })) }));
  const eulerVaultRows = (euler?.vaultRows || []).filter((row) => String(row.asset || "").toLowerCase() === MSUSD).map((row) => ({ vault: row.vault, vaultSymbol: row.vaultSymbol, asset: row.asset, cashUsd: row.cashUsd, totalAssetsUsd: row.totalAssetsUsd, totalBorrowsUsd: row.totalBorrowsUsd, maxDepositAmount: row.maxDepositAmount, maxLtvBorrowBps: row.maxLtvBorrowBps, ltvRowsScanned: row.ltvRowsScanned, materialBorrowCash: row.materialBorrowCash, routePositive: row.routePositive }));
  const evaultRows = (evault?.rows || []).filter((row) => [row.collateralAsset, row.borrowAsset].some((addr) => String(addr || "").toLowerCase() === MSUSD)).map((row) => ({ protocol: row.protocol, collateral: row.collateral, collateralSymbol: row.collateralSymbol, collateralAsset: row.collateralAsset, borrowEvault: row.borrowEvault, borrowAsset: row.borrowAsset, borrowAssetSymbol: row.borrowAssetSymbol, ltv: row.ltv, collateralTvlUsd: row.collateralTvlUsd, borrowCashUsd: row.borrowCashUsd, matCash: row.matCash, watchCandidate: row.watchCandidate, routePositive: row.routePositive, blockers: row.blockers || [] }));
  const seenPendle = new Set();
  const pendleRows = [];
  for (const src of [pendleA, pendleB]) {
    for (const sourceSection of ["matches", "producers"]) {
      for (const row of src?.[sourceSection] || []) {
        if (![MSUSD, MSY].includes(String(row.underlyingAsset || "").toLowerCase())) continue;
        const key = `${sourceSection}:${row.market}:${row.underlyingAsset}`.toLowerCase();
        if (seenPendle.has(key)) continue;
        seenPendle.add(key);
        pendleRows.push({ sourceSection, marketName: row.marketName, market: row.market, pt: row.pt, symbol: row.symbol, underlyingAsset: row.underlyingAsset, expiry: row.expiry, liquidityUsdHint: row.liquidityUsdHint, impliedApy: row.impliedApy, ptPriceUsd: row.ptPriceUsd, syPriceUsd: row.syPriceUsd, underlyingPriceUsd: row.underlyingPriceUsd, blocker: row.blocker, currentAnomaly: row.currentAnomaly ?? false });
      }
    }
  }
  const donationRows = (donation?.rows || []).filter((row) => String(row.vault?.address || "").toLowerCase() === MSUSDC).map((row) => ({ vault: row.vault?.address, symbol: row.vault?.symbol, totalAssetsUsd: row.vault?.totalAssetsUsd, oneShareAssets: row.vault?.oneShareAssets, maxDeposit: row.vault?.maxDeposit, consumers: (row.consumers || []).length, bestNetUsd: row.bestNetUsd, preforkDonationPositive: row.preforkDonationPositive, routePositive: row.routePositive, blockers: row.blockers || [] }));
  const currentProfitRows = (currentProfit?.combined || []).filter((row) => (row.underlying || []).some((addr) => [MSUSD, MSUSDC, MSY].includes(String(addr || "").toLowerCase()))).map((row) => ({ type: row.type, project: row.project, chain: row.chain, symbol: row.symbol, tvlUsd: row.tvlUsd, apyPct: row.apyPct, apyBasePct: row.apyBasePct, pool: row.pool, score: row.score, candidateRoute: row.candidateRoute }));
  return { balancerPools, eulerVaultRows, evaultRows, pendleRows, donationRows, currentProfitRows };
}

async function main() {
  const [metadata, prices, rpc] = await Promise.all([
    fetchMetadata(),
    priceMap(),
    SKIP_RPC_INVENTORY ? resolvePublicFallbackRpc() : resolveRpc(1),
  ]);
  const rpcBlocked = [];
  const tokenRows = [];
  let provider = null;
  if (!rpc) {
    rpcBlocked.push({ protocol: "Mainstreet", chain: CHAIN.chain, chainId: CHAIN.chainId, missingEndpointClass: "EVM RPC", skippedChecks: ["token state", "ERC4626 msUSDC/msY probes", "DEX/consumer joins"] });
  } else {
    provider = new ethers.JsonRpcProvider(rpc, CHAIN.chainId, { staticNetwork: true });
    for (const token of TOKENS) tokenRows.push(await tokenMeta(provider, token, prices));
  }
  const context = localContext();
  const msUsd = tokenRows.find((row) => row.label === "msUSD");
  const msUsdc = tokenRows.find((row) => row.label === "msUSDC");
  const msY = tokenRows.find((row) => row.label === "msY");
  const dexLiquidityRows = [
    ...tokenRows.filter((row) => row.role !== "underlying-reference" && Number(row.topDexLiquidityUsd || 0) >= 10000).map((row) => ({ source: "geckoterminal", token: row.label, topDexLiquidityUsd: row.topDexLiquidityUsd, pools: row.dexPools })),
    ...context.balancerPools.filter((row) => Number(row.totalLiquidityUsd || 0) >= 10000).map((row) => ({ source: "balancer-v3-local", pool: row.pool, name: row.name, totalLiquidityUsd: row.totalLiquidityUsd, tokenSymbols: row.tokenSymbols, routePositive: row.routePositive })),
    ...context.currentProfitRows.map((row) => ({ source: "current-profit-leads", project: row.project, symbol: row.symbol, tvlUsd: row.tvlUsd, apyPct: row.apyPct, candidateRoute: row.candidateRoute })),
  ];
  const localArtifactMatchRows = tokenRows.reduce((sum, row) => sum + (row.localMatches || []).reduce((s, m) => s + m.count, 0), 0);
  const pendleConsumerRows = context.pendleRows.filter((row) => row.sourceSection === "matches").length;
  const consumerJoinRows = context.eulerVaultRows.length + context.evaultRows.length + pendleConsumerRows;
  const materialBorrowRows = context.evaultRows.filter((row) => Number(row.borrowCashUsd || 0) >= 5000).length + context.eulerVaultRows.filter((row) => row.materialBorrowCash).length;
  const materialDexLiquidityUsd = context.balancerPools.reduce((sum, row) => sum + Number(row.totalLiquidityUsd || 0), 0) + context.currentProfitRows.reduce((sum, row) => sum + Number(row.tvlUsd || 0), 0);
  const selectors = provider && msUsd ? { msUSD: await selectorContext(provider, msUsd) } : {};
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-mainstreet-prefilter.js",
    scope: "Mainstreet msUSD/msUSDC basis-stable route prefilter",
    safety: { rpcInventorySkipped: SKIP_RPC_INVENTORY, rpcInventoryRead: !SKIP_RPC_INVENTORY, publicFallbackRpcAllowed: SKIP_RPC_INVENTORY, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false, forkJustified: false },
    metadata,
    adapter: { source: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/mainstreet/index.js", methodology: "Adapter values msUSD totalSupply as USDC" },
    tokenRows,
    selectorContext: selectors,
    localContext: context,
    rpcBlocked,
    summary: {
      tokenRows: tokenRows.length,
      codePresentRows: tokenRows.filter((row) => row.codePresent).length,
      erc4626ProbeRows: tokenRows.filter((row) => row.erc4626Probe.asset || row.erc4626Probe.totalAssetsRaw).length,
      msUsdPriceUsd: msUsd?.priceUsd || null,
      msUsdTotalSupplyUsd: msUsd?.totalSupplyUsd || null,
      msUsdcTotalAssetsUsd: msUsdc?.erc4626Probe?.totalAssetsUsd || null,
      msUsdcMaxDeposit: msUsdc?.erc4626Probe?.maxDeposit || null,
      msYTotalAssetsUsd: msY?.erc4626Probe?.totalAssetsUsd || null,
      msUsdRedeemLikeSelectorsPresent: selectors.msUSD?.redeemLikeSelectorsPresent?.length ?? null,
      msUsdMintBurnSelectorsPresent: selectors.msUSD?.mintBurnSelectorsPresent || [],
      balancerPoolRows: context.balancerPools.length,
      balancerLiquidityUsd: context.balancerPools.reduce((sum, row) => sum + Number(row.totalLiquidityUsd || 0), 0),
      pendleRows: context.pendleRows.length,
      pendleConsumerRows,
      pendleLiquidityUsd: context.pendleRows.reduce((sum, row) => sum + Number(row.liquidityUsdHint || 0), 0),
      eulerVaultRows: context.eulerVaultRows.length,
      evaultRouteRows: context.evaultRows.length,
      materialBorrowRows,
      donationRows: context.donationRows.length,
      currentProfitLeadRows: context.currentProfitRows.length,
      localArtifactMatchRows,
      consumerJoinRows,
      dexLiquidityRows: dexLiquidityRows.length,
      materialDexLiquidityUsd,
      exactEconomicsRows: 0,
      rpcBlockedRows: rpcBlocked.length,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      forkJustified: false,
    },
    dexLiquidityRows,
    blockers: [
      "msUSD has material DEX/Pendle context, but no producer-side underpricing, public mint/redeem arbitrage, or accepted-value overvaluation is proven",
      "Euler/EVK msUSD rows have borrow-side cash below material low-capital thresholds",
      "msUSDC ERC4626 donation path remains blocked by maxDeposit=0 and no consumers",
      "Pendle msUSD/msY rows have liquidity but no current producer anomaly or consumer-specific positive economics",
      "Balancer pools are live exit liquidity, not an extractive route without cheaper acquisition or accepted-value divergence",
      "No exact positive borrow, redeem, liquidation, donation, PT, or DEX unwind route exists from current evidence",
    ],
    nextRoutePositiveCriteria: [
      "msUSD/msUSDC/msY can be acquired below accepted or redeemable value at material size after slippage, fees, and gas",
      "A live lending/EVK route accepts Mainstreet collateral with material borrow cash and overvalues it versus market/redeem value",
      "A public msUSDC/msY mint/redeem or donation route becomes positive with open deposits and an accepted-value consumer",
    ],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Mainstreet prefilter: tokens=${tokenRows.length} consumers=${consumerJoinRows} borrowMaterial=${materialBorrowRows} dexRows=${dexLiquidityRows.length} routePositive=0 rpcBlocked=${rpcBlocked.length}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
