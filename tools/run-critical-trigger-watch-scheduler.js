#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const candidateFeedModule = require("./build-fresh-deployed-delta-candidate-feed-v1.js");
const { assessArtifactObject } = require("./monitor-artifact-policy.js");

const CLAIM = "monitor/trigger-watch-scheduler";
const SCHEMA = "trigger-watch-scheduler/v1";
const CADENCE_SECONDS = 900;
const DISCOVERY_CADENCE_SECONDS = 21600;
// Edits to this scheduler take effect only after the daemon is restarted (the orchestrator restarts it when a change lands).
const DISCOVERY_RETRY_SECONDS = 1800;
const DISCOVERY_MAX_SHORT_RETRIES = 3;
const CAPABILITY_ROTATION_CADENCE_SECONDS = 21600;
const CHILD_TIMEOUT_MS = 120000;
const CAPABILITY_ROTATION_CHILD_TIMEOUT_MS = 1620000;
const WORKSPACE = path.resolve(__dirname, "..");
const MONITOR_DIRECTORY = path.join(WORKSPACE, "reports", "monitor");
const OUTPUT = path.join(MONITOR_DIRECTORY, "trigger-watch-scheduler.json");
const LOCK = path.join(MONITOR_DIRECTORY, "trigger-watch-scheduler.lock");
const DISCOVERY_COMMAND = "tools/run-official-deployed-delta-sentinel.js";
const DISCOVERY_ARTIFACT = "reports/monitor/official-deployed-delta-sentinel.json";
const DELTA_BINDER_REFRESH_COMMAND = "tools/refresh-trigger-coverage-delta-binders.js";
const DELTA_BINDER_REFRESH_ID = "trigger-coverage-delta-binders";
const DELTA_BINDER_REFRESH_ARGS = Object.freeze(["--skip-sentinel"]);
// Rebuilt on every 900 s cycle so the covered Ethereum Aave V4 O binder cannot expire
// inside its 1800 s freshness window between ~19m15s topology/borrower observations.
const AAVE_V4_BINDER_REFRESH_COMMAND = "tools/refresh-trigger-coverage-aave-v4-binders.js";
const AAVE_V4_BINDER_REFRESH_ID = "trigger-coverage-aave-v4-binders";
const AAVE_V4_BINDER_REFRESH_ARGS = Object.freeze([]);
const SCORER_COMMAND = "tools/run-deployed-delta-source-risk-scorer.js";
const SCORER_ARTIFACT = "reports/monitor/deployed-delta-source-risk-scorer.json";
const EXTRACTOR_COMMAND = "tools/run-deployed-delta-manifest-extractor.js";
const EXTRACTOR_ARTIFACT = "reports/monitor/deployed-delta-manifest-extractor.json";
const MAPPING_ARTIFACT = "reports/monitor/deployed-delta-build-mapping-resolver.json";
const METADATA_ARTIFACT = "reports/monitor/deployed-delta-pinned-build-metadata.json";
const AUTHORITY_ARTIFACT = "reports/monitor/deployed-delta-source-build-authority.json";
const BINDER_ARTIFACT = "reports/monitor/deployed-delta-finalized-runtime-binder.json";
const INVARIANT_ARTIFACT = "reports/monitor/deployed-delta-invariant-planner.json";
const PREFILTER_COMMAND = "tools/run-deployed-delta-manifest-prefilter.js";
const PREFILTER_ARTIFACT = "reports/monitor/deployed-delta-manifest-prefilter.json";
const ECONOMICS_GATE_COMMAND = "tools/run-deployed-delta-sealed-local-evidence-economics-gate.js";
const ECONOMICS_GATE_ARTIFACT = "reports/monitor/deployed-delta-profit-route-attestations.json";
const CANDIDATE_FEED_DIRECTORY = "reports/monitor/fresh-deployed-delta-candidate-feed-runs";
const RANKER_COMMAND = "tools/run-deployed-delta-profit-ranker.js";
const RANKER_ARTIFACT = "reports/monitor/deployed-delta-profit-ranker.json";
const CAPABILITY_ROTATION_COMMAND = "tools/run-etherfi-optimism-provider-capability-rotation.js";
const CAPABILITY_ROTATION_ARTIFACT = "reports/monitor/etherfi-optimism-provider-capability-rotation.json";

// A12 00:00 UTC daily due — deliberately NOT part of PRODUCER_SPECS / the 900 s loop.
const DAILY_CHECK_SECONDS = 60;
const A12_MAX_AGE_MS = 26 * 60 * 60 * 1000;
const A12_DISPATCH_WINDOW_MS = 15 * 60 * 1000;
const A12_DAILY_SPEC = Object.freeze({
  id: "a12-h1-watch",
  command: "tools/a12-h1-watch.js",
  args: Object.freeze(["--once", "--live", "--refresh", "--rpc-url", "https://ethereum.publicnode.com/"]),
  artifactPath: "reports/monitor/a12-h1-watch.json"
});
const A12_DAILY_KEYS = Object.freeze([
  "id", "status", "lastDueAt", "lastAttemptAt", "nextDueAt", "exitCode", "durationMs",
  "generatedAt", "freshness", "annotations"
]);
const A12_DAILY_STATUSES = Object.freeze(["NOT_DUE", "INFLIGHT", "INTERRUPTED", "PASS", "INCOMPLETE", "FAILED", "TIMEOUT", "ARTIFACT_INVALID", "NOT_INSTALLED"]);

// Morpho Base multi-pair observation — its own UTC claim, never A12's slot or the 900 s loop.
const MORPHO_MAX_AGE_MS = 26 * 60 * 60 * 1000;
const MORPHO_DISPATCH_WINDOW_MS = 15 * 60 * 1000;
const MORPHO_DAILY_SPEC = Object.freeze({
  id: "morpho-multi-pair-watch",
  command: "tools/morpho-multi-watch.js",
  watchListPath: "tools/morpho-multi-watch.watch-list.json",
  // Keyless Base endpoint cited by the producer's liveSend default; never persisted in health.
  args: Object.freeze(["--once", "--live", "--refresh", "--watch-list", "tools/morpho-multi-watch.watch-list.json", "--rpc-url", "https://base-rpc.publicnode.com"]),
  artifactPath: "reports/monitor/morpho-multi-watch.json"
});
const MORPHO_DAILY_KEYS = Object.freeze([
  "id", "status", "lastDueAt", "lastAttemptAt", "nextDueAt", "exitCode", "durationMs",
  "generatedAt", "freshness", "annotations", "readOnly"
]);
const MORPHO_DAILY_STATUSES = Object.freeze(["NOT_DUE", "INFLIGHT", "INTERRUPTED", "PASS", "INCOMPLETE", "FAILED", "TIMEOUT", "ARTIFACT_INVALID", "NOT_INSTALLED"]);

// GMX Arbitrum indexed observation — independent UTC claim, never a 900 s producer.
const GMX_MAX_AGE_MS = 26 * 60 * 60 * 1000;
const GMX_DISPATCH_WINDOW_MS = 15 * 60 * 1000;
const GMX_DAILY_SPEC = Object.freeze({
  id: "gmx-position-watch",
  command: "tools/gmx-position-watch.js",
  args: Object.freeze(["--once", "--live", "--refresh", "--default-top-10"]),
  artifactPath: "reports/monitor/gmx-position-watch.json"
});
const GMX_DAILY_KEYS = Object.freeze([
  "id", "status", "lastDueAt", "lastAttemptAt", "nextDueAt", "exitCode", "durationMs",
  "generatedAt", "freshness", "annotations", "readOnly"
]);
const GMX_DAILY_STATUSES = Object.freeze(["NOT_DUE", "INFLIGHT", "INTERRUPTED", "PASS", "INCOMPLETE", "FAILED", "TIMEOUT", "ARTIFACT_INVALID", "NOT_INSTALLED"]);

// Aave V3 borrower observation — independent UTC claim, never a 900 s producer.
const AAVE_V3_MAX_AGE_MS = 26 * 60 * 60 * 1000;
const AAVE_V3_DISPATCH_WINDOW_MS = 15 * 60 * 1000;
const AAVE_V3_DAILY_SPEC = Object.freeze({
  id: "aave-v3-borrower-watch",
  command: "tools/aave-v3-borrower-watch.js",
  // Keyless Ethereum endpoint listed in the workspace endpoint inventory. The
  // producer identifies this chain and retains its other per-chain defaults.
  args: Object.freeze(["--once", "--live", "--refresh", "--composite-83", "--rpc-url", "https://ethereum.publicnode.com/"]),
  artifactPath: "reports/monitor/aave-v3-borrower-watch.json"
});
const AAVE_V3_DAILY_KEYS = Object.freeze([
  "id", "status", "lastDueAt", "lastAttemptAt", "nextDueAt", "exitCode", "durationMs",
  "generatedAt", "freshness", "annotations", "readOnly"
]);
const AAVE_V3_DAILY_STATUSES = Object.freeze(["NOT_DUE", "INFLIGHT", "INTERRUPTED", "PASS", "INCOMPLETE", "FAILED", "TIMEOUT", "ARTIFACT_INVALID", "NOT_INSTALLED"]);

// Compound V3 Base observation — independent UTC claim, never a 900 s producer.
const COMPOUND_V3_MAX_AGE_MS = 26 * 60 * 60 * 1000;
const COMPOUND_V3_DISPATCH_WINDOW_MS = 15 * 60 * 1000;
const COMPOUND_V3_DAILY_SPEC = Object.freeze({
  id: "compound-v3-base-watch",
  command: "tools/compound-v3-base-watch.js",
  // Catalog keyless Base endpoint; never persisted in scheduler health.
  args: Object.freeze(["--once", "--live", "--refresh", "--top-n", "20", "--rpc-url", "https://base-rpc.publicnode.com/"]),
  artifactPath: "reports/monitor/compound-v3-base-watch.json"
});
const COMPOUND_V3_DAILY_KEYS = Object.freeze([
  "id", "status", "lastDueAt", "lastAttemptAt", "nextDueAt", "exitCode", "durationMs",
  "generatedAt", "freshness", "annotations", "readOnly"
]);
const COMPOUND_V3_DAILY_STATUSES = Object.freeze(["NOT_DUE", "INFLIGHT", "INTERRUPTED", "PASS", "INCOMPLETE", "FAILED", "TIMEOUT", "ARTIFACT_INVALID", "NOT_INSTALLED"]);

const PRODUCER_SPECS = Object.freeze([
  Object.freeze({
    id: "valantis-stex",
    command: "tools/run-critical-valantis-stex-profit-trigger.js",
    artifactPath: "reports/monitor/stex-profit-trigger.json"
  }),
  Object.freeze({
    id: "etherfi-debtmanager",
    command: "tools/run-critical-etherfi-debtmanager-profit-trigger.js",
    artifactPath: "reports/monitor/etherfi-debtmanager-profit-trigger.json"
  }),
  Object.freeze({
    id: "lista-auction-incentive",
    command: "tools/run-critical-lista-auction-incentive-profit-trigger.js",
    artifactPath: "reports/monitor/lista-auction-incentive-profit-trigger.json"
  }),
  Object.freeze({
    id: "aave-v3-arbitrum-config-oracle-events",
    command: "tools/run-arbitrum-aave-v3-config-oracle-events.js",
    artifactPath: "reports/monitor/aave-v3-arbitrum-config-oracle-events.json",
    args: Object.freeze(["--live"])
  })
]);

const TOP_KEYS = Object.freeze([
  "schema", "generatedAt", "cadenceSeconds", "discoveryCadenceSeconds", "running", "pid",
  "startedAt", "cycle", "producers", "discovery", "capabilityRotation", "aaveV4BinderRefresh", "a12Daily", "morphoDaily", "gmxDaily", "aaveV3Daily", "compoundV3Daily", "safety"
]);
const CYCLE_KEYS = Object.freeze(["sequence", "startedAt", "completedAt", "status"]);
const PRODUCER_KEYS = Object.freeze([
  "id", "status", "exitCode", "durationMs", "artifactPath", "triggerStatus", "triggerReason", "generatedAt"
]);
const DISCOVERY_KEYS = Object.freeze(["status", "lastAttemptAt", "nextDueAt", "exitCode", "durationMs", "artifactPath"]);
const CAPABILITY_ROTATION_KEYS = Object.freeze(["artifactPath", "status", "lastAttemptAt", "nextDueAt", "durationMs", "exitCode"]);
const AAVE_V4_BINDER_REFRESH_KEYS = Object.freeze(["status", "lastAttemptAt", "durationMs", "exitCode"]);
const SAFETY_KEYS = Object.freeze([
  "localOnly", "sequential", "overlap", "automaticRetries", "transactionsInitiatedByScheduler", "signing", "broadcast"
]);
const PRODUCER_STATUSES = Object.freeze(["PASS", "FAILED", "TIMEOUT", "ARTIFACT_INVALID"]);
const DISCOVERY_STATUSES = Object.freeze(["NOT_INSTALLED", "NOT_DUE", "PASS", "FAILED", "TIMEOUT", "ARTIFACT_INVALID"]);
const CAPABILITY_ROTATION_STATUSES = Object.freeze(["NOT_DUE", "READY", "INCOMPLETE", "DEGRADED", "FAILED", "TIMEOUT"]);
const AAVE_V4_BINDER_REFRESH_STATUSES = Object.freeze(["NOT_DUE", "NOT_INSTALLED", "PASS", "FAILED", "TIMEOUT"]);
const CYCLE_STATUSES = Object.freeze(["PASS", "DEGRADED"]);
const LEAK_PATTERN = /(?:https?|wss?):\/\/|authorization\s*:|bearer\s|api[_-]?key|rpc_endpoints|graphql_endpoints|\.env\b|private[_-]?key|mnemonic/i;

class SchedulerError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function fail(code) { throw new SchedulerError(code); }
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function iso(value) {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch (_) { return false; }
}
function nullableIso(value) { return value === null || iso(value); }
function nullableString(value) { return value === null || typeof value === "string"; }
function nullableExitCode(value) { return value === null || Number.isInteger(value); }
function relativePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..");
}
function safeSerialized(value) { return !LEAK_PATTERN.test(JSON.stringify(value)); }

function utcDailyDueMs(current) {
  const date = new Date(current);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
function validateA12Daily(value) {
  return exactKeys(value, A12_DAILY_KEYS) && value.id === A12_DAILY_SPEC.id
    && A12_DAILY_STATUSES.includes(value.status) && nullableIso(value.lastDueAt)
    && nullableIso(value.lastAttemptAt) && iso(value.nextDueAt) && nullableExitCode(value.exitCode)
    && Number.isSafeInteger(value.durationMs) && value.durationMs >= 0 && nullableIso(value.generatedAt)
    && typeof value.freshness === "string" && Array.isArray(value.annotations)
    && value.annotations.every((entry) => typeof entry === "string") && safeSerialized(value)
    && ((value.lastDueAt === null && value.lastAttemptAt === null && value.status === "NOT_DUE")
      || (iso(value.lastDueAt) && iso(value.lastAttemptAt)
        && Date.parse(value.lastDueAt) === utcDailyDueMs(Date.parse(value.lastDueAt))
        && Date.parse(value.lastAttemptAt) >= Date.parse(value.lastDueAt)
        && Date.parse(value.nextDueAt) === Date.parse(value.lastDueAt) + 86400000));
}

function validateMorphoDaily(value) {
  return exactKeys(value, MORPHO_DAILY_KEYS) && value.id === MORPHO_DAILY_SPEC.id && value.readOnly === true
    && MORPHO_DAILY_STATUSES.includes(value.status) && nullableIso(value.lastDueAt)
    && nullableIso(value.lastAttemptAt) && iso(value.nextDueAt) && nullableExitCode(value.exitCode)
    && Number.isSafeInteger(value.durationMs) && value.durationMs >= 0 && nullableIso(value.generatedAt)
    && typeof value.freshness === "string" && Array.isArray(value.annotations)
    && value.annotations.every((entry) => typeof entry === "string") && safeSerialized(value)
    && ((value.lastDueAt === null && value.lastAttemptAt === null && value.status === "NOT_DUE")
      || (iso(value.lastDueAt) && iso(value.lastAttemptAt)
        && Date.parse(value.lastDueAt) === utcDailyDueMs(Date.parse(value.lastDueAt))
        && Date.parse(value.lastAttemptAt) >= Date.parse(value.lastDueAt)
        && Date.parse(value.nextDueAt) === Date.parse(value.lastDueAt) + 86400000));
}

function validateGmxDaily(value) {
  return exactKeys(value, GMX_DAILY_KEYS) && value.id === GMX_DAILY_SPEC.id && value.readOnly === true
    && GMX_DAILY_STATUSES.includes(value.status) && nullableIso(value.lastDueAt)
    && nullableIso(value.lastAttemptAt) && iso(value.nextDueAt) && nullableExitCode(value.exitCode)
    && Number.isSafeInteger(value.durationMs) && value.durationMs >= 0 && nullableIso(value.generatedAt)
    && typeof value.freshness === "string" && Array.isArray(value.annotations)
    && value.annotations.every((entry) => typeof entry === "string") && safeSerialized(value)
    && ((value.lastDueAt === null && value.lastAttemptAt === null && value.status === "NOT_DUE")
      || (iso(value.lastDueAt) && iso(value.lastAttemptAt)
        && Date.parse(value.lastDueAt) === utcDailyDueMs(Date.parse(value.lastDueAt))
        && Date.parse(value.lastAttemptAt) >= Date.parse(value.lastDueAt)
        && Date.parse(value.nextDueAt) === Date.parse(value.lastDueAt) + 86400000));
}

function validateAaveV3Daily(value) {
  return exactKeys(value, AAVE_V3_DAILY_KEYS) && value.id === AAVE_V3_DAILY_SPEC.id && value.readOnly === true
    && AAVE_V3_DAILY_STATUSES.includes(value.status) && nullableIso(value.lastDueAt)
    && nullableIso(value.lastAttemptAt) && iso(value.nextDueAt) && nullableExitCode(value.exitCode)
    && Number.isSafeInteger(value.durationMs) && value.durationMs >= 0 && nullableIso(value.generatedAt)
    && typeof value.freshness === "string" && Array.isArray(value.annotations)
    && value.annotations.every((entry) => typeof entry === "string") && safeSerialized(value)
    && ((value.lastDueAt === null && value.lastAttemptAt === null && value.status === "NOT_DUE")
      || (iso(value.lastDueAt) && iso(value.lastAttemptAt)
        && Date.parse(value.lastDueAt) === utcDailyDueMs(Date.parse(value.lastDueAt))
        && Date.parse(value.lastAttemptAt) >= Date.parse(value.lastDueAt)
        && Date.parse(value.nextDueAt) === Date.parse(value.lastDueAt) + 86400000));
}

function validateCompoundV3Daily(value) {
  return exactKeys(value, COMPOUND_V3_DAILY_KEYS) && value.id === COMPOUND_V3_DAILY_SPEC.id && value.readOnly === true
    && COMPOUND_V3_DAILY_STATUSES.includes(value.status) && nullableIso(value.lastDueAt)
    && nullableIso(value.lastAttemptAt) && iso(value.nextDueAt) && nullableExitCode(value.exitCode)
    && Number.isSafeInteger(value.durationMs) && value.durationMs >= 0 && nullableIso(value.generatedAt)
    && typeof value.freshness === "string" && Array.isArray(value.annotations)
    && value.annotations.every((entry) => typeof entry === "string") && safeSerialized(value)
    && ((value.lastDueAt === null && value.lastAttemptAt === null && value.status === "NOT_DUE")
      || (iso(value.lastDueAt) && iso(value.lastAttemptAt)
        && Date.parse(value.lastDueAt) === utcDailyDueMs(Date.parse(value.lastDueAt))
        && Date.parse(value.lastAttemptAt) >= Date.parse(value.lastDueAt)
        && Date.parse(value.nextDueAt) === Date.parse(value.lastDueAt) + 86400000));
}

function validateHealth(value) {
  try {
    if (!exactKeys(value, TOP_KEYS) || value.schema !== SCHEMA || !iso(value.generatedAt)
        || value.cadenceSeconds !== CADENCE_SECONDS || value.discoveryCadenceSeconds !== DISCOVERY_CADENCE_SECONDS
        || typeof value.running !== "boolean" || !Number.isSafeInteger(value.pid) || value.pid < 0
        || (value.running && value.pid < 1) || !iso(value.startedAt)) return false;
    const cycle = value.cycle;
    if (!exactKeys(cycle, CYCLE_KEYS) || !Number.isSafeInteger(cycle.sequence) || cycle.sequence < 0
        || !iso(cycle.startedAt) || !iso(cycle.completedAt) || !CYCLE_STATUSES.includes(cycle.status)) return false;
    if (!Array.isArray(value.producers) || value.producers.length !== PRODUCER_SPECS.length) return false;
    for (let index = 0; index < value.producers.length; index += 1) {
      const row = value.producers[index], expected = PRODUCER_SPECS[index];
      if (!exactKeys(row, PRODUCER_KEYS) || row.id !== expected.id || row.artifactPath !== expected.artifactPath
          || !PRODUCER_STATUSES.includes(row.status) || !nullableExitCode(row.exitCode)
          || !Number.isSafeInteger(row.durationMs) || row.durationMs < 0
          || !nullableString(row.triggerStatus) || !nullableString(row.triggerReason) || !nullableIso(row.generatedAt)) return false;
      if (row.status === "PASS" && (row.exitCode !== 0 || row.triggerStatus === null || row.generatedAt === null)) return false;
    }
    const discovery = value.discovery;
    if (!exactKeys(discovery, DISCOVERY_KEYS) || !DISCOVERY_STATUSES.includes(discovery.status)
        || !nullableIso(discovery.lastAttemptAt) || !nullableIso(discovery.nextDueAt)
        || !nullableExitCode(discovery.exitCode) || !Number.isSafeInteger(discovery.durationMs) || discovery.durationMs < 0
        || !relativePath(discovery.artifactPath)) return false;
    const capabilityRotation = value.capabilityRotation;
    if (!exactKeys(capabilityRotation, CAPABILITY_ROTATION_KEYS)
        || !CAPABILITY_ROTATION_STATUSES.includes(capabilityRotation.status)
        || capabilityRotation.artifactPath !== CAPABILITY_ROTATION_ARTIFACT
        || !nullableIso(capabilityRotation.lastAttemptAt) || !nullableIso(capabilityRotation.nextDueAt)
        || !Number.isSafeInteger(capabilityRotation.durationMs) || capabilityRotation.durationMs < 0
        || !nullableExitCode(capabilityRotation.exitCode)) return false;
    if (["READY", "INCOMPLETE"].includes(capabilityRotation.status) && capabilityRotation.exitCode !== 0) return false;
    if (capabilityRotation.status === "NOT_DUE" && capabilityRotation.exitCode !== null) return false;
    if (capabilityRotation.status !== "NOT_DUE"
        && (capabilityRotation.lastAttemptAt === null || capabilityRotation.nextDueAt === null)) return false;
    if (capabilityRotation.lastAttemptAt !== null && capabilityRotation.nextDueAt !== null
        && Date.parse(capabilityRotation.nextDueAt) < Date.parse(capabilityRotation.lastAttemptAt)) return false;
    const aaveV4BinderRefresh = value.aaveV4BinderRefresh;
    if (!exactKeys(aaveV4BinderRefresh, AAVE_V4_BINDER_REFRESH_KEYS)
        || !AAVE_V4_BINDER_REFRESH_STATUSES.includes(aaveV4BinderRefresh.status)
        || !nullableIso(aaveV4BinderRefresh.lastAttemptAt)
        || !Number.isSafeInteger(aaveV4BinderRefresh.durationMs) || aaveV4BinderRefresh.durationMs < 0
        || !nullableExitCode(aaveV4BinderRefresh.exitCode)) return false;
    if (aaveV4BinderRefresh.status === "PASS"
        && (aaveV4BinderRefresh.exitCode !== 0 || aaveV4BinderRefresh.lastAttemptAt === null)) return false;
    if (aaveV4BinderRefresh.status === "NOT_DUE"
        && (aaveV4BinderRefresh.exitCode !== null || aaveV4BinderRefresh.lastAttemptAt !== null)) return false;
    if (["FAILED", "TIMEOUT", "NOT_INSTALLED"].includes(aaveV4BinderRefresh.status)
        && aaveV4BinderRefresh.lastAttemptAt === null) return false;
    if (aaveV4BinderRefresh.status === "NOT_INSTALLED" && aaveV4BinderRefresh.exitCode !== null) return false;
    if (!validateA12Daily(value.a12Daily)) return false;
    if (!validateMorphoDaily(value.morphoDaily)) return false;
    if (!validateGmxDaily(value.gmxDaily)) return false;
    if (!validateAaveV3Daily(value.aaveV3Daily)) return false;
    if (!validateCompoundV3Daily(value.compoundV3Daily)) return false;
    const safety = value.safety;
    if (!exactKeys(safety, SAFETY_KEYS) || safety.localOnly !== true || safety.sequential !== true
        || safety.overlap !== false || safety.automaticRetries !== 0 || safety.transactionsInitiatedByScheduler !== 0
        || safety.signing !== false || safety.broadcast !== false) return false;
    return safeSerialized(value);
  } catch (_) { return false; }
}

function producerContracts(workspace = WORKSPACE) {
  return PRODUCER_SPECS.map((spec) => {
    const loaded = require(path.join(workspace, spec.command));
    if (!loaded || typeof loaded.validateArtifact !== "function" || typeof loaded.SCHEMA !== "string") fail("PRODUCER_CONTRACT_INVALID");
    return Object.freeze({ ...spec, validateArtifact: loaded.validateArtifact, expectedSchema: loaded.SCHEMA });
  });
}

function initialProducerRows() {
  return PRODUCER_SPECS.map((spec) => ({
    id: spec.id, status: "ARTIFACT_INVALID", exitCode: null, durationMs: 0,
    artifactPath: spec.artifactPath, triggerStatus: null, triggerReason: null, generatedAt: null
  }));
}
function safetyFields() {
  return {
    localOnly: true, sequential: true, overlap: false, automaticRetries: 0,
    transactionsInitiatedByScheduler: 0, signing: false, broadcast: false
  };
}
function baseHealth(options = {}) {
  const now = options.now || Date.now;
  const stamp = new Date(now()).toISOString();
  return {
    schema: SCHEMA,
    generatedAt: stamp,
    cadenceSeconds: CADENCE_SECONDS,
    discoveryCadenceSeconds: DISCOVERY_CADENCE_SECONDS,
    running: options.running === true,
    pid: options.pid === undefined ? 0 : options.pid,
    startedAt: options.startedAt || stamp,
    cycle: { sequence: 0, startedAt: stamp, completedAt: stamp, status: "DEGRADED" },
    producers: initialProducerRows(),
    discovery: {
      status: "NOT_DUE", lastAttemptAt: null, nextDueAt: stamp, exitCode: null,
      durationMs: 0, artifactPath: DISCOVERY_ARTIFACT
    },
    capabilityRotation: {
      artifactPath: CAPABILITY_ROTATION_ARTIFACT, status: "NOT_DUE", lastAttemptAt: null,
      nextDueAt: stamp, durationMs: 0, exitCode: null
    },
    aaveV4BinderRefresh: {
      status: "NOT_DUE", lastAttemptAt: null, durationMs: 0, exitCode: null
    },
    a12Daily: {
      id: A12_DAILY_SPEC.id, status: "NOT_DUE", lastDueAt: null, lastAttemptAt: null,
      nextDueAt: new Date(utcDailyDueMs(now())).toISOString(), exitCode: null, durationMs: 0,
      generatedAt: null, freshness: "MISSING", annotations: ["A12_CAPTURE_MISSING"]
    },
    morphoDaily: {
      id: MORPHO_DAILY_SPEC.id, status: "NOT_DUE", lastDueAt: null, lastAttemptAt: null,
      nextDueAt: new Date(utcDailyDueMs(now())).toISOString(), exitCode: null, durationMs: 0,
      generatedAt: null, freshness: "MISSING", annotations: ["MORPHO_CAPTURE_MISSING"], readOnly: true
    },
    gmxDaily: {
      id: GMX_DAILY_SPEC.id, status: "NOT_DUE", lastDueAt: null, lastAttemptAt: null,
      nextDueAt: new Date(utcDailyDueMs(now())).toISOString(), exitCode: null, durationMs: 0,
      generatedAt: null, freshness: "MISSING", annotations: ["GMX_CAPTURE_MISSING"], readOnly: true
    },
    aaveV3Daily: {
      id: AAVE_V3_DAILY_SPEC.id, status: "NOT_DUE", lastDueAt: null, lastAttemptAt: null,
      nextDueAt: new Date(utcDailyDueMs(now())).toISOString(), exitCode: null, durationMs: 0,
      generatedAt: null, freshness: "MISSING", annotations: ["AAVE_V3_CAPTURE_MISSING"], readOnly: true
    },
    compoundV3Daily: {
      id: COMPOUND_V3_DAILY_SPEC.id, status: "NOT_DUE", lastDueAt: null, lastAttemptAt: null,
      nextDueAt: new Date(utcDailyDueMs(now())).toISOString(), exitCode: null, durationMs: 0,
      generatedAt: null, freshness: "MISSING", annotations: ["COMPOUND_V3_CAPTURE_MISSING"], readOnly: true
    },
    safety: safetyFields()
  };
}

function fsyncDirectory(directory, fsImpl = fs) {
  const descriptor = fsImpl.openSync(directory, "r");
  try {
    try { fsImpl.fsyncSync(descriptor); }
    catch (error) { if (!["EINVAL", "EPERM", "EBADF"].includes(error.code)) throw error; }
  } finally { fsImpl.closeSync(descriptor); }
}

function publishAtomic(health, options = {}) {
  if (!validateHealth(health)) fail("HEALTH_SCHEMA_INVALID");
  const fsImpl = options.fsImpl || fs;
  const target = path.resolve(options.outputPath || OUTPUT);
  const allowedRoot = path.resolve(options.allowedRoot || path.dirname(OUTPUT));
  if (path.dirname(target) !== allowedRoot || path.basename(target) !== "trigger-watch-scheduler.json") fail("OUTPUT_PATH_REJECTED");
  const bytes = Buffer.from(`${JSON.stringify(health, null, 2)}\n`);
  const temporary = path.join(allowedRoot, `.trigger-watch-scheduler.json.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  let descriptor;
  try {
    descriptor = fsImpl.openSync(temporary, "wx", 0o600);
    fsImpl.writeFileSync(descriptor, bytes);
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    fsImpl.renameSync(temporary, target);
    fsyncDirectory(allowedRoot, fsImpl);
    const readback = fsImpl.readFileSync(target);
    if (!readback.equals(bytes) || !validateHealth(JSON.parse(readback.toString("utf8")))) fail("HEALTH_READBACK_INVALID");
    return target;
  } finally {
    if (descriptor !== undefined) try { fsImpl.closeSync(descriptor); } catch (_) {}
    if (fsImpl.existsSync(temporary)) try { fsImpl.unlinkSync(temporary); } catch (_) {}
  }
}

function strictRegularFile(filePath, fsImpl = fs, maximumBytes = 1024 * 1024) {
  const stat = fsImpl.lstatSync(filePath);
  return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximumBytes;
}
function readJsonStrict(filePath, fsImpl = fs, maximumBytes = 1024 * 1024) {
  if (!strictRegularFile(filePath, fsImpl, maximumBytes)) fail("ARTIFACT_INVALID");
  const raw = fsImpl.readFileSync(filePath);
  if (raw.length === 0 || raw.length > maximumBytes) fail("ARTIFACT_INVALID");
  return JSON.parse(raw.toString("utf8"));
}

function createChildRunner(options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const now = options.now || Date.now;
  const timeoutMs = Math.min(options.timeoutMs || CHILD_TIMEOUT_MS, CHILD_TIMEOUT_MS);
  const capabilityRotationTimeoutMs = Math.min(
    options.capabilityRotationTimeoutMs || CAPABILITY_ROTATION_CHILD_TIMEOUT_MS,
    CAPABILITY_ROTATION_CHILD_TIMEOUT_MS
  );
  return function run(commandPath, metadata = {}) {
    return new Promise((resolve) => {
      const started = now();
      let child, settled = false, timedOut = false, timer;
      const finish = (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut, exitCode: Number.isInteger(exitCode) ? exitCode : null, durationMs: Math.max(0, Math.round(now() - started)) });
      };
      try {
        const childArgs = Array.isArray(metadata.args) && metadata.args.every((value) => typeof value === "string") ? metadata.args : [];
        child = spawnImpl(process.execPath, [commandPath, ...childArgs], {
          cwd: options.workspace || WORKSPACE,
          shell: false,
          windowsHide: true,
          stdio: "ignore"
        });
      } catch (_) { finish(null); return; }
      child.once("error", () => finish(null));
      child.once("close", (code) => finish(code));
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch (_) {}
      }, metadata.capabilityRotation === true ? capabilityRotationTimeoutMs : timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
  };
}

function validatedProducerRow(contract, result, options = {}) {
  const row = {
    id: contract.id,
    status: result.timedOut ? "TIMEOUT" : result.exitCode === 0 ? "ARTIFACT_INVALID" : "FAILED",
    exitCode: result.exitCode,
    durationMs: Math.max(0, Math.round(result.durationMs || 0)),
    artifactPath: contract.artifactPath,
    triggerStatus: null,
    triggerReason: null,
    generatedAt: null
  };
  const aave = contract.id === "aave-v3-arbitrum-config-oracle-events";
  if (result.timedOut || (result.exitCode !== 0 && !aave)) return row;
  try {
    const artifact = readJsonStrict(path.join(options.workspace || WORKSPACE, contract.artifactPath), options.fsImpl || fs);
    if (artifact.schema !== contract.expectedSchema || !contract.validateArtifact(artifact) || !safeSerialized(artifact)) return row;
    const generatedMs = Date.parse(artifact.generatedAt);
    if ((options.minimumGeneratedAtMs !== undefined && generatedMs < options.minimumGeneratedAtMs)
        || (options.maximumGeneratedAtMs !== undefined && generatedMs > options.maximumGeneratedAtMs)) return row;
    if (aave) {
      row.generatedAt = artifact.generatedAt;
      if (artifact.status === "INCOMPLETE" && artifact.outcome === "INCOMPLETE") {
        row.status = "FAILED"; row.triggerStatus = "INCOMPLETE"; row.triggerReason = artifact.code; return row;
      }
      if (result.exitCode !== 0 || !["COMPLETE_ZERO_EVENTS", "EVENT_SURVIVOR_NO_ROUTE"].includes(artifact.outcome)) return row;
      row.status = "PASS"; row.triggerStatus = artifact.outcome; row.triggerReason = null; return row;
    }
    row.status = "PASS"; row.triggerStatus = artifact.trigger.status;
    row.triggerReason = typeof artifact.trigger.reason === "string" ? artifact.trigger.reason : null; row.generatedAt = artifact.generatedAt;
  } catch (_) { /* invalid artifacts remain explicitly invalid */ }
  return row;
}

function defaultDiscoveryContract(workspace = WORKSPACE) {
  const commandPath = path.join(workspace, DISCOVERY_COMMAND);
  if (!fs.existsSync(commandPath)) return null;
  try {
    const loaded = require(commandPath);
    const output = path.resolve(loaded.OUTPUT || path.join(workspace, DISCOVERY_ARTIFACT));
    const monitor = path.resolve(workspace, "reports", "monitor");
    if (!loaded || typeof loaded.validateArtifact !== "function" || typeof loaded.SCHEMA !== "string"
        || path.dirname(output) !== monitor) return { artifactPath: DISCOVERY_ARTIFACT, expectedSchema: null, validateArtifact: () => false };
    return {
      artifactPath: path.relative(workspace, output).replace(/\\/g, "/"),
      expectedSchema: loaded.SCHEMA,
      validateArtifact: loaded.validateArtifact
    };
  } catch (_) {
    return { artifactPath: DISCOVERY_ARTIFACT, expectedSchema: null, validateArtifact: () => false };
  }
}

function defaultDeltaBinderRefreshContract(workspace = WORKSPACE) {
  const commandPath = path.join(workspace, DELTA_BINDER_REFRESH_COMMAND);
  if (!fs.existsSync(commandPath)) return null;
  try {
    const loaded = require(commandPath);
    if (!loaded || typeof loaded.refresh !== "function") return null;
    return {
      command: DELTA_BINDER_REFRESH_COMMAND,
      id: DELTA_BINDER_REFRESH_ID,
      args: [...DELTA_BINDER_REFRESH_ARGS]
    };
  } catch (_) {
    return null;
  }
}

function defaultAaveV4BinderRefreshContract(workspace = WORKSPACE) {
  const commandPath = path.join(workspace, AAVE_V4_BINDER_REFRESH_COMMAND);
  if (!fs.existsSync(commandPath)) return null;
  try {
    const loaded = require(commandPath);
    if (!loaded || typeof loaded.refresh !== "function") return null;
    return {
      command: AAVE_V4_BINDER_REFRESH_COMMAND,
      id: AAVE_V4_BINDER_REFRESH_ID,
      args: [...AAVE_V4_BINDER_REFRESH_ARGS]
    };
  } catch (_) {
    return null;
  }
}

function defaultRankerContract(workspace = WORKSPACE) {
  const commandPath = path.join(workspace, RANKER_COMMAND);
  if (!fs.existsSync(commandPath)) return null;
  try {
    const loaded = require(commandPath);
    const output = path.resolve(loaded.OUTPUT || path.join(workspace, RANKER_ARTIFACT));
    const expectedOutput = path.resolve(workspace, RANKER_ARTIFACT);
    if (!loaded || typeof loaded.validateArtifact !== "function" || typeof loaded.SCHEMA !== "string"
        || output !== expectedOutput) return null;
    return {
      artifactPath: RANKER_ARTIFACT,
      expectedSchema: loaded.SCHEMA,
      validateArtifact: loaded.validateArtifact
    };
  } catch (_) { return null; }
}

function defaultPrefilterContract(workspace = WORKSPACE) {
  const commandPath = path.join(workspace, PREFILTER_COMMAND);
  if (!fs.existsSync(commandPath)) return null;
  try {
    const loaded = require(commandPath);
    const output = path.resolve(loaded.OUTPUT || path.join(workspace, PREFILTER_ARTIFACT));
    const expectedOutput = path.resolve(workspace, PREFILTER_ARTIFACT);
    if (!loaded || typeof loaded.validateArtifact !== "function" || typeof loaded.SCHEMA !== "string"
        || output !== expectedOutput) return null;
    return {
      artifactPath: PREFILTER_ARTIFACT,
      expectedSchema: loaded.SCHEMA,
      validateArtifact: loaded.validateArtifact
    };
  } catch (_) { return null; }
}

function defaultEconomicsGateContract(workspace = WORKSPACE) {
  const commandPath = path.join(workspace, ECONOMICS_GATE_COMMAND);
  const rankerPath = path.join(workspace, RANKER_COMMAND);
  if (!fs.existsSync(commandPath) || !fs.existsSync(rankerPath)) return null;
  try {
    const loaded = require(commandPath);
    const ranker = require(rankerPath);
    const output = path.resolve(loaded.OUTPUT || path.join(workspace, ECONOMICS_GATE_ARTIFACT));
    const expectedOutput = path.resolve(workspace, ECONOMICS_GATE_ARTIFACT);
    if (!loaded || typeof loaded.validateOutput !== "function" || typeof loaded.SCHEMA !== "string"
        || typeof ranker.ROUTE_ATTESTATION_SCHEMA !== "string"
        || output !== expectedOutput) return null;
    return {
      artifactPath: ECONOMICS_GATE_ARTIFACT,
      expectedSchema: ranker.ROUTE_ATTESTATION_SCHEMA,
      emptyFeedId: crypto.createHash("sha256").update(`${loaded.SCHEMA}\0unbound-feed\0[]`, "utf8").digest("hex"),
      validateArtifact: loaded.validateOutput
    };
  } catch (_) { return null; }
}

function defaultScorerContract(workspace = WORKSPACE) {
  const commandPath = path.join(workspace, SCORER_COMMAND);
  if (!fs.existsSync(commandPath)) return null;
  try {
    const loaded = require(commandPath);
    const output = path.resolve(loaded.OUTPUT || path.join(workspace, SCORER_ARTIFACT));
    const expectedOutput = path.resolve(workspace, SCORER_ARTIFACT);
    if (!loaded || typeof loaded.validateArtifact !== "function" || typeof loaded.SCHEMA !== "string"
        || output !== expectedOutput) return null;
    return {
      artifactPath: SCORER_ARTIFACT,
      expectedSchema: loaded.SCHEMA,
      validateArtifact: loaded.validateArtifact
    };
  } catch (_) { return null; }
}

function defaultExtractorContract(workspace = WORKSPACE) {
  const commandPath = path.join(workspace, EXTRACTOR_COMMAND);
  if (!fs.existsSync(commandPath)) return null;
  try {
    const loaded = require(commandPath);
    const output = path.resolve(loaded.OUTPUT || path.join(workspace, EXTRACTOR_ARTIFACT));
    const expectedOutput = path.resolve(workspace, EXTRACTOR_ARTIFACT);
    if (!loaded || typeof loaded.validateArtifact !== "function" || typeof loaded.SCHEMA !== "string"
        || output !== expectedOutput) return null;
    return {
      artifactPath: EXTRACTOR_ARTIFACT,
      expectedSchema: loaded.SCHEMA,
      validateArtifact: loaded.validateArtifact
    };
  } catch (_) { return null; }
}

function defaultBinderContract(workspace = WORKSPACE) {
  const modulePath = path.join(workspace, "tools", "run-deployed-delta-finalized-runtime-binder.js");
  if (!fs.existsSync(modulePath)) return null;
  try {
    const loaded = require(modulePath);
    const output = path.resolve(loaded.OUTPUT || path.join(workspace, BINDER_ARTIFACT));
    const expectedOutput = path.resolve(workspace, BINDER_ARTIFACT);
    if (!loaded || typeof loaded.validateArtifact !== "function" || typeof loaded.SCHEMA !== "string"
        || output !== expectedOutput) return null;
    return {
      artifactPath: BINDER_ARTIFACT,
      expectedSchema: loaded.SCHEMA,
      validateArtifact: loaded.validateArtifact
    };
  } catch (_) { return null; }
}

function defaultAuthorityContract(workspace = WORKSPACE) {
  const modulePath = path.join(workspace, "tools", "run-deployed-delta-source-build-authority.js");
  if (!fs.existsSync(modulePath)) return null;
  try {
    const loaded = require(modulePath);
    const output = path.resolve(loaded.OUTPUT || path.join(workspace, AUTHORITY_ARTIFACT));
    const expectedOutput = path.resolve(workspace, AUTHORITY_ARTIFACT);
    if (!loaded || typeof loaded.validateArtifact !== "function" || typeof loaded.SCHEMA !== "string"
        || output !== expectedOutput) return null;
    return {
      artifactPath: AUTHORITY_ARTIFACT,
      expectedSchema: loaded.SCHEMA,
      validateArtifact: loaded.validateArtifact
    };
  } catch (_) { return null; }
}

function defaultMappingContract(workspace = WORKSPACE) {
  return defaultCoProducedContract(workspace, "run-deployed-delta-build-mapping-resolver.js", MAPPING_ARTIFACT);
}
function defaultMetadataContract(workspace = WORKSPACE) {
  return defaultCoProducedContract(workspace, "run-deployed-delta-pinned-build-metadata.js", METADATA_ARTIFACT);
}
function defaultInvariantContract(workspace = WORKSPACE) {
  return defaultCoProducedContract(workspace, "run-deployed-delta-invariant-planner.js", INVARIANT_ARTIFACT);
}
function defaultCoProducedContract(workspace, filename, artifactPath) {
  const modulePath = path.join(workspace, "tools", filename);
  if (!fs.existsSync(modulePath)) return null;
  try {
    const loaded = require(modulePath);
    const output = path.resolve(loaded.OUTPUT || path.join(workspace, artifactPath));
    if (!loaded || typeof loaded.validateArtifact !== "function" || typeof loaded.SCHEMA !== "string"
        || output !== path.resolve(workspace, artifactPath)) return null;
    return { artifactPath, expectedSchema: loaded.SCHEMA, validateArtifact: loaded.validateArtifact };
  } catch (_) { return null; }
}

function defaultCapabilityRotationContract(workspace = WORKSPACE) {
  const commandPath = path.join(workspace, CAPABILITY_ROTATION_COMMAND);
  if (!fs.existsSync(commandPath)) return null;
  try {
    const loaded = require(commandPath);
    const output = path.resolve(loaded.OUTPUT || path.join(workspace, CAPABILITY_ROTATION_ARTIFACT));
    const expectedOutput = path.resolve(workspace, CAPABILITY_ROTATION_ARTIFACT);
    if (!loaded || typeof loaded.validateArtifact !== "function" || typeof loaded.SCHEMA !== "string"
        || output !== expectedOutput) return null;
    return {
      artifactPath: CAPABILITY_ROTATION_ARTIFACT,
      expectedSchema: loaded.SCHEMA,
      validateArtifact: loaded.validateArtifact
    };
  } catch (_) { return null; }
}

function createScheduler(options = {}) {
  const workspace = path.resolve(options.workspace || WORKSPACE);
  const fsImpl = options.fsImpl || fs;
  const now = options.now || Date.now;
  const runner = options.runner || createChildRunner({ workspace, now });
  const contracts = options.producers || producerContracts(workspace);
  const exists = options.exists || ((filePath) => fsImpl.existsSync(filePath));
  const discoveryFactory = options.discoveryFactory || (() => defaultDiscoveryContract(workspace));
  const deltaBinderRefreshFactory = options.deltaBinderRefreshFactory || (() => defaultDeltaBinderRefreshContract(workspace));
  const aaveV4BinderRefreshFactory = options.aaveV4BinderRefreshFactory || (() => defaultAaveV4BinderRefreshContract(workspace));
  const scorerFactory = options.scorerFactory || (() => defaultScorerContract(workspace));
  const extractorFactory = options.extractorFactory || (() => defaultExtractorContract(workspace));
  const mappingFactory = options.mappingFactory || (() => defaultMappingContract(workspace));
  const metadataFactory = options.metadataFactory || (() => defaultMetadataContract(workspace));
  const authorityFactory = options.authorityFactory || (() => defaultAuthorityContract(workspace));
  const binderFactory = options.binderFactory || (() => defaultBinderContract(workspace));
  const invariantFactory = options.invariantFactory || (() => defaultInvariantContract(workspace));
  const prefilterFactory = options.prefilterFactory || (() => defaultPrefilterContract(workspace));
  const economicsGateFactory = options.economicsGateFactory || (() => defaultEconomicsGateContract(workspace));
  const rankerFactory = options.rankerFactory || (() => defaultRankerContract(workspace));
  const capabilityRotationFactory = options.capabilityRotationFactory || (() => defaultCapabilityRotationContract(workspace));
  const publish = options.publish || ((health) => publishAtomic(health, {
    fsImpl, outputPath: options.outputPath || OUTPUT, allowedRoot: options.allowedRoot || path.dirname(options.outputPath || OUTPUT)
  }));
  const startedAt = options.startedAt || new Date(now()).toISOString();
  const health = baseHealth({ now, running: options.running !== false, pid: options.pid === undefined ? process.pid : options.pid, startedAt });
  let inCycle = false;
  let inA12Daily = false;
  let inMorphoDaily = false;
  // Restore the durable claim BEFORE publishInitial can replace scheduler health.
  // A malformed prior state must not silently reset the gate and dispatch again.
  const priorHealthPath = options.outputPath || OUTPUT;
  try {
    const prior = readJsonStrict(priorHealthPath, fsImpl);
    if (prior.schema !== SCHEMA) fail("A12_DAILY_STATE_INVALID");
    if (Object.prototype.hasOwnProperty.call(prior, "a12Daily")) {
      if (!validateA12Daily(prior.a12Daily)) fail("A12_DAILY_STATE_INVALID");
      health.a12Daily = prior.a12Daily;
      if (health.a12Daily.status === "INFLIGHT") health.a12Daily.status = "INTERRUPTED";
    } // Existing pre-registration health has no daily claim to restore.
    if (Object.prototype.hasOwnProperty.call(prior, "morphoDaily")) {
      if (!validateMorphoDaily(prior.morphoDaily)) fail("MORPHO_DAILY_STATE_INVALID");
      health.morphoDaily = prior.morphoDaily;
      if (health.morphoDaily.status === "INFLIGHT") health.morphoDaily.status = "INTERRUPTED";
    }
    if (Object.prototype.hasOwnProperty.call(prior, "gmxDaily")) {
      if (!validateGmxDaily(prior.gmxDaily)) fail("GMX_DAILY_STATE_INVALID");
      health.gmxDaily = prior.gmxDaily;
      if (health.gmxDaily.status === "INFLIGHT") health.gmxDaily.status = "INTERRUPTED";
    }
    if (Object.prototype.hasOwnProperty.call(prior, "aaveV3Daily")) {
      if (!validateAaveV3Daily(prior.aaveV3Daily)) fail("AAVE_V3_DAILY_STATE_INVALID");
      health.aaveV3Daily = prior.aaveV3Daily;
      if (health.aaveV3Daily.status === "INFLIGHT") health.aaveV3Daily.status = "INTERRUPTED";
    }
    if (Object.prototype.hasOwnProperty.call(prior, "compoundV3Daily")) {
      if (!validateCompoundV3Daily(prior.compoundV3Daily)) fail("COMPOUND_V3_DAILY_STATE_INVALID");
      health.compoundV3Daily = prior.compoundV3Daily;
      if (health.compoundV3Daily.status === "INFLIGHT") health.compoundV3Daily.status = "INTERRUPTED";
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  let sequence = 0;
  let discoveryLastAttemptMs = null;
  let discoveryNextDueMs = null;
  let discoveryRetryStreak = 0;
  let capabilityRotationLastAttemptMs = null;

  function publishNow() {
    health.generatedAt = new Date(now()).toISOString();
    publish(JSON.parse(JSON.stringify(health)));
  }

  function annotateA12Freshness() {
    const row = health.a12Daily;
    row.generatedAt = null;
    row.annotations = [];
    try {
      // Assess the latest persisted capture (the evidence tail), never a synthetic zero.
      const artifact = readJsonStrict(path.join(workspace, A12_DAILY_SPEC.artifactPath), fsImpl);
      const validate = options.a12ValidateArtifact || require(path.join(workspace, A12_DAILY_SPEC.command)).validateArtifact;
      const assessment = assessArtifactObject(artifact, {
        nowMs: now(), maxAgeMs: A12_MAX_AGE_MS, maxFutureSkewMs: 0,
        validate: (value) => validate(value) && value.mode === "live"
      });
      row.freshness = assessment.status;
      row.generatedAt = assessment.generatedAt || null;
      if (assessment.status === "VALID_STALE") row.annotations.push("A12_CAPTURE_OLDER_THAN_26_HOURS");
      else if (assessment.status !== "VALID_FRESH") row.annotations.push("A12_CAPTURE_INVALID");
      if (artifact.status === "INCOMPLETE") row.annotations.push("A12_CAPTURE_INCOMPLETE_NOT_ZERO");
    } catch (error) {
      row.freshness = error && error.code === "ENOENT" ? "MISSING" : "MALFORMED";
      row.annotations.push(row.freshness === "MISSING" ? "A12_CAPTURE_MISSING" : "A12_CAPTURE_INVALID");
    }
    if (row.status === "INTERRUPTED") row.annotations.push("A12_ATTEMPT_INTERRUPTED_NO_AUTOMATIC_RETRY");
    if (row.lastDueAt && Date.parse(row.lastAttemptAt) - Date.parse(row.lastDueAt) > A12_DISPATCH_WINDOW_MS) {
      row.annotations.push("A12_DISPATCH_AFTER_00_15_UTC");
    }
  }

  async function runA12DailyDue() {
    if (inCycle || inA12Daily || inMorphoDaily) return false; // Never override an inflight gate.
    inA12Daily = true;
    try {
      const current = now(), dueMs = utcDailyDueMs(current);
      annotateA12Freshness();
      if (health.a12Daily.lastDueAt !== null && Date.parse(health.a12Daily.lastDueAt) >= dueMs) {
        publishNow();
        return false;
      }
      health.a12Daily = {
        ...health.a12Daily, status: "INFLIGHT", lastDueAt: new Date(dueMs).toISOString(),
        lastAttemptAt: new Date(current).toISOString(), nextDueAt: new Date(dueMs + 86400000).toISOString(),
        exitCode: null, durationMs: 0
      };
      annotateA12Freshness();
      // Atomic fsync/rename/readback claim before spawn: restart/failure never retries this UTC slot.
      publishNow();
      const commandPath = path.join(workspace, A12_DAILY_SPEC.command);
      if (!exists(commandPath)) health.a12Daily.status = "NOT_INSTALLED";
      else {
        try {
          const result = await runner(commandPath, { id: A12_DAILY_SPEC.id, daily: true, args: [...A12_DAILY_SPEC.args] });
          const row = health.a12Daily;
          row.exitCode = result.exitCode;
          row.durationMs = Math.max(0, Math.round(result.durationMs || 0));
          row.status = result.timedOut ? "TIMEOUT" : result.exitCode === 0 ? "ARTIFACT_INVALID" : "FAILED";
          // Even nonzero exits can leave valid INCOMPLETE evidence; retain that, never infer zero.
          if (!result.timedOut) {
            try {
              const artifact = readJsonStrict(path.join(workspace, A12_DAILY_SPEC.artifactPath), fsImpl);
              const validate = options.a12ValidateArtifact || require(commandPath).validateArtifact;
              const generatedMs = Date.parse(artifact.generatedAt);
              if (validate(artifact) && artifact.mode === "live" && generatedMs >= current && generatedMs <= now()) {
                if (artifact.status === "INCOMPLETE") row.status = "INCOMPLETE";
                else if (result.exitCode === 0) row.status = "PASS";
              }
            } catch (_) { /* missing/stale/invalid evidence is never a successful zero */ }
          }
        } catch (_) { health.a12Daily.status = "FAILED"; }
      }
      annotateA12Freshness();
      publishNow();
      return true;
    } finally { inA12Daily = false; }
  }

  function validateMorphoCapture(artifact) {
    // The multi-pair producer exports validateList, not validateArtifact. Check its
    // observation envelope here without reinterpreting HF or introducing execution policy.
    const producer = require(path.join(workspace, MORPHO_DAILY_SPEC.command));
    const single = require(path.join(workspace, "tools/morpho-cbbtc-watch.js"));
    const { CORE, PRICE, IRM, USDC, decimal } = single.helpers;
    const { keccak256 } = require(path.join(workspace, "tools/node_modules/ethers"));
    const configured = producer.validateList(readJsonStrict(path.join(workspace, MORPHO_DAILY_SPEC.watchListPath), fsImpl));
    const readOnly = (value) => value && value.readOnly === true && value.signing === false
      && value.submission === false && value.deployment === false && value.stateMutation === false
      && value.simulation === false && value.forkExecution === false && value.executableNow === false
      && ["routePositive", "signedActionJustified", "alertDispatch", "rpcUrlsStored", "keysRead", "authMaterialStored"]
        .every((key) => value[key] === false);
    const budget = (value) => value && Number.isSafeInteger(value.rpcCount) && value.rpcCount >= 0
      && value.rpcCount <= producer.MAX_REQUESTS && value.requestCount === value.rpcCount
      && value.maxRpcRequests === producer.MAX_REQUESTS && value.retries === 0
      && Array.isArray(value.methodLedger) && value.methodLedger.length === value.requestCount;
    const completePin = (pin) => pin && pin.requested === "finalized" && pin.valid === true && pin.rechecked === true
      && pin.callBinding === "EIP-1898 blockHash + requireCanonical"
      && Number.isSafeInteger(pin.number) && pin.number >= 0 && Number.isSafeInteger(pin.timestamp) && pin.timestamp >= 0
      && /^0x[0-9a-f]{64}$/.test(pin.hash) && pin.finalizedNumber === pin.number && pin.finalizedHash === pin.hash;
    if (!artifact || artifact.schema !== producer.SCHEMA || artifact.kind !== "MultiWatch"
        || artifact.mode !== "live" || artifact.fixtureId !== null || !iso(artifact.generatedAt)
        || !["COMPLETE", "INCOMPLETE"].includes(artifact.status) || !readOnly(artifact.safety)
        // The trusted current file contains five ordered pairs, including mGLO/USDC.
        || configured.length !== 5 || JSON.stringify(artifact.watchList) !== JSON.stringify(configured)
        || !Array.isArray(artifact.entries) || artifact.entries.length !== configured.length
        || artifact.enforcement !== producer.ENFORCEMENT || !budget(artifact.diagnostics)
        || (artifact.status === "COMPLETE" && !completePin(artifact.pin))
        || !artifact.pin || artifact.pin.requested !== "finalized" || !safeSerialized(artifact)) return false;
    for (let index = 0; index < configured.length; index += 1) {
      const entry = artifact.entries[index], expected = configured[index];
      const marketConfig = producer.MARKETS[expected.marketId];
      if (!entry || entry.mode !== "live" || entry.fixtureId !== null || !readOnly(entry.safety)
          || entry.schema !== single.SCHEMA || entry.kind !== "LiveWatch" || !iso(entry.generatedAt)
          || !budget(entry.diagnostics) || entry.diagnostics.simulatedRpcCount !== 0
          || entry.diagnostics.requestCount > artifact.diagnostics.requestCount
          || !["COMPLETE", "INCOMPLETE"].includes(entry.status) || !entry.identity
          || entry.identity.producer !== "tools/morpho-cbbtc-watch.js" || entry.identity.morpho !== single.MORPHO
          || entry.identity.chainId !== 8453 || entry.identity.marketId !== expected.marketId
          || entry.identity.borrower !== expected.borrower || entry.identity.loanToken !== USDC || entry.identity.loanDecimals !== 6
          || entry.identity.oracle !== marketConfig.oracle || entry.identity.collateralToken !== marketConfig.collateralToken
          || entry.identity.collateralDecimals !== marketConfig.collateralDecimals || !entry.pin || !entry.trigger) return false;
      if (entry.status === "COMPLETE") {
        if (!completePin(entry.pin) || !entry.metrics || entry.reason !== null
            || entry.pin.hash !== artifact.pin.hash || entry.pin.number !== artifact.pin.number
            || entry.pin.timestamp !== artifact.pin.timestamp) return false;
        // Decode canonical saved getter bytes and reuse the producer's local arithmetic only.
        const decode = (name, target, iface, names) => {
          const read = entry.reads && entry.reads[name];
          if (!read || read.target !== target || typeof read.returnData !== "string"
              || !/^0x(?:[0-9a-f]{64})+$/i.test(read.returnData) || read.returnData.length !== 2 + names.length * 64
              || read.sha256 !== crypto.createHash("sha256").update(Buffer.from(read.returnData.slice(2), "hex")).digest("hex")) fail("ARTIFACT_INVALID");
          const decoded = iface.decodeFunctionResult(name, read.returnData);
          const values = Object.fromEntries(names.map((field, i) => [field, typeof decoded[i] === "bigint" ? decoded[i].toString() : decoded[i].toLowerCase()]));
          if (iface.encodeFunctionResult(name, decoded).toLowerCase() !== read.returnData.toLowerCase()
              || JSON.stringify(read.values) !== JSON.stringify(values)) fail("ARTIFACT_INVALID");
          return decoded;
        };
        const params = decode("idToMarketParams", single.MORPHO, CORE, ["loanToken", "collateralToken", "oracle", "irm", "lltv"]);
        if (keccak256(entry.reads.idToMarketParams.returnData) !== expected.marketId || params[0].toLowerCase() !== USDC
            || params[1].toLowerCase() !== marketConfig.collateralToken || params[2].toLowerCase() !== marketConfig.oracle) return false;
        const position = decode("position", single.MORPHO, CORE, ["supplyShares", "borrowShares", "collateral"]);
        const market = decode("market", single.MORPHO, CORE, ["totalSupplyAssets", "totalSupplyShares", "totalBorrowAssets", "totalBorrowShares", "lastUpdate", "fee"]);
        const [price] = decode("price", marketConfig.oracle, PRICE, ["price"]);
        const needsRate = !/^0x0{40}$/i.test(params[3]) && BigInt(entry.pin.timestamp) > market[4];
        const rate = needsRate ? decode("borrowRateView", params[3].toLowerCase(), IRM, ["borrowRatePerSecondWad"])[0] : 0n;
        const metrics = single.compute(position, market, params, price, entry.pin.timestamp, rate);
        if (expected.marketId !== single.MARKET_ID || expected.borrower !== single.BORROWER) {
          delete metrics.collateralCbBTC; delete metrics.priceUsdcPerCbBTC;
          metrics.collateralAmount = decimal(position[2], marketConfig.collateralDecimals);
          metrics.wholeTokenPriceDecimals = 36 + 6 - marketConfig.collateralDecimals;
          metrics.priceUsdcPerCollateral = decimal(price, metrics.wholeTokenPriceDecimals);
        }
        if (!exactKeys(entry.metrics, Object.keys(metrics))
            || Object.keys(metrics).some((key) => entry.metrics[key] !== metrics[key])
            || entry.trigger.status !== metrics.verdict || entry.trigger.reason !== null) return false;
      }
      if (entry.status === "INCOMPLETE" && (entry.metrics !== null || entry.trigger.status !== "INCOMPLETE")) return false;
    }
    const complete = artifact.entries.filter((entry) => entry.status === "COMPLETE").length;
    const summary = artifact.crossPairSummary;
    return !!summary && summary.configured === configured.length && summary.captured === complete
      && summary.incomplete === configured.length - complete && Array.isArray(summary.pairs)
      && summary.pairs.length === configured.length
      && artifact.status === (complete === configured.length ? "COMPLETE" : "INCOMPLETE")
      && artifact.pin.valid === (artifact.status === "COMPLETE");
  }

  function annotateMorphoFreshness() {
    const row = health.morphoDaily;
    row.generatedAt = null;
    row.annotations = [];
    try {
      // Read the latest atomic status (the persisted evidence tail), never synthesize a zero.
      const artifact = readJsonStrict(path.join(workspace, MORPHO_DAILY_SPEC.artifactPath), fsImpl);
      const assessment = assessArtifactObject(artifact, {
        nowMs: now(), maxAgeMs: MORPHO_MAX_AGE_MS, maxFutureSkewMs: 0, validate: validateMorphoCapture
      });
      row.freshness = assessment.status;
      row.generatedAt = assessment.generatedAt || null;
      if (assessment.status === "VALID_STALE") row.annotations.push("MORPHO_CAPTURE_OLDER_THAN_26_HOURS");
      else if (assessment.status !== "VALID_FRESH") row.annotations.push("MORPHO_CAPTURE_INVALID");
      if (artifact.status === "INCOMPLETE") row.annotations.push("MORPHO_CAPTURE_INCOMPLETE_NOT_ZERO");
      if (["VALID_FRESH", "VALID_STALE"].includes(assessment.status)
          && artifact.entries.some((entry) => ["NEAR_LIQUIDATION", "LIQUIDATABLE"].includes(entry.trigger.status))) {
        row.annotations.push("MORPHO_NON_ZERO_OBSERVATIONS_REVIEW_ONLY");
      }
    } catch (error) {
      row.freshness = error && error.code === "ENOENT" ? "MISSING" : "MALFORMED";
      row.annotations.push(row.freshness === "MISSING" ? "MORPHO_CAPTURE_MISSING" : "MORPHO_CAPTURE_INVALID");
    }
    if (row.status === "INTERRUPTED") row.annotations.push("MORPHO_ATTEMPT_INTERRUPTED_NO_AUTOMATIC_RETRY");
    if (row.lastDueAt && Date.parse(row.lastAttemptAt) - Date.parse(row.lastDueAt) > MORPHO_DISPATCH_WINDOW_MS) {
      row.annotations.push("MORPHO_DISPATCH_AFTER_00_15_UTC");
    }
  }

  async function runMorphoDailyDue() {
    if (inCycle || inA12Daily || inMorphoDaily) return false;
    inMorphoDaily = true;
    try {
      const current = now(), dueMs = utcDailyDueMs(current);
      annotateMorphoFreshness();
      if (health.morphoDaily.lastDueAt !== null && Date.parse(health.morphoDaily.lastDueAt) >= dueMs) {
        publishNow();
        return false;
      }
      health.morphoDaily = {
        ...health.morphoDaily, status: "INFLIGHT", lastDueAt: new Date(dueMs).toISOString(),
        lastAttemptAt: new Date(current).toISOString(), nextDueAt: new Date(dueMs + 86400000).toISOString(),
        exitCode: null, durationMs: 0, readOnly: true
      };
      annotateMorphoFreshness();
      // Same atomic fsync/rename/readback helper as A12; a claimed UTC slot never retries.
      publishNow();
      const commandPath = path.join(workspace, MORPHO_DAILY_SPEC.command);
      if (!exists(commandPath)) health.morphoDaily.status = "NOT_INSTALLED";
      else {
        try {
          const result = await runner(commandPath, {
            id: MORPHO_DAILY_SPEC.id, daily: true, readOnly: true, args: [...MORPHO_DAILY_SPEC.args]
          });
          const row = health.morphoDaily;
          row.exitCode = result.exitCode;
          row.durationMs = Math.max(0, Math.round(result.durationMs || 0));
          row.status = result.timedOut ? "TIMEOUT" : result.exitCode === 0 ? "ARTIFACT_INVALID" : "FAILED";
          // A nonzero exit may still leave INCOMPLETE evidence, never a successful zero.
          if (!result.timedOut) {
            try {
              const artifact = readJsonStrict(path.join(workspace, MORPHO_DAILY_SPEC.artifactPath), fsImpl);
              const generatedMs = Date.parse(artifact.generatedAt);
              if (validateMorphoCapture(artifact) && generatedMs >= current && generatedMs <= now()) {
                if (artifact.status === "INCOMPLETE") row.status = "INCOMPLETE";
                else if (result.exitCode === 0) row.status = "PASS";
              }
            } catch (_) { /* missing/stale/invalid evidence never establishes a successful zero */ }
          }
        } catch (_) { health.morphoDaily.status = "FAILED"; }
      }
      annotateMorphoFreshness();
      publishNow();
      return true;
    } finally { inMorphoDaily = false; }
  }

  function validateGmxCapture(artifact) {
    // The producer has no validateArtifact export; validate its indexed, read-only
    // envelope locally. No RPC, canonical-block claim, or execution policy is added.
    const producer = require(path.join(workspace, GMX_DAILY_SPEC.command));
    const safety = artifact && artifact.safety;
    if (!artifact || artifact.schema !== producer.SCHEMA || artifact.kind !== "LiveWatch"
        || artifact.mode !== "live" || artifact.fixtureId !== null || !iso(artifact.generatedAt)
        || !["COMPLETE", "INCOMPLETE"].includes(artifact.status) || artifact.enforcement !== producer.ENFORCEMENT
        || !artifact.identity || artifact.identity.chainId !== 42161 || artifact.identity.protocol !== "GMX v2"
        || artifact.identity.producer !== GMX_DAILY_SPEC.command || artifact.identity.selection !== "default-top-10"
        || !safety || safety.readOnly !== true
        || ["signing", "submission", "deployment", "stateMutation", "simulation", "forkExecution", "routePositive",
          "executableNow", "signedActionJustified", "alertDispatch", "keysRead"].some((key) => safety[key] !== false)
        || !artifact.diagnostics || artifact.diagnostics.rpcCount !== 0 || artifact.diagnostics.retries !== 0
        || artifact.diagnostics.requestCount !== 1 || artifact.diagnostics.networkRequestCount !== 1
        || !artifact.pin || artifact.pin.requested !== "indexed" || artifact.pin.chainBlockHashVerified !== false
        || !Array.isArray(artifact.positions) || artifact.positions.length > 10 || !safeSerialized(artifact)) return false;
    const keys = new Set();
    for (const position of artifact.positions) {
      if (!position || !["COMPLETE", "INCOMPLETE"].includes(position.status)) return false;
      if (position.status === "INCOMPLETE") {
        if (position.verdict !== "INCOMPLETE") return false;
        continue;
      }
      if (!/^0x[0-9a-f]{64}$/.test(position.positionKey) || keys.has(position.positionKey)
          || !/^\d+$/.test(position.indexedLeverageRaw) || BigInt(position.indexedLeverageRaw) <= 0n) return false;
      keys.add(position.positionKey);
      const comparison = position.comparedWithPrevious;
      if (!comparison || !["COMPARED", "NO_COMPARABLE_PREVIOUS"].includes(comparison.status)) return false;
      if (comparison.status === "COMPARED" && (!iso(comparison.previousGeneratedAt)
          || Date.parse(comparison.previousGeneratedAt) >= Date.parse(artifact.generatedAt)
          || !comparison.deltas || !/^-?\d+\.\d{4}$/.test(comparison.deltas.indexedLeverage))) return false;
    }
    const summary = artifact.crossSectionSummary;
    if (!summary || JSON.stringify(summary) !== JSON.stringify({
      ...producer.summarize(artifact.positions), partial: artifact.status !== "COMPLETE"
    })) return false;
    return artifact.status !== "COMPLETE" || (artifact.pin.valid === true
      && Number.isSafeInteger(artifact.pin.number) && Number.isSafeInteger(artifact.pin.finalizedHeight)
      && artifact.pin.finalizedHeight >= 0 && artifact.pin.number >= artifact.pin.finalizedHeight
      && artifact.positions.every((position) => position.status === "COMPLETE"));
  }

  function annotateGmxFreshness() {
    const row = health.gmxDaily;
    row.generatedAt = null;
    row.annotations = [];
    try {
      const artifact = readJsonStrict(path.join(workspace, GMX_DAILY_SPEC.artifactPath), fsImpl);
      const assessment = assessArtifactObject(artifact, {
        nowMs: now(), maxAgeMs: GMX_MAX_AGE_MS, maxFutureSkewMs: 0, validate: validateGmxCapture
      });
      row.freshness = assessment.status;
      row.generatedAt = assessment.generatedAt || null;
      if (assessment.status === "VALID_STALE") row.annotations.push("GMX_CAPTURE_OLDER_THAN_26_HOURS");
      else if (assessment.status !== "VALID_FRESH") row.annotations.push("GMX_CAPTURE_INVALID");
      if (artifact.status === "INCOMPLETE") row.annotations.push("GMX_CAPTURE_INCOMPLETE_NOT_ZERO");
      // Material increase = an upward crossing into the 10–25x or >25x bucket
      // for the SAME positionKey since its previous capture. High leverage alone
      // (or a newly selected position with no comparison) is not a non-zero delta.
      if (["VALID_FRESH", "VALID_STALE"].includes(assessment.status)
          && artifact.positions.some((position) => {
            const comparison = position.comparedWithPrevious;
            if (position.status !== "COMPLETE" || comparison.status !== "COMPARED") return false;
            const delta = BigInt(comparison.deltas.indexedLeverage.replace(".", ""));
            const current = BigInt(position.indexedLeverageRaw), previous = current - delta;
            return delta > 0n && previous > 0n
              && ((previous < 100000n && current >= 100000n) || (previous <= 250000n && current > 250000n));
          })) row.annotations.push("GMX_NON_ZERO_LEVERAGE_INCREASE_OBSERVATIONS_REVIEW_ONLY");
    } catch (error) {
      row.freshness = error && error.code === "ENOENT" ? "MISSING" : "MALFORMED";
      row.annotations.push(row.freshness === "MISSING" ? "GMX_CAPTURE_MISSING" : "GMX_CAPTURE_INVALID");
    }
    if (row.status === "INTERRUPTED") row.annotations.push("GMX_ATTEMPT_INTERRUPTED_NO_AUTOMATIC_RETRY");
    if (row.lastDueAt && Date.parse(row.lastAttemptAt) - Date.parse(row.lastDueAt) > GMX_DISPATCH_WINDOW_MS) {
      row.annotations.push("GMX_DISPATCH_AFTER_00_15_UTC");
    }
  }

  async function runGmxDailyDue() {
    if (inCycle || inA12Daily || inMorphoDaily) return false;
    // Reuse the existing sequential exclusion barrier, not any producer/daily
    // slot: this leaves A12, Morpho and the 900 s runCycle implementation intact.
    inCycle = true;
    try {
      const current = now(), dueMs = utcDailyDueMs(current);
      annotateGmxFreshness();
      if (health.gmxDaily.lastDueAt !== null && Date.parse(health.gmxDaily.lastDueAt) >= dueMs) {
        publishNow();
        return false;
      }
      health.gmxDaily = {
        ...health.gmxDaily, status: "INFLIGHT", lastDueAt: new Date(dueMs).toISOString(),
        lastAttemptAt: new Date(current).toISOString(), nextDueAt: new Date(dueMs + 86400000).toISOString(),
        exitCode: null, durationMs: 0, readOnly: true
      };
      annotateGmxFreshness();
      // publishAtomic fsync/rename/readback MUST succeed before dispatch. Claimed
      // UTC days are never retried, including after a crash or producer failure.
      publishNow();
      const commandPath = path.join(workspace, GMX_DAILY_SPEC.command);
      if (!exists(commandPath)) health.gmxDaily.status = "NOT_INSTALLED";
      else {
        try {
          const result = await runner(commandPath, {
            id: GMX_DAILY_SPEC.id, daily: true, readOnly: true, args: [...GMX_DAILY_SPEC.args]
          });
          const row = health.gmxDaily;
          row.exitCode = result.exitCode;
          row.durationMs = Math.max(0, Math.round(result.durationMs || 0));
          row.status = result.timedOut ? "TIMEOUT" : result.exitCode === 0 ? "ARTIFACT_INVALID" : "FAILED";
          if (!result.timedOut) {
            try {
              const artifact = readJsonStrict(path.join(workspace, GMX_DAILY_SPEC.artifactPath), fsImpl);
              const generatedMs = Date.parse(artifact.generatedAt);
              if (validateGmxCapture(artifact) && generatedMs >= current && generatedMs <= now()) {
                if (artifact.status === "INCOMPLETE") row.status = "INCOMPLETE";
                else if (result.exitCode === 0) row.status = "PASS";
              }
            } catch (_) { /* incomplete/missing/invalid evidence is never a successful zero */ }
          }
        } catch (_) { health.gmxDaily.status = "FAILED"; }
      }
      annotateGmxFreshness();
      publishNow();
      return true;
    } finally { inCycle = false; }
  }

  function validateAaveV3Capture(artifact) {
    // No validateArtifact export: check the producer's read-only envelope and
    // decode saved getter bytes locally. This never calls capture or any RPC.
    const producer = require(path.join(workspace, AAVE_V3_DAILY_SPEC.command));
    // Bind to the producer's ordered --composite-83 selection, never an artifact-supplied list.
    const configured = producer.allFourChainsList(), safety = artifact && artifact.safety;
    const watchListSha256 = crypto.createHash("sha256").update(`${JSON.stringify(configured, null, 2)}\n`).digest("hex");
    if (!artifact || artifact.schema !== producer.SCHEMA || artifact.kind !== "LiveWatch"
        || artifact.mode !== "live" || artifact.fixtureId !== null || !iso(artifact.generatedAt)
        || !["COMPLETE", "INCOMPLETE"].includes(artifact.status) || artifact.enforcement !== producer.ENFORCEMENT
        || !artifact.identity || artifact.identity.producer !== AAVE_V3_DAILY_SPEC.command
        || artifact.identity.protocol !== "Aave V3" || artifact.identity.watchListSha256 !== watchListSha256
        || !safety || safety.readOnly !== true
        || ["signing", "submission", "deployment", "stateMutation", "simulation", "forkExecution", "routePositive",
          "executableNow", "signedActionJustified", "alertDispatch", "rpcUrlsStored", "endpointUrlsStored",
          "keysRead", "authMaterialStored"].some((key) => safety[key] !== false)
        || !artifact.diagnostics || !Number.isSafeInteger(artifact.diagnostics.rpcCount)
        || artifact.diagnostics.rpcCount < 0 || artifact.diagnostics.rpcCount > 40
        || artifact.diagnostics.networkRequestCount !== artifact.diagnostics.rpcCount
        || artifact.diagnostics.maxRequests !== 40 || artifact.diagnostics.retries !== 0
        || artifact.diagnostics.perUserCallCap !== 4 || !artifact.pins
        || configured.length !== 83 || !Array.isArray(artifact.borrowers)
        || artifact.borrowers.length !== configured.length || !safeSerialized(artifact)) return false;
    for (let index = 0; index < configured.length; index += 1) {
      const row = artifact.borrowers[index], expected = configured[index];
      if (!row || row.chainId !== expected.chainId || row.chain !== expected.chain
          || row.market !== expected.market || row.user !== expected.user
          || !["COMPLETE", "INCOMPLETE"].includes(row.status)) return false;
      if (row.status === "INCOMPLETE") {
        if (row.verdict !== "INCOMPLETE") return false;
        continue;
      }
      const pin = artifact.pins[row.chainId];
      if (!pin || pin.requested !== "finalized" || pin.valid !== true || pin.rechecked !== true
          || pin.chainIdVerified !== true || !Number.isSafeInteger(pin.number) || pin.number < 0
          || !/^0x[0-9a-f]{64}$/.test(pin.hash)) return false;
      const decoded = producer.decodeAccount(row.read && row.read.returnData);
      if (Object.keys(decoded).some((key) => JSON.stringify(row[key]) !== JSON.stringify(decoded[key]))) return false;
    }
    const complete = artifact.borrowers.filter((row) => row.status === "COMPLETE").length;
    const summary = artifact.crossSectionSummary;
    return !!summary && summary.count === configured.length && summary.completeCount === complete
      && summary.incompleteCount === configured.length - complete && summary.partial === (artifact.status !== "COMPLETE")
      && (artifact.status !== "COMPLETE" || complete === configured.length);
  }

  function annotateAaveV3Freshness() {
    const row = health.aaveV3Daily;
    row.generatedAt = null;
    row.annotations = [];
    try {
      const artifact = readJsonStrict(path.join(workspace, AAVE_V3_DAILY_SPEC.artifactPath), fsImpl);
      const assessment = assessArtifactObject(artifact, {
        nowMs: now(), maxAgeMs: AAVE_V3_MAX_AGE_MS, maxFutureSkewMs: 0, validate: validateAaveV3Capture
      });
      row.freshness = assessment.status;
      row.generatedAt = assessment.generatedAt || null;
      if (assessment.status === "VALID_STALE") row.annotations.push("AAVE_V3_CAPTURE_OLDER_THAN_26_HOURS");
      else if (assessment.status !== "VALID_FRESH") row.annotations.push("AAVE_V3_CAPTURE_INVALID");
      if (artifact.status === "INCOMPLETE") row.annotations.push("AAVE_V3_CAPTURE_INCOMPLETE_NOT_ZERO");
      // Include every observed HF <= 1.10, even zero-debt rows and complete rows
      // within a partial capture; this is a review note, never execution authority.
      if (["VALID_FRESH", "VALID_STALE"].includes(assessment.status)
          && artifact.borrowers.some((borrower) => borrower.status === "COMPLETE"
            && BigInt(borrower.hfWad) <= 1100000000000000000n)) {
        row.annotations.push("REVIEW_NOTE: AAVE_V3_NON_ZERO_OBSERVATIONS_REVIEW_ONLY");
      }
    } catch (error) {
      row.freshness = error && error.code === "ENOENT" ? "MISSING" : "MALFORMED";
      row.annotations.push(row.freshness === "MISSING" ? "AAVE_V3_CAPTURE_MISSING" : "AAVE_V3_CAPTURE_INVALID");
    }
    if (row.status === "INTERRUPTED") row.annotations.push("AAVE_V3_ATTEMPT_INTERRUPTED_NO_AUTOMATIC_RETRY");
    if (row.lastDueAt && Date.parse(row.lastAttemptAt) - Date.parse(row.lastDueAt) > AAVE_V3_DISPATCH_WINDOW_MS) {
      row.annotations.push("AAVE_V3_DISPATCH_AFTER_00_15_UTC");
    }
  }

  async function runAaveV3DailyDue() {
    if (inCycle || inA12Daily || inMorphoDaily) return false;
    // Share only the sequential exclusion barrier (as GMX does), never another
    // daily state slot. Existing daily gates and runCycle remain unchanged.
    inCycle = true;
    try {
      const current = now(), dueMs = utcDailyDueMs(current);
      annotateAaveV3Freshness();
      if (health.aaveV3Daily.lastDueAt !== null && Date.parse(health.aaveV3Daily.lastDueAt) >= dueMs) {
        publishNow();
        return false;
      }
      health.aaveV3Daily = {
        ...health.aaveV3Daily, status: "INFLIGHT", lastDueAt: new Date(dueMs).toISOString(),
        lastAttemptAt: new Date(current).toISOString(), nextDueAt: new Date(dueMs + 86400000).toISOString(),
        exitCode: null, durationMs: 0, readOnly: true
      };
      annotateAaveV3Freshness();
      // publishNow -> publishAtomic fsync/rename/readback claim BEFORE spawn.
      // Restart, timeout and failed/incomplete evidence never retry this UTC day.
      publishNow();
      const commandPath = path.join(workspace, AAVE_V3_DAILY_SPEC.command);
      if (!exists(commandPath)) health.aaveV3Daily.status = "NOT_INSTALLED";
      else {
        try {
          const result = await runner(commandPath, {
            id: AAVE_V3_DAILY_SPEC.id, daily: true, readOnly: true, args: [...AAVE_V3_DAILY_SPEC.args]
          });
          const row = health.aaveV3Daily;
          row.exitCode = result.exitCode;
          row.durationMs = Math.max(0, Math.round(result.durationMs || 0));
          row.status = result.timedOut ? "TIMEOUT" : result.exitCode === 0 ? "ARTIFACT_INVALID" : "FAILED";
          if (!result.timedOut) {
            try {
              const artifact = readJsonStrict(path.join(workspace, AAVE_V3_DAILY_SPEC.artifactPath), fsImpl);
              const generatedMs = Date.parse(artifact.generatedAt);
              if (validateAaveV3Capture(artifact) && generatedMs >= current && generatedMs <= now()) {
                if (artifact.status === "INCOMPLETE") row.status = "INCOMPLETE";
                else if (result.exitCode === 0) row.status = "PASS";
              }
            } catch (_) { /* incomplete/missing/invalid evidence is never a successful zero */ }
          }
        } catch (_) { health.aaveV3Daily.status = "FAILED"; }
      }
      annotateAaveV3Freshness();
      publishNow();
      return true;
    } finally { inCycle = false; }
  }

  function validateCompoundV3Capture(artifact) {
    // No validateArtifact/SCHEMA export: check the saved read-only envelope and
    // HF arithmetic locally. Requiring the producer never invokes capture/RPC.
    const producer = require(path.join(workspace, COMPOUND_V3_DAILY_SPEC.command));
    const safety = artifact && artifact.safety;
    if (!artifact || artifact.schema !== "compound-v3-base-watch/v1" || artifact.kind !== "LiveWatch"
        || artifact.mode !== "live" || artifact.fixtureId !== null || !iso(artifact.generatedAt)
        || !["COMPLETE", "INCOMPLETE"].includes(artifact.status)
        || !artifact.identity || artifact.identity.producer !== COMPOUND_V3_DAILY_SPEC.command
        || artifact.identity.protocol !== "Compound V3" || artifact.identity.chainId !== 8453
        || artifact.identity.chain !== "Base" || artifact.identity.market !== producer.MARKET || artifact.identity.topN !== 20
        || !safety || safety.readOnly !== true
        || ["signing", "deployment", "transactions", "stateMutation", "simulation", "forkExecution", "alertDispatch",
          "executableNow", "signedActionJustified", "rpcUrlsStored", "keysRead", "authMaterialStored"].some((key) => safety[key] !== false)
        || !artifact.diagnostics || !Number.isSafeInteger(artifact.diagnostics.rpcCount)
        || artifact.diagnostics.rpcCount < 0 || artifact.diagnostics.rpcCount > producer.MAX_REQUESTS
        || artifact.diagnostics.networkRequestCount !== artifact.diagnostics.rpcCount
        || artifact.diagnostics.maxRequests !== producer.MAX_REQUESTS || artifact.diagnostics.retries !== 0
        || !artifact.pin || artifact.pin.requested !== "finalized" || !artifact.discovery
        || artifact.discovery.protocolWideRankingEstablished !== false
        || !Array.isArray(artifact.borrowers) || artifact.borrowers.length > 20 || !safeSerialized(artifact)) return false;
    const users = new Set();
    for (let index = 0; index < artifact.borrowers.length; index += 1) {
      const row = artifact.borrowers[index];
      if (!row || !/^0x[0-9a-f]{40}$/.test(row.user) || users.has(row.user)
          || row.chainId !== 8453 || row.chain !== "Base" || row.market !== producer.MARKET
          || row.debtRankWithinWindow !== index + 1 || !["COMPLETE", "INCOMPLETE"].includes(row.status)) return false;
      users.add(row.user);
      if (row.status === "INCOMPLETE") {
        if (row.verdict !== "INCOMPLETE" || row.hf !== null) return false;
        continue;
      }
      if (artifact.pin.valid !== true || artifact.pin.rechecked !== true || artifact.pin.chainIdVerified !== true
          || !Number.isSafeInteger(artifact.pin.number) || artifact.pin.number < 0 || !/^0x[0-9a-f]{64}$/.test(artifact.pin.hash)
          || !/^\d+$/.test(row.debtRaw) || !/^\d+$/.test(row.debtUsdRaw)
          || !/^\d+$/.test(row.liquidationAdjustedUsdRaw) || row.noDebt !== (BigInt(row.debtRaw) === 0n)) return false;
      const debtUsd = BigInt(row.debtUsdRaw);
      if (row.noDebt) {
        if (debtUsd !== 0n || row.hfWad !== null || row.hf !== null || row.verdict !== "HEALTHY") return false;
      } else {
        if (debtUsd <= 0n || !/^\d+$/.test(row.hfWad)
            || BigInt(row.hfWad) !== BigInt(row.liquidationAdjustedUsdRaw) * 1000000000000000000n / debtUsd
            || row.verdict !== producer.classify(row.hfWad)) return false;
      }
    }
    const complete = artifact.borrowers.filter((row) => row.status === "COMPLETE").length;
    const summary = artifact.crossSectionSummary;
    return !!summary && summary.requestedTopN === 20 && summary.count === artifact.borrowers.length
      && summary.completeCount === complete && summary.partial === (artifact.status !== "COMPLETE")
      && summary.emptySelection === (artifact.borrowers.length === 0)
      && (artifact.status !== "COMPLETE" || (complete === artifact.borrowers.length && artifact.pin.valid === true
        && artifact.pin.rechecked === true && artifact.pin.chainIdVerified === true
        && artifact.discovery.rankingEstablishedWithinWindow === true));
  }

  function annotateCompoundV3Freshness() {
    const row = health.compoundV3Daily;
    row.generatedAt = null;
    row.annotations = [];
    try {
      const artifact = readJsonStrict(path.join(workspace, COMPOUND_V3_DAILY_SPEC.artifactPath), fsImpl);
      const assessment = assessArtifactObject(artifact, {
        nowMs: now(), maxAgeMs: COMPOUND_V3_MAX_AGE_MS, maxFutureSkewMs: 0, validate: validateCompoundV3Capture
      });
      row.freshness = assessment.status;
      row.generatedAt = assessment.generatedAt || null;
      if (assessment.status === "VALID_STALE") row.annotations.push("COMPOUND_V3_CAPTURE_OLDER_THAN_26_HOURS");
      else if (assessment.status !== "VALID_FRESH") row.annotations.push("COMPOUND_V3_CAPTURE_INVALID");
      if (artifact.status === "INCOMPLETE") row.annotations.push("COMPOUND_V3_CAPTURE_INCOMPLETE_NOT_ZERO");
      // Include the exact 1.10 boundary and complete rows within partial evidence.
      // This is a review note only, never liquidation or execution authority.
      if (["VALID_FRESH", "VALID_STALE"].includes(assessment.status)
          && artifact.borrowers.some((borrower) => borrower.status === "COMPLETE" && borrower.hfWad !== null
            && BigInt(borrower.hfWad) <= 1100000000000000000n)) {
        row.annotations.push("REVIEW_NOTE: COMPOUND_V3_NON_ZERO_OBSERVATIONS_REVIEW_ONLY");
      }
    } catch (error) {
      row.freshness = error && error.code === "ENOENT" ? "MISSING" : "MALFORMED";
      row.annotations.push(row.freshness === "MISSING" ? "COMPOUND_V3_CAPTURE_MISSING" : "COMPOUND_V3_CAPTURE_INVALID");
    }
    if (row.status === "INTERRUPTED") row.annotations.push("COMPOUND_V3_ATTEMPT_INTERRUPTED_NO_AUTOMATIC_RETRY");
    if (row.lastDueAt && Date.parse(row.lastAttemptAt) - Date.parse(row.lastDueAt) > COMPOUND_V3_DISPATCH_WINDOW_MS) {
      row.annotations.push("COMPOUND_V3_DISPATCH_AFTER_00_15_UTC");
    }
  }

  async function runCompoundV3DailyDue() {
    if (inCycle || inA12Daily || inMorphoDaily) return false;
    // Share only the sequential exclusion barrier, not another daily state slot.
    // The existing daily gates and 900 s runCycle remain unchanged.
    inCycle = true;
    try {
      const current = now(), dueMs = utcDailyDueMs(current);
      annotateCompoundV3Freshness();
      if (health.compoundV3Daily.lastDueAt !== null && Date.parse(health.compoundV3Daily.lastDueAt) >= dueMs) {
        publishNow();
        return false;
      }
      health.compoundV3Daily = {
        ...health.compoundV3Daily, status: "INFLIGHT", lastDueAt: new Date(dueMs).toISOString(),
        lastAttemptAt: new Date(current).toISOString(), nextDueAt: new Date(dueMs + 86400000).toISOString(),
        exitCode: null, durationMs: 0, readOnly: true
      };
      annotateCompoundV3Freshness();
      // publishNow -> publishAtomic fsync/rename/readback claim BEFORE spawn.
      // Restart, timeout and failed/incomplete evidence never retry this UTC day.
      publishNow();
      const commandPath = path.join(workspace, COMPOUND_V3_DAILY_SPEC.command);
      if (!exists(commandPath)) health.compoundV3Daily.status = "NOT_INSTALLED";
      else {
        try {
          const result = await runner(commandPath, {
            id: COMPOUND_V3_DAILY_SPEC.id, daily: true, readOnly: true, args: [...COMPOUND_V3_DAILY_SPEC.args]
          });
          const row = health.compoundV3Daily;
          row.exitCode = result.exitCode;
          row.durationMs = Math.max(0, Math.round(result.durationMs || 0));
          row.status = result.timedOut ? "TIMEOUT" : result.exitCode === 0 ? "ARTIFACT_INVALID" : "FAILED";
          if (!result.timedOut) {
            try {
              const artifact = readJsonStrict(path.join(workspace, COMPOUND_V3_DAILY_SPEC.artifactPath), fsImpl);
              const generatedMs = Date.parse(artifact.generatedAt);
              if (validateCompoundV3Capture(artifact) && generatedMs >= current && generatedMs <= now()) {
                if (artifact.status === "INCOMPLETE") row.status = "INCOMPLETE";
                else if (result.exitCode === 0) row.status = "PASS";
              }
            } catch (_) { /* incomplete/missing/invalid evidence is never a successful zero */ }
          }
        } catch (_) { health.compoundV3Daily.status = "FAILED"; }
      }
      annotateCompoundV3Freshness();
      publishNow();
      return true;
    } finally { inCycle = false; }
  }

  function scheduleNextDiscovery(status, current) {
    const retryable = status === "FAILED" || status === "TIMEOUT" || status === "ARTIFACT_INVALID";
    if (!retryable) {
      discoveryRetryStreak = 0;
      discoveryNextDueMs = current + DISCOVERY_CADENCE_SECONDS * 1000;
      return;
    }
    discoveryRetryStreak += 1;
    discoveryNextDueMs = current + (discoveryRetryStreak <= DISCOVERY_MAX_SHORT_RETRIES
      ? DISCOVERY_RETRY_SECONDS * 1000
      : DISCOVERY_CADENCE_SECONDS * 1000);
  }

  async function runDiscovery() {
    const current = now();
    if (discoveryLastAttemptMs !== null) {
      const dueMs = discoveryNextDueMs === null ? discoveryLastAttemptMs + DISCOVERY_CADENCE_SECONDS * 1000 : discoveryNextDueMs;
      if (current < dueMs) {
        health.discovery = {
          status: "NOT_DUE", lastAttemptAt: new Date(discoveryLastAttemptMs).toISOString(),
          nextDueAt: new Date(dueMs).toISOString(),
          exitCode: null, durationMs: 0, artifactPath: health.discovery.artifactPath
        };
        return;
      }
    }
    discoveryLastAttemptMs = current;
    const commandPath = path.join(workspace, DISCOVERY_COMMAND);
    if (!exists(commandPath)) {
      discoveryRetryStreak = 0;
      discoveryNextDueMs = current + DISCOVERY_CADENCE_SECONDS * 1000;
      health.discovery = {
        status: "NOT_INSTALLED", lastAttemptAt: new Date(current).toISOString(),
        nextDueAt: new Date(discoveryNextDueMs).toISOString(),
        exitCode: null, durationMs: 0, artifactPath: DISCOVERY_ARTIFACT
      };
      return;
    }
    const contract = discoveryFactory();
    const artifactPath = contract && relativePath(contract.artifactPath) ? contract.artifactPath : DISCOVERY_ARTIFACT;
    let canonicalSentinelCommitment = null;
    let validatedPrefilter = null;
    let rankerEligible = true;
    const result = await runner(commandPath, { id: "official-deployed-delta-sentinel", discovery: true });
    let status = result.timedOut ? "TIMEOUT" : result.exitCode === 0 ? "ARTIFACT_INVALID" : "FAILED";
    if (!result.timedOut && result.exitCode === 0 && contract) {
      try {
        const artifact = readJsonStrict(path.join(workspace, artifactPath), fsImpl);
        if (artifact.schema === contract.expectedSchema && contract.validateArtifact(artifact)) {
          status = "PASS";
          canonicalSentinelCommitment = candidateFeedModule.sha256Canonical(artifact);
        }
      } catch (_) { /* invalid discovery artifacts are never interpreted */ }
    }
    let exitCode = result.exitCode;
    let durationMs = Math.max(0, Math.round(result.durationMs || 0));
    if (status === "PASS") {
      const refreshPath = path.join(workspace, DELTA_BINDER_REFRESH_COMMAND);
      const refreshContract = deltaBinderRefreshFactory();
      if (exists(refreshPath) && refreshContract) {
        const refreshResult = await runner(refreshPath, {
          id: refreshContract.id || DELTA_BINDER_REFRESH_ID,
          discovery: true,
          deltaBinderRefresh: true,
          args: Array.isArray(refreshContract.args) ? refreshContract.args : [...DELTA_BINDER_REFRESH_ARGS]
        });
        exitCode = refreshResult.exitCode;
        durationMs += Math.max(0, Math.round(refreshResult.durationMs || 0));
        status = refreshResult.timedOut ? "TIMEOUT" : refreshResult.exitCode === 0 ? "PASS" : "FAILED";
      }
    }
    if (status === "PASS") {
      const scorerPath = path.join(workspace, SCORER_COMMAND);
      const scorerContract = scorerFactory();
      if (!exists(scorerPath) || !scorerContract || scorerContract.artifactPath !== SCORER_ARTIFACT) {
        status = "FAILED";
        exitCode = null;
      } else {
        const scorerStartedAt = now();
        const scorerResult = await runner(scorerPath, { id: "deployed-delta-source-risk-scorer", discovery: true, scorer: true });
        exitCode = scorerResult.exitCode;
        durationMs += Math.max(0, Math.round(scorerResult.durationMs || 0));
        status = scorerResult.timedOut ? "TIMEOUT" : scorerResult.exitCode === 0 ? "ARTIFACT_INVALID" : "FAILED";
        if (!scorerResult.timedOut && scorerResult.exitCode === 0) {
          try {
            const artifact = readJsonStrict(path.join(workspace, SCORER_ARTIFACT), fsImpl);
            const generatedMs = Date.parse(artifact.generatedAt);
            const completedMs = now();
            if (artifact.schema === scorerContract.expectedSchema && scorerContract.validateArtifact(artifact)
                && safeSerialized(artifact) && generatedMs >= scorerStartedAt && generatedMs <= completedMs) status = "PASS";
          } catch (_) { /* invalid scorer artifacts keep discovery fail-closed */ }
        }
      }
    }
    if (status === "PASS") {
      const extractorPath = path.join(workspace, EXTRACTOR_COMMAND);
      const extractorContract = extractorFactory();
      const mappingContract = mappingFactory();
      const metadataContract = metadataFactory();
      const authorityContract = authorityFactory();
      const binderContract = binderFactory();
      const invariantContract = invariantFactory();
      if (!exists(extractorPath) || !extractorContract || extractorContract.artifactPath !== EXTRACTOR_ARTIFACT
          || !mappingContract || mappingContract.artifactPath !== MAPPING_ARTIFACT
          || !metadataContract || metadataContract.artifactPath !== METADATA_ARTIFACT
          || !authorityContract || authorityContract.artifactPath !== AUTHORITY_ARTIFACT
          || !binderContract || binderContract.artifactPath !== BINDER_ARTIFACT
          || !invariantContract || invariantContract.artifactPath !== INVARIANT_ARTIFACT) {
        status = "FAILED";
        exitCode = null;
      } else {
        const extractorStartedAt = now();
        const extractorResult = await runner(extractorPath, { id: "deployed-delta-manifest-extractor", discovery: true, extractor: true });
        exitCode = extractorResult.exitCode;
        durationMs += Math.max(0, Math.round(extractorResult.durationMs || 0));
        status = extractorResult.timedOut ? "TIMEOUT" : extractorResult.exitCode === 0 ? "ARTIFACT_INVALID" : "FAILED";
        if (!extractorResult.timedOut && extractorResult.exitCode === 0) {
          try {
            const artifact = readJsonStrict(path.join(workspace, EXTRACTOR_ARTIFACT), fsImpl);
            const mappingArtifact = readJsonStrict(path.join(workspace, MAPPING_ARTIFACT), fsImpl);
            const metadataArtifact = readJsonStrict(path.join(workspace, METADATA_ARTIFACT), fsImpl);
            const authorityArtifact = readJsonStrict(path.join(workspace, AUTHORITY_ARTIFACT), fsImpl);
            const binderArtifact = readJsonStrict(path.join(workspace, BINDER_ARTIFACT), fsImpl);
            const invariantArtifact = readJsonStrict(path.join(workspace, INVARIANT_ARTIFACT), fsImpl);
            const generatedMs = Date.parse(artifact.generatedAt);
            const mappingGeneratedMs = Date.parse(mappingArtifact.generatedAt);
            const metadataGeneratedMs = Date.parse(metadataArtifact.generatedAt);
            const authorityGeneratedMs = Date.parse(authorityArtifact.generatedAt);
            const binderGeneratedMs = Date.parse(binderArtifact.generatedAt);
            const invariantGeneratedMs = Date.parse(invariantArtifact.generatedAt);
            const completedMs = now();
            const upstreamExtractorCommitment = candidateFeedModule.sha256Canonical(artifact);
            const exactMappingCommitments = mappingArtifact.rows.filter((row) => row.status === "EXACT")
              .map((row) => row.mappingCommitment);
            const exactMappingSet = new Set(exactMappingCommitments);
            const exactMetadataRows = metadataArtifact.rows.filter((row) => row.status === "EXACT");
            const exactMetadataCommitments = exactMetadataRows.map((row) => row.buildMetadataCommitment);
            const exactMetadataSet = new Set(exactMetadataCommitments);
            const metadataMappingReferences = metadataArtifact.rows.map((row) => row.mappingCommitment);
            const mappingMetadataJoin = exactMappingSet.size === exactMappingCommitments.length
              && new Set(metadataMappingReferences).size === metadataMappingReferences.length
              && metadataMappingReferences.length === exactMappingCommitments.length
              && metadataMappingReferences.every((commitment) => exactMappingSet.has(commitment));
            const exactAuthorityRows = authorityArtifact.rows.filter((row) => row.status === "EXACT");
            const exactAuthorityCommitments = exactAuthorityRows.map((row) => row.authorityCommitment);
            const exactAuthoritySet = new Set(exactAuthorityCommitments);
            const authorityMetadataReferences = exactAuthorityRows.map((row) => row.metadataCommitment);
            const metadataAuthorityJoin = exactMetadataSet.size === exactMetadataCommitments.length
              && new Set(authorityMetadataReferences).size === authorityMetadataReferences.length
              && authorityMetadataReferences.length === exactMetadataCommitments.length
              && authorityMetadataReferences.every((commitment) => exactMetadataSet.has(commitment));
            const terminalBindings = binderArtifact.bindings
              .filter((binding) => binding.status === "PASS" || binding.status === "FAIL");
            const exactAuthorityJoin = exactAuthoritySet.size === exactAuthorityCommitments.length
              && binderArtifact.bindings.filter((binding) => binding.authorityCommitment !== null)
                .every((binding) => exactAuthoritySet.has(binding.authorityCommitment))
              && terminalBindings.every((binding) => typeof binding.authorityCommitment === "string"
                && exactAuthoritySet.has(binding.authorityCommitment));
            const authorityRecordByCommitment = new Map(exactAuthorityRows
              .map((row) => [row.authorityCommitment, row.upstreamRecordCommitment]));
            const passBindings = new Set(binderArtifact.bindings.filter((binding) => binding.status === "PASS")
              .map((binding) => binding.bindingCommitment));
            const invariantJoin = invariantArtifact.plans.filter((plan) => plan.status === "PLANNED")
              .every((plan) => authorityRecordByCommitment.get(plan.authorityCommitment) === plan.recordCommitment
                && passBindings.has(plan.binderCommitment));
            if (artifact.schema === extractorContract.expectedSchema && extractorContract.validateArtifact(artifact)
                && safeSerialized(artifact) && generatedMs >= extractorStartedAt && generatedMs <= completedMs
                && mappingArtifact.schema === mappingContract.expectedSchema && mappingContract.validateArtifact(mappingArtifact)
                && safeSerialized(mappingArtifact) && mappingGeneratedMs >= extractorStartedAt && mappingGeneratedMs <= completedMs
                && metadataArtifact.schema === metadataContract.expectedSchema && metadataContract.validateArtifact(metadataArtifact)
                && safeSerialized(metadataArtifact) && metadataGeneratedMs >= extractorStartedAt && metadataGeneratedMs <= completedMs
                && authorityArtifact.schema === authorityContract.expectedSchema && authorityContract.validateArtifact(authorityArtifact)
                && safeSerialized(authorityArtifact) && authorityGeneratedMs >= extractorStartedAt && authorityGeneratedMs <= completedMs
                && binderArtifact.schema === binderContract.expectedSchema && binderContract.validateArtifact(binderArtifact)
                && safeSerialized(binderArtifact) && binderGeneratedMs >= extractorStartedAt && binderGeneratedMs <= completedMs
                && invariantArtifact.schema === invariantContract.expectedSchema && invariantContract.validateArtifact(invariantArtifact)
                && safeSerialized(invariantArtifact) && invariantGeneratedMs >= extractorStartedAt && invariantGeneratedMs <= completedMs
                && mappingArtifact.upstreamExtractorCommitment === upstreamExtractorCommitment
                && metadataArtifact.upstreamExtractorCommitment === upstreamExtractorCommitment
                && authorityArtifact.upstreamExtractorCommitment === upstreamExtractorCommitment
                && binderArtifact.upstreamBatchCommitment === upstreamExtractorCommitment
                && invariantArtifact.upstreamExtractorCommitment === upstreamExtractorCommitment
                && invariantArtifact.authorityBatchCommitment === authorityArtifact.authorityBatchCommitment
                && invariantArtifact.binderBatchCommitment === binderArtifact.bindingBatchCommitment
                && invariantArtifact.scorerBatchCommitment === artifact.scorerCommitment
                && mappingMetadataJoin && metadataAuthorityJoin && invariantJoin
                && binderArtifact.counts.pass + binderArtifact.counts.fail <= authorityArtifact.counts.exact
                && exactAuthorityJoin) status = "PASS";
          } catch (_) { /* invalid extractor artifacts keep discovery fail-closed */ }
        }
      }
    }
    if (status === "PASS") {
      const prefilterPath = path.join(workspace, PREFILTER_COMMAND);
      const prefilterContract = prefilterFactory();
      if (!exists(prefilterPath) || !prefilterContract || prefilterContract.artifactPath !== PREFILTER_ARTIFACT) {
        status = "FAILED";
        exitCode = null;
      } else {
        const prefilterStartedAt = now();
        const prefilterResult = await runner(prefilterPath, { id: "deployed-delta-manifest-prefilter", discovery: true, prefilter: true });
        exitCode = prefilterResult.exitCode;
        durationMs += Math.max(0, Math.round(prefilterResult.durationMs || 0));
        status = prefilterResult.timedOut ? "TIMEOUT" : prefilterResult.exitCode === 0 ? "ARTIFACT_INVALID" : "FAILED";
        if (!prefilterResult.timedOut && prefilterResult.exitCode === 0) {
          try {
            const artifact = readJsonStrict(path.join(workspace, PREFILTER_ARTIFACT), fsImpl);
            const generatedMs = Date.parse(artifact.generatedAt);
            const completedMs = now();
            if (artifact.schema === prefilterContract.expectedSchema && prefilterContract.validateArtifact(artifact)
                && safeSerialized(artifact) && generatedMs >= prefilterStartedAt && generatedMs <= completedMs) {
              status = "PASS";
              validatedPrefilter = artifact;
            }
          } catch (_) { /* invalid prefilter artifacts keep discovery fail-closed */ }
        }
      }
    }
    if (status === "PASS") {
      const gatePath = path.join(workspace, ECONOMICS_GATE_COMMAND);
      const gateContract = economicsGateFactory();
      if (!exists(gatePath) || !gateContract || gateContract.artifactPath !== ECONOMICS_GATE_ARTIFACT) {
        status = "FAILED";
        exitCode = null;
      } else {
        const gateStartedAt = now();
        const gateResult = await runner(gatePath, {
          id: "deployed-delta-sealed-local-evidence-economics-gate", discovery: true, economicsGate: true
        });
        exitCode = gateResult.exitCode;
        durationMs += Math.max(0, Math.round(gateResult.durationMs || 0));
        status = gateResult.timedOut ? "TIMEOUT" : gateResult.exitCode === 0 ? "ARTIFACT_INVALID" : "FAILED";
        if (!gateResult.timedOut && gateResult.exitCode === 0) {
          try {
            const completedMs = now();
            const sentinel = readJsonStrict(path.join(workspace, artifactPath), fsImpl);
            const sentinelCommitment = candidateFeedModule.sha256Canonical(sentinel);
            const feedId = validatedPrefilter && validatedPrefilter.feedId;
            const feed = readJsonStrict(path.join(workspace, CANDIDATE_FEED_DIRECTORY, `${feedId}.json`), fsImpl, 4 * 1024 * 1024);
            const attestation = readJsonStrict(path.join(workspace, ECONOMICS_GATE_ARTIFACT), fsImpl, 4 * 1024 * 1024);
            const generatedMs = Date.parse(attestation.generatedAt);
            const gateArtifactValid = attestation.schema === gateContract.expectedSchema
                && gateContract.validateArtifact(attestation, completedMs) && safeSerialized(attestation)
                && generatedMs >= gateStartedAt && generatedMs <= completedMs
                && canonicalSentinelCommitment !== null && sentinelCommitment === canonicalSentinelCommitment
                && contract.validateArtifact(sentinel)
                && validatedPrefilter.sentinelCommitment === canonicalSentinelCommitment
                && candidateFeedModule.validateFeed(feed) && safeSerialized(feed)
                && feed.feedId === feedId && feed.inputCommitments.sentinel === canonicalSentinelCommitment
                && Date.parse(feed.generatedAt) <= completedMs && Date.parse(feed.expiresAt) > completedMs;
            if (gateArtifactValid && attestation.feedId === feed.feedId) status = "PASS";
            else if (gateArtifactValid && attestation.feedId === gateContract.emptyFeedId
                && validatedPrefilter.status === "EMPTY" && feed.status === "empty"
                && feed.candidates.length === 0 && attestation.rows.length === 0) {
              status = "PASS";
              rankerEligible = false;
            }
          } catch (_) { /* invalid or unbound economics-gate artifacts keep ranker fail-closed */ }
        }
      }
    }
    if (status === "PASS" && rankerEligible) {
      const rankerPath = path.join(workspace, RANKER_COMMAND);
      const rankerContract = rankerFactory();
      if (!exists(rankerPath) || !rankerContract || rankerContract.artifactPath !== RANKER_ARTIFACT) {
        status = "FAILED";
        exitCode = null;
      } else {
        const rankerStartedAt = now();
        const rankerResult = await runner(rankerPath, { id: "deployed-delta-profit-ranker", discovery: true, ranker: true });
        exitCode = rankerResult.exitCode;
        durationMs += Math.max(0, Math.round(rankerResult.durationMs || 0));
        status = rankerResult.timedOut ? "TIMEOUT" : rankerResult.exitCode === 0 ? "ARTIFACT_INVALID" : "FAILED";
        if (!rankerResult.timedOut && rankerResult.exitCode === 0) {
          try {
            const artifact = readJsonStrict(path.join(workspace, RANKER_ARTIFACT), fsImpl, 4 * 1024 * 1024);
            const generatedMs = Date.parse(artifact.generatedAt);
            const completedMs = now();
            if (artifact.schema === rankerContract.expectedSchema && rankerContract.validateArtifact(artifact)
                && safeSerialized(artifact) && generatedMs >= rankerStartedAt && generatedMs <= completedMs) status = "PASS";
          } catch (_) { /* invalid ranker artifacts keep discovery fail-closed */ }
        }
      }
    }
    scheduleNextDiscovery(status, current);
    health.discovery = {
      status, lastAttemptAt: new Date(current).toISOString(),
      nextDueAt: new Date(discoveryNextDueMs).toISOString(),
      exitCode, durationMs, artifactPath
    };
  }

  function capabilityRotationAttempt() {
    const current = now();
    if (capabilityRotationLastAttemptMs === null && exists(path.join(workspace, CAPABILITY_ROTATION_COMMAND))) {
      try {
        const priorContract = capabilityRotationFactory();
        const prior = readJsonStrict(path.join(workspace, CAPABILITY_ROTATION_ARTIFACT), fsImpl);
        const priorMs = Date.parse(prior.generatedAt);
        if (priorContract && prior.schema === priorContract.expectedSchema && priorContract.validateArtifact(prior)
            && Number.isFinite(priorMs) && priorMs <= current
            && current < priorMs + CAPABILITY_ROTATION_CADENCE_SECONDS * 1000) {
          capabilityRotationLastAttemptMs = priorMs;
        }
      } catch (_) { /* absent or invalid prior artifacts do not suppress a due attempt */ }
    }
    if (capabilityRotationLastAttemptMs !== null
        && current < capabilityRotationLastAttemptMs + CAPABILITY_ROTATION_CADENCE_SECONDS * 1000) {
      health.capabilityRotation = {
        artifactPath: CAPABILITY_ROTATION_ARTIFACT,
        status: "NOT_DUE",
        lastAttemptAt: new Date(capabilityRotationLastAttemptMs).toISOString(),
        nextDueAt: new Date(capabilityRotationLastAttemptMs + CAPABILITY_ROTATION_CADENCE_SECONDS * 1000).toISOString(),
        durationMs: 0,
        exitCode: null
      };
      return Object.freeze({ due: false });
    }
    capabilityRotationLastAttemptMs = current;
    return Object.freeze({ due: true });
  }

  async function runCombinedEtherfi(contract) {
    const startedMs = now();
    capabilityRotationLastAttemptMs = startedMs;
    const attempted = new Date(startedMs).toISOString();
    const nextDueAt = new Date(startedMs + CAPABILITY_ROTATION_CADENCE_SECONDS * 1000).toISOString();
    const commandPath = path.join(workspace, CAPABILITY_ROTATION_COMMAND);
    if (!exists(commandPath)) {
      health.capabilityRotation = {
        artifactPath: CAPABILITY_ROTATION_ARTIFACT, status: "DEGRADED", lastAttemptAt: attempted,
        nextDueAt, durationMs: 0, exitCode: null
      };
      return null;
    }
    const rotationContract = capabilityRotationFactory();
    const result = await runner(commandPath, { id: "etherfi-optimism-provider-capability-rotation", capabilityRotation: true });
    let status = result.timedOut ? "TIMEOUT" : result.exitCode === 0 ? "DEGRADED" : "FAILED";
    let producerRow = null;
    if (!result.timedOut && result.exitCode === 0 && rotationContract
        && rotationContract.artifactPath === CAPABILITY_ROTATION_ARTIFACT) {
      try {
        const artifact = readJsonStrict(path.join(workspace, CAPABILITY_ROTATION_ARTIFACT), fsImpl);
        const generatedMs = Date.parse(artifact.generatedAt), completedMs = now();
        if (artifact.schema === rotationContract.expectedSchema && rotationContract.validateArtifact(artifact)
            && safeSerialized(artifact) && generatedMs >= startedMs && generatedMs <= completedMs) {
          status = artifact.status === "READY" ? "READY" : "INCOMPLETE";
          if (status === "READY") {
            producerRow = validatedProducerRow(contract, result, {
              workspace, fsImpl, minimumGeneratedAtMs: startedMs, maximumGeneratedAtMs: completedMs
            });
            if (producerRow.status !== "PASS") { producerRow = null; status = "DEGRADED"; }
          }
        }
      } catch (_) { /* missing or invalid artifacts remain degraded and non-promoting */ }
    }
    health.capabilityRotation = {
      artifactPath: CAPABILITY_ROTATION_ARTIFACT, status, lastAttemptAt: attempted, nextDueAt,
      durationMs: Math.max(0, Math.round(result.durationMs || 0)), exitCode: result.exitCode
    };
    return producerRow;
  }

  async function runAaveV4BinderRefresh() {
    const attemptedMs = now();
    const attemptedAt = new Date(attemptedMs).toISOString();
    const commandPath = path.join(workspace, AAVE_V4_BINDER_REFRESH_COMMAND);
    const contract = exists(commandPath) ? aaveV4BinderRefreshFactory() : null;
    if (!contract) {
      health.aaveV4BinderRefresh = {
        status: "NOT_INSTALLED", lastAttemptAt: attemptedAt, durationMs: 0, exitCode: null
      };
      return;
    }
    const result = await runner(commandPath, {
      id: contract.id || AAVE_V4_BINDER_REFRESH_ID,
      discovery: false,
      aaveV4BinderRefresh: true,
      args: Array.isArray(contract.args) ? contract.args : [...AAVE_V4_BINDER_REFRESH_ARGS]
    });
    health.aaveV4BinderRefresh = {
      status: result.timedOut ? "TIMEOUT" : result.exitCode === 0 ? "PASS" : "FAILED",
      lastAttemptAt: attemptedAt,
      durationMs: Math.max(0, Math.round(result.durationMs || 0)),
      exitCode: result.exitCode
    };
  }

  async function runCycle() {
    if (inCycle || inA12Daily || inMorphoDaily) fail("CYCLE_OVERLAP_REJECTED");
    inCycle = true;
    sequence += 1;
    const cycleStartedAt = new Date(now()).toISOString();
    const rotationAttempt = capabilityRotationAttempt();
    health.producers = initialProducerRows();
    try {
      const rows = [];
      for (const contract of contracts) {
        if (contract.id === "etherfi-debtmanager" && rotationAttempt.due) {
          const combined = await runCombinedEtherfi(contract);
          if (combined) { rows.push(combined); continue; }
        }
        const producerStartedAt = now();
        const result = await runner(path.join(workspace, contract.command), { id: contract.id, discovery: false, args: contract.args || [] });
        const validationOptions = { workspace, fsImpl };
        if (contract.id === "aave-v3-arbitrum-config-oracle-events") {
          validationOptions.minimumGeneratedAtMs = producerStartedAt;
          validationOptions.maximumGeneratedAtMs = now();
        }
        rows.push(validatedProducerRow(contract, result, validationOptions));
      }
      health.producers = rows;
      await runAaveV4BinderRefresh();
      await runDiscovery();
      health.cycle = {
        sequence,
        startedAt: cycleStartedAt,
        completedAt: new Date(now()).toISOString(),
        status: rows.every((row) => row.status === "PASS") ? "PASS" : "DEGRADED"
      };
      publishNow();
      return JSON.parse(JSON.stringify(health));
    } finally { inCycle = false; }
  }

  function setRunning(running) { health.running = running; publishNow(); }
  function publishInitial() { publishNow(); }
  return Object.freeze({ health, runCycle, runA12DailyDue, runMorphoDailyDue, runGmxDailyDue, runAaveV3DailyDue, runCompoundV3DailyDue, setRunning, publishInitial, get inCycle() { return inCycle; } });
}

function validateLock(value) {
  return exactKeys(value, ["pid", "startedAt", "nonce"])
    && Number.isSafeInteger(value.pid) && value.pid > 0 && iso(value.startedAt)
    && typeof value.nonce === "string" && /^[0-9a-f]{32}$/.test(value.nonce);
}
function readLock(lockPath = LOCK, fsImpl = fs) {
  try {
    if (!strictRegularFile(lockPath, fsImpl, 512)) fail("LOCK_MALFORMED");
    const raw = fsImpl.readFileSync(lockPath);
    const value = JSON.parse(raw.toString("utf8"));
    if (!validateLock(value)) fail("LOCK_MALFORMED");
    return { value, raw };
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    fail("LOCK_MALFORMED");
  }
}
function defaultPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === "EPERM"; }
}
function writeNewLock(lockPath, lockValue, fsImpl = fs) {
  const descriptor = fsImpl.openSync(lockPath, "wx", 0o600);
  try {
    fsImpl.writeFileSync(descriptor, Buffer.from(`${JSON.stringify(lockValue)}\n`));
    fsImpl.fsyncSync(descriptor);
  } finally { fsImpl.closeSync(descriptor); }
  fsyncDirectory(path.dirname(lockPath), fsImpl);
}
function acquireLock(options = {}) {
  const lockPath = path.resolve(options.lockPath || LOCK);
  const fsImpl = options.fsImpl || fs;
  const pidAlive = options.pidAlive || defaultPidAlive;
  const now = options.now || Date.now;
  const value = {
    pid: options.pid === undefined ? process.pid : options.pid,
    startedAt: new Date(now()).toISOString(),
    nonce: options.nonce || crypto.randomBytes(16).toString("hex")
  };
  if (!validateLock(value)) fail("LOCK_VALUE_INVALID");
  try { writeNewLock(lockPath, value, fsImpl); return value; }
  catch (error) { if (!error || error.code !== "EEXIST") throw error; }

  const existing = readLock(lockPath, fsImpl);
  if (pidAlive(existing.value.pid)) fail("ALREADY_RUNNING");
  const stalePath = `${lockPath}.stale-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  try {
    fsImpl.renameSync(lockPath, stalePath);
    const claimed = fsImpl.readFileSync(stalePath);
    if (!claimed.equals(existing.raw)) {
      if (!fsImpl.existsSync(lockPath)) fsImpl.renameSync(stalePath, lockPath);
      fail("LOCK_CHANGED");
    }
    try { writeNewLock(lockPath, value, fsImpl); }
    catch (error) { if (error && error.code === "EEXIST") fail("ALREADY_RUNNING"); throw error; }
    return value;
  } finally {
    if (fsImpl.existsSync(stalePath)) try { fsImpl.unlinkSync(stalePath); } catch (_) {}
  }
}
function releaseOwnLock(lockValue, options = {}) {
  const lockPath = path.resolve(options.lockPath || LOCK);
  const fsImpl = options.fsImpl || fs;
  try {
    const current = readLock(lockPath, fsImpl).value;
    if (current.pid !== lockValue.pid || current.nonce !== lockValue.nonce || current.startedAt !== lockValue.startedAt) return false;
    fsImpl.unlinkSync(lockPath);
    fsyncDirectory(path.dirname(lockPath), fsImpl);
    return true;
  } catch (_) { return false; }
}

function parseCli(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || !["--once", "--daemon"].includes(argv[0])) fail("ARGUMENTS_REJECTED");
  return argv[0].slice(2);
}
function cancellableSleep(milliseconds, signal) {
  return new Promise((resolve) => {
    if (milliseconds <= 0 || signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function runService(mode, options = {}) {
  if (!["once", "daemon"].includes(mode)) fail("MODE_REJECTED");
  const now = options.now || Date.now;
  const lockValue = acquireLock({ ...options, now });
  const controller = new AbortController();
  let stopping = false;
  const requestStop = () => { stopping = true; controller.abort(); };
  const installSignals = options.installSignals !== false && mode === "daemon";
  if (installSignals) { process.once("SIGINT", requestStop); process.once("SIGTERM", requestStop); }
  const scheduler = createScheduler({ ...options, now, pid: lockValue.pid, startedAt: lockValue.startedAt, running: true });
  const sleep = options.sleep || cancellableSleep;
  const maximumCycles = options.maxCycles === undefined ? Infinity : options.maxCycles;
  const firstStart = now();
  let completed = 0;
  try {
    scheduler.publishInitial();
    while (!stopping && completed < maximumCycles) {
      // Independent daily due gate on minute wakes, not a 900 s producer registration.
      await scheduler.runA12DailyDue();
      await scheduler.runMorphoDailyDue();
      await scheduler.runGmxDailyDue();
      await scheduler.runAaveV3DailyDue();
      await scheduler.runCompoundV3DailyDue();
      if (now() >= firstStart + completed * CADENCE_SECONDS * 1000) {
        await scheduler.runCycle();
        completed += 1;
      }
      if (mode === "once" || stopping || completed >= maximumCycles) break;
      const nextStart = firstStart + completed * CADENCE_SECONDS * 1000;
      await sleep(Math.max(0, Math.min(DAILY_CHECK_SECONDS * 1000, nextStart - now())), controller.signal);
    }
    scheduler.setRunning(false);
    return scheduler.health;
  } finally {
    if (installSignals) { process.removeListener("SIGINT", requestStop); process.removeListener("SIGTERM", requestStop); }
    releaseOwnLock(lockValue, options);
  }
}

async function main(argv = process.argv.slice(2), options = {}) {
  const mode = parseCli(argv);
  return runService(mode, options);
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });

module.exports = Object.freeze({
  CLAIM, SCHEMA, CADENCE_SECONDS, DISCOVERY_CADENCE_SECONDS, CAPABILITY_ROTATION_CADENCE_SECONDS,
  DISCOVERY_RETRY_SECONDS, DISCOVERY_MAX_SHORT_RETRIES,
  CHILD_TIMEOUT_MS, CAPABILITY_ROTATION_CHILD_TIMEOUT_MS, WORKSPACE, OUTPUT, LOCK, PRODUCER_SPECS,
  DAILY_CHECK_SECONDS, A12_DAILY_SPEC, A12_MAX_AGE_MS, A12_DISPATCH_WINDOW_MS, validateA12Daily, utcDailyDueMs,
  MORPHO_DAILY_SPEC, MORPHO_MAX_AGE_MS, MORPHO_DISPATCH_WINDOW_MS, validateMorphoDaily,
  GMX_DAILY_SPEC, GMX_MAX_AGE_MS, GMX_DISPATCH_WINDOW_MS, validateGmxDaily,
  AAVE_V3_DAILY_SPEC, AAVE_V3_MAX_AGE_MS, AAVE_V3_DISPATCH_WINDOW_MS, validateAaveV3Daily,
  COMPOUND_V3_DAILY_SPEC, COMPOUND_V3_MAX_AGE_MS, COMPOUND_V3_DISPATCH_WINDOW_MS, validateCompoundV3Daily,
  DISCOVERY_COMMAND, DISCOVERY_ARTIFACT, SCORER_COMMAND, SCORER_ARTIFACT,
  DELTA_BINDER_REFRESH_COMMAND, DELTA_BINDER_REFRESH_ID, DELTA_BINDER_REFRESH_ARGS,
  AAVE_V4_BINDER_REFRESH_COMMAND, AAVE_V4_BINDER_REFRESH_ID, AAVE_V4_BINDER_REFRESH_ARGS,
  AAVE_V4_BINDER_REFRESH_KEYS, AAVE_V4_BINDER_REFRESH_STATUSES,
  EXTRACTOR_COMMAND, EXTRACTOR_ARTIFACT, MAPPING_ARTIFACT, METADATA_ARTIFACT, AUTHORITY_ARTIFACT,
  BINDER_ARTIFACT, INVARIANT_ARTIFACT, RANKER_COMMAND, RANKER_ARTIFACT,
  PREFILTER_COMMAND, PREFILTER_ARTIFACT, ECONOMICS_GATE_COMMAND, ECONOMICS_GATE_ARTIFACT,
  CANDIDATE_FEED_DIRECTORY,
  CAPABILITY_ROTATION_COMMAND, CAPABILITY_ROTATION_ARTIFACT, SchedulerError, validateHealth, validateLock,
  baseHealth, safetyFields, producerContracts, publishAtomic, createChildRunner, validatedProducerRow,
  defaultDiscoveryContract, defaultScorerContract, defaultExtractorContract, defaultMappingContract,
  defaultDeltaBinderRefreshContract, defaultAaveV4BinderRefreshContract,
  defaultMetadataContract, defaultAuthorityContract, defaultBinderContract, defaultInvariantContract, defaultPrefilterContract,
  defaultEconomicsGateContract, defaultRankerContract, defaultCapabilityRotationContract, createScheduler, readLock, acquireLock,
  releaseOwnLock, parseCli, runService, main
});
