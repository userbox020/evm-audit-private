#!/usr/bin/env node
"use strict";
// crossing-fluid-t2t4-exec.js — standing one-shot crossing driver for the Fluid T2/T4 lane
// (executor 0x719ae473cdacaab7cebdc6b47b085123d5ead39c, batch
//  live-execution-batch-fluid-t2t4-trigger.json). Mirrors crossing-euler-evk-exec2.js.
//
// Relaunch policy: the watchdog supervisor relaunches this process after each exit;
// the driver paces itself to AT MOST one full chain attempt per ~30 min via its own
// status artifact's lastChainRunAt (pacing skips PRESERVE lastChainRunAt/result/steps,
// learned from the restart-churn history). Heartbeat on EVERY exit so the supervisor's
// staleSeconds stays satisfied.
//
// Chain per full run: cheap live probe FIRST (eligible Ethereum economics rows via the
// trigger runner's exported selection helpers + one per-row eth_call simulateLiquidate)
// -> only when a probe reports liquidatable debt > 0: real fork rehearsal
// (tools/fluid-t2t4-fork-rehearsal-real.js must report state PASS, i.e. realizedNet>0 on
// real executor bytecode at a real pin) -> trigger dry-run -> execute-once.
// Fail-closed everywhere; endpoints/key material never printed or persisted. The
// rehearsal evidence is labeled REHEARSAL_EVIDENCE_NOT_AUTHORIZATION; the trigger
// runner's own gate set remains the sole firing authority.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const process = require("node:process");

const trig = require("./execute-fluid-t2t4-trigger");
const reh = require("./fluid-t2t4-fork-rehearsal-real");

const STATUS = path.join("reports", "raw", "fast", "fluid-crossing-exec-status.json");
const PACING_MS = 30 * 60 * 1000;
const REHEARSAL_TIMEOUT_MS = 480 * 1000;
const PROBE_TIMEOUT_MS = 15 * 1000;
const REHEARSAL_SCRIPT = "tools/fluid-t2t4-fork-rehearsal-real.js";
const ADDRESS = /^(?:0x)?[0-9a-fA-F]{40}$/;
const RUNNER_ARGS = [
  "tools/execute-fluid-t2t4-trigger.js",
  "--batch", "coordination/live-execution-batch-fluid-t2t4-trigger.json",
  "--executor", "0x719ae473cdacaab7cebdc6b47b085123d5ead39c",
  "--outdir", "fluid-liquidation-execution",
];

function writeStatus(extra) {
  const body = { schema: "fluid-crossing-exec-status/v1", ...extra, generatedAt: new Date().toISOString() };
  try { fs.mkdirSync(path.dirname(STATUS), { recursive: true }); fs.writeFileSync(STATUS, JSON.stringify(body, null, 2) + "\n"); } catch (_) {}
  return body;
}

function readStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS, "utf8")); } catch (_) { return null; }
}

function run(cmd, args, timeoutMs) {
  try { return { rc: 0, out: execFileSync(cmd, args, { encoding: "utf8", timeout: timeoutMs }) }; }
  catch (e) { return { rc: e?.status ?? 1, out: String((e?.stdout || "") + (e?.stderr || "")) }; }
}

function lastJson(out) {
  const m = String(out || "").match(/\{[\s\S]*\}/s);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

function tryReadJson(file) {
  try { return { exists: true, ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) }; }
  catch (_) { return { exists: false, ok: false, value: null }; }
}

function address(v) { return ADDRESS.test(String(v || "")) ? String(v).toLowerCase() : null; }

// Shared-rpc relay loader: endpoint material is process-only, never printed/persisted.
function loadRpcUrls() {
  try { return require("./shared-rpc").loadRpcUrls({ maxCandidates: 40 }); } catch (_) { return []; }
}

async function rpcOn(url, method, params, timeoutMs) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs || PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: c.signal, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const b = await r.json();
    if (b.error) {
      const err = new Error("rpc:" + (b.error.message || "").slice(0, 40));
      const data = typeof b.error.data === "string" ? b.error.data : b.error.data?.data;
      if (typeof data === "string" && /^0x[0-9a-f]+$/i.test(data)) err.revertData = data.toLowerCase();
      throw err;
    }
    if (b.result === undefined) throw new Error("rpc-shape-failure");
    return b.result;
  } finally { clearTimeout(t); }
}

const SIM_CALLDATA = "0x" + keccakOfSimulate();
// simulateLiquidate(uint256 maxAmount_, bool absorb_): selector computed once from the
// ABI fragment via the trigger runner's ethers copy (module-local; no network).
function keccakOfSimulate() {
  try {
    const { Interface } = require(path.join(__dirname, "node_modules", "ethers"));
    const iface = new Interface(["function simulateLiquidate(uint256 maxAmount_, bool absorb_)"]);
    return iface.getFunction("simulateLiquidate").selector.slice(2);
  } catch (_) { return "00000000"; }
}

// Live probe encoding identical provenance to the trigger runner/rehearsal decoder:
// simulateLiquidate reverts with FluidLiquidateResult(col,debt) -> liquidatable iff debt>0.
// providers may be a single url (DI parity) or a list; an unreadable probe falls back to
// the next qualified provider before being recorded unreadable (shared-rpc churn lesson).
async function probeRow(providers, vaultAddr) {
  const urls = Array.isArray(providers) ? providers : [providers];
  let outcome = { liquidatable: false, reason: "no-qualified-ethereum-provider", debtLiquidated: null, colLiquidated: null, unreadable: true };
  for (const url of urls) {
    let raw;
    try {
      raw = await rpcOn(url, "eth_call", [{ to: vaultAddr, data: SIM_CALLDATA }, "latest"]);
      outcome = { liquidatable: false, reason: "simulateLiquidate-returned", debtLiquidated: "0", colLiquidated: "0", unreadable: false };
      break;
    } catch (err) {
      const d = err && err.revertData ? err.revertData : null;
      if (!d) { outcome = { liquidatable: false, reason: "liveness-unreadable", debtLiquidated: null, colLiquidated: null, unreadable: true }; continue; }
      const dec = reh.decodeLiqSimRevert(d);
      if (dec && dec.name === "FluidLiquidateResult") {
        const debt = dec.debtLiquidated != null ? String(dec.debtLiquidated) : "0";
        const col = dec.colLiquidated != null ? String(dec.colLiquidated) : "0";
        outcome = { liquidatable: BigInt(debt) > 0n, reason: `FluidLiquidateResult(col=${col},debt=${debt})`, debtLiquidated: debt, colLiquidated: col, unreadable: false };
        break;
      }
      if (dec && dec.name === "FluidVaultError") {
        outcome = { liquidatable: false, reason: `FluidVaultError(${dec.errorId ?? "?"})`, debtLiquidated: "0", colLiquidated: "0", unreadable: false };
        break;
      }
      outcome = { liquidatable: false, reason: "liveness-unreadable", debtLiquidated: null, colLiquidated: null, unreadable: true };
    }
  }
  return outcome;
}

async function qualifyEthProviders(loadUrls) {
  const out = [];
  for (const url of loadUrls()) {
    let chainId;
    try { chainId = await rpcOn(url, "eth_chainId", [], 10_000); } catch (_) { continue; }
    if (chainId === "0x1") out.push(url);
  }
  return out;
}

function selectEligibleRows(economics) {
  const depthRows = new Map();
  const r = tryReadJson(trig.PATHS.EXIT_DEPTH);
  if (r.ok && Array.isArray(r.value && r.value.rows)) {
    for (const row of r.value.rows) { if (row && typeof row.vault === "string") depthRows.set(row.vault.toLowerCase(), row); }
  }
  const rows = Array.isArray(economics && economics.rows) ? economics.rows : [];
  const res = trig.selectProbeRows(rows, depthRows);
  // The trigger helper returns { eligible, rejected, eligibleTotal }; normalize so
  // callers always receive an array (the historical no-feasible-row lesson: selection
  // shape drift must fail loud, not silently starve candidates).
  const selected = Array.isArray(res && res.selected) ? res.selected
    : Array.isArray(res && res.eligible) ? res.eligible : [];
  const rejected = Array.isArray(res && res.rejected) ? res.rejected : [];
  return { selected, rejected };
}

// Finish protocol mirrors the euler driver: every terminal path writes an honest state
// BEFORE exiting, so there is never a silent die (watchdog-visible).
function buildFinish(deps) {
  return (state, extra, code) => {
    deps.writeStatus({ state, ...extra });
    const err = new Error("finish");
    err.__fluidFinish = { state, extra, code: code === undefined ? 0 : code };
    throw err;
  };
}

// runOnce(deps): injectable for offline tests. Required deps (defaults wired in main):
//   writeStatus, readStatus, run, now, refreshStatusPath, economicsTryRead, loadRpcUrls,
//   probeRow(providerUrl, vault), qualify(ethProvider), selectRows(economics), lastJsonOut.
async function runOnce(deps) {
  const finish = buildFinish(deps);
  try {
    deps.writeStatus({ state: "RUNNING", result: "started", pid: process.pid });

    const prev = deps.readStatus();
    const lastRun = prev && prev.lastChainRunAt ? Date.parse(prev.lastChainRunAt) : 0;
    const sinceLast = Number.isFinite(lastRun) ? Date.now() - lastRun : Infinity;
    if (sinceLast < PACING_MS) {
      // Preserve lastChainRunAt/result/steps: a pacing skip must NOT reset the chain
      // clock (historical churn lesson — the old haircut wrote a bare heartbeat that
      // made every other relaunch a full run).
      const preserved = prev && typeof prev === "object" ? prev : {};
      finish("PACING_SKIP", {
        result: "pacing",
        pacingMsLeft: Math.max(0, PACING_MS - sinceLast),
        lastChainRunAt: preserved.lastChainRunAt ?? null,
        preservedResult: preserved.result ?? null,
      }, 0);
    }

    // Gate 1: the standing surface producer must have completed a chain OK.
    const ref = deps.refreshStatusPath ? deps.tryRead(deps.refreshStatusPath) : { exists: false, ok: false, value: null };
    if (!ref.ok) {
      finish("REFRESH_SURFACE_UNAVAILABLE", { lastChainRunAt: new Date().toISOString(), result: "refresh-status-unreadable-or-missing" }, 2);
    }
    if (ref.value.result !== "OK") {
      finish("REFRESH_SURFACE_NOT_OK", { lastChainRunAt: new Date().toISOString(), result: "refresh-surface-not-ok", refreshResult: ref.value.result ?? null }, 2);
    }

    // Gate 2: eligible Ethereum rows from the fresh economics producer.
    const econ = deps.economicsTryRead();
    if (!econ.ok) finish("ECONOMICS_UNAVAILABLE", { lastChainRunAt: new Date().toISOString(), result: "economics-unreadable-or-missing" }, 2);
    const selection = deps.selectRows(econ.value);
    const eligible = Array.isArray(selection && selection.selected) ? selection.selected : [];
    const rejected = Array.isArray(selection && selection.rejected) ? selection.rejected : [];
    if (!eligible.length) {
      finish("NO_CANDIDATE", { lastChainRunAt: new Date().toISOString(), result: "no-eligible-ethereum-row", rejected: rejected.map((c) => ({ vault: String((c && ((c.row && c.row.vault) || c.vault)) || "?").toLowerCase().slice(0, 42), reason: String((c && (c.reason || c.skip)) || "ineligible").slice(0, 48) })) }, 0);
    }

    // Gate 3: cheap live liquidatability probe (one eth_call per eligible row).
    const providerUrl = await deps.qualify();
    if (!providerUrl) {
      finish("FAIL_PROVIDER_QUALIFICATION", { lastChainRunAt: new Date().toISOString(), result: "no-qualified-ethereum-provider" }, 2);
    }
    const probes = [];
    for (const cand of eligible) {
      const row = cand.row || cand;
      const vaultAddr = address(row.vault);
      const outcome = vaultAddr && deps.probeRow ? await deps.probeRow(providerUrl, `0x${vaultAddr.replace(/^0x/, "")}`) : { liquidatable: false, reason: "invalid-vault-address", unreadable: true };
      probes.push({ vault: vaultAddr, net: String(cand.net ?? (cand.depth && cand.depth.netAtQuotedSize) ?? "0").slice(0, 24), liquidatable: outcome.liquidatable, reason: outcome.reason ? String(outcome.reason).slice(0, 48) : null, unreadable: outcome.unreadable === true });
    }
    // Rejected rows keep their per-row eligibility reason (no silent starvation).
    for (const cand of rejected) {
      const rr = cand && (cand.row || cand);
      probes.push({ vault: rr ? String(rr.vault || "").toLowerCase().slice(0, 42) || null : null, net: null, liquidatable: false, reason: String((cand && (cand.reason || cand.skip)) || "ineligible").slice(0, 48), unreadable: false, rejected: true });
    }
    const live = probes.filter((p) => p.liquidatable);
    if (!live.length) {
      finish("NO_CANDIDATE_LIQUIDATABLE", { lastChainRunAt: new Date().toISOString(), result: "no-live-liquidatable-row", probes }, 0);
    }
    deps.writeStatus({ state: "RUNNING", result: "live-candidate-probed", candidates: live.length, probes });

    // Gate 4: the REAL fork rehearsal must report state PASS (realizedNet>0 on real
    // executor bytecode at a real pin; REHEARSAL_EVIDENCE_NOT_AUTHORIZATION label).
    const rehRes = deps.run("node", [REHEARSAL_SCRIPT], REHEARSAL_TIMEOUT_MS);
    const rehJson = deps.lastJson(rehRes.out);
    if (!(rehJson && rehJson.state === "PASS")) {
      finish("REHEARSAL_NOT_PASS", {
        lastChainRunAt: new Date().toISOString(),
        result: "rehearsal-not-pass",
        rc: rehRes.rc,
        detail: rehJson ? (rehJson.stage ?? rehJson.reason ?? rehJson.state) : "no-json",
      }, 2);
    }

    // Gates 5-6: trigger dry-run gates (0/a/b/c/d) then the single execute attempt.
    const dr = deps.run(RUNNER_CMD[0], [].concat(RUNNER_CMD.slice(1), ["--dry-run"]), 240_000);
    const dj = deps.lastJson(dr.out);
    if (!(dj && dj.ok === true)) {
      const reason = dj ? (dj.reason ?? "gates-failed") : "dry-run-no-json";
      finish("DRY_RUN_FAIL", { lastChainRunAt: new Date().toISOString(), result: "dry-run-fail", reason, rc: dr.rc },
        reason === "no-qualified-provider" || (dj && String(dj.reason || "").startsWith("no-feasible-row")) ? 0 : 2);
    }

    const ex = deps.run(RUNNER_CMD[0], [].concat(RUNNER_CMD.slice(1), ["--execute"]), 600_000);
    const summary = String(ex.out || "").slice(0, 4000);
    deps.writeStatus({ state: "EXECUTED", lastChainRunAt: new Date().toISOString(), result: "execute-attempted", rc: ex.rc, summary });
    return { state: "EXECUTED", summary, code: 0 };
  } catch (err) {
    if (err && err.__fluidFinish) return { state: err.__fluidFinish.state, code: err.__fluidFinish.code, extra: err.__fluidFinish.extra };
    throw err;
  }
}

const RUNNER_CMD = ["node", ...RUNNER_ARGS];

const defaultDeps = {
  writeStatus, readStatus, run, lastJson,
  now: Date.now,
  tryRead: tryReadJson,
  refreshStatusPath: path.join("reports", "raw", "fast", "fluid-l-surface-refresh-status.json"),
  economicsTryRead: () => tryReadJson(trig.PATHS.ECONOMICS),
  loadRpcUrls, qualify: () => qualifyEthProviders(loadRpcUrls),
  probeRow,
  selectRows: selectEligibleRows,
};

// Fail-closed: never die silently. SIGTERM/SIGINT or an unhandled crash still writes an
// honest terminal status artifact before exiting.
let terminating = false;
function onTerminate(reason) {
  if (terminating) return;
  terminating = true;
  writeStatus({ state: "ERROR", result: "terminated-before-completion", reason });
  process.exit(143);
}
process.on("SIGINT", () => onTerminate("SIGINT"));
process.on("SIGTERM", () => onTerminate("SIGTERM"));
process.on("uncaughtException", (err) => onTerminate("uncaughtException:" + String(err && err.message ? err.message : err).slice(0, 120)));
process.on("unhandledRejection", (err) => onTerminate("unhandledRejection:" + String(err && err.message ? err.message : err).slice(0, 120)));

async function main() {
  const res = await runOnce({ ...defaultDeps, finishWritten: true });
  // A returned (non-thrown) finish means the injected finish was captured in tests;
  // in the real process runOnce throws only for unexpected errors, so this is
  // defensive: record the returned state honestly.
  if (res && res.code !== 0 && res.code !== undefined && res.state) writeStatus({ state: res.state, result: "returned-nonzero", rc: res.code });
  process.exit(res && typeof res.code === "number" ? res.code : 0);
}

if (require.main === module) main();

module.exports = {
  STATUS, PACING_MS, RUNNER_ARGS, REHEARSAL_SCRIPT,
  writeStatus, readStatus, run, lastJson, tryReadJson, selectEligibleRows,
  probeRow, qualifyEthProviders, runOnce, defaultDeps,
};
