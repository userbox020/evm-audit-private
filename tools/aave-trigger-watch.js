#!/usr/bin/env node
// aave-trigger-watch.js - read-only convenience wrapper for the Aave V4 trigger watcher.
// This script never signs, never reads private keys, and never calls exploit execute().

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const WORKSPACE = path.resolve(__dirname, "..");
const WATCH_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-watch.json");
const QUOTE_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-quotes.json");
const SWEEP_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "route-positive-sweep.json");
const GATES_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "audit-completion-gates.json");

const args = process.argv.slice(2);
const UNTIL_TRIGGER = args.includes("--until-trigger");
const DASHBOARD = args.includes("--dashboard");
const QUIET = args.includes("--quiet");
const VERBOSE = args.includes("--verbose");
const BATCH_ITERATIONS = Math.max(1, Number(argValue("--batch-iterations") || argValue("--iterations") || "2") || 2);
const INTERVAL_MS = Math.max(10_000, Number(argValue("--interval-ms") || "10000") || 10_000);
const MAX_CYCLES = Math.max(1, Number(argValue("--max-cycles") || (UNTIL_TRIGGER ? "1000000" : "1")) || 1);
const SLEEP_BETWEEN_CYCLES_MS = Math.max(0, Number(argValue("--cycle-sleep-ms") || "0") || 0);

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

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
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
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}${result.stdout || ""}`.trim();
    throw new Error(`${script} failed${detail ? `: ${detail}` : ""}`);
  }
  if (options.printOutput && result.stdout) process.stdout.write(result.stdout);
  return result;
}

function latestStatus(cycle) {
  const watch = loadJson(WATCH_FILE, {});
  const quote = loadJson(QUOTE_FILE, {});
  const sweep = loadJson(SWEEP_FILE, {});
  const gates = loadJson(GATES_FILE, {});
  const summary = watch.latest?.summary || {};
  const top = Array.isArray(watch.latest?.topRows) ? watch.latest.topRows[0] : null;
  const quoteSummary = quote.summary || watch.quoteArtifact || {};
  const sweepSummary = sweep.summary || {};
  const gateSummary = gates.summary || {};

  const liquidatable = asNumber(summary.liquidatable) || 0;
  const quoteRequiredRows = asNumber(summary.quoteRequiredRows ?? quoteSummary.quoteRequiredRows) || 0;
  const rowsQuoted = asNumber(quoteSummary.rowsQuoted) || 0;
  const routePositive = Math.max(
    asNumber(summary.routePositive) || 0,
    asNumber(quoteSummary.routePositive) || 0,
    asNumber(sweepSummary.routePositive) || 0,
    asNumber(gateSummary.routePositive) || 0
  );
  const executableNow = Math.max(asNumber(sweepSummary.executableNow) || 0, asNumber(gateSummary.executableNow) || 0);
  const signedActionJustified = Boolean(sweepSummary.signedActionJustified || gateSummary.signedActionJustified);
  const hf = top?.healthFactor ?? summary.topHealthFactor ?? summary.closestHealthFactor;
  const bps = top?.bpsToLiquidation ?? summary.topBpsToLiquidation ?? summary.closestBpsToLiquidation;
  const debt = top?.debtUsd ?? summary.topDebtUsd ?? summary.closestDebtUsd;
  const collateral = top?.topCollateral?.symbol || "n/a";
  const user = top?.user || "n/a";
  const blockNumber = watch.latest?.chain?.blockNumber || "n/a";
  const triggered = liquidatable > 0 || quoteRequiredRows > 0 || rowsQuoted > 0 || routePositive > 0 || executableNow > 0 || signedActionJustified;

  return {
    cycle,
    generatedAt: watch.generatedAt || watch.latest?.generatedAt || null,
    blockNumber,
    hf,
    bps,
    debt,
    collateral,
    user,
    liquidatable,
    quoteRequiredRows,
    rowsQuoted,
    routePositive,
    executableNow,
    signedActionJustified,
    gateStatus: gateSummary.status || "n/a",
    completeForNow: gateSummary.completeForNow ?? null,
    quoteBlocker: quoteSummary.blocker || null,
    triggered,
  };
}

function printStatus(status) {
  const prefix = status.triggered ? "TRIGGER" : "WATCH";
  console.log(
    `[${prefix} cycle=${status.cycle} block=${status.blockNumber}] `
    + `HF=${fmt(status.hf, 9)} bps=${fmt(status.bps, 2)} debt=$${fmt(status.debt, 2)} collateral=${status.collateral} `
    + `liquidatable=${status.liquidatable} quoteRequired=${status.quoteRequiredRows} rowsQuoted=${status.rowsQuoted} `
    + `routePositive=${status.routePositive} executableNow=${status.executableNow}`
  );
  if (status.quoteBlocker && (VERBOSE || status.triggered)) console.log(`  quote: ${status.quoteBlocker}`);
}

function printTriggerInstructions(status) {
  console.log("");
  console.log("FORK GATE CANDIDATE - automation stopped before any signed action.");
  console.log(`User: ${status.user}`);
  console.log(`HF=${fmt(status.hf, 9)} bps=${fmt(status.bps, 2)} debt=$${fmt(status.debt, 2)} collateral=${status.collateral}`);
  console.log("Inspect these artifacts before doing anything else:");
  console.log("  reports\\raw\\fast\\aave-v4-liquidation-watch.json");
  console.log("  reports\\raw\\fast\\aave-v4-liquidation-quotes.json");
  console.log("  reports\\raw\\fast\\route-positive-sweep.json");
  console.log("Required next gate: exact route economics positive after gas/slippage, then fork proof. Live action still requires explicit authorization.");
}

async function main() {
  console.log("Aave V4 read-only trigger watch");
  console.log(`batchIterations=${BATCH_ITERATIONS} intervalMs=${INTERVAL_MS} maxCycles=${MAX_CYCLES}${UNTIL_TRIGGER ? " untilTrigger=true" : ""}`);
  console.log("Safety: no private keys, no signed actions, no execute calls. Press Ctrl+C to stop.");

  let finalStatus = null;
  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    runNode(path.join("tools", "watch-aave-v4-liquidation-triggers.js"), [
      "--iterations", String(BATCH_ITERATIONS),
      "--interval-ms", String(INTERVAL_MS),
      QUIET || !VERBOSE ? "--quiet" : "",
    ].filter(Boolean), { inherit: VERBOSE && !QUIET });

    runNode(path.join("tools", "scan-reports-signal.js"));
    runNode(path.join("tools", "scan-audit-completion-gates.js"), ["--quiet"]);
    if (DASHBOARD) runNode(path.join("tools", "view-alerts.js"), ["--dashboard"], { printOutput: true });

    finalStatus = latestStatus(cycle);
    printStatus(finalStatus);

    if (finalStatus.triggered) {
      printTriggerInstructions(finalStatus);
      process.exitCode = 2;
      return;
    }
    if (!UNTIL_TRIGGER && cycle >= MAX_CYCLES) break;
    if (SLEEP_BETWEEN_CYCLES_MS > 0) await sleep(SLEEP_BETWEEN_CYCLES_MS);
  }

  if (finalStatus) {
    console.log(`No trigger. Gate=${finalStatus.gateStatus} routePositive=${finalStatus.routePositive} signedActionJustified=${finalStatus.signedActionJustified}`);
  }
}

main().catch((err) => {
  console.error(`aave-trigger-watch failed: ${err?.message || String(err)}`);
  process.exitCode = 1;
});
