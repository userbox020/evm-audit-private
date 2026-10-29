#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { normalizeMonitorEvidence, runIdFor, marketIdentity, envelope } = require("./monitor-evidence");

const WORKSPACE = path.resolve(__dirname, "..");
const MONITOR_DIR = path.join(WORKSPACE, "reports", "monitor");
const STATE_FILE = path.join(MONITOR_DIR, "monitor-alert-dispatcher-state.json");
const STATUS_FILE = path.join(MONITOR_DIR, "monitor-alert-dispatcher-status.json");
const QUEUE_FILE = path.join(MONITOR_DIR, "monitor-alert-queue.json");
const MAX_QUEUE = 256;
const MAX_MESSAGE_CHARS = 512;
const MAX_DISPATCH_PER_PASS = 4;
const MAX_OBSERVATIONS = 256;
const SOURCE_COOLDOWN_MS = 5 * 60_000;

const INPUT_FILES = Object.freeze({
  autopilotHealth: path.join(MONITOR_DIR, "autopilot-health.json"),
  scheduler: path.join(MONITOR_DIR, "trigger-watch-scheduler.json"),
  profitTrigger: path.join(MONITOR_DIR, "profit-trigger-watch.json"),
  frozenOracle: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-frozen-oracle-status.json"),
  watchdog: path.join(MONITOR_DIR, "monitor-set-watchdog-status.json"),
  triggerForkAutopilot: path.join(MONITOR_DIR, "trigger-fork-autopilot-status.json"),
});

const POSITIVE_STATUS = /(?:^|_)(?:TRIGGERED?|TRIGGER_UNPAUSE|FIRED|POSITIVE(?:_FLOW|_GROSS_FORK_WARRANTED)?|WINDOW_OPEN|STRATEGY_SET_CHANGED)(?:$|_)/iu;
const FORK_STATUS_MAX_AGE_MS = 2 * 60_000;
const FORK_SOURCE_MAX_AGE_MS = 10 * 60_000;
const FORK_SOURCE_PATH = "reports/monitor/profit-trigger-watch.json";
const DELIVERY_STATUSES = new Set(["QUEUED", "DELIVERED", "DELIVERY_UNAVAILABLE"]);
const SEVERITY_ORDER = Object.freeze({ critical: 0, warning: 1, info: 2 });
// Fork-promotion-only producers: a fired cross-venue trigger never alerts on its
// own; only a promoted (net>0 + exact-pin) fork emits a critical alert.
const FORK_PROMOTION_PRODUCERS = Object.freeze(["frax-usdc-cross-venue", "base-usdc-usdt-cross-venue", "balancer-v2-eth-cross-venue", "balancer-v2-base-cross-venue", "balancer-v2-eth-join-exit", "curve-eth-join-exit", "curve-base-join-exit", "morpho-blue-eth-l", "morpho-blue-base-l", "aave-v3-eth-reserve-watch", "aave-v3-base-reserve-watch", "aave-v3-eth-l", "aave-v3-base-l"]);

function isoMs(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeToken(value, fallback = "unknown", maximum = 80) {
  const cleaned = String(value ?? "").replace(/[^A-Za-z0-9._:-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, maximum);
  return cleaned || fallback;
}

function sanitizeMessage(value) {
  let text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\b(?:https?|wss?|ftp):\/\/\S+/giu, "[redacted-url]")
    .replace(/\b(?:authorization|bearer|api[_-]?key|token|password|secret|private[_-]?key|mnemonic)\s*[:=]?\s*\S*/giu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  if (text.length > MAX_MESSAGE_CHARS) text = text.slice(0, MAX_MESSAGE_CHARS);
  return text;
}

function fresh(timestamp, nowMs, maximumAgeMs) {
  const stamp = isoMs(timestamp);
  return stamp !== null && stamp <= nowMs + 5 * 60_000 && nowMs - stamp <= maximumAgeMs;
}

function exactIsoMs(value) {
  const stamp = isoMs(value);
  return stamp !== null && new Date(stamp).toISOString() === value ? stamp : null;
}

function promotedExecution(inputs, nowMs) {
  return null; // legacy status text is not a private persisted epoch receipt
}
function heldForkPromotion(row){return typeof row.key==="string"&&row.key.startsWith("fork-promotion:")||typeof row.source==="string"&&row.source.startsWith("fork-promotion-");}

function readJsonBounded(file, fsImpl = fs) {
  try {
    const stat = fsImpl.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 2 * 1024 * 1024) return null;
    return JSON.parse(fsImpl.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

function readInputs(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const files = options.inputFiles || INPUT_FILES;
  return Object.fromEntries(Object.entries(files).map(([name, file]) => [name, readJsonBounded(file, fsImpl)]));
}

function observation(fields) {
  const monitorEvidence = boundFrozenEvidence(fields.monitorEvidence, fields.evidenceAt, fields.runId);
  return {
    key: safeToken(fields.key, "observation", 120),
    source: safeToken(fields.source, "monitor", 80),
    kind: safeToken(fields.kind, "health", 40),
    active: fields.active === true,
    value: safeToken(fields.value, fields.active ? "active" : "clear", 96),
    evidenceAt: typeof fields.evidenceAt === "string" && isoMs(fields.evidenceAt) !== null ? fields.evidenceAt : null,
    cycle: Number.isSafeInteger(fields.cycle) && fields.cycle >= 0 ? fields.cycle : null,
    metric: Number.isSafeInteger(fields.metric) && fields.metric >= 0 ? fields.metric : null,
    severity: ["critical", "warning", "info"].includes(fields.severity) ? fields.severity : "warning",
    label: safeToken(fields.label, fields.source, 96),
    recoverable: fields.recoverable !== false,
    ...(fields.source === "morpho-frozen-oracle" ? {
      aggregateOnly: fields.aggregateOnly === true,
      activeMarketSet: normalizeMarketSet(fields.activeMarketSet),
      ...(monitorEvidence ? { monitorEvidence } : {}),
    } : {}),
  };
}

function boundFrozenEvidence(value, observedAt, runId = runIdFor(observedAt)) {
  return normalizeMonitorEvidence(value, { producer: "morpho-frozen-oracle", observedAt, runId });
}

function normalizeMarketSet(value) {
  if (!Array.isArray(value) || value.length > 16 || value.some((v) => typeof v !== "string"
    || !/^[1-9][0-9]*:0x[0-9a-f]{64}$/.test(v) || !Number.isSafeInteger(Number(v.split(":")[0])))) return null;
  if (new Set(value).size !== value.length) return null;
  return [...value].sort();
}

function frozenSnapshot(artifact, count) {
  if (artifact?.runId !== runIdFor(artifact?.capturedAt)) return null;
  const evidence = boundFrozenEvidence(artifact?.monitorEvidence, artifact?.capturedAt, artifact?.runId);
  if (!evidence || !Array.isArray(artifact.markets) || artifact.markets.length > 16
      || artifact.markets.length !== evidence.markets.length) return null;
  const byIdentity = new Map(evidence.markets.map((market) => [marketIdentity(market), market]));
  const active = [], seen = new Set();
  for (const record of artifact.markets) {
    if (!Number.isSafeInteger(record?.chainId) || record.chainId <= 0
        || typeof record.marketId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(record.marketId)
        || !["TRIGGERED", "WATCH", "CLEAR", "REFERENCE_UNAVAILABLE", "ORACLE_REVERT"].includes(record.status)) return null;
    const id = marketIdentity(record), market = byIdentity.get(id);
    if (!market || seen.has(id)) return null;
    seen.add(id);
    if (record.status === "TRIGGERED") {
      if (market.predicate !== "TRUE") return null;
      active.push(market);
    }
  }
  if (active.length !== count) return null;
  // Only this event's active identities are retained. Never copy inactive markets
  // into a triggered alert or join a legacy queued alert to today's artifact.
  const snapshot = envelope("morpho-frozen-oracle", evidence.observedAt, active);
  snapshot.predicate = count > 0 ? "TRUE" : evidence.predicate;
  if (!count) {
    snapshot.quality = evidence.quality;
    snapshot.gaps = evidence.gaps;
  }
  return { evidence: snapshot, activeMarketSet: active.map(marketIdentity).sort(),
    recoverable: evidence.predicate === "FALSE" };
}

function aggregateFrozenEvidence(observedAt, active) {
  const evidence = envelope("morpho-frozen-oracle", observedAt, [],
    ["AGGREGATE_ONLY", "DETAILS_NOT_RETAINED", "ECONOMICS_NOT_EVALUATED"]);
  if (evidence) evidence.predicate = active ? "TRUE" : "UNKNOWN";
  return evidence;
}

function invalidFrozenEvidence(observedAt) {
  // Record rejection, not the rejected payload. The empty envelope is UNKNOWN /
  // UNAVAILABLE and is bound only to the independently valid enclosing time.
  return envelope("morpho-frozen-oracle", observedAt, [],
    ["EVIDENCE_INVALID", "DETAILS_NOT_RETAINED", "ECONOMICS_NOT_EVALUATED"]);
}

function frozenEventTimeBound(row) {
  return runIdFor(row.observedAt) !== null && ["active", "update", "recovery"].some((phase) =>
    row.eventKey === `trigger:morpho-frozen-oracle:${phase}:${row.observedAt}`);
}

function collectObservations(inputs, nowMs) {
  const rows = [];
  const health = inputs?.autopilotHealth;
  const healthFresh = fresh(health?.generatedAt, nowMs, 5 * 60_000);
  rows.push(observation({
    key: "health:autopilot-feed", source: "autopilot-health", kind: "health",
    active: !healthFresh, value: health ? "stale" : "missing", evidenceAt: health?.generatedAt,
    severity: "critical", label: "autopilot-health-feed",
  }));

  if (healthFresh && Array.isArray(health.services)) {
    for (const service of health.services.slice(0, 128)) {
      if (typeof service?.running !== "boolean") continue;
      const id = safeToken(service.id, "service");
      const ready = service.running === true
        && service.artifact?.exists === true
        && service.artifact?.fresh === true
        && service.artifact?.acceptable === true;
      let value = "not-ready";
      if (!service.running) value = "missing";
      else if (service.artifact?.fresh !== true) value = "stale";
      else if (ready) value = "ready";
      rows.push(observation({
        key: `service:${id}`, source: `service-${id}`, kind: "health", active: !ready,
        value, evidenceAt: health.generatedAt, cycle: health.cycle, severity: "critical", label: id,
      }));
    }
  }

  const frozen = inputs?.frozenOracle;
  const frozenFresh = fresh(frozen?.capturedAt, nowMs, 20 * 60_000);
  const healthTriggered = healthFresh && String(health?.triggerStatus?.status || health?.summary?.triggerStatus).toLowerCase() === "triggered";
  const healthCount = Number.isSafeInteger(health?.triggerStatus?.triggered)
    ? health.triggerStatus.triggered : Number.isSafeInteger(health?.summary?.frozenOracleTriggered) ? health.summary.frozenOracleTriggered : 0;
  const frozenCount = frozenFresh && Number.isSafeInteger(frozen?.summary?.TRIGGERED) ? frozen.summary.TRIGGERED : 0;
  if (frozenFresh || healthFresh) {
    // A newer health heartbeat is not a newer detailed market observation.
    const useFrozen = frozenFresh && Number.isSafeInteger(frozen?.summary?.TRIGGERED) && frozenCount >= 0;
    const count = useFrozen ? frozenCount : healthCount;
    const active = count > 0 || (!useFrozen && healthTriggered);
    const evidenceAt = useFrozen ? frozen.capturedAt : health.generatedAt;
    const snapshot = useFrozen ? frozenSnapshot(frozen, count) : null;
    const invalidEvidence = useFrozen && Object.hasOwn(frozen, "monitorEvidence") && !snapshot;
    rows.push(observation({
      key: "trigger:morpho-frozen-oracle", source: "morpho-frozen-oracle", kind: "trigger",
      active, value: active ? "triggered" : "clear", metric: count,
      evidenceAt, cycle: health?.cycle,
      severity: "critical", label: "morpho-frozen-oracle",
      monitorEvidence: snapshot?.evidence || (invalidEvidence ? invalidFrozenEvidence(evidenceAt) : aggregateFrozenEvidence(evidenceAt, active)),
      activeMarketSet: snapshot?.activeMarketSet, aggregateOnly: !snapshot,
      recoverable: snapshot?.recoverable === true,
    }));
  }

  const scheduler = inputs?.scheduler;
  if (fresh(scheduler?.generatedAt, nowMs, Math.max(45 * 60_000, Number(scheduler?.cadenceSeconds || 0) * 3_000))
      && Array.isArray(scheduler.producers)) {
    for (const producer of scheduler.producers.slice(0, 64)) {
      const id = safeToken(producer?.id, "producer");
      const status = safeToken(producer?.triggerStatus, "unknown");
      rows.push(observation({
        key: `scheduler:${id}`, source: `scheduler-${id}`, kind: "producer", active: POSITIVE_STATUS.test(status),
        value: status, evidenceAt: producer?.generatedAt || scheduler.generatedAt,
        cycle: scheduler?.cycle?.sequence, severity: "critical", label: id,
      }));
    }
  }

  const profit = inputs?.profitTrigger;
  if (fresh(profit?.generatedAt, nowMs, 30 * 60_000) && Array.isArray(profit.producers)) {
    for (const producer of profit.producers.slice(0, 64)) {
      const id = safeToken(producer?.id, "producer");
      const status = safeToken(producer?.status, "unknown");
      rows.push(observation({
        key: `profit-trigger:${id}`, source: `profit-trigger-${id}`, kind: "producer",
        active: POSITIVE_STATUS.test(status), value: status, evidenceAt: producer?.generatedAt || profit.generatedAt,
        severity: "critical", label: id,
      }));
    }
  }

  const watchdog = inputs?.watchdog;
  if (fresh(watchdog?.generatedAt, nowMs, 15 * 60_000) && Array.isArray(watchdog.services)) {
    for (const service of watchdog.services.slice(0, 128)) {
      const id = safeToken(service?.id, "service");
      const state = safeToken(service?.state, "unknown");
      const cutoff = ["retry-limit", "wall-clock-cap", "pass-relaunch-cap"].includes(service?.reason);
      const active = state === "relaunched" || state === "failed" || cutoff;
      rows.push(observation({
        key: `watchdog:${id}`, source: `watchdog-${id}`, kind: "watchdog", active,
        value: cutoff ? safeToken(service.reason) : state, evidenceAt: service?.lastAttemptAt || watchdog.generatedAt,
        metric: Number.isSafeInteger(service?.attempts) ? service.attempts : null,
        severity: state === "relaunched" ? "warning" : "critical", label: id,
      }));
    }
    rows.push(observation({
      key: "watchdog:wall-clock-cutoff", source: "watchdog", kind: "watchdog", active: watchdog.wallClockCapped === true,
      value: watchdog.wallClockCapped === true ? "wall-clock-cutoff" : "running-within-limit",
      evidenceAt: watchdog.generatedAt, severity: "critical", label: "watchdog",
    }));
  }
  // Promotion-ID MODEL outbox is separate; legacy fork status never observes
  // an active/clear transition or resets a generic health baseline.
  return rows.slice(0, MAX_OBSERVATIONS);
}

function normalizeState(value) {
  const result = { schema: "monitor-alert-dispatcher-state/v1", updatedAt: null, observations: {} };
  if (value?.schema !== result.schema || !value.observations || typeof value.observations !== "object") return null;
  for (const [rawKey, row] of Object.entries(value.observations).slice(0, MAX_OBSERVATIONS)) {
    const key = safeToken(rawKey, "", 120);
    if (!key) continue;
    result.observations[key] = {
      source: safeToken(row?.source, "monitor"), kind: safeToken(row?.kind, "health", 40), active: row?.active === true,
      value: safeToken(row?.value, "unknown", 96), evidenceAt: isoMs(row?.evidenceAt) === null ? null : row.evidenceAt,
      cycle: Number.isSafeInteger(row?.cycle) && row.cycle >= 0 ? row.cycle : null,
      metric: Number.isSafeInteger(row?.metric) && row.metric >= 0 ? row.metric : null,
      lastAlertAt: isoMs(row?.lastAlertAt) === null ? null : row.lastAlertAt,
      ...(key === "trigger:morpho-frozen-oracle" ? { activeMarketSet: normalizeMarketSet(row?.activeMarketSet) } : {}),
    };
  }
  result.updatedAt = isoMs(value.updatedAt) === null ? null : value.updatedAt;
  return result;
}

function normalizeQueue(value) {
  const queue = {
    schema: "monitor-alert-queue/v1", updatedAt: null, dropped: 0,
    retention: { deliveredAcknowledged: 0, pendingUnacknowledged: 0, legacyUnclassified: 0 }, alerts: [],
  };
  if (value?.schema !== queue.schema || !Array.isArray(value.alerts)) return queue;
  queue.updatedAt = isoMs(value.updatedAt) === null ? null : value.updatedAt;
  queue.dropped = Number.isSafeInteger(value.dropped) && value.dropped >= 0 ? value.dropped : 0;
  // Historical drops have no delivery-state evidence. Reject inconsistent counters
  // without rewriting the aggregate or guessing how those drops were delivered.
  const retention = value.retention;
  let remainder = queue.dropped;
  if (retention && typeof retention === "object" && !Array.isArray(retention)
      && ["deliveredAcknowledged", "pendingUnacknowledged", "legacyUnclassified"].every((key) => {
        const count = retention[key];
        if (!Number.isSafeInteger(count) || count < 0 || count > remainder) return false;
        remainder -= count;
        return true;
      }) && remainder === 0) {
    queue.retention = {
      deliveredAcknowledged: retention.deliveredAcknowledged,
      pendingUnacknowledged: retention.pendingUnacknowledged,
      legacyUnclassified: retention.legacyUnclassified,
    };
  } else queue.retention.legacyUnclassified = queue.dropped;
  for (const row of value.alerts.slice(-MAX_QUEUE)) {
    const deliveryStatus = DELIVERY_STATUSES.has(row?.delivery?.status) ? row.delivery.status : "QUEUED";
    const hasFrozenEvidence = row?.key === "trigger:morpho-frozen-oracle" && row?.source === "morpho-frozen-oracle"
      && row?.kind === "trigger" && Object.hasOwn(row, "monitorEvidence");
    let monitorEvidence = hasFrozenEvidence && frozenEventTimeBound(row)
      ? boundFrozenEvidence(row.monitorEvidence, row.observedAt) : null;
    if (monitorEvidence?.markets.some((market) => market.predicate !== "TRUE")) monitorEvidence = null;
    if (hasFrozenEvidence && !monitorEvidence) monitorEvidence = invalidFrozenEvidence(row.observedAt);
    queue.alerts.push({
      id: safeToken(row?.id, crypto.randomUUID(), 80), eventKey: safeToken(row?.eventKey, "event", 160),
      key: safeToken(row?.key, "alert", 120), source: safeToken(row?.source, "monitor"),
      kind: safeToken(row?.kind, "health", 40), severity: ["critical", "warning", "info"].includes(row?.severity) ? row.severity : "warning",
      message: sanitizeMessage(row?.message), observedAt: isoMs(row?.observedAt) === null ? null : row.observedAt,
      createdAt: isoMs(row?.createdAt) === null ? new Date(0).toISOString() : row.createdAt,
      test: row?.test === true, pending: deliveryStatus !== "DELIVERED", acknowledged: deliveryStatus === "DELIVERED",
      delivery: { status: deliveryStatus, attemptedAt: isoMs(row?.delivery?.attemptedAt) === null ? null : row.delivery.attemptedAt },
      ...(heldForkPromotion(row||{})&&deliveryStatus!=="DELIVERED"?{heldDiagnostic:"LEGACY_FORK_PROMOTION_HELD"}:{}),
      ...(monitorEvidence ? { monitorEvidence } : {}),
    });
  }
  return queue;
}

function eventToken(row, phase) {
  return safeToken(`${row.key}:${phase}:${row.evidenceAt || row.cycle || row.metric || row.value}`, "event", 160);
}

function alertFromObservation(row, phase, nowIso) {
  const recovery = phase === "recovery";
  const severity = recovery ? "info" : row.severity;
  const label = safeToken(row.label, row.source, 96);
  const monitorEvidence = boundFrozenEvidence(row.monitorEvidence, row.evidenceAt);
  let message;
  if (recovery) message = `[RECOVERY] ${label} returned to ${row.value}.`;
  else if (row.kind === "trigger") message = `[CRITICAL] ${label} trigger evidence is ${row.value}${row.metric !== null ? ` (count ${row.metric})` : ""}.`;
  else if (row.kind === "producer") message = `[CRITICAL] ${label} producer transitioned to ${row.value}.`;
  else if (row.kind === "watchdog") message = `[${severity.toUpperCase()}] Watchdog ${label}: ${row.value}.`;
  else message = `[CRITICAL] Persistent service ${label} is ${row.value}.`;
  return {
    key: row.key, eventKey: eventToken(row, phase), source: row.source, kind: row.kind, severity,
    message: sanitizeMessage(message), observedAt: row.evidenceAt || nowIso, test: false,
    ...(row.source === "morpho-frozen-oracle" && monitorEvidence ? { monitorEvidence } : {}),
  };
}

function detectAlerts(current, priorState, nowIso) {
  if (!priorState) return [];
  const alerts = [];
  for (const row of current) {
    const prior = priorState.observations[row.key];
    if (!prior) continue;
    if (row.active && !prior.active) alerts.push(alertFromObservation(row, "active", nowIso));
    else if (!row.active && prior.active && row.recoverable) alerts.push(alertFromObservation(row, "recovery", nowIso));
    else if (row.active && prior.active) {
      const detailedComparison = row.key === "trigger:morpho-frozen-oracle"
        && row.activeMarketSet !== null && prior.activeMarketSet != null;
      const increased = row.kind === "trigger" && row.metric !== null && prior.metric !== null && row.metric > prior.metric
        && !detailedComparison;
      const newWatchdogEvent = row.kind === "watchdog" && row.evidenceAt && row.evidenceAt !== prior.evidenceAt;
      const changedPositive = row.kind === "producer" && row.value !== prior.value;
      const changedMarkets = row.key === "trigger:morpho-frozen-oracle" && row.activeMarketSet !== null
        && prior.activeMarketSet != null && JSON.stringify(row.activeMarketSet) !== JSON.stringify(prior.activeMarketSet);
      if (increased || changedMarkets || newWatchdogEvent || changedPositive) alerts.push(alertFromObservation(row, "update", nowIso));
    }
  }
  return alerts;
}

function buildState(current, priorState, nowIso, alertedKeys = new Set()) {
  const observations = { ...(priorState?.observations || {}) };
  for (const row of current) {
    const prior = observations[row.key];
    // Missing/aggregate evidence cannot clear a known positive or erase its last
    // detailed identity baseline. Otherwise fallback -> detail would replay it.
    const held = row.key === "trigger:morpho-frozen-oracle" && !row.active && !row.recoverable && prior?.active;
    observations[row.key] = {
    source: row.source, kind: row.kind, active: row.active, value: row.value,
    evidenceAt: row.evidenceAt, cycle: row.cycle, metric: row.metric,
    lastAlertAt: alertedKeys.has(row.key) ? nowIso : observations[row.key]?.lastAlertAt || null,
    ...(row.key === "trigger:morpho-frozen-oracle" ? {
      activeMarketSet: held || row.activeMarketSet === null ? prior?.activeMarketSet ?? null : row.activeMarketSet,
    } : {}),
    ...(held ? { active: prior.active, value: prior.value, metric: prior.metric } : {}),
    };
  }
  const bounded = Object.fromEntries(Object.entries(observations).slice(-MAX_OBSERVATIONS));
  return { schema: "monitor-alert-dispatcher-state/v1", updatedAt: nowIso, observations: bounded };
}

function builtInWindowsDelivery(alert, options = {}) {
  if ((options.platform || process.platform) !== "win32") return "DELIVERY_UNAVAILABLE";
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) return "DELIVERY_UNAVAILABLE";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; if(-not [Environment]::UserInteractive){exit 2}; if(-not (Get-Process explorer -ErrorAction SilentlyContinue)){exit 3}; $n=New-Object System.Windows.Forms.NotifyIcon; try {$n.Icon=[System.Drawing.SystemIcons]::Warning; $n.Visible=$true; $n.BalloonTipTitle=$env:EVMAUDIT_ALERT_TITLE; $n.BalloonTipText=$env:EVMAUDIT_ALERT_MESSAGE; $n.BalloonTipIcon=[System.Windows.Forms.ToolTipIcon]::Warning; $n.ShowBalloonTip(5000); Start-Sleep -Seconds 6} finally {$n.Dispose()}";
  const env = {
    SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: process.env.ComSpec || path.join(systemRoot, "System32", "cmd.exe"),
    PATH: [path.join(systemRoot, "System32"), path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")].join(path.delimiter),
    TEMP: process.env.TEMP || path.join(systemRoot, "Temp"), TMP: process.env.TMP || process.env.TEMP || path.join(systemRoot, "Temp"),
    USERPROFILE: process.env.USERPROFILE || "", SESSIONNAME: process.env.SESSIONNAME || "",
    EVMAUDIT_ALERT_TITLE: alert.test ? "EVMAudit TEST notification" : `EVMAudit ${alert.severity} alert`,
    EVMAUDIT_ALERT_MESSAGE: sanitizeMessage(alert.message),
  };
  try {
    const result = (options.spawnSync || spawnSync)(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
      cwd: WORKSPACE, env, encoding: "utf8", windowsHide: true, timeout: 12_000, stdio: "ignore",
    });
    return result?.status === 0 && !result?.error ? "DELIVERED" : "DELIVERY_UNAVAILABLE";
  } catch (_) {
    return "DELIVERY_UNAVAILABLE";
  }
}

function enqueue(queue, candidates, nowIso) {
  const known = new Set(queue.alerts.map((row) => row.eventKey));
  let added = 0;
  for (const alert of candidates) {
    if (known.has(alert.eventKey)) continue;
    known.add(alert.eventKey);
    queue.alerts.push({
      id: crypto.randomUUID(), ...alert, createdAt: nowIso, pending: true, acknowledged: false,
      delivery: { status: "QUEUED", attemptedAt: null },
    });
    added += 1;
  }
  if (queue.alerts.length > MAX_QUEUE) {
    const excess = queue.alerts.length - MAX_QUEUE;
    const acknowledged = queue.alerts.filter((row) => row.acknowledged).slice(0, excess);
    const remove = new Set(acknowledged.map((row) => row.id));
    for (const row of queue.alerts) {
      if (remove.size >= excess) break;
      if(row.pending&&heldForkPromotion(row))continue; // quarantine is retained, not silently evicted
      if (!remove.has(row.id)) remove.add(row.id);
    }
    const accounted = Math.min(excess, Number.MAX_SAFE_INTEGER - queue.dropped);
    const selected = queue.alerts.filter((row) => remove.has(row.id)&&!(row.pending&&heldForkPromotion(row)));
    if (accounted === excess && selected.length === excess) {
      const delivered = selected.filter((row) => row.delivery?.status === "DELIVERED").length;
      queue.retention.deliveredAcknowledged += delivered;
      queue.retention.pendingUnacknowledged += excess - delivered;
    } else {
      // Duplicate IDs make selected rows ambiguous; saturated totals also cannot
      // safely represent every eviction. Preserve bounded aggregate accounting.
      queue.retention.legacyUnclassified += accounted;
    }
    queue.alerts = queue.alerts.filter((row) => row.pending&&heldForkPromotion(row)||!remove.has(row.id));
    queue.dropped += accounted;
  }
  return added;
}

function dispatchPending(queue, nowMs, delivery, options = {}) {
  const cap = Math.max(0, Math.min(MAX_DISPATCH_PER_PASS, options.dispatchCap ?? MAX_DISPATCH_PER_PASS));
  const cooldown = options.cooldownMs ?? SOURCE_COOLDOWN_MS;
  const lastBySource = new Map();
  for (const row of queue.alerts) {
    const stamp = isoMs(row.delivery.attemptedAt);
    if (stamp !== null) lastBySource.set(row.source, Math.max(lastBySource.get(row.source) || 0, stamp));
  }
  const pending = queue.alerts.filter((row) => row.pending)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || isoMs(a.createdAt) - isoMs(b.createdAt));
  const results = [];
  for (const row of pending) {
    if(heldForkPromotion(row)){row.heldDiagnostic="LEGACY_FORK_PROMOTION_HELD";continue;}
    if (results.length >= cap) break;
    if (nowMs - (lastBySource.get(row.source) || 0) < cooldown) continue;
    let status = "DELIVERY_UNAVAILABLE";
    try {
      const result = delivery(row);
      if (result === true || result === "DELIVERED") status = "DELIVERED";
    } catch (_) { /* retained as unavailable */ }
    const attemptedAt = new Date(nowMs).toISOString();
    row.delivery = { status, attemptedAt };
    row.pending = status !== "DELIVERED";
    row.acknowledged = status === "DELIVERED";
    lastBySource.set(row.source, nowMs);
    results.push({ id: row.id, key: row.key, source: row.source, status, attemptedAt });
  }
  return results;
}

function writeAtomic(file, value, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  try {
    fsImpl.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fsImpl.renameSync(temporary, file);
  } finally {
    try { fsImpl.rmSync(temporary, { force: true }); } catch (_) {}
  }
}

function runDispatcher(options = {}) {
  const nowMs = Number((options.clock || Date.now)());
  const nowIso = new Date(nowMs).toISOString();
  const apply = options.apply === true || options.testNotification === true;
  const inputs = options.inputs || readInputs(options);
  const priorStateRaw = options.priorState === undefined ? readJsonBounded(options.stateFile || STATE_FILE, options.fsImpl || fs) : options.priorState;
  const priorState = normalizeState(priorStateRaw);
  const queueRaw = options.priorQueue === undefined ? readJsonBounded(options.queueFile || QUEUE_FILE, options.fsImpl || fs) : options.priorQueue;
  const queue = normalizeQueue(queueRaw);
  const current = collectObservations(inputs, nowMs);
  const baselineEstablished = priorState === null;
  const candidates = detectAlerts(current, priorState, nowIso);
  if (options.testNotification === true) candidates.push({
    key: "test:local-notification", eventKey: `test-local-notification-${nowMs}`, source: "test-notification",
    kind: "test", severity: "info", message: "[TEST] EVMAudit local monitor notification delivery test.",
    observedAt: nowIso, test: true,
  });

  let enqueued = 0;
  let dispatches = [];
  if (apply) {
    enqueued = enqueue(queue, candidates, nowIso);
    dispatches = dispatchPending(queue, nowMs, options.delivery || ((alert) => builtInWindowsDelivery(alert, options)), options);
    queue.updatedAt = nowIso;
  }
  const alertedKeys = new Set(candidates.filter((row) => !row.test).map((row) => row.key));
  const state = buildState(current, priorState, nowIso, alertedKeys);
  const pending = queue.alerts.filter((row) => row.pending).length;
  const acknowledged = queue.alerts.filter((row) => row.acknowledged).length;
  const delivered = dispatches.filter((row) => row.status === "DELIVERED").length;
  const unavailable = dispatches.filter((row) => row.status === "DELIVERY_UNAVAILABLE").length;
  const status = {
    schema: "monitor-alert-dispatcher-status/v1", generatedAt: nowIso,
    mode: options.testNotification === true ? "test-notification" : apply ? "apply" : "check",
    baselineEstablished,
    summary: {
      observations: current.length, wouldAlert: candidates.length, enqueued, dispatched: dispatches.length,
      delivered, deliveryUnavailable: unavailable, pending, acknowledged, queueSize: queue.alerts.length, dropped: queue.dropped,
      retention: { ...queue.retention },
    },
    wouldAlerts: candidates.slice(0, 64).map(({ key, source, severity, message, test }) => ({ key, source, severity, message, test })),
    lastDelivery: dispatches.length ? dispatches[dispatches.length - 1] : null,
    queue: { path: "reports/monitor/monitor-alert-queue.json", pending, acknowledged, size: queue.alerts.length },
    lastRun: { startedAt: nowIso, completedAt: new Date(Number((options.clock || Date.now)())).toISOString(), result: "PASS" },
  };

  if (apply) {
    if (typeof options.write === "function") options.write({ state, queue, status });
    else {
      const fsImpl = options.fsImpl || fs;
      writeAtomic(options.queueFile || QUEUE_FILE, queue, fsImpl);
      writeAtomic(options.stateFile || STATE_FILE, state, fsImpl);
      writeAtomic(options.statusFile || STATUS_FILE, status, fsImpl);
    }
  }
  return { state, queue, status, candidates, dispatches };
}

function parseOptions(argv = process.argv.slice(2)) {
  const allowed = new Set(["--check", "--apply", "--test-notification"]);
  if (argv.some((arg) => !allowed.has(arg)) || new Set(argv).size !== argv.length || argv.length > 1) {
    throw new Error("use exactly one of --check, --apply, or --test-notification");
  }
  const testNotification = argv.includes("--test-notification");
  return { apply: argv.includes("--apply"), testNotification };
}

function cli(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  const result = runDispatcher(options);
  const summary = result.status.summary;
  process.stdout.write(`monitor-alert-dispatcher ${result.status.mode}: baseline=${result.status.baselineEstablished} would-alert=${summary.wouldAlert} dispatched=${summary.dispatched} delivered=${summary.delivered} unavailable=${summary.deliveryUnavailable} pending=${summary.pending}\n`);
  return result;
}

if (require.main === module) {
  try { cli(); }
  catch (_) {
    process.stderr.write("monitor-alert-dispatcher: failed closed\n");
    process.exitCode = 1;
  }
}

module.exports = {
  INPUT_FILES, MAX_DISPATCH_PER_PASS, MAX_MESSAGE_CHARS, MAX_QUEUE, QUEUE_FILE, SOURCE_COOLDOWN_MS,
  FORK_PROMOTION_PRODUCERS,
  STATE_FILE, STATUS_FILE, builtInWindowsDelivery, collectObservations, normalizeQueue, normalizeState,
  parseOptions, runDispatcher, sanitizeMessage, writeAtomic,
};
