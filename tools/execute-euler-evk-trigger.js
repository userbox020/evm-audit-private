#!/usr/bin/env node
"use strict";
// execute-euler-evk-trigger.js
// Trigger-gated signing runner for the deployed Euler EVK flash liquidator
// 0x876ceed4a83ef6bc219fd14c239a0f54895d4ada (owner 0x24e4...ce0a; bytecode
// MATCH_IMMUTABLES_MASKED in reports/raw/fast/deployed-bytecode-verification.json,
// label EULER-LIQ-V3).
//
// Fail-closed end to end. Every precondition listed in
// coordination/live-execution-batch-euler-trigger.json:triggerGated.requiredBeforeSignedTx
// is verified in order and logged as a gate BEFORE any key read or network call.
// If any gate is not satisfied the runner prints an honest gate table and exits
// {"ok":false,"reason":"execution-needs-live-trigger-state"} without reading a key
// file and without sending. Private key material is read from gated env files only
// in --execute mode, only after every gate passes; it stays in-process and is never
// printed, hashed, persisted, or passed on a command line. Endpoint material
// (URL/host/path) is never printed or persisted.
//
// Mirrors tools/execute-aave-v3-trigger.js for batch gating, key loading, keyless
// RPC qualification, nonce/chainId/fee handling, and the receipt poll; mirrors
// tools/execute-morpho-blue-trigger.js for the fresh-surface row gate shape
// (fresh scan artifact + >=1 routePositive row + highest-net row selection).
//
// The executor surface (onlyOwner) is the deployed 8-arg call:
//   execute(address violator, address collateral, uint256 repayAssets,
//           uint256 minYieldBalance, uint256 minProfitWei, uint256 minOut,
//           address router, bytes routerSwapData)
// per contracts/flash-liquidate-euler-evk/src/FlashLiquidateEulerEVK.sol:243-280.
//
// CLI: --dry-run (default) | --execute

const fs = require("node:fs");
const path = require("node:path");
const { Wallet, Interface, getAddress } = require(path.join(__dirname, "node_modules", "ethers"));

const ROOT = path.resolve(__dirname, "..");
// Executor-#2 lane overrides: --batch <path> --executor <addr> --outdir <name> --deploy-block <n>
// Fail-closed defaults keep the executor-#1 lane semantics unchanged.
const __triggerArgv = process.argv.slice(2);
function __triggerArg(flag, fallback) {
  const i = __triggerArgv.indexOf(flag);
  return i !== -1 && __triggerArgv[i + 1] ? __triggerArgv[i + 1] : fallback;
}
const BUNDLE = path.resolve(ROOT, __triggerArg("--batch", "coordination/live-execution-batch-euler-trigger.json"));
const WATCH_STATUS = path.join(ROOT, "reports", "raw", "fast", "euler-l-watch-status.json");
const VALUATION = path.join(ROOT, "reports", "raw", "fast", "euler-l-valuation.json");
// The rehearsal runner tools/euler-evk-flash-liquidator-rehearsal.js writes OUTPUT to
// reports/raw/fast/euler-fork-rehearsal/result.json (state PASS|FAIL_CLOSED).
const REHEARSAL = path.join(ROOT, "reports", "raw", "fast", "euler-fork-rehearsal", "result.json");
const OUTDIR = path.join(ROOT, "reports", "raw", "fast", __triggerArg("--outdir", "euler-liquidation-execution"));
const ENV_FILES = [path.join(ROOT, ".env"), path.join(ROOT, ".env.exploit")];
const RPC_INVENTORY = path.join(ROOT, "rpc_endpoints.txt");

const MAIN_ACCOUNT = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const EXECUTOR = getAddress(__triggerArg("--executor", "0x876ceed4a83ef6bc219fd14c239a0f54895d4ada"));

const FRESH_WATCH_MS = 5 * 60 * 1000;
const FRESH_VALUATION_MS = 10 * 60 * 1000;
const FRESH_REHEARSAL_MS = 10 * 60 * 1000;
const MIN_OUT_HAIRCUT_BPS = 98n; // minOut floor = quoted * 0.98
// minYield floor: 2% tolerance below the captured maxYield. The 0.1% (999/1000)
// pin matched the rehearsal's snapshot but failed live on normal state drift with
// EVK E_MinYield (selector 0x0dc316c4, decoded 2026-10-13 from the winner row's
// estimate); the 98% floor keeps the slippage guard while tolerating drift from
// the row's checkLiquidation capture to the firing block.
const MIN_YIELD_HAIRCUT_BPS = 980n;

// Exact deployed executor surface (FlashLiquidateEulerEVK.sol:243-252). `owner()` is
// declared only so the module's gate exports stay self-describing; it is never called.
const EXEC_IFACE = new Interface([
  "function execute(address violator,address collateral,uint256 repayAssets,uint256 minYieldBalance,uint256 minProfitWei,uint256 minOut,address router,bytes routerSwapData) external",
  "function owner() view returns (address)",
  "function setEvcConfiguration(address liabilityVault,address collateralVault) external",
  "event EvcConfigurationSet(address liabilityVault,address collateralVault)",
]);

// Executor deploy block (deployed-bytecode-verification.json:416, blockHash record).
const EXECUTOR_DEPLOY_BLOCK = Number(__triggerArg("--deploy-block", "26173090"));
// Trigger-time one-time EVC pair wiring per the armed batch: "setEvcConfiguration
// (liabilityVault, collateralVault) is run once owner-side per fresh pair BEFORE the
// liquidation call" (coordination/live-execution-batch-euler-trigger.json:31). The
// source guard is one-time-ever (E_VAULT_PAIR_CONFIGURED, FlashLiquidateEulerEVK.sol:220).
const CONFIG_TOPIC0 = EXEC_IFACE.getEvent("EvcConfigurationSet").topicHash;

// Flash-source funding precheck: the Balancer Vault must hold >= repayAssets of the
// liability asset (BAL#528 = INSUFFICIENT_FLASH_LOAN_BALANCE during its loan leg).
const BALANCER_VAULT = getAddress("0xBA12222222228d8Ba445958a75a0704d566BF2C8");
const MAX_ROW_PROBES = 3; // bounded per-candidate probes per firing attempt
const ERC20_IFACE = new Interface(["function balanceOf(address) view returns (uint256)"]);

async function readBalancerBalance(provider, token) {
  const raw = await rpcOn(provider, "eth_call", [{
    to: getAddress(token),
    data: ERC20_IFACE.encodeFunctionData("balanceOf", [BALANCER_VAULT]),
  }, "latest"]);
  return typeof raw === "string" && raw.length > 2 ? BigInt(raw) : null;
}

// Live liveness: violators are racey (eaten between surface capture and firing);
// EVK's own checkLiquidation view is the only honest state for a firing decision.
const LIQ_VIEW_IFACE = new Interface(["function checkLiquidation(address liquidator,address violator,address collateral) view returns (uint256 maxRepay, uint256 maxYield)"]);

async function readCheckLiquidation(provider, vault, liquidator, violator, collateral) {
  const raw = await rpcOn(provider, "eth_call", [{
    to: getAddress(vault),
    data: LIQ_VIEW_IFACE.encodeFunctionData("checkLiquidation", [getAddress(liquidator), getAddress(violator), getAddress(collateral)]),
  }, "latest"]);
  if (typeof raw !== "string" || raw.length <= 2) return null;
  const dec = LIQ_VIEW_IFACE.decodeFunctionResult("checkLiquidation", raw);
  return { maxRepay: BigInt(dec[0]), maxYield: BigInt(dec[1]) };
}

async function findConfiguredPair(provider) {
  const headRaw = await rpcOn(provider, "eth_blockNumber", []);
  const head = Number(BigInt(headRaw));
  const start = EXECUTOR_DEPLOY_BLOCK;
  for (let from = start; from <= head; from += 9_500) {
    const to = Math.min(from + 9_499, head);
    const logs = await rpcOn(provider, "eth_getLogs", [{
      address: EXECUTOR,
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + to.toString(16),
      topics: [CONFIG_TOPIC0],
    }]);
    if (Array.isArray(logs) && logs.length) {
      const last = logs[logs.length - 1];
      const decoded = EXEC_IFACE.decodeEventLog("EvcConfigurationSet", last.data, last.topics);
      return {
        liabilityVault: getAddress(decoded[0]),
        collateralVault: getAddress(decoded[1]),
        txHash: last.transactionHash,
        blockNumber: Number(BigInt(last.blockNumber)),
      };
    }
  }
  return null;
}

function fail(code) { console.log(JSON.stringify({ ok: false, reason: code })); process.exit(1); }
function sanitize(v) { return typeof v === "string" ? v.replaceAll(/[0-9a-fA-F]{64}/g, "<64hex>") : v; }
function rel(file) { return path.relative(ROOT, file).replace(/\\/g, "/"); }
function toBig(value) { try { return value === null || value === undefined ? null : BigInt(value); } catch (_) { return null; } }
function toNum(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }

function tryReadJson(file) {
  try {
    if (!fs.existsSync(file)) return { exists: false, ok: false, value: null };
    return { exists: true, ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (_) {
    return { exists: true, ok: false, value: null };
  }
}

function ageMs(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Date.now() - t : null;
}

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

function isQuantity(v) { return typeof v === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v); }
function isHash(v) { return typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v); }

function loadRpcUrls() {
  // Align the candidate pool with the workspace's shared-rpc ranked loader (the
  // same pool every working tool — watchers, scans, valuation, rehearsal — uses).
  // The prior inline raw-regex slice picked junk/dead endpoints (only 3/24 overlap
  // with the shared pool) and structurally missed the working keyless archive node.
  // Security posture unchanged: qualify() still enforces chainId 0x1, finalized
  // hash recheck, and live executor code per candidate, all fail-closed.
  try { return require("./shared-rpc").loadRpcUrls({ maxCandidates: 40 }); } catch (_) { return []; }
}

// Same keyless qualification pattern as the aave trigger runner: chainId, finalized
// block hash recheck, and live code on the target. The endpoint value is
// process-only and never printed or persisted.
async function qualify() {
  for (const url of loadRpcUrls()) {
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
  return fail("no-qualified-provider");
}

// Same gated key-file pattern as the aave trigger runner. Only ever invoked in
// --execute after every gate has passed.
function loadPrivateKey() {
  for (const file of ENV_FILES) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^(?:[A-Z0-9_]+)\s*=\s*(0x[0-9a-fA-F]{64}|[0-9a-fA-F]{64})\s*(?:#.*)?$/);
      if (!m) continue;
      try {
        const wallet = new Wallet(m[1].startsWith("0x") ? m[1] : "0x" + m[1]);
        if (wallet.address.toLowerCase() === MAIN_ACCOUNT.toLowerCase()) return m[1].startsWith("0x") ? m[1] : "0x" + m[1];
      } catch (_) { continue; }
    }
  }
  return fail("key-file-unavailable");
}

// ---- preconditions (all must pass, in order, before any key/network call) ----

// a. batch approved / unexpired / account matches MAIN / triggerGated block present.
function gateBatch() {
  const r = tryReadJson(BUNDLE);
  if (!r.exists) return { ok: false, detail: `batch-missing:${rel(BUNDLE)}` };
  if (!r.ok) return { ok: false, detail: "batch-unreadable-or-invalid-json" };
  const b = r.value;
  if (b.approved !== true) return { ok: false, detail: "batch-not-approved" };
  const exp = Date.parse(b.expiresAt);
  if (!Number.isFinite(exp)) return { ok: false, detail: "batch-expiresAt-unparseable" };
  if (exp < Date.now()) return { ok: false, detail: "batch-expired" };
  if (String(b.account?.address || "").toLowerCase() !== MAIN_ACCOUNT) return { ok: false, detail: "batch-account-mismatch" };
  if (!b.triggerGated || typeof b.triggerGated !== "object" || !Array.isArray(b.triggerGated.requiredBeforeSignedTx)) {
    return { ok: false, detail: "triggerGated-block-missing" };
  }
  return { ok: true, detail: `approved batchId=${b.batchId} expiresAt=${b.expiresAt}`, batch: b };
}

// b. fresh trigger surface: fresh euler-l-watch-status.json (<=5m) whose own sweep
//    reached live liquidatable candidates, AND a fresh euler-l-valuation.json (<=10m)
//    carrying >=1 routePositive row; the highest-net (netUsdcRaw) row is selected.
function gateFreshTrigger() {
  // --- watch status ---
  const w = tryReadJson(WATCH_STATUS);
  if (!w.exists) return { ok: false, detail: `watch-status-missing:${rel(WATCH_STATUS)}` };
  if (!w.ok) return { ok: false, detail: "watch-status-unreadable-or-invalid-json" };
  const wAge = ageMs(w.value.generatedAt);
  if (wAge === null) return { ok: false, detail: "watch-status-generatedAt-unparseable" };
  if (wAge > FRESH_WATCH_MS) return { ok: false, detail: `watch-status-stale:${Math.round(wAge / 1000)}s>${FRESH_WATCH_MS / 1000}s` };
  if (wAge < -60_000) return { ok: false, detail: "watch-status-generatedAt-in-future" };
  const t = w.value.totals || {};
  const liquidatable = toNum(t.violatorChecksLiquidatable);
  const healthy = toNum(t.violatorChecksHealthy);
  const liveCandidates = liquidatable > 0 || healthy > 0; // sweep's violatorChecksLiquidatable / violatorChecksHealthy row
  if (w.value.ok !== true) return { ok: false, detail: `watch-status-not-ok:${w.value.reason || w.value.ok}` };
  if (!liveCandidates) {
    return { ok: false, detail: `watch-status-no-live-candidates:liquidatable=${t.violatorChecksLiquidatable ?? null},healthy=${t.violatorChecksHealthy ?? null}` };
  }

  // --- valuation rows ---
  const v = tryReadJson(VALUATION);
  if (!v.exists) return { ok: false, detail: `valuation-missing:${rel(VALUATION)}` };
  if (!v.ok) return { ok: false, detail: "valuation-unreadable-or-invalid-json" };
  const vAge = ageMs(v.value.generatedAt);
  if (vAge === null) return { ok: false, detail: "valuation-generatedAt-unparseable" };
  if (vAge > FRESH_VALUATION_MS) return { ok: false, detail: `valuation-stale:${Math.round(vAge / 1000)}s>${FRESH_VALUATION_MS / 1000}s` };
  if (vAge < -60_000) return { ok: false, detail: "valuation-generatedAt-in-future" };
  const rows = Array.isArray(v.value.rows) ? v.value.rows : [];
  // Executable-route selection: the row must carry BOTH routePositive economics
  // AND a builder-valid Üniverswap V3 path (swapHops >= 2 + swapTarget). A
  // route-positive row without a complete swap path is not fireable — the
  // runner never fabricates exit bytes (buildSwapPath rejects/abstains).
  const routeRows = rows.filter(r => r && r.routePositive === true
    && Array.isArray(r.swapHops) && r.swapHops.length >= 2 && r.swapTarget);
  const routePk = rows.filter(r => r && r.routePositive === true).length;
  if (!routeRows.length) return { ok: false, detail: `valuation-no-routePositive-buildableSwap-row:rows=${rows.length},routePositive=${routePk}` };

  let chosen = null;
  for (const row of routeRows) {
    const net = toBig(row.netUsdcRaw);
    if (net === null) continue;
    if (!chosen || net > chosen.net) chosen = { row, net };
  }
  if (!chosen) return { ok: false, detail: "valuation-routePositive-rows-lack-netUsdcRaw" };

  return {
    ok: true,
    detail: `watch live(liquidatable=${t.violatorChecksLiquidatable ?? 0},healthy=${t.violatorChecksHealthy ?? 0}) age=${Math.round(wAge / 1000)}s; valuation routePositive=${routeRows.length} topNetUsdcRaw=${chosen.net} age=${Math.round(vAge / 1000)}s`,
    row: chosen.row,
    net: chosen.net,
    valuationArtifact: v.value,
  };
}

// c. fresh fork rehearsal: state PASS and generatedAt (or completedAt) <= 10m.
function gateRehearsal() {
  const r = tryReadJson(REHEARSAL);
  if (!r.exists) return { ok: false, detail: `rehearsal-result-missing:${rel(REHEARSAL)}` };
  if (!r.ok) return { ok: false, detail: "rehearsal-result-unreadable-or-invalid-json" };
  const a = r.value;
  if (a.state !== "PASS") return { ok: false, detail: `rehearsal-state-not-PASS:${a.state}` };
  const ages = [ageMs(a.generatedAt), ageMs(a.completedAt)].filter(x => x !== null);
  if (!ages.length) return { ok: false, detail: "rehearsal-timestamps-unparseable" };
  const age = Math.min(...ages);
  if (age > FRESH_REHEARSAL_MS) return { ok: false, detail: `rehearsal-stale:${Math.round(age / 1000)}s>${FRESH_REHEARSAL_MS / 1000}s` };
  return { ok: true, detail: `PASS at ${rel(REHEARSAL)} age=${Math.round(age / 1000)}s` };
}

// d. economics floors derived from the selected row's quote shape:
//    minOut floor = quoted swap output (expectedOutUsdcRaw) * 0.98, nonzero;
//    minProfitWei floor = netUsdcRaw - gasCeilingUsdcRaw, nonzero.
//    Both are expressed in the row's quote unit (the valuation's UoA/USDC raw);
//    the calldata labels that unit explicitly and never fabricates a converted value.
function gateEconomics(row) {
  if (!row || typeof row !== "object") return { ok: false, detail: "economics-route-row-unavailable" };
  const quotedOut = toBig(row.expectedOutUsdcRaw);
  const netUsdc = toBig(row.netUsdcRaw);
  const gasBound = toBig(row.gasCeilingUsdcRaw) ?? 0n;

  if (quotedOut === null || quotedOut <= 0n) return { ok: false, detail: "economics-quoted-out-missing-or-nonpositive" };
  const minOutFloorRaw = (quotedOut * MIN_OUT_HAIRCUT_BPS) / 100n;
  if (minOutFloorRaw <= 0n) return { ok: false, detail: "economics-minOut-floor-nonpositive" };

  if (netUsdc === null) return { ok: false, detail: "economics-netUsdc-missing", minOutFloorRaw };
  const minProfitFloorRaw = netUsdc - gasBound;
  if (minProfitFloorRaw <= 0n) return { ok: false, detail: `economics-minProfit-floor-nonpositive(${minProfitFloorRaw})`, minOutFloorRaw };

  return {
    ok: true,
    detail: `minOutFloorRaw=${minOutFloorRaw} minProfitFloorRaw=${minProfitFloorRaw} (quotedOut=${quotedOut}*0.98; netUsdc=${netUsdc}-gasBound=${gasBound})`,
    floors: { minOutFloorRaw, minProfitFloorRaw, quotedOut, netUsdc, gasBound },
  };
}

const GATE_DEFS = [
  { id: "a", name: "batch approved/unexpired/account/triggerGated", fn: gateBatch },
  { id: "b", name: "fresh trigger surface (watch-status live candidates <=5m + valuation routePositive with buildable swap path <=10m, highest net)", fn: gateFreshTrigger },
  { id: "c", name: "fork rehearsal state PASS fresh <=10m", fn: gateRehearsal },
  { id: "d", name: "economics floors (minOut=quoted*0.98, minProfit=netUsdc-gasBound) nonzero", fn: gateEconomics },
];

// Uniswap V3 exactInput path bytes from the row's swapHops/swapFees.
function buildSwapPath(hops, fees) {
  if (!Array.isArray(hops) || hops.length < 2) return null;
  const feeList = Array.isArray(fees) ? fees : [];
  let out = "0x" + String(hops[0]).toLowerCase().replace(/^0x/, "");
  for (let i = 1; i < hops.length; i++) {
    const raw = Number(feeList[i - 1] ?? feeList[0] ?? 3000);
    const fee = Number.isInteger(raw) && raw > 0 ? raw : 3000;
    out += fee.toString(16).padStart(6, "0") + String(hops[i]).toLowerCase().replace(/^0x/, "");
  }
  return out;
}

function refuse(mode, gates, firstFailure) {
  console.log(JSON.stringify({
    ok: false,
    reason: "execution-needs-live-trigger-state",
    stage: "PRECONDITION_GATES",
    mode,
    executor: EXECUTOR,
    firstFailure,
    keyRead: false,
    networkWrite: false,
    gates,
  }, null, 2));
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const mode = execute ? "EXECUTE" : "DRY_RUN";

  // ---- step 2: evaluate every gate in order; stop at the first failure ----
  const gates = [];
  const ctx = {};
  for (let i = 0; i < GATE_DEFS.length; i++) {
    const def = GATE_DEFS[i];
    const result = def.id === "d" ? def.fn(ctx.triggerRow) : def.fn();
    const ok = result.ok === true;
    gates.push({ order: def.id, id: def.id, name: def.name, ok, status: ok ? "pass" : "fail", detail: result.detail });
    if (!ok) {
      for (let j = i + 1; j < GATE_DEFS.length; j++) {
        gates.push({ order: GATE_DEFS[j].id, id: GATE_DEFS[j].id, name: GATE_DEFS[j].name, ok: null, status: "skipped", detail: "not evaluated: earlier gate failed" });
      }
      return refuse(mode, gates, def.id);
    }
    if (def.id === "a") ctx.batch = result.batch;
    if (def.id === "b") { ctx.triggerRow = result.row; ctx.valuationArtifact = result.valuationArtifact; }
    if (def.id === "d") ctx.floors = result.floors;
  }

  // ---- step 3: only after every gate passed ----
  const batch = ctx.batch;
  const floors = ctx.floors;
  let row = null; // selected by the bounded feasibility loop below (gate b row probed first)

  let wallet = null;
  if (execute) {
    const key = loadPrivateKey();
    wallet = new Wallet(key);
    if (wallet.address.toLowerCase() !== MAIN_ACCOUNT) return fail("key-account-mismatch");
  }
  const from = wallet ? wallet.address : getAddress(MAIN_ACCOUNT);

  const provider = await qualify();
  let [nonce, chainId, latest] = await Promise.all([
    rpcOn(provider, "eth_getTransactionCount", [from, "pending"]),
    rpcOn(provider, "eth_chainId", []),
    rpcOn(provider, "eth_getBlockByNumber", ["latest", false]),
  ]);

  // ---- bounded candidate feasibility selection (fail-closed per row; honest probe log) ----
  // BAL#528 = INSUFFICIENT_FLASH_LOAN_BALANCE on the top-net row motivated this:
  // the flash leg (Balancer Vault) must actually hold >= repayAssets of the liability
  // asset. Select the best net row among buildable route-positive candidates that is
  // pair-compatible, floors-consistent, and flash-fundable. Bounded probes.
  const configuredPair = await findConfiguredPair(provider);
  const probeLog = [];
  const eligibleRows = [...(Array.isArray(ctx.valuationArtifact?.rows) ? ctx.valuationArtifact.rows : [])]
    .filter(r => r && r.routePositive === true && Array.isArray(r.swapHops) && r.swapHops.length >= 2 && r.swapTarget)
    .sort((a, b) => {
      const x = toBig(a.netUsdcRaw), y = toBig(b.netUsdcRaw);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return x < y ? 1 : x > y ? -1 : 0;
    })
    .slice(0, MAX_ROW_PROBES);

  let winnerLiveRepay = null, winnerMinYield = null, winnerMinOut = null, winnerMinProfit = null;
  for (const cand of eligibleRows) {
    const cLiab = getAddress(cand.vault);
    const cColl = getAddress(cand.collateralAsset);
    // pair compatibility: a one-time configured pair locks the executor to that pair
    if (configuredPair && (getAddress(configuredPair.liabilityVault) !== cLiab
        || getAddress(configuredPair.collateralVault) !== cColl)) {
      probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "configured-pair-mismatch" });
      continue;
    }
    const floorsC = gateEconomics(cand);
    if (!floorsC.ok) {
      probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "floors:" + floorsC.detail });
      continue;
    }
    const repayRaw = toBig(cand.repayAssetsRaw);
    if (repayRaw === null || repayRaw <= 0n) {
      probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "repayAssets-nonpositive" });
      continue;
    }
    const balRaw = await readBalancerBalance(provider, cand.liabilityAsset).catch(() => null);
    if (balRaw === null) {
      probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "flash-balance-unreadable" });
      continue;
    }
    if (balRaw < repayRaw) {
      probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "flash-source-insufficient", bal: balRaw.toString(), requested: repayRaw.toString() });
      continue;
    }

    // live liveness: rows are racey (violators get eaten between surface capture
    // and firing); EVK's own view decides. A 0x0 row is already eaten; a shrunk
    // maxRepay is honest drift — refuse instead of firing into E_MinYield.
    const live = await readCheckLiquidation(provider, cand.vault, from, cand.violator, cand.collateralAsset).catch(() => null);
    if (live === null) {
      probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "liveness-unreadable" });
      continue;
    }
    if (live.maxRepay === 0n || live.maxYield === 0n) {
      probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "row-already-eaten" });
      continue;
    }
    if (live.maxRepay < repayRaw) {
      probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "liveness-shrunk", liveRepay: live.maxRepay.toString(), rowRepay: repayRaw.toString() });
      continue;
    }
    if (balRaw < live.maxRepay) {
      probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "flash-source-insufficient-live", bal: balRaw.toString(), requested: live.maxRepay.toString() });
      continue;
    }

    // live-anchored floors: repayAssets = live.maxRepay; minYield = live.maxYield
    // hair-cut; minOut/minProfit rescaled by the live/snapshot ratio in the row's
    // own USDC-raw quote unit (documented in the receipt, never fabricated).
    const respay = live.maxRepay;
    const minOutLive = (BigInt(cand.expectedOutUsdcRaw) * 98n * respay) / (100n * repayRaw);
    const minProfitLive = (BigInt(cand.netUsdcRaw) * respay) / repayRaw - BigInt(cand.gasCeilingUsdcRaw ?? 0);
    const minYieldLive = (live.maxYield * MIN_YIELD_HAIRCUT_BPS) / 1000n;
    if (minOutLive <= 0n) {
      probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "minOut-live-nonpositive" });
      continue;
    }
    if (minProfitLive <= 0n) {
      probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "minProfit-live-nonpositive" });
      continue;
    }
    if (minYieldLive <= 0n) {
      probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "minYield-live-nonpositive" });
      continue;
    }
    winnerLiveRepay = respay;
    winnerMinYield = minYieldLive;
    winnerMinOut = minOutLive;
    winnerMinProfit = minProfitLive;
    row = cand;
    break;
  }
  if (!row) {
    const lastReason = probeLog.length
      ? (probeLog[probeLog.length - 1].skip || "none-probed")
      : "no-eligible-rows";
    return fail("no-feasible-row:" + sanitize(lastReason).slice(0, 100));
  }

  const wantLiability = getAddress(row.vault);
  const wantCollateral = getAddress(row.collateralAsset);
  const configuration = {
    liabilityVault: wantLiability,
    collateralVault: wantCollateral,
    status: configuredPair ? "already-configured" : "pending-owner-configuration",
    configuredAtTxHash: configuredPair ? configuredPair.txHash : null,
  };
  if (!configuredPair && execute) {
    const configData = EXEC_IFACE.encodeFunctionData("setEvcConfiguration", [wantLiability, wantCollateral]);
    let configGasEst;
    try {
      configGasEst = await rpcOn(provider, "eth_estimateGas", [{ from, to: EXECUTOR, data: configData }]);
    } catch (err) {
      const msg = err && err.message ? String(err.message) : "";
      if (msg.includes("E_VAULT_PAIR")) return fail("pair-configured-unknown-values");
      return fail("pair-estimate-failed:" + sanitize(msg).slice(0, 80));
    }
    const configGasLimit = BigInt(configGasEst);
    const batchMaxGas = BigInt(batch.caps?.maxGasLimitPerTransaction ?? 0);
    if (batchMaxGas > 0n && configGasLimit > batchMaxGas) return fail("pair-estimate-gas-exceeds-batch-cap");
    configuration.gasEstimate = configGasLimit.toString();
    const configBaseFee = latest?.baseFeePerGas ? BigInt(latest.baseFeePerGas) : 0n;
    const tipWei = BigInt(1_000_000_000);
    const configBatchMaxSpend = BigInt(batch.caps?.maxNativeSpendPerTransactionWei ?? 0);
    const configCapPerGas = configBatchMaxSpend > 0n ? configBatchMaxSpend / configGasLimit : 0n;
    let configMaxFee = (configBaseFee * 2n) + (tipWei * 12n) / 10n + 2n;
    if (configCapPerGas > 0n && configMaxFee > configCapPerGas) configMaxFee = configCapPerGas;
    if (configMaxFee <= 0n) return fail("zero-fee");
    if (configBatchMaxSpend > 0n && configGasLimit * configMaxFee > configBatchMaxSpend) return fail("pair-spend-exceeds-batch-cap");
    const configSigned = await wallet.signTransaction({
      type: 2,
      chainId: Number(BigInt(chainId)),
      nonce: Number(BigInt(nonce)),
      to: EXECUTOR,
      data: configData,
      gasLimit: configGasLimit,
      maxFeePerGas: configMaxFee,
      maxPriorityFeePerGas: tipWei,
    });
    const configTxHash = await rpcOn(provider, "eth_sendRawTransaction", [configSigned]);
    let configReceipt = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 4_000));
      try {
        configReceipt = await rpcOn(provider, "eth_getTransactionReceipt", [configTxHash]);
        if (configReceipt && configReceipt.status !== undefined) break;
      } catch (_) { continue; }
    }
    if (!configReceipt || configReceipt.status === null) return fail("pair-configuration-receipt-timeout:" + configTxHash);
    if (configReceipt.status !== "0x1" && configReceipt.status !== "0x01") return fail("pair-configuration-tx-failed:" + configTxHash);
    configuration.status = "configured-this-event";
    configuration.txHash = configTxHash;
    configuration.blockNumber = Number(BigInt(configReceipt.blockNumber));
    nonce = await rpcOn(provider, "eth_getTransactionCount", [from, "pending"]);
  }

  if (row === null || winnerLiveRepay === null) return fail("winner-live-values-missing");
  const violator = getAddress(row.violator);
  const collateral = getAddress(row.collateralAsset);
  // live-anchored firing values: repay = EVK's live maxRepay of the liveness-passed
  // row; minYield/minOut/minProfit floors derive from the live view, hair-cut and
  // live/snapshot scaled. Snapshot ctx.floors only validated the row shape upstream.
  const repayAssets = winnerLiveRepay;
  const minYieldBalance = winnerMinYield;
  const minProfitWei = winnerMinProfit;
  const minOut = winnerMinOut;
  const router = getAddress(row.swapTarget);
  const routerSwapData = buildSwapPath(row.swapHops, row.swapFees);

  if (repayAssets <= 0n) return fail("repayAssets-nonpositive");
  if (minYieldBalance <= 0n) return fail("minYieldBalance-nonpositive");
  if (minProfitWei <= 0n) return fail("minProfit-nonpositive");
  if (minOut <= 0n) return fail("minOut-nonpositive");
  if (router === "0x0000000000000000000000000000000000000000") return fail("router-zero");
  if (!routerSwapData) return fail("routerSwapData-missing");

  const data = EXEC_IFACE.encodeFunctionData("execute", [
    violator, collateral, repayAssets, minYieldBalance, minProfitWei, minOut, router, routerSwapData,
  ]);

  // Dry-run while the pair is still unconfigured: the on-chain estimate is
  // expected to revert UNCONFIGURED_VAULT_PAIR (the executor requires evcConfigured).
  // That is a known-expected pending-configuration state — previewed honestly, never
  // a hidden failure. Any other revert reason stays fail-closed.
  let gasLimitEst = null;
  let estimateBlockedReason = null;
  try {
    gasLimitEst = await rpcOn(provider, "eth_estimateGas", [{ from, to: EXECUTOR, data }]);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : "";
    if (!execute && configuration.status !== "already-configured" && msg.includes("UNCONFIGURED_VAULT")) {
      estimateBlockedReason = "execute-estimate-blocked-pending-configuration";
    } else {
      return fail("estimate-failed:" + sanitize(msg).slice(0, 80));
    }
  }

  let gasLimit = null, maxFeePerGas = null, estTotal = null;
  if (gasLimitEst !== null) {
    gasLimit = BigInt(gasLimitEst);
    const batchMaxGasLimit = BigInt(batch.caps?.maxGasLimitPerTransaction ?? 0);
    if (batchMaxGasLimit > 0n && gasLimit > batchMaxGasLimit) return fail("gas-limit-exceeds-batch-cap");

    const baseFeeWei = latest?.baseFeePerGas ? BigInt(latest.baseFeePerGas) : BigInt(7);
    const tipWei = BigInt(1_000_000_000);
    const margin = (baseFeeWei * 2n) + (tipWei * 12n) / 10n + 2n;
    const batchMaxSpend = BigInt(batch.caps?.maxNativeSpendPerTransactionWei ?? 0);
    const capWeiPerGas = batchMaxSpend > 0n ? batchMaxSpend / gasLimit : 0n;
    maxFeePerGas = margin;
    if (capWeiPerGas > 0n && margin > capWeiPerGas) maxFeePerGas = capWeiPerGas;
    if (maxFeePerGas <= 0n) return fail("zero-fee");
    estTotal = gasLimit * maxFeePerGas;
    if (batchMaxSpend > 0n && estTotal > batchMaxSpend) return fail("spend-exceeds-batch-cap");
  }

  const tx = gasLimitEst !== null ? {
    type: 2,
    chainId: Number(BigInt(chainId)),
    nonce: Number(BigInt(nonce)),
    to: EXECUTOR,
    data,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas: BigInt(1_000_000_000),
  } : null;

  const estimate = {
    gasLimit: gasLimit !== null ? gasLimit.toString() : null,
    maxFeePerGas: maxFeePerGas !== null ? maxFeePerGas.toString() : null,
    maxPriorityFeePerGas: gasLimitEst !== null ? BigInt(1_000_000_000).toString() : null,
    estimatedMaxFeeWei: estTotal !== null ? estTotal.toString() : null,
    batchCapWei: BigInt(batch.caps?.maxNativeSpendPerTransactionWei ?? 0) > 0n ? batch.caps.maxNativeSpendPerTransactionWei : null,
    blockedReason: estimateBlockedReason,
    summary: estimateBlockedReason
      ? estimateBlockedReason
      : `gas<=${gasLimit} maxFee<=${maxFeePerGas}wei estimatedMaxFeeWei=${estTotal}`,
  };
  const calldata = {
    violator,
    collateral,
    repayAssets: repayAssets.toString(),
    minYieldBalance: minYieldBalance.toString(),
    minProfitWei: minProfitWei.toString(),
    minOut: minOut.toString(),
    router,
    routerSwapData,
    floorsQuoteUnit: "uoa-usdc-raw (valuation expectedOutUsdcRaw/netUsdcRaw/gasCeilingUsdcRaw; not converted, not fabricated)",
  };

  if (!execute) {
    console.log(JSON.stringify({
      ok: true,
      stage: "DRY_RUN_ESTIMATE",
      mode,
      executor: EXECUTOR,
      keyRead: false,
      networkWrite: false,
      gates: gates.map(g => ({ id: g.id, status: g.status, detail: g.detail })),
      configuration,
      rowSelection: probeLog,
      nonce: tx ? tx.nonce : null,
      chainId: Number(BigInt(chainId)),
      calldata,
      estimate,
    }, null, 2));
    return;
  }

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
  if (!receipt || receipt.status === null) {
    console.log(JSON.stringify({ ok: false, reason: "receipt-timeout", txHash }, null, 2));
    process.exitCode = 2;
    return;
  }

  const out = {
    schema: "euler-liquidation-execution/v1",
    generatedAt: new Date().toISOString(),
    scanner: "tools/execute-euler-evk-trigger.js",
    batchId: batch.batchId,
    executor: EXECUTOR,
    configuration,
    txHash,
    status: receipt.status,
    ok: receipt.status === "0x1" || receipt.status === "0x01",
    blockNumber: Number(BigInt(receipt.blockNumber)),
    gasUsed: BigInt(receipt.gasUsed).toString(),
    effectiveGasPriceWei: BigInt(receipt.effectiveGasPrice || 0).toString(),
    netDeltas: null,
    netDeltasNote: "not fabricated; net loan-asset/profit deltas require post-execution balance reads and are deliberately not estimated here",
    calldata,
    configuration,
    rowSelection: probeLog,
    gates: gates.map(g => ({ id: g.id, status: g.status })),
    readonly: false,
    signedActionJustified: true,
  };
  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.writeFileSync(path.join(OUTDIR, `execution-${Date.now()}.json`), JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(sanitize(err && err.message ? err.message : String(err)));
    process.exitCode = 1;
  });
}

module.exports = { GATE_DEFS, gateBatch, gateFreshTrigger, gateRehearsal, gateEconomics, buildSwapPath };
