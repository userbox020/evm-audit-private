#!/usr/bin/env node
"use strict";

// Binder builder for the Ethereum Aave V4 L/O trigger-coverage rows.
//
// It binds `ethereum-aave-v4-l` (bounded borrower observation) and
// `ethereum-aave-v4-o` (bounded reserve-oracle observation) to real, on-disk
// Aave V4 observation artifacts and emits `trigger-coverage-evidence/v1` binders
// under `reports/monitor/trigger-coverage/`.
//
// Honesty properties:
// - `observedAt` is copied verbatim from the source artifact (`generatedAt`); the
//   builder never stamps wall-clock time.
// - The O row is only covered when the topology envelope is sample-complete,
//   provenance-bound to a pinned registry commit, and every declared reserve/oracle
//   read succeeded; otherwise it is emitted BLOCKED (fail-closed).
// - The L row is declared BLOCKED in config because the borrower monitor is
//   SOURCE_INCOMPLETE (sampleComplete=false, truncated, dust-filtered); the binder
//   records the exact gap instead of forcing coverage.
// - `coverage.complete` is scoped strictly to the declared bounded observation and
//   the evidence says so.

const fs = require("node:fs");
const path = require("node:path");
const audit = require("./audit-trigger-coverage-universe.js");
const sourceCoverage = require("./aave-source-coverage.js");

const WORKSPACE = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(__dirname, "trigger-coverage-aave-v4-binders.json");
const BINDER_SCHEMA = "trigger-coverage-evidence/v1";
const CONFIG_SCHEMA = "trigger-coverage-aave-v4-binders/v1";
const TOPOLOGY_SCANNER = "tools/scan-aave-v4-hubs.js";
const MONITOR_SCANNER = "tools/watch-aave-v4-liquidation-triggers.js";
const FAMILY = "Aave V4";
const CHAIN_ID = 1;
const MODES = Object.freeze(["COVERED", "BLOCKED"]);
const SOURCES = Object.freeze(["topology", "monitor"]);
const CONFIG_KEYS = Object.freeze([
  "schema", "universePath", "topologyPath", "monitorPath", "outputDir",
  "freshnessSeconds", "rows", "reconciliation", "freshnessRationale",
]);
const ROW_CONFIG_KEYS = Object.freeze(["source", "mode", "blocker"]);

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
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function relPosix(workspace, target) { return path.relative(workspace, target).split(path.sep).join("/"); }

function aaveRowsOf(universe) {
  return universe.rows.filter((row) => row.family === FAMILY && row.chainId === CHAIN_ID
    && (row.triggerClass === "L" || row.triggerClass === "O"));
}

function validateConfig(config, universe) {
  if (!exactKeys(config, CONFIG_KEYS)) fail("CONFIG_KEYS_INVALID");
  if (config.schema !== CONFIG_SCHEMA) fail("CONFIG_SCHEMA_INVALID");
  for (const key of ["universePath", "topologyPath", "monitorPath", "outputDir"]) {
    if (!safeRelative(config[key])) fail(`CONFIG_PATH_INVALID:${key}`);
  }
  if (!config.outputDir.startsWith("reports/")) fail("CONFIG_OUTPUT_DIR_INVALID");
  if (!Number.isSafeInteger(config.freshnessSeconds) || config.freshnessSeconds <= 0 || config.freshnessSeconds > 86400) {
    fail("CONFIG_FRESHNESS_INVALID");
  }
  if (typeof config.reconciliation !== "string" || !config.reconciliation.trim()) fail("CONFIG_RECONCILIATION_INVALID");
  if (typeof config.freshnessRationale !== "string" || !config.freshnessRationale.trim()) fail("CONFIG_FRESHNESS_RATIONALE_INVALID");
  const rows = aaveRowsOf(universe);
  const ids = rows.map((row) => row.id).sort();
  if (!isObject(config.rows) || JSON.stringify(Object.keys(config.rows).sort()) !== JSON.stringify(ids)) {
    fail("CONFIG_ROW_SET_INVALID");
  }
  for (const row of rows) {
    const rowConfig = config.rows[row.id];
    if (!isObject(rowConfig) || !SOURCES.includes(rowConfig.source) || !MODES.includes(rowConfig.mode)
        || Object.keys(rowConfig).some((key) => !ROW_CONFIG_KEYS.includes(key))) fail(`CONFIG_ROW_INVALID:${row.id}`);
    if (rowConfig.mode === "BLOCKED" && (typeof rowConfig.blocker !== "string" || !rowConfig.blocker.trim())) {
      fail(`CONFIG_ROW_BLOCKER_MISSING:${row.id}`);
    }
    if (rowConfig.mode === "COVERED" && rowConfig.blocker !== undefined) fail(`CONFIG_ROW_BLOCKER_UNEXPECTED:${row.id}`);
  }
  return rows;
}

function collectOracleRows(topology) {
  const oracle = { total: 0, withAddress: 0, withSource: 0, withPrice: 0, withReference: 0, withErrors: 0 };
  for (const hub of topology.hubs || []) {
    for (const dependency of hub.listedSpokeDependencies || []) {
      for (const linked of dependency.linkedAssets || []) {
        const data = linked?.reserve?.oracleData;
        if (!isObject(data)) continue;
        oracle.total += 1;
        if (typeof data.address === "string" && data.address) oracle.withAddress += 1;
        if (typeof data.source === "string" && data.source) oracle.withSource += 1;
        if (Number.isFinite(data.price)) oracle.withPrice += 1;
        if (Number.isFinite(data.referencePriceUsd)) oracle.withReference += 1;
        if (isObject(data.errors) && Object.values(data.errors).some(Boolean)) oracle.withErrors += 1;
      }
    }
  }
  return oracle;
}

function topologyEvidence(topology, oracle) {
  const sc = topology.sourceCoverage;
  const universe = sc.topologyUniverse;
  return [
    "reports/raw/fast/aave-v4-hubs.json#sourceCoverage",
    `Aave V4 topology registry ${universe.registry}@${universe.version} commit ${universe.commit} pinBlock ${universe.pinBlock} inventoryDigest ${universe.inventoryDigest}`,
    `declared-static hub set bound=${universe.bound} hubs=${sc.hubsObserved}/${sc.hubsExpected} assets=${sc.assetsObserved}/${sc.assetsExpected} spokes=${sc.spokesObserved}/${sc.spokesExpected} reserveLinks=${sc.reserveLinksObserved}/${sc.reserveLinksExpected}`,
    `per-reserve oracle observation read cleanly: ${oracle.total} reserve/oracle rows with address+source+price (${oracle.withReference} with reference price), ${oracle.withErrors} errors`,
    `bounded observational scope: sampleComplete=${sc.sampleComplete} complete=${sc.complete} exhaustiveProof=${sc.exhaustiveProof === null ? "null" : "present"}; coverage.complete is scoped to this declared bounded sample-complete topology oracle observation, not an exhaustive position proof`,
  ];
}

function assessTopology(topology) {
  if (!isObject(topology) || topology.scanner !== TOPOLOGY_SCANNER || !iso(topology.generatedAt)) fail("TOPOLOGY_INVALID");
  if (!isObject(topology.chain) || topology.chain.id !== CHAIN_ID) fail("TOPOLOGY_CHAIN_INVALID");
  const sc = topology.sourceCoverage;
  const envelope = sourceCoverage.validateAaveSourceCoverageEnvelope(sc, {
    protocolVersion: "V4", coverageKind: "topology", requireSampleComplete: true,
  });
  if (!envelope.valid) fail(`TOPOLOGY_COVERAGE_INVALID:${envelope.failures.join(",")}`);
  if (sourceCoverage.boundTopologyProvenanceFailure(sc.topologyUniverse)) fail("TOPOLOGY_PROVENANCE_INVALID");
  if (sc.complete !== false || sc.sampleComplete !== true) fail("TOPOLOGY_SCOPE_INVALID");
  if (sc.hubsExpected !== sc.hubsObserved || sc.assetsExpected !== sc.assetsObserved || sc.spokesExpected !== sc.spokesObserved) {
    fail("TOPOLOGY_COUNTS_INVALID");
  }
  if (sc.reserveLinksExpected !== sc.reserveLinksObserved || sc.reserveLinksObserved !== sc.reserveLinksConsumed) {
    fail("TOPOLOGY_LINKS_INVALID");
  }
  if (sc.stateReadsSucceeded !== sc.stateReadsAttempted || sc.stateReadsFailed !== 0) fail("TOPOLOGY_READS_INVALID");
  const oracle = collectOracleRows(topology);
  if (oracle.total === 0 || oracle.total !== sc.reserveLinksObserved
      || oracle.withAddress !== oracle.total || oracle.withPrice !== oracle.total || oracle.withErrors !== 0) {
    fail("TOPOLOGY_ORACLE_INVALID");
  }
  return Object.freeze({
    ok: true,
    observedAt: new Date(Date.parse(topology.generatedAt)).toISOString(),
    reads: { attempted: count(sc.stateReadsAttempted), succeeded: count(sc.stateReadsSucceeded), failed: 0, unclassifiedFailures: 0 },
    evidence: topologyEvidence(topology, oracle),
    blockers: [],
  });
}

function monitorBlockers(monitor) {
  const sc = monitor.sourceCoverage;
  const summary = isObject(monitor.latest) && isObject(monitor.latest.summary) ? monitor.latest.summary : {};
  const blockers = [];
  if (Array.isArray(sc.errors) && sc.errors.length) blockers.push(`monitor source errors: ${sc.errors.join(", ")}`);
  if (sc.sampleComplete !== true) blockers.push("monitor sampleComplete is not proven");
  if (sc.wasTruncated === true) blockers.push(`per-spoke borrower cap truncated the sample (limit ${count(sc.truncationLimit)})`);
  if (count(sc.discoveredBorrowers) !== count(sc.checkedBorrowers)) {
    blockers.push(`borrower sample checked ${count(sc.checkedBorrowers)} of ${count(sc.discoveredBorrowers)} discovered`);
  }
  if (summary.sampleTelemetryUsable === false) blockers.push("monitor sample telemetry is not usable");
  return blockers;
}

function assessMonitor(monitor) {
  if (!isObject(monitor) || monitor.scanner !== MONITOR_SCANNER || !iso(monitor.generatedAt)) fail("MONITOR_INVALID");
  const monitorChain = isObject(monitor.latest) && isObject(monitor.latest.chain) ? monitor.latest.chain : monitor.chain;
  if (!isObject(monitorChain) || monitorChain.id !== CHAIN_ID) fail("MONITOR_CHAIN_INVALID");
  const sc = monitor.sourceCoverage;
  if (!isObject(sc) || sc.schema !== sourceCoverage.AAVE_SOURCE_COVERAGE_SCHEMA
      || sc.protocolVersion !== "V4" || sc.coverageKind !== "monitor") fail("MONITOR_COVERAGE_SHAPE_INVALID");
  const summary = isObject(monitor.latest) && isObject(monitor.latest.summary) ? monitor.latest.summary : {};
  const blockers = monitorBlockers(monitor);
  return Object.freeze({
    ok: sc.sampleComplete === true,
    observedAt: new Date(Date.parse(monitor.generatedAt)).toISOString(),
    reads: { attempted: count(sc.stateReadsAttempted), succeeded: count(sc.stateReadsSucceeded), failed: count(sc.stateReadsFailed), unclassifiedFailures: 0 },
    evidence: [
      "reports/raw/fast/aave-v4-liquidation-watch.json#sourceCoverage",
      "reports/raw/fast/aave-v4-hubs.json#sourceCoverage",
      `monitor sampleComplete=${sc.sampleComplete} errors=${Array.isArray(sc.errors) ? sc.errors.join(",") : ""} discovered=${count(sc.discoveredBorrowers)} checked=${count(sc.checkedBorrowers)} truncationLimit=${count(sc.truncationLimit)} wasTruncated=${sc.wasTruncated === true}`,
      `monitor sourceHealth=${typeof monitor.latest?.sourceHealth === "string" ? monitor.latest.sourceHealth : "unknown"} sampleTelemetryUsable=${summary.sampleTelemetryUsable === true}`,
      `bounded read accounting: stateReads ${count(sc.stateReadsSucceeded)}/${count(sc.stateReadsAttempted)} succeeded, ${count(sc.stateReadsFailed)} failed`,
    ],
    blockers,
  });
}

function buildBinder(row, rowConfig, assessment, config) {
  const covered = rowConfig.mode === "COVERED" && assessment.ok;
  const blockers = covered ? [] : [
    ...(rowConfig.blocker ? [rowConfig.blocker] : []),
    ...assessment.blockers,
  ];
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
    reads: assessment.reads,
    classSemantics: { triggerClass: row.triggerClass, exact: covered },
    coverage: { complete: covered },
    onFire: { economics: covered, keylessFixedPinFork: covered, alert: covered },
    dispatchEnabled: covered,
    evidence: [...new Set(assessment.evidence.map(audit.sanitizeText).filter(Boolean))],
    blockers: [...new Set(blockers.map(audit.sanitizeText).filter(Boolean))],
  };
}

function buildBinders(options = {}) {
  const workspace = path.resolve(options.workspace || WORKSPACE);
  const configPath = path.resolve(options.configPath || CONFIG_PATH);
  const fsImpl = options.fsImpl || fs;
  const config = options.config || readJson(configPath);
  const universePath = resolveWorkspaceRelative(workspace, config.universePath);
  const topologyPath = resolveWorkspaceRelative(workspace, config.topologyPath);
  const monitorPath = resolveWorkspaceRelative(workspace, config.monitorPath);
  if (!universePath || !topologyPath || !monitorPath) fail("CONFIG_PATH_ESCAPES");

  const universe = options.universe || JSON.parse(fsImpl.readFileSync(universePath, "utf8"));
  audit.validateUniverse(universe, { workspace });
  const rows = validateConfig(config, universe);
  for (const row of rows) {
    if (row.freshnessSeconds !== config.freshnessSeconds) fail(`UNIVERSE_FRESHNESS_MISMATCH:${row.id}`);
  }

  const topology = JSON.parse(fsImpl.readFileSync(topologyPath, "utf8"));
  const monitor = JSON.parse(fsImpl.readFileSync(monitorPath, "utf8"));
  const assessments = {
    topology: assessTopology(topology),
    monitor: assessMonitor(monitor),
  };

  const binders = rows.map((row) => {
    const rowConfig = config.rows[row.id];
    const assessment = assessments[rowConfig.source];
    return Object.freeze({ id: row.id, artifactPath: `${config.outputDir}/${row.id}.json`, value: buildBinder(row, rowConfig, assessment, config) });
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
    config, universe, assessments, binders, written,
    covered: binders.filter((binder) => binder.value.coverage.complete).length,
    blocked: binders.filter((binder) => !binder.value.coverage.complete).length,
  });
}

function checkUniverseWiring(universe, config) {
  const problems = [];
  for (const row of aaveRowsOf(universe)) {
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
    throw new Error("usage: build-trigger-coverage-aave-v4-binders.js [--check|--apply]");
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
        for (const problem of problems) process.stderr.write(`aave-v4-binders check failed: ${audit.sanitizeText(problem)}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`aave-v4-binders check ok: rows=${result.binders.length} covered=${result.covered} blocked=${result.blocked} observedAt=${result.assessments.topology.observedAt}\n`);
      return;
    }
    process.stdout.write(`aave-v4-binders ${options.apply ? "applied" : "dry-run"}: rows=${result.binders.length} covered=${result.covered} blocked=${result.blocked}\n`);
    if (options.apply) for (const file of result.written) process.stdout.write(`aave-v4-binders wrote ${file}\n`);
  } catch (error) {
    process.stderr.write(`aave-v4-binders failed closed: ${audit.sanitizeText(error?.message || error)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  WORKSPACE, CONFIG_PATH, BINDER_SCHEMA, CONFIG_SCHEMA, TOPOLOGY_SCANNER, MONITOR_SCANNER, FAMILY, CHAIN_ID,
  MODES, SOURCES, BinderError, aaveRowsOf, validateConfig, collectOracleRows, assessTopology, assessMonitor,
  buildBinder, buildBinders, checkUniverseWiring, parseOptions,
};
