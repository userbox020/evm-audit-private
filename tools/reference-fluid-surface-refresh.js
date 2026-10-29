#!/usr/bin/env node
"use strict";
// reference-fluid-surface-refresh.js — standing one-shot trigger-state producer for the
// Fluid T2/T4 trigger chain. The supervisor relaunches this process; paces itself to
// AT MOST one full refresh chain per ~20 min via its own status artifact's
// lastChainRunAt; writes a fresh heartbeat on EVERY exit so the supervisor's
// staleSeconds stays satisfied. Fail-closed; endpoints process-only.
// Chain (the ORIGINAL three scanner steps): scan-fluid-l(--sync) ->
//   scan-fluid-l-economics -> scan-fluid-l-economics-stage6 (fresh rows for the
//   trigger batch's gate b + gate d at the runner's freshness window).
//
// SAFETY NOTE (2026-10-13): the previous merge-exit-depth step and the auto
// rehearsal-refresh step were REMOVED. They wrote merged exit-depth estimates and
// refreshed the fork-rehearsal artifact; neither may bypass the trigger runner's
// execution block (tools/execute-fluid-t2t4-trigger.js gateRehearsal now refuses
// unconditionally). The underlying scanners/harness are untouched. Pacing now
// PRESERVES lastChainRunAt/result/steps on a skip heartbeat, so a pacing skip no
// longer resets the pacing clock and lets every other relaunch run the full chain.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const STATUS = path.join("reports", "raw", "fast", "fluid-l-surface-refresh-status.json");
const PACING_MS = 20 * 60 * 1000;
const STEP_TIMEOUT_MS = 480 * 1000;
// The original scanner chain. Do not add merge/rehearsal steps here.
const STEPS = [
  ["surface-sync", ["tools/scan-fluid-l.js", "--sync"]],
  ["economics-refresh", ["tools/scan-fluid-l-economics.js"]],
  ["stage6-exit-depth", ["tools/scan-fluid-l-economics-stage6.js"]],
];

function redact(text) {
  return String(text || "").slice(0, 200).replaceAll(/https?:\/\/[^\s"']+|[\s\']*key[^\s]*[\'\"]?/gi, "<redacted>");
}

function writeStatus(extra) {
  const body = { schema: "fluid-l-surface-refresh-status/v1", ...extra, generatedAt: new Date().toISOString() };
  try { fs.mkdirSync(path.dirname(STATUS), { recursive: true }); fs.writeFileSync(STATUS, JSON.stringify(body, null, 2) + "\n"); } catch (_) {}
  return body;
}

function readStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS, "utf8")); } catch (_) { return null; }
}

function run(cmd, args, timeoutMs) {
  try { return { rc: 0, out: execFileSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, stdio: "pipe" }) }; }
  catch (e) { return { rc: e?.status ?? 1, out: String((e?.stdout || "") + (e?.stderr || "")) }; }
}

// runOnce: one pacing-gated refresh pass. Dependencies are injectable so the offline
// test suite can drive pacing + step selection without spawning scanners or touching
// the real status file.
function runOnce(deps) {
  const d = deps || {};
  const read = d.readStatus || readStatus;
  const write = d.writeStatus || writeStatus;
  const exec = d.run || run;
  const now = d.now || (() => Date.now());
  const prev = read();
  const lastRun = prev && prev.lastChainRunAt ? Date.parse(prev.lastChainRunAt) : 0;
  const sinceLast = Number.isFinite(lastRun) ? now() - lastRun : Infinity;
  if (sinceLast < PACING_MS) {
    // Pacing heartbeat: PRESERVE lastChainRunAt/result/steps from the previous status.
    // (The old code dropped lastChainRunAt here, which reset the pacing clock and let
    // every other supervisor relaunch run the full chain.)
    const preserved = {};
    if (prev && prev.lastChainRunAt) preserved.lastChainRunAt = prev.lastChainRunAt;
    if (prev && prev.result) preserved.result = prev.result;
    if (prev && Array.isArray(prev.steps)) preserved.steps = prev.steps;
    return write({ ...preserved, skipped: "pacing", pacingMsLeft: Math.max(0, PACING_MS - sinceLast) });
  }
  const steps = [];
  for (const step of STEPS) {
    const res = exec("node", step[1], STEP_TIMEOUT_MS);
    steps.push({ step: step[0], rc: res.rc, tail: redact(res.out) });
    if (res.rc !== 0) {
      return write({ lastChainRunAt: new Date(now()).toISOString(), result: "chain-failed", failedStep: step[0], steps });
    }
  }
  return write({ lastChainRunAt: new Date(now()).toISOString(), result: "OK", steps });
}

if (require.main === module) {
  try { runOnce(); } catch (_) {}
  process.exit(0);
}

module.exports = { runOnce, readStatus, writeStatus, run, redact, STATUS, PACING_MS, STEP_TIMEOUT_MS, STEPS };
