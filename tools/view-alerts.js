#!/usr/bin/env node
"use strict";

// Local, read-only monitor health and research-watch viewer.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ALERT_FILE = path.join(ROOT, "reports", "monitor", "alerts.jsonl");
const LAST_VIEW_FILE = path.join(ROOT, "reports", "monitor", ".last-view.json");
const AAVE_V4_FILE = path.join(ROOT, "reports", "raw", "fast", "aave-v4-liquidation-watch.json");
const RESEARCH_FILE = path.join(ROOT, "reports", "monitor", "research-watch-state.json");
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_EVENTS = 1000;
const MAX_METRIC = 1e15;

const args = process.argv.slice(2);
const sinceMode = args.includes("--since");
const dashboardMode = args.includes("--dashboard");

function loadJson(file, fallback) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) return fallback;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch (_) {
    return fallback;
  }
}

function boundedLines(file) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) return [];
    const length = Math.min(info.size, MAX_BYTES);
    const start = info.size - length;
    const descriptor = fs.openSync(file, "r");
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, start);
    fs.closeSync(descriptor);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
    return text.split("\n").filter(Boolean).slice(-MAX_EVENTS);
  } catch (_) {
    return [];
  }
}

function sourceTime(row) {
  return row.sourceGeneratedAt ?? row.timestamp ?? row.at ?? null;
}

function eventTimeMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e11 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizedEvent(row, now = Date.now()) {
  if (!row || typeof row !== "object") return null;
  const level = String(row.severity || "").toUpperCase();
  if (!["CRITICAL", "HIGH", "WARN", "INFO", "MEDIUM", "DORMANT"].includes(level)) return null;
  const sourceMs = eventTimeMs(sourceTime(row));
  if (!Number.isFinite(sourceMs)) return null;
  const sourceHealth = String(row.sourceHealth || "OK").toUpperCase();
  const stale = sourceHealth === "STALE" || sourceHealth === "INVALID" || now - sourceMs > 60 * 60 * 1000;
  const candidate = typeof row.condition === "string" ? row.condition : "";
  const condition = /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(candidate) && !/^0x[a-f0-9]{40}$/i.test(candidate)
    ? candidate
    : "monitor-event";
  return {
    condition,
    severity: level === "MEDIUM" ? "WARN" : level === "DORMANT" ? "INFO" : level,
    sourceMs,
    lifecycle: stale ? "HISTORICAL" : "RECENT_EVENT",
  };
}

function loadAlerts() {
  const seen = new Set();
  const result = [];
  for (const line of boundedLines(ALERT_FILE)) {
    try {
      const event = normalizedEvent(JSON.parse(line));
      if (!event) continue;
      const key = `${event.condition}|${event.severity}|${event.sourceMs}|${event.lifecycle}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(event);
    } catch (_) {}
  }
  return result;
}

function finiteMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= MAX_METRIC ? number : null;
}

function aaveV4Health(now = Date.now()) {
  const state = loadJson(AAVE_V4_FILE, null);
  const latest = state?.latest;
  const summary = latest?.summary;
  if (state?.scanner !== "tools/watch-aave-v4-liquidation-triggers.js" || !latest || !summary) return { status: "UNKNOWN" };
  const sourceMs = eventTimeMs(latest.sourceGeneratedAt);
  const health = String(latest.sourceHealth || state.sourceHealth || "OK").toUpperCase();
  if (!Number.isFinite(sourceMs) || !["OK", "STALE", "INVALID"].includes(health)) return { status: "UNKNOWN" };
  if (health !== "OK" || now - sourceMs > 30 * 60 * 1000) return { status: "STALE", at: sourceMs };
  const near = finiteMetric(summary.nearLiquidation);
  const liquidatable = finiteMetric(summary.liquidatable);
  const route = finiteMetric(summary.routePositive);
  if ([near, liquidatable, route].some(value => value === null)) return { status: "UNKNOWN" };
  return { status: liquidatable > 0 || route > 0 ? "TRIGGERED" : near > 0 ? "WATCH" : "ZERO", at: sourceMs, near, liquidatable };
}

function researchGroups() {
  const state = loadJson(RESEARCH_FILE, null);
  if (state?.schema !== "monitor-research-watch/v1" || !Array.isArray(state.entries)) return null;
  const groups = new Map();
  for (const entry of state.entries.slice(0, 200)) {
    if (!entry || typeof entry.id !== "string" || typeof entry.disposition !== "string") continue;
    const key = entry.effectiveDisposition === "INCOMPLETE" ? "INCOMPLETE" : entry.disposition;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return groups;
}

function printAlerts(alerts) {
  if (alerts.length === 0) {
    console.log("No bounded monitor events available.");
    return;
  }
  const counts = {};
  for (const event of alerts) counts[event.lifecycle] = (counts[event.lifecycle] || 0) + 1;
  console.log(`Monitor events: ${alerts.length}; recent=${counts.RECENT_EVENT || 0}; historical=${counts.HISTORICAL || 0}`);
  for (const event of alerts.slice(-20)) {
    console.log(`  ${new Date(event.sourceMs).toISOString()} ${event.lifecycle.padEnd(12)} ${event.severity.padEnd(8)} ${event.condition}`);
  }
}

function printDashboard(alerts) {
  console.log("EVM AUDIT — READ-ONLY MONITOR HEALTH\n");
  const aave = aaveV4Health();
  const detail = aave.status === "WATCH" ? ` near=${aave.near}` : aave.status === "TRIGGERED" ? ` liquidatable=${aave.liquidatable}` : "";
  console.log(`Aave V4 authoritative watcher: ${aave.status}${detail}`);

  const groups = researchGroups();
  if (!groups) {
    console.log("Research watches: UNKNOWN (state unavailable or invalid)");
  } else {
    console.log("\nResearch watches:");
    for (const disposition of ["ACTIVE_WATCH", "CHANGE_TRIGGER", "SCHEDULED", "HOLD", "SUPPRESSED", "INCOMPLETE"]) {
      const rows = groups.get(disposition) || [];
      console.log(`  ${disposition}: ${rows.length}`);
      for (const row of rows) {
        const due = disposition === "SCHEDULED" && Number.isFinite(Date.parse(row.reviewAt)) && Date.now() >= Date.parse(row.reviewAt) ? " DUE_FOR_REVIEW" : "";
        console.log(`    ${row.id} [${row.status || "INCOMPLETE"}]${due}`);
      }
    }
  }
  console.log("");
  printAlerts(alerts);
}

function lastViewMs() {
  const value = loadJson(LAST_VIEW_FILE, null);
  return Number.isFinite(value?.ts) ? value.ts : null;
}

function saveLastView() {
  fs.writeFileSync(LAST_VIEW_FILE, `${JSON.stringify({ timestamp: new Date().toISOString(), ts: Date.now() }, null, 2)}\n`, "utf8");
}

const alerts = loadAlerts();
if (dashboardMode) {
  printDashboard(alerts);
} else if (sinceMode) {
  const since = lastViewMs();
  printAlerts(since === null ? alerts : alerts.filter(event => event.sourceMs > since));
  saveLastView();
} else {
  printAlerts(alerts);
}
