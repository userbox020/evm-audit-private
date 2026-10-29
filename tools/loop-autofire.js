#!/usr/bin/env node
"use strict";

// loop-autofire.js
//
// Standing loop wrapper (dual-mode, --once default / --loop N) that TIMES
// invocations of the fix-27 runner tools/execute-euler-evk-autofire.js. It is
// NOT the signing authority and owns NO execution authority of its own: the
// runner owns the fail-closed gate ladder, the key read, the caps and the single
// signed fire (coordination/live-execution-batch-euler-autofire.json,
// batchId euler-autofire-20261013-01, signedExecutionsTotal 1).
//
// Per cycle (at most ONE runner invocation — the bounded per-cycle budget):
//   1. Read reports/raw/fast/euler-fastlane-status.json (schema
//      euler-fastlane-watch/v1). Fail closed when the artifact is missing /
//      invalid / older than --max-age-ms (default 180s, mirroring the runner's
//      (D3) fastlane cap): verdict SKIP_EVIDENCE_* / SKIP_STALE_EVIDENCE and NO
//      spawn (this is the stale-suppression: the loop never spams refusals on a
//      dead evidence lane).
//   2. If the artifact is fresh AND firedDecision === "win-probable", spawn
//      `node tools/execute-euler-evk-autofire.js --execute` once, as a bounded
//      child_process. The loop does not chase the child's RPC or text internals:
//      it records the child's stdout tail (bounded, sanitized) plus exit code and
//      classifies the outcome honestly (SIGNED / REFUSED / UNKNOWN). A child
//      timeout is recorded as half-open (UNKNOWN) — never as a fire, never as a
//      clean refusal.
//   3. If firedDecision is anything else -> SKIP_NOT_WIN_PROBABLE, no spawn.
//
// The loop also OBSERVES the runner's own fire records
// (reports/raw/fast/euler-autofire-out/fire-*.json) to avoid re-spawning once the
// one-fire budget is consumed: that is a read-only observation of the runner's
// D7 budget lock, not a cap the loop introduces (SKIP_FIRE_CAP_CONSUMED).
//
// --loop N repeats --once every N seconds until the canary-loop-window deadline
// convention is honored: the loop reuses the SAME convention as the
// silo-defaulting lane (tools/watch-silo-defaulting.js resolveDeadline) — an
// explicit batch expiry first (coordination/live-execution-batch-euler-autofire.json
// :expiresAt), else a documented DEFAULT_DEADLINE_DAYS window from start.
//
// Safety: the loop NEVER signs, NEVER broadcasts, NEVER reads keys, and edits no
// tool / envelope. Key bytes and endpoint values are never printed or persisted.
// The embedded safety block records noSigningByLoop / noKeysByLoop.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { forceMonitorOnlyArtifact, minimalMonitorEnv } = require("./monitor-minimal-env");

const WORKSPACE = path.resolve(__dirname, "..");
const FASTLANE = path.join(WORKSPACE, "reports", "raw", "fast", "euler-fastlane-status.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "autofire-loop-status.json");
const BATCH = path.join(WORKSPACE, "coordination", "live-execution-batch-euler-autofire.json");
const OUTDIR = path.join(WORKSPACE, "reports", "raw", "fast", "euler-autofire-out");
const RUNNER = "tools/execute-euler-evk-autofire.js";

const SCHEMA = "autofire-loop/v1";
const FASTLANE_SCHEMA = "euler-fastlane-watch/v1";
const SCANNER = "tools/loop-autofire.js";
const RUNNER_ARTIFACT_SCHEMA = "euler-autofire-out/v1";

// Mirror of the runner's (D3) fastlane freshness cap; the loop uses it only to
// decide whether the evidence lane can seed a candidate — it does not invalidate
// the verdict.
const FRESH_FASTLANE_MS = 180 * 1000;
const MAX_FASTLANE_AGE_MS_MAX = 3600 * 1000;
const CHILD_TIMEOUT_MS_DEFAULT = 10 * 60 * 1000;   // bounded child invocation
const CHILD_TIMEOUT_MS_MAX = 30 * 60 * 1000;
const STDOUT_TAIL_BYTES = 8 * 1024;                // honest, bounded stdout tail
const STDERR_TAIL_BYTES = 2 * 1024;

// Canary-loop-window convention (identical to tools/watch-silo-defaulting.js).
const DEFAULT_DEADLINE_DAYS = 7;
const DEFAULT_DEADLINE_DAYS_MAX = 30;
const LOOP_MIN_SECONDS = 30;
const LOOP_MAX_SECONDS = 3600;
const DEFAULT_LOOP_SECONDS = 60;

const WIN_PROBABLE = "win-probable";
const VERDICT = Object.freeze({
  SIGNED: "SIGNED",
  REFUSED: "REFUSED",
  SKIP_MISSING: "SKIP_EVIDENCE_MISSING",
  SKIP_INVALID: "SKIP_EVIDENCE_INVALID",
  SKIP_UNDATED: "SKIP_EVIDENCE_UNDATED",
  SKIP_STALE: "SKIP_STALE_EVIDENCE",
  SKIP_NOT_WIN_PROBABLE: "SKIP_NOT_WIN_PROBABLE",
  SKIP_FIRE_CAP_CONSUMED: "SKIP_FIRE_CAP_CONSUMED",
  SKIP_DEADLINE: "SKIP_DEADLINE_REACHED",
  UNKNOWN_TIMEOUT: "UNKNOWN_TIMEOUT",
  UNKNOWN: "UNKNOWN",
});

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) { return fallback; }
}

function readJsonResult(file) {
  try {
    if (!fs.existsSync(file)) return { present: false, ok: false, value: null };
    return { present: true, ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (_) { return { present: true, ok: false, value: null }; }
}

function argValue(args, name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
}

function finitePositive(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function toNum(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }

// Never emit an endpoint or a 64-hex blob (a private key is exactly this shape).
function sanitizeText(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/0x[0-9a-fA-F]{64}/g, "<64hex>")
    .replace(/[0-9a-fA-F]{64}/g, "<64hex>")
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, "<url>")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
}

function tailOf(text, limit) {
  return typeof text === "string" ? text.slice(-limit) : "";
}

// Locate the runner's JSON payload anywhere in the received stdout (compact
// fail()/success lines, pretty-printed refuse() blobs). Best-effort but honest:
// null means "not classifiable", never a fabricated outcome.
function parseChildStdout(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  const candidates = [text];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length) candidates.push(lines[lines.length - 1]);
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch (_) { /* try the next candidate */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// fastlane evidence (fail closed)
// ---------------------------------------------------------------------------
function readFastlane(maxAgeMs = FRESH_FASTLANE_MS) {
  const r = readJsonResult(FASTLANE);
  if (!r.present) {
    return { present: false, fresh: false, status: VERDICT.SKIP_MISSING, reason: "fastlane-evidence-missing", scannedAt: null, ageMs: null, artifact: null };
  }
  if (!r.ok || !r.value || typeof r.value !== "object") {
    return { present: true, fresh: false, status: VERDICT.SKIP_INVALID, reason: "fastlane-evidence-unreadable", scannedAt: null, ageMs: null, artifact: null };
  }
  const a = r.value;
  if (a.schema && a.schema !== FASTLANE_SCHEMA) {
    return { present: true, fresh: false, status: VERDICT.SKIP_INVALID, reason: "fastlane-schema-mismatch", scannedAt: null, ageMs: null, artifact: a };
  }
  const parsedAt = Date.parse(typeof a.scannedAt === "string" ? a.scannedAt : "");
  if (!Number.isFinite(parsedAt)) {
    return { present: true, fresh: false, status: VERDICT.SKIP_UNDATED, reason: "fastlane-scannedAt-unparseable", scannedAt: null, ageMs: null, artifact: a };
  }
  const ageMs = Date.now() - parsedAt;
  const fresh = ageMs <= maxAgeMs;
  const ds = a.decisionSummary || {};
  return {
    present: true,
    ok: true,
    fresh,
    status: fresh ? "OK" : VERDICT.SKIP_STALE,
    reason: fresh ? null : "fastlane-evidence-stale",
    scannedAt: a.scannedAt,
    ageMs,
    maxAgeMs,
    artifact: a,
    firedDecision: typeof a.firedDecision === "string" ? a.firedDecision : null,
    winProbable: toNum(ds.winProbable),
    candidateCount: Array.isArray(a.verdicts) ? a.verdicts.filter((row) => row && row.decision === WIN_PROBABLE).length : null,
  };
}

// ---------------------------------------------------------------------------
// observational budget lock (read-only mirror of the runner's D7)
// ---------------------------------------------------------------------------
function readFireRecords() {
  try {
    if (!fs.existsSync(OUTDIR)) return [];
    const records = [];
    for (const name of fs.readdirSync(OUTDIR)) {
      if (!/\.json$/i.test(name) || /\.executor\.json$/i.test(name)) continue;
      const r = readJsonResult(path.join(OUTDIR, name));
      if (r.ok && r.value && r.value.schema === RUNNER_ARTIFACT_SCHEMA) records.push(r.value);
    }
    return records;
  } catch (_) { return []; }
}

function readBudgetLock(batch) {
  const b = batch || readJson(BATCH, null);
  const batchId = b && b.batchId ? b.batchId : null;
  const total = Number(b && b.caps ? (b.caps.signedExecutionsTotal ?? 1) : 1);
  const perDay = Number(b && b.caps ? (b.caps.signedExecutionsPerDay ?? 1) : 1);
  const signed = readFireRecords().filter((f) => f && f.signed === true && (batchId === null || f.batchId === batchId));
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = signed.filter((f) => typeof f.generatedAt === "string" && f.generatedAt.slice(0, 10) === today).length;
  const consumed = signed.length >= total || todayCount >= perDay;
  return {
    consumed,
    fired: signed.length,
    total,
    perDay,
    todayCount,
    batchId,
    expiresAt: b && typeof b.expiresAt === "string" ? b.expiresAt : null,
    note: "read-only observation of the runner's own fire records; the loop introduces no cap and grants no authority",
  };
}

// ---------------------------------------------------------------------------
// deadline (canary-loop-window convention)
// ---------------------------------------------------------------------------
function asIsoOrNull(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function resolveDeadline(options, startedMs) {
  const days = finitePositive(options.deadlineDays, DEFAULT_DEADLINE_DAYS, DEFAULT_DEADLINE_DAYS_MAX);
  const batch = readJson(BATCH, null);
  const batchExpires = batch ? asIsoOrNull(batch.expiresAt) : null;
  if (batchExpires) {
    return {
      source: "coordination/live-execution-batch-euler-autofire.json:expiresAt",
      expiresAt: batchExpires,
      expiresMs: Date.parse(batchExpires),
      defaultDays: days,
    };
  }
  const defaultMs = startedMs + days * 24 * 60 * 60 * 1000;
  return { source: "default-window", expiresAt: new Date(defaultMs).toISOString(), expiresMs: defaultMs, defaultDays: days };
}

// ---------------------------------------------------------------------------
// child invocation (bounded; the runner is the signing authority)
// ---------------------------------------------------------------------------
function deriveBudgetUsed(stdout, lock) {
  const text = String(stdout || "");
  const firedMatch = text.match(/fired=(\d+)\/(\d+)/);
  const spentMatch = text.match(/spent=(\d+)/);
  const observedFired = spentMatch ? Number(spentMatch[1]) : (firedMatch ? Number(firedMatch[1]) : null);
  const observedTotal = firedMatch ? Number(firedMatch[2]) : (lock ? lock.total : null);
  const visible = observedFired !== null;
  return {
    visible,
    observedFired,
    observedTotal,
    source: visible ? "child-stdout" : (lock ? "fire-records-observation" : "none"),
    lockConsumed: lock ? lock.consumed : null,
    note: visible
      ? "fired/total parsed from the runner's received text (best-effort; honest when absent)"
      : "the runner did not emit fired/total text; only the observational fire-record lock is available",
  };
}

function spawnRunner(options) {
  const startedAt = Date.now();
  let result;
  try {
    result = spawnSync(process.execPath, [RUNNER, "--execute"], {
      cwd: WORKSPACE,
      encoding: "utf8",
      timeout: options.childTimeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: minimalMonitorEnv(process.env),
    });
  } catch (error) {
    return { decision: "UNKNOWN", verdict: VERDICT.UNKNOWN, gateLadder: null, exitCode: null, oneShotOutcome: null, stdoutTail: "", stderrTail: "", elapsedMs: Date.now() - startedAt, note: `child-spawn-failed:${String((error && error.code) || "unknown")}`, timedOut: false };
  }

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const exitCode = typeof result.status === "number" ? result.status : null;
  const timedOut = !!(result.error && result.error.code === "ETIMEDOUT") || result.signal === "SIGTERM";
  const parsed = parseChildStdout(stdout);

  const attempt = {
    verdict: VERDICT.UNKNOWN,
    decision: "UNKNOWN",
    gateLadder: null,
    exitCode,
    oneShotOutcome: null,
    stdoutTail: sanitizeText(tailOf(stdout, STDOUT_TAIL_BYTES)),
    stderrTail: sanitizeText(tailOf(stderr, STDERR_TAIL_BYTES)),
    elapsedMs: Date.now() - startedAt,
    note: null,
    timedOut,
    rawStdout: stdout,
  };

  if (timedOut) {
    attempt.verdict = VERDICT.UNKNOWN_TIMEOUT;
    attempt.note = "child timed out (half-open): the runner may or may not have signed; inspect reports/raw/fast/euler-autofire-out fire-*.json before any further action";
    return attempt;
  }
  if (parsed) {
    attempt.gateLadder = Array.isArray(parsed.gates)
      ? parsed.gates.map((g) => ({ id: g && g.id, status: g && g.status, detail: g && g.detail }))
      : null;
    if (typeof parsed.oneShotOutcome === "string") attempt.oneShotOutcome = parsed.oneShotOutcome;
    if (parsed.stage === "SENT") {
      attempt.decision = "SIGNED";
      attempt.verdict = VERDICT.SIGNED;
      attempt.note = `runner sent a signed fire (exit=${exitCode} outcome=${attempt.oneShotOutcome || "unknown"})`;
    } else if (parsed.ok === false) {
      attempt.decision = "REFUSED";
      attempt.verdict = VERDICT.REFUSED;
      attempt.note = `runner refused honestly: ${typeof parsed.reason === "string" ? parsed.reason : "unknown"}`;
    } else {
      attempt.note = `runner stdout not classifiable (exit=${exitCode})`;
    }
    return attempt;
  }
  attempt.note = `child stdout not classifiable (exit=${exitCode}${result.error ? `, error=${String(result.error.code || "spawn-error")}` : ""})`;
  return attempt;
}

function skipAttempt(reason, lock) {
  return {
    gateLadder: null,
    decision: "SKIPPED",
    exitCode: null,
    oneShotOutcome: null,
    stdoutTail: "",
    stderrTail: "",
    elapsedMs: null,
    note: reason,
    budgetUsed: lock
      ? { visible: false, observedFired: lock.fired, observedTotal: lock.total, source: "fire-records-observation", lockConsumed: lock.consumed, note: "no child spawned this cycle" }
      : { visible: false, observedFired: null, observedTotal: null, source: "none", lockConsumed: null, note: "no child spawned this cycle" },
  };
}

// ---------------------------------------------------------------------------
// one cycle
// ---------------------------------------------------------------------------
function runCycle(context) {
  const { cycle, options, startedMs, deadline, batch } = context;
  const generatedAt = new Date().toISOString();
  const fastlane = readFastlane(options.maxFastlaneAgeMs);
  const lock = readBudgetLock(batch);

  let verdict;
  let attemptResult;

  if (!fastlane.present) {
    verdict = VERDICT.SKIP_MISSING;
    attemptResult = skipAttempt("fastlane-status artifact missing; no spawn", lock);
  } else if (fastlane.status === VERDICT.SKIP_INVALID) {
    verdict = VERDICT.SKIP_INVALID;
    attemptResult = skipAttempt("fastlane-status artifact unreadable/schema-mismatch; no spawn", lock);
  } else if (fastlane.status === VERDICT.SKIP_UNDATED) {
    verdict = VERDICT.SKIP_UNDATED;
    attemptResult = skipAttempt("fastlane scannedAt unparseable; no spawn", lock);
  } else if (!fastlane.fresh) {
    verdict = VERDICT.SKIP_STALE;
    attemptResult = skipAttempt(`fastlane stale:${Math.round((fastlane.ageMs || 0) / 1000)}s>${options.maxFastlaneAgeMs / 1000}s; no spawn (stale-suppression)`, lock);
  } else if (fastlane.firedDecision !== WIN_PROBABLE) {
    verdict = VERDICT.SKIP_NOT_WIN_PROBABLE;
    attemptResult = skipAttempt(`firedDecision=${fastlane.firedDecision === null ? "null" : fastlane.firedDecision}; no spawn`, lock);
  } else if (lock.consumed) {
    verdict = VERDICT.SKIP_FIRE_CAP_CONSUMED;
    attemptResult = skipAttempt(`signed-fire budget consumed (fired=${lock.fired}/${lock.total}); no spawn`, lock);
  } else {
    const spawned = spawnRunner(options);
    verdict = spawned.verdict;
    attemptResult = {
      gateLadder: spawned.gateLadder,
      decision: spawned.decision,
      budgetUsed: deriveBudgetUsed(spawned.rawStdout, lock),
      exitCode: spawned.exitCode,
      oneShotOutcome: spawned.oneShotOutcome,
      stdoutTail: spawned.stdoutTail,
      stderrTail: spawned.stderrTail,
      elapsedMs: spawned.elapsedMs,
      note: spawned.note,
    };
  }

  return {
    schema: SCHEMA,
    generatedAt,
    scannedAt: generatedAt,
    scanner: SCANNER,
    scope: "Standing loop timer over the fix-27 auto-fire runner; the runner owns the fail-closed ladder and the single signed fire",
    mode: options.once ? "once" : "loop",
    cycle,
    startedAt: new Date(startedMs).toISOString(),
    ok: true,
    verdict,
    fastlane: {
      artifact: "reports/raw/fast/euler-fastlane-status.json",
      present: fastlane.present,
      fresh: fastlane.fresh,
      status: fastlane.status,
      scannedAt: fastlane.scannedAt,
      ageMs: fastlane.ageMs === undefined ? null : fastlane.ageMs,
      maxAgeMs: options.maxFastlaneAgeMs,
      schema: fastlane.artifact ? (fastlane.artifact.schema || null) : null,
      firedDecision: fastlane.firedDecision === undefined ? null : fastlane.firedDecision,
      winProbable: fastlane.winProbable === undefined ? null : fastlane.winProbable,
      candidateCount: fastlane.candidateCount === undefined ? null : fastlane.candidateCount,
      reason: fastlane.reason === undefined ? null : fastlane.reason,
    },
    attemptResult,
    budget: {
      consumed: lock.consumed,
      fired: lock.fired,
      total: lock.total,
      perDay: lock.perDay,
      todayCount: lock.todayCount,
      batchId: lock.batchId,
      batchExpiresAt: lock.expiresAt,
      source: "reports/raw/fast/euler-autofire-out/fire-*.json (runner D7 budget lock; read-only observation)",
      note: lock.note,
    },
    deadline: {
      source: deadline.source,
      expiresAt: deadline.expiresAt,
      remainingMs: Math.max(0, deadline.expiresMs - Date.now()),
      defaultDays: deadline.defaultDays,
      convention: "canary-loop-window: euler-autofire batch expiry, else DEFAULT_DEADLINE_DAYS (same convention as tools/watch-silo-defaulting.js)",
    },
    config: {
      loopSeconds: options.loopSeconds,
      maxRuns: options.maxRuns,
      childTimeoutMs: options.childTimeoutMs,
      maxFastlaneAgeMs: options.maxFastlaneAgeMs,
      perCycleInvocations: 1,
    },
    producer_health: {
      fastlanePresent: fastlane.present,
      fastlaneFresh: fastlane.fresh,
      fastlaneAgeMs: fastlane.ageMs === undefined ? null : fastlane.ageMs,
      firedDecision: fastlane.firedDecision === undefined ? null : fastlane.firedDecision,
      verdict,
      failClosed: true,
    },
    safety: {
      noSigningByLoop: true,
      noKeysByLoop: true,
      signsNothing: true,
      broadcastNothing: true,
      spawnsRunnerOnce: true,
      endpointValuesPersisted: false,
      privateKeysRead: false,
      editsNoTools: true,
      note: "the loop only times invocations of tools/execute-euler-evk-autofire.js --execute; the runner is the sole signing authority",
    },
  };
}

// ---------------------------------------------------------------------------
// persistence / reporting
// ---------------------------------------------------------------------------
function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) { /* already renamed */ }
  }
}

function persist(status, out) {
  let safe;
  try { safe = forceMonitorOnlyArtifact(status); } catch (_) { safe = status; }
  atomicWriteJson(out || OUT, safe);
}

function printStatus(status, quiet) {
  process.stdout.write(
    `[AUTOFIRE-LOOP cycle=${status.cycle}] verdict=${status.verdict} `
    + `fastlane=${status.fastlane.fresh ? "fresh" : "not-fresh"} ageMs=${status.fastlane.ageMs ?? "n/a"} `
    + `decision=${status.attemptResult.decision} fired=${status.budget.fired}/${status.budget.total}`
    + `${status.attemptResult.note ? ` note=${status.attemptResult.note}` : ""}\n`,
  );
  if (quiet) return;
  if (status.attemptResult.stdoutTail) process.stdout.write(`  stdoutTail=${status.attemptResult.stdoutTail}\n`);
}

// ---------------------------------------------------------------------------
// arguments + main
// ---------------------------------------------------------------------------
function parseArgs(args) {
  const once = args.includes("--once") || !args.includes("--loop");
  const quiet = args.includes("--quiet");
  const loopSeconds = args.includes("--loop")
    ? Math.min(LOOP_MAX_SECONDS, Math.max(LOOP_MIN_SECONDS, Number(argValue(args, "--loop") || DEFAULT_LOOP_SECONDS) || DEFAULT_LOOP_SECONDS))
    : DEFAULT_LOOP_SECONDS;
  const maxRunsRaw = argValue(args, "--max-runs");
  const maxRuns = maxRunsRaw !== null ? Math.max(1, Number(maxRunsRaw) || 1) : Number.MAX_SAFE_INTEGER;
  const maxFastlaneAgeMs = finitePositive(argValue(args, "--max-age-ms"), FRESH_FASTLANE_MS, MAX_FASTLANE_AGE_MS_MAX);
  const childTimeoutMs = finitePositive(argValue(args, "--child-timeout-ms"), CHILD_TIMEOUT_MS_DEFAULT, CHILD_TIMEOUT_MS_MAX);
  const deadlineDays = finitePositive(argValue(args, "--deadline-days"), DEFAULT_DEADLINE_DAYS, DEFAULT_DEADLINE_DAYS_MAX);
  const out = argValue(args, "--out") || OUT;
  return { once, quiet, loopSeconds, maxRuns, maxFastlaneAgeMs, childTimeoutMs, deadlineDays, out };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const startedMs = Date.now();
  const deadline = resolveDeadline(options, startedMs);
  const batch = readJson(BATCH, null);
  const out = path.resolve(options.out);

  if (!options.quiet) {
    process.stdout.write("Auto-fire loop timer (runner owns signing; loop owns nothing)\n");
    process.stdout.write(`mode=${options.once ? "once" : "loop"} loopSeconds=${options.loopSeconds} maxFastlaneAgeMs=${options.maxFastlaneAgeMs} deadline=${deadline.source}@${deadline.expiresAt}\n`);
    process.stdout.write("Safety: the loop never signs, never broadcasts, never reads keys; endpoints/keys are never stored.\n");
  }

  let finalStatus = null;
  for (let cycle = 1; cycle <= options.maxRuns; cycle += 1) {
    if (!options.once && Date.now() >= deadline.expiresMs) {
      const deadlineStatus = {
        schema: SCHEMA, generatedAt: new Date().toISOString(), scannedAt: new Date().toISOString(), scanner: SCANNER,
        mode: "loop", cycle, startedAt: new Date(startedMs).toISOString(), ok: true, verdict: VERDICT.SKIP_DEADLINE,
        fastlane: { artifact: "reports/raw/fast/euler-fastlane-status.json", present: false, fresh: false, status: VERDICT.SKIP_DEADLINE, scannedAt: null, ageMs: null, maxAgeMs: options.maxFastlaneAgeMs, schema: null, firedDecision: null, winProbable: null, candidateCount: null, reason: "deadline-reached" },
        attemptResult: skipAttempt("canary-loop-window deadline reached; no spawn", null),
        budget: { consumed: null, fired: null, total: null, perDay: null, todayCount: null, batchId: batch && batch.batchId ? batch.batchId : null, batchExpiresAt: deadline.expiresAt, source: "n/a", note: "deadline reached" },
        deadline: { source: deadline.source, expiresAt: deadline.expiresAt, remainingMs: 0, defaultDays: deadline.defaultDays, convention: "canary-loop-window" },
        config: { loopSeconds: options.loopSeconds, maxRuns: options.maxRuns, childTimeoutMs: options.childTimeoutMs, maxFastlaneAgeMs: options.maxFastlaneAgeMs, perCycleInvocations: 1 },
        producer_health: { fastlanePresent: false, fastlaneFresh: false, fastlaneAgeMs: null, firedDecision: null, verdict: VERDICT.SKIP_DEADLINE, failClosed: true },
        safety: { noSigningByLoop: true, noKeysByLoop: true, signsNothing: true, broadcastNothing: true, spawnsRunnerOnce: true, endpointValuesPersisted: false, privateKeysRead: false, editsNoTools: true },
      };
      finalStatus = deadlineStatus;
      try { persist(deadlineStatus, out); } catch (_) { process.exitCode = 1; }
      printStatus(deadlineStatus, options.quiet);
      process.stdout.write("Canary-loop-window deadline reached (loop stop; no action taken by the loop).\n");
      break;
    }

    let status;
    try {
      status = runCycle({ cycle, options, startedMs, deadline, batch });
    } catch (_) {
      status = {
        schema: SCHEMA, generatedAt: new Date().toISOString(), scannedAt: new Date().toISOString(), scanner: SCANNER,
        mode: options.once ? "once" : "loop", cycle, startedAt: new Date(startedMs).toISOString(), ok: false, verdict: VERDICT.UNKNOWN,
        fastlane: { present: false, fresh: false, status: VERDICT.UNKNOWN }, attemptResult: { decision: "SKIPPED", note: "cycle-failed" },
        budget: { consumed: null, fired: null, total: null }, safety: { noSigningByLoop: true, noKeysByLoop: true },
      };
    }
    finalStatus = status;

    try { persist(status, out); } catch (_) {
      process.exitCode = 1;
      printStatus(status, options.quiet);
      return;
    }
    printStatus(status, options.quiet);

    if (options.once) break;
    if (cycle >= options.maxRuns) break;
    if (Date.now() + options.loopSeconds * 1000 >= deadline.expiresMs) {
      process.stdout.write("Canary-loop-window deadline reached (loop stop; no action taken by the loop).\n");
      break;
    }
    await delay(options.loopSeconds * 1000);
  }

  if (finalStatus && !options.quiet) {
    process.stdout.write(`Loop verdict=${finalStatus.verdict}. Status artifact: ${path.relative(WORKSPACE, out).split(path.sep).join("/")}\n`);
  }
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write("loop-autofire failed closed\n");
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE, FASTLANE, OUT, BATCH, OUTDIR, RUNNER,
  SCHEMA, FASTLANE_SCHEMA, SCANNER, RUNNER_ARTIFACT_SCHEMA, VERDICT, WIN_PROBABLE,
  FRESH_FASTLANE_MS, DEFAULT_DEADLINE_DAYS, CHILD_TIMEOUT_MS_DEFAULT,
  parseArgs, parseChildStdout, readFastlane, readBudgetLock, readFireRecords,
  resolveDeadline, deriveBudgetUsed, sanitizeText, runCycle, spawnRunner, persist, main,
};
