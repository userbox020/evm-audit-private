#!/usr/bin/env node
// aave-v3-liquidation-watch.js - read-only continuous Aave V3 HF/route watcher.
// Refreshes existing Aave V3 artifacts on a cadence and stops at the fork gate.
// It never reads private keys, signs transactions, deploys, or calls executors.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { minimalMonitorEnv, forceMonitorOnlyArtifact, authorizationSignalPresent } = require("./monitor-minimal-env");
const { buildAaveSourceCoverage, validateAaveSourceCoverageEnvelope } = require("./aave-source-coverage");

const WORKSPACE = path.resolve(__dirname, "..");
const ROUTE_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-route-distance.json");
const READINESS_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-trigger-readiness.json");
const SWEEP_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "route-positive-sweep.json");
const GATES_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "audit-completion-gates.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-liquidation-watch-status.json");

// Proven full-historical borrower universe (sibling scanner lane). Cited as coverage
// evidence only when its recorded hash matches a fresh local rehash of the CSV.
const UNIVERSE_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-borrower-universe.json");
const UNIVERSE_CSV_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-borrower-universe-users.csv");
const UNIVERSE_SCHEMA = "aave-v3-borrower-universe/v1";
const UNIVERSE_COVERAGE_CLASS = "FULL_HISTORICAL_BORROWERS_MAINNET_V3";
const UNIVERSE_RELATIVE = "reports/raw/fast/aave-v3-borrower-universe.json";
const OLD_HISTORY_BLOCKER = "Monitor inputs are bounded historical samples; active-position coverage is not complete.";

const args = process.argv.slice(2);
const QUIET = args.includes("--quiet");
const VERBOSE = args.includes("--verbose");
const ONCE = args.includes("--once");
const FULL_REFRESH = args.includes("--full-refresh");
const UNTIL_TRIGGER = args.includes("--until-trigger") || (!ONCE && !argValue("--max-cycles"));
const INTERVAL_MS = Math.max(10_000, Number(argValue("--interval-ms") || "60000") || 60_000);
const MAX_CYCLES = Math.max(1, Number(argValue("--max-cycles") || (ONCE ? "1" : UNTIL_TRIGGER ? "1000000" : "1")) || 1);
const TIMEOUT_MS = Math.max(60_000, Number(argValue("--timeout-ms") || "600000") || 600_000);
const MAX_SOURCE_AGE_MS = finitePositive(argValue("--max-source-age-ms"), 5 * 60_000, 5 * 60_000);
const LAUNCHER_MODE = !ONCE && UNTIL_TRIGGER;
const CHAINS_EXPECTED = 9;

function finitePositive(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function argValue(name) {
  const prefix = `${name}=`;
  const item = args.find((arg) => arg.startsWith(prefix));
  if (item) return item.slice(prefix.length);
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
}

function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(forceMonitorOnlyArtifact(value), null, 2)}\n`);
}

function sha256File(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch (_) {
    return null;
  }
}

// Read the sibling borrower-universe artifact and rehash its canonical CSV. The
// proof is only "verified" when the artifact self-declares the V3 full-historical
// class, chainId 1, and fullHistoryProven, AND the recorded universeSha256 equals
// a fresh local rehash of the CSV. Anything else stays fail-closed (old class).
function readUniverseCoverage(options = {}) {
  const verifiedAt = options.verifiedAt || new Date().toISOString();
  try {
    if (!fs.existsSync(UNIVERSE_FILE)) return { present: false, verified: false, reason: "universe-artifact-absent" };
    const artifact = JSON.parse(fs.readFileSync(UNIVERSE_FILE, "utf8"));
    // Version binding: the V3 universe schema (or an explicit protocolVersion field).
    const versionOk = artifact.protocolVersion === "V3" || artifact.schema === UNIVERSE_SCHEMA;
    const classOk = artifact.coverageClass === UNIVERSE_COVERAGE_CLASS;
    const chainOk = artifact.chainId === 1;
    const provenOk = artifact.fullHistoryProven === true;
    const base = {
      present: true,
      schema: typeof artifact.schema === "string" ? artifact.schema : null,
      artifact: UNIVERSE_RELATIVE,
      universeSha256: typeof artifact.universeSha256 === "string" ? artifact.universeSha256.toLowerCase() : null,
      verifiedAt,
      fullHistoryProven: provenOk,
      chainId: Number.isInteger(artifact.chainId) ? artifact.chainId : null,
      coverageClass: typeof artifact.coverageClass === "string" ? artifact.coverageClass : null,
      dedupedBorrowersCount: Number.isInteger(artifact.dedupedBorrowersCount) ? artifact.dedupedBorrowersCount : null,
    };
    if (!versionOk || !classOk || !chainOk || !provenOk) {
      return { ...base, verified: false, reason: "universe-artifact-not-qualified" };
    }
    const fresh = sha256File(UNIVERSE_CSV_FILE);
    const verified = fresh !== null && typeof base.universeSha256 === "string" && fresh === base.universeSha256;
    return { ...base, verified, reason: verified ? null : "universe-csv-hash-mismatch" };
  } catch (_) {
    return { present: false, verified: false, reason: "universe-artifact-unreadable" };
  }
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return null;
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
    env: minimalMonitorEnv(),
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    maxBuffer: 50 * 1024 * 1024,
    timeout: options.timeoutMs || TIMEOUT_MS,
  });
  if (result.error) throw new Error(`${path.basename(script)}-failed`);
  if (result.status !== 0) {
    throw new Error(`${path.basename(script)}-failed`);
  }
  if (options.printOutput && result.stdout) process.stdout.write(result.stdout);
  return result;
}

function sourceTime(value, nowMs, maxAgeMs, label, errors) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    errors.push(`${label}-generated-at-invalid`);
    return null;
  }
  const age = nowMs - time;
  if (age < -60_000) errors.push(`${label}-generated-at-future`);
  if (age > maxAgeMs) errors.push(`${label}-stale`);
  return time;
}

function routeCoverage(route, nowMs, maxAgeMs) {
  const errors = [];
  const summary = route?.summary || {};
  const candidate = route?.sourceCoverage;
  const validation = validateAaveSourceCoverageEnvelope(candidate, {
    protocolVersion: "V3", coverageKind: "route-scan", requireSampleComplete: true,
  });
  // Keep the producer's real counters for diagnostics even when the envelope is not
  // sample-complete. Zeroing them here fabricated a "log-chunk-coverage-empty" error
  // (0/0 chunks) for a route scan that had actually attempted chunks and failed some of
  // them. Fail-closed classification is still driven by `validation` and the derived
  // error codes, so this changes only what is reported, not whether coverage is accepted.
  const coverage = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {};
  const reportedChainsExpected = Math.max(0, Math.trunc(asNumber(coverage.chainsExpected ?? summary.chainsRequested) || 0));
  const chainsExpected = CHAINS_EXPECTED;
  const chainsObserved = Math.max(0, Math.trunc(asNumber(coverage.chainsObserved ?? summary.chainsScanned) || 0));
  const routeTime = sourceTime(route?.generatedAt, nowMs, maxAgeMs, "route", errors);
  if (!validation.valid) errors.push(...validation.failures.map(code => `route-source-${code}`));
  if (reportedChainsExpected !== chainsExpected) errors.push("required-chain-set-mismatch");
  if (chainsObserved !== chainsExpected) errors.push("required-chain-coverage-incomplete");
  const count = (name) => Math.max(0, Math.trunc(asNumber(coverage[name]) || 0));
  const logChunksAttempted = count("logChunksAttempted");
  const logChunksSucceeded = count("logChunksSucceeded");
  const logChunksFailed = count("logChunksFailed");
  const discoveredBorrowers = count("discoveredBorrowers");
  const checkedBorrowers = count("checkedBorrowers");
  const accountReadsAttempted = count("accountReadsAttempted");
  const accountReadsSucceeded = count("accountReadsSucceeded");
  const accountReadsFailed = count("accountReadsFailed");
  const reserveReadsAttempted = count("reserveReadsAttempted");
  const reserveReadsSucceeded = count("reserveReadsSucceeded");
  const reserveReadsFailed = count("reserveReadsFailed");
  if (logChunksAttempted === 0) errors.push("log-chunk-coverage-empty");
  if (logChunksFailed > 0 || logChunksSucceeded !== logChunksAttempted) errors.push("route-log-chunk-failed");
  if (coverage.wasTruncated === true) errors.push("route-truncated");
  if (discoveredBorrowers !== checkedBorrowers || checkedBorrowers !== accountReadsAttempted) errors.push("account-read-skipped");
  if (accountReadsFailed > 0 || accountReadsSucceeded !== accountReadsAttempted) errors.push("account-read-failed");
  if (reserveReadsFailed > 0 || reserveReadsSucceeded !== reserveReadsAttempted) errors.push("reserve-read-failed");
  return {
    routeTime, chainsExpected, chainsObserved, logChunksAttempted, logChunksSucceeded,
    logChunksFailed, discoveredBorrowers, checkedBorrowers, accountReadsAttempted,
    accountReadsSucceeded, accountReadsFailed, reserveReadsAttempted, reserveReadsSucceeded,
    reserveReadsFailed, truncationLimit: count("truncationLimit"), wasTruncated: coverage.wasTruncated === true,
    requiredChainIds: Array.isArray(coverage.requiredChainIds) ? coverage.requiredChainIds : [],
    observedChainIds: Array.isArray(coverage.observedChainIds) ? coverage.observedChainIds : [],
    observedRanges: Array.isArray(coverage.observedRanges) ? coverage.observedRanges : [],
    historyScope: coverage.historyScope || "UNDECLARED",
    fullHistoryProven: coverage.fullHistoryProven === true,
    errors,
  };
}

function buildSourceCoverage(route, readiness, context = {}) {
  const nowMs = Number.isFinite(context.nowMs) ? context.nowMs : Date.now();
  const maxSourceAgeMs = finitePositive(context.maxSourceAgeMs, MAX_SOURCE_AGE_MS, 5 * 60_000);
  const routeRefreshAttempted = context.routeRefreshAttempted === true;
  const routeRefreshOk = routeRefreshAttempted && context.routeRefreshOk === true;
  const routeResult = routeCoverage(route, nowMs, maxSourceAgeMs);
  const errors = [...routeResult.errors];
  const readinessTime = sourceTime(readiness?.generatedAt, nowMs, maxSourceAgeMs, "readiness", errors);
  const readinessCandidate = readiness?.sourceCoverage;
  // Structural check without requiring sample completeness preserves the readiness
  // producer's real read counters for diagnostics. Validity/completeness is still decided
  // by `readinessValidation`, so an incomplete readiness source keeps failing closed instead
  // of being reported as having performed no reads.
  const readinessEnvelope = validateAaveSourceCoverageEnvelope(readinessCandidate, {
    protocolVersion: "V3", coverageKind: "readiness",
  });
  const readinessValidation = validateAaveSourceCoverageEnvelope(readinessCandidate, {
    protocolVersion: "V3", coverageKind: "readiness", requireSampleComplete: true,
  });
  const readinessCoverage = readinessEnvelope.valid ? readinessCandidate : {};
  const readinessCount = (name) => Math.max(0, Math.trunc(asNumber(readinessCoverage[name]) || 0));
  const readinessStateReadsAttempted = readinessCount("readinessStateReadsAttempted");
  const readinessStateReadsSucceeded = readinessCount("readinessStateReadsSucceeded");
  const readinessStateReadsFailed = readinessCount("readinessStateReadsFailed");
  const readinessAccountReadsAttempted = readinessCount("readinessAccountReadsAttempted");
  const readinessAccountReadsSucceeded = readinessCount("readinessAccountReadsSucceeded");
  const readinessAccountReadsFailed = readinessCount("readinessAccountReadsFailed");
  if (!readinessValidation.valid) errors.push(...readinessValidation.failures.map(code => `readiness-source-${code}`));
  if (readinessStateReadsAttempted === 0) errors.push("readiness-state-reads-empty");
  if (readinessStateReadsFailed > 0 || readinessStateReadsSucceeded !== readinessStateReadsAttempted) errors.push("readiness-state-read-failed");
  if (readinessAccountReadsAttempted === 0) errors.push("readiness-account-read-skipped");
  if (readinessAccountReadsFailed > 0 || readinessAccountReadsSucceeded !== readinessAccountReadsAttempted) errors.push("readiness-account-read-failed");
  if (routeResult.routeTime !== null && readinessTime !== null && readinessTime < routeResult.routeTime) {
    errors.push("readiness-predates-route");
  }
  if (routeRefreshAttempted && !routeRefreshOk) errors.push("route-refresh-failed");
  if (context.requireRouteRefresh === true && !routeRefreshAttempted) errors.push("route-refresh-required");
  for (const code of context.errors || []) {
    if (["readiness-refresh-failed", "route-refresh-failed"].includes(code)) errors.push(code);
  }
  const uniqueErrors = [...new Set(errors)];
  const upstreamFullHistoryProven = routeResult.fullHistoryProven && readinessCoverage.fullHistoryProven === true;
  const sampleComplete = uniqueErrors.length === 0;
  const exhaustiveProof = upstreamFullHistoryProven && routeResult.fullHistoryProven
    && route?.sourceCoverage?.complete === true && readinessCoverage.complete === true ? {
      type: "V3_MONITOR_EXACT_UPSTREAM_BOUNDS",
      exact: true,
      evidence: route.sourceCoverage.exhaustiveProof?.evidence || "upstream-exact-bound",
    } : null;

  // Proven full-historical candidate universe (additive coverage evidence). The
  // per-cycle sample stays bounded; only the coverage classification is upgraded,
  // and only when the recorded universe hash matches a fresh local rehash.
  const universe = context.universeCoverage || null;
  const universePresent = Boolean(universe && universe.present === true);
  const universeVerified = universePresent && universe.verified === true
    && universe.fullHistoryProven === true && universe.chainId === 1;
  const universeHash = typeof universe?.universeSha256 === "string" ? universe.universeSha256 : null;
  const coverageProof = universePresent && typeof universe.schema === "string" ? {
    schema: universe.schema,
    artifact: universe.artifact,
    universeSha256: universeHash,
    verifiedAt: universe.verifiedAt,
  } : null;
  const historicalBlocker = universeVerified
    ? `Bounded live-state sample per cycle; candidate universe coverage proven FULL_HISTORICAL via aave-v3-borrower-universe/v1 (hash ${universeHash.slice(0, 8)}…).`
    : null;

  return buildAaveSourceCoverage("V3", "monitor", {
    complete: sampleComplete && Boolean(exhaustiveProof),
    sampleComplete,
    historyScope: routeResult.historyScope,
    fullHistoryProven: universeVerified ? true : upstreamFullHistoryProven,
    historicalCoverageProven: universeVerified,
    coverageProofVerified: universeVerified,
    ...(coverageProof ? { coverageProof } : {}),
    exhaustiveProof,
    observedRanges: routeResult.observedRanges,
    blocker: historicalBlocker ? historicalBlocker : sampleComplete && exhaustiveProof ? null : !upstreamFullHistoryProven
      ? OLD_HISTORY_BLOCKER
      : "One or more fresh route or readiness reads are incomplete.",
    routeGeneratedAt: routeResult.routeTime === null ? null : route.generatedAt,
    readinessGeneratedAt: readinessTime === null ? null : readiness.generatedAt,
    maxSourceAgeMs,
    routeRefreshAttempted,
    routeRefreshOk,
    chainsExpected: routeResult.chainsExpected,
    chainsObserved: routeResult.chainsObserved,
    requiredChainIds: routeResult.requiredChainIds,
    observedChainIds: routeResult.observedChainIds,
    logChunksAttempted: routeResult.logChunksAttempted,
    logChunksSucceeded: routeResult.logChunksSucceeded,
    logChunksFailed: routeResult.logChunksFailed,
    discoveredBorrowers: routeResult.discoveredBorrowers,
    checkedBorrowers: routeResult.checkedBorrowers,
    accountReadsAttempted: routeResult.accountReadsAttempted,
    accountReadsSucceeded: routeResult.accountReadsSucceeded,
    accountReadsFailed: routeResult.accountReadsFailed,
    reserveReadsAttempted: routeResult.reserveReadsAttempted,
    reserveReadsSucceeded: routeResult.reserveReadsSucceeded,
    reserveReadsFailed: routeResult.reserveReadsFailed,
    stateReadsAttempted: routeResult.accountReadsAttempted + routeResult.reserveReadsAttempted + readinessStateReadsAttempted,
    stateReadsSucceeded: routeResult.accountReadsSucceeded + routeResult.reserveReadsSucceeded + readinessStateReadsSucceeded,
    stateReadsFailed: routeResult.accountReadsFailed + routeResult.reserveReadsFailed + readinessStateReadsFailed,
    readinessStateReadsAttempted,
    readinessStateReadsSucceeded,
    readinessStateReadsFailed,
    readinessAccountReadsAttempted,
    readinessAccountReadsSucceeded,
    readinessAccountReadsFailed,
    truncationLimit: routeResult.truncationLimit,
    wasTruncated: routeResult.wasTruncated,
    errors: uniqueErrors,
  });
}

function latestStatus(cycle, startedAt, artifacts = {}, context = {}) {
  const route = artifacts.route || readJson(ROUTE_FILE, {});
  const readiness = artifacts.readiness || readJson(READINESS_FILE, {});
  const sweep = artifacts.sweep || readJson(SWEEP_FILE, {});
  const gates = artifacts.gates || readJson(GATES_FILE, {});
  const routeSummary = route.summary || {};
  const readinessSummary = readiness.summary || {};
  const sweepSummary = sweep.summary || {};
  const gateSummary = gates.summary || {};
  const sourceCoverage = buildSourceCoverage(route, readiness, context);
  const sourceComplete = sourceCoverage.complete;
  const sampleTelemetryUsable = sourceCoverage.sampleComplete === true;
  const top = sampleTelemetryUsable && Array.isArray(route.globalTopRows) ? route.globalTopRows[0] : null;

  const currentLiquidatable = sampleTelemetryUsable ? asNumber(routeSummary.currentLiquidatable) || 0 : 0;
  const materialLiquidatable = sampleTelemetryUsable ? asNumber(routeSummary.materialLiquidatable) || 0 : 0;
  const exactEconomicsRows = sampleTelemetryUsable ? asNumber(routeSummary.exactEconomicsRows) || 0 : 0;
  const rowsWithAnyQuote = sampleTelemetryUsable ? asNumber(routeSummary.rowsWithAnyQuote) || 0 : 0;
  const routePositive = sourceComplete ? Math.max(
    asNumber(routeSummary.routePositive) || 0,
    asNumber(readinessSummary.routePositive) || 0
  ) : 0;
  const globalRoutePositive = sourceComplete
    ? Math.max(asNumber(sweepSummary.routePositive) || 0, asNumber(gateSummary.routePositive) || 0)
    : 0;
  const upstreamExecutableNow = sweepSummary.executableNow === true || gateSummary.executableNow === true;
  const upstreamSignedActionSignal = Boolean(sweepSummary.signedActionJustified || gateSummary.signedActionJustified);
  const upstreamAuthorizationSignal = upstreamExecutableNow
    || upstreamSignedActionSignal
    || authorizationSignalPresent(sweepSummary)
    || authorizationSignalPresent(gateSummary);
  const hardStop = upstreamAuthorizationSignal;
  const triggerReady = sourceComplete && Boolean(readinessSummary.triggerReady || currentLiquidatable > 0 || materialLiquidatable > 0);
  const exactReady = sourceComplete && Boolean(readinessSummary.exactEconomicsReady || (exactEconomicsRows > 0 && rowsWithAnyQuote > 0));
  const forkGateCandidate = triggerReady || exactReady || routePositive > 0 || hardStop;

  return {
    generatedAt: new Date().toISOString(),
    scanner: "tools/aave-v3-liquidation-watch.js",
    scope: "Read-only Aave V3 continuous liquidation/HF monitor",
    classification: sourceCoverage.classification,
    complete: sourceCoverage.complete,
    blocker: sourceCoverage.blocker,
    cycle,
    startedAt,
    sourceCoverage,
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: routePositive > 0,
      globalRoutePositive: globalRoutePositive > 0,
      executableNow: false,
      signedActionJustified: false,
      upstreamAuthorizationSignal,
      hardStop,
    },
    config: { intervalMs: INTERVAL_MS, maxCycles: MAX_CYCLES, untilTrigger: UNTIL_TRIGGER, fullRefresh: FULL_REFRESH, maxSourceAgeMs: MAX_SOURCE_AGE_MS },
    latest: {
      routeGeneratedAt: sourceCoverage.routeGeneratedAt,
      readinessGeneratedAt: sourceCoverage.readinessGeneratedAt,
      gateGeneratedAt: sourceComplete ? gates.generatedAt || null : null,
      chain: top?.chain || null,
      user: sampleTelemetryUsable ? top?.user || readiness.topRow?.borrower || null : null,
      healthFactor: sampleTelemetryUsable ? readinessSummary.currentHealthFactor ?? top?.healthFactor ?? null : null,
      bpsToLiquidation: sampleTelemetryUsable ? readinessSummary.bpsToLiquidation ?? top?.bpsToLiquidation ?? null : null,
      debtUsd: top?.totalDebtUsd ?? top?.topDebt?.usd ?? null,
      collateralUsd: top?.totalCollateralUsd ?? top?.topCollateral?.usd ?? null,
      topDebtSymbol: top?.topDebt?.symbol || null,
      topCollateralSymbol: top?.topCollateral?.symbol || null,
      watchCandidates: sampleTelemetryUsable ? asNumber(routeSummary.watchCandidates) || 0 : 0,
      currentLiquidatable,
      materialLiquidatable,
      exactEconomicsRows,
      rowsWithAnyQuote,
      triggerReady,
      exactReady,
      sourceAbiReady: sourceComplete && Boolean(readinessSummary.sourceAbiReady),
      deployedSelectorReady: sourceComplete && Boolean(readinessSummary.deployedSelectorReady),
      flashLiquidityReady: sourceComplete && Boolean(readinessSummary.flashLiquidityReady),
      forkProofReady: sourceComplete && Boolean(readinessSummary.forkProofReady),
      observedUpstreamLiveExecutorSignal: Boolean(readinessSummary.liveExecutorReady),
      liveExecutorReady: false,
      routePositive,
      globalRoutePositive,
      executableNow: false,
      signedActionJustified: false,
      upstreamAuthorizationSignal,
      hardStop,
      forkGateCandidate,
      sampleOnly: !sourceComplete,
      observational: sourceCoverage.classification === "BOUNDED_OBSERVATIONAL",
      sampleTelemetryUsable,
      blocker: sourceComplete
        ? readinessSummary.blocker || routeSummary.blocker || null
        : sampleTelemetryUsable ? sourceCoverage.blocker : "source-coverage-incomplete",
      globalGateStatus: sourceComplete ? gateSummary.status || null : null,
    },
    sourceArtifacts: {
      routeDistance: "reports/raw/fast/aave-v3-route-distance.json",
      triggerReadiness: "reports/raw/fast/aave-v3-trigger-readiness.json",
      routeSweep: "reports/raw/fast/route-positive-sweep.json",
      completionGates: "reports/raw/fast/audit-completion-gates.json",
    },
    gates: {
      forkOnlyAfter: [
        "current HF < 1 for a material borrower",
        "exact repay-token and seized-collateral sizing",
        "exact repay acquisition and collateral-exit quotes are net-positive after gas/slippage/flash fees",
        "patched deployed liquidator bytecode proves Aave V3 liquidationCall selector",
        "fresh fork/staticCall/estimateGas proof succeeds",
      ],
      liveActionRequires: ["explicit operator authorization", "fresh minProfit/minOut gates", "verified deployed bytecode"],
    },
  };
}

function printStatus(status) {
  const latest = status.latest;
  const prefix = latest.forkGateCandidate ? "TRIGGER" : "WATCH";
  console.log(
    `[${prefix} cycle=${status.cycle}] `
    + `${latest.chain || "n/a"} ${latest.user || "n/a"} `
    + `HF=${fmt(latest.healthFactor, 9)} bps=${fmt(latest.bpsToLiquidation, 2)} `
    + `debt=$${fmt(latest.debtUsd, 2)} ${latest.topDebtSymbol || ""}/${latest.topCollateralSymbol || ""} `
    + `liq=${latest.currentLiquidatable} exact=${latest.exactEconomicsRows} deployedSelector=${latest.deployedSelectorReady} `
    + `routePositive=${latest.routePositive} executableNow=${latest.executableNow}`
  );
  if ((VERBOSE || latest.forkGateCandidate) && latest.blocker) console.log(`  blocker: ${latest.blocker}`);
}

function printTriggerInstructions(status) {
  console.log("");
  console.log("AAVE V3 FORK GATE CANDIDATE - stopped before any fork, signed action, or executor call.");
  console.log(`User: ${status.latest.user || "n/a"}`);
  console.log(`HF=${fmt(status.latest.healthFactor, 9)} bps=${fmt(status.latest.bpsToLiquidation, 2)} debt=$${fmt(status.latest.debtUsd, 2)}`);
  console.log("Inspect these artifacts first:");
  console.log("  reports\\raw\\fast\\aave-v3-route-distance.json");
  console.log("  reports\\raw\\fast\\aave-v3-trigger-readiness.json");
  console.log("  reports\\raw\\fast\\route-positive-sweep.json");
  console.log("Required next gate: exact quotes, patched deployed liquidator verification, then fork/staticCall proof. Live action still requires explicit authorization.");
}

// Readiness is an independent read-only source. Gate its refresh on the route *artifact*
// being available, not on route sample-completeness. A complete route is not required for
// the readiness producer to perform and record its own reads; it fails closed on an
// incomplete upstream instead. Coupling the two left readiness permanently stale and empty
// whenever route discovery was bounded or partially failed.
function readinessRefreshGate(context = {}) {
  if (context.routeArtifactPresent !== true) return false;
  return context.routeRefreshAttempted !== true || context.routeRefreshOk === true;
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log("Aave V3 read-only liquidation watch");
  console.log(`intervalMs=${INTERVAL_MS} maxCycles=${MAX_CYCLES}${UNTIL_TRIGGER ? " untilTrigger=true" : ""} fullRefresh=${FULL_REFRESH}`);
  console.log("Safety: no private keys, no signed actions, no execute calls. Press Ctrl+C to stop.");

  let finalStatus = null;
  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    let routeRefreshAttempted = false;
    let routeRefreshOk = false;
    let readinessRefreshOk = false;
    const existingRoute = readJson(ROUTE_FILE, {});
    const existingRouteCoverage = routeCoverage(existingRoute, Date.now(), MAX_SOURCE_AGE_MS);
    const routeUsable = existingRouteCoverage.errors.length === 0;
    if (FULL_REFRESH || LAUNCHER_MODE || !routeUsable) {
      routeRefreshAttempted = true;
      try {
        runNode(path.join("tools", "scan-aave-v3-route-distance.js"), ["--quiet"], { inherit: VERBOSE && !QUIET });
        routeRefreshOk = true;
      } catch (_) {
        routeRefreshOk = false;
      }
    }
    const route = readJson(ROUTE_FILE, {});
    const routeArtifactPresent = Boolean(route && typeof route === "object" && typeof route.generatedAt === "string");
    const refreshGateOpen = readinessRefreshGate({ routeArtifactPresent, routeRefreshAttempted, routeRefreshOk });
    if (refreshGateOpen) {
      try {
        runNode(path.join("tools", "audit-aave-v3-trigger-readiness.js"), ["--quiet"], { inherit: VERBOSE && !QUIET });
        readinessRefreshOk = true;
      } catch (_) {
        readinessRefreshOk = false;
      }
      try {
        runNode(path.join("tools", "scan-route-positive-sweep.js"), ["--quiet"]);
        runNode(path.join("tools", "scan-audit-completion-gates.js"), ["--quiet"]);
      } catch (_) {}
    }

    const universeCoverage = readUniverseCoverage();
    finalStatus = latestStatus(cycle, startedAt, { route }, {
      routeRefreshAttempted,
      routeRefreshOk,
      requireRouteRefresh: LAUNCHER_MODE,
      maxSourceAgeMs: MAX_SOURCE_AGE_MS,
      universeCoverage,
      errors: refreshGateOpen && !readinessRefreshOk ? ["readiness-refresh-failed"] : [],
    });
    writeJson(OUT, finalStatus);
    printStatus(finalStatus);

    if (finalStatus.latest.forkGateCandidate) {
      printTriggerInstructions(finalStatus);
      process.exitCode = 2;
      return;
    }
    if (cycle >= MAX_CYCLES || ONCE) break;
    await sleep(INTERVAL_MS);
  }

  if (finalStatus) {
    console.log(`No Aave V3 trigger. Status artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`aave-v3-liquidation-watch failed: ${err?.message || String(err)}`);
    process.exitCode = 1;
  });
}

module.exports = { CHAINS_EXPECTED, MAX_SOURCE_AGE_MS, UNIVERSE_FILE, UNIVERSE_CSV_FILE, UNIVERSE_SCHEMA, UNIVERSE_COVERAGE_CLASS, OLD_HISTORY_BLOCKER, readUniverseCoverage, buildSourceCoverage, latestStatus, routeCoverage, readinessRefreshGate, writeJson };
