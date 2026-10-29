"use strict";
// Documented observational-shortfall policy tests (2026-09-15).
// These fixtures are synthetic and offline: they lock in the rule that a service may only report
// `ready-observational` when the shortfall is a declared, structural, by-design signature, and
// that any genuine read failure, unknown error code, shape drift, or hard-stop signal keeps the
// assertion failing closed.

const test = require("node:test");
const assert = require("node:assert/strict");

const manifest = require("../monitor-service-manifest");
const statusModule = require("../autopilot-status");
const v4Watch = require("../watch-aave-v4-liquidation-triggers");
const v3Watch = require("../aave-v3-liquidation-watch");
const v3Route = require("../scan-aave-v3-route-distance");
const v3Readiness = require("../audit-aave-v3-trigger-readiness");

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const RECENT = new Date(NOW - 60_000).toISOString();

function artifactSpec(id) {
  return manifest.services.find((service) => service.id === id).artifact;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Reproduces the live structural signature exactly: an absent upstream borrower-scan coverage plus
// a hub topology that the watch could not refresh to sample completeness.
function v4StructuralArtifact(generatedAt = RECENT) {
  const options = {
    nowMs: Date.parse(generatedAt),
    scanAttempted: false,
    scanOk: false,
    topologyRefreshAttempted: true,
    topologyRefreshOk: false,
    topologyRefreshError: "topology-refresh-incomplete",
  };
  const snapshot = v4Watch.summarizeBorrowers({}, options);
  snapshot.generatedAt = generatedAt;
  snapshot.iteration = 1;
  return clone(v4Watch.forceMonitorOnlyArtifact(v4Watch.buildWatchArtifact(
    snapshot,
    [],
    { topologyRefreshAttempted: true, topologyRefreshOk: false },
    { generatedAt },
  )));
}

// Reproduces the V3 monitor envelope. `readFailure` flips one chain's log chunk from success to
// failure while keeping the envelope shape and the by-design MAX_USERS_PER_CHAIN truncation.
function v3Artifact({ readFailure = false } = {}) {
  const chainIds = [1, 8453, 42161, 10, 137, 43114, 100, 534352, 56];
  const chains = chainIds.map((chainId) => ({
    chainId,
    observedRange: { fromBlock: 90, toBlock: 100 },
    fromBlock: 90,
    latestBlock: 100,
    historyScope: "RECENT_BLOCK_SUFFIX",
    fullHistoryProven: false,
    logChunks: 1,
    logChunksSucceeded: readFailure ? 0 : 1,
    logChunksFailed: readFailure ? 1 : 0,
    borrowersDiscovered: 5,
    accountDataChecked: 2,
    accountReadsAttempted: 2,
    accountReadsSucceeded: 2,
    accountReadsFailed: 0,
    reserveReadsAttempted: 0,
    reserveReadsSucceeded: 0,
    reserveReadsFailed: 0,
    wasTruncated: true,
    coverageErrors: [],
  }));
  const route = { generatedAt: RECENT, sourceCoverage: v3Route.buildRouteSourceCoverage(chains, chainIds) };
  const tracker = { attempted: 1, succeeded: 1, failed: 0, accountAttempted: 1, accountSucceeded: 1, accountFailed: 0 };
  const readiness = { generatedAt: RECENT, sourceCoverage: v3Readiness.buildReadinessSourceCoverage(route, tracker) };
  const artifact = v3Watch.latestStatus(1, RECENT, {
    route: { ...route, summary: {}, globalTopRows: [] },
    readiness: { ...readiness, summary: {} },
    sweep: { summary: { executableNow: false, signedActionJustified: false } },
    gates: { summary: { executableNow: false, signedActionJustified: false } },
  }, { nowMs: NOW, maxSourceAgeMs: 5 * 60_000, routeRefreshAttempted: true, routeRefreshOk: true });
  artifact.generatedAt = RECENT;
  return clone(artifact);
}

function persistentRows() {
  return manifest.persistentServices.map((service, index) => ({ commandLine: `node ${service.script} synthetic-${index}` }));
}

test("manifest declares exactly the documented structural and left-failing shortfalls", () => {
  assert.equal(manifest.validateManifest(), true);

  const v4 = artifactSpec("aave-v4-owner-watch").observationalShortfall;
  assert.equal(v4.decision, "OBSERVATIONAL");
  assert.ok(v4.reason.includes("62/128"));
  assert.deepEqual(v4.require, {
    protocolVersion: "V4", coverageKind: "monitor", classification: "SOURCE_INCOMPLETE",
    topologyRefreshAttempted: true, topologyRefreshOk: false, topologySourceSampleComplete: false,
    logChunksAttempted: 0, chainsObserved: 0,
  });
  assert.ok(v4.evidence.some((item) => item.includes("aave-v4-hubs.json")));

  const v3 = artifactSpec("aave-v3-liquidation-watch").observationalShortfall;
  assert.equal(v3.decision, "OBSERVATIONAL");
  assert.ok(v3.structuralErrorCodes.includes("route-truncated"));
  assert.equal(v3.structuralErrorCodes.includes("route-log-chunk-failed"), false, "read failures are never tolerated");

  assert.equal(artifactSpec("venus-psr-multichain").observationalShortfall.decision, "LEFT_FAILING");
  const completion = manifest.dataArtifacts.find((spec) => spec.assertionId === "fresh-completionGates");
  assert.equal(completion.observationalShortfall.decision, "LEFT_FAILING");

  // A malformed policy is rejected rather than silently accepted.
  for (const bad of [
    null,
    { decision: "MAYBE", reason: "x", evidence: ["y"] },
    { decision: "OBSERVATIONAL", reason: "", evidence: ["y"] },
    { decision: "OBSERVATIONAL", reason: "x", evidence: [] },
    { decision: "OBSERVATIONAL", reason: "x", evidence: ["y"] },
  ]) {
    assert.throws(() => manifest.validateShortfallPolicy(bad, "fixture"), /observational/);
  }
});

test("the structural Aave V4 signature is observational, and every deviation fails closed", () => {
  const spec = artifactSpec("aave-v4-owner-watch");
  const accepted = v4StructuralArtifact();
  assert.equal(statusModule.validateArtifactSemantics(spec, accepted, null, NOW), true);
  const decision = statusModule.observationalShortfallDecision(spec, accepted, NOW);
  assert.equal(decision.accepted, true);
  assert.equal(decision.strictFailures.length > 0, true, "the structural shortfall is real, not a clean pass");

  const readFailure = clone(accepted);
  readFailure.sourceCoverage.accountReadsFailed = 1;
  readFailure.sourceCoverage.accountReadsAttempted += 1;
  readFailure.sourceCoverage.stateReadsFailed += 1;
  readFailure.sourceCoverage.stateReadsAttempted += 1;
  assert.equal(statusModule.validateArtifactSemantics(spec, readFailure, null, NOW), false);
  assert.equal(statusModule.observationalShortfallDecision(spec, readFailure, NOW).accepted, false);

  const unknownError = clone(accepted);
  unknownError.sourceCoverage.errors.push("sanitized-read-failure");
  assert.equal(statusModule.validateArtifactSemantics(spec, unknownError, null, NOW), false);

  const emptyErrors = clone(accepted);
  emptyErrors.sourceCoverage.errors = [];
  assert.equal(statusModule.validateArtifactSemantics(spec, emptyErrors, null, NOW), false);

  const wrongMarker = clone(accepted);
  wrongMarker.sourceCoverage.topologyRefreshOk = true;
  assert.equal(statusModule.validateArtifactSemantics(spec, wrongMarker, null, NOW), false);

  const unexpectedFailure = clone(accepted);
  unexpectedFailure.sourceCoverage.truncationLimit = 0;
  assert.equal(statusModule.validateArtifactSemantics(spec, unexpectedFailure, null, NOW), false);

  // The structural allowance must never bypass the recursive hard-stop gate.
  const hardStop = clone(accepted);
  hardStop.latest.summary.executableNow = true;
  assert.equal(statusModule.validateArtifactSemantics(spec, hardStop, null, NOW), false);
});

test("Aave V3 tolerates only the by-design truncation and never a genuine read failure", () => {
  const spec = artifactSpec("aave-v3-liquidation-watch");

  const structuralOnly = v3Artifact({ readFailure: false });
  assert.equal(statusModule.observationalShortfallDecision(spec, structuralOnly, NOW).accepted, true);
  assert.equal(statusModule.validateArtifactSemantics(spec, structuralOnly, null, NOW), true);

  const readFailure = v3Artifact({ readFailure: true });
  const decision = statusModule.observationalShortfallDecision(spec, readFailure, NOW);
  assert.equal(decision.accepted, false);
  assert.ok(decision.rejectedBecause.includes("read-failure:logChunksFailed"));
  assert.equal(statusModule.validateArtifactSemantics(spec, readFailure, null, NOW), false);
});

test("left-failing decisions are surfaced for review and never flip readiness", () => {
  const venusSpec = artifactSpec("venus-psr-multichain");
  const decision = statusModule.observationalShortfallDecision(venusSpec, { chains: {} }, NOW);
  assert.equal(decision.decision, "LEFT_FAILING");
  assert.equal(decision.accepted, false);
  assert.equal(decision.rejectedBecause.includes("decision-left-failing"), true);

  const health = statusModule.artifactHealth(venusSpec, {
    nowMs: NOW,
    artifactMap: { [venusSpec.path]: { json: { chains: {} }, mtimeMs: NOW - 1000 } },
  });
  assert.equal(health.acceptable, false);
  assert.equal(health.observational, false);
  assert.equal(health.shortfallDecision.decision, "LEFT_FAILING");
});

test("service readiness reflects the decision: V4 observational, V3 and Venus fail closed", () => {
  const v4spec = artifactSpec("aave-v4-owner-watch");
  const v3spec = artifactSpec("aave-v3-liquidation-watch");
  const venusSpec = artifactSpec("venus-psr-multichain");
  const rows = statusModule.buildServiceStatuses(persistentRows(), {
    nowMs: NOW,
    scriptExists: () => true,
    artifactMap: {
      [v4spec.path]: { json: v4StructuralArtifact(), mtimeMs: NOW - 1000 },
      [v3spec.path]: { json: v3Artifact({ readFailure: true }), mtimeMs: NOW - 1000 },
      [venusSpec.path]: { json: { schema: "venus-psr-state/v1", chains: {} }, mtimeMs: NOW - 1000 },
    },
  });

  const v4 = rows.find((row) => row.id === "aave-v4-owner-watch");
  assert.equal(v4.artifact.semanticValid, true);
  assert.equal(v4.artifact.shortfallDecision.accepted, true);
  assert.equal(v4.readiness, "ready-observational");

  const v3 = rows.find((row) => row.id === "aave-v3-liquidation-watch");
  assert.equal(v3.artifact.semanticValid, false);
  assert.equal(v3.readiness, "pending-artifact");

  const venus = rows.find((row) => row.id === "venus-psr-multichain");
  assert.equal(venus.readiness, "pending-artifact");
  assert.equal(venus.artifact.shortfallDecision.decision, "LEFT_FAILING");
});
