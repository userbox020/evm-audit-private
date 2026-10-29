#!/usr/bin/env node
"use strict";

// Import-inert. No producers, executor modules, approval stores or locks are loaded.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { execFileSync, spawnSync } = require("node:child_process");
const manifest = require("./monitor-service-manifest");
const watchdog = require("./monitor-set-watchdog");
const { minimalMonitorEnv } = require("./monitor-minimal-env");
const hidden = require("./monitor-hidden-dispatch");
const ROOT = path.resolve(__dirname, "..");
const STATUS = path.join(ROOT, "reports/monitor/readonly-recovery/status.json");
const MAX_PASSES = 4;
const MAX_LAUNCHES = 3;
const MAX_RUNTIME_MS = 220000;
// Pin the prior-active set, not every present/future manifest entry.
const PINS = [
  ["novelty-monitor", "tools/monitor-novelty-conditions.js", ["--watch"]],
  ["morpho-ws", "tools/monitor-morpho-ws.js", []],
  ["chainlink-ws", "tools/monitor-chainlink-ws.js", []],
  ["aave-v4-owner-watch", "tools/watch-aave-v4-liquidation-triggers.js", ["--iterations", "1000000", "--interval-ms", "300000", "--no-quotes", "--no-sweep", "--quiet"]],
  ["aave-v3-liquidation-watch", "tools/aave-v3-liquidation-watch.js", ["--until-trigger", "--interval-ms", "60000"]],
  ["global-gates", "tools/monitor-global-gates.js", ["--watch", "--interval-ms=300000", "--apyusd-interval-ms=1800000"]],
  ["e1-proximity", "tools/monitor-e1-proximity.js", ["--watch"]],
  ["venus-psr-multichain", "tools/monitor-venus-psr-multichain.js", ["--loop", "--use-authorized-inventory", "--allow-public-ethereum-fallback", "--interval-seconds", "3600"]],
  ["autopilot-status", "tools/autopilot-status.js", ["--watch", "--interval-ms=60000"]],
  ["morpho-frozen-oracle", "tools/monitor-morpho-frozen-oracle.js", ["--watch"]],
];
const SENTINEL = Object.freeze({ id: "whale-sentinel", script: "tools/watch-top-whale-triggers.js", args: ["--watch", "20"], kind: "persistent", mode: "read-only" });
const TASK_IDS = Object.freeze({ dashboard: "EVMAuditDashboard", "monitor-set": "EVMAuditMonitorSet", "monitor-set-watchdog": "EVMAuditMonitorSetWatchdog", "venus-psr-multichain": "EVMAuditMonitorVenus", "canary-feeds": "EVMAuditCanaryFeeds" });
const TASK_STATES = ["MISSING", "READY", "RUNNING", "QUEUED", "DISABLED"];
const stamp = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function selectedServices() {
  if (manifest.persistentServices.length !== PINS.length) throw new Error("MANIFEST_CHANGED");
  return PINS.map(([id, script, args]) => {
    const row = manifest.persistentServices.find(s => s.id === id);
    if (!row || row.script !== script || row.mode !== "read-only" || row.kind !== "persistent" || JSON.stringify(row.args) !== JSON.stringify(args)) throw new Error("MANIFEST_CHANGED");
    return row;
  });
}

function parseOptions(argv = []) {
  if (argv.length > 1 || (argv.length === 1 && !["--apply", "--check"].includes(argv[0]))) throw new Error("ARGUMENTS_REFUSED");
  return { apply: argv[0] === "--apply" };
}

function runtimeEnv(source = process.env) {
  // Safe configuration overrides are deliberately not inherited by recovery.
  const env = minimalMonitorEnv(source, "win32");
  for (const name of Object.keys(env)) if (!/^(SystemRoot|WINDIR|ComSpec|PATHEXT|PATH|TEMP|TMP)$/i.test(name)) delete env[name];
  return env;
}

function powershell(env) {
  return path.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
}

function inspect() {
  const env = runtimeEnv();
  const exec = args => execFileSync(powershell(env), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], {
    cwd: ROOT, env, encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    const jobs = JSON.parse(exec(["-File", path.join(__dirname, "read-audit-jobs.ps1")]));
    // This fixed helper emits only counts, task enums and a verified interpreter.
    const auxiliary = JSON.parse(exec(["-Command", ". './tools/run-readonly-recovery.ps1'; Get-ReadOnlyRecoveryAuxiliary | ConvertTo-Json -Depth 4 -Compress"]));
    // The existing inspector's execFileSync can forward native stderr. Isolate
    // it behind private pipes so even its failure diagnostics cannot escape.
    // Raw command lines travel only between these two processes, never to logs.
    const nodes = JSON.parse(execFileSync(process.execPath, ["-e", "const w=require('./tools/monitor-set-watchdog');process.stdout.write(JSON.stringify(w.inspectProcesses()));"], {
      cwd: ROOT, env, encoding: "utf8", windowsHide: true, timeout: 12000, maxBuffer: 5 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    }));
    return { ok: nodes.ok === true && jobs.inspection?.processes === "OK" && jobs.inspection?.scheduler === "OK" && auxiliary.ok === true,
      rows: nodes.rows, jobs: jobs.jobs, dashboard: auxiliary.dashboard, dashboardTask: auxiliary.schedule, legacyStartup: auxiliary.legacyStartup };
  } catch (_) { return { ok: false }; }
}

function readJson(file, limit = 1024 * 1024) {
  try {
    const size = fs.statSync(file).size;
    if (size > limit) throw new Error("STATUS_READ_FAILED");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("STATUS_READ_FAILED");
  }
}
const statusIO = {
  read(kind) {
    const files = { recovery: STATUS, watchdog: watchdog.STATUS_FILE, health: path.join(ROOT, "reports/monitor/autopilot-health.json") };
    if (!Object.hasOwn(files, kind)) throw new Error("STATUS_READ_FAILED");
    return readJson(files[kind]);
  },
  write(value) {
    fs.mkdirSync(path.dirname(STATUS), { recursive: true });
    fs.writeFileSync(STATUS, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
  },
};

function getHealth() {
  // No redirects, proxies, /canary or other side-effecting dashboard routes.
  return new Promise(resolve => {
    let finished = false;
    const done = value => { if (!finished) { finished = true; resolve(value); } };
    const request = http.get({ hostname: "127.0.0.1", port: 5050, path: "/healthz", agent: false, timeout: 1500 }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; if (text.length > 32768) { done({ state: "UNAVAILABLE" }); response.destroy(); } });
      response.on("end", () => {
        try {
          const body = JSON.parse(text);
          done({ state: response.statusCode === 200 && typeof body.available === "boolean" ? "RESPONDING" : "UNAVAILABLE", sourcesAvailable: body.available === true });
        } catch (_) { done({ state: "UNAVAILABLE" }); }
      });
      response.on("error", () => done({ state: "UNAVAILABLE" }));
    });
    const timer = setTimeout(() => { request.destroy(); done({ state: "UNAVAILABLE" }); }, 2000);
    request.on("close", () => clearTimeout(timer));
    request.on("timeout", () => { request.destroy(); done({ state: "UNAVAILABLE" }); });
    request.on("error", () => done({ state: "UNAVAILABLE" }));
  });
}

function launch(id, context = {}, options = {}) {
  const env = runtimeEnv(options.env || process.env);
  const service = selectedServices().find(row => row.id === id);
  if (service) return hidden.launch(service.id, { env, timeoutMs: 8000, spawnImpl: options.spawnImpl });
  let executable; let args;
  if (id === SENTINEL.id) {
    executable = process.execPath;
    args = [path.join(ROOT, SENTINEL.script), ...SENTINEL.args].map(hidden.quote).join(" ");
  } else if (id === "dashboard" && typeof context.python === "string" && /^[A-Za-z]:\\[^\r\n"]+\\Python3[0-9]+(?:-[0-9]+)?\\python\.exe$/i.test(context.python)) {
    executable = context.python; // Already resolved against trusted install roots by the PS helper.
    args = `-E -B ${hidden.quote(path.join(__dirname, "run-dashboard-task.py"))}`;
  } else throw new Error("LAUNCH_REFUSED");
  const wire = { version: 1, executable, arguments: args, workingDirectory: ROOT, wait: false, environmentNames: Object.keys(env) };
  return (options.spawnImpl || spawnSync)(path.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32/wscript.exe"),
    ["//B", "//Nologo", path.join(__dirname, "launch-hidden.vbs"), Buffer.from(JSON.stringify(wire)).toString("base64")],
    { cwd: ROOT, env, stdio: "ignore", windowsHide: true, timeout: 8000 });
}

function priorRows(...values) {
  const result = new Map();
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (!["readonly-recovery/v1", "monitor-set-watchdog-status/v1"].includes(value.schema) || !Array.isArray(value.services)) throw new Error("STATUS_READ_FAILED");
    for (const row of value.services) {
      if (!row || !["dashboard", SENTINEL.id, ...PINS.map(p => p[0])].includes(row.id)) continue;
      if (!Number.isSafeInteger(row.attempts) || row.attempts < 0 || (row.nextEligibleAt && !stamp(row.nextEligibleAt)) || (row.lastAttemptAt && !stamp(row.lastAttemptAt))) throw new Error("STATUS_READ_FAILED");
      const old = result.get(row.id) || { attempts: 0, lastAttemptAt: null, nextEligibleAt: null };
      result.set(row.id, { attempts: Math.max(old.attempts, Math.min(5, row.attempts)), lastAttemptAt: [old.lastAttemptAt, stamp(row.lastAttemptAt)].filter(Boolean).sort().pop() || null,
        nextEligibleAt: [old.nextEligibleAt, stamp(row.nextEligibleAt)].filter(Boolean).sort().pop() || null });
    }
  }
  return result;
}

function schedule(snapshot, id) {
  const rows = snapshot.jobs?.filter(row => row.id === id) || [];
  const raw = id === "dashboard" ? snapshot.dashboardTask : rows.length === 1 ? rows[0].schedule : null;
  if (!raw || raw.taskId !== TASK_IDS[id] || !TASK_STATES.includes(raw.state) || (raw.state !== "MISSING" && typeof raw.enabled !== "boolean")) return { state: "UNKNOWN", enabled: null };
  return { state: raw.state, enabled: raw.enabled === true };
}

function view(snapshot, targets, prior) {
  if (snapshot?.ok !== true || !Array.isArray(snapshot.rows) || !Array.isArray(snapshot.jobs) || !Number.isInteger(snapshot.dashboard?.count) || snapshot.dashboard.count < 0 || typeof snapshot.dashboard.occupied !== "boolean" || typeof snapshot.legacyStartup !== "boolean") {
    return { reason: "INSPECTION_FAILED", services: targets.map(target => ({ id: target.id, count: null, state: "UNKNOWN", ...(prior.get(target.id) || { attempts: 0, lastAttemptAt: null, nextEligibleAt: null }) })) };
  }
  const tasks = Object.fromEntries(Object.keys(TASK_IDS).map(id => [id, schedule(snapshot, id)]));
  const services = targets.map(target => {
    const count = target.id === "dashboard" ? snapshot.dashboard.count : snapshot.rows.filter(row => watchdog.processHasScript(row, target.script, ROOT)).length;
    const linked = target.id === "dashboard" ? ["dashboard"] : ["monitor-set", "monitor-set-watchdog", ...(target.id === "venus-psr-multichain" ? [target.id] : [])];
    const held = linked.some(id => tasks[id].state === "DISABLED" || (tasks[id].state !== "MISSING" && tasks[id].enabled === false));
    return { id: target.id, count, state: count > 1 ? "DUPLICATE" : held ? "HELD_DISABLED" : count === 1 ? "PRESENT" : target.id === "dashboard" && snapshot.dashboard.occupied ? "PORT_OCCUPIED" : "MISSING",
      ...(prior.get(target.id) || { attempts: 0, lastAttemptAt: null, nextEligibleAt: null }) };
  });
  let reason = "INSPECTED";
  if (services.some(row => row.count > 1)) reason = "DUPLICATES_REFUSED";
  else if (Object.entries(tasks).some(([id, task]) => id !== "canary-feeds" && task.state === "UNKNOWN")) reason = "INSPECTION_FAILED";
  else if (snapshot.rows.some(row => watchdog.processHasScript(row, SENTINEL.script, ROOT) && JSON.stringify(watchdog.parseNodeInvocation(row).args) !== JSON.stringify(SENTINEL.args))) reason = "SENTINEL_MODE_REFUSED";
  else if (snapshot.legacyStartup || ["monitor-set", "monitor-set-watchdog"].some(id => ["RUNNING", "QUEUED"].includes(tasks[id].state)) || snapshot.rows.some(row => watchdog.processHasScript(row, "tools/monitor-set-watchdog.js", ROOT))) reason = "LEGACY_STARTUP_DEFERRED";
  return { reason, services, tasks };
}

function healthView(value, now) {
  const generatedAt = stamp(value?.generatedAt);
  const age = generatedAt ? now - Date.parse(generatedAt) : NaN;
  const count = key => Number.isInteger(value?.summary?.[key]) && value.summary[key] >= 0 && value.summary[key] <= 10 ? value.summary[key] : null;
  return { freshness: Number.isFinite(age) ? age >= 0 && age <= 180000 ? "FRESH" : "STALE" : "UNKNOWN",
    status: ["healthy", "observational", "fail-closed"].includes(value?.summary?.status) ? value.summary.status : "UNKNOWN",
    persistentExpected: count("persistentExpected"), persistentRunning: count("persistentRunning"), persistentReady: count("persistentReady"), persistentObservational: count("persistentObservational") };
}

async function runRecovery(options = {}, dependencies = {}) {
  const deps = { inspect, launch, clock: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), http: getHealth, statusIO, ...dependencies };
  const apply = options.apply === true;
  const started = deps.clock();
  const output = { schema: "readonly-recovery/v1", mode: apply ? "apply" : "check", reason: "INSPECTION_FAILED", passes: 0, launches: 0, services: [],
    liveExecutions: "EXCLUDED_HELD", liveHold: "BATCH_TARGET_NOT_APPROVED", liveHoldSource: "RECOVERY_SCOPE_NOT_REVALIDATED", canary: "SCHEDULE_ONLY_NO_LOCK_OR_WINDOW_CHANGES", readiness: "NOT_ESTABLISHED" };
  let prior = new Map();
  let persistenceAllowed = false;
  const save = () => { if (apply && persistenceAllowed) deps.statusIO.write(output); };
  try {
    const targets = [{ id: "dashboard" }, ...selectedServices(), SENTINEL];
    prior = priorRows(deps.statusIO.read("watchdog"), deps.statusIO.read("recovery"));
    persistenceAllowed = true;
    let pending = [];
    for (let pass = 0; pass <= (apply ? MAX_PASSES : 0);) {
      if (deps.clock() - started >= MAX_RUNTIME_MS) { output.reason = "TIME_LIMIT"; break; }
      const snapshot = await deps.inspect();
      const observed = view(snapshot, targets, prior);
      output.services = observed.services;
      output.schedules = observed.tasks || {};
      output.reason = observed.reason;
      if (apply && observed.reason === "LEGACY_STARTUP_DEFERRED") {
        const remaining = MAX_RUNTIME_MS - (deps.clock() - started);
        if (remaining <= 0) { output.reason = "TIME_LIMIT"; break; }
        // Waiting consumes runtime, not launch passes; no holds/backoff change.
        await deps.sleep(Math.min(5000, remaining));
        continue;
      }
      if (observed.reason !== "INSPECTED") break;
      // Match the watchdog's successful-observation reset. A retry budget is not
      // a lifetime limit on successful reboot recoveries; unknown/missing rows
      // retain their original backoff, including across interrupted invocations.
      for (const row of output.services) if (row.count === 1) {
        const reset = { attempts: 0, lastAttemptAt: null, nextEligibleAt: null };
        Object.assign(row, reset);
        prior.set(row.id, reset);
      }
      if (pending.length && pending.some(id => !observed.services.some(row => row.id === id && (row.count === 1 || (id === "dashboard" && snapshot.dashboard.occupied))))) { output.reason = "NO_PROGRESS"; break; }
      pending = [];
      if (!apply) { output.reason = "CHECK_ONLY"; break; }
      if (pass === MAX_PASSES) { output.reason = "PASS_LIMIT"; break; }
      output.passes += 1;
      pass += 1;
      let failed = false;
      for (const target of targets) {
        const row = output.services.find(s => s.id === target.id);
        if (row.state !== "MISSING" || pending.length >= MAX_LAUNCHES) continue;
        if (deps.clock() - started >= MAX_RUNTIME_MS) { output.reason = "TIME_LIMIT"; failed = true; break; }
        // A linked task in flight owns its startup, even before its listener/child appears.
        const linkedTask = target.id === "dashboard" ? observed.tasks.dashboard : target.id === "venus-psr-multichain" ? observed.tasks[target.id] : null;
        if (linkedTask && ["RUNNING", "QUEUED"].includes(linkedTask.state)) { row.state = "TASK_IN_FLIGHT"; continue; }
        const now = deps.clock();
        if (row.attempts >= 5) { row.state = "RETRY_LIMIT"; continue; }
        if (Date.parse(row.nextEligibleAt || "") > now) { row.state = "COOLDOWN"; continue; }
        if (target.id === "dashboard" && !snapshot.dashboard.python) { row.state = "INTERPRETER_UNVERIFIED"; output.reason = "LAUNCH_FAILED"; failed = true; break; }
        const next = { attempts: row.attempts + 1, lastAttemptAt: new Date(now).toISOString(), nextEligibleAt: new Date(now + Math.min(3600000, watchdog.BASE_COOLDOWN_MS * 2 ** row.attempts)).toISOString() };
        const previous = { ...row };
        Object.assign(row, next, { state: "ATTEMPTING" });
        prior.set(target.id, next);
        save(); // Preserve cooldown before process creation, including interrupted invocations.
        let result;
        if (target.id === "dashboard") {
          try { result = deps.launch(target.id, { python: snapshot.dashboard.python }); } catch (_) { result = null; }
        } else {
          const status = watchdog.runWatchdog({ apply: true, manifest: { persistentServices: [target], forbiddenProcessScripts: manifest.forbiddenProcessScripts },
            processRows: snapshot.rows, priorStatus: { services: [previous] }, clock: deps.clock, maxRelaunches: 1,
            spawn: service => deps.launch(service.id, {}) });
          result = { status: status.services[0]?.state === "relaunched" ? 0 : 1 };
        }
        output.launches += 1;
        if (result?.status !== 0 || result?.error) { row.state = "LAUNCH_FAILED"; output.reason = "LAUNCH_FAILED"; failed = true; save(); break; }
        row.state = "LAUNCHED_NOT_READY";
        pending.push(target.id);
        save();
      }
      if (failed) break;
      if (!pending.length) { output.reason = "BOUNDED_COMPLETE"; break; }
      await deps.sleep(2000);
    }
    if (output.reason === "PASS_LIMIT" && output.services.every(row => row.count === 1)) output.reason = "BOUNDED_COMPLETE";
    try { output.monitorHealth = healthView(deps.statusIO.read("health"), deps.clock()); } catch (_) { output.monitorHealth = healthView(null, deps.clock()); }
    try {
      const health = await deps.http();
      output.dashboardHealth = { state: health?.state === "RESPONDING" ? "RESPONDING" : "UNAVAILABLE", sourcesAvailable: health?.sourcesAvailable === true };
    } catch (_) { output.dashboardHealth = { state: "UNAVAILABLE", sourcesAvailable: false }; }
    output.readiness = "SEE_HEALTH_SEPARATELY_FROM_PROCESS_PRESENCE";
  } catch (error) {
    output.reason = ["STATUS_READ_FAILED", "MANIFEST_CHANGED"].includes(error?.message) ? error.message : "RECOVERY_FAILED";
  }
  output.generatedAt = new Date(deps.clock()).toISOString();
  try { save(); } catch (_) { output.reason = "STATUS_WRITE_FAILED"; }
  return output;
}

function exitCode(status) {
  return ["CHECK_ONLY", "BOUNDED_COMPLETE"].includes(status.reason) && status.services.length === 12 && status.services.every(row => row.count === 1 && row.state === "PRESENT") ? 0 : 1;
}
async function cli(argv = process.argv.slice(2)) {
  const status = await runRecovery(parseOptions(argv));
  process.stdout.write(`readonly-recovery ${status.mode}: ${status.reason}; present=${status.services.filter(row => row.count === 1).length}/12; launched=${status.launches}; dashboard=${status.dashboardHealth?.state || "UNKNOWN"}; monitor-readiness=${status.monitorHealth?.status || "UNKNOWN"}; live=EXCLUDED_HELD\n`);
  process.exitCode = exitCode(status);
  return status;
}
if (require.main === module) cli().catch(() => { process.stderr.write("readonly-recovery: ARGUMENTS_OR_RECOVERY_REFUSED\n"); process.exitCode = 1; });
module.exports = { ROOT, STATUS, MAX_PASSES, MAX_LAUNCHES, MAX_RUNTIME_MS, SENTINEL, TASK_IDS, selectedServices, parseOptions, runtimeEnv, launch, priorRows, view, healthView, runRecovery, exitCode, cli };
