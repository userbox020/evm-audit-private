#!/usr/bin/env node
"use strict";
// standing-relaunch-euler-exec3.js — EXTERNAL standing cadence owner for the executor-#3
// one-shot crossing driver tools/crossing-euler-evk-exec3.js
// (executor 0xd2e340b1ce33453509d34e8a8eee63e67b442c29, batch euler-trigger-liquidation-20261013-03).
//
// Why this exists: the exec2 lane gets relaunch-after-exit from the watchdog manifest
// (tools/watchdog-live.js, id "euler-crossing-exec2"). The exec3 lane intentionally has NO
// watchdog entry. The driver's own internal ~55-min pacing gate is INERT — its startup
// heartbeat writeStatus() clobbers lastChainRunAt before the pacing read, so the driver always
// runs a full fail-closed pass when launched. This wrapper is therefore the cadence owner: it
// launches the driver at most once per --interval-minutes (default 55), exactly one child at a
// time, and never touches the watchdog or the exec2 lane.
//
// Relaunch semantics:
//   * first-ever start (no persisted cadence state) runs immediately, UNLESS a driver run
//     happened < RACE_GRACE_MS (5 min) ago — the micro-race guard against a launcher that just
//     finished. This is the "run once immediately at start" cycle.
//   * every later cycle (including after a wrapper restart) skips + reschedules if the driver's
//     status artifact lastChainRunAt is < interval old (anti-race with any other launcher),
//     otherwise runs.
//   * never relaunch while a driver child is alive (live-process check).
//   * never start a second wrapper (singleton pid lock).
//
// Artifacts (workspace-root relative, root resolved from this file's directory):
//   status  reports/raw/fast/euler-crossing-exec3-status.json         (owned by the driver)
//   lock    reports/raw/fast/euler-crossing-exec3-relaunch.lock       (wrapper singleton)
//   state   reports/raw/fast/euler-crossing-exec3-relaunch-state.json (wrapper cadence memory)
//   log     reports/logs/standing-relaunch-exec3.log                  (2 lines per cycle)
//   child   reports/logs/euler-crossing-exec3.log / .err.log          (driver stdout/stderr)
//
// Endpoints/key material are never read, printed, or persisted here; the driver owns all RPC
// handling. This wrapper never signs, submits, or moves funds.

const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const process = require("node:process");

const ROOT = path.resolve(__dirname, "..");
const DRIVER = path.join("tools", "crossing-euler-evk-exec3.js");
const STATUS = path.join(ROOT, "reports", "raw", "fast", "euler-crossing-exec3-status.json");
const LOCK = path.join(ROOT, "reports", "raw", "fast", "euler-crossing-exec3-relaunch.lock");
const STATE = path.join(ROOT, "reports", "raw", "fast", "euler-crossing-exec3-relaunch-state.json");
const LOG = path.join(ROOT, "reports", "logs", "standing-relaunch-exec3.log");
const DRIVER_LOG = path.join(ROOT, "reports", "logs", "euler-crossing-exec3.log");
const DRIVER_ERR = path.join(ROOT, "reports", "logs", "euler-crossing-exec3.err.log");

const DEFAULT_INTERVAL_MINUTES = 55;
const RACE_GRACE_MS = 5 * 60 * 1000;
const SLEEP_CHUNK_MS = 15 * 1000;
const DRIVER_MATCH = "crossing-euler-evk-exec3.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const value = (name) => {
    const inline = argv.find((a) => a.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const raw = Number(value("--interval-minutes"));
  const intervalMinutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MINUTES;
  return { intervalMinutes, quiet: argv.includes("--quiet") };
}

function appendLine(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line + "\n");
  } catch (_) {}
  if (!QUIET) {
    try { process.stdout.write(line + "\n"); } catch (_) {}
  }
}

function log(...parts) {
  appendLine(`[${new Date().toISOString()}] [pid ${process.pid}] ${parts.join(" ")}`);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
}

function writeJsonAtomic(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    fs.renameSync(tmp, file);
    return true;
  } catch (_) { return false; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === "EPERM"; }
}

// Singleton wrapper lock: exclusive create; reclaim only if the recorded pid is provably dead.
function acquireSingletonLock() {
  const value = { pid: process.pid, startedAt: new Date().toISOString(), script: path.basename(__filename) };
  try {
    fs.mkdirSync(path.dirname(LOCK), { recursive: true });
    const fd = fs.openSync(LOCK, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value) + "\n"); } finally { fs.closeSync(fd); }
    return value;
  } catch (e) {
    if (!e || e.code !== "EEXIST") throw e;
  }
  const existing = readJson(LOCK);
  if (existing && pidAlive(existing.pid)) return null; // another relauncher is alive
  try { fs.unlinkSync(LOCK); } catch (_) {}
  const fd = fs.openSync(LOCK, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + "\n"); } finally { fs.closeSync(fd); }
  return value;
}

function releaseSingletonLock(lockValue) {
  try {
    const current = readJson(LOCK);
    if (current && current.pid === lockValue.pid && current.startedAt === lockValue.startedAt) fs.unlinkSync(LOCK);
  } catch (_) {}
}

// Liveness probe for ANY node process running the exec3 driver (this wrapper's child or a
// foreign launcher's). Matches by script name only; excludes powershell and this wrapper.
function driverProcessAlive() {
  const query =
    "$ErrorActionPreference='SilentlyContinue'; " +
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    `Where-Object { $_.CommandLine -like '*${DRIVER_MATCH}*' -and $_.ProcessId -ne ${process.pid} } | ` +
    "Select-Object -First 1 -ExpandProperty ProcessId";
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query], {
      encoding: "utf8", timeout: 20000, windowsHide: true,
    });
    const pid = parseInt(String(out).trim(), 10);
    return Number.isInteger(pid) && pid > 0 && pid !== process.pid;
  } catch (_) { return false; }
}

function readStatus() { return readJson(STATUS); }

let QUIET = false;
let shuttingDown = false;
let currentChild = null;

async function sleepInterruptible(ms) {
  const end = Date.now() + ms;
  while (!shuttingDown && Date.now() < end) {
    await delay(Math.min(SLEEP_CHUNK_MS, Math.max(0, end - Date.now())));
  }
}

function runDriver() {
  return new Promise((resolve) => {
    let outFd;
    let errFd;
    try {
      fs.mkdirSync(path.dirname(DRIVER_LOG), { recursive: true });
      outFd = fs.openSync(DRIVER_LOG, "a");
      errFd = fs.openSync(DRIVER_ERR, "a");
    } catch (_) { outFd = "ignore"; errFd = "ignore"; }
    const child = spawn(process.execPath, [DRIVER], {
      cwd: ROOT, stdio: ["ignore", outFd, errFd], windowsHide: true,
    });
    currentChild = child;
    const finish = (code, signal) => {
      if (currentChild === child) currentChild = null;
      try { if (typeof outFd === "number") fs.closeSync(outFd); } catch (_) {}
      try { if (typeof errFd === "number") fs.closeSync(errFd); } catch (_) {}
      resolve({ code: code == null ? (signal ? 143 : 1) : code, signal: signal || null });
    };
    child.on("exit", (code, signal) => finish(code, signal));
    child.on("error", () => finish(1, null));
  });
}

function killCurrentChild() {
  const child = currentChild;
  if (!child || child.exitCode !== null) return;
  try { child.kill(); } catch (_) {}
  try { execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }); } catch (_) {}
}

function shutdown(reason, code) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutdown: ${reason}; stopping (child ${currentChild ? "killed" : "none"})`);
  killCurrentChild();
  if (LOCK_VALUE) releaseSingletonLock(LOCK_VALUE);
  try { process.exit(code == null ? 0 : code); } catch (_) {}
}

function recordCycle(intervalMs, cycleNumber, nextAt, overrides) {
  const prev = readJson(STATE) || {};
  writeJsonAtomic(STATE, {
    schema: "euler-crossing-exec3-relaunch-state/v1",
    wrapperPid: process.pid,
    driver: DRIVER.replace(/\\/g, "/"),
    intervalMinutes: Math.round(intervalMs / 60000),
    cycles: cycleNumber,
    lastCycleAt: new Date().toISOString(),
    lastDriverRc: overrides.rc !== undefined ? overrides.rc : (prev.lastDriverRc ?? null),
    lastDriverState: overrides.state !== undefined ? overrides.state : (prev.lastDriverState ?? null),
    lastDriverRunAt: overrides.runAt !== undefined ? overrides.runAt : (prev.lastDriverRunAt ?? null),
    lastCycleOutcome: overrides.outcome,
    nextCycleAt: new Date(nextAt).toISOString(),
    statusArtifact: path.relative(ROOT, STATUS).replace(/\\/g, "/"),
    note: "external cadence owner for exec3; internal driver pacing is inert",
  });
}

async function cycle(intervalMs, firstEver, cycleNumber) {
  const startedAtIso = new Date().toISOString();
  log(`cycle ${cycleNumber} start @ ${startedAtIso}`);

  // (a) Never relaunch while a driver child (ours or foreign) is alive.
  if (driverProcessAlive()) {
    const nextAt = Date.now() + intervalMs;
    log(`cycle ${cycleNumber} skip: driver already alive (no relaunch); next in ${Math.round(intervalMs / 60000)}min`);
    recordCycle(intervalMs, cycleNumber, nextAt, { outcome: "skip:driver-alive" });
    return { nextDelayMs: Math.max(1000, nextAt - Date.now()), ran: false, reason: "driver-alive" };
  }

  // (b) Cadence guard on the driver's own status artifact.
  const status = readStatus();
  const lastRunMs = status && status.lastChainRunAt ? Date.parse(status.lastChainRunAt) : NaN;
  const ageMs = Number.isFinite(lastRunMs) ? Date.now() - lastRunMs : Infinity;
  const graceMs = firstEver ? RACE_GRACE_MS : intervalMs;
  if (Number.isFinite(ageMs) && ageMs < graceMs) {
    const nextAt = (Number.isFinite(lastRunMs) ? lastRunMs : Date.now()) + intervalMs;
    const nextDelay = Math.max(1000, nextAt - Date.now());
    log(
      `cycle ${cycleNumber} skip: lastChainRunAt ${status.lastChainRunAt} is ${Math.round(ageMs / 1000)}s old ` +
      `(< ${Math.round(graceMs / 60000)}min); next in ${Math.round(nextDelay / 60000)}min`,
    );
    recordCycle(intervalMs, cycleNumber, nextAt, { outcome: "skip:cadence-fresh" });
    return { nextDelayMs: nextDelay, ran: false, reason: "cadence-fresh" };
  }

  // (c) Launch exactly one driver child and wait for its exit.
  const res = await runDriver();
  const after = readStatus();
  const state = after && after.state ? after.state : "unknown";
  const advanced = after && after.lastChainRunAt ? after.lastChainRunAt : null;
  const nextAt = Date.now() + intervalMs + 5000; // +5s slack so the guard clears on wake
  const nextDelay = Math.max(1000, nextAt - Date.now());
  log(`cycle ${cycleNumber} driver exit rc=${res.code}${res.signal ? ` signal=${res.signal}` : ""} state=${state} lastChainRunAt=${advanced}; next in ${Math.round(nextDelay / 60000)}min`);
  recordCycle(intervalMs, cycleNumber, nextAt, { rc: res.code, state, runAt: advanced, outcome: "ran:driver-pass" });
  return { nextDelayMs: nextDelay, ran: true, reason: "ran" };
}

let LOCK_VALUE = null;

async function main() {
  const { intervalMinutes, quiet } = parseArgs(process.argv.slice(2));
  QUIET = quiet;
  const intervalMs = Math.round(intervalMinutes * 60 * 1000);

  const stateAtStart = readJson(STATE);
  const firstEver = !stateAtStart;

  LOCK_VALUE = acquireSingletonLock();
  if (!LOCK_VALUE) {
    log(`another standing relauncher is already alive; exiting without starting a second owner`);
    process.exit(0);
  }
  log(`start: interval=${intervalMinutes}min firstEver=${firstEver} driver=${DRIVER.replace(/\\/g, "/")}`);

  let cycleNumber = 0;
  // First cycle runs (near-)immediately: no initial sleep ("run once immediately at start").
  while (!shuttingDown) {
    cycleNumber += 1;
    let result;
    try {
      result = await cycle(intervalMs, firstEver && cycleNumber === 1, cycleNumber);
    } catch (e) {
      log(`cycle ${cycleNumber} error: ${String((e && e.message) || e).slice(0, 200)} -> reschedule`);
      result = { nextDelayMs: intervalMs };
    }
    if (shuttingDown) break;
    await sleepInterruptible(result.nextDelayMs);
  }
  shutdown("loop-exit", 0);
}

process.on("SIGINT", () => shutdown("SIGINT", 0));
process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("uncaughtException", (e) => { log(`uncaughtException: ${String((e && e.message) || e).slice(0, 200)}`); shutdown("uncaughtException", 1); });
process.on("unhandledRejection", (e) => { log(`unhandledRejection: ${String((e && e.message) || e).slice(0, 200)}`); shutdown("unhandledRejection", 1); });
process.on("exit", () => { try { if (LOCK_VALUE) releaseSingletonLock(LOCK_VALUE); } catch (_) {} });

main().catch((e) => { log(`main-rejected: ${String((e && e.message) || e).slice(0, 200)}`); shutdown("main-rejected", 1); });
