#!/usr/bin/env node
"use strict";

// watch-euler-head-fastlane.js - chain-head, fail-closed, READ-ONLY Euler fast-lane watcher.
//
// WHY THIS EXISTS
//   The standing gate ladder (fresh watcher -> fresh valuation -> fresh rehearsal <=10m
//   -> sign) is consistently losing the race: by the time the ladder completes, the top
//   violator rows are consumed by faster searchers (dry-run vs executor #3 reports
//   `no-feasible-row:row-already-eaten` every attempt; watch-status shows 2 live
//   liquidatable rows at chain head while the ladder is still finalizing).
//
// WHAT A CHAIN-HEAD LANE CHANGES (mechanism)
//   The finalized-pin ladder pins every artifact to a FIXED scanner block and re-runs a
//   per-event rehearsal before each fire. The fast lane instead observes the SAME
//   surfaces at chain-tip and decides, deterministically, whether an already-armed
//   executor fleet WOULD win if it fired right now. Its decision discipline is:
//     (1) chain-tip block-head observation (headBlock > scanner pin by >= 1 block),
//     (2) a PRE-ARMED determinate pair (the row -> executor mapping is fixed by the
//         deterministic-pair-prediction, not re-derived per event),
//     (3) a same-block fire intention (the exit route is fixed by the pin-consistent
//         artifact, so the fire is decided inside the head block it was observed at),
//     (4) rehearsal freshness satisfied at ARM time (once, when the executor is
//         configured), NOT re-satisfied per event,
//     (5) a fresh pre-quoted minOut floor per fired event, computed from the fresh
//         valuation artifact's route math -- no live-quote re-fetch at fire.
//
// HONEST TRADEOFF (recorded in the artifact, not hidden)
//   The per-event route quote is NOT re-fetched: it is read from the fresh valuation
//   artifact (routePositive + buildable swap path + the artifact's conservative exit
//   haircut as the price-impact proxy). The artifact carries no explicit `priceImpactBps`
//   field, so the same-block exit-impact check uses `row.haircutBps` (25 direct / 100
//   two-hop) as the deterministic proxy, compared against the conservative 200 bps floor.
//   A live re-quote would change nothing about the fire/no-fire decision discipline and
//   is deliberately out of scope for this lane.
//
// SAFETY: read-only. No private keys (never reads .env*), no signing, no broadcast, no
//   transactions, no funds movement, no fork. RPC material is process-only, never
//   printed or persisted. --run only wires a LIVE READ path (chain-tip head fetch).
//
// CLI:
//   node tools/watch-euler-head-fastlane.js            # DEFAULT OFFLINE plan mode -> exit 0
//   node tools/watch-euler-head-fastlane.js --plan      # same
//   node tools/watch-euler-head-fastlane.js --run --input <scenario.json>   # live read path
//   node tools/watch-euler-head-fastlane.js --watch-once   # autonomous standing pass -> exit 0 always

const fs = require("node:fs");
const path = require("node:path");
const { getAddress } = require("./node_modules/ethers");
const { loadRpcUrls, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_PLAN = path.join(WORKSPACE, "reports", "raw", "fast", "euler-fastlane-plan.json");
const OUT_OBS = path.join(WORKSPACE, "reports", "raw", "fast", "euler-fastlane-observation.json");
const OUT_STATUS = path.join(WORKSPACE, "reports", "raw", "fast", "euler-fastlane-status.json");
const DEFAULT_VALUATION = path.join(WORKSPACE, "reports", "raw", "fast", "euler-l-valuation.json");
const DEFAULT_WATCH = path.join(WORKSPACE, "reports", "raw", "fast", "euler-l-watch-status.json");
const DEFAULT_SURFACE = path.join(WORKSPACE, "reports", "raw", "fast", "euler-l.json");

const SCHEMA_PLAN = "euler-head-fastlane-plan/v1";
const SCHEMA_OBS = "euler-head-fastlane-observation/v1";
const SCHEMA_WATCH = "euler-fastlane-watch/v1";

const PRICE_IMPACT_FLOOR_BPS = 200;   // conservative same-block exit-impact ceiling
const MIN_OUT_HAIRCUT_BPS = 98n;      // minOut floor = quoted * 0.98 (mirrors trigger runner)
const FRESH_VALUATION_MS = 10 * 60 * 1000;
const FRESH_WATCH_MS = 5 * 60 * 1000;
const MAX_REQUESTS = 12;

// --watch-once autonomous evidence caps (watch <=15m, valuation <=30m) and the
// deliberately tiny chain-head read budget (<=3 reads) for the standing pass.
const WATCH_ONCE_WATCH_CAP_MS = 15 * 60 * 1000;
const WATCH_ONCE_VALUATION_CAP_MS = 30 * 60 * 1000;
const MAX_WATCH_ONCE_REQUESTS = 3;
const CLOCK_SKEW_MS = 60_000;

// Armed executor fleet (deployed FlashLiquidateEulerEVK instances). `pair` is the
// one-time setEvcConfiguration pair once consumed; null => still FRESH (its
// deterministic lane is the top-ranked honest pick, assigned at arm time).
// Sourced from coordination/live-execution-batch-euler-executor-deploy*.json and the
// offensive plan section 6. Overridable via scenarioInput.armedExecutors.
const DEFAULT_FLEET = [
  { label: "EULER-LIQ-V3", address: "0x876ceed4a83ef6bc219fd14c239a0f54895d4ada", pair: null },
  { label: "EULER-LIQ-V3-2", address: "0x22760de82a1ebf0c9467e8e15684a03b2fa8dd58", pair: { liabilityVault: "0x83c266bdf990574a05ee62831a266a3891817b5b", collateralVault: "0xe1ce9af672f8854845e5474400b6ddc7ae458a10" } },
  { label: "EULER-LIQ-V3-3", address: "0xd2e340b1ce33453509d34e8a8eee63e67b442c29", pair: null },
];

const SAFETY = Object.freeze({
  readOnly: true,
  privateKeysRead: false,
  envFilesRead: false,
  signedActions: false,
  signedTransactions: false,
  broadcast: false,
  fundsMovement: false,
  forkTransactions: false,
  endpointMaterialPersisted: false,
});

// --watch-once autonomous armed set: fresh executor #3 + the deployed fleet F1/F2.
// All three are UNCONFIGURED (pair:null) so predictPairs assigns them the
// deterministic fresh top-net picks in this order.
const WATCH_DEFAULT_FLEET = [
  { label: "EULER-LIQ-V3-3", address: "0xd2e340b1ce33453509d34e8a8eee63e67b442c29", pair: null },
  { label: "EULER-LIQ-V3-F1", address: "0xb3219646e7b93ddc6cb8e10d6d80782f42f758fa", pair: null },
  { label: "EULER-LIQ-V3-F2", address: "0xb6ae06b25bf329e02d8cafd168e38aafd0748f99", pair: null },
];

const WATCH_SAFETY = Object.freeze({ noSigning: true, noBroadcast: true, noKeyReads: true });

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* already renamed */ }
  }
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return { present: false, value: null, reason: "missing" };
    return { present: true, value: JSON.parse(fs.readFileSync(file, "utf8")), reason: null };
  } catch (_) { return { present: true, value: null, reason: "unreadable" }; }
}

function normAddr(value) {
  try { return getAddress(String(value)).toLowerCase(); } catch (_) { return null; }
}
function bigOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  try { return BigInt(value); } catch (_) { return null; }
}
function ageMs(iso) { const t = Date.parse(iso); return Number.isFinite(t) ? Date.now() - t : null; }
function freshWithin(age, capMs) { return age !== null && Number.isFinite(age) && age >= -CLOCK_SKEW_MS && age <= capMs; }
function isQuantity(v) { return typeof v === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v); }
function isHash(v) { return typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v); }

// ---------------------------------------------------------------------------
// deterministic-pair-prediction: which valuation rows map to which executors
// ---------------------------------------------------------------------------
function routeRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.routePositive === true
    && Array.isArray(r.swapHops) && r.swapHops.length >= 2 && r.swapTarget);
}
function byNetDesc(a, b) {
  const x = bigOrNull(a.netUsdcRaw); const y = bigOrNull(b.netUsdcRaw);
  if (x === null && y === null) return String(a.violator || "").localeCompare(String(b.violator || ""));
  if (x === null) return 1;
  if (y === null) return -1;
  if (x === y) return String(a.violator || "").localeCompare(String(b.violator || ""));
  return x < y ? 1 : -1;
}
function pairKey(row) {
  const l = normAddr(row.vault); const c = normAddr(row.collateralAsset);
  return l && c ? `${l}:${c}` : null;
}
// Deterministic: pair-locked lanes consume their exact pair first; FRESH lanes then
// consume the remaining honest top picks in fleet order (net desc, violator tie-break).
function predictPairs(rows, fleet) {
  const sorted = routeRows(rows).slice().sort(byNetDesc);
  const taken = new Set();
  const mapping = [];
  for (const ex of fleet) {
    if (ex.pair) {
      const want = `${normAddr(ex.pair.liabilityVault)}:${normAddr(ex.pair.collateralVault)}`;
      const hit = sorted.find((r) => !taken.has(r) && pairKey(r) === want);
      if (hit) { taken.add(hit); mapping.push({ executor: ex.label, address: ex.address, mode: "pair-locked", violator: hit.violator, pairKey: want }); }
      else mapping.push({ executor: ex.label, address: ex.address, mode: "pair-locked", violator: null, pairKey: want });
    }
  }
  for (const ex of fleet) {
    if (ex.pair) continue;
    const hit = sorted.find((r) => !taken.has(r));
    if (hit) { taken.add(hit); mapping.push({ executor: ex.label, address: ex.address, mode: "fresh-top-pick", violator: hit.violator, pairKey: pairKey(hit) }); }
    else mapping.push({ executor: ex.label, address: ex.address, mode: "fresh-top-pick", violator: null, pairKey: null });
  }
  return { sorted, mapping };
}

// ---------------------------------------------------------------------------
// per-row deterministic feasibility (artifact-only; no live re-quote)
// ---------------------------------------------------------------------------
function impactProxyBps(row) {
  if (row && typeof row.priceImpactBps === "number" && Number.isFinite(row.priceImpactBps)) return row.priceImpactBps;
  if (row && row.haircutBps !== null && row.haircutBps !== undefined && Number.isFinite(Number(row.haircutBps))) return Number(row.haircutBps);
  return null;
}
function evaluateRow(row, executor, valuation, headBlock) {
  const net = bigOrNull(row.netUsdcRaw);
  const gas = bigOrNull(row.gasCeilingUsdcRaw) ?? 0n;
  const quotedOut = bigOrNull(row.expectedOutUsdcRaw);
  const impact = impactProxyBps(row);

  if (!executor) return { decision: "skip", reason: "no-armed-executor-covers-pair" };
  if (!routeRows([row]).length) return { decision: "skip", reason: "no-buildable-route-in-artifact" };
  if (net === null) return { decision: "skip", reason: "netUsdcRaw-missing" };
  const minProfit = (net * MIN_OUT_HAIRCUT_BPS) / 100n - gas; // conservative pre-quoted floor (minOut >= quoted*0.98)
  if (quotedOut === null || quotedOut <= 0n) return { decision: "skip", reason: "quoted-out-missing" };
  if (minProfit <= 0n) return { decision: "skip", reason: `minProfit-floor-nonpositive(${minProfit})` };
  if (impact === null) return { decision: "win-unverifiable", reason: "impact-proxy-unavailable" };
  if (impact > PRICE_IMPACT_FLOOR_BPS) return { decision: "skip", reason: `route-impact-exceeds-floor(${impact}>${PRICE_IMPACT_FLOOR_BPS}bps)` };

  const pin = valuation && valuation.pin && Number.isInteger(valuation.pin.number) ? valuation.pin.number : null;
  if (typeof headBlock !== "number" || pin === null) return { decision: "win-unverifiable", reason: "head-or-pin-unresolved" };
  if (headBlock <= pin) return { decision: "win-unverifiable", reason: `head-not-beyond-scanner-pin(${headBlock}<=${pin})` };
  return { decision: "win-probable", reason: `pair+route+impact<=${PRICE_IMPACT_FLOOR_BPS}bps+floor+head>pin` };
}

// Chain-tip head over the workspace's qualified-RPC convention: resolveRpc(1, null,
// {capability:'read'}) selects a chain-1 READ-qualified endpoint (its internal
// qualification probes use shared-rpc's own transport and do NOT consume this tool's
// tiny request budget). We then spend at most 2 budgeted head reads, excluding a
// failed endpoint each round, before returning an honest unresolved verdict.
async function readHeadBlock(transport) {
  const attempts = [];
  const tried = new Set();
  let pool = [];
  try { pool = loadRpcUrls({ maxCandidates: 8 }) || []; } catch (_) { pool = []; }
  for (let n = 0; n < 2; n += 1) {
    const remaining = pool.filter((u) => !tried.has(u));
    if (!remaining.length) { attempts.push({ attempt: n + 1, reason: "candidate-pool-exhausted" }); break; }
    let url = null;
    try { url = await resolveRpc(1, remaining, { capability: "read" }); } catch (_) { url = null; }
    if (!url) { attempts.push({ attempt: n + 1, reason: "no-qualified-endpoint" }); break; }
    tried.add(url);
    try {
      const head = await transport.rpc(url, "eth_getBlockByNumber", ["latest", false]);
      if (!head || !isHash(head.hash) || !isQuantity(head.number)) {
        attempts.push({ attempt: n + 1, reason: "head-shape-failure" });
        continue;
      }
      attempts.push({ attempt: n + 1, reason: "ok" });
      return { headBlock: Number(BigInt(head.number)), headHash: head.hash, attempts };
    } catch (error) {
      attempts.push({ attempt: n + 1, reason: String((error && error.message) || error).slice(0, 60) });
    }
  }
  return { headBlock: null, headHash: null, attempts };
}

// ---------------------------------------------------------------------------
// plan (default OFFLINE mode; no network)
// ---------------------------------------------------------------------------
function buildPlan() {
  return {
    schema: SCHEMA_PLAN,
    scannedAt: new Date().toISOString(),
    mode: "plan-offline",
    scanner: "tools/watch-euler-head-fastlane.js",
    mechanism: {
      summary: "OBSERVE the same surfaces at chain-tip and decide, deterministically, whether an already-armed executor fleet WOULD win if it fired right now. The tool never signs.",
      differenceFromFinalizedPinLadder:
        "The finalized-pin ladder pins artifacts to a fixed scanner block and re-runs a per-event rehearsal before each fire (fresh watcher -> fresh valuation -> fresh rehearsal <=10m -> sign), which loses the race (top rows eaten: no-feasible-row:row-already-eaten). The fast lane observes at the chain-tip head block instead and fires on a pre-armed determinate pair.",
      decisionDiscipline: [
        "chain-tip block head observation: headBlock > scanner pin by >= 1 block",
        "pre-armed determinate pair: row -> executor mapping is fixed by deterministic-pair-prediction, not re-derived per event",
        "same-block fire intention: exit route fixed by the pin-consistent artifact, decided inside the observed head block",
        "rehearsal freshness satisfied at ARM time (once, when the executor pair is configured), NOT per event",
        "fresh pre-quoted minOut floor per fired event, computed from the fresh valuation artifact's route math (no live-quote re-fetch at fire)",
      ],
    },
    feasibilityChecks: [
      { id: "f1", name: "buildable route in artifact", detail: "valuation row has routePositive:true + swapHops.length>=2 + swapTarget" },
      { id: "f2", name: "armed executor covers pair", detail: "an armed executor is pair-locked to the row's (vault,collateralAsset) or is a fresh lane assigned the deterministic top pick" },
      { id: "f3", name: "fresh route quote exists in artifact", detail: "route quote is read from the fresh valuation artifact, NOT re-fetched (recorded tradeoff)" },
      { id: "f4", name: "same-block exit impact inside floor", detail: `impact proxy (row.priceImpactBps ?? row.haircutBps) <= ${PRICE_IMPACT_FLOOR_BPS} bps` },
      { id: "f5", name: "pre-quoted minOut/minProfit floor positive", detail: "minOut >= quoted*0.98; minProfit = netUsdc - gasCeiling > 0" },
      { id: "f6", name: "head beyond scanner pin", detail: "headBlock > valuation.pin.number; else win-unverifiable" },
    ],
    deterministicPairPrediction: {
      spec: "Sort buildable routePositive rows by netUsdcRaw desc (tie-break violator asc). Pair-locked executors consume their exact configured pair first. FRESH executors then consume the remaining top picks in fleet order. Output maps each executor to at most one violator row deterministically.",
      fleet: DEFAULT_FLEET,
    },
    inputShape: {
      runFlag: "--run --input <scenario.json>",
      scenario: {
        headBlock: "optional integer; when absent the tool reads chain-tip over a qualified keyless RPC (LIVE READ path)",
        scenarioInput: {
          valuationPath: "optional; default reports/raw/fast/euler-l-valuation.json (fresh <=10m)",
          watchStatusPath: "optional; default reports/raw/fast/euler-l-watch-status.json (fresh <=5m)",
          surfacePath: "optional; default reports/raw/fast/euler-l.json",
          priceImpactFloorBps: "optional; default 200",
          armedExecutors: "optional; default DEFAULT_FLEET [{label,address,pair:{liabilityVault,collateralVault}|null}]",
        },
      },
    },
    output: { plan: "reports/raw/fast/euler-fastlane-plan.json", observation: "reports/raw/fast/euler-fastlane-observation.json" },
    safety: SAFETY,
  };
}

// ---------------------------------------------------------------------------
// run (LIVE READ path; fail-closed without ctx.input)
// ---------------------------------------------------------------------------
function createTransport(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 10_000;
  const maxRequests = Number.isSafeInteger(options.maxRequests) && options.maxRequests > 0 ? options.maxRequests : MAX_REQUESTS;
  let count = 0;
  async function rpc(url, method, params) {
    if (count >= maxRequests) throw new Error("request-budget-exhausted");
    count += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: "2.0", id: count, method, params }),
      });
      const body = await response.json();
      if (body && body.error) throw new Error("rpc-error");
      if (!body || body.result === undefined) throw new Error("rpc-shape-failure");
      return body.result;
    } finally { clearTimeout(timer); }
  }
  return { rpc, get count() { return count; } };
}

async function runFastlane(ctx, transport) {
  const input = ctx.input && typeof ctx.input === "object" ? ctx.input : {};
  const scenario = input.scenarioInput && typeof input.scenarioInput === "object" ? input.scenarioInput : {};
  const valuationFile = scenario.valuationPath || DEFAULT_VALUATION;
  const watchFile = scenario.watchStatusPath || DEFAULT_WATCH;
  const surfaceFile = scenario.surfacePath || DEFAULT_SURFACE;
  const floor = Number.isFinite(scenario.priceImpactFloorBps) ? scenario.priceImpactFloorBps : PRICE_IMPACT_FLOOR_BPS;
  const fleet = Array.isArray(scenario.armedExecutors) && scenario.armedExecutors.length ? scenario.armedExecutors : DEFAULT_FLEET;

  const valuationR = readJson(valuationFile);
  const watchR = readJson(watchFile);
  const valuation = valuationR.value;
  const rows = valuation && Array.isArray(valuation.rows) ? valuation.rows : [];
  const watchAge = watchR.value ? ageMs(watchR.value.generatedAt) : null;
  const valAge = valuation ? ageMs(valuation.generatedAt) : null;

  // Chain-tip head: supplied headBlock (offline-testable) else LIVE READ over a qualified keyless RPC.
  let headBlock = Number.isInteger(input.headBlock) ? input.headBlock : null;
  let headHash = null;
  let headSource = headBlock !== null ? "supplied" : null;
  let headAttempts = headBlock !== null ? [{ attempt: 0, reason: "supplied" }] : null;
  if (headBlock === null) {
    const live = await readHeadBlock(transport);
    headBlock = live.headBlock; headHash = live.headHash;
    headAttempts = live.attempts;
    headSource = "chain-tip-rpc";
  }

  const { mapping } = predictPairs(rows, fleet);
  const executorByViolator = new Map();
  for (const m of mapping) if (m.violator) executorByViolator.set(normAddr(m.violator), m);

  const perRow = routeRows(rows).slice().sort(byNetDesc).map((row) => {
    const ex = executorByViolator.get(normAddr(row.violator)) || null;
    const evald = evaluateRow(row, ex, valuation, typeof headBlock === "number" ? headBlock : null);
    return {
      violator: row.violator,
      vault: row.vault,
      collateralAsset: row.collateralAsset,
      netUsdcRaw: row.netUsdcRaw,
      route: { routePositive: true, swapTarget: row.swapTarget || null, hops: row.swapHops ? row.swapHops.length : 0 },
      impactProxyBps: impactProxyBps(row),
      executor: ex ? { label: ex.executor, address: ex.address, mode: ex.mode } : null,
      decision: evald.decision,
      reason: evald.reason,
    };
  });

  const winProbable = perRow.filter((r) => r.decision === "win-probable").length;
  const unverifiable = perRow.filter((r) => r.decision === "win-unverifiable").length;
  const fired = winProbable > 0 ? "win-probable" : (unverifiable > 0 ? "win-unverifiable" : "skip");

  const observation = {
    schema: SCHEMA_OBS,
    observedAt: new Date().toISOString(),
    scanner: "tools/watch-euler-head-fastlane.js",
    mode: "run-live-read",
    fired,
    headBlock,
    headHash,
    headSource,
    headAttempts,
    scannerPin: valuation && valuation.pin ? valuation.pin.number : null,
    freshness: {
      valuationPath: path.relative(WORKSPACE, valuationFile).split(path.sep).join("/"),
      valuationFresh: valAge !== null && valAge >= -60_000 && valAge <= FRESH_VALUATION_MS,
      valuationAgeMs: valAge,
      watchFresh: watchAge !== null && watchAge >= -60_000 && watchAge <= FRESH_WATCH_MS,
      watchAgeMs: watchAge,
      surfacePath: path.relative(WORKSPACE, surfaceFile).split(path.sep).join("/"),
    },
    priceImpactFloorBps: floor,
    totals: { routeRows: perRow.length, winProbable, unverifiable, skipped: perRow.length - winProbable - unverifiable },
    rows: perRow,
    budget: { requests: transport.count, maxRequests: MAX_REQUESTS },
    safety: SAFETY,
    notes: [
      "route quote read from the fresh valuation artifact, NOT re-fetched (recorded tradeoff)",
      "rehearsal freshness is an ARM-time precondition, not per-event",
      "this tool never signs, never broadcasts, never reads keys; fired is a read-only decision",
    ],
  };
  return observation;
}

// ---------------------------------------------------------------------------
// watch-once (autonomous standing observation; reads fresh euler-l evidence)
//   Freshness gate first (watch <=15m, valuation <=30m) -> else SKIP_STALE_EVIDENCE.
//   Otherwise resolves chain head over a qualified keyless RPC (<=3 reads) and runs
//   the SAME runFastlane decision pipeline with ctx.input built in-code. Chain-head
//   read failure is an honest HEAD_UNRESOLVED verdict, never a crash. Exit 0 always.
// ---------------------------------------------------------------------------
function watchOnceFreshness() {
  const watchR = readJson(DEFAULT_WATCH);
  const valuationR = readJson(DEFAULT_VALUATION);
  const watchVal = watchR.value;
  const valuation = valuationR.value;
  const watchAge = watchVal ? ageMs(watchVal.generatedAt) : null;
  const valAge = valuation ? ageMs(valuation.generatedAt) : null;
  const watchFresh = freshWithin(watchAge, WATCH_ONCE_WATCH_CAP_MS);
  const valuationFresh = freshWithin(valAge, WATCH_ONCE_VALUATION_CAP_MS);
  return {
    watchVal, valuation, watchAge, valAge, watchFresh, valuationFresh,
    freshness: {
      watchStatusPath: path.relative(WORKSPACE, DEFAULT_WATCH).split(path.sep).join("/"),
      watchGeneratedAt: watchVal && typeof watchVal.generatedAt === "string" ? watchVal.generatedAt : null,
      watchAgeMs: watchAge,
      watchCapMs: WATCH_ONCE_WATCH_CAP_MS,
      watchFresh,
      valuationPath: path.relative(WORKSPACE, DEFAULT_VALUATION).split(path.sep).join("/"),
      valuationGeneratedAt: valuation && typeof valuation.generatedAt === "string" ? valuation.generatedAt : null,
      valuationAgeMs: valAge,
      valuationCapMs: WATCH_ONCE_VALUATION_CAP_MS,
      valuationFresh,
    },
  };
}

async function runWatchOnce(transport) {
  const scannedAt = new Date().toISOString();
  const gate = watchOnceFreshness();

  if (!gate.watchFresh || !gate.valuationFresh) {
    return {
      schema: SCHEMA_WATCH,
      scannedAt,
      scanner: "tools/watch-euler-head-fastlane.js",
      mode: "watch-once",
      ok: true,
      headBlock: null,
      headHash: null,
      headSource: null,
      headAttempts: [],
      scannerPin: gate.valuation && gate.valuation.pin ? gate.valuation.pin.number : null,
      verdicts: [],
      decisionSummary: { winProbable: 0, skips: 0, unverifiable: 0 },
      firedDecision: "SKIP_STALE_EVIDENCE",
      reason: `stale-evidence(watchFresh=${gate.watchFresh},valuationFresh=${gate.valuationFresh})`,
      freshness: gate.freshness,
      priceImpactFloorBps: PRICE_IMPACT_FLOOR_BPS,
      totals: { routeRows: 0, winProbable: 0, unverifiable: 0, skipped: 0 },
      budget: { requests: transport.count, maxRequests: MAX_WATCH_ONCE_REQUESTS },
      safety: WATCH_SAFETY,
      notes: [
        "freshness gate failed: no chain-head read attempted, no decision rendered (fail-closed, honest skip)",
        "re-run after the euler-l watch + valuation artifacts refresh",
      ],
    };
  }

  const ctx = {
    input: {
      scenarioInput: {
        valuationPath: DEFAULT_VALUATION,
        watchStatusPath: DEFAULT_WATCH,
        surfacePath: DEFAULT_SURFACE,
        priceImpactFloorBps: PRICE_IMPACT_FLOOR_BPS,
        armedExecutors: WATCH_DEFAULT_FLEET,
      },
    },
  };
  const observation = await runFastlane(ctx, transport);
  const headResolved = typeof observation.headBlock === "number" && Number.isFinite(observation.headBlock);
  const verdicts = observation.rows.map((r) => ({
    violator: r.violator,
    vault: r.vault,
    collateralAsset: r.collateralAsset,
    netUsdcRaw: r.netUsdcRaw,
    route: r.route,
    impactProxyBps: r.impactProxyBps,
    executor: r.executor,
    decision: r.decision,
    reason: r.reason,
  }));

  return {
    schema: SCHEMA_WATCH,
    scannedAt,
    scanner: "tools/watch-euler-head-fastlane.js",
    mode: "watch-once",
    ok: true,
    headBlock: observation.headBlock,
    headHash: observation.headHash,
    headSource: observation.headSource,
    headAttempts: observation.headAttempts,
    scannerPin: observation.scannerPin,
    verdicts,
    decisionSummary: {
      winProbable: observation.totals.winProbable,
      skips: observation.totals.skipped,
      unverifiable: observation.totals.unverifiable,
    },
    firedDecision: headResolved ? observation.fired : "HEAD_UNRESOLVED",
    reason: headResolved
      ? null
      : "head-unresolved: chain-tip RPC read failed within the <=3-read budget; verdicts are honest win-unverifiable",
    freshness: gate.freshness,
    priceImpactFloorBps: observation.priceImpactFloorBps,
    armedExecutors: WATCH_DEFAULT_FLEET.map((ex) => ({ label: ex.label, address: ex.address, pair: ex.pair })),
    totals: observation.totals,
    budget: { requests: transport.count, maxRequests: MAX_WATCH_ONCE_REQUESTS },
    safety: WATCH_SAFETY,
    notes: [
      "route quote read from the fresh valuation artifact, NOT re-fetched (recorded tradeoff)",
      "chain head resolved over a qualified keyless RPC (resolveRpc chain-1 read capability) with at least 2 head-request attempts inside the <=3-read budget; failure is HEAD_UNRESOLVED, never a crash",
      "this tool never signs, never broadcasts, never reads keys; firedDecision is a read-only decision",
    ],
  };
}

function parseArgs(args) {
  const a = args || [];
  const val = (name) => { const i = a.indexOf(name); return i >= 0 && a[i + 1] ? a[i + 1] : null; };
  const watchOnce = a.includes("--watch-once");
  const run = a.includes("--run");
  const plan = !watchOnce && (a.includes("--plan") || !run);
  return { plan, run, watchOnce, input: val("--input") };
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);

  if (opts.watchOnce) {
    const transport = createTransport({ maxRequests: MAX_WATCH_ONCE_REQUESTS });
    let status;
    try {
      status = await runWatchOnce(transport);
    } catch (error) {
      status = {
        schema: SCHEMA_WATCH,
        scannedAt: new Date().toISOString(),
        scanner: "tools/watch-euler-head-fastlane.js",
        mode: "watch-once",
        ok: false,
        headBlock: null,
        headHash: null,
        headSource: null,
        scannerPin: null,
        verdicts: [],
        decisionSummary: { winProbable: 0, skips: 0, unverifiable: 0 },
        firedDecision: "WATCH_ERROR",
        reason: `watch-once-failed: ${String(error && error.message || error).slice(0, 120)}`,
        freshness: null,
        priceImpactFloorBps: PRICE_IMPACT_FLOOR_BPS,
        totals: { routeRows: 0, winProbable: 0, unverifiable: 0, skipped: 0 },
        budget: { requests: transport.count, maxRequests: MAX_WATCH_ONCE_REQUESTS },
        safety: WATCH_SAFETY,
        notes: ["unexpected error; honest minimal status written; exit 0 (fail-open on exit, fail-closed on decision)"],
      };
    }
    try { atomicWriteJson(OUT_STATUS, status); } catch (_) { /* best-effort; still exit 0 */ }
    process.stdout.write(`[WATCH-ONCE decision=${status.firedDecision}] head=${status.headBlock ?? "n/a"} rows=${status.verdicts.length} winProbable=${status.decisionSummary.winProbable} unverifiable=${status.decisionSummary.unverifiable} skips=${status.decisionSummary.skips} requests=${transport.count} -> ${path.relative(WORKSPACE, OUT_STATUS).split(path.sep).join("/")}\n`);
    return 0;
  }

  if (!opts.run) {
    const plan = buildPlan();
    atomicWriteJson(OUT_PLAN, plan);
    process.stdout.write(`[PLAN] euler-head-fastlane offline plan written: ${path.relative(WORKSPACE, OUT_PLAN).split(path.sep).join("/")} mechanism=chain-head+pre-armed-pair checks=${plan.feasibilityChecks.length} floor=${PRICE_IMPACT_FLOOR_BPS}bps\n`);
    process.stdout.write(`  run to exercise the live read path: node tools/watch-euler-head-fastlane.js --run --input <scenario.json>\n`);
    return 0;
  }

  let ctx = {};
  if (opts.input) {
    const r = readJson(opts.input);
    if (!r.present || r.reason === "unreadable") {
      process.stdout.write(JSON.stringify({ ok: false, reason: "scenario-input-unreadable", input: opts.input, safety: SAFETY }, null, 2) + "\n");
      return 1;
    }
    ctx.input = r.value;
  }
  if (!ctx.input || typeof ctx.input !== "object") {
    const plan = buildPlan();
    process.stdout.write(JSON.stringify({
      ok: false,
      reason: "fastlane-run-requires-scenario-input",
      detail: "fail-closed: --run needs ctx.input (a fresh head-block and/or scenarioInput). Nothing was read, signed, or broadcast.",
      inputShape: plan.inputShape,
      safety: SAFETY,
    }, null, 2) + "\n");
    return 1;
  }

  const transport = createTransport({});
  let observation;
  try { observation = await runFastlane(ctx, transport); }
  catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, reason: "fastlane-run-failed", detail: String(error && error.message || error).slice(0, 120), budget: { requests: transport.count }, safety: SAFETY }, null, 2) + "\n");
    return 1;
  }
  atomicWriteJson(OUT_OBS, observation);
  process.stdout.write(`[OBS fire=${observation.fired}] head=${observation.headBlock ?? "n/a"} pin=${observation.scannerPin ?? "n/a"} rows=${observation.totals.routeRows} winProbable=${observation.totals.winProbable} unverifiable=${observation.totals.unverifiable} requests=${observation.budget.requests} -> ${path.relative(WORKSPACE, OUT_OBS).split(path.sep).join("/")}\n`);
  return 0;
}

if (require.main === module) {
  main().then((code) => { if (code) process.exitCode = code; }).catch((error) => {
    process.stderr.write(`watch-euler-head-fastlane failed: ${String(error && error.message || error).slice(0, 120)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE, OUT_PLAN, OUT_OBS, OUT_STATUS, DEFAULT_FLEET, WATCH_DEFAULT_FLEET, PRICE_IMPACT_FLOOR_BPS,
  SCHEMA_WATCH, MAX_WATCH_ONCE_REQUESTS, WATCH_ONCE_WATCH_CAP_MS, WATCH_ONCE_VALUATION_CAP_MS, WATCH_SAFETY,
  buildPlan, predictPairs, evaluateRow, impactProxyBps, routeRows, byNetDesc, runFastlane,
  watchOnceFreshness, runWatchOnce, parseArgs, main,
};
