#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const manifest = require("./monitor-service-manifest");
const { minimalMonitorEnv, assertMinimalEnvironment } = require("./monitor-minimal-env");

const WORKSPACE = path.resolve(__dirname, "..");
const STATUS_FILE = path.join(WORKSPACE, "reports", "monitor", "monitor-set-watchdog-status.json");
const MAX_RELAUNCHES_PER_PASS = 3;
const BASE_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 60 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_WALL_CLOCK_MS = 25_000;
const MAX_SERVICES = 64;

function splitWindowsCommandLine(value) {
  const text = String(value || "");
  const args = [];
  let index = 0;
  while (index < text.length) {
    while (/\s/.test(text[index] || "")) index += 1;
    if (index >= text.length) break;
    let arg = "";
    let quoted = false;
    while (index < text.length && (quoted || !/\s/.test(text[index]))) {
      let backslashes = 0;
      while (text[index] === "\\") {
        backslashes += 1;
        index += 1;
      }
      if (text[index] === '"') {
        arg += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2) arg += '"';
        else quoted = !quoted;
        index += 1;
      } else {
        arg += "\\".repeat(backslashes);
        if (index < text.length && (quoted || !/\s/.test(text[index]))) {
          arg += text[index];
          index += 1;
        }
      }
    }
    args.push(arg);
  }
  return args;
}

const NODE_OPTIONS_WITH_VALUE = new Set([
  "-C", "--conditions", "--cpu-prof-dir", "--diagnostic-dir", "--disable-warning",
  "--dns-result-order", "--env-file", "--env-file-if-exists", "--experimental-loader",
  "--experimental-policy", "--icu-data-dir", "--import", "--inspect-port", "--loader",
  "--openssl-config", "-r", "--require", "--snapshot-blob", "--title",
]);
const NODE_INLINE_SOURCE_OPTIONS = new Set(["-e", "--eval", "-p", "--print"]);

function parseNodeInvocation(row) {
  if (row?.scriptId) return { script: String(row.scriptId), args: [] };
  const commandLine = typeof row === "string" ? row : row?.CommandLine || row?.commandLine || "";
  const tokens = splitWindowsCommandLine(commandLine);
  if (tokens.length < 2) return null;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const rawOption = token.split("=", 1)[0];
    const option = rawOption.startsWith("--") ? rawOption.toLowerCase() : rawOption;
    if (token === "--") return tokens[index + 1] ? { script: tokens[index + 1], args: tokens.slice(index + 2) } : null;
    if (!token.startsWith("-") || token === "-") return { script: token, args: tokens.slice(index + 1) };
    if (NODE_INLINE_SOURCE_OPTIONS.has(option) || /^-[ep][^=]/.test(token)) return null;
    if (!token.includes("=") && NODE_OPTIONS_WITH_VALUE.has(option)) index += 1;
    else if (/^-r.+/.test(token) && token !== "-r") continue;
  }
  return null;
}

function normalizedScript(value) {
  return path.win32.normalize(String(value || "").replace(/\//g, "\\")).toLowerCase();
}

function scriptIdentityMatches(candidate, expected, workspace = WORKSPACE) {
  const actual = normalizedScript(candidate);
  const wanted = normalizedScript(expected).replace(/^\.\\/, "");
  if (!actual || !wanted) return false;
  if (path.win32.isAbsolute(actual)) {
    return actual === normalizedScript(path.win32.resolve(workspace, wanted));
  }
  return actual.replace(/^\.\\/, "") === wanted;
}

function processHasScript(row, script, workspace = WORKSPACE) {
  const invocation = parseNodeInvocation(row);
  return Boolean(invocation && scriptIdentityMatches(invocation.script, script, workspace));
}

function validateWatchdogManifest(value) {
  const services = value?.persistentServices;
  const forbidden = value?.forbiddenProcessScripts;
  if (!Array.isArray(services) || !Array.isArray(forbidden) || services.length > MAX_SERVICES) {
    throw new Error("malformed monitor service manifest");
  }
  const ids = new Set();
  const scripts = new Set();
  for (const service of services) {
    const validId = typeof service?.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(service.id);
    const validScript = typeof service?.script === "string"
      && /^tools\/[A-Za-z0-9._/-]+\.js$/u.test(service.script)
      && !service.script.split("/").includes("..");
    const validArgs = Array.isArray(service?.args) && service.args.length <= 32
      && service.args.every((arg) => typeof arg === "string" && arg.length <= 256 && /^[A-Za-z0-9._=:/-]+$/u.test(arg));
    if (!validId || !validScript || !validArgs || service.kind !== "persistent" || service.mode !== "read-only"
      || ids.has(service.id) || scripts.has(normalizedScript(service.script))) {
      throw new Error("malformed monitor service manifest");
    }
    ids.add(service.id);
    scripts.add(normalizedScript(service.script));
  }
  if (forbidden.some((script) => typeof script !== "string" || !/^tools\/[A-Za-z0-9._/-]+\.js$/u.test(script))) {
    throw new Error("malformed monitor service manifest");
  }
  return services;
}

function minimalRuntimeEnv(source = process.env) {
  const env = minimalMonitorEnv(source, "win32");
  if (!assertMinimalEnvironment(env, "win32")) throw new Error("minimal environment gate failed");
  return env;
}

function inspectProcesses(options = {}) {
  const timeout = Math.max(1, Math.min(10_000, options.timeoutMs || 10_000));
  const env = minimalRuntimeEnv(options.env || process.env);
  const powershell = env.SystemRoot
    ? path.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const query = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'node.exe' -and $_.CommandLine } | Select-Object CommandLine | ConvertTo-Json -Compress";
  try {
    const raw = execFileSync(powershell, ["-NoProfile", "-Command", query], {
      cwd: WORKSPACE,
      encoding: "utf8",
      env,
      maxBuffer: 5 * 1024 * 1024,
      timeout,
      windowsHide: true,
    }).trim();
    if (!raw) return { ok: true, rows: [] };
    const parsed = JSON.parse(raw);
    return { ok: true, rows: (Array.isArray(parsed) ? parsed : [parsed]).filter((row) => row?.CommandLine) };
  } catch (_) {
    return { ok: false, rows: [] };
  }
}

function friendlyName(id) {
  const acronyms = new Map([["ws", "WS"], ["v3", "V3"], ["v4", "V4"], ["e1", "E1"], ["psr", "PSR"]]);
  return id.split("-").map((word) => acronyms.get(word) || `${word[0].toUpperCase()}${word.slice(1)}`).join(" ");
}

function launchService(service, options = {}) {
  const fixed = manifest.persistentServices.find(row => row.id === service.id);
  if (!fixed || fixed.script !== service.script || JSON.stringify(fixed.args) !== JSON.stringify(service.args)) {
    throw new Error("HIDDEN_SERVICE_REFUSED");
  }
  // Fixed ID only; shared primitive returns launch success, not readiness.
  return require("./monitor-hidden-dispatch").launch(fixed.id, options);
}

function readPriorStatus(file = STATUS_FILE) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value?.schema === "monitor-set-watchdog-status/v1" && Array.isArray(value.services) ? value : null;
  } catch (_) {
    return null;
  }
}

function priorFor(priorStatus, id) {
  const prior = priorStatus?.services?.find((row) => row?.id === id);
  return {
    attempts: Number.isSafeInteger(prior?.attempts) && prior.attempts >= 0 ? Math.min(prior.attempts, MAX_ATTEMPTS) : 0,
    lastAttemptAt: typeof prior?.lastAttemptAt === "string" ? prior.lastAttemptAt : null,
    nextEligibleAt: typeof prior?.nextEligibleAt === "string" ? prior.nextEligibleAt : null,
  };
}

function serviceStatus(service, state, prior, fields = {}) {
  return {
    id: service.id,
    script: service.script,
    state,
    running: state === "running",
    missing: state !== "running",
    relaunched: state === "relaunched",
    failed: state === "failed",
    cooldown: state === "cooldown",
    attempts: prior.attempts,
    lastAttemptAt: prior.lastAttemptAt,
    nextEligibleAt: prior.nextEligibleAt,
    wouldRelaunch: false,
    reason: null,
    ...fields,
  };
}

function runWatchdog(options = {}) {
  const selectedManifest = options.manifest || manifest;
  const services = validateWatchdogManifest(selectedManifest);
  const forbidden = new Set(selectedManifest.forbiddenProcessScripts.map(normalizedScript));
  const apply = options.apply === true;
  const clock = options.clock || Date.now;
  const startedMs = clock();
  const maxWallMs = options.maxWallMs || MAX_WALL_CLOCK_MS;
  const maxRelaunches = options.maxRelaunches || MAX_RELAUNCHES_PER_PASS;
  const maxAttempts = options.maxAttempts || MAX_ATTEMPTS;
  const priorStatus = options.priorStatus === undefined ? readPriorStatus(options.statusFile) : options.priorStatus;
  const inspection = options.processRows
    ? { ok: true, rows: options.processRows }
    : (options.inspect || inspectProcesses)({ timeoutMs: Math.max(1, maxWallMs - (clock() - startedMs)) });
  const rows = inspection?.rows || [];
  const statuses = [];
  let launchSlotsUsed = 0;
  let wallClockCapped = false;

  for (const service of services) {
    const prior = priorFor(priorStatus, service.id);
    if (inspection?.ok !== true) {
      statuses.push(serviceStatus(service, "failed", prior, { reason: "process-inspection-failed" }));
      continue;
    }
    if (rows.some((row) => processHasScript(row, service.script, options.workspace || WORKSPACE))) {
      statuses.push(serviceStatus(service, "running", { attempts: 0, lastAttemptAt: null, nextEligibleAt: null }));
      continue;
    }
    if (forbidden.has(normalizedScript(service.script))) {
      statuses.push(serviceStatus(service, "failed", prior, { reason: "forbidden-script" }));
      continue;
    }
    if (prior.attempts >= maxAttempts) {
      statuses.push(serviceStatus(service, "failed", prior, { reason: "retry-limit" }));
      continue;
    }
    const nowMs = clock();
    const eligibleMs = Date.parse(prior.nextEligibleAt || "");
    if (Number.isFinite(eligibleMs) && eligibleMs > nowMs) {
      statuses.push(serviceStatus(service, "cooldown", prior, { reason: "backoff-active" }));
      continue;
    }
    if (nowMs - startedMs >= maxWallMs) {
      wallClockCapped = true;
      statuses.push(serviceStatus(service, "missing", prior, { reason: "wall-clock-cap" }));
      continue;
    }
    if (launchSlotsUsed >= maxRelaunches) {
      statuses.push(serviceStatus(service, "missing", prior, { reason: "pass-relaunch-cap" }));
      continue;
    }
    launchSlotsUsed += 1;
    if (!apply) {
      statuses.push(serviceStatus(service, "missing", prior, { wouldRelaunch: true, reason: "dry-run" }));
      continue;
    }
    const attemptAtMs = clock();
    const attempts = prior.attempts + 1;
    const cooldownMs = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * (2 ** Math.max(0, attempts - 1)));
    const next = {
      attempts,
      lastAttemptAt: new Date(attemptAtMs).toISOString(),
      nextEligibleAt: new Date(attemptAtMs + cooldownMs).toISOString(),
    };
    const remaining = Math.max(1, maxWallMs - (clock() - startedMs));
    let result;
    try {
      result = (options.spawn || launchService)(service, { timeoutMs: remaining });
    } catch (_) {
      result = { status: null };
    }
    if (result?.status === 0 && !result?.error) statuses.push(serviceStatus(service, "relaunched", next));
    else statuses.push(serviceStatus(service, "failed", next, { reason: attempts >= maxAttempts ? "retry-limit" : "launch-failed" }));
  }

  const summary = {
    total: statuses.length,
    running: statuses.filter((row) => row.running).length,
    missing: statuses.filter((row) => row.missing).length,
    relaunched: statuses.filter((row) => row.relaunched).length,
    failed: statuses.filter((row) => row.failed).length,
    cooldown: statuses.filter((row) => row.cooldown).length,
    wouldRelaunch: statuses.filter((row) => row.wouldRelaunch).length,
  };
  return {
    schema: "monitor-set-watchdog-status/v1",
    generatedAt: new Date(clock()).toISOString(),
    mode: apply ? "apply" : "check",
    inspection: inspection?.ok === true ? "ok" : "failed",
    wallClockCapped,
    limits: { maxRelaunchesPerPass: maxRelaunches, maxAttemptsPerService: maxAttempts, maxWallClockMs: maxWallMs },
    summary,
    services: statuses,
  };
}

function writeStatus(value, file = STATUS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
  }
}

function parseOptions(argv = process.argv.slice(2)) {
  if (argv.some((arg) => arg !== "--check" && arg !== "--apply") || (argv.includes("--check") && argv.includes("--apply"))) {
    throw new Error("use exactly one of --check or --apply");
  }
  return { apply: argv.includes("--apply") };
}

function watchdogExitCode(status) {
  if (!status || status.inspection !== "ok") return 1;
  return (status.summary?.failed || 0) > 0 ? 1 : 0;
}

function cli(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  const status = runWatchdog(options);
  writeStatus(status);
  const s = status.summary;
  process.stdout.write(`monitor-set-watchdog ${status.mode}: running=${s.running} missing=${s.missing} relaunched=${s.relaunched} failed=${s.failed} cooldown=${s.cooldown} would-relaunch=${s.wouldRelaunch}\n`);
  // A failed launch/inspection must not report task success. Failed services
  // (launch-failed, retry-limit, forbidden-script) now exit non-zero.
  process.exitCode = watchdogExitCode(status);
  return status;
}

if (require.main === module) {
  try {
    cli();
  } catch (_) {
    process.stderr.write("monitor-set-watchdog: failed closed\n");
    process.exitCode = 1;
  }
}

module.exports = {
  BASE_COOLDOWN_MS,
  MAX_ATTEMPTS,
  MAX_RELAUNCHES_PER_PASS,
  MAX_WALL_CLOCK_MS,
  STATUS_FILE,
  inspectProcesses,
  launchService,
  parseNodeInvocation,
  processHasScript,
  runWatchdog,
  scriptIdentityMatches,
  splitWindowsCommandLine,
  validateWatchdogManifest,
  watchdogExitCode,
  writeStatus,
};
