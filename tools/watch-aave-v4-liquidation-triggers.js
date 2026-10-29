#!/usr/bin/env node
// watch-aave-v4-liquidation-triggers.js - bounded read-only Aave V4 liquidation trigger watcher.
// RPC URLs are only used by the underlying borrower scanner and are never printed or written.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { minimalMonitorEnv, forceMonitorOnlyArtifact } = require("./monitor-minimal-env");
const { buildSourceCoverage, TOPOLOGY_MAX_AGE_MS } = require("./scan-aave-v4-spoke-borrowers");
const { LIMITS: COLLECTION_LIMITS } = require("./lib/aave-v4-pinned-collection");
const { validateAaveSourceCoverageEnvelope, validV4ObservationPin } = require("./aave-source-coverage");

const WORKSPACE = path.resolve(__dirname, "..");
const BORROWERS_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-spoke-borrowers.json");
const HUBS_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-hubs.json");
const QUOTE_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-quotes.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-watch.json");
const AAVE_V4_WATCH_SCHEMA = "aave-v4-liquidation-watch/v1";
const WATCH_SCANNER = "tools/watch-aave-v4-liquidation-triggers.js";
const SOURCE_SCANNER = "tools/scan-aave-v4-spoke-borrowers.js";
const SOURCE_ARTIFACT = "reports/raw/fast/aave-v4-spoke-borrowers.json";

const QUIET = process.argv.includes("--quiet");
const SKIP_SCAN = process.argv.includes("--skip-scan");
const NO_QUOTES = process.argv.includes("--no-quotes");
const NO_SWEEP = process.argv.includes("--no-sweep");
const ITERATIONS = Math.max(1, Number(argValue("--iterations") || (process.argv.includes("--once") ? "1" : "1")) || 1);
const INTERVAL_MS = Math.max(10_000, Number(argValue("--interval-ms") || "300000") || 300_000);
const TRIGGER_BPS = Math.max(0, Number(argValue("--trigger-bps") || "150") || 150);
const MIN_DEBT_USD = Math.max(0, Number(argValue("--min-debt-usd") || "1000") || 1000);
const HISTORY_LIMIT = 12;
const HISTORY_BYTE_LIMIT = 256 * 1024;
// Keep topology valid through a full pinned collection plus a safety margin.
const TOPOLOGY_SCAN_HEADROOM_MS = COLLECTION_LIMITS.maxMs + 60_000;
const historySizes = new WeakMap();

function argValue(name) {
  const prefix = `${name}=`;
  const item = process.argv.find((arg) => arg.startsWith(prefix));
  if (item) return item.slice(prefix.length);
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
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
  const text = String(value).replace(/[$,%\s,]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function sum(items, fn) {
  return (items || []).reduce((acc, item) => acc + (asNumber(fn(item)) || 0), 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: WORKSPACE,
    env: minimalMonitorEnv(),
    stdio: QUIET ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (result.error) throw new Error(`${path.basename(script)}-failed`);
  if (result.status !== 0) {
    throw new Error(`${path.basename(script)}-failed`);
  }
}

function topologyUsable(artifact, nowMs = Date.now(), minimumValidityMs = 0) {
  const generatedAt = Date.parse(artifact?.generatedAt);
  const ageMs = nowMs - generatedAt;
  const coverage = validateAaveSourceCoverageEnvelope(artifact?.sourceCoverage, {
    protocolVersion: "V4", coverageKind: "topology", requireSampleComplete: true,
  });
  return coverage.valid && validV4ObservationPin(artifact?.sourceCoverage) && Number.isFinite(generatedAt)
    && Number.isSafeInteger(minimumValidityMs) && minimumValidityMs >= 0 && minimumValidityMs <= TOPOLOGY_MAX_AGE_MS
    && ageMs >= -60_000
    && ageMs <= TOPOLOGY_MAX_AGE_MS - minimumValidityMs
    && artifact?.sourceCoverage?.topologyUniverse?.type === "DECLARED_STATIC_HUB_SET";
}

function refreshTopologyIfNeeded(options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const load = options.load || (() => loadJson(HUBS_FILE, null));
  const run = options.run || (() => runNode(path.join("tools", "scan-aave-v4-hubs.js"), ["--quiet"]));
  if (topologyUsable(load(), nowMs, TOPOLOGY_SCAN_HEADROOM_MS)) return { topologyRefreshAttempted: false, topologyRefreshOk: true };
  try {
    run();
  } catch (_) {
    return { topologyRefreshAttempted: true, topologyRefreshOk: false, error: "topology-refresh-failed" };
  }
  const ok = topologyUsable(load(), Number.isFinite(options.afterNowMs) ? options.afterNowMs : Date.now(), TOPOLOGY_SCAN_HEADROOM_MS);
  return {
    topologyRefreshAttempted: true,
    topologyRefreshOk: ok,
    ...(ok ? {} : { error: "topology-refresh-incomplete" }),
  };
}

function reserveBonusBps(reserve) {
  const direct = asNumber(reserve?.liquidationBonusBps);
  if (direct && direct > 0) return direct;
  const dynamic = asNumber(reserve?.dynamicConfig?.maxLiquidationBonusBps);
  return dynamic && dynamic > 0 ? dynamic : null;
}

function userRow(row) {
  const reserves = Array.isArray(row.reserves) ? row.reserves : [];
  const debts = reserves
    .filter((reserve) => (asNumber(reserve.debtUsd) || 0) > 0)
    .sort((a, b) => (asNumber(b.debtUsd) || 0) - (asNumber(a.debtUsd) || 0));
  const collaterals = reserves
    .filter((reserve) => reserve.usingAsCollateral !== false && (asNumber(reserve.suppliedUsd) || 0) > 0)
    .sort((a, b) => (asNumber(b.suppliedUsd) || 0) - (asNumber(a.suppliedUsd) || 0));
  const healthFactor = asNumber(row.account?.healthFactor);
  const debtUsd = sum(debts, (reserve) => reserve.debtUsd);
  const collateralUsd = sum(collaterals, (reserve) => reserve.suppliedUsd);
  const topDebt = debts[0] || null;
  const topCollateral = collaterals[0] || null;
  const topCollateralBonusBps = reserveBonusBps(topCollateral);
  const bonusBps = Math.max(0, (topCollateralBonusBps || 10_000) - 10_000);
  const bpsToLiquidation = Number.isFinite(healthFactor) ? Math.max(0, (healthFactor - 1) * 10_000) : null;
  const collateralDropToLiquidationPct = Number.isFinite(healthFactor) && healthFactor > 1 ? (1 - (1 / healthFactor)) * 100 : 0;
  const potentialGrossBonusUsd = Math.min(debtUsd, collateralUsd) * bonusBps / 10_000;
  const liquidatable = Boolean(row.liquidatable) || (Number.isFinite(healthFactor) && healthFactor < 1);
  const proximityScore = Number.isFinite(bpsToLiquidation) ? Math.max(0, Math.min(1, 1 - (bpsToLiquidation / 1000))) : 0;
  const profitPriorityScore = Math.round(
    proximityScore * 45
    + Math.min(1, potentialGrossBonusUsd / 1000) * 35
    + Math.min(1, debtUsd / 50_000) * 20
    + (liquidatable ? 25 : 0)
    - (debtUsd < MIN_DEBT_USD ? 35 : 0)
  );

  return {
    hub: row.hub || null,
    spoke: row.spoke || null,
    user: row.user,
    liquidatable,
    nearLiquidation: Boolean(row.nearLiquidation) || (Number.isFinite(healthFactor) && healthFactor >= 1 && healthFactor < 1.05),
    healthFactor: round(healthFactor, 9),
    bpsToLiquidation: round(bpsToLiquidation, 2),
    collateralDropToLiquidationPct: round(collateralDropToLiquidationPct, 4),
    debtUsd: round(debtUsd, 2),
    collateralUsd: round(collateralUsd, 2),
    potentialGrossBonusUsd: round(potentialGrossBonusUsd, 2),
    profitPriorityScore,
    materialDebt: debtUsd >= MIN_DEBT_USD,
    topDebt: topDebt ? {
      reserveId: topDebt.reserveId,
      symbol: topDebt.symbol,
      debtUsd: round(topDebt.debtUsd, 2),
      priceVsReferenceBps: round(topDebt.oracleData?.priceVsReferenceBps, 2),
    } : null,
    topCollateral: topCollateral ? {
      reserveId: topCollateral.reserveId,
      symbol: topCollateral.symbol,
      suppliedUsd: round(topCollateral.suppliedUsd, 2),
      liquidationBonusBps: topCollateralBonusBps,
      priceVsReferenceBps: round(topCollateral.oracleData?.priceVsReferenceBps, 2),
    } : null,
    quoteRequired: liquidatable && debtUsd >= MIN_DEBT_USD,
  };
}

function sourceCoverageForArtifact(artifact, options = {}) {
  const candidate = artifact?.sourceCoverage;
  const structural = validateAaveSourceCoverageEnvelope(candidate, {
    protocolVersion: "V4", coverageKind: "borrower-scan",
  });
  const raw = structural.valid ? candidate : {};
  const errors = structural.valid && Array.isArray(raw.errors) ? raw.errors.slice() : [];
  if (!structural.valid) errors.push(...structural.failures.map(code => `upstream-${code}`));
  const scanFailed = options.scanAttempted === true && options.scanOk !== true;
  if (scanFailed) errors.push("source-error");
  const input = {
    coverageKind: "monitor",
    upstreamCoverage: candidate,
    topologyGeneratedAt: raw.topologyGeneratedAt,
    topologySourceComplete: raw.topologySourceComplete,
    topologySourceSampleComplete: raw.topologySourceSampleComplete,
    topologyUniverse: raw.topologyUniverse,
    spokeReserveLinks: raw.spokeReserveLinks,
    chainsExpected: raw.chainsExpected,
    chainsObserved: raw.chainsObserved,
    spokesExpected: raw.spokesExpected,
    spokesObserved: raw.spokesObserved,
    observedRange: raw.observedRange,
    historyScope: raw.historyScope,
    historyStartBound: raw.historyStartBound,
    fullHistoryProven: raw.fullHistoryProven,
    observationPin: raw.observationPin,
    logChunksAttempted: raw.logChunksAttempted,
    logChunksSucceeded: raw.logChunksSucceeded,
    logChunksFailed: raw.logChunksFailed,
    discoveredBorrowers: raw.discoveredBorrowers,
    checkedBorrowers: raw.checkedBorrowers,
    accountReadsAttempted: raw.accountReadsAttempted,
    accountReadsSucceeded: raw.accountReadsSucceeded,
    accountReadsFailed: raw.accountReadsFailed,
    reserveReadsAttempted: raw.reserveReadsAttempted,
    reserveReadsSucceeded: raw.reserveReadsSucceeded,
    reserveReadsFailed: raw.reserveReadsFailed,
    truncationLimit: raw.truncationLimit,
    wasTruncated: raw.wasTruncated,
    excludedSpokes: raw.excludedSpokes,
    topologyRefreshAttempted: options.topologyRefreshAttempted ?? raw.topologyRefreshAttempted,
    topologyRefreshOk: options.topologyRefreshOk ?? raw.topologyRefreshOk,
    // Distinguish a scanner that actually threw ("topology-refresh-failed")
    // from one that ran and produced an unusable/incomplete artifact
    // ("topology-refresh-incomplete"). Both still fail closed.
    topologyRefreshError: options.topologyRefreshError,
    errors,
  };
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  return buildSourceCoverage(input, nowMs);
}

function boundedScalar(value, maxLength = 256) {
  if (typeof value === "string") return value.slice(0, maxLength);
  return value === null || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function compactScalars(value, limit = 64) {
  const out = {};
  for (const [key, child] of Object.entries(value || {}).slice(0, limit)) {
    const compact = boundedScalar(child);
    if (compact !== undefined) out[key] = compact;
  }
  return out;
}

function compactHistorySnapshot(snapshot) {
  const coverage = snapshot?.sourceCoverage || {};
  return {
    iteration: Number.isSafeInteger(snapshot?.iteration) ? snapshot.iteration : null,
    generatedAt: boundedScalar(snapshot?.generatedAt),
    sourceGeneratedAt: boundedScalar(snapshot?.sourceGeneratedAt),
    sourceScanner: SOURCE_SCANNER,
    sourceArtifact: SOURCE_ARTIFACT,
    sourceHealth: boundedScalar(snapshot?.sourceHealth),
    classification: boundedScalar(snapshot?.classification),
    complete: snapshot?.complete === true,
    summary: compactScalars(snapshot?.summary),
    sourceCoverage: {
      ...compactScalars(coverage),
      errors: (Array.isArray(coverage.errors) ? coverage.errors : [])
        .filter(error => typeof error === "string" && error)
        .slice(0, 32)
        .map(error => error.slice(0, 128)),
      observedRange: coverage.observedRange && typeof coverage.observedRange === "object" ? {
        fromBlock: Number.isSafeInteger(coverage.observedRange.fromBlock) ? coverage.observedRange.fromBlock : null,
        toBlock: Number.isSafeInteger(coverage.observedRange.toBlock) ? coverage.observedRange.toBlock : null,
      } : null,
    },
  };
}

function appendBoundedHistory(history, snapshot, limit = HISTORY_LIMIT, byteLimit = HISTORY_BYTE_LIMIT) {
  if (!Array.isArray(history)) throw new Error("history-not-array");
  const cap = Number.isSafeInteger(limit) && limit > 0 && limit <= HISTORY_LIMIT ? limit : HISTORY_LIMIT;
  const byteCap = Number.isSafeInteger(byteLimit) && byteLimit > 0 && byteLimit <= HISTORY_BYTE_LIMIT
    ? byteLimit : HISTORY_BYTE_LIMIT;
  let state = historySizes.get(history);
  if (!state || state.rowBytes.length !== history.length) {
    state = { rowBytes: history.map(row => Buffer.byteLength(JSON.stringify(row))) };
  }
  let compact = compactHistorySnapshot(snapshot);
  let rowBytes = Buffer.byteLength(JSON.stringify(compact));
  if (rowBytes + 2 > byteCap) {
    compact = {
      iteration: Number.isSafeInteger(snapshot?.iteration) ? snapshot.iteration : null,
      generatedAt: boundedScalar(snapshot?.generatedAt),
      classification: boundedScalar(snapshot?.classification),
      complete: snapshot?.complete === true,
    };
    rowBytes = Buffer.byteLength(JSON.stringify(compact));
  }
  history.push(compact);
  state.rowBytes.push(rowBytes);
  let serializedBytes = state.rowBytes.reduce((sum, bytes) => sum + bytes, 0) + Math.max(0, history.length - 1) + 2;
  while (history.length > cap || serializedBytes > byteCap) {
    serializedBytes -= state.rowBytes[0] + (history.length > 1 ? 1 : 0);
    history.shift();
    state.rowBytes.shift();
  }
  historySizes.set(history, state);
  return history;
}

function summarizeBorrowers(artifact, options = {}) {
  const sourceCoverage = sourceCoverageForArtifact(artifact, options);
  const sourceComplete = sourceCoverage.complete;
  const sampleTelemetryUsable = sourceCoverage.sampleComplete === true;
  const closestRows = (sampleTelemetryUsable && Array.isArray(artifact?.topUsers) ? artifact.topUsers : [])
    .map(userRow)
    .filter((row) => (asNumber(row.debtUsd) || 0) > 0)
    .sort((a, b) => {
      const ah = asNumber(a.healthFactor) ?? Number.POSITIVE_INFINITY;
      const bh = asNumber(b.healthFactor) ?? Number.POSITIVE_INFINITY;
      return ah - bh || (asNumber(b.debtUsd) || 0) - (asNumber(a.debtUsd) || 0);
    });
  const profitRankedRows = closestRows.slice().sort((a, b) => {
    const ar = asNumber(a.profitPriorityScore) ?? -Infinity;
    const br = asNumber(b.profitPriorityScore) ?? -Infinity;
    return br - ar
      || (asNumber(b.potentialGrossBonusUsd) || 0) - (asNumber(a.potentialGrossBonusUsd) || 0)
      || (asNumber(a.bpsToLiquidation) ?? Infinity) - (asNumber(b.bpsToLiquidation) ?? Infinity);
  });
  const materialRows = profitRankedRows.filter((row) => row.materialDebt);
  const top = materialRows[0] || profitRankedRows[0] || null;
  const closest = closestRows[0] || null;
  const liquidatableRows = closestRows.filter((row) => row.liquidatable);
  const triggerRows = closestRows.filter((row) => (asNumber(row.bpsToLiquidation) ?? Infinity) <= TRIGGER_BPS);
  const materialTriggerRows = triggerRows.filter((row) => row.materialDebt);
  const quoteRows = liquidatableRows.filter((row) => row.quoteRequired);
  const routePositive = sourceComplete ? asNumber(artifact?.summary?.routePositive) || 0 : 0;

  return {
    generatedAt: new Date().toISOString(),
    sourceGeneratedAt: artifact?.generatedAt || null,
    sourceScanner: SOURCE_SCANNER,
    sourceArtifact: SOURCE_ARTIFACT,
    sourceHealth: sourceCoverage.sampleComplete === true ? "OK" : "INVALID",
    classification: sourceCoverage.classification,
    complete: sourceCoverage.complete,
    blocker: sourceCoverage.blocker,
    sourceCoverage,
    chain: artifact?.chain || null,
    query: artifact?.query || null,
    summary: {
      activeBorrowers: sampleTelemetryUsable ? artifact?.summary?.activeBorrowers || 0 : 0,
      nearLiquidation: sampleTelemetryUsable ? artifact?.summary?.nearLiquidation || 0 : 0,
      liquidatable: sampleTelemetryUsable ? artifact?.summary?.liquidatable || 0 : 0,
      routePositive,
      signedActionJustified: false,
      sampleOnly: !sourceComplete,
      observational: sourceCoverage.classification === "BOUNDED_OBSERVATIONAL",
      sampleTelemetryUsable,
      topHealthFactor: top?.healthFactor ?? null,
      topBpsToLiquidation: top?.bpsToLiquidation ?? null,
      topDebtUsd: top?.debtUsd ?? null,
      topPotentialGrossBonusUsd: top?.potentialGrossBonusUsd ?? null,
      topRankReason: !sourceComplete ? "bounded-sample-telemetry-only" : top?.materialDebt ? "profit-weighted-material" : "closest-dust-fallback",
      closestHealthFactor: closest?.healthFactor ?? null,
      closestBpsToLiquidation: closest?.bpsToLiquidation ?? null,
      closestDebtUsd: closest?.debtUsd ?? null,
      triggerBps: TRIGGER_BPS,
      triggerRows: triggerRows.length,
      materialTriggerRows: materialTriggerRows.length,
      materialRows: materialRows.length,
      quoteRequiredRows: quoteRows.length,
      minDebtUsd: MIN_DEBT_USD,
      forkGate: routePositive > 0 ? "route-positive-needs-fork-proof" : "closed-route-positive-zero",
      nextAction: !sourceComplete
        ? "Refresh complete hub topology and required-chain log coverage before using borrower health."
        : quoteRows.length > 0
        ? "Build exact repay-token acquisition and collateral-exit quotes for top liquidatable row; fork only if net positive."
        : materialTriggerRows.length > 0
          ? "Continue short-interval read-only Aave watcher; exact-quote only after HF < 1."
          : triggerRows.length > 0
            ? "Closest trigger rows are below the material debt gate; keep watching profit-ranked rows and exact-quote only after HF < 1."
          : "Keep normal read-only refresh cadence; no fork or quote work yet.",
    },
    topRows: (materialRows.length ? materialRows : profitRankedRows).slice(0, 10),
    closestRows: closestRows.slice(0, 10),
    profitRankedRows: profitRankedRows.slice(0, 10),
    triggerRows: triggerRows.slice(0, 10),
    materialTriggerRows: materialTriggerRows.slice(0, 10),
    quoteRequiredRows: quoteRows.slice(0, 10),
  };
}

function buildWatchArtifact(snapshot, history, topology = {}, options = {}) {
  return {
    schema: AAVE_V4_WATCH_SCHEMA,
    generatedAt: options.generatedAt || new Date().toISOString(),
    scanner: WATCH_SCANNER,
    sourceScanner: SOURCE_SCANNER,
    sourceArtifact: SOURCE_ARTIFACT,
    source: { scanner: SOURCE_SCANNER, artifact: SOURCE_ARTIFACT },
    scope: "Read-only Aave V4 near-liquidation trigger watcher",
    classification: snapshot.sourceCoverage.classification,
    complete: snapshot.sourceCoverage.complete,
    blocker: snapshot.sourceCoverage.blocker,
    sourceCoverage: snapshot.sourceCoverage,
    safety: {
      rpcInventoryRead: !SKIP_SCAN,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: (asNumber(snapshot.summary.routePositive) || 0) > 0,
      signedActionJustified: false,
      executableNow: false,
    },
    config: {
      iterations: ITERATIONS,
      intervalMs: ITERATIONS > 1 ? INTERVAL_MS : 0,
      triggerBps: TRIGGER_BPS,
      minDebtUsd: MIN_DEBT_USD,
      skipScan: SKIP_SCAN,
      refreshQuotes: !NO_QUOTES,
      refreshSweep: !NO_SWEEP,
      topologyBootstrap: {
        script: "tools/scan-aave-v4-hubs.js",
        trigger: "missing-stale-or-source-incomplete-or-insufficient-headroom",
        readOnly: true,
        bounded: true,
        attempted: topology.topologyRefreshAttempted === true,
        ok: topology.topologyRefreshOk === true,
      },
    },
    gates: {
      forkOnlyAfter: [
        "a borrower is currently liquidatable",
        "exact repay-token acquisition quote is available",
        "exact collateral-exit quote is available",
        "gas/slippage-adjusted net profit is positive",
        "fork extraction proof succeeds",
      ],
    },
    latest: snapshot,
    history,
  };
}

async function main() {
  const history = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const topology = SKIP_SCAN
      ? { topologyRefreshAttempted: false, topologyRefreshOk: topologyUsable(loadJson(HUBS_FILE, null)) }
      : refreshTopologyIfNeeded();
    let scanOk = topology.topologyRefreshOk;
    let scanAttempted = false;
    if (!SKIP_SCAN) {
      if (topology.topologyRefreshOk) {
        scanAttempted = true;
        try {
          runNode(path.join("tools", "scan-aave-v4-spoke-borrowers.js"), [
            `--topology-refresh-attempted=${topology.topologyRefreshAttempted}`,
            `--topology-refresh-ok=${topology.topologyRefreshOk}`,
          ]);
        } catch (_) {
          scanOk = false;
        }
      }
    }
    const borrowers = loadJson(BORROWERS_FILE, {});
    const snapshot = summarizeBorrowers(borrowers, {
      scanAttempted,
      scanOk,
      topologyRefreshAttempted: topology.topologyRefreshAttempted,
      topologyRefreshOk: topology.topologyRefreshOk,
      topologyRefreshError: topology.error,
    });
    snapshot.iteration = i + 1;
    appendBoundedHistory(history, snapshot);

    const latest = buildWatchArtifact(snapshot, history, topology);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(forceMonitorOnlyArtifact(latest), null, 2)}\n`);

    if (!NO_QUOTES && snapshot.sourceCoverage.complete) {
      runNode(path.join("tools", "quote-aave-v4-liquidation-trigger.js"), ["--quiet"]);
      const quoteArtifact = loadJson(QUOTE_FILE, null);
      latest.quoteArtifact = quoteArtifact?.summary ? {
        generatedAt: quoteArtifact.generatedAt || null,
        quoteRequiredRows: quoteArtifact.summary.quoteRequiredRows || 0,
        rowsQuoted: quoteArtifact.summary.rowsQuoted || 0,
        researchPositiveRoutes: quoteArtifact.summary.researchPositiveRoutes || 0,
        routePositive: quoteArtifact.summary.routePositive || 0,
        executableNow: false,
        signedActionJustified: false,
        blocker: quoteArtifact.summary.blocker || null,
      } : null;
      fs.writeFileSync(OUT, `${JSON.stringify(forceMonitorOnlyArtifact(latest), null, 2)}\n`);
    }

    if (!NO_SWEEP && snapshot.sourceCoverage.complete) {
      runNode(path.join("tools", "scan-route-positive-sweep.js"), ["--quiet"]);
      runNode(path.join("tools", "scan-evaluator-proximity.js"), ["--quiet"]);
    }

    if (!QUIET) {
      const top = snapshot.topRows[0];
      console.log(`Aave V4 watch: active=${snapshot.summary.activeBorrowers} near=${snapshot.summary.nearLiquidation} liquidatable=${snapshot.summary.liquidatable} routePositive=${snapshot.summary.routePositive}`);
      console.log(`Closest: HF=${top?.healthFactor ?? "n/a"} bpsToLiq=${top?.bpsToLiquidation ?? "n/a"} debtUsd=${top?.debtUsd ?? "n/a"} collateral=${top?.topCollateral?.symbol || "n/a"}`);
      console.log(`Report: ${path.relative(WORKSPACE, OUT)}`);
    }

    if (i < ITERATIONS - 1) await sleep(INTERVAL_MS);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`watch-aave-v4-liquidation-triggers failed: ${err?.message || String(err)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  AAVE_V4_WATCH_SCHEMA,
  HISTORY_BYTE_LIMIT,
  HISTORY_LIMIT,
  SOURCE_ARTIFACT,
  SOURCE_SCANNER,
  TOPOLOGY_SCAN_HEADROOM_MS,
  WATCH_SCANNER,
  appendBoundedHistory,
  buildWatchArtifact,
  compactHistorySnapshot,
  forceMonitorOnlyArtifact,
  refreshTopologyIfNeeded,
  sourceCoverageForArtifact,
  summarizeBorrowers,
  topologyUsable,
};
