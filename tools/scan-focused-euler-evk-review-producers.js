#!/usr/bin/env node
// Read-only focused scanner for Euler EVK high-LTV collateral review rows.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const IN = path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "focused-euler-evk-review-producers.json");

const MIN_ROUTE_LIQUIDITY_USD = Number(process.env.FOCUSED_EULER_MIN_LIQUIDITY_USD || "10000");
const MAX_ROWS = Number(process.env.FOCUSED_EULER_MAX_ROWS || "40");
const SLIPPAGE_BPS = Number(process.env.FOCUSED_EULER_SLIPPAGE_BPS || "100");
const GAS_UNITS = Number(process.env.FOCUSED_EULER_GAS_UNITS || "1800000");
const MIN_PROFIT_USD = Number(process.env.FOCUSED_EULER_MIN_PROFIT_USD || "25");

const CHAIN_CONFIGS = {
  1: { name: "Ethereum", coinSlug: "ethereum", gasPriceKey: "coingecko:ethereum" },
  10: { name: "Optimism", coinSlug: "optimism", gasPriceKey: "coingecko:ethereum" },
  137: { name: "Polygon", coinSlug: "polygon", gasPriceKey: "coingecko:matic-network" },
  480: { name: "World Chain", coinSlug: "world-chain", gasPriceKey: "coingecko:ethereum" },
  8453: { name: "Base", coinSlug: "base", gasPriceKey: "coingecko:ethereum" },
  130: { name: "Unichain", coinSlug: "unichain", gasPriceKey: "coingecko:ethereum" },
};

const TOKEN = new ethers.Interface([
  "function asset() view returns (address)",
  "function cash() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function maxMint(address receiver) view returns (uint256)",
  "function name() view returns (string)",
  "function oracle() view returns (address)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function symbol() view returns (string)",
  "function totalAssets() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function unitOfAccount() view returns (address)",
]);
const EULER_ORACLE = new ethers.Interface([
  "function getQuote(uint256 inAmount,address base,address quote) view returns (uint256 outAmount)",
]);

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

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcPool(chainIds) {
  const wanted = new Set(chainIds.map(Number));
  const pool = {};
  for (const url of loadRpcUrls()) {
    try {
      const chainId = Number(BigInt(await rpcCall(url, "eth_chainId", [], 6000)));
      if (wanted.has(chainId) && !pool[chainId]) pool[chainId] = url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return pool;
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

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try { return Number(ethers.formatUnits(BigInt(raw), Number(decimals))); } catch (_) { return null; }
}

function oneUnit(decimals) {
  try { return 10n ** BigInt(Math.min(Number(decimals ?? 18), 36)); } catch (_) { return 10n ** 18n; }
}

function round(value, decimals = 6) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function bpsDiff(reference, observed) {
  const ref = Number(reference || 0);
  const obs = Number(observed || 0);
  if (!Number.isFinite(ref) || !Number.isFinite(obs) || ref <= 0 || obs <= 0) return null;
  return ((obs / ref) - 1) * 10_000;
}

function minNumber(rows, getValue) {
  const values = rows.map(getValue).filter((value) => Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
}

function maxNumber(rows, getValue) {
  const values = rows.map(getValue).filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

function countBy(rows, getKey) {
  const out = {};
  for (const row of rows) {
    const key = getKey(row) || "unknown";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 20_000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function priceMapKey(chainId, address) {
  const lower = lowerAddress(address);
  return lower ? `${Number(chainId)}:${lower}` : null;
}

function priceFromMap(prices, chainId, address) {
  const key = priceMapKey(chainId, address);
  return key ? prices.get(key) || null : null;
}

async function fetchPrices(refs) {
  const keyToRefs = new Map();
  for (const ref of refs || []) {
    const cfg = CHAIN_CONFIGS[Number(ref?.chainId)];
    const lower = lowerAddress(ref?.address);
    if (!cfg?.coinSlug || !lower) continue;
    const coinKey = `${cfg.coinSlug}:${lower}`.toLowerCase();
    const list = keyToRefs.get(coinKey) || [];
    list.push({ chainId: Number(ref.chainId), address: lower });
    keyToRefs.set(coinKey, list);
  }
  const keys = [...keyToRefs.keys()];
  const out = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.slice(i, i + 50).join(",")}?searchWidth=6h`, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    for (const [key, row] of Object.entries(json.coins || {})) {
      const price = Number(row?.price || 0);
      if (price <= 0) continue;
      for (const ref of keyToRefs.get(key.toLowerCase()) || []) out.set(`${ref.chainId}:${ref.address}`, price);
    }
  }
  return out;
}

async function fetchCoinKeyPrices(keys) {
  const uniq = [...new Set((keys || []).filter(Boolean).map((key) => String(key).toLowerCase()))];
  const out = new Map();
  for (let i = 0; i < uniq.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${uniq.slice(i, i + 50).join(",")}?searchWidth=6h`, { timeoutMs: 20_000 }).catch(() => ({ coins: {} }));
    for (const [key, row] of Object.entries(json.coins || {})) {
      const price = Number(row?.price || 0);
      if (price > 0) out.set(key.toLowerCase(), price);
    }
  }
  return out;
}

function collectRows() {
  const artifact = readJson(IN, null);
  const rows = [];
  for (const result of artifact?.results || []) {
    if (!CHAIN_CONFIGS[Number(result.chainId)]) continue;
    for (const row of result.highLtvRowsDetail || result.topRows || []) {
      if (row.protocol !== "Euler EVK" || !row.reviewCandidate) continue;
      if (Number(row.routeLiquidityUsd || 0) < MIN_ROUTE_LIQUIDITY_USD) continue;
      rows.push(row);
    }
  }
  const seen = new Set();
  const deduped = [];
  for (const row of rows.sort((a, b) => Number(b.routeLiquidityUsd || 0) - Number(a.routeLiquidityUsd || 0))) {
    const key = `${Number(row.chainId)}:${lowerAddress(row.consumer?.evault)}:${lowerAddress(row.collateral?.address)}:${lowerAddress(row.borrowAsset?.address)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped.slice(0, MAX_ROWS);
}

async function tokenMeta(provider, token, fallback = {}) {
  const address = normalizeAddress(token);
  if (!address) return null;
  const [symbol, name, decimals] = await Promise.all([
    safeCall(provider, address, TOKEN, "symbol"),
    safeCall(provider, address, TOKEN, "name"),
    safeCall(provider, address, TOKEN, "decimals"),
  ]);
  return {
    address,
    symbol: symbol ? String(symbol) : fallback.symbol || null,
    name: name ? String(name) : fallback.name || null,
    decimals: Number(decimals ?? fallback.decimals ?? 18),
  };
}

async function quoteOracle(provider, oracle, amount, base, quote) {
  const raw = await safeCall(provider, oracle, EULER_ORACLE, "getQuote", [amount, base, quote]);
  return raw === null || raw === undefined ? null : BigInt(raw);
}

function ratioFromRaw(numeratorRaw, denominatorRaw) {
  if (numeratorRaw === null || numeratorRaw === undefined || denominatorRaw === null || denominatorRaw === undefined) return null;
  const denominator = BigInt(denominatorRaw);
  if (denominator <= 0n) return null;
  const numerator = BigInt(numeratorRaw);
  return Number(numerator) / Number(denominator);
}

async function enrichRow(provider, row, prices, gasUsd) {
  const chainId = Number(row.chainId);
  const collateralAddress = normalizeAddress(row.collateral?.address);
  const borrowEvault = normalizeAddress(row.consumer?.evault);
  const borrowAssetAddress = normalizeAddress(row.borrowAsset?.address || row.consumer?.asset);
  const collateralMeta = await tokenMeta(provider, collateralAddress, row.collateral || {});
  const borrowAssetMeta = await tokenMeta(provider, borrowAssetAddress, row.borrowAsset || {});
  const collateralDecimals = Number(collateralMeta?.decimals ?? row.collateral?.decimals ?? 18);
  const oneShare = oneUnit(collateralDecimals);

  const [collateralAsset, convertRaw, previewRaw, totalAssetsRaw, totalSupplyRaw, maxDepositRaw, maxMintRaw, oracle, unitOfAccountRaw] = await Promise.all([
    safeCall(provider, collateralAddress, TOKEN, "asset"),
    safeCall(provider, collateralAddress, TOKEN, "convertToAssets", [oneShare]),
    safeCall(provider, collateralAddress, TOKEN, "previewRedeem", [oneShare]),
    safeCall(provider, collateralAddress, TOKEN, "totalAssets"),
    safeCall(provider, collateralAddress, TOKEN, "totalSupply"),
    safeCall(provider, collateralAddress, TOKEN, "maxDeposit", [ethers.ZeroAddress]),
    safeCall(provider, collateralAddress, TOKEN, "maxMint", [ethers.ZeroAddress]),
    safeCall(provider, borrowEvault, TOKEN, "oracle"),
    safeCall(provider, borrowEvault, TOKEN, "unitOfAccount"),
  ]);
  const collateralAssetMeta = collateralAsset ? await tokenMeta(provider, collateralAsset) : null;
  const collateralAssetDecimals = Number(collateralAssetMeta?.decimals ?? 18);
  const navAssetRaw = convertRaw !== null && convertRaw !== undefined ? BigInt(convertRaw) : previewRaw !== null && previewRaw !== undefined ? BigInt(previewRaw) : null;
  const navAssetsPerShare = navAssetRaw !== null ? formatUnitsNumber(navAssetRaw, collateralAssetDecimals) : null;
  const collateralAssetPriceUsd = priceFromMap(prices, chainId, collateralAssetMeta?.address);
  const directCollateralPriceUsd = priceFromMap(prices, chainId, collateralAddress);
  const borrowAssetPriceUsd = priceFromMap(prices, chainId, borrowAssetAddress);
  const unitOfAccount = normalizeAddress(unitOfAccountRaw);
  const referenceUsdPerCollateral = collateralAssetPriceUsd && navAssetsPerShare !== null
    ? collateralAssetPriceUsd * navAssetsPerShare
    : directCollateralPriceUsd;

  let oracleQuoteRaw = null;
  let oracleQuoteMode = null;
  let unitAccountQuoteRaw = null;
  let borrowUnitQuoteRaw = null;
  let acceptedBorrowPerCollateral = null;
  if (oracle && borrowAssetAddress) {
    oracleQuoteRaw = await quoteOracle(provider, oracle, oneShare, collateralAddress, borrowAssetAddress);
    if (oracleQuoteRaw !== null) {
      oracleQuoteMode = "collateral-share-to-borrow";
      acceptedBorrowPerCollateral = formatUnitsNumber(oracleQuoteRaw, borrowAssetMeta?.decimals);
    }
    if (acceptedBorrowPerCollateral === null && unitOfAccount) {
      borrowUnitQuoteRaw = lowerAddress(unitOfAccount) === lowerAddress(borrowAssetAddress)
        ? oneUnit(borrowAssetMeta?.decimals)
        : await quoteOracle(provider, oracle, oneUnit(borrowAssetMeta?.decimals), borrowAssetAddress, unitOfAccount);
      if (borrowUnitQuoteRaw !== null) {
        unitAccountQuoteRaw = await quoteOracle(provider, oracle, oneShare, collateralAddress, unitOfAccount);
        if (unitAccountQuoteRaw !== null) {
          acceptedBorrowPerCollateral = ratioFromRaw(unitAccountQuoteRaw, borrowUnitQuoteRaw);
          oracleQuoteMode = "collateral-share-to-unit-account";
        }
        if (acceptedBorrowPerCollateral === null && collateralAsset && navAssetRaw !== null) {
          unitAccountQuoteRaw = await quoteOracle(provider, oracle, navAssetRaw, collateralAsset, unitOfAccount);
          if (unitAccountQuoteRaw !== null) {
            acceptedBorrowPerCollateral = ratioFromRaw(unitAccountQuoteRaw, borrowUnitQuoteRaw);
            oracleQuoteMode = "underlying-asset-to-unit-account";
          }
        }
      }
    }
    if (acceptedBorrowPerCollateral === null && collateralAsset && navAssetRaw !== null) {
      oracleQuoteRaw = await quoteOracle(provider, oracle, navAssetRaw, collateralAsset, borrowAssetAddress);
      if (oracleQuoteRaw !== null) {
        oracleQuoteMode = "underlying-asset-to-borrow";
        acceptedBorrowPerCollateral = formatUnitsNumber(oracleQuoteRaw, borrowAssetMeta?.decimals);
      }
    }
  }
  const acceptedUsdPerCollateral = acceptedBorrowPerCollateral !== null && borrowAssetPriceUsd
    ? acceptedBorrowPerCollateral * borrowAssetPriceUsd
    : null;
  const acceptedVsReferenceBps = bpsDiff(referenceUsdPerCollateral, acceptedUsdPerCollateral);
  const ltv = Number(row.ltv || 0);
  const routeLiquidityUsd = Number(row.routeLiquidityUsd || 0);
  const ltvBreakEvenPremiumBps = ltv > 0 ? ((1 / ltv) - 1) * 10_000 : null;
  const gasBps = routeLiquidityUsd > 0 && gasUsd !== null ? gasUsd / routeLiquidityUsd * 10_000 : 0;
  const requiredPremiumBps = ltvBreakEvenPremiumBps !== null ? ltvBreakEvenPremiumBps + SLIPPAGE_BPS + gasBps : null;
  const premiumGapBps = acceptedVsReferenceBps !== null && requiredPremiumBps !== null ? requiredPremiumBps - acceptedVsReferenceBps : null;
  const borrowablePerReferenceUsd = acceptedUsdPerCollateral !== null && referenceUsdPerCollateral
    ? (acceptedUsdPerCollateral / referenceUsdPerCollateral) * ltv
    : null;
  const acquisitionCostForRouteUsd = borrowablePerReferenceUsd && borrowablePerReferenceUsd > 0
    ? routeLiquidityUsd / borrowablePerReferenceUsd
    : null;
  const slippageUsd = acquisitionCostForRouteUsd !== null ? acquisitionCostForRouteUsd * SLIPPAGE_BPS / 10_000 : null;
  const netEdgeUsd = acquisitionCostForRouteUsd !== null
    ? routeLiquidityUsd - acquisitionCostForRouteUsd - (slippageUsd || 0) - (gasUsd || 0)
    : null;
  const publicMintOpen = maxDepositRaw !== null && maxDepositRaw !== undefined
    ? BigInt(maxDepositRaw) > 0n
    : maxMintRaw !== null && maxMintRaw !== undefined
      ? BigInt(maxMintRaw) > 0n
      : null;
  const referenceClearsBreakEven = premiumGapBps !== null && premiumGapBps <= 0 && netEdgeUsd !== null && netEdgeUsd > MIN_PROFIT_USD;
  const watchCandidate = Boolean(referenceClearsBreakEven && publicMintOpen !== false);

  return {
    protocol: row.protocol,
    chainId,
    chain: row.chain || CHAIN_CONFIGS[chainId]?.name || String(chainId),
    consumer: row.consumer || null,
    collateral: collateralMeta,
    collateralAsset: collateralAssetMeta,
    borrowAsset: borrowAssetMeta,
    ltv,
    routeLiquidityUsd: round(routeLiquidityUsd, 6),
    riskTags: row.riskTags || [],
    euler: {
      borrowEvault,
      oracle: oracle ? normalizeAddress(oracle) : null,
      unitOfAccount,
      oracleQuoteMode,
      oracleQuoteRaw: oracleQuoteRaw !== null ? oracleQuoteRaw.toString() : null,
      unitAccountQuoteRaw: unitAccountQuoteRaw !== null ? unitAccountQuoteRaw.toString() : null,
      borrowUnitQuoteRaw: borrowUnitQuoteRaw !== null ? borrowUnitQuoteRaw.toString() : null,
      acceptedBorrowPerCollateral: round(acceptedBorrowPerCollateral, 12),
      acceptedUsdPerCollateral: round(acceptedUsdPerCollateral, 12),
    },
    nav: {
      totalAssetsRaw: totalAssetsRaw !== null && totalAssetsRaw !== undefined ? BigInt(totalAssetsRaw).toString() : null,
      totalSupplyRaw: totalSupplyRaw !== null && totalSupplyRaw !== undefined ? BigInt(totalSupplyRaw).toString() : null,
      convertOneShareToAssetsRaw: convertRaw !== null && convertRaw !== undefined ? BigInt(convertRaw).toString() : null,
      previewRedeemOneShareRaw: previewRaw !== null && previewRaw !== undefined ? BigInt(previewRaw).toString() : null,
      navAssetsPerShare: round(navAssetsPerShare, 12),
      collateralAssetPriceUsd: round(collateralAssetPriceUsd, 8),
      directCollateralPriceUsd: round(directCollateralPriceUsd, 8),
      referenceUsdPerCollateral: round(referenceUsdPerCollateral, 12),
      maxDepositRaw: maxDepositRaw !== null && maxDepositRaw !== undefined ? BigInt(maxDepositRaw).toString() : null,
      maxMintRaw: maxMintRaw !== null && maxMintRaw !== undefined ? BigInt(maxMintRaw).toString() : null,
      publicMintOpen,
    },
    economics: {
      borrowAssetPriceUsd: round(borrowAssetPriceUsd, 8),
      acceptedVsReferenceBps: round(acceptedVsReferenceBps, 6),
      ltvBreakEvenPremiumBps: round(ltvBreakEvenPremiumBps, 6),
      slippageBps: SLIPPAGE_BPS,
      gasUsd: round(gasUsd, 6),
      gasBps: round(gasBps, 6),
      requiredPremiumBps: round(requiredPremiumBps, 6),
      premiumGapBps: round(premiumGapBps, 6),
      acquisitionCostForRouteUsd: round(acquisitionCostForRouteUsd, 6),
      netEdgeUsd: round(netEdgeUsd, 6),
      routeFlipBps: round(premiumGapBps, 6),
    },
    routeGate: {
      status: watchCandidate ? "reference-positive-needs-exact-acquisition-and-fork" : acceptedVsReferenceBps === null ? "missing-oracle-or-reference" : "reference-below-lltv-break-even",
      referencePremiumClearsBreakEven: Boolean(referenceClearsBreakEven),
      publicMintOpen,
      exactUnderlyingAcquisitionQuoted: false,
      forkProof: false,
      nextMissingInputs: [
        acceptedVsReferenceBps === null ? "Euler oracle or reference price" : null,
        referenceClearsBreakEven ? null : "LLTV-adjusted premium",
        publicMintOpen === false ? "public mint/deposit route" : "exact underlying acquisition quote",
        "fork proof",
      ].filter(Boolean),
    },
    reviewCandidate: true,
    watchCandidate,
    routePositive: false,
    blockers: [
      watchCandidate ? "Reference model needs exact underlying acquisition quote before fork" : "Euler oracle/reference premium below LLTV break-even or unresolved",
      publicMintOpen === false ? "Collateral eVault maxDeposit/maxMint is closed" : null,
      "No exact underlying acquisition/exit quote",
      "No fork proof or signed-action justification",
    ].filter(Boolean),
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rows = collectRows();
  const chainIds = [...new Set(rows.map((row) => Number(row.chainId)).filter((chainId) => CHAIN_CONFIGS[chainId]))].sort((a, b) => a - b);
  const rpcPool = await resolveRpcPool(chainIds);
  const providers = new Map();
  const blocks = new Map();
  for (const chainId of chainIds) {
    if (!rpcPool[chainId]) continue;
    const provider = new ethers.JsonRpcProvider(rpcPool[chainId]);
    providers.set(chainId, provider);
    const block = await provider.getBlock("latest").catch(() => null);
    if (block) blocks.set(chainId, block);
  }

  const priceRefs = [];
  for (const row of rows) {
    priceRefs.push({ chainId: row.chainId, address: row.collateral?.address }, { chainId: row.chainId, address: row.borrowAsset?.address });
  }
  for (const row of rows) {
    const provider = providers.get(Number(row.chainId));
    if (!provider) continue;
    const asset = await safeCall(provider, row.collateral?.address, TOKEN, "asset");
    if (asset) priceRefs.push({ chainId: row.chainId, address: asset });
  }
  const prices = await fetchPrices(priceRefs);
  const gasAssetPrices = await fetchCoinKeyPrices(chainIds.map((chainId) => CHAIN_CONFIGS[chainId]?.gasPriceKey));
  const gasByChain = {};
  for (const chainId of chainIds) {
    const provider = providers.get(chainId);
    const cfg = CHAIN_CONFIGS[chainId];
    const gasPriceWei = provider ? await provider.send("eth_gasPrice", []).then(BigInt).catch(() => 0n) : 0n;
    const gasAssetPriceUsd = cfg?.gasPriceKey ? gasAssetPrices.get(cfg.gasPriceKey.toLowerCase()) || null : null;
    const gasUsd = gasAssetPriceUsd && gasPriceWei > 0n ? Number(gasPriceWei) * GAS_UNITS / 1e18 * gasAssetPriceUsd : null;
    gasByChain[chainId] = { chainId, chain: cfg?.name || String(chainId), gasPriceWei: gasPriceWei.toString(), gasAssetPriceUsd, gasUsd };
  }

  const enriched = [];
  for (const row of rows) {
    const chainId = Number(row.chainId);
    const provider = providers.get(chainId);
    if (!provider) {
      enriched.push({ protocol: row.protocol, chainId, chain: row.chain, consumer: row.consumer, collateral: row.collateral, borrowAsset: row.borrowAsset, routePositive: false, reviewCandidate: true, watchCandidate: false, blockers: ["Missing RPC for configured chain"] });
      continue;
    }
    enriched.push(await enrichRow(provider, row, prices, gasByChain[chainId]?.gasUsd).catch((err) => ({ error: err.message || String(err), sourceRow: row, routePositive: false, reviewCandidate: true, watchCandidate: false })));
  }
  enriched.sort((a, b) => Number(b.watchCandidate) - Number(a.watchCandidate)
    || (Number(a.economics?.premiumGapBps ?? Infinity) - Number(b.economics?.premiumGapBps ?? Infinity))
    || Number(b.routeLiquidityUsd || 0) - Number(a.routeLiquidityUsd || 0));
  const routePositive = 0;
  const watchCandidates = enriched.filter((row) => row.watchCandidate).length;
  const primaryBlockEntry = blocks.get(1) ? [1, blocks.get(1)] : [...blocks.entries()][0] || [null, null];
  const [primaryBlockChainId, primaryBlock] = primaryBlockEntry;
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-focused-euler-evk-review-producers.js",
    scope: "Read-only Euler EVK high-LTV eVault collateral oracle/NAV route probe",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    block: { chainId: primaryBlockChainId, chain: CHAIN_CONFIGS[primaryBlockChainId]?.name || null, number: primaryBlock?.number || null, timestamp: primaryBlock?.timestamp || null, iso: primaryBlock?.timestamp ? new Date(Number(primaryBlock.timestamp) * 1000).toISOString() : null },
    blocks: Object.fromEntries([...blocks.entries()].map(([chainId, block]) => [chainId, { chain: CHAIN_CONFIGS[chainId]?.name || String(chainId), number: block?.number || null, timestamp: block?.timestamp || null, iso: block?.timestamp ? new Date(Number(block.timestamp) * 1000).toISOString() : null }])),
    thresholds: { minRouteLiquidityUsd: MIN_ROUTE_LIQUIDITY_USD, maxRows: MAX_ROWS, slippageBps: SLIPPAGE_BPS, gasUnits: GAS_UNITS, minProfitUsd: MIN_PROFIT_USD },
    gas: { gasUnits: GAS_UNITS, gasPriceWei: gasByChain[1]?.gasPriceWei || null, ethPriceUsd: gasAssetPrices.get("coingecko:ethereum") || null, gasUsd: gasByChain[1]?.gasUsd || null, byChain: gasByChain },
    summary: {
      rowsInput: rows.length,
      chainsInput: chainIds.length,
      chainsWithRpc: providers.size,
      byChain: countBy(enriched, (row) => row.chain || CHAIN_CONFIGS[row.chainId]?.name),
      byBorrowAsset: countBy(enriched, (row) => row.borrowAsset?.symbol),
      byCollateralAsset: countBy(enriched, (row) => row.collateralAsset?.symbol || row.collateral?.symbol),
      reviewCandidates: enriched.filter((row) => row.reviewCandidate).length,
      rowsWithOracleQuote: enriched.filter((row) => row.euler?.oracleQuoteRaw || row.euler?.unitAccountQuoteRaw).length,
      rowsWithUnitAccountQuote: enriched.filter((row) => row.euler?.unitAccountQuoteRaw).length,
      rowsWithNavReference: enriched.filter((row) => row.nav?.referenceUsdPerCollateral).length,
      rowsWithPublicMintOpen: enriched.filter((row) => row.nav?.publicMintOpen === true).length,
      rowsWithPublicMintClosed: enriched.filter((row) => row.nav?.publicMintOpen === false).length,
      closestPremiumGapBps: minNumber(enriched, (row) => row.economics?.premiumGapBps),
      bestNetEdgeUsd: maxNumber(enriched, (row) => row.economics?.netEdgeUsd),
      watchCandidates,
      routePositive,
      signedActionJustified: false,
    },
    rows: enriched,
    nextRoutePositiveCriteria: [
      "Euler oracle accepted value exceeds executable eVault share acquisition cost after LTV haircut, gas, and slippage",
      "collateral eVault has public mint/deposit capacity or another exact acquisition path",
      "underlying acquisition and borrow-asset exit are exact-quoted for the route size",
      "local fork proof extracts positive net value",
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  console.log(`Focused Euler EVK scan: rows=${artifact.summary.rowsInput} oracleQuotes=${artifact.summary.rowsWithOracleQuote} watch=${watchCandidates} routePositive=0`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
