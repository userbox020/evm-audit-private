#!/usr/bin/env node
"use strict";

// Per-candidate Euler EVK (Euler V2) liquidation-economics valuator.
//
// Consumes the fresh surface produced by tools/scan-euler-l.js
// (reports/raw/fast/euler-l.json) and values the top-N Liquidate events with
// Euler's own liquidation math (fix-14 anchors):
//
//   * discount (Liquidation.sol:139-147):
//       discountFactor = collateralAdjustedValue * 1e18 / liabilityValue
//       discount       = min(maxLiquidationDiscount, 1 - collateral/liability)
//     implemented with the event's own mid-point oracle quotes,
//   * take-over-debt (Liquidation.sol:195) and collateral transfer
//     (Liquidation.sol:213) define the liquidator's repay/yield legs,
//   * mid-point pricing shapes (LiquidityUtils.sol:97-120):
//       collateral value = oracle.getQuote(balance, collateral, uoa)
//                          * liquidationLTV / CONFIG_SCALE
//       liability value  = oracle.getQuote(owedAssets, asset, uoa)
//
// and mirrors tools/morpho-unwind-valuation.js for the Uniswap V3 QuoterV2
// exit-swap depth bound (per-collateral top fee-tier pool, bounded <= 240 quote
// reads) and the conservative suppress-only haircut.
//
// Read-only. No signing, no transactions, no broadcasts. No external price API
// (no fetchPrice): every price comes from the Euler on-chain oracle or the
// Uniswap V3 quoter at the pinned block. RPC material stays process-only and is
// never printed or persisted. Nothing is fabricated: a row with missing
// oracle/quote/route data is UNQUALIFIED_ROUTE with null values.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc, loadRpcUrls } = require("./shared-rpc");
const economics = require("./frax-usdc-cross-venue-economics");

const WORKSPACE = path.resolve(__dirname, "..");
const SURFACE_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "euler-l.json");
const ARTIFACT_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "euler-l-valuation.json");
const CSV_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "euler-l-valuation.csv");

const ARTIFACT_SCHEMA = "euler-l-valuation/v1";
const SURFACE_SCHEMA = "euler-l-observation/v1";
const CHAIN_ID = 1;
const SCANNER = "tools/calc-euler-l-valuation.js";

const UNIV3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNIV3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const UNIV3_SWAP_ROUTER_02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETH_USD_FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const USDC_DECIMALS = 6;
const FEES = Object.freeze([100, 500, 3000, 10000]);

const CONFIG_SCALE = 10_000n;
const WAD = 10n ** 18n;
const PERIPHERY_DEFAULT_DISCOUNT_RAW = 1500n; // euler-periphery EdgeFactory MAX_LIQ_DISCOUNT = 0.15e4

const MAX_CANDIDATES = 200;
const QUOTE_BUDGET = 240;
const MAX_VAULTS_PER_SWEEP = 40;
const HAIRCUT_DIRECT_BPS = 25;
const HAIRCUT_TWO_HOP_BPS = 100;
const QUOTE_EXECUTABLE = false;

const TIMEOUT_MS = 30_000;
const MC_BATCH = 200;
const MC_CONCURRENCY = 4;

const IFACE = Object.freeze({
  oracle: new ethers.Interface(["function getQuote(uint256 inAmount,address base,address quote) view returns (uint256)"]),
  governance: new ethers.Interface(["function maxLiquidationDiscount() view returns (uint16)"]),
  factory: new ethers.Interface(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)"]),
  liquidity: new ethers.Interface(["function liquidity() view returns (uint128)"]),
  quoter: new ethers.Interface([
    "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
  ]),
  multicall: new ethers.Interface(["function aggregate3((address target,bool allowFailure,bytes callData)[]) payable returns ((bool success,bytes returnData)[])"]),
  chainlink: new ethers.Interface([
    "function decimals() view returns (uint8)",
    "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  ]),
  erc4626: new ethers.Interface([
    "function asset() view returns (address)",
    "function convertToAssets(uint256 shares) view returns (uint256 assets)",
  ]),
});

class ScanFailure extends Error {
  constructor(code) { super(code); this.name = "ScanFailure"; this.code = code; }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function lower(value) { try { return ethers.getAddress(String(value)).toLowerCase(); } catch (_) { return null; } }
function relPosix(target) { return path.relative(WORKSPACE, target).split(path.sep).join("/"); }
function canonicalHash(value) { return `0x${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function ceilDiv(a, b) { return (a + b - 1n) / b; }
function haircutRaw(amount, bps) { return bps <= 0 ? 0n : ceilDiv(amount * BigInt(bps), 10_000n); }
function pairKey(a, b) { return `${String(a).toLowerCase()}|${String(b).toLowerCase()}`; }
function decodeOrNull(iface, fn, returnData) {
  try { return iface.decodeFunctionResult(fn, returnData); } catch (_) { return null; }
}

async function call(rpc, method, params, ms = TIMEOUT_MS, attempts = 6) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await rpcCall(rpc, method, params, ms);
    if (result !== null && result !== undefined) return result;
    last = result;
    if (attempt < attempts - 1) await sleep(250 * (attempt + 1));
  }
  void last;
  throw new ScanFailure("RPC_READ_FAILED");
}

async function resolveWorkingRpc(chainId) {
  const first = await resolveRpc(chainId);
  const candidates = [];
  if (first) candidates.push(first);
  try { for (const url of loadRpcUrls({ maxCandidates: 40 })) if (!candidates.includes(url)) candidates.push(url); } catch (_) {}
  for (const url of candidates.slice(0, 20)) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
    try {
      const chainRaw = await rpcCall(url, "eth_chainId", [], 6000);
      if (!chainRaw || Number(BigInt(chainRaw)) !== chainId) continue;
      const block = await rpcCall(url, "eth_getBlockByNumber", ["finalized", false], 12_000);
      if (block && block.number && block.hash) return url;
    } catch (_) { /* try next */ }
  }
  return first;
}

async function multicall(rpc, blockTag, entries) {
  const results = new Array(entries.length);
  const batches = [];
  for (let i = 0; i < entries.length; i += MC_BATCH) batches.push(i);
  let cursor = 0;
  let failures = 0;
  const worker = async () => {
    while (true) {
      const start = batches[cursor++];
      if (start === undefined) return;
      const batch = entries.slice(start, start + MC_BATCH);
      let decoded = null;
      for (let attempt = 0; attempt < 3 && decoded === null; attempt += 1) {
        try {
          const tuples = batch.map((e) => ({ target: e.to, allowFailure: true, callData: e.data }));
          const data = IFACE.multicall.encodeFunctionData("aggregate3", [tuples]);
          const raw = await call(rpc, "eth_call", [{ to: MULTICALL3, data }, blockTag], TIMEOUT_MS);
          const [out] = IFACE.multicall.decodeFunctionResult("aggregate3", raw);
          decoded = out;
        } catch (_) {
          if (attempt < 2) await sleep(300 * (attempt + 1));
        }
      }
      if (decoded === null) { failures += batch.length; return; }
      decoded.forEach((item, index) => { results[start + index] = { success: item[0] === true, returnData: item[1] }; });
    }
  };
  await Promise.all(Array.from({ length: Math.min(MC_CONCURRENCY, batches.length) }, worker));
  return { results, failures };
}

// --- surface ingestion ------------------------------------------------------------------
function loadSurface(file = SURFACE_PATH, fsImpl = fs) {
  const parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
  if (!parsed || parsed.schema !== SURFACE_SCHEMA || !Array.isArray(parsed.vaults)) throw new ScanFailure("SURFACE_INVALID");
  return parsed;
}

// Flatten the surface's per-vault top events into a candidate list, then bound to
// the top MAX_CANDIDATES by repayAssetsRaw. The vault meta (asset/oracle/uoa) is
// attached; the surface is NOT re-scanned.
function collectCandidates(surface, limit = MAX_CANDIDATES) {
  const vaultMeta = new Map(surface.vaults.map((v) => [v.vault, v]));
  const events = [];
  for (const v of surface.vaults) {
    for (const e of v.topLiquidateEvents || []) {
      events.push({ ...e, vaultMeta: vaultMeta.get(e.vault) || null });
    }
  }
  events.sort((a, b) => {
    const av = BigInt(a.repayAssetsRaw), bv = BigInt(b.repayAssetsRaw);
    if (av !== bv) return bv > av ? 1 : -1;
    return (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex);
  });
  return events.slice(0, limit);
}

// --- pinned context ---------------------------------------------------------------------
async function readPinContext(rpc, surface) {
  const block = await call(rpc, "eth_getBlockByNumber", [hexBlock(surface.pin.number), false]);
  if (!block || !block.hash) throw new ScanFailure("PIN_UNAVAILABLE");
  const baseFeeRaw = block.baseFeePerGas ? BigInt(block.baseFeePerGas) : 0n;
  let ethUsdRaw = null;
  let ethUsdNote = null;
  try {
    const dec = decodeOrNull(IFACE.chainlink, "decimals", await call(rpc, "eth_call", [{ to: ETH_USD_FEED, data: IFACE.chainlink.encodeFunctionData("decimals", []) }, block.hash]));
    const round = decodeOrNull(IFACE.chainlink, "latestRoundData", await call(rpc, "eth_call", [{ to: ETH_USD_FEED, data: IFACE.chainlink.encodeFunctionData("latestRoundData", []) }, block.hash]));
    const answer = round ? BigInt(round[1]) : 0n;
    if (dec && Number(dec[0]) === 8 && answer > 0n) ethUsdRaw = answer;
    else ethUsdNote = "ORACLE_INVALID";
  } catch (_) {
    ethUsdNote = "ORACLE_UNAVAILABLE";
  }
  return { block, baseFeeRaw, ethUsdRaw, ethUsdNote };
}

// --- maxLiquidationDiscount sweep -------------------------------------------------------
async function readMaxLiquidationDiscount(rpc, blockTag, vaults) {
  const result = new Map();
  const unique = [...new Set(vaults)];
  for (let start = 0; start < unique.length; start += MAX_VAULTS_PER_SWEEP) {
    const sweep = unique.slice(start, start + MAX_VAULTS_PER_SWEEP);
    const entries = sweep.map((vault) => ({ to: vault, data: IFACE.governance.encodeFunctionData("maxLiquidationDiscount", []) }));
    const { results } = await multicall(rpc, blockTag, entries);
    sweep.forEach((vault, index) => {
      const item = results[index];
      const decoded = item && item.success ? decodeOrNull(IFACE.governance, "maxLiquidationDiscount", item.returnData) : null;
      if (decoded) result.set(vault, { raw: BigInt(decoded[0]), source: "governance-getter" });
      else result.set(vault, { raw: PERIPHERY_DEFAULT_DISCOUNT_RAW, source: "periphery-default" });
    });
  }
  return result;
}

// --- oracle mid-point quotes (fix-14 / LiquidityUtils shapes) ---------------------------
async function readOracleQuotes(rpc, blockTag, candidates) {
  const entries = [];
  for (const c of candidates) {
    const meta = c.vaultMeta || {};
    const uoa = meta.unitOfAccount;
    entries.push({ to: meta.oracle, data: IFACE.oracle.encodeFunctionData("getQuote", [BigInt(c.yieldBalanceRaw), c.collateralAsset, uoa]) });
    entries.push({ to: meta.oracle, data: IFACE.oracle.encodeFunctionData("getQuote", [BigInt(c.repayAssetsRaw), meta.asset, uoa]) });
  }
  const { results } = await multicall(rpc, blockTag, entries);
  return candidates.map((c, index) => {
    const col = results[index * 2];
    const lia = results[index * 2 + 1];
    const colDecoded = col && col.success ? decodeOrNull(IFACE.oracle, "getQuote", col.returnData) : null;
    const liaDecoded = lia && lia.success ? decodeOrNull(IFACE.oracle, "getQuote", lia.returnData) : null;
    return {
      collateralQuoteRaw: colDecoded ? BigInt(colDecoded[0]) : null,
      liabilityQuoteRaw: liaDecoded ? BigInt(liaDecoded[0]) : null,
    };
  });
}

// --- ERC4626 redeem leg -----------------------------------------------------------------
// Euler collateral assets are frequently other EVault (ERC4626) share tokens
// (eWETH-2, eUSDC-22, ...), which have no Uniswap V3 pool of their own. The
// honest exit is therefore redeem-shares-to-underlying (convertToAssets) before
// the Uniswap V3 swap. Detection and the redeem quote are on-chain views.
async function readErc4626(rpc, blockTag, candidates) {
  const collaterals = [...new Set(candidates.map((c) => String(c.collateralAsset).toLowerCase()))];
  const assetEntries = collaterals.map((t) => ({ to: t, data: IFACE.erc4626.encodeFunctionData("asset", []) }));
  const assetRes = await multicall(rpc, blockTag, assetEntries);
  const underlyingOf = new Map();
  collaterals.forEach((t, i) => {
    const item = assetRes.results[i];
    const decoded = item && item.success ? decodeOrNull(IFACE.erc4626, "asset", item.returnData) : null;
    if (decoded) { const u = lower(decoded[0]); if (u && u !== ethers.ZeroAddress) underlyingOf.set(t, u); }
  });
  const convEntries = candidates.map((c) => {
    const t = String(c.collateralAsset).toLowerCase();
    return underlyingOf.has(t)
      ? { to: c.collateralAsset, data: IFACE.erc4626.encodeFunctionData("convertToAssets", [BigInt(c.yieldBalanceRaw)]) }
      : null;
  });
  const convRes = await multicall(rpc, blockTag, convEntries.filter(Boolean));
  let cursor = 0;
  return candidates.map((c) => {
    const t = String(c.collateralAsset).toLowerCase();
    if (!underlyingOf.has(t)) return { underlyingAsset: null, underlyingAmountRaw: null };
    const item = convRes.results[cursor++];
    const decoded = item && item.success ? decodeOrNull(IFACE.erc4626, "convertToAssets", item.returnData) : null;
    return { underlyingAsset: underlyingOf.get(t), underlyingAmountRaw: decoded ? BigInt(decoded[0]) : null };
  });
}

// --- Uniswap V3 pool discovery + QuoterV2 (mirrors morpho-unwind-valuation) -------------
async function discoverPools(rpc, blockTag, pairs) {
  const entries = [];
  const meta = [];
  const pushPool = (key, kind, tokenA, tokenB, fee) => {
    entries.push({ to: UNIV3_FACTORY, data: IFACE.factory.encodeFunctionData("getPool", [String(tokenA).toLowerCase(), String(tokenB).toLowerCase(), fee]) });
    meta.push({ key, kind, fee });
  };
  for (const pair of pairs) {
    const c = pair.collateralAsset.toLowerCase();
    const l = pair.liabilityAsset.toLowerCase();
    const u = pair.underlyingAsset ? pair.underlyingAsset.toLowerCase() : null;
    const key = pairKey(c, l);
    for (const fee of FEES) {
      pushPool(key, "direct", c, l, fee);
      pushPool(key, "collateralUsdc", c, USDC, fee);
      pushPool(key, "loanUsdc", l, USDC, fee);
      if (u) {
        pushPool(key, "underlyingDirect", u, l, fee);
        pushPool(key, "underlyingUsdc", u, USDC, fee);
      }
    }
  }
  const found = await multicall(rpc, blockTag, entries);
  const pools = [];
  found.results.forEach((item, index) => {
    if (!item || !item.success) return;
    const decoded = decodeOrNull(IFACE.factory, "getPool", item.returnData);
    const pool = decoded ? decoded[0] : null;
    if (!pool || pool === ethers.ZeroAddress) return;
    pools.push({ ...meta[index], pool: pool.toLowerCase() });
  });
  const liq = await multicall(rpc, blockTag, pools.map((p) => ({ to: p.pool, data: IFACE.liquidity.encodeFunctionData("liquidity", []) })));
  const best = new Map();
  pools.forEach((p, index) => {
    const item = liq.results[index];
    const decoded = item && item.success ? decodeOrNull(IFACE.liquidity, "liquidity", item.returnData) : null;
    const liquidity = decoded ? BigInt(decoded[0]) : 0n;
    if (liquidity <= 0n) return;
    const slot = `${p.key}|${p.kind}`;
    const current = best.get(slot);
    if (!current || liquidity > current.liquidity) best.set(slot, { pool: p.pool, fee: p.fee, liquidity });
  });
  const routes = new Map();
  for (const pair of pairs) {
    const key = pairKey(pair.collateralAsset, pair.liabilityAsset);
    routes.set(key, {
      direct: best.get(`${key}|direct`) || null,
      collateralUsdc: best.get(`${key}|collateralUsdc`) || null,
      loanUsdc: best.get(`${key}|loanUsdc`) || null,
      underlyingDirect: best.get(`${key}|underlyingDirect`) || null,
      underlyingUsdc: best.get(`${key}|underlyingUsdc`) || null,
    });
  }
  return routes;
}

async function quoteMany(rpc, blockTag, jobs) {
  if (!jobs.length) return [];
  const entries = jobs.map((job) => ({
    to: UNIV3_QUOTER_V2,
    data: IFACE.quoter.encodeFunctionData("quoteExactInputSingle", [{
      tokenIn: job.tokenIn, tokenOut: job.tokenOut, amountIn: job.amountIn, fee: job.fee, sqrtPriceLimitX96: 0n,
    }]),
  }));
  const { results } = await multicall(rpc, blockTag, entries);
  return results.map((item) => {
    if (!item || !item.success) return null;
    const decoded = decodeOrNull(IFACE.quoter, "quoteExactInputSingle", item.returnData);
    return decoded ? BigInt(decoded[0]) : null;
  });
}

// Build the exit/repay quote plan within the bounded QuoterV2 budget. A job is
// deduplicated by (tokenIn,tokenOut,fee,amountIn) so identical legs share one
// read. The exit source is the seized collateral when it has a pool, otherwise
// the ERC4626 underlying (redeem shares -> underlying first). Returns per-event
// route descriptors referencing job indices.
function planQuoteJobs(candidates, routes, budget) {
  const jobs = [];
  const index = new Map();
  let used = 0;
  const add = (job) => {
    const key = `${job.tokenIn}|${job.tokenOut}|${job.fee}|${job.amountIn}`.toLowerCase();
    if (index.has(key)) return index.get(key);
    if (used >= budget) return -1;
    used += 1;
    index.set(key, jobs.length);
    jobs.push(job);
    return jobs.length - 1;
  };
  const plan = candidates.map((c) => {
    const meta0 = c.vaultMeta || {};
    const key = pairKey(c.collateralAsset, meta0.asset);
    const route = routes.get(key);
    const p = { exitJob: -1, repayJob: -1, pass2Job: -1, kind: null, exitFee: null, pass2Fee: null, haircutBps: 0, outUsdcFromExit: false, identityAmountRaw: null, erc4626: false, hops: [], fees: [] };
    if (!route) return p;
    const loanIsUsdc = String(meta0.asset || "").toLowerCase() === USDC.toLowerCase();
    if (loanIsUsdc) p.repayIsUsdc = true;
    else if (route.loanUsdc) p.repayJob = add({ tokenIn: meta0.asset, tokenOut: USDC, amountIn: BigInt(c.repayAssetsRaw), fee: route.loanUsdc.fee });
    const collat = { token: c.collateralAsset, amount: BigInt(c.yieldBalanceRaw), erc: false };
    const under = (c.underlyingAsset && c.underlyingAmountRaw !== null)
      ? { token: c.underlyingAsset, amount: BigInt(c.underlyingAmountRaw), erc: true } : null;
    const prefs = [];
    const isUsdc = (t) => String(t).toLowerCase() === USDC.toLowerCase();
    if (isUsdc(collat.token)) prefs.push({ s: collat, pool: null, kind: "univ3-usdc", hop: "identity" });
    prefs.push({ s: collat, pool: route.collateralUsdc, kind: "univ3-usdc", hop: "usdc" });
    prefs.push({ s: collat, pool: route.direct, kind: "univ3-direct", hop: "direct" });
    if (under) {
      if (isUsdc(under.token)) prefs.push({ s: under, pool: null, kind: "univ3-erc4626-usdc", hop: "identity" });
      prefs.push({ s: under, pool: route.underlyingUsdc, kind: "univ3-erc4626-usdc", hop: "usdc" });
      prefs.push({ s: under, pool: route.underlyingDirect, kind: "univ3-erc4626-direct", hop: "direct" });
    }
    let chosen = null;
    for (const pf of prefs) { if (pf.hop === "identity" || pf.pool) { chosen = pf; break; } }
    if (!chosen) return p;
    p.kind = chosen.kind;
    p.erc4626 = chosen.s.erc;
    if (chosen.hop === "identity") {
      p.outUsdcFromExit = true;
      p.identityAmountRaw = chosen.s.amount;
      p.haircutBps = chosen.s.erc ? HAIRCUT_TWO_HOP_BPS : 0;
      p.hops = [String(chosen.s.token).toLowerCase()];
      p.fees = [];
    } else if (chosen.hop === "usdc") {
      p.exitJob = add({ tokenIn: chosen.s.token, tokenOut: USDC, amountIn: chosen.s.amount, fee: chosen.pool.fee });
      p.exitFee = chosen.pool.fee;
      p.outUsdcFromExit = true;
      p.haircutBps = chosen.s.erc ? HAIRCUT_TWO_HOP_BPS : HAIRCUT_DIRECT_BPS;
      p.hops = [String(chosen.s.token).toLowerCase(), USDC.toLowerCase()];
      p.fees = [chosen.pool.fee];
    } else {
      p.exitJob = add({ tokenIn: chosen.s.token, tokenOut: meta0.asset, amountIn: chosen.s.amount, fee: chosen.pool.fee });
      p.exitFee = chosen.pool.fee;
      p.outUsdcFromExit = false;
      p.haircutBps = (chosen.s.erc || !loanIsUsdc) ? HAIRCUT_TWO_HOP_BPS : HAIRCUT_DIRECT_BPS;
      p.hops = [String(chosen.s.token).toLowerCase(), String(meta0.asset).toLowerCase()];
      p.fees = [chosen.pool.fee];
    }
    return p;
  });
  return { jobs, plan, used };
}

function planPass2(candidates, routes, plan, pass1, budget) {
  const jobs = [];
  const index = new Map();
  let used = 0;
  const add = (job) => {
    const key = `${job.tokenIn}|${job.tokenOut}|${job.fee}|${job.amountIn}`.toLowerCase();
    if (index.has(key)) return index.get(key);
    if (used >= budget) return -1;
    used += 1;
    index.set(key, jobs.length);
    jobs.push(job);
    return jobs.length - 1;
  };
  candidates.forEach((c, i) => {
    const p = plan[i];
    const meta0 = c.vaultMeta || {};
    if (p.kind !== "univ3-direct" && p.kind !== "univ3-erc4626-direct") return;
    if (String(meta0.asset || "").toLowerCase() === USDC.toLowerCase()) return;
    const route = routes.get(pairKey(c.collateralAsset, meta0.asset));
    if (!route || !route.loanUsdc) return;
    const outLoan = p.exitJob >= 0 ? pass1[p.exitJob] : null;
    if (outLoan === null || outLoan === undefined) return;
    p.pass2Job = add({ tokenIn: meta0.asset, tokenOut: USDC, amountIn: outLoan, fee: route.loanUsdc.fee });
    p.pass2Fee = route.loanUsdc.fee;
  });
  return { jobs, plan, used };
}

// --- valuation --------------------------------------------------------------------------
function valueRow(c, oracleQuotes, discountInfo, gasCeilingUsdcRaw) {
  const meta = c.vaultMeta || {};
  const base = {
    vault: c.vault, liquidator: c.liquidator, violator: c.violator,
    collateralAsset: c.collateralAsset, liabilityAsset: meta.asset || null, unitOfAccount: meta.unitOfAccount || null,
    oracle: meta.oracle || null, repayAssetsRaw: c.repayAssetsRaw, yieldBalanceRaw: c.yieldBalanceRaw,
    blockNumber: c.blockNumber, txHash: c.txHash, logIndex: c.logIndex,
    maxLiquidationDiscountRaw: discountInfo ? discountInfo.raw.toString() : null,
    maxLiquidationDiscountSource: discountInfo ? discountInfo.source : null,
  };
  const collateralQuote = oracleQuotes ? oracleQuotes.collateralQuoteRaw : null;
  const liabilityQuote = oracleQuotes ? oracleQuotes.liabilityQuoteRaw : null;
  if (collateralQuote === null || liabilityQuote === null || collateralQuote <= 0n || liabilityQuote <= 0n) {
    return {
      ...base, collateralQuoteRaw: null, liabilityQuoteRaw: null,
      discountBps: null, collateralValuedRaw: null, assumeDebtValueRaw: null, netBeforeGasRaw: null,
      exitSwapRoute: null, expectedOutUsdcRaw: null, repaidUsdcRaw: null, gasCeilingUsdcRaw: gasCeilingUsdcRaw === null ? null : gasCeilingUsdcRaw.toString(),
      netUsdcRaw: null, haircutBps: 0, quoteExecutable: QUOTE_EXECUTABLE, probeStatus: "NOT_REQUIRED",
      routePositive: false, valuationStatus: "UNQUALIFIED_ROUTE", valuationReason: "oracle-quote-unavailable",
    };
  }
  const maxDiscountFrac = (discountInfo ? discountInfo.raw : PERIPHERY_DEFAULT_DISCOUNT_RAW) * WAD / CONFIG_SCALE;
  // fix-14: discount = min(maxLiquidationDiscount, 1 - collateral/liability).
  const rawDiscountFrac = liabilityQuote < collateralQuote ? WAD - (liabilityQuote * WAD / collateralQuote) : 0n;
  const discountFrac = rawDiscountFrac < maxDiscountFrac ? rawDiscountFrac : maxDiscountFrac;
  const collateralValued = collateralQuote - (collateralQuote * discountFrac / WAD);
  const assumeDebtValue = liabilityQuote;
  const netBeforeGas = collateralValued - assumeDebtValue;
  return {
    ...base,
    collateralQuoteRaw: collateralQuote.toString(),
    liabilityQuoteRaw: liabilityQuote.toString(),
    discountBps: (discountFrac * 10_000n / WAD).toString(),
    collateralValuedRaw: collateralValued.toString(),
    assumeDebtValueRaw: assumeDebtValue.toString(),
    netBeforeGasRaw: netBeforeGas.toString(),
    netBeforeGasPositive: netBeforeGas > 0n,
    exitSwapRoute: null, expectedOutUsdcRaw: null, repaidUsdcRaw: null,
    gasCeilingUsdcRaw: gasCeilingUsdcRaw === null ? null : gasCeilingUsdcRaw.toString(),
    netUsdcRaw: null, haircutBps: 0, quoteExecutable: QUOTE_EXECUTABLE, probeStatus: "NOT_REQUIRED",
    routePositive: false, valuationStatus: "UNQUALIFIED_ROUTE", valuationReason: "route-unavailable",
  };
}

function applyRoute(row, routeResult, gasCeilingUsdcRaw) {
  if (!routeResult || !routeResult.routeKind) return row;
  const outUsdc = routeResult.outUsdcRaw;
  const repaidUsdc = routeResult.repaidUsdcRaw;
  if (outUsdc === null || outUsdc === undefined || repaidUsdc === null || repaidUsdc === undefined) return row;
  const haircut = haircutRaw(outUsdc, routeResult.haircutBps);
  const adjustedOut = outUsdc > haircut ? outUsdc - haircut : 0n;
  const gas = gasCeilingUsdcRaw === null ? 0n : gasCeilingUsdcRaw;
  const netUsdc = adjustedOut - repaidUsdc - gas;
  return {
    ...row,
    exitSwapRoute: routeResult.routeKind,
    expectedOutUsdcRaw: outUsdc.toString(),
    repaidUsdcRaw: repaidUsdc.toString(),
    gasCeilingUsdcRaw: gasCeilingUsdcRaw === null ? null : gasCeilingUsdcRaw.toString(),
    netUsdcRaw: netUsdc.toString(),
    haircutBps: routeResult.haircutBps,
    routePositive: netUsdc > 0n,
    valuationStatus: "QUALIFIED_VIEW",
    valuationReason: null,
    probeStatus: netUsdc > 0n ? "PENDING_KEYLESS_FORK" : "NOT_REQUIRED",
    swapTarget: UNIV3_SWAP_ROUTER_02.toLowerCase(),
    swapHops: routeResult.hops,
    swapFees: routeResult.fees,
    quoteExecutable: QUOTE_EXECUTABLE,
  };
}

// --- artifact ---------------------------------------------------------------------------
function atomicWriteJson(file, value, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    fsImpl.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    fsImpl.renameSync(temporary, file);
  } finally {
    try { fsImpl.rmSync(temporary, { force: true }); } catch (_) {}
  }
}

function writeCsv(rows, file, fsImpl = fs) {
  const header = "vault,liquidator,violator,collateralAsset,liabilityAsset,repayAssetsRaw,yieldBalanceRaw,discountBps,collateralValuedRaw,assumeDebtValueRaw,netBeforeGasRaw,expectedOutUsdcRaw,repaidUsdcRaw,gasCeilingUsdcRaw,netUsdcRaw,valuationStatus,routePositive";
  const lines = rows.map((r) => [r.vault, r.liquidator, r.violator, r.collateralAsset, r.liabilityAsset, r.repayAssetsRaw, r.yieldBalanceRaw, r.discountBps, r.collateralValuedRaw, r.assumeDebtValueRaw, r.netBeforeGasRaw, r.expectedOutUsdcRaw, r.repaidUsdcRaw, r.gasCeilingUsdcRaw, r.netUsdcRaw, r.valuationStatus, r.routePositive].map((v) => (v === null || v === undefined ? "" : v)).join(","));
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    fsImpl.writeFileSync(temporary, `${[header, ...lines].join("\n")}\n`, { flag: "wx" });
    fsImpl.renameSync(temporary, file);
  } finally {
    try { fsImpl.rmSync(temporary, { force: true }); } catch (_) {}
  }
}

// --- orchestration ----------------------------------------------------------------------
async function valuate(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const surface = options.surface || loadSurface(options.surfacePath || SURFACE_PATH, fsImpl);
  const rpc = options.rpc || (await resolveWorkingRpc(CHAIN_ID));
  if (!rpc) throw new ScanFailure("RPC_UNAVAILABLE");
  const blockTag = surface.pin.hash;

  const candidates = collectCandidates(surface, options.maxCandidates || MAX_CANDIDATES);
  const ctx = await readPinContext(rpc, surface);

  // Bounded maxLiquidationDiscount sweep (<= 40 vaults per sweep).
  const discountMap = await readMaxLiquidationDiscount(rpc, blockTag, candidates.map((c) => c.vault));

  // Oracle mid-point quotes (fix-14 collateral/liability values).
  const oracleQuotes = await readOracleQuotes(rpc, blockTag, candidates);

  // ERC4626 redeem leg: Euler collaterals are often EVault share tokens with no
  // Uniswap pool; resolve their underlying + redeem amount.
  const erc4626Info = await readErc4626(rpc, blockTag, candidates);
  candidates.forEach((c, i) => { c.underlyingAsset = erc4626Info[i].underlyingAsset; c.underlyingAmountRaw = erc4626Info[i].underlyingAmountRaw; });

  // Uniswap V3 route discovery + bounded QuoterV2 reads.
  const pairSeen = new Set();
  const pairs = [];
  for (const c of candidates) {
    const key = pairKey(c.collateralAsset, (c.vaultMeta || {}).asset);
    if (pairSeen.has(key) || !c.collateralAsset || !(c.vaultMeta || {}).asset) continue;
    pairSeen.add(key);
    pairs.push({ collateralAsset: c.collateralAsset, liabilityAsset: c.vaultMeta.asset, underlyingAsset: c.underlyingAsset || null });
  }
  const routes = await discoverPools(rpc, blockTag, pairs);
  const pass1Plan = planQuoteJobs(candidates, routes, QUOTE_BUDGET);
  const pass1 = await quoteMany(rpc, blockTag, pass1Plan.jobs);
  const remaining = QUOTE_BUDGET - pass1Plan.used;
  const pass2Plan = planPass2(candidates, routes, pass1Plan.plan, pass1, Math.max(0, remaining));
  const pass2 = await quoteMany(rpc, blockTag, pass2Plan.jobs);

  const gasCeilingUsdcRaw = ctx.ethUsdRaw === null ? null : economics.gasCeilingUsdcRaw(ctx.baseFeeRaw, ctx.ethUsdRaw);
  const quoteReadsUsed = pass1Plan.used + pass2Plan.used;

  const rows = candidates.map((c, i) => {
    const discountInfo = discountMap.get(c.vault) || { raw: PERIPHERY_DEFAULT_DISCOUNT_RAW, source: "periphery-default" };
    let row = valueRow(c, oracleQuotes[i], discountInfo, gasCeilingUsdcRaw);
    const meta = c.vaultMeta || {};
    const p = pass1Plan.plan[i];
    const loanIsUsdc = String(meta.asset || "").toLowerCase() === USDC.toLowerCase();
    let routeResult = null;
    if (p && p.kind) {
      let outUsdcRaw = null;
      if (p.identityAmountRaw !== null) {
        outUsdcRaw = p.identityAmountRaw;
      } else if (p.exitJob >= 0) {
        const exitOut = pass1[p.exitJob];
        if (p.outUsdcFromExit) outUsdcRaw = exitOut;
        else if (p.pass2Job >= 0) outUsdcRaw = pass2[p.pass2Job];
      }
      const repaidUsdcRaw = p.repayIsUsdc ? BigInt(c.repayAssetsRaw) : (p.repayJob >= 0 ? pass1[p.repayJob] : null);
      if (outUsdcRaw !== null && outUsdcRaw !== undefined && repaidUsdcRaw !== null && repaidUsdcRaw !== undefined) {
        const hops = [...p.hops];
        const fees = [...p.fees];
        if (p.pass2Job >= 0 && p.pass2Fee !== null) { hops.push(USDC.toLowerCase()); fees.push(p.pass2Fee); }
        routeResult = { routeKind: p.kind, outUsdcRaw, repaidUsdcRaw, haircutBps: p.haircutBps, hops, fees };
      }
    }
    row = applyRoute(row, routeResult, gasCeilingUsdcRaw);
    if (row.valuationStatus === "UNQUALIFIED_ROUTE") {
      row.valuationReason = (oracleQuotes[i] && oracleQuotes[i].collateralQuoteRaw !== null && oracleQuotes[i].liabilityQuoteRaw !== null)
        ? "route-unavailable" : "oracle-quote-unavailable";
    }
    return row;
  });

  const statusCounts = {};
  for (const r of rows) statusCounts[r.valuationStatus] = (statusCounts[r.valuationStatus] || 0) + 1;
  const probeCounts = {};
  for (const r of rows) probeCounts[r.probeStatus] = (probeCounts[r.probeStatus] || 0) + 1;
  const netPositiveRows = rows.filter((r) => r.netUsdcRaw !== null && BigInt(r.netUsdcRaw) > 0n);
  const routePositiveRows = rows.filter((r) => r.routePositive === true);
  const netBeforeGasPositiveRows = rows.filter((r) => r.netBeforeGasPositive === true);
  const sortedByNet = rows.filter((r) => r.netUsdcRaw !== null).sort((a, b) => (BigInt(b.netUsdcRaw) > BigInt(a.netUsdcRaw) ? 1 : BigInt(b.netUsdcRaw) < BigInt(a.netUsdcRaw) ? -1 : 0));

  const routeSummary = pairs.map((pair) => {
    const key = pairKey(pair.collateralAsset, pair.liabilityAsset);
    const route = routes.get(key);
    const entry = (r) => (r ? { pool: r.pool, fee: r.fee, liquidity: r.liquidity.toString() } : null);
    return {
      collateralAsset: pair.collateralAsset, liabilityAsset: pair.liabilityAsset, underlyingAsset: pair.underlyingAsset || null,
      direct: entry(route.direct),
      collateralUsdc: entry(route.collateralUsdc),
      loanUsdc: entry(route.loanUsdc),
      underlyingDirect: entry(route.underlyingDirect),
      underlyingUsdc: entry(route.underlyingUsdc),
    };
  });

  // Bounded canonical CSV only when the valued row count exceeds 500.
  let csvInfo = null;
  if (rows.length > 500) {
    const csvPath = options.csvPath || CSV_PATH;
    writeCsv(rows, csvPath, fsImpl);
    csvInfo = { path: relPosix(csvPath), rowCount: rows.length, canonicalHash: canonicalHash(rows), bounded: true };
  }

  const fallbackVaults = [...discountMap.values()].filter((d) => d.source === "periphery-default").length;

  return {
    schema: ARTIFACT_SCHEMA,
    generatedAt: new Date().toISOString(),
    scanner: SCANNER,
    chainId: CHAIN_ID,
    safety: {
      readOnly: true, signedActions: false, transactions: false, endpointMaterialPersisted: false,
      externalPriceApi: false, fetchPriceUsed: false,
    },
    source: {
      path: relPosix(SURFACE_PATH), schema: surface.schema, scannedAt: surface.scannedAt,
      pin: { number: surface.pin.number, hash: surface.pin.hash },
      liquidateEventCount: surface.totals ? surface.totals.liquidateEventCount : null,
    },
    pin: {
      number: surface.pin.number, hash: surface.pin.hash,
      baseFeePerGasRaw: ctx.baseFeeRaw.toString(),
      ethUsdRaw: ctx.ethUsdRaw === null ? null : ctx.ethUsdRaw.toString(),
      ethUsdNote: ctx.ethUsdNote,
      timestamp: surface.pin.timestamp,
    },
    gasPolicy: {
      gasCeiling: economics.GAS_CEILING.toString(),
      baseFeeMultiplierNumerator: "9",
      baseFeeMultiplierDenominator: "8",
      priorityFeeWei: economics.PRIORITY_FEE_WEI.toString(),
      gasCeilingUsdcRaw: gasCeilingUsdcRaw === null ? null : gasCeilingUsdcRaw.toString(),
    },
    model: {
      configScale: CONFIG_SCALE.toString(),
      peripheryDefaultDiscountRaw: PERIPHERY_DEFAULT_DISCOUNT_RAW.toString(),
      discountFormula: "discount = min(maxLiquidationDiscount/CONFIG_SCALE, 1 - collateralQuote/liabilityQuote)",
      collateralValuedFormula: "collateralValued = collateralQuote * (1 - discount)",
      assumeDebtValueFormula: "assumeDebtValue = oracle.getQuote(repayAssets, asset, unitOfAccount)",
      netBeforeGasFormula: "netBeforeGas = collateralValued - assumeDebtValue (unitOfAccount units)",
      collateralQuoteFormula: "oracle.getQuote(yieldBalance, collateral, unitOfAccount)",
      quoteReadsBudget: QUOTE_BUDGET,
      haircutDirectBps: HAIRCUT_DIRECT_BPS,
      haircutTwoHopBps: HAIRCUT_TWO_HOP_BPS,
      quoteExecutable: QUOTE_EXECUTABLE,
      sources: [
        "targets/euler-evk/src/EVault/modules/Liquidation.sol:139-147 (discount formula)",
        "targets/euler-evk/src/EVault/modules/Liquidation.sol:195 (take-over-debt transferBorrow)",
        "targets/euler-evk/src/EVault/modules/Liquidation.sol:213 (collateral enforceCollateralTransfer)",
        "targets/euler-evk/src/EVault/shared/LiquidityUtils.sol:97-120 (mid-point pricing shapes)",
      ],
      note: "collateral/liability are the event's mid-point oracle quotes of the seized collateral (yieldBalance) and the taken-over debt (repayAssets); the on-chain source additionally scales the collateral leg by the liquidationLTV, which is per-account and not reconstructible from the surface, so it is not applied and not fabricated. Euler collateral assets are frequently other EVault (ERC4626) share tokens with no Uniswap V3 pool; such exits are valued by redeeming shares to the underlying (convertToAssets) before the Uniswap V3 swap (routes labelled univ3-erc4626-*).",
    },
    maxLiquidationDiscountSweep: {
      vaultsRead: discountMap.size,
      vaultsPerSweepCap: MAX_VAULTS_PER_SWEEP,
      vaultsFallbackPeripheryDefault: fallbackVaults,
      sources: { "governance-getter": discountMap.size - fallbackVaults, "periphery-default": fallbackVaults },
    },
    candidates: { evaluated: rows.length, maxCandidates: MAX_CANDIDATES, quoteReadsUsed, quoteReadsBudget: QUOTE_BUDGET },
    summary: {
      candidatesEvaluated: rows.length,
      netPositive: netPositiveRows.length,
      netBeforeGasPositive: netBeforeGasPositiveRows.length,
      routePositive: routePositiveRows.length,
      qualifiedView: statusCounts.QUALIFIED_VIEW || 0,
      unqualified: statusCounts.UNQUALIFIED_ROUTE || 0,
      valuationStatusCounts: statusCounts,
      probeStatusCounts: probeCounts,
      quoteExecutableCount: rows.filter((r) => r.quoteExecutable === true).length,
      netUsdcSumRaw: sortedByNet.reduce((sum, r) => sum + BigInt(r.netUsdcRaw), 0n).toString(),
    },
    routes: routeSummary,
    rows,
    topNetPositive: sortedByNet.filter((r) => BigInt(r.netUsdcRaw) > 0n).slice(0, 5),
    csv: csvInfo,
  };
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((v) => v.startsWith("--") && v !== "--once");
  if (unknown.length) throw new ScanFailure("USAGE");
  const artifact = await valuate();
  atomicWriteJson(ARTIFACT_PATH, artifact);
  process.stdout.write(`${JSON.stringify({
    status: "OK",
    sourcePin: artifact.pin.number,
    candidatesEvaluated: artifact.summary.candidatesEvaluated,
    netPositive: artifact.summary.netPositive,
    netBeforeGasPositive: artifact.summary.netBeforeGasPositive,
    routePositive: artifact.summary.routePositive,
    qualifiedView: artifact.summary.qualifiedView,
    unqualified: artifact.summary.unqualified,
    quoteReadsUsed: artifact.candidates.quoteReadsUsed,
    ethUsdNote: artifact.pin.ethUsdNote,
    csv: artifact.csv ? artifact.csv.path : null,
    generatedAt: artifact.generatedAt,
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`euler-l valuation failed: ${error && error.code ? error.code : "SCAN_FAILED"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE, SURFACE_PATH, ARTIFACT_PATH, CSV_PATH, ARTIFACT_SCHEMA, SURFACE_SCHEMA, CHAIN_ID, SCANNER,
  UNIV3_FACTORY, UNIV3_QUOTER_V2, UNIV3_SWAP_ROUTER_02, MULTICALL3, USDC, ETH_USD_FEED, FEES,
  CONFIG_SCALE, WAD, PERIPHERY_DEFAULT_DISCOUNT_RAW, MAX_CANDIDATES, QUOTE_BUDGET, MAX_VAULTS_PER_SWEEP,
  HAIRCUT_DIRECT_BPS, HAIRCUT_TWO_HOP_BPS, QUOTE_EXECUTABLE, IFACE,
  ScanFailure, sleep, hexBlock, lower, relPosix, canonicalHash, ceilDiv, haircutRaw, pairKey, decodeOrNull,
  call, resolveWorkingRpc, multicall, loadSurface, collectCandidates, readPinContext,
  readMaxLiquidationDiscount, readOracleQuotes, readErc4626, discoverPools, quoteMany, planQuoteJobs, planPass2,
  valueRow, applyRoute, atomicWriteJson, writeCsv, valuate, main,
};
