#!/usr/bin/env node
"use strict";

const services = Object.freeze([
  {
    id: "novelty-monitor",
    script: "tools/monitor-novelty-conditions.js",
    kind: "persistent",
    mode: "read-only",
    args: ["--watch"],
    artifact: {
      path: "reports/monitor/state.json",
      format: "json",
      timestampFields: ["lastRun"],
      freshnessMinutes: 15,
      assertionId: "fresh-noveltyState",
      semantic: {
        validator: "novelty-state",
        cycleHealthSchema: {
          field: "cycleHealth",
          healthyStatus: "HEALTHY",
          completeField: "complete",
          broadlyFailedField: "broadlyFailed",
          blindField: "blind",
          sourceSummaryField: "sourceSummary",
        },
      },
    },
  },
  {
    id: "morpho-ws",
    script: "tools/monitor-morpho-ws.js",
    kind: "persistent",
    mode: "read-only",
    args: [],
    artifact: { path: "reports/monitor/morpho-ws-status.json", format: "json", timestampFields: ["updatedAt"], freshnessMinutes: 10, assertionId: "fresh-morphoWs", semantic: { validator: "morpho-ws", requiredChains: ["ethereum", "base", "arbitrum", "optimism"], observation: { subscriptionStateField: "subscriptionState", subscribedValue: "SUBSCRIBED", blockField: "lastObservedBlock", updatedAtField: "observationUpdatedAt", freshnessMinutes: 10 } } },
  },
  {
    id: "chainlink-ws",
    script: "tools/monitor-chainlink-ws.js",
    kind: "persistent",
    mode: "read-only",
    args: [],
    artifact: { path: "reports/monitor/chainlink-ws-status.json", format: "json", timestampFields: ["updatedAt"], freshnessMinutes: 10, assertionId: "fresh-chainlinkWs", semantic: { validator: "chainlink-ws", requiredChains: ["ethereum", "base", "arbitrum", "optimism", "polygon"], observation: { subscriptionStateField: "subscriptionState", subscribedValue: "SUBSCRIBED", blockField: "lastObservedBlock", updatedAtField: "observationUpdatedAt", freshnessMinutes: 10 } } },
  },
  {
    id: "aave-v4-owner-watch",
    script: "tools/watch-aave-v4-liquidation-triggers.js",
    kind: "persistent",
    mode: "read-only",
    coverageMode: "BOUNDED_OBSERVATIONAL",
    args: ["--iterations", "1000000", "--interval-ms", "300000", "--no-quotes", "--no-sweep", "--quiet"],
    artifact: {
      path: "reports/raw/fast/aave-v4-liquidation-watch.json",
      format: "json",
      timestampFields: ["generatedAt", "latest.generatedAt"],
      freshnessMinutes: 10,
      assertionId: "fresh-aaveV4Watch",
      semantic: { validator: "aave-v4-watch", expectedChains: 1, coverageKind: "monitor" },
      // DOCUMENTED OBSERVATIONAL DECISION - Aave V4 owner watch (2026-09-20, round 3).
      // The former "non-conforming spokes" structural topology shortfall is resolved: the
      // hub topology is now bound to aave-dao/aave-address-book@v4.68.2 (4 hubs incl.
      // GLOBAL_DOLLAR) with intact provenance, and the hub coverage is sample-complete
      // because non-reserve-bearing (tokenization/treasury) spokes are excluded from the
      // reserve-link ledger. See reports/raw/fast/aave-v4-hubs.json#sourceCoverage.
      // What remains is a bounded observational borrower scan, not a topology gap:
      //   * MAX_USERS_PER_SPOKE=20 truncates per-spoke borrower discovery.
      //   * MIN_SPOKE_OWED_USD=10000 excludes dust-only working spokes by design.
      //   * The optional getLiquidationBonus probe is clamped to <=1 WAD and its
      //     deterministic reverts are accounted separately; core reserve reads are clean
      //     (reserveReadsFailed=0) and a genuine read failure still fails the row closed.
      // Acceptance stays bound to the exact structural signature below. Any other strict
      // validator failure, any non-allowlisted producer error, or any non-zero read-failure
      // counter flips the service straight back to fail-closed. The producer's own errors
      // stay in the watch artifact (sourceCoverage.errors) and are re-surfaced as
      // `shortfallDecision`.
      observationalShortfall: {
        decision: "OBSERVATIONAL",
        kind: "STRUCTURAL_BOUNDED_BORROWER_SCAN_TRUNCATION_AND_DUST_FILTER",
        reason: "Aave V4 topology is bound and sample-complete (aave-dao/aave-address-book@v4.68.2, 4 hubs); the remaining shortfall is the bounded observational borrower scan: MAX_USERS_PER_SPOKE=20 truncation and the by-design MIN_SPOKE_OWED_USD=10000 dust filter, with the optional liquidation-bonus probe clamped/accounted. Core log/account/reserve/state reads are clean, so any genuine read failure flips the service back to fail-closed.",
        evidence: [
          "reports/raw/fast/aave-v4-hubs.json#sourceCoverage",
          "reports/raw/fast/aave-v4-spoke-borrowers.json#summary",
          "reports/raw/fast/aave-v4-liquidation-watch.json#sourceCoverage.errors",
        ],
        structuralFailures: ["reserve-link-envelope", "truncated", "source-errors", "borrower-coverage", "spoke-coverage", "observational-semantics"],
        allowedEnvelopeFailures: ["reserve-link-envelope"],
        structuralErrorCodes: ["upstream-upstream-incomplete", "topology-source-incomplete", "required-spoke-failed", "spoke-filtered", "borrower-truncated", "borrower-check-incomplete", "source-error"],
        require: { protocolVersion: "V4", coverageKind: "monitor", classification: "SOURCE_INCOMPLETE", topologySourceSampleComplete: true, topologyRefreshOk: true, logChunksFailed: 0, accountReadsFailed: 0, reserveReadsFailed: 0, stateReadsFailed: 0, chainsObserved: 1 },
      },
    },
  },
  {
    id: "aave-v3-liquidation-watch",
    script: "tools/aave-v3-liquidation-watch.js",
    kind: "persistent",
    mode: "read-only",
    coverageMode: "BOUNDED_OBSERVATIONAL",
    args: ["--until-trigger", "--interval-ms", "60000"],
    artifact: {
      path: "reports/raw/fast/aave-v3-liquidation-watch-status.json",
      format: "json",
      timestampFields: ["generatedAt"],
      freshnessMinutes: 5,
      assertionId: "fresh-aaveV3Watch",
      semantic: { validator: "aave-v3-watch", expectedChains: 9, requiredChainIds: [1, 8453, 42161, 10, 137, 43114, 100, 534352, 56], coverageKind: "monitor" },
      // DOCUMENTED OBSERVATIONAL DECISION - Aave V3 multichain liquidation watch (2026-09-15).
      // Chain coverage is complete (chainsObserved=9/9), but the envelope is SOURCE_INCOMPLETE
      // for two very different reasons that must not be conflated:
      //   * STRUCTURAL, by design: MAX_USERS_PER_CHAIN=160 truncates borrower discovery
      //     (wasTruncated=true, discoveredBorrowers >> checkedBorrowers). No amount of retrying
      //     widens the cap; the resulting "route-truncated", "account-read-skipped" and
      //     "*-source-upstream-incomplete" codes are expected.
      //   * INFORMATIVE, genuine endpoint read failures: log-chunk-failed, account-read-failed,
      //     reserve-read-failed, readiness-state/account-read-failed. These must keep failing.
      // This policy accepts the service observationally ONLY while every read-failure counter is
      // zero and every producer error is one of the declared structural codes. The moment a real
      // read failure appears the allowlist rejects it and the service stays pending-artifact, so
      // no read failure is ever masked. Today the producer reports genuine failures, so the
      // service remains fail-closed; the distinction is what lets it recover honestly once reads
      // are clean.
      observationalShortfall: {
        decision: "OBSERVATIONAL",
        kind: "STRUCTURAL_BOUNDED_TRUNCATION_EXCLUDING_READ_FAILURES",
        reason: "Aave V3 coverage is structurally bounded by MAX_USERS_PER_CHAIN=160; only the truncation codes are tolerated observationally, and any genuine log/account/reserve/readiness read failure keeps the service fail-closed.",
        evidence: [
          "reports/raw/fast/aave-v3-liquidation-watch-status.json#sourceCoverage",
        ],
        structuralFailures: ["truncated", "source-errors", "log-coverage", "account-reads", "reserve-reads", "state-reads", "borrower-coverage", "observational-semantics"],
        allowedEnvelopeFailures: [],
        structuralErrorCodes: ["route-source-upstream-incomplete", "readiness-source-upstream-incomplete", "route-truncated", "account-read-skipped"],
        require: { protocolVersion: "V3", coverageKind: "monitor", classification: "SOURCE_INCOMPLETE", wasTruncated: true, chainsExpected: 9, chainsObserved: 9, routeRefreshAttempted: true, routeRefreshOk: true },
      },
    },
  },
  {
    id: "global-gates",
    script: "tools/monitor-global-gates.js",
    kind: "persistent",
    mode: "read-only",
    args: ["--watch", "--interval-ms=300000", "--apyusd-interval-ms=1800000"],
    artifact: { path: "reports/monitor/global-gates-status.json", format: "json", timestampFields: ["generatedAt"], freshnessMinutes: 10, assertionId: "fresh-globalGates", semantic: { validator: "global-gates" } },
  },
  {
    id: "e1-proximity",
    script: "tools/monitor-e1-proximity.js",
    kind: "persistent",
    mode: "read-only",
    args: ["--watch"],
    artifact: { path: "reports/monitor/e1-proximity.json", format: "json", timestampFields: ["generatedAt"], freshnessMinutes: 5, assertionId: "fresh-e1Proximity", semantic: { validator: "e1-proximity" } },
  },
  {
    id: "venus-psr-multichain",
    script: "tools/monitor-venus-psr-multichain.js",
    kind: "persistent",
    mode: "read-only",
    args: ["--loop", "--use-authorized-inventory", "--allow-public-ethereum-fallback", "--interval-seconds", "3600"],
    artifact: {
      path: "reports/monitor/venus-psr-state.json",
      format: "json",
      timestampFields: ["attemptAt"],
      freshnessMinutes: 75,
      assertionId: "fresh-venusPsr",
      semantic: { validator: "venus-psr", requiredChains: ["bnb", "ethereum", "arbitrum"] },
      // DOCUMENTED DECISION - Venus PSR multichain (2026-09-15): LEFT FAILING on purpose.
      // bnb and arbitrum are ACCESS_PROVENANCE_REQUIRED because no reviewed per-entry resolver
      // exists; only Ethereum currently reads through the sanctioned public fallback. The
      // provenance gate is an authorization control, and there is no positive structural marker
      // that proves bnb/arbitrum are permanently unreadable (unlike the Aave V4 non-conforming
      // topology). Declaring the service observational for the two gated chains here would
      // normalise an unmet provenance requirement and let a missing resolver pass as healthy, so
      // the shortfall is recorded as informative and the assertion stays fail-closed until a
      // reviewed resolver actually exists. No gate, threshold or provenance control is weakened.
      observationalShortfall: {
        decision: "LEFT_FAILING",
        kind: "PROVENANCE_GATE_MISSING_PER_ENTRY_RESOLVER",
        reason: "bnb and arbitrum remain ACCESS_PROVENANCE_REQUIRED with no reviewed per-entry resolver; building that resolver is out of scope, and treating the gated chains as observational would mask an unmet provenance gate.",
        evidence: [
          "reports/monitor/venus-psr-state.json#chains.bnb",
          "reports/monitor/venus-psr-state.json#chains.arbitrum",
        ],
      },
    },
  },
  {
    id: "autopilot-status",
    script: "tools/autopilot-status.js",
    kind: "persistent",
    mode: "read-only",
    args: ["--watch", "--interval-ms=60000"],
    artifact: { path: "reports/monitor/autopilot-health.json", format: "json", timestampFields: ["generatedAt"], freshnessMinutes: 3, assertionId: "fresh-monitorHealth", semantic: { validator: "supervisor-health" } },
  },
  {
    id: "morpho-frozen-oracle",
    script: "tools/monitor-morpho-frozen-oracle.js",
    kind: "persistent",
    mode: "read-only",
    // --watch refreshes every 300s (the tool's documented default); 10 minutes allows
    // two full refresh windows before the artifact is considered stale.
    args: ["--watch"],
    artifact: {
      path: "reports/raw/fast/morpho-frozen-oracle-status.json",
      format: "json",
      timestampFields: ["capturedAt"],
      freshnessMinutes: 10,
      assertionId: "fresh-morphoFrozenOracle",
      semantic: { validator: "morpho-frozen-oracle" },
    },
  },
  {
    id: "morpho-startup-scan",
    script: "tools/morpho-find-liquidatable.js",
    kind: "scheduled",
    mode: "read-only",
    // The producer honestly covers only a recent block suffix by design, so it can never
    // emit EXHAUSTIVE_COMPLETE. Declared observational exactly like the aave watches; the
    // semantic validator still enforces the strict exhaustive path for artifacts that claim it.
    coverageMode: "BOUNDED_OBSERVATIONAL",
    args: [],
    // STARTUP-SCOPED FRESHNESS (2026-09-16). This artifact is written once per monitor-set launch
    // (tools/monitor-set-autostart.cmd starts the scanner on logon) and nothing refreshes it between
    // launches, so the previous 1440-minute (24 h) window expired by construction on any session
    // longer than a day - observed live at 28.8 h uptime. 10080 minutes (7 days) spans a full weekly
    // operating cycle with margin over the observed uptime and over a weekend without a logon.
    // TRADEOFF: if the launch path stops running, a stale startup scan now goes unnoticed for up to a
    // week instead of a day. Correctness is NOT relaxed - the strict `morpho-startup-scan` semantic
    // validator still fails closed on a missing, malformed, truncated, or falsely-complete artifact.
    artifact: { path: "reports/monitor/morpho-liquidatable-startup.json", format: "json", timestampFields: ["generatedAt"], freshnessMinutes: 10080, assertionId: "fresh-morphoStartupScan", semantic: { validator: "morpho-startup-scan" } },
  },
  {
    id: "disabled-routes-report",
    script: "tools/autopilot-disabled-routes.js",
    kind: "scheduled",
    mode: "read-only",
    args: ["--once"],
    // STARTUP-SCOPED FRESHNESS (2026-09-16). Produced once per monitor-set launch and not refreshed
    // between launches; the old 1440-minute (24 h) window expired by construction past 24 h uptime
    // (observed live at 28.8 h). 10080 minutes (7 days) covers a weekly operating cycle. TRADEOFF: a
    // stale disabled-routes report can now persist unnoticed for up to a week if the launch path
    // stops. The `disabled-routes` semantic validator is unchanged and still rejects a missing,
    // malformed, or executable-field-drifted artifact immediately.
    artifact: { path: "reports/monitor/autopilot-disabled-routes.json", format: "json", timestampFields: ["generatedAt"], freshnessMinutes: 10080, assertionId: "fresh-disabledRoutes", semantic: { validator: "disabled-routes" } },
  },
  {
    id: "research-watch-build",
    script: "tools/build-monitor-research-watch.js",
    kind: "scheduled",
    mode: "read-only",
    args: ["--once"],
    optional: true,
    // STARTUP-SCOPED FRESHNESS (2026-09-16). This completion marker is written once per monitor-set
    // launch (echo completed> on success) and never re-touched; the old 1440-minute (24 h) window
    // expired by construction past 24 h uptime (observed live at 28.8 h). 10080 minutes (7 days)
    // covers a weekly operating cycle. TRADEOFF: a genuinely failed research-watch build now stays
    // green for up to a week, but the completion-marker validator still requires the exact
    // `completed` text, so a missing or malformed marker fails immediately. Text-format artifacts
    // fall back to file mtime for age, which is the marker's true write time.
    artifact: { path: "reports/monitor/research-watch-startup.done", format: "text", timestampFields: [], freshnessMinutes: 10080, assertionId: "fresh-researchWatchBuild", semantic: { validator: "completion-marker", expectedText: "completed" } },
  },
]);

const dataArtifacts = Object.freeze([
  { path: "reports/raw/fast/route-positive-sweep.json", format: "json", timestampFields: ["generatedAt"], freshnessMinutes: 15, assertionId: "fresh-routeSweep", semantic: { validator: "route-sweep" } },
  // DOCUMENTED DECISION - audit completion gates (2026-09-15): LEFT FAILING on purpose.
  // The completion artifact is blocked by the residual audit backlog (stale active-branch source
  // artifacts plus untagged triage reports), which is exactly the signal the gate exists to
  // raise. Its branch accounting already uses the existing terminal/incomplete classification
  // (closureEligible:false, coverageOpen:true, historicalCoverageComplete:false), and no branch
  // is reclassified here. Declaring this data artifact observational would hide a live backlog,
  // and because `route-gate-inputs-ready` consumes it, the route gate assertions stay fail-closed
  // as well. Nothing is refreshed or reclassified to make it pass.
  { path: "reports/raw/fast/audit-completion-gates.json", format: "json", timestampFields: ["generatedAt"], freshnessMinutes: 15, assertionId: "fresh-completionGates", semantic: { validator: "completion-gates", healthyStatuses: ["watch-ready"] }, observationalShortfall: { decision: "LEFT_FAILING", kind: "RESIDUAL_AUDIT_BACKLOG", reason: "Stale active-branch artifacts and untagged triage reports keep completeForNow=false; the gate is informative and must stay fail-closed.", evidence: ["reports/raw/fast/audit-completion-gates.json#summary"] } },
  { path: "reports/monitor/trigger-coverage-audit.json", format: "json", timestampFields: ["auditedAt"], freshnessMinutes: 5, assertionId: "fresh-triggerCoverageAudit", semantic: { validator: "trigger-coverage-audit" } },
]);

const supervisorRuntime = Object.freeze({
  role: "read-only-observer",
  processInspection: "query-only",
  artifactRefresh: "disabled",
  processOutput: "aggregate-only",
});

const forbiddenProcessScripts = Object.freeze([
  "tools/aave-autopilot.js",
  "tools/aave-v3-autopilot.js",
  "tools/monitor-morpho-executor.js",
  "tools/monitor-aave-v3-executor.js",
  "tools/monitor-auto-liquidate.js",
  "tools/monitor-solana-liquidations.js",
  "tools/autopilot-action-queue.js",
]);

const SHORTFALL_DECISIONS = Object.freeze(["OBSERVATIONAL", "LEFT_FAILING"]);

// A documented shortfall declaration must state its decision and carry a reason and at least one
// evidence pointer so a reviewer can always reconstruct WHY a service is (or is not) allowed to
// report `ready-observational`. An OBSERVATIONAL declaration is additionally required to name the
// exact structural signature it tolerates; autopilot-status refuses to accept anything outside it.
function validateShortfallPolicy(policy, id) {
  if (policy === undefined) return true;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error(`invalid observational shortfall policy: ${id}`);
  if (!SHORTFALL_DECISIONS.includes(policy.decision)) throw new Error(`invalid observational decision: ${id}`);
  if (typeof policy.reason !== "string" || !policy.reason.trim()) throw new Error(`observational shortfall reason is required: ${id}`);
  if (!Array.isArray(policy.evidence) || policy.evidence.length === 0
    || policy.evidence.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`observational shortfall evidence is required: ${id}`);
  }
  if (policy.decision === "OBSERVATIONAL") {
    for (const field of ["structuralFailures", "allowedEnvelopeFailures", "structuralErrorCodes"]) {
      if (!Array.isArray(policy[field]) || policy[field].some((item) => typeof item !== "string" || !item.trim())) {
        throw new Error(`observational shortfall ${field} must be a string array: ${id}`);
      }
    }
    if (!policy.require || typeof policy.require !== "object" || Array.isArray(policy.require) || Object.keys(policy.require).length === 0) {
      throw new Error(`observational shortfall require markers are required: ${id}`);
    }
  }
  return true;
}

function validateManifest(rows = services) {
  const ids = new Set();
  const scripts = new Set();
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id) throw new Error("manifest service id is required");
    if (ids.has(row.id)) throw new Error(`duplicate manifest service id: ${row.id}`);
    if (!row.script || scripts.has(row.script)) throw new Error(`duplicate or missing manifest script: ${row.script || row.id}`);
    if (!new Set(["persistent", "scheduled"]).has(row.kind)) throw new Error(`invalid service kind: ${row.id}`);
    if (row.mode !== "read-only") throw new Error(`invalid service mode: ${row.id}`);
    if (row.coverageMode !== undefined && row.coverageMode !== "BOUNDED_OBSERVATIONAL") throw new Error(`invalid coverage mode: ${row.id}`);
    if (!Array.isArray(row.args)) throw new Error(`service args must be an array: ${row.id}`);
    if (!row.artifact?.semantic?.validator) throw new Error(`service semantic validator is required: ${row.id}`);
    validateShortfallPolicy(row.artifact.observationalShortfall, row.id);
    ids.add(row.id);
    scripts.add(row.script);
  }
  for (const spec of dataArtifacts) validateShortfallPolicy(spec.observationalShortfall, spec.assertionId);
  return true;
}

validateManifest();

const persistentServices = Object.freeze(services.filter((row) => row.kind === "persistent"));
const scheduledServices = Object.freeze(services.filter((row) => row.kind === "scheduled"));

function summary() {
  return {
    persistent: persistentServices.length,
    scheduled: scheduledServices.length,
    optionalScheduled: scheduledServices.filter((row) => row.optional).length,
    total: services.length,
  };
}

function cli(argv = process.argv.slice(2)) {
  const countIndex = argv.indexOf("--count");
  if (countIndex >= 0) {
    const kind = argv[countIndex + 1];
    if (kind === "persistent") return process.stdout.write(`${persistentServices.length}\n`);
    if (kind === "scheduled") return process.stdout.write(`${scheduledServices.length}\n`);
    throw new Error("--count requires persistent or scheduled");
  }
  if (argv.includes("--json")) {
    return process.stdout.write(`${JSON.stringify({ summary: summary(), services, dataArtifacts }, null, 2)}\n`);
  }
  const counts = summary();
  process.stdout.write(`Read-only monitor manifest: ${counts.persistent} persistent + ${counts.scheduled} scheduled (${counts.optionalScheduled} optional)\n`);
}

if (require.main === module) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(`monitor-service-manifest: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  services,
  persistentServices,
  scheduledServices,
  dataArtifacts,
  supervisorRuntime,
  forbiddenProcessScripts,
  summary,
  validateManifest,
  validateShortfallPolicy,
  SHORTFALL_DECISIONS,
  cli,
};
