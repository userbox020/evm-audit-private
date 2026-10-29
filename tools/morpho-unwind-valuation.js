#!/usr/bin/env node
"use strict";

// Venue-generic collateral -> loan-token unwind valuation for the Morpho Blue
// Ethereum liquidation (L class) producer.
//
// For every candidate market pair the qualifier discovers Uniswap V3 pools
// (collateral/loan, collateral/USDC, loan/USDC) by factory at the exact pin and
// quotes the actual seize/repay sizes through QuoterV2. Everything is valued in
// USDC so candidates across loans are comparable.
//
// No same-pin fork probe is run here, so every route is `quoteExecutable:false`
// and carries a conservative suppress-only haircut: the haircut can only reduce
// the realised output, never create a positive. A route is only allowed to
// become `routePositive:true` when the haircut-adjusted net after the bounded
// gas ceiling is still positive, at which point the keyless fixed-pin fork is
// the mandatory mined-execution probe. Unqualified pairs stay `unknown` and are
// suppressed. Nothing is fabricated.

const { ethers } = require("ethers");
const economics = require("./frax-usdc-cross-venue-economics");

const UNIV3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNIV3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const UNIV3_SWAP_ROUTER_02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC_DECIMALS = 6;
const FEES = Object.freeze([100, 500, 3000, 10000]);

const VENUES = Object.freeze({
  1: Object.freeze({ chainId: 1, factory: UNIV3_FACTORY, quoter: UNIV3_QUOTER_V2, router: UNIV3_SWAP_ROUTER_02, usdc: USDC, weth: WETH }),
  8453: Object.freeze({
    chainId: 8453,
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    weth: "0x4200000000000000000000000000000000000006",
  }),
});
function venueFor(chainId) { return VENUES[Number(chainId)] || VENUES[1]; }

const HAIRCUT_DIRECT_BPS = 25;
const HAIRCUT_TWO_HOP_BPS = 100;
const QUOTE_EXECUTABLE = false;

const IFACE = Object.freeze({
  factory: new ethers.Interface(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)"]),
  liquidity: new ethers.Interface(["function liquidity() view returns (uint128)"]),
  quoter: new ethers.Interface([
    "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
  ]),
  router: new ethers.Interface([
    "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
    "function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256 amountOut)",
  ]),
});

function ceilDiv(a, b) { return (a + b - 1n) / b; }
function haircutRaw(amount, bps) { return bps <= 0 ? 0n : ceilDiv(amount * BigInt(bps), 10_000n); }
function pairKey(collateralToken, loanToken) { return `${String(collateralToken).toLowerCase()}|${String(loanToken).toLowerCase()}`; }

// Morpho.liquidate: seize all collateral unless that would over-repay the user's
// shares, in which case repay all shares. Never charge socialized debt to the
// liquidator. Keep both share conversions and their virtual offsets exact.
function liquidationAmounts(row) {
  const WAD = 10n ** 18n;
  const scale = 10n ** 36n;
  const collateral = BigInt(row.collateralRaw);
  const price = BigInt(row.oraclePriceRaw);
  const lltv = BigInt(row.lltvRaw);
  const assets = BigInt(row.totalBorrowAssetsAccruedRaw);
  const shares = BigInt(row.totalBorrowSharesRaw);
  const borrowerShares = BigInt(row.borrowShares);
  if (lltv < 0n || lltv >= WAD || collateral < 0n || price < 0n || assets < 0n
      || shares < borrowerShares || borrowerShares <= 0n) throw new Error("LIQUIDATION_INPUT_INVALID");
  const incentive = WAD * WAD / (WAD - 300000000000000000n * (WAD - lltv) / WAD);
  const lif = incentive < 1150000000000000000n ? incentive : 1150000000000000000n;
  const toAssetsUp = value => ceilDiv(value * (assets + 1n), shares + 1000000n);
  const fullDebt = toAssetsUp(borrowerShares);
  const quoted = ceilDiv(collateral * price, scale);
  let repaidShares = ceilDiv(ceilDiv(quoted * WAD, lif) * (shares + 1000000n), assets + 1n);
  let seized = collateral;
  if (repaidShares > borrowerShares) {
    repaidShares = borrowerShares;
    const debtDown = repaidShares * (assets + 1n) / (shares + 1000000n);
    seized = price === 0n ? collateral : (debtDown * lif / WAD) * scale / price;
    if (seized > collateral) throw new Error("LIQUIDATION_INPUT_INVALID");
  }
  const repaid = toAssetsUp(repaidShares);
  const remainingAssets = assets > repaid ? assets - repaid : 0n;
  const remainingShares = shares - repaidShares;
  const residual = borrowerShares - repaidShares;
  const badDebt = seized === collateral
    ? ceilDiv(residual * (remainingAssets + 1n), remainingShares + 1000000n) : 0n;
  return {
    seizedCollateralRaw: seized.toString(), repaidDebtRaw: repaid.toString(),
    repaidSharesRaw: repaidShares.toString(), fullDebtRaw: fullDebt.toString(),
    badDebtSocializedRaw: (badDebt < remainingAssets ? badDebt : remainingAssets).toString(),
    liquidationIncentiveFactorRaw: lif.toString(),
  };
}

// Discover the deepest Uniswap V3 pool per direction for every candidate pair.
// Returns a map keyed by `collateral|loan` with optional `direct`/`collateralUsdc`
// /`loanUsdc` entries carrying the chosen fee and pool address.
async function discoverPools(rpc, blockRef, pairs, multicall, venue = VENUES[1]) {
  const entries = [];
  const meta = [];
  for (const pair of pairs) {
    const c = pair.collateralToken.toLowerCase();
    const l = pair.loanToken.toLowerCase();
    for (const fee of FEES) {
      entries.push({ to: venue.factory, data: IFACE.factory.encodeFunctionData("getPool", [c, l, fee]) });
      meta.push({ key: pairKey(c, l), kind: "direct", fee });
      entries.push({ to: venue.factory, data: IFACE.factory.encodeFunctionData("getPool", [c, venue.usdc, fee]) });
      meta.push({ key: pairKey(c, l), kind: "collateralUsdc", fee });
      entries.push({ to: venue.factory, data: IFACE.factory.encodeFunctionData("getPool", [l, venue.usdc, fee]) });
      meta.push({ key: pairKey(c, l), kind: "loanUsdc", fee });
    }
  }
  const found = await multicall(rpc, blockRef, entries);
  const pools = [];
  found.results.forEach((item, index) => {
    if (!item || !item.success) return;
    let decoded; try { decoded = IFACE.factory.decodeFunctionResult("getPool", item.returnData); } catch (_) { return; }
    const pool = decoded[0];
    if (!pool || pool === ethers.ZeroAddress) return;
    pools.push({ ...meta[index], pool: pool.toLowerCase() });
  });
  const liq = await multicall(rpc, blockRef, pools.map((p) => ({ to: p.pool, data: IFACE.liquidity.encodeFunctionData("liquidity", []) })));
  const best = new Map();
  pools.forEach((p, index) => {
    const item = liq.results[index];
    let liquidity = 0n; try { liquidity = IFACE.liquidity.decodeFunctionResult("liquidity", item.returnData)[0]; } catch (_) {}
    if (liquidity <= 0n) return;
    const slot = `${p.key}|${p.kind}`;
    const current = best.get(slot);
    if (!current || liquidity > current.liquidity) best.set(slot, { pool: p.pool, fee: p.fee, liquidity: BigInt(liquidity) });
  });
  const routes = new Map();
  for (const pair of pairs) {
    const key = pairKey(pair.collateralToken, pair.loanToken);
    routes.set(key, {
      direct: best.get(`${key}|direct`) || null,
      collateralUsdc: best.get(`${key}|collateralUsdc`) || null,
      loanUsdc: best.get(`${key}|loanUsdc`) || null,
    });
  }
  return routes;
}

async function quoteMany(rpc, blockRef, jobs, multicall, venue = VENUES[1]) {
  if (!jobs.length) return [];
  const entries = jobs.map((job) => ({
    to: venue.quoter,
    data: IFACE.quoter.encodeFunctionData("quoteExactInputSingle", [{
      tokenIn: job.tokenIn, tokenOut: job.tokenOut, amountIn: job.amountIn, fee: job.fee, sqrtPriceLimitX96: 0n,
    }]),
  }));
  const result = await multicall(rpc, blockRef, entries);
  return result.results.map((item) => {
    if (!item || !item.success) return null;
    try { return BigInt(IFACE.quoter.decodeFunctionResult("quoteExactInputSingle", item.returnData)[0]); }
    catch (_) { return null; }
  });
}

// The swap recipient must be the deployed executor, which is only known inside
// the keyless fork. The producer therefore emits the route as hops+fees and the
// fork scenario encodes the exact router calldata with its own address.
function encodeSwapData({ hops, fees, recipient, amountIn, amountOutMinimum }) {
  if (!Array.isArray(hops) || !Array.isArray(fees) || hops.length !== fees.length + 1) throw new Error("ROUTE_ARITY");
  if (hops.length === 2) {
    return IFACE.router.encodeFunctionData("exactInputSingle", [{
      tokenIn: hops[0], tokenOut: hops[1], fee: fees[0], recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n,
    }]);
  }
  const pathTypes = [];
  const pathValues = [];
  for (let index = 0; index < hops.length; index += 1) {
    pathTypes.push("address");
    pathValues.push(hops[index]);
    if (index < fees.length) { pathTypes.push("uint24"); pathValues.push(fees[index]); }
  }
  const path = ethers.solidityPacked(pathTypes, pathValues);
  return IFACE.router.encodeFunctionData("exactInput", [{ path, recipient, amountIn, amountOutMinimum }]);
}

// Valuate the liquidatable candidate set at one pin. `candidates` rows come from
// classifyPositions (fields: collateralToken, loanToken, collateralRaw,
// borrowedRaw, marketId, borrower, oracle, irm, lltv, oraclePriceRaw).
async function valuate({ rpc, blockRef, baseFeeWei, ethUsdRaw, candidates, priorityFeeWei, multicall, chainId = 1 }) {
  const venue = venueFor(chainId);
  const amounts = new Map(candidates.map(row => [row.key, liquidationAmounts(row)]));
  const pairs = [];
  const seen = new Set();
  for (const row of candidates) {
    const key = pairKey(row.collateralToken, row.loanToken);
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ collateralToken: row.collateralToken, loanToken: row.loanToken });
  }
  const routes = await discoverPools(rpc, blockRef, pairs, multicall, venue);

  // Pass 1: outgoing leg (collateral -> loan, or collateral -> USDC when no
  // direct pool) plus the repay leg (loan -> USDC).
  const pass1Jobs = [];
  const pass1Meta = [];
  for (const row of candidates) {
    const key = pairKey(row.collateralToken, row.loanToken);
    const route = routes.get(key);
    if (!route) continue;
    const loanIsUsdc = row.loanToken.toLowerCase() === venue.usdc.toLowerCase();
    if (route.direct) {
      pass1Jobs.push({ tokenIn: row.collateralToken, tokenOut: row.loanToken, amountIn: BigInt(amounts.get(row.key).seizedCollateralRaw), fee: route.direct.fee });
      pass1Meta.push({ key: row.key, kind: "outLoan" });
    } else if (route.collateralUsdc) {
      pass1Jobs.push({ tokenIn: row.collateralToken, tokenOut: venue.usdc, amountIn: BigInt(amounts.get(row.key).seizedCollateralRaw), fee: route.collateralUsdc.fee });
      pass1Meta.push({ key: row.key, kind: "outUsdc" });
    }
    if (!loanIsUsdc && route.loanUsdc) {
      pass1Jobs.push({ tokenIn: row.loanToken, tokenOut: venue.usdc, amountIn: BigInt(amounts.get(row.key).repaidDebtRaw), fee: route.loanUsdc.fee });
      pass1Meta.push({ key: row.key, kind: "repayUsdc" });
    }
  }
  const pass1 = await quoteMany(rpc, blockRef, pass1Jobs, multicall, venue);
  const quotes = new Map();
  pass1Meta.forEach((meta, index) => {
    const bucket = quotes.get(meta.key) || {};
    bucket[meta.kind] = pass1[index];
    quotes.set(meta.key, bucket);
  });

  // Pass 2: value the realised direct-route loan output through loan/USDC at the
  // exact output size so price impact is not approximated.
  const pass2Jobs = [];
  const pass2Meta = [];
  for (const row of candidates) {
    const key = pairKey(row.collateralToken, row.loanToken);
    const route = routes.get(key);
    if (!route || !route.direct || !route.loanUsdc) continue;
    if (row.loanToken.toLowerCase() === venue.usdc.toLowerCase()) continue;
    const outLoan = (quotes.get(row.key) || {}).outLoan;
    if (outLoan === undefined || outLoan === null) continue;
    pass2Jobs.push({ tokenIn: row.loanToken, tokenOut: venue.usdc, amountIn: outLoan, fee: route.loanUsdc.fee });
    pass2Meta.push({ key: row.key });
  }
  const pass2 = await quoteMany(rpc, blockRef, pass2Jobs, multicall, venue);
  pass2Meta.forEach((meta, index) => {
    const bucket = quotes.get(meta.key) || {};
    bucket.outLoanUsdc = pass2[index];
    quotes.set(meta.key, bucket);
  });

  const priorityFeeWeiValue = priorityFeeWei !== undefined ? priorityFeeWei : undefined;
  const gasCeilingUsdcRaw = economics.gasCeilingUsdcRaw(baseFeeWei, ethUsdRaw, priorityFeeWeiValue);

  const valued = candidates.map((row) => {
    const key = pairKey(row.collateralToken, row.loanToken);
    const route = routes.get(key);
    const q = quotes.get(row.key) || {};
    const loanIsUsdc = row.loanToken.toLowerCase() === venue.usdc.toLowerCase();
    const obligation = amounts.get(row.key);
    const debtRaw = BigInt(obligation.repaidDebtRaw);

    let routeKind = null;
    let outUsdcRaw = null;
    let repaidUsdcRaw = null;
    let haircutBps = 0;
    let hops = null;
    let fees = null;
    const directOut = q.outLoan;
    if (route && route.direct && directOut !== undefined && directOut !== null) {
      if (loanIsUsdc) outUsdcRaw = directOut;
      else if (q.outLoanUsdc !== undefined && q.outLoanUsdc !== null) outUsdcRaw = q.outLoanUsdc;
      repaidUsdcRaw = loanIsUsdc ? debtRaw : q.repayUsdc;
      if (repaidUsdcRaw !== null && repaidUsdcRaw !== undefined && (loanIsUsdc || route.loanUsdc)) {
        routeKind = "univ3-direct";
        haircutBps = HAIRCUT_DIRECT_BPS;
        hops = [row.collateralToken, row.loanToken];
        fees = [route.direct.fee];
      } else {
        outUsdcRaw = null;
      }
    } else if (route && route.collateralUsdc && route.loanUsdc && q.outUsdc !== undefined && q.outUsdc !== null) {
      outUsdcRaw = q.outUsdc;
      repaidUsdcRaw = loanIsUsdc ? debtRaw : q.repayUsdc;
      if (repaidUsdcRaw !== null && repaidUsdcRaw !== undefined) {
        routeKind = "univ3-via-usdc";
        haircutBps = HAIRCUT_TWO_HOP_BPS;
        hops = [row.collateralToken, venue.usdc, row.loanToken];
        fees = [route.collateralUsdc.fee, route.loanUsdc.fee];
      } else {
        outUsdcRaw = null;
      }
    }

    let routePositive = false;
    let valuationStatus = "UNQUALIFIED_ROUTE";
    let netUsdcRaw = null;
    if (routeKind && outUsdcRaw !== null && outUsdcRaw !== undefined && repaidUsdcRaw !== null && repaidUsdcRaw !== undefined) {
      // Suppress-only haircut: applied to the realised output, so it can never
      // create a positive. quoteExecutable stays false until a same-pin keyless
      // fork measures the view-vs-mined divergence for this route.
      const haircut = haircutRaw(outUsdcRaw, haircutBps);
      const adjustedOut = outUsdcRaw > haircut ? outUsdcRaw - haircut : 0n;
      netUsdcRaw = adjustedOut - repaidUsdcRaw - gasCeilingUsdcRaw;
      routePositive = netUsdcRaw > 0n;
      valuationStatus = "QUALIFIED_VIEW";
    }

    return {
      eventKey: row.key, marketId: String(row.marketId).toLowerCase(), borrower: String(row.borrower).toLowerCase(),
      collateralToken: String(row.collateralToken).toLowerCase(), loanToken: String(row.loanToken).toLowerCase(),
      ...obligation,
      oracle: String(row.oracle).toLowerCase(), irm: String(row.irm).toLowerCase(), lltvRaw: row.lltvRaw, oraclePriceRaw: row.oraclePriceRaw,
      unwindRoute: routeKind,
      expectedOutUsdcRaw: outUsdcRaw === null || outUsdcRaw === undefined ? null : outUsdcRaw.toString(),
      repaidUsdcRaw: repaidUsdcRaw === null || repaidUsdcRaw === undefined ? null : repaidUsdcRaw.toString(),
      gasCeilingUsdcRaw: gasCeilingUsdcRaw.toString(),
      netUsdcRaw: netUsdcRaw === null ? null : netUsdcRaw.toString(),
      haircutBps,
      quoteExecutable: QUOTE_EXECUTABLE,
      probeStatus: routePositive ? "PENDING_KEYLESS_FORK" : "NOT_REQUIRED",
      routePositive,
      valuationStatus,
      swapTarget: routeKind ? venue.router.toLowerCase() : null,
      swapData: null,
      swapHops: (hops || []).map((value) => String(value).toLowerCase()),
      swapFees: fees || [],
      minLoanOutRaw: routeKind ? obligation.repaidDebtRaw : null,
    };
  });

  const qualified = valued.filter((row) => row.routePositive).length;
  const routed = valued.filter((row) => row.valuationStatus === "QUALIFIED_VIEW").length;
  const pairSummary = pairs.map((pair) => {
    const key = pairKey(pair.collateralToken, pair.loanToken);
    const route = routes.get(key);
    return {
      collateralToken: pair.collateralToken, loanToken: pair.loanToken,
      direct: route.direct ? { pool: route.direct.pool, fee: route.direct.fee, liquidity: route.direct.liquidity.toString() } : null,
      collateralUsdc: route.collateralUsdc ? { pool: route.collateralUsdc.pool, fee: route.collateralUsdc.fee, liquidity: route.collateralUsdc.liquidity.toString() } : null,
      loanUsdc: route.loanUsdc ? { pool: route.loanUsdc.pool, fee: route.loanUsdc.fee, liquidity: route.loanUsdc.liquidity.toString() } : null,
    };
  });
  return {
    routes: pairSummary,
    candidates: valued,
    gasCeilingUsdcRaw: gasCeilingUsdcRaw.toString(),
    summary: { pairs: pairs.length, candidates: valued.length, routed, qualified, unknown: valued.length - routed },
  };
}

module.exports = {
  UNIV3_FACTORY, UNIV3_QUOTER_V2, UNIV3_SWAP_ROUTER_02, USDC, WETH, USDC_DECIMALS, FEES,
  VENUES, venueFor,
  HAIRCUT_DIRECT_BPS, HAIRCUT_TWO_HOP_BPS, QUOTE_EXECUTABLE, IFACE,
  ceilDiv, haircutRaw, pairKey, liquidationAmounts, discoverPools, quoteMany, encodeSwapData, valuate,
};
