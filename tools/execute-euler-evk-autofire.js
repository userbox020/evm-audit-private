#!/usr/bin/env node
"use strict";
// execute-euler-evk-autofire.js
// AUTO-FIRE signing runner for the five FRESH deployed Euler EVK flash liquidators
// (envelope coordination/live-execution-batch-euler-autofire.json:targets, batchId
// euler-autofire-20261013-01, signedExecutionsTotal 1):
//   0xd2e340b1ce33453509d34e8a8eee63e67b442c29  EULER-LIQ-V3-3
//   0xb3219646e7b93ddc6cb8e10d6d80782f42f758fa  EULER-LIQ-V3-F1
//   0xb6ae06b25bf329e02d8cafd168e38aafd0748f99  EULER-LIQ-V3-F2
//   0x45333d985c8338d14d1f0102d5e6fa6446aa669b  EULER-LIQ-V3-F3
//   0x308c3c7810c5ba1fb2a0831a6fc189014314b968  EULER-LIQ-V3-F4
// All five verify MATCH_IMMUTABLES_MASKED at block 26180740
// (reports/raw/fast/deployed-bytecode-verification.json, EULER-LIQ-V3-{3,F1,F2,F3,F4}).
//
// Mirrors tools/execute-euler-evk-trigger.js EXACTLY for: the batch-envelope gate
// ladder shape, key loading (gated env files, process-only), keyless RPC
// qualification (chainId 0x1 + finalized-hash recheck + live executor code),
// nonce/chainId/fee handling, the Balancer flash-source balance precheck, the
// live-anchored firing floors, the executor one-time setEvcConfiguration
// owner-side consumption contract, the receipt poll, and the OUTDIR writing
// pattern. Private key material is read only in --execute after every gate
// passes; it stays in-process and is never printed, hashed, persisted, or passed
// on a command line. Endpoint material (URL/host/path) is never printed/persisted.
//
// DOCUMENTED DIFFERENCES from tools/execute-euler-evk-trigger.js (honest):
//   (D1) Gate a batchId/expiry: euler-autofire-20261013-01, signedExecutionsTotal 1
//        (trigger-3 used euler-trigger-liquidation-20261013-03, signedExecutionsTotal 5).
//   (D2) Gate a is DRAFT-TOLERANT: the envelope is approved:false while the offline
//        ladder is being reviewed (envelope :7 draftNote). Gate a validates
//        present/expiresAt/account/triggerGated/targets/caps + the budget lock and
//        records `approved=<bool>` in its detail; `--execute` additionally hard-refuses
//        with `batch-not-approved` before any key read. The trigger runner required
//        approved===true inside gate a.
//   (D3) Gate b is the ONLY ladder change: the trigger runner used the watcher/valuation
//        freshness pair (euler-l-watch-status.json <=5m + euler-l-valuation.json <=10m).
//        Autofire instead requires reports/raw/fast/euler-fastlane-status.json
//        (schema euler-fastlane-watch/v1, tools/watch-euler-head-fastlane.js:499-532) to
//        be <=180s old with firedDecision === "win-probable" AND
//        decisionSummary.winProbable >= 1, plus the valuation artifact <=10m. Candidate
//        rows are the fastlane's per-row win-probable verdicts (recorded tradeoff, see
//        watch runner header :28-35: the route quote is NOT re-fetched). Gate b does NOT
//        duplicate the liveness probe and does NOT invalidate the fastlane verdict;
//        gate-d's live ladder does ALL liveness checks at fire time.
//   (D4) Gate c is identical to the trigger runner (fresh euler-fork-rehearsal PASS <=10m).
//   (D5) Gate d (offline) is the trigger runner's snapshot economics floors
//        (minOut=quoted*0.98, minProfit=netUsdc-gasBound) on the top win-probable row;
//        the LIVE-anchored floors (repayAssets = live maxRepay; minYield = live maxYield
//        x 0.98; minOut = live quoted x 0.98 scaled; minProfitWei = live net - gasCeil > 0)
//        are re-derived against the FRESHEST head block in the --execute ladder.
//   (D6) --dry-run is OFFLINE-SAFE (no RPC, no key, no signing) and exits 0 always; the
//        trigger runner's dry-run still ran the live candidate feasibility loop + estimate.
//        --execute fails-closed (exit 1) and snaps a refusal artifact to OUTDIR.
//   (D7) BUDGET LOCK: one signed FIRE per batch life (signedExecutionsTotal=1). After one
//        signed fire, every subsequent run reports honest `fire-cap-consumed` (or
//        `fire-cap-consumed-daily` for signedExecutionsPerDay) until the batch expiry
//        resets. Consumption is derived from the OUTDIR fire records.
//   (D8) HARD CAPS enforced before signing: gas <= 2,000,000 (`fire-cap-gas-exceeded`)
//        and native spend <= 2e15 wei (envelope :62-67); eth_estimateGas runs BEFORE
//        signing; the wallet balance preflight fails-closed with `fire-cap-conf-brief`
//        when balance < estimated cost + 0.0002 ETH buffer.
//   (D9) Executor pick: the first FRESH (never-configured) executor among the envelope's
//        five, via the SAME setEvcConfiguration one-time owner-side consumption contract
//        as the trigger runner (E_VAULT_PAIR_CONFIGURED, FlashLiquidateEulerEVK.sol:220).
//        ONE signed FIRE tx per fire (Balancer flash settlement); the one-time arm step
//        (setEvcConfiguration) is a separate owner-side tx, exactly as the trigger runner
//        sends it, and is recorded as configTxHash with the fire counted as the signed unit.
//
// CLI: --dry-run (default) | --execute   [--batch <path>] [--outdir <name>] [--deploy-block <n>]

const fs = require("node:fs");
const path = require("node:path");
const { Wallet, Interface, getAddress } = require(path.join(__dirname, "node_modules", "ethers"));

const ROOT = path.resolve(__dirname, "..");
const ARGV = process.argv.slice(2);
function arg(flag, fallback) {
  const i = ARGV.indexOf(flag);
  return i !== -1 && ARGV[i + 1] ? ARGV[i + 1] : fallback;
}
const BUNDLE = path.resolve(ROOT, arg("--batch", "coordination/live-execution-batch-euler-autofire.json"));
const FASTLANE = path.join(ROOT, "reports", "raw", "fast", "euler-fastlane-status.json");
const VALUATION = path.join(ROOT, "reports", "raw", "fast", "euler-l-valuation.json");
const REHEARSAL = path.join(ROOT, "reports", "raw", "fast", "euler-fork-rehearsal", "result.json");
const OUTDIR = path.join(ROOT, "reports", "raw", "fast", arg("--outdir", "euler-autofire-out"));
const ENV_FILES = [path.join(ROOT, ".env"), path.join(ROOT, ".env.exploit")];

const MAIN_ACCOUNT = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";

const FRESH_FASTLANE_MS = 180 * 1000; // (D3) fastlane artifact <=180s
const FRESH_VALUATION_MS = 10 * 60 * 1000;
const FRESH_REHEARSAL_MS = 10 * 60 * 1000;
const MIN_OUT_HAIRCUT_BPS = 98n;      // minOut floor = quoted * 0.98
const MIN_YIELD_HAIRCUT_BPS = 980n;   // minYield floor = live maxYield * 0.98

// (D8) envelope caps coordination/live-execution-batch-euler-autofire.json:62-67.
const DEFAULT_MAX_GAS_LIMIT = 2_000_000n;
const DEFAULT_MAX_NATIVE_SPEND_WEI = 2_000_000_000_000_000n;
const BALANCE_BUFFER_WEI = 200_000_000_000_000n; // 0.0002 ETH buffer
const TIP_WEI = 1_000_000_000n;

// (D9) executor deploy scan floor: earliest fresh deploy (executor #3, block 26179960,
// coordination/live-execution-batch-euler-trigger-3.json approvedAt) / fleet F3 at
// block 26180735 (reports/raw/fast/euler-fleet-deploy-status.json). Overridable.
const EXECUTOR_DEPLOY_BLOCK = Number(arg("--deploy-block", "26179960"));

// Exact deployed executor surface (FlashLiquidateEulerEVK.sol:243-252).
const EXEC_IFACE = new Interface([
  "function execute(address violator,address collateral,uint256 repayAssets,uint256 minYieldBalance,uint256 minProfitWei,uint256 minOut,address router,bytes routerSwapData) external",
  "function owner() view returns (address)",
  "function setEvcConfiguration(address liabilityVault,address collateralVault) external",
  "event EvcConfigurationSet(address liabilityVault,address collateralVault)",
]);
const CONFIG_TOPIC0 = EXEC_IFACE.getEvent("EvcConfigurationSet").topicHash;

// Flash-source funding precheck (BAL#528 = INSUFFICIENT_FLASH_LOAN_BALANCE).
const BALANCER_VAULT = getAddress("0xBA12222222228d8Ba445958a75a0704d566BF2C8");
const MAX_ROW_PROBES = 3;
const ERC20_IFACE = new Interface(["function balanceOf(address) view returns (uint256)"]);
const LIQ_VIEW_IFACE = new Interface(["function checkLiquidation(address liquidator,address violator,address collateral) view returns (uint256 maxRepay, uint256 maxYield)"]);

let MODE = "DRY_RUN";

// ---- helpers (mirror the trigger runner) ----
function rel(file) { return path.relative(ROOT, file).replace(/\\/g, "/"); }
function sanitize(v) { return typeof v === "string" ? v.replaceAll(/[0-9a-fA-F]{64}/g, "<64hex>") : v; }
function toBig(value) { try { return value === null || value === undefined ? null : BigInt(value); } catch (_) { return null; } }
function toNum(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function tryReadJson(file) {
  try {
    if (!fs.existsSync(file)) return { exists: false, ok: false, value: null };
    return { exists: true, ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (_) { return { exists: true, ok: false, value: null }; }
}
function ageMs(iso) { const t = Date.parse(iso); return Number.isFinite(t) ? Date.now() - t : null; }
function isQuantity(v) { return typeof v === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v); }
function isHash(v) { return typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v); }

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

function loadRpcUrls() {
  try { return require("./shared-rpc").loadRpcUrls({ maxCandidates: 40 }); } catch (_) { return []; }
}

async function qualify() {
  for (const url of loadRpcUrls()) {
    let chainId, finalized, recheck, code;
    try { chainId = await rpcOn(url, "eth_chainId", []); } catch (_) { continue; }
    if (chainId !== "0x1") continue;
    try { finalized = await rpcOn(url, "eth_getBlockByNumber", ["finalized", false]); } catch (_) { continue; }
    if (!finalized || !isHash(finalized.hash) || !isQuantity(finalized.number)) continue;
    try { recheck = await rpcOn(url, "eth_getBlockByNumber", [finalized.number, false]); } catch (_) { continue; }
    if (!recheck || recheck.hash !== finalized.hash) continue;
    try { code = await rpcOn(url, "eth_getCode", [getAddress(executorsOf().length ? executorsOf()[0].address : MAIN_ACCOUNT), "latest"]); } catch (_) { continue; }
    if (typeof code !== "string" || code.length <= 2) continue;
    return url;
  }
  return fail("no-qualified-provider");
}

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

function executorsOf() {
  const b = tryReadJson(BUNDLE).value;
  const list = Array.isArray(b && b.targets) ? b.targets.filter((t) => t && t.kind === "executor") : [];
  return list.map((t) => {
    let address = t.address;
    try { address = getAddress(t.address); } catch (_) { /* keep raw */ }
    return { label: t.label || null, address, state: t.state || null };
  });
}

function budgetTotal() { const b = tryReadJson(BUNDLE).value; return { total: Number(b && b.caps ? (b.caps.signedExecutionsTotal ?? 1) : 1), perDay: Number(b && b.caps ? (b.caps.signedExecutionsPerDay ?? 1) : 1) }; }

// ---- OPTIONAL executor-view helpers ----
async function readBalancerBalance(provider, token) {
  const raw = await rpcOn(provider, "eth_call", [{ to: getAddress(token), data: ERC20_IFACE.encodeFunctionData("balanceOf", [BALANCER_VAULT]) }, "latest"]);
  return typeof raw === "string" && raw.length > 2 ? BigInt(raw) : null;
}
async function readCheckLiquidation(provider, vault, liquidator, violator, collateral) {
  const raw = await rpcOn(provider, "eth_call", [{ to: getAddress(vault), data: LIQ_VIEW_IFACE.encodeFunctionData("checkLiquidation", [getAddress(liquidator), getAddress(violator), getAddress(collateral)]) }, "latest"]);
  if (typeof raw !== "string" || raw.length <= 2) return null;
  const dec = LIQ_VIEW_IFACE.decodeFunctionResult("checkLiquidation", raw);
  return { maxRepay: BigInt(dec[0]), maxYield: BigInt(dec[1]) };
}
async function findConfiguredPair(provider, executorAddr) {
  const headRaw = await rpcOn(provider, "eth_blockNumber", []);
  const head = Number(BigInt(headRaw));
  const start = EXECUTOR_DEPLOY_BLOCK;
  for (let from = start; from <= head; from += 9_500) {
    const to = Math.min(from + 9_499, head);
    const logs = await rpcOn(provider, "eth_getLogs", [{ address: executorAddr, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [CONFIG_TOPIC0] }]);
    if (Array.isArray(logs) && logs.length) {
      const last = logs[logs.length - 1];
      const decoded = EXEC_IFACE.decodeEventLog("EvcConfigurationSet", last.data, last.topics);
      return { liabilityVault: getAddress(decoded[0]), collateralVault: getAddress(decoded[1]), txHash: last.transactionHash, blockNumber: Number(BigInt(last.blockNumber)) };
    }
  }
  return null;
}
async function findFreshExecutor(provider, batch) {
  const execs = (Array.isArray(batch.targets) ? batch.targets : []).filter((t) => t && t.kind === "executor");
  for (const t of execs) {
    const addr = getAddress(t.address);
    const pair = await findConfiguredPair(provider, addr);
    if (!pair) return { label: t.label || null, address: addr, fresh: true };
  }
  return null;
}

// ---- budget lock (D7) ----
function readFireRecords() {
  try {
    if (!fs.existsSync(OUTDIR)) return [];
    const out = [];
    for (const name of fs.readdirSync(OUTDIR)) {
      if (!/\.json$/i.test(name)) continue;
      if (/\.executor\.json$/i.test(name)) continue;
      const r = tryReadJson(path.join(OUTDIR, name));
      if (r.ok && r.value && r.value.schema === "euler-autofire-out/v1") out.push(r.value);
    }
    return out;
  } catch (_) { return []; }
}
function readBudgetLock() {
  const { total, perDay } = budgetTotal();
  const b = tryReadJson(BUNDLE).value;
  const batchId = b && b.batchId ? b.batchId : null;
  // One fire per batch life: only this batch's fire records count (a new batchId resets).
  const signed = readFireRecords().filter((f) => f && f.signed === true && (batchId === null || f.batchId === batchId));
  const count = signed.length;
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = signed.filter((f) => typeof f.generatedAt === "string" && f.generatedAt.slice(0, 10) === today).length;
  if (count >= total) return { consumed: true, kind: "total", count, total, perDay, todayCount, detail: `fire-cap-consumed:signedExecutionsTotal=${total} spent=${count} (batch life exhausted; resets at expiresAt=${b && b.expiresAt})` };
  if (todayCount >= perDay) return { consumed: true, kind: "daily", count, total, perDay, todayCount, detail: `fire-cap-consumed-daily:signedExecutionsPerDay=${perDay} spentToday=${todayCount} (resets next UTC day)` };
  return { consumed: false, kind: null, count, total, perDay, todayCount, detail: `budget ok fired=${count}/${total} (today ${todayCount}/${perDay})` };
}

// ---- gate ladder (all evaluated in order, in-process, before any key read) ----

// a. batch present / unexpired / account / triggerGated+targets+caps + budget lock.
//    (D2) DRAFT-tolerant: records approved=<bool>; --execute enforces approval separately.
function gateBatch() {
  const r = tryReadJson(BUNDLE);
  if (!r.exists) return { ok: false, detail: `batch-missing:${rel(BUNDLE)}` };
  if (!r.ok) return { ok: false, detail: "batch-unreadable-or-invalid-json" };
  const b = r.value;
  const exp = Date.parse(b.expiresAt);
  if (!Number.isFinite(exp)) return { ok: false, detail: "batch-expiresAt-unparseable" };
  if (exp < Date.now()) return { ok: false, detail: "batch-expired" };
  if (String((b.account && b.account.address) || "").toLowerCase() !== MAIN_ACCOUNT) return { ok: false, detail: "batch-account-mismatch" };
  if (!Array.isArray(b.targets) || !b.targets.some((t) => t && t.kind === "executor")) return { ok: false, detail: "batch-targets-missing-executors" };
  if (!b.caps || typeof b.caps !== "object" || b.caps.maxGasLimitPerTransaction === undefined || b.caps.maxNativeSpendPerTransactionWei === undefined) return { ok: false, detail: "batch-caps-missing" };
  const budget = readBudgetLock();
  if (budget.consumed) return { ok: false, reason: budget.kind === "daily" ? "fire-cap-consumed-daily" : "fire-cap-consumed", detail: budget.detail };
  const approved = b.approved === true;
  return { ok: true, approved, batch: b, budget, detail: `batchId=${b.batchId} approved=${approved} expiresAt=${b.expiresAt} signedExecutionsTotal=${b.caps.signedExecutionsTotal} ${budget.detail} (DRAFT approval enforced only in --execute)` };
}

// b. (D3) FASTLANE artifact contract (the only ladder change): euler-fastlane-status.json
//    <=180s, firedDecision === "win-probable", decisionSummary.winProbable >= 1; plus the
//    valuation artifact <=10m. Candidate rows = per-row win-probable verdicts. No liveness
//    probe here; the fastlane verdict is NOT invalidated by this runner.
function gateFastlane() {
  const f = tryReadJson(FASTLANE);
  if (!f.exists) return { ok: false, detail: `fastlane-status-missing:${rel(FASTLANE)}` };
  if (!f.ok) return { ok: false, detail: "fastlane-status-unreadable-or-invalid-json" };
  const a = f.value;
  if (a.schema !== "euler-fastlane-watch/v1") return { ok: false, detail: `fastlane-schema-unexpected:${a.schema}` };
  const fAge = ageMs(a.scannedAt);
  if (fAge === null) return { ok: false, detail: "fastlane-scannedAt-unparseable" };
  if (fAge > FRESH_FASTLANE_MS) return { ok: false, detail: `fastlane-stale:${Math.round(fAge / 1000)}s>${FRESH_FASTLANE_MS / 1000}s` };
  if (fAge < -60_000) return { ok: false, detail: "fastlane-scannedAt-in-future" };
  if (a.firedDecision !== "win-probable") return { ok: false, detail: `fastlane-firedDecision-not-win-probable:${a.firedDecision}` };
  const ds = a.decisionSummary || a.decisionsummary || {};
  const wp = toNum(ds.winProbable);
  if (wp < 1) return { ok: false, detail: `fastlane-winProbable-lt-1:${ds.winProbable === undefined ? null : ds.winProbable}` };

  const verdicts = Array.isArray(a.verdicts) ? a.verdicts : [];
  const candidates = verdicts.filter((r) => r && r.decision === "win-probable");
  if (!candidates.length) return { ok: false, detail: `fastlane-no-win-probable-verdict-rows:verdicts=${verdicts.length}` };

  const v = tryReadJson(VALUATION);
  if (!v.exists) return { ok: false, detail: `valuation-missing:${rel(VALUATION)}` };
  if (!v.ok) return { ok: false, detail: "valuation-unreadable-or-invalid-json" };
  const vAge = ageMs(v.value.generatedAt);
  if (vAge === null) return { ok: false, detail: "valuation-generatedAt-unparseable" };
  if (vAge > FRESH_VALUATION_MS) return { ok: false, detail: `valuation-stale:${Math.round(vAge / 1000)}s>${FRESH_VALUATION_MS / 1000}s` };
  if (vAge < -60_000) return { ok: false, detail: "valuation-generatedAt-in-future" };

  const rows = Array.isArray(v.value.rows) ? v.value.rows : [];
  const byV = new Map(rows.filter(Boolean).map((row) => [String(row.violator || "").toLowerCase(), row]));
  const enriched = [];
  for (const c of candidates) {
    const row = byV.get(String(c.violator || "").toLowerCase());
    if (!row) continue;
    if (!(row.routePositive === true && Array.isArray(row.swapHops) && row.swapHops.length >= 2 && row.swapTarget)) continue;
    enriched.push(row);
  }
  if (!enriched.length) return { ok: false, detail: `fastlane-candidates-not-buildable-in-valuation:candidates=${candidates.length}` };

  let chosen = null;
  for (const row of enriched) { const net = toBig(row.netUsdcRaw); if (net === null) continue; if (!chosen || net > chosen.net) chosen = { row, net }; }
  if (!chosen) return { ok: false, detail: "fastlane-candidate-rows-lack-netUsdcRaw" };

  return {
    ok: true,
    detail: `fastlane age=${Math.round(fAge / 1000)}s firedDecision=win-probable winProbable=${wp} candidates=${enriched.length}; valuation age=${Math.round(vAge / 1000)}s topNetUsdcRaw=${chosen.net} headBlock=${a.headBlock === undefined ? null : a.headBlock}`,
    row: chosen.row, net: chosen.net, valuationArtifact: v.value, fastlaneArtifact: a, candidateRows: candidates, headBlock: a.headBlock === undefined ? null : a.headBlock, candidateCount: enriched.length,
  };
}

// c. fresh fork rehearsal: state PASS and generatedAt (or completedAt) <= 10m (identical to trigger).
function gateRehearsal() {
  const r = tryReadJson(REHEARSAL);
  if (!r.exists) return { ok: false, detail: `rehearsal-result-missing:${rel(REHEARSAL)}` };
  if (!r.ok) return { ok: false, detail: "rehearsal-result-unreadable-or-invalid-json" };
  const a = r.value;
  if (a.state !== "PASS") return { ok: false, detail: `rehearsal-state-not-PASS:${a.state}` };
  const ages = [ageMs(a.generatedAt), ageMs(a.completedAt)].filter((x) => x !== null);
  if (!ages.length) return { ok: false, detail: "rehearsal-timestamps-unparseable" };
  const age = Math.min(...ages);
  if (age > FRESH_REHEARSAL_MS) return { ok: false, detail: `rehearsal-stale:${Math.round(age / 1000)}s>${FRESH_REHEARSAL_MS / 1000}s` };
  return { ok: true, detail: `PASS at ${rel(REHEARSAL)} age=${Math.round(age / 1000)}s` };
}

// d. (D5) snapshot economics floors (identical to trigger's gateEconomics). The live-anchored
//    floors are re-derived against the freshest head block in the --execute ladder.
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
  return { ok: true, detail: `minOutFloorRaw=${minOutFloorRaw} minProfitFloorRaw=${minProfitFloorRaw} (quotedOut=${quotedOut}*0.98; netUsdc=${netUsdc}-gasBound=${gasBound})`, floors: { minOutFloorRaw, minProfitFloorRaw, quotedOut, netUsdc, gasBound } };
}

const GATE_DEFS = [
  { id: "a", name: "batch present/unexpired/account/triggerGated+targets+caps + budget lock (approved enforced in --execute)", fn: gateBatch },
  { id: "b", name: "FASTLANE artifact euler-fastlane-status.json <=180s + firedDecision=win-probable + decisionSummary.winProbable>=1 (valuation <=10m, candidates=win-probable rows)", fn: gateFastlane },
  { id: "c", name: "fork rehearsal state PASS fresh <=10m", fn: gateRehearsal },
  { id: "d", name: "economics floors (snapshot minOut=quoted*0.98, minProfit=netUsdc-gasBound) nonzero; live-anchored at fire time", fn: gateEconomics },
];

// Uniswap V3 exactInput path bytes (identical to trigger runner).
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

function writeArtifact(name, payload) {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const file = path.join(OUTDIR, name);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return file;
}

function fail(code, detail) {
  const payload = { ok: false, reason: code, detail: detail === undefined ? null : detail, mode: MODE };
  if (MODE === "EXECUTE") { try { writeArtifact(`refuse-${Date.now()}.json`, { schema: "euler-autofire-refusal/v1", generatedAt: new Date().toISOString(), scanner: "tools/execute-euler-evk-autofire.js", ...payload }); } catch (_) { /* best-effort */ } }
  console.log(JSON.stringify(payload));
  process.exit(1);
}

// --dry-run exits 0; --execute fails-closed with a refusal artifact ("snaps state").
function refuse(mode, gates, firstFailure, reason) {
  const b = tryReadJson(BUNDLE).value;
  const payload = {
    ok: false,
    reason: reason || "execution-needs-live-autofire-state",
    stage: "PRECONDITION_GATES",
    mode,
    batchId: b && b.batchId ? b.batchId : null,
    firstFailure,
    keyRead: false,
    networkWrite: false,
    gates,
  };
  if (mode === "EXECUTE") { try { writeArtifact(`refuse-${Date.now()}.json`, { schema: "euler-autofire-refusal/v1", generatedAt: new Date().toISOString(), scanner: "tools/execute-euler-evk-autofire.js", ...payload }); } catch (_) { /* best-effort */ } }
  console.log(JSON.stringify(payload, null, 2));
  process.exit(mode === "EXECUTE" ? 1 : 0);
}

function enrichExecutableRows(candidateVerdicts, valuation) {
  const rows = Array.isArray(valuation && valuation.rows) ? valuation.rows : [];
  const byV = new Map(rows.filter(Boolean).map((r) => [String(r.violator || "").toLowerCase(), r]));
  const out = [];
  const seen = new Set();
  for (const c of (Array.isArray(candidateVerdicts) ? candidateVerdicts : [])) {
    const key = String((c && c.violator) || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const row = byV.get(key);
    if (row) out.push(row);
  }
  return out;
}

async function main() {
  const execute = ARGV.includes("--execute");
  MODE = execute ? "EXECUTE" : "DRY_RUN";

  const gates = [];
  const ctx = {};
  for (let i = 0; i < GATE_DEFS.length; i++) {
    const def = GATE_DEFS[i];
    const result = def.id === "d" ? def.fn(ctx.triggerRow) : def.fn();
    const ok = result.ok === true;
    gates.push({ order: def.id, id: def.id, name: def.name, ok, status: ok ? "pass" : "fail", detail: result.detail });
    if (!ok) {
      for (let j = i + 1; j < GATE_DEFS.length; j++) gates.push({ order: GATE_DEFS[j].id, id: GATE_DEFS[j].id, name: GATE_DEFS[j].name, ok: null, status: "skipped", detail: "not evaluated: earlier gate failed" });
      return refuse(MODE, gates, def.id, result.reason);
    }
    if (def.id === "a") { ctx.batch = result.batch; ctx.approved = result.approved; ctx.budget = result.budget; }
    if (def.id === "b") { ctx.triggerRow = result.row; ctx.valuationArtifact = result.valuationArtifact; ctx.fastlaneArtifact = result.fastlaneArtifact; ctx.candidateRows = result.candidateRows; ctx.headBlock = result.headBlock; ctx.candidateCount = result.candidateCount; }
    if (def.id === "d") ctx.floors = result.floors;
  }

  // ---- step 2: dry-run is OFFLINE-SAFE (D6): print the ladder + candidate rows, exit 0 ----
  if (!execute) {
    console.log(JSON.stringify({
      ok: true,
      stage: "DRY_RUN_ESTIMATE",
      mode: MODE,
      offlineSafe: true,
      keyRead: false,
      networkWrite: false,
      batchId: ctx.batch.batchId,
      approvalPending: ctx.approved !== true,
      executorPool: executorsOf(),
      budget: ctx.budget,
      fastlaneHeadBlock: ctx.headBlock,
      fastlaneFiredDecision: ctx.fastlaneArtifact ? ctx.fastlaneArtifact.firedDecision : null,
      candidateCount: ctx.candidateCount,
      candidateRows: Array.isArray(ctx.candidateRows) ? ctx.candidateRows : [],
      gates: gates.map((g) => ({ id: g.id, status: g.status, detail: g.detail })),
      floors: ctx.floors ? {
        minOutFloorRaw: ctx.floors.minOutFloorRaw.toString(),
        minProfitFloorRaw: ctx.floors.minProfitFloorRaw.toString(),
        quotedOut: ctx.floors.quotedOut.toString(),
        netUsdc: ctx.floors.netUsdc.toString(),
        gasBound: ctx.floors.gasBound.toString(),
      } : null,
      note: "dry-run is offline-safe: no RPC, no key read, no signing. Approval (DRAFT) is enforced only in --execute. Live anchoring (live maxRepay/maxYield liveness + eth_estimateGas caps + balance preflight) runs only in --execute.",
    }, null, 2));
    return;
  }

  // ---- step 3: --execute only after every gate passed. (D2) approval hard-refusal. ----
  if (ctx.batch.approved !== true) return refuse(MODE, gates, "a", "batch-not-approved");

  const batch = ctx.batch;
  const maxGasCap = BigInt(batch.caps.maxGasLimitPerTransaction ?? DEFAULT_MAX_GAS_LIMIT);
  const maxSpendCap = BigInt(batch.caps.maxNativeSpendPerTransactionWei ?? DEFAULT_MAX_NATIVE_SPEND_WEI);

  const key = loadPrivateKey();
  const wallet = new Wallet(key);
  if (wallet.address.toLowerCase() !== MAIN_ACCOUNT) return fail("key-account-mismatch");
  const from = wallet.address;

  const provider = await qualify();
  let [nonce, chainId, latest] = await Promise.all([
    rpcOn(provider, "eth_getTransactionCount", [from, "pending"]),
    rpcOn(provider, "eth_chainId", []),
    rpcOn(provider, "eth_getBlockByNumber", ["latest", false]),
  ]);

  // (D9) fresh executor pick via the one-time setEvcConfiguration consumption contract.
  const freshExec = await findFreshExecutor(provider, batch);
  if (!freshExec) return fail("no-fresh-executor");
  const EXECUTOR = freshExec.address;
  const configuredPair = null; // a fresh executor has never emitted EvcConfigurationSet

  const probeLog = [];
  const eligibleRows = enrichExecutableRows(ctx.candidateRows, ctx.valuationArtifact)
    .sort((a, b) => {
      const x = toBig(a.netUsdcRaw), y = toBig(b.netUsdcRaw);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return x < y ? 1 : x > y ? -1 : 0;
    })
    .slice(0, MAX_ROW_PROBES);

  let row = null, winnerLiveRepay = null, winnerMinYield = null, winnerMinOut = null, winnerMinProfit = null;
  for (const cand of eligibleRows) {
    const cLiab = getAddress(cand.vault);
    const cColl = getAddress(cand.collateralAsset);
    if (configuredPair && (getAddress(configuredPair.liabilityVault) !== cLiab || getAddress(configuredPair.collateralVault) !== cColl)) {
      probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "configured-pair-mismatch" });
      continue;
    }
    const floorsC = gateEconomics(cand);
    if (!floorsC.ok) { probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "floors:" + floorsC.detail }); continue; }
    const repayRaw = toBig(cand.repayAssetsRaw);
    if (repayRaw === null || repayRaw <= 0n) { probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "repayAssets-nonpositive" }); continue; }
    const balRaw = await readBalancerBalance(provider, cand.liabilityAsset).catch(() => null);
    if (balRaw === null) { probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "flash-balance-unreadable" }); continue; }
    if (balRaw < repayRaw) { probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "flash-source-insufficient", bal: balRaw.toString(), requested: repayRaw.toString() }); continue; }

    // live liveness at the freshest head block (only change source: gate-b candidates).
    const live = await readCheckLiquidation(provider, cand.vault, from, cand.violator, cand.collateralAsset).catch(() => null);
    if (live === null) { probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "liveness-unreadable" }); continue; }
    if (live.maxRepay === 0n || live.maxYield === 0n) { probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "row-already-eaten" }); continue; }
    if (live.maxRepay < repayRaw) { probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "liveness-shrunk", liveRepay: live.maxRepay.toString(), rowRepay: repayRaw.toString() }); continue; }
    if (balRaw < live.maxRepay) { probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "flash-source-insufficient-live", bal: balRaw.toString(), requested: live.maxRepay.toString() }); continue; }

    // live-anchored floors (identical to trigger runner).
    const respay = live.maxRepay;
    const minOutLive = (BigInt(cand.expectedOutUsdcRaw) * 98n * respay) / (100n * repayRaw);
    const minProfitLive = (BigInt(cand.netUsdcRaw) * respay) / repayRaw - BigInt(cand.gasCeilingUsdcRaw ?? 0);
    const minYieldLive = (live.maxYield * MIN_YIELD_HAIRCUT_BPS) / 1000n;
    if (minOutLive <= 0n) { probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "minOut-live-nonpositive" }); continue; }
    if (minProfitLive <= 0n) { probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "minProfit-live-nonpositive" }); continue; }
    if (minYieldLive <= 0n) { probeLog.push({ row: String(cand.violator || "").slice(0, 10), skip: "minYield-live-nonpositive" }); continue; }

    winnerLiveRepay = respay; winnerMinYield = minYieldLive; winnerMinOut = minOutLive; winnerMinProfit = minProfitLive;
    row = cand;
    break;
  }
  if (!row) {
    const lastReason = probeLog.length ? (probeLog[probeLog.length - 1].skip || "none-probed") : "no-eligible-rows";
    return fail("no-feasible-row:" + sanitize(lastReason).slice(0, 100));
  }

  const wantLiability = getAddress(row.vault);
  const wantCollateral = getAddress(row.collateralAsset);
  const configuration = { liabilityVault: wantLiability, collateralVault: wantCollateral, status: "pending-owner-configuration", configuredAtTxHash: null };

  // One-time owner-side arm (mirror the trigger runner's config transaction).
  const configData = EXEC_IFACE.encodeFunctionData("setEvcConfiguration", [wantLiability, wantCollateral]);
  let configGasLimit = null, configMaxFeePerGas = null;
  try {
    const configGasEst = await rpcOn(provider, "eth_estimateGas", [{ from, to: EXECUTOR, data: configData }]);
    configGasLimit = BigInt(configGasEst);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : "";
    if (msg.includes("E_VAULT_PAIR")) return fail("pair-configured-unknown-values");
    return fail("pair-estimate-failed:" + sanitize(msg).slice(0, 80));
  }
  if (maxGasCap > 0n && configGasLimit > maxGasCap) return fail("pair-estimate-gas-exceeds-batch-cap");
  {
    const baseFeeWei = latest && latest.baseFeePerGas ? BigInt(latest.baseFeePerGas) : 7n;
    const capPerGas = maxSpendCap > 0n ? maxSpendCap / configGasLimit : 0n;
    let mf = (baseFeeWei * 2n) + (TIP_WEI * 12n) / 10n + 2n;
    if (capPerGas > 0n && mf > capPerGas) mf = capPerGas;
    if (mf <= 0n) return fail("zero-fee");
    if (maxSpendCap > 0n && configGasLimit * mf > maxSpendCap) return fail("pair-spend-exceeds-batch-cap");
    configMaxFeePerGas = mf;
  }
  configuration.gasEstimate = configGasLimit.toString();
  const configSigned = await wallet.signTransaction({ type: 2, chainId: Number(BigInt(chainId)), nonce: Number(BigInt(nonce)), to: EXECUTOR, data: configData, gasLimit: configGasLimit, maxFeePerGas: configMaxFeePerGas, maxPriorityFeePerGas: TIP_WEI });
  const configTxHash = await rpcOn(provider, "eth_sendRawTransaction", [configSigned]);
  let configReceipt = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4_000));
    try { configReceipt = await rpcOn(provider, "eth_getTransactionReceipt", [configTxHash]); if (configReceipt && configReceipt.status !== undefined) break; } catch (_) { continue; }
  }
  if (!configReceipt || configReceipt.status === null) return fail("pair-configuration-receipt-timeout:" + configTxHash);
  if (configReceipt.status !== "0x1" && configReceipt.status !== "0x01") return fail("pair-configuration-tx-failed:" + configTxHash);
  configuration.status = "configured-this-event";
  configuration.txHash = configTxHash;
  configuration.blockNumber = Number(BigInt(configReceipt.blockNumber));
  nonce = await rpcOn(provider, "eth_getTransactionCount", [from, "pending"]);

  const violator = getAddress(row.violator);
  const collateral = getAddress(row.collateralAsset);
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

  const data = EXEC_IFACE.encodeFunctionData("execute", [violator, collateral, repayAssets, minYieldBalance, minProfitWei, minOut, router, routerSwapData]);

  // (D8) eth_estimateGas BEFORE signing; 2M gas hard stop.
  let gasLimitEst;
  try { gasLimitEst = await rpcOn(provider, "eth_estimateGas", [{ from, to: EXECUTOR, data }]); }
  catch (err) { return fail("estimate-failed:" + sanitize(err && err.message ? String(err.message) : "").slice(0, 80)); }
  const gasLimit = BigInt(gasLimitEst);
  if (maxGasCap > 0n && gasLimit > maxGasCap) {
    return fail("fire-cap-gas-exceeded", `estimated gas ${gasLimit} > cap ${maxGasCap} (row ${violator})`);
  }
  const baseFee = latest && latest.baseFeePerGas ? BigInt(latest.baseFeePerGas) : 7n;
  const capPerGas = maxSpendCap > 0n ? maxSpendCap / gasLimit : 0n;
  let maxFeePerGas = (baseFee * 2n) + (TIP_WEI * 12n) / 10n + 2n;
  if (capPerGas > 0n && maxFeePerGas > capPerGas) maxFeePerGas = capPerGas;
  if (maxFeePerGas <= 0n) return fail("zero-fee");
  const estFireWei = gasLimit * maxFeePerGas;
  if (maxSpendCap > 0n && estFireWei > maxSpendCap) return fail("spend-exceeds-batch-cap");

  // (D8) wallet balance preflight: balance < estimated cost + 0.0002 ETH buffer.
  const estTotalCostWei = (configGasLimit * configMaxFeePerGas) + estFireWei;
  const balHex = await rpcOn(provider, "eth_getBalance", [from, "latest"]);
  const balWei = BigInt(balHex);
  if (balWei < estTotalCostWei + BALANCE_BUFFER_WEI) {
    return fail("fire-cap-conf-brief", `balance ${balWei} < cost ${estTotalCostWei} + buffer ${BALANCE_BUFFER_WEI}`);
  }

  const tx = { type: 2, chainId: Number(BigInt(chainId)), nonce: Number(BigInt(nonce)), to: EXECUTOR, data, gasLimit, maxFeePerGas, maxPriorityFeePerGas: TIP_WEI };
  const signed = await wallet.signTransaction(tx);
  const txHash = await rpcOn(provider, "eth_sendRawTransaction", [signed]);

  let receipt = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4_000));
    try { receipt = await rpcOn(provider, "eth_getTransactionReceipt", [txHash]); if (receipt && receipt.status !== undefined) break; } catch (_) { continue; }
  }

  const ok = !!receipt && (receipt.status === "0x1" || receipt.status === "0x01");
  const artifact = {
    schema: "euler-autofire-out/v1",
    generatedAt: new Date().toISOString(),
    scanner: "tools/execute-euler-evk-autofire.js",
    mode: MODE,
    batchId: batch.batchId,
    signed: true,
    signedTransactionsInThisFire: configuration.status === "configured-this-event" ? 2 : 1,
    gates: gates.map((g) => ({ id: g.id, status: g.status })),
    candidateCount: ctx.candidateCount,
    candidateRow: { violator, vault: wantLiability, collateralAsset: wantCollateral },
    firedDecision: ctx.fastlaneArtifact ? ctx.fastlaneArtifact.firedDecision : null,
    executor: { label: freshExec.label, address: EXECUTOR },
    configuration,
    txHash,
    configTxHash,
    status: receipt ? receipt.status : null,
    ok,
    blockNumber: receipt ? Number(BigInt(receipt.blockNumber)) : null,
    gasUsed: receipt ? BigInt(receipt.gasUsed).toString() : null,
    effectiveGasPriceWei: receipt ? BigInt(receipt.effectiveGasPrice || 0).toString() : "0",
    floors: { repayAssets: repayAssets.toString(), minYieldBalance: minYieldBalance.toString(), minProfitWei: minProfitWei.toString(), minOut: minOut.toString() },
    calldata: { violator, collateral, repayAssets: repayAssets.toString(), minYieldBalance: minYieldBalance.toString(), minProfitWei: minProfitWei.toString(), minOut: minOut.toString(), router, routerSwapData, floorsQuoteUnit: "uoa-usdc-raw (valuation expectedOutUsdcRaw/netUsdcRaw/gasCeilingUsdcRaw; not converted, not fabricated)" },
    rowSelection: probeLog,
    oneShotOutcome: receipt === null ? "receipt-timeout" : (ok ? "fired-ok" : "fired-reverted"),
    keyRead: true,
    networkWrite: true,
  };
  writeArtifact(`fire-${Date.now()}.json`, artifact);
  writeArtifact(`fire-${Date.now()}.executor.json`, { schema: "euler-autofire-executor-row/v1", generatedAt: artifact.generatedAt, executor: artifact.executor, configuration, txHash, configTxHash, status: artifact.status, ok: artifact.ok, gasUsed: artifact.gasUsed });
  console.log(JSON.stringify({ ok, stage: "SENT", txHash, configTxHash, oneShotOutcome: artifact.oneShotOutcome }, null, 2));
  if (receipt === null) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(sanitize(err && err.message ? err.message : String(err)));
    process.exitCode = 1;
  });
}

module.exports = { GATE_DEFS, gateBatch, gateFastlane, gateRehearsal, gateEconomics, buildSwapPath, readBudgetLock, enrichExecutableRows };
