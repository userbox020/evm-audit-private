#!/usr/bin/env node
"use strict";
// reference-euler-surface-refresh.js — standing one-shot surface producer for the
// Euler EVK watcher + crossing driver chain. The supervisor relaunches this process;
// paces itself to AT MOST one full `scan-euler-l --full` per ~15 min via its own
// status artifact's lastChainRunAt; writes a fresh heartbeat on EVERY exit so the
// supervisor's staleSeconds stays satisfied. Fail-closed; no endpoints printed or
// persisted (the scanner follows the standing process-only convention).
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const process = require("node:process");

const STATUS = path.join("reports", "raw", "fast", "euler-l-surface-refresh-status.json");
const PACING_MS = 15 * 60 * 1000;
const FULL_TIMEOUT_MS = 600 * 1000;

function writeStatus(extra) {
  const body = { schema: "euler-l-surface-refresh-status/v1", ...extra, generatedAt: new Date().toISOString() };
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

(async () => {
  const prev = readStatus();
  const lastRun = prev && prev.lastChainRunAt ? Date.parse(prev.lastChainRunAt) : 0;
  const sinceLast = Number.isFinite(lastRun) ? Date.now() - lastRun : Infinity;
  if (sinceLast < PACING_MS) {
    // Preserve lastChainRunAt/result/steps: a bare heartbeat on skip would reset the
    // chain clock and make every other relaunch a full rescan (restart-churn lesson
    // learned on the fluid refresh lane; applied here before first mount).
    const preserved = prev && typeof prev === "object" ? prev : {};
    writeStatus({
      skipped: "pacing",
      pacingMsLeft: Math.max(0, PACING_MS - sinceLast),
      lastChainRunAt: preserved.lastChainRunAt ?? null,
      preservedResult: preserved.result ?? null,
    });
    process.exit(0);
  }
  const res = run("node", ["tools/scan-euler-l.js", "--full"], FULL_TIMEOUT_MS);
  let summary = null;
  try { const m = res.out.match(/\{[\s\S]*\}/s); if (m) summary = JSON.parse(m[0]); } catch (_) { /* honest */ }
  const ok = res.rc === 0 && summary && summary.status === "OK";
  writeStatus({
    lastChainRunAt: new Date().toISOString(),
    result: ok ? "OK" : "scan-failed",
    rc: res.rc,
    scannedAt: summary && summary.scannedAt ? summary.scannedAt : null,
    pin: summary && summary.pin ? summary.pin : null,
    out: res.out.slice(0, 300),
  });
  process.exit(0);
})();
