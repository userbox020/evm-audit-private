"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  ARTIFACT_STATUS,
  assessArtifactObject,
  readArtifactFile,
} = require("../monitor-artifact-policy");
const {
  classifyAaveV4Artifact,
  classifyForkArtifact,
} = require("../monitor-novelty-conditions");
const v4BorrowerProducer = require("../scan-aave-v4-spoke-borrowers");
const v4TopologyProducer = require("../scan-aave-v4-hubs");
const v4WatchProducer = require("../watch-aave-v4-liquidation-triggers");

const NOW = Date.parse("2026-08-25T12:00:00.000Z");

function canonicalV4Artifact(generatedAt) {
  const sourceGeneratedAt = new Date(NOW - 60_000).toISOString();
  const registry = v4TopologyProducer.loadAaveV4EthereumRegistry();
  const topology = v4TopologyProducer.buildTopologySourceCoverage(
    registry.hubs.map(({ address }) => ({
      address,
      assetCountReadOk: true,
      assetCount: 0,
      assetScanTruncated: false,
      assets: [],
    })), registry,
  );
  const borrowerCoverage = v4BorrowerProducer.buildSourceCoverage({
    topologyGeneratedAt: sourceGeneratedAt,
    topologySourceComplete: false,
    topologySourceSampleComplete: true,
    topologyUniverse: topology.topologyUniverse,
    spokeReserveLinks: topology.spokeReserveLinks,
    upstreamCoverage: topology,
    chainsExpected: 1,
    chainsObserved: 1,
    spokesExpected: 0,
    spokesObserved: 0,
    observedRange: { fromBlock: 90, toBlock: 100 },
    historyScope: "RECENT_BLOCK_SUFFIX",
    fullHistoryProven: false,
    logChunksAttempted: 1,
    logChunksSucceeded: 1,
    logChunksFailed: 0,
    discoveredBorrowers: 0,
    checkedBorrowers: 0,
    accountReadsAttempted: 0,
    accountReadsSucceeded: 0,
    accountReadsFailed: 0,
    reserveReadsAttempted: 0,
    reserveReadsSucceeded: 0,
    reserveReadsFailed: 0,
    truncationLimit: 20,
    wasTruncated: false,
  }, NOW);
  const snapshot = v4WatchProducer.summarizeBorrowers({
    generatedAt: sourceGeneratedAt,
    scanner: v4WatchProducer.SOURCE_SCANNER,
    sourceCoverage: borrowerCoverage,
    summary: { activeBorrowers: 0, nearLiquidation: 0, liquidatable: 0, routePositive: 0 },
    topUsers: [],
  }, { nowMs: NOW });
  snapshot.generatedAt = generatedAt;
  snapshot.iteration = 1;
  return JSON.parse(JSON.stringify(v4WatchProducer.forceMonitorOnlyArtifact(
    v4WatchProducer.buildWatchArtifact(snapshot, [], {}, { generatedAt }),
  )));
}

test("artifact policy distinguishes fresh, stale, future, incomplete, and missing", () => {
  const fresh = assessArtifactObject({ generatedAt: new Date(NOW - 60_000).toISOString() }, { nowMs: NOW, maxAgeMs: 120_000 });
  const stale = assessArtifactObject({ generatedAt: new Date(NOW - 121_000).toISOString() }, { nowMs: NOW, maxAgeMs: 120_000 });
  const future = assessArtifactObject({ generatedAt: new Date(NOW + 301_000).toISOString() }, { nowMs: NOW, maxAgeMs: 120_000, maxFutureSkewMs: 300_000 });
  const incomplete = assessArtifactObject({}, { nowMs: NOW, maxAgeMs: 120_000 });
  const missing = readArtifactFile(path.join(__dirname, "definitely-not-present-monitor-artifact.json"));
  const malformed = readArtifactFile(__filename);
  const schemaInvalid = assessArtifactObject(
    { generatedAt: new Date(NOW).toISOString(), rows: "not-an-array" },
    { nowMs: NOW, validate: (artifact) => Array.isArray(artifact.rows) || "rows invalid" },
  );

  assert.equal(fresh.status, ARTIFACT_STATUS.VALID_FRESH);
  assert.equal(stale.status, ARTIFACT_STATUS.VALID_STALE);
  assert.equal(future.status, ARTIFACT_STATUS.FUTURE_TIMESTAMP);
  assert.equal(incomplete.status, ARTIFACT_STATUS.INCOMPLETE);
  assert.equal(missing.status, ARTIFACT_STATUS.MISSING);
  assert.equal(malformed.status, ARTIFACT_STATUS.MALFORMED);
  assert.equal(schemaInvalid.status, ARTIFACT_STATUS.SCHEMA_INVALID);
});

test("E23 stale positive fork evidence is suppressed", () => {
  const result = classifyForkArtifact({
    generatedAt: new Date(NOW - 31 * 60_000).toISOString(),
    status: "positive",
    fork: { success: true, netProfitUsd: 100 },
  }, NOW);

  assert.equal(result.status, ARTIFACT_STATUS.VALID_STALE);
  assert.equal(result.positive, false);
});

test("AV4 stale current-looking summary is suppressed", () => {
  const artifact = canonicalV4Artifact(new Date(NOW - 16 * 60_000).toISOString());
  const result = classifyAaveV4Artifact(artifact, NOW);

  assert.equal(result.status, ARTIFACT_STATUS.VALID_STALE);
  assert.equal(result.fresh, false);
});

test("AV4 novelty ingestion requires the exact serialized wrapper identity", () => {
  const generatedAt = new Date(NOW - 60_000).toISOString();
  const artifact = canonicalV4Artifact(generatedAt);
  assert.equal(classifyAaveV4Artifact(artifact, NOW).status, ARTIFACT_STATUS.VALID_FRESH);

  for (const mutate of [
    value => { value.schema = "aave-v4-liquidation-watch/v0"; },
    value => { value.scanner = "tools/not-the-v4-wrapper.js"; },
    value => { value.sourceScanner = "tools/not-the-v4-source.js"; },
    value => { value.sourceCoverage.sampleComplete = false; },
  ]) {
    const rejected = JSON.parse(JSON.stringify(artifact));
    mutate(rejected);
    assert.equal(classifyAaveV4Artifact(rejected, NOW).status, ARTIFACT_STATUS.SCHEMA_INVALID);
  }
});
