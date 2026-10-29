#!/usr/bin/env node
// Read-only E9 Morpho liquidation route salvage scanner.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("./node_modules/ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "e9-liquidation-salvage-routes.json");

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNISWAP_V3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const ZERO = ethers.ZeroAddress;

const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const VIRTUAL_SHARES = 1_000_000n;
const VIRTUAL_ASSETS = 1n;
const LIQUIDATION_CURSOR = 300_000_000_000_000_000n;
const MAX_LIQUIDATION_INCENTIVE_FACTOR = 1_150_000_000_000_000_000n;

const FEES = [100, 500, 3000, 10000];
const SIZE_FRACTIONS = String(process.env.E9_SALVAGE_SIZE_FRACTIONS || "0.01,0.05,0.1,0.25,0.5,0.75,1")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0 && x <= 1);
const MAX_POSITIONS = Number(process.env.E9_SALVAGE_MAX_POSITIONS || "24");
const GRAPHQL_FIRST = Number(process.env.E9_SALVAGE_GRAPHQL_FIRST || "500");
const RESEARCH_MAX_ROWS = Number(process.env.E9_SALVAGE_RESEARCH_MAX_ROWS || "5");
const MIN_DEBT_USD = Number(process.env.E9_SALVAGE_MIN_DEBT_USD || "100");
const MIN_COLLATERAL_USD = Number(process.env.E9_SALVAGE_MIN_COLLATERAL_USD || "1");
const SLIPPAGE_BPS = Number(process.env.E9_SALVAGE_SLIPPAGE_BPS || "100");
const LIQUIDATION_GAS_UNITS = Number(process.env.E9_SALVAGE_GAS_UNITS || "1800000");
const FLASH_FEE_BPS = BigInt(process.env.E9_SALVAGE_FLASH_FEE_BPS || "0");
const EXECUTOR_REPAY_BUFFER_BPS = BigInt(process.env.E9_SALVAGE_EXECUTOR_REPAY_BUFFER_BPS || "50");
const CURVE_MAX_POOLS_PER_PAIR = Number(process.env.E9_SALVAGE_CURVE_MAX_POOLS_PER_PAIR || "1");
const BALANCER_MAX_POOLS_PER_PAIR = Number(process.env.E9_SALVAGE_BALANCER_MAX_POOLS_PER_PAIR || "3");
const MAX_UNISWAP_PATHS = Number(process.env.E9_SALVAGE_MAX_UNISWAP_PATHS || "80");
const ENABLE_REFERENCE_QUOTES = process.env.E9_SALVAGE_REFERENCE_QUOTES === "1";
const ALLOW_UNPROVEN_WRAPPER_REDEEM = process.env.E9_SALVAGE_ALLOW_UNPROVEN_WRAPPER_REDEEM === "1";

const TOKENS = {
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  WSTETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
  WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  USDE: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
  USDS: "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
  GHO: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f",
  FRAX: "0x853d955aCEf822Db058eb8505911ED77F175b99e",
  crvUSD: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
  PYUSD: "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8",
  USD0: "0x73A15FeD60Bf67631dC6cd7Bc5B6e8da8190aCF5",
};

const CHAINLINK_FEEDS = new Map([
  [TOKENS.WETH.toLowerCase(), { feed: "0x5f4eC3Df9cbd43714FE2740f5e3616155c5b8419", maxAgeSeconds: 3 * 3600, label: "WETH" }],
  [TOKENS.USDC.toLowerCase(), { feed: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6", maxAgeSeconds: 30 * 3600, label: "USDC" }],
  [TOKENS.USDT.toLowerCase(), { feed: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D", maxAgeSeconds: 30 * 3600, label: "USDT" }],
  [TOKENS.DAI.toLowerCase(), { feed: "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9", maxAgeSeconds: 3 * 3600, label: "DAI" }],
  [TOKENS.WBTC.toLowerCase(), { feed: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c", maxAgeSeconds: 3 * 3600, label: "WBTC" }],
  [TOKENS.USDE.toLowerCase(), { feed: "0xa569d910839Ae8865Da8F8e70FfFb0cBA869F961", maxAgeSeconds: 30 * 3600, label: "USDe" }],
  [TOKENS.GHO.toLowerCase(), { feed: "0x3f12643D3f6f874d39c2A4c9f2cd6f2DbAC877fc", maxAgeSeconds: 30 * 3600, label: "GHO" }],
  [TOKENS.FRAX.toLowerCase(), { feed: "0xB9E1E3A9feFf48998E45Fa90847ed4D467E8BcfD", maxAgeSeconds: 30 * 3600, label: "FRAX" }],
  [TOKENS.crvUSD.toLowerCase(), { feed: "0xeef0C605546958c1f899b6fb336c20671f9cd49f", maxAgeSeconds: 30 * 3600, label: "crvUSD" }],
]);

const ERC20 = new ethers.Interface([
  "function asset() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function symbol() view returns (string)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const WRAPPER_MANAGER = new ethers.Interface([
  "function manager() view returns (address)",
  "function maxRedeemCap(address yToken) view returns (uint256)",
  "function withdrawAssets(address yToken,address asset) view returns (bool)",
]);
const FACTORY = new ethers.Interface(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)"]);
const QUOTER = new ethers.Interface([
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
const MORPHO_IFACE = new ethers.Interface([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function position(bytes32 id,address user) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)",
]);
const ORACLE = new ethers.Interface(["function price() view returns (uint256)"]);
const CHAINLINK = new ethers.Interface([
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);
const CURVE_INT128 = new ethers.Interface(["function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)"]);
const CURVE_UINT256 = new ethers.Interface(["function get_dy(uint256 i,uint256 j,uint256 dx) view returns (uint256)"]);
const BALANCER = new ethers.Interface([
  "function queryBatchSwap(uint8 kind,(bytes32 poolId,uint256 assetInIndex,uint256 assetOutIndex,uint256 amount,bytes userData)[] swaps,address[] assets,(address sender,bool fromInternalBalance,address recipient,bool toInternalBalance) funds) returns (int256[] assetDeltas)",
]);

const poolCache = new Map();
const curveDyCache = new Map();
const balancerPairCache = new Map();

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function lowerAddress(value) {
  const addr = normalizeAddress(value);
  return addr ? addr.toLowerCase() : null;
}

function sameAddress(a, b) {
  const aa = lowerAddress(a);
  const bb = lowerAddress(b);
  return Boolean(aa && bb && aa === bb);
}

function toBigInt(value, fallback = 0n) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    return BigInt(value);
  } catch (_) {
    return fallback;
  }
}

function mulDivDown(x, y, d) {
  if (d === 0n) return 0n;
  return x * y / d;
}

function mulDivUp(x, y, d) {
  if (d === 0n) return 0n;
  return (x * y + d - 1n) / d;
}

function toAssetsUp(shares, totalAssets, totalShares) {
  return mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
}

function liquidationIncentiveFactorRaw(lltvRaw) {
  const lltv = toBigInt(lltvRaw);
  if (lltv <= 0n || lltv >= WAD) return 1_050_000_000_000_000_000n;
  const cursorTerm = mulDivDown(LIQUIDATION_CURSOR, WAD - lltv, WAD);
  const factor = mulDivDown(WAD, WAD, WAD - cursorTerm);
  return factor > MAX_LIQUIDATION_INCENTIVE_FACTOR ? MAX_LIQUIDATION_INCENTIVE_FACTOR : factor;
}

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined) return null;
  try { return Number(ethers.formatUnits(toBigInt(raw), Number(decimals))); } catch (_) { return null; }
}

function parseFractionShares(borrowShares, fraction) {
  const shares = toBigInt(borrowShares, 0n);
  if (shares <= 0n) return 0n;
  if (fraction >= 1) return shares;
  const bps = BigInt(Math.max(1, Math.floor(Number(fraction) * 10_000)));
  const partial = shares * bps / 10_000n;
  return partial > 0n ? partial : 1n;
}

function percentDiff(a, b) {
  const x = Number(a || 0);
  const y = Number(b || 0);
  if (!(x > 0) || !(y > 0)) return null;
  return Math.abs(x - y) / ((x + y) / 2) * 100;
}

function routeLabel(tokens, fees) {
  const parts = [];
  for (let i = 0; i < tokens.length; i++) {
    parts.push(tokens[i].slice(0, 8));
    if (i < fees.length) parts.push(String(fees[i]));
  }
  return parts.join("-");
}

function encodePath(tokens, fees) {
  const types = [];
  const values = [];
  for (let i = 0; i < tokens.length; i++) {
    types.push("address");
    values.push(tokens[i]);
    if (i < fees.length) {
      types.push("uint24");
      values.push(fees[i]);
    }
  }
  return ethers.solidityPacked(types, values);
}

function marketId(marketParams) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address", "uint256"],
    [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, toBigInt(marketParams.lltv)]
  ));
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 12_000) {
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
      if (Number(BigInt(await rpcCall(url, "eth_chainId", [], 6000))) === 1) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
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

async function fetchUsd(url, pathFn, timeoutMs = 8000) {
  try {
    const json = await fetchJson(url, { timeoutMs });
    const price = Number(pathFn(json));
    return price > 0 ? price : null;
  } catch (_) {
    return null;
  }
}

async function getValidatedEthUsdPrice(provider, blockTimestamp) {
  const sources = [];
  const coingecko = await fetchUsd(
    "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    (j) => j?.ethereum?.usd
  );
  if (coingecko) sources.push({ source: "coingecko", price: coingecko });

  const binance = await fetchUsd("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT", (j) => j?.price);
  if (binance) sources.push({ source: "binance", price: binance });

  const chainlink = await readChainlinkUsd(provider, "0x5f4eC3Df9cbd43714FE2740f5e3616155c5b8419", 3 * 3600, blockTimestamp).catch(() => null);
  if (chainlink) sources.push({ source: "chainlink", price: chainlink.priceUsd });

  let best = null;
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const deviation = percentDiff(sources[i].price, sources[j].price);
      if (deviation !== null && deviation <= 2 && (!best || deviation < best.deviation)) {
        best = { priceUsd: (sources[i].price + sources[j].price) / 2, deviation, sources: [sources[i].source, sources[j].source] };
      }
    }
  }
  if (best) return best;
  if (sources.length === 1) return { priceUsd: sources[0].price, deviation: null, sources: [sources[0].source], singleSource: true };
  return null;
}

async function fetchPrices(addresses) {
  const keys = [...new Set(addresses.map(lowerAddress).filter(Boolean).map((addr) => `ethereum:${addr}`))];
  const out = new Map();
  for (let i = 0; i < keys.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.slice(i, i + 50).join(",")}?searchWidth=6h`, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    for (const [key, row] of Object.entries(json.coins || {})) {
      const addr = key.split(":").pop().toLowerCase();
      const price = Number(row?.price || 0);
      if (price > 0) out.set(addr, price);
    }
  }
  const eth = await fetchJson("https://coins.llama.fi/prices/current/coingecko:ethereum", { timeoutMs: 20_000 }).catch(() => null);
  const ethPrice = Number(eth?.coins?.["coingecko:ethereum"]?.price || 0);
  if (ethPrice > 0) out.set(TOKENS.WETH.toLowerCase(), ethPrice);
  return out;
}

function priceOf(prices, address, fallback = null) {
  const key = lowerAddress(address);
  const live = key ? Number(prices.get(key) || 0) : 0;
  if (live > 0) return live;
  const fb = Number(fallback || 0);
  return fb > 0 ? fb : null;
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

async function probeWrapperManagerRedeem(provider, wrapper, asset) {
  const manager = normalizeAddress(await safeCall(provider, wrapper, WRAPPER_MANAGER, "manager"));
  const assetAddr = normalizeAddress(asset);
  const wrapperAddr = normalizeAddress(wrapper);
  if (!manager || !assetAddr || !wrapperAddr) return null;

  const [withdrawEnabled, maxRedeemCap, managerAssetBalance, wrapperAssetBalance] = await Promise.all([
    safeCall(provider, manager, WRAPPER_MANAGER, "withdrawAssets", [wrapperAddr, assetAddr]),
    safeCall(provider, manager, WRAPPER_MANAGER, "maxRedeemCap", [wrapperAddr]),
    safeCall(provider, assetAddr, ERC20, "balanceOf", [manager]),
    safeCall(provider, assetAddr, ERC20, "balanceOf", [wrapperAddr]),
  ]);
  const cap = toBigInt(maxRedeemCap, 0n);
  const managerLiquidity = toBigInt(managerAssetBalance, 0n);
  const wrapperLiquidity = toBigInt(wrapperAssetBalance, 0n);
  const totalInstantLiquidity = managerLiquidity + wrapperLiquidity;
  const enabled = Boolean(withdrawEnabled);
  const sameBlockAssetTransferProven = Boolean(enabled && cap > 0n && totalInstantLiquidity > 0n);
  let blocker = null;
  if (!enabled) blocker = "Wrapper manager does not enable this withdrawal asset";
  else if (cap <= 0n) blocker = "Wrapper manager instant redeem cap is zero";
  else if (totalInstantLiquidity <= 0n) blocker = "Wrapper manager/wrapper asset liquidity is zero";

  return {
    manager,
    withdrawAssetEnabled: enabled,
    maxRedeemCapRaw: maxRedeemCap?.toString?.() || null,
    managerAssetBalanceRaw: managerAssetBalance?.toString?.() || null,
    wrapperAssetBalanceRaw: wrapperAssetBalance?.toString?.() || null,
    totalInstantLiquidityRaw: totalInstantLiquidity.toString(),
    sameBlockAssetTransferProven,
    blocker,
  };
}

async function readChainlinkUsd(provider, feed, maxAgeSeconds, blockTimestamp) {
  try {
    const feedAddr = normalizeAddress(feed);
    if (!feedAddr) return null;
    const [roundRaw, decimalsRaw] = await Promise.all([
      provider.call({ to: feedAddr, data: CHAINLINK.encodeFunctionData("latestRoundData", []) }),
      provider.call({ to: feedAddr, data: CHAINLINK.encodeFunctionData("decimals", []) }),
    ]);
    const [, answer, , updatedAt] = CHAINLINK.decodeFunctionResult("latestRoundData", roundRaw);
    const [decimals] = CHAINLINK.decodeFunctionResult("decimals", decimalsRaw);
    if (answer <= 0n || updatedAt <= 0n) return null;
    const now = Number(blockTimestamp || Math.floor(Date.now() / 1000));
    const age = now - Number(updatedAt);
    if (age < 0 || age > maxAgeSeconds) return null;
    return { priceUsd: Number(answer) / (10 ** Number(decimals)), age, feed: feedAddr };
  } catch (_) {
    return null;
  }
}

async function tokenUsdPrice(provider, token, graphPriceUsd, prices, blockTimestamp, validatedEthUsd = null) {
  const tokenLc = lowerAddress(token);
  const graph = Number(graphPriceUsd || 0);
  if (!tokenLc) return { priceUsd: null, trusted: false, source: "invalid-token", reason: "invalid token" };
  if (tokenLc === TOKENS.WETH.toLowerCase() && validatedEthUsd?.priceUsd > 0) {
    return {
      priceUsd: validatedEthUsd.priceUsd,
      trusted: validatedEthUsd.singleSource !== true,
      source: `validated-eth-usd:${validatedEthUsd.sources.join("+")}`,
      graphDeviationPct: percentDiff(validatedEthUsd.priceUsd, graph),
      reason: validatedEthUsd.singleSource ? "only one ETH/USD source available" : null,
    };
  }
  if (tokenLc === TOKENS.WSTETH.toLowerCase()) {
    const steth = await readChainlinkUsd(provider, "0xCfE54B5cD566aB89272946F602D76Ea879CAb4a8", 3 * 3600, blockTimestamp);
    const spr = await safeCall(provider, TOKENS.WSTETH, new ethers.Interface(["function stEthPerToken() view returns (uint256)"]), "stEthPerToken");
    if (steth && spr) {
      const priceUsd = steth.priceUsd * Number(spr) / 1e18;
      return { priceUsd, trusted: true, source: "chainlink-steth-plus-wsteth-rate", graphDeviationPct: percentDiff(priceUsd, graph), reason: null };
    }
  }
  const cfg = CHAINLINK_FEEDS.get(tokenLc);
  if (cfg) {
    const live = await readChainlinkUsd(provider, cfg.feed, cfg.maxAgeSeconds, blockTimestamp);
    if (live) return { priceUsd: live.priceUsd, trusted: true, source: `chainlink-${cfg.label.toLowerCase()}-usd`, feed: live.feed, age: live.age, graphDeviationPct: percentDiff(live.priceUsd, graph), reason: null };
  }
  const llama = priceOf(prices, token, graph);
  return { priceUsd: llama, trusted: false, source: llama ? "defillama-reference-only" : "missing-price", graphDeviationPct: percentDiff(llama, graph), reason: "no supported fresh Chainlink/live rate source for route-positive gating" };
}

async function fetchMorphoLiquidationItems() {
  const query = `query($first: Int!) {
    marketPositions(first: $first, orderBy: BorrowShares, orderDirection: Desc,
      where: { healthFactor_lte: 0.99, borrowShares_gte: "1" }) {
      items {
        user { address }
        market {
          chain { id network }
          loanAsset { symbol address decimals }
          collateralAsset { symbol address decimals }
          oracle { address }
          irmAddress
          lltv
        }
        healthFactor
        state { collateral collateralUsd borrowAssets borrowAssetsUsd borrowShares marginUsd }
      }
    }
  }`;
  const json = await fetchJson("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { first: GRAPHQL_FIRST } }),
    timeoutMs: 30_000,
  }).catch(() => null);
  if (!json || json.errors) return [];
  return json.data?.marketPositions?.items || [];
}

async function readOnchainMarketPosition(provider, marketParams, borrower) {
  const id = marketId(marketParams);
  const [marketRaw, positionRaw, oracleRaw] = await Promise.all([
    provider.call({ to: MORPHO, data: MORPHO_IFACE.encodeFunctionData("market", [id]) }).catch(() => null),
    provider.call({ to: MORPHO, data: MORPHO_IFACE.encodeFunctionData("position", [id, borrower]) }).catch(() => null),
    provider.call({ to: marketParams.oracle, data: ORACLE.encodeFunctionData("price", []) }).catch(() => null),
  ]);
  if (!marketRaw || !positionRaw || !oracleRaw) return null;
  try {
    const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = MORPHO_IFACE.decodeFunctionResult("market", marketRaw);
    const [supplyShares, borrowShares, collateral] = MORPHO_IFACE.decodeFunctionResult("position", positionRaw);
    const [oraclePrice] = ORACLE.decodeFunctionResult("price", oracleRaw);
    return { id, totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee, supplyShares, borrowShares, collateral, oraclePrice };
  } catch (_) {
    return null;
  }
}

async function getPool(provider, tokenA, tokenB, fee) {
  const a = normalizeAddress(tokenA);
  const b = normalizeAddress(tokenB);
  if (!a || !b || sameAddress(a, b)) return null;
  const key = [a.toLowerCase(), b.toLowerCase(), fee].sort().join(":");
  if (poolCache.has(key)) return poolCache.get(key);
  const raw = await provider.call({
    to: UNISWAP_V3_FACTORY,
    data: FACTORY.encodeFunctionData("getPool", [a, b, fee]),
  }).catch(() => null);
  let pool = null;
  if (raw) {
    try {
      const [decoded] = FACTORY.decodeFunctionResult("getPool", raw);
      pool = decoded && decoded !== ZERO ? decoded : null;
    } catch (_) {}
  }
  poolCache.set(key, pool);
  return pool;
}

async function buildUniswapPathCandidates(provider, tokenIn, tokenOut, intermediates, includeDirect, includeTwoHop) {
  const input = normalizeAddress(tokenIn);
  const output = normalizeAddress(tokenOut);
  if (!input || !output) return [];
  if (sameAddress(input, output)) return [{ tokens: [input, output], fees: [0], pools: [], label: "same-token", directSameToken: true }];
  const candidates = [];
  if (includeDirect) {
    for (const fee of FEES) {
      const pool = await getPool(provider, input, output, fee);
      if (pool) candidates.push({ tokens: [input, output], fees: [fee], pools: [pool], label: routeLabel([input, output], [fee]), direct: true });
    }
  }
  if (includeTwoHop) {
    const mids = [...new Set(intermediates.map(normalizeAddress).filter(Boolean).map((x) => x.toLowerCase()))]
      .filter((x) => !sameAddress(x, input) && !sameAddress(x, output))
      .map((x) => ethers.getAddress(x));
    for (const mid of mids) {
      for (const fee1 of FEES) {
        const pool1 = await getPool(provider, input, mid, fee1);
        if (!pool1) continue;
        for (const fee2 of FEES) {
          const pool2 = await getPool(provider, mid, output, fee2);
          if (!pool2) continue;
          candidates.push({ tokens: [input, mid, output], fees: [fee1, fee2], pools: [pool1, pool2], label: routeLabel([input, mid, output], [fee1, fee2]), direct: false });
          if (candidates.length >= MAX_UNISWAP_PATHS) return candidates;
        }
      }
    }
  }
  return candidates;
}

async function quoteUniswapExactInput(provider, tokenIn, tokenOut, amountIn, intermediates, includeDirect, includeTwoHop) {
  const value = toBigInt(amountIn, 0n);
  if (value <= 0n) return [];
  if (sameAddress(tokenIn, tokenOut)) {
    return [{
      source: "same-token",
      pathKind: "same-token",
      executorCompatible: true,
      referenceOnly: false,
      amountInRaw: value,
      amountOutRaw: value,
      gasEstimate: 0n,
      path: { tokens: [normalizeAddress(tokenIn), normalizeAddress(tokenOut)], fees: [0], label: "same-token" },
    }];
  }
  const out = [];
  const paths = await buildUniswapPathCandidates(provider, tokenIn, tokenOut, intermediates, includeDirect, includeTwoHop);
  for (const p of paths) {
    if (p.directSameToken) continue;
    const raw = await provider.call({
      to: UNISWAP_V3_QUOTER_V2,
      data: QUOTER.encodeFunctionData("quoteExactInput", [encodePath(p.tokens, p.fees), value]),
    }).catch(() => null);
    if (!raw) continue;
    try {
      const [amountOut, , , gasEstimate] = QUOTER.decodeFunctionResult("quoteExactInput", raw);
      out.push({
        source: p.direct ? "Uniswap V3 exactInputSingle" : "Uniswap V3 routed exact-input",
        pathKind: p.direct ? "uniswap-v3-single" : "uniswap-v3-routed",
        executorCompatible: Boolean(p.direct),
        referenceOnly: false,
        amountInRaw: value,
        amountOutRaw: amountOut,
        gasEstimate,
        path: p,
      });
    } catch (_) {}
  }
  return out;
}

async function fetchCurvePools() {
  const registries = ["main", "factory", "factory-stable-ng", "crypto", "factory-crypto"];
  const pools = [];
  for (const registry of registries) {
    const json = await fetchJson(`https://api.curve.fi/v1/getPools/ethereum/${registry}`, { timeoutMs: 30_000 }).catch(() => null);
    for (const p of json?.data?.poolData || []) {
      const address = normalizeAddress(p.address);
      const coins = (p.coins || []).map((coin, index) => ({
        index,
        address: normalizeAddress(coin.address),
        symbol: coin.symbol || null,
        decimals: Number(coin.decimals ?? 18),
      })).filter((coin) => coin.address);
      if (!address || coins.length < 2) continue;
      pools.push({
        source: `Curve ${registry}`,
        name: p.name || p.symbol || null,
        address,
        coins,
        usdTotal: Number(p.usdTotal || p.usdTotalExcludingBasePool || 0) || null,
        isBroken: Boolean(p.isBroken),
      });
    }
  }
  return pools;
}

function findCurvePools(curvePools, tokenIn, tokenOut) {
  const input = lowerAddress(tokenIn);
  const output = lowerAddress(tokenOut);
  if (!input || !output || input === output) return [];
  return (curvePools || []).map((pool) => {
    const i = pool.coins.find((coin) => lowerAddress(coin.address) === input);
    const j = pool.coins.find((coin) => lowerAddress(coin.address) === output);
    return i && j && !pool.isBroken ? { ...pool, i, j } : null;
  }).filter(Boolean)
    .sort((a, b) => Number(b.usdTotal || 0) - Number(a.usdTotal || 0))
    .slice(0, CURVE_MAX_POOLS_PER_PAIR);
}

async function curveGetDy(provider, pool, i, j, dx) {
  const amount = toBigInt(dx, 0n);
  if (amount <= 0n) return null;
  const key = `${pool.address}:${i}:${j}:${amount.toString()}`;
  if (curveDyCache.has(key)) return curveDyCache.get(key);
  for (const iface of [CURVE_INT128, CURVE_UINT256]) {
    const raw = await provider.call({
      to: pool.address,
      data: iface.encodeFunctionData("get_dy", [BigInt(i), BigInt(j), amount]),
    }).catch(() => null);
    if (!raw) continue;
    try {
      const [dy] = iface.decodeFunctionResult("get_dy", raw);
      if (dy > 0n) {
        curveDyCache.set(key, dy);
        return dy;
      }
    } catch (_) {}
  }
  curveDyCache.set(key, null);
  return null;
}

async function quoteCurveExactInput(provider, curvePools, tokenIn, tokenOut, amountIn) {
  const out = [];
  for (const pool of findCurvePools(curvePools, tokenIn, tokenOut)) {
    const amountOut = await curveGetDy(provider, pool, pool.i.index, pool.j.index, amountIn).catch(() => null);
    if (!amountOut || amountOut <= 0n) continue;
    out.push({
      source: pool.source,
      pathKind: "curve-direct",
      executorCompatible: false,
      referenceOnly: false,
      amountInRaw: toBigInt(amountIn),
      amountOutRaw: amountOut,
      gasEstimate: 0n,
      path: { pool: pool.address, name: pool.name, tokenIn: pool.i.address, tokenOut: pool.j.address, coinIn: pool.i, coinOut: pool.j },
    });
  }
  return out;
}

function stableHopCandidates(tokenIn, tokenOut, intermediates) {
  const base = [TOKENS.WETH, TOKENS.USDC, TOKENS.USDT, TOKENS.DAI, TOKENS.crvUSD, TOKENS.USDE, TOKENS.USDS, TOKENS.FRAX, TOKENS.PYUSD, TOKENS.USD0, ...intermediates];
  return [...new Set(base.map(normalizeAddress).filter(Boolean).map((x) => x.toLowerCase()))]
    .map((x) => ethers.getAddress(x))
    .filter((mid) => !sameAddress(mid, tokenIn) && !sameAddress(mid, tokenOut))
    .slice(0, 12);
}

async function quoteCurveStableHops(provider, curvePools, tokenIn, tokenOut, amountIn, intermediates) {
  const candidates = [];
  for (const mid of stableHopCandidates(tokenIn, tokenOut, intermediates)) {
    if (findCurvePools(curvePools, tokenIn, mid).length > 0) {
      const curveHeads = await quoteCurveExactInput(provider, curvePools, tokenIn, mid, amountIn).catch(() => []);
      const curveHead = curveHeads.sort((a, b) => (a.amountOutRaw > b.amountOutRaw ? -1 : a.amountOutRaw < b.amountOutRaw ? 1 : 0))[0];
      if (curveHead) {
        const uniTails = await quoteUniswapExactInput(provider, mid, tokenOut, curveHead.amountOutRaw, intermediates, true, true).catch(() => []);
        const bestTail = uniTails.sort((a, b) => (a.amountOutRaw > b.amountOutRaw ? -1 : a.amountOutRaw < b.amountOutRaw ? 1 : 0))[0];
        if (bestTail) candidates.push({
          source: "Curve + Uniswap V3 exact-input",
          pathKind: "curve-to-uniswap-v3",
          executorCompatible: false,
          referenceOnly: false,
          amountInRaw: toBigInt(amountIn),
          amountOutRaw: bestTail.amountOutRaw,
          gasEstimate: toBigInt(bestTail.gasEstimate) + toBigInt(curveHead.gasEstimate),
          path: { legs: [curveHead.path, bestTail.path] },
        });
      }
    }
    if (findCurvePools(curvePools, mid, tokenOut).length > 0) {
      const uniHeads = await quoteUniswapExactInput(provider, tokenIn, mid, amountIn, intermediates, true, true).catch(() => []);
      const bestHead = uniHeads.sort((a, b) => (a.amountOutRaw > b.amountOutRaw ? -1 : a.amountOutRaw < b.amountOutRaw ? 1 : 0))[0];
      if (!bestHead) continue;
      const curveTails = await quoteCurveExactInput(provider, curvePools, mid, tokenOut, bestHead.amountOutRaw).catch(() => []);
      const bestTail = curveTails.sort((a, b) => (a.amountOutRaw > b.amountOutRaw ? -1 : a.amountOutRaw < b.amountOutRaw ? 1 : 0))[0];
      if (bestTail) candidates.push({
        source: "Uniswap V3 + Curve exact-input",
        pathKind: "uniswap-v3-to-curve",
        executorCompatible: false,
        referenceOnly: false,
        amountInRaw: toBigInt(amountIn),
        amountOutRaw: bestTail.amountOutRaw,
        gasEstimate: toBigInt(bestHead.gasEstimate) + toBigInt(bestTail.gasEstimate),
        path: { legs: [bestHead.path, bestTail.path] },
      });
    }
  }
  return candidates;
}

async function fetchBalancerPoolsForPair(tokenIn, tokenOut) {
  const a = lowerAddress(tokenIn);
  const b = lowerAddress(tokenOut);
  if (!a || !b || a === b) return [];
  const key = [a, b].sort().join(":");
  if (balancerPairCache.has(key)) return balancerPairCache.get(key);
  const query = `query($tokens: [Bytes!]!) {
    pools(first: ${BALANCER_MAX_POOLS_PER_PAIR}, orderBy: totalLiquidity, orderDirection: desc,
      where: { tokensList_contains: $tokens, totalLiquidity_gt: 0, swapEnabled: true }) {
      id
      address
      symbol
      totalLiquidity
      swapFee
      tokens { address symbol decimals balance }
    }
  }`;
  const endpoints = [
    "https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-v2",
    "https://gateway.thegraph.com/api/subgraphs/id/C4ayEZP2yTXRAB8vSaTrgN4m9anTe9Mdm2ViyiAuV9TV",
  ];
  for (const endpoint of endpoints) {
    const json = await fetchJson(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { tokens: [a, b] } }),
      timeoutMs: 12_000,
    }).catch(() => null);
    const rows = (json?.data?.pools || []).map((p) => ({
      id: p.id,
      address: normalizeAddress(p.address),
      symbol: p.symbol || null,
      totalLiquidity: Number(p.totalLiquidity || 0),
      swapFee: p.swapFee || null,
      tokens: (p.tokens || []).map((t) => ({ address: normalizeAddress(t.address), symbol: t.symbol || null, decimals: Number(t.decimals || 18), balance: t.balance || null })).filter((t) => t.address),
    })).filter((p) => p.id && p.address);
    if (rows.length > 0) {
      balancerPairCache.set(key, rows);
      return rows;
    }
  }
  balancerPairCache.set(key, []);
  return [];
}

async function quoteBalancerExactInput(provider, tokenIn, tokenOut, amountIn) {
  const pools = await fetchBalancerPoolsForPair(tokenIn, tokenOut).catch(() => []);
  const candidates = [];
  for (const pool of pools) {
    try {
      const assets = [normalizeAddress(tokenIn), normalizeAddress(tokenOut)];
      const swaps = [{ poolId: pool.id, assetInIndex: 0, assetOutIndex: 1, amount: toBigInt(amountIn), userData: "0x" }];
      const funds = { sender: ZERO, fromInternalBalance: false, recipient: ZERO, toInternalBalance: false };
      const raw = await provider.call({ to: BALANCER_VAULT, data: BALANCER.encodeFunctionData("queryBatchSwap", [0, swaps, assets, funds]) }).catch(() => null);
      if (!raw) continue;
      const [deltas] = BALANCER.decodeFunctionResult("queryBatchSwap", raw);
      const outDelta = toBigInt(deltas[1], 0n);
      const amountOut = outDelta < 0n ? -outDelta : 0n;
      if (amountOut <= 0n) continue;
      candidates.push({
        source: "Balancer V2 queryBatchSwap",
        pathKind: "balancer-v2-single",
        executorCompatible: false,
        referenceOnly: false,
        amountInRaw: toBigInt(amountIn),
        amountOutRaw: amountOut,
        gasEstimate: 0n,
        path: { poolId: pool.id, pool: pool.address, symbol: pool.symbol, totalLiquidity: pool.totalLiquidity, swapFee: pool.swapFee, assets },
      });
    } catch (_) {}
  }
  return candidates;
}

async function probeWrapper(provider, collateral, decimals, prices) {
  const one = 10n ** BigInt(Math.min(Number(decimals) || 18, 36));
  const [asset, totalSupply, totalAssets, convertToAssets, previewRedeem, maxRedeemZero] = await Promise.all([
    safeCall(provider, collateral, ERC20, "asset"),
    safeCall(provider, collateral, ERC20, "totalSupply"),
    safeCall(provider, collateral, ERC20, "totalAssets"),
    safeCall(provider, collateral, ERC20, "convertToAssets", [one]),
    safeCall(provider, collateral, ERC20, "previewRedeem", [one]),
    safeCall(provider, collateral, ERC20, "maxRedeem", [ZERO]),
  ]);
  const assetAddr = normalizeAddress(asset);
  const assetDecimals = assetAddr ? await safeCall(provider, assetAddr, ERC20, "decimals").then((x) => x === null ? null : Number(x)).catch(() => null) : null;
  const assetSymbol = assetAddr ? await safeCall(provider, assetAddr, ERC20, "symbol").then((x) => x === null ? null : String(x)).catch(() => null) : null;
  const assetPriceUsd = assetAddr ? priceOf(prices, assetAddr, null) : null;
  const redeemProof = assetAddr ? await probeWrapperManagerRedeem(provider, collateral, assetAddr).catch(() => null) : null;
  return {
    erc4626Like: Boolean(assetAddr && (convertToAssets !== null || previewRedeem !== null)),
    asset: assetAddr,
    assetSymbol,
    assetDecimals,
    assetPriceUsd,
    totalSupplyRaw: totalSupply?.toString() || null,
    totalAssetsRaw: totalAssets?.toString() || null,
    convertOneShareToAssetsRaw: convertToAssets?.toString() || null,
    previewRedeemOneShareRaw: previewRedeem?.toString() || null,
    maxRedeemZeroRaw: maxRedeemZero?.toString() || null,
    redeemProof,
    redemptionProbe: assetAddr ? "view-only" : "not-erc4626-or-unsupported-view",
  };
}

async function quoteWrapperRedeemExit(provider, curvePools, wrapper, collateral, loan, seizedCollateral, intermediates) {
  if (!wrapper?.erc4626Like || !wrapper.asset || sameAddress(wrapper.asset, collateral)) return [];
  const assetsOut = await safeCall(provider, collateral, ERC20, "previewRedeem", [seizedCollateral]).catch(() => null);
  if (!assetsOut || assetsOut <= 0n) return [];
  const nextIntermediates = [...intermediates, wrapper.asset];
  const direct = sameAddress(wrapper.asset, loan) ? [{
    source: "ERC4626 previewRedeem to loan token",
    pathKind: "erc4626-preview-redeem",
    executorCompatible: false,
    referenceOnly: false,
    amountInRaw: toBigInt(seizedCollateral),
    amountOutRaw: assetsOut,
    gasEstimate: 0n,
    path: { wrapper: collateral, asset: wrapper.asset, previewAssetsRaw: assetsOut.toString() },
  }] : [];
  const tails = sameAddress(wrapper.asset, loan) ? [] : await quoteExitCandidates(provider, curvePools, wrapper.asset, loan, assetsOut, nextIntermediates, null, { skipWrapper: true }).catch(() => []);
  return [...direct, ...tails.map((tail) => ({
    ...tail,
    source: `ERC4626 previewRedeem + ${tail.source}`,
    pathKind: `erc4626-${tail.pathKind}`,
    executorCompatible: false,
    amountInRaw: toBigInt(seizedCollateral),
    path: { wrapper: collateral, asset: wrapper.asset, previewAssetsRaw: assetsOut.toString(), tail: tail.path },
  }))];
}

async function quoteReferenceAggregators(tokenIn, tokenOut, amountIn) {
  if (!ENABLE_REFERENCE_QUOTES) return [];
  const candidates = [];
  const sellToken = normalizeAddress(tokenIn);
  const buyToken = normalizeAddress(tokenOut);
  if (!sellToken || !buyToken || toBigInt(amountIn) <= 0n) return candidates;
  const url = `https://api.0x.org/swap/v1/quote?sellToken=${sellToken}&buyToken=${buyToken}&sellAmount=${toBigInt(amountIn).toString()}&slippagePercentage=0.01`;
  const json = await fetchJson(url, { timeoutMs: 8000, headers: { accept: "application/json" } }).catch(() => null);
  const buyAmount = toBigInt(json?.buyAmount, 0n);
  if (buyAmount > 0n) candidates.push({
    source: "0x quote reference",
    pathKind: "aggregator-reference-0x",
    executorCompatible: false,
    referenceOnly: true,
    amountInRaw: toBigInt(amountIn),
    amountOutRaw: buyAmount,
    gasEstimate: toBigInt(json?.estimatedGas, 0n),
    path: { allowanceTarget: json?.allowanceTarget || null },
  });
  return candidates;
}

async function quoteExitCandidates(provider, curvePools, tokenIn, tokenOut, amountIn, intermediates, wrapper = null, opts = {}) {
  const candidates = [];
  candidates.push(...await quoteUniswapExactInput(provider, tokenIn, tokenOut, amountIn, intermediates, true, false).catch(() => []));
  if (opts.directOnly) return candidates.filter((q) => q && toBigInt(q.amountOutRaw) > 0n);
  candidates.push(...await quoteUniswapExactInput(provider, tokenIn, tokenOut, amountIn, intermediates, false, true).catch(() => []));
  candidates.push(...await quoteCurveExactInput(provider, curvePools, tokenIn, tokenOut, amountIn).catch(() => []));
  candidates.push(...await quoteCurveStableHops(provider, curvePools, tokenIn, tokenOut, amountIn, intermediates).catch(() => []));
  candidates.push(...await quoteBalancerExactInput(provider, tokenIn, tokenOut, amountIn).catch(() => []));
  if (!opts.skipWrapper && wrapper) candidates.push(...await quoteWrapperRedeemExit(provider, curvePools, wrapper, tokenIn, tokenOut, amountIn, intermediates).catch(() => []));
  candidates.push(...await quoteReferenceAggregators(tokenIn, tokenOut, amountIn).catch(() => []));
  const seen = new Set();
  return candidates
    .filter((q) => q && toBigInt(q.amountOutRaw) > 0n)
    .sort((a, b) => (toBigInt(a.amountOutRaw) > toBigInt(b.amountOutRaw) ? -1 : toBigInt(a.amountOutRaw) < toBigInt(b.amountOutRaw) ? 1 : 0))
    .filter((q) => {
      const key = `${q.pathKind}:${q.amountOutRaw.toString()}:${JSON.stringify(q.path || {})}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function buildIntermediates(item, wrapper) {
  const values = [
    TOKENS.WETH,
    TOKENS.WSTETH,
    TOKENS.WBTC,
    TOKENS.USDC,
    TOKENS.USDT,
    TOKENS.DAI,
    TOKENS.USDE,
    TOKENS.USDS,
    TOKENS.crvUSD,
    TOKENS.FRAX,
    TOKENS.PYUSD,
    TOKENS.USD0,
    item.market?.loanAsset?.address,
    item.market?.collateralAsset?.address,
    wrapper?.asset,
  ];
  return [...new Set(values.map(normalizeAddress).filter(Boolean).map((x) => x.toLowerCase()))].map((x) => ethers.getAddress(x));
}

async function scorePosition(provider, curvePools, prices, block, gas, item, validatedEthUsd, richRoutes) {
  const borrower = normalizeAddress(item.user?.address);
  const loan = normalizeAddress(item.market?.loanAsset?.address);
  const collateral = normalizeAddress(item.market?.collateralAsset?.address);
  const oracle = normalizeAddress(item.market?.oracle?.address);
  const irm = normalizeAddress(item.market?.irmAddress);
  const loanDecimals = Number(item.market?.loanAsset?.decimals ?? 18);
  const collateralDecimals = Number(item.market?.collateralAsset?.decimals ?? 18);
  const marketParams = { loanToken: loan, collateralToken: collateral, oracle, irm, lltv: item.market?.lltv || "0" };
  const graphBorrowUsd = Number(item.state?.borrowAssetsUsd || 0);
  const graphBorrowRaw = toBigInt(item.state?.borrowAssets || 0n);
  const graphBorrowHuman = formatUnitsNumber(graphBorrowRaw, loanDecimals) || 0;
  const graphLoanPrice = graphBorrowHuman > 0 && graphBorrowUsd > 0 ? graphBorrowUsd / graphBorrowHuman : null;
  const loanPrice = await tokenUsdPrice(provider, loan, graphLoanPrice, prices, block?.timestamp, validatedEthUsd);
  const collateralPriceUsd = priceOf(prices, collateral, Number(item.state?.collateralUsd || 0) > 0 && Number(item.state?.collateral || 0) > 0 ? null : null);
  const onchain = await readOnchainMarketPosition(provider, marketParams, borrower).catch(() => null);

  const base = {
    borrower,
    marketId: loan && collateral && oracle && irm ? marketId(marketParams) : null,
    pair: `${item.market?.loanAsset?.symbol || "?"}/${item.market?.collateralAsset?.symbol || "?"}`,
    healthFactor: Number(item.healthFactor || 0),
    graph: {
      borrowAssetsUsd: graphBorrowUsd,
      collateralUsd: Number(item.state?.collateralUsd || 0),
      borrowAssetsRaw: item.state?.borrowAssets || null,
      borrowSharesRaw: item.state?.borrowShares || null,
      collateralRaw: item.state?.collateral || null,
      marginUsd: Number(item.state?.marginUsd || 0),
    },
    loanAsset: { address: loan, symbol: item.market?.loanAsset?.symbol || null, decimals: loanDecimals, priceUsd: loanPrice.priceUsd, pricingTrusted: loanPrice.trusted, priceSource: loanPrice.source, priceReason: loanPrice.reason || null },
    collateral: { address: collateral, symbol: item.market?.collateralAsset?.symbol || null, decimals: collateralDecimals, priceUsd: collateralPriceUsd },
    marketParams,
    onchainAvailable: Boolean(onchain),
    routePositive: false,
    executorCompatiblePositive: false,
    signedActionJustified: false,
  };

  if (!borrower || !loan || !collateral || !oracle || !irm) return { ...base, blockers: ["Invalid GraphQL market or borrower address"] };
  if (!onchain || onchain.borrowShares <= 0n || onchain.collateral <= 0n || onchain.totalBorrowShares <= 0n || onchain.oraclePrice <= 0n) {
    return { ...base, blockers: ["Missing on-chain market/position/oracle data or no repayable debt/collateral"] };
  }
  if (!loanPrice.priceUsd) return { ...base, blockers: ["Missing loan-token USD price for gas/profit conversion"] };

  const wrapper = await probeWrapper(provider, collateral, collateralDecimals, prices).catch(() => null);
  const intermediates = buildIntermediates(item, wrapper);
  const lifRaw = liquidationIncentiveFactorRaw(marketParams.lltv);
  const sizeResults = [];

  for (const fraction of SIZE_FRACTIONS) {
    const repaidShares = parseFractionShares(onchain.borrowShares, fraction);
    if (repaidShares <= 0n) continue;
    const repaidAssets = toAssetsUp(repaidShares, onchain.totalBorrowAssets, onchain.totalBorrowShares);
    const seizedCollateral = mulDivDown(mulDivDown(repaidAssets, lifRaw, WAD), ORACLE_PRICE_SCALE, onchain.oraclePrice);
    const seizedExceedsCollateral = seizedCollateral > onchain.collateral;
    const executorFlashAmount = repaidAssets * (10_000n + EXECUTOR_REPAY_BUFFER_BPS) / 10_000n;
    const flashFeeRaw = executorFlashAmount * FLASH_FEE_BPS / 10_000n;
    const repayUsd = (formatUnitsNumber(repaidAssets, loanDecimals) || 0) * loanPrice.priceUsd;
    let quotes = [];
    if (!seizedExceedsCollateral && seizedCollateral > 0n) {
      quotes = await quoteExitCandidates(provider, curvePools, collateral, loan, seizedCollateral, intermediates, richRoutes ? wrapper : null, { directOnly: !richRoutes }).catch(() => []);
    }
    const scoredQuotes = quotes.slice(0, 8).map((quote) => {
      const expectedOutRaw = toBigInt(quote.amountOutRaw);
      const grossProfitRaw = expectedOutRaw - repaidAssets - flashFeeRaw;
      const expectedOut = formatUnitsNumber(expectedOutRaw, loanDecimals) || 0;
      const expectedOutUsd = expectedOut * loanPrice.priceUsd;
      const grossProfitUsd = (formatUnitsNumber(grossProfitRaw, loanDecimals) || 0) * loanPrice.priceUsd;
      const slippageUsd = repayUsd * SLIPPAGE_BPS / 10_000;
      const netProfitUsd = grossProfitUsd - Number(gas.liquidationGasUsd || 0) - slippageUsd;
      const wrapperPreviewOnly = String(quote.pathKind || "").includes("erc4626") && !ALLOW_UNPROVEN_WRAPPER_REDEEM;
      const wrapperProofBlocker = wrapperPreviewOnly && wrapper?.redeemProof?.sameBlockAssetTransferProven === false ? wrapper.redeemProof.blocker : null;
      const researchPositive = Boolean(!quote.referenceOnly && loanPrice.trusted && grossProfitRaw > 0n && netProfitUsd > 0);
      const routePositive = Boolean(researchPositive && !wrapperPreviewOnly);
      return {
        source: quote.source,
        pathKind: quote.pathKind,
        executorCompatible: Boolean(quote.executorCompatible),
        referenceOnly: Boolean(quote.referenceOnly),
        amountInRaw: quote.amountInRaw.toString(),
        amountOutRaw: expectedOutRaw.toString(),
        amountOut: expectedOut,
        expectedOutUsd,
        grossProfitRaw: grossProfitRaw.toString(),
        grossProfitUsd,
        slippageUsd,
        gasUsd: gas.liquidationGasUsd,
        netProfitUsd,
        gasEstimate: quote.gasEstimate?.toString?.() || null,
        researchPositive,
        routePositive,
        path: quote.path,
        blockers: [
          quote.referenceOnly ? "Reference-only aggregator quote, not executable" : null,
          loanPrice.trusted ? null : "Loan-token price is not trusted for route-positive gating",
          grossProfitRaw > 0n ? null : "Exit quote does not cover repay assets plus flash fee",
          netProfitUsd > 0 ? null : "Net profit after gas/slippage is not positive",
          wrapperPreviewOnly ? "ERC4626 wrapper route is preview-only until fork-proven redeemable" : null,
          wrapperProofBlocker,
          quote.executorCompatible ? null : "Not compatible with current E9 exactInputSingle executor",
        ].filter(Boolean),
      };
    });
    scoredQuotes.sort((a, b) => Number(b.netProfitUsd ?? -Infinity) - Number(a.netProfitUsd ?? -Infinity));
    const best = scoredQuotes[0] || null;
    sizeResults.push({
      fraction,
      repaidSharesRaw: repaidShares.toString(),
      repaidAssetsRaw: repaidAssets.toString(),
      repayUsd,
      seizedCollateralRaw: seizedCollateral.toString(),
      seizedCollateral: formatUnitsNumber(seizedCollateral, collateralDecimals),
      seizedExceedsCollateral,
      liquidationIncentiveFactor: Number(lifRaw) / 1e18,
      executorFlashAmountRaw: executorFlashAmount.toString(),
      flashFeeRaw: flashFeeRaw.toString(),
      quotes: scoredQuotes,
      best,
      routePositive: Boolean(best?.routePositive),
      executorCompatiblePositive: Boolean(best?.routePositive && best?.executorCompatible),
      blockers: [
        seizedExceedsCollateral ? "Partial repay would over-seize collateral" : null,
        scoredQuotes.length > 0 ? null : "No collateral-exit quote for this size",
        best?.routePositive ? null : "No positive net quote for this size",
      ].filter(Boolean),
    });
  }

  sizeResults.sort((a, b) => Number(b.best?.netProfitUsd ?? -Infinity) - Number(a.best?.netProfitUsd ?? -Infinity));
  const positives = sizeResults.flatMap((s) => (s.quotes || []).filter((q) => q.routePositive).map((q) => ({ fraction: s.fraction, quote: q })));
  const executorPositives = positives.filter((p) => p.quote.executorCompatible);
  return {
    ...base,
    onchain: {
      totalBorrowAssetsRaw: onchain.totalBorrowAssets.toString(),
      totalBorrowSharesRaw: onchain.totalBorrowShares.toString(),
      borrowSharesRaw: onchain.borrowShares.toString(),
      collateralRaw: onchain.collateral.toString(),
      oraclePriceRaw: onchain.oraclePrice.toString(),
      lastUpdate: onchain.lastUpdate.toString(),
      fee: onchain.fee.toString(),
    },
    wrapper,
    routedIntermediates: intermediates,
    sizeResults,
    best: sizeResults[0] || null,
    routePositive: positives.length > 0,
    executorCompatiblePositive: executorPositives.length > 0,
    signedActionJustified: false,
    blockers: [
      positives.length > 0 ? null : "No route-positive liquidation size",
      executorPositives.length > 0 ? "No current E9 exactInputSingle-compatible positive route" : "No current E9 exactInputSingle-compatible positive route",
      richRoutes ? "Fork proof and signed-action authorization absent" : "Research-only route surface skipped for this lower-priority row",
    ].filter(Boolean),
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const rpc = await resolveEthereumRpc();
  if (!rpc) throw new Error("missing ethereum rpc");
  const provider = new ethers.JsonRpcProvider(rpc);
  const block = await provider.getBlock("latest");
  const gasPriceWei = await provider.send("eth_gasPrice", []).then(BigInt).catch(() => 0n);

  const allItems = await fetchMorphoLiquidationItems();
  const items = allItems.filter((p) => Number(p.market?.chain?.id) === 1
    && Number(p.healthFactor || 0) > 0
    && Number(p.healthFactor || 0) < 1
    && Number(p.state?.borrowAssetsUsd || 0) >= MIN_DEBT_USD
    && Number(p.state?.collateralUsd || 0) >= MIN_COLLATERAL_USD
    && normalizeAddress(p.user?.address)
    && normalizeAddress(p.market?.loanAsset?.address)
    && normalizeAddress(p.market?.collateralAsset?.address)
    && normalizeAddress(p.market?.oracle?.address)
    && normalizeAddress(p.market?.irmAddress))
    .sort((a, b) => Number(b.state?.collateralUsd || 0) - Number(a.state?.collateralUsd || 0)
      || Number(b.state?.borrowAssetsUsd || 0) - Number(a.state?.borrowAssetsUsd || 0))
    .slice(0, MAX_POSITIONS);

  const priceAddresses = [];
  for (const item of items) priceAddresses.push(item.market?.loanAsset?.address, item.market?.collateralAsset?.address, ...Object.values(TOKENS));
  const prices = await fetchPrices(priceAddresses.filter(Boolean));
  const validatedEthUsd = await getValidatedEthUsdPrice(provider, block?.timestamp).catch(() => null);
  const ethPriceUsd = validatedEthUsd?.priceUsd || priceOf(prices, TOKENS.WETH, null);
  const gas = {
    gasPriceWei: gasPriceWei.toString(),
    ethPriceUsd,
    liquidationGasUsd: ethPriceUsd && gasPriceWei > 0n ? LIQUIDATION_GAS_UNITS * Number(gasPriceWei) / 1e18 * ethPriceUsd : null,
  };
  const curvePools = await fetchCurvePools().catch(() => []);

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const richRoutes = i < RESEARCH_MAX_ROWS;
    results.push(await scorePosition(provider, curvePools, prices, block, gas, item, validatedEthUsd, richRoutes).catch((err) => ({
      borrower: normalizeAddress(item.user?.address),
      pair: `${item.market?.loanAsset?.symbol || "?"}/${item.market?.collateralAsset?.symbol || "?"}`,
      error: err.message || String(err),
      routePositive: false,
      executorCompatiblePositive: false,
      signedActionJustified: false,
    })));
  }
  results.sort((a, b) => Number(b.executorCompatiblePositive) - Number(a.executorCompatiblePositive)
    || Number(b.routePositive) - Number(a.routePositive)
    || Number(b.best?.best?.netProfitUsd ?? b.best?.netProfitUsd ?? -Infinity) - Number(a.best?.best?.netProfitUsd ?? a.best?.netProfitUsd ?? -Infinity)
    || Number(b.graph?.borrowAssetsUsd || 0) - Number(a.graph?.borrowAssetsUsd || 0));

  const positiveRoutes = [];
  for (const row of results) {
    for (const size of row.sizeResults || []) {
      for (const quote of size.quotes || []) {
        if (quote.routePositive) positiveRoutes.push({ borrower: row.borrower, marketId: row.marketId, pair: row.pair, fraction: size.fraction, repaidAssetsRaw: size.repaidAssetsRaw, seizedCollateralRaw: size.seizedCollateralRaw, source: quote.source, pathKind: quote.pathKind, executorCompatible: quote.executorCompatible, netProfitUsd: quote.netProfitUsd });
      }
    }
  }
  const executorPositiveRoutes = positiveRoutes.filter((r) => r.executorCompatible);
  const routePositive = positiveRoutes.length;
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-e9-liquidation-salvage-routes.js",
    scope: "Read-only E9 Morpho liquidation route salvage scanner",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    block: { number: block?.number || null, timestamp: block?.timestamp || null, iso: block?.timestamp ? new Date(Number(block.timestamp) * 1000).toISOString() : null },
    thresholds: {
      maxPositions: MAX_POSITIONS,
      graphqlFirst: GRAPHQL_FIRST,
      researchMaxRows: RESEARCH_MAX_ROWS,
      minDebtUsd: MIN_DEBT_USD,
      minCollateralUsd: MIN_COLLATERAL_USD,
      sizeFractions: SIZE_FRACTIONS,
      slippageBps: SLIPPAGE_BPS,
      liquidationGasUnits: LIQUIDATION_GAS_UNITS,
      flashFeeBps: Number(FLASH_FEE_BPS),
      executorRepayBufferBps: Number(EXECUTOR_REPAY_BUFFER_BPS),
      allowUnprovenWrapperRedeem: ALLOW_UNPROVEN_WRAPPER_REDEEM,
      curvePoolsDiscovered: curvePools.length,
      balancerMaxPoolsPerPair: BALANCER_MAX_POOLS_PER_PAIR,
      referenceQuotesEnabled: ENABLE_REFERENCE_QUOTES,
    },
    gas,
    ethPriceValidation: validatedEthUsd || null,
    summary: {
      graphqlLiquidatableRows: allItems.filter((p) => Number(p.market?.chain?.id) === 1 && Number(p.healthFactor || 0) < 1).length,
      rowsScored: results.length,
      rowsWithAnyQuote: results.filter((r) => (r.sizeResults || []).some((s) => (s.quotes || []).length > 0)).length,
      rowsWithExecutorCompatibleQuote: results.filter((r) => (r.sizeResults || []).some((s) => (s.quotes || []).some((q) => q.executorCompatible))).length,
      rowsWithCurveQuote: results.filter((r) => (r.sizeResults || []).some((s) => (s.quotes || []).some((q) => String(q.pathKind || "").includes("curve")))).length,
      rowsWithBalancerQuote: results.filter((r) => (r.sizeResults || []).some((s) => (s.quotes || []).some((q) => String(q.pathKind || "").includes("balancer")))).length,
      rowsWithWrapperRedeemQuote: results.filter((r) => (r.sizeResults || []).some((s) => (s.quotes || []).some((q) => String(q.pathKind || "").includes("erc4626")))).length,
      rowsWithWrapperRedeemProofBlocker: results.filter((r) => r.wrapper?.redeemProof?.sameBlockAssetTransferProven === false).length,
      routePositive,
      researchPositiveRoutes: results.reduce((sum, r) => sum + (r.sizeResults || []).reduce((inner, s) => inner + (s.quotes || []).filter((q) => q.researchPositive).length, 0), 0),
      executorCompatibleRoutePositive: executorPositiveRoutes.length,
      signedActionJustified: false,
    },
    positiveRoutes,
    results,
    nextRoutePositiveCriteria: [
      "Exact borrower, market, repay shares/assets, seized collateral, and route must be specified",
      "Exit quote must cover repaid assets, flash fee, live gas, and slippage",
      "Loan-token USD price must be trusted for route-positive gating",
      "Current E9 executor can only use same-token or Uniswap V3 exactInputSingle routes",
      "Any routed/Curve/Balancer/wrapper positive route needs fork proof and a verified executor before live use",
    ],
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, jsonReplacer, 2) + "\n");
  console.log(`E9 liquidation salvage: rows=${output.summary.rowsScored} quotes=${output.summary.rowsWithAnyQuote} routePositive=${output.summary.routePositive} executorPositive=${output.summary.executorCompatibleRoutePositive}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT_FILE).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
