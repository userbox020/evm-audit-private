#!/usr/bin/env node
"use strict";

// monitor-kamino-reduced-status.js
//
// Durable read-only watch for the Kamino Klend reduced-price-status liquidation bypass.
// The mechanism is proven but currently dormant and unpatched: across prior snapshots of all
// Main Market reserves, none were in the reduced state. This monitor fires when one is.
//
// PREDICATE (single source of truth: tools/solana-kamino-current-status.js):
//   reduced    := ((status & 0x23) == 0x23) && ((status & 0x3f) != 0x3f)
//                 0x23 = LIQUIDATION_CHECKS (omits TWAP_CHECKED, TWAP_AGE_CHECKED, HEURISTIC_CHECKED)
//                 0x3f = ALL_CHECKS
//   in-state   := reduced && ageSlots == 0   -> ALERT (live same-slot bypass window)
//   near-state := reduced && ageSlots < 5    -> WARN
// Reserve set: all Main Market reserves (dataSize 8624, lending_market memcmp at offset 32).
// ageSlots = finalized context slot - LastUpdate.lastUpdateSlot.
//
// SECRETS CONTRACT (do not weaken):
//   * rpc_endpoints.txt is read in-process by the shared status probe under standing authorization.
//   * The endpoint value is never printed, logged, summarized, hashed, persisted, or placed on
//     any child command line. The artifact records only { qualified, candidatesTested }.
//   * Every artifact and trigger record passes a fail-closed non-loopback URL scan before writing.
//   * Read-only: getGenesisHash/getSlot/getProgramAccounts/getAccountInfo only. No signing,
//     no transaction, no state change anywhere.
//
// Usage:
//   node tools/monitor-kamino-reduced-status.js --once
//   node tools/monitor-kamino-reduced-status.js --loop [--interval-seconds 300]
//
// Outputs:
//   reports/raw/fast/kamino-reduced-status.json            sanitized current status
//   reports/raw/fast/kamino-reduced-status-triggers.jsonl  append-only transitions + alerts
//   reports/raw/fast/kamino-reduced-status-state.json      transition-detection state

const fs = require("fs");
const path = require("path");
const probe = require("./solana-kamino-current-status.js");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "reports", "raw", "fast");
const ARTIFACT_PATH = path.join(OUT_DIR, "kamino-reduced-status.json");
const TRIGGER_LOG_PATH = path.join(OUT_DIR, "kamino-reduced-status-triggers.jsonl");
const STATE_PATH = path.join(OUT_DIR, "kamino-reduced-status-state.json");

const SCHEMA = "kamino-reduced-status/1";
const TRIGGER_SCHEMA = "kamino-reduced-status-trigger/1";
const MONITOR = "monitor-kamino-reduced-status";
const MAX_STATE_BYTES = 256 * 1024;
const DEFAULT_INTERVAL_SECONDS = 300;
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 86400;

const LEVEL = Object.freeze({
  ALERT: "ALERT",
  WARN: "WARN",
  REDUCED: "REDUCED",
  CLEAN: "CLEAN",
  ERROR: "ERROR",
});

const NON_LOOPBACK_URL = /https?:\/\/[^\s"'<>\\]+/gi;
const LOOPBACK_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?:[:/]|$)/i;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Fail closed: refuse to write anything that contains a non-loopback URL.
function assertSanitized(label, value) {
  const text = JSON.stringify(value);
  NON_LOOPBACK_URL.lastIndex = 0;
  let m;
  while ((m = NON_LOOPBACK_URL.exec(text)) !== null) {
    if (!LOOPBACK_URL.test(m[0])) throw new Error(`sanitization-failed:${label}`);
  }
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, "/");
}

function readState() {
  try {
    const st = fs.statSync(STATE_PATH);
    if (!st.isFile() || st.size > MAX_STATE_BYTES) return null;
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return s && typeof s === "object" ? s : null;
  } catch (_) {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function appendTrigger(record) {
  assertSanitized("trigger", record);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(TRIGGER_LOG_PATH, JSON.stringify(record) + "\n", "utf8");
}

function compactReserve(r, state) {
  return {
    pubkey: r.pubkey,
    tokenName: r.tokenName,
    state,
    statusHex: r.statusHex,
    missingFlags: r.missingFlags,
    lastUpdateSlot: r.lastUpdateSlot,
    ageSlots: r.ageSlots,
    stale: r.stale,
    marketMatches: r.marketMatches === undefined ? null : r.marketMatches,
    liquidationChecksAccepted: r.liquidationChecksAccepted,
    allChecksAccepted: r.allChecksAccepted,
  };
}

function detailReserve(r, state) {
  return {
    ...compactReserve(r, state),
    maxTwapDivergenceBps: r.maxTwapDivergenceBps,
    maxAgePriceSeconds: r.maxAgePriceSeconds,
    maxAgeTwapSeconds: r.maxAgeTwapSeconds,
    oracle: r.oracle,
    heuristic: { lower: r.heuristicLower, upper: r.heuristicUpper, exp: r.heuristicExp },
  };
}

// One observation cycle. Never persists the endpoint value.
async function collect() {
  const qualified = await probe.qualify();

  const head = Number(await probe.rpc(qualified.url, "getSlot", [{ commitment: "finalized" }]));

  const { contextSlot, reserves, reserveErrors, rowsReturned } = await probe.fetchReserves(qualified.url, head);
  if (contextSlot < 0) throw new Error("finalized-context-unavailable");
  if (rowsReturned === 0) throw new Error("reserve-enumeration-empty");

  const classified = reserves.map((r) => ({ reserve: r, state: probe.classifyReserve(r) }));

  const stateCounts = { clean: 0, reduced: 0, nearState: 0, inState: 0 };
  const byStatus = {};
  let zeroStatusReserves = 0;
  let notLiquidationUsableReserves = 0;
  for (const c of classified) {
    const r = c.reserve;
    byStatus[r.statusHex] = (byStatus[r.statusHex] || 0) + 1;
    if (r.status === 0) zeroStatusReserves++;
    if (!r.liquidationChecksAccepted) notLiquidationUsableReserves++;
    if (r.reduced) stateCounts.reduced++;
    if (c.state === probe.RESERVE_STATE.IN_STATE) stateCounts.inState++;
    else if (c.state === probe.RESERVE_STATE.NEAR_STATE) stateCounts.nearState++;
    else if (c.state === probe.RESERVE_STATE.CLEAN) stateCounts.clean++;
  }

  const level = stateCounts.inState > 0
    ? LEVEL.ALERT
    : stateCounts.nearState > 0
      ? LEVEL.WARN
      : stateCounts.reduced > 0
        ? LEVEL.REDUCED
        : LEVEL.CLEAN;

  const alerting = classified.filter((c) => c.state === probe.RESERVE_STATE.IN_STATE || c.state === probe.RESERVE_STATE.NEAR_STATE);
  const anyReduced = classified.filter((c) => c.reserve.reduced);
  const coverageDegraded = reserveErrors.length > 0 || rowsReturned !== classified.length;

  return {
    level,
    candidatesTested: qualified.tested,
    observation: {
      contextSlot,
      finalizedHeadAtStart: head,
      commitment: "finalized",
      ageBasis: "contextSlot - LastUpdate.lastUpdateSlot",
      reserveFilter: {
        dataSize: probe.LAYOUT.reserveSize,
        memcmpOffset: probe.LAYOUT.marketOffset,
        bytes: probe.MAIN_MARKET,
      },
      reserveRowsReturned: rowsReturned,
      reserveRowsParsed: classified.length,
      reserveParseErrors: reserveErrors,
      coverageDegraded,
      predicate: {
        reduced: "((status & 0x23) == 0x23) && ((status & 0x3f) != 0x3f)",
        inState: "reduced && ageSlots == 0",
        nearState: "reduced && ageSlots < 5",
        liquidationChecks: "0x23",
        allChecks: "0x3f",
      },
      stateCounts,
      statusHistogram: byStatus,
      zeroStatusReserves,
      notLiquidationUsableReserves,
      alertingReserves: alerting.map((c) => detailReserve(c.reserve, c.state)),
      reducedReserves: anyReduced.map((c) => detailReserve(c.reserve, c.state)),
      reserves: classified.map((c) => compactReserve(c.reserve, c.state)),
    },
    levelAlertCount: alerting.length,
    levelReducedCount: anyReduced.length,
  };
}

function triggerRecord(kind, level, obs, extra) {
  return {
    schema: TRIGGER_SCHEMA,
    monitor: MONITOR,
    ts: new Date().toISOString(),
    kind,
    level,
    contextSlot: obs ? obs.contextSlot : null,
    finalizedHeadAtStart: obs ? obs.finalizedHeadAtStart : null,
    ageBasis: obs ? obs.ageBasis : null,
    counts: obs ? obs.stateCounts : null,
    ...extra,
  };
}

async function runCycle({ mode, previous }) {
  const previousLevel = previous && previous.level ? previous.level : null;
  const previousDegraded = previous && typeof previous.coverageDegraded === "boolean" ? previous.coverageDegraded : null;
  const previousAlertRepeats = previous && Number.isInteger(previous.alertRepeatCount) ? previous.alertRepeatCount : 0;

  let cycle;
  try {
    cycle = await collect();
  } catch (err) {
    const message = String(err && err.message ? err.message : err).replace(NON_LOOPBACK_URL, "<redacted-url>");
    const level = LEVEL.ERROR;
    const changed = previousLevel !== level;
    const artifact = {
      schema: SCHEMA,
      monitor: MONITOR,
      generatedAt: new Date().toISOString(),
      mode,
      level,
      endpoint: { qualified: false, candidatesTested: null },
      error: message,
      observation: null,
      previousLevel,
      transition: { from: previousLevel, to: level, changed },
      triggerLog: { path: rel(TRIGGER_LOG_PATH), appended: false, kinds: [] },
      coverageDegraded: true,
      artifactSanitized: true,
    };
    const kinds = [];
    if (changed) {
      appendTrigger(triggerRecord("error", level, null, { from: previousLevel, to: level, error: message }));
      kinds.push("error");
      artifact.triggerLog.appended = true;
      artifact.triggerLog.kinds = kinds;
    }
    assertSanitized("artifact", artifact);
    writeJson(ARTIFACT_PATH, artifact);
    writeJson(STATE_PATH, {
      schema: "kamino-reduced-status-state/1",
      updatedAt: artifact.generatedAt,
      level,
      contextSlot: null,
      coverageDegraded: true,
      alertRepeatCount: 0,
    });
    return { artifact, level, appended: kinds.length > 0, kinds, error: message };
  }

  const obs = cycle.observation;
  const level = cycle.level;
  const changed = previousLevel !== level;
  const degradedChanged = previousDegraded !== null && previousDegraded !== obs.coverageDegraded;
  const alertRepeatCount = level === LEVEL.ALERT
    ? (changed ? 1 : previousAlertRepeats + 1)
    : 0;

  // Append-only trigger log: transitions and clearly-marked alerts only.
  // A clean (or unchanged) cycle appends nothing, so the log never floods.
  const kinds = [];
  const records = [];
  if (previousLevel === null) {
    records.push(triggerRecord("baseline", level, obs, { from: null, to: level }));
    kinds.push("baseline");
  } else if (changed) {
    records.push(triggerRecord("transition", level, obs, {
      from: previousLevel,
      to: level,
      alertRepeatCount: level === LEVEL.ALERT ? 1 : undefined,
      alertingReserves: obs.alertingReserves,
    }));
    kinds.push("transition");
  } else if (level === LEVEL.ALERT) {
    records.push(triggerRecord("alert", level, obs, {
      from: previousLevel,
      to: level,
      repeat: true,
      alertRepeatCount,
      alertingReserves: obs.alertingReserves,
    }));
    kinds.push("alert");
  }
  if (degradedChanged) {
    records.push(triggerRecord("coverage", level, obs, {
      from: previousLevel,
      to: level,
      coverageDegraded: obs.coverageDegraded,
      reserveRowsReturned: obs.reserveRowsReturned,
      reserveRowsParsed: obs.reserveRowsParsed,
      reserveParseErrors: obs.reserveParseErrors,
    }));
    kinds.push("coverage");
  }

  const artifact = {
    schema: SCHEMA,
    monitor: MONITOR,
    generatedAt: new Date().toISOString(),
    mode,
    level,
    endpoint: { qualified: true, candidatesTested: cycle.candidatesTested },
    observation: obs,
    alerts: obs.alertingReserves.map((r) => ({
      pubkey: r.pubkey,
      tokenName: r.tokenName,
      state: r.state,
      statusHex: r.statusHex,
      missingFlags: r.missingFlags,
      ageSlots: r.ageSlots,
      lastUpdateSlot: r.lastUpdateSlot,
    })),
    alertRepeatCount,
    previousLevel,
    transition: { from: previousLevel, to: level, changed },
    coverageDegraded: obs.coverageDegraded,
    triggerLog: { path: rel(TRIGGER_LOG_PATH), appended: records.length > 0, kinds },
    artifactSanitized: true,
  };

  for (const rec of records) appendTrigger(rec);
  assertSanitized("artifact", artifact);
  writeJson(ARTIFACT_PATH, artifact);
  writeJson(STATE_PATH, {
    schema: "kamino-reduced-status-state/1",
    updatedAt: artifact.generatedAt,
    level,
    contextSlot: obs.contextSlot,
    coverageDegraded: obs.coverageDegraded,
    alertRepeatCount,
  });

  return { artifact, level, appended: records.length > 0, kinds };
}

function parseArgs(argv) {
  const opts = { once: false, loop: false, intervalSeconds: DEFAULT_INTERVAL_SECONDS, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") opts.once = true;
    else if (a === "--loop" || a === "--watch") opts.loop = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--interval-seconds") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < MIN_INTERVAL_SECONDS || v > MAX_INTERVAL_SECONDS) {
        throw new Error(`interval-seconds-out-of-range:${MIN_INTERVAL_SECONDS}-${MAX_INTERVAL_SECONDS}`);
      }
      opts.intervalSeconds = Math.floor(v);
    } else if (a.startsWith("--interval-seconds=")) {
      const v = Number(a.split("=")[1]);
      if (!Number.isFinite(v) || v < MIN_INTERVAL_SECONDS || v > MAX_INTERVAL_SECONDS) {
        throw new Error(`interval-seconds-out-of-range:${MIN_INTERVAL_SECONDS}-${MAX_INTERVAL_SECONDS}`);
      }
      opts.intervalSeconds = Math.floor(v);
    } else {
      throw new Error(`unknown-argument:${a}`);
    }
  }
  if (!opts.once && !opts.loop) opts.once = true;
  return opts;
}

function logLine(level, artifact, appended, kinds) {
  const obs = artifact.observation;
  const counts = obs ? obs.stateCounts : { clean: 0, reduced: 0, nearState: 0, inState: 0 };
  const slot = obs ? obs.contextSlot : "-";
  const reserves = obs ? `${obs.reserveRowsParsed}/${obs.reserveRowsReturned}` : "0/0";
  console.log(
    `[kamino-reduced] ${artifact.generatedAt} level=${level} slot=${slot} reserves=${reserves} ` +
    `clean=${counts.clean} reduced=${counts.reduced} near=${counts.nearState} in-state=${counts.inState} ` +
    `appended=${appended}${kinds.length ? `(${kinds.join(",")})` : ""}`
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("usage: node tools/monitor-kamino-reduced-status.js [--once | --loop] [--interval-seconds N]");
    return;
  }

  if (opts.once) {
    const previous = readState();
    const res = await runCycle({ mode: "once", previous });
    logLine(res.level, res.artifact, res.appended, res.kinds);
    if (res.level === LEVEL.ALERT) {
      const a = res.artifact.alerts || [];
      console.log(`[kamino-reduced] ALERT: ${a.length} reserve(s) in the live same-slot reduced window`);
    }
    return;
  }

  console.error(`[kamino-reduced] durable read-only watch; interval ${opts.intervalSeconds}s. Ctrl+C to stop.`);
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });
  while (!stopping) {
    try {
      const previous = readState();
      const res = await runCycle({ mode: "loop", previous });
      logLine(res.level, res.artifact, res.appended, res.kinds);
    } catch (err) {
      console.error(`[kamino-reduced] cycle-error: ${String(err && err.message ? err.message : err).replace(NON_LOOPBACK_URL, "<redacted-url>")}`);
    }
    for (let i = 0; i < opts.intervalSeconds && !stopping; i++) await sleep(1000);
  }
  console.error("[kamino-reduced] stopped.");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[kamino-reduced] fatal: ${String(e && e.message ? e.message : e).replace(NON_LOOPBACK_URL, "<redacted-url>")}`);
    process.exitCode = 1;
  });
}

module.exports = { runCycle, collect, parseArgs, LEVEL, ARTIFACT_PATH, TRIGGER_LOG_PATH, STATE_PATH };
