#!/usr/bin/env node
"use strict";
// crossing-euler-evk-exec2.js — standing one-shot crossing driver for executor #2 lane
// (0x22760de82a1ebf0c9467e8e15684a03b2fa8dd58, batch euler-trigger-liquidation-20261013-02).
// Relaunch policy: the watchdog supervisor relaunches this process after each exit;
// this driver paces itself to AT MOST ONE full chain attempt per ~55 min (reads its own
// status artifact's lastChainRunAt; heartbeat written on every exit so the supervisor's
// staleSeconds stays satisfied). One signed execute per live candidate event, fail-closed
// everywhere; endpoints/key material never printed or persisted. See
// coordination/euler-liquidation-offensive-plan.md §6 for the full evolution record.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { spawn } = require("node:child_process");
const process = require("node:process");

const STATUS = path.join("reports", "raw", "fast", "euler-crossing-exec2-status.json");
const PACING_MS = 55 * 60 * 1000;
const WAIT_WATCH_MIN = 5;
const RUNNER_ARGS = [
  "tools/execute-euler-evk-trigger.js",
  "--batch", "coordination/live-execution-batch-euler-trigger-2.json",
  "--executor", "0x22760de82a1ebf0c9467e8e15684a03b2fa8dd58",
  "--deploy-block", "26173338",
  "--outdir", "euler-liquidation-execution-2",
];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function writeStatus(extra) {
  const body = { schema: "euler-crossing-exec2-status/v1", backlog: RUNNER_ARGS.slice(1), ...extra, generatedAt: new Date().toISOString() };
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
  const m = out.match(/\{[\s\S]*\}/s);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

function readWatchStatus() {
  try {
    const j = JSON.parse(fs.readFileSync("./reports/raw/fast/euler-l-watch-status.json", "utf8"));
    return { ageMs: Date.now() - new Date(j.generatedAt).getTime(), ok: j.ok === true, trigger: j.totals && j.totals.liquidatableVaults > 0, block: j.blockNumber, reason: j.reason ?? null };
  } catch (_) { return null; }
}

// Every terminal path routes through this: an honest state + reason is written
// BEFORE the process exits, so there is never a silent die (watchdog-visible).
function finish(state, extra, code) {
  writeStatus({ state, ...extra });
  process.exit(code);
}

async function main() {
  // Heartbeat FIRST: the status artifact must exist before any wait or network
  // step, so a supervisor SIGTERM mid-run still leaves a freshest-timestamp file.
  writeStatus({ state: "RUNNING", result: "started", pid: process.pid });

  const prev = readStatus();
  const lastRun = prev && prev.lastChainRunAt ? Date.parse(prev.lastChainRunAt) : 0;
  const sinceLast = Number.isFinite(lastRun) ? Date.now() - lastRun : Infinity;
  if (sinceLast < PACING_MS) {
    finish("PACING_SKIP", { result: "pacing", pacingMsLeft: Math.max(0, PACING_MS - sinceLast) }, 0);
  }

  let status = readWatchStatus(), waited = 0;
  while ((!status || !status.ok || !status.trigger || status.ageMs > 4.5 * 60000) && waited++ < 12) {
    // Refresh the heartbeat while genuinely alive so the supervisor's
    // (fresh && alive) invariant holds instead of a stale-heartbeat relaunch churn.
    writeStatus({ state: "RUNNING", result: "waiting-for-watch-trigger", waited });
    await delay(30000);
    status = readWatchStatus();
  }
  if (!status || !status.ok || !status.trigger || status.ageMs > 5 * 60000) {
    const reason = !status ? "watch-status-unreadable" : (!status.ok ? "watch-not-ok" : "no-trigger-or-stale-watch");
    finish("FAIL_PROVIDER_QUALIFICATION", {
      lastChainRunAt: new Date().toISOString(),
      result: "watch-status-wait-timeout",
      reason,
      watchReason: status ? status.reason : null,
    }, 2);
  }

  const val = run("node", ["tools/calc-euler-l-valuation.js", "--once"], 240000);
  const vj = lastJson(val.out);
  if (!vj || !(vj.routePositive > 0)) {
    finish("VALUATION_NO_ROUTE", { lastChainRunAt: new Date().toISOString(), result: "valuation-no-route-positive", reason: "valuation-no-route-positive", rc: val.rc }, 2);
  }

  const reh = run("node", ["tools/euler-evk-flash-liquidator-rehearsal.js"], 480000);
  const rj = lastJson(reh.out);
  if (!rj || rj.state !== "PASS") {
    finish("REHEARSAL_NOT_PASS", { lastChainRunAt: new Date().toISOString(), result: "rehearsal-not-pass", reason: "rehearsal-not-pass", rc: reh.rc, detail: rj ? rj.state : "no-json" }, 2);
  }

  const dr = run("node", [...RUNNER_ARGS, "--dry-run"], 240000);
  const dj = lastJson(dr.out);
  if (!(dj && dj.ok === true)) {
    const reason = dj ? (dj.reason ?? "gates-failed") : "dry-run-no-json";
    finish("DRY_RUN_FAIL", { lastChainRunAt: new Date().toISOString(), result: "dry-run-fail", reason, rc: dr.rc },
      reason === "no-qualified-provider" || (dj && String(dj.reason || "").startsWith("no-feasible-row")) ? 0 : 2);
  }

  const ex = run("node", [...RUNNER_ARGS, "--execute"], 600000);
  const summary = ex.out.slice(0, 4000);
  writeStatus({ state: "EXECUTED", lastChainRunAt: new Date().toISOString(), result: "execute-attempted", rc: ex.rc, summary });
  console.log(summary);
  process.exit(0); // firing happened this event; non-zero rc is recorded in the status
}

// Fail-closed: never die silently. A supervisor SIGTERM/SIGINT or an unhandled
// crash still writes an honest terminal status artifact before exiting.
let terminating = false;
function onTerminate(reason) {
  if (terminating) return;
  terminating = true;
  writeStatus({ state: "ERROR", result: "terminated-before-completion", reason });
  process.exit(143);
}
process.on("SIGTERM", () => onTerminate("SIGTERM"));
process.on("SIGINT", () => onTerminate("SIGINT"));
process.on("uncaughtException", (e) => onTerminate(`uncaught-exception:${String((e && e.message) || e).slice(0, 120)}`));
process.on("unhandledRejection", (e) => onTerminate(`unhandled-rejection:${String((e && e.message) || e).slice(0, 120)}`));

main().catch((e) => onTerminate(`main-rejected:${String((e && e.message) || e).slice(0, 120)}`));
