#!/usr/bin/env node
"use strict";

// watch-silo-defaulting.js
//
// Read-only standing watcher for the Silo V3 defaulting-keeper instrument. The
// fork-PoC (tools/fork-poc/silo-default-keeper.js -> reports/raw/fast/fork-poc/
// silo-default-keeper.json) is event-driven: liquidationCallByDefaulting only
// fires once a tracked borrower's LTV crosses their liquidation threshold LT
// (the baseline eligibility gate is ltv > lt; PartialLiquidationByDefaulting
// then widens lt by LT_MARGIN_FOR_DEFAULTING before sizing). Nothing can be
// executed until such an event appears, so this watcher exists to detect it
// from the fresh economics artifact without touching chain state.
//
// Per cycle:
//   1. Read reports/raw/fast/silo-l-economics.json (schema silo-l-economics/v1)
//      produced by tools/scan-silo-l-economics.js. Fail closed when the scan
//      evidence is older than --max-age-ms (default 24h): status
//      STALE_SCAN_EVIDENCE, ok=false, eventFlag=null, and NO scan of its own.
//   2. Evaluate every tracked account row: in-band iff ltv > lt + margin. ltv/lt
//      are the artifact's authoritative live fields (liveLtvRaw/liveLtRaw, with
//      ltRaw as the config fallback); rows missing either field are unresolved
//      and NEVER counted in-band (fail closed). margin defaults to 0 (the exact
//      instrument eligibility gate, ltv > lt); --margin <fraction|%|wad> adds a
//      cushion above it.
//   3. Diff against the previous run's status artifact to report which accounts
//      newly entered the band (baselineDiff.newlyInBand) and which left it.
//   4. Emit one status artifact with eventFlag="DEFAULTING_EVENT_READY" whenever
//      any tracked account is in-band.
//
// --once (default) is fully offline: zero network. --rescan shells out to the
// scanner once per cycle (bounded to one invocation) to refresh the evidence.
// --probe-head optionally stamps the current mainnet head using at most
// RPC_BUDGET (10) read-only eth_calls; no other chain interaction exists.
//
// Safety: read-only. No liquidate/borrow, no signing, no transactions, no forks,
// no executors. Only read-only eth_call/eth_chainId/eth_getBlockByNumber under
// --probe-head, hard-capped at RPC_BUDGET. RPC endpoint values are process-only:
// never printed, logged, hashed, persisted, or placed on a child argv.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadRpcUrls } = require("./shared-rpc");
const { forceMonitorOnlyArtifact } = require("./monitor-minimal-env");

const WORKSPACE = path.resolve(__dirname, "..");
const ECON_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "silo-l-economics.json");
const SURFACE_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "silo-l.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "silo-default-watch-status.json");
const HISTORY = path.join(WORKSPACE, "reports", "raw", "fast", "silo-default-watch-history.json");
const CANARY_STATUS = path.join(WORKSPACE, "reports", "raw", "fast", "exploit-rearm-canary", "status.json");
const SILO_BATCH = path.join(WORKSPACE, "coordination", "live-execution-batch-silo-default.json");
const SCAN_SCRIPT = "tools/scan-silo-l-economics.js";

const SCHEMA = "silo-default-watch/v1";
const ECON_SCHEMA = "silo-l-economics/v1";
const SCANNER = "tools/watch-silo-defaulting.js";

const MAX_SCAN_AGE_MS_DEFAULT = 24 * 60 * 60 * 1000;
const MAX_SCAN_AGE_MS_MIN = 60 * 1000;
const MAX_SCAN_AGE_MS_MAX = 30 * 24 * 60 * 60 * 1000;

// Canary-loop-window deadline convention: an explicit batch expiry
// (coordination/live-execution-batch-silo-default.json:expiresAt, then the
// exploit-rearm-canary batch window) bounds a standing loop. When both are
// absent the watcher uses a documented DEFAULT_DEADLINE_DAYS window from start.
const DEFAULT_DEADLINE_DAYS = 7;
const DEFAULT_DEADLINE_DAYS_MAX = 30;

const RPC_BUDGET = 10;
const RPC_TIMEOUT_MS = 8000;
const HISTORY_LIMIT = 60;
const LOOP_MIN_SECONDS = 30;
const LOOP_MAX_SECONDS = 3600;
const RESCAN_TIMEOUT_MS = 180_000;

const EVENT_READY = "DEFAULTING_EVENT_READY";
const STATUS = Object.freeze({
  OK: "OK",
  STALE: "STALE_SCAN_EVIDENCE",
  MISSING: "SCAN_EVIDENCE_MISSING",
  INVALID: "SCAN_EVIDENCE_INVALID",
  UNDATED: "SCAN_EVIDENCE_UNDATED",
});

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) { return fallback; }
}

function argValue(args, name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
}

function finitePositive(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function bigOrNull(value) {
  if (typeof value === "bigint") return value;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try { return BigInt(value); } catch (_) { return null; }
}

// Accepts a decimal fraction ("0.01" = 1%), an explicit percent ("1%"), or a
// raw 18-decimal WAD integer. Anything unparseable falls back (default 0).
function parseWadMargin(value, fallback = 0n) {
  if (value === null || value === undefined || value === "") return fallback;
  const text = String(value).trim();
  if (/^\d{7,}$/.test(text)) { try { return BigInt(text); } catch (_) { return fallback; } }
  const normalized = text.endsWith("%") ? text.slice(0, -1) : text;
  if (!/^\d+(\.\d+)?$/.test(normalized)) return fallback;
  const [whole, fraction = ""] = normalized.split(".");
  const padded = (fraction + "0".repeat(18)).slice(0, 18);
  try { return BigInt(whole) * 10n ** 18n + BigInt(padded); } catch (_) { return fallback; }
}

function accountKey(chainId, borrower) {
  return `${Number(chainId)}:${String(borrower || "").toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// scan-evidence freshness (fail closed)
// ---------------------------------------------------------------------------
function defaultMaxAgeMs() { return MAX_SCAN_AGE_MS_DEFAULT; }

function readEconomics(file = ECON_FILE, maxAgeMs = MAX_SCAN_AGE_MS_DEFAULT) {
  if (!fs.existsSync(file)) {
    return { present: false, fresh: false, status: STATUS.MISSING, reason: "scan-evidence-missing", artifact: null, scannedAt: null, ageMs: null };
  }
  let artifact;
  try { artifact = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (_) { return { present: false, fresh: false, status: STATUS.INVALID, reason: "scan-evidence-unreadable", artifact: null, scannedAt: null, ageMs: null }; }
  if (!artifact || typeof artifact !== "object" || (artifact.schema && artifact.schema !== ECON_SCHEMA)) {
    return { present: true, fresh: false, status: STATUS.INVALID, reason: "scan-evidence-schema-mismatch", artifact, scannedAt: null, ageMs: null };
  }
  // The scanner stamps `generatedAt`; accept `scannedAt` too for forward/backward
  // compatibility. Either way the age bound is what gates freshness.
  const evidenceIso = typeof artifact.scannedAt === "string" ? artifact.scannedAt
    : (typeof artifact.generatedAt === "string" ? artifact.generatedAt : null);
  const scannedAt = Date.parse(evidenceIso);
  if (!Number.isFinite(scannedAt)) {
    return { present: true, fresh: false, status: STATUS.UNDATED, reason: "scan-evidence-undated", artifact, scannedAt: null, evidenceIso: null, ageMs: null };
  }
  const ageMs = Date.now() - scannedAt;
  const fresh = ageMs <= maxAgeMs;
  return { present: true, fresh, status: fresh ? STATUS.OK : STATUS.STALE, reason: fresh ? null : "scan-evidence-stale", artifact, scannedAt, evidenceIso, ageMs };
}

// ---------------------------------------------------------------------------
// in-band evaluation (fail closed on unresolved inputs)
// ---------------------------------------------------------------------------
function evaluateAccounts(rows, marginWad) {
  const tracked = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    const borrower = typeof row.borrower === "string" ? row.borrower : null;
    if (!borrower) continue;
    const chainId = Number.isFinite(row.chainId) ? row.chainId : 1;
    const ltv = bigOrNull(row.liveLtvRaw);
    const lt = bigOrNull(row.liveLtRaw) !== null ? bigOrNull(row.liveLtRaw) : bigOrNull(row.ltRaw);
    const liveness = typeof row.liveness === "string" ? row.liveness : null;
    let threshold = null;
    let inBand = false;
    let reason = null;
    if (ltv === null || lt === null) {
      reason = "unresolved-inputs";
    } else {
      threshold = lt + marginWad;
      inBand = ltv > threshold;
    }
    tracked.push({
      key: accountKey(chainId, borrower),
      chainId,
      market: typeof row.market === "string" ? row.market : null,
      borrower,
      debtSilo: typeof row.debtSilo === "string" ? row.debtSilo : null,
      liveness,
      ltv: ltv === null ? null : ltv.toString(),
      lt: lt === null ? null : lt.toString(),
      threshold: threshold === null ? null : threshold.toString(),
      inBand,
      resolved: ltv !== null && lt !== null,
      reason,
    });
  }
  return tracked;
}

function diffBaseline(tracked, prior) {
  const currentInBand = tracked.filter((row) => row.inBand);
  const priorRows = prior && Array.isArray(prior.inBandAccounts) ? prior.inBandAccounts : [];
  const priorKeys = new Set(priorRows
    .map((row) => (typeof row === "string" ? row : row && row.key))
    .filter((key) => typeof key === "string"));
  const currentKeys = new Set(currentInBand.map((row) => row.key));
  return {
    newlyInBand: currentInBand.filter((row) => !priorKeys.has(row.key)),
    clearedFromBand: [...priorKeys].filter((key) => !currentKeys.has(key)),
    priorInBandCount: priorKeys.size,
    previousGeneratedAt: prior && typeof prior.generatedAt === "string" ? prior.generatedAt : null,
    previousScannedAt: prior && prior.scanEvidence && typeof prior.scanEvidence.scannedAt === "string" ? prior.scanEvidence.scannedAt : null,
    baselineSource: prior
      ? "reports/raw/fast/silo-default-watch-status.json (previous watcher run)"
      : "none-first-run",
    baselineSemantics: "an account is newly-in-band when it is in-band now and was not in the previous status artifact",
  };
}

// ---------------------------------------------------------------------------
// deadline (canary-loop-window convention)
// ---------------------------------------------------------------------------
function asIsoOrNull(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function resolveDeadline(options, startedMs) {
  const days = finitePositive(options.deadlineDays, DEFAULT_DEADLINE_DAYS, DEFAULT_DEADLINE_DAYS_MAX);
  const defaultExpiresMs = startedMs + days * 24 * 60 * 60 * 1000;

  const batch = readJson(SILO_BATCH, null);
  const batchExpires = batch ? asIsoOrNull(batch.expiresAt) : null;
  if (batchExpires) {
    return { source: "coordination/live-execution-batch-silo-default.json:expiresAt", expiresAt: batchExpires, expiresMs: Date.parse(batchExpires), defaultDays: days };
  }

  const canary = readJson(CANARY_STATUS, null);
  const canaryBatch = canary && canary.batch ? canary.batch : null;
  const canaryExpires = canaryBatch ? (asIsoOrNull(canaryBatch.expiresAt) || asIsoOrNull(canaryBatch.monitorEndsAt)) : null;
  if (canaryExpires) {
    return { source: "reports/raw/fast/exploit-rearm-canary/status.json:batch window", expiresAt: canaryExpires, expiresMs: Date.parse(canaryExpires), defaultDays: days };
  }

  return { source: "default-window", expiresAt: new Date(defaultExpiresMs).toISOString(), expiresMs: defaultExpiresMs, defaultDays: days };
}

// ---------------------------------------------------------------------------
// optional bounded read-only head probe (--probe-head only)
// ---------------------------------------------------------------------------
function buildRpcPool() {
  const pool = [];
  const seen = new Set();
  let urls = [];
  try { urls = loadRpcUrls({ maxCandidates: 8 }) || []; } catch (_) { urls = []; }
  for (const url of urls) {
    if (typeof url !== "string" || !/^https:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    pool.push(url);
  }
  return pool;
}

async function probeHead() {
  const pool = buildRpcPool();
  let calls = 0;
  const call = async (url, method, params) => {
    if (calls >= RPC_BUDGET) throw new Error("rpc-budget-exhausted");
    calls += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: "2.0", id: calls, method, params }),
      });
      const body = await response.json();
      if (body && body.error) throw new Error("rpc-error");
      return body ? body.result : null;
    } finally {
      clearTimeout(timer);
    }
  };
  for (const url of pool) {
    try {
      const chainId = await call(url, "eth_chainId", []);
      if (chainId !== "0x1") continue;
      const block = await call(url, "eth_getBlockByNumber", ["latest", false]);
      if (block && typeof block.number === "string" && /^0x[0-9a-f]+$/i.test(block.number)) {
        return { ok: true, calls, blockNumber: Number(BigInt(block.number)), blockHash: typeof block.hash === "string" ? block.hash : null };
      }
    } catch (_) {
      if (calls >= RPC_BUDGET) break;
    }
  }
  return { ok: false, calls, blockNumber: null, blockHash: null };
}

// ---------------------------------------------------------------------------
// rescan (one bounded scanner invocation per cycle)
// ---------------------------------------------------------------------------
function rescanOnce() {
  let result;
  try {
    result = spawnSync(process.execPath, [SCAN_SCRIPT], {
      cwd: WORKSPACE,
      encoding: "utf8",
      timeout: RESCAN_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (_) {
    return { ran: true, ok: false, exitCode: null, error: "spawn-failed" };
  }
  const exitCode = typeof result.status === "number" ? result.status : null;
  return {
    ran: true,
    ok: result.error === undefined && exitCode === 0,
    exitCode,
    error: result.error ? String(result.error.code || "spawn-failed") : null,
  };
}

// ---------------------------------------------------------------------------
// one cycle
// ---------------------------------------------------------------------------
async function runCycle(context) {
  const { cycle, options, startedMs, deadline, prior } = context;
  const generatedAt = new Date().toISOString();

  let rescan = null;
  let econ = readEconomics(ECON_FILE, options.maxAgeMs);
  if (options.rescan && (!econ.fresh || options.forceRescan)) {
    rescan = rescanOnce();
    econ = readEconomics(ECON_FILE, options.maxAgeMs);
  }

  let head = null;
  if (options.probeHead) {
    try { head = await probeHead(); } catch (_) { head = { ok: false, calls: 0, blockNumber: null, blockHash: null }; }
  }

  const tracked = econ.present && econ.artifact && Array.isArray(econ.artifact.rows)
    ? evaluateAccounts(econ.artifact.rows, options.marginWad)
    : [];
  const inBand = tracked.filter((row) => row.inBand);
  const baselineDiff = diffBaseline(tracked, prior);
  const ok = econ.status === STATUS.OK;
  const eventFlag = ok && inBand.length > 0 ? EVENT_READY : null;

  const rescanRequests = rescan && econ.artifact && econ.artifact.budget && Number.isFinite(econ.artifact.budget.requests)
    ? econ.artifact.budget.requests
    : null;

  return {
    schema: SCHEMA,
    generatedAt,
    scannedAt: generatedAt,
    scanner: SCANNER,
    scope: "Read-only Silo V3 defaulting-keeper event watcher over the economics artifact",
    mode: options.once ? "once" : "loop",
    cycle,
    startedAt: new Date(startedMs).toISOString(),
    ok,
    status: econ.status,
    reason: econ.reason,
    eventFlag,
    inBandAccounts: inBand,
    baselineDiff,
    trackedAccounts: tracked,
    counts: {
      tracked: tracked.length,
      inBand: inBand.length,
      newlyInBand: baselineDiff.newlyInBand.length,
      clearedFromBand: baselineDiff.clearedFromBand.length,
      unresolved: tracked.filter((row) => !row.resolved).length,
    },
    scanEvidence: {
      artifact: "reports/raw/fast/silo-l-economics.json",
      surfaceArtifact: "reports/raw/fast/silo-l.json",
      present: econ.present,
      fresh: econ.fresh,
      status: econ.status,
      scannedAt: econ.evidenceIso || null,
      ageMs: econ.ageMs === undefined ? null : econ.ageMs,
      maxAgeMs: options.maxAgeMs,
      schema: econ.artifact ? (econ.artifact.schema || null) : null,
      rows: econ.artifact && Array.isArray(econ.artifact.rows) ? econ.artifact.rows.length : null,
      surfaceBandNote: "economics rows are the scanner's authoritative live re-derivation; the surface's nearLt band decode is known-inverted and is not trusted here",
    },
    deadline: {
      source: deadline.source,
      expiresAt: deadline.expiresAt,
      remainingMs: Math.max(0, deadline.expiresMs - Date.now()),
      defaultDays: deadline.defaultDays,
      convention: "canary-loop-window: silo batch expiry, else exploit-rearm-canary batch window, else DEFAULT_DEADLINE_DAYS",
    },
    rescan: rescan ? { ...rescan, requests: rescanRequests } : null,
    head: head ? { probed: true, ok: head.ok, blockNumber: head.blockNumber, blockHash: head.blockHash, rpcCalls: head.calls } : { probed: false },
    readBudget: {
      budget: RPC_BUDGET,
      calls: head ? head.calls : 0,
      note: "read-only eth_chainId / eth_getBlockByNumber only; endpoint values are never stored",
    },
    config: {
      marginWad: options.marginWad.toString(),
      maxScanAgeMs: options.maxAgeMs,
      loopSeconds: options.loopSeconds,
      maxRuns: options.maxRuns,
      rescan: options.rescan === true,
      probeHead: options.probeHead === true,
    },
    producer_health: {
      scanEvidencePresent: econ.present,
      scanEvidenceFresh: econ.fresh,
      scanEvidenceAgeMs: econ.ageMs === undefined ? null : econ.ageMs,
      trackedAccounts: tracked.length,
      inBandAccounts: inBand.length,
      rpcQualified: head ? head.ok === true : false,
      requests: head ? head.calls : 0,
      failClosed: true,
      eventFlag,
    },
    safety: {
      readOnly: true,
      rpcInventoryRead: options.probeHead === true,
      rpcUrlsStored: false,
      endpointValuesPersisted: false,
      privateKeysRead: false,
      signedActions: false,
      borrowCalls: false,
      liquidateCalls: false,
      exploitExecuteCalls: false,
      transactions: false,
      forkTransactions: false,
      routePositive: false,
    },
  };
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------
function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) { /* already renamed */ }
  }
}

function persist(status) {
  let safe;
  try { safe = forceMonitorOnlyArtifact(status); }
  catch (_) { safe = status; }
  atomicWriteJson(OUT, safe);
  const existing = readJson(HISTORY, []);
  const history = Array.isArray(existing) ? existing : [];
  atomicWriteJson(HISTORY, [...history.slice(-(HISTORY_LIMIT - 1)), safe]);
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------
function printStatus(status, quiet) {
  const prefix = status.ok ? (status.eventFlag ? "EVENT" : "WATCH") : "FAILED";
  process.stdout.write(
    `[${prefix} cycle=${status.cycle}] status=${status.status} event=${status.eventFlag || "none"} `
    + `tracked=${status.counts.tracked} inBand=${status.counts.inBand} newly=${status.counts.newlyInBand} `
    + `scanAgeMs=${status.scanEvidence.ageMs ?? "n/a"}${status.reason ? ` reason=${status.reason}` : ""}\n`,
  );
  if (quiet) return;
  for (const row of status.inBandAccounts) {
    process.stdout.write(
      `  ${row.key} ltv=${row.ltv} lt=${row.lt} threshold=${row.threshold} liveness=${row.liveness || "n/a"}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// arguments + main
// ---------------------------------------------------------------------------
function parseArgs(args) {
  const once = args.includes("--once") || !args.includes("--loop");
  const quiet = args.includes("--quiet");
  const rescan = args.includes("--rescan");
  const forceRescan = args.includes("--rescan-force");
  const probeHead = args.includes("--probe-head");
  const loopSeconds = args.includes("--loop")
    ? Math.min(LOOP_MAX_SECONDS, Math.max(LOOP_MIN_SECONDS, Number(argValue(args, "--loop") || "300") || 300))
    : 300;
  const maxRunsRaw = argValue(args, "--max-runs");
  const maxRuns = maxRunsRaw !== null ? Math.max(1, Number(maxRunsRaw) || 1) : Number.MAX_SAFE_INTEGER;
  const marginWad = parseWadMargin(argValue(args, "--margin"), 0n);
  const maxAgeMs = finitePositive(argValue(args, "--max-age-ms"), MAX_SCAN_AGE_MS_DEFAULT, MAX_SCAN_AGE_MS_MAX);
  const deadlineDays = finitePositive(argValue(args, "--deadline-days"), DEFAULT_DEADLINE_DAYS, DEFAULT_DEADLINE_DAYS_MAX);
  const out = argValue(args, "--out") || OUT;
  return { once, quiet, rescan, forceRescan, probeHead, loopSeconds, maxRuns, marginWad, maxAgeMs: Math.max(maxAgeMs, MAX_SCAN_AGE_MS_MIN), deadlineDays, out };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const startedMs = Date.now();
  const deadline = resolveDeadline(options, startedMs);
  const targetsOut = path.resolve(options.out);

  if (!options.quiet) {
    process.stdout.write("Silo V3 read-only defaulting-keeper watch\n");
    process.stdout.write(`mode=${options.once ? "once" : "loop"} marginWad=${options.marginWad} maxScanAgeMs=${options.maxAgeMs} deadline=${deadline.source}@${deadline.expiresAt}\n`);
    process.stdout.write("Safety: read-only, no signing, no borrow/liquidate, no transactions. Endpoints process-only.\n");
  }

  let finalStatus = null;
  for (let cycle = 1; cycle <= options.maxRuns; cycle += 1) {
    if (!options.once && Date.now() >= deadline.expiresMs) {
      process.stdout.write("Canary-loop-window deadline reached (read-only stop; no action taken).\n");
      break;
    }
    const prior = readJson(OUT, null);
    let status;
    try {
      status = await runCycle({ cycle, options, startedMs, deadline, prior });
    } catch (error) {
      status = {
        schema: SCHEMA, generatedAt: new Date().toISOString(), scannedAt: new Date().toISOString(),
        scanner: SCANNER, mode: options.once ? "once" : "loop", cycle, startedAt: new Date(startedMs).toISOString(),
        ok: false, status: STATUS.INVALID, reason: "cycle-failed", eventFlag: null,
        inBandAccounts: [], baselineDiff: { newlyInBand: [], clearedFromBand: [], priorInBandCount: 0 },
        trackedAccounts: [], counts: { tracked: 0, inBand: 0, newlyInBand: 0, clearedFromBand: 0, unresolved: 0 },
        scanEvidence: { artifact: "reports/raw/fast/silo-l-economics.json", present: false, fresh: false, status: STATUS.INVALID },
        producer_health: { failClosed: true, requests: 0 }, safety: { readOnly: true },
      };
    }
    finalStatus = status;

    try {
      if (targetsOut === path.resolve(OUT)) persist(status);
      else atomicWriteJson(targetsOut, status);
    } catch (_) {
      process.exitCode = 1;
      printStatus(status, options.quiet);
      return;
    }
    printStatus(status, options.quiet);

    if (options.once) break;
    if (cycle >= options.maxRuns) break;
    if (Date.now() + options.loopSeconds * 1000 >= deadline.expiresMs) {
      process.stdout.write("Canary-loop-window deadline reached (read-only stop; no action taken).\n");
      break;
    }
    await delay(options.loopSeconds * 1000);
  }

  if (finalStatus && !options.quiet) {
    process.stdout.write(`No Silo V3 defaulting action. Status artifact: ${path.relative(WORKSPACE, OUT).split(path.sep).join("/")}\n`);
  }
  // --once always exits 0: a stale/missing evidence classification is a normal,
  // honest observation, not a tool failure.
  if (finalStatus && finalStatus.ok === false && !options.once && process.exitCode !== 1) process.exitCode = 0;
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write("watch-silo-defaulting failed closed\n");
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE, ECON_FILE, SURFACE_FILE, OUT, HISTORY, CANARY_STATUS, SILO_BATCH, SCAN_SCRIPT,
  SCHEMA, ECON_SCHEMA, SCANNER, STATUS, EVENT_READY,
  MAX_SCAN_AGE_MS_DEFAULT, DEFAULT_DEADLINE_DAYS, RPC_BUDGET, HISTORY_LIMIT,
  atomicWriteJson, accountKey, bigOrNull, buildRpcPool, diffBaseline, evaluateAccounts,
  parseArgs, parseWadMargin, persist, probeHead, readEconomics, rescanOnce,
  resolveDeadline, runCycle, main,
};
