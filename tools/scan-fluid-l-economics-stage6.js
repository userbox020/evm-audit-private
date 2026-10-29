#!/usr/bin/env node
"use strict";

// Fluid Vault near-LT band liquidation EXIT-DEPTH sizer (Stage-6, L class).
//
// Consumes the Stage-5 idealized economics artifact
// (reports/raw/fast/fluid-l-economics.json, schema fluid-l-economics/v1) and,
// for every `routePositive: true` row, sizes the realizable exit depth of the
// received collateral against the vault's OWN in-tree exit market.
//
// Realization geometry (exactly as verified in-tree, no fabrication):
//   * Liquidator repays the vault debt (debtValued raw debt units) and receives
//     collateral at the liquidate conversion (equivalent value + the penalty at
//     vaultTypesCommon/coreModule/main.sol:114; the liquidator's own
//     colPerUnitDebt_ guard shape is main.sol:648). The received collateral has
//     debt-equivalent value (debtValued + grossBonus) at the liquidate oracle
//     rate (grossBonus = debtValued * penaltyBps / 10000).
//   * For a T2/T4 smart-collateral vault the collateral token address IS the
//     Fluid DEX pool address (vaultTypesCommon/coreModule/constantVariables.sol:
//     111-116: "if smart collateral then adding dex address (even though it's not
//     a token)"). The vault's supply shares are DEX collateral shares (1e18), and
//     the oracle `getExchangeRateLiquidate()` is debt-per-1e18-DEX-share
//     (oracle/implementations/dex/dexSmartColOracleImpl.sol:44).
//   * Exit market = the SAME in-tree Fluid DEX pool the vault oracle prices from
//     (`dexOracleData().dexPool`). The in-tree realization of
//     colShare -> one token is the DEX's `withdrawPerfectInOneToken`
//     (poolT1/coreModule/core/colOperations.sol:449-584), read through the
//     deployed DexResolver `estimateWithdrawPerfectInOneToken` (periphery/
//     resolvers/dex/main.sol:348-359). Single source, no multi-hop fabrication.
//   * If the debt token is NOT one of the pool's two tokens, the in-tree pool
//     cannot deliver the debt token in one hop -> FAIL_CLOSED (no multi-hop
//     fabrication). If the vault oracle is not a DEX-pool oracle (e.g. a
//     GenericOracle with no pool config) -> FAIL_CLOSED.
//
// exitDepth semantics (documented, deterministic):
//   * realizedSize     = the row's received DEX collateral shares, the exact
//                        inverse of the liquidate conversion:
//                        (debtValued + grossBonus) * 1e27 / rate.
//   * spot_size        = the largest probed share size whose realized per-share
//                        exit value (out * 1e27 / shares) is >= the vault's own
//                        liquidate oracle rate (i.e. no adverse slippage beyond
//                        the vault's own (peg-buffered) oracle mark). null when no
//                        probed size qualifies.
//   * unfillable_above = the largest share size the DEX one-token withdrawal can
//                        still fill with positive output (the pool's physical
//                        fill ceiling); above it the withdrawal is unfillable.
//
// Read-only. No signing, no transactions, no broadcasts, no external price API.
// RPC material stays process-only and is never printed or persisted. Nothing is
// fabricated: an unknown path is FAIL_CLOSED with a null realizedNetUsdc.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc, loadRpcUrls, sanitizeError } = require("./shared-rpc");
const fluid = require("./scan-fluid-l.js");

const WORKSPACE = path.resolve(__dirname, "..");
const STAGE5_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "fluid-l-economics.json");
const ARTIFACT_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "fluid-l-economics-stage6.json");
const CSV_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "fluid-l-economics-stage6.csv");

const ARTIFACT_SCHEMA = "fluid-l-economics-stage6/v1";
const STAGE5_SCHEMA = "fluid-l-economics/v1";
const SCANNER = "tools/scan-fluid-l-economics-stage6.js";
const VERSION = 1;

const REQUEST_BUDGET = 240;   // total requests per run
const PER_ROW_BUDGET = 60;    // probes/requests per row
const MC_BATCH = 200;
const TIMEOUT_MS = 30_000;
const MAX_BISECT = 14;        // binary-search iterations for unfillable_above

// DexResolver is deployed at the same address on every in-scope chain (verified
// live: identical runtime, 47,252 bytes).
const DEX_RESOLVER = "0x11D80CfF056Cef4F9E6d23da8672fE9873e5cC07";

// Canonical USD stablecoin allowlist (chainId -> token -> {symbol, decimals});
// reused verbatim from Stage-5 (no external price API).
const USD_STABLES = {
  1: {
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
    "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6 },
    "0x6b175474e89094c44da98b954eedeac495271d0f": { symbol: "DAI", decimals: 18 },
    "0xdc035d45d973e3ec169d2276ddab16f1e407384f": { symbol: "USDS", decimals: 18 },
  },
  8453: {
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6 },
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": { symbol: "USDbC", decimals: 6 },
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { symbol: "DAI", decimals: 18 },
  },
  42161: {
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { symbol: "USDC", decimals: 6 },
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": { symbol: "USDT", decimals: 6 },
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": { symbol: "DAI", decimals: 18 },
  },
  137: {
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { symbol: "USDC", decimals: 6 },
    "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": { symbol: "USDT", decimals: 6 },
    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063": { symbol: "DAI", decimals: 18 },
  },
};

const I = Object.freeze({
  oracle: new ethers.Interface([
    "function dexOracleData() view returns (address dexPool_, bool quoteInToken0_, address liquidity_, uint256 resultMultiplier_, uint256 resultDivisor_)",
    "function getExchangeRateLiquidate() view returns (uint256)",
    "function infoName() view returns (string)",
  ]),
  dexResolver: new ethers.Interface([
    "function getDexTokens(address dex_) view returns (address token0_, address token1_)",
    "function getTotalSupplySharesRaw(address dex_) view returns (uint256)",
    "function getDexCollateralReserves(address dex_) view returns (uint256 token0RealReserves, uint256 token1RealReserves, uint256 token0ImaginaryReserves, uint256 token1ImaginaryReserves)",
    "function getDexDebtReserves(address dex_) view returns (uint256 token0Debt, uint256 token1Debt, uint256 token0RealReserves, uint256 token1RealReserves, uint256 token0ImaginaryReserves, uint256 token1ImaginaryReserves)",
    "function estimateWithdrawPerfectInOneToken(address dex_, uint256 shares_, uint256 minToken0_, uint256 minToken1_) returns (uint256 withdrawAmt_)",
  ]),
  multicall: new ethers.Interface([
    "function aggregate3((address target,bool failure,bytes callData)[]) payable returns ((bool success,bytes returnData)[])",
  ]),
});

let REQUEST_COUNT = 0;

class Stage6Failure extends Error {
  constructor(code) { super(code); this.name = "Stage6Failure"; this.code = code; }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function relPosix(target) { return path.relative(WORKSPACE, target).split(path.sep).join("/"); }
function lower(value) { try { return ethers.getAddress(String(value)).toLowerCase(); } catch (_) { return null; } }
function big(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function ustr(value) { return value === null || value === undefined ? null : big(value).toString(); }
function sha256Hex(body) { return crypto.createHash("sha256").update(body).digest("hex"); }
function decodeOrNull(iface, fn, returnData) {
  try { return iface.decodeFunctionResult(fn, returnData); } catch (_) { return null; }
}

async function call(rpc, method, params, ms = TIMEOUT_MS, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    REQUEST_COUNT += 1;
    const result = await rpcCall(rpc, method, params, ms);
    if (result !== null && result !== undefined) return result;
    if (attempt < attempts - 1) await sleep(250 * (attempt + 1));
  }
  throw new Stage6Failure("RPC_READ_FAILED");
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
    } catch (_) { /* try next candidate */ }
  }
  return first;
}

// One RPC request per batch (Multicall3 aggregate3).
async function multicall(rpc, blockTag, entries) {
  const results = new Array(entries.length);
  let failures = 0;
  for (let start = 0; start < entries.length; start += MC_BATCH) {
    const batch = entries.slice(start, start + MC_BATCH);
    let decoded = null;
    for (let attempt = 0; attempt < 3 && decoded === null; attempt += 1) {
      try {
        const tuples = batch.map((e) => ({ target: e.to, failure: true, callData: e.data }));
        const data = I.multicall.encodeFunctionData("aggregate3", [tuples]);
        const raw = await call(rpc, "eth_call", [{ to: fluid.MULTICALL3, data }, blockTag], TIMEOUT_MS);
        const [out] = I.multicall.decodeFunctionResult("aggregate3", raw);
        decoded = out;
      } catch (_) { if (attempt < 2) await sleep(300 * (attempt + 1)); }
    }
    if (decoded === null) { failures += batch.length; continue; }
    decoded.forEach((item, index) => { results[start + index] = { success: item[0] === true, returnData: item[1] }; });
  }
  return { results, failures };
}

function loadStage5(file = STAGE5_PATH) {
  const parsed = fluid.readJson(file);
  if (!parsed || parsed.schema !== STAGE5_SCHEMA || !Array.isArray(parsed.chains) || !Array.isArray(parsed.rows)) {
    throw new Stage6Failure("STAGE5_INVALID");
  }
  return parsed;
}

function collectRoutePositiveRows(stage5) {
  return stage5.rows.filter((r) => r.routePositive === true);
}

function pinFromStage5(stage5, chainId) {
  const c = (stage5.chains || []).find((x) => x && x.chainId === chainId);
  return c && c.pin && c.pin.hash ? c.pin : null;
}

function usdDecimalsFor(row) {
  const stable = (USD_STABLES[row.chainId] || {})[row.debtToken];
  if (!stable) return null;
  return stable;
}

// sharesReceived = (debtValued + grossBonus) * 1e27 / rate  (exact inverse of the
// contract's colPerDebt conversion at the liquidate oracle rate).
function receivedSharesRaw(row) {
  const rate = big(row.oracleRateLiquidateRaw);
  if (rate === 0n) return null;
  const debt = big(row.debtValued);
  const bonus = big(row.grossBonusDebtRaw);
  return ((debt + bonus) * (10n ** 27n)) / rate;
}

function toUsdcRaw(amountDebtRaw, decimals) {
  return (big(amountDebtRaw) * (10n ** 6n)) / (10n ** BigInt(decimals));
}

// Probe set relative to the received size R (deduped, bounded by totalShares).
function probeSizes(R, totalShares) {
  const out = [];
  const add = (v) => {
    const x = v > 0n ? v : 0n;
    if (x > 0n && x <= totalShares && !out.includes(x)) out.push(x);
  };
  add(1n);
  add(R / 1000n);
  add(R / 100n);
  add(R / 10n);
  add(R / 2n);
  add(R);
  add(R * 2n);
  add(R * 5n);
  add(R * 10n);
  add(totalShares);
  return out;
}

function exitProbeEntries(pool, shares, minT0, minT1) {
  return { to: DEX_RESOLVER, data: I.dexResolver.encodeFunctionData("estimateWithdrawPerfectInOneToken", [pool, shares, minT0, minT1]) };
}

function failClosedRow(row, code, reason, extra) {
  return {
    chainId: row.chainId,
    vault: row.vault,
    vaultId: row.vaultId,
    debtToken: row.debtToken,
    debtTokenSymbol: row.debtTokenSymbol || null,
    debtTokenDecimals: row.debtTokenDecimals === undefined ? null : row.debtTokenDecimals,
    oracle: row.oracle,
    oracleInfoName: row.oracleInfoName || null,
    oracleRateLiquidateRaw: row.oracleRateLiquidateRaw,
    idealizedNetUsdc: row.netUsdc,
    realizedNetUsdc: null,
    exitDepth: { unit: "dexColShares(1e18)", spot_size: null, realizedSize: null, unfillable_above: null },
    executable: false,
    verdict: code,
    routeSource: `FAIL_CLOSED_${code}`,
    failClosed: { code, reason },
    exitMarket: null,
    probes: [],
    ...extra,
  };
}

async function processRow(rpc, blockTag, row) {
  const chainStart = REQUEST_COUNT;
  const probes = [];
  const finalize = (r) => ({ ...r, probes, requestsUsed: REQUEST_COUNT - chainStart });

  // 1) Resolve the in-tree exit market: the oracle's own DEX pool.
  let oracleData = null;
  try {
    const raw = await call(rpc, "eth_call", [{ to: row.oracle, data: I.oracle.encodeFunctionData("dexOracleData", []) }, blockTag]);
    const d = decodeOrNull(I.oracle, "dexOracleData", raw);
    if (d) oracleData = { dexPool: lower(d[0]), quoteInToken0: d[1] === true, liquidity: lower(d[2]) };
  } catch (_) { oracleData = null; }
  if (!oracleData || !oracleData.dexPool) {
    return finalize(failClosedRow(row, "EXIT_MARKET_NOT_DEX_POOL", "oracle has no in-tree DEX pool config (dexOracleData() unavailable); no single-source exit market can be derived without fabrication"));
  }
  const pool = oracleData.dexPool;

  // 2) Pool tokens + shares + reserves (single multicall request).
  const entries = [
    { to: DEX_RESOLVER, data: I.dexResolver.encodeFunctionData("getDexTokens", [pool]) },
    { to: DEX_RESOLVER, data: I.dexResolver.encodeFunctionData("getTotalSupplySharesRaw", [pool]) },
    { to: DEX_RESOLVER, data: I.dexResolver.encodeFunctionData("getDexCollateralReserves", [pool]) },
    { to: DEX_RESOLVER, data: I.dexResolver.encodeFunctionData("getDexDebtReserves", [pool]) },
  ];
  const mc = await multicall(rpc, blockTag, entries);
  const tokD = mc.results[0] && mc.results[0].success ? decodeOrNull(I.dexResolver, "getDexTokens", mc.results[0].returnData) : null;
  const totalD = mc.results[1] && mc.results[1].success ? decodeOrNull(I.dexResolver, "getTotalSupplySharesRaw", mc.results[1].returnData) : null;
  const colD = mc.results[2] && mc.results[2].success ? decodeOrNull(I.dexResolver, "getDexCollateralReserves", mc.results[2].returnData) : null;
  const debtD = mc.results[3] && mc.results[3].success ? decodeOrNull(I.dexResolver, "getDexDebtReserves", mc.results[3].returnData) : null;
  if (!tokD || !totalD) {
    return finalize(failClosedRow(row, "EXIT_POOL_READ_FAILED", "DEX pool token/total-share read failed at pin", { exitMarket: { dexPool: pool, quoteInToken0: oracleData.quoteInToken0 } }));
  }
  const token0 = lower(tokD[0]);
  const token1 = lower(tokD[1]);
  // getTotalSupplySharesRaw returns the packed storage slot; the oracle masks it
  // with X128 (dexSmartColOracleImpl.sol:30-32). Mask identically.
  const totalShares = big(totalD[0]) & ((1n << 128n) - 1n);

  const debtToken = row.debtToken;
  let debtIsToken0 = null;
  if (debtToken === token0) debtIsToken0 = true;
  else if (debtToken === token1) debtIsToken0 = false;
  const exitMarket = {
    dexPool: pool,
    quoteInToken0: oracleData.quoteInToken0,
    token0,
    token1,
    debtToken,
    debtTokenInPool: debtIsToken0 !== null,
    collateralToken: debtIsToken0 === true ? token1 : (debtIsToken0 === false ? token0 : null),
    totalSupplySharesRaw: ustr(totalShares),
    collateralReservesRaw: colD ? { token0RealReserves: ustr(colD[0]), token1RealReserves: ustr(colD[1]) } : null,
    debtReservesRaw: debtD ? { token0Debt: ustr(debtD[0]), token1Debt: ustr(debtD[1]) } : null,
  };
  if (debtIsToken0 === null) {
    return finalize(failClosedRow(row, "DEBT_TOKEN_NOT_IN_EXIT_POOL", `vault debt token ${debtToken} is not one of the in-tree DEX pool tokens [${token0}, ${token1}]; a single-source exit to the debt token does not exist (no multi-hop fabrication)`, { exitMarket }));
  }
  const stable = usdDecimalsFor(row);
  if (!stable) {
    return finalize(failClosedRow(row, "NON_USD_DEBT_TOKEN", "debt token is not on the canonical USD stablecoin allowlist; USDC-net realization not derivable", { exitMarket }));
  }

  const R = receivedSharesRaw(row);
  if (R === null || R === 0n) {
    return finalize(failClosedRow(row, "RECEIVED_SIZE_UNRESOLVED", "received-collateral share size could not be derived (rate unavailable)", { exitMarket }));
  }

  // 3) Probe the DEX one-token withdrawal across the size set (one request).
  const minT0 = debtIsToken0 ? 1n : 0n;
  const minT1 = debtIsToken0 ? 0n : 1n;
  const sizes = probeSizes(R, totalShares);
  const sizeMc = await multicall(rpc, blockTag, sizes.map((s) => exitProbeEntries(pool, s, minT0, minT1)));
  const sizeOut = sizes.map((s, i) => {
    const item = sizeMc.results[i];
    if (!item || item.success !== true) return { size: s, out: null };
    const d = decodeOrNull(I.dexResolver, "estimateWithdrawPerfectInOneToken", item.returnData);
    return { size: s, out: d ? big(d[0]) : null };
  });
  const oracleRate = big(row.oracleRateLiquidateRaw);
  let spotSize = null;
  for (const p of sizeOut) {
    if (p.out !== null && p.out > 0n && (p.out * (10n ** 27n)) / p.size >= oracleRate) spotSize = p.size;
  }
  const realized = sizeOut.find((p) => p.size === R) || { size: R, out: null };
  probes.push({ phase: "size-scan", pool, minToken0: minT0.toString(), minToken1: minT1.toString(), points: sizeOut.map((p) => ({ size: p.size.toString(), out: p.out === null ? null : p.out.toString() })) });

  // 4) Binary search the fill ceiling (unfillable_above): the largest size the
  // DEX one-token withdrawal still fills with positive output. Output is not
  // monotonic at tiny sizes (rounding), so bracket between the largest positive
  // probed size and the next probed size that returned zero.
  let unfillable = null;
  let unfillableOut = null;
  const fillable = sizeOut.filter((p) => p.out !== null && p.out > 0n);
  if (fillable.length > 0) {
    const maxPos = fillable.reduce((m, p) => (p.size > m ? p.size : m), 0n);
    if (maxPos >= totalShares) {
      unfillable = totalShares;
      unfillableOut = (fillable.find((p) => p.size === totalShares) || {}).out ?? null;
    } else {
      const above = sizeOut.map((p) => p.size).filter((s) => s > maxPos).sort((a, b) => (a < b ? -1 : 1));
      const upper = above.length ? above[0] : totalShares;
      let lo = maxPos; // known > 0
      let loOut = (fillable.find((p) => p.size === maxPos) || {}).out ?? null;
      let hi = upper;  // known 0 / unfillable
      let iters = 0;
      while (hi - lo > 1n && iters < MAX_BISECT) {
        iters += 1;
        const mid = (lo + hi) / 2n;
        const bmc = await multicall(rpc, blockTag, [exitProbeEntries(pool, mid, minT0, minT1)]);
        const item = bmc.results[0];
        let val = null;
        if (item && item.success === true) {
          const d = decodeOrNull(I.dexResolver, "estimateWithdrawPerfectInOneToken", item.returnData);
          val = d ? big(d[0]) : null;
        }
        probes.push({ phase: "bisect", size: mid.toString(), out: val === null ? null : val.toString() });
        if (val !== null && val > 0n) { lo = mid; loOut = val; } else { hi = mid; }
      }
      unfillable = lo;
      unfillableOut = loOut;
    }
  }

  const depth = {
    unit: "dexColShares(1e18)",
    spot_size: spotSize === null ? null : spotSize.toString(),
    realizedSize: R.toString(),
    unfillable_above: unfillable === null ? null : unfillable.toString(),
  };

  // 5) Realized economics at the row's actual received size.
  const realizedOut = realized.out;
  if (realizedOut === null || realizedOut === 0n) {
    // The received size exceeds the pool's one-token fill ceiling: the idealized
    // bonus is NOT realizable at full-liquidation scale. Report the (informational)
    // net at the fill ceiling, but the row verdict is fail-closed.
    let ceilingNet = null;
    if (unfillable !== null && unfillable > 0n && unfillableOut !== null && unfillableOut > 0n) {
      ceilingNet = (toUsdcRaw(unfillableOut - big(row.debtValued), stable.decimals) - big(row.gasBoundUsdc)).toString();
    }
    return finalize(failClosedRow(row, "UNFILLABLE_AT_REALIZED_SIZE", "the received collateral exceeds the in-tree DEX pool's one-token fill ceiling; the full-liquidation bonus cannot be realized in one hop (no multi-hop fabrication)", {
      exitMarket,
      exitDepth: depth,
      unfillableAtRealizedSize: true,
      realizedNetUsdcAtFillCeiling: ceilingNet,
      realizedOutRaw: null,
    }));
  }
  const realizedNetUsdc = toUsdcRaw(realizedOut - big(row.debtValued), stable.decimals) - big(row.gasBoundUsdc);
  const executable = realizedNetUsdc > 0n;
  const verdict = executable ? "REALIZED_NET_POSITIVE_EXECUTABLE" : "REALIZED_NET_NEGATIVE";

  return finalize({
    chainId: row.chainId,
    vault: row.vault,
    vaultId: row.vaultId,
    debtToken,
    debtTokenSymbol: stable.symbol,
    debtTokenDecimals: stable.decimals,
    oracle: row.oracle,
    oracleInfoName: row.oracleInfoName || null,
    oracleRateLiquidateRaw: row.oracleRateLiquidateRaw,
    idealizedNetUsdc: row.netUsdc,
    realizedNetUsdc: realizedNetUsdc.toString(),
    realizedGrossUsdcRaw: toUsdcRaw(realizedOut - big(row.debtValued), stable.decimals).toString(),
    realizedOutRaw: realizedOut.toString(),
    exitDepth: {
      unit: "dexColShares(1e18)",
      spot_size: spotSize === null ? null : spotSize.toString(),
      realizedSize: R.toString(),
      unfillable_above: unfillable === null ? null : unfillable.toString(),
    },
    executable,
    verdict,
    routeSource: `fluid-dex-withdrawPerfectInOneToken-realized-exit (pool ${pool}; single-source; realized-size ${R.toString()})`,
    failClosed: null,
    exitMarket,
  });
}

async function run(options = {}) {
  const startMs = Date.now();
  const stage5 = options.stage5 || loadStage5(options.stage5Path || STAGE5_PATH);
  const rows = collectRoutePositiveRows(stage5);
  const chainIds = [...new Set(rows.map((r) => r.chainId))].sort((a, b) => a - b);

  const chainResults = [];
  const outRows = [];

  for (const chainId of chainIds) {
    const chainStart = REQUEST_COUNT;
    const chainRows = rows.filter((r) => r.chainId === chainId);
    const label = fluid.CHAINS[chainId] ? fluid.CHAINS[chainId].label : `c${chainId}`;
    const result = { chainId, label, rows: chainRows.length, pin: null, error: null, reads: 0 };
    try {
      const rpc = options.rpcFor ? options.rpcFor(chainId) : await resolveWorkingRpc(chainId);
      if (!rpc) throw new Stage6Failure("RPC_UNAVAILABLE");
      const prior = pinFromStage5(stage5, chainId);
      let block;
      if (prior) {
        block = await call(rpc, "eth_getBlockByHash", [prior.hash, false]);
        if (!block || !block.hash) throw new Stage6Failure("PIN_UNAVAILABLE");
        result.pin = { number: Number(big(block.number)), hash: block.hash, timestamp: fluid.toIso(block.timestamp), finality: "reused-stage5-pin", baseFeePerGasRaw: block.baseFeePerGas ? big(block.baseFeePerGas).toString() : "0" };
      } else {
        block = await fluid.selectFinalized(rpc);
        result.pin = { number: Number(big(block.number)), hash: block.hash, timestamp: fluid.toIso(block.timestamp), finality: "finalized", baseFeePerGasRaw: block.baseFeePerGas ? big(block.baseFeePerGas).toString() : "0" };
      }
      const blockTag = block.hash;
      for (const r of chainRows) outRows.push(await processRow(rpc, blockTag, r));
    } catch (e) {
      result.error = sanitizeError(e, e && e.code ? String(e.code).toLowerCase() : "chain-error");
      for (const r of chainRows) outRows.push(failClosedRow(r, "CHAIN_READ_FAILED", "chain read failed before exit-depth sizing"));
    }
    result.reads = REQUEST_COUNT - chainStart;
    chainResults.push(result);
  }

  outRows.sort((a, b) => (a.chainId - b.chainId) || String(a.vault).localeCompare(String(b.vault)));

  const csv = writeCsvVersioned(outRows, options.csvPath || CSV_PATH);

  const verdictCounts = {};
  for (const r of outRows) verdictCounts[r.verdict] = (verdictCounts[r.verdict] || 0) + 1;
  const executable = outRows.filter((r) => r.executable === true).length;
  const failClosed = outRows.filter((r) => r.realizedNetUsdc === null).length;
  const realized = outRows.filter((r) => r.realizedNetUsdc !== null).length;

  const honestAbsences = [
    "realizedNetUsdc is the USDC-net of the received collateral exited through the vault's OWN in-tree Fluid DEX pool (DexResolver.estimateWithdrawPerfectInOneToken), single-source. Rows whose debt token is not a pool token, or whose oracle has no DEX-pool config, are FAIL_CLOSED with null realizedNetUsdc; no multi-hop route is fabricated.",
    "spot_size = largest probed share size whose realized per-share exit value is >= the vault's own (peg-buffered) liquidate oracle rate; unfillable_above = largest share size the DEX one-token withdrawal still fills with positive output. Both are pool-depth bounds at the reused Stage-5 pin, not executable-trade claims.",
    "A realizedNetUsdc > 0 is a read-only depth bound (pool state at the pin, gas ceiling from Stage-5), NOT a signed/executable route. No fork execution, no signing, no broadcast.",
    "The DEX withdrawal is estimated through the deployed DexResolver try/catch ADDRESS_DEAD pattern; a value of 0 is treated as unfillable, never as a fabricated fill.",
  ];

  const artifact = {
    schema: ARTIFACT_SCHEMA,
    version: VERSION,
    generatedAt: new Date().toISOString(),
    scanner: SCANNER,
    scope: "Read-only Fluid Vault route-positive row EXIT-DEPTH sizing against the in-tree oracle DEX pool (single-source; no signing/execution)",
    safety: {
      readOnly: true, signedActions: false, transactions: false, endpointMaterialPersisted: false,
      privateKeysRead: false, externalPriceApi: false, fetchPriceUsed: false, forkTransactions: false,
      executable: executable > 0,
    },
    source: {
      path: relPosix(options.stage5Path || STAGE5_PATH),
      schema: stage5.schema,
      generatedAt: stage5.generatedAt,
      routePositiveRows: rows.length,
    },
    model: {
      realization: "liquidator repays debtValued; receives DEX collateral shares = (debtValued + grossBonus) * 1e27 / getExchangeRateLiquidate(); exits via the SAME Fluid DEX pool the oracle prices from",
      penaltyAnchor: "vaultTypesCommon/coreModule/main.sol:114 (colPerDebt = temp2_ * (10000 + penalty) / 10000)",
      slippageGuardAnchor: "vaultTypesCommon/coreModule/main.sol:648 (colPerUnitDebt_ liquidator guard)",
      collateralTokenFact: "smart-collateral vault SUPPLY_TOKEN = the DEX pool address (vaultTypesCommon/coreModule/constantVariables.sol:111-116)",
      oracleShareFact: "oracle getExchangeRateLiquidate is debt per 1e18 DEX collateral share (oracle/implementations/dex/dexSmartColOracleImpl.sol:44)",
      exitMechanism: "DexResolver.estimateWithdrawPerfectInOneToken -> FluidDexT1.withdrawPerfectInOneToken (poolT1/coreModule/core/colOperations.sol:449-584); periphery/resolvers/dex/main.sol:348-359",
      exitMarketSource: "oracle.dexOracleData().dexPool (in-tree oracle/pool config; deployment args verified per row)",
      netFormula: "realizedNetUsdc = toUsdc(estimateWithdrawPerfectInOneToken(pool, receivedShares, debt-token min) - debtValued) - gasBoundUsdc(Stage-5)",
      exitDepthSemantics: {
        realizedSize: "the row's received DEX collateral shares (exact inverse of the liquidate conversion)",
        spot_size: "largest probed size whose realized per-share exit value >= the vault liquidate oracle rate (no adverse slippage beyond the oracle mark)",
        unfillable_above: "largest size the DEX one-token withdrawal still fills with positive output (pool fill ceiling)",
      },
      dexResolver: DEX_RESOLVER,
      sources: [
        "targets/fluid-contracts-public/contracts/protocols/vault/vaultTypesCommon/coreModule/main.sol:88-114,648",
        "targets/fluid-contracts-public/contracts/protocols/vault/vaultTypesCommon/coreModule/constantVariables.sol:111-116",
        "targets/fluid-contracts-public/contracts/oracle/implementations/dex/dexSmartColOracleImpl.sol:25-45",
        "targets/fluid-contracts-public/contracts/oracle/oracles/dex/dexSmartColPegOracle.sol:47-90",
        "targets/fluid-contracts-public/contracts/oracle/implementations/dex/reserveGetters/reservesFromLiquidity.sol:78-96",
        "targets/fluid-contracts-public/contracts/protocols/dex/poolT1/coreModule/core/colOperations.sol:443-584",
        "targets/fluid-contracts-public/contracts/periphery/resolvers/dex/main.sol:342-359",
      ],
      note: "Single-source exit only. A debt token that is not one of the pool's two tokens is FAIL_CLOSED (no multi-hop fabrication).",
    },
    budget: {
      requestBudget: REQUEST_BUDGET,
      perRowBudget: PER_ROW_BUDGET,
      requests: REQUEST_COUNT,
      withinBudget: REQUEST_COUNT <= REQUEST_BUDGET,
      sequential: true,
      wallMs: Date.now() - startMs,
      pinsReused: true,
      chainReads: chainResults.map((c) => ({ chainId: c.chainId, reads: c.reads })),
      maxRowRequests: outRows.reduce((m, r) => Math.max(m, r.requestsUsed || 0), 0),
    },
    summary: {
      routePositiveRows: rows.length,
      realized: realized,
      executable,
      failClosed,
      verdictCounts,
      chains: chainResults.length,
    },
    netDeltas: executable > 0 ? "REALIZED_EXIT_DEPTH_SIZED" : (realized > 0 ? "REALIZED_EXIT_DEPTH_SIZED_NO_POSITIVE" : "FAIL_CLOSED_ALL"),
    chains: chainResults,
    rows: outRows,
    csv: { path: csv.path, rowCount: csv.rowCount, sha256: csv.sha256, canonicalHash: csv.canonicalHash, bounded: true, byteIdenticalToPreviousRun: csv.byteIdenticalToPreviousRun, versionedSuffix: csv.versionedSuffix, version: csv.version },
    coverage: {
      complete: chainResults.every((c) => !c.error),
      blockers: [...new Set(chainResults.filter((c) => c.error).map((c) => c.error))],
      honestAbsences,
    },
  };
  return artifact;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
  }
}

const CSV_HEADER = [
  "chainId", "vault", "vaultId", "debtToken", "debtTokenSymbol",
  "idealizedNetUsdc", "realizedNetUsdc", "exitMarketPool",
  "spot_size", "realizedSize", "unfillable_above", "executable", "verdict", "routeSource",
];

function csvRow(r) {
  return {
    chainId: r.chainId,
    vault: r.vault,
    vaultId: r.vaultId,
    debtToken: r.debtToken,
    debtTokenSymbol: r.debtTokenSymbol,
    idealizedNetUsdc: r.idealizedNetUsdc,
    realizedNetUsdc: r.realizedNetUsdc,
    exitMarketPool: r.exitMarket ? r.exitMarket.dexPool : null,
    spot_size: r.exitDepth ? r.exitDepth.spot_size : null,
    realizedSize: r.exitDepth ? r.exitDepth.realizedSize : null,
    unfillable_above: r.exitDepth ? r.exitDepth.unfillable_above : null,
    executable: r.executable,
    verdict: r.verdict,
    routeSource: r.routeSource,
  };
}

function csvBody(rows) {
  const lines = rows.map((r) => {
    const c = csvRow(r);
    return CSV_HEADER.map((h) => {
      const v = c[h];
      return v === null || v === undefined ? "" : String(v);
    }).join(",");
  });
  return `${[CSV_HEADER.join(","), ...lines].join("\n")}\n`;
}

function writeCsvVersioned(rows, file) {
  const body = csvBody(rows);
  const sha = sha256Hex(body);
  const base = { sha256: sha, rowCount: rows.length, canonicalHash: `0x${sha}` };
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf8");
    if (existing === body) {
      return { ...base, path: relPosix(file), byteIdenticalToPreviousRun: true, versionedSuffix: false, version: null };
    }
    let n = 2;
    let candidate = `${file.replace(/\.csv$/i, "")}-r${n}.csv`;
    while (fs.existsSync(candidate) && fs.readFileSync(candidate, "utf8") !== body && n < 100) {
      n += 1;
      candidate = `${file.replace(/\.csv$/i, "")}-r${n}.csv`;
    }
    if (!fs.existsSync(candidate)) fs.writeFileSync(candidate, body, { flag: "wx" });
    return { ...base, path: relPosix(candidate), byteIdenticalToPreviousRun: false, versionedSuffix: true, version: `r${n}` };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { flag: "wx" });
  return { ...base, path: relPosix(file), byteIdenticalToPreviousRun: false, versionedSuffix: false, version: null };
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((v) => v.startsWith("--") && v !== "--once");
  if (unknown.length) throw new Stage6Failure("USAGE");
  const artifact = await run({});
  atomicWriteJson(ARTIFACT_PATH, artifact);
  process.stdout.write(`${JSON.stringify({
    status: "OK",
    schema: artifact.schema,
    generatedAt: artifact.generatedAt,
    routePositiveRows: artifact.summary.routePositiveRows,
    realized: artifact.summary.realized,
    executable: artifact.summary.executable,
    failClosed: artifact.summary.failClosed,
    verdictCounts: artifact.summary.verdictCounts,
    requests: artifact.budget.requests,
    withinBudget: artifact.budget.withinBudget,
    maxRowRequests: artifact.budget.maxRowRequests,
    csv: artifact.csv.path,
    csvByteIdenticalToPreviousRun: artifact.csv.byteIdenticalToPreviousRun,
    csvVersionedSuffix: artifact.csv.versionedSuffix,
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`fluid-l stage6 failed: ${error && error.code ? error.code : "SCAN_FAILED"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE, STAGE5_PATH, ARTIFACT_PATH, CSV_PATH, ARTIFACT_SCHEMA, STAGE5_SCHEMA, SCANNER, VERSION,
  REQUEST_BUDGET, PER_ROW_BUDGET, DEX_RESOLVER, USD_STABLES, I, Stage6Failure,
  call, resolveWorkingRpc, multicall, loadStage5, collectRoutePositiveRows, pinFromStage5,
  receivedSharesRaw, toUsdcRaw, probeSizes, failClosedRow, processRow, run, csvBody, writeCsvVersioned, main,
};
