#!/usr/bin/env node
// Read-only stablecoin depeg -> lending collateral route scanner.
// Checks whether depegged stablecoins are listed as high-LTV collateral in any lending protocol.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "stablecoin-depeg-lending-routes.json");
const QUIET = process.argv.includes("--quiet");

const CHAIN_ID = 1;
const CHAIN_NAME = "Ethereum";
const TIMEOUT_MS = Number(process.env.DEPEG_LENDING_TIMEOUT_MS || "15000");
const MIN_LTV = Number(process.env.DEPEG_LENDING_MIN_LTV || "0.60");
const MIN_LIQUIDITY_USD = Number(process.env.DEPEG_LENDING_MIN_LIQUIDITY_USD || "5000");
const MIN_DEPEG_BPS = Number(process.env.DEPEG_LENDING_MIN_DEPEG_BPS || "5");

const STABLECOINS = {
  FRAX:   { address: "0x853d955aCEf822Db058eb8505911ED77F175b99e", targetPrice: 1.00 },
  crvUSD: { address: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E", targetPrice: 1.00 },
  GHO:    { address: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f", targetPrice: 1.00 },
  USDe:   { address: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3", targetPrice: 1.00 },
  DAI:    { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", targetPrice: 1.00 },
  USDT:   { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", targetPrice: 1.00 },
  USDC:   { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", targetPrice: 1.00 },
};

const CHAIN_SLUG = "ethereum";

const AAVE_V3_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);

const AAVE_POOL = new ethers.Interface([
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns (tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
]);

const COMPTROLLER = new ethers.Interface([
  "function getAllMarkets() view returns (address[])",
  "function oracle() view returns (address)",
]);

const CTOKEN = new ethers.Interface([
  "function underlying() view returns (address)",
  "function getCash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
]);

const EVAULT = new ethers.Interface([
  "function asset() view returns (address)",
  "function cash() view returns (uint256)",
  "function LTVBorrow(address collateral) view returns (uint16)",
  "function LTVList() view returns (address[])",
]);

const GENERIC_FACTORY = new ethers.Interface([
  "function getProxyListLength() view returns (uint256)",
  "function getProxyListSlice(uint256 start,uint256 end) view returns (address[])",
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

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[$,%\s,_]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 6) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function wordAt(raw, index) {
  const hex = strip0x(raw);
  const start = index * 64;
  if (!hex || hex.length < start + 64) return null;
  return `0x${hex.slice(start, start + 64)}`;
}

function addressWordAt(raw, index) {
  const word = wordAt(raw, index);
  if (!word) return null;
  const hex = strip0x(word).padStart(64, "0");
  if (/^0+$/.test(hex)) return null;
  return normalizeAddress(`0x${hex.slice(-40)}`);
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) {
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

async function resolveRpcUrl(chainId) {
  for (const url of loadRpcUrls()) {
    try {
      const id = Number(BigInt(await rpcCall(url, "eth_chainId", [], 6000)));
      if (id === chainId) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function safeProviderCall(provider, to, data) {
  try { return await provider.call({ to, data }); } catch (_) { return null; }
}

function decodeResult(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}

function decodeUintResult(raw, fn) {
  if (!raw || raw === "0x") return null;
  try { return BigInt(ERC20.decodeFunctionResult(fn, raw)[0]); } catch (_) {
    try { return BigInt(raw); } catch (_) { return null; }
  }
}

function decodeStringResult(raw, fn) {
  if (!raw || raw === "0x") return null;
  try { return String(ERC20.decodeFunctionResult(fn, raw)[0]); } catch (_) { return null; }
}

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try { return Number(ethers.formatUnits(raw, Number(decimals))); } catch (_) { return null; }
}

function decodeAaveConfig(data) {
  const raw = BigInt(data || 0n);
  const mask16 = 0xffffn;
  const mask36 = (1n << 36n) - 1n;
  return {
    ltv: Number(raw & mask16) / 10_000,
    liquidationThreshold: Number((raw >> 16n) & mask16) / 10_000,
    active: Boolean((raw >> 56n) & 1n),
    frozen: Boolean((raw >> 57n) & 1n),
    borrowingEnabled: Boolean((raw >> 58n) & 1n),
    paused: Boolean((raw >> 60n) & 1n),
    borrowCapWholeTokens: ((raw >> 80n) & mask36).toString(),
    supplyCapWholeTokens: ((raw >> 116n) & mask36).toString(),
  };
}

async function fetchStablecoinPrices() {
  const keys = Object.values(STABLECOINS).map((sc) => `${CHAIN_SLUG}:${sc.address.toLowerCase()}`);
  const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.join(",")}?searchWidth=6h`, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
  const prices = {};
  for (const [symbol, sc] of Object.entries(STABLECOINS)) {
    const key = `${CHAIN_SLUG}:${sc.address.toLowerCase()}`;
    const price = Number((json.coins || {})[key]?.price || 0);
    if (Number.isFinite(price) && price > 0) {
      prices[symbol] = { current: price, target: sc.targetPrice, depegBps: round((1 - price / sc.targetPrice) * 10_000, 2), address: sc.address };
    }
  }
  return prices;
}

async function scanAave(provider, prices, stableMap) {
  const pool = normalizeAddress(AAVE_V3_POOL);
  if (!pool) return [];
  const matchedAddrs = new Set(Object.values(STABLECOINS).map((sc) => sc.address.toLowerCase()));
  const reservesRaw = await safeProviderCall(provider, pool, AAVE_POOL.encodeFunctionData("getReservesList", []));
  const reserves = (decodeResult(reservesRaw, AAVE_POOL, "getReservesList")?.[0] || []).map(normalizeAddress).filter(Boolean);
  const rows = [];
  for (const reserve of reserves) {
    const lower = lowerAddress(reserve);
    if (!lower || !matchedAddrs.has(lower)) continue;
    const dataRaw = await safeProviderCall(provider, pool, AAVE_POOL.encodeFunctionData("getReserveData", [reserve]));
    if (!dataRaw || dataRaw === "0x") continue;
    const cfg = decodeAaveConfig(BigInt(wordAt(dataRaw, 0) || 0n));
    const aToken = normalizeAddress(addressWordAt(dataRaw, 8));
    const decimals = 18;
    const cashRaw = aToken ? await safeProviderCall(provider, reserve, ERC20.encodeFunctionData("balanceOf", [aToken])).catch(() => "0x0") : "0x0";
    const cash = formatUnitsNumber(decodeUintResult(cashRaw, "balanceOf") || 0n, decimals) || 0;
    const matchedSym = [...Object.entries(STABLECOINS)].find(([, sc]) => sc.address.toLowerCase() === lower)?.[0];
    const price = prices[matchedSym] || null;
    const cashUsd = cash * (price?.current || 0);
    const routeLiquidityUsd = cfg.active && !cfg.paused && cfg.borrowingEnabled ? cashUsd * 0.85 : 0;
    rows.push({
      protocol: "Aave V3",
      collateral: { symbol: matchedSym, address: reserve },
      ltv: cfg.ltv,
      lt: cfg.liquidationThreshold,
      active: cfg.active,
      borrowingEnabled: cfg.borrowingEnabled,
      paused: cfg.paused,
      borrowCapWholeTokens: cfg.borrowCapWholeTokens,
      supplyCapWholeTokens: cfg.supplyCapWholeTokens,
      cash, cashUsd: round(cashUsd, 2),
      routeLiquidityUsd: round(routeLiquidityUsd, 2),
      depegBps: price?.depegBps || 0,
      depegName: matchedSym,
    });
  }
  return rows;
}

async function scanMorpho() {
  const matchedAddrs = Object.values(STABLECOINS).map((sc) => sc.address.toLowerCase());
  const query = `query($chainIds:[Int!]!, $minSupply:Float!) {
    markets(first:500, orderBy:SupplyAssetsUsd, orderDirection:Desc,
      where:{chainId_in:$chainIds, supplyAssetsUsd_gte:$minSupply}) { items {
        marketId
        loanAsset { symbol address decimals }
        collateralAsset { symbol address decimals }
        oracle { address }
        lltv
        state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization }
      } }
  }`;
  const json = await fetchJson("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { chainIds: [CHAIN_ID], minSupply: 1 } }),
    timeoutMs: 30_000,
  }).catch(() => null);
  const markets = json?.data?.markets?.items || [];
  const rows = [];
  for (const market of markets) {
    const collLower = lowerAddress(market.collateralAsset?.address);
    if (!collLower || !matchedAddrs.includes(collLower)) continue;
    const matchedSym = [...Object.entries(STABLECOINS)].find(([, sc]) => sc.address.toLowerCase() === collLower)?.[0];
    const lltv = (() => { try { return Number(BigInt(String(market.lltv || 0))) / 1e18; } catch (_) { return Number(market.lltv || 0); } })();
    rows.push({
      protocol: "Morpho Blue",
      marketId: market.marketId,
      oracle: normalizeAddress(market.oracle?.address),
      collateral: { symbol: matchedSym, address: normalizeAddress(market.collateralAsset?.address) },
      borrowAsset: market.loanAsset || null,
      ltv: lltv,
      supplyAssetsUsd: Number(market.state?.supplyAssetsUsd || 0),
      borrowAssetsUsd: Number(market.state?.borrowAssetsUsd || 0),
      routeLiquidityUsd: round(Number(market.state?.liquidityAssetsUsd || 0), 2),
      utilization: market.state?.utilization ?? null,
    });
  }
  return rows;
}

async function scanEulerEvk(provider, prices) {
  const factory = normalizeAddress("0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e");
  if (!factory) return [];
  const matchedAddrs = new Set(Object.values(STABLECOINS).map((sc) => sc.address.toLowerCase()));
  const lengthRaw = await safeProviderCall(provider, factory, GENERIC_FACTORY.encodeFunctionData("getProxyListLength", []));
  const length = Number(decodeResult(lengthRaw, GENERIC_FACTORY, "getProxyListLength")?.[0] || 0n);
  const rows = [];
  const start = Math.max(0, length - 800);
  for (let cursor = start; cursor < length; cursor += 100) {
    const end = Math.min(length, cursor + 100);
    const raw = await safeProviderCall(provider, factory, GENERIC_FACTORY.encodeFunctionData("getProxyListSlice", [cursor, end]));
    const evaults = (decodeResult(raw, GENERIC_FACTORY, "getProxyListSlice")?.[0] || []).map(normalizeAddress).filter(Boolean);
    for (const evault of evaults) {
      const [assetRaw, cashRaw, ltvListRaw] = await Promise.all([
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("asset", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("cash", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("LTVList", [])),
      ]);
      const asset = normalizeAddress(decodeResult(assetRaw, EVAULT, "asset")?.[0]);
      if (!asset) continue;
      const assetLower = lowerAddress(asset);
      const cash = decodeResult(cashRaw, EVAULT, "cash")?.[0] || 0n;
      const ltvList = (decodeResult(ltvListRaw, EVAULT, "LTVList")?.[0] || []).map(normalizeAddress).filter(Boolean);
      for (const collateral of ltvList) {
        const collLower = lowerAddress(collateral);
        if (!collLower || !matchedAddrs.has(collLower)) continue;
        const ltvRaw = await safeProviderCall(provider, evault, EVAULT.encodeFunctionData("LTVBorrow", [collateral]));
        const ltv = Number(decodeResult(ltvRaw, EVAULT, "LTVBorrow")?.[0] || 0) / 10_000;
        const matchedSym = [...Object.entries(STABLECOINS)].find(([, sc]) => sc.address.toLowerCase() === collLower)?.[0];
        rows.push({
          protocol: "Euler EVK",
          evault,
          borrowAsset: normalizeAddress(asset),
          collateral: { symbol: matchedSym, address: collateral },
          ltv,
          cashRaw: cash.toString(),
        });
      }
    }
  }
  return rows;
}

async function erc20Meta(provider, address) {
  const [symRaw, decRaw] = await Promise.all([
    safeProviderCall(provider, address, ERC20.encodeFunctionData("symbol", [])),
    safeProviderCall(provider, address, ERC20.encodeFunctionData("decimals", [])),
  ]);
  return {
    symbol: decodeStringResult(symRaw, "symbol"),
    decimals: decodeUintResult(decRaw, "decimals"),
  };
}

function scoreAndClassify(row, prices) {
  const sym = row.collateral?.symbol;
  const price = prices[sym];
  const depegBps = price?.depegBps || 0;
  const belowPeg = depegBps > 0;
  const effectiveLtv = row.ltv || 0;
  const gasUsd = 15;
  const flashFeeRate = 0.0009; // Aave V3 flash fee baseline.
  const borrowSideModeled = Boolean(row.borrowAsset);
  const modelable = borrowSideModeled && effectiveLtv > 0 && (price?.current || 0) > 0 && (price?.target || 0) > 0;
  const routeLiquidityUsd = row.routeLiquidityUsd || 0;
  const maxBorrowUsd = modelable ? routeLiquidityUsd : 0;
  const requiredCollateralUsd = modelable ? maxBorrowUsd / effectiveLtv : 0;
  const collateralAcquisitionUsd = modelable ? requiredCollateralUsd * (price.current / price.target) : 0;
  const ltvHaircutUsd = Math.max(0, requiredCollateralUsd - maxBorrowUsd);
  const depegUsd = Math.max(0, requiredCollateralUsd - collateralAcquisitionUsd);
  const flashFeeUsd = collateralAcquisitionUsd * flashFeeRate;
  const netUsd = modelable ? maxBorrowUsd - collateralAcquisitionUsd - flashFeeUsd - gasUsd : -gasUsd;
  const breakevenDepegBps = modelable ? round((1 - effectiveLtv / (1 + flashFeeRate + (requiredCollateralUsd > 0 ? gasUsd / requiredCollateralUsd : 0))) * 10_000, 2) : null;
  const materialDepeg = belowPeg && depegBps >= MIN_DEPEG_BPS;
  const materialLiquidity = maxBorrowUsd >= MIN_LIQUIDITY_USD;
  const highLtv = effectiveLtv >= MIN_LTV;
  const routePositive = highLtv && materialDepeg && materialLiquidity && netUsd > 0;
  return {
    ...row,
    effectiveLtv,
    depegBps,
    maxBorrowUsd: round(maxBorrowUsd, 2),
    requiredCollateralUsd: round(requiredCollateralUsd, 2),
    collateralAcquisitionUsd: round(collateralAcquisitionUsd, 2),
    ltvHaircutUsd: round(ltvHaircutUsd, 2),
    breakevenDepegBps,
    grossBorrowableUsd: round(maxBorrowUsd, 2),
    depegUsd: round(depegUsd, 2),
    flashFeeUsd: round(flashFeeUsd, 2),
    netDepegUsd: round(netUsd, 2),
    highLtv,
    materialDepeg,
    materialLiquidity,
    watchCandidate: highLtv && materialDepeg && materialLiquidity,
    routePositive,
    blockers: [
      (highLtv && materialDepeg && materialLiquidity) ? "Watch-only: needs exact borrow-side asset, exit route, and fork proof" : null,
      !highLtv ? `LTV below ${MIN_LTV}` : null,
      !materialDepeg ? `Depeg below ${MIN_DEPEG_BPS}bps` : null,
      !materialLiquidity ? `Borrow liquidity below $${MIN_LIQUIDITY_USD}` : null,
      !borrowSideModeled ? "Borrow-side asset/liquidity is not modeled for this row" : null,
      belowPeg && breakevenDepegBps !== null && depegBps < breakevenDepegBps ? `Depeg ${round(depegBps, 2)}bps below breakeven ${breakevenDepegBps}bps after LTV haircut` : null,
      !belowPeg ? "Collateral token is not below peg" : null,
      netUsd <= 0 ? "Net depeg-adjusted profit is not positive after gas and flash fee" : null,
      "No exact borrow/exit route or fork proof",
    ].filter(Boolean),
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const prices = await fetchStablecoinPrices();
  if (!QUIET) {
    for (const [sym, data] of Object.entries(prices)) {
      console.log(`${sym}=$${round(data.current,4)} target=$${data.target} depeg=${data.depegBps}bps`);
    }
  }
  const rpc = await resolveRpcUrl(CHAIN_ID);
  if (!rpc) throw new Error("No Ethereum RPC endpoint resolved from local inventory");
  const provider = new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
  const blockNumber = await provider.getBlockNumber().catch(() => null);
  const [aaveRows, morphoRows, eulerRows] = await Promise.all([
    scanAave(provider, prices),
    scanMorpho(),
    scanEulerEvk(provider, prices),
  ]);
  const allRows = [...aaveRows, ...morphoRows, ...eulerRows].map((row) => scoreAndClassify(row, prices));
  const watchRows = allRows.filter((row) => row.watchCandidate);
  const routeRows = allRows.filter((row) => row.routePositive);
  allRows.sort((a, b) => Number(b.watchCandidate) - Number(a.watchCandidate) || (b.netDepegUsd || 0) - (a.netDepegUsd || 0) || (b.routeLiquidityUsd || 0) - (a.routeLiquidityUsd || 0));
  const byProtocol = {};
  for (const row of allRows) byProtocol[row.protocol] = (byProtocol[row.protocol] || 0) + 1;
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-stablecoin-depeg-lending-routes.js",
    scope: "Read-only stablecoin depeg -> lending collateral route scan over Aave V3, Morpho Blue, and Euler EVK",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: routeRows.length > 0,
      signedActionJustified: false,
    },
    chain: { chainId: CHAIN_ID, name: CHAIN_NAME, blockNumber },
    thresholds: { minLtv: MIN_LTV, minLiquidityUsd: MIN_LIQUIDITY_USD, minDepegBps: MIN_DEPEG_BPS },
    prices: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, { current: round(v.current, 6), target: v.target, depegBps: v.depegBps }])),
    summary: {
      aaveRows: aaveRows.length,
      morphoRows: morphoRows.length,
      eulerRows: eulerRows.length,
      rowsScanned: allRows.length,
      highLtvRows: allRows.filter((row) => row.highLtv).length,
      materialDepegRows: allRows.filter((row) => row.materialDepeg).length,
      watchCandidates: watchRows.length,
      routePositive: routeRows.length,
      signedActionJustified: false,
      bestDepegBps: allRows.length ? Math.max(...allRows.map((row) => row.depegBps || 0)) : 0,
      bestNetUsd: allRows.length ? Math.max(...allRows.map((row) => row.netDepegUsd || -Infinity)) : null,
      breakdown: { byProtocol },
    },
    topRows: allRows.slice(0, 60),
    rows: allRows,
    nextRoutePositiveCriteria: [
      "depegged stablecoin is collateral at high LTV in a liquid lending market",
      "borrow-side liquidity and exit route are material and unpaused",
      "conservative net after depeg, gas, flash fee, and slippage is positive",
      "fork extraction proof demonstrates positive net value",
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  console.log(`Stablecoin depeg lending: rows=${artifact.summary.rowsScanned} highLtv=${artifact.summary.highLtvRows} watch=${artifact.summary.watchCandidates} routePositive=${artifact.summary.routePositive}`);
  if (!QUIET) console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
