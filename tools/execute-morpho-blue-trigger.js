#!/usr/bin/env node
"use strict";
// Orchestrator-lane trigger runner for the deployed FlashLiquidateMorphoBlue
// (0xaf5b033e23ac555c09096bf39979a855e09907ba). Gated by
// coordination/live-execution-batch-morpho-trigger.json.
//
// Fail-closed end to end: the four preconditions are evaluated in order BEFORE any
// gated-key read or RPC-write call. If any gate fails the runner prints the honest
// gate table and refuses with {"ok":false,"reason":"execution-needs-live-trigger-state"}.
// Private key material is read from gated env files within the approved batch, stays
// in-process, and is never printed, hashed, persisted, or passed on a command line.
// Endpoint text is never printed.
//
// CLI: --dry-run (default; gate table + estimate only) | --execute (sign + send once).
//
// Gate order:
//   a. batch approved / unexpired / account matches main wallet
//   b. fresh surface scan (<=5 min) with >=1 routePositive row; pick highest-net row
//   c. fork rehearsal artifact state PASS and <=10 min old (trigger-pin proof)
//   d. trigger-quotes: a same-pin Quoter fill for the revert-free seize shape derives the
//      floors -- minOut = fill - scanner haircut; minProfitWei = measured loan net
//      (fill - haircut - repaidAssets - gas). If the fill quote is unavailable the gate
//      aborts (never a 0 floor).
//
// Seize shape (probe r1 side-finding 1; fork-rehearsal proven): the scan's
// `seizedCollateralRaw` is the WHOLE position collateral, so the seize-assets branch
// over-repays and reverts (Panic 0x11 / bare revert). The executor pre-funds its Balancer
// flash from `repaidShares` only (FlashLiquidateMorphoBlue.sol:190) and Morpho computes the
// exact seize internally from `repaidShares`. The runner therefore passes the repaid-shares
// branch (seizedAssets=0, repaidShares=accrued borrowShares capped to collateral) -- the
// same shape the fork rehearsal and the qualified-view fork probe proved.

const fs = require("node:fs");
const path = require("node:path");
const { Wallet, Interface, getAddress } = require(path.join(__dirname, "node_modules", "ethers"));
const valuation = require(path.join(__dirname, "morpho-unwind-valuation.js"));

const BUNDLE = path.join(__dirname, "..", "coordination", "live-execution-batch-morpho-trigger.json");
const SCAN_FILES = [
  path.join(__dirname, "..", "reports", "raw", "fast", "morpho-blue-liquidatable.json"),
  path.join(__dirname, "..", "reports", "raw", "fast", "morpho-blue-liquidatable-base.json"),
];
const REHEARSAL = path.join(__dirname, "..", "reports", "raw", "fast", "morpho-fork-rehearsal", "result.json");
const ENV_FILES = [path.join(__dirname, "..", ".env"), path.join(__dirname, "..", ".env.exploit")];

const EXECUTOR = getAddress("0xaf5b033e23ac555c09096bf39979a855e09907ba"); // deployed, MATCH_IMMUTABLES_MASKED
const MAIN_ACCOUNT = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const REFUSAL = "execution-needs-live-trigger-state";
const SCAN_MAX_AGE_MS = 5 * 60 * 1000;
const REHEARSAL_MAX_AGE_MS = 10 * 60 * 1000;
const OUT_DIR = path.join(__dirname, "..", "reports", "raw", "fast", "morpho-blue-liquidation-execution");

const MORPHO = getAddress("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");
// The deployed executor's ISwapRouter shape carries a `deadline` field
// (FlashLiquidateMorphoBlue.sol:89-99) i.e. SwapRouter v1 -- NOT the scanner's Router02
// `swapTarget` (whose exactInput has no deadline). This is the router the fork rehearsal
// and the qualified-view fork probe actually drove the deployed executor with.
const SWAP_ROUTER = getAddress("0xE592427A0AEce92De3Edee1F18E0157C05861564");
const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const LIQUIDATION_CURSOR = 300000000000000000n;
const MAX_LIF = 1150000000000000000n;
const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;


const EXEC_IFACE = new Interface([
  "function execute((address,address,address,address,uint256) marketParams, address borrower, uint256 seizedAssets, uint256 repaidShares, uint256 minProfitWei, uint256 minOut, address router, bytes routerSwapData)",
  "function owner() view returns (address)",
]);

const MORPHO_IFACE = new Interface([
  "function position(bytes32,address) view returns (uint256,uint128,uint128)",
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
]);
const ORACLE_IFACE = new Interface(["function price() view returns (uint256)"]);
const QUOTER_IFACE = new Interface(["function quoteExactInput(bytes,uint256) returns (uint256,uint160[],uint32[],uint256)"]);

const urls = [
  "https://eth.blockscout.com/api/eth-rpc",
  "https://eth.drpc.org",
  ...[...new Set((fs.readFileSync(path.join(__dirname, "..", "rpc_endpoints.txt"), "utf8").match(/https?:\/\/[^\s'"<>\[\]]+/gi) || []).map(u => u.replace(/[)\],;]+$/, "")))]
    .filter(u => { try { const p = new URL(u); return p.protocol === "https:" && !p.username && !p.password; } catch (_) { return false; } })
    .slice(0, 24),
];

function fail(code) { console.log(JSON.stringify({ ok: false, reason: code })); process.exit(1); }
function sanitize(v) { return typeof v === "string" ? v.replaceAll(/[0-9a-fA-F]{64}/g, "<64hex>") : v; }
function isQuantity(v) { return typeof v === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v); }
function isHash(v) { return typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v); }
function big(v) { try { return v === null || v === undefined ? null : BigInt(v); } catch (_) { return null; } }

async function rpcOn(url, method, params) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15_000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: c.signal, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const b = await r.json();
    if (b.error) throw new Error("rpc:" + (b.error.message || "").slice(0, 40));
    if (b.result === undefined) throw new Error("rpc-shape-failure");
    return b.result;
  } finally { clearTimeout(t); }
}

// --- gates ------------------------------------------------------------------------------
function gateBatch() {
  let b;
  try { b = JSON.parse(fs.readFileSync(BUNDLE, "utf8")); } catch (_) { return { ok: false, detail: "batch-unreadable" }; }
  if (b.approved !== true) return { ok: false, detail: "batch-not-approved" };
  if (!Number.isFinite(Date.parse(b.expiresAt)) || Date.parse(b.expiresAt) < Date.now()) return { ok: false, detail: "batch-expired" };
  if (String(b.account?.address || "").toLowerCase() !== MAIN_ACCOUNT) return { ok: false, detail: "batch-account-mismatch" };
  return { ok: true, detail: `batchId=${b.batchId} expiresAt=${b.expiresAt}`, batch: b };
}

function gateSurface() {
  const now = Date.now();
  const diag = [];
  let candidate = null;
  for (const f of SCAN_FILES) {
    const name = path.basename(f);
    if (!fs.existsSync(f)) { diag.push(`${name}:missing`); continue; }
    let j;
    try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { diag.push(`${name}:unreadable`); continue; }
    const ageMin = (now - Date.parse(j.scannedAt)) / 60000;
    const rows = Array.isArray(j.rows) ? j.rows : [];
    const routePositive = rows.filter((r) => r.routePositive === true);
    diag.push(`${name}:ageMin=${Number.isFinite(ageMin) ? ageMin.toFixed(1) : "?"},routePositive=${routePositive.length}`);
    if (!Number.isFinite(ageMin) || ageMin > SCAN_MAX_AGE_MS / 60000) continue;
    for (const r of routePositive) {
      const net = big(r.netUsdcRaw);
      if (net === null) continue;
      if (!candidate || net > candidate.net) candidate = { row: r, net, file: name, artifact: j };
    }
  }
  if (!candidate) return { ok: false, detail: diag.join("; ") || "no-scan-artifact", row: null };
  return { ok: true, detail: `file=${candidate.file} marketId=${String(candidate.row.marketId).slice(0, 14)} netUsdcRaw=${candidate.net}`, row: candidate.row, net: candidate.net, artifact: candidate.artifact };
}

function gateRehearsal() {
  if (!fs.existsSync(REHEARSAL)) return { ok: false, detail: "rehearsal-missing" };
  let j;
  try { j = JSON.parse(fs.readFileSync(REHEARSAL, "utf8")); } catch (_) { return { ok: false, detail: "rehearsal-unreadable" }; }
  if (j.state !== "PASS") return { ok: false, detail: `state=${j.state}` };
  const ts = j.completedAt || j.generatedAt;
  const ageMin = (Date.now() - Date.parse(ts)) / 60000;
  if (!Number.isFinite(ageMin) || ageMin > REHEARSAL_MAX_AGE_MS / 60000) return { ok: false, detail: `state=PASS but stale ageMin=${Number.isFinite(ageMin) ? ageMin.toFixed(1) : "?"}` };
  return { ok: true, detail: `state=PASS ageMin=${ageMin.toFixed(1)}` };
}

// --- trigger-quotes gate: measured-fill-derived floors (probe r1 side-findings 1/2) ------
// The scanner's `minLoanOutRaw` is the position's FULL debt, so the old
// `minOut = minLoanOutRaw * 0.98` floor is systematically unachievable on a liquidatable row
// (recoverable collateral value is below the debt by construction). Replace it with a
// MEASURED, same-pin Quoter fill of the collateral->loan route for the actual (collateral-
// capped) seize:
//   minOut       = fill - haircut(fill, scanner haircutBps)
//   minProfitWei = minOut - repaidAssets - gas   (all in the loan-asset unit)
// Fail-closed: any missing read/quote aborts the gate; the floor is never 0.
function packedPath(hops, fees) {
  if (!Array.isArray(hops) || !Array.isArray(fees) || hops.length !== fees.length + 1 || hops.length < 2) return null;
  let out = "";
  for (let i = 0; i < hops.length; i += 1) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(hops[i]))) return null;
    out += String(hops[i]).toLowerCase().slice(2);
    if (i < fees.length) {
      const fee = Number(fees[i]);
      if (!Number.isInteger(fee) || fee <= 0 || fee > 0xffffff) return null;
      out += fee.toString(16).padStart(6, "0");
    }
  }
  return "0x" + out;
}
function blockRef(n) { return "0x" + BigInt(n).toString(16); }
// Morpho math (mirrors Morpho.sol / SharesMathLib.sol, as the fork rehearsal does).
function liquidationIncentiveFactor(lltv) {
  const lif = (WAD * WAD) / (WAD - (LIQUIDATION_CURSOR * (WAD - lltv)) / WAD);
  return lif > MAX_LIF ? MAX_LIF : lif;
}
function toAssetsUp(shares, totalAssets, totalShares) {
  const p = shares * (totalAssets + VIRTUAL_ASSETS);
  if (p === 0n) return 0n;
  return (p - 1n) / (totalShares + VIRTUAL_SHARES) + 1n;
}
function toAssetsDown(shares, totalAssets, totalShares) {
  return (shares * (totalAssets + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
}
function seizedForShares(shares, totalBorrowAssets, totalBorrowShares, lif, price) {
  const assets = toAssetsDown(shares, totalBorrowAssets, totalBorrowShares);
  const quoted = (assets * lif) / WAD;
  return (quoted * ORACLE_PRICE_SCALE) / price;
}
async function callAt(url, to, iface, fn, args, blockTag) {
  const data = iface.encodeFunctionData(fn, args);
  const res = await rpcOn(url, "eth_call", [{ to, data }, blockTag]);
  return iface.decodeFunctionResult(fn, res);
}
async function quoteFill(url, path, amountIn, blockTag) {
  const data = QUOTER_IFACE.encodeFunctionData("quoteExactInput", [path, amountIn]);
  const res = await rpcOn(url, "eth_call", [{ to: valuation.venueFor(1).quoter, data }, blockTag]);
  return BigInt(QUOTER_IFACE.decodeFunctionResult("quoteExactInput", res)[0]);
}

// Convert the scanner's USDC gas ceiling into the loan asset so minProfitWei stays in the
// executor's unit. Identity when loan == USDC; otherwise a same-pin USDC->loan Quoter fill
// on the pair's own loan/USDC pool. null => fail-closed (abort, never a 0 floor).
async function gasToLoan(url, row, artifact, gasUsdc, blockTag) {
  const usdc = valuation.venueFor(1).usdc;
  if (gasUsdc === 0n) return 0n;
  if (String(row.loanToken).toLowerCase() === String(usdc).toLowerCase()) return gasUsdc;
  const routes = (artifact.valuation && artifact.valuation.routes) || [];
  const pair = routes.find((rt) => rt
    && String(rt.loanToken).toLowerCase() === String(row.loanToken).toLowerCase()
    && String(rt.collateralToken).toLowerCase() === String(row.collateralToken).toLowerCase());
  const fee = pair && pair.loanUsdc ? Number(pair.loanUsdc.fee) : null;
  if (!Number.isInteger(fee) || fee <= 0) return null;
  const path = packedPath([usdc, row.loanToken], [fee]);
  if (!path) return null;
  try { return BigInt(await quoteFill(url, path, gasUsdc, blockTag)); } catch (_) { return null; }
}

async function deriveFloors(url, row, artifact, blockTag) {
  const sp = packedPath(row.swapHops, row.swapFees);
  if (!sp) return { ok: false, detail: "route-path-not-reconstructible" };
  let pos, mkt, priceRaw;
  try {
    pos = await callAt(url, MORPHO, MORPHO_IFACE, "position", [row.marketId, row.borrower], blockTag);
    mkt = await callAt(url, MORPHO, MORPHO_IFACE, "market", [row.marketId], blockTag);
    priceRaw = await callAt(url, row.oracle, ORACLE_IFACE, "price", [], blockTag);
  } catch (_) { return { ok: false, detail: "position-market-oracle-read-failed" }; }
  const borrowShares = BigInt(pos[1]);
  const collateral = BigInt(pos[2]);
  const tba = BigInt(mkt[2]);
  const tbs = BigInt(mkt[3]);
  const price = BigInt(priceRaw[0]);
  if (borrowShares === 0n || collateral === 0n || price === 0n) return { ok: false, detail: "empty-or-unpriced-position" };
  const lltv = BigInt(row.lltvRaw);
  const lif = liquidationIncentiveFactor(lltv);
  const borrowed = toAssetsUp(borrowShares, tba, tbs);
  const maxBorrow = ((collateral * price) / ORACLE_PRICE_SCALE) * lltv / WAD;
  if (maxBorrow >= borrowed) return { ok: false, detail: "position-not-liquidatable-at-ref" };

  // Repaid-shares branch: repay the accrued borrow shares, capped so the implied seize never
  // exceeds the position collateral (Morpho computes the exact seize from repaidShares).
  let repaidShares = borrowShares;
  const seizedFull = seizedForShares(borrowShares, tba, tbs, lif, price);
  if (seizedFull > collateral && seizedFull > 0n) repaidShares = (borrowShares * collateral * 95n) / (seizedFull * 100n);
  let seizedEstimate = seizedForShares(repaidShares, tba, tbs, lif, price);
  for (let guard = 0; seizedEstimate > collateral && repaidShares > 1n && guard < 40; guard += 1) {
    repaidShares = (repaidShares * 90n) / 100n;
    seizedEstimate = seizedForShares(repaidShares, tba, tbs, lif, price);
  }
  if (repaidShares === 0n) return { ok: false, detail: "no-repayable-shares" };
  const seizedIn = seizedEstimate > collateral ? collateral : seizedEstimate;

  // Same-pin measured route fill for the seized amount (loan asset out).
  let fill;
  try { fill = await quoteFill(url, sp, seizedIn, blockTag); } catch (_) { return { ok: false, detail: "fill-quote-unavailable" }; }
  if (fill === null || fill <= 0n) return { ok: false, detail: "fill-quote-nonpositive" };
  const haircut = valuation.haircutRaw(fill, BigInt(row.haircutBps || 0));
  const minOut = fill > haircut ? fill - haircut : 0n;
  if (minOut <= 0n) return { ok: false, detail: "minOut-nonpositive" };

  const repaidAssets = toAssetsUp(repaidShares, tba, tbs);
  const gasUsdc = big(row.gasCeilingUsdcRaw);
  if (gasUsdc === null) return { ok: false, detail: "gas-ceiling-missing" };
  const gasLoan = await gasToLoan(url, row, artifact, gasUsdc, blockTag);
  if (gasLoan === null) return { ok: false, detail: "gas-loan-conversion-unavailable" };
  const minProfitWei = minOut - repaidAssets - gasLoan;
  if (minProfitWei <= 0n) return { ok: false, detail: `minProfitWei-nonpositive(${minProfitWei})` };

  const ref = blockTag === "latest" ? "latest" : "same-pin";
  return {
    ok: true,
    detail: `${ref} seizedEstimate=${seizedIn} repaidShares=${repaidShares} fill=${fill} minOut=${minOut} minProfitWei=${minProfitWei} (fill=${fill}-haircut=${haircut}-repaid=${repaidAssets}-gas=${gasLoan})`,
    floors: { seizedAssets: 0n, repaidShares, seizedEstimate: seizedIn, minOut, minProfitWei, routerSwapData: sp },
  };
}

async function gateTriggerQuotes(url, surface) {
  if (!surface || !surface.row || !surface.artifact) return { ok: false, detail: "no-route-positive-row", floors: null };
  const pin = surface.artifact.pin ? Number(surface.artifact.pin.number) : null;
  const refs = [];
  if (Number.isFinite(pin) && pin > 0) refs.push({ tag: blockRef(pin), label: "same-pin" });
  refs.push({ tag: "latest", label: "latest" });
  let last = "no-block-ref";
  for (const ref of refs) {
    const r = await deriveFloors(url, surface.row, surface.artifact, ref.tag);
    if (r.ok) return r;
    last = `${ref.label}:${r.detail}`;
  }
  return { ok: false, detail: `trigger-quote-unavailable(${last})`, floors: null };
}

// --- post-gate: key + provider -----------------------------------------------------------
function loadPrivateKey() {
  for (const file of ENV_FILES) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^(?:[A-Z0-9_]+)\s*=\s*(0x[0-9a-fA-F]{64}|[0-9a-fA-F]{64})\s*(?:#.*)?$/);
      if (!m) continue;
      try {
        const wallet = new Wallet(m[1].startsWith("0x") ? m[1] : "0x" + m[1]);
        if (wallet.address.toLowerCase() === MAIN_ACCOUNT) return m[1].startsWith("0x") ? m[1] : "0x" + m[1];
      } catch (_) { continue; }
    }
  }
  fail("key-file-unavailable");
}

async function findQualifiedProvider() {
  for (const url of urls) {
    let chainId, finalized, recheck, code;
    try { chainId = await rpcOn(url, "eth_chainId", []); } catch (_) { continue; }
    if (chainId !== "0x1") continue;
    try { finalized = await rpcOn(url, "eth_getBlockByNumber", ["finalized", false]); } catch (_) { continue; }
    if (!finalized || !isHash(finalized.hash) || !isQuantity(finalized.number)) continue;
    try { recheck = await rpcOn(url, "eth_getBlockByNumber", [finalized.number, false]); } catch (_) { continue; }
    if (!recheck || recheck.hash !== finalized.hash) continue;
    try { code = await rpcOn(url, "eth_getCode", [EXECUTOR, "latest"]); } catch (_) { continue; }
    if (typeof code !== "string" || code.length <= 2) continue;
    return url;
  }
  return null;
}

async function qualify() {
  const url = await findQualifiedProvider();
  if (!url) fail("no-qualified-provider");
  return url;
}

(async () => {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const mode = execute ? "EXECUTE" : "DRY_RUN";

  // ---- gate table (no key read, no RPC-write; read-only eth_call only) ----
  const a = gateBatch();
  const b = gateSurface();
  const c = gateRehearsal();
  let d = { ok: false, detail: "no-route-positive-row", floors: null };
  let readProvider = null;
  if (b.ok) {
    readProvider = await findQualifiedProvider();
    d = readProvider ? await gateTriggerQuotes(readProvider, b) : { ok: false, detail: "no-qualified-provider", floors: null };
    if (!d.ok) readProvider = null;
  }
  const gates = [
    { gate: "a.batch", ok: a.ok, detail: a.detail },
    { gate: "b.fresh-surface", ok: b.ok, detail: b.detail },
    { gate: "c.fork-rehearsal", ok: c.ok, detail: c.detail },
    { gate: "d.trigger-quotes", ok: d.ok, detail: d.detail },
  ];
  console.log(JSON.stringify({ stage: "GATE_TABLE", mode, executor: EXECUTOR, gates }, null, 2));

  if (gates.some((g) => !g.ok)) {
    console.log(JSON.stringify({ ok: false, reason: REFUSAL }));
    process.exitCode = 1;
    return;
  }

  // ---- all gates passed: only now load the gated key and qualify ----
  const walletKey = loadPrivateKey();
  const wallet = new Wallet(walletKey);
  if (wallet.address.toLowerCase() !== MAIN_ACCOUNT) fail("key-account-mismatch");

  const provider = readProvider || (await qualify());

  const row = b.row;
  const floors = d.floors;
  const marketParams = [row.loanToken, row.collateralToken, row.oracle, row.irm, BigInt(row.lltvRaw)];
  // Corrected seize shape: the repaid-shares branch. Morpho computes the exact (liquidatable
  // portion) seize internally from repaidShares, and the executor pre-funds its Balancer
  // flash from repaidShares (FlashLiquidateMorphoBlue.sol:190); seizedAssets stays 0.
  const seizedAssets = floors.seizedAssets;
  const repaidShares = floors.repaidShares;
  if ((seizedAssets === 0n) === (repaidShares === 0n)) fail("inconsistent-input");
  const router = SWAP_ROUTER; // executor-compatible SwapRouter v1 (fork-rehearsal / probe proven)
  const data = EXEC_IFACE.encodeFunctionData("execute", [
    marketParams, row.borrower, seizedAssets, repaidShares, floors.minProfitWei, floors.minOut, router, floors.routerSwapData,
  ]);

  const [chainId, latest, priorityFee, gasLimitEst] = await Promise.all([
    rpcOn(provider, "eth_chainId", []),
    rpcOn(provider, "eth_getBlockByNumber", ["latest", false]),
    rpcOn(provider, "eth_maxPriorityFeePerGas", []).catch(() => null),
    rpcOn(provider, "eth_estimateGas", [{ from: wallet.address, to: EXECUTOR, data }]),
  ]);

  const batchMaxGasLimit = BigInt(b.batch.caps.maxGasLimitPerTransaction ?? 0);
  const batchMaxSpend = BigInt(b.batch.caps.maxNativeSpendPerTransactionWei ?? 0);
  const gasLimit = BigInt(gasLimitEst);
  if (batchMaxGasLimit > 0n && gasLimit > batchMaxGasLimit) fail("gas-limit-exceeds-batch-cap");

  const baseFeeWei = latest?.baseFeePerGas ? BigInt(latest.baseFeePerGas) : BigInt(7);
  const reportedTip = priorityFee ? BigInt(priorityFee) : BigInt(1_000_000_000);
  const tipWei = reportedTip > BigInt(1_000_000_000) ? reportedTip : BigInt(1_000_000_000);
  const margin = (baseFeeWei * 2n) + (tipWei * 12n) / 10n + 2n;
  const capWeiPerGas = batchMaxSpend > 0n ? batchMaxSpend / gasLimit : BigInt(0);
  let maxFeePerGas = margin;
  if (capWeiPerGas > 0n && margin > capWeiPerGas) maxFeePerGas = capWeiPerGas;
  if (maxFeePerGas <= 0n) fail("zero-fee");

  const estTotal = (gasLimit * maxFeePerGas).toString();
  if (batchMaxSpend > 0n && BigInt(estTotal) > batchMaxSpend) fail("spend-exceeds-batch-cap");
  console.log(JSON.stringify({
    ok: true, stage: "ESTIMATE", chainId: Number(BigInt(chainId)),
    target: EXECUTOR, marketId: row.marketId, borrower: row.borrower,
    seizedAssets: seizedAssets.toString(), repaidShares: repaidShares.toString(),
    seizedEstimate: floors.seizedEstimate.toString(),
    minProfitWei: floors.minProfitWei.toString(), minOut: floors.minOut.toString(), router,
    gasLimit: gasLimit.toString(), maxFeePerGas: maxFeePerGas.toString(),
    maxPriorityFeePerGas: tipWei.toString(), estimatedMaxFeeWei: estTotal,
    batchCapWei: batchMaxSpend.toString(), mode,
  }, null, 2));

  // Dry-run stops here: no nonce fetch, no signing, no send of any kind.
  if (!execute) {
    console.log(JSON.stringify({ ok: true, stage: "DRY_RUN_ONLY_NOT_SENT" }, null, 2));
    return;
  }

  const nonce = await rpcOn(provider, "eth_getTransactionCount", [wallet.address, "pending"]);
  const tx = {
    type: 2,
    chainId: Number(BigInt(chainId)),
    nonce: Number(BigInt(nonce)),
    to: EXECUTOR,
    value: 0,
    data,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas: tipWei,
  };

  const signed = await wallet.signTransaction(tx);
  const txHash = await rpcOn(provider, "eth_sendRawTransaction", [signed]);
  console.log(JSON.stringify({ ok: true, stage: "SENT", txHash }, null, 2));

  let receipt = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4_000));
    try {
      receipt = await rpcOn(provider, "eth_getTransactionReceipt", [txHash]);
      if (receipt && receipt.status !== undefined) break;
    } catch (_) { continue; }
  }
  if (!receipt || receipt.status === null) { console.log(JSON.stringify({ ok: false, reason: "receipt-timeout", txHash }, null, 2)); process.exitCode = 2; return; }

  const result = {
    ok: receipt.status === "0x1" || receipt.status === "0x01",
    stage: "RECEIPT",
    txHash,
    blockNumber: Number(BigInt(receipt.blockNumber)),
    gasUsed: BigInt(receipt.gasUsed).toString(),
    effectiveGasPriceWei: BigInt(receipt.effectiveGasPrice || 0).toString(),
  };
  console.log(JSON.stringify(result, null, 2));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `execution-${Date.now()}.json`), JSON.stringify({
    schema: "morpho-blue-liquidation-execution/v1",
    batchId: b.batch.batchId,
    executor: EXECUTOR,
    marketId: row.marketId,
    borrower: row.borrower,
    ...result,
    readonly: false,
    signedActionJustified: true,
    netDeltas: null,
    note: "net deltas are not fabricated here; reconcile against the receipt logs before recording",
  }, null, 2) + "\n", "utf8");
})().catch((e) => { console.log(JSON.stringify({ ok: false, reason: sanitize(String(e && e.message || e)).slice(0, 120) })); process.exitCode = 1; });
