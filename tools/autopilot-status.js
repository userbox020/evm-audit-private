#!/usr/bin/env node
"use strict";

// Observational process/artifact health for the read-only monitor launcher.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const {
  services: manifestServices,
  persistentServices,
  scheduledServices,
  dataArtifacts,
  supervisorRuntime,
  forbiddenProcessScripts,
} = require("./monitor-service-manifest");
const { BOUNDED_OBSERVATIONAL, EXHAUSTIVE_COMPLETE, validateAaveSourceCoverage, validateAaveSourceCoverageEnvelope } = require("./aave-source-coverage");
const { authorizationSafetySignals } = require("./monitor-minimal-env");

const AAVE_V4_WATCH_SCHEMA = "aave-v4-liquidation-watch/v1";
const AAVE_V4_WATCH_SCANNER = "tools/watch-aave-v4-liquidation-triggers.js";
const AAVE_V4_SOURCE_SCANNER = "tools/scan-aave-v4-spoke-borrowers.js";
const AAVE_V4_SOURCE_ARTIFACT = "reports/raw/fast/aave-v4-spoke-borrowers.json";

const MORPHO_FROZEN_ORACLE_SCHEMA = "morpho-frozen-oracle-status/read-only/v1";
// The monitor's full status vocabulary; summary counts and per-market statuses must both
// draw from exactly this set so an unknown or drifted status fails closed.
const MORPHO_FROZEN_ORACLE_STATUSES = Object.freeze([
  "TRIGGERED", "WATCH", "CLEAR", "REFERENCE_UNAVAILABLE", "ORACLE_REVERT",
]);

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "monitor", "autopilot-health.json");
const LOG = path.join(WORKSPACE, "reports", "monitor", "autopilot-health-log.jsonl");
const LOCK_DIR = path.join(WORKSPACE, "reports", "monitor", "autopilot-status.lock");
const LOCK_LEASE_MS = 180_000;

function parseOptions(argv = process.argv.slice(2)) {
  const watch = argv.includes("--watch");
  const once = argv.includes("--once") || !watch;
  const quiet = argv.includes("--quiet");
  const inline = argv.find((arg) => arg.startsWith("--interval-ms="));
  const index = argv.indexOf("--interval-ms");
  const raw = inline ? inline.slice("--interval-ms=".length) : index >= 0 ? argv[index + 1] : "60000";
  const intervalMs = Math.max(15_000, Number(raw) || 60_000);
  return { watch, once, quiet, intervalMs };
}

function iso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function appendJsonLine(file, value) {
  ensureParent(file);
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function normalizePathText(value) {
  return path.win32.normalize(String(value || "").replace(/\//g, "\\")).toLowerCase();
}

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
  "-C", "--conditions", "--cpu-prof-dir", "--cpu-prof-interval", "--cpu-prof-name",
  "--diagnostic-dir", "--disable-warning", "--dns-result-order", "--env-file",
  "--env-file-if-exists", "--experimental-default-type", "--experimental-loader",
  "--experimental-policy", "--heapsnapshot-near-heap-limit", "--heapsnapshot-signal",
  "--icu-data-dir", "--import", "--input-type", "--inspect-port", "--loader",
  "--localstorage-file", "--max-http-header-size", "--openssl-config", "--redirect-warnings",
  "-r", "--require", "--report-dir", "--report-directory", "--report-filename",
  "--report-signal", "--secure-heap", "--secure-heap-min", "--snapshot-blob",
  "--test-concurrency", "--test-name-pattern", "--test-reporter",
  "--test-reporter-destination", "--test-shard", "--test-timeout", "--title",
  "--tls-cipher-list", "--trace-event-categories", "--trace-event-file-pattern",
  "--unhandled-rejections", "--use-largepages", "--watch-path",
]);

const NODE_INLINE_SOURCE_OPTIONS = new Set(["-e", "--eval", "-p", "--print"]);

function parseNodeInvocation(row) {
  if (row?.scriptId) return {
    script: String(row.scriptId),
    args: [],
    launchReservation: row.launchReservation === true,
  };
  const tokens = splitWindowsCommandLine(processText(row));
  if (tokens.length < 2) return null;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const rawOption = token.split("=", 1)[0];
    const option = rawOption.startsWith("--") ? rawOption.toLowerCase() : rawOption;
    if (token === "--") {
      return tokens[index + 1] ? { script: tokens[index + 1], args: tokens.slice(index + 2) } : null;
    }
    if (!token.startsWith("-") || token === "-") {
      return { script: token, args: tokens.slice(index + 1) };
    }
    if (NODE_INLINE_SOURCE_OPTIONS.has(option) || /^-[ep][^=]/.test(token)) return null;
    if (!token.includes("=") && NODE_OPTIONS_WITH_VALUE.has(option)) index += 1;
    else if (/^-r.+/.test(token) && token !== "-r") continue;
  }
  return null;
}

function scriptIdentityMatches(candidate, expected, workspace = WORKSPACE) {
  const expectedId = normalizePathText(expected).replace(/^\.\\/, "");
  const candidateId = normalizePathText(candidate).replace(/^\.\\/, "");
  if (!candidateId || !expectedId) return false;
  // Process CWD is not available from the aggregate-only inspection. Match the
  // actual Node entrypoint by exact basename, including parent-relative forms,
  // while rejecting suffixes such as .test/.backup and argument mentions.
  return path.win32.basename(candidateId) === path.win32.basename(expectedId);
}

function recognizedProcessRow(row) {
  const invocation = parseNodeInvocation(row);
  if (!invocation) return null;
  const knownScripts = [...new Set([
    ...manifestServices.map((service) => service.script),
    ...forbiddenProcessScripts,
  ])];
  const scriptId = knownScripts.find((script) => scriptIdentityMatches(invocation.script, script));
  if (!scriptId) return null;
  return {
    scriptId,
    launchReservation: scriptId === "tools/autopilot-status.js"
      && (invocation.launchReservation === true || invocation.args.includes("--reserve-launch")),
  };
}

function minimalProcessInspectionEnv(source = process.env) {
  const env = {};
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"]) {
    if (typeof source[name] === "string" && source[name]) env[name] = source[name];
  }
  return env;
}

function inspectProcesses() {
  // Count the owning Node process, not the long-lived cmd /c wrapper created by
  // the Windows launcher, so one service cannot be reported as two processes.
  const query = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'node.exe' -and $_.CommandLine } | Select-Object CommandLine | ConvertTo-Json -Compress";
  try {
    const env = minimalProcessInspectionEnv();
    const powershell = env.SystemRoot
      ? path.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    const raw = execFileSync(powershell, ["-NoProfile", "-Command", query], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 5 * 1024 * 1024,
      env,
    }).trim();
    if (!raw) return { ok: true, rows: [] };
    const parsed = JSON.parse(raw);
    const rows = (Array.isArray(parsed) ? parsed : [parsed])
      .filter((row) => row && row.CommandLine)
      .map(recognizedProcessRow)
      .filter(Boolean);
    return { ok: true, rows };
  } catch (_) {
    return { ok: false, rows: [] };
  }
}

function listProcesses() {
  return inspectProcesses().rows;
}

function processText(row) {
  return typeof row === "string" ? row : row?.commandLine || row?.CommandLine || "";
}

function processHasScript(row, script) {
  if (row?.scriptId) return normalizePathText(row.scriptId) === normalizePathText(script);
  const invocation = parseNodeInvocation(row);
  return Boolean(invocation && scriptIdentityMatches(invocation.script, script));
}

function forbiddenProcessMatches(processes) {
  return forbiddenProcessScripts.filter((script) => processes.some((row) => processHasScript(row, script)));
}

function isLaunchReservationProcess(row) {
  if (!processHasScript(row, "tools/autopilot-status.js")) return false;
  if (row?.scriptId) return row.launchReservation === true;
  return parseNodeInvocation(row)?.args.includes("--reserve-launch") === true;
}

function persistentProcessMatches(processes) {
  return persistentServices.filter((service) => processes.some((row) => {
    if (service.script === "tools/autopilot-status.js" && isLaunchReservationProcess(row)) return false;
    return processHasScript(row, service.script);
  }));
}

function launchPreflightIsClear(inspection) {
  return inspection?.ok === true
    && forbiddenProcessMatches(inspection.rows || []).length === 0
    && persistentProcessMatches(inspection.rows || []).length === 0;
}

function readLease(lockDir = LOCK_DIR) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(lockDir, "lease.json"), "utf8"));
    return isObject(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function leaseIsCurrent(lease, nowMs = Date.now()) {
  const expiresMs = Date.parse(lease?.expiresAt);
  return Number.isFinite(expiresMs) && expiresMs > nowMs;
}

function replaceLockDirectory(lockDir) {
  const displaced = `${lockDir}.displaced-${crypto.randomUUID()}`;
  fs.renameSync(lockDir, displaced);
  fs.rmSync(displaced, { recursive: true, force: true });
}

function acquireArtifactLease(options = {}) {
  const lockDir = options.lockDir || LOCK_DIR;
  const nowMs = options.nowMs ?? Date.now();
  const leaseMs = options.leaseMs || LOCK_LEASE_MS;
  const ownerToken = crypto.randomUUID();
  ensureParent(lockDir);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.mkdirSync(lockDir);
      const lease = {
        schema: "autopilot-status-lease/v1",
        ownerToken,
        role: options.role || "supervisor",
        acquiredAt: iso(nowMs),
        renewedAt: iso(nowMs),
        expiresAt: iso(nowMs + leaseMs),
      };
      fs.writeFileSync(path.join(lockDir, "lease.json"), `${JSON.stringify(lease, null, 2)}\n`, { flag: "wx" });
      return { lockDir, ownerToken, leaseMs, lease };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readLease(lockDir);
      if (leaseIsCurrent(existing, nowMs)) {
        if (!(options.adoptLaunchReservation && existing.role === "launch-reservation")) return null;
        const adoptionFile = path.join(lockDir, "adoption.lock");
        try {
          fs.writeFileSync(adoptionFile, ownerToken, { flag: "wx" });
          const confirmed = readLease(lockDir);
          if (!leaseIsCurrent(confirmed, nowMs) || confirmed.ownerToken !== existing.ownerToken
            || confirmed.role !== "launch-reservation") return null;
          const lease = {
            schema: "autopilot-status-lease/v1",
            ownerToken,
            role: options.role || "supervisor",
            acquiredAt: iso(nowMs),
            renewedAt: iso(nowMs),
            expiresAt: iso(nowMs + leaseMs),
          };
          writeJson(path.join(lockDir, "lease.json"), lease);
          return { lockDir, ownerToken, leaseMs, lease };
        } catch (adoptionError) {
          if (adoptionError?.code !== "EEXIST") throw adoptionError;
          return null;
        } finally {
          try {
            if (fs.readFileSync(adoptionFile, "utf8") === ownerToken) fs.rmSync(adoptionFile, { force: true });
          } catch (_) {}
        }
      } else if (!existing) {
        let ageMs = 0;
        try { ageMs = nowMs - fs.statSync(lockDir).mtimeMs; } catch (_) { continue; }
        if (ageMs <= leaseMs) return null;
      }
      try {
        replaceLockDirectory(lockDir);
      } catch (replaceError) {
        if (!["ENOENT", "EACCES", "EPERM"].includes(replaceError?.code)) throw replaceError;
      }
    }
  }
  return null;
}

function renewArtifactLease(owner, nowMs = Date.now()) {
  const existing = readLease(owner?.lockDir);
  if (!existing || existing.ownerToken !== owner?.ownerToken) return false;
  const renewed = { ...existing, renewedAt: iso(nowMs), expiresAt: iso(nowMs + owner.leaseMs) };
  writeJson(path.join(owner.lockDir, "lease.json"), renewed);
  owner.lease = renewed;
  return true;
}

function releaseArtifactLease(owner) {
  const existing = readLease(owner?.lockDir);
  if (!existing || existing.ownerToken !== owner?.ownerToken) return false;
  try {
    replaceLockDirectory(owner.lockDir);
    return true;
  } catch (_) {
    return false;
  }
}

function nestedValue(value, dottedPath) {
  return String(dottedPath || "").split(".").reduce((current, key) => current?.[key], value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function hasExactObjectKeys(value, expectedKeys) {
  return isObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort());
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasCanonicalExecutableFields(value) {
  if (Array.isArray(value)) return value.every(hasCanonicalExecutableFields);
  if (!isObject(value)) return true;
  return Object.entries(value).every(([key, child]) => {
    if (key === "executableNow") return child === false;
    if (key === "executableNowCount") return child === 0;
    return hasCanonicalExecutableFields(child);
  });
}

function healthyCountTriplet(value, attempted, succeeded, failed, options = {}) {
  return [value?.[attempted], value?.[succeeded], value?.[failed]].every(isCount)
    && (options.allowZero !== false || value[attempted] > 0)
    && value[succeeded] + value[failed] === value[attempted]
    && value[succeeded] === value[attempted]
    && value[failed] === 0;
}

function hasExactCountArray(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && new Set(value).size === value.length
    && expected.every((item) => value.includes(item));
}

function hasExactKeys(rows, requiredKeys, readConnection) {
  if (!Array.isArray(rows)) return false;
  const byKey = new Map();
  for (const row of rows) {
    if (!isObject(row) || typeof row.key !== "string" || byKey.has(row.key)) return false;
    byKey.set(row.key, row);
  }
  return requiredKeys.every((key) => {
    const connection = readConnection(byKey.get(key));
    return isObject(connection) && connection.connected === true && connection.degraded === false;
  });
}

function timestampIsFresh(value, freshnessMinutes, nowMs) {
  const observedMs = Date.parse(value);
  if (!Number.isFinite(observedMs)) return false;
  const ageMinutes = (nowMs - observedMs) / 60_000;
  return ageMinutes >= -5 && ageMinutes <= freshnessMinutes;
}

function hasObservationHeartbeat(row, observation, nowMs) {
  if (!isObject(row) || !isObject(observation)) return false;
  return row[observation.subscriptionStateField] === observation.subscribedValue
    && Number.isSafeInteger(row[observation.blockField]) && row[observation.blockField] > 0
    && timestampIsFresh(row[observation.updatedAtField], observation.freshnessMinutes, nowMs);
}

// CONDITION-LEVEL SOURCE AGGREGATES — fail closed (added 2026-09-16).
//
// `cycleHealth.sourceSummary` only counts the monitor's coarse CYCLE source groups (RPC coverage,
// stablecoin feeds, ETH oracle/market, liquidation). None of those groups is the condition family
// that actually ingests the pattern artifacts, so an entire family can be 0% healthy while the
// cycle summary still reads n/n HEALTHY. Observed live: the novelty-patterns condition aggregated
// the 11 scanner artifacts as { total: 11, healthy: 0, failed: 11 }, yet cycleHealth reported
// 4/4 healthy and fresh-noveltyState still passed. The supervisor must not trust the cycle summary
// alone, so it validates every condition-level aggregate directly from the artifact.
//
// A condition that publishes `conditions.<name>.lastResult.sourceSummary` MUST be fully healthy:
// all four counts are safe integers, total > 0, healthy === total, failed === 0, unknown === 0.
// A missing, malformed, empty, or partially-failed aggregate is NEVER treated as healthy.
//
// Declared policy:
//   required: true  -> the aggregate must always be present; a missing one fails closed.
//   exemptReason    -> an explicit, reviewable reason that a failing/empty aggregate is intended.
//                      Exemptions are hand-declared here (never inferred from shape) and must not
//                      also be marked `required`.
const CONDITION_SOURCE_AGGREGATE_POLICY = Object.freeze({
  "novelty-patterns": Object.freeze({ required: true }),
  // Declared exemptions go here, each with a written reason, e.g.
  // "some-condition": Object.freeze({ exemptReason: "why a failing/empty aggregate is intended" }),
});

function conditionPublishesSourceAggregate(condition) {
  return isObject(condition)
    && isObject(condition.lastResult)
    && Object.prototype.hasOwnProperty.call(condition.lastResult, "sourceSummary");
}

function healthyConditionSourceAggregate(summary) {
  return isObject(summary)
    && [summary.total, summary.healthy, summary.failed, summary.unknown].every(Number.isSafeInteger)
    && summary.total > 0
    && summary.healthy === summary.total
    && summary.failed === 0
    && summary.unknown === 0;
}

function hasHealthyConditionSourceAggregates(value) {
  const conditions = value?.conditions;
  if (!isObject(conditions)) return false;
  const checked = new Set();
  // Declared policy is authoritative, including `required` conditions that fail by omission.
  for (const [name, policy] of Object.entries(CONDITION_SOURCE_AGGREGATE_POLICY)) {
    checked.add(name);
    if (policy.exemptReason) continue;
    const condition = conditions[name];
    if (policy.required !== true && !conditionPublishesSourceAggregate(condition)) continue;
    if (!healthyConditionSourceAggregate(condition?.lastResult?.sourceSummary)) return false;
  }
  // Any undeclared condition that publishes an aggregate is validated too, so a new family cannot
  // bypass the check by simply not being listed above.
  for (const [name, condition] of Object.entries(conditions)) {
    if (checked.has(name)) continue;
    if (conditionPublishesSourceAggregate(condition)
      && !healthyConditionSourceAggregate(condition.lastResult.sourceSummary)) return false;
  }
  return true;
}

function hasHealthyNoveltyCycle(value, semantic) {
  const schema = semantic.cycleHealthSchema;
  const cycle = isObject(schema) ? value?.[schema.field] : null;
  const sources = isObject(cycle) ? cycle[schema.sourceSummaryField] : null;
  if (!isObject(cycle) || !isObject(sources)) return false;
  const counts = [sources.total, sources.healthy, sources.failed, sources.unknown];
  return cycle.status === schema.healthyStatus
    && cycle[schema.completeField] === true
    && cycle[schema.broadlyFailedField] === false
    && cycle[schema.blindField] === false
    && counts.every(Number.isSafeInteger)
    && sources.total > 0
    && sources.healthy === sources.total
    && sources.failed === 0
    && sources.unknown === 0;
}

function healthyAaveSourceCoverage(value, spec, nowMs, version) {
  return validateAaveSourceCoverage(value?.sourceCoverage, {
    protocolVersion: version === 3 ? "V3" : "V4",
    coverageKind: spec.semantic.coverageKind,
    mode: version === 4 && value?.sourceCoverage?.classification === EXHAUSTIVE_COMPLETE ? EXHAUSTIVE_COMPLETE : BOUNDED_OBSERVATIONAL,
    expectedChains: spec.semantic.expectedChains,
    requiredChainIds: spec.semantic.requiredChainIds || [],
    freshnessMinutes: spec.freshnessMinutes,
    nowMs,
  }).valid;
}

const OBSERVATIONAL_SHORTFALL_DECISION = "OBSERVATIONAL";

// DOCUMENTED SHORTFALL POLICY - see tools/monitor-service-manifest.js for each declaration and its
// rationale. A `decision: "OBSERVATIONAL"` declaration only relaxes the coverage-completeness part
// of the aave watch semantics, and only when ALL of the following hold:
//   1. the whole strict coverage validation failed for no reason outside the declared
//      `structuralFailures` allowlist (staleness, chain-set drift, cap drift, etc. still fail);
//   2. the coverage envelope's structural failures are all in `allowedEnvelopeFailures`;
//   3. the producer's sanitized error list is non-empty and every code is in
//      `structuralErrorCodes` (a new or unknown code fails closed);
//   4. every read-failure counter is zero and every read count is a well-formed attempted pair,
//      so a genuine endpoint read failure can never be hidden;
//   5. the declared `require` structural markers match the artifact exactly.
// A `decision: "LEFT_FAILING"` declaration is surfaced for review but never relaxes anything, and
// the full shape/hard-stop checks in validateArtifactSemantics still gate every acceptance.
function observationalShortfallDecision(spec, value, nowMs) {
  const policy = spec?.observationalShortfall;
  if (!isObject(policy) || typeof policy.reason !== "string" || !policy.reason.trim()) return null;
  const base = {
    decision: policy.decision,
    kind: policy.kind || null,
    reason: policy.reason,
    evidence: Array.isArray(policy.evidence) ? policy.evidence.slice() : [],
  };
  if (policy.decision !== OBSERVATIONAL_SHORTFALL_DECISION) {
    return { ...base, accepted: false, rejectedBecause: ["decision-left-failing"] };
  }
  const coverage = value?.sourceCoverage;
  if (!isObject(coverage)) return { ...base, accepted: false, rejectedBecause: ["missing-source-coverage"] };
  const rejectedBecause = [];
  for (const [field, expected] of Object.entries(policy.require || {})) {
    if (coverage[field] !== expected) rejectedBecause.push(`require:${field}`);
  }
  for (const [succeeded, attempted, failed] of [
    ["logChunksSucceeded", "logChunksAttempted", "logChunksFailed"],
    ["accountReadsSucceeded", "accountReadsAttempted", "accountReadsFailed"],
    ["reserveReadsSucceeded", "reserveReadsAttempted", "reserveReadsFailed"],
    ["stateReadsSucceeded", "stateReadsAttempted", "stateReadsFailed"],
  ]) {
    if (!isCount(coverage[succeeded]) || !isCount(coverage[attempted]) || !isCount(coverage[failed])) {
      rejectedBecause.push(`read-shape:${failed}`);
    } else if (coverage[failed] !== 0 || coverage[succeeded] !== coverage[attempted]) {
      rejectedBecause.push(`read-failure:${failed}`);
    }
  }
  const allowedErrorCodes = new Set(policy.structuralErrorCodes || []);
  if (!Array.isArray(coverage.errors) || coverage.errors.length === 0) {
    rejectedBecause.push("errors:empty");
  } else {
    for (const code of coverage.errors) {
      if (typeof code !== "string" || !allowedErrorCodes.has(code)) rejectedBecause.push(`error:${String(code).slice(0, 64)}`);
    }
  }
  const allowedEnvelopeFailures = new Set(policy.allowedEnvelopeFailures || []);
  for (const code of validateAaveSourceCoverageEnvelope(coverage, {
    protocolVersion: policy.require?.protocolVersion,
    coverageKind: policy.require?.coverageKind,
  }).failures) {
    if (!allowedEnvelopeFailures.has(code)) rejectedBecause.push(`envelope:${code}`);
  }
  const strictFailures = validateAaveSourceCoverage(coverage, {
    protocolVersion: policy.require?.protocolVersion,
    coverageKind: spec.semantic?.coverageKind,
    mode: BOUNDED_OBSERVATIONAL,
    expectedChains: spec.semantic?.expectedChains,
    requiredChainIds: spec.semantic?.requiredChainIds || [],
    freshnessMinutes: spec.freshnessMinutes,
    nowMs,
  }).failures;
  const allowedStructuralFailures = new Set(policy.structuralFailures || []);
  for (const code of strictFailures) {
    if (!allowedStructuralFailures.has(code)) rejectedBecause.push(`strict:${code}`);
  }
  return {
    ...base,
    accepted: rejectedBecause.length === 0,
    strictFailures,
    rejectedBecause: [...new Set(rejectedBecause)].slice(0, 16),
  };
}

const MORPHO_STARTUP_SCAN_EXHAUSTIVE = "EXHAUSTIVE_COMPLETE";
const MORPHO_STARTUP_SCAN_BOUNDED = "BOUNDED_WINDOW_INCOMPLETE";

// Shared structural checks for any honestly-produced morpho-startup-scan artifact. History
// exhaustiveness and the completeness claim are evaluated separately by
// healthyMorphoStartupScan, so a bounded observation is accepted while a false completeness
// claim is still rejected.
function morphoStartupScanShape(value) {
  const coverage = value?.coverage;
  const results = value?.results;
  const readKinds = ["blockNumber", "borrowLogs", "marketParams", "marketState", "oraclePrice", "position"];
  const topKeys = [
    "schemaVersion", "generatedAt", "scanner", "classification", "complete", "blocker", "currentBlock",
    "logQuerySuccessful", "marketsAttempted", "marketsSuccessfullyChecked", "positionsAttempted",
    "positionsSuccessfullyChecked", "errors", "coverage", "results",
  ];
  if (!hasExactObjectKeys(value, topKeys) || value.schemaVersion !== 2
    || value.scanner !== "tools/morpho-find-liquidatable.js"
    || !hasExactObjectKeys(coverage, ["currentBlock", "logQuerySuccessful", "observedRange", "historyScope", "historyStartBound", "fullHistoryProven", "caps", "borrowLogs", "markets", "borrowers", "positions", "reads", "operationalFailures", "errors"])
    || !Number.isSafeInteger(coverage.currentBlock) || coverage.currentBlock <= 0
    || coverage.logQuerySuccessful !== true || coverage.operationalFailures !== 0 || coverage.errors !== 0
    || value.currentBlock !== coverage.currentBlock || value.logQuerySuccessful !== coverage.logQuerySuccessful
    || value.errors !== 0) return false;

  const range = coverage.observedRange;
  if (!hasExactObjectKeys(range, ["fromBlock", "toBlock"])
    || !isCount(range.fromBlock) || range.toBlock !== coverage.currentBlock
    || range.toBlock < range.fromBlock
    || !hasExactObjectKeys(coverage.caps, ["borrowLogs", "borrowersPerMarket"])
    || coverage.caps.borrowLogs !== 500 || coverage.caps.borrowersPerMarket !== 30) return false;

  const logs = coverage.borrowLogs;
  const markets = coverage.markets;
  const borrowers = coverage.borrowers;
  const positions = coverage.positions;
  if (!hasExactObjectKeys(logs, ["discovered", "processed", "omittedByCap", "malformed", "wasTruncated"])
    || !isCount(logs.discovered) || logs.processed !== logs.discovered || logs.omittedByCap !== 0
    || logs.malformed !== 0 || logs.wasTruncated !== false
    || !hasExactObjectKeys(markets, ["discoveryScope", "discovered", "attempted", "resolved", "unresolved"])
    || markets.discoveryScope !== "processedBorrowLogs" || !isCount(markets.discovered)
    || markets.attempted !== markets.discovered || markets.resolved !== markets.discovered || markets.unresolved !== 0
    || !hasExactObjectKeys(borrowers, ["discoveryScope", "discoveredUnique", "discoveredMarketBorrowerPairs", "selectedForCheck", "omittedByCap", "wasTruncated"])
    || borrowers.discoveryScope !== "processedBorrowLogs" || !isCount(borrowers.discoveredUnique)
    || !isCount(borrowers.discoveredMarketBorrowerPairs)
    || borrowers.discoveredUnique > borrowers.discoveredMarketBorrowerPairs
    || borrowers.selectedForCheck !== borrowers.discoveredMarketBorrowerPairs
    || borrowers.omittedByCap !== 0 || borrowers.wasTruncated !== false
    || !hasExactObjectKeys(positions, ["discovered", "selectedForCheck", "readAttempts", "successfullyChecked", "readFailures", "unchecked", "uncheckedDueToBorrowerCap", "uncheckedDueToUnresolvedMarket"])
    || positions.discovered !== borrowers.discoveredMarketBorrowerPairs
    || positions.selectedForCheck !== positions.discovered || positions.readAttempts !== positions.discovered
    || positions.successfullyChecked !== positions.discovered || positions.readFailures !== 0
    || positions.unchecked !== 0 || positions.uncheckedDueToBorrowerCap !== 0
    || positions.uncheckedDueToUnresolvedMarket !== 0
    || value.marketsAttempted !== markets.attempted || value.marketsSuccessfullyChecked !== markets.resolved
    || value.positionsAttempted !== positions.readAttempts
    || value.positionsSuccessfullyChecked !== positions.successfullyChecked) return false;

  const reads = coverage.reads;
  if (!hasExactObjectKeys(reads, ["attempts", "successes", "failures", "byKind"])
    || !hasExactObjectKeys(reads.byKind, readKinds) || !isCount(reads.attempts)
    || reads.attempts < 2 || reads.successes !== reads.attempts || reads.failures !== 0) return false;
  let attempts = 0;
  for (const kind of readKinds) {
    const row = reads.byKind[kind];
    if (!hasExactObjectKeys(row, ["attempts", "successes", "failures"])
      || !isCount(row.attempts) || row.successes !== row.attempts || row.failures !== 0) return false;
    attempts += row.attempts;
  }
  if (attempts !== reads.attempts || reads.byKind.blockNumber.attempts !== 1
    || reads.byKind.borrowLogs.attempts !== 1
    || reads.byKind.marketParams.attempts !== markets.discovered
    || reads.byKind.marketState.attempts !== markets.discovered
    || reads.byKind.oraclePrice.attempts !== markets.discovered
    || reads.byKind.position.attempts !== positions.discovered) return false;

  return hasExactObjectKeys(results, ["liquidatablePositionsFound", "valuationStatus", "valuationEvidence", "promotionEligible", "liquidatablePositions"])
    && results.valuationStatus === "unavailable" && results.valuationEvidence === null
    && results.promotionEligible === false && Array.isArray(results.liquidatablePositions)
    && results.liquidatablePositionsFound === results.liquidatablePositions.length
    && results.liquidatablePositions.every((row) => isObject(row) && row.valuationStatus === "unavailable");
}

// Accept either an artifact that honestly proves full-history exhaustiveness or one that
// honestly declares a bounded observation. Classification and completion claims must agree
// with the proven history scope: a bounded claim that asserts completeness (or an
// EXHAUSTIVE_COMPLETE claim without proven full history) fails closed.
function healthyMorphoStartupScan(value) {
  if (!morphoStartupScanShape(value)) return false;
  const fullHistoryProven = value.coverage.fullHistoryProven === true;
  if (value.classification === MORPHO_STARTUP_SCAN_EXHAUSTIVE) {
    return value.complete === true && fullHistoryProven && value.blocker === null;
  }
  if (value.classification === MORPHO_STARTUP_SCAN_BOUNDED) {
    return value.complete === false && !fullHistoryProven
      && typeof value.blocker === "string" && value.blocker.trim().length > 0;
  }
  return false;
}

function healthyTriggerCoverageAudit(value) {
  const universeFile = path.join(WORKSPACE, "tools", "trigger-coverage-universe.json");
  let universeBytes;
  let universe;
  try {
    universeBytes = fs.readFileSync(universeFile);
    universe = JSON.parse(universeBytes.toString("utf8"));
    require("./audit-trigger-coverage-universe").validateUniverse(universe, { workspace: WORKSPACE });
  } catch (_) {
    return false;
  }
  if (!hasExactObjectKeys(value, ["schema", "auditedAt", "universeSha256", "rows", "done"])
    || value.schema !== "trigger-coverage-audit/v1"
    || value.universeSha256 !== crypto.createHash("sha256").update(universeBytes).digest("hex")
    || !Array.isArray(universe?.rows) || universe.rows.length !== 53
    || !Array.isArray(value.rows) || value.rows.length !== universe.rows.length) return false;
  const declared = new Map(universe.rows.map((row) => [row.id, row]));
  const seen = new Set();
  for (const row of value.rows) {
    if (!hasExactObjectKeys(row, ["id", "status", "observedAt", "expiresAt", "artifactPath", "artifactSha256", "evidence", "blockers"])
      || seen.has(row.id) || !declared.has(row.id)
      || row.artifactPath !== declared.get(row.id).artifactPath
      || !new Set(["COVERED", "BLOCKED", "MISSING", "STALE"]).has(row.status)
      || !Number.isFinite(Date.parse(row.observedAt))
      || !(row.expiresAt === null || Number.isFinite(Date.parse(row.expiresAt)))
      || !(row.artifactSha256 === null || /^[0-9a-f]{64}$/.test(row.artifactSha256))
      || !Array.isArray(row.evidence) || row.evidence.some((item) => typeof item !== "string" || !item)
      || !Array.isArray(row.blockers) || row.blockers.some((item) => typeof item !== "string" || !item)) return false;
    if (row.status === "COVERED" && row.blockers.length !== 0) return false;
    if (row.status === "BLOCKED" && (row.evidence.length === 0 || row.blockers.length === 0
      || declared.get(row.id).onFire?.enabled !== false)) return false;
    seen.add(row.id);
  }
  const accountingDone = value.rows.every((row) => row.status === "COVERED" || row.status === "BLOCKED");
  return seen.size === declared.size && value.done === accountingDone;
}

function validateArtifactSemantics(spec, value, text = null, nowMs = Date.now()) {
  const semantic = spec.semantic;
  if (!semantic?.validator) return false;
  if (authorizationSafetySignals(value).hardStop) return false;
  const summary = value?.summary;
  switch (semantic.validator) {
    case "completion-marker":
      return typeof text === "string" && text.trim() === semantic.expectedText;
    case "novelty-state":
      return isObject(value) && isObject(value.lastBlock) && isObject(value.conditions)
        && hasHealthyNoveltyCycle(value, semantic)
        && hasHealthyConditionSourceAggregates(value);
    case "morpho-ws":
      return value?.status === "RUNNING"
        && hasExactKeys(value.chains, semantic.requiredChains, (row) => row)
        && value.chains.every((row) => hasObservationHeartbeat(row, semantic.observation, nowMs));
    case "chainlink-ws":
      return value?.status === "RUNNING"
        && hasExactKeys(value.feeds, semantic.requiredChains, (row) => row?.connection)
        && value.feeds.every((row) => hasObservationHeartbeat(row?.connection, semantic.observation, nowMs));
    case "aave-v4-watch":
      return value?.schema === AAVE_V4_WATCH_SCHEMA
        && value?.scanner === AAVE_V4_WATCH_SCANNER
        && value.sourceScanner === AAVE_V4_SOURCE_SCANNER
        && value.sourceArtifact === AAVE_V4_SOURCE_ARTIFACT
        && hasExactObjectKeys(value.source, ["scanner", "artifact"])
        && value.source.scanner === AAVE_V4_SOURCE_SCANNER
        && value.source.artifact === AAVE_V4_SOURCE_ARTIFACT
        && (healthyAaveSourceCoverage(value, spec, nowMs, 4)
          || observationalShortfallDecision(spec, value, nowMs)?.accepted === true)
        && isObject(value.latest?.summary)
        && value.latest.sourceScanner === AAVE_V4_SOURCE_SCANNER
        && value.latest.sourceArtifact === AAVE_V4_SOURCE_ARTIFACT
        && isFiniteNumber(value.latest.summary.activeBorrowers)
        && isFiniteNumber(value.latest.summary.liquidatable)
        && value.latest.summary.signedActionJustified === false
        && Array.isArray(value.latest.topRows);
    case "aave-v3-watch":
      return value?.scanner === "tools/aave-v3-liquidation-watch.js"
        && (healthyAaveSourceCoverage(value, spec, nowMs, 3)
          || observationalShortfallDecision(spec, value, nowMs)?.accepted === true)
        && Number.isInteger(value.cycle) && value.cycle > 0
        && isObject(value.latest)
        && typeof value.latest.forkGateCandidate === "boolean"
        && value.latest.executableNow === false
        && typeof value.latest.signedActionJustified === "boolean";
    case "morpho-startup-scan":
      return healthyMorphoStartupScan(value);
    case "trigger-coverage-audit":
      // Accounting completeness only: BLOCKED remains non-operational coverage.
      return healthyTriggerCoverageAudit(value);
    case "morpho-frozen-oracle": {
      // Fail closed on any malformed, drifted, or incomplete frozen-oracle observation. The
      // artifact's own generation timestamp is capturedAt; a valid artifact must also carry
      // the monitor's read-only safety declaration and exact request/market bookkeeping.
      if (!isObject(value) || value.schema !== MORPHO_FROZEN_ORACLE_SCHEMA) return false;
      const safety = value.safety;
      if (!isObject(safety)
        || safety.readOnly !== true
        || safety.externalStateMutations !== false
        || safety.oracleOrPoolManipulation !== false
        || safety.signing !== false
        || safety.transactions !== false
        || safety.forks !== false
        || safety.endpointValuesStored !== false
        || safety.endpointMaterialInChildArgv !== false) return false;
      if (!new Set(["once", "watch"]).has(value.mode)) return false;
      if (!timestampIsFresh(value.capturedAt, spec.freshnessMinutes, nowMs)) return false;
      if (!isObject(value.requestCounts) || !isCount(value.requestCounts.trackedMarkets)) return false;
      if (!isObject(summary)) return false;
      if (!MORPHO_FROZEN_ORACLE_STATUSES.every((status) => isCount(summary[status]))) return false;
      if (!Array.isArray(value.markets) || value.markets.length === 0) return false;
      if (value.requestCounts.trackedMarkets !== value.markets.length) return false;
      const summarised = MORPHO_FROZEN_ORACLE_STATUSES.reduce((count, status) => count + summary[status], 0);
      if (summarised !== value.markets.length) return false;
      const observed = Object.fromEntries(MORPHO_FROZEN_ORACLE_STATUSES.map((status) => [status, 0]));
      for (const row of value.markets) {
        if (!isObject(row) || !MORPHO_FROZEN_ORACLE_STATUSES.includes(row.status)) return false;
        observed[row.status] += 1;
      }
      return MORPHO_FROZEN_ORACLE_STATUSES.every((status) => observed[status] === summary[status]);
    }
    case "global-gates":
      return value?.scanner === "tools/monitor-global-gates.js"
        && isObject(summary)
        && typeof summary.status === "string" && summary.status.length > 0
        && summary.gateRefreshOk === true
        && summary.confirmationOk === true
        && isFiniteNumber(summary.routePositive)
        && summary.executableNow === false
        && summary.executableNowCount === 0
        && summary.signedActionJustified === false
        && summary.hardStop === false;
    case "e1-proximity":
      return value?.scanner === "tools/monitor-e1-proximity.js"
        && isObject(value.metrics) && isFiniteNumber(value.metrics.feedAgeSeconds)
        && isFiniteNumber(value.metrics.divergencePercent)
        && isObject(value.gates) && typeof value.gates.triggered === "boolean"
        && value.gates.executableNow === false
        && new Set(["TRIGGERED", "WARNING", "ELEVATED", "NOMINAL"]).has(value.statusLevel);
    case "venus-psr": {
      if (value?.schema !== "venus-psr-state/v1" || value.readOnly !== true
        || value.upstreamTransactions !== 0 || value.signedActionJustified !== false
        || !isObject(value.chains) || !new Set(["CLEAR", "DRIFT"]).has(value.status)) return false;
      return semantic.requiredChains.every((key) => new Set(["CLEAR", "DRIFT"]).has(value.chains[key]?.status));
    }
    case "supervisor-health":
      return value?.scanner === "tools/autopilot-status.js"
        && isObject(summary)
        && new Set(["observational", "fail-closed"]).has(summary.status)
        && isObject(value.safetyStatus)
        && new Set(["ok", "fail-closed"]).has(value.safetyStatus.status);
    case "disabled-routes":
      return value?.scanner === "tools/autopilot-disabled-routes.js"
        && isObject(summary)
        && hasCanonicalExecutableFields(value)
        && isFiniteNumber(summary.observedLowFundCandidates)
        && isFiniteNumber(summary.disabledRoutes)
        && summary.executableNow === false
        && summary.executableNowCount === 0
        && summary.signedActionJustified === false
        && summary.hardStop === false
        && Array.isArray(value.observedLowFundCandidates)
        && Array.isArray(value.disabledRoutes);
    case "route-sweep":
      return value?.scanner === "tools/scan-route-positive-sweep.js"
        && isObject(summary)
        && hasCanonicalExecutableFields(value)
        && isFiniteNumber(summary.routePositive)
        && summary.executableNow === false
        && summary.executableNowCount === 0
        && summary.signedActionJustified === false
        && summary.hardStop === false
        && Array.isArray(value.ranked);
    case "completion-gates":
      return value?.scanner === "tools/scan-audit-completion-gates.js"
        && isObject(summary)
        && hasCanonicalExecutableFields(value)
        && semantic.healthyStatuses.includes(summary.status)
        && summary.completeForNow === true
        && summary.routePositive === 0
        && summary.executableNow === false
        && summary.executableNowCount === 0
        && summary.signedActionJustified === false
        && summary.hardStop === false;
    default:
      return false;
  }
}

function syntheticEntry(artifactMap, relativePath) {
  if (!artifactMap || !Object.prototype.hasOwnProperty.call(artifactMap, relativePath)) return null;
  const supplied = artifactMap[relativePath];
  if (supplied && typeof supplied === "object"
    && (Object.prototype.hasOwnProperty.call(supplied, "json")
      || Object.prototype.hasOwnProperty.call(supplied, "text")
      || Object.prototype.hasOwnProperty.call(supplied, "exists")
      || Object.prototype.hasOwnProperty.call(supplied, "mtimeMs"))) {
    return {
      supplied: true,
      exists: supplied.exists !== false,
      json: supplied.json,
      text: supplied.text,
      mtimeMs: supplied.mtimeMs,
    };
  }
  return { supplied: true, exists: supplied !== undefined && supplied !== null, json: supplied, text: null, mtimeMs: null };
}

function artifactHealth(spec, options = {}) {
  const workspace = options.workspace || WORKSPACE;
  const nowMs = options.nowMs ?? Date.now();
  const relativePath = String(spec.path).replace(/\\/g, "/");
  const file = path.join(workspace, ...relativePath.split("/"));
  const synthetic = syntheticEntry(options.artifactMap, relativePath);
  let exists = false;
  let valid = false;
  let semanticValid = false;
  let value = null;
  let text = null;
  let mtimeMs = null;

  if (synthetic) {
    exists = synthetic.exists;
    mtimeMs = synthetic.mtimeMs ?? null;
    if (exists && spec.format === "text") {
      text = typeof synthetic.text === "string" ? synthetic.text : null;
      valid = text !== null && text.length > 0;
    } else if (exists) {
      value = synthetic.json;
      valid = isObject(value);
    }
  } else {
    try {
      const stat = fs.statSync(file);
      exists = stat.isFile();
      mtimeMs = stat.mtimeMs;
      if (exists && spec.format === "text") {
        text = fs.readFileSync(file, "utf8");
        valid = text.length > 0;
      } else if (exists) {
        value = JSON.parse(fs.readFileSync(file, "utf8"));
        valid = isObject(value);
      }
    } catch (_) {
      exists = false;
      valid = false;
    }
  }

  semanticValid = Boolean(valid && validateArtifactSemantics(spec, value, text, nowMs));
  // Computed for review only: acceptance already flowed through validateArtifactSemantics, which
  // enforces every shape check and the recursive hard-stop check BEFORE the structural allowance.
  // A LEFT_FAILING decision is surfaced here and never changes readiness.
  const shortfallDecision = valid ? observationalShortfallDecision(spec, value, nowMs) : null;
  valid = Boolean(valid && semanticValid);

  let observedMs = null;
  for (const field of spec.timestampFields || []) {
    const candidate = nestedValue(value, field);
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) {
      observedMs = parsed;
      break;
    }
  }
  if (observedMs === null && (spec.format === "text" || !(spec.timestampFields || []).length) && Number.isFinite(mtimeMs)) observedMs = mtimeMs;
  const rawAge = observedMs === null ? null : (nowMs - observedMs) / 60_000;
  const ageMinutes = Number.isFinite(rawAge) ? Math.round(rawAge * 100) / 100 : null;
  const timestampValid = ageMinutes !== null && ageMinutes >= -5;
  const fresh = Boolean(timestampValid && ageMinutes <= spec.freshnessMinutes);

  const observational = spec.coverageMode === BOUNDED_OBSERVATIONAL
    || spec.semantic?.coverageMode === BOUNDED_OBSERVATIONAL
    || shortfallDecision?.accepted === true;
  const acceptable = Boolean(exists && valid && fresh);
  return {
    path: relativePath,
    exists,
    valid,
    semanticValid,
    fresh,
    ageMinutes,
    maxAgeMinutes: spec.freshnessMinutes,
    status: acceptable ? observational ? "ready-observational" : "healthy" : "invalid",
    observational,
    acceptable,
    healthy: Boolean(acceptable && !observational),
    shortfallDecision,
  };
}

function scriptIsInstalled(service, options = {}) {
  if (typeof options.scriptExists === "function") return Boolean(options.scriptExists(service.script));
  if (options.scriptExists && Object.prototype.hasOwnProperty.call(options.scriptExists, service.script)) {
    return Boolean(options.scriptExists[service.script]);
  }
  return fs.existsSync(path.join(options.workspace || WORKSPACE, ...service.script.split("/")));
}

function buildServiceStatuses(processes, options = {}) {
  return manifestServices.map((service) => {
    const artifactSpec = service.artifact ? { ...service.artifact, coverageMode: service.coverageMode } : null;
    const artifact = artifactSpec ? artifactHealth(artifactSpec, options) : null;
    if (service.kind === "scheduled") {
      const installed = !service.optional || scriptIsInstalled(service, options);
      const readiness = !installed ? "not-installed" : artifact?.acceptable ? "complete" : "pending-artifact";
      return { id: service.id, running: null, processCount: null, readiness, artifact };
    }
    const processCount = processes.filter((row) => processHasScript(row, service.script)).length;
    const running = processCount === 1;
    const readiness = processCount === 0 ? "not-running"
      : processCount > 1 ? "duplicate-processes"
        : service.artifact && !artifact.acceptable ? "pending-artifact"
          : service.coverageMode === BOUNDED_OBSERVATIONAL ? "ready-observational" : "ready";
    return { id: service.id, running, processCount, readiness, artifact };
  });
}

function assertion(id, pass, artifact = null) {
  return {
    id,
    pass: Boolean(pass),
    artifactAgeMinutes: artifact?.ageMinutes ?? null,
    maxAgeMinutes: artifact?.maxAgeMinutes ?? null,
  };
}

function statusBlock(assertions, okStatus = "ready", failStatus = "fail-closed", extra = {}) {
  const failed = assertions.filter((row) => !row.pass);
  return {
    status: failed.length ? failStatus : okStatus,
    ...extra,
    failedAssertionIds: failed.map((row) => row.id),
    assertions,
  };
}

function artifactValue(spec, options = {}) {
  const relativePath = String(spec.path).replace(/\\/g, "/");
  const synthetic = syntheticEntry(options.artifactMap, relativePath);
  if (synthetic) return synthetic.exists ? synthetic.json ?? null : null;
  try {
    return JSON.parse(fs.readFileSync(path.join(options.workspace || WORKSPACE, ...relativePath.split("/")), "utf8"));
  } catch (_) {
    return null;
  }
}

function containsSensitiveProcessFields(value) {
  if (Array.isArray(value)) return value.some(containsSensitiveProcessFields);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, child]) => /^(?:pid|command|commandLine|endpoint|provider|environment|keyState)$/i.test(key)
    || containsSensitiveProcessFields(child));
}

function buildStatus(cycle = 1, startedAt = iso(), options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const inspection = options.processes ? { ok: options.processInspectionOk !== false, rows: options.processes } : inspectProcesses();
  const processes = inspection.rows;
  const serviceRows = buildServiceStatuses(processes, { ...options, nowMs });
  const persistentRows = serviceRows.filter((row) => persistentServices.some((service) => service.id === row.id));
  const scheduledRows = serviceRows.filter((row) => scheduledServices.some((service) => service.id === row.id));

  const runtimeFacts = options.runtimeFacts || supervisorRuntime;
  const safetyAssertions = [
    assertion("read-only-observer", runtimeFacts.role === "read-only-observer"
      && manifestServices.every((service) => service.mode === "read-only")),
    assertion("no-child-refresh", runtimeFacts.processInspection === "query-only"
      && runtimeFacts.artifactRefresh === "disabled"),
    assertion("sanitized-process-output", runtimeFacts.processOutput === "aggregate-only"
      && !containsSensitiveProcessFields(serviceRows)),
    assertion("process-inspection-succeeded", inspection.ok),
    assertion("forbidden-processes-absent", inspection.ok && forbiddenProcessMatches(processes).length === 0),
  ];
  const safetyStatus = statusBlock(safetyAssertions, "ok", "fail-closed");

  const serviceAssertions = persistentRows.flatMap((row) => [
    assertion(`service-singleton-${row.id}`, row.processCount === 1),
    assertion(`service-ready-${row.id}`, new Set(["ready", "ready-observational"]).has(row.readiness), row.artifact),
  ]);
  const observationalPersistent = persistentRows.filter((row) => row.readiness === "ready-observational").length;
  const serviceStatus = statusBlock(serviceAssertions, observationalPersistent ? "observational" : "ready", "degraded", {
    expectedPersistent: persistentServices.length,
    runningPersistent: persistentRows.filter((row) => row.running).length,
    readyPersistent: persistentRows.filter((row) => new Set(["ready", "ready-observational"]).has(row.readiness)).length,
    observationalPersistent,
    expectedScheduled: scheduledServices.length,
    completeScheduled: scheduledRows.filter((row) => row.readiness === "complete").length,
    notInstalledScheduled: scheduledRows.filter((row) => row.readiness === "not-installed").length,
  });

  const artifactRows = manifestServices
    .map((service) => ({ service, row: serviceRows.find((item) => item.id === service.id) }))
    .filter(({ service, row }) => service.artifact && !(service.optional && row.readiness === "not-installed"));
  const dataAssertions = artifactRows.map(({ service, row }) => assertion(service.artifact.assertionId, row.artifact.acceptable, row.artifact));
  const independentData = dataArtifacts.map((spec) => ({ spec, health: artifactHealth(spec, { ...options, nowMs }) }));
  dataAssertions.push(...independentData.map(({ spec, health }) => assertion(spec.assertionId, health.healthy, health)));
  const dataStatus = statusBlock(dataAssertions, "ready", "fail-closed");
  // Every documented OBSERVATIONAL/LEFT_FAILING shortfall decision is mirrored here so a reviewer
  // can see, at the top level of the health artifact, exactly WHY a service is observational or
  // why it is deliberately still failing. The source-of-truth rationale lives in
  // tools/monitor-service-manifest.js next to each declaration.
  const shortfallDecisions = [
    ...serviceRows.map((row) => ({ id: row.id, artifact: row.artifact })),
    ...independentData.map(({ spec, health }) => ({ id: spec.assertionId, artifact: health })),
  ]
    .filter((row) => row.artifact?.shortfallDecision)
    .map((row) => ({ id: row.id, ...row.artifact.shortfallDecision }));

  // A real frozen-oracle trigger is a security signal, not a green state. Surface
  // TRIGGERED > 0 as its own distinct assertion so it is never silently acceptable: a
  // missing, malformed, or unreadable artifact also fails this closed.
  const frozenOracleSpec = manifestServices.find((service) => service.id === "morpho-frozen-oracle")?.artifact || null;
  const frozenOracleValue = frozenOracleSpec ? artifactValue(frozenOracleSpec, options) : null;
  const frozenOracleTriggered = isCount(frozenOracleValue?.summary?.TRIGGERED)
    ? frozenOracleValue.summary.TRIGGERED
    : null;
  const triggerStatus = statusBlock(
    frozenOracleSpec ? [assertion("trigger-morphoFrozenOracle", frozenOracleTriggered === 0)] : [],
    "clear",
    "triggered",
    { triggered: frozenOracleTriggered },
  );

  const globalSpec = manifestServices.find((service) => service.id === "global-gates").artifact;
  const routeSpec = dataArtifacts.find((spec) => spec.assertionId === "fresh-routeSweep");
  const completionSpec = dataArtifacts.find((spec) => spec.assertionId === "fresh-completionGates");
  const globalData = artifactValue(globalSpec, options) || {};
  const routeData = artifactValue(routeSpec, options) || {};
  const completionData = artifactValue(completionSpec, options) || {};
  const gateInputs = ["fresh-globalGates", "fresh-routeSweep", "fresh-completionGates"];
  const gateInputsReady = gateInputs.every((id) => dataAssertions.find((row) => row.id === id)?.pass === true);
  const summaries = [globalData.summary, routeData.summary, completionData.summary];
  const explicitRouteSummary = summaries.every((row) => isObject(row)
    && typeof row.executableNow === "boolean"
    && typeof row.signedActionJustified === "boolean");
  const upstreamExecutableNow = gateInputsReady && explicitRouteSummary
    ? summaries.some((row) => row.executableNow === true)
    : false;
  const upstreamSignedActionSignal = gateInputsReady && explicitRouteSummary
    ? summaries.some((row) => row.signedActionJustified === true)
    : false;
  const routeAssertions = [
    assertion("route-gate-inputs-ready", gateInputsReady && explicitRouteSummary),
    assertion("route-executable-now-closed", gateInputsReady && explicitRouteSummary && upstreamExecutableNow === false),
    assertion("route-signed-action-closed", gateInputsReady && explicitRouteSummary && upstreamSignedActionSignal === false),
  ];
  const routeGateStatus = statusBlock(routeAssertions, "closed", "fail-closed", {
    executableNow: false,
    executableNowCount: 0,
    signedActionJustified: false,
    // Informational only: this shows which of the three gate inputs actually passed, so a failing
    // route gate can never be mistaken for a missing/undefined input. The completion-gate input is
    // left genuinely failing while the residual audit backlog is open (see manifest decision).
    gateInputs: Object.fromEntries(gateInputs.map((id) => [id, dataAssertions.find((row) => row.id === id)?.pass === true])),
  });

  const allAssertions = [
    ...safetyStatus.assertions,
    ...serviceStatus.assertions,
    ...dataStatus.assertions,
    ...triggerStatus.assertions,
    ...routeGateStatus.assertions,
  ];
  const failedAssertionIds = [...new Set(allAssertions.filter((row) => !row.pass).map((row) => row.id))];
  const artifactAgesMinutes = Object.fromEntries(
    allAssertions.filter((row) => row.maxAgeMinutes !== null).map((row) => [row.id, row.artifactAgeMinutes])
  );

  return {
    generatedAt: iso(nowMs),
    scanner: "tools/autopilot-status.js",
    cycle,
    startedAt,
    summary: {
      status: failedAssertionIds.length ? "fail-closed" : serviceStatus.observationalPersistent > 0 ? "observational" : "healthy",
      persistentExpected: persistentServices.length,
      persistentRunning: serviceStatus.runningPersistent,
      persistentReady: serviceStatus.readyPersistent,
      persistentObservational: serviceStatus.observationalPersistent,
      scheduledExpected: scheduledServices.length,
      scheduledComplete: serviceStatus.completeScheduled,
      scheduledNotInstalled: serviceStatus.notInstalledScheduled,
      safetyStatus: safetyStatus.status,
      serviceStatus: serviceStatus.status,
      dataStatus: dataStatus.status,
      triggerStatus: triggerStatus.status,
      frozenOracleTriggered,
      routeGateStatus: routeGateStatus.status,
      failedAssertionIds,
      artifactAgesMinutes,
    },
    safetyStatus,
    serviceStatus,
    dataStatus,
    triggerStatus,
    routeGateStatus,
    shortfallDecisions,
    services: serviceRows,
  };
}

function formatConsole(status) {
  const failed = status.summary.failedAssertionIds;
  const ids = failed.length ? failed.join(",") : "none";
  const ages = failed.map((id) => {
    const age = status.summary.artifactAgesMinutes[id];
    return `${id}:${age === null || age === undefined ? "n/a" : `${age}m`}`;
  }).join(",") || "none";
  return `[MONITOR-HEALTH cycle=${status.cycle}] status=${status.summary.status} services=${status.summary.persistentReady}/${status.summary.persistentExpected} running=${status.summary.persistentRunning} scheduled=${status.summary.scheduledComplete}/${status.summary.scheduledExpected} optionalNotInstalled=${status.summary.scheduledNotInstalled} safety=${status.summary.safetyStatus} data=${status.summary.dataStatus} routes=${status.summary.routeGateStatus} failed=${ids} ages=${ages}`;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (argv.includes("--reserve-launch")) {
    const inspection = inspectProcesses();
    if (!launchPreflightIsClear(inspection)) throw new Error("launch-preflight-fail-closed");
    const reservation = acquireArtifactLease({ role: "launch-reservation" });
    if (!reservation) throw new Error("supervisor-owner-present");
    return;
  }
  const owner = acquireArtifactLease({
    role: options.watch ? "supervisor" : "one-shot-validation",
    adoptLaunchReservation: options.watch,
    leaseMs: options.watch ? Math.max(LOCK_LEASE_MS, options.intervalMs * 3) : LOCK_LEASE_MS,
  });
  if (!owner) throw new Error("supervisor-owner-present");
  const startedAt = iso();
  let cycle = 0;
  try {
    do {
      if (!renewArtifactLease(owner)) throw new Error("supervisor-lease-lost");
      cycle += 1;
      const status = buildStatus(cycle, startedAt);
      writeJson(OUT, status);
      appendJsonLine(LOG, {
        generatedAt: status.generatedAt,
        cycle,
        status: status.summary.status,
        persistentReady: status.summary.persistentReady,
        persistentExpected: status.summary.persistentExpected,
        failedAssertionIds: status.summary.failedAssertionIds,
        artifactAgesMinutes: status.summary.artifactAgesMinutes,
      });
      if (!options.quiet || status.summary.failedAssertionIds.length) console.log(formatConsole(status));
      if (options.once) break;
      await sleep(options.intervalMs);
    } while (true);
  } finally {
    releaseArtifactLease(owner);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`autopilot-status failed closed: ${error?.message || String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE,
  OUT,
  LOG,
  parseOptions,
  normalizePathText,
  minimalProcessInspectionEnv,
  inspectProcesses,
  processHasScript,
  forbiddenProcessMatches,
  persistentProcessMatches,
  launchPreflightIsClear,
  acquireArtifactLease,
  renewArtifactLease,
  releaseArtifactLease,
  readLease,
  nestedValue,
  healthyTriggerCoverageAudit,
  validateArtifactSemantics,
  hasHealthyConditionSourceAggregates,
  observationalShortfallDecision,
  artifactHealth,
  buildServiceStatuses,
  assertion,
  statusBlock,
  artifactValue,
  buildStatus,
  formatConsole,
  listProcesses,
  LOCK_DIR,
  LOCK_LEASE_MS,
  main,
};
