#!/usr/bin/env node
// Read-only focused scanner for Morpho high-LTV producer review rows.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const IN = path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "focused-morpho-review-producers.json");

const ROUTE_LIQUIDITY_USD = Number(process.env.FOCUSED_MORPHO_MIN_LIQUIDITY_USD || "10000");
const MAX_ROWS = Number(process.env.FOCUSED_MORPHO_MAX_ROWS || "40");
const SLIPPAGE_BPS = Number(process.env.FOCUSED_MORPHO_SLIPPAGE_BPS || "100");
const GAS_UNITS = Number(process.env.FOCUSED_MORPHO_GAS_UNITS || "1800000");
const UNISWAP_FEES = [100, 500, 3000, 10000];
const PROBE_ADDRESS = "0x000000000000000000000000000000000000dEaD";

const CHAIN_CONFIGS = {
  1: { name: "Ethereum", coinSlug: "ethereum", exactOutputQuoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", gasPriceKey: "coingecko:ethereum" },
  8453: { name: "Base", coinSlug: "base", exactOutputQuoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a", gasPriceKey: "coingecko:ethereum" },
  42161: { name: "Arbitrum", coinSlug: "arbitrum", exactOutputQuoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", gasPriceKey: "coingecko:ethereum" },
  130: { name: "Unichain", coinSlug: "unichain", exactOutputQuoter: null, gasPriceKey: "coingecko:ethereum" },
  999: { name: "HyperEVM", coinSlug: "hyperliquid", exactOutputQuoter: null, gasPriceKey: "coingecko:hyperliquid" },
};

const DEFAULT_TARGET_SYMBOLS = [
  "wJAAA", "wsrUSD", "SolvBTC", "EUTBL", "PT-USDG-28MAY2026", "PWrUSDC-hyper",
  "AVLT", "PT-USDai-18JUN2026", "PT-USDai-18JUN2026-(ARB)", "PT-cUSD-23JUL2026-(ETH)", "PT-apxUSD-18JUN2026",
  "LBTC", "thBILL", "syrupUSDC", "wsuperOETHb", "yoUSD", "steakUSDC", "kHYPE", "wstHYPE", "lstHYPE", "cmETH", "hbHYPE", "beHYPE", "siUSD",
].join(",");

const TARGET_SYMBOLS = new Set(String(process.env.FOCUSED_MORPHO_SYMBOLS || DEFAULT_TARGET_SYMBOLS)
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean));

const ERC20 = new ethers.Interface([
  "function asset() view returns (address)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function maxMint(address receiver) view returns (uint256)",
]);
const MORPHO_ORACLE = new ethers.Interface(["function price() view returns (uint256)"]);
const QUOTER = new ethers.Interface([
  "function quoteExactOutput(bytes path,uint256 amountOut) returns (uint256 amountIn,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
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

async function rpcCall(url, method, params = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "rpc error");
  return json.result ?? null;
}

async function resolveRpcPool(chainIds) {
  const wanted = new Set(chainIds.map(Number));
  const pool = {};
  for (const url of loadRpcUrls()) {
    try {
      const chainId = Number(BigInt(await rpcCall(url, "eth_chainId")));
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
  try { return Number(ethers.formatUnits(raw, Number(decimals))); } catch (_) { return null; }
}

function decimalToUnits(value, decimals) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const places = Math.min(Number(decimals), 18);
  const fixed = n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: places });
  try { return ethers.parseUnits(fixed, Number(decimals)); } catch (_) { return null; }
}

function bpsDiff(reference, observed) {
  const ref = Number(reference || 0);
  const obs = Number(observed || 0);
  if (!Number.isFinite(ref) || !Number.isFinite(obs) || ref <= 0 || obs <= 0) return null;
  return ((obs / ref) - 1) * 10_000;
}

function classifyProducer(row, details) {
  const symbol = String(details.symbol || row.collateral?.symbol || "");
  const name = String(details.name || "");
  const text = `${symbol} ${name}`.toUpperCase();
  const riskTags = new Set(row.riskTags || []);
  const types = [];
  const evidence = [];
  const add = (type, reason) => {
    if (!types.includes(type)) types.push(type);
    if (reason) evidence.push(reason);
  };
  if (/\bPT[-_ ]|PRINCIPAL TOKEN|PENDLE/.test(text) || riskTags.has("principal-token")) add("principal-token", "PT/Pendle naming or risk tag");
  if (/OUSG|USDY|USTB|USCC|TBILL|STBT|BACKED|TOKENIZED|TREASUR|T-BILL|BOND|GOVERNMENT|CREDIT|RWA|JAAA|EUTBL|MIDAS|FASANARA|\bMF[-_ ]/.test(text) || riskTags.has("rwa-or-credit")) add("rwa-or-credit", "RWA/credit naming or risk tag");
  if (/OFT|USDT0|WARP|HYP|BRIDGE|LAYERZERO|WORMHOLE|AXELAR|HYPER/.test(text) || riskTags.has("bridge-wrapper")) add("bridge-wrapper", "bridge/wrapper naming or risk tag");
  if (details.assetAddress && (details.totalAssetsRaw !== null || details.convertRaw !== null || details.previewRedeemRaw !== null)) add("erc4626-like", "asset/totalAssets/convertToAssets/previewRedeem responded");
  if (/\bOETH\b|ORIGIN ETHER|ETHPLUS|ETH\+|LST|LRT|RESTAK|LIQUID STAK/.test(text)) add("lst-lrt-or-eth-wrapper", "ETH/LST wrapper naming");
  if (/VAULT|SHARE|STAKED|STAKING|YIELD|SAVING|WRAPPED|RECEIPT|WRAPPED SAVINGS|YN|STAKEDAO/.test(text) || riskTags.has("receipt-or-yield-bearing")) add("yield-or-receipt-wrapper", "yield/receipt naming or risk tag");
  if (/BTC|LBTC|SOLVBTC/.test(text)) add("btc-wrapper", "BTC wrapper naming");
  if (/USD|EUR|STABLE|SAVING/.test(text)) add("stable-wrapper", "stable/RWA cash-like naming");
  if (row.knownLocalToken) add("known-artifact-token", "matched prior local artifact inventory");
  if (!types.length) add("unknown-noncanonical", "noncanonical token without resolved producer class");
  return {
    primaryType: types[0],
    types,
    riskTags: [...riskTags].sort(),
    knownLocalToken: row.knownLocalToken || null,
    evidence: [...new Set(evidence)],
  };
}

function routeGateStatus({ exactAcquisitionAvailable, acceptedVsAcquisitionBps, acceptedVsReferenceBps, requiredPremiumBps, netEdgeUsd }) {
  if (requiredPremiumBps === null) return "missing-required-premium";
  if (exactAcquisitionAvailable) {
    if (acceptedVsAcquisitionBps !== null && acceptedVsAcquisitionBps >= requiredPremiumBps && netEdgeUsd !== null && netEdgeUsd > 0) return "route-positive";
    return "exact-acquisition-negative";
  }
  if (acceptedVsReferenceBps === null) return "missing-reference-price";
  if (acceptedVsReferenceBps >= requiredPremiumBps) return "reference-positive-needs-exact-quote";
  return "reference-below-lltv-break-even";
}

function countBy(rows, getKey) {
  const out = {};
  for (const row of rows) {
    const key = getKey(row) || "unknown";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function minNumber(rows, getValue) {
  const values = rows.map(getValue).filter((value) => Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
}

function sameAddress(a, b) {
  const left = lowerAddress(a);
  const right = lowerAddress(b);
  return Boolean(left && right && left === right);
}

function bigintOrNull(value) {
  try {
    if (value === null || value === undefined) return null;
    return BigInt(value);
  } catch (_) {
    return null;
  }
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
      if (row.protocol !== "Morpho Blue" || !row.reviewCandidate) continue;
      if (Number(row.routeLiquidityUsd || 0) < ROUTE_LIQUIDITY_USD) continue;
      rows.push(row);
    }
  }
  const seen = new Set();
  const deduped = [];
  for (const row of rows.sort((a, b) => Number(b.routeLiquidityUsd || 0) - Number(a.routeLiquidityUsd || 0))) {
    const key = `${Number(row.chainId)}:${lowerAddress(row.collateral?.address)}:${lowerAddress(row.borrowAsset?.address)}:${row.consumer?.oracle || ""}:${row.consumer?.marketId || ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  const priority = deduped.filter((row) => TARGET_SYMBOLS.has(row.collateral?.symbol));
  const rest = deduped.filter((row) => !TARGET_SYMBOLS.has(row.collateral?.symbol)).slice(0, MAX_ROWS);
  return [...priority, ...rest].slice(0, Math.max(MAX_ROWS, priority.length));
}

function encodeExactOutputPath(tokenOut, fee, tokenIn) {
  return ethers.solidityPacked(["address", "uint24", "address"], [tokenOut, fee, tokenIn]);
}

async function quoteDirectExactOutput(provider, chainConfig, tokenIn, tokenOut, amountOut) {
  if (!chainConfig?.exactOutputQuoter) return null;
  const rows = [];
  for (const fee of UNISWAP_FEES) {
    const pathBytes = encodeExactOutputPath(tokenOut, fee, tokenIn);
    const raw = await provider.call({
      to: chainConfig.exactOutputQuoter,
      data: QUOTER.encodeFunctionData("quoteExactOutput", [pathBytes, amountOut]),
    }).catch(() => null);
    if (!raw) continue;
    const decoded = QUOTER.decodeFunctionResult("quoteExactOutput", raw);
    rows.push({ fee, amountInRaw: decoded[0], gasEstimate: decoded[3] });
  }
  rows.sort((a, b) => (a.amountInRaw < b.amountInRaw ? -1 : a.amountInRaw > b.amountInRaw ? 1 : 0));
  return rows[0] || null;
}

async function enrichRow(provider, chainConfig, row, prices, gasUsd) {
  const chainId = Number(row.chainId);
  const collateral = normalizeAddress(row.collateral?.address);
  const loanAsset = normalizeAddress(row.borrowAsset?.address);
  const oracle = normalizeAddress(row.consumer?.oracle);
  const collateralDecimals = Number(row.collateral?.decimals ?? 18);
  const loanDecimals = Number(row.borrowAsset?.decimals ?? 18);
  const lltv = Number(row.ltv || 0);
  const routeLiquidityUsd = Number(row.routeLiquidityUsd || 0);
  const oneShareRaw = 10n ** BigInt(Math.min(collateralDecimals, 36));
  const [symbol, name, supplyRaw, asset, totalAssetsRaw, convertRaw, previewRedeemRaw, maxDepositRaw, maxMintRaw, oracleRaw] = await Promise.all([
    safeCall(provider, collateral, ERC20, "symbol"),
    safeCall(provider, collateral, ERC20, "name"),
    safeCall(provider, collateral, ERC20, "totalSupply"),
    safeCall(provider, collateral, ERC20, "asset"),
    safeCall(provider, collateral, ERC20, "totalAssets"),
    safeCall(provider, collateral, ERC20, "convertToAssets", [oneShareRaw]),
    safeCall(provider, collateral, ERC20, "previewRedeem", [oneShareRaw]),
    safeCall(provider, collateral, ERC20, "maxDeposit", [PROBE_ADDRESS]),
    safeCall(provider, collateral, ERC20, "maxMint", [PROBE_ADDRESS]),
    oracle ? safeCall(provider, oracle, MORPHO_ORACLE, "price") : Promise.resolve(null),
  ]);
  const collateralPriceUsd = priceFromMap(prices, chainId, collateral);
  const loanPriceUsd = priceFromMap(prices, chainId, loanAsset);
  const assetAddress = normalizeAddress(asset);
  const assetDecimalsRaw = assetAddress ? await safeCall(provider, assetAddress, ERC20, "decimals") : null;
  const assetDecimals = assetDecimalsRaw === null ? collateralDecimals : Number(assetDecimalsRaw);
  const assetPriceUsd = assetAddress ? priceFromMap(prices, chainId, assetAddress) : null;
  const acceptedLoanPerCollateralRaw = oracleRaw === null ? null : ((10n ** BigInt(collateralDecimals)) * BigInt(oracleRaw)) / (10n ** 36n);
  const acceptedLoanPerCollateral = acceptedLoanPerCollateralRaw === null ? null : formatUnitsNumber(acceptedLoanPerCollateralRaw, loanDecimals);
  const acceptedUsdPerCollateral = acceptedLoanPerCollateral !== null && loanPriceUsd ? acceptedLoanPerCollateral * loanPriceUsd : null;
  const navAssetsPerShare = convertRaw === null ? null : formatUnitsNumber(convertRaw, assetDecimals);
  const navUsdPerCollateral = navAssetsPerShare !== null && assetPriceUsd ? navAssetsPerShare * assetPriceUsd : null;
  const referenceUsdPerCollateral = collateralPriceUsd || navUsdPerCollateral || null;
  const acceptedVsReferenceBps = bpsDiff(referenceUsdPerCollateral, acceptedUsdPerCollateral);
  const ltvBreakEvenPremiumBps = lltv > 0 ? ((1 / lltv) - 1) * 10_000 : null;
  const gasBpsAtCapacity = routeLiquidityUsd > 0 && gasUsd ? gasUsd / routeLiquidityUsd * 10_000 : null;
  const requiredPremiumBps = ltvBreakEvenPremiumBps === null ? null : ltvBreakEvenPremiumBps + SLIPPAGE_BPS + Number(gasBpsAtCapacity || 0);
  const collateralNeeded = acceptedUsdPerCollateral && lltv > 0 ? routeLiquidityUsd / (acceptedUsdPerCollateral * lltv) : null;
  const collateralNeededRaw = decimalToUnits(collateralNeeded, collateralDecimals);
  const directQuote = collateralNeededRaw && loanAsset
    ? await quoteDirectExactOutput(provider, chainConfig, loanAsset, collateral, collateralNeededRaw).catch(() => null)
    : null;
  const quoteLoanIn = directQuote ? formatUnitsNumber(directQuote.amountInRaw, loanDecimals) : null;
  const quoteAcquisitionUsdPerCollateral = quoteLoanIn !== null && loanPriceUsd && collateralNeeded ? (quoteLoanIn * loanPriceUsd) / collateralNeeded : null;
  const acceptedVsQuoteBps = bpsDiff(quoteAcquisitionUsdPerCollateral, acceptedUsdPerCollateral);
  let assetNeededRaw = null;
  if (collateralNeededRaw && assetAddress) {
    assetNeededRaw = await safeCall(provider, collateral, ERC20, "previewRedeem", [collateralNeededRaw]);
    if (assetNeededRaw === null) assetNeededRaw = await safeCall(provider, collateral, ERC20, "convertToAssets", [collateralNeededRaw]);
  }
  const maxDepositBig = bigintOrNull(maxDepositRaw);
  const assetNeededBig = bigintOrNull(assetNeededRaw);
  const depositCapOk = assetNeededBig === null ? false : (maxDepositBig === null ? null : maxDepositBig >= assetNeededBig);
  let erc4626MintAcquisition = null;
  if (assetAddress && assetNeededBig !== null && depositCapOk !== false && collateralNeeded) {
    const assetNeeded = formatUnitsNumber(assetNeededBig, assetDecimals);
    if (sameAddress(assetAddress, loanAsset)) {
      const amountIn = formatUnitsNumber(assetNeededBig, loanDecimals);
      const costUsd = amountIn !== null && loanPriceUsd ? amountIn * loanPriceUsd : null;
      erc4626MintAcquisition = {
        mode: "erc4626-mint-from-loan-asset",
        assetNeededRaw: assetNeededBig.toString(),
        assetNeeded,
        amountInRaw: assetNeededBig.toString(),
        amountIn,
        depositCapOk,
        costUsd,
        acquisitionUsdPerCollateral: costUsd !== null ? costUsd / collateralNeeded : null,
        acceptedVsAcquisitionBps: costUsd !== null ? bpsDiff(costUsd / collateralNeeded, acceptedUsdPerCollateral) : null,
      };
    } else {
      const assetQuote = await quoteDirectExactOutput(provider, chainConfig, loanAsset, assetAddress, assetNeededBig).catch(() => null);
      const amountIn = assetQuote ? formatUnitsNumber(assetQuote.amountInRaw, loanDecimals) : null;
      const costUsd = amountIn !== null && loanPriceUsd ? amountIn * loanPriceUsd : null;
      erc4626MintAcquisition = assetQuote ? {
        mode: "uniswap-v3-to-erc4626-asset-mint",
        asset: assetAddress,
        assetNeededRaw: assetNeededBig.toString(),
        assetNeeded,
        depositCapOk,
        quote: {
          fee: assetQuote.fee,
          amountInRaw: assetQuote.amountInRaw.toString(),
          amountIn,
          gasEstimate: assetQuote.gasEstimate?.toString() || null,
        },
        costUsd,
        acquisitionUsdPerCollateral: costUsd !== null ? costUsd / collateralNeeded : null,
        acceptedVsAcquisitionBps: costUsd !== null ? bpsDiff(costUsd / collateralNeeded, acceptedUsdPerCollateral) : null,
      } : null;
    }
  }
  const directAcquisitionCostUsd = quoteLoanIn !== null && loanPriceUsd ? quoteLoanIn * loanPriceUsd : null;
  const exactAcquisitionCandidates = [
    directQuote && directAcquisitionCostUsd !== null ? {
      mode: "direct-uniswap-v3-exact-output",
      costUsd: directAcquisitionCostUsd,
      acquisitionUsdPerCollateral: quoteAcquisitionUsdPerCollateral,
      acceptedVsAcquisitionBps: acceptedVsQuoteBps,
    } : null,
    erc4626MintAcquisition && erc4626MintAcquisition.costUsd !== null ? {
      mode: erc4626MintAcquisition.mode,
      costUsd: erc4626MintAcquisition.costUsd,
      acquisitionUsdPerCollateral: erc4626MintAcquisition.acquisitionUsdPerCollateral,
      acceptedVsAcquisitionBps: erc4626MintAcquisition.acceptedVsAcquisitionBps,
    } : null,
  ].filter(Boolean).sort((a, b) => Number(a.costUsd) - Number(b.costUsd));
  const selectedAcquisition = exactAcquisitionCandidates[0] || null;
  const acquisitionCostUsd = selectedAcquisition?.costUsd ?? (referenceUsdPerCollateral && collateralNeeded ? referenceUsdPerCollateral * collateralNeeded : null);
  const acceptedVsAcquisitionBps = selectedAcquisition?.acceptedVsAcquisitionBps ?? null;
  const grossEdgeUsd = acquisitionCostUsd === null ? null : routeLiquidityUsd - acquisitionCostUsd;
  const netEdgeUsd = grossEdgeUsd === null ? null : grossEdgeUsd - Number(gasUsd || 0) - (routeLiquidityUsd * SLIPPAGE_BPS / 10_000);
  const premiumGapBps = acceptedVsReferenceBps !== null && requiredPremiumBps !== null ? requiredPremiumBps - acceptedVsReferenceBps : null;
  const quotePremiumGapBps = acceptedVsAcquisitionBps !== null && requiredPremiumBps !== null ? requiredPremiumBps - acceptedVsAcquisitionBps : null;
  const shockNeededBps = selectedAcquisition ? quotePremiumGapBps : premiumGapBps;
  const routeFlipBps = Number.isFinite(shockNeededBps) ? Math.max(0, shockNeededBps) : null;
  const netGapUsd = netEdgeUsd === null ? null : Math.max(0, -netEdgeUsd);
  const producer = classifyProducer(row, {
    symbol: symbol?.toString() || row.collateral?.symbol || null,
    name: name?.toString() || null,
    assetAddress,
    totalAssetsRaw,
    convertRaw,
    previewRedeemRaw,
  });
  const gateStatus = routeGateStatus({ exactAcquisitionAvailable: Boolean(selectedAcquisition), acceptedVsAcquisitionBps, acceptedVsReferenceBps, requiredPremiumBps, netEdgeUsd });
  const routePositive = Boolean(
    selectedAcquisition
    && acceptedVsAcquisitionBps !== null
    && requiredPremiumBps !== null
    && acceptedVsAcquisitionBps >= requiredPremiumBps
    && netEdgeUsd !== null
    && netEdgeUsd > 0
  );
  return {
    protocol: row.protocol,
    chain: row.chain,
    chainId: row.chainId,
    marketId: row.consumer?.marketId,
    oracle,
    collateral: {
      address: collateral,
      symbol: symbol?.toString() || row.collateral?.symbol || null,
      name: name?.toString() || null,
      decimals: collateralDecimals,
      totalSupply: supplyRaw === null ? null : ethers.formatUnits(supplyRaw, collateralDecimals),
      priceUsd: collateralPriceUsd,
    },
    loanAsset: {
      address: loanAsset,
      symbol: row.borrowAsset?.symbol || null,
      decimals: loanDecimals,
      priceUsd: loanPriceUsd,
    },
    erc4626: {
      asset: assetAddress,
      assetDecimals,
      assetPriceUsd,
      totalAssetsRaw: totalAssetsRaw?.toString() || null,
      convertOneShareToAssetsRaw: convertRaw?.toString() || null,
      previewRedeemOneShareRaw: previewRedeemRaw?.toString() || null,
      maxDepositProbeRaw: maxDepositRaw?.toString() || null,
      maxMintProbeRaw: maxMintRaw?.toString() || null,
      navAssetsPerShare,
      navUsdPerCollateral,
    },
    producer,
    morpho: {
      lltv,
      routeLiquidityUsd,
      supplyAssetsUsd: row.supplyAssetsUsd ?? null,
      borrowAssetsUsd: row.borrowAssetsUsd ?? null,
      utilization: row.utilization ?? null,
      oraclePriceRaw: oracleRaw?.toString() || null,
      acceptedLoanPerCollateral,
      acceptedUsdPerCollateral,
    },
    economics: {
      referenceUsdPerCollateral,
      acceptedVsReferenceBps,
      ltvBreakEvenPremiumBps,
      requiredPremiumBps,
      gasUsd,
      collateralNeeded,
      collateralNeededRaw: collateralNeededRaw?.toString() || null,
      directUniswapV3ExactOutputQuote: directQuote ? {
        fee: directQuote.fee,
        amountInRaw: directQuote.amountInRaw.toString(),
        amountIn: quoteLoanIn,
        gasEstimate: directQuote.gasEstimate?.toString() || null,
        quoteAcquisitionUsdPerCollateral,
        acceptedVsQuoteBps,
      } : null,
      erc4626MintAcquisition,
      selectedAcquisitionRoute: selectedAcquisition,
      acquisitionCostUsd,
      grossEdgeUsd,
      netEdgeUsd,
      netGapUsd,
      premiumGapBps,
      quotePremiumGapBps,
      shockNeededBps,
      routeFlipBps,
      acceptedVsAcquisitionBps,
    },
    routeGate: {
      status: gateStatus,
      exactQuoteConfigured: Boolean(chainConfig?.exactOutputQuoter),
      exactAcquisitionAvailable: Boolean(selectedAcquisition),
      directExactQuoteAvailable: Boolean(directQuote),
      erc4626MintAcquisitionAvailable: Boolean(erc4626MintAcquisition),
      selectedAcquisitionMode: selectedAcquisition?.mode || null,
      referencePremiumClearsBreakEven: premiumGapBps !== null ? premiumGapBps <= 0 : false,
      exactQuotePremiumClearsBreakEven: quotePremiumGapBps !== null ? quotePremiumGapBps <= 0 : false,
      routeFlipBps,
      shockNeededBps,
      permissionlessNavHint: Boolean(assetAddress && (convertRaw !== null || previewRedeemRaw !== null)),
      nextMissingInputs: [
        selectedAcquisition ? null : "exact acquisition route",
        !chainConfig?.exactOutputQuoter ? "configured exact quoter for chain" : null,
        premiumGapBps !== null && premiumGapBps > 0 ? "LLTV-adjusted premium" : null,
        netEdgeUsd !== null && netEdgeUsd <= 0 ? "positive net economics" : null,
        "fork proof",
      ].filter(Boolean),
    },
    reviewCandidate: true,
    watchCandidate: false,
    routePositive,
    blockers: [
      routePositive ? null : "No current direct executable acquisition route with positive LLTV-adjusted economics",
      selectedAcquisition ? null : "No exact direct DEX or ERC4626 mint acquisition route for full route size",
      chainConfig?.exactOutputQuoter ? null : "No configured exact DEX quoter for this chain in the focused scanner",
      assetNeededBig !== null && depositCapOk === false ? "ERC4626 maxDeposit probe below modeled route size" : null,
      acceptedVsReferenceBps === null ? "Missing public/NAV reference price" : null,
      acceptedVsReferenceBps !== null && requiredPremiumBps !== null && acceptedVsReferenceBps < requiredPremiumBps ? "Oracle/reference premium below LLTV break-even after gas/slippage" : null,
      producer.primaryType === "unknown-noncanonical" ? "Producer type unresolved" : null,
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
  const firstPrices = await fetchPrices(priceRefs);
  const metas = [];
  for (const row of rows) {
    const provider = providers.get(Number(row.chainId));
    if (!provider) continue;
    const asset = await safeCall(provider, row.collateral?.address, ERC20, "asset");
    if (asset) priceRefs.push({ chainId: row.chainId, address: asset });
  }
  const prices = await fetchPrices(priceRefs);
  for (const [key, value] of firstPrices.entries()) if (!prices.has(key)) prices.set(key, value);

  const gasPriceKeys = chainIds.map((chainId) => CHAIN_CONFIGS[chainId]?.gasPriceKey).filter(Boolean);
  const gasAssetPrices = await fetchCoinKeyPrices(gasPriceKeys);
  const gasByChain = {};
  for (const chainId of chainIds) {
    const provider = providers.get(chainId);
    const cfg = CHAIN_CONFIGS[chainId];
    const gasPriceWei = provider ? await provider.send("eth_gasPrice", []).then(BigInt).catch(() => 0n) : 0n;
    const gasAssetPriceUsd = cfg?.gasPriceKey ? gasAssetPrices.get(cfg.gasPriceKey.toLowerCase()) || null : null;
    const gasUsd = gasAssetPriceUsd && gasPriceWei > 0n ? Number(gasPriceWei) * GAS_UNITS / 1e18 * gasAssetPriceUsd : null;
    gasByChain[chainId] = { chainId, chain: cfg?.name || String(chainId), gasPriceWei: gasPriceWei.toString(), gasAssetPriceUsd, gasUsd };
  }

  for (const row of rows) {
    const chainId = Number(row.chainId);
    const provider = providers.get(chainId);
    const cfg = CHAIN_CONFIGS[chainId];
    if (!provider) {
      metas.push({
        protocol: row.protocol,
        chain: row.chain || cfg?.name || String(chainId),
        chainId,
        marketId: row.consumer?.marketId || null,
        oracle: row.consumer?.oracle || null,
        collateral: row.collateral || null,
        loanAsset: row.borrowAsset || null,
        morpho: { lltv: row.ltv ?? null, routeLiquidityUsd: row.routeLiquidityUsd ?? null },
        routeGate: { status: "missing-rpc", exactQuoteConfigured: Boolean(cfg?.exactOutputQuoter), exactAcquisitionAvailable: false, routeFlipBps: null },
        economics: { routeFlipBps: null, shockNeededBps: null, netEdgeUsd: null },
        reviewCandidate: true,
        watchCandidate: false,
        routePositive: false,
        blockers: ["Missing RPC for configured chain", "No fork proof or signed-action justification"],
      });
      continue;
    }
    metas.push(await enrichRow(provider, cfg, row, prices, gasByChain[chainId]?.gasUsd).catch((err) => ({ error: err.message || String(err), sourceRow: row, routePositive: false, reviewCandidate: true, watchCandidate: false })));
  }
  const routeDistance = (row) => Number.isFinite(row.economics?.routeFlipBps) ? Number(row.economics.routeFlipBps) : Infinity;
  metas.sort((a, b) => Number(b.routePositive) - Number(a.routePositive) || routeDistance(a) - routeDistance(b) || Number(b.economics?.netEdgeUsd ?? -Infinity) - Number(a.economics?.netEdgeUsd ?? -Infinity) || Number(b.morpho?.routeLiquidityUsd || 0) - Number(a.morpho?.routeLiquidityUsd || 0));
  const routePositive = metas.filter((row) => row.routePositive).length;
  const primaryBlockEntry = blocks.get(1) ? [1, blocks.get(1)] : [...blocks.entries()][0] || [null, null];
  const [primaryBlockChainId, primaryBlock] = primaryBlockEntry;
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-focused-morpho-review-producers.js",
    scope: "Read-only multi-chain producer/oracle/NAV/economics scan for high-LTV Morpho review rows",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    block: { chainId: primaryBlockChainId, chain: CHAIN_CONFIGS[primaryBlockChainId]?.name || null, number: primaryBlock?.number || null, timestamp: primaryBlock?.timestamp || null, iso: primaryBlock?.timestamp ? new Date(Number(primaryBlock.timestamp) * 1000).toISOString() : null },
    blocks: Object.fromEntries([...blocks.entries()].map(([chainId, block]) => [chainId, { chain: CHAIN_CONFIGS[chainId]?.name || String(chainId), number: block?.number || null, timestamp: block?.timestamp || null, iso: block?.timestamp ? new Date(Number(block.timestamp) * 1000).toISOString() : null }])),
    thresholds: { routeLiquidityUsd: ROUTE_LIQUIDITY_USD, maxRows: MAX_ROWS, slippageBps: SLIPPAGE_BPS, gasUnits: GAS_UNITS, targetSymbols: [...TARGET_SYMBOLS], chains: chainIds.map((chainId) => CHAIN_CONFIGS[chainId]?.name || String(chainId)) },
    gas: { gasUnits: GAS_UNITS, gasPriceWei: gasByChain[1]?.gasPriceWei || null, ethPriceUsd: gasAssetPrices.get("coingecko:ethereum") || null, gasUsd: gasByChain[1]?.gasUsd || null, byChain: gasByChain },
    summary: {
      rowsInput: rows.length,
      chainsInput: chainIds.length,
      chainsWithRpc: providers.size,
      byChain: countBy(metas, (row) => row.chain || CHAIN_CONFIGS[row.chainId]?.name),
      reviewCandidates: metas.filter((row) => row.reviewCandidate).length,
      rowsWithReferencePrice: metas.filter((row) => row.economics?.referenceUsdPerCollateral).length,
      rowsWithExactQuoteConfigured: metas.filter((row) => row.routeGate?.exactQuoteConfigured).length,
      rowsWithDirectDexQuote: metas.filter((row) => row.economics?.directUniswapV3ExactOutputQuote).length,
      rowsWithExactAcquisitionRoute: metas.filter((row) => row.routeGate?.exactAcquisitionAvailable).length,
      rowsWithErc4626MintAcquisition: metas.filter((row) => row.routeGate?.erc4626MintAcquisitionAvailable).length,
      rowsWithErc4626LikeProducer: metas.filter((row) => row.producer?.types?.includes("erc4626-like")).length,
      rowsWithPreviewRedeem: metas.filter((row) => row.erc4626?.previewRedeemOneShareRaw).length,
      rowsWithKnownLocalSource: metas.filter((row) => row.producer?.knownLocalToken).length,
      byProducerPrimaryType: countBy(metas, (row) => row.producer?.primaryType),
      byRouteGateStatus: countBy(metas, (row) => row.routeGate?.status),
      bySelectedAcquisitionMode: countBy(metas.filter((row) => row.routeGate?.selectedAcquisitionMode), (row) => row.routeGate?.selectedAcquisitionMode),
      closestReferencePremiumGapBps: minNumber(metas, (row) => row.economics?.premiumGapBps),
      closestExactAcquisitionPremiumGapBps: minNumber(metas, (row) => row.economics?.quotePremiumGapBps),
      closestRouteFlipBps: minNumber(metas, (row) => row.economics?.routeFlipBps),
      watchCandidates: metas.filter((row) => row.watchCandidate).length,
      routePositive,
      signedActionJustified: false,
    },
    rows: metas,
    nextRoutePositiveCriteria: [
      "Morpho accepted value materially exceeds executable acquisition cost after LLTV haircut, gas, and slippage",
      "Direct or routed DEX quote can acquire the exact collateral size needed for available borrow liquidity",
      "Collateral token is transferable/redeemable or has a permissionless exit for the exact size",
      "Fork simulation extracts positive value from the exact market and route",
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  console.log(`Focused Morpho producer scan: rows=${artifact.summary.rowsInput} quotes=${artifact.summary.rowsWithDirectDexQuote} routePositive=${artifact.summary.routePositive}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
