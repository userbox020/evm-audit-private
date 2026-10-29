#!/usr/bin/env node
// monitor-high-probability.js — read-only watch runner for top dormant triggers.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const WORKSPACE = path.resolve(__dirname, "..");
const STATE_FILE = path.join(WORKSPACE, "reports", "monitor", "high-probability-state-v2.json");
const ALERT_FILE = path.join(WORKSPACE, "reports", "monitor", "alerts.jsonl");
const KAMINO_SCRIPT = path.join("targets", "kamino-klend", "monitor-liquidation-window.js");
const SUILEND_PROBE = path.join("tools", "suilend_suite_candidate_probe.js");
const STEAMM_MARKETABILITY = path.join("tools", "steamm_candidate_marketability.js");
const STEAMM_CANDIDATES = path.join(WORKSPACE, "reports", "raw", "suilend-suite-candidate-probe.json");
const STEAMM_MARKETABILITY_JSON = path.join(WORKSPACE, "reports", "raw", "steamm-candidate-marketability.json");

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_STEAMM_REFRESH_MS = 30 * 60_000;

function sanitize(text) {
  return String(text || "")
    .replace(/https?:\/\/[^\s'"<>]+/g, "[redacted-url]")
    .replace(/(PRIVATE_KEY=)0x[0-9a-fA-F]{64}/g, "$1[redacted]");
}

function ts() { return new Date().toISOString(); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function alertState(entry) {
  if (!entry) return { fingerprint: null, severity: null };
  if (typeof entry === "object") return { fingerprint: entry.fingerprint || null, severity: entry.severity || null };
  return { fingerprint: String(entry), severity: null };
}

function appendAlert(state, key, severity, fields) {
  const { emitOnLegacySeverityChange = false, ...alertFields } = fields || {};
  const fingerprint = alertFields.fingerprint || key;
  const previous = alertState(state.lastAlerted?.[key]);
  const sameFingerprint = previous.fingerprint === fingerprint;
  const sameSeverity = previous.severity === severity;
  if (sameFingerprint && (sameSeverity || (!previous.severity && !emitOnLegacySeverityChange))) return false;

  state.lastAlerted = state.lastAlerted || {};
  state.lastAlerted[key] = { fingerprint, severity };
  const alert = { timestamp: ts(), condition: "high-probability-watch", severity, vector: key, ...alertFields };
  if (sameFingerprint && previous.severity && previous.severity !== severity) alert.previousSeverity = previous.severity;
  if (sameFingerprint && !previous.severity && emitOnLegacySeverityChange) alert.previousSeverity = "legacy";
  fs.mkdirSync(path.dirname(ALERT_FILE), { recursive: true });
  fs.appendFileSync(ALERT_FILE, `${JSON.stringify(alert)}\n`);
  return true;
}

function fileAgeMs(file) {
  try { return Date.now() - fs.statSync(file).mtimeMs; } catch (_) { return Infinity; }
}

function runNode(label, args, timeoutMs) {
  const result = spawnSync(process.execPath, args, {
    cwd: WORKSPACE,
    env: { ...process.env, FORCE_COLOR: "0" },
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const stdout = sanitize(result.stdout || "");
  const stderr = sanitize(result.stderr || "");
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
  if (result.error) console.error(`${label}: ${sanitize(result.error.message)}`);
  return { ok: result.status === 0 && !result.error, status: result.status, stdout, stderr };
}

function parseArgs(argv) {
  const args = new Set(argv);
  const watch = args.has("--watch");
  const numeric = argv.find((arg, i) => i > 0 && /^\d+$/.test(arg));
  const intervalMs = numeric ? Number(numeric) * 1000 : DEFAULT_INTERVAL_MS;
  return {
    watch,
    intervalMs,
    skipKamino: args.has("--skip-kamino"),
    skipSteamm: args.has("--skip-steamm"),
    refreshSteamm: args.has("--refresh-steamm"),
    noRefreshSteamm: args.has("--no-refresh-steamm"),
  };
}

function summarizeKamino(output) {
  const line = output.split(/\r?\n/).find((l) => /LIVE_WINDOW:/i.test(l));
  if (!line) return { status: "unknown", message: "LIVE_WINDOW line not found" };
  if (/LIVE_WINDOW:\s*none/i.test(line)) return { status: "none", message: "LIVE_WINDOW: none" };
  const match = line.match(/LIVE_WINDOW:\s*(.+)$/i);
  return { status: "candidate", message: match ? `LIVE_WINDOW: ${match[1].trim()}` : line.trim() };
}

function runKamino(state) {
  console.log(`\n[${ts()}] Kamino LIVE_WINDOW check`);
  const result = runNode("kamino", [KAMINO_SCRIPT, "--once"], 180_000);
  const summary = summarizeKamino(`${result.stdout}\n${result.stderr}`);
  console.log(`Kamino summary: ${summary.message}`);
  state.kamino = { lastChecked: ts(), status: summary.status, message: summary.message };
  if (summary.status === "candidate") {
    const emitted = appendAlert(state, "kamino-live-window", "CRITICAL", {
      fingerprint: summary.message,
      message: `Kamino reduced-status liquidation ${summary.message}. Run guarded executor in plan/sim mode before any signed action.`,
    });
    if (emitted) console.log("Kamino alert emitted");
  } else if (summary.status === "none" && state.lastAlerted?.["kamino-live-window"]) {
    const emitted = appendAlert(state, "kamino-live-window", "INFO", {
      fingerprint: summary.message,
      emitOnLegacySeverityChange: true,
      message: "Kamino reduced-status liquidation LIVE_WINDOW is empty.",
    });
    if (emitted) console.log("Kamino clear status emitted");
  }
  return result.ok && summary.status !== "unknown";
}

function runSteamm(state, opts) {
  console.log(`\n[${ts()}] STEAMM marketability check`);
  const shouldRefresh = opts.refreshSteamm || (!opts.noRefreshSteamm && fileAgeMs(STEAMM_CANDIDATES) > DEFAULT_STEAMM_REFRESH_MS);
  if (shouldRefresh) {
    console.log("Refreshing STEAMM candidate probe");
    const probe = runNode("suilend-probe", [SUILEND_PROBE], 600_000);
    if (!probe.ok) return false;
  } else {
    const ageMin = Math.round(fileAgeMs(STEAMM_CANDIDATES) / 60_000);
    console.log(`Using existing STEAMM candidate probe (${ageMin}m old)`);
  }

  const market = runNode("steamm-marketability", [STEAMM_MARKETABILITY], 600_000);
  if (!market.ok) return false;

  const data = readJson(STEAMM_MARKETABILITY_JSON, null);
  if (!data) {
    console.log("STEAMM summary: marketability output missing");
    return false;
  }
  const top = Array.isArray(data.ranked) ? data.ranked[0] : null;
  const fingerprint = [data.candidateCount, data.dexPricedCount, data.steammRouteOnlyCount, top?.poolId, top?.status, top?.bestLiquidityUsd].join(":");
  const dexPricedCount = Number(data.dexPricedCount || 0);
  const routeOnlyCount = Number(data.steammRouteOnlyCount || 0);
  const steammSeverity = dexPricedCount > 0 ? "CRITICAL" : routeOnlyCount > 0 ? "INFO" : "OK";
  state.steamm = {
    lastChecked: ts(),
    severity: steammSeverity,
    checkpoint: data.chain?.latestCheckpoint || data.checkpoint || null,
    candidateCount: Number(data.candidateCount || 0),
    dexPricedCount,
    routeOnlyCount,
    unpricedCount: Number(data.unpricedCount || 0),
    topPool: top?.poolId || null,
    topStatus: top?.status || null,
    bestLiquidityUsd: Number(top?.bestLiquidityUsd || 0),
  };
  console.log(`STEAMM summary: candidates=${data.candidateCount} dexPriced=${data.dexPricedCount} routeOnly=${data.steammRouteOnlyCount} unpriced=${data.unpricedCount}`);

  if (dexPricedCount > 0) {
    const emitted = appendAlert(state, "steamm-dex-priced", "CRITICAL", {
      fingerprint,
      count: data.dexPricedCount,
      message: `STEAMM zero-offset CPMM has ${data.dexPricedCount} DexScreener-priced candidate(s). Top pool=${top?.poolId || "unknown"} status=${top?.status || "unknown"} bestLiquidityUsd=${Number(top?.bestLiquidityUsd || 0).toFixed(2)}. Do local/Sui simulation before any live action.`,
    });
    if (emitted) console.log("STEAMM critical alert emitted");
  } else if (state.lastAlerted?.["steamm-dex-priced"]) {
    const emitted = appendAlert(state, "steamm-dex-priced", "INFO", {
      fingerprint: "dex-priced:0",
      emitOnLegacySeverityChange: true,
      message: "STEAMM zero-offset CPMM has no DexScreener-priced candidates.",
    });
    if (emitted) console.log("STEAMM priced clear status emitted");
  }

  if (routeOnlyCount > 0) {
    const emitted = appendAlert(state, "steamm-route-only", "INFO", {
      fingerprint,
      emitOnLegacySeverityChange: true,
      count: data.steammRouteOnlyCount,
      message: `STEAMM zero-offset CPMM has ${data.steammRouteOnlyCount} internal-route-only candidate(s), but no external-priced route. Treat as watch-only until priced liquidity appears.`,
    });
    if (emitted) console.log("STEAMM route-only status emitted");
  } else if (state.lastAlerted?.["steamm-route-only"]) {
    const emitted = appendAlert(state, "steamm-route-only", "INFO", {
      fingerprint: "route-only:0",
      emitOnLegacySeverityChange: true,
      message: "STEAMM zero-offset CPMM has no internal-route-only candidates.",
    });
    if (emitted) console.log("STEAMM route-only clear status emitted");
  }
  return true;
}

async function runOnce(opts, state) {
  const ok = [];
  if (!opts.skipKamino) ok.push(runKamino(state));
  if (!opts.skipSteamm) ok.push(runSteamm(state, opts));
  state.lastRun = ts();
  writeJson(STATE_FILE, state);
  return ok.every(Boolean);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const state = readJson(STATE_FILE, { lastAlerted: {} });
  console.log("High-probability watch runner (read-only)");
  console.log(`Mode: ${opts.watch ? `watch every ${Math.round(opts.intervalMs / 1000)}s` : "single scan"}`);
  console.log("Targets: Kamino LIVE_WINDOW, STEAMM zero-offset marketability");

  do {
    const ok = await runOnce(opts, state);
    if (!opts.watch) process.exit(ok ? 0 : 1);
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
  } while (true);
}

main().catch((err) => {
  console.error(sanitize(err.stack || err.message || err));
  process.exit(1);
});
