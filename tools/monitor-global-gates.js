#!/usr/bin/env node
// monitor-global-gates.js - read-only periodic safety gate refresher.
// Never reads keys, RPC inventory, or env files. It only runs sanitized
// artifact scanners and writes monitor status/log files.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { minimalMonitorEnv, forceMonitorOnlyArtifact, authorizationSafetySignals, sanitizeMonitorText, rememberAuthorizationSnapshot } = require("./monitor-minimal-env");

const WORKSPACE = path.resolve(__dirname, "..");
const STATUS_FILE = path.join(WORKSPACE, "reports", "monitor", "global-gates-status.json");
const LOG_FILE = path.join(WORKSPACE, "reports", "monitor", "global-gates-log.jsonl");
const ROUTE_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "route-positive-sweep.json");
const GATES_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "audit-completion-gates.json");
const APYUSD_PREFLIGHT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "apyusd-receipt-live-preflight.json");

const args = process.argv.slice(2);
const WATCH = args.includes("--watch");
const ONCE = args.includes("--once") || !WATCH;
const QUIET = args.includes("--quiet");
const INTERVAL_MS = Math.max(30_000, Number(argValue("--interval-ms") || process.env.GLOBAL_GATES_INTERVAL_MS || "300000") || 300_000);
const APYUSD_INTERVAL_MS = Math.max(60_000, Number(argValue("--apyusd-interval-ms") || process.env.GLOBAL_GATES_APYUSD_INTERVAL_MS || "1800000") || 1_800_000);

let lastApyusdRun = 0;

function argValue(name) {
  const prefix = `${name}=`;
  const item = args.find((arg) => arg.startsWith(prefix));
  if (item) return item.slice(prefix.length);
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
}

function ts() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function loadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, value, authorizationContext) {
  ensureDir(file);
  fs.writeFileSync(file, `${JSON.stringify(forceMonitorOnlyArtifact(value, authorizationContext), null, 2)}\n`);
}

function appendLog(value, authorizationContext) {
  ensureDir(LOG_FILE);
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(forceMonitorOnlyArtifact(value, authorizationContext))}\n`);
}

function asNumber(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function runNode(script, runArgs = []) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [script, ...runArgs], {
    cwd: WORKSPACE,
    env: minimalMonitorEnv(),
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    maxBuffer: 50 * 1024 * 1024,
  });
  return {
    script,
    args: runArgs,
    status: result.status,
    ok: result.status === 0,
    elapsedMs: Date.now() - startedAt,
  };
}

function summarizeApyusd(preflight, ranThisCycle, runResult) {
  const checks = preflight?.preflightChecks || {};
  const summary = preflight?.summary || {};
  const readOnlyPreflightPassed = summary.readOnlyPreflightPassed === true;
  return {
    ranThisCycle,
    runOk: runResult ? runResult.ok : null,
    status: sanitizeMonitorText(summary.status || (runResult && !runResult.ok ? "preflight-refresh-failed" : "preflight-not-run-this-cycle"), "evidence"),
    routeArtifactFresh: checks.routeArtifactFresh === true,
    forkProofFresh: checks.forkProofFresh === true,
    routePositive: checks.routePositive === true,
    forkPositive: checks.forkPositive === true,
    readOnlyPreflightPassed,
    failClosed: !readOnlyPreflightPassed,
    liveActionBlocked: true,
    signedActionJustified: false,
    nextAction: sanitizeMonitorText(summary.nextAction || "Keep apyUSD fail-closed until fresh exact route and fresh fork proof both pass; live action still requires explicit authorization.", "evidence"),
    artifact: path.relative(WORKSPACE, APYUSD_PREFLIGHT_FILE),
  };
}

function buildStatus(cycle, startedAt, results, apyusdRan, apyusdResult, artifacts = {}, options = {}) {
  const route = artifacts.route || loadJson(ROUTE_FILE, {});
  const gates = artifacts.gates || loadJson(GATES_FILE, {});
  const apyusdPreflight = artifacts.apyusdPreflight || loadJson(APYUSD_PREFLIGHT_FILE, {});
  const routeSummary = route.summary || {};
  const gatesSummary = gates.summary || {};
  const upstreamSafety = authorizationSafetySignals([route, gates], options);
  const authorization = upstreamSafety.liveBatchStatus;
  const upstreamAuthorizationSignal = upstreamSafety.observedUpstreamAuthorizationSignal === true;
  const authorizationApproved = authorization.authorizationState === "VALID";
  const routePositive = Math.max(asNumber(routeSummary.routePositive), asNumber(gatesSummary.routePositive));
  const gateRefreshOk = results.every((result) => result.ok);
  const apyusd = summarizeApyusd(apyusdPreflight, apyusdRan, apyusdResult);
  const hardStop = upstreamSafety.hardStop === true;
  const confirmationOk = gateRefreshOk && !hardStop;
  const status = !gateRefreshOk
    ? "refresh-error-fail-closed"
    : hardStop
      ? "hard-stop-upstream-authorization-signal"
      : routePositive > 0
        ? "watching-route-positive-fail-closed"
        : "watching-authorization-gates-closed";

  return rememberAuthorizationSnapshot({
    generatedAt: ts(),
    scanner: "tools/monitor-global-gates.js",
    scope: "Read-only periodic global route/completion gate monitor",
    cycle,
    startedAt,
    liveBatchStatus: authorization,
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      childScriptsAreReadOnlyArtifactRefresh: true,
      signedActionJustified: false,
      executableNow: false,
      executableNowCount: 0,
      upstreamAuthorizationSignal,
      observedInvalidAuthorizationSignal: upstreamSafety.observedInvalidAuthorizationSignal === true,
      authorizationState: authorization.authorizationState,
      authorizationApproved,
      hardStop,
    },
    config: {
      watch: WATCH,
      once: ONCE,
      intervalMs: INTERVAL_MS,
      apyusdIntervalMs: APYUSD_INTERVAL_MS,
    },
    summary: {
      status,
      gateRefreshOk,
      confirmationOk,
      routePositive,
      executableNow: false,
      executableNowCount: 0,
      signedActionJustified: false,
      upstreamAuthorizationSignal,
      observedInvalidAuthorizationSignal: upstreamSafety.observedInvalidAuthorizationSignal === true,
      authorizationState: authorization.authorizationState,
      authorizationApproved,
      hardStop,
      routeTopCandidate: routeSummary.topCandidate || null,
      routeTopStatus: sanitizeMonitorText(routeSummary.topStatus || null, "evidence"),
      completionStatus: sanitizeMonitorText(gatesSummary.status || null, "evidence"),
      completionNextAction: sanitizeMonitorText(gatesSummary.nextAction || null, "evidence"),
      nextAction: hardStop
        ? "Stop before live action. Require explicit authorization plus fresh staticCall/estimateGas/minProfit gates."
        : "Continue periodic refresh; keep apyUSD fail-closed unless fresh route and fork proof both pass.",
    },
    apyusd,
    childRuns: results,
    artifacts: {
      routeSweep: path.relative(WORKSPACE, ROUTE_FILE),
      completionGates: path.relative(WORKSPACE, GATES_FILE),
      apyusdPreflight: path.relative(WORKSPACE, APYUSD_PREFLIGHT_FILE),
      status: path.relative(WORKSPACE, STATUS_FILE),
      log: path.relative(WORKSPACE, LOG_FILE),
    },
  }, upstreamSafety);
}

async function runCycle(cycle, startedAt) {
  const results = [];
  results.push(runNode(path.join("tools", "scan-route-positive-sweep.js"), ["--quiet"]));
  results.push(runNode(path.join("tools", "scan-audit-completion-gates.js"), ["--quiet"]));

  const shouldRunApyusd = Date.now() - lastApyusdRun >= APYUSD_INTERVAL_MS || cycle === 1;
  let apyusdResult = null;
  if (shouldRunApyusd) {
    lastApyusdRun = Date.now();
    apyusdResult = runNode(path.join("tools", "preflight-apyusd-receipt-route.js"));
    results.push(apyusdResult);
  }

  const status = buildStatus(cycle, startedAt, results, shouldRunApyusd, apyusdResult);
  writeJson(STATUS_FILE, status, status);
  appendLog({
    generatedAt: status.generatedAt,
    cycle,
    status: status.summary.status,
    confirmationOk: status.summary.confirmationOk,
    routePositive: status.summary.routePositive,
    executableNow: status.summary.executableNow,
    signedActionJustified: status.summary.signedActionJustified,
    upstreamAuthorizationSignal: status.summary.upstreamAuthorizationSignal,
    authorizationState: status.summary.authorizationState,
    hardStop: status.summary.hardStop,
    apyusdStatus: status.apyusd.status,
    apyusdFailClosed: status.apyusd.failClosed,
  }, status);

  if (!QUIET || status.summary.hardStop || !status.summary.gateRefreshOk) {
    console.log(`[GLOBAL-GATES cycle=${cycle}] status=${sanitizeMonitorText(status.summary.status, "evidence")} routePositive=${status.summary.routePositive} executableNow=${status.summary.executableNow} signedActionJustified=${status.summary.signedActionJustified} apyusd=${sanitizeMonitorText(status.apyusd.status, "evidence")} failClosed=${status.apyusd.failClosed}`);
  }

  if (status.summary.hardStop) process.exitCode = 2;
  if (!status.summary.gateRefreshOk && !status.summary.hardStop) process.exitCode = 1;
  return status;
}

async function main() {
  const startedAt = ts();
  let cycle = 0;
  do {
    cycle += 1;
    await runCycle(cycle, startedAt);
    if (ONCE) break;
    await sleep(INTERVAL_MS);
  } while (true);
}

if (require.main === module) main().catch((err) => {
  const status = {
    generatedAt: ts(),
    scanner: "tools/monitor-global-gates.js",
    scope: "Read-only periodic global route/completion gate monitor",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      executableNow: false,
      executableNowCount: 0,
      signedActionJustified: false,
      upstreamAuthorizationSignal: false,
      hardStop: true,
    },
    summary: {
      status: "fatal-refresh-error-fail-closed",
      gateRefreshOk: false,
      confirmationOk: false,
      executableNow: false,
      executableNowCount: 0,
      signedActionJustified: false,
      upstreamAuthorizationSignal: false,
      hardStop: true,
      error: "MONITOR_FATAL_FAILURE",
    },
  };
  writeJson(STATUS_FILE, status, status);
  appendLog(status.summary, status);
  console.error("monitor-global-gates failed: MONITOR_FATAL_FAILURE");
  process.exitCode = 1;
});

module.exports = { buildStatus, summarizeApyusd, runNode };
