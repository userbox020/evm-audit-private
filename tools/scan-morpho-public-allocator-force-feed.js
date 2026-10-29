#!/usr/bin/env node
// Read-only Morpho public-allocator force-feed scanner.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const FOCUSED_IN = path.join(WORKSPACE, "reports", "raw", "fast", "focused-morpho-review-producers.json");
const STRESS_IN = path.join(WORKSPACE, "reports", "raw", "fast", "morpho-exit-liquidity-stress.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "morpho-public-allocator-force-feed.json");

const CHAIN_ID = 1;
const MORPHO_API = "https://api.morpho.org/graphql";
const MAX_ROWS = Number(process.env.MORPHO_ALLOCATOR_MAX_ROWS || "40");
const MAX_VAULTS_PER_LOAN = Number(process.env.MORPHO_ALLOCATOR_MAX_VAULTS_PER_LOAN || "150");
const MIN_VAULT_TOTAL_ASSETS_USD = Number(process.env.MORPHO_ALLOCATOR_MIN_VAULT_USD || "1000");
const MIN_FORCE_FEED_USD = Number(process.env.MORPHO_ALLOCATOR_MIN_FORCE_FEED_USD || "10000");
const WATCH_GAP_BPS = Number(process.env.MORPHO_ALLOCATOR_WATCH_GAP_BPS || "500");
const RECENT_REALLOCATES = Number(process.env.MORPHO_ALLOCATOR_RECENT_REALLOCATES || "8");

const TARGET_SYMBOLS = new Set(String(process.env.MORPHO_ALLOCATOR_SYMBOLS || "wJAAA,wsrUSD,SolvBTC,EUTBL,PT-USDG-28MAY2026,PWrUSDC-hyper,PRIME")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean));

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function lowerAddress(value) {
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
}

function normalizeMarketId(value) {
  return String(value || "").toLowerCase();
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toBigInt(value, fallback = 0n) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return fallback;
      return BigInt(Math.trunc(value));
    }
    return BigInt(String(value));
  } catch (_) {
    return fallback;
  }
}

function formatUnitsNumber(raw, decimals) {
  try {
    if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
    const n = Number(ethers.formatUnits(toBigInt(raw), Number(decimals)));
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

function rawUsd(raw, decimals, priceUsd) {
  const amount = formatUnitsNumber(raw, decimals);
  const price = asNumber(priceUsd);
  if (amount === null || price === null || price <= 0) return null;
  return amount * price;
}

function finiteMin(values) {
  const nums = values.map(asNumber).filter((n) => n !== null && Number.isFinite(n) && n >= 0);
  if (nums.length === 0) return null;
  return Math.min(...nums);
}

function minimumNumber(values) {
  const nums = values.map(asNumber).filter((n) => n !== null && Number.isFinite(n));
  if (nums.length === 0) return null;
  return Math.min(...nums);
}

function maximumNumber(values) {
  const nums = values.map(asNumber).filter((n) => n !== null && Number.isFinite(n));
  if (nums.length === 0) return null;
  return Math.max(...nums);
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 8000) {
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
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveEthereumRpc() {
  for (const url of loadRpcUrls()) {
    try {
      if (Number(BigInt(await rpcCall(url, "eth_chainId"))) === CHAIN_ID) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30_000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function morphoQuery(query, variables = {}) {
  const json = await fetchJson(MORPHO_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    timeoutMs: 45_000,
  });
  if (json.errors) throw new Error(json.errors[0]?.message || "Morpho GraphQL error");
  return json.data || {};
}

function stressLookup() {
  const stress = readJson(STRESS_IN, {});
  const byMarket = new Map();
  for (const row of stress?.results || []) {
    const key = normalizeMarketId(row.marketId);
    if (!key) continue;
    byMarket.set(key, row);
  }
  return byMarket;
}

function focusedExactAcquisition(row) {
  const econ = row.economics || {};
  const selected = econ.selectedAcquisitionRoute || null;
  const direct = econ.directUniswapV3ExactOutputQuote || null;
  const mint = econ.erc4626MintAcquisition || null;
  const acquisitionMode = row.routeGate?.selectedAcquisitionMode
    || selected?.mode
    || mint?.mode
    || (direct ? "direct-uniswap-v3-exact-output" : null);
  const acceptedVsAcquisitionBps = asNumber(selected?.acceptedVsAcquisitionBps)
    ?? asNumber(econ.acceptedVsAcquisitionBps)
    ?? asNumber(direct?.acceptedVsQuoteBps)
    ?? asNumber(mint?.acceptedVsAcquisitionBps);
  const acquisitionCostUsd = asNumber(selected?.costUsd) ?? asNumber(econ.acquisitionCostUsd) ?? asNumber(mint?.costUsd);
  const acquisitionUsdPerCollateral = asNumber(selected?.acquisitionUsdPerCollateral)
    ?? asNumber(direct?.quoteAcquisitionUsdPerCollateral)
    ?? asNumber(mint?.acquisitionUsdPerCollateral);
  const hasExactAcquisitionSource = Boolean(row.routeGate?.exactAcquisitionAvailable || selected || direct || mint);
  const usableExactAcquisition = Boolean(
    hasExactAcquisitionSource
    && (
      (acquisitionCostUsd !== null && acquisitionCostUsd > 0)
      || (acquisitionUsdPerCollateral !== null && acquisitionUsdPerCollateral > 0)
      || acceptedVsAcquisitionBps !== null
    )
  );
  const requiredPremiumBps = asNumber(econ.requiredPremiumBps);
  const gapToRequiredBps = asNumber(econ.quotePremiumGapBps)
    ?? (acceptedVsAcquisitionBps !== null && requiredPremiumBps !== null ? requiredPremiumBps - acceptedVsAcquisitionBps : null);
  const borrowUsd = asNumber(row.morpho?.routeLiquidityUsd);
  const netEdgeUsd = asNumber(econ.netEdgeUsd);
  return {
    exactAcquisitionAvailable: usableExactAcquisition,
    invalidExactAcquisitionHint: hasExactAcquisitionSource && !usableExactAcquisition ? "exact acquisition hint has zero/unknown cost or no quote premium" : null,
    acquisitionMode,
    acquisitionCostUsd,
    acquisitionUsdPerCollateral,
    borrowUsd,
    netEdgeUsd,
    netEdgeBps: borrowUsd && netEdgeUsd !== null ? netEdgeUsd / borrowUsd * 10_000 : null,
    acceptedVsReferenceBps: asNumber(econ.acceptedVsReferenceBps),
    acceptedVsAcquisitionBps,
    requiredPremiumBps,
    referencePremiumGapBps: asNumber(econ.premiumGapBps),
    gapToRequiredBps,
    routePositive: Boolean(row.routePositive),
    source: "focused-morpho-review-producers",
  };
}

function stressExactAcquisition(stressRow) {
  const stress = stressRow?.acquisitionStress || null;
  const best = stress?.best || null;
  if (!best) return null;
  const borrowUsd = asNumber(best.borrowUsd);
  const netEdgeUsd = asNumber(best.netEdgeUsd);
  return {
    exactAcquisitionAvailable: Boolean(best.quote),
    acquisitionMode: best.quote?.source || best.quote?.pathKind || (best.quote ? "stress-exact-output" : null),
    acquisitionCostUsd: null,
    acquisitionUsdPerCollateral: asNumber(best.quote?.quoteAcquisitionUsdPerCollateral),
    borrowUsd,
    netEdgeUsd,
    netEdgeBps: borrowUsd && netEdgeUsd !== null ? netEdgeUsd / borrowUsd * 10_000 : null,
    acceptedVsReferenceBps: asNumber(stress.acceptedVsReferenceBps),
    acceptedVsAcquisitionBps: asNumber(best.acceptedVsQuoteBps),
    requiredPremiumBps: asNumber(best.requiredPremiumBps),
    referencePremiumGapBps: stress.acceptedVsReferenceBps !== null && best.requiredPremiumBps !== null
      ? asNumber(best.requiredPremiumBps) - asNumber(stress.acceptedVsReferenceBps)
      : null,
    gapToRequiredBps: asNumber(best.gapToRequiredBps),
    routePositive: Boolean(best.routePositive),
    source: "morpho-exit-liquidity-stress",
  };
}

function collectRows() {
  const focused = readJson(FOCUSED_IN, {});
  const stress = readJson(STRESS_IN, {});
  const focusedRows = (focused?.rows || [])
    .filter((row) => Number(row.chainId) === CHAIN_ID && row.protocol === "Morpho Blue" && row.marketId)
    .filter((row) => normalizeAddress(row.loanAsset?.address) && normalizeAddress(row.collateral?.address));
  const stressRows = (stress?.results || [])
    .filter((row) => Number(row.chainId) === CHAIN_ID && row.protocol === "Morpho Blue" && row.marketId)
    .filter((row) => normalizeAddress(row.loanAsset?.address) && normalizeAddress(row.collateral?.address));
  const rows = [...focusedRows, ...stressRows];
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key = normalizeMarketId(row.marketId);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  const priority = deduped.filter((row) => TARGET_SYMBOLS.has(row.collateral?.symbol));
  const exactAcquisition = deduped
    .filter((row) => row.routeGate?.exactAcquisitionAvailable || row.economics?.selectedAcquisitionRoute || row.economics?.directUniswapV3ExactOutputQuote)
    .sort((a, b) => (asNumber(a.economics?.quotePremiumGapBps) ?? Infinity) - (asNumber(b.economics?.quotePremiumGapBps) ?? Infinity));
  const highLiquidity = deduped
    .slice()
    .sort((a, b) => Number(b.morpho?.routeLiquidityUsd || 0) - Number(a.morpho?.routeLiquidityUsd || 0));
  const out = [];
  const used = new Set();
  for (const row of [...priority, ...exactAcquisition, ...highLiquidity]) {
    const key = normalizeMarketId(row.marketId);
    if (used.has(key)) continue;
    used.add(key);
    out.push(row);
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}

async function queryVaultsByLoanAsset(assetAddress) {
  const asset = normalizeAddress(assetAddress);
  if (!asset) return [];
  const query = `query($first:Int!, $skip:Int!, $asset:String!, $minUsd:Float!) {
    vaults(first:$first, skip:$skip, orderBy:TotalAssetsUsd, orderDirection:Desc,
      where:{chainId_in:[1], assetAddress_in:[$asset], totalAssetsUsd_gte:$minUsd}) {
      items {
        address
        name
        symbol
        asset { address symbol decimals }
        liquidity { usd underlying }
        state {
          totalAssetsUsd
          totalAssets
          allocation {
            supplyAssets
            supplyAssetsUsd
            supplyShares
            supplyCap
            supplyCapUsd
            market {
              marketId
              loanAsset { symbol address decimals }
              collateralAsset { symbol address decimals }
              state { liquidityAssetsUsd supplyAssetsUsd borrowAssetsUsd utilization }
            }
          }
        }
        publicAllocatorConfig {
          fee
          accruedFee
          overallFee
          admin
          flowCaps {
            maxIn
            maxOut
            market {
              marketId
              loanAsset { symbol address decimals }
              collateralAsset { symbol address decimals }
              state { liquidityAssetsUsd supplyAssetsUsd borrowAssetsUsd utilization }
            }
          }
        }
        allocators { address }
      }
    }
  }`;
  const out = [];
  for (let skip = 0; skip < MAX_VAULTS_PER_LOAN; skip += 100) {
    const first = Math.min(100, MAX_VAULTS_PER_LOAN - skip);
    const data = await morphoQuery(query, { first, skip, asset, minUsd: MIN_VAULT_TOTAL_ASSETS_USD }).catch(() => ({ vaults: { items: [] } }));
    const items = data?.vaults?.items || [];
    out.push(...items);
    if (items.length < first) break;
  }
  return out;
}

async function queryRecentReallocates(marketId) {
  const market = String(marketId || "");
  if (!market) return { publicAllocator: [], vault: [] };
  const publicQuery = `query($first:Int!, $market:String!) {
    publicAllocatorReallocates(first:$first, orderBy:Timestamp, orderDirection:Desc,
      where:{chainId_in:[1], marketUniqueKey_in:[$market]}) {
      items {
        timestamp
        blockNumber
        hash
        sender
        assets
        type
        vault { address symbol name }
        publicAllocator { address }
        market { marketId loanAsset { symbol address decimals } collateralAsset { symbol address decimals } }
      }
    }
  }`;
  const vaultQuery = `query($first:Int!, $market:String!) {
    vaultReallocates(first:$first, orderBy:Timestamp, orderDirection:Desc,
      where:{chainId_in:[1], marketUniqueKey_in:[$market]}) {
      items {
        timestamp
        blockNumber
        hash
        caller
        assets
        shares
        type
        vault { address symbol name }
        market { marketId loanAsset { symbol address decimals } collateralAsset { symbol address decimals } }
      }
    }
  }`;
  const [publicData, vaultData] = await Promise.all([
    morphoQuery(publicQuery, { first: RECENT_REALLOCATES, market }).catch(() => ({ publicAllocatorReallocates: { items: [] } })),
    morphoQuery(vaultQuery, { first: RECENT_REALLOCATES, market }).catch(() => ({ vaultReallocates: { items: [] } })),
  ]);
  return {
    publicAllocator: publicData?.publicAllocatorReallocates?.items || [],
    vault: vaultData?.vaultReallocates?.items || [],
  };
}

function allocationByMarket(vault) {
  const map = new Map();
  for (const alloc of vault?.state?.allocation || []) {
    const key = normalizeMarketId(alloc?.market?.marketId);
    if (key) map.set(key, alloc);
  }
  return map;
}

function flowCapByMarket(vault) {
  const map = new Map();
  for (const flow of vault?.publicAllocatorConfig?.flowCaps || []) {
    const key = normalizeMarketId(flow?.market?.marketId);
    if (key) map.set(key, flow);
  }
  return map;
}

function sourceCapacityRows(vault, targetMarketId, loanDecimals, loanPriceUsd) {
  const targetKey = normalizeMarketId(targetMarketId);
  const flows = flowCapByMarket(vault);
  const rows = [];
  for (const alloc of vault?.state?.allocation || []) {
    const marketId = normalizeMarketId(alloc?.market?.marketId);
    if (!marketId || marketId === targetKey) continue;
    const flow = flows.get(marketId);
    if (!flow) continue;
    const maxOutUsd = rawUsd(flow.maxOut, loanDecimals, loanPriceUsd);
    const allocatedUsd = asNumber(alloc.supplyAssetsUsd) || 0;
    const marketLiquidityUsd = asNumber(alloc.market?.state?.liquidityAssetsUsd) || 0;
    const withdrawableUsd = finiteMin([maxOutUsd, allocatedUsd, marketLiquidityUsd]) || 0;
    if (maxOutUsd <= 0 && withdrawableUsd <= 0) continue;
    rows.push({
      marketId: alloc.market?.marketId || null,
      collateral: alloc.market?.collateralAsset ? {
        address: normalizeAddress(alloc.market.collateralAsset.address),
        symbol: alloc.market.collateralAsset.symbol || null,
        decimals: alloc.market.collateralAsset.decimals ?? null,
      } : null,
      loanAsset: alloc.market?.loanAsset ? {
        address: normalizeAddress(alloc.market.loanAsset.address),
        symbol: alloc.market.loanAsset.symbol || null,
        decimals: alloc.market.loanAsset.decimals ?? null,
      } : null,
      allocatedUsd,
      marketLiquidityUsd,
      maxOutRaw: flow.maxOut?.toString?.() || String(flow.maxOut ?? ""),
      maxOutUsd,
      withdrawableUsd,
    });
  }
  rows.sort((a, b) => Number(b.withdrawableUsd || 0) - Number(a.withdrawableUsd || 0));
  return rows;
}

function economicsFromRows(row, stressRow) {
  const focused = focusedExactAcquisition(row);
  const stress = stressExactAcquisition(stressRow);
  const candidates = [focused, stress]
    .filter((entry) => entry?.exactAcquisitionAvailable)
    .sort((a, b) => (asNumber(b.netEdgeBps) ?? -Infinity) - (asNumber(a.netEdgeBps) ?? -Infinity)
      || (asNumber(a.gapToRequiredBps) ?? Infinity) - (asNumber(b.gapToRequiredBps) ?? Infinity));
  const best = candidates[0] || focused;
  const bestBorrowUsd = asNumber(best?.borrowUsd) ?? asNumber(row.morpho?.routeLiquidityUsd);
  const bestNetEdgeUsd = asNumber(best?.netEdgeUsd);
  const exactAcquisitionAvailable = Boolean(focused.exactAcquisitionAvailable || stress?.exactAcquisitionAvailable);
  const closestPremiumGapBps = minimumNumber([focused.gapToRequiredBps, stress?.gapToRequiredBps, focused.referencePremiumGapBps, stress?.referencePremiumGapBps]);
  const bestRoutePositive = Boolean(focused.routePositive || stress?.routePositive || row.routePositive);
  return {
    exactQuotePresent: exactAcquisitionAvailable,
    exactAcquisitionAvailable,
    invalidExactAcquisitionHint: focused.invalidExactAcquisitionHint || null,
    acquisitionMode: best?.acquisitionMode || focused.acquisitionMode || null,
    exactAcquisitionSource: best?.source || focused.source,
    bestBorrowUsd,
    bestNetEdgeUsd,
    bestNetEdgeBps: asNumber(best?.netEdgeBps),
    acquisitionCostUsd: asNumber(best?.acquisitionCostUsd),
    acquisitionUsdPerCollateral: asNumber(best?.acquisitionUsdPerCollateral),
    acceptedVsReferenceBps: asNumber(best?.acceptedVsReferenceBps) ?? asNumber(row.economics?.acceptedVsReferenceBps),
    acceptedVsQuoteBps: asNumber(best?.acceptedVsAcquisitionBps),
    acceptedVsAcquisitionBps: asNumber(best?.acceptedVsAcquisitionBps),
    requiredPremiumBps: asNumber(best?.requiredPremiumBps) ?? asNumber(row.economics?.requiredPremiumBps),
    gapToRequiredBps: asNumber(best?.gapToRequiredBps),
    closestPremiumGapBps,
    bestRoutePositive,
    source: best?.source || focused.source,
  };
}

function scoreVaultTarget(row, vault, stressRow) {
  const marketId = normalizeMarketId(row.marketId);
  const loanDecimals = Number(row.loanAsset?.decimals ?? vault.asset?.decimals ?? 18);
  const loanPriceUsd = asNumber(row.loanAsset?.priceUsd) || null;
  const allocations = allocationByMarket(vault);
  const flows = flowCapByMarket(vault);
  const targetAllocation = allocations.get(marketId) || null;
  const targetFlow = flows.get(marketId) || null;
  const targetMaxInUsd = targetFlow ? rawUsd(targetFlow.maxIn, loanDecimals, loanPriceUsd) : null;
  const targetMaxOutUsd = targetFlow ? rawUsd(targetFlow.maxOut, loanDecimals, loanPriceUsd) : null;
  const targetSupplyAssetsUsd = asNumber(targetAllocation?.supplyAssetsUsd) ?? asNumber(targetFlow?.market?.state?.supplyAssetsUsd);
  const targetSupplyCapUsd = asNumber(targetAllocation?.supplyCapUsd);
  const capHeadroomUsd = targetSupplyCapUsd !== null && targetSupplyAssetsUsd !== null
    ? Math.max(0, targetSupplyCapUsd - targetSupplyAssetsUsd)
    : null;
  const sources = sourceCapacityRows(vault, row.marketId, loanDecimals, loanPriceUsd);
  const sourceWithdrawableUsd = sources.reduce((sum, source) => sum + Number(source.withdrawableUsd || 0), 0);
  const forceFeedCapacityUsd = targetFlow && targetMaxInUsd !== null && targetMaxInUsd > 0
    ? finiteMin([targetMaxInUsd, capHeadroomUsd, sourceWithdrawableUsd])
    : 0;
  const targetLiquidityUsd = asNumber(targetFlow?.market?.state?.liquidityAssetsUsd) ?? asNumber(row.morpho?.routeLiquidityUsd) ?? 0;
  const econ = economicsFromRows(row, stressRow);
  const postAllocatorBorrowableLiquidityUsd = targetLiquidityUsd + Number(forceFeedCapacityUsd || 0);
  const postAllocatorNetUsd = econ.exactAcquisitionAvailable && econ.bestNetEdgeBps !== null
    ? postAllocatorBorrowableLiquidityUsd * econ.bestNetEdgeBps / 10_000
    : null;
  const preforkAllocatorPositive = Boolean(
    forceFeedCapacityUsd >= MIN_FORCE_FEED_USD
    && econ.exactAcquisitionAvailable
    && econ.bestRoutePositive
    && postAllocatorNetUsd !== null
    && postAllocatorNetUsd > 0
  );
  const watchCandidate = Boolean(
    !preforkAllocatorPositive
    && forceFeedCapacityUsd >= MIN_FORCE_FEED_USD
    && econ.exactAcquisitionAvailable
    && econ.closestPremiumGapBps !== null
    && econ.closestPremiumGapBps >= 0
    && econ.closestPremiumGapBps <= WATCH_GAP_BPS
  );
  return {
    vault: {
      address: normalizeAddress(vault.address),
      name: vault.name || null,
      symbol: vault.symbol || null,
      asset: vault.asset ? {
        address: normalizeAddress(vault.asset.address),
        symbol: vault.asset.symbol || null,
        decimals: vault.asset.decimals ?? null,
      } : null,
      totalAssetsUsd: asNumber(vault.state?.totalAssetsUsd),
      liquidityUsd: asNumber(vault.liquidity?.usd),
      allocators: (vault.allocators || []).map((a) => normalizeAddress(a.address)).filter(Boolean),
    },
    publicAllocator: vault.publicAllocatorConfig ? {
      admin: normalizeAddress(vault.publicAllocatorConfig.admin),
      feeRaw: vault.publicAllocatorConfig.fee?.toString?.() || String(vault.publicAllocatorConfig.fee ?? ""),
      accruedFeeRaw: vault.publicAllocatorConfig.accruedFee?.toString?.() || String(vault.publicAllocatorConfig.accruedFee ?? ""),
      overallFeeRaw: vault.publicAllocatorConfig.overallFee?.toString?.() || String(vault.publicAllocatorConfig.overallFee ?? ""),
      flowCaps: (vault.publicAllocatorConfig.flowCaps || []).length,
    } : null,
    targetMarket: {
      marketId: row.marketId,
      allocationPresent: Boolean(targetAllocation),
      flowCapPresent: Boolean(targetFlow),
      supplyAssetsUsd: targetSupplyAssetsUsd,
      supplyCapUsd: targetSupplyCapUsd,
      capHeadroomUsd,
      maxInRaw: targetFlow?.maxIn?.toString?.() || (targetFlow ? String(targetFlow.maxIn ?? "") : null),
      maxOutRaw: targetFlow?.maxOut?.toString?.() || (targetFlow ? String(targetFlow.maxOut ?? "") : null),
      maxInUsd: targetMaxInUsd,
      maxOutUsd: targetMaxOutUsd,
      currentLiquidityUsd: targetLiquidityUsd,
      liquidityIfForceFedUsd: postAllocatorBorrowableLiquidityUsd,
      postAllocatorBorrowableLiquidityUsd,
    },
    sources: {
      withdrawableUsd: sourceWithdrawableUsd,
      positiveSourceMarkets: sources.filter((source) => Number(source.withdrawableUsd || 0) > 0).length,
      top: sources.slice(0, 5),
    },
    allocatorEconomics: {
      forceFeedCapacityUsd,
      minForceFeedUsd: MIN_FORCE_FEED_USD,
      preforkAllocatorPositive,
      watchCandidate,
      exactQuotePresent: econ.exactQuotePresent,
      exactAcquisitionAvailable: econ.exactAcquisitionAvailable,
      invalidExactAcquisitionHint: econ.invalidExactAcquisitionHint,
      selectedAcquisitionMode: econ.acquisitionMode,
      exactAcquisitionSource: econ.exactAcquisitionSource,
      economicsSource: econ.source,
      postAllocatorBorrowableLiquidityUsd,
      postAllocatorNetUsd,
      postAllocatorNetGapToPositiveUsd: postAllocatorNetUsd !== null ? Math.max(0, -postAllocatorNetUsd) : null,
      bestBorrowUsd: econ.bestBorrowUsd,
      bestNetEdgeUsd: econ.bestNetEdgeUsd,
      bestNetEdgeBps: econ.bestNetEdgeBps,
      acquisitionCostUsd: econ.acquisitionCostUsd,
      acquisitionUsdPerCollateral: econ.acquisitionUsdPerCollateral,
      acceptedVsReferenceBps: econ.acceptedVsReferenceBps,
      acceptedVsQuoteBps: econ.acceptedVsQuoteBps,
      acceptedVsAcquisitionBps: econ.acceptedVsAcquisitionBps,
      requiredPremiumBps: econ.requiredPremiumBps,
      gapToRequiredBps: econ.gapToRequiredBps,
      closestPremiumGapBps: econ.closestPremiumGapBps,
    },
    routePositive: false,
    blockers: [
      vault.publicAllocatorConfig ? null : "Vault has no public allocator config",
      targetFlow ? null : "Target market has no public allocator flow cap in this vault",
      targetFlow && Number(targetMaxInUsd || 0) > 0 ? null : "Target public allocator maxIn is zero or unavailable",
      sourceWithdrawableUsd > 0 ? null : "No source-market withdrawable liquidity through public allocator maxOut caps",
      forceFeedCapacityUsd >= MIN_FORCE_FEED_USD ? null : `Force-feed capacity below $${MIN_FORCE_FEED_USD}`,
      econ.exactAcquisitionAvailable ? null : "No exact acquisition route from prior focused/stress scans",
      econ.invalidExactAcquisitionHint,
      econ.bestRoutePositive ? null : "Existing LLTV-adjusted acquisition economics are not positive",
      postAllocatorNetUsd !== null && postAllocatorNetUsd <= 0 ? "Post-allocator modeled net remains negative" : null,
      "No fork proof or signed-action authorization",
    ].filter(Boolean),
  };
}

async function enrichMarket(row, vaultsByLoan, stressByMarket) {
  const loanKey = lowerAddress(row.loanAsset?.address);
  const vaults = loanKey ? vaultsByLoan.get(loanKey) || [] : [];
  const stressRow = stressByMarket.get(normalizeMarketId(row.marketId)) || null;
  const scored = vaults
    .map((vault) => scoreVaultTarget(row, vault, stressRow))
    .filter((entry) => entry.publicAllocator || entry.targetMarket.flowCapPresent || entry.targetMarket.allocationPresent)
    .sort((a, b) => Number(b.allocatorEconomics.forceFeedCapacityUsd || 0) - Number(a.allocatorEconomics.forceFeedCapacityUsd || 0)
      || Number(b.targetMarket.maxInUsd || 0) - Number(a.targetMarket.maxInUsd || 0)
      || Number(b.vault.totalAssetsUsd || 0) - Number(a.vault.totalAssetsUsd || 0));
  const recent = await queryRecentReallocates(row.marketId).catch(() => ({ publicAllocator: [], vault: [] }));
  const totalForceFeedCapacityUsd = scored.reduce((sum, entry) => sum + Number(entry.allocatorEconomics.forceFeedCapacityUsd || 0), 0);
  const maxForceFeedCapacityUsd = scored.reduce((best, entry) => Math.max(best, Number(entry.allocatorEconomics.forceFeedCapacityUsd || 0)), 0);
  const targetFlowCaps = scored.filter((entry) => entry.targetMarket.flowCapPresent).length;
  const targetPositiveMaxIn = scored.filter((entry) => Number(entry.targetMarket.maxInUsd || 0) > 0).length;
  const allocatorCapacityRows = scored.filter((entry) => Number(entry.allocatorEconomics.forceFeedCapacityUsd || 0) >= MIN_FORCE_FEED_USD).length;
  const exactAcquisitionRows = scored.filter((entry) => entry.allocatorEconomics.exactAcquisitionAvailable).length;
  const allocatorExactOverlapRows = scored.filter((entry) => Number(entry.allocatorEconomics.forceFeedCapacityUsd || 0) >= MIN_FORCE_FEED_USD && entry.allocatorEconomics.exactAcquisitionAvailable).length;
  const preforkAllocatorPositive = scored.filter((entry) => entry.allocatorEconomics.preforkAllocatorPositive).length;
  const watchCandidates = scored.filter((entry) => entry.allocatorEconomics.watchCandidate).length;
  const bestPostAllocatorNetUsd = maximumNumber(scored.map((entry) => entry.allocatorEconomics.postAllocatorNetUsd));
  const closestAllocatorExactGapBps = minimumNumber(scored
    .filter((entry) => Number(entry.allocatorEconomics.forceFeedCapacityUsd || 0) >= MIN_FORCE_FEED_USD && entry.allocatorEconomics.exactAcquisitionAvailable)
    .map((entry) => entry.allocatorEconomics.closestPremiumGapBps));
  return {
    protocol: row.protocol,
    chain: row.chain,
    chainId: row.chainId,
    marketId: row.marketId,
    oracle: row.oracle,
    collateral: row.collateral,
    loanAsset: row.loanAsset,
    morpho: row.morpho,
    focusedEconomics: row.economics ? {
      referenceUsdPerCollateral: row.economics.referenceUsdPerCollateral,
      acceptedVsReferenceBps: row.economics.acceptedVsReferenceBps,
      directQuote: Boolean(row.economics.directUniswapV3ExactOutputQuote),
      netEdgeUsd: row.economics.netEdgeUsd,
    } : null,
    stressEconomics: stressRow?.acquisitionStress ? {
      exactQuote: Boolean(stressRow.acquisitionStress.best?.quote),
      bestBorrowUsd: stressRow.acquisitionStress.best?.borrowUsd ?? null,
      bestNetEdgeUsd: stressRow.acquisitionStress.best?.netEdgeUsd ?? null,
      bestGapToRequiredBps: stressRow.acquisitionStress.best?.gapToRequiredBps ?? null,
      routePositive: Boolean(stressRow.acquisitionStress.best?.routePositive),
    } : null,
    allocatorSummary: {
      vaultsConsidered: vaults.length,
      vaultsWithPublicAllocator: scored.filter((entry) => entry.publicAllocator).length,
      targetFlowCaps,
      targetPositiveMaxIn,
      allocatorCapacityRows,
      exactAcquisitionRows,
      allocatorExactOverlapRows,
      totalForceFeedCapacityUsd,
      maxForceFeedCapacityUsd,
      bestPostAllocatorNetUsd,
      closestAllocatorExactGapBps,
      recentPublicAllocatorReallocates: recent.publicAllocator.length,
      recentVaultReallocates: recent.vault.length,
      watchCandidates,
      preforkAllocatorPositive,
      routePositive: 0,
    },
    recentReallocates: {
      publicAllocator: recent.publicAllocator.slice(0, RECENT_REALLOCATES),
      vault: recent.vault.slice(0, RECENT_REALLOCATES),
    },
    vaults: scored.slice(0, 12),
    watchCandidate: watchCandidates > 0,
    preforkAllocatorPositive: preforkAllocatorPositive > 0,
    routePositive: false,
    blockers: [
      targetFlowCaps > 0 ? null : "No public allocator target flow caps found for this market",
      targetPositiveMaxIn > 0 ? null : "All target public allocator maxIn caps are zero or unavailable",
      allocatorCapacityRows > 0 ? null : `No vault can force-feed at least $${MIN_FORCE_FEED_USD} into this market right now`,
      allocatorExactOverlapRows > 0 ? null : "Allocator capacity does not overlap an exact acquisition route for this market",
      preforkAllocatorPositive > 0 ? null : "Allocator capacity does not coincide with positive exact LLTV-adjusted acquisition economics",
      "No fork proof or signed-action authorization",
    ].filter(Boolean),
  };
}

async function readBlockInfo() {
  const rpc = await resolveEthereumRpc();
  if (!rpc) return { block: null, gas: null };
  const provider = new ethers.JsonRpcProvider(rpc);
  const [block, gasPriceWei] = await Promise.all([
    provider.getBlock("latest").catch(() => null),
    provider.send("eth_gasPrice", []).then(BigInt).catch(() => null),
  ]);
  return {
    block: block ? { number: block.number, timestamp: block.timestamp, iso: block.timestamp ? new Date(Number(block.timestamp) * 1000).toISOString() : null } : null,
    gas: { gasPriceWei: gasPriceWei?.toString() || null },
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rows = collectRows();
  const stressByMarket = stressLookup();
  const loanAssets = [...new Set(rows.map((row) => lowerAddress(row.loanAsset?.address)).filter(Boolean))];
  const vaultsByLoan = new Map();
  for (const loan of loanAssets) {
    const vaults = await queryVaultsByLoanAsset(loan);
    vaultsByLoan.set(loan, vaults);
  }
  const results = [];
  for (const row of rows) results.push(await enrichMarket(row, vaultsByLoan, stressByMarket));
  results.sort((a, b) => Number(b.preforkAllocatorPositive) - Number(a.preforkAllocatorPositive)
    || Number(b.watchCandidate) - Number(a.watchCandidate)
    || Number(b.allocatorSummary.maxForceFeedCapacityUsd || 0) - Number(a.allocatorSummary.maxForceFeedCapacityUsd || 0)
    || Number(b.morpho?.routeLiquidityUsd || 0) - Number(a.morpho?.routeLiquidityUsd || 0));
  const { block, gas } = await readBlockInfo();
  const allVaults = [...vaultsByLoan.values()].flat();
  const summary = {
    marketsInput: rows.length,
    loanAssetsQueried: loanAssets.length,
    vaultsScanned: allVaults.length,
    vaultsWithPublicAllocator: allVaults.filter((vault) => vault.publicAllocatorConfig).length,
    marketsWithTargetFlowCaps: results.filter((row) => row.allocatorSummary.targetFlowCaps > 0).length,
    marketsWithPositiveMaxIn: results.filter((row) => row.allocatorSummary.targetPositiveMaxIn > 0).length,
    marketsWithAllocatorCapacity: results.filter((row) => row.allocatorSummary.allocatorCapacityRows > 0).length,
    marketsWithExactAcquisition: results.filter((row) => row.allocatorSummary.exactAcquisitionRows > 0).length,
    marketsWithAllocatorExactOverlap: results.filter((row) => row.allocatorSummary.allocatorExactOverlapRows > 0).length,
    allocatorCapacityRows: results.reduce((sum, row) => sum + Number(row.allocatorSummary.allocatorCapacityRows || 0), 0),
    allocatorExactOverlapRows: results.reduce((sum, row) => sum + Number(row.allocatorSummary.allocatorExactOverlapRows || 0), 0),
    maxForceFeedCapacityUsd: results.reduce((best, row) => Math.max(best, Number(row.allocatorSummary.maxForceFeedCapacityUsd || 0)), 0),
    totalForceFeedCapacityUsd: results.reduce((sum, row) => sum + Number(row.allocatorSummary.totalForceFeedCapacityUsd || 0), 0),
    bestPostAllocatorNetUsd: maximumNumber(results.map((row) => row.allocatorSummary.bestPostAllocatorNetUsd)),
    closestAllocatorExactGapBps: minimumNumber(results.map((row) => row.allocatorSummary.closestAllocatorExactGapBps)),
    watchCandidates: results.filter((row) => row.watchCandidate).length,
    preforkAllocatorPositive: results.filter((row) => row.preforkAllocatorPositive).length,
    routePositive: 0,
    signedActionJustified: false,
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-morpho-public-allocator-force-feed.js",
    scope: "Read-only Morpho public allocator force-feed capacity join for high-LLTV review rows",
    safety: {
      rpcInventoryRead: Boolean(block || gas),
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    block,
    gas,
    thresholds: {
      maxRows: MAX_ROWS,
      maxVaultsPerLoan: MAX_VAULTS_PER_LOAN,
      minVaultTotalAssetsUsd: MIN_VAULT_TOTAL_ASSETS_USD,
      minForceFeedUsd: MIN_FORCE_FEED_USD,
      watchGapBps: WATCH_GAP_BPS,
      recentReallocates: RECENT_REALLOCATES,
      targetSymbols: [...TARGET_SYMBOLS],
    },
    summary,
    results,
    nextRoutePositiveCriteria: [
      "Target market has nonzero public allocator maxIn and reachable source maxOut liquidity",
      "Force-feed amount plus current borrow liquidity is material at exact route size",
      "Existing or refreshed acquisition quote is positive after LLTV haircut, gas, fees, and slippage",
      "Fork simulation proves positive extraction after the public allocator reallocation step",
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  console.log(`Morpho allocator force-feed scan: markets=${summary.marketsInput} vaults=${summary.vaultsScanned} capacityRows=${summary.allocatorCapacityRows} routePositive=${summary.routePositive}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
