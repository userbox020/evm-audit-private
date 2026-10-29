#!/usr/bin/env node
"use strict";

// refresh-novelty-patterns.js — bounded sequential refresher for the seven novelty-pattern scanners
// whose artifacts feed the `novelty-patterns` condition and the `fresh-noveltyState` health gate.
//
// WHY THIS EXISTS: the condition reads seven artifacts under a 24 h freshness window, but nothing in
// the monitor set invokes the scanners. They were refreshed by hand; without a refresher the
// condition-level gate permanently reds out once they age past 24 h. This runner is registered as a
// standalone scheduled task (see tools/manage-novelty-refresh-task.ps1) every 6 h — well under 24 h.
//
// DESIGN:
//   * SEQUENTIAL: one scanner at a time, so a scan never contends with the read-only monitor set or
//     with itself; measured total runtime is ~2.3 min for all seven.
//   * BOUNDED: each scanner gets its own hard timeout. A hung scanner is killed and the remaining
//     scanners still run — one broken scanner must not deny the other six their refresh.
//   * READ-ONLY / KEYLESS / ARGUMENT-FREE: every scanner is invoked with no arguments and takes no
//     signing, transaction, or state-changing path. Endpoint material stays process-only: this
//     runner never reads, prints, logs, or persists endpoint values, credentials, or tokens. Scanner
//     stdout/stderr is deliberately NOT surfaced (only byte counts), because a failing RPC scanner
//     could otherwise echo endpoint material into a log.
//
// EXIT CODE: 0 only when every scanner process exited 0 and every resulting artifact is fresh.
// A non-zero exit is informational for the scheduled task's last-result and never un-does a refresh
// already performed by the scanners that succeeded.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("node:child_process");

const { readArtifactFile, ARTIFACT_STATUS } = require("./monitor-artifact-policy");

const WORKSPACE = path.resolve(__dirname, "..");
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_AGE_MS = 24 * 3600_000;
const TIME_FIELDS = ["generatedAt", "scannedAt"];

// Order is stable and matches the condition's NOVELTY_PATTERN_ARTIFACTS group keys.
const SCANNERS = Object.freeze([
  { name: "pull-oracle-timing", script: "tools/scan-pull-oracle-timing.js", artifact: "reports/raw/fast/pull-oracle-timing.json" },
  { name: "cross-market-manipulation", script: "tools/scan-cross-market-manipulation.js", artifact: "reports/raw/fast/cross-market-manipulation.json" },
  { name: "blockc-combined", script: "tools/scan-blockc-combined.js", artifact: "reports/raw/fast/blockc-combined.json" },
  { name: "insurance-fund-drain", script: "tools/scan-insurance-fund-drain.js", artifact: "reports/raw/fast/insurance-fund-drain.json" },
  { name: "router-approval-drain", script: "tools/scan-router-approval-drain.js", artifact: "reports/raw/fast/router-approval-drain.json" },
  { name: "pendle-pt-mispricing", script: "tools/scan-pendle-pt-mispricing.js", artifact: "reports/raw/fast/pendle-pt-mispricing.json" },
  { name: "storage-layout-regression", script: "tools/scan-storage-layout-regression.js", artifact: "reports/raw/fast/storage-layout-regression.json" },
]);

// Sanitized child environment: never forward NODE_OPTIONS/NODE_PATH from an inherited shell.
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return env;
}

function scannerInvocation(scanner) {
  return {
    command: process.execPath,
    args: [path.join(WORKSPACE, ...scanner.script.split("/"))],
  };
}

function runScanner(scanner, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  let result;
  try {
    result = spawnSync(scannerInvocation(scanner).command, scannerInvocation(scanner).args, {
      cwd: WORKSPACE,
      env: options.env || childEnv(),
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      name: scanner.name,
      script: scanner.script,
      artifact: scanner.artifact,
      spawned: false,
      exitCode: null,
      timedOut: false,
      processOk: false,
      durationMs: Date.now() - startedAt,
      stdoutBytes: 0,
      stderrBytes: 0,
      error: "spawn-failed",
    };
  }
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM" && result.status === null;
  return {
    name: scanner.name,
    script: scanner.script,
    artifact: scanner.artifact,
    spawned: true,
    exitCode: Number.isInteger(result.status) ? result.status : null,
    timedOut,
    processOk: !timedOut && result.status === 0 && !result.error,
    durationMs: Date.now() - startedAt,
    // Content is never surfaced; only bounded sizes, so endpoint material cannot leak.
    stdoutBytes: Buffer.isBuffer(result.stdout) ? result.stdout.length : 0,
    stderrBytes: Buffer.isBuffer(result.stderr) ? result.stderr.length : 0,
    error: timedOut ? "timeout" : result.error ? "spawn-error" : null,
  };
}

function assessArtifact(scanner, nowMs, options = {}) {
  const file = path.join(options.workspace || WORKSPACE, ...scanner.artifact.split("/"));
  if (!fs.existsSync(file)) {
    return { status: ARTIFACT_STATUS.MISSING, fresh: false, generatedAt: null, ageMinutes: null };
  }
  const policy = readArtifactFile(file, {
    nowMs,
    maxAgeMs: options.maxAgeMs || MAX_AGE_MS,
    maxFutureSkewMs: 5 * 60_000,
    timestampFields: TIME_FIELDS,
  });
  return {
    status: policy.status,
    fresh: policy.status === ARTIFACT_STATUS.VALID_FRESH,
    generatedAt: policy.generatedAt || null,
    ageMinutes: Number.isFinite(policy.ageMs) ? Math.round((policy.ageMs / 60_000) * 100) / 100 : null,
  };
}

function refresh(options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const log = options.log || ((line) => process.stdout.write(`${line}\n`));
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  const scanners = [];
  for (const scanner of SCANNERS) {
    const outcome = runScanner(scanner, { timeoutMs, env: options.env });
    const artifact = assessArtifact(scanner, Date.now(), options);
    const row = { ...outcome, artifactStatus: artifact.status, artifactFresh: artifact.fresh, artifactGeneratedAt: artifact.generatedAt, artifactAgeMinutes: artifact.ageMinutes };
    scanners.push(row);
    log(`[novelty-refresh] ${row.name}: process=${row.processOk ? "ok" : "FAIL"}${row.timedOut ? " (timeout)" : ""} ` +
      `exit=${row.exitCode} ${row.durationMs}ms | artifact=${row.artifactStatus} age=${row.artifactAgeMinutes ?? "n/a"}min`);
  }

  const failures = scanners.filter((row) => !row.processOk);
  const stale = scanners.filter((row) => !row.artifactFresh);
  const summary = {
    total: scanners.length,
    processOk: scanners.length - failures.length,
    artifactFresh: scanners.length - stale.length,
    failedScanners: failures.map((row) => row.name),
    staleArtifacts: stale.map((row) => row.name),
  };
  const ok = failures.length === 0 && stale.length === 0;
  const report = {
    schema: "novelty-pattern-refresh/v1",
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedMs,
    timeoutMs,
    maxAgeMinutes: MAX_AGE_MS / 60_000,
    scanners,
    summary,
    ok,
  };

  if (options.printReport !== false) log(`${JSON.stringify(report)}`);
  return report;
}

function cli() {
  const report = refresh();
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) cli();

module.exports = { SCANNERS, DEFAULT_TIMEOUT_MS, MAX_AGE_MS, TIME_FIELDS, runScanner, assessArtifact, refresh, childEnv };
