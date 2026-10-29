#!/usr/bin/env node
// autopilot-disabled-routes.js - reports routes intentionally not auto-executed.
// This is read-only and never reads keys, RPC inventory, or env files.

const fs = require("fs");
const path = require("path");
const { authorizationSafetySignals, forceMonitorOnlyArtifact, rememberAuthorizationSnapshot } = require("./monitor-minimal-env");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "monitor", "autopilot-disabled-routes.json");
const ROUTE_SWEEP = path.join(WORKSPACE, "reports", "raw", "fast", "route-positive-sweep.json");
const GLOBAL_GATES = path.join(WORKSPACE, "reports", "monitor", "global-gates-status.json");
const APYUSD_PREFLIGHT = path.join(WORKSPACE, "reports", "raw", "fast", "apyusd-receipt-live-preflight.json");
const AAVE_V4_WATCH = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-watch.json");

const args = process.argv.slice(2);
const QUIET = args.includes("--quiet");

function ts() {
  return new Date().toISOString();
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
  ensureDir(file);
  fs.writeFileSync(file, `${JSON.stringify(forceMonitorOnlyArtifact(value), null, 2)}\n`);
}

function asNumber(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function findRanked(routeSweep, id) {
  const ranked = Array.isArray(routeSweep?.ranked) ? routeSweep.ranked : [];
  return ranked.find((row) => row.id === id) || null;
}

function buildArtifact(options = {}) {
  const routeSweep = options.routeSweep ?? loadJson(ROUTE_SWEEP, {});
  const globalGates = options.globalGates ?? loadJson(GLOBAL_GATES, {});
  const apyusdPreflight = options.apyusdPreflight ?? loadJson(APYUSD_PREFLIGHT, {});
  const aaveV4Watch = options.aaveV4Watch ?? loadJson(AAVE_V4_WATCH, {});
  const apyusdRow = findRanked(routeSweep, "apyusd-erc4626-fork-proof-sweep");
  const aaveSummary = aaveV4Watch?.latest?.summary || {};
  const apyusdSummary = apyusdPreflight?.summary || {};
  const upstreamSafety = authorizationSafetySignals([routeSweep, globalGates, apyusdPreflight, aaveV4Watch], options);
  const authorization = upstreamSafety.liveBatchStatus;
  const authorizationApproved = authorization.authorizationState === "VALID";
  const hardStop = upstreamSafety.hardStop === true;

  const observedLowFundCandidates = [
    { id: "E1", name: "Compound CAPO/stale-oracle", fundingModel: "gas-only flash-loan", status: "observational candidate telemetry only", autoExecutable: false },
    { id: "E5", name: "Stablecoin depeg", fundingModel: "gas-only flash-loan", status: "observational candidate telemetry only", autoExecutable: false },
    { id: "E8", name: "Fluid stale oracle", fundingModel: "gas-only flash-loan", status: "observational candidate telemetry only", autoExecutable: false },
    { id: "E9", name: "Morpho liquidation", fundingModel: "gas-only flash-loan", status: "observational candidate telemetry only", autoExecutable: false },
    { id: "E10", name: "Cross-chain Aave route", fundingModel: "gas-only flash-loan", status: "observational candidate telemetry only", autoExecutable: false },
    { id: "E12x", name: "Morpho new-market stale-oracle", fundingModel: "gas-only flash-loan", status: "observational candidate telemetry only", autoExecutable: false },
    { id: "AAVE_V3", name: "Aave V3 liquidation", fundingModel: "gas-only flash liquidation", status: "observational candidate telemetry only", autoExecutable: false },
  ];

  const disabledRoutes = [
    {
      id: "apyusd-receipt",
      name: "apyUSD UnlockReceipt route",
      disabled: true,
      category: "capital-locked-delayed",
      reason: "Requires roughly $25k own apxUSD/apyUSD capital and 3-20 day receipt lock; receipt is soulbound and not flash-loanable.",
      sourceStatus: apyusdRow?.status || apyusdSummary.status || "disabled-capital-lock",
      routePositive: Boolean(apyusdRow?.routePositive || apyusdSummary.routePositive),
      executableNow: false,
      signedActionJustified: false,
      artifact: path.relative(WORKSPACE, APYUSD_PREFLIGHT),
    },
    {
      id: "lb-steth-premium",
      name: "Liquity Bold stETH/ETH premium",
      disabled: true,
      category: "break-even-not-met",
      reason: "Auto-exec is disabled in monitor-novelty-conditions.js unless a >22.6% stETH premium appears; current market does not meet this.",
      executableNow: false,
      signedActionJustified: false,
    },
    {
      id: "aave-v4-direct-repay",
      name: "Aave V4 direct repay liquidation",
      disabled: true,
      category: "capital-required-pretrigger",
      reason: "Direct repayment needs own capital and the current hot borrower remains above HF 1. Low-fund path stays read-only until exact quote and fork proof show a flash-compatible route.",
      sourceStatus: aaveSummary.forkGate || "closed-route-positive-zero",
      topHealthFactor: aaveSummary.topHealthFactor || aaveSummary.closestHealthFactor || null,
      liquidatable: asNumber(aaveSummary.liquidatable),
      executableNow: false,
      signedActionJustified: false,
      artifact: path.relative(WORKSPACE, AAVE_V4_WATCH),
    },
    {
      id: "e12-new-market-auto-borrow",
      name: "E12 new-market auto-borrow",
      disabled: true,
      category: "manual-capital-review",
      reason: "New-market capital deployment is manual review only; E12x stale-oracle observations remain candidate telemetry and never authorize execution.",
      executableNow: false,
      signedActionJustified: false,
    },
    {
      id: "lorenzo-susd1plus",
      name: "Lorenzo sUSD1+ inverse/NAV timing",
      disabled: true,
      category: "queued-exit-delayed",
      reason: "Public same-epoch NAV exit is unproven and request/withdraw uses queue semantics; keep disabled unless separately funded and proven.",
      executableNow: false,
      signedActionJustified: false,
    },
  ];

  return rememberAuthorizationSnapshot({
    generatedAt: ts(),
    scanner: "tools/autopilot-disabled-routes.js",
    scope: "Monitor-only candidate telemetry and disabled capital/delay route report",
    autoExecutable: false,
    liveBatchStatus: authorization,
    hardStop,
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      signedActionJustified: false,
      observedUpstreamAuthorizationSignal: upstreamSafety.observedUpstreamAuthorizationSignal === true,
      observedInvalidAuthorizationSignal: upstreamSafety.observedInvalidAuthorizationSignal === true,
      authorizationState: authorization.authorizationState,
      authorizationApproved,
      hardStop,
    },
    summary: {
      status: hardStop ? "hard-stop-upstream-authorization-signal" : "monitor-only-candidates-capital-routes-disabled",
      observedLowFundCandidates: observedLowFundCandidates.length,
      disabledRoutes: disabledRoutes.length,
      routePositive: asNumber(routeSweep?.summary?.routePositive || globalGates?.summary?.routePositive),
      executableNow: false,
      executableNowCount: 0,
      signedActionJustified: false,
      apyusdDisabled: true,
      autoExecutable: false,
      observedUpstreamAuthorizationSignal: upstreamSafety.observedUpstreamAuthorizationSignal === true,
      observedInvalidAuthorizationSignal: upstreamSafety.observedInvalidAuthorizationSignal === true,
      authorizationState: authorization.authorizationState,
      authorizationApproved,
      hardStop,
      nextAction: hardStop
        ? "Stop on the upstream signal. This report remains non-authoritative and cannot authorize execution."
        : "Review candidate telemetry separately; this artifact never authorizes execution. Keep capital-locked and delayed routes disabled and visible.",
    },
    observedLowFundCandidates,
    disabledRoutes,
    artifacts: {
      routeSweep: path.relative(WORKSPACE, ROUTE_SWEEP),
      globalGates: path.relative(WORKSPACE, GLOBAL_GATES),
      apyusdPreflight: path.relative(WORKSPACE, APYUSD_PREFLIGHT),
      aaveV4Watch: path.relative(WORKSPACE, AAVE_V4_WATCH),
      disabledRoutes: path.relative(WORKSPACE, OUT),
    },
  }, upstreamSafety);
}

function main() {
  const artifact = buildArtifact();
  writeJson(OUT, artifact);
  if (!QUIET) {
    console.log(`disabledRoutes=${artifact.summary.disabledRoutes} observedLowFundCandidates=${artifact.summary.observedLowFundCandidates} autoExecutable=false signedActionJustified=false`);
    for (const route of artifact.disabledRoutes) console.log(`DISABLED ${route.id}: ${route.reason}`);
    console.log(`artifact=${path.relative(WORKSPACE, OUT)}`);
  }
}

if (require.main === module) main();

module.exports = { buildArtifact };
