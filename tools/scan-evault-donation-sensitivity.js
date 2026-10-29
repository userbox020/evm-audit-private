#!/usr/bin/env node
// Read-only Euler eVault donation/oracle sensitivity preflight.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const IN = path.join(WORKSPACE, "reports", "raw", "fast", "evault-collateral-nav-manipulation.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "evault-donation-sensitivity.json");
const CHAIN_ID = 1;
const GAS_UNITS = Number(process.env.EVAULT_DONATION_GAS_UNITS || "2500000");
const SLIPPAGE_BPS = Number(process.env.EVAULT_DONATION_SLIPPAGE_BPS || "100");
const MIN_PROFIT_USD = Number(process.env.EVAULT_DONATION_MIN_PROFIT_USD || "25");
const RECEIVER = process.env.EVAULT_PREFLIGHT_RECEIVER || ethers.ZeroAddress;

const EVAULT = new ethers.Interface([
  "function asset() view returns (address)",
  "function cash() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function LTVBorrow(address) view returns (uint16)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function maxMint(address receiver) view returns (uint256)",
  "function oracle() view returns (address)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
  "function symbol() view returns (string)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function unitOfAccount() view returns (address)",
]);
const ERC20 = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const ORACLE = new ethers.Interface([
  "function getQuote(uint256 inAmount,address base,address quote) view returns (uint256 outAmount)",
]);
const ETH_FEED = new ethers.Interface([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const ETH_USD_FEED = "0x5f4eC3Df9cbd43714FE2740f5e3616155c5b8419";

function loadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function lowerAddress(value) {
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
}

function sameAddress(a, b) {
  const aa = lowerAddress(a);
  const bb = lowerAddress(b);
  return Boolean(aa && bb && aa === bb);
}

function round(value, decimals = 6) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function bpsDiff(reference, observed) {
  const ref = Number(reference || 0);
  const obs = Number(observed || 0);
  if (!Number.isFinite(ref) || !Number.isFinite(obs) || ref <= 0 || obs <= 0) return null;
  return ((obs / ref) - 1) * 10_000;
}

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try { return Number(ethers.formatUnits(BigInt(raw), Number(decimals))); } catch (_) { return null; }
}

function oneUnit(decimals) {
  try { return 10n ** BigInt(Math.min(Number(decimals ?? 18), 36)); } catch (_) { return 10n ** 18n; }
}

function ratioFromRaw(numeratorRaw, denominatorRaw) {
  if (numeratorRaw === null || numeratorRaw === undefined || denominatorRaw === null || denominatorRaw === undefined) return null;
  const denominator = BigInt(denominatorRaw);
  if (denominator <= 0n) return null;
  return Number(BigInt(numeratorRaw)) / Number(denominator);
}

async function safeCall(provider, to, iface, fn, args = []) {
  try {
    const target = normalizeAddress(to);
    if (!target) return null;
    const raw = await provider.call({ to: target, data: iface.encodeFunctionData(fn, args) });
    return iface.decodeFunctionResult(fn, raw)[0];
  } catch (_) {
    return null;
  }
}

async function quoteOracle(provider, oracle, inAmount, base, quote) {
  try {
    if (!normalizeAddress(oracle) || !normalizeAddress(base) || !normalizeAddress(quote)) return null;
    const raw = await provider.call({ to: oracle, data: ORACLE.encodeFunctionData("getQuote", [inAmount, base, quote]) });
    return ORACLE.decodeFunctionResult("getQuote", raw)[0];
  } catch (_) {
    return null;
  }
}

async function tokenMeta(provider, address, fallback = {}) {
  const token = normalizeAddress(address || fallback.address);
  if (!token) return { address: null, symbol: fallback.symbol || null, decimals: fallback.decimals ?? null };
  const [symbol, decimals] = await Promise.all([
    safeCall(provider, token, ERC20, "symbol"),
    safeCall(provider, token, ERC20, "decimals"),
  ]);
  return {
    address: token,
    symbol: symbol ? String(symbol) : fallback.symbol || null,
    decimals: decimals === null || decimals === undefined ? fallback.decimals ?? 18 : Number(decimals),
  };
}

async function fetchJson(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPrices(refs) {
  const keys = [...new Set((refs || []).map((addr) => lowerAddress(addr)).filter(Boolean).map((addr) => `ethereum:${addr}`))];
  const prices = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${chunk.join(",")}?searchWidth=6h`, 30_000).catch(() => ({ coins: {} }));
    for (const [key, value] of Object.entries(json.coins || {})) {
      const addr = lowerAddress(key.slice(key.indexOf(":") + 1));
      const price = Number(value?.price || 0);
      if (addr && Number.isFinite(price) && price > 0) prices.set(addr, price);
    }
  }
  return prices;
}

async function ethPriceUsd(provider) {
  const raw = await provider.call({ to: ETH_USD_FEED, data: ETH_FEED.encodeFunctionData("latestRoundData", []) }).catch(() => null);
  if (raw) {
    const [, answer] = ETH_FEED.decodeFunctionResult("latestRoundData", raw);
    const price = Number(answer) / 1e8;
    if (Number.isFinite(price) && price > 0) return price;
  }
  const json = await fetchJson("https://coins.llama.fi/prices/current/coingecko:ethereum?searchWidth=6h", 20_000).catch(() => null);
  const price = Number(json?.coins?.["coingecko:ethereum"]?.price || 0);
  return Number.isFinite(price) && price > 0 ? price : 0;
}

function collectRows(artifact) {
  return (Array.isArray(artifact?.rows) ? artifact.rows : [])
    .filter((row) => row.watchCandidate && row.collateral && row.borrowEvault)
    .slice(0, Number(process.env.EVAULT_DONATION_MAX_ROWS || "8"));
}

async function enrichRow(provider, row, prices, gasUsd) {
  const collateral = normalizeAddress(row.collateral);
  const borrowEvault = normalizeAddress(row.borrowEvault);
  const [shareMeta, collateralAsset, totalAssetsRaw, totalSupplyRaw, maxDepositRaw, maxMintRaw, borrowAsset, borrowCashRaw, ltvRaw, oracle, unitOfAccountRaw] = await Promise.all([
    tokenMeta(provider, collateral, { symbol: row.collateralSymbol, decimals: 18 }),
    safeCall(provider, collateral, EVAULT, "asset"),
    safeCall(provider, collateral, EVAULT, "totalAssets"),
    safeCall(provider, collateral, EVAULT, "totalSupply"),
    safeCall(provider, collateral, EVAULT, "maxDeposit", [RECEIVER]),
    safeCall(provider, collateral, EVAULT, "maxMint", [RECEIVER]),
    safeCall(provider, borrowEvault, EVAULT, "asset"),
    safeCall(provider, borrowEvault, EVAULT, "cash"),
    safeCall(provider, borrowEvault, EVAULT, "LTVBorrow", [collateral]),
    safeCall(provider, borrowEvault, EVAULT, "oracle"),
    safeCall(provider, borrowEvault, EVAULT, "unitOfAccount"),
  ]);
  const collateralAssetMeta = await tokenMeta(provider, collateralAsset, { symbol: row.collateralAssetSymbol, decimals: row.collateralAssetDecimals });
  const borrowAssetMeta = await tokenMeta(provider, borrowAsset, { symbol: row.borrowAssetSymbol, decimals: row.borrowAssetDecimals });
  const shareDecimals = Number(shareMeta.decimals ?? 18);
  const collateralAssetDecimals = Number(collateralAssetMeta.decimals ?? 18);
  const borrowDecimals = Number(borrowAssetMeta.decimals ?? 18);
  const oneShare = oneUnit(shareDecimals);
  const oneBorrow = oneUnit(borrowDecimals);
  const navAssetRaw = await safeCall(provider, collateral, EVAULT, "previewRedeem", [oneShare]);
  const navAssetsPerShare = formatUnitsNumber(navAssetRaw, collateralAssetDecimals);
  const collateralAssetPriceUsd = prices.get(lowerAddress(collateralAssetMeta.address)) || 0;
  const borrowAssetPriceUsd = prices.get(lowerAddress(borrowAssetMeta.address)) || 0;
  const referenceUsdPerShare = navAssetsPerShare !== null && collateralAssetPriceUsd > 0 ? navAssetsPerShare * collateralAssetPriceUsd : null;

  const unitOfAccount = normalizeAddress(unitOfAccountRaw);
  const borrowUnitQuoteRaw = unitOfAccount && sameAddress(unitOfAccount, borrowAssetMeta.address)
    ? oneBorrow
    : unitOfAccount ? await quoteOracle(provider, oracle, oneBorrow, borrowAssetMeta.address, unitOfAccount) : null;
  const shareToBorrowRaw = await quoteOracle(provider, oracle, oneShare, collateral, borrowAssetMeta.address);
  const shareToUnitRaw = unitOfAccount ? await quoteOracle(provider, oracle, oneShare, collateral, unitOfAccount) : null;
  const underlyingToBorrowRaw = navAssetRaw !== null ? await quoteOracle(provider, oracle, navAssetRaw, collateralAssetMeta.address, borrowAssetMeta.address) : null;
  const underlyingToUnitRaw = unitOfAccount && navAssetRaw !== null ? await quoteOracle(provider, oracle, navAssetRaw, collateralAssetMeta.address, unitOfAccount) : null;

  let acceptedBorrowPerShare = shareToBorrowRaw !== null ? formatUnitsNumber(shareToBorrowRaw, borrowDecimals) : null;
  let acceptedMode = acceptedBorrowPerShare !== null ? "share-to-borrow" : null;
  if (acceptedBorrowPerShare === null && shareToUnitRaw !== null && borrowUnitQuoteRaw !== null) {
    acceptedBorrowPerShare = ratioFromRaw(shareToUnitRaw, borrowUnitQuoteRaw);
    acceptedMode = "share-to-unit-account";
  }

  let referenceBorrowPerShare = underlyingToBorrowRaw !== null ? formatUnitsNumber(underlyingToBorrowRaw, borrowDecimals) : null;
  let referenceMode = referenceBorrowPerShare !== null ? "underlying-to-borrow" : null;
  if (referenceBorrowPerShare === null && underlyingToUnitRaw !== null && borrowUnitQuoteRaw !== null) {
    referenceBorrowPerShare = ratioFromRaw(underlyingToUnitRaw, borrowUnitQuoteRaw);
    referenceMode = "underlying-to-unit-account";
  }
  if (referenceBorrowPerShare === null && referenceUsdPerShare !== null && borrowAssetPriceUsd > 0) {
    referenceBorrowPerShare = referenceUsdPerShare / borrowAssetPriceUsd;
    referenceMode = "defillama-usd-reference";
  }

  const acceptedUsdPerShare = acceptedBorrowPerShare !== null && borrowAssetPriceUsd > 0 ? acceptedBorrowPerShare * borrowAssetPriceUsd : null;
  const acceptedVsReferenceBps = bpsDiff(referenceBorrowPerShare, acceptedBorrowPerShare);
  const ltv = Number(ltvRaw ?? ((row.ltv || 0) * 10000)) / 10000;
  const borrowCash = formatUnitsNumber(borrowCashRaw, borrowDecimals) || 0;
  const borrowCashUsd = borrowCash * borrowAssetPriceUsd;
  const gasBps = borrowCashUsd > 0 && gasUsd > 0 ? gasUsd / borrowCashUsd * 10_000 : 0;
  const breakEvenPremiumBps = ltv > 0 ? ((1 / ltv) - 1) * 10_000 : null;
  const requiredPremiumBps = breakEvenPremiumBps !== null ? breakEvenPremiumBps + SLIPPAGE_BPS + gasBps : null;
  const premiumGapBps = acceptedVsReferenceBps !== null && requiredPremiumBps !== null ? requiredPremiumBps - acceptedVsReferenceBps : null;
  const acceptedReferenceRatio = acceptedBorrowPerShare !== null && referenceBorrowPerShare ? acceptedBorrowPerShare / referenceBorrowPerShare : null;
  const borrowablePerReferenceUsd = acceptedReferenceRatio !== null ? acceptedReferenceRatio * ltv : null;
  const acquisitionCostForBorrowCashUsd = borrowablePerReferenceUsd && borrowablePerReferenceUsd > 0 ? borrowCashUsd / borrowablePerReferenceUsd : null;
  const slippageUsd = acquisitionCostForBorrowCashUsd !== null ? acquisitionCostForBorrowCashUsd * SLIPPAGE_BPS / 10_000 : null;
  const netEdgeUsd = acquisitionCostForBorrowCashUsd !== null ? borrowCashUsd - acquisitionCostForBorrowCashUsd - (slippageUsd || 0) - gasUsd : null;
  const donationBorrowablePerDollar = borrowablePerReferenceUsd;
  const donationNetPerDollarBeforeGas = donationBorrowablePerDollar !== null ? donationBorrowablePerDollar - 1 : null;
  const routePositive = netEdgeUsd !== null && netEdgeUsd > MIN_PROFIT_USD && donationNetPerDollarBeforeGas !== null && donationNetPerDollarBeforeGas > (SLIPPAGE_BPS / 10_000);

  return {
    protocol: "Euler EVK",
    chainId: CHAIN_ID,
    chain: "Ethereum",
    collateral,
    collateralSymbol: shareMeta.symbol || row.collateralSymbol || null,
    collateralAsset: collateralAssetMeta,
    borrowEvault,
    borrowAsset: borrowAssetMeta,
    ltv: round(ltv, 6),
    publicMintOpen: maxDepositRaw !== null ? BigInt(maxDepositRaw) > 0n : maxMintRaw !== null ? BigInt(maxMintRaw) > 0n : null,
    maxDepositRaw: maxDepositRaw?.toString?.() || null,
    maxMintRaw: maxMintRaw?.toString?.() || null,
    totalAssetsRaw: totalAssetsRaw?.toString?.() || null,
    totalSupplyRaw: totalSupplyRaw?.toString?.() || null,
    nav: {
      previewRedeemOneShareRaw: navAssetRaw?.toString?.() || null,
      navAssetsPerShare: round(navAssetsPerShare, 12),
      collateralAssetPriceUsd: round(collateralAssetPriceUsd, 8),
      referenceUsdPerShare: round(referenceUsdPerShare, 12),
    },
    oracle: {
      address: normalizeAddress(oracle),
      unitOfAccount,
      acceptedMode,
      referenceMode,
      shareToBorrowRaw: shareToBorrowRaw?.toString?.() || null,
      shareToUnitRaw: shareToUnitRaw?.toString?.() || null,
      underlyingToBorrowRaw: underlyingToBorrowRaw?.toString?.() || null,
      underlyingToUnitRaw: underlyingToUnitRaw?.toString?.() || null,
      borrowUnitQuoteRaw: borrowUnitQuoteRaw?.toString?.() || null,
      acceptedBorrowPerShare: round(acceptedBorrowPerShare, 12),
      referenceBorrowPerShare: round(referenceBorrowPerShare, 12),
      acceptedUsdPerShare: round(acceptedUsdPerShare, 12),
      acceptedVsReferenceBps: round(acceptedVsReferenceBps, 6),
    },
    economics: {
      borrowAssetPriceUsd: round(borrowAssetPriceUsd, 8),
      borrowCash: round(borrowCash, 8),
      borrowCashUsd: round(borrowCashUsd, 2),
      breakEvenPremiumBps: round(breakEvenPremiumBps, 6),
      slippageBps: SLIPPAGE_BPS,
      gasUsd: round(gasUsd, 6),
      gasBps: round(gasBps, 6),
      requiredPremiumBps: round(requiredPremiumBps, 6),
      premiumGapBps: round(premiumGapBps, 6),
      borrowablePerReferenceUsd: round(borrowablePerReferenceUsd, 12),
      donationBorrowablePerDollar: round(donationBorrowablePerDollar, 12),
      donationNetPerDollarBeforeGas: round(donationNetPerDollarBeforeGas, 12),
      acquisitionCostForBorrowCashUsd: round(acquisitionCostForBorrowCashUsd, 6),
      slippageUsd: round(slippageUsd, 6),
      netEdgeUsd: round(netEdgeUsd, 6),
      minProfitUsd: MIN_PROFIT_USD,
    },
    watchCandidate: true,
    routePositive,
    blockers: [
      routePositive ? null : "Oracle/donation economics do not clear LTV haircut, slippage, gas, and min-profit gates",
      acceptedVsReferenceBps === null ? "Euler oracle or reference quote unresolved" : null,
      donationNetPerDollarBeforeGas !== null && donationNetPerDollarBeforeGas <= 0 ? "Donation borrowable value is below donated cost" : null,
      "No fork extraction proof",
    ].filter(Boolean),
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const source = loadJson(IN, {});
  const rows = collectRows(source);
  const rpc = await require("./shared-rpc").resolveRpc(CHAIN_ID);
  if (!rpc) throw new Error("No Ethereum RPC endpoint resolved from local inventory");
  const provider = new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
  const block = await provider.getBlockNumber();
  const priceRefs = [];
  for (const row of rows) priceRefs.push(row.collateralAsset, row.borrowAsset);
  const [prices, gasPriceRaw, ethUsd] = await Promise.all([
    fetchPrices(priceRefs),
    provider.send("eth_gasPrice", []).then(BigInt).catch(() => 0n),
    ethPriceUsd(provider).catch(() => 0),
  ]);
  const gasUsd = ethUsd && gasPriceRaw > 0n ? (GAS_UNITS * Number(gasPriceRaw) / 1e18) * ethUsd : 0;
  const enriched = [];
  for (const row of rows) enriched.push(await enrichRow(provider, row, prices, gasUsd));
  enriched.sort((a, b) => (b.economics?.netEdgeUsd ?? -Infinity) - (a.economics?.netEdgeUsd ?? -Infinity));
  const routePositiveRows = enriched.filter((row) => row.routePositive);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-evault-donation-sensitivity.js",
    scope: "Read-only Euler eVault oracle/donation sensitivity preflight",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: routePositiveRows.length > 0,
      signedActionJustified: false,
    },
    sourceArtifact: path.relative(WORKSPACE, IN),
    chain: { chainId: CHAIN_ID, name: "Ethereum", blockNumber: block },
    config: { receiver: RECEIVER, gasUnits: GAS_UNITS, slippageBps: SLIPPAGE_BPS, minProfitUsd: MIN_PROFIT_USD },
    gas: { gasPriceWei: gasPriceRaw.toString(), ethPriceUsd: round(ethUsd, 2), gasUsd: round(gasUsd, 6) },
    summary: {
      sourceWatchCandidates: source?.summary?.watchCandidates || 0,
      rowsInput: rows.length,
      rowsQuoted: enriched.length,
      rowsWithOracleQuote: enriched.filter((row) => row.oracle.acceptedBorrowPerShare !== null).length,
      rowsWithReferenceQuote: enriched.filter((row) => row.oracle.referenceBorrowPerShare !== null).length,
      publicMintOpenRows: enriched.filter((row) => row.publicMintOpen === true).length,
      routePositive: routePositiveRows.length,
      signedActionJustified: false,
      bestPremiumBps: round(Math.max(...enriched.map((row) => row.oracle.acceptedVsReferenceBps).filter((n) => Number.isFinite(n)), -Infinity), 6),
      bestRequiredPremiumBps: round(Math.min(...enriched.map((row) => row.economics.requiredPremiumBps).filter((n) => Number.isFinite(n)), Infinity), 6),
      bestNetEdgeUsd: round(Math.max(...enriched.map((row) => row.economics.netEdgeUsd).filter((n) => Number.isFinite(n)), -Infinity), 6),
      blocker: routePositiveRows.length > 0
        ? "Read-only sensitivity is positive; requires fork extraction proof before any signed action."
        : "No watch row clears LTV haircut, slippage, gas, and min-profit gates under read-only oracle/donation sensitivity.",
    },
    rows: enriched,
    positiveRows: routePositiveRows,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  console.log(`eVault donation sensitivity: rows=${enriched.length} routePositive=${routePositiveRows.length} bestNet=${artifact.summary.bestNetEdgeUsd}`);
}

main().catch((err) => {
  console.error(`scan-evault-donation-sensitivity failed: ${err?.message || String(err)}`);
  process.exitCode = 1;
});
