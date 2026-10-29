#!/usr/bin/env node
"use strict";

// Reusable builder for the trigger-coverage D (deployed runtime/config delta) rows.
//
// It binds each `*-d` universe row to the bounded official deployed-delta sentinel
// artifact (`reports/monitor/official-deployed-delta-sentinel.json`) and emits a
// per-row `trigger-coverage-evidence/v1` binder under `reports/monitor/trigger-coverage/`.
//
// Honesty properties:
// - `observedAt` is copied from the sentinel's own `generatedAt`; the builder never
//   stamps the wall-clock time of the binder build.
// - The sentinel's configured repository set is scoped by an explicit, reasoned
//   `excludedRepositories` config list. Any in-scope repository that did not reach a
//   required poll status fails the builder closed (rows are emitted BLOCKED, not COVERED).
// - A row can only be COVERED when the real sentinel artifact proves the bounded poll.

const fs = require("node:fs");
const path = require("node:path");
const audit = require("./audit-trigger-coverage-universe.js");

const WORKSPACE = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(__dirname, "trigger-coverage-delta-binders.json");
const BINDER_SCHEMA = "trigger-coverage-evidence/v1";
const CONFIG_SCHEMA = "trigger-coverage-delta-binders/v1";
const SENTINEL_SCHEMA = "official-deployed-delta-sentinel/v1";
const MODES = Object.freeze(["COVERED", "BLOCKED"]);
const SENTINEL_STATUSES = Object.freeze(["unchanged", "candidate-change", "incomplete", "rate-limited"]);
const CONFIG_KEYS = Object.freeze([
  "schema", "universePath", "sentinelPath", "outputDir", "freshnessSeconds",
  "sentinelScope", "rows", "reconciliation", "freshnessRationale",
]);
const SCOPE_KEYS = Object.freeze(["requiredPollStatuses", "excludedRepositories"]);
const ROW_CONFIG_KEYS = Object.freeze(["mode", "blocker"]);
const EXCLUSION_KEYS = Object.freeze(["id", "reason"]);
const REPO_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ON_FIRE_NOTE = "on-fire economics = bounded delta-trigger exposure bound (no profit claim); keyless fixed-pin fork = wired bounded state-consistency probe at the observation point (no state change); alert = wired";

class BinderError extends Error {
  constructor(code) { super(code); this.name = "BinderError"; this.code = code; }
}
function fail(code) { throw new BinderError(code); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) {
  return isObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function iso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    && !path.isAbsolute(value) && !value.includes("\\") && !value.includes("\0")
    && !value.split("/").includes("..") && !value.split("/").includes("");
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function resolveWorkspaceRelative(workspace, relativePath) {
  if (!safeRelative(relativePath)) return null;
  const absolute = path.resolve(workspace, ...relativePath.split("/"));
  const prefix = `${path.resolve(workspace)}${path.sep}`.toLowerCase();
  return absolute.toLowerCase().startsWith(prefix) ? absolute : null;
}
function relPosix(workspace, target) {
  return path.relative(workspace, target).split(path.sep).join("/");
}

function validateConfig(config, universe) {
  if (!exactKeys(config, CONFIG_KEYS)) fail("CONFIG_KEYS_INVALID");
  if (config.schema !== CONFIG_SCHEMA) fail("CONFIG_SCHEMA_INVALID");
  for (const key of ["universePath", "sentinelPath", "outputDir"]) {
    if (!safeRelative(config[key])) fail(`CONFIG_PATH_INVALID:${key}`);
  }
  if (!config.outputDir.startsWith("reports/")) fail("CONFIG_OUTPUT_DIR_INVALID");
  if (!Number.isSafeInteger(config.freshnessSeconds) || config.freshnessSeconds <= 0 || config.freshnessSeconds > 86400) {
    fail("CONFIG_FRESHNESS_INVALID");
  }
  if (typeof config.reconciliation !== "string" || !config.reconciliation.trim()) fail("CONFIG_RECONCILIATION_INVALID");
  if (typeof config.freshnessRationale !== "string" || !config.freshnessRationale.trim()) fail("CONFIG_FRESHNESS_RATIONALE_INVALID");
  if (!exactKeys(config.sentinelScope, SCOPE_KEYS)) fail("CONFIG_SCOPE_KEYS_INVALID");
  const scope = config.sentinelScope;
  if (!Array.isArray(scope.requiredPollStatuses) || scope.requiredPollStatuses.length === 0
      || scope.requiredPollStatuses.some((status) => !SENTINEL_STATUSES.includes(status))
      || new Set(scope.requiredPollStatuses).size !== scope.requiredPollStatuses.length) {
    fail("CONFIG_REQUIRED_STATUSES_INVALID");
  }
  if (!Array.isArray(scope.excludedRepositories)) fail("CONFIG_EXCLUSIONS_INVALID");
  const excludedIds = new Set();
  for (const exclusion of scope.excludedRepositories) {
    if (!exactKeys(exclusion, EXCLUSION_KEYS) || !REPO_ID.test(exclusion.id)
        || typeof exclusion.reason !== "string" || !exclusion.reason.trim() || excludedIds.has(exclusion.id)) {
      fail("CONFIG_EXCLUSION_INVALID");
    }
    excludedIds.add(exclusion.id);
  }
  const deltaRows = universe.rows.filter((row) => row.triggerClass === "D");
  const deltaIds = deltaRows.map((row) => row.id).sort();
  if (!isObject(config.rows) || JSON.stringify(Object.keys(config.rows).sort()) !== JSON.stringify(deltaIds)) {
    fail("CONFIG_ROW_SET_INVALID");
  }
  for (const row of deltaRows) {
    const rowConfig = config.rows[row.id];
    if (!isObject(rowConfig) || !MODES.includes(rowConfig.mode)
        || Object.keys(rowConfig).some((key) => !ROW_CONFIG_KEYS.includes(key))) {
      fail(`CONFIG_ROW_INVALID:${row.id}`);
    }
    if (rowConfig.mode === "BLOCKED" && (typeof rowConfig.blocker !== "string" || !rowConfig.blocker.trim())) {
      fail(`CONFIG_ROW_BLOCKER_MISSING:${row.id}`);
    }
    if (rowConfig.mode === "COVERED" && rowConfig.blocker !== undefined) fail(`CONFIG_ROW_BLOCKER_UNEXPECTED:${row.id}`);
  }
  return { deltaRows, excludedIds };
}

function validateSentinel(sentinel) {
  if (!isObject(sentinel) || sentinel.schema !== SENTINEL_SCHEMA || !iso(sentinel.generatedAt)) fail("SENTINEL_INVALID");
  if (sentinel.status !== undefined && !SENTINEL_STATUSES.includes(sentinel.status)) fail("SENTINEL_STATUS_INVALID");
  if (!Array.isArray(sentinel.repositories) || sentinel.repositories.length === 0) fail("SENTINEL_REPOSITORIES_INVALID");
  const repositories = sentinel.repositories.map((entry) => {
    if (!isObject(entry) || !REPO_ID.test(entry.id) || !SENTINEL_STATUSES.includes(entry.pollStatus)) fail("SENTINEL_REPOSITORY_INVALID");
    return Object.freeze({ id: entry.id, pollStatus: entry.pollStatus });
  });
  if (new Set(repositories.map((entry) => entry.id)).size !== repositories.length) fail("SENTINEL_REPOSITORY_DUPLICATE");
  return Object.freeze({
    observedAt: new Date(Date.parse(sentinel.generatedAt)).toISOString(),
    runId: typeof sentinel.runId === "string" ? sentinel.runId : "unknown",
    status: sentinel.status || "unknown",
    repositories,
  });
}

function assessSentinel(sentinel, scope, excludedIds) {
  const configured = new Set(sentinel.repositories.map((entry) => entry.id));
  for (const id of excludedIds) {
    if (!configured.has(id)) fail(`EXCLUSION_NOT_CONFIGURED:${id}`);
  }
  const inScope = sentinel.repositories.filter((entry) => !excludedIds.has(entry.id));
  if (inScope.length === 0) fail("SENTINEL_IN_SCOPE_EMPTY");
  const required = new Set(scope.requiredPollStatuses);
  const failed = inScope.filter((entry) => !required.has(entry.pollStatus));
  const succeeded = inScope.length - failed.length;
  const candidateChanges = inScope.filter((entry) => entry.pollStatus === "candidate-change").map((entry) => entry.id);
  return Object.freeze({
    observedAt: sentinel.observedAt,
    runId: sentinel.runId,
    status: sentinel.status,
    attempted: inScope.length,
    succeeded,
    failed: failed.map((entry) => Object.freeze({ id: entry.id, pollStatus: entry.pollStatus })),
    candidateChanges: Object.freeze(candidateChanges.sort()),
    excluded: scope.excludedRepositories.map((entry) => Object.freeze({ id: entry.id, reason: entry.reason })),
    ok: failed.length === 0,
  });
}

function exclusionEvidence(assessment) {
  return assessment.excluded.map((entry) => `excluded configured repository ${entry.id}: ${audit.sanitizeText(entry.reason)}`);
}

function evidenceFor(assessment, sentinelRel, row) {
  const evidence = [
    `${sentinelRel}#repositories`,
    `official-deployed-delta-sentinel/v1 run=${audit.sanitizeText(assessment.runId)} status=${assessment.status} observedAt=${assessment.observedAt}`,
    `bounded sentinel polled ${assessment.succeeded}/${assessment.attempted} in-scope configured repositories successfully`,
    `candidate-change=${assessment.candidateChanges.length ? assessment.candidateChanges.join(", ") : "none"}`,
    ...exclusionEvidence(assessment),
  ];
  if (assessment.ok && row.onFire.enabled) evidence.push(ON_FIRE_NOTE);
  return [...new Set(evidence.map(audit.sanitizeText).filter(Boolean))];
}

function buildBinder(row, rowConfig, assessment, config, sentinelRel) {
  const failures = assessment.ok ? [] : assessment.failed.map((entry) => `in-scope sentinel repository poll failed: ${entry.id} (${entry.pollStatus})`);
  const blockers = rowConfig.mode === "BLOCKED"
    ? [rowConfig.blocker, ...failures]
    : failures;
  const covered = rowConfig.mode === "COVERED" && assessment.ok;
  const registryBlocked = row.enumerationKind === "BLOCKED_REGISTRY";
  const reads = registryBlocked
    ? { attempted: 0, succeeded: 0, failed: 0, unclassifiedFailures: 0 }
    : {
      attempted: assessment.attempted,
      succeeded: assessment.succeeded,
      failed: covered ? 0 : assessment.failed.length,
      unclassifiedFailures: 0,
    };
  return {
    schema: BINDER_SCHEMA,
    observedAt: assessment.observedAt,
    chainId: row.chainId,
    family: row.family,
    triggerClass: row.triggerClass,
    enumeration: {
      kind: row.enumerationKind,
      ref: row.enumerationRef,
      boundDeclared: covered,
      successful: covered,
    },
    reads,
    classSemantics: { triggerClass: row.triggerClass, exact: covered },
    coverage: { complete: covered },
    onFire: { economics: covered, keylessFixedPinFork: covered, alert: covered },
    dispatchEnabled: covered,
    evidence: evidenceFor(assessment, sentinelRel, row),
    blockers: covered ? [] : [...new Set(blockers.map(audit.sanitizeText).filter(Boolean))],
  };
}

function buildBinders(options = {}) {
  const workspace = path.resolve(options.workspace || WORKSPACE);
  const configPath = path.resolve(options.configPath || CONFIG_PATH);
  const fsImpl = options.fsImpl || fs;
  const config = options.config || readJson(configPath);
  const universePath = resolveWorkspaceRelative(workspace, config.universePath);
  const sentinelPath = resolveWorkspaceRelative(workspace, config.sentinelPath);
  if (!universePath) fail("CONFIG_UNIVERSE_PATH_ESCAPES");
  if (!sentinelPath) fail("CONFIG_SENTINEL_PATH_ESCAPES");

  const universe = options.universe || JSON.parse(fsImpl.readFileSync(universePath, "utf8"));
  audit.validateUniverse(universe, { workspace });
  const { deltaRows, excludedIds } = validateConfig(config, universe);
  for (const row of deltaRows) {
    if (row.freshnessSeconds !== config.freshnessSeconds) fail(`UNIVERSE_FRESHNESS_MISMATCH:${row.id}`);
  }

  const sentinel = validateSentinel(JSON.parse(fsImpl.readFileSync(sentinelPath, "utf8")));
  const assessment = assessSentinel(sentinel, config.sentinelScope, excludedIds);
  const sentinelRel = config.sentinelPath;
  const binders = deltaRows.map((row) => {
    const rowConfig = config.rows[row.id];
    const value = buildBinder(row, rowConfig, assessment, config, sentinelRel);
    return Object.freeze({ id: row.id, artifactPath: `${config.outputDir}/${row.id}.json`, value });
  });
  const written = [];
  if (options.apply) {
    for (const binder of binders) {
      const target = resolveWorkspaceRelative(workspace, binder.artifactPath);
      if (!target) fail(`BINDER_PATH_ESCAPES:${binder.id}`);
      audit.atomicWriteJson(target, binder.value, { fsImpl });
      written.push(binder.artifactPath);
    }
  }
  return Object.freeze({
    config,
    universe,
    assessment,
    binders,
    written,
    covered: binders.filter((binder) => binder.value.coverage.complete).length,
    blocked: binders.filter((binder) => !binder.value.coverage.complete).length,
  });
}

function checkUniverseWiring(universe, config) {
  const problems = [];
  for (const row of universe.rows.filter((entry) => entry.triggerClass === "D")) {
    const rowConfig = config.rows[row.id];
    const expectedPath = `${config.outputDir}/${row.id}.json`;
    const expectedEnabled = rowConfig.mode === "COVERED";
    if (row.artifactPath !== expectedPath) problems.push(`${row.id}: artifactPath=${row.artifactPath} expected=${expectedPath}`);
    if (row.freshnessSeconds !== config.freshnessSeconds) problems.push(`${row.id}: freshnessSeconds=${row.freshnessSeconds} expected=${config.freshnessSeconds}`);
    if (row.onFire.enabled !== expectedEnabled) problems.push(`${row.id}: onFire.enabled=${row.onFire.enabled} expected=${expectedEnabled}`);
  }
  return problems;
}

function parseOptions(argv) {
  const unknown = argv.filter((arg) => !["--check", "--apply"].includes(arg));
  if (unknown.length || (argv.includes("--check") && argv.includes("--apply"))) {
    throw new Error("usage: build-trigger-coverage-delta-binders.js [--check|--apply]");
  }
  return { apply: argv.includes("--apply"), check: argv.includes("--check") };
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseOptions(argv);
    const result = buildBinders({ apply: options.apply });
    if (options.check) {
      const problems = checkUniverseWiring(result.universe, result.config);
      if (problems.length) {
        for (const problem of problems) process.stderr.write(`delta-binders check failed: ${audit.sanitizeText(problem)}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`delta-binders check ok: rows=${result.binders.length} covered=${result.covered} blocked=${result.blocked} observedAt=${result.assessment.observedAt}\n`);
      return;
    }
    process.stdout.write(`delta-binders ${options.apply ? "applied" : "dry-run"}: rows=${result.binders.length} covered=${result.covered} blocked=${result.blocked} observedAt=${result.assessment.observedAt}\n`);
    if (options.apply) {
      for (const file of result.written) process.stdout.write(`delta-binders wrote ${file}\n`);
    }
  } catch (error) {
    process.stderr.write(`delta-binders failed closed: ${audit.sanitizeText(error?.message || error)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  WORKSPACE, CONFIG_PATH, BINDER_SCHEMA, CONFIG_SCHEMA, SENTINEL_SCHEMA, MODES, SENTINEL_STATUSES,
  BinderError, validateConfig, validateSentinel, assessSentinel, buildBinder, buildBinders,
  checkUniverseWiring, parseOptions, resolveWorkspaceRelative,
};
