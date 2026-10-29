"use strict";
// Service-level tests for the persistent morpho-frozen-oracle monitor entry:
// manifest registration, fail-closed artifact semantics, and loud trigger surfacing.
// All fixtures are synthetic; no network, no endpoint values.

const test = require("node:test");
const assert = require("node:assert/strict");

const manifest = require("../monitor-service-manifest");
const statusModule = require("../autopilot-status");

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const CAPTURED_AT = new Date(NOW - 60_000).toISOString();

function frozenOracleArtifact(statuses, capturedAt = CAPTURED_AT) {
  const summary = { TRIGGERED: 0, WATCH: 0, CLEAR: 0, REFERENCE_UNAVAILABLE: 0, ORACLE_REVERT: 0 };
  for (const status of statuses) summary[status] += 1;
  return {
    schema: "morpho-frozen-oracle-status/read-only/v1",
    capturedAt,
    mode: "watch",
    source: "local source tests, public read-only state, and one keyless public reference API",
    safety: {
      readOnly: true,
      externalStateMutations: false,
      oracleOrPoolManipulation: false,
      signing: false,
      transactions: false,
      forks: false,
      endpointValuesStored: false,
      endpointMaterialInChildArgv: false,
    },
    stalenessThresholdSeconds: 86400,
    minimumActionableLiquidityAssets: 1,
    limits: { maxMarkets: 16, maxRpcRequestsPerRun: 160, maxReferenceRequestsPerRun: 8 },
    requestCounts: { rpcCalls: 6, referenceCalls: 1, trackedMarkets: statuses.length },
    summary,
    markets: statuses.map((status, index) => ({
      chainId: index % 2 === 0 ? 1 : 8453,
      chain: index % 2 === 0 ? "ethereum" : "base",
      market: `MARKET-${index}/USDC`,
      marketId: `0x${String(index + 1).padStart(2, "0")}`,
      status,
    })),
  };
}

function spec() {
  return manifest.services.find((service) => service.id === "morpho-frozen-oracle").artifact;
}

test("manifest registers the frozen-oracle monitor as a persistent read-only service", () => {
  const service = manifest.services.find((row) => row.id === "morpho-frozen-oracle");
  assert.ok(service, "morpho-frozen-oracle service must exist");
  assert.equal(service.script, "tools/monitor-morpho-frozen-oracle.js");
  assert.equal(service.kind, "persistent");
  assert.equal(service.mode, "read-only");
  assert.deepEqual(service.args, ["--watch"]);
  assert.equal(service.artifact.path, "reports/raw/fast/morpho-frozen-oracle-status.json");
  assert.equal(service.artifact.format, "json");
  assert.deepEqual(service.artifact.timestampFields, ["capturedAt"]);
  assert.equal(service.artifact.freshnessMinutes, 10);
  assert.equal(service.artifact.assertionId, "fresh-morphoFrozenOracle");
  assert.equal(service.artifact.semantic.validator, "morpho-frozen-oracle");
  assert.equal(manifest.validateManifest(), true);
});

test("frozen-oracle semantics accept a well-formed artifact and fail closed on every malformed or drifted variant", () => {
  const artifactSpec = spec();
  const valid = frozenOracleArtifact(["CLEAR", "WATCH", "WATCH"]);
  assert.equal(statusModule.validateArtifactSemantics(artifactSpec, valid, null, NOW), true);

  const stale = frozenOracleArtifact(["CLEAR"], new Date(NOW - 31 * 60_000).toISOString());
  const cases = [
    ["missing object", null],
    ["missing schema", Object.assign(frozenOracleArtifact(["CLEAR"]), { schema: undefined })],
    ["wrong schema", Object.assign(frozenOracleArtifact(["CLEAR"]), { schema: "morpho-frozen-oracle-status/read-only/v0" })],
    ["invalid mode", Object.assign(frozenOracleArtifact(["CLEAR"]), { mode: "loop" })],
    ["missing safety", Object.assign(frozenOracleArtifact(["CLEAR"]), { safety: undefined })],
    ["non-read-only safety", Object.assign(frozenOracleArtifact(["CLEAR"]), { safety: { ...frozenOracleArtifact(["CLEAR"]).safety, readOnly: false } })],
    ["signing enabled", Object.assign(frozenOracleArtifact(["CLEAR"]), { safety: { ...frozenOracleArtifact(["CLEAR"]).safety, signing: true } })],
    ["missing capturedAt", Object.assign(frozenOracleArtifact(["CLEAR"]), { capturedAt: undefined })],
    ["stale capturedAt", stale],
    ["missing requestCounts", Object.assign(frozenOracleArtifact(["CLEAR"]), { requestCounts: undefined })],
    ["trackedMarkets mismatch", Object.assign(frozenOracleArtifact(["CLEAR"]), { requestCounts: { trackedMarkets: 2 } })],
    ["missing summary field", Object.assign(frozenOracleArtifact(["CLEAR"]), { summary: { TRIGGERED: 0, WATCH: 1, CLEAR: 0, REFERENCE_UNAVAILABLE: 0 } })],
    ["non-integer summary count", Object.assign(frozenOracleArtifact(["CLEAR"]), { summary: { TRIGGERED: 0, WATCH: 1, CLEAR: 0.5, REFERENCE_UNAVAILABLE: 0, ORACLE_REVERT: 0 } })],
    ["summary total mismatch", Object.assign(frozenOracleArtifact(["CLEAR"]), { summary: { TRIGGERED: 0, WATCH: 2, CLEAR: 0, REFERENCE_UNAVAILABLE: 0, ORACLE_REVERT: 0 } })],
    ["empty markets", Object.assign(frozenOracleArtifact([]), { requestCounts: { trackedMarkets: 0 }, summary: { TRIGGERED: 0, WATCH: 0, CLEAR: 0, REFERENCE_UNAVAILABLE: 0, ORACLE_REVERT: 0 } })],
    ["unknown market status", frozenOracleArtifact(["CLEAR", "ARMED"])],
    ["per-status count drift", Object.assign(frozenOracleArtifact(["CLEAR", "CLEAR"]), { summary: { TRIGGERED: 0, WATCH: 1, CLEAR: 1, REFERENCE_UNAVAILABLE: 0, ORACLE_REVERT: 0 } })],
  ];
  for (const [label, artifact] of cases) {
    assert.equal(statusModule.validateArtifactSemantics(artifactSpec, artifact, null, NOW), false, label);
  }
});

test("a positive TRIGGERED count surfaces as its own distinct failed assertion instead of a green state", () => {
  const artifactSpec = spec();
  const artifactMap = (statuses) => ({
    [artifactSpec.path]: { json: frozenOracleArtifact(statuses), mtimeMs: NOW - 60_000 },
  });

  const clear = statusModule.buildStatus(1, new Date(NOW).toISOString(), {
    nowMs: NOW,
    processes: [],
    artifactMap: artifactMap(["CLEAR", "WATCH", "WATCH"]),
    scriptExists: () => true,
  });
  assert.equal(clear.triggerStatus.triggered, 0);
  assert.equal(clear.triggerStatus.status, "clear");
  assert.equal(clear.summary.frozenOracleTriggered, 0);
  assert.equal(clear.summary.failedAssertionIds.includes("trigger-morphoFrozenOracle"), false);

  const triggered = statusModule.buildStatus(1, new Date(NOW).toISOString(), {
    nowMs: NOW,
    processes: [],
    artifactMap: artifactMap(["TRIGGERED", "WATCH", "CLEAR"]),
    scriptExists: () => true,
  });
  assert.equal(triggered.summary.frozenOracleTriggered, 1);
  assert.equal(triggered.triggerStatus.triggered, 1);
  assert.equal(triggered.triggerStatus.status, "triggered");
  assert.ok(triggered.summary.failedAssertionIds.includes("trigger-morphoFrozenOracle"));
  assert.ok(triggered.triggerStatus.failedAssertionIds.includes("trigger-morphoFrozenOracle"));

  const missing = statusModule.buildStatus(1, new Date(NOW).toISOString(), {
    nowMs: NOW,
    processes: [],
    artifactMap: { [artifactSpec.path]: { exists: false } },
    scriptExists: () => true,
  });
  assert.ok(missing.summary.failedAssertionIds.includes("trigger-morphoFrozenOracle"), "a missing artifact must fail the trigger assertion closed");
});
