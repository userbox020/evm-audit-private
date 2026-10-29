#!/usr/bin/env node
// aave-autopilot.js - read-only Aave V4 watcher + quote + gate pipeline + Aave V3 hot borrower monitor.
// This script never reads private keys, never signs, never deploys, and never calls exploit execute().

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const WORKSPACE = path.resolve(__dirname, "..");
const WATCH_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-watch.json");
const QUOTE_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-quotes.json");
const SHADOW_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-shadow-quotes.json");
const STABLE_PAIR_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-stable-pair-route-probe.json");
const SOCKET_BRANCH_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "socket-branch-enrichment.json");
const SWEEP_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "route-positive-sweep.json");
const PROXIMITY_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "evaluator-proximity.json");
const GATES_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "audit-completion-gates.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "aave-autopilot-status.json");
// Aave V3 monitoring
const V3_STATUS_FILE = path.join(WORKSPACE, "reports", "monitor", "aave-v3-autopilot-status.json");
const V3_ALERT_FILE = path.join(WORKSPACE, "reports", "monitor", "aave-v3-trigger-alert.json");
const V3_USER = "0x1a557354c5b8d7df38ea914209e416dc7065b158";
const V3_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";

const args = process.argv.slice(2);
const QUIET = args.includes("--quiet");
const VERBOSE = args.includes("--verbose");
const DASHBOARD = args.includes("--dashboard");
const NO_SHADOW = args.includes("--no-shadow");
const NO_STABLE_PAIR = args.includes("--no-stable-pair");
const NO_SOCKET = args.includes("--no-socket");
const ONCE = args.includes("--once");
const UNTIL_TRIGGER = args.includes("--until-trigger") || (!ONCE && !argValue("--max-cycles"));
const MAX_CYCLES = Math.max(1, Number(argValue("--max-cycles") || (ONCE ? "1" : UNTIL_TRIGGER ? "1000000" : "1")) || 1);
const INTERVAL_MS = Math.max(10_000, Number(argValue("--interval-ms") || "10000") || 10_000);
const CYCLE_SLEEP_MS = Math.max(0, Number(argValue("--cycle-sleep-ms") || String(INTERVAL_MS)) || 0);
const SHADOW_MAX_ROWS = Math.max(1, Number(argValue("--shadow-max-rows") || "2") || 2);
const SHADOW_PAIR_LIMIT = Math.max(1, Number(argValue("--shadow-pair-limit") || "2") || 2);
const SHADOW_EVERY = Math.max(1, Number(argValue("--shadow-every") || "1") || 1);
const SHADOW_TRIGGER_BPS = Math.max(0, Number(argValue("--shadow-trigger-bps") || process.env.AAVE_V4_SHADOW_TRIGGER_BPS || "250") || 250);
const SHADOW_SIZE_FRACTIONS = argValue("--shadow-size-fractions") || "";
const STABLE_PAIR_EVERY = Math.max(1, Number(argValue("--stable-pair-every") || "30") || 30);
const SOCKET_EVERY = Math.max(1, Number(argValue("--socket-every") || "30") || 30);
const WATCH_TIMEOUT_MS = Math.max(60_000, Number(process.env.AAVE_AUTOPILOT_WATCH_TIMEOUT_MS || "300000") || 300_000);
const SHADOW_TIMEOUT_MS = Math.max(30_000, Number(process.env.AAVE_AUTOPILOT_SHADOW_TIMEOUT_MS || "180000") || 180_000);
const STABLE_PAIR_TIMEOUT_MS = Math.max(30_000, Number(process.env.AAVE_AUTOPILOT_STABLE_PAIR_TIMEOUT_MS || "240000") || 240_000);
const SOCKET_TIMEOUT_MS = Math.max(30_000, Number(process.env.AAVE_AUTOPILOT_SOCKET_TIMEOUT_MS || "120000") || 120_000);
const HOUSEKEEPING_TIMEOUT_MS = Math.max(30_000, Number(process.env.AAVE_AUTOPILOT_HOUSEKEEPING_TIMEOUT_MS || "120000") || 120_000);

function argValue(name) {
  const prefix = `${name}=`;
  const item = args.find((arg) => arg.startsWith(prefix));
  if (item) return item.slice(prefix.length);
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
}

function loadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function fmt(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return "n/a";
  return n.toFixed(decimals);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runNode(script, runArgs = [], options = {}) {
  const result = spawnSync(process.execPath, [script, ...runArgs], {
    cwd: WORKSPACE,
    env: process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    maxBuffer: 50 * 1024 * 1024,
    timeout: options.timeoutMs || HOUSEKEEPING_TIMEOUT_MS,
  });
  if (result.error) throw new Error(`${script} failed: ${result.error.message || String(result.error)}`);
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}${result.stdout || ""}`.trim();
    throw new Error(`${script} failed${detail ? `: ${detail}` : ""}`);
  }
  if (options.printOutput && result.stdout) process.stdout.write(result.stdout);
  return result;
}

function runOptionalNode(script, runArgs = [], options = {}, warnings = []) {
  try {
    return runNode(script, runArgs, options);
  } catch (err) {
    const warning = {
      script: String(script).replace(/\\/g, "/"),
      error: err?.message || String(err),
      optional: true,
    };
    warnings.push(warning);
    if (!QUIET) console.log(`[WARN] optional ${warning.script} skipped: ${warning.error}`);
    return null;
  }
}

function statusFromArtifacts(cycle, startedAt, optionalWarnings = []) {
  const watch = loadJson(WATCH_FILE, {});
  const quote = loadJson(QUOTE_FILE, {});
  const shadow = loadJson(SHADOW_FILE, {});
  const stablePair = loadJson(STABLE_PAIR_FILE, {});
  const socketBranch = loadJson(SOCKET_BRANCH_FILE, {});
  const sweep = loadJson(SWEEP_FILE, {});
  const proximity = loadJson(PROXIMITY_FILE, {});
  const gates = loadJson(GATES_FILE, {});

  const watchSummary = watch.latest?.summary || {};
  const top = Array.isArray(watch.latest?.topRows) ? watch.latest.topRows[0] : null;
  const quoteSummary = quote.summary || watch.quoteArtifact || {};
  const shadowSummary = shadow.summary || {};
  const stableSummary = stablePair.summary || {};
  const socketSummary = socketBranch.summary || {};
  const sweepSummary = sweep.summary || {};
  const gateSummary = gates.summary || {};
  const proximitySummary = proximity.summary || {};

  const liquidatable = asNumber(watchSummary.liquidatable) || 0;
  const quoteRequiredRows = asNumber(watchSummary.quoteRequiredRows ?? quoteSummary.quoteRequiredRows) || 0;
  const rowsQuoted = asNumber(quoteSummary.rowsQuoted) || 0;
  const researchPositiveRoutes = asNumber(quoteSummary.researchPositiveRoutes) || 0;
  const shadowRowsQuoted = asNumber(shadowSummary.shadowRowsQuoted) || 0;
  const shadowResearchPositiveRoutes = asNumber(shadowSummary.shadowResearchPositiveRoutes) || 0;
  const socketExactEconomicsRows = asNumber(socketSummary.exactEconomicsRows) || 0;
  const socketTriggerReadyExactEconomicsRows = asNumber(socketSummary.triggerReadyExactEconomicsRows) || 0;
  const socketForkProofRows = asNumber(socketSummary.forkProofRows) || 0;
  const aaveRoutePositive = Math.max(
    asNumber(watchSummary.routePositive) || 0,
    asNumber(quoteSummary.routePositive) || 0,
    asNumber(shadowSummary.routePositive) || 0,
    asNumber(socketSummary.routePositive) || 0
  );
  const globalRoutePositive = Math.max(
    asNumber(sweepSummary.routePositive) || 0,
    asNumber(gateSummary.routePositive) || 0
  );
  const executableNow = Math.max(asNumber(sweepSummary.executableNow) || 0, asNumber(gateSummary.executableNow) || 0);
  const signedActionJustified = Boolean(sweepSummary.signedActionJustified || gateSummary.signedActionJustified);
  const exactTrigger = liquidatable > 0 || quoteRequiredRows > 0 || rowsQuoted > 0 || researchPositiveRoutes > 0;
  const hardStopReason = exactTrigger
    ? "aave-exact-trigger"
    : socketTriggerReadyExactEconomicsRows > 0
      ? "socket-trigger-ready-exact-economics"
    : aaveRoutePositive > 0
      ? "aave-route-positive"
      : executableNow > 0
        ? "global-executable-now"
        : signedActionJustified
          ? "global-signed-action-justified"
          : null;
  const hardStop = Boolean(hardStopReason);

  return {
    generatedAt: new Date().toISOString(),
    scanner: "tools/aave-autopilot.js",
    scope: "Read-only Aave V4 autopilot pipeline status",
    cycle,
    startedAt,
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: aaveRoutePositive > 0,
      globalRoutePositive: globalRoutePositive > 0,
      signedActionJustified,
    },
    config: {
      maxCycles: MAX_CYCLES,
      untilTrigger: UNTIL_TRIGGER,
      intervalMs: INTERVAL_MS,
      cycleSleepMs: CYCLE_SLEEP_MS,
      shadowEnabled: !NO_SHADOW,
      shadowEvery: SHADOW_EVERY,
      shadowTriggerBps: SHADOW_TRIGGER_BPS,
      shadowMaxRows: SHADOW_MAX_ROWS,
      shadowPairLimit: SHADOW_PAIR_LIMIT,
      shadowSizeFractions: SHADOW_SIZE_FRACTIONS || null,
      stablePairEnabled: !NO_STABLE_PAIR,
      stablePairEvery: STABLE_PAIR_EVERY,
      socketEnabled: !NO_SOCKET,
      socketEvery: SOCKET_EVERY,
      timeoutsMs: {
        watch: WATCH_TIMEOUT_MS,
        shadow: SHADOW_TIMEOUT_MS,
        stablePair: STABLE_PAIR_TIMEOUT_MS,
        socket: SOCKET_TIMEOUT_MS,
        housekeeping: HOUSEKEEPING_TIMEOUT_MS,
      },
    },
    latest: {
      blockNumber: watch.latest?.chain?.blockNumber || null,
      watchGeneratedAt: watch.latest?.generatedAt || watch.generatedAt || null,
      quoteGeneratedAt: quote.generatedAt || null,
      shadowGeneratedAt: shadow.generatedAt || null,
      stablePairGeneratedAt: stablePair.generatedAt || null,
      socketBranchGeneratedAt: socketBranch.generatedAt || null,
      gateGeneratedAt: gates.generatedAt || null,
      user: top?.user || null,
      hub: top?.hub || null,
      spoke: top?.spoke || null,
      healthFactor: top?.healthFactor ?? watchSummary.topHealthFactor ?? watchSummary.closestHealthFactor ?? null,
      bpsToLiquidation: top?.bpsToLiquidation ?? watchSummary.topBpsToLiquidation ?? watchSummary.closestBpsToLiquidation ?? null,
      debtUsd: top?.debtUsd ?? watchSummary.topDebtUsd ?? watchSummary.closestDebtUsd ?? null,
      collateral: top?.topCollateral?.symbol || null,
      liquidatable,
      quoteRequiredRows,
      rowsQuoted,
      researchPositiveRoutes,
      shadowRowsQuoted,
      shadowResearchPositiveRoutes,
      shadowBestPair: shadowSummary.bestPair || null,
      shadowBestNetProfitUsd: round(shadowSummary.bestNetProfitUsd, 2),
      shadowBestRepayUsd: round(shadowSummary.bestRepayUsd, 2),
      shadowClosestBestPair: shadowSummary.closestBestPair || null,
      shadowClosestBestNetProfitUsd: round(shadowSummary.closestBestNetProfitUsd, 2),
      shadowClosestBestFraction: round(shadowSummary.closestBestFraction, 4),
      shadowClosestBestSource: shadowSummary.closestBestSource || null,
      shadowClosestBestPathKind: shadowSummary.closestBestPathKind || null,
      stablePairRouteRows: asNumber(stableSummary.routeRows) || 0,
      stablePairCollateralFlashResearchPositive: stableSummary.collateralFlashResearchPositive ? 1 : 0,
      stablePairCollateralFlashNetUsd: round(stableSummary.collateralFlashNetUsd, 2),
      stablePairCollateralFlashSufficient: stableSummary.collateralFlashSufficientForProbe ?? null,
      stablePairBestSource: stableSummary.bestSource || null,
      stablePairBestPathKind: stableSummary.bestPathKind || null,
      socketRequestsBuilt: asNumber(socketSummary.requestsBuilt) || 0,
      socketQuotedRows: asNumber(socketSummary.quotedRows) || 0,
      socketAaveRowsQuoted: asNumber(socketSummary.aaveRowsQuoted) || 0,
      socketExactEconomicsRows,
      socketTriggerReadyExactEconomicsRows,
      socketForkProofRows,
      socketBestConservativeNetUsd: round(socketSummary.bestConservativeNetUsd, 2),
      socketRoutePositive: asNumber(socketSummary.routePositive) || 0,
      socketExecutableNow: asNumber(socketSummary.executableNow) || 0,
      routePositive: aaveRoutePositive,
      aaveRoutePositive,
      globalRoutePositive,
      executableNow,
      signedActionJustified,
      gateStatus: gateSummary.status || null,
      completeForNow: gateSummary.completeForNow ?? null,
      proximityTopSurface: proximitySummary.topSurface || null,
      exactTrigger,
      hardStop,
      hardStopReason,
      optionalWarnings,
      blocker: exactTrigger
        ? quoteSummary.blocker || "Aave trigger opened; inspect exact quote artifact."
        : socketTriggerReadyExactEconomicsRows > 0
          ? "Socket branch has trigger-ready exact-economics rows; fork proof is required before any signed action."
          : socketSummary.closedReason || shadowSummary.blocker || quoteSummary.blocker || null,
    },
    artifacts: {
      watch: path.relative(WORKSPACE, WATCH_FILE),
      quote: path.relative(WORKSPACE, QUOTE_FILE),
      shadow: path.relative(WORKSPACE, SHADOW_FILE),
      stablePair: path.relative(WORKSPACE, STABLE_PAIR_FILE),
      socketBranchEnrichment: path.relative(WORKSPACE, SOCKET_BRANCH_FILE),
      routeSweep: path.relative(WORKSPACE, SWEEP_FILE),
      proximity: path.relative(WORKSPACE, PROXIMITY_FILE),
      completionGates: path.relative(WORKSPACE, GATES_FILE),
    },
    nextGate: hardStop
      ? "Stop before any signed action. Inspect artifacts; fork only if exact route economics are positive after gas/slippage and staticCall/fork proof succeeds."
      : globalRoutePositive > 0
        ? "Continue Aave read-only watcher. Global route-positive surfaces are tracked separately and do not stop Aave autopilot unless executable/signed gates open."
        : "Continue read-only watcher. Shadow and Socket-positive rows remain pre-trigger only until HF < 1 and fork proof passes.",
  };
}

function printStatus(status) {
  const latest = status.latest;
  const prefix = latest.hardStop ? "AAVE-STOP" : "AAVE-AUTO";
  const shadow = latest.shadowRowsQuoted > 0
    ? ` shadow=${latest.shadowBestPair || "n/a"} net=$${fmt(latest.shadowBestNetProfitUsd, 2)} closest=${latest.shadowClosestBestPair || "n/a"} closestNet=$${fmt(latest.shadowClosestBestNetProfitUsd, 2)} shadowPos=${latest.shadowResearchPositiveRoutes}`
    : " shadow=n/a";
  const socket = latest.socketQuotedRows > 0
    ? ` socketRows=${latest.socketQuotedRows} socketAave=${latest.socketAaveRowsQuoted} socketExact=${latest.socketExactEconomicsRows} socketTriggerExact=${latest.socketTriggerReadyExactEconomicsRows} socketBest=$${fmt(latest.socketBestConservativeNetUsd, 2)}`
    : " socket=n/a";
  const stablePair = latest.stablePairRouteRows > 0
    ? ` stablePairRows=${latest.stablePairRouteRows} stablePairNet=$${fmt(latest.stablePairCollateralFlashNetUsd, 2)} stablePairFlash=${latest.stablePairCollateralFlashSufficient}`
    : " stablePair=n/a";
  console.log(
    `[${prefix} cycle=${status.cycle} block=${latest.blockNumber || "n/a"}] `
    + `HF=${fmt(latest.healthFactor, 9)} bps=${fmt(latest.bpsToLiquidation, 2)} debt=$${fmt(latest.debtUsd, 2)} collateral=${latest.collateral || "n/a"} `
    + `liq=${latest.liquidatable} quoteReq=${latest.quoteRequiredRows} exactRows=${latest.rowsQuoted} `
    + `routePositive=${latest.routePositive} globalRoutePositive=${latest.globalRoutePositive} executableNow=${latest.executableNow}${shadow}${stablePair}${socket}`
  );
}

function printStopInstructions(status) {
  const latest = status.latest;
  console.log("");
  const aaveGate = latest.hardStopReason === "aave-exact-trigger" || latest.hardStopReason === "aave-route-positive";
  console.log(aaveGate
    ? "FORK GATE CANDIDATE - autopilot stopped before any signed action."
    : "SAFETY GATE - autopilot stopped before any signed action.");
  console.log(`User: ${latest.user || "n/a"}`);
  console.log(`HF=${fmt(latest.healthFactor, 9)} bps=${fmt(latest.bpsToLiquidation, 2)} debt=$${fmt(latest.debtUsd, 2)} collateral=${latest.collateral || "n/a"}`);
  console.log(`Exact rows=${latest.rowsQuoted} researchPositive=${latest.researchPositiveRoutes} routePositive=${latest.routePositive} globalRoutePositive=${latest.globalRoutePositive} reason=${latest.hardStopReason || "n/a"}`);
  console.log("Inspect these artifacts:");
  console.log("  reports\\raw\\fast\\aave-v4-liquidation-watch.json");
  console.log("  reports\\raw\\fast\\aave-v4-liquidation-quotes.json");
  console.log("  reports\\raw\\fast\\aave-v4-liquidation-shadow-quotes.json");
  console.log("  reports\\raw\\fast\\aave-v4-stable-pair-route-probe.json");
  console.log("  reports\\raw\\fast\\socket-branch-enrichment.json");
  console.log("  reports\\raw\\fast\\route-positive-sweep.json");
  console.log("Required next gate: exact positive economics after gas/slippage, liquidation staticCall, then fork proof. Live action still requires explicit authorization.");
}

// --- Aave V3 Hot Borrower Monitor (integrated) ---
async function checkV3HF() {
  try {
    const { ethers } = require("ethers");
    const { rpcCall, resolveRpc } = require("./shared-rpc");
    const r = await resolveRpc(1);
    if (!r) return null;
    const AAVE = new ethers.Interface(["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"]);
    const raw = await rpcCall(r, "eth_call", [{ to: V3_POOL, data: AAVE.encodeFunctionData("getUserAccountData", [V3_USER]) }, "latest"], 12000);
    if (!raw || raw === "0x") return null;
    const d = AAVE.decodeFunctionResult("getUserAccountData", raw);
    const hf = Number(ethers.formatUnits(d[5], 18));
    const debt = Number(ethers.formatUnits(d[1], 8));
    const bps = hf > 1 ? ((hf - 1) * 10000) : 0;
    const liquidatable = hf < 1;
    const result = { at: new Date().toISOString(), hf, debtUsd: Math.round(debt), bpsToLiq: bps, liquidatable };
    // Write status
    fs.mkdirSync(path.dirname(V3_STATUS_FILE), { recursive: true });
    fs.writeFileSync(V3_STATUS_FILE, JSON.stringify({ ...result, status: liquidatable ? "LIQUIDATABLE" : "WATCHING" }, null, 2));
    return result;
  } catch (_) { return null; }
}

function runV3ForkIfTriggered(v3) {
  if (!v3 || !v3.liquidatable) return;
  const FORK = path.join(__dirname, "auto-fork-aave-v3-liquidation.js");
  if (!fs.existsSync(FORK)) { console.error(`  [V3] Fork script missing: ${FORK}`); return; }
  console.error(`  [V3] 🚨 LIQUIDATABLE! Running fork test: ${FORK}`);
  fs.mkdirSync(path.dirname(V3_ALERT_FILE), { recursive: true });
  fs.writeFileSync(V3_ALERT_FILE, JSON.stringify({ ...v3, triggeredAt: new Date().toISOString() }, null, 2));
  runNode(FORK, [], { timeoutMs: 300000 });
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log("Aave V4 + V3 read-only autopilot pipeline");
  console.log(`maxCycles=${MAX_CYCLES}${UNTIL_TRIGGER ? " untilTrigger=true" : ""} intervalMs=${INTERVAL_MS} cycleSleepMs=${CYCLE_SLEEP_MS}`);
  console.log(`shadow=${NO_SHADOW ? "off" : "on"} shadowEvery=${SHADOW_EVERY} triggerBps=${SHADOW_TRIGGER_BPS} maxRows=${SHADOW_MAX_ROWS} pairLimit=${SHADOW_PAIR_LIMIT}`);
  console.log(`stablePair=${NO_STABLE_PAIR ? "off" : "on"} stablePairEvery=${STABLE_PAIR_EVERY} (read-only, no calldata execution)`);
  console.log(`socketBranch=${NO_SOCKET ? "off" : "on"} socketEvery=${SOCKET_EVERY} (read-only, no calldata storage)`);
  console.log(`timeoutsMs watch=${WATCH_TIMEOUT_MS} shadow=${SHADOW_TIMEOUT_MS} stablePair=${STABLE_PAIR_TIMEOUT_MS} socket=${SOCKET_TIMEOUT_MS} housekeeping=${HOUSEKEEPING_TIMEOUT_MS}`);
  console.log("Safety: no private keys, no signed actions, no deploys, no execute calls. Press Ctrl+C to stop.");

  let finalStatus = null;
  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    const optionalWarnings = [];
    runNode(path.join("tools", "watch-aave-v4-liquidation-triggers.js"), [
      "--iterations", "1",
      "--interval-ms", String(INTERVAL_MS),
      QUIET || !VERBOSE ? "--quiet" : "",
    ].filter(Boolean), { inherit: VERBOSE && !QUIET, timeoutMs: WATCH_TIMEOUT_MS });

    const watchStatus = statusFromArtifacts(cycle, startedAt, optionalWarnings);
    const shouldShadow = !NO_SHADOW && cycle % SHADOW_EVERY === 0;
    if (shouldShadow) {
      runNode(path.join("tools", "quote-aave-v4-shadow-liquidation-routes.js"), [
        "--max-rows", String(SHADOW_MAX_ROWS),
        "--pair-limit", String(SHADOW_PAIR_LIMIT),
        "--trigger-bps", String(SHADOW_TRIGGER_BPS),
        SHADOW_SIZE_FRACTIONS ? "--size-fractions" : "",
        SHADOW_SIZE_FRACTIONS || "",
        "--quiet",
      ].filter(Boolean), { timeoutMs: SHADOW_TIMEOUT_MS });
    }

    const shouldStablePair = !NO_STABLE_PAIR && cycle % STABLE_PAIR_EVERY === 0 && fs.existsSync(SHADOW_FILE);
    if (shouldStablePair) runOptionalNode(path.join("tools", "probe-aave-v4-stable-pair-routes.js"), [], { timeoutMs: STABLE_PAIR_TIMEOUT_MS }, optionalWarnings);

    const shouldSocket = !NO_SOCKET && cycle % SOCKET_EVERY === 0;
    if (shouldSocket) runOptionalNode(path.join("tools", "quote-socket-branch-enrichment.js"), ["--quiet"], { timeoutMs: SOCKET_TIMEOUT_MS }, optionalWarnings);

    if (watchStatus.latest.exactTrigger) runNode(path.join("tools", "quote-aave-v4-liquidation-trigger.js"), ["--quiet"], { timeoutMs: HOUSEKEEPING_TIMEOUT_MS });
    
    // Aave V3 hot borrower check
    const v3 = await checkV3HF();
    if (v3) {
      const v3Alert = v3.liquidatable ? "🚨 LIQUIDATABLE" : v3.hf < 1.01 ? "⚠️ CLOSE" : "✅";
      if (!QUIET) console.error(`  [V3] ${v3Alert} HF=${v3.hf.toFixed(6)} ${v3.bpsToLiq.toFixed(2)}bps debt=$${v3.debtUsd.toLocaleString()}`);
      if (v3.liquidatable) runV3ForkIfTriggered(v3);
    }
    
    runNode(path.join("tools", "scan-route-positive-sweep.js"), ["--quiet"], { timeoutMs: HOUSEKEEPING_TIMEOUT_MS });
    runNode(path.join("tools", "scan-evaluator-proximity.js"), ["--quiet"], { timeoutMs: HOUSEKEEPING_TIMEOUT_MS });
    runNode(path.join("tools", "scan-reports-signal.js"), ["--quiet"], { timeoutMs: HOUSEKEEPING_TIMEOUT_MS });
    runNode(path.join("tools", "scan-audit-completion-gates.js"), ["--quiet"], { timeoutMs: HOUSEKEEPING_TIMEOUT_MS });
    if (DASHBOARD) runNode(path.join("tools", "view-alerts.js"), ["--dashboard"], { printOutput: true, timeoutMs: HOUSEKEEPING_TIMEOUT_MS });

    finalStatus = statusFromArtifacts(cycle, startedAt, optionalWarnings);
    writeJson(OUT, finalStatus);
    printStatus(finalStatus);

    if (finalStatus.latest.hardStop) {
      printStopInstructions(finalStatus);
      process.exitCode = 2;
      return;
    }

    if (!UNTIL_TRIGGER && cycle >= MAX_CYCLES) break;
    if (CYCLE_SLEEP_MS > 0) await sleep(CYCLE_SLEEP_MS);
  }

  if (finalStatus) {
    console.log(`No trigger. Gate=${finalStatus.latest.gateStatus || "n/a"} routePositive=${finalStatus.latest.routePositive} globalRoutePositive=${finalStatus.latest.globalRoutePositive} signedActionJustified=${finalStatus.latest.signedActionJustified}`);
    console.log(`Status artifact: ${path.relative(WORKSPACE, OUT)}`);
  }
}

main().catch((err) => {
  console.error(`aave-autopilot failed: ${err?.message || String(err)}`);
  process.exitCode = 1;
});
