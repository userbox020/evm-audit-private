#!/usr/bin/env node
// Read-only E12x candidate route scorer.
// RPC URLs are read locally and never printed or written.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "e12x-route-dry-runs.json");
const TIMEOUT_MS = 15_000;

const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const FEES = [100, 500, 3000, 10000];
const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const FLASH_COLLATERAL_HUMAN = Number(process.env.E12X_DRY_RUN_FLASH_COLLATERAL || "0.5");
const BORROW_BUFFER_BPS = BigInt(process.env.E12X_DRY_RUN_BORROW_BUFFER_BPS || "9000");
const BALANCER_FEE_BPS = BigInt(process.env.E12X_BALANCER_FEE_BPS || "1");
const GAS_USED = Number(process.env.E12X_DRY_RUN_GAS_USED || "3000000");
const MIN_DIVERGENCE_PCT = Number(process.env.E12X_DRY_RUN_MIN_DIVERGENCE_PCT || "5");
const MIN_NET_PROFIT_USD = Number(process.env.E12X_DRY_RUN_MIN_NET_PROFIT_USD || "25");

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const FACTORY = new ethers.Interface(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)"]);
const QUOTER = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const MORPHO = new ethers.Interface([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
]);
const ORACLE = new ethers.Interface(["function price() view returns (uint256)"]);
const ABI = ethers.AbiCoder.defaultAbiCoder();

const CHAINS = [
  {
    chainId: 8453,
    name: "Base",
    coinSlug: "base",
    morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    stable: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    collaterals: [
      "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", // wstETH
      "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", // cbETH
    ],
  },
  {
    chainId: 42161,
    name: "Arbitrum",
    coinSlug: "arbitrum",
    morpho: "0x6c247b1F6182318877311737BaC0844bAa518F5e",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    wrappedNative: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
    stable: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    collaterals: [
      "0x5979D7b546E38E414F7E9822514be443A4800529", // wstETH
      "0x1DEBd73E752bEaF79865Fd6446b0c970EaE7732f", // cbETH
      "0xEC70Dcb4A1EFa46b8F2D97C310C9C4790ba5ffA8", // rETH
    ],
  },
];

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function loadRpcUrls() {
  const text = fs.readFileSync(RPC_FILE, "utf8");
  return [...text.matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const json = await res.json();
    return json.result ?? null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcPool(chainIds) {
  const urls = loadRpcUrls();
  const pool = {};
  for (const url of urls) {
    const idHex = await rpcCall(url, "eth_chainId", [], 6000);
    if (!idHex) continue;
    const chainId = parseInt(idHex, 16);
    if (chainIds.includes(chainId) && !pool[chainId]) pool[chainId] = url;
  }
  return pool;
}

async function safeCall(provider, to, data) {
  try { return await provider.call({ to: String(to), data }); }
  catch (_) { return null; }
}

async function fetchJson(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMorphoMarkets(chain) {
  const query = `query($chainIds:[Int!]!, $collaterals:[String!]!) {
    markets(first:100, orderBy:SupplyAssetsUsd, orderDirection:Desc,
      where:{chainId_in:$chainIds, collateralAssetAddress_in:$collaterals, supplyAssetsUsd_gte:1}) {
      items {
        marketId
        creationTimestamp
        loanAsset { symbol address decimals }
        collateralAsset { symbol address decimals }
        oracle { address }
        irmAddress
        lltv
        state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization }
      }
    }
  }`;
  const body = JSON.stringify({
    query,
    variables: { chainIds: [chain.chainId], collaterals: chain.collaterals.map((a) => a.toLowerCase()) },
  });
  const json = await fetchJson("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    timeoutMs: 30_000,
  });
  if (json.errors) throw new Error(json.errors[0]?.message || "Morpho GraphQL error");
  return json.data?.markets?.items || [];
}

async function fetchCoinPrices(chains, marketsByChain) {
  const keys = [];
  for (const chain of chains) {
    keys.push(`${chain.coinSlug}:${chain.wrappedNative}`);
    keys.push(`${chain.coinSlug}:${chain.stable}`);
    for (const c of chain.collaterals) keys.push(`${chain.coinSlug}:${c}`);
    for (const market of marketsByChain[chain.chainId] || []) {
      keys.push(`${chain.coinSlug}:${market.loanAsset.address}`);
      keys.push(`${chain.coinSlug}:${market.collateralAsset.address}`);
    }
  }
  const uniq = [...new Set(keys.map((k) => k.toLowerCase()))];
  const out = {};
  for (let i = 0; i < uniq.length; i += 50) {
    const url = `https://coins.llama.fi/prices/current/${uniq.slice(i, i + 50).join(",")}?searchWidth=6h`;
    const json = await fetchJson(url, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    Object.assign(out, json.coins || {});
  }
  return out;
}

function priceOf(prices, chain, token) {
  const coin = prices[`${chain.coinSlug}:${String(token).toLowerCase()}`];
  const price = Number(coin?.price || 0);
  return Number.isFinite(price) && price > 0 ? price : 0;
}

function marketId(market) {
  return ethers.keccak256(ABI.encode(
    ["address", "address", "address", "address", "uint256"],
    [market.loanAsset.address, market.collateralAsset.address, market.oracle.address, market.irmAddress, BigInt(market.lltv)]
  ));
}

function parseUnitsFromNumber(value, decimals) {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  const places = Math.min(Math.max(Number(decimals) || 18, 0), 18);
  return ethers.parseUnits(value.toFixed(places), Number(decimals) || 18);
}

function formatUnitsNumber(value, decimals) {
  return Number(ethers.formatUnits(value < 0n ? 0n : value, Number(decimals) || 18));
}

function mulDivDown(x, y, d) {
  return d === 0n ? 0n : x * y / d;
}

async function tokenBalance(provider, token, account) {
  const raw = await safeCall(provider, token, ERC20.encodeFunctionData("balanceOf", [account]));
  if (!raw) return 0n;
  try { return ERC20.decodeFunctionResult("balanceOf", raw)[0]; }
  catch (_) { return 0n; }
}

async function findBestQuote(provider, chain, tokenIn, tokenOut, amountIn) {
  let best = null;
  for (const fee of FEES) {
    const poolRaw = await safeCall(provider, chain.factory, FACTORY.encodeFunctionData("getPool", [tokenIn, tokenOut, fee]));
    if (!poolRaw) continue;
    let pool = ethers.ZeroAddress;
    try { [pool] = FACTORY.decodeFunctionResult("getPool", poolRaw); } catch (_) { continue; }
    if (!pool || pool === ethers.ZeroAddress) continue;
    try {
      const quoteRaw = await provider.call({
        to: chain.quoter,
        data: QUOTER.encodeFunctionData("quoteExactInputSingle", [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 }]),
      });
      const [amountOut, , , gasEstimate] = QUOTER.decodeFunctionResult("quoteExactInputSingle", quoteRaw);
      if (!best || amountOut > best.amountOutRaw) best = { fee, pool, amountOutRaw: amountOut, gasEstimate };
    } catch (_) {}
  }
  return best;
}

async function scoreMarket(provider, chain, market, prices, gasPrice) {
  const blockers = [];
  const loanDecimals = Number(market.loanAsset.decimals || 18);
  const collateralDecimals = Number(market.collateralAsset.decimals || 18);
  const requestedFlashCollateral = parseUnitsFromNumber(FLASH_COLLATERAL_HUMAN, collateralDecimals);
  const sizingNotes = [];
  const loanPriceUsd = priceOf(prices, chain, market.loanAsset.address);
  const collateralPriceUsd = priceOf(prices, chain, market.collateralAsset.address);
  const nativePriceUsd = priceOf(prices, chain, chain.wrappedNative);
  if (!(loanPriceUsd > 0)) blockers.push("missing DeFiLlama loan price");
  if (!(collateralPriceUsd > 0)) blockers.push("missing DeFiLlama collateral price");
  if (!(nativePriceUsd > 0)) blockers.push("missing DeFiLlama native price");

  const id = marketId(market);
  const [oracleRaw, morphoRaw, balancerCollateral] = await Promise.all([
    safeCall(provider, market.oracle.address, ORACLE.encodeFunctionData("price", [])),
    safeCall(provider, chain.morpho, MORPHO.encodeFunctionData("market", [id])),
    tokenBalance(provider, market.collateralAsset.address, BALANCER_VAULT),
  ]);
  if (!oracleRaw) blockers.push("missing Morpho oracle price");
  if (!morphoRaw) blockers.push("missing Morpho market state");

  let oraclePrice = 0n;
  let marketAvailableLoan = 0n;
  if (oracleRaw) {
    try { [oraclePrice] = ORACLE.decodeFunctionResult("price", oracleRaw); } catch (_) { blockers.push("oracle decode failed"); }
  }
  if (morphoRaw) {
    try {
      const [totalSupplyAssets, , totalBorrowAssets] = MORPHO.decodeFunctionResult("market", morphoRaw);
      marketAvailableLoan = totalSupplyAssets > totalBorrowAssets ? totalSupplyAssets - totalBorrowAssets : 0n;
    } catch (_) { blockers.push("market decode failed"); }
  }
  if (oraclePrice <= 0n) blockers.push("invalid oracle price");
  if (marketAvailableLoan <= 0n) blockers.push("no Morpho loan liquidity");

  const priceScaleDecimals = 36 + loanDecimals - collateralDecimals;
  const acceptedLoanPerCollateral = oraclePrice > 0n ? Number(oraclePrice) / (10 ** priceScaleDecimals) : 0;
  const acceptedCollateralUsd = acceptedLoanPerCollateral * loanPriceUsd;
  const divergencePct = collateralPriceUsd > 0
    ? ((acceptedCollateralUsd - collateralPriceUsd) / collateralPriceUsd) * 100
    : 0;
  if (divergencePct <= 0) blockers.push("oracle accepts collateral at or below live price");
  else if (divergencePct < MIN_DIVERGENCE_PCT) blockers.push(`positive divergence below ${MIN_DIVERGENCE_PCT}%`);

  let flashCollateral = requestedFlashCollateral;
  if (balancerCollateral < requestedFlashCollateral) {
    flashCollateral = balancerCollateral * 95n / 100n;
    sizingNotes.push("scaled flash to 95% of Balancer collateral");
  }
  if (flashCollateral <= 0n) blockers.push("no Balancer collateral liquidity");
  const maxBorrow = mulDivDown(mulDivDown(flashCollateral, oraclePrice, ORACLE_PRICE_SCALE), BigInt(market.lltv), WAD);
  const targetBorrow = maxBorrow * BORROW_BUFFER_BPS / 10_000n;
  const marketCappedBorrow = marketAvailableLoan * 99n / 100n;
  const borrowAmount = targetBorrow < marketCappedBorrow ? targetBorrow : marketCappedBorrow;
  if (borrowAmount <= 0n) blockers.push("zero borrow sizing");

  let quote = null;
  if (borrowAmount > 0n) {
    quote = await findBestQuote(provider, chain, market.loanAsset.address, market.collateralAsset.address, borrowAmount);
    if (!quote) blockers.push("missing Uniswap V3 loan->collateral quote");
  }

  const expectedCollateralOut = quote?.amountOutRaw || 0n;
  const flashFee = flashCollateral * BALANCER_FEE_BPS / 10_000n;
  const repaymentCollateral = flashCollateral + flashFee;
  const repaymentShortfall = expectedCollateralOut >= repaymentCollateral ? 0n : repaymentCollateral - expectedCollateralOut;
  const swapOutputVsRepayBps = repaymentCollateral > 0n ? Number((expectedCollateralOut * 10_000n / repaymentCollateral) - 10_000n) : null;
  if (quote && expectedCollateralOut < repaymentCollateral) blockers.push("swap output below flash repayment");
  const netCollateral = expectedCollateralOut > repaymentCollateral ? expectedCollateralOut - repaymentCollateral : 0n;
  const gasUsd = nativePriceUsd > 0 ? GAS_USED * Number(gasPrice || 0n) / 1e18 * nativePriceUsd : 0;
  const netProfitUsd = formatUnitsNumber(netCollateral, collateralDecimals) * collateralPriceUsd - gasUsd;
  const repaymentShortfallUsd = formatUnitsNumber(repaymentShortfall, collateralDecimals) * collateralPriceUsd;
  const netGapToMinProfitUsd = Math.max(0, MIN_NET_PROFIT_USD - netProfitUsd);
  if (!(netProfitUsd >= MIN_NET_PROFIT_USD)) blockers.push(`net profit below $${MIN_NET_PROFIT_USD}`);

  return {
    chainId: chain.chainId,
    chain: chain.name,
    marketId: market.marketId,
    createdAt: new Date(Number(market.creationTimestamp) * 1000).toISOString(),
    loan: { symbol: market.loanAsset.symbol, address: market.loanAsset.address, decimals: loanDecimals, priceUsd: loanPriceUsd },
    collateral: { symbol: market.collateralAsset.symbol, address: market.collateralAsset.address, decimals: collateralDecimals, priceUsd: collateralPriceUsd },
    oracle: market.oracle.address,
    irm: market.irmAddress,
    lltvPct: Number(market.lltv) / 1e16,
    morphoLiquidityUsd: Number(market.state?.liquidityAssetsUsd || 0),
    acceptedCollateralUsd,
    divergencePct,
    balancerCollateral: balancerCollateral.toString(),
    marketAvailableLoan: marketAvailableLoan.toString(),
    requestedFlashCollateral: requestedFlashCollateral.toString(),
    flashCollateral: flashCollateral.toString(),
    sizingNotes,
    borrowAmount: borrowAmount.toString(),
    quote: quote ? { fee: quote.fee, pool: quote.pool, amountOut: quote.amountOutRaw.toString(), gasEstimate: quote.gasEstimate.toString() } : null,
    repaymentCollateral: repaymentCollateral.toString(),
    repaymentShortfall: repaymentShortfall.toString(),
    repaymentShortfallUsd,
    swapOutputVsRepayBps,
    gasUsd,
    netProfitUsd,
    netGapToMinProfitUsd,
    routePositive: blockers.length === 0,
    autoExecutable: false,
    blockers,
  };
}

function compactCandidate(c) {
  if (!c) return null;
  return {
    chainId: c.chainId,
    chain: c.chain,
    marketId: c.marketId,
    loan: c.loan?.symbol || null,
    collateral: c.collateral?.symbol || null,
    lltvPct: c.lltvPct,
    morphoLiquidityUsd: c.morphoLiquidityUsd,
    acceptedCollateralUsd: c.acceptedCollateralUsd,
    collateralPriceUsd: c.collateral?.priceUsd || null,
    divergencePct: c.divergencePct,
    flashCollateral: c.flashCollateral,
    borrowAmount: c.borrowAmount,
    quote: c.quote ? { fee: c.quote.fee, pool: c.quote.pool, gasEstimate: c.quote.gasEstimate } : null,
    repaymentShortfallUsd: c.repaymentShortfallUsd,
    swapOutputVsRepayBps: c.swapOutputVsRepayBps,
    gasUsd: c.gasUsd,
    netProfitUsd: c.netProfitUsd,
    netGapToMinProfitUsd: c.netGapToMinProfitUsd,
    routePositive: c.routePositive,
    blockers: c.blockers,
  };
}

function asBigInt(value) {
  try { return BigInt(value || 0); }
  catch (_) { return 0n; }
}

function maxBy(items, scoreFn) {
  let best = null;
  let bestScore = -Infinity;
  for (const item of items) {
    const score = Number(scoreFn(item));
    if (!Number.isFinite(score)) continue;
    if (!best || score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

function summarizeCandidates(candidates) {
  const blockerCounts = {};
  const hasPositiveDivergence = (c) => Number(c.divergencePct || 0) > 0;
  const hasLoanLiquidity = (c) => Number(c.morphoLiquidityUsd || 0) > 0 && asBigInt(c.marketAvailableLoan) > 0n;
  const hasFlashLiquidity = (c) => asBigInt(c.flashCollateral) > 0n;
  const hasBorrowSizing = (c) => asBigInt(c.borrowAmount) > 0n;
  const missingQuote = (c) => c.blockers?.includes("missing Uniswap V3 loan->collateral quote");
  const coversRepayment = (c) => Boolean(c.quote) && asBigInt(c.repaymentShortfall) === 0n;

  for (const c of candidates) {
    for (const blocker of c.blockers || []) blockerCounts[blocker] = (blockerCounts[blocker] || 0) + 1;
  }

  const positiveDivergenceRows = candidates.filter(hasPositiveDivergence);
  const positiveDivergenceWithLiquidityRows = positiveDivergenceRows.filter((c) => hasLoanLiquidity(c) && hasFlashLiquidity(c) && hasBorrowSizing(c));
  const positiveDivergenceWithQuoteRows = positiveDivergenceRows.filter((c) => Boolean(c.quote));
  const quotedRows = candidates.filter((c) => Boolean(c.quote));
  return {
    totalRows: candidates.length,
    routePositiveRows: candidates.filter((c) => c.routePositive).length,
    positiveDivergenceRows: positiveDivergenceRows.length,
    positiveDivergenceWithLiquidityRows: positiveDivergenceWithLiquidityRows.length,
    positiveDivergenceWithQuoteRows: positiveDivergenceWithQuoteRows.length,
    quotedRows: quotedRows.length,
    missingQuoteRows: candidates.filter(missingQuote).length,
    missingQuoteWithPositiveDivergenceRows: positiveDivergenceRows.filter(missingQuote).length,
    swapOutputCoversRepaymentRows: candidates.filter(coversRepayment).length,
    netProfitPositiveRows: candidates.filter((c) => Number(c.netProfitUsd || 0) > 0).length,
    blockerCounts,
    bestPositiveDivergenceWithLiquidityCandidate: compactCandidate(maxBy(positiveDivergenceWithLiquidityRows, (c) => Number(c.divergencePct || 0))),
    bestPositiveDivergenceWithQuoteCandidate: compactCandidate(maxBy(positiveDivergenceWithQuoteRows, (c) => Number(c.divergencePct || 0))),
    bestQuotedNetCandidate: compactCandidate(maxBy(quotedRows, (c) => Number(c.netProfitUsd || -1e18))),
  };
}

function mergeDiagnostics(chains) {
  const out = {
    totalRows: 0,
    routePositiveRows: 0,
    positiveDivergenceRows: 0,
    positiveDivergenceWithLiquidityRows: 0,
    positiveDivergenceWithQuoteRows: 0,
    quotedRows: 0,
    missingQuoteRows: 0,
    missingQuoteWithPositiveDivergenceRows: 0,
    swapOutputCoversRepaymentRows: 0,
    netProfitPositiveRows: 0,
    blockerCounts: {},
    bestPositiveDivergenceWithLiquidityCandidate: null,
    bestPositiveDivergenceWithQuoteCandidate: null,
    bestQuotedNetCandidate: null,
  };
  for (const chain of chains) {
    const d = chain.routeDiagnostics;
    if (!d) continue;
    for (const key of ["totalRows", "routePositiveRows", "positiveDivergenceRows", "positiveDivergenceWithLiquidityRows", "positiveDivergenceWithQuoteRows", "quotedRows", "missingQuoteRows", "missingQuoteWithPositiveDivergenceRows", "swapOutputCoversRepaymentRows", "netProfitPositiveRows"]) {
      out[key] += Number(d[key] || 0);
    }
    for (const [blocker, count] of Object.entries(d.blockerCounts || {})) out.blockerCounts[blocker] = (out.blockerCounts[blocker] || 0) + Number(count || 0);
    if (d.bestPositiveDivergenceWithLiquidityCandidate && Number(d.bestPositiveDivergenceWithLiquidityCandidate.divergencePct || 0) > Number(out.bestPositiveDivergenceWithLiquidityCandidate?.divergencePct || 0)) out.bestPositiveDivergenceWithLiquidityCandidate = d.bestPositiveDivergenceWithLiquidityCandidate;
    if (d.bestPositiveDivergenceWithQuoteCandidate && Number(d.bestPositiveDivergenceWithQuoteCandidate.divergencePct || 0) > Number(out.bestPositiveDivergenceWithQuoteCandidate?.divergencePct || 0)) out.bestPositiveDivergenceWithQuoteCandidate = d.bestPositiveDivergenceWithQuoteCandidate;
    if (d.bestQuotedNetCandidate && Number(d.bestQuotedNetCandidate.netProfitUsd || -1e18) > Number(out.bestQuotedNetCandidate?.netProfitUsd || -1e18)) out.bestQuotedNetCandidate = d.bestQuotedNetCandidate;
  }
  return out;
}

async function main() {
  const pool = await resolveRpcPool(CHAINS.map((c) => c.chainId));
  const marketsByChain = {};
  for (const chain of CHAINS) marketsByChain[chain.chainId] = await fetchMorphoMarkets(chain);
  const prices = await fetchCoinPrices(CHAINS, marketsByChain);

  const chains = [];
  for (const chain of CHAINS) {
    const rpc = pool[chain.chainId];
    if (!rpc) {
      chains.push({ chainId: chain.chainId, name: chain.name, error: "missing RPC", candidates: [] });
      continue;
    }
    const provider = new ethers.JsonRpcProvider(rpc);
    const gasPrice = await provider.send("eth_gasPrice", []).then(BigInt).catch(() => 0n);
    const candidates = [];
    for (const market of (marketsByChain[chain.chainId] || []).slice(0, 40)) {
      candidates.push(await scoreMarket(provider, chain, market, prices, gasPrice));
    }
    candidates.sort((a, b) => Number(b.netProfitUsd || -1e9) - Number(a.netProfitUsd || -1e9));
    const topDivergenceCandidates = candidates
      .slice()
      .sort((a, b) => Math.abs(Number(b.divergencePct || 0)) - Math.abs(Number(a.divergencePct || 0)))
      .slice(0, 10)
      .map(compactCandidate);
    const topPositiveDivergenceCandidates = candidates
      .filter((c) => Number(c.divergencePct || 0) > 0)
      .sort((a, b) => Number(b.divergencePct || 0) - Number(a.divergencePct || 0))
      .slice(0, 10)
      .map(compactCandidate);
    const topNearPositiveCandidates = candidates
      .slice()
      .sort((a, b) => Number(a.netGapToMinProfitUsd ?? 1e18) - Number(b.netGapToMinProfitUsd ?? 1e18)
        || Number(a.repaymentShortfallUsd ?? 1e18) - Number(b.repaymentShortfallUsd ?? 1e18)
        || Math.abs(Number(b.divergencePct || 0)) - Math.abs(Number(a.divergencePct || 0)))
      .slice(0, 10)
      .map(compactCandidate);
    const maxAbsDivergence = candidates.reduce((max, c) => Math.max(max, Math.abs(Number(c.divergencePct || 0))), 0);
    const maxPositiveDivergence = candidates.reduce((max, c) => Math.max(max, Number(c.divergencePct || 0)), 0);
    const maxNegativeDivergence = candidates.reduce((min, c) => Math.min(min, Number(c.divergencePct || 0)), 0);
    const bestLiquidity = candidates.reduce((max, c) => Math.max(max, Number(c.morphoLiquidityUsd || 0)), 0);
    chains.push({
      chainId: chain.chainId,
      name: chain.name,
      morpho: chain.morpho,
      candidateCount: candidates.length,
      positiveCount: candidates.filter((c) => c.routePositive).length,
      maxAbsDivergencePct: maxAbsDivergence,
      maxPositiveDivergencePct: maxPositiveDivergence,
      maxNegativeDivergencePct: maxNegativeDivergence,
      bestMorphoLiquidityUsd: bestLiquidity,
      bestNetProfitUsd: candidates[0]?.netProfitUsd ?? null,
      topCandidates: candidates.slice(0, 15),
      topDivergenceCandidates,
      topPositiveDivergenceCandidates,
      topNearPositiveCandidates,
      routeDiagnostics: summarizeCandidates(candidates),
    });
  }

  const summary = chains.reduce((acc, chain) => {
    acc.candidateCount += Number(chain.candidateCount || 0);
    acc.positiveCount += Number(chain.positiveCount || 0);
    acc.maxAbsDivergencePct = Math.max(acc.maxAbsDivergencePct, Number(chain.maxAbsDivergencePct || 0));
    acc.maxPositiveDivergencePct = Math.max(acc.maxPositiveDivergencePct, Number(chain.maxPositiveDivergencePct || 0));
    acc.maxNegativeDivergencePct = Math.min(acc.maxNegativeDivergencePct, Number(chain.maxNegativeDivergencePct || 0));
    acc.bestMorphoLiquidityUsd = Math.max(acc.bestMorphoLiquidityUsd, Number(chain.bestMorphoLiquidityUsd || 0));
    const net = Number(chain.bestNetProfitUsd);
    if (Number.isFinite(net) && (acc.bestNetProfitUsd === null || net > acc.bestNetProfitUsd)) acc.bestNetProfitUsd = net;
    const topDivergence = chain.topDivergenceCandidates?.[0];
    if (topDivergence && Math.abs(Number(topDivergence.divergencePct || 0)) > Math.abs(Number(acc.maxDivergenceCandidate?.divergencePct || 0))) {
      acc.maxDivergenceCandidate = topDivergence;
    }
    const topPositiveDivergence = chain.topPositiveDivergenceCandidates?.[0];
    if (topPositiveDivergence && Number(topPositiveDivergence.divergencePct || 0) > Number(acc.maxPositiveDivergenceCandidate?.divergencePct || 0)) {
      acc.maxPositiveDivergenceCandidate = topPositiveDivergence;
    }
    const topNearPositive = chain.topNearPositiveCandidates?.[0];
    if (topNearPositive && (acc.nearestPositiveCandidate === null || Number(topNearPositive.netGapToMinProfitUsd ?? 1e18) < Number(acc.nearestPositiveCandidate.netGapToMinProfitUsd ?? 1e18))) {
      acc.nearestPositiveCandidate = topNearPositive;
    }
    return acc;
  }, { candidateCount: 0, positiveCount: 0, maxAbsDivergencePct: 0, maxPositiveDivergencePct: 0, maxNegativeDivergencePct: 0, bestMorphoLiquidityUsd: 0, bestNetProfitUsd: null, maxDivergenceCandidate: null, maxPositiveDivergenceCandidate: null, nearestPositiveCandidate: null });
  summary.routePositive = summary.positiveCount;
  summary.autoExecutable = false;
  summary.signedActionJustified = false;
  summary.routeDiagnostics = mergeDiagnostics(chains);

  const output = {
    generatedAt: new Date().toISOString(),
    scope: "E12x read-only route-positive dry-run scoring",
    safety: "No signed calls. autoExecutable=false for every non-Ethereum candidate until per-chain deployment, bytecode verification, artifact gates, and explicit authorization exist.",
    thresholds: {
      flashCollateralHuman: FLASH_COLLATERAL_HUMAN,
      borrowBufferBps: Number(BORROW_BUFFER_BPS),
      minDivergencePct: MIN_DIVERGENCE_PCT,
      minNetProfitUsd: MIN_NET_PROFIT_USD,
      gasUsed: GAS_USED,
    },
    summary,
    chains,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, jsonReplacer, 2));

  console.log("E12x route-positive dry-run scan");
  for (const chain of chains) {
    const top = chain.topCandidates?.[0];
    const topText = top ? `${top.loan.symbol}/${top.collateral.symbol} net=$${Math.round(top.netProfitUsd)} blockers=${top.blockers.length}` : "none";
    console.log(`${chain.name}: candidates=${chain.candidateCount || 0} positive=${chain.positiveCount || 0} top=${topText}`);
  }
  console.log(`Report: ${path.relative(WORKSPACE, OUT_FILE)}`);
}

main().catch((e) => {
  console.error(`scan failed: ${e.shortMessage || e.message}`);
  process.exit(1);
});
