#!/usr/bin/env node
"use strict";

// Fluid Vault near/at-LT EXIT-DEPTH sizing (DEX quote lane) for the economics
// routePositive rows.
//
// Consumes the fresh surface produced by tools/scan-fluid-l-economics.js
// (reports/raw/fast/fluid-l-economics.json, schema fluid-l-economics/v1). Those
// rows carry routePositive:true with
// routeSource "oracle-getExchangeRateLiquidate-idealized-collateral-exit (exit
// depth UNSIZED; non-executable)" and exitDepthSized:false -- the oracle-idealized
// upper bound is not a realizable route. This producer sizes the missing input:
// the real DEX exit depth for the seized collateral leg -> best venue per row.
//
// Design (bounded, honest, fail-closed):
//   * Input is ONLY the economics artifact's routePositive rows (<= 7). The
//     collateral asset is the first supply leg that is not the debt asset; the
//     exit notional is the row's own colValued (debt-token units, decimal
//     adjusted) and the collateral-raw amount is reconstructed from the row's
//     own oracle rate: collRaw = floor(colValued * 1e27 / rateLiquidate). No
//     value is invented; a missing/zero input => NOT_SIZABLE with a reason.
//   * Candidate venues come from a small STATIC per-chain table of OFFICIAL
//     Uniswap V3 deployments (factory + QuoterV2 + fee tiers). No remembered
//     addresses: the table is transcribed from the in-tree official tables
//     (tools/morpho-unwind-valuation.js, tools/scan-e12x-cross-chain.js,
//     tools/scan-focused-morpho-review-producers.js) and follows the lib-24
//     discipline (official deployment table beats a remembered address). The
//     in-tree fluid checkout does not pin DEX contracts, so these in-tree
//     official tables are the preferred source. At most 2 candidate venues per
//     asset.
//   * Default = OFFLINE plan-only: NO live calls. It emits the plan rows with an
//     honest `liveNotWired:false,offline:"plan-only"` marker and a resumable
//     per-row state. `--live` enables QuoterV2 reads (quoteExactInputSingle at
//     size, half-size and 2x-size: at most 3 quotes per row).
//
// Fail-closed: a per-chain pool-discovery failure marks the row UNSIZED
// (POOL_DISCOVERY_UNAVAILABLE) -- never a fabricated fallback. An RPC/pin
// failure marks the row UNSIZED (RPC_READ_FAILED). Offline rows that cannot even
// be sized (no non-debt leg / no value / no rate) are NOT_SIZABLE.
//
// Read-only. No signing, no transactions, no broadcasts, no fork, no external
// price API. RPC endpoints are resolved through the shared read-only pool
// (shared-rpc via scan-fluid-l-economics) and stay process-only: never printed
// or persisted.

const path = require("node:path");
const { ethers } = require("ethers");
const econ = require("./scan-fluid-l-economics");
const fluid = require("./scan-fluid-l.js");

const WORKSPACE = path.resolve(__dirname, "..");
const ECONOMICS_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "fluid-l-economics.json");
const OUT_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "fluid-exit-depth", "r1.json");

const SCHEMA = "fluid-exit-depth/v1";
const VERSION = 1;
const SCANNER = "tools/scan-fluid-exit-depth.js";
const ECONOMICS_SCHEMA = "fluid-l-economics/v1";

const MAX_ROWS = 7;                 // bounded routePositive set
const MAX_VENUES_PER_ASSET = 2;     // at most 2 candidate venues per asset
const MAX_QUOTES_PER_ROW = 3;       // size, half-size, 2x-size
const ONE27 = 10n ** 27n;

// Static per-chain official Uniswap V3 deployments. Transcribed from in-tree
// official tables; fee tiers are the canonical V3 creation tiers. `candidateFees`
// is the ordered (<= 2) preferred discovery plan used offline.
const VENUE_SOURCES = "tools/morpho-unwind-valuation.js; tools/scan-e12x-cross-chain.js; tools/scan-focused-morpho-review-producers.js";
const VENUES = Object.freeze({
  1: Object.freeze({
    chainId: 1, label: "ethereum",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    feeTiers: Object.freeze([100, 500, 3000, 10000]),
    candidateFees: Object.freeze([500, 3000]),
    source: VENUE_SOURCES,
  }),
  8453: Object.freeze({
    chainId: 8453, label: "base",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    feeTiers: Object.freeze([100, 500, 3000, 10000]),
    candidateFees: Object.freeze([500, 3000]),
    source: VENUE_SOURCES,
  }),
  42161: Object.freeze({
    chainId: 42161, label: "arbitrum",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    feeTiers: Object.freeze([100, 500, 3000, 10000]),
    candidateFees: Object.freeze([500, 3000]),
    source: VENUE_SOURCES,
  }),
  137: Object.freeze({
    chainId: 137, label: "polygon",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    feeTiers: Object.freeze([100, 500, 3000, 10000]),
    candidateFees: Object.freeze([500, 3000]),
    source: VENUE_SOURCES,
  }),
});
function venueFor(chainId) { return VENUES[Number(chainId)] || null; }

const IFACE = Object.freeze({
  factory: new ethers.Interface(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)"]),
  liquidity: new ethers.Interface(["function liquidity() view returns (uint128)"]),
  erc20: new ethers.Interface(["function decimals() view returns (uint8)"]),
  quoter: new ethers.Interface([
    "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
  ]),
});

class ExitFailure extends Error {
  constructor(code) { super(code); this.name = "ExitFailure"; this.code = code; }
}

function relPosix(target) { return path.relative(WORKSPACE, target).split(path.sep).join("/"); }
function lower(value) { try { return ethers.getAddress(String(value)).toLowerCase(); } catch (_) { return null; } }
function big(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }

// --- input ---------------------------------------------------------------------------------
function loadEconomics(file = ECONOMICS_PATH) {
  const parsed = fluid.readJson(file);
  if (!parsed || parsed.schema !== ECONOMICS_SCHEMA || !Array.isArray(parsed.rows)) {
    throw new ExitFailure("ECONOMICS_INVALID");
  }
  return parsed;
}

function routePositiveRows(economics) {
  const all = economics.rows.filter((r) => r && r.routePositive === true);
  return { rows: all.slice(0, MAX_ROWS), total: all.length, truncated: Math.max(0, all.length - MAX_ROWS) };
}

// Collateral asset = first supply leg that is not the debt asset.
function pickCollAsset(row) {
  const debt = lower(row.debtToken);
  const legs = [row.colToken0, row.colToken1].map(lower).filter(Boolean);
  const nonDebt = legs.filter((l) => l !== debt);
  return { debt, legs, asset: nonDebt[0] || null };
}

// Exit size, reconstructed only from the row's own fields.
function sizeExit(row) {
  const colValued = row.colValued === null || row.colValued === undefined ? null : big(row.colValued);
  const rate = row.oracleRateLiquidateRaw === null || row.oracleRateLiquidateRaw === undefined ? null : big(row.oracleRateLiquidateRaw);
  if (colValued === null || colValued === 0n) return { ok: false, reason: "COLLATERAL_VALUE_UNAVAILABLE" };
  if (rate === null || rate === 0n) return { ok: false, reason: "COLLATERAL_RATE_UNAVAILABLE" };
  const collRaw = (colValued * ONE27) / rate;
  if (collRaw === 0n) return { ok: false, reason: "RECONSTRUCTED_SIZE_ZERO" };
  return {
    ok: true,
    collRaw,
    notionalDebtRaw: colValued,
    rateRaw: rate,
    approximate: true,
    rateIsDecimalNaive: row.oracleTargetDecimals === null || row.oracleTargetDecimals === undefined,
  };
}

function feePlan(venue) {
  return venue.candidateFees.slice(0, MAX_VENUES_PER_ASSET).map((fee) => ({
    pool: null, fee, quotedOutAtSizes: null, priceImpactBps: null, sufficientExit: null,
  }));
}

// --- plan row ------------------------------------------------------------------------------
function planRow(row, venue) {
  const { debt, legs, asset } = pickCollAsset(row);
  const sized = asset ? sizeExit(row) : { ok: false, reason: "NO_NON_DEBT_COLLATERAL_LEG" };
  const base = {
    chainId: row.chainId,
    vault: row.vault,
    vaultId: row.vaultId ?? null,
    type: row.type ?? null,
    debtAsset: debt,
    debtValueRaw: row.debtValued === null || row.debtValued === undefined ? null : String(row.debtValued),
    collateralLegs: legs,
    collAsset: asset,
    collSize: sized.ok ? sized.collRaw.toString() : null,
    collSizeUnit: "collateralRaw (reconstructed floor(colValued*1e27/rateLiquidate))",
    collSizeNotionalDebtRaw: sized.ok ? sized.notionalDebtRaw.toString() : null,
    collSizeApproximate: sized.ok ? true : null,
    rateIsDecimalNaive: sized.ok ? sized.rateIsDecimalNaive : null,
    oracleTargetDecimals: row.oracleTargetDecimals === undefined ? null : row.oracleTargetDecimals,
    venues: [],
    sufficientExit: null,
    executableAfterSizing: false,
    state: "PLAN",
    stateReason: null,
    liveNotWired: false,
    offline: "plan-only",
    notes: [],
  };
  if (!venue) {
    base.state = "NOT_SIZABLE";
    base.stateReason = "NO_VENUE_TABLE_FOR_CHAIN";
    base.notes.push(`no static official venue table for chainId ${row.chainId}; not fabricated`);
    return base;
  }
  if (!sized.ok) {
    base.state = "NOT_SIZABLE";
    base.stateReason = sized.reason;
    base.notes.push(`collateral exit size not derivable from the economics row (${sized.reason}); fail-closed`);
    base.venues = feePlan(venue);
    return base;
  }
  base.venues = feePlan(venue);
  base.notes.push("offline plan-only: candidate venues unresolved; --live resolves pools via the official factory and quotes QuoterV2 at size/half/2x");
  if (!sized.rateIsDecimalNaive) {
    base.notes.push("row oracleTargetDecimals is set: the raw rate is targetDecimals-adjusted, so collRaw is approximate; a live pool revert is recorded UNSIZED, never defaulted");
  }
  return base;
}

// --- live quotes ---------------------------------------------------------------------------
function impactBps(base, qHalf, q2x) {
  if (qHalf === null || q2x === null || base === 0n) return null;
  const halfIn = base / 2n;
  const doubleIn = base * 2n;
  if (halfIn === 0n || doubleIn === 0n) return null;
  const pHalf = (qHalf * (10n ** 18n)) / halfIn;
  const p2x = (q2x * (10n ** 18n)) / doubleIn;
  if (pHalf === 0n) return null;
  const delta = pHalf > p2x ? pHalf - p2x : p2x - pHalf;
  return Number((delta * 10000n) / pHalf);
}

async function liveRow(row, plan, ctx) {
  const venue = ctx.venue;
  const debt = plan.debtAsset;
  const coll = plan.collAsset;
  const base = big(plan.collSize);
  const sizes = [base, base / 2n, base * 2n].filter((s) => s > 0n);
  const note = (m) => { plan.notes.push(m); };

  const found = await econ.multicall(ctx.rpc, ctx.blockTag, venue.feeTiers.map((fee) => ({
    to: venue.factory, data: IFACE.factory.encodeFunctionData("getPool", [coll, debt, fee]),
  })));
  const pools = [];
  found.results.forEach((item, index) => {
    if (!item || !item.success) return;
    const decoded = econ.decodeOrNull(IFACE.factory, "getPool", item.returnData);
    const pool = decoded ? decoded[0] : null;
    if (!pool || pool === ethers.ZeroAddress) return;
    pools.push({ pool: String(pool).toLowerCase(), fee: venue.feeTiers[index], liquidity: 0n });
  });
  if (pools.length === 0) {
    plan.state = "UNSIZED";
    plan.stateReason = "POOL_DISCOVERY_UNAVAILABLE";
    plan.venues = plan.venues.map((v) => ({ ...v, sufficientExit: null }));
    note("live: no official factory pool found for the collateral->debt pair at any creation tier; UNSIZED (no fallback venue fabricated)");
    return plan;
  }
  const liq = await econ.multicall(ctx.rpc, ctx.blockTag, pools.map((p) => ({ to: p.pool, data: IFACE.liquidity.encodeFunctionData("liquidity", []) })));
  pools.forEach((p, index) => {
    const item = liq.results[index];
    try { p.liquidity = big(IFACE.liquidity.decodeFunctionResult("liquidity", item.returnData)[0]); } catch (_) { p.liquidity = 0n; }
  });
  pools.sort((a, b) => (b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0));
  const candidates = pools.slice(0, MAX_VENUES_PER_ASSET);

  const primary = candidates[0];
  const qres = await econ.multicall(ctx.rpc, ctx.blockTag, sizes.map((s) => ({
    to: venue.quoter,
    data: IFACE.quoter.encodeFunctionData("quoteExactInputSingle", [{
      tokenIn: coll, tokenOut: debt, amountIn: s, fee: primary.fee, sqrtPriceLimitX96: 0n,
    }]),
  })));
  const quoted = sizes.map((s, index) => {
    const item = qres.results[index];
    if (!item || !item.success) return { size: s.toString(), amountOut: null };
    const decoded = econ.decodeOrNull(IFACE.quoter, "quoteExactInputSingle", item.returnData);
    return { size: s.toString(), amountOut: decoded ? big(decoded[0]).toString() : null };
  });
  const okCount = quoted.filter((q) => q.amountOut !== null).length;
  const at = (i) => (quoted[i] && quoted[i].amountOut !== null ? big(quoted[i].amountOut) : null);
  const outBase = at(0);
  const impact = impactBps(base, at(1), at(2));
  const debtToRepay = plan.debtValueRaw === null ? null : big(plan.debtValueRaw);

  let sufficientExit;
  if (okCount === 0) sufficientExit = false;
  else if (outBase !== null && debtToRepay !== null && outBase >= debtToRepay && okCount === sizes.length) sufficientExit = true;
  else sufficientExit = "PARTIAL";

  plan.venues = candidates.map((c, index) => ({
    pool: c.pool,
    fee: c.fee,
    liquidityRaw: c.liquidity.toString(),
    quotedOutAtSizes: index === 0 ? quoted : null,
    priceImpactBps: index === 0 ? impact : null,
    sufficientExit: index === 0 ? sufficientExit : null,
  }));
  plan.sufficientExit = sufficientExit;
  plan.executableAfterSizing = sufficientExit === true;
  plan.state = okCount === sizes.length ? "QUOTED" : "QUOTE_PARTIAL";
  plan.stateReason = okCount === sizes.length ? null : `${sizes.length - okCount}_of_${sizes.length}_quotes_failed`;
  note(`live: ${okCount}/${sizes.length} QuoterV2 quotes resolved on the deepest candidate (fee=${primary.fee}); executableAfterSizing is a view-quote signal only (no same-pin fork probe)`);
  return plan;
}

async function runLive(rows) {
  const byChain = new Map();
  for (const r of rows) {
    if (!byChain.has(r.chainId)) byChain.set(r.chainId, []);
    byChain.get(r.chainId).push(r);
  }
  for (const [chainId, chainRows] of byChain) {
    const venue = venueFor(chainId);
    if (!venue) continue; // already NOT_SIZABLE in plan
    let ctx = null;
    try {
      const rpc = await econ.resolveWorkingRpc(chainId);
      if (!rpc) throw new ExitFailure("RPC_UNAVAILABLE");
      const block = await fluid.selectFinalized(rpc);
      if (!block || !/^0x[0-9a-f]{64}$/i.test(block.hash || "")) throw new ExitFailure("BLOCK_UNAVAILABLE");
      ctx = { rpc, blockTag: block.hash, venue };
    } catch (e) {
      const code = e && e.code ? String(e.code) : "RPC_READ_FAILED";
      for (const r of chainRows) {
        if (r.state !== "PLAN") continue;
        r.state = "UNSIZED";
        r.stateReason = code;
        r.notes.push(`live: chain read unavailable (${code}); UNSIZED, not fabricated`);
      }
      continue;
    }
    for (const r of chainRows) {
      if (r.state !== "PLAN") continue;
      try { await liveRow(r, r, ctx); }
      catch (e) {
        r.state = "UNSIZED";
        r.stateReason = e && e.code ? String(e.code) : "RPC_READ_FAILED";
        r.notes.push("live: read failed; UNSIZED, not fabricated");
      }
    }
  }
  return rows;
}

// --- orchestration -------------------------------------------------------------------------
async function run(options = {}) {
  const economicsPath = options.economicsPath || ECONOMICS_PATH;
  const economics = loadEconomics(economicsPath);
  const { rows: routeRows, total, truncated } = routePositiveRows(economics);

  // Each plan row IS the live sub-plan; --live mutates the same object in place.
  const rows = routeRows.map((row) => planRow(row, venueFor(row.chainId)));

  const mode = options.live ? "live" : "offline-plan-only";
  if (options.live) await runLive(rows);

  const counts = { planned: 0, notSizable: 0, unsized: 0, quoted: 0, quotePartial: 0 };
  for (const r of rows) {
    if (r.state === "PLAN") counts.planned += 1;
    else if (r.state === "NOT_SIZABLE") counts.notSizable += 1;
    else if (r.state === "UNSIZED") counts.unsized += 1;
    else if (r.state === "QUOTED") counts.quoted += 1;
    else if (r.state === "QUOTE_PARTIAL") counts.quotePartial += 1;
  }

  const artifact = {
    schema: SCHEMA,
    version: VERSION,
    scannedAt: new Date().toISOString(),
    scanner: SCANNER,
    mode,
    liveNotWired: false,
    offline: options.live ? null : "plan-only",
    scope: "Read-only exit-depth sizing (DEX QuoterV2 quotes) for Fluid near/at-LT economics routePositive rows; no signing/execution",
    safety: {
      readOnly: true, signedActions: false, transactions: false, forkTransactions: false,
      endpointMaterialPersisted: false, privateKeysRead: false, externalPriceApi: false,
    },
    source: {
      path: relPosix(economicsPath),
      schema: economics.schema,
      scannedAt: economics.scannedAt ?? economics.generatedAt ?? null,
      routePositiveRows: total,
      consumed: rows.length,
      truncated,
    },
    budget: {
      maxRows: MAX_ROWS,
      maxVenuesPerAsset: MAX_VENUES_PER_ASSET,
      maxQuotesPerRow: MAX_QUOTES_PER_ROW,
      liveReads: options.live === true,
    },
    venues: Object.fromEntries(Object.entries(VENUES).map(([k, v]) => [k, {
      chainId: v.chainId, label: v.label, factory: v.factory, quoter: v.quoter,
      feeTiers: [...v.feeTiers], candidateFees: [...v.candidateFees], source: v.source,
    }])),
    summary: {
      routePositiveRows: total,
      consumed: rows.length,
      truncated,
      ...counts,
      executableAfterSizing: rows.filter((r) => r.executableAfterSizing === true).length,
    },
    honestAbsences: [
      "collSize is reconstructed from the economics row's own colValued and oracle rateLiquidate (floor(colValued*1e27/rate)); the economics artifact does not carry the vault supply raw or the collateral decimals, so it is an approximation, labelled per row.",
      "executableAfterSizing is a read-only QuoterV2 view-quote signal only: no same-pin fork probe is run here (forkTransactions:false), so it is not a mined-execution grant.",
      "Venue addresses are the in-tree OFFICIAL Uniswap V3 tables (no remembered addresses); the in-tree fluid checkout does not pin DEX contracts, so the in-tree official tables are the preferred source (lib-24 discipline).",
      "Any missing row input => NOT_SIZABLE; any per-chain pool-discovery failure => UNSIZED. No fallback venue or size is fabricated.",
    ],
    rows,
  };
  return artifact;
}

function parseArgs(argv) {
  const options = { live: false, economicsPath: ECONOMICS_PATH, outPath: OUT_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--live") options.live = true;
    else if (a === "--once") { /* compat no-op */ }
    else if (a === "--economics") { options.economicsPath = argv[++i]; }
    else if (a.startsWith("--economics=")) options.economicsPath = a.slice("--economics=".length);
    else if (a === "--out") { options.outPath = argv[++i]; }
    else if (a.startsWith("--out=")) options.outPath = a.slice("--out=".length);
    else throw new ExitFailure("USAGE");
  }
  if (!options.economicsPath || !options.outPath) throw new ExitFailure("USAGE");
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const artifact = await run(options);
  econ.atomicWriteJson(options.outPath, artifact);
  const s = artifact.summary;
  process.stdout.write(`${JSON.stringify({
    status: "OK",
    schema: artifact.schema,
    mode: artifact.mode,
    scannedAt: artifact.scannedAt,
    routePositiveRows: s.routePositiveRows,
    consumed: s.consumed,
    planned: s.planned,
    notSizable: s.notSizable,
    unsized: s.unsized,
    quoted: s.quoted,
    quotePartial: s.quotePartial,
    executableAfterSizing: s.executableAfterSizing,
    out: relPosix(options.outPath),
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`fluid exit-depth failed: ${error && error.code ? error.code : "SCAN_FAILED"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE, ECONOMICS_PATH, OUT_PATH, SCHEMA, VERSION, SCANNER, ECONOMICS_SCHEMA,
  MAX_ROWS, MAX_VENUES_PER_ASSET, MAX_QUOTES_PER_ROW, ONE27, VENUES, VENUE_SOURCES, IFACE,
  ExitFailure, relPosix, lower, big, venueFor,
  loadEconomics, routePositiveRows, pickCollAsset, sizeExit, feePlan, planRow,
  impactBps, liveRow, runLive, run, parseArgs, main,
};
