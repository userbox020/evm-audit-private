#!/usr/bin/env node
"use strict";

// Gap-binder builder for the Balancer trigger-coverage rows that have no
// conforming bounded observation.
//
// Coverage for Balancer is produced by the live producers:
// - X / R (V2 Ethereum and V2 X Base) by tools/scan-cross-dex-arbitrage.js and
//   tools/scan-balancer-v2-join-exit.js (run every 240 s by
//   tools/run-profit-trigger-watch.js).
// - F (V2 Ethereum and Base) by tools/scan-cross-dex-arbitrage.js.
//
// The remaining rows have no bounded keyless producer. This builder emits a
// recognized `trigger-coverage-evidence/v1` binder for each one so the audit
// reports the exact declared gap (rather than "artifact is not a recognized
// trigger coverage schema" or a bare filesystem absence). It never claims
// coverage:
// - `observedAt` is copied verbatim from the declared source artifact
//   (`generatedAt`/`scannedAt`) when one exists, and is null otherwise. No
//   wall-clock stamping.
// - `enumeration.boundDeclared=false`, `successful=false`, `coverage.complete=false`,
//   `dispatchEnabled=false` and every on-fire stage is false.
// - The declared blocker and evidence lines are config-owned and validated to
//   match the blocked Balancer row set exactly (fail closed on drift).

const fs = require("node:fs");
const path = require("node:path");
const audit = require("./audit-trigger-coverage-universe.js");

const WORKSPACE = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(__dirname, "trigger-coverage-balancer-binders.json");
const BINDER_SCHEMA = "trigger-coverage-evidence/v1";
const CONFIG_SCHEMA = "trigger-coverage-balancer-binders/v1";
const MODES = Object.freeze(["BLOCKED"]);
const CONFIG_KEYS = Object.freeze(["schema", "universePath", "outputDir", "rows"]);
const ROW_KEYS = Object.freeze(["source", "mode", "blocker", "evidence"]);
const BALANCER_FAMILIES = Object.freeze(["Balancer V2", "Balancer V3"]);

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

// Blocked, non-D Balancer rows are exactly the rows this builder owns: every
// other Balancer row is produced (or refreshed) by the live scanners.
function blockedBalancerRows(universe) {
  return universe.rows.filter((row) => BALANCER_FAMILIES.includes(row.family)
    && row.triggerClass !== "D" && row.onFire.enabled === false);
}

function validateConfig(config, universe, workspace) {
  if (!exactKeys(config, CONFIG_KEYS)) fail("CONFIG_KEYS_INVALID");
  if (config.schema !== CONFIG_SCHEMA) fail("CONFIG_SCHEMA_INVALID");
  if (!safeRelative(config.universePath)) fail("CONFIG_PATH_INVALID:universePath");
  if (!safeRelative(config.outputDir) || !config.outputDir.startsWith("reports/")) fail("CONFIG_OUTPUT_DIR_INVALID");
  const rows = blockedBalancerRows(universe);
  const ids = rows.map((row) => row.id).sort();
  if (!isObject(config.rows) || JSON.stringify(Object.keys(config.rows).sort()) !== JSON.stringify(ids)) {
    fail("CONFIG_ROW_SET_INVALID");
  }
  for (const row of rows) {
    const rowConfig = config.rows[row.id];
    if (!isObject(rowConfig) || !MODES.includes(rowConfig.mode)
        || Object.keys(rowConfig).some((key) => !ROW_KEYS.includes(key))) fail(`CONFIG_ROW_INVALID:${row.id}`);
    if (rowConfig.mode === "BLOCKED" && (typeof rowConfig.blocker !== "string" || !rowConfig.blocker.trim())) {
      fail(`CONFIG_ROW_BLOCKER_MISSING:${row.id}`);
    }
    if (rowConfig.source !== null && !safeRelative(rowConfig.source)) fail(`CONFIG_ROW_SOURCE_INVALID:${row.id}`);
    if (!Array.isArray(rowConfig.evidence) || rowConfig.evidence.length === 0
        || !rowConfig.evidence.every((line) => typeof line === "string" && line.trim())) {
      fail(`CONFIG_ROW_EVIDENCE_INVALID:${row.id}`);
    }
    if (!row.artifactPath.startsWith(`${config.outputDir}/`) || !row.artifactPath.endsWith(".json")) {
      fail(`UNIVERSE_ARTIFACT_MISMATCH:${row.id}`);
    }
  }
  return rows;
}

function sourceTimestamp(source) {
  if (!source) return null;
  for (const candidate of [source.generatedAt, source.scannedAt, source.observedAt]) {
    if (iso(candidate)) return candidate;
  }
  return null;
}

function buildBinder(row, rowConfig, source) {
  const blockers = [rowConfig.blocker];
  if (rowConfig.source && !source) blockers.push(`declared source artifact ${rowConfig.source} is absent`);
  return {
    schema: BINDER_SCHEMA,
    observedAt: sourceTimestamp(source),
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
    evidence: [...new Set([...rowConfig.evidence, ...(rowConfig.source ? [rowConfig.source] : [])].map(audit.sanitizeText).filter(Boolean))],
    blockers: [...new Set(blockers.map(audit.sanitizeText).filter(Boolean))],
  };
}

function buildBinders(options = {}) {
  const workspace = path.resolve(options.workspace || WORKSPACE);
  const configPath = path.resolve(options.configPath || CONFIG_PATH);
  const fsImpl = options.fsImpl || fs;
  const config = options.config || readJson(configPath);
  const universePath = resolveWorkspaceRelative(workspace, config.universePath);
  if (!universePath) fail("CONFIG_PATH_ESCAPES");
  const universe = options.universe || JSON.parse(fsImpl.readFileSync(universePath, "utf8"));
  audit.validateUniverse(universe, { workspace });
  const rows = validateConfig(config, universe, workspace);

  const binders = rows.map((row) => {
    const rowConfig = config.rows[row.id];
    let source = null;
    if (rowConfig.source) {
      const sourcePath = resolveWorkspaceRelative(workspace, rowConfig.source);
      if (!sourcePath) fail(`CONFIG_ROW_SOURCE_ESCAPES:${row.id}`);
      try { source = JSON.parse(fsImpl.readFileSync(sourcePath, "utf8")); } catch (_) { source = null; }
    }
    return Object.freeze({
      id: row.id,
      artifactPath: row.artifactPath,
      value: buildBinder(row, rowConfig, source),
    });
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
    config, universe, binders, written,
    covered: binders.filter((binder) => binder.value.coverage.complete).length,
    blocked: binders.filter((binder) => !binder.value.coverage.complete).length,
  });
}

function checkUniverseWiring(universe, config) {
  const problems = [];
  for (const row of blockedBalancerRows(universe)) {
    if (!row.artifactPath.startsWith(`${config.outputDir}/`) || !row.artifactPath.endsWith(".json")) {
      problems.push(`${row.id}: artifactPath=${row.artifactPath} not under ${config.outputDir}`);
    }
    if (row.onFire.enabled !== false) problems.push(`${row.id}: onFire.enabled=${row.onFire.enabled} expected=false`);
  }
  return problems;
}

function parseOptions(argv) {
  const unknown = argv.filter((arg) => !["--check", "--apply"].includes(arg));
  if (unknown.length || (argv.includes("--check") && argv.includes("--apply"))) {
    throw new Error("usage: build-trigger-coverage-balancer-binders.js [--check|--apply]");
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
        for (const problem of problems) process.stderr.write(`balancer-binders check failed: ${audit.sanitizeText(problem)}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`balancer-binders check ok: rows=${result.binders.length} blocked=${result.blocked}\n`);
      return;
    }
    process.stdout.write(`balancer-binders ${options.apply ? "applied" : "dry-run"}: rows=${result.binders.length} blocked=${result.blocked}\n`);
    if (options.apply) for (const file of result.written) process.stdout.write(`balancer-binders wrote ${file}\n`);
  } catch (error) {
    process.stderr.write(`balancer-binders failed closed: ${audit.sanitizeText(error?.message || error)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  WORKSPACE, CONFIG_PATH, BINDER_SCHEMA, CONFIG_SCHEMA, MODES, BALANCER_FAMILIES,
  BinderError, blockedBalancerRows, validateConfig, sourceTimestamp, buildBinder,
  buildBinders, checkUniverseWiring, parseOptions,
};
