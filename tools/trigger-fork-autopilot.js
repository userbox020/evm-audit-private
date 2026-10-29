#!/usr/bin/env node
"use strict";

// Automatically runs the existing trigger-to-fork bridge for fresh fired
// events. SOURCE_MAX_AGE_MS is the explicit source freshness policy: 10 minutes.
// The bridge remains the authority for scenario mapping and keyless local-fork
// execution; this file adds scheduling safety, event dedupe, and durable status.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const epochExecution = require("./lib/trigger-fork-epoch-execution.js");

const bridge = require("./run-trigger-fork-poc");
const forkPoc = require("./run-fork-poc");

const ROOT = path.resolve(__dirname, "..");
const MONITOR_DIR = path.join(ROOT, "reports", "monitor");
const SOURCE_FILE = path.join(MONITOR_DIR, "profit-trigger-watch.json");
const STATE_FILE = path.join(MONITOR_DIR, "trigger-fork-autopilot-state.json");
const STATUS_FILE = path.join(MONITOR_DIR, "trigger-fork-autopilot-status.json");
const LOCK_FILE = path.join(MONITOR_DIR, "trigger-fork-autopilot.lock");

const SOURCE_SCHEMA = "profit-trigger-watch/v1";
const STATE_SCHEMA = "trigger-fork-autopilot-state/v2";
const LEGACY_STATE_SCHEMA = "trigger-fork-autopilot-state/v1";
const STATUS_SCHEMA = "trigger-fork-autopilot-status/v1";
const SOURCE_MAX_AGE_MS = 10 * 60_000;
const LOCK_LEASE_MS = 5 * 60_000;
const MAX_WALL_MS = 210_000;
const EVENT_COOLDOWN_MS = 15 * 60_000;
const FAILURE_BACKOFF_MS = 30 * 60_000;
const MAX_EXECUTIONS_PER_PASS = 1;
const MAX_EVENTS = 128;
const MAX_HISTORY = 128;
const FUTURE_TOLERANCE_MS = 60_000;
const SUPPORTED_EVENTS = new Map([
  ["kelp-composite", "TRIGGER_UNPAUSE"],
  ["ostium-settlement-window", "WINDOW_OPEN"],
  ["clever-harvest", "STRATEGY_SET_CHANGED"],
  ["frax-usdc-cross-venue", "ATOMIC_FORK_REQUIRED"],
  ["base-usdc-usdt-cross-venue", "ATOMIC_FORK_REQUIRED"],
  ["balancer-v2-eth-cross-venue", "ATOMIC_FORK_REQUIRED"],
  ["balancer-v2-base-cross-venue", "ATOMIC_FORK_REQUIRED"],
  ["balancer-v2-eth-join-exit", "ATOMIC_FORK_REQUIRED"],
  ["curve-eth-join-exit", "ATOMIC_FORK_REQUIRED"],
  ["morpho-blue-eth-l", "ATOMIC_FORK_REQUIRED"],
  ["morpho-blue-base-l", "ATOMIC_FORK_REQUIRED"],
  ["aave-v3-eth-reserve-watch", "ATOMIC_FORK_REQUIRED"],
  ["aave-v3-base-reserve-watch", "ATOMIC_FORK_REQUIRED"],
  ["aave-v3-eth-l", "ATOMIC_FORK_REQUIRED"],
  ["aave-v3-base-l", "ATOMIC_FORK_REQUIRED"],
  ["curve-base-join-exit", "ATOMIC_FORK_REQUIRED"],
]);
// Producers whose ATOMIC_FORK_REQUIRED carry an exact cross-venue candidate
// (eventId + routeKey) and use route-level cooldown/promotion evidence.
const CROSS_VENUE_PRODUCERS = new Set(["frax-usdc-cross-venue", "base-usdc-usdt-cross-venue", "balancer-v2-eth-cross-venue", "balancer-v2-base-cross-venue", "balancer-v2-eth-join-exit", "curve-eth-join-exit", "curve-base-join-exit", "morpho-blue-eth-l", "morpho-blue-base-l", "aave-v3-eth-reserve-watch", "aave-v3-base-reserve-watch", "aave-v3-eth-l", "aave-v3-base-l"]);
const PRODUCER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/u;
const SAFE_PATH = /^[A-Za-z0-9_./-]{1,512}$/u;
const FORBIDDEN_KEY = /^(?:url|urls|endpoint|endpoints|provider|providers|headers?|origin|credentials?|privateKey|secret|mnemonic|keystore)$/iu;
const URL = /(?:https?|wss?):\/\//iu;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isoMs(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeCode(value, fallback = "UNKNOWN") {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : fallback;
}

function containsEndpointMaterial(value, key = "", depth = 0) {
  if (depth > 12 || FORBIDDEN_KEY.test(key)) return true;
  if (typeof value === "string") return URL.test(value);
  if (Array.isArray(value)) return value.some((child) => containsEndpointMaterial(child, key, depth + 1));
  if (isObject(value)) return Object.entries(value).some(([name, child]) => containsEndpointMaterial(child, name, depth + 1));
  return false;
}

function validateSource(value) {
  if (!isObject(value) || value.schema !== SOURCE_SCHEMA || isoMs(value.generatedAt) === null || !Array.isArray(value.producers) || value.producers.length > 256) return false;
  const ids = new Set();
  for (const row of value.producers) {
    if (!isObject(row) || !PRODUCER_ID.test(row.id || "") || ids.has(row.id)
        || typeof row.status !== "string" || row.status.length > 64
        || isoMs(row.generatedAt) === null || !isObject(row.evidence)) return false;
    ids.add(row.id);
  }
  return true;
}

function sourceFresh(source, nowMs, maximumAgeMs = SOURCE_MAX_AGE_MS) {
  const stamp = isoMs(source?.generatedAt);
  return stamp !== null && stamp <= nowMs + FUTURE_TOLERANCE_MS && nowMs - stamp <= maximumAgeMs;
}

function evidenceIdentity(producer) {
  if (CROSS_VENUE_PRODUCERS.has(producer.id) && /^[0-9a-f]{64}$/u.test(producer.evidence?.candidate?.eventId || "")) {
    return `${producer.id}:${producer.status}:${producer.evidence.candidate.eventId}`;
  }
  const evidence = producer.evidence;
  const parts = [];
  for (const key of ["blockNumberRaw", "blockNumber", "block"]) {
    const value = evidence[key];
    if ((typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) || (Number.isSafeInteger(value) && value >= 0)) {
      parts.push(`block=${String(value)}`);
      break;
    }
  }
  for (const key of ["blockTimestampRaw", "blockTimestamp", "timestamp"]) {
    const value = evidence[key];
    if ((typeof value === "string" && (/^(?:0|[1-9][0-9]*)$/u.test(value) || isoMs(value) !== null)) || (Number.isSafeInteger(value) && value >= 0)) {
      parts.push(`timestamp=${String(value)}`);
      break;
    }
  }
  for (const key of ["commitment", "commitmentHash", "blockHash"]) {
    const value = evidence[key];
    if (typeof value === "string" && /^(?:0x[0-9a-f]{64}|[A-Za-z0-9_-]{8,128})$/iu.test(value)) {
      parts.push(`commitment=${value.toLowerCase()}`);
      break;
    }
  }
  if (!parts.some((part) => part.startsWith("timestamp="))) parts.push(`timestamp=${producer.generatedAt}`);
  const digest = crypto.createHash("sha256").update(`${producer.id}|${producer.status}|${parts.join("|")}`).digest("hex").slice(0, 32);
  return `${producer.id}:${producer.status}:${digest}`;
}

function emptyState() {
  return { schema: STATE_SCHEMA, updatedAt: null, events: {}, routeCooldowns: {}, history: [] };
}

function validPersistedState(value) {
  if (!isObject(value) || value.schema !== STATE_SCHEMA || !isObject(value.events)
      || !isObject(value.eventJournal) || value.eventJournal.completeness !== "EXPLICIT_ATTESTATION"
      || value.eventJournal.provenance !== "EXTERNAL_RECONCILIATION"
      || isoMs(value.eventJournal.attestedAt) === null
      || !Array.isArray(value.history) || (value.routeCooldowns !== undefined && !isObject(value.routeCooldowns))) return false;
  if (Object.keys(value.events).length > MAX_EVENTS || Object.keys(value.routeCooldowns || {}).length > MAX_EVENTS) return false;
  for (const [eventId, row] of Object.entries(value.events)) {
    if (!/^[a-z0-9:_-]{1,180}$/iu.test(eventId) || !isObject(row)
        || !PRODUCER_ID.test(row.producerId || "") || typeof row.terminal !== "boolean"
        || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || row.attempts > 1) return false;
  }
  for (const [key, row] of Object.entries(value.routeCooldowns || {})) {
    if (!/^[0-9a-f]{64}$/u.test(key) || !isObject(row)
        || isoMs(row.nextEligibleAt) === null) return false;
  }
  return true;
}

function normalizeState(value) {
  const state = emptyState();
  if (!isObject(value) || value.schema !== STATE_SCHEMA || !isObject(value.events) || !Array.isArray(value.history)) return state;
  if (Object.keys(value.events).length > MAX_EVENTS) throw new Error("EVENT_JOURNAL_OVERSIZED");
  state.eventJournal = {
    completeness: value.eventJournal.completeness,
    provenance: value.eventJournal.provenance,
    attestedAt: value.eventJournal.attestedAt,
  };
  for (const [eventId, row] of Object.entries(value.events)) {
    if (!/^[a-z0-9:_-]{1,180}$/iu.test(eventId) || !isObject(row) || !PRODUCER_ID.test(row.producerId || "")) continue;
    state.events[eventId] = {
      producerId: row.producerId,
      firedStatus: safeCode(row.firedStatus),
      phase: safeCode(row.phase),
      terminal: row.terminal === true,
      attempts: Number.isSafeInteger(row.attempts) && row.attempts >= 0 ? Math.min(row.attempts, 1) : 0,
      firstSeenAt: isoMs(row.firstSeenAt) === null ? null : row.firstSeenAt,
      lastAttemptAt: isoMs(row.lastAttemptAt) === null ? null : row.lastAttemptAt,
      nextEligibleAt: isoMs(row.nextEligibleAt) === null ? null : row.nextEligibleAt,
      success: row.success === true,
      result: safeCode(row.result, "UNKNOWN"),
      blocker: row.blocker === null ? null : safeCode(row.blocker, "REDACTED_FAILURE"),
      forkArtifact: typeof row.forkArtifact === "string" && SAFE_PATH.test(row.forkArtifact) && !URL.test(row.forkArtifact) ? row.forkArtifact : null,
      net: Object.hasOwn(row, "net") ? row.net : null,
      promoted: row.promoted === true,
    };
  }
  state.history = value.history.slice(-MAX_HISTORY).filter(isObject).map((row) => ({
    eventId: /^[a-z0-9:_-]{1,180}$/iu.test(row.eventId || "") ? row.eventId : "invalid",
    producerId: PRODUCER_ID.test(row.producerId || "") ? row.producerId : "invalid",
    firedStatus: safeCode(row.firedStatus),
    attemptedAt: isoMs(row.attemptedAt) === null ? null : row.attemptedAt,
    success: row.success === true,
    result: safeCode(row.result, "UNKNOWN"),
    blocker: row.blocker === null ? null : safeCode(row.blocker, "REDACTED_FAILURE"),
    forkArtifact: typeof row.forkArtifact === "string" && SAFE_PATH.test(row.forkArtifact) && !URL.test(row.forkArtifact) ? row.forkArtifact : null,
    net: Object.hasOwn(row, "net") ? row.net : null,
    promoted: row.promoted === true,
  }));
  if (isObject(value.routeCooldowns)) {
    for (const [key, row] of Object.entries(value.routeCooldowns).slice(-MAX_EVENTS)) {
      if (/^[0-9a-f]{64}$/u.test(key) && isObject(row)) state.routeCooldowns[key] = {
        lastEventId: /^[0-9a-f]{64}$/u.test(row.lastEventId || "") ? row.lastEventId : null,
        outcome: safeCode(row.outcome, "UNKNOWN"),
        nextEligibleAt: isoMs(row.nextEligibleAt) === null ? null : row.nextEligibleAt,
      };
    }
  }
  state.updatedAt = isoMs(value.updatedAt) === null ? null : value.updatedAt;
  forkPoc.leakGuard(state);
  return state;
}

function trimState(state) {
  if (Object.keys(state.events).length > MAX_EVENTS) throw new Error("EVENT_JOURNAL_OVERSIZED");
  state.history = state.history.slice(-MAX_HISTORY);
  state.routeCooldowns = Object.fromEntries(Object.entries(state.routeCooldowns).slice(-MAX_EVENTS));
  return state;
}

function parseSource(raw) {
  try {
    const source = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    if (!validateSource(source)) return { source: null, blocker: "SOURCE_SCHEMA_INVALID" };
    if (containsEndpointMaterial(source)) return { source: null, blocker: "SOURCE_ENDPOINT_MATERIAL_REJECTED" };
    return { source, blocker: null };
  } catch (_) {
    return { source: null, blocker: "SOURCE_PARSE_FAILED" };
  }
}

function inspectSource(source, state, nowMs, deps, options = {}) {
  const rows = source.producers.map((producer) => ({
    producerId: producer.id,
    firedStatus: producer.status,
    classification: bridge.classifyStatus(producer.status),
    eventId: null,
    action: "NONE",
    reason: null,
  }));
  const ageMs = Math.max(0, nowMs - isoMs(source.generatedAt));
  if (!sourceFresh(source, nowMs, options.sourceMaxAgeMs || SOURCE_MAX_AGE_MS)) {
    rows.forEach((row) => { row.action = "BLOCKED"; row.reason = "STALE_SOURCE"; });
    return { classification: "FAIL_CLOSED", blocker: "STALE_SOURCE", ageMs, rows, selected: null };
  }
  if (rows.some((row) => row.classification === "UNKNOWN")) {
    rows.forEach((row) => { row.action = "BLOCKED"; row.reason = "UNKNOWN_STATUS"; });
    return { classification: "FAIL_CLOSED", blocker: "UNKNOWN_STATUS", ageMs, rows, selected: null };
  }

  let bridgePlan;
  try {
    bridgePlan = deps.planBridge(source);
  } catch (_) {
    return { classification: "FAIL_CLOSED", blocker: "BRIDGE_PLAN_FAILED", ageMs, rows, selected: null };
  }
  const mapped = new Map(bridgePlan.rows.map((row) => [row.producerId, row]));
  const firedRows = rows.filter((row) => row.classification === "FIRED");
  const unmapped = firedRows.some((row) => SUPPORTED_EVENTS.get(row.producerId) !== row.firedStatus || mapped.get(row.producerId)?.status !== "WOULD_FORK");
  if (unmapped) {
    rows.forEach((row) => { row.action = "BLOCKED"; row.reason = "UNMAPPED_FIRED_EVENT"; });
    return { classification: "FAIL_CLOSED", blocker: "UNMAPPED_FIRED_EVENT", ageMs, rows, selected: null };
  }

  const eligible = [];
  let saturated = false;
  for (const row of rows) {
    if (row.classification !== "FIRED") {
      row.action = "IGNORE_NOT_FIRED";
      continue;
    }
    const producer = source.producers.find((entry) => entry.id === row.producerId);
    row.eventId = evidenceIdentity(producer);
    const prior = state.events[row.eventId];
    const routeKey = producer.evidence?.candidate?.routeKey;
    const routeCooldown = /^[0-9a-f]{64}$/u.test(routeKey || "") ? state.routeCooldowns[routeKey] : null;
    const routeNext = isoMs(routeCooldown?.nextEligibleAt);
    if (prior?.terminal) {
      row.action = "DEDUPED";
      row.reason = "EVENT_ALREADY_ATTEMPTED";
    } else if (prior) {
      const next = isoMs(prior.nextEligibleAt);
      row.action = next !== null && nowMs < next ? "BACKOFF" : "DEDUPED";
      row.reason = next !== null && nowMs < next ? "EVENT_BACKOFF_ACTIVE" : "EVENT_PRIOR_ATTEMPT_UNCERTAIN";
    } else if (Object.keys(state.events).length >= MAX_EVENTS) {
      row.action = "BLOCKED";
      row.reason = "EVENT_JOURNAL_SATURATED";
      saturated = true;
    } else if (routeNext !== null && nowMs < routeNext) {
      row.action = "BACKOFF";
      row.reason = "ROUTE_COOLDOWN_ACTIVE";
    } else {
      row.action = "ELIGIBLE";
      eligible.push(row);
    }
  }
  if (saturated) {
    eligible.forEach((row) => { row.action = "BLOCKED"; row.reason = "EVENT_JOURNAL_SATURATED"; });
    return { classification: "FAIL_CLOSED", blocker: "EVENT_JOURNAL_SATURATED", ageMs, rows, selected: null };
  }
  const selected = eligible[0] || null;
  if (selected) selected.action = "EXECUTE";
  eligible.slice(MAX_EXECUTIONS_PER_PASS).forEach((row) => { row.action = "DEFERRED_CAP"; row.reason = "PASS_EXECUTION_CAP"; });
  return {
    classification: selected ? "READY" : firedRows.length ? "NO_NEW_EVENT" : "NO_FIRED_EVENT",
    blocker: null,
    ageMs,
    rows,
    selected,
  };
}

function buildStatus(mode, nowIso, sourceInfo, inspection, state, execution = null) {
  const rows = inspection?.rows || [];
  const status = {
    schema: STATUS_SCHEMA,
    generatedAt: nowIso,
    mode,
    classification: inspection?.classification || "FAIL_CLOSED",
    blocker: inspection?.blocker || sourceInfo.blocker || null,
    source: {
      path: "reports/monitor/profit-trigger-watch.json",
      schema: sourceInfo.source?.schema || null,
      generatedAt: sourceInfo.source?.generatedAt || null,
      freshnessMaximumMs: SOURCE_MAX_AGE_MS,
      ageMs: inspection?.ageMs ?? null,
      fresh: inspection ? inspection.blocker !== "STALE_SOURCE" : false,
    },
    plan: rows.map((row) => ({
      producerId: row.producerId,
      firedStatus: row.firedStatus,
      classification: row.classification,
      eventId: row.eventId,
      action: row.action,
      reason: row.reason,
    })),
    summary: {
      producers: rows.length,
      fired: rows.filter((row) => row.classification === "FIRED").length,
      eligible: rows.filter((row) => row.action === "EXECUTE" || row.action === "DEFERRED_CAP").length,
      planned: rows.filter((row) => row.action === "EXECUTE").length,
      executed: execution ? 1 : 0,
      succeeded: execution?.success === true ? 1 : 0,
      failed: execution && execution.success !== true ? 1 : 0,
      deduped: rows.filter((row) => row.action === "DEDUPED" || row.action === "BACKOFF").length,
      history: state.history.length,
    },
    execution,
    safety: {
      localOnly: true,
      keyless: true,
      sequential: true,
      noSigning: true,
      noBroadcast: true,
      maxForksPerPass: MAX_EXECUTIONS_PER_PASS,
      maxWallMs: MAX_WALL_MS,
      lockLeaseMs: LOCK_LEASE_MS,
      endpointMaterialPersisted: false,
    },
  };
  forkPoc.leakGuard(status);
  return status;
}

function executionFromBridge(outcome, selected, attemptedAt) {
  const trigger = outcome?.output?.triggers?.find((row) => row.producerId === selected.producerId) || null;
  const executed = outcome?.status === "BRIDGE_COMPLETE" && outcome.output?.executedCount === 1 && trigger?.status === "EXECUTED";
  const result = executed ? safeCode(trigger.result, "INCOMPLETE") : "FAIL_CLOSED";
  const forkPromoted = CROSS_VENUE_PRODUCERS.has(selected.producerId)
    ? executed && result === "PASS" && trigger?.net?.routePositive === true && trigger?.net?.exactPin === true
    : false;
  const success = executed && result === "PASS";
  const blocker = success ? null : safeCode(trigger?.blocker || outcome?.blocker, executed ? "FORK_FAILED" : "BRIDGE_INCOMPLETE");
  const forkArtifact = typeof trigger?.forkArtifact === "string" && SAFE_PATH.test(trigger.forkArtifact) && !URL.test(trigger.forkArtifact) ? trigger.forkArtifact : null;
  const net = trigger && Object.hasOwn(trigger, "net") ? trigger.net : null;
  const execution = {
    eventId: selected.eventId,
    producerId: selected.producerId,
    firedStatus: selected.firedStatus,
    attemptedAt,
    success,
    result,
    blocker,
    forkArtifact,
    net,
    promoted: forkPromoted,
  };
  forkPoc.leakGuard(execution);
  return execution;
}

function writeAtomic(file, value, fsImpl = fs) {
  forkPoc.leakGuard(value);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  try {
    fsImpl.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fsImpl.renameSync(temporary, file);
  } finally {
    try { fsImpl.rmSync(temporary, { force: true }); } catch (_) {}
  }
}

function acquireFileLock(file, nowMs, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const owner = `${process.pid}-${crypto.randomBytes(12).toString("hex")}`;
  const expiresAt = nowMs + LOCK_LEASE_MS;
  const create = () => {
    const handle = fsImpl.openSync(file, "wx", 0o600);
    try { fsImpl.writeFileSync(handle, `${JSON.stringify({ owner, acquiredAt: new Date(nowMs).toISOString(), expiresAt: new Date(expiresAt).toISOString() })}\n`); }
    finally { fsImpl.closeSync(handle); }
  };
  try {
    create();
  } catch (_) {
    // Existing, corrupt, or expired locks require attended recovery. Never steal
    // a lock while its owner may still be awaiting a fork or writing artifacts.
    return { acquired: false, release: () => {} };
  }
  return {
    acquired: true,
    release: () => {
      try {
        const current = JSON.parse(fsImpl.readFileSync(file, "utf8"));
        if (current.owner === owner) fsImpl.rmSync(file, { force: true });
      } catch (_) { /* best effort; lease expires fail-closed */ }
    },
  };
}

function defaultDeps() {
  return {
    now: () => Date.now(),
    readSource: () => fs.readFileSync(SOURCE_FILE, "utf8"),
    readState: () => {
      try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
    planBridge: (source) => bridge.buildPlan(source, {}, {
      triggersDir: bridge.TRIGGERS_DIR,
      scenarioExists: (file) => fs.existsSync(file),
      loadScenario: (file) => require(file),
    }),
    runBridge: (source) => bridge.runBridge({ run: true, totalMs: MAX_WALL_MS }, {
      readArtifact: () => JSON.stringify(source),
      now: () => Date.now(),
    }),
    acquireLock: (nowMs) => acquireFileLock(LOCK_FILE, nowMs),
    writeArtifacts: ({ state, status }) => {
      if (state) writeAtomic(STATE_FILE, state);
      if (status) writeAtomic(STATUS_FILE, status);
    },
    write: (text) => process.stdout.write(text),
  };
}

async function runAutopilot(options = {}, depsInput = {}) {
  const refuse = (blocker, mode) => {
    const state = emptyState();
    const status = buildStatus(mode, "1970-01-01T00:00:00.000Z", { source: null, blocker }, null, state);
    return { state, status: { ...status, platformBlocker: "PLATFORM_RUNTIME_UNIMPLEMENTED" }, executed: 0 };
  };
  let snapshot;
  try {
    if (!options || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new Error();
    const copy = Object.create(null);
    for (const key of Reflect.ownKeys(options)) {
      const d = Object.getOwnPropertyDescriptor(options, key);
      if (!["apply", "sourceMaxAgeMs", "maxWallMs"].includes(key) || !d.enumerable || !("value" in d)) throw new Error();
      if (key === "apply" ? typeof d.value !== "boolean" : !Number.isSafeInteger(d.value) || d.value <= 0) throw new Error();
      copy[key] = d.value;
    }
    snapshot = Object.freeze(copy);
  } catch (_) { return refuse("AUTOPILOT_OPTIONS_INVALID", "CHECK"); }
  // Old APPLY cannot activate or join an epoch. Dominates dependency creation,
  // clocks, lock acquisition, legacy state/source reads and artifact mutation.
  if (snapshot.apply === true) return refuse("EPOCH_OWNER_REQUIRED", "APPLY");
  const deps = { ...defaultDeps(), ...depsInput };
  const mode = "CHECK";
  const startedMs = Number(deps.now());
  const nowIso = new Date(startedMs).toISOString();
    let persisted;
    try { persisted = deps.readState(); }
    catch (_) {
      const state = emptyState();
      return { state, status: buildStatus(mode, nowIso, { source: null, blocker: "STATE_READ_FAILED" }, null, state), executed: 0 };
    }
    if (persisted?.schema === LEGACY_STATE_SCHEMA) {
      // v1 trimmed event identities: even a currently empty journal cannot
      // attest that an earlier fired identity was never reserved or executed.
      const state = emptyState();
      return { state, status: buildStatus(mode, nowIso, { source: null, blocker: "LEGACY_EVENT_JOURNAL_INCOMPLETE" }, null, state), executed: 0 };
    }
    if (persisted !== null && !validPersistedState(persisted)) {
      const state = emptyState();
      return { state, status: buildStatus(mode, nowIso, { source: null, blocker: "STATE_INVALID" }, null, state), executed: 0 };
    }
    const state = normalizeState(persisted);
    let raw;
    try { raw = deps.readSource(); } catch (_) {
      const sourceInfo = { source: null, blocker: "SOURCE_READ_FAILED" };
      const status = buildStatus(mode, nowIso, sourceInfo, null, state);
      return { state, status, executed: 0 };
    }
    const sourceInfo = parseSource(raw);
    if (!sourceInfo.source) {
      const status = buildStatus(mode, nowIso, sourceInfo, null, state);
      return { state, status, executed: 0 };
    }

    const inspection = inspectSource(sourceInfo.source, state, startedMs, deps, snapshot);
    if (inspection.blocker === "EVENT_JOURNAL_SATURATED") {
      // Do not rewrite the journal or its status on capacity rejection.
      return { state, status: buildStatus(mode, nowIso, sourceInfo, inspection, state), executed: 0 };
    }
    // CHECK can inspect a missing journal, but must not plan a fork from it.
    if (persisted === null && inspection.classification !== "NO_FIRED_EVENT") {
      const rows = inspection.rows.map((row) => row.action === "EXECUTE" || row.action === "DEFERRED_CAP"
        ? { ...row, action: "BLOCKED", reason: "STATE_ABSENT_UNSAFE_INIT" } : row);
      const status = buildStatus(mode, nowIso, sourceInfo,
        { ...inspection, rows, classification: "FAIL_CLOSED", blocker: "STATE_ABSENT_UNSAFE_INIT", selected: null }, state);
      return { state, status, executed: 0 };
    }
    // Beyond the refusal boundary this function is CHECK-only.
    trimState(state);
    const status = buildStatus(mode, nowIso, sourceInfo, inspection, state);
    return { state, status, executed: 0 };
}

// Held, explicitly synchronous integration model; no async bridge or legacy
// producer row can be converted into an epoch event or execution capability.
function runEpochAutopilotModel(request, deps = {}) {
  const env = epochExecution.envelope(request);
  if (!env.ok) return { status: "FAIL_CLOSED", blocker: env.blocker, ...epochExecution.metadata(env) };
  const answer = bridge.runEpochBridgeModel(request, deps);
  if (!epochExecution.validResult(answer, env)) return epochExecution.result(env, "MODEL_UNCERTAIN", "MODEL_CHILD_RESULT_INVALID", false);
  return epochExecution.result(env, answer.status, answer.blocker, answer.teardownVerified);
}

function parseArgs(args) {
  if (!Array.isArray(args) || args.length > 1 || (args.length === 1 && !["--check", "--apply"].includes(args[0]))) throw new Error("USAGE_ERROR");
  return { apply: args[0] === "--apply" };
}

async function runCli(argv = process.argv, depsInput = {}) {
  const deps = { ...defaultDeps(), ...depsInput };
  try {
    const options = parseArgs(argv.slice(2));
    const result = await runAutopilot(options, deps);
    const summary = result.status.summary;
    deps.write(`${JSON.stringify({
      mode: result.status.mode,
      classification: result.status.classification,
      blocker: result.status.blocker,
      fresh: result.status.source.fresh,
      fired: summary.fired,
      planned: summary.planned,
      executed: summary.executed,
      succeeded: summary.succeeded,
      failed: summary.failed,
      plan: result.status.plan.map(({ producerId, firedStatus, action, reason }) => ({ producerId, firedStatus, action, reason })),
    })}\n`);
    if (options.apply && (result.status.classification === "FAIL_CLOSED"
        || result.status.classification === "EXECUTED_FAILED" || result.status.blocker)) process.exitCode = 1;
    return result;
  } catch (_) {
    deps.write(`${JSON.stringify({ mode: "FAIL_CLOSED", blocker: "INTERNAL_FAILURE_REDACTED", executed: 0 })}\n`);
    process.exitCode = 1;
    return null;
  }
}

if (require.main === module) runCli();

module.exports = {
  runEpochAutopilotModel,
  SOURCE_FILE, STATE_FILE, STATUS_FILE, LOCK_FILE,
  SOURCE_SCHEMA, STATE_SCHEMA, LEGACY_STATE_SCHEMA, STATUS_SCHEMA,
  SOURCE_MAX_AGE_MS, LOCK_LEASE_MS, MAX_WALL_MS, EVENT_COOLDOWN_MS, FAILURE_BACKOFF_MS,
  MAX_EXECUTIONS_PER_PASS, MAX_EVENTS, MAX_HISTORY, SUPPORTED_EVENTS, CROSS_VENUE_PRODUCERS,
  containsEndpointMaterial, validateSource, sourceFresh, evidenceIdentity, normalizeState,
  parseSource, inspectSource, buildStatus, executionFromBridge, writeAtomic, acquireFileLock,
  defaultDeps, runAutopilot, parseArgs, runCli,
};
