#!/usr/bin/env node
"use strict";
// watchdog-live.js
//
// Bounded, read-only supervisor that keeps the five standing read-only node
// watchers alive across environment evictions. Three prior watch loops froze at
// the same wall-clock moment (~01:50Z) before restarts, so a single durable
// supervisor now sweeps their heartbeat artifacts and process presence and only
// restarts an entry whose heartbeat is stale or whose process is absent.
//
// Safety: NO mainnet/RPC, NO endpoints, NO keys, NO dashboard, NO python. The
// supervisor only reads heartbeat artifacts, enumerates node.exe command lines,
// and may restart a manifest entry. Every emitted field is sanitized: entry ids,
// artifact paths, counts and fixed reason codes only. Command lines, PIDs and
// any endpoint material are never written or logged.
//
// Fail-closed invariants:
//   * Only the five embedded manifest entries are ever touched.
//   * Relaunches are bounded: <= 5 per pass, and >= 2 full passes between repeat
//     relaunches of the same entry (cooldown), so a crash-loop cannot be restarted
//     on every sweep.
//   * A duplicate `--loop` supervisor exits with stage DUPLICATE_SUPERVISOR_EXIT.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "monitor", "watchdog-live-status.json");

const SCHEMA = "watchdog-live/v1";
const SCANNER = "tools/watchdog-live.js";
const SUPERVISOR_SCRIPT = "tools/watchdog-live.js";
const MAX_RELAUNCHES_PER_PASS = 5;
const MIN_PASSES_BETWEEN_RELAUNCHES = 2;
const DEFAULT_LOOP_SECONDS = 60;
const DEFAULT_MAX_PASSES = 1440;
const CLOCK_SKEW_TOLERANCE_SECONDS = 300;

// Embedded manifest: the exact five standing read-only watchers. Paths/fields/
// thresholds are load-bearing; a mismatch here is a fail-closed bug, not a tweak.
const MANIFEST = Object.freeze([
  {
    id: "liquity-liquidation-triggers",
    script: "tools/watch-liquity-liquidation-triggers.js",
    args: ["--loop", "300"],
    heartbeat: "reports/raw/fast/liquity-liquidation-watch/status.json",
    field: "generatedAt",
    staleSeconds: 900,
  },
  {
    id: "aave-v3-liquidation-watch",
    script: "tools/aave-v3-liquidation-watch.js",
    args: ["--until-trigger", "--interval-ms", "60000"],
    heartbeat: "reports/raw/fast/aave-v3-liquidation-watch-status.json",
    field: "generatedAt",
    staleSeconds: 700,
  },
  {
    id: "euler-liquidation-watch",
    script: "tools/watch-euler-l.js",
    args: ["--loop", "300"],
    heartbeat: "reports/raw/fast/euler-l-watch-status.json",
    field: "generatedAt",
    staleSeconds: 700,
  },
  {
    id: "aave-v3-liquidation-exact-quotes",
    script: "tools/quote-aave-v3-liquidation-exact.js",
    args: ["--watch", "120", "--max-runs", "500"],
    heartbeat: "reports/raw/fast/aave-v3-liquidation-exact-quotes.json",
    field: "generatedAt",
    staleSeconds: 700,
  },
  {
    id: "morpho-ws",
    script: "tools/monitor-morpho-ws.js",
    args: [],
    heartbeat: "reports/monitor/morpho-ws-status.json",
    field: "updatedAt",
    staleSeconds: 700,
  },
  {
    id: "morpho-frozen-oracle",
    script: "tools/monitor-morpho-frozen-oracle.js",
    args: ["--watch"],
    heartbeat: "reports/raw/fast/morpho-frozen-oracle-status.json",
    field: "capturedAt",
    staleSeconds: 1200,
  },
  {
    id: "euler-crossing-exec2",
    script: "tools/crossing-euler-evk-exec2.js",
    args: [],
    heartbeat: "reports/raw/fast/euler-crossing-exec2-status.json",
    field: "generatedAt",
    staleSeconds: 2400,
  },
  {
    id: "silo-defaulting-watch",
    script: "tools/watch-silo-defaulting.js",
    args: ["--loop", "300"],
    heartbeat: "reports/raw/fast/silo-default-watch-status.json",
    field: "generatedAt",
    staleSeconds: 900,
  },
  {
    id: "euler-fastlane-watch",
    script: "tools/watch-euler-head-fastlane.js",
    args: ["--watch-once"],
    heartbeat: "reports/raw/fast/euler-fastlane-status.json",
    field: "scannedAt",
    staleSeconds: 300,
  },
  {
    id: "autofire-loop",
    script: "tools/loop-autofire.js",
    args: ["--loop", "60"],
    heartbeat: "reports/raw/fast/autofire-loop-status.json",
    field: "scannedAt",
    staleSeconds: 300,
  },
  {
    id: "fluid-surface-refresh",
    script: "tools/reference-fluid-surface-refresh.js",
    args: [],
    heartbeat: "reports/raw/fast/fluid-l-surface-refresh-status.json",
    field: "generatedAt",
    staleSeconds: 1800,
  },
  {
    id: "fluid-crossing-exec",
    script: "tools/crossing-fluid-t2t4-exec.js",
    args: [],
    heartbeat: "reports/raw/fast/fluid-crossing-exec-status.json",
    field: "generatedAt",
    staleSeconds: 1800,
  },
  {
    id: "euler-surface-refresh",
    script: "tools/reference-euler-surface-refresh.js",
    args: [],
    heartbeat: "reports/raw/fast/euler-l-surface-refresh-status.json",
    field: "generatedAt",
    staleSeconds: 1800,
  },
]);

function parseOptions(argv = process.argv.slice(2)) {
  const value = (name) => {
    const inline = argv.find((arg) => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const once = argv.includes("--once");
  const rawLoop = value("--loop");
  const loopSeconds = Math.max(5, Math.floor(Number(rawLoop) || DEFAULT_LOOP_SECONDS));
  const rawPasses = Number(value("--max-passes"));
  const maxPasses = Number.isFinite(rawPasses) ? Math.max(1, Math.floor(rawPasses)) : DEFAULT_MAX_PASSES;
  const manifestPath = value("--manifest") || null;
  const quiet = argv.includes("--quiet");
  return { once, loopSeconds, maxPasses, manifestPath, quiet };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateManifest(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("watchdog manifest must be a non-empty array");
  }
  const ids = new Set();
  const scripts = new Set();
  for (const entry of entries) {
    if (!isObject(entry) || typeof entry.id !== "string" || !entry.id) {
      throw new Error("watchdog manifest entry id is required");
    }
    if (typeof entry.script !== "string" || !/^tools\/[A-Za-z0-9._-]+\.js$/.test(entry.script)) {
      throw new Error(`watchdog manifest entry script must be a tools/*.js path: ${entry.id}`);
    }
    if (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== "string")) {
      throw new Error(`watchdog manifest entry args must be a string array: ${entry.id}`);
    }
    if (typeof entry.heartbeat !== "string" || !entry.heartbeat.startsWith("reports/")) {
      throw new Error(`watchdog manifest entry heartbeat must be a reports/ path: ${entry.id}`);
    }
    if (typeof entry.field !== "string" || !entry.field) {
      throw new Error(`watchdog manifest entry field is required: ${entry.id}`);
    }
    if (!Number.isSafeInteger(entry.staleSeconds) || entry.staleSeconds <= 0) {
      throw new Error(`watchdog manifest entry staleSeconds must be a positive integer: ${entry.id}`);
    }
    const texts = [entry.id, entry.script, entry.heartbeat, entry.field, ...entry.args];
    if (texts.some((text) => /https?:\/\//i.test(text))) {
      throw new Error(`watchdog manifest entry contains url material: ${entry.id}`);
    }
    if (ids.has(entry.id)) throw new Error(`duplicate watchdog manifest id: ${entry.id}`);
    if (scripts.has(entry.script)) throw new Error(`duplicate watchdog manifest script: ${entry.script}`);
    ids.add(entry.id);
    scripts.add(entry.script);
  }
  return true;
}

validateManifest(MANIFEST);

function loadManifest(manifestPath) {
  if (!manifestPath) return MANIFEST;
  const resolved = path.isAbsolute(manifestPath) ? manifestPath : path.join(WORKSPACE, manifestPath);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`watchdog manifest unreadable: ${error?.message || String(error)}`);
  }
  const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
  validateManifest(entries);
  return entries;
}

// Ascending staleness ordering. Stable, so equal thresholds keep manifest order.
function staleOrder(entries = MANIFEST) {
  return entries.slice().sort((a, b) => a.staleSeconds - b.staleSeconds).map((entry) => entry.id);
}

function nestedValue(value, dottedPath) {
  return String(dottedPath || "").split(".").reduce((current, key) => current?.[key], value);
}

function heartbeatAge(value, field, nowMs = Date.now()) {
  const observed = nestedValue(value, field);
  const parsed = Date.parse(observed);
  if (!Number.isFinite(parsed)) {
    return { present: false, iso: null, ageSeconds: null, ageMinutes: null };
  }
  const ageSeconds = (nowMs - parsed) / 1000;
  return {
    present: true,
    iso: new Date(parsed).toISOString(),
    ageSeconds,
    ageMinutes: Math.round((ageSeconds / 60) * 100) / 100,
  };
}

function heartbeatIsFresh(age, staleSeconds) {
  return age.present
    && age.ageSeconds !== null
    && age.ageSeconds <= staleSeconds
    && age.ageSeconds >= -CLOCK_SKEW_TOLERANCE_SECONDS;
}

function readHeartbeatArtifact(entry, options = {}) {
  if (options.heartbeatMap && Object.prototype.hasOwnProperty.call(options.heartbeatMap, entry.heartbeat)) {
    return options.heartbeatMap[entry.heartbeat];
  }
  const file = path.join(options.workspace || WORKSPACE, ...entry.heartbeat.split("/"));
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Fragment match on a normalized command line: `tools/<basename>` must appear as
// a whole path token, so `tools/<base>.test.js`, `tools/not-<base>` and argument
// mentions inside another script do not match.
function commandLineMatchesScript(commandLine, script) {
  const haystack = String(commandLine || "").replace(/\\/g, "/").toLowerCase();
  const base = String(script || "").replace(/\\/g, "/").toLowerCase().split("/").pop();
  if (!base) return false;
  const pattern = new RegExp(`(^|[\\s"'/])tools/${escapeRegExp(base)}(?=$|[\\s"'])`, "i");
  return pattern.test(haystack);
}

function matchEntryProcesses(rows, entry) {
  return (rows || []).filter((row) => commandLineMatchesScript(row?.commandLine, entry.script));
}

function detectDuplicateSupervisor(rows, selfPid, script = SUPERVISOR_SCRIPT) {
  return (rows || []).some((row) => {
    if (row?.pid === selfPid) return false;
    if (!commandLineMatchesScript(row?.commandLine, script)) return false;
    return /(^|\s)--loop(=|\s|$)/.test(String(row?.commandLine || ""));
  });
}

// Pure decision: FRESH + alive -> NONE; stale or absent -> relaunch unless a
// cooldown or the per-pass budget suppresses it.
function decideEntryAction({ fresh, processAlive, cooldownRemaining, relaunchesThisPass }) {
  if (fresh && processAlive) {
    return { action: "NONE", reason: "fresh-and-alive", suppressed: false };
  }
  if (cooldownRemaining > 0) {
    return { action: "NONE", reason: "relaunch-cooldown", suppressed: true };
  }
  if (relaunchesThisPass >= MAX_RELAUNCHES_PER_PASS) {
    return { action: "NONE", reason: "relaunch-budget-exhausted", suppressed: true };
  }
  return {
    action: "STOP_STALE_THEN_RELAUNCH",
    reason: processAlive ? "heartbeat-stale" : "process-absent",
    suppressed: false,
  };
}

function minimalProcessInspectionEnv(source = process.env) {
  const env = {};
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"]) {
    if (typeof source[name] === "string" && source[name]) env[name] = source[name];
  }
  return env;
}

function inspectNodeProcesses() {
  // Bounded query: only node.exe, only CommandLine, aggregate rows. Nothing about
  // a command line is ever emitted downstream.
  const query = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  try {
    const env = minimalProcessInspectionEnv();
    const powershell = env.SystemRoot
      ? path.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    const result = spawnSync(powershell, ["-NoProfile", "-Command", query], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 5 * 1024 * 1024,
      env,
    });
    if (result.error || result.status !== 0) return { ok: false, rows: [] };
    const raw = String(result.stdout || "").trim();
    if (!raw) return { ok: true, rows: [] };
    const parsed = JSON.parse(raw);
    const rows = (Array.isArray(parsed) ? parsed : [parsed])
      .filter((row) => row && row.CommandLine)
      .map((row) => ({ pid: Number(row.ProcessId), commandLine: String(row.CommandLine) }));
    return { ok: true, rows };
  } catch (_) {
    return { ok: false, rows: [] };
  }
}

function runSweep(manifest, state, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const inspection = options.processes
    ? { ok: options.processInspectionOk !== false, rows: options.processes }
    : inspectNodeProcesses();
  const rows = inspection.rows;
  let relaunchesThisPass = 0;
  const entries = [];

  for (const entry of manifest) {
    const artifact = readHeartbeatArtifact(entry, options);
    const age = heartbeatAge(artifact, entry.field, nowMs);
    const fresh = heartbeatIsFresh(age, entry.staleSeconds);
    const matched = matchEntryProcesses(rows, entry);
    const processAlive = matched.length > 0;
    const passesSince = state.passesSinceRelaunch[entry.id] ?? MIN_PASSES_BETWEEN_RELAUNCHES;
    const cooldownRemaining = Math.max(0, MIN_PASSES_BETWEEN_RELAUNCHES - passesSince);
    const decision = decideEntryAction({ fresh, processAlive, cooldownRemaining, relaunchesThisPass });

    if (decision.action === "STOP_STALE_THEN_RELAUNCH") {
      if (!options.dryRun) {
        for (const row of matched) {
          try { process.kill(row.pid, "SIGTERM"); } catch (_) {}
        }
        if (!options.noSpawn) {
          try {
            const child = spawn(process.execPath, [entry.script, ...entry.args], {
              cwd: options.workspace || WORKSPACE,
              detached: true,
              stdio: "ignore",
            });
            child.unref();
          } catch (_) {}
        }
      }
      relaunchesThisPass += 1;
      state.passesSinceRelaunch[entry.id] = 0;
      state.consecutiveRelaunches[entry.id] = (state.consecutiveRelaunches[entry.id] || 0) + 1;
    } else {
      state.passesSinceRelaunch[entry.id] = passesSince + 1;
      if (!decision.suppressed) state.consecutiveRelaunches[entry.id] = 0;
    }

    entries.push({
      id: entry.id,
      script: entry.script,
      heartbeat: entry.heartbeat,
      field: entry.field,
      staleThresholdSeconds: entry.staleSeconds,
      heartbeatAge: age.ageMinutes,
      heartbeatAgeSeconds: age.ageSeconds === null ? null : Math.round(age.ageSeconds),
      processAlive,
      action: decision.action,
      consecutiveRelaunches: state.consecutiveRelaunches[entry.id] || 0,
      passesSinceRelaunch: state.passesSinceRelaunch[entry.id],
      suppressed: decision.suppressed,
      reason: decision.reason,
    });
  }

  return {
    entries,
    processInspectionOk: inspection.ok,
    relaunchesThisPass,
    summary: {
      entries: entries.length,
      none: entries.filter((row) => row.action === "NONE").length,
      relaunched: entries.filter((row) => row.action === "STOP_STALE_THEN_RELAUNCH").length,
      suppressed: entries.filter((row) => row.suppressed).length,
    },
  };
}

function buildStatus({ pass, mode, manifest, state, options = {}, nowMs = Date.now(), duplicate = false }) {
  const sweep = runSweep(manifest, state, { ...options, nowMs });
  return {
    schema: SCHEMA,
    generatedAt: new Date(nowMs).toISOString(),
    scanner: SCANNER,
    mode,
    pass,
    readonly: true,
    coverageProof: null,
    processInspectionOk: sweep.processInspectionOk,
    duplicateGuard: duplicate ? "duplicate-supervisor-exit" : "ok",
    relaunchBudget: {
      perPass: MAX_RELAUNCHES_PER_PASS,
      minPassesBetweenRelaunches: MIN_PASSES_BETWEEN_RELAUNCHES,
    },
    relaunches: sweep.relaunchesThisPass,
    consecutiveRelaunches: { ...state.consecutiveRelaunches },
    summary: sweep.summary,
    entries: sweep.entries,
  };
}

function formatConsole(status) {
  const actions = status.entries.map((row) => `${row.id}:${row.action}`).join(",");
  return `[WATCHDOG-LIVE pass=${status.pass}] mode=${status.mode} relaunches=${status.relaunches} entries=${status.summary.entries} none=${status.summary.none} suppressed=${status.summary.suppressed} ${actions}`;
}

function containsUrlMaterial(value) {
  if (Array.isArray(value)) return value.some(containsUrlMaterial);
  if (typeof value === "string") return /https?:\/\//i.test(value);
  if (isObject(value)) return Object.values(value).some(containsUrlMaterial);
  return false;
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function writeJson(file, value) {
  ensureParent(file);
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  const manifest = loadManifest(options.manifestPath);
  const state = { passesSinceRelaunch: {}, consecutiveRelaunches: {} };

  const guardRows = options.processes ? options.processes : inspectNodeProcesses().rows;
  if (detectDuplicateSupervisor(guardRows, options.selfPid ?? process.pid)) {
    const status = {
      schema: SCHEMA,
      generatedAt: new Date().toISOString(),
      scanner: SCANNER,
      mode: options.once ? "once" : "loop",
      pass: 0,
      stage: "DUPLICATE_SUPERVISOR_EXIT",
      ok: true,
      readonly: true,
      coverageProof: null,
      duplicateGuard: "duplicate-supervisor-exit",
      entries: [],
    };
    writeJson(OUT, status);
    if (!options.quiet) console.log("[WATCHDOG-LIVE] DUPLICATE_SUPERVISOR_EXIT");
    return { ok: true, stage: "DUPLICATE_SUPERVISOR_EXIT", passes: 0 };
  }

  let pass = 0;
  do {
    pass += 1;
    const status = buildStatus({
      pass,
      mode: options.once ? "once" : "loop",
      manifest,
      state,
      options: { ...options, selfPid: options.selfPid ?? process.pid },
    });
    writeJson(OUT, status);
    if (!options.quiet) console.log(formatConsole(status));
    if (options.once) break;
    if (pass >= options.maxPasses) break;
    await sleep(options.loopSeconds * 1000);
  } while (true);

  return { ok: true, stage: "COMPLETE", passes: pass };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`watchdog-live failed closed: ${error?.message || String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE,
  OUT,
  SCHEMA,
  SCANNER,
  SUPERVISOR_SCRIPT,
  MAX_RELAUNCHES_PER_PASS,
  MIN_PASSES_BETWEEN_RELAUNCHES,
  DEFAULT_LOOP_SECONDS,
  DEFAULT_MAX_PASSES,
  MANIFEST,
  parseOptions,
  validateManifest,
  loadManifest,
  staleOrder,
  nestedValue,
  heartbeatAge,
  heartbeatIsFresh,
  readHeartbeatArtifact,
  commandLineMatchesScript,
  matchEntryProcesses,
  detectDuplicateSupervisor,
  decideEntryAction,
  inspectNodeProcesses,
  minimalProcessInspectionEnv,
  runSweep,
  buildStatus,
  formatConsole,
  containsUrlMaterial,
  writeJson,
  main,
};
