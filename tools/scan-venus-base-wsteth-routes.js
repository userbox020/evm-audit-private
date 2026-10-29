#!/usr/bin/env node
// Read-only Venus Base wstETH stale-ratio route mapper.
// Resolves live oracle, market, cap, pause, and route-liquidity gates without signed calls.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "venus-base-wsteth-routes.json");
const TIMEOUT_MS = 15_000;

const ETHEREUM_CHAIN_ID = 1;
const BASE_CHAIN_ID = 8453;

const ADDR = {
  comptroller: "0x0C7973F9598AA62f9e03B94E92C967fD5437426C",
  resilientOracle: "0xcBBf58bD5bAdE357b634419B70b215D5E9d6FbeD",
  chainlinkOracle: "0x6F2eA73597955DB37d7C06e1319F0dC7C7455dEb",
  oneJumpWstethOracle: "0xDDD4F0836c8016E11fC6741A4886E97B3c3d20C1",
  vWsteth: "0x133d3BCD77158D125B75A17Cb517fFD4B4BE64C5",
  vUsdc: "0x3cb752d175740043Ec463673094e06ACDa2F9a2e",
  vWeth: "0xEB8A79bD44cF4500943bf94a2b4434c95C008599",
  baseUsdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  baseWeth: "0x4200000000000000000000000000000000000006",
  mainnetWsteth: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
};

const THRESHOLDS = {
  minFeedAgeSeconds: Number(process.env.VB_MIN_FEED_AGE_SECONDS || "1800"),
  minOvervaluedCollateralPct: Number(process.env.VB_MIN_OVERVALUED_COLLATERAL_PCT || "30"),
  minUnderpricedBorrowPct: Number(process.env.VB_MIN_UNDERPRICED_BORROW_PCT || "5"),
  minRouteLiquidityUsd: Number(process.env.VB_MIN_ROUTE_LIQUIDITY_USD || "10000"),
  gasUsdBuffer: Number(process.env.VB_GAS_USD_BUFFER || "15"),
};

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const VTOKEN = new ethers.Interface([
  "function underlying() view returns (address)",
  "function getCash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const COMPTROLLER = new ethers.Interface([
  "function actionPaused(address,uint8) view returns (bool)",
  "function borrowCaps(address) view returns (uint256)",
  "function closeFactorMantissa() view returns (uint256)",
  "function liquidationIncentiveMantissa() view returns (uint256)",
  "function markets(address) view returns (bool,uint256,uint256)",
  "function minLiquidatableCollateral() view returns (uint256)",
  "function oracle() view returns (address)",
  "function supplyCaps(address) view returns (uint256)",
]);
const RESILIENT_ORACLE = new ethers.Interface([
  "function getTokenConfig(address) view returns (address,address[3],bool[3],bool)",
]);
const CHAINLINK_ORACLE = new ethers.Interface([
  "function tokenConfigs(address) view returns (address,address,uint256)",
]);
const AGGREGATOR = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const WSTETH = new ethers.Interface([
  "function stEthPerToken() view returns (uint256)",
]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function sanitizeError(error) {
  return String(error?.shortMessage || error?.message || error || "call failed").replace(/https?:\/\/\S+/g, "[redacted-url]").slice(0, 180);
}

function round(value, decimals = 4) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try { return Number(ethers.formatUnits(BigInt(raw), Number(decimals))); } catch (_) { return null; }
}

function formatUnitsString(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try { return ethers.formatUnits(BigInt(raw), Number(decimals)); } catch (_) { return null; }
}

function pct(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return (numerator / denominator) * 100;
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
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcUrl(chainId) {
  for (const url of loadRpcUrls()) {
    try {
      const got = await rpcCall(url, "eth_chainId", []);
      if (Number(BigInt(got)) === chainId) return url;
    } catch (_) {
      // Keep endpoints secret; try next URL.
    }
  }
  return null;
}

async function safeCall(provider, address, iface, name, args = []) {
  try {
    const raw = await provider.call({ to: address, data: iface.encodeFunctionData(name, args) });
    return { ok: true, value: iface.decodeFunctionResult(name, raw), raw };
  } catch (error) {
    return { ok: false, error: sanitizeError(error) };
  }
}

async function tokenMeta(provider, address) {
  const [symbol, name, decimals, totalSupply] = await Promise.all([
    safeCall(provider, address, ERC20, "symbol"),
    safeCall(provider, address, ERC20, "name"),
    safeCall(provider, address, ERC20, "decimals"),
    safeCall(provider, address, ERC20, "totalSupply"),
  ]);
  const dec = decimals.ok ? Number(decimals.value[0]) : null;
  return {
    address,
    symbol: symbol.ok ? symbol.value[0] : null,
    name: name.ok ? name.value[0] : null,
    decimals: dec,
    totalSupplyRaw: totalSupply.ok ? totalSupply.value[0].toString() : null,
    totalSupply: totalSupply.ok && dec !== null ? formatUnitsString(totalSupply.value[0], dec) : null,
  };
}

async function chainlinkConfigAndRound(provider, asset, blockTimestamp) {
  const config = await safeCall(provider, ADDR.chainlinkOracle, CHAINLINK_ORACLE, "tokenConfigs", [asset]);
  if (!config.ok) return { ok: false, error: config.error };

  const [, feed, maxStalePeriod] = config.value;
  if (!feed || feed === ethers.ZeroAddress) return { ok: false, error: "feed unavailable", feed };

  const [decimals, description, roundData] = await Promise.all([
    safeCall(provider, feed, AGGREGATOR, "decimals"),
    safeCall(provider, feed, AGGREGATOR, "description"),
    safeCall(provider, feed, AGGREGATOR, "latestRoundData"),
  ]);
  if (!roundData.ok) return { ok: false, error: roundData.error, feed };

  const feedDecimals = decimals.ok ? Number(decimals.value[0]) : 18;
  const [, answer, startedAt, updatedAt, answeredInRound] = roundData.value;
  const answerNumber = Number(answer) / 10 ** feedDecimals;
  const ageSeconds = Number(blockTimestamp) - Number(updatedAt);
  const maxStale = Number(maxStalePeriod || 0n);
  return {
    ok: true,
    asset,
    feed,
    description: description.ok ? description.value[0] : null,
    decimals: feedDecimals,
    answerRaw: answer.toString(),
    answer: answerNumber,
    startedAt: Number(startedAt),
    updatedAt: Number(updatedAt),
    answeredInRound: answeredInRound.toString(),
    ageSeconds,
    maxStalePeriod: maxStale,
    acceptedByChainlinkOracle: maxStale <= 0 ? true : ageSeconds <= maxStale,
  };
}

async function resilientTokenConfig(provider, asset) {
  const config = await safeCall(provider, ADDR.resilientOracle, RESILIENT_ORACLE, "getTokenConfig", [asset]);
  if (!config.ok) return { ok: false, error: config.error };
  const [, oracles, enabled, enableFlagsForToken] = config.value;
  return {
    ok: true,
    mainOracle: oracles[0],
    pivotOracle: oracles[1],
    fallbackOracle: oracles[2],
    enabled: enabled.map(Boolean),
    enableFlagsForToken: Boolean(enableFlagsForToken),
  };
}

async function venusActionPaused(provider, vToken, action) {
  const paused = await safeCall(provider, ADDR.comptroller, COMPTROLLER, "actionPaused", [vToken, action]);
  return paused.ok ? Boolean(paused.value[0]) : true;
}

async function venusMarket(provider, vToken, label, priceUsd) {
  const underlyingCall = await safeCall(provider, vToken, VTOKEN, "underlying");
  const underlying = underlyingCall.ok ? underlyingCall.value[0] : null;
  const meta = underlying ? await tokenMeta(provider, underlying) : null;
  const decimals = meta?.decimals ?? 18;

  const [cash, borrows, vSupply, market, supplyCap, borrowCap, mintPaused, borrowPaused, liquidatePaused] = await Promise.all([
    safeCall(provider, vToken, VTOKEN, "getCash"),
    safeCall(provider, vToken, VTOKEN, "totalBorrows"),
    safeCall(provider, vToken, VTOKEN, "totalSupply"),
    safeCall(provider, ADDR.comptroller, COMPTROLLER, "markets", [vToken]),
    safeCall(provider, ADDR.comptroller, COMPTROLLER, "supplyCaps", [vToken]),
    safeCall(provider, ADDR.comptroller, COMPTROLLER, "borrowCaps", [vToken]),
    venusActionPaused(provider, vToken, 0),
    venusActionPaused(provider, vToken, 2),
    venusActionPaused(provider, vToken, 5),
  ]);

  const cashRaw = cash.ok ? cash.value[0] : 0n;
  const borrowsRaw = borrows.ok ? borrows.value[0] : 0n;
  const supplyCapRaw = supplyCap.ok ? supplyCap.value[0] : 0n;
  const borrowCapRaw = borrowCap.ok ? borrowCap.value[0] : 0n;
  const borrowHeadroomRaw = borrowCapRaw > borrowsRaw ? borrowCapRaw - borrowsRaw : 0n;
  const cashHuman = formatUnitsNumber(cashRaw, decimals) || 0;
  const totalBorrowsHuman = formatUnitsNumber(borrowsRaw, decimals) || 0;
  const supplyCapHuman = formatUnitsNumber(supplyCapRaw, decimals) || 0;
  const borrowCapHuman = formatUnitsNumber(borrowCapRaw, decimals) || 0;
  const borrowHeadroomHuman = formatUnitsNumber(borrowHeadroomRaw, decimals) || 0;
  const cashUsd = cashHuman * (priceUsd || 0);
  const borrowHeadroomUsd = borrowHeadroomHuman * (priceUsd || 0);
  const capLimitedBorrowLiquidityUsd = borrowCapRaw === 0n ? 0 : Math.min(cashUsd, borrowHeadroomUsd || cashUsd);

  return {
    label,
    vToken,
    underlying,
    token: meta,
    listed: market.ok ? Boolean(market.value[0]) : false,
    collateralFactor: market.ok ? Number(market.value[1]) / 1e18 : 0,
    liquidationThreshold: market.ok ? Number(market.value[2]) / 1e18 : 0,
    mintPaused,
    borrowPaused,
    liquidatePaused,
    supplyCapRaw: supplyCapRaw.toString(),
    borrowCapRaw: borrowCapRaw.toString(),
    borrowHeadroomRaw: borrowHeadroomRaw.toString(),
    supplyCap: round(supplyCapHuman, 8),
    borrowCap: round(borrowCapHuman, 8),
    borrowHeadroom: round(borrowHeadroomHuman, 8),
    cashRaw: cashRaw.toString(),
    cash: round(cashHuman, 8),
    cashUsd: round(cashUsd, 2),
    totalBorrowsRaw: borrowsRaw.toString(),
    totalBorrows: round(totalBorrowsHuman, 8),
    totalSupplyRaw: vSupply.ok ? vSupply.value[0].toString() : null,
    priceUsd: round(priceUsd, 8),
    capLimitedBorrowLiquidityUsd: round(capLimitedBorrowLiquidityUsd, 2),
    borrowRouteUsable: !borrowPaused && borrowCapRaw > 0n && capLimitedBorrowLiquidityUsd >= THRESHOLDS.minRouteLiquidityUsd,
  };
}

function buildRouteAssessment({ wstethMarket, borrowMarkets, oracle }) {
  const blockers = [];
  const liveRatio = oracle.liveRatio;
  const staleRatio = oracle.staleRatio;
  const ethPriceUsd = oracle.ethPriceUsd;
  const divergencePct = oracle.divergencePct;
  const acceptedByVenus = oracle.acceptedByVenus;
  const staleEnough = oracle.staleEnough;
  const bestBorrowRoute = [...borrowMarkets].sort((a, b) => (b.capLimitedBorrowLiquidityUsd || 0) - (a.capLimitedBorrowLiquidityUsd || 0))[0] || null;

  const collateralFactor = wstethMarket.collateralFactor || 0;
  const liveWstethUsd = liveRatio && ethPriceUsd ? liveRatio * ethPriceUsd : null;
  const staleWstethUsd = staleRatio && ethPriceUsd ? staleRatio * ethPriceUsd : null;
  const borrowCapacityUsdPerWsteth = staleWstethUsd !== null ? staleWstethUsd * collateralFactor : null;
  const edgeUsdPerWsteth = borrowCapacityUsdPerWsteth !== null && liveWstethUsd !== null ? borrowCapacityUsdPerWsteth - liveWstethUsd : null;
  const breakEvenDivergencePct = collateralFactor > 0 ? ((1 / collateralFactor) - 1) * 100 : null;

  if (!acceptedByVenus) blockers.push("wstETH/ETH feed rejected by Venus stale-period gate");
  if (!staleEnough) blockers.push("feed age below monitor stale-window threshold");
  if (divergencePct === null || Math.abs(divergencePct) < THRESHOLDS.minUnderpricedBorrowPct) blockers.push("ratio divergence below minimum route threshold");
  if (divergencePct !== null && divergencePct < THRESHOLDS.minOvervaluedCollateralPct) blockers.push(`overvalued-collateral divergence below ${THRESHOLDS.minOvervaluedCollateralPct}% gate`);
  if (!wstethMarket.listed || wstethMarket.collateralFactor <= 0 || wstethMarket.mintPaused || Number(wstethMarket.supplyCap || 0) <= 0) blockers.push("wstETH collateral market not fully mintable/collateral-enabled");
  if (!bestBorrowRoute || !bestBorrowRoute.borrowRouteUsable) blockers.push("best borrow route below liquidity/cap/pause gate");
  if (edgeUsdPerWsteth !== null && edgeUsdPerWsteth <= THRESHOLDS.gasUsdBuffer) blockers.push("overvalued-collateral edge below gas/profit buffer");

  const overvaluedCollateral = {
    direction: "overvalued-collateral",
    collateralSymbol: "wstETH",
    bestBorrowRoute: bestBorrowRoute ? bestBorrowRoute.label : null,
    liveWstethUsd: round(liveWstethUsd, 6),
    staleWstethUsd: round(staleWstethUsd, 6),
    collateralFactor,
    borrowCapacityUsdPerWsteth: round(borrowCapacityUsdPerWsteth, 6),
    edgeUsdPerWsteth: round(edgeUsdPerWsteth, 6),
    grossEdgePct: liveWstethUsd ? round(((borrowCapacityUsdPerWsteth - liveWstethUsd) / liveWstethUsd) * 100, 6) : null,
    breakEvenDivergencePct: round(breakEvenDivergencePct, 4),
    routeLiquidityUsd: bestBorrowRoute ? bestBorrowRoute.capLimitedBorrowLiquidityUsd : 0,
    researchPositive: edgeUsdPerWsteth !== null && edgeUsdPerWsteth > 0,
    routePositive: Boolean(acceptedByVenus && staleEnough && divergencePct !== null
      && divergencePct >= THRESHOLDS.minOvervaluedCollateralPct
      && wstethMarket.listed && collateralFactor > 0 && !wstethMarket.mintPaused
      && Number(wstethMarket.supplyCap || 0) > 0 && bestBorrowRoute?.borrowRouteUsable
      && edgeUsdPerWsteth !== null && edgeUsdPerWsteth > THRESHOLDS.gasUsdBuffer),
  };

  const underpricedBorrowEdgePct = staleRatio && liveRatio ? ((liveRatio - staleRatio) / staleRatio) * 100 : null;
  const underpricedBorrow = {
    direction: "underpriced-borrow",
    borrowSymbol: "wstETH",
    wstethBorrowPaused: wstethMarket.borrowPaused,
    wstethBorrowCap: wstethMarket.borrowCap,
    wstethBorrowLiquidityUsd: wstethMarket.capLimitedBorrowLiquidityUsd,
    edgePct: round(underpricedBorrowEdgePct, 6),
    researchPositive: underpricedBorrowEdgePct !== null && underpricedBorrowEdgePct >= THRESHOLDS.minUnderpricedBorrowPct,
    routePositive: Boolean(acceptedByVenus && staleEnough && divergencePct !== null
      && divergencePct <= -THRESHOLDS.minUnderpricedBorrowPct
      && !wstethMarket.borrowPaused && Number(wstethMarket.borrowCap || 0) > 0
      && Number(wstethMarket.capLimitedBorrowLiquidityUsd || 0) >= THRESHOLDS.minRouteLiquidityUsd),
  };

  if (underpricedBorrow.wstethBorrowPaused || Number(wstethMarket.borrowCap || 0) <= 0) blockers.push("wstETH borrow direction paused/capped");
  if (Number(wstethMarket.capLimitedBorrowLiquidityUsd || 0) < THRESHOLDS.minRouteLiquidityUsd) blockers.push("wstETH borrow liquidity below monitor gate");

  const routes = [overvaluedCollateral, underpricedBorrow];
  return {
    classification: routes.some((r) => r.routePositive) ? "ROUTE_POSITIVE_NEEDS_FORK" : (acceptedByVenus && staleEnough ? "STALE_BUT_NO_ROUTE" : "FRESH_OR_REJECTED"),
    bestBorrowRoute,
    routes,
    blockers: [...new Set(blockers)],
    researchPositiveRows: routes.filter((r) => r.researchPositive).length,
    routePositive: routes.filter((r) => r.routePositive).length,
  };
}

async function main() {
  const [baseRpc, ethereumRpc] = await Promise.all([
    resolveRpcUrl(BASE_CHAIN_ID),
    resolveRpcUrl(ETHEREUM_CHAIN_ID),
  ]);
  if (!baseRpc) throw new Error("Base RPC unavailable");
  if (!ethereumRpc) throw new Error("Ethereum RPC unavailable");

  const baseProvider = new ethers.JsonRpcProvider(baseRpc, BASE_CHAIN_ID);
  const ethereumProvider = new ethers.JsonRpcProvider(ethereumRpc, ETHEREUM_CHAIN_ID);
  const [baseBlock, ethereumBlock] = await Promise.all([
    baseProvider.getBlock("latest"),
    ethereumProvider.getBlock("latest"),
  ]);

  const wstethUnderlyingCall = await safeCall(baseProvider, ADDR.vWsteth, VTOKEN, "underlying");
  const wstethUnderlying = wstethUnderlyingCall.ok ? wstethUnderlyingCall.value[0] : null;
  if (!wstethUnderlying) throw new Error("vwstETH underlying unavailable");

  const [wstethFeed, wethFeed, usdcFeed, liveRatioCall, resilientWsteth, comptOracle] = await Promise.all([
    chainlinkConfigAndRound(baseProvider, wstethUnderlying, baseBlock.timestamp),
    chainlinkConfigAndRound(baseProvider, ADDR.baseWeth, baseBlock.timestamp),
    chainlinkConfigAndRound(baseProvider, ADDR.baseUsdc, baseBlock.timestamp),
    safeCall(ethereumProvider, ADDR.mainnetWsteth, WSTETH, "stEthPerToken"),
    resilientTokenConfig(baseProvider, wstethUnderlying),
    safeCall(baseProvider, ADDR.comptroller, COMPTROLLER, "oracle"),
  ]);

  const liveRatio = liveRatioCall.ok ? Number(liveRatioCall.value[0]) / 1e18 : null;
  const staleRatio = wstethFeed.ok ? wstethFeed.answer : null;
  const divergencePct = liveRatio && staleRatio ? ((staleRatio - liveRatio) / liveRatio) * 100 : null;
  const maxStale = wstethFeed.ok ? (wstethFeed.maxStalePeriod || 93_600) : 93_600;
  const acceptedByVenus = wstethFeed.ok ? wstethFeed.ageSeconds <= maxStale : false;
  const staleEnough = wstethFeed.ok ? wstethFeed.ageSeconds >= THRESHOLDS.minFeedAgeSeconds : false;
  const ethPriceUsd = wethFeed.ok ? wethFeed.answer : null;

  const [closeFactor, liquidationIncentive, minLiquidatableCollateral] = await Promise.all([
    safeCall(baseProvider, ADDR.comptroller, COMPTROLLER, "closeFactorMantissa"),
    safeCall(baseProvider, ADDR.comptroller, COMPTROLLER, "liquidationIncentiveMantissa"),
    safeCall(baseProvider, ADDR.comptroller, COMPTROLLER, "minLiquidatableCollateral"),
  ]);

  const wstethPriceUsd = liveRatio && ethPriceUsd ? liveRatio * ethPriceUsd : 0;
  const [wstethMarket, usdcMarket, wethMarket] = await Promise.all([
    venusMarket(baseProvider, ADDR.vWsteth, "wstETH", wstethPriceUsd),
    venusMarket(baseProvider, ADDR.vUsdc, "USDC", usdcFeed.ok ? usdcFeed.answer : 1),
    venusMarket(baseProvider, ADDR.vWeth, "WETH", ethPriceUsd || 0),
  ]);

  const assessment = buildRouteAssessment({
    wstethMarket,
    borrowMarkets: [usdcMarket, wethMarket],
    oracle: {
      liveRatio,
      staleRatio,
      ethPriceUsd,
      divergencePct,
      acceptedByVenus,
      staleEnough,
    },
  });

  const out = {
    generatedAt: new Date().toISOString(),
    scope: "Venus Base wstETH stale-ratio route model",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: assessment.routePositive > 0,
      signedActionJustified: false,
    },
    sourceArtifacts: {
      monitorState: "reports\\monitor\\state.json",
      report: "reports\\venus-base-triage.md",
      baseRpc: "resolved from rpc_endpoints.txt without storing URL",
      ethereumRpc: "resolved from rpc_endpoints.txt without storing URL",
    },
    thresholds: THRESHOLDS,
    chainState: {
      base: { chainId: BASE_CHAIN_ID, blockNumber: baseBlock.number, timestamp: baseBlock.timestamp },
      ethereum: { chainId: ETHEREUM_CHAIN_ID, blockNumber: ethereumBlock.number, timestamp: ethereumBlock.timestamp },
    },
    addresses: ADDR,
    comptroller: {
      address: ADDR.comptroller,
      oracle: comptOracle.ok ? comptOracle.value[0] : null,
      closeFactor: closeFactor.ok ? Number(closeFactor.value[0]) / 1e18 : null,
      liquidationIncentive: liquidationIncentive.ok ? Number(liquidationIncentive.value[0]) / 1e18 : null,
      minLiquidatableCollateralUsd: minLiquidatableCollateral.ok ? Number(minLiquidatableCollateral.value[0]) / 1e18 : null,
    },
    oracle: {
      resilientWsteth,
      wstethFeed,
      wethFeed,
      usdcFeed,
      liveRatioSource: {
        chain: "Ethereum",
        token: ADDR.mainnetWsteth,
        method: "stEthPerToken()",
        blockNumber: ethereumBlock.number,
      },
      liveRatio,
      staleRatio,
      ethPriceUsd,
      liveWstethUsd: liveRatio && ethPriceUsd ? liveRatio * ethPriceUsd : null,
      staleWstethUsd: staleRatio && ethPriceUsd ? staleRatio * ethPriceUsd : null,
      divergencePct: round(divergencePct, 8),
      acceptedByVenus,
      staleEnough,
      pctOfMax: pct(wstethFeed.ok ? wstethFeed.ageSeconds : 0, maxStale),
    },
    markets: {
      wstETH: wstethMarket,
      USDC: usdcMarket,
      WETH: wethMarket,
    },
    assessment,
    summary: {
      classification: assessment.classification,
      feedAgeSeconds: wstethFeed.ok ? wstethFeed.ageSeconds : null,
      maxStaleSeconds: maxStale,
      pctOfMax: round(pct(wstethFeed.ok ? wstethFeed.ageSeconds : 0, maxStale), 2),
      divergencePct: round(divergencePct, 8),
      collateralFactor: wstethMarket.collateralFactor,
      bestBorrowRoute: assessment.bestBorrowRoute ? assessment.bestBorrowRoute.label : null,
      bestBorrowRouteLiquidityUsd: assessment.bestBorrowRoute ? assessment.bestBorrowRoute.capLimitedBorrowLiquidityUsd : 0,
      wstethBorrowLiquidityUsd: wstethMarket.capLimitedBorrowLiquidityUsd,
      researchPositiveRows: assessment.researchPositiveRows,
      routePositive: assessment.routePositive,
      signedActionJustified: false,
    },
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, jsonReplacer, 2));
  console.log(`Wrote ${path.relative(WORKSPACE, OUT_FILE)}`);
  console.log(`Venus Base wstETH: class=${out.summary.classification}; age=${out.summary.feedAgeSeconds}s; div=${out.summary.divergencePct}%; bestRoute=${out.summary.bestBorrowRoute || "n/a"} $${out.summary.bestBorrowRouteLiquidityUsd || 0}; routePositive=${out.summary.routePositive}`);
}

main().catch((error) => {
  console.error(`scan-venus-base-wsteth-routes failed: ${sanitizeError(error)}`);
  process.exit(1);
});
