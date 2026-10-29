#!/usr/bin/env node
"use strict";

// These producers share a directory-wide writer lock. Run one-shot observations
// sequentially; Task Scheduler owns cadence, never three competing --loop jobs.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { acquireCanaryOutputOwner, LOCK_NAME } = require("./lib/canary-output-owner");
const { batchBlock, historicalMonitoringWindowState } = require("./monitor-rearm-canary-multichain");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIR = "reports/raw/fast/exploit-rearm-canary";
const STATUS_FILE = "reports/monitor/canary-feeds/status.json";
const CHILD_TIMEOUT_MS = 5 * 60_000;
const FEEDS = Object.freeze([
  { id: "dedicated", script: "monitor-exploit-rearm-canary.js", file: "status.json", schema: "exploit-rearm-canary/v1" },
  { id: "multichain", script: "monitor-rearm-canary-multichain.js", file: "status-multichain.json", schema: "exploit-rearm-canary-multichain/v1" },
  { id: "divergence", script: "monitor-oracle-divergence.js", file: "status-divergence.json", schema: "oracle-divergence-monitor/v1" },
]);
const VERDICTS = Object.freeze({ 0: "DORMANT", 1: "INCOMPLETE", 3: "FIRED" });

function runChild(script, root, timeoutMs = CHILD_TIMEOUT_MS, args = ["--once"], spawnChild = spawn) {
  return new Promise((resolve) => {
    // Producer output can be large; only fixed fields from its artifact are used.
    const child = spawnChild(process.execPath, [path.join(root, "tools", script), ...args], {
      cwd: root, stdio: "ignore", windowsHide: true, shell: false,
    });
    let timedOut = false;
    let startFailed = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once("error", () => { startFailed = true; });
    // Await actual exit, including timeout, before attempting the next writer.
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, timedOut, startFailed });
    });
  });
}

function observation(root, feed, result, startedMs, nowMs) {
  const row = { id: feed.id, exitCode: result.exitCode, updated: false,
    generatedAt: null, verdict: null, incompleteCount: null, reason: null,
    observationMode: "READ_ONLY_ONCE",
    historicalMonitoringWindowState: feed.id === "multichain" ? historicalMonitoringWindowState(batchBlock(), nowMs) : null };
  if (result.timedOut || result.startFailed) {
    row.reason = result.timedOut ? "CHILD_TIMEOUT" : "CHILD_START_FAILED";
    return row;
  }
  try {
    const file = path.join(root, SOURCE_DIR, feed.file);
    if (fs.statSync(file).size > 5 * 1024 * 1024) throw new Error("oversized");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    const stamp = Date.parse(value.generatedAt);
    if (value.schema !== feed.schema || value.noSigning !== true || value.noBroadcast !== true ||
        !Array.isArray(value.sentinels) || !Object.hasOwn(VERDICTS, result.exitCode) ||
        value.verdict !== VERDICTS[result.exitCode] || !Number.isFinite(stamp) ||
        stamp < startedMs || stamp > nowMs) throw new Error("invalid-or-old");
    if (feed.id === "multichain" && (value.observationMode !== "READ_ONLY_ONCE" ||
        value.batch?.startedAt !== batchBlock().startedAt || value.batch?.expiresAt !== batchBlock().expiresAt ||
        value.historicalMonitoringWindowState !== historicalMonitoringWindowState(value.batch, stamp))) {
      throw new Error("invalid-historical-window");
    }
    row.updated = true;
    row.generatedAt = new Date(stamp).toISOString();
    row.verdict = value.verdict;
    row.incompleteCount = value.sentinels.filter((entry) => entry?.ok !== true).length;
  } catch (_) { row.reason = "OBSERVATION_NOT_UPDATED_OR_INVALID"; }
  return row;
}

function writeStatus(file, status, owner) {
  owner.check();
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`);
    owner.check();
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

async function runOnce({ root = ROOT, now = Date.now, launch = runChild } = {}) {
  const statusFile = path.join(root, STATUS_FILE);
  const owner = acquireCanaryOutputOwner(statusFile);
  const window = batchBlock(); // Observation window metadata, not execution authority.
  const status = { schema: "canary-feeds-refresh/v1", startedAt: new Date(now()).toISOString(),
    generatedAt: null, status: "RUNNING", reason: null, updatedCount: 0,
    // Historical multichain metadata only, never a gate on the other producers.
    monitoringEndsAt: window.expiresAt, observationMode: "READ_ONLY_ONCE",
    historicalMonitoringWindowState: historicalMonitoringWindowState(window, now()),
    noSigning: true, noBroadcast: true, feeds: [] };
  try {
    writeStatus(statusFile, status, owner);
    for (const feed of FEEDS) {
      owner.check();
      const startedMs = now();
      if (fs.existsSync(path.join(root, SOURCE_DIR, LOCK_NAME))) {
        status.reason = "PRODUCER_OWNER_PRESENT";
        break;
      }
      let result;
      try { result = await launch(feed.script, root, CHILD_TIMEOUT_MS,
        feed.id === "multichain" ? ["--once", "--observation-only"] : ["--once"]); }
      catch (_) { result = { exitCode: null, startFailed: true }; }
      status.feeds.push(observation(root, feed, result, startedMs, now()));
      status.updatedCount = status.feeds.filter((row) => row.updated).length;
      writeStatus(statusFile, status, owner);
      if (fs.existsSync(path.join(root, SOURCE_DIR, LOCK_NAME))) {
        status.reason = "PRODUCER_OWNER_REMAINS_ATTENDED_RECOVERY_REQUIRED";
        break;
      }
    }
    status.generatedAt = new Date(now()).toISOString();
    status.historicalMonitoringWindowState = historicalMonitoringWindowState(window, Date.parse(status.generatedAt));
    status.status = status.reason ? "BLOCKED" : status.updatedCount !== FEEDS.length ? "FAILED" :
      status.feeds.some((row) => row.verdict === "INCOMPLETE" || row.incompleteCount > 0) ? "DEGRADED" : "UPDATED";
    writeStatus(statusFile, status, owner);
    return status;
  } finally {
    if (!owner.release()) throw new Error("REFRESH_OWNER_RELEASE_FAILED");
  }
}

async function main(args = process.argv.slice(2)) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--once")) throw new Error("USAGE");
  const status = await runOnce();
  process.stdout.write(`${JSON.stringify(status)}\n`);
  if (status.status !== "UPDATED") process.exitCode = 1;
}

if (require.main === module) main().catch(() => {
  process.stderr.write("canary-feeds refresh failed; inspect status and writer ownership\n");
  process.exitCode = 1;
});

module.exports = { FEEDS, SOURCE_DIR, STATUS_FILE, CHILD_TIMEOUT_MS, runChild, runOnce, main };
