#!/usr/bin/env node
"use strict";

// Binder builder for the Morpho Blue O (oracle-market) and F (flash-liquidity/fee)
// trigger-coverage rows.
//
// O rows are bound to the live `morpho-frozen-oracle-status/read-only/v1` monitor
// artifact (tools/monitor-morpho-frozen-oracle.js, a persistent 300 s service).
// The binder is COVERED only when the bounded oracle-market observation is
// structurally complete: every declared market on the chain was observed with no
// read errors. Markets whose external reference price is unavailable are declared
// trigger-indeterminate and excluded from the trigger bound (they can never fire);
// this mirrors the covered L rows' declared oracle-unavailable exclusion.
//
// F rows are produced separately by tools/scan-morpho-f-coverage.js from the same
// monitor artifact; this builder owns the O rows only.
//
// Honesty properties:
// - `observedAt` is copied verbatim from the source artifact (`capturedAt`); the
//   builder never stamps wall-clock time, and is null for rows with no source.
// - Coverage fails closed: any market observation error emits a BLOCKED binder.
// - The declared enumeration (kind/ref) is copied verbatim from the universe row.

const fs = require("node:fs");
const path = require("node:path");
const audit = require("./audit-trigger-coverage-universe.js");

const WORKSPACE = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(__dirname, "trigger-coverage-morpho-binders.json");
const BINDER_SCHEMA = "trigger-coverage-evidence/v1";
const CONFIG_SCHEMA = "trigger-coverage-morpho-binders/v1";
const ORACLE_SCHEMA = "morpho-frozen-oracle-status/read-only/v1";
const FAMILY = "Morpho Blue";
// The F rows are produced by scan-morpho-f-coverage.js; this builder owns the O rows.
const CLASSES = Object.freeze(["O"]);
const MODES = Object.freeze(["COVERED", "BLOCKED"]);
const SOURCES = Object.freeze(["oracle", "none"]);
const CONFIG_KEYS = Object.freeze(["schema", "universePath", "oracleSourcePath", "outputDir", "freshnessSeconds", "rows", "reconciliation", "freshnessRationale"]);
const ROW_CONFIG_KEYS = Object.freeze(["source", "mode", "blocker", "evidence"]);
const ON_FIRE_NOTE = "on-fire economics = bounded exposure/impact bound (no profit claim); keyless fixed-pin fork = wired bounded state-consistency probe at the observation point (no state change); alert = wired";

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
function resolveWorkspaceRelative(workspace, relativePath) {
  if (!safeRelative(relativePath)) return null;
  const absolute = path.resolve(workspace, ...relativePath.split("/"));
  const prefix = `${path.resolve(workspace)}${path.sep}`.toLowerCase();
  return absolute.toLowerCase().startsWith(prefix) ? absolute : null;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function relPosix(workspace, target) { return path.relative(workspace, target).split(path.sep).join("/"); }

function morphoRowsOf(universe) {
  return universe.rows.filter((row) => row.family === FAMILY && CLASSES.includes(row.triggerClass));
}

function validateConfig(config, universe) {
  if (!exactKeys(config, CONFIG_KEYS)) fail("CONFIG_KEYS_INVALID");
  if (config.schema !== CONFIG_SCHEMA) fail("CONFIG_SCHEMA_INVALID");
  for (const key of ["universePath", "oracleSourcePath", "outputDir"]) {
    if (!safeRelative(config[key])) fail(`CONFIG_PATH_INVALID:${key}`);
  }
  if (!config.outputDir.startsWith("reports/")) fail("CONFIG_OUTPUT_DIR_INVALID");
  if (!Number.isSafeInteger(config.freshnessSeconds) || config.freshnessSeconds <= 0 || config.freshnessSeconds > 86400) {
    fail("CONFIG_FRESHNESS_INVALID");
  }
  if (typeof config.reconciliation !== "string" || !config.reconciliation.trim()) fail("CONFIG_RECONCILIATION_INVALID");
  if (typeof config.freshnessRationale !== "string" || !config.freshnessRationale.trim()) fail("CONFIG_FRESHNESS_RATIONALE_INVALID");
  const rows = morphoRowsOf(universe);
  const ids = rows.map((row) => row.id).sort();
  if (!isObject(config.rows) || JSON.stringify(Object.keys(config.rows).sort()) !== JSON.stringify(ids)) {
    fail("CONFIG_ROW_SET_INVALID");
  }
  for (const row of rows) {
    const rowConfig = config.rows[row.id];
    if (!isObject(rowConfig) || !SOURCES.includes(rowConfig.source) || !MODES.includes(rowConfig.mode)
        || Object.keys(rowConfig).some((key) => !ROW_CONFIG_KEYS.includes(key))) fail(`CONFIG_ROW_INVALID:${row.id}`);
    if (rowConfig.mode === "BLOCKED") {
      if (typeof rowConfig.blocker !== "string" || !rowConfig.blocker.trim()) fail(`CONFIG_ROW_BLOCKER_MISSING:${row.id}`);
      if (!Array.isArray(rowConfig.evidence) || rowConfig.evidence.length === 0
          || !rowConfig.evidence.every((line) => typeof line === "string" && line.trim())) fail(`CONFIG_ROW_EVIDENCE_INVALID:${row.id}`);
    }
    if (rowConfig.mode === "COVERED" && rowConfig.blocker !== undefined) fail(`CONFIG_ROW_BLOCKER_UNEXPECTED:${row.id}`);
    if (rowConfig.source === "oracle" && row.triggerClass !== "O") fail(`CONFIG_ROW_SOURCE_CLASS_INVALID:${row.id}`);
    if (!row.artifactPath.startsWith(`${config.outputDir}/`) || !row.artifactPath.endsWith(".json")) {
      fail(`UNIVERSE_ARTIFACT_MISMATCH:${row.id}`);
    }
  }
  return rows;
}

function oracleAssessment(artifact, chainId) {
  const markets = artifact.markets.filter((market) => market.chainId === chainId);
  const failed = markets.filter((market) => Array.isArray(market.errors) && market.errors.length > 0);
  const referenceUnavailable = markets.filter((market) => market.status === "REFERENCE_UNAVAILABLE");
  const statuses = {};
  for (const market of markets) statuses[market.status] = (statuses[market.status] || 0) + 1;
  return Object.freeze({
    attempted: markets.length,
    succeeded: markets.length - failed.length,
    failed: failed.length,
    referenceUnavailable: referenceUnavailable.map((market) => market.market),
    statuses,
    complete: markets.length > 0 && failed.length === 0,
  });
}

function oracleBinder(row, rowConfig, artifact, assessment, config) {
  const covered = rowConfig.mode === "COVERED" && assessment.complete;
  const blockers = covered ? [] : [
    ...(rowConfig.blocker ? [rowConfig.blocker] : []),
    ...(assessment.attempted === 0 ? [`no ${row.family} oracle markets observed for chain ${row.chainId}`] : []),
    ...(assessment.failed > 0 ? [`${assessment.failed} of ${assessment.attempted} market observations reported read errors`] : []),
  ];
  const evidence = [
    `${config.oracleSourcePath}#markets`,
    `${ORACLE_SCHEMA} capturedAt=${artifact.capturedAt} trackedMarkets=${artifact.markets.length}`,
    `per-market on-chain market state + oracle price + feed latestRoundData at the monitor's public read-only pins; the external reference is an auxiliary trigger-edge input`,
    `market statuses: ${Object.entries(assessment.statuses).map(([status, count]) => `${status}=${count}`).join(", ")}`,
  ];
  if (assessment.referenceUnavailable.length > 0) {
    evidence.push(`reference-unavailable markets excluded from the trigger bound (never fire, re-checked every cycle): ${assessment.referenceUnavailable.join(", ")}`);
  }
  if (covered) evidence.push(ON_FIRE_NOTE);
  return {
    schema: BINDER_SCHEMA,
    observedAt: artifact.capturedAt,
    chainId: row.chainId,
    family: row.family,
    triggerClass: row.triggerClass,
    enumeration: {
      kind: row.enumerationKind,
      ref: row.enumerationRef,
      boundDeclared: covered,
      successful: covered,
    },
    reads: { attempted: assessment.attempted, succeeded: assessment.succeeded, failed: covered ? 0 : assessment.failed, unclassifiedFailures: 0 },
    classSemantics: { triggerClass: row.triggerClass, exact: covered },
    coverage: { complete: covered },
    onFire: { economics: covered, keylessFixedPinFork: covered, alert: covered },
    dispatchEnabled: covered,
    evidence: [...new Set(evidence.map(audit.sanitizeText).filter(Boolean))],
    blockers: [...new Set(blockers.map(audit.sanitizeText).filter(Boolean))],
  };
}

function gapBinder(row, rowConfig) {
  return {
    schema: BINDER_SCHEMA,
    observedAt: null,
    chainId: row.chainId,
    family: row.family,
    triggerClass: row.triggerClass,
    enumeration: {
      kind: row.enumerationKind,
      ref: row.enumerationRef,
      boundDeclared: false,
      successful: false,
    },
    reads: { attempted: 0, succeeded: 0, failed: 0, unclassifiedFailures: 0 },
    classSemantics: { triggerClass: row.triggerClass, exact: false },
    coverage: { complete: false },
    onFire: { economics: false, keylessFixedPinFork: false, alert: false },
    dispatchEnabled: false,
    evidence: [...new Set(rowConfig.evidence.map(audit.sanitizeText).filter(Boolean))],
    blockers: [...new Set([rowConfig.blocker].map(audit.sanitizeText).filter(Boolean))],
  };
}

function buildBinders(options = {}) {
  const workspace = path.resolve(options.workspace || WORKSPACE);
  const configPath = path.resolve(options.configPath || CONFIG_PATH);
  const fsImpl = options.fsImpl || fs;
  const config = options.config || readJson(configPath);
  const universePath = resolveWorkspaceRelative(workspace, config.universePath);
  const oracleSourcePath = resolveWorkspaceRelative(workspace, config.oracleSourcePath);
  if (!universePath || !oracleSourcePath) fail("CONFIG_PATH_ESCAPES");

  const universe = options.universe || JSON.parse(fsImpl.readFileSync(universePath, "utf8"));
  audit.validateUniverse(universe, { workspace });
  const rows = validateConfig(config, universe);
  for (const row of rows) {
    if (row.freshnessSeconds !== config.freshnessSeconds) fail(`UNIVERSE_FRESHNESS_MISMATCH:${row.id}`);
  }

  const artifact = options.artifact || JSON.parse(fsImpl.readFileSync(oracleSourcePath, "utf8"));
  if (!isObject(artifact) || artifact.schema !== ORACLE_SCHEMA || !iso(artifact.capturedAt) || !Array.isArray(artifact.markets)) {
    fail("ORACLE_SOURCE_INVALID");
  }

  const binders = rows.map((row) => {
    const rowConfig = config.rows[row.id];
    const value = rowConfig.source === "oracle"
      ? oracleBinder(row, rowConfig, artifact, oracleAssessment(artifact, row.chainId), config)
      : gapBinder(row, rowConfig);
    return Object.freeze({ id: row.id, artifactPath: row.artifactPath, value });
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
    config, universe, artifact, binders, written,
    covered: binders.filter((binder) => binder.value.coverage.complete).length,
    blocked: binders.filter((binder) => !binder.value.coverage.complete).length,
  });
}

function checkUniverseWiring(universe, config) {
  const problems = [];
  for (const row of morphoRowsOf(universe)) {
    const rowConfig = config.rows[row.id];
    const expectedEnabled = rowConfig.mode === "COVERED";
    if (!row.artifactPath.startsWith(`${config.outputDir}/`) || !row.artifactPath.endsWith(".json")) {
      problems.push(`${row.id}: artifactPath=${row.artifactPath} not under ${config.outputDir}`);
    }
    if (row.freshnessSeconds !== config.freshnessSeconds) problems.push(`${row.id}: freshnessSeconds=${row.freshnessSeconds} expected=${config.freshnessSeconds}`);
    if (row.onFire.enabled !== expectedEnabled) problems.push(`${row.id}: onFire.enabled=${row.onFire.enabled} expected=${expectedEnabled}`);
  }
  return problems;
}

function parseOptions(argv) {
  const unknown = argv.filter((arg) => !["--check", "--apply"].includes(arg));
  if (unknown.length || (argv.includes("--check") && argv.includes("--apply"))) {
    throw new Error("usage: build-trigger-coverage-morpho-binders.js [--check|--apply]");
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
        for (const problem of problems) process.stderr.write(`morpho-binders check failed: ${audit.sanitizeText(problem)}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`morpho-binders check ok: rows=${result.binders.length} covered=${result.covered} blocked=${result.blocked} observedAt=${result.artifact.capturedAt}\n`);
      return;
    }
    process.stdout.write(`morpho-binders ${options.apply ? "applied" : "dry-run"}: rows=${result.binders.length} covered=${result.covered} blocked=${result.blocked} observedAt=${result.artifact.capturedAt}\n`);
    if (options.apply) for (const file of result.written) process.stdout.write(`morpho-binders wrote ${file}\n`);
  } catch (error) {
    process.stderr.write(`morpho-binders failed closed: ${audit.sanitizeText(error?.message || error)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  WORKSPACE, CONFIG_PATH, BINDER_SCHEMA, CONFIG_SCHEMA, ORACLE_SCHEMA, FAMILY, CLASSES, MODES, SOURCES,
  BinderError, morphoRowsOf, validateConfig, oracleAssessment, oracleBinder, gapBinder, buildBinders,
  checkUniverseWiring, parseOptions, relPosix,
};
