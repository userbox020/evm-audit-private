#!/usr/bin/env node
"use strict";

// Fluid Vault near-LT band liquidation-economics valuator (Stage-5, L class).
//
// Consumes the fresh surface produced by tools/scan-fluid-l.js
// (reports/raw/fast/fluid-l.json, schema fluid-l-observation/v1) and prices the
// would-be liquidation economics of the near/at-LT rows with the in-tree verified
// anchors of the vaultTypesCommon core liquidate path:
//
//   * colPerDebt (raw, 1e27) = 1e27 / getExchangeRateLiquidate()  -- the token-level
//     inverse of the contract's `temp_`/`temp2_` conversion
//     (vaultTypesCommon/coreModule/main.sol:88-114). The measured
//     `colPerUnitDebt_` slippage guard shape is main.sol:648
//     (`actualColAmt*1e18/actualDebtAmt < colPerUnitDebt_` => ExcessSlippageLiquidation).
//   * liquidation penalty is applied at main.sol:114
//     (`colPerDebt = (temp2_ * (10000 + penalty)) / 10000`); the stored penalty is
//     4-decimal bps (1e2 = 1%).
//   * exit price = per-vault oracle IFluidOracle.getExchangeRateLiquidate()
//     (main.sol:90-92), a 1e27 debt-per-col rate already decimal-adjusted
//     (targetDecimals): colRaw * rate / 1e27 = debtRaw.
//   * rounding semantics verified from the in-tree pin: total supply ROUND_DOWN,
//     total borrow ROUND_UP and branch debt ROUND_UP on the toBigNumber(56,8)
//     writes (main.sol:555, 699-700). These do not enter the token-level price
//     below (they are share-level), and are recorded as the rounding fact.
//
// Read-only. No signing, no transactions, no broadcasts, no external price API.
// RPC material stays process-only and is never printed or persisted. Nothing is
// fabricated: a row with a missing oracle rate, a non-USD debt token, or an
// unsizable exit is labelled fail-closed with null values.
//
// netDeltas is null until realizable (exit-depth-sized) deltas are proven; the
// per-row netUsdc is the oracle-based idealized USD estimate (upper bound),
// explicitly labelled non-executable.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc, loadRpcUrls, sanitizeError } = require("./shared-rpc");
const fluid = require("./scan-fluid-l.js");
const economics = require("./frax-usdc-cross-venue-economics");

const WORKSPACE = path.resolve(__dirname, "..");
const SURFACE_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "fluid-l.json");
const ARTIFACT_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "fluid-l-economics.json");
const CSV_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "fluid-l-economics.csv");
const DEPLOYMENTS = path.join(WORKSPACE, "targets", "fluid-contracts-public", "deployments");

const ARTIFACT_SCHEMA = "fluid-l-economics/v1";
const SURFACE_SCHEMA = "fluid-l-observation/v1";
const SCANNER = "tools/scan-fluid-l-economics.js";
const VERSION = 1;

const REQUEST_BUDGET = 120;
const MC_BATCH_ORACLE = 200;
const TIMEOUT_MS = 30_000;

// Exit-depth (DEX QuoterV2) artifact produced by tools/scan-fluid-exit-depth.js. When it
// exists and is fresh for this economics artifact, its per-row quotes are attached and the
// executable flag is recomputed. This is pure/offline (no network) and is exercised by
// --recompute; the live leg is --live-recompute (not auto-run).
const EXIT_DEPTH_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "fluid-exit-depth", "r1.json");
const EXIT_DEPTH_SCHEMA = "fluid-exit-depth/v1";
const EXIT_DEPTH_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// Conservative marginal-slippage ceiling for an executable exit (bps). The tool had no
// prior impact threshold; this explicit conservative default is used and can be overridden
// with --impact-threshold-bps=<n>. Impact is measured against the deepest (smallest) real
// quote point, so the 2x point reproduces the source artifact's priceImpactBps (half-vs-2x).
const CONSERVATIVE_IMPACT_THRESHOLD_BPS = 200;

const NEAR_LT_READINESS = Object.freeze(["NEAR_LT", "AT_OR_ABOVE_LT"]);
const ROUNDING_FACT = "toBigNumber(56,8): totalSupply ROUND_DOWN, totalBorrow ROUND_UP, branch debt ROUND_UP (vaultTypesCommon/coreModule/main.sol:555,699-700)";

// Chainlink ETH/USD reference feeds (8 decimals). A failed/absent read leaves
// gasBoundUsdc null (fail-closed), never a default.
const ETH_USD_FEEDS = Object.freeze({
  1: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  8453: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  42161: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
  137: "0xF9680D99D6C9589e2a93a78A04A279e509205945",
});

// Canonical USD stablecoin allowlist (address -> {symbol, decimals}). USD is only
// assumed for a debt token that is in this list; any other debt token is
// fail-closed (no external price API is used).
const USD_STABLES = Object.freeze({
  1: Object.freeze({
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
    "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6 },
    "0x6b175474e89094c44da98b954eedeac495271d0f": { symbol: "DAI", decimals: 18 },
    "0xdc035d45d973e3ec169d2276ddab16f1e407384f": { symbol: "USDS", decimals: 18 },
  }),
  8453: Object.freeze({
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6 },
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": { symbol: "USDbC", decimals: 6 },
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { symbol: "DAI", decimals: 18 },
  }),
  42161: Object.freeze({
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { symbol: "USDC", decimals: 6 },
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": { symbol: "USDT", decimals: 6 },
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": { symbol: "DAI", decimals: 18 },
  }),
  137: Object.freeze({
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { symbol: "USDC", decimals: 6 },
    "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": { symbol: "USDT", decimals: 6 },
    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063": { symbol: "DAI", decimals: 18 },
  }),
});

const I = Object.freeze({
  oracle: new ethers.Interface([
    "function getExchangeRateLiquidate() view returns (uint256)",
    "function getExchangeRateOperate() view returns (uint256)",
    "function infoName() view returns (string)",
    "function targetDecimals() view returns (uint8)",
  ]),
  chainlink: new ethers.Interface([
    "function decimals() view returns (uint8)",
    "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  ]),
  multicall: new ethers.Interface([
    "function aggregate3((address target,bool failure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])",
  ]),
});

let REQUEST_COUNT = 0;

class EconFailure extends Error {
  constructor(code) { super(code); this.name = "EconFailure"; this.code = code; }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function relPosix(target) { return path.relative(WORKSPACE, target).split(path.sep).join("/"); }
function lower(value) { try { return ethers.getAddress(String(value)).toLowerCase(); } catch (_) { return null; } }
function big(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function decodeOrNull(iface, fn, returnData) {
  try { return iface.decodeFunctionResult(fn, returnData); } catch (_) { return null; }
}
function sha256Hex(body) { return crypto.createHash("sha256").update(body).digest("hex"); }

async function call(rpc, method, params, ms = TIMEOUT_MS, attempts = 6) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    REQUEST_COUNT += 1;
    const result = await rpcCall(rpc, method, params, ms);
    if (result !== null && result !== undefined) return result;
    last = result;
    if (attempt < attempts - 1) await sleep(250 * (attempt + 1));
  }
  void last;
  throw new EconFailure("RPC_READ_FAILED");
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

async function multicall(rpc, blockTag, entries) {
  const results = new Array(entries.length);
  let failures = 0;
  for (let start = 0; start < entries.length; start += MC_BATCH_ORACLE) {
    const batch = entries.slice(start, start + MC_BATCH_ORACLE);
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

// --- oracle deployment-name map (in-tree, deterministic) ---------------------------------
function loadOracleNameMap(folder) {
  const dir = path.join(DEPLOYMENTS, folder);
  const map = {};
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.json$/i.test(e.name)) continue;
      if (!/Oracle/i.test(e.name)) continue;
      if (/VaultLiquidationResolver|VaultPositionsResolver|VaultTicksBranchesResolver/i.test(e.name)) continue;
      const j = fluid.readJson(full);
      if (!j || !j.address) continue;
      const addr = lower(j.address);
      if (!addr) continue;
      if (!map[addr]) map[addr] = e.name.replace(/\.json$/i, "");
    }
  };
  walk(dir);
  return map;
}

// Coarse oracle class from the in-tree deployment artifact name. The raw name is
// always recorded so a reviewer can re-derive; the class is a label, not a live read.
function classifyOracleName(name) {
  if (!name) return "unclassified";
  if (/Balancer/i.test(name)) return "balancer";
  if (/UniV3|CLRS|CLOracle|ColOracle|DebtOracle|Concentrated/i.test(name)) return "uniV3";
  if (/ChainlinkOracle/i.test(name)) return "chainlink";
  if (/Peg|GenericOracle|OracleL2|_L2_|L2$|Static|SUSDe|SUSDs|FluidOracle|WstETHOracle|WeETH/i.test(name)) return "peg-or-l2";
  return "unclassified";
}

// --- surface ingestion --------------------------------------------------------------------
function loadSurface(file = SURFACE_PATH) {
  const parsed = fluid.readJson(file);
  if (!parsed || parsed.schema !== SURFACE_SCHEMA || !Array.isArray(parsed.chains)) throw new EconFailure("SURFACE_INVALID");
  return parsed;
}

function collectNearLtRows(surface) {
  const rows = [];
  for (const chain of surface.chains || []) {
    for (const v of chain.vaults || []) {
      const readiness = v.ltPosture && v.ltPosture.ltReadiness;
      if (!NEAR_LT_READINESS.includes(readiness)) continue;
      rows.push({
        chainId: chain.chainId,
        label: chain.label,
        vault: v.vault,
        vaultId: v.vaultId,
        typeNumber: v.typeNumber,
        typeLabel: v.typeLabel,
        ltReadiness: readiness,
        ltBps: v.liquidationThresholdBps,
        penaltyBps: v.liquidationPenaltyBps,
        surfaceLtvBps: v.ltPosture ? v.ltPosture.aggregateLtvBps : null,
      });
    }
  }
  return rows;
}

// --- live reads ---------------------------------------------------------------------------
async function readOracleRates(rpc, blockTag, oracles) {
  const entries = [];
  for (const o of oracles) {
    entries.push({ to: o, data: I.oracle.encodeFunctionData("getExchangeRateLiquidate", []) });
    entries.push({ to: o, data: I.oracle.encodeFunctionData("getExchangeRateOperate", []) });
    entries.push({ to: o, data: I.oracle.encodeFunctionData("infoName", []) });
    entries.push({ to: o, data: I.oracle.encodeFunctionData("targetDecimals", []) });
  }
  const mc = await multicall(rpc, blockTag, entries);
  const out = new Map();
  oracles.forEach((o, k) => {
    const base = k * 4;
    const liq = mc.results[base];
    const op = mc.results[base + 1];
    const info = mc.results[base + 2];
    const td = mc.results[base + 3];
    const liqD = liq && liq.success ? decodeOrNull(I.oracle, "getExchangeRateLiquidate", liq.returnData) : null;
    const opD = op && op.success ? decodeOrNull(I.oracle, "getExchangeRateOperate", op.returnData) : null;
    const infoD = info && info.success ? decodeOrNull(I.oracle, "infoName", info.returnData) : null;
    const tdD = td && td.success ? decodeOrNull(I.oracle, "targetDecimals", td.returnData) : null;
    out.set(o, {
      liquidateRateRaw: liqD ? big(liqD[0]).toString() : null,
      operateRateRaw: opD ? big(opD[0]).toString() : null,
      infoName: infoD ? String(infoD[0]) : null,
      targetDecimals: tdD ? Number(tdD[0]) : null,
    });
  });
  return out;
}

async function readEthUsd(rpc, blockTag, chainId) {
  const feed = ETH_USD_FEEDS[chainId];
  if (!feed) return { raw: null, note: "NO_ETH_USD_FEED_FOR_CHAIN" };
  try {
    const dec = decodeOrNull(I.chainlink, "decimals", await call(rpc, "eth_call", [{ to: feed, data: I.chainlink.encodeFunctionData("decimals", []) }, blockTag]));
    const round = decodeOrNull(I.chainlink, "latestRoundData", await call(rpc, "eth_call", [{ to: feed, data: I.chainlink.encodeFunctionData("latestRoundData", []) }, blockTag]));
    const answer = round ? big(round[1]) : 0n;
    if (dec && Number(dec[0]) === 8 && answer > 0n) return { raw: answer.toString(), note: null };
    return { raw: null, note: "ORACLE_INVALID" };
  } catch (_) {
    return { raw: null, note: "ORACLE_UNAVAILABLE" };
  }
}

// --- economics ----------------------------------------------------------------------------
function negativeMaxLens(typeNumber) {
  if (typeNumber !== 2 && typeNumber !== 4) return null;
  return "vulnerable-per-pin";
}

function baseRow(row, oracleInfo, oracleName, extra) {
  return {
    chainId: row.chainId,
    vault: row.vault,
    vaultId: row.vaultId,
    type: row.typeLabel,
    typeNumber: row.typeNumber,
    LT: row.ltBps,
    negativeMaxLens: negativeMaxLens(row.typeNumber),
    debtValued: null,
    colValued: null,
    penalty: row.penaltyBps,
    routePositive: null,
    routeSource: null,
    gasBoundUsdc: null,
    netUsdc: null,
    verdict: "UNPRICED",
    ...extra,
    oracleClass: classifyOracleName(oracleName),
    oracleDeploymentName: oracleName || null,
    oracleInfoName: oracleInfo ? oracleInfo.infoName : null,
    oracleTargetDecimals: oracleInfo ? oracleInfo.targetDecimals : null,
    oracleRateLiquidateRaw: oracleInfo ? oracleInfo.liquidateRateRaw : null,
    oracleRateOperateRaw: oracleInfo ? oracleInfo.operateRateRaw : null,
    stalenessGuards: "none (no staleness/deviation guard on the Fluid oracle path; L2-side only the sequencer-path guard applies)",
    roundingSemantics: ROUNDING_FACT,
  };
}

function valueRow(row, live, oracleInfo, oracleName, gasBoundUsdcRaw) {
  const oracle = live ? live.oracle : null;
  const liveInfo = oracleInfo || null;
  const rateRaw = liveInfo && liveInfo.liquidateRateRaw ? big(liveInfo.liquidateRateRaw) : null;
  const common = {
    oracle,
    debtToken: live ? (live.borrowToken0 || live.borrowToken1 || null) : null,
    colToken0: live ? live.supplyToken0 : null,
    colToken1: live ? live.supplyToken1 : null,
    debtToken0: live ? live.borrowToken0 : null,
    debtToken1: live ? live.borrowToken1 : null,
    gasBoundUsdc: gasBoundUsdcRaw === null ? null : gasBoundUsdcRaw.toString(),
  };
  if (!live || live.resolverResolved !== true) {
    return baseRow(row, liveInfo, oracleName, { ...common, valuationStatus: "UNRESOLVED_NO_DEEPER_READ", valuationReason: "resolver-unresolved", usdAssumed: false });
  }
  if (rateRaw === null || rateRaw === 0n) {
    return baseRow(row, liveInfo, oracleName, { ...common, valuationStatus: "UNRESOLVED_NO_DEEPER_READ", valuationReason: "oracle-rate-unavailable", usdAssumed: false });
  }
  const supply = big(live.totalSupplyVaultRaw);
  const borrow = big(live.totalBorrowVaultRaw);
  if (supply === 0n || borrow === 0n) {
    return baseRow(row, liveInfo, oracleName, { ...common, valuationStatus: "UNRESOLVED_NO_DEEPER_READ", valuationReason: supply === 0n ? "no-collateral" : "no-debt", usdAssumed: false });
  }
  // colValued in raw debt-token units (1e27 debt-per-col rate is decimal-adjusted).
  const colValuedDebtRaw = (supply * rateRaw) / (10n ** 27n);
  const debtValuedRaw = borrow;
  const penaltyBps = BigInt(live.liquidationPenaltyBps);
  const grossBonusDebtRaw = (debtValuedRaw * penaltyBps) / 10000n;
  const colPerDebtRaw = (10n ** 27n) / rateRaw; // 1e27 col per unit debt at the liquidate rate

  const debtTok = common.debtToken;
  const stable = debtTok ? (USD_STABLES[row.chainId] || {})[debtTok] : null;

  const withVals = baseRow(row, liveInfo, oracleName, {
    ...common,
    debtValued: debtValuedRaw.toString(),
    colValued: colValuedDebtRaw.toString(),
    colPerDebtLiquidateRaw: colPerDebtRaw.toString(),
    grossBonusDebtRaw: grossBonusDebtRaw.toString(),
    valuationUnit: stable ? `USD (debt token ${stable.symbol})` : "debt-token-raw (no USD anchor)",
    usdAssumed: Boolean(stable),
    debtTokenSymbol: stable ? stable.symbol : null,
    debtTokenDecimals: stable ? stable.decimals : null,
    valuationStatus: "PRICED_ORACLE_IDEALIZED",
    valuationReason: null,
  });
  if (!stable) {
    return {
      ...withVals,
      routePositive: null,
      routeSource: "FAIL_CLOSED_DEBT_TOKEN_NOT_USD",
      netUsdc: null,
      verdict: "FAIL_CLOSED_DEBT_TOKEN_NOT_USD",
    };
  }
  const scale = 10n ** BigInt(stable.decimals);
  // debt-raw (stable, 1 USD assumed) -> USDC raw (6 dp)
  const grossBonusUsdcRaw = (grossBonusDebtRaw * (10n ** 6n)) / scale;
  const gas = gasBoundUsdcRaw === null ? null : BigInt(gasBoundUsdcRaw);
  const netUsdc = gas === null ? null : (grossBonusUsdcRaw - gas);
  const routePositive = netUsdc === null ? null : netUsdc > 0n;
  return {
    ...withVals,
    grossBonusUsdcRaw: grossBonusUsdcRaw.toString(),
    routePositive,
    routeSource: "oracle-getExchangeRateLiquidate-idealized-collateral-exit (exit depth UNSIZED; non-executable)",
    netUsdc: netUsdc === null ? null : netUsdc.toString(),
    executable: false,
    exitDepthSized: false,
    verdict: netUsdc === null
      ? "FAIL_CLOSED_GAS_UNPRICED"
      : (routePositive ? "IDEALIZED_ORACLE_NET_POSITIVE_EXIT_DEPTH_UNSIZED" : "IDEALIZED_ORACLE_NET_NEGATIVE"),
  };
}

// --- exit-depth (DEX QuoterV2) attachment -------------------------------------------------
// Attaches tools/scan-fluid-exit-depth.js output to the matching row (chainId+vault) and
// recomputes `executable` from real quotes. Pure: reads artifacts only, never the network.
// Conservative net model (in USDC 6dp raw units):
//   netAtQuotedSize = exitProceeds(outQuoted @ size) - debtRepaid(debtValued scaled by size/collSize) - gasBoundUsdc
//   executable = netAtQuotedSize > 0 AND priceImpact at the quoted size <= threshold
// No penalty credit is added (strict). Missing quote / non-USD debt token / missing gas =>
// null net, class UNDETERMINED, executable false (fail-closed).
const EXIT_SWEEP_FRACTIONS = Object.freeze([
  { label: "full", num: 1n, den: 1n },
  { label: "3/4", num: 3n, den: 4n },
  { label: "1/2", num: 1n, den: 2n },
  { label: "1/4", num: 1n, den: 4n },
  { label: "1/8", num: 1n, den: 8n },
]);

function loadExitDepth(file = EXIT_DEPTH_PATH) {
  if (!fs.existsSync(file)) return { exists: false, path: file, artifact: null };
  const parsed = fluid.readJson(file);
  if (!parsed || parsed.schema !== EXIT_DEPTH_SCHEMA || !Array.isArray(parsed.rows)) {
    throw new EconFailure("EXIT_DEPTH_INVALID");
  }
  return { exists: true, path: file, artifact: parsed };
}

// Freshness is a PIN identity: the exit-depth source scannedAt must equal the economics
// generation it was produced from, plus a wall-age bound on the quote capture itself.
function exitDepthFreshness(exitDepth, economicsArtifact, nowMs = Date.now()) {
  const ed = exitDepth.artifact;
  const info = {
    path: relPosix(exitDepth.path), exists: exitDepth.exists,
    schema: ed ? ed.schema : null,
    scannedAt: ed ? (ed.scannedAt || null) : null,
    sourceScannedAt: ed && ed.source ? (ed.source.scannedAt || null) : null,
    sourcePath: ed && ed.source ? (ed.source.path || null) : null,
    economicsGeneratedAt: economicsArtifact ? (economicsArtifact.generatedAt || null) : null,
    maxAgeMs: EXIT_DEPTH_MAX_AGE_MS, ageMs: null, fresh: false, reason: null,
  };
  if (!ed) { info.reason = "EXIT_DEPTH_MISSING"; return info; }
  const src = info.sourceScannedAt;
  const gen = info.economicsGeneratedAt;
  if (!src || !gen || src !== gen) { info.reason = "EXIT_DEPTH_PIN_MISMATCH"; return info; }
  const ageMs = info.scannedAt ? (nowMs - Date.parse(info.scannedAt)) : NaN;
  if (Number.isNaN(ageMs)) { info.reason = "EXIT_DEPTH_UNPARSEABLE_TIMESTAMP"; return info; }
  info.ageMs = Math.max(0, ageMs);
  if (info.ageMs > EXIT_DEPTH_MAX_AGE_MS) { info.reason = "EXIT_DEPTH_STALE_AGE"; return info; }
  info.fresh = true;
  info.reason = "FRESH_MATCHES_ECONOMICS_GENERATION";
  return info;
}

function toSixDpRaw(raw, decimals) {
  if (raw === null || raw === undefined) return null;
  const d = BigInt(decimals);
  const v = BigInt(raw);
  if (d === 6n) return v;
  if (d < 6n) return v * (10n ** (6n - d));
  return v / (10n ** (d - 6n));
}

function price18(outRaw, sizeRaw) {
  if (outRaw === null || sizeRaw === null || sizeRaw <= 0n) return null;
  return (BigInt(outRaw) * (10n ** 18n)) / BigInt(sizeRaw);
}

// Impact of the average execution price at a size vs the reference (deepest) price, in bps.
// Never negative (a better-than-reference price is 0). The 2x point reproduces the source
// artifact's half-vs-2x priceImpactBps by construction.
function impactVsRefBps(refPrice, price) {
  if (refPrice === null || price === null || refPrice <= 0n) return null;
  const diff = refPrice >= price ? refPrice - price : 0n;
  return Number((diff * 10000n) / refPrice);
}

function bigSortAsc(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// Linear interpolation of `out` at `size` between real quote points only. No extrapolation.
function interpOut(points, size) {
  for (const p of points) if (p.size === size) return { out: p.out, interpolated: false, source: "exact-quote" };
  const asc = points.slice().sort((a, b) => bigSortAsc(a.size, b.size));
  if (asc.length === 0) return { out: null, interpolated: false, source: "no-quote-support" };
  if (size < asc[0].size || size > asc[asc.length - 1].size) return { out: null, interpolated: false, source: "OUT_OF_QUOTE_SUPPORT_NO_EXTRAPOLATION" };
  for (let i = 0; i < asc.length - 1; i += 1) {
    const lo = asc[i]; const hi = asc[i + 1];
    if (size > lo.size && size < hi.size) {
      const out = lo.out + ((hi.out - lo.out) * (size - lo.size)) / (hi.size - lo.size);
      return { out, interpolated: true, source: `linear(${lo.label}->${hi.label})` };
    }
  }
  return { out: null, interpolated: false, source: "no-bracket" };
}

function labelForSize(size, collSize) {
  if (collSize === null || collSize <= 0n) return size.toString();
  if (size === collSize) return "full";
  if (size * 2n === collSize) return "half";
  if (size === collSize * 2n) return "2x";
  return size.toString();
}

function buildExitDepthSection(econRow, edRow, gasBoundUsdcRaw, thresholdBps, opts = {}) {
  const venues = Array.isArray(edRow.venues) ? edRow.venues : [];
  const primaryVenue = venues[0] || null;
  const debtToken = lower(edRow.debtAsset) || lower(econRow.debtToken);
  const stable = debtToken ? ((USD_STABLES[econRow.chainId] || {})[debtToken] || null) : null;
  const collSize = edRow.collSize === null || edRow.collSize === undefined ? null : big(edRow.collSize);
  const debtValued = econRow.debtValued === null || econRow.debtValued === undefined ? null : big(econRow.debtValued);
  const gas = gasBoundUsdcRaw === null || gasBoundUsdcRaw === undefined ? null : BigInt(gasBoundUsdcRaw);

  const section = {
    source: relPosix(EXIT_DEPTH_PATH),
    schema: EXIT_DEPTH_SCHEMA,
    scannedAt: opts.edScannedAt || null,
    state: edRow.state || null,
    stateReason: edRow.stateReason || null,
    venue: primaryVenue ? { pool: primaryVenue.pool || null, fee: primaryVenue.fee ?? null, liquidityRaw: primaryVenue.liquidityRaw ?? null } : null,
    legacyPriceImpactBps: primaryVenue ? (primaryVenue.priceImpactBps ?? null) : null,
    collAsset: edRow.collAsset || null,
    collSize: collSize === null ? null : collSize.toString(),
    collSizeApproximate: edRow.collSizeApproximate === true,
    debtAsset: debtToken,
    debtTokenSymbol: stable ? stable.symbol : null,
    debtValuedRaw: debtValued === null ? null : debtValued.toString(),
    impactThresholdBps: thresholdBps,
    sizeQuoted: null, outQuoted: null, impactBps: null,
    netAtQuotedSize: null, executableAtQuotedSize: false, netClass: "UNDETERMINED",
    quoteSupport: null, sizePoints: [], sweep: null,
    freshForPin: opts.freshForPin !== false,
    model: "netAtQuotedSize = exitProceeds(outQuoted -> USDC 6dp) - debtRepaid(debtValued scaled by sizeQuoted/collSize) - gasBoundUsdc; strict (no penalty credit, full-debt repayment at the primary size); class UNDETERMINED when a usable quote, the debt-token USD decimals, or gas is missing (fail-closed).",
    caveats: [],
  };
  if (!stable) section.caveats.push("debt token not on the canonical USD stablecoin allowlist: no USDC net computed (fail-closed)");
  if (edRow.collSizeApproximate === true) section.caveats.push("collSize is reconstructed floor(colValued*1e27/rateLiquidate) (not the vault stored supply raw) and the exit leg is a single non-debt collateral leg; treat netAtQuotedSize as approximate");
  if (opts.freshForPin === false) section.caveats.push("exit-depth quotes predate this economics pin/refresh: freshForPin=false, executable forced false (fail-closed)");

  const pts = [];
  for (const p of (primaryVenue && primaryVenue.quotedOutAtSizes) || []) {
    if (!p || p.amountOut === null || p.amountOut === undefined) continue;
    if (p.size === null || p.size === undefined) continue;
    const size = big(p.size);
    if (size <= 0n) continue;
    pts.push({ size, out: big(p.amountOut), label: labelForSize(size, collSize) });
  }
  if (pts.length === 0) {
    section.caveats.push("no usable QuoterV2 quote on the primary venue (state=" + String(edRow.state) + "): net UNDETERMINED");
    return section;
  }

  const ref = pts.slice().sort((a, b) => bigSortAsc(a.size, b.size))[0];
  const refPrice = price18(ref.out, ref.size);
  const debt6 = stable && debtValued !== null ? toSixDpRaw(debtValued, stable.decimals) : null;
  const canNet = Boolean(stable) && gas !== null && debt6 !== null && collSize !== null && collSize > 0n;

  const sizePoints = pts.map((p) => {
    const price = price18(p.out, p.size);
    const impactBps = impactVsRefBps(refPrice, price);
    let net = null;
    if (canNet) {
      const out6 = toSixDpRaw(p.out, stable.decimals);
      const debtRepaid = (debt6 * p.size) / collSize;
      net = out6 - debtRepaid - gas;
    }
    return {
      label: p.label, size: p.size.toString(), out: p.out.toString(),
      price18: price === null ? null : price.toString(),
      impactBps, netUsdcRaw: net === null ? null : net.toString(),
      qualifies: net !== null && net > 0n && impactBps !== null && impactBps <= thresholdBps,
    };
  });

  const fullStr = collSize === null ? null : collSize.toString();
  const primary = sizePoints.find((sp) => fullStr !== null && sp.size === fullStr)
    || sizePoints.slice().sort((a, b) => bigSortAsc(big(b.size), big(a.size)))[0];
  section.sizeQuoted = primary.size;
  section.outQuoted = primary.out;
  section.impactBps = primary.impactBps;
  section.netAtQuotedSize = primary.netUsdcRaw;
  section.executableAtQuotedSize = primary.qualifies === true && section.freshForPin === true;
  section.netClass = primary.netUsdcRaw === null ? "UNDETERMINED" : (big(primary.netUsdcRaw) > 0n ? "POSITIVE" : "NEGATIVE");
  section.sizePoints = sizePoints;
  section.quoteSupport = {
    pointCount: pts.length,
    realPointLabels: pts.slice().sort((a, b) => bigSortAsc(a.size, b.size)).map((p) => p.label),
    smallestQuotedSize: ref.size.toString(),
    largestQuotedSize: pts.slice().sort((a, b) => bigSortAsc(a.size, b.size))[pts.length - 1].size.toString(),
    impactReference: "average execution price at each size vs the deepest (smallest) real quote point",
  };

  if (opts.sweepRole) {
    const sweepPoints = EXIT_SWEEP_FRACTIONS.map((f) => {
      const size = collSize === null || collSize <= 0n ? null : (collSize * f.num) / f.den;
      if (size === null || size <= 0n) {
        return { label: f.label, size: null, interpolated: false, quoteSource: "NO_SIZE", out: null, impactBps: null, netUsdcRaw: null, qualifies: false };
      }
      const r = interpOut(pts, size);
      let impactBps = null; let net = null;
      if (r.out !== null) {
        impactBps = impactVsRefBps(refPrice, price18(r.out, size));
        if (canNet) net = toSixDpRaw(r.out, stable.decimals) - (debt6 * size) / collSize - gas;
      }
      return {
        label: f.label, size: size.toString(), interpolated: r.interpolated, quoteSource: r.source,
        out: r.out === null ? null : r.out.toString(), impactBps,
        netUsdcRaw: net === null ? null : net.toString(),
        qualifies: net !== null && net > 0n && impactBps !== null && impactBps <= thresholdBps,
      };
    });
    let largest = null;
    for (const s of sweepPoints) {
      if (s.out === null || s.impactBps === null || s.impactBps > thresholdBps) continue;
      if (!largest || big(s.size) > big(largest.size)) largest = s;
    }
    section.sweep = {
      role: opts.sweepRole.role,
      selectionReason: opts.sweepRole.selectionReason,
      fractions: EXIT_SWEEP_FRACTIONS.map((f) => f.label),
      interpolation: "linear between the three real quote points only (full/half/2x); a size below the smallest real quote is NOT extrapolated",
      points: sweepPoints,
      largestSizeWithImpactAtOrBelowThreshold: largest ? {
        label: largest.label, size: largest.size, out: largest.out, impactBps: largest.impactBps,
        netUsdcRaw: largest.netUsdcRaw,
        netClass: largest.netUsdcRaw === null ? "UNDETERMINED" : (big(largest.netUsdcRaw) > 0n ? "POSITIVE" : "NEGATIVE"),
      } : null,
      largestSizeNote: largest ? null : "no sweep size has both a usable (exact/interpolated) quote and impact at/below the threshold",
    };
  }
  return section;
}

// The "knee" row: a QUOTED row with all real quote points and the smallest finite
// priceImpactBps (the healthiest observed exit); drives the size sweep.
function selectKneeRow(edRows) {
  const cand = (edRows || []).filter((r) => r && r.state === "QUOTED"
    && Array.isArray(r.venues) && r.venues[0] && Array.isArray(r.venues[0].quotedOutAtSizes)
    && r.venues[0].quotedOutAtSizes.some((p) => p && p.amountOut !== null && p.amountOut !== undefined)
    && r.venues[0].priceImpactBps !== null && r.venues[0].priceImpactBps !== undefined);
  if (!cand.length) return null;
  cand.sort((a, b) => a.venues[0].priceImpactBps - b.venues[0].priceImpactBps);
  return cand[0];
}

function attachExitDepth(artifact, exitDepth, options = {}) {
  const now = options.now || Date.now();
  const thresholdBps = options.thresholdBps ?? CONSERVATIVE_IMPACT_THRESHOLD_BPS;
  const info = { thresholdBps, ...exitDepthFreshness(exitDepth, artifact, now), attached: false, attachedStale: false, rowsWithExitDepth: 0, executableAfterExitDepth: 0 };
  if (!exitDepth.exists || !exitDepth.artifact) return info;
  if (!info.fresh && options.allowStale !== true) return info;
  const ed = exitDepth.artifact;
  const byKey = new Map();
  for (const r of ed.rows || []) {
    if (!r || r.vault === undefined || r.vault === null) continue;
    byKey.set(`${r.chainId}:${String(lower(r.vault))}`, r);
  }
  const knee = selectKneeRow(ed.rows || []);
  const kneeKey = knee ? `${knee.chainId}:${String(lower(knee.vault))}` : null;
  const freshForPin = info.fresh === true;
  let withDepth = 0;
  for (const econRow of artifact.rows || []) {
    const key = `${econRow.chainId}:${String(lower(econRow.vault))}`;
    const edRow = byKey.get(key);
    if (!edRow) continue;
    const sweepRole = key === kneeKey ? {
      role: edRow.chainId === 42161 ? "arbitrum-knee" : `chain${edRow.chainId}-lowest-impact-quoted`,
      selectionReason: "QUOTED row with the smallest finite priceImpactBps among rows with usable quotes (deepest healthy exit); sweep interpolates only between the three real quote points (full/half/2x), no extrapolation",
    } : null;
    const section = buildExitDepthSection(econRow, edRow, econRow.gasBoundUsdc, thresholdBps, { sweepRole, edScannedAt: ed.scannedAt || null, freshForPin });
    econRow.exitDepth = section;
    econRow.exitDepthSized = true;
    econRow.executable = section.executableAtQuotedSize === true;
    withDepth += 1;
  }
  info.attached = true;
  info.attachedStale = !freshForPin;
  info.rowsWithExitDepth = withDepth;
  info.executableAfterExitDepth = (artifact.rows || []).filter((r) => r.executable === true).length;
  return info;
}

function exitDepthInfoBlock(exitDepth, info) {
  return {
    path: relPosix(EXIT_DEPTH_PATH),
    schema: EXIT_DEPTH_SCHEMA,
    exists: info.exists === true,
    fresh: info.fresh === true,
    reason: info.reason || null,
    sourceScannedAt: info.sourceScannedAt || null,
    economicsGeneratedAt: info.economicsGeneratedAt || null,
    scannedAt: info.scannedAt || null,
    ageMs: info.ageMs ?? null,
    maxAgeMs: info.maxAgeMs ?? EXIT_DEPTH_MAX_AGE_MS,
    impactThresholdBps: info.thresholdBps ?? CONSERVATIVE_IMPACT_THRESHOLD_BPS,
    attached: info.attached === true,
    attachedStale: info.attachedStale === true,
    rowsWithExitDepth: info.rowsWithExitDepth ?? 0,
    executableAfterExitDepth: info.executableAfterExitDepth ?? 0,
  };
}

function applyExitDepth(artifact, options = {}) {
  const exitDepth = loadExitDepth(options.exitDepthPath || EXIT_DEPTH_PATH);
  const info = attachExitDepth(artifact, exitDepth, {
    thresholdBps: options.thresholdBps,
    allowStale: options.allowStale === true,
  });
  artifact.exitDepth = exitDepthInfoBlock(exitDepth, info);
  if (Array.isArray(artifact.rows)) artifact.summary.executable = artifact.rows.filter((r) => r.executable === true).length;
  artifact.summary.exitDepthAttached = info.attached === true;
  artifact.summary.exitDepthAttachedStale = info.attachedStale === true;
  artifact.summary.exitDepthRows = info.rowsWithExitDepth;
  artifact.summary.executableAfterExitDepth = info.executableAfterExitDepth;
  return info;
}

// --- artifact -----------------------------------------------------------------------------
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
  "chainId", "vault", "vaultId", "type", "LT", "negativeMaxLens", "penalty",
  "debtValued", "colValued", "oracleClass", "oracleDeploymentName", "usdAssumed",
  "gasBoundUsdc", "netUsdc", "routePositive", "routeSource", "verdict",
];

function csvBody(rows) {
  const lines = rows.map((r) => CSV_HEADER.map((h) => {
    const v = r[h];
    return v === null || v === undefined ? "" : String(v);
  }).join(","));
  return `${[CSV_HEADER.join(","), ...lines].join("\n")}\n`;
}

function writeCsvVersioned(rows, file) {
  const body = csvBody(rows);
  const sha = sha256Hex(body);
  const base = { sha256: sha, rowCount: rows.length, canonicalHash: fluid.canonicalHash(rows) };
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

// --- orchestration ------------------------------------------------------------------------
async function valuate(options = {}) {
  const startMs = Date.now();
  const surface = options.surface || loadSurface(options.surfacePath || SURFACE_PATH);
  const nearRows = collectNearLtRows(surface);
  const chainIds = [...new Set(nearRows.map((r) => r.chainId))].sort((a, b) => a - b);

  const chainResults = [];
  const pricedRows = [];
  let pinnedHashes = [];
  const reusePins = options.pins || null;

  for (const chainId of chainIds) {
    const chainStart = REQUEST_COUNT;
    const label = fluid.CHAINS[chainId] ? fluid.CHAINS[chainId].label : `c${chainId}`;
    const rows = nearRows.filter((r) => r.chainId === chainId);
    const deployments = fluid.loadChainDeployments(fluid.CHAINS[chainId].folder);
    const result = { chainId, label, vaults: rows.length, pin: null, error: null, reads: 0, oracleMapSize: 0 };
    try {
      const rpc = options.rpcFor ? options.rpcFor(chainId) : await resolveWorkingRpc(chainId);
      if (!rpc) throw new EconFailure("RPC_UNAVAILABLE");
      const pinnedHash = reusePins && reusePins[chainId] ? reusePins[chainId] : null;
      let blockForFee;
      if (pinnedHash) {
        blockForFee = await call(rpc, "eth_getBlockByHash", [pinnedHash, false]);
        if (!blockForFee || !blockForFee.hash) throw new EconFailure("PIN_UNAVAILABLE");
      } else {
        blockForFee = await fluid.selectFinalized(rpc);
      }
      const finalizedNumber = Number(big(blockForFee.number));
      const blockTag = blockForFee.hash;
      const baseFeeRaw = blockForFee.baseFeePerGas ? big(blockForFee.baseFeePerGas) : 0n;
      result.pin = { number: finalizedNumber, hash: blockTag, timestamp: fluid.toIso(blockForFee.timestamp), finality: pinnedHash ? "reused-pin" : "finalized", baseFeePerGasRaw: baseFeeRaw.toString() };
      pinnedHashes.push(blockTag);

      const resolver = deployments.resolver;
      let resolverIface = null;
      if (resolver && deployments.resolverAbi) {
        try { resolverIface = new ethers.Interface(deployments.resolverAbi); } catch (_) { resolverIface = null; }
      }
      if (!resolver || !resolverIface) throw new EconFailure("RESOLVER_UNRESOLVED");

      const vaults = rows.map((r) => r.vault);
      const live = await fluid.readVaultLive(rpc, blockTag, resolver, resolverIface, vaults);
      const oracles = [];
      for (const v of vaults) {
        const l = live.live.get(v);
        if (l && l.resolverResolved === true && l.oracle) oracles.push(l.oracle);
      }
      const uniqueOracles = [...new Set(oracles)];
      const oracleInfo = await readOracleRates(rpc, blockTag, uniqueOracles);
      const ethUsd = await readEthUsd(rpc, blockTag, chainId);
      const gasBound = ethUsd.raw === null ? null : economics.gasCeilingUsdcRaw(baseFeeRaw, BigInt(ethUsd.raw));
      result.ethUsdRaw = ethUsd.raw;
      result.ethUsdNote = ethUsd.note;
      result.gasBoundUsdcRaw = gasBound === null ? null : gasBound.toString();

      const oracleNameMap = loadOracleNameMap(fluid.CHAINS[chainId].folder);
      result.oracleMapSize = Object.keys(oracleNameMap).length;

      for (const r of rows) {
        const l = live.live.get(r.vault) || { resolverResolved: false };
        const oracle = l.oracle || null;
        const oName = oracle ? (oracleNameMap[oracle] || null) : null;
        const oInfo = oracle ? (oracleInfo.get(oracle) || null) : null;
        pricedRows.push(valueRow(r, l, oInfo, oName, gasBound));
      }
      result.liveFailures = live.failures;
    } catch (e) {
      result.error = sanitizeError(e, e && e.code ? String(e.code).toLowerCase() : "chain-error");
      for (const r of rows) {
        pricedRows.push(baseRow(r, null, null, { valuationStatus: "UNRESOLVED_NO_DEEPER_READ", valuationReason: "chain-read-failed", usdAssumed: false, oracle: null }));
      }
    }
    result.reads = REQUEST_COUNT - chainStart;
    chainResults.push(result);
  }

  pricedRows.sort((a, b) => (a.chainId - b.chainId) || String(a.vault).localeCompare(String(b.vault)));

  const csv = writeCsvVersioned(pricedRows, options.csvPath || CSV_PATH);

  const verdictCounts = {};
  for (const r of pricedRows) verdictCounts[r.verdict] = (verdictCounts[r.verdict] || 0) + 1;
  const oracleClassCounts = {};
  for (const r of pricedRows) oracleClassCounts[r.oracleClass] = (oracleClassCounts[r.oracleClass] || 0) + 1;
  const routePositiveRows = pricedRows.filter((r) => r.routePositive === true);
  const netUsdcRows = pricedRows.filter((r) => r.netUsdc !== null);
  const nearT2T4 = pricedRows.filter((r) => r.negativeMaxLens === "vulnerable-per-pin");
  const allPriced = pricedRows.length > 0 && pricedRows.every((r) => r.valuationStatus === "PRICED_ORACLE_IDEALIZED");
  const allUsdNet = allPriced && pricedRows.every((r) => r.netUsdc !== null);

  const honestAbsences = [
    "netDeltas is null: the realizable (exit-depth-sized) liquidation delta is NOT claimed. Every netUsdc is the oracle-based IDEALIZED upper bound (collateral exited at the liquidate oracle rate, no DEX depth), and is labelled non-executable.",
    "The T2/T4 negative-max lens is a compile fact of the in-tree pin (mainOperate.sol:51 / :88); NO live confirmation is available from this surface. Every T2/T4 near/at-LT row is labelled negativeMaxLens: vulnerable-per-pin (compile-fact only).",
    "No staleness/deviation guard exists on the Fluid oracle path; only the L2-side sequencer-path guard applies. This is a code/config fact, not a live freshness proof.",
    "USD is assumed only for debt tokens on the canonical stablecoin allowlist; any other debt token is fail-closed (FAIL_CLOSED_DEBT_TOKEN_NOT_USD) with null netUsdc. No external price API is used.",
    `toBigNumber(56,8) rounding (${ROUNDING_FACT}) is a share-level write and does not enter the token-level oracle price recorded here.`,
  ];
  const unpriced = pricedRows.filter((r) => r.valuationStatus !== "PRICED_ORACLE_IDEALIZED").length;
  if (unpriced > 0) honestAbsences.push(`${unpriced} row(s) are unpriced (oracle rate / resolver / chain read unavailable): recorded UNRESOLVED_NO_DEEPER_READ, never guessed.`);
  if (!allPriced) honestAbsences.push("netDeltas stays null because not every row is honestly priced; no partial aggregate is fabricated.");
  else if (!allUsdNet) honestAbsences.push(`${pricedRows.length - netUsdcRows.length} priced row(s) have a non-USD debt token and therefore no netUsdc; netDeltas stays null (no partial aggregate).`);

  const artifact = {
    schema: ARTIFACT_SCHEMA,
    version: VERSION,
    generatedAt: new Date().toISOString(),
    scanner: SCANNER,
    scope: "Read-only Fluid Vault near/at-LT band would-be liquidation economics (oracle-based idealized; no signing/execution)",
    safety: {
      readOnly: true, signedActions: false, transactions: false, endpointMaterialPersisted: false,
      privateKeysRead: false, externalPriceApi: false, fetchPriceUsed: false, forkTransactions: false, routePositive: routePositiveRows.length > 0,
    },
    source: {
      path: relPosix(options.surfacePath || SURFACE_PATH),
      schema: surface.schema,
      scannedAt: surface.scannedAt,
      nearAtLtRows: nearRows.length,
    },
    // Fail-closed until realizable deltas are proven; per-row netUsdc is idealized.
    netDeltas: null,
    netDeltasReason: allPriced
      ? "FAIL_CLOSED_EXIT_DEPTH_UNSIZED: realizable delta requires exit-depth sizing (DEX quotes) outside this lane's budget; per-row netUsdc is the idealized oracle upper bound only."
      : "FAIL_CLOSED_INCOMPLETE_PRICING: at least one row is not honestly priced.",    model: {
      exchangeRateSource: "IFluidOracle.getExchangeRateLiquidate() (vaultTypesCommon/coreModule/main.sol:90-92), 1e27 debt-per-col, decimal-adjusted via targetDecimals",
      colPerDebtFormula: "colPerDebtRaw = 1e27 / rate  (inverse of the contract's temp_/temp2_ conversion, main.sol:88-114)",
      penaltyFormula: "grossBonus(debt units) = debtValued * penaltyBps / 10000  (penalty applied at main.sol:114; stored 4-decimal bps)",
      slippageGuard: "colPerUnitDebt_ guard shape at main.sol:648: actualColAmt*1e18/actualDebtAmt < colPerUnitDebt_ => ExcessSlippageLiquidation (liquidator min col-per-debt; not the vault's own bound)",
      debtValuedFormula: "debtValued = totalBorrowVault (raw debt-token units, resolver getVaultEntireData)",
      colValuedFormula: "colValued = totalSupplyVault * rate / 1e27 (raw debt-token units)",
      netUsdcFormula: "netUsdc = grossBonusUsdcRaw - gasBoundUsdc (only when the debt token is a canonical USD stablecoin)",
      gasPolicy: {
        gasCeiling: economics.GAS_CEILING.toString(),
        baseFeeMultiplierNumerator: "9", baseFeeMultiplierDenominator: "8",
        priorityFeeWei: economics.PRIORITY_FEE_WEI.toString(),
      },
      roundingSemantics: ROUNDING_FACT,
      sources: [
        "targets/fluid-contracts-public/contracts/protocols/vault/vaultTypesCommon/coreModule/main.sol:88-114 (oracle rate + penalty)",
        "targets/fluid-contracts-public/contracts/protocols/vault/vaultTypesCommon/coreModule/main.sol:648 (colPerUnitDebt_ slippage guard)",
        "targets/fluid-contracts-public/contracts/protocols/vault/vaultTypesCommon/coreModule/main.sol:555,699-700 (toBigNumber(56,8) rounding)",
        "targets/fluid-contracts-public/contracts/oracle/interfaces/iFluidOracle.sol:9-21 (getExchangeRateLiquidate / targetDecimals)",
        "reports/critical-fluid-vaultt2-t4-smart-collateral-negative-max-r2.md (FLUID-VT2T4-L01)",
      ],
      note: "The would-be liquidation is priced ONLY at the vault's own oracle (no DEX exit depth). netUsdc is therefore an idealized upper bound, never an executable route.",
    },
    budget: {
      requestBudget: REQUEST_BUDGET,
      requests: REQUEST_COUNT,
      withinBudget: REQUEST_COUNT <= REQUEST_BUDGET,
      sequential: true,
      wallMs: Date.now() - startMs,
      pinsReused: false,
      chainReads: chainResults.map((c) => ({ chainId: c.chainId, reads: c.reads })),
    },
    summary: {
      nearAtLtRows: nearRows.length,
      rows: pricedRows.length,
      pricedOracleIdealized: pricedRows.filter((r) => r.valuationStatus === "PRICED_ORACLE_IDEALIZED").length,
      unpriced,
      usdAssumedRows: pricedRows.filter((r) => r.usdAssumed === true).length,
      netUsdcRows: netUsdcRows.length,
      routePositive: routePositiveRows.length,
      executable: 0,
      nearT2T4NegativeMax: nearT2T4.length,
      verdictCounts,
      oracleClassCounts,
    },
    netDeltasStatus: allPriced ? "FAIL_CLOSED_EXIT_DEPTH_UNSIZED" : "FAIL_CLOSED_INCOMPLETE_PRICING",
    chains: chainResults,
    rows: pricedRows,
    topRoutePositive: routePositiveRows
      .slice()
      .sort((a, b) => (BigInt(b.netUsdc) > BigInt(a.netUsdc) ? 1 : BigInt(b.netUsdc) < BigInt(a.netUsdc) ? -1 : 0))
      .slice(0, 5),
    csv: { path: csv.path, rowCount: csv.rowCount, sha256: csv.sha256, canonicalHash: csv.canonicalHash, bounded: true, byteIdenticalToPreviousRun: csv.byteIdenticalToPreviousRun, versionedSuffix: csv.versionedSuffix, version: csv.version },
    coverage: {
      complete: chainResults.every((c) => !c.error),
      blockers: [...new Set(chainResults.filter((c) => c.error).map((c) => c.error))],
      honestAbsences,
    },
  };

  // Attach the cached exit-depth quotes and recompute `executable` when fresh. Pure; no
  // network. A live run regenerates generatedAt, so a prior exit-depth is normally stale
  // here (fail-closed, executable stays false) unless --recompute reuses the same pin.
  const exitInfo = applyExitDepth(artifact, { thresholdBps: options.impactThresholdBps, allowStale: options.allowStaleExitDepth === true });
  if (exitInfo.attached) {
    honestAbsences.push(`exit-depth attached from ${relPosix(EXIT_DEPTH_PATH)} (fresh=${exitInfo.fresh === true}); per-row quotes attached and executable recomputed (${artifact.summary.executable} executable after exit-depth). netDeltas stays null: no quoted size yields a strict conservative net > 0 at/below the impact threshold (${exitInfo.thresholdBps} bps).`);
  } else {
    honestAbsences.push(`exit-depth not attached (${exitInfo.reason || "EXIT_DEPTH_UNAVAILABLE"}); executable stays fail-closed false and no exit-depth section is emitted.`);
  }

  return artifact;
}

// Offline recompute: artifacts only, no network. Attaches the exit-depth artifact and
// recomputes `executable`. Static inputs come from the economics artifact (debtValued,
// gasBoundUsdc, oracle rate, debt-token decimals) and the exit-depth artifact (quotes).
// A genuinely LIVE net additionally needs a fresh oracle rate and fresh DEX quotes.
async function recomputeOffline(options = {}) {
  const artifactPath = options.artifactPath || ARTIFACT_PATH;
  const artifact = fluid.readJson(artifactPath);
  if (!artifact || artifact.schema !== ARTIFACT_SCHEMA || !Array.isArray(artifact.rows)) throw new EconFailure("ARTIFACT_INVALID");
  const info = applyExitDepth(artifact, {
    exitDepthPath: options.exitDepthPath,
    thresholdBps: options.impactThresholdBps,
    allowStale: false,
  });
  artifact.recomputeMode = "offline-artifacts-only (no network: attaches exit-depth artifact, recomputes executable)";
  artifact.recomputedAt = new Date().toISOString();
  artifact.recomputeInputs = {
    staticFromEconomicsArtifact: ["debtValued", "colValued", "grossBonusUsdcRaw", "gasBoundUsdc", "oracleRateLiquidateRaw", "debtToken/decimals", "routePositive"],
    staticFromExitDepthArtifact: ["venues", "quotedOutAtSizes", "priceImpactBps", "collSize", "sufficientExit"],
    liveRequiredForFreshNet: ["IFluidOracle.getExchangeRateLiquidate() (fresh oracle rate)", "fresh QuoterV2 quotes (re-run tools/scan-fluid-exit-depth.js --live)"],
  };
  atomicWriteJson(artifactPath, artifact);
  return { artifact, info };
}

// Live recompute: reuses the tool's own endpoint mechanism (resolveWorkingRpc/rpcCall via
// valuate) to refresh oracle rates, gas and pin, then attaches the exit-depth artifact. If
// the cached quotes predate this refresh they are attached for visibility but marked
// attachedStale and forced non-executable (fail-closed). NOT run by default.
async function recomputeLive(options = {}) {
  const reusePin = options.reusePin === true;
  let pins = null;
  if (reusePin) {
    const prior = fluid.readJson(ARTIFACT_PATH);
    if (prior && Array.isArray(prior.chains)) {
      pins = {};
      for (const c of prior.chains) if (c && c.pin && c.pin.hash) pins[c.chainId] = c.pin.hash;
    }
    if (!pins || Object.keys(pins).length === 0) throw new EconFailure("NO_PRIOR_PIN");
  }
  const artifact = await valuate({ pins, impactThresholdBps: options.impactThresholdBps, allowStaleExitDepth: true });
  artifact.budget.pinsReused = Boolean(reusePin);
  artifact.recomputeMode = "live-refresh (fresh oracle rates/gas/pin via the existing RPC path; exit-depth quotes attached, fail-closed if stale)";
  artifact.recomputedAt = new Date().toISOString();
  atomicWriteJson(options.artifactPath || ARTIFACT_PATH, artifact);
  return { artifact };
}

function statusFor(artifact) {
  return {
    status: "OK",
    schema: artifact.schema,
    generatedAt: artifact.generatedAt,
    recomputedAt: artifact.recomputedAt || null,
    recomputeMode: artifact.recomputeMode || null,
    nearAtLtRows: artifact.summary.nearAtLtRows,
    priced: artifact.summary.pricedOracleIdealized,
    unpriced: artifact.summary.unpriced,
    usdAssumed: artifact.summary.usdAssumedRows,
    routePositive: artifact.summary.routePositive,
    executable: artifact.summary.executable,
    nearT2T4NegativeMax: artifact.summary.nearT2T4NegativeMax,
    netDeltas: artifact.netDeltas,
    netDeltasStatus: artifact.netDeltasStatus,
    exitDepth: artifact.exitDepth || null,
    requests: artifact.budget.requests,
    withinBudget: artifact.budget.withinBudget,
    csv: artifact.csv ? artifact.csv.path : null,
    csvByteIdenticalToPreviousRun: artifact.csv ? artifact.csv.byteIdenticalToPreviousRun : null,
    csvVersionedSuffix: artifact.csv ? artifact.csv.versionedSuffix : null,
    oracleClassCounts: artifact.summary.oracleClassCounts,
    verdictCounts: artifact.summary.verdictCounts,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = { recompute: false, liveRecompute: false, reusePin: false, impactThresholdBps: undefined, exitDepthPath: EXIT_DEPTH_PATH, artifactPath: ARTIFACT_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--once") { /* compat no-op */ }
    else if (a === "--reuse-pin") options.reusePin = true;
    else if (a === "--recompute") options.recompute = true;
    else if (a === "--live-recompute") options.liveRecompute = true;
    else if (a === "--impact-threshold-bps") { options.impactThresholdBps = Number(argv[++i]); }
    else if (a.startsWith("--impact-threshold-bps=")) options.impactThresholdBps = Number(a.slice("--impact-threshold-bps=".length));
    else if (a === "--exit-depth") { options.exitDepthPath = argv[++i]; }
    else if (a.startsWith("--exit-depth=")) options.exitDepthPath = a.slice("--exit-depth=".length);
    else throw new EconFailure("USAGE");
  }
  if (options.impactThresholdBps !== undefined && !Number.isFinite(options.impactThresholdBps)) throw new EconFailure("USAGE");
  if (options.recompute && options.liveRecompute) throw new EconFailure("USAGE");

  let artifact;
  if (options.recompute) {
    artifact = (await recomputeOffline(options)).artifact;
  } else if (options.liveRecompute) {
    artifact = (await recomputeLive(options)).artifact;
  } else {
    let pins = null;
    if (options.reusePin) {
      const prior = fluid.readJson(ARTIFACT_PATH);
      if (prior && Array.isArray(prior.chains)) {
        pins = {};
        for (const c of prior.chains) if (c && c.pin && c.pin.hash) pins[c.chainId] = c.pin.hash;
      }
      if (!pins || Object.keys(pins).length === 0) throw new EconFailure("NO_PRIOR_PIN");
    }
    artifact = await valuate({ pins, impactThresholdBps: options.impactThresholdBps });
    artifact.budget.pinsReused = Boolean(options.reusePin);
    atomicWriteJson(ARTIFACT_PATH, artifact);
  }

  process.stdout.write(`${JSON.stringify(statusFor(artifact))}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`fluid-l economics failed: ${error && error.code ? error.code : "SCAN_FAILED"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE, SURFACE_PATH, ARTIFACT_PATH, CSV_PATH, DEPLOYMENTS, ARTIFACT_SCHEMA, SURFACE_SCHEMA, SCANNER, VERSION,
  REQUEST_BUDGET, MC_BATCH_ORACLE, TIMEOUT_MS, NEAR_LT_READINESS, ROUNDING_FACT, ETH_USD_FEEDS, USD_STABLES, I,
  EXIT_DEPTH_PATH, EXIT_DEPTH_SCHEMA, EXIT_DEPTH_MAX_AGE_MS, CONSERVATIVE_IMPACT_THRESHOLD_BPS, EXIT_SWEEP_FRACTIONS,
  EconFailure, sleep, hexBlock, relPosix, lower, big, decodeOrNull, sha256Hex, call, resolveWorkingRpc, multicall,
  loadOracleNameMap, classifyOracleName, loadSurface, collectNearLtRows, readOracleRates, readEthUsd,
  negativeMaxLens, baseRow, valueRow, atomicWriteJson, CSV_HEADER, csvBody, writeCsvVersioned, valuate, main,
  loadExitDepth, exitDepthFreshness, toSixDpRaw, price18, impactVsRefBps, interpOut, labelForSize,
  buildExitDepthSection, selectKneeRow, attachExitDepth, exitDepthInfoBlock, applyExitDepth,
  recomputeOffline, recomputeLive, statusFor,
};
